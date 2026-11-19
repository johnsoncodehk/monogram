// Gate: the portable targets split '>'-led punctuators where a type argument list closes.
//
// The TypeScript lexer reads `>>`, `>>>`, `>=`, `>>=` as one token; inside nested type arguments
// the parser must take a single '>' from it and leave the rest as the next token. In Go and Rust,
// a fresh parse, an incremental Doc (CST fast path, with and without validation) and a Doc on a
// consumer builder with Shift (which keeps no parse stream of its own) must all produce the
// tsTarget CST, after every edit around split tokens, and the edits must still reuse the old tree.
//
//   node test/emit-portable-split.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitParser, goTarget, rustTarget, tsTarget } from '../src/emit.ts';
import { asGoMain } from './go-main.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};

type Edit = { start: number; end: number; text: string };
const grammar = (await import('../typescript.ts')).default;
const dir = mkdtempSync(join(tmpdir(), 'monogram-portable-split-'));
writeFileSync(join(dir, 'parser.ts'), emitParser(grammar, tsTarget));
const ts = (await import(join(dir, 'parser.ts'))) as { parse(s: string): unknown };
const ref = (s: string) => { const c = ts.parse(s); return c === null ? '' : JSON.stringify(c); };

const SPLIT = 'let x: Array<Array<number>> = y; foo(bar);\nlet z: Map<string, Set<number>>= q;\nconst w = 1;\n';
const SAMPLES = [
  SPLIT,
  'let a = b >> c; let d: A<B<C<D>>> = e >>> f;\n',
  'let m: Map<K, Array<V>>= n; m >>= 2; m >>>= 1;\n',
  'function f<T>(x: Array<T>): T { return x[0]; }\n',
  'type T = Promise<Array<Record<string, number>>>;\n',
];
type Session = { name: string; init: string; edits: Edit[]; texts: string[]; reuse: boolean };
const session = (name: string, init: string, reuse: boolean): Session & { push(e: Edit): void; text(): string } => {
  const ses = { name, init, edits: [] as Edit[], texts: [] as string[], reuse, push(e: Edit) {
    const t = ses.text();
    ses.edits.push(e); ses.texts.push(t.slice(0, e.start) + e.text + t.slice(e.end));
  }, text: () => ses.texts.at(-1) ?? init };
  return ses;
};
// Edits at statement boundaries and on the split tokens themselves; every text parses, so every
// edit can reuse.
const curated = session('curated edits', SPLIT, true);
for (let i = 0; i < 18; i++) {
  const semis = [...curated.text().matchAll(/;/g)].map((x) => x.index!);
  const p = semis[(i * 7) % semis.length]! + 1;
  curated.push({ start: p, end: p, text: i % 3 === 0 ? ' let k: A<B<C>> = 1;' : i % 3 === 1 ? '\n' : ' ' });
}
{
  const gt = curated.text().indexOf('>>');
  curated.push({ start: gt, end: gt + 2, text: '> >' });
  curated.push({ start: gt, end: gt + 3, text: '>>' });
  const num = curated.text().lastIndexOf('Set<number') + 4;
  curated.push({ start: num, end: num + 6, text: 'Array<number>' });
  curated.push({ start: num, end: num + 13, text: 'number' });
}
// Seeded random edits: whole statements inserted and deleted at statement boundaries, split
// tokens closing type arguments toggled between `>>` and `> >`, and spaces, mostly between
// statements (one inside a token may stop the text parsing for a while).
const STMTS = ['let a: A<B<C>> = 1;', 'let b = c >> d;', 'type T = X<Y<Z<W>>>;', 'let m: M<K, V<W>>= n;', 'x >>>= 2;', 'f<T>(y);', 'let q: Array<Array<number>> = [];', 'const w = 1;'];
let seed = 7;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
const random = session('random edits', Array.from({ length: 24 }, (_, i) => STMTS[i % STMTS.length]).join('\n') + '\n', false);
for (let i = 0; i < 200; i++) {
  const t = random.text();
  const bounds = [0, ...[...t.matchAll(/[;\n]/g)].map((x) => x.index! + 1)];
  const op = rnd(4);
  if (op === 0) { const at = bounds[rnd(bounds.length)]!; random.push({ start: at, end: at, text: STMTS[rnd(STMTS.length)]! + (rnd(2) ? '\n' : ' ') }); continue; }
  if (op === 1 && bounds.length > 2) { const k = rnd(bounds.length - 1); random.push({ start: bounds[k]!, end: bounds[k + 1]!, text: '' }); continue; }
  const gts = [...t.matchAll(/(?<=\w)(>>|> >)/g)];
  if (op === 2 && gts.length) { const g = gts[rnd(gts.length)]!; random.push({ start: g.index!, end: g.index! + g[0].length, text: g[0] === '>>' ? '> >' : '>>' }); continue; }
  const at = rnd(4) ? bounds[rnd(bounds.length)]! : rnd(t.length + 1);
  random.push({ start: at, end: at, text: ' ' });
}
const SESSIONS = [curated, random];

const HARNESS = `package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

type lf struct{ tt uint16; off, end uint32 }

// spanB is a consumer builder (not *CstBuilder, so a Doc on it runs the parserW path) whose
// leaves keep their source spans.
type spanB struct {
	N []Node
	K []int32
	L []lf
}

func (b *spanB) Leaf(scratch *[]int32, ttId uint16, tokIdx, off, end uint32) bool {
	if ttId == uint16(TT_SKIP_PUNCT) { return false }
	b.L = append(b.L, lf{ttId, off, end})
	*scratch = append(*scratch, ^int32(len(b.L)-1))
	return true
}
func (b *spanB) SpanOf(h int32, _ []Tok) (uint32, uint32) {
	if h < 0 { l := b.L[^h]; return l.off, l.end }
	return b.N[h].Offset, b.N[h].End
}
func (b *spanB) HeadSpan(h int32, toks []Tok) (uint32, uint32) {
	for h >= 0 && b.N[h].KidCount > 0 { h = b.K[b.N[h].KidStart] }
	return b.SpanOf(h, toks)
}
func (b *spanB) Node(scratch *[]int32, sb int, ruleId uint16, off, end, tokStart, tokEnd uint32) {
	ks := len(b.K)
	b.K = append(b.K, (*scratch)[sb:]...)
	n := len(*scratch) - sb
	*scratch = (*scratch)[:sb]
	b.N = append(b.N, Node{RuleId: ruleId, KidStart: uint32(ks), KidCount: uint32(n), Offset: off, End: end, TokStart: tokStart, TokEnd: tokEnd})
	*scratch = append(*scratch, int32(len(b.N)-1))
}
func (b *spanB) Finish(scratch *[]int32, sb int, ruleId uint16, fallbackOff, tokStart, tokEnd uint32, toks []Tok) (int32, uint32, bool) {
	off, end := fallbackOff, fallbackOff
	if len(*scratch) > sb {
		off, _ = b.SpanOf((*scratch)[sb], toks)
		_, end = b.SpanOf((*scratch)[len(*scratch)-1], toks)
	}
	b.Node(scratch, sb, ruleId, off, end, tokStart, tokEnd)
	h := (*scratch)[len(*scratch)-1]
	*scratch = (*scratch)[:len(*scratch)-1]
	return h, off, true
}
func (b *spanB) Checkpoint() (int, int) { return len(b.N), len(b.K) }
func (b *spanB) Restore(nb, kb int)     { b.N = b.N[:nb]; b.K = b.K[:kb] }
func (b *spanB) Shift(h int32, bd, td int) int32 {
	if h < 0 { b.L[^h].off += uint32(bd); b.L[^h].end += uint32(bd); return h }
	nd := &b.N[h]
	nd.Offset += uint32(bd); nd.End += uint32(bd)
	for i := uint32(0); i < nd.KidCount; i++ { b.Shift(b.K[nd.KidStart+i], bd, td) }
	return h
}
func (b *spanB) json(h int32, sb *strings.Builder) {
	if h < 0 {
		l := b.L[^h]
		fmt.Fprintf(sb, "{\\"tokenType\\":%q,\\"offset\\":%d,\\"end\\":%d}", TT_NAMES[l.tt], l.off, l.end)
		return
	}
	nd := &b.N[h]
	fmt.Fprintf(sb, "{\\"rule\\":%q,\\"children\\":[", RULE_NAMES[nd.RuleId])
	for i := uint32(0); i < nd.KidCount; i++ {
		if i > 0 { sb.WriteByte(',') }
		b.json(b.K[nd.KidStart+i], sb)
	}
	fmt.Fprintf(sb, "],\\"offset\\":%d,\\"end\\":%d}", nd.Offset, nd.End)
}
func spanJSON(b *spanB, root int32) string {
	if root < 0 { return "" }
	var sb strings.Builder
	b.json(root, &sb)
	return sb.String()
}

type step struct {
	Native, Validated, Span, Fresh string
	NativeReused, SpanReused int
	TreeEq                   bool
}

func main() {
	raw, _ := io.ReadAll(os.Stdin)
	var in struct {
		Samples  []string
		Sessions []struct {
			Init  string
			Edits []Edit
		}
	}
	if json.Unmarshal(raw, &in) != nil { os.Exit(2) }
	var out struct {
		Doc, ParseWith, Span []string
		Sessions             [][]step
	}
	for _, s := range in.Samples {
		out.Doc = append(out.Doc, NewDoc(s).CstJSON())
		cb := &CstBuilder{}
		pw := ""
		if h, ok := ParseWith(s, cb); ok { pw = CstJSONWith(cb, h) }
		out.ParseWith = append(out.ParseWith, pw)
		sb := &spanB{}
		sp := ""
		if h, ok := ParseWith(s, sb); ok { sp = spanJSON(sb, h) }
		out.Span = append(out.Span, sp)
	}
	for _, ses := range in.Sessions {
		native, validated := NewDoc(ses.Init), NewDoc(ses.Init)
		validated.SetValidate(true)
		sb := &spanB{}
		span := NewDocWith(ses.Init, sb)
		var steps []step
		for _, e := range ses.Edits {
			native.Edit([]Edit{e})
			validated.Edit([]Edit{e})
			span.Edit([]Edit{e})
			st := step{Native: native.CstJSON(), Validated: validated.CstJSON(), Span: spanJSON(sb, span.Root()), Fresh: NewDoc(native.Text()).CstJSON()}
			if a := native.Align(); a != nil { st.NativeReused = a.Reused }
			if a := span.Align(); a != nil { st.SpanReused = a.Reused }
			if a := validated.Align(); a != nil && a.TreeEq != nil { st.TreeEq = *a.TreeEq }
			steps = append(steps, st)
		}
		out.Sessions = append(out.Sessions, steps)
	}
	b, _ := json.Marshal(out)
	os.Stdout.Write(b)
}
`;

type Step = { Native: string; Validated: string; Span?: string; Fresh: string; NativeReused: number; SpanReused?: number; TreeEq: boolean };
type Out = { Doc: string[]; ParseWith: string[]; Span?: string[]; Sessions: Step[][] };
const verify = (lang: string, out: Out, names: { doc: string; parseWith: string }) => {
  SAMPLES.forEach((s, i) => {
    const tag = JSON.stringify(s.slice(0, 34));
    const want = ref(s);
    check(`${lang}: tsTarget accepts ${tag}`, want !== '');
    check(`${lang}: ${names.doc} ≡ tsTarget for ${tag}`, out.Doc[i] === want, out.Doc[i] ? 'CST differs' : 'rejected');
    check(`${lang}: ${names.parseWith} ≡ tsTarget for ${tag}`, out.ParseWith[i] === want, out.ParseWith[i] ? 'CST differs' : 'rejected');
    if (out.Span) check(`${lang}: ParseWith(consumer builder) ≡ tsTarget for ${tag}`, out.Span[i] === want, out.Span[i] ? 'CST differs' : 'rejected');
  });
  check(`${lang} curated: every edited text parses (tsTarget)`, curated.texts.every((t) => ref(t) !== ''));
  SESSIONS.forEach((ses, si) => {
    const steps = out.Sessions[si]!;
    // The curated texts are compared with tsTarget too; random texts only with a fresh Doc.
    if (ses.reuse) {
      const bad = steps.filter((s, i) => s.Fresh !== ref(ses.texts[i]!)).length;
      check(`${lang} ${ses.name}: a fresh Doc ≡ tsTarget on every text`, bad === 0, `${bad}/${steps.length} differ`);
    }
    const variants: [string, (s: Step) => string | undefined, ((s: Step) => number | undefined) | null][] = [
      ['Doc (CST fast path)', (s) => s.Native, (s) => s.NativeReused],
      ['Doc (CST, validate)', (s) => s.Validated, null],
    ];
    if (out.Span) variants.push(['Doc (consumer builder with Shift)', (s) => s.Span, (s) => s.SpanReused]);
    for (const [label, get, reusedOf] of variants) {
      let bad = 0, first = '', reused = 0;
      steps.forEach((s, i) => {
        if (get(s) !== s.Fresh) { bad++; if (!first) first = `step ${i}: ${JSON.stringify(ses.texts[i])}`; }
        if (reusedOf && reusedOf(s)! > 0) reused++;
      });
      check(`${lang} ${ses.name}: ${label} ≡ a fresh Doc after every edit`, bad === 0, `${bad}/${steps.length} steps differ, first ${first}`);
      if (reusedOf && ses.reuse) check(`${lang} ${ses.name}: ${label} reuses the old tree on every edit`, reused === steps.length, `${reused}/${steps.length} steps reused`);
    }
    if (!ses.reuse) {
      const parsed = steps.filter((s) => s.Fresh !== '').length;
      const reused = steps.filter((s) => s.NativeReused > 0 && (s.SpanReused ?? 1) > 0).length;
      check(`${lang} ${ses.name}: most texts parse and most edits reuse`, 2 * parsed > steps.length && 2 * reused > steps.length, `${parsed} parse, ${reused} reuse of ${steps.length}`);
    }
    check(`${lang} ${ses.name}: validated Doc reports treeEq on every edit`, steps.every((s) => s.TreeEq), `${steps.filter((s) => !s.TreeEq).length} steps not treeEq`);
  });
};
const have = (cmd: string, arg: string) => { try { execFileSync(cmd, [arg], { stdio: 'pipe' }); return true; } catch { return false; } };

if (!have('go', 'version')) console.log('  go: (toolchain absent — skipped)');
else {
  const gdir = join(dir, 'go');
  mkdirSync(gdir);
  writeFileSync(join(gdir, 'parser.go'), asGoMain(emitParser(grammar, goTarget)));
  writeFileSync(join(gdir, 'main.go'), HARNESS);
  writeFileSync(join(gdir, 'go.mod'), 'module p\n\ngo 1.21\n');
  execFileSync('go', ['build', '-o', 'h', '.'], { cwd: gdir, stdio: 'pipe' });
  const out = JSON.parse(execFileSync(join(gdir, 'h'), {
    input: JSON.stringify({ Samples: SAMPLES, Sessions: SESSIONS.map((x) => ({ Init: x.init, Edits: x.edits })) }), maxBuffer: 1 << 28,
  }).toString()) as Out;
  verify('go', out, { doc: 'NewDoc', parseWith: 'ParseWith(*CstBuilder)' });
}

// Rust has no JSON reader in std, so the inputs are compiled in (all ASCII, so a JSON string is a
// Rust string literal and byte offsets are UTF-16 offsets).
const rlit = (s: string) => { if (!/^[\x20-\x7e\n]*$/.test(s)) throw new Error('non-ASCII input'); return JSON.stringify(s); };
const RUST_HARNESS = `
fn q(s: &str) -> String { format!("{:?}", s) }
// A consumer builder (not CstBuilder: it keeps no parse stream, so its Doc keeps one itself) whose
// leaves keep their source spans.
#[derive(Default)]
struct SpanB { n: Vec<(u16, u32, u32, u32, u32, u32, u32)>, k: Vec<i32>, l: Vec<(u16, u32, u32, u32)> }
impl SpanB {
    fn json(&self, h: i32, out: &mut String) {
        if h < 0 { let (tt, _, off, end) = self.l[!h as usize]; out.push_str(&format!("{{\\"tokenType\\":\\"{}\\",\\"offset\\":{},\\"end\\":{}}}", TT_NAMES[tt as usize], off, end)); return; }
        let (rule, ks, kc, off, end, _, _) = self.n[h as usize];
        out.push_str(&format!("{{\\"rule\\":\\"{}\\",\\"children\\":[", RULE_NAMES[rule as usize]));
        for i in 0..kc { if i > 0 { out.push(','); } self.json(self.k[(ks + i) as usize], out); }
        out.push_str(&format!("],\\"offset\\":{},\\"end\\":{}}}", off, end));
    }
    fn to_json(&self, root: Option<i32>) -> String { match root { Some(h) => { let mut s = String::new(); self.json(h, &mut s); s } None => String::new() } }
}
impl Builder for SpanB {
    type H = i32;
    const SUPPORTS_SHIFT: bool = true;
    fn dummy_h() -> i32 { 0 }
    fn shift(&mut self, h: i32, bd: isize, td: isize) -> i32 {
        if h < 0 { let l = &mut self.l[!h as usize]; l.1 = (l.1 as isize + td) as u32; l.2 = (l.2 as isize + bd) as u32; l.3 = (l.3 as isize + bd) as u32; return h; }
        let (ks, kc) = { let nd = &mut self.n[h as usize]; nd.3 = (nd.3 as isize + bd) as u32; nd.4 = (nd.4 as isize + bd) as u32; nd.5 = (nd.5 as isize + td) as u32; nd.6 = (nd.6 as isize + td) as u32; (nd.1, nd.2) };
        for i in 0..kc { let kid = self.k[(ks + i) as usize]; self.shift(kid, bd, td); }
        h
    }
    fn root_kids(&self, root: i32) -> Vec<i32> { let (_, ks, kc, ..) = self.n[root as usize]; (0..kc).map(|i| self.k[(ks + i) as usize]).collect() }
    fn root_kid_at(&self, root: i32, idx: usize) -> i32 { self.k[self.n[root as usize].1 as usize + idx] }
    fn rule_id_of(&self, h: i32) -> u16 { self.n[h as usize].0 }
    fn checkpoint(&self) -> (usize, usize) { (self.n.len(), self.k.len()) }
    fn restore(&mut self, ck: (usize, usize)) { self.n.truncate(ck.0); self.k.truncate(ck.1); }
    fn leaf(&mut self, scratch: &mut Vec<i32>, tt_id: u16, tok_idx: u32, off: u32, end: u32) -> bool {
        if tt_id == 255 { return false; }
        self.l.push((tt_id, tok_idx, off, end)); scratch.push(!((self.l.len() - 1) as i32)); true
    }
    fn node(&mut self, scratch: &mut Vec<i32>, sb: usize, rule_id: u16, off: u32, end: u32, tok_start: u32, tok_end: u32) {
        let ks = self.k.len() as u32; let kc = (scratch.len() - sb) as u32;
        self.k.extend(scratch[sb..].iter().copied()); scratch.truncate(sb);
        self.n.push((rule_id, ks, kc, off, end, tok_start, tok_end)); scratch.push((self.n.len() - 1) as i32);
    }
    fn span_of(&self, h: i32, _toks: &[Tok]) -> (u32, u32) { if h < 0 { let l = self.l[!h as usize]; (l.2, l.3) } else { let nd = self.n[h as usize]; (nd.3, nd.4) } }
    fn head_span(&self, h: i32, toks: &[Tok]) -> (u32, u32) { let mut h = h; while h >= 0 && self.n[h as usize].2 > 0 { h = self.k[self.n[h as usize].1 as usize]; } self.span_of(h, toks) }
    fn tok_range(&self, h: i32) -> (u32, u32) { if h < 0 { let t = self.l[!h as usize].1; (t, t + 1) } else { let nd = self.n[h as usize]; (nd.5, nd.6) } }
}
fn main() {
    let samples: &[&str] = &[${SAMPLES.map(rlit).join(', ')}];
    let sessions: &[(&str, &[(usize, usize, &str)])] = &[${SESSIONS.map((x) => `(${rlit(x.init)}, &[${x.edits.map((e) => `(${e.start}, ${e.end}, ${rlit(e.text)})`).join(', ')}])`).join(', ')}];
    let mut docs = Vec::new();
    let mut pws = Vec::new();
    let mut spans = Vec::new();
    for s in samples {
        let d: Doc = Doc::new(s.to_string());
        docs.push(q(&d.cst_json().unwrap_or_default()));
        let mut b = CstBuilder::default();
        pws.push(q(&match parse_with(s, &mut b) { Some(h) => cst_json_with(&b, h), None => String::new() }));
        let mut sb = SpanB::default();
        let r = parse_with(s, &mut sb);
        spans.push(q(&sb.to_json(r)));
    }
    let mut ses = Vec::new();
    for (init, edits) in sessions {
        let mut nat: Doc = Doc::new(init.to_string());
        let mut val: Doc = Doc::new(init.to_string());
        val.set_validate(true);
        let mut span: Doc<SpanB> = Doc::new(init.to_string());
        let mut steps = Vec::new();
        for &(s, e, t) in edits.iter() {
            let ed = [Edit { start: s, end: e, text: t.to_string() }];
            nat.edit(&ed);
            val.edit(&ed);
            span.edit(&ed);
            let fresh: Doc = Doc::new(nat.text().to_string());
            let reused = nat.alignment().map(|a| a.reused).unwrap_or(0);
            let span_reused = span.alignment().map(|a| a.reused).unwrap_or(0);
            let tree_eq = val.alignment().and_then(|a| a.tree_eq).unwrap_or(false);
            steps.push(format!("{{\\"Native\\":{},\\"Validated\\":{},\\"Span\\":{},\\"Fresh\\":{},\\"NativeReused\\":{},\\"SpanReused\\":{},\\"TreeEq\\":{}}}",
                q(&nat.cst_json().unwrap_or_default()), q(&val.cst_json().unwrap_or_default()), q(&span.builder().to_json(span.root_handle())), q(&fresh.cst_json().unwrap_or_default()), reused, span_reused, tree_eq));
        }
        ses.push(format!("[{}]", steps.join(",")));
    }
    println!("{{\\"Doc\\":[{}],\\"ParseWith\\":[{}],\\"Span\\":[{}],\\"Sessions\\":[{}]}}", docs.join(","), pws.join(","), spans.join(","), ses.join(","));
}
`;

if (!have('rustc', '--version')) console.log('  rust: (toolchain absent — skipped)');
else {
  const rdir = join(dir, 'rust');
  mkdirSync(rdir);
  writeFileSync(join(rdir, 'h.rs'), emitParser(grammar, rustTarget) + RUST_HARNESS);
  execFileSync('rustc', ['-O', '-A', 'warnings', '--edition', '2021', 'h.rs', '-o', 'h'], { cwd: rdir, stdio: 'pipe' });
  const out = JSON.parse(execFileSync(join(rdir, 'h'), { maxBuffer: 1 << 28 }).toString()) as Out;
  verify('rust', out, { doc: 'Doc::new', parseWith: 'parse_with(CstBuilder)' });
}

console.log(`\n${ok}/${ok + fail} portable-split checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
