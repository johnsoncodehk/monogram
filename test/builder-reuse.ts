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
// The builder API itself (formerly test/ast-builder.ts), below the reuse sequences:
//   • parseWith(cstBuilder) ≡ parse() in TS, Rust parse_with(CstBuilder) and Go ParseWith(CstBuilder)
//     (and Go's interface path through a MirrorBuilder) ≡ parse(), over 16 grammars × 300 padded
//     inputs and a 2 MB TypeScript document;
//   • each target's Builder API is additive: the marker, the exports, a non-empty CST prefix;
//   • a Doc on a builder: CstBuilder's alignment ≡ a bare Doc's; a SlimBuilder (no shift) Doc ≡ a
//     fresh parse with reused = 0 and treeEq null; a third-party builder with shift reuses and ≡ fresh;
//   • Rust / Go SlimBuilder splice a single-child chain down to its leaf.
// Here a missing go / rustc FAILS the builder-API checks (as ast-builder did).
//
//   node test/builder-reuse.ts
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser } from '../src/targets/target.ts';
import { tsTarget } from '../src/targets/target-ts.ts';
import { goTarget } from '../src/targets/target-go.ts';
import { rustTarget } from '../src/targets/target-rust.ts';
import { asGoMain } from './go-main.ts';
import { scratchDir } from './scratch.ts';
import { cachedGoBuild, cachedRustc, RUSTC_LINTS } from './build-cache.ts';
import { createParser } from '../src/interpreter/interpreter.ts';
import type { Grammar } from '../src/grammar/types.ts';

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
  cachedGoBuild(['-o', 'consumer', '.'], { cwd: gdir });
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
  cachedRustc([...RUSTC_LINTS, rfile, '-o', join(dir, 'reuse')], { stdio: 'pipe' });
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

// ════ The builder API: parseWith(cstBuilder) ≡ parse(), Doc on a builder, per target ════

type Case = { grammar: string; path: string; seeds: string[] };

const CASES: Case[] = [
  {
    grammar: 'calc', path: './fixtures/calc.ts',
    seeds: ['1;', 'a;', '', '1 + 2 * 3;', '1 * 2 + 3;', '1 - 2 - 3;', 'a / b / c;', '1 + 2 + 3 + 4;',
      '-a;', '-(-a);', '- - a;', '-a * b;', '-a + b * c;', '-(a + b) * c;',
      '(1);', '((a));', '(1 + 2) * (3 - 4);', 'a * b + c * d - e / f;',
      'let x = 1; let y = x + 2 * x; (y);', 'let z = -(a * b) / (c - -d);', 'foo; bar; baz;'],
  },
  {
    grammar: 'minijs', path: './fixtures/minijs.ts',
    seeds: ['1;', 'a;', '', 'x = 1 + 2 * 3;', '-a * b + 1;', '(1 + 2) * 3;',
      'foo(a, b);', 'a.b.c;', 'a[0][1];', 'f()()();', 'a.b(c).d[e];',
      'let x = 1; let y = x + 2;', '[1, 2, 3];', '[];', '[a, [b, c]];',
      'if (x < 10) { x = x + 1; } else { y(); }', 'while (i) { i = i - 1; }',
      'function f(a, b) { return a + b; }', 'var s = "hi\\"x"; // c\n s.length;',
      '/* block */ a;', 'a === b !== c;', 'a && b || c;', '!a && -b;',
      'return;', 'return a + b;', 'const PI = 3;', '{ a; b; }',
      'f(g(h(x)), [1, 2], y.z);', 'while (a < b) { if (c) { d(); } e = e + 1; }'],
  },
  {
    grammar: 'richtokens', path: './fixtures/richtokens.ts',
    seeds: ['123', '0xFF', '1_000_000', '3.14', 'foo', 'bar_$x9', '"hi"', "'single'",
      '"esc\\"q\\n"', '123 0xa foo "s" 3.14', '0xDEADbeef 42 _id $x cafe // line\n 7',
      '/* block */ 99 x', 'caf\\u00e9 \\u0041bc', '1_2_3 0X1F 10.5 a1 b2'],
  },
  {
    grammar: 'regexjs', path: './fixtures/regexjs.ts',
    seeds: ['a / b;', 'var r = /abc/g;', 'return /re/;', 'if (x) /re/;', '(a + b) / c;',
      'a.b / c;', 'foo(x) / y;', '[1, 2] / 3;', 'var x = a / b / c;',
      'var re = /[a-z]+/i; x / y;', 'f(/re/, a / b);', 'var z = /a\\/b/;',
      'var d = /\\d+\\w/g;', 'var k = /[\\]]/;', 'if (a) /x/; else b / c;'],
  },
  {
    grammar: 'templatejs', path: './fixtures/templatejs.ts',
    seeds: ['var a = `hello`;', 'var b = `hi ${name}!`;', 'var c = `${x}${y}`;',
      'var d = `a${ x + 1 }b${ y * 2 }c`;', 'var e = `outer ${ `inner ${z}` } end`;',
      'var f = `${ {a} }`;', 'var f2 = `${ {a, b} } and ${ c }`;', 'var g = `no holes $ here`;',
      'f(`${a}`, `${b}`);', 'var h = `${a}${b}${c}`;', 'return `${ {x, y} }`;',
      'tag`hello`;', 'tag`${a}${b}`;', 'String.raw`a${b}c`.length;', 'x.tag`${y}`;'],
  },
  {
    grammar: 'envspec', path: './fixtures/envspec.ts',
    seeds: ['A=1', 'A=1\nB=2', 'A=1\n', 'A=1\n# c\nB=2', 'A=fn(1,\n2)\nB=3',
      'A=1\n\n\nB=2', '\n\nA=1', 'A=fn(1,\n2)'],
  },
  {
    grammar: 'altjs', path: './fixtures/altjs.ts',
    seeds: ['{a: 1};', '{"k": 2};', '{1: x};', '{a: 1, "b": 2, 3: c};', '{x: 1 + 2 * 3};',
      '({nested: {inner: 1}});', '{};', 'a + b;', '{k: (1 + 2)};'],
  },
  {
    grammar: 'nudjs', path: './fixtures/nudjs.ts',
    seeds: ['x;', 'foo + bar;', 'class C {};', 'class {};', 'class C extends B {};',
      '@dec class C { m(){} };', 'new Foo;', 'new C();', 'a.b.c;',
      'class C { @x m(){} n(){} };', 'x + class {} + y;'],
  },
  {
    grammar: 'postjs', path: './fixtures/postjs.ts',
    seeds: ['x++;', 'x--;', 'a + b++;', '++x;', 'x++ + y;', 'a.b++;', '(x)++;', '--a.b;',
      'x++ * 2;', '(a++).b;', 'x.y.z++;'],
  },
  {
    grammar: 'seqjs', path: './fixtures/seqjs.ts',
    seeds: ['[1, 2, 3];', '[];', '[1];', 'f(1, 2);', 'f();', '[a + b, c];',
      'f(g(1, 2), 3);', '(x);', 'f(a)(b, c);', '[[1,2],[3,4]];'],
  },
  {
    grammar: 'sljs', path: './fixtures/sljs.ts',
    seeds: ['return 1;', 'return;', 'return 1 + 2;', '1 + 2;', 'return /* c */ 1;',
      '(a);', 'return (1);', 'return\t1;'],
  },
  {
    grammar: 'arrowjs', path: './fixtures/arrowjs.ts',
    seeds: ['x => x;', '(a, b) => a + b;', '() => {};', 'x = (() => 1);', 'f(() => 1, 2);',
      '(x);', 'a + b;', 'x => y => x;', '(() => 2);', '(a) => a;', 'x = y => y;', 'foo();',
      '(a,) => b;', '(a, b,) => a;'],
  },
  {
    grammar: 'ledjs', path: './fixtures/ledjs.ts',
    seeds: ['a == b ? c : d;', 'a ? b : c ? d : e;', 'a + b ? c : d - e;', 'a in b;',
      'a in b in c;', 'x instanceof Y;', 'a < b in c;', '1 + 2 * 3 ? 4 : 5;',
      '(a ? b : c) + d;', 'a in b ? c : d;', 'a = b ? c : d;'],
  },
  {
    grammar: 'noinjs', path: './fixtures/noinjs.ts',
    seeds: ['for (x in y) z;', 'x in y;', 'for (a.b in c) d;', 'a in b in c;',
      'for ((x) in y) z;', 'for (x in y) a in b;', 'for (x in a in b) z;',
      '(a in b);', 'for (a in b) for (c in d) e;'],
  },
  {
    grammar: 'javascript', path: '../javascript.ts',
    seeds: [
      'var x = 1, y = 2;', 'function f(a, b) { return a + b; }', 'const g = (x) => x * 2;',
      'x => x + 1;', 'a ? b : c;', 'a.b.c();', 'f(g(1, 2), 3);', '[1, 2, 3].map(f);',
      'for (let i = 0; i < n; i++) x();', 'for (const k in obj) { y(); }', 'while (x) { z(); }',
      'if (a) b(); else c();', 'class C extends B { m() {} get p() { return 1; } }', 'a++; b--;',
      'typeof x; void 0;', 'new Foo(1, 2);', 'a ?? b; a?.b?.c;',
      'try { f(); } catch (e) { g(); } finally { h(); }', 'switch (x) { case 1: f(); break; default: g(); }',
      'a instanceof B; a in obj;', '(function () {})(); (() => {})();', 'x = a && b || c;',
      'do { x(); } while (y);', 'function* gen() { yield* o(); }', 'const { a, b: c, ...r } = o;',
      'const [p, , q, ...z] = arr;', 'label: for (;;) { break label; }', 'async function h() { await x; }',
      '(() => {})();', 'f(() => a, () => b);', 'let g = () => x => x + 1;',
      'x.y.z++;', '(a++).b;', 'a++ instanceof B;', 'for (a in b) c;', 'new a.b();', '((((x))));',
    ],
  },
  {
    grammar: 'typescript', path: '../typescript.ts',
    seeds: [
      'const a: number = 1;', 'let s: string;', 'type Alias = { a: number; b?: string };',
      'type U = "a" | "b" | "c";', 'function gen2<T, U extends T>(x: T, y: U): T { return x; }',
      'interface I<T> extends A<T> { m(x: T): T; }', 'const c = x as const;',
      'function isStr(x: unknown): x is string { return true; }', 'enum E { A, B, C }',
      'const n = maybe!;', 'let arr: number[];', 'type Fn = (x: number) => string;',
      'class C<in out T> { value!: T; }',
      'var x = 1, y = 2;', 'function f(a, b) { return a + b; }', 'const g = (x) => x * 2;',
      'x => x + 1;', 'a ? b : c;', 'a.b.c();', 'f(g(1, 2), 3);',
    ],
  },
];

const TMP = scratchDir('builder-api');

/** A ≥2MB typescript document: the typescript seeds repeated, one per line. */
const CORPUS_2MB = (() => {
  const seeds = CASES.find((x) => x.grammar === 'typescript')!.seeds;
  const lines: string[] = [];
  let bytes = 0;
  for (let i = 0; bytes < 2_100_000; i++) {
    const line = seeds[i % seeds.length] + '\n';
    lines.push(line);
    bytes += Buffer.byteLength(line);
  }
  return lines.join('');
})();

/** ≥300 inputs per grammar — whitespace paddings only (keep lexical validity). */
function variants(seeds: string[], n = 300): string[] {
  const out: string[] = [];
  const pads = ['', ' ', '  ', '\n', ' \n ', '\t', '  \t  '];
  let i = 0;
  while (out.length < n) {
    const s = seeds[i % seeds.length]!;
    const p = pads[i % pads.length]!;
    const q = pads[(i * 3) % pads.length]!;
    if (i % 5 === 0) out.push(s);
    else if (i % 5 === 1) out.push(p + s + q);
    else if (i % 5 === 2) out.push(p + s);
    else if (i % 5 === 3) out.push(s + q);
    else out.push(q + p + s + p + q);
    i++;
  }
  return out;
}

type Align = {
  oldN: number; newN: number; prefix: number; suffix: number; relexed: number; reused: number;
  streamEq?: boolean; treeEq?: boolean | null;
};
type Doc<H> = {
  text(): string;
  root(): H | null;
  align(): Align | null;
  edit(edits: { start: number; end: number; text: string }[]): H | null;
};
type Mod = {
  tokenize: (src: string) => { kind: string; text: string; off: number; end: number; nl: boolean; kid: number; lid: number }[];
  parse: (src: string) => unknown;
  parseWith: <H>(src: string, b: Builder<H>) => H | null;
  cstBuilder: Builder<unknown>;
  createDoc: <H = unknown>(src: string, opts?: { validate?: boolean; builder?: Builder<H> }) => Doc<H>;
};

type Builder<H> = {
  leaf(tokenType: string, kid: number, lid: number, off: number, end: number): H | null;
  node(rule: string, children: H[], off: number, end: number): H | H[] | null;
  shift?(h: H, byteDelta: number, tokDelta: number): H;
};

async function loadMod(grammar: Grammar, name: string): Promise<Mod> {
  const out = `${TMP}/${name}.mts`;
  writeFileSync(out, emitParser(grammar, tsTarget));
  return await import(out + '?t=' + Date.now()) as Mod;
}

/** Strip engine-side lookahead watermark. After D3, parse() may still stamp Node.ext as an
 *  oracle for Doc.validate asserts, but parseWith must not mutate consumer handles — so
 *  cstBuilder ≡ parse compares structure without `ext`. */
function cstCanon(v: unknown): string {
  return JSON.stringify(v, (k, x) => (k === 'ext' ? undefined : x));
}

function parseJson(mod: Mod, src: string): string {
  try {
    return cstCanon(mod.parse(src));
  } catch {
    return '__THROW__';
  }
}

function withJson(mod: Mod, src: string): string {
  try {
    return cstCanon(mod.parseWith(src, mod.cstBuilder));
  } catch {
    return '__THROW__';
  }
}


/** Slim builder used in the CST-premium bench: drop trivia/punct leaves + inline unary chains. */
function slimBuilder(): Builder<unknown> {
  return {
    leaf(tokenType, _k, _l, off, end) {
      if (tokenType === '$punct' || tokenType === '$keyword' || tokenType === '$operator') return null;
      return { t: tokenType, off, end };
    },
    node(rule, children, off, end) {
      if (children.length === 1) return children as unknown[];
      if (children.length === 0) return null;
      return { r: rule, c: children, off, end };
    },
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ─── 1. Default equivalence: 16 grammars × ≥300 variants ────────────────────
console.log('builder-api: cstBuilder ≡ parse()');
for (const c of CASES) {
  const grammar: Grammar = (await import(c.path)).default;
  const mod = await loadMod(grammar, c.grammar);
  const inputs = variants(c.seeds, 300);
  assert(inputs.length >= 300, `${c.grammar}: need ≥300, got ${inputs.length}`);
  let eq = 0, bothNull = 0, mismatch = 0;
  for (const src of inputs) {
    const a = parseJson(mod, src);
    const b = withJson(mod, src);
    if (a === b) {
      eq++;
      if (a === 'null') bothNull++;
    } else {
      mismatch++;
      if (mismatch <= 3) console.log(`    mismatch ${c.grammar}: ${JSON.stringify(src)}\n      A=${a.slice(0, 180)}\n      B=${b.slice(0, 180)}`);
    }
  }
  check(`${c.grammar} (${inputs.length} inputs)`, mismatch === 0, `${eq} eq (${bothNull} null)`);
}

// ─── 3. CST emit prefix identity tip (additive marker present) ──────────────
{
  const grammar: Grammar = (await import('./fixtures/calc.ts')).default;
  const emitted = emitParser(grammar, tsTarget);
  check('builder addon marker present', emitted.includes('// ─── Builder API'));
  check('exports parseWith + cstBuilder + Builder',
    emitted.includes('export function parseWith') && emitted.includes('export const cstBuilder') && emitted.includes('export type Builder'));
  check('exports createDoc + optional Builder.shift',
    emitted.includes('export function createDoc') && emitted.includes('shift?(h: H, byteDelta: number, tokDelta: number): H'));
  const prefix = emitted.slice(0, emitted.indexOf('// ─── Builder API'));
  check('CST prefix stable hash (nonempty)', prefix.length > 1000,
    createHash('sha256').update(prefix).digest('hex').slice(0, 12));
}

// ─── 3b. TS Doc + optional shift (D2 semantics on createDoc) ─────────────────
console.log('\nbuilder-api: ts createDoc builder / shift contracts');
{
  const grammar: Grammar = (await import('./fixtures/calc.ts')).default;
  const mod = await loadMod(grammar, 'calc-doc-shift');
  const init = '1+2;\n3+4;\n5+6;';

  // cstBuilder Doc (or bare createDoc): align JSON field-by-field ≡ bare createDoc
  {
    const bare = mod.createDoc(init, { validate: true });
    bare.edit([{ start: 0, end: 1, text: '9' }]);
    const withCst = mod.createDoc(init, { validate: true, builder: mod.cstBuilder as Builder<unknown> });
    withCst.edit([{ start: 0, end: 1, text: '9' }]);
    const a = JSON.stringify(bare.align());
    const b = JSON.stringify(withCst.align());
    check('ts createDoc(cstBuilder) align ≡ createDoc()', a === b, `bare=${a} with=${b}`);
    check('ts createDoc(cstBuilder) reused>0 + streamEq/treeEq',
      !!bare.align() && (bare.align()!.reused > 0) && bare.align()!.streamEq === true && bare.align()!.treeEq === true,
      JSON.stringify(bare.align()));
  }

  // Slim (no shift): multi-step edit ≡ fresh parseWith; reused=0; treeEq=null
  {
    const slim: Builder<unknown> = slimBuilder();
    const steps: { text: string; edits: { start: number; end: number; text: string }[] }[] = [
      { text: init, edits: [] },
      { text: '9+2;\n3+4;\n5+6;', edits: [{ start: 0, end: 1, text: '9' }] },
      { text: '9+2;\n3+4;\n5+7;', edits: [{ start: 12, end: 13, text: '7' }] },
    ];
    const doc = mod.createDoc(init, { validate: true, builder: slim });
    let ok = true;
    const aligns: Align[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (step.edits.length) doc.edit(step.edits);
      if (doc.text() !== step.text) { ok = false; console.log(`    slim text[${i}] got=${JSON.stringify(doc.text())}`); }
      const a = doc.align();
      if (i > 0) {
        if (!a) { ok = false; console.log(`    slim missing align[${i}]`); }
        else {
          aligns.push(a);
          if (a.reused !== 0) { ok = false; console.log(`    slim reused[${i}]=${a.reused}`); }
          if (a.streamEq !== true) { ok = false; console.log(`    slim streamEq[${i}]=${a.streamEq}`); }
          if (a.treeEq !== null) { ok = false; console.log(`    slim treeEq[${i}]=${JSON.stringify(a.treeEq)}`); }
        }
      }
      const fresh = mod.parseWith(doc.text(), slim);
      if (JSON.stringify(doc.root()) !== JSON.stringify(fresh)) {
        ok = false;
        console.log(`    slim≠fresh[${i}]`);
      }
    }
    check('ts Slim Doc multi-edit ≡ fresh', ok);
    check('ts Slim reused=0 each step + streamEq + treeEq=null',
      aligns.length >= 2 && aligns.every((a) => a.reused === 0 && a.streamEq === true && a.treeEq === null),
      aligns.map((a) => `reused=${a.reused},treeEq=${a.treeEq}`).join(' | '));
  }

  // Mirror (third-party shift): reuse engages; result ≡ fresh; treeEq=null
  {
    const mirror: Builder<unknown> = {
      leaf: (tt, k, l, off, end) => mod.cstBuilder.leaf(tt, k, l, off, end),
      node: (rule, children, off, end) => mod.cstBuilder.node(rule, children, off, end),
      shift: (h, bd, td) => {
        const sh = mod.cstBuilder.shift;
        if (!sh) throw new Error('cstBuilder.shift missing');
        return sh.call(mod.cstBuilder, h, bd, td);
      },
    };
    const doc = mod.createDoc(init, { validate: true, builder: mirror });
    doc.edit([{ start: 0, end: 1, text: '9' }]);
    const a = doc.align();
    const fresh = mod.parseWith(doc.text(), mirror);
    check('ts Mirror Doc.edit reuse+≡fresh',
      !!a && a.reused > 0 && a.streamEq === true && a.treeEq === null && cstCanon(doc.root()) === cstCanon(fresh),
      JSON.stringify(a));
  }
}

// ─── 4. Rust target: parse_with(CstBuilder) ≡ parse + SlimBuilder smoke ──────
console.log('\nbuilder-api: rust parse_with(CstBuilder) ≡ parse()');
const RUST_TMP = scratchDir('builder-api-rust');

function haveRustc(): boolean {
  try { execFileSync('rustc', ['--version'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

const rustHarness = `
fn gate_skip_ws(s: &[u8], mut i: usize) -> usize { while i < s.len() && (s[i] as char).is_whitespace() { i += 1; } i }
fn gate_parse_str(s: &[u8], mut i: usize) -> Option<(String, usize)> {
    if s.get(i)? != &b'"' { return None; }
    i += 1;
    let mut out = String::new();
    while i < s.len() {
        match s[i] {
            b'"' => return Some((out, i + 1)),
            b'\\\\' => { i += 1; if i >= s.len() { return None; }
                out.push(match s[i] { b'n' => '\\n', b'r' => '\\r', b't' => '\\t', b'"' => '"', b'\\\\' => '\\\\', b'/' => '/', c => c as char });
                i += 1; }
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
fn parse_json_str_array(s: &str) -> Option<Vec<String>> {
    let b = s.as_bytes();
    let mut i = gate_skip_ws(b, 0);
    if *b.get(i)? != b'[' { return None; }
    i = gate_skip_ws(b, i + 1);
    let mut out = Vec::new();
    if *b.get(i)? == b']' { return Some(out); }
    loop {
        let (v, ni) = gate_parse_str(b, i)?;
        out.push(v);
        i = gate_skip_ws(b, ni);
        if *b.get(i)? == b']' { return Some(out); }
        if *b.get(i)? != b',' { return None; }
        i = gate_skip_ws(b, i + 1);
    }
}
/// Third-party builder: CstBuilder guts + SUPPORTS_SHIFT, but NOT the CstBuilder type
/// (SUPPORTS_TREE_EQ=false → validate skips treeEq). Proves shift contract is usable.
#[derive(Default)]
struct MirrorBuilder { inner: CstBuilder }
impl Builder for MirrorBuilder {
    type H = i32;
    const SUPPORTS_SHIFT: bool = true;
    const SUPPORTS_TREE_EQ: bool = false;
    #[inline(always)] fn dummy_h() -> i32 { 0 }
    #[inline(always)] fn shift(&mut self, h: i32, bd: isize, td: isize) -> i32 { Builder::shift(&mut self.inner, h, bd, td) }
    #[inline(always)] fn should_reclaim(&self, root: i32, baseline: usize) -> bool { Builder::should_reclaim(&self.inner, root, baseline) }
    #[inline(always)] fn arena_len(&self) -> usize { Builder::arena_len(&self.inner) }
    #[inline(always)] fn root_kid_at(&self, root: i32, idx: usize) -> i32 { Builder::root_kid_at(&self.inner, root, idx) }
    #[inline(always)] fn rule_id_of(&self, h: i32) -> u16 { Builder::rule_id_of(&self.inner, h) }
    #[inline(always)] fn validate_entries(&self, e: &[EntryMeta], root: i32) { Builder::validate_entries(&self.inner, e, root) }
    #[inline(always)] fn checkpoint(&self) -> (usize, usize) { self.inner.checkpoint() }
    #[inline(always)] fn restore(&mut self, ck: (usize, usize)) { self.inner.restore(ck) }
    #[inline(always)] fn leaf(&mut self, scratch: &mut Vec<i32>, tt: u16, ti: u32, off: u32, end: u32) -> bool { self.inner.leaf(scratch, tt, ti, off, end) }
    #[inline(always)] fn finish(&mut self, scratch: &mut Vec<i32>, sb: usize, rule_id: u16, fallback_off: u32, tok_start: u32, tok_end: u32, toks: &[Tok]) -> (i32, u32, bool) {
        self.inner.finish(scratch, sb, rule_id, fallback_off, tok_start, tok_end, toks)
    }
    #[inline(always)] fn node(&mut self, scratch: &mut Vec<i32>, sb: usize, rule_id: u16, off: u32, end: u32, tok_start: u32, tok_end: u32) {
        self.inner.node(scratch, sb, rule_id, off, end, tok_start, tok_end)
    }
    #[inline(always)] fn span_of(&self, h: i32, toks: &[Tok]) -> (u32, u32) { self.inner.span_of(h, toks) }
    #[inline(always)] fn head_span(&self, h: i32, toks: &[Tok]) -> (u32, u32) { self.inner.head_span(h, toks) }
    #[inline(always)] fn note_look(&mut self, h: i32, max_look: u32) { self.inner.note_look(h, max_look) }
    #[inline(always)] fn entry_meta(&mut self, h: i32, max_look: u32, toks: &[Tok]) -> EntryMeta { self.inner.entry_meta(h, max_look, toks) }
    #[inline(always)] fn tok_range(&self, h: i32) -> (u32, u32) { self.inner.tok_range(h) }
    #[inline(always)] fn toks(&self) -> Option<&Vec<Tok>> { self.inner.toks() }
    #[inline(always)] fn toks_mut(&mut self) -> Option<&mut Vec<Tok>> { self.inner.toks_mut() }
}
fn gate_print_align(a: &Align) {
    match (a.stream_eq, a.tree_eq) {
        (Some(eq), Some(te)) => println!("ALIGN\\toldN={}\\tnewN={}\\tprefix={}\\tsuffix={}\\trelexed={}\\treused={}\\tstreamEq={}\\ttreeEq={}", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.reused, eq, te),
        (Some(eq), None) => println!("ALIGN\\toldN={}\\tnewN={}\\tprefix={}\\tsuffix={}\\trelexed={}\\treused={}\\tstreamEq={}\\ttreeEq=null", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.reused, eq),
        (None, Some(te)) => println!("ALIGN\\toldN={}\\tnewN={}\\tprefix={}\\tsuffix={}\\trelexed={}\\treused={}\\tstreamEq=null\\ttreeEq={}", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.reused, te),
        (None, None) => println!("ALIGN\\toldN={}\\tnewN={}\\tprefix={}\\tsuffix={}\\trelexed={}\\treused={}\\tstreamEq=null\\ttreeEq=null", a.old_n, a.new_n, a.prefix, a.suffix, a.relexed, a.reused),
    }
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(|s| s.as_str()).unwrap_or("eq-batch");
    if mode == "slim-demo" {
        for src in &["(1);", "1;"] {
            let mut s = SlimBuilder::new();
            match parse_with(src, &mut s) {
                Some(h) if h < 0 => {
                    let toks = lex(src);
                    let (ti, tt) = decode_leaf(h);
                    let t = &toks[ti as usize];
                    println!("LEAF\\t{}\\t{}\\t{}", src, TT_NAMES[tt as usize], t.off);
                }
                Some(h) => println!("NODE\\t{}\\t{}", src, slim_json_with(&s, h)),
                None => println!("NULL\\t{}", src),
            }
        }
        return;
    }
    // Doc<CstBuilder> edit: print align after each batch (stdin: init\\0batch JSON lines omitted —
    // fixed embedded session for the gate).
    if mode == "doc-cst-edit" {
        let init = "1+2;\\n3+4;\\n5+6;";
        let mut doc = Doc::new(init.to_string());
        doc.set_validate(true);
        doc.edit(&[Edit { start: 0, end: 1, text: "9".into() }]);
        if let Some(a) = doc.alignment() { gate_print_align(a); }
        match doc.cst_json() {
            Some(j) => { println!("CST\\t{}", j); println!("ok"); }
            None => { println!("fail cst_json"); std::process::exit(1); }
        }
        return;
    }
    if mode == "doc-slim-edit" {
        // Multi-step SlimBuilder Doc.edit ≡ fresh parse_with; reused must stay 0; no treeEq.
        let steps: &[(&str, &[Edit])] = &[
            ("1+2;\\n3+4;\\n5+6;", &[]),
            ("9+2;\\n3+4;\\n5+6;", &[Edit { start: 0, end: 1, text: "9".into() }]),
            ("9+2;\\n3+4;\\n5+7;", &[Edit { start: 12, end: 13, text: "7".into() }]),
        ];
        let mut doc = Doc::<SlimBuilder>::new("1+2;\\n3+4;\\n5+6;".into());
        doc.set_validate(true);
        for (i, (want_text, eds)) in steps.iter().enumerate() {
            if !eds.is_empty() { doc.edit(eds); }
            if doc.text() != *want_text {
                println!("fail text[{}] got={:?}", i, doc.text());
                std::process::exit(1);
            }
            if let Some(a) = doc.alignment() {
                gate_print_align(a);
                if a.reused != 0 { println!("fail reused[{}]={}", i, a.reused); std::process::exit(1); }
                if a.stream_eq != Some(true) { println!("fail streamEq[{:?}]", a.stream_eq); std::process::exit(1); }
                if a.tree_eq.is_some() { println!("fail treeEq should be null"); std::process::exit(1); }
            } else if i > 0 {
                println!("fail missing align[{}]", i); std::process::exit(1);
            }
            let mut fresh = SlimBuilder::new();
            let fh = parse_with(doc.text(), &mut fresh);
            match (doc.root_handle(), fh) {
                (Some(dr), Some(fr)) => {
                    let ja = slim_json_with(doc.builder(), dr);
                    let jb = slim_json_with(&fresh, fr);
                    if ja != jb {
                        println!("fail slim≠fresh[{}]\\n{}\\n{}", i, ja, jb);
                        std::process::exit(1);
                    }
                }
                (None, None) => {}
                _ => { println!("fail accept[{}]", i); std::process::exit(1); }
            }
        }
        println!("ok slim-edit");
        return;
    }
    if mode == "doc-mirror-shift" {
        // Third-party SUPPORTS_SHIFT=true → reuse engages; result ≡ fresh CST JSON.
        let mut doc = Doc::new_with("1+2;\\n3+4;\\n5+6;".into(), MirrorBuilder::default());
        doc.set_validate(true);
        doc.edit(&[Edit { start: 0, end: 1, text: "9".into() }]);
        let a = doc.alignment().expect("align");
        gate_print_align(a);
        if a.reused == 0 { println!("fail expected reuse>0"); std::process::exit(1); }
        if a.stream_eq != Some(true) { println!("fail streamEq"); std::process::exit(1); }
        if a.tree_eq.is_some() { println!("fail treeEq should be null for MirrorBuilder"); std::process::exit(1); }
        let root = doc.root_handle().expect("root");
        let got = cst_json_with(&doc.builder().inner, root);
        let fresh = parse(doc.text()).expect("fresh");
        let mut want = String::new();
        write_json(&fresh.0, fresh.1, &mut want);
        if got != want {
            println!("fail mirror≠fresh");
            std::process::exit(1);
        }
        println!("ok mirror-shift reused={}", a.reused);
        return;
    }
    let mut raw = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw).unwrap();
    let inputs = parse_json_str_array(&raw).expect("json string array");
    let mut bad = 0usize;
    for (i, src) in inputs.iter().enumerate() {
        let a = parse(src);
        let mut b = CstBuilder::new();
        let root = parse_with(src, &mut b);
        match (a.as_ref(), root) {
            (Some((p, r)), Some(rw)) => {
                let mut ja = String::new();
                write_json(p, *r, &mut ja);
                let jb = cst_json_with(&b, rw);
                if ja != jb {
                    bad += 1;
                    if bad <= 3 { eprintln!("mismatch[{}]: {:?}", i, src); }
                }
            }
            (None, None) => {}
            _ => { bad += 1; if bad <= 3 { eprintln!("accept[{}]: {:?}", i, src); } }
        }
    }
    if bad == 0 { println!("ok {}", inputs.len()); } else { println!("bad {}", bad); std::process::exit(1); }
}
`;

if (!haveRustc()) {
  check('rust toolchain present', false, 'rustc missing — rust builder gates skipped');
} else {
  // Additive marker + prefix tip on calc
  {
    const grammar: Grammar = (await import('./fixtures/calc.ts')).default;
    const emitted = emitParser(grammar, rustTarget);
    check('rust builder addon marker', emitted.includes('// ─── Builder API'));
    check('rust exports parse_with + CstBuilder + Builder',
      emitted.includes('pub fn parse_with') && emitted.includes('pub struct CstBuilder') && emitted.includes('pub trait Builder'));
    const prefix = emitted.slice(0, emitted.indexOf('// ─── Builder API'));
    check('rust CST prefix nonempty', prefix.length > 1000,
      createHash('sha256').update(prefix).digest('hex').slice(0, 12));
  }

  // One binary per grammar (library + rustHarness, every mode): the sections below run
  // their modes on these same binaries.
  const rustBins = new Map<string, string>();
  for (const c of CASES) {
    const grammar: Grammar = (await import(c.path)).default;
    const rfile = `${RUST_TMP}/${c.grammar}.rs`;
    const bin = `${RUST_TMP}/${c.grammar}`;
    writeFileSync(rfile, emitParser(grammar, rustTarget) + rustHarness);
    try {
      cachedRustc([...RUSTC_LINTS, rfile, '-o', bin], { stdio: 'pipe', timeout: 120_000 });
    } catch (e) {
      check(`rustc ${c.grammar}`, false, String(e).slice(0, 200));
      continue;
    }
    rustBins.set(c.grammar, bin);
    const inputs = variants(c.seeds, 300);
    const out = execFileSync(bin, ['eq-batch'], {
      input: JSON.stringify(inputs), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
    }).trim();
    check(`rust ${c.grammar} (${inputs.length} inputs)`, out.startsWith('ok '), out);
  }
  const rustBin = (grammar: string): string => {
    const bin = rustBins.get(grammar);
    if (!bin) throw new Error(`rust ${grammar} binary was not built`);
    return bin;
  };

  // SlimBuilder smoke on javascript
  {
    const bin = rustBin('javascript');
    const slimOut = execFileSync(bin, ['slim-demo'], { encoding: 'utf8' }).trim().split('\n');
    check('rust slim (1); → Number leaf (splice)', slimOut.some((l) => l.startsWith('LEAF\t(1);\tNumber\t')));
    check('rust slim 1; → Number leaf (splice)', slimOut.some((l) => l.startsWith('LEAF\t1;\tNumber\t')));
  }

  // 2MB corpus equivalence
  {
    const corpus = CORPUS_2MB;
    check('2MB corpus present', Buffer.byteLength(corpus) >= 2_000_000, `${Buffer.byteLength(corpus)} bytes`);
    const out = execFileSync(rustBin('typescript'), ['eq-batch'], {
      input: JSON.stringify([corpus]), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 180_000,
    }).trim();
    check('rust 2MB corpus parse_with ≡ parse', out === 'ok 1', out);
  }

  // Doc<B> + optional shift: CstBuilder / SlimBuilder / MirrorBuilder (third-party SUPPORTS_SHIFT)
  {
    console.log('builder-api: rust Doc<B> edit contracts');
    const bin = rustBin('calc');

    const cstOut = execFileSync(bin, ['doc-cst-edit'], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n');
    const cstAlign = cstOut.find((l) => l.startsWith('ALIGN\t'));
    check('rust Doc<CstBuilder> edit ok', cstOut.includes('ok'), cstOut.slice(-3).join(' | '));
    check('rust Doc<CstBuilder> align streamEq+treeEq',
      !!cstAlign && cstAlign.includes('streamEq=true') && cstAlign.includes('treeEq=true'), cstAlign);
    check('rust Doc<CstBuilder> reused > 0',
      !!cstAlign && /reused=([1-9]\d*)/.test(cstAlign), cstAlign);

    const slimOut = execFileSync(bin, ['doc-slim-edit'], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n');
    check('rust Doc<SlimBuilder> multi-edit ≡ fresh', slimOut.includes('ok slim-edit'), slimOut.slice(-5).join(' | '));
    const slimAligns = slimOut.filter((l) => l.startsWith('ALIGN\t'));
    check('rust Doc<SlimBuilder> reused=0 each step',
      slimAligns.length >= 2 && slimAligns.every((l) => l.includes('reused=0')), slimAligns.join(' || '));
    check('rust Doc<SlimBuilder> streamEq, treeEq=null',
      slimAligns.every((l) => l.includes('streamEq=true') && l.includes('treeEq=null')), slimAligns.join(' || '));

    const mirOut = execFileSync(bin, ['doc-mirror-shift'], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n');
    check('rust MirrorBuilder Doc.edit reuse+≡fresh', mirOut.some((l) => l.startsWith('ok mirror-shift')), mirOut.join(' | '));
    check('rust MirrorBuilder reused>0 treeEq=null',
      mirOut.some((l) => l.startsWith('ALIGN\t') && /reused=([1-9]\d*)/.test(l) && l.includes('treeEq=null') && l.includes('streamEq=true')),
      mirOut.filter((l) => l.startsWith('ALIGN\t')).join(' || '));
  }
}

// ─── 5. Go target: ParseWith(CstBuilder) ≡ parse + SlimBuilder smoke ─────────
console.log('\nbuilder-api: go ParseWith(CstBuilder) ≡ parse()');
const GO_TMP = scratchDir('builder-api-go');

function haveGo(): boolean {
  try { execFileSync('go', ['version'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

const goHarness = `
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// MirrorBuilder is intentionally NOT *CstBuilder, so ParseWith routes through
// parserW (interface path). Rebuilds full CST shape isomorphic to native JSON.
type MirrorBuilder struct {
	Nodes []Node
	Kids  []int32
}

func (b *MirrorBuilder) Checkpoint() (nb, kb int) { return len(b.Nodes), len(b.Kids) }
func (b *MirrorBuilder) Restore(nb, kb int)       { b.Nodes = b.Nodes[:nb]; b.Kids = b.Kids[:kb] }
func (b *MirrorBuilder) Leaf(scratch *[]int32, ttId uint16, tokIdx, off, end uint32) bool {
	_ = off
	_ = end
	if ttId == TT_SKIP_PUNCT {
		return false
	}
	*scratch = append(*scratch, encodeLeaf(tokIdx, uint8(ttId)))
	return true
}
func (b *MirrorBuilder) Finish(scratch *[]int32, sb int, ruleId uint16, fallbackOff, tokStart, tokEnd uint32, toks []Tok) (int32, uint32, bool) {
	nn := len(*scratch)
	kidStart := len(b.Kids)
	off, end := fallbackOff, fallbackOff
	if nn > sb {
		o0, _ := cstKidOffEnd(b.Nodes, toks, (*scratch)[sb])
		_, e1 := cstKidOffEnd(b.Nodes, toks, (*scratch)[nn-1])
		off, end = o0, e1
	}
	b.Kids = append(b.Kids, (*scratch)[sb:nn]...)
	*scratch = (*scratch)[:sb]
	b.Nodes = append(b.Nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(nn - sb), Offset: off, End: end, TokStart: tokStart, TokEnd: tokEnd, Ext: 0})
	return int32(len(b.Nodes) - 1), off, true
}
func (b *MirrorBuilder) Node(scratch *[]int32, sb int, ruleId uint16, off, end, tokStart, tokEnd uint32) {
	nn := len(*scratch)
	kidStart := len(b.Kids)
	b.Kids = append(b.Kids, (*scratch)[sb:nn]...)
	*scratch = (*scratch)[:sb]
	b.Nodes = append(b.Nodes, Node{RuleId: ruleId, KidStart: uint32(kidStart), KidCount: uint32(nn - sb), Offset: off, End: end, TokStart: tokStart, TokEnd: tokEnd, Ext: 0})
	*scratch = append(*scratch, int32(len(b.Nodes)-1))
}
func (b *MirrorBuilder) SpanOf(h int32, toks []Tok) (uint32, uint32) {
	return cstKidOffEnd(b.Nodes, toks, h)
}
func (b *MirrorBuilder) HeadSpan(h int32, toks []Tok) (uint32, uint32) {
	id := h
	for {
		if id < 0 {
			ti, _ := decodeLeaf(id)
			t := &toks[ti]
			return t.Off, t.End
		}
		nd := &b.Nodes[id]
		if nd.KidCount == 0 {
			return nd.Offset, nd.End
		}
		id = b.Kids[nd.KidStart]
	}
}
// Shift implements Shifter — third-party incremental reuse without *CstBuilder identity.
func (b *MirrorBuilder) Shift(h int32, byteDelta, tokDelta int) int32 {
	cb := &CstBuilder{Nodes: b.Nodes, Kids: b.Kids}
	out := cb.Shift(h, byteDelta, tokDelta)
	b.Nodes, b.Kids = cb.Nodes, cb.Kids
	return out
}
func MirrorJSONWith(b *MirrorBuilder, toks []Tok, root int32) string {
	var buf strings.Builder
	writeJSONWith(b.Nodes, b.Kids, toks, root, &buf)
	return buf.String()
}
func gatePrintAlign(a *Align) {
	if a == nil {
		return
	}
	se, te := "null", "null"
	if a.StreamEq != nil {
		se = fmt.Sprintf("%v", *a.StreamEq)
	}
	if a.TreeEq != nil {
		te = fmt.Sprintf("%v", *a.TreeEq)
	}
	fmt.Printf("ALIGN\\toldN=%d\\tnewN=%d\\tprefix=%d\\tsuffix=%d\\trelexed=%d\\treused=%d\\tstreamEq=%s\\ttreeEq=%s\\n",
		a.OldN, a.NewN, a.Prefix, a.Suffix, a.Relexed, a.Reused, se, te)
}

func main() {
	mode := "eq-batch"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	if mode == "slim-demo" {
		for _, src := range []string{"(1);", "1;"} {
			b := &SlimBuilder{}
			h, ok := ParseWith(src, b)
			if !ok {
				fmt.Printf("NULL\\t%s\\n", src)
				continue
			}
			toks := lex(src)
			if h < 0 {
				ti, tt := decodeLeaf(h)
				t := toks[ti]
				fmt.Printf("LEAF\\t%s\\t%s\\t%d\\n", src, TT_NAMES[tt], t.Off)
			} else {
				fmt.Printf("NODE\\t%s\\t%s\\n", src, SlimJSONWith(b, h))
			}
		}
		return
	}
	if mode == "doc-cst-edit" {
		init := "1+2;\\n3+4;\\n5+6;"
		bare := NewDoc(init)
		bare.SetValidate(true)
		bare.Edit([]Edit{{Start: 0, End: 1, Text: "9"}})
		with := NewDocWith(init, &CstBuilder{})
		with.SetValidate(true)
		with.Edit([]Edit{{Start: 0, End: 1, Text: "9"}})
		a, b := bare.Align(), with.Align()
		gatePrintAlign(a)
		if a == nil || b == nil || a.Reused != b.Reused || a.OldN != b.OldN || a.NewN != b.NewN ||
			a.Prefix != b.Prefix || a.Suffix != b.Suffix || a.Reused == 0 ||
			a.StreamEq == nil || !*a.StreamEq || a.TreeEq == nil || !*a.TreeEq {
			fmt.Println("fail cst-align mismatch")
			os.Exit(1)
		}
		fmt.Println("ok")
		return
	}
	if mode == "doc-slim-edit" {
		init := "1+2;\\n3+4;\\n5+6;"
		steps := []struct {
			text  string
			edits []Edit
		}{
			{init, nil},
			{"9+2;\\n3+4;\\n5+6;", []Edit{{0, 1, "9"}}},
			{"9+2;\\n3+4;\\n5+7;", []Edit{{12, 13, "7"}}},
		}
		doc := NewDocWith(init, &SlimBuilder{})
		doc.SetValidate(true)
		for i, step := range steps {
			if len(step.edits) > 0 {
				doc.Edit(step.edits)
			}
			if doc.Text() != step.text {
				fmt.Printf("fail text[%d] got=%q\\n", i, doc.Text())
				os.Exit(1)
			}
			if i > 0 {
				a := doc.Align()
				gatePrintAlign(a)
				if a == nil || a.Reused != 0 {
					fmt.Printf("fail reused[%d]\\n", i)
					os.Exit(1)
				}
				if a.StreamEq == nil || !*a.StreamEq {
					fmt.Println("fail streamEq")
					os.Exit(1)
				}
				if a.TreeEq != nil {
					fmt.Println("fail treeEq should be null")
					os.Exit(1)
				}
			}
			freshB := &SlimBuilder{}
			fh, fok := ParseWith(doc.Text(), freshB)
			dw := doc.(*DocWith)
			j1 := SlimJSONWith(dw.b.(*SlimBuilder), doc.Root())
			if !fok {
				fmt.Printf("fail fresh[%d]\\n", i)
				os.Exit(1)
			}
			j2 := SlimJSONWith(freshB, fh)
			if j1 != j2 {
				fmt.Printf("fail slim≠fresh[%d]\\n", i)
				os.Exit(1)
			}
		}
		fmt.Println("ok slim-edit")
		return
	}
	if mode == "doc-mirror-shift" {
		init := "1+2;\\n3+4;\\n5+6;"
		doc := NewDocWith(init, &MirrorBuilder{})
		doc.SetValidate(true)
		doc.Edit([]Edit{{Start: 0, End: 1, Text: "9"}})
		a := doc.Align()
		gatePrintAlign(a)
		if a == nil || a.Reused == 0 {
			fmt.Println("fail expected reuse>0")
			os.Exit(1)
		}
		if a.StreamEq == nil || !*a.StreamEq {
			fmt.Println("fail streamEq")
			os.Exit(1)
		}
		if a.TreeEq != nil {
			fmt.Println("fail treeEq should be null for MirrorBuilder")
			os.Exit(1)
		}
		mb := doc.(*DocWith).b.(*MirrorBuilder)
		fresh := &MirrorBuilder{}
		fh, fok := ParseWith(doc.Text(), fresh)
		if !fok {
			fmt.Println("fail fresh")
			os.Exit(1)
		}
		j1 := MirrorJSONWith(mb, lex(doc.Text()), doc.Root())
		j2 := MirrorJSONWith(fresh, lex(doc.Text()), fh)
		if j1 != j2 {
			fmt.Println("fail mirror≠fresh")
			os.Exit(1)
		}
		fmt.Printf("ok mirror-shift reused=%d\\n", a.Reused)
		return
	}
	raw, _ := io.ReadAll(os.Stdin)
	var inputs []string
	if err := json.Unmarshal(raw, &inputs); err != nil {
		fmt.Fprintf(os.Stderr, "json: %v\\n", err)
		os.Exit(1)
	}
	bad := 0
	useMirror := mode == "eq-mirror"
	for i, src := range inputs {
		e := &engine{}
		a := e.parse(src, lex(src))
		var rw int32
		var ok bool
		var jb string
		if useMirror {
			b := &MirrorBuilder{}
			rw, ok = ParseWith(src, b)
			if ok && a >= 0 {
				jb = MirrorJSONWith(b, lex(src), rw)
			}
		} else {
			b := &CstBuilder{}
			rw, ok = ParseWith(src, b)
			if ok && a >= 0 {
				jb = CstJSONWith(b, rw)
			}
		}
		if (a < 0) != !ok {
			bad++
			if bad <= 3 {
				fmt.Fprintf(os.Stderr, "accept[%d]: %q a=%d ok=%v\\n", i, src, a, ok)
			}
			continue
		}
		if a < 0 {
			continue
		}
		var ja strings.Builder
		e.writeJSON(a, &ja)
		if ja.String() != jb {
			bad++
			if bad <= 3 {
				fmt.Fprintf(os.Stderr, "mismatch[%d]: %q\\n", i, src)
			}
		}
	}
	if bad == 0 {
		fmt.Printf("ok %d\\n", len(inputs))
	} else {
		fmt.Printf("bad %d\\n", bad)
		os.Exit(1)
	}
}
`;

if (!haveGo()) {
  check('go toolchain present', false, 'go missing — go builder gates skipped');
} else {
  {
    const grammar: Grammar = (await import('./fixtures/calc.ts')).default;
    const emitted = emitParser(grammar, goTarget);
    check('go builder addon marker', emitted.includes('// ─── Builder API'));
    check('go exports ParseWith + CstBuilder + Builder',
      emitted.includes('func ParseWith') && emitted.includes('type CstBuilder') && emitted.includes('type Builder interface'));
    check('go exports NewDocWith + Shifter',
      emitted.includes('func NewDocWith') && emitted.includes('type Shifter interface') && emitted.includes('func (b *CstBuilder) Shift'));
    const prefix = emitted.slice(0, emitted.indexOf('// ─── Builder API'));
    check('go CST prefix nonempty', prefix.length > 1000,
      createHash('sha256').update(prefix).digest('hex').slice(0, 12));
  }

  const goBins = new Map<string, string>();
  for (const c of CASES) {
    const grammar: Grammar = (await import(c.path)).default;
    const gfile = `${GO_TMP}/${c.grammar}.go`;
    const hfile = `${GO_TMP}/${c.grammar}_harness.go`;
    const bin = `${GO_TMP}/${c.grammar}`;
    writeFileSync(gfile, asGoMain(emitParser(grammar, goTarget)));
    writeFileSync(hfile, goHarness);
    try {
      cachedGoBuild(['-o', bin, gfile, hfile], { cwd: GO_TMP, timeout: 180_000 });
    } catch (e) {
      check(`go build ${c.grammar}`, false, String(e).slice(0, 200));
      continue;
    }
    goBins.set(c.grammar, bin);
    const inputs = variants(c.seeds, 300);
    const out = execFileSync(bin, ['eq-batch'], {
      input: JSON.stringify(inputs), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
    }).trim();
    check(`go ${c.grammar} (${inputs.length} inputs)`, out.startsWith('ok '), out);
    const outM = execFileSync(bin, ['eq-mirror'], {
      input: JSON.stringify(inputs), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
    }).trim();
    check(`go ${c.grammar} eq-mirror (${inputs.length} inputs)`, outM.startsWith('ok '), outM);
  }
  const goBin = (grammar: string): string => {
    const bin = goBins.get(grammar);
    if (!bin) throw new Error(`go ${grammar} binary was not built`);
    return bin;
  };

  // SlimBuilder smoke on javascript
  {
    const bin = goBin('javascript');
    const slimOut = execFileSync(bin, ['slim-demo'], { encoding: 'utf8' }).trim().split('\n');
    check('go slim (1); → Number leaf (splice)', slimOut.some((l) => l.startsWith('LEAF\t(1);\tNumber\t')));
    check('go slim 1; → Number leaf (splice)', slimOut.some((l) => l.startsWith('LEAF\t1;\tNumber\t')));
  }

  // 2MB corpus equivalence
  {
    const corpus = CORPUS_2MB;
    check('go 2MB corpus present', Buffer.byteLength(corpus) >= 2_000_000, `${Buffer.byteLength(corpus)} bytes`);
    const bin = goBin('typescript');
    const out = execFileSync(bin, ['eq-batch'], {
      input: JSON.stringify([corpus]), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 600_000,
    }).trim();
    check('go 2MB corpus ParseWith ≡ parse', out === 'ok 1', out);
    const outM = execFileSync(bin, ['eq-mirror'], {
      input: JSON.stringify([corpus]), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 600_000,
    }).trim();
    check('go 2MB corpus eq-mirror ok', outM === 'ok 1', outM);
  }

  // NewDocWith + optional Shifter: CstBuilder / SlimBuilder / MirrorBuilder
  {
    console.log('builder-api: go NewDocWith edit contracts');
    const bin = goBin('calc');

    const cstOut = execFileSync(bin, ['doc-cst-edit'], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n');
    const cstAlign = cstOut.find((l) => l.startsWith('ALIGN\t'));
    check('go NewDocWith(CstBuilder) ≡ NewDoc', cstOut.includes('ok'), cstOut.slice(-3).join(' | '));
    check('go NewDocWith(CstBuilder) align streamEq+treeEq',
      !!cstAlign && cstAlign.includes('streamEq=true') && cstAlign.includes('treeEq=true'), cstAlign);
    check('go NewDocWith(CstBuilder) reused > 0',
      !!cstAlign && /reused=([1-9]\d*)/.test(cstAlign), cstAlign);

    const slimOut = execFileSync(bin, ['doc-slim-edit'], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n');
    check('go Slim NewDocWith multi-edit ≡ fresh', slimOut.includes('ok slim-edit'), slimOut.slice(-5).join(' | '));
    const slimAligns = slimOut.filter((l) => l.startsWith('ALIGN\t'));
    check('go Slim reused=0 each step',
      slimAligns.length >= 2 && slimAligns.every((l) => l.includes('reused=0')), slimAligns.join(' || '));
    check('go Slim streamEq, treeEq=null',
      slimAligns.every((l) => l.includes('streamEq=true') && l.includes('treeEq=null')), slimAligns.join(' || '));

    const mirOut = execFileSync(bin, ['doc-mirror-shift'], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n');
    check('go Mirror NewDocWith reuse+≡fresh', mirOut.some((l) => l.startsWith('ok mirror-shift')), mirOut.join(' | '));
    check('go Mirror reused>0 treeEq=null',
      mirOut.some((l) => l.startsWith('ALIGN\t') && /reused=([1-9]\d*)/.test(l) && l.includes('treeEq=null') && l.includes('streamEq=true')),
      mirOut.filter((l) => l.startsWith('ALIGN\t')).join(' || '));
  }
}

console.log(`builder-reuse: ${seqNames.length} sequences, targets ${[...results.keys()].join(' / ')}`);
console.log(`\n${ok} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
