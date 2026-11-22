// ShapeSpec v2: the EXPRESSION subset of ESTree (as acorn 8 produces it) from javascript.ts, in the
// core calculus only (src/shape2-schema.ts). Checked against acorn by test/shape2-oracle.ts.
// Not total: an arm outside the subset (functions, classes, arrows, object / array literals,
// templates) is unmapped, and an expression statement that reaches one is reported as outside
// the subset, not compared.
import {
  absent, and, armOf, branch, c, child, cook, iff, inh, list, map, match, node, not, orElse, present, record,
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
const FUNCTION_BODIES: Record<string, string[]> = {
  Expr: ['function_', 'function_2', 'async', 'async2', 'seq', 'seq2', 'seq3', 'seq4'],   // function expressions, arrows
  Decl: ['function_', 'function_2', 'async', 'async2', 'export_2'],                     // declarations, `export default function`
  Prop: ['get', 'async', 'async2', 'star', 'memberName'],                               // object methods / accessors
  ClassMember: ['seq'],                                                                  // constructor, methods, accessors
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

/** The statements (ECMA-262 14), one node per Stmt arm. */
const STATEMENTS: Record<string, Term> = {
  block: child('block'),
  variable: node('VariableDeclaration', { declarations: child('binding'), kind: text('kind') }),
  using: node('VariableDeclaration', { declarations: child('binding'), kind: iff(present('awaitKeyword'), c('await using'), c('using')) }),
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
  with_: node('WithStatement', { object: child('object'), body: child('body') }),
  decl: child('decl'),
};

export const estreeExprShape: Shape2Spec = {
  name: 'estree-expr',
  synthesized: {
    directive: { type: 'bool', default: false, rules: { Stmt: { expr: and(not(present('rest')), match(armOf('first'), { string: c(true) }, c(false))) } } },
    stringBody: { type: 'string', rules: { Expr: { string: cook('stringBody', 'string') } } },
    optional: { type: 'bool', default: false, rules: { Expr: { led_optChain: c(true), led_dot: syn('optional', 'left'), led_bracket: syn('optional', 'left'), led_paren: syn('optional', 'left') } } },
  },
  inherited: {
    functionBody: { type: 'bool', default: false, rules: Object.fromEntries(Object.entries(FUNCTION_BODIES).map(([r, arms]) => [r, Object.fromEntries(arms.map((a) => [a, { block: c(true) }]))])) },
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
    Expr: {
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
      postfixOp: node('UpdateExpression', { operator: text('op'), prefix: c(false), argument: child('operand') }),
    },
    // The callee of `new` (a MemberExpression, never a call).
    NewTarget: {
      ident: node('Identifier', { name: cook('identifierName', 'ident') }),
      new_: node('NewExpression', { callee: child('newTarget'), arguments: child('expr') }),
      led_dot: node('MemberExpression', { object: child('left'), property: idOf('ident'), computed: c(false), optional: c(false) }),
      led_bracket: node('MemberExpression', { object: child('left'), property: child('expr'), computed: c(true), optional: c(false) }),
      paren: sequence,
    },
  },
};
