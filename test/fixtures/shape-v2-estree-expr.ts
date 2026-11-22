// ShapeSpec v2: a subset of ESTree (as acorn 8 produces it) from javascript.ts, in the core
// calculus only (src/shape2-schema.ts): the expressions below, the root, and the statements
// (blocks, variable statements with identifier bindings, `if`, loops, `return`, `throw`, `break`,
// `continue`, labelled, `try`, `with`, `debugger`, empty), functions, arrows and their parameters.
// Checked against acorn by test/shape2-oracle.ts. Not total: an arm outside the subset (`switch`,
// other declarations, binding patterns, methods, classes, object / array literals, templates) is unmapped,
// and a unit that reaches one is reported as outside the subset, not compared.
import {
  absent, and, armOf, branch, c, child, cook, get, iff, inh, list, map, match, node, not, orElse, present, record,
  spread, syn, text, thread, v, wrapIf, type Shape2Spec, type Term,
} from '../../src/shape2-schema.ts';

/** An Identifier node from a named leaf (a property name, `new` / `target`). */
const idOf = (leaf: string, name: Term = cook('identifierName', leaf)): Term => node('Identifier', { name }, { from: leaf, to: leaf });
const privateOf = (leaf: string): Term => node('PrivateIdentifier', { name: cook('privateName', leaf) }, { from: leaf, to: leaf });
const literal = (value: Term, extra: Record<string, Term> = {}): Term => node('Literal', { value, raw: text(), ...extra });
const property = (): Term => branch('alt', { ident: idOf('ident'), privateField: privateOf('privateField') });

// A member / call link is the TOP of its chain unless it is the object / callee of another link
// (inherited `chainTop`), and its chain holds a `?.` when it is one or its object / callee's chain
// does (synthesized `optional`). The chain's top wraps in ChainExpression.
const LINKS = ['led_dot', 'led_optChain', 'led_bracket', 'led_paren'] as const;
const chain = (inner: Term): Term => wrapIf(and(inh('chainTop'), syn('optional')), 'ChainExpression', 'expression', inner);
const member = (property: Term, computed: boolean, optional: boolean): Term =>
  node('MemberExpression', { object: child('left'), property, computed: c(computed), optional: c(optional) });

const ASSIGN = ['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '??=', '||=', '&&='];
const LOGICAL = ['||', '&&', '??'];
const binaryType = match(text('op'), Object.fromEntries([...ASSIGN.map((o) => [o, c('AssignmentExpression')]), ...LOGICAL.map((o) => [o, c('LogicalExpression')])]), c('BinaryExpression'));

// The directive prologue (ECMA-262 11.2.1; acorn's `directive`): the leading run of statements
// of a Program or a function body that are a lone, unparenthesised string literal. Threaded
// state `prologue` (src/shape2-schema.ts): true entering the first statement of a Program, and
// of a Block that is a function body (inherited `functionBody`: the grammar has one Block rule
// for both ECMAScript's Block and FunctionBody, so the parent arm tells them apart); stays true
// while each statement is a directive candidate (synthesized `directive`).
const FUNCTIONS = ['function_', 'generator', 'asyncFunction', 'asyncGenerator'] as const;
const ARROWS = ['arrow', 'asyncArrow', 'arrowIdentifier', 'asyncArrowIdentifier'] as const;
/** rule -> arm -> the child that is the function body. */
const FUNCTION_BODIES: Record<string, Record<string, string>> = {
  Expr: { ...Object.fromEntries(FUNCTIONS.map((a) => [a, 'body'])), ...Object.fromEntries(ARROWS.map((a) => [a, 'block'])) },   // function expressions, arrows (a block body)
  NewTarget: Object.fromEntries(FUNCTIONS.map((a) => [a, 'body'])),                                                                    // a function expression as a `new` callee
  Decl: { ...Object.fromEntries(FUNCTIONS.map((a) => [a, 'body'])), export_2: 'body' },                                        // declarations, `export default function`
  Prop: Object.fromEntries(['get', 'async', 'async2', 'star', 'memberName'].map((a) => [a, 'block'])),                           // object methods / accessors
  ClassMember: { seq: 'block' },                                                                                                 // constructor, methods, accessors
};
const prologue = (init: Term) => thread(init, 'p', and(v('p'), syn('directive', 'stmt')));

/** `first (, rest)*`: the expression itself, or a SequenceExpression spanning the list. */
const sequenceOf = (first: string, rest: string): Term =>
  iff(present(rest), node('SequenceExpression', { expressions: list(child(first), spread(child(rest))) }, { from: first, to: rest }), child(first));
const sequence: Term = sequenceOf('first', 'rest');
/** An optional child's value, or acorn's explicit null. */
const orNull = (name: string): Term => orElse(child(name), c(null));
/** A statement's optional label. */
const label: Term = iff(present('label'), idOf('label'), c(null));

/** A declaration list's bindings: the first and the rest. */
const bindings: Term = list(child('binding'), spread(child('bindingRest')));

// ── `for` (ECMA-262 14.7.4, 14.7.5) ──
// The grammar factors a `for` statement's `( … )` into ForHead / ForAwaitHead, whose node is not
// the statement's: both heads are RECORD-VALUED (an interface: `get`), and Stmt.for_ builds
// For / ForIn / ForOfStatement from the head's fields and its own body.
/** A declaration in a head: `kind` (a keyword alternation, or `using` / `await using`), its
 * first binding and, in a C-style head, the rest. */
const headDeclaration = (kind: Term, rest: boolean): Term => {
  const decl = (to: string, declarations: Term): Term => node('VariableDeclaration', { declarations, kind }, { from: 'kind', to });
  return rest
    ? iff(present('bindingRest'), decl('bindingRest', list(child('binding'), spread(child('bindingRest')))), decl('binding', list(child('binding'))))
    : decl('binding', list(child('binding')));
};
const optSequence = (first: string, rest: string): Term => iff(present(first), sequenceOf(first, rest), absent);
type HeadFields = { kind: Term; init: Term; test: Term; update: Term; left: Term; right: Term };
const head = (f: Partial<HeadFields>): Term => record({ kind: f.kind!, init: f.init ?? absent, test: f.test ?? absent, update: f.update ?? absent, left: f.left ?? absent, right: f.right ?? absent });
/** One field of a declaration head: per kind branch (`let_` / `using`), per tail. */
const declField = (pick: (kind: Term, tail: 'classic' | 'in_' | 'of') => Term, tails: ('classic' | 'in_' | 'of')[], usingTails: ('classic' | 'in_' | 'of')[]): Term => branch('alt', {
  let_: branch('tail', Object.fromEntries(tails.map((t) => [t, pick(text('kind'), t)]))),
  using: branch('tail', Object.fromEntries(usingTails.map((t) => [t, pick(branch('kind', { using: c('using'), await_: c('await using') }), t)]))),
});
const declarationHead = (tails: ('classic' | 'in_' | 'of')[], usingTails: ('classic' | 'in_' | 'of')[]): Term => {
  const f = (pick: (kind: Term, tail: 'classic' | 'in_' | 'of') => Term): Term => declField(pick, tails, usingTails);
  return head({
    kind: f((_, t) => c(t === 'classic' ? 'for' : t === 'in_' ? 'in' : 'of')),
    init: f((k, t) => (t === 'classic' ? headDeclaration(k, true) : absent)),
    test: f((_, t) => (t === 'classic' ? optSequence('condition', 'conditionRest') : absent)),
    update: f((_, t) => (t === 'classic' ? optSequence('increment', 'incrementRest') : absent)),
    left: f((k, t) => (t === 'classic' ? absent : headDeclaration(k, false))),
    right: f((_, t) => (t === 'in_' ? sequenceOf('right', 'rightRest') : t === 'of' ? child('right') : absent)),
  });
};
const forStatement = (isAwait: boolean): Term => match(get('head', 'kind'), {
  for: node('ForStatement', { init: orElse(get('head', 'init'), c(null)), test: orElse(get('head', 'test'), c(null)), update: orElse(get('head', 'update'), c(null)), body: child('body') }),
  in: node('ForInStatement', { left: get('head', 'left'), right: get('head', 'right'), body: child('body') }),
  of: node('ForOfStatement', { await: c(isAwait), left: get('head', 'left'), right: get('head', 'right'), body: child('body') }),
});
const FOR_RULES: Shape2Spec['rules'] = {
  ForHead: {
    declaration: declarationHead(['classic', 'in_', 'of'], ['classic', 'of']),
    classic: head({ kind: c('for'), init: optSequence('initializer', 'initializerRest'), test: optSequence('condition', 'conditionRest'), update: optSequence('increment', 'incrementRest') }),
    in_: head({ kind: c('in'), left: child('left'), right: sequenceOf('right', 'rightRest') }),
    of: head({ kind: c('of'), left: child('left'), right: child('right') }),
  },
  ForAwaitHead: {
    declaration: declarationHead(['of'], ['of']),
    of: head({ kind: c('of'), left: child('left'), right: child('right') }),
  },
  ForBinding: { seq: node('VariableDeclarator', { id: branch('name', { ident: idOf('ident') }), init: orElse(child('value'), c(null)) }) },
};

// ── Functions (ECMA-262 15.2 - 15.6) ──
// Four arms per form (plain, generator, async, async generator: the grammar routes each one's
// parameters and body to its [Await] / [Yield] family), so `generator` / `async` are the arm's.
const FUNCTION_FLAGS: Record<(typeof FUNCTIONS)[number], [boolean, boolean]> = { function_: [false, false], generator: [true, false], asyncFunction: [false, true], asyncGenerator: [true, true] };
const fn = (type: string, id: Term, generator: boolean, isAsync: boolean): Term =>
  node(type, { id, expression: c(false), generator: c(generator), async: c(isAsync), params: child('parameter'), body: child('body') });
const functionArms = (type: string, id: Term): Record<string, Term> =>
  Object.fromEntries(FUNCTIONS.map((a) => [a, fn(type, id, ...FUNCTION_FLAGS[a])]));
/** An arrow: a parenthesised parameter list (`parameter` repeats) or one identifier; a block or
 * an expression body (ConciseBody). */
const arrow = (isAsync: boolean, params: Term): Term => node('ArrowFunctionExpression', {
  id: c(null), expression: branch('body', { block: c(false), expression: c(true) }), generator: c(false), async: c(isAsync),
  params, body: branch('body', { block: child('block'), expression: child('expr') }),
});
const ARROW_RULES: Record<string, Term> = {
  arrow: arrow(false, child('parameter')),
  asyncArrow: arrow(true, child('parameter')),
  arrowIdentifier: arrow(false, list(idOf('parameter'))),
  asyncArrowIdentifier: arrow(true, list(idOf('parameter'))),
};
/** A parameter (FormalParameter): a binding element (identifier names only: patterns are not
 * mapped yet), with a default (AssignmentPattern) or rest (RestElement). A decorator on a
 * parameter is no ECMAScript (acorn rejects it), so it is not read. */
const bindingName: Term = branch('name', { ident: idOf('ident') });
const PARAM_RULES: Shape2Spec['rules'] = {
  Param: {
    plain: branch('binding', {
      single: iff(present('value'), node('AssignmentPattern', { left: bindingName, right: child('value') }), bindingName),
      rest: node('RestElement', { argument: bindingName }),
    }),
  },
};

/** The statements (ECMA-262 14), one node per Stmt arm. */
const STATEMENTS: Record<string, Term> = {
  block: child('block'),
  variable: node('VariableDeclaration', { declarations: bindings, kind: text('kind') }),
  using: node('VariableDeclaration', { declarations: bindings, kind: iff(present('awaitKeyword'), c('await using'), c('using')) }),
  if_: node('IfStatement', { test: sequenceOf('condition', 'conditionRest'), consequent: child('consequence'), alternate: orNull('alternative') }),
  while_: node('WhileStatement', { test: sequenceOf('condition', 'conditionRest'), body: child('body') }),
  do_: node('DoWhileStatement', { body: child('body'), test: sequenceOf('condition', 'conditionRest') }),
  return_: node('ReturnStatement', { argument: iff(present('argument'), sequenceOf('argument', 'argumentRest'), c(null)) }),
  throw_: node('ThrowStatement', { argument: sequenceOf('argument', 'argumentRest') }),
  break_: node('BreakStatement', { label }),
  continue_: node('ContinueStatement', { label }),
  // A Catch is not a rule of its own: the clause spans `catch` .. its block.
  try_: node('TryStatement', {
    block: child('body'),
    handler: iff(present('handler'), node('CatchClause', { param: orNull('parameter'), body: child('handler') }, { from: 'catchTok', to: 'handler' }), c(null)),
    finalizer: orNull('finalizer'),
  }),
  labelled: node('LabeledStatement', { body: child('body'), label: idOf('label') }),
  empty: node('EmptyStatement'),
  debugger_: node('DebuggerStatement'),
  with_: node('WithStatement', { object: sequenceOf('object', 'objectRest'), body: child('body') }),
  for_: branch('alt', { paren: forStatement(false), await_: forStatement(true) }),
  decl: child('decl'),
};

/** The PrimaryExpression arms Expr and NewTarget (a `new` callee) share: the literals and `this`. */
const PRIMARY: Record<string, Term> = {
  true_: literal(c(true)),
  false_: literal(c(false)),
  null_: literal(c(null)),
  undefined: node('Identifier', { name: c('undefined') }),
  this_: node('ThisExpression'),
  ident: node('Identifier', { name: cook('identifierName', 'ident') }),
  number: literal(cook('numberValue', 'number')),
  hexNumber: literal(cook('numberValue', 'hexNumber')),
  octalNumber: literal(cook('numberValue', 'octalNumber')),
  binaryNumber: literal(cook('numberValue', 'binaryNumber')),
  bigInt: literal(cook('bigintValue', 'bigInt'), { bigint: cook('bigintText', 'bigInt') }),
  string: literal(cook('stringValue', 'string')),
  regex: literal(c(null), { regex: record({ pattern: cook('regexPattern', 'regex'), flags: cook('regexFlags', 'regex') }) }),
};

export const estreeExprShape: Shape2Spec = {
  name: 'estree-expr',
  synthesized: {
    directive: { type: 'bool', default: false, rules: { Stmt: { expr: and(not(present('rest')), match(armOf('first'), { string: c(true) }, c(false))) } } },
    stringBody: { type: 'string', rules: { Expr: { string: cook('stringBody', 'string') } } },
    optional: { type: 'bool', default: false, rules: { Expr: { led_optChain: c(true), led_dot: syn('optional', 'left'), led_bracket: syn('optional', 'left'), led_paren: syn('optional', 'left') } } },
  },
  inherited: {
    functionBody: { type: 'bool', default: false, rules: Object.fromEntries(Object.entries(FUNCTION_BODIES).map(([r, arms]) => [r, Object.fromEntries(Object.entries(arms).map(([a, body]) => [a, { [body]: c(true) }]))])) },
    prologue: {
      type: 'bool', default: false, rules: {
        Program: { decl: { alt: thread(c(true), 'p', and(v('p'), branch('alt', { decl: c(false), stmt: syn('directive', 'stmt') }))) } },
        Block: { brace: { stmt: prologue(inh('functionBody')) } },
      },
    },
    chainTop: { type: 'bool', default: true, rules: { Expr: Object.fromEntries(LINKS.map((a) => [a, { left: c(false) }])) } },
  },
  rules: {
    // The root: its statement list. acorn's `sourceType` (the goal acorn was run with) and the
    // root's extent over trailing trivia are not produced (test/shape2-oracle.ts ROOT_NOT_COMPARED).
    Program: { decl: node('Program', { body: map('alt', branch('alt', { decl: child('decl'), stmt: child('stmt') })) }) },
    Stmt: { ...STATEMENTS, expr: node('ExpressionStatement', { expression: sequence, directive: iff(and(inh('prologue'), syn('directive')), syn('stringBody', 'first'), absent) }) },
    Block: { brace: node('BlockStatement', { body: child('stmt') }) },
    // A binding: identifier names (binding patterns are not mapped yet).
    Binding: { seq: node('VariableDeclarator', { id: branch('name', { ident: idOf('ident') }), init: orNull('value') }) },
    CatchParameter: { ident: idOf('ident') },
    ...PARAM_RULES,
    Decl: functionArms('FunctionDeclaration', idOf('name')),
    ...FOR_RULES,
    Expr: {
      ...PRIMARY,
      privateField: privateOf('privateField'),
      spread: node('SpreadElement', { argument: child('expr') }),
      paren: sequence,
      super_: branch('alt', {
        paren: node('CallExpression', { callee: node('Super', {}, { from: 'superKeyword', to: 'superKeyword' }), arguments: child('expr'), optional: c(false) }),
        dot: node('MemberExpression', { object: node('Super', {}, { from: 'superKeyword', to: 'superKeyword' }), property: property(), computed: c(false), optional: c(false) }),
        bracket: node('MemberExpression', { object: node('Super', {}, { from: 'superKeyword', to: 'superKeyword' }), property: child('expr'), computed: c(true), optional: c(false) }),
      }),
      led_dot: chain(member(property(), false, false)),
      led_bracket: chain(member(child('expr'), true, false)),
      led_paren: chain(node('CallExpression', { callee: child('left'), arguments: child('expr'), optional: c(false) })),
      led_optChain: chain(branch('alt', {
        ident: member(idOf('ident'), false, true),
        privateField: member(privateOf('privateField'), false, true),
        paren: node('CallExpression', { callee: child('left'), arguments: child('expr'), optional: c(true) }),
        bracket: member(child('expr'), true, true),
      })),
      led_question: node('ConditionalExpression', { test: child('left'), consequent: child('then'), alternate: child('otherwise') }),
      led_in: node('BinaryExpression', { left: child('left'), operator: c('in'), right: child('expr') }),
      led_instanceof: node('BinaryExpression', { left: child('left'), operator: c('instanceof'), right: child('expr') }),
      newDotTarget: node('MetaProperty', { meta: idOf('newKeyword', c('new')), property: idOf('targetKeyword', c('target')) }),
      construct: node('NewExpression', { callee: child('newTarget'), arguments: branch('alt', { paren: child('expr'), empty: list() }) }),
      yield_: branch('alt', {
        star: node('YieldExpression', { delegate: c(true), argument: child('expr') }),
        expr: node('YieldExpression', { delegate: c(false), argument: orElse(child('expr'), c(null)) }),
      }),
      binaryOp: node(binaryType, { left: child('left'), operator: text('op'), right: child('right') }),
      prefixOp: match(text('op'), {
        '++': node('UpdateExpression', { operator: text('op'), prefix: c(true), argument: child('operand') }),
        '--': node('UpdateExpression', { operator: text('op'), prefix: c(true), argument: child('operand') }),
        await: node('AwaitExpression', { argument: child('operand') }),
        yield: node('YieldExpression', { delegate: c(false), argument: child('operand') }),
      }, node('UnaryExpression', { operator: text('op'), prefix: c(true), argument: child('operand') })),
      ...functionArms('FunctionExpression', iff(present('name'), idOf('name'), c(null))),
      ...ARROW_RULES,
      postfixOp: node('UpdateExpression', { operator: text('op'), prefix: c(false), argument: child('operand') }),
    },
    // The callee of `new` (a MemberExpression, never a call).
    NewTarget: {
      ...PRIMARY,
      superMember: branch('alt', {
        dot: node('MemberExpression', { object: node('Super', {}, { from: 'superKeyword', to: 'superKeyword' }), property: idOf('ident'), computed: c(false), optional: c(false) }),
        bracket: node('MemberExpression', { object: node('Super', {}, { from: 'superKeyword', to: 'superKeyword' }), property: child('expr'), computed: c(true), optional: c(false) }),
      }),
      newDotTarget: node('MetaProperty', { meta: idOf('newKeyword', c('new')), property: idOf('targetKeyword', c('target')) }),
      ...functionArms('FunctionExpression', iff(present('name'), idOf('name'), c(null))),
      ident: node('Identifier', { name: cook('identifierName', 'ident') }),
      new_: node('NewExpression', { callee: child('newTarget'), arguments: child('expr') }),
      led_dot: node('MemberExpression', { object: child('left'), property: property(), computed: c(false), optional: c(false) }),
      led_bracket: node('MemberExpression', { object: child('left'), property: child('expr'), computed: c(true), optional: c(false) }),
      paren: sequence,
    },
  },
};
