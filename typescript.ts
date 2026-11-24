import {
  rule, defineGrammar,
  op, prefix, postfix, sameLine,
  sep, opt, many, many1, alt, not, tsRelax, capExpr, notLeftLeaf, withHoles,
  awaitCtx, yieldCtx, asyncGenCtx, resetCtx, arm, field,
} from './src/api.ts';

// Build the four async×generator arms of a TypeScript `function` form, routing each
// arm's params and body to its [Await]/[Yield] family (plain resets, generator ->
// yield, async -> await, async-generator -> both). Type params and the return-type
// annotation are NOT [Await]/[Yield]-parameterized, so they stay plain. `nameParts`
// is spread in after `function` (and `*`); `body` is the function body element.
// Param/Block/Type/TypeParams resolve at thunk-eval time (defined below).
function tsFnArms(nameParts, body) {
  return [
    arm('function_', 'function', ...nameParts, opt(field('typeParameters', TypeParams)), '(', sep(resetCtx(field('parameter', Param)), ','), ')', opt(":", ReturnType), resetCtx(field('body', body))),
    arm('generator', 'function', field('asterisk', '*'), ...nameParts, opt(field('typeParameters', TypeParams)), '(', sep(yieldCtx(field('parameter', Param)), ','), ')', opt(":", ReturnType), yieldCtx(field('body', body))),
    arm('asyncFunction', field('asyncKeyword', 'async'), sameLine, 'function', ...nameParts, opt(field('typeParameters', TypeParams)), '(', sep(awaitCtx(field('parameter', Param)), ','), ')', opt(":", ReturnType), awaitCtx(field('body', body))),
    arm('asyncGenerator', field('asyncKeyword', 'async'), sameLine, 'function', field('asterisk', '*'), ...nameParts, opt(field('typeParameters', TypeParams)), '(', sep(asyncGenCtx(field('parameter', Param)), ','), ')', opt(":", ReturnType), asyncGenCtx(field('body', body))),
  ];
}

// A function declaration's body: a block, or none (an overload or ambient signature), and a
// declaration without a body ends as a statement does (tsc's parseFunctionBlockOrSemicolon).
const fnBodyOrAsi = () => alt(Block, [not('{'), asi()]);
// A type member (and a class index signature) ends as tsc's parseTypeMemberSemicolon: a `,`,
// or as a statement does. Each member carries its own end, so two members on one line need one.
const typeMemberEnd = () => alt([','], asi());
// JavaScript is the SUBSET / base of the ECMAScript family; TypeScript is the
// SUPERSET (JS + a type layer). The shared, type-free vocabulary — token consts,
// the `notReserved`/`notReservedExpr` reserved-word guards, the statement end (`asi`), the precedence ladder
// (`ecmaPrec`), and the JS scope map (`jsScopes`) — is OWNED by javascript.ts and
// imported here, then extended below with the type layer. Rules are NOT shared
// either direction (combinator rules bind their references at definition time), so
// this file keeps its own rule consts.
import {
  Shebang, JSDoc, TripleSlash, LineComment, BlockComment,
  Ident, HexNumber, OctalNumber, BinaryNumber, BigInt_,
  Number_, String_, Template, Regex_, Decorator, PrivateField,
  notReserved, notReservedExpr, bindingIdentifier, bindingName, asi, expressionStatement, conciseBody, classHeritageArms, newTargetArms, ecmaPrec, jsLedPrecs, jsScopes, jsBaseCanonical,
  forBindingArms, forHeadArms, forAwaitHeadArms, forStatement,
  memberStart, memberAhead, memberWordRules, memberWord, exportDeclaration, moduleSpecifier, bracketIndex,
} from './javascript.ts';

// ── Type query reference (typeof's argument: just dotted identifiers) ──

const TypeofRef = rule($ => [
  Ident,
  // `typeof import("m")` — tsc's ImportTypeNode is a valid type-query target
  // (`typeof import("./mod").Thing` chains members via the `.` led below).
  ['import', '(', Type, ')'],
  [$, '.', Ident],
]);

// ── Decorators ──

// A decorator is `@` and then tsc's parseDecoratorExpression: a name (any IdentifierName word: tsc
// reads a primary expression) or a parenthesized expression, and then the tails of a
// LeftHandSideExpression. The head is the Decorator token (`@a`: `@` and one IdentifierName), or `@`
// and a name when trivia separates them (`@ a`); dotted segments are tokens of their own. These tail forms may follow and chain (`@x!.y`, `@x.y!`, `@x!()`): a call `(args)` /
// typed call `<T>(args)`, a non-null `!`, and a member `.m`. ELEMENT access `[i]` is
// deliberately EXCLUDED — TS's decorator grammar omits it precisely so a computed class
// member after a decorator (`@dec ["m"]() {}`, `@dec [field] = 1`) is not swallowed as
// `@dec[...]` (tsc rejects a real `@arr[0]` decorator). `many` so a whole chain is allowed.
const DecoratorExpr = rule($ => [
  // Not `@new`: `new` is a reserved word, so it names no decorator; `@new …` is the NewExpression arm below.
  [alt([not('@new'), Decorator], ['@', alt([notReservedExpr, Ident], ['(', Expr, many(',', Expr), ')'])]), many(alt(
    ['(', sep(Expr, ','), ')'],                          // call: (args)
    [...typeArgsInExpr(), '(', sep(Expr, ','), ')'],     // typed call: <T>(args)
    '!',                                                  // non-null assertion
    ['.', alt(Ident, PrivateField)],                      // member access
    // optional chain: ?.y | ?.#y | ?.(args) | ?.[i] — unlike plain element access,
    // `?.[` is unambiguous (a computed class member never starts with `?.`), so tsc
    // parses it in decorator position and we mirror.
    ['?.', alt(Ident, PrivateField, ['(', sep(Expr, ','), ')'], bracketIndex(Expr))],   // `?.#y` is valid current ES (see Expr `?.` below)
    Template,                                             // tagged template: @x`…`
  ))],
  // `@new x`: the decorator expression is a NewExpression. The lexer reads `@new` as ONE Decorator
  // token (it cannot know `new` is reserved): the arm takes that token by its text, or `@` and `new`.
  [alt('@new', ['@', 'new']), NewTarget, opt('(', sep(Expr, ','), ')')],
]);

// ── Types ──

// A function / constructor / method / index-signature parameter that appears in a TYPE
// position. Such a parameter never carries a default value (`= Expr`) or a decorator
// (`@d`) — both are parse/checker errors in a type — so the full `Param` rule (which
// reaches `DecoratorExpr` and `= Expr`, and through them the whole expression grammar)
// is what couples the type sub-grammar to the expression sub-grammar. That coupling is
// the dominant driver of the tree-sitter state explosion (issue #46): a derived GLR
// parser must keep the `type` and `expr` interpretations co-live at every `(`, because
// a type-position param can reach an expression. `tsRelax` keeps the PARSER (and every
// other generator) on the shared `Param` rule, but renders this lean, expression-free
// param for tree-sitter only — making the type partition disjoint from `expr`.
//
// The rule is a VISIBLE node (not `_`-hidden): a hidden rule splices its `ident` child
// straight into the enclosing `type` node, where the `(type (ident) @type)` highlight query
// would then mis-scope a function-type PARAMETER NAME as a type. A visible `type_fn_param`
// node keeps the param name out of `type`'s direct children (→ @variable), while the `: T`
// annotation stays a nested `type` node (→ `T` still @type).
const typeFnParam = () => tsRelax(Param, [opt('...'), Ident, opt('?'), opt(':', Type)], 'type_fn_param');

// tsc's isStartOfType: whether the token here can begin a type, read from the tokens alone. It is
// what decides a `T?` (parsePostfixTypeOrHigher): before a type start the `?` is a conditional
// type's (or, after `as T`, the expression's), elsewhere it is the postfix nullable. A type
// starts with an identifier or a contextual keyword (isIdentifier: not a reserved word), a
// keyword type (`void`, `null`, `this`, `typeof`, `new`, `true`, `false`, `import`, `function`),
// a literal or template, `{ [ < | & * ? ! ...`, a `-` before a number, or a `(` before what
// begins a type or a parameter (isStartOfParenthesizedOrFunctionType: `)`, a `#name`, a
// decorator, a modifier keyword, or a type start).
const TypeStart = rule($ => [
  alt(
    [notReserved, Ident], 'void', 'null', 'this', 'typeof', 'new', 'true', 'false', 'import', 'function',
    String_, Number_, HexNumber, OctalNumber, BinaryNumber, BigInt_, Template,
    '{', '[', '<', '|', '&', '*', '?', '!', '...',
  ),
  ['-', alt(Number_, HexNumber, OctalNumber, BinaryNumber, BigInt_)],
  ['(', alt(')', PrivateField, '@', Decorator, 'const', 'default', 'export', 'in', $)],
]);

const Type = rule($ => {
  // (a: T) => R  /  <T>(…) => R (the return may be a type predicate). A type that starts with `(`
  // is a function type only by tsc's isUnambiguouslyStartOfFunctionType, whose skipParameterStart
  // reads modifier words but no decorator (parseModifiers without decorators): the first
  // parameter carries none (`(@a x) => 1`, `(export @a x) => 1` have no parse), while after type
  // parameters or `new`, and on every later parameter, parseParameter reads them (`<T>(@a x) =>
  // 1`, `new (@a x) => 1`, `(x, @a y) => 1`).
  // (tree-sitter renders no lookahead, so it keeps the one shape `<T>?(`.)
  const fnHead = (lead: unknown[]) => [...(lead.length ? [tsRelax(alt([TypeParams, '('], ['(', ...lead]), [opt(TypeParams), '('])] : [opt(TypeParams), '(']), sep(typeFnParam(), ','), ')', '=>', ReturnType];
  const fnType = fnHead([not([many(paramMods.any), alt('@', Decorator)])]);
  // tsc parses a type in levels (parseUnionTypeOrHigher, parseIntersectionTypeOrHigher,
  // parseTypeOperatorOrHigher): a union's constituents are intersections, an intersection's are
  // type operators, and a leading `|` / `&` belongs to the union / intersection it starts, read
  // once at that level (`| A`, `& A`, `| & A`). So what follows a `|` (leading or between
  // constituents) begins no `|`, and what follows a `&` begins neither `|` nor `&`: `| | A`,
  // `A | | B`, `A & | B`, `& & A` have no parse. The arms are flat (one Type each), so the level
  // is stated as that first token. (A type operator's operand is the same level, but `keyof |
  // A` still parses: `keyof` is also read as a type name, which tsc never does; owed.)
  const unionMember = not('|'), intersectionMember = not(alt('|', '&'));
  return [
    // A bare type reference / entity name. The identifier-subject predicate `x is T` is NOT
    // here for the PARSER: tsc's parser accepts it ONLY in a function RETURN-TYPE position
    // (see ReturnType below), so in any other type slot (var/param/property annotation, cast,
    // type argument, union member, …) it is a parse error. (`this is T` and `asserts x` are
    // different — tsc's parser accepts them in EVERY type position, so they are arms of this
    // general Type, below.) tsRelax: tree-sitter KEEPS the predicate in the general type (its
    // status-quo shape, GLR-cheap), since a highlighter may over-accept a stray predicate
    // — adding the return-only ReturnType to ~18 slots for tree-sitter inflates its table.
    tsRelax(Ident, [Ident, opt('is', Type)]),
    [$, sameLine, '<', sep($, ','), '>'],   // type-arg application T<A> — `<` must be on the same line (no ASI), like the postfix `[`/`!` arms below
    [$, sameLine, '[', ']'],   // array type T[] — `[` must be on the same line (no ASI)
    [$, '|', unionMember, $],
    [$, '&', intersectionMember, $],
    ['|', unionMember, $],   // leading pipe: type T = | A | B
    ['&', intersectionMember, $],   // leading amp:  type T = & A & B
    ['keyof', $],
    ['typeof', TypeofRef],
    ['readonly', $],
    ['(', $, ')'],
    fnType,                          // function type
    [opt('abstract'), 'new', ...fnHead([])],  // constructor type (= `new` + function type)
    // tuple element: `...`? (name `?`? `:`)? `...`? Type `?`?  — the second `...`
    // covers a named rest member `n: ...T[]` (TS: RestType after the label); the
    // trailing `?` covers optional members `n: T?` / `T?` (TS: OptionalType).
    // Elements are comma-SEPARATED: a `,` is required between elements (`[A B]` and
    // even `[A\n B]` are tsc's "',' expected" — unlike object types, a newline does NOT
    // separate tuple members), while the LAST element needs none (`]`-ahead). Trailing
    // comma is covered by the `,` arm before the closing-`]` iteration fails to start.
    ['[', many(opt('...'), opt(Ident, opt('?'), ':'), opt('...'), $, opt('?'), alt([','], [not(not(']'))])), ']'],
    // object type literal (tsc's parseTypeLiteral): the members of an object type, as in an
    // interface body. It is the literal only where a mapped type does not start (see the mapped
    // type arm, last below): tsc chooses between the two by that lookahead, so
    // `{ [K in T]: U, }` is a mapped type missing its `;`, not a computed member `[K in T]`.
    ['{', not(mappedTypeStart), many(TypeMember), '}'],
    ['asserts', Ident, opt('is', $)],
    [$, 'extends', $, '?', $, ':', $],
    // infer U | infer U extends T | infer U extends T ? X : Y (conditional binds to the infer)
    ['infer', ...bindingIdentifier, opt('extends', $, opt('?', $, ':', $))],
    String_,
    Number_,
    HexNumber, OctalNumber, BinaryNumber, BigInt_,
    ['-', alt(Number_, BigInt_)],
    'true', 'false', 'null', 'undefined', 'void',
    // The `this` type, and `this is T` — the this-type predicate. tsc parses the predicate
    // where it parses the `this` type (parseNonArrayType: a `this` followed by `is` on the
    // same line), so it is a type like any other: annotation, parameter, cast, type argument,
    // union member, parenthesized, …. The target is a whole Type (`this is A | B`,
    // `this is this is T`). A line break before `is` leaves a plain `this` type
    // (`p: this⏎ is: number` is two class members).
    ['this', opt(sameLine, 'is', $)],
    ['unique', $],   // `unique` is a general prefix type operator (tsc parses `unique <Type>`); `unique symbol` is the checker-valid case
    ['import', '(', $, ')'],
    withHoles(Template, $),   // template-literal type: its `${…}` holes are types
    [$, sameLine, '[', $, ']'],   // indexed access T[K] — `[` must be on the same line (no ASI)
    // qualified type name `A.B`: a TypeName's root is an IdentifierReference, so the
    // keyword/literal types `void`/`null`/`true`/`false`/`this` are NOT `.`-qualifiable
    // (`void.x` has no parse tree — tsc rejects; @babel/parser is lenient but the spec
    // PRODUCTIONS make it underivable). `undefined`/`number`/`string`/… are identifier-rooted
    // and stay qualifiable. `notLeftLeaf(...)` gates the arm on the LEFT node's head leaf; it is
    // zero-width, so tree-sitter DROPS it (the derived GLR grammar keeps the unconstrained `.`
    // LED — a left-leaf predicate is not expressible in GLR, and a stray `void.x` is harmless for
    // a highlighter). No tsRelax wrapper is needed: the marker is itself the relaxation point.
    [notLeftLeaf('void', 'null', 'true', 'false', 'this'), $, '.', Ident],
    // ── JSDoc types — tsc parses these in NORMAL TS type positions (the checker
    // rejects them with "JSDoc types can only be used inside documentation
    // comments"), so the parse surface must accept them. ──
    [notLeftLeaf('void', 'null', 'true', 'false', 'this'), $, '.', '<', sep($, ','), '>'],   // dotted type arguments: Array.<number>
    ['?', $],    // prefix nullable: ?number
    ['!', $],    // prefix non-nullable: !string
    '?',         // JSDocUnknownType: a bare `?` (when no type follows)
    '*',         // JSDocAllType
    // JSDoc function type `function(this: T, string): U`. Its list holds TYPES, not parameters
    // (tsc's parseJSDocParameter): each is an optional `this:` / `new:` label, then tsc's
    // parseJSDocType — an optional `...`, then a type or type predicate (parseTypeOrTypePredicate,
    // as a return type). A `this` / `new` there is the label, so it needs its `:`. Not modelled:
    // parseJSDocType's trailing `=` (`function(string=)`) and its `module` name path, and the
    // list's start test (isStartOfParameter), which stops the list at a reserved word that
    // starts no type (`function(if)`).
    ['function', '(', sep(alt([alt([alt('this', 'new'), ':'], not(alt('this', 'new'))), opt('...'), ReturnType]), ','), ')', opt(':', $)],
    // postfix nullable `T?`: tsc takes the `?` only when the NEXT token cannot start
    // a type (`TypeStart`, its isStartOfType) — otherwise the `?` belongs to a conditional
    // type / an expression-level ternary after `as T`. No line break before postfix (tsc).
    [$, sameLine, '?', not(TypeStart)],
    [$, sameLine, '!'],   // postfix non-nullable: T!
    // mapped type (tsc's parseMappedType): `{`, an optional `readonly` (or `+readonly` /
    // `-readonly`), the type parameter `[K in T]` with an optional `as` clause, an optional `?`
    // (or `+?` / `-?`), an optional `: T`, then a statement end, and then the members of an
    // object type (tsc parses them; the checker rejects them). A different TYPE from the object
    // type literal, not a member of one: in a member list `[K in T]` is a computed name. Last
    // among the arms so the shape layers' arm indices of the others stay as they were.
    // tsRelax: tree-sitter renders no members after the mapped one (only an optional `;`). Its
    // statement end is a blank there, so `: T` would run straight into a following member
    // (`: T [k…`, `: T <U>(…`) and each such pair is an LR conflict; a highlighter missing
    // members the checker rejects anyway is harmless.
    ['{', opt(opt(alt('+', '-')), 'readonly'), '[', ...bindingIdentifier, 'in', $, opt('as', $), ']', opt(opt(alt('+', '-')), '?'), opt(':', $), tsRelax([asi(), many(TypeMember)], [opt(';')]), '}'],
  ];
}, { type: true });

// tsc's isStartOfMappedType, read after the `{`: `+readonly` / `-readonly`, or `readonly`? then
// `[ identifier in` (isIdentifier: no reserved word, so `{ [if in K]: U }` is no mapped type).
const mappedTypeStart = alt([alt('+', '-'), 'readonly'], [opt('readonly'), '[', ...bindingIdentifier, 'in']);

// ── Expressions ──

// A modifier KEYWORD is a modifier only when the start of a member follows it; otherwise the
// word is the member's NAME (`public() {}`, `static = 1`, `{ static: 1 }`, and equally after
// other modifiers: `public static() {}`). This is tsc's parser rule (nextTokenCanFollowModifier),
// and JavaScript's (`memberWord` in javascript.ts, which states the rule and the words `static`,
// `get`, `set`, `async`, `accessor` once; the TypeScript words extend it).
// A member start is a property name, `[` or `*` (tsc also lists `{` and `...`; no member
// starts with either, so the word rejects under both readings). What differs per word is one
// further condition, held in `modifierExtra` (JavaScript's `memberWordRules` and these):
//   static              none                                (`static⏎x` is a static `x`)
//   export              the start, or a decorator, is not `as` or `*`; a `default` start is one `default`
//                       takes (`export default class: T`; `export default: T` is a member
//                       `export`, then a stray `default`), and a `type` start is followed by
//                       one `export` takes (`export type⏎x: T`; `export type: T` and
//                       `export type⏎as: T` are a member `export`, then a stray `type`)
//   default             the start is `class`, `function`, `interface` or a decorator, or `abstract` /
//                       `async` with `class` / `function` on its line, on any line after
//                       `default` (`default class() {}`; `default x` is a member `default`,
//                       then a stray `x`)
//   const               the start is `enum`, on any line (`{ const enum: T }`;
//                       `{ const x: T }` rejects); in a class body, see below
//   get / set           the start is not `*`                (`get⏎x() {}` is a getter)
//   every other word    the start is on the word's own line (`public⏎x` is two members)
// These are tsc's nextTokenCanFollowModifier, the lookahead its statements share (hence the
// declaration keywords: `export default class`, `export type`, `const enum`). A class body is
// the one member list that reads `const` as an ordinary same-line word (tsc's
// permitConstAsModifier: `class C { const x }`), so its runs pass `sameLineConst`.
// `export` and `default` are the two words a decorator may follow (tsc's canFollowExportModifier
// and nextTokenCanFollowDefaultKeyword list `@`; canFollowModifier does not), so theirs is the
// one follower that is no member start: `export @d class C {}`, `@d default @e class C {}`,
// `x = { export @d m() {} }`. Every other word before a `@` is no modifier (`public @d x`).
// Every modifier run of declarations, class expressions, class, object-literal and type members
// is built from `modifierWord`, so no word is consumed as a modifier unchecked.
// tsc's canFollowExportModifier and nextTokenCanFollowDefaultKeyword, read at the word after
// `export` / `default`. (Each one-token alternation sits in its own double `not`, which the
// emitted parsers test as one token set.)
const exportAhead = [not(alt('as', '*')), not(not(alt('@', Decorator, memberStart)))];
const defaultAhead = alt(not(not(alt('class', 'function', 'interface', '@', Decorator))), ['abstract', sameLine, 'class'], ['async', sameLine, 'function']);
// JavaScript's words (`memberWordRules`: static, get, set), extended with TypeScript's.
const modifierExtra: Record<string, unknown[]> = {
  ...memberWordRules,
  export: [not(alt('as', '*')), not(['default', not(defaultAhead)]), not(['type', not(exportAhead)])],
  default: [not(not(defaultAhead))],
  const: [not(not('enum'))],
};
const { const: _const, ...classBodyExtra } = modifierExtra;
// Where a second decorator run is read (`secondRun`), `export` and `default` state their
// follower in full: a member start or a decorator. Elsewhere a decorator after them is no
// member's (class and object-literal members read no second run: see ClassMember), so the word
// is the member's name there (`class C { export⏎@d x() {} }` is a field `export`, then a member).
const followsDecorator: Record<string, unknown[]> = {
  export: [not(['default', not(defaultAhead)]), not(['type', not(exportAhead)]), ...exportAhead],
  default: [not(not(defaultAhead))],
};
// A parameter's modifiers: tsc's canFollowModifier also lists `{` and `...`, which start a
// parameter (`f(public { a })`, `f(readonly ...a)`), though no member; `export` takes no `{`
// (canFollowExportModifier), and `default` only its own followers.
const paramStart = alt(memberStart, '{', '...');
const paramExportAhead = [not(alt('as', '*', '{')), not(not(alt('@', Decorator, paramStart)))];
const paramFollows: Record<string, unknown[]> = {
  export: [not(['default', not(defaultAhead)]), not(['type', not(paramExportAhead)]), ...paramExportAhead],
  default: followsDecorator.default!,
};
type ModifierOpts = { sameLineConst?: boolean; param?: boolean; secondRun?: boolean };
const modifierWord = (words: string[], { sameLineConst = false, param = false, secondRun = false }: ModifierOpts = {}) => {
  const follows: Record<string, unknown[]> = param ? paramFollows : secondRun ? followsDecorator : {};
  const rest = words.filter(w => !(w in follows));
  const own = words.filter(w => w in follows).map(w => [w, ...follows[w]!]);
  const plain = rest.length ? memberWord(rest, sameLineConst ? classBodyExtra : modifierExtra, param ? not(not(paramStart)) : undefined) : null;
  return own.length ? alt(...(plain ? [plain] : []), ...own) : plain;
};
// A modifier run holds AT MOST ONE `static` (tsc stops taking `static` as a modifier once it
// has one; ECMAScript's ClassElement has a single `static` slot): the only reading of a
// second `static` is the member NAME, so `static static x` has no production. `run` is that
// shape, `run1` the same with at least one word. It doubles the modifier-vs-name decision
// points against the member arms, which explodes tree-sitter's GLR table, so tree-sitter
// renders the plain repetition (tsRelax): a highlighter over-accepting `static static` is
// harmless and measured. tree-sitter renders no lookahead, so a word whose modifier reading
// only the lookahead tells from a statement keyword (`const` in an object literal or object
// type, where `{ const [e]: 1 }` and the block `{ const [a] = b }` share a prefix, as do an
// arrow's `=> { const [` block and a return-type literal) is left out of its rendering
// (`treeSitterOmits`): a highlighter missing `{ const enum: 1 }` is harmless.
const modifierRun = (words: string[], opts: ModifierOpts & { treeSitterOmits?: string[] } = {}) => {
  const strictAny = modifierWord(words, opts), stat = modifierWord(['static'], opts.param ? { param: true } : {});
  const rest = modifierWord(words.filter(w => w !== 'static'), opts);
  const shown = words.filter(w => !opts.treeSitterOmits?.includes(w));
  const tsAny = shown.length === words.length ? strictAny : modifierWord(shown, opts);
  // The words are named: `modifier` before the `static` slot, `staticModifier`, `modifierAfterStatic`
  // (`runNamed` names them otherwise, for a second run in one scope).
  const runNamed = (m: string, s: string, a: string) => tsRelax([many(field(m, rest)), opt(field(s, stat), many(field(a, rest)))], many(tsAny));
  return {
    any: tsAny === strictAny ? strictAny : tsRelax(strictAny, tsAny), stat, rest, runNamed,
    run: runNamed('modifier', 'staticModifier', 'modifierAfterStatic'),
    run1: tsRelax(alt(
      arm('plain', many1(field('modifier', rest)), opt(field('staticModifier', stat), many(field('modifierAfterStatic', rest)))),
      arm('static_', field('staticModifier', stat), many(field('modifierAfterStatic', rest))),
    ), many1(tsAny)),
  };
};

// A class expression's decorators and modifiers (tsc's parseDecoratedExpression, entered at a
// `@`): every modifier word but `const` (a modifier only before `enum`).
const classExprMods = modifierRun(['abstract', 'accessor', 'async', 'declare', 'default', 'export', 'in', 'out', 'override', 'private', 'protected', 'public', 'readonly', 'static'], { secondRun: true });
const classExprPrefix = opt(many1(field('decorator', DecoratorExpr)), classExprMods.run, opt(many1(field('decoratorRest', DecoratorExpr)), classExprMods.runNamed('modifierRest', 'staticModifierRest', 'modifierRestAfterStatic')));

// An object-literal member is tsc's parseObjectLiteralElement: a spread, or a modifier run
// (parseModifiers) and then one member. The run is one list in which `async` is a word like the
// others (`{ static async m() {} }`, `{ async static m() {} }`, `{ async async m() {} }`,
// `{ async x: 1 }`, `{ static x }` all parse; which modifiers a member may carry is the
// checker's question) and `static` comes at most once (tsc stops taking `static` as a modifier
// once it has one, so a second one is the member's name: `{ static async static m() {} }`
// rejects). Every member may follow every run:
//   accessor     `get` / `set`, a name, type parameters, ( … ): T, then a body or none
//   `*` method   a name, `?`, `!`, type parameters, ( … ): T, then a body or none
//   method       a name, `?`, `!`, type parameters, ( … ): T, then a body or none
//   value        a name, `?`, `!`, `: v`
//   shorthand    an identifier that is not a reserved word, `?`, `!`, `= v`
//                (`{ class }` and `{ static class }` reject; `{ class: 1 }` is a value)
// A method's body is a function declaration's (parseFunctionBlockOrSemicolon): a block, or none,
// and then the member ends as a statement does (`{ m() }`, `{ m(); }`, `{ m()⏎, n }` parse;
// `{ m(), n }` rejects). What the run decides is the body's context: params and body are
// [Await] after a run that holds `async`, [Yield] after a `*`, both for both, and reset
// otherwise (parseMethodDeclaration); an accessor's are reset after any run
// (parseAccessorDeclaration takes no `async`). The name and return type stay outside the family
// (a computed key inherits the enclosing context, type positions are not parameterized).
//   A word is a modifier only where `modifierWord` says so; otherwise it is the member's name
// (`{ static: 1 }`, `{ async }`, `{ get: 1 }`, `{ public static() {} }`).
//   The run is parsed ONCE and the member decided after it, so its shape carries what the
// member needs to know: whether an `async` has been read (the body's context), and whether a
// `static` has (whether another may come). Those are the four places a run can stop at, and
// the members are `members(…)` at each, under the context its `async` gives. tree-sitter has no
// [Await] context, and renders the plain repetition of `modifierRun` for the run (tsRelax).
// The inner alt() is first-match; its branches part at one token (`get`/`set` then a name, `*`,
// a name then `?`/`!`/`<`/`(`/`:`, or a name alone), so the first that matches is the only one.
const Prop = rule($ => {
  const mods = modifierRun(['public', 'private', 'protected', 'static', 'abstract', 'readonly', 'override', 'accessor', 'export', 'declare', 'in', 'out', 'const', 'default'], { treeSitterOmits: ['const'], secondRun: true });
  const asyncMod = modifierWord(['async']);
  const sig = (ctx) => [opt(field('typeParameters', TypeParams)), '(', sep(ctx(field('parameter', Param)), ','), ')', opt(':', ReturnType), ctx(field('body', fnBodyOrAsi()))];
  const marks = [opt(field('question', '?')), opt(field('exclamation', '!'))];
  const members = (generator, method) => field('member', alt(
    arm('accessor', field('kind', alt('get', 'set')), field('key', MemberName), ...sig(resetCtx)),
    arm('generatorMethod', field('asterisk', '*'), field('key', MemberName), ...marks, ...sig(generator)),
    arm('named', field('key', MemberName), ...marks, field('tail', alt(arm('method', ...sig(method)), arm('init', ':', field('value', Expr))))),
    arm('shorthand', notReserved, field('name', Ident), ...marks, opt(field('equals', '='), field('value', Expr))),
  ));
  const plain = members(yieldCtx, resetCtx), withAsync = members(asyncGenCtx, awaitCtx);
  // tsc reads one decorator run inside the modifier run, after a word (only `export` / `default`
  // may precede it: `modifierWord`'s `secondRun` followers), and a member never starts with one
  // (`@` begins no element of tsc's object literal list: `{ @d m() {} }` has no parse). The run is
  // a word of the run here, and "once" is the lookahead after it (`{ export @d export @e m() {} }`
  // has no parse; it runs only where a decorator run was read): stating it by shape, as `static`
  // and `async` are, makes the run's stop places eight instead of four, and the TextMate
  // generator, which expands every rule body into its sequences (gen-tm's expandAlts), runs out
  // of memory on it (2 GB heap, `npm run gen`).
  const runWord = alt(mods.any, asyncMod);
  const decorators = [many1(DecoratorExpr), not([many(runWord), alt('@', Decorator)])];
  const words = many(field('word', alt(mods.rest, decorators))), asyncWords = many(field('word', alt(mods.rest, asyncMod, decorators)));
  return [
    arm('spread', '...', field('argument', Expr)),
    arm('member', tsRelax(
      [not(alt('@', Decorator)), words, field('form', alt(
        arm('static_', field('staticWord', mods.stat), words, field('afterStatic', alt(arm('async', field('asyncWord', asyncMod), asyncWords, withAsync), arm('plain', plain)))),
        arm('async', field('asyncWord', asyncMod), asyncWords, opt(field('staticWord', mods.stat), many(field('wordAfterStatic', alt(mods.rest, asyncMod, decorators)))), withAsync),
        arm('plain', plain),
      ))],
      [many(alt(mods.any, asyncMod)), plain],
    )),
  ];
});

// A function/method/accessor/arrow/fn-type RETURN type. For the PARSER it adds the
// identifier-subject type predicate `x is T` on top of an ordinary Type — the one predicate
// form tsc's parser accepts ONLY in return position (parseTypeOrTypePredicate). The SUBJECT is
// an identifier (a reserved word, number, string, qualified or parenthesized subject rejects;
// `await`/`yield` are ordinary-identifier subjects), `is` follows it on the same line, and the
// TARGET is an ordinary Type, so `x is y is z` rejects. The other predicate forms are NOT
// here: `this is T` and `asserts x` / `asserts x is T` are arms of the general Type (tsc
// parses them in any type position), so a return type written that way is the Type arm below.
// It stays TRANSPARENT (the strict side is a plain `alt`, not a rule), so a normal return is a
// bare `Type` node — identical CST shape to a pre-predicate return slot, leaving AST lowering /
// cst-match unaffected. tsRelax: tree-sitter renders just `Type` here (the predicate lives in
// its general type instead), so adding ReturnType to ~18 slots doesn't inflate its GLR table.
const ReturnType = tsRelax(field('returnType', alt([notReserved, Ident, sameLine, 'is', Type], Type)), Type);   // `field` inside: a name on the tsRelax group is not taken

// The heritage forms are JavaScript's (`classHeritageArms`, javascript.ts); TypeScript's class
// expression carries type parameters and an `implements` clause, and a base may take type
// arguments (`extends Base<T>`, tsc's ExpressionWithTypeArguments).
const ClassHeritage = rule($ => classHeritageArms($, Expr, NewTarget,
  ['class', opt(...bindingIdentifier), opt(TypeParams), opt('extends', $), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}'],
  [[$, '<', sep(Type, ','), '>']]));

// Heritage clauses, shared by every class shape: tsc parses REPEATED and order-free
// `extends`/`implements` clauses (`class D extends A extends B implements I`), each a
// comma list; element parses stop at the next clause keyword (the not() guard), and a
// clause may even be EMPTY (`class M extends { }` — tsc reads `{` as the body). A heritage
// element may be an object literal (a LeftHandSideExpression), and an empty one `{}` is that
// element only where a `,`, `{`, `extends` or `implements` follows it (tsc's
// isValidHeritageClauseObjectLiteral), so the class body is not read as a heritage element:
// `class M extends {} {}` has the base `{}`, `class M extends {}` none. Where a `{` starts such an
// element (any `{` but a `{}` that none of those follows), tsc parses the element there, so the
// list is not empty: `class M extends { a: T; } {}` has no parse (the `{` is no class body). So
// the list is a possibly-empty one where no such `{` starts, or one that starts with an element.
// (Stated as one list followed by a guard on its emptiness, `alt([el, many(',', el), opt(',')],
// not(...))`, the TextMate generator runs out of memory: 2 GB heap, `npm run gen`.) tree-sitter,
// which renders no lookahead, keeps the plain list of elements (tsRelax): the two branches and the
// `{}` guard would only be one more conflict and dropped lookaheads there.
const heritageFollowers = alt(',', '{', 'extends', 'implements');
// Named: each clause `heritage` (`extends_` / `implements`); its elements `element` (the first, in
// the branch that starts with one) and `elementRest`; an element's expression `base`.
const heritageElement = alt([not(alt('extends', 'implements')), not(['{', '}', not(heritageFollowers)]), field('base', ClassHeritage)]);
const heritageList = [tsRelax(field('elements', alt(
  arm('list', not(alt(['{', not('}')], ['{', '}', heritageFollowers])), sep(field('elementRest', heritageElement), ',')),
  arm('first', field('element', heritageElement), opt(',', sep(field('elementRest', heritageElement), ','))),
)), sep(alt([not(alt('extends', 'implements')), ClassHeritage]), ','))];
const heritageClauses = many(field('heritage', alt(
  arm('extends_', field('keyword', 'extends'), ...heritageList),
  arm('implements', field('keyword', 'implements'), ...heritageList),
)));

// The `new` callee forms are JavaScript's (`newTargetArms`, javascript.ts); a TypeScript `new`
// may take type arguments, and so may a template's tag.
const NewTarget = rule($ => newTargetArms($, Expr,
  opt(alt([...typeArgsInExpr(), opt('(', sep(Expr, ','), ')')], ['(', sep(Expr, ','), ')'])),
  { identGuard: notReservedExpr, Prop, fnExprArms: tsFnArms([opt(...bindingName)], Block), taggedTemplate: [[$, ...typeArgsInExpr(), Template]] }));

// Expression type arguments `<T, U>` (tsc's parseTypeArgumentsInExpression): tsc rescans the
// closing token, so a `>>`/`>=`/`>>=`/`>>>`/`>>>=` there is not a closing `>` — `a < b >> c` is a
// shift inside a comparison. Only a type's own nested `>` takes the first `>` of such a token.
const typeArgsInExpr = () => ['<', sep(Type, ','), not(alt('>>', '>=', '>>=', '>>>', '>>>=')), '>'];

// tsc's canFollowTypeArgumentsInExpression, read at the token after a bare instantiation's
// `>`: `<`, any `>`-led token (tsc scans `>` alone), `+`, `-`, `(` and a template never end
// it; otherwise it ends unless the next token is on the same line, starts an expression and
// is not a binary operator. tsc scans a `/` there as division (a binary operator), so a regex
// literal does not count as starting an expression.
const startsExprNotBinary = alt(
  [not(alt('as', 'satisfies', 'in', 'instanceof')), Ident],
  Number_, HexNumber, OctalNumber, BinaryNumber, BigInt_, String_, PrivateField, '@', Decorator,
  '[', '{', '!', '~', '++', '--',
);
const instantiationEnd = not(alt(
  '<', '>', '>=', '>>', '>>=', '>>>', '>>>=', '+', '-', '(', Template,
  [sameLine, startsExprNotBinary],
));

const Expr = rule($ => [
  // The keyword-valued literals and `this` (reserved words, so the identifier below refuses
  // them: each is its own arm alone).
  'true', 'false', 'null', 'this',
  // `super` is a CONSTRAINED primary (mirrors tsc's parseSuperExpression): it MUST be
  // immediately followed by a call `(args)`, a member `.name`/`.#priv`, or an element
  // `[expr]` access. Bare `super`, `super<T>()`, `super?.x`, a super-tagged-template, and
  // `super = …` are all parse errors. Modeling super as a bare atom would let the generic
  // LEDs (type-arg call, optional chain, tagged template, assignment) attach and re-open
  // that whole class; further access chains off the RESULT normally (`super.x<T>()`).
  [field('superKeyword', 'super'), alt(['(', sep($, ','), ')'], ['.', alt(Ident, PrivateField)], bracketIndex($))],
  // A standalone identifier expression (IdentifierReference): never a reserved word (see
  // notReservedExpr), so `catch(x){}` with no `try`, `void ;`, `throw ;`, and a failed `super` /
  // `new` arm (`new <T>Foo()` is no `(new < T) > Foo()`) are no expression.
  [notReservedExpr, Ident],
  Number_,
  String_,
  Template,
  Regex_,
  [$, op, $],
  [prefix, $],
  // Postfix `++`/`--` is a RESTRICTED production (`LeftHandSideExpression [no LineTerminator
  // here] ++`): after a line break the operator is not this operand's — `x\n++\ny` is
  // `x; ++y`, and `x\n++\n++\ny` is `x; ++ ++y` (rejected by the prefix target check).
  [$, sameLine, postfix],
  ['...', $],
  // typed call / tagged template: f<T>(…) | f<T>`…` — a call/tag may itself be
  // continued by member access (`f<T>().x`), so this is an ordinary access tail.
  [$, ...typeArgsInExpr(), alt(['(', sep($, ','), ')'], Template)],
  // bare instantiation `f<T>` (no call/tag): allowed only where tsc's
  // canFollowTypeArgumentsInExpression allows it (`instantiationEnd`) — otherwise `<`/`>`
  // were comparisons (`f < a, b > 7`). Ending in a negative lookahead, this LED closes the
  // access tail (it asserts nothing follows), so a `.`/`?.` property access can't chain off
  // it: `Foo<T>.Bar` is rejected (TS1477 — a bare instantiation is not a valid base for
  // property access).
  [$, ...typeArgsInExpr(), instantiationEnd],
  [$, '(', sep($, ','), ')'],
  [$, '.', alt(Ident, PrivateField)],
  // optional chaining: ?.x | ?.#x | ?.(args) | ?.[i] | ?.`…` | ?.<T>(args). A private member
  // `a?.#x` IS valid current ECMAScript (V8 + Babel accept; tsc's lone parse rejection is a bug
  // being removed in TS#60263), so PrivateField stays — the CST producer models the syntax, not
  // a tsc-only restriction. Any "no private in optional chain" rule, were it real, would be a
  // Static-Semantics check in a CST consumer, never a parse-level exclusion here.
  // Owed: `a?.[0, 1]` (tsc accepts): one expression here, as in JavaScript's Expr (the v1 shape).
  [$, field('questionDot', '?.'), alt(Ident, PrivateField, ['(', sep($, ','), ')'], ['[', $, ']'], Template, [...typeArgsInExpr(), '(', sep($, ','), ')'])],   // optional typed call `a?.<T>(args)`
  [$, ...bracketIndex($)],
  [$, sameLine, '!'],   // TS non-null assertion — RESTRICTED (no line break before `!`, like postfix ++/--); a LHS-chain tail (access can follow: `x!.y`, `x!()`)
  [$, field('question', '?'), field('then', $), field('colon', ':'), field('otherwise', $)],
  [$, 'as', Type],
  [$, field('instanceofKeyword', 'instanceof'), $],
  [$, field('inKeyword', 'in'), $],
  [$, Template],
  // `new.target` meta-property — the ONLY form where `new` is not followed by a target.
  // Listed before the `new T` arm and matched by the dedicated `new` arms (NOT the bare
  // identifier nud, which excludes `new`), so `new <T>Foo()` — where the `new T` arm fails
  // on the leading `<` — can no longer fall through to `new` as an identifier and reparse
  // as the comparison `(new < T) > Foo()` (tsc: "Expression expected").
  arm('newDotTarget', field('newKeyword', 'new'), '.', field('targetKeyword', 'target')),
  // new T | new T(args) | new T<X> | new T<X>(args). An optional chain may NOT follow a bare
  // `new` (no Arguments): a NewExpression is not a valid `?.` base (the base must be a
  // MemberExpression / CallExpression — i.e. a `new` WITH `( )`), so `new a?.b`, `new a<T>?.b`,
  // `new class{}?.x`, `new new a()?.x` have no parse tree (tsc + V8 + babel all reject). The
  // `not('?.')` guards exactly the no-call exits; `new a()?.b` (Arguments consumed) chains via
  // the outer `?.` LED unchanged.
  arm('construct', 'new', NewTarget, alt(
    [...typeArgsInExpr(), alt(['(', sep($, ','), ')'], not('?.'))],
    ['(', sep($, ','), ')'],
    not('?.'),
  )),
  ['new', 'class', ...bindingIdentifier, opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}', alt(['(', sep($, ','), ')'], not('?.'))],
  ['new', 'class', opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}', alt(['(', sep($, ','), ')'], not('?.'))],
  arm('array', field('bracket', '['), opt(field('element', $)), many(field('comma', ','), opt(field('elementRest', $))), ']'),   // array literal: each element parsed once (see javascript.ts)
  arm('object', '{', sep(field('property', Prop), ','), '}'),
  // Arrow functions, async/non-async SPLIT so the [Await] grammar parameter routes
  // each arm's params + body to the right rule family (await-yield-fork.ts): an async
  // arrow's params and body are await-context (`async (a = await) =>` rejects), a
  // plain arrow's body resets. Type params/annotations stay PLAIN (not await-context).
  // capExpr('?'): an ArrowFunction is the LOWEST-precedence AssignmentExpression — neither a
  // binary/logical/conditional operand nor an assignment target — so each arm is capped BELOW
  // the conditional `?`: it parses only at an assignment-or-looser minBp and admits no led once
  // parsed (`() => {} || a` rejects, NOT `(() => {}) || a`); a `||`/`?:` INSIDE an expression
  // body (`() => a || b`) is unaffected. The body is the JavaScript ConciseBody (`conciseBody`).
  // An arrow's type parameter list starts with a name or `const` (tsc's
  // isParenthesizedArrowFunctionExpression: after `<` an identifier or `const`, else the `<` is
  // a type assertion's), so `<>() => 1` and `<in T>() => 1` are no arrows; a declaration's or a
  // function type's list may be empty (`function f<>() {}`, `type F = <>() => void`).
  arm('asyncArrow', capExpr('?', field('asyncKeyword', 'async'), notArrowTypeParams, opt(field('typeParameters', TypeParams)), '(', sep(awaitCtx(field('parameter', Param)), ','), ')', opt(":", ReturnType), field('arrow', '=>'), awaitCtx(field('body', conciseBody(Block, $))))),
  arm('arrow', capExpr('?', notArrowTypeParams, opt(field('typeParameters', TypeParams)), '(', sep(field('parameter', Param), ','), ')', opt(":", ReturnType), field('arrow', '=>'), resetCtx(field('body', conciseBody(Block, $))))),
  // async arrow with a BARE parameter: `async err => …`. tsc requires async and the
  // parameter on the same line (`async\nx => …` is `async;` then a plain arrow — ASI).
  // Without this arm the bare form only "parsed" by splitting into two statements.
  arm('asyncArrowIdentifier', capExpr('?', field('asyncKeyword', 'async'), sameLine, awaitCtx(notReservedExpr, field('parameter', Ident)), field('arrow', '=>'), awaitCtx(field('body', conciseBody(Block, $))))),
  arm('arrowIdentifier', capExpr('?', notReservedExpr, field('parameter', Ident), field('arrow', '=>'), resetCtx(field('body', conciseBody(Block, $))))),
  arm('yield_', capExpr('?', 'yield', alt([field('asterisk', '*'), $], [opt($)]))),   // yield e | yield* e (delegate) | yield: an AssignmentExpression, capped as javascript.ts's
  ['(', field('first', $), many(field('comma', ','), field('rest', $)), ')'],
  [$, 'satisfies', Type],
  arm('import_', field('importKeyword', 'import'), field('form', alt(arm('call', '(', field('source', $), ')'), arm('meta', '.', field('metaKeyword', alt('meta', 'defer', 'source'))), arm('typeArguments', ...typeArgsInExpr(), opt('(', sep($, ','), ')'))))),   // import(e) | import.meta | import.defer / import.source (tsc's parser reads `import.` and a name as a MetaProperty; a call after it is the call LED) | import<T>(args) (instantiation-expression; checker rejects)
  PrivateField,
  HexNumber, OctalNumber, BinaryNumber, BigInt_,
  ...tsFnArms([opt(...bindingName)], Block),
  // named vs anonymous kept separate (greedy opt(Ident) would eat a leading
  // `extends`/`implements`). A decorated class expression is tsc's parseDecoratedExpression:
  // decorators, modifier words, a second decorator run after `export` / `default`, then `class`
  // (`x = @d @e class C {}`, `x = @d export @e class {}`, `x = @d abstract class {}`; without a
  // decorator a modifier word is an identifier, so `x = abstract class {}` has no parse).
  arm('namedClass', classExprPrefix, 'class', ...bindingName, opt(field('typeParameters', TypeParams)), heritageClauses, '{', many(field('member', ClassMember)), '}'),
  arm('anonymousClass', classExprPrefix, 'class', opt(field('typeParameters', TypeParams)), heritageClauses, '{', many(field('member', ClassMember)), '}'),
  ['<', Type, '>', $],
]);

// ── Statements ──

const Block = rule($ => [
  ['{', many(Stmt), '}'],
]);

// ── Destructuring Patterns ──

const BindingProperty = rule($ => [
  // `name: elem` — the KEY is a PropertyName, so a reserved word is allowed here
  // (`{ while: y }`); the bound name inside `elem` is guarded by BindingElement.
  arm('identPair', field('key', Ident), ':', field('value', BindingElement)),
  // shorthand `a` / shorthand-with-default `a = 1` — the name is a BindingIdentifier,
  // so a reserved word is invalid (`{ while }`, `{ class }`).
  arm('shorthand', ...bindingName, opt('=', field('value', Expr))),
  arm('pair', field('key', alt(String_, Number_, HexNumber, OctalNumber, BinaryNumber, BigInt_, arm('computed', field('bracket', '['), field('expr', Expr), field('bracketClose', ']')))), ':', field('value', BindingElement)),  // "s"/0/0x1/1n/[e]: elem (a LiteralPropertyName or a ComputedPropertyName)
  // rest: ...r | ...{ a } — tsc also parses `...r: name` and `...r = init` (the
  // object-binding-element shape is uniform; "rest can't have a property name /
  // initializer" are checker errors, both parse-clean).
  arm('rest', field('ellipsis', '...'), field('argument', alt(bindingIdentifier, BindingPattern)), opt(':', field('element', BindingElement)), opt('=', field('value', Expr))),
]);

const BindingElement = rule($ => [
  [field('name', alt(bindingIdentifier, BindingPattern)), opt('=', field('value', Expr))],  // a | { a }  (optionally = default)
]);

const ArrayBindingElement = rule($ => [
  BindingElement,
  arm('rest', field('ellipsis', '...'), field('argument', alt(bindingIdentifier, BindingPattern))),    // [...rest] | [...{ a }]
]);

const BindingPattern = rule($ => [
  arm('object', '{', sep(field('property', BindingProperty), ','), '}'),                  // { a, b: c, ...rest }
  // [a, , b, ...rest]: a hole is an absent element. The `[` and each `,` are named: a hole's
  // position is the end of the token before it (tsc's OmittedExpression).
  arm('array', field('bracket', '['), opt(field('element', ArrayBindingElement)), many(field('comma', ','), opt(field('elementRest', ArrayBindingElement))), ']'),
]);

// ── Bindings & Parameters ──

const Binding = rule($ => [
  [field('name', alt([...bindingIdentifier, opt(field('exclamation', '!'))], BindingPattern)), opt(':', field('type', Type)), opt('=', field('value', Expr))],
]);

// A binding in a for-head (`forBindingArms`) with its type annotation. No definite-assignment
// `!`: tsc's parser reads a for-head's declarations with parseVariableDeclaration, which takes
// none (`for (var a!: T;;)` is a parse error), where a variable statement's take one.
const ForBinding = rule($ => forBindingArms(BindingPattern, Expr, [opt(':', Type)]));


const paramMods = modifierRun(['public', 'private', 'protected', 'readonly', 'override', 'static', 'abstract', 'accessor', 'async', 'export', 'declare', 'in', 'out', 'default'], { param: true });
const Param = rule($ => {
  const tail = [opt(field('question', '?')), opt(':', field('type', Type)), opt('=', field('value', Expr))];   // ?  : T  = E
  const name = field('name', alt(bindingIdentifier, BindingPattern));
  const body = alt(
    // The name is a BindingIdentifier (tsc's parseNameOfParameter → parseBindingIdentifier),
    // in every parameter list, value or type: no reserved word, and so not `this`, which tsc
    // treats as a special parameter form accepting ONLY bare `this` or `this: T` (the
    // dedicated arm below) — `this?`, `this = 1`, `this: T = 1`, and any decorated/modified
    // `this` (`@dec this`, `public this`) are parse errors there.
    arm('single', name, ...tail),
    arm('rest', field('ellipsis', '...'), name, ...tail),   // rest (`?`/initializer are CHECKER errors in tsc, not parse errors)
  );
  return [
    // `this`-param: bare `this` or `this: T` ONLY — no `?`, no default, no decorator,
    // no modifier (tsc's parser rejects all of those). This is the SOLE way `this`
    // reaches param position; the plain-name arm above excludes it.
    arm('thisParameter', field('thisKeyword', 'this'), opt(':', field('type', Type))),
    // tsc's parseModifiers, then the binding: decorators (any number, `f(@a @b x)`), modifier
    // words, and after `export` / `default` a second decorator run (`f(export @d x)`). tsc
    // parses the FULL modifier soup on any parameter (`f(static x)`, `f(export x)`, `f(async x)`
    // are parse-clean — validity is the checker's job). Each word is a modifier only where
    // `modifierWord` says so, so a parameter NAMED like one (`public: T`, `f(public)`) is the
    // name (the second arm), `public @d x` has no parse, and the two runs hold one `static`
    // between them (tsc's hasSeenStaticModifier spans parseModifiers): `f(static static x)` and
    // `f(static export @d static x)` have no parse, `f(export @d static x)` parses. So the words
    // are read in two shapes, parted at the first run's `static`: with it, the second run takes
    // none; without it, the second run is a run of its own.
    arm('modified', many(DecoratorExpr), tsRelax(alt(
      [many(paramMods.rest), paramMods.stat, many(paramMods.rest), opt(many1(DecoratorExpr), many(paramMods.rest))],
      [many1(paramMods.rest), opt(many1(DecoratorExpr), paramMods.run)],
    ), [many1(paramMods.any), opt(many1(DecoratorExpr), many(paramMods.rest))]), field('binding', body)),
    arm('plain', many(field('decorator', DecoratorExpr)), field('binding', body)),
  ];
});

const ForHead = rule($ => forHeadArms(Expr, ForBinding));
const ForAwaitHead = rule($ => forAwaitHeadArms(Expr, ForBinding));

const SwitchCase = rule($ => [
  ['case', Expr, many(',', Expr), ':'],
  ['default', ':'],
  Stmt,
]);

// A catch clause's parameter (14.15 `CatchParameter : BindingIdentifier | BindingPattern`), not
// a FormalParameter, with TypeScript's type annotation (tsc's parseCatchClause reads
// parseVariableDeclaration: a name or pattern and a type, no `!`; which types are allowed is the
// checker's). No initializer: the production has none, and tsc's parser takes one and leaves it
// to the checker (docs/CORRECTNESS.md). No rest, `?`, `this`, decorator or modifier.
const CatchParameter = rule($ => [
  [...bindingIdentifier, opt(':', Type)],
  [BindingPattern, opt(':', Type)],
]);

const Stmt = rule($ => [
  Block,
  // VariableStatement / LexicalDeclaration (14.3): a VariableDeclarationList / BindingList has one
  // or more declarations and no trailing comma, so `var;`, `const;` and `var a,` have no parse,
  // and `let;` is the expression statement of the identifier `let` (sloppy mode).
  arm('variable', field('kind', alt('let', 'const', 'var')), field('binding', Binding), many(field('bindingComma', ','), field('bindingRest', Binding)), asi()),
  ['if', '(', field('condition', Expr), many(field('conditionComma', ','), field('conditionRest', Expr)), ')', field('consequence', $), opt('else', field('alternative', $))],
  forStatement($, ForHead, ForAwaitHead),
  ['while', '(', field('condition', Expr), many(field('conditionComma', ','), field('conditionRest', Expr)), ')', field('body', $)],
  ['do', field('body', $), 'while', '(', field('condition', Expr), many(field('conditionComma', ','), field('conditionRest', Expr)), ')', opt(';')],
  ['switch', '(', Expr, many(',', Expr), ')', '{', many(SwitchCase), '}'],
  // `return [no LineTerminator here] Expression`: after a line break the expression starts the
  // next statement (tsc's parseReturnStatement parses one only where no `;` could be inserted).
  ['return', opt(sameLine, field('argument', Expr), many(field('argumentComma', ','), field('argumentRest', Expr))), asi()],
  ['throw', field('argument', Expr), many(field('argumentComma', ','), field('argumentRest', Expr)), asi()],
  // The label is a RESTRICTED production (`break [no LineTerminator here] Label`)
  // and a label can't be a reserved word — without both, `break` ⏎ `case "X":`
  // inside a switch eats `case` as the label and the whole switch cascades.
  ['break', opt(sameLine, notReserved, field('label', Ident)), asi()],
  ['continue', opt(sameLine, notReserved, field('label', Ident)), asi()],
  // TryStatement (14.15): a Catch, a Finally, or both, so `try {}` has no parse.
  ['try', field('body', Block), not(not(alt('catch', 'finally'))), opt('catch', opt('(', field('parameter', CatchParameter), ')'), field('handler', Block)), opt('finally', field('finalizer', Block))],
  arm('labelled', notReserved, field('label', Ident), ':', field('body', $)),
  arm('empty', ';'),
  ['debugger', asi()],
  // `with ( Expression ) Statement` (14.11): the object is an Expression, a comma list included.
  ['with', '(', field('object', Expr), many(field('objectComma', ','), field('objectRest', Expr)), ')', field('body', $)],
  // A `using` / `await using` declaration binding is a BindingIdentifier — NOT a pattern. The
  // `not(alt('[','{'))` routes a `[`/`{` start to the expression arm instead: `using [a] = b`
  // is `using[a] = b` (element-assignment on the identifier `using`) and stays valid, while
  // `using {a} = b` / `await using [a] = null` (no derivation — V8 + babel reject; tsc is
  // lenient on the `{` form) correctly fail. (Guards the first binding; see ForHead for for-of.)
  arm('using', opt(field('awaitKeyword', 'await')), field('usingKeyword', 'using'), not(alt('[', '{')), field('binding', Binding), many(field('bindingComma', ','), field('bindingRest', Binding)), asi()),
  Decl,
  // The JavaScript expression statement (`expressionStatement`): tsc's parseStatement also takes
  // `{` as a block and `function`, `class`, `@` and same-line `async function` as declarations
  // before it tries an expression. The TypeScript declaration words (`type`, `namespace`,
  // `declare`, `abstract`, …) are contextual: `type = 1;` is an expression statement.
  expressionStatement(Expr),
]);

// ── Type Parameters ──

const TypeParam = rule($ => {
  // TS parses any modifier soup before a type-param name (variance `in`/`out`,
  // `const`, even bogus `public`), then reports invalid ones post-parse. A param
  // can also be NAMED like a modifier — `<in>`, `<out = any>`, and even the
  // variance-modified `<in in>` / `<out out>` (first `in`/`out` is the modifier,
  // second is the name). Longest-match picks among:
  const tail = [opt('extends', Type), opt('=', Type)];
  const mod = alt('const', 'in', 'out', 'public', 'private', 'protected', 'readonly');
  // The type-param NAME is a binding identifier: `in` LEXES as an Ident, so a bare Ident
  // would wrongly accept it as the name — but `in` is a reserved word there (tsc
  // rejects `<in>`/`<in in>`/`<out in>` "'in' is a reserved word"). `bindingIdentifier` forbids
  // `in` while allowing `out` and the other contextual keywords; `in` stays a variance
  // modifier (`<in T>`/`<in out>`/`<in out T>` parse). Guards arm 1's name too.
  const name = bindingIdentifier;
  return [
    [many1(mod), ...name, ...tail],  // modifier soup + name: `<const in T>`, `<in T>`, `<in out T>`
    [mod, ...name, ...tail],         // single modifier + name: `<out out>`, `<in out>`
    [...name, ...tail],              // bare name: `<T>`, `<out>` (NOT `<in>`)
  ];
});

const TypeParams = rule($ => [
  ['<', sep(TypeParam, ','), '>'],
]);
// (see the arrow arms) an arrow whose `<` is followed by no name and no `const` has no type
// parameter list; the test stands right before the arm's optional list, the one it conditions
const notArrowTypeParams = not(['<', not(alt([notReserved, Ident], 'const'))]);

// ── Declarations ──

// The members of an object type: an interface body, a type literal, and the members after a
// mapped type's own. tsc parses all of them with one routine, parseTypeMember (reached through
// parseObjectTypeMembers and parseMappedType), so they are one rule.
// The modifiers of a type member (tsc's parseTypeMember: parseModifiers without decorators,
// after the call / construct signatures and before an accessor, index signature, property or
// method). `const` and `default` are modifiers only before `enum` / a declaration keyword
// (`const enum: T`, `default class: T`; see `modifierWord`), elsewhere names.
const typeMemberMods = modifierRun(['public', 'private', 'protected', 'static', 'abstract', 'readonly', 'override', 'accessor', 'declare', 'export', 'in', 'out', 'async', 'const', 'default'], { treeSitterOmits: ['const'] });
// tsc's isTypeMemberStart, which its member list tests before each member. A leading `(`, `<`,
// `get` or `set` starts a member, and so does a `[` past the words that can be a modifier (tsc's
// isModifierKind; line breaks included). Otherwise, past those words and a property name, the
// next token must be `(`, `<`, `?`, `:`, `,` or a statement end, so a member made of those words
// fails it when a name follows on their line (`public⏎get g(): T`), and a member whose name is
// followed on its line by `=` fails it (`a = 1`, `static a = 1`, `public get = 1`, `readonly = 1`),
// though `a?: T = 1`, `[e] = 1`, `get = 1` and `a⏎= 1` start one and take an initializer.
const modifierKindWord = alt('abstract', 'accessor', 'async', 'const', 'declare', 'default', 'export', 'in', 'out', 'override', 'private', 'protected', 'public', 'readonly', 'static');
const literalPropertyName = alt(Ident, PrivateField, String_, Number_, HexNumber, OctalNumber, BinaryNumber, BigInt_);
const notTypeMemberStart = [
  not(alt('get', 'set')),
  many(modifierKindWord), not(modifierKindWord), not('['), opt(literalPropertyName),
  sameLine, not(alt('(', '<', '?', ':', ',', ';', '}')),
];
const TypeMember = rule($ => {
  const sig = [opt(TypeParams), '(', sep(typeFnParam(), ','), ')', opt(":", ReturnType)];  // `<T>( … ): Ret`
  // Every member but a block-bodied accessor ends as tsc's parseTypeMemberSemicolon: a `,`, or
  // as a statement does. So two members on one line need a separator between them.
  return [
    // call / construct signature (construct = call sig with a leading `new`)
    [opt('new'), ...sig, typeMemberEnd()],
    // getter / setter (tsc's parseAccessorDeclaration): type parameters parse, and the body is
    // a block, after which nothing is needed, or none, and then the member ends as the others
    // do (parseFunctionBlockOrSemicolon). No modifier before it: tsc's isTypeMemberStart reads
    // `get` after a modifier as the member's name, so `readonly get x(): T` is not a member start.
    [accessorMod, MemberName, ...sig, alt(resetCtx(Block), [not('{'), typeMemberEnd()])],
    // named / computed member (MemberName includes `[Expr]`) — branch method | property
    // (bare = implicit any). `get` / `set` before a member name is the accessor keyword (tsc
    // commits to the accessor), so it is not a name there: `get⏎x: T` rejects. A bracket that
    // starts an index signature is no name (`propertyOrMethodName`); any other is a computed
    // name (`[p]`, and `[K in T]`: a member is never a mapped type).
    // A property signature may have an initializer (tsc's parsePropertyOrMethodSignature reads
    // one at a `=`; that an object type's property cannot have one is a checker error).
    [not(notTypeMemberStart), typeMemberMods.run, not(accessorMod), ...propertyOrMethodName, opt('?'), alt(sig, [opt(':', Type), opt('=', Expr)]), typeMemberEnd()],
    // index signature: modifiers, then the one form a class member shares (`indexSignature`).
    [typeMemberMods.run, ...indexSignature],
  ];
});

// A computed name holds an Expression, a comma list included (tsc's parseComputedPropertyName;
// `{ [a, b]: 1 }` is a checker error). Where an index signature may stand, a bracket that starts
// one is no name (`propertyOrMethodName`).
const MemberName = rule($ => [
  Ident,
  PrivateField,
  String_,
  Number_,
  HexNumber,
  OctalNumber,
  BinaryNumber,
  BigInt_,
  arm('computed', field('bracket', '['), field('expr', Expr), many(field('comma', ','), field('exprRest', Expr)), field('bracketClose', ']')),
]);

// An index signature is one form wherever a member may be one: parseTypeMember and
// parseClassElement both test tsc's isIndexSignature after the member's modifiers, and both
// parse it with parseIndexSignatureDeclaration. The test reads past the `[`: a `...` or `]`; a
// modifier word and then an identifier; or an identifier (or a modifier word) and then `:`, `,`
// or a `?` that `:`, `,` or `]` follows. Such a bracket holds a parameter list (`[]`, `[a?]`,
// `[public a]`, `[a: T, b: U]`; what an index signature may not hold is reported after parsing)
// and is nothing else, so a member name is read only where the test fails
// (`propertyOrMethodName`): `[e]`, `[a = 1]` and `[async (x) => x]` are computed names, and
// `[async x => x]` and `[{ a }: T]` are no member at all.
const indexSignatureStart = ['[', alt(
  '...', ']',
  [modifierKindWord, ...bindingIdentifier],
  [alt(modifierKindWord, bindingIdentifier), alt(':', ',', ['?', alt(':', ',', ']')])],
)];
const indexSignature = [not(not(indexSignatureStart)), '[', sep(typeFnParam(), ','), ']', opt(':', Type), typeMemberEnd()];
const propertyOrMethodName = [not(indexSignatureStart), field('key', MemberName)];

// Branched: parse the modifier list ONCE, then branch on the member kind, so a
// member's shared `modifiers …` prefix isn't re-parsed per alternative. Inner
// alt() is first-match, so branches are ordered specific-before-general
// (generator/accessor/index-sig before the MemberName method/field split).
// Whether a modifier KEYWORD is a modifier or the member NAME is `modifierWord`'s
// decision (above), for EVERY word of a run, `static` included. 'declare' is a real
// class modifier; 'export'/'in'/'out' are parse-tolerated by tsc (semantic errors).
// `async` is NOT a generic class-member modifier here: it leads the async/async-generator
// method arms below (which give the body its [Await] context), so the modifier soup must
// not swallow it into a plain method (the class analog of the Decl modifier-prefix fix).
const classMods = modifierRun(['public', 'private', 'protected', 'static', 'abstract', 'readonly', 'override', 'accessor', 'declare', 'export', 'in', 'out', 'const', 'default'], { sameLineConst: true });
const Modifier = classMods.any;
const modRun = classMods.run;
const asyncMod = modifierWord(['async']);
const accessorMod = modifierWord(['get', 'set']);
// The words after `async`: every modifier word, `async` itself among them (tsc's parseModifiers
// takes `async` as often as it can follow: `async async x() {}`, `static async async x() {}`).
// (tree-sitter keeps its plain run of words: `async` there would be one more modifier-vs-name
// decision against the method name `async` in its GLR table.)
const asyncWords = tsRelax(many(field('wordAfterAsync', alt(Modifier, asyncMod))), many(Modifier));
// The single `static` slot spans the whole member, and the words go on after `async`
// (`static async x`, `async static x`). `modRun` gives the leading run its shape; the words
// after `async` are a plain repetition, because a second run shape there multiplies the
// modifier-vs-name decision points past what the TextMate generator can enumerate (it runs
// out of memory), and no arm can see what an earlier one matched. So the cases the shapes
// leave open are excluded up front: a second `static` that a member start follows on its own
// line (past a line break it is a field name, which parses). Owed: `async` as a word of the
// run itself, which states this by shape alone.
const staticTwice = [many(alt(classMods.rest, asyncMod)), classMods.stat, many(alt(classMods.rest, asyncMod)), 'static', sameLine, memberAhead];
// field (all-optional → catch-all). A field ends as a statement does (tsc's
// parseSemicolonAfterPropertyName), so a SAME-LINE decorator after it rejects: tsc reads that
// '@' as belonging to THIS property ("Decorators must precede the name and all keywords") —
// `x @dec y()` and `x = 1 @dec y()` reject, `x; @dec` and newline accept. The `!` sits on the
// name's line (tsc takes it only without a line break).
const fieldTail = [opt(sameLine, field('exclamation', '!')), opt(field('question', '?')), opt(':', field('type', Type)), opt('=', resetCtx(field('value', Expr))), asi()];
// Class member ( params ): T body, params+body routed to a [Await]/[Yield] family:
// plain methods reset (a method body has its OWN, non-inherited context — the spec's
// implicit function boundary), generators yield, async await, async-generators both.
// MemberName, type params, and the return type stay OUTSIDE the family (a computed key
// `[e]` is evaluated in the ENCLOSING context, and type positions are not parameterized).
// The body is a function declaration's (tsc's parseFunctionBlockOrSemicolon): a block, after
// which nothing is needed (a `;` there is an empty class element of its own), or none, and
// then the member ends as a statement does.
const memTail = (ctx) => ['(', sep(ctx(field('parameter', Param)), ','), ')', opt(":", ReturnType), ctx(field('body', fnBodyOrAsi()))];
const ClassMember = rule($ => [
  arm('empty', ';'),   // tsc's SemicolonClassElement: `class C { ; }` is parse-clean
  arm('staticBlock', many(field('decorator', DecoratorExpr)), many(field('modifier', Modifier)), field('staticKeyword', 'static'), awaitCtx(field('block', Block))),   // static block body is [+Await] (await reserved); decorators/modifiers parse (SEMANTIC errors)
  // decorators PREFIX a member, before any modifier — tsc parse-rejects
  // `public @dec method()` ("Decorators are not valid here") and an orphan
  // `@dec` with no member, which a standalone sibling alternative tolerated.
  // Owed: the second decorator run after `export` / `default` (tsc's parseModifiers: `@d export
  // @e x() {}`, `public export @d x() {}`, valid). With it (and tsc's isClassMemberStart, which
  // takes no same-line `@` after modifier words none of which is a class-member modifier, unless
  // the member starts with a decorator) the TextMate generator runs out of memory (2 GB heap,
  // `npm run gen`), as with a second run shape after `async` (`staticTwice` below).
  arm('member',
    many(field('decorator', DecoratorExpr)),
    not(staticTwice),
    modRun,
    field('form', alt(
      // `async` is order-free among modifiers (tsc parses any order; the checker
      // validates), so it carries its own inner modifier run and an async member's
      // body is [+Await]/[+Await,+Yield].
      arm('asyncGeneratorMethod', field('asyncWord', asyncMod), asyncWords, field('asterisk', '*'), field('key', MemberName), opt(field('question', '?')), opt(field('typeParameters', TypeParams)), ...memTail(asyncGenCtx)),   // async generator method
      arm('asyncAccessor', field('asyncWord', asyncMod), asyncWords, field('kind', accessorMod), field('key', MemberName), opt(field('typeParameters', TypeParams)), '(', opt(sep(awaitCtx(field('parameter', Param)), ',')), ')', opt(":", ReturnType), awaitCtx(field('body', fnBodyOrAsi()))),  // async accessor (semantic error; parses)
      arm('asyncStaticBlock', field('asyncWord', asyncMod), asyncWords, field('staticKeyword', 'static'), awaitCtx(field('block', Block))),                              // `async static { }` (semantic error; parses)
      arm('asyncMethod', field('asyncWord', asyncMod), asyncWords, not(accessorMod), ...propertyOrMethodName, opt(field('question', '?')), opt(field('typeParameters', TypeParams)), ...memTail(awaitCtx)),   // async method
      arm('generatorMethod', field('asterisk', '*'), field('key', MemberName), opt(field('question', '?')), opt(field('typeParameters', TypeParams)), ...memTail(yieldCtx)),                // generator method
      arm('accessor', field('kind', accessorMod), field('key', MemberName), opt(field('typeParameters', TypeParams)), '(', opt(sep(resetCtx(field('parameter', Param)), ',')), ')', opt(":", ReturnType), resetCtx(field('body', fnBodyOrAsi()))),  // accessor (type params parse; semantic error)
      // index signature, after any modifiers (`async` among them, as in tsc): the type member's
      // one form (`indexSignature`), so a bracket that starts one is no method or field name.
      arm('indexSignature', opt(field('asyncWord', asyncMod), asyncWords), ...indexSignature),
      // a bare identifier `constructor` member MUST be a call signature — tsc rejects a
      // `constructor` field/property ("'(' expected"): `constructor;`, `constructor = 1`,
      // `constructor: T`, even modified (`public constructor;`). TypeParams parse; `?`/`!`
      // do not. A string / #private / computed name `constructor` is NOT the identifier,
      // so it stays a valid field (the `not('constructor')` generic arm below covers it).
      // Every constructor is this branch: bare (`constructor() {}`), decorated, modified or an
      // overload without a body.
      arm('constructor', field('constructorKeyword', 'constructor'), opt(field('typeParameters', TypeParams)), ...memTail(resetCtx)),
      // `get` / `set` before an accessor name IS the accessor keyword (tsc commits to the
      // accessor), so it is not available as a field name there: `get⏎x = 1` rejects.
      arm('named', not('constructor'), not(accessorMod), ...propertyOrMethodName, field('tail', alt(
        arm('method', opt(field('question', '?')), opt(field('typeParameters', TypeParams)), ...memTail(resetCtx)),                       // method (requires `(`)
        arm('field', ...fieldTail),
      ))),
      // `async` is a modifier like any other to tsc, so it may also precede a field
      // (`async x;` parses; the checker rejects it).
      arm('asyncField', field('asyncWord', asyncMod), asyncWords, not('constructor'), not(accessorMod), ...propertyOrMethodName, ...fieldTail),
    )),
  ),
]);

const EnumMember = rule($ => [
  [MemberName, opt('=', Expr)],
]);

// Per-specifier `type` modifier (`import { type A }`, `export { type A as B }`), as tsc's
// parseImportOrExportSpecifier decides it from the tokens after `type` (a ModuleExportName is an
// IdentifierName or a string; no line break matters): `type` is the modifier before a name that
// is not `as` (`{ type A }`, `{ type⏎A }`), before `as as` and a name (`{ type as as x }`: the
// type-only `as`, renamed), and before an `as` no name follows (`{ type as }`: the type-only
// `as`). Otherwise it is the specifier's name: `{ type }`, `{ type, x }`, `{ type as x }`,
// `{ type as as }` (`type` renamed to `as`).
const moduleExportName = alt(Ident, String_);
const typeMod = () => opt(field('typeKeyword', 'type'), not(not(alt([not('as'), moduleExportName], ['as', 'as', moduleExportName], ['as', not(moduleExportName)]))));
const ImportSpecifier = rule($ => [
  // A module-side name `as` a local name, or a local name alone. The local name is a binding
  // identifier; the name read from the module, before `as`, is an IdentifierName (tsc's
  // parseImportOrExportSpecifier): `{ if as x }`, not `{ if }` / `{ x as if }`.
  arm('renamed', typeMod(), field('imported', Ident), 'as', notReserved, field('local', Ident)),
  arm('plain', typeMod(), notReserved, field('local', Ident)),
  // arbitrary module namespace identifier (ES2022): `import { "str" as x }`. The
  // string form REQUIRES the rename (`{ "a" }` / `{ "a" as "b" }` are tsc parse
  // errors on the import side — the local binding must be an identifier).
  arm('stringRenamed', typeMod(), field('imported', String_), 'as', notReserved, field('local', Ident)),
]);

// Export specifiers are WIDER than import ones: a ModuleExportName (identifier or
// string) is valid on BOTH sides and may stand alone (`export { x as "s" }`,
// `export { "a" as "b" } from "m"`, `export { "a" }` — all tsc parse-clean).
const ExportSpecifier = rule($ => [
  // `type` modifier disambiguation (tsc's multi-token lookahead). `type` is the modifier
  // when followed by a real name that ISN'T `as` (arm 1), or by `as` that is itself the
  // name — `{ type as }`, no rename target after (arm 2). Otherwise `type` is the name:
  // `{ type }`, `{ type as B }` (renamed), `{ type, x }` all take arm 3.
  arm('typed', field('typeKeyword', 'type'), not('as'), field('local', alt(Ident, String_)), opt('as', field('exported', alt(Ident, String_)))),
  // name is `as`: `{ type as }` (no rename) or `{ type as as Y }` (DOUBLE as = rename).
  // A single `{ type as Y }` is NOT this arm — the not(Ident/String) / second-`as` guard
  // rejects it so it falls to arm 3 as name=`type` renamed to Y.
  arm('typedAs', field('typeKeyword', 'type'), field('local', 'as'), field('rename', alt(arm('none', not(alt(Ident, String_))), arm('renamed', 'as', field('exported', alt(Ident, String_)))))),
  arm('specifier', field('local', alt(Ident, String_)), opt('as', field('exported', alt(Ident, String_)))),
]);

// `{ a, b as c }` (NamedImports) and `* as ns` (NamespaceImport), alone or after a default binding.
const namedImports = () => [field('brace', '{'), sep(field('specifier', ImportSpecifier), ','), field('braceClose', '}')];
const namespaceImport = () => [field('star', '*'), 'as', notReserved, field('namespace', Ident)];
const ImportClause = rule($ => [
  // deferred import (TS 5.9): `import defer * as ns from "m"`. `defer` is a phase
  // modifier here, ONLY valid immediately before the namespace `* as`. As a keyword
  // literal it still lexes as an Ident, so `defer` stays an ordinary binding name in
  // every other position (`const defer = 1`, `import defer from "m"`, `defer()`).
  arm('deferNamespace', field('deferKeyword', 'defer'), ...namespaceImport()),
  // default import, optionally followed by named `{…}` or namespace `* as x`
  arm('defaultBinding', notReserved, field('name', Ident), opt(',', field('bindings', alt(arm('named', ...namedImports()), arm('namespace', ...namespaceImport()))))),
  arm('named', ...namedImports()),
  arm('namespace', ...namespaceImport()),
]);

// The right-hand side of an import-equals declaration (`import x = …`), tsc's
// parseModuleReference: an ExternalModuleReference `require ( specifier )`, or an
// EntityName — identifiers joined by `.`, every segment a non-reserved identifier
// (tsc parses it with allowReservedWords=false, so `a.default` / `a.if` are errors).
// It is NOT an expression: no call, index, template tag, `new`, literal, `this`, type
// arguments or operator continues it. The specifier is a bare string literal (tsc
// parses a literal alone there, so `require("x" + y)` / `require("x", "y")` are
// errors) or, when the first token is not a string, a full comma Expression
// (`require(x)`, `require(1, 2)` parse; their wrongness is the checker's).
const ModuleReference = rule($ => [
  arm('external', field('requireKeyword', 'require'), '(', field('argument', alt(arm('string', field('string', String_)), arm('expression', not(String_), field('expr', Expr), many(',', field('exprRest', Expr))))), field('parenClose', ')')),
  arm('entityName', notReserved, field('first', Ident), many('.', notReserved, field('rest', Ident))),
]);

// A class declaration from its `class` keyword on, named or NAMELESS: tsc parses `class { … }` at
// statement level cleanly ("a class declaration without 'default' must have a name" is a checker
// error). The two part at the token after `class` (a name, or `<` / a heritage clause / `{`),
// mirroring the class-expression pair. Decl writes them once bare and once after a declaration's
// prefix (below); gen-tm expands them to recover the `class Ident … { … }` shape for highlighting.
const classDecls = [
  arm('namedClass', 'class', ...bindingName, opt(field('typeParameters', TypeParams)), heritageClauses, '{', many(field('member', ClassMember)), '}'),
  arm('anonymousClass', 'class', opt(field('typeParameters', TypeParams)), heritageClauses, '{', many(field('member', ClassMember)), '}'),
];
// The modifier words of a declaration's prefix, each one a modifier only where `modifierWord`
// says so (`public @d class C {}`, `abstract @d class C {}` have no parse); the `declare`,
// `export` and `async` prefixes and `const enum` have arms of their own. After decorators the
// words are those of tsc's parseModifiers, `in` and `out` among them (`@d in class C {}`); a
// statement that starts with a word is read by tsc's isStartOfDeclaration walk, which takes
// neither. Owed (each needs the left context, since `$` reaches the same arm at a statement's
// start and past a prefix):
// - `override`, which the walk does not take either: `@d export override class C {}` is valid,
//   `export override class C {}` has no parse, and both reach this arm with `override class`.
// - `default` after decorators (`@d default class C {}`, valid): past `export` the export
//   default arm reads `@d default class C {}`, and the prefix arm would read it a second way
//   (`export @dec default class C {}` would change its tree).
// - one `static` across a nested `export` / `declare` arm (`static export static class C {}`).
// - two decorator runs at most (`@d export @e export @f class C {}` has three).
// - the `declare` arm's statement (tsc's expression statement `declare` without its `;`,
//   `declare x;`) at a statement's start only: past a prefix `declare` is a modifier
//   (`export declare x;`, `@d declare @e class C {}` have no parse).
const decoratedMods = modifierRun(['abstract', 'public', 'private', 'protected', 'readonly', 'static', 'override', 'accessor', 'in', 'out']);
const declMods = modifierRun(['abstract', 'public', 'private', 'protected', 'readonly', 'static', 'override', 'accessor']);
// How a declaration ends is tsc's: one that ends in a block (`{ … }` of a function, class,
// interface, enum, namespace or module) needs nothing after it; every other one ends as a
// statement does, at `asi()` (tsc's parseSemicolon). An arm that wraps another declaration or
// statement (`export …`, `declare …`, a modifier or decorator prefix) takes the wrapped one's end.
const Decl = rule($ => [
  // Function declarations live here (not in Stmt) so that at statement level a
  // leading `function` is preferred as a declaration over an IIFE expression-
  // statement: Program tries Decl before Stmt, so `function f(){}\n()=>{}` parses
  // as a declaration + arrow rather than longest-matching `function f(){}()` (IIFE).
  ...tsFnArms(bindingName, fnBodyOrAsi()),
  // The declaration NAME slots below are a `bindingIdentifier`: a reserved word is not a
  // legal declaration name (`interface void {}`, `class while {}`, `enum for {}`,
  // `namespace debugger {}` — all TS errors), while a contextual keyword name
  // (`interface any`, `class string`, `enum number`) stays valid.
  // tsc parses REPEATED `extends` clauses on an interface (`interface I extends A
  // extends B`) — the parser accepts them and the checker reports the duplicate;
  // mirror with many() rather than a single opt() clause.
  ['interface', ...bindingIdentifier, opt(TypeParams), heritageClauses, '{', many(TypeMember), '}'],   // shared heritage: repeated/order-free extends+implements, `extends Foo?.Bar`, empty `extends {`
  ['type', ...bindingIdentifier, opt(TypeParams), '=', Type, asi()],   // type-alias name can't be a reserved word (`type void = …`); contextual type keywords (`string`/`any`/…) stay valid
  ...classDecls,   // a class with no decorator or modifier; with them, the prefix arm below
  ['enum', ...bindingIdentifier, '{', sep(EnumMember, ','), '}'],
  ['declare', 'function', opt('*'), ...bindingIdentifier, opt(TypeParams), '(', sep(Param, ','), ')', opt(":", ReturnType), asi()],
  // ambient module shorthand `declare module "foo";` (no body — the module arm below
  // requires `{…}`) and `declare global { … }` (global-scope augmentation; `global`
  // is a contextual-keyword block, not a namespace name). tsc accepts both.
  ['declare', 'module', String_, asi()],
  ['declare', 'global', '{', many(Stmt), '}'],
  arm('declared', field('declareKeyword', 'declare'), field('declaration', alt(arm('decl', field('decl', $)), arm('statement', field('stmt', Stmt))))),
  // A declaration's prefix: decorators, then modifier words, parsed ONCE; the declaration it
  // prefixes is chosen after it (tsc's parseDeclaration: decorators, modifiers, then the keyword).
  // A second decorator run follows `export` (the export arms read it, `@dec export @e class C
  // {}`). A run holds one `static` at most (tsc's hasSeenStaticModifier), and a second one is no
  // declaration keyword, so `$` starts with none (`static static class C {}` has no parse).
  // A class takes the prefix as its own (`@dec abstract class C {}` is one declaration); any other
  // declaration is `$` (`@dec export class C {}`, `@dec interface I {}`). tsc parses the soup before
  // any declaration and before var/let/const and `using` statements, which `$` alone can't reach
  // (`accessor var x`, `public using y`, `@dec var x`); which combinations are valid is the
  // checker's line ("decorators are not valid here", `async class`). Not before an arbitrary
  // statement (`public someExpr;`, `@dec if (…)` are tsc parse errors). `using` requires a real
  // binding here, and so does a var/let/const one: a VariableDeclarationList / BindingList has
  // one or more declarations and no trailing comma (tsc's parser takes `var;` and `var a,` and its
  // checker reports them: docs/CORRECTNESS.md). The branches part at
  // the token after the prefix, so the first that matches is the only one.
  arm('prefixed', field('prefix', alt(arm('decorated', many1(field('decorator', DecoratorExpr)), decoratedMods.run), arm('modified', declMods.run1))), field('declaration', alt(
    ...classDecls,
    arm('other', not('static'), field('decl', $)),
    [alt('let', 'const', 'var'), Binding, many(',', Binding), asi()],
    [opt('await'), 'using', not(alt('[', '{')), Binding, many(',', Binding), asi()],
  ))),
  // A leading `async` before a declaration other than a function: tsc's parser accepts it (the
  // checker rejects `async class`). `async function` MUST take the async-function arm so its
  // params/body carry the [Await] context — otherwise this lenient prefix would catch the async
  // arm's await-context rejections (e.g. `async function f(a=await)`) and re-accept them as a
  // plain function with a stray `async` modifier.
  // Owed: a variable statement after `async` (`async var x;`, tsc's parser takes it as it does
  // after `export`); with the owed `override` above, `override async var x;` would parse.
  [modifierWord(['async']), not('function'), $],
  ['namespace', ...bindingIdentifier, many('.', Ident), '{', many(Stmt), '}'],   // dotted name: `namespace A.B.C { … }`
  ['module', alt([...bindingIdentifier, many('.', Ident)], String_), '{', many(Stmt), '}'],   // `module A.B.C { … }` | `module "x" { … }`
  arm('exportAsNamespace', field('exportKeyword', 'export'), 'as', 'namespace', ...bindingName, asi()),   // UMD NamespaceExportDeclaration — BEFORE `exportDeclaration`
  exportDeclaration($, Stmt, ['var', 'let', 'const', 'using', ['await', 'using']]),
  // decorators may also sit BETWEEN `export` and `default` (`export @dec default
  // class C {}` — tsc parses the soup in either spot; ordering is a checker error). There
  // `default` is a modifier word, so a declaration follows it (`export @d default x;` has no
  // parse), and the decorators are the second run, so no third one follows (`export @d default
  // @e class C {}` has no parse; `export default @e class C {}` is one run).
  arm('exportDefault', field('exportKeyword', 'export'), field('defaultWord', alt(arm('decorated', many1(field('decorator', DecoratorExpr)), field('defaultKeyword', modifierWord(['default'], { secondRun: true })), not(alt('@', Decorator))), arm('plain', field('defaultKeyword', 'default')))), field('declaration', alt(
    ...tsFnArms([opt(...bindingName)], fnBodyOrAsi()),  // function
    arm('namedClass', many(field('decorator', DecoratorExpr)), opt(field('abstractKeyword', 'abstract')), 'class', ...bindingName, opt(field('typeParameters', TypeParams)), heritageClauses, '{', many(field('member', ClassMember)), '}'),  // named class
    arm('anonymousClass', many(field('decorator', DecoratorExpr)), opt(field('abstractKeyword', 'abstract')), 'class', opt(field('typeParameters', TypeParams)), heritageClauses, '{', many(field('member', ClassMember)), '}'),          // anonymous class
    ['interface', ...bindingIdentifier, opt(TypeParams), heritageClauses, '{', many(TypeMember), '}'],   // export default interface (interface is not an Expr)
    // decorators after `default` prefix any declaration, as at a statement's start (tsc reads
    // `export default @d function f() {}` as one modifier list, then the keyword)
    arm('decorated', not(not(alt('@', Decorator))), field('decl', $)),
    arm('expression', field('expr', Expr), asi()),   // catch-all: export default <expr>
  ))),
  arm('exportAll', field('exportKeyword', 'export'), opt(field('typeKeyword', 'type')), field('star', '*'), opt('as', field('exported', alt(Ident, String_))), 'from', ...moduleSpecifier, asi()),   // export (type)? * (as ns)? from "m" — alias is a ModuleExportName
  arm('exportNamed', field('exportKeyword', 'export'), field('brace', '{'), sep(field('specifier', ExportSpecifier), ','), field('braceClose', '}'), opt('from', ...moduleSpecifier), asi()),
  arm('exportEquals', field('exportKeyword', 'export'), '=', field('expr', Expr), asi()),
  arm('exportNamedType', field('exportKeyword', 'export'), field('typeKeyword', 'type'), field('brace', '{'), sep(field('specifier', ExportSpecifier), ','), field('braceClose', '}'), opt('from', ...moduleSpecifier), asi()),
  ['const', 'enum', ...bindingIdentifier, '{', sep(EnumMember, ','), '}'],
  arm('importDeclaration', field('importKeyword', 'import'), field('form', alt(
    arm('clause', field('clause', ImportClause), 'from', ...moduleSpecifier),   // import X from "m"  (also `import type from "m"` = default named `type`)
    arm('typeClause', field('typeKeyword', 'type'), field('clause', ImportClause), 'from', ...moduleSpecifier),   // import type X from "m"
    arm('typeEquals', field('typeKeyword', 'type'), ...bindingName, '=', field('reference', ModuleReference)),    // import type X = require(…) / = ns.Foo (type-only import-equals)
    arm('equals', ...bindingName, '=', field('reference', ModuleReference)),            // import x = require(…) / = ns.Foo  (also `import type = …` where `type` is the binding name)
    arm('bare', ...moduleSpecifier),                          // import "m"
  )), asi()),
]);

// ── Entry ──

const Program = rule($ => [
  many(alt(Decl, Stmt)),   // Decl first: prefer declaration over IIFE expression-statement
]);

// ── Grammar ──

export default defineGrammar({
  name: 'typescript',
  scopeName: 'source.ts',
  // `>` closes type arguments (`f<A<B>>(x)`, `a as Map<K, V>>= b`), so `>>`, `>=` … are composed by
  // the parser from single `>` tokens (tsc's reScanGreaterToken).
  composeGt: true,

  tokens: {
    // Comments must come before Regex_ to avoid /** ... */ being matched as regex
    Shebang, JSDoc, TripleSlash, LineComment, BlockComment,
    Ident, HexNumber, OctalNumber, BinaryNumber, BigInt: BigInt_,
    Number: Number_, String: String_, Template, Regex: Regex_,
    Decorator, PrivateField,
  },

  // The ECMAScript operator-precedence ladder is shared, owned by javascript.ts.
  prec: ecmaPrec,
  // TS adds the type-rhs LEDs at the relational level (mirrors tsc: `as`/`satisfies`
  // participate in the binary-operator chain at relational precedence).
  ledPrec: [...jsLedPrecs, { connector: 'as', sameAs: '<' }, { connector: 'satisfies', sameAs: '<' }],

  // tree-sitter GLR conflicts: the fixpoint of `tree-sitter generate`'s own LR(1) analysis of this
  // grammar (`node test/collect-conflicts.ts`), minus the tuples it reports as unnecessary. ECMAScript
  // genuinely needs them: `(a, b)` is a parenthesised expression or arrow params until `=>`, `{` opens a
  // block, object literal or destructuring pattern, `<` is a comparison or type arguments, and nested
  // `new new Foo()` self-conflicts on NewTarget's leading `new`. The generator derives `[expr, type]`
  // structurally when a type rule exists; these are the rest.
  // The `type_fn_param` tuples (issue #46) are the residual `(` boundary where a param could still be
  // value-context after the type-only fn param decoupled types from `expr`.
  // The keywords the tree-sitter grammar also reads as names: the ones real code uses as names (measured
  // on the first ERROR of real files, TypeScript's lib .d.ts files and this repository: `out` 28 files,
  // `set` 10, `default` 6, `this` 5, `namespace` 3, `get`, `private`, `async`, `type` 1 each; `public`
  // beside `private`), each costing parse-table size (LALR entries: async 2.4k, get / set 2.0k, out 1.8k,
  // private / public 1.7k, default 1.6k, this 1.2k, type 1.0k, namespace 1.0k; `static` 3.1k and no file:
  // left out). Any other keyword is the keyword wherever it is valid, as without the option.
  treeSitterContextualNames: ['async', 'default', 'get', 'namespace', 'out', 'private', 'public', 'set', 'this', 'type'],
  treeSitterConflicts: [
    // `export { a }`: an export list, or `export` + an expression statement `{ a }` (the guard against
    // a statement that starts with `{` is a dropped lookahead); with the statement's end a token of
    // its own (the line-end token), both readings meet at `a` before `}`.
    ['prop', 'export_specifier'],
    ['expr'], ['stmt'], ['stmt', 'decl'], ['expr', 'decl'], ['program', 'stmt'], ['new_target'],
    ['type', 'type_param'], ['type_param'], ['expr', 'param'], ['expr', 'new_target'],
    ['expr', 'block'], ['expr', 'member_name'], ['expr', 'prop'], ['member_name', 'stmt'], ['decl'],
    ['binding'], ['type'], ['type', 'typeof_ref'], ['type', 'param'], ['type_member'],
    ['expr', 'binding_pattern'], ['expr', 'binding_element'], ['prop', 'binding_property'],
    ['member_name', 'binding_property'], ['expr', 'block', 'decl'], ['type', 'binding_pattern'],
    ['type', 'binding_element'], ['type_member', 'binding_property'], ['type_member', 'expr'],
    ['expr', 'array_binding_element'], ['expr', 'binding_property'], ['prop', 'member_name'],
    ['type_member', 'class_member'], ['type_member', 'member_name'], ['type', 'binding'],
    ['type', 'decl'], ['typeof_ref', 'expr'], ['type', 'expr', 'param'],
    ['type_member', 'prop'], ['type', 'array_binding_element'], ['type', 'type_member'],
    ['prop', 'member_name', 'binding_property'], ['type', 'class_member'], ['stmt', 'param'],
    ['type', 'expr', 'binding_pattern'],
    ['type', 'expr', 'binding_element'], ['type_member', 'prop', 'binding_property'],
    ['type_member', 'member_name', 'binding_property'],
    ['type', 'expr', 'array_binding_element'], ['type_member', 'prop', 'member_name'],
    ['type', 'expr', 'block'], ['type_member', 'expr', 'member_name'],
    ['type_member', 'expr', 'prop'], ['type_member', 'member_name', 'stmt'],
    ['type_member', 'prop', 'member_name', 'binding_property'],
    ['type', 'type_member', 'class_member'], ['type', 'class_heritage'], ['class_member'],
    ['expr', 'prop', 'export_specifier'], ['expr', 'export_specifier'], ['prop', 'decl'],
    ['expr', 'prop', 'member_name'], ['decorator_expr', 'new_target'], ['binding_element'],
    ['type_member', 'expr', 'prop', 'member_name'], ['type_fn_param', 'type'],
    ['type_fn_param', 'type', 'expr', 'param'], ['type_fn_param', 'expr', 'param'],
    ['type_fn_param', 'expr'], ['type_fn_param', 'param'],
    // A template-literal type and a template-literal expression are the same tokens up to their
    // first hole, wherever `<` or `(` leaves both a type and an expression possible.
    ['template', 'type_template'],
    // An import-equals `require(` specifier is a bare string or else an expression (tsc's
    // parseModuleSpecifier); the `not(String_)` that keeps the two apart has no tree-sitter
    // counterpart, so `require("m")` is both until the `)`.
    ['expr', 'module_reference'],
    // A heritage base (a NewTarget) after `extends f <`: the element's type arguments
    // (`extends f<T> {}`) or a typed tagged template (`extends f<T>`x` {}`); only the token after
    // `>` decides, and tsc accepts both. And, as in JavaScript, a member tail after the base
    // (`extends a.b {}`): NewTarget's own `.b`, or the heritage's `.b` on the base `a`.
    ['new_target', 'class_heritage'],
    // `{ readonly [` starts a mapped type, a type member with a `readonly` modifier, or (after a
    // `<` that may open type arguments or compare) an object literal's member, until `in` / `:`.
    ['type', 'type_member', 'prop'],
    // A modifier run opens a type-literal member (in a type argument / arrow return), an
    // object-literal member or a declaration in a block alike.
    ['type_member', 'prop', 'decl'], ['type_member', 'decl'],
    // After `implements {` a type-literal index signature's parameter list and a class index
    // signature's `[k: T,` are the same tokens.
    ['type_fn_param', 'class_member'],
  ],

  rules: {
    Type, TypeMember, DecoratorExpr, TypeofRef,
    Expr, Prop, MemberName, NewTarget, ClassHeritage,
    Stmt, Block,
    BindingProperty, BindingElement, ArrayBindingElement, BindingPattern,
    Binding, ForBinding, Param, CatchParameter, ForHead, ForAwaitHead, SwitchCase,
    TypeParams, TypeParam,
    Decl, ClassMember, EnumMember,
    ImportClause, ImportSpecifier, ExportSpecifier, ModuleReference,
    TypeStart,
    Program,
  },

  // TypeScript EXTENDS the JS scope map (jsScopes, owned by javascript.ts) with the
  // type layer. The shared entries are reused by reference; the TS-specific ones are
  // inlined: four type-declaration keywords (storage.type.interface/type/enum/
  // namespace), the type-operator keyword.operator.expression set (adds keyof/as/is/
  // satisfies/asserts/infer over JS's), the widened storage.modifier (TS accessibility
  // + readonly/abstract/override/declare) and keyword.other.extends (adds implements),
  // and support.type.primitive (TS's primitive type names). The keys are written in
  // jsScopes' original order — with the type-only keys interleaved at their TS
  // positions — so the emitted grammar is byte-identical to the prior inline map (a
  // bare `{ ...jsScopes, …TS-only }` spread would instead append the type-only keys at
  // the end and flip `module`'s primary scope, changing the generated output).
  scopes: {
    'keyword.control.conditional': jsScopes['keyword.control.conditional'],
    'keyword.control.switch': jsScopes['keyword.control.switch'],
    'keyword.control.loop': jsScopes['keyword.control.loop'],
    'keyword.control.flow': jsScopes['keyword.control.flow'],
    'keyword.control.trycatch': jsScopes['keyword.control.trycatch'],
    'keyword.control': jsScopes['keyword.control'],
    'keyword.control.import': jsScopes['keyword.control.import'],
    // `defer` is the TS 5.9 deferred-import phase modifier (`import defer * as ns`).
    // It carries a keyword.control.import subtype, but — unlike `import` itself — it
    // is NOT reserved (a valid identifier name everywhere else). gen-tm therefore
    // scopes it POSITIONALLY (only right before the namespace `*`, via the
    // import-export-all pattern), never in the flat keyword match. See gen-tm's
    // phase-modifier handling.
    'keyword.control.import.phase': ['defer'],
    'keyword.control.export': jsScopes['keyword.control.export'],
    'keyword.control.from': jsScopes['keyword.control.from'],
    'storage.type': jsScopes['storage.type'],
    'storage.type.const': jsScopes['storage.type.const'],
    'storage.type.function': jsScopes['storage.type.function'],
    'storage.type.class': jsScopes['storage.type.class'],
    'storage.type.interface': ['interface'],
    'storage.type.type': ['type'],
    'storage.type.enum': ['enum'],
    'storage.type.namespace': ['namespace', 'module'],
    'storage.modifier': [
      'public', 'private', 'protected',
      'static', 'readonly', 'abstract', 'override', 'declare', 'async', 'accessor',
    ],
    'storage.type.property': jsScopes['storage.type.property'],
    'keyword.other.extends': ['extends', 'implements'],
    'keyword.operator.expression': ['typeof', 'keyof', 'instanceof', 'as', 'new', 'delete', 'void', 'is', 'satisfies', 'asserts', 'infer'],
    'keyword.operator.assignment': jsScopes['keyword.operator.assignment'],
    'keyword.operator.comparison': jsScopes['keyword.operator.comparison'],
    'keyword.operator.relational': jsScopes['keyword.operator.relational'],
    'keyword.operator.logical': jsScopes['keyword.operator.logical'],
    'keyword.operator.arithmetic': jsScopes['keyword.operator.arithmetic'],
    'keyword.operator.increment-decrement': jsScopes['keyword.operator.increment-decrement'],
    'keyword.operator.logical.prefix': jsScopes['keyword.operator.logical.prefix'],
    'keyword.operator.bitwise': jsScopes['keyword.operator.bitwise'],
    'keyword.operator.bitwise.shift': jsScopes['keyword.operator.bitwise.shift'],
    'storage.type.function.arrow': jsScopes['storage.type.function.arrow'],
    'punctuation.bracket.round': jsScopes['punctuation.bracket.round'],
    'punctuation.bracket.curly': jsScopes['punctuation.bracket.curly'],
    'punctuation.bracket.square': jsScopes['punctuation.bracket.square'],
    'punctuation.accessor': jsScopes['punctuation.accessor'],
    'punctuation.accessor.optional': jsScopes['punctuation.accessor.optional'],
    'punctuation.terminator.statement': jsScopes['punctuation.terminator.statement'],
    'punctuation.separator.comma': jsScopes['punctuation.separator.comma'],
    'constant.language.boolean.true': jsScopes['constant.language.boolean.true'],
    'constant.language.boolean.false': jsScopes['constant.language.boolean.false'],
    'constant.language.null': jsScopes['constant.language.null'],
    'variable.language.this': jsScopes['variable.language.this'],
    'variable.language.super': jsScopes['variable.language.super'],
    'support.type.primitive': ['string', 'number', 'boolean', 'object', 'symbol', 'bigint', 'any', 'unknown', 'never', 'void'],
    'support.class': jsScopes['support.class'],
    'support.variable': jsScopes['support.variable'],
    'support.variable.property': jsScopes['support.variable.property'],
  },

  // Repository-key NAMING CONSTRAINT (官方命名「限制器」) — the part that makes Monogram's source.ts a
  // REPOSITORY-LEVEL drop-in for VS Code's official TypeScript grammar. External grammars (Vue,
  // Markdown, MDX, …) `#include` the official repository keys BY NAME (`source.ts#type`,
  // `source.ts#qstring-double`, `source.ts#comment`, …). Monogram derives those keys under its OWN
  // structural names (`#type-inner`, `#string-double`, `#linecomment`/`#blockcomment`, …), so the
  // official names wouldn't resolve and an `#include` would silently no-op. This CONSTRAINS gen-tm's
  // key emission: it maps each OFFICIAL name → the structural key(s) gen-tm derived for the SAME
  // construct, and gen-tm projects the repository through it at generation time, emitting the
  // canonical name NATIVELY (a STRING value RENAMES the structural key — its old name ceases to exist
  // — and rewrites every `#…` reference; an ARRAY value SYNTHESISES the `{patterns:[…]}` UNION the
  // official grammar itself writes, e.g. `#comment`/`#return-type`, resolving each member through the
  // 1:1 renames first). It is purely a naming projection — no `match`/`begin`/`name` changes — so the
  // emitted tokenization is byte-for-byte unchanged (verified: test/repo-compat.ts + the vue dual-host
  // proof). gen-tm only looks up + substitutes, staying language-agnostic.
  //
  // The SHARED ECMAScript half (`type`, `qstring-*`, `punctuation-comma`/`-semicolon`/`-accessor`,
  // `new-expr`, `regex`, `directives`, `parameter-name`, `comment`/`string`/`boolean-literal`/
  // `numeric-literal` unions, `this-literal`/`super-literal`) is OWNED by javascript.ts (which owns the
  // shared vocabulary) as `jsBaseCanonical`, imported and spread here; this file adds ONLY the TS-only
  // entries (the type layer: type-parameters, casts, type-object, param/return type annotations,
  // type-predicate). The structural source of an entry that doesn't exist in source.ts (none here —
  // all verified present) would simply be SKIPPED by gen-tm. Official names that ALREADY name a real
  // Monogram key are omitted: `expression`, `template`, and `namespace-declaration` (Monogram's
  // `namespace`-keyword key) already match by name. (Monogram's `module-declaration` — the legacy
  // `module X {}` form the official folds into `namespace-declaration` — stays Monogram-internal; a
  // structural split, not a naming gap.)
  canonicalRepoNames: {
    ...jsBaseCanonical,
    // TS-only — the type layer (no JS counterpart).
    'type-parameters': 'declaration-type-params',
    'type-alias-declaration': 'type-declaration',
    'type-object': 'type-object-type',
    cast: 'type-cast',
    'parameter-type-annotation': 'param-type-annotation',
    'type-predicate-operator': 'is-typekw',
    // Union (official wrapper key): members resolved through the renames above.
    'return-type': ['type-annotation-return', 'decl-return-type'],
  },

  entry: Program,
  // The expression rule — lets gen-tm derive a `#expression` sub-grammar (used by
  // expression-only embeds like Vue's `{{ }}`, where statements are invalid).
  expression: Expr,
});
