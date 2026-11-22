// Gate: the memory a portable lexer reserves for its token array is bounded by the tokens it writes.
//
// The token count is known only once the scan ends, so the array grows as tokens are pushed.
// Reserving a guess sized from the input instead (one token per two bytes, say) is no bound:
// one-byte tokens with no trivia (`;;;`, `a+a+a`) give one token per byte, so the array must be
// able to grow anyway, and on ordinary code (about 0.1 tokens per byte) most of the guess is
// never written. A growing array holds at most twice what it holds at the end, and while it grows
// the old buffer and the new one are both alive for one copy. So, per input below:
//   • the token array's final capacity is at most CAP_PER_TOKEN × max(tokens, MIN_TOKENS) slots;
//   • the lexer's peak live heap, counting a growth as old + new buffers alive together, is at most
//     PEAK_PER_TOKEN × max(tokens, MIN_TOKENS) × size_of(Tok) + STACK_BYTES (the bracket and
//     template stacks the lexer keeps beside the array, bounded by nesting depth);
//   • tokens per input byte is at most 1 (every token consumes at least one byte);
//   • a second parse with the builder of the first allocates nothing (expected-fail for now, below).
// Counts, not timings: Rust through a counting global allocator around `lex`, Go through
// `cap` / `len` of the slice `lex` returns. TS arrays expose no capacity; the engine grows them.
// Missing go / rustc → logged + skipped.
//
//   node test/lexer-reservation.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser, goTarget, rustTarget } from '../src/emit.ts';
import { goBuild, scratchDir } from './scratch.ts';

const CAP_PER_TOKEN = 2, PEAK_PER_TOKEN = 3, MIN_TOKENS = 4, STACK_BYTES = 4096;
const DENSE = 1 << 16;

const CORPORA: Record<string, string> = {
  'ordinary code (typescript.ts)': readFileSync(new URL('../typescript.ts', import.meta.url), 'utf8'),
  'ordinary code (src/gen-tm.ts)': readFileSync(new URL('../src/gen-tm.ts', import.meta.url), 'utf8'),
  'dense one-byte tokens `;;;`': ';'.repeat(DENSE),
  'dense one-byte tokens `a+a+a`': 'a' + '+a'.repeat(DENSE / 2),
  'dense one-byte tokens `a;a;`': 'a;'.repeat(DENSE / 2),
  'one token': 'x',
};

let ok = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};
const have = (cmd: string, arg: string) => { try { execFileSync(cmd, [arg], { stdio: 'pipe' }); return true; } catch { return false; } };

const grammar = (await import('../typescript.ts')).default;
const dir = scratchDir('lexer-reservation');
const names = Object.keys(CORPORA);
const files = names.map((n, i) => { const f = join(dir, `in${i}.ts`); writeFileSync(f, CORPORA[n]!); return f; });
const bytesOf = (i: number) => Buffer.byteLength(CORPORA[names[i]!]!, 'utf8');

// One line per input: `<tokens>\t<capacity>\t<peak bytes or -1>\t<size_of(Tok)>`.
// `reAllocs` / `reBytes`: allocations (and bytes) of a second parse of the input with the builder
// the first parse used.
type Count = { toks: number; cap: number; peak: number; tokSize: number; reAllocs: number; reBytes: number };
const readCounts = (out: string): Count[] => out.trim().split('\n').map((l) => {
  const [toks, cap, peak, tokSize, reAllocs, reBytes] = l.split('\t').map(Number);
  return { toks: toks!, cap: cap!, peak: peak!, tokSize: tokSize!, reAllocs: reAllocs!, reBytes: reBytes! };
});
const counts = new Map<string, Count[]>();

// ── Rust ──
if (!have('rustc', '--version')) console.log('  rust: (toolchain not found — skipped)');
else {
  const rfile = join(dir, 'reserve.rs');
  writeFileSync(rfile, emitParser(grammar, rustTarget) + `
// Heap traffic of \`lex\` alone. A realloc is counted as the new buffer allocated while the old one
// is still alive (the copying case), so a growth's peak is old + new.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicI64, Ordering::Relaxed};
struct LrAlloc;
static LR_LIVE: AtomicI64 = AtomicI64::new(0);
static LR_PEAK: AtomicI64 = AtomicI64::new(0);
static LR_ALLOCS: AtomicI64 = AtomicI64::new(0); // alloc + growing realloc calls
static LR_BYTES: AtomicI64 = AtomicI64::new(0); // bytes they requested
fn lr_live(d: i64) { let v = LR_LIVE.fetch_add(d, Relaxed) + d; LR_PEAK.fetch_max(v, Relaxed); }
unsafe impl GlobalAlloc for LrAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { LR_ALLOCS.fetch_add(1, Relaxed); LR_BYTES.fetch_add(l.size() as i64, Relaxed); lr_live(l.size() as i64); System.alloc(l) }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 { lr_live(l.size() as i64); System.alloc_zeroed(l) }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { lr_live(-(l.size() as i64)); System.dealloc(p, l) }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        if n > l.size() { LR_ALLOCS.fetch_add(1, Relaxed); LR_BYTES.fetch_add(n as i64, Relaxed); }
        lr_live(n as i64); lr_live(-(l.size() as i64));
        System.realloc(p, l, n)
    }
}
#[global_allocator]
static LR_GLOBAL: LrAlloc = LrAlloc;
fn main() {
    for f in std::env::args().skip(1) {
        let src = std::fs::read_to_string(&f).unwrap();
        let base = LR_LIVE.load(Relaxed);
        LR_PEAK.store(base, Relaxed);
        let t = lex(&src);
        let peak = LR_PEAK.load(Relaxed) - base;
        // A second parse of the same input with the builder the first one used.
        let mut b = CstBuilder::default();
        parse_with(&src, &mut b);
        let (a0, b0) = (LR_ALLOCS.load(Relaxed), LR_BYTES.load(Relaxed));
        parse_with(&src, &mut b);
        let (a1, b1) = (LR_ALLOCS.load(Relaxed), LR_BYTES.load(Relaxed));
        println!("{}\\t{}\\t{}\\t{}\\t{}\\t{}", t.len(), t.capacity(), peak, std::mem::size_of::<Tok>(), a1 - a0, b1 - b0);
    }
}
`);
  execFileSync('rustc', ['-A', 'warnings', rfile, '-o', join(dir, 'reserve')], { stdio: 'pipe' });
  counts.set('rust', readCounts(execFileSync(join(dir, 'reserve'), files, { encoding: 'utf8' })));
}

// ── Go ──
if (!have('go', 'version')) console.log('  go: (toolchain not found — skipped)');
else {
  const gdir = join(dir, 'go');
  mkdirSync(join(gdir, 'parser'), { recursive: true });
  writeFileSync(join(gdir, 'go.mod'), 'module consumer\n\ngo 1.21\n');
  writeFileSync(join(gdir, 'parser', 'parser.go'), emitParser(grammar, goTarget));
  writeFileSync(join(gdir, 'parser', 'reserve.go'), `package parser

import (
	"runtime"
	"unsafe"
)

// LexCounts lexes src and reports the token slice's length, capacity and element size, then the
// allocations and bytes of a second ParseWith of src with the builder the first one used.
func LexCounts(src string) (int, int, int, uint64, uint64) {
	t := lex(src)
	b := &CstBuilder{}
	ParseWith(src, b)
	var m0, m1 runtime.MemStats
	runtime.ReadMemStats(&m0)
	ParseWith(src, b)
	runtime.ReadMemStats(&m1)
	return len(t), cap(t), int(unsafe.Sizeof(Tok{})), m1.Mallocs - m0.Mallocs, m1.TotalAlloc - m0.TotalAlloc
}
`);
  writeFileSync(join(gdir, 'main.go'), `package main

import (
	"fmt"
	"os"

	"consumer/parser"
)

func main() {
	for _, f := range os.Args[1:] {
		b, err := os.ReadFile(f)
		if err != nil {
			panic(err)
		}
		n, c, sz, ra, rb := parser.LexCounts(string(b))
		fmt.Printf("%d\\t%d\\t-1\\t%d\\t%d\\t%d\\n", n, c, sz, ra, rb)
	}
}
`);
  goBuild(['-o', 'consumer', '.'], { cwd: gdir });
  counts.set('go', readCounts(execFileSync(join(gdir, 'consumer'), files, { encoding: 'utf8' })));
}

for (const [label, cs] of counts) {
  names.forEach((n, i) => {
    const c = cs[i]!, bytes = bytesOf(i), base = Math.max(c.toks, MIN_TOKENS);
    check(`${label}: ${n} — at most one token per input byte`, c.toks <= bytes, `${c.toks} tokens for ${bytes} bytes`);
    check(`${label}: ${n} — token array capacity ≤ ${CAP_PER_TOKEN} × tokens`, c.cap <= CAP_PER_TOKEN * base,
      `capacity ${c.cap} slots for ${c.toks} tokens (${(c.cap / base).toFixed(2)} ×)`);
    if (c.peak >= 0) {
      check(`${label}: ${n} — lexer peak heap ≤ ${PEAK_PER_TOKEN} × tokens × ${c.tokSize} B + ${STACK_BYTES} B`, c.peak <= PEAK_PER_TOKEN * base * c.tokSize + STACK_BYTES,
        `peak ${c.peak} B for ${c.toks} tokens (${(c.peak / base).toFixed(1)} B per token, ${(c.peak / bytes).toFixed(2)} B per input byte)`);
    }
  });
}
// A second parse with the builder of the first allocates nothing. EXPECTED-FAIL: the token stream and
// the arena travel in the builder and are reused, but the parser's scratch stack, its top-level
// entry list and the lexer's bracket / template stacks are still per-parse buffers (on `;;;` the
// scratch and entry lists are input-sized). Carrying them in the builder needs a Builder trait
// addition in Rust, which awaits the maintainer's decision. The check flips to a hard failure if
// it starts passing, so the mark is removed when it does.
let expectedFail = 0;
for (const [label, cs] of counts) names.forEach((n, i) => {
  const c = cs[i]!;
  const label2 = `${label}: ${n} — second parse with a reused builder allocates nothing`;
  if (c.reAllocs === 0) check(`${label2} (passes: remove its EXPECTED-FAIL mark)`, false);
  else { expectedFail++; console.log(`  EXPECTED-FAIL ${label2}: ${c.reAllocs} allocations, ${c.reBytes} B`); }
});
const [ref, ...others] = [...counts];
if (ref) for (const [label, cs] of others) {
  const diff = names.filter((_, i) => cs[i]!.toks !== ref[1][i]!.toks);
  check(`${label}: token counts ≡ ${ref[0]}`, diff.length === 0, diff.join('; '));
}
for (const [i, n] of names.entries()) {
  console.log(`  ${n}: ${bytesOf(i)} B, ${[...counts][0]?.[1][i]!.toks ?? '?'} tokens; ${[...counts].map(([label, cs]) => {
    const c = cs[i]!;
    return `${label} capacity ${(c.cap / Math.max(c.toks, 1)).toFixed(2)} × tokens${c.peak >= 0 ? `, peak ${(c.peak / Math.max(c.toks, 1)).toFixed(1)} B per token / ${(c.peak / bytesOf(i)).toFixed(2)} B per input byte` : ''}`;
  }).join('; ')}`);
}
console.log(`lexer-reservation: ${names.length} inputs, targets ${[...counts.keys()].join(' / ') || 'none'}`);
console.log(`\n${ok} ok, ${fail} failed, ${expectedFail} expected-fail`);
process.exit(fail === 0 ? 0 : 1);
