// ShapeSpec v2: the EXPRESSION subset of tsc's AST (typescript 5.9, as test/shape-oracle-tsc.ts
// normalises it) from typescript.ts, in the core calculus only (src/shape2-schema.ts). Checked
// against tsc's parser by test/shape2-oracle.ts. Not total: an arm outside the subset (functions,
// classes, arrows, object / array literals, templates, type syntax) is unmapped, and an
// expression statement that reaches one is reported as outside the subset, not compared.
//
// Positions: a node's start is tsc's `getStart()` (the first token); tsc's `pos` (leading trivia
// included) is not produced (the harness compares it only when both sides carry it).
import {
  absent, and, branch, c, child, cook, fold, iff, inh, match, node, not, orElse, syn, text, v,
  type Shape2Spec, type Term,
} from '../../src/shape2-schema.ts';

/** A token node (tsc's `operatorToken`, `questionDotToken`, ...) over a named leaf. */
const token = (kind: string | Term, leaf: string): Term => node(kind, {}, { from: leaf, to: leaf });
const idOf = (leaf: string, textOf: Term = cook('identifierName', leaf)): Term => node('Identifier', { text: textOf }, { from: leaf, to: leaf });
const privateOf = (leaf: string): Term => node('PrivateIdentifier', { text: text(leaf) }, { from: leaf, to: leaf });
const numeric = (leaf: string): Term => node('NumericLiteral', { text: cook('tsNumericText', leaf), numericLiteralFlags: cook('tsNumericLiteralFlags', leaf) });
const name = (): Term => branch('alt', { ident: idOf('ident'), privateField: privateOf('privateField') });

const BINARY: Record<string, string> = {
  '=': 'EqualsToken', '+=': 'PlusEqualsToken', '-=': 'MinusEqualsToken', '*=': 'AsteriskEqualsToken', '/=': 'SlashEqualsToken',
  '%=': 'PercentEqualsToken', '**=': 'AsteriskAsteriskEqualsToken', '<<=': 'LessThanLessThanEqualsToken',
  '>>=': 'GreaterThanGreaterThanEqualsToken', '>>>=': 'GreaterThanGreaterThanGreaterThanEqualsToken', '&=': 'AmpersandEqualsToken',
  '|=': 'BarEqualsToken', '^=': 'CaretEqualsToken', '??=': 'QuestionQuestionEqualsToken', '||=': 'BarBarEqualsToken',
  '&&=': 'AmpersandAmpersandEqualsToken', '??': 'QuestionQuestionToken', '||': 'BarBarToken', '&&': 'AmpersandAmpersandToken',
  '|': 'BarToken', '^': 'CaretToken', '&': 'AmpersandToken', '==': 'EqualsEqualsToken', '!=': 'ExclamationEqualsToken',
  '===': 'EqualsEqualsEqualsToken', '!==': 'ExclamationEqualsEqualsToken', '<': 'LessThanToken', '>': 'GreaterThanToken',
  '<=': 'LessThanEqualsToken', '>=': 'GreaterThanEqualsToken', '<<': 'LessThanLessThanToken', '>>': 'GreaterThanGreaterThanToken',
  '>>>': 'GreaterThanGreaterThanGreaterThanToken', '+': 'PlusToken', '-': 'MinusToken', '*': 'AsteriskToken', '/': 'SlashToken',
  '%': 'PercentToken', '**': 'AsteriskAsteriskToken',
};
const PREFIX: Record<string, string> = { '!': 'ExclamationToken', '~': 'TildeToken', '+': 'PlusToken', '-': 'MinusToken', '++': 'PlusPlusToken', '--': 'MinusMinusToken' };
const kindOf = (table: Record<string, string>): Term => match(text('op'), Object.fromEntries(Object.entries(table).map(([k, x]) => [k, c(x)])));

/** `first (, rest)*` as tsc's left-nested comma BinaryExpression. */
const comma: Term = fold('rest', child('first'), 'acc',
  node('BinaryExpression', { left: v('acc'), operatorToken: token('CommaToken', 'comma'), right: child('rest') }, { from: 'acc', to: 'rest' }));

/** tsc's OptionalChain flag: every link of a chain that holds a `?.` (synthesized `optional`). */
const chainFlags: Term = iff(syn('optional'), c('OptionalChain'), absent);

export const tscExprShape: Shape2Spec = {
  name: 'tsc-expr',
  synthesized: {
    optional: { type: 'bool', default: false, rules: { Expr: { led_optChain: c(true), led_dot: syn('optional', 'left'), led_bracket: syn('optional', 'left'), led_paren: syn('optional', 'left'), led_bang: syn('optional', 'left') } } },
  },
  inherited: {
    // A link is the top of its chain unless it is the object / callee of another link: a
    // trailing `!` is a chain link (NonNullChain) only when a link follows it.
    chainTop: { type: 'bool', default: true, rules: { Expr: Object.fromEntries(['led_dot', 'led_optChain', 'led_bracket', 'led_paren', 'led_bang'].map((a) => [a, { left: c(false) }])) } },
  },
  rules: {
    Stmt: { expr: node('ExpressionStatement', { expression: comma }) },
    Expr: {
      true_: node('TrueKeyword'),
      false_: node('FalseKeyword'),
      null_: node('NullKeyword'),
      this_: node('ThisKeyword'),
      undefined: node('Identifier', { text: c('undefined') }),
      ident: node('Identifier', { text: cook('identifierName', 'ident') }),
      number: numeric('number'),
      hexNumber: numeric('hexNumber'),
      octalNumber: numeric('octalNumber'),
      binaryNumber: numeric('binaryNumber'),
      bigInt: node('BigIntLiteral', { text: cook('tsBigIntText', 'bigInt') }),
      string: node('StringLiteral', { text: cook('stringValue', 'string'), hasExtendedUnicodeEscape: cook('hasExtendedUnicodeEscape', 'string') }),
      regex: node('RegularExpressionLiteral', { text: text('regex') }),
      privateField: privateOf('privateField'),
      spread: node('SpreadElement', { expression: child('expr') }),
      paren: node('ParenthesizedExpression', { expression: comma }),
      super_: branch('alt', {
        paren: node('CallExpression', { expression: token('SuperKeyword', 'superKeyword'), arguments: child('expr') }),
        dot: node('PropertyAccessExpression', { expression: token('SuperKeyword', 'superKeyword'), name: name() }),
        bracket: node('ElementAccessExpression', { expression: token('SuperKeyword', 'superKeyword'), argumentExpression: child('expr') }),
      }),
      led_dot: node('PropertyAccessExpression', { expression: child('left'), name: name(), flags: chainFlags }),
      led_bracket: node('ElementAccessExpression', { expression: child('left'), argumentExpression: child('expr'), flags: chainFlags }),
      led_paren: node('CallExpression', { expression: child('left'), arguments: child('expr'), flags: chainFlags }),
      led_optChain: branch('alt', {
        ident: node('PropertyAccessExpression', { expression: child('left'), questionDotToken: token('QuestionDotToken', 'questionDot'), name: idOf('ident'), flags: c('OptionalChain') }),
        privateField: node('PropertyAccessExpression', { expression: child('left'), questionDotToken: token('QuestionDotToken', 'questionDot'), name: privateOf('privateField'), flags: c('OptionalChain') }),
        paren: node('CallExpression', { expression: child('left'), questionDotToken: token('QuestionDotToken', 'questionDot'), arguments: child('expr'), flags: c('OptionalChain') }),
        bracket: node('ElementAccessExpression', { expression: child('left'), questionDotToken: token('QuestionDotToken', 'questionDot'), argumentExpression: child('expr'), flags: c('OptionalChain') }),
      }),
      led_bang: node('NonNullExpression', { expression: child('left'), flags: iff(and(syn('optional'), not(inh('chainTop'))), c('OptionalChain'), absent) }),
      led_question: node('ConditionalExpression', {
        condition: child('left'), questionToken: token('QuestionToken', 'question'), whenTrue: child('then'),
        colonToken: token('ColonToken', 'colon'), whenFalse: child('otherwise'),
      }),
      led_in: node('BinaryExpression', { left: child('left'), operatorToken: token('InKeyword', 'inKeyword'), right: child('expr') }),
      led_instanceof: node('BinaryExpression', { left: child('left'), operatorToken: token('InstanceOfKeyword', 'instanceofKeyword'), right: child('expr') }),
      newDotTarget: node('MetaProperty', { keywordToken: c('NewKeyword'), name: idOf('targetKeyword', c('target')) }),
      construct: node('NewExpression', { expression: child('newTarget'), arguments: branch('alt', { paren: child('expr'), empty: absent }) }),
      yield_: branch('alt', {
        star: node('YieldExpression', { asteriskToken: token('AsteriskToken', 'asterisk'), expression: child('expr') }),
        expr: node('YieldExpression', { expression: orElse(child('expr'), absent) }),
      }),
      binaryOp: node('BinaryExpression', { left: child('left'), operatorToken: token(kindOf(BINARY), 'op'), right: child('right') }),
      prefixOp: match(text('op'), {
        typeof: node('TypeOfExpression', { expression: child('operand') }),
        void: node('VoidExpression', { expression: child('operand') }),
        delete: node('DeleteExpression', { expression: child('operand') }),
        await: node('AwaitExpression', { expression: child('operand') }),
        yield: node('YieldExpression', { expression: child('operand') }),
      }, node('PrefixUnaryExpression', { operator: kindOf(PREFIX), operand: child('operand') })),
      postfixOp: node('PostfixUnaryExpression', { operand: child('operand'), operator: kindOf(PREFIX) }),
    },
    NewTarget: {
      ident: node('Identifier', { text: cook('identifierName', 'ident') }),
      new_: node('NewExpression', { expression: child('newTarget'), arguments: branch('alt', { paren: child('expr') }) }),
      led_dot: node('PropertyAccessExpression', { expression: child('left'), name: idOf('ident') }),
      led_bracket: node('ElementAccessExpression', { expression: child('left'), argumentExpression: child('expr') }),
      paren: node('ParenthesizedExpression', { expression: comma }),
    },
  },
};
