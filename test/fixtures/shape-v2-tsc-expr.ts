// ShapeSpec v2: a subset of tsc's AST (typescript 5.9, as test/shape-oracle-tsc.ts normalises
// it) from typescript.ts, in the core calculus only (src/shape2-schema.ts): the expressions
// below, the root, the statements, functions, arrows and their parameters (as in
// shape-v2-estree-expr.ts), binding patterns, object / array literals, spread and templates,
// classes, and modules (import / export, with the modifiers the wrapping arms hand a declaration).
// Checked against tsc's parser by test/shape2-oracle.ts. Not total: an arm outside the subset
// (`switch`, other declarations, an object member's modifier words, decorators, type syntax) is
// unmapped, and a unit that reaches one is reported as outside the subset, not compared.
//
// Positions: a node's start is tsc's `getStart()` (the first token); tsc's `pos` (leading trivia
// included) is not produced (the harness compares it only when both sides carry it).
import {
  absent, and, branch, c, child, cook, dropLastIf, fold, get, iff, inh, let_, map, match, node, not, or, orElse, present, record, syn, text, v, list, spread,
  type Shape2Spec, type Term,
} from '../../src/shape2-schema.ts';

/** A token node (tsc's `operatorToken`, `questionDotToken`, ...) over a named leaf. */
const token = (kind: string | Term, leaf: string): Term => node(kind, {}, { from: leaf, to: leaf });
const idOf = (leaf: string, textOf: Term = cook('identifierName', leaf)): Term => node('Identifier', { text: textOf }, { from: leaf, to: leaf });
const privateOf = (leaf: string): Term => node('PrivateIdentifier', { text: text(leaf) }, { from: leaf, to: leaf });
const numeric = (leaf: string): Term => node('NumericLiteral', { text: cook('tsNumericText', leaf), numericLiteralFlags: cook('tsNumericLiteralFlags', leaf) });
const name = (): Term => branch('alt', { ident: idOf('ident'), privateField: privateOf('privateField') });

// ── Modifiers handed down (the node-valued inherited attribute `modifiers`) ──
// tsc puts the `export` / `declare` words and the outer decorators on the INNER declaration
// (`export declare function f(): void;` is one FunctionDeclaration whose modifiers are
// [ExportKeyword, DeclareKeyword]); in the grammar they sit in the Decl arms that wrap it. Each
// wrapping arm hands the declaration the list it got with its own words appended, built only
// from what precedes the declaration; a RECEIVER places the list before its own modifiers and
// then starts at the first inherited one.
type Item = Term | { spread: Term };
/** A receiver: `fields`, and `modifiers` = the inherited ones then `own` (absent when both are
 * empty: `ownPresent` says whether `own` is). With inherited modifiers the node spans from the
 * first of them to the end of its arm. */
const receiver = (type: string | Term, own: Item[], ownPresent: Term, fields: Record<string, Term>): Term =>
  let_('$modifiers', inh('modifiers'), let_('$arm', absent, iff(present('$modifiers'),
    node(type, { modifiers: list(spread(v('$modifiers')), ...own), ...fields }, { from: '$modifiers', to: '$arm' }),
    node(type, { modifiers: iff(ownPresent, list(...own), absent), ...fields }))));
/** What a wrapping arm hands its declaration: what it got, then its own words. */
const handDown = (...own: Item[]): Term => list(spread(inh('modifiers')), ...own);

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

// ── `for` (ECMA-262 14.7.4, 14.7.5) ──
// The grammar factors a `for` statement's `( … )` into ForHead / ForAwaitHead, whose node is not
// the statement's: both heads are RECORD-VALUED (an interface: `get`), and Stmt.for_ builds
// For / ForIn / ForOfStatement from the head's fields and its own body.
type Tail = 'classic' | 'in_' | 'of';
/** A head's declaration list: its keyword(s) to its last binding. */
const headDeclarations = (from: string, flags: Term, rest: boolean): Term => {
  const list_ = (to: string, declarations: Term): Term => node('VariableDeclarationList', { declarations, flags }, { from, to });
  return rest
    ? iff(present('bindingRest'), list_('bindingRest', list(child('binding'), spread(child('bindingRest')))), list_('binding', list(child('binding'))))
    : list_('binding', list(child('binding')));
};
const optComma = (first: string): Term => iff(present(first), commaOf(first), absent);
type HeadFields = { kind: Term; initializer: Term; condition: Term; incrementor: Term; expression: Term };
const head = (f: Partial<HeadFields>): Term => record({ kind: f.kind!, initializer: f.initializer ?? absent, condition: f.condition ?? absent, incrementor: f.incrementor ?? absent, expression: f.expression ?? absent });
const KEYWORD_FLAGS = match(text('kind'), { var: absent, let: c('Let'), const: c('Const') });
const declarationHead = (tails: Tail[], usingTails: Tail[]): Term => {
  const f = (pick: (declarations: (rest: boolean) => Term, t: Tail) => Term): Term => branch('alt', {
    let_: branch('tail', Object.fromEntries(tails.map((t) => [t, pick((rest) => headDeclarations('kind', KEYWORD_FLAGS, rest), t)]))),
    using: branch('tail', Object.fromEntries(usingTails.map((t) => [t, pick((rest) => headDeclarations('kind', branch('kind', { using: c('Using'), await_: c('Const|Using') }), rest), t)]))),
  });
  return head({
    kind: f((_, t) => c(t === 'classic' ? 'for' : t === 'in_' ? 'in' : 'of')),
    initializer: f((d, t) => d(t === 'classic')),
    condition: f((_, t) => (t === 'classic' ? optComma('condition') : absent)),
    incrementor: f((_, t) => (t === 'classic' ? optComma('increment') : absent)),
    expression: f((_, t) => (t === 'in_' ? commaOf('right') : t === 'of' ? child('right') : absent)),
  });
};
const forStatement = (awaitModifier: Term): Term => match(get('head', 'kind'), {
  for: node('ForStatement', { initializer: get('head', 'initializer'), condition: get('head', 'condition'), incrementor: get('head', 'incrementor'), statement: child('body') }),
  in: node('ForInStatement', { initializer: get('head', 'initializer'), expression: get('head', 'expression'), statement: child('body') }),
  of: node('ForOfStatement', { awaitModifier, initializer: get('head', 'initializer'), expression: get('head', 'expression'), statement: child('body') }),
});
const FOR_RULES: Shape2Spec['rules'] = {
  ForHead: {
    declaration: declarationHead(['classic', 'in_', 'of'], ['classic', 'of']),
    classic: head({ kind: c('for'), initializer: optComma('initializer'), condition: optComma('condition'), incrementor: optComma('increment') }),
    in_: head({ kind: c('in'), initializer: child('left'), expression: commaOf('right') }),
    of: head({ kind: c('of'), initializer: child('left'), expression: child('right') }),
  },
  ForAwaitHead: {
    declaration: declarationHead(['of'], ['of']),
    of: head({ kind: c('of'), initializer: child('left'), expression: child('right') }),
  },
  ForBinding: { seq: node('VariableDeclaration', { name: target('name'), type: child('type'), initializer: child('value') }) },
};

/** The statements (ECMA-262 14), one node per Stmt arm. */
const STATEMENTS: Record<string, Term> = {
  block: child('block'),
  variable: receiver('VariableStatement', [], c(false), { declarationList: declarationList('kind', match(text('kind'), { var: absent, let: c('Let'), const: c('Const') })) }),
  using: receiver('VariableStatement', [], c(false), {
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
  for_: branch('alt', { paren: forStatement(absent), await_: forStatement(token('AwaitKeyword', 'awaitKeyword')) }),
  decl: child('decl'),
};

// ── Functions ──
// Four arms per form (plain, generator, async, async generator). tsc's `modifiers` holds the
// `async` keyword (and, on a declaration, the `export` / `declare` / `default` words the wrapping
// arms hand it: `receiver`); `asteriskToken` the generator's `*`.
type FnArm = 'function_' | 'generator' | 'asyncFunction' | 'asyncGenerator';
const FUNCTIONS: FnArm[] = ['function_', 'generator', 'asyncFunction', 'asyncGenerator'];
const asyncModifier: Term = list(token('AsyncKeyword', 'asyncKeyword'));
/** A return type: a type, or a type predicate `x is T` (not mapped yet: types are not mapped). */
const returnType: Term = branch('returnType', { type: child('type') });
const isAsyncFn = (a: FnArm): boolean => a === 'asyncFunction' || a === 'asyncGenerator';
const fnFields = (a: FnArm, name: Term, body: Term, modifiers = true): Record<string, Term> => ({
  ...(modifiers && isAsyncFn(a) ? { modifiers: asyncModifier } : {}),
  ...(a === 'generator' || a === 'asyncGenerator' ? { asteriskToken: token('AsteriskToken', 'asterisk') } : {}),
  name,
  typeParameters: child('typeParameters'), parameters: child('parameter'), type: returnType, body,
});
// A declaration's body is a block, or none (an overload or an ambient signature). It receives the
// modifiers of the arms that wrap it, then its own (`own`, and `async`).
const functionDeclaration = (a: FnArm, name: Term, own: Item[] = [], ownPresent: Term = c(false)): Term => receiver('FunctionDeclaration',
  [...own, ...(isAsyncFn(a) ? [token('AsyncKeyword', 'asyncKeyword')] : [])], isAsyncFn(a) ? c(true) : ownPresent,
  fnFields(a, name, branch('body', { block: child('block'), semi: absent }), false));
const FUNCTION_DECLARATIONS = Object.fromEntries(FUNCTIONS.map((a) => [a, functionDeclaration(a, idOf('name'))]));
const FUNCTION_EXPRESSIONS = Object.fromEntries(FUNCTIONS.map((a) => [a, node('FunctionExpression', fnFields(a, iff(present('name'), idOf('name'), absent), child('body')))]));
/** An arrow: a parenthesised parameter list (`parameter` repeats) or one identifier (a Parameter
 * over it); a block or an expression body (ConciseBody). */
const arrow = (isAsync: boolean, parameters: Term, typed: boolean): Term => node('ArrowFunction', {
  ...(isAsync ? { modifiers: asyncModifier } : {}),
  ...(typed ? { typeParameters: child('typeParameters'), parameters, type: returnType } : { parameters }),
  equalsGreaterThanToken: token('EqualsGreaterThanToken', 'arrow'),
  body: branch('body', { block: child('block'), expression: child('expr') }),
});
const bareParameter: Term = list(node('Parameter', { name: idOf('parameter') }, { from: 'parameter', to: 'parameter' }));
const ARROWS: Record<string, Term> = {
  arrow: arrow(false, child('parameter'), true),
  asyncArrow: arrow(true, child('parameter'), true),
  arrowIdentifier: arrow(false, bareParameter, false),
  asyncArrowIdentifier: arrow(true, bareParameter, false),
};
// ── Binding patterns ──
// tsc's BindingElement holds a property's key (`propertyName`) beside the element's own name
// and initializer, so the grammar's BindingElement rule (`name = value`) is RECORD-VALUED here:
// each parent builds the BindingElement node from its fields (`get`). A hole is an
// OmittedExpression: zero width at the end of the token before it (`[` or the iteration's `,`:
// tsc builds it at getNodePos), so it is a node with an `after` span; both oracles drop the
// final hole (`finalHole`).
function target(alt: string): Term { return branch(alt, { ident: idOf('ident'), bindingPattern: child('bindingPattern') }); }
const omitted = (after: string): Term => node('OmittedExpression', {}, { after });
const finalHole = (first: string, over: string, rest: string): Term => fold(over, not(present(first)), 'h', not(present(rest)));
const fromElement = (extra: Record<string, Term>, element = 'value'): Term =>
  node('BindingElement', { ...extra, name: get(element, 'name'), initializer: get(element, 'initializer') });
const PATTERN_RULES: Shape2Spec['rules'] = {
  BindingPattern: {
    object: node('ObjectBindingPattern', { elements: child('property') }),
    array: node('ArrayBindingPattern', {
      elements: dropLastIf(finalHole('element', 'comma', 'elementRest'),
        list(orElse(child('element'), omitted('bracket')), spread(map('comma', orElse(child('elementRest'), omitted('comma')))))),
    }),
  },
  BindingProperty: {
    identPair: fromElement({ propertyName: idOf('key') }),
    shorthand: node('BindingElement', { name: idOf('name'), initializer: child('value') }),
    pair: fromElement({
      propertyName: branch('key', {
        string: node('StringLiteral', { text: cook('stringValue', 'string'), hasExtendedUnicodeEscape: cook('hasExtendedUnicodeEscape', 'string') }, { from: 'string', to: 'string' }),
        number: node('NumericLiteral', { text: cook('tsNumericText', 'number'), numericLiteralFlags: cook('tsNumericLiteralFlags', 'number') }, { from: 'number', to: 'number' }),
        hexNumber: node('NumericLiteral', { text: cook('tsNumericText', 'hexNumber'), numericLiteralFlags: cook('tsNumericLiteralFlags', 'hexNumber') }, { from: 'hexNumber', to: 'hexNumber' }),
        octalNumber: node('NumericLiteral', { text: cook('tsNumericText', 'octalNumber'), numericLiteralFlags: cook('tsNumericLiteralFlags', 'octalNumber') }, { from: 'octalNumber', to: 'octalNumber' }),
        binaryNumber: node('NumericLiteral', { text: cook('tsNumericText', 'binaryNumber'), numericLiteralFlags: cook('tsNumericLiteralFlags', 'binaryNumber') }, { from: 'binaryNumber', to: 'binaryNumber' }),
        bigInt: node('BigIntLiteral', { text: cook('tsBigIntText', 'bigInt') }, { from: 'bigInt', to: 'bigInt' }),
        computed: node('ComputedPropertyName', { expression: child('expr') }, { from: 'bracket', to: 'bracketClose' }),
      }),
    }),
    // `...r` / `...{ a }`; tsc also parses `...r: x = 1` (a checker error), where `r` is the key.
    rest: iff(present('element'),
      fromElement({ dotDotDotToken: token('DotDotDotToken', 'ellipsis'), propertyName: target('argument') }, 'element'),
      node('BindingElement', { dotDotDotToken: token('DotDotDotToken', 'ellipsis'), name: target('argument'), initializer: child('value') })),
  },
  BindingElement: { seq: record({ name: target('name'), initializer: child('value') }) },
  ArrayBindingElement: {
    bindingElement: fromElement({}, 'bindingElement'),
    rest: node('BindingElement', { dotDotDotToken: token('DotDotDotToken', 'ellipsis'), name: target('argument') }),
  },
};

/** A parameter: tsc's Parameter; its decorators are `modifiers`. The modifier-word arm
 * (`public x`) is not mapped yet (classes). Identifier names only: patterns are not mapped yet. */
const parameter = (rest: boolean): Term => node('Parameter', {
  modifiers: iff(present('decorator'), child('decorator'), absent),
  ...(rest ? { dotDotDotToken: token('DotDotDotToken', 'ellipsis') } : {}),
  name: target('name'),
  questionToken: iff(present('question'), token('QuestionToken', 'question'), absent),
  type: child('type'), initializer: child('value'),
});
const PARAM_RULES: Shape2Spec['rules'] = {
  Param: {
    thisParameter: node('Parameter', { name: idOf('thisKeyword', c('this')), type: child('type') }),
    plain: branch('binding', { single: parameter(false), rest: parameter(true) }),
  },
};

/** tsc's OptionalChain flag: every link of a chain that holds a `?.` (synthesized `optional`). */
const chainFlags: Term = iff(syn('optional'), c('OptionalChain'), absent);

// ── Object and array literals, templates ──
// tsc keeps an object / array literal on the left of `=` as it is (no pattern reinterpretation),
// so this shape has no right-dependent equation.
/** A property name (MemberName); a computed one holds a comma list (a checker error, parsed). */
const KEY_RULES: Shape2Spec['rules'] = {
  MemberName: {
    ident: idOf('ident'),
    privateField: privateOf('privateField'),
    string: node('StringLiteral', { text: cook('stringValue', 'string'), hasExtendedUnicodeEscape: cook('hasExtendedUnicodeEscape', 'string') }),
    number: numeric('number'),
    hexNumber: numeric('hexNumber'),
    octalNumber: numeric('octalNumber'),
    binaryNumber: numeric('binaryNumber'),
    bigInt: node('BigIntLiteral', { text: cook('tsBigIntText', 'bigInt') }),
    computed: node('ComputedPropertyName', { expression: commaOf('expr', 'comma', 'exprRest') }),
  },
};
/** Evaluate `inner` only when the repeated child `name` has no element: a modifier word or a
 * decorator of an object-literal member (a checker error, parsed) is not mapped yet (classes),
 * so a member that has one is outside the subset. */
const without = (name: string, inner: Term): Term => let_('$none', list(spread(map(name, branch(name, {})))), inner);
const marks: Record<string, Term> = {
  questionToken: iff(present('question'), token('QuestionToken', 'question'), absent),
  exclamationToken: iff(present('exclamation'), token('ExclamationToken', 'exclamation'), absent),
};
/** One object-literal member (the inner alternation `member`), after its modifiers (`async`). */
const objectMember = (isAsync: boolean): Term => {
  const modifiers = isAsync ? { modifiers: list(token('AsyncKeyword', 'asyncWord')) } : {};
  const sig = { typeParameters: child('typeParameters'), parameters: child('parameter'), type: returnType, body: branch('body', { block: child('block') }) };
  return branch('member', {
    ...(isAsync ? {} : { accessor: node(match(text('kind'), { get: c('GetAccessor'), set: c('SetAccessor') }), { name: child('key'), ...sig }) }),
    generatorMethod: node('MethodDeclaration', { ...modifiers, asteriskToken: token('AsteriskToken', 'asterisk'), name: child('key'), ...marks, ...sig }),
    named: branch('tail', {
      method: node('MethodDeclaration', { ...modifiers, name: child('key'), ...marks, ...sig }),
      ...(isAsync ? {} : { init: node('PropertyAssignment', { name: child('key'), ...marks, initializer: child('value') }) }),
    }),
    ...(isAsync ? {} : {
      shorthand: node('ShorthandPropertyAssignment', {
        name: idOf('name'), ...marks, equalsToken: iff(present('equals'), token('EqualsToken', 'equals'), absent), objectAssignmentInitializer: child('value'),
      }),
    }),
  });
};
const PROP_RULES: Shape2Spec['rules'] = {
  Prop: {
    spread: node('SpreadAssignment', { expression: child('argument') }),
    member: without('word', branch('form', {
      async: without('word', iff(present('staticWord'), branch('staticWord', {}), objectMember(true))),
      plain: objectMember(false),
    })),
  },
};
const arrayElements: Term = dropLastIf(finalHole('element', 'comma', 'elementRest'),
  list(orElse(child('element'), omitted('bracket')), spread(map('comma', orElse(child('elementRest'), omitted('comma'))))));
/** A template part: tsc's text, raw text and escape flags, over the whole token. */
const templatePart = (kind: string, leaf: string): Term => node(kind, {
  text: cook('tsTemplateText', leaf), rawText: cook('tsTemplateRawText', leaf), templateFlags: cook('tsTemplateFlags', leaf),
  hasExtendedUnicodeEscape: iff(cook('hasExtendedUnicodeEscape', leaf), c(true), absent),
}, { from: leaf, to: leaf });
const templateOf = (name: string): Term => branch(name, {
  noSubstitution: templatePart('NoSubstitutionTemplateLiteral', 'quasi'),
  substitution: node('TemplateExpression', {
    head: templatePart('TemplateHead', 'head'),
    templateSpans: map('expr', node('TemplateSpan', {
      expression: child('expr'),
      literal: branch('part', { middle: templatePart('TemplateMiddle', 'literal'), tail: templatePart('TemplateTail', 'literal') }),
    }, { from: 'expr', to: 'part' })),
  }, { from: name, to: name }),
});
const LITERALS: Record<string, Term> = {
  array: node('ArrayLiteralExpression', { elements: arrayElements }),
  object: node('ObjectLiteralExpression', { properties: child('property') }),
  template: templateOf('template'),
  led_template: node('TaggedTemplateExpression', { tag: child('left'), template: templateOf('template') }),
};

/** The PrimaryExpression arms Expr and NewTarget (a `new` callee) share: the literals and `this`. */
const PRIMARY: Record<string, Term> = {
  true_: node('TrueKeyword'),
  false_: node('FalseKeyword'),
  null_: node('NullKeyword'),
  this_: node('ThisKeyword'),
  ident: node('Identifier', { text: cook('identifierName', 'ident') }),
  number: numeric('number'),
  hexNumber: numeric('hexNumber'),
  octalNumber: numeric('octalNumber'),
  binaryNumber: numeric('binaryNumber'),
  bigInt: node('BigIntLiteral', { text: cook('tsBigIntText', 'bigInt') }),
  string: node('StringLiteral', { text: cook('stringValue', 'string'), hasExtendedUnicodeEscape: cook('hasExtendedUnicodeEscape', 'string') }),
  regex: node('RegularExpressionLiteral', { text: text('regex') }),
};

// ── Classes ──
// A modifier word is its keyword token. tsc's `modifiers` list holds the decorators and the words
// in source order, and is absent when empty. A class that an `export` / `declare` / prefix arm
// wraps receives that arm's words first (`receiver`).
const KEYWORDS: Record<string, string> = {
  public: 'PublicKeyword', private: 'PrivateKeyword', protected: 'ProtectedKeyword', static: 'StaticKeyword', abstract: 'AbstractKeyword',
  readonly: 'ReadonlyKeyword', override: 'OverrideKeyword', accessor: 'AccessorKeyword', declare: 'DeclareKeyword', export: 'ExportKeyword',
  in: 'InKeyword', out: 'OutKeyword', const: 'ConstKeyword', default: 'DefaultKeyword', async: 'AsyncKeyword',
};
const keyword = (leaf: string): Term => token(match(text(leaf), Object.fromEntries(Object.entries(KEYWORDS).map(([k, x]) => [k, c(x)]))), leaf);
/** A modifier run's words (`modifierRun`'s names). */
const runWords = (m = 'modifier', s = 'staticModifier', a = 'modifierAfterStatic'): (Term | { spread: Term })[] =>
  [spread(map(m, keyword(m))), spread(iff(present(s), list(keyword(s)), list())), spread(map(a, keyword(a)))];
/** A `modifiers` list from its items, absent when none of the named children is present. */
const modifiersOf = (names: string[], items: (Term | { spread: Term })[]): Term => iff(or(...names.map(present)), list(...items), absent);
const RUN = ['modifier', 'staticModifier', 'modifierAfterStatic'];
/** A heritage element's top: tsc's ExpressionWithTypeArguments around it (`heritageElement`). */
const asElement = (expression: Term): Term => let_('$e', expression, iff(inh('heritageElement'), node('ExpressionWithTypeArguments', { expression: v('$e') }), v('$e')));
/** A heritage element (ClassHeritage, valued under `heritageElement`). */
const element = (name: string): Term => branch(name, { classHeritage: child('base') });
/** A clause: from its keyword to its last element (to the keyword when it has none: `extends {`). */
const heritageClause = (kw: string): Term => {
  const clause = (types: Term, to: string): Term => node('HeritageClause', { token: c(kw), types }, { from: 'keyword', to });
  return branch('elements', {
    list: iff(present('elementRest'), clause(map('elementRest', element('elementRest')), 'elements'), clause(list(), 'keyword')),
    first: clause(list(element('element'), spread(map('elementRest', element('elementRest')))), 'elements'),
  });
};
const heritageClauses: Term = map('heritage', branch('heritage', { extends_: heritageClause('ExtendsKeyword'), implements: heritageClause('ImplementsKeyword') }));
const classFields = (nameTerm: Term): Record<string, Term> => ({
  name: nameTerm, typeParameters: child('typeParameters'), heritageClauses: iff(present('heritage'), heritageClauses, absent), members: child('member'),
});
const memberSig: Record<string, Term> = {
  typeParameters: child('typeParameters'), parameters: child('parameter'), type: returnType, body: branch('body', { block: child('block'), semi: absent }),
};
/** A member's modifiers: its decorators (not mapped yet), the run, and the words of an `async` form. */
const memberModifiers = (isAsync: boolean): Term => isAsync
  ? list(spread(child('decorator')), ...runWords(), keyword('asyncWord'), spread(map('wordAfterAsync', keyword('wordAfterAsync'))))
  : modifiersOf(['decorator', ...RUN], [spread(child('decorator')), ...runWords()]);
const property = (isAsync: boolean): Term => node('PropertyDeclaration', {
  modifiers: memberModifiers(isAsync), name: child('key'), ...marks, type: child('type'), initializer: child('value'),
});
const method = (isAsync: boolean, generator: boolean): Term => node('MethodDeclaration', {
  modifiers: memberModifiers(isAsync), ...(generator ? { asteriskToken: token('AsteriskToken', 'asterisk') } : {}), name: child('key'),
  questionToken: marks.questionToken, ...memberSig,
});
const constructorOf = (isAsync: boolean): Term => node('Constructor', { modifiers: memberModifiers(isAsync), ...memberSig });
/** A method named `constructor` (the identifier, or a string whose value it is) is tsc's
 * Constructor (parseClassElement tries a constructor at either token before any other member,
 * unless a `*` precedes it). */
const methodOrConstructor = (isAsync: boolean): Term => iff(syn('constructorName', 'key'), constructorOf(isAsync), method(isAsync, false));
const accessor = (isAsync: boolean): Term => node(match(text('kind'), { get: c('GetAccessor'), set: c('SetAccessor') }), { modifiers: memberModifiers(isAsync), name: child('key'), ...memberSig });
const CLASS_RULES: Shape2Spec['rules'] = {
  ClassMember: {
    empty: node('SemicolonClassElement'),
    staticBlock: node('ClassStaticBlockDeclaration', { modifiers: modifiersOf(['decorator', 'modifier'], [spread(child('decorator')), spread(map('modifier', keyword('modifier')))]), body: child('block') }),
    member: branch('form', {
      asyncGeneratorMethod: method(true, true),
      asyncAccessor: accessor(true),
      asyncMethod: methodOrConstructor(true),
      generatorMethod: method(false, true),
      accessor: accessor(false),
      constructor: constructorOf(false),
      named: branch('tail', { method: methodOrConstructor(false), field: property(false) }),
      asyncField: property(true),
    }),
  },
  // A heritage element's expression; tsc wraps it in an ExpressionWithTypeArguments, with the type
  // arguments of `Base<T>`. The member / call tails after the base are the chain's own nodes.
  ClassHeritage: {
    newTarget: asElement(child('newTarget')),
    led_lt: node('ExpressionWithTypeArguments', { expression: child('left'), typeArguments: child('type') }),
    led_dot: asElement(node('PropertyAccessExpression', { expression: child('left'), name: name() })),
    led_bracket: asElement(node('ElementAccessExpression', { expression: child('left'), argumentExpression: commaOf('expr', 'exprComma', 'exprRest') })),
    led_paren: asElement(node('CallExpression', { expression: child('left'), arguments: child('expr') })),
    led_template: asElement(node('TaggedTemplateExpression', { tag: child('left'), template: templateOf('template') })),
  },
};
const classDeclarations = (own: Item[], ownPresent: Term, nameTerm: Term = idOf('name')): Record<string, Term> => ({
  namedClass: receiver('ClassDeclaration', own, ownPresent, classFields(nameTerm)),
  anonymousClass: receiver('ClassDeclaration', own, ownPresent, classFields(absent)),
});
const prefixWords: Term = branch('prefix', {
  decorated: list(spread(child('decorator')), ...runWords()),
  modified: branch('alt', { plain: list(...runWords()), static_: list(keyword('staticModifier'), spread(map('modifierAfterStatic', keyword('modifierAfterStatic')))) }),
});
const CLASS_DECLARATIONS: Record<string, Term> = {
  ...classDeclarations([], c(false)),
  // A class takes the prefix as its own; any other declaration (`other`) receives it.
  prefixed: branch('declaration', { ...classDeclarations([spread(prefixWords)], c(true)), other: child('decl') }),
};
const classExpressionModifiers = modifiersOf(
  ['decorator', ...RUN, 'decoratorRest', 'modifierRest', 'staticModifierRest', 'modifierRestAfterStatic'],
  [spread(child('decorator')), ...runWords(), spread(child('decoratorRest')), ...runWords('modifierRest', 'staticModifierRest', 'modifierRestAfterStatic')],
);
const CLASS_EXPRESSIONS: Record<string, Term> = {
  namedClass: node('ClassExpression', { modifiers: classExpressionModifiers, ...classFields(idOf('name')) }),
  anonymousClass: node('ClassExpression', { modifiers: classExpressionModifiers, ...classFields(absent) }),
};

// ── Modules ──
// A module specifier is a StringLiteral; its attributes an ImportAttributes node from `with` to
// `}`. A specifier's ModuleExportName is an Identifier or a StringLiteral; a renamed one holds the
// name it reads as `propertyName`.
const stringLiteral = (leaf: string): Term => node('StringLiteral', { text: cook('stringValue', leaf), hasExtendedUnicodeEscape: cook('hasExtendedUnicodeEscape', leaf) }, { from: leaf, to: leaf });
const exportName = (n: string): Term => branch(n, { ident: idOf('ident'), string: stringLiteral('string') });
const importAttribute = (key: string, value: string): Term => node('ImportAttribute', { name: exportName(key), value: stringLiteral(value) }, { from: key, to: value });
const moduleFields: Record<string, Term> = {
  moduleSpecifier: stringLiteral('source'),
  attributes: iff(present('withKeyword'), node('ImportAttributes', {
    elements: iff(present('attributeKey'), list(importAttribute('attributeKey', 'attributeValue'), spread(map('attributeKeyRest', importAttribute('attributeKeyRest', 'attributeValueRest')))), list()),
    token: c('WithKeyword'),
  }, { from: 'withKeyword', to: 'attributesClose' }), absent),
};
/** `export { … } from "m"`: the module part is optional. */
const optionalModule: Record<string, Term> = {
  moduleSpecifier: iff(present('source'), moduleFields.moduleSpecifier, absent), attributes: iff(present('source'), moduleFields.attributes, absent),
};
const namedImports: Term = node('NamedImports', { elements: child('specifier') }, { from: 'brace', to: 'braceClose' });
const namespaceImport: Term = node('NamespaceImport', { name: idOf('namespace') }, { from: 'star', to: 'namespace' });
const exportKeyword: Term = token('ExportKeyword', 'exportKeyword');
const typeOnly: Term = present('typeKeyword');
/** An import clause's parts. tsc's ImportClause also spans a `type` that the Decl arm reads, so
 * ImportClause is RECORD-VALUED and the import arm builds the node. */
const MODULE_RULES: Shape2Spec['rules'] = {
  ImportClause: {
    deferNamespace: record({ name: absent, namedBindings: namespaceImport, phaseModifier: c('DeferKeyword') }),
    defaultBinding: record({ name: idOf('name'), namedBindings: iff(present('bindings'), branch('bindings', { named: namedImports, namespace: namespaceImport }), absent), phaseModifier: absent }),
    named: record({ name: absent, namedBindings: namedImports, phaseModifier: absent }),
    namespace: record({ name: absent, namedBindings: namespaceImport, phaseModifier: absent }),
  },
  ImportSpecifier: {
    renamed: node('ImportSpecifier', { propertyName: idOf('imported'), name: idOf('local'), isTypeOnly: typeOnly }),
    plain: node('ImportSpecifier', { name: idOf('local'), isTypeOnly: typeOnly }),
    stringRenamed: node('ImportSpecifier', { propertyName: stringLiteral('imported'), name: idOf('local'), isTypeOnly: typeOnly }),
  },
  ExportSpecifier: {
    typed: node('ExportSpecifier', { propertyName: iff(present('exported'), exportName('local'), absent), name: iff(present('exported'), exportName('exported'), exportName('local')), isTypeOnly: c(true) }),
    typedAs: branch('rename', {
      none: node('ExportSpecifier', { name: idOf('local'), isTypeOnly: c(true) }),
      renamed: node('ExportSpecifier', { propertyName: idOf('local'), name: exportName('exported'), isTypeOnly: c(true) }),
    }),
    specifier: node('ExportSpecifier', { propertyName: iff(present('exported'), exportName('local'), absent), name: iff(present('exported'), exportName('exported'), exportName('local')), isTypeOnly: c(false) }),
  },
  // `require("m")`, or an EntityName (a left-nested QualifiedName chain). A `require` of a
  // non-string expression (a checker error, parsed) is not mapped.
  ModuleReference: {
    external: branch('argument', { string: node('ExternalModuleReference', { expression: stringLiteral('string') }, { from: 'requireKeyword', to: 'parenClose' }) }),
    entityName: fold('rest', idOf('first'), 'acc', node('QualifiedName', { left: v('acc'), right: idOf('rest') }, { from: 'acc', to: 'rest' })),
  },
};
const importClause = (from: string, isTypeOnly: boolean): Term => node('ImportClause', {
  name: get('clause', 'name'), namedBindings: get('clause', 'namedBindings'),
  phaseModifier: isTypeOnly ? c('TypeKeyword') : get('clause', 'phaseModifier'), isTypeOnly: c(isTypeOnly),
}, { from, to: 'clause' });
const exportDeclaration = (fields: Record<string, Term>): Term => receiver('ExportDeclaration', [], c(false), fields);
const namedExports: Term = node('NamedExports', { elements: child('specifier') }, { from: 'brace', to: 'braceClose' });
const MODULE_DECLARATIONS: Record<string, Term> = {
  // The wrapping arms: the declaration receives `export` / `declare` (inherited `modifiers`).
  exportDeclaration: branch('declaration', { decl: child('decl'), variable: child('stmt') }),
  declared: branch('declaration', { decl: child('decl'), statement: child('stmt') }),
  // `export default`: its words are the declaration's own modifiers; an expression is an
  // ExportAssignment. The decorated forms (decorators are not mapped) and an interface (types) are not.
  exportDefault: let_('$default', branch('defaultWord', { plain: list(token('DefaultKeyword', 'defaultKeyword')) }), branch('declaration', {
    ...Object.fromEntries(FUNCTIONS.map((a) => [a, functionDeclaration(a, iff(present('name'), idOf('name'), absent), [exportKeyword, spread(v('$default'))], c(true))])),
    ...classDeclarations([exportKeyword, spread(v('$default')), spread(child('decorator')), spread(iff(present('abstractKeyword'), list(token('AbstractKeyword', 'abstractKeyword')), list()))], c(true)),
    expression: receiver('ExportAssignment', [], c(false), { expression: child('expr') }),
  })),
  exportAll: exportDeclaration({
    exportClause: iff(present('exported'), node('NamespaceExport', { name: exportName('exported') }, { from: 'star', to: 'exported' }), absent),
    ...moduleFields, isTypeOnly: typeOnly,
  }),
  exportNamed: exportDeclaration({ exportClause: namedExports, ...optionalModule, isTypeOnly: c(false) }),
  exportNamedType: exportDeclaration({ exportClause: namedExports, ...optionalModule, isTypeOnly: c(true) }),
  exportEquals: receiver('ExportAssignment', [], c(false), { expression: child('expr'), isExportEquals: c(true) }),
  exportAsNamespace: receiver('NamespaceExportDeclaration', [], c(false), { name: idOf('name') }),
  importDeclaration: branch('form', {
    clause: receiver('ImportDeclaration', [], c(false), { importClause: importClause('clause', false), ...moduleFields }),
    typeClause: receiver('ImportDeclaration', [], c(false), { importClause: importClause('typeKeyword', true), ...moduleFields }),
    bare: receiver('ImportDeclaration', [], c(false), moduleFields),
    equals: receiver('ImportEqualsDeclaration', [], c(false), { name: idOf('name'), moduleReference: child('reference'), isTypeOnly: c(false) }),
    typeEquals: receiver('ImportEqualsDeclaration', [], c(false), { name: idOf('name'), moduleReference: child('reference'), isTypeOnly: c(true) }),
  }),
};

export const tscExprShape: Shape2Spec = {
  name: 'tsc-expr',
  synthesized: {
    optional: { type: 'bool', default: false, rules: { Expr: { led_optChain: c(true), led_dot: syn('optional', 'left'), led_bracket: syn('optional', 'left'), led_paren: syn('optional', 'left'), led_bang: syn('optional', 'left') } } },
    // A property key that names the constructor: the identifier (its StringValue: an escaped spelling too) or a string whose value it is.
    constructorName: { type: 'bool', default: false, rules: { MemberName: { ident: match(cook('identifierName', 'ident'), { constructor: c(true) }, c(false)), string: match(cook('stringValue', 'string'), { constructor: c(true) }, c(false)) } } },
  },
  inherited: {
    // A link is the top of its chain unless it is the object / callee of another link: a
    // trailing `!` is a chain link (NonNullChain) only when a link follows it.
    chainTop: { type: 'bool', default: true, rules: { Expr: Object.fromEntries(['led_dot', 'led_optChain', 'led_bracket', 'led_paren', 'led_bang'].map((a) => [a, { left: c(false) }])) } },
    // A heritage clause's element (its top ClassHeritage node) is an ExpressionWithTypeArguments.
    // The modifiers the arms wrapping a declaration hand it (see `receiver`): L-attributed by
    // construction (each equation reads only what precedes the declaration).
    modifiers: {
      type: 'nodes', rules: {
        Decl: {
          exportDeclaration: { decl: handDown(exportKeyword), stmt: handDown(exportKeyword) },
          declared: { decl: handDown(token('DeclareKeyword', 'declareKeyword')), stmt: handDown(token('DeclareKeyword', 'declareKeyword')) },
          prefixed: { decl: handDown(spread(prefixWords)) },
        },
      },
    },
    heritageElement: {
      type: 'bool', default: false,
      rules: { Decl: { namedClass: { base: c(true) }, anonymousClass: { base: c(true) }, prefixed: { base: c(true) }, exportDefault: { base: c(true) } }, Expr: { namedClass: { base: c(true) }, anonymousClass: { base: c(true) } } },
    },
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
        name: target('name'),
        exclamationToken: branch('name', { ident: iff(present('exclamation'), token('ExclamationToken', 'exclamation'), absent), bindingPattern: absent }),
        type: child('type'), initializer: child('value'),
      }),
    },
    ...PARAM_RULES,
    ...PATTERN_RULES,
    Decl: { ...FUNCTION_DECLARATIONS, ...CLASS_DECLARATIONS, ...MODULE_DECLARATIONS },
    ...MODULE_RULES,
    ...CLASS_RULES,
    CatchParameter: { ident: node('VariableDeclaration', { name: idOf('ident'), type: child('type') }), bindingPattern: node('VariableDeclaration', { name: child('bindingPattern'), type: child('type') }) },
    ...FOR_RULES,
    Expr: {
      ...PRIMARY,
      privateField: privateOf('privateField'),
      spread: node('SpreadElement', { expression: child('expr') }),
      paren: node('ParenthesizedExpression', { expression: comma }),
      super_: branch('alt', {
        paren: node('CallExpression', { expression: token('SuperKeyword', 'superKeyword'), arguments: child('expr') }),
        dot: node('PropertyAccessExpression', { expression: token('SuperKeyword', 'superKeyword'), name: name() }),
        bracket: node('ElementAccessExpression', { expression: token('SuperKeyword', 'superKeyword'), argumentExpression: commaOf('expr', 'exprComma', 'exprRest') }),
      }),
      led_dot: node('PropertyAccessExpression', { expression: child('left'), name: name(), flags: chainFlags }),
      led_bracket: node('ElementAccessExpression', { expression: child('left'), argumentExpression: commaOf('expr', 'exprComma', 'exprRest'), flags: chainFlags }),
      led_paren: node('CallExpression', { expression: child('left'), arguments: child('expr'), flags: chainFlags }),
      led_optChain: branch('alt', {
        ident: node('PropertyAccessExpression', { expression: child('left'), questionDotToken: token('QuestionDotToken', 'questionDot'), name: idOf('ident'), flags: c('OptionalChain') }),
        privateField: node('PropertyAccessExpression', { expression: child('left'), questionDotToken: token('QuestionDotToken', 'questionDot'), name: privateOf('privateField'), flags: c('OptionalChain') }),
        paren: node('CallExpression', { expression: child('left'), questionDotToken: token('QuestionDotToken', 'questionDot'), arguments: child('expr'), flags: c('OptionalChain') }),
        bracket: node('ElementAccessExpression', { expression: child('left'), questionDotToken: token('QuestionDotToken', 'questionDot'), argumentExpression: commaOf('expr', 'exprComma', 'exprRest'), flags: c('OptionalChain') }),
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
      ...FUNCTION_EXPRESSIONS,
      ...ARROWS,
      ...LITERALS,
      ...CLASS_EXPRESSIONS,
      postfixOp: node('PostfixUnaryExpression', { operand: child('operand'), operator: kindOf(PREFIX) }),
    },
    NewTarget: {
      ...PRIMARY,
      superMember: branch('alt', {
        dot: node('PropertyAccessExpression', { expression: token('SuperKeyword', 'superKeyword'), name: idOf('ident') }),
        bracket: node('ElementAccessExpression', { expression: token('SuperKeyword', 'superKeyword'), argumentExpression: commaOf('expr', 'exprComma', 'exprRest') }),
      }),
      newDotTarget: node('MetaProperty', { keywordToken: c('NewKeyword'), name: idOf('targetKeyword', c('target')) }),
      ...FUNCTION_EXPRESSIONS,
      ident: node('Identifier', { text: cook('identifierName', 'ident') }),
      new_: node('NewExpression', { expression: child('newTarget'), arguments: branch('alt', { paren: child('expr') }) }),
      led_dot: node('PropertyAccessExpression', { expression: child('left'), name: name() }),
      led_bracket: node('ElementAccessExpression', { expression: child('left'), argumentExpression: commaOf('expr', 'exprComma', 'exprRest') }),
      paren: node('ParenthesizedExpression', { expression: comma }),
      ...LITERALS,
    },
    ...KEY_RULES,
    ...PROP_RULES,
  },
};
