// Collects the tree-sitter `conflicts` tuples each grammar declares in `treeSitterConflicts`.
//
// This grammar is highly ambiguous, so tree-sitter needs an explicit `conflicts` entry
// for every LR(1) state it can't resolve alone. The standard authoring loop is: run
// `tree-sitter generate`, read its "Add a conflict for these rules: …" suggestion, add
// it, repeat to a fixpoint. This script automates that loop for EVERY derived grammar
// (CI only builds the typescript + html tree-sitters, so tsx/js/jsx conflicts would
// otherwise go unnoticed) and prints, per grammar, the tuples to add to its
// `treeSitterConflicts` and the declared tuples tree-sitter reports as unnecessary.
//
// Run after a grammar change that makes `npm run gate:treesitter` fail to generate:
//   node test/collect-conflicts.ts
// then update the named grammar's `treeSitterConflicts` (a JSX-only tuple belongs to the
// JSX layer in javascriptreact.ts) and re-run `npm run gen`.
// It restores each grammar.js afterwards, so it never leaves the tree dirty.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const tsDir = `${root}tree-sitter`;
const langs = readdirSync(tsDir).filter(l => existsSync(`${tsDir}/${l}/grammar.js`));
const missing = new Map<string, string[][]>();
const unnecessary = new Map<string, string[][]>();

for (const lang of langs) {
  const dir = `${tsDir}/${lang}`;
  const gj = `${dir}/grammar.js`;
  const backup = readFileSync(gj, 'utf8');
  const found: string[][] = [];
  try {
    for (let i = 0; i < 80; i++) {
      const r = spawnSync('npx', ['tree-sitter', 'generate'], { cwd: dir, encoding: 'utf8' });
      const out = `${r.stdout}\n${r.stderr}`;
      if (r.status === 0) {
        // Generates cleanly — no (more) missing conflicts. Any "unnecessary conflicts" warning lists
        // one tuple per line, so the declaration can be trimmed to what the table actually uses.
        const block = out.split(/unnecessary conflicts:/)[1];
        if (block) {
          const tuples: string[][] = [];
          for (const line of block.split('\n').slice(1)) {
            const names = [...line.matchAll(/`([a-z0-9_]+)`/g)].map(x => x[1]);
            if (!names.length) break;
            tuples.push(names);
          }
          unnecessary.set(lang, tuples);
        }
        break;
      }
      const m = out.match(/Add a conflict for these rules:\s*([^\n]+)/);
      if (!m) {
        // Not a conflict — e.g. yaml's generated grammar.js is not loadable by
        // tree-sitter (a pre-existing gen-treesitter regex-emission issue, and yaml's
        // tree-sitter is neither built nor gated). Skip it rather than dump a trace.
        const why = /Failed to load grammar|SyntaxError/.test(out) ? 'grammar.js not loadable' : 'unparseable generate error';
        console.error(`[${lang}] skipped — ${why}`);
        break;
      }
      const rules = [...m[1].matchAll(/`([a-z0-9_]+)`/g)].map(x => x[1]);
      if (!rules.length) break;
      found.push(rules);
      const src = readFileSync(gj, 'utf8').replace(
        /conflicts:\s*\$\s*=>\s*\[/,
        mm => `${mm}\n    [${rules.map(r => `$.${r}`).join(', ')}],`,
      );
      writeFileSync(gj, src);
    }
  } finally {
    writeFileSync(gj, backup); // discovery must not dirty the tree
  }
  if (found.length) missing.set(lang, found);
  console.error(`[${lang}] ${found.length} missing conflict tuple(s)`);
}

const fmt = (t: string[]) => `[${t.map(r => `'${r}'`).join(', ')}],`;
if (missing.size === 0 && unnecessary.size === 0) {
  console.log('\n✓ every derived tree-sitter grammar generates, and declares no unnecessary conflict.');
}
for (const [lang, ts] of missing) {
  console.log(`\n// ${lang}: add to treeSitterConflicts`);
  for (const t of ts) console.log(`  ${fmt(t)}`);
}
for (const [lang, ts] of unnecessary) {
  console.log(`\n// ${lang}: tree-sitter reports these declared tuples as unnecessary`);
  for (const t of ts) console.log(`  ${fmt(t)}`);
}
