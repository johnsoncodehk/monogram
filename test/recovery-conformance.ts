// Error-recovery conformance: on every single-file conformance test that tsc's
// PARSER rejects, compare Monogram's total-parse diagnostics against tsc's
// parseDiagnostics (the live source of the .errors.txt syntax baselines),
// BIDIRECTIONALLY:
//   recall    — tsc diagnostics with a Monogram diagnostic within ±SLACK chars
//   precision — Monogram diagnostics with a tsc diagnostic within ±SLACK chars
//   first     — files where the FIRST error positions agree within ±SLACK
// Diagnostic positions are parser-policy choices (where to blame a missing
// token), so the slack absorbs token-boundary differences; the metric is about
// reporting the same BREAKAGES, not byte-equal spans.
//
//   node --max-old-space-size=4096 test/recovery-conformance.ts
import { writeFileSync, readFileSync } from 'node:fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { emitParser } from '../src/emit-parser.ts';
import ts from 'typescript';

const grammar = (await import('../typescript.ts')).default;
const emPath = '/tmp/emitted-recovery-conf.mjs';
writeFileSync(emPath, emitParser(grammar));
type Cst = { root: number; errors: { offset: number; end: number; message: string }[] };
const em = (await import(emPath + '?v=' + process.pid)) as { createParser(): { parse(s: string): Cst } };
const p = em.createParser();

const baseDir = '/tmp/ts-repo/tests/cases/conformance';
const SLACK = 8;

async function allTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...await allTsFiles(full));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}
const isMulti = (t: string) => /^\s*\/\/\s*@filename:/im.test(t);

const files = (await allTsFiles(baseDir)).sort();
let nFiles = 0, tTotal = 0, tHit = 0, mTotal = 0, mHit = 0, firstOK = 0, weSilent = 0, oracleCrash = 0;
const worst: { file: string; kind: string; at: number; msg: string }[] = [];

for (const file of files) {
  const code = readFileSync(file, 'utf-8');
  if (isMulti(code)) continue;
  let sf;
  try {
    sf = ts.createSourceFile('t.ts', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  } catch { oracleCrash++; continue; }
  const tDiags = (sf as unknown as { parseDiagnostics: { start: number }[] }).parseDiagnostics;
  if (tDiags.length === 0) continue;          // parser-valid: the accept/CST gates own it
  const T = [...new Set(tDiags.map(d => d.start ?? 0))].sort((a, b) => a - b);
  const c = p.parse(code);
  const M = [...new Set(c.errors.map(g => g.offset))].sort((a, b) => a - b);
  nFiles++;
  if (M.length === 0) {
    weSilent++;
    if (worst.length < 12) worst.push({ file: file.replace(baseDir + '/', ''), kind: 'WE-ACCEPT', at: T[0], msg: code.slice(Math.max(0, T[0] - 30), T[0] + 20).replace(/\n/g, '⏎') });
  }
  const near = (xs: number[], x: number) => xs.some(y => Math.abs(y - x) <= SLACK);
  tTotal += T.length; mTotal += M.length;
  for (const t of T) if (near(M, t)) tHit++; else if (worst.length < 24 && M.length > 0) worst.push({ file: file.replace(baseDir + '/', ''), kind: 'MISSED', at: t, msg: code.slice(Math.max(0, t - 30), t + 20).replace(/\n/g, '⏎') });
  for (const m of M) if (near(T, m)) mHit++;
  if (M.length > 0 && Math.abs(M[0] - T[0]) <= SLACK) firstOK++;
}

const pct = (a: number, b: number) => b === 0 ? '—' : (100 * a / b).toFixed(2) + '%';
console.log(`error-recovery conformance vs tsc parseDiagnostics (${baseDir}, slack ±${SLACK}):`);
console.log(`  files tsc-parser-rejects (single-file): ${nFiles}${oracleCrash ? ` (+${oracleCrash} oracle crashes skipped)` : ''}`);
console.log(`  recall    (tsc errors we also report):   ${tHit}/${tTotal} = ${pct(tHit, tTotal)}`);
console.log(`  precision (our errors tsc also reports): ${mHit}/${mTotal} = ${pct(mHit, mTotal)}`);
console.log(`  first-error agreement:                   ${firstOK}/${nFiles} = ${pct(firstOK, nFiles)}`);
console.log(`  files we accept but tsc rejects:         ${weSilent}`);
if (worst.length) {
  console.log(`\n  ===== sample divergences =====`);
  for (const w of worst) console.log(`  [${w.kind}] ${w.file} @${w.at}  «${w.msg}»`);
}
