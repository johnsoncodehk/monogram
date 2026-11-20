// ─────────────────────────────────────────────────────────────────────────────
//  treesitter-bench.ts — the tree-sitter accuracy GATE (CI-runnable).
//
//  Monogram's derived tree-sitter highlighter is the strongest thesis proof: the
//  SAME grammar that drives the parser also drives a real GLR parser + query, and
//  it must beat the official hand-written tree-sitter grammar. This used to be an
//  opt-in number quoted in the README; this turns it into a gate.
//
//  It grades two engines at the token-FAMILY level against the neutral tsc oracle
//  over the documented-bug corpus (test/issue-cases.ts) — NO TextMate, no official
//  TextMate grammar needed (so it runs on a bare runner):
//    • Monogram (tree-sitter, derived) — loaded from a wasm built off the generated
//      tree-sitter/typescript/ package (see the CI job / README).
//    • official tree-sitter            — from the @vscode/tree-sitter-wasm package.
//
//  Gate: Monogram ≥ FLOOR and Monogram ≥ official. Build the wasm first:
//    cd tree-sitter/typescript && npx tree-sitter generate && npx tree-sitter build --wasm
//    MONOGRAM_TS_WASM=tree-sitter/typescript/tree-sitter-typescript.wasm node test/treesitter-bench.ts
// ─────────────────────────────────────────────────────────────────────────────
import ts from 'typescript';
import { existsSync } from 'node:fs';
import { oracle } from './oracle.ts';
import { ROLE_SPEC, roleFamily, acceptableFamilies } from './scope-roles.ts';
import { loadTreeSitter, treesitterFamilies, loadMonogramTreeSitter, monogramTreesitterFamilies, monogramTreesitterCaptures, familyAt } from './highlight-engines.ts';
import { tests as issueTests, multiLineTests as issueMultiLine } from './issue-cases.ts';

const WASM = process.env.MONOGRAM_TS_WASM ?? 'tree-sitter/typescript/tree-sitter-typescript.wasm';
const QUERY = process.env.MONOGRAM_TS_QUERY ?? 'tree-sitter/typescript/queries/highlights.scm';

if (!existsSync(WASM)) {
  console.error(`✗ Monogram tree-sitter wasm not found at ${WASM}\n  Build it: cd tree-sitter/typescript && npx tree-sitter generate && npx tree-sitter build --wasm`);
  process.exit(1);
}

const offOk = await loadTreeSitter();
if (!offOk) { console.error('✗ failed to load official tree-sitter (node_modules/@vscode/tree-sitter-wasm)'); process.exit(1); }
const monoOk = await loadMonogramTreeSitter(WASM, QUERY);
if (!monoOk) { console.error(`✗ failed to load Monogram tree-sitter wasm (${WASM})`); process.exit(1); }

const corpus = [
  ...issueTests.map((t) => t.input),
  ...issueMultiLine.map((t) => t.lines.join('\n')),
];

// Grade one engine's token-FAMILY classification against the tsc oracle.
function score(spansOf: (code: string) => { start: number; end: number; family: string }[]): { correct: number; total: number } {
  let correct = 0, total = 0;
  for (const text of corpus) {
    const sf = ts.createSourceFile('c.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (((sf as any).parseDiagnostics?.length ?? 0) > 0) continue; // grade only valid inputs
    let gold; try { gold = oracle(text); } catch { continue; }
    let spans; try { spans = spansOf(text); } catch { spans = []; }
    for (const g of gold) {
      if (ROLE_SPEC[g.role].tier === 'lexical' || roleFamily(g.role) === 'punct') continue;
      const ok = acceptableFamilies(g.role);
      total++;
      const fam = familyAt(spans, g.start);
      if (fam && ok.has(fam)) correct++;
    }
  }
  return { correct, total };
}

const mono = score(monogramTreesitterFamilies);
const off = score(treesitterFamilies);
const pct = (x: { correct: number; total: number }) => (x.correct / x.total) * 100;
const monoPct = pct(mono), offPct = pct(off);

console.log('── tree-sitter token-family accuracy vs the tsc oracle (issue-cases corpus) ──');
console.log(`  Monogram (derived)    ${monoPct.toFixed(1)}%  (${mono.correct}/${mono.total})`);
console.log(`  official tree-sitter  ${offPct.toFixed(1)}%  (${off.correct}/${off.total})`);

// Gate: a conservative floor (catch regressions) AND must still beat official.
const FLOOR = 90;
const fails: string[] = [];

// Word roles. The family grade above cannot see a builtin name painted as a plain variable
// (@variable.builtin and @variable are both 'value'), so the capture itself is checked here, with
// the node it lands on. A `scopes` builtin name (support.variable) keeps @variable.builtin
// wherever the word is lexed as an identifier, also when the grammar uses the same word as a
// keyword elsewhere (`module`, `global`, `require`); where it IS the keyword (an anonymous node
// of that text), the keyword's own capture applies.
const WORD_ROLES: { code: string; word: string; node: string; capture: string }[] = [
  { code: 'x = console.log;', word: 'console', node: 'ident', capture: 'variable.builtin' },   // a builtin that is no keyword
  { code: 'x = module.exports;', word: 'module', node: 'ident', capture: 'variable.builtin' },
  { code: 'f(module);', word: 'module', node: 'ident', capture: 'variable.builtin' },
  { code: 'x = global.y;', word: 'global', node: 'ident', capture: 'variable.builtin' },
  { code: 'const x = require("y");', word: 'require', node: 'ident', capture: 'variable.builtin' },
  { code: 'x = require("y");', word: 'require', node: 'ident', capture: 'variable.builtin' },
  { code: 'declare module "m" {}', word: 'module', node: 'module', capture: 'keyword' },        // storage.type.namespace
  { code: 'declare global {}', word: 'global', node: 'global', capture: 'variable.builtin' },   // its one scope, as the keyword token
  // The import-equals `require (` is the keyword token; its one scope is support.variable.
  { code: 'import r = require("x");', word: 'require', node: 'require', capture: 'variable.builtin' },
  { code: 'export import r = require("x");', word: 'require', node: 'require', capture: 'variable.builtin' },
];
console.log('── tree-sitter word roles (winning capture per word, and its node) ──');
for (const r of WORD_ROLES) {
  const at = r.code.indexOf(r.word);
  const end = at + r.word.length;
  const hit = monogramTreesitterCaptures(r.code).filter((s) => s.start === at && s.end === end).at(-1);
  const got = hit ? `${hit.node} @${hit.capture}` : '(none)';
  const want = `${r.node} @${r.capture}`;
  const ok = got === want;
  console.log(`  ${ok ? '✓' : '✗'} ${JSON.stringify(r.code).padEnd(34)} ${r.word.padEnd(8)} ${got}${ok ? '' : `  (want ${want})`}`);
  if (!ok) fails.push(`${JSON.stringify(r.code)}: \`${r.word}\` is ${got}, want ${want}`);
}
if (monoPct < FLOOR) fails.push(`Monogram ${monoPct.toFixed(1)}% below floor ${FLOOR}%`);
if (monoPct < offPct) fails.push(`Monogram ${monoPct.toFixed(1)}% no longer beats official ${offPct.toFixed(1)}%`);
if (fails.length) {
  console.error('\n✗ ' + fails.join('; '));
  process.exit(1);
}
console.log(`\n✓ tree-sitter gate: Monogram ${monoPct.toFixed(1)}% ≥ floor ${FLOOR}% and beats official ${offPct.toFixed(1)}%`);
