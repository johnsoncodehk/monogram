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
// combinators take non-capturing `fn(&mut Parser) -> bool` pointers. Arena lives in
// `Parser.b` (CstBuilder by default); rule fns return `Option<Spanned<B::H>>`.
import { type ParserIR, type RdRule, type PrattRule, type Step, type Bracket, type CharRange, type LexTok, type TplCfg, type NewlineCfg, type FirstSig, type LexFirstBytes, type LexIdPlan, type ArenaIdPlan } from './emit-portable.ts';
import { portableIR, buildLexDispatchPlan, lexTokFirstBytes, punctFirstBytes, buildLexIdPlan, buildLidPrefilter, buildArenaIdPlan, lidOf, kidOf, lidFlagTable, kidFlagTable, ttIdOf, ruleIdOf, TT_SKIP_PUNCT, rangesHaveNonAscii, isFirstGuardable, groupByPreserveOrder } from './emit-portable.ts';
import { isKeywordLiteral } from './grammar-utils.ts';
import type { Target } from './emit.ts';
import type { TokenPattern, CstGrammar } from './types.ts';

const J = (v: unknown) => JSON.stringify(v);
const rangeCond = (v: string, rs: CharRange[]) =>
  '(' + rs.map(([lo, hi]) => (lo === hi ? `${v} == ${lo}` : `(${lo}..=${hi}).contains(&${v})`)).join(' || ') + ')';

function bailCondRs(v: string, bail: number[], bailNonAscii: boolean): string {
  const parts = bail.map((c) => `${v} == ${c}`);
  if (bailNonAscii) parts.push(`${v} >= 128`);
  return parts.length ? parts.join(' || ') : 'false';
}

function emitAsciiBoolTableRs(name: string, rs: CharRange[]): string {
  const a = Array<boolean>(256).fill(false);
  for (const [lo, hi] of rs) {
    for (let c = Math.max(0, lo); c <= Math.min(127, hi); c++) a[c] = true;
  }
  return `const ${name}: [bool; 256] = [${a.map((b) => (b ? 'true' : 'false')).join(', ')}];`;
}

// Boolean expr testing whether the buffered token t starts branch i (FIRST set membership).
// null FirstSig → 'false' (never matched here; predictive alts have all-non-null FIRSTs).
const firstCond = (f: FirstSig, t: string, ids: LexIdPlan) => f
  ? `(${f.lits.map((l) => `${t}.lid == ${lidOf(ids, l)}`).join(' || ') || 'false'} || ${f.toks.map((k) => `${t}.kid == ${kidOf(ids, k)}`).join(' || ') || 'false'})`
  : 'false';
/** Non-null FirstSig small enough to pre-filter before a backtracking attempt. */
const isGuardable = (f: FirstSig, nAlts?: number): f is NonNullable<FirstSig> =>
  isFirstGuardable(f, nAlts);

/** Emit kid/lid lookup tables into generated lexer source (length-bucketed lid_of match). */
function renderIdTablesRust(ids: LexIdPlan): string {
  const kidsLit = ids.kids.map(J).join(', ');
  const lidsLit = ids.lids.map(J).join(', ');
  const kidArms = ids.kids.map((k, i) => `${J(k)} => ${i}`).join(', ');
  // Group lids[1..] by UTF-8 byte length; split keyword-shaped vs punct for separate match tables.
  const byLenKw = new Map<number, { text: string; id: number }[]>();
  const byLenPu = new Map<number, { text: string; id: number }[]>();
  for (let i = 1; i < ids.lids.length; i++) {
    const text = ids.lids[i]!;
    const blen = Buffer.byteLength(text);
    const ent = { text, id: i };
    const map = isKeywordLiteral(text) ? byLenKw : byLenPu;
    const arr = map.get(blen) ?? [];
    arr.push(ent);
    map.set(blen, arr);
  }
  const lenArmsOf = (byLen: Map<number, { text: string; id: number }[]>) =>
    [...byLen.entries()].sort((a, b) => a[0] - b[0]).map(([len, ents]) => {
      const arms = ents.map((e) => `${J(e.text)} => ${e.id}`).join(', ');
      return `        ${len} => match text { ${arms}, _ => 0 },`;
    }).join('\n');
  const kwArms = lenArmsOf(byLenKw);
  const puArms = lenArmsOf(byLenPu);
  const pf = buildLidPrefilter(ids);
  const bitsLit = [...pf.firstByLenBits].join(', ');
  return `const KIND_STR: &[&str] = &[${kidsLit}];
const _LIDS: &[&str] = &[${lidsLit}];
const _LID_MAX_LEN: usize = ${pf.maxByteLen};
const _LID_FIRST_BITS: &[u8] = &[${bitsLit}];
#[inline(always)] fn tok_kind(t: &Tok) -> &'static str { KIND_STR[t.kid as usize] }
#[inline(always)] fn tok_text<'a>(src: &'a str, t: &Tok) -> &'a str { &src[t.off as usize..t.end as usize] }
#[inline(always)] fn mk_tok(off: usize, end: usize, nl: bool, kid: u16, lid: u16) -> Tok { Tok { off: off as u32, end: end as u32, kid, lid, nl } }
fn kid_of(kind: &str) -> u16 { match kind { ${kidArms}, _ => 0 } }
/// Ident/@-keyword: O(1) length×first-byte prefilter, then keyword-only match (no punct arms).
#[inline(always)]
fn lid_of(text: &str) -> u16 {
    let n = text.len();
    if n == 0 || n > _LID_MAX_LEN { return 0; }
    let b0 = text.as_bytes()[0];
    if matches!(b0, b'A'..=b'Z' | b'a'..=b'z' | b'_' | b'$' | b'@') {
        let b0u = b0 as usize;
        if (_LID_FIRST_BITS[n * 32 + (b0u >> 3)] & (1u8 << (b0u & 7))) == 0 { return 0; }
        return lid_of_kw(text, n);
    }
    lid_of_punct(text, n)
}
#[inline(never)]
fn lid_of_kw(text: &str, n: usize) -> u16 {
    match n {
${kwArms || '        // no keyword lids'}
        _ => 0,
    }
}
#[inline(never)]
fn lid_of_punct(text: &str, n: usize) -> u16 {
    match n {
${puArms || '        // no punct lids'}
        _ => 0,
    }
}
`;
}

/** Emit TT_NAMES / RULE_NAMES from ArenaIdPlan (slim arena leaf + rule ids). */
function renderArenaIdTablesRust(ar: ArenaIdPlan): string {
  return `const TT_NAMES: &[&str] = &[${ar.ttNames.map(J).join(', ')}];
const RULE_NAMES: &[&str] = &[${ar.ruleNames.map(J).join(', ')}];
`;
}


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

function scanTok(t: LexTok, defs: string[], stateful: boolean, ids: LexIdPlan, rxTok?: string, tplTok?: string): string {
  const name = (t as { name: string }).name;
  if (tplTok !== undefined && name === tplTok) return '';   // template token scanned by the state machine
  const nlVar = stateful ? 'st.pending_nl' : 'pending_nl';
  const kid = kidOf(ids, name);
  const push = (endE: string) => (t.skip
    ? `if src[pos..${endE}].chars().any(|c| matches!(c, '\\n' | '\\r' | '\\u{2028}' | '\\u{2029}')) { ${nlVar} = true; } `
    : stateful
      ? `st.emit(pos, ${endE}, ${kid}, lid_of(&src[pos..${endE}])); `
      : `toks.push(mk_tok(pos, ${endE}, pending_nl, ${kid}, lid_of(&src[pos..${endE}]))); pending_nl = false; `);
  const gate = rxTok !== undefined && name === rxTok ? '!st.prev_is_value() && ' : '';
  if (t.kind === 'run') return `        if ${gate}${rangeCond('c', t.first)} {
            let mut e = pos + 1;
            while e < n { let cc = b[e] as u32; if !${rangeCond('cc', t.cont)} { break } e += 1; }
            ${push('e')}pos = e; continue;
        }`;
  if (t.kind === 'runBail') {
    if (rangesHaveNonAscii(t.cont)) {
      const m = compilePat(t.pattern, defs);
      return `        if ${gate}true { let e = ${m}(src, pos as i64); if e > pos as i64 { let e = e as usize; ${push('e')}pos = e; continue; } }`;
    }
    const tag = t.name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
    const fTab = `_RB_F_${tag}`, cTab = `_RB_C_${tag}`;
    defs.push(emitAsciiBoolTableRs(fTab, t.first));
    defs.push(emitAsciiBoolTableRs(cTab, t.cont));
    const m = compilePat(t.pattern, defs);
    const bailAt = (v: string) => bailCondRs(v, t.bail, t.bailNonAscii);
    // Entry fallback covers cont-bail chars AND complex-head entry chars (headBail).
    const entryBail = bailCondRs('c', [...new Set([...t.bail, ...t.headBail])].sort((a, b) => a - b), t.bailNonAscii || t.headBailNonAscii);
    return `        if ${gate}${fTab}[c as usize] {
            let mut e = pos + 1;
            while e < n && ${cTab}[b[e] as usize] { e += 1; }
            if e >= n || !(${bailAt('b[e] as u32')}) { ${push('e')}pos = e; continue; }
            { let e2 = ${m}(src, pos as i64); if e2 > pos as i64 { let e2 = e2 as usize; ${push('e2')}pos = e2; continue; } }
        } else if ${entryBail} {
            let e = ${m}(src, pos as i64); if e > pos as i64 { let e = e as usize; ${push('e')}pos = e; continue; }
        }`;
  }
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
            // Byte-step + &str slice panics mid multi-byte char; match close on bytes.
            while e < n && !b[e..].starts_with(${J(t.close)}.as_bytes()) { e += 1; }
            if e < n { e += ${t.close.length}; }
            ${push('e')}pos = e; continue;
        }`;
  const m = compilePat(t.pattern, defs);
  return `        if ${gate}true { let e = ${m}(src, pos as i64); if e > pos as i64 { let e = e as usize; ${push('e')}pos = e; continue; } }`;
}

function rustByteLit(b: number): string {
  if ((b >= 97 && b <= 122) || (b >= 65 && b <= 90) || (b >= 48 && b <= 57)) return `b'${String.fromCharCode(b)}'`;
  if ([33, 35, 36, 37, 38, 42, 43, 44, 45, 46, 47, 58, 59, 61, 63, 64, 94, 95].includes(b)) return `b'${String.fromCharCode(b)}'`;
  return String(b);
}

function rustMatchLabels(bytes: number[]): string {
  const sorted = [...bytes].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i];
    let hi = lo;
    while (i + 1 < sorted.length && sorted[i + 1] === hi + 1) hi = sorted[++i];
    if (lo === hi) {
      parts.push(rustByteLit(lo));
    } else {
      const ls = rustByteLit(lo), hs = rustByteLit(hi);
      parts.push(ls.startsWith('b') && hs.startsWith('b') ? `${ls}..=${hs}` : `${lo}..=${hi}`);
    }
  }
  return parts.join(' | ');
}

function buildLexCandidates(
  ir: ParserIR, defs: string[], stateful: boolean, ids: LexIdPlan, rxTok: string | undefined, tplTok: string | undefined,
  punctLine: (p: string) => string,
): { codes: string[]; firsts: (LexFirstBytes | null)[] } {
  const codes: string[] = [];
  const firsts: (LexFirstBytes | null)[] = [];
  for (const t of ir.tokens) {
    const code = scanTok(t, defs, stateful, ids, rxTok, tplTok);
    if (!code) continue;
    codes.push(code);
    firsts.push(lexTokFirstBytes(t));
  }
  for (const p of ir.puncts) {
    codes.push(punctLine(p));
    firsts.push(punctFirstBytes(p));
  }
  return { codes, firsts };
}

/** Shared first-byte dispatch for all lexFrom variants in this target. */
function renderLexByteDispatchRust(codes: string[], firsts: (LexFirstBytes | null)[], indent: string): string {
  const { arms, fallbackIndices } = buildLexDispatchPlan(firsts);
  const fallback = fallbackIndices.map((i) => codes[i]).join('\n');
  let matchArms = '';
  for (const arm of arms) {
    matchArms += `${indent}        ${rustMatchLabels(arm.bytes)} => {\n`;
    matchArms += arm.indices.map((i) => codes[i]).join('\n') + '\n';
    matchArms += `${indent}        }\n`;
  }
  return `${indent}        if c >= 128 {
${fallback}
${indent}        } else {
${indent}        match b[pos] {
${matchArms}${indent}        _ => {}
${indent}        }
${indent}        }`;
}

function newlinePartsRs(nl: NewlineCfg, ids: LexIdPlan): { consts: string; fields: string; init: string; boundary: string; ws: string; hooks: string; boundaryFrom: string; wsFrom: string; hooksFrom: string } {
  const commentSkip = nl.comment
    ? `            if src[p..].starts_with(${J(nl.comment)}) { let mut e = p; while e < n && b[e] != 10 { e += 1; } pos = e; continue; }\n`
    : '';
  const commentSkipFrom = nl.comment
    ? `            if src[p..].starts_with(${J(nl.comment)}) { let mut e = p; while e < n && b[e] != 10 { e += 1; } pos = e; continue; }\n`
    : '';
  return {
    consts: `const _NLTOK: &str = ${J(nl.token)};
const _KID_NLTOK: u16 = ${kidOf(ids, nl.token)};
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
            if st.emitted_content { st.emit(pos, pos, ${kidOf(ids, nl.token)}, 0); }
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
            if st.emitted_content { st.push_tok(pos, pos, ${kidOf(ids, nl.token)}, 0); }
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
    hooks: `        if kid != _KID_NLTOK { self.emitted_content = true; }
        if kid == 0 && _in(_FLOW_OPEN, _LIDS[lid as usize]) { self.flow_depth += 1; }
        else if kid == 0 && _in(_FLOW_CLOSE, _LIDS[lid as usize]) { self.flow_depth = (self.flow_depth - 1).max(0); }
`,
    hooksFrom: `        if kid != _KID_NLTOK { emitted_content = true; }
        if kid == 0 && _in(_FLOW_OPEN, _LIDS[lid as usize]) { flow_depth += 1; }
        else if kid == 0 && _in(_FLOW_CLOSE, _LIDS[lid as usize]) { flow_depth = (flow_depth - 1).max(0); }
`,
  };
}

/** Exact-size lid/kid flag tables as `static` (single .rodata copy; avoid const duplication). */
function rsBoolArr(name: string, flags: boolean[]): string {
  return `static ${name}: [bool; ${flags.length}] = [${flags.map((b) => (b ? 'true' : 'false')).join(', ')}];`;
}
/** Bounds-check-free flag load (table len == plan lids/kids len; ids always in range). */
const rsFlag = (table: string, idExpr: string) =>
  `(unsafe { *${table}.get_unchecked(${idExpr} as usize) })`;
/** Small lid-set membership as integer OR-chain (avoids every-token table load for tiny sets). */
function rsLidAny(ids: LexIdPlan, texts: readonly string[], idExpr: string): string {
  const ls = [...new Set(texts.map((t) => lidOf(ids, t)).filter((i) => i > 0))];
  if (ls.length === 0) return 'false';
  return ls.map((l) => `${idExpr} == ${l}`).join(' || ');
}

function lexer(ir: ParserIR): string {
  const ids = buildLexIdPlan(ir);
  const defs: string[] = [];
  const rx = ir.regexCtx;
  const tpl = ir.tpl;
  const nl = ir.newlineCfg;
  const nlRs = nl ? newlinePartsRs(nl, ids) : null;
  const rxOnly = !!(rx && !tpl && !nl);
  const tplOnly = !!(tpl && !rx && !nl);
  const rxTpl = !!(rx && tpl && !nl);
  const rxOrTpl = !!(rx || tpl) && !rxOnly && !tplOnly && !rxTpl;
  const stateful = !!(rx || tpl);
  const newlineOnly = !!(nl && !rx && !tpl);
  const punctLine = (p: string) =>
    `        if src[pos..].starts_with(${J(p)}) { ${stateful ? `st.emit(pos, pos + ${p.length}, 0, ${lidOf(ids, p)});` : `toks.push(mk_tok(pos, pos + ${p.length}, pending_nl, 0, ${lidOf(ids, p)})); pending_nl = false;`} pos += ${p.length}; continue; }`;
  const { codes: lexCodes, firsts: lexFirsts } = buildLexCandidates(ir, defs, stateful, ids, rx?.regexToken, tpl?.token, punctLine);
  const cascade = renderLexByteDispatchRust(lexCodes, lexFirsts, '        ');
  // Struct fields / emit hooks / init are assembled per-feature so a grammar can have regex,
  // templates, or both share one LexState. Rx bookkeeping is fully integerized (lid/kid bit tables).
  const rxBitTables = rx ? `${rsBoolArr('_DIVT', lidFlagTable(ids, rx.divisionTexts))}
${rsBoolArr('_DIVK', kidFlagTable(ids, rx.divisionTypes))}
${rsBoolArr('_RXT', lidFlagTable(ids, rx.regexTexts))}
${rsBoolArr('_PHK', lidFlagTable(ids, rx.parenHeadKw))}
${rsBoolArr('_MEM', lidFlagTable(ids, rx.memberAccess))}
${rsBoolArr('_PAV', lidFlagTable(ids, rx.postfixAfterValue))}
const _KID_IDENT: u16 = ${kidOf(ids, rx.identToken)};
const _LID_LPAREN: u16 = ${lidOf(ids, '(')};
const _LID_RPAREN: u16 = ${lidOf(ids, ')')};
` : '';
  const tplLidConsts = tpl ? `const _LID_BRACE_OPEN: u16 = ${lidOf(ids, tpl.braceOpen)};
const _LID_INTERP_CLOSE: u16 = ${lidOf(ids, tpl.interpClose)};
` : '';
  const needIn = !!(nlRs); // newline flow still uses string _in
  const rxConsts = `${rxBitTables}${tplLidConsts}${needIn ? `fn _in(set: &[&str], x: &str) -> bool { set.iter().any(|s| *s == x) }\n` : ''}${nlRs ? nlRs.consts : ''}`;
  const pavHot = rx ? rsLidAny(ids, rx.postfixAfterValue, 'lid') : 'false';
  const tplFn = tpl ? `fn _scan_tpl_span(s: &str, mut p: usize) -> (bool, usize) {
    let b = s.as_bytes();
    let n = b.len();
    // Scan on bytes: p may land mid multi-byte UTF-8 after escape (+2) or byte-step;
    // &str[p..] would panic on char-boundary. ASCII delimiters match equivalently.
    while p < n {
        if b[p..].starts_with(${J(tpl.interpOpen)}.as_bytes()) { return (true, p + ${tpl.interpOpen.length}); }
        if b[p] == 92 { p += 2; continue; }
        if b[p..].starts_with(${J(tpl.open)}.as_bytes()) { return (false, p + ${tpl.open.length}); }
        p += 1;
    }
    (false, p)
}
` : '';
  const fields = ['toks: Vec<Tok>', 'pending_nl: bool',
    rx ? 'prev_lid: u16, prev_kid: u16, bp_lid: u16, has_prev: bool, has_prev2: bool, paren_head: Vec<bool>, last_close: bool, last_bang: bool' : '',
    tpl ? 'template_stack: Vec<i64>' : '',
    nlRs ? nlRs.fields : ''].filter(Boolean).join(', ');
  // Force-inline bookkeeping into the lex cascade. Under rustc -O (no LTO), leaving
  // emit/prev_is_value as outlined calls flips full-parse I-cache layout so lex gains
  // reverse into a parse regress; LTO / codegen-units=1 hide it — #[inline(always)] fixes -O.
  const inlAlways = '    #[inline(always)]\n';
  const prevIsValue = rx ? `${inlAlways}    fn prev_is_value(&self) -> bool {
        if !self.has_prev { return false; }
        if ${rsFlag('_PAV', 'self.prev_lid')} { return self.last_bang; }
        let is_expr_kw = self.prev_kid == _KID_IDENT && ${rsFlag('_RXT', 'self.prev_lid')};
        let is_paren_head = self.prev_lid == _LID_RPAREN && self.last_close;
        !is_expr_kw && !is_paren_head && (${rsFlag('_DIVK', 'self.prev_kid')} || ${rsFlag('_DIVT', 'self.prev_lid')})
    }
` : '';
  const emitHooks = [
    rx ? `        if lid == _LID_LPAREN { let is_member = self.has_prev2 && ${rsFlag('_MEM', 'self.bp_lid')}; self.paren_head.push(!is_member && self.prev_kid == _KID_IDENT && ${rsFlag('_PHK', 'self.prev_lid')}); }
        else if lid == _LID_RPAREN { self.last_close = self.paren_head.pop().unwrap_or(false); }
        if ${pavHot} { self.last_bang = self.prev_is_value(); }` : '',
    tpl ? `        if !self.template_stack.is_empty() { if lid == _LID_BRACE_OPEN { *self.template_stack.last_mut().unwrap() += 1; } else if lid == _LID_INTERP_CLOSE { *self.template_stack.last_mut().unwrap() -= 1; } }` : '',
    nlRs ? nlRs.hooks : '',
  ].filter(Boolean).join('\n');
  const emitTail = rx ? `
        self.bp_lid = self.prev_lid; self.has_prev2 = self.has_prev; self.prev_kid = kid; self.prev_lid = lid; self.has_prev = true;` : '';
  const stateImpl = stateful ? `struct LexState { ${fields} }
impl LexState {
${prevIsValue}${inlAlways}    fn emit(&mut self, off: usize, end: usize, kid: u16, lid: u16) {
${emitHooks}
        self.toks.push(mk_tok(off, end, self.pending_nl, kid, lid)); self.pending_nl = false;${emitTail}
    }
}
` : '';
  const rxScanImpl = rxOnly ? `struct RxScan<'a> { acc: &'a mut Vec<Tok>, pending_nl: bool, prev_lid: u16, prev_kid: u16, bp_lid: u16, has_prev: bool, has_prev2: bool, paren_head: Vec<bool>, last_close: bool, last_bang: bool }
impl<'a> RxScan<'a> {
${inlAlways}    fn prev_is_value(&self) -> bool {
        if !self.has_prev { return false; }
        if ${rsFlag('_PAV', 'self.prev_lid')} { return self.last_bang; }
        let is_expr_kw = self.prev_kid == _KID_IDENT && ${rsFlag('_RXT', 'self.prev_lid')};
        let is_paren_head = self.prev_lid == _LID_RPAREN && self.last_close;
        !is_expr_kw && !is_paren_head && (${rsFlag('_DIVK', 'self.prev_kid')} || ${rsFlag('_DIVT', 'self.prev_lid')})
    }
${inlAlways}    fn emit(&mut self, off: usize, end: usize, kid: u16, lid: u16) {
        if lid == _LID_LPAREN { let is_member = self.has_prev2 && ${rsFlag('_MEM', 'self.bp_lid')}; self.paren_head.push(!is_member && self.prev_kid == _KID_IDENT && ${rsFlag('_PHK', 'self.prev_lid')}); }
        else if lid == _LID_RPAREN { self.last_close = self.paren_head.pop().unwrap_or(false); }
        if ${pavHot} { self.last_bang = self.prev_is_value(); }
        self.acc.push(mk_tok(off, end, self.pending_nl, kid, lid)); self.pending_nl = false;
        self.bp_lid = self.prev_lid; self.has_prev2 = self.has_prev; self.prev_kid = kid; self.prev_lid = lid; self.has_prev = true;
    }
}
` : '';
  const tplScanImpl = tplOnly ? `struct TplScan<'a> { acc: &'a mut Vec<Tok>, pending_nl: bool, template_stack: Vec<i64> }
impl<'a> TplScan<'a> {
${inlAlways}    fn emit(&mut self, off: usize, end: usize, kid: u16, lid: u16) {
        if !self.template_stack.is_empty() { if lid == _LID_BRACE_OPEN { *self.template_stack.last_mut().unwrap() += 1; } else if lid == _LID_INTERP_CLOSE { *self.template_stack.last_mut().unwrap() -= 1; } }
        self.acc.push(mk_tok(off, end, self.pending_nl, kid, lid)); self.pending_nl = false;
    }
}
` : '';
  const rxTplScanImpl = rxTpl ? `struct RxTplScan<'a> { acc: &'a mut Vec<Tok>, pending_nl: bool, prev_lid: u16, prev_kid: u16, bp_lid: u16, has_prev: bool, has_prev2: bool, paren_head: Vec<bool>, last_close: bool, last_bang: bool, template_stack: Vec<i64> }
impl<'a> RxTplScan<'a> {
${inlAlways}    fn prev_is_value(&self) -> bool {
        if !self.has_prev { return false; }
        if ${rsFlag('_PAV', 'self.prev_lid')} { return self.last_bang; }
        let is_expr_kw = self.prev_kid == _KID_IDENT && ${rsFlag('_RXT', 'self.prev_lid')};
        let is_paren_head = self.prev_lid == _LID_RPAREN && self.last_close;
        !is_expr_kw && !is_paren_head && (${rsFlag('_DIVK', 'self.prev_kid')} || ${rsFlag('_DIVT', 'self.prev_lid')})
    }
${inlAlways}    fn emit(&mut self, off: usize, end: usize, kid: u16, lid: u16) {
        if lid == _LID_LPAREN { let is_member = self.has_prev2 && ${rsFlag('_MEM', 'self.bp_lid')}; self.paren_head.push(!is_member && self.prev_kid == _KID_IDENT && ${rsFlag('_PHK', 'self.prev_lid')}); }
        else if lid == _LID_RPAREN { self.last_close = self.paren_head.pop().unwrap_or(false); }
        if ${pavHot} { self.last_bang = self.prev_is_value(); }
        if !self.template_stack.is_empty() { if lid == _LID_BRACE_OPEN { *self.template_stack.last_mut().unwrap() += 1; } else if lid == _LID_INTERP_CLOSE { *self.template_stack.last_mut().unwrap() -= 1; } }
        self.acc.push(mk_tok(off, end, self.pending_nl, kid, lid)); self.pending_nl = false;
        self.bp_lid = self.prev_lid; self.has_prev2 = self.has_prev; self.prev_kid = kid; self.prev_lid = lid; self.has_prev = true;
    }
}
` : '';
  const initFields = ['toks: Vec::new()', 'pending_nl: false',
    rx ? 'prev_lid: 0, prev_kid: 0, bp_lid: 0, has_prev: false, has_prev2: false, paren_head: Vec::new(), last_close: false, last_bang: false' : '',
    tpl ? 'template_stack: Vec::new()' : '',
    nlRs ? nlRs.init : ''].filter(Boolean).join(', ');
  const open = stateful ? `    let mut st = LexState { ${initFields} };` : `    let mut toks: Vec<Tok> = Vec::new();\n    let mut pending_nl = false;`;
  const nlVar = stateful ? 'st.pending_nl' : 'pending_nl';
  const tplDispatch = tpl ? `        if !st.template_stack.is_empty() && src[pos..].starts_with(${J(tpl.interpClose)}) && *st.template_stack.last().unwrap() == 0 {
            st.template_stack.pop();
            let (interp, e) = _scan_tpl_span(src, pos + ${tpl.interpClose.length});
            if interp { st.emit(pos, e, ${kidOf(ids, "$templateMiddle")}, lid_of(&src[pos..e])); st.template_stack.push(0); } else { st.emit(pos, e, ${kidOf(ids, "$templateTail")}, lid_of(&src[pos..e])); }
            pos = e; continue;
        }
        if src[pos..].starts_with(${J(tpl.open)}) {
            let (interp, e) = _scan_tpl_span(src, pos + ${tpl.open.length});
            if interp { st.emit(pos, e, ${kidOf(ids, "$templateHead")}, lid_of(&src[pos..e])); st.template_stack.push(0); } else { st.emit(pos, e, ${kidOf(ids, tpl.token)}, lid_of(&src[pos..e])); }
            pos = e; continue;
        }
` : '';
  const nlBoundary = nlRs ? nlRs.boundary : '';
  const nlWs = nlRs ? nlRs.ws : `        if c == 32 || c == 9 { pos += 1; continue; }
        if pos + 2 < n && b[pos] == 0xE2 && b[pos + 1] == 0x80 && (b[pos + 2] == 0xA8 || b[pos + 2] == 0xA9) { ${nlVar} = true; pos += 3; continue; }   // LS/PS (UTF-8)
        if c == 10 || c == 13 { ${nlVar} = true; pos += 1; continue; }   // LF/CR
`;
  const loopBody = `${nlBoundary}        let c = b[pos] as u32;
${nlWs}${tplDispatch}${cascade}
        panic!("lex error at {}", pos);`;
  if (rxOnly) {
    const rxLoopBody = `${nlBoundary}        let c = b[pos] as u32;
${nlWs}${cascade}
        panic!("lex error at {}", pos);`;
    return `${renderIdTablesRust(ids)}${defs.length ? defs.join('\n') + '\n' : ''}${rxConsts}${tplFn}${rxScanImpl}fn lex_from<'a>(src: &'a str, mut pos: usize, mut pending_nl: bool, mut prev_lid: u16, mut prev_kid: u16, mut bp_lid: u16, mut has_prev: bool, mut has_prev2: bool, mut paren_head: Vec<bool>, mut last_close: bool, mut last_bang: bool, acc: &mut Vec<Tok>, limit: usize) -> (usize, bool, u16, u16, u16, bool, bool, Vec<bool>, bool, bool) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    let mut st = RxScan { acc, pending_nl, prev_lid, prev_kid, bp_lid, has_prev, has_prev2, paren_head, last_close, last_bang };
    while pos < n && (limit == 0 || st.acc.len() - base < limit) {
${rxLoopBody}
    }
    (pos, st.pending_nl, st.prev_lid, st.prev_kid, st.bp_lid, st.has_prev, st.has_prev2, st.paren_head, st.last_close, st.last_bang)
}
fn lex<'a>(src: &'a str) -> Vec<Tok> {
    let mut toks = Vec::new();
    lex_from(src, 0, false, 0, 0, 0, false, false, Vec::new(), false, false, &mut toks, 0);
    toks
}`;
  }
  if (tplOnly) {
    return `${renderIdTablesRust(ids)}${defs.length ? defs.join('\n') + '\n' : ''}${rxConsts}${tplFn}${tplScanImpl}fn lex_from<'a>(src: &'a str, mut pos: usize, mut pending_nl: bool, template_stack: Vec<i64>, acc: &mut Vec<Tok>, limit: usize) -> (usize, bool, Vec<i64>) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    let mut st = TplScan { acc, pending_nl, template_stack };
    while pos < n && (limit == 0 || st.acc.len() - base < limit) {
${loopBody}
    }
    (pos, st.pending_nl, st.template_stack)
}
fn lex<'a>(src: &'a str) -> Vec<Tok> {
    let mut toks = Vec::new();
    lex_from(src, 0, false, Vec::new(), &mut toks, 0);
    toks
}`;
  }
  if (rxTpl) {
    return `${renderIdTablesRust(ids)}${defs.length ? defs.join('\n') + '\n' : ''}${rxConsts}${tplFn}${rxTplScanImpl}fn lex_from<'a>(src: &'a str, mut pos: usize, mut pending_nl: bool, mut prev_lid: u16, mut prev_kid: u16, mut bp_lid: u16, mut has_prev: bool, mut has_prev2: bool, mut paren_head: Vec<bool>, mut last_close: bool, mut last_bang: bool, template_stack: Vec<i64>, acc: &mut Vec<Tok>, limit: usize) -> (usize, bool, u16, u16, u16, bool, bool, Vec<bool>, bool, bool, Vec<i64>) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    let mut st = RxTplScan { acc, pending_nl, prev_lid, prev_kid, bp_lid, has_prev, has_prev2, paren_head, last_close, last_bang, template_stack };
    while pos < n && (limit == 0 || st.acc.len() - base < limit) {
${loopBody}
    }
    (pos, st.pending_nl, st.prev_lid, st.prev_kid, st.bp_lid, st.has_prev, st.has_prev2, st.paren_head, st.last_close, st.last_bang, st.template_stack)
}
fn lex<'a>(src: &'a str) -> Vec<Tok> {
    let mut toks = Vec::new();
    lex_from(src, 0, false, 0, 0, 0, false, false, Vec::new(), false, false, Vec::new(), &mut toks, 0);
    toks
}`;
  }
  if (rxOrTpl) {
    return `${renderIdTablesRust(ids)}${defs.length ? defs.join('\n') + '\n' : ''}${rxConsts}${tplFn}${stateImpl}fn lex<'a>(src: &'a str) -> Vec<Tok> {
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
      .replace(/toks\.push\(mk_tok\(pos, ([^,]+), pending_nl, ([^,]+), (.+)\)\); ?/g, 'st.push_tok(pos, $1, $2, $3); ')
      .replace(/pending_nl/g, 'st.pending_nl');
    const nlLoopBody = `${nlRs!.boundaryFrom}        let c = b[pos] as u32;
${nlRs!.wsFrom}${rustNlScan(cascade)}
        panic!("lex error at {}", pos);`;
    return `${renderIdTablesRust(ids)}${defs.length ? defs.join('\n') + '\n' : ''}${rxConsts}${tplFn}struct NlScan<'a> { acc: &'a mut Vec<Tok>, pending_nl: bool, line_start: bool, emitted_content: bool, flow_depth: i64 }
impl<'a> NlScan<'a> {
    fn push_tok(&mut self, off: usize, end: usize, kid: u16, lid: u16) {
${nlRs!.hooksFrom.replace(/emitted_content/g, 'self.emitted_content').replace(/flow_depth/g, 'self.flow_depth').replace(/pending_nl/g, 'self.pending_nl')}
        self.acc.push(mk_tok(off, end, self.pending_nl, kid, lid)); self.pending_nl = false;
    }
}
fn lex_from<'a>(src: &'a str, mut pos: usize, mut pending_nl: bool, mut line_start: bool, mut emitted_content: bool, mut flow_depth: i64, acc: &mut Vec<Tok>, limit: usize) -> (usize, bool, bool, bool, i64) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    let mut st = NlScan { acc, pending_nl, line_start, emitted_content, flow_depth };
    while pos < n && (limit == 0 || st.acc.len() - base < limit) {
${nlLoopBody}
    }
    (pos, st.pending_nl, st.line_start, st.emitted_content, st.flow_depth)
}
fn lex<'a>(src: &'a str) -> Vec<Tok> {
    let mut toks = Vec::new();
    lex_from(src, 0, false, true, false, 0, &mut toks, 0);
    toks
}`;
  }
  return `${renderIdTablesRust(ids)}${defs.length ? defs.join('\n') + '\n' : ''}${rxConsts}${tplFn}fn lex_from<'a>(src: &'a str, mut pos: usize, mut pending_nl: bool, acc: &mut Vec<Tok>, limit: usize) -> (usize, bool) {
    let b = src.as_bytes();
    let n = b.len();
    let base = acc.len();
    while pos < n && (limit == 0 || acc.len() - base < limit) {
${loopBody.replace(/pending_nl/g, 'pending_nl').replace(/toks\.push/g, 'acc.push')}
    }
    (pos, pending_nl)
}
fn lex<'a>(src: &'a str) -> Vec<Tok> {
    let mut toks = Vec::new();
    lex_from(src, 0, false, &mut toks, 0);
    toks
}`;
}

// Top-level step: uses `self`; children accumulate on `self.scratch`.
type ReusePlanA = { kind: 'A'; topOneBody: string };
type ReusePlanB = { kind: 'B'; hasHead: boolean; headRule: string | null; loopTok: string; loopRule: string };
type ReusePlan = ReusePlanA | ReusePlanB;

function matchLoopSeq(step: Step): { loopTok: string; loopRule: string } | null {
  if (step.t !== 'seq' || step.steps.length !== 2) return null;
  const [a, b] = step.steps;
  if (a.t !== 'tok') return null;
  if (b.t !== 'opt' || b.steps.length !== 1 || b.steps[0].t !== 'rule') return null;
  return { loopTok: a.name, loopRule: (b.steps[0] as { t: 'rule'; name: string }).name };
}

function topReusePlan(ir: ParserIR): ReusePlan | null {
  const entry = ir.rules.find((r) => r.name === ir.entry);
  if (!entry || entry.kind !== 'rd' || entry.alts.length !== 1) return null;
  const alt = entry.alts[0];
  if (alt.length === 1 && alt[0].t === 'star') {
    const step = alt[0].step;
    if (step.t === 'rule') return { kind: 'A', topOneBody: `        return self.parse_${step.name}();` };
    if (step.t === 'alt') {
      for (const br of step.branches) {
        if (br.length !== 1 || br[0].t !== 'rule') return null;
      }
      const tries = step.branches.map((br) => {
        const name = (br[0] as { t: 'rule'; name: string }).name;
        return `        { let sp = self.pos; if let Some(n) = self.parse_${name}() { return Some(n); } self.pos = sp; }`;
      }).join('\n');
      return { kind: 'A', topOneBody: `${tries}\n        None` };
    }
    const loop = matchLoopSeq(step);
    if (loop) return { kind: 'B', hasHead: false, headRule: null, ...loop };
    return null;
  }
  if (alt.length === 2 && alt[0].t === 'opt' && alt[1].t === 'star') {
    const hs = alt[0].steps;
    if (hs.length !== 1 || hs[0].t !== 'rule') return null;
    const loop = matchLoopSeq(alt[1].step);
    if (!loop) return null;
    return { kind: 'B', hasHead: true, headRule: hs[0].name, ...loop };
  }
  return null;
}


// Top-level step: uses `self`; children accumulate on `self.scratch`.
function stepCond(s: Step, ids: LexIdPlan, ar: ArenaIdPlan): string {
  switch (s.t) {
    case 'lit': return `self.match_lit(${lidOf(ids, s.value)}, ${ttIdOf(ar, s.ttype)})`;
    case 'tok': return `self.match_tok(${kidOf(ids, s.name)}, ${ttIdOf(ar, s.name)})`;
    case 'rule': return `self.call_rule(Parser::parse_${s.name})`;
    case 'ruleBp': return `self.call_rule(|p| p.${s.name}_bp(${s.bp}))`;
    case 'star': return `self.star(|p| ${stepCondP(s.step, ids, ar)})`;
    case 'opt': return `self.opt(|p| ${s.steps.map((x) => stepCondP(x, ids, ar)).join(' && ')})`;
    case 'sep': return `self.sep_by(|p| ${stepCondP(s.elem, ids, ar)}, ${lidOf(ids, s.delim)})`;
    case 'altlit': return `self.alt_lit(&[${s.opts.map((o) => `(${lidOf(ids, o.value)}, ${ttIdOf(ar, o.ttype)})`).join(', ')}])`;
    case 'alt': return s.predictive
      ? `(|p: &mut Parser<'a, B>| -> bool { ${predAltBody(s.branches, ids, ar, s.firsts)} })(self)`
      : `(|p: &mut Parser<'a, B>| -> bool { ${altBody(s.branches, ids, ar, s.firsts)} })(self)`;
    case 'not': return `(|p: &mut Parser<'a, B>| -> bool { ${notBody(s.steps, ids, ar)} })(self)`;
    case 'seq': return `(${s.steps.length ? s.steps.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'})`;
    case 'sameLine': return `matches!(self.peek(), Some(t) if !t.nl)`;
    case 'suppress': return `{ self.suppress_next = vec![${s.connectors.map((c) => lidOf(ids, c)).join(', ')}]; let _r = (${s.steps.length ? s.steps.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'}); self.suppress_next = Vec::new(); _r }`;
  }
}
function stepCondP(s: Step, ids: LexIdPlan, ar: ArenaIdPlan): string {
  switch (s.t) {
    case 'lit': return `p.match_lit(${lidOf(ids, s.value)}, ${ttIdOf(ar, s.ttype)})`;
    case 'tok': return `p.match_tok(${kidOf(ids, s.name)}, ${ttIdOf(ar, s.name)})`;
    case 'rule': return `p.call_rule(Parser::parse_${s.name})`;
    case 'ruleBp': return `p.call_rule(|p| p.${s.name}_bp(${s.bp}))`;
    case 'star': return `p.star(|p| ${stepCondP(s.step, ids, ar)})`;
    case 'opt': return `p.opt(|p| ${s.steps.map((x) => stepCondP(x, ids, ar)).join(' && ')})`;
    case 'sep': return `p.sep_by(|p| ${stepCondP(s.elem, ids, ar)}, ${lidOf(ids, s.delim)})`;
    case 'altlit': return `p.alt_lit(&[${s.opts.map((o) => `(${lidOf(ids, o.value)}, ${ttIdOf(ar, o.ttype)})`).join(', ')}])`;
    case 'alt': return s.predictive
      ? `(|p: &mut Parser<'a, B>| -> bool { ${predAltBody(s.branches, ids, ar, s.firsts)} })(p)`
      : `(|p: &mut Parser<'a, B>| -> bool { ${altBody(s.branches, ids, ar, s.firsts)} })(p)`;
    case 'not': return `(|p: &mut Parser<'a, B>| -> bool { ${notBody(s.steps, ids, ar)} })(p)`;
    case 'seq': return `(${s.steps.length ? s.steps.map((x) => stepCondP(x, ids, ar)).join(' && ') : 'true'})`;
    case 'sameLine': return `matches!(p.peek(), Some(t) if !t.nl)`;
    case 'suppress': return `{ p.suppress_next = vec![${s.connectors.map((c) => lidOf(ids, c)).join(', ')}]; let _r = (${s.steps.length ? s.steps.map((x) => stepCondP(x, ids, ar)).join(' && ') : 'true'}); p.suppress_next = Vec::new(); _r }`;
  }
}
function altBody(branches: Step[][], ids: LexIdPlan, ar: ArenaIdPlan, firsts?: FirstSig[]): string {
  const fs = firsts ?? [];
  const nAlts = branches.length;
  const needPeek = branches.some((_, i) => isGuardable(fs[i] ?? null, nAlts));
  const peekInit = needPeek ? `let _ft = p.peek(); ` : '';
  const tries = branches.map((br, i) => {
    const body = `{ let sp = p.pos; let sb = p.scratch.len(); let ck = p.b.checkpoint(); if ${br.length ? br.map((x) => stepCondP(x, ids, ar)).join(' && ') : 'true'} { return true; } p.pos = sp; p.scratch.truncate(sb); p.b.restore(ck); }`;
    const f = fs[i] ?? null;
    if (!isGuardable(f, nAlts)) return body;
    return `if let Some(t) = _ft { if ${firstCond(f, 't', ids)} ${body} }`;
  }).join(' ');
  return `${peekInit}${tries} false`;
}
function notBody(steps: Step[], ids: LexIdPlan, ar: ArenaIdPlan): string {
  return `let sp = p.pos; let sb = p.scratch.len(); let ck = p.b.checkpoint(); let m = ${steps.length ? steps.map((x) => stepCondP(x, ids, ar)).join(' && ') : 'true'}; p.pos = sp; p.scratch.truncate(sb); p.b.restore(ck); !m`;
}
function predAltBody(branches: Step[][], ids: LexIdPlan, ar: ArenaIdPlan, firsts?: FirstSig[]): string {
  const arms = branches.map((br, i) => `        ${i === 0 ? 'if' : 'else if'} ${firstCond(firsts![i], 't', ids)} { if ${br.length ? br.map((x) => stepCondP(x, ids, ar)).join(' && ') : 'true'} { return true; } }`).join('\n');
  return `let t = match p.peek() { Some(t) => t, None => return false };\n${arms}\n        false`;
}

function rdRule(r: RdRule, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const rid = ruleIdOf(ar, r.cstName);
  if (r.predictive) {
    const arm = (steps: Step[], i: number) => `        ${i === 0 ? 'if' : 'else if'} ${firstCond(r.altFirst[i], 't', ids)} { if ${steps.map((x) => stepCond(x, ids, ar)).join(' && ')} { return Some(self.finish(${rid}, sb, self.off_at(save), save)); } }`;
    return `    fn parse_${r.name}(&mut self) -> Option<Spanned<B::H>> {
        let save = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
        let t = match self.peek() { Some(t) => t, None => return None };
${r.alts.map(arm).join('\n')}
        self.pos = save; self.scratch.truncate(sb); self.b.restore(ck);
        None
    }`;
  }
  const alt = (steps: Step[], i: number) => {
    const cond = steps.map((x) => stepCond(x, ids, ar)).join(' && ');
    const restore = `self.pos = save; self.scratch.truncate(sb); self.b.restore(ck);`;
    if (!isGuardable(r.altFirst[i], r.alts.length)) {
      return `        if ${cond} { return Some(self.finish(${rid}, sb, self.off_at(save), save)); }
        ${restore}`;
    }
    return `        if let Some(t) = _ft { if ${firstCond(r.altFirst[i], 't', ids)} {
            if ${cond} { return Some(self.finish(${rid}, sb, self.off_at(save), save)); }
            ${restore}
        } }`;
  };
  const needPeek = r.alts.some((_, i) => isGuardable(r.altFirst[i], r.alts.length));
  return `    fn parse_${r.name}(&mut self) -> Option<Spanned<B::H>> {
        let save = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
${needPeek ? '        let _ft = self.peek();\n' : ''}${r.alts.map(alt).join('\n')}
        None
    }`;
}

/** Entry rule that records per-top-kid lookahead ext via parse_top_one (shape A). */
function rdEntryWithReuseA(r: RdRule, plan: ReusePlanA, ar: ArenaIdPlan): string {
  const rid = ruleIdOf(ar, r.cstName);
  return `    fn parse_top_one(&mut self) -> Option<Spanned<B::H>> {
${plan.topOneBody}
    }
    #[inline(always)]
    fn push_entry_from_h(&mut self, h: B::H) {
        let meta = self.b.entry_meta(h, self.max_look as u32, &self.toks);
        self.entries.push(meta);
    }
    fn parse_${r.name}(&mut self) -> Option<Spanned<B::H>> {
        let save = self.pos; let sb = self.scratch.len();
        self.entries.clear();
        self.entries.reserve((self.toks.len().saturating_sub(self.pos) / 2).max(8));
        loop {
            let sp = self.pos;
            self.max_look = 0;
            match self.parse_top_one() {
                None => { self.pos = sp; break; }
                Some(fr) => {
                    if fr.present {
                        // Engine-side side table (decision input). CstBuilder.entry_meta also stamps Node.ext.
                        self.push_entry_from_h(fr.h);
                        self.scratch.push(fr.h);
                    }
                }
            }
        }
        Some(self.finish(${rid}, sb, self.off_at(save), save))
    }`;
}

function rdEntryWithReuseB(r: RdRule, plan: ReusePlanB, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const rid = ruleIdOf(ar, r.cstName);
  const headFn = plan.hasHead && plan.headRule
    ? `    fn parse_head_seg(&mut self, sb: usize) -> Option<(Seg, EntryMeta)> {
        self.max_look = 0;
        let before = self.scratch.len();
        self.opt(|p| p.call_rule(Parser::parse_${plan.headRule}));
        if self.scratch.len() == before { return None; }
        let n = self.scratch[before];
        let (tok_start, tok_end) = self.b.tok_range(n);
        let mut ext = tok_end;
        if (self.max_look as u32) > ext { ext = self.max_look as u32; }
        let (off, end) = self.b.span_of(n, &self.toks);
        let kid_start = (before - sb) as u32;
        let meta = EntryMeta { tok_start: tok_start as u32, tok_end: tok_end as u32, ext: ext as u32, off, end, kid_start, kid_count: 1 };
        Some((Seg { kid_start: before - sb, kid_count: 1, tok_start: tok_start as usize, tok_end: tok_end as usize, ext: ext as usize }, meta))
    }
`
    : '';
  const headBlock = plan.hasHead && plan.headRule
    ? `        if let Some((h, m)) = self.parse_head_seg(sb) { local.push(h); local_e.push(m); }
`
    : '';
  return `${headFn}    fn parse_loop_seg(&mut self, sb: usize) -> Option<(Seg, EntryMeta)> {
        let sp = self.pos; let before = self.scratch.len(); let ck = self.b.checkpoint();
        self.max_look = 0;
        if !self.match_tok(${kidOf(ids, plan.loopTok)}, ${ttIdOf(ar, plan.loopTok)}) {
            self.pos = sp; self.scratch.truncate(before); self.b.restore(ck);
            return None;
        }
        self.opt(|p| p.call_rule(Parser::parse_${plan.loopRule}));
        let leaf = self.scratch[before];
        let (tok_start, mut tok_end) = self.b.tok_range(leaf);
        let count = self.scratch.len() - before;
        if count > 1 { tok_end = self.b.tok_range(self.scratch[before + 1]).1; }
        let mut ext = tok_end;
        if (self.max_look as u32) > ext { ext = self.max_look as u32; }
        let (off, mut end) = self.b.span_of(leaf, &self.toks);
        if count > 1 { end = self.b.span_of(self.scratch[before + 1], &self.toks).1; }
        let kid_start = (before - sb) as u32;
        let meta = EntryMeta { tok_start: tok_start as u32, tok_end: tok_end as u32, ext: ext as u32, off, end, kid_start, kid_count: count as u32 };
        // Engine-side EntryMeta is the reuse decision source; Seg kept as validate oracle (+ SEGK mirror).
        Some((Seg { kid_start: before - sb, kid_count: count, tok_start: tok_start as usize, tok_end: tok_end as usize, ext: ext as usize }, meta))
    }
    fn parse_${r.name}(&mut self) -> Option<Spanned<B::H>> {
        let save = self.pos; let sb = self.scratch.len();
        let mut local: Vec<Seg> = Vec::new();
        let mut local_e: Vec<EntryMeta> = Vec::new();
${headBlock}        loop {
            match self.parse_loop_seg(sb) {
                Some((seg, meta)) => { local.push(seg); local_e.push(meta); }
                None => break,
            }
        }
        self.segs = local;
        self.entries = local_e;
        Some(self.finish(${rid}, sb, self.off_at(save), save))
    }`;
}

function rdEntryWithReuse(r: RdRule, plan: ReusePlan, ids: LexIdPlan, ar: ArenaIdPlan): string {
  return plan.kind === 'A' ? rdEntryWithReuseA(r, plan, ar) : rdEntryWithReuseB(r, plan, ids, ar);
}

function prattRule(r: PrattRule, tpl: TplCfg | null, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const rid = ruleIdOf(ar, r.cstName);
  const binArms = r.binary.map((b) => `${lidOf(ids, b.op)} => Some((${b.lbp}, ${b.rbp}))`).join(', ');
  const preArms = r.prefix.map((p) => `${lidOf(ids, p.op)} => Some(${p.rbp})`).join(', ');
  const postArms = r.postfix.map((p) => `${lidOf(ids, p.op)} => Some(${p.lbp})`).join(', ');
  const atomArm = r.nudToks.map((k) => `${kidOf(ids, k)}`).join(' | ');
  const tplNud = tpl && r.nudToks.includes(tpl.token)
    ? `        if t.kid == ${kidOf(ids, "$templateHead")} {
            let n = match self.match_template() { Some(n) => n, None => return None };
            let sb = self.scratch.len();
            if n.present { self.scratch.push(n.h); }
            return Some(self.finish(${rid}, sb, n.off as usize, n.tok_start as usize));
        }\n`
    : '';
  const bracketNudBody = (b: Bracket) => `{
            let save = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
            if ${b.steps.map((x) => stepCond(x, ids, ar)).join(' && ')} { return Some(self.finish(${rid}, sb, self.off_at(save), save)); }
            self.pos = save; self.scratch.truncate(sb); self.b.restore(ck);
        }`;
  const bracketNudMatch = (() => {
    if (r.nudBrackets.length === 0) return '';
    const groups = groupByPreserveOrder(r.nudBrackets, (b) => lidOf(ids, b.first));
    return `        match t.lid {
${groups.map((g) => `            ${g.key} => {
${g.members.map(({ item: b }) => `                ${bracketNudBody(b)}`).join('\n')}
            }`).join('\n')}
            _ => {}
        }`;
  })();
  const ledGuard = (accessTail: boolean, lbp: number | null, sameLine: boolean, nll: string[] | null, lid: number) => {
    const parts: string[] = [];
    if (accessTail) parts.push('!tail_closed');
    if (lbp !== null) parts.push(`${lbp} > min_bp`);
    if (sameLine) parts.push('!t.nl');
    if (nll) parts.push(`!self.nll_blocked(&[${nll.map(J).join(', ')}], &left)`);
    parts.push(`!self.suppress_cur.iter().any(|c| *c == ${lid})`);
    return parts.join(' && ');
  };
  const ledBody = (b: Bracket) => `{
                let led_save = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
                self.scratch.push(left.h);
                if ${b.steps.map((x) => stepCond(x, ids, ar)).join(' && ')} { left = self.finish(${rid}, sb, left.off as usize, left.tok_start as usize); continue; }
                self.pos = led_save; self.scratch.truncate(sb); self.b.restore(ck); break;
            }`;
  const ledMatch = (() => {
    if (r.leds.length === 0) return '';
    const groups = groupByPreserveOrder(r.leds, (b) => lidOf(ids, b.first));
    return `            match t.lid {
${groups.map((g) => {
  const lid = g.key as number;
  const arms = g.members.map(({ item: b, index: i }) =>
    `                if ${ledGuard(r.ledAccessTail[i]!, r.ledLbp[i]!, r.ledSameLine[i]!, r.ledNotLeftLeaf[i]!, lid)} ${ledBody(b)}`);
  return `                ${lid} => {\n${arms.join('\n')}\n                }`;
}).join('\n')}
                _ => {}
            }`;
  })();
  const postfixTokMatch = (() => {
    if (r.postfixToks.length === 0) return '';
    const groups = groupByPreserveOrder(r.postfixToks, (tok) => kidOf(ids, tok));
    const hasTpl = !!(tpl && r.postfixToks.includes(tpl.token));
    const tplPart = hasTpl ? `
            if !tail_closed && t.kid == ${kidOf(ids, "$templateHead")} { if let Some(n) = self.match_template() { let sb = self.scratch.len(); if left.present { self.scratch.push(left.h); } if n.present { self.scratch.push(n.h); } left = self.finish(${rid}, sb, left.off as usize, left.tok_start as usize); continue; } }` : '';
    return `            match t.kid {
${groups.map((g) => `                ${g.key} => { if !tail_closed { let sb = self.scratch.len(); self.scratch.push(left.h); self.push_leaf(t.kid as u16, self.pos as u32, t.off, t.end); self.pos += 1; left = self.finish(${rid}, sb, left.off as usize, left.tok_start as usize); continue; } }`).join('\n')}
                _ => {}
            }${tplPart}`;
  })();
  return `    fn parse_${r.name}(&mut self) -> Option<Spanned<B::H>> {
        let prev = std::mem::take(&mut self.suppress_cur);
        self.suppress_cur = std::mem::take(&mut self.suppress_next);
        let r = self.${r.name}_bp(0);
        self.suppress_cur = prev;
        r
    }
    fn ${r.name}_bin(op: u16) -> Option<(i64, i64)> { match op { ${binArms}${binArms ? ', ' : ''}_ => None } }
    fn ${r.name}_pre(op: u16) -> Option<i64> { match op { ${preArms}${preArms ? ', ' : ''}_ => None } }
    fn ${r.name}_post(op: u16) -> Option<i64> { match op { ${postArms}${postArms ? ', ' : ''}_ => None } }
    fn ${r.name}_atom(kid: u16) -> bool { matches!(kid, ${atomArm || '0'}) }
    fn ${r.name}_bp(&mut self, min_bp: i64) -> Option<Spanned<B::H>> {
        let mut left = self.${r.name}_nud(min_bp)?;
        if self.capped { return Some(left); }
        let mut tail_closed = false;
        loop {
            let t = match self.peek() { Some(t) => t, None => break };
${ledMatch}
${postfixTokMatch}
            if let Some(plbp) = Self::${r.name}_post(t.lid) { if !tail_closed && plbp > min_bp { let sb = self.scratch.len(); self.scratch.push(left.h); self.push_leaf(${ttIdOf(ar, '$operator')}, self.pos as u32, t.off, t.end); self.pos += 1; left = self.finish(${rid}, sb, left.off as usize, left.tok_start as usize); tail_closed = true; continue; } }
            let (lbp, rbp) = match Self::${r.name}_bin(t.lid) { Some(x) => x, None => break };
            if lbp <= min_bp { break; }
            let led_save = self.pos;
            let sb = self.scratch.len(); self.scratch.push(left.h);
            self.push_leaf(${ttIdOf(ar, '$operator')}, self.pos as u32, t.off, t.end);
            self.pos += 1;
            let rhs = match self.${r.name}_bp(rbp) { Some(r) => r, None => { self.pos = led_save; self.scratch.truncate(sb); break; } };
            if rhs.present { self.scratch.push(rhs.h); }
            left = self.finish(${rid}, sb, left.off as usize, left.tok_start as usize);
        }
        Some(left)
    }
    fn ${r.name}_nud(&mut self, min_bp: i64) -> Option<Spanned<B::H>> {
        self.capped = false;
        let t = self.peek()?;
${r.nudCapped.map((c) => `        if min_bp < ${c.capBp} { let save = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint(); if ${c.steps.length ? c.steps.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'} { self.capped = true; return Some(self.finish(${rid}, sb, self.off_at(save), save)); } self.pos = save; self.scratch.truncate(sb); self.b.restore(ck); }`).join('\n')}
        let r = self.${r.name}_nud_rest(t);
        self.capped = false;
        r
    }
    fn ${r.name}_nud_rest(&mut self, t: Tok) -> Option<Spanned<B::H>> {
${tplNud}        if Self::${r.name}_atom(t.kid) {
            let sb = self.scratch.len(); let ts = self.pos;
            self.push_leaf(t.kid as u16, self.pos as u32, t.off, t.end); self.pos += 1;
            return Some(self.finish(${rid}, sb, t.off as usize, ts));
        }
${bracketNudMatch}
        if let Some(pbp) = Self::${r.name}_pre(t.lid) {
            let save = self.pos; let sb = self.scratch.len(); self.push_leaf(${ttIdOf(ar, '$operator')}, self.pos as u32, t.off, t.end); self.pos += 1;
            match self.${r.name}_bp(pbp) {
                Some(operand) => { if operand.present { self.scratch.push(operand.h); } return Some(self.finish(${rid}, sb, self.off_at(save), save)); }
                None => { self.pos = save; self.scratch.truncate(sb); return None; }
            }
        }
${r.nudSeqs.map((seq) => `        { let save = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint(); if ${seq.length ? seq.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'} { return Some(self.finish(${rid}, sb, self.off_at(save), save)); } self.pos = save; self.scratch.truncate(sb); self.b.restore(ck); }`).join('\n')}
        None
    }`;
}


function docEditBlockRust(ir: ParserIR): string {
  const windowLex = (!ir.regexCtx && !ir.tpl) || !ir.newlineCfg;
  const hasNewline = !!(ir.newlineCfg && !ir.regexCtx && !ir.tpl);
  const rxOnly = !!(ir.regexCtx && !ir.tpl && !ir.newlineCfg);
  const tplOnly = !!(ir.tpl && !ir.regexCtx && !ir.newlineCfg);
  const rxTpl = !!(ir.regexCtx && ir.tpl && !ir.newlineCfg);
  const topReuse = topReusePlan(ir);
  const shapeA = topReuse?.kind === 'A';
  const shapeB = topReuse?.kind === 'B';
  const hasHeadB = !!(shapeB && topReuse.kind === 'B' && topReuse.hasHead);
  const entriesInit = topReuse ? ', entries: Vec::new()' : '';
  const entriesMove = topReuse ? ' self.entries = p.entries;' : '';
  const segsInit = shapeB ? ', segs: Vec::new()' : '';
  const segsMove = shapeB ? ' self.segs = p.segs;' : '';
  const reuseInit = `${entriesInit}${segsInit}`;
  const reuseMove = `${entriesMove}${segsMove}`;
  const adoptSuffix = `                        for j in (o_idx + 1)..old_toks.len() {
                            let ot = &old_toks[j];
                            out.push(AlignMeta { kind: ot.kind, off: (ot.off as isize + delta) as usize, end: (ot.end as isize + delta) as usize, nl: ot.nl, fd: ot.fd, pd: ot.pd, lc: ot.lc, lb: ot.lb, hd: ot.hd, td: ot.td });
                        }`;
  const findTokAtOff = `
fn find_tok_at_off(toks: &[AlignMeta], off: usize) -> Option<usize> {
    let mut lo = 0usize; let mut hi = toks.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if toks[mid].off < off { lo = mid + 1; } else if toks[mid].off > off { hi = mid; } else { return Some(mid); }
    }
    None
}`;
  const reconstructParens = `
fn reconstruct_parens(toks: &[AlignMeta], text: &str, b: isize) -> Vec<bool> {
    let mut need = if b >= 0 { toks[b as usize].pd } else { 0 };
    let mut out = vec![false; need as usize];
    let mut i = b;
    while i >= 0 && need > 0 {
        let t = &toks[i as usize];
        if &text[t.off..t.end] == "(" && t.pd == need {
            out[(need - 1) as usize] = t.hd;
            need -= 1;
        }
        i -= 1;
    }
    out
}
fn paren_stacks_eq(a: &[bool], b: &[bool]) -> bool { a == b }`;
  const tplAnchor = `    let mut max_idx: isize = -1;
    for (i, t) in old_toks.iter().enumerate() {
        if t.end < start { max_idx = i as isize; } else { break; }
    }
    let rb0: isize = if max_idx >= 0 { max_idx - 1 } else { -1 };
    let mut rb: isize = -1;
    if rb0 >= 0 {
        for i in rb0 as usize..old_toks.len() {
            if old_toks[i].end > start { break; }
            if old_toks[i].td == 0 { rb = i as isize; break; }
        }
    }
    let mut out: Vec<AlignMeta> = if rb >= 0 { old_toks[..=rb as usize].to_vec() } else { Vec::new() };`;
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
    let mut scratch: Vec<Tok> = Vec::new();
    let mut relexed = 0usize;
    while scan_off < new_text.len() {
        let before = scratch.len();
        (scan_off, pending_nl, line_start, emitted_content, flow_depth) = lex_from(new_text, scan_off, pending_nl, line_start, emitted_content, flow_depth, &mut scratch, 1);
        if scratch.len() == before { break; }
        let t = &scratch[scratch.len() - 1];
        out.push(AlignMeta { kind: tok_kind(t), off: t.off as usize, end: t.end as usize, nl: t.nl, fd: flow_depth, pd: 0, lc: false, lb: false, hd: false, td: 0 });
        relexed += 1;
        if (t.off as usize) >= edit_end {
            if let Some(o_idx) = find_tok_at_off_kind(old_toks, (t.off as isize - delta) as usize, tok_kind(t)) {
                let o = &old_toks[o_idx];
                if o.kind == tok_kind(t) && o.end == (t.end as isize - delta) as usize && o.nl == t.nl && o.fd == flow_depth && old_text[o.off..o.end] == new_text[t.off as usize..t.end as usize] {
                    for ot in &old_toks[o_idx + 1..] {
                        out.push(AlignMeta { kind: ot.kind, off: (ot.off as isize + delta) as usize, end: (ot.end as isize + delta) as usize, nl: ot.nl, fd: ot.fd, pd: ot.pd, lc: ot.lc, lb: ot.lb, hd: ot.hd, td: ot.td });
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
    let mut prev_lid: u16 = 0;
    let mut prev_kid: u16 = 0;
    let mut bp_lid: u16 = 0;
    let mut has_prev = false;
    let mut has_prev2 = false;
    let mut paren_head: Vec<bool> = Vec::new();
    let mut last_close = false;
    let mut last_bang = false;
    if rb >= 0 {
        let anchor = &old_toks[rb as usize];
        scan_off = anchor.end;
        prev_lid = lid_of(&old_text[anchor.off..anchor.end]);
        prev_kid = kid_of(anchor.kind);
        has_prev = true;
        if rb >= 1 {
            let p = &old_toks[rb as usize - 1];
            bp_lid = lid_of(&old_text[p.off..p.end]);
            has_prev2 = true;
        }
        last_close = anchor.lc;
        last_bang = anchor.lb;
        paren_head = reconstruct_parens(old_toks, old_text, rb);
    } else {
        scan_off = 0;
    }
    let mut scratch: Vec<Tok> = Vec::new();
    let mut relexed = 0usize;
    while scan_off < new_text.len() {
        let before = scratch.len();
        (scan_off, pending_nl, prev_lid, prev_kid, bp_lid, has_prev, has_prev2, paren_head, last_close, last_bang) = lex_from(new_text, scan_off, pending_nl, prev_lid, prev_kid, bp_lid, has_prev, has_prev2, paren_head, last_close, last_bang, &mut scratch, 1);
        if scratch.len() == before { break; }
        let t = &scratch[scratch.len() - 1];
        let hd = if t.lid == _LID_LPAREN && !paren_head.is_empty() { paren_head[paren_head.len() - 1] } else { false };
        out.push(AlignMeta { kind: tok_kind(t), off: t.off as usize, end: t.end as usize, nl: t.nl, fd: 0, pd: paren_head.len() as i64, lc: last_close, lb: last_bang, hd, td: 0 });
        relexed += 1;
        if (t.off as usize) >= edit_end {
            if let Some(o_idx) = find_tok_at_off(old_toks, (t.off as isize - delta) as usize) {
                let o = &old_toks[o_idx];
                let new_prev_text = if out.len() > 1 { let p = &out[out.len() - 2]; &new_text[p.off..p.end] } else { "" };
                let old_prev_text = if o_idx >= 1 { let p = &old_toks[o_idx - 1]; &old_text[p.off..p.end] } else { "" };
                let bp_ok = new_prev_text == old_prev_text;
                let old_stack = reconstruct_parens(old_toks, old_text, o_idx as isize);
                if o.pd == paren_head.len() as i64 && paren_stacks_eq(&old_stack, &paren_head) && o.lc == last_close && o.lb == last_bang && bp_ok && o.kind == tok_kind(t) && o.end == (t.end as isize - delta) as usize && o.nl == t.nl && old_text[o.off..o.end] == new_text[t.off as usize..t.end as usize] {
                    for ot in &old_toks[o_idx + 1..] {
                        out.push(AlignMeta { kind: ot.kind, off: (ot.off as isize + delta) as usize, end: (ot.end as isize + delta) as usize, nl: ot.nl, fd: ot.fd, pd: ot.pd, lc: ot.lc, lb: ot.lb, hd: ot.hd, td: ot.td });
                    }
                    return (out, relexed);
                }
            }
        }
    }
    (out, relexed)
}
` : rxTpl ? `${findTokAtOff}${reconstructParens}
fn window_relex_step(old_text: &str, old_toks: &[AlignMeta], new_text: &str, start: usize, end: usize, ins: &str) -> (Vec<AlignMeta>, usize) {
    let delta = ins.len() as isize - (end - start) as isize;
    let edit_end = start + ins.len();
${tplAnchor}
    let mut scan_off: usize;
    let mut pending_nl = false;
    let mut prev_lid: u16 = 0;
    let mut prev_kid: u16 = 0;
    let mut bp_lid: u16 = 0;
    let mut has_prev = false;
    let mut has_prev2 = false;
    let mut paren_head: Vec<bool> = Vec::new();
    let mut last_close = false;
    let mut last_bang = false;
    let mut template_stack: Vec<i64> = Vec::new();
    if rb >= 0 {
        let anchor = &old_toks[rb as usize];
        scan_off = anchor.end;
        prev_lid = lid_of(&old_text[anchor.off..anchor.end]);
        prev_kid = kid_of(anchor.kind);
        has_prev = true;
        if rb >= 1 {
            let p = &old_toks[(rb - 1) as usize];
            bp_lid = lid_of(&old_text[p.off..p.end]);
            has_prev2 = true;
        }
        last_close = anchor.lc;
        last_bang = anchor.lb;
        paren_head = reconstruct_parens(old_toks, old_text, rb);
    } else {
        scan_off = 0;
    }
    let mut scratch: Vec<Tok> = Vec::new();
    let mut relexed = 0usize;
    while scan_off < new_text.len() {
        let before = scratch.len();
        let r = lex_from(new_text, scan_off, pending_nl, prev_lid, prev_kid, bp_lid, has_prev, has_prev2, paren_head, last_close, last_bang, template_stack, &mut scratch, 1);
        scan_off = r.0; pending_nl = r.1; prev_lid = r.2; prev_kid = r.3; bp_lid = r.4; has_prev = r.5; has_prev2 = r.6; paren_head = r.7; last_close = r.8; last_bang = r.9; template_stack = r.10;
        if scratch.len() == before { break; }
        let t = &scratch[scratch.len() - 1];
        let hd = if t.lid == _LID_LPAREN && !paren_head.is_empty() { paren_head[paren_head.len() - 1] } else { false };
        out.push(AlignMeta { kind: tok_kind(t), off: t.off as usize, end: t.end as usize, nl: t.nl, fd: 0, pd: paren_head.len() as i64, lc: last_close, lb: last_bang, hd, td: template_stack.len() as i64 });
        relexed += 1;
        if (t.off as usize) >= edit_end {
            if let Some(o_idx) = find_tok_at_off(old_toks, (t.off as isize - delta) as usize) {
                let o = &old_toks[o_idx];
                let new_prev = if out.len() > 1 { &new_text[out[out.len()-2].off..out[out.len()-2].end] } else { "" };
                let old_prev = if o_idx >= 1 { &old_text[old_toks[o_idx-1].off..old_toks[o_idx-1].end] } else { "" };
                let old_stack = reconstruct_parens(old_toks, old_text, o_idx as isize);
                if o.td == 0 && template_stack.is_empty() && o.pd == paren_head.len() as i64 && paren_stacks_eq(&old_stack, &paren_head) && o.lc == last_close && o.lb == last_bang && new_prev == old_prev && o.kind == tok_kind(t) && o.end == (t.end as isize - delta) as usize && o.nl == t.nl && old_text[o.off..o.end] == new_text[t.off as usize..t.end as usize] {
${adoptSuffix}
                    return (out, relexed);
                }
            }
        }
    }
    (out, relexed)
}
` : tplOnly ? `${findTokAtOff}
fn window_relex_step(old_text: &str, old_toks: &[AlignMeta], new_text: &str, start: usize, end: usize, ins: &str) -> (Vec<AlignMeta>, usize) {
    let delta = ins.len() as isize - (end - start) as isize;
    let edit_end = start + ins.len();
${tplAnchor}
    let mut scan_off = if rb >= 0 { old_toks[rb as usize].end } else { 0 };
    let mut pending_nl = false;
    let mut template_stack: Vec<i64> = Vec::new();
    let mut scratch: Vec<Tok> = Vec::new();
    let mut relexed = 0usize;
    while scan_off < new_text.len() {
        let before = scratch.len();
        let r = lex_from(new_text, scan_off, pending_nl, template_stack, &mut scratch, 1);
        scan_off = r.0; pending_nl = r.1; template_stack = r.2;
        if scratch.len() == before { break; }
        let t = &scratch[scratch.len() - 1];
        out.push(AlignMeta { kind: tok_kind(t), off: t.off as usize, end: t.end as usize, nl: t.nl, fd: 0, pd: 0, lc: false, lb: false, hd: false, td: template_stack.len() as i64 });
        relexed += 1;
        if (t.off as usize) >= edit_end {
            if let Some(o_idx) = find_tok_at_off(old_toks, (t.off as isize - delta) as usize) {
                let o = &old_toks[o_idx];
                if o.td == 0 && template_stack.is_empty() && o.kind == tok_kind(t) && o.end == (t.end as isize - delta) as usize && o.nl == t.nl && old_text[o.off..o.end] == new_text[t.off as usize..t.end as usize] {
${adoptSuffix}
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
    let mut scratch: Vec<Tok> = Vec::new();
    let mut relexed = 0usize;
    while scan_off < new_text.len() {
        let before = scratch.len();
        (scan_off, pending_nl) = lex_from(new_text, scan_off, pending_nl, &mut scratch, 1);
        if scratch.len() == before { break; }
        let t = &scratch[scratch.len() - 1];
        out.push(AlignMeta { kind: tok_kind(t), off: t.off as usize, end: t.end as usize, nl: t.nl, fd: 0, pd: 0, lc: false, lb: false, hd: false, td: 0 });
        relexed += 1;
        if (t.off as usize) >= edit_end {
            if let Some(o_idx) = find_tok_at_off(old_toks, (t.off as isize - delta) as usize) {
                let o = &old_toks[o_idx];
                if o.kind == tok_kind(t) && o.end == (t.end as isize - delta) as usize && o.nl == t.nl && old_text[o.off..o.end] == new_text[t.off as usize..t.end as usize] {
                    for ot in &old_toks[o_idx + 1..] {
                        out.push(AlignMeta { kind: ot.kind, off: (ot.off as isize + delta) as usize, end: (ot.end as isize + delta) as usize, nl: ot.nl, fd: ot.fd, pd: ot.pd, lc: ot.lc, lb: ot.lb, hd: ot.hd, td: ot.td });
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
    let mut toks: Vec<Tok> = Vec::new();
    let mut meta: Vec<AlignMeta> = Vec::new();
    let (mut pos, mut pending_nl, mut line_start, mut emitted_content, mut flow_depth) = (0usize, false, true, false, 0i64);
    while pos < src.len() {
        let before = toks.len();
        (pos, pending_nl, line_start, emitted_content, flow_depth) = lex_from(src, pos, pending_nl, line_start, emitted_content, flow_depth, &mut toks, 1);
        if toks.len() == before { break; }
        let t = &toks[toks.len() - 1];
        meta.push(AlignMeta { kind: tok_kind(t), off: t.off as usize, end: t.end as usize, nl: t.nl, fd: flow_depth, pd: 0, lc: false, lb: false, hd: false, td: 0 });
    }
    meta
}
fn to_meta(_toks: &[Tok]) -> Vec<AlignMeta> { panic!("use scan_meta for newline") }
` : rxOnly ? `
fn scan_meta(src: &str) -> Vec<AlignMeta> {
    let mut toks: Vec<Tok> = Vec::new();
    let mut meta: Vec<AlignMeta> = Vec::new();
    let (mut pos, mut pending_nl) = (0usize, false);
    let (mut prev_lid, mut prev_kid, mut bp_lid) = (0u16, 0u16, 0u16);
    let (mut has_prev, mut has_prev2) = (false, false);
    let mut paren_head: Vec<bool> = Vec::new();
    let (mut last_close, mut last_bang) = (false, false);
    while pos < src.len() {
        let before = toks.len();
        (pos, pending_nl, prev_lid, prev_kid, bp_lid, has_prev, has_prev2, paren_head, last_close, last_bang) = lex_from(src, pos, pending_nl, prev_lid, prev_kid, bp_lid, has_prev, has_prev2, paren_head, last_close, last_bang, &mut toks, 1);
        if toks.len() == before { break; }
        let t = &toks[toks.len() - 1];
        let hd = if t.lid == _LID_LPAREN && !paren_head.is_empty() { paren_head[paren_head.len() - 1] } else { false };
        meta.push(AlignMeta { kind: tok_kind(t), off: t.off as usize, end: t.end as usize, nl: t.nl, fd: 0, pd: paren_head.len() as i64, lc: last_close, lb: last_bang, hd, td: 0 });
    }
    meta
}
fn to_meta(_toks: &[Tok]) -> Vec<AlignMeta> { panic!("use scan_meta for regex") }
` : rxTpl ? `
fn scan_meta(src: &str) -> Vec<AlignMeta> {
    let mut toks: Vec<Tok> = Vec::new();
    let mut meta: Vec<AlignMeta> = Vec::new();
    let mut pos = 0usize;
    let mut pending_nl = false;
    let mut prev_lid: u16 = 0;
    let mut prev_kid: u16 = 0;
    let mut bp_lid: u16 = 0;
    let mut has_prev = false;
    let mut has_prev2 = false;
    let mut paren_head: Vec<bool> = Vec::new();
    let mut last_close = false;
    let mut last_bang = false;
    let mut template_stack: Vec<i64> = Vec::new();
    while pos < src.len() {
        let before = toks.len();
        let r = lex_from(src, pos, pending_nl, prev_lid, prev_kid, bp_lid, has_prev, has_prev2, paren_head, last_close, last_bang, template_stack, &mut toks, 1);
        pos = r.0; pending_nl = r.1; prev_lid = r.2; prev_kid = r.3; bp_lid = r.4; has_prev = r.5; has_prev2 = r.6; paren_head = r.7; last_close = r.8; last_bang = r.9; template_stack = r.10;
        if toks.len() == before { break; }
        let t = &toks[toks.len() - 1];
        let hd = if t.lid == _LID_LPAREN && !paren_head.is_empty() { paren_head[paren_head.len() - 1] } else { false };
        meta.push(AlignMeta { kind: tok_kind(t), off: t.off as usize, end: t.end as usize, nl: t.nl, fd: 0, pd: paren_head.len() as i64, lc: last_close, lb: last_bang, hd, td: template_stack.len() as i64 });
    }
    meta
}
fn to_meta(_toks: &[Tok]) -> Vec<AlignMeta> { panic!("use scan_meta for rx+tpl") }
` : tplOnly ? `
fn scan_meta(src: &str) -> Vec<AlignMeta> {
    let mut toks: Vec<Tok> = Vec::new();
    let mut meta: Vec<AlignMeta> = Vec::new();
    let mut pos = 0usize;
    let mut pending_nl = false;
    let mut template_stack: Vec<i64> = Vec::new();
    while pos < src.len() {
        let before = toks.len();
        let r = lex_from(src, pos, pending_nl, template_stack, &mut toks, 1);
        pos = r.0; pending_nl = r.1; template_stack = r.2;
        if toks.len() == before { break; }
        let t = &toks[toks.len() - 1];
        meta.push(AlignMeta { kind: tok_kind(t), off: t.off as usize, end: t.end as usize, nl: t.nl, fd: 0, pd: 0, lc: false, lb: false, hd: false, td: template_stack.len() as i64 });
    }
    meta
}
fn to_meta(_toks: &[Tok]) -> Vec<AlignMeta> { panic!("use scan_meta for tpl") }
` : `fn to_meta(toks: &[Tok]) -> Vec<AlignMeta> {
    toks.iter().map(|t| AlignMeta { kind: tok_kind(t), off: t.off as usize, end: t.end as usize, nl: t.nl, fd: 0, pd: 0, lc: false, lb: false, hd: false, td: 0 }).collect()
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
` : (rxTpl || tplOnly) ? `
fn check_stream_eq(text: &str, meta: &[AlignMeta]) -> bool {
    let fresh = scan_meta(text);
    if fresh.len() != meta.len() { return false; }
    for (f, m) in fresh.iter().zip(meta.iter()) {
        if f.kind != m.kind || f.off != m.off || f.end != m.end || f.nl != m.nl || f.td != m.td${rxTpl ? ' || f.pd != m.pd || f.lc != m.lc || f.lb != m.lb || f.hd != m.hd' : ''} { return false; }
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
  const initToks = (hasNewline || rxOnly || tplOnly || rxTpl) ? 'scan_meta(&text)' : 'to_meta(&lex(&text))';
  const reuseShared = topReuse ? `
fn count_live(nodes: &[Node], kids: &[i32], id: i32) -> usize {
    let mut n = 1usize;
    let nd = &nodes[id as usize];
    for i in 0..nd.kid_count {
        let cid = kids[nd.kid_start as usize + i as usize];
        if cid >= 0 { n += count_live(nodes, kids, cid); }
    }
    n
}
fn should_reclaim(nodes: &[Node], kids: &[i32], root: i32, baseline: usize) -> bool {
    if root < 0 || baseline == 0 { return false; }
    let live = count_live(nodes, kids, root);
    let lim = baseline.max(live);
    nodes.len() > ARENA_COMPACT_K * lim
}
fn shift_subtree(nodes: &mut [Node], kids: &mut [i32], id: i32, byte_delta: isize, tok_delta: isize) {
    assert!(id >= 0);
    {
        let nd = &mut nodes[id as usize];
        nd.offset = (nd.offset as isize + byte_delta) as u32;
        nd.end = (nd.end as isize + byte_delta) as u32;
        nd.tok_start = (nd.tok_start as isize + tok_delta) as u32;
        nd.tok_end = (nd.tok_end as isize + tok_delta) as u32;
        nd.ext = (nd.ext as isize + tok_delta) as u32;
    }
    let (ks, kc) = { let nd = &nodes[id as usize]; (nd.kid_start, nd.kid_count) };
    for i in 0..kc {
        let slot = ks as usize + i as usize;
        let cid = kids[slot];
        if cid < 0 {
            let (ti, tt) = decode_leaf(cid);
            let nti = (ti as isize + tok_delta) as u32;
            kids[slot] = encode_leaf(nti, tt);
        } else {
            shift_subtree(nodes, kids, cid, byte_delta, tok_delta);
        }
    }
}
#[inline(always)]
fn shift_entry_meta(m: &mut EntryMeta, byte_delta: isize, tok_delta: isize) {
    m.tok_start = (m.tok_start as isize + tok_delta) as u32;
    m.tok_end = (m.tok_end as isize + tok_delta) as u32;
    m.ext = (m.ext as isize + tok_delta) as u32;
    m.off = (m.off as isize + byte_delta) as u32;
    m.end = (m.end as isize + byte_delta) as u32;
}
fn assert_entries_vs_nodes(entries: &[EntryMeta], nodes: &[Node], kids: &[i32], old_root: i32) {
    let old = &nodes[old_root as usize];
    assert_eq!(entries.len(), old.kid_count as usize, "entry count vs root kids");
    for i in 0..entries.len() {
        let kid = kids[old.kid_start as usize + i];
        assert!(kid >= 0, "entry {} expected rule node kid", i);
        let nd = &nodes[kid as usize];
        let e = &entries[i];
        assert_eq!(e.tok_start, nd.tok_start, "tok_start entry {}", i);
        assert_eq!(e.tok_end, nd.tok_end, "tok_end entry {}", i);
        assert_eq!(e.ext, nd.ext, "ext entry {}", i);
        assert_eq!(e.off, nd.offset, "off entry {}", i);
        assert_eq!(e.end, nd.end, "end entry {}", i);
    }
}
` : '';
  const reuseFnsA = shapeA ? `${reuseShared}impl<'a> Parser<'a> {
    fn finish_reuse(&mut self, rule_id: u16, prefix_kids: &[i32], mid: &[i32], suffix_cand: &[i32], prefix_meta: &[EntryMeta], mid_meta: &[EntryMeta], suffix_meta: &[EntryMeta], adopt_from: usize, byte_delta: isize, tok_delta: isize, new_n: usize) -> (i32, usize) {
        let adopted = &suffix_cand[adopt_from..];
        for &s in adopted { shift_subtree(&mut self.b.nodes, &mut self.b.kids, s, byte_delta, tok_delta); }
        let mut children: Vec<i32> = Vec::with_capacity(prefix_kids.len() + mid.len() + adopted.len());
        children.extend_from_slice(prefix_kids);
        children.extend_from_slice(mid);
        children.extend_from_slice(adopted);
        let mut new_entries: Vec<EntryMeta> = Vec::with_capacity(prefix_meta.len() + mid_meta.len() + suffix_meta.len().saturating_sub(adopt_from));
        new_entries.extend_from_slice(prefix_meta);
        new_entries.extend_from_slice(mid_meta);
        for m in &suffix_meta[adopt_from..] {
            let mut em = *m;
            shift_entry_meta(&mut em, byte_delta, tok_delta);
            new_entries.push(em);
        }
        let (off, end, tok_start, tok_end) = if new_entries.is_empty() {
            (0u32, 0u32, 0u32, 0u32)
        } else {
            let first = &new_entries[0];
            let last = new_entries.last().unwrap();
            (first.off, last.end, first.tok_start, last.tok_end)
        };
        let kid_start = self.b.kids.len();
        self.b.kids.extend_from_slice(&children);
        self.b.nodes.push(Node { rule_id, kid_start: kid_start as u32, kid_count: children.len() as u32, offset: off, end, tok_start, tok_end, ext: 0 });
        self.entries = new_entries;
        self.pos = new_n;
        ((self.b.nodes.len() - 1) as i32, prefix_kids.len() + adopted.len())
    }
    fn try_reuse_top(&mut self, old_root: i32, old_entries: &[EntryMeta], byte_delta: isize, old_n: usize, new_n: usize, prefix: usize, suffix: usize, validate: bool) -> Option<(i32, usize)> {
        if old_root < 0 { return None; }
        if validate { assert_entries_vs_nodes(old_entries, &self.b.nodes, &self.b.kids, old_root); }
        let old = self.b.nodes[old_root as usize];
        let old_kids: Vec<i32> = (0..old.kid_count).map(|i| self.b.kids[old.kid_start as usize + i as usize]).collect();
        let mut prefix_len = 0usize;
        while prefix_len < old_entries.len() {
            if old_entries[prefix_len].ext <= prefix as u32 { prefix_len += 1; } else { break; }
        }
        let mut suffix_start = old_entries.len();
        let mut i = old_entries.len();
        while i > prefix_len {
            i -= 1;
            if old_entries[i].tok_start as usize >= old_n - suffix { suffix_start = i; } else { break; }
        }
        let prefix_kids = old_kids[..prefix_len].to_vec();
        let suffix_cand = old_kids[suffix_start..].to_vec();
        let prefix_meta = &old_entries[..prefix_len];
        let suffix_meta = &old_entries[suffix_start..];
        let tok_delta = new_n as isize - old_n as isize;
        self.pos = if prefix_len > 0 { prefix_meta[prefix_len - 1].tok_end as usize } else { 0 };
        self.scratch.clear();
        let mut mid: Vec<i32> = Vec::new();
        let mut mid_meta: Vec<EntryMeta> = Vec::new();
        let suffix_bound = new_n - suffix;
        let mut max_cand: isize = -1;
        for m in suffix_meta {
            let c = m.tok_start as isize + tok_delta;
            if c > max_cand { max_cand = c; }
        }
        let rule_id = old.rule_id;
        let try_hit = |p: &mut Parser<'a>, mid: &[i32], mid_meta: &[EntryMeta]| -> Option<(i32, usize)> {
            if p.pos < suffix_bound { return None; }
            if suffix_cand.is_empty() {
                if p.pos == new_n { return Some(p.finish_reuse(rule_id, &prefix_kids, mid, &suffix_cand, prefix_meta, mid_meta, suffix_meta, 0, byte_delta, tok_delta, new_n)); }
                return None;
            }
            for (hi, m) in suffix_meta.iter().enumerate() {
                if m.tok_start as isize + tok_delta == p.pos as isize {
                    return Some(p.finish_reuse(rule_id, &prefix_kids, mid, &suffix_cand, prefix_meta, mid_meta, suffix_meta, hi, byte_delta, tok_delta, new_n));
                }
            }
            None
        };
        if let Some(hit) = try_hit(self, &mid, &mid_meta) { return Some(hit); }
        if !suffix_cand.is_empty() && max_cand >= 0 && (self.pos as isize) > max_cand { return None; }
        loop {
            if self.pos >= self.toks.len() {
                if suffix_cand.is_empty() && self.pos == new_n {
                    return Some(self.finish_reuse(rule_id, &prefix_kids, &mid, &suffix_cand, prefix_meta, &mid_meta, suffix_meta, 0, byte_delta, tok_delta, new_n));
                }
                return try_hit(self, &mid, &mid_meta);
            }
            self.max_look = 0;
            let sp = self.pos;
            let fr = match self.parse_top_one() { Some(fr) => fr, None => { self.pos = sp; return None; } };
            if !fr.present { self.pos = sp; return None; }
            let em = self.b.entry_meta(fr.h, self.max_look as u32, &self.toks);
            mid_meta.push(em);
            mid.push(fr.h);
            if let Some(hit) = try_hit(self, &mid, &mid_meta) { return Some(hit); }
            if !suffix_cand.is_empty() && max_cand >= 0 && (self.pos as isize) > max_cand { return None; }
        }
    }
}
` : '';
  const reuseFnsB = shapeB ? `${reuseShared}fn assert_entries_vs_segs(entries: &[EntryMeta], segs: &[Seg], nodes: &[Node], kids: &[i32], old_root: i32) {
    assert_eq!(entries.len(), segs.len(), "entry count vs segs");
    let old = &nodes[old_root as usize];
    for i in 0..entries.len() {
        let e = &entries[i];
        let s = &segs[i];
        assert_eq!(e.tok_start as usize, s.tok_start, "tok_start entry {}", i);
        assert_eq!(e.tok_end as usize, s.tok_end, "tok_end entry {}", i);
        assert_eq!(e.ext as usize, s.ext, "ext entry {}", i);
        assert_eq!(e.kid_start as usize, s.kid_start, "kid_start entry {}", i);
        assert_eq!(e.kid_count as usize, s.kid_count, "kid_count entry {}", i);
        // off/end vs rule-node kids only — leaf endpoints need the old tok stream, which
        // the edit Parser no longer holds (self.toks is the new stream).
        let first = kids[old.kid_start as usize + s.kid_start];
        let last = kids[old.kid_start as usize + s.kid_start + s.kid_count - 1];
        if first >= 0 {
            assert_eq!(e.off, nodes[first as usize].offset, "off entry {}", i);
        }
        if last >= 0 {
            assert_eq!(e.end, nodes[last as usize].end, "end entry {}", i);
        }
    }
}
impl<'a> Parser<'a> {
    fn finish_reuse_seg(&mut self, rule_id: u16, prefix_segs: &[Seg], prefix_kids: &[i32], mid_segs: &[Seg], mid_kids: &[i32], suffix_cand: &[Seg], prefix_meta: &[EntryMeta], mid_meta: &[EntryMeta], suffix_meta: &[EntryMeta], old_kid_start: u32, adopt_from: usize, byte_delta: isize, tok_delta: isize, new_n: usize) -> (i32, usize) {
        let adopted_segs = &suffix_cand[adopt_from..];
        let mut adopted_kids: Vec<i32> = Vec::new();
        for s in adopted_segs {
            for i in 0..s.kid_count {
                let id = self.b.kids[old_kid_start as usize + s.kid_start + i];
                if id < 0 {
                    let (ti, tt) = decode_leaf(id);
                    let nti = (ti as isize + tok_delta) as u32;
                    adopted_kids.push(encode_leaf(nti, tt));
                } else {
                    shift_subtree(&mut self.b.nodes, &mut self.b.kids, id, byte_delta, tok_delta);
                    adopted_kids.push(id);
                }
            }
        }
        let mut children: Vec<i32> = Vec::with_capacity(prefix_kids.len() + mid_kids.len() + adopted_kids.len());
        children.extend_from_slice(prefix_kids);
        children.extend_from_slice(mid_kids);
        children.extend_from_slice(&adopted_kids);
        let mut new_segs: Vec<Seg> = Vec::with_capacity(prefix_segs.len() + mid_segs.len() + adopted_segs.len());
        let mut new_entries: Vec<EntryMeta> = Vec::with_capacity(prefix_meta.len() + mid_meta.len() + suffix_meta.len().saturating_sub(adopt_from));
        let mut k_off = 0usize;
        for (s, m) in prefix_segs.iter().zip(prefix_meta.iter()) {
            new_segs.push(Seg { kid_start: k_off, kid_count: s.kid_count, tok_start: s.tok_start, tok_end: s.tok_end, ext: s.ext });
            let mut em = *m;
            em.kid_start = k_off as u32;
            new_entries.push(em);
            k_off += s.kid_count;
        }
        for (s, m) in mid_segs.iter().zip(mid_meta.iter()) {
            new_segs.push(Seg { kid_start: k_off, kid_count: s.kid_count, tok_start: s.tok_start, tok_end: s.tok_end, ext: s.ext });
            let mut em = *m;
            em.kid_start = k_off as u32;
            new_entries.push(em);
            k_off += s.kid_count;
        }
        for (s, m) in adopted_segs.iter().zip(suffix_meta[adopt_from..].iter()) {
            new_segs.push(Seg { kid_start: k_off, kid_count: s.kid_count, tok_start: (s.tok_start as isize + tok_delta) as usize, tok_end: (s.tok_end as isize + tok_delta) as usize, ext: (s.ext as isize + tok_delta) as usize });
            let mut em = *m;
            shift_entry_meta(&mut em, byte_delta, tok_delta);
            em.kid_start = k_off as u32;
            new_entries.push(em);
            k_off += s.kid_count;
        }
        let (off, end, tok_start, tok_end) = if new_entries.is_empty() {
            (0u32, 0u32, 0u32, 0u32)
        } else {
            let first = &new_entries[0];
            let last = new_entries.last().unwrap();
            (first.off, last.end, first.tok_start, last.tok_end)
        };
        let kid_start = self.b.kids.len();
        self.b.kids.extend_from_slice(&children);
        self.b.nodes.push(Node { rule_id, kid_start: kid_start as u32, kid_count: children.len() as u32, offset: off, end, tok_start, tok_end, ext: 0 });
        self.segs = new_segs;
        self.entries = new_entries;
        self.pos = new_n;
        ((self.b.nodes.len() - 1) as i32, prefix_segs.len() + adopted_segs.len())
    }
    fn try_reuse_seg(&mut self, old_root: i32, old_segs: &[Seg], old_entries: &[EntryMeta], byte_delta: isize, old_n: usize, new_n: usize, prefix: usize, suffix: usize, validate: bool) -> Option<(i32, usize)> {
        if old_root < 0 || old_segs.is_empty() { return None; }
        if validate { assert_entries_vs_segs(old_entries, old_segs, &self.b.nodes, &self.b.kids, old_root); }
        let old = self.b.nodes[old_root as usize];
        let mut prefix_len = 0usize;
        while prefix_len < old_entries.len() {
            if old_entries[prefix_len].ext as usize <= prefix { prefix_len += 1; } else { break; }
        }
        let mut suffix_start = old_entries.len();
        let mut i = old_entries.len();
        while i > prefix_len {
            i -= 1;
            if old_entries[i].tok_start as usize >= old_n - suffix { suffix_start = i; } else { break; }
        }
        let prefix_segs = &old_segs[..prefix_len];
        let suffix_cand = &old_segs[suffix_start..];
        let prefix_meta = &old_entries[..prefix_len];
        let suffix_meta = &old_entries[suffix_start..];
        let mut prefix_kids: Vec<i32> = Vec::new();
        for s in prefix_segs {
            for j in 0..s.kid_count {
                prefix_kids.push(self.b.kids[old.kid_start as usize + s.kid_start + j]);
            }
        }
        let tok_delta = new_n as isize - old_n as isize;
        self.pos = if prefix_len > 0 { prefix_meta[prefix_len - 1].tok_end as usize } else { 0 };
        self.scratch.clear();
        let mut mid_kids: Vec<i32> = Vec::new();
        let mut mid_segs: Vec<Seg> = Vec::new();
        let mut mid_meta: Vec<EntryMeta> = Vec::new();
        let suffix_bound = new_n - suffix;
        let mut max_cand: isize = -1;
        for m in suffix_meta {
            let c = m.tok_start as isize + tok_delta;
            if c > max_cand { max_cand = c; }
        }
        let rule_id = old.rule_id;
        let old_kid_start = old.kid_start;
        let try_hit = |p: &mut Parser<'a>, mid_kids: &[i32], mid_segs: &[Seg], mid_meta: &[EntryMeta]| -> Option<(i32, usize)> {
            if p.pos < suffix_bound { return None; }
            if suffix_cand.is_empty() {
                if p.pos == new_n { return Some(p.finish_reuse_seg(rule_id, prefix_segs, &prefix_kids, mid_segs, mid_kids, suffix_cand, prefix_meta, mid_meta, suffix_meta, old_kid_start, 0, byte_delta, tok_delta, new_n)); }
                return None;
            }
            for (hi, m) in suffix_meta.iter().enumerate() {
                if m.tok_start as isize + tok_delta == p.pos as isize {
                    return Some(p.finish_reuse_seg(rule_id, prefix_segs, &prefix_kids, mid_segs, mid_kids, suffix_cand, prefix_meta, mid_meta, suffix_meta, old_kid_start, hi, byte_delta, tok_delta, new_n));
                }
            }
            None
        };
        if let Some(hit) = try_hit(self, &mid_kids, &mid_segs, &mid_meta) { return Some(hit); }
        if !suffix_cand.is_empty() && max_cand >= 0 && (self.pos as isize) > max_cand { return None; }
        ${hasHeadB ? `if prefix_len == 0 {
            let sb = self.scratch.len();
            if let Some((mut h, mut m)) = self.parse_head_seg(sb) {
                h.kid_start = 0;
                m.kid_start = 0;
                mid_kids.extend_from_slice(&self.scratch[sb..]);
                self.scratch.truncate(sb);
                mid_segs.push(h);
                mid_meta.push(m);
                if let Some(hit) = try_hit(self, &mid_kids, &mid_segs, &mid_meta) { return Some(hit); }
                if !suffix_cand.is_empty() && max_cand >= 0 && (self.pos as isize) > max_cand { return None; }
            }
        }
        ` : ''}loop {
            if self.pos >= self.toks.len() {
                if suffix_cand.is_empty() && self.pos == new_n {
                    return Some(self.finish_reuse_seg(rule_id, prefix_segs, &prefix_kids, &mid_segs, &mid_kids, suffix_cand, prefix_meta, &mid_meta, suffix_meta, old_kid_start, 0, byte_delta, tok_delta, new_n));
                }
                return try_hit(self, &mid_kids, &mid_segs, &mid_meta);
            }
            let sb = self.scratch.len();
            let (seg, meta) = match self.parse_loop_seg(sb) {
                Some(pair) => pair,
                None => {
                    if suffix_cand.is_empty() && self.pos == new_n {
                        return Some(self.finish_reuse_seg(rule_id, prefix_segs, &prefix_kids, &mid_segs, &mid_kids, suffix_cand, prefix_meta, &mid_meta, suffix_meta, old_kid_start, 0, byte_delta, tok_delta, new_n));
                    }
                    return try_hit(self, &mid_kids, &mid_segs, &mid_meta);
                }
            };
            let count = self.scratch.len() - sb;
            mid_kids.extend_from_slice(&self.scratch[sb..]);
            self.scratch.truncate(sb);
            mid_segs.push(Seg { kid_start: 0, kid_count: count, tok_start: seg.tok_start, tok_end: seg.tok_end, ext: seg.ext });
            mid_meta.push(EntryMeta { kid_start: 0, kid_count: count as u32, tok_start: meta.tok_start, tok_end: meta.tok_end, ext: meta.ext, off: meta.off, end: meta.end });
            if let Some(hit) = try_hit(self, &mid_kids, &mid_segs, &mid_meta) { return Some(hit); }
            if !suffix_cand.is_empty() && max_cand >= 0 && (self.pos as isize) > max_cand { return None; }
        }
    }
}
` : '';
  const reuseFns = reuseFnsA || reuseFnsB;
  const treeEqFn = `
fn cmp_kid(nodes_a: &[Node], kids_a: &[i32], toks_a: &[Tok], kid_a: i32, nodes_b: &[Node], kids_b: &[i32], toks_b: &[Tok], kid_b: i32) -> bool {
    if (kid_a < 0) != (kid_b < 0) { return false; }
    if kid_a < 0 {
        let (ti_a, tt_a) = decode_leaf(kid_a);
        let (ti_b, tt_b) = decode_leaf(kid_b);
        if tt_a != tt_b { return false; }
        let ta = &toks_a[ti_a as usize];
        let tb = &toks_b[ti_b as usize];
        ta.off == tb.off && ta.end == tb.end
    } else {
        let na = &nodes_a[kid_a as usize];
        let nb = &nodes_b[kid_b as usize];
        if na.rule_id != nb.rule_id || na.kid_count != nb.kid_count || na.offset != nb.offset || na.end != nb.end { return false; }
        for i in 0..na.kid_count {
            let ca = kids_a[na.kid_start as usize + i as usize];
            let cb = kids_b[nb.kid_start as usize + i as usize];
            if !cmp_kid(nodes_a, kids_a, toks_a, ca, nodes_b, kids_b, toks_b, cb) { return false; }
        }
        true
    }
}
fn check_tree_eq(text: &str, nodes: &[Node], kids: &[i32], root: Option<i32>) -> bool {
    let root_ok = root.is_some();
    let toks_a = tokenize(text).toks;
    let s1 = if let Some(r) = root {
        let mut b = String::new();
        write_json_arena(nodes, kids, &toks_a, r, &mut b);
        b
    } else { String::new() };
    let fresh = parse(tokenize(text));
    match (root_ok, fresh) {
        (false, None) => true,
        (true, Some((p, fr))) => {
            if !cmp_kid(nodes, kids, &toks_a, root.unwrap(), &p.b.nodes, &p.b.kids, &p.toks, fr) { return false; }
            let mut b2 = String::new();
            write_json(&p, fr, &mut b2);
            s1 == b2
        }
        _ => false,
    }
}
`;
  const editParseA = shapeA
    ? `        let byte_delta = self.text.len() as isize - old_text.len() as isize;
        let mut reused = 0usize;
        let force_fresh = self.root.is_none() || should_reclaim(&self.nodes, &self.kids, self.root.unwrap_or(-1), self.baseline);
        let text = self.text.clone();
        let meta = self.toks.clone();
        if !force_fresh {
            let nodes = std::mem::take(&mut self.nodes);
            let kids = std::mem::take(&mut self.kids);
            let scratch = std::mem::take(&mut self.scratch);
            let old_entries = std::mem::take(&mut self.entries);
            let old_root = self.root.unwrap();
            let mut p = Parser { toks: toks_from_meta(&text, &meta), pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: CstBuilder { nodes, kids }, scratch, entries: Vec::new() };
            if let Some((root, n)) = p.try_reuse_top(old_root, &old_entries, byte_delta, old_n, new_n, prefix, suffix, self.validate) {
                self.root = Some(root);
                reused = n;
                self.last_pos = p.pos;
                self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch; self.entries = p.entries;
            } else {
                let ntoks = toks_from_meta(&text, &meta);
                let nlen = ntoks.len();
                let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: CstBuilder::default(), scratch: Vec::new(), entries: Vec::new() };
                match p.parse_${ir.entry}() {
                    Some(fr) if p.pos == nlen && fr.present => {
                        self.root = Some(fr.h); self.baseline = p.b.nodes.len(); self.last_pos = p.pos;
                        self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch; self.entries = p.entries; reused = 0;
                    }
                    _ => {
                        self.root = None; self.baseline = p.b.nodes.len(); self.last_pos = p.pos;
                        self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch; self.entries = p.entries; reused = 0;
                    }
                }
            }
        } else {
            let ntoks = toks_from_meta(&text, &meta);
            let nlen = ntoks.len();
            let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: CstBuilder::default(), scratch: Vec::new(), entries: Vec::new() };
            match p.parse_${ir.entry}() {
                Some(fr) if p.pos == nlen && fr.present => {
                    self.root = Some(fr.h); self.baseline = p.b.nodes.len(); self.last_pos = p.pos;
                    self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch; self.entries = p.entries;
                }
                _ => {
                    self.root = None; self.baseline = p.b.nodes.len(); self.last_pos = p.pos;
                    self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch; self.entries = p.entries;
                }
            }
            reused = 0;
        }
        let stream_eq = if self.validate { Some(check_stream_eq(&self.text, &self.toks)) } else { None };
        let tree_eq = if self.validate { Some(check_tree_eq(&self.text, &self.nodes, &self.kids, self.root)) } else { None };
        self.align = Some(Align { old_n, new_n, prefix, suffix, relexed, reused, stream_eq, tree_eq });`
    : '';
  const editParseB = shapeB
    ? `        let byte_delta = self.text.len() as isize - old_text.len() as isize;
        let mut reused = 0usize;
        let force_fresh = self.root.is_none() || should_reclaim(&self.nodes, &self.kids, self.root.unwrap_or(-1), self.baseline);
        let text = self.text.clone();
        let meta = self.toks.clone();
        if !force_fresh {
            let nodes = std::mem::take(&mut self.nodes);
            let kids = std::mem::take(&mut self.kids);
            let scratch = std::mem::take(&mut self.scratch);
            let old_segs = std::mem::take(&mut self.segs);
            let old_entries = std::mem::take(&mut self.entries);
            let old_root = self.root.unwrap();
            let mut p = Parser { toks: toks_from_meta(&text, &meta), pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: CstBuilder { nodes, kids }, scratch, entries: Vec::new(), segs: Vec::new() };
            if let Some((root, n)) = p.try_reuse_seg(old_root, &old_segs, &old_entries, byte_delta, old_n, new_n, prefix, suffix, self.validate) {
                self.root = Some(root);
                reused = n;
                self.last_pos = p.pos;
                self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch; self.segs = p.segs; self.entries = p.entries;
            } else {
                let ntoks = toks_from_meta(&text, &meta);
                let nlen = ntoks.len();
                let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: CstBuilder::default(), scratch: Vec::new(), entries: Vec::new(), segs: Vec::new() };
                match p.parse_${ir.entry}() {
                    Some(fr) if p.pos == nlen && fr.present => {
                        self.root = Some(fr.h); self.baseline = p.b.nodes.len(); self.last_pos = p.pos;
                        self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch; self.segs = p.segs; self.entries = p.entries; reused = 0;
                    }
                    _ => {
                        self.root = None; self.baseline = p.b.nodes.len(); self.last_pos = p.pos;
                        self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch; self.segs = p.segs; self.entries = p.entries; reused = 0;
                    }
                }
            }
        } else {
            let ntoks = toks_from_meta(&text, &meta);
            let nlen = ntoks.len();
            let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: CstBuilder::default(), scratch: Vec::new(), entries: Vec::new(), segs: Vec::new() };
            match p.parse_${ir.entry}() {
                Some(fr) if p.pos == nlen && fr.present => {
                    self.root = Some(fr.h); self.baseline = p.b.nodes.len(); self.last_pos = p.pos;
                    self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch; self.segs = p.segs; self.entries = p.entries;
                }
                _ => {
                    self.root = None; self.baseline = p.b.nodes.len(); self.last_pos = p.pos;
                    self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch; self.segs = p.segs; self.entries = p.entries;
                }
            }
            reused = 0;
        }
        let stream_eq = if self.validate { Some(check_stream_eq(&self.text, &self.toks)) } else { None };
        let tree_eq = if self.validate { Some(check_tree_eq(&self.text, &self.nodes, &self.kids, self.root)) } else { None };
        self.align = Some(Align { old_n, new_n, prefix, suffix, relexed, reused, stream_eq, tree_eq });`
    : '';
  const editParse = shapeA
    ? editParseA
    : shapeB
    ? editParseB
    : `        let text = self.text.clone();
        let meta = self.toks.clone();
        let ntoks = toks_from_meta(&text, &meta);
        let nlen = ntoks.len();
        let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: CstBuilder::default(), scratch: Vec::new()${reuseInit} };
        match p.parse_${ir.entry}() {
            Some(fr) if p.pos == nlen && fr.present => {
                self.root = Some(fr.h); self.baseline = p.b.nodes.len(); self.last_pos = p.pos;
                self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch;${reuseMove}
            }
            _ => {
                self.root = None; self.baseline = p.b.nodes.len(); self.last_pos = p.pos;
                self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch;${reuseMove}
            }
        }
        let reused = 0usize;
        let stream_eq = if self.validate { Some(check_stream_eq(&self.text, &self.toks)) } else { None };
        let tree_eq = if self.validate { Some(check_tree_eq(&self.text, &self.nodes, &self.kids, self.root)) } else { None };
        self.align = Some(Align { old_n, new_n, prefix, suffix, relexed, reused, stream_eq, tree_eq });`;
  const docSegField = shapeB ? '\n    segs: Vec<Seg>,' : '';
  const docEntriesField = topReuse ? '\n    entries: Vec<EntryMeta>,' : '';
  const docSegInit = shapeB ? ', segs: Vec::new()' : '';
  const docEntriesInit = topReuse ? ', entries: Vec::new()' : '';
  const docExtraField = `${docEntriesField}${docSegField}`;
  const docExtraInit = `${docEntriesInit}${docSegInit}`;
  return `pub struct Edit { pub start: usize, pub end: usize, pub text: String }
#[derive(Clone)]
struct AlignMeta { kind: &'static str, off: usize, end: usize, nl: bool, fd: i64, pd: i64, lc: bool, lb: bool, hd: bool, td: i64 }
struct Align { old_n: usize, new_n: usize, prefix: usize, suffix: usize, relexed: usize, reused: usize, stream_eq: Option<bool>, tree_eq: Option<bool> }
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
fn toks_from_meta(text: &str, meta: &[AlignMeta]) -> Vec<Tok> {
    meta.iter().map(|m| { let tx = &text[m.off..m.end]; mk_tok(m.off, m.end, m.nl, kid_of(m.kind), lid_of(tx)) }).collect()
}
${checkStreamEqFn}${treeEqFn}${windowHelpers}${reuseFns}pub struct Doc {
    text: String,
    toks: Vec<AlignMeta>,
    align: Option<Align>,
    validate: bool,
    nodes: Vec<Node>,
    kids: Vec<i32>,
    scratch: Vec<i32>,${docExtraField}
    root: Option<i32>,
    baseline: usize,
    last_pos: usize,
}
impl Doc {
    pub fn new(text: String) -> Doc {
        let toks = ${initToks};
        let mut d = Doc { text, toks, align: None, validate: false, nodes: Vec::new(), kids: Vec::new(), scratch: Vec::new()${docExtraInit}, root: None, baseline: 0, last_pos: 0 };
        d.reparse_fresh();
        d
    }
    fn reparse_fresh(&mut self) {
        let text = self.text.clone();
        let meta = self.toks.clone();
        let ntoks = toks_from_meta(&text, &meta);
        let nlen = ntoks.len();
        let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: CstBuilder::default(), scratch: Vec::new()${reuseInit} };
        match p.parse_${ir.entry}() {
            Some(fr) if p.pos == nlen && fr.present => {
                self.root = Some(fr.h); self.baseline = p.b.nodes.len(); self.last_pos = p.pos;
                self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch;${reuseMove}
            }
            _ => {
                self.root = None; self.baseline = p.b.nodes.len(); self.last_pos = p.pos;
                self.nodes = p.b.nodes; self.kids = p.b.kids; self.scratch = p.scratch;${reuseMove}
            }
        }
    }
    pub fn set_validate(&mut self, v: bool) { self.validate = v; }
    pub fn text(&self) -> &str { &self.text }
    pub fn alignment(&self) -> Option<&Align> { self.align.as_ref() }
    pub fn cst_json(&self) -> Option<String> {
        let root = self.root?;
        if self.last_pos != self.toks.len() { return None; }
        let toks = toks_from_meta(&self.text, &self.toks);
        let mut out = String::new();
        write_json_arena(&self.nodes, &self.kids, &toks, root, &mut out);
        Some(out)
    }
    pub fn edit(&mut self, edits: &[Edit]) {
        let old_text = self.text.clone();
        let old_toks = self.toks.clone();
        let mut relexed = 0usize;
${editBody}
        let (old_n, new_n, prefix, suffix) = compute_align_core(&old_text, &old_toks, &self.text, &self.toks);
${editParse}
    }
    pub fn parse(&self) -> Option<(Parser<'_>, i32)> {
        // Fresh independent parse (does not touch Doc arena) — used by non-edit callers.
        let toks = toks_from_meta(&self.text, &self.toks);
        let n = toks.len();
        let mut p = Parser { toks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &self.text, b: CstBuilder::default(), scratch: Vec::new()${reuseInit} };
        match p.parse_${ir.entry}() {
            Some(fr) if p.pos == n && fr.present => Some((p, fr.h)),
            _ => None,
        }
    }
}`;
}




/** Emit Builder trait, CstBuilder/SlimBuilder, sole Parser machine, and parse_with helpers. */
function emitParserMachine(ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan, shapeB: boolean): string {
  const reuse = topReusePlan(ir);
  const entriesField = reuse ? '\n    entries: Vec<EntryMeta>,' : '';
  const segsField = shapeB ? '\n    segs: Vec<Seg>,' : '';
  const ruleFns = ir.rules.map((r) => {
    if (r.kind === 'pratt') return prattRule(r, ir.tpl, ids, ar);
    if (reuse && r.name === ir.entry) return rdEntryWithReuse(r, reuse, ids, ar);
    return rdRule(r, ids, ar);
  }).join('\n\n');
  const matchTemplate = ir.tpl ? `    fn match_template(&mut self) -> Option<Spanned<B::H>> {
        let t = self.peek()?;
        if t.kid != ${kidOf(ids, "$templateHead")} { return None; }
        let save = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
        self.push_leaf(${ttIdOf(ar, '$templateHead')}, self.pos as u32, t.off, t.end); self.pos += 1;
        loop {
            let expr = match self.parse_${ir.tpl.interpRule}() { Some(e) => e, None => { self.pos = save; self.scratch.truncate(sb); self.b.restore(ck); return None; } };
            if expr.present { self.scratch.push(expr.h); }
            let next = match self.peek() { Some(x) => x, None => { self.pos = save; self.scratch.truncate(sb); self.b.restore(ck); return None; } };
            if next.kid == ${kidOf(ids, "$templateMiddle")} { self.push_leaf(${ttIdOf(ar, '$templateMiddle')}, self.pos as u32, next.off, next.end); self.pos += 1; continue; }
            if next.kid == ${kidOf(ids, "$templateTail")} { self.push_leaf(${ttIdOf(ar, '$templateTail')}, self.pos as u32, next.off, next.end); self.pos += 1; break; }
            self.pos = save; self.scratch.truncate(sb); self.b.restore(ck); return None;
        }
        Some(self.finish(${ruleIdOf(ar, '$template')}, sb, self.off_at(save), save))
    }
` : '';

  const dropTtIds = ['$punct', '$keyword', '$operator']
    .map((n) => {
      try { return ttIdOf(ar, n); } catch { return null; }
    })
    .filter((x): x is number => x !== null);
  const punctId = TT_SKIP_PUNCT;
  const slimDropMatch = dropTtIds.length
    ? dropTtIds.map((id) => `${id}`).join(' | ')
    : 'u16::MAX';

  return `// ─── Builder API ─────────────────────────────────────────────────────────────
// Builder is pure / bottom-up. Backtracking truncates scratch (+ optional arena
// checkpoint); discarded handles are garbage. H: Copy (arena i32) — owning
// builders that need cleanup on truncate must self-manage.
pub trait Builder {
    type H: Copy;
    fn leaf(&mut self, scratch: &mut Vec<Self::H>, tt_id: u16, tok_idx: u32, off: u32, end: u32) -> bool;
    /// Consume scratch[sb..] → 0..=n handles; return (primary H, off, present).
    /// Default: span_of + node (drop/splice via leftover scratch count). CstBuilder overrides
    /// with an arena \`finish\` twin so monomorphization matches native parse.
    #[inline(always)]
    fn finish(
        &mut self, scratch: &mut Vec<Self::H>, sb: usize, rule_id: u16,
        fallback_off: u32, tok_start: u32, tok_end: u32, toks: &[Tok],
    ) -> (Self::H, u32, bool) {
        let nn = scratch.len();
        let (offset, end) = if nn > sb {
            let (o0, _) = self.span_of(scratch[sb], toks);
            let (_, e1) = self.span_of(scratch[nn - 1], toks);
            (o0, e1)
        } else {
            (fallback_off, fallback_off)
        };
        self.node(scratch, sb, rule_id, offset, end, tok_start, tok_end);
        let n = scratch.len() - sb;
        if n == 1 {
            (scratch.pop().unwrap(), offset, true)
        } else if n == 0 {
            (Self::dummy_h(), offset, false)
        } else {
            let h = scratch[sb];
            scratch.truncate(sb);
            (h, offset, true)
        }
    }
    fn node(&mut self, scratch: &mut Vec<Self::H>, sb: usize, rule_id: u16, off: u32, end: u32, tok_start: u32, tok_end: u32);
    fn span_of(&self, h: Self::H, toks: &[Tok]) -> (u32, u32);
    fn head_span(&self, h: Self::H, toks: &[Tok]) -> (u32, u32);
    /// Arena builders: (nodes.len(), kids.len()). Default no-op for pure builders.
    #[inline(always)] fn checkpoint(&self) -> (usize, usize) { (0, 0) }
    #[inline(always)] fn restore(&mut self, _ck: (usize, usize)) {}
    fn dummy_h() -> Self::H;
    /// Record lookahead watermark on a finished kid (shape-A reuse). Default no-op.
    #[inline(always)] fn note_look(&mut self, _h: Self::H, _max_look: u32) {}
    /// Build EntryMeta for an entry handle; CstBuilder also stamps Node.ext (note_look fused).
    #[inline(always)]
    fn entry_meta(&mut self, h: Self::H, max_look: u32, toks: &[Tok]) -> EntryMeta {
        let (tok_start, tok_end) = self.tok_range(h);
        let mut ext = tok_end;
        if max_look > ext { ext = max_look; }
        let (off, end) = self.span_of(h, toks);
        EntryMeta { tok_start, tok_end, ext, off, end, kid_start: 0, kid_count: 1 }
    }
    /// Token span of handle h (leaf encoding or rule node).
    fn tok_range(&self, h: Self::H) -> (u32, u32);
}

/// Parser-side span+handle frame. Span fields are independent of H (Pratt never reads H for spans).
#[derive(Clone, Copy)]
struct Spanned<H: Copy> { h: H, off: u32, tok_start: u32, present: bool }

#[derive(Default)]
pub struct CstBuilder {
    pub nodes: Vec<Node>,
    pub kids: Vec<i32>,
}
impl CstBuilder {
    pub fn new() -> Self { Self::default() }
}
impl Builder for CstBuilder {
    type H = i32;
    #[inline(always)]
    fn dummy_h() -> i32 { 0 }
    #[inline(always)]
    fn checkpoint(&self) -> (usize, usize) { (self.nodes.len(), self.kids.len()) }
    #[inline(always)]
    fn restore(&mut self, ck: (usize, usize)) { self.nodes.truncate(ck.0); self.kids.truncate(ck.1); }
    #[inline(always)]
    fn leaf(&mut self, scratch: &mut Vec<i32>, tt_id: u16, tok_idx: u32, _off: u32, _end: u32) -> bool {
        if tt_id == ${punctId} { return false; }
        scratch.push(encode_leaf(tok_idx, tt_id as u8));
        true
    }
    /// Byte-twin of Parser::finish (arena path): compute span, extend kids, push node, return id.
    #[inline(always)]
    fn finish(
        &mut self, scratch: &mut Vec<i32>, sb: usize, rule_id: u16,
        fallback_off: u32, tok_start: u32, tok_end: u32, toks: &[Tok],
    ) -> (i32, u32, bool) {
        let nn = scratch.len();
        let kid_start = self.kids.len();
        let (offset, end) = if nn > sb {
            let (o0, _) = Self::kid_off_end(&self.nodes, toks, scratch[sb]);
            let (_, e1) = Self::kid_off_end(&self.nodes, toks, scratch[nn - 1]);
            (o0, e1)
        } else {
            (fallback_off, fallback_off)
        };
        self.kids.extend(scratch[sb..nn].iter().copied());
        scratch.truncate(sb);
        self.nodes.push(Node { rule_id, kid_start: kid_start as u32, kid_count: (nn - sb) as u32, offset, end, tok_start, tok_end, ext: 0 });
        ((self.nodes.len() - 1) as i32, offset, true)
    }
    #[inline(always)]
    fn node(&mut self, scratch: &mut Vec<i32>, sb: usize, rule_id: u16, off: u32, end: u32, tok_start: u32, tok_end: u32) {
        let nn = scratch.len();
        let kid_start = self.kids.len();
        self.kids.extend(scratch[sb..nn].iter().copied());
        scratch.truncate(sb);
        self.nodes.push(Node { rule_id, kid_start: kid_start as u32, kid_count: (nn - sb) as u32, offset: off, end, tok_start, tok_end, ext: 0 });
        scratch.push((self.nodes.len() - 1) as i32);
    }
    #[inline(always)]
    fn span_of(&self, h: i32, toks: &[Tok]) -> (u32, u32) {
        Self::kid_off_end(&self.nodes, toks, h)
    }
    #[inline(always)]
    fn head_span(&self, h: i32, toks: &[Tok]) -> (u32, u32) {
        let mut id = h;
        loop {
            if id < 0 { let (ti, _) = decode_leaf(id); let t = &toks[ti as usize]; return (t.off, t.end); }
            let nd = &self.nodes[id as usize];
            if nd.kid_count == 0 { return (nd.offset, nd.end); }
            id = self.kids[nd.kid_start as usize];
        }
    }
    #[inline(always)]
    fn note_look(&mut self, h: i32, max_look: u32) {
        if h >= 0 {
            let nd = &mut self.nodes[h as usize];
            let mut ext = nd.tok_end;
            if max_look > ext { ext = max_look; }
            nd.ext = ext;
        }
    }
    #[inline(always)]
    fn entry_meta(&mut self, h: i32, max_look: u32, toks: &[Tok]) -> EntryMeta {
        if h < 0 {
            let (ti, _) = decode_leaf(h);
            let t = &toks[ti as usize];
            let tok_end = ti + 1;
            let mut ext = tok_end;
            if max_look > ext { ext = max_look; }
            EntryMeta { tok_start: ti, tok_end, ext, off: t.off, end: t.end, kid_start: 0, kid_count: 1 }
        } else {
            let nd = &mut self.nodes[h as usize];
            let mut ext = nd.tok_end;
            if max_look > ext { ext = max_look; }
            nd.ext = ext;
            EntryMeta { tok_start: nd.tok_start, tok_end: nd.tok_end, ext, off: nd.offset, end: nd.end, kid_start: 0, kid_count: 1 }
        }
    }
    #[inline(always)]
    fn tok_range(&self, h: i32) -> (u32, u32) {
        if h < 0 { let (ti, _) = decode_leaf(h); (ti, ti + 1) }
        else { let nd = &self.nodes[h as usize]; (nd.tok_start, nd.tok_end) }
    }
}
impl CstBuilder {
    #[inline(always)]
    fn kid_off_end(nodes: &[Node], toks: &[Tok], kid: i32) -> (u32, u32) {
        if kid < 0 { let (ti, _) = decode_leaf(kid); let t = &toks[ti as usize]; (t.off, t.end) }
        else { let nd = &nodes[kid as usize]; (nd.offset, nd.end) }
    }
}

#[derive(Default)]
pub struct SlimBuilder {
    pub nodes: Vec<Node>,
    pub kids: Vec<i32>,
}
impl SlimBuilder {
    pub fn new() -> Self { Self::default() }
}
impl Builder for SlimBuilder {
    type H = i32;
    #[inline(always)]
    fn dummy_h() -> i32 { 0 }
    #[inline(always)]
    fn checkpoint(&self) -> (usize, usize) { (self.nodes.len(), self.kids.len()) }
    #[inline(always)]
    fn restore(&mut self, ck: (usize, usize)) { self.nodes.truncate(ck.0); self.kids.truncate(ck.1); }
    #[inline(always)]
    fn leaf(&mut self, scratch: &mut Vec<i32>, tt_id: u16, tok_idx: u32, _off: u32, _end: u32) -> bool {
        match tt_id { ${slimDropMatch} => return false, _ => {} }
        if tt_id == ${punctId} { return false; }
        scratch.push(encode_leaf(tok_idx, tt_id as u8));
        true
    }
    #[inline(always)]
    fn node(&mut self, scratch: &mut Vec<i32>, sb: usize, rule_id: u16, off: u32, end: u32, tok_start: u32, tok_end: u32) {
        let nn = scratch.len();
        let count = nn - sb;
        if count == 1 { return; }
        if count == 0 { scratch.truncate(sb); return; }
        let kid_start = self.kids.len();
        self.kids.extend(scratch[sb..nn].iter().copied());
        scratch.truncate(sb);
        self.nodes.push(Node { rule_id, kid_start: kid_start as u32, kid_count: count as u32, offset: off, end, tok_start, tok_end, ext: 0 });
        scratch.push((self.nodes.len() - 1) as i32);
    }
    #[inline(always)]
    fn span_of(&self, h: i32, toks: &[Tok]) -> (u32, u32) {
        if h < 0 { let (ti, _) = decode_leaf(h); let t = &toks[ti as usize]; (t.off, t.end) }
        else { let nd = &self.nodes[h as usize]; (nd.offset, nd.end) }
    }
    #[inline(always)]
    fn head_span(&self, h: i32, toks: &[Tok]) -> (u32, u32) {
        let mut id = h;
        loop {
            if id < 0 { let (ti, _) = decode_leaf(id); let t = &toks[ti as usize]; return (t.off, t.end); }
            let nd = &self.nodes[id as usize];
            if nd.kid_count == 0 { return (nd.offset, nd.end); }
            id = self.kids[nd.kid_start as usize];
        }
    }
    #[inline(always)]
    fn tok_range(&self, h: i32) -> (u32, u32) {
        if h < 0 { let (ti, _) = decode_leaf(h); (ti, ti + 1) }
        else { let nd = &self.nodes[h as usize]; (nd.tok_start, nd.tok_end) }
    }
}

struct Parser<'a, B: Builder = CstBuilder> {
    toks: Vec<Tok>,
    pos: usize,
    max_look: usize,
    capped: bool,
    suppress_next: Vec<u16>,
    suppress_cur: Vec<u16>,
    src: &'a str,
    b: B,
    scratch: Vec<B::H>,${entriesField}${segsField}
}

impl<'a, B: Builder> Parser<'a, B> {
    #[inline(always)]
    fn peek(&mut self) -> Option<Tok> {
        if self.pos + 1 > self.max_look { self.max_look = self.pos + 1; }
        if self.pos < self.toks.len() { Some(self.toks[self.pos]) } else { None }
    }
    #[inline(always)]
    fn off_at(&self, i: usize) -> usize { if i < self.toks.len() { self.toks[i].off as usize } else { 0 } }
    #[inline(always)]
    fn push_leaf(&mut self, tt_id: u16, tok_idx: u32, off: u32, end: u32) {
        let _ = self.b.leaf(&mut self.scratch, tt_id, tok_idx, off, end);
    }
    #[inline(always)]
    fn finish(&mut self, rule_id: u16, sb: usize, fallback_off: usize, tok_start: usize) -> Spanned<B::H> {
        let (h, off, present) = self.b.finish(
            &mut self.scratch, sb, rule_id, fallback_off as u32, tok_start as u32, self.pos as u32, &self.toks,
        );
        Spanned { h, off, tok_start: tok_start as u32, present }
    }
    #[inline(always)]
    fn head_leaf_text(&self, f: &Spanned<B::H>) -> &'a str {
        if !f.present { return ""; }
        let (a, b) = self.b.head_span(f.h, &self.toks);
        let a = a as usize; let b = b as usize;
        if a <= b && b <= self.src.len() { &self.src[a..b] } else { "" }
    }
    #[inline(always)]
    fn nll_blocked(&self, words: &[&str], left: &Spanned<B::H>) -> bool {
        let h = self.head_leaf_text(left); words.iter().any(|w| *w == h)
    }
    #[inline(always)]
    fn match_lit(&mut self, lid: u16, tt_id: u16) -> bool {
        match self.peek() {
            Some(t) if t.lid == lid => { self.push_leaf(tt_id, self.pos as u32, t.off, t.end); self.pos += 1; true }
            _ => false
        }
    }
    #[inline(always)]
    fn match_tok(&mut self, kid: u16, tt_id: u16) -> bool {
        match self.peek() {
            Some(t) if t.kid == kid => { self.push_leaf(tt_id, self.pos as u32, t.off, t.end); self.pos += 1; true }
            _ => false
        }
    }
    #[inline(always)]
    fn call_rule(&mut self, f: fn(&mut Parser<'a, B>) -> Option<Spanned<B::H>>) -> bool {
        match f(self) {
            Some(fr) => { if fr.present { self.scratch.push(fr.h); } true }
            None => false
        }
    }
    #[inline(always)]
    fn star(&mut self, once: fn(&mut Parser<'a, B>) -> bool) -> bool {
        loop {
            let sp = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
            if !once(self) { self.pos = sp; self.scratch.truncate(sb); self.b.restore(ck); break; }
        }
        true
    }
    #[inline(always)]
    fn opt(&mut self, body: fn(&mut Parser<'a, B>) -> bool) -> bool {
        let sp = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
        if !body(self) { self.pos = sp; self.scratch.truncate(sb); self.b.restore(ck); }
        true
    }
    #[inline(always)]
    fn sep_by(&mut self, elem: fn(&mut Parser<'a, B>) -> bool, delim: u16) -> bool {
        if !elem(self) { return true; }
        loop {
            let sp = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
            if !self.match_lit(delim, ${punctId}) { self.pos = sp; self.scratch.truncate(sb); self.b.restore(ck); break; }
            if !elem(self) { break; }
        }
        true
    }
    #[inline(always)]
    fn alt_lit(&mut self, opts: &[(u16, u16)]) -> bool {
        for (lid, tt) in opts { if self.match_lit(*lid, *tt) { return true; } }
        false
    }

${matchTemplate}${ruleFns}
}
`;
}

function emitParseWithHelpers(ir: ParserIR, shapeB: boolean): string {
  const reuse = !!topReusePlan(ir);
  const reuseInit = `${reuse ? ', entries: Vec::new()' : ''}${shapeB ? ', segs: Vec::new()' : ''}`;
  return `
pub fn parse_with<'a, B: Builder + Default>(src: &'a str, b: &mut B) -> Option<B::H> {
    let toks = lex(src);
    let n = toks.len();
    let owned = std::mem::take(b);
    let mut p = Parser { toks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src, b: owned, scratch: Vec::new()${reuseInit} };
    let root = match p.parse_${ir.entry}() {
        Some(fr) if p.pos == n && fr.present => Some(fr.h),
        _ => None,
    };
    *b = p.b;
    root
}

pub fn cst_json_with(b: &CstBuilder, toks: &[Tok], root: i32) -> String {
    let mut out = String::new();
    write_json_arena(&b.nodes, &b.kids, toks, root, &mut out);
    out
}

pub fn slim_json_with(b: &SlimBuilder, toks: &[Tok], root: i32) -> String {
    let mut out = String::new();
    write_json_arena(&b.nodes, &b.kids, toks, root, &mut out);
    out
}
`;
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
#[repr(C)]
#[derive(Clone, Copy)]
struct Tok { off: u32, end: u32, kid: u16, lid: u16, nl: bool }
const _: () = assert!(std::mem::size_of::<Tok>() == 16);

${lexer(portableIR(grammar))}

pub struct RichTok<'a> { pub kind: &'static str, pub text: &'a str, pub off: usize, pub end: usize, pub nl: bool, pub kid: u16, pub lid: u16 }
pub fn tokenize<'a>(src: &'a str) -> Vec<RichTok<'a>> {
    lex(src).into_iter().map(|t| RichTok { kind: tok_kind(&t), text: tok_text(src, &t), off: t.off as usize, end: t.end as usize, nl: t.nl, kid: t.kid, lid: t.lid }).collect()
}
`;
  },

  emitParser(grammar: CstGrammar, lexerSrc: string | null): string {
    const ir = portableIR(grammar);
    const ids = buildLexIdPlan(ir);
    const ar = buildArenaIdPlan(ir, ids);
    const reuse = topReusePlan(ir);
    const shapeB = reuse?.kind === 'B';
    const reuseInit = `${reuse ? ', entries: Vec::new()' : ''}${shapeB ? ', segs: Vec::new()' : ''}`;
    // EntryMeta is always emitted — Builder::entry_meta returns it (even when the side table is unused).
    const entryMetaStruct = `\n#[derive(Clone, Copy)]\nstruct EntryMeta { tok_start: u32, tok_end: u32, ext: u32, off: u32, end: u32, kid_start: u32, kid_count: u32 }\n`;
    const segStruct = shapeB
      ? `\n#[derive(Clone, Copy)]\nstruct Seg { kid_start: usize, kid_count: usize, tok_start: usize, tok_end: usize, ext: usize }\n`
      : '';
    const arenaIdTables = renderArenaIdTablesRust(ar);
    return `// GENERATED by emit-portable.ts (rustTarget) — parser for grammar "${ir.grammarName}".
#![allow(non_snake_case)]
use std::io::Read;

// Slim hot-path token (16B): kind/text reconstructed via KIND_STR / src[off..end].
#[repr(C)]
#[derive(Clone, Copy)]
struct Tok { off: u32, end: u32, kid: u16, lid: u16, nl: bool }
const _: () = assert!(std::mem::size_of::<Tok>() == 16);

// Arena node: a flat record in \`nodes\`; children are a contiguous range in \`kids\`.
// Rule nodes only — leaf kids are negative i32 encodings in \`kids\` / \`scratch\`.
#[repr(C)]
#[derive(Clone, Copy)]
struct Node { rule_id: u16, kid_start: u32, kid_count: u32, offset: u32, end: u32, tok_start: u32, tok_end: u32, ext: u32 }
const _: () = assert!(std::mem::size_of::<Node>() == 32);
${entryMetaStruct}${segStruct}
${lexerSrc ?? ''}

${arenaIdTables}
const ARENA_COMPACT_K: usize = 4;

#[inline]
fn encode_leaf(tok_idx: u32, tt_id: u8) -> i32 {
    debug_assert!(tok_idx < (1u32 << 25));
    debug_assert!((tt_id as u32) < 64);
    let packed = tok_idx | ((tt_id as u32) << 25);
    !(packed as i32)
}
#[inline]
fn decode_leaf(v: i32) -> (u32, u8) {
    debug_assert!(v < 0);
    let packed = (!v) as u32;
    (packed & ((1u32 << 25) - 1), (packed >> 25) as u8)
}

${emitParserMachine(ir, ids, ar, shapeB)}

fn write_json_kid(nodes: &[Node], kids: &[i32], toks: &[Tok], kid: i32, out: &mut String) {
    if kid < 0 {
        let (ti, tt) = decode_leaf(kid);
        let t = &toks[ti as usize];
        out.push_str(&format!("{{\\"tokenType\\":\\"{}\\",\\"offset\\":{},\\"end\\":{}}}", TT_NAMES[tt as usize], t.off, t.end));
        return;
    }
    write_json_arena(nodes, kids, toks, kid, out);
}
fn write_json_arena(nodes: &[Node], kids: &[i32], toks: &[Tok], id: i32, out: &mut String) {
    let nd = &nodes[id as usize];
    out.push_str(&format!("{{\\"rule\\":\\"{}\\",\\"children\\":[", RULE_NAMES[nd.rule_id as usize]));
    for i in 0..nd.kid_count {
        if i > 0 { out.push(','); }
        write_json_kid(nodes, kids, toks, kids[nd.kid_start as usize + i as usize], out);
    }
    out.push_str(&format!("],\\"offset\\":{},\\"end\\":{}}}", nd.offset, nd.end));
}
fn write_json(p: &Parser<'_>, id: i32, out: &mut String) {
    write_json_arena(&p.b.nodes, &p.b.kids, &p.toks, id, out);
}

// Library entry, two composable phases. tokenize() lexes ONCE and returns a Tokens struct that
// carries the source slice (head-leaf lookups need it — Rust keeps no globals). Pass it to
// parse(). The arena (nodes/kids) lives in the returned Parser so the caller can serialize
// (write_json) or inspect it. Just the CST? parse(tokenize(src)).
struct Tokens<'a> { src: &'a str, toks: Vec<Tok> }
fn tokenize<'a>(src: &'a str) -> Tokens<'a> { Tokens { src, toks: lex(src) } }
fn parse<'a>(tokens: Tokens<'a>) -> Option<(Parser<'a>, i32)> {
    let n = tokens.toks.len();
    let mut p = Parser { toks: tokens.toks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: tokens.src, b: CstBuilder::default(), scratch: Vec::new()${reuseInit} };
    match p.parse_${ir.entry}() {
        Some(fr) if p.pos == n && fr.present => Some((p, fr.h)),
        _ => None,
    }
}

${docEditBlockRust(ir)}
${emitParseWithHelpers(ir, shapeB)}
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
            // Decode UTF-8 properly: byte-as-char Latin-1 corrupted multi-byte (e.g. é → Ã©)
            // and made edit offsets disagree with go/ts JSON parsers.
            c if c < 0x80 => { out.push(c as char); i += 1; }
            _ => {
                let w = match s[i] { 0xC0..=0xDF => 2, 0xE0..=0xEF => 3, 0xF0..=0xF7 => 4, _ => return None };
                if i + w > s.len() { return None; }
                let ch = std::str::from_utf8(&s[i..i + w]).ok()?.chars().next()?;
                out.push(ch); i += w;
            }
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
    if args.len() > 1 && (args[1] == "edit-session" || args[1] == "edit-session-fast") {
        let (init, batches) = parse_edit_session(&src).unwrap();
        let mut doc = Doc::new(init);
        if args[1] == "edit-session" { doc.set_validate(true); }
        for batch in &batches {
            let edits: Vec<Edit> = batch.iter().map(|&(s, e, ref t)| Edit { start: s, end: e, text: t.clone() }).collect();
            doc.edit(&edits);
        }
        if let Some(a) = doc.alignment() {
            match (a.stream_eq, a.tree_eq) {
                (Some(eq), Some(te)) => eprintln!("{{\\"oldN\\":{},\\"newN\\":{},\\"prefix\\":{},\\"suffix\\":{},\\"relexed\\":{},\\"reused\\":{},\\"streamEq\\":{},\\"treeEq\\":{}}}", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.reused, eq, te),
                (Some(eq), None) => eprintln!("{{\\"oldN\\":{},\\"newN\\":{},\\"prefix\\":{},\\"suffix\\":{},\\"relexed\\":{},\\"reused\\":{},\\"streamEq\\":{}}}", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.reused, eq),
                (None, Some(te)) => eprintln!("{{\\"oldN\\":{},\\"newN\\":{},\\"prefix\\":{},\\"suffix\\":{},\\"relexed\\":{},\\"reused\\":{},\\"treeEq\\":{}}}", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.reused, te),
                (None, None) => eprintln!("{{\\"oldN\\":{},\\"newN\\":{},\\"prefix\\":{},\\"suffix\\":{},\\"relexed\\":{},\\"reused\\":{}}}", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.reused),
            }
        }
        match doc.cst_json() {
            Some(out) => print!("{}", out),
            None => { eprintln!("parse error"); std::process::exit(1); }
        }
        return;
    }
    // Self-bench: a numeric arg N times the lex+parse loop and prints ms/iteration.
    if let Some(iters) = args.get(1).and_then(|a| a.parse::<u64>().ok()) {
        for _ in 0..3 { let s = std::hint::black_box(&src); if let Some((p, r)) = parse(tokenize(s)) { std::hint::black_box((&p.b.nodes[r as usize], p.pos)); } }
        let t = std::time::Instant::now();
        for _ in 0..iters { let s = std::hint::black_box(&src); if let Some((p, r)) = parse(tokenize(s)) { std::hint::black_box((&p.b.nodes[r as usize], p.pos)); } }
        println!("{:.4}", t.elapsed().as_secs_f64() * 1000.0 / iters as f64);
        return;
    }
    if args.get(1).map(|a| a.as_str()) == Some("tok-spans") {
        match parse(tokenize(&src)) {
            Some((p, root)) => {
                let nd = &p.b.nodes[root as usize];
                for i in 0..nd.kid_count {
                    let kv = p.b.kids[nd.kid_start as usize + i as usize];
                    if kv < 0 {
                        let (ti, tt) = decode_leaf(kv);
                        println!("{}\t{}\t{}", TT_NAMES[tt as usize], ti, ti + 1);
                    } else {
                        let k = &p.b.nodes[kv as usize];
                        println!("{}\t{}\t{}", RULE_NAMES[k.rule_id as usize], k.tok_start, k.tok_end);
                    }
                }
                println!("total\t0\t{}", p.pos);
            }
            None => { eprintln!("parse error"); std::process::exit(1); }
        }
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
