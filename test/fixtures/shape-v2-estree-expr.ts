// ShapeSpec v2: a subset of ESTree (as acorn 8 produces it) from javascript.ts, in the core
// calculus only (src/shape2-schema.ts): the expressions below, the root, and the statements
// (blocks, variable statements with identifier bindings, `if`, loops, `return`, `throw`, `break`,
// `continue`, labelled, `try`, `with`, `debugger`, empty), functions, arrows and their parameters,
// binding patterns, object / array literals, spread, templates and assignment patterns, classes,
// and modules (import / export declarations, `import()`, `import.meta`). Checked against acorn by
// test/shape2-oracle.ts. Not total: an arm outside the subset (`switch`, a decorated declaration)
// is unmapped, and a unit that reaches one is reported as outside the subset, not compared.
import {
  absent, and, armOf, branch, c, child, cook, dropLastIf, fold, get, iff, inh, list, map, match, node, not, orElse, present, record,
  spread, syn, text, thread, v, wrapIf, type Shape2Spec, type Term,
} from '../../src/shape2-schema.ts';

/** An Identifier node from a named leaf (a property name, `new` / `target`). */
const idOf = (leaf: string, name: Term = cook('identifierName', leaf)): Term => node('Identifier', { name }, { from: leaf, to: leaf });
const privateOf = (leaf: string): Term => node('PrivateIdentifier', { name: cook('privateName', leaf) }, { from: leaf, to: leaf });
const literal = (value: Term, extra: Record<string, Term> = {}): Term => node('Literal', { value, raw: text(), ...extra });
const property = (): Term => branch('alt', { ident: idOf('ident'), privateField: privateOf('privateField') });
/** A Block child as ESTree's BlockStatement. The grammar has one Block rule for a block statement,
 * a function body and a class static block; ESTree's StaticBlock holds the statements itself and
 * spans from `static`, so Block is RECORD-VALUED (its `body`, the statement list) and each parent
 * builds the node it needs. */
const blockOf = (name: string): Term => node('BlockStatement', { body: get(name, 'body') }, { from: name, to: name });

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
  Decl: { ...Object.fromEntries(FUNCTIONS.map((a) => [a, 'body'])), exportDefault: 'body' },                                        // declarations, `export default function`
  Prop: Object.fromEntries(['accessor', 'asyncGeneratorMethod', 'asyncMethod', 'generatorMethod', 'method'].map((a) => [a, 'body'])),   // object methods / accessors
  ClassMember: { member: 'body' },                                                                                              // constructor, methods, accessors
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
  ForBinding: { seq: node('VariableDeclarator', { id: target('name'), init: orElse(child('value'), c(null)) }) },
};

// ── Functions (ECMA-262 15.2 - 15.6) ──
// Four arms per form (plain, generator, async, async generator: the grammar routes each one's
// parameters and body to its [Await] / [Yield] family), so `generator` / `async` are the arm's.
const FUNCTION_FLAGS: Record<(typeof FUNCTIONS)[number], [boolean, boolean]> = { function_: [false, false], generator: [true, false], asyncFunction: [false, true], asyncGenerator: [true, true] };
const fn = (type: string, id: Term, generator: boolean, isAsync: boolean, span?: { from: string; to: string }): Term =>
  node(type, { id, expression: c(false), generator: c(generator), async: c(isAsync), params: child('parameter'), body: blockOf('body') }, span);
const functionArms = (type: string, id: Term, span?: { from: string; to: string }): Record<string, Term> =>
  Object.fromEntries(FUNCTIONS.map((a) => [a, fn(type, id, ...FUNCTION_FLAGS[a], span)]));
/** An arrow: a parenthesised parameter list (`parameter` repeats) or one identifier; a block or
 * an expression body (ConciseBody). */
const arrow = (isAsync: boolean, params: Term): Term => node('ArrowFunctionExpression', {
  id: c(null), expression: branch('body', { block: c(false), expression: c(true) }), generator: c(false), async: c(isAsync),
  params, body: branch('body', { block: blockOf('block'), expression: child('expr') }),
});
const ARROW_RULES: Record<string, Term> = {
  arrow: arrow(false, child('parameter')),
  asyncArrow: arrow(true, child('parameter')),
  arrowIdentifier: arrow(false, list(idOf('parameter'))),
  asyncArrowIdentifier: arrow(true, list(idOf('parameter'))),
};
// ── Binding patterns (ECMA-262 14.3.3) ──
// A binding target is an identifier or a pattern: the inline alternation `name` (or `argument`
// after `...`) with branches `ident` / `bindingPattern`.
function target(alt: string): Term { return branch(alt, { ident: idOf('ident'), bindingPattern: child('bindingPattern') }); }
const withDefault = (left: Term): Term => iff(present('value'), node('AssignmentPattern', { left, right: child('value') }), left);
const patternProperty = (key: Term, value: Term, flags: { shorthand: boolean; computed: Term }): Term =>
  node('Property', { method: c(false), shorthand: c(flags.shorthand), computed: flags.computed, key, value, kind: c('init') });
const literalKey = (leaf: string, value: Term, extra: Record<string, Term> = {}): Term => node('Literal', { value, raw: text(leaf), ...extra }, { from: leaf, to: leaf });
/** `[ E? (, E?)* ]`: whether the final element is a hole (absent): the first one when there is
 * no `,`, else the last iteration's. Both oracles drop that final hole (`[a,]` has one element). */
export const finalHole = (first: string, over: string, rest: string): Term => fold(over, not(present(first)), 'h', not(present(rest)));
const PATTERN_RULES: Shape2Spec['rules'] = {
  BindingPattern: {
    object: node('ObjectPattern', { properties: child('property') }),
    array: node('ArrayPattern', { elements: dropLastIf(finalHole('element', 'comma', 'elementRest'), list(child('element'), spread(child('elementRest')))) }),
  },
  BindingProperty: {
    identPair: patternProperty(idOf('key'), child('value'), { shorthand: false, computed: c(false) }),
    shorthand: patternProperty(idOf('name'), withDefault(idOf('name')), { shorthand: true, computed: c(false) }),
    pair: patternProperty(branch('key', {
      string: literalKey('string', cook('stringValue', 'string')),
      number: literalKey('number', cook('numberValue', 'number')),
      hexNumber: literalKey('hexNumber', cook('numberValue', 'hexNumber')),
      octalNumber: literalKey('octalNumber', cook('numberValue', 'octalNumber')),
      binaryNumber: literalKey('binaryNumber', cook('numberValue', 'binaryNumber')),
      legacyNumber: literalKey('legacyNumber', cook('numberValue', 'legacyNumber')),
      bigInt: literalKey('bigInt', cook('bigintValue', 'bigInt'), { bigint: cook('bigintText', 'bigInt') }),
      computed: child('expr'),
    }), child('value'), { shorthand: false, computed: match(armOf('key'), { computed: c(true) }, c(false)) }),
    rest: node('RestElement', { argument: target('argument') }),
  },
  BindingElement: { seq: withDefault(target('name')) },
  ArrayBindingElement: { bindingElement: child('bindingElement'), rest: node('RestElement', { argument: target('argument') }) },
};

/** A parameter (FormalParameter): a binding element, with a default (AssignmentPattern) or rest
 * (RestElement). A decorator on a parameter is no ECMAScript (acorn rejects it), so it is not
 * read. */
const bindingName: Term = target('name');
const PARAM_RULES: Shape2Spec['rules'] = {
  Param: {
    plain: branch('binding', {
      single: iff(present('value'), node('AssignmentPattern', { left: bindingName, right: child('value') }), bindingName),
      rest: node('RestElement', { argument: bindingName }),
    }),
  },
};

// ── Object and array literals (ECMA-262 13.2.4, 13.2.5), templates (13.2.8) ──
// A literal on the left of `=` (and a `for … in / of` head's left) is an assignment PATTERN
// (13.15.5): ESTree builds ArrayPattern / ObjectPattern / RestElement / AssignmentPattern there.
// The grammar parses an expression (the cover grammar), so the shape says where the pattern
// reading holds: the inherited `pattern`, true for the left operand of `=` (a RIGHT-DEPENDENT
// equation: the operator follows the operand) and for a `for` head's left, handed down through
// the elements, the properties' values and the spread arguments. Whether the pattern is VALID
// (`[a + b] = c`) is the grammar's business, not the shape's.
const inPattern = inh('pattern');
/** A property key (MemberName): computed when it is `[ e ]`. */
const KEY_RULES: Shape2Spec['rules'] = {
  MemberName: {
    ident: idOf('ident'),
    privateField: privateOf('privateField'),
    string: literal(cook('stringValue', 'string')),
    number: literal(cook('numberValue', 'number')),
    hexNumber: literal(cook('numberValue', 'hexNumber')),
    octalNumber: literal(cook('numberValue', 'octalNumber')),
    binaryNumber: literal(cook('numberValue', 'binaryNumber')),
    legacyNumber: literal(cook('numberValue', 'legacyNumber')),
    bigInt: literal(cook('bigintValue', 'bigInt'), { bigint: cook('bigintText', 'bigInt') }),
    computed: child('expr'),
  },
};
const computedKey: Term = match(armOf('key'), { computed: c(true) }, c(false));
const objectProperty = (value: Term, f: { kind?: Term; method?: boolean; shorthand?: boolean; key?: Term; computed?: Term } = {}): Term => node('Property', {
  method: c(f.method ?? false), shorthand: c(f.shorthand ?? false), computed: f.computed ?? computedKey, key: f.key ?? child('key'), value, kind: f.kind ?? c('init'),
});
/** A method's or accessor's function: from its `(` to its body. */
const methodFunction = (generator: boolean, isAsync: boolean): Term => node('FunctionExpression', {
  id: c(null), expression: c(false), generator: c(generator), async: c(isAsync), params: child('parameter'), body: blockOf('body'),
}, { from: 'paren', to: 'body' });
const spreadOrRest = (argument: string): Term => node(iff(inPattern, c('RestElement'), c('SpreadElement')), { argument: child(argument) });
const PROP_RULES: Shape2Spec['rules'] = {
  Prop: {
    spread: spreadOrRest('argument'),
    accessor: objectProperty(methodFunction(false, false), { kind: text('kind') }),
    asyncGeneratorMethod: objectProperty(methodFunction(true, true), { method: true }),
    asyncMethod: objectProperty(methodFunction(false, true), { method: true }),
    generatorMethod: objectProperty(methodFunction(true, false), { method: true }),
    method: objectProperty(methodFunction(false, false), { method: true }),
    init: objectProperty(child('value')),
    // `{ a = 1 }` (CoverInitializedName) is only a pattern's: an AssignmentPattern value.
    shorthand: objectProperty(branch('initializer', {
      none: idOf('name'),
      assign: node('AssignmentPattern', { left: idOf('name'), right: child('value') }, { from: 'name', to: 'value' }),
    }), { shorthand: true, key: idOf('name'), computed: c(false) }),
  },
};
const arrayElements: Term = dropLastIf(finalHole('element', 'comma', 'elementRest'), list(child('element'), spread(child('elementRest'))));
/** A template part: its body (the `inside` span) cooked and raw; `tail` on the last part. */
const quasi = (leaf: string, tail: boolean): Term =>
  node('TemplateElement', { value: record({ raw: cook('templateRaw', leaf), cooked: cook('templateCooked', leaf) }), tail: c(tail) }, { inside: leaf });
const templateLiteral = (name: string): Term => branch(name, {
  noSubstitution: node('TemplateLiteral', { expressions: list(), quasis: list(quasi('quasi', true)) }, { from: name, to: name }),
  substitution: node('TemplateLiteral', {
    expressions: child('expr'),
    quasis: list(quasi('head', false), spread(map('expr', branch('part', { middle: quasi('literal', false), tail: quasi('literal', true) })))),
  }, { from: name, to: name }),
});

// ── Classes (ECMA-262 15.7) ──
// A class: its name, its heritage (one LeftHandSideExpression), its body from `{` to `}`. A `;`
// element is no ClassElement (acorn keeps none), so the body's list folds it away. A method's
// FunctionExpression spans from its `(`; a field spans its element (its `;` included). A string
// key "constructor" names the constructor as the identifier does (15.7.1 ClassElementKind:
// PropName), unless the element is `static`. acorn takes neither decorators nor `accessor`: an
// `accessor` field is unmapped, a decorator not read.
const classBody: Term = node('ClassBody', {
  body: fold('member', list(), 'acc', iff(match(armOf('member'), { empty: c(true) }, c(false)), v('acc'), list(spread(v('acc')), child('member')))),
}, { from: 'bodyOpen', to: 'bodyClose' });
const classNode = (type: string, id: Term, span?: { from: string; to: string }): Term =>
  node(type, { id, superClass: orNull('superClass'), body: classBody }, span);
const classId: Term = iff(present('name'), idOf('name'), c(null));
const elementStatic: Term = present('staticWord');
const methodDefinition = (kind: Term, generator: boolean, isAsync: boolean): Term => node('MethodDefinition', {
  static: elementStatic, computed: computedKey, key: child('key'), kind, value: methodFunction(generator, isAsync),
});
const methodKind: Term = iff(and(not(elementStatic), syn('constructorName', 'key')), c('constructor'), c('method'));
/** The element after its decorators (no ECMAScript: acorn rejects every file with one, so they are not read) and `static`. */
const classElement: Term = branch('member', {
  async: branch('form', { generatorMethod: methodDefinition(methodKind, true, true), method: methodDefinition(methodKind, false, true) }),
  generatorMethod: methodDefinition(methodKind, true, false),
  accessor: methodDefinition(text('kind'), false, false),
  named: branch('tail', {
    method: methodDefinition(methodKind, false, false),
    field: node('PropertyDefinition', { static: elementStatic, computed: computedKey, key: child('key'), value: orNull('value') }),
  }),
});
const CLASS_RULES: Shape2Spec['rules'] = {
  ClassMember: {
    empty: absent,
    staticBlock: node('StaticBlock', { body: get('body', 'body') }),
    member: branch('form', {
      constructor: node('MethodDefinition', {
        static: c(false), computed: c(false), key: idOf('constructorKeyword', c('constructor')), kind: c('constructor'), value: methodFunction(false, false),
      }),
      element: classElement,
    }),
  },
};

// ── Modules (ECMA-262 16.2) ──
// A module specifier is a string Literal; its import attributes (`with { type: "json" }`) are
// ImportAttribute nodes, key to value. A specifier's ModuleExportName is an identifier or a
// string; an unrenamed specifier holds its one name twice (`imported` / `exported` and `local`).
const stringLiteral = (leaf: string): Term => node('Literal', { value: cook('stringValue', leaf), raw: text(leaf) }, { from: leaf, to: leaf });
const exportName = (name: string): Term => branch(name, { ident: idOf('ident'), string: stringLiteral('string') });
const attribute = (key: string, value: string): Term => node('ImportAttribute', { key: exportName(key), value: stringLiteral(value) }, { from: key, to: value });
/** A module specifier's fields (`moduleSpecifier`'s names). */
const moduleFields: Record<string, Term> = {
  source: stringLiteral('source'),
  attributes: iff(present('attributeKey'), list(attribute('attributeKey', 'attributeValue'), spread(map('attributeKeyRest', attribute('attributeKeyRest', 'attributeValueRest')))), list()),
};
const namespaceSpecifier: Term = node('ImportNamespaceSpecifier', { local: idOf('namespace') }, { from: 'star', to: 'namespace' });
/** An import clause is its specifier list (ImportDeclaration's `specifiers`). */
const MODULE_RULES: Shape2Spec['rules'] = {
  ImportClause: {
    defaultBinding: list(
      node('ImportDefaultSpecifier', { local: idOf('name') }, { from: 'name', to: 'name' }),
      spread(iff(present('bindings'), branch('bindings', { named: child('specifier'), namespace: list(namespaceSpecifier) }), list())),
    ),
    named: child('specifier'),
    namespace: list(namespaceSpecifier),
    deferNamespace: list(namespaceSpecifier),
  },
  ImportSpecifier: {
    renamed: node('ImportSpecifier', { imported: idOf('imported'), local: idOf('local') }),
    plain: node('ImportSpecifier', { imported: idOf('local'), local: idOf('local') }),
    stringRenamed: node('ImportSpecifier', { imported: stringLiteral('imported'), local: idOf('local') }),
  },
  ExportSpecifier: {
    specifier: node('ExportSpecifier', { local: exportName('local'), exported: iff(present('exported'), exportName('exported'), exportName('local')) }),
  },
};
/** The declaration an `export default` holds spans its own branch (`declaration`). */
const ownSpan = { from: 'declaration', to: 'declaration' };
const MODULE_DECLARATIONS: Record<string, Term> = {
  exportDeclaration: node('ExportNamedDeclaration', {
    declaration: branch('declaration', { decl: child('decl'), variable: child('stmt') }), specifiers: list(), source: c(null), attributes: list(),
  }),
  exportDefault: node('ExportDefaultDeclaration', {
    declaration: branch('declaration', {
      ...functionArms('FunctionDeclaration', iff(present('name'), idOf('name'), c(null)), ownSpan),
      namedClass: classNode('ClassDeclaration', idOf('name'), ownSpan),
      anonymousClass: classNode('ClassDeclaration', c(null), ownSpan),
      expression: child('expr'),
    }),
  }),
  exportAll: branch('form', {
    plain: node('ExportAllDeclaration', { exported: c(null), ...moduleFields }),
    aliased: node('ExportAllDeclaration', { exported: exportName('exported'), ...moduleFields }),
  }),
  exportNamed: node('ExportNamedDeclaration', {
    declaration: c(null), specifiers: child('specifier'),
    source: iff(present('source'), moduleFields.source, c(null)), attributes: iff(present('source'), moduleFields.attributes, list()),
  }),
  importDeclaration: branch('form', {
    // A phase import (Stage 3; acorn has neither) carries ESTree's `phase`, as Babel's does.
    clause: node('ImportDeclaration', { specifiers: child('clause'), ...moduleFields, phase: match(armOf('clause'), { deferNamespace: c('defer') }, absent) }),
    source: node('ImportDeclaration', { specifiers: list(node('ImportDefaultSpecifier', { local: idOf('name') }, { from: 'name', to: 'name' })), ...moduleFields, phase: c('source') }),
    bare: node('ImportDeclaration', { specifiers: list(), ...moduleFields }),
  }),
};

/** The statements (ECMA-262 14), one node per Stmt arm. */
const STATEMENTS: Record<string, Term> = {
  block: blockOf('block'),
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
    block: blockOf('body'),
    handler: iff(present('handler'), node('CatchClause', { param: orNull('parameter'), body: blockOf('handler') }, { from: 'catchTok', to: 'handler' }), c(null)),
    finalizer: iff(present('finalizer'), blockOf('finalizer'), c(null)),
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
  this_: node('ThisExpression'),
  ident: node('Identifier', { name: cook('identifierName', 'ident') }),
  number: literal(cook('numberValue', 'number')),
  hexNumber: literal(cook('numberValue', 'hexNumber')),
  octalNumber: literal(cook('numberValue', 'octalNumber')),
  binaryNumber: literal(cook('numberValue', 'binaryNumber')),
  legacyNumber: literal(cook('numberValue', 'legacyNumber')),
  bigInt: literal(cook('bigintValue', 'bigInt'), { bigint: cook('bigintText', 'bigInt') }),
  string: literal(cook('stringValue', 'string')),
  regex: literal(c(null), { regex: record({ pattern: cook('regexPattern', 'regex'), flags: cook('regexFlags', 'regex') }) }),
};

export const estreeExprShape: Shape2Spec = {
  name: 'estree-expr',
  synthesized: {
    directive: { type: 'bool', default: false, rules: { Stmt: { expr: and(not(present('rest')), match(armOf('first'), { string: c(true) }, c(false))) } } },
    stringBody: { type: 'string', rules: { Expr: { string: cook('stringBody', 'string') } } },
    optional: { type: 'bool', default: false, rules: Object.fromEntries(['Expr', 'ClassHeritage'].map((r) => [r, { led_optChain: c(true), led_dot: syn('optional', 'left'), led_bracket: syn('optional', 'left'), led_paren: syn('optional', 'left') }])) },
    // A property key that names the constructor: the identifier or the string `constructor`.
    constructorName: { type: 'bool', default: false, rules: { MemberName: { ident: match(cook('identifierName', 'ident'), { constructor: c(true) }, c(false)), string: match(cook('stringValue', 'string'), { constructor: c(true) }, c(false)) } } },
  },
  inherited: {
    pattern: {
      type: 'bool', default: false, rules: {
        Expr: {
          binaryOp: { left: match(text('op'), { '=': c(true) }, c(false)) },
          array: { element: inPattern, elementRest: inPattern },
          object: { property: inPattern },
          spread: { expr: inPattern },
        },
        Prop: { init: { value: inPattern }, spread: { argument: inPattern } },
        ForHead: { in_: { left: c(true) }, of: { left: c(true) } },
        ForAwaitHead: { of: { left: c(true) } },
      },
    },
    functionBody: { type: 'bool', default: false, rules: Object.fromEntries(Object.entries(FUNCTION_BODIES).map(([r, arms]) => [r, Object.fromEntries(Object.entries(arms).map(([a, body]) => [a, { [body]: c(true) }]))])) },
    prologue: {
      type: 'bool', default: false, rules: {
        Program: { decl: { alt: thread(c(true), 'p', and(v('p'), branch('alt', { decl: c(false), stmt: syn('directive', 'stmt') }))) } },
        Block: { brace: { stmt: prologue(inh('functionBody')) } },
      },
    },
    chainTop: { type: 'bool', default: true, rules: Object.fromEntries(['Expr', 'ClassHeritage'].map((r) => [r, Object.fromEntries(LINKS.map((a) => [a, { left: c(false) }]))])) },
  },
  rules: {
    // The root: its statement list. acorn's `sourceType` (the goal acorn was run with) and the
    // root's extent over trailing trivia are not produced (test/shape2-oracle.ts ROOT_NOT_COMPARED).
    Program: { decl: node('Program', { body: map('alt', branch('alt', { decl: child('decl'), stmt: child('stmt') })) }) },
    Stmt: { ...STATEMENTS, expr: node('ExpressionStatement', { expression: sequence, directive: iff(and(inh('prologue'), syn('directive')), syn('stringBody', 'first'), absent) }) },
    Block: { brace: record({ body: child('stmt') }) },
    // A binding: an identifier or a pattern.
    Binding: { seq: node('VariableDeclarator', { id: target('name'), init: orNull('value') }) },
    CatchParameter: { ident: idOf('ident'), bindingPattern: child('bindingPattern') },
    ...PARAM_RULES,
    ...PATTERN_RULES,
    Decl: { ...functionArms('FunctionDeclaration', idOf('name')), class_: classNode('ClassDeclaration', idOf('name')), ...MODULE_DECLARATIONS },
    ...MODULE_RULES,
    ...CLASS_RULES,
    // A class heritage: a LeftHandSideExpression (the `new` callee rule, then the call and chain tails).
    ClassHeritage: {
      newTarget: child('newTarget'),
      class_: classNode('ClassExpression', classId),
      led_dot: chain(member(property(), false, false)),
      led_bracket: chain(member(sequenceOf('expr', 'exprRest'), true, false)),
      led_paren: chain(node('CallExpression', { callee: child('left'), arguments: child('expr'), optional: c(false) })),
      led_optChain: chain(branch('alt', {
        ident: member(idOf('ident'), false, true),
        privateField: member(privateOf('privateField'), false, true),
        paren: node('CallExpression', { callee: child('left'), arguments: child('expr'), optional: c(true) }),
        bracket: member(sequenceOf('expr', 'exprRest'), true, true),
      })),
      led_template: node('TaggedTemplateExpression', { tag: child('left'), quasi: templateLiteral('template') }),
    },
    ...FOR_RULES,
    ...KEY_RULES,
    ...PROP_RULES,
    Expr: {
      ...PRIMARY,
      privateField: privateOf('privateField'),
      spread: spreadOrRest('expr'),
      array: node(iff(inPattern, c('ArrayPattern'), c('ArrayExpression')), { elements: arrayElements }),
      object: node(iff(inPattern, c('ObjectPattern'), c('ObjectExpression')), { properties: child('property') }),
      template: templateLiteral('template'),
      led_template: node('TaggedTemplateExpression', { tag: child('left'), quasi: templateLiteral('template') }),
      paren: sequence,
      super_: branch('alt', {
        paren: node('CallExpression', { callee: node('Super', {}, { from: 'superKeyword', to: 'superKeyword' }), arguments: child('expr'), optional: c(false) }),
        dot: node('MemberExpression', { object: node('Super', {}, { from: 'superKeyword', to: 'superKeyword' }), property: property(), computed: c(false), optional: c(false) }),
        bracket: node('MemberExpression', { object: node('Super', {}, { from: 'superKeyword', to: 'superKeyword' }), property: sequenceOf('expr', 'exprRest'), computed: c(true), optional: c(false) }),
      }),
      led_dot: chain(member(property(), false, false)),
      led_bracket: chain(member(sequenceOf('expr', 'exprRest'), true, false)),
      led_paren: chain(node('CallExpression', { callee: child('left'), arguments: child('expr'), optional: c(false) })),
      led_optChain: chain(branch('alt', {
        ident: member(idOf('ident'), false, true),
        privateField: member(privateOf('privateField'), false, true),
        paren: node('CallExpression', { callee: child('left'), arguments: child('expr'), optional: c(true) }),
        bracket: member(sequenceOf('expr', 'exprRest'), true, true),
      })),
      led_question: node('ConditionalExpression', { test: child('left'), consequent: child('then'), alternate: child('otherwise') }),
      led_in: node('BinaryExpression', { left: child('left'), operator: c('in'), right: child('expr') }),
      led_instanceof: node('BinaryExpression', { left: child('left'), operator: c('instanceof'), right: child('expr') }),
      newDotTarget: node('MetaProperty', { meta: idOf('newKeyword', c('new')), property: idOf('targetKeyword', c('target')) }),
      import_: branch('form', {
        call: node('ImportExpression', { source: child('source'), options: orNull('options') }),
        dot: branch('property', {
          meta: node('MetaProperty', { meta: idOf('importKeyword', c('import')), property: idOf('metaKeyword', c('meta')) }),
          phaseCall: node('ImportExpression', { source: child('source'), options: orNull('options'), phase: text('phase') }),
        }),
      }),
      construct: node('NewExpression', { callee: child('newTarget'), arguments: branch('alt', { paren: child('expr'), empty: list() }) }),
      yield_: branch('alt', {
        star: node('YieldExpression', { delegate: c(true), argument: child('expr') }),
        expr: node('YieldExpression', { delegate: c(false), argument: orElse(child('expr'), c(null)) }),
      }),
      // `=` inside a pattern (`[a = 1] = b`) is an element's default.
      binaryOp: iff(and(inPattern, match(text('op'), { '=': c(true) }, c(false))),
        node('AssignmentPattern', { left: child('left'), right: child('right') }),
        node(binaryType, { left: child('left'), operator: text('op'), right: child('right') })),
      prefixOp: match(text('op'), {
        '++': node('UpdateExpression', { operator: text('op'), prefix: c(true), argument: child('operand') }),
        '--': node('UpdateExpression', { operator: text('op'), prefix: c(true), argument: child('operand') }),
        await: node('AwaitExpression', { argument: child('operand') }),
        yield: node('YieldExpression', { delegate: c(false), argument: child('operand') }),
      }, node('UnaryExpression', { operator: text('op'), prefix: c(true), argument: child('operand') })),
      ...functionArms('FunctionExpression', iff(present('name'), idOf('name'), c(null))),
      ...ARROW_RULES,
      namedClass: classNode('ClassExpression', idOf('name')),
      anonymousClass: classNode('ClassExpression', c(null)),
      newNamedClass: node('NewExpression', { callee: classNode('ClassExpression', idOf('name'), { from: 'classKeyword', to: 'bodyClose' }), arguments: branch('newArguments', { paren: child('argument'), none: list() }) }),
      newAnonymousClass: node('NewExpression', { callee: classNode('ClassExpression', c(null), { from: 'classKeyword', to: 'bodyClose' }), arguments: branch('newArguments', { paren: child('argument'), none: list() }) }),
      postfixOp: node('UpdateExpression', { operator: text('op'), prefix: c(false), argument: child('operand') }),
    },
    // The callee of `new` (a MemberExpression, never a call).
    NewTarget: {
      ...PRIMARY,
      superMember: branch('alt', {
        dot: node('MemberExpression', { object: node('Super', {}, { from: 'superKeyword', to: 'superKeyword' }), property: idOf('ident'), computed: c(false), optional: c(false) }),
        bracket: node('MemberExpression', { object: node('Super', {}, { from: 'superKeyword', to: 'superKeyword' }), property: sequenceOf('expr', 'exprRest'), computed: c(true), optional: c(false) }),
      }),
      newDotTarget: node('MetaProperty', { meta: idOf('newKeyword', c('new')), property: idOf('targetKeyword', c('target')) }),
      ...functionArms('FunctionExpression', iff(present('name'), idOf('name'), c(null))),
      ident: node('Identifier', { name: cook('identifierName', 'ident') }),
      new_: node('NewExpression', { callee: child('newTarget'), arguments: child('expr') }),
      led_dot: node('MemberExpression', { object: child('left'), property: property(), computed: c(false), optional: c(false) }),
      led_bracket: node('MemberExpression', { object: child('left'), property: sequenceOf('expr', 'exprRest'), computed: c(true), optional: c(false) }),
      paren: sequence,
      array: node('ArrayExpression', { elements: arrayElements }),
      object: node('ObjectExpression', { properties: child('property') }),
      template: templateLiteral('template'),
      led_template: node('TaggedTemplateExpression', { tag: child('left'), quasi: templateLiteral('template') }),
    },
  },
};
