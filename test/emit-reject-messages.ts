// Error-MESSAGE parity gate for the EMITTED parser against the RUNTIME INTERPRETER
// (createParser) — the oracle. emit-parser-verify.ts gates accept/reject parity and
// byte-identical CSTs but deliberately ignores error text; this gate pins the text.
//
// The PRIMARY error (offset + reason) is the consumer-facing contract and must be EQUAL for
// every input both parsers reject. The trailing `[farthest: …]` hint is the parser's
// exploration HIGH-WATER mark: the two engines run deliberately-independent control loops
// (Layer B — e.g. the interpreter prunes some inline alts the emitter still tries, issue #45
// D1), so they can reach it differently in rare error cases WITHOUT any CST or primary-error
// difference. emit-parser-verify proves CST parity across the whole corpus, so a farthest-only
// difference is benign — report it, but pin only the primary message. (Across the 18,805-file
// TS corpus exactly one file, the multi-file bigintPropertyName.ts, differs this way.)
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

const EMITTED = '/tmp/emitted-parser-msg.mts';
writeFileSync(EMITTED, emitParser(grammar));
const emitted = await import(EMITTED + '?v=' + Date.now());

function errOf(parse: (s: string) => unknown, code: string): string | null {
  try { parse(code); return null; }
  catch (e) { return (e as Error).message; }
}

const FARTHEST = / \[farthest: .*\]$/;
const primary = (m: string) => m.replace(FARTHEST, '');

function sweep(samples: { name: string; code: string }[]) {
  let bothReject = 0, mismatches = 0, farthestOnly = 0;
  const out: { name: string; oracle: string; emit: string }[] = [];
  const fout: { name: string; oracle: string; emit: string }[] = [];
  for (const { name, code } of samples) {
    const o = errOf(oracle.parse, code);
    if (o === null) continue;
    if (o.includes('Maximum call stack')) continue; // oracle capacity, not a verdict
    const e = errOf(emitted.parse as (s: string) => unknown, code);
    if (e === null) continue; // accept/reject parity is emit-parser-verify's gate
    bothReject++;
    if (o === e) continue;
    if (primary(o) === primary(e)) { farthestOnly++; if (fout.length < 5) fout.push({ name, oracle: o, emit: e }); continue; }
    mismatches++; if (out.length < 10) out.push({ name, oracle: o, emit: e });
  }
  return { bothReject, mismatches, farthestOnly, samples: out, fsamples: fout };
}

function report(label: string, r: ReturnType<typeof sweep>) {
  console.log(`${label}: both-reject ${r.bothReject}, primary mismatches ${r.mismatches}, farthest-only ${r.farthestOnly}`);
  for (const s of r.samples) {
    console.log(`  ✗ ${s.name}`);
    console.log(`    oracle: ${s.oracle}`);
    console.log(`    emit:   ${s.emit}`);
  }
  for (const s of r.fsamples) console.log(`  ~ farthest-only: ${s.name} (oracle ${primary(s.oracle) === s.oracle ? '' : 'hint'} differs only in the exploration hint)`);
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
  console.error('✗ emitted reject messages diverge from the interpreter (primary error)');
  process.exit(1);
}
console.log('✓ emitted reject messages ≡ interpreter (primary error; farthest-exploration hint may differ — see header)');
