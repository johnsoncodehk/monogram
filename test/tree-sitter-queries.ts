// ─────────────────────────────────────────────────────────────────────────────
//  tree-sitter-queries.ts — every generated tree-sitter query file compiles against its grammar.
//  For each tree-sitter/<lang>/ package, loads the wasm built from it and compiles every
//  queries/*.scm with web-tree-sitter's Query: a query naming a node type or field the grammar
//  does not have, or a malformed pattern, throws. Before this gate only typescript's
//  highlights.scm was compiled (by test/tree-sitter-bench.ts); the other grammars' queries were
//  committed unchecked. Needs every wasm built (CI `treesitter` job builds them all).
//  Run: node test/tree-sitter-queries.ts
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readdirSync, readFileSync } from 'node:fs';

// Query files known not to compile, with the reason. Expected-fail: the gate fails if one of
// these starts compiling (drop its entry in the same commit) or if any other file fails.
const KNOWN_BAD: Record<string, string> = {
};

const { Parser, Language, Query } = await import('web-tree-sitter');
await Parser.init();

let ok = 0, fail = 0, xfail = 0;
for (const lang of readdirSync('tree-sitter').sort()) {
  const dir = `tree-sitter/${lang}`;
  if (!existsSync(`${dir}/grammar.js`)) continue;
  const wasm = `${dir}/tree-sitter-${lang}.wasm`;
  if (!existsSync(wasm)) { fail++; console.log(`✗ ${lang}: ${wasm} not built`); continue; }
  const language = await Language.load(wasm);
  const qdir = `${dir}/queries`;
  for (const f of existsSync(qdir) ? readdirSync(qdir).filter(f => f.endsWith('.scm')).sort() : []) {
    const id = `${lang}/queries/${f}`;
    const known = KNOWN_BAD[id];
    try {
      const q = new Query(language, readFileSync(`${qdir}/${f}`, 'utf8'));
      if (known) { fail++; console.log(`✗ ${id} NOW COMPILES: drop its KNOWN_BAD entry`); }
      else { ok++; console.log(`✓ ${id}: ${q.patternCount()} patterns, ${q.captureNames.length} capture names`); }
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      if (known) { xfail++; console.log(`· ${id}: expected-fail (${known}): ${msg}`); }
      else { fail++; console.log(`✗ ${id}: ${msg}`); }
    }
  }
}
console.log(`\n${ok} compile, ${xfail} expected-fail, ${fail} failing${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
