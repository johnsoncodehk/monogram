// treesitter-assertions.ts — the zero-width assertions (`not`, `sameLine`, `noCommentBefore`,
// `noMultilineFlowBefore`, `notLeftLeaf`) of every token-stream grammar, and what its generated
// tree-sitter grammar does with each. A CFG has no lookahead: gen-treesitter renders an assertion
// exactly only where a rewrite exists (`lowered`) and otherwise drops it to `blank()`. The drop is
// exact when FIRST/FOLLOW prove the assertion always holds where the CFG reaches it (`vacuous`); every
// other class is a place where the generated grammar may accept MORE than the grammar. The ledger
// comes from the generator itself (`generateTreeSitter(...).assertions`, decided beside the
// rendering), so nothing is dropped without a record.
//
// The pinned counts are the record: a change that raises an inexact count fails; a change that
// lowers one must lower the pinned number in the same commit (the record moves with the generator).
// Exact counts (`lowered`, `vacuous`) are pinned too, so a reclassification is visible.
//   node test/treesitter-assertions.ts           check against the pinned counts
//   node test/treesitter-assertions.ts --rules   also print the per-rule table
//   node test/treesitter-assertions.ts --list    also print every assertion with its class
// With GITHUB_STEP_SUMMARY set, the per-grammar and per-rule tables go to the job summary.
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateTreeSitter, EXACT_ASSERTION_CLASSES, type AssertionClass, type AssertionRecord } from '../src/gen-treesitter.ts';
import type { CstGrammar } from '../src/types.ts';

const CLASSES: AssertionClass[] = ['lowered', 'vacuous', 'scanner', 'reserved', 'lookahead1', 'lookahead', 'left-context'];

// Pinned on master f732d9d + this gate (item 1a of the editor lane's tree-sitter queue).
const PINNED: Record<string, Partial<Record<AssertionClass, number>>> = {
  javascript: {},
  typescript: {},
  javascriptreact: {},
  typescriptreact: {},
  yaml: {},
};

const count = (rs: AssertionRecord[]) => {
  const out: Partial<Record<AssertionClass, number>> = {};
  for (const r of rs) out[r.cls] = (out[r.cls] ?? 0) + 1;
  return out;
};
const inexact = (c: Partial<Record<AssertionClass, number>>) =>
  CLASSES.filter(k => !EXACT_ASSERTION_CLASSES.includes(k)).reduce((s, k) => s + (c[k] ?? 0), 0);

const showRules = process.argv.includes('--rules');
const showList = process.argv.includes('--list');
const summary: string[] = ['### tree-sitter: zero-width assertions per grammar', '',
  'Only `lowered` is rendered and `vacuous` drops are proven exact; every other class is dropped and the generated grammar may accept more than the grammar (the class names the lowering that would make it exact). Gate: `test/treesitter-assertions.ts`.', '',
  `| grammar | ${CLASSES.join(' | ')} | inexact |`, `|---|${CLASSES.map(() => '---:').join('|')}|---:|`];
const perRule: string[] = [];
let bad = 0;
for (const [name, pinned] of Object.entries(PINNED)) {
  const grammar = (await import(resolve(`${name}.ts`))).default as CstGrammar;
  const records = generateTreeSitter(grammar, name).assertions;
  const got = count(records);
  const diffs = CLASSES.filter(k => (got[k] ?? 0) !== (pinned[k] ?? 0));
  const ok = diffs.length === 0;
  if (!ok) bad++;
  const fmt = (c: Partial<Record<AssertionClass, number>>) => CLASSES.map(k => `${k} ${c[k] ?? 0}`).join(', ');
  console.log(`${ok ? '✓' : '✗'} ${name}: ${records.length} assertion(s), ${inexact(got)} inexact (${fmt(got)})`);
  if (!ok) {
    const rose = inexact(got) > inexact(pinned) || diffs.some(k => !EXACT_ASSERTION_CLASSES.includes(k) && (got[k] ?? 0) > (pinned[k] ?? 0));
    console.log(`    pinned: ${fmt(pinned)}${rose ? ' (a change ADDED inexact drops)' : ' (update the pinned counts)'}`);
  }
  if (showList) for (const r of [...records].sort((a, b) => CLASSES.indexOf(a.cls) - CLASSES.indexOf(b.cls))) console.log(`    ${r.cls.padEnd(12)} ${r.rule}: ${r.text}`);
  summary.push(`| ${name} | ${CLASSES.map(k => got[k] ?? 0).join(' | ')} | ${inexact(got)} |`);
  const byRule = new Map<string, AssertionRecord[]>();
  for (const r of records) { const k = `${r.rule} (${r.kind})`; if (!byRule.has(k)) byRule.set(k, []); byRule.get(k)!.push(r); }
  const rows = [...byRule].map(([k, rs]) => ({ k, c: count(rs) })).sort((a, b) => inexact(b.c) - inexact(a.c) || a.k.localeCompare(b.k));
  perRule.push('', `<details><summary>${name}: per rule</summary>`, '', `| rule (assertion) | ${CLASSES.join(' | ')} |`, `|---|${CLASSES.map(() => '---:').join('|')}|`);
  for (const { k, c } of rows) {
    perRule.push(`| ${k} | ${CLASSES.map(x => c[x] ?? 0).join(' | ')} |`);
    if (showRules) console.log(`    ${k}: ${CLASSES.filter(x => c[x]).map(x => `${x} ${c[x]}`).join(', ')}`);
  }
  perRule.push('', '</details>');
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, [...summary, ...perRule, ''].join('\n') + '\n');
console.log(bad ? `\n${bad} grammar(s) differ from the pinned record` : '\nassertion ledger matches the record ✓');
if (bad) process.exit(1);
