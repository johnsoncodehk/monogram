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
//   • with a reused builder, the second and later parses of an input allocate nothing: the token
//     stream, the arena and the workspace (scratch stack, top-level entry list, lexer stacks) all
//     keep their capacity. Also after a rejected parse, and after one the lexer stops by a panic
//     (input ending inside a template / an unclosed bracket), the next parse of the ordinary input
//     the builder parsed before allocates nothing — except, in Rust after a lexer panic, the
//     lexer's two stacks (expected-fail, below).
// Counts, not timings: Rust through a counting global allocator around `lex`, Go through
// `cap` / `len` of the slice `lex` returns and the runtime's allocation profile (below). TS
// arrays expose no capacity; the engine grows them.
// Missing go / rustc → logged + skipped.
//
//   node test/lexer-reservation.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser } from '../src/target.ts';
import { goTarget } from '../src/target-go.ts';
import { rustTarget } from '../src/target-rust.ts';
import { scratchDir } from './scratch.ts';

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

// Inputs a parse fails on, each parsed with a builder that has parsed ORDINARY twice, before ORDINARY
// is parsed with it again: that parse must allocate nothing either.
const ORDINARY = CORPORA['ordinary code (src/gen-tm.ts)']!;
const FAILING: Record<string, string> = {
  'rejected by the parser': 'let = ;',
  'rejected with the lexer stacks non-empty (inside `${`, an open bracket)': 'x = `a${ f((',
  'the lexer panics inside a template': 'f(1, `a${ g(`b',
  'the lexer panics on a character it cannot lex': 'f((1, \u0001',
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
const failNames = Object.keys(FAILING);
const ordFile = join(dir, 'ordinary.ts');
writeFileSync(ordFile, ORDINARY);
const failFiles = failNames.map((n, i) => { const f = join(dir, `fail${i}.ts`); writeFileSync(f, FAILING[n]!); return f; });
// One line per failing input: `<allocations>\t<bytes>` of the parse of ORDINARY after it, then 1 if
// the failing parse panicked (a lexer error), 0 if it returned a reject.
const afterFail = new Map<string, number[][]>();
const readAfter = (out: string) => out.trim().split('\n').map((l) => l.split('\t').map(Number));

// One line per input: `<tokens>\t<capacity>\t<peak bytes or -1>\t<size_of(Tok)>`.
// `reAllocs` / `reBytes`: allocations (and bytes) of the second and third parse of the input with the
// builder the first parse used.
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
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args[0] == "--after" {
        // args[1] is the ordinary input, the rest are inputs a parse fails on.
        std::panic::set_hook(Box::new(|_| {}));
        let good = std::fs::read_to_string(&args[1]).unwrap();
        for f in &args[2..] {
            let bad = std::fs::read_to_string(f).unwrap();
            let mut b = CstBuilder::default();
            parse_with(&good, &mut b);
            parse_with(&good, &mut b);
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| parse_with(&bad, &mut b)));
            assert!(!matches!(r, Ok(Some(_))), "{} was accepted", f);
            let panicked = r.is_err() as u8;
            let (a0, b0) = (LR_ALLOCS.load(Relaxed), LR_BYTES.load(Relaxed));
            parse_with(&good, &mut b);
            let (a1, b1) = (LR_ALLOCS.load(Relaxed), LR_BYTES.load(Relaxed));
            println!("{}\\t{}\\t{}", a1 - a0, b1 - b0, panicked);
        }
        return;
    }
    for f in args {
        let src = std::fs::read_to_string(&f).unwrap();
        let base = LR_LIVE.load(Relaxed);
        LR_PEAK.store(base, Relaxed);
        let t = lex(&src);
        let peak = LR_PEAK.load(Relaxed) - base;
        // The second and third parse of the same input with the builder the first one used.
        let mut b = CstBuilder::default();
        parse_with(&src, &mut b);
        let (a0, b0) = (LR_ALLOCS.load(Relaxed), LR_BYTES.load(Relaxed));
        parse_with(&src, &mut b);
        parse_with(&src, &mut b);
        let (a1, b1) = (LR_ALLOCS.load(Relaxed), LR_BYTES.load(Relaxed));
        println!("{}\\t{}\\t{}\\t{}\\t{}\\t{}", t.len(), t.capacity(), peak, std::mem::size_of::<Tok>(), a1 - a0, b1 - b0);
    }
}
`);
  cachedRustc(['-A', 'warnings', rfile, '-o', join(dir, 'reserve')], { stdio: 'pipe' });
  counts.set('rust', readCounts(execFileSync(join(dir, 'reserve'), files, { encoding: 'utf8' })));
  afterFail.set('rust', readAfter(execFileSync(join(dir, 'reserve'), ['--after', ordFile, ...failFiles], { encoding: 'utf8' })));
}

// ── Go ──
if (!have('go', 'version')) console.log('  go: (toolchain not found — skipped)');
else {
  const gdir = join(dir, 'go');
  mkdirSync(join(gdir, 'parser'), { recursive: true });
  writeFileSync(join(gdir, 'go.mod'), 'module consumer\n\ngo 1.21\n');
  writeFileSync(join(gdir, 'parser', 'parser.go'), emitParser(grammar, goTarget));
  writeFileSync(join(gdir, 'parser', 'reserve.go'), `package parser

import "unsafe"

// LexShape lexes src and reports the token slice's length, capacity and element size.
func LexShape(src string) (int, int, int) {
	t := lex(src)
	return len(t), cap(t), int(unsafe.Sizeof(Tok{}))
}
`);
  // A parse's allocations are read from the runtime's allocation profile at rate 1 (every
  // allocation recorded with its call stack): the records whose stack runs through package parser.
  // A process-wide counter (runtime.MemStats.Mallocs, even with the GC off) also counts what the
  // runtime allocates for itself on other stacks, on its own schedule, while the parse runs. Seen
  // on this measurement: allocm creating an M for a goroutine the runtime woke (6 allocations,
  // 5320 B, in 1 window of 400), and the background scavenger re-arming its sleep timer, which
  // grows a P's timer heap (runtime.bgscavenge → timer.reset → timers.addHeap: 1 allocation,
  // 16 B: CI's "1 allocation, 16 B" for a different input in each failing run). A stack belongs to the parse or it does not, so this count does not depend on scheduling.
  // The measurement lives outside package parser so that its own allocations are not the parse's.
  writeFileSync(join(gdir, 'main.go'), `package main

import (
import { cachedGoBuild, cachedRustc } from './build-cache.ts';
	"fmt"
	"os"
	"runtime"
	"strings"

	"consumer/parser"
)

func init() { runtime.MemProfileRate = 1 }

// parserAllocs: allocations and bytes so far whose stack has a frame of package parser, or is
// truncated (deeper than a record holds: its parser frames may be the ones cut off). Three GC
// cycles first: a record is published once the cycle after its allocation has ended.
func parserAllocs() (n, bytes int64) {
	for i := 0; i < 3; i++ {
		runtime.GC()
	}
	var recs []runtime.MemProfileRecord
	for k, _ := runtime.MemProfile(nil, true); ; {
		recs = make([]runtime.MemProfileRecord, k+64)
		var ok bool
		if k, ok = runtime.MemProfile(recs, true); ok {
			recs = recs[:k]
			break
		}
	}
	for _, r := range recs {
		st := r.Stack()
		in := len(st) == len(r.Stack0)
		for fr := runtime.CallersFrames(st); !in; {
			f, more := fr.Next()
			in = strings.HasPrefix(f.Function, "consumer/parser.")
			if !more {
				break
			}
		}
		if in {
			n += r.AllocObjects
			bytes += r.AllocBytes
		}
	}
	return
}

func measure(f func()) (int64, int64) {
	n0, b0 := parserAllocs()
	f()
	n1, b1 := parserAllocs()
	return n1 - n0, b1 - b0
}

func failParse(src string, b *parser.CstBuilder) (ok, panicked bool) {
	defer func() {
		if recover() != nil {
			ok, panicked = false, true
		}
	}()
	_, ok = parser.ParseWith(src, b)
	return ok, false
}

func read(f string) string {
	b, err := os.ReadFile(f)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func main() {
	if os.Args[1] == "--version" {
		fmt.Println(runtime.Version())
		return
	}
	if os.Args[1] == "--after" {
		// Parse good twice with one builder, then bad (which must fail, by a reject or a lexer
		// panic), and report the allocations and bytes of a further parse of good with that builder.
		good := read(os.Args[2])
		for _, f := range os.Args[3:] {
			b := &parser.CstBuilder{}
			parser.ParseWith(good, b)
			parser.ParseWith(good, b)
			ok, panicked := failParse(read(f), b)
			if ok {
				panic("accepted: " + f)
			}
			p := 0
			if panicked {
				p = 1
			}
			ra, rb := measure(func() { parser.ParseWith(good, b) })
			fmt.Printf("%d\\t%d\\t%d\\n", ra, rb, p)
		}
		return
	}
	// Per input: the token slice's shape, then the allocations and bytes of a second and third
	// ParseWith of it with the builder the first one used.
	for _, f := range os.Args[1:] {
		src := read(f)
		n, c, sz := parser.LexShape(src)
		b := &parser.CstBuilder{}
		parser.ParseWith(src, b)
		ra, rb := measure(func() {
			parser.ParseWith(src, b)
			parser.ParseWith(src, b)
		})
		fmt.Printf("%d\\t%d\\t-1\\t%d\\t%d\\t%d\\n", n, c, sz, ra, rb)
	}
}
`);
  cachedGoBuild(['-o', 'consumer', '.'], { cwd: gdir });
  console.log(`  go: ${execFileSync(join(gdir, 'consumer'), ['--version'], { encoding: 'utf8' }).trim()}`);
  counts.set('go', readCounts(execFileSync(join(gdir, 'consumer'), files, { encoding: 'utf8' })));
  afterFail.set('go', readAfter(execFileSync(join(gdir, 'consumer'), ['--after', ordFile, ...failFiles], { encoding: 'utf8' })));
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
// With a reused builder, the second and later parses allocate nothing.
for (const [label, cs] of counts) names.forEach((n, i) => {
  const c = cs[i]!;
  check(`${label}: ${n} — second and third parse with a reused builder allocate nothing`, c.reAllocs === 0, `${c.reAllocs} allocations, ${c.reBytes} B`);
});
// … also right after a parse that failed, by a reject or by a lexer error (which the parse entry
// raises: the lexer returns it, so its stacks stay with the builder).
for (const [label, rows] of afterFail) failNames.forEach((n, i) => {
  const [allocs, bytes, panicked] = rows[i]!;
  check(`${label}: ${n} — the parse ${n.includes('panics') ? 'panics' : 'returns a reject'}`, (panicked === 1) === n.includes('panics'));
  check(`${label}: after a failed parse (${n}), a parse of ordinary code with the same builder allocates nothing`, allocs === 0, `${allocs} allocations, ${bytes} B`);
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
console.log(`\n${ok} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
