// node blocks.ts <ts.mts|js.mts> <ts-parse|js-fresh> <file> <per-function.json>: the work of ONE
// parse of the TS target (`parse(src)`) or the emitted JS parser (`createParser().parse(src)`), as
// V8 precise block coverage with counts (inspector Profiler.startPreciseCoverage({ callCount: true,
// detailed: true })). Prints "<ACCEPT|REJECT> blocks=<total> functions=<n>" and writes, per function
// of the emitted module, its block executions to <per-function.json>.
//
// The measure: for every function of the module, the sum of the counts of the ranges V8 reports for
// it (the function's own range counts its calls; each nested range, a block's executions). The
// counters are incremented by the code itself, so the same commit and input give the same number
// (test/bench-rust-profile/run.sh measures M twice to show it). It sees control flow, not cost: a
// change inside one block (a string slice against a byte read, a wider object) does not move it;
// and V8 merges a nested range whose count equals its parent's before reporting, so a block that
// always runs with its function is counted with the function, not apart. Collection starts before
// the module is imported (functions compiled earlier are not instrumented per block) and the
// counters are reset after the import, so only the parse is counted.
import { Session } from 'node:inspector/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [mod, mode, file, perFn] = process.argv.slice(2);
if (!mod || !mode || !file || !perFn) throw new Error('usage: blocks.ts <module> <ts-parse|js-fresh> <file> <per-function.json>');
const url = pathToFileURL(resolve(mod)).href;
const src = readFileSync(file, 'utf8');
const s = new Session();
s.connect();
await s.post('Profiler.enable');
await s.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
const m = await import(url);
await s.post('Profiler.takePreciseCoverage'); // resets the counters: the import is not counted
let ok: boolean;
try {
  const r = mode === 'ts-parse' ? m.parse(src) : mode === 'js-fresh' ? m.createParser().parse(src) : (() => { throw new Error('unknown mode ' + mode); })();
  ok = r !== null && r !== undefined;
} catch {
  ok = false; // the JS target's parse throws on a reject
}
const { result } = await s.post('Profiler.takePreciseCoverage');
await s.post('Profiler.stopPreciseCoverage');
const script = result.find((x) => x.url === url);
if (!script) throw new Error('no coverage for ' + url);
const by: Record<string, number> = {};
const seen = new Map<string, number>();
let total = 0;
for (const f of script.functions) {
  // A key per function that does not depend on the counts: its name, numbered in source order.
  const name = f.functionName || '(anonymous)';
  const i = (seen.get(name) ?? 0) + 1;
  seen.set(name, i);
  let n = 0;
  for (const r of f.ranges) n += r.count;
  if (n === 0) continue;
  by[i === 1 ? name : `${name}#${i}`] = n;
  total += n;
}
writeFileSync(perFn, JSON.stringify(by));
console.log(`${ok ? 'ACCEPT' : 'REJECT'} blocks=${total} functions=${Object.keys(by).length}`);
