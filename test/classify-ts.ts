import { createParser } from '../src/gen-parser.ts';
import { readdir, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

const grammar = (await import('../examples/typescript.ts')).default;
const { parse } = createParser(grammar);
const baseDir = '/tmp/ts-repo/tests/cases/conformance';

async function getAllTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await getAllTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

// Count syntactic parse diagnostics for a chunk of TS source.
function syntaxErrors(text: string, name = 't.ts'): number {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return (sf as any).parseDiagnostics?.length ?? 0;
}

// Split TS conformance file by `// @filename:` directives.
function splitMultiFile(text: string): string[] {
  if (!/^\s*\/\/\s*@filename:/im.test(text)) return [text];
  const parts: string[] = [];
  const re = /^\s*\/\/\s*@filename:.*$/gim;
  let last = 0, m: RegExpExecArray | null, started = false;
  const idxs: number[] = [];
  while ((m = re.exec(text))) idxs.push(m.index);
  if (idxs.length === 0) return [text];
  // preamble before first @filename (global directives) — ignore as its own chunk
  for (let i = 0; i < idxs.length; i++) {
    const start = idxs[i];
    const end = i + 1 < idxs.length ? idxs[i + 1] : text.length;
    parts.push(text.slice(start, end));
  }
  return parts;
}

const files = await getAllTsFiles(baseDir);
files.sort();

interface Row { file: string; ourMsg: string; tsWhole: number; tsParts: number; multi: boolean; }
const rows: Row[] = [];

for (const file of files) {
  const code = readFileSync(file, 'utf-8');
  let ourFail = false, ourMsg = '';
  try { parse(code); } catch (e: any) { ourFail = true; ourMsg = e.message.replace(/\s*\[farthest.*/, ''); }
  if (!ourFail) continue;

  const path = file.replace(baseDir + '/', '');
  const tsWhole = syntaxErrors(code);
  const parts = splitMultiFile(code);
  const multi = parts.length > 1;
  const tsParts = multi ? parts.reduce((a, p) => a + syntaxErrors(p), 0) : tsWhole;
  rows.push({ file: path, ourMsg, tsWhole, tsParts, multi });
}

// Categories:
//  REAL: TS reports 0 syntax errors (on parts if multi, else whole) -> we should parse
//  MULTI: multi-file, parts clean but whole dirty (concatenation issue, structural)
//  ERRORTEST: TS reports syntax errors -> intentional
const real = rows.filter(r => !r.multi && r.tsWhole === 0);
const multiClean = rows.filter(r => r.multi && r.tsParts === 0);
const multiDirty = rows.filter(r => r.multi && r.tsParts > 0);
const errorTest = rows.filter(r => !r.multi && r.tsWhole > 0);

const out: string[] = [];
out.push(`Total our failures: ${rows.length}`);
out.push(`REAL (TS clean, single-file)         : ${real.length}`);
out.push(`MULTI-CLEAN (parts clean, concat fails): ${multiClean.length}`);
out.push(`MULTI-DIRTY (multi-file w/ syntax err) : ${multiDirty.length}`);
out.push(`ERROR-TEST (TS reports syntax error)   : ${errorTest.length}`);
out.push('');
out.push('===== REAL (should fix) =====');
for (const r of real) out.push(`  ${r.file}\n      ${r.ourMsg}`);
out.push('');
out.push('===== MULTI-CLEAN (structural, @filename concat) =====');
for (const r of multiClean) out.push(`  ${r.file}\n      ${r.ourMsg}`);
out.push('');
out.push('===== MULTI-DIRTY (has intentional errors in some part) =====');
for (const r of multiDirty) out.push(`  ${r.file} (tsParts=${r.tsParts})`);

const text = out.join('\n');
await writeFile('/tmp/classify.txt', text);
console.log(text.split('\n').slice(0, 6).join('\n'));
console.log('\nFull report: /tmp/classify.txt');
