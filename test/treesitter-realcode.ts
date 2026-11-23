// treesitter-realcode.ts — REPORT-ONLY: the derived tree-sitter JavaScript and TypeScript grammars on
// REAL sources, against the interpreter. For every file the interpreter accepts: does tree-sitter
// report an ERROR / MISSING node; for each such file, the keyword the first ERROR node starts with (or
// holds first): the word a keyword-as-name reading would have to accept, as a histogram.
// Sources (all reachable on CI after `npm ci`): JavaScript: the npm / corepack bundled with node,
// node_modules' JavaScript (yaml, parse5, entities, acorn, typescript/lib); TypeScript:
// typescript/lib/*.d.ts, the repository's src/**/*.ts, test/*.ts and grammar files.
// Build the wasms first (as test/treesitter-jsx.ts). Run: node test/treesitter-realcode.ts
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createParser } from '../src/gen-parser.ts';
import { collectLiterals } from '../src/grammar-utils.ts';

const MAX = 3_000_000;   // bytes: the largest file read (typescript.js is ~9 MB: skipped)
const walk = (dir: string, re: RegExp, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '.git') walk(p, re, out); }
    else if (re.test(e.name) && statSync(p).size <= MAX) out.push(p);
  }
  return out;
};
const nodeLib = join(dirname(process.execPath), '..', 'lib', 'node_modules');
const SOURCES: Record<string, string[]> = {
  javascript: [
    ...walk(join(nodeLib, 'npm'), /\.js$/), ...walk(join(nodeLib, 'corepack'), /\.js$/),
    ...['yaml', 'parse5', 'entities', 'acorn'].flatMap(p => walk(`node_modules/${p}`, /\.js$/)),
    ...walk('node_modules/typescript/lib', /\.js$/),
  ],
  typescript: [
    ...walk('node_modules/typescript/lib', /\.d\.ts$/), ...walk('src', /\.ts$/), ...walk('test', /^[^.]+\.ts$/),
    ...readdirSync('.').filter(f => /^[a-z]+\.ts$/.test(f)),
  ],
};

const { Parser, Language } = await import('web-tree-sitter');
await Parser.init();
const firstError = (root: any): any => {
  const stack = [root];
  let best: any = null;
  while (stack.length) {
    const x = stack.pop();
    if (x.type === 'ERROR' || x.isMissing) { if (!best || x.startIndex < best.startIndex) best = x; continue; }
    if (x.hasError) stack.push(...x.children);
  }
  return best;
};
const lines: string[] = [];
for (const [lang, files] of Object.entries(SOURCES)) {
  const wasm = `tree-sitter/${lang}/tree-sitter-${lang}.wasm`;
  if (!existsSync(wasm)) { console.error(`✗ ${wasm} not found`); process.exitCode = 1; continue; }
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  const grammar = (await import(`../${lang}.ts`)).default;
  const interp = createParser(grammar);
  const keywords = new Set<string>();
  for (const r of grammar.rules) for (const l of collectLiterals(r.body)) if (/^[A-Za-z_$][\w$]*$/.test(l)) keywords.add(l);
  let accepted = 0, rejected = 0, tsError = 0, bytes = 0;
  const byWord = new Map<string, string[]>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    try { interp.parse(src); } catch { rejected++; continue; }
    accepted++; bytes += src.length;
    const tree = parser.parse(src)!;
    if (!tree.rootNode.hasError) continue;
    tsError++;
    const e = firstError(tree.rootNode);
    // The keyword the error is about: the first keyword-shaped word of the ERROR node's text, else
    // the word right before it (a MISSING node or an ERROR that starts after the keyword it follows).
    const text = src.slice(e.startIndex, Math.min(e.endIndex, e.startIndex + 200));
    let w = (text.match(/[A-Za-z_$][\w$]*/g) ?? []).find(x => keywords.has(x));
    if (!w) { const before = src.slice(Math.max(0, e.startIndex - 60), e.startIndex).match(/[A-Za-z_$][\w$]*/g) ?? []; w = [...before].reverse().find(x => keywords.has(x)); }
    const k = w ?? '(no keyword)';
    const at = src.slice(0, e.startIndex).split('\n').length;
    (byWord.get(k) ?? byWord.set(k, []).get(k)!).push(`${f}:${at} ${JSON.stringify(src.slice(Math.max(0, e.startIndex - 30), e.startIndex + 50))}`);
    tree.delete();
  }
  lines.push(`#### ${lang}: ${files.length} files, interpreter accepts ${accepted} (${(bytes / 1e6).toFixed(1)} MB), rejects ${rejected}; tree-sitter ERROR on ${tsError} of the accepted`, '',
    '| keyword at the first ERROR | files | first example |', '|---|---:|---|',
    ...[...byWord].sort((a, b) => b[1].length - a[1].length).map(([k, xs]) => `| ${k} | ${xs.length} | \`${xs[0].replace(/`/g, "'").replace(/\|/g, '\\|')}\` |`), '');
  for (const [k, xs] of byWord) for (const x of xs) console.log(`  ${lang} ${k}: ${x}`);
}
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### tree-sitter on real sources (report-only)\n\n${lines.join('\n')}\n`);
