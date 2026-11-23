// Gate: the WORK a portable lexer does per input byte does not grow with input size.
//
// A lexer reads each byte a bounded number of times. Decoding a character is where a target can
// silently read more: a UTF-8 routine handed the whole rest of the input (validating it, copying
// it, or searching it) at every non-ASCII character makes lexing quadratic in the input, while
// the tokens stay the same, so parity cannot see it and a wall-clock check on a shared runner
// cannot hold a bound. A work count can: it is deterministic.
//
// The count is the number of input units each target's string routines may examine while
// `tokenize` runs. Every such routine the emitted source calls is replaced by a counting twin
// that charges what the routine reads by its definition and then calls it:
//   • Rust: `std::str::from_utf8(x)` validates all of x (x.len()); `.chars()` decodes the chars
//     it yields (their UTF-8 widths).
//   • Go: `utf8.DecodeRuneInString(x)` reads at most one encoding (min(len(x), utf8.UTFMax));
//     `strings.ContainsAny(x, …)` and `strings.Contains(x, …)` search all of x (len(x));
//     `strings.Index(x, lit)` / `strings.IndexByte(x, c)` read up to the match's end, or all of x;
//     `strings.HasPrefix(x, lit)` compares lit alone and is not counted.
//   • TS: `RegExp.prototype.exec` (behind `test`, `match`, `search`, … too) reads, for a sticky
//     regex, the match and one unit after it, and otherwise the whole string from lastIndex; the
//     String routines that scan or copy (`slice`, `indexOf`, `startsWith`, …, table below) read
//     what they copy, compare or search.
// In Rust and Go a string routine outside this list fails the gate: it must be counted before the
// lexer may call it (in TS the twins replace the prototype methods, so no call escapes them).
// Per corpus below, the input is one unit repeated SMALL and LARGE times:
//   • units examined per input unit at LARGE is at most GROWTH × the same at SMALL (0 stays 0);
//   • every target reports the same token count.
// Missing go / rustc → logged + skipped.
//
//   node test/lexer-work.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser } from '../src/target.ts';
import { tsTarget } from '../src/target-ts.ts';
import { goTarget } from '../src/target-go.ts';
import { rustTarget } from '../src/target-rust.ts';
import { goBuild, scratchDir } from './scratch.ts';

const SMALL = 64, LARGE = 8 * SMALL, GROWTH = 2;

// One statement (or a few) per corpus; the ASCII one is the control.
const CORPORA: Record<string, string> = {
  'ASCII code': 'const value = call("text", 1) + other; // note\n',
  'non-ASCII identifiers': 'const 変数名 = 関数(引数, ŉame);\n',
  'ASCII identifiers continued by non-ASCII': 'const café = naïve + résumé;\n',
  'non-ASCII whitespace': 'a\u3000=\u00a0b\u2003+\ufeffc;\n',
  'non-ASCII in strings': 's = "日本語の文字列" + \'émoji 😀\';\n',
  'non-ASCII in templates': 't = `日本${x}語 😀`;\n',
  'non-ASCII in comments': '// 日本語のコメント\n/* 注釈 😀 */ x;\n',
  'non-ASCII in regex literals': 'r = /日本語/u.test(s);\n',
};

let ok = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};
const have = (cmd: string, arg: string) => { try { execFileSync(cmd, [arg], { stdio: 'pipe' }); return true; } catch { return false; } };

const grammar = (await import('../typescript.ts')).default;
const dir = scratchDir('lexer-work');
const names = Object.keys(CORPORA);
// Two inputs per corpus, in `names` order: SMALL repetitions, then LARGE.
const inputs = names.flatMap((n) => [CORPORA[n]!.repeat(SMALL), CORPORA[n]!.repeat(LARGE)]);
const files = inputs.map((src, i) => { const f = join(dir, `in${i}.ts`); writeFileSync(f, src); return f; });

// `units`: the input's length in the target's string units; `work`: units examined.
type Count = { toks: number; units: number; work: number };
const counts = new Map<string, Count[]>();
// A consumer binary prints one line per input file: `<tokens>\t<units>\t<work>`.
const readCounts = (out: string): Count[] => out.trim().split('\n').map((l) => {
  const [toks, units, work] = l.split('\t').map(Number);
  return { toks: toks!, units: units!, work: work! };
});

// ── TS ──
{
  const file = join(dir, 'parser.ts');
  writeFileSync(file, emitParser(grammar, tsTarget));
  const m = await import(file);
  const S = String.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  // What each String routine may read, given its receiver, arguments and result.
  const reads: Record<string, (s: string, a: unknown[], r: unknown) => number> = {
    slice: (_s, _a, r) => (r as string).length,
    substring: (_s, _a, r) => (r as string).length,
    substr: (_s, _a, r) => (r as string).length,
    startsWith: (_s, a) => String(a[0]).length,
    endsWith: (_s, a) => String(a[0]).length,
    // To the end of the match, or to the end of s when there is none.
    indexOf: (s, a, r) => ((r as number) < 0 ? s.length : (r as number) + String(a[0]).length) - Math.max(0, Number(a[1] ?? 0)),
    lastIndexOf: (s) => s.length,
    includes: (s, a) => s.length - Number(a[1] ?? 0),
    split: (s) => s.length,
    normalize: (s) => s.length,
    toLowerCase: (s) => s.length,
    toUpperCase: (s) => s.length,
  };
  const exec = RegExp.prototype.exec;
  const saved = Object.fromEntries(Object.keys(reads).map((k) => [k, S[k]!]));
  counts.set('ts', inputs.map((input): Count => {
    let work = 0;
    // `test`, `match`, `search`, `replace` and `split` with a regex all run through exec.
    RegExp.prototype.exec = function (this: RegExp, s: string) {
      const from = this.sticky || this.global ? this.lastIndex : 0;
      const r = exec.call(this, s);
      work += this.sticky ? Math.min((r ? r[0].length : 0) + 1, s.length - from) : s.length - from;
      return r;
    };
    for (const [k, f] of Object.entries(reads)) {
      const orig = saved[k]!;
      S[k] = function (this: string, ...a: unknown[]) { const r = orig.apply(this, a); work += f(String(this), a, r); return r; };
    }
    try { return { toks: m.tokenize(input).length, units: input.length, work }; }
    finally { RegExp.prototype.exec = exec; Object.assign(S, saved); }
  }));
}

// ── Go ──
if (!have('go', 'version')) console.log('  go: (toolchain not found — skipped)');
else {
  const gdir = join(dir, 'go');
  mkdirSync(join(gdir, 'parser'), { recursive: true });
  writeFileSync(join(gdir, 'go.mod'), 'module consumer\n\ngo 1.21\n');
  let src = emitParser(grammar, goTarget);
  src = src.replaceAll('utf8.DecodeRuneInString(', 'lwDecodeRuneInString(').replaceAll('strings.ContainsAny(', 'lwContainsAny(')
    .replaceAll('strings.Contains(', 'lwContains(').replaceAll('strings.IndexByte(', 'lwIndexByte(').replaceAll('strings.Index(', 'lwIndex(');
  for (const m of src.matchAll(/\butf8\.(\w+)|\[\]rune\(|\bstrings\.(?!HasPrefix\(|Builder\b)(\w+)/g)) {
    check(`go: string routine ${m[0]} is counted`, false, 'add a counting twin for it');
  }
  writeFileSync(join(gdir, 'parser', 'parser.go'), src + '\nvar _ = utf8.RuneError\n');
  writeFileSync(join(gdir, 'parser', 'work.go'), `package parser

import (
	"strings"
	"unicode/utf8"
)

// Units examined by the string routines since the last reset.
var LwWork int

func lwDecodeRuneInString(s string) (rune, int) {
	LwWork += min(len(s), utf8.UTFMax)
	return utf8.DecodeRuneInString(s)
}

func lwContainsAny(s, chars string) bool {
	LwWork += len(s)
	return strings.ContainsAny(s, chars)
}

func lwContains(s, sub string) bool {
	LwWork += len(s)
	return strings.Contains(s, sub)
}

func lwIndex(s, lit string) int {
	k := strings.Index(s, lit)
	if k < 0 {
		LwWork += len(s)
	} else {
		LwWork += k + len(lit)
	}
	return k
}

func lwIndexByte(s string, c byte) int {
	k := strings.IndexByte(s, c)
	if k < 0 {
		LwWork += len(s)
	} else {
		LwWork += k + 1
	}
	return k
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
		src := string(b)
		parser.LwWork = 0
		toks, err := parser.Tokenize(src)
		if err != nil {
			panic(err)
		}
		fmt.Printf("%d\\t%d\\t%d\\n", len(toks), len(src), parser.LwWork)
	}
}
`);
  goBuild(['-o', 'consumer', '.'], { cwd: gdir });
  counts.set('go', readCounts(execFileSync(join(gdir, 'consumer'), files, { encoding: 'utf8' })));
}

// ── Rust ──
if (!have('rustc', '--version')) console.log('  rust: (toolchain not found — skipped)');
else {
  const rfile = join(dir, 'work.rs');
  let src = emitParser(grammar, rustTarget);
  src = src.replaceAll('std::str::from_utf8(', '_lw_from_utf8(').replaceAll('.chars()', '._lw_chars()');
  for (const m of src.matchAll(/\bfrom_utf8\w*|\.char_indices\(|\.utf8_chunks\(|\.char_count\(/g)) {
    check(`rust: string routine ${m[0]} is counted`, false, 'add a counting twin for it');
  }
  writeFileSync(rfile, src + `
// Units examined by the string routines since the last reset.
static LW_WORK: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
fn _lw_add(n: usize) { LW_WORK.fetch_add(n, std::sync::atomic::Ordering::Relaxed); }
fn _lw_from_utf8(v: &[u8]) -> Result<&str, std::str::Utf8Error> { _lw_add(v.len()); std::str::from_utf8(v) }
struct LwChars<'a>(std::str::Chars<'a>);
impl Iterator for LwChars<'_> {
    type Item = char;
    fn next(&mut self) -> Option<char> { let c = self.0.next()?; _lw_add(c.len_utf8()); Some(c) }
}
trait LwStr { fn _lw_chars(&self) -> LwChars<'_>; }
impl LwStr for str { fn _lw_chars(&self) -> LwChars<'_> { LwChars(self.chars()) } }
fn main() {
    for f in std::env::args().skip(1) {
        let src = std::fs::read_to_string(&f).unwrap();
        LW_WORK.store(0, std::sync::atomic::Ordering::Relaxed);
        let n = tokenize(&src).unwrap().len();
        println!("{}\\t{}\\t{}", n, src.len(), LW_WORK.load(std::sync::atomic::Ordering::Relaxed));
    }
}
`);
  execFileSync('rustc', ['-A', 'warnings', rfile, '-o', join(dir, 'work')], { stdio: 'pipe' });
  counts.set('rust', readCounts(execFileSync(join(dir, 'work'), files, { encoding: 'utf8' })));
}

const [ref, ...others] = [...counts];
const [refLabel, refCounts] = ref!;
for (const [label, cs] of others) {
  const diff = names.flatMap((n, k) => [SMALL, LARGE].flatMap((r, j) => {
    const a = refCounts[2 * k + j]!.toks, b = cs[2 * k + j]!.toks;
    return a === b ? [] : [`${n} ×${r}: ${refLabel} ${a} vs ${label} ${b} tokens`];
  }));
  check(`${label}: token counts ≡ ${refLabel}`, diff.length === 0, diff.slice(0, 3).join('; '));
}
const growthOf = (small: Count, large: Count): number =>
  small.work === 0 ? (large.work === 0 ? 1 : Infinity) : (large.work / large.units) / (small.work / small.units);
for (const [label, cs] of counts) {
  names.forEach((n, k) => {
    const small = cs[2 * k]!, large = cs[2 * k + 1]!;
    const growth = growthOf(small, large);
    check(`${label}: ${n} — work per input unit does not grow with input size`, growth <= GROWTH,
      `units examined per input unit ${(small.work / small.units).toFixed(2)} at ×${SMALL}, ${(large.work / large.units).toFixed(2)} at ×${LARGE} (×${growth.toFixed(2)})`);
  });
}
// The twins are live: decoding a non-ASCII identifier reads something in every target.
for (const [label, cs] of counts) {
  const k = names.indexOf('non-ASCII identifiers');
  check(`${label}: the count sees the character decodes`, cs[2 * k]!.work > 0);
}
for (const [k, n] of names.entries()) {
  console.log(`  ${n}: ${[...counts].map(([label, cs]) => `${label} ${(cs[2 * k]!.work / cs[2 * k]!.units).toFixed(2)} → ${(cs[2 * k + 1]!.work / cs[2 * k + 1]!.units).toFixed(2)}`).join(', ')} units examined per input unit`);
}
const summary = [...counts].map(([label, cs]) => {
  const worst = names.map((n, k) => ({ n, g: growthOf(cs[2 * k]!, cs[2 * k + 1]!) })).sort((a, b) => b.g - a.g)[0]!;
  return `${label} ×${worst.g.toFixed(2)} (${worst.n})`;
});
console.log(`lexer-work: ${names.length} corpora × ${SMALL} and ${LARGE} repetitions, targets ${[...counts.keys()].join(' / ')}; largest growth ${summary.join(', ')}`);
console.log(`\n${ok} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
