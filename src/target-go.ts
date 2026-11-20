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
import { type ParserIR, type RdRule, type PrattRule, type Step, type Bracket, type LexTok, type TplCfg, type NewlineCfg, type FirstSig, type LexFirstBytes, type LexIdPlan, type ArenaIdPlan } from './emit-portable.ts';
import { portableIR, buildLexDispatchPlan, lexTokFirstBytes, punctFirstBytes, buildLexIdPlan, buildLidPrefilter, buildArenaIdPlan, lidOf, kidOf, lidFlagTable, kidFlagTable, ttIdOf, ruleIdOf, TT_SKIP_PUNCT, isFirstGuardable, groupByPreserveOrder, tplHoleRules, tokenSetBits } from './emit-portable.ts';
import type { CstGrammar } from './types.ts';
import { defineTarget, type SharedAlgorithms } from './define-target.ts';
import { ATOM, COMPARISON, isNum, type BinOp, type Lowering, type MetaInt, type MkMeta, type R, type TokInt, type Ty } from './algo-ir.ts';

const J = (v: unknown) => JSON.stringify(v);

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
  return `var kindStr = []string{${kidsLit}}
var _lids = []string{${lidsLit}}
var _kidMap = map[string]uint16{}
var _lidMap = map[string]uint16{}
const _lidMaxLen = ${pf.maxByteLen}
var _lidFirstBits = [...]byte{${bitsLit}}

func init() {
\tfor i, k := range kindStr { _kidMap[k] = uint16(i) }
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
func tokKind(t *Tok) string { return kindStr[t.Kid] }
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

// One token at a dispatch site: the shared scanner, spliced in, says where it ends; the lexer
// records it.
function scanTok(ir: ParserIR, t: LexTok, shared: SharedAlgorithms, stateful: boolean, ids: LexIdPlan, rxTok: string | undefined, identLike: Set<string>): string {
  const name = t.name;
  const kid = kidOf(ids, name);
  const push = t.skip
    ? `if strings.ContainsAny(src[pos:e], "\\n\\r\\u2028\\u2029") { pendingNl = true }; `
    : `${stateful ? 'emit' : 'pushTok'}(pos, e, ${kid}, lidOf(src[pos:e])); `;
  // Identifier(-prefixed) token: fold a trailing non-ASCII ID_Continue run into the match
  // (caf|é → café), mirroring the interpreter's uniIdentContReY extension (emit-lexer.ts).
  const ext = identLike.has(name) ? 'e = lxExt(src, e); ' : '';
  const body = shared.scanInline(ir, name, { s: 'src', p: 'pos', out: 'e' });
  const scan = ['{', ...goBlock([...body, `if e >= 0 { ${ext}${push}pos = e; continue }`]), '}'];
  const lines = rxTok !== undefined && name === rxTok ? ['if !prevIsValue() {', ...goBlock(scan), '}'] : scan;
  return lines.map((l) => `\t\t${l}`).join('\n');
}

function buildLexCandidates(
  ir: ParserIR, shared: SharedAlgorithms, stateful: boolean, ids: LexIdPlan, rxTok: string | undefined,
  punctLine: (p: string) => string,
): { codes: string[]; firsts: (LexFirstBytes | null)[] } {
  const identLike = new Set(ir.identLike);
  const codes: string[] = [];
  const firsts: (LexFirstBytes | null)[] = [];
  for (const t of shared.scannedTokens(ir)) {
    codes.push(scanTok(ir, t, shared, stateful, ids, rxTok, identLike));
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

// Newline mode: every line break outside flow delimiters is a NEWLINE token spanning the break.
function newlinePartsGo(nl: NewlineCfg, pushFn: string, ids: LexIdPlan): { state: string; stateFrom: string; ws: string; hooks: string } {
  const kidNl = kidOf(ids, nl.token);
  const flowSets = `\t_flowOpen := map[string]bool{${nl.flowOpen.map((x) => `${J(x)}: true`).join(', ')}}
\t_flowClose := map[string]bool{${nl.flowClose.map((x) => `${J(x)}: true`).join(', ')}}
`;
  return {
    state: `\tflowDepth := 0
${flowSets}`,
    stateFrom: flowSets,
    ws: `\t\tif c == 32 || c == 9 || c == 11 || c == 12 { pos++; continue }
\t\tif c == 10 || c == 13 {
\t\t\ts := pos
\t\t\tpos++; if c == 13 && pos < n && src[pos] == 10 { pos++ }
\t\t\tif flowDepth == 0 { ${pushFn}(s, pos, ${kidNl}, 0) }
\t\t\tpendingNl = true
\t\t\tcontinue
\t\t}
\t\tif c >= 0x80 {
\t\t\t// LS/PS excluded: they fall to the unexpected-character panic, matching the interpreter.
\t\t\tr, w := utf8.DecodeRuneInString(src[pos:])
\t\t\tif isJsWs(r) && r != 0x2028 && r != 0x2029 { pos += w; continue }
\t\t}
`,
    hooks: `\t\tif kid == 0 && _flowOpen[_lids[lid]] { flowDepth++ } else if kid == 0 && _flowClose[_lids[lid]] { if flowDepth > 0 { flowDepth-- } }
`,
  };
}

function lexer(ir: ParserIR, ids: LexIdPlan, shared: SharedAlgorithms): string {
  const scanFns = shared.lexScan(ir);
  const scans = scanFns ? scanFns + '\n' : '';
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
  const { codes: lexCodes, firsts: lexFirsts } = buildLexCandidates(ir, shared, stateful, ids, rx?.regexToken, punctLine);
  const cascade = renderLexByteDispatchGo(lexCodes, lexFirsts, '\t');
  const goBoolArr = (name: string, flags: boolean[]) =>
    `var ${name} = []bool{${flags.map((b) => (b ? 'true' : 'false')).join(', ')}}`;
  const rxBitTables = rx ? `${goBoolArr('_divT', lidFlagTable(ids, rx.divisionTexts))}
${goBoolArr('_divK', kidFlagTable(ids, rx.divisionTypes))}
${goBoolArr('_rxT', lidFlagTable(ids, rx.regexTexts))}
${goBoolArr('_phK', lidFlagTable(ids, rx.parenHeadKw))}
${goBoolArr('_mem', lidFlagTable(ids, rx.memberAccess))}
${goBoolArr('_pav', lidFlagTable(ids, rx.postfixAfterValue))}
const kidIdent uint16 = ${kidOf(ids, rx.identToken)}
const lidLParen uint16 = ${lidOf(ids, '(')}
const lidRParen uint16 = ${lidOf(ids, ')')}
` : '';
  const tplLidConsts = tpl ? `const lidBraceOpen uint16 = ${lidOf(ids, tpl.braceOpen)}
const lidInterpClose uint16 = ${lidOf(ids, tpl.interpClose)}
` : '';
  const rxModuleConsts = `${rxBitTables}${tplLidConsts}`;
  const rxState = rx ? `\tprevLid, prevKid, bpLid := uint16(0), uint16(0), uint16(0)
\thasPrev, hasPrev2 := false, false
\tparenHead := []bool{}
\tlastClose, lastBang := false, false
\tprevIsValue := func() bool {
\t\tif !hasPrev { return false }
\t\tif _pav[prevLid] { return lastBang }
\t\tisExprKw := prevKid == kidIdent && _rxT[prevLid]
\t\tisParenHead := prevLid == lidRParen && lastClose
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
\t\tpanic(&LexError{Off: p, Msg: fmt.Sprintf("Unterminated template literal at offset %d", p)})
\t}
\t_ = scanTplSpan
` : '';
  const emitHooks = [
    rx ? `\t\tif lid == lidLParen {
\t\t\tisMember := hasPrev2 && _mem[bpLid]
\t\t\tparenHead = append(parenHead, !isMember && prevKid == kidIdent && _phK[prevLid])
\t\t} else if lid == lidRParen {
\t\t\tif len(parenHead) > 0 { lastClose = parenHead[len(parenHead)-1]; parenHead = parenHead[:len(parenHead)-1] } else { lastClose = false }
\t\t}
\t\tif _pav[lid] { lastBang = prevIsValue() }` : '',
    tpl ? `\t\tif len(templateStack) > 0 { if lid == lidBraceOpen { templateStack[len(templateStack)-1]++ } else if lid == lidInterpClose { templateStack[len(templateStack)-1]-- } }` : '',
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
\t\tisExprKw := prevKid == kidIdent && _rxT[prevLid]
\t\tisParenHead := prevLid == lidRParen && lastClose
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
\t\tpanic(&LexError{Off: p, Msg: fmt.Sprintf("Unterminated template literal at offset %d", p)})
\t}
\t_ = scanTplSpan
` : '';
  const emitRxOnly = rx ? `\temit := func(off, end int, kid, lid uint16) {
\t\tif lid == lidLParen {
\t\t\tisMember := hasPrev2 && _mem[bpLid]
\t\t\tparenHead = append(parenHead, !isMember && prevKid == kidIdent && _phK[prevLid])
\t\t} else if lid == lidRParen {
\t\t\tif len(parenHead) > 0 { lastClose = parenHead[len(parenHead)-1]; parenHead = parenHead[:len(parenHead)-1] } else { lastClose = false }
\t\t}
\t\tif _pav[lid] { lastBang = prevIsValue() }
\t\t*acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t\tbpLid = prevLid; hasPrev2 = hasPrev; prevKid = kid; prevLid = lid; hasPrev = true
\t}
\t_ = emit
` : '';
  const emitTplOnly = tpl ? `\temit := func(off, end int, kid, lid uint16) {
\t\tif len(templateStack) > 0 { if lid == lidBraceOpen { templateStack[len(templateStack)-1]++ } else if lid == lidInterpClose { templateStack[len(templateStack)-1]-- } }
\t\t*acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t}
\t_ = emit
` : '';
  const emitRxTpl = (rx && tpl) ? `\temit := func(off, end int, kid, lid uint16) {
\t\tif lid == lidLParen {
\t\t\tisMember := hasPrev2 && _mem[bpLid]
\t\t\tparenHead = append(parenHead, !isMember && prevKid == kidIdent && _phK[prevLid])
\t\t} else if lid == lidRParen {
\t\t\tif len(parenHead) > 0 { lastClose = parenHead[len(parenHead)-1]; parenHead = parenHead[:len(parenHead)-1] } else { lastClose = false }
\t\t}
\t\tif _pav[lid] { lastBang = prevIsValue() }
\t\tif len(templateStack) > 0 { if lid == lidBraceOpen { templateStack[len(templateStack)-1]++ } else if lid == lidInterpClose { templateStack[len(templateStack)-1]-- } }
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
  const identNameGo = ir.identToken;
  const identKidGo = identNameGo ? kidOf(ids, identNameGo) : 0;
  const lexGoHelpers = (identNameGo || ir.identLike.length) ? `func isJsWs(r rune) bool {
	if r == 0xA0 || r == 0x1680 || r == 0x2028 || r == 0x2029 || r == 0x202F || r == 0x205F || r == 0x3000 || r == 0xFEFF {
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}
// ID_Start ≈ L + Nl (gen-tm.ts's widened approximation); ID_Continue adds Nd/Mn/Mc/Pc + ZWNJ/ZWJ.
func isUniIdStart(r rune) bool { return r == '$' || r == '_' || unicode.IsLetter(r) || unicode.Is(unicode.Nl, r) }
func isUniIdContinue(r rune) bool {
	return isUniIdStart(r) || r == 0x200C || r == 0x200D || unicode.In(r, unicode.Nd, unicode.Mn, unicode.Mc, unicode.Pc)
}
func scanUniIdent(src string, pos int) (int, bool) {
	r, w := utf8.DecodeRuneInString(src[pos:])
	if !isUniIdStart(r) { return pos, false }
	e := pos + w
	for e < len(src) {
		r2, w2 := utf8.DecodeRuneInString(src[e:])
		if !isUniIdContinue(r2) { break }
		e += w2
	}
	return e, true
}
// Extend an identifier token that the ASCII pattern cut short at a non-ASCII
// ID_Continue char (caf|é → café), mirroring emit-lexer's uniIdentContReY extension.
func lxExt(src string, e int) int {
	if e >= len(src) || src[e] < 0x80 { return e }
	ee := e
	for ee < len(src) {
		r, w := utf8.DecodeRuneInString(src[ee:])
		if !isUniIdContinue(r) { break }
		ee += w
	}
	return ee
}
` : `func isJsWs(r rune) bool {
	if r == 0xA0 || r == 0x1680 || r == 0x2028 || r == 0x2029 || r == 0x202F || r == 0x205F || r == 0x3000 || r == 0xFEFF {
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}
`;
  const nlState = nl ? newlinePartsGo(nl, stateful ? 'emit' : 'pushTok', ids).state : '';
  const nlStateFrom = nl ? newlinePartsGo(nl, 'pushTok', ids).stateFrom : '';
  const nlWs = nl ? newlinePartsGo(nl, stateful ? 'emit' : 'pushTok', ids).ws : `\t\tif c == 32 || c == 9 || c == 11 || c == 12 { pos++; continue }
\t\tif c == 10 || c == 13 { pendingNl = true; pos++; continue }
\t\tif c >= 0x80 {
\t\t\tr, w := utf8.DecodeRuneInString(src[pos:])
\t\t\tif isJsWs(r) { if r == 0x2028 || r == 0x2029 { pendingNl = true }; pos += w; continue }
\t\t}
`;
  const pushHooks = nl && !stateful ? newlinePartsGo(nl, 'pushTok', ids).hooks : '';
  const pushTokFn = stateful ? '' : nl
    ? `\tpushTok := func(off, end int, kid, lid uint16) {
${pushHooks}\t\ttoks = append(toks, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t}
\t_ = pushTok
`
    : `\tpushTok := func(off, end int, kid, lid uint16) { toks = append(toks, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false }\n\t_ = pushTok\n`;
  const uniIdentPushGo = stateful ? 'emit' : 'pushTok';
  const uniIdentFallbackGo = identNameGo
    ? `\t\tif c >= 0x80 {
\t\t\tif e, ok := scanUniIdent(src, pos); ok {
\t\t\t\t${uniIdentPushGo}(pos, e, ${identKidGo}, lidOf(src[pos:e])); pos = e; continue
\t\t\t}
\t\t}
`
    : '';
  const loopPanicGo = `\t\tr, _ := utf8.DecodeRuneInString(src[pos:])
\t\tpanic(&LexError{Off: pos, Msg: fmt.Sprintf("Unexpected character at offset %d: '%c'", pos, r)})`;
  const pushTokAccFn = nl && !stateful
    ? `\tpushTok := func(off, end int, kid, lid uint16) {
${pushHooks}\t\t*acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false
\t}
\t_ = pushTok
`
    : `\tpushTok := func(off, end int, kid, lid uint16) { *acc = append(*acc, mkTok(off, end, pendingNl, kid, lid)); pendingNl = false }
\t_ = pushTok
`;
  const loopBody = `\t\tc := int(src[pos])
${nlWs}${tplDispatch}${cascade}
${uniIdentFallbackGo}${loopPanicGo}`;
  const idTables = renderIdTablesGo(ids);
  if (rxOnly) {
    return `${idTables}${lexGoHelpers}${rxModuleConsts}${scans}func lexFrom(src string, pos int, pendingNl bool, prevLid, prevKid, bpLid uint16, hasPrev, hasPrev2 bool, parenHead []bool, lastClose, lastBang bool, acc *[]Tok, limit int) (int, bool, uint16, uint16, uint16, bool, bool, []bool, bool, bool) {
\tn := len(src)
${rxStateFrom}${emitRxOnly}\tbase := len(*acc)
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
    return `${idTables}${lexGoHelpers}${rxModuleConsts}${scans}func lexFrom(src string, pos int, pendingNl bool, templateStack []int, acc *[]Tok, limit int) (int, bool, []int) {
\tn := len(src)
${tplStateFrom}${emitTplOnly}\tbase := len(*acc)
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
    return `${idTables}${lexGoHelpers}${rxModuleConsts}${scans}func lexFrom(src string, pos int, pendingNl bool, prevLid, prevKid, bpLid uint16, hasPrev, hasPrev2 bool, parenHead []bool, lastClose, lastBang bool, templateStack []int, acc *[]Tok, limit int) (int, bool, uint16, uint16, uint16, bool, bool, []bool, bool, bool, []int) {
\tn := len(src)
${rxStateFrom}${tplStateFrom}${emitRxTpl}\tbase := len(*acc)
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
    return `${idTables}${lexGoHelpers}${rxModuleConsts}${scans}func lex(src string) []Tok {
\tvar toks []Tok
\tn := len(src)
\tpos := 0
\tpendingNl := false
\t_ = pendingNl
${rxState}${tplState}${nlState}${emitFn}${pushTokFn}\tfor pos < n {
${loopBody}
\t}
\treturn toks
}`;
  }
  if (newlineOnly) {
    return `${idTables}${lexGoHelpers}${scans}func lexFrom(src string, pos int, pendingNl bool, flowDepth int, acc *[]Tok, limit int) (int, bool, int) {
\tn := len(src)
${nlStateFrom}${pushTokAccFn}\tbase := len(*acc)
\tfor pos < n && (limit <= 0 || len(*acc)-base < limit) {
${loopBody}
\t}
\treturn pos, pendingNl, flowDepth
}
func lex(src string) []Tok {
\tvar out []Tok
\tlexFrom(src, 0, false, 0, &out, 0)
\treturn out
}`;
  }
  return `${idTables}${lexGoHelpers}${scans}func lexFrom(src string, pos int, pendingNl bool, acc *[]Tok, limit int) (int, bool) {
\tn := len(src)
${pushTokAccFn}\tbase := len(*acc)
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

// A composed '>'-led literal (LexIdPlan.gtComps): only a lookahead operand, so never a tree leaf.
function gtCompLit(ids: LexIdPlan, s: { value: string; ttype: string }): boolean {
  if (!ids.gtComps.includes(s.value)) return false;
  if (s.ttype !== '$punct') throw new Error(`goTarget: composed literal ${JSON.stringify(s.value)} must be punctuation`);
  return true;
}
// The binary operator read at p.pos (t = p.toks[p.pos]): opLid, its token count opN and (withEnd)
// its end offset opEnd. A '>' read counts the tokens it inspected toward maxLook.
function gtOpRead(ids: LexIdPlan, withEnd: boolean): string {
  if (ids.gtComps.length === 0) return withEnd ? `\t\topLid, opN, opEnd := t.Lid, 1, t.End` : `\t\topLid, opN := t.Lid, 1`;
  return `\t\topLid, opN, ${withEnd ? 'opEnd' : '_'} := gtOp(p.toks, p.pos)
\t\tif t.Lid == ${lidOf(ids, '>')} { if e := p.pos + opN + 1; e > p.maxLook { p.maxLook = e } }`;
}
// '>'-led composite operators (LexIdPlan.gtComps): the lexer scans every '>' alone. gtOp reads the
// operator at ts[i]: a lone '>' extends over each adjacent single-character punct token after it
// while the text stays a composite (gtStep: prefix lid × next character lid → composite lid).
// leafEnd is a leaf's end offset: an operator leaf at a '>' spans the composite read there.
function gtRuntimeGo(ids: LexIdPlan, ar: ArenaIdPlan): string {
  if (ids.gtComps.length === 0) {
    return `func gtOp(ts []Tok, i int) (uint16, int, uint32) { return ts[i].Lid, 1, ts[i].End }
func leafEnd(ts []Tok, ti uint32, tt uint8) uint32 { _ = tt; return ts[ti].End }`;
  }
  const arms = ids.gtComps.map((c) => {
    const a = lidOf(ids, c.slice(0, -1)), b = lidOf(ids, c.slice(-1)), r = lidOf(ids, c);
    if (a === 0 || b === 0 || r === 0) throw new Error(`goTarget: composite ${JSON.stringify(c)} needs lids for its prefix and last character`);
    return `\tcase a == ${a} && b == ${b}: return ${r}`;
  });
  return `func gtStep(a, b uint16) uint16 {
\tswitch {
${arms.join('\n')}
\t}
\treturn 0
}
func gtOp(ts []Tok, i int) (lid uint16, n int, end uint32) {
\tt := &ts[i]
\tlid, n, end = t.Lid, 1, t.End
\tif lid != ${lidOf(ids, '>')} { return }
\tfor j := i + 1; j < len(ts); j++ {
\t\tu := &ts[j]
\t\tif u.Kid != 0 || u.Off != end || u.End != end+1 { break }
\t\tc := gtStep(lid, u.Lid)
\t\tif c == 0 { break }
\t\tlid, n, end = c, n+1, u.End
\t}
\treturn
}
func leafEnd(ts []Tok, ti uint32, tt uint8) uint32 {
\tif tt == ${ttIdOf(ar, '$operator')} && ts[ti].Lid == ${lidOf(ids, '>')} { _, _, e := gtOp(ts, int(ti)); return e }
\treturn ts[ti].End
}`;
}

function stepCond(s: Step, ids: LexIdPlan, ar: ArenaIdPlan): string {
  switch (s.t) {
    case 'lit': return gtCompLit(ids, s) ? `p.matchComp(${lidOf(ids, s.value)})` : `p.matchLit(${lidOf(ids, s.value)}, ${ttIdOf(ar, s.ttype)})`;
    case 'tok': return `p.matchTok(${kidOf(ids, s.name)}, ${ttIdOf(ar, s.name)})`;
    case 'rule': return `p.callRule(p.parse${s.name}())`;
    case 'ruleBp': return `p.callRule(p.bp_${s.name}(${s.bp}))`;
    case 'star': return `p.star(func() bool { return ${stepCond(s.step, ids, ar)} })`;
    case 'opt': return `p.opt(func() bool { return ${s.steps.map((x) => stepCond(x, ids, ar)).join(' && ')} })`;
    case 'sep': return `p.sepBy(func() bool { return ${stepCond(s.elem, ids, ar)} }, ${lidOf(ids, s.delim)})`;
    case 'altlit': return `p.altLit([]struct{ Lid uint16; TtId uint8 }{${s.opts.map((o) => `{${lidOf(ids, o.value)}, ${ttIdOf(ar, o.ttype)}}`).join(', ')}})`;
    case 'alt': {
      if (s.predictive) return `func() bool { ${predAltBody(s.branches, ids, s.firsts, ar)} }()`;
      const firsts = s.firsts ?? [];
      const nAlts = s.branches.length;
      const needPeek = s.branches.some((_, i) => isGuardable(firsts[i] ?? null, nAlts));
      const peekInit = needPeek ? `_ft := p.peek(); ` : '';
      const tries = s.branches.map((br, i) => {
        const body = `{ save := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids); if ${br.length ? br.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'} { return true }; p.pos = save; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb] }`;
        const f = firsts[i] ?? null;
        if (!isGuardable(f, nAlts)) return body;
        return `if _ft != nil && ${firstCond(f, '_ft', ids)} ${body}`;
      }).join('; ');
      return `func() bool { ${peekInit}${tries}; return false }()`;
    }
    case 'not': return `func() bool { save := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids); m := ${s.steps.length ? s.steps.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'}; p.pos = save; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]; return !m }()`;
    case 'ahead': return `p.ahead(${s.set}, ${s.is})`;
    case 'seq': return `(${s.steps.length ? s.steps.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'})`;
    case 'sameLine': return `func() bool { t := p.peek(); return t != nil && !t.Nl }()`;
    case 'suppress': return `func() bool { p.suppressNext = map[uint16]bool{${s.connectors.map((c) => `${lidOf(ids, c)}: true`).join(', ')}}; _r := (${s.steps.length ? s.steps.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'}); p.suppressNext = nil; return _r }()`;
  }
}

function predAltBody(branches: Step[][], ids: LexIdPlan, firsts: FirstSig[] | undefined, ar: ArenaIdPlan): string {
  // FIRST dispatch still only tries the matching arm; on half-failure restore like non-pred alt.
  const arms = branches.map((br, i) => {
    const steps = br.length ? br.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true';
    return `if ${firstCond(firsts![i], 't', ids)} { save := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids); if ${steps} { return true }; p.pos = save; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb] }`;
  }).join(' else ');
  return `t := p.peek(); if t == nil { return false }; ${arms}; return false`;
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
    if (step.t === 'rule') return { kind: 'A', topOneBody: `\treturn p.parse${step.name}()` };
    if (step.t === 'alt') {
      for (const br of step.branches) {
        if (br.length !== 1 || br[0].t !== 'rule') return null;
      }
      const tries = step.branches.map((br) => {
        const name = (br[0] as { t: 'rule'; name: string }).name;
        return `\t{ sp := p.pos; n := p.parse${name}(); if n >= 0 { return n }; p.pos = sp }`;
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
    const arm = (steps: Step[], i: number) => `\t${i === 0 ? 'if' : 'else if'} ${firstCond(r.altFirst[i], 't', ids)} { if ${steps.map((x) => stepCond(x, ids, ar)).join(' && ')} { return p.finish(${ruleIdOf(ar, r.cstName)}, sb, p.offAt(save), save) } }`;
    return `func (p *engine) parse${r.name}() int32 {
\tsave := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids)
\tt := p.peek(); if t == nil { return -1 }
${r.alts.map(arm).join(' ')}
\tp.pos = save; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]
\treturn -1
}`;
  }
  const alt = (steps: Step[], i: number) => {
    const cond = steps.map((x) => stepCond(x, ids, ar)).join(' && ');
    const restore = `p.pos = save; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]`;
    if (!isGuardable(r.altFirst[i], r.alts.length)) {
      return `\tif ${cond} { return p.finish(${ruleIdOf(ar, r.cstName)}, sb, p.offAt(save), save) }
\t${restore}`;
    }
    return `\tif _ft != nil && ${firstCond(r.altFirst[i], '_ft', ids)} {
\t\tif ${cond} { return p.finish(${ruleIdOf(ar, r.cstName)}, sb, p.offAt(save), save) }
\t\t${restore}
\t}`;
  };
  const needPeek = r.alts.some((_, i) => isGuardable(r.altFirst[i], r.alts.length));
  return `func (p *engine) parse${r.name}() int32 {
\tsave := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids)
${needPeek ? '\t_ft := p.peek()\n' : ''}${r.alts.map(alt).join('\n')}
\treturn -1
}`;
}

/** Entry rule that records per-top-kid EntryMeta (+ Node.ext oracle) via parseTopOne (shape A). */
function rdEntryWithReuseA(r: RdRule, plan: ReusePlanA, ar: ArenaIdPlan): string {
  return `type EntryMeta struct { TokStart, TokEnd, Ext, Off, End, KidStart, KidCount int }
func (p *engine) parseTopOne() int32 {
${plan.topOneBody}
}
func (p *engine) parse${r.name}() int32 {
\tsave := p.pos; sb := len(p.scratch)
\tcapHint := (len(p.toks) - p.pos) / 2
\tif capHint < 8 { capHint = 8 }
\tlocalE := make([]EntryMeta, 0, capHint)
\tfor {
\t\tsp := p.pos
\t\tp.maxLook = 0
\t\tn := p.parseTopOne()
\t\tif n < 0 { p.pos = sp; break }
\t\text := p.nodes[n].TokEnd
\t\tif uint32(p.maxLook) > ext { ext = uint32(p.maxLook) }
\t\tp.nodes[n].Ext = ext // CST oracle for validate assert; reuse decisions read p.entries
\t\tlocalE = append(localE, EntryMeta{int(p.nodes[n].TokStart), int(p.nodes[n].TokEnd), int(ext), int(p.nodes[n].Offset), int(p.nodes[n].End), len(p.scratch) - sb, 1})
\t\tp.scratch = append(p.scratch, n)
\t}
\tp.entries = localE
\treturn p.finish(${ruleIdOf(ar, r.cstName)}, sb, p.offAt(save), save)
}`;
}

function rdEntryWithReuseB(r: RdRule, plan: ReusePlanB, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const headFn = plan.hasHead && plan.headRule
    ? `func (p *engine) parseHeadSeg(sb int) (Seg, EntryMeta, bool) {
\tp.maxLook = 0
\tbefore := len(p.scratch)
\tp.opt(func() bool { return p.callRule(p.parse${plan.headRule}()) })
\tif len(p.scratch) == before { return Seg{}, EntryMeta{}, false }
\tn := p.scratch[before]
\text := p.nodes[n].TokEnd
\tif uint32(p.maxLook) > ext { ext = uint32(p.maxLook) }
\tmeta := EntryMeta{int(p.nodes[n].TokStart), int(p.nodes[n].TokEnd), int(ext), int(p.nodes[n].Offset), int(p.nodes[n].End), before - sb, 1}
\treturn Seg{KidStart: before - sb, KidCount: 1, TokStart: int(p.nodes[n].TokStart), TokEnd: int(p.nodes[n].TokEnd), Ext: int(ext)}, meta, true
}
`
    : '';
  const headBlock = plan.hasHead && plan.headRule
    ? `\tif h, m, ok := p.parseHeadSeg(sb); ok { local = append(local, h); localE = append(localE, m) }
`
    : '';
  return `type Seg struct { KidStart, KidCount, TokStart, TokEnd, Ext int }
type EntryMeta struct { TokStart, TokEnd, Ext, Off, End, KidStart, KidCount int }
${headFn}func (p *engine) parseLoopSeg(sb int) (Seg, EntryMeta, bool) {
\tsp := p.pos; before := len(p.scratch); nb := len(p.nodes); kb := len(p.kids)
\tp.maxLook = 0
\tif !p.matchTok(${kidOf(ids, plan.loopTok)}, ${ttIdOf(ar, plan.loopTok)}) {
\t\tp.pos = sp; p.scratch = p.scratch[:before]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]
\t\treturn Seg{}, EntryMeta{}, false
\t}
\tp.opt(func() bool { return p.callRule(p.parse${plan.loopRule}()) })
\tleaf := p.scratch[before]
\tvar tokStart, tokEnd uint32
\tvar off, end uint32
\tif leaf < 0 {
\t\tti, _ := decodeLeaf(leaf)
\t\ttokStart = ti
\t\ttokEnd = ti + 1
\t\toff = p.toks[ti].Off
\t\tend = p.toks[ti].End
\t} else {
\t\ttokStart = p.nodes[leaf].TokStart
\t\ttokEnd = p.nodes[leaf].TokEnd
\t\toff = p.nodes[leaf].Offset
\t\tend = p.nodes[leaf].End
\t}
\tcount := len(p.scratch) - before
\tif count > 1 {
\t\tsecond := p.scratch[before+1]
\t\tif second < 0 {
\t\t\tti, _ := decodeLeaf(second)
\t\t\ttokEnd = ti + 1
\t\t\tend = p.toks[ti].End
\t\t} else {
\t\t\ttokEnd = p.nodes[second].TokEnd
\t\t\tend = p.nodes[second].End
\t\t}
\t}
\text := tokEnd
\tif uint32(p.maxLook) > ext { ext = uint32(p.maxLook) }
\tmeta := EntryMeta{int(tokStart), int(tokEnd), int(ext), int(off), int(end), before - sb, count}
\treturn Seg{KidStart: before - sb, KidCount: count, TokStart: int(tokStart), TokEnd: int(tokEnd), Ext: int(ext)}, meta, true
}
func (p *engine) parse${r.name}() int32 {
\tsave := p.pos; sb := len(p.scratch)
\tcapHint := (len(p.toks) - p.pos) / 2
\tif capHint < 8 { capHint = 8 }
\tlocal := make([]Seg, 0, capHint)
\tlocalE := make([]EntryMeta, 0, capHint)
${headBlock}\tfor {
\t\tif seg, m, ok := p.parseLoopSeg(sb); ok { local = append(local, seg); localE = append(localE, m) } else { break }
\t}
\tp.segs = local
\tp.entries = localE
\treturn p.finish(${ruleIdOf(ar, r.cstName)}, sb, p.offAt(save), save)
}`;
}

function rdEntryWithReuse(r: RdRule, plan: ReusePlan, ids: LexIdPlan, ar: ArenaIdPlan): string {
  return plan.kind === 'A' ? rdEntryWithReuseA(r, plan, ar) : rdEntryWithReuseB(r, plan, ids, ar);
}

function prattRule(r: PrattRule, tpl: TplCfg | null, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const tplNud = r.nudTplHole !== undefined
    ? `\tif t.Kid == ${kidOf(ids, '$templateHead')} {
\t\tnode := p.matchTemplate_${r.nudTplHole}()
\t\tif node < 0 { return -1 }
\t\tsb := len(p.scratch); p.scratch = append(p.scratch, node)
\t\treturn p.finish(${ruleIdOf(ar, r.cstName)}, sb, int(p.nodes[node].Offset), int(p.nodes[node].TokStart))
\t}\n`
    : '';
  const bin = r.binary.map((b) => `${lidOf(ids, b.op)}: {${b.lbp}, ${b.rbp}, ${b.requireTarget}, ${b.noUnaryLhs}}`).join(', ');
  const pre = r.prefix.map((p) => `${lidOf(ids, p.op)}: {${p.rbp}, ${p.requireTarget}, ${p.form}}`).join(', ');
  const atoms = r.nudToks.map((k) => `${kidOf(ids, k)}: true`).join(', ');
  const bracketNudBody = (b: Bracket, closes: boolean) => `{
\t\tsave := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids)
\t\tif ${b.steps.map((x) => stepCond(x, ids, ar)).join(' && ')} { ${closes ? 'pt = true; ' : ''}return p.finish(${ruleIdOf(ar, r.cstName)}, sb, int(t.Off), save) }
\t\tp.pos = save; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]
\t}`;
  const bracketNudSwitch = (() => {
    if (r.nudBrackets.length === 0) return '';
    const groups = groupByPreserveOrder(r.nudBrackets, (b) => lidOf(ids, b.first));
    return `\tswitch t.Lid {
${groups.map((g) => `\tcase ${g.key}:
${g.members.map(({ item: b, index: bi }) => `\t\t${bracketNudBody(b, r.nudBracketClosesTail[bi]!)}`).join('\n')}`).join('\n')}
\t}`;
  })();
  const ledGuard = (accessTail: boolean, lbp: number | null, sameLine: boolean, nll: string[] | null, lid: number) => {
    const parts: string[] = [];
    if (accessTail) parts.push('!tailClosed');
    if (lbp !== null) parts.push(`${lbp} > minBp`);
    if (sameLine) parts.push('!t.Nl');
    if (nll) parts.push(`!_inW([]string{${nll.map(J).join(', ')}}, p.headLeafText(left))`);
    parts.push(`!p.suppressCur[${lid}]`);
    return parts.join(' && ');
  };
  const ledBody = (b: Bracket, form: number, closes: boolean) => `{
\t\t\tledSave := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids)
\t\t\tp.scratch = append(p.scratch, left)
\t\t\tif ${b.steps.map((x) => stepCond(x, ids, ar)).join(' && ')} { left = p.finish(${ruleIdOf(ar, r.cstName)}, sb, int(p.nodes[left].Offset), int(p.nodes[left].TokStart)); form = ${form};${closes ? ' tailClosed = true;' : ''} continue LedLoop }
\t\t\tp.pos = ledSave; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]
\t\t}`;
  const ledSwitch = (() => {
    if (r.leds.length === 0) return '';
    const groups = groupByPreserveOrder(r.leds, (b) => lidOf(ids, b.first));
    return `\t\tswitch t.Lid {
${groups.map((g) => {
  const lid = g.key as number;
  const arms = g.members.map(({ item: b, index: i }) =>
    `\t\t\tif ${ledGuard(r.ledAccessTail[i]!, r.ledLbp[i]!, r.ledSameLine[i]!, r.ledNotLeftLeaf[i]!, lid)} ${ledBody(b, r.ledForm[i]!, r.ledClosesTail[i]!)}`);
  return `\t\tcase ${lid}:\n${arms.join('\n')}`;
}).join('\n')}
\t\t}`;
  })();
  const postfixTokSwitch = (() => {
    if (r.postfixToks.length === 0) return '';
    const groups = groupByPreserveOrder(r.postfixToks, (tok) => kidOf(ids, tok));
    const tplPart = r.postfixTplHole !== undefined ? `
\t\tif !tailClosed && t.Kid == ${kidOf(ids, '$templateHead')} {
\t\t\tnode := p.matchTemplate_${r.postfixTplHole}()
\t\t\tif node >= 0 { sb := len(p.scratch); p.scratch = append(p.scratch, left, node); left = p.finish(${ruleIdOf(ar, r.cstName)}, sb, int(p.nodes[left].Offset), int(p.nodes[left].TokStart)); form = 0; continue LedLoop }
\t\t}` : '';
    return `\t\tswitch t.Kid {
${groups.map((g) => `\t\tcase ${g.key}:
\t\t\tif !tailClosed {
\t\t\t\tsb := len(p.scratch); p.scratch = append(p.scratch, left); p.pushLeaf(uint8(t.Kid), uint32(p.pos)); p.pos++
\t\t\t\tleft = p.finish(${ruleIdOf(ar, r.cstName)}, sb, int(p.nodes[left].Offset), int(p.nodes[left].TokStart)); form = 0; continue LedLoop
\t\t\t}`).join('\n')}
\t\t}${tplPart}`;
  })();
  const post = r.postfix.map((p) => `${lidOf(ids, p.op)}: {${p.lbp}, ${p.requireTarget}}`).join(', ');
  return `var bin_${r.name} = map[uint16]bp{${bin}}
var pre_${r.name} = map[uint16]preOp{${pre}}
var post_${r.name} = map[uint16]postOp{${post}}
var atom_${r.name} = map[uint16]bool{${atoms}}
func (p *engine) parse${r.name}() int32 {
\tprev := p.suppressCur
\tp.suppressCur = p.suppressNext
\tp.suppressNext = nil
\tr := p.bp_${r.name}(0)
\tp.suppressCur = prev
\treturn r
}
func (p *engine) bp_${r.name}(minBp int) int32 {
\tleft := p.nud_${r.name}(minBp)
\tif left < 0 { return -1 }
\tform := p.form
\tif p.capped { return left }
\ttailClosed := p.tail
${(r.leds.length > 0 || r.postfixToks.length > 0) ? 'LedLoop:\n' : ''}\tfor {
\t\tt := p.peek()
\t\tif t == nil { break }
${ledSwitch}
${postfixTokSwitch}
\t\tif post, ok := post_${r.name}[t.Lid]; ok && !tailClosed && post.lbp > minBp${r.postfixSameLine ? ' && !t.Nl' : ''} {
\t\t\tif post.tgt && form != 0 { return -1 }
\t\t\tsb := len(p.scratch); p.scratch = append(p.scratch, left); p.pushLeaf(${ttIdOf(ar, '$operator')}, uint32(p.pos)); p.pos++; tailClosed = true
\t\t\tleft = p.finish(${ruleIdOf(ar, r.cstName)}, sb, int(p.nodes[left].Offset), int(p.nodes[left].TokStart)); form = 1; continue
\t\t}
${gtOpRead(ids, false)}
\t\tinfo, ok := bin_${r.name}[opLid]
\t\tif !ok || info.lbp <= minBp { break }
\t\tif info.tgt && form != 0 || info.noUnary && form == 2 { return -1 }
\t\tledSave := p.pos; sb := len(p.scratch)
\t\tp.scratch = append(p.scratch, left); p.pushLeaf(${ttIdOf(ar, '$operator')}, uint32(p.pos))
\t\tp.pos += opN
\t\trhs := p.bp_${r.name}(info.rbp)
\t\tif rhs < 0 { p.pos = ledSave; p.scratch = p.scratch[:sb]; break }
\t\tp.scratch = append(p.scratch, rhs)
\t\tleft = p.finish(${ruleIdOf(ar, r.cstName)}, sb, int(p.nodes[left].Offset), int(p.nodes[left].TokStart))
\t\tform = 1; tailClosed = true
\t}
\tp.form = form
\treturn left
}
func (p *engine) nud_${r.name}(minBp int) int32 {
\tp.capped = false
\tt := p.peek()
\tif t == nil { return -1 }
${r.nudCapped.map((c) => `\tif minBp < ${c.capBp} { save := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids); if ${c.steps.length ? c.steps.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'} { p.capped = true; p.form = 0; return p.finish(${ruleIdOf(ar, r.cstName)}, sb, p.offAt(save), save) }; p.pos = save; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb] }`).join('\n')}
\tpf, pt := uint8(0), false
\t_r := func() int32 {   // non-capped: a sub-parse may leave p.capped set; force it false after
${tplNud}\tif atom_${r.name}[t.Kid] {
\t\tsb := len(p.scratch); ts := p.pos; p.pushLeaf(uint8(t.Kid), uint32(p.pos)); p.pos++
\t\treturn p.finish(${ruleIdOf(ar, r.cstName)}, sb, int(t.Off), ts)
\t}
${bracketNudSwitch}
\tif pbp, ok := pre_${r.name}[t.Lid]; ok {
\t\tsave := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids)
\t\tp.pushLeaf(${ttIdOf(ar, '$operator')}, uint32(p.pos)); p.pos++
\t\toperand := p.bp_${r.name}(pbp.rbp)
\t\tif operand < 0 || pbp.tgt && p.form != 0 { p.pos = save; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]; return -1 }
\t\tp.scratch = append(p.scratch, operand)
\t\tpf, pt = pbp.form, true
\t\treturn p.finish(${ruleIdOf(ar, r.cstName)}, sb, int(t.Off), save)
\t}
${r.nudSeqs.map((seq, si) => `\t{ save := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids); if ${seq.length ? seq.map((x) => stepCond(x, ids, ar)).join(' && ') : 'true'} { ${r.nudSeqClosesTail[si] ? 'pt = true; ' : ''}return p.finish(${ruleIdOf(ar, r.cstName)}, sb, p.offAt(save), save) }; p.pos = save; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb] }`).join('\n')}
\treturn -1
\t}()
\tp.capped = false
\tp.form = pf
\tp.tail = pt
\treturn _r
}`;
}

const goEditBody = '\td.text, d.toks, relexed = relexEdits(oldText, oldToks, edits)';

function docEditBlockGo(ir: ParserIR, shared: SharedAlgorithms): string {
  const topReuse = topReusePlan(ir);
  const shapeA = topReuse?.kind === 'A';
  const shapeB = topReuse?.kind === 'B';
  const hasHeadB = !!(shapeB && topReuse.kind === 'B' && topReuse.hasHead);
  const relexFamily = `\n// ---- relex family: generated from src/relex-family.ts (shared by the TS / Go / Rust targets) ----\n${shared.relexFamily(ir)}\n`;
  const editBody = goEditBody;
  const freshMeta = 'scanMeta(d.text)';
  const parseFreshRetry = `\td.root = p.parse(d.text, toksFromMeta(d.text, d.toks))
\tif d.root < 0 { d.toks = ${freshMeta}; d.root = p.parse(d.text, toksFromMeta(d.text, d.toks)) }`;
  const reuseFns = topReuse ? `
func (p *engine) countLive(id int32) int {
	if id < 0 { return 0 }
	n := 1
	nd := &p.nodes[id]
	for i := uint32(0); i < nd.KidCount; i++ {
		cid := p.kids[nd.KidStart+i]
		if cid >= 0 { n += p.countLive(cid) }
	}
	return n
}
func (p *engine) shouldReclaim(root int32) bool {
	if root < 0 || p.arenaBaseline == 0 { return false }
	live := p.countLive(root)
	lim := p.arenaBaseline
	if live > lim { lim = live }
	return len(p.nodes) > arenaCompactK*lim
}
func (p *engine) shiftSubtree(id int32, byteDelta, tokDelta int) {
	if id < 0 { panic("shiftSubtree on leaf") }
	nd := &p.nodes[id]
	nd.Offset = uint32(int32(nd.Offset) + int32(byteDelta))
	nd.End = uint32(int32(nd.End) + int32(byteDelta))
	nd.TokStart = uint32(int32(nd.TokStart) + int32(tokDelta))
	nd.TokEnd = uint32(int32(nd.TokEnd) + int32(tokDelta))
	nd.Ext = uint32(int32(nd.Ext) + int32(tokDelta))
	for i := uint32(0); i < nd.KidCount; i++ {
		slot := nd.KidStart + i
		cid := p.kids[slot]
		if cid < 0 {
			ti, tt := decodeLeaf(cid)
			p.kids[slot] = encodeLeaf(uint32(int32(ti)+int32(tokDelta)), tt)
		} else {
			p.shiftSubtree(cid, byteDelta, tokDelta)
		}
	}
}
// tailRel is, per suffix entry, the tokens from its start to the old end. A suffix entry is
// adopted at pos when the new stream has that many tokens left.
func tailRel(oldN int, suffixMeta []EntryMeta) ([]int, int) {
	rel := make([]int, len(suffixMeta))
	minRel := -1
	for i, m := range suffixMeta {
		rel[i] = oldN - m.TokStart
		if minRel < 0 || rel[i] < minRel { minRel = rel[i] }
	}
	return rel, minRel
}
func shiftEntryMeta(m *EntryMeta, byteDelta, tokDelta int) {
	m.TokStart += tokDelta
	m.TokEnd += tokDelta
	m.Ext += tokDelta
	m.Off += byteDelta
	m.End += byteDelta
}
${shapeA ? `func (p *engine) assertEntriesVsNodes(oldEntries []EntryMeta, oldRoot int32) {
	old := p.nodes[oldRoot]
	if len(oldEntries) != int(old.KidCount) {
		panic("entry count vs root kids: " + fmt.Sprintf("%d", len(oldEntries)) + " vs " + fmt.Sprintf("%d", int(old.KidCount)))
	}
	for i, e := range oldEntries {
		nd := p.nodes[p.kids[old.KidStart+uint32(i)]]
		if e.TokStart != int(nd.TokStart) { panic("tok_start entry " + fmt.Sprintf("%d", i)) }
		if e.TokEnd != int(nd.TokEnd) { panic("tok_end entry " + fmt.Sprintf("%d", i)) }
		if e.Ext != int(nd.Ext) { panic("ext entry " + fmt.Sprintf("%d", i)) }
		if e.Off != int(nd.Offset) { panic("off entry " + fmt.Sprintf("%d", i)) }
		if e.End != int(nd.End) { panic("end entry " + fmt.Sprintf("%d", i)) }
	}
}
func (p *engine) tryReuseTop(oldRoot int32, oldEntries []EntryMeta, newText string, newMeta []alignMeta, byteDelta, oldN, prefix, suffix int, validate bool) (int32, int) {
	if oldRoot < 0 { return -1, 0 }
	if validate { p.assertEntriesVsNodes(oldEntries, oldRoot) }
	old := p.nodes[oldRoot]
	oldKids := make([]int32, old.KidCount)
	for i := uint32(0); i < old.KidCount; i++ { oldKids[i] = p.kids[old.KidStart+i] }
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
	rel, minRel := tailRel(oldN, suffixMeta)
	p.src = newText
	p.toks = toksFromMeta(newText, newMeta)
	if prefixLen > 0 { p.pos = prefixMeta[prefixLen-1].TokEnd } else { p.pos = 0 }
	p.scratch = p.scratch[:0]
	mid := make([]int32, 0)
	midMeta := make([]EntryMeta, 0)
	finishHit := func(adoptFrom int) (int32, int) {
		adopted := suffixCand[adoptFrom:]
		tokDelta := 0
		if len(adopted) > 0 {
			s := suffixMeta[adoptFrom].TokStart
			tokDelta = p.pos - s
		}
		for _, s := range adopted { p.shiftSubtree(s, byteDelta, tokDelta) }
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
		kidStart := len(p.kids)
		p.kids = append(p.kids, children...)
		p.nodes = append(p.nodes, Node{RuleId: old.RuleId, KidStart: uint32(kidStart), KidCount: uint32(len(children)), Offset: uint32(off), End: uint32(end), TokStart: uint32(tokStart), TokEnd: uint32(tokEnd)})
		p.entries = newEntries
		p.pos = len(p.toks)
		return int32(len(p.nodes) - 1), len(prefixKids) + len(adopted)
	}
	tryHit := func() (int32, int, bool) {
		if len(p.toks)-p.pos > suffix { return -1, 0, false }
		if len(suffixCand) == 0 {
			if p.pos == len(p.toks) { r, n := finishHit(0); return r, n, true }
			return -1, 0, false
		}
		for i := range suffixMeta {
			if rel[i] == len(p.toks)-p.pos { r, n := finishHit(i); return r, n, true }
		}
		return -1, 0, false
	}
	passed := func() bool { return len(suffixCand) > 0 && minRel >= 0 && len(p.toks)-p.pos < minRel }
	if r, n, ok := tryHit(); ok { return r, n }
	if passed() { return -1, 0 }
	for {
		if p.pos >= len(p.toks) {
			if len(suffixCand) == 0 && p.pos == len(p.toks) { return finishHit(0) }
			if r, n, ok := tryHit(); ok { return r, n }
			return -1, 0
		}
		p.maxLook = 0
		sp := p.pos
		n := p.parseTopOne()
		if n < 0 { p.pos = sp; return -1, 0 }
		ext := p.nodes[n].TokEnd
		if uint32(p.maxLook) > ext { ext = uint32(p.maxLook) }
		p.nodes[n].Ext = ext
		midMeta = append(midMeta, EntryMeta{int(p.nodes[n].TokStart), int(p.nodes[n].TokEnd), int(ext), int(p.nodes[n].Offset), int(p.nodes[n].End), 0, 1})
		mid = append(mid, n)
		if r, rn, ok := tryHit(); ok { return r, rn }
		if passed() { return -1, 0 }
	}
}
` : ''}${shapeB ? `func (p *engine) assertEntriesVsSegs(oldEntries []EntryMeta, oldSegs []Seg, oldRoot int32) {
	if len(oldEntries) != len(oldSegs) {
		panic("entry count vs segs: " + fmt.Sprintf("%d", len(oldEntries)) + " vs " + fmt.Sprintf("%d", len(oldSegs)))
	}
	old := p.nodes[oldRoot]
	for i, e := range oldEntries {
		s := oldSegs[i]
		if e.TokStart != s.TokStart { panic("tok_start entry " + fmt.Sprintf("%d", i)) }
		if e.TokEnd != s.TokEnd { panic("tok_end entry " + fmt.Sprintf("%d", i)) }
		if e.Ext != s.Ext { panic("ext entry " + fmt.Sprintf("%d", i)) }
		if e.KidStart != s.KidStart { panic("kid_start entry " + fmt.Sprintf("%d", i)) }
		if e.KidCount != s.KidCount { panic("kid_count entry " + fmt.Sprintf("%d", i)) }
		first := p.kids[old.KidStart+uint32(s.KidStart)]
		last := p.kids[old.KidStart+uint32(s.KidStart+s.KidCount-1)]
		if first >= 0 {
			if e.Off != int(p.nodes[first].Offset) { panic("off entry " + fmt.Sprintf("%d", i)) }
		}
		if last >= 0 {
			if e.End != int(p.nodes[last].End) { panic("end entry " + fmt.Sprintf("%d", i)) }
		}
	}
}
func (p *engine) tryReuseSeg(oldRoot int32, oldSegs []Seg, oldEntries []EntryMeta, newText string, newMeta []alignMeta, byteDelta, oldN, prefix, suffix int, validate bool) (int32, int) {
	if oldRoot < 0 || len(oldSegs) == 0 { return -1, 0 }
	if validate { p.assertEntriesVsSegs(oldEntries, oldSegs, oldRoot) }
	old := p.nodes[oldRoot]
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
		for i := 0; i < s.KidCount; i++ { prefixKids = append(prefixKids, p.kids[old.KidStart+uint32(s.KidStart+i)]) }
	}
	rel, minRel := tailRel(oldN, suffixMeta)
	p.src = newText
	p.toks = toksFromMeta(newText, newMeta)
	if prefixLen > 0 { p.pos = prefixMeta[prefixLen-1].TokEnd } else { p.pos = 0 }
	p.scratch = p.scratch[:0]
	midKids := make([]int32, 0)
	midSegs := make([]Seg, 0)
	midMeta := make([]EntryMeta, 0)
	finishHit := func(adoptFrom int) (int32, int) {
		adoptedSegs := suffixCand[adoptFrom:]
		tokDelta := 0
		if len(adoptedSegs) > 0 {
			s := suffixMeta[adoptFrom].TokStart
			tokDelta = p.pos - s
		}
		adoptedKids := make([]int32, 0)
		for _, s := range adoptedSegs {
			for i := 0; i < s.KidCount; i++ {
				id := p.kids[old.KidStart+uint32(s.KidStart+i)]
				if id < 0 {
					ti, tt := decodeLeaf(id)
					id = encodeLeaf(uint32(int32(ti)+int32(tokDelta)), tt)
				} else {
					p.shiftSubtree(id, byteDelta, tokDelta)
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
		kidStart := len(p.kids)
		p.kids = append(p.kids, children...)
		p.nodes = append(p.nodes, Node{RuleId: old.RuleId, KidStart: uint32(kidStart), KidCount: uint32(len(children)), Offset: uint32(off), End: uint32(end), TokStart: uint32(tokStart), TokEnd: uint32(tokEnd)})
		p.segs = newSegs
		p.entries = newEntries
		p.pos = len(p.toks)
		return int32(len(p.nodes) - 1), len(prefixSegs) + len(adoptedSegs)
	}
	tryHit := func() (int32, int, bool) {
		if len(p.toks)-p.pos > suffix { return -1, 0, false }
		if len(suffixCand) == 0 {
			if p.pos == len(p.toks) { r, n := finishHit(0); return r, n, true }
			return -1, 0, false
		}
		for i := range suffixMeta {
			if rel[i] == len(p.toks)-p.pos { r, n := finishHit(i); return r, n, true }
		}
		return -1, 0, false
	}
	passed := func() bool { return len(suffixCand) > 0 && minRel >= 0 && len(p.toks)-p.pos < minRel }
	if r, n, ok := tryHit(); ok { return r, n }
	if passed() { return -1, 0 }
	${hasHeadB ? `if prefixLen == 0 {
		sb := len(p.scratch)
		if h, m, ok := p.parseHeadSeg(sb); ok {
			h.KidStart = 0
			m.KidStart = 0
			midKids = append(midKids, p.scratch[sb:]...)
			p.scratch = p.scratch[:sb]
			midSegs = append(midSegs, h)
			midMeta = append(midMeta, m)
			if r, rn, ok := tryHit(); ok { return r, rn }
			if passed() { return -1, 0 }
		}
	}
	` : ''}for {
		if p.pos >= len(p.toks) {
			if len(suffixCand) == 0 && p.pos == len(p.toks) { return finishHit(0) }
			if r, n, ok := tryHit(); ok { return r, n }
			return -1, 0
		}
		sb := len(p.scratch)
		seg, m, ok := p.parseLoopSeg(sb)
		if !ok {
			if len(suffixCand) == 0 && p.pos == len(p.toks) { return finishHit(0) }
			if r, n, hit := tryHit(); hit { return r, n }
			return -1, 0
		}
		count := len(p.scratch) - sb
		midKids = append(midKids, p.scratch[sb:]...)
		p.scratch = p.scratch[:sb]
		m.KidStart = 0
		midSegs = append(midSegs, Seg{0, count, seg.TokStart, seg.TokEnd, seg.Ext})
		midMeta = append(midMeta, m)
		if r, rn, hit := tryHit(); hit { return r, rn }
		if passed() { return -1, 0 }
	}
}
` : ''}` : '';
  const editParse = shapeA
    ? `\tbyteDelta := len(d.text) - len(oldText)
\treused := 0
\tforceFresh := d.root < 0 || p.shouldReclaim(d.root)
\tif !forceFresh {
\t\toldEntries := append([]EntryMeta(nil), d.entries...)
\t\tif got, n := p.tryReuseTop(d.root, oldEntries, d.text, d.toks, byteDelta, oldN, prefix, suffix, d.validate); got >= 0 {
\t\t\td.root = got
\t\t\td.entries = append([]EntryMeta(nil), p.entries...)
\t\t\treused = n
\t\t} else {
${parseFreshRetry}
\t\t\td.entries = append([]EntryMeta(nil), p.entries...)
\t\t\treused = 0
\t\t}
\t} else {
${parseFreshRetry}
\t\td.entries = append([]EntryMeta(nil), p.entries...)
\t\treused = 0
\t}`
    : shapeB
    ? `\tbyteDelta := len(d.text) - len(oldText)
\treused := 0
\tforceFresh := d.root < 0 || p.shouldReclaim(d.root)
\tif !forceFresh {
\t\toldSegs := append([]Seg(nil), p.segs...)
\t\toldEntries := append([]EntryMeta(nil), d.entries...)
\t\tif got, n := p.tryReuseSeg(d.root, oldSegs, oldEntries, d.text, d.toks, byteDelta, oldN, prefix, suffix, d.validate); got >= 0 {
\t\t\td.root = got
\t\t\td.entries = append([]EntryMeta(nil), p.entries...)
\t\t\treused = n
\t\t} else {
${parseFreshRetry}
\t\t\td.entries = append([]EntryMeta(nil), p.entries...)
\t\t\treused = 0
\t\t}
\t} else {
${parseFreshRetry}
\t\td.entries = append([]EntryMeta(nil), p.entries...)
\t\treused = 0
\t}`
    : `\treused := 0
${parseFreshRetry}`;
  const treeEqFn = `
// checkTreeEq compares p's tree for text with a fresh parse on a separate engine.
func (p *engine) checkTreeEq(text string, root int32) bool {
	// Match TS/Rust: incomplete parse (root>=0 but pos!=len) is not a tree.
	rootOk := root >= 0 && p.pos == len(p.toks)
	f := &engine{}
	fresh := f.parse(text, lex(text))
	freshOk := fresh >= 0 && f.pos == len(f.toks)
	if !rootOk || !freshOk { return rootOk == freshOk }
	var s1, s2 strings.Builder
	p.writeJSON(root, &s1)
	f.writeJSON(fresh, &s2)
	return s1.String() == s2.String()
}
`;
  return `type Edit struct { Start, End int; Text string }
// Packed Doc-state token (~16B). kind → Kid+kindStr; text → src[Off:End];
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
${relexFamily}
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
${treeEqFn}${reuseFns}// A Doc owns its tree: its engine (e) keeps the arena, parse stream and reuse metadata across
// edits, and b (the caller's CstBuilder under NewDocWith) is pointed at that tree after each call.
type Doc struct { text string; root int32; toks []alignMeta; align *Align; validate bool; b *CstBuilder; e engine${topReuse ? '; entries []EntryMeta' : ''} }
func (d *Doc) publish() { d.b.Nodes, d.b.Kids, d.b.Toks = d.e.nodes, d.e.kids, d.e.toks }
func NewDoc(src string) *Doc { return newDocCst(src, &CstBuilder{}) }
func newDocCst(src string, b *CstBuilder) *Doc {
	d := &Doc{text: src, b: b}
	defer d.publish()
	var toks []Tok
	d.toks, toks = scanMetaToks(src)
	// A Doc owns its arena, so a new one starts empty; size it from the token count instead of
	// growing it by repeated append copies (TS-family code runs ~0.6 nodes and ~1.1 kids per token).
	// The token and meta slices are likewise sized from the source (len/2 covers dense code, where a
	// token averages over two bytes): growth garbage is what drives GC cycles, since a dropped Doc
	// leaves a small live heap.
	n := len(toks)
	if cap(b.Nodes) < n*3/4 { b.Nodes = make([]Node, 0, n*3/4) }
	if cap(b.Kids) < n*5/4 { b.Kids = make([]int32, 0, n*5/4) }
	d.e.nodes, d.e.kids = b.Nodes[:0], b.Kids[:0]
	d.root = d.e.parse(src, toks)
${topReuse ? '\td.entries = append([]EntryMeta(nil), d.e.entries...)\n' : ''}\treturn d
}
// CstJSON renders the Doc's current tree ("" when its text does not parse).
func (d *Doc) CstJSON() string {
	if d.root < 0 { return "" }
	var buf strings.Builder
	writeJSONWith(d.e.nodes, d.e.kids, d.e.toks, d.root, &buf)
	return buf.String()
}
func (d *Doc) SetValidate(v bool) { d.validate = v }
func (d *Doc) Text() string { return d.text }
func (d *Doc) Root() int32 { return d.root }
func (d *Doc) Align() *Align { return d.align }
func (d *Doc) Edit(edits []Edit) (ret int32) {
	p := &d.e
	defer d.publish()
	oldText, oldToks := d.text, d.toks
	relexed := 0
	defer func() {
		if rec := recover(); rec != nil {
			d.text = applyEdits(oldText, edits)
			func() {
				defer func() {
					if recover() != nil {
						d.toks = nil
						d.root = -1
						d.align = &Align{OldN: len(oldToks), NewN: 0, Prefix: 0, Suffix: 0, Relexed: 0, Reused: 0}
					}
				}()
				d.toks = ${freshMeta}
				d.root = p.parse(d.text, toksFromMeta(d.text, d.toks))
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
		func() { defer func() { recover() }(); t := p.checkTreeEq(d.text, d.root); a.TreeEq = &t }()
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
    case 'lit': return gtCompLit(ids, s) ? `p.matchCompW(${lidOf(ids, s.value)})` : `p.matchLitW(${lidOf(ids, s.value)}, ${ttIdOf(ar, s.ttype)})`;
    case 'tok': return `p.matchTokW(${kidOf(ids, s.name)}, ${ttIdOf(ar, s.name)})`;
    case 'rule': return `p.callRuleW((*${recv}).parse${s.name}W)`;
    case 'ruleBp': return `p.callRuleW(func(q *${recv}) (spanned, bool) { return q.bpW_${s.name}(${s.bp}) })`;
    case 'star': return `p.starW(func() bool { return ${stepCondW(s.step, ids, ar, recv)} })`;
    case 'opt': return `p.optW(func() bool { return ${s.steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ')} })`;
    case 'sep': return `p.sepByW(func() bool { return ${stepCondW(s.elem, ids, ar, recv)} }, ${lidOf(ids, s.delim)})`;
    case 'altlit': return `p.altLitW([]struct{ Lid, TtId uint16 }{${s.opts.map((o) => `{${lidOf(ids, o.value)}, ${ttIdOf(ar, o.ttype)}}`).join(', ')}})`;
    case 'alt': return s.predictive
      ? `func() bool { ${predAltBodyW(s.branches, ids, ar, s.firsts, recv)} }()`
      : `func() bool { ${altBodyW(s.branches, ids, ar, s.firsts, recv)} }()`;
    case 'not': return `func() bool { ${notBodyW(s.steps, ids, ar, recv)} }()`;
    case 'ahead': return `p.aheadW(${s.set}, ${s.is})`;
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
  // FIRST dispatch; restore pos/scratch/arena on arm half-failure (like altBodyW).
  const arms = branches.map((br, i) => {
    const steps = br.length ? br.map((x) => stepCondW(x, ids, ar, recv)).join(' && ') : 'true';
    return `if ${firstCond(firsts![i], 't', ids)} { sp := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}; if ${steps} { return true }; p.pos = sp; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)} }`;
  }).join(' else ');
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
    .replace(/\{ sp := p\.pos; n := p\.parse([A-Za-z0-9_]+)\(\); if n >= 0 \{ return n \}; p\.pos = sp \}/g,
      '{ sp := p.pos; fr, ok := p.parse$1W(); if ok { return fr, true }; p.pos = sp }')
    .replace(/return p\.parse([A-Za-z0-9_]+)\(\)/g, 'return p.parse$1W()')
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
\tp.entryHs = append([]int32(nil), p.scratch[sb:]...)
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
\tp.entryHs = append([]int32(nil), p.scratch[sb:]...)
\tp.entries = localE
\treturn p.finishW(${rid}, sb, p.offAtW(save), save), true
}`;
}

function rdEntryWithReuseW(r: RdRule, plan: ReusePlan, ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string {
  return plan.kind === 'A' ? rdEntryWithReuseAW(r, plan, ar, recv) : rdEntryWithReuseBW(r, plan, ids, ar, recv);
}

function prattRuleW(r: PrattRule, tpl: TplCfg | null, ids: LexIdPlan, ar: ArenaIdPlan, recv: string): string {
  const rid = ruleIdOf(ar, r.cstName);
  const tplNud = r.nudTplHole !== undefined
    ? `\tif t.Kid == ${kidOf(ids, '$templateHead')} {
\t\tn, ok := p.matchTemplateW_${r.nudTplHole}()
\t\tif !ok { return spanned{}, false }
\t\tsb := len(p.scratch)
\t\tif n.present { p.scratch = append(p.scratch, n.h) }
\t\treturn p.finishW(${rid}, sb, int(n.off), int(n.tokStart)), true
\t}\n`
    : '';
  const bracketNudBody = (b: Bracket, closes: boolean) => `{
\t\tsave := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}
\t\tif ${b.steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ')} { ${closes ? 'pt = true; ' : ''}return p.finishW(${rid}, sb, p.offAtW(save), save), true }
\t\tp.pos = save; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}
\t}`;
  const bracketNudSwitch = (() => {
    if (r.nudBrackets.length === 0) return '';
    const groups = groupByPreserveOrder(r.nudBrackets, (b) => lidOf(ids, b.first));
    return `\tswitch t.Lid {
${groups.map((g) => `\tcase ${g.key}:
${g.members.map(({ item: b, index: bi }) => `\t\t${bracketNudBody(b, r.nudBracketClosesTail[bi]!)}`).join('\n')}`).join('\n')}
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
  const ledBody = (b: Bracket, form: number, closes: boolean) => `{
\t\t\tledSave := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}
\t\t\tp.scratch = append(p.scratch, left.h)
\t\t\tif ${b.steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ')} { left = p.finishW(${rid}, sb, int(left.off), int(left.tokStart)); form = ${form};${closes ? ' tailClosed = true;' : ''} continue LedLoop }
\t\t\tp.pos = ledSave; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}
\t\t}`;
  const ledSwitch = (() => {
    if (r.leds.length === 0) return '';
    const groups = groupByPreserveOrder(r.leds, (b) => lidOf(ids, b.first));
    return `\t\tswitch t.Lid {
${groups.map((g) => {
  const lid = g.key as number;
  const arms = g.members.map(({ item: b, index: i }) =>
    `\t\t\tif ${ledGuard(r.ledAccessTail[i]!, r.ledLbp[i]!, r.ledSameLine[i]!, r.ledNotLeftLeaf[i]!, lid)} ${ledBody(b, r.ledForm[i]!, r.ledClosesTail[i]!)}`);
  return `\t\tcase ${lid}:\n${arms.join('\n')}`;
}).join('\n')}
\t\t}`;
  })();
  const postfixTokSwitch = (() => {
    if (r.postfixToks.length === 0) return '';
    const groups = groupByPreserveOrder(r.postfixToks, (tok) => kidOf(ids, tok));
    const tplPart = r.postfixTplHole !== undefined ? `
\t\tif !tailClosed && t.Kid == ${kidOf(ids, '$templateHead')} {
\t\t\tif n, ok := p.matchTemplateW_${r.postfixTplHole}(); ok {
\t\t\t\tsb := len(p.scratch)
\t\t\t\tif left.present { p.scratch = append(p.scratch, left.h) }
\t\t\t\tif n.present { p.scratch = append(p.scratch, n.h) }
\t\t\t\tleft = p.finishW(${rid}, sb, int(left.off), int(left.tokStart)); form = 0; continue LedLoop
\t\t\t}
\t\t}` : '';
    return `\t\tswitch t.Kid {
${groups.map((g) => `\t\tcase ${g.key}:
\t\t\tif !tailClosed {
\t\t\t\tsb := len(p.scratch); p.scratch = append(p.scratch, left.h); p.pushLeafW(uint16(t.Kid), uint32(p.pos), t.Off, t.End); p.pos++
\t\t\t\tleft = p.finishW(${rid}, sb, int(left.off), int(left.tokStart)); form = 0; continue LedLoop
\t\t\t}`).join('\n')}
\t\t}${tplPart}`;
  })();
  const needLedLoop = r.leds.length > 0 || r.postfixToks.length > 0;
  return `func (p *${recv}) parse${r.name}W() (spanned, bool) {
\tprev := p.suppressCur
\tp.suppressCur = p.suppressNext
\tp.suppressNext = nil
\tr, ok := p.bpW_${r.name}(0)
\tp.suppressCur = prev
\treturn r, ok
}
func (p *${recv}) bpW_${r.name}(minBp int) (spanned, bool) {
\tleft, ok := p.nudW_${r.name}(minBp)
\tif !ok { return spanned{}, false }
\tform := p.form
\tif p.capped { return left, true }
\ttailClosed := p.tail
${needLedLoop ? 'LedLoop:\n' : ''}\tfor {
\t\tt := p.peekW()
\t\tif t == nil { break }
${ledSwitch}
${postfixTokSwitch}
\t\tif post, ok := post_${r.name}[t.Lid]; ok && !tailClosed && post.lbp > minBp${r.postfixSameLine ? ' && !t.Nl' : ''} {
\t\t\tif post.tgt && form != 0 { return spanned{}, false }
\t\t\tsb := len(p.scratch); p.scratch = append(p.scratch, left.h); p.pushLeafW(${ttIdOf(ar, '$operator')}, uint32(p.pos), t.Off, t.End); p.pos++; tailClosed = true
\t\t\tleft = p.finishW(${rid}, sb, int(left.off), int(left.tokStart)); form = 1; continue
\t\t}
${gtOpRead(ids, true)}
\t\tinfo, ok := bin_${r.name}[opLid]
\t\tif !ok || info.lbp <= minBp { break }
\t\tif info.tgt && form != 0 || info.noUnary && form == 2 { return spanned{}, false }
\t\tledSave := p.pos; sb := len(p.scratch)
\t\tp.scratch = append(p.scratch, left.h); p.pushLeafW(${ttIdOf(ar, '$operator')}, uint32(p.pos), t.Off, opEnd)
\t\tp.pos += opN
\t\trhs, rok := p.bpW_${r.name}(info.rbp)
\t\tif !rok { p.pos = ledSave; p.scratch = p.scratch[:sb]; break }
\t\tif rhs.present { p.scratch = append(p.scratch, rhs.h) }
\t\tleft = p.finishW(${rid}, sb, int(left.off), int(left.tokStart))
\t\tform = 1; tailClosed = true
\t}
\tp.form = form
\treturn left, true
}
func (p *${recv}) nudW_${r.name}(minBp int) (spanned, bool) {
\tp.capped = false
\tt := p.peekW()
\tif t == nil { return spanned{}, false }
${r.nudCapped.map((c) => `\tif minBp < ${c.capBp} { save := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}; if ${c.steps.length ? c.steps.map((x) => stepCondW(x, ids, ar, recv)).join(' && ') : 'true'} { p.capped = true; p.form = 0; return p.finishW(${rid}, sb, p.offAtW(save), save), true }; p.pos = save; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)} }`).join('\n')}
\tpf, pt := uint8(0), false
\t_r, _ok := func() (spanned, bool) {
${tplNud}\tif atom_${r.name}[t.Kid] {
\t\tsb := len(p.scratch); ts := p.pos; p.pushLeafW(uint16(t.Kid), uint32(p.pos), t.Off, t.End); p.pos++
\t\treturn p.finishW(${rid}, sb, int(t.Off), ts), true
\t}
${bracketNudSwitch}
\tif pbp, ok := pre_${r.name}[t.Lid]; ok {
\t\tsave := p.pos; sb := len(p.scratch)
\t\tp.pushLeafW(${ttIdOf(ar, '$operator')}, uint32(p.pos), t.Off, t.End); p.pos++
\t\toperand, ook := p.bpW_${r.name}(pbp.rbp)
\t\tif !ook || pbp.tgt && p.form != 0 { p.pos = save; p.scratch = p.scratch[:sb]; return spanned{}, false }
\t\tif operand.present { p.scratch = append(p.scratch, operand.h) }
\t\tpf, pt = pbp.form, true
\t\treturn p.finishW(${rid}, sb, p.offAtW(save), save), true
\t}
${r.nudSeqs.map((seq, si) => `\t{ save := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}; if ${seq.length ? seq.map((x) => stepCondW(x, ids, ar, recv)).join(' && ') : 'true'} { ${r.nudSeqClosesTail[si] ? 'pt = true; ' : ''}return p.finishW(${rid}, sb, p.offAtW(save), save), true }; p.pos = save; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)} }`).join('\n')}
\treturn spanned{}, false
\t}()
\tp.capped = false
\tp.form = pf
\tp.tail = pt
\treturn _r, _ok
}`;
}

function emitParserMethodsW(recv: string, ir: ParserIR, ids: LexIdPlan, ar: ArenaIdPlan): string {
  const reuse = topReusePlan(ir);
  // entryHs: flat entry-level handles (shape-A kids / shape-B root kids), snapshotted
  // before finishW consumes scratch — DocWith reuse reads this, never Builder.Nodes.
  const entriesField = reuse ? '\n\tentries []EntryMeta\n\tentryHs []int32' : '';
  const ruleFnsW = ir.rules.map((r) => {
    if (r.kind === 'pratt') return prattRuleW(r, ir.tpl, ids, ar, recv);
    if (reuse && r.name === ir.entry) return rdEntryWithReuseW(r, reuse, ids, ar, recv);
    return rdRuleW(r, ids, ar, recv);
  }).join('\n\n');
  // One template matcher per hole rule (tplHoleRules): the hole is parsed by the rule the
  // matching reference declares, called directly.
  const matchTemplateW = tplHoleRules(ir).map((hole) => `func (p *${recv}) matchTemplateW_${hole}() (spanned, bool) {
\tt := p.peekW()
\tif t == nil || t.Kid != ${kidOf(ids, '$templateHead')} { return spanned{}, false }
\tsave := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}
\tp.pushLeafW(${ttIdOf(ar, '$templateHead')}, uint32(p.pos), t.Off, t.End); p.pos++
\tfor {
\t\texpr, ok := p.parse${hole}W()
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
`).join('');
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
\tform uint8 // assignment-target form of the node the last nud_/bp_ call returned
\ttail bool  // whether the node the last nud_ call returned closes the access tail
\tsuppressNext, suppressCur map[uint16]bool
\tsrc string
\tNodes []Node
\tKids []int32
\tscratch []int32`
    : `\ttoks []Tok
\tpos, maxLook int
\tcapped bool
\tform uint8 // assignment-target form of the node the last nud_/bp_ call returned
\ttail bool  // whether the node the last nud_ call returned closes the access tail
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
func (p *${recv}) aheadW(k int, is bool) bool { t := p.peekW(); return (t != nil && inTokenSet(k, t)) == is }
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
func (p *${recv}) matchCompW(lid uint16) bool {
\tif p.peekW() == nil { return false }
\tc, n, _ := gtOp(p.toks, p.pos)
\tif c != lid { return false }
\tif e := p.pos + n + 1; e > p.maxLook { p.maxLook = e }
\tp.pos += n; return true
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
\tsp0 := p.pos; sb0 := len(p.scratch); ${arenaCkpt(recv).replace('nb, kb', 'nb0, kb0')}
\tif !elem() { p.pos = sp0; p.scratch = p.scratch[:sb0]; ${arenaRestore(recv).replace('nb', 'nb0').replace('kb', 'kb0')}; return true }
\tfor {
\t\tsp := p.pos; sb := len(p.scratch); ${arenaCkpt(recv)}
\t\tif !p.matchLitW(delim, TT_SKIP_PUNCT) { p.pos = sp; p.scratch = p.scratch[:sb]; ${arenaRestore(recv)}; break }
\t\tsp2 := p.pos; sb2 := len(p.scratch); ${arenaCkpt(recv).replace('nb, kb', 'nb2, kb2')}
\t\tif !elem() { p.pos = sp2; p.scratch = p.scratch[:sb2]; ${arenaRestore(recv).replace('nb', 'nb2').replace('kb', 'kb2')}; break }
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

function emitDocWithGo(
  ir: ParserIR,
  entryRid: number,
  shapeA: boolean,
  shapeB: boolean,
  hasHeadB: boolean,
  topReuse: boolean,
  initToks: string,
  freshMeta: string,
  editBody: string,
): string {
  const entry = ir.entry;
  const segsField = shapeB ? '\n\tsegs []Seg' : '';
  const entriesFields = topReuse
    ? `\n\tentries []EntryMeta\n\tentryHs []int32${segsField}`
    : '';

  const segsFromEntries = shapeB
    ? `
func segsFromEntries(entries []EntryMeta) []Seg {
	out := make([]Seg, len(entries))
	for i, e := range entries {
		out[i] = Seg{e.KidStart, e.KidCount, e.TokStart, e.TokEnd, e.Ext}
	}
	return out
}
`
    : '';

  const shiftHandleFn = `
// shiftHandle mutates a consumer builder arena (or returns a shifted leaf handle).
func shiftHandle(nodes []Node, kids *[]int32, h int32, byteDelta, tokDelta int) int32 {
	if h < 0 {
		ti, tt := decodeLeaf(h)
		return encodeLeaf(uint32(int32(ti)+int32(tokDelta)), tt)
	}
	nd := &nodes[h]
	nd.Offset = uint32(int32(nd.Offset) + int32(byteDelta))
	nd.End = uint32(int32(nd.End) + int32(byteDelta))
	nd.TokStart = uint32(int32(nd.TokStart) + int32(tokDelta))
	nd.TokEnd = uint32(int32(nd.TokEnd) + int32(tokDelta))
	nd.Ext = uint32(int32(nd.Ext) + int32(tokDelta))
	for i := uint32(0); i < nd.KidCount; i++ {
		slot := nd.KidStart + i
		cid := (*kids)[slot]
		if cid < 0 {
			ti, tt := decodeLeaf(cid)
			(*kids)[slot] = encodeLeaf(uint32(int32(ti)+int32(tokDelta)), tt)
		} else {
			shiftHandle(nodes, kids, cid, byteDelta, tokDelta)
		}
	}
	return h
}
func (b *CstBuilder) Shift(h int32, byteDelta, tokDelta int) int32 {
	return shiftHandle(b.Nodes, &b.Kids, h, byteDelta, tokDelta)
}
`;

  // EntryMeta is part of parseWithMetaW's signature always; reuse paths define it via
  // rdEntryWithReuse{A,B}. Non-reuse grammars (e.g. toy) still emit DocWith and need the type.
  const entryMetaType = topReuse ? '' : `type EntryMeta struct { TokStart, TokEnd, Ext, Off, End, KidStart, KidCount int }
`;

  const parseWithMetaW = `
${entryMetaType}func parseWithMetaW(text string, meta []alignMeta, b Builder) (h int32, entries []EntryMeta, entryHs []int32, ok bool) {
	p := &parserW{toks: toksFromMeta(text, meta), src: text, b: b, scratch: nil}
	fr, pok := p.parse${entry}W()
	recordToks(b, p.toks)
	if !pok || p.pos != len(p.toks) || !fr.present {
		return 0, nil, nil, false
	}
${topReuse
    ? `\treturn fr.h, append([]EntryMeta(nil), p.entries...), append([]int32(nil), p.entryHs...), true`
    : `\treturn fr.h, nil, nil, true`}
}
`;

  const tryReuseTopW = shapeA
    ? `
func tryReuseTopW(b Builder, sh Shifter, oldHs []int32, oldEntries []EntryMeta, newText string, newMeta []alignMeta, byteDelta, oldN, prefix, suffix int) (root int32, newEntries []EntryMeta, newHs []int32, reused int, ok bool) {
	prefixLen := 0
	for prefixLen < len(oldEntries) {
		if oldEntries[prefixLen].Ext <= prefix {
			prefixLen++
		} else {
			break
		}
	}
	suffixStart := len(oldEntries)
	for i := len(oldEntries) - 1; i >= prefixLen; i-- {
		if oldEntries[i].TokStart >= oldN-suffix {
			suffixStart = i
		} else {
			break
		}
	}
	prefixKids := append([]int32(nil), oldHs[:prefixLen]...)
	suffixCand := append([]int32(nil), oldHs[suffixStart:]...)
	prefixMeta := append([]EntryMeta(nil), oldEntries[:prefixLen]...)
	suffixMeta := append([]EntryMeta(nil), oldEntries[suffixStart:]...)
	rel, minRel := tailRel(oldN, suffixMeta)
	p := &parserW{toks: toksFromMeta(newText, newMeta), src: newText, b: b, scratch: nil}
	if prefixLen > 0 {
		p.pos = prefixMeta[prefixLen-1].TokEnd
	} else {
		p.pos = 0
	}
	mid := make([]int32, 0)
	midMeta := make([]EntryMeta, 0)
	finishHit := func(adoptFrom int) (int32, []EntryMeta, []int32, int, bool) {
		tokDelta := 0
		if adoptFrom < len(suffixMeta) {
			s := suffixMeta[adoptFrom].TokStart
			tokDelta = p.pos - s
		}
		adopted := make([]int32, 0, len(suffixCand)-adoptFrom)
		for _, s := range suffixCand[adoptFrom:] {
			adopted = append(adopted, sh.Shift(s, byteDelta, tokDelta))
		}
		children := make([]int32, 0, len(prefixKids)+len(mid)+len(adopted))
		children = append(children, prefixKids...)
		children = append(children, mid...)
		children = append(children, adopted...)
		adoptedMeta := append([]EntryMeta(nil), suffixMeta[adoptFrom:]...)
		outE := make([]EntryMeta, 0, len(prefixMeta)+len(midMeta)+len(adoptedMeta))
		outE = append(outE, prefixMeta...)
		outE = append(outE, midMeta...)
		for i := range adoptedMeta {
			shiftEntryMeta(&adoptedMeta[i], byteDelta, tokDelta)
			outE = append(outE, adoptedMeta[i])
		}
		off, end, tokStart, tokEnd := 0, 0, 0, 0
		if len(outE) > 0 {
			off = outE[0].Off
			end = outE[len(outE)-1].End
			tokStart = outE[0].TokStart
			tokEnd = outE[len(outE)-1].TokEnd
		}
		scratch := append([]int32(nil), children...)
		b.Node(&scratch, 0, ${entryRid}, uint32(off), uint32(end), uint32(tokStart), uint32(tokEnd))
		if len(scratch) != 1 {
			return 0, nil, nil, 0, false
		}
		recordToks(b, p.toks)
		return scratch[0], outE, children, len(prefixKids) + len(adopted), true
	}
	tryHit := func() (int32, []EntryMeta, []int32, int, bool) {
		if len(p.toks)-p.pos > suffix {
			return 0, nil, nil, 0, false
		}
		if len(suffixCand) == 0 {
			if p.pos == len(p.toks) {
				return finishHit(0)
			}
			return 0, nil, nil, 0, false
		}
		for i := range suffixMeta {
			if rel[i] == len(p.toks)-p.pos {
				return finishHit(i)
			}
		}
		return 0, nil, nil, 0, false
	}
	if r, e, hs, n, hit := tryHit(); hit {
		return r, e, hs, n, true
	}
	if len(suffixCand) > 0 && minRel >= 0 && len(p.toks)-p.pos < minRel {
		return 0, nil, nil, 0, false
	}
	for {
		if p.pos >= len(p.toks) {
			if len(suffixCand) == 0 && p.pos == len(p.toks) {
				return finishHit(0)
			}
			if r, e, hs, n, hit := tryHit(); hit {
				return r, e, hs, n, true
			}
			return 0, nil, nil, 0, false
		}
		p.maxLook = 0
		sp := p.pos
		fr, pok := p.parseTopOneW()
		if !pok {
			p.pos = sp
			return 0, nil, nil, 0, false
		}
		tokEnd := p.pos
		ext := tokEnd
		if p.maxLook > ext {
			ext = p.maxLook
		}
		end := int(fr.off)
		if fr.present {
			_, e1 := b.SpanOf(fr.h, p.toks)
			end = int(e1)
		}
		midMeta = append(midMeta, EntryMeta{int(fr.tokStart), tokEnd, ext, int(fr.off), end, 0, 1})
		mid = append(mid, fr.h)
		if r, e, hs, n, hit := tryHit(); hit {
			return r, e, hs, n, true
		}
		if len(suffixCand) > 0 && minRel >= 0 && len(p.toks)-p.pos < minRel {
			return 0, nil, nil, 0, false
		}
	}
}
`
    : '';

  const tryReuseSegW = shapeB
    ? `
func tryReuseSegW(b Builder, sh Shifter, oldRootHs []int32, oldSegs []Seg, oldEntries []EntryMeta, newText string, newMeta []alignMeta, byteDelta, oldN, prefix, suffix int) (root int32, newSegs []Seg, newEntries []EntryMeta, newHs []int32, reused int, ok bool) {
	if len(oldSegs) == 0 {
		return 0, nil, nil, nil, 0, false
	}
	prefixLen := 0
	for prefixLen < len(oldEntries) {
		if oldEntries[prefixLen].Ext <= prefix {
			prefixLen++
		} else {
			break
		}
	}
	suffixStart := len(oldEntries)
	for i := len(oldEntries) - 1; i >= prefixLen; i-- {
		if oldEntries[i].TokStart >= oldN-suffix {
			suffixStart = i
		} else {
			break
		}
	}
	prefixSegs := append([]Seg(nil), oldSegs[:prefixLen]...)
	suffixCand := append([]Seg(nil), oldSegs[suffixStart:]...)
	prefixMeta := append([]EntryMeta(nil), oldEntries[:prefixLen]...)
	suffixMeta := append([]EntryMeta(nil), oldEntries[suffixStart:]...)
	prefixKids := make([]int32, 0)
	for _, s := range prefixSegs {
		for i := 0; i < s.KidCount; i++ {
			prefixKids = append(prefixKids, oldRootHs[s.KidStart+i])
		}
	}
	rel, minRel := tailRel(oldN, suffixMeta)
	p := &parserW{toks: toksFromMeta(newText, newMeta), src: newText, b: b, scratch: nil}
	if prefixLen > 0 {
		p.pos = prefixMeta[prefixLen-1].TokEnd
	} else {
		p.pos = 0
	}
	midKids := make([]int32, 0)
	midSegs := make([]Seg, 0)
	midMeta := make([]EntryMeta, 0)
	finishHit := func(adoptFrom int) (int32, []Seg, []EntryMeta, []int32, int, bool) {
		adoptedSegs := suffixCand[adoptFrom:]
		tokDelta := 0
		if len(adoptedSegs) > 0 {
			s := suffixMeta[adoptFrom].TokStart
			tokDelta = p.pos - s
		}
		adoptedKids := make([]int32, 0)
		for _, s := range adoptedSegs {
			for i := 0; i < s.KidCount; i++ {
				adoptedKids = append(adoptedKids, sh.Shift(oldRootHs[s.KidStart+i], byteDelta, tokDelta))
			}
		}
		children := make([]int32, 0, len(prefixKids)+len(midKids)+len(adoptedKids))
		children = append(children, prefixKids...)
		children = append(children, midKids...)
		children = append(children, adoptedKids...)
		outSegs := make([]Seg, 0, len(prefixSegs)+len(midSegs)+len(adoptedSegs))
		outE := make([]EntryMeta, 0, len(prefixMeta)+len(midMeta)+len(suffixMeta)-adoptFrom)
		kOff := 0
		for i, s := range prefixSegs {
			em := prefixMeta[i]
			em.KidStart = kOff
			outSegs = append(outSegs, Seg{kOff, s.KidCount, s.TokStart, s.TokEnd, s.Ext})
			outE = append(outE, em)
			kOff += s.KidCount
		}
		for i, s := range midSegs {
			em := midMeta[i]
			em.KidStart = kOff
			outSegs = append(outSegs, Seg{kOff, s.KidCount, s.TokStart, s.TokEnd, s.Ext})
			outE = append(outE, em)
			kOff += s.KidCount
		}
		adoptedMeta := append([]EntryMeta(nil), suffixMeta[adoptFrom:]...)
		for i, s := range adoptedSegs {
			em := adoptedMeta[i]
			shiftEntryMeta(&em, byteDelta, tokDelta)
			em.KidStart = kOff
			outSegs = append(outSegs, Seg{kOff, s.KidCount, s.TokStart + tokDelta, s.TokEnd + tokDelta, s.Ext + tokDelta})
			outE = append(outE, em)
			kOff += s.KidCount
		}
		off, end, tokStart, tokEnd := 0, 0, 0, 0
		if len(outE) > 0 {
			off = outE[0].Off
			end = outE[len(outE)-1].End
			tokStart = outE[0].TokStart
			tokEnd = outE[len(outE)-1].TokEnd
		}
		scratch := append([]int32(nil), children...)
		b.Node(&scratch, 0, ${entryRid}, uint32(off), uint32(end), uint32(tokStart), uint32(tokEnd))
		if len(scratch) != 1 {
			return 0, nil, nil, nil, 0, false
		}
		recordToks(b, p.toks)
		return scratch[0], outSegs, outE, children, len(prefixSegs) + len(adoptedSegs), true
	}
	tryHit := func() (int32, []Seg, []EntryMeta, []int32, int, bool) {
		if len(p.toks)-p.pos > suffix {
			return 0, nil, nil, nil, 0, false
		}
		if len(suffixCand) == 0 {
			if p.pos == len(p.toks) {
				return finishHit(0)
			}
			return 0, nil, nil, nil, 0, false
		}
		for i := range suffixMeta {
			if rel[i] == len(p.toks)-p.pos {
				return finishHit(i)
			}
		}
		return 0, nil, nil, nil, 0, false
	}
	if r, sg, e, hs, n, hit := tryHit(); hit {
		return r, sg, e, hs, n, true
	}
	if len(suffixCand) > 0 && minRel >= 0 && len(p.toks)-p.pos < minRel {
		return 0, nil, nil, nil, 0, false
	}
	${hasHeadB
    ? `if prefixLen == 0 {
		sb := len(p.scratch)
		if m, pok := p.parseHeadSegW(sb); pok {
			midKids = append(midKids, p.scratch[sb:]...)
			p.scratch = p.scratch[:sb]
			count := len(midKids)
			midSegs = append(midSegs, Seg{0, count, m.TokStart, m.TokEnd, m.Ext})
			m.KidStart = 0
			m.KidCount = count
			midMeta = append(midMeta, m)
			if r, sg, e, hs, n, hit := tryHit(); hit {
				return r, sg, e, hs, n, true
			}
			if len(suffixCand) > 0 && minRel >= 0 && len(p.toks)-p.pos < minRel {
				return 0, nil, nil, nil, 0, false
			}
		}
	}
`
    : ''}for {
		if p.pos >= len(p.toks) {
			if len(suffixCand) == 0 && p.pos == len(p.toks) {
				return finishHit(0)
			}
			if r, sg, e, hs, n, hit := tryHit(); hit {
				return r, sg, e, hs, n, true
			}
			return 0, nil, nil, nil, 0, false
		}
		sb := len(p.scratch)
		m, pok := p.parseLoopSegW(sb)
		if !pok {
			if len(suffixCand) == 0 && p.pos == len(p.toks) {
				return finishHit(0)
			}
			if r, sg, e, hs, n, hit := tryHit(); hit {
				return r, sg, e, hs, n, true
			}
			return 0, nil, nil, nil, 0, false
		}
		count := len(p.scratch) - sb
		midKids = append(midKids, p.scratch[sb:]...)
		p.scratch = p.scratch[:sb]
		m.KidStart = 0
		midSegs = append(midSegs, Seg{0, count, m.TokStart, m.TokEnd, m.Ext})
		midMeta = append(midMeta, m)
		if r, sg, e, hs, n, hit := tryHit(); hit {
			return r, sg, e, hs, n, true
		}
		if len(suffixCand) > 0 && minRel >= 0 && len(p.toks)-p.pos < minRel {
			return 0, nil, nil, nil, 0, false
		}
	}
}
`
    : '';

  const editReuse = shapeA
    ? `\tbyteDelta := len(d.text) - len(oldText)
\treused := 0
\t_, hasShift := d.b.(Shifter)
\tforceFresh := !hasShift || d.root < 0
\tif !forceFresh {
\t\tsh := d.b.(Shifter)
\t\tif got, ne, nhs, n, hit := tryReuseTopW(d.b, sh, d.entryHs, d.entries, d.text, d.toks, byteDelta, oldN, prefix, suffix); hit {
\t\t\td.root = got
\t\t\td.entries = ne
\t\t\td.entryHs = nhs
\t\t\treused = n
\t\t} else {
\t\t\th, ne, nhs, ok := parseWithMetaW(d.text, d.toks, d.b)
\t\t\tif !ok {
\t\t\t\td.toks = ${freshMeta}
\t\t\t\th, ne, nhs, ok = parseWithMetaW(d.text, d.toks, d.b)
\t\t\t}
\t\t\tif ok {
\t\t\t\td.root = h
\t\t\t\td.entries = ne
\t\t\t\td.entryHs = nhs
\t\t\t} else {
\t\t\t\td.root = -1
\t\t\t\td.entries = nil
\t\t\t\td.entryHs = nil
\t\t\t}
\t\t\treused = 0
\t\t}
\t} else {
\t\th, ne, nhs, ok := parseWithMetaW(d.text, d.toks, d.b)
\t\tif !ok {
\t\t\td.toks = ${freshMeta}
\t\t\th, ne, nhs, ok = parseWithMetaW(d.text, d.toks, d.b)
\t\t}
\t\tif ok {
\t\t\td.root = h
\t\t\td.entries = ne
\t\t\td.entryHs = nhs
\t\t} else {
\t\t\td.root = -1
\t\t\td.entries = nil
\t\t\td.entryHs = nil
\t\t}
\t\treused = 0
\t}`
    : shapeB
    ? `\tbyteDelta := len(d.text) - len(oldText)
\treused := 0
\t_, hasShift := d.b.(Shifter)
\tforceFresh := !hasShift || d.root < 0 || len(d.segs) == 0
\tif !forceFresh {
\t\tsh := d.b.(Shifter)
\t\tif got, nsg, ne, nhs, n, hit := tryReuseSegW(d.b, sh, d.entryHs, d.segs, d.entries, d.text, d.toks, byteDelta, oldN, prefix, suffix); hit {
\t\t\td.root = got
\t\t\td.segs = nsg
\t\t\td.entries = ne
\t\t\td.entryHs = nhs
\t\t\treused = n
\t\t} else {
\t\t\th, ne, nhs, ok := parseWithMetaW(d.text, d.toks, d.b)
\t\t\tif !ok {
\t\t\t\td.toks = ${freshMeta}
\t\t\t\th, ne, nhs, ok = parseWithMetaW(d.text, d.toks, d.b)
\t\t\t}
\t\t\tif ok {
\t\t\t\td.root = h
\t\t\t\td.entries = ne
\t\t\t\td.entryHs = nhs
\t\t\t\td.segs = segsFromEntries(ne)
\t\t\t} else {
\t\t\t\td.root = -1
\t\t\t\td.entries = nil
\t\t\t\td.entryHs = nil
\t\t\t\td.segs = nil
\t\t\t}
\t\t\treused = 0
\t\t}
\t} else {
\t\th, ne, nhs, ok := parseWithMetaW(d.text, d.toks, d.b)
\t\tif !ok {
\t\t\td.toks = ${freshMeta}
\t\t\th, ne, nhs, ok = parseWithMetaW(d.text, d.toks, d.b)
\t\t}
\t\tif ok {
\t\t\td.root = h
\t\t\td.entries = ne
\t\t\td.entryHs = nhs
\t\t\td.segs = segsFromEntries(ne)
\t\t} else {
\t\t\td.root = -1
\t\t\td.entries = nil
\t\t\td.entryHs = nil
\t\t\td.segs = nil
\t\t}
\t\treused = 0
\t}`
    : `\treused := 0
\th, _, _, ok := parseWithMetaW(d.text, d.toks, d.b)
\tif !ok {
\t\td.toks = ${freshMeta}
\t\th, _, _, ok = parseWithMetaW(d.text, d.toks, d.b)
\t}
\tif ok {
\t\td.root = h
\t} else {
\t\td.root = -1
\t}`;

  const recoverAssign = topReuse
    ? (shapeB
      ? `\t\t\t\td.root = h
\t\t\t\td.entries = ne
\t\t\t\td.entryHs = nhs
\t\t\t\td.segs = segsFromEntries(ne)`
      : `\t\t\t\td.root = h
\t\t\t\td.entries = ne
\t\t\t\td.entryHs = nhs`)
    : `\t\t\t\td.root = h`;

  const recoverClear = topReuse
    ? (shapeB
      ? `\t\t\t\td.root = -1
\t\t\t\td.entries = nil
\t\t\t\td.entryHs = nil
\t\t\t\td.segs = nil`
      : `\t\t\t\td.root = -1
\t\t\t\td.entries = nil
\t\t\t\td.entryHs = nil`)
    : `\t\t\t\td.root = -1`;

  const initAssign = topReuse
    ? (shapeB
      ? `\t\td.root = h
\t\td.entries = entries
\t\td.entryHs = entryHs
\t\td.segs = segsFromEntries(entries)`
      : `\t\td.root = h
\t\td.entries = entries
\t\td.entryHs = entryHs`)
    : `\t\td.root = h`;

  return `${shiftHandleFn}${segsFromEntries}${parseWithMetaW}${tryReuseTopW}${tryReuseSegW}
// Document is the shared surface of NewDoc (*Doc) and NewDocWith (*DocWith).
type Document interface {
	SetValidate(v bool)
	Text() string
	Root() int32
	Align() *Align
	Edit(edits []Edit) int32
}

// DocWith holds a consumer Builder + optional EntryMeta reuse (W path).
type DocWith struct {
	text     string
	root     int32
	toks     []alignMeta
	align    *Align
	validate bool
	b        Builder${entriesFields}
}

// NewDocWith: *CstBuilder → a Doc whose tree lives in that builder (CST fast path, S3). Other
// builders → DocWith (parserW).
func NewDocWith(src string, b Builder) Document {
	if cb, is := b.(*CstBuilder); is {
		return newDocCst(src, cb)
	}
	return newDocWith(src, b)
}

func newDocWith(src string, b Builder) *DocWith {
	d := &DocWith{text: src, b: b}
	d.toks = ${initToks}
	${topReuse ? 'h, entries, entryHs, ok' : 'h, _, _, ok'} := parseWithMetaW(src, d.toks, b)
	if ok {
${initAssign}
	} else {
		d.root = -1
	}
	return d
}

func (d *DocWith) SetValidate(v bool) { d.validate = v }
func (d *DocWith) Text() string       { return d.text }
func (d *DocWith) Root() int32        { return d.root }
func (d *DocWith) Align() *Align      { return d.align }

func (d *DocWith) Edit(edits []Edit) (ret int32) {
	oldText, oldToks := d.text, d.toks
	relexed := 0
	defer func() {
		if rec := recover(); rec != nil {
			d.text = applyEdits(oldText, edits)
			func() {
				defer func() {
					if recover() != nil {
${recoverClear}
						d.toks = nil
						d.align = &Align{OldN: len(oldToks), NewN: 0, Prefix: 0, Suffix: 0, Relexed: 0, Reused: 0}
					}
				}()
				d.toks = ${freshMeta}
				${topReuse ? 'h, ne, nhs, ok' : 'h, _, _, ok'} := parseWithMetaW(d.text, d.toks, d.b)
				if ok {
${recoverAssign}
				} else {
${recoverClear}
				}
				d.align = &Align{OldN: len(oldToks), NewN: len(d.toks), Prefix: 0, Suffix: 0, Relexed: len(d.toks), Reused: 0}
			}()
			ret = d.root
		}
	}()
${editBody}
	oldN, newN, prefix, suffix := computeAlignCore(oldText, oldToks, d.text, d.toks)
${editReuse}
	a := &Align{OldN: oldN, NewN: newN, Prefix: prefix, Suffix: suffix, Relexed: relexed, Reused: reused}
	if d.validate {
		func() {
			defer func() { recover() }()
			v := checkStreamEq(d.text, d.toks)
			a.StreamEq = &v
		}()
		// Non-CST builders: treeEq reports nil (rust SUPPORTS_TREE_EQ=false).
	}
	d.align = a
	ret = d.root
	return
}
`;
}

// The `ahead` test's table: whether a token is in tokenSets[k] (see tokenSetBits).
function tokenSetRuntimeGo(ir: ParserIR, ids: LexIdPlan): string {
  const b = tokenSetBits(ids, ir.tokenSets);
  return `const _tokenSetStride = ${b.stride}
const _tokenSetKid = ${b.kidBase}
var _tokenSets = [...]uint32{${b.words.join(', ')}}
func inTokenSet(k int, t *Tok) bool {
\tr, l, c := k*_tokenSetStride, uint(t.Lid), uint(_tokenSetKid)+uint(t.Kid)
\treturn ((_tokenSets[r+int(l>>5)]>>(l&31))|(_tokenSets[r+int(c>>5)]>>(c&31)))&1 != 0
}`;
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
  // the native engine; other Builders use interface parserW.
  const wMethods = emitParserMethodsW('parserW', ir, ids, ar);
  const topReuse = topReusePlan(ir);
  const shapeA = topReuse?.kind === 'A';
  const shapeB = topReuse?.kind === 'B';
  const hasHeadB = !!(shapeB && topReuse && topReuse.kind === 'B' && topReuse.hasHead);
  const initToks = 'scanMeta(src)';
  const freshMeta = 'scanMeta(d.text)';
  const editBody = goEditBody;
  const entryRule = ir.rules.find((r) => r.name === ir.entry);
  const entryCst = entryRule && 'cstName' in entryRule ? (entryRule as { cstName: string }).cstName : ir.entry;
  const entryRid = ruleIdOf(ar, entryCst);
  const docWithBlock = emitDocWithGo(ir, entryRid, shapeA, shapeB, hasHeadB, !!topReuse, initToks, freshMeta, editBody);
  return `// ─── Builder API (additive; CST parse() / Doc above are unchanged) ───────────
// Builder is pure / bottom-up. Backtracking truncates scratch (+ optional arena
// checkpoint); discarded handles are garbage.
// *CstBuilder hot path = the native engine. Interface path = parserW.
// Optional shift: separate Shifter interface (Go has no optional methods); type
// assert. treeEq capacity = *CstBuilder identity (NewDocWith routes Cst → NewDoc).

type Builder interface {
\tLeaf(scratch *[]int32, ttId uint16, tokIdx, off, end uint32) bool
\tFinish(scratch *[]int32, sb int, ruleId uint16, fallbackOff, tokStart, tokEnd uint32, toks []Tok) (h int32, off uint32, present bool)
\tNode(scratch *[]int32, sb int, ruleId uint16, off, end, tokStart, tokEnd uint32)
\tSpanOf(h int32, toks []Tok) (uint32, uint32)
\tHeadSpan(h int32, toks []Tok) (uint32, uint32)
\tCheckpoint() (nb, kb int)
\tRestore(nb, kb int)
}

// Shifter is the optional incremental contract. Presence (type assert) ⇒ DocWith
// edit may reuse; absence ⇒ every edit is a fresh ParseWith (reused=0).
type Shifter interface {
\tShift(h int32, byteDelta, tokDelta int) int32
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

// Leaves index Toks, the token stream of the builder's last tree.
type CstBuilder struct {
\tNodes []Node
\tKids  []int32
\tToks  []Tok
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
\t\t\tti, tt := decodeLeaf(id)
\t\t\treturn toks[ti].Off, leafEnd(toks, ti, tt)
\t\t}
\t\tnd := &b.Nodes[id]
\t\tif nd.KidCount == 0 { return nd.Offset, nd.End }
\t\tid = b.Kids[nd.KidStart]
\t}
}
func cstKidOffEnd(nodes []Node, toks []Tok, kid int32) (uint32, uint32) {
\tif kid < 0 {
\t\tti, tt := decodeLeaf(kid)
\t\treturn toks[ti].Off, leafEnd(toks, ti, tt)
\t}
\tnd := &nodes[kid]
\treturn nd.Offset, nd.End
}

type SlimBuilder struct {
\tNodes []Node
\tKids  []int32
\tToks  []Tok
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
\t\tti, tt := decodeLeaf(h)
\t\treturn toks[ti].Off, leafEnd(toks, ti, tt)
\t}
\tnd := &b.Nodes[h]
\treturn nd.Offset, nd.End
}
func (b *SlimBuilder) HeadSpan(h int32, toks []Tok) (uint32, uint32) {
\tid := h
\tfor {
\t\tif id < 0 {
\t\t\tti, tt := decodeLeaf(id)
\t\t\treturn toks[ti].Off, leafEnd(toks, ti, tt)
\t\t}
\t\tnd := &b.Nodes[id]
\t\tif nd.KidCount == 0 { return nd.Offset, nd.End }
\t\tid = b.Kids[nd.KidStart]
\t}
}

${wMethods}
// parseWithCst: concrete hot path — the native engine building into the builder's arena.
// Keeps ParseWith(CstBuilder) within the additive-prefix / byte-equal contract
// without paying for a second method-instantiation (Go GC-shape stenciling tax).
func parseWithCst(src string, b *CstBuilder) (int32, bool) {
\tp := &engine{nodes: b.Nodes[:0], kids: b.Kids[:0]}
\th := p.parse(src, lex(src))
\tb.Nodes, b.Kids, b.Toks = p.nodes, p.kids, p.toks
\tif h < 0 { return 0, false }
\treturn h, true
}
func parseWithW(src string, b Builder) (int32, bool) {
\tp := &parserW{toks: lex(src), src: src, b: b, scratch: nil}
\tfr, ok := p.parse${ir.entry}W()
\trecordToks(b, p.toks)
\tif !ok || p.pos != len(p.toks) || !fr.present { return 0, false }
\treturn fr.h, true
}

// ParseWith runs the builder-driven parse. *CstBuilder uses the concrete hot path (the native
// engine); other Builders (e.g. *SlimBuilder) use interface parserW.
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
\t\tfmt.Fprintf(b, "{\\"tokenType\\":%q,\\"offset\\":%d,\\"end\\":%d}", TT_NAMES[tt], toks[ti].Off, leafEnd(toks, ti, tt))
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

${docWithBlock}
// recordToks hands the built-in builders the parse stream their leaves index.
func recordToks(b Builder, ts []Tok) {
\tswitch x := b.(type) {
\tcase *CstBuilder:
\t\tx.Toks = ts
\tcase *SlimBuilder:
\t\tx.Toks = ts
\t}
}
func CstJSONWith(b *CstBuilder, root int32) string {
\tvar buf strings.Builder
\twriteJSONWith(b.Nodes, b.Kids, b.Toks, root, &buf)
\treturn buf.String()
}
func SlimJSONWith(b *SlimBuilder, root int32) string {
\tvar buf strings.Builder
\twriteJSONWith(b.Nodes, b.Kids, b.Toks, root, &buf)
\treturn buf.String()
}
`;
}

const GO_TYPES: Record<Ty, string> = {
  int: 'int', lid: 'uint16', depth: 'int', bool: 'bool', str: 'string', meta: 'alignMeta', tok: 'Tok', edit: 'Edit',
  metas: '[]alignMeta', toks: '[]Tok', bools: '[]bool', depths: '[]int', edits: '[]Edit',
};
const GO_META: Record<MetaInt, string> = { off: 'int32', end: 'int32', kid: 'uint16', pd: 'uint16', fd: 'uint16', td: 'uint8' };
const GO_TOK: Record<TokInt, string> = { off: 'uint32', end: 'uint32', kid: 'uint16', lid: 'uint16' };
const GO_MK: Record<keyof MkMeta, string> = { off: 'int32', end: 'int32', kid: 'uint16', nl: 'bool', fd: 'uint16', pd: 'uint16', lc: 'bool', lb: 'bool', hd: 'bool', td: 'uint8' };
// Operator spelling and binding strength; unary is 90, a negative literal 7.
const GO_OPS: Record<BinOp, [string, number]> = {
  or: ['||', 1], and: ['&&', 2], eq: ['==', 3], ne: ['!=', 3], lt: ['<', 4], le: ['<=', 4], gt: ['>', 4], ge: ['>=', 4], shr: ['>>', 5], add: ['+', 6], sub: ['-', 6],
};
const GO_IND = '\t';
const exported = (s: string): string => s[0].toUpperCase() + s.slice(1);
const goWrap = (r: R, min: number): string => (r.prec < min ? `(${r.c})` : r.c);
const goBlock = (lines: string[]): string[] => lines.map((l) => GO_IND + l);

// Shared-algorithm lowering: explicit conversions, slices; growth estimates are reserved up front
// (GC churn from append doubling is the cost they avoid) and over-reserved slices are trimmed.
const goLowering: Lowering = {
  ident: (n) => n,
  num: { int: 'int', lid: 'uint16', depth: 'int' },
  type: (t) => GO_TYPES[t],
  cast: (_cx, r, nat) => ({ ...r, c: `${nat}(${r.c})`, nat, prec: ATOM }),
  owns: false,
  spliceInline: true,
  charSet: (name, rs) => `var ${name} = [256]bool{${rs.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, k) => `${lo + k}: true`)).join(', ')}}`,
  expr: {
    literal: (v) => ({ c: typeof v === 'string' ? JSON.stringify(v) : String(v), prec: typeof v === 'number' && v < 0 ? 7 : ATOM }),
    not: (r) => ({ c: `!${goWrap(r, ATOM)}`, prec: 90 }),
    bin: (op, a, b) => {
      const [sp, p] = GO_OPS[op];
      const side = (r: R, right: boolean): string =>
        (r.prec < p || (right && r.prec === p) || (op === 'shr' && r.prec < ATOM) || (COMPARISON.has(op) && r.prec >= 3 && r.prec <= 4) ? `(${r.c})` : r.c);
      return { c: `${side(a, false)} ${sp} ${side(b, true)}`, prec: p };
    },
    call: (name, args) => `${name}(${args.join(', ')})`,
    len: (cx, l) => cx.atom(`len(${l.c})`, 'int', 'int'),
    code: (cx, s, i) => cx.atom(`int(${goWrap(s, ATOM)}[${i.c}])`, 'int', 'int'),
    hasAt: (cx, s, i, lit) => cx.atom(`strings.HasPrefix(${goWrap(s, ATOM)}[${i.c}:], ${JSON.stringify(lit)})`, 'bool', 'bool'),
    inSet: (cx, set, c) => cx.atom(`${set}[${c.c}]`, 'bool', 'bool'),
    own: (_cx, r) => r,
  },
  stmt: {
    comment: (text) => [`// ${text}`],
    let: (cx, s) => {
      if (s.emptyList) return [`var ${s.id} ${cx.type(s.ty, 'local')}`];
      if (!isNum(s.ty)) return [`${s.id} := ${s.r.c}`];
      const nat = cx.nat(s.ty);
      if (s.r.lit) return [nat === 'int' ? `${s.id} := ${s.r.c}` : `var ${s.id} ${nat} = ${s.r.c}`];
      return [`${s.id} := ${cx.coerce(s.r, nat)}`];
    },
    set: (id, val) => [`${id} = ${val}`],
    if: (s) => {
      const head = `if ${s.c}`;
      if (s.inline !== undefined && GO_IND.length * s.depth + head.length + s.inline.length + 5 <= 110) return [`${head} { ${s.inline} }`];
      return [`${head} {`, ...goBlock(s.then), ...(s.else ? ['} else {', ...goBlock(s.else)] : []), '}'];
    },
    while: (c, body) => [`for ${c} {`, ...goBlock(body), '}'],
    break: () => ['break'],
    return: (vals) => [`return ${vals.join(', ')}`],
    fn: (f) => [
      ...f.doc.map((l) => `// ${l}`),
      `func ${f.name}(${f.params.map((p) => `${p.name} ${p.type}`).join(', ')}) ${f.rets.length === 1 ? f.rets[0] : `(${f.rets.join(', ')})`} {`,
      ...goBlock(f.body),
      '}',
    ].join('\n'),
  },
  relex: {
    index: 'int',
    expr: {
      index: (l, i) => ({ c: `${goWrap(l, ATOM)}[${i.c}]`, prec: ATOM }),
      metaInt: (cx, m, f) => cx.atom(`${goWrap(m, ATOM)}.${exported(f)}`, 'int', GO_META[f]),
      metaFlag: (cx, m, f) => cx.atom(`am${exported(f)}(${m.c})`, 'bool', 'bool'),
      tokInt: (cx, t, f) => cx.atom(`${goWrap(t, ATOM)}.${exported(f)}`, 'int', GO_TOK[f]),
      tokNl: (cx, t) => cx.atom(`${goWrap(t, ATOM)}.Nl`, 'bool', 'bool'),
      editInt: (cx, e, f) => cx.atom(`${e.c}.${exported(f)}`, 'int', 'int'),
      editText: (cx, e) => cx.atom(`${e.c}.Text`, 'str', 'str'),
      metaText: (cx, t, m) => cx.atom(`amText(${t.c}, ${m.c})`, 'str', 'str'),
      substr: (cx, s, a, b) => cx.atom(`${goWrap(s, ATOM)}[${cx.coerce(a, 'int')}:${cx.coerce(b, 'int')}]`, 'str', 'str'),
      lidOf: (cx, s) => cx.atom(`lidOf(${s.c})`, 'lid', cx.nat('lid')),
      mkMeta: (cx, fs) => cx.atom(`mkAlign(${fs.map(([f, r]) => cx.coerce(r, GO_MK[f])).join(', ')})`, 'meta', 'meta'),
      shiftMeta: (cx, m, d) => cx.atom(`shiftAlign(${m.c}, ${cx.coerce(d, 'int')})`, 'meta', 'meta'),
      metaEq: (_cx, a, b) => ({ c: `${a.c} == ${b.c}`, ty: 'bool', nat: 'bool', prec: GO_OPS.eq[1] }),
      splice: (cx, s, a, b, ins) => ({ c: `${goWrap(s, ATOM)}[:${cx.coerce(a, 'int')}] + ${ins.c} + ${goWrap(s, ATOM)}[${cx.coerce(b, 'int')}:]`, ty: 'str', nat: 'str', prec: GO_OPS.add[1] }),
      newList: (cx, ty, cap, estimate) => {
        const c = cap ?? estimate;
        return cx.atom(c ? `make(${GO_TYPES[ty]}, 0, ${cx.coerce(c, 'int')})` : 'nil', ty, ty, { owned: true });
      },
      falses: (cx, n) => cx.atom(`make([]bool, ${cx.coerce(n, 'int')})`, 'bools', 'bools', { owned: true }),
      prefix: (cx, l, n, estimate) => cx.atom(`append(make(${GO_TYPES[l.ty]}, 0, ${cx.coerce(estimate, 'int')}), ${goWrap(l, ATOM)}[:${cx.coerce(n, 'int')}]...)`, l.ty, l.ty, { owned: true }),
    },
    stmt: {
      setAt: (id, i, val) => [`${id}[${i}] = ${val}`],
      push: (_cx, l, r) => [`${l} = append(${l}, ${r.c})`],
      for: (cx, v, from, to, body) => [`for ${v} := ${cx.coerce(from, 'int')}; ${v} < ${cx.coerce(to, 'int')}; ${v}++ {`, ...goBlock(body), '}'],
      forEach: (v, l, body) => [`for _, ${v} := range ${l} {`, ...goBlock(body), '}'],
      destructure: (_cx, s) => [`${s.ids.join(', ')} ${s.declare ? ':=' : '='} ${s.call}`],
      lexStep: (_cx, s) => [`${[s.pos, ...s.state].join(', ')} = lexFrom(${s.text.c}, ${s.pos}, ${[...s.state, `&${s.out}`].join(', ')}, 1)`],
      shrink: (_cx, l, ty) => [`if cap(${l}) > 2*len(${l}) { ${l} = append(${GO_TYPES[ty]}(nil), ${l}...) }`],
    },
  },
};

export const goTarget = defineTarget({
  name: 'go',
  ext: 'go',
  lowering: goLowering,
  emitParser(grammar: CstGrammar, shared: SharedAlgorithms): string {
    const ir = portableIR(grammar);
    const ids = buildLexIdPlan(ir);
    const ar = buildArenaIdPlan(ir, ids);
    const reuse = topReusePlan(ir);
    const ruleFns = ir.rules.map((r) => {
      if (r.kind === 'pratt') return prattRule(r, ir.tpl, ids, ar);
      if (reuse && r.name === ir.entry) return rdEntryWithReuse(r, reuse, ids, ar);
      return rdRule(r, ids, ar);
    }).join('\n\n');
    // One template matcher per hole rule (tplHoleRules): the hole is parsed by the rule the
    // matching reference declares, called directly.
    const matchTemplate = tplHoleRules(ir).map((hole) => `func (p *engine) matchTemplate_${hole}() int32 {
\tt := p.peek()
\tif t == nil || t.Kid != ${kidOf(ids, '$templateHead')} { return -1 }
\tsb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids); save := p.pos
\tp.pushLeaf(${ttIdOf(ar, '$templateHead')}, uint32(p.pos)); p.pos++
\tfor {
\t\texpr := p.parse${hole}()
\t\tif expr < 0 { p.pos = save; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]; return -1 }
\t\tp.scratch = append(p.scratch, expr)
\t\tnext := p.peek()
\t\tif next == nil { p.pos = save; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]; return -1 }
\t\tif next.Kid == ${kidOf(ids, '$templateMiddle')} { p.pushLeaf(${ttIdOf(ar, '$templateMiddle')}, uint32(p.pos)); p.pos++; continue }
\t\tif next.Kid == ${kidOf(ids, '$templateTail')} { p.pushLeaf(${ttIdOf(ar, '$templateTail')}, uint32(p.pos)); p.pos++; break }
\t\tp.pos = save; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]; return -1
\t}
\treturn p.finish(${ruleIdOf(ar, '$template')}, sb, int(t.Off), save)
}
`).join('');
    return `// GENERATED by emit-portable.ts (goTarget) — parser LIBRARY (package parser) for grammar "${ir.grammarName}".
// Public API: Tokenize(src) []Token (the lexer alone, a fresh slice the caller owns), ParseWith /
// NewDoc / NewDocWith (CST). The CLI runner (stdin → CST JSON) is goTarget.emitRunner(): the
// verification gates compile it with this file as one \`package main\`.
package parser

import (
\t"fmt"
\t"strings"
\t"unicode"
\t"unicode/utf8"
)

// unicode is only referenced when the grammar declares an identifier token; pin it so other
// grammars still compile.
var _ = unicode.IsLetter

// Slim hot-path token (kind/text via kindStr / src[Off:End]).
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
type bp struct{ lbp, rbp int; tgt, noUnary bool }
type preOp struct{ rbp int; tgt bool; form uint8 }
type postOp struct{ lbp int; tgt bool }

// engine is one parse's mutable state: the token stream it reads, the cursor and lookahead watermark, the arena it builds into and the reuse
// metadata. A Doc owns one for its lifetime; ParseWith uses a fresh one per call. Nothing the
// parser or lexer mutates is package-level, so different Docs, ParseWith and Tokenize are
// independent (and safe from concurrent goroutines); a single Doc is not safe for concurrent use.
type engine struct {
\ttoks []Tok
\tpos, maxLook int
\tcapped bool
\tform uint8 // assignment-target form of the node the last nud_/bp_ call returned
\ttail bool  // whether the node the last nud_ call returned closes the access tail
\tsrc string
\tsuppressNext, suppressCur map[uint16]bool
\tnodes []Node
\tkids []int32
\tscratch []int32
\tarenaBaseline int
${reuse ? '\tentries []EntryMeta\n' : ''}${reuse?.kind === 'B' ? '\tsegs []Seg\n' : ''}}
const arenaCompactK = 4

${renderArenaTablesGo(ar)}

${lexer(ir, ids, shared)}

// Public token (the tokenizer's output model).
type Token struct {
\tKind, Text string
\tOff, End   int
\tNl         bool
\tKid, Lid   uint16
}

// LexError reports input the lexer cannot tokenize. Tokenize returns it; ParseWith and the
// Doc constructors panic with it.
type LexError struct {
\tOff int
\tMsg string
}

func (e *LexError) Error() string { return e.Msg }

// Tokenize is the lexer alone: a fresh slice the caller owns.
func Tokenize(src string) (toks []Token, err error) {
\tdefer func() {
\t\tif r := recover(); r != nil {
\t\t\tle, ok := r.(*LexError)
\t\t\tif !ok { panic(r) }
\t\t\ttoks, err = nil, le
\t\t}
\t}()
\tslim := lex(src)
\tout := make([]Token, len(slim))
\tfor i := range slim {
\t\tt := &slim[i]
\t\tout[i] = Token{Kind: tokKind(t), Text: tokText(src, t), Off: int(t.Off), End: int(t.End), Nl: t.Nl, Kid: t.Kid, Lid: t.Lid}
\t}
\treturn out, nil
}

func encodeLeaf(tokIdx uint32, ttId uint8) int32 {
\tif tokIdx >= (1 << 25) { panic("tok_idx exceeds 2^25-1") }
\tpacked := tokIdx | (uint32(ttId) << 25)
\treturn int32(^packed)
}
func decodeLeaf(v int32) (tokIdx uint32, ttId uint8) {
\tpacked := uint32(^v)
\treturn packed & ((1 << 25) - 1), uint8(packed >> 25)
}
${gtRuntimeGo(ids, ar)}
func (p *engine) pushLeaf(ttId uint8, tokIdx uint32) {
\tif ttId == TT_SKIP_PUNCT { return }
\tp.scratch = append(p.scratch, encodeLeaf(tokIdx, ttId))
}

func (p *engine) peek() *Tok {
\tif p.pos+1 > p.maxLook { p.maxLook = p.pos + 1 }
\tif p.pos < len(p.toks) { return &p.toks[p.pos] }
\treturn nil
}
${tokenSetRuntimeGo(ir, ids)}
func (p *engine) ahead(k int, is bool) bool { t := p.peek(); return (t != nil && inTokenSet(k, t)) == is }
func (p *engine) offAt(i int) int { if i < len(p.toks) { return int(p.toks[i].Off) }; return 0 }
// Wrap the scratch entries [sb:] as one node's children (flattened into kids); truncate scratch.
// tokStart is the parse-consumption start (entry pos / leftmost operand), tokEnd is pos at finish.
func (p *engine) finish(ruleId uint16, sb, fallbackOff, tokStart int) int32 {
\tnn := len(p.scratch)
\tkidStart := len(p.kids)
\toff, end := uint32(fallbackOff), uint32(fallbackOff)
\tif nn > sb {
\t\tfirst := p.scratch[sb]
\t\tlast := p.scratch[nn-1]
\t\tif first < 0 {
\t\t\tti, _ := decodeLeaf(first)
\t\t\toff = uint32(p.toks[ti].Off)
\t\t} else {
\t\t\toff = p.nodes[first].Offset
\t\t}
\t\tif last < 0 {
\t\t\tti, _ := decodeLeaf(last)
\t\t\tend = uint32(p.toks[ti].End)
\t\t} else {
\t\t\tend = p.nodes[last].End
\t\t}
\t}
\tp.kids = append(p.kids, p.scratch[sb:nn]...)
\tp.scratch = p.scratch[:sb]
\tp.nodes = append(p.nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(nn - sb), Offset: off, End: end, TokStart: uint32(tokStart), TokEnd: uint32(p.pos), Ext: 0})
\treturn int32(len(p.nodes) - 1)
}
func (p *engine) matchLit(lid uint16, ttId uint8) bool {
\ti := p.pos
\tif i >= p.maxLook { p.maxLook = i + 1 } // probe counts as lookahead (mirrors TS/Rust peek())
\tif i >= len(p.toks) || p.toks[i].Lid != lid { return false }
\tif ttId != TT_SKIP_PUNCT { p.scratch = append(p.scratch, encodeLeaf(uint32(i), ttId)) }
\tp.pos = i + 1
\treturn true
}
func (p *engine) matchTok(kid uint16, ttId uint8) bool {
\ti := p.pos
\tif i >= p.maxLook { p.maxLook = i + 1 }
\tif i >= len(p.toks) || p.toks[i].Kid != kid { return false }
\tif ttId != TT_SKIP_PUNCT { p.scratch = append(p.scratch, encodeLeaf(uint32(i), ttId)) }
\tp.pos = i + 1
\treturn true
}
// matchComp matches a composite '>'-led literal (a lookahead operand; never a tree leaf).
func (p *engine) matchComp(lid uint16) bool {
\tif p.peek() == nil { return false }
\tc, n, _ := gtOp(p.toks, p.pos)
\tif c != lid { return false }
\tif e := p.pos + n + 1; e > p.maxLook { p.maxLook = e }
\tp.pos += n; return true
}
// callRule pushes the node a rule call returned (id < 0: the rule did not match).
func (p *engine) callRule(id int32) bool {
\tif id < 0 { return false }
\tp.scratch = append(p.scratch, id); return true
}
func (p *engine) star(once func() bool) bool {
\tfor { sp := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids); if !once() { p.pos = sp; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]; break } }
\treturn true
}
func (p *engine) opt(body func() bool) bool {
\tsp := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids); if !body() { p.pos = sp; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb] }; return true
}
func (p *engine) sepBy(elem func() bool, delimLid uint16) bool {
\tsp0 := p.pos; sb0 := len(p.scratch); nb0 := len(p.nodes); kb0 := len(p.kids)
\tif !elem() { p.pos = sp0; p.scratch = p.scratch[:sb0]; p.nodes = p.nodes[:nb0]; p.kids = p.kids[:kb0]; return true }
\tfor {
\t\tsp := p.pos; sb := len(p.scratch); nb := len(p.nodes); kb := len(p.kids)
\t\tif !p.matchLit(delimLid, TT_SKIP_PUNCT) { p.pos = sp; p.scratch = p.scratch[:sb]; p.nodes = p.nodes[:nb]; p.kids = p.kids[:kb]; break }
\t\tsp2 := p.pos; sb2 := len(p.scratch); nb2 := len(p.nodes); kb2 := len(p.kids)
\t\tif !elem() { p.pos = sp2; p.scratch = p.scratch[:sb2]; p.nodes = p.nodes[:nb2]; p.kids = p.kids[:kb2]; break }   // trailing delim OK — keep delim
\t}
\treturn true
}
func (p *engine) altLit(opts []struct{ Lid uint16; TtId uint8 }) bool {
\tfor _, o := range opts { if p.matchLit(o.Lid, o.TtId) { return true } }
\treturn false
}

${matchTemplate}${ruleFns}

func (p *engine) writeJSON(id int32, b *strings.Builder) { writeJSONWith(p.nodes, p.kids, p.toks, id, b) }

func (p *engine) headLeafText(id int32) string {
\tfor {
\t\tif id < 0 {
\t\t\tti, _ := decodeLeaf(id)
\t\t\tt := p.toks[ti]
\t\t\treturn p.src[t.Off:t.End]
\t\t}
\t\tnd := &p.nodes[id]
\t\tif nd.KidCount == 0 { break }
\t\tid = p.kids[nd.KidStart]
\t}
\tnd := &p.nodes[id]
\treturn p.src[nd.Offset:nd.End]
}
func _inW(ws []string, s string) bool { for _, w := range ws { if w == s { return true } }; return false }

// parse runs the parser over t, the tokens of src, into p's arena (internal — the public CST
// entries are ParseWith / NewDoc). src is also the source head-leaf lookups read.
func (p *engine) parse(src string, t []Tok) int32 {
\tp.src = src
\tp.toks = t
\tp.pos = 0
\tp.maxLook = 0
\tp.nodes = p.nodes[:0]; p.kids = p.kids[:0]; p.scratch = p.scratch[:0]
\troot := p.parse${ir.entry}()
\tp.arenaBaseline = len(p.nodes)
\t// Full-consumption guard (mirrors the TS wrapper): a partial parse is a reject, not a
\t// tree. Without this, Doc keeps a partial root after a rejecting edit and the next
\t// edit's reuse path resurrects it as if it were a valid old tree.
\tif root >= 0 && p.pos != len(p.toks) { return -1 }
\treturn root
}

${docEditBlockGo(ir, shared)}
${emitBuilderAddonGo(ir, ids, ar)}
`;
  },
  emitRunner(): string {
    return `// CLI runner (harness only): stdin -> CST JSON + a self-bench mode. A SEPARATE file; the
// gate writes it as runner.go next to the parser library with the library's package clause
// set to main, so the two build into an executable. NOT part of the parser.
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
\t\t\tp := &engine{}
\t\t\tfor i := 0; i < 3; i++ { p.parse(src, lex(src)) }
\t\t\tt0 := time.Now()
\t\t\tfor i := 0; i < iters; i++ { p.parse(src, lex(src)) }
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
\t\tif d.Root() < 0 { fmt.Fprintln(os.Stderr, "parse error"); os.Exit(1) }
\t\tos.Stdout.WriteString(d.CstJSON())
\t\treturn
\t}
\tif len(os.Args) > 1 && os.Args[1] == "tok-spans" {
\t\tp := &engine{}
\t\troot := p.parse(src, lex(src))
\t\tif root < 0 || p.pos != len(p.toks) {
\t\t\tfmt.Fprintf(os.Stderr, "parse error (pos %d/%d)\\n", p.pos, len(p.toks))
\t\t\tos.Exit(1)
\t\t}
\t\tnd := &p.nodes[root]
\t\tfor i := uint32(0); i < nd.KidCount; i++ {
\t\t\tv := p.kids[nd.KidStart+i]
\t\t\tif v < 0 {
\t\t\t\tti, tt := decodeLeaf(v)
\t\t\t\tfmt.Printf("%s\\t%d\\t%d\\n", TT_NAMES[tt], ti, ti+1)
\t\t\t} else {
\t\t\t\tk := &p.nodes[v]
\t\t\t\tfmt.Printf("%s\\t%d\\t%d\\n", RULE_NAMES[k.RuleId], k.TokStart, k.TokEnd)
\t\t\t}
\t\t}
\t\tfmt.Printf("total\\t0\\t%d\\n", p.pos)
\t\treturn
\t}
\tp := &engine{}
\troot := p.parse(src, lex(src))
\tif root < 0 || p.pos != len(p.toks) {
\t\tfmt.Fprintf(os.Stderr, "parse error (pos %d/%d)\\n", p.pos, len(p.toks))
\t\tos.Exit(1)
\t}
\tvar b strings.Builder
\tp.writeJSON(root, &b)
\tos.Stdout.WriteString(b.String())
}
`;
  },
});
