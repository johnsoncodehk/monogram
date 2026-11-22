// ShapeSpec v2: a subset of tsc's AST (typescript 5.9, as test/shape-oracle-tsc.ts normalises
// it) from typescript.ts, in the core calculus only (src/shape2-schema.ts): the expressions
// below, the root, and the statements (as in shape-v2-estree-expr.ts). Checked against tsc's
// parser by test/shape2-oracle.ts. Not total: an arm outside the subset (`for`, `switch`,
// declarations, binding patterns, functions, classes, arrows, object / array literals,
// templates, type syntax) is unmapped, and a unit that reaches one is reported as outside the
// subset, not compared.
//
// Positions: a node's start is tsc's `getStart()` (the first token); tsc's `pos` (leading trivia
// included) is not produced (the harness compares it only when both sides carry it).
import {
  absent, and, branch, c, child, cook, fold, iff, inh, list, map, match, node, not, orElse, present, spread, syn, text, v,
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
const commaOf = (first: string, comma = `${first}Comma`, rest = `${first}Rest`): Term => fold(rest, child(first), 'acc',
  node('BinaryExpression', { left: v('acc'), operatorToken: token('CommaToken', comma), right: child(rest) }, { from: 'acc', to: rest }));
const comma: Term = commaOf('first', 'comma', 'rest');
/** A statement's optional label. */
const label: Term = iff(present('label'), idOf('label'), absent);
/** A declaration list spanning its keyword(s) to its last binding; `flags` from the keyword. */
const declarationList = (from: string, flags: Term): Term => {
  const declarations = list(child('binding'), spread(child('bindingRest')));
  return iff(present('bindingRest'), node('VariableDeclarationList', { declarations, flags }, { from, to: 'bindingRest' }), node('VariableDeclarationList', { declarations, flags }, { from, to: 'binding' }));
};

/** The statements (ECMA-262 14), one node per Stmt arm. */
const STATEMENTS: Record<string, Term> = {
  block: child('block'),
  variable: node('VariableStatement', { declarationList: declarationList('kind', match(text('kind'), { var: absent, let: c('Let'), const: c('Const') })) }),
  using: node('VariableStatement', {
    declarationList: iff(present('awaitKeyword'), declarationList('awaitKeyword', c('Const|Using')), declarationList('usingKeyword', c('Using'))),
  }),
  if_: node('IfStatement', { expression: commaOf('condition'), thenStatement: child('consequence'), elseStatement: child('alternative') }),
  while_: node('WhileStatement', { expression: commaOf('condition'), statement: child('body') }),
  do_: node('DoStatement', { statement: child('body'), expression: commaOf('condition') }),
  return_: node('ReturnStatement', { expression: iff(present('argument'), commaOf('argument'), absent) }),
  throw_: node('ThrowStatement', { expression: commaOf('argument') }),
  break_: node('BreakStatement', { label }),
  continue_: node('ContinueStatement', { label }),
  // A Catch is not a rule of its own: the clause spans `catch` .. its block.
  try_: node('TryStatement', {
    tryBlock: child('body'),
    catchClause: iff(present('handler'), node('CatchClause', { variableDeclaration: child('parameter'), block: child('handler') }, { from: 'catchTok', to: 'handler' }), absent),
    finallyBlock: child('finalizer'),
  }),
  labelled: node('LabeledStatement', { label: idOf('label'), statement: child('body') }),
  empty: node('EmptyStatement'),
  debugger_: node('DebuggerStatement'),
  with_: node('WithStatement', { expression: commaOf('object'), statement: child('body') }),
  decl: child('decl'),
};

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
    // The root: its statement list. The `endOfFileToken` and the root's extent over trailing
    // trivia are not produced (test/shape2-oracle.ts ROOT_NOT_COMPARED).
    Program: { decl: node('SourceFile', { statements: map('alt', branch('alt', { decl: child('decl'), stmt: child('stmt') })) }) },
    Stmt: { ...STATEMENTS, expr: node('ExpressionStatement', { expression: comma }) },
    Block: { brace: node('Block', { statements: child('stmt') }) },
    // A binding: identifier names (binding patterns are not mapped yet); a type annotation is
    // outside the subset (Type is not mapped).
    Binding: {
      seq: node('VariableDeclaration', {
        name: branch('name', { ident: idOf('ident') }),
        exclamationToken: branch('name', { ident: iff(present('exclamation'), token('ExclamationToken', 'exclamation'), absent) }),
        type: child('type'), initializer: child('value'),
      }),
    },
    CatchParameter: { ident: node('VariableDeclaration', { name: idOf('ident'), type: child('type') }) },
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
