// Error-MESSAGE parity gate for the EMITTED parser against the RUNTIME INTERPRETER
// (createParser) — the oracle. emit-parser-verify.ts gates accept/reject parity and
// byte-identical CSTs but deliberately ignores error text; this gate pins the text:
// for every corpus file BOTH parsers reject, the thrown messages must be EQUAL.
// Levers that touch error-only state (maxPos / farthest-token tracking) gate here.
//
//   node test/emit-reject-messages.ts        # full conformance corpus
import { createParser } from '../src/gen-parser.ts';
import { emitParser } from '../src/emit-parser.ts';
import { readdir } from 'fs/promises';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const grammar = (await import('../typescript.ts')).default;
const oracle = createParser(grammar);

const EMITTED = '/tmp/emitted-parser-msg.mjs';
writeFileSync(EMITTED, emitParser(grammar));
const emitted = await import(EMITTED + '?v=' + Date.now());

const baseDir = '/tmp/ts-repo/tests/cases';
async function allTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await allTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function errOf(parse: (s: string) => unknown, code: string): string | null {
  try { parse(code); return null; }
  catch (e) { return (e as Error).message; }
}

let bothReject = 0;
let mismatches = 0;
const samples: { file: string; oracle: string; emit: string }[] = [];
for (const f of (await allTs(baseDir)).sort()) {
  let code: string;
  try { code = readFileSync(f, 'utf-8'); } catch { continue; }
  const o = errOf(oracle.parse, code);
  if (o === null) continue;
  const e = errOf(emitted.parse as (s: string) => unknown, code);
  if (e === null) continue; // accept/reject parity is emit-parser-verify's gate
  bothReject++;
  if (o !== e) {
    mismatches++;
    if (samples.length < 10) samples.push({ file: f.replace(baseDir + '/', ''), oracle: o, emit: e });
  }
}

console.log(`both-reject files: ${bothReject}, message mismatches: ${mismatches}`);
for (const s of samples) {
  console.log(`  ${s.file}`);
  console.log(`    oracle: ${s.oracle}`);
  console.log(`    emit:   ${s.emit}`);
}
if (mismatches > 0) {
  console.error('✗ emitted reject messages diverge from the interpreter');
  process.exit(1);
}
console.log('✓ emitted reject messages ≡ interpreter');
