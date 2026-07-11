// The Rust Target for emit-portable. Renders the same language-agnostic ParserIR as
// tsTarget/goTarget into a self-contained Rust program (no external crates — the lexer is
// regex-free, so it compiles with rustc alone, no Cargo/network). Its CST JSON is checked
// against the interpreter on accept/reject parity, so `emitParser(grammar, rustTarget)` is a
// real, verified Rust parser derived from the same grammar definition.
//
// ARENA allocation (mirrors goTarget / tsgo / oxc): nodes live in a flat `nodes: Vec<Node>`,
// their children in a flat `kids: Vec<i32>`, and in-progress children accumulate on a
// `scratch: Vec<i32>` stack. A node is an `i32` index, never a heap pointer. Backtracking
// truncates the three vecs to saved lengths; they keep capacity across parses, so a warmed
// parser allocates ~nothing per parse. Rule fns return `i32` (-1 = fail); sub-sequence
// combinators take non-capturing `fn(&mut Parser) -> bool` pointers (the kids vec is now on
// the Parser as `scratch`, so the second param the old owned-tree version threaded is gone).
import type { ParserIR, RdRule, PrattRule, Step, Bracket, CharRange, LexTok, TplCfg, NewlineCfg, FirstSig } from './emit-portable.ts';
import { portableIR } from './emit-portable.ts';
import type { Target } from './emit.ts';
import type { TokenPattern, CstGrammar } from './types.ts';

const J = (v: unknown) => JSON.stringify(v);
const rangeCond = (v: string, rs: CharRange[]) =>
  '(' + rs.map(([lo, hi]) => (lo === hi ? `${v} == ${lo}` : `(${lo}..=${hi}).contains(&${v})`)).join(' || ') + ')';

// Boolean expr testing whether the buffered token t starts branch i (FIRST set membership).
// null FirstSig → 'false' (never matched here; predictive alts have all-non-null FIRSTs).
const firstCond = (f: FirstSig, t: string) => f
  ? `(${f.lits.map((l) => `${t}.text == ${J(l)}`).join(' || ') || 'false'} || ${f.toks.map((k) => `${t}.kind == ${J(k)}`).join(' || ') || 'false'})`
  : 'false';

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

function scanTok(t: LexTok, defs: string[], stateful: boolean, rxTok?: string, tplTok?: string): string {
  const name = (t as { name: string }).name;
  if (tplTok !== undefined && name === tplTok) return '';   // template token scanned by the state machine
  const nlVar = stateful ? 'st.pending_nl' : 'pending_nl';
  const push = (endE: string) => (t.skip ? `if src[pos..${endE}].chars().any(|c| matches!(c, '\\n' | '\\r' | '\\u{2028}' | '\\u{2029}')) { ${nlVar} = true; } ` : stateful ? `st.emit(${J(name)}, &src[pos..${endE}], pos, ${endE}); ` : `toks.push(Tok { kind: ${J(name)}, text: &src[pos..${endE}], off: pos, end: ${endE}, nl: pending_nl }); pending_nl = false; `);
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

function newlinePartsRs(nl: NewlineCfg): { consts: string; fields: string; init: string; boundary: string; ws: string; hooks: string } {
  const commentSkip = nl.comment
    ? `            if src[p..].starts_with(${J(nl.comment)}) { let mut e = p; while e < n && b[e] != 10 { e += 1; } pos = e; continue; }\n`
    : '';
  return {
    consts: `const _NLTOK: &str = ${J(nl.token)};
const _FLOW_OPEN: &[&str] = ${`&[${nl.flowOpen.map(J).join(', ')}]`};
const _FLOW_CLOSE: &[&str] = ${`&[${nl.flowClose.map(J).join(', ')}]`};
`,
    fields: 'line_start: bool, emitted_content: bool, flow_depth: i64',
    init: 'line_start: true, emitted_content: false, flow_depth: 0',
    boundary: `        if st.flow_depth == 0 && st.line_start {
            let mut p = pos;
            while p < n && b[p] == 32 { p += 1; }
            if p >= n { pos = p; st.line_start = false; continue; }
            let ch = b[p] as u32;
            if ch == 10 || ch == 13 {
                pos = p + 1; if ch == 13 && pos < n && b[pos] == 10 { pos += 1; } continue;
            }
            if ch == 9 {
                let mut bb = p;
                while bb < n && (b[bb] == 32 || b[bb] == 9) { bb += 1; }
                if bb >= n { pos = bb; continue; }
                let bc = b[bb] as u32;
                if bc == 10 || bc == 13 {
                    pos = bb + 1; if bc == 13 && pos < n && b[pos] == 10 { pos += 1; } continue;
                }
            }
${commentSkip}            pos = p;
            if st.emitted_content { st.emit(_NLTOK, &src[pos..pos], pos, pos); }
            st.line_start = false;
            continue;
        }
`,
    ws: `        if c == 32 || c == 9 || c == 11 || c == 12 || c == 160 || c == 5760 || (c >= 8192 && c <= 8202) || c == 8239 || c == 8287 || c == 12288 || c == 65279 { pos += 1; continue; }
        if c == 10 || c == 13 {
            pos += 1; if c == 13 && pos < n && b[pos] == 10 { pos += 1; }
            if st.flow_depth == 0 { st.line_start = true; } else { st.pending_nl = true; }
            continue;
        }
`,
    hooks: `        if kind != _NLTOK { self.emitted_content = true; }
        if kind == "" && _in(_FLOW_OPEN, text) { self.flow_depth += 1; }
        else if kind == "" && _in(_FLOW_CLOSE, text) { self.flow_depth = (self.flow_depth - 1).max(0); }
`,
  };
}

function lexer(ir: ParserIR): string {
  const defs: string[] = [];
  const rx = ir.regexCtx;
  const tpl = ir.tpl;
  const nl = ir.newlineCfg;
  const nlRs = nl ? newlinePartsRs(nl) : null;
  const stateful = !!(rx || tpl || nl);
  const toks = ir.tokens.map((t) => scanTok(t, defs, stateful, rx?.regexToken, tpl?.token)).join('\n');
  const puncts = ir.puncts.map((p) =>
    `        if src[pos..].starts_with(${J(p)}) { ${stateful ? `st.emit("", &src[pos..pos + ${p.length}], pos, pos + ${p.length});` : `toks.push(Tok { kind: "", text: &src[pos..pos + ${p.length}], off: pos, end: pos + ${p.length}, nl: pending_nl }); pending_nl = false;`} pos += ${p.length}; continue; }`).join('\n');
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
${nlRs ? nlRs.consts : ''}` : (nlRs ? `fn _in(set: &[&str], x: &str) -> bool { set.iter().any(|s| *s == x) }
${nlRs.consts}` : '');
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
  const fields = ['toks: Vec<Tok<\'a>>', 'pending_nl: bool',
    rx ? 'prev_text: &\'a str, prev_kind: &\'static str, bp_text: &\'a str, has_prev: bool, has_prev2: bool, paren_head: Vec<bool>, last_close: bool, last_bang: bool' : '',
    tpl ? 'template_stack: Vec<i64>' : '',
    nlRs ? nlRs.fields : ''].filter(Boolean).join(', ');
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
    nlRs ? nlRs.hooks : '',
  ].filter(Boolean).join('\n');
  const emitTail = rx ? `
        self.bp_text = self.prev_text; self.has_prev2 = self.has_prev; self.prev_kind = kind; self.prev_text = text; self.has_prev = true;` : '';
  const stateImpl = stateful ? `struct LexState<'a> { ${fields} }
impl<'a> LexState<'a> {
${prevIsValue}    fn emit(&mut self, kind: &'static str, text: &'a str, off: usize, end: usize) {
${emitHooks}
        self.toks.push(Tok { kind, text, off, end, nl: self.pending_nl }); self.pending_nl = false;${emitTail}
    }
}
` : '';
  const initFields = ['toks: Vec::new()', 'pending_nl: false',
    rx ? 'prev_text: "", prev_kind: "", bp_text: "", has_prev: false, has_prev2: false, paren_head: Vec::new(), last_close: false, last_bang: false' : '',
    tpl ? 'template_stack: Vec::new()' : '',
    nlRs ? nlRs.init : ''].filter(Boolean).join(', ');
  const open = stateful ? `    let mut st = LexState { ${initFields} };` : `    let mut toks: Vec<Tok> = Vec::new();\n    let mut pending_nl = false;`;
  const nlVar = stateful ? 'st.pending_nl' : 'pending_nl';
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
  const nlBoundary = nlRs ? nlRs.boundary : '';
  const nlWs = nlRs ? nlRs.ws : `        if c == 32 || c == 9 { pos += 1; continue; }
        if pos + 2 < n && b[pos] == 0xE2 && b[pos + 1] == 0x80 && (b[pos + 2] == 0xA8 || b[pos + 2] == 0xA9) { ${nlVar} = true; pos += 3; continue; }   // LS/PS (UTF-8)
        if c == 10 || c == 13 { ${nlVar} = true; pos += 1; continue; }   // LF/CR
`;
  return `${defs.length ? defs.join('\n') + '\n' : ''}${rxConsts}${tplFn}${stateImpl}fn lex<'a>(src: &'a str) -> Vec<Tok<'a>> {
    let b = src.as_bytes();
    let n = b.len();
${open}
    let mut pos = 0usize;
    while pos < n {
${nlBoundary}        let c = b[pos] as u32;
${nlWs}${tplDispatch}${toks}
${puncts}
        panic!("lex error at {}", pos);
    }
    ${stateful ? 'st.toks' : 'toks'}
}`;
}

// Top-level step: uses `self`; children accumulate on `self.scratch`.
function stepCond(s: Step): string {
  switch (s.t) {
    case 'lit': return `self.match_lit(${J(s.value)}, ${J(s.ttype)})`;
    case 'tok': return `self.match_tok(${J(s.name)})`;
    case 'rule': return `self.call_rule(Parser::parse_${s.name})`;
    case 'ruleBp': return `self.call_rule(|p| p.${s.name}_bp(${s.bp}))`;
    case 'star': return `self.star(|p| ${stepCondP(s.step)})`;
    case 'opt': return `self.opt(|p| ${s.steps.map(stepCondP).join(' && ')})`;
    case 'sep': return `self.sep_by(|p| ${stepCondP(s.elem)}, ${J(s.delim)})`;
    case 'altlit': return `self.alt_lit(&[${s.opts.map((o) => `(${J(o.value)}, ${J(o.ttype)})`).join(', ')}])`;
    case 'alt': return s.predictive ? `(|p: &mut Parser<'a>| -> bool { ${predAltBody(s.branches, s.firsts)} })(self)` : `(|p: &mut Parser<'a>| -> bool { ${altBody(s.branches)} })(self)`;
    case 'not': return `(|p: &mut Parser<'a>| -> bool { ${notBody(s.steps)} })(self)`;
    case 'seq': return `(${s.steps.length ? s.steps.map(stepCond).join(' && ') : 'true'})`;
    case 'sameLine': return `matches!(self.peek(), Some(t) if !t.nl)`;
    case 'suppress': return `{ self.suppress_next = vec![${s.connectors.map(J).join(', ')}]; let _r = (${s.steps.length ? s.steps.map(stepCond).join(' && ') : 'true'}); self.suppress_next = Vec::new(); _r }`;
  }
}
// A backtracking inline alternation rendered as an immediately-applied closure over p,
// so it composes identically whether it sits at top level or already inside a closure.
function altBody(branches: Step[][]): string {
  return `${branches.map((br) => `{ let sp = p.pos; let sb = p.scratch.len(); let nb = p.nodes.len(); let kb = p.kids.len(); if ${br.length ? br.map(stepCondP).join(' && ') : 'true'} { return true; } p.pos = sp; p.scratch.truncate(sb); p.nodes.truncate(nb); p.kids.truncate(kb); }`).join(' ')} false`;
}
// Zero-width negative lookahead: try the steps, restore, succeed iff they did NOT all match.
function notBody(steps: Step[]): string {
  return `let sp = p.pos; let sb = p.scratch.len(); let nb = p.nodes.len(); let kb = p.kids.len(); let m = ${steps.length ? steps.map(stepCondP).join(' && ') : 'true'}; p.pos = sp; p.scratch.truncate(sb); p.nodes.truncate(nb); p.kids.truncate(kb); !m`;
}
// Inside a closure: uses `p`.
function stepCondP(s: Step): string {
  switch (s.t) {
    case 'lit': return `p.match_lit(${J(s.value)}, ${J(s.ttype)})`;
    case 'tok': return `p.match_tok(${J(s.name)})`;
    case 'rule': return `p.call_rule(Parser::parse_${s.name})`;
    case 'ruleBp': return `p.call_rule(|p| p.${s.name}_bp(${s.bp}))`;
    case 'star': return `p.star(|p| ${stepCondP(s.step)})`;
    case 'opt': return `p.opt(|p| ${s.steps.map(stepCondP).join(' && ')})`;
    case 'sep': return `p.sep_by(|p| ${stepCondP(s.elem)}, ${J(s.delim)})`;
    case 'altlit': return `p.alt_lit(&[${s.opts.map((o) => `(${J(o.value)}, ${J(o.ttype)})`).join(', ')}])`;
    case 'alt': return s.predictive ? `(|p: &mut Parser<'a>| -> bool { ${predAltBody(s.branches, s.firsts)} })(p)` : `(|p: &mut Parser<'a>| -> bool { ${altBody(s.branches)} })(p)`;
    case 'not': return `(|p: &mut Parser<'a>| -> bool { ${notBody(s.steps)} })(p)`;
    case 'seq': return `(${s.steps.length ? s.steps.map(stepCondP).join(' && ') : 'true'})`;
    case 'sameLine': return `matches!(p.peek(), Some(t) if !t.nl)`;
    case 'suppress': return `{ p.suppress_next = vec![${s.connectors.map(J).join(', ')}]; let _r = (${s.steps.length ? s.steps.map(stepCondP).join(' && ') : 'true'}); p.suppress_next = Vec::new(); _r }`;
  }
}

// Predictive alternation: FIRST sets are disjoint, so the buffered token selects exactly one
// branch — no save/restore per branch, no cross-branch backtracking. If the selected branch's
// body fails, the alt fails (the enclosing rule restores pos to its own save). Parity holds
// because disjoint EXACT FIRSTs mean no other branch could match the first token.
function predAltBody(branches: Step[][], firsts?: FirstSig[]): string {
  const arms = branches.map((br, i) => `        ${i === 0 ? 'if' : 'else if'} ${firstCond(firsts![i], 't')} { if ${br.length ? br.map(stepCondP).join(' && ') : 'true'} { return true; } }`).join('\n');
  return `let t = match p.peek() { Some(t) => t, None => return false };\n${arms}\n        false`;
}

function rdRule(r: RdRule): string {
  if (r.predictive) {
    const arm = (steps: Step[], i: number) => `        ${i === 0 ? 'if' : 'else if'} ${firstCond(r.altFirst[i], 't')} { if ${steps.map(stepCond).join(' && ')} { return Some(self.finish(${J(r.cstName)}, sb, self.off_at(save))); } }`;
    return `    fn parse_${r.name}(&mut self) -> Option<i32> {
        let save = self.pos; let sb = self.scratch.len(); let nb = self.nodes.len(); let kb = self.kids.len();
        let t = match self.peek() { Some(t) => t, None => return None };
${r.alts.map(arm).join('\n')}
        self.pos = save; self.scratch.truncate(sb); self.nodes.truncate(nb); self.kids.truncate(kb);
        None
    }`;
  }
  const alt = (steps: Step[]) =>
    `        if ${steps.map(stepCond).join(' && ')} { return Some(self.finish(${J(r.cstName)}, sb, self.off_at(save))); }
        self.pos = save; self.scratch.truncate(sb); self.nodes.truncate(nb); self.kids.truncate(kb);`;
  return `    fn parse_${r.name}(&mut self) -> Option<i32> {
        let save = self.pos; let sb = self.scratch.len(); let nb = self.nodes.len(); let kb = self.kids.len();
${r.alts.map(alt).join('\n')}
        None
    }`;
}

function prattRule(r: PrattRule, tpl: TplCfg | null): string {
  const tplNud = tpl && r.nudToks.includes(tpl.token)
    ? `        if t.kind == "$templateHead" {
            let n = match self.match_template() { Some(n) => n, None => return None };
            let sb = self.scratch.len(); self.scratch.push(n);
            return Some(self.finish(${J(r.cstName)}, sb, self.nodes[n as usize].offset));
        }\n`
    : '';
  const binArms = r.binary.map((b) => `${J(b.op)} => Some((${b.lbp}, ${b.rbp}))`).join(', ');
  const preArms = r.prefix.map((p) => `${J(p.op)} => Some(${p.rbp})`).join(', ');
  const atomArm = r.nudToks.map(J).join(' | ');
  const bracketNud = (b: Bracket) => `        if t.text == ${J(b.first)} {
            let save = self.pos; let sb = self.scratch.len(); let nb = self.nodes.len(); let kb = self.kids.len();
            if ${b.steps.map(stepCond).join(' && ')} { return Some(self.finish(${J(r.cstName)}, sb, t.off)); }
            self.pos = save; self.scratch.truncate(sb); self.nodes.truncate(nb); self.kids.truncate(kb);
        }`;
  const ledArm = (b: Bracket, accessTail: boolean, lbp: number | null, sameLine: boolean, nll: string[] | null) => `            if ${accessTail ? '!tail_closed && ' : ''}${lbp !== null ? `${lbp} > min_bp && ` : ''}${sameLine ? '!t.nl && ' : ''}${nll ? `!self.nll_blocked(&[${nll.map(J).join(', ')}], left) && ` : ''}!self.suppress_cur.iter().any(|c| *c == ${J(b.first)}) && t.text == ${J(b.first)} {
                let led_save = self.pos; let sb = self.scratch.len(); let nb = self.nodes.len(); let kb = self.kids.len();
                self.scratch.push(left);
                if ${b.steps.map(stepCond).join(' && ')} { left = self.finish(${J(r.cstName)}, sb, self.nodes[left as usize].offset); continue; }
                self.pos = led_save; self.scratch.truncate(sb); self.nodes.truncate(nb); self.kids.truncate(kb); break;
            }`;
  const postfixArm = (tok: string) => {
    const tplPart = tpl && tok === tpl.token ? `
            if !tail_closed && t.kind == "$templateHead" { if let Some(n) = self.match_template() { let sb = self.scratch.len(); self.scratch.push(left); self.scratch.push(n); left = self.finish(${J(r.cstName)}, sb, self.nodes[left as usize].offset); continue; } }` : '';
    return `            if !tail_closed && t.kind == ${J(tok)} { self.pos += 1; let sb = self.scratch.len(); self.scratch.push(left); self.push_leaf(t.kind, t.off, t.end); left = self.finish(${J(r.cstName)}, sb, self.nodes[left as usize].offset); continue; }${tplPart}`;
  };
  const postArms = r.postfix.map((p) => `${J(p.op)} => Some(${p.lbp})`).join(', ');
  return `    fn parse_${r.name}(&mut self) -> Option<i32> {
        let prev = std::mem::take(&mut self.suppress_cur);
        self.suppress_cur = std::mem::take(&mut self.suppress_next);
        let r = self.${r.name}_bp(0);
        self.suppress_cur = prev;
        r
    }
    fn ${r.name}_bin(op: &str) -> Option<(i64, i64)> { match op { ${binArms}${binArms ? ', ' : ''}_ => None } }
    fn ${r.name}_pre(op: &str) -> Option<i64> { match op { ${preArms}${preArms ? ', ' : ''}_ => None } }
    fn ${r.name}_post(op: &str) -> Option<i64> { match op { ${postArms}${postArms ? ', ' : ''}_ => None } }
    fn ${r.name}_atom(kind: &str) -> bool { matches!(kind, ${atomArm || '""'}) }
    fn ${r.name}_bp(&mut self, min_bp: i64) -> Option<i32> {
        let mut left = self.${r.name}_nud(min_bp)?;
        if self.capped { return Some(left); }
        let mut tail_closed = false;
        loop {
            let t = match self.peek() { Some(t) => t, None => break };
${r.leds.map((b, i) => ledArm(b, r.ledAccessTail[i], r.ledLbp[i], r.ledSameLine[i], r.ledNotLeftLeaf[i])).join('\n')}
${r.postfixToks.map(postfixArm).join('\n')}
            if let Some(plbp) = Parser::${r.name}_post(t.text) { if !tail_closed && plbp > min_bp { self.pos += 1; let sb = self.scratch.len(); self.scratch.push(left); self.push_leaf("$operator", t.off, t.end); left = self.finish(${J(r.cstName)}, sb, self.nodes[left as usize].offset); tail_closed = true; continue; } }
            let (lbp, rbp) = match Parser::${r.name}_bin(t.text) { Some(x) => x, None => break };
            if lbp <= min_bp { break; }
            let led_save = self.pos;
            self.pos += 1;
            let sb = self.scratch.len(); self.scratch.push(left); self.push_leaf("$operator", t.off, t.end);
            let rhs = match self.${r.name}_bp(rbp) { Some(r) => r, None => { self.pos = led_save; break; } };
            self.scratch.push(rhs);
            left = self.finish(${J(r.cstName)}, sb, self.nodes[left as usize].offset);
        }
        Some(left)
    }
    fn ${r.name}_nud(&mut self, min_bp: i64) -> Option<i32> {
        self.capped = false;
        let t = self.peek()?;
${r.nudCapped.map((c) => `        if min_bp < ${c.capBp} { let save = self.pos; let sb = self.scratch.len(); let nb = self.nodes.len(); let kb = self.kids.len(); if ${c.steps.length ? c.steps.map(stepCond).join(' && ') : 'true'} { self.capped = true; return Some(self.finish(${J(r.cstName)}, sb, self.off_at(save))); } self.pos = save; self.scratch.truncate(sb); self.nodes.truncate(nb); self.kids.truncate(kb); }`).join('\n')}
        // non-capped: a sub-parse may leave capped set (grouping a capped arrow); force it false after
        let r = self.${r.name}_nud_rest(t);
        self.capped = false;
        r
    }
    fn ${r.name}_nud_rest(&mut self, t: Tok<'a>) -> Option<i32> {
${tplNud}        if Parser::${r.name}_atom(t.kind) {
            let sb = self.scratch.len(); self.push_leaf(t.kind, t.off, t.end); self.pos += 1;
            return Some(self.finish(${J(r.cstName)}, sb, t.off));
        }
${r.nudBrackets.map(bracketNud).join('\n')}
        if let Some(pbp) = Parser::${r.name}_pre(t.text) {
            let save = self.pos; self.pos += 1;
            let sb = self.scratch.len(); self.push_leaf("$operator", t.off, t.end);
            match self.${r.name}_bp(pbp) {
                Some(operand) => { return Some(self.finish(${J(r.cstName)}, sb, t.off)); }
                None => { self.pos = save; self.scratch.truncate(sb); return None; }
            }
        }
${r.nudSeqs.map((seq) => `        { let save = self.pos; let sb = self.scratch.len(); let nb = self.nodes.len(); let kb = self.kids.len(); if ${seq.length ? seq.map(stepCond).join(' && ') : 'true'} { return Some(self.finish(${J(r.cstName)}, sb, self.off_at(save))); } self.pos = save; self.scratch.truncate(sb); self.nodes.truncate(nb); self.kids.truncate(kb); }`).join('\n')}
        None
    }`;
}

export const rustTarget: Target = {
  name: 'rust',
  ext: 'rs',
  embedLexer(grammar: CstGrammar): string {
    return lexer(portableIR(grammar));
  },
  emitLexer(grammar: CstGrammar): string {
    return `// GENERATED by emit-portable.ts (rustTarget) — standalone TOKENIZER for grammar "${grammar.name ?? ''}".
// tokenize(src) -> Vec<Tok>. The same lexer is embedded in emitParser's output, so the tokens
// are identical. Compile as a library (rustc --crate-type lib) or include via \`mod\`.
#![allow(dead_code)]
struct Tok<'a> { kind: &'static str, text: &'a str, off: usize, end: usize, nl: bool }

${lexer(portableIR(grammar))}

pub fn tokenize<'a>(src: &'a str) -> Vec<Tok<'a>> { lex(src) }
`;
  },
  emitParser(grammar: CstGrammar, lexerSrc: string | null): string {
    const ir = portableIR(grammar);
    const ruleFns = ir.rules.map((r) => (r.kind === 'pratt' ? prattRule(r, ir.tpl) : rdRule(r))).join('\n\n');
    const matchTemplate = ir.tpl ? `    fn match_template(&mut self) -> Option<i32> {
        let t = self.peek()?;
        if t.kind != "$templateHead" { return None; }
        let save = self.pos; let sb = self.scratch.len(); let nb = self.nodes.len(); let kb = self.kids.len();
        self.push_leaf("$templateHead", t.off, t.end); self.pos += 1;
        loop {
            let expr = match self.parse_${ir.tpl.interpRule}() { Some(e) => e, None => { self.pos = save; self.scratch.truncate(sb); self.nodes.truncate(nb); self.kids.truncate(kb); return None; } };
            self.scratch.push(expr);
            let next = match self.peek() { Some(x) => x, None => { self.pos = save; self.scratch.truncate(sb); self.nodes.truncate(nb); self.kids.truncate(kb); return None; } };
            if next.kind == "$templateMiddle" { self.push_leaf("$templateMiddle", next.off, next.end); self.pos += 1; continue; }
            if next.kind == "$templateTail" { self.push_leaf("$templateTail", next.off, next.end); self.pos += 1; break; }
            self.pos = save; self.scratch.truncate(sb); self.nodes.truncate(nb); self.kids.truncate(kb); return None;
        }
        let o = self.nodes[self.scratch[sb] as usize].offset;
        Some(self.finish("$template", sb, o))
    }
` : '';
    return `// GENERATED by emit-portable.ts (rustTarget) — parser for grammar "${ir.grammarName}".
#![allow(non_snake_case)]
use std::io::Read;

// Zero-alloc tokens: kind is a known grammar name (&'static str), text is a slice of the
// source. Tok is Copy, so peek() copies pointers — no per-peek heap work.
#[derive(Clone, Copy)]
struct Tok<'a> { kind: &'static str, text: &'a str, off: usize, end: usize, nl: bool }

// Arena node: a flat record in \`nodes\`; children are a contiguous range in \`kids\` (kid_start,
// kid_count). No per-node heap allocation — the arena grows by Vec push, and backtracking
// truncates the three vecs (nodes/kids/scratch) to saved lengths. Nodes hold only &'static str
// labels + usize spans: no per-node String.
struct Node { rule: &'static str, token_type: &'static str, is_leaf: bool, kid_start: u32, kid_count: u32, offset: usize, end: usize }

${lexerSrc ?? ''}

struct Parser<'a> { toks: Vec<Tok<'a>>, pos: usize, capped: bool, suppress_next: Vec<&'static str>, suppress_cur: Vec<&'static str>, src: &'a str, nodes: Vec<Node>, kids: Vec<i32>, scratch: Vec<i32> }
impl<'a> Parser<'a> {
    fn peek(&self) -> Option<Tok<'a>> { if self.pos < self.toks.len() { Some(self.toks[self.pos]) } else { None } }
    fn off_at(&self, i: usize) -> usize { if i < self.toks.len() { self.toks[i].off } else { 0 } }
    fn mk_leaf(&mut self, ttype: &'static str, off: usize, end: usize) -> i32 {
        self.nodes.push(Node { rule: "", token_type: ttype, is_leaf: true, kid_start: 0, kid_count: 0, offset: off, end });
        (self.nodes.len() - 1) as i32
    }
    // mk_leaf + scratch.push combined: the obvious self.scratch.push(self.mk_leaf(...)) is a
    // double mutable borrow of self, so this splits the two statements. CST compression (Phase 5):
    // punctuation ($punct) leaves are TRIVIA — they carry no semantic content the rule node
    // doesn't already capture — so they are NOT recorded. This cuts arena node count substantially
    // with no loss of parse decisions or recoverable spans (a rule node's offset/end still come
    // from its first/last KEPT child). $operator leaves are KEPT: the Pratt notLeftLeaf guard
    // (void/typeof/delete .x blocking) reads the head leaf of a prefix-op node, which is its
    // $operator leaf. Token-kind leaves (identifiers, literals, numbers), $keyword, and
    // $template* parts are kept.
    fn push_leaf(&mut self, ttype: &'static str, off: usize, end: usize) { if ttype != "$punct" { let id = self.mk_leaf(ttype, off, end); self.scratch.push(id); } }
    // Wrap the scratch entries [sb:] as one node's children (flattened into kids); truncate scratch.
    fn finish(&mut self, rule: &'static str, sb: usize, fallback_off: usize) -> i32 {
        let nn = self.scratch.len();
        let kid_start = self.kids.len();
        let off = if nn > sb { self.nodes[self.scratch[sb] as usize].offset } else { fallback_off };
        let end = if nn > sb { self.nodes[self.scratch[nn - 1] as usize].end } else { fallback_off };
        self.kids.extend(self.scratch[sb..nn].iter().copied());
        self.scratch.truncate(sb);
        self.nodes.push(Node { rule, token_type: "", is_leaf: false, kid_start: kid_start as u32, kid_count: (nn - sb) as u32, offset: off, end });
        (self.nodes.len() - 1) as i32
    }
    fn head_leaf_text(&self, node: i32) -> &'a str {
        let mut id = node as usize;
        while !self.nodes[id].is_leaf && self.nodes[id].kid_count > 0 { id = self.kids[self.nodes[id].kid_start as usize] as usize; }
        &self.src[self.nodes[id].offset..self.nodes[id].end]
    }
    fn nll_blocked(&self, words: &[&str], node: i32) -> bool { let h = self.head_leaf_text(node); words.iter().any(|w| *w == h) }
    fn match_lit(&mut self, value: &str, ttype: &'static str) -> bool {
        match self.peek() { Some(t) if t.text == value => { self.push_leaf(ttype, t.off, t.end); self.pos += 1; true } _ => false }
    }
    fn match_tok(&mut self, name: &'static str) -> bool {
        match self.peek() { Some(t) if t.kind == name => { self.push_leaf(name, t.off, t.end); self.pos += 1; true } _ => false }
    }
    fn call_rule(&mut self, f: fn(&mut Parser<'a>) -> Option<i32>) -> bool {
        match f(self) { Some(id) => { self.scratch.push(id); true } None => false }
    }
    fn star(&mut self, once: fn(&mut Parser<'a>) -> bool) -> bool {
        loop { let sp = self.pos; let sb = self.scratch.len(); let nb = self.nodes.len(); let kb = self.kids.len(); if !once(self) { self.pos = sp; self.scratch.truncate(sb); self.nodes.truncate(nb); self.kids.truncate(kb); break; } }
        true
    }
    fn opt(&mut self, body: fn(&mut Parser<'a>) -> bool) -> bool {
        let sp = self.pos; let sb = self.scratch.len(); let nb = self.nodes.len(); let kb = self.kids.len(); if !body(self) { self.pos = sp; self.scratch.truncate(sb); self.nodes.truncate(nb); self.kids.truncate(kb); } true
    }
    fn sep_by(&mut self, elem: fn(&mut Parser<'a>) -> bool, delim: &str) -> bool {
        if !elem(self) { return true; }   // the whole separated list is optional — zero elements is valid
        loop {
            let sp = self.pos; let sb = self.scratch.len(); let nb = self.nodes.len(); let kb = self.kids.len();
            if !self.match_lit(delim, "$punct") { self.pos = sp; self.scratch.truncate(sb); self.nodes.truncate(nb); self.kids.truncate(kb); break; }
            if !elem(self) { break; }   // a trailing delimiter is allowed — keep the pushed delim and stop
        }
        true
    }
    fn alt_lit(&mut self, opts: &[(&str, &'static str)]) -> bool {
        for (v, tt) in opts { if self.match_lit(v, tt) { return true; } }
        false
    }

${matchTemplate}${ruleFns}
}

fn write_json(p: &Parser, id: i32, out: &mut String) {
    let nd = &p.nodes[id as usize];
    if nd.is_leaf {
        out.push_str(&format!("{{\\"tokenType\\":\\"{}\\",\\"offset\\":{},\\"end\\":{}}}", nd.token_type, nd.offset, nd.end));
        return;
    }
    out.push_str(&format!("{{\\"rule\\":\\"{}\\",\\"children\\":[", nd.rule));
    for i in 0..nd.kid_count { if i > 0 { out.push(','); } write_json(p, p.kids[nd.kid_start as usize + i as usize], out); }
    out.push_str(&format!("],\\"offset\\":{},\\"end\\":{}}}", nd.offset, nd.end));
}

// Library entry, two composable phases. tokenize() lexes ONCE and returns a Tokens struct that
// carries the source slice (head-leaf lookups need it — Rust keeps no globals). Pass it to
// parse(). The arena (nodes/kids) lives in the returned Parser so the caller can serialize
// (write_json) or inspect it. Just the CST? parse(tokenize(src)).
struct Tokens<'a> { src: &'a str, toks: Vec<Tok<'a>> }
fn tokenize<'a>(src: &'a str) -> Tokens<'a> { Tokens { src, toks: lex(src) } }
fn parse<'a>(tokens: Tokens<'a>) -> Option<(Parser<'a>, i32)> {
    let n = tokens.toks.len();
    let mut p = Parser { toks: tokens.toks, pos: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: tokens.src, nodes: Vec::new(), kids: Vec::new(), scratch: Vec::new() };
    match p.parse_${ir.entry}() {
        Some(root) if p.pos == n => Some((p, root)),
        _ => None,
    }
}

pub struct Edit { pub start: usize, pub end: usize, pub text: String }
pub struct Doc { text: String }
impl Doc {
    pub fn new(text: String) -> Doc { Doc { text } }
    pub fn text(&self) -> &str { &self.text }
    pub fn edit(&mut self, edits: &[Edit]) {
        for e in edits { let s = e.start; let en = e.end; self.text = format!("{}{}{}", &self.text[..s], e.text, &self.text[en..]); }
    }
    pub fn parse(&self) -> Option<(Parser<'_>, i32)> { parse(tokenize(&self.text)) }
}
`;
  },
  emitRunner(): string {
    return `
// CLI runner (harness only): stdin -> CST JSON + a self-bench mode. Appended to the parser
// library by the gate (same file/crate, so it calls \`parse\`/\`write_json\` directly); NOT part
// of the parser.
fn skip_ws(s: &[u8], mut i: usize) -> usize { while i < s.len() && (s[i] as char).is_whitespace() { i += 1; } i }
fn parse_str(s: &[u8], mut i: usize) -> Option<(String, usize)> {
    if s.get(i)? != &b'"' { return None; }
    i += 1;
    let mut out = String::new();
    while i < s.len() {
        match s[i] {
            b'"' => return Some((out, i + 1)),
            b'\\\\' => { i += 1; if i >= s.len() { return None; }
                out.push(match s[i] { b'n' => '\\n', b'r' => '\\r', b't' => '\\t', b'"' => '"', b'\\\\' => '\\\\', b'/' => '/', c => c as char });
                i += 1; }
            c => { out.push(c as char); i += 1; }
        }
    }
    None
}
fn parse_num(s: &[u8], mut i: usize) -> Option<(usize, usize)> {
    let start = i;
    while i < s.len() && s[i].is_ascii_digit() { i += 1; }
    if i == start { return None; }
    s[start..i].iter().fold(Some(0usize), |a, &d| a.and_then(|n| n.checked_mul(10).and_then(|m| m.checked_add((d - b'0') as usize))))
        .map(|n| (n, i))
}
fn parse_triple(s: &[u8], mut i: usize) -> Option<((usize, usize, String), usize)> {
    if s.get(i)? != &b'[' { return None; }
    i = skip_ws(s, i + 1);
    let (a, mut i) = parse_num(s, i)?;
    i = skip_ws(s, i); if s.get(i)? != &b',' { return None; }
    i = skip_ws(s, i + 1);
    let (b, mut i) = parse_num(s, i)?;
    i = skip_ws(s, i); if s.get(i)? != &b',' { return None; }
    i = skip_ws(s, i + 1);
    let (t, mut i) = parse_str(s, i)?;
    i = skip_ws(s, i); if s.get(i)? != &b']' { return None; }
    Some(((a, b, t), i + 1))
}
fn parse_batch(s: &[u8], mut i: usize) -> Option<(Vec<(usize, usize, String)>, usize)> {
    if s.get(i)? != &b'[' { return None; }
    i = skip_ws(s, i + 1);
    let mut batch = Vec::new();
    if s.get(i)? == &b']' { return Some((batch, i + 1)); }
    loop {
        let (t, ni) = parse_triple(s, i)?;
        batch.push(t);
        i = skip_ws(s, ni);
        if s.get(i)? == &b']' { return Some((batch, i + 1)); }
        if s.get(i)? != &b',' { return None; }
        i = skip_ws(s, i + 1);
    }
}
fn parse_edit_session(s: &str) -> Option<(String, Vec<Vec<(usize, usize, String)>>)> {
    let b = s.as_bytes();
    let mut i = skip_ws(b, 0);
    if b.get(i)? != &b'{' { return None; }
    i = skip_ws(b, i + 1);
    let mut init = None;
    let mut batches = None;
    loop {
        let (key, ni) = parse_str(b, i)?;
        i = skip_ws(b, ni);
        if b.get(i)? != &b':' { return None; }
        i = skip_ws(b, i + 1);
        if key == "init" {
            let (v, ni) = parse_str(b, i)?;
            init = Some(v);
            i = skip_ws(b, ni);
        } else if key == "batches" {
            if b.get(i)? != &b'[' { return None; }
            i = skip_ws(b, i + 1);
            let mut bs = Vec::new();
            if b.get(i)? == &b']' { batches = Some(bs); i += 1; }
            else {
                loop {
                    let (batch, ni) = parse_batch(b, i)?;
                    bs.push(batch);
                    i = skip_ws(b, ni);
                    if b.get(i)? == &b']' { batches = Some(bs); i += 1; break; }
                    if b.get(i)? != &b',' { return None; }
                    i = skip_ws(b, i + 1);
                }
            }
        } else { return None; }
        if b.get(i)? == &b'}' { break; }
        if b.get(i)? != &b',' { return None; }
        i = skip_ws(b, i + 1);
    }
    Some((init?, batches?))
}

fn main() {
    use std::io::Read;
    let mut src = String::new();
    std::io::stdin().read_to_string(&mut src).unwrap();
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "edit-session" {
        let (init, batches) = parse_edit_session(&src).unwrap();
        let mut doc = Doc::new(init);
        for batch in &batches {
            let edits: Vec<Edit> = batch.iter().map(|&(s, e, ref t)| Edit { start: s, end: e, text: t.clone() }).collect();
            doc.edit(&edits);
        }
        match doc.parse() {
            Some((p, root)) => { let mut out = String::new(); write_json(&p, root, &mut out); print!("{}", out); }
            None => { eprintln!("parse error"); std::process::exit(1); }
        }
        return;
    }
    // Self-bench: a numeric arg N times the lex+parse loop and prints ms/iteration.
    if let Some(iters) = args.get(1).and_then(|a| a.parse::<u64>().ok()) {
        for _ in 0..3 { let s = std::hint::black_box(&src); if let Some((p, r)) = parse(tokenize(s)) { std::hint::black_box((&p.nodes[r as usize], p.pos)); } }
        let t = std::time::Instant::now();
        for _ in 0..iters { let s = std::hint::black_box(&src); if let Some((p, r)) = parse(tokenize(s)) { std::hint::black_box((&p.nodes[r as usize], p.pos)); } }
        println!("{:.4}", t.elapsed().as_secs_f64() * 1000.0 / iters as f64);
        return;
    }
    match parse(tokenize(&src)) {
        Some((p, root)) => { let mut out = String::new(); write_json(&p, root, &mut out); print!("{}", out); }
        None => { eprintln!("parse error"); std::process::exit(1); }
    }
}
`;
  },
};
