// ShapeSpec v2: the EXPRESSION subset of ESTree (as acorn 8 produces it) from javascript.ts, in the
// core calculus only (src/shape2-schema.ts). Checked against acorn by test/shape2-oracle.ts.
// Not total: an arm outside the subset (functions, classes, arrows, object / array literals,
// templates) is unmapped, and an expression statement that reaches one is reported as outside
// the subset, not compared.
import {
  and, branch, c, child, cook, iff, inh, list, match, node, orElse, present, record, spread, syn,
  text, wrapIf, type Shape2Spec, type Term,
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

/** `first (, rest)*`: the expression itself, or a SequenceExpression spanning the list. */
const sequence: Term = iff(present('rest'), node('SequenceExpression', { expressions: list(child('first'), spread(child('rest'))) }, { from: 'first', to: 'rest' }), child('first'));

export const estreeExprShape: Shape2Spec = {
  name: 'estree-expr',
  synthesized: {
    optional: { type: 'bool', default: false, rules: { Expr: { led_optChain: c(true), led_dot: syn('optional', 'left'), led_bracket: syn('optional', 'left'), led_paren: syn('optional', 'left') } } },
  },
  inherited: {
    chainTop: { type: 'bool', default: true, rules: { Expr: Object.fromEntries(LINKS.map((a) => [a, { left: c(false) }])) } },
  },
  rules: {
    Stmt: { expr: node('ExpressionStatement', { expression: sequence }) },
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
