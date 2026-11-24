// node cg-self.ts <callgrind.out> [n]: the n functions with the most SELF instructions (Ir), each
// summed over every source file its instructions come from (its inlined callees' lines included),
// read from the Callgrind output itself: callgrind_annotate lists one function once per file, and
// its output format differs between valgrind versions (run.sh, phase shape).
import { readFileSync } from 'node:fs';

const [path, n0] = process.argv.slice(2);
if (!path) throw new Error('usage: cg-self.ts <callgrind.out> [n]');
const names = new Map<string, string>();
// A compressed name: "(id) name" defines id, "(id)" refers to it.
const fnName = (v: string): string => {
  const m = /^\((\d+)\)(?:\s+(.*))?$/.exec(v);
  if (!m) return v;
  if (m[2] !== undefined) names.set(m[1]!, m[2]);
  return names.get(m[1]!) ?? v;
};
const self = new Map<string, number>();
let fn = '', afterCalls = false, total = 0;
for (const l of readFileSync(path, 'utf8').split('\n')) {
  if (l.startsWith('fn=')) { fn = fnName(l.slice(3)); continue; }
  if (l.startsWith('cfn=')) { fnName(l.slice(4)); continue; }
  if (l.startsWith('calls=')) { afterCalls = true; continue; }
  const m = /^([+-]?\d+|\*)\s+(\d+)/.exec(l);
  if (!m) continue;
  // The cost line after calls= is the call's inclusive cost: not this function's own.
  if (afterCalls) { afterCalls = false; continue; }
  const c = +m[2]!;
  total += c;
  self.set(fn, (self.get(fn) ?? 0) + c);
}
console.log(`${String(total).padStart(11)}  (total)`);
for (const [f, c] of [...self].sort((a, b) => b[1] - a[1]).slice(0, +(n0 ?? 30))) console.log(`${String(c).padStart(11)}  ${f}`);
