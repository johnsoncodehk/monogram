// Error-MESSAGE parity gate for the EMITTED parser against the RUNTIME INTERPRETER
// (createParser) — the oracle. emit-parser-verify.ts gates accept/reject parity and
// byte-identical CSTs but deliberately ignores error text; this gate pins the text:
// for every input BOTH parsers reject, the thrown messages must be EQUAL. Levers that
// touch error-only state (maxPos / farthest-token tracking, SECOND-set prune decisions)
// gate here.
//
// HARD gate = the in-repo corpus (test/emit-corpus.ts); the optional /tmp/ts-repo corpus
// is also swept when present. Corpus-free, so it runs in `npm run check` everywhere.
//
//   node test/emit-reject-messages.ts
import { createParser } from '../src/gen-parser.ts';
import { emitParser } from '../src/emit-parser.ts';
import { inRepoCorpus, externalTsFiles } from './emit-corpus.ts';
import { readFileSync, writeFileSync } from 'fs';

const grammar = (await import('../typescript.ts')).default;
const oracle = createParser(grammar);

const EMITTED = '/tmp/emitted-parser-msg.mjs';
writeFileSync(EMITTED, emitParser(grammar));
const emitted = await import(EMITTED + '?v=' + Date.now());

function errOf(parse: (s: string) => unknown, code: string): string | null {
  try { parse(code); return null; }
  catch (e) { return (e as Error).message; }
}

function sweep(samples: { name: string; code: string }[]) {
  let bothReject = 0, mismatches = 0;
  const out: { name: string; oracle: string; emit: string }[] = [];
  for (const { name, code } of samples) {
    const o = errOf(oracle.parse, code);
    if (o === null) continue;
    if (o.includes('Maximum call stack')) continue; // oracle capacity, not a verdict
    const e = errOf(emitted.parse as (s: string) => unknown, code);
    if (e === null) continue; // accept/reject parity is emit-parser-verify's gate
    bothReject++;
    if (o !== e) { mismatches++; if (out.length < 10) out.push({ name, oracle: o, emit: e }); }
  }
  return { bothReject, mismatches, samples: out };
}

function report(label: string, r: ReturnType<typeof sweep>) {
  console.log(`${label}: both-reject ${r.bothReject}, message mismatches ${r.mismatches}`);
  for (const s of r.samples) {
    console.log(`  ${s.name}`);
    console.log(`    oracle: ${s.oracle}`);
    console.log(`    emit:   ${s.emit}`);
  }
}

// ── 1) HARD gate: in-repo corpus ──
const r1 = sweep(inRepoCorpus());
report('in-repo corpus', r1);

// ── 2) Optional breadth: external corpus ──
const ext = externalTsFiles();
let extMismatch = 0;
if (ext.length) {
  const samples = ext.map((f) => { try { return { name: f, code: readFileSync(f, 'utf8') }; } catch { return null; } }).filter(Boolean) as { name: string; code: string }[];
  const r2 = sweep(samples);
  report(`external corpus (${samples.length} files)`, r2);
  extMismatch = r2.mismatches;
} else {
  console.log('external corpus (/tmp/ts-repo) absent — in-repo gate only');
}

if (r1.mismatches + extMismatch > 0) {
  console.error('✗ emitted reject messages diverge from the interpreter');
  process.exit(1);
}
console.log('✓ emitted reject messages ≡ interpreter');
