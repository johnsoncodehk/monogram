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

function newlinePartsRs(nl: NewlineCfg): { consts: string; fields: string; init: string; boundary: string; ws: string; hooks: string; boundaryFrom: string; wsFrom: string; hooksFrom: string } {
  const commentSkip = nl.comment
    ? `            if src[p..].starts_with(${J(nl.comment)}) { let mut e = p; while e < n && b[e] != 10 { e += 1; } pos = e; continue; }\n`
    : '';
  const commentSkipFrom = nl.comment
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
    boundaryFrom: `        if st.flow_depth == 0 && st.line_start {
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
${commentSkipFrom}            pos = p;
            if st.emitted_content { st.push_tok(_NLTOK, &src[pos..pos], pos, pos); }
            st.line_start = false;
            continue;
        }
`,
    ws: `        if c == 32 || c == 9 || c == 11 || c == 12 || c == 160 || c == 5760 || (c >= 8192 && c <= 8202) || c == 8239 || c == 8287 || c == 12288 || c == 65279 { pos += 1; continue; }
        if c == 10 || c == 13 {
            pos += 1; if c == 13 && pos < n && b[pos] == 10 { pos += 1; }
            if st.flow_depth == 0 { st.line_start = true; }
            continue;
        }
`,
    wsFrom: `        if c == 32 || c == 9 || c == 11 || c == 12 || c == 160 || c == 5760 || (c >= 8192 && c <= 8202) || c == 8239 || c == 8287 || c == 12288 || c == 65279 { pos += 1; continue; }
        if c == 10 || c == 13 {
            pos += 1; if c == 13 && pos < n && b[pos] == 10 { pos += 1; }
            if st.flow_depth == 0 { st.line_start = true; }
            continue;
        }
`,
    hooks: `        if kind != _NLTOK { self.emitted_content = true; }
        if kind == "" && _in(_FLOW_OPEN, text) { self.flow_depth += 1; }
        else if kind == "" && _in(_FLOW_CLOSE, text) { self.flow_depth = (self.flow_depth - 1).max(0); }
`,
    hooksFrom: `        if kind != _NLTOK { emitted_content = true; }
        if kind == "" && _in(_FLOW_OPEN, text) { flow_depth += 1; }
        else if kind == "" && _in(_FLOW_CLOSE, text) { flow_depth = (flow_depth - 1).max(0); }
`,
  };
}

function lexer(ir: ParserIR): string {
  const defs: string[] = [];
  const rx = ir.regexCtx;
  const tpl = ir.tpl;
  const nl = ir.newlineCfg;
  const nlRs = nl ? newlinePartsRs(nl) : null;
  const rxOnly = !!(rx && !tpl && !nl);
  const rxOrTpl = !!(rx || tpl) && !rxOnly;
  const stateful = !!(rx || tpl);
  const newlineOnly = !!(nl && !rx && !tpl);
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
  const rxScanImpl = rxOnly ? `struct RxScan<'a, 'b> { acc: &'a mut Vec<Tok<'b>>, pending_nl: bool, prev_text: &'b str, prev_kind: &'static str, bp_text: &'b str, has_prev: bool, has_prev2: bool, paren_head: Vec<bool>, last_close: bool, last_bang: bool }
impl<'a, 'b> RxScan<'a, 'b> {
    fn prev_is_value(&self) -> bool {
        if !self.has_prev { return false; }
        if _in(_PAV, self.prev_text) { return self.last_bang; }
        let is_expr_kw = self.prev_kind == _IDENT && _in(_RXT, self.prev_text);
        let is_paren_head = self.prev_text == ")" && self.last_close;
        !is_expr_kw && !is_paren_head && (_in(_DIVK, self.prev_kind) || _in(_DIVT, self.prev_text))
    }
    fn emit(&mut self, kind: &'static str, text: &'b str, off: usize, end: usize) {
        if text == "(" { let is_member = self.has_prev2 && _in(_MEM, self.bp_text); self.paren_head.push(!is_member && self.prev_kind == _IDENT && _in(_PHK, self.prev_text)); }
        else if text == ")" { self.last_close = self.paren_head.pop().unwrap_or(false); }
        if _in(_PAV, text) { self.last_bang = self.prev_is_value(); }
        self.acc.push(Tok { kind, text, off, end, nl: self.pending_nl }); self.pending_nl = false;
        self.bp_text = self.prev_text; self.has_prev2 = self.has_prev; self.prev_kind = kind; self.prev_text = text; self.has_prev = true;
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
  const loopBody = `${nlBoundary}        let c = b[pos] as u32;
${nlWs}${tplDispatch}${toks}
${puncts}
        panic!("lex error at {}", pos);`;
  if (rxOnly) {
    const rxLoopBody = `${nlBoundary}        let c = b[pos] as u32;
${nlWs}${toks}
${puncts}
        panic!("lex error at {}", pos);`;
    return `${defs.length ? defs.join('\n') + '\n' : ''}${rxConsts}${tplFn}${rxScanImpl}fn lex_from<'a>(src: &'a str, mut pos: usize, mut pending_nl: bool, mut prev_text: &'a str, mut prev_kind: &'static str, mut bp_text: &'a str, mut has_prev: bool, mut has_prev2: bool, mut paren_head: Vec<bool>, mut last_close: bool, mut last_bang: bool, acc: &mut Vec<Tok<'a>>, limit: usize) -> (usize, bool, &'a str, &'static str, &'a str, bool, bool, Vec<bool>, bool, bool) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    let mut st = RxScan { acc, pending_nl, prev_text, prev_kind, bp_text, has_prev, has_prev2, paren_head, last_close, last_bang };
    while pos < n && (limit == 0 || st.acc.len() - base < limit) {
${rxLoopBody}
    }
    (pos, st.pending_nl, st.prev_text, st.prev_kind, st.bp_text, st.has_prev, st.has_prev2, st.paren_head, st.last_close, st.last_bang)
}
fn lex<'a>(src: &'a str) -> Vec<Tok<'a>> {
    let mut toks = Vec::new();
    lex_from(src, 0, false, "", "", "", false, false, Vec::new(), false, false, &mut toks, 0);
    toks
}`;
  }
  if (rxOrTpl) {
    return `${defs.length ? defs.join('\n') + '\n' : ''}${rxConsts}${tplFn}${stateImpl}fn lex<'a>(src: &'a str) -> Vec<Tok<'a>> {
    let b = src.as_bytes();
    let n = b.len();
${open}
    let mut pos = 0usize;
    while pos < n {
${loopBody}
    }
    st.toks
}`;
  }
  if (newlineOnly) {
    const rustNlScan = (s: string) => s
      .replace(/toks\.push\(Tok \{ kind: ([^,]+), text: ([^,]+), off: pos, end: ([^,]+), nl: pending_nl \}\); pending_nl = false; ?/g, 'st.push_tok($1, $2, pos, $3); ')
      .replace(/pending_nl/g, 'st.pending_nl');
    const nlLoopBody = `${nlRs!.boundaryFrom}        let c = b[pos] as u32;
${nlRs!.wsFrom}${rustNlScan(toks)}
${rustNlScan(puncts)}
        panic!("lex error at {}", pos);`;
    return `${defs.length ? defs.join('\n') + '\n' : ''}${rxConsts}${tplFn}struct NlScan<'a, 'b> { acc: &'a mut Vec<Tok<'b>>, pending_nl: bool, line_start: bool, emitted_content: bool, flow_depth: i64 }
impl<'a, 'b> NlScan<'a, 'b> {
    fn push_tok(&mut self, kind: &'static str, text: &'b str, off: usize, end: usize) {
${nlRs!.hooksFrom.replace(/emitted_content/g, 'self.emitted_content').replace(/flow_depth/g, 'self.flow_depth').replace(/pending_nl/g, 'self.pending_nl')}
        self.acc.push(Tok { kind, text, off, end, nl: self.pending_nl }); self.pending_nl = false;
    }
}
fn lex_from<'a>(src: &'a str, mut pos: usize, mut pending_nl: bool, mut line_start: bool, mut emitted_content: bool, mut flow_depth: i64, acc: &mut Vec<Tok<'a>>, limit: usize) -> (usize, bool, bool, bool, i64) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    let mut st = NlScan { acc, pending_nl, line_start, emitted_content, flow_depth };
    while pos < n && (limit == 0 || st.acc.len() - base < limit) {
${nlLoopBody}
    }
    (pos, st.pending_nl, st.line_start, st.emitted_content, st.flow_depth)
}
fn lex<'a>(src: &'a str) -> Vec<Tok<'a>> {
    let mut toks = Vec::new();
    lex_from(src, 0, false, true, false, 0, &mut toks, 0);
    toks
}`;
  }
  return `${defs.length ? defs.join('\n') + '\n' : ''}${rxConsts}${tplFn}fn lex_from<'a>(src: &'a str, mut pos: usize, mut pending_nl: bool, acc: &mut Vec<Tok<'a>>, limit: usize) -> (usize, bool) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    while pos < n && (limit == 0 || acc.len() - base < limit) {
${loopBody.replace(/pending_nl/g, 'pending_nl').replace(/toks\.push/g, 'acc.push')}
    }
    (pos, pending_nl)
}
fn lex<'a>(src: &'a str) -> Vec<Tok<'a>> {
    let mut toks = Vec::new();
    lex_from(src, 0, false, &mut toks, 0);
    toks
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

function docEditBlockRust(ir: ParserIR): string {
  const windowLex = !ir.tpl && (!ir.regexCtx || !ir.newlineCfg);
  const hasNewline = !!(ir.newlineCfg && !ir.regexCtx && !ir.tpl);
  const rxOnly = !!(ir.regexCtx && !ir.tpl && !ir.newlineCfg);
  const windowHelpers = windowLex ? (hasNewline ? `
fn find_tok_at_off_kind(toks: &[AlignMeta], off: usize, kind: &'static str) -> Option<usize> {
    let mut lo = 0usize;
    let mut hi = toks.len();
    let mut hit = None;
    while lo < hi {
        let mid = (lo + hi) / 2;
        if toks[mid].off < off { lo = mid + 1; } else { hi = mid; }
    }
    if lo < toks.len() && toks[lo].off == off { hit = Some(lo); }
    let hit = hit?;
    let mut start = hit;
    while start > 0 && toks[start - 1].off == off { start -= 1; }
    let mut i = start;
    while i < toks.len() && toks[i].off == off {
        if toks[i].kind == kind { return Some(i); }
        i += 1;
    }
    None
}
fn window_relex_step(old_text: &str, old_toks: &[AlignMeta], new_text: &str, start: usize, end: usize, ins: &str) -> (Vec<AlignMeta>, usize) {
    let delta = ins.len() as isize - (end - start) as isize;
    let edit_end = start + ins.len();
    let mut max_idx = None::<usize>;
    for (i, t) in old_toks.iter().enumerate() {
        if t.end < start { max_idx = Some(i); } else { break; }
    }
    let rb = max_idx.map(|i| i as isize - 1).unwrap_or(-1);
    let mut out: Vec<AlignMeta> = if rb >= 0 { old_toks[..=rb as usize].to_vec() } else { Vec::new() };
    let (mut scan_off, mut pending_nl, mut line_start, mut emitted_content, mut flow_depth) = if rb >= 0 {
        (old_toks[rb as usize].end, false, false, true, old_toks[rb as usize].fd)
    } else {
        (0, false, true, false, 0)
    };
    let mut scratch: Vec<Tok<'_>> = Vec::new();
    let mut relexed = 0usize;
    while scan_off < new_text.len() {
        let before = scratch.len();
        (scan_off, pending_nl, line_start, emitted_content, flow_depth) = lex_from(new_text, scan_off, pending_nl, line_start, emitted_content, flow_depth, &mut scratch, 1);
        if scratch.len() == before { break; }
        let t = &scratch[scratch.len() - 1];
        out.push(AlignMeta { kind: t.kind, off: t.off, end: t.end, nl: t.nl, fd: flow_depth, pd: 0, lc: false, lb: false, hd: false });
        relexed += 1;
        if t.off >= edit_end {
            if let Some(o_idx) = find_tok_at_off_kind(old_toks, (t.off as isize - delta) as usize, t.kind) {
                let o = &old_toks[o_idx];
                if o.kind == t.kind && o.end == (t.end as isize - delta) as usize && o.nl == t.nl && o.fd == flow_depth && old_text[o.off..o.end] == new_text[t.off..t.end] {
                    for ot in &old_toks[o_idx + 1..] {
                        out.push(AlignMeta { kind: ot.kind, off: (ot.off as isize + delta) as usize, end: (ot.end as isize + delta) as usize, nl: ot.nl, fd: ot.fd, pd: ot.pd, lc: ot.lc, lb: ot.lb, hd: ot.hd });
                    }
                    return (out, relexed);
                }
            }
        }
    }
    (out, relexed)
}
` : rxOnly ? `
fn find_tok_at_off(toks: &[AlignMeta], off: usize) -> Option<usize> {
    let mut lo = 0usize;
    let mut hi = toks.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if toks[mid].off < off { lo = mid + 1; } else { hi = mid; }
    }
    if lo < toks.len() && toks[lo].off == off { Some(lo) } else { None }
}
fn reconstruct_parens(toks: &[AlignMeta], text: &str, b: isize) -> Vec<bool> {
    let mut need = if b >= 0 { toks[b as usize].pd } else { 0 };
    let mut out: Vec<bool> = Vec::new();
    let mut i = b;
    while i >= 0 && need > 0 {
        let t = &toks[i as usize];
        if &text[t.off..t.end] == "(" && t.pd == need {
            out.insert(0, t.hd);
            need -= 1;
        }
        i -= 1;
    }
    out
}
fn paren_stacks_eq(a: &[bool], b: &[bool]) -> bool {
    a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x == y)
}
fn window_relex_step(old_text: &str, old_toks: &[AlignMeta], new_text: &str, start: usize, end: usize, ins: &str) -> (Vec<AlignMeta>, usize) {
    let delta = ins.len() as isize - (end - start) as isize;
    let edit_end = start + ins.len();
    let mut max_idx = None::<usize>;
    for (i, t) in old_toks.iter().enumerate() {
        if t.end < start { max_idx = Some(i); } else { break; }
    }
    let rb = max_idx.map(|i| i as isize - 1).unwrap_or(-1);
    let mut out: Vec<AlignMeta> = if rb >= 0 { old_toks[..=rb as usize].to_vec() } else { Vec::new() };
    let mut scan_off: usize;
    let mut pending_nl = false;
    let mut prev_text: &str = "";
    let mut prev_kind: &'static str = "";
    let mut bp_text: &str = "";
    let mut has_prev = false;
    let mut has_prev2 = false;
    let mut paren_head: Vec<bool> = Vec::new();
    let mut last_close = false;
    let mut last_bang = false;
    if rb >= 0 {
        let anchor = &old_toks[rb as usize];
        scan_off = anchor.end;
        prev_text = &old_text[anchor.off..anchor.end];
        prev_kind = anchor.kind;
        has_prev = true;
        if rb >= 1 {
            let p = &old_toks[rb as usize - 1];
            bp_text = &old_text[p.off..p.end];
            has_prev2 = true;
        }
        last_close = anchor.lc;
        last_bang = anchor.lb;
        paren_head = reconstruct_parens(old_toks, old_text, rb);
    } else {
        scan_off = 0;
    }
    let mut scratch: Vec<Tok<'_>> = Vec::new();
    let mut relexed = 0usize;
    while scan_off < new_text.len() {
        let before = scratch.len();
        (scan_off, pending_nl, prev_text, prev_kind, bp_text, has_prev, has_prev2, paren_head, last_close, last_bang) = lex_from(new_text, scan_off, pending_nl, prev_text, prev_kind, bp_text, has_prev, has_prev2, paren_head, last_close, last_bang, &mut scratch, 1);
        if scratch.len() == before { break; }
        let t = &scratch[scratch.len() - 1];
        let txt = &new_text[t.off..t.end];
        let hd = if txt == "(" && !paren_head.is_empty() { paren_head[paren_head.len() - 1] } else { false };
        out.push(AlignMeta { kind: t.kind, off: t.off, end: t.end, nl: t.nl, fd: 0, pd: paren_head.len() as i64, lc: last_close, lb: last_bang, hd });
        relexed += 1;
        if t.off >= edit_end {
            if let Some(o_idx) = find_tok_at_off(old_toks, (t.off as isize - delta) as usize) {
                let o = &old_toks[o_idx];
                let new_prev_text = if out.len() > 1 { let p = &out[out.len() - 2]; &new_text[p.off..p.end] } else { "" };
                let old_prev_text = if o_idx >= 1 { let p = &old_toks[o_idx - 1]; &old_text[p.off..p.end] } else { "" };
                let bp_ok = new_prev_text == old_prev_text;
                let old_stack = reconstruct_parens(old_toks, old_text, o_idx as isize);
                if o.pd == paren_head.len() as i64 && paren_stacks_eq(&old_stack, &paren_head) && o.lc == last_close && o.lb == last_bang && bp_ok && o.kind == t.kind && o.end == (t.end as isize - delta) as usize && o.nl == t.nl && old_text[o.off..o.end] == new_text[t.off..t.end] {
                    for ot in &old_toks[o_idx + 1..] {
                        out.push(AlignMeta { kind: ot.kind, off: (ot.off as isize + delta) as usize, end: (ot.end as isize + delta) as usize, nl: ot.nl, fd: ot.fd, pd: ot.pd, lc: ot.lc, lb: ot.lb, hd: ot.hd });
                    }
                    return (out, relexed);
                }
            }
        }
    }
    (out, relexed)
}
` : `
fn find_tok_at_off(toks: &[AlignMeta], off: usize) -> Option<usize> {
    let mut lo = 0usize;
    let mut hi = toks.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if toks[mid].off < off { lo = mid + 1; } else { hi = mid; }
    }
    if lo < toks.len() && toks[lo].off == off { Some(lo) } else { None }
}
fn window_relex_step(old_text: &str, old_toks: &[AlignMeta], new_text: &str, start: usize, end: usize, ins: &str) -> (Vec<AlignMeta>, usize) {
    let delta = ins.len() as isize - (end - start) as isize;
    let edit_end = start + ins.len();
    let mut max_idx = None::<usize>;
    for (i, t) in old_toks.iter().enumerate() {
        if t.end < start { max_idx = Some(i); } else { break; }
    }
    let rb = max_idx.map(|i| i as isize - 1).unwrap_or(-1);
    let mut out: Vec<AlignMeta> = if rb >= 0 { old_toks[..=rb as usize].to_vec() } else { Vec::new() };
    let mut scan_off = if rb >= 0 { old_toks[rb as usize].end } else { 0 };
    let mut pending_nl = false;
    let mut scratch: Vec<Tok<'_>> = Vec::new();
    let mut relexed = 0usize;
    while scan_off < new_text.len() {
        let before = scratch.len();
        (scan_off, pending_nl) = lex_from(new_text, scan_off, pending_nl, &mut scratch, 1);
        if scratch.len() == before { break; }
        let t = &scratch[scratch.len() - 1];
        out.push(AlignMeta { kind: t.kind, off: t.off, end: t.end, nl: t.nl, fd: 0, pd: 0, lc: false, lb: false, hd: false });
        relexed += 1;
        if t.off >= edit_end {
            if let Some(o_idx) = find_tok_at_off(old_toks, (t.off as isize - delta) as usize) {
                let o = &old_toks[o_idx];
                if o.kind == t.kind && o.end == (t.end as isize - delta) as usize && o.nl == t.nl && old_text[o.off..o.end] == new_text[t.off..t.end] {
                    for ot in &old_toks[o_idx + 1..] {
                        out.push(AlignMeta { kind: ot.kind, off: (ot.off as isize + delta) as usize, end: (ot.end as isize + delta) as usize, nl: ot.nl, fd: ot.fd, pd: ot.pd, lc: ot.lc, lb: ot.lb, hd: ot.hd });
                    }
                    return (out, relexed);
                }
            }
        }
    }
    (out, relexed)
}
`) : '';
  const editBody = windowLex
    ? `        let mut cur_text = self.text.clone();
        let mut cur_toks = self.toks.clone();
        for e in edits {
            let step_old_text = cur_text.clone();
            let step_old_toks = cur_toks.clone();
            let n = cur_text.len();
            let start = e.start.min(n);
            let end = e.end.max(start).min(n);
            let ins = e.text.clone();
            cur_text = format!("{}{}{}", &cur_text[..start], ins, &cur_text[end..]);
            let (toks, step_relexed) = window_relex_step(&step_old_text, &step_old_toks, &cur_text, start, end, &ins);
            cur_toks = toks;
            relexed += step_relexed;
        }
        self.text = cur_text;
        self.toks = cur_toks;`
    : `        for e in edits {
            let n = self.text.len();
            let start = e.start.min(n);
            let end = e.end.max(start).min(n);
            self.text = format!("{}{}{}", &self.text[..start], e.text, &self.text[end..]);
        }
        self.toks = to_meta(&lex(&self.text));
        relexed = self.toks.len();`;
  const toMetaFn = hasNewline ? `
fn scan_meta(src: &str) -> Vec<AlignMeta> {
    let mut toks: Vec<Tok<'_>> = Vec::new();
    let mut meta: Vec<AlignMeta> = Vec::new();
    let (mut pos, mut pending_nl, mut line_start, mut emitted_content, mut flow_depth) = (0usize, false, true, false, 0i64);
    while pos < src.len() {
        let before = toks.len();
        (pos, pending_nl, line_start, emitted_content, flow_depth) = lex_from(src, pos, pending_nl, line_start, emitted_content, flow_depth, &mut toks, 1);
        if toks.len() == before { break; }
        let t = &toks[toks.len() - 1];
        meta.push(AlignMeta { kind: t.kind, off: t.off, end: t.end, nl: t.nl, fd: flow_depth, pd: 0, lc: false, lb: false, hd: false });
    }
    meta
}
fn to_meta(_toks: &[Tok<'_>]) -> Vec<AlignMeta> { panic!("use scan_meta for newline") }
` : rxOnly ? `
fn scan_meta(src: &str) -> Vec<AlignMeta> {
    let mut toks: Vec<Tok<'_>> = Vec::new();
    let mut meta: Vec<AlignMeta> = Vec::new();
    let (mut pos, mut pending_nl) = (0usize, false);
    let (mut prev_text, mut prev_kind, mut bp_text) = ("", "", "");
    let (mut has_prev, mut has_prev2) = (false, false);
    let mut paren_head: Vec<bool> = Vec::new();
    let (mut last_close, mut last_bang) = (false, false);
    while pos < src.len() {
        let before = toks.len();
        (pos, pending_nl, prev_text, prev_kind, bp_text, has_prev, has_prev2, paren_head, last_close, last_bang) = lex_from(src, pos, pending_nl, prev_text, prev_kind, bp_text, has_prev, has_prev2, paren_head, last_close, last_bang, &mut toks, 1);
        if toks.len() == before { break; }
        let t = &toks[toks.len() - 1];
        let txt = &src[t.off..t.end];
        let hd = if txt == "(" && !paren_head.is_empty() { paren_head[paren_head.len() - 1] } else { false };
        meta.push(AlignMeta { kind: t.kind, off: t.off, end: t.end, nl: t.nl, fd: 0, pd: paren_head.len() as i64, lc: last_close, lb: last_bang, hd });
    }
    meta
}
fn to_meta(_toks: &[Tok<'_>]) -> Vec<AlignMeta> { panic!("use scan_meta for regex") }
` : `fn to_meta(toks: &[Tok<'_>]) -> Vec<AlignMeta> {
    toks.iter().map(|t| AlignMeta { kind: t.kind, off: t.off, end: t.end, nl: t.nl, fd: 0, pd: 0, lc: false, lb: false, hd: false }).collect()
}`;
  const checkStreamEqFn = hasNewline ? `
fn check_stream_eq(text: &str, meta: &[AlignMeta]) -> bool {
    let fresh = scan_meta(text);
    if fresh.len() != meta.len() { return false; }
    for (f, m) in fresh.iter().zip(meta.iter()) {
        if f.kind != m.kind || f.off != m.off || f.end != m.end || f.nl != m.nl || f.fd != m.fd { return false; }
        if text[f.off..f.end] != text[m.off..m.end] { return false; }
    }
    true
}
` : rxOnly ? `
fn check_stream_eq(text: &str, meta: &[AlignMeta]) -> bool {
    let fresh = scan_meta(text);
    if fresh.len() != meta.len() { return false; }
    for (f, m) in fresh.iter().zip(meta.iter()) {
        if f.kind != m.kind || f.off != m.off || f.end != m.end || f.nl != m.nl || f.pd != m.pd || f.lc != m.lc || f.lb != m.lb || f.hd != m.hd { return false; }
        if text[f.off..f.end] != text[m.off..m.end] { return false; }
    }
    true
}
` : `
fn check_stream_eq(text: &str, meta: &[AlignMeta]) -> bool {
    let fresh = to_meta(&lex(text));
    if fresh.len() != meta.len() { return false; }
    for (f, m) in fresh.iter().zip(meta.iter()) {
        if f.kind != m.kind || f.off != m.off || f.end != m.end || f.nl != m.nl { return false; }
        if text[f.off..f.end] != text[m.off..m.end] { return false; }
    }
    true
}
`;
  const initToks = (hasNewline || rxOnly) ? 'scan_meta(&text)' : 'to_meta(&lex(&text))';
  return `pub struct Edit { pub start: usize, pub end: usize, pub text: String }
#[derive(Clone)]
struct AlignMeta { kind: &'static str, off: usize, end: usize, nl: bool, fd: i64, pd: i64, lc: bool, lb: bool, hd: bool }
struct Align { old_n: usize, new_n: usize, prefix: usize, suffix: usize, relexed: usize, stream_eq: bool }
${toMetaFn}
fn compute_align_core(old_text: &str, old_toks: &[AlignMeta], new_text: &str, new_toks: &[AlignMeta]) -> (usize, usize, usize, usize) {
    let old_n = old_toks.len();
    let new_n = new_toks.len();
    let mut prefix = 0usize;
    while prefix < old_n && prefix < new_n {
        let o = &old_toks[prefix];
        let n = &new_toks[prefix];
        if o.kind != n.kind || o.off != n.off || o.end != n.end || o.nl != n.nl { break; }
        if old_text[o.off..o.end] != new_text[n.off..n.end] { break; }
        prefix += 1;
    }
    let delta = new_text.len() as isize - old_text.len() as isize;
    let min_n = old_n.min(new_n);
    let mut suffix = 0usize;
    while prefix + suffix < min_n {
        let o = &old_toks[old_n - 1 - suffix];
        let n = &new_toks[new_n - 1 - suffix];
        if o.kind != n.kind || o.nl != n.nl { break; }
        if n.off != (o.off as isize + delta) as usize || n.end != (o.end as isize + delta) as usize { break; }
        if old_text[o.off..o.end] != new_text[n.off..n.end] { break; }
        suffix += 1;
    }
    (old_n, new_n, prefix, suffix)
}
fn toks_from_meta<'a>(text: &'a str, meta: &[AlignMeta]) -> Vec<Tok<'a>> {
    meta.iter().map(|m| Tok { kind: m.kind, text: &text[m.off..m.end], off: m.off, end: m.end, nl: m.nl }).collect()
}
${checkStreamEqFn}${windowHelpers}pub struct Doc { text: String, toks: Vec<AlignMeta>, align: Option<Align> }
impl Doc {
    pub fn new(text: String) -> Doc { Doc { text: text.clone(), toks: ${initToks}, align: None } }
    pub fn text(&self) -> &str { &self.text }
    pub fn alignment(&self) -> Option<&Align> { self.align.as_ref() }
    pub fn edit(&mut self, edits: &[Edit]) {
        let old_text = self.text.clone();
        let old_toks = self.toks.clone();
        let mut relexed = 0usize;
${editBody}
        let stream_eq = check_stream_eq(&self.text, &self.toks);
        let (old_n, new_n, prefix, suffix) = compute_align_core(&old_text, &old_toks, &self.text, &self.toks);
        self.align = Some(Align { old_n, new_n, prefix, suffix, relexed, stream_eq });
    }
    pub fn parse(&self) -> Option<(Parser<'_>, i32)> {
        let toks = toks_from_meta(&self.text, &self.toks);
        let n = toks.len();
        let mut p = Parser { toks, pos: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &self.text, nodes: Vec::new(), kids: Vec::new(), scratch: Vec::new() };
        match p.parse_${ir.entry}() {
            Some(root) if p.pos == n => Some((p, root)),
            _ => None,
        }
    }
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

${docEditBlockRust(ir)}
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
        if let Some(a) = doc.alignment() {
            eprintln!("{{\\"oldN\\":{},\\"newN\\":{},\\"prefix\\":{},\\"suffix\\":{},\\"relexed\\":{},\\"streamEq\\":{}}}", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.stream_eq);
        }
        match doc.parse() {
            Some((p, root)) => {
                let mut out = String::new(); write_json(&p, root, &mut out); print!("{}", out);
            }
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
