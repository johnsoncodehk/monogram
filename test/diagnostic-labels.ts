// Gate: human-readable LABELS for `$missing` diagnostics.
//
// The emitted engine's "expected X" messages name what a required position was missing. By
// default X is the raw grammar name (a token `NUM` reads as `expected 'NUM'`, a rule `Value`
// as `expected Value`), which is fine for a language whose grammar names are already words but
// leaks internal identifiers (`DEC_VALUE_TEXT`) to end users of any real editor. `token(p,
// { label })` and `rule(fn, { label })` substitute a display string in exactly those messages
// and NOWHERE else: leaf `tokenType`s, `ruleNameOf`, the CST, and every other artifact keep
// the grammar name, so a grammar that adds labels parses byte-identically.
//
// Run with: node test/diagnostic-labels.ts
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitParser, jsTarget } from '../src/emit.ts';
import { createParser } from '../src/gen-parser.ts';
import { objectify } from './emitted-obj.ts';
import { token, rule, defineGrammar, many, opt, plus, oneOf, range } from '../src/api.ts';
import { generateTmLanguage } from '../src/gen-tm.ts';
import { generateTreeSitter } from '../src/gen-treesitter.ts';
import { generateLanguageConfig } from '../src/gen-vscode-config.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { if (cond) ok++; else { fail++; console.log('  ✗', label); } };

type Diag = { offset: number; end: number; message: string };

function build(labelled: boolean) {
  const WS = token(plus(oneOf(' ', '\t')), { skip: true });
  const IDENT = token(plus(oneOf(range('a', 'z'))), { identifier: true });
  const NUM = token(plus(oneOf(range('0', '9'))), labelled ? { label: 'a number' } : {});
  const SEMI = token(';', {});
  const Value = rule(() => [[NUM], [IDENT, '(', opt(NUM), ')']], labelled ? { label: 'a value' } : {});
  // `opt('=', Value)`: once the optional group has consumed `=` it is committed, so a missing
  // Value synthesizes a $missing row (the tsc-style rule the engine derives; see TOTAL-PARSING.md).
  const Stmt = rule(() => [[IDENT, opt('=', Value), SEMI]]);
  const Program = rule(() => [[many(Stmt)]]);
  return defineGrammar({ name: 'labels', tokens: { WS, IDENT, NUM, SEMI }, rules: { Value, Stmt, Program }, entry: Program });
}

const plain = build(false);
const labelled = build(true);

// ── 1. defineGrammar carries the labels onto the declarations (and only when given) ──
check('token label lands on TokenDecl', labelled.tokens.find(t => t.name === 'NUM')?.label === 'a number');
check('rule label lands on RuleDecl', labelled.rules.find(r => r.name === 'Value')?.label === 'a value');
check('an unlabelled token has no label', plain.tokens.find(t => t.name === 'NUM')?.label === undefined);
check('an unlabelled rule has no label', plain.rules.find(r => r.name === 'Value')?.label === undefined);

// ── 2. The emitted engine renders labels in `expected …` messages ──
const dir = tmpdir();
async function load(g: ReturnType<typeof build>, tag: string) {
  const file = join(dir, `monogram-labels-${tag}-${process.pid}.ts`);
  writeFileSync(file, emitParser(g, jsTarget));
  const em = await import(file + '?v=' + Date.now());
  return em.createParser() as { parse(s: string): { root: number; errors: Diag[] }; visit(c: unknown, fns: object): void; tree: any };
}
const pp = await load(plain, 'plain');
const pl = await load(labelled, 'labelled');
const msgs = (p: typeof pp, src: string) => p.parse(src).errors.map(e => e.message);

// A required TOKEN missing: `a = 1` (no `;`) and `a = f(` (the `)` is a literal, unaffected).
check("plain: missing named token → expected 'SEMI'", msgs(pp, 'a = 1').includes("expected 'SEMI'"));
check("labelled: unlabelled token keeps the quoted grammar name", msgs(pl, 'a = 1').includes("expected 'SEMI'"));

// A required RULE missing is exercised on the TypeScript grammar below (2b): whether a tiny
// grammar synthesizes the rule or absorbs the statement is the recovery engine's call, not
// this gate's subject.

// A labelled TOKEN missing: `a = f(1` is a literal `)`; use `a = f(` + `;`? The optional NUM never
// synthesizes, so exercise the token label through a grammar position where NUM is required:
{
  const WS = token(plus(oneOf(' ', '\t')), { skip: true });
  const NUM = token(plus(oneOf(range('0', '9'))), { label: 'a number' });
  const Pair = rule(() => [[NUM, ',', NUM]]);
  const Top = rule(() => [[many(Pair)]]);
  const g = defineGrammar({ name: 'labels2', tokens: { WS, NUM }, rules: { Pair, Top }, entry: Top });
  const p = await load(g, 'pair');
  check('labelled: missing token → expected a number (unquoted label)', msgs(p, '1,').includes('expected a number'));
  check("labelled: the quoted raw token name is gone", !msgs(p, '1,').includes("expected 'NUM'"));
}

const tree = (p: typeof pp, src: string) => { const c = p.parse(src); return JSON.stringify(objectify(p.tree, (fns: any) => p.visit(c, fns))); };

// ── 2b. A real grammar: label TypeScript's Expr rule and read `const a = ;` ──
{
  const ts = (await import('../typescript.ts')).default;
  const labelledTs = { ...ts, rules: ts.rules.map((r: any) => r.name === 'Expr' ? { ...r, label: 'an expression' } : r) };
  const p0 = await load(ts as any, 'ts-plain');
  const p1 = await load(labelledTs as any, 'ts-labelled');
  check('typescript: default message is expected Expr', msgs(p0, 'const a = ;').includes('expected Expr'));
  check('typescript: labelled message is expected an expression', msgs(p1, 'const a = ;').includes('expected an expression'));
  check('typescript: labelled tree is byte-identical', tree(p0, 'const a = ;\nfoo(1, [2, 3]);') === tree(p1, 'const a = ;\nfoo(1, [2, 3]);'));
}

// ── 3. Labels change messages ONLY: trees, leaf token types, and literal messages are identical ──
for (const src of ['a = 1;', 'a = f(2);', 'a = ;', 'a = f(', 'a = 1']) {
  check(`byte-identical tree for ${JSON.stringify(src)}`, tree(pp, src) === tree(pl, src));
}
check("literal messages unchanged: expected ')'", msgs(pl, 'a = f(').includes("expected ')'"));
check('related info unchanged', JSON.stringify(pl.parse('a = f(').errors).includes("to match this '('"));
check('valid input has no errors under labels', pl.parse('a = 1; b = f(2);').errors.length === 0);

// ── 3b. Every derived artifact is unaffected: labels are not scopes, captures, or names ──
check('TextMate grammar identical with and without labels', JSON.stringify(generateTmLanguage(plain)) === JSON.stringify(generateTmLanguage(labelled)));
check('tree-sitter output identical with and without labels', JSON.stringify(generateTreeSitter(plain, 'labels')) === JSON.stringify(generateTreeSitter(labelled, 'labels')));
check('language-configuration identical with and without labels', JSON.stringify(generateLanguageConfig(plain)) === JSON.stringify(generateLanguageConfig(labelled)));
check('leaf tokenTypes keep the grammar name (no label leaks into the tree)', tree(pl, 'a = 1;').includes('"tokenType":"NUM"') && !tree(pl, 'a = 1;').includes('a number'));

// ── 4. The interpreter is unaffected (it has no expected-X diagnostics to label) ──
const interp = createParser(labelled);
let threw = '';
try { interp.parse('a = ;'); } catch (e) { threw = (e as Error).message; }
check('interpreter still rejects with its own message', threw.startsWith('Parse error at offset'));

console.log(`\n${ok}/${ok + fail} diagnostic-label checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
