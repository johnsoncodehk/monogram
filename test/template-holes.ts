// Gate: the rule that parses a template's `${…}` holes is DECLARED at the template reference.
//
// A template token (`template: { open, interpOpen, interpClose }`) says how a template is
// tokenized; which rule parses its holes is a fact of each REFERENCE, because one token can
// serve two productions (TypeScript's template-literal expression and template-literal type).
// A bare reference takes the grammar's `expression` rule; `withHoles(token, rule)` names
// another. defineGrammar writes the answer on the reference (RuleExpr ref.hole) and every engine
// reads it from there — none infers it from the rule a reference happens to be reached through,
// from rule order, or from a rule's name.
//
// The fixture is built so that each inference the engines used to make gives a wrong answer:
//   - `Ty` is declared BEFORE `Ex`               (first Pratt / first recursive rule = Ty)
//   - `Callee` is left-recursive and holds a template     (innermost recursive rule = Callee)
//   - the type rule is not named `Type`                    (no rule name to key on)
//
// Run with: node test/template-holes.ts
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser } from '../src/gen-parser.ts';
import { emitParser, jsTarget, tsTarget, goTarget } from '../src/emit.ts';
import { generateTreeSitter } from '../src/gen-treesitter.ts';
import {
  token, rule, defineGrammar, left, op, seq, oneOf, range, star, plus, many,
  altPattern, noneOf, notFollowedBy, withHoles, awaitCtx, reservableNot, alt,
} from '../src/api.ts';
import type { CstGrammar, RuleExpr } from '../src/types.ts';
import { asGoMain } from './go-main.ts';
import { objectify } from './emitted-obj.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { if (cond) ok++; else { fail++; console.log('  ✗', label); } };
const thrown = (f: () => unknown): string => { try { f(); return ''; } catch (e) { return (e as Error).message; } };

const WS = token(plus(oneOf(' ', '\t', '\n')), { skip: true });
const Ident = token(seq(oneOf(range('a', 'z'), range('A', 'Z')), star(oneOf(range('a', 'z'), range('A', 'Z')))), { identifier: true });
const Num = token(plus(range('0', '9')));
const Template = token(
  seq('`', star(altPattern(noneOf('`', '\\', '$'), seq('\\', noneOf('\n')), seq('$', notFollowedBy('{')))), '`'),
  { template: { open: '`', interpOpen: '${', interpClose: '}' } },
);

// Ty: identifiers, `T[]`, `A | B`, and a template whose holes are types.
// Ex: identifiers, numbers, `a + b`, `x as Ty`, `new Callee`, `async(e)` (an await context), and
//     a template whose holes are expressions.
// Callee: a left-recursive member chain that may hold a template (its holes are expressions).
function fixture() {
  const Ty = rule(($) => [Ident, [$, '[', ']'], [$, '|', $], withHoles(Template, $)]);
  const Callee = rule(($) => [Ident, Template, [$, '.', Ident], [$, Template]]);
  const Ex = rule(($) => [
    // the keywords are not identifiers; inside an await context neither is `await` (the fork
    // extends this guard), so `await` with no operand has no parse there
    [reservableNot(alt('new', 'async', 'type')), Ident],
    Num, Template, [$, op, $], [$, 'as', Ty], [$, Template],
    ['new', Callee], ['async', '(', awaitCtx($), ')'], ['await', $],
  ]);
  const Stmt = rule(() => [['type', Ident, '=', Ty, ';'], [Ex, ';']]);
  const Program = rule(() => [[many(Stmt)]]);
  return defineGrammar({
    name: 'tplholes', tokens: { WS, Ident, Num, Template },
    prec: [left('+')],
    rules: { Ty, Callee, Ex, Stmt, Program }, entry: Program, expression: Ex,
  });
}

// ── 1. The declaration: what defineGrammar writes, and what it refuses ──
{
  const g = fixture();
  const holes = (name: string): string[] => {
    const out: string[] = [];
    const walk = (e: RuleExpr): void => {
      if (e.type === 'ref') { if (e.name === 'Template') out.push(String(e.hole)); return; }
      if (e.type === 'seq' || e.type === 'alt') e.items.forEach(walk);
      else if (e.type === 'quantifier' || e.type === 'not' || e.type === 'group') walk(e.body);
      else if (e.type === 'sep') walk(e.element);
    };
    walk(g.rules.find((r) => r.name === name)!.body);
    return out;
  };
  check('a bare template reference carries the expression rule', holes('Ex').join() === 'Ex,Ex' && holes('Callee').join() === 'Ex,Ex');
  check('a withHoles reference carries the rule it names', holes('Ty').join() === 'Ty');
  const nonTemplateRefs = JSON.stringify(g.rules).match(/"type":"ref","name":"(Ident|Num)","hole"/);
  check('a reference to a token that is not a template carries no hole', nonTemplateRefs === null);

  // No expression rule and no withHoles: there is nothing to parse the holes with.
  const E = rule(($) => [Ident, Template, [$, op, $]]);
  const P = rule(() => [[many(E, ';')]]);
  const noExpr = thrown(() => defineGrammar({ name: 'noexpr', tokens: { WS, Ident, Template }, prec: [left('+')], rules: { E, P }, entry: P }));
  check('a bare template reference without an `expression` rule is rejected', noExpr !== '');
  check('the message names the token', noExpr.includes("'Template'"));
  check('the message names both fixes', noExpr.includes('`expression`') && noExpr.includes('withHoles(Template, rule)'));

  // The same grammar with every reference declaring its own rule needs no `expression`.
  const E2 = rule(($) => [Ident, withHoles(Template, $), [$, op, $]]);
  const P2 = rule(() => [[many(E2, ';')]]);
  check('withHoles on every reference needs no `expression` rule',
    thrown(() => defineGrammar({ name: 'allholes', tokens: { WS, Ident, Template }, prec: [left('+')], rules: { E2, P2 }, entry: P2 })) === '');

  const E3 = rule(($) => [withHoles(Ident, $), [$, op, $]]);
  const P3 = rule(() => [[many(E3, ';')]]);
  const notTpl = thrown(() => defineGrammar({ name: 'nottpl', tokens: { WS, Ident }, prec: [left('+')], rules: { E3, P3 }, entry: P3 }));
  check('withHoles on a token that is not a template is rejected', /not a template token/.test(notTpl) && notTpl.includes('Ident'));

  const Stray = rule(($) => [Ident, [$, op, $]]);
  const E4 = rule(($) => [Ident, withHoles(Template, Stray), [$, op, $]]);
  const P4 = rule(() => [[many(E4, ';')]]);
  check('withHoles naming a rule the grammar does not define is rejected',
    /hole rule is not registered/.test(thrown(() => defineGrammar({ name: 'stray', tokens: { WS, Ident, Template }, prec: [left('+')], rules: { E4, P4 }, entry: P4 }))));
}

// ── 2. Every engine parses each hole with the declared rule ──
// [input, accepted?, the rule names of the hole nodes in source order (when accepted)]
const CASES: [string, boolean, string[]?][] = [
  // expression template: holes are Ex, wherever the template sits
  ['`a${1 + 2}b`;', true, ['Ex']],
  ['tag`a${1 + 2}b${c}`;', true, ['Ex', 'Ex']],
  ['`a${T[]}b`;', false],                       // `T[]` is a type, not an expression
  // type template: holes are Ty
  ['type X = `a${T[]}b`;', true, ['Ty']],
  ['type X = `a${A | B}b${C}`;', true, ['Ty', 'Ty']],
  ['type X = `a${1 + 2}b`;', false],            // `1 + 2` is an expression, not a type
  // a template inside the left-recursive Callee: holes are still Ex, never Callee
  ['new `a${1 + 2}b`;', true, ['Ex']],
  ['new tag`a${1 + 2}b`.c;', true, ['Ex']],
  ['new a.b`x${c}`;', true, ['Ex']],
  ['new `a${T[]}b`;', false],
  // nesting crosses kinds at each reference, both ways
  ['`a${x as `b${T[]}`}c`;', true, ['Ex', 'Ty']],
  ['new `a${x as `b${T[]}`}c`;', true, ['Ex', 'Ty']],
  // the hole inherits the [Await] context of its reference: `await` needs an operand there
  ['async(`a${await b}c`);', true, ['Ex']],
  ['async(new t`a${await b}c`);', true, ['Ex']],
  ['async(`a${await}c`);', false],
  ['`a${await}c`;', true, ['Ex']],               // outside the context `await` is an identifier
];

type Node = { rule?: string; children?: Node[] };
const holeRules = (root: unknown): string[] => {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (!n || !n.children) return;
    if (n.rule === '$template') for (const c of n.children) if (c.rule) out.push(c.rule);
    n.children.forEach(walk);
  };
  walk(root as Node);
  return out;
};

function verify(engine: string, parse: (src: string) => unknown | null) {
  for (const [src, accept, want] of CASES) {
    let root: unknown | null;
    try { root = parse(src); } catch { root = null; }
    if (!accept) { check(`${engine}: rejects ${JSON.stringify(src)}`, root === null); continue; }
    check(`${engine}: accepts ${JSON.stringify(src)}`, root !== null);
    if (root !== null) check(`${engine}: holes of ${JSON.stringify(src)} are [${want!.join(', ')}], got [${holeRules(root).join(', ')}]`, holeRules(root).join() === want!.join());
  }
}

const grammar: CstGrammar = fixture();
const dir = mkdtempSync(join(tmpdir(), 'template-holes-'));

verify('interpreter', createParser(grammar).parse);

{
  const file = join(dir, 'emitted.mts');
  writeFileSync(file, emitParser(grammar, jsTarget));
  const m = await import(file);
  verify('emitted', (src) => { const r = m.parse(src); return objectify(m.tree, (fns) => m.visit(r, fns)); });
}
{
  const file = join(dir, 'portable.ts');
  writeFileSync(file, emitParser(grammar, tsTarget));
  const m = await import(file) as { parse(src: string): unknown | null };
  verify('portable ts', m.parse);
}
const haveGo = (() => { try { execFileSync('go', ['version'], { stdio: 'pipe' }); return true; } catch { return false; } })();
if (haveGo) {
  const gdir = join(dir, 'go'); mkdirSync(gdir);
  writeFileSync(join(gdir, 'parser.go'), asGoMain(emitParser(grammar, goTarget)));
  writeFileSync(join(gdir, 'runner.go'), goTarget.emitRunner?.() ?? '');
  writeFileSync(join(gdir, 'go.mod'), 'module p\n\ngo 1.21\n');
  execFileSync('go', ['build', '-o', join(gdir, 'p'), '.'], { cwd: gdir, stdio: 'pipe' });
  verify('portable go', (src) => {
    const r = spawnSync(join(gdir, 'p'), [], { input: src, encoding: 'utf8' });
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  });
} else {
  console.log('  go: (toolchain absent — skipped)');
}

// ── 3. tree-sitter: one template rule per hole rule, one node kind ──
{
  const js = generateTreeSitter(grammar).grammarJs;
  check('tree-sitter: the expression template re-enters the expression rule', /template_substitution: \$ => seq\("\$\{", \$\.ex, "\}"\)/.test(js));
  check('tree-sitter: the type template re-enters the type rule', /ty_template_substitution: \$ => seq\("\$\{", \$\.ty, "\}"\)/.test(js));
  check('tree-sitter: the type rule references its own template, aliased to the one node kind', js.includes('alias($.ty_template, $.template)'));
  check('tree-sitter: its holes are aliased to the one substitution node kind', js.includes('alias($.ty_template_substitution, $.template_substitution)'));
  const callee = js.split('\n').find((l) => l.trimStart().startsWith('callee:')) ?? '';
  check('tree-sitter: the callee references the expression template', callee.includes('$.template') && !callee.includes('ty_template'));
}

console.log(`template-holes: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
