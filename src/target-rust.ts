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
import type {
  ShapeSpec, ShapeIR, ShapeIRRule, RuleShape, NodeShape, ChoiceShape, FieldDecl,
  FieldBind, TokenLeafPolicy, CustomShape, ParentFold, StreamType, PrattShape, RuleShapeAtom,
} from './shape-schema.ts';
import { validateShapeOrThrow } from './shape-validate.ts';

export type { ShapeSpec, ShapeIR } from './shape-schema.ts';

const J = (v: unknown) => JSON.stringify(v);
const rangeCond = (v: string, rs: CharRange[]) =>
  '(' + rs.map(([lo, hi]) => (lo === hi ? `${v} == ${lo}` : `(${lo}..=${hi}).contains(&${v})`)).join(' || ') + ')';

/** `starts_with` on a single ASCII byte collapses to a direct byte compare (no slice/bounds). */
const startByteEq = (posExpr: string, s: string): string => {
  if (s.length === 1) {
    const c = s.charCodeAt(0);
    if (c < 128) return `b[${posExpr}] == ${c}`;
  }
  return `src[${posExpr}..].starts_with(${J(s)})`;
};

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

function scanTok(t: LexTok, defs: string[], stateful: boolean, ids: LexIdPlan, rxTok: string | undefined, tplTok: string | undefined, identLike: Set<string>): string {
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
  // Identifier(-prefixed) token: fold a trailing non-ASCII ID_Continue run into the match
  // (caf|é → café), mirroring the interpreter's uniIdentContReY extension (gen-lexer.ts).
  const ext = (v: string) => (identLike.has(name) ? `let ${v} = if ${v} < b.len() && b[${v}] >= 0x80 { _lx_ext(b, ${v}) } else { ${v} }; ` : '');
  if (t.kind === 'run') return `        if ${gate}${rangeCond('c', t.first)} {
            let mut e = pos + 1;
            while e < n { let cc = b[e] as u32; if !${rangeCond('cc', t.cont)} { break } e += 1; }
            ${ext('e')}${push('e')}pos = e; continue;
        }`;
  if (t.kind === 'runBail') {
    if (rangesHaveNonAscii(t.cont)) {
      const m = compilePat(t.pattern, defs);
      return `        if ${gate}true { let e = ${m}(src, pos as i64); if e > pos as i64 { let e = e as usize; ${ext('e')}${push('e')}pos = e; continue; } }`;
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
            if e >= n || !(${bailAt('b[e] as u32')}) { ${ext('e')}${push('e')}pos = e; continue; }
            { let e2 = ${m}(src, pos as i64); if e2 > pos as i64 { let e2 = e2 as usize; ${ext('e2')}${push('e2')}pos = e2; continue; } }
        } else if ${entryBail} {
            let e = ${m}(src, pos as i64); if e > pos as i64 { let e = e as usize; ${ext('e')}${push('e')}pos = e; continue; }
        }`;
  }
  if (t.kind === 'string') return `        if ${gate}c == ${t.delim.charCodeAt(0)} {
            let mut e = pos + 1;
            let mut closed = false;
            while e < n { let ch = b[e] as u32; if ch == 92 { e += 2; continue } if ch == ${t.delim.charCodeAt(0)} { e += 1; closed = true; break } e += 1; }
            if closed { ${push('e')}pos = e; continue; }
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
            if e < n { e += ${t.close.length}; ${push('e')}pos = e; continue; }
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
  const identLike = new Set(ir.identLike);
  const codes: string[] = [];
  const firsts: (LexFirstBytes | null)[] = [];
  for (const t of ir.tokens) {
    const code = scanTok(t, defs, stateful, ids, rxTok, tplTok, identLike);
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
function renderLexByteDispatchRust(codes: string[], firsts: (LexFirstBytes | null)[], indent: string, specialAsciiArms: string, nonAsciiWsCheck: string): string {
  const { arms, fallbackIndices } = buildLexDispatchPlan(firsts);
  const fallback = fallbackIndices.map((i) => codes[i]).join('\n');
  let matchArms = specialAsciiArms;
  for (const arm of arms) {
    matchArms += `${indent}        ${rustMatchLabels(arm.bytes)} => {\n`;
    matchArms += arm.indices.map((i) => codes[i]).join('\n') + '\n';
    matchArms += `${indent}        }\n`;
  }
  return `${indent}        if c >= 128 {
${nonAsciiWsCheck}${fallback}
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
    // Byte-oriented: ASCII ws by lead byte; non-ASCII via UTF-8 decode (JS \\s set).
    // LS/PS excluded: they fall to the unexpected-character panic, matching the interpreter.
    ws: `        if c == 32 || c == 9 || c == 11 || c == 12 { pos += 1; continue; }
        if c == 10 || c == 13 {
            pos += 1; if c == 13 && pos < n && b[pos] == 10 { pos += 1; }
            if st.flow_depth == 0 { st.line_start = true; }
            continue;
        }
        if c >= 0xC2 { if let Some((ch, w)) = _utf8_char_at(b, pos) { if _is_js_ws(ch) && ch != '\\u{2028}' && ch != '\\u{2029}' { pos += w; continue; } } }
`,
    wsFrom: `        if c == 32 || c == 9 || c == 11 || c == 12 { pos += 1; continue; }
        if c == 10 || c == 13 {
            pos += 1; if c == 13 && pos < n && b[pos] == 10 { pos += 1; }
            if st.flow_depth == 0 { st.line_start = true; }
            continue;
        }
        if c >= 0xC2 { if let Some((ch, w)) = _utf8_char_at(b, pos) { if _is_js_ws(ch) && ch != '\\u{2028}' && ch != '\\u{2029}' { pos += w; continue; } } }
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
  const nlVar = stateful ? 'st.pending_nl' : 'pending_nl';
  // Byte-class dispatch folds whitespace/newline/template-open into the match's jump table so
  // the hot loop does one load + one match, instead of a chain of pre-checks per byte. Newline-mode
  // grammars keep the flow-aware pre-check (line_start/flow_depth) and do NOT use the folded arms.
  const nonAsciiWsCheck = nlRs ? '' : `        if c >= 0xC2 { if let Some((ch, w)) = _utf8_char_at(b, pos) { if _is_js_ws(ch) { if ch == '\\u{2028}' || ch == '\\u{2029}' { ${nlVar} = true; } pos += w; continue; } } }
`;
  const wsNlArms = nlRs ? '' : `        9 | 11 | 12 | 32 => { pos += 1; continue; }
        10 | 13 => { ${nlVar} = true; pos += 1; continue; }
`;
  const tplOpenByte = tpl && tpl.open.length === 1 && tpl.open.charCodeAt(0) < 128 ? tpl.open.charCodeAt(0) : null;
  const tplOpenArm = tplOpenByte !== null ? `        ${tplOpenByte} => {
            let (interp, e) = _scan_tpl_span(src, pos + ${tpl.open.length});
            if interp { st.emit(pos, e, ${kidOf(ids, "$templateHead")}, lid_of(&src[pos..e])); st.template_stack.push(0); } else { st.emit(pos, e, ${kidOf(ids, tpl.token)}, lid_of(&src[pos..e])); }
            pos = e; continue;
        }
` : '';
  const tplOpenPreCheck = tpl && tplOpenByte === null ? `        if ${startByteEq('pos', tpl.open)} {
            let (interp, e) = _scan_tpl_span(src, pos + ${tpl.open.length});
            if interp { st.emit(pos, e, ${kidOf(ids, "$templateHead")}, lid_of(&src[pos..e])); st.template_stack.push(0); } else { st.emit(pos, e, ${kidOf(ids, tpl.token)}, lid_of(&src[pos..e])); }
            pos = e; continue;
        }
` : '';
  const tplDispatch = tpl ? `        if !st.template_stack.is_empty() && ${startByteEq('pos', tpl.interpClose)} && *st.template_stack.last().unwrap() == 0 {
            st.template_stack.pop();
            let (interp, e) = _scan_tpl_span(src, pos + ${tpl.interpClose.length});
            if interp { st.emit(pos, e, ${kidOf(ids, "$templateMiddle")}, lid_of(&src[pos..e])); st.template_stack.push(0); } else { st.emit(pos, e, ${kidOf(ids, "$templateTail")}, lid_of(&src[pos..e])); }
            pos = e; continue;
        }
${tplOpenPreCheck}` : '';
  const punctLine = (p: string) =>
    `        if ${startByteEq('pos', p)} { ${stateful ? `st.emit(pos, pos + ${p.length}, 0, ${lidOf(ids, p)});` : `toks.push(mk_tok(pos, pos + ${p.length}, pending_nl, 0, ${lidOf(ids, p)})); pending_nl = false;`} pos += ${p.length}; continue; }`;
  const { codes: lexCodes, firsts: lexFirsts } = buildLexCandidates(ir, defs, stateful, ids, rx?.regexToken, tpl?.token, punctLine);
  const cascade = renderLexByteDispatchRust(lexCodes, lexFirsts, '        ', `${wsNlArms}${tplOpenArm}`, nonAsciiWsCheck);
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
  const identName = ir.identToken;
  const identKid = identName ? kidOf(ids, identName) : 0;
  // Unicode ID_Start fallback (mirrors gen-lexer uniIdentReY) before unmatched-byte panic.
  const uniIdentEmit = stateful
    ? `st.emit(pos, e, ${identKid}, lid_of(&src[pos..e]));`
    : `toks.push(mk_tok(pos, e, pending_nl, ${identKid}, lid_of(&src[pos..e]))); pending_nl = false;`;
  const uniIdentOrPanic = identName
    ? `        if c >= 0x80 { if let Some(e) = _scan_uni_ident(b, pos) { ${uniIdentEmit} pos = e; continue; } }
        panic!("Unexpected character at offset {}: '{}'", pos, _utf8_char_at(b, pos).map(|(ch, _)| ch).unwrap_or(b[pos] as char));`
    : `        panic!("Unexpected character at offset {}: '{}'", pos, _utf8_char_at(b, pos).map(|(ch, _)| ch).unwrap_or(b[pos] as char));`;
  const lexUtf8Helpers = `#[inline(always)] fn _utf8_char_at(b: &[u8], pos: usize) -> Option<(char, usize)> {
    let s = std::str::from_utf8(&b[pos..]).ok()?;
    let ch = s.chars().next()?;
    Some((ch, ch.len_utf8()))
}
#[inline(always)] fn _is_js_ws(ch: char) -> bool {
    matches!(ch, '\\u{00A0}' | '\\u{1680}' | '\\u{2028}' | '\\u{2029}' | '\\u{202F}' | '\\u{205F}' | '\\u{3000}' | '\\u{FEFF}')
        || { let u = ch as u32; (0x2000..=0x200A).contains(&u) }
}
// ID_Start ≈ Alphabetic (L + Nl + Other_Alphabetic); ID_Continue adds numerics + ZWNJ/ZWJ.
// std has no general-category queries, so this is the closest dependency-free approximation
// of gen-tm.ts's widened \\p{L}\\p{Nl} / +\\p{Nd}\\p{Mn}\\p{Mc}\\p{Pc} classes (combining
// marks and connector punctuation outside Other_Alphabetic are not covered).
#[inline(always)] fn _is_uni_id_start(ch: char) -> bool {
    ch == '$' || ch == '_' || ch.is_alphabetic()
}
#[inline(always)] fn _is_uni_id_continue(ch: char) -> bool {
    ch == '$' || ch == '_' || ch == '\\u{200C}' || ch == '\\u{200D}' || ch.is_alphanumeric()
}
fn _scan_uni_ident(b: &[u8], pos: usize) -> Option<usize> {
    let (ch, w) = _utf8_char_at(b, pos)?;
    if !_is_uni_id_start(ch) { return None; }
    let mut e = pos + w;
    while e < b.len() {
        let Some((c2, w2)) = _utf8_char_at(b, e) else { break; };
        if !_is_uni_id_continue(c2) { break; }
        e += w2;
    }
    Some(e)
}
// Extend an identifier token that the ASCII pattern cut short at a non-ASCII
// ID_Continue char (caf|é → café), mirroring gen-lexer's uniIdentContReY extension.
fn _lx_ext(b: &[u8], e: usize) -> usize {
    if e >= b.len() || b[e] < 0x80 { return e; }
    let mut ee = e;
    while ee < b.len() {
        let Some((c2, w2)) = _utf8_char_at(b, ee) else { break; };
        if !_is_uni_id_continue(c2) { break; }
        ee += w2;
    }
    ee
}
`;
  const needIn = !!(nlRs); // newline flow still uses string _in
  const rxConsts = `${lexUtf8Helpers}${rxBitTables}${tplLidConsts}${needIn ? `fn _in(set: &[&str], x: &str) -> bool { set.iter().any(|s| *s == x) }\n` : ''}${nlRs ? nlRs.consts : ''}`;
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
    panic!("Unterminated template literal at offset {}", p);
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
  const nlBoundary = nlRs ? nlRs.boundary : '';
  const nlWs = nlRs ? nlRs.ws : '';
  const loopBody = `${nlBoundary}        let c = b[pos] as u32;
${nlWs}${tplDispatch}${cascade}
${uniIdentOrPanic}`;
  if (rxOnly) {
    const rxLoopBody = `${nlBoundary}        let c = b[pos] as u32;
${nlWs}${cascade}
${uniIdentOrPanic}`;
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
    let mut toks = Vec::with_capacity(src.len() / 2 + 16);
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
    let mut toks = Vec::with_capacity(src.len() / 2 + 16);
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
    let mut toks = Vec::with_capacity(src.len() / 2 + 16);
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
    const nlUniIdentOrPanic = identName
      ? rustNlScan(uniIdentOrPanic)
      : `        panic!("Unexpected character at offset {}: '{}'", pos, _utf8_char_at(b, pos).map(|(ch, _)| ch).unwrap_or(b[pos] as char));`;
    const nlLoopBody = `${nlRs!.boundaryFrom}        let c = b[pos] as u32;
${nlRs!.wsFrom}${rustNlScan(cascade)}
${nlUniIdentOrPanic}`;
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
    let mut toks = Vec::with_capacity(src.len() / 2 + 16);
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
    let mut toks = Vec::with_capacity(src.len() / 2 + 16);
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
    case 'lit': return s.value === '>' ? `self.match_gt(${ttIdOf(ar, s.ttype)})` : `self.match_lit(${lidOf(ids, s.value)}, ${ttIdOf(ar, s.ttype)})`;
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
    case 'lit': return s.value === '>' ? `p.match_gt(${ttIdOf(ar, s.ttype)})` : `p.match_lit(${lidOf(ids, s.value)}, ${ttIdOf(ar, s.ttype)})`;
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
  // FIRST dispatch; restore pos/scratch/builder on arm half-failure (like altBody).
  const arms = branches.map((br, i) => {
    const steps = br.length ? br.map((x) => stepCondP(x, ids, ar)).join(' && ') : 'true';
    return `        ${i === 0 ? 'if' : 'else if'} ${firstCond(firsts![i], 't', ids)} { let sp = p.pos; let sb = p.scratch.len(); let ck = p.b.checkpoint(); if ${steps} { return true; } p.pos = sp; p.scratch.truncate(sb); p.b.restore(ck); }`;
  }).join('\n');
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
            let n = match self.match_template(Self::parse_${r.name}) { Some(n) => n, None => return None };
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
  // A lid that ALSO has a binary entry (`<` is both a type-arg LED and the
  // relational operator) must not `break` the Pratt loop when its LED arms
  // fail — the restore happens, then control falls through to the binary
  // while-let below so `<` still parses as a comparison. Lids with no binary
  // entry still fall through between MULTIPLE arms of the SAME lid (e.g. `[`
  // is array-type then indexed-access): only the LAST arm of a group emits the
  // `break` (all arms for that lid failed ⇒ the expression ends).
  const binLids = new Set(r.binary.map((b) => lidOf(ids, b.op)));
  const ledBody = (b: Bracket, hasBin: boolean, isLast: boolean) => `{
                let led_save = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
                self.scratch.push(left.h);
                if ${b.steps.map((x) => stepCond(x, ids, ar)).join(' && ')} { left = self.finish(${rid}, sb, left.off as usize, left.tok_start as usize); continue; }
                self.pos = led_save; self.scratch.truncate(sb); self.b.restore(ck);${hasBin ? '' : isLast ? ' break;' : ''}
            }`;
  const ledMatch = (() => {
    if (r.leds.length === 0) return '';
    const groups = groupByPreserveOrder(r.leds, (b) => lidOf(ids, b.first));
    return `            match t.lid {
${groups.map((g) => {
  const lid = g.key as number;
  const hasBin = binLids.has(lid);
  const arms = g.members.map(({ item: b, index: i }, j) =>
    `                if ${ledGuard(r.ledAccessTail[i]!, r.ledLbp[i]!, r.ledSameLine[i]!, r.ledNotLeftLeaf[i]!, lid)} ${ledBody(b, hasBin, j === g.members.length - 1)}`);
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
            if !tail_closed && t.kid == ${kidOf(ids, "$templateHead")} { if let Some(n) = self.match_template(Self::parse_${r.name}) { let sb = self.scratch.len(); if left.present { self.scratch.push(left.h); } if n.present { self.scratch.push(n.h); } left = self.finish(${rid}, sb, left.off as usize, left.tok_start as usize); continue; } }` : '';
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
  const segsInit = shapeB ? ', segs: Vec::new()' : '';
  const reuseInit = `${entriesInit}${segsInit}`;
  const adoptSuffix = `                        for j in (o_idx + 1)..old_toks.len() {
                            out.push(shift_align(&old_toks[j], delta));
                        }`;
  const findTokAtOff = `
fn find_tok_at_off(toks: &[AlignMeta], off: usize) -> Option<usize> {
    let mut lo = 0usize; let mut hi = toks.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if (toks[mid].off as usize) < off { lo = mid + 1; } else if (toks[mid].off as usize) > off { hi = mid; } else { return Some(mid); }
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
        if am_text(text, t) == "(" && t.pd == need {
            out[(need - 1) as usize] = am_hd(t);
            need -= 1;
        }
        i -= 1;
    }
    out
}
fn paren_stacks_eq(a: &[bool], b: &[bool]) -> bool { a == b }`;
  const tplAnchor = `    let mut max_idx: isize = -1;
    for (i, t) in old_toks.iter().enumerate() {
        if (t.end as usize) < start { max_idx = i as isize; } else { break; }
    }
    let rb0: isize = if max_idx >= 0 { max_idx - 1 } else { -1 };
    let mut rb: isize = -1;
    if rb0 >= 0 {
        for i in rb0 as usize..old_toks.len() {
            if (old_toks[i].end as usize) > start { break; }
            if old_toks[i].td == 0 { rb = i as isize; break; }
        }
    }
    let mut out: Vec<AlignMeta> = if rb >= 0 { old_toks[..=rb as usize].to_vec() } else { Vec::new() };`;
  const windowHelpers = windowLex ? (hasNewline ? `
fn find_tok_at_off_kind(toks: &[AlignMeta], off: usize, kid: u16) -> Option<usize> {
    let mut lo = 0usize;
    let mut hi = toks.len();
    let mut hit = None;
    while lo < hi {
        let mid = (lo + hi) / 2;
        if (toks[mid].off as usize) < off { lo = mid + 1; } else { hi = mid; }
    }
    if lo < toks.len() && toks[lo].off as usize == off { hit = Some(lo); }
    let hit = hit?;
    let mut start = hit;
    while start > 0 && toks[start - 1].off as usize == off { start -= 1; }
    let mut i = start;
    while i < toks.len() && toks[i].off as usize == off {
        if toks[i].kid == kid { return Some(i); }
        i += 1;
    }
    None
}
fn window_relex_step(old_text: &str, old_toks: &[AlignMeta], new_text: &str, start: usize, end: usize, ins: &str) -> (Vec<AlignMeta>, usize) {
    let delta = ins.len() as isize - (end - start) as isize;
    let edit_end = start + ins.len();
    let mut max_idx = None::<usize>;
    for (i, t) in old_toks.iter().enumerate() {
        if (t.end as usize) < start { max_idx = Some(i); } else { break; }
    }
    let rb = max_idx.map(|i| i as isize - 1).unwrap_or(-1);
    let mut out: Vec<AlignMeta> = if rb >= 0 { old_toks[..=rb as usize].to_vec() } else { Vec::new() };
    let (mut scan_off, mut pending_nl, mut line_start, mut emitted_content, mut flow_depth) = if rb >= 0 {
        (old_toks[rb as usize].end as usize, false, false, true, old_toks[rb as usize].fd as i64)
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
        out.push(mk_align(t.off, t.end, t.kid, t.nl, flow_depth as u16, 0, false, false, false, 0));
        relexed += 1;
        if (t.off as usize) >= edit_end {
            if let Some(o_idx) = find_tok_at_off_kind(old_toks, (t.off as isize - delta) as usize, t.kid) {
                let o = &old_toks[o_idx];
                if o.kid == t.kid && o.end == (t.end as isize - delta) as u32 && am_nl(o) == t.nl && o.fd as i64 == flow_depth && am_text(old_text, o) == &new_text[t.off as usize..t.end as usize] {
                    for ot in &old_toks[o_idx + 1..] {
                        out.push(shift_align(ot, delta));
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
        if (toks[mid].off as usize) < off { lo = mid + 1; } else { hi = mid; }
    }
    if lo < toks.len() && toks[lo].off as usize == off { Some(lo) } else { None }
}
fn reconstruct_parens(toks: &[AlignMeta], text: &str, b: isize) -> Vec<bool> {
    let mut need = if b >= 0 { toks[b as usize].pd } else { 0 };
    let mut out: Vec<bool> = Vec::new();
    let mut i = b;
    while i >= 0 && need > 0 {
        let t = &toks[i as usize];
        if am_text(text, t) == "(" && t.pd == need {
            out.insert(0, am_hd(t));
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
        if (t.end as usize) < start { max_idx = Some(i); } else { break; }
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
        scan_off = anchor.end as usize;
        prev_lid = lid_of(am_text(old_text, anchor));
        prev_kid = anchor.kid;
        has_prev = true;
        if rb >= 1 {
            let p = &old_toks[rb as usize - 1];
            bp_lid = lid_of(am_text(old_text, p));
            has_prev2 = true;
        }
        last_close = am_lc(anchor);
        last_bang = am_lb(anchor);
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
        out.push(mk_align(t.off, t.end, t.kid, t.nl, 0, paren_head.len() as u16, last_close, last_bang, hd, 0));
        relexed += 1;
        if (t.off as usize) >= edit_end {
            if let Some(o_idx) = find_tok_at_off(old_toks, (t.off as isize - delta) as usize) {
                let o = &old_toks[o_idx];
                let new_prev_text = if out.len() > 1 { am_text(new_text, &out[out.len() - 2]) } else { "" };
                let old_prev_text = if o_idx >= 1 { am_text(old_text, &old_toks[o_idx - 1]) } else { "" };
                let bp_ok = new_prev_text == old_prev_text;
                let old_stack = reconstruct_parens(old_toks, old_text, o_idx as isize);
                if o.pd as usize == paren_head.len() && paren_stacks_eq(&old_stack, &paren_head) && am_lc(o) == last_close && am_lb(o) == last_bang && bp_ok && o.kid == t.kid && o.end == (t.end as isize - delta) as u32 && am_nl(o) == t.nl && am_text(old_text, o) == &new_text[t.off as usize..t.end as usize] {
                    for ot in &old_toks[o_idx + 1..] {
                        out.push(shift_align(ot, delta));
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
        scan_off = anchor.end as usize;
        prev_lid = lid_of(am_text(old_text, anchor));
        prev_kid = anchor.kid;
        has_prev = true;
        if rb >= 1 {
            let p = &old_toks[(rb - 1) as usize];
            bp_lid = lid_of(am_text(old_text, p));
            has_prev2 = true;
        }
        last_close = am_lc(anchor);
        last_bang = am_lb(anchor);
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
        out.push(mk_align(t.off, t.end, t.kid, t.nl, 0, paren_head.len() as u16, last_close, last_bang, hd, template_stack.len() as u8));
        relexed += 1;
        if (t.off as usize) >= edit_end {
            if let Some(o_idx) = find_tok_at_off(old_toks, (t.off as isize - delta) as usize) {
                let o = &old_toks[o_idx];
                let new_prev = if out.len() > 1 { am_text(new_text, &out[out.len()-2]) } else { "" };
                let old_prev = if o_idx >= 1 { am_text(old_text, &old_toks[o_idx-1]) } else { "" };
                let old_stack = reconstruct_parens(old_toks, old_text, o_idx as isize);
                if o.td == 0 && template_stack.is_empty() && o.pd as usize == paren_head.len() && paren_stacks_eq(&old_stack, &paren_head) && am_lc(o) == last_close && am_lb(o) == last_bang && new_prev == old_prev && o.kid == t.kid && o.end == (t.end as isize - delta) as u32 && am_nl(o) == t.nl && am_text(old_text, o) == &new_text[t.off as usize..t.end as usize] {
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
    let mut scan_off = if rb >= 0 { old_toks[rb as usize].end as usize } else { 0 };
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
        out.push(mk_align(t.off, t.end, t.kid, t.nl, 0, 0, false, false, false, template_stack.len() as u8));
        relexed += 1;
        if (t.off as usize) >= edit_end {
            if let Some(o_idx) = find_tok_at_off(old_toks, (t.off as isize - delta) as usize) {
                let o = &old_toks[o_idx];
                if o.td == 0 && template_stack.is_empty() && o.kid == t.kid && o.end == (t.end as isize - delta) as u32 && am_nl(o) == t.nl && am_text(old_text, o) == &new_text[t.off as usize..t.end as usize] {
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
        if (toks[mid].off as usize) < off { lo = mid + 1; } else { hi = mid; }
    }
    if lo < toks.len() && toks[lo].off as usize == off { Some(lo) } else { None }
}
fn window_relex_step(old_text: &str, old_toks: &[AlignMeta], new_text: &str, start: usize, end: usize, ins: &str) -> (Vec<AlignMeta>, usize) {
    let delta = ins.len() as isize - (end - start) as isize;
    let edit_end = start + ins.len();
    let mut max_idx = None::<usize>;
    for (i, t) in old_toks.iter().enumerate() {
        if (t.end as usize) < start { max_idx = Some(i); } else { break; }
    }
    let rb = max_idx.map(|i| i as isize - 1).unwrap_or(-1);
    let mut out: Vec<AlignMeta> = if rb >= 0 { old_toks[..=rb as usize].to_vec() } else { Vec::new() };
    let mut scan_off = if rb >= 0 { old_toks[rb as usize].end as usize } else { 0 };
    let mut pending_nl = false;
    let mut scratch: Vec<Tok> = Vec::new();
    let mut relexed = 0usize;
    while scan_off < new_text.len() {
        let before = scratch.len();
        (scan_off, pending_nl) = lex_from(new_text, scan_off, pending_nl, &mut scratch, 1);
        if scratch.len() == before { break; }
        let t = &scratch[scratch.len() - 1];
        out.push(mk_align(t.off, t.end, t.kid, t.nl, 0, 0, false, false, false, 0));
        relexed += 1;
        if (t.off as usize) >= edit_end {
            if let Some(o_idx) = find_tok_at_off(old_toks, (t.off as isize - delta) as usize) {
                let o = &old_toks[o_idx];
                if o.kid == t.kid && o.end == (t.end as isize - delta) as u32 && am_nl(o) == t.nl && am_text(old_text, o) == &new_text[t.off as usize..t.end as usize] {
                    for ot in &old_toks[o_idx + 1..] {
                        out.push(shift_align(ot, delta));
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
        meta.push(mk_align(t.off, t.end, t.kid, t.nl, flow_depth as u16, 0, false, false, false, 0));
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
        meta.push(mk_align(t.off, t.end, t.kid, t.nl, 0, paren_head.len() as u16, last_close, last_bang, hd, 0));
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
        meta.push(mk_align(t.off, t.end, t.kid, t.nl, 0, paren_head.len() as u16, last_close, last_bang, hd, template_stack.len() as u8));
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
        meta.push(mk_align(t.off, t.end, t.kid, t.nl, 0, 0, false, false, false, template_stack.len() as u8));
    }
    meta
}
fn to_meta(_toks: &[Tok]) -> Vec<AlignMeta> { panic!("use scan_meta for tpl") }
` : `fn to_meta(toks: &[Tok]) -> Vec<AlignMeta> {
    toks.iter().map(|t| mk_align(t.off, t.end, t.kid, t.nl, 0, 0, false, false, false, 0)).collect()
}`;
  // Packed AlignMeta: full-field equality covers the prior mode-specific checks
  // (unused state fields are always zeroed by scan_meta / to_meta / window_relex).
  const checkStreamEqFn = (hasNewline || rxOnly || rxTpl || tplOnly) ? `
fn check_stream_eq(text: &str, meta: &[AlignMeta]) -> bool {
    let fresh = scan_meta(text);
    if fresh.len() != meta.len() { return false; }
    for (f, m) in fresh.iter().zip(meta.iter()) {
        if f != m { return false; }
        if am_text(text, f) != am_text(text, m) { return false; }
    }
    true
}
` : `
fn check_stream_eq(text: &str, meta: &[AlignMeta]) -> bool {
    let fresh = to_meta(&lex(text));
    if fresh.len() != meta.len() { return false; }
    for (f, m) in fresh.iter().zip(meta.iter()) {
        if f != m { return false; }
        if am_text(text, f) != am_text(text, m) { return false; }
    }
    true
}
`;
  const initToks = (hasNewline || rxOnly || tplOnly || rxTpl) ? 'scan_meta(&text)' : 'to_meta(&lex(&text))';
  const freshMeta = (hasNewline || rxOnly || tplOnly || rxTpl) ? 'scan_meta(&self.text)' : 'to_meta(&lex(&self.text))';
  const freshRetryRs = `        if self.root.is_none() {
            self.toks = ${freshMeta};
            let text = self.text.clone();
            let meta = self.toks.clone();
            let ntoks = toks_from_meta(&text, &meta);
            let nlen = ntoks.len();
            let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: B::default(), scratch: Vec::new()${topReuse ? (shapeB ? ', entries: Vec::new(), segs: Vec::new()' : ', entries: Vec::new()') : ''} };
            match p.parse_${ir.entry}() {
                Some(fr) if p.pos == nlen && fr.present => {
                    self.root = Some(fr.h); self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                    self.b = p.b; self.scratch = p.scratch;${topReuse ? (shapeB ? ' self.entries = p.entries; self.segs = p.segs;' : ' self.entries = p.entries;') : ''}
                }
                _ => {
                    self.root = None; self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                    self.b = p.b; self.scratch = p.scratch;${topReuse ? (shapeB ? ' self.entries = p.entries; self.segs = p.segs;' : ' self.entries = p.entries;') : ''}
                }
            }
        }
`;
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
fn should_reclaim_arena(nodes: &[Node], kids: &[i32], root: i32, baseline: usize) -> bool {
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
  const reuseFnsA = shapeA ? `${reuseShared}impl<'a, B: Builder> Parser<'a, B> {
    fn finish_reuse(&mut self, rule_id: u16, prefix_kids: &[B::H], mid: &[B::H], suffix_cand: &[B::H], prefix_meta: &[EntryMeta], mid_meta: &[EntryMeta], suffix_meta: &[EntryMeta], adopt_from: usize, byte_delta: isize, tok_delta: isize, new_n: usize) -> (B::H, usize) {
        let adopted = &suffix_cand[adopt_from..];
        let mut adopted_hs: Vec<B::H> = Vec::with_capacity(adopted.len());
        for &s in adopted {
            adopted_hs.push(self.b.shift(s, byte_delta, tok_delta));
        }
        let mut children: Vec<B::H> = Vec::with_capacity(prefix_kids.len() + mid.len() + adopted_hs.len());
        children.extend_from_slice(prefix_kids);
        children.extend_from_slice(mid);
        children.extend_from_slice(&adopted_hs);
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
        let sb = self.scratch.len();
        self.scratch.extend_from_slice(&children);
        self.b.node(&mut self.scratch, sb, rule_id, off, end, tok_start, tok_end);
        let root = self.scratch.pop().expect("finish_reuse root");
        self.entries = new_entries;
        self.pos = new_n;
        (root, prefix_kids.len() + adopted_hs.len())
    }
    fn try_reuse_top(&mut self, old_root: B::H, old_entries: &[EntryMeta], byte_delta: isize, old_n: usize, new_n: usize, prefix: usize, suffix: usize, validate: bool) -> Option<(B::H, usize)> {
        if validate { self.b.validate_entries(old_entries, old_root); }
        let old_kids = self.b.root_kids(old_root);
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
        let mut mid: Vec<B::H> = Vec::new();
        let mut mid_meta: Vec<EntryMeta> = Vec::new();
        let suffix_bound = new_n - suffix;
        let mut max_cand: isize = -1;
        for m in suffix_meta {
            let c = m.tok_start as isize + tok_delta;
            if c > max_cand { max_cand = c; }
        }
        let rule_id = self.b.rule_id_of(old_root);
        let try_hit = |p: &mut Parser<'a, B>, mid: &[B::H], mid_meta: &[EntryMeta]| -> Option<(B::H, usize)> {
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
impl<'a, B: Builder> Parser<'a, B> {
    fn finish_reuse_seg(&mut self, rule_id: u16, prefix_segs: &[Seg], prefix_kids: &[B::H], mid_segs: &[Seg], mid_kids: &[B::H], suffix_cand: &[Seg], prefix_meta: &[EntryMeta], mid_meta: &[EntryMeta], suffix_meta: &[EntryMeta], old_root: B::H, adopt_from: usize, byte_delta: isize, tok_delta: isize, new_n: usize) -> (B::H, usize) {
        let adopted_segs = &suffix_cand[adopt_from..];
        let mut adopted_kids: Vec<B::H> = Vec::new();
        for s in adopted_segs {
            for i in 0..s.kid_count {
                let id = self.b.root_kid_at(old_root, s.kid_start + i);
                adopted_kids.push(self.b.shift(id, byte_delta, tok_delta));
            }
        }
        let mut children: Vec<B::H> = Vec::with_capacity(prefix_kids.len() + mid_kids.len() + adopted_kids.len());
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
        let sb = self.scratch.len();
        self.scratch.extend_from_slice(&children);
        self.b.node(&mut self.scratch, sb, rule_id, off, end, tok_start, tok_end);
        let root = self.scratch.pop().expect("finish_reuse_seg root");
        self.segs = new_segs;
        self.entries = new_entries;
        self.pos = new_n;
        (root, prefix_segs.len() + adopted_segs.len())
    }
    fn try_reuse_seg(&mut self, old_root: B::H, old_segs: &[Seg], old_entries: &[EntryMeta], byte_delta: isize, old_n: usize, new_n: usize, prefix: usize, suffix: usize, validate: bool) -> Option<(B::H, usize)> {
        if old_segs.is_empty() { return None; }
        if validate { self.b.validate_entry_segs(old_entries, old_segs, old_root); }
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
        let mut prefix_kids: Vec<B::H> = Vec::new();
        for s in prefix_segs {
            for j in 0..s.kid_count {
                prefix_kids.push(self.b.root_kid_at(old_root, s.kid_start + j));
            }
        }
        let tok_delta = new_n as isize - old_n as isize;
        self.pos = if prefix_len > 0 { prefix_meta[prefix_len - 1].tok_end as usize } else { 0 };
        self.scratch.clear();
        let mut mid_kids: Vec<B::H> = Vec::new();
        let mut mid_segs: Vec<Seg> = Vec::new();
        let mut mid_meta: Vec<EntryMeta> = Vec::new();
        let suffix_bound = new_n - suffix;
        let mut max_cand: isize = -1;
        for m in suffix_meta {
            let c = m.tok_start as isize + tok_delta;
            if c > max_cand { max_cand = c; }
        }
        let rule_id = self.b.rule_id_of(old_root);
        let try_hit = |p: &mut Parser<'a, B>, mid_kids: &[B::H], mid_segs: &[Seg], mid_meta: &[EntryMeta]| -> Option<(B::H, usize)> {
            if p.pos < suffix_bound { return None; }
            if suffix_cand.is_empty() {
                if p.pos == new_n { return Some(p.finish_reuse_seg(rule_id, prefix_segs, &prefix_kids, mid_segs, mid_kids, suffix_cand, prefix_meta, mid_meta, suffix_meta, old_root, 0, byte_delta, tok_delta, new_n)); }
                return None;
            }
            for (hi, m) in suffix_meta.iter().enumerate() {
                if m.tok_start as isize + tok_delta == p.pos as isize {
                    return Some(p.finish_reuse_seg(rule_id, prefix_segs, &prefix_kids, mid_segs, mid_kids, suffix_cand, prefix_meta, mid_meta, suffix_meta, old_root, hi, byte_delta, tok_delta, new_n));
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
                    return Some(self.finish_reuse_seg(rule_id, prefix_segs, &prefix_kids, &mid_segs, &mid_kids, suffix_cand, prefix_meta, &mid_meta, suffix_meta, old_root, 0, byte_delta, tok_delta, new_n));
                }
                return try_hit(self, &mid_kids, &mid_segs, &mid_meta);
            }
            let sb = self.scratch.len();
            let (seg, meta) = match self.parse_loop_seg(sb) {
                Some(pair) => pair,
                None => {
                    if suffix_cand.is_empty() && self.pos == new_n {
                        return Some(self.finish_reuse_seg(rule_id, prefix_segs, &prefix_kids, &mid_segs, &mid_kids, suffix_cand, prefix_meta, &mid_meta, suffix_meta, old_root, 0, byte_delta, tok_delta, new_n));
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
fn check_tree_eq_arena(text: &str, nodes: &[Node], kids: &[i32], root: Option<i32>) -> bool {
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
        let force_fresh = self.root.is_none()
            || !B::SUPPORTS_SHIFT
            || self.root.map(|r| self.b.should_reclaim(r, self.baseline)).unwrap_or(true);
        let text = self.text.clone();
        let meta = self.toks.clone();
        if !force_fresh {
            let b = std::mem::take(&mut self.b);
            let scratch = std::mem::take(&mut self.scratch);
            let old_entries = std::mem::take(&mut self.entries);
            let old_root = self.root.take().unwrap();
            let mut p = Parser { toks: toks_from_meta(&text, &meta), pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b, scratch, entries: Vec::new() };
            if let Some((root, n)) = p.try_reuse_top(old_root, &old_entries, byte_delta, old_n, new_n, prefix, suffix, self.validate) {
                self.root = Some(root);
                reused = n;
                self.last_pos = p.pos;
                self.b = p.b; self.scratch = p.scratch; self.entries = p.entries;
            } else {
                let ntoks = toks_from_meta(&text, &meta);
                let nlen = ntoks.len();
                let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: B::default(), scratch: Vec::new(), entries: Vec::new() };
                match p.parse_${ir.entry}() {
                    Some(fr) if p.pos == nlen && fr.present => {
                        self.root = Some(fr.h); self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                        self.b = p.b; self.scratch = p.scratch; self.entries = p.entries; reused = 0;
                    }
                    _ => {
                        self.root = None; self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                        self.b = p.b; self.scratch = p.scratch; self.entries = p.entries; reused = 0;
                    }
                }
            }
        } else {
            let ntoks = toks_from_meta(&text, &meta);
            let nlen = ntoks.len();
            let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: B::default(), scratch: Vec::new(), entries: Vec::new() };
            match p.parse_${ir.entry}() {
                Some(fr) if p.pos == nlen && fr.present => {
                    self.root = Some(fr.h); self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                    self.b = p.b; self.scratch = p.scratch; self.entries = p.entries;
                }
                _ => {
                    self.root = None; self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                    self.b = p.b; self.scratch = p.scratch; self.entries = p.entries;
                }
            }
            reused = 0;
        }
${freshRetryRs}        let stream_eq = if self.validate { Some(check_stream_eq(&self.text, &self.toks)) } else { None };
        let tree_eq = if self.validate && B::SUPPORTS_TREE_EQ {
            Some(self.b.check_tree_eq(&self.text, self.root))
        } else { None };
        self.align = Some(Align { old_n, new_n, prefix, suffix, relexed, reused, stream_eq, tree_eq });`
    : '';
  const editParseB = shapeB
    ? `        let byte_delta = self.text.len() as isize - old_text.len() as isize;
        let mut reused = 0usize;
        let force_fresh = self.root.is_none()
            || !B::SUPPORTS_SHIFT
            || self.root.map(|r| self.b.should_reclaim(r, self.baseline)).unwrap_or(true);
        let text = self.text.clone();
        let meta = self.toks.clone();
        if !force_fresh {
            let b = std::mem::take(&mut self.b);
            let scratch = std::mem::take(&mut self.scratch);
            let old_segs = std::mem::take(&mut self.segs);
            let old_entries = std::mem::take(&mut self.entries);
            let old_root = self.root.take().unwrap();
            let mut p = Parser { toks: toks_from_meta(&text, &meta), pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b, scratch, entries: Vec::new(), segs: Vec::new() };
            if let Some((root, n)) = p.try_reuse_seg(old_root, &old_segs, &old_entries, byte_delta, old_n, new_n, prefix, suffix, self.validate) {
                self.root = Some(root);
                reused = n;
                self.last_pos = p.pos;
                self.b = p.b; self.scratch = p.scratch; self.segs = p.segs; self.entries = p.entries;
            } else {
                let ntoks = toks_from_meta(&text, &meta);
                let nlen = ntoks.len();
                let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: B::default(), scratch: Vec::new(), entries: Vec::new(), segs: Vec::new() };
                match p.parse_${ir.entry}() {
                    Some(fr) if p.pos == nlen && fr.present => {
                        self.root = Some(fr.h); self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                        self.b = p.b; self.scratch = p.scratch; self.segs = p.segs; self.entries = p.entries; reused = 0;
                    }
                    _ => {
                        self.root = None; self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                        self.b = p.b; self.scratch = p.scratch; self.segs = p.segs; self.entries = p.entries; reused = 0;
                    }
                }
            }
        } else {
            let ntoks = toks_from_meta(&text, &meta);
            let nlen = ntoks.len();
            let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: B::default(), scratch: Vec::new(), entries: Vec::new(), segs: Vec::new() };
            match p.parse_${ir.entry}() {
                Some(fr) if p.pos == nlen && fr.present => {
                    self.root = Some(fr.h); self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                    self.b = p.b; self.scratch = p.scratch; self.segs = p.segs; self.entries = p.entries;
                }
                _ => {
                    self.root = None; self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                    self.b = p.b; self.scratch = p.scratch; self.segs = p.segs; self.entries = p.entries;
                }
            }
            reused = 0;
        }
${freshRetryRs}        let stream_eq = if self.validate { Some(check_stream_eq(&self.text, &self.toks)) } else { None };
        let tree_eq = if self.validate && B::SUPPORTS_TREE_EQ {
            Some(self.b.check_tree_eq(&self.text, self.root))
        } else { None };
        self.align = Some(Align { old_n, new_n, prefix, suffix, relexed, reused, stream_eq, tree_eq });`
    : '';
  const docTakeReuse = topReuse
    ? (shapeB ? ' self.entries = p.entries; self.segs = p.segs;' : ' self.entries = p.entries;')
    : '';
  const editParse = shapeA
    ? editParseA
    : shapeB
    ? editParseB
    : `        let text = self.text.clone();
        let meta = self.toks.clone();
        let ntoks = toks_from_meta(&text, &meta);
        let nlen = ntoks.len();
        let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: B::default(), scratch: Vec::new()${reuseInit} };
        match p.parse_${ir.entry}() {
            Some(fr) if p.pos == nlen && fr.present => {
                self.root = Some(fr.h); self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                self.b = p.b; self.scratch = p.scratch;${docTakeReuse}
            }
            _ => {
                self.root = None; self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                self.b = p.b; self.scratch = p.scratch;${docTakeReuse}
            }
        }
        let reused = 0usize;
${freshRetryRs}        let stream_eq = if self.validate { Some(check_stream_eq(&self.text, &self.toks)) } else { None };
        let tree_eq = if self.validate && B::SUPPORTS_TREE_EQ {
            Some(self.b.check_tree_eq(&self.text, self.root))
        } else { None };
        self.align = Some(Align { old_n, new_n, prefix, suffix, relexed, reused, stream_eq, tree_eq });`;
  const docSegField = shapeB ? '\n    segs: Vec<Seg>,' : '';
  const docEntriesField = topReuse ? '\n    entries: Vec<EntryMeta>,' : '';
  const docSegInit = shapeB ? ', segs: Vec::new()' : '';
  const docEntriesInit = topReuse ? ', entries: Vec::new()' : '';
  const docExtraField = `${docEntriesField}${docSegField}`;
  const docExtraInit = `${docEntriesInit}${docSegInit}`;
  return `pub struct Edit { pub start: usize, pub end: usize, pub text: String }
/// Packed Doc-state token (16B). kind → kid+KIND_STR; text → src[off..end];
/// nl/lc/lb/hd packed in flags; pd/fd/td are narrow depths (paren/flow/template).
#[derive(Clone, Copy, PartialEq, Eq)]
struct AlignMeta { off: u32, end: u32, kid: u16, pd: u16, fd: u16, flags: u8, td: u8 }
#[inline(always)] fn am_nl(m: &AlignMeta) -> bool { m.flags & 1 != 0 }
#[inline(always)] fn am_lc(m: &AlignMeta) -> bool { m.flags & 2 != 0 }
#[inline(always)] fn am_lb(m: &AlignMeta) -> bool { m.flags & 4 != 0 }
#[inline(always)] fn am_hd(m: &AlignMeta) -> bool { m.flags & 8 != 0 }
#[inline(always)] fn am_text<'a>(src: &'a str, m: &AlignMeta) -> &'a str { &src[m.off as usize..m.end as usize] }
#[inline(always)] fn mk_align(off: u32, end: u32, kid: u16, nl: bool, fd: u16, pd: u16, lc: bool, lb: bool, hd: bool, td: u8) -> AlignMeta {
    AlignMeta { off, end, kid, pd, fd, td, flags: (nl as u8) | ((lc as u8) << 1) | ((lb as u8) << 2) | ((hd as u8) << 3) }
}
#[inline(always)] fn shift_align(m: &AlignMeta, delta: isize) -> AlignMeta {
    AlignMeta { off: (m.off as isize + delta) as u32, end: (m.end as isize + delta) as u32, kid: m.kid, pd: m.pd, fd: m.fd, flags: m.flags, td: m.td }
}
struct Align { old_n: usize, new_n: usize, prefix: usize, suffix: usize, relexed: usize, reused: usize, stream_eq: Option<bool>, tree_eq: Option<bool> }
${toMetaFn}
fn compute_align_core(old_text: &str, old_toks: &[AlignMeta], new_text: &str, new_toks: &[AlignMeta]) -> (usize, usize, usize, usize) {
    let old_n = old_toks.len();
    let new_n = new_toks.len();
    let mut prefix = 0usize;
    while prefix < old_n && prefix < new_n {
        let o = &old_toks[prefix];
        let n = &new_toks[prefix];
        if o.kid != n.kid || o.off != n.off || o.end != n.end || am_nl(o) != am_nl(n) { break; }
        if am_text(old_text, o) != am_text(new_text, n) { break; }
        prefix += 1;
    }
    let delta = new_text.len() as isize - old_text.len() as isize;
    let min_n = old_n.min(new_n);
    let mut suffix = 0usize;
    while prefix + suffix < min_n {
        let o = &old_toks[old_n - 1 - suffix];
        let n = &new_toks[new_n - 1 - suffix];
        if o.kid != n.kid || am_nl(o) != am_nl(n) { break; }
        if n.off != (o.off as isize + delta) as u32 || n.end != (o.end as isize + delta) as u32 { break; }
        if am_text(old_text, o) != am_text(new_text, n) { break; }
        suffix += 1;
    }
    (old_n, new_n, prefix, suffix)
}
fn toks_from_meta(text: &str, meta: &[AlignMeta]) -> Vec<Tok> {
    meta.iter().map(|m| { let tx = am_text(text, m); mk_tok(m.off as usize, m.end as usize, am_nl(m), m.kid, lid_of(tx)) }).collect()
}
${checkStreamEqFn}${treeEqFn}${windowHelpers}${reuseFns}pub struct Doc<B: Builder = CstBuilder> {
    text: String,
    toks: Vec<AlignMeta>,
    align: Option<Align>,
    validate: bool,
    b: B,
    scratch: Vec<B::H>,${docExtraField}
    root: Option<B::H>,
    baseline: usize,
    last_pos: usize,
}
impl<B: Builder + Default> Doc<B> {
    /// Explicit builder (handout Doc::new(src, builder) form — Rust has no arity overload).
    pub fn new_with(text: String, b: B) -> Doc<B> {
        let toks = ${initToks};
        let mut d = Doc { text, toks, align: None, validate: false, b, scratch: Vec::new()${docExtraInit}, root: None, baseline: 0, last_pos: 0 };
        d.reparse_fresh();
        d
    }
    /// Convenient constructor via B::default(). Bare Doc::new(src) → CstBuilder (default type param).
    pub fn new(text: String) -> Doc<B> {
        Doc::new_with(text, B::default())
    }
    fn reparse_fresh(&mut self) {
        let text = self.text.clone();
        let meta = self.toks.clone();
        let ntoks = toks_from_meta(&text, &meta);
        let nlen = ntoks.len();
        let b = std::mem::take(&mut self.b);
        let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b, scratch: Vec::new()${reuseInit} };
        match p.parse_${ir.entry}() {
            Some(fr) if p.pos == nlen && fr.present => {
                self.root = Some(fr.h); self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                self.b = p.b; self.scratch = p.scratch;${docTakeReuse}
            }
            _ => {
                self.root = None; self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                self.b = p.b; self.scratch = p.scratch;${docTakeReuse}
            }
        }
    }
    pub fn set_validate(&mut self, v: bool) { self.validate = v; }
    pub fn text(&self) -> &str { &self.text }
    pub fn alignment(&self) -> Option<&Align> { self.align.as_ref() }
    pub fn builder(&self) -> &B { &self.b }
    pub fn root_handle(&self) -> Option<B::H> { self.root }
    pub fn edit(&mut self, edits: &[Edit]) {
        let old_text = self.text.clone();
        let old_toks = self.toks.clone();
        let edits_owned: Vec<Edit> = edits.iter().map(|e| Edit { start: e.start, end: e.end, text: e.text.clone() }).collect();
        let self_ptr = self as *mut Self;
        let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let d = unsafe { &mut *self_ptr };
            let mut relexed = 0usize;
            {
                // Re-bind names expected by editBody / editParse templates.
                let edits = &edits_owned[..];
                let _ = edits;
${editBody.replace(/self\./g, 'd.').replace(/old_text/g, 'old_text')}
                let (old_n, new_n, prefix, suffix) = compute_align_core(&old_text, &old_toks, &d.text, &d.toks);
${editParse.replace(/self\./g, 'd.')}
            }
            let _ = relexed;
        }));
        if ok.is_err() {
            self.text = old_text;
            for e in &edits_owned {
                let n = self.text.len();
                let start = e.start.min(n);
                let end = e.end.max(start).min(n);
                self.text = format!("{}{}{}", &self.text[..start], e.text, &self.text[end..]);
            }
            let toks = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ${freshMeta.replace(/self\.text/g, 'self.text')}));
            match toks {
                Ok(t) => {
                    self.toks = t;
                    let text = self.text.clone();
                    let meta = self.toks.clone();
                    let ntoks = toks_from_meta(&text, &meta);
                    let nlen = ntoks.len();
                    let mut p = Parser { toks: ntoks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &text, b: B::default(), scratch: Vec::new()${topReuse ? (shapeB ? ', entries: Vec::new(), segs: Vec::new()' : ', entries: Vec::new()') : ''} };
                    match p.parse_${ir.entry}() {
                        Some(fr) if p.pos == nlen && fr.present => {
                            self.root = Some(fr.h); self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                            self.b = p.b; self.scratch = p.scratch;${topReuse ? (shapeB ? ' self.entries = p.entries; self.segs = p.segs;' : ' self.entries = p.entries;') : ''}
                        }
                        _ => {
                            self.root = None; self.baseline = p.b.arena_len(); self.last_pos = p.pos;
                            self.b = p.b; self.scratch = p.scratch;${topReuse ? (shapeB ? ' self.entries = p.entries; self.segs = p.segs;' : ' self.entries = p.entries;') : ''}
                        }
                    }
                    self.align = Some(Align { old_n: old_toks.len(), new_n: self.toks.len(), prefix: 0, suffix: 0, relexed: self.toks.len(), reused: 0, stream_eq: None, tree_eq: None });
                }
                Err(_) => {
                    self.toks = Vec::new();
                    self.root = None;
                    self.align = Some(Align { old_n: old_toks.len(), new_n: 0, prefix: 0, suffix: 0, relexed: 0, reused: 0, stream_eq: None, tree_eq: None });
                }
            }
        }
    }
}
impl Doc<CstBuilder> {
    pub fn cst_json(&self) -> Option<String> {
        let root = self.root?;
        if self.last_pos != self.toks.len() { return None; }
        let toks = toks_from_meta(&self.text, &self.toks);
        let mut out = String::new();
        write_json_arena(&self.b.nodes, &self.b.kids, &toks, root, &mut out);
        Some(out)
    }
    pub fn parse(&self) -> Option<(Parser<'_>, i32)> {
        // Fresh independent parse (does not touch Doc arena) — used by non-edit callers.
        let toks = toks_from_meta(&self.text, &self.toks);
        let n = toks.len();
        let mut p = Parser { toks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: &self.text, b: CstBuilder::default(), scratch: Vec::new()${reuseInit} };
        match p.parse_${ir.entry}() {
            Some(fr) if p.pos == p.toks.len() && fr.present => Some((p, fr.h)),
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
  const matchTemplate = ir.tpl ? `    // interp: the Pratt rule to parse each \`\${…}\` hole — the CALLER's rule
    // (Expr for expression templates, Type for template literal types), mirroring
    // the reference parser's currentPrattContext ?? findExprRule().
    fn match_template(&mut self, interp: fn(&mut Parser<'a, B>) -> Option<Spanned<B::H>>) -> Option<Spanned<B::H>> {
        let t = self.peek()?;
        if t.kid != ${kidOf(ids, "$templateHead")} { return None; }
        let save = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
        self.push_leaf(${ttIdOf(ar, '$templateHead')}, self.pos as u32, t.off, t.end); self.pos += 1;
        loop {
            let expr = match interp(self) { Some(e) => e, None => { self.pos = save; self.scratch.truncate(sb); self.b.restore(ck); return None; } };
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
    /// When false, Doc::edit skips subtree reuse (fresh parse). Default: no shift.
    const SUPPORTS_SHIFT: bool = false;
    /// When true, validate runs treeEq against a full CST (CstBuilder only).
    const SUPPORTS_TREE_EQ: bool = false;
    /// Shift handle spans by edit deltas. Leaves may return a re-encoded handle.
    /// Engine never touches arena kid encoding directly (D0 R5).
    #[inline(always)]
    fn shift(&mut self, h: Self::H, _byte_delta: isize, _tok_delta: isize) -> Self::H { h }
    /// Arena reclaim probe (CstBuilder). Default: never reclaim.
    #[inline(always)]
    fn should_reclaim(&self, _root: Self::H, _baseline: usize) -> bool { false }
    /// Arena node count for baseline after fresh parse. Default 0.
    #[inline(always)]
    fn arena_len(&self) -> usize { 0 }
    /// Entry-level children of a root (shape-A reuse). Default empty.
    #[inline(always)]
    fn root_kids(&self, _root: Self::H) -> Vec<Self::H> { Vec::new() }
    /// Kid at relative index under root (shape-B SEGK). Default dummy.
    #[inline(always)]
    fn root_kid_at(&self, _root: Self::H, _idx: usize) -> Self::H { Self::dummy_h() }
    /// Rule id of a rule-node handle (reuse finish). Default 0.
    #[inline(always)]
    fn rule_id_of(&self, _h: Self::H) -> u16 { 0 }
    /// D1 EntryMeta ↔ arena asserts (CstBuilder). Default no-op.
    #[inline(always)]
    fn validate_entries(&self, _entries: &[EntryMeta], _root: Self::H) {}
${shapeB ? `    #[inline(always)]
    fn validate_entry_segs(&self, _entries: &[EntryMeta], _segs: &[Seg], _root: Self::H) {}
` : ``}    /// treeEq oracle (CstBuilder). Default true (unused when SUPPORTS_TREE_EQ=false).
    #[inline(always)]
    fn check_tree_eq(&self, _text: &str, _root: Option<Self::H>) -> bool { true }
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
    const SUPPORTS_SHIFT: bool = ${reuse ? 'true' : 'false'};
    const SUPPORTS_TREE_EQ: bool = true;
    #[inline(always)]
    fn dummy_h() -> i32 { 0 }
${reuse ? `    #[inline(always)]
    fn shift(&mut self, h: i32, byte_delta: isize, tok_delta: isize) -> i32 {
        if h < 0 {
            let (ti, tt) = decode_leaf(h);
            encode_leaf((ti as isize + tok_delta) as u32, tt)
        } else {
            shift_subtree(&mut self.nodes, &mut self.kids, h, byte_delta, tok_delta);
            h
        }
    }
    #[inline(always)]
    fn should_reclaim(&self, root: i32, baseline: usize) -> bool {
        should_reclaim_arena(&self.nodes, &self.kids, root, baseline)
    }
    #[inline(always)]
    fn arena_len(&self) -> usize { self.nodes.len() }
    #[inline(always)]
    fn root_kids(&self, root: i32) -> Vec<i32> {
        let old = &self.nodes[root as usize];
        (0..old.kid_count).map(|i| self.kids[old.kid_start as usize + i as usize]).collect()
    }
    #[inline(always)]
    fn root_kid_at(&self, root: i32, idx: usize) -> i32 {
        let old = &self.nodes[root as usize];
        self.kids[old.kid_start as usize + idx]
    }
    #[inline(always)]
    fn rule_id_of(&self, h: i32) -> u16 { self.nodes[h as usize].rule_id }
    #[inline(always)]
    fn validate_entries(&self, entries: &[EntryMeta], root: i32) {
        assert_entries_vs_nodes(entries, &self.nodes, &self.kids, root);
    }
${shapeB ? `    #[inline(always)]
    fn validate_entry_segs(&self, entries: &[EntryMeta], segs: &[Seg], root: i32) {
        assert_entries_vs_segs(entries, segs, &self.nodes, &self.kids, root);
    }
` : ``}    #[inline(always)]
    fn check_tree_eq(&self, text: &str, root: Option<i32>) -> bool {
        check_tree_eq_arena(text, &self.nodes, &self.kids, root)
    }
` : `    #[inline(always)]
    fn arena_len(&self) -> usize { self.nodes.len() }
    #[inline(always)]
    fn check_tree_eq(&self, text: &str, root: Option<i32>) -> bool {
        check_tree_eq_arena(text, &self.nodes, &self.kids, root)
    }
`}    #[inline(always)]
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
    fn arena_len(&self) -> usize { self.nodes.len() }
    #[inline(always)]
    fn rule_id_of(&self, h: i32) -> u16 { if h < 0 { 0 } else { self.nodes[h as usize].rule_id } }
    #[inline(always)]
    fn root_kids(&self, root: i32) -> Vec<i32> {
        if root < 0 { return Vec::new(); }
        let old = &self.nodes[root as usize];
        (0..old.kid_count).map(|i| self.kids[old.kid_start as usize + i as usize]).collect()
    }
    #[inline(always)]
    fn root_kid_at(&self, root: i32, idx: usize) -> i32 {
        let old = &self.nodes[root as usize];
        self.kids[old.kid_start as usize + idx]
    }
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
    /// Match a single '>' even when the lexer tokenized a longer '>'-led punct
    /// (>>, >=, >>>, >>=, >>>=): consume the leading '>' and splice the
    /// remainder back into toks as the next token (mirrors the reference
    /// emitter matchPuLitGT).
    #[inline(always)]
    fn match_gt(&mut self, tt_id: u16) -> bool {
        match self.peek() {
            Some(t) if t.lid == ${lidOf(ids, '>')} => { self.push_leaf(tt_id, self.pos as u32, t.off, t.end); self.pos += 1; true }
            Some(t) => {
                let n = (t.end - t.off) as usize;
                if n > 1 && self.src.as_bytes()[t.off as usize] == b'>' {
                    self.push_leaf(tt_id, self.pos as u32, t.off, t.off + 1);
                    let rem_lid = lid_of(&self.src[(t.off + 1) as usize..t.end as usize]);
                    self.toks.insert(self.pos + 1, Tok { off: t.off + 1, end: t.end, kid: 0, lid: rem_lid, nl: t.nl });
                    self.toks[self.pos] = Tok { off: t.off, end: t.off + 1, kid: 0, lid: ${lidOf(ids, '>')}, nl: t.nl };
                    self.pos += 1;
                    true
                } else { false }
            }
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
        let sp0 = self.pos; let sb0 = self.scratch.len(); let ck0 = self.b.checkpoint();
        if !elem(self) { self.pos = sp0; self.scratch.truncate(sb0); self.b.restore(ck0); return true; }
        loop {
            let sp = self.pos; let sb = self.scratch.len(); let ck = self.b.checkpoint();
            if !self.match_lit(delim, ${punctId}) { self.pos = sp; self.scratch.truncate(sb); self.b.restore(ck); break; }
            let sp2 = self.pos; let sb2 = self.scratch.len(); let ck2 = self.b.checkpoint();
            if !elem(self) { self.pos = sp2; self.scratch.truncate(sb2); self.b.restore(ck2); break; }
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
        Some(fr) if p.pos == p.toks.len() && fr.present => Some(fr.h),
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

// ─── Shape AST codegen (SH3-1: RD full constructs + toy-scale Pratt) ──────────

type RustShapeUnionMember = { variant: string; ty: string; boxed: boolean };
type RustShapeUnion = { name: string; alias?: string; members: RustShapeUnionMember[] };

function rustShapeIdent(name: string): string {
  const out = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(out) ? `_${out}` : out;
}

function rustShapeUnionName(ruleName: string): string {
  return `${rustShapeIdent(ruleName)}Shape`;
}

function rustShapeScalar(fn: string): string {
  if (fn === 'number') return 'f64';
  if (fn === 'boolean') return 'bool';
  return 'String';
}

function rustShapeHint(hint: string | string[] | undefined, known?: Set<string>): string {
  const h = Array.isArray(hint) ? hint[0] : hint;
  if (!h || h === 'unknown') return 'AstValue';
  if (h === 'string' || h === 'Identifier') return 'String';
  if (h === 'number' || h === 'Number') return 'f64';
  if (h === 'boolean' || h === 'Boolean') return 'bool';
  const id = rustShapeIdent(h);
  const shape = `${id}Shape`;
  if (known?.has(id)) return id;
  if (known?.has(shape)) return shape;
  return 'AstValue';
}

function rustShapeFieldType(field: FieldDecl, known?: Set<string>): string {
  let ty = field.bind === 'opText' ? 'String' : rustShapeHint(field.typeHint, known);
  const isList = typeof field.bind === 'object' && 'from' in field.bind && field.bind.from === 'list';
  const scalar = ty === 'String' || ty === 'f64' || ty === 'bool' || ty === 'AstValue';
  if (isList) ty = `Vec<${ty}>`;
  else if (!scalar) ty = `Box<${ty}>`;
  if (field.optional) ty = `Option<${ty}>`;
  return ty;
}

function rustLeafDropped(ttype: string, leaves: Record<string, TokenLeafPolicy>): boolean {
  return leaves[ttype]?.action === 'drop';
}

function collectRustShapeNodes(shapeIR: ShapeIR): Map<string, NodeShape> {
  const out = new Map<string, NodeShape>();
  const walk = (shape: RuleShape): void => {
    if (shape.kind === 'node') out.set(shape.type, shape);
    else if (shape.kind === 'choice') for (const arm of shape.arms) walk(arm.shape);
    else if (shape.kind === 'pratt') {
      for (const key of ['atom', 'group', 'nudSeq', 'nudCapped', 'prefix', 'binary', 'postfix', 'led', 'postfixTok', 'template'] as const) {
        const slot = shape[key];
        if (slot && typeof slot === 'object' && 'kind' in slot && slot.kind !== 'rule') walk(slot as RuleShape);
      }
    }
  };
  for (const rule of shapeIR.rules) walk(rule.shape);
  return out;
}

function rustShapeUnions(shapeIR: ShapeIR): RustShapeUnion[] {
  const out: RustShapeUnion[] = [];
  const aliasesUsed = new Set<string>();
  for (const rule of shapeIR.rules) {
    if (rule.shape.kind === 'choice') {
      const members: RustShapeUnionMember[] = [];
      const seen = new Set<string>();
      for (const arm of rule.shape.arms) {
        const member: RustShapeUnionMember = arm.shape.kind === 'node'
          ? { variant: rustShapeIdent(arm.shape.type), ty: rustShapeIdent(arm.shape.type), boxed: true }
          : { variant: rustShapeIdent(arm.name), ty: 'AstValue', boxed: false };
        if (!seen.has(member.variant)) {
          seen.add(member.variant);
          members.push(member);
        }
      }
      let alias: string | undefined;
      if (rule.name === 'Stmt' && !aliasesUsed.has('Statement')) {
        alias = 'Statement';
        aliasesUsed.add('Statement');
      }
      out.push({ name: rustShapeUnionName(rule.name), alias, members });
    } else if (rule.shape.kind === 'pratt') {
      const members: RustShapeUnionMember[] = [];
      for (const tok of (portableRule(shapeIR, rule.name) as PrattRule).nudToks) {
        const policy = shapeIR.leaves[tok];
        if (policy?.action === 'leafValue') {
          members.push({ variant: rustShapeIdent(tok), ty: rustShapeScalar(policy.fn), boxed: false });
        }
      }
      for (const slot of [rule.shape.prefix, rule.shape.binary, rule.shape.postfix]) {
        if (slot?.kind === 'node' && !members.some((m) => m.variant === rustShapeIdent(slot.type))) {
          members.push({ variant: rustShapeIdent(slot.type), ty: rustShapeIdent(slot.type), boxed: true });
        }
      }
      members.push({ variant: 'Keep', ty: 'AstValue', boxed: false });
      let alias: string | undefined;
      if (rule.name === 'Expr' && !aliasesUsed.has('Expression')) {
        alias = 'Expression';
        aliasesUsed.add('Expression');
      }
      out.push({
        name: rustShapeUnionName(rule.name),
        alias,
        members,
      });
    }
  }
  return out;
}

let _rustShapeParserIR: ParserIR | null = null;
function portableRule(_shapeIR: ShapeIR, name: string): RdRule | PrattRule {
  const rule = _rustShapeParserIR?.rules.find((r) => r.name === name);
  if (!rule) throw new Error(`shape rust emit: missing IR rule ${name}`);
  return rule;
}

// ── Step-level FIRST pre-filters (SH3-5 O5) ────────────────────────────────
// Per-rule leading FIRST (null = unknown/unpredictable), built once per emit.
// Soundness: a rule with a known FIRST is NON-nullable — a nullable alt is
// always seqFirst-unpredictable (null), which poisons the union. Guards are
// therefore pure pre-filters: reject ⇒ the walk would have failed anyway.
let _rustShapeRuleFirst: Map<string, FirstSig> | null = null;

/** FIRST of a step sequence (sound superset; null = unknown → no guard). */
function rustShapeFirstOfSteps(steps: Step[]): FirstSig {
  const rf = _rustShapeRuleFirst;
  if (!rf) return null;
  const lits = new Set<string>();
  const toks = new Set<string>();
  // 'done' = a consuming step fixed the FIRST; 'nullable' = may derive ε (keep
  // folding into the next step); 'unknown' = give up (null).
  const walkSeq = (xs: Step[]): 'done' | 'nullable' | 'unknown' => {
    for (const s of xs) {
      const r = walkStep(s);
      if (r !== 'nullable') return r;
    }
    return 'nullable';
  };
  const walkStep = (s: Step): 'done' | 'nullable' | 'unknown' => {
    switch (s.t) {
      case 'lit': lits.add(s.value); return 'done';
      case 'tok': toks.add(s.name); return 'done';
      case 'altlit': s.opts.forEach((o) => lits.add(o.value)); return 'done';
      case 'rule':
      case 'ruleBp': {
        const f = rf.get(s.name);
        if (f == null) return 'unknown';
        f.lits.forEach((x) => lits.add(x));
        f.toks.forEach((x) => toks.add(x));
        return 'done';
      }
      case 'seq':
      case 'suppress': return walkSeq(s.steps);
      case 'not':
      case 'sameLine': return 'nullable'; // zero-width: consumes nothing
      case 'opt': return walkSeq(s.steps) === 'unknown' ? 'unknown' : 'nullable';
      case 'star': return walkSeq([s.step]) === 'unknown' ? 'unknown' : 'nullable';
      case 'sep': return walkStep(s.elem) === 'unknown' ? 'unknown' : 'nullable';
      case 'alt': {
        let sawBranch = false;
        for (const b of s.branches) {
          const r = walkSeq(b);
          if (r === 'unknown') return 'unknown';
          if (r === 'done') sawBranch = true;
        }
        // all-nullable (or empty) alt contributes its FIRST and stays nullable
        return sawBranch ? 'done' : 'nullable';
      }
    }
    return 'unknown';
  };
  const r = walkSeq(steps);
  // Fully-nullable seqs (derive ε) would succeed even when the guard rejects
  // (star/sep semantics diverge), so they get no guard.
  if (r === 'unknown' || r === 'nullable') return null;
  return { lits: [...lits], toks: [...toks] };
}

/** Build per-rule leading FIRST for all parser rules (rd unions + pratt nud). */
function buildRustShapeRuleFirst(ir: ParserIR): Map<string, FirstSig> {
  const out = new Map<string, FirstSig>();
  for (const rule of ir.rules) {
    if (rule.kind === 'rd') {
      if (rule.altFirst.some((f) => f === null)) {
        out.set(rule.name, null);
        continue;
      }
      const lits = new Set<string>();
      const toks = new Set<string>();
      for (const f of rule.altFirst) {
        f!.lits.forEach((x) => lits.add(x));
        f!.toks.forEach((x) => toks.add(x));
      }
      out.set(rule.name, { lits: [...lits], toks: [...toks] });
      continue;
    }
    // pratt: a parse must nud — leading FIRST is the nud dispatch set.
    const lits = new Set<string>();
    const toks = new Set<string>();
    let unknown = false;
    for (const t of rule.nudToks) toks.add(t);
    for (const p of rule.prefix) lits.add(p.op);
    for (const b of rule.nudBrackets) lits.add(b.first);
    for (const f of [...rule.nudSeqFirst, ...rule.nudCappedFirst]) {
      if (f === null) { unknown = true; break; }
      f.lits.forEach((x) => lits.add(x));
      f.toks.forEach((x) => toks.add(x));
    }
    if (!unknown && ir.tpl && rule.nudToks.includes(ir.tpl.token)) toks.add('$templateHead');
    out.set(rule.name, unknown ? null : { lits: [...lits], toks: [...toks] });
  }
  return out;
}


function rustShapeRuleType(rule: ShapeIRRule): string {
  // Runtime is AstValue-centric (RD kids / keep / unknown). Typed structs remain for API docs + gates.
  return 'AstValue';
}

function rustShapeSpanFields(spans: ShapeSpec['spans']): string {
  if (spans === 'none') return '';
  const ty = spans === 'optional' ? 'Option<usize>' : 'usize';
  return `\n    pub off: ${ty},\n    pub end: ${ty},`;
}

/** M-A1.4-S5: streaming node completion — push the structure event and return
 *  the node's source span as the placeholder value. ledNotLeftLeaf guards read
 *  shape_head_text(left): the span text matches the tree-mode head-text for
 *  leaf atoms (e.g. `void` in `void##x`), keeping accept decisions identical. */
function rustStreamFinish(typ: string, offExpr: string, endExpr: string, alt = '0'): string {
  return `{
            let __so = (${offExpr}) as usize;
            let __se = (${endExpr}) as usize;
            if self.emit_events { self.events.push(StreamEvent { id: self.events.len() as u32, typ: ${typ}, alt: ${alt}, off: __so as u32, end: __se as u32 }); }
            SVal::Str(__so as u32, (__se - __so) as u32)
        }`;
}

function rustShapeNodeObjectExpr(
  node: NodeShape,
  _baseExpr: string,
  _opExpr: string,
  _spans: ShapeSpec['spans'],
  offExpr: string,
  endExpr: string,
  _leftExpr?: string,
): string {
  // M-A1.2/S5: streaming-only — node completion emits the structure event
  // (field computation and DynObj construction were tree-mode, removed).
  return rustStreamFinish(J(node.type), offExpr, endExpr);
}

function emitRustShapeTypes(ir: ParserIR, shapeIR: ShapeIR): string {
  _rustShapeParserIR = ir;
  _rustShapeParserIR = null;
  const lines: string[] = [
    '// ─── Shape AST runtime (arena values, SH3-6) ──────────────────────────────',
    'fn _shape_json_string(value: &str, out: &mut String) {',
    "    out.push('\"');",
    '    for c in value.chars() { match c {',
    "        '\"' => out.push_str(\"\\\\\\\"\"), '\\\\' => out.push_str(\"\\\\\\\\\"), '\\n' => out.push_str(\"\\\\n\"),",
    "        '\\r' => out.push_str(\"\\\\r\"), '\\t' => out.push_str(\"\\\\t\"), c if c < ' ' => out.push_str(&format!(\"\\\\u{:04x}\", c as u32)),",
    '        c => out.push(c),',
    '    }}',
    "    out.push('\"');",
    '}',
    '// Arena value: every variant Copy — speculative truncate on restore runs no',
    '// drop glue. M15 slim: Str is a (off, len) span into AstArena.src, not a',
    '// borrowed slice — the enum drops from 24B to 16B (max payload 8B).',
    '#[derive(Clone, Copy, Debug)]',
    "pub enum SVal<'a> {",
    '    Null,',
    '    Bool(bool),',
    '    Number(f64),',
    '    /// (byte offset, byte length) into AstArena.src.',
    '    Str(u32, u32),',
    '    OwnStr(u32),',
    '    Node(u32),',
    '    List(u32, u32),',
    '    /// Packed TNode range into AstArena.node_lists (each element = (tag<<24)|idx).',
    '    /// Only lists whose elements are ALL TNode use this slab — 4B/element vs 16B.',
    '    NodeList(u32, u32),',
    '    Partial(u32),',
    '    /// Typed custom node: (customs type tag, index into the customs-owned arena).',
    '    /// JSON is written via ShapeCustoms::write_tnode_json (M2 typed direct-emit).',
    '    TNode(u16, u32),',
    '    /// Keeps the (now payload-less) lifetime parameter occupied: every existing',
    '    /// SVal<\'a> signature stays valid. ZST — size is still 16B.',
    '    #[doc(hidden)]',
    "    _Marker(std::marker::PhantomData<&'a ()>),",
    '}',
    '#[derive(Debug)]',
    "struct DynObj { typ: &'static str, fields: (u32, u32) }",
    '#[derive(Clone, Copy, Debug)]',
    "struct PartialRec<'a> { tag: &'static str, mode: &'static str, value: SVal<'a> }",
    '#[derive(Debug, Default)]',
    "pub struct AstArena<'a> {",
    "    /// Source text every SVal::Str span indexes into (M15). Default \"\" —",
    '    /// any Str read on a default-built arena fails loud (out of bounds).',
    "    pub src: &'a str,",
    "    pub lists: Vec<SVal<'a>>,",
    "    pub node_lists: Vec<u32>,",
    "    pub fields: Vec<(&'static str, SVal<'a>)>,",
    '    nodes: Vec<DynObj>,',
    "    partials: Vec<PartialRec<'a>>,",
    '    /// Monotonic count of mk_partial calls (never decremented, even on txn',
    '    /// rollback). Zero means no Partial marker exists anywhere in the arena —',
    '    /// shape_fold_kids can skip its recursive has_partial scan (M21).',
    '    pub partial_count: usize,',
    '    strings: Vec<String>,',
    '}',
    "impl<'a> AstArena<'a> {",
    "    pub fn mk_own_str(&mut self, s: &str) -> SVal<'a> { self.strings.push(s.to_owned()); SVal::OwnStr((self.strings.len() - 1) as u32) }",
    "    pub fn mk_partial(&mut self, tag: &'static str, mode: &'static str, value: SVal<'a>) -> SVal<'a> { self.partial_count += 1; self.partials.push(PartialRec { tag, mode, value }); SVal::Partial((self.partials.len() - 1) as u32) }",
    "    pub fn typ_of(&self, v: SVal<'a>) -> &'static str { if let SVal::Node(i) = v { self.nodes[i as usize].typ } else { \"\" } }",
    "    pub fn fields_of(&self, v: SVal<'a>) -> &[(&'static str, SVal<'a>)] {",
    '        if let SVal::Node(i) = v {',
    '            let (fs, fl) = self.nodes[i as usize].fields;',
    '            &self.fields[fs as usize..(fs + fl) as usize]',
    '        } else { &[] }',
    '    }',
    "    pub fn list_of(&self, v: SVal<'a>) -> &[SVal<'a>] {",
    '        if let SVal::List(s, l) = v { &self.lists[s as usize..(s + l) as usize] } else { &[] }',
    '    }',
    "    pub fn obj_field(&self, v: SVal<'a>, name: &'static str) -> SVal<'a> {",
    '        self.fields_of(v).iter().find(|(k, _)| *k == name).map(|(_, x)| *x).unwrap_or(SVal::Null)',
    '    }',
    "    pub fn fields_range_of(&self, v: SVal<'a>) -> (usize, usize) {",
    '        if let SVal::Node(i) = v { let (fs, fl) = self.nodes[i as usize].fields; (fs as usize, fl as usize) } else { (0, 0) }',
    '    }',
    "    /// Span → source slice (M15). The slice keeps the source lifetime 'a,",
    '    /// unlike str_of which reborrows through &self.',
    "    pub fn str_span(&self, off: u32, len: u32) -> &'a str {",
    '        &self.src[off as usize..(off + len) as usize]',
    '    }',
    "    pub fn str_of(&self, v: SVal<'a>) -> &str {",
    '        match v {',
    '            SVal::Str(o, l) => &self.src[o as usize..(o + l) as usize],',
    '            SVal::OwnStr(i) => &self.strings[i as usize],',
    '            _ => "",',
    '        }',
    '    }',
    '}',
    'fn write_sval_json<\'a, C: ShapeCustoms<\'a>>(ar: &AstArena<\'a>, customs: &C, v: SVal<\'a>, out: &mut String) {',
    '    match v {',
    '        SVal::Null => out.push_str("null"),',
    '        SVal::Bool(b) => out.push_str(if b { "true" } else { "false" }),',
    '        SVal::Number(n) => out.push_str(&n.to_string()),',
    '        SVal::Str(o, l) => _shape_json_string(&ar.src[o as usize..(o + l) as usize], out),',
    '        SVal::OwnStr(i) => _shape_json_string(&ar.strings[i as usize], out),',
    '        SVal::Node(i) => {',
    '            let o = &ar.nodes[i as usize];',
    "            out.push('{');",
    '            let mut wrote = false;',
    '            if !o.typ.is_empty() { _shape_json_string("type", out); out.push(\':\'); _shape_json_string(o.typ, out); wrote = true; }',
    '            let (fs, fl) = o.fields;',
    '            for (k, v) in &ar.fields[fs as usize..(fs + fl) as usize] { if wrote { out.push(\',\'); } _shape_json_string(k, out); out.push(\':\'); write_sval_json(ar, customs, *v, out); wrote = true; }',
    "            out.push('}');",
    '        }',
    '        SVal::List(s, l) => {',
    "            out.push('[');",
    '            for (i, v) in ar.lists[s as usize..(s + l) as usize].iter().enumerate() { if i > 0 { out.push(\',\'); } write_sval_json(ar, customs, *v, out); }',
    "            out.push(']');",
    '        }',
    '        SVal::NodeList(s, l) => {',
    "            out.push('[');",
    '            for (i, e) in ar.node_lists[s as usize..(s + l) as usize].iter().enumerate() { if i > 0 { out.push(\',\'); } customs.write_tnode_json(ar, (e >> 24) as u16, e & 0xFFFFFF, out); }',
    "            out.push(']');",
    '        }',
    '        SVal::Partial(i) => {',
    '            let p = &ar.partials[i as usize];',
    '            out.push_str("{\\"__shapePartial\\":"); _shape_json_string(p.tag, out);',
    '            out.push_str(",\\"mode\\":"); _shape_json_string(p.mode, out);',
    '            out.push_str(",\\"value\\":"); write_sval_json(ar, customs, p.value, out);',
    "            out.push('}');",
    '        }',
    '        SVal::TNode(tag, idx) => customs.write_tnode_json(ar, tag, idx, out),',
    '        SVal::_Marker(_) => {},',
    '    }',
    '}',
    "/// M-A1.4-S3: a committed node-completion event from the streaming parse.\n",
    "/// id = per-parse event index (continuous after checkpoint truncation).\n",
    "#[derive(Clone, Copy, Debug)]\n",
    "pub struct StreamEvent {\n",
    "    pub id: u32,        // per-parse event index\n",
    "    pub typ: &'static str,\n",
    "    pub alt: u32,\n",
    "    pub off: u32,\n",
    "    pub end: u32,\n",
    "}\n",
    "pub struct AstRoot<'a> { pub root: SVal<'a>, pub arena: AstArena<'a>, pub events: Vec<StreamEvent> }",
    "impl<'a> AstRoot<'a> {",
    '    pub fn write_shape_json_with<C: ShapeCustoms<\'a>>(&self, customs: &C, out: &mut String) { write_sval_json(&self.arena, customs, self.root, out); }',
    '    pub fn to_shape_json_with<C: ShapeCustoms<\'a>>(&self, customs: &C) -> String { let mut out = String::new(); self.write_shape_json_with(customs, &mut out); out }',
    '    pub fn to_shape_json(&self) -> String { self.to_shape_json_with(&DefaultShapeCustoms) }',
    '}',
  ];
  return lines.join('\n');
}

/** M15: leaves are source spans — offExpr/lenExpr are u32 code fragments.
 *  leaf_number/leaf_boolean still go through the customs hook with a source
 *  slice (TS overrides leaf_number); ident/bigint leaves construct the span
 *  directly (the identity hooks were removed with tree mode, S5). */
function rustShapeLeafAstExpr(policy: TokenLeafPolicy, off: string, len: string): string {
  const slice = `&self.src[${off} as usize..(${off} + ${len}) as usize]`;
  if (policy.action !== 'leafValue') return `SVal::Str(${off}, ${len})`;
  if (policy.fn === 'number') return `SVal::Number(self.customs.leaf_number(${slice}))`;
  if (policy.fn === 'boolean') return `SVal::Bool(self.customs.leaf_boolean(${slice}))`;
  return `SVal::Str(${off}, ${len})`; // bigint/ident: leaf hook is identity (M15)
}

/** Recursive RD step renderer — arena stack model (SH3-6): every sink is the
 *  parser's arena vals stack; per-construct "vecs" are base watermarks. */
function emitRustAstRdAltSteps(
  steps: Step[],
  ids: LexIdPlan,
  leaves: Record<string, TokenLeafPolicy>,
  selfRule?: string,
  selfRuleUseBp?: boolean,
): { ok: string; okVar: string } {
  const visible = (s: Step): boolean => {
    switch (s.t) {
      case 'lit': return !rustLeafDropped(s.ttype, leaves);
      case 'tok': return !rustLeafDropped(s.name, leaves);
      case 'rule':
      case 'ruleBp': return true;
      case 'star': return visible(s.step);
      case 'opt':
      case 'seq':
      case 'suppress': return s.steps.some(visible);
      case 'sep': return visible(s.elem);
      case 'altlit': return s.opts.some((o) => !rustLeafDropped(o.ttype, leaves));
      case 'alt': return s.branches.some((b) => b.some(visible));
      case 'not':
      case 'sameLine': return false;
    }
  };
  /** M18: txn purity — true when the step's OUTER trace is confined to
   *  pos/vals (so a surrounding txn can use the 2-field light snapshot).
   *  lit/tok/altlit touch pos + vals only; sameLine is read-only; not is
   *  self-restoring (full ck/restore inside) and externally transparent;
   *  suppress self-restores suppress_next. Visible star/opt/sep/alt write
   *  the arena via shape_pack_range/shape_list_from on success paths —
   *  impure. rule/ruleBp call parse_ast_* which may write the arena
   *  (customs/pack) — always impure. */
  const pure = (s: Step): boolean => {
    switch (s.t) {
      case 'lit':
      case 'tok':
      case 'altlit': return true;
      case 'sameLine': return true;
      case 'not': return true;
      case 'suppress': return s.steps.every(pure);
      case 'seq': return s.steps.every(pure);
      case 'star': return !visible(s.step) && pure(s.step);
      case 'opt': return !s.steps.some(visible) && s.steps.every(pure);
      case 'sep': return !visible(s.elem) && pure(s.elem);
      case 'alt': return !visible(s) && s.branches.every((b) => b.every(pure));
      case 'rule':
      case 'ruleBp': return false;
    }
  };
  /** M18: txn snapshot pair — pure guarded steps get a light snapshot of the
   *  three mutable channels a pure txn can touch (pos, vals, ap_stack — the
   *  alt-branch shell pushes ap_stack inside the guarded region, so the light
   *  restore must rewind it too); anything that can touch the arena, suppress
   *  state or capped keeps the full 10-field ShapeCk. */
  const txnCk = (v: string, light: boolean): string =>
    light ? `let ${v} = (self.pos, self.vals.len(), self.ap_stack.len());` : `let ${v} = self.shape_ck();`;
  const txnRestore = (v: string, light: boolean): string =>
    light ? `self.pos = ${v}.0; self.vals.truncate(${v}.1); self.ap_stack.truncate(${v}.2);` : `self.shape_restore(${v});`;
  let localId = 0;
  const local = (stem: string): string => `_shape_${stem}_${localId++}`;
  /** FIRST pre-filter over the current token; null when not worth guarding. */
  const firstGuard = (f: FirstSig, nAlts?: number): string | null =>
    isFirstGuardable(f, nAlts) ? firstCond(f, 't', ids) : null;
  const emitSteps = (xs: Step[], okVar: string): string =>
    xs.map((x) => emitStep(x, okVar)).join('\n');
  const emitStep = (s: Step, okVar: string): string => {
    switch (s.t) {
      case 'lit': {
        // M15: a consumed literal's text is exactly its token span in src.
        const push = rustLeafDropped(s.ttype, leaves) ? '' : `let _lt = self.toks[self.pos - 1]; self.vals.push(SVal::Str(_lt.off, _lt.end - _lt.off));`;
        const take = s.value === '>' ? `self.take_gt()` : `self.take_lit(${lidOf(ids, s.value)})`;
        return `if ${okVar} { if ${take}.is_none() { ${okVar} = false; } else { ${push} } }`;
      }
      case 'tok': {
        const t = local('tok');
        if (rustLeafDropped(s.name, leaves)) {
          return `if ${okVar} { if self.take_span(${kidOf(ids, s.name)}).is_none() { ${okVar} = false; } }`;
        }
        return `if ${okVar} { match self.take_span(${kidOf(ids, s.name)}) { Some((${t}_o, ${t}_l)) => { self.vals.push(${rustShapeLeafAstExpr(leaves[s.name] ?? { action: 'keep' }, `${t}_o`, `${t}_l`)}); } None => { ${okVar} = false; } } }`;
      }
      case 'rule': {
        const v = local('rule');
        const call = selfRuleUseBp && s.name === selfRule
          ? `self.parse_ast_${s.name}_bp(1)`
          : `self.parse_ast_${s.name}()`;
        return `if ${okVar} { match ${call} { Some(${v}) => { self.vals.push(${v}); } None => { ${okVar} = false; } } }`;
      }
      case 'ruleBp': {
        const v = local('rulebp');
        return `if ${okVar} { match self.parse_ast_${s.name}_bp(${s.bp}) { Some(${v}) => { self.vals.push(${v}); } None => { ${okVar} = false; } } }`;
      }
      case 'seq':
        return emitSteps(s.steps, okVar);
      case 'sameLine':
        return `if ${okVar} { match self.toks.get(self.pos) { Some(t) if !t.nl => {} _ => { ${okVar} = false; } } }`;
      case 'not': {
        // Gate on okVar to match TS `&&` short-circuit — otherwise probe still
        // runs after a failed predecessor and can re-enter recursive rules.
        const poke = local('probe');
        const body = emitSteps(s.steps, poke);
        const light = s.steps.every(pure);
        return `if ${okVar} {
            ${txnCk('_ck', light)}
            let mut ${poke} = true;
            ${body}
            let _probe_hit = ${poke};
            ${txnRestore('_ck', light)}
            if _probe_hit { ${okVar} = false; }
        }`;
      }
      case 'suppress': {
        const sok = local('sup_ok');
        return `if ${okVar} {
            let _sn_save = self.suppress_next;
            self.set_suppress_next(Some(&[${s.connectors.map((c) => lidOf(ids, c)).join(', ')}u16][..]));
            let mut ${sok} = true;
            ${emitSteps(s.steps, sok)}
            self.set_suppress_next(_sn_save);
            if !${sok} { ${okVar} = false; }
        }`;
      }
      case 'altlit': {
        const matched = local('altlit');
        const arms = s.opts.map((o) => {
          const push = visible(s)
            ? (rustLeafDropped(o.ttype, leaves)
              ? `self.vals.push(SVal::Null);`
              : `self.vals.push(SVal::Str(t.off, t.end - t.off));`)
            : '';
          return `${lidOf(ids, o.value)} => { self.pos += 1; ${push} ${matched} = true; }`;
        }).join('\n                    ');
        return `if ${okVar} {
            let mut ${matched} = false;
            if let Some(t) = self.toks.get(self.pos).copied() {
                match t.lid {
                    ${arms}
                    _ => {}
                }
            }
            if !${matched} { ${okVar} = false; }
        }`;
      }
      case 'alt': {
        // Must short-circuit on okVar — ungated alt/star/opt closed the
        // ClassMember↔Block↔Stmt↔Decl infinite recursion on shallow inputs.
        const flag = local('alt_ok');
        const tries = s.branches.map((b, i) => {
          const ab = local('alt_base');
          const bok = local('br');
          const body = emitSteps(b, bok);
          const push = visible(s) ? `self.shape_pack_push(${ab});` : '';
          // FIRST pre-filter: a branch whose leading set misses the current
          // token is skipped without ck + walk + restore (IR-annotated firsts).
          const fguard = firstGuard(s.firsts?.[i] ?? null, s.branches.length);
          const cond = fguard
            ? `!${flag} && (match self.toks.get(self.pos) { Some(t) => ${fguard}, None => false })`
            : `!${flag}`;
          const light = b.every(pure);
          return `if ${cond} {
                ${txnCk('_ck', light)}
                self.ap_stack.push(${i});
                let ${ab} = self.vals.len();
                let mut ${bok} = true;
                ${body}
                if ${bok} {
                    ${push}
                    ${flag} = true;
                } else {
                    ${txnRestore('_ck', light)}
                }
            }`;
        }).join('\n            ');
        return `if ${okVar} {
            let mut ${flag} = false;
            ${tries}
            if !${flag} { ${okVar} = false; }
        }`;
      }
      case 'star': {
        const ob = local('star_base');
        const sb = local('star_vbase');
        const sok = local('star_ok');
        const body = emitStep(s.step, sok);
        const add = visible(s.step) ? `self.shape_pack_push(${sb});` : '';
        const finish = visible(s.step) ? `let _lst = self.shape_list_from(${ob}); self.vals.push(_lst);` : '';
        // FIRST pre-filter: skip the doomed exit walk (ck + failed body + restore).
        const fguard = firstGuard(rustShapeFirstOfSteps([s.step]));
        const cont = fguard
          ? `if !(match self.toks.get(self.pos) { Some(t) => ${fguard}, None => false }) { break; }`
          : '';
        const light = pure(s.step);
        return `if ${okVar} {
            let ${ob} = self.vals.len();
            loop {
                ${cont}
                ${txnCk('_ck', light)}
                let ${sb} = self.vals.len();
                let mut ${sok} = true;
                ${body}
                if !${sok} {
                    ${txnRestore('_ck', light)}
                    break;
                }
                ${add}
            }
            ${finish}
        }`;
      }
      case 'opt': {
        // FIRST pre-filter: an absent optional skips ck + walk + restore.
        const ob = local('opt_base');
        const ook = local('opt_ok');
        const body = emitSteps(s.steps, ook);
        const push = s.steps.some(visible)
          ? `if ${ook} { self.shape_pack_push(${ob}) } else { self.vals.push(SVal::Null) }`
          : '';
        const fguard = firstGuard(rustShapeFirstOfSteps(s.steps));
        const light = s.steps.every(pure);
        const inner = `${txnCk('_ck', light)}
            ${body}
            if !${ook} {
                ${txnRestore('_ck', light)}
            }`;
        return `if ${okVar} {
            let ${ob} = self.vals.len();
            let mut ${ook} = true;
            ${fguard ? `if (match self.toks.get(self.pos) { Some(t) => ${fguard}, None => false }) { ${inner} }` : inner}
            ${push}
        }`;
      }
      case 'sep': {
        const ob = local('sep_base');
        const eb = local('sep_vbase');
        const fok = local('first_ok');
        const eok = local('elem_ok');
        const bodyFirst = emitStep(s.elem, fok);
        const bodyElem = emitStep(s.elem, eok);
        const add = visible(s.elem) ? `self.shape_pack_push(${eb});` : '';
        // After first failure: push empty array (zero elems). After success path: move out.
        const finishEmpty = visible(s.elem) ? `self.vals.push(SVal::List(0, 0));` : '';
        const finishMove = visible(s.elem) ? `let _lst = self.shape_list_from(${ob}); self.vals.push(_lst);` : '';
        // FIRST pre-filter on the leading element: absent list skips ck + walk.
        const fguard = firstGuard(rustShapeFirstOfSteps([s.elem]));
        const light = pure(s.elem);
        const attempt = `${txnCk('_ck', light)}
            let ${eb} = self.vals.len();
            let mut ${fok} = true;
            ${bodyFirst}
            if !${fok} {
                ${txnRestore('_ck', light)}
                ${finishEmpty}
            } else {
                ${add}
                loop {
                    let _d = self.pos;
                    if self.take_lit(${lidOf(ids, s.delim)}).is_none() {
                        self.pos = _d;
                        break;
                    }
                    let ${eb} = self.vals.len();
                    let mut ${eok} = true;
                    ${bodyElem}
                    if !${eok} {
                        // trailing delimiter consumed — CST-aligned
                        break;
                    }
                    ${add}
                }
                ${finishMove}
            }`;
        return `if ${okVar} {
            let ${ob} = self.vals.len();
            ${fguard ? `if (match self.toks.get(self.pos) { Some(t) => ${fguard}, None => false }) { ${attempt} } else { ${finishEmpty} }` : attempt}
        }`;
      }
    }
  };
  const okVar = local('steps_ok');
  const body = emitSteps(steps, okVar);
  const light = steps.every(pure);
  return {
    ok: `${txnCk('_txn_ck', light)}
        let mut ${okVar} = true;
        ${body}
        if !${okVar} {
            ${txnRestore('_txn_ck', light)}
        }`,
    okVar,
  };
}


/** Emit the streaming structure event for a custom completion (M-A1.2/S5). */
function rustAstCustomCall(
  fn: string,
  ruleName: string,
  args: {
    /** Statements staging kids before the call (usually ''; kids slice borrows self.vals directly). */
    kidsPrep: string;
    /** `&[SVal]` expression usable after kidsPrep. */
    kidsSlice: string;
    /** Statements staging the alt path ('' when none). */
    altPrep: string;
    /** `&[usize]` expression usable after altPrep. */
    altSlice: string;
    offExpr: string;
    endExpr: string;
    leftExpr?: string;
    opExpr?: string;
    folds?: ParentFold[];
  },
): string {
  // M-A1.2: structure event only — no field computation, no customs call.
  // Control flow (kids staging, fold prep, vals truncate) is preserved.
  const folds = args.folds ?? [];
  const foldPairs = folds.map((f) => `(${J(f.tag)}, ${J(f.into)})`).join(', ');
  const foldPrep = folds.length > 0
    ? `let (__fk, __fs) = Self::shape_fold_kids(&mut self.arena, self.customs, ${args.kidsSlice}, &[${foldPairs}]);`
    : '';
  const call = `{
            let __off = ${args.offExpr};
            let __end = ${args.endExpr};
            ${args.kidsPrep}
            ${args.altPrep}
            ${foldPrep}
            if self.emit_events { self.events.push(StreamEvent { id: self.events.len() as u32, typ: estree_type_of_streaming(${J(fn)}, ${args.altSlice}, ${args.kidsSlice}, ${args.opExpr ? `Some((${args.opExpr}).as_ref())` : 'None'}, None), alt: (${args.altSlice}).first().copied().unwrap_or(0) as u32, off: __off as u32, end: __end as u32 }); }
            SVal::Str(__off as u32, (__end - __off) as u32)
        }`;
  return args.kidsSlice === '&self.vals[_sk_base..]'
    ? `{ let _cv = ${call}; self.vals.truncate(_sk_base); _cv }`
    : call;
}

function emitRustRdMethod(
  rule: RdRule,
  sir: ShapeIRRule,
  ids: LexIdPlan,
  shapeIR: ShapeIR,
): string {
  const leaves = shapeIR.leaves;
  const ret = "SVal<'a>";

  const finishNode = (node: NodeShape, baseExpr: string, offExpr: string): string =>
    rustShapeNodeObjectExpr(node, baseExpr, '(0u32, 0u32)', shapeIR.spans, offExpr, 'self.last_end(' + offExpr + ')', undefined);

  const tryAlt = (altIdx: number, finish: string, guardFirst: boolean): string => {
    const alt = rule.alts[altIdx]!;
    const useGuard = guardFirst && isGuardable(rule.altFirst[altIdx] ?? null, rule.alts.length);
    const guardExpr = useGuard
      ? `_ft.is_some() && { let t = _ft.unwrap(); ${firstCond(rule.altFirst[altIdx]!, 't', ids)} }`
      : 'true';
    const steps = emitRustAstRdAltSteps(alt, ids, leaves);
    const finished = finish.replaceAll('__ALT__', String(altIdx)).replaceAll('__SK__', '_sk_base').replaceAll('__SPOFF__', 'sp_off');
    return `{
            let sp = self.pos;
            let sp_off = self.current_off();
            if ${guardExpr} {
                let _sk_base = self.vals.len();
                let _ap_base = self.ap_stack.len();
                self.ap_stack.push(${altIdx}usize);
                ${steps.ok}
                if ${steps.okVar} {
                    let _shape_finished = ${finished};
                    self.vals.truncate(_sk_base);
                    if _shape_finished.is_some() { self.ap_stack.truncate(_ap_base); return _shape_finished; }
                }
                self.ap_stack.truncate(_ap_base);
                self.pos = sp;
            }
        }`;
  };

  /** Alt composition: disjoint-FIRST rules dispatch via one match on the
   *  current token instead of sequential guard evals (SH3-6 M3).
   *  NOTE: partial-predictive (match on a disjoint subset) measured a
   *  wash-to-loss on this grammar — or-pattern chains don't jump-table and
   *  cost more than the cheap sequential FIRST guards they replace (M6
   *  reverted). */
  const tryAlts = (tries: Array<{ altIdx: number; finish: string }>): string => {
    if (!rule.predictive) {
      return tries.map((t) => tryAlt(t.altIdx, t.finish, true)).join('\n        ');
    }
    const arms = tries.map(({ altIdx, finish }) => {
      const f = rule.altFirst[altIdx]!;
      const pats = [
        ...f.lits.map((l) => `Some((${lidOf(ids, l)}, _))`),
        ...f.toks.map((k) => `Some((_, ${kidOf(ids, k)}))`),
      ].join(' | ');
      const alt = rule.alts[altIdx]!;
      const steps = emitRustAstRdAltSteps(alt, ids, leaves);
      const finished = finish.replaceAll('__ALT__', String(altIdx)).replaceAll('__SK__', '_sk_base').replaceAll('__SPOFF__', 'sp_off');
      return `${pats} => {
                let _sk_base = self.vals.len();
                let _ap_base = self.ap_stack.len();
                self.ap_stack.push(${altIdx}usize);
                ${steps.ok}
                if ${steps.okVar} {
                    let _shape_finished = ${finished};
                    self.vals.truncate(_sk_base);
                    if _shape_finished.is_some() { self.ap_stack.truncate(_ap_base); return _shape_finished; }
                }
                self.ap_stack.truncate(_ap_base);
                self.pos = sp;
            }`;
    }).join('\n        ');
    return `{
            let sp = self.pos;
            let sp_off = self.current_off();
            match self.toks.get(self.pos).map(|t| (t.lid, t.kid)) {
                ${arms}
                _ => {}
            }
        }`;
  };

  if (sir.shape.kind === 'drop') {
    return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let sp = self.pos;
        // Recognizer-only: reuse CST parse path via token consumption is not available;
        // drop shape mirrors accept by running steps then discarding.
        None
    }`;
  }
  if (sir.shape.kind === 'custom') {
    const shape = sir.shape;
    const tries = rule.alts.map((_, ai) => ({
      altIdx: ai,
      finish: `match ${rustAstCustomCall(shape.fn, rule.name, {
        kidsPrep: '',
        kidsSlice: '&self.vals[_sk_base..]',
        altPrep: '',
        altSlice: '&self.ap_stack[_ap_base..]',
        offExpr: 'sp_off',
        endExpr: 'self.last_end(sp_off)',
        folds: shape.folds,
      })} { SVal::Null => None, v => Some(v) }`,
    }));
    const needPeek = rule.alts.some((_, i) => isGuardable(rule.altFirst[i] ?? null, rule.alts.length));
    return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        ${needPeek && !rule.predictive ? 'let _ft = self.toks.get(self.pos).copied();\n        ' : ''}${tryAlts(tries)}
        None
    }`;
  }
  if (sir.shape.kind === 'inline') {
    return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let _ = self;
        panic!("shape: inline ${rule.name} must be spliced by parent");
    }`;
  }
  if (sir.shape.kind === 'list') {
    const inner = rule.alts[0]?.[0];
    const elemRule = inner?.t === 'star' && inner.step.t === 'rule' ? inner.step.name : null;
    if (!elemRule) {
      return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let _ = self;
        unimplemented!("shape rust: list ${rule.name} unsupported IR")
    }`;
    }
    return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let sp = self.pos;
        let _out_base = self.vals.len();
        loop {
            let sp2 = self.pos;
            match self.parse_ast_${elemRule}() {
                Some(el) => self.vals.push(el),
                None => { self.pos = sp2; break; }
            }
        }
        if self.pos == sp && self.vals.len() == _out_base { return None; }
        Some(self.shape_list_from(_out_base))
    }`;
  }
  if (sir.shape.kind === 'keep') {
    // Positional keep via RD alts → structure event (streaming-only).
    const tries = rule.alts.map((_, ai) => ({
      altIdx: ai,
      finish: `Some(${rustStreamFinish(J(rule.cstName), '__SPOFF__', 'self.last_end(__SPOFF__)')})`,
    }));
    const needPeek = rule.alts.some((_, i) => isGuardable(rule.altFirst[i] ?? null, rule.alts.length));
    return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        ${needPeek && !rule.predictive ? 'let _ft = self.toks.get(self.pos).copied();\n        ' : ''}${tryAlts(tries)}
        None
    }`;
  }
  if (sir.shape.kind === 'choice') {
    const shape = sir.shape;
    const armBlocks: Array<{ altIdx: number; finish: string }> = [];
    for (const arm of shape.arms) {
      let finish: string;
      if (arm.shape.kind === 'node') {
        finish = `Some(${finishNode(arm.shape, '__SK__', '__SPOFF__')})`;
      } else if (arm.shape.kind === 'inline') {
        finish = `Some(self.shape_pack_range(_sk_base))`;
      } else if (arm.shape.kind === 'keep') {
        finish = `Some(${rustStreamFinish(J(rule.cstName), '__SPOFF__', 'self.last_end(__SPOFF__)', '__ALT__')})`;
      } else if (arm.shape.kind === 'list') {
        finish = `Some(self.shape_list_from(_sk_base))`;
      } else if (arm.shape.kind === 'custom') {
        finish = `match ${rustAstCustomCall(arm.shape.fn, rule.name, {
          kidsPrep: '',
          kidsSlice: '&self.vals[_sk_base..]',
          altPrep: '',
          altSlice: '&self.ap_stack[_ap_base..]',
          offExpr: '__SPOFF__',
          endExpr: 'self.last_end(__SPOFF__)',
          folds: arm.shape.folds,
        })} { SVal::Null => None, v => Some(v) }`;
      } else {
        finish = `None`;
      }
      for (const altIdx of arm.altIndices) {
        armBlocks.push({ altIdx, finish });
      }
    }
    const needPeek = rule.alts.some((_, i) => isGuardable(rule.altFirst[i] ?? null, rule.alts.length));
    return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        ${needPeek && !rule.predictive ? 'let _ft = self.toks.get(self.pos).copied();\n        ' : ''}${tryAlts(armBlocks)}
        None
    }`;
  }
  if (sir.shape.kind === 'node') {
    const node = sir.shape;
    if (rule.alts.length === 1) {
      const steps = emitRustAstRdAltSteps(rule.alts[0]!, ids, leaves);
      return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let sp = self.pos;
        let sp_off = self.current_off();
        let _sk_base = self.vals.len();
        ${steps.ok}
        if !${steps.okVar} { self.pos = sp; return None; }
        let _shape_v = ${finishNode(node, '_sk_base', 'sp_off')};
        self.vals.truncate(_sk_base);
        Some(_shape_v)
    }`;
    }
    const tries = rule.alts.map((_, ai) => ({
      altIdx: ai,
      finish: `Some(${finishNode(node, '__SK__', '__SPOFF__')})`,
    }));
    const needPeek = rule.alts.some((_, i) => isGuardable(rule.altFirst[i] ?? null, rule.alts.length));
    return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        ${needPeek && !rule.predictive ? 'let _ft = self.toks.get(self.pos).copied();\n        ' : ''}${tryAlts(tries)}
        None
    }`;
  }
  return `    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        let _ = self;
        unimplemented!("shape rust: unsupported RD shape for ${rule.name}")
    }`;
}

function emitRustPrattMethod(
  rule: PrattRule,
  sir: ShapeIRRule,
  ids: LexIdPlan,
  shapeIR: ShapeIR,
  ir: ParserIR,
): string {
  let shape: RuleShape = sir.shape;
  if (shape.kind === 'keep') shape = { kind: 'pratt' };
  if (shape.kind !== 'pratt') {
    return `    fn parse_ast_${rule.name}(&mut self) -> Option<SVal<'a>> { unimplemented!("expected pratt") }
    fn parse_ast_${rule.name}_bp(&mut self, _min_bp: i64) -> Option<SVal<'a>> { unimplemented!() }
    fn parse_ast_${rule.name}_nud(&mut self, _min_bp: i64) -> Option<SVal<'a>> { unimplemented!() }`;
  }
  const ps = shape;
  const leaves = shapeIR.leaves;
  const ret = "SVal<'a>";
  const tpl = ir.tpl;
  const emptySteps = (steps: Step[], selfBp = false) =>
    emitRustAstRdAltSteps(steps, ids, leaves, selfBp ? rule.name : undefined, selfBp);

  /** Missing Pratt slot → keep (positional), matching TS emitAstPrattRule. */
  const slotOf = (declared: { kind: string } | undefined, present: boolean): { kind: string } | null => {
    if (!present) return null;
    return declared ?? { kind: 'keep' };
  };

  /** Keep finish from a stack range [baseExpr..] — emits the structure event. */
  const keepFinish = (baseExpr: string, cstName: string, offExpr: string): string =>
    rustStreamFinish(J(cstName), offExpr, `self.last_end(${offExpr})`);

  /** Keep finish from a borrowed slice (template helper kids) — event only. */
  const keepFinishSlice = (kidsSlice: string, cstName: string, offExpr: string, endExpr: string): string =>
    rustStreamFinish(J(cstName), offExpr, endExpr);

  /** TS three-state inline finish: 1→unwrap, 0→None, else array. */
  const inlineFinishReturn = (baseExpr: string): string =>
    `match self.shape_inline_finish(${baseExpr}) { Some(v) => return Some(v), None => return None }`;

  /** Node finishes only READ the kids range — consume it before returning. */
  const nodeFinish = (nodeExpr: string, baseExpr: string): string =>
    `{ let _shape_v = ${nodeExpr}; self.vals.truncate(${baseExpr}); _shape_v }`;

  const customCall = (
    fn: string,
    kidsSlice: string,
    altExpr: string,
    offExpr: string,
    endExpr: string,
    leftExpr?: string,
    opExpr?: string,
    folds?: ParentFold[],
  ): string => {
    const kidsPrep = '';
    const kids = kidsSlice === '_sk_base' ? '&self.vals[_sk_base..]' : kidsSlice;
    const altSlice = altExpr === '[]' ? '&[]' : `&${altExpr}`;
    return rustAstCustomCall(fn, rule.name, {
      kidsPrep,
      kidsSlice: kids,
      altPrep: '',
      altSlice,
      offExpr,
      endExpr,
      leftExpr,
      opExpr,
      folds,
    });
  };

  /** Explicit pratt.template only — omitted keeps legacy `$template` + interpRule holes. */
  const templateSlot = ps.template as CustomShape | { kind: 'keep' } | undefined;
  const hasTplNud = !!(tpl && rule.nudToks.includes(tpl.token));
  const hasTplPostfix = !!(tpl && rule.postfixToks.includes(tpl.token));
  const templateFinish = (kidsSlice: string, offExpr: string, endExpr: string): string => {
    if (!templateSlot || templateSlot.kind === 'keep') return keepFinishSlice(kidsSlice, '$template', offExpr, endExpr);
    return customCall(templateSlot.fn, kidsSlice, '[]', offExpr, endExpr, undefined, undefined, templateSlot.folds);
  };
  // Template holes parse with the CALLER's rule (parse_ast_<rule>): an expression
  // template's `${f(1)}` / `${b + 1}` are Exprs, a template literal type's
  // `${A & B}` is a Type — mirroring the reference's currentPrattContext
  // (currentPrattContext ?? EXPR_RULE; a template only appears inside a Pratt
  // rule, so the current context is always the caller's rule). The old Type-first
  // dual-parse mis-accepted `${f(1)}`: `f` is a valid Type reference, so Type
  // consumed only `f`, the Expr re-parse's end differed, the fallback re-took the
  // Type shape, and the leftover `(1)` killed the template.
  const holeRule = rule.name;
  const tplHelperCode = tpl && (hasTplNud || hasTplPostfix)
    ? `    fn match_template_ast_${rule.name}(&mut self) -> Option<(Vec<SVal<'a>>, usize)> {
        let t = self.toks.get(self.pos).copied()?;
        if t.kid != ${kidOf(ids, '$templateHead')} { return None; }
        let save = self.pos;
        let save_snap = self.shape_tpl_snap();
        let mut kids: Vec<SVal<'a>> = vec![SVal::Str(t.off, t.end - t.off)];
        self.pos += 1;
        loop {
            let accept_hole = match self.parse_ast_${holeRule}() {
                Some(v) => v,
                None => { self.shape_tpl_restore(&save_snap); return None; }
            };
            kids.push(accept_hole);
            let next = match self.toks.get(self.pos).copied() {
                Some(v) => v,
                None => { self.shape_tpl_restore(&save_snap); return None; }
            };
            if next.kid == ${kidOf(ids, '$templateMiddle')} {
                kids.push(SVal::Str(next.off, next.end - next.off));
                self.pos += 1;
                continue;
            }
            if next.kid == ${kidOf(ids, '$templateTail')} {
                kids.push(SVal::Str(next.off, next.end - next.off));
                self.pos += 1;
                break;
            }
            self.shape_tpl_restore(&save_snap);
            return None;
        }
        Some((kids, save))
    }
`
    : '';

  // ── atom ──
  let atomCode = '';
  const atomKids = rule.nudToks.map((k) => kidOf(ids, k));
  if (ps.atom?.kind === 'rule') {
    atomCode = `if let Some(t) = self.toks.get(self.pos) {
            if matches!(t.kid, ${atomKids.join(' | ') || 'u16::MAX'}) {
                return self.parse_ast_${ps.atom.name}();
            }
        }`;
  } else if (ps.atom?.kind === 'custom') {
    const arms = rule.nudToks.map((tok) => {
      const policy = leaves[tok] ?? { action: 'keep' as const };
      return `if t.kid == ${kidOf(ids, tok)} { ${rustShapeLeafAstExpr(policy, 't.off', 't.end - t.off')} }`;
    }).join(' else ');
    atomCode = `if let Some(t) = self.toks.get(self.pos).copied() {
            if matches!(t.kid, ${atomKids.join(' | ') || 'u16::MAX'}) {
                let sp_off = t.off as usize;
                let _leaf = ${arms} else { SVal::Null };
                self.pos += 1;
                return Some(${customCall(ps.atom.fn, '&[_leaf]', '[]', 'sp_off', 't.end as usize', undefined, undefined, ps.atom.folds)});
            }
        }`;
  } else if (!ps.atom || ps.atom.kind === 'keep' || (ps.atom as { kind: string }).kind === 'leafValue' || ps.atom.kind === undefined) {
    if (rule.nudToks.length > 0) {
      const arms = rule.nudToks.map((tok) => {
        const policy = leaves[tok] ?? { action: 'keep' as const };
        if (tpl && tok === tpl.token && templateSlot) {
          return `${kidOf(ids, tok)} => {
                let leaf = ${rustShapeLeafAstExpr(policy, 't.off', 't.end - t.off')};
                self.pos += 1;
                return Some(${templateFinish('&[leaf]', 't.off as usize', 't.end as usize')});
            }`;
        }
        return `${kidOf(ids, tok)} => {
                self.pos += 1;
                return Some(${rustShapeLeafAstExpr(policy, 't.off', 't.end - t.off')});
            }`;
      }).join('\n            ');
      atomCode = `if let Some(t) = self.toks.get(self.pos).copied() {
            if matches!(t.kid, ${atomKids.join(' | ')}) {
                match t.kid {
                    ${arms}
                    _ => {}
                }
            }
        }`;
    }
  }

  // ── template NUD ──
  const tplNudCode = hasTplNud
    ? `if self.peek_kid() == Some(${kidOf(ids, '$templateHead')}) {
            let (_tm_kids, _tm_save) = self.match_template_ast_${rule.name}()?;
            let _tm_off = self.toks[_tm_save].off as usize;
            let _tm_end = self.last_end(_tm_off);
            return Some(${templateFinish('&_tm_kids', '_tm_off', '_tm_end')});
        }
        `
    : '';

  // ── group (lid-grouped; RD steps; custom slot reserved but inventory fail-fast) ──
  let groupCode = '';
  const groupSlot = slotOf(ps.group as { kind: string } | undefined, rule.nudBrackets.length > 0);
  if (groupSlot && rule.nudBrackets.length) {
    const groups = groupByPreserveOrder(rule.nudBrackets, (b) => lidOf(ids, b.first));
    for (const g of groups) {
      const armBlocks = g.members.map(({ item: b, index: bi }) => {
        const st = emptySteps(b.steps);
        let finish: string;
        if (groupSlot.kind === 'inline') {
          finish = inlineFinishReturn('_sk_base');
        } else if (groupSlot.kind === 'custom') {
          const gs = groupSlot as CustomShape;
          finish = `return Some(${customCall(gs.fn, '_sk_base', `[${bi}]`, 'save_off', 'self.last_end(save_off)', undefined, undefined, gs.folds)});`;
        } else if (groupSlot.kind === 'node') {
          finish = `return Some(${nodeFinish(rustShapeNodeObjectExpr(groupSlot as NodeShape, '_sk_base', '(0u32, 0u32)', shapeIR.spans, 'save_off', 'self.last_end(save_off)', undefined), '_sk_base')});`;
        } else {
          finish = `return Some(${keepFinish('_sk_base', rule.cstName, 'save_off')});`;
        }
        return `{
            let save = self.pos;
            let save_off = self.current_off();
            let _sk_base = self.vals.len();
            let _ap_base = self.ap_stack.len();
            ${st.ok}
            if ${st.okVar} {
                ${finish}
                self.ap_stack.truncate(_ap_base);
            }
            self.pos = save;
        }`;
      }).join('\n            ');
      groupCode += `if self.peek_lid() == Some(${g.key}) {
            ${armBlocks}
        }\n        `;
    }
  }

  // ── prefix ──
  let prefixCode = '';
  const prefixSlot = slotOf(ps.prefix as { kind: string } | undefined, rule.prefix.length > 0);
  if (prefixSlot && rule.prefix.length) {
    for (const prefix of rule.prefix) {
      const lid = lidOf(ids, prefix.op);
      if (prefixSlot.kind === 'node') {
        prefixCode += `if self.peek_lid() == Some(${lid}) {
            let save = self.pos;
            let _off = self.current_off();
            let _op = self.current_span();
            self.pos += 1;
            let _argument = match self.parse_ast_${rule.name}_bp(${prefix.rbp}) {
                Some(v) => v,
                None => { self.pos = save; return None; }
            };
            let _ab = self.vals.len();
            self.vals.push(_argument);
            return Some(${nodeFinish(rustShapeNodeObjectExpr(prefixSlot as NodeShape, '_ab', '_op', shapeIR.spans, '_off', 'self.last_end(_off)', undefined), '_ab')});
        }\n        `;
      } else if (prefixSlot.kind === 'custom') {
        const psCustom = prefixSlot as CustomShape;
        prefixCode += `if self.peek_lid() == Some(${lid}) {
            let save = self.pos;
            let _off = self.current_off();
            let _op = self.current_text();
            self.pos += 1;
            let argument = match self.parse_ast_${rule.name}_bp(${prefix.rbp}) {
                Some(v) => v,
                None => { self.pos = save; return None; }
            };
            return Some(${customCall(psCustom.fn, '&[argument]', '[]', '_off', 'self.last_end(_off)', undefined, '_op', psCustom.folds)});
        }\n        `;
      } else if (prefixSlot.kind === 'inline') {
        prefixCode += `if self.peek_lid() == Some(${lid}) {
            let save = self.pos;
            self.pos += 1;
            match self.parse_ast_${rule.name}_bp(${prefix.rbp}) {
                Some(v) => return Some(v),
                None => { self.pos = save; return None; }
            }
        }\n        `;
      } else {
        prefixCode += `if self.peek_lid() == Some(${lid}) {
            let save = self.pos;
            let _op = self.current_span();
            self.pos += 1;
            let argument = match self.parse_ast_${rule.name}_bp(${prefix.rbp}) {
                Some(v) => v,
                None => { self.pos = save; return None; }
            };
            let _ab = self.vals.len();
            self.vals.push(SVal::Str(_op.0, _op.1));
            self.vals.push(argument);
            return Some(${keepFinish('_ab', rule.cstName, '_op.0')});
        }\n        `;
      }
    }
  }

  // ── nudSeq ──
  let nudSeqCode = '';
  const nudSeqSlot = slotOf(ps.nudSeq as { kind: string } | undefined, rule.nudSeqs.length > 0);
  if (nudSeqSlot && rule.nudSeqs.length) {
    nudSeqCode = rule.nudSeqs.map((seq, si) => {
      const st = emptySteps(seq, true);
      let finish: string;
      if (nudSeqSlot.kind === 'custom') {
        const ns = nudSeqSlot as CustomShape;
        finish = `return Some(${customCall(ns.fn, '_sk_base', `[${si}]`, 'save_off', 'self.last_end(save_off)', undefined, undefined, ns.folds)});`;
      } else if (nudSeqSlot.kind === 'node') {
        finish = `return Some(${nodeFinish(rustShapeNodeObjectExpr(nudSeqSlot as NodeShape, '_sk_base', '(0u32, 0u32)', shapeIR.spans, 'save_off', 'self.last_end(save_off)', undefined), '_sk_base')});`;
      } else if (nudSeqSlot.kind === 'inline') {
        finish = inlineFinishReturn('_sk_base');
      } else {
        finish = `return Some(${keepFinish('_sk_base', rule.cstName, 'save_off')});`;
      }
      return `{
            let save = self.pos;
            {
                let save_off = self.current_off();
                let _sk_base = self.vals.len();
                let _ap_base = self.ap_stack.len();
                ${st.ok}
                if ${st.okVar} {
                    ${finish}
                    self.ap_stack.truncate(_ap_base);
                }
            }
            self.pos = save;
        }`;
    }).join('\n        ');
  }

  // ── nudCapped ──
  let nudCappedCode = '';
  const nudCappedSlot = slotOf(ps.nudCapped as { kind: string } | undefined, rule.nudCapped.length > 0);
  if (nudCappedSlot && rule.nudCapped.length) {
    nudCappedCode = rule.nudCapped.map((c, ci) => {
      const st = emptySteps(c.steps, true);
      let finish: string;
      if (nudCappedSlot.kind === 'custom') {
        const nc = nudCappedSlot as CustomShape;
        finish = `self.capped = true; return Some(${customCall(nc.fn, '_sk_base', `[${ci}]`, 'save_off', 'self.last_end(save_off)', undefined, undefined, nc.folds)});`;
      } else if (nudCappedSlot.kind === 'node') {
        finish = `self.capped = true; return Some(${nodeFinish(rustShapeNodeObjectExpr(nudCappedSlot as NodeShape, '_sk_base', '(0u32, 0u32)', shapeIR.spans, 'save_off', 'self.last_end(save_off)', undefined), '_sk_base')});`;
      } else if (nudCappedSlot.kind === 'inline') {
        finish = `self.capped = true; ${inlineFinishReturn('_sk_base')}`;
      } else {
        finish = `self.capped = true; return Some(${keepFinish('_sk_base', rule.cstName, 'save_off')});`;
      }
      return `if min_bp < ${c.capBp} {
            let save = self.pos;
            {
                let save_off = self.current_off();
                let _sk_base = self.vals.len();
                let _ap_base = self.ap_stack.len();
                ${st.ok}
                if ${st.okVar} {
                    ${finish}
                    self.ap_stack.truncate(_ap_base);
                }
            }
            self.pos = save;
        }`;
    }).join('\n        ');
  }

  // ── binary ──
  let binaryBody = '';
  const binarySlot = slotOf(ps.binary as { kind: string } | undefined, rule.binary.length > 0);
  if (binarySlot && rule.binary.length) {
    const binaryArms = rule.binary.map((b) =>
      `Some(${lidOf(ids, b.op)}) => (${b.lbp}, ${b.rbp}),`,
    ).join('\n                ');
    if (binarySlot.kind === 'node') {
      binaryBody = `{
            let (_lbp, _rbp) = match self.peek_lid() {
                ${binaryArms}
                _ => break,
            };
            if _lbp <= min_bp { break; }
            let _save = self.pos;
            let _op = self.current_span();
            self.pos += 1;
            let _right = match self.parse_ast_${rule.name}_bp(_rbp) {
                Some(v) => v,
                None => { self.pos = _save; break; }
            };
            let _ab = self.vals.len();
            self.vals.push(left);
            self.vals.push(_right);
            left = ${nodeFinish(rustShapeNodeObjectExpr(binarySlot as NodeShape, '_ab', '_op', shapeIR.spans, '_off', 'self.last_end(_off)', undefined), '_ab')};
            continue;
        }`;
    } else if (binarySlot.kind === 'custom') {
      const bs = binarySlot as CustomShape;
      binaryBody = `{
            let (_lbp, _rbp) = match self.peek_lid() {
                ${binaryArms}
                _ => break,
            };
            if _lbp <= min_bp { break; }
            let _save = self.pos;
            let _op = self.current_text();
            self.pos += 1;
            let _right = match self.parse_ast_${rule.name}_bp(_rbp) {
                Some(v) => v,
                None => { self.pos = _save; break; }
            };
            left = ${customCall(bs.fn, '&[_right]', '[]', '_off', 'self.last_end(_off)', 'left', '_op', bs.folds)};
            continue;
        }`;
    } else {
      binaryBody = `{
            let (_lbp, _rbp) = match self.peek_lid() {
                ${binaryArms}
                _ => break,
            };
            if _lbp <= min_bp { break; }
            let _save = self.pos;
            let _op = self.current_span();
            self.pos += 1;
            let _right = match self.parse_ast_${rule.name}_bp(_rbp) {
                Some(v) => v,
                None => { self.pos = _save; break; }
            };
            let _ab = self.vals.len();
            self.vals.push(left);
            self.vals.push(SVal::Str(_op.0, _op.1));
            self.vals.push(_right);
            left = ${keepFinish('_ab', rule.cstName, '_off')};
            continue;
        }`;
    }
  }

  // ── postfix ──
  let postfixCode = '';
  const postfixSlot = slotOf(ps.postfix as { kind: string } | undefined, rule.postfix.length > 0);
  if (postfixSlot && rule.postfix.length) {
    const postArms = rule.postfix.map((p) =>
      `Some(${lidOf(ids, p.op)}) => ${p.lbp},`,
    ).join('\n                    ');
    if (postfixSlot.kind === 'node') {
      postfixCode = `{
                let post = match self.peek_lid() {
                    ${postArms}
                    _ => -1,
                };
                if !tail_closed && post > min_bp {
                    let _op = self.current_span();
                    let _end_tok = self.toks[self.pos];
                    self.pos += 1;
                    let _ab = self.vals.len();
                    self.vals.push(left);
                    left = ${nodeFinish(rustShapeNodeObjectExpr(postfixSlot as NodeShape, '_ab', '_op', shapeIR.spans, '_off', '_end_tok.end as usize', undefined), '_ab')};
                    tail_closed = true;
                    continue;
                }
            }`;
    } else if (postfixSlot.kind === 'custom') {
      const pfs = postfixSlot as CustomShape;
      postfixCode = `{
                let post = match self.peek_lid() {
                    ${postArms}
                    _ => -1,
                };
                if !tail_closed && post > min_bp {
                    let _op = self.current_text();
                    self.pos += 1;
                    left = ${customCall(pfs.fn, '&[]', '[]', '_off', 'self.last_end(_off)', 'left', '_op', pfs.folds)};
                    tail_closed = true;
                    continue;
                }
            }`;
    } else {
      postfixCode = `{
                let post = match self.peek_lid() {
                    ${postArms}
                    _ => -1,
                };
                if !tail_closed && post > min_bp {
                    let _op = self.current_span();
                    self.pos += 1;
                    let _ab = self.vals.len();
                    self.vals.push(left);
                    self.vals.push(SVal::Str(_op.0, _op.1));
                    left = ${keepFinish('_ab', rule.cstName, '_off')};
                    tail_closed = true;
                    continue;
                }
            }`;
    }
  }

  // ── postfixTok (plain token + template-headed tagged form) ──
  let postfixTokCode = '';
  const postfixTokSlot = slotOf(ps.postfixTok as { kind: string } | undefined, rule.postfixToks.length > 0);
  if (postfixTokSlot && rule.postfixToks.length) {
    const groups = groupByPreserveOrder(rule.postfixToks, (tok) => kidOf(ids, tok));
    const cases = groups.map((g) => {
      const tokName = rule.postfixToks.find((t) => kidOf(ids, t) === g.key)!;
      const policy = leaves[tokName] ?? { action: 'keep' as const };
      let finish: string;
      if (postfixTokSlot.kind === 'custom') {
        const pts = postfixTokSlot as CustomShape;
        finish = `left = ${customCall(pts.fn, '&[leaf]', '[]', '_off', 't.end as usize', 'left', 'op_owned', pts.folds)};`;
      } else if (postfixTokSlot.kind === 'node') {
        const node = postfixTokSlot as NodeShape;
        // Used as a bare statement (no left assignment in streaming) — the
        // block needs a trailing ';' so its SVal tail is not mistaken for the
        // enclosing block's value.
        finish = rustStreamFinish(J(node.type), 't.off as u32', 't.end as u32') + ';';
      } else {
        finish = `{ let _ab = self.vals.len(); self.vals.push(left); self.vals.push(leaf); left = ${keepFinish('_ab', rule.cstName, '_off')}; }`;
      }
      return `if self.peek_kid() == Some(${g.key}) {
                if !tail_closed {
                    let t = self.toks[self.pos];
                    ${postfixTokSlot.kind === 'custom' ? 'let op_owned = tok_text(self.src, &t);' : ''}
                    let leaf_value = ${rustShapeLeafAstExpr(policy, 't.off', 't.end - t.off')};
                    self.pos += 1;
                    #[allow(unused_mut)]
                    let mut leaf = ${tpl && tokName === tpl.token && templateSlot
        ? templateFinish('&[leaf_value]', 't.off as usize', 't.end as usize')
        : 'leaf_value'};
                    ${finish}
                    continue;
                }
            }`;
    }).join('\n            ');
    let tplPart = '';
    if (hasTplPostfix) {
      let tplFinish: string;
      if (postfixTokSlot.kind === 'custom') {
        const pts = postfixTokSlot as CustomShape;
        tplFinish = `left = ${customCall(pts.fn, '&[node]', '[]', '_off', 'node_end', 'left', 'op_owned', pts.folds)};`;
      } else if (postfixTokSlot.kind === 'node') {
        const nodeShape = postfixTokSlot as NodeShape;
        tplFinish = rustStreamFinish(J(nodeShape.type), 'node_off as u32', 'node_end as u32') + ';';
      } else {
        tplFinish = `{ let _ab = self.vals.len(); self.vals.push(left); self.vals.push(node); left = ${keepFinish('_ab', rule.cstName, 'node_off')}; }`;
      }
      tplPart = `
            if !tail_closed && self.peek_kid() == Some(${kidOf(ids, '$templateHead')}) {
                let node_off = self.current_off();
                if let Some((_tm_kids, _tm_save)) = self.match_template_ast_${rule.name}() {
                    let node_end = self.last_end(node_off);
                    #[allow(unused_mut)]
                    let mut node = ${templateFinish('&_tm_kids', 'node_off', 'node_end')};
                    ${postfixTokSlot.kind === 'custom' ? 'let op_owned = &self.src[node_off..node_end];' : ''}
                    ${tplFinish}
                    continue;
                }
            }`;
    }
    postfixTokCode = cases + tplPart;
  }

  // ── LED (mixfix; RD steps; guards; success-only commit) ──
  let ledCode = '';
  const ledSlot = slotOf(ps.led as { kind: string } | undefined, rule.leds.length > 0);
  if (ledSlot && rule.leds.length) {
    // A lid that ALSO has a binary entry (`<` is both a type-arg LED and the
    // relational operator) must not `break` the Pratt loop when its LED steps
    // fail — the restore happens, then control falls through to the binary
    // body so `<` still parses as a comparison. Multiple arms sharing a lid
    // (e.g. `[` array-type then indexed-access) fall through to each other;
    // only the LAST arm of a group emits `break`.
    const binLids = new Set(rule.binary.map((b) => lidOf(ids, b.op)));
    const groups = groupByPreserveOrder(rule.leds, (b) => lidOf(ids, b.first));
    ledCode = groups.map((g) => {
      const lid = g.key as number;
      const hasBin = binLids.has(lid);
      const arms = g.members.map(({ item: b, index: i }, j) => {
        const parts: string[] = [];
        if (rule.ledAccessTail[i]) parts.push('!tail_closed');
        if (rule.ledLbp[i] !== null && rule.ledLbp[i] !== undefined) parts.push(`${rule.ledLbp[i]} > min_bp`);
        if (rule.ledSameLine[i]) parts.push('!t.nl');
        if (rule.ledNotLeftLeaf[i]) {
          const set = rule.ledNotLeftLeaf[i]!;
          parts.push(`{ let _ht = self.shape_head_text(left); !matches!(Self::shape_sval_str(&self.arena, _ht), ${set.map((x) => J(x)).join(' | ')}) }`);
        }
        parts.push(`!self.suppress_cur.as_ref().map_or(false, |v| v.contains(&${lid}))`);
        const guard = parts.join(' && ');
        const st = emptySteps(b.steps);
        let finish: string;
        if (ledSlot.kind === 'custom') {
          const ls = ledSlot as CustomShape;
          finish = `left = ${customCall(ls.fn, '_sk_base', `[${i}]`, '_off', 'self.last_end(_off)', 'left', '_op', ls.folds)};`;
        } else if (ledSlot.kind === 'node') {
          finish = `left = ${nodeFinish(rustShapeNodeObjectExpr(ledSlot as NodeShape, '_sk_base', '_op', shapeIR.spans, '_off', 'self.last_end(_off)', 'left'), '_sk_base')};`;
        } else if (ledSlot.kind === 'inline') {
          finish = `left = self.shape_pack_range(_sk_base);`;
        } else {
          finish = `{ self.vals.insert(_sk_base, left); left = ${keepFinish('_sk_base', rule.cstName, '_off')}; }`;
        }
        return `if ${guard} {
                    let led_save = self.pos;
                    ${ledSlot.kind === 'node' ? 'let _op = self.current_span();' : ledSlot.kind === 'custom' ? 'let _op = self.current_text();' : ''}
                    let _capped_save = self.capped;
                    let _sk_base = self.vals.len();
                    let _ap_base = self.ap_stack.len();
                    ${st.ok}
                    if ${st.okVar} {
                        ${finish}
                        self.ap_stack.truncate(_ap_base);
                        continue;
                    }
                    self.pos = led_save;
                    self.capped = _capped_save;
                    ${hasBin ? '' : (j === g.members.length - 1 ? 'break;' : '')}
                }`;
      }).join('\n                ');
      return `if self.peek_lid() == Some(${lid}) {
                let t = self.toks[self.pos];
                ${arms}
            }`;
    }).join('\n            ');
  }

  const hasLoop = !!(ledCode || postfixCode || postfixTokCode || binaryBody);

  return `${tplHelperCode}    fn parse_ast_${rule.name}(&mut self) -> Option<${ret}> {
        // Fast path: no pending suppress swap — skip the Rc clone + log traffic.
        if self.suppress_next.is_none() && self.suppress_cur.is_none() {
            return self.parse_ast_${rule.name}_bp(0);
        }
        let prev = self.suppress_cur;
        let _sn = self.take_suppress_next();
        self.set_suppress_cur(_sn);
        let r = self.parse_ast_${rule.name}_bp(0);
        self.set_suppress_cur(prev);
        r
    }
    fn parse_ast_${rule.name}_bp(&mut self, min_bp: i64) -> Option<${ret}> {
        let _off = self.current_off();
        let mut left = self.parse_ast_${rule.name}_nud(min_bp)?;
        if self.capped { return Some(left); }
        let mut tail_closed = false;
        ${hasLoop ? 'loop {' : ''}
            ${ledCode}
            ${postfixTokCode}
            ${postfixCode}
            ${binaryBody || (hasLoop ? 'break;' : '')}
        ${hasLoop ? '}' : ''}
        Some(left)
    }
    fn parse_ast_${rule.name}_nud(&mut self, min_bp: i64) -> Option<${ret}> {
        self.capped = false;
        ${nudCappedCode}
        // Non-capped path in nud_rest; clear capped afterwards so a nested arrow
        // inside grouping does not suppress the enclosing LED/binary loop (≡ TS/CST).
        let _r = self.parse_ast_${rule.name}_nud_rest(min_bp);
        self.capped = false;
        _r
    }
    fn parse_ast_${rule.name}_nud_rest(&mut self, min_bp: i64) -> Option<${ret}> {
        let _ = min_bp;
        ${tplNudCode}
        ${atomCode}
        ${groupCode}
        ${nudSeqCode}
        ${prefixCode}
        None
    }`;
}

function rustShapeUnsupported(ir: ParserIR, shapeIR: ShapeIR): Array<{ rule: string; construct: string }> {
  const out: Array<{ rule: string; construct: string }> = [];
  const note = (rule: string, construct: string): void => { out.push({ rule, construct }); };
  const supportedLeaf = (name: string): boolean => {
    const p = shapeIR.leaves[name];
    return p?.action === 'drop' || (p?.action === 'leafValue' && ['number', 'ident', 'identity', 'string', 'boolean', 'bigint'].includes(p.fn));
  };
  const walkStep = (rule: string, step: Step): void => {
    // SH3-1: all RD step kinds are supported.
    if (step.t === 'lit') {
      if (shapeIR.leaves[step.ttype]?.action !== 'drop') note(rule, `step:lit-kept:${step.value}`);
    } else if (step.t === 'tok') {
      if (!supportedLeaf(step.name) || shapeIR.leaves[step.name]?.action === 'drop') note(rule, `step:tok-policy:${step.name}`);
    } else if (step.t === 'alt') {
      for (const branch of step.branches) for (const s of branch) walkStep(rule, s);
    } else if (step.t === 'opt' || step.t === 'seq' || step.t === 'suppress' || step.t === 'not') {
      for (const s of step.steps) walkStep(rule, s);
    } else if (step.t === 'star') walkStep(rule, step.step);
    else if (step.t === 'sep') walkStep(rule, step.elem);
    // rule/ruleBp/altlit/sameLine: ok
  };
  const walkShape = (rule: string, shape: RuleShape): void => {
    if (shape.kind === 'custom') {
      // SH3-4: custom supported (streaming structure event + type table)
    } else if (shape.kind === 'choice') for (const arm of shape.arms) walkShape(rule, arm.shape);
    else if (shape.kind === 'keep' || shape.kind === 'inline' || shape.kind === 'list' || shape.kind === 'node' || shape.kind === 'pratt' || shape.kind === 'drop') {
      // supported RD shape kinds
    } else if (shape.kind === 'leafValue') note(rule, `shape:${shape.kind}`);
    else note(rule, `shape:${(shape as { kind: string }).kind}`);
  };

  for (const sir of shapeIR.rules) {
    const rule = ir.rules.find((r) => r.name === sir.name)!;
    walkShape(rule.name, sir.shape);
    if (rule.kind === 'rd') {
      if (sir.shape.kind === 'node') {
        for (const alt of rule.alts) for (const step of alt) walkStep(rule.name, step);
      } else if (sir.shape.kind === 'choice') {
        for (const arm of sir.shape.arms) {
          if (arm.shape.kind === 'custom') {
            // SH3-4: choice-arm custom supported
          } else if (!['node', 'keep', 'inline', 'list', 'drop'].includes(arm.shape.kind)) {
            note(rule.name, `choice-arm:${arm.shape.kind}`);
          }
          for (const ai of arm.altIndices) for (const step of rule.alts[ai] ?? []) walkStep(rule.name, step);
        }
      } else if (sir.shape.kind === 'custom') {
        // already noted
      } else if (['keep', 'inline', 'list', 'drop'].includes(sir.shape.kind)) {
        for (const alt of rule.alts) for (const step of alt) walkStep(rule.name, step);
      } else if (sir.shape.kind !== 'pratt') {
        note(rule.name, `rd-shape:${sir.shape.kind}`);
      }
      continue;
    }
    if (sir.shape.kind !== 'pratt') {
      note(rule.name, `pratt-shape:${sir.shape.kind}`);
      continue;
    }
    const ps = sir.shape;
    // Supported toy/calc Pratt slots:
    const atomOk = !ps.atom || ps.atom.kind === 'keep' || ps.atom.kind === 'leafValue' || ps.atom.kind === 'rule'
      || ps.atom.kind === 'drop' || ps.atom.kind === 'custom';
    if (ps.atom && !atomOk) {
      note(rule.name, `pratt-shape:atom:${ps.atom.kind}`);
    }
    if (ps.group && !['inline', 'keep', 'node', 'custom'].includes(ps.group.kind)) {
      note(rule.name, `pratt-shape:group:${ps.group.kind}`);
    }
    // Complex groups: allow if we render via RD steps (all brackets ok in SH3-1 for keep/inline/node)
    for (const tok of rule.nudToks) {
      if (ps.atom?.kind === 'rule') continue;
      if (!supportedLeaf(tok) || shapeIR.leaves[tok]?.action === 'drop') note(rule.name, `pratt-ir:atom-policy:${tok}`);
    }
    if (rule.prefix.length && ps.prefix && !['node', 'keep', 'inline', 'custom'].includes(ps.prefix.kind)) {
      note(rule.name, `pratt-shape:prefix:${ps.prefix.kind}`);
    }
    if (rule.binary.length && ps.binary && !['node', 'keep', 'custom'].includes(ps.binary.kind)) {
      note(rule.name, `pratt-shape:binary:${ps.binary.kind}`);
    }
    if (rule.postfix.length && ps.postfix && !['node', 'keep', 'inline', 'custom'].includes(ps.postfix.kind)) {
      note(rule.name, `pratt-shape:postfix:${ps.postfix.kind}`);
    }
    // led / nudSeq / nudCapped / postfixTok: keep|inline|node|custom supported
    for (const [slotName, slot, present] of [
      ['nudSeq', ps.nudSeq, rule.nudSeqs.length],
      ['nudCapped', ps.nudCapped, rule.nudCapped.length],
      ['led', ps.led, rule.leds.length],
      ['postfixTok', ps.postfixTok, rule.postfixToks.length],
    ] as const) {
      if (!present) continue;
      const kind = slot?.kind ?? 'keep';
      if (!['keep', 'inline', 'node', 'custom'].includes(kind)) note(rule.name, `pratt-shape:${slotName}:${kind}`);
    }
    if (ps.template && !['keep', 'custom'].includes(ps.template.kind)) {
      note(rule.name, `pratt-shape:template:${ps.template.kind}`);
    }
  }
  return out;
}


/**
 * M-A1.4-S2: streaming estree-type table. Emit-time totality check + collection.
 * Every custom/Pratt-custom site declares per-arm `types` (or `opMap` for
 * op-driven binary/prefix). Declared coverage must span the grammar's reachable
 * arms/ops; anything missing is an emit error. Sites of the same fn are merged;
 * conflicting arm/op types across sites → error. Returns the merged table.
 */
type StreamTypeObj = { passthrough: true } | { optionalChain: true } | { parenOrComma: true };
function collectStreamTypes(ir: ParserIR, shapeIR: ShapeIR, ids: LexIdPlan): Map<string, { perArm: (string | StreamTypeObj)[]; opMap?: Record<string, string> }> {
  const merged = new Map<string, { perArm: (string | StreamTypeObj)[]; opMap?: Record<string, string> }>();
  const fail = (msg: string): never => { throw new Error('stream-type totality: ' + msg); };
  const ensureTypes = (fn: string, types: StreamType[] | undefined, armCount: number) => {
    if (!types) { fail(`${fn} declares no types`); return; }
    // A single parenOrComma marker is a site-level decision covering every arm.
    if (types.length === 1 && typeof types[0] === 'object' && types[0] !== null && 'parenOrComma' in (types[0] as object)) return;
    if (types.length !== armCount) fail(`${fn} expects ${armCount} reachable arm(s), got ${types.length} declared`);
  };
  const collect = (fn: string, types: StreamType[] | undefined, opMap: Record<string, string> | undefined) => {
    const cur = merged.get(fn) ?? { perArm: [] as (string | StreamTypeObj)[] };
    if (opMap) {
      for (const [op, ty] of Object.entries(opMap)) {
        if (cur.opMap && cur.opMap[op] && cur.opMap[op] !== ty) fail(`${fn} op ${op} has two types (${cur.opMap[op]} vs ${ty})`);
        (cur.opMap ??= {})[op] = ty;
      }
    }
    if (types) {
      if (cur.perArm.length === 0) cur.perArm = types;
      else {
        const len = Math.max(cur.perArm.length, types.length);
        for (let i = 0; i < len; i++) {
          const a = cur.perArm[i];
          const b = types[i];
          if (a !== undefined && b !== undefined && JSON.stringify(a) !== JSON.stringify(b)) fail(`${fn} arm ${i} has two types (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
          if (a === undefined) cur.perArm[i] = b;
        }
      }
    }
    merged.set(fn, cur);
  };
  for (const sir of shapeIR.rules) {
    const rule = ir.rules.find((r) => r.name === sir.name)!;
    if (rule.kind === 'rd') {
      const sh = sir.shape;
      if (sh.kind === 'custom') {
        ensureTypes(sh.fn, sh.types, rule.alts.length);
        collect(sh.fn, sh.types, undefined);
      } else if (sh.kind === 'choice') {
        for (const arm of sh.arms) {
          if (arm.shape.kind === 'custom') {
            ensureTypes(arm.shape.fn, arm.shape.types, arm.altIndices.length);
            // choice-arm types are positional (types[i] ↔ altIndices[i]) — place
            // each at its actual alt value so the table matches the event alt.
            const perArm: (string | StreamTypeObj)[] = [];
            for (let i = 0; i < arm.altIndices.length; i++) perArm[arm.altIndices[i]!] = arm.shape.types![i] as string | StreamTypeObj;
            collect(arm.shape.fn, perArm, undefined);
          }
        }
      }
      continue;
    }
    const ps = sir.shape as PrattShape;
    const slot = (name: string, s: { kind: string } | undefined): void => {
      if (!s || s.kind !== 'custom') return;
      const cs = s as CustomShape;
      let n: number | null = null;
      if (name === 'nudSeq') n = rule.nudSeqs.length;
      else if (name === 'nudCapped') n = rule.nudCapped.length;
      else if (name === 'led') n = rule.leds.length;
      else if (name === 'group') n = rule.nudBrackets.length;
      else if (name === 'postfixTok') n = rule.postfixToks.length;
      else if (name === 'template' || name === 'atom') n = 1;
      if (n !== null) ensureTypes(cs.fn, cs.types, n);
      collect(cs.fn, cs.types, undefined);
    };
    slot('atom', ps.atom);
    slot('group', ps.group);
    slot('nudSeq', ps.nudSeq);
    slot('nudCapped', ps.nudCapped);
    slot('led', ps.led);
    slot('postfixTok', ps.postfixTok);
    slot('template', ps.template);
    if (ps.prefix?.kind === 'custom') {
      const cs = ps.prefix as CustomShape;
      if (!cs.opMap) fail(`${cs.fn} is op-driven but declares no opMap`);
      const ops = rule.prefix.map((p) => p.op);
      for (const op of ops) if (!(op in (cs.opMap ?? {}))) fail(`${cs.fn} op ${op} missing from opMap`);
      collect(cs.fn, undefined, cs.opMap);
    }
    if (ps.binary?.kind === 'custom') {
      const cs = ps.binary as CustomShape;
      if (!cs.opMap) fail(`${cs.fn} is op-driven but declares no opMap`);
      const ops = rule.binary.map((b) => b.op);
      for (const op of ops) if (!(op in (cs.opMap ?? {}))) fail(`${cs.fn} op ${op} missing from opMap`);
      collect(cs.fn, undefined, cs.opMap);
    }
  }
  return merged;
}

/** Emit the estree_type_of_streaming function from the collected table. */
function emitStreamTypeFn(table: Map<string, { perArm: (string | StreamTypeObj)[]; opMap?: Record<string, string> }>): string {
  const lines: string[] = [];
  for (const [fn, info] of table) {
    if (info.opMap) {
      const byType = new Map<string, string[]>();
      for (const [op, ty] of Object.entries(info.opMap)) {
        const arr = byType.get(ty) ?? [];
        arr.push(op);
        byType.set(ty, arr);
      }
      const arms: string[] = [];
      for (const [ty, ops] of byType) arms.push(`                ${ops.map((o) => JSON.stringify(o)).join(' | ')} => ${JSON.stringify(ty)},`);
      lines.push(`            ${JSON.stringify(fn)} => match op {
${arms.join('\n')}
                _ => ${JSON.stringify('Unknown' + fn)},
            },`);
    } else {
      // parenOrComma is a site-level decision for every arm — emit one branch.
      if (info.perArm.length === 1 && typeof info.perArm[0] === 'object' && info.perArm[0] !== null && 'parenOrComma' in (info.perArm[0] as object)) {
        lines.push(`            ${JSON.stringify(fn)} => if arm == 7 { "MetaProperty" } else if kids.len() == 1 { kid_type(kids[0]) } else { "SequenceExpression" },`);
        continue;
      }
      const arms: string[] = [];
      info.perArm.forEach((t, i) => {
        if (t === undefined) return; // sparse hole — choice-arm alt not mapped
        let rhs: string;
        if (typeof t === 'string') rhs = JSON.stringify(t);
        else if ('passthrough' in t) rhs = 'kid_type(kids.first().copied().unwrap_or(SVal::Null))';
        else if ('optionalChain' in t) rhs = 'optional_chain_type(kids)';
        else rhs = 'if arm == 7 { "MetaProperty" } else if kids.len() == 1 { kid_type(kids[0]) } else { "SequenceExpression" }';
        arms.push(`                ${i} => ${rhs},`);
      });
      lines.push(`            ${JSON.stringify(fn)} => match arm {
${arms.join('\n')}
                _ => ${JSON.stringify('Unknown' + fn)},
            },`);
    }
  }
  return `/// M-A1.4-S2: estree type of a streaming event — generated from the shape
/// spec's per-arm types (source of truth; fixture's handwritten table removed).
pub fn estree_type_of_streaming<'a>(fn_name: &str, alt: &[usize], kids: &[SVal<'a>], op_text: Option<&str>, _kind: Option<&str>) -> &'static str {
        let arm = alt.first().copied().unwrap_or(0);
        let op = op_text.unwrap_or("");
        match fn_name {
${lines.join('\n')}
            _ => "UnknownFn",
        }
    
}
`;
}

function emitRustShapeAddon(ir: ParserIR, shapeIR: ShapeIR, ids: LexIdPlan): string {
  const unsupported = rustShapeUnsupported(ir, shapeIR);
  if (unsupported.length) {
    throw new Error(
      `shape rust emit: ${unsupported.length} unsupported construct(s):\n` +
      unsupported.map((u) => `  ${u.rule}: ${u.construct}`).join('\n'),
    );
  }
  _rustShapeRuleFirst = buildRustShapeRuleFirst(ir);
  // M-A1.4-S5: streaming-only — the estree-type table is always collected
  // (every custom site must declare per-arm types/opMap).
  const streamTypeTable = collectStreamTypes(ir, shapeIR, ids);
  const streamTypeFn = streamTypeTable.size ? emitStreamTypeFn(streamTypeTable) : '';
  const methods = shapeIR.rules.map((sir) => {
    const rule = ir.rules.find((r) => r.name === sir.name)!;
    return rule.kind === 'pratt'
      ? emitRustPrattMethod(rule, sir, ids, shapeIR, ir)
      : emitRustRdMethod(rule, sir, ids, shapeIR);
  }).join('\n\n');
  _rustShapeRuleFirst = null;
  return `

${emitRustShapeTypes(ir, shapeIR)}

${streamTypeFn}// Generic C makes every hook statically dispatched and monomorphized. No trait object,
// callback table, or per-node allocation is introduced by the customs boundary.
#[derive(Debug, Clone, Default)]
pub struct AstFoldCounts { pub starts: usize, pub appends: usize }

pub trait ShapeCustoms<'a> {
    #[inline(always)]
    fn leaf_number(&self, text: &str) -> f64 {
        // Fast path: plain integer literals — a digit loop avoids f64::from_str's
        // correct-rounding cost (the common case in real code). >19 digits or
        // any non-digit falls back to the full parser (overflow/hex/float-safe).
        let b = text.as_bytes();
        if !b.is_empty() && b.len() <= 19 && b.iter().all(|c| c.is_ascii_digit()) {
            let mut v: u64 = 0;
            for &c in b { v = v * 10 + (c - b'0') as u64; }
            return v as f64;
        }
        text.parse::<f64>().expect("shape number")
    }
    #[inline(always)] fn leaf_boolean(&self, text: &str) -> bool { text == "true" }
    /// JSON writer for typed custom nodes (SVal::TNode) — M2 typed direct-emit.
    /// Customs that produce TNodes must override; default panics (never hit otherwise).
    fn write_tnode_json(&self, _ar: &AstArena<'a>, _tag: u16, _idx: u32, _out: &mut String) {
        panic!("shape rust: write_tnode_json not implemented for this customs")
    }
    /// Fold append into a typed node's field (TNode) — M2 typed fold protocol.
    /// Default panics; customs with fold-capable typed products must override.
    fn tnode_fold_append(&self, _ar: &mut AstArena<'a>, _tag: u16, _idx: u32, _into: &'static str, _value: SVal<'a>) {
        panic!("shape rust: tnode_fold_append not implemented for this customs")
    }
    /// Reserve hook (M10) — called once per parse with the token count so
    /// customs-owned arenas can pre-size (the customs value is fresh per parse,
    /// so its Vecs would otherwise grow from zero with realloc churn).
    fn reserve(&self, _n: usize) {}
    /// Head-text of a typed node (M14) — mirrors the DynObj "headText" field
    /// read that shape_head_text performs on keep-wrapper objects. Default ""
    /// (the pre-M14 TNode behavior).
    fn tnode_head_text(&self, _tag: u16, _idx: u32) -> SVal<'a> { SVal::Str(0, 0) }
}
pub struct DefaultShapeCustoms;
impl ShapeCustoms<'_> for DefaultShapeCustoms {}

// suppress connector sets are compile-time literal lists — store them as
// promoted &'static slices (Copy). Zero allocation, zero refcount traffic;
// the undo log just records old values (SH3-6 M3).
#[derive(Clone, Copy)]
struct ShapeCk {
    pos: usize,
    vals_len: usize,
    lists_len: usize,
    // fields/nodes/partials are omitted: the streaming-only shape codegen never
    // mutates those arena slabs (no DynObj/Partial construction), so their len is
    // constant 0 and snapshotting/truncating them is pure per-alt overhead.
    strings_len: usize,
    ap_len: usize,
    suppress_log_len: usize,
    capped: bool,
    events_len: usize,
}

#[derive(Clone, Copy)]
struct ShapeTplSnap {
    pos: usize,
    suppress_next: Option<&'static [u16]>,
    suppress_cur: Option<&'static [u16]>,
    capped: bool,
    events_len: usize,
}

struct ShapeParser<'a, 'c, C: ShapeCustoms<'a>> {
    src: &'a str,
    toks: Vec<Tok>,
    pos: usize,
    customs: &'c C,
    arena: AstArena<'a>,
    /// Shape value stack — lives on the parser (not AstArena) so customs can
    /// borrow &self.vals[base..] as kids while &mut self.arena is passed
    /// (disjoint field borrows; kills the old kids_scratch drain-copy per call).
    vals: Vec<SVal<'a>>,
    /// Global alt_path stack: rule alt index + nested alt-step branch picks.
    ap_stack: Vec<usize>,
    suppress_next: Option<&'static [u16]>,
    suppress_cur: Option<&'static [u16]>,
    suppress_log: Vec<(u8, Option<&'static [u16]>)>,
    capped: bool,
    /// When true, committed node completions also emit StreamEvents (parse_stream_buf
    /// path); when false the walk is tree-only and skips event/type-tag work.
    emit_events: bool,
    /// M-A1.2/S5: streaming structure events (typ, alt, off, end) — populated
    /// at every committed node completion (speculative events are rolled back
    /// by checkpoint truncation); parse_stream replays them to the caller.
    events: Vec<StreamEvent>,
}
impl<'a, 'c, C: ShapeCustoms<'a>> ShapeParser<'a, 'c, C> {
    #[inline(always)] fn peek_kid(&self) -> Option<u16> { self.toks.get(self.pos).map(|t| t.kid) }
    #[inline(always)] fn peek_lid(&self) -> Option<u16> { self.toks.get(self.pos).map(|t| t.lid) }
    #[inline(always)] fn current_off(&self) -> usize { self.toks.get(self.pos).map(|t| t.off as usize).unwrap_or(self.src.len()) }
    #[inline(always)] fn current_text(&self) -> &'a str { self.toks.get(self.pos).map(|t| tok_text(self.src, t)).unwrap_or("") }
    /// M15: span of the current token — (off, len); (src.len(), 0) at EOF.
    #[inline(always)] fn current_span(&self) -> (u32, u32) { self.toks.get(self.pos).map(|t| (t.off, t.end - t.off)).unwrap_or((self.src.len() as u32, 0)) }
    #[inline(always)] fn last_end(&self, fallback: usize) -> usize { if self.pos > 0 { self.toks[self.pos - 1].end as usize } else { fallback } }
    #[inline(always)] fn take_lit(&mut self, lid: u16) -> Option<()> {
        if self.peek_lid() != Some(lid) { return None; }
        self.pos += 1;
        Some(())
    }
    /// Streaming twin of Parser::match_gt: consume a single '>' from a longer
    /// '>'-led punct token, splicing the remainder back as the next token.
    #[inline(always)] fn take_gt(&mut self) -> Option<()> {
        let t = *self.toks.get(self.pos)?;
        if t.lid == ${lidOf(ids, '>')} { self.pos += 1; return Some(()); }
        let n = (t.end - t.off) as usize;
        if n > 1 && self.src.as_bytes()[t.off as usize] == b'>' {
            let rem_lid = lid_of(&self.src[(t.off + 1) as usize..t.end as usize]);
            self.toks.insert(self.pos + 1, Tok { off: t.off + 1, end: t.end, kid: 0, lid: rem_lid, nl: t.nl });
            self.toks[self.pos] = Tok { off: t.off, end: t.off + 1, kid: 0, lid: ${lidOf(ids, '>')}, nl: t.nl };
            self.pos += 1;
            Some(())
        } else { None }
    }
    #[inline(always)] fn take_span(&mut self, kid: u16) -> Option<(u32, u32)> {
        if self.peek_kid() != Some(kid) { return None; }
        let t = &self.toks[self.pos];
        let span = (t.off, t.end - t.off);
        self.pos += 1;
        Some(span)
    }
    #[inline(always)]
    fn set_suppress_next(&mut self, v: Option<&'static [u16]>) {
        let old = std::mem::replace(&mut self.suppress_next, v);
        self.suppress_log.push((0, old));
    }
    #[inline(always)]
    fn set_suppress_cur(&mut self, v: Option<&'static [u16]>) {
        let old = std::mem::replace(&mut self.suppress_cur, v);
        self.suppress_log.push((1, old));
    }
    #[inline(always)]
    fn take_suppress_next(&mut self) -> Option<&'static [u16]> {
        let old = std::mem::take(&mut self.suppress_next);
        self.suppress_log.push((0, old));
        old
    }
    fn shape_tpl_snap(&self) -> ShapeTplSnap {
        ShapeTplSnap {
            pos: self.pos,
            suppress_next: self.suppress_next,
            suppress_cur: self.suppress_cur,
            capped: self.capped,
            events_len: self.events.len(),
        }
    }
    fn shape_tpl_restore(&mut self, snap: &ShapeTplSnap) {
        self.pos = snap.pos;
        self.suppress_next = snap.suppress_next;
        self.suppress_cur = snap.suppress_cur;
        self.capped = snap.capped;
        self.events.truncate(snap.events_len);
    }
    #[inline(always)]
    fn shape_ck(&self) -> ShapeCk {
        ShapeCk {
            pos: self.pos,
            vals_len: self.vals.len(),
            lists_len: self.arena.lists.len(),
            strings_len: self.arena.strings.len(),
            ap_len: self.ap_stack.len(),
            suppress_log_len: self.suppress_log.len(),
            capped: self.capped,
            events_len: self.events.len(),
        }
    }
    #[inline(always)]
    fn shape_restore(&mut self, ck: ShapeCk) {
        self.pos = ck.pos;
        self.vals.truncate(ck.vals_len);
        self.arena.lists.truncate(ck.lists_len);
        self.arena.strings.truncate(ck.strings_len);
        self.ap_stack.truncate(ck.ap_len);
        self.events.truncate(ck.events_len);
        while self.suppress_log.len() > ck.suppress_log_len {
            match self.suppress_log.pop() {
                Some((0, old)) => self.suppress_next = old,
                Some((_, old)) => self.suppress_cur = old,
                None => break,
            }
        }
        self.capped = ck.capped;
    }
    /// Pack the vals stack range [base..] into one value; list storage copies
    /// into the lists slab via memcpy (SVal is Copy — extend_from_slice
    /// specializes to ptr::copy_nonoverlapping; alloc-free once warm).
    #[inline(always)]
    fn shape_pack_range(&mut self, base: usize) -> SVal<'a> {
        let n = self.vals.len() - base;
        match n {
            0 => SVal::Null,
            1 => self.vals.pop().unwrap(),
            _ => {
                if self.vals[base..].iter().all(|v| matches!(v, SVal::TNode(..))) {
                    let st = self.arena.node_lists.len() as u32;
                    for v in &self.vals[base..] { if let SVal::TNode(t, i) = *v { self.arena.node_lists.push((t as u32) << 24 | i); } }
                    self.vals.truncate(base);
                    SVal::NodeList(st, n as u32)
                } else {
                    let start = self.arena.lists.len() as u32;
                    self.arena.lists.extend_from_slice(&self.vals[base..]);
                    self.vals.truncate(base);
                    SVal::List(start, n as u32)
                }
            }
        }
    }
    /// Pack [base..] to one value and leave it on the stack. For the common
    /// single-value case this is a no-op (the value is already in place),
    /// eliding the pop+push roundtrip of shape_pack_range + vals.push (the
    /// alt/star/sep codegen always packs then re-pushes).
    #[inline(always)] fn shape_pack_push(&mut self, base: usize) {
        let n = self.vals.len() - base;
        match n {
            0 => self.vals.push(SVal::Null),
            1 => {}
            _ => { let v = self.shape_pack_range(base); self.vals.push(v); }
        }
    }
    /// Close the vals stack range [base..] as a list value (copies it).
    #[inline(always)] fn shape_list_from(&mut self, base: usize) -> SVal<'a> {
        let n = self.vals.len() - base;
        match n {
            0 => SVal::List(0, 0),
            1 => {
                let v = self.vals.pop().unwrap();
                if matches!(v, SVal::TNode(..)) {
                    let st = self.arena.node_lists.len() as u32;
                    if let SVal::TNode(t, i) = v { self.arena.node_lists.push((t as u32) << 24 | i); }
                    SVal::NodeList(st, 1)
                } else {
                    let start = self.arena.lists.len() as u32;
                    self.arena.lists.push(v);
                    SVal::List(start, 1)
                }
            }
            _ => {
                if self.vals[base..].iter().all(|v| matches!(v, SVal::TNode(..))) {
                    let st = self.arena.node_lists.len() as u32;
                    for v in &self.vals[base..] { if let SVal::TNode(t, i) = *v { self.arena.node_lists.push((t as u32) << 24 | i); } }
                    self.vals.truncate(base);
                    SVal::NodeList(st, n as u32)
                } else {
                    let start = self.arena.lists.len() as u32;
                    self.arena.lists.extend_from_slice(&self.vals[base..]);
                    self.vals.truncate(base);
                    SVal::List(start, n as u32)
                }
            }
        }
    }
    fn shape_inline_finish(&mut self, base: usize) -> Option<SVal<'a>> {
        if self.vals.len() - base == 0 { None } else { Some(self.shape_pack_range(base)) }
    }
    /// Read an object's field by name (linear scan of its fields range).
    fn shape_obj_field(&self, obj: SVal<'a>, name: &'static str) -> SVal<'a> {
        if let SVal::Node(i) = obj {
            let o = &self.arena.nodes[i as usize];
            let (fs, fl) = o.fields;
            for (k, v) in &self.arena.fields[fs as usize..(fs + fl) as usize] {
                if *k == name { return *v; }
            }
        }
        SVal::Null
    }
    /// Fold child partial markers per parent folds (recursive into list slots). Equals TS _shapeFoldKids.
    /// Fast path: no folds, no partials ever created this parse (monotonic
    /// partial_count — M21), or no Partial kids at any depth → borrowed kids,
    /// zero allocation.
    fn shape_fold_kids<'x>(ar: &mut AstArena<'a>, customs: &'x C, kids: &'x [SVal<'a>], folds: &[(&'static str, &'static str)]) -> (std::borrow::Cow<'x, [SVal<'a>]>, Option<Vec<(&'static str, AstFoldCounts)>>) {
        if folds.is_empty() { return (std::borrow::Cow::Borrowed(kids), None); }
        if ar.partial_count == 0 { return (std::borrow::Cow::Borrowed(kids), None); }
        fn has_partial<'a>(ar: &AstArena<'a>, list: &[SVal<'a>]) -> bool {
            list.iter().any(|v| match *v {
                SVal::Partial(_) => true,
                SVal::List(_, _) => has_partial(ar, ar.list_of(*v)),
                _ => false,
            })
        }
        if !has_partial(ar, kids) { return (std::borrow::Cow::Borrowed(kids), None); }
        let mut state: Vec<(&'static str, AstFoldCounts)> = folds.iter().map(|(tag, _)| (*tag, AstFoldCounts::default())).collect();
        let out = Self::shape_fold_list(ar, customs, kids, folds, &mut state);
        (std::borrow::Cow::Owned(out), Some(state))
    }
    fn shape_fold_list(ar: &mut AstArena<'a>, customs: &C, list: &[SVal<'a>], folds: &[(&'static str, &'static str)], state: &mut Vec<(&'static str, AstFoldCounts)>) -> Vec<SVal<'a>> {
        let into_of = |tag: &str| -> Option<&'static str> {
            folds.iter().find(|(t, _)| *t == tag).map(|(_, into)| *into)
        };
        let mut out: Vec<SVal<'a>> = Vec::new();
        for k in list {
            match *k {
                SVal::Partial(pi) => {
                    let rec = ar.partials[pi as usize];
                    if let Some(into) = into_of(rec.tag) {
                        if rec.mode == "start" {
                            if let Some((_, c)) = state.iter_mut().find(|(t, _)| *t == rec.tag) { c.starts += 1; }
                            out.push(rec.value);
                        } else if rec.mode == "append" {
                            match out.last().copied() {
                                Some(SVal::Node(ni)) => {
                                    Self::shape_fold_append(ar, ni, into, rec.value);
                                    if let Some((_, c)) = state.iter_mut().find(|(t, _)| *t == rec.tag) { c.appends += 1; }
                                }
                                Some(SVal::TNode(tag, tidx)) => {
                                    customs.tnode_fold_append(ar, tag, tidx, into, rec.value);
                                    if let Some((_, c)) = state.iter_mut().find(|(t, _)| *t == rec.tag) { c.appends += 1; }
                                }
                                _ => panic!("shape: partial append has no preceding start for {}", rec.tag),
                            }
                        } else {
                            out.push(*k);
                        }
                    } else {
                        out.push(*k);
                    }
                }
                SVal::List(s, l) => {
                    let inner: Vec<SVal<'a>> = ar.lists[s as usize..(s + l) as usize].to_vec();
                    let folded = Self::shape_fold_list(ar, customs, &inner, folds, state);
                    let start = ar.lists.len() as u32;
                    let flen = folded.len() as u32;
                    ar.lists.extend_from_slice(&folded);
                    out.push(SVal::List(start, flen));
                }
                // NodeList holds packed TNode u32s — no Partial possible, pass through.
                SVal::NodeList(..) => out.push(*k),
                other => out.push(other),
            }
        }
        out
    }
    /// Append a partial value into an object's into-field (list slot), growing
    /// the field range at the slab tail when the field is absent.
    fn shape_fold_append(ar: &mut AstArena<'a>, ni: u32, into: &'static str, value: SVal<'a>) {
        let (fs, fl) = ar.nodes[ni as usize].fields;
        let fr = fs as usize..(fs + fl) as usize;
        let mut slot_idx: Option<usize> = None;
        for (i, (k, _)) in ar.fields[fr.clone()].iter().enumerate() {
            if *k == into { slot_idx = Some(fs as usize + i); break; }
        }
        if let Some(si) = slot_idx {
            match ar.fields[si].1 {
                SVal::List(s, l) => {
                    if (s + l) as usize == ar.lists.len() {
                        ar.lists.push(value);
                        ar.fields[si].1 = SVal::List(s, l + 1);
                    } else {
                        let start = ar.lists.len() as u32;
                        ar.lists.extend_from_within(s as usize..(s + l) as usize);
                        ar.lists.push(value);
                        ar.fields[si].1 = SVal::List(start, l + 1);
                    }
                }
                // Defensive: TS grammar never appends into a NodeList slot, but
                // unroll packed TNode elements into a generic List if it does.
                SVal::NodeList(s, l) => {
                    let start = ar.lists.len() as u32;
                    for e in &ar.node_lists[s as usize..(s + l) as usize] {
                        ar.lists.push(SVal::TNode((e >> 24) as u16, e & 0xFFFFFF));
                    }
                    ar.lists.push(value);
                    ar.fields[si].1 = SVal::List(start, l + 1);
                }
                _ => {
                    let start = ar.lists.len() as u32;
                    ar.lists.push(value);
                    ar.fields[si].1 = SVal::List(start, 1);
                }
            }
        } else {
            // Field absent: move the object's field range to the slab tail with the new field.
            let old: Vec<(&'static str, SVal<'a>)> = ar.fields[fr].to_vec();
            let start = ar.fields.len() as u32;
            ar.fields.extend(old);
            let vstart = ar.lists.len() as u32;
            ar.lists.push(value);
            ar.fields.push((into, SVal::List(vstart, 1)));
            ar.nodes[ni as usize].fields = (start, fl + 1);
        }
    }
    /// Head text of a value (≡ TS shapeHeadText) — spans where possible.
    fn shape_head_text(&mut self, v: SVal<'a>) -> SVal<'a> {
        match v {
            SVal::Null => SVal::Str(0, 0),
            SVal::TNode(t, i) => self.customs.tnode_head_text(t, i),
            SVal::Str(..) | SVal::OwnStr(_) => v,
            SVal::Number(n) => { let s = n.to_string(); self.arena.mk_own_str(&s) }
            SVal::Bool(b) => { let s = b.to_string(); self.arena.mk_own_str(&s) }
            SVal::List(s, l) => {
                if l == 0 { SVal::Str(0, 0) } else {
                    let first = self.arena.lists[s as usize];
                    // M21: keep-wrapper children's first kid is usually a Str
                    // (identifier/keyword) — resolve it inline instead of a
                    // recursive call; semantics identical to shape_head_text(first).
                    match first {
                        SVal::Str(..) | SVal::OwnStr(_) => first,
                        _ => self.shape_head_text(first),
                    }
                }
            }
            // NodeList elements are all TNode — head text resolves via the typed node.
            SVal::NodeList(s, l) => {
                if l == 0 { SVal::Str(0, 0) } else {
                    let e = self.arena.node_lists[s as usize];
                    self.customs.tnode_head_text((e >> 24) as u16, e & 0xFFFFFF)
                }
            }
            SVal::Partial(pi) => {
                let rec = self.arena.partials[pi as usize];
                self.shape_head_text(rec.value)
            }
            SVal::Node(_) => {
                let ht = self.shape_obj_field(v, "headText");
                if let SVal::Str(_, l) = ht { if l > 0 { return ht; } }
                if let SVal::OwnStr(_) = ht { return ht; }
                let op = self.shape_obj_field(v, "operator");
                let has_arg = !matches!(self.shape_obj_field(v, "argument"), SVal::Null);
                let has_left = !matches!(self.shape_obj_field(v, "left"), SVal::Null);
                let has_right = !matches!(self.shape_obj_field(v, "right"), SVal::Null);
                if has_arg && !has_left && !has_right {
                    if let SVal::Str(..) | SVal::OwnStr(_) = op { return op; }
                }
                let name = self.shape_obj_field(v, "name");
                if let SVal::Str(..) | SVal::OwnStr(_) = name { return name; }
                let val = self.shape_obj_field(v, "value");
                if !matches!(val, SVal::Null) { return self.shape_head_text(val); }
                let left = self.shape_obj_field(v, "left");
                if !matches!(left, SVal::Null) { return self.shape_head_text(left); }
                let kids = self.shape_obj_field(v, "children");
                if let SVal::List(s, l) = kids {
                    if l > 0 {
                        let first = self.arena.lists[s as usize];
                        return self.shape_head_text(first);
                    }
                }
                if let SVal::NodeList(s, l) = kids {
                    if l > 0 {
                        let e = self.arena.node_lists[s as usize];
                        return self.customs.tnode_head_text((e >> 24) as u16, e & 0xFFFFFF);
                    }
                }
                let arg = self.shape_obj_field(v, "argument");
                if !matches!(arg, SVal::Null) { return self.shape_head_text(arg); }
                SVal::Str(0, 0)
            }
            SVal::_Marker(_) => SVal::Str(0, 0),
        }
    }
    /// String view of a head-text value (for guard comparisons).
    fn shape_sval_str<'s>(ar: &'s AstArena<'a>, v: SVal<'a>) -> &'s str {
        match v {
            SVal::Str(o, l) => &ar.src[o as usize..(o + l) as usize],
            SVal::OwnStr(i) => &ar.strings[i as usize],
            _ => "",
        }
    }

${methods}
}

pub fn parse_ast_with<'a, 'c, C: ShapeCustoms<'a>>(src: &'a str, customs: &'c C) -> Option<AstRoot<'a>> {
    parse_ast_impl(src, customs, false, &mut None)
}
pub fn parse_ast_with_buf<'a, 'c, C: ShapeCustoms<'a>>(src: &'a str, customs: &'c C, events_buf: &mut Option<Vec<StreamEvent>>) -> Option<AstRoot<'a>> {
    parse_ast_impl(src, customs, true, events_buf)
}
fn parse_ast_impl<'a, 'c, C: ShapeCustoms<'a>>(src: &'a str, customs: &'c C, emit_events: bool, events_buf: &mut Option<Vec<StreamEvent>>) -> Option<AstRoot<'a>> {
    let toks = lex(src);
    let n = toks.len();
    customs.reserve(n);
    let events_init = events_buf.take().unwrap_or_else(Vec::new);
    let mut parser = ShapeParser {
        src, toks, pos: 0, customs,
        arena: AstArena {
            src,
            lists: Vec::with_capacity(n + 64),
            node_lists: Vec::with_capacity(n / 8 + 64),
            fields: Vec::with_capacity(n * 2 + 64),
            nodes: Vec::with_capacity(n * 3 / 4 + 64),
            partials: Vec::with_capacity(128),
            partial_count: 0,
            strings: Vec::with_capacity(n / 32 + 64),
        },
        vals: Vec::with_capacity(1024),
        ap_stack: Vec::with_capacity(256),
        suppress_next: None, suppress_cur: None, suppress_log: Vec::with_capacity(64), capped: false,
        emit_events,
        events: events_init,
    };
    let root = parser.parse_ast_${ir.entry}()?;
    if parser.pos != parser.toks.len() { return None; }
    let events = parser.events;
    if emit_events { *events_buf = Some(events.clone()); }
    Some(AstRoot { root, arena: parser.arena, events })
}
pub fn parse_ast(src: &str) -> Option<AstRoot<'_>> {
    parse_ast_with(src, &DefaultShapeCustoms)
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
pub struct Tokens<'a> { src: &'a str, toks: Vec<Tok> }
/// Lex ONCE; the resulting tokens carry the source slice. A token is a LEAF iff
/// no node span from a parse covers it — every node span is covered by its
/// parent, so the uncovered token ranges are exactly the leaves (see parse_stream).
pub fn tokenize<'a>(src: &'a str) -> Tokens<'a> { Tokens { src, toks: lex(src) } }
fn parse<'a>(tokens: Tokens<'a>) -> Option<(Parser<'a>, i32)> {
    let mut p = Parser { toks: tokens.toks, pos: 0, max_look: 0, capped: false, suppress_next: Vec::new(), suppress_cur: Vec::new(), src: tokens.src, b: CstBuilder::default(), scratch: Vec::new()${reuseInit} };
    match p.parse_${ir.entry}() {
        Some(fr) if p.pos == p.toks.len() && fr.present => Some((p, fr.h)),
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

/** Emit a Rust parser with an optional specialized declarative-shape AST entry. */
export function emitRust(grammar: CstGrammar, opts?: { shape?: ShapeSpec }): string {
  const lexerSrc = rustTarget.embedLexer(grammar);
  const base = rustTarget.emitParser(grammar, lexerSrc);
  if (!opts?.shape) return base;
  const shapeIR = validateShapeOrThrow(grammar, opts.shape);
  const ir = portableIR(grammar);
  const ids = buildLexIdPlan(ir);
  return base + emitRustShapeAddon(ir, shapeIR, ids);
}
