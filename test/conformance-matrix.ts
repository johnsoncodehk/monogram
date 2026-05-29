// Bidirectional conformance: a real parser must ACCEPT what TS accepts AND REJECT
// what TS rejects. The snapshot's "pass = didn't throw" only measures acceptance —
// the easy half — so it counts an over-accept (invalid code we wave through) as a
// success. This computes the full confusion matrix against TS's own parseDiagnostics
// over single-file conformance cases (multi-`@filename` excluded — not one program).
import { createParser } from '../src/gen-parser.ts';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

const grammar = (await import('../examples/typescript.ts')).default;
const { parse } = createParser(grammar);
const base = '/tmp/ts-repo/tests/cases/conformance';

function walk(d: string): string[] {
  let o: string[] = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.isDirectory()) o = o.concat(walk(f));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) o.push(f);
  }
  return o;
}
const isMulti = (t: string) => /^\s*\/\/\s*@filename:/im.test(t);

let TP = 0, FN = 0, FP = 0, TN = 0;
const fns: string[] = [], fps: string[] = [];
for (const f of walk(base)) {
  const code = readFileSync(f, 'utf8');
  if (isMulti(code)) continue;
  const sf = ts.createSourceFile('t.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tsAccept = ((sf as any).parseDiagnostics?.length ?? 0) === 0;
  let weAccept = true;
  try { parse(code); } catch { weAccept = false; }
  if (tsAccept && weAccept) TP++;
  else if (tsAccept && !weAccept) { FN++; fns.push(f.replace(base + '/', '')); }
  else if (!tsAccept && weAccept) { FP++; fps.push(f.replace(base + '/', '')); }
  else TN++;
}
const total = TP + FN + FP + TN;
console.log(`Single-file conformance cases: ${total}\n`);
console.log('                     WE accept        WE reject');
console.log(`  TS accept (valid)  ${String(TP).padStart(6)} (correct)  ${String(FN).padStart(4)} (MISS — valid-code gap)`);
console.log(`  TS reject (error)  ${String(FP).padStart(6)} (over-accept)${String(TN).padStart(4)} (correct reject)`);
console.log('');
console.log(`  Valid-code coverage : ${(TP / (TP + FN) * 100).toFixed(2)}%  (${TP}/${TP + FN})  ← parses every valid file when FN=0`);
console.log(`  Bidirectional agree : ${((TP + TN) / total * 100).toFixed(2)}%  (${TP + TN}/${total})`);
if (fns.length) console.log(`\n  MISSED valid (real gaps):\n${fns.map(x => '    - ' + x).join('\n')}`);

// Over-accepts grouped by directory → the over-acceptance *categories* to tighten.
// Run `node test/conformance-matrix.ts fp` to also list every file under each group.
const showFiles = process.argv.includes('fp');
const byDir = new Map<string, string[]>();
for (const f of fps) {
  const dir = f.split('/').slice(0, -1).join('/');
  (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(f);
}
const groups = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`\n  OVER-ACCEPTS by directory (${FP} files, ${groups.length} dirs) — these are the categories to tighten:`);
for (const [dir, files] of groups) {
  console.log(`    ${String(files.length).padStart(3)}  ${dir}`);
  if (showFiles) for (const f of files) console.log(`         ${f.split('/').pop()}`);
}
if (!showFiles) console.log(`\n  (re-run with \`fp\` to list every file: node test/conformance-matrix.ts fp)`);
