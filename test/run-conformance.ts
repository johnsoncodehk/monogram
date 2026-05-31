import { createParser } from '../src/gen-parser.ts';
import { readdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';

const grammar = (await import('../typescript.ts')).default;
const { parse } = createParser(grammar);

const baseDir = '/tmp/ts-repo/tests/cases/conformance';

async function getAllTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await getAllTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const files = await getAllTsFiles(baseDir);
files.sort();

let passed = 0;
let failed = 0;
const failures: { file: string; msg: string }[] = [];

for (const file of files) {
  const code = readFileSync(file, 'utf-8');
  try {
    parse(code);
    passed++;
  } catch (e: any) {
    failed++;
    failures.push({ file: file.replace(baseDir + '/', ''), msg: e.message.slice(0, 150) });
  }
}

console.log(`${passed}/${files.length} passed (${(passed/files.length*100).toFixed(1)}%)`);
console.log(`${failed} failures\n`);

// Group by error token
const byToken = new Map<string, number>();
for (const f of failures) {
  const m = f.msg.match(/unexpected '(.+?)'/);
  const tok = m ? m[1] : 'other';
  byToken.set(tok, (byToken.get(tok) || 0) + 1);
}
console.log('By error token:');
for (const [tok, count] of [...byToken.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tok}: ${count}`);
}

// Show first few failures per token type
if (process.argv.includes('--detail')) {
  for (const [tok] of [...byToken.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`\n--- ${tok} failures ---`);
    const tokFailures = failures.filter(f => {
      const m = f.msg.match(/unexpected '(.+?)'/);
      return (m ? m[1] : 'other') === tok;
    });
    for (const f of tokFailures.slice(0, 5)) {
      console.log(`  ${f.file}: ${f.msg}`);
    }
  }
}
