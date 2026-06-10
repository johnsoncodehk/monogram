// Interleaved A/B of two EMITTED parser builds on the PR#4 bench files — the standard
// keep/revert gate for emit-layer perf work (best-of-7 × N=20, min taken, engines
// alternated within one process so machine drift cancels).
//   node test/ab-emitted.mjs /tmp/emitted-A.mjs /tmp/emitted-B.mjs
// Emit a build of the current working tree with:
//   node -e "const{emitParser}=await import('./src/emit-parser.ts');const g=(await import('./typescript.ts')).default;require('fs').writeFileSync(process.argv[1],emitParser(g))" --input-type=module /tmp/emitted-X.mjs
// (or see test/emit-parser-bench.ts). For a committed baseline: git stash → emit → stash pop.
import { readFileSync } from 'node:fs';
const [pa, pb] = [process.argv[2], process.argv[3]];
if (!pa || !pb) { console.error('usage: node test/ab-emitted.mjs <A.mjs> <B.mjs>'); process.exit(1); }
const A = await import(pa);
const B = await import(pb);
const paths = [
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserharness.ts',
  '/tmp/ts-repo/tests/cases/conformance/fixSignatureCaching.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/parserRealSource7.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserindenter.ts',
];
const files = paths.map(p => ({ name: p.split('/').pop(), code: readFileSync(p, 'utf8') }));
const time = (fn, code, n) => { const s = process.hrtime.bigint(); for (let i = 0; i < n; i++) { try { fn(code); } catch {} } return Number(process.hrtime.bigint() - s) / 1e6 / n; };
for (const { code } of files) for (let i = 0; i < 10; i++) { try { A.parse(code); B.parse(code); } catch {} }
let ta = 0, tb = 0;
for (const { name, code } of files) {
  let a = Infinity, b = Infinity;
  for (let r = 0; r < 7; r++) { a = Math.min(a, time(A.parse, code, 20)); b = Math.min(b, time(B.parse, code, 20)); }
  ta += a; tb += b;
  console.log(`${name.padEnd(28)} ${a.toFixed(2).padStart(6)} → ${b.toFixed(2).padEnd(6)} ${((a / b - 1) * 100).toFixed(1).padStart(6)}%`);
}
console.log(`${'AGGREGATE'.padEnd(28)} ${ta.toFixed(2).padStart(6)} → ${tb.toFixed(2).padEnd(6)} ${((ta / tb - 1) * 100).toFixed(1).padStart(6)}%`);
