// Gate: a builder reused for a second parse yields exactly the CST a fresh builder yields.
//
// `parse_with(src, &mut builder)` (Rust), `ParseWith(src, builder)` (Go) and `parseWith(src,
// builder)` (TS) keep the buffers of a builder that parsed before — its token stream and arena —
// emptied but with their capacity, so a loop that keeps its builder does not allocate them again.
// Nothing of an earlier parse may be observable in a later one: every input in each sequence
// below is parsed with ONE builder, in order, and its CST JSON (or its rejection) must equal the
// one a fresh builder gives. The sequences put a longer input before a shorter one and the
// reverse, a rejected input before an accepted one, dense one-byte tokens before ordinary code, and
// a parse that leaves the engine's transient buffers non-empty — rejected inside a template and an
// open bracket, or stopped by a lexer panic — before ordinary code (the builder's workspace: Rust
// `Builder::workspace_mut`, Go `WorkspaceOwner`). Go runs both CstBuilder (the native engine) and
// SlimBuilder (the builder engine behind the Builder interface), Rust both CstBuilder and SlimBuilder.
// The verdict of every builder is the interpreter's (createParser): accepting or rejecting is the
// parser's decision, never the builder's, so a program whose root keeps no child (empty, only
// comments, only empty statements: a SlimBuilder drops every leaf of `;`) is accepted by every
// builder. A builder that keeps no node for the root of an accepted parse breaks the builder
// contract and fails loudly (TS: `dropAll` below), never reports a reject.
// Missing go / rustc → logged + skipped.
//
//   node test/builder-reuse.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser, tsTarget, goTarget, rustTarget } from '../src/emit.ts';
import { goBuild, scratchDir } from './scratch.ts';
import { createParser } from '../src/gen-parser.ts';

const LONG = readFileSync(new URL('../typescript.ts', import.meta.url), 'utf8');
const SHORT = 'let x = f(1, "a") + y;\n';
const OTHER = 'function g<T>(a: T): T { return a; }\nclass C { m() { return `t${1}`; } }\n';
const DENSE = ';'.repeat(4096);
const REJECTED = 'let = ;';
// Rejected with the lexer's template and bracket stacks non-empty at the end of the input.
const REJECTED_OPEN = 'x = `a${ f((';
// The lexer stops by a panic (a lex error) part-way, its stacks non-empty.
const LEX_PANIC_TEMPLATE = 'f(1, `a${ g(`b';
const LEX_PANIC_CHAR = 'f((1, \u0001';
const SEQUENCES: Record<string, string[]> = {
  'longer, then shorter': [LONG, SHORT],
  'shorter, then longer': [SHORT, LONG],
  'rejected, then accepted': [REJECTED, OTHER],
  'dense tokens, then ordinary code, then dense again': [DENSE, OTHER, DENSE],
  'accepted, then rejected, then accepted': [OTHER, REJECTED, SHORT],
  'rejected with the lexer stacks non-empty, then accepted': [OTHER, REJECTED_OPEN, OTHER],
  'the lexer panics inside a template, then accepted': [OTHER, LEX_PANIC_TEMPLATE, OTHER],
  'the lexer panics on a character it cannot lex, then accepted': [OTHER, LEX_PANIC_CHAR, OTHER],
  'programs whose root keeps no child: empty, only a comment, only empty statements': ['', '// only a comment\n', ';;;', OTHER, ''],
};

let ok = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};
const have = (cmd: string, arg: string) => { try { execFileSync(cmd, [arg], { stdio: 'pipe' }); return true; } catch { return false; } };

const grammar = (await import('../typescript.ts')).default;
const oracle = createParser(grammar);
const oracleVerdict = (src: string): boolean => { try { oracle.parse(src); return true; } catch { return false; } };
const dir = scratchDir('builder-reuse');
const seqNames = Object.keys(SEQUENCES);
// One file list per sequence; the consumer prints, per file, `<reused>\t<fresh>` (CST JSON or REJECT).
const seqFiles = seqNames.map((n, k) => SEQUENCES[n]!.map((src, i) => { const f = join(dir, `s${k}-${i}.ts`); writeFileSync(f, src); return f; }));
const results = new Map<string, string[][]>();
const readPairs = (out: string) => out.trim().split('\n').map((l) => l.split('\t'));

// ── TS ── (the builder is the stateless `cstBuilder`; the parser's own state is module-level)
{
  const file = join(dir, 'parser.ts');
  writeFileSync(file, emitParser(grammar, tsTarget));
  const m = await import(file);
  const json = (src: string, mod: typeof m) => { try { const r = mod.parseWith(src, mod.cstBuilder); return r === null ? 'REJECT' : JSON.stringify(r); } catch { return 'REJECT'; } };
  const rows: string[][] = [];
  for (const [k, n] of seqNames.entries()) {
    const reused = SEQUENCES[n]!.map((src) => json(src, m));
    const fresh = await Promise.all(SEQUENCES[n]!.map(async (src, i) => json(src, await import(`${file}?fresh=${k}-${i}`))));
    rows.push(...reused.map((r, i) => [r, fresh[i]!]));
  }
  results.set('ts', rows);
  // A builder that keeps no node at all: an accepted parse has no root to hand back, which the
  // engine reports loudly (a broken builder contract), never as a reject.
  const dropAll = { leaf: () => null, node: () => null };
  const dropped = (src: string) => { try { return m.parseWith(src, dropAll) === null ? 'REJECT' : 'ROOT'; } catch (e) { return /no node for the root/.test(String(e)) ? 'NOROOT' : 'REJECT'; } };
  for (const n of seqNames) for (const src of SEQUENCES[n]!)
    check(`ts dropAll: ${JSON.stringify(src.slice(0, 30))} is reported as ${oracleVerdict(src) ? 'a builder with no root' : 'a reject'}`, dropped(src) === (oracleVerdict(src) ? 'NOROOT' : 'REJECT'), dropped(src));
}

// A builder that keeps nothing, in Go and Rust (as TS dropAll above): one line per input of every
// sequence, in order: NOROOT for an accepted input (the contract broken, loudly), REJECT for a rejected one.
function checkDropped(label: string, out: string): void {
  const lines = out.trimEnd().split('\n');
  let i = 0;
  for (const n of seqNames) for (const src of SEQUENCES[n]!) {
    const got = lines[i++];
    check(`${label} dropAll: ${JSON.stringify(src.slice(0, 30))} is reported as ${oracleVerdict(src) ? 'a builder with no root' : 'a reject'}`, got === (oracleVerdict(src) ? 'NOROOT' : 'REJECT'), got);
  }
}

// ── Go ──
if (!have('go', 'version')) console.log('  go: (toolchain not found — skipped)');
else {
  const gdir = join(dir, 'go');
  mkdirSync(join(gdir, 'parser'), { recursive: true });
  writeFileSync(join(gdir, 'go.mod'), 'module consumer\n\ngo 1.21\n');
  writeFileSync(join(gdir, 'parser', 'parser.go'), emitParser(grammar, goTarget));
  writeFileSync(join(gdir, 'main.go'), `package main

import (
	"fmt"
	"os"
	"strings"

	"consumer/parser"
)

func parseJSON(src string, b parser.Builder) (s string) {
	defer func() {
		if r := recover(); r != nil {
			if _, lex := r.(*parser.LexError); lex { s = "REJECT" } else { s = fmt.Sprint("PANIC ", r) }
		}
	}()
	h, ok := parser.ParseWith(src, b)
	if !ok { return "REJECT" }
	switch x := b.(type) {
	case *parser.CstBuilder:
		return parser.CstJSONWith(x, h)
	case *parser.SlimBuilder:
		return parser.SlimJSONWith(x, h)
	}
	panic("builder")
}

// dropAll keeps nothing: an accepted parse has no root to hand back, which ParseWith reports by
// panicking (the builder contract), never as a reject.
type dropAll struct{}

func (dropAll) Leaf(*[]int32, uint16, uint32, uint32, uint32) bool { return false }
func (dropAll) Finish(s *[]int32, sb int, _ uint16, fo, _, _ uint32, _ []parser.Tok) (int32, uint32, bool) {
	*s = (*s)[:sb]
	return 0, fo, false
}
func (dropAll) Node(s *[]int32, sb int, _ uint16, _, _, _, _ uint32) { *s = (*s)[:sb] }
func (dropAll) SpanOf(int32, []parser.Tok) (uint32, uint32)   { return 0, 0 }
func (dropAll) HeadSpan(int32, []parser.Tok) (uint32, uint32) { return 0, 0 }
func (dropAll) Checkpoint() (int, int)                        { return 0, 0 }
func (dropAll) Restore(int, int)                              {}

func dropped(src string) (s string) {
	defer func() {
		if r := recover(); r != nil {
			if _, lex := r.(*parser.LexError); lex { s = "REJECT" } else if strings.Contains(fmt.Sprint(r), "no node for the root") { s = "NOROOT" } else { s = fmt.Sprint("PANIC ", r) }
		}
	}()
	if _, ok := parser.ParseWith(src, dropAll{}); !ok { return "REJECT" }
	return "ROOT"
}

func main() {
	if os.Args[1] == "drop" {
		for _, f := range os.Args[2:] {
			b, err := os.ReadFile(f)
			if err != nil { panic(err) }
			fmt.Println(dropped(string(b)))
		}
		return
	}
	// The first argument names the builder (cst: the native engine's fast path; slim: the builder
	// engine, ParseWith through the Builder interface); each further one is a sequence of file
	// paths joined by ','.
	newB := func() parser.Builder { return &parser.CstBuilder{} }
	if os.Args[1] == "slim" { newB = func() parser.Builder { return &parser.SlimBuilder{} } }
	for _, seq := range os.Args[2:] {
		reused := newB()
		for _, f := range strings.Split(seq, ",") {
			b, err := os.ReadFile(f)
			if err != nil { panic(err) }
			src := string(b)
			fmt.Printf("%s\\t%s\\n", parseJSON(src, reused), parseJSON(src, newB()))
		}
	}
}
`);
  goBuild(['-o', 'consumer', '.'], { cwd: gdir });
  for (const [label, b] of [['go', 'cst'], ['go SlimBuilder', 'slim']] as const)
    results.set(label, readPairs(execFileSync(join(gdir, 'consumer'), [b, ...seqFiles.map((fs) => fs.join(','))], { encoding: 'utf8', maxBuffer: 1 << 28 })));
  checkDropped('go', execFileSync(join(gdir, 'consumer'), ['drop', ...seqFiles.flat()], { encoding: 'utf8', maxBuffer: 1 << 28 }));
}

// ── Rust ──
if (!have('rustc', '--version')) console.log('  rust: (toolchain not found — skipped)');
else {
  const rfile = join(dir, 'reuse.rs');
  writeFileSync(rfile, emitParser(grammar, rustTarget) + `
fn parse_json(src: &str, b: &mut CstBuilder) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| parse_with(src, b))) {
        Ok(Some(h)) => cst_json_with(b, h),
        _ => "REJECT".to_string(),
    }
}
fn parse_slim(src: &str, b: &mut SlimBuilder) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| parse_with(src, b))) {
        Ok(Some(h)) => slim_json_with(b, h),
        _ => "REJECT".to_string(),
    }
}
// DropAll keeps nothing: an accepted parse has no root to hand back, which parse_with reports by
// panicking (the builder contract), never as a reject.
#[derive(Default)]
struct DropAll;
impl Builder for DropAll {
    type H = i32;
    fn leaf(&mut self, _: &mut Vec<i32>, _: u16, _: u32, _: u32, _: u32) -> bool { false }
    fn node(&mut self, scratch: &mut Vec<i32>, sb: usize, _: u16, _: u32, _: u32, _: u32, _: u32) { scratch.truncate(sb); }
    fn span_of(&self, _: i32, _: &[Tok]) -> (u32, u32) { (0, 0) }
    fn head_span(&self, _: i32, _: &[Tok]) -> (u32, u32) { (0, 0) }
    fn dummy_h() -> i32 { 0 }
    fn tok_range(&self, _: i32) -> (u32, u32) { (0, 0) }
}
fn dropped(src: &str) -> &'static str {
    match std::panic::catch_unwind(|| parse_with(src, &mut DropAll::default())) {
        Ok(Some(_)) => "ROOT",
        Ok(None) => "REJECT",
        Err(e) => {
            let m = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            if m.contains("no node for the root") { "NOROOT" } else { "REJECT" }
        }
    }
}
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    if std::env::args().nth(1).unwrap() == "drop" {
        for f in std::env::args().skip(2) { println!("{}", dropped(&std::fs::read_to_string(f).unwrap())); }
        return;
    }
    // The first argument names the builder (cst or slim); each further one is a sequence: file
    // paths joined by ','.
    let slim = std::env::args().nth(1).unwrap() == "slim";
    for seq in std::env::args().skip(2) {
        let mut reused = CstBuilder::default();
        let mut reused_slim = SlimBuilder::default();
        for f in seq.split(',') {
            let src = std::fs::read_to_string(f).unwrap();
            let (r, fresh) = if slim { (parse_slim(&src, &mut reused_slim), parse_slim(&src, &mut SlimBuilder::default())) }
                else { (parse_json(&src, &mut reused), parse_json(&src, &mut CstBuilder::default())) };
            println!("{}\\t{}", r, fresh);
        }
    }
}
`);
  execFileSync('rustc', ['-A', 'warnings', rfile, '-o', join(dir, 'reuse')], { stdio: 'pipe' });
  for (const [label, b] of [['rust', 'cst'], ['rust SlimBuilder', 'slim']] as const)
    results.set(label, readPairs(execFileSync(join(dir, 'reuse'), [b, ...seqFiles.map((fs) => fs.join(','))], { encoding: 'utf8', maxBuffer: 1 << 28 })));
  checkDropped('rust', execFileSync(join(dir, 'reuse'), ['drop', ...seqFiles.flat()], { encoding: 'utf8', maxBuffer: 1 << 28 }));
}

for (const [label, rows] of results) {
  let r = 0;
  for (const n of seqNames) {
    SEQUENCES[n]!.forEach((src, i) => {
      const [reused, fresh] = rows[r++]!;
      check(`${label}: ${n} — input ${i + 1} (${src.length} B) with the reused builder ≡ a fresh builder`, reused === fresh,
        `reused ${reused!.slice(0, 80)}… vs fresh ${fresh!.slice(0, 80)}…`);
      check(`${label}: ${n} — input ${i + 1} (${src.length} B): the verdict is the interpreter's`, (fresh !== 'REJECT') === oracleVerdict(src),
        `fresh ${fresh!.slice(0, 80)}, interpreter ${oracleVerdict(src) ? 'accepts' : 'rejects'}`);
    });
  }
  // The sequences are meaningful only if both verdicts occur.
  check(`${label}: the sequences include an accepted and a rejected input`, rows.some(([, f]) => f === 'REJECT') && rows.some(([, f]) => f !== 'REJECT'));
}
console.log(`builder-reuse: ${seqNames.length} sequences, targets ${[...results.keys()].join(' / ')}`);
console.log(`\n${ok} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
