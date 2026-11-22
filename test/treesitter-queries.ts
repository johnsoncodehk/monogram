// ─────────────────────────────────────────────────────────────────────────────
//  treesitter-queries.ts — every generated tree-sitter query file compiles against its grammar.
//  For each tree-sitter/<lang>/ package, loads the wasm built from it and compiles every
//  queries/*.scm with web-tree-sitter's Query: a query naming a node type or field the grammar
//  does not have, or a malformed pattern, throws. Before this gate only typescript's
//  highlights.scm was compiled (by test/treesitter-bench.ts); the other grammars' queries were
//  committed unchecked. Needs every wasm built (CI `treesitter` job builds them all).
//  Run: node test/treesitter-queries.ts
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const { Parser, Language, Query } = await import('web-tree-sitter');
await Parser.init();

let ok = 0, fail = 0;
for (const lang of readdirSync('tree-sitter').sort()) {
  const dir = `tree-sitter/${lang}`;
  if (!existsSync(`${dir}/grammar.js`)) continue;
  const wasm = `${dir}/tree-sitter-${lang}.wasm`;
  if (!existsSync(wasm)) { fail++; console.log(`✗ ${lang}: ${wasm} not built`); continue; }
  const language = await Language.load(wasm);
  const qdir = `${dir}/queries`;
  for (const f of existsSync(qdir) ? readdirSync(qdir).filter(f => f.endsWith('.scm')).sort() : []) {
    try {
      const q = new Query(language, readFileSync(`${qdir}/${f}`, 'utf8'));
      ok++; console.log(`✓ ${lang}/queries/${f}: ${q.patternCount()} patterns, ${q.captureNames.length} capture names`);
    } catch (e) { fail++; console.log(`✗ ${lang}/queries/${f}: ${(e as Error).message.split('\n')[0]}`); }
  }
}
console.log(`\n${ok}/${ok + fail} query files compile${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
