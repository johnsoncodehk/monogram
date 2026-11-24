// treesitter-assertions.ts — the zero-width assertions (`not`, `sameLine`, `noCommentBefore`,
// `noMultilineFlowBefore`, `notLeftLeaf`) of every token-stream grammar, and what its generated
// tree-sitter grammar does with each. A CFG has no lookahead: gen-treesitter renders an assertion
// exactly only where a rewrite exists (`lowered`) and otherwise drops it to `blank()`. The drop is
// exact when FIRST/FOLLOW prove the assertion always holds where the CFG reaches it (`vacuous`); every
// other class is a place where the generated grammar may accept MORE than the grammar. The ledger
// comes from the generator itself (`generateTreeSitter(...).assertions`, decided beside the
// rendering), so nothing is dropped without a record.
//
// The pinned counts are the record: a change that raises a dropped or inexact count fails; a change that
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

const CLASSES: AssertionClass[] = ['lowered', 'vacuous', 'reserved-set', 'scanner', 'reserved', 'lookahead1', 'lookahead', 'left-context'];
// Rendered into grammar.js (every other class is dropped to blank()).
const RENDERED: AssertionClass[] = ['lowered', 'reserved-set'];

// Pinned on master 5a6c557 (editor lane, tree-sitter item 1a: the ledger made visible; no rendering change).
// Item 1b: reserved-word guards before the word token render as tree-sitter reserved word sets
// (js / jsx 41 of 43, ts / tsx 63 of 65; the two left are `not("new")` / `not("super")`, sets that
// are no subset of the chain).
// Item 2: the line-end alternatives (`asi()`: its `not(sameLine)` and `not(not("}"))` arms) and the
// `sameLine` items render as zero-width external tokens (planZeroWidth): js 41, jsx 43, ts 131, tsx 133
// lowered (every scanner-class assertion of js / jsx); the 6 `sameLine` left in ts / tsx are the ones
// whose AFTER meets their CONT.
// `new` callees take every MemberExpression form (land/shape-newtarget): NewTarget's identifier arm
// carries the expression NUD's guards (`not('super')`, `not('new')`: reserved +2; the reserved-word
// guard: reserved-set +5, rendered) and its async function arms their `sameLine` (lowered +2); in
// TypeScript a plain decorator is not `@new` (`not('@new')`: lookahead1 +1).
// A class heritage is a LeftHandSideExpression with NewTarget as its base (land/shape-class-heritage):
// the heritage's own reserved-guarded identifier arm is NewTarget's (reserved-set -1); JavaScript's
// six `not('extends')` list guards are gone with its list (lookahead1 -6); in TypeScript one
// `sameLine` moves from lowered to scanner (lowered -1, scanner +1).
// Positive lookaheads render as FIRST-filtered copies (planFirstFilters): TypeScript's `not(not(Decorator))`
// is exact (lookahead1 -1, lowered +1); `export`'s declaration start and the decorated `export default?
// class` render too, but leave out the expression statement's Pratt corner, so they stay inexact.
// The expression identifier refuses every reserved word (land/shape-ident-reserved): the
// `not('super')` / `not('new')` beside its reserved-word guard (Expr and NewTarget) are gone, those
// words now in the guard's set (reserved -4; the set stays rendered).
// JavaScript's phase imports (land/shape-test262-valid): the phase call's `( AssignmentExpression ,opt )` has
// ImportCall's two `not('...')` (lookahead1 +2), and `import source x` / `import defer * as x` bind a
// BindingIdentifier (reserved-set +2). A LegacyNumber is a MemberName but no member start (`memberStart`, shared
// with TypeScript; in a class, strict code, it is an early error anyway), so ClassMember's two member-start
// lookaheads are no longer vacuous (vacuous -2, lookahead1 +2).
// A negative lookahead at an alternative's start renders as a zero-width start marker before the
// other alternatives that can start as it excludes (planStartMarkers: the expression statement's,
// the concise body's, the for heads', TypeScript's `constructor` member and module reference string):
// js / jsx lowered +10 (lookahead1 -6, lookahead -4), ts / tsx lowered +12 (lookahead1 -8, lookahead -4).
// `[no LineTerminator here]` after `yield` (both arms) and in the `using` / `await using` declarations
// (the statement's, and the for heads' ForDeclaration, used by `for` and `for await`): each a `sameLine`
// tree-sitter does not express: js / jsx lowered +8, ts / tsx lowered +10 (TypeScript's decorated
// declaration has its own `using` arm).
const PINNED: Record<string, Partial<Record<AssertionClass, number>>> = {
  javascript:      { lowered: 61,  vacuous: 4,  'reserved-set': 47, scanner: 0,  reserved: 0, lookahead1: 15, lookahead: 4 },
  typescript:      { lowered: 155, vacuous: 60, 'reserved-set': 67, scanner: 7,  reserved: 0, lookahead1: 80, lookahead: 65, 'left-context': 2 },
  javascriptreact: { lowered: 63,  vacuous: 4,  'reserved-set': 47, scanner: 0,  reserved: 0, lookahead1: 15, lookahead: 4 },
  typescriptreact: { lowered: 157, vacuous: 60, 'reserved-set': 67, scanner: 7,  reserved: 0, lookahead1: 80, lookahead: 65, 'left-context': 2 },
  yaml:            { lowered: 1,  scanner: 16, lookahead1: 6 },
};

const count = (rs: AssertionRecord[]) => {
  const out: Partial<Record<AssertionClass, number>> = {};
  for (const r of rs) out[r.cls] = (out[r.cls] ?? 0) + 1;
  return out;
};
const dropped = (c: Partial<Record<AssertionClass, number>>) => CLASSES.filter(k => !RENDERED.includes(k)).reduce((s, k) => s + (c[k] ?? 0), 0);
const inexact = (c: Partial<Record<AssertionClass, number>>) =>
  CLASSES.filter(k => !EXACT_ASSERTION_CLASSES.includes(k)).reduce((s, k) => s + (c[k] ?? 0), 0);

const showRules = process.argv.includes('--rules');
const showList = process.argv.includes('--list');
const summary: string[] = ['### tree-sitter: zero-width assertions per grammar', '',
  '`lowered` and `reserved-set` are rendered; `lowered` and `vacuous` are exact. Every other class is dropped and the generated grammar may accept more than the grammar (the class names the lowering that would make it exact); `reserved-set` is exact except in parse states shared with a less reserved word position. Gate: `test/treesitter-assertions.ts`.', '',
  `| grammar | ${CLASSES.join(' | ')} | dropped | inexact |`, `|---|${CLASSES.map(() => '---:').join('|')}|---:|---:|`];
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
  console.log(`${ok ? '✓' : '✗'} ${name}: ${records.length} assertion(s), ${dropped(got)} dropped, ${inexact(got)} inexact (${fmt(got)})`);
  if (!ok) {
    const rose = inexact(got) > inexact(pinned) || dropped(got) > dropped(pinned) || diffs.some(k => !EXACT_ASSERTION_CLASSES.includes(k) && !RENDERED.includes(k) && (got[k] ?? 0) > (pinned[k] ?? 0));
    console.log(`    pinned: ${fmt(pinned)}${rose ? ' (a change ADDED inexact drops)' : ' (update the pinned counts)'}`);
  }
  if (showList) for (const r of [...records].sort((a, b) => CLASSES.indexOf(a.cls) - CLASSES.indexOf(b.cls))) console.log(`    ${r.cls.padEnd(12)} ${r.rule}: ${r.text}`);
  summary.push(`| ${name} | ${CLASSES.map(k => got[k] ?? 0).join(' | ')} | ${dropped(got)} | ${inexact(got)} |`);
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
