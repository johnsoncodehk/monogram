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
import type { ParserIR, RdRule, PrattRule, Step, Bracket, CharRange, LexTok, TplCfg, NewlineCfg, FirstSig } from './emit-portable.ts';
import { portableIR } from './emit-portable.ts';
import type { Target } from './emit.ts';
import type { TokenPattern, CstGrammar } from './types.ts';

const J = (v: unknown) => JSON.stringify(v);
const rangeCond = (v: string, rs: CharRange[]) =>
  '(' + rs.map(([lo, hi]) => (lo === hi ? `${v} == ${lo}` : `${v} >= ${lo} && ${v} <= ${hi}`)).join(' || ') + ')';

// Boolean expr testing whether the buffered token t starts branch i (FIRST set membership).
const firstCond = (f: FirstSig, t: string) => f
  ? `(${f.lits.map((l) => `${t}.Text == ${J(l)}`).join(' || ') || 'false'} || ${f.toks.map((k) => `${t}.Kind == ${J(k)}`).join(' || ') || 'false'})`
  : 'false';

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

function scanTok(t: LexTok, defs: string[], stateful: boolean, rxTok?: string, tplTok?: string): string {
  const name = (t as { name: string }).name;
  if (tplTok !== undefined && name === tplTok) return '';   // template token scanned by the state machine
  const push = (endE: string) => (t.skip ? `if strings.ContainsAny(src[pos:${endE}], "\\n\\r\\u2028\\u2029") { pendingNl = true }; ` : stateful ? `emit(${J(name)}, src[pos:${endE}], pos, ${endE}); ` : `pushTok(${J(name)}, src[pos:${endE}], pos, ${endE}); `);
  const gate = rxTok !== undefined && name === rxTok ? '!prevIsValue() && ' : '';
  if (t.kind === 'run') return `\t\tif ${gate}${rangeCond('c', t.first)} {
\t\t\te := pos + 1
\t\t\tfor e < n { cc := int(src[e]); if !${rangeCond('cc', t.cont)} { break }; e++ }
\t\t\t${push('e')}pos = e; continue
\t\t}`;
  if (t.kind === 'string') return `\t\tif ${gate}c == ${t.delim.charCodeAt(0)} {
\t\t\te := pos + 1
\t\t\tfor e < n { ch := int(src[e]); if ch == 92 { e += 2; continue }; if ch == ${t.delim.charCodeAt(0)} { e++; break }; e++ }
\t\t\t${push('e')}pos = e; continue
\t\t}`;
  if (t.kind === 'line') return `\t\tif ${gate}strings.HasPrefix(src[pos:], ${J(t.prefix)}) {
\t\t\te := pos + ${t.prefix.length}
\t\t\tfor e < n && src[e] != 10 { e++ }
\t\t\t${push('e')}pos = e; continue
\t\t}`;
  if (t.kind === 'block') return `\t\tif ${gate}strings.HasPrefix(src[pos:], ${J(t.open)}) {
\t\t\te := pos + ${t.open.length}
\t\t\tfor e < n && !strings.HasPrefix(src[e:], ${J(t.close)}) { e++ }
\t\t\tif e < n { e += ${t.close.length} }
\t\t\t${push('e')}pos = e; continue
\t\t}`;
  const m = compilePat(t.pattern, defs);
  return `\t\tif ${gate ? gate + 'true' : 'true'} { if e := ${m}(pos); e > pos { ${push('e')}pos = e; continue } }`;
}

function newlinePartsGo(nl: NewlineCfg, pushFn: string): { state: string; stateFrom: string; boundary: string; ws: string; hooks: string } {
  const commentSkip = nl.comment
    ? `\t\tif strings.HasPrefix(src[p:], ${J(nl.comment)}) { e := p; for e < n && src[e] != 10 { e++ }; pos = e; continue }\n`
    : '';
  return {
    state: `\tlineStart, emittedContent, flowDepth := true, false, 0
\t_flowOpen := map[string]bool{${nl.flowOpen.map((x) => `${J(x)}: true`).join(', ')}}
\t_flowClose := map[string]bool{${nl.flowClose.map((x) => `${J(x)}: true`).join(', ')}}
\tconst _nlTok = ${J(nl.token)}
`,
    stateFrom: `\t_flowOpen := map[string]bool{${nl.flowOpen.map((x) => `${J(x)}: true`).join(', ')}}
\t_flowClose := map[string]bool{${nl.flowClose.map((x) => `${J(x)}: true`).join(', ')}}
\tconst _nlTok = ${J(nl.token)}
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
\t\t\tif emittedContent { ${pushFn}(_nlTok, "", pos, pos) }
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
    hooks: `\t\tif kind != _nlTok { emittedContent = true }
\t\tif kind == "" && _flowOpen[text] { flowDepth++ } else if kind == "" && _flowClose[text] { if flowDepth > 0 { flowDepth-- } }
`,
  };
}

function lexer(ir: ParserIR): string {
  const defs: string[] = [];
  const rx = ir.regexCtx;
  const tpl = ir.tpl;
  const nl = ir.newlineCfg;
  const rxOnly = !!(rx && !tpl && !nl);
  const rxOrTpl = !!(rx || tpl) && !rxOnly;
  const stateful = !!(rx || tpl);
  const newlineOnly = !!(nl && !rx && !tpl);
  const toks = ir.tokens.map((t) => scanTok(t, defs, stateful, rx?.regexToken, tpl?.token)).join('\n');
  const pushPunct = stateful ? (p: string) => `emit("", ${J(p)}, pos, pos + ${p.length})` : (p: string) => `pushTok("", ${J(p)}, pos, pos + ${p.length})`;
  const puncts = ir.puncts.map((p) =>
    `\t\tif strings.HasPrefix(src[pos:], ${J(p)}) { ${pushPunct(p)}; pos += ${p.length}; continue }`).join('\n');
  const goMap = (a: string[]) => `map[string]bool{${a.map((x) => `${J(x)}: true`).join(', ')}}`;
  const rxState = rx ? `\tprevText, prevKind, bpText := "", "", ""
\thasPrev, hasPrev2 := false, false
\tparenHead := []bool{}
\tlastClose, lastBang := false, false
\t_divT := ${goMap(rx.divisionTexts)}
\t_divK := ${goMap(rx.divisionTypes)}
\t_rxT := ${goMap(rx.regexTexts)}
\t_phK := ${goMap(rx.parenHeadKw)}
\t_mem := ${goMap(rx.memberAccess)}
\t_pav := ${goMap(rx.postfixAfterValue)}
\tconst IDENT = ${J(rx.identToken)}
\tprevIsValue := func() bool {
\t\tif !hasPrev { return false }
\t\tif _pav[prevText] { return lastBang }
\t\tisExprKw := prevKind == IDENT && _rxT[prevText]
\t\tisParenHead := prevText == ")" && lastClose
\t\treturn !isExprKw && !isParenHead && (_divK[prevKind] || _divT[prevText])
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
\t\treturn false, p
\t}
\t_ = scanTplSpan
` : '';
  const emitHooks = [
    rx ? `\t\tif text == "(" {
\t\t\tisMember := hasPrev2 && _mem[bpText]
\t\t\tparenHead = append(parenHead, !isMember && prevKind == IDENT && _phK[prevText])
\t\t} else if text == ")" {
\t\t\tif len(parenHead) > 0 { lastClose = parenHead[len(parenHead)-1]; parenHead = parenHead[:len(parenHead)-1] } else { lastClose = false }
\t\t}
\t\tif _pav[text] { lastBang = prevIsValue() }` : '',
    tpl ? `\t\tif len(templateStack) > 0 { if text == ${J(tpl.braceOpen)} { templateStack[len(templateStack)-1]++ } else if text == ${J(tpl.interpClose)} { templateStack[len(templateStack)-1]-- } }` : '',
    nl ? newlinePartsGo(nl, 'emit').hooks : '',
  ].filter(Boolean).join('\n');
  const emitTail = rx ? `\n\t\tbpText = prevText; hasPrev2 = hasPrev; prevKind = kind; prevText = text; hasPrev = true` : '';
  const emitFn = stateful ? `\temit := func(kind, text string, off, end int) {
${emitHooks}
\t\ttoks = append(toks, Tok{kind, text, off, end, pendingNl}); pendingNl = false${emitTail}
\t}
\t_ = emit
` : '';
  const rxStateFrom = rx ? `\t_divT := ${goMap(rx.divisionTexts)}
\t_divK := ${goMap(rx.divisionTypes)}
\t_rxT := ${goMap(rx.regexTexts)}
\t_phK := ${goMap(rx.parenHeadKw)}
\t_mem := ${goMap(rx.memberAccess)}
\t_pav := ${goMap(rx.postfixAfterValue)}
\tconst IDENT = ${J(rx.identToken)}
\tprevIsValue := func() bool {
\t\tif !hasPrev { return false }
\t\tif _pav[prevText] { return lastBang }
\t\tisExprKw := prevKind == IDENT && _rxT[prevText]
\t\tisParenHead := prevText == ")" && lastClose
\t\treturn !isExprKw && !isParenHead && (_divK[prevKind] || _divT[prevText])
\t}
\temit := func(kind, text string, off, end int) {
\t\tif text == "(" {
\t\t\tisMember := hasPrev2 && _mem[bpText]
\t\t\tparenHead = append(parenHead, !isMember && prevKind == IDENT && _phK[prevText])
\t\t} else if text == ")" {
\t\t\tif len(parenHead) > 0 { lastClose = parenHead[len(parenHead)-1]; parenHead = parenHead[:len(parenHead)-1] } else { lastClose = false }
\t\t}
\t\tif _pav[text] { lastBang = prevIsValue() }
\t\t*acc = append(*acc, Tok{kind, text, off, end, pendingNl}); pendingNl = false
\t\tbpText = prevText; hasPrev2 = hasPrev; prevKind = kind; prevText = text; hasPrev = true
\t}
\t_ = emit
` : '';
  const tplDispatch = tpl ? `\t\tif len(templateStack) > 0 && strings.HasPrefix(src[pos:], ${J(tpl.interpClose)}) && templateStack[len(templateStack)-1] == 0 {
\t\t\ttemplateStack = templateStack[:len(templateStack)-1]
\t\t\tinterp, e := scanTplSpan(pos + ${tpl.interpClose.length})
\t\t\tif interp { emit("$templateMiddle", src[pos:e], pos, e); templateStack = append(templateStack, 0) } else { emit("$templateTail", src[pos:e], pos, e) }
\t\t\tpos = e; continue
\t\t}
\t\tif strings.HasPrefix(src[pos:], ${J(tpl.open)}) {
\t\t\tinterp, e := scanTplSpan(pos + ${tpl.open.length})
\t\t\tif interp { emit("$templateHead", src[pos:e], pos, e); templateStack = append(templateStack, 0) } else { emit(${J(tpl.token)}, src[pos:e], pos, e) }
\t\t\tpos = e; continue
\t\t}
` : '';
  const nlState = nl ? newlinePartsGo(nl, stateful ? 'emit' : 'pushTok').state : '';
  const nlStateFrom = nl ? newlinePartsGo(nl, 'pushTok').stateFrom : '';
  const nlBoundary = nl ? newlinePartsGo(nl, stateful ? 'emit' : 'pushTok').boundary : '';
  const nlWs = nl ? newlinePartsGo(nl, stateful ? 'emit' : 'pushTok').ws : `\t\tif strings.HasPrefix(src[pos:], ${J('\u2028')}) || strings.HasPrefix(src[pos:], ${J('\u2029')}) { pendingNl = true; pos += 3; continue }   // LS/PS (UTF-8)
\t\tif c == 10 || c == 13 { pendingNl = true; pos++; continue }   // LF/CR
\t\tif c == 32 || c == 9 || c == 11 || c == 12 || c == 160 || c == 5760 || (c >= 8192 && c <= 8202) || c == 8239 || c == 8287 || c == 12288 || c == 65279 { pos++; continue }
`;
  const pushHooks = nl && !stateful ? newlinePartsGo(nl, 'pushTok').hooks : '';
  const pushTokFn = stateful ? '' : nl
    ? `\tpushTok := func(kind, text string, off, end int) {
${pushHooks}\t\ttoks = append(toks, Tok{kind, text, off, end, pendingNl}); pendingNl = false
\t}
\t_ = pushTok
`
    : `\tpushTok := func(kind, text string, off, end int) { toks = append(toks, Tok{kind, text, off, end, pendingNl}); pendingNl = false }\n\t_ = pushTok\n`;
  const pushTokAccFn = nl && !stateful
    ? `\tpushTok := func(kind, text string, off, end int) {
${pushHooks}\t\t*acc = append(*acc, Tok{kind, text, off, end, pendingNl}); pendingNl = false
\t}
\t_ = pushTok
`
    : `\tpushTok := func(kind, text string, off, end int) { *acc = append(*acc, Tok{kind, text, off, end, pendingNl}); pendingNl = false }
\t_ = pushTok
`;
  const loopBody = `${nlBoundary}\t\tc := int(src[pos])
${nlWs}${tplDispatch}${toks}
${puncts}
\t\tpanic(fmt.Sprintf("lex error at %d", pos))`;
  if (rxOnly) {
    return `${defs.length ? 'var _s string\n' + defs.join('\n') + '\n' : ''}func lexFrom(src string, pos int, pendingNl bool, prevText, prevKind, bpText string, hasPrev, hasPrev2 bool, parenHead []bool, lastClose, lastBang bool, acc *[]Tok, limit int) (int, bool, string, string, string, bool, bool, []bool, bool, bool) {
\tn := len(src)
${rxStateFrom}${defs.length ? '\t_s = src\n' : ''}\tbase := len(*acc)
\tfor pos < n && (limit <= 0 || len(*acc)-base < limit) {
${loopBody}
\t}
\treturn pos, pendingNl, prevText, prevKind, bpText, hasPrev, hasPrev2, parenHead, lastClose, lastBang
}
func lex(src string) []Tok {
\tvar out []Tok
\tlexFrom(src, 0, false, "", "", "", false, false, nil, false, false, &out, 0)
\treturn out
}`;
  }
  if (rxOrTpl) {
    return `${defs.length ? 'var _s string\n' + defs.join('\n') + '\n' : ''}func lex(src string) []Tok {
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
    return `${defs.length ? 'var _s string\n' + defs.join('\n') + '\n' : ''}func lexFrom(src string, pos int, pendingNl bool, lineStart bool, emittedContent bool, flowDepth int, acc *[]Tok, limit int) (int, bool, bool, bool, int) {
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
  return `${defs.length ? 'var _s string\n' + defs.join('\n') + '\n' : ''}func lexFrom(src string, pos int, pendingNl bool, acc *[]Tok, limit int) (int, bool) {
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

function stepCond(s: Step): string {
  switch (s.t) {
    case 'lit': return `matchLit(${J(s.value)}, ${J(s.ttype)})`;
    case 'tok': return `matchTok(${J(s.name)})`;
    case 'rule': return `callRule(parse${s.name})`;
    case 'ruleBp': return `callRule(func() int32 { return ${s.name}bp(${s.bp}) })`;
    case 'star': return `star(func() bool { return ${stepCond(s.step)} })`;
    case 'opt': return `opt(func() bool { return ${s.steps.map(stepCond).join(' && ')} })`;
    case 'sep': return `sepBy(func() bool { return ${stepCond(s.elem)} }, ${J(s.delim)})`;
    case 'altlit': return `altLit([][2]string{${s.opts.map((o) => `{${J(o.value)}, ${J(o.ttype)}}`).join(', ')}})`;
    case 'alt': return s.predictive ? `func() bool { ${predAltBody(s.branches, s.firsts)} }()` : `func() bool { ${s.branches.map((br) => `{ save := pos; sb := len(scratch); nb := len(nodes); kb := len(kids); if ${br.length ? br.map(stepCond).join(' && ') : 'true'} { return true }; pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb] }`).join('; ')}; return false }()`;
    case 'not': return `func() bool { save := pos; sb := len(scratch); nb := len(nodes); kb := len(kids); m := ${s.steps.length ? s.steps.map(stepCond).join(' && ') : 'true'}; pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; return !m }()`;
    case 'seq': return `(${s.steps.length ? s.steps.map(stepCond).join(' && ') : 'true'})`;
    case 'sameLine': return `func() bool { t := peek(); return t != nil && !t.Nl }()`;
    case 'suppress': return `func() bool { _suppressNext = map[string]bool{${s.connectors.map((c) => `${J(c)}: true`).join(', ')}}; _r := (${s.steps.length ? s.steps.map(stepCond).join(' && ') : 'true'}); _suppressNext = nil; return _r }()`;
  }
}

function predAltBody(branches: Step[][], firsts?: FirstSig[]): string {
  const arms = branches.map((br, i) => `if ${firstCond(firsts![i], 't')} { if ${br.length ? br.map(stepCond).join(' && ') : 'true'} { return true } }`).join(' else ');
  return `t := peek(); if t == nil { return false }; ${arms}; return false`;
}

function rdRule(r: RdRule): string {
  if (r.predictive) {
    const arm = (steps: Step[], i: number) => `\t${i === 0 ? 'if' : 'else if'} ${firstCond(r.altFirst[i], 't')} { if ${steps.map(stepCond).join(' && ')} { return finish(${J(r.cstName)}, sb, offAt(save)) } }`;
    return `func parse${r.name}() int32 {
\tsave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\tt := peek(); if t == nil { return -1 }
${r.alts.map(arm).join(' ')}
\tpos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]
\treturn -1
}`;
  }
  const alt = (steps: Step[]) =>
    `\tif ${steps.map(stepCond).join(' && ')} { return finish(${J(r.cstName)}, sb, offAt(save)) }
\tpos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]`;
  return `func parse${r.name}() int32 {
\tsave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
${r.alts.map(alt).join('\n')}
\treturn -1
}`;
}

function prattRule(r: PrattRule, tpl: TplCfg | null): string {
  const tplNud = tpl && r.nudToks.includes(tpl.token)
    ? `\tif t.Kind == "$templateHead" {
\t\tnode := matchTemplate()
\t\tif node < 0 { return -1 }
\t\tsb := len(scratch); scratch = append(scratch, node)
\t\treturn finish(${J(r.cstName)}, sb, nodes[node].Offset)
\t}\n`
    : '';
  const bin = r.binary.map((b) => `${J(b.op)}: {${b.lbp}, ${b.rbp}}`).join(', ');
  const pre = r.prefix.map((p) => `${J(p.op)}: ${p.rbp}`).join(', ');
  const atoms = r.nudToks.map((k) => `${J(k)}: true`).join(', ');
  const bracketNud = (b: Bracket) => `\tif t.Text == ${J(b.first)} {
\t\tsave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\t\tif ${b.steps.map(stepCond).join(' && ')} { return finish(${J(r.cstName)}, sb, t.Off) }
\t\tpos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]
\t}`;
  const ledArm = (b: Bracket, accessTail: boolean, lbp: number | null, sameLine: boolean, nll: string[] | null) => `\t\tif ${accessTail ? '!tailClosed && ' : ''}${lbp !== null ? `${lbp} > minBp && ` : ''}${sameLine ? '!t.Nl && ' : ''}${nll ? `!_inW([]string{${nll.map(J).join(', ')}}, headLeafText(left)) && ` : ''}!_suppressCur[${J(b.first)}] && t.Text == ${J(b.first)} {
\t\t\tledSave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\t\t\tscratch = append(scratch, left)
\t\t\tif ${b.steps.map(stepCond).join(' && ')} { left = finish(${J(r.cstName)}, sb, nodes[left].Offset); continue }
\t\t\tpos = ledSave; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; break
\t\t}`;
  const postfixArm = (tok: string) => {
    const tplPart = tpl && tok === tpl.token ? `
\t\tif !tailClosed && t.Kind == "$templateHead" {
\t\t\tnode := matchTemplate()
\t\t\tif node >= 0 { sb := len(scratch); scratch = append(scratch, left, node); left = finish(${J(r.cstName)}, sb, nodes[left].Offset); continue }
\t\t}` : '';
    return `\t\tif !tailClosed && t.Kind == ${J(tok)} {
\t\t\tsb := len(scratch); scratch = append(scratch, left, mkLeaf(t.Kind, t.Off, t.End)); pos++
\t\t\tleft = finish(${J(r.cstName)}, sb, nodes[left].Offset); continue
\t\t}${tplPart}`;
  };
  const post = r.postfix.map((p) => `${J(p.op)}: ${p.lbp}`).join(', ');
  return `var ${r.name}BIN = map[string]bp{${bin}}
var ${r.name}PRE = map[string]int{${pre}}
var ${r.name}POST = map[string]int{${post}}
var ${r.name}ATOM = map[string]bool{${atoms}}
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
\tfor {
\t\tt := peek()
\t\tif t == nil { break }
${r.leds.map((b, i) => ledArm(b, r.ledAccessTail[i], r.ledLbp[i], r.ledSameLine[i], r.ledNotLeftLeaf[i])).join('\n')}
${r.postfixToks.map(postfixArm).join('\n')}
\t\tif post, ok := ${r.name}POST[t.Text]; ok && !tailClosed && post > minBp {
\t\t\tsb := len(scratch); scratch = append(scratch, left, mkLeaf("$operator", t.Off, t.End)); pos++; tailClosed = true
\t\t\tleft = finish(${J(r.cstName)}, sb, nodes[left].Offset); continue
\t\t}
\t\tinfo, ok := ${r.name}BIN[t.Text]
\t\tif !ok || info.lbp <= minBp { break }
\t\tledSave := pos; sb := len(scratch)
\t\tscratch = append(scratch, left, mkLeaf("$operator", t.Off, t.End))
\t\tpos++
\t\trhs := ${r.name}bp(info.rbp)
\t\tif rhs < 0 { pos = ledSave; scratch = scratch[:sb]; break }
\t\tscratch = append(scratch, rhs)
\t\tleft = finish(${J(r.cstName)}, sb, nodes[left].Offset)
\t}
\treturn left
}
func ${r.name}nud(minBp int) int32 {
\t_capped = false
\tt := peek()
\tif t == nil { return -1 }
${r.nudCapped.map((c) => `\tif minBp < ${c.capBp} { save := pos; sb := len(scratch); nb := len(nodes); kb := len(kids); if ${c.steps.length ? c.steps.map(stepCond).join(' && ') : 'true'} { _capped = true; return finish(${J(r.cstName)}, sb, offAt(save)) }; pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb] }`).join('\n')}
\t_r := func() int32 {   // non-capped: a sub-parse may leave _capped set; force it false after
${tplNud}\tif ${r.name}ATOM[t.Kind] {
\t\tsb := len(scratch); scratch = append(scratch, mkLeaf(t.Kind, t.Off, t.End)); pos++
\t\treturn finish(${J(r.cstName)}, sb, t.Off)
\t}
${r.nudBrackets.map(bracketNud).join('\n')}
\tif pbp, ok := ${r.name}PRE[t.Text]; ok {
\t\tsave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\t\tscratch = append(scratch, mkLeaf("$operator", t.Off, t.End)); pos++
\t\toperand := ${r.name}bp(pbp)
\t\tif operand < 0 { pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; return -1 }
\t\tscratch = append(scratch, operand)
\t\treturn finish(${J(r.cstName)}, sb, t.Off)
\t}
${r.nudSeqs.map((seq) => `\t{ save := pos; sb := len(scratch); nb := len(nodes); kb := len(kids); if ${seq.length ? seq.map(stepCond).join(' && ') : 'true'} { return finish(${J(r.cstName)}, sb, offAt(save)) }; pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb] }`).join('\n')}
\treturn -1
\t}()
\t_capped = false
\treturn _r
}`;
}

function docEditBlockGo(ir: ParserIR): string {
  const windowLex = !ir.tpl && (!ir.regexCtx || !ir.newlineCfg);
  const hasNewline = !!(ir.newlineCfg && !ir.regexCtx && !ir.tpl);
  const rxOnly = !!(ir.regexCtx && !ir.tpl && !ir.newlineCfg);
  const zeroMeta = ', Pd: 0, Lc: false, Lb: false, Hd: false';
  const windowHelpers = windowLex ? (hasNewline ? `
func findTokAtOffKind(toks []alignMeta, off int, kind string) int {
\tlo, hi := 0, len(toks)-1
\thit := -1
\tfor lo <= hi {
\t\tmid := (lo + hi) >> 1
\t\tif toks[mid].Off < off { lo = mid + 1 } else if toks[mid].Off > off { hi = mid - 1 } else { hit = mid; break }
\t}
\tif hit < 0 { return -1 }
\tstart := hit
\tfor start > 0 && toks[start-1].Off == off { start-- }
\tfor i := start; i < len(toks) && toks[i].Off == off; i++ {
\t\tif toks[i].Kind == kind { return i }
\t}
\treturn -1
}
func windowRelexStep(oldText string, oldToks []alignMeta, newText string, start, end int, ins string) ([]alignMeta, int) {
\tdelta := len(ins) - (end - start)
\teditEnd := start + len(ins)
\tmaxIdx := -1
\tfor i := 0; i < len(oldToks); i++ {
\t\tif oldToks[i].End < start { maxIdx = i } else { break }
\t}
\trb := -1
\tif maxIdx >= 0 { rb = maxIdx - 1 }
\tvar out []alignMeta
\tif rb >= 0 { out = append(out, oldToks[:rb+1]...) }
\tvar scanOff int
\tvar pendingNl, lineStart, emittedContent bool
\tvar flowDepth int
\tif rb >= 0 {
\t\tscanOff = oldToks[rb].End; pendingNl = false; lineStart = false; emittedContent = true; flowDepth = oldToks[rb].Fd
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
\t\tout = append(out, alignMeta{t.Kind, t.Off, t.End, t.Nl, flowDepth, 0, false, false, false})
\t\trelexed++
\t\tif t.Off >= editEnd {
\t\t\toIdx := findTokAtOffKind(oldToks, t.Off-delta, t.Kind)
\t\t\tif oIdx >= 0 {
\t\t\t\to := oldToks[oIdx]
\t\t\t\tif o.Kind == t.Kind && o.End == t.End-delta && o.Nl == t.Nl && o.Fd == flowDepth && oldText[o.Off:o.End] == newText[t.Off:t.End] {
\t\t\t\t\tfor j := oIdx + 1; j < len(oldToks); j++ {
\t\t\t\t\t\tot := oldToks[j]
\t\t\t\t\t\tout = append(out, alignMeta{ot.Kind, ot.Off + delta, ot.End + delta, ot.Nl, ot.Fd, ot.Pd, ot.Lc, ot.Lb, ot.Hd})
\t\t\t\t\t}
\t\t\t\t\treturn out, relexed
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\treturn out, relexed
}
` : rxOnly ? `
func findTokAtOff(toks []alignMeta, off int) int {
\tlo, hi := 0, len(toks)-1
\tfor lo <= hi {
\t\tmid := (lo + hi) >> 1
\t\tif toks[mid].Off < off { lo = mid + 1 } else if toks[mid].Off > off { hi = mid - 1 } else { return mid }
\t}
\treturn -1
}
func reconstructParens(toks []alignMeta, text string, b int) []bool {
\tneed := 0
\tif b >= 0 { need = toks[b].Pd }
\tout := make([]bool, 0, need)
\tfor i := b; i >= 0 && need > 0; i-- {
\t\tt := toks[i]
\t\tif text[t.Off:t.End] == "(" && t.Pd == need {
\t\t\tout = append([]bool{t.Hd}, out...)
\t\t\tneed--
\t\t}
\t}
\treturn out
}
func parenStacksEq(a, b []bool) bool {
\tif len(a) != len(b) { return false }
\tfor i := range a { if a[i] != b[i] { return false } }
\treturn true
}
func windowRelexStep(oldText string, oldToks []alignMeta, newText string, start, end int, ins string) ([]alignMeta, int) {
\tdelta := len(ins) - (end - start)
\teditEnd := start + len(ins)
\tmaxIdx := -1
\tfor i := 0; i < len(oldToks); i++ {
\t\tif oldToks[i].End < start { maxIdx = i } else { break }
\t}
\trb := -1
\tif maxIdx >= 0 { rb = maxIdx - 1 }
\tvar out []alignMeta
\tif rb >= 0 { out = append(out, oldToks[:rb+1]...) }
\tvar scanOff int
\tpendingNl := false
\tprevText, prevKind, bpText := "", "", ""
\thasPrev, hasPrev2 := false, false
\tvar parenHead []bool
\tlastClose, lastBang := false, false
\tif rb >= 0 {
\t\tanchor := oldToks[rb]
\t\tscanOff = anchor.End
\t\tprevText = oldText[anchor.Off:anchor.End]
\t\tprevKind = anchor.Kind
\t\thasPrev = true
\t\tif rb >= 1 {
\t\t\tbpText = oldText[oldToks[rb-1].Off:oldToks[rb-1].End]
\t\t\thasPrev2 = true
\t\t}
\t\tlastClose = anchor.Lc
\t\tlastBang = anchor.Lb
\t\tparenHead = reconstructParens(oldToks, oldText, rb)
\t}
\tvar scratch []Tok
\trelexed := 0
\tfor scanOff < len(newText) {
\t\tbefore := len(scratch)
\t\tscanOff, pendingNl, prevText, prevKind, bpText, hasPrev, hasPrev2, parenHead, lastClose, lastBang = lexFrom(newText, scanOff, pendingNl, prevText, prevKind, bpText, hasPrev, hasPrev2, parenHead, lastClose, lastBang, &scratch, 1)
\t\tif len(scratch) == before { break }
\t\tt := scratch[len(scratch)-1]
\t\ttxt := newText[t.Off:t.End]
\t\thd := false
\t\tif txt == "(" && len(parenHead) > 0 { hd = parenHead[len(parenHead)-1] }
\t\tout = append(out, alignMeta{t.Kind, t.Off, t.End, t.Nl, 0, len(parenHead), lastClose, lastBang, hd})
\t\trelexed++
\t\tif t.Off >= editEnd {
\t\t\toIdx := findTokAtOff(oldToks, t.Off-delta)
\t\t\tif oIdx >= 0 {
\t\t\t\to := oldToks[oIdx]
\t\t\t\tnewPrevText := ""
\t\t\t\tif len(out) > 1 { p := out[len(out)-2]; newPrevText = newText[p.Off:p.End] }
\t\t\t\toldPrevText := ""
\t\t\t\tif oIdx >= 1 { p := oldToks[oIdx-1]; oldPrevText = oldText[p.Off:p.End] }
\t\t\t\tbpOk := newPrevText == oldPrevText
\t\t\t\toldStack := reconstructParens(oldToks, oldText, oIdx)
\t\t\t\tif o.Pd == len(parenHead) && parenStacksEq(oldStack, parenHead) && o.Lc == lastClose && o.Lb == lastBang && bpOk && o.Kind == t.Kind && o.End == t.End-delta && o.Nl == t.Nl && oldText[o.Off:o.End] == newText[t.Off:t.End] {
\t\t\t\t\tfor j := oIdx + 1; j < len(oldToks); j++ {
\t\t\t\t\t\tot := oldToks[j]
\t\t\t\t\t\tout = append(out, alignMeta{ot.Kind, ot.Off + delta, ot.End + delta, ot.Nl, ot.Fd, ot.Pd, ot.Lc, ot.Lb, ot.Hd})
\t\t\t\t\t}
\t\t\t\t\treturn out, relexed
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\treturn out, relexed
}
` : `
func findTokAtOff(toks []alignMeta, off int) int {
\tlo, hi := 0, len(toks)-1
\tfor lo <= hi {
\t\tmid := (lo + hi) >> 1
\t\tif toks[mid].Off < off { lo = mid + 1 } else if toks[mid].Off > off { hi = mid - 1 } else { return mid }
\t}
\treturn -1
}
func windowRelexStep(oldText string, oldToks []alignMeta, newText string, start, end int, ins string) ([]alignMeta, int) {
\tdelta := len(ins) - (end - start)
\teditEnd := start + len(ins)
\tmaxIdx := -1
\tfor i := 0; i < len(oldToks); i++ {
\t\tif oldToks[i].End < start { maxIdx = i } else { break }
\t}
\trb := -1
\tif maxIdx >= 0 { rb = maxIdx - 1 }
\tvar out []alignMeta
\tif rb >= 0 { out = append(out, oldToks[:rb+1]...) }
\tscanOff := 0
\tif rb >= 0 { scanOff = oldToks[rb].End }
\tpendingNl := false
\tvar scratch []Tok
\trelexed := 0
\tfor scanOff < len(newText) {
\t\tbefore := len(scratch)
\t\tscanOff, pendingNl = lexFrom(newText, scanOff, pendingNl, &scratch, 1)
\t\tif len(scratch) == before { break }
\t\tt := scratch[len(scratch)-1]
\t\tout = append(out, alignMeta{t.Kind, t.Off, t.End, t.Nl, 0, 0, false, false, false})
\t\trelexed++
\t\tif t.Off >= editEnd {
\t\t\toIdx := findTokAtOff(oldToks, t.Off-delta)
\t\t\tif oIdx >= 0 {
\t\t\t\to := oldToks[oIdx]
\t\t\t\tif o.Kind == t.Kind && o.End == t.End-delta && o.Nl == t.Nl && oldText[o.Off:o.End] == newText[t.Off:t.End] {
\t\t\t\t\tfor j := oIdx + 1; j < len(oldToks); j++ {
\t\t\t\t\t\tot := oldToks[j]
\t\t\t\t\t\tout = append(out, alignMeta{ot.Kind, ot.Off + delta, ot.End + delta, ot.Nl, ot.Fd, ot.Pd, ot.Lc, ot.Lb, ot.Hd})
\t\t\t\t\t}
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
\tpos, pendingNl, lineStart, emittedContent, flowDepth := 0, false, true, false, 0
\tfor pos < len(src) {
\t\tbefore := len(toks)
\t\tpos, pendingNl, lineStart, emittedContent, flowDepth = lexFrom(src, pos, pendingNl, lineStart, emittedContent, flowDepth, &toks, 1)
\t\tif len(toks) == before { break }
\t\tt := toks[len(toks)-1]
\t\tmeta = append(meta, alignMeta{t.Kind, t.Off, t.End, t.Nl, flowDepth, 0, false, false, false})
\t}
\treturn meta
}
func toMeta(toks []Tok) []alignMeta { panic("use scanMeta for newline") }
` : rxOnly ? `
func scanMeta(src string) []alignMeta {
\tvar toks []Tok
\tvar meta []alignMeta
\tpos, pendingNl := 0, false
\tprevText, prevKind, bpText := "", "", ""
\thasPrev, hasPrev2 := false, false
\tvar parenHead []bool
\tlastClose, lastBang := false, false
\tfor pos < len(src) {
\t\tbefore := len(toks)
\t\tpos, pendingNl, prevText, prevKind, bpText, hasPrev, hasPrev2, parenHead, lastClose, lastBang = lexFrom(src, pos, pendingNl, prevText, prevKind, bpText, hasPrev, hasPrev2, parenHead, lastClose, lastBang, &toks, 1)
\t\tif len(toks) == before { break }
\t\tt := toks[len(toks)-1]
\t\ttxt := src[t.Off:t.End]
\t\thd := false
\t\tif txt == "(" && len(parenHead) > 0 { hd = parenHead[len(parenHead)-1] }
\t\tmeta = append(meta, alignMeta{t.Kind, t.Off, t.End, t.Nl, 0, len(parenHead), lastClose, lastBang, hd})
\t}
\treturn meta
}
func toMeta(toks []Tok) []alignMeta { panic("use scanMeta for regex") }
` : `func toMeta(toks []Tok) []alignMeta {
\tm := make([]alignMeta, len(toks))
\tfor i, t := range toks { m[i] = alignMeta{t.Kind, t.Off, t.End, t.Nl, 0, 0, false, false, false} }
\treturn m
}`;
  const checkStreamEqFn = hasNewline ? `
func checkStreamEq(text string, meta []alignMeta) bool {
\tfresh := scanMeta(text)
\tif len(fresh) != len(meta) { return false }
\tfor i := range fresh {
\t\tf, m := fresh[i], meta[i]
\t\tif f.Kind != m.Kind || f.Off != m.Off || f.End != m.End || f.Nl != m.Nl || f.Fd != m.Fd { return false }
\t\tif text[f.Off:f.End] != text[m.Off:m.End] { return false }
\t}
\treturn true
}
` : rxOnly ? `
func checkStreamEq(text string, meta []alignMeta) bool {
\tfresh := scanMeta(text)
\tif len(fresh) != len(meta) { return false }
\tfor i := range fresh {
\t\tf, m := fresh[i], meta[i]
\t\tif f.Kind != m.Kind || f.Off != m.Off || f.End != m.End || f.Nl != m.Nl || f.Pd != m.Pd || f.Lc != m.Lc || f.Lb != m.Lb || f.Hd != m.Hd { return false }
\t\tif text[f.Off:f.End] != text[m.Off:m.End] { return false }
\t}
\treturn true
}
` : `
func checkStreamEq(text string, meta []alignMeta) bool {
\tfresh := toMeta(tokenize(text))
\tif len(fresh) != len(meta) { return false }
\tfor i := range fresh {
\t\tf, m := fresh[i], meta[i]
\t\tif f.Kind != m.Kind || f.Off != m.Off || f.End != m.End || f.Nl != m.Nl { return false }
\t\tif text[f.Off:f.End] != text[m.Off:m.End] { return false }
\t}
\treturn true
}
`;
  const initToks = (hasNewline || rxOnly) ? 'scanMeta(src)' : 'toMeta(tokenize(src))';
  return `type Edit struct { Start, End int; Text string }
type alignMeta struct { Kind string; Off, End int; Nl bool; Fd, Pd int; Lc, Lb, Hd bool }
type Align struct {
\tOldN     int  \`json:"oldN"\`
\tNewN     int  \`json:"newN"\`
\tPrefix   int  \`json:"prefix"\`
\tSuffix   int  \`json:"suffix"\`
\tRelexed  int  \`json:"relexed"\`
\tStreamEq bool \`json:"streamEq"\`
}
${toMetaFn}
func computeAlignCore(oldText string, oldToks []alignMeta, newText string, newToks []alignMeta) (oldN, newN, prefix, suffix int) {
\toldN, newN = len(oldToks), len(newToks)
\tfor prefix < oldN && prefix < newN {
\t\to, n := oldToks[prefix], newToks[prefix]
\t\tif o.Kind != n.Kind || o.Off != n.Off || o.End != n.End || o.Nl != n.Nl { break }
\t\tif oldText[o.Off:o.End] != newText[n.Off:n.End] { break }
\t\tprefix++
\t}
\tdelta := len(newText) - len(oldText)
\tminN := oldN; if newN < minN { minN = newN }
\tfor prefix+suffix < minN {
\t\to, n := oldToks[oldN-1-suffix], newToks[newN-1-suffix]
\t\tif o.Kind != n.Kind || o.Nl != n.Nl || n.Off != o.Off+delta || n.End != o.End+delta { break }
\t\tif oldText[o.Off:o.End] != newText[n.Off:n.End] { break }
\t\tsuffix++
\t}
\treturn
}
func toksFromMeta(text string, meta []alignMeta) []Tok {
\tt := make([]Tok, len(meta))
\tfor i, m := range meta { t[i] = Tok{m.Kind, text[m.Off:m.End], m.Off, m.End, m.Nl} }
\treturn t
}
${checkStreamEqFn}${windowHelpers}type Doc struct { text string; root int32; toks []alignMeta; align *Align }
func NewDoc(src string) *Doc {
\td := &Doc{text: src}
\td.toks = ${initToks}
\td.root = parse(tokenize(src))
\treturn d
}
func (d *Doc) Text() string { return d.text }
func (d *Doc) Root() int32 { return d.root }
func (d *Doc) Align() *Align { return d.align }
func applyEdit(text string, e Edit) string {
\tn := len(text)
\tstart, end := e.Start, e.End
\tif start < 0 { start = 0 }
\tif start > n { start = n }
\tif end < start { end = start }
\tif end > n { end = n }
\treturn text[:start] + e.Text + text[end:]
}
func (d *Doc) Edit(edits []Edit) int32 {
\toldText, oldToks := d.text, d.toks
\trelexed := 0
${editBody}
\tstreamEq := checkStreamEq(d.text, d.toks)
\toldN, newN, prefix, suffix := computeAlignCore(oldText, oldToks, d.text, d.toks)
\td.align = &Align{oldN, newN, prefix, suffix, relexed, streamEq}
\td.root = parse(toksFromMeta(d.text, d.toks))
\treturn d.root
}`;
}

export const goTarget: Target = {
  name: 'go',
  ext: 'go',
  embedLexer(grammar: CstGrammar): string {
    return lexer(portableIR(grammar));
  },
  emitLexer(grammar: CstGrammar): string {
    return `// GENERATED by emit-portable.ts (goTarget) — standalone TOKENIZER for grammar "${grammar.name ?? ''}".
// A library package: Tokenize(src) []Tok. The same lexer is embedded in emitParser's output
// (there as package main), so the tokens are identical.
package lexer

import (
\t"fmt"
\t"strings"
)

// The lexer panics via fmt on an unmatched char and uses strings for literal prefixes; pin both
// imports so a grammar whose lexer happens to skip one still compiles.
var _, _ = fmt.Sprintf, strings.HasPrefix

type Tok struct {
\tKind, Text string
\tOff, End   int
\tNl         bool
}

var toks []Tok   // the lexer reseeds this (toks[:0]) per call

${lexer(portableIR(grammar))}

func Tokenize(src string) []Tok { return lex(src) }
`;
  },
  emitParser(grammar: CstGrammar, lexerSrc: string | null): string {
    const ir = portableIR(grammar);
    const ruleFns = ir.rules.map((r) => (r.kind === 'pratt' ? prattRule(r, ir.tpl) : rdRule(r))).join('\n\n');
    const matchTemplate = ir.tpl ? `func matchTemplate() int32 {
\tt := peek()
\tif t == nil || t.Kind != "$templateHead" { return -1 }
\tsb := len(scratch); nb := len(nodes); kb := len(kids); save := pos
\tscratch = append(scratch, mkLeaf("$templateHead", t.Off, t.End)); pos++
\tfor {
\t\texpr := parse${ir.tpl.interpRule}()
\t\tif expr < 0 { pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; return -1 }
\t\tscratch = append(scratch, expr)
\t\tnext := peek()
\t\tif next == nil { pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; return -1 }
\t\tif next.Kind == "$templateMiddle" { scratch = append(scratch, mkLeaf("$templateMiddle", next.Off, next.End)); pos++; continue }
\t\tif next.Kind == "$templateTail" { scratch = append(scratch, mkLeaf("$templateTail", next.Off, next.End)); pos++; break }
\t\tpos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; return -1
\t}
\treturn finish("$template", sb, t.Off)
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

type Tok struct {
\tKind, Text string
\tOff, End   int
\tNl         bool
}
// Arena node: an int32 index into nodes; children are a flat range in kids.
type Node struct {
\tRule, TokenType string
\tIsLeaf          bool
\tKidStart, KidCount, Offset, End int
}
type bp struct{ lbp, rbp int }

var toks []Tok
var pos int
var _capped bool
var _src string
var _suppressNext map[string]bool
var _suppressCur map[string]bool
var nodes []Node
var kids []int32
var scratch []int32

${lexerSrc ?? ''}

func peek() *Tok {
\tif pos < len(toks) { return &toks[pos] }
\treturn nil
}
func offAt(i int) int { if i < len(toks) { return toks[i].Off }; return 0 }
func mkLeaf(ttype string, off, end int) int32 {
\tnodes = append(nodes, Node{TokenType: ttype, IsLeaf: true, Offset: off, End: end})
\treturn int32(len(nodes) - 1)
}
// Wrap the scratch entries [sb:] as one node's children (flattened into kids); truncate scratch.
func finish(rule string, sb, fallbackOff int) int32 {
\tnn := len(scratch)
\tkidStart := len(kids)
\toff, end := fallbackOff, fallbackOff
\tif nn > sb { off = nodes[scratch[sb]].Offset; end = nodes[scratch[nn-1]].End }
\tkids = append(kids, scratch[sb:nn]...)
\tscratch = scratch[:sb]
\tnodes = append(nodes, Node{Rule: rule, KidStart: kidStart, KidCount: nn - sb, Offset: off, End: end})
\treturn int32(len(nodes) - 1)
}
func matchLit(value, ttype string) bool {
\tif pos < len(toks) && toks[pos].Text == value { if ttype != "$punct" { scratch = append(scratch, mkLeaf(ttype, toks[pos].Off, toks[pos].End)) }; pos++; return true }
\treturn false
}
func matchTok(name string) bool {
\tif pos < len(toks) && toks[pos].Kind == name { scratch = append(scratch, mkLeaf(name, toks[pos].Off, toks[pos].End)); pos++; return true }
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
func sepBy(elem func() bool, delim string) bool {
\tif !elem() { return true }   // the whole separated list is optional — zero elements is valid
\tfor {
\t\tsp := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\t\tif !matchLit(delim, "$punct") { pos = sp; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; break }
\t\tif !elem() { break }   // a trailing delimiter is allowed — keep the pushed delim and stop
\t}
\treturn true
}
func altLit(opts [][2]string) bool {
\tfor _, o := range opts { if matchLit(o[0], o[1]) { return true } }
\treturn false
}

${matchTemplate}${ruleFns}

func writeJSON(id int32, b *strings.Builder) {
\tnd := &nodes[id]
\tif nd.IsLeaf {
\t\tfmt.Fprintf(b, "{\\"tokenType\\":%q,\\"offset\\":%d,\\"end\\":%d}", nd.TokenType, nd.Offset, nd.End)
\t\treturn
\t}
\tfmt.Fprintf(b, "{\\"rule\\":%q,\\"children\\":[", nd.Rule)
\tfor i := 0; i < nd.KidCount; i++ { if i > 0 { b.WriteByte(',') }; writeJSON(kids[nd.KidStart+i], b) }
\tfmt.Fprintf(b, "],\\"offset\\":%d,\\"end\\":%d}", nd.Offset, nd.End)
}

func headLeafText(id int32) string {
\tfor !nodes[id].IsLeaf && nodes[id].KidCount > 0 { id = kids[nodes[id].KidStart] }
\treturn _src[nodes[id].Offset:nodes[id].End]
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
\tnodes = nodes[:0]; kids = kids[:0]; scratch = scratch[:0]
\treturn parse${ir.entry}()
}

${docEditBlockGo(ir)}
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
\t// Self-bench: a numeric arg N times the lex+parse loop and prints ms/iteration.
\tif len(os.Args) > 1 && os.Args[1] != "edit-session" {
\t\tif iters, err := strconv.Atoi(os.Args[1]); err == nil && iters > 0 {
\t\t\tfor i := 0; i < 3; i++ { parse(tokenize(src)) }
\t\t\tt0 := time.Now()
\t\t\tfor i := 0; i < iters; i++ { parse(tokenize(src)) }
\t\t\tfmt.Printf("%.4f\\n", float64(time.Since(t0).Nanoseconds())/1e6/float64(iters))
\t\t\treturn
\t\t}
\t}
\tif len(os.Args) > 1 && os.Args[1] == "edit-session" {
\t\tvar sess struct {
\t\t\tInit    string              \`json:"init"\`
\t\t\tBatches [][][3]interface{}   \`json:"batches"\`
\t\t}
\t\tif json.Unmarshal(data, &sess) != nil { os.Exit(1) }
\t\td := NewDoc(sess.Init)
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
