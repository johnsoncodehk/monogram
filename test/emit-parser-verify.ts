// Correctness gate for the EMITTED parser (src/emit-parser.ts) against the RUNTIME
// INTERPRETER (src/gen-parser.ts createParser) — the oracle.
//
// For each input it runs BOTH parsers and compares (a) accept/reject (throw vs not)
// and (b) the produced CST, JSON-stringified, byte-for-byte. The HARD gate is the
// in-repo corpus (test/emit-corpus.ts: curated TS snippets + the repo's own .ts
// sources), so the check is CORPUS-FREE and runs in `npm run check` everywhere — the
// mechanism that forces a gen-parser change to propagate to emit-parser (issue #45).
// When the optional /tmp/ts-repo corpus is present it is ALSO swept for breadth.
//
//   node test/emit-parser-verify.ts            # in-repo corpus (+ /tmp/ts-repo if present)
//   node test/emit-parser-verify.ts all        # also sweep EVERY external file (no stride)
//   node test/emit-parser-verify.ts <N>        # external sweep stride N (default ~400 files)
import { objectify } from './emitted-obj.ts';
import { createParser } from '../src/gen-parser.ts';
import { emitParser, jsTarget } from '../src/emit.ts';
import { inRepoCorpus, externalTsFiles } from './emit-corpus.ts';
import { readFileSync, writeFileSync } from 'fs';

const grammar = (await import('../typescript.ts')).default;
const oracle = createParser(grammar);

// Emit, write to /tmp, import the standalone module.
const EMITTED = '/tmp/emitted-parser.mts';
writeFileSync(EMITTED, emitParser(grammar, jsTarget));
const emitted = await import(EMITTED + '?v=' + Date.now());

type Outcome = { ok: true; cst: string } | { ok: false; err: string };
function run(parse: (s: string) => unknown, code: string): Outcome {
  try { return { ok: true, cst: JSON.stringify(parse(code)) }; }
  catch (e) { return { ok: false, err: (e as Error).message }; }
}

// Compare one input. Returns 'agree' | 'accept-mismatch' | 'cst-mismatch' | 'oracle-capacity'.
function compare(code: string): { verdict: string; detail?: string } {
  const o = run(oracle.parse, code);
  // The emitted parser returns an arena node id; materialize the object view for the
  // byte-identical comparison against the interpreter's object tree.
  const e = run((s: string) => { const r = emitted.parse(s); return objectify(emitted.tree, (fns) => emitted.visit(r, fns)); }, code);
  if (!o.ok && o.err.includes('Maximum call stack')) {
    // The interpreter recursed out of stack — a CAPACITY limit, not a parse verdict;
    // the emitted parser's flatter frames can legitimately survive deeper inputs.
    // Semantic parity is only checkable where the oracle can actually answer.
    return { verdict: 'oracle-capacity', detail: `oracle stack overflow / emit ${e.ok ? 'accept' : 'reject'}` };
  }
  if (o.ok !== e.ok) {
    return { verdict: 'accept-mismatch', detail: `oracle ${o.ok ? 'accept' : 'reject'} / emit ${e.ok ? 'accept' : 'reject'}` };
  }
  if (!o.ok) {
    // Both reject: count as agree (accept/reject parity is the contract; error TEXT
    // is pinned separately by emit-reject-messages.ts).
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

function tally(samples: { name: string; code: string }[]) {
  const counts: Record<string, number> = { agree: 0, 'accept-mismatch': 0, 'cst-mismatch': 0, 'oracle-capacity': 0 };
  const divergences: { name: string; verdict: string; detail?: string }[] = [];
  for (const { name, code } of samples) {
    let r: { verdict: string; detail?: string };
    try { r = compare(code); }
    catch (e) { r = { verdict: 'cst-mismatch', detail: 'compare threw: ' + (e as Error).message }; }
    counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
    if (r.verdict !== 'agree' && r.verdict !== 'oracle-capacity') divergences.push({ name, verdict: r.verdict, detail: r.detail });
  }
  return { counts, divergences };
}

// ── 1) The HARD gate: the in-repo corpus must all agree ──
const inRepo = inRepoCorpus();
console.log(`=== in-repo corpus (HARD gate: ${inRepo.length} samples — curated + repo sources) ===`);
const r1 = tally(inRepo);
const agree1 = r1.counts.agree ?? 0;
console.log(`agreement: ${agree1}/${inRepo.length}`);
console.log(`  accept/reject mismatches: ${r1.counts['accept-mismatch'] ?? 0}`);
console.log(`  CST mismatches:           ${r1.counts['cst-mismatch'] ?? 0}`);
console.log(`  oracle-capacity skips:    ${r1.counts['oracle-capacity'] ?? 0}`);
for (const d of r1.divergences.slice(0, 15)) {
  console.log(`  [${d.verdict}] ${d.name}`);
  if (d.detail) console.log(`     ${d.detail}`);
}

// ── 2) Optional breadth: the external /tmp/ts-repo corpus when present ──
const arg = process.argv[2];
const extAll = externalTsFiles();
let extDiv = 0;
if (extAll.length) {
  let sample: string[];
  if (arg === 'all') sample = extAll;
  else { const stride = arg ? Number(arg) : Math.max(1, Math.floor(extAll.length / 400)); sample = extAll.filter((_, i) => i % stride === 0); }
  const samples = sample.map((f) => { try { return { name: f, code: readFileSync(f, 'utf-8') }; } catch { return null; } }).filter(Boolean) as { name: string; code: string }[];
  console.log(`\n=== external corpus sample (${samples.length} of ${extAll.length} files) ===`);
  const r2 = tally(samples);
  const agree2 = r2.counts.agree ?? 0;
  console.log(`agreement: ${agree2}/${samples.length} = ${(100 * agree2 / Math.max(1, samples.length)).toFixed(2)}%`);
  console.log(`  accept/reject mismatches: ${r2.counts['accept-mismatch'] ?? 0}`);
  console.log(`  CST mismatches:           ${r2.counts['cst-mismatch'] ?? 0}`);
  console.log(`  oracle-capacity skips:    ${r2.counts['oracle-capacity'] ?? 0}`);
  extDiv = r2.divergences.length;
  if (extDiv) {
    for (const d of r2.divergences.slice(0, 15)) { console.log(`  [${d.verdict}] ${d.name}`); if (d.detail) console.log(`     ${d.detail}`); }
    writeFileSync('/tmp/emit-divergences.json', JSON.stringify(r2.divergences, null, 2));
    console.log(`\n(full list: /tmp/emit-divergences.json — ${extDiv} entries)`);
  }
} else {
  console.log('\n=== external corpus (/tmp/ts-repo) absent — in-repo gate only ===');
}

const failed = r1.divergences.length + extDiv;
if (failed) { console.error(`\n✗ emit ≢ interpreter (${failed} divergence${failed === 1 ? '' : 's'})`); process.exit(1); }
console.log('\n✓ emitted parser ≡ interpreter (CST byte-identical)');
