// Gate `shape2-eval`: the ShapeSpec v2 reference interpreter (src/shape2-eval.ts) on its calculus
// (src/shape2-schema.ts): every operator evaluated on a small grammar with every name written
// (test/fixtures/namedcalc.ts) and on the JavaScript grammar's expression rules, and every
// load-time rejection: a spec outside the calculus or not typed against the grammar must be
// refused, naming the rule / arm / child.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createParser, type CstLeaf, type CstNode } from '../src/gen-parser.ts';
import type { CstGrammar } from '../src/types.ts';
import { armNameOf, dependencies, evaluate, evaluator, loadShape2, Shape2SpecError, Shape2Unmapped, type S2Value } from '../src/shape2-eval.ts';
import {
  absent, and, armOf, branch, c, child, cook, fold, iff, inh, let_, list, map, match, node, not, or, orElse,
  present, record, spread, syn, text, thread, typeByText, v, wrapIf, type Shape2Spec,
} from '../src/shape2-schema.ts';
import calc from './fixtures/namedcalc.ts';
import { estreeExprShape } from './fixtures/shape-v2-estree-expr.ts';
import javascript from '../javascript.ts';
import typescript from '../typescript.ts';

let passed = 0;
const check = (name: string, fn: () => void): void => {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n${(e as Error).stack}`); process.exitCode = 1; }
};
const parse = (g: CstGrammar, src: string): CstNode => createParser(g).parse(src);
const run = (g: CstGrammar, spec: Shape2Spec, src: string): S2Value | undefined => evaluate(loadShape2(g, spec), parse(g, src), src);
const N = (kind: string, start: number, end: number, fields: Record<string, S2Value> = {}): S2Value => ({ kind, start, end, fields });

// ── The calculus on namedcalc ──

const calcSpec: Shape2Spec = {
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
  const spec: Shape2Spec = {
    ...calcSpec,
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

check('calc: an unmapped arm of a non-total spec throws Shape2Unmapped naming it', () => {
  const spec: Shape2Spec = { name: 'partial', rules: { Program: calcSpec.rules.Program, Stmt: calcSpec.rules.Stmt, Expr: { name: node('Name') } } };
  assert.throws(() => run(calc, spec, '1;'), (e) => e instanceof Shape2Unmapped && e.rule === 'Expr' && e.arm === 'number');
});

check('calc: an inherited attribute set by a constant and passed on by a copy; its dependencies', () => {
  const spec: Shape2Spec = {
    name: 'inh', total: true,
    inherited: { mode: { type: 'string', default: 'statement', rules: { Stmt: { letDeclaration: { initializer: c('init') } }, Expr: { parenthesized: { expression: inh('mode') } } } } },
    rules: { ...calcSpec.rules, Expr: { ...calcSpec.rules.Expr, name: node('Name', { name: text('ident'), mode: inh('mode') }) } },
  };
  assert.deepEqual(run(calc, spec, 'let a = ((x)); y;'), N('Program', 0, 17, {
    body: [N('Let', 0, 14, { name: 'a', init: N('Name', 10, 11, { name: 'x', mode: 'init' }) }), N('ExpressionStatement', 15, 17, { expression: N('Name', 15, 16, { name: 'y', mode: 'statement' }) })],
  }));
  const deps = dependencies(loadShape2(calc, spec));
  assert.deepEqual(deps['Expr.name'], { inherited: ['mode'] });            // reads it
  assert.deepEqual(deps['Expr.parenthesized'], { inherited: ['mode'] });   // copies it to a child that reads it
  assert.deepEqual(deps['Stmt.letDeclaration'], { inherited: [] });       // hands a constant: context-free
  assert.deepEqual(deps['Expr.binaryOp'], { inherited: [] });
});

// Threaded list state: the only construct by which a node's context depends on its siblings.
const leadSpec: Shape2Spec = {
  ...calcSpec,
  name: 'lead',
  synthesized: { isLet: { type: 'bool', default: false, rules: { Stmt: { letDeclaration: c(true) } } } },
  inherited: {
    lead: { type: 'bool', default: false, rules: { Program: { program: { statement: thread(c(true), 'p', and(v('p'), syn('isLet', 'statement'))) } } } },
  },
  rules: { ...calcSpec.rules, Stmt: { ...calcSpec.rules.Stmt, expression: node('ExpressionStatement', { expression: child('expression'), lead: inh('lead') }) } },
};
type Fields = { fields: Record<string, S2Value> };

check('calc: a threaded state across a list (each element sees the state its left siblings made)', () => {
  const src = 'let a = 1; b; let c = 2; d;';
  const body = (run(calc, leadSpec, src) as unknown as { fields: { body: Fields[] } }).fields.body;
  assert.deepEqual(body.map((x) => x.fields.lead), [undefined, true, undefined, false]);
  // the same value for one element evaluated on its own, in the context of its root
  const cst = parse(calc, src);
  const at = evaluator(loadShape2(calc, leadSpec), cst, src);
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
  const deps = dependencies(loadShape2(calc, leadSpec));
  assert.deepEqual(deps['Stmt.expression'], { inherited: ['lead'] });
  assert.deepEqual(deps['Program.program'], { inherited: [], threads: [{ attr: 'lead', over: 'statement', reads: ['isLet'] }] });
  assert.deepEqual(deps['Stmt.letDeclaration'], { inherited: [] });
});

// ── The calculus on the JavaScript expression rules ──

const stmtOf = (src: string): CstNode => parse(javascript, src).children[0] as CstNode;
const jsEval = (spec: Shape2Spec, src: string): S2Value | undefined => evaluate(loadShape2(javascript, spec), stmtOf(src), src);

// A left fold (tsc's comma BinaryExpression) and a list (ESTree's SequenceExpression), an inline
// alternation (`.` Ident | PrivateField), named conditional children, the op-form children.
const jsBase: Shape2Spec['rules'] = {
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
  const spec: Shape2Spec = {
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
  const spec: Shape2Spec = {
    name: 'seq', rules: {
      ...jsBase,
      Stmt: { expr: iff(present('rest'), node('Seq', { expressions: list(child('first'), spread(child('rest'))) }, { from: 'first', to: 'rest' }), child('first')) },
    },
  };
  assert.deepEqual(jsEval(spec, 'x ? 1 : "\\x41", y;'), N('Seq', 0, 17, {
    expressions: [N('Cond', 0, 14, { test: N('Id', 0, 1, { name: 'x' }), then: N('Num', 4, 5, { value: 1 }), otherwise: N('Str', 8, 14, { value: 'A' }) }), N('Id', 16, 17, { name: 'y' })],
  }));
});

// ESTree's ChainExpression: an inherited attribute (am I the top of a member / call chain?)
// and a synthesized one (does my chain hold a `?.`?).
const chainSpec: Shape2Spec = {
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
  const m = (start: number, end: number, object: S2Value, optional: boolean): S2Value => N('Member', start, end, { object, optional });
  const id = (s: number, n: string): S2Value => N('Id', s, s + 1, { name: n });
  assert.deepEqual(jsEval(chainSpec, 'a?.b.c();'), N('Chain', 0, 8, { expression: N('Call', 0, 8, { callee: m(0, 6, m(0, 4, id(0, 'a'), true), false), args: [] }) }));
  assert.deepEqual(jsEval(chainSpec, 'a.b;'), m(0, 3, id(0, 'a'), false));
  // a parenthesis ends a chain: (a?.b).c is a member of a chain
  assert.deepEqual(jsEval(chainSpec, '(a?.b).c;'), m(0, 8, N('Chain', 1, 5, { expression: m(1, 5, id(1, 'a'), true) }), false));
  const deps = dependencies(loadShape2(javascript, chainSpec));
  assert.deepEqual(deps['Expr.led_dot'], { inherited: ['chainTop'] });
  assert.deepEqual(deps['Expr.ident'], { inherited: [] });
});

// ESTree's directive prologue by a thread: Program and function bodies, not plain blocks; a
// parenthesised string, a declaration or any other statement ends the run.
check('js: the directive prologue (threaded state, ESTree fixture)', () => {
  const src = `'a'; "b\\n"; ('c'); 'd'; function f() { 'x'; y; 'z'; } { 'no'; } (() => { 'arrow'; });\n'late';`;
  const loaded = loadShape2(javascript, estreeExprShape);
  const cst = parse(javascript, src);
  const at = evaluator(loaded, cst, src);
  const got: [string, S2Value | undefined][] = [];
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

// The reference matcher finds an arm for every node of real inputs (an arm consuming all the
// node's children): JavaScript on acorn's own source, TypeScript on this interpreter's source.
check('the matcher is total on real files', () => {
  for (const [g, file] of [[javascript, 'node_modules/acorn/dist/acorn.js'], [typescript, 'src/shape2-eval.ts']] as const) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8');
    const loaded = loadShape2(g, { name: 'none', rules: {} });
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

const rejects = (what: string, g: CstGrammar, spec: Shape2Spec, ...needles: string[]): void => check(`rejects: ${what}`, () => {
  assert.throws(() => loadShape2(g, spec), (e) => {
    if (!(e instanceof Shape2SpecError)) throw e;
    for (const n of needles) if (!e.message.includes(n)) throw new Error(`message lacks ${JSON.stringify(n)}:\n${e.message}`);
    return true;
  });
});
const one = (rules: Shape2Spec['rules'], extra: Partial<Shape2Spec> = {}): Shape2Spec => ({ name: 'bad', rules, ...extra });
const E = (arms: Record<string, unknown>): Shape2Spec['rules'] => ({ Expr: arms as Shape2Spec['rules'][string] });

rejects('an unknown rule', calc, one({ Exp: {} }), 'rules Exp', 'no rule Exp');
rejects('an unknown arm', calc, one(E({ numbr: c(1) })), 'rules Expr.numbr', 'no arm numbr');
rejects('an unknown child', calc, one(E({ number: child('num') })), 'Expr.number', 'no child num');
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
rejects('an inherited equation that is not a constant or a copy', calc, one({}, {
  inherited: { i: { type: 'string', default: '', rules: E({ parenthesized: { expression: text('expression') } }) } },
}), 'Expr.parenthesized.expression', 'a constant or `inh`');
rejects('an inherited equation on an unknown child', calc, one({}, {
  inherited: { i: { type: 'bool', default: false, rules: E({ parenthesized: { expr: c(true) } }) } },
}), 'no child expr');
rejects('an inherited equation on a leaf', calc, one({}, {
  inherited: { i: { type: 'bool', default: false, rules: E({ number: { number: c(true) } }) } },
}), 'only a rule node has inherited attributes');

// A sibling can be read only through a thread, and a thread's next state only from its element.
const leadWith = (eq: unknown, extra: Record<string, unknown> = {}): Shape2Spec => one({}, {
  synthesized: leadSpec.synthesized,
  inherited: { lead: { type: 'bool', default: false, rules: { Program: { program: { statement: eq, ...extra } } } } } as Shape2Spec['inherited'],
});
rejects('an inherited equation reading a sibling\'s attribute', calc, leadWith(syn('isLet', 'statement')), 'Program.program.statement', 'a constant or `inh`');
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

console.log(`shape2-eval: ${passed} checks passed`);
