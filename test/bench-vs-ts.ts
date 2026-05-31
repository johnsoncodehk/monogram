// Compare our grammar-driven parser against TypeScript's own parser (ts.createSourceFile)
// on the same inputs. Both do a full from-scratch parse (no incremental reuse).
import { createParser } from '../src/gen-parser.ts';
import { readFileSync } from 'fs';
import ts from 'typescript';

const grammar = (await import('../typescript.ts')).default;
const { parse } = createParser(grammar);

const tsParse = (code: string) =>
  ts.createSourceFile('t.ts', code, ts.ScriptTarget.Latest, /*setParentNodes*/ false, ts.ScriptKind.TS);

function timeIt(fn: () => void, iters: number): number {
  for (let i = 0; i < 3; i++) fn();                  // warm up
  const start = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  return Number(process.hrtime.bigint() - start) / 1e6 / iters;  // ms/parse
}

const files = [
  ['parserharness.ts',        '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserharness.ts'],
  ['fixSignatureCaching.ts',  '/tmp/ts-repo/tests/cases/conformance/fixSignatureCaching.ts'],
  ['parserRealSource7.ts',    '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/parserRealSource7.ts'],
  ['parserindenter.ts',       '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserindenter.ts'],
];

console.log('file                         KB    ours(ms)   ts(ms)   ours/ts');
for (const [name, path] of files) {
  const code = readFileSync(path, 'utf-8');
  const kb = (code.length / 1024).toFixed(0);
  const ours = timeIt(() => { try { parse(code); } catch {} }, 30);
  const tsms = timeIt(() => { tsParse(code); }, 30);
  console.log(
    name.padEnd(28) + kb.padStart(4) +
    ours.toFixed(1).padStart(11) + tsms.toFixed(2).padStart(9) +
    ('×' + (ours / tsms).toFixed(1)).padStart(10),
  );
}
