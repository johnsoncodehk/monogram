// Snapshot/diff harness: tracks exactly which files pass, so grammar changes
// can be evaluated for regressions (pass->fail) as well as wins (fail->pass).
import { createParser } from '../src/gen-parser.ts';
import { readdir, writeFile, readFile } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const grammar = (await import('../typescript.ts')).default;
const { parse } = createParser(grammar);
const baseDir = '/tmp/ts-repo/tests/cases/conformance';
const SNAP = '/tmp/pass-snapshot.json';

async function getAllTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await getAllTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

const files = (await getAllTsFiles(baseDir)).sort();
const passing = new Set<string>();
for (const file of files) {
  const code = readFileSync(file, 'utf-8');
  try { parse(code); passing.add(file.replace(baseDir + '/', '')); } catch {}
}

console.log(`${passing.size}/${files.length} passed (${(passing.size / files.length * 100).toFixed(1)}%)`);

const mode = process.argv[2];
if (mode === 'save') {
  await writeFile(SNAP, JSON.stringify([...passing].sort(), null, 0));
  console.log(`Saved baseline snapshot (${passing.size} passing) to ${SNAP}`);
} else {
  if (!existsSync(SNAP)) { console.log('No baseline snapshot. Run with "save" first.'); process.exit(0); }
  const base = new Set<string>(JSON.parse(await readFile(SNAP, 'utf-8')));
  const regressions = [...base].filter(f => !passing.has(f)).sort();
  const wins = [...passing].filter(f => !base.has(f)).sort();
  console.log(`\nBaseline: ${base.size} passing`);
  console.log(`Net delta: ${passing.size - base.size >= 0 ? '+' : ''}${passing.size - base.size}`);
  console.log(`\nREGRESSIONS (pass->fail): ${regressions.length}`);
  for (const f of regressions) console.log(`  - ${f}`);
  console.log(`\nWINS (fail->pass): ${wins.length}`);
  for (const f of wins) console.log(`  + ${f}`);
}
