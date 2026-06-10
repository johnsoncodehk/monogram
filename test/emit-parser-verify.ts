// Correctness gate for the EMITTED parser (src/emit-parser.ts) against the RUNTIME
// INTERPRETER (src/gen-parser.ts createParser) — the oracle.
//
// For each input it runs BOTH parsers and compares (a) accept/reject (throw vs not)
// and (b) the produced CST, JSON-stringified, byte-for-byte. The 4 test/bench.ts
// files (the benchmark inputs) MUST be byte-identical; then a stride-sample of the
// /tmp/ts-repo corpus measures broader agreement.
//
//   node test/emit-parser-verify.ts            # 4 bench files + ~400-file corpus sample
//   node test/emit-parser-verify.ts <N>        # sample stride N (default ~ to hit ~400)
//   node test/emit-parser-verify.ts all        # every .ts file under conformance
import { createParser } from '../src/gen-parser.ts';
import { emitParser } from '../src/emit-parser.ts';
import { readdir } from 'fs/promises';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const grammar = (await import('../typescript.ts')).default;
const oracle = createParser(grammar);

// Emit, write to /tmp, import the standalone module.
const EMITTED = '/tmp/emitted-parser.mjs';
writeFileSync(EMITTED, emitParser(grammar));
const emitted = await import(EMITTED + '?v=' + Date.now());

const BENCH = [
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserharness.ts',
  '/tmp/ts-repo/tests/cases/conformance/fixSignatureCaching.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/parserRealSource7.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserindenter.ts',
];

type Outcome = { ok: true; cst: string } | { ok: false; err: string };
function run(parse: (s: string) => unknown, code: string): Outcome {
  try { return { ok: true, cst: JSON.stringify(parse(code)) }; }
  catch (e) { return { ok: false, err: (e as Error).message }; }
}

// Compare one file. Returns 'agree' | 'accept-mismatch' | 'cst-mismatch' | 'oracle-capacity'.
function compare(code: string): { verdict: string; detail?: string } {
  const o = run(oracle.parse, code);
  const e = run(emitted.parse as (s: string) => unknown, code);
  if (!o.ok && o.err.includes('Maximum call stack')) {
    // The interpreter recursed out of stack — a CAPACITY limit, not a parse verdict;
    // the emitted parser's flatter frames can legitimately survive deeper inputs
    // (first seen on a 139KB union-type stress file the official tsc also accepts).
    // Semantic parity is only checkable where the oracle can actually answer.
    return { verdict: 'oracle-capacity', detail: `oracle stack overflow / emit ${e.ok ? 'accept' : 'reject'}` };
  }
  if (o.ok !== e.ok) {
    return { verdict: 'accept-mismatch', detail: `oracle ${o.ok ? 'accept' : 'reject'} / emit ${e.ok ? 'accept' : 'reject'}` };
  }
  if (!o.ok) {
    // Both reject: count as agree (accept/reject parity is the contract; error TEXT
    // can differ harmlessly, but in practice farthest/offset logic is copied verbatim).
    return { verdict: 'agree' };
  }
  if (o.cst !== (e as { cst: string }).cst) {
    // First differing offset for a compact hint.
    const a = o.cst, b = (e as { cst: string }).cst;
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return { verdict: 'cst-mismatch', detail: `diverge @${i}: …${a.slice(Math.max(0, i - 40), i + 40)}… vs …${b.slice(Math.max(0, i - 40), i + 40)}…` };
  }
  return { verdict: 'agree' };
}

// ── 1) The 4 bench files (HARD: must all agree) ──
console.log('=== bench files (must be byte-identical) ===');
let benchOk = 0;
for (const f of BENCH) {
  const code = readFileSync(f, 'utf-8');
  const r = compare(code);
  console.log(`${r.verdict === 'agree' ? 'OK  ' : 'FAIL'} ${r.verdict.padEnd(16)} ${f.split('/').pop()}`);
  if (r.verdict !== 'agree') console.log(`     ${r.detail}`);
  if (r.verdict === 'agree') benchOk++;
}
console.log(`bench: ${benchOk}/${BENCH.length} byte-identical\n`);

// ── 2) Broader corpus sample ──
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

const arg = process.argv[2];
const files = (await allTs(baseDir)).sort();
let sample: string[];
if (arg === 'all') sample = files;
else {
  const stride = arg ? Number(arg) : Math.max(1, Math.floor(files.length / 400));
  sample = files.filter((_, i) => i % stride === 0);
}

console.log(`=== corpus sample (${sample.length} of ${files.length} files) ===`);
const counts: Record<string, number> = { agree: 0, 'accept-mismatch': 0, 'cst-mismatch': 0 };
const divergences: { file: string; verdict: string; detail?: string }[] = [];
for (const f of sample) {
  let code: string;
  try { code = readFileSync(f, 'utf-8'); } catch { continue; }
  let r: { verdict: string; detail?: string };
  try { r = compare(code); }
  catch (e) { r = { verdict: 'cst-mismatch', detail: 'compare threw: ' + (e as Error).message }; }
  counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  if (r.verdict !== 'agree' && r.verdict !== 'oracle-capacity') divergences.push({ file: f.replace(baseDir + '/', ''), verdict: r.verdict, detail: r.detail });
}
const total = sample.length;
const agree = counts.agree ?? 0;
console.log(`agreement: ${agree}/${total} = ${(100 * agree / total).toFixed(2)}%`);
console.log(`  accept/reject mismatches: ${counts['accept-mismatch'] ?? 0}`);
console.log(`  CST mismatches:           ${counts['cst-mismatch'] ?? 0}`);
console.log(`  oracle-capacity skips:    ${counts['oracle-capacity'] ?? 0}`);
if (divergences.length) {
  console.log(`\nfirst ${Math.min(15, divergences.length)} divergences:`);
  for (const d of divergences.slice(0, 15)) {
    console.log(`  [${d.verdict}] ${d.file}`);
    if (d.detail) console.log(`     ${d.detail}`);
  }
  // Persist the full list for triage.
  writeFileSync('/tmp/emit-divergences.json', JSON.stringify(divergences, null, 2));
  console.log(`\n(full list: /tmp/emit-divergences.json — ${divergences.length} entries)`);
}
