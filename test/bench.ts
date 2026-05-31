import { createParser } from '../src/gen-parser.ts';
import { readFileSync } from 'fs';
const grammar = (await import('../typescript.ts')).default;
const { parse } = createParser(grammar);

const files = [
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserharness.ts',
  '/tmp/ts-repo/tests/cases/conformance/fixSignatureCaching.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/parserRealSource7.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserindenter.ts',
];

for (const f of files) {
  const code = readFileSync(f, 'utf-8');
  let ok = false;
  try { parse(code); ok = true; } catch {}
  // warm + timed runs
  const N = 5;
  const start = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { try { parse(code); } catch {} }
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1e6 / N;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${(code.length / 1024).toFixed(0)}KB  ${ms.toFixed(1)} ms/parse  ${f.split('/').pop()}`);
}
