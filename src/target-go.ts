// The Go Target for emit-portable. Renders the same language-agnostic ParserIR as tsTarget
// into a self-contained Go program (Go stdlib only — the lexer is regex-free, so it compiles
// with no module dependencies). Its CST JSON is checked byte-for-byte against the interpreter,
// so `emitParser(grammar, goTarget)` is a real, verified Go parser derived from the
// same grammar definition.
//
// ARENA allocation (to minimise GC pressure, as tsgo does): nodes live in a flat `nodes []Node`,
// their children in a flat `kids []int32`, and in-progress children accumulate on a `scratch`
// stack. A node is an int32 index, never a heap pointer. Backtracking truncates the three
// slices to saved lengths; the slices keep their capacity across parses (reset to len 0), so a
// warmed parser allocates ~nothing per parse.
import { type ParserIR, type RdRule, type PrattRule, type Step, type Bracket, type CharRange, type LexTok, type TplCfg, type NewlineCfg, type FirstSig, type LexFirstBytes, type LexIdPlan, type ArenaIdPlan } from './emit-portable.ts';
import { portableIR, buildLexDispatchPlan, lexTokFirstBytes, punctFirstBytes, buildLexIdPlan, buildLidPrefilter, buildArenaIdPlan, lidOf, kidOf, lidFlagTable, kidFlagTable, ttIdOf, ruleIdOf, TT_SKIP_PUNCT, rangesHaveNonAscii, isFirstGuardable, groupByPreserveOrder } from './emit-portable.ts';
import type { Target } from './emit.ts';
import type { TokenPattern, CstGrammar } from './types.ts';

const J = (v: unknown) => JSON.stringify(v);
const rangeCond = (v: string, rs: CharRange[]) =>
  '(' + rs.map(([lo, hi]) => (lo === hi ? `${v} == ${lo}` : `${v} >= ${lo} && ${v} <= ${hi}`)).join(' || ') + ')';

function bailCondGo(v: string, bail: number[], bailNonAscii: boolean): string {
  const parts = bail.map((c) => `${v} == ${c}`);
  if (bailNonAscii) parts.push(`${v} >= 128`);
  return parts.length ? parts.join(' || ') : 'false';
}

function emitAsciiBoolTableGo(name: string, rs: CharRange[]): string {
  const idxs: number[] = [];
  for (const [lo, hi] of rs) {
    for (let c = Math.max(0, lo); c <= Math.min(127, hi); c++) idxs.push(c);
  }
  return `var ${name} = [256]bool{${idxs.map((i) => `${i}: true`).join(', ')}}`;
}

// Boolean expr testing whether the buffered token t starts branch i (FIRST set membership).
const firstCond = (f: FirstSig, t: string, ids: LexIdPlan) => f
  ? `(${f.lits.map((l) => `${t}.Lid == ${lidOf(ids, l)}`).join(' || ') || 'false'} || ${f.toks.map((k) => `${t}.Kid == ${kidOf(ids, k)}`).join(' || ') || 'false'})`
  : 'false';
/** Non-null FirstSig small enough to pre-filter before a backtracking attempt. */
const isGuardable = (f: FirstSig, nAlts?: number): f is NonNullable<FirstSig> =>
  isFirstGuardable(f, nAlts);

/** Emit kid/lid lookup tables into generated lexer source. */
function renderIdTablesGo(ids: LexIdPlan): string {
  const kidsLit = ids.kids.map(J).join(', ');
  const lidsLit = ids.lids.map(J).join(', ');
  const pf = buildLidPrefilter(ids);
  const bitsLit = [...pf.firstByLenBits].join(', ');
  return `var KIND_STR = []string{${kidsLit}}
var _lids = []string{${lidsLit}}
var _kidMap = map[string]uint16{}
var _lidMap = map[string]uint16{}
const _lidMaxLen = ${pf.maxByteLen}
var _lidFirstBits = [...]byte{${bitsLit}}

func init() {
\tfor i, k := range KIND_STR { _kidMap[k] = uint16(i) }
\tfor i, t := range _lids { _lidMap[t] = uint16(i) }
}
func kidOf(kind string) uint16 { if v, ok := _kidMap[kind]; ok { return v }; return 0 }
func lidOf(text string) uint16 {
\tn := len(text)
\tif n == 0 || n > _lidMaxLen { return 0 }
\tb0 := text[0]
\t// Ident/@-keyword shape: O(1) length×first-byte miss ⇒ lid 0. Punct first bytes skip the probe.
\tif (b0 >= 'A' && b0 <= 'Z') || (b0 >= 'a' && b0 <= 'z') || b0 == '_' || b0 == '$' || b0 == '@' {
\t\tif _lidFirstBits[n*32+(int(b0)>>3)]&(1<<(b0&7)) == 0 { return 0 }
\t}
\tif v, ok := _lidMap[text]; ok { return v }
\treturn 0
}
func tokKind(t *Tok) string { return KIND_STR[t.Kid] }
func tokText(src string, t *Tok) string { return src[t.Off:t.End] }
func mkTok(off, end int, nl bool, kid, lid uint16) Tok { return Tok{Off: uint32(off), End: uint32(end), Kid: kid, Lid: lid, Nl: nl} }
`;
}

/** Emit TT_NAMES / RULE_NAMES lookup tables for arena slim encoding. */
function renderArenaTablesGo(ar: ArenaIdPlan): string {
  return `var TT_NAMES = []string{${ar.ttNames.map(J).join(', ')}}
var RULE_NAMES = []string{${ar.ruleNames.map(J).join(', ')}}
const TT_SKIP_PUNCT = ${TT_SKIP_PUNCT}
`;
}

// Compile a token-pattern AST to backtracking-free package-level matcher funcs
// `_mN(p int) int` (new position, or -1) over the module-level source `_s`.
function ccCondGo(p: Extract<TokenPattern, { type: 'charClass' }>): string {
  const parts = p.items.map((it) =>
    it.type === 'char' ? `cc == ${it.value.charCodeAt(0)}` : `cc >= ${it.from.charCodeAt(0)} && cc <= ${it.to.charCodeAt(0)}`);
  const inSet = '(' + parts.join(' || ') + ')';
  return p.negate ? `!${inSet}` : inSet;
}
function compilePat(p: TokenPattern, defs: string[]): string {
  const name = `_m${defs.length}`;
  defs.push('');
  let body: string;
  if (typeof p === 'string') {
    body = `{ if p <= len(_s) && strings.HasPrefix(_s[p:], ${J(p)}) { return p + ${p.length} }; return -1 }`;
  } else switch (p.type) {
    case 'anyChar': body = `{ if p < len(_s) { return p + 1 }; return -1 }`; break;
    case 'charClass': body = `{ if p >= len(_s) { return -1 }; cc := int(_s[p]); if ${ccCondGo(p)} { return p + 1 }; return -1 }`; break;
    case 'seq': { const ms = p.items.map((x) => compilePat(x, defs)); body = `{ ${ms.map((m) => `p = ${m}(p); if p < 0 { return -1 }`).join('; ')}; return p }`; break; }
    case 'alt': { const ms = p.items.map((x) => compilePat(x, defs)); body = `{ ${ms.map((m) => `if r := ${m}(p); r >= 0 { return r }`).join('; ')}; return -1 }`; break; }
    case 'repeat': { const m = compilePat(p.body, defs); const mx = p.max !== undefined ? `; if c >= ${p.max} { break }` : ''; body = `{ q, c := p, 0; for { r := ${m}(q); if r < 0 || r == q { break }; q = r; c++${mx} }; if c >= ${p.min} { return q }; return -1 }`; break; }
    case 'lookahead': { const m = compilePat(p.body, defs); body = `{ r := ${m}(p); if ${p.negate ? 'r < 0' : 'r >= 0'} { return p }; return -1 }`; break; }
    case 'anchor': body = p.kind === 'start' ? `{ if p == 0 { return p }; return -1 }` : `{ if p == len(_s) { return p }; return -1 }`; break;
    default: throw new Error(`portable Go lexer: pattern '${(p as { type: string }).type}' unsupported`);
  }
  defs[Number(name.slice(2))] = `func ${name}(p int) int ${body}`;
  return name;
}

function scanTok(t: LexTok, defs: string[], stateful: boolean, ids: LexIdPlan, rxTok?: string, tplTok?: string): string {
  const name = (t as { name: string }).name;
  if (tplTok !== undefined && name === tplTok) return '';   // template token scanned by the state machine
  const kid = kidOf(ids, name);
  const push = (endE: string) => (t.skip
    ? `if strings.ContainsAny(src[pos:${endE}], "\\n\\r\\u2028\\u2029") { pendingNl = true }; `
    : `${stateful ? 'emit' : 'pushTok'}(pos, ${endE}, ${kid}, lidOf(src[pos:${endE}])); `);
  const gate = rxTok !== undefined && name === rxTok ? '!prevIsValue() && ' : '';
  if (t.kind === 'run') return `\t\tif ${gate}${rangeCond('c', t.first)} {
\t\t\te := pos + 1
\t\t\tfor e < n { cc := int(src[e]); if !${rangeCond('cc', t.cont)} { break }; e++ }
\t\t\t${push('e')}pos = e; continue
\t\t}`;
  if (t.kind === 'runBail') {
    if (rangesHaveNonAscii(t.cont)) {
      const m = compilePat(t.pattern, defs);
      return `\t\tif ${gate ? gate + 'true' : 'true'} { if e := ${m}(pos); e > pos { ${push('e')}pos = e; continue } }`;
    }
    const tag = t.name.replace(/[^A-Za-z0-9_]/g, '_');
    const fTab = `_rbF_${tag}`, cTab = `_rbC_${tag}`;
    defs.push(emitAsciiBoolTableGo(fTab, t.first));
    defs.push(emitAsciiBoolTableGo(cTab, t.cont));
    const m = compilePat(t.pattern, defs);
    const bailAt = (v: string) => bailCondGo(v, t.bail, t.bailNonAscii);
    // Entry fallback covers cont-bail chars AND complex-head entry chars (headBail).
    const entryBail = bailCondGo('c', [...new Set([...t.bail, ...t.headBail])].sort((a, b) => a - b), t.bailNonAscii || t.headBailNonAscii);
    return `\t\tif ${gate}${fTab}[c] {
\t\t\te := pos + 1
\t\t\tfor e < n && ${cTab}[src[e]] { e++ }
\t\t\tif e >= n || !(${bailAt('int(src[e])')}) { ${push('e')}pos = e; continue }
\t\t\tif e2 := ${m}(pos); e2 > pos { ${push('e2')}pos = e2; continue }
\t\t} else if ${entryBail} {
\t\t\tif e := ${m}(pos); e > pos { ${push('e')}pos = e; continue }
\t\t}`;
  }
  if (t.kind === 'string') return `\t\tif ${gate}c == ${t.delim.charCodeAt(0)} {
\t\t\te := pos + 1
\t\t\tclosed := false
\t\t\tfor e < n { ch := int(src[e]); if ch == 92 { e += 2; continue }; if ch == ${t.delim.charCodeAt(0)} { e++; closed = true; break }; e++ }
\t\t\tif closed { ${push('e')}pos = e; continue }
\t\t}`;
  if (t.kind === 'line') return `\t\tif ${gate}strings.HasPrefix(src[pos:], ${J(t.prefix)}) {
\t\t\te := pos + ${t.prefix.length}
\t\t\tfor e < n && src[e] != 10 { e++ }
\t\t\t${push('e')}pos = e; continue
\t\t}`;
  if (t.kind === 'block') return `\t\tif ${gate}strings.HasPrefix(src[pos:], ${J(t.open)}) {
\t\t\te := pos + ${t.open.length}
\t\t\tfor e < n && !strings.HasPrefix(src[e:], ${J(t.close)}) { e++ }
\t\t\tif e < n { e += ${t.close.length}; ${push('e')}pos = e; continue }
\t\t}`;
  const m = compilePat(t.pattern, defs);
  return `\t\tif ${gate ? gate + 'true' : 'true'} { if e := ${m}(pos); e > pos { ${push('e')}pos = e; continue } }`;
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
function renderLexByteDispatchGo(codes: string[], firsts: (LexFirstBytes | null)[], indent: string): string {
  const { arms, fallbackIndices } = buildLexDispatchPlan(firsts);
  const fallback = fallbackIndices.map((i) => codes[i]).join('\n');
  let switchArms = '';
  for (const arm of arms) {
    switchArms += `${indent}\tcase ${arm.bytes.join(', ')}:\n`;
    switchArms += arm.indices.map((i) => codes[i]).join('\n') + '\n';
  }
  return `${indent}if c >= 128 {
${fallback}
${indent}} else {
${indent}\tswitch c {
${switchArms}${indent}\t}
${indent}}`;
}

function newlinePartsGo(nl: NewlineCfg, pushFn: string, ids: LexIdPlan): { state: string; stateFrom: string; boundary: string; ws: string; hooks: string } {
  const commentSkip = nl.comment
    ? `\t\tif strings.HasPrefix(src[p:], ${J(nl.comment)}) { e := p; for e < n && src[e] != 10 { e++ }; pos = e; continue }\n`
    : '';
  const kidNl = kidOf(ids, nl.token);
  return {
    state: `\tlineStart, emittedContent, flowDepth := true, false, 0
\t_flowOpen := map[string]bool{${nl.flowOpen.map((x) => `${J(x)}: true`).join(', ')}}
\t_flowClose := map[string]bool{${nl.flowClose.map((x) => `${J(x)}: true`).join(', ')}}
`,
    stateFrom: `\t_flowOpen := map[string]bool{${nl.flowOpen.map((x) => `${J(x)}: true`).join(', ')}}
\t_flowClose := map[string]bool{${nl.flowClose.map((x) => `${J(x)}: true`).join(', ')}}
`,
    boundary: `\t\tif flowDepth == 0 && lineStart {
\t\t\tp := pos
\t\t\tfor p < n && src[p] == 32 { p++ }
\t\t\tif p >= n { pos = p; lineStart = false; continue }
\t\t\tch := int(src[p])
\t\t\tif ch == 10 || ch == 13 {
\t\t\t\tpos = p + 1; if ch == 13 && pos < n && src[pos] == 10 { pos++ }; continue
\t\t\t}
\t\t\tif ch == 9 {
\t\t\t\tb := p
\t\t\t\tfor b < n && (src[b] == 32 || src[b] == 9) { b++ }
\t\t\t\tif b >= n { pos = b; continue }
\t\t\t\tbc := int(src[b])
\t\t\t\tif bc == 10 || bc == 13 {
\t\t\t\t\tpos = b + 1; if bc == 13 && pos < n && src[pos] == 10 { pos++ }; continue
\t\t\t\t}
\t\t\t}
${commentSkip}\t\t\tpos = p
\t\t\tif emittedContent { ${pushFn}(pos, pos, ${kidNl}, 0) }
\t\t\tlineStart = false
\t\t\tcontinue
\t\t}
`,
    ws: `\t\tif c == 32 || c == 9 || c == 11 || c == 12 || c == 160 || c == 5760 || (c >= 8192 && c <= 8202) || c == 8239 || c == 8287 || c == 12288 || c == 65279 { pos++; continue }
\t\tif c == 10 || c == 13 {
\t\t\tpos++; if c == 13 && pos < n && src[pos] == 10 { pos++ }
\t\t\tif flowDepth == 0 { lineStart = true }
\t\t\tcontinue
\t\t}
`,
    hooks: `\t\tif kid != ${kidNl} { emittedContent = true }
\t\tif kid == 0 && _flowOpen[_lids[lid]] { flowDepth++ } else if kid == 0 && _flowClose[_lids[lid]] { if flowDepth > 0 { flowDepth-- } }
`,
  };
}

function lexer(ir: ParserIR): string {
  const ids = buildLexIdPlan(ir);
  const defs: string[] = [];
  const rx = ir.regexCtx;
  const tpl = ir.tpl;
  const nl = ir.newlineCfg;
  const rxOnly = !!(rx && !tpl && !nl);
  const tplOnly = !!(tpl && !rx && !nl);
  const rxTpl = !!(rx && tpl && !nl);
  const rxOrTpl = !!(rx || tpl) && !rxOnly && !tplOnly && !rxTpl;
  const stateful = !!(rx || tpl);
  const newlineOnly = !!(nl && !rx && !tpl);
  const pushPunct = stateful
    ? (p: string) => `emit(pos, pos + ${p.length}, 0, ${lidOf(ids, p)})`
    : (p: string) => `pushTok(pos, pos + ${p.length}, 0, ${lidOf(ids, p)})`;
  const punctLine = (p: string) =>
    `\t\tif strings.HasPrefix(src[pos:], ${J(p)}) { ${pushPunct(p)}; pos += ${p.length}; continue }`;
  const { codes: lexCodes, firsts: lexFirsts } = buildLexCandidates(ir, defs, stateful, ids, rx?.regexToken, tpl?.token, punctLine);
  const cascade = renderLexByteDispatchGo(lexCodes, lexFirsts, '\t');
  const goBoolArr = (name: string, flags: boolean[]) =>
    `var ${name} = []bool{${flags.map((b) => (b ? 'true' : 'false')).join(', ')}}`;
  const rxBitTables = rx ? `${goBoolArr('_divT', lidFlagTable(ids, rx.divisionTexts))}
${goBoolArr('_divK', kidFlagTable(ids, rx.divisionTypes))}
${goBoolArr('_rxT', lidFlagTable(ids, rx.regexTexts))}
${goBoolArr('_phK', lidFlagTable(ids, rx.parenHeadKw))}
${goBoolArr('_mem', lidFlagTable(ids, rx.memberAccess))}
${goBoolArr('_pav', lidFlagTable(ids, rx.postfixAfterValue))}
const KID_IDENT uint16 = ${kidOf(ids, rx.identToken)}
const LID_LPAREN uint16 = ${lidOf(ids, '(')}
const LID_RPAREN uint16 = ${lidOf(ids, ')')}
` : '';
  const tplLidConsts = tpl ? `const LID_BRACE_OPEN uint16 = ${lidOf(ids, tpl.braceOpen)}
const LID_INTERP_CLOSE uint16 = ${lidOf(ids, tpl.interpClose)}
` : '';
  const rxModuleConsts = `${rxBitTables}${tplLidConsts}`;
  const rxState = rx ? `\tprevLid, prevKid, bpLid := uint16(0), uint16(0), uint16(0)
\thasPrev, hasPrev2 := false, false
\tparenHead := []bool{}
\tlastClose, lastBang := false, false
\tprevIsValue := func() bool {
\t\tif !hasPrev { return false }
\t\tif _pav[prevLid] { return lastBang }
\t\tisExprKw := prevKid == KID_IDENT && _rxT[prevLid]
\t\tisParenHead := prevLid == LID_RPAREN && lastClose
\t\treturn !isExprKw && !isParenHead && (_divK[prevKid] || _divT[prevLid])
\t}
` : '';
  const tplState = tpl ? `\ttemplateStack := []int{}
\tscanTplSpan := func(p int) (bool, int) {
\t\tfor p < n {
\t\t\tif strings.HasPrefix(src[p:], ${J(tpl.interpOpen)}) { return true, p + ${tpl.interpOpen.length} }
\t\t\tif src[p] == 92 { p += 2; continue }
\t\t\tif strings.HasPrefix(src[p:], ${J(tpl.open)}) { return false, p + ${tpl.open.length} }
\t\t\tp++
\t\t}
\t\tpanic(fmt.Sprintf("Unterminated template literal at offset %d", p))
\t}
\t_ = scanTplSpan
` : '';
  const emitHooks = [
    rx ? `\t\tif lid == LID_LPAREN {
\t\t\tisMember := hasPrev2 && _mem[bpLid]
\t\t\tparenHead = append(parenHead, !isMember && prevKid == KID_IDENT && _phK[prevLid])
\t\t} else if lid == LID_RPAREN {
\t\t\tif len(parenHead) > 0 { lastClose = parenHead[len(parenHead)-1]; parenHead = parenHead[:len(parenHead)-1] } else { lastClose = false }
\t\t}
\t\tif _pav[lid] { lastBang = prevIsValue() }` : '',
    tpl ? `\t\tif len(templateStack) > 0 { if lid == LID_BRACE_OPEN { templateStack[len(templateStack)-1]++ } else if lid == LID_INTERP_CLOSE { templateStack[len(templateStack)-1]-- } }` : '',
    nl ? newlinePartsGo(nl, 'emit', ids).hooks : '',
  ].filter(Boolean).join('\n');
  const emitTail = rx ? `\n\t\tbpLid = prevLid; hasPrev2 = hasPrev; prevKid = kid; prevLid = lid; hasPrev = true` : '';
  const emitFn = stateful ? `\temit := func(off, end int, kid, lid uint16) {
${emitHooks}
\t\ttoks = append(toks, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false${emitTail}
\t}
\t_ = emit
` : '';
  const rxStateFrom = rx ? `\tprevIsValue := func() bool {
\t\tif !hasPrev { return false }
\t\tif _pav[prevLid] { return lastBang }
\t\tisExprKw := prevKid == KID_IDENT && _rxT[prevLid]
\t\tisParenHead := prevLid == LID_RPAREN && lastClose
\t\treturn !isExprKw && !isParenHead && (_divK[prevKid] || _divT[prevLid])
\t}
` : '';
  const tplStateFrom = tpl ? `\tscanTplSpan := func(p int) (bool, int) {
\t\tfor p < n {
\t\t\tif strings.HasPrefix(src[p:], ${J(tpl.interpOpen)}) { return true, p + ${tpl.interpOpen.length} }
\t\t\tif src[p] == 92 { p += 2; continue }
\t\t\tif strings.HasPrefix(src[p:], ${J(tpl.open)}) { return false, p + ${tpl.open.length} }
\t\t\tp++
\t\t}
\t\tpanic(fmt.Sprintf("Unterminated template literal at offset %d", p))
\t}
\t_ = scanTplSpan
` : '';
  const emitRxOnly = rx ? `\temit := func(off, end int, kid, lid uint16) {
\t\tif lid == LID_LPAREN {
\t\t\tisMember := hasPrev2 && _mem[bpLid]
\t\t\tparenHead = append(parenHead, !isMember && prevKid == KID_IDENT && _phK[prevLid])
\t\t} else if lid == LID_RPAREN {
\t\t\tif len(parenHead) > 0 { lastClose = parenHead[len(parenHead)-1]; parenHead = parenHead[:len(parenHead)-1] } else { lastClose = false }
\t\t}
\t\tif _pav[lid] { lastBang = prevIsValue() }
\t\t*acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t\tbpLid = prevLid; hasPrev2 = hasPrev; prevKid = kid; prevLid = lid; hasPrev = true
\t}
\t_ = emit
` : '';
  const emitTplOnly = tpl ? `\temit := func(off, end int, kid, lid uint16) {
\t\tif len(templateStack) > 0 { if lid == LID_BRACE_OPEN { templateStack[len(templateStack)-1]++ } else if lid == LID_INTERP_CLOSE { templateStack[len(templateStack)-1]-- } }
\t\t*acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t}
\t_ = emit
` : '';
  const emitRxTpl = (rx && tpl) ? `\temit := func(off, end int, kid, lid uint16) {
\t\tif lid == LID_LPAREN {
\t\t\tisMember := hasPrev2 && _mem[bpLid]
\t\t\tparenHead = append(parenHead, !isMember && prevKid == KID_IDENT && _phK[prevLid])
\t\t} else if lid == LID_RPAREN {
\t\t\tif len(parenHead) > 0 { lastClose = parenHead[len(parenHead)-1]; parenHead = parenHead[:len(parenHead)-1] } else { lastClose = false }
\t\t}
\t\tif _pav[lid] { lastBang = prevIsValue() }
\t\tif len(templateStack) > 0 { if lid == LID_BRACE_OPEN { templateStack[len(templateStack)-1]++ } else if lid == LID_INTERP_CLOSE { templateStack[len(templateStack)-1]-- } }
\t\t*acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t\tbpLid = prevLid; hasPrev2 = hasPrev; prevKid = kid; prevLid = lid; hasPrev = true
\t}
\t_ = emit
` : '';
  const tplDispatch = tpl ? `\t\tif len(templateStack) > 0 && strings.HasPrefix(src[pos:], ${J(tpl.interpClose)}) && templateStack[len(templateStack)-1] == 0 {
\t\t\ttemplateStack = templateStack[:len(templateStack)-1]
\t\t\tinterp, e := scanTplSpan(pos + ${tpl.interpClose.length})
\t\t\tif interp { emit(pos, e, ${kidOf(ids, '$templateMiddle')}, lidOf(src[pos:e])); templateStack = append(templateStack, 0) } else { emit(pos, e, ${kidOf(ids, '$templateTail')}, lidOf(src[pos:e])) }
\t\t\tpos = e; continue
\t\t}
\t\tif strings.HasPrefix(src[pos:], ${J(tpl.open)}) {
\t\t\tinterp, e := scanTplSpan(pos + ${tpl.open.length})
\t\t\tif interp { emit(pos, e, ${kidOf(ids, '$templateHead')}, lidOf(src[pos:e])); templateStack = append(templateStack, 0) } else { emit(pos, e, ${kidOf(ids, tpl.token)}, lidOf(src[pos:e])) }
\t\t\tpos = e; continue
\t\t}
` : '';
  const nlState = nl ? newlinePartsGo(nl, stateful ? 'emit' : 'pushTok', ids).state : '';
  const nlStateFrom = nl ? newlinePartsGo(nl, 'pushTok', ids).stateFrom : '';
  const nlBoundary = nl ? newlinePartsGo(nl, stateful ? 'emit' : 'pushTok', ids).boundary : '';
  const nlWs = nl ? newlinePartsGo(nl, stateful ? 'emit' : 'pushTok', ids).ws : `\t\tif strings.HasPrefix(src[pos:], ${J('\u2028')}) || strings.HasPrefix(src[pos:], ${J('\u2029')}) { pendingNl = true; pos += 3; continue }   // LS/PS (UTF-8)
\t\tif c == 10 || c == 13 { pendingNl = true; pos++; continue }   // LF/CR
\t\tif c == 32 || c == 9 || c == 11 || c == 12 || c == 160 || c == 5760 || (c >= 8192 && c <= 8202) || c == 8239 || c == 8287 || c == 12288 || c == 65279 { pos++; continue }
`;
  const pushHooks = nl && !stateful ? newlinePartsGo(nl, 'pushTok', ids).hooks : '';
  const pushTokFn = stateful ? '' : nl
    ? `\tpushTok := func(off, end int, kid, lid uint16) {
${pushHooks}\t\ttoks = append(toks, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t}
\t_ = pushTok
`
    : `\tpushTok := func(off, end int, kid, lid uint16) { toks = append(toks, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false }\n\t_ = pushTok\n`;
  const pushTokAccFn = nl && !stateful
    ? `\tpushTok := func(off, end int, kid, lid uint16) {
${pushHooks}\t\t*acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t}
\t_ = pushTok
`
    : `\tpushTok := func(off, end int, kid, lid uint16) { *acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false }
\t_ = pushTok
`;
  const loopBody = `${nlBoundary}\t\tc := int(src[pos])
${nlWs}${tplDispatch}${cascade}
\t\tpanic(fmt.Sprintf("Unexpected character at offset %d: '%c'", pos, src[pos]))`;
  const idTables = renderIdTablesGo(ids);
  if (rxOnly) {
    return `${idTables}${rxModuleConsts}${defs.length ? 'var _s string\n' + defs.join('\n') + '\n' : ''}func lexFrom(src string, pos int, pendingNl bool, prevLid, prevKid, bpLid uint16, hasPrev, hasPrev2 bool, parenHead []bool, lastClose, lastBang bool, acc *[]Tok, limit int) (int, bool, uint16, uint16, uint16, bool, bool, []bool, bool, bool) {
\tn := len(src)
${rxStateFrom}${emitRxOnly}${defs.length ? '\t_s = src\n' : ''}\tbase := len(*acc)
\tfor pos < n && (limit <= 0 || len(*acc)-base < limit) {
${loopBody}
\t}
\treturn pos, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang
}
func lex(src string) []Tok {
\tvar out []Tok
\tlexFrom(src, 0, false, 0, 0, 0, false, false, nil, false, false, &out, 0)
\treturn out
}`;
  }
  if (tplOnly) {
    return `${idTables}${rxModuleConsts}${defs.length ? 'var _s string\n' + defs.join('\n') + '\n' : ''}func lexFrom(src string, pos int, pendingNl bool, templateStack []int, acc *[]Tok, limit int) (int, bool, []int) {
\tn := len(src)
${tplStateFrom}${emitTplOnly}${defs.length ? '\t_s = src\n' : ''}\tbase := len(*acc)
\tfor pos < n && (limit <= 0 || len(*acc)-base < limit) {
${loopBody}
\t}
\treturn pos, pendingNl, templateStack
}
func lex(src string) []Tok {
\tvar out []Tok
\tlexFrom(src, 0, false, nil, &out, 0)
\treturn out
}`;
  }
  if (rxTpl) {
    return `${idTables}${rxModuleConsts}${defs.length ? 'var _s string\n' + defs.join('\n') + '\n' : ''}func lexFrom(src string, pos int, pendingNl bool, prevLid, prevKid, bpLid uint16, hasPrev, hasPrev2 bool, parenHead []bool, lastClose, lastBang bool, templateStack []int, acc *[]Tok, limit int) (int, bool, uint16, uint16, uint16, bool, bool, []bool, bool, bool, []int) {
\tn := len(src)
${rxStateFrom}${tplStateFrom}${emitRxTpl}${defs.length ? '\t_s = src\n' : ''}\tbase := len(*acc)
\tfor pos < n && (limit <= 0 || len(*acc)-base < limit) {
${loopBody}
\t}
\treturn pos, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang, templateStack
}
func lex(src string) []Tok {
\tvar out []Tok
\tlexFrom(src, 0, false, 0, 0, 0, false, false, nil, false, false, nil, &out, 0)
\treturn out
}`;
  }
  if (rxOrTpl) {
    return `${idTables}${rxModuleConsts}${defs.length ? 'var _s string\n' + defs.join('\n') + '\n' : ''}func lex(src string) []Tok {
\ttoks := toks[:0]
\tn := len(src)
\tpos := 0
\tpendingNl := false
\t_ = pendingNl
${rxState}${tplState}${nlState}${emitFn}${pushTokFn}${defs.length ? '\t_s = src\n' : ''}\tfor pos < n {
${loopBody}
\t}
\treturn toks
}`;
  }
  if (newlineOnly) {
    return `${idTables}${defs.length ? 'var _s string\n' + defs.join('\n') + '\n' : ''}func lexFrom(src string, pos int, pendingNl bool, lineStart bool, emittedContent bool, flowDepth int, acc *[]Tok, limit int) (int, bool, bool, bool, int) {
\tn := len(src)
${nlStateFrom}${pushTokAccFn}${defs.length ? '\t_s = src\n' : ''}\tbase := len(*acc)
\tfor pos < n && (limit <= 0 || len(*acc)-base < limit) {
${loopBody}
\t}
\treturn pos, pendingNl, lineStart, emittedContent, flowDepth
}
func lex(src string) []Tok {
\tvar out []Tok
\tlexFrom(src, 0, false, true, false, 0, &out, 0)
\treturn out
}`;
  }
  return `${idTables}${defs.length ? 'var _s string\n' + defs.join('\n') + '\n' : ''}func lexFrom(src string, pos int, pendingNl bool, acc *[]Tok, limit int) (int, bool) {
\tn := len(src)
${pushTokAccFn}${defs.length ? '\t_s = src\n' : ''}\tbase := len(*acc)
\tfor pos < n && (limit <= 0 || len(*acc)-base < limit) {
${loopBody}
\t}
\treturn pos, pendingNl
}
func lex(src string) []Tok {
\tvar out []Tok
\tlexFrom(src, 0, false, &out, 0)
\treturn out
}`;
}

function stepCond(s: Step, ids: LexIdPlan, ar: ArenaIdPlan): string {
  switch (s.t) {
    case 'lit': return `matchLit(${lidOf(ids, s.value)}, ${ttIdOf(ar, s.ttype)})`;
    case 'tok': return `matchTok(${kidOf(ids, s.name)}, ${ttIdOf(ar, s.name)})`;
    case 'rule': return `callRule(parse${s.name})`;
    case 'ruleBp': return `callRule(func() int32 { return ${s.name}bp(${s.bp}) })`;
    case 'star': return `star(func() bool { return ${stepCond(s.step, ids, ar)} })`;
    case 'opt': return `opt(func() bool { return ${s.steps.map((x) => stepCond(x, ids, ar)).join(' && ')} })`;
    case 'sep': return `sepBy(func() bool { return ${stepCond(s.elem, ids, ar)} }, ${lidOf(ids, s.delim)})`;
    case 'altlit': return `altLit([]struct{ Lid uint16; TtId uint8 }{${s.opts.map((o) => `{${lidOf(ids, o.value)}, ${ttIdOf(ar, o.ttype)}}`).join(', ')}})`;
    case 'alt': {
      if (s.predictive) return `func() bool { ${predAltBody(s.branches, ids, s.firsts, ar)} }()`;
      const firsts = s.firsts ?? [];
      const nAlts = s.branches.length;
      const needPeek = s.branches.some((_, i) => isGuardable(firsts[i] ?? null, nAlts));
      const peekInit = needPeek ? `_ft := peek(); ` : '';
      const tries = s.branches.map((br, i) => {
        const body = `{ save := pos; sb := len(scratch); nb := len(nodes); kb := len(kids); if ${br.length ? br.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'} { return true }; pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb] }`;
        const f = firsts[i] ?? null;
        if (!isGuardable(f, nAlts)) return body;
        return `if _ft != nil && ${firstCond(f, '_ft', ids)} ${body}`;
      }).join('; ');
      return `func() bool { ${peekInit}${tries}; return false }()`;
    }
    case 'not': return `func() bool { save := pos; sb := len(scratch); nb := len(nodes); kb := len(kids); m := ${s.steps.length ? s.steps.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'}; pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; return !m }()`;
    case 'seq': return `(${s.steps.length ? s.steps.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'})`;
    case 'sameLine': return `func() bool { t := peek(); return t != nil && !t.Nl }()`;
    case 'suppress': return `func() bool { _suppressNext = map[uint16]bool{${s.connectors.map((c) => `${lidOf(ids, c)}: true`).join(', ')}}; _r := (${s.steps.length ? s.steps.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'}); _suppressNext = nil; return _r }()`;
  }
}

function predAltBody(branches: Step[][], ids: LexIdPlan, firsts: FirstSig[] | undefined, ar: ArenaIdPlan): string {
  const arms = branches.map((br, i) => `if ${firstCond(firsts![i], 't', ids)} { if ${br.length ? br.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'} { return true } }`).join(' else ');
  return `t := peek(); if t == nil { return false }; ${arms}; return false`;
}

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
    if (step.t === 'rule') return { kind: 'A', topOneBody: `\treturn parse${step.name}()` };
    if (step.t === 'alt') {
      for (const br of step.branches) {
        if (br.length !== 1 || br[0].t !== 'rule') return null;
      }
      const tries = step.branches.map((br) => {
        const name = (br[0] as { t: 'rule'; name: string }).name;
        return `\t{ sp := pos; n := parse${name}(); if n >= 0 { return n }; pos = sp }`;
      }).join('\n');
      return { kind: 'A', topOneBody: `${tries}\n\treturn -1` };
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

function rdRule(r: RdRule, ids: LexIdPlan, ar: ArenaIdPlan): string {
  if (r.predictive) {
    const arm = (steps: Step[], i: number) => `\t${i === 0 ? 'if' : 'else if'} ${firstCond(r.altFirst[i], 't', ids)} { if ${steps.map((x) => stepCond(x, ids, ar)).join(' && ')} { return finish(${ruleIdOf(ar, r.cstName)}, sb, offAt(save), save) } }`;
    return `func parse${r.name}() int32 {
\tsave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\tt := peek(); if t == nil { return -1 }
${r.alts.map(arm).join(' ')}
\tpos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]
\treturn -1
}`;
  }
  const alt = (steps: Step[], i: number) => {
    const cond = steps.map((x) => stepCond(x, ids, ar)).join(' && ');
    const restore = `pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]`;
    if (!isGuardable(r.altFirst[i], r.alts.length)) {
      return `\tif ${cond} { return finish(${ruleIdOf(ar, r.cstName)}, sb, offAt(save), save) }
\t${restore}`;
    }
    return `\tif _ft != nil && ${firstCond(r.altFirst[i], '_ft', ids)} {
\t\tif ${cond} { return finish(${ruleIdOf(ar, r.cstName)}, sb, offAt(save), save) }
\t\t${restore}
\t}`;
  };
  const needPeek = r.alts.some((_, i) => isGuardable(r.altFirst[i], r.alts.length));
  return `func parse${r.name}() int32 {
\tsave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
${needPeek ? '\t_ft := peek()\n' : ''}${r.alts.map(alt).join('\n')}
\treturn -1
}`;
}

/** Entry rule that records per-top-kid EntryMeta (+ Node.ext oracle) via parseTopOne (shape A). */
function rdEntryWithReuseA(r: RdRule, plan: ReusePlanA, ar: ArenaIdPlan): string {
  return `type EntryMeta struct { TokStart, TokEnd, Ext, Off, End, KidStart, KidCount int }
var entries []EntryMeta
func parseTopOne() int32 {
${plan.topOneBody}
}
func parse${r.name}() int32 {
\tsave := pos; sb := len(scratch)
\tcapHint := (len(toks) - pos) / 2
\tif capHint < 8 { capHint = 8 }
\tlocalE := make([]EntryMeta, 0, capHint)
\tfor {
\t\tsp := pos
\t\tmaxLook = 0
\t\tn := parseTopOne()
\t\tif n < 0 { pos = sp; break }
\t\text := nodes[n].TokEnd
\t\tif uint32(maxLook) > ext { ext = uint32(maxLook) }
\t\tnodes[n].Ext = ext // CST oracle for validate assert; reuse decisions read entries
\t\tlocalE = append(localE, EntryMeta{int(nodes[n].TokStart), int(nodes[n].TokEnd), int(ext), int(nodes[n].Offset), int(nodes[n].End), len(scratch) - sb, 1})
\t\tscratch = append(scratch, n)
\t}
\tentries = localE
\treturn finish(${ruleIdOf(ar, r.cstName)}, sb, offAt(save), save)
}`;
}

function rdEntryWithReuseB(r: RdRule, plan: ReusePlanB, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const headFn = plan.hasHead && plan.headRule
    ? `func parseHeadSeg(sb int) (Seg, EntryMeta, bool) {
\tmaxLook = 0
\tbefore := len(scratch)
\topt(func() bool { return callRule(parse${plan.headRule}) })
\tif len(scratch) == before { return Seg{}, EntryMeta{}, false }
\tn := scratch[before]
\text := nodes[n].TokEnd
\tif uint32(maxLook) > ext { ext = uint32(maxLook) }
\tmeta := EntryMeta{int(nodes[n].TokStart), int(nodes[n].TokEnd), int(ext), int(nodes[n].Offset), int(nodes[n].End), before - sb, 1}
\treturn Seg{KidStart: before - sb, KidCount: 1, TokStart: int(nodes[n].TokStart), TokEnd: int(nodes[n].TokEnd), Ext: int(ext)}, meta, true
}
`
    : '';
  const headBlock = plan.hasHead && plan.headRule
    ? `\tif h, m, ok := parseHeadSeg(sb); ok { local = append(local, h); localE = append(localE, m) }
`
    : '';
  return `type Seg struct { KidStart, KidCount, TokStart, TokEnd, Ext int }
type EntryMeta struct { TokStart, TokEnd, Ext, Off, End, KidStart, KidCount int }
var segs []Seg
var entries []EntryMeta
${headFn}func parseLoopSeg(sb int) (Seg, EntryMeta, bool) {
\tsp := pos; before := len(scratch); nb := len(nodes); kb := len(kids)
\tmaxLook = 0
\tif !matchTok(${kidOf(ids, plan.loopTok)}, ${ttIdOf(ar, plan.loopTok)}) {
\t\tpos = sp; scratch = scratch[:before]; nodes = nodes[:nb]; kids = kids[:kb]
\t\treturn Seg{}, EntryMeta{}, false
\t}
\topt(func() bool { return callRule(parse${plan.loopRule}) })
\tleaf := scratch[before]
\tvar tokStart, tokEnd uint32
\tvar off, end uint32
\tif leaf < 0 {
\t\tti, _ := decodeLeaf(leaf)
\t\ttokStart = ti
\t\ttokEnd = ti + 1
\t\toff = toks[ti].Off
\t\tend = toks[ti].End
\t} else {
\t\ttokStart = nodes[leaf].TokStart
\t\ttokEnd = nodes[leaf].TokEnd
\t\toff = nodes[leaf].Offset
\t\tend = nodes[leaf].End
\t}
\tcount := len(scratch) - before
\tif count > 1 {
\t\tsecond := scratch[before+1]
\t\tif second < 0 {
\t\t\tti, _ := decodeLeaf(second)
\t\t\ttokEnd = ti + 1
\t\t\tend = toks[ti].End
\t\t} else {
\t\t\ttokEnd = nodes[second].TokEnd
\t\t\tend = nodes[second].End
\t\t}
\t}
\text := tokEnd
\tif uint32(maxLook) > ext { ext = uint32(maxLook) }
\tmeta := EntryMeta{int(tokStart), int(tokEnd), int(ext), int(off), int(end), before - sb, count}
\treturn Seg{KidStart: before - sb, KidCount: count, TokStart: int(tokStart), TokEnd: int(tokEnd), Ext: int(ext)}, meta, true
}
func parse${r.name}() int32 {
\tsave := pos; sb := len(scratch)
\tcapHint := (len(toks) - pos) / 2
\tif capHint < 8 { capHint = 8 }
\tlocal := make([]Seg, 0, capHint)
\tlocalE := make([]EntryMeta, 0, capHint)
${headBlock}\tfor {
\t\tif seg, m, ok := parseLoopSeg(sb); ok { local = append(local, seg); localE = append(localE, m) } else { break }
\t}
\tsegs = local
\tentries = localE
\treturn finish(${ruleIdOf(ar, r.cstName)}, sb, offAt(save), save)
}`;
}

function rdEntryWithReuse(r: RdRule, plan: ReusePlan, ids: LexIdPlan, ar: ArenaIdPlan): string {
  return plan.kind === 'A' ? rdEntryWithReuseA(r, plan, ar) : rdEntryWithReuseB(r, plan, ids, ar);
}

function prattRule(r: PrattRule, tpl: TplCfg | null, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const tplNud = tpl && r.nudToks.includes(tpl.token)
    ? `\tif t.Kid == ${kidOf(ids, '$templateHead')} {
\t\tnode := matchTemplate()
\t\tif node < 0 { return -1 }
\t\tsb := len(scratch); scratch = append(scratch, node)
\t\treturn finish(${ruleIdOf(ar, r.cstName)}, sb, int(nodes[node].Offset), int(nodes[node].TokStart))
\t}\n`
    : '';
  const bin = r.binary.map((b) => `${lidOf(ids, b.op)}: {${b.lbp}, ${b.rbp}}`).join(', ');
  const pre = r.prefix.map((p) => `${lidOf(ids, p.op)}: ${p.rbp}`).join(', ');
  const atoms = r.nudToks.map((k) => `${kidOf(ids, k)}: true`).join(', ');
  const bracketNudBody = (b: Bracket) => `{
\t\tsave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\t\tif ${b.steps.map((x) => stepCond(x, ids, ar)).join(' && ')} { return finish(${ruleIdOf(ar, r.cstName)}, sb, int(t.Off), save) }
\t\tpos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]
\t}`;
  const bracketNudSwitch = (() => {
    if (r.nudBrackets.length === 0) return '';
    const groups = groupByPreserveOrder(r.nudBrackets, (b) => lidOf(ids, b.first));
    return `\tswitch t.Lid {
${groups.map((g) => `\tcase ${g.key}:
${g.members.map(({ item: b }) => `\t\t${bracketNudBody(b)}`).join('\n')}`).join('\n')}
\t}`;
  })();
  const ledGuard = (accessTail: boolean, lbp: number | null, sameLine: boolean, nll: string[] | null, lid: number) => {
    const parts: string[] = [];
    if (accessTail) parts.push('!tailClosed');
    if (lbp !== null) parts.push(`${lbp} > minBp`);
    if (sameLine) parts.push('!t.Nl');
    if (nll) parts.push(`!_inW([]string{${nll.map(J).join(', ')}}, headLeafText(left))`);
    parts.push(`!_suppressCur[${lid}]`);
    return parts.join(' && ');
  };
  const ledBody = (b: Bracket) => `{
\t\t\tledSave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\t\t\tscratch = append(scratch, left)
\t\t\tif ${b.steps.map((x) => stepCond(x, ids, ar)).join(' && ')} { left = finish(${ruleIdOf(ar, r.cstName)}, sb, int(nodes[left].Offset), int(nodes[left].TokStart)); continue LedLoop }
\t\t\tpos = ledSave; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; break LedLoop
\t\t}`;
  const ledSwitch = (() => {
    if (r.leds.length === 0) return '';
    const groups = groupByPreserveOrder(r.leds, (b) => lidOf(ids, b.first));
    return `\t\tswitch t.Lid {
${groups.map((g) => {
  const lid = g.key as number;
  const arms = g.members.map(({ item: b, index: i }) =>
    `\t\t\tif ${ledGuard(r.ledAccessTail[i]!, r.ledLbp[i]!, r.ledSameLine[i]!, r.ledNotLeftLeaf[i]!, lid)} ${ledBody(b)}`);
  return `\t\tcase ${lid}:\n${arms.join('\n')}`;
}).join('\n')}
\t\t}`;
  })();
  const postfixTokSwitch = (() => {
    if (r.postfixToks.length === 0) return '';
    const groups = groupByPreserveOrder(r.postfixToks, (tok) => kidOf(ids, tok));
    const hasTpl = !!(tpl && r.postfixToks.includes(tpl.token));
    const tplPart = hasTpl ? `
\t\tif !tailClosed && t.Kid == ${kidOf(ids, '$templateHead')} {
\t\t\tnode := matchTemplate()
\t\t\tif node >= 0 { sb := len(scratch); scratch = append(scratch, left, node); left = finish(${ruleIdOf(ar, r.cstName)}, sb, int(nodes[left].Offset), int(nodes[left].TokStart)); continue LedLoop }
\t\t}` : '';
    return `\t\tswitch t.Kid {
${groups.map((g) => `\t\tcase ${g.key}:
\t\t\tif !tailClosed {
\t\t\t\tsb := len(scratch); scratch = append(scratch, left); pushLeaf(uint8(t.Kid), uint32(pos)); pos++
\t\t\t\tleft = finish(${ruleIdOf(ar, r.cstName)}, sb, int(nodes[left].Offset), int(nodes[left].TokStart)); continue LedLoop
\t\t\t}`).join('\n')}
\t\t}${tplPart}`;
  })();
  const post = r.postfix.map((p) => `${lidOf(ids, p.op)}: ${p.lbp}`).join(', ');
  return `var ${r.name}BIN = map[uint16]bp{${bin}}
var ${r.name}PRE = map[uint16]int{${pre}}
var ${r.name}POST = map[uint16]int{${post}}
var ${r.name}ATOM = map[uint16]bool{${atoms}}
func parse${r.name}() int32 {
\tprev := _suppressCur
\t_suppressCur = _suppressNext
\t_suppressNext = nil
\tr := ${r.name}bp(0)
\t_suppressCur = prev
\treturn r
}
func ${r.name}bp(minBp int) int32 {
\tleft := ${r.name}nud(minBp)
\tif left < 0 { return -1 }
\tif _capped { return left }
\ttailClosed := false
${(r.leds.length > 0 || r.postfixToks.length > 0) ? 'LedLoop:\n' : ''}\tfor {
\t\tt := peek()
\t\tif t == nil { break }
${ledSwitch}
${postfixTokSwitch}
\t\tif post, ok := ${r.name}POST[t.Lid]; ok && !tailClosed && post > minBp {
\t\t\tsb := len(scratch); scratch = append(scratch, left); pushLeaf(${ttIdOf(ar, '$operator')}, uint32(pos)); pos++; tailClosed = true
\t\t\tleft = finish(${ruleIdOf(ar, r.cstName)}, sb, int(nodes[left].Offset), int(nodes[left].TokStart)); continue
\t\t}
\t\tinfo, ok := ${r.name}BIN[t.Lid]
\t\tif !ok || info.lbp <= minBp { break }
\t\tledSave := pos; sb := len(scratch)
\t\tscratch = append(scratch, left); pushLeaf(${ttIdOf(ar, '$operator')}, uint32(pos))
\t\tpos++
\t\trhs := ${r.name}bp(info.rbp)
\t\tif rhs < 0 { pos = ledSave; scratch = scratch[:sb]; break }
\t\tscratch = append(scratch, rhs)
\t\tleft = finish(${ruleIdOf(ar, r.cstName)}, sb, int(nodes[left].Offset), int(nodes[left].TokStart))
\t}
\treturn left
}
func ${r.name}nud(minBp int) int32 {
\t_capped = false
\tt := peek()
\tif t == nil { return -1 }
${r.nudCapped.map((c) => `\tif minBp < ${c.capBp} { save := pos; sb := len(scratch); nb := len(nodes); kb := len(kids); if ${c.steps.length ? c.steps.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'} { _capped = true; return finish(${ruleIdOf(ar, r.cstName)}, sb, offAt(save), save) }; pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb] }`).join('\n')}
\t_r := func() int32 {   // non-capped: a sub-parse may leave _capped set; force it false after
${tplNud}\tif ${r.name}ATOM[t.Kid] {
\t\tsb := len(scratch); ts := pos; pushLeaf(uint8(t.Kid), uint32(pos)); pos++
\t\treturn finish(${ruleIdOf(ar, r.cstName)}, sb, int(t.Off), ts)
\t}
${bracketNudSwitch}
\tif pbp, ok := ${r.name}PRE[t.Lid]; ok {
\t\tsave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\t\tpushLeaf(${ttIdOf(ar, '$operator')}, uint32(pos)); pos++
\t\toperand := ${r.name}bp(pbp)
\t\tif operand < 0 { pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; return -1 }
\t\tscratch = append(scratch, operand)
\t\treturn finish(${ruleIdOf(ar, r.cstName)}, sb, int(t.Off), save)
\t}
${r.nudSeqs.map((seq) => `\t{ save := pos; sb := len(scratch); nb := len(nodes); kb := len(kids); if ${seq.length ? seq.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'} { return finish(${ruleIdOf(ar, r.cstName)}, sb, offAt(save), save) }; pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb] }`).join('\n')}
\treturn -1
\t}()
\t_capped = false
\treturn _r
}`;
}

function docEditBlockGo(ir: ParserIR): string {
  const windowLex = (!ir.regexCtx && !ir.tpl) || !ir.newlineCfg;
  const hasNewline = !!(ir.newlineCfg && !ir.regexCtx && !ir.tpl);
  const rxOnly = !!(ir.regexCtx && !ir.tpl && !ir.newlineCfg);
  const tplOnly = !!(ir.tpl && !ir.regexCtx && !ir.newlineCfg);
  const rxTpl = !!(ir.regexCtx && ir.tpl && !ir.newlineCfg);
  const topReuse = topReusePlan(ir);
  const shapeA = topReuse?.kind === 'A';
  const shapeB = topReuse?.kind === 'B';
  const hasHeadB = !!(shapeB && topReuse.kind === 'B' && topReuse.hasHead);
  const adoptSuffix = `\t\t\t\tfor j := oIdx + 1; j < len(oldToks); j++ {
\t\t\t\t\tout = append(out, shiftAlign(oldToks[j], delta))
\t\t\t\t}`;
  const findTokAtOff = `
func findTokAtOff(toks []alignMeta, off int) int {
\tlo, hi := 0, len(toks)-1
\tfor lo <= hi {
\t\tmid := (lo + hi) >> 1
\t\tif int(toks[mid].Off) < off { lo = mid + 1 } else if int(toks[mid].Off) > off { hi = mid - 1 } else { return mid }
\t}
\treturn -1
}`;
  const reconstructParens = `
func reconstructParens(toks []alignMeta, text string, b int) []bool {
\tneed := 0
\tif b >= 0 { need = int(toks[b].Pd) }
\tout := make([]bool, 0, need)
\tfor i := b; i >= 0 && need > 0; i-- {
\t\tt := toks[i]
\t\tif amText(text, t) == "(" && int(t.Pd) == need {
\t\t\tout = append([]bool{amHd(t)}, out...)
\t\t\tneed--
\t\t}
\t}
\treturn out
}
func parenStacksEq(a, b []bool) bool {
\tif len(a) != len(b) { return false }
\tfor i := range a { if a[i] != b[i] { return false } }
\treturn true
}`;
  const tplAnchor = `\tmaxIdx := -1
\tfor i := 0; i < len(oldToks); i++ {
\t\tif int(oldToks[i].End) < start { maxIdx = i } else { break }
\t}
\trb0 := -1
\tif maxIdx >= 0 { rb0 = maxIdx - 1 }
\trb := -1
\tif rb0 >= 0 {
\t\tfor i := rb0; i < len(oldToks); i++ {
\t\t\tif int(oldToks[i].End) > start { break }
\t\t\tif oldToks[i].Td == 0 { rb = i; break }
\t\t}
\t}
\tvar out []alignMeta
\tif rb >= 0 { out = append(out, oldToks[:rb+1]...) }`;
  const windowHelpers = windowLex ? (hasNewline ? `
func findTokAtOffKind(toks []alignMeta, off int, kid uint16) int {
\tlo, hi := 0, len(toks)-1
\thit := -1
\tfor lo <= hi {
\t\tmid := (lo + hi) >> 1
\t\tif int(toks[mid].Off) < off { lo = mid + 1 } else if int(toks[mid].Off) > off { hi = mid - 1 } else { hit = mid; break }
\t}
\tif hit < 0 { return -1 }
\tstart := hit
\tfor start > 0 && int(toks[start-1].Off) == off { start-- }
\tfor i := start; i < len(toks) && int(toks[i].Off) == off; i++ {
\t\tif toks[i].Kid == kid { return i }
\t}
\treturn -1
}
func windowRelexStep(oldText string, oldToks []alignMeta, newText string, start, end int, ins string) ([]alignMeta, int) {
\tdelta := len(ins) - (end - start)
\teditEnd := start + len(ins)
\tmaxIdx := -1
\tfor i := 0; i < len(oldToks); i++ {
\t\tif int(oldToks[i].End) < start { maxIdx = i } else { break }
\t}
\trb := -1
\tif maxIdx >= 0 { rb = maxIdx - 1 }
\tvar out []alignMeta
\tif rb >= 0 { out = append(out, oldToks[:rb+1]...) }
\tvar scanOff int
\tvar pendingNl, lineStart, emittedContent bool
\tvar flowDepth int
\tif rb >= 0 {
\t\tscanOff = int(oldToks[rb].End); pendingNl = false; lineStart = false; emittedContent = true; flowDepth = int(oldToks[rb].Fd)
\t} else {
\t\tscanOff = 0; pendingNl = false; lineStart = true; emittedContent = false; flowDepth = 0
\t}
\tvar scratch []Tok
\trelexed := 0
\tfor scanOff < len(newText) {
\t\tbefore := len(scratch)
\t\tscanOff, pendingNl, lineStart, emittedContent, flowDepth = lexFrom(newText, scanOff, pendingNl, lineStart, emittedContent, flowDepth, &scratch, 1)
\t\tif len(scratch) == before { break }
\t\tt := scratch[len(scratch)-1]
\t\tout = append(out, mkAlign(int32(t.Off), int32(t.End), t.Kid, t.Nl, uint16(flowDepth), 0, false, false, false, 0))
\t\trelexed++
\t\tif int(t.Off) >= editEnd {
\t\t\toIdx := findTokAtOffKind(oldToks, int(t.Off)-delta, t.Kid)
\t\t\tif oIdx >= 0 {
\t\t\t\to := oldToks[oIdx]
\t\t\t\tif o.Kid == t.Kid && int(o.End) == int(t.End)-delta && amNl(o) == t.Nl && int(o.Fd) == flowDepth && amText(oldText, o) == newText[t.Off:t.End] {
${adoptSuffix}
\t\t\t\t\treturn out, relexed
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\treturn out, relexed
}
` : rxOnly ? `${findTokAtOff}${reconstructParens}
func windowRelexStep(oldText string, oldToks []alignMeta, newText string, start, end int, ins string) ([]alignMeta, int) {
\tdelta := len(ins) - (end - start)
\teditEnd := start + len(ins)
\tmaxIdx := -1
\tfor i := 0; i < len(oldToks); i++ {
\t\tif int(oldToks[i].End) < start { maxIdx = i } else { break }
\t}
\trb := -1
\tif maxIdx >= 0 { rb = maxIdx - 1 }
\tvar out []alignMeta
\tif rb >= 0 { out = append(out, oldToks[:rb+1]...) }
\tvar scanOff int
\tpendingNl := false
\tprevLid, prevKid, bpLid := uint16(0), uint16(0), uint16(0)
\thasPrev, hasPrev2 := false, false
\tvar parenHead []bool
\tlastClose, lastBang := false, false
\tif rb >= 0 {
\t\tanchor := oldToks[rb]
\t\tscanOff = int(anchor.End)
\t\tprevLid = lidOf(amText(oldText, anchor))
\t\tprevKid = anchor.Kid
\t\thasPrev = true
\t\tif rb >= 1 {
\t\t\tbpLid = lidOf(amText(oldText, oldToks[rb-1]))
\t\t\thasPrev2 = true
\t\t}
\t\tlastClose = amLc(anchor)
\t\tlastBang = amLb(anchor)
\t\tparenHead = reconstructParens(oldToks, oldText, rb)
\t}
\tvar scratch []Tok
\trelexed := 0
\tfor scanOff < len(newText) {
\t\tbefore := len(scratch)
\t\tscanOff, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang = lexFrom(newText, scanOff, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang, &scratch, 1)
\t\tif len(scratch) == before { break }
\t\tt := scratch[len(scratch)-1]
\t\thd := false
\t\tif t.Lid == LID_LPAREN && len(parenHead) > 0 { hd = parenHead[len(parenHead)-1] }
\t\tout = append(out, mkAlign(int32(t.Off), int32(t.End), t.Kid, t.Nl, 0, uint16(len(parenHead)), lastClose, lastBang, hd, 0))
\t\trelexed++
\t\tif int(t.Off) >= editEnd {
\t\t\toIdx := findTokAtOff(oldToks, int(t.Off)-delta)
\t\t\tif oIdx >= 0 {
\t\t\t\to := oldToks[oIdx]
\t\t\t\tnewPrevText := ""
\t\t\t\tif len(out) > 1 { newPrevText = amText(newText, out[len(out)-2]) }
\t\t\t\toldPrevText := ""
\t\t\t\tif oIdx >= 1 { oldPrevText = amText(oldText, oldToks[oIdx-1]) }
\t\t\t\toldStack := reconstructParens(oldToks, oldText, oIdx)
\t\t\t\tif int(o.Pd) == len(parenHead) && parenStacksEq(oldStack, parenHead) && amLc(o) == lastClose && amLb(o) == lastBang && newPrevText == oldPrevText && o.Kid == t.Kid && int(o.End) == int(t.End)-delta && amNl(o) == t.Nl && amText(oldText, o) == newText[t.Off:t.End] {
${adoptSuffix}
\t\t\t\t\treturn out, relexed
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\treturn out, relexed
}
` : rxTpl ? `${findTokAtOff}${reconstructParens}
func windowRelexStep(oldText string, oldToks []alignMeta, newText string, start, end int, ins string) ([]alignMeta, int) {
\tdelta := len(ins) - (end - start)
\teditEnd := start + len(ins)
${tplAnchor}
\tvar scanOff int
\tpendingNl := false
\tprevLid, prevKid, bpLid := uint16(0), uint16(0), uint16(0)
\thasPrev, hasPrev2 := false, false
\tvar parenHead []bool
\tlastClose, lastBang := false, false
\tvar templateStack []int
\tif rb >= 0 {
\t\tanchor := oldToks[rb]
\t\tscanOff = int(anchor.End)
\t\tprevLid = lidOf(amText(oldText, anchor))
\t\tprevKid = anchor.Kid
\t\thasPrev = true
\t\tif rb >= 1 {
\t\t\tbpLid = lidOf(amText(oldText, oldToks[rb-1]))
\t\t\thasPrev2 = true
\t\t}
\t\tlastClose = amLc(anchor)
\t\tlastBang = amLb(anchor)
\t\tparenHead = reconstructParens(oldToks, oldText, rb)
\t}
\tvar scratch []Tok
\trelexed := 0
\tfor scanOff < len(newText) {
\t\tbefore := len(scratch)
\t\tscanOff, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang, templateStack = lexFrom(newText, scanOff, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang, templateStack, &scratch, 1)
\t\tif len(scratch) == before { break }
\t\tt := scratch[len(scratch)-1]
\t\thd := false
\t\tif t.Lid == LID_LPAREN && len(parenHead) > 0 { hd = parenHead[len(parenHead)-1] }
\t\tout = append(out, mkAlign(int32(t.Off), int32(t.End), t.Kid, t.Nl, 0, uint16(len(parenHead)), lastClose, lastBang, hd, uint8(len(templateStack))))
\t\trelexed++
\t\tif int(t.Off) >= editEnd {
\t\t\toIdx := findTokAtOff(oldToks, int(t.Off)-delta)
\t\t\tif oIdx >= 0 {
\t\t\t\to := oldToks[oIdx]
\t\t\t\tnewPrevText := ""
\t\t\t\tif len(out) > 1 { newPrevText = amText(newText, out[len(out)-2]) }
\t\t\t\toldPrevText := ""
\t\t\t\tif oIdx >= 1 { oldPrevText = amText(oldText, oldToks[oIdx-1]) }
\t\t\t\toldStack := reconstructParens(oldToks, oldText, oIdx)
\t\t\t\tif o.Td == 0 && len(templateStack) == 0 && int(o.Pd) == len(parenHead) && parenStacksEq(oldStack, parenHead) && amLc(o) == lastClose && amLb(o) == lastBang && newPrevText == oldPrevText && o.Kid == t.Kid && int(o.End) == int(t.End)-delta && amNl(o) == t.Nl && amText(oldText, o) == newText[t.Off:t.End] {
${adoptSuffix}
\t\t\t\t\treturn out, relexed
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\treturn out, relexed
}
` : tplOnly ? `${findTokAtOff}
func windowRelexStep(oldText string, oldToks []alignMeta, newText string, start, end int, ins string) ([]alignMeta, int) {
\tdelta := len(ins) - (end - start)
\teditEnd := start + len(ins)
${tplAnchor}
\tscanOff := 0
\tif rb >= 0 { scanOff = int(oldToks[rb].End) }
\tpendingNl := false
\tvar templateStack []int
\tvar scratch []Tok
\trelexed := 0
\tfor scanOff < len(newText) {
\t\tbefore := len(scratch)
\t\tscanOff, pendingNl, templateStack = lexFrom(newText, scanOff, pendingNl, templateStack, &scratch, 1)
\t\tif len(scratch) == before { break }
\t\tt := scratch[len(scratch)-1]
\t\tout = append(out, mkAlign(int32(t.Off), int32(t.End), t.Kid, t.Nl, 0, 0, false, false, false, uint8(len(templateStack))))
\t\trelexed++
\t\tif int(t.Off) >= editEnd {
\t\t\toIdx := findTokAtOff(oldToks, int(t.Off)-delta)
\t\t\tif oIdx >= 0 {
\t\t\t\to := oldToks[oIdx]
\t\t\t\tif o.Td == 0 && len(templateStack) == 0 && o.Kid == t.Kid && int(o.End) == int(t.End)-delta && amNl(o) == t.Nl && amText(oldText, o) == newText[t.Off:t.End] {
${adoptSuffix}
\t\t\t\t\treturn out, relexed
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\treturn out, relexed
}
` : `${findTokAtOff}
func windowRelexStep(oldText string, oldToks []alignMeta, newText string, start, end int, ins string) ([]alignMeta, int) {
\tdelta := len(ins) - (end - start)
\teditEnd := start + len(ins)
\tmaxIdx := -1
\tfor i := 0; i < len(oldToks); i++ {
\t\tif int(oldToks[i].End) < start { maxIdx = i } else { break }
\t}
\trb := -1
\tif maxIdx >= 0 { rb = maxIdx - 1 }
\tvar out []alignMeta
\tif rb >= 0 { out = append(out, oldToks[:rb+1]...) }
\tscanOff := 0
\tif rb >= 0 { scanOff = int(oldToks[rb].End) }
\tpendingNl := false
\tvar scratch []Tok
\trelexed := 0
\tfor scanOff < len(newText) {
\t\tbefore := len(scratch)
\t\tscanOff, pendingNl = lexFrom(newText, scanOff, pendingNl, &scratch, 1)
\t\tif len(scratch) == before { break }
\t\tt := scratch[len(scratch)-1]
\t\tout = append(out, mkAlign(int32(t.Off), int32(t.End), t.Kid, t.Nl, 0, 0, false, false, false, 0))
\t\trelexed++
\t\tif int(t.Off) >= editEnd {
\t\t\toIdx := findTokAtOff(oldToks, int(t.Off)-delta)
\t\t\tif oIdx >= 0 {
\t\t\t\to := oldToks[oIdx]
\t\t\t\tif o.Kid == t.Kid && int(o.End) == int(t.End)-delta && amNl(o) == t.Nl && amText(oldText, o) == newText[t.Off:t.End] {
${adoptSuffix}
\t\t\t\t\treturn out, relexed
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\treturn out, relexed
}
`) : '';
  const editBody = windowLex
    ? `\tcurText := d.text
\tcurToks := d.toks
\tfor _, e := range edits {
\t\tstepOldText, stepOldToks := curText, curToks
\t\tn := len(curText)
\t\tstart, end := e.Start, e.End
\t\tif start < 0 { start = 0 }
\t\tif start > n { start = n }
\t\tif end < start { end = start }
\t\tif end > n { end = n }
\t\tins := e.Text
\t\tcurText = curText[:start] + ins + curText[end:]
\t\tvar stepRelexed int
\t\tcurToks, stepRelexed = windowRelexStep(stepOldText, stepOldToks, curText, start, end, ins)
\t\trelexed += stepRelexed
\t}
\td.text = curText
\td.toks = curToks`
    : `\tfor _, e := range edits { d.text = applyEdit(d.text, e) }
\tnewToks := tokenize(d.text)
\td.toks = toMeta(newToks)
\trelexed = len(d.toks)`;
  const toMetaFn = hasNewline ? `
func scanMeta(src string) []alignMeta {
\tvar toks []Tok
\tvar meta []alignMeta
\tpos := 0
\tpendingNl, lineStart, emittedContent := false, true, false
\tflowDepth := 0
\tfor pos < len(src) {
\t\tbefore := len(toks)
\t\tpos, pendingNl, lineStart, emittedContent, flowDepth = lexFrom(src, pos, pendingNl, lineStart, emittedContent, flowDepth, &toks, 1)
\t\tif len(toks) == before { break }
\t\tt := toks[len(toks)-1]
\t\tmeta = append(meta, mkAlign(int32(t.Off), int32(t.End), t.Kid, t.Nl, uint16(flowDepth), 0, false, false, false, 0))
\t}
\treturn meta
}
func toMeta(_ []Tok) []alignMeta { panic("use scanMeta for newline") }
` : rxOnly ? `
func scanMeta(src string) []alignMeta {
\tvar toks []Tok
\tvar meta []alignMeta
\tpos := 0
\tpendingNl := false
\tprevLid, prevKid, bpLid := uint16(0), uint16(0), uint16(0)
\thasPrev, hasPrev2 := false, false
\tvar parenHead []bool
\tlastClose, lastBang := false, false
\tfor pos < len(src) {
\t\tbefore := len(toks)
\t\tpos, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang = lexFrom(src, pos, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang, &toks, 1)
\t\tif len(toks) == before { break }
\t\tt := toks[len(toks)-1]
\t\thd := false
\t\tif t.Lid == LID_LPAREN && len(parenHead) > 0 { hd = parenHead[len(parenHead)-1] }
\t\tmeta = append(meta, mkAlign(int32(t.Off), int32(t.End), t.Kid, t.Nl, 0, uint16(len(parenHead)), lastClose, lastBang, hd, 0))
\t}
\treturn meta
}
func toMeta(_ []Tok) []alignMeta { panic("use scanMeta for regex") }
` : rxTpl ? `
func scanMeta(src string) []alignMeta {
\tvar toks []Tok
\tvar meta []alignMeta
\tpos := 0
\tpendingNl := false
\tprevLid, prevKid, bpLid := uint16(0), uint16(0), uint16(0)
\thasPrev, hasPrev2 := false, false
\tvar parenHead []bool
\tlastClose, lastBang := false, false
\tvar templateStack []int
\tfor pos < len(src) {
\t\tbefore := len(toks)
\t\tpos, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang, templateStack = lexFrom(src, pos, pendingNl, prevLid, prevKid, bpLid, hasPrev, hasPrev2, parenHead, lastClose, lastBang, templateStack, &toks, 1)
\t\tif len(toks) == before { break }
\t\tt := toks[len(toks)-1]
\t\thd := false
\t\tif t.Lid == LID_LPAREN && len(parenHead) > 0 { hd = parenHead[len(parenHead)-1] }
\t\tmeta = append(meta, mkAlign(int32(t.Off), int32(t.End), t.Kid, t.Nl, 0, uint16(len(parenHead)), lastClose, lastBang, hd, uint8(len(templateStack))))
\t}
\treturn meta
}
func toMeta(_ []Tok) []alignMeta { panic("use scanMeta for rx+tpl") }
` : tplOnly ? `
func scanMeta(src string) []alignMeta {
\tvar toks []Tok
\tvar meta []alignMeta
\tpos := 0
\tpendingNl := false
\tvar templateStack []int
\tfor pos < len(src) {
\t\tbefore := len(toks)
\t\tpos, pendingNl, templateStack = lexFrom(src, pos, pendingNl, templateStack, &toks, 1)
\t\tif len(toks) == before { break }
\t\tt := toks[len(toks)-1]
\t\tmeta = append(meta, mkAlign(int32(t.Off), int32(t.End), t.Kid, t.Nl, 0, 0, false, false, false, uint8(len(templateStack))))
\t}
\treturn meta
}
func toMeta(_ []Tok) []alignMeta { panic("use scanMeta for tpl") }
` : `
func toMeta(toks []Tok) []alignMeta {
\tout := make([]alignMeta, len(toks))
\tfor i, t := range toks { out[i] = mkAlign(int32(t.Off), int32(t.End), t.Kid, t.Nl, 0, 0, false, false, false, 0) }
\treturn out
}`;
  // Packed AlignMeta: full-field equality covers prior mode-specific checks
  // (unused state fields are always zeroed by scanMeta / toMeta / windowRelex).
  const checkStreamEqFn = (hasNewline || rxOnly || rxTpl || tplOnly) ? `
func checkStreamEq(text string, meta []alignMeta) bool {
\tfresh := scanMeta(text)
\tif len(fresh) != len(meta) { return false }
\tfor i := range fresh {
\t\tif fresh[i] != meta[i] { return false }
\t\tif amText(text, fresh[i]) != amText(text, meta[i]) { return false }
\t}
\treturn true
}
` : `
func checkStreamEq(text string, meta []alignMeta) bool {
\tfresh := toMeta(tokenize(text))
\tif len(fresh) != len(meta) { return false }
\tfor i := range fresh {
\t\tif fresh[i] != meta[i] { return false }
\t\tif amText(text, fresh[i]) != amText(text, meta[i]) { return false }
\t}
\treturn true
}
`;
  const initToks = (hasNewline || rxOnly || tplOnly || rxTpl) ? 'scanMeta(src)' : 'toMeta(tokenize(src))';
  const freshMeta = (hasNewline || rxOnly || tplOnly || rxTpl) ? 'scanMeta(d.text)' : 'toMeta(tokenize(d.text))';
  const parseFreshRetry = `\td.root = parse(toksFromMeta(d.text, d.toks))
\tif d.root < 0 { d.toks = ${freshMeta}; d.root = parse(toksFromMeta(d.text, d.toks)) }`;
  const reuseFns = topReuse ? `
func countLive(id int32) int {
	if id < 0 { return 0 }
	n := 1
	nd := &nodes[id]
	for i := uint32(0); i < nd.KidCount; i++ {
		cid := kids[nd.KidStart+i]
		if cid >= 0 { n += countLive(cid) }
	}
	return n
}
func shouldReclaim(root int32) bool {
	if root < 0 || arenaBaseline == 0 { return false }
	live := countLive(root)
	lim := arenaBaseline
	if live > lim { lim = live }
	return len(nodes) > arenaCompactK*lim
}
func shiftSubtree(id int32, byteDelta, tokDelta int) {
	if id < 0 { panic("shiftSubtree on leaf") }
	nd := &nodes[id]
	nd.Offset = uint32(int32(nd.Offset) + int32(byteDelta))
	nd.End = uint32(int32(nd.End) + int32(byteDelta))
	nd.TokStart = uint32(int32(nd.TokStart) + int32(tokDelta))
	nd.TokEnd = uint32(int32(nd.TokEnd) + int32(tokDelta))
	nd.Ext = uint32(int32(nd.Ext) + int32(tokDelta))
	for i := uint32(0); i < nd.KidCount; i++ {
		slot := nd.KidStart + i
		cid := kids[slot]
		if cid < 0 {
			ti, tt := decodeLeaf(cid)
			kids[slot] = encodeLeaf(uint32(int32(ti)+int32(tokDelta)), tt)
		} else {
			shiftSubtree(cid, byteDelta, tokDelta)
		}
	}
}
func shiftEntryMeta(m *EntryMeta, byteDelta, tokDelta int) {
	m.TokStart += tokDelta
	m.TokEnd += tokDelta
	m.Ext += tokDelta
	m.Off += byteDelta
	m.End += byteDelta
}
${shapeA ? `func assertEntriesVsNodes(oldEntries []EntryMeta, oldRoot int32) {
	old := nodes[oldRoot]
	if len(oldEntries) != int(old.KidCount) {
		panic("entry count vs root kids: " + fmt.Sprintf("%d", len(oldEntries)) + " vs " + fmt.Sprintf("%d", int(old.KidCount)))
	}
	for i, e := range oldEntries {
		nd := nodes[kids[old.KidStart+uint32(i)]]
		if e.TokStart != int(nd.TokStart) { panic("tok_start entry " + fmt.Sprintf("%d", i)) }
		if e.TokEnd != int(nd.TokEnd) { panic("tok_end entry " + fmt.Sprintf("%d", i)) }
		if e.Ext != int(nd.Ext) { panic("ext entry " + fmt.Sprintf("%d", i)) }
		if e.Off != int(nd.Offset) { panic("off entry " + fmt.Sprintf("%d", i)) }
		if e.End != int(nd.End) { panic("end entry " + fmt.Sprintf("%d", i)) }
	}
}
func tryReuseTop(oldRoot int32, oldEntries []EntryMeta, newText string, newMeta []alignMeta, byteDelta, oldN, newN, prefix, suffix int, validate bool) (int32, int) {
	if oldRoot < 0 { return -1, 0 }
	if validate { assertEntriesVsNodes(oldEntries, oldRoot) }
	old := nodes[oldRoot]
	oldKids := make([]int32, old.KidCount)
	for i := uint32(0); i < old.KidCount; i++ { oldKids[i] = kids[old.KidStart+i] }
	prefixLen := 0
	for prefixLen < len(oldEntries) {
		if oldEntries[prefixLen].Ext <= prefix { prefixLen++ } else { break }
	}
	suffixStart := len(oldEntries)
	for i := len(oldEntries) - 1; i >= prefixLen; i-- {
		if oldEntries[i].TokStart >= oldN-suffix { suffixStart = i } else { break }
	}
	prefixKids := oldKids[:prefixLen]
	suffixCand := oldKids[suffixStart:]
	prefixMeta := append([]EntryMeta(nil), oldEntries[:prefixLen]...)
	suffixMeta := append([]EntryMeta(nil), oldEntries[suffixStart:]...)
	tokDelta := newN - oldN
	_src = newText
	toks = toksFromMeta(newText, newMeta)
	if prefixLen > 0 { pos = prefixMeta[prefixLen-1].TokEnd } else { pos = 0 }
	scratch = scratch[:0]
	mid := make([]int32, 0)
	midMeta := make([]EntryMeta, 0)
	suffixBound := newN - suffix
	maxCand := -1
	for _, m := range suffixMeta {
		c := m.TokStart + tokDelta
		if c > maxCand { maxCand = c }
	}
	finishHit := func(adoptFrom int) (int32, int) {
		adopted := suffixCand[adoptFrom:]
		for _, s := range adopted { shiftSubtree(s, byteDelta, tokDelta) }
		children := make([]int32, 0, len(prefixKids)+len(mid)+len(adopted))
		children = append(children, prefixKids...)
		children = append(children, mid...)
		children = append(children, adopted...)
		adoptedMeta := append([]EntryMeta(nil), suffixMeta[adoptFrom:]...)
		newEntries := make([]EntryMeta, 0, len(prefixMeta)+len(midMeta)+len(adoptedMeta))
		newEntries = append(newEntries, prefixMeta...)
		newEntries = append(newEntries, midMeta...)
		for i := range adoptedMeta {
			shiftEntryMeta(&adoptedMeta[i], byteDelta, tokDelta)
			newEntries = append(newEntries, adoptedMeta[i])
		}
		off, end, tokStart, tokEnd := 0, 0, 0, 0
		if len(newEntries) > 0 {
			off = newEntries[0].Off
			end = newEntries[len(newEntries)-1].End
			tokStart = newEntries[0].TokStart
			tokEnd = newEntries[len(newEntries)-1].TokEnd
		}
		kidStart := len(kids)
		kids = append(kids, children...)
		nodes = append(nodes, Node{RuleId: old.RuleId, KidStart: uint32(kidStart), KidCount: uint32(len(children)), Offset: uint32(off), End: uint32(end), TokStart: uint32(tokStart), TokEnd: uint32(tokEnd)})
		entries = newEntries
		pos = newN
		return int32(len(nodes) - 1), len(prefixKids) + len(adopted)
	}
	tryHit := func() (int32, int, bool) {
		if pos < suffixBound { return -1, 0, false }
		if len(suffixCand) == 0 {
			if pos == newN { r, n := finishHit(0); return r, n, true }
			return -1, 0, false
		}
		for i, m := range suffixMeta {
			if m.TokStart+tokDelta == pos { r, n := finishHit(i); return r, n, true }
		}
		return -1, 0, false
	}
	if r, n, ok := tryHit(); ok { return r, n }
	if len(suffixCand) > 0 && maxCand >= 0 && pos > maxCand { return -1, 0 }
	for {
		if pos >= len(toks) {
			if len(suffixCand) == 0 && pos == newN { return finishHit(0) }
			if r, n, ok := tryHit(); ok { return r, n }
			return -1, 0
		}
		maxLook = 0
		sp := pos
		n := parseTopOne()
		if n < 0 { pos = sp; return -1, 0 }
		ext := nodes[n].TokEnd
		if uint32(maxLook) > ext { ext = uint32(maxLook) }
		nodes[n].Ext = ext
		midMeta = append(midMeta, EntryMeta{int(nodes[n].TokStart), int(nodes[n].TokEnd), int(ext), int(nodes[n].Offset), int(nodes[n].End), 0, 1})
		mid = append(mid, n)
		if r, rn, ok := tryHit(); ok { return r, rn }
		if len(suffixCand) > 0 && maxCand >= 0 && pos > maxCand { return -1, 0 }
	}
}
` : ''}${shapeB ? `func assertEntriesVsSegs(oldEntries []EntryMeta, oldSegs []Seg, oldRoot int32) {
	if len(oldEntries) != len(oldSegs) {
		panic("entry count vs segs: " + fmt.Sprintf("%d", len(oldEntries)) + " vs " + fmt.Sprintf("%d", len(oldSegs)))
	}
	old := nodes[oldRoot]
	for i, e := range oldEntries {
		s := oldSegs[i]
		if e.TokStart != s.TokStart { panic("tok_start entry " + fmt.Sprintf("%d", i)) }
		if e.TokEnd != s.TokEnd { panic("tok_end entry " + fmt.Sprintf("%d", i)) }
		if e.Ext != s.Ext { panic("ext entry " + fmt.Sprintf("%d", i)) }
		if e.KidStart != s.KidStart { panic("kid_start entry " + fmt.Sprintf("%d", i)) }
		if e.KidCount != s.KidCount { panic("kid_count entry " + fmt.Sprintf("%d", i)) }
		first := kids[old.KidStart+uint32(s.KidStart)]
		last := kids[old.KidStart+uint32(s.KidStart+s.KidCount-1)]
		if first >= 0 {
			if e.Off != int(nodes[first].Offset) { panic("off entry " + fmt.Sprintf("%d", i)) }
		}
		if last >= 0 {
			if e.End != int(nodes[last].End) { panic("end entry " + fmt.Sprintf("%d", i)) }
		}
	}
}
func tryReuseSeg(oldRoot int32, oldSegs []Seg, oldEntries []EntryMeta, newText string, newMeta []alignMeta, byteDelta, oldN, newN, prefix, suffix int, validate bool) (int32, int) {
	if oldRoot < 0 || len(oldSegs) == 0 { return -1, 0 }
	if validate { assertEntriesVsSegs(oldEntries, oldSegs, oldRoot) }
	old := nodes[oldRoot]
	prefixLen := 0
	for prefixLen < len(oldEntries) {
		if oldEntries[prefixLen].Ext <= prefix { prefixLen++ } else { break }
	}
	suffixStart := len(oldEntries)
	for i := len(oldEntries) - 1; i >= prefixLen; i-- {
		if oldEntries[i].TokStart >= oldN-suffix { suffixStart = i } else { break }
	}
	prefixSegs := oldSegs[:prefixLen]
	suffixCand := oldSegs[suffixStart:]
	prefixMeta := append([]EntryMeta(nil), oldEntries[:prefixLen]...)
	suffixMeta := append([]EntryMeta(nil), oldEntries[suffixStart:]...)
	prefixKids := make([]int32, 0)
	for _, s := range prefixSegs {
		for i := 0; i < s.KidCount; i++ { prefixKids = append(prefixKids, kids[old.KidStart+uint32(s.KidStart+i)]) }
	}
	tokDelta := newN - oldN
	_src = newText
	toks = toksFromMeta(newText, newMeta)
	if prefixLen > 0 { pos = prefixMeta[prefixLen-1].TokEnd } else { pos = 0 }
	scratch = scratch[:0]
	midKids := make([]int32, 0)
	midSegs := make([]Seg, 0)
	midMeta := make([]EntryMeta, 0)
	suffixBound := newN - suffix
	maxCand := -1
	for _, m := range suffixMeta {
		c := m.TokStart + tokDelta
		if c > maxCand { maxCand = c }
	}
	finishHit := func(adoptFrom int) (int32, int) {
		adoptedSegs := suffixCand[adoptFrom:]
		adoptedKids := make([]int32, 0)
		for _, s := range adoptedSegs {
			for i := 0; i < s.KidCount; i++ {
				id := kids[old.KidStart+uint32(s.KidStart+i)]
				if id < 0 {
					ti, tt := decodeLeaf(id)
					id = encodeLeaf(uint32(int32(ti)+int32(tokDelta)), tt)
				} else {
					shiftSubtree(id, byteDelta, tokDelta)
				}
				adoptedKids = append(adoptedKids, id)
			}
		}
		children := make([]int32, 0, len(prefixKids)+len(midKids)+len(adoptedKids))
		children = append(children, prefixKids...)
		children = append(children, midKids...)
		children = append(children, adoptedKids...)
		newSegs := make([]Seg, 0, len(prefixSegs)+len(midSegs)+len(adoptedSegs))
		newEntries := make([]EntryMeta, 0, len(prefixMeta)+len(midMeta)+len(suffixMeta)-adoptFrom)
		kOff := 0
		for i, s := range prefixSegs {
			em := prefixMeta[i]
			em.KidStart = kOff
			newSegs = append(newSegs, Seg{kOff, s.KidCount, s.TokStart, s.TokEnd, s.Ext})
			newEntries = append(newEntries, em)
			kOff += s.KidCount
		}
		for i, s := range midSegs {
			em := midMeta[i]
			em.KidStart = kOff
			newSegs = append(newSegs, Seg{kOff, s.KidCount, s.TokStart, s.TokEnd, s.Ext})
			newEntries = append(newEntries, em)
			kOff += s.KidCount
		}
		adoptedMeta := append([]EntryMeta(nil), suffixMeta[adoptFrom:]...)
		for i, s := range adoptedSegs {
			em := adoptedMeta[i]
			shiftEntryMeta(&em, byteDelta, tokDelta)
			em.KidStart = kOff
			newSegs = append(newSegs, Seg{kOff, s.KidCount, s.TokStart + tokDelta, s.TokEnd + tokDelta, s.Ext + tokDelta})
			newEntries = append(newEntries, em)
			kOff += s.KidCount
		}
		off, end, tokStart, tokEnd := 0, 0, 0, 0
		if len(newEntries) > 0 {
			off = newEntries[0].Off
			end = newEntries[len(newEntries)-1].End
			tokStart = newEntries[0].TokStart
			tokEnd = newEntries[len(newEntries)-1].TokEnd
		}
		kidStart := len(kids)
		kids = append(kids, children...)
		nodes = append(nodes, Node{RuleId: old.RuleId, KidStart: uint32(kidStart), KidCount: uint32(len(children)), Offset: uint32(off), End: uint32(end), TokStart: uint32(tokStart), TokEnd: uint32(tokEnd)})
		segs = newSegs
		entries = newEntries
		pos = newN
		return int32(len(nodes) - 1), len(prefixSegs) + len(adoptedSegs)
	}
	tryHit := func() (int32, int, bool) {
		if pos < suffixBound { return -1, 0, false }
		if len(suffixCand) == 0 {
			if pos == newN { r, n := finishHit(0); return r, n, true }
			return -1, 0, false
		}
		for i, m := range suffixMeta {
			if m.TokStart+tokDelta == pos { r, n := finishHit(i); return r, n, true }
		}
		return -1, 0, false
	}
	if r, n, ok := tryHit(); ok { return r, n }
	if len(suffixCand) > 0 && maxCand >= 0 && pos > maxCand { return -1, 0 }
	${hasHeadB ? `if prefixLen == 0 {
		sb := len(scratch)
		if h, m, ok := parseHeadSeg(sb); ok {
			h.KidStart = 0
			m.KidStart = 0
			midKids = append(midKids, scratch[sb:]...)
			scratch = scratch[:sb]
			midSegs = append(midSegs, h)
			midMeta = append(midMeta, m)
			if r, rn, ok := tryHit(); ok { return r, rn }
			if len(suffixCand) > 0 && maxCand >= 0 && pos > maxCand { return -1, 0 }
		}
	}
	` : ''}for {
		if pos >= len(toks) {
			if len(suffixCand) == 0 && pos == newN { return finishHit(0) }
			if r, n, ok := tryHit(); ok { return r, n }
			return -1, 0
		}
		sb := len(scratch)
		seg, m, ok := parseLoopSeg(sb)
		if !ok {
			if len(suffixCand) == 0 && pos == newN { return finishHit(0) }
			if r, n, hit := tryHit(); hit { return r, n }
			return -1, 0
		}
		count := len(scratch) - sb
		midKids = append(midKids, scratch[sb:]...)
		scratch = scratch[:sb]
		m.KidStart = 0
		midSegs = append(midSegs, Seg{0, count, seg.TokStart, seg.TokEnd, seg.Ext})
		midMeta = append(midMeta, m)
		if r, rn, hit := tryHit(); hit { return r, rn }
		if len(suffixCand) > 0 && maxCand >= 0 && pos > maxCand { return -1, 0 }
	}
}
` : ''}` : '';
  const editParse = shapeA
    ? `\tbyteDelta := len(d.text) - len(oldText)
\treused := 0
\tforceFresh := d.root < 0 || shouldReclaim(d.root)
\tif !forceFresh {
\t\toldEntries := append([]EntryMeta(nil), d.entries...)
\t\tif got, n := tryReuseTop(d.root, oldEntries, d.text, d.toks, byteDelta, oldN, newN, prefix, suffix, d.validate); got >= 0 {
\t\t\td.root = got
\t\t\td.entries = append([]EntryMeta(nil), entries...)
\t\t\treused = n
\t\t} else {
${parseFreshRetry}
\t\t\td.entries = append([]EntryMeta(nil), entries...)
\t\t\treused = 0
\t\t}
\t} else {
${parseFreshRetry}
\t\td.entries = append([]EntryMeta(nil), entries...)
\t\treused = 0
\t}`
    : shapeB
    ? `\tbyteDelta := len(d.text) - len(oldText)
\treused := 0
\tforceFresh := d.root < 0 || shouldReclaim(d.root)
\tif !forceFresh {
\t\toldSegs := append([]Seg(nil), segs...)
\t\toldEntries := append([]EntryMeta(nil), d.entries...)
\t\tif got, n := tryReuseSeg(d.root, oldSegs, oldEntries, d.text, d.toks, byteDelta, oldN, newN, prefix, suffix, d.validate); got >= 0 {
\t\t\td.root = got
\t\t\td.entries = append([]EntryMeta(nil), entries...)
\t\t\treused = n
\t\t} else {
${parseFreshRetry}
\t\t\td.entries = append([]EntryMeta(nil), entries...)
\t\t\treused = 0
\t\t}
\t} else {
${parseFreshRetry}
\t\td.entries = append([]EntryMeta(nil), entries...)
\t\treused = 0
\t}`
    : `\treused := 0
${parseFreshRetry}`;
  const treeEqFn = shapeB ? `
func checkTreeEq(text string, root int32) bool {
	rootOk := root >= 0 && pos == len(toks)
	var s1 string
	if rootOk {
		var b strings.Builder
		writeJSON(root, &b)
		s1 = b.String()
	}
	saveNodes := append([]Node(nil), nodes...)
	saveKids := append([]int32(nil), kids...)
	saveScratch := append([]int32(nil), scratch...)
	saveSegs := append([]Seg(nil), segs...)
	saveEntries := append([]EntryMeta(nil), entries...)
	saveBaseline := arenaBaseline
	saveToks := append([]Tok(nil), toks...)
	savePos, saveSrc, saveML := pos, _src, maxLook
	saveCap, saveSN, saveSC := _capped, _suppressNext, _suppressCur
	nodes, kids, scratch, segs, entries = nil, nil, nil, nil, nil
	_capped, _suppressNext, _suppressCur = false, nil, nil
	fresh := parse(tokenize(text))
	freshOk := fresh >= 0 && pos == len(toks)
	ok := false
	if !rootOk || !freshOk {
		ok = rootOk == freshOk
	} else {
		var b2 strings.Builder
		writeJSON(fresh, &b2)
		ok = s1 == b2.String()
	}
	nodes, kids, scratch, segs, entries = saveNodes, saveKids, saveScratch, saveSegs, saveEntries
	arenaBaseline, toks, pos, _src, maxLook = saveBaseline, saveToks, savePos, saveSrc, saveML
	_capped, _suppressNext, _suppressCur = saveCap, saveSN, saveSC
	return ok
}
` : `
func checkTreeEq(text string, root int32) bool {
	// Match TS/Rust: incomplete parse (root>=0 but pos!=len) is not a tree.
	rootOk := root >= 0 && pos == len(toks)
	var s1 string
	if rootOk {
		var b strings.Builder
		writeJSON(root, &b)
		s1 = b.String()
	}
	saveNodes := append([]Node(nil), nodes...)
	saveKids := append([]int32(nil), kids...)
	saveScratch := append([]int32(nil), scratch...)
${shapeA ? `\tsaveEntries := append([]EntryMeta(nil), entries...)
` : ''}\tsaveBaseline := arenaBaseline
	saveToks := append([]Tok(nil), toks...)
	savePos, saveSrc, saveML := pos, _src, maxLook
	saveCap, saveSN, saveSC := _capped, _suppressNext, _suppressCur
	nodes, kids, scratch = nil, nil, nil
${shapeA ? `\tentries = nil
` : ''}\t_capped, _suppressNext, _suppressCur = false, nil, nil
	fresh := parse(tokenize(text))
	freshOk := fresh >= 0 && pos == len(toks)
	ok := false
	if !rootOk || !freshOk {
		ok = rootOk == freshOk
	} else {
		var b2 strings.Builder
		writeJSON(fresh, &b2)
		ok = s1 == b2.String()
	}
	nodes, kids, scratch = saveNodes, saveKids, saveScratch
${shapeA ? `\tentries = saveEntries
` : ''}\tarenaBaseline, toks, pos, _src, maxLook = saveBaseline, saveToks, savePos, saveSrc, saveML
	_capped, _suppressNext, _suppressCur = saveCap, saveSN, saveSC
	return ok
}
`;
  return `type Edit struct { Start, End int; Text string }
// Packed Doc-state token (~16B). kind → Kid+KIND_STR; text → src[Off:End];
// Nl/Lc/Lb/Hd packed in Flags; Pd/Fd/Td are narrow depths (paren/flow/template).
type alignMeta struct { Off, End int32; Kid, Pd, Fd uint16; Flags, Td uint8 }
func amNl(m alignMeta) bool { return m.Flags&1 != 0 }
func amLc(m alignMeta) bool { return m.Flags&2 != 0 }
func amLb(m alignMeta) bool { return m.Flags&4 != 0 }
func amHd(m alignMeta) bool { return m.Flags&8 != 0 }
func amText(src string, m alignMeta) string { return src[m.Off:m.End] }
func mkAlign(off, end int32, kid uint16, nl bool, fd, pd uint16, lc, lb, hd bool, td uint8) alignMeta {
	var flags uint8
	if nl { flags |= 1 }
	if lc { flags |= 2 }
	if lb { flags |= 4 }
	if hd { flags |= 8 }
	return alignMeta{Off: off, End: end, Kid: kid, Pd: pd, Fd: fd, Flags: flags, Td: td}
}
func shiftAlign(m alignMeta, delta int) alignMeta {
	return alignMeta{Off: m.Off + int32(delta), End: m.End + int32(delta), Kid: m.Kid, Pd: m.Pd, Fd: m.Fd, Flags: m.Flags, Td: m.Td}
}
type Align struct {
	OldN     int   \`json:"oldN"\`
	NewN     int   \`json:"newN"\`
	Prefix   int   \`json:"prefix"\`
	Suffix   int   \`json:"suffix"\`
	Relexed  int   \`json:"relexed"\`
	Reused   int   \`json:"reused"\`
	StreamEq *bool \`json:"streamEq,omitempty"\`
	TreeEq   *bool \`json:"treeEq,omitempty"\`
}
${toMetaFn}
func computeAlignCore(oldText string, oldToks []alignMeta, newText string, newToks []alignMeta) (oldN, newN, prefix, suffix int) {
	oldN, newN = len(oldToks), len(newToks)
	for prefix < oldN && prefix < newN {
		o, n := oldToks[prefix], newToks[prefix]
		if o.Kid != n.Kid || o.Off != n.Off || o.End != n.End || amNl(o) != amNl(n) { break }
		if amText(oldText, o) != amText(newText, n) { break }
		prefix++
	}
	delta := len(newText) - len(oldText)
	minN := oldN; if newN < minN { minN = newN }
	for prefix+suffix < minN {
		o, n := oldToks[oldN-1-suffix], newToks[newN-1-suffix]
		if o.Kid != n.Kid || amNl(o) != amNl(n) || n.Off != o.Off+int32(delta) || n.End != o.End+int32(delta) { break }
		if amText(oldText, o) != amText(newText, n) { break }
		suffix++
	}
	return
}
func toksFromMeta(text string, meta []alignMeta) []Tok {
	t := make([]Tok, len(meta))
	for i, m := range meta {
		tx := amText(text, m)
		t[i] = mkTok(int(m.Off), int(m.End), amNl(m), m.Kid, lidOf(tx))
	}
	return t
}
${checkStreamEqFn}${treeEqFn}${windowHelpers}${reuseFns}type Doc struct { text string; root int32; toks []alignMeta; align *Align; validate bool${topReuse ? '; entries []EntryMeta' : ''} }
func NewDoc(src string) *Doc {
	d := &Doc{text: src}
	d.toks = ${initToks}
	d.root = parse(tokenize(src))
${topReuse ? '\td.entries = append([]EntryMeta(nil), entries...)\n' : ''}\treturn d
}
func (d *Doc) SetValidate(v bool) { d.validate = v }
func (d *Doc) Text() string { return d.text }
func (d *Doc) Root() int32 { return d.root }
func (d *Doc) Align() *Align { return d.align }
func applyEdit(text string, e Edit) string {
	n := len(text)
	start, end := e.Start, e.End
	if start < 0 { start = 0 }
	if start > n { start = n }
	if end < start { end = start }
	if end > n { end = n }
	return text[:start] + e.Text + text[end:]
}
func (d *Doc) Edit(edits []Edit) (ret int32) {
	oldText, oldToks := d.text, d.toks
	relexed := 0
	defer func() {
		if rec := recover(); rec != nil {
			d.text = oldText
			for _, e := range edits { d.text = applyEdit(d.text, e) }
			func() {
				defer func() {
					if recover() != nil {
						d.toks = nil
						d.root = -1
						d.align = &Align{OldN: len(oldToks), NewN: 0, Prefix: 0, Suffix: 0, Relexed: 0, Reused: 0}
					}
				}()
				d.toks = ${freshMeta}
				d.root = parse(toksFromMeta(d.text, d.toks))
				d.align = &Align{OldN: len(oldToks), NewN: len(d.toks), Prefix: 0, Suffix: 0, Relexed: len(d.toks), Reused: 0}
			}()
			ret = d.root
		}
	}()
${editBody}
	oldN, newN, prefix, suffix := computeAlignCore(oldText, oldToks, d.text, d.toks)
${editParse}
	a := &Align{OldN: oldN, NewN: newN, Prefix: prefix, Suffix: suffix, Relexed: relexed, Reused: reused}
	if d.validate {
		func() { defer func() { recover() }(); v := checkStreamEq(d.text, d.toks); a.StreamEq = &v }()
		func() { defer func() { recover() }(); t := checkTreeEq(d.text, d.root); a.TreeEq = &t }()
	}
	d.align = a
	ret = d.root
	return
}`;
}

// ─── Builder API (additive parse_with) — second instantiation ────────────────
// Parallel combinators / rules ending in `W`. Existing `parse`/arena/`Doc` above
// are byte-identical to pre-addon emit; this block is appended only.

/** parserCst: direct arena ckpt on embedded Nodes/Kids (native twin). parserW: Builder.Checkpoint. */
function arenaCkpt(recv: string): string {
  return recv === 'parserCst'
    ? 'nb, kb := len(p.Nodes), len(p.Kids)'
    : 'nb, kb := p.b.Checkpoint()';
}
/** parserCst: slice-truncate restore. parserW: Builder.Restore. */
function arenaRestore(recv: string): string {
  return recv === 'parserCst'
    ? 'p.Nodes = p.Nodes[:nb]; p.Kids = p.Kids[:kb]'
    : 'p.b.Restore(nb, kb)';
}

function stepCondW(s: Step, ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string {
  switch (s.t) {
    case 'lit': return `p.matchLitW(${lidOf(ids, s.value)}, ${ttIdOf(ar, s.ttype)})`;
    case 'tok': return `p.matchTokW(${kidOf(ids, s.name)}, ${ttIdOf(ar, s.name)})`;
    case 'rule': return `p.callRuleW((*${recv}).parse${s.name}W)`;
    case 'ruleBp': return `p.callRuleW(func(q *${recv}) (spanned, bool) { return q.${s.name}BpW(${s.bp}) })`;
    case 'star': return `p.starW(func() bool { return ${stepCondW(s.step, ids, ar, recv)} })`;
    case 'opt': return `p.optW(func() bool { return ${s.steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ')} })`;
    case 'sep': return `p.sepByW(func() bool { return ${stepCondW(s.elem, ids, ar, recv)} }, ${lidOf(ids, s.delim)})`;
    case 'altlit': return `p.altLitW([]struct{ Lid, TtId uint16 }{${s.opts.map((o) => `{${lidOf(ids, o.value)}, ${ttIdOf(ar, o.ttype)}}`).join(', ')}})`;
    case 'alt': return s.predictive
      ? `func() bool { ${predAltBodyW(s.branches, ids, ar, s.firsts, recv)} }()`
      : `func() bool { ${altBodyW(s.branches, ids, ar, s.firsts, recv)} }()`;
    case 'not': return `func() bool { ${notBodyW(s.steps, ids, ar, recv)} }()`;
    case 'seq': return `(${s.steps.length ? s.steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ') : 'true'})`;
    case 'sameLine': return `func() bool { t := p.peekW(); return t != nil && !t.Nl }()`;
    case 'suppress': return `func() bool { p.suppressNext = map[uint16]bool{${s.connectors.map((c) => `${lidOf(ids, c)}: true`).join(', ')}}; _r := (${s.steps.length ? s.steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ') : 'true'}); p.suppressNext = nil; return _r }()`;
  }
}
function altBodyW(branches: Step[][], ids: LexIdPlan, ar: ArenaIdPlan, firsts: FirstSig[] | undefined, recv: string): string {
  const fs = firsts ?? [];
  const nAlts = branches.length;
  const needPeek = branches.some((_, i) => isGuardable(fs[i] ?? null, nAlts));
  const peekInit = needPeek ? `_ft := p.peekW(); ` : '';
  const tries = branches.map((br, i) => {
    const body = `{ sp := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}; if ${br.length ? br.map((x) => stepCondW(x, ids, ar, recv)).join(' && ') : 'true'} { return true }; p.pos = sp; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)} }`;
    const f = fs[i] ?? null;
    if (!isGuardable(f, nAlts)) return body;
    return `if _ft != nil && ${firstCond(f, '_ft', ids)} ${body}`;
  }).join('; ');
  return `${peekInit}${tries}; return false`;
}
function notBodyW(steps: Step[], ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string {
  return `sp := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}; m := ${steps.length ? steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ') : 'true'}; p.pos = sp; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}; return !m`;
}
function predAltBodyW(branches: Step[][], ids: LexIdPlan, ar: ArenaIdPlan, firsts: FirstSig[] | undefined, recv: string): string {
  // Same-line `} else if` (native predAltBody joins with ' else '); newlines break Go ASI.
  const arms = branches.map((br, i) => `if ${firstCond(firsts![i], 't', ids)} { if ${br.length ? br.map((x) => stepCondW(x, ids, ar, recv)).join(' && ') : 'true'} { return true } }`).join(' else ');
  return `t := p.peekW(); if t == nil { return false }; ${arms}; return false`;
}

function rdRuleW(r: RdRule, ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string {
  const rid = ruleIdOf(ar, r.cstName);
  if (r.predictive) {
    // Join with space (not newline): Go ASI inserts ';' after '}' at EOL, which
    // breaks `} \\n else if` — native rdRule uses the same same-line join.
    const arm = (steps: Step[], i: number) => `\t${i === 0 ? 'if' : 'else if'} ${firstCond(r.altFirst[i], 't', ids)} { if ${steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ')} { return p.finishW(${rid}, sb, p.offAtW(save), save), true } }`;
    return `func (p *${recv}) parse${r.name}W() (spanned, bool) {
\tsave := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}
\tt := p.peekW(); if t == nil { return spanned{}, false }
${r.alts.map(arm).join(' ')}
\tp.pos = save; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}
\treturn spanned{}, false
}`;
  }
  const alt = (steps: Step[], i: number) => {
    const cond = steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ');
    const restore = `p.pos = save; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}`;
    if (!isGuardable(r.altFirst[i], r.alts.length)) {
      return `\tif ${cond} { return p.finishW(${rid}, sb, p.offAtW(save), save), true }
\t${restore}`;
    }
    return `\tif _ft != nil && ${firstCond(r.altFirst[i], '_ft', ids)} {
\t\tif ${cond} { return p.finishW(${rid}, sb, p.offAtW(save), save), true }
\t\t${restore}
\t}`;
  };
  const needPeek = r.alts.some((_, i) => isGuardable(r.altFirst[i], r.alts.length));
  return `func (p *${recv}) parse${r.name}W() (spanned, bool) {
\tsave := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}
${needPeek ? '\t_ft := p.peekW()\n' : ''}${r.alts.map(alt).join('\n')}
\treturn spanned{}, false
}`;
}

function topOneBodyW(plan: ReusePlanA): string {
  return plan.topOneBody
    .replace(/\{ sp := pos; n := parse([A-Za-z0-9_]+)\(\); if n >= 0 \{ return n \}; pos = sp \}/g,
      '{ sp := p.pos; fr, ok := p.parse$1W(); if ok { return fr, true }; p.pos = sp }')
    .replace(/return parse([A-Za-z0-9_]+)\(\)/g, 'return p.parse$1W()')
    .replace(/return -1/g, 'return spanned{}, false');
}

function rdEntryWithReuseAW(r: RdRule, plan: ReusePlanA, ar: ArenaIdPlan, recv: string): string {
  const rid = ruleIdOf(ar, r.cstName);
  // Engine-side EntryMeta (R2): never mutate consumer handles; span from spanned + SpanOf.
  return `func (p *${recv}) parseTopOneW() (spanned, bool) {
${topOneBodyW(plan)}
}
func (p *${recv}) parse${r.name}W() (spanned, bool) {
\tsave := p.pos; sb := len(p.scratch)
\tcapHint := (len(p.toks) - p.pos) / 2
\tif capHint < 8 { capHint = 8 }
\tlocalE := make([]EntryMeta, 0, capHint)
\tfor {
\t\tsp := p.pos
\t\tp.maxLook = 0
\t\tfr, ok := p.parseTopOneW()
\t\tif !ok { p.pos = sp; break }
\t\ttokEnd := p.pos
\t\text := tokEnd
\t\tif p.maxLook > ext { ext = p.maxLook }
\t\tend := int(fr.off)
\t\tif fr.present {
\t\t\t_, e1 := p.b.SpanOf(fr.h, p.toks)
\t\t\tend = int(e1)
\t\t\tlocalE = append(localE, EntryMeta{int(fr.tokStart), tokEnd, ext, int(fr.off), end, len(p.scratch) - sb, 1})
\t\t\tp.scratch = append(p.scratch, fr.h)
\t\t}
\t}
\tp.entries = localE
\treturn p.finishW(${rid}, sb, p.offAtW(save), save), true
}`;
}

function rdEntryWithReuseBW(r: RdRule, plan: ReusePlanB, ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string {
  const rid = ruleIdOf(ar, r.cstName);
  const headFn = plan.hasHead && plan.headRule
    ? `func (p *${recv}) parseHeadSegW(sb int) (EntryMeta, bool) {
\tp.maxLook = 0
\tbefore := len(p.scratch)
\ttokStart := p.pos
\tp.optW(func() bool { return p.callRuleW((*${recv}).parse${plan.headRule}W) })
\tif len(p.scratch) == before { return EntryMeta{}, false }
\th := p.scratch[before]
\to0, e1 := p.b.SpanOf(h, p.toks)
\ttokEnd := p.pos
\text := tokEnd
\tif p.maxLook > ext { ext = p.maxLook }
\treturn EntryMeta{tokStart, tokEnd, ext, int(o0), int(e1), before - sb, 1}, true
}
`
    : '';
  const headBlock = plan.hasHead && plan.headRule
    ? `\tif m, ok := p.parseHeadSegW(sb); ok { localE = append(localE, m) }
`
    : '';
  return `${headFn}func (p *${recv}) parseLoopSegW(sb int) (EntryMeta, bool) {
\tsp := p.pos; before := len(p.scratch); ${arenaCkpt(recv)}
\tp.maxLook = 0
\tif !p.matchTokW(${kidOf(ids, plan.loopTok)}, ${ttIdOf(ar, plan.loopTok)}) {
\t\tp.pos = sp; p.scratch = p.scratch[:before]; ${arenaRestore(recv)}
\t\treturn EntryMeta{}, false
\t}
\tp.optW(func() bool { return p.callRuleW((*${recv}).parse${plan.loopRule}W) })
\tcount := len(p.scratch) - before
\tif count == 0 { return EntryMeta{}, false }
\tleaf := p.scratch[before]
\to0, e1 := p.b.SpanOf(leaf, p.toks)
\tend := e1
\tif count > 1 {
\t\t_, e2 := p.b.SpanOf(p.scratch[before+1], p.toks)
\t\tend = e2
\t}
\ttokStart := sp
\ttokEnd := p.pos
\text := tokEnd
\tif p.maxLook > ext { ext = p.maxLook }
\treturn EntryMeta{tokStart, tokEnd, ext, int(o0), int(end), before - sb, count}, true
}
func (p *${recv}) parse${r.name}W() (spanned, bool) {
\tsave := p.pos; sb := len(p.scratch)
\tcapHint := (len(p.toks) - p.pos) / 2
\tif capHint < 8 { capHint = 8 }
\tlocalE := make([]EntryMeta, 0, capHint)
${headBlock}\tfor {
\t\tm, ok := p.parseLoopSegW(sb)
\t\tif !ok { break }
\t\tlocalE = append(localE, m)
\t}
\tp.entries = localE
\treturn p.finishW(${rid}, sb, p.offAtW(save), save), true
}`;
}

function rdEntryWithReuseW(r: RdRule, plan: ReusePlan, ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string {
  return plan.kind === 'A' ? rdEntryWithReuseAW(r, plan, ar, recv) : rdEntryWithReuseBW(r, plan, ids, ar, recv);
}

function prattRuleW(r: PrattRule, tpl: TplCfg | null, ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string {
  const rid = ruleIdOf(ar, r.cstName);
  const tplNud = tpl && r.nudToks.includes(tpl.token)
    ? `\tif t.Kid == ${kidOf(ids, '$templateHead')} {
\t\tn, ok := p.matchTemplateW()
\t\tif !ok { return spanned{}, false }
\t\tsb := len(p.scratch)
\t\tif n.present { p.scratch = append(p.scratch, n.h) }
\t\treturn p.finishW(${rid}, sb, int(n.off), int(n.tokStart)), true
\t}\n`
    : '';
  const bracketNudBody = (b: Bracket) => `{
\t\tsave := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}
\t\tif ${b.steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ')} { return p.finishW(${rid}, sb, p.offAtW(save), save), true }
\t\tp.pos = save; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}
\t}`;
  const bracketNudSwitch = (() => {
    if (r.nudBrackets.length === 0) return '';
    const groups = groupByPreserveOrder(r.nudBrackets, (b) => lidOf(ids, b.first));
    return `\tswitch t.Lid {
${groups.map((g) => `\tcase ${g.key}:
${g.members.map(({ item: b }) => `\t\t${bracketNudBody(b)}`).join('\n')}`).join('\n')}
\t}`;
  })();
  const ledGuard = (accessTail: boolean, lbp: number | null, sameLine: boolean, nll: string[] | null, lid: number) => {
    const parts: string[] = [];
    if (accessTail) parts.push('!tailClosed');
    if (lbp !== null) parts.push(`${lbp} > minBp`);
    if (sameLine) parts.push('!t.Nl');
    if (nll) parts.push(`!p.nllBlockedW([]string{${nll.map(J).join(', ')}}, left)`);
    parts.push(`!p.suppressCur[${lid}]`);
    return parts.join(' && ');
  };
  const ledBody = (b: Bracket) => `{
\t\t\tledSave := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}
\t\t\tp.scratch = append(p.scratch, left.h)
\t\t\tif ${b.steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ')} { left = p.finishW(${rid}, sb, int(left.off), int(left.tokStart)); continue LedLoop }
\t\t\tp.pos = ledSave; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}; break LedLoop
\t\t}`;
  const ledSwitch = (() => {
    if (r.leds.length === 0) return '';
    const groups = groupByPreserveOrder(r.leds, (b) => lidOf(ids, b.first));
    return `\t\tswitch t.Lid {
${groups.map((g) => {
  const lid = g.key as number;
  const arms = g.members.map(({ item: b, index: i }) =>
    `\t\t\tif ${ledGuard(r.ledAccessTail[i]!, r.ledLbp[i]!, r.ledSameLine[i]!, r.ledNotLeftLeaf[i]!, lid)} ${ledBody(b)}`);
  return `\t\tcase ${lid}:\n${arms.join('\n')}`;
}).join('\n')}
\t\t}`;
  })();
  const postfixTokSwitch = (() => {
    if (r.postfixToks.length === 0) return '';
    const groups = groupByPreserveOrder(r.postfixToks, (tok) => kidOf(ids, tok));
    const hasTpl = !!(tpl && r.postfixToks.includes(tpl.token));
    const tplPart = hasTpl ? `
\t\tif !tailClosed && t.Kid == ${kidOf(ids, '$templateHead')} {
\t\t\tif n, ok := p.matchTemplateW(); ok {
\t\t\t\tsb := len(p.scratch)
\t\t\t\tif left.present { p.scratch = append(p.scratch, left.h) }
\t\t\t\tif n.present { p.scratch = append(p.scratch, n.h) }
\t\t\t\tleft = p.finishW(${rid}, sb, int(left.off), int(left.tokStart)); continue LedLoop
\t\t\t}
\t\t}` : '';
    return `\t\tswitch t.Kid {
${groups.map((g) => `\t\tcase ${g.key}:
\t\t\tif !tailClosed {
\t\t\t\tsb := len(p.scratch); p.scratch = append(p.scratch, left.h); p.pushLeafW(uint16(t.Kid), uint32(p.pos), t.Off, t.End); p.pos++
\t\t\t\tleft = p.finishW(${rid}, sb, int(left.off), int(left.tokStart)); continue LedLoop
\t\t\t}`).join('\n')}
\t\t}${tplPart}`;
  })();
  const needLedLoop = r.leds.length > 0 || r.postfixToks.length > 0;
  return `func (p *${recv}) parse${r.name}W() (spanned, bool) {
\tprev := p.suppressCur
\tp.suppressCur = p.suppressNext
\tp.suppressNext = nil
\tr, ok := p.${r.name}BpW(0)
\tp.suppressCur = prev
\treturn r, ok
}
func (p *${recv}) ${r.name}BpW(minBp int) (spanned, bool) {
\tleft, ok := p.${r.name}NudW(minBp)
\tif !ok { return spanned{}, false }
\tif p.capped { return left, true }
\ttailClosed := false
${needLedLoop ? 'LedLoop:\n' : ''}\tfor {
\t\tt := p.peekW()
\t\tif t == nil { break }
${ledSwitch}
${postfixTokSwitch}
\t\tif post, ok := ${r.name}POST[t.Lid]; ok && !tailClosed && post > minBp {
\t\t\tsb := len(p.scratch); p.scratch = append(p.scratch, left.h); p.pushLeafW(${ttIdOf(ar, '$operator')}, uint32(p.pos), t.Off, t.End); p.pos++; tailClosed = true
\t\t\tleft = p.finishW(${rid}, sb, int(left.off), int(left.tokStart)); continue
\t\t}
\t\tinfo, ok := ${r.name}BIN[t.Lid]
\t\tif !ok || info.lbp <= minBp { break }
\t\tledSave := p.pos; sb := len(p.scratch)
\t\tp.scratch = append(p.scratch, left.h); p.pushLeafW(${ttIdOf(ar, '$operator')}, uint32(p.pos), t.Off, t.End)
\t\tp.pos++
\t\trhs, rok := p.${r.name}BpW(info.rbp)
\t\tif !rok { p.pos = ledSave; p.scratch = p.scratch[:sb]; break }
\t\tif rhs.present { p.scratch = append(p.scratch, rhs.h) }
\t\tleft = p.finishW(${rid}, sb, int(left.off), int(left.tokStart))
\t}
\treturn left, true
}
func (p *${recv}) ${r.name}NudW(minBp int) (spanned, bool) {
\tp.capped = false
\tt := p.peekW()
\tif t == nil { return spanned{}, false }
${r.nudCapped.map((c) => `\tif minBp < ${c.capBp} { save := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}; if ${c.steps.length ? c.steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ') : 'true'} { p.capped = true; return p.finishW(${rid}, sb, p.offAtW(save), save), true }; p.pos = save; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)} }`).join('\n')}
\t_r, _ok := func() (spanned, bool) {
${tplNud}\tif ${r.name}ATOM[t.Kid] {
\t\tsb := len(p.scratch); ts := p.pos; p.pushLeafW(uint16(t.Kid), uint32(p.pos), t.Off, t.End); p.pos++
\t\treturn p.finishW(${rid}, sb, int(t.Off), ts), true
\t}
${bracketNudSwitch}
\tif pbp, ok := ${r.name}PRE[t.Lid]; ok {
\t\tsave := p.pos; sb := len(p.scratch)
\t\tp.pushLeafW(${ttIdOf(ar, '$operator')}, uint32(p.pos), t.Off, t.End); p.pos++
\t\toperand, ook := p.${r.name}BpW(pbp)
\t\tif !ook { p.pos = save; p.scratch = p.scratch[:sb]; return spanned{}, false }
\t\tif operand.present { p.scratch = append(p.scratch, operand.h) }
\t\treturn p.finishW(${rid}, sb, p.offAtW(save), save), true
\t}
${r.nudSeqs.map((seq) => `\t{ save := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}; if ${seq.length ? seq.map((x) => stepCondW(x, ids, ar, recv)).join(' && ') : 'true'} { return p.finishW(${rid}, sb, p.offAtW(save), save), true }; p.pos = save; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)} }`).join('\n')}
\treturn spanned{}, false
\t}()
\tp.capped = false
\treturn _r, _ok
}`;
}

function emitParserMethodsW(recv: string, ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const reuse = topReusePlan(ir);
  const entriesField = reuse ? '\n\tentries []EntryMeta' : '';
  const ruleFnsW = ir.rules.map((r) => {
    if (r.kind === 'pratt') return prattRuleW(r, ir.tpl, ids, ar, recv);
    if (reuse && r.name === ir.entry) return rdEntryWithReuseW(r, reuse, ids, ar, recv);
    return rdRuleW(r, ids, ar, recv);
  }).join('\n\n');
  const matchTemplateW = ir.tpl ? `func (p *${recv}) matchTemplateW() (spanned, bool) {
\tt := p.peekW()
\tif t == nil || t.Kid != ${kidOf(ids, '$templateHead')} { return spanned{}, false }
\tsave := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}
\tp.pushLeafW(${ttIdOf(ar, '$templateHead')}, uint32(p.pos), t.Off, t.End); p.pos++
\tfor {
\t\texpr, ok := p.parse${ir.tpl.interpRule}W()
\t\tif !ok { p.pos = save; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}; return spanned{}, false }
\t\tif expr.present { p.scratch = append(p.scratch, expr.h) }
\t\tnext := p.peekW()
\t\tif next == nil { p.pos = save; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}; return spanned{}, false }
\t\tif next.Kid == ${kidOf(ids, '$templateMiddle')} { p.pushLeafW(${ttIdOf(ar, '$templateMiddle')}, uint32(p.pos), next.Off, next.End); p.pos++; continue }
\t\tif next.Kid == ${kidOf(ids, '$templateTail')} { p.pushLeafW(${ttIdOf(ar, '$templateTail')}, uint32(p.pos), next.Off, next.End); p.pos++; break }
\t\tp.pos = save; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}; return spanned{}, false
\t}
\treturn p.finishW(${ruleIdOf(ar, '$template')}, sb, p.offAtW(save), save), true
}
` : '';
  const cstDirect = recv === 'parserCst';
  // parserCst: Nodes/Kids embedded (Rust by-value layout). parserW: interface Builder.
  const pushLeafW = cstDirect ? `func (p *${recv}) pushLeafW(ttId uint16, tokIdx, off, end uint32) {
\t_ = off; _ = end
\tif ttId == TT_SKIP_PUNCT { return }
\tp.scratch = append(p.scratch, encodeLeaf(tokIdx, uint8(ttId)))
}` : `func (p *${recv}) pushLeafW(ttId uint16, tokIdx, off, end uint32) {
\t_ = p.b.Leaf(&p.scratch, ttId, tokIdx, off, end)
}`;
  const finishW = cstDirect ? `func (p *${recv}) finishW(ruleId uint16, sb, fallbackOff, tokStart int) spanned {
\tnn := len(p.scratch)
\tkidStart := len(p.Kids)
\toff, end := uint32(fallbackOff), uint32(fallbackOff)
\tif nn > sb {
\t\tfirst := p.scratch[sb]
\t\tlast := p.scratch[nn-1]
\t\tif first < 0 {
\t\t\tti, _ := decodeLeaf(first)
\t\t\toff = uint32(p.toks[ti].Off)
\t\t} else {
\t\t\toff = p.Nodes[first].Offset
\t\t}
\t\tif last < 0 {
\t\t\tti, _ := decodeLeaf(last)
\t\t\tend = uint32(p.toks[ti].End)
\t\t} else {
\t\t\tend = p.Nodes[last].End
\t\t}
\t}
\tp.Kids = append(p.Kids, p.scratch[sb:nn]...)
\tp.scratch = p.scratch[:sb]
\tp.Nodes = append(p.Nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(nn - sb), Offset: off, End: end, TokStart: uint32(tokStart), TokEnd: uint32(p.pos), Ext: 0})
\treturn spanned{h: int32(len(p.Nodes) - 1), off: off, tokStart: uint32(tokStart), present: true}
}` : `func (p *${recv}) finishW(ruleId uint16, sb, fallbackOff, tokStart int) spanned {
\th, off, present := p.b.Finish(&p.scratch, sb, ruleId, uint32(fallbackOff), uint32(tokStart), uint32(p.pos), p.toks)
\treturn spanned{h: h, off: off, tokStart: uint32(tokStart), present: present}
}`;
  const headLeafTextW = cstDirect ? `func (p *${recv}) headLeafTextW(f spanned) string {
\tif !f.present { return "" }
\tid := f.h
\tfor {
\t\tif id < 0 {
\t\t\tti, _ := decodeLeaf(id)
\t\t\tt := p.toks[ti]
\t\t\treturn p.src[t.Off:t.End]
\t\t}
\t\tnd := &p.Nodes[id]
\t\tif nd.KidCount == 0 { break }
\t\tid = p.Kids[nd.KidStart]
\t}
\tnd := &p.Nodes[id]
\treturn p.src[nd.Offset:nd.End]
}` : `func (p *${recv}) headLeafTextW(f spanned) string {
\tif !f.present { return "" }
\ta, b := p.b.HeadSpan(f.h, p.toks)
\tif a <= b && int(b) <= len(p.src) { return p.src[a:b] }
\treturn ""
}`;
  const structFields = cstDirect
    ? `\ttoks []Tok
\tpos, maxLook int
\tcapped bool
\tsuppressNext, suppressCur map[uint16]bool
\tsrc string
\tNodes []Node
\tKids []int32
\tscratch []int32`
    : `\ttoks []Tok
\tpos, maxLook int
\tcapped bool
\tsuppressNext, suppressCur map[uint16]bool
\tsrc string
\tb Builder
\tscratch []int32${entriesField}`;
  return `type ${recv} struct {
${structFields}
}

func (p *${recv}) peekW() *Tok {
\tif p.pos+1 > p.maxLook { p.maxLook = p.pos + 1 }
\tif p.pos < len(p.toks) { return &p.toks[p.pos] }
\treturn nil
}
func (p *${recv}) offAtW(i int) int { if i < len(p.toks) { return int(p.toks[i].Off) }; return 0 }
${pushLeafW}
${finishW}
${headLeafTextW}
func (p *${recv}) nllBlockedW(words []string, left spanned) bool {
\th := p.headLeafTextW(left)
\tfor _, w := range words { if w == h { return true } }
\treturn false
}
func (p *${recv}) matchLitW(lid, ttId uint16) bool {
\tt := p.peekW()
\tif t != nil && t.Lid == lid { p.pushLeafW(ttId, uint32(p.pos), t.Off, t.End); p.pos++; return true }
\treturn false
}
func (p *${recv}) matchTokW(kid, ttId uint16) bool {
\tt := p.peekW()
\tif t != nil && t.Kid == kid { p.pushLeafW(ttId, uint32(p.pos), t.Off, t.End); p.pos++; return true }
\treturn false
}
func (p *${recv}) callRuleW(fn func(*${recv}) (spanned, bool)) bool {
\tfr, ok := fn(p)
\tif !ok { return false }
\tif fr.present { p.scratch = append(p.scratch, fr.h) }
\treturn true
}
func (p *${recv}) starW(once func() bool) bool {
\tfor {
\t\tsp := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}
\t\tif !once() { p.pos = sp; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}; break }
\t}
\treturn true
}
func (p *${recv}) optW(body func() bool) bool {
\tsp := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}
\tif !body() { p.pos = sp; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)} }
\treturn true
}
func (p *${recv}) sepByW(elem func() bool, delim uint16) bool {
\tif !elem() { return true }
\tfor {
\t\tsp := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}
\t\tif !p.matchLitW(delim, TT_SKIP_PUNCT) { p.pos = sp; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}; break }
\t\tif !elem() { break }
\t}
\treturn true
}
func (p *${recv}) altLitW(opts []struct{ Lid, TtId uint16 }) bool {
\tfor _, o := range opts { if p.matchLitW(o.Lid, o.TtId) { return true } }
\treturn false
}

${matchTemplateW}${ruleFnsW}
`;
}

function emitBuilderAddonGo(ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const dropTtIds = ['$punct', '$keyword', '$operator']
    .map((n) => {
      try { return ttIdOf(ar, n); } catch { return null; }
    })
    .filter((x): x is number => x !== null);
  const punctId = TT_SKIP_PUNCT;
  const slimDropCases = dropTtIds.length
    ? dropTtIds.map((id) => `${id}`).join(', ')
    : '/* none */';
  const slimDropBody = dropTtIds.length
    ? `\tswitch ttId {\n\tcase ${slimDropCases}:\n\t\treturn false\n\t}\n`
    : '';
  // Selection: Go cannot monomorphize a second parse instantiation for free
  // (measured ~6–8ms / ~12–15% on 2MB TS). Hot path for *CstBuilder reuses
  // native parse() via arena slice swap; other Builders use interface parserW.
  const wMethods = emitParserMethodsW('parserW', ir, ids, ar);
  return `// ─── Builder API (additive; CST parse() / Doc above are unchanged) ───────────
// Builder is pure / bottom-up. Backtracking truncates scratch (+ optional arena
// checkpoint); discarded handles are garbage.
// *CstBuilder hot path = native parse() (arena swap). Interface path = parserW.

type Builder interface {
\tLeaf(scratch *[]int32, ttId uint16, tokIdx, off, end uint32) bool
\tFinish(scratch *[]int32, sb int, ruleId uint16, fallbackOff, tokStart, tokEnd uint32, toks []Tok) (h int32, off uint32, present bool)
\tNode(scratch *[]int32, sb int, ruleId uint16, off, end, tokStart, tokEnd uint32)
\tSpanOf(h int32, toks []Tok) (uint32, uint32)
\tHeadSpan(h int32, toks []Tok) (uint32, uint32)
\tCheckpoint() (nb, kb int)
\tRestore(nb, kb int)
}

// spanned: span fields are independent of the handle (Pratt never reads H for spans).
type spanned struct {
\th int32
\toff, tokStart uint32
\tpresent bool
}

func builderFinishDefault(b Builder, scratch *[]int32, sb int, ruleId uint16, fallbackOff, tokStart, tokEnd uint32, toks []Tok) (int32, uint32, bool) {
\tnn := len(*scratch)
\tvar offset, end uint32
\tif nn > sb {
\t\to0, _ := b.SpanOf((*scratch)[sb], toks)
\t\t_, e1 := b.SpanOf((*scratch)[nn-1], toks)
\t\toffset, end = o0, e1
\t} else {
\t\toffset, end = fallbackOff, fallbackOff
\t}
\tb.Node(scratch, sb, ruleId, offset, end, tokStart, tokEnd)
\tn := len(*scratch) - sb
\tif n == 1 {
\t\th := (*scratch)[len(*scratch)-1]
\t\t*scratch = (*scratch)[:len(*scratch)-1]
\t\treturn h, offset, true
\t} else if n == 0 {
\t\treturn 0, offset, false
\t}
\th := (*scratch)[sb]
\t*scratch = (*scratch)[:sb]
\treturn h, offset, true
}

type CstBuilder struct {
\tNodes []Node
\tKids  []int32
}

func (b *CstBuilder) Checkpoint() (nb, kb int) { return len(b.Nodes), len(b.Kids) }
func (b *CstBuilder) Restore(nb, kb int) { b.Nodes = b.Nodes[:nb]; b.Kids = b.Kids[:kb] }
func (b *CstBuilder) Leaf(scratch *[]int32, ttId uint16, tokIdx, off, end uint32) bool {
\t_ = off; _ = end
\tif ttId == ${punctId} { return false }
\t*scratch = append(*scratch, encodeLeaf(tokIdx, uint8(ttId)))
\treturn true
}
// Finish is a byte-twin of native finish (always creates a node, present=true).
func (b *CstBuilder) Finish(scratch *[]int32, sb int, ruleId uint16, fallbackOff, tokStart, tokEnd uint32, toks []Tok) (int32, uint32, bool) {
\tnn := len(*scratch)
\tkidStart := len(b.Kids)
\toff, end := fallbackOff, fallbackOff
\tif nn > sb {
\t\to0, _ := cstKidOffEnd(b.Nodes, toks, (*scratch)[sb])
\t\t_, e1 := cstKidOffEnd(b.Nodes, toks, (*scratch)[nn-1])
\t\toff, end = o0, e1
\t}
\tb.Kids = append(b.Kids, (*scratch)[sb:nn]...)
\t*scratch = (*scratch)[:sb]
\tb.Nodes = append(b.Nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(nn - sb), Offset: off, End: end, TokStart: tokStart, TokEnd: tokEnd, Ext: 0})
\treturn int32(len(b.Nodes) - 1), off, true
}
func (b *CstBuilder) Node(scratch *[]int32, sb int, ruleId uint16, off, end, tokStart, tokEnd uint32) {
\tnn := len(*scratch)
\tkidStart := len(b.Kids)
\tb.Kids = append(b.Kids, (*scratch)[sb:nn]...)
\t*scratch = (*scratch)[:sb]
\tb.Nodes = append(b.Nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(nn - sb), Offset: off, End: end, TokStart: tokStart, TokEnd: tokEnd, Ext: 0})
\t*scratch = append(*scratch, int32(len(b.Nodes)-1))
}
func (b *CstBuilder) SpanOf(h int32, toks []Tok) (uint32, uint32) {
\treturn cstKidOffEnd(b.Nodes, toks, h)
}
func (b *CstBuilder) HeadSpan(h int32, toks []Tok) (uint32, uint32) {
\tid := h
\tfor {
\t\tif id < 0 {
\t\t\tti, _ := decodeLeaf(id)
\t\t\tt := &toks[ti]
\t\t\treturn t.Off, t.End
\t\t}
\t\tnd := &b.Nodes[id]
\t\tif nd.KidCount == 0 { return nd.Offset, nd.End }
\t\tid = b.Kids[nd.KidStart]
\t}
}
func cstKidOffEnd(nodes []Node, toks []Tok, kid int32) (uint32, uint32) {
\tif kid < 0 {
\t\tti, _ := decodeLeaf(kid)
\t\tt := &toks[ti]
\t\treturn t.Off, t.End
\t}
\tnd := &nodes[kid]
\treturn nd.Offset, nd.End
}

type SlimBuilder struct {
\tNodes []Node
\tKids  []int32
}

func (b *SlimBuilder) Checkpoint() (nb, kb int) { return len(b.Nodes), len(b.Kids) }
func (b *SlimBuilder) Restore(nb, kb int) { b.Nodes = b.Nodes[:nb]; b.Kids = b.Kids[:kb] }
func (b *SlimBuilder) Leaf(scratch *[]int32, ttId uint16, tokIdx, off, end uint32) bool {
\t_ = off; _ = end
${slimDropBody}\tif ttId == ${punctId} { return false }
\t*scratch = append(*scratch, encodeLeaf(tokIdx, uint8(ttId)))
\treturn true
}
func (b *SlimBuilder) Finish(scratch *[]int32, sb int, ruleId uint16, fallbackOff, tokStart, tokEnd uint32, toks []Tok) (int32, uint32, bool) {
\treturn builderFinishDefault(b, scratch, sb, ruleId, fallbackOff, tokStart, tokEnd, toks)
}
func (b *SlimBuilder) Node(scratch *[]int32, sb int, ruleId uint16, off, end, tokStart, tokEnd uint32) {
\tnn := len(*scratch)
\tcount := nn - sb
\tif count == 1 { return }
\tif count == 0 { *scratch = (*scratch)[:sb]; return }
\tkidStart := len(b.Kids)
\tb.Kids = append(b.Kids, (*scratch)[sb:nn]...)
\t*scratch = (*scratch)[:sb]
\tb.Nodes = append(b.Nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(count), Offset: off, End: end, TokStart: tokStart, TokEnd: tokEnd, Ext: 0})
\t*scratch = append(*scratch, int32(len(b.Nodes)-1))
}
func (b *SlimBuilder) SpanOf(h int32, toks []Tok) (uint32, uint32) {
\tif h < 0 {
\t\tti, _ := decodeLeaf(h)
\t\tt := &toks[ti]
\t\treturn t.Off, t.End
\t}
\tnd := &b.Nodes[h]
\treturn nd.Offset, nd.End
}
func (b *SlimBuilder) HeadSpan(h int32, toks []Tok) (uint32, uint32) {
\tid := h
\tfor {
\t\tif id < 0 {
\t\t\tti, _ := decodeLeaf(id)
\t\t\tt := &toks[ti]
\t\t\treturn t.Off, t.End
\t\t}
\t\tnd := &b.Nodes[id]
\t\tif nd.KidCount == 0 { return nd.Offset, nd.End }
\t\tid = b.Kids[nd.KidStart]
\t}
}

${wMethods}
// parseWithCst: concrete hot path — native parse codegen with builder arena swap.
// Keeps ParseWith(CstBuilder) within the additive-prefix / byte-equal contract
// without paying for a second method-instantiation (Go GC-shape stenciling tax).
func parseWithCst(src string, b *CstBuilder) (int32, bool) {
\tsaveNodes, saveKids := nodes, kids
\tnodes, kids = b.Nodes[:0], b.Kids[:0]
\th := parse(tokenize(src))
\tb.Nodes, b.Kids = nodes, kids
\tnodes, kids = saveNodes, saveKids
\tif h < 0 { return 0, false }
\treturn h, true
}
func parseWithW(src string, b Builder) (int32, bool) {
\ttoks := lex(src)
\tn := len(toks)
\tp := &parserW{toks: toks, src: src, b: b, scratch: nil}
\tfr, ok := p.parse${ir.entry}W()
\tif !ok || p.pos != n || !fr.present { return 0, false }
\treturn fr.h, true
}

// ParseWith runs the builder-driven parse. *CstBuilder uses the concrete hot path
// (native parse + arena swap); other Builders (e.g. *SlimBuilder) use interface parserW.
// ok=false is reject (distinct from a leaf handle, which may also be negative).
func ParseWith(src string, b Builder) (h int32, ok bool) {
\tif cb, is := b.(*CstBuilder); is {
\t\treturn parseWithCst(src, cb)
\t}
\treturn parseWithW(src, b)
}

func writeKidWith(nodes []Node, kids []int32, toks []Tok, v int32, b *strings.Builder) {
\tif v < 0 {
\t\tti, tt := decodeLeaf(v)
\t\tt := toks[ti]
\t\tfmt.Fprintf(b, "{\\"tokenType\\":%q,\\"offset\\":%d,\\"end\\":%d}", TT_NAMES[tt], t.Off, t.End)
\t\treturn
\t}
\twriteJSONWith(nodes, kids, toks, v, b)
}
func writeJSONWith(nodes []Node, kids []int32, toks []Tok, id int32, b *strings.Builder) {
\tnd := &nodes[id]
\tfmt.Fprintf(b, "{\\"rule\\":%q,\\"children\\":[", RULE_NAMES[nd.RuleId])
\tfor i := uint32(0); i < nd.KidCount; i++ {
\t\tif i > 0 { b.WriteByte(',') }
\t\twriteKidWith(nodes, kids, toks, kids[nd.KidStart+i], b)
\t}
\tfmt.Fprintf(b, "],\\"offset\\":%d,\\"end\\":%d}", nd.Offset, nd.End)
}

func CstJSONWith(b *CstBuilder, toks []Tok, root int32) string {
\tvar buf strings.Builder
\twriteJSONWith(b.Nodes, b.Kids, toks, root, &buf)
\treturn buf.String()
}
func SlimJSONWith(b *SlimBuilder, toks []Tok, root int32) string {
\tvar buf strings.Builder
\twriteJSONWith(b.Nodes, b.Kids, toks, root, &buf)
\treturn buf.String()
}
`;
}

export const goTarget: Target = {
  name: 'go',
  ext: 'go',
  embedLexer(grammar: CstGrammar): string {
    return lexer(portableIR(grammar));
  },
  emitLexer(grammar: CstGrammar): string {
    return `// GENERATED by emit-portable.ts (goTarget) — standalone TOKENIZER for grammar "${grammar.name ?? ''}".
// A library package: Tokenize(src) []RichTok. The same lexer is embedded in emitParser's output
// (there as package main), so the tokens are identical.
package lexer

import (
\t"fmt"
\t"strings"
)

// The lexer panics via fmt on an unmatched char and uses strings for literal prefixes; pin both
// imports so a grammar whose lexer happens to skip one still compiles.
var _, _ = fmt.Sprintf, strings.HasPrefix

// Slim hot-path token (kind/text via KIND_STR / src[Off:End]).
type Tok struct {
\tOff, End uint32
\tKid, Lid uint16
\tNl       bool
}

// Public materialized token (API shape).
type RichTok struct {
\tKind, Text string
\tOff, End   int
\tNl         bool
\tKid, Lid   uint16
}

var toks []Tok   // the lexer reseeds this (toks[:0]) per call

${lexer(portableIR(grammar))}

func Tokenize(src string) []RichTok {
\tslim := lex(src)
\tout := make([]RichTok, len(slim))
\tfor i := range slim {
\t\tt := &slim[i]
\t\tout[i] = RichTok{Kind: tokKind(t), Text: tokText(src, t), Off: int(t.Off), End: int(t.End), Nl: t.Nl, Kid: t.Kid, Lid: t.Lid}
\t}
\treturn out
}
`;
  },
  emitParser(grammar: CstGrammar, lexerSrc: string | null): string {
    const ir = portableIR(grammar);
    const ids = buildLexIdPlan(ir);
    const ar = buildArenaIdPlan(ir, ids);
    const reuse = topReusePlan(ir);
    const ruleFns = ir.rules.map((r) => {
      if (r.kind === 'pratt') return prattRule(r, ir.tpl, ids, ar);
      if (reuse && r.name === ir.entry) return rdEntryWithReuse(r, reuse, ids, ar);
      return rdRule(r, ids, ar);
    }).join('\n\n');
    const matchTemplate = ir.tpl ? `func matchTemplate() int32 {
\tt := peek()
\tif t == nil || t.Kid != ${kidOf(ids, '$templateHead')} { return -1 }
\tsb := len(scratch); nb := len(nodes); kb := len(kids); save := pos
\tpushLeaf(${ttIdOf(ar, '$templateHead')}, uint32(pos)); pos++
\tfor {
\t\texpr := parse${ir.tpl.interpRule}()
\t\tif expr < 0 { pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; return -1 }
\t\tscratch = append(scratch, expr)
\t\tnext := peek()
\t\tif next == nil { pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; return -1 }
\t\tif next.Kid == ${kidOf(ids, '$templateMiddle')} { pushLeaf(${ttIdOf(ar, '$templateMiddle')}, uint32(pos)); pos++; continue }
\t\tif next.Kid == ${kidOf(ids, '$templateTail')} { pushLeaf(${ttIdOf(ar, '$templateTail')}, uint32(pos)); pos++; break }
\t\tpos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; return -1
\t}
\treturn finish(${ruleIdOf(ar, '$template')}, sb, int(t.Off), save)
}
` : '';
    return `// GENERATED by emit-portable.ts (goTarget) — parser LIBRARY for grammar "${ir.grammarName}".
// Exposes tokenize(src) + parse(toks) + writeJSON. The CLI runner (stdin → CST JSON) is goTarget.emitRunner()
// — a SEPARATE runner.go in this same \`package main\` (Go forbids a second import block after
// declarations, so it can't be appended inline). Together they \`go build\` into an executable.
package main

import (
\t"fmt"
\t"strings"
)

// Slim hot-path token (kind/text via KIND_STR / src[Off:End]).
type Tok struct {
\tOff, End uint32
\tKid, Lid uint16
\tNl       bool
}
// Arena node: an int32 index into nodes; children are a flat range in kids (node indices or encoded leaf refs).
// Ext is lookahead watermark for top-level reuse (not emitted in JSON).
type Node struct {
\tRuleId uint16
\tKidStart, KidCount, Offset, End, TokStart, TokEnd, Ext uint32
}
type bp struct{ lbp, rbp int }

var toks []Tok
var pos int
var maxLook int
var _capped bool
var _src string
var _suppressNext map[uint16]bool
var _suppressCur map[uint16]bool
var nodes []Node
var kids []int32
var scratch []int32
var arenaBaseline int
const arenaCompactK = 4

${renderArenaTablesGo(ar)}

${lexerSrc ?? ''}

func encodeLeaf(tokIdx uint32, ttId uint8) int32 {
\tif tokIdx >= (1 << 25) { panic("tok_idx exceeds 2^25-1") }
\tpacked := tokIdx | (uint32(ttId) << 25)
\treturn int32(^packed)
}
func decodeLeaf(v int32) (tokIdx uint32, ttId uint8) {
\tpacked := uint32(^v)
\treturn packed & ((1 << 25) - 1), uint8(packed >> 25)
}
func pushLeaf(ttId uint8, tokIdx uint32) {
\tif ttId == TT_SKIP_PUNCT { return }
\tscratch = append(scratch, encodeLeaf(tokIdx, ttId))
}

func peek() *Tok {
\tif pos+1 > maxLook { maxLook = pos + 1 }
\tif pos < len(toks) { return &toks[pos] }
\treturn nil
}
func offAt(i int) int { if i < len(toks) { return int(toks[i].Off) }; return 0 }
// Wrap the scratch entries [sb:] as one node's children (flattened into kids); truncate scratch.
// tokStart is the parse-consumption start (entry pos / leftmost operand), tokEnd is pos at finish.
func finish(ruleId uint16, sb, fallbackOff, tokStart int) int32 {
\tnn := len(scratch)
\tkidStart := len(kids)
\toff, end := uint32(fallbackOff), uint32(fallbackOff)
\tif nn > sb {
\t\tfirst := scratch[sb]
\t\tlast := scratch[nn-1]
\t\tif first < 0 {
\t\t\tti, _ := decodeLeaf(first)
\t\t\toff = uint32(toks[ti].Off)
\t\t} else {
\t\t\toff = nodes[first].Offset
\t\t}
\t\tif last < 0 {
\t\t\tti, _ := decodeLeaf(last)
\t\t\tend = uint32(toks[ti].End)
\t\t} else {
\t\t\tend = nodes[last].End
\t\t}
\t}
\tkids = append(kids, scratch[sb:nn]...)
\tscratch = scratch[:sb]
\tnodes = append(nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(nn - sb), Offset: off, End: end, TokStart: uint32(tokStart), TokEnd: uint32(pos), Ext: 0})
\treturn int32(len(nodes) - 1)
}
func matchLit(lid uint16, ttId uint8) bool {
\tif pos+1 > maxLook { maxLook = pos + 1 } // probe counts as lookahead (mirrors TS/Rust peek())
\tif pos < len(toks) && toks[pos].Lid == lid { pushLeaf(ttId, uint32(pos)); pos++; return true }
\treturn false
}
func matchTok(kid uint16, ttId uint8) bool {
\tif pos+1 > maxLook { maxLook = pos + 1 }
\tif pos < len(toks) && toks[pos].Kid == kid { pushLeaf(ttId, uint32(pos)); pos++; return true }
\treturn false
}
func callRule(fn func() int32) bool {
\tid := fn()
\tif id < 0 { return false }
\tscratch = append(scratch, id); return true
}
func star(once func() bool) bool {
\tfor { sp := pos; sb := len(scratch); nb := len(nodes); kb := len(kids); if !once() { pos = sp; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; break } }
\treturn true
}
func opt(body func() bool) bool {
\tsp := pos; sb := len(scratch); nb := len(nodes); kb := len(kids); if !body() { pos = sp; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb] }; return true
}
func sepBy(elem func() bool, delimLid uint16) bool {
\tif !elem() { return true }   // the whole separated list is optional — zero elements is valid
\tfor {
\t\tsp := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\t\tif !matchLit(delimLid, TT_SKIP_PUNCT) { pos = sp; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; break }
\t\tif !elem() { break }   // a trailing delimiter is allowed — keep the pushed delim and stop
\t}
\treturn true
}
func altLit(opts []struct{ Lid uint16; TtId uint8 }) bool {
\tfor _, o := range opts { if matchLit(o.Lid, o.TtId) { return true } }
\treturn false
}

${matchTemplate}${ruleFns}

func writeKid(v int32, b *strings.Builder) {
\tif v < 0 {
\t\tti, tt := decodeLeaf(v)
\t\tt := toks[ti]
\t\tfmt.Fprintf(b, "{\\"tokenType\\":%q,\\"offset\\":%d,\\"end\\":%d}", TT_NAMES[tt], t.Off, t.End)
\t\treturn
\t}
\twriteJSON(v, b)
}
func writeJSON(id int32, b *strings.Builder) {
\tnd := &nodes[id]
\tfmt.Fprintf(b, "{\\"rule\\":%q,\\"children\\":[", RULE_NAMES[nd.RuleId])
\tfor i := uint32(0); i < nd.KidCount; i++ {
\t\tif i > 0 { b.WriteByte(',') }
\t\twriteKid(kids[nd.KidStart+i], b)
\t}
\tfmt.Fprintf(b, "],\\"offset\\":%d,\\"end\\":%d}", nd.Offset, nd.End)
}

func headLeafText(id int32) string {
\tfor {
\t\tif id < 0 {
\t\t\tti, _ := decodeLeaf(id)
\t\t\tt := toks[ti]
\t\t\treturn _src[t.Off:t.End]
\t\t}
\t\tnd := &nodes[id]
\t\tif nd.KidCount == 0 { break }
\t\tid = kids[nd.KidStart]
\t}
\tnd := &nodes[id]
\treturn _src[nd.Offset:nd.End]
}
func _inW(ws []string, s string) bool { for _, w := range ws { if w == s { return true } }; return false }

// Library entry, two composable phases. tokenize() lexes ONCE; pass its tokens to parse().
// Want the tokens AND the CST? t := tokenize(src); parse(t) — no re-lexing. (tokenize also
// records the source for head-leaf lookups.)
func tokenize(src string) []Tok {
\t_src = src
\treturn lex(src)
}
func parse(t []Tok) int32 {
\ttoks = t
\tpos = 0
\tmaxLook = 0
\tnodes = nodes[:0]; kids = kids[:0]; scratch = scratch[:0]
\troot := parse${ir.entry}()
\tarenaBaseline = len(nodes)
\t// Full-consumption guard (mirrors the TS wrapper): a partial parse is a reject, not a
\t// tree. Without this, Doc keeps a partial root after a rejecting edit and the next
\t// edit's reuse path resurrects it as if it were a valid old tree.
\tif root >= 0 && pos != len(toks) { return -1 }
\treturn root
}

${docEditBlockGo(ir)}
${emitBuilderAddonGo(ir, ids, ar)}
`;
  },
  emitRunner(): string {
    return `// CLI runner (harness only): stdin -> CST JSON + a self-bench mode. A SEPARATE file in the
// same package main as the parser library; NOT part of the parser. The gate writes it as
// runner.go so the package builds into an executable.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

func main() {
\tdata, _ := io.ReadAll(os.Stdin)
\tsrc := string(data)
\teditFast := len(os.Args) > 1 && os.Args[1] == "edit-session-fast"
\teditSess := editFast || (len(os.Args) > 1 && os.Args[1] == "edit-session")
\t// Self-bench: a numeric arg N times the lex+parse loop and prints ms/iteration.
\tif len(os.Args) > 1 && !editSess {
\t\tif iters, err := strconv.Atoi(os.Args[1]); err == nil && iters > 0 {
\t\t\tfor i := 0; i < 3; i++ { parse(tokenize(src)) }
\t\t\tt0 := time.Now()
\t\t\tfor i := 0; i < iters; i++ { parse(tokenize(src)) }
\t\t\tfmt.Printf("%.4f\\n", float64(time.Since(t0).Nanoseconds())/1e6/float64(iters))
\t\t\treturn
\t\t}
\t}
\tif editSess {
\t\tvar sess struct {
\t\t\tInit    string              \`json:"init"\`
\t\t\tBatches [][][3]interface{}   \`json:"batches"\`
\t\t}
\t\tif json.Unmarshal(data, &sess) != nil { os.Exit(1) }
\t\td := NewDoc(sess.Init)
\t\tif !editFast { d.SetValidate(true) }
\t\tfor _, batch := range sess.Batches {
\t\t\tedits := make([]Edit, len(batch))
\t\t\tfor i, t := range batch {
\t\t\t\tedits[i] = Edit{Start: int(t[0].(float64)), End: int(t[1].(float64)), Text: t[2].(string)}
\t\t\t}
\t\t\td.Edit(edits)
\t\t}
\t\tif a := d.Align(); a != nil { b, _ := json.Marshal(a); os.Stderr.Write(append(b, '\\n')) }
\t\troot := d.Root()
\t\tif root < 0 || pos != len(toks) { fmt.Fprintf(os.Stderr, "parse error (pos %d/%d)\\n", pos, len(toks)); os.Exit(1) }
\t\tvar b strings.Builder
\t\twriteJSON(root, &b)
\t\tos.Stdout.WriteString(b.String())
\t\treturn
\t}
\tif len(os.Args) > 1 && os.Args[1] == "tok-spans" {
\t\troot := parse(tokenize(src))
\t\tif root < 0 || pos != len(toks) {
\t\t\tfmt.Fprintf(os.Stderr, "parse error (pos %d/%d)\\n", pos, len(toks))
\t\t\tos.Exit(1)
\t\t}
\t\tnd := &nodes[root]
\t\tfor i := uint32(0); i < nd.KidCount; i++ {
\t\t\tv := kids[nd.KidStart+i]
\t\t\tif v < 0 {
\t\t\t\tti, tt := decodeLeaf(v)
\t\t\t\tfmt.Printf("%s\\t%d\\t%d\\n", TT_NAMES[tt], ti, ti+1)
\t\t\t} else {
\t\t\t\tk := &nodes[v]
\t\t\t\tfmt.Printf("%s\\t%d\\t%d\\n", RULE_NAMES[k.RuleId], k.TokStart, k.TokEnd)
\t\t\t}
\t\t}
\t\tfmt.Printf("total\\t0\\t%d\\n", pos)
\t\treturn
\t}
\troot := parse(tokenize(src))
\tif root < 0 || pos != len(toks) {
\t\tfmt.Fprintf(os.Stderr, "parse error (pos %d/%d)\\n", pos, len(toks))
\t\tos.Exit(1)
\t}
\tvar b strings.Builder
\twriteJSON(root, &b)
\tos.Stdout.WriteString(b.String())
}
`;
  },
};
