// Generate a V8 CPU profile of the parser.
//   npx tsx test/cpu-profile.ts                 # profile the bench corpus (mixed real files)
//   npx tsx test/cpu-profile.ts <file.ts>       # profile a single file
//   npx tsx test/cpu-profile.ts <file.ts> 8     # ...for ~8 seconds of samples
// Writes parser.cpuprofile (open in Chrome DevTools ▸ Performance ▸ Load profile, or VS Code).
import { Session } from 'node:inspector';
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createParser } from '../src/gen-parser.ts';

const grammar = (await import('../examples/typescript.ts')).default;
const { parse } = createParser(grammar);

const arg = process.argv[2];
const seconds = Number(process.argv[3]) || 4;

const corpus = [
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserharness.ts',
  '/tmp/ts-repo/tests/cases/conformance/fixSignatureCaching.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/parserRealSource7.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserindenter.ts',
];
const paths = arg ? [arg] : corpus;
const files = paths
  .map((p) => { try { return readFileSync(p, 'utf-8'); } catch { return null; } })
  .filter((c): c is string => c !== null);

if (files.length === 0) { console.error('no readable input files:', paths); process.exit(1); }
const totalKB = (files.reduce((n, c) => n + c.length, 0) / 1024).toFixed(0);

// Warm up so the profile reflects JIT-optimized steady state, not the cold tier.
for (let r = 0; r < 5; r++) for (const c of files) { try { parse(c); } catch {} }

const session = new Session();
session.connect();
const post = (method: string, params?: any) =>
  new Promise<any>((res, rej) => session.post(method, params, (e: any, r: any) => (e ? rej(e) : res(r))));

await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 200 }); // microseconds (5x finer than default)
await post('Profiler.start');

const start = process.hrtime.bigint();
let parses = 0;
while (Number(process.hrtime.bigint() - start) / 1e9 < seconds) {
  for (const c of files) { try { parse(c); } catch {} parses++; }
}
const secs = Number(process.hrtime.bigint() - start) / 1e9;

const { profile } = await post('Profiler.stop');
const outPath = resolve('parser.cpuprofile');
writeFileSync(outPath, JSON.stringify(profile));

// Text summary: aggregate self-time (hitCount = samples landing on top of stack) by function.
const byFn = new Map<string, number>();
let totalSamples = 0;
for (const node of profile.nodes) {
  const hc = node.hitCount || 0;
  if (!hc) continue;
  totalSamples += hc;
  const cf = node.callFrame;
  const name = cf.functionName || '(anonymous)';
  const file = (cf.url || '').split('/').pop() || cf.url || '';
  const where = file ? `${file}:${cf.lineNumber + 1}` : '(native)';
  const key = `${name.padEnd(22)} ${where}`;
  byFn.set(key, (byFn.get(key) || 0) + hc);
}
const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);

console.log(`\nprofiled ${parses} parses of ${files.length} file(s) (${totalKB} KB/round) in ${secs.toFixed(1)}s`);
console.log(`${totalSamples} samples @200us\n`);
console.log(' self%   samples  function @ file:line');
console.log(' ' + '-'.repeat(60));
let cum = 0;
for (const [k, v] of top) {
  cum += v;
  console.log(`${(100 * v / totalSamples).toFixed(1).padStart(5)}%  ${String(v).padStart(7)}  ${k}`);
}
console.log(` (top 25 = ${(100 * cum / totalSamples).toFixed(0)}% of self-time)`);
console.log(`\nwrote ${outPath}`);
console.log('open in Chrome DevTools (Performance ▸ Load profile) or just open the file in VS Code.');
