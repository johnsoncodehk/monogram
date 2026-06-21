// The Go Target for emit-portable. Renders the same language-agnostic ParserIR as tsTarget
// into a self-contained Go program (Go stdlib only — the lexer is regex-free, so it compiles
// with no module dependencies). Its CST JSON is checked byte-for-byte against the interpreter,
// so `emitPortableParser(grammar, goTarget)` is a real, verified Go parser derived from the
// same grammar definition.
//
// ARENA allocation (to minimise GC pressure, as tsgo does): nodes live in a flat `nodes []Node`,
// their children in a flat `kids []int32`, and in-progress children accumulate on a `scratch`
// stack. A node is an int32 index, never a heap pointer. Backtracking truncates the three
// slices to saved lengths; the slices keep their capacity across parses (reset to len 0), so a
// warmed parser allocates ~nothing per parse.
import type { ParserIR, RdRule, PrattRule, Step, Bracket, CharRange, LexTok, Target, TplCfg } from './emit-portable.ts';
import type { TokenPattern } from './types.ts';

const J = (v: unknown) => JSON.stringify(v);
const rangeCond = (v: string, rs: CharRange[]) =>
  '(' + rs.map(([lo, hi]) => (lo === hi ? `${v} == ${lo}` : `${v} >= ${lo} && ${v} <= ${hi}`)).join(' || ') + ')';

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

function scanTok(t: LexTok, defs: string[], rxTok?: string, tplTok?: string): string {
  const name = (t as { name: string }).name;
  const stateful = rxTok !== undefined || tplTok !== undefined;
  if (tplTok !== undefined && name === tplTok) return '';   // template token scanned by the state machine
  const push = (endE: string) => (t.skip ? '' : stateful ? `emit(${J(name)}, src[pos:${endE}], pos, ${endE}); ` : `toks = append(toks, Tok{${J(name)}, src[pos:${endE}], pos, ${endE}}); `);
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

function lexer(ir: ParserIR): string {
  const defs: string[] = [];
  const rx = ir.regexCtx;
  const tpl = ir.tpl;
  const stateful = !!(rx || tpl);
  const toks = ir.tokens.map((t) => scanTok(t, defs, rx?.regexToken, tpl?.token)).join('\n');
  const pushPunct = stateful ? (p: string) => `emit("", ${J(p)}, pos, pos + ${p.length})` : (p: string) => `toks = append(toks, Tok{"", ${J(p)}, pos, pos + ${p.length}})`;
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
  ].filter(Boolean).join('\n');
  const emitTail = rx ? `\n\t\tbpText = prevText; hasPrev2 = hasPrev; prevKind = kind; prevText = text; hasPrev = true` : '';
  const emitFn = stateful ? `\temit := func(kind, text string, off, end int) {
${emitHooks}
\t\ttoks = append(toks, Tok{kind, text, off, end})${emitTail}
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
  return `${defs.length ? 'var _s string\n' + defs.join('\n') + '\n' : ''}func lex(src string) []Tok {
\ttoks := toks[:0]
\tn := len(src)
\tpos := 0
${rxState}${tplState}${emitFn}${defs.length ? '\t_s = src\n' : ''}\tfor pos < n {
\t\tc := int(src[pos])
\t\tif c == 32 || c == 9 || c == 10 || c == 13 { pos++; continue }
${tplDispatch}${toks}
${puncts}
\t\tpanic(fmt.Sprintf("lex error at %d", pos))
\t}
\treturn toks
}`;
}

function stepCond(s: Step): string {
  switch (s.t) {
    case 'lit': return `matchLit(${J(s.value)}, ${J(s.ttype)})`;
    case 'tok': return `matchTok(${J(s.name)})`;
    case 'rule': return `callRule(parse${s.name})`;
    case 'star': return `star(func() bool { return ${stepCond(s.step)} })`;
    case 'opt': return `opt(func() bool { return ${s.steps.map(stepCond).join(' && ')} })`;
    case 'sep': return `sepBy(func() bool { return ${stepCond(s.elem)} }, ${J(s.delim)})`;
    case 'altlit': return `altLit([][2]string{${s.opts.map((o) => `{${J(o.value)}, ${J(o.ttype)}}`).join(', ')}})`;
  }
}

function rdRule(r: RdRule): string {
  const alt = (steps: Step[]) =>
    `\tif ${steps.map(stepCond).join(' && ')} { return finish(${J(r.name)}, sb, offAt(save)) }
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
\t\treturn finish(${J(r.name)}, sb, nodes[node].Offset)
\t}\n`
    : '';
  const bin = r.binary.map((b) => `${J(b.op)}: {${b.lbp}, ${b.rbp}}`).join(', ');
  const pre = r.prefix.map((p) => `${J(p.op)}: ${p.rbp}`).join(', ');
  const atoms = r.nudToks.map((k) => `${J(k)}: true`).join(', ');
  const bracketNud = (b: Bracket) => `\tif t.Text == ${J(b.first)} {
\t\tsave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\t\tif ${b.steps.map(stepCond).join(' && ')} { return finish(${J(r.name)}, sb, t.Off) }
\t\tpos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; return -1
\t}`;
  const ledArm = (b: Bracket) => `\t\tif t.Text == ${J(b.first)} {
\t\t\tledSave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\t\t\tscratch = append(scratch, left)
\t\t\tif ${b.steps.map(stepCond).join(' && ')} { left = finish(${J(r.name)}, sb, nodes[left].Offset); continue }
\t\t\tpos = ledSave; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; break
\t\t}`;
  const postfixArm = (tok: string) => {
    const tplPart = tpl && tok === tpl.token ? `
\t\tif t.Kind == "$templateHead" {
\t\t\tnode := matchTemplate()
\t\t\tif node >= 0 { sb := len(scratch); scratch = append(scratch, left, node); left = finish(${J(r.name)}, sb, nodes[left].Offset); continue }
\t\t}` : '';
    return `\t\tif t.Kind == ${J(tok)} {
\t\t\tsb := len(scratch); scratch = append(scratch, left, mkLeaf(t.Kind, t.Off, t.End)); pos++
\t\t\tleft = finish(${J(r.name)}, sb, nodes[left].Offset); continue
\t\t}${tplPart}`;
  };
  return `var ${r.name}BIN = map[string]bp{${bin}}
var ${r.name}PRE = map[string]int{${pre}}
var ${r.name}ATOM = map[string]bool{${atoms}}
func parse${r.name}() int32 { return ${r.name}bp(0) }
func ${r.name}bp(minBp int) int32 {
\tleft := ${r.name}nud()
\tif left < 0 { return -1 }
\tfor {
\t\tt := peek()
\t\tif t == nil { break }
${r.leds.map(ledArm).join('\n')}
${r.postfixToks.map(postfixArm).join('\n')}
\t\tinfo, ok := ${r.name}BIN[t.Text]
\t\tif !ok || info.lbp <= minBp { break }
\t\tledSave := pos; sb := len(scratch)
\t\tscratch = append(scratch, left, mkLeaf("$operator", t.Off, t.End))
\t\tpos++
\t\trhs := ${r.name}bp(info.rbp)
\t\tif rhs < 0 { pos = ledSave; scratch = scratch[:sb]; break }
\t\tscratch = append(scratch, rhs)
\t\tleft = finish(${J(r.name)}, sb, nodes[left].Offset)
\t}
\treturn left
}
func ${r.name}nud() int32 {
\tt := peek()
\tif t == nil { return -1 }
${tplNud}\tif ${r.name}ATOM[t.Kind] {
\t\tsb := len(scratch); scratch = append(scratch, mkLeaf(t.Kind, t.Off, t.End)); pos++
\t\treturn finish(${J(r.name)}, sb, t.Off)
\t}
${r.nudBrackets.map(bracketNud).join('\n')}
\tif pbp, ok := ${r.name}PRE[t.Text]; ok {
\t\tsave := pos; sb := len(scratch); nb := len(nodes); kb := len(kids)
\t\tscratch = append(scratch, mkLeaf("$operator", t.Off, t.End)); pos++
\t\toperand := ${r.name}bp(pbp)
\t\tif operand < 0 { pos = save; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; return -1 }
\t\tscratch = append(scratch, operand)
\t\treturn finish(${J(r.name)}, sb, t.Off)
\t}
\treturn -1
}`;
}

export const goTarget: Target = {
  name: 'go',
  ext: 'go',
  render(ir: ParserIR): string {
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
    return `// GENERATED by emit-portable.ts (goTarget) — parser for grammar "${ir.grammarName}".
package main

import (
\t"fmt"
\t"io"
\t"os"
\t"strconv"
\t"strings"
\t"time"
)

type Tok struct {
\tKind, Text string
\tOff, End   int
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
var nodes []Node
var kids []int32
var scratch []int32

${lexer(ir)}

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
\tif pos < len(toks) && toks[pos].Text == value { scratch = append(scratch, mkLeaf(ttype, toks[pos].Off, toks[pos].End)); pos++; return true }
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
\tif !elem() { return false }
\tfor { sp := pos; sb := len(scratch); nb := len(nodes); kb := len(kids); if matchLit(delim, "$punct") && elem() { continue }; pos = sp; scratch = scratch[:sb]; nodes = nodes[:nb]; kids = kids[:kb]; break }
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

func parseOnce(src string) int32 {
\ttoks = lex(src)
\tpos = 0
\tnodes = nodes[:0]; kids = kids[:0]; scratch = scratch[:0]
\treturn parse${ir.entry}()
}

func main() {
\tdata, _ := io.ReadAll(os.Stdin)
\tsrc := string(data)
\t// Self-bench: a numeric arg N times the lex+parse loop and prints ms/iteration.
\tif len(os.Args) > 1 {
\t\tif iters, err := strconv.Atoi(os.Args[1]); err == nil && iters > 0 {
\t\t\tfor i := 0; i < 3; i++ { parseOnce(src) }
\t\t\tt0 := time.Now()
\t\t\tfor i := 0; i < iters; i++ { parseOnce(src) }
\t\t\tfmt.Printf("%.4f\\n", float64(time.Since(t0).Nanoseconds())/1e6/float64(iters))
\t\t\treturn
\t\t}
\t}
\troot := parseOnce(src)
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
