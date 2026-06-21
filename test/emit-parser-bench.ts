// Benchmark: RUNTIME INTERPRETER (createParser, gen-parser.ts) vs the EMITTED
// specialized parser (emit-parser.ts) on the files where they AGREE — the 4
// test/bench.ts files (verified byte-identical) plus, optionally, more.
//
// Method mirrors test/bench.ts: warm up, then N timed runs, ms/parse per file +
// the multiplier (interpreter_ms / emitted_ms) per file and aggregate. The lexer
// is shared (same tokenize), so the delta isolates the PARSER-layer speedup.
//
//   node test/emit-parser-bench.ts            # the 4 bench files, N=20
//   node test/emit-parser-bench.ts <N>        # custom timed-run count
import { createParser } from '../src/gen-parser.ts';
import { emitParser } from '../src/emit-parser.ts';
import { readFileSync, writeFileSync } from 'fs';

const grammar = (await import('../typescript.ts')).default;
const oracle = createParser(grammar);

const EMITTED = '/tmp/emitted-parser.mts';
writeFileSync(EMITTED, emitParser(grammar));
const emitted = await import(EMITTED + '?v=' + Date.now());

const N = Number(process.argv[2]) || 20;

const files = [
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserharness.ts',
  '/tmp/ts-repo/tests/cases/conformance/fixSignatureCaching.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/parserRealSource7.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserindenter.ts',
];

function time(parse: (s: string) => unknown, code: string, n: number): number {
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i++) { try { parse(code); } catch {} }
  return Number(process.hrtime.bigint() - start) / 1e6 / n;
}

// Warm up both engines (JIT to steady state) before timing.
function warm(parse: (s: string) => unknown, code: string) {
  for (let i = 0; i < 10; i++) { try { parse(code); } catch {} }
}

console.log(`N=${N} timed runs/engine/file  (lexer is shared → delta = parser layer)\n`);
console.log('file                          KB   interp ms   emit ms    speedup');
console.log('-'.repeat(74));

let totInterp = 0, totEmit = 0;
for (const f of files) {
  const code = readFileSync(f, 'utf-8');
  warm(oracle.parse, code);
  warm(emitted.parse as (s: string) => unknown, code);
  // Interleave a few rounds and take the best (min) to reduce GC/scheduler noise.
  let interp = Infinity, emit = Infinity;
  for (let r = 0; r < 5; r++) {
    interp = Math.min(interp, time(oracle.parse, code, N));
    emit = Math.min(emit, time(emitted.parse as (s: string) => unknown, code, N));
  }
  totInterp += interp; totEmit += emit;
  const name = (f.split('/').pop() ?? '').padEnd(28);
  const kb = (code.length / 1024).toFixed(0).padStart(4);
  console.log(`${name}${kb}   ${interp.toFixed(2).padStart(8)}   ${emit.toFixed(2).padStart(7)}    ${(interp / emit).toFixed(2)}x`);
}
console.log('-'.repeat(74));
console.log(`${'AGGREGATE'.padEnd(28)}     ${totInterp.toFixed(2).padStart(8)}   ${totEmit.toFixed(2).padStart(7)}    ${(totInterp / totEmit).toFixed(2)}x`);
