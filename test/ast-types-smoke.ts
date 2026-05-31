// Smoke test for src/gen-ast-types.ts.
//
//  1. Generate the typed-CST source from the real TypeScript grammar.
//  2. Write it to a temp `.ts` file.
//  3. Write a consumer module that (a) imports the generated types, (b) does an
//     exhaustive `switch (node.rule)` proving the discriminated union narrows
//     and is complete (a `never` assertion in `default`), and (c) narrows a
//     leaf on `tokenType`.
//  4. Type-check BOTH with `tsc --noEmit --strict`. A non-empty diagnostic =
//     the generated types are wrong (or not exhaustive) → fail.
//  5. Also assert a few structural facts about the generated string directly.
//
// Run: `node test/ast-types-smoke.ts`. (This file lives under test/, which the
// project tsconfig excludes, so it does not affect `npx tsc --noEmit` for src.)

import { generateAstTypes } from '../src/gen-ast-types.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse as parsePath } from 'node:path';

const grammar = (await import('../typescript.ts')).default;

// Resolve the workspace `tsc` so the temp dir uses the same compiler. Walk up
// from the cwd — under a git worktree, node_modules lives in the parent repo.
function resolveTsc(): string {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, 'node_modules', '.bin', 'tsc');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || dir === parsePath(dir).root) break;
    dir = parent;
  }
  return 'tsc'; // fall back to PATH
}
const tscBin = resolveTsc();

let fail = 0;
const check = (label: string, cond: boolean) => {
  if (cond) console.log('  ok  ', label);
  else { fail++; console.log('  FAIL', label); }
};

// ── 1. Generate ──
const src = generateAstTypes(grammar);

// ── 5. Direct structural assertions on the generated text ──
check('emits a CstNode discriminated union', /export type CstNode =/.test(src));
check('emits a TokenType union', /export type TokenType =/.test(src));
check('emits a RuleName union', /export type RuleName =/.test(src));
check('emits NodeOf<R> helper', /export type NodeOf<R extends RuleName>/.test(src));

// Every declared rule gets an interface with a literal `rule` discriminant.
const missingRule = grammar.rules.find(
  r => !src.includes(`export interface ${r.name}Node `) || !src.includes(`rule: '${r.name}'`),
);
check('every grammar rule has a <Rule>Node interface + literal rule', missingRule === undefined);

// Synthetic leaf token types are present in the TokenType union.
for (const t of ['$keyword', '$punct', '$operator', '$templateHead', '$templateMiddle', '$templateTail']) {
  check(`TokenType includes ${t}`, src.includes(`'${t}'`));
}
// Declared token names are present too.
check('TokenType includes a declared token (Ident)', src.includes("'Ident'"));

// The grammar has a template token → a `$template` node interface should exist.
check('emits $templateNode (grammar has a template token)', src.includes("rule: '$template'"));

// ── 2/3/4. Type-check the generated types + a consumer ──
const dir = mkdtempSync(join(tmpdir(), 'monogram-ast-types-'));
const typesPath = join(dir, 'cst-types.ts');
const consumerPath = join(dir, 'consumer.ts');
const tsconfigPath = join(dir, 'tsconfig.json');

writeFileSync(typesPath, src);

// Pick a few real rule names from the grammar to exercise narrowing.
const ruleSample = grammar.rules.slice(0, 3).map(r => r.name);

// Consumer: exhaustive switch over EVERY rule (built from the grammar so it
// stays complete as the grammar grows), plus explicit narrowing on a couple of
// sampled rules and a leaf. If the union is missing a member, the per-case
// access fails; if it has an EXTRA member we don't handle, the `default`
// `never` assignment fails — both prove the union is exactly right.
const allRuleNames = [
  '$template',
  ...grammar.rules.map(r => r.name),
];
const cases = allRuleNames.map(name =>
  `    case '${name}': { const _c: CstNode = node; void _c; return node.children.length; }`,
).join('\n');

const consumer = `import type { CstNode, CstLeaf, NodeOf, RuleName, TokenType } from './cst-types.ts';

// (a) Exhaustive switch on the \`rule\` discriminant: narrows, and \`default\`
// proves completeness via a \`never\` assignment.
export function childCount(node: CstNode): number {
  switch (node.rule) {
${cases}
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

// (b) NodeOf<R> narrows the union to one rule's node.
function sampleNarrowing(n: CstNode) {
  ${ruleSample.map((r, i) => `if (n.rule === '${r}') { const x${i}: NodeOf<'${r}'> = n; void x${i}; }`).join('\n  ')}
}
void sampleNarrowing;

// (c) A RuleName value is assignable from a literal in the union.
const someRule: RuleName = '${ruleSample[0]}';
void someRule;

// (d) Leaf narrowing on tokenType.
function leafText(leaf: CstLeaf): string {
  if (leaf.tokenType === '$keyword') return leaf.text;
  const t: TokenType = leaf.tokenType;
  void t;
  return leaf.text;
}
void leafText;
`;
writeFileSync(consumerPath, consumer);

writeFileSync(tsconfigPath, JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
  },
  include: ['cst-types.ts', 'consumer.ts'],
}, null, 2));

let tscOut = '';
let tscOk = true;
try {
  execFileSync(tscBin, ['--noEmit', '-p', tsconfigPath], { stdio: 'pipe' });
} catch (e: any) {
  tscOk = false;
  tscOut = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`;
}
check('generated types + exhaustive-switch consumer type-check under tsc --strict', tscOk);
if (!tscOk) {
  console.log('\n--- tsc diagnostics ---\n' + tscOut + '\n--- generated source ---\n' + src + '\n--- consumer ---\n' + consumer);
}

// Negative control: a bogus rule literal must NOT be assignable to RuleName,
// confirming RuleName is a closed union (not widened to `string`).
const badConsumerPath = join(dir, 'bad.ts');
writeFileSync(badConsumerPath, `import type { RuleName } from './cst-types.ts';
const bad: RuleName = '___definitely_not_a_rule___';
void bad;
`);
writeFileSync(join(dir, 'tsconfig.bad.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'Node16', moduleResolution: 'Node16',
    allowImportingTsExtensions: true, noEmit: true, strict: true, skipLibCheck: true,
  },
  include: ['cst-types.ts', 'bad.ts'],
}, null, 2));
let bogusRejected = false;
try {
  execFileSync(tscBin, ['--noEmit', '-p', join(dir, 'tsconfig.bad.json')], { stdio: 'pipe' });
} catch {
  bogusRejected = true; // tsc errored → the bogus literal was correctly rejected
}
check('RuleName is a closed union (rejects an unknown rule literal)', bogusRejected);

rmSync(dir, { recursive: true, force: true });

console.log(
  fail === 0
    ? `\n${grammar.rules.length} rules typed; all AST-type smoke checks pass`
    : `\n${fail} FAILED`,
);
process.exit(fail === 0 ? 0 : 1);
