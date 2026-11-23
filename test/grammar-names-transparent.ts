// Gate `grammar-names`: grammar NAMES (`arm` / `field`, src/api.ts) are transparent to parsing,
// and the shared deriver (src/grammar-names.ts) reads them.
//   1. api: test/fixtures/namedcalc.ts (calc with every arm and child named) lowers to exactly
//      calc's rules plus the names; every emitted parser is byte-identical to calc's; the
//      interpreter's CSTs are identical; gen-cst-match names the arms and captures as written.
//   2. every node: javascript.ts and typescript.ts with a DIFFERENT name on every node (arms,
//      branches and every other node, in memory) emit byte-identical parsers for every target.
//   3. the deriver: a repeated derived name is suffixed and reported; an author-written name is
//      never suffixed; two equal written names in one scope are an error.
//   4. the portable IR carries the names (src/emit-portable.ts, Step NAMES): an rd rule's
//      `altNames`, a Pratt rule's `nudNames` / `ledNames` / `ledLeftNames` / `postfixTokNames` /
//      `opNames`, a step's `field`, an inline alternation's `branchNames`, each the deriver's; with
//      them dropped, the IR of a named grammar equals the unnamed one's.
import { createHash } from 'node:crypto';
import { emitParser } from '../src/target.ts';
import { jsTarget } from '../src/emit-parser.ts';
import { tsTarget } from '../src/target-ts.ts';
import { goTarget } from '../src/target-go.ts';
import { rustTarget } from '../src/target-rust.ts';
import { createParser } from '../src/gen-parser.ts';
import { generateCstMatch } from '../src/gen-cst-match.ts';
import { nameReport, nameRule } from '../src/grammar-names.ts';
import { portableIR, type RdRule, type PrattRule, type Step } from '../src/emit-portable.ts';
import type { CstGrammar, RuleExpr } from '../src/types.ts';
import { rule, alt, arm, field, defineGrammar, token, many, opt, seq, range, star } from '../src/api.ts';
import calc from './fixtures/calc.ts';
import namedCalc from './fixtures/namedcalc.ts';

let failed = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${what}${ok || !detail ? '' : `\n    ${detail.slice(0, 600)}`}`);
  if (!ok) failed++;
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const TARGETS = { ts: tsTarget, js: jsTarget, go: goTarget, rust: rustTarget } as const;

const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === 'arm' || k === 'field' ? undefined : x)));
const countNames = (v: unknown): number => { let n = 0; JSON.stringify(v, (k, x) => { if (k === 'arm' || k === 'field') n++; return x; }); return n; };

// ── 1. the api fixture ──
check(countNames(namedCalc.rules) === 12, 'namedcalc carries its 12 written names', String(countNames(namedCalc.rules)));
check(JSON.stringify(strip(namedCalc)) === JSON.stringify(strip(calc)), 'namedcalc lowers to calc plus names (nothing else differs)');
for (const [t, target] of Object.entries(TARGETS)) {
  const a = emitParser(calc, target), b = emitParser(namedCalc, target);
  check(a === b, `calc ${t} parser byte-identical with names (${sha(a)})`, `${sha(a)} vs ${sha(b)}`);
}
{
  const p0 = createParser(calc), p1 = createParser(namedCalc);
  const inputs = ['let x = 1;', '1 + 2 * 3;', '-(a - b) / c;', 'let y = -x; y * (y + 1);', ''];
  check(inputs.every((s) => JSON.stringify(p0.parse(s)) === JSON.stringify(p1.parse(s))), 'calc interpreter CSTs identical with names');
}
{
  const m = generateCstMatch(namedCalc);
  check(/arm: "parenthesized"/.test(m) && /arm: "letDeclaration"/.test(m) && /binding/.test(m) && /initializer/.test(m),
    'gen-cst-match uses the written arm and capture names');
  const n = nameRule(namedCalc.rules.find((r) => r.name === 'Stmt')!);
  check(JSON.stringify(n.arms.map((a) => [a.name, a.origin, a.children.map((c) => c.name)])) === JSON.stringify([['letDeclaration', 'authored', ['binding', 'initializer']], ['expression', 'authored', ['expression']]]),
    'grammar-names: Stmt arms and children as written', JSON.stringify(n.arms));
}

// ── 2. a different name on every node of the real grammars ──
function nameEverything(g: CstGrammar): CstGrammar {
  let k = 0;
  const visit = (e: RuleExpr): RuleExpr => {
    const named: RuleExpr = { ...e, field: `f${k++}` } as RuleExpr;
    if (named.type === 'alt' || named.type === 'seq') (named as { items: RuleExpr[] }).items = named.items.map((x) => ({ ...visit(x), arm: `a${k++}` }) as RuleExpr);
    if ('body' in named && named.body) (named as { body: RuleExpr }).body = visit(named.body);
    if (named.type === 'sep') (named as { element: RuleExpr }).element = visit(named.element);
    if (named.type === 'group' && named.tsRelaxed) (named as { tsRelaxed: RuleExpr }).tsRelaxed = visit(named.tsRelaxed);
    return named;
  };
  return { ...g, rules: g.rules.map((r) => ({ ...r, body: visit(r.body) })) } as CstGrammar;
}
for (const name of ['javascript', 'typescript']) {
  const g = (await import(`../${name}.ts`)).default as CstGrammar;
  const named = nameEverything(g);
  check(countNames(named.rules) > 1000, `${name}: every node named in memory (${countNames(named.rules)} names)`);
  for (const [t, target] of Object.entries(TARGETS)) {
    const a = emitParser(g, target), b = emitParser(named, target);
    check(a === b, `${name} ${t} parser byte-identical with a name on every node (${sha(a)})`, `${sha(a)} vs ${sha(b)}`);
  }
}

// ── 4. the names in the portable IR ──
const IR_NAMES = new Set(['field', 'branchNames', 'altNames', 'nudNames', 'ledNames', 'ledLeftNames', 'postfixTokNames', 'opNames']);
const irSyntax = (g: CstGrammar): string => JSON.stringify(portableIR(g), (k, v) => (IR_NAMES.has(k) ? undefined : v));
const stepFields = (steps: readonly Step[]): string[] => steps.flatMap((s): string[] => {
  const own = s.field !== undefined ? [s.field] : [];
  switch (s.t) {
    case 'star': return [...own, ...stepFields([s.step])];
    case 'sep': return [...own, ...stepFields([s.elem])];
    case 'opt': case 'seq': case 'suppress': case 'ctx': return [...own, ...stepFields(s.steps)];
    case 'alt': return [...own, ...s.branches.flatMap(stepFields)];
    default: return own;
  }
});
{
  const ir = portableIR(namedCalc);
  const stmt = ir.rules.find((r) => r.name === 'Stmt') as RdRule, expr = ir.rules.find((r) => r.name === 'Expr') as PrattRule;
  const program = ir.rules.find((r) => r.name === 'Program') as RdRule;
  check(JSON.stringify(stmt.altNames) === '["letDeclaration","expression"]' && JSON.stringify(stmt.alts.map(stepFields)) === '[["binding","initializer"],["expression"]]',
    'IR: Stmt altNames and step fields as written', JSON.stringify([stmt.altNames, stmt.alts.map(stepFields)]));
  check(JSON.stringify(program.altNames) === '["program"]' && JSON.stringify(stepFields(program.alts[0]!)) === '["statement"]',
    'IR: a named child inside many()', JSON.stringify([program.altNames, stepFields(program.alts[0]!)]));
  check(JSON.stringify(expr.nudNames) === '["number","name","parenthesized","prefixOp"]' && JSON.stringify(expr.opNames) === '{"binary":"binaryOp","prefix":"prefixOp","postfix":"postfixOp"}'
    && JSON.stringify(expr.nudBrackets.map((b) => stepFields(b.steps))) === '[["expression"]]',
    'IR: Expr NUD arm names (the prefix arm by its operator form), operator forms, a bracket arm\'s field', JSON.stringify([expr.nudNames, expr.opNames]));
  check(irSyntax(namedCalc) === irSyntax(calc), 'IR: namedcalc with its names dropped equals calc');
}
{
  const Id = token(seq(range('a', 'z'), star(range('a', 'z'))), { identifier: true });
  const R = rule(() => [['x', alt(arm('one', 'a', Id), arm('two', 'b', Id)), opt('else', field('alternate', Id))]]);
  const r = portableIR(defineGrammar({ name: 'n6', tokens: { Id }, rules: { R } })).rules[0] as RdRule;
  const a = r.alts[0]!.find((s) => s.t === 'alt');
  check(a?.t === 'alt' && JSON.stringify(a.branchNames) === '["one","two"]' && a.field === 'alt' && JSON.stringify(stepFields(r.alts[0]!)) === '["alt","id","id","elseTok","alternate"]',
    'IR: an inline alternation\'s branchNames and field; the elseTok anchor on its literal', JSON.stringify(r.alts[0]));
}
for (const name of ['javascript', 'typescript']) {
  const g = (await import(`../${name}.ts`)).default as CstGrammar;
  const ir = portableIR(g);
  const rd = ir.rules.filter((r): r is RdRule => r.kind === 'rd'), pr = ir.rules.filter((r): r is PrattRule => r.kind === 'pratt');
  const full = rd.every((r) => r.altNames.length === r.alts.length)
    && pr.every((r) => r.nudNames.length === r.nudOrder.length && r.ledNames.length === r.leds.length && r.ledLeftNames.length === r.leds.length && r.postfixTokNames.length === r.postfixToks.length);
  const fields = [...rd.flatMap((r) => r.alts.flatMap(stepFields)), ...pr.flatMap((r) => [...r.nudSeqs, ...r.nudBrackets.map((b) => b.steps), ...r.leds.map((b) => b.steps)].flatMap(stepFields))];
  check(full, `${name}: IR arm names parallel to every arm list`);
  check(fields.length > 300, `${name}: the IR carries the deriver's child names (${fields.length} step fields)`);
  check(irSyntax(nameEverything(g)) === irSyntax(g), `${name}: IR with a name on every node equals the plain IR once names are dropped`);
}

// ── 3. the deriver's rules ──
{
  const Id = token(seq(range('a', 'z'), star(range('a', 'z'))), { identifier: true });
  const R = rule(() => [['x', Id], ['x', Id, Id], arm('pair', 'y', field('left', Id), field('right', Id))]);
  const g = defineGrammar({ name: 'n1', tokens: { Id }, rules: { R } });
  const f = nameReport(g.rules);
  check(JSON.stringify(f.map((x) => [x.kind, x.arm, x.child ?? null, x.name])) === JSON.stringify([['arm', 0, null, 'x'], ['arm', 1, null, 'x2'], ['child', 1, 0, 'id'], ['child', 1, 1, 'id2']]),
    'nameReport: every holder of a repeated derived name (the first one too), nothing written', JSON.stringify(f));
}
{
  const Id = token(seq(range('a', 'z'), star(range('a', 'z'))), { identifier: true });
  const R = rule(() => [arm('same', 'x', Id), arm('same', 'y', Id)]);
  let err = '';
  try { nameRule(defineGrammar({ name: 'n2', tokens: { Id }, rules: { R } }).rules[0]); } catch (e) { err = (e as Error).message; }
  check(/already used/.test(err), 'two equal written arm names in one rule are an error', err);
}
{
  const Id = token(seq(range('a', 'z'), star(range('a', 'z'))), { identifier: true });
  const R = rule(() => [['x', field('id', Id), Id]]);
  let err = '';
  try { nameRule(defineGrammar({ name: 'n3', tokens: { Id }, rules: { R } }).rules[0]); } catch (e) { err = (e as Error).message; }
  check(/equals an author-written name/.test(err), 'a derived name equal to a written one in its scope is an error (name it too)', err);
}
for (const bad of ['arguments', 'eval']) {
  // A name is a local of the generated destructurers (a module: strict mode), so no strict-mode
  // binding may be one.
  const Id = token(seq(range('a', 'z'), star(range('a', 'z'))), { identifier: true });
  const R = rule(() => [['x', field(bad, Id)]]);
  let err = '';
  try { nameRule(defineGrammar({ name: 'n4', tokens: { Id }, rules: { R } }).rules[0]); } catch (e) { err = (e as Error).message; }
  check(/not identifier-safe/.test(err), `a written name \`${bad}\` is an error (no strict-mode binding has it)`, err);
}
{
  const Id = token(seq(range('a', 'z'), star(range('a', 'z'))), { identifier: true });
  const R = rule(() => [['x', alt(arm('one', 'a', Id), arm('two', 'b', Id)), opt('else', field('alternate', Id)), many(field('item', Id))]]);
  const n = nameRule(defineGrammar({ name: 'n4', tokens: { Id }, rules: { R } }).rules[0]);
  const bs = [...n.branches.values()][0]!;
  check(JSON.stringify(bs.map((b) => b.name)) === '["one","two"]' && JSON.stringify(n.arms[0]!.children.map((c) => c.name)) === '["alt","alternate","elseTok","item"]',
    'written branch names, a written child inside opt / many, the derived elseTok anchor', JSON.stringify([bs.map((b) => b.name), n.arms[0]!.children]));
}
{
  let err = '';
  try { field('a', field('b', 'x') as never); defineGrammar({ name: 'n5', tokens: {}, rules: { R: rule(() => [[field('a', field('b', 'x'))]]) } }); } catch (e) { err = (e as Error).message; }
  check(/already named/.test(err), 'one item cannot carry two field names', err);
}

if (failed) { console.error(`✗ grammar-names: ${failed} check(s) failed`); process.exit(1); }
console.log('✓ grammar names are transparent to every parser and read by the shared deriver');
