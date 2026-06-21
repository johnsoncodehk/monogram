// The Rust Target for emit-portable. Renders the same language-agnostic ParserIR as
// tsTarget/goTarget into a self-contained Rust program (no external crates — the lexer is
// regex-free, so it compiles with rustc alone, no Cargo/network). Its CST JSON is checked
// byte-for-byte against the interpreter, so `emitPortableParser(grammar, rustTarget)` is a
// real, verified Rust parser derived from the same grammar definition.
//
// Rust ownership note: a CST node is OWNED (moved), unlike the TS/Go pointer trees. In the
// Pratt LED loop `left` can only be moved into a child vec once the continuation is known to
// match — so a mixfix LED matches its steps into a SEPARATE kids vec first, then (on success)
// moves `left` to the front and reassigns; on failure `left` is untouched and the loop
// returns it. Sub-sequence combinators (star/opt/sep) take non-capturing fn pointers
// `fn(&mut Parser, &mut Vec<Cst>) -> bool`, threading the parser + kids as params (so nothing
// is captured, sidestepping the borrow checker).
import type { ParserIR, RdRule, PrattRule, Step, Bracket, CharRange, LexTok, Target, TplCfg } from './emit-portable.ts';
import type { TokenPattern } from './types.ts';

const J = (v: unknown) => JSON.stringify(v);
const rangeCond = (v: string, rs: CharRange[]) =>
  '(' + rs.map(([lo, hi]) => (lo === hi ? `${v} == ${lo}` : `(${lo}..=${hi}).contains(&${v})`)).join(' || ') + ')';

// Compile a token-pattern AST to backtracking-free matcher fns `_mN(s, p) -> i64`
// (new position, or -1). Named functions (Rust closures can't recurse); the source is
// threaded as a param (Rust has no convenient module-level mutable string).
function ccCondRs(p: Extract<TokenPattern, { type: 'charClass' }>): string {
  const parts = p.items.map((it) =>
    it.type === 'char' ? `cc == ${it.value.charCodeAt(0)}` : `(${it.from.charCodeAt(0)}..=${it.to.charCodeAt(0)}).contains(&cc)`);
  const inSet = '(' + parts.join(' || ') + ')';
  return p.negate ? `!${inSet}` : inSet;
}
function compilePat(p: TokenPattern, defs: string[]): string {
  const name = `_m${defs.length}`;
  defs.push('');
  let body: string;
  if (typeof p === 'string') {
    body = `if (p as usize) <= s.len() && s[p as usize..].starts_with(${J(p)}) { p + ${p.length} } else { -1 }`;
  } else switch (p.type) {
    case 'anyChar': body = `if (p as usize) < s.len() { p + 1 } else { -1 }`; break;
    case 'charClass': body = `let u = p as usize; if u >= s.len() { return -1; } let cc = s.as_bytes()[u] as u32; if ${ccCondRs(p)} { p + 1 } else { -1 }`; break;
    case 'seq': { const ms = p.items.map((x) => compilePat(x, defs)); body = `let mut p = p; ${ms.map((m) => `p = ${m}(s, p); if p < 0 { return -1; }`).join(' ')} p`; break; }
    case 'alt': { const ms = p.items.map((x) => compilePat(x, defs)); body = `${ms.map((m) => `{ let r = ${m}(s, p); if r >= 0 { return r; } }`).join(' ')} -1`; break; }
    case 'repeat': { const m = compilePat(p.body, defs); const mx = p.max !== undefined ? ` if c >= ${p.max} { break; }` : ''; body = `let mut q = p; let mut c = 0i64; loop { let r = ${m}(s, q); if r < 0 || r == q { break; } q = r; c += 1;${mx} } if c >= ${p.min} { q } else { -1 }`; break; }
    case 'lookahead': { const m = compilePat(p.body, defs); body = `let r = ${m}(s, p); if ${p.negate ? 'r < 0' : 'r >= 0'} { p } else { -1 }`; break; }
    case 'anchor': body = p.kind === 'start' ? `if p == 0 { p } else { -1 }` : `if p as usize == s.len() { p } else { -1 }`; break;
    default: throw new Error(`portable Rust lexer: pattern '${(p as { type: string }).type}' unsupported`);
  }
  defs[Number(name.slice(2))] = `fn ${name}(s: &str, p: i64) -> i64 { ${body} }`;
  return name;
}

function scanTok(t: LexTok, defs: string[], rxTok?: string, tplTok?: string): string {
  const name = (t as { name: string }).name;
  const stateful = rxTok !== undefined || tplTok !== undefined;
  if (tplTok !== undefined && name === tplTok) return '';   // template token scanned by the state machine
  const push = (endE: string) => (t.skip ? '' : stateful ? `st.emit(${J(name)}, &src[pos..${endE}], pos, ${endE}); ` : `toks.push(Tok { kind: ${J(name)}, text: &src[pos..${endE}], off: pos, end: ${endE} }); `);
  const gate = rxTok !== undefined && name === rxTok ? '!st.prev_is_value() && ' : '';
  if (t.kind === 'run') return `        if ${gate}${rangeCond('c', t.first)} {
            let mut e = pos + 1;
            while e < n { let cc = b[e] as u32; if !${rangeCond('cc', t.cont)} { break } e += 1; }
            ${push('e')}pos = e; continue;
        }`;
  if (t.kind === 'string') return `        if ${gate}c == ${t.delim.charCodeAt(0)} {
            let mut e = pos + 1;
            while e < n { let ch = b[e] as u32; if ch == 92 { e += 2; continue } if ch == ${t.delim.charCodeAt(0)} { e += 1; break } e += 1; }
            ${push('e')}pos = e; continue;
        }`;
  if (t.kind === 'line') return `        if ${gate}src[pos..].starts_with(${J(t.prefix)}) {
            let mut e = pos + ${t.prefix.length};
            while e < n && b[e] != 10 { e += 1; }
            ${push('e')}pos = e; continue;
        }`;
  if (t.kind === 'block') return `        if ${gate}src[pos..].starts_with(${J(t.open)}) {
            let mut e = pos + ${t.open.length};
            while e < n && !src[e..].starts_with(${J(t.close)}) { e += 1; }
            if e < n { e += ${t.close.length}; }
            ${push('e')}pos = e; continue;
        }`;
  const m = compilePat(t.pattern, defs);
  return `        if ${gate}true { let e = ${m}(src, pos as i64); if e > pos as i64 { let e = e as usize; ${push('e')}pos = e; continue; } }`;
}

function lexer(ir: ParserIR): string {
  const defs: string[] = [];
  const rx = ir.regexCtx;
  const tpl = ir.tpl;
  const stateful = !!(rx || tpl);
  const toks = ir.tokens.map((t) => scanTok(t, defs, rx?.regexToken, tpl?.token)).join('\n');
  const puncts = ir.puncts.map((p) =>
    `        if src[pos..].starts_with(${J(p)}) { ${stateful ? `st.emit("", &src[pos..pos + ${p.length}], pos, pos + ${p.length});` : `toks.push(Tok { kind: "", text: &src[pos..pos + ${p.length}], off: pos, end: pos + ${p.length} });`} pos += ${p.length}; continue; }`).join('\n');
  const rsArr = (a: string[]) => `&[${a.map(J).join(', ')}]`;
  // Struct fields / emit hooks / init are assembled per-feature so a grammar can have regex,
  // templates, or both share one LexState.
  const rxConsts = rx ? `const _DIVT: &[&str] = ${rsArr(rx.divisionTexts)};
const _DIVK: &[&str] = ${rsArr(rx.divisionTypes)};
const _RXT: &[&str] = ${rsArr(rx.regexTexts)};
const _PHK: &[&str] = ${rsArr(rx.parenHeadKw)};
const _MEM: &[&str] = ${rsArr(rx.memberAccess)};
const _PAV: &[&str] = ${rsArr(rx.postfixAfterValue)};
const _IDENT: &str = ${J(rx.identToken)};
fn _in(set: &[&str], x: &str) -> bool { set.iter().any(|s| *s == x) }
` : '';
  const tplFn = tpl ? `fn _scan_tpl_span(s: &str, mut p: usize) -> (bool, usize) {
    let n = s.len();
    while p < n {
        if s[p..].starts_with(${J(tpl.interpOpen)}) { return (true, p + ${tpl.interpOpen.length}); }
        if s.as_bytes()[p] == 92 { p += 2; continue; }
        if s[p..].starts_with(${J(tpl.open)}) { return (false, p + ${tpl.open.length}); }
        p += 1;
    }
    (false, p)
}
` : '';
  const fields = ['toks: Vec<Tok<\'a>>',
    rx ? 'prev_text: &\'a str, prev_kind: &\'static str, bp_text: &\'a str, has_prev: bool, has_prev2: bool, paren_head: Vec<bool>, last_close: bool, last_bang: bool' : '',
    tpl ? 'template_stack: Vec<i64>' : ''].filter(Boolean).join(', ');
  const prevIsValue = rx ? `    fn prev_is_value(&self) -> bool {
        if !self.has_prev { return false; }
        if _in(_PAV, self.prev_text) { return self.last_bang; }
        let is_expr_kw = self.prev_kind == _IDENT && _in(_RXT, self.prev_text);
        let is_paren_head = self.prev_text == ")" && self.last_close;
        !is_expr_kw && !is_paren_head && (_in(_DIVK, self.prev_kind) || _in(_DIVT, self.prev_text))
    }
` : '';
  const emitHooks = [
    rx ? `        if text == "(" { let is_member = self.has_prev2 && _in(_MEM, self.bp_text); self.paren_head.push(!is_member && self.prev_kind == _IDENT && _in(_PHK, self.prev_text)); }
        else if text == ")" { self.last_close = self.paren_head.pop().unwrap_or(false); }
        if _in(_PAV, text) { self.last_bang = self.prev_is_value(); }` : '',
    tpl ? `        if !self.template_stack.is_empty() { if text == ${J(tpl.braceOpen)} { *self.template_stack.last_mut().unwrap() += 1; } else if text == ${J(tpl.interpClose)} { *self.template_stack.last_mut().unwrap() -= 1; } }` : '',
  ].filter(Boolean).join('\n');
  const emitTail = rx ? `
        self.bp_text = self.prev_text; self.has_prev2 = self.has_prev; self.prev_kind = kind; self.prev_text = text; self.has_prev = true;` : '';
  const stateImpl = stateful ? `struct LexState<'a> { ${fields} }
impl<'a> LexState<'a> {
${prevIsValue}    fn emit(&mut self, kind: &'static str, text: &'a str, off: usize, end: usize) {
${emitHooks}
        self.toks.push(Tok { kind, text, off, end });${emitTail}
    }
}
` : '';
  const initFields = ['toks: Vec::new()',
    rx ? 'prev_text: "", prev_kind: "", bp_text: "", has_prev: false, has_prev2: false, paren_head: Vec::new(), last_close: false, last_bang: false' : '',
    tpl ? 'template_stack: Vec::new()' : ''].filter(Boolean).join(', ');
  const open = stateful ? `    let mut st = LexState { ${initFields} };` : `    let mut toks: Vec<Tok> = Vec::new();`;
  const tplDispatch = tpl ? `        if !st.template_stack.is_empty() && src[pos..].starts_with(${J(tpl.interpClose)}) && *st.template_stack.last().unwrap() == 0 {
            st.template_stack.pop();
            let (interp, e) = _scan_tpl_span(src, pos + ${tpl.interpClose.length});
            if interp { st.emit("$templateMiddle", &src[pos..e], pos, e); st.template_stack.push(0); } else { st.emit("$templateTail", &src[pos..e], pos, e); }
            pos = e; continue;
        }
        if src[pos..].starts_with(${J(tpl.open)}) {
            let (interp, e) = _scan_tpl_span(src, pos + ${tpl.open.length});
            if interp { st.emit("$templateHead", &src[pos..e], pos, e); st.template_stack.push(0); } else { st.emit(${J(tpl.token)}, &src[pos..e], pos, e); }
            pos = e; continue;
        }
` : '';
  return `${defs.length ? defs.join('\n') + '\n' : ''}${rxConsts}${tplFn}${stateImpl}fn lex<'a>(src: &'a str) -> Vec<Tok<'a>> {
    let b = src.as_bytes();
    let n = b.len();
${open}
    let mut pos = 0usize;
    while pos < n {
        let c = b[pos] as u32;
        if c == 32 || c == 9 || c == 10 || c == 13 { pos += 1; continue; }
${tplDispatch}${toks}
${puncts}
        panic!("lex error at {}", pos);
    }
    ${stateful ? 'st.toks' : 'toks'}
}`;
}

// Top-level step: uses `self` and `&mut kids`.
function stepCond(s: Step): string {
  switch (s.t) {
    case 'lit': return `self.match_lit(${J(s.value)}, ${J(s.ttype)}, &mut kids)`;
    case 'tok': return `self.match_tok(${J(s.name)}, &mut kids)`;
    case 'rule': return `self.call_rule(Parser::parse_${s.name}, &mut kids)`;
    case 'star': return `self.star(|p, k| ${stepCondP(s.step)}, &mut kids)`;
    case 'opt': return `self.opt(|p, k| ${s.steps.map(stepCondP).join(' && ')}, &mut kids)`;
    case 'sep': return `self.sep_by(|p, k| ${stepCondP(s.elem)}, ${J(s.delim)}, &mut kids)`;
    case 'altlit': return `self.alt_lit(&[${s.opts.map((o) => `(${J(o.value)}, ${J(o.ttype)})`).join(', ')}], &mut kids)`;
    case 'alt': return `(|p: &mut Parser<'a>, k: &mut Vec<Cst>| -> bool { ${altBody(s.branches)} })(self, &mut kids)`;
    case 'not': return `(|p: &mut Parser<'a>, k: &mut Vec<Cst>| -> bool { ${notBody(s.steps)} })(self, &mut kids)`;
    case 'seq': return `(${s.steps.length ? s.steps.map(stepCond).join(' && ') : 'true'})`;
  }
}
// A backtracking inline alternation rendered as an immediately-applied closure over (p, k),
// so it composes identically whether it sits at top level or already inside a closure.
function altBody(branches: Step[][]): string {
  return `${branches.map((br) => `{ let sp = p.pos; let bk = k.len(); if ${br.length ? br.map(stepCondP).join(' && ') : 'true'} { return true; } p.pos = sp; k.truncate(bk); }`).join(' ')} false`;
}
// Zero-width negative lookahead: try the steps, restore, succeed iff they did NOT all match.
function notBody(steps: Step[]): string {
  return `let sp = p.pos; let bk = k.len(); let m = ${steps.length ? steps.map(stepCondP).join(' && ') : 'true'}; p.pos = sp; k.truncate(bk); !m`;
}
// Inside a closure: uses `p` and `k`.
function stepCondP(s: Step): string {
  switch (s.t) {
    case 'lit': return `p.match_lit(${J(s.value)}, ${J(s.ttype)}, k)`;
    case 'tok': return `p.match_tok(${J(s.name)}, k)`;
    case 'rule': return `p.call_rule(Parser::parse_${s.name}, k)`;
    case 'star': return `p.star(|p, k| ${stepCondP(s.step)}, k)`;
    case 'opt': return `p.opt(|p, k| ${s.steps.map(stepCondP).join(' && ')}, k)`;
    case 'sep': return `p.sep_by(|p, k| ${stepCondP(s.elem)}, ${J(s.delim)}, k)`;
    case 'altlit': return `p.alt_lit(&[${s.opts.map((o) => `(${J(o.value)}, ${J(o.ttype)})`).join(', ')}], k)`;
    case 'alt': return `(|p: &mut Parser<'a>, k: &mut Vec<Cst>| -> bool { ${altBody(s.branches)} })(p, k)`;
    case 'not': return `(|p: &mut Parser<'a>, k: &mut Vec<Cst>| -> bool { ${notBody(s.steps)} })(p, k)`;
    case 'seq': return `(${s.steps.length ? s.steps.map(stepCondP).join(' && ') : 'true'})`;
  }
}

function rdRule(r: RdRule): string {
  const alt = (steps: Step[]) =>
    `        { let mut kids: Vec<Cst> = Vec::new(); if ${steps.map(stepCond).join(' && ')} { return Some(self.branch(${J(r.name)}, kids, save)); } self.pos = save; }`;
  return `    fn parse_${r.name}(&mut self) -> Option<Cst> {
        let save = self.pos;
${r.alts.map(alt).join('\n')}
        None
    }`;
}

function prattRule(r: PrattRule, tpl: TplCfg | null): string {
  const tplNud = tpl && r.nudToks.includes(tpl.token)
    ? `        if t.kind == "$templateHead" {
            return self.match_template().map(|n| { let (o, e) = (n.offset, n.end); Cst::node(${J(r.name)}, vec![n], o, e) });
        }\n`
    : '';
  const binArms = r.binary.map((b) => `${J(b.op)} => Some((${b.lbp}, ${b.rbp}))`).join(', ');
  const preArms = r.prefix.map((p) => `${J(p.op)} => Some(${p.rbp})`).join(', ');
  const atomArm = r.nudToks.map(J).join(' | ');
  const bracketNud = (b: Bracket) => `        if t.text == ${J(b.first)} {
            let save = self.pos; let mut kids: Vec<Cst> = Vec::new();
            if ${b.steps.map(stepCond).join(' && ')} { return Some(node(${J(r.name)}, kids)); }
            self.pos = save; return None;
        }`;
  const ledArm = (b: Bracket, accessTail: boolean) => `            if ${accessTail ? '!tail_closed && ' : ''}t.text == ${J(b.first)} {
                let led_save = self.pos; let mut kids: Vec<Cst> = Vec::new();
                if ${b.steps.map(stepCond).join(' && ')} {
                    let mut full = vec![left]; full.append(&mut kids);
                    left = node(${J(r.name)}, full); continue;
                }
                self.pos = led_save; break;
            }`;
  const postfixArm = (tok: string) => {
    const tplPart = tpl && tok === tpl.token ? `
            if !tail_closed && t.kind == "$templateHead" { if let Some(n) = self.match_template() { left = node(${J(r.name)}, vec![left, n]); continue; } }` : '';
    return `            if !tail_closed && t.kind == ${J(tok)} { self.pos += 1; let leaf = Cst::leaf(t.kind, t.off, t.end); left = node(${J(r.name)}, vec![left, leaf]); continue; }${tplPart}`;
  };
  const postArms = r.postfix.map((p) => `${J(p.op)} => Some(${p.lbp})`).join(', ');
  return `    fn parse_${r.name}(&mut self) -> Option<Cst> { self.${r.name}_bp(0) }
    fn ${r.name}_bin(op: &str) -> Option<(i64, i64)> { match op { ${binArms}${binArms ? ', ' : ''}_ => None } }
    fn ${r.name}_pre(op: &str) -> Option<i64> { match op { ${preArms}${preArms ? ', ' : ''}_ => None } }
    fn ${r.name}_post(op: &str) -> Option<i64> { match op { ${postArms}${postArms ? ', ' : ''}_ => None } }
    fn ${r.name}_atom(kind: &str) -> bool { matches!(kind, ${atomArm || '""'}) }
    fn ${r.name}_bp(&mut self, min_bp: i64) -> Option<Cst> {
        let mut left = self.${r.name}_nud()?;
        let mut tail_closed = false;
        loop {
            let t = match self.peek() { Some(t) => t, None => break };
${r.leds.map((b, i) => ledArm(b, r.ledAccessTail[i])).join('\n')}
${r.postfixToks.map(postfixArm).join('\n')}
            if let Some(plbp) = Parser::${r.name}_post(t.text) { if !tail_closed && plbp > min_bp { self.pos += 1; let op_leaf = Cst::leaf("$operator", t.off, t.end); left = node(${J(r.name)}, vec![left, op_leaf]); tail_closed = true; continue; } }
            let (lbp, rbp) = match Parser::${r.name}_bin(t.text) { Some(x) => x, None => break };
            if lbp <= min_bp { break; }
            let led_save = self.pos;
            self.pos += 1;
            let op_leaf = Cst::leaf("$operator", t.off, t.end);
            let rhs = match self.${r.name}_bp(rbp) { Some(r) => r, None => { self.pos = led_save; break; } };
            left = node(${J(r.name)}, vec![left, op_leaf, rhs]);
        }
        Some(left)
    }
    fn ${r.name}_nud(&mut self) -> Option<Cst> {
        let t = self.peek()?;
${tplNud}        if Parser::${r.name}_atom(t.kind) {
            self.pos += 1;
            return Some(Cst::node(${J(r.name)}, vec![Cst::leaf(t.kind, t.off, t.end)], t.off, t.end));
        }
${r.nudBrackets.map(bracketNud).join('\n')}
        if let Some(pbp) = Parser::${r.name}_pre(t.text) {
            let save = self.pos; self.pos += 1;
            let op_leaf = Cst::leaf("$operator", t.off, t.end);
            match self.${r.name}_bp(pbp) {
                Some(operand) => { let (o, e) = (t.off, operand.end); return Some(Cst::node(${J(r.name)}, vec![op_leaf, operand], o, e)); }
                None => { self.pos = save; return None; }
            }
        }
${r.nudSeqs.map((seq) => `        { let save = self.pos; let mut kids: Vec<Cst> = Vec::new(); if ${seq.length ? seq.map(stepCond).join(' && ') : 'true'} { return Some(self.branch(${J(r.name)}, kids, save)); } self.pos = save; }`).join('\n')}
        None
    }`;
}

export const rustTarget: Target = {
  name: 'rust',
  ext: 'rs',
  render(ir: ParserIR): string {
    const ruleFns = ir.rules.map((r) => (r.kind === 'pratt' ? prattRule(r, ir.tpl) : rdRule(r))).join('\n\n');
    const matchTemplate = ir.tpl ? `    fn match_template(&mut self) -> Option<Cst> {
        let t = self.peek()?;
        if t.kind != "$templateHead" { return None; }
        let save = self.pos; self.pos += 1;
        let mut children: Vec<Cst> = vec![Cst::leaf("$templateHead", t.off, t.end)];
        loop {
            let expr = match self.parse_${ir.tpl.interpRule}() { Some(e) => e, None => { self.pos = save; return None; } };
            children.push(expr);
            let next = match self.peek() { Some(x) => x, None => { self.pos = save; return None; } };
            if next.kind == "$templateMiddle" { children.push(Cst::leaf("$templateMiddle", next.off, next.end)); self.pos += 1; continue; }
            if next.kind == "$templateTail" { children.push(Cst::leaf("$templateTail", next.off, next.end)); self.pos += 1; break; }
            self.pos = save; return None;
        }
        let o = children[0].offset; let e = children[children.len() - 1].end;
        Some(Cst::node("$template", children, o, e))
    }
` : '';
    return `// GENERATED by emit-portable.ts (rustTarget) — parser for grammar "${ir.grammarName}".
#![allow(non_snake_case)]
use std::io::Read;

// Zero-alloc tokens: kind is a known grammar name (&'static str), text is a slice of the
// source. Tok is Copy, so peek() copies pointers — no per-peek heap work.
#[derive(Clone, Copy)]
struct Tok<'a> { kind: &'static str, text: &'a str, off: usize, end: usize }

// CST nodes hold only &'static str labels (rule names / token-type tags are all literals)
// + usize spans — no per-node String allocation.
struct Cst { rule: &'static str, children: Vec<Cst>, is_leaf: bool, token_type: &'static str, offset: usize, end: usize }
impl Cst {
    fn leaf(tt: &'static str, off: usize, end: usize) -> Cst { Cst { rule: "", children: Vec::new(), is_leaf: true, token_type: tt, offset: off, end } }
    fn node(rule: &'static str, children: Vec<Cst>, offset: usize, end: usize) -> Cst { Cst { rule, children, is_leaf: false, token_type: "", offset, end } }
}
// offset/end inferred from first/last child (children non-empty).
fn node(rule: &'static str, kids: Vec<Cst>) -> Cst { let o = kids[0].offset; let e = kids[kids.len() - 1].end; Cst::node(rule, kids, o, e) }

${lexer(ir)}

struct Parser<'a> { toks: Vec<Tok<'a>>, pos: usize }
impl<'a> Parser<'a> {
    fn peek(&self) -> Option<Tok<'a>> { if self.pos < self.toks.len() { Some(self.toks[self.pos]) } else { None } }
    fn branch(&self, rule: &'static str, kids: Vec<Cst>, save: usize) -> Cst {
        let offset = if !kids.is_empty() { kids[0].offset } else if save < self.toks.len() { self.toks[save].off } else { 0 };
        let end = if !kids.is_empty() { kids[kids.len() - 1].end } else { offset };
        Cst::node(rule, kids, offset, end)
    }
    fn match_lit(&mut self, value: &str, ttype: &'static str, kids: &mut Vec<Cst>) -> bool {
        match self.peek() { Some(t) if t.text == value => { kids.push(Cst::leaf(ttype, t.off, t.end)); self.pos += 1; true } _ => false }
    }
    fn match_tok(&mut self, name: &'static str, kids: &mut Vec<Cst>) -> bool {
        match self.peek() { Some(t) if t.kind == name => { kids.push(Cst::leaf(name, t.off, t.end)); self.pos += 1; true } _ => false }
    }
    fn call_rule(&mut self, f: fn(&mut Parser<'a>) -> Option<Cst>, kids: &mut Vec<Cst>) -> bool {
        match f(self) { Some(n) => { kids.push(n); true } None => false }
    }
    fn star(&mut self, once: fn(&mut Parser<'a>, &mut Vec<Cst>) -> bool, kids: &mut Vec<Cst>) -> bool {
        loop { let sp = self.pos; let before = kids.len(); if !once(self, kids) { self.pos = sp; kids.truncate(before); break; } }
        true
    }
    fn opt(&mut self, body: fn(&mut Parser<'a>, &mut Vec<Cst>) -> bool, kids: &mut Vec<Cst>) -> bool {
        let sp = self.pos; let before = kids.len(); if !body(self, kids) { self.pos = sp; kids.truncate(before); } true
    }
    fn sep_by(&mut self, elem: fn(&mut Parser<'a>, &mut Vec<Cst>) -> bool, delim: &str, kids: &mut Vec<Cst>) -> bool {
        if !elem(self, kids) { return false; }
        loop { let sp = self.pos; let before = kids.len(); if self.match_lit(delim, "$punct", kids) && elem(self, kids) { continue; } self.pos = sp; kids.truncate(before); break; }
        true
    }
    fn alt_lit(&mut self, opts: &[(&str, &'static str)], kids: &mut Vec<Cst>) -> bool {
        for (v, tt) in opts { if self.match_lit(v, tt, kids) { return true; } }
        false
    }

${matchTemplate}${ruleFns}
}

fn write_json(c: &Cst, out: &mut String) {
    if c.is_leaf {
        out.push_str(&format!("{{\\"tokenType\\":\\"{}\\",\\"offset\\":{},\\"end\\":{}}}", c.token_type, c.offset, c.end));
        return;
    }
    out.push_str(&format!("{{\\"rule\\":\\"{}\\",\\"children\\":[", c.rule));
    for (i, k) in c.children.iter().enumerate() { if i > 0 { out.push(','); } write_json(k, out); }
    out.push_str(&format!("],\\"offset\\":{},\\"end\\":{}}}", c.offset, c.end));
}

fn main() {
    let mut src = String::new();
    std::io::stdin().read_to_string(&mut src).unwrap();
    // Self-bench: a numeric arg N times the lex+parse loop and prints ms/iteration.
    if let Some(iters) = std::env::args().nth(1).and_then(|a| a.parse::<u64>().ok()) {
        // black_box on the input + result so the optimizer can't elide the lex/parse.
        for _ in 0..3 { let toks = lex(std::hint::black_box(&src)); let mut p = Parser { toks, pos: 0 }; std::hint::black_box(p.parse_${ir.entry}()); }
        let t = std::time::Instant::now();
        for _ in 0..iters { let toks = lex(std::hint::black_box(&src)); let mut p = Parser { toks, pos: 0 }; std::hint::black_box(p.parse_${ir.entry}()); }
        println!("{:.4}", t.elapsed().as_secs_f64() * 1000.0 / iters as f64);
        return;
    }
    let toks = lex(&src);
    let n = toks.len();
    let mut p = Parser { toks, pos: 0 };
    match p.parse_${ir.entry}() {
        Some(root) if p.pos == n => { let mut out = String::new(); write_json(&root, &mut out); print!("{}", out); }
        _ => { eprintln!("parse error (pos {}/{})", p.pos, n); std::process::exit(1); }
    }
}
`;
  },
};
