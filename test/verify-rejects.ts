// Rigor check for the "error-test" bucket: failing a file that TS also rejects
// only counts as *correct* if we reject for the RIGHT reason — i.e. we reach at
// least as far as TS's first syntax error before bailing. If our parser chokes
// EARLIER than TS's first diagnostic, the code before that point is valid TS we
// silently can't parse — a hidden gap hiding behind the "intentional error" label.
import { createParser } from '../src/gen-parser.ts';
import { readdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

const grammar = (await import('../examples/typescript.ts')).default;
const { parse } = createParser(grammar);
const baseDir = '/tmp/ts-repo/tests/cases/conformance';
const SLACK = 8; // chars of tolerance (token boundary / trivia differences)

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
// How far our parser actually reached: prefer the `farthest` backtracking mark,
// else the primary error offset.
function ourReach(msg: string): number | null {
  const far = msg.match(/farthest: offset (\d+)/);
  if (far) return +far[1];
  const at = msg.match(/offset (\d+)/);
  return at ? +at[1] : null;
}

const files = (await allTsFiles(baseDir)).sort();
let agree = 0, early = 0, unknown = 0;
const earlies: { file: string; ourReach: number; tsFirst: number; ctx: string }[] = [];

for (const file of files) {
  const code = readFileSync(file, 'utf-8');
  if (isMulti(code)) continue;                 // single-file only (clean comparison)
  let msg = '';
  try { parse(code); continue; } catch (e: any) { msg = e.message; }  // only files we FAIL

  const sf = ts.createSourceFile('t.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diags = (sf as any).parseDiagnostics ?? [];
  if (diags.length === 0) continue;            // that's a REAL gap, handled elsewhere

  const tsFirst = Math.min(...diags.map((d: any) => d.start ?? Infinity));
  const reach = ourReach(msg);
  if (reach == null) { unknown++; continue; }

  if (reach >= tsFirst - SLACK) {
    agree++;                                    // we got to (or past) TS's first error → right reason
  } else {
    early++;                                    // we bailed on valid code BEFORE the error
    earlies.push({ file: file.replace(baseDir + '/', ''), ourReach: reach, tsFirst, ctx: JSON.stringify(code.slice(Math.max(0, reach - 40), reach + 15)) });
  }
}

console.log(`Single-file error-tests we fail: ${agree + early + unknown}`);
console.log(`  AGREE (reach >= TS first error - ${SLACK}) : ${agree}  ← rejected for the right reason`);
console.log(`  EARLY (bail before TS's error)            : ${early}  ← hidden gap: valid code we can't parse`);
console.log(`  UNKNOWN (no offset in our error)          : ${unknown}`);
if (earlies.length) {
  console.log(`\n===== EARLY (hidden gaps) =====`);
  earlies.sort((a, b) => (a.tsFirst - a.ourReach) - (b.tsFirst - b.ourReach));
  for (const e of earlies) console.log(`  ${e.file}\n      ours@${e.ourReach} vs TS@${e.tsFirst} (gap ${e.tsFirst - e.ourReach})  near ${e.ctx}`);
}
