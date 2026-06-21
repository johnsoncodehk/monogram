// The Go Target for emit-portable. Renders the same language-agnostic ParserIR as tsTarget
// into a self-contained Go program (Go stdlib only — the lexer is regex-free, so it compiles
// with no module dependencies). Its CST JSON is checked byte-for-byte against the interpreter,
// so `emitPortableParser(grammar, goTarget)` is a real, verified Go parser derived from the
// same grammar definition.
import type { ParserIR, RdRule, PrattRule, Step, Bracket, CharRange, LexTok, Target } from './emit-portable.ts';

const J = (v: unknown) => JSON.stringify(v);
const rangeCond = (v: string, rs: CharRange[]) =>
  '(' + rs.map(([lo, hi]) => (lo === hi ? `${v} == ${lo}` : `${v} >= ${lo} && ${v} <= ${hi}`)).join(' || ') + ')';

function scanTok(t: LexTok): string {
  const push = t.skip ? '' : `toks = append(toks, Tok{${J((t as { name: string }).name)}, src[pos:e], pos, e}); `;
  if (t.kind === 'run') return `\t\tif ${rangeCond('c', t.first)} {
\t\t\te := pos + 1
\t\t\tfor e < n { cc := int(src[e]); if !${rangeCond('cc', t.cont)} { break }; e++ }
\t\t\t${push}pos = e; continue
\t\t}`;
  if (t.kind === 'string') return `\t\tif c == ${t.delim.charCodeAt(0)} {
\t\t\te := pos + 1
\t\t\tfor e < n { ch := int(src[e]); if ch == 92 { e += 2; continue }; if ch == ${t.delim.charCodeAt(0)} { e++; break }; e++ }
\t\t\t${push}pos = e; continue
\t\t}`;
  if (t.kind === 'line') return `\t\tif strings.HasPrefix(src[pos:], ${J(t.prefix)}) {
\t\t\te := pos + ${t.prefix.length}
\t\t\tfor e < n && src[e] != 10 { e++ }
\t\t\t${push}pos = e; continue
\t\t}`;
  return `\t\tif strings.HasPrefix(src[pos:], ${J(t.open)}) {
\t\t\te := pos + ${t.open.length}
\t\t\tfor e < n && !strings.HasPrefix(src[e:], ${J(t.close)}) { e++ }
\t\t\tif e < n { e += ${t.close.length} }
\t\t\t${push}pos = e; continue
\t\t}`;
}

function lexer(ir: ParserIR): string {
  const toks = ir.tokens.map(scanTok).join('\n');
  const puncts = ir.puncts.map((p) =>
    `\t\tif strings.HasPrefix(src[pos:], ${J(p)}) { toks = append(toks, Tok{"", ${J(p)}, pos, pos + ${p.length}}); pos += ${p.length}; continue }`).join('\n');
  return `func lex(src string) []Tok {
\ttoks := []Tok{}
\tn := len(src)
\tpos := 0
\tfor pos < n {
\t\tc := int(src[pos])
\t\tif c == 32 || c == 9 || c == 10 || c == 13 { pos++; continue }
${toks}
${puncts}
\t\tpanic(fmt.Sprintf("lex error at %d", pos))
\t}
\treturn toks
}`;
}

function stepCond(s: Step): string {
  switch (s.t) {
    case 'lit': return `matchLit(${J(s.value)}, ${J(s.ttype)}, &kids)`;
    case 'tok': return `matchTok(${J(s.name)}, &kids)`;
    case 'rule': return `callRule(parse${s.name}, &kids)`;
    case 'star': return `star(func() bool { return ${stepCond(s.step)} }, &kids)`;
    case 'opt': return `opt(func() bool { return ${s.steps.map(stepCond).join(' && ')} }, &kids)`;
    case 'sep': return `sepBy(func() bool { return ${stepCond(s.elem)} }, ${J(s.delim)}, &kids)`;
    case 'altlit': return `altLit([][2]string{${s.opts.map((o) => `{${J(o.value)}, ${J(o.ttype)}}`).join(', ')}}, &kids)`;
  }
}

function rdRule(r: RdRule): string {
  const alt = (steps: Step[]) =>
    `\t{ kids := []*Cst{}; if ${steps.map(stepCond).join(' && ')} { return branch(${J(r.name)}, kids, save) }; pos = save }`;
  return `func parse${r.name}() *Cst {
\tsave := pos
${r.alts.map(alt).join('\n')}
\treturn nil
}`;
}

function prattRule(r: PrattRule): string {
  const bin = r.binary.map((b) => `${J(b.op)}: {${b.lbp}, ${b.rbp}}`).join(', ');
  const pre = r.prefix.map((p) => `${J(p.op)}: ${p.rbp}`).join(', ');
  const atoms = r.nudToks.map((k) => `${J(k)}: true`).join(', ');
  const bracketNud = (b: Bracket) => `\tif t.Text == ${J(b.first)} {
\t\tsave := pos; kids := []*Cst{}
\t\tif ${b.steps.map(stepCond).join(' && ')} { return node(${J(r.name)}, kids) }
\t\tpos = save; return nil
\t}`;
  const ledArm = (b: Bracket) => `\t\tif t.Text == ${J(b.first)} {
\t\t\tledSave := pos; kids := []*Cst{left}
\t\t\tif ${b.steps.map(stepCond).join(' && ')} { left = node(${J(r.name)}, kids); continue }
\t\t\tpos = ledSave; break
\t\t}`;
  return `var ${r.name}BIN = map[string]bp{${bin}}
var ${r.name}PRE = map[string]int{${pre}}
var ${r.name}ATOM = map[string]bool{${atoms}}
func parse${r.name}() *Cst { return ${r.name}bp(0) }
func ${r.name}bp(minBp int) *Cst {
\tleft := ${r.name}nud()
\tif left == nil { return nil }
\tfor {
\t\tt := peek()
\t\tif t == nil { break }
${r.leds.map(ledArm).join('\n')}
\t\tinfo, ok := ${r.name}BIN[t.Text]
\t\tif !ok || info.lbp <= minBp { break }
\t\tledSave := pos
\t\tpos++
\t\topLeaf := &Cst{IsLeaf: true, TokenType: "$operator", Offset: t.Off, End: t.End}
\t\trhs := ${r.name}bp(info.rbp)
\t\tif rhs == nil { pos = ledSave; break }
\t\tleft = &Cst{Rule: ${J(r.name)}, Children: []*Cst{left, opLeaf, rhs}, Offset: left.Offset, End: rhs.End}
\t}
\treturn left
}
func ${r.name}nud() *Cst {
\tt := peek()
\tif t == nil { return nil }
\tif ${r.name}ATOM[t.Kind] {
\t\tpos++
\t\treturn &Cst{Rule: ${J(r.name)}, Children: []*Cst{{IsLeaf: true, TokenType: t.Kind, Offset: t.Off, End: t.End}}, Offset: t.Off, End: t.End}
\t}
${r.nudBrackets.map(bracketNud).join('\n')}
\tif pbp, ok := ${r.name}PRE[t.Text]; ok {
\t\tsave := pos; pos++
\t\topLeaf := &Cst{IsLeaf: true, TokenType: "$operator", Offset: t.Off, End: t.End}
\t\toperand := ${r.name}bp(pbp)
\t\tif operand == nil { pos = save; return nil }
\t\treturn &Cst{Rule: ${J(r.name)}, Children: []*Cst{opLeaf, operand}, Offset: t.Off, End: operand.End}
\t}
\treturn nil
}`;
}

export const goTarget: Target = {
  name: 'go',
  ext: 'go',
  render(ir: ParserIR): string {
    const ruleFns = ir.rules.map((r) => (r.kind === 'pratt' ? prattRule(r) : rdRule(r))).join('\n\n');
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
type Cst struct {
\tRule      string
\tChildren  []*Cst
\tIsLeaf    bool
\tTokenType string
\tOffset    int
\tEnd       int
}
type bp struct{ lbp, rbp int }

${lexer(ir)}

var toks []Tok
var pos int

func peek() *Tok {
\tif pos < len(toks) { return &toks[pos] }
\treturn nil
}
func branch(rule string, kids []*Cst, save int) *Cst {
\toffset := 0
\tif len(kids) > 0 { offset = kids[0].Offset } else if save < len(toks) { offset = toks[save].Off }
\tend := offset
\tif len(kids) > 0 { end = kids[len(kids)-1].End }
\treturn &Cst{Rule: rule, Children: kids, Offset: offset, End: end}
}
func node(rule string, kids []*Cst) *Cst {
\treturn &Cst{Rule: rule, Children: kids, Offset: kids[0].Offset, End: kids[len(kids)-1].End}
}
func matchLit(value, ttype string, kids *[]*Cst) bool {
\tt := peek()
\tif t == nil || t.Text != value { return false }
\t*kids = append(*kids, &Cst{IsLeaf: true, TokenType: ttype, Offset: t.Off, End: t.End}); pos++; return true
}
func matchTok(name string, kids *[]*Cst) bool {
\tt := peek()
\tif t == nil || t.Kind != name { return false }
\t*kids = append(*kids, &Cst{IsLeaf: true, TokenType: name, Offset: t.Off, End: t.End}); pos++; return true
}
func callRule(fn func() *Cst, kids *[]*Cst) bool {
\tn := fn()
\tif n == nil { return false }
\t*kids = append(*kids, n); return true
}
func star(once func() bool, kids *[]*Cst) bool {
\tfor { sp := pos; before := len(*kids); if !once() { pos = sp; *kids = (*kids)[:before]; break } }
\treturn true
}
func opt(body func() bool, kids *[]*Cst) bool {
\tsp := pos; before := len(*kids); if !body() { pos = sp; *kids = (*kids)[:before] }; return true
}
func sepBy(elem func() bool, delim string, kids *[]*Cst) bool {
\tif !elem() { return false }
\tfor { sp := pos; before := len(*kids); if matchLit(delim, "$punct", kids) && elem() { continue }; pos = sp; *kids = (*kids)[:before]; break }
\treturn true
}
func altLit(opts [][2]string, kids *[]*Cst) bool {
\tfor _, o := range opts { if matchLit(o[0], o[1], kids) { return true } }
\treturn false
}

${ruleFns}

func writeJSON(c *Cst, b *strings.Builder) {
\tif c.IsLeaf {
\t\tfmt.Fprintf(b, "{\\"tokenType\\":%q,\\"offset\\":%d,\\"end\\":%d}", c.TokenType, c.Offset, c.End)
\t\treturn
\t}
\tfmt.Fprintf(b, "{\\"rule\\":%q,\\"children\\":[", c.Rule)
\tfor i, k := range c.Children { if i > 0 { b.WriteByte(',') }; writeJSON(k, b) }
\tfmt.Fprintf(b, "],\\"offset\\":%d,\\"end\\":%d}", c.Offset, c.End)
}

func main() {
\tdata, _ := io.ReadAll(os.Stdin)
\tsrc := string(data)
\t// Self-bench: a numeric arg N times the lex+parse loop and prints ms/iteration.
\tif len(os.Args) > 1 {
\t\tif iters, err := strconv.Atoi(os.Args[1]); err == nil && iters > 0 {
\t\t\tfor i := 0; i < 3; i++ { toks = lex(src); pos = 0; parse${ir.entry}() }
\t\t\tt0 := time.Now()
\t\t\tfor i := 0; i < iters; i++ { toks = lex(src); pos = 0; parse${ir.entry}() }
\t\t\tfmt.Printf("%.4f\\n", float64(time.Since(t0).Nanoseconds())/1e6/float64(iters))
\t\t\treturn
\t\t}
\t}
\ttoks = lex(src)
\tpos = 0
\troot := parse${ir.entry}()
\tif root == nil || pos != len(toks) {
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
