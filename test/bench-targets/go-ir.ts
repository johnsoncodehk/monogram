// node go-ir.ts <callgrind.out> [--functions]: the Go target's instruction count of one parse from a
// Callgrind output of go-main.go's count-* modes (run with --compress-strings=no --compress-pos=no).
// Prints "ir=<total minus map lookups> total=<total> mapir=<map lookups' instructions>
// mapcalls=<calls into the map runtime>"; --functions prints every function's own instructions.
//
// Why the map runtime is apart: a Go map's hash seed is random per map and per process, so the
// instructions of one lookup (its probe sequence, its false h2 matches, the key comparisons they
// cost) differ from run to run (measured: up to 0.5% of a parse of checker.ts between two runs of
// one binary), while the number of lookups does not. `mapir` is the inclusive cost of every call
// from outside the map runtime into it (a lookup switches no stack, so Callgrind's inclusive cost
// of that call is exact), `ir` the count without it, and `mapcalls` the number of those calls; `total` is printed for reference. Once no map is read on the parse
// path (the Pratt operator tables and the keyword lookup are the two today), mapir and mapcalls
// are 0 and ir = total.
import { readFileSync } from 'node:fs';

const [file, flag] = process.argv.slice(2);
if (!file) throw new Error('usage: go-ir.ts <callgrind.out> [--functions]');
const MAP_RUNTIME = /^(internal\/runtime\/maps\.|runtime\.(mapaccess|mapassign|mapiter|memhash|strhash|aeshash|typehash)|aeshashbody)/;
const self = new Map<string, number>();
let fn = '', cfn = '', afterCalls = false, intoMap = false, total = NaN, mapcalls = 0, mapir = 0;
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line.startsWith('fn=')) { fn = line.slice(3).replace(/^\(\d+\)\s*/, ''); continue; }
  if (line.startsWith('cfn=')) { cfn = line.slice(4).replace(/^\(\d+\)\s*/, ''); continue; }
  if (line.startsWith('calls=')) {
    afterCalls = true;
    intoMap = MAP_RUNTIME.test(cfn) && !MAP_RUNTIME.test(fn);
    if (intoMap) mapcalls += +line.slice(6).split(/\s+/)[0]!;
    continue;
  }
  if (line.startsWith('totals:') || line.startsWith('summary:')) { if (Number.isNaN(total)) total = +line.split(/\s+/)[1]!; continue; }
  if (/^[+-]?\d/.test(line)) {
    const ir = +line.split(/\s+/)[1]!;
    // A cost line right after calls= is the call's inclusive cost (the callee's own lines carry it).
    if (afterCalls) { afterCalls = false; if (intoMap) mapir += ir; continue; }
    if (Number.isFinite(ir)) self.set(fn, (self.get(fn) ?? 0) + ir);
  }
}
if (!Number.isFinite(total)) throw new Error('no totals in ' + file);
let sum = 0;
for (const n of self.values()) sum += n;
if (sum !== total) throw new Error(`${file}: own costs sum to ${sum}, totals say ${total}`);
if (flag === '--functions') for (const [f, n] of [...self].sort((a, b) => b[1] - a[1])) console.log(n, f);
else console.log(`ir=${total - mapir} total=${total} mapir=${mapir} mapcalls=${mapcalls}`);
