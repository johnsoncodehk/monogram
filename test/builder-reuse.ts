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
// `Builder::workspace_mut`, Go's unexported CstBuilder fields).
// Missing go / rustc → logged + skipped.
//
//   node test/builder-reuse.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser, tsTarget, goTarget, rustTarget } from '../src/emit.ts';
import { goBuild, scratchDir } from './scratch.ts';

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
};

let ok = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};
const have = (cmd: string, arg: string) => { try { execFileSync(cmd, [arg], { stdio: 'pipe' }); return true; } catch { return false; } };

const grammar = (await import('../typescript.ts')).default;
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

func parseJSON(src string, b *parser.CstBuilder) (s string) {
	defer func() {
		if recover() != nil { s = "REJECT" }
	}()
	h, ok := parser.ParseWith(src, b)
	if !ok { return "REJECT" }
	return parser.CstJSONWith(b, h)
}

func main() {
	// Each argument is one sequence: file paths joined by ','.
	for _, seq := range os.Args[1:] {
		reused := &parser.CstBuilder{}
		for _, f := range strings.Split(seq, ",") {
			b, err := os.ReadFile(f)
			if err != nil { panic(err) }
			src := string(b)
			fmt.Printf("%s\\t%s\\n", parseJSON(src, reused), parseJSON(src, &parser.CstBuilder{}))
		}
	}
}
`);
  goBuild(['-o', 'consumer', '.'], { cwd: gdir });
  results.set('go', readPairs(execFileSync(join(gdir, 'consumer'), seqFiles.map((fs) => fs.join(',')), { encoding: 'utf8', maxBuffer: 1 << 28 })));
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
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    // Each argument is one sequence: file paths joined by ','.
    for seq in std::env::args().skip(1) {
        let mut reused = CstBuilder::default();
        for f in seq.split(',') {
            let src = std::fs::read_to_string(f).unwrap();
            let r = parse_json(&src, &mut reused);
            let fresh = parse_json(&src, &mut CstBuilder::default());
            println!("{}\\t{}", r, fresh);
        }
    }
}
`);
  execFileSync('rustc', ['-A', 'warnings', rfile, '-o', join(dir, 'reuse')], { stdio: 'pipe' });
  results.set('rust', readPairs(execFileSync(join(dir, 'reuse'), seqFiles.map((fs) => fs.join(',')), { encoding: 'utf8', maxBuffer: 1 << 28 })));
}

for (const [label, rows] of results) {
  let r = 0;
  for (const n of seqNames) {
    SEQUENCES[n]!.forEach((src, i) => {
      const [reused, fresh] = rows[r++]!;
      check(`${label}: ${n} — input ${i + 1} (${src.length} B) with the reused builder ≡ a fresh builder`, reused === fresh,
        `reused ${reused!.slice(0, 80)}… vs fresh ${fresh!.slice(0, 80)}…`);
    });
  }
  // The sequences are meaningful only if both verdicts occur.
  check(`${label}: the sequences include an accepted and a rejected input`, rows.some(([, f]) => f === 'REJECT') && rows.some(([, f]) => f !== 'REJECT'));
}
console.log(`builder-reuse: ${seqNames.length} sequences, targets ${[...results.keys()].join(' / ')}`);
console.log(`\n${ok} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
