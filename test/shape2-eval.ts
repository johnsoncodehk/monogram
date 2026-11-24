// Gate `shape2-eval`: the ShapeSpec v2 reference interpreter (src/shape2-eval.ts) on its calculus
// (src/shape2-schema.ts): every operator evaluated on a small grammar with every name written
// (test/fixtures/namedcalc.ts) and on the JavaScript grammar's expression rules, and every
// load-time rejection: a spec outside the calculus or not typed against the grammar must be
// refused, naming the rule / arm / child.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser, type CstLeaf, type CstNode } from '../src/gen-parser.ts';
import type { CstGrammar } from '../src/types.ts';
import { armNameOf, dependencies, evaluateShape, evaluator, defineShape, ShapeSpecError, ShapeUnmapped, spineOf, type ShapeValue } from '../src/shape2-eval.ts';
import { nodeKeysOf } from '../src/shape2-schema.ts';
import {
  absent, and, armOf, branch, c, child, cook, fold, iff, inh, let_, list, map, match, node, not, or, orElse,
  dropLastIf, get, present, record, spread, syn, text, thread, typeByText, v, wrapIf, type ShapeSpec, type Term,
} from '../src/shape2-schema.ts';
import calc from './fixtures/namedcalc.ts';
import calcExample from './fixtures/shape-namedcalc.ts';
import { freeNodeKeys, shapeCoverage, shapeSkeleton } from '../src/shape-coverage.ts';
import { estreeExprShape } from './fixtures/shape-v2-estree-expr.ts';
import { tscExprShape } from './fixtures/shape-v2-tsc-expr.ts';
import { compareTrees, nestValue, type NTree } from './shape-oracle.ts';
import { normaliseEstree, parseEstree } from './shape-oracle-estree.ts';
import { tscOracle } from './shape-oracle-tsc.ts';
import javascript from '../javascript.ts';
import typescript from '../typescript.ts';
import tsc from 'typescript';

let passed = 0;
const check = (name: string, fn: () => void): void => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n${(e as Error).stack}`); process.exitCode = 1; }
};
const parse = (g: CstGrammar, src: string): CstNode => createParser(g).parse(src);
// The evaluator's value in the harness's nested form (shape-oracle.ts nestValue): the tests below
// read `kind` / `fields` whatever node keys a shape declares.
const nest = (spec: ShapeSpec, v: ShapeValue | undefined): ShapeValue | undefined => (v === undefined ? v : nestValue(v, nodeKeysOf(spec)) as ShapeValue);
const run = (g: CstGrammar, spec: ShapeSpec, src: string): ShapeValue | undefined => nest(spec, evaluateShape(defineShape(g, spec), parse(g, src), src));
const N = (kind: string, start: number, end: number, fields: Record<string, ShapeValue> = {}): ShapeValue => ({ kind, start, end, fields });

// ── The calculus on namedcalc ──

const calcSpec: ShapeSpec = {
  name: 'calc',
  total: true,
  rules: {
    Program: { program: node('Program', { body: child('statement') }) },
    Stmt: {
      letDeclaration: node('Let', { name: text('binding'), init: child('initializer') }),
      expression: node('ExpressionStatement', { expression: child('expression') }),
    },
    Expr: {
      number: node('Num', { value: cook('numberValue', 'number'), raw: text('number') }),
      name: node('Name', { name: text('ident') }),
      parenthesized: child('expression'),                                       // P6: pass-through
      binaryOp: node(typeByText('op', { '+': 'Add', '-': 'Sub', '*': 'Mul', '/': 'Div' }),   // P2
        { left: child('left'), right: child('right') }),
      prefixOp: node('Neg', { operand: child('operand'), operatorAt: node('Op', {}, { from: 'op', to: 'op' }) }),
      postfixOp: absent,
    },
  },
};

check('calc: values, P2 type by operator text, P6 pass-through, spans', () => {
  const src = 'let x = 1 + 2 * -y; (x);';
  assert.deepEqual(run(calc, calcSpec, src), N('Program', 0, 24, {
    body: [
      N('Let', 0, 19, {
        name: 'x',
        init: N('Add', 8, 18, {
          left: N('Num', 8, 9, { value: 1, raw: '1' }),
          right: N('Mul', 12, 18, { left: N('Num', 12, 13, { value: 2, raw: '2' }), right: N('Neg', 16, 18, { operand: N('Name', 17, 18, { name: 'y' }), operatorAt: N('Op', 16, 17) }) }),
        }),
      }),
      N('ExpressionStatement', 20, 24, { expression: N('Name', 21, 22, { name: 'x' }) }),
    ],
  }));
});

check('calc: present / armOf / match / if / and / or / not / orElse / record / list / spread / let / map', () => {
  const spec: ShapeSpec = {
    ...calcSpec,
    // A field named `kind` (L.kind): the node's kind goes under another key.
    node: { kind: 'type' },
    rules: {
      ...calcSpec.rules,
      Program: {
        program: node('P', {
          count: map('statement', armOf('statement')),
          any: present('statement'),
          pair: list(c(1), spread(list(c(2), c(3))), absent),
          rec: record({ a: c('x'), gone: absent }),
          first: let_('s', child('statement'), v('s')),
        }),
      },
      Stmt: {
        letDeclaration: node('L', {
          kind: armOf('initializer'),
          flags: iff(and(c(true), or(c(false), not(c(false)))), c('yes'), c('no')),
          op: match(armOf('initializer'), { binaryOp: text('initializer') }, c('other')),
          dflt: orElse(absent, c(0)),
        }),
        expression: absent,
      },
    },
  };
  assert.deepEqual(run(calc, spec, 'let a = b - 1; c;'), N('P', 0, 17, {
    count: ['letDeclaration', 'expression'],
    any: true,
    pair: [1, 2, 3, null],
    rec: { record: { a: 'x' } },
    first: [N('L', 0, 14, { kind: 'binaryOp', flags: 'yes', op: 'b - 1', dflt: 0 }), null],
  }));
  assert.deepEqual(run(calc, spec, ''), N('P', 0, 0, { count: [], any: false, pair: [1, 2, 3, null], rec: { record: { a: 'x' } }, first: [] }));
});

check('calc: an unmapped arm of a non-total spec throws ShapeUnmapped naming it', () => {
  const spec: ShapeSpec = { name: 'partial', rules: { Program: calcSpec.rules.Program, Stmt: calcSpec.rules.Stmt, Expr: { name: node('Name') } } };
  assert.throws(() => run(calc, spec, '1;'), (e) => e instanceof ShapeUnmapped && e.rule === 'Expr' && e.arm === 'number');
});

check('calc: an inherited attribute set by a constant and passed on by a copy; its dependencies', () => {
  const spec: ShapeSpec = {
    name: 'inh', total: true,
    inherited: { mode: { type: 'string', default: 'statement', rules: { Stmt: { letDeclaration: { initializer: c('init') } }, Expr: { parenthesized: { expression: inh('mode') } } } } },
    rules: { ...calcSpec.rules, Expr: { ...calcSpec.rules.Expr, name: node('Name', { name: text('ident'), mode: inh('mode') }) } },
  };
  assert.deepEqual(run(calc, spec, 'let a = ((x)); y;'), N('Program', 0, 17, {
    body: [N('Let', 0, 14, { name: 'a', init: N('Name', 10, 11, { name: 'x', mode: 'init' }) }), N('ExpressionStatement', 15, 17, { expression: N('Name', 15, 16, { name: 'y', mode: 'statement' }) })],
  }));
  const deps = dependencies(defineShape(calc, spec));
  assert.deepEqual(deps['Expr.name'], { inherited: ['mode'] });            // reads it
  assert.deepEqual(deps['Expr.parenthesized'], { inherited: ['mode'] });   // copies it to a child that reads it
  assert.deepEqual(deps['Stmt.letDeclaration'], { inherited: [] });       // hands a constant: context-free
  assert.deepEqual(deps['Expr.binaryOp'], { inherited: [] });
});

// Threaded list state: the only construct by which a node's context depends on its siblings.
const leadSpec: ShapeSpec = {
  ...calcSpec,
  name: 'lead',
  synthesized: { isLet: { type: 'bool', default: false, rules: { Stmt: { letDeclaration: c(true) } } } },
  inherited: {
    lead: { type: 'bool', default: false, rules: { Program: { program: { statement: thread(c(true), 'p', and(v('p'), syn('isLet', 'statement'))) } } } },
  },
  rules: { ...calcSpec.rules, Stmt: { ...calcSpec.rules.Stmt, expression: node('ExpressionStatement', { expression: child('expression'), lead: inh('lead') }) } },
};
type Fields = { fields: Record<string, ShapeValue> };

check('calc: a threaded state across a list (each element sees the state its left siblings made)', () => {
  const src = 'let a = 1; b; let c = 2; d;';
  const body = (run(calc, leadSpec, src) as unknown as { fields: { body: Fields[] } }).fields.body;
  assert.deepEqual(body.map((x) => x.fields.lead), [undefined, true, undefined, false]);
  // the same value for one element evaluated on its own, in the context of its root
  const cst = parse(calc, src);
  const at0 = evaluator(defineShape(calc, leadSpec), cst, src);
  const at = (n: CstNode) => nest(leadSpec, at0(n));
  const stmts: CstNode[] = [];
  const walk = (x: CstNode | CstLeaf): void => { if ('tokenType' in x) return; if (x.rule === 'Stmt') stmts.push(x); x.children.forEach(walk); };
  walk(cst);
  assert.deepEqual(at(stmts[1]), N('ExpressionStatement', 11, 13, { expression: N('Name', 11, 12, { name: 'b' }), lead: true }));
  assert.equal((at(stmts[3]) as unknown as Fields).fields.lead, false);
  // the empty list, a list of one
  assert.deepEqual(run(calc, leadSpec, ''), N('Program', 0, 0, { body: [] }));
  assert.equal((run(calc, leadSpec, 'x;') as unknown as { fields: { body: Fields[] } }).fields.body[0].fields.lead, true);
});

check('calc: dependencies of a thread (the element reads the state; the parent threads it)', () => {
  const deps = dependencies(defineShape(calc, leadSpec));
  assert.deepEqual(deps['Stmt.expression'], { inherited: ['lead'] });
  assert.deepEqual(deps['Program.program'], { inherited: [], threads: [{ attr: 'lead', over: 'statement', reads: ['isLet'] }] });
  assert.deepEqual(deps['Stmt.letDeclaration'], { inherited: [] });
});

// ── The calculus on the JavaScript expression rules ──

const stmtOf = (src: string): CstNode => parse(javascript, src).children[0] as CstNode;
const jsEval = (spec: ShapeSpec, src: string): ShapeValue | undefined => nest(spec, evaluateShape(defineShape(javascript, spec), stmtOf(src), src));

// A left fold (tsc's comma BinaryExpression) and a list (ESTree's SequenceExpression), an inline
// alternation (`.` Ident | PrivateField), named conditional children, the op-form children.
const jsBase: ShapeSpec['rules'] = {
  Expr: {
    ident: node('Id', { name: cook('identifierName', 'ident') }),
    number: node('Num', { value: cook('numberValue', 'number') }),
    string: node('Str', { value: cook('stringValue', 'string') }),
    led_dot: node('Member', { object: child('left'), property: branch('alt', { ident: node('Id', { name: text('ident') }, { from: 'ident', to: 'ident' }), privateField: node('Private', {}, { from: 'privateField', to: 'privateField' }) }) }),
    led_question: node('Cond', { test: child('left'), then: child('then'), otherwise: child('otherwise') }),
    binaryOp: node('Bin', { op: text('op'), left: child('left'), right: child('right') }),
  },
};

check('js: fold over a repetition (left-nested comma), with the iteration scope and spans', () => {
  const spec: ShapeSpec = {
    name: 'fold', rules: {
      ...jsBase,
      Stmt: { expr: fold('rest', child('first'), 'acc', node('Comma', { left: v('acc'), comma: node('Tok', {}, { from: 'comma', to: 'comma' }), right: child('rest') }, { from: 'acc', to: 'rest' })) },
    },
  };
  const src = 'a, b.c, 1;';
  assert.deepEqual(jsEval(spec, src), N('Comma', 0, 9, {
    left: N('Comma', 0, 6, { left: N('Id', 0, 1, { name: 'a' }), comma: N('Tok', 1, 2), right: N('Member', 3, 6, { object: N('Id', 3, 4, { name: 'b' }), property: N('Id', 5, 6, { name: 'c' }) }) }),
    comma: N('Tok', 6, 7),
    right: N('Num', 8, 9, { value: 1 }),
  }));
  assert.deepEqual(jsEval(spec, 'a;'), N('Id', 0, 1, { name: 'a' }));
});

check('js: list / spread / present on a repetition; span over a list child', () => {
  const spec: ShapeSpec = {
    name: 'seq', rules: {
      ...jsBase,
      Stmt: { expr: iff(present('rest'), node('Seq', { expressions: list(child('first'), spread(child('rest'))) }, { from: 'first', to: 'rest' }), child('first')) },
    },
  };
  assert.deepEqual(jsEval(spec, 'x ? 1 : "\\x41", y;'), N('Seq', 0, 17, {
    expressions: [N('Cond', 0, 14, { test: N('Id', 0, 1, { name: 'x' }), then: N('Num', 4, 5, { value: 1 }), otherwise: N('Str', 8, 14, { value: 'A' }) }), N('Id', 16, 17, { name: 'y' })],
  }));
});

// A RECORD-VALUED rule (`get`): ForHead is an interface of the `for` statement, which builds its
// node from the head's fields and its own body.
const forSpec: ShapeSpec = {
  name: 'for', rules: {
    ...jsBase,
    Stmt: {
      expr: child('first'),
      for_: branch('alt', { paren: match(get('head', 'kind'), {
        classic: node('For', { test: orElse(get('head', 'test'), c(null)), body: child('body') }),
        of: node('ForOf', { left: get('head', 'left'), right: get('head', 'right'), body: child('body') }),
      }) }),
    },
    ForHead: {
      classic: record({ kind: c('classic'), test: child('condition'), left: absent, right: absent }),
      of: record({ kind: c('of'), test: absent, left: child('left'), right: child('right') }),
    },
  },
};
check('js: a record-valued rule projected by get (for heads)', () => {
  assert.deepEqual(jsEval(forSpec, 'for (a of b) c;'), N('ForOf', 0, 15, { left: N('Id', 5, 6, { name: 'a' }), right: N('Id', 10, 11, { name: 'b' }), body: N('Id', 13, 14, { name: 'c' }) }));
  assert.deepEqual(jsEval(forSpec, 'for (;;) c;'), N('For', 0, 11, { test: null, body: N('Id', 9, 10, { name: 'c' }) }));
  assert.deepEqual(jsEval(forSpec, 'for (; x;) c;'), N('For', 0, 13, { test: N('Id', 7, 8, { name: 'x' }), body: N('Id', 11, 12, { name: 'c' }) }));
  assert.throws(() => jsEval(forSpec, 'for (a in b) c;'), (e: unknown) => e instanceof ShapeUnmapped && e.rule === 'ForHead' && e.arm === 'in_');
  // A value depends on what its record's fields depend on: nothing here.
  const d = dependencies(defineShape(javascript, forSpec));
  assert.deepEqual(d['ForHead.classic'], { inherited: [] });
  assert.deepEqual(d['Stmt.for_'], { inherited: [] });
});

// ESTree's ChainExpression: an inherited attribute (am I the top of a member / call chain?)
// and a synthesized one (does my chain hold a `?.`?).
const chainSpec: ShapeSpec = {
  name: 'chain',
  synthesized: {
    optional: { type: 'bool', default: false, rules: { Expr: { led_optChain: c(true), led_dot: syn('optional', 'left'), led_paren: syn('optional', 'left') } } },
  },
  inherited: {
    chainTop: { type: 'bool', default: true, rules: { Expr: { led_dot: { left: c(false) }, led_optChain: { left: c(false) }, led_paren: { left: c(false) } } } },
  },
  rules: {
    Stmt: { expr: child('first') },
    Expr: {
      ident: node('Id', { name: text('ident') }),
      paren: child('first'),
      led_dot: wrapIf(and(inh('chainTop'), syn('optional')), 'Chain', 'expression', node('Member', { object: child('left'), optional: c(false) })),
      led_optChain: wrapIf(inh('chainTop'), 'Chain', 'expression', node('Member', { object: child('left'), optional: c(true) })),
      led_paren: wrapIf(and(inh('chainTop'), syn('optional')), 'Chain', 'expression', node('Call', { callee: child('left'), args: child('expr') })),
    },
  },
};

check('js: inherited + synthesized attributes (ChainExpression boundary)', () => {
  const m = (start: number, end: number, object: ShapeValue, optional: boolean): ShapeValue => N('Member', start, end, { object, optional });
  const id = (s: number, n: string): ShapeValue => N('Id', s, s + 1, { name: n });
  assert.deepEqual(jsEval(chainSpec, 'a?.b.c();'), N('Chain', 0, 8, { expression: N('Call', 0, 8, { callee: m(0, 6, m(0, 4, id(0, 'a'), true), false), args: [] }) }));
  assert.deepEqual(jsEval(chainSpec, 'a.b;'), m(0, 3, id(0, 'a'), false));
  // a parenthesis ends a chain: (a?.b).c is a member of a chain
  assert.deepEqual(jsEval(chainSpec, '(a?.b).c;'), m(0, 8, N('Chain', 1, 5, { expression: m(1, 5, id(1, 'a'), true) }), false));
  const deps = dependencies(defineShape(javascript, chainSpec));
  assert.deepEqual(deps['Expr.led_dot'], { inherited: ['chainTop'] });
  assert.deepEqual(deps['Expr.ident'], { inherited: [] });
});

// ESTree's directive prologue by a thread: Program and function bodies, not plain blocks; a
// parenthesised string, a declaration or any other statement ends the run.
check('js: the directive prologue (threaded state, ESTree fixture)', () => {
  const src = `'a'; "b\\n"; ('c'); 'd'; function f() { 'x'; y; 'z'; } { 'no'; } (() => { 'arrow'; });\n'late';`;
  const loaded = estreeExprShape;
  const cst = parse(javascript, src);
  const at0 = evaluator(loaded, cst, src);
  const at = (n: CstNode) => nest(loaded.spec, at0(n));
  const got: [string, ShapeValue | undefined][] = [];
  const walk = (x: CstNode | CstLeaf): void => {
    if ('tokenType' in x) return;
    if (x.rule === 'Stmt' && armNameOf(loaded, x, src) === 'expr' && src[x.offset] !== '(') got.push([src.slice(x.offset, x.end), (at(x) as unknown as Fields).fields.directive]);
    x.children.forEach(walk);
  };
  walk(cst);
  assert.deepEqual(got, [["'a';", 'a'], ['"b\\n";', 'b\\n'], ["'d';", undefined], ["'x';", 'x'], ['y;', undefined], ["'z';", undefined], ["'no';", undefined], ["'arrow';", 'arrow'], ["'late';", undefined]]);
  const deps = dependencies(loaded);
  assert.deepEqual(deps['Stmt.expr'].inherited, ['prologue']);
  assert.deepEqual(deps['Block.brace'], { inherited: ['functionBody'], threads: [{ attr: 'prologue', over: 'stmt', reads: ['directive'] }] });
  assert.deepEqual(deps['Program.decl'], { inherited: [], threads: [{ attr: 'prologue', over: 'alt', reads: ['directive'] }] });
});

// Functions, arrows and parameters in both shapes, against their oracles: every form (plain,
// generator, async, async generator; expression and declaration; arrow with a list, one
// identifier, a block or an expression body; default and rest parameters; tsc's `this`
// parameter and optional parameter, and a declaration with no body). A function is a function of
// its own subtree in both shapes: only a body's prologue (ESTree) reads context.
check('functions, arrows and parameters (both fixtures, against acorn and tsc)', () => {
  const js = `function f(a, b = 1, ...c) { return a; }\nasync function* g() { 'use strict'; }\nx = function () {};\ny = async function h(a) {};\nz = (a, b) => a + b;\nw = async x => { 'd'; };\nv = async (a) => a;\nu = q => q;\nfunction* k(x) { yield x; }\n`;
  const ts = `${js}function t(this) {}\nfunction o(a?, b = 2) {}\nfunction ov(a);\n`;
  for (const [g, spec, src, oracle] of [
    [javascript, estreeExprShape.spec, js, () => normaliseEstree(parseEstree(js)!.tree)],
    [typescript, tscExprShape.spec, ts, () => { const r = tscOracle(ts, 'a.ts'); return 'tree' in r ? r.tree : assert.fail(JSON.stringify(r)); }],
  ] as const) {
    // The root's own extent and its end-of-file leaf are not compared (shape2-oracle.ts ROOT_NOT_COMPARED).
    const root = (t: NTree): NTree => ({ kind: t.kind, start: 0, end: 0, fields: Object.fromEntries(Object.entries(t.fields).filter(([k]) => k !== 'sourceType' && k !== 'endOfFileToken')) });
    assert.deepEqual(compareTrees(root(oracle()), root(run(g, spec, src) as NTree), 1).divergences, [], spec.name);
    const deps = dependencies(defineShape(g, spec));
    for (const a of ['function_', 'generator', 'asyncFunction', 'asyncGenerator', 'arrow', 'asyncArrow', 'arrowIdentifier', 'asyncArrowIdentifier']) assert.deepEqual(deps[`Expr.${a}`]?.inherited ?? [], [], `${spec.name} Expr.${a}`);
  }
});

// Binding patterns in both shapes, against their oracles: object and array patterns in variable
// declarations, parameters, catch and for heads; shorthand with a default, identifier / string /
// number / computed keys, nested patterns, rest; array holes, with the final hole dropped by
// `dropLastIf` (`[h,]`, `[,]`, `[i,,]`, `[]`) and, in tsc, each hole an OmittedExpression at the
// end of the token before it (`{ after }`).
check('binding patterns (both fixtures, against acorn and tsc)', () => {
  const js = 'var {a, b: c, d = 1, ...r} = x, [e, , f = 2, ...g] = y, [h,] = z, [,] = w, [i,,] = q, [, , j] = q, {"s": t, [k]: m, 0: n} = o, [] = p, [[u], {v: [w2 = 3]}] = s, {} = e;\n'
    + 'function f([a, b] = q, {c} = q, ...[d]) {}\ntry {} catch ({message}) {}\nfor (const [k, v] of m);\nfor (let {a} = b;;);\n';
  const ts = `${js}var {...r2: x2 = 1} = o;\n`;
  for (const [g, spec, src, oracle] of [
    [javascript, estreeExprShape.spec, js, () => normaliseEstree(parseEstree(js)!.tree)],
    [typescript, tscExprShape.spec, ts, () => { const r = tscOracle(ts, 'a.ts'); return 'tree' in r ? r.tree : assert.fail(JSON.stringify(r)); }],
  ] as const) {
    const root = (t: NTree): NTree => ({ kind: t.kind, start: 0, end: 0, fields: Object.fromEntries(Object.entries(t.fields).filter(([k]) => k !== 'sourceType' && k !== 'endOfFileToken')) });
    assert.deepEqual(compareTrees(root(oracle()), root(run(g, spec, src) as NTree), 1).divergences, [], spec.name);
    const deps = dependencies(defineShape(g, spec));
    for (const r of ['BindingPattern.object', 'BindingPattern.array', 'BindingElement.seq', 'BindingProperty.pair']) assert.deepEqual(deps[r]?.inherited ?? [], [], `${spec.name} ${r}`);
  }
});

// Object and array literals, spread and templates in both shapes, against their oracles: every
// property form (init, shorthand, computed / string / number keys, methods, accessors, async and
// generator methods, spread), holes, nested and tagged templates with invalid escapes and CR / CRLF
// (the five template cooking functions), a hole as a fresh context (`?.` inside one is its own
// chain), and ESTree's assignment patterns (`[a] = b`, `({a = 1} = b)`, `for ([k, v] of m)`).
check('literals, spread, templates (both fixtures, against acorn and tsc)', () => {
  const both = 'x = {a, b: 1, [c]: 2, "s": 3, 4: 5, 0x10: 6, 1n: 7, d(p) {}, get e() {}, set f(v) {}, async g() {}, *h() {}, async *i() {}, ...j};\n'
    + 'y = [1, , ...z, [], [,], [a,,], {}];\nf(...a, ...[b]);\nnew F`t`;\nnew F`t`();\nq = `a${b}c${`d${e?.f}`}g`;\nr = `\\u{41}\\x41\\u0041${x}`;\n'
    + 'String.raw`\\unicode\\01\\8${x}\\u{110000}\r\nz\r`;\nfn`a\\\r\nb\\u{g}`;\n({m() { "use strict"; }});\n'
    + '[a, [b], {c: d = 1, e = 2, ...g}, ...h] = x;\n({a: [b.c], ...d} = e);\n[a = b = c] = d;\nfor ([k, v] of m);\nfor ({k} in o);\n[a] == b;\n({a} || b);\n';
  const ts = `${both}z = {a?: 1, k = 2, async *m() {}, [a, b]: 3};\n`;
  for (const [g, spec, src, oracle] of [
    [javascript, estreeExprShape.spec, both, () => normaliseEstree(parseEstree(both)!.tree)],
    [typescript, tscExprShape.spec, ts, () => { const r = tscOracle(ts, 'a.ts'); return 'tree' in r ? r.tree : assert.fail(JSON.stringify(r)); }],
  ] as const) {
    const root = (t: NTree): NTree => ({ kind: t.kind, start: 0, end: 0, fields: Object.fromEntries(Object.entries(t.fields).filter(([k]) => k !== 'sourceType' && k !== 'endOfFileToken')) });
    assert.deepEqual(compareTrees(root(oracle()), root(run(g, spec, src) as NTree), 1).divergences, [], spec.name);
  }
  // Only ESTree's literals depend on where they sit (the pattern reading); tsc's are their subtree's.
  const deps = dependencies(estreeExprShape);
  for (const a of ['array', 'object', 'spread', 'binaryOp']) assert.deepEqual(deps[`Expr.${a}`]?.inherited, ['pattern'], `estree Expr.${a}`);
  assert.deepEqual(deps['Expr.template']?.inherited ?? [], [], 'estree Expr.template');
  const tdeps = dependencies(tscExprShape);
  for (const a of ['array', 'object', 'template', 'led_template']) assert.deepEqual(tdeps[`Expr.${a}`]?.inherited ?? [], [], `tsc Expr.${a}`);
});

// Modules in both shapes, against their oracles: every import / export form (default, named,
// namespace and string specifiers, attributes, `export *` with and without an alias, `export
// default` of a function, a class and an expression, `import()` / `import.meta`), and in tsc the
// type-only forms, import-equals, `export =`, `export as namespace` and the modifiers the
// wrapping `export` / `declare` / prefix arms hand a declaration (the nodes attribute `modifiers`).
check('modules (both fixtures, against acorn and tsc)', () => {
  const js = `import a, {b as c, d} from "m" with {type: "json", 'x': "y"};\nimport * as ns from "m";\nimport "x";\nimport e, * as f from "q";\nimport {"s t" as g} from "q";\nvar h, k;\nexport {h as hh, k, h as "s"};\nexport * from "m";\nexport * as q from "m";\nexport {x as xd, "y" as z} from "n" with {type: "j"};\nexport default async function* () { 'u'; }\nexport const x1 = 1, x2 = 3;\nexport function f1() { 'v'; }\nexport class C1 extends D {}\nimport.meta.url;\nimport("x").then(y);\n`;
  const ts = `import a, {b as c, type d} from "m" with {type: "json"};\nimport type T from "t";\nimport x = require("y");\nimport type {Q} from "q";\nimport defer * as n from "r";\nimport e = A.B.C;\nexport import ei = A.B;\nexport {a as b, type c as cc, "q" as "r"};\nexport {type as};\nexport {type as as x2};\nexport * as q from "m";\nexport type * as tt from "u";\nexport * from "v" with {};\nexport type {Z} from "z";\nexport function f() {}\nexport async function f2() {}\nexport const k1 = 1, k2 = 2;\nexport class C1 extends D.E {}\nexport abstract class C2 {}\nabstract class C3 {}\ndeclare var dv;\nexport declare let dl;\ndeclare export * from "w";\nexport default abstract class {}\nexport as namespace N;\nexport = a;\n`;
  for (const [g, spec, src, oracle] of [
    [javascript, estreeExprShape.spec, js, () => { const r = parseEstree(js); return r ? normaliseEstree(r.tree) : assert.fail('acorn rejects it'); }],
    [typescript, tscExprShape.spec, ts, () => { const r = tscOracle(ts, 'a.ts'); return 'tree' in r ? r.tree : assert.fail(JSON.stringify(r)); }],
  ] as const) {
    const root = (t: NTree): NTree => ({ kind: t.kind, start: 0, end: 0, fields: Object.fromEntries(Object.entries(t.fields).filter(([k]) => k !== 'sourceType' && k !== 'endOfFileToken')) });
    assert.deepEqual(compareTrees(root(oracle()), root(run(g, spec, src) as NTree), 1).divergences, [], spec.name);
  }
});

// A method whose name is an escaped `constructor` is the constructor (ECMA-262 ClassElementKind
// reads the PropName's StringValue). tsc's parser builds a Constructor too, with the diagnostic
// "Keywords cannot contain escape characters", so the oracle harness skips such a file; the kind
// is compared with tsc's parser directly.
check('an escaped constructor name is the constructor (both shapes; tsc against its parser\'s kind)', () => {
  const src = String.raw`class C { \u0063onstructor() {} }` + '\n';
  const sf = tsc.createSourceFile('a.ts', src, tsc.ScriptTarget.Latest, true);
  assert.equal(tsc.SyntaxKind[(sf.statements[0] as import('typescript').ClassDeclaration).members[0].kind], 'Constructor');
  type V = { kind: string; fields: Record<string, V & V[]> };
  const t = run(typescript, tscExprShape.spec, src) as V;
  assert.equal(t.fields.statements[0].fields.members[0].kind, 'Constructor');
  const e = run(javascript, estreeExprShape.spec, src) as V;
  assert.equal(e.fields.body[0].fields.body.fields.body[0].fields.kind as never, 'constructor');
});

// The nodes attribute `modifiers` (tsc): a declaration reached through wrapping arms is the node it
// is without them, apart from its modifiers and its start (the first inherited modifier). The
// source is padded so that the bare declaration sits at the same offsets.
check('tsc modifiers: the same declaration with and without wrappers differs only in modifiers and start', () => {
  const declOf = (src: string): Record<string, ShapeValue> & { kind: string; start: number; end: number } => {
    const p = run(typescript, tscExprShape.spec, src) as { fields: { statements: ShapeValue[] } };
    return p.fields.statements[0] as never;
  };
  for (const [wrapped, words] of [
    ['export function f(a) { return a; }', ['ExportKeyword']],
    ['export declare let x, y;', ['ExportKeyword', 'DeclareKeyword']],
    ['declare var v = 1;', ['DeclareKeyword']],
    ['export abstract class C extends B { m() {} }', ['ExportKeyword', 'AbstractKeyword']],
    ['export async function g() {}', ['ExportKeyword', 'AsyncKeyword']],
  ] as const) {
    const at = wrapped.search(/(function|let|var|class|async)\b/);
    const bareAt = /abstract|async/.test(wrapped) ? wrapped.search(/(abstract|async)\b/) : at;
    const bare = ' '.repeat(bareAt) + wrapped.slice(bareAt);
    const w = declOf(wrapped) as unknown as { kind: string; start: number; end: number; fields: Record<string, ShapeValue> };
    const b = declOf(bare) as unknown as { kind: string; start: number; end: number; fields: Record<string, ShapeValue> };
    assert.equal(w.start, 0, wrapped);
    assert.equal(b.start, bareAt, bare);
    assert.equal(w.end, b.end, wrapped);
    const { modifiers: wm, ...wrest } = w.fields;
    const { modifiers: bm, ...brest } = b.fields;
    assert.deepEqual(wrest, brest, wrapped);
    assert.deepEqual((wm as { kind: string }[]).map((m) => m.kind), words, wrapped);
    const own = (bm as { kind: string }[] | undefined)?.map((m) => m.kind) ?? [];
    assert.deepEqual(own, words.filter((k) => k === 'AbstractKeyword' || k === 'AsyncKeyword'), bare);
  }
  // The receivers read the attribute; the arms that hand it on depend on it through the copy.
  const deps = dependencies(tscExprShape);
  for (const k of ['Decl.function_', 'Decl.namedClass', 'Stmt.variable', 'Decl.exportDeclaration', 'Decl.declared', 'Decl.prefixed']) assert.ok(deps[k]?.inherited.includes('modifiers'), k);
});

// A node handed modifiers whose arm does not place them is outside the subset (it would build a
// node without them): `declare x;` reaches the expression statement with [DeclareKeyword].
check('tsc modifiers: an arm that does not place the modifiers it is handed is outside the subset', () => {
  assert.throws(() => run(typescript, tscExprShape.spec, 'declare x;'), (e) => e instanceof ShapeUnmapped && e.rule === 'Stmt' && e.arm === 'expr (handed modifiers)');
});

// The loader classifies every inherited equation: RIGHT-DEPENDENT when it reads a leaf to the right
// of the child it feeds. ESTree has one (the left operand of `=`: the operator follows it); tsc has
// none, so a parser building tsc's tree as it goes never rewrites a node it has built.
check('right-dependent inherited equations: ESTree has exactly binaryOp.left, tsc none', () => {
  assert.deepEqual(estreeExprShape.rightDependent, [{ rule: 'Expr', arm: 'binaryOp', child: 'left', attr: 'pattern', reads: ['op'] }]);
  assert.deepEqual(tscExprShape.rightDependent, []);
  // The spine a fused parser rewrites when `=` arrives: the arms reading `pattern` and the
  // children it is passed on to.
  assert.deepEqual(spineOf(estreeExprShape, 'pattern'), {
    reads: ['Expr.array', 'Expr.binaryOp', 'Expr.object', 'Expr.spread', 'Prop.spread'],
    copies: ['Expr.array.element', 'Expr.array.elementRest', 'Expr.object.property', 'Expr.spread.expr', 'Prop.init.value', 'Prop.spread.argument'],
  });
  // A constant equation and a copy are L-attributed by construction.
  assert.deepEqual(defineShape(javascript, { ...estreeExprShape.spec, inherited: { ...estreeExprShape.spec.inherited, pattern: { ...estreeExprShape.spec.inherited!.pattern, rules: { ForHead: { of: { left: c(true) } } } } } }).rightDependent, []);
});

// The right-dependent equation gives the left operand the value it would have under a context
// decided before it (the L-attributed `for (L of r)` head, a constant): what a fused parser that
// builds the left in its default reading and rewrites it on `=` must produce. And under `==` (the
// deciding leaf says no) the left is its default reading.
check('a right-dependent equation equals the left evaluated in the context the leaf decides', () => {
  const loaded = estreeExprShape;
  const shift = (v: ShapeValue, by: number): ShapeValue => Array.isArray(v) ? v.map((x) => shift(x, by))
    : v !== null && typeof v === 'object' && 'kind' in v ? { ...v, start: v.start - by, end: v.end - by, fields: Object.fromEntries(Object.entries(v.fields).map(([k, x]) => [k, shift(x, by)])) }
    : v !== null && typeof v === 'object' && 'record' in v ? { record: Object.fromEntries(Object.entries(v.record).map(([k, x]) => [k, shift(x, by)])) } : v;
  const left = (src: string, at: string): ShapeValue => {
    const cst = parse(javascript, src);
    const tree = nest(loaded.spec, evaluateShape(loaded, cst, src)) as NTree;
    const found: ShapeValue[] = [];
    const walk = (x: unknown): void => {
      if (x === null || typeof x !== 'object') return;
      const t = x as { kind?: string; fields?: Record<string, unknown> };
      if (t.kind && t.fields && at in t.fields && t.kind !== 'Program') found.push(t.fields[at] as ShapeValue);
      Object.values(t.fields ?? (x as object)).forEach(walk);
    };
    walk(tree.fields);
    return shift(found[0], src.indexOf(src.match(/[[{]/)![0]));
  };
  for (const L of ['[a, , ...b]', '[a = 1, [b], {c}]', '{a, b: [c] = d, ...e}', '{a = 1, "s": t, [k]: {m}}']) {
    const rd = left(`(${L} = r);`, 'left');
    const lattr = left(`for (${L} of r);`, 'left');
    assert.deepEqual(rd, lattr, L);
    assert.match((rd as NTree).kind, /Pattern$/, L);
    const plain = left(`(${L} == r);`, 'left') as NTree;
    assert.match(plain.kind, /Expression$/, `${L} under ==`);
  }
});

check('the template cooking functions on their witnesses (invalid escapes, CR / CRLF), against acorn and tsc', () => {
  const srcs = ['f`a\\u{g}\\n\\x4`;', 'f`\\01\\1x\\u{41}\\u0041\\x41\r\n\r`;', 'f`\\8\\0\\\r\nz${x}\\u{110000}`;', '`\\\u2028a\u2029`;', 'f`a\\u00g${x}b`;'];
  for (const src of srcs) {
    const est = normaliseEstree(parseEstree(src)!.tree);
    const r = tscOracle(src, 'a.ts');
    if (!('tree' in r)) assert.fail(JSON.stringify(r));
    const root = (t: NTree): NTree => ({ kind: t.kind, start: 0, end: 0, fields: Object.fromEntries(Object.entries(t.fields).filter(([k]) => k !== 'sourceType' && k !== 'endOfFileToken')) });
    assert.deepEqual(compareTrees(root(est), root(run(javascript, estreeExprShape.spec, src) as NTree), 1).divergences, [], `estree ${JSON.stringify(src)}`);
    assert.deepEqual(compareTrees(root(r.tree), root(run(typescript, tscExprShape.spec, src) as NTree), 1).divergences, [], `tsc ${JSON.stringify(src)}`);
  }
});

check('calc: dropLastIf drops the final element only when its condition holds; an empty list stays empty', () => {
  const spec = (cond: boolean, items: Term): ShapeSpec => ({ ...calcSpec, rules: { ...calcSpec.rules, Program: { program: node('P', { l: dropLastIf(c(cond), items) }) } } });
  assert.deepEqual(run(calc, spec(true, list(c(1), c(2))), ''), N('P', 0, 0, { l: [1] }));
  assert.deepEqual(run(calc, spec(false, list(c(1), c(2))), ''), N('P', 0, 0, { l: [1, 2] }));
  assert.deepEqual(run(calc, spec(true, child('statement')), ''), N('P', 0, 0, { l: [] }));
});

check('calc: a span { after } is zero width at the end of its child', () => {
  const spec: ShapeSpec = { ...calcSpec, rules: { ...calcSpec.rules, Expr: { ...calcSpec.rules.Expr, prefixOp: node('Neg', { at: node('Gap', {}, { after: 'op' }) }) } } };
  assert.deepEqual(run(calc, spec, '- x;'), N('Program', 0, 4, { body: [N('ExpressionStatement', 0, 4, { expression: N('Neg', 0, 3, { at: N('Gap', 1, 1) }) })] }));
});

// The reference matcher finds an arm for every node of real inputs (an arm consuming all the
// node's children): JavaScript on acorn's own source, TypeScript on this interpreter's source.
check('the matcher is total on real files', () => {
  for (const [g, file] of [[javascript, 'node_modules/acorn/dist/acorn.js'], [typescript, 'src/shape2-eval.ts']] as const) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8');
    const loaded = defineShape(g, { name: 'none', rules: {} });
    let nodes = 0;
    const walk = (x: CstNode | CstLeaf): void => {
      if ('tokenType' in x) return;
      if (x.rule !== '$template') { armNameOf(loaded, x, src); nodes++; }
      x.children.forEach(walk);
    };
    walk(parse(g, src));
    assert.ok(nodes > 5000, `${file}: ${nodes} nodes`);
  }
});

// ── Load-time rejections ──

const rejects = (what: string, g: CstGrammar, spec: ShapeSpec, ...needles: string[]): void => check(`rejects: ${what}`, () => {
  assert.throws(() => defineShape(g, spec), (e) => {
    if (!(e instanceof ShapeSpecError)) throw e;
    for (const n of needles) if (!e.message.includes(n)) throw new Error(`message lacks ${JSON.stringify(n)}:\n${e.message}`);
    return true;
  });
});
const one = (rules: ShapeSpec['rules'], extra: Partial<ShapeSpec> = {}): ShapeSpec => ({ name: 'bad', rules, ...extra });
const E = (arms: Record<string, unknown>): ShapeSpec['rules'] => ({ Expr: arms as ShapeSpec['rules'][string] });

rejects('an unknown rule', calc, one({ Exp: {} }), 'rules Exp', 'no rule Exp');
rejects('an unknown arm', calc, one(E({ numbr: c(1) })), 'rules Expr.numbr', 'no arm numbr', 'they are: number, name, parenthesized, binaryOp, prefixOp, postfixOp');
rejects('an unknown arm among many: the nearest names', javascript, one(E({ led_dott: c(1) })), 'no arm led_dott', 'nearest: led_dot');
rejects('an unknown child', calc, one(E({ number: child('num') })), 'Expr.number', 'no child num', 'the only one is: number');
rejects('child() of a leaf', calc, one(E({ number: child('number') })), 'number is a leaf');
rejects('child() of an inline alternation', javascript, one(E({ led_dot: child('alt') })), 'Expr.led_dot', 'inline alternation');
rejects('text() of a list', calc, one({ Program: { program: text('statement') } }), 'statement is a list');
rejects('present() of a required child', calc, one(E({ parenthesized: present('expression') })), 'required child');
rejects('an unknown cooking function', calc, one(E({ number: cook('evalIt' as never, 'number') })), 'not a cooking function');
rejects('cook() of a rule node', calc, one(E({ parenthesized: cook('numberValue', 'expression') })), 'expression is a node');
rejects('armOf() of a leaf', calc, one(E({ number: armOf('number') })), 'only a rule node or an inline alternation');
rejects('a function (no escape to code)', calc, one(E({ number: (() => 1) as never })), 'no escape to code');
rejects('a function inside a node', calc, one(E({ number: node('N', { v: (() => 1) as never }) })), 'Expr.number .v', 'no escape to code');
rejects('an operator outside the calculus', calc, one(E({ number: { t: 'custom', fn: 'x' } as never })), '`custom` is not an operator');
rejects('a non-string node type', calc, one(E({ number: node(present('number' as never), {}) })), 'type');
rejects('a non-bool condition', calc, one(E({ number: iff(text('number'), c(1), c(2)) })), 'cond', 'must be a bool');
rejects('a branch case that is not a branch', javascript, one(E({ led_dot: branch('alt', { ident: c(1), name: c(2) }) })), 'no branch name');
rejects('branch() of a node', calc, one(E({ parenthesized: branch('expression', {}) })), 'not an inline alternation');
rejects('map over a single child', calc, one(E({ parenthesized: map('expression', c(1)) })), 'is not repeated');
rejects('an unbound variable', calc, one(E({ number: v('x') })), 'var(x) is not bound');
const forRules = (stmt: ShapeSpec['rules'][string], head: ShapeSpec['rules'][string]): ShapeSpec => one({ Stmt: stmt, ForHead: head });
const okHead = { classic: record({ kind: c('classic'), test: absent }), of: record({ kind: c('of'), test: absent }) };
rejects('get of a field the record-valued rule does not declare', javascript, forRules({ for_: branch('alt', { paren: get('head', 'init') }) }, okHead), 'Stmt.for_', 'get(head, init)', 'ForHead has no field init');
rejects('get of a child whose rule is not record-valued (a node is not projectable)', javascript, forRules({ while_: get('body', 'test') }, okHead), 'Stmt.while_', 'Stmt is not record-valued');
rejects('get of a leaf', javascript, forRules({ break_: get('label', 'x') }, okHead), 'get(label, x)', 'label is a leaf');
rejects('child() of a record-valued rule (an interface, not a node)', javascript, forRules({ for_: branch('alt', { paren: child('head') }) }, okHead), 'Stmt.for_', 'ForHead is record-valued');
rejects('a record-valued rule with an arm that is not a record', javascript, forRules({}, { classic: record({ kind: c('classic') }), of: node('X') }), 'rules ForHead', 'every arm to a record', 'of is not');
rejects('a record-valued rule whose arms have different fields', javascript, forRules({}, { classic: record({ kind: c('classic') }), of: record({ kind: c('of'), left: absent }) }), 'rules ForHead.of', 'the same fields');
rejects('dropLastIf with a condition that is not a bool', calc, one({ Program: { program: dropLastIf(text('statement' as never) as never, child('statement')) } }), 'cond');
rejects('dropLastIf with a condition that is a string', calc, one(E({ parenthesized: dropLastIf(armOf('expression'), list()) })), 'cond', 'must be a bool');
rejects('dropLastIf of a value that is not a list', calc, one(E({ parenthesized: dropLastIf(c(true), child('expression')) })), 'Expr.parenthesized list', 'takes a list');
rejects('a span after an optional child (it can be absent)', javascript, one({ Stmt: { return_: node('R', {}, { after: 'argument' }) } }), 'span.after', 'argument is optional');
rejects('a span after a list (it can be empty)', calc, one({ Program: { program: node('P', {}, { after: 'statement' }) } }), 'span.after', 'statement is a list');
rejects('a span after an unknown name', calc, one(E({ number: node('N', {}, { after: 'nope' }) })), 'span.after', 'no child or variable nope');
rejects('a span over an unknown name', calc, one(E({ number: node('N', {}, { from: 'number', to: 'nope' }) })), 'span.to', 'nope');
rejects('total: an unmapped arm', calc, one({ Stmt: { expression: c(1) } }, { total: true }), 'rules Stmt.letDeclaration', 'not mapped');
rejects('total: an unmapped branch', javascript, one(E({ led_dot: branch('alt', { ident: c(1) }) }), { total: true }), 'branch privateField not mapped');
rejects('a synthesized attribute that builds a node', calc, one({}, { synthesized: { s: { type: 'bool', default: false, rules: E({ number: node('N') }) } } }), 'cannot appear in a synthesized');
rejects('a synthesized attribute that reads inherited context', calc, one({}, {
  synthesized: { s: { type: 'bool', default: false, rules: E({ number: inh('i') }) } },
  inherited: { i: { type: 'bool', default: false, rules: {} } },
}), '`inh` cannot appear in a synthesized');
rejects('a synthesized attribute reading itself', calc, one({}, { synthesized: { s: { type: 'bool', default: false, rules: E({ number: syn('s') }) } } }), 'is a cycle');
rejects('a synthesized attribute of the wrong type', calc, one({}, { synthesized: { s: { type: 'bool', default: false, rules: E({ number: text('number') }) } } }), 'has type string');
rejects('an undeclared synthesized attribute', calc, one(E({ parenthesized: syn('nope', 'expression') })), 'no synthesized attribute nope');
rejects('an undeclared inherited attribute', calc, one(E({ number: inh('nope') })), 'no inherited attribute nope');
rejects('an inherited equation reading into a sibling subtree (text of a node)', calc, one({}, {
  inherited: { i: { type: 'string', default: '', rules: E({ parenthesized: { expression: text('expression') } }) } },
}), 'Expr.parenthesized.expression', 'expression is a node', 'own leaves only');
rejects('an inherited equation reading a sibling node\'s arm', javascript, one({}, {
  inherited: { i: { type: 'string', default: '', rules: E({ binaryOp: { left: armOf('right') } }) } },
}), 'Expr.binaryOp.left', 'right is a node');
rejects('an inherited equation reading an alternation that holds a rule node', javascript, one({}, {
  inherited: { i: { type: 'string', default: '', rules: { Stmt: { for_: { body: armOf('alt') } } } } },
}), 'Stmt.for_.body', 'holding a rule node');
rejects('an inherited equation building a node', javascript, one({}, {
  inherited: { i: { type: 'bool', default: false, rules: E({ binaryOp: { left: node('N') } }) } },
}), 'Expr.binaryOp.left', '`node` cannot appear in an inherited equation');
rejects('an inherited equation reading the whole arm\'s text', javascript, one({}, {
  inherited: { i: { type: 'string', default: '', rules: E({ binaryOp: { left: text() } }) } },
}), 'Expr.binaryOp.left', 'named leaves only');
rejects('an inherited equation of the wrong type', javascript, one({}, {
  inherited: { i: { type: 'bool', default: false, rules: E({ binaryOp: { left: text('op') } }) } },
}), 'Expr.binaryOp.left', 'has type string');
rejects('a span inside a leaf that is no template part', calc, one(E({ number: node('N', {}, { inside: 'number' }) })), 'span.inside', 'not a delimited template part');
rejects('a span inside a template (not one of its parts)', javascript, one(E({ template: node('T', {}, { inside: 'template' }) })), 'span.inside', 'not a delimited template part');
rejects('an inherited equation on an unknown child', calc, one({}, {
  inherited: { i: { type: 'bool', default: false, rules: E({ parenthesized: { expr: c(true) } }) } },
}), 'no child expr');
rejects('an inherited equation on a leaf', calc, one({}, {
  inherited: { i: { type: 'bool', default: false, rules: E({ number: { number: c(true) } }) } },
}), 'only a rule node has inherited attributes');

// A sibling can be read only through a thread, and a thread's next state only from its element.
const leadWith = (eq: unknown, extra: Record<string, unknown> = {}): ShapeSpec => one({}, {
  synthesized: leadSpec.synthesized,
  inherited: { lead: { type: 'bool', default: false, rules: { Program: { program: { statement: eq, ...extra } } } } } as ShapeSpec['inherited'],
});
rejects('an inherited equation reading a sibling\'s attribute', calc, leadWith(syn('isLet', 'statement')), 'Program.program.statement', '`syn` cannot appear in an inherited equation');
rejects('a thread over a child that does not repeat', calc, one({}, {
  inherited: { i: { type: 'bool', default: false, rules: E({ parenthesized: { expression: thread(c(true), 'p', v('p')) } }) } },
}), 'Expr.parenthesized.expression', 'is not repeated');
rejects('a thread over a child not of the arm itself', javascript, one({}, {
  inherited: { i: { type: 'bool', default: false, rules: { Program: { decl: { stmt: thread(c(true), 'p', v('p')) } } } } },
}), 'Program.decl.stmt', 'no child stmt of its own');
rejects('a thread whose initial state is computed', calc, leadWith(thread(syn('isLet', 'statement'), 'p', v('p'))), 'init', 'a constant or `inh`');
rejects('a thread whose initial state has the wrong type', calc, leadWith(thread(c('yes'), 'p', v('p'))), 'init', 'initial state is "yes"');
rejects('a thread whose next state has the wrong type', calc, leadWith(thread(c(true), 'p', armOf('statement'))), 'next', 'has type string');
rejects('a thread whose next state reads inherited context', calc, leadWith(thread(c(true), 'p', inh('lead'))), 'next', '`inh` cannot appear in a thread');
rejects('a thread whose next state builds a node', calc, leadWith(thread(c(true), 'p', node('N'))), 'next', '`node` cannot appear in a thread');
rejects('a thread whose next state reads the parent\'s own attribute', calc, leadWith(thread(c(true), 'p', syn('isLet'))), 'next', 'the element\'s own children only');
rejects('a thread whose next state reads a sibling outside the element', javascript, one({}, {
  inherited: { i: { type: 'bool', default: false, rules: { Stmt: { switch_: { switchCase: thread(c(true), 'p', present('expr2')) } } } } },
}), 'Stmt.switch_.switchCase next', 'expr2 is not in the element');
rejects('a thread beside another equation for the same attribute', calc, leadWith(thread(c(true), 'p', v('p')), { x: c(true) }), 'Program.program', 'no other equation');
rejects('a thread outside an inherited equation', calc, one(E({ number: thread(c(true), 'p', v('p')) as never })), '`thread` is not an operator');

// A nodes attribute: L-attributed by construction, placed and never read, and only a list.
const nodesWith = (rules: Record<string, Record<string, Record<string, unknown>>>, value: ShapeSpec['rules'] = {}, extra: Record<string, unknown> = {}): ShapeSpec =>
  one(value, { inherited: { m: { type: 'nodes', rules, ...extra }, i: { type: 'bool', default: false, rules: {} } } as ShapeSpec['inherited'] });
const tokenAt = (leaf: string): Term => node('T', {}, { from: leaf, to: leaf });
rejects('a nodes equation reading a leaf to the right of the child it feeds', calc, nodesWith(E({ binaryOp: { left: list(tokenAt('op')) } })), 'Expr.binaryOp.left', 'reads op, which is not to the LEFT of left');
rejects('a nodes equation reading the child it feeds', calc, nodesWith(E({ binaryOp: { right: list(child('right')) } })), 'Expr.binaryOp.right', 'reads right, which is not to the LEFT');
rejects('a nodes equation reading a branch that holds the child it feeds', typescript, nodesWith({ Decl: { prefixed: { decl: list(spread(branch('declaration', {}))) } } }), 'Decl.prefixed.decl', 'reads declaration, which is not to the LEFT of decl');
rejects('a nodes equation that is not a list', calc, nodesWith(E({ binaryOp: { right: tokenAt('op') } })), 'Expr.binaryOp.right', 'is a list');
rejects('a nodes equation reading a synthesized attribute', calc, nodesWith(E({ binaryOp: { right: list(iff(syn('s', 'left'), c(1), c(2))) } }), {}), 'Expr.binaryOp.right', '`syn` cannot appear in a nodes');
rejects('a threaded nodes attribute', calc, nodesWith({ Program: { program: { statement: thread(c(true), 'p', v('p')) } } }), 'is not threaded');
rejects('a nodes attribute with a default other than the empty list', calc, nodesWith({}, {}, { default: [1] }), 'inherited m', 'default is the empty list');
rejects('a nodes attribute used as a value (a field)', calc, nodesWith({}, E({ number: node('N', { m: inh('m') }) })), 'Expr.number .m', 'placed only');
rejects('a nodes attribute used as a scalar (a condition)', calc, nodesWith({}, E({ number: iff(inh('m') as never, c(1), c(2)) })), 'Expr.number cond', 'placed only');
rejects('a variable bound to a nodes attribute used as a value', calc, nodesWith({}, E({ number: let_('x', inh('m'), list(v('x'))) })), 'Expr.number body [0]', 'placed only');
rejects('present of a variable not bound to a nodes attribute', calc, one(E({ number: let_('x', c(1), present('x')) })), 'present(x)', 'not bound to a nodes attribute');
rejects('a scalar equation copying a nodes attribute', calc, one({}, {
  inherited: { m: { type: 'nodes', rules: {} }, i: { type: 'bool', default: false, rules: E({ binaryOp: { right: inh('m') } }) } } as ShapeSpec['inherited'],
}), 'Expr.binaryOp.right', 'copies m (nodes) into a bool attribute');
rejects('a scalar equation given node terms', calc, one({}, {
  inherited: { m: { type: 'nodes', rules: {} }, i: { type: 'bool', default: false, rules: E({ binaryOp: { right: list(spread(inh('m'))) } }) } } as ShapeSpec['inherited'],
}), 'Expr.binaryOp.right', '`list` cannot appear in an inherited equation');

// ── defineShape's surface: the documented example, coverage, the skeleton ──

check('docs/SHAPE.md holds the defineShape example verbatim, and its value is the one shown', () => {
  const doc = readFileSync(new URL('../docs/SHAPE.md', import.meta.url), 'utf8');
  const block = (marker: string): string => {
    const m = new RegExp(`<!-- ${marker}:start -->\\n\`\`\`\\w*\\n([\\s\\S]*?)\`\`\`\\n<!-- ${marker}:end -->`).exec(doc);
    return m ? m[1] : assert.fail(`docs/SHAPE.md has no ${marker} block`);
  };
  assert.equal(block('shape-example'), readFileSync(new URL('./fixtures/shape-namedcalc.ts', import.meta.url), 'utf8'));
  // The value block: `evaluateShape(shape, parse(<source>), <source>)` on its first line, the value as JSON after.
  const [call, ...value] = block('shape-example-value').split('\n');
  const text = JSON.parse(/parse\(("(?:[^"\\]|\\.)*")\)/.exec(call)![1]) as string;
  assert.deepEqual(evaluateShape(calcExample, parse(calc, text), text), JSON.parse(value.join('\n').replace(/^\/\/ =>/, '')));
});

check('coverage: what a shape leaves out, and whether evaluation from the entry rule reaches it (from the grammar)', () => {
  const cov = shapeCoverage(estreeExprShape);
  assert.equal(cov.entry, 'Program');
  const at = (rule: string, arm: string): [boolean, boolean] => { const a = cov.arms.find((x) => x.rule === rule && x.arm === arm)!; return [a.mapped, a.reached]; };
  assert.deepEqual(at('Expr', 'binaryOp'), [true, true]);
  // `switch` is a statement (reached) the ESTree shape does not map yet: an input holding one throws ShapeUnmapped.
  assert.deepEqual(at('Stmt', 'switch_'), [false, true]);
  assert.throws(() => run(javascript, estreeExprShape.spec, 'switch (a) {}'), (e) => e instanceof ShapeUnmapped && e.rule === 'Stmt' && e.arm === 'switch_');
  // Evaluation stops at an unmapped arm: what only it reads is not reached.
  const reached = (rules: ShapeSpec['rules']): string[] => shapeCoverage(defineShape(calc, { name: 'x', rules })).arms.filter((a) => !a.mapped && a.reached).map((a) => `${a.rule}.${a.arm}`);
  assert.deepEqual(reached({ Program: { program: child('statement') }, Stmt: { letDeclaration: c(1) } }), ['Stmt.expression']);
  assert.deepEqual(reached({ Program: { program: c(1) } }), []);
});

// The skeleton is what a user starts a shape from: every arm's term must load in the calculus
// (alternations, repetitions of them, template parts: on every grammar the shapes are written
// for), and the printed module must import and evaluate as it is.
check('skeleton: every arm of calc / javascript / typescript maps to a term that loads', () => {
  for (const g of [calc, javascript, typescript]) {
    const rules: Record<string, Record<string, Term>> = {};
    for (const a of shapeCoverage(defineShape(g, { name: 'empty', rules: {} })).arms) (rules[a.rule] ??= {})[a.arm] = a.skeleton;
    defineShape(g, { name: 'skeleton', total: true, node: freeNodeKeys(Object.values(rules).flatMap((r) => Object.values(r))), rules });
  }
});
{
  const at = join(tmpdir(), `shape-skeleton-${process.pid}.ts`);
  // Outside the package `monogram/shape` does not resolve (Node resolves a self-reference only from
  // inside it): the module imports the entry by its path instead.
  const entry = new URL('../src/shape.ts', import.meta.url).pathname;
  writeFileSync(at, shapeSkeleton(calc, new URL('./fixtures/namedcalc.ts', import.meta.url).pathname).replace("from 'monogram/shape'", `from '${entry}'`));
  try {
    const sk = (await import(at)).default;
    check('skeleton: the printed module imports and evaluates', () => {
      const text = 'let x = (1);';
      assert.deepEqual(nest(sk.spec, evaluateShape(sk, parse(calc, text), text)), N('Program.program', 0, 12, {
        statement: [N('Stmt.letDeclaration', 0, 12, { binding: 'x', initializer: N('Expr.parenthesized', 8, 11, { expression: N('Expr.number', 9, 10, { number: '1' }) }) })],
      }));
    });
  } finally { rmSync(at); }
}

// ── The emitted shape-building parser (emit option `shape`, TypeScript; src/shape-plan.ts) ──
// Its value of a text is the evaluator's of the interpreter's CST: on the doc example's calc
// shape, over accepted and rejected texts. And a LOSING candidate's nodes are truncated with it:
// in `x! y` the arm `short` of S is accepted at `x` (its node built) and then beaten by the longer
// `long`; that node is built (observeBuilt sees it) and is in no value the parse returns.
{
  const { emitParser } = await import('../src/target.ts');
  const { tsTarget } = await import('../src/target-ts.ts');
  const { token, rule, defineGrammar, many, plus, oneOf, range, arm, field } = await import('../src/api.ts');
  const { child, node, text } = await import('../src/shape2-schema.ts');
  const at = join(tmpdir(), `shape2-built-${process.pid}`);
  type AnyShape = Parameters<typeof evaluateShape>[0];
  const emitted = async (shape: AnyShape, name: string) => {
    const file = `${at}-${name}.ts`;
    writeFileSync(file, emitParser(shape.source, tsTarget, { shape }));
    try { return await import(file); } finally { rmSync(file); }
  };
  const same = (m: { parse(s: string): unknown }, shape: AnyShape, src: string): boolean => {
    let got: unknown, want: unknown;
    try { got = m.parse(src); } catch (e) { got = `throws ${(e as Error).constructor.name}`; }
    try { want = evaluateShape(shape, createParser(shape.source).parse(src), src); } catch (e) { want = /Parse error/.test(String(e)) ? null : `throws ${(e as Error).constructor.name}`; }
    return JSON.stringify(got) === JSON.stringify(want);
  };
  const calcM = await emitted(calcExample, 'calc');
  for (const src of ['let x = 1 + 2 * y;', '-3; (a - b) / c;', 'x;', '', 'let a = -(1); b * -c - d;', '(((n)));', 'a + ;', 'let = 1;']) {
    assert.ok(same(calcM, calcExample, src), `emitted calc shape parser ≡ evaluateShape on ${JSON.stringify(src)}`); passed++;
  }
  const ID = token(plus(oneOf(range('a', 'z'))), { identifier: true });
  const WS = token(plus(oneOf(' ')), { skip: true });
  const A = rule(() => [arm('a', ID)]);
  const S = rule(() => [arm('short', field('head', A)), arm('long', field('head', A), '!')]);
  const P = rule(() => [arm('program', many(field('stmt', S)))]);
  const g = defineGrammar({ name: 'losing', tokens: { WS, ID }, rules: { A, S, P }, entry: P });
  const shape = defineShape(g, { name: 'losing-ast', rules: {
    A: { a: node('A', { name: text('iD') }) },
    S: { short: node('Short', { head: child('head') }), long: node('Long', { head: child('head') }) },
    P: { program: node('P', { body: child('stmt') }) },
  } });
  const m = await emitted(shape, 'losing');
  const built: string[] = [];
  m.observeBuilt((id: number, off: number, end: number) => built.push(`${m.shapeArms[id].rule}.${m.shapeArms[id].arm}@${off}:${end}`));
  const v = m.parse('x! y');
  m.observeBuilt(null);
  assert.ok(same(m, shape, 'x! y'), 'the losing-candidate grammar: emitted ≡ evaluateShape'); passed++;
  assert.ok(built.includes('S.short@0:1'), `the losing candidate S.short at x is built (${built.join(' ')})`); passed++;
  assert.ok(!JSON.stringify(v).includes('"Short","start":0'), 'and is in no value the parse returns'); passed++;
  console.log(`  emitted shape-building parser: calc ≡ evaluateShape; losing candidate built and dropped (${built.join(' ')})`);
}

console.log(`shape2-eval: ${passed} checks passed`);

