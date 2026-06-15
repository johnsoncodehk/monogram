import {
  rule, defineGrammar,
  op, prefix, postfix, sameLine,
  sep, opt, many, many1, alt, exclude, not, tsRelax, capExpr, notLeftLeaf,
  awaitCtx, yieldCtx, asyncGenCtx, resetCtx,
} from './src/api.ts';

// Build the four async×generator arms of a TypeScript `function` form, routing each
// arm's params and body to its [Await]/[Yield] family (plain resets, generator ->
// yield, async -> await, async-generator -> both). Type params and the return-type
// annotation are NOT [Await]/[Yield]-parameterized, so they stay plain. `nameParts`
// is spread in after `function` (and `*`); `body` is the function body element.
// Param/Block/Type/TypeParams resolve at thunk-eval time (defined below).
function tsFnArms(nameParts, body) {
  return [
    ['function', ...nameParts, opt(TypeParams), '(', sep(Param, ','), ')', opt(":", ReturnType), resetCtx(body)],
    ['function', '*', ...nameParts, opt(TypeParams), '(', sep(yieldCtx(Param), ','), ')', opt(":", ReturnType), yieldCtx(body)],
    ['async', 'function', ...nameParts, opt(TypeParams), '(', sep(awaitCtx(Param), ','), ')', opt(":", ReturnType), awaitCtx(body)],
    ['async', 'function', '*', ...nameParts, opt(TypeParams), '(', sep(asyncGenCtx(Param), ','), ')', opt(":", ReturnType), asyncGenCtx(body)],
  ];
}

// Statement ASI terminator: a `;`, OR a line-terminator before the next token (newline
// ASI), OR the next token is `}` (block end). A same-line non-`;`/`}` token can NOT end
// the statement, so a mid-line split (`var x = a[]`) stays one statement (tsc-shaped).
const asi = () => alt([';'], [not(sameLine)], [not(not('}'))]);
// JavaScript is the SUBSET / base of the ECMAScript family; TypeScript is the
// SUPERSET (JS + a type layer). The shared, type-free vocabulary — token consts,
// the `notReserved`/`notReservedExpr` reserved-word guards, the precedence ladder
// (`ecmaPrec`), and the JS scope map (`jsScopes`) — is OWNED by javascript.ts and
// imported here, then extended below with the type layer. Rules are NOT shared
// either direction (combinator rules bind their references at definition time), so
// this file keeps its own rule consts.
import {
  Shebang, JSDoc, TripleSlash, LineComment, BlockComment,
  Ident, HexNumber, OctalNumber, BinaryNumber, BigInt_,
  Number_, String_, Template, Regex_, Decorator, PrivateField,
  notReserved, notReservedExpr, ecmaPrec, jsLedPrecs, jsScopes, jsBaseCanonical,
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

// A decorator is `@ DecoratorMemberExpression`/`DecoratorCallExpression` (the `@name`
// head already lexed by the Decorator token, dotted segments included). After the head,
// these tail forms may follow and chain (`@x!.y`, `@x.y!`, `@x!()`): a call `(args)` /
// typed call `<T>(args)`, a non-null `!`, and a member `.m`. ELEMENT access `[i]` is
// deliberately EXCLUDED — TS's decorator grammar omits it precisely so a computed class
// member after a decorator (`@dec ["m"]() {}`, `@dec [field] = 1`) is not swallowed as
// `@dec[...]` (tsc rejects a real `@arr[0]` decorator). `many` so a whole chain is allowed.
const DecoratorExpr = rule($ => [
  [Decorator, many(alt(
    ['(', sep(Expr, ','), ')'],                          // call: (args)
    ['<', sep(Type, ','), '>', '(', sep(Expr, ','), ')'], // typed call: <T>(args)
    '!',                                                  // non-null assertion
    ['.', alt(Ident, PrivateField)],                      // member access
    // optional chain: ?.y | ?.#y | ?.(args) | ?.[i] — unlike plain element access,
    // `?.[` is unambiguous (a computed class member never starts with `?.`), so tsc
    // parses it in decorator position and we mirror.
    ['?.', alt(Ident, PrivateField, ['(', sep(Expr, ','), ')'], ['[', Expr, ']'])],   // `?.#y` is valid current ES (see Expr `?.` below)
    Template,                                             // tagged template: @x`…`
  ))],
  // `@new x` — the decorator expression is a NewExpression. The lexer maximal-munches
  // `@new` into ONE Decorator token (it cannot know `new` is reserved), so the arm is
  // keyed on that fused token as a keyword-class literal (matched by exact text).
  ['@new', NewTarget, opt('(', sep(Expr, ','), ')')],
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

const TypeMember = rule($ => {
  const callSig = [opt(TypeParams), '(', sep(typeFnParam(), ','), ')', opt(":", ReturnType)];  // `<T>( … ): Ret`
  const propOrMethod = alt(callSig, [opt(':', Type)]);  // after a name: method (callSig) | property
  return [
    // call / construct signature (no member name): a construct sig is just a
    // call sig with an optional leading `new`.
    [opt('new'), ...callSig],
    // index signature | mapped type | computed member — share `(+/-)? readonly? [`,
    // then (for index/mapped) share the leading `Ident` and branch on `in` vs `:`.
    [opt(alt('+', '-')), opt('readonly'), '[', alt(
      [Ident, alt(
        ['in', Type, opt('as', Type), ']', opt(alt('+', '-')), opt('?'), ':', Type],  // mapped: K in T (as U)?
        [':', Type, opt(','), ']', opt(':', Type)],                                    // index:  k: T  (trailing comma tolerated)
      )],
      [Expr, ']', opt('?'), propOrMethod],                                            // computed: expr
      [']', opt(':', Type)],                                                          // empty index sig: []  /  []: T
    )],
    // readonly property (the readonly index signature is the bracketed branch above)
    ['readonly', Ident, opt('?'), ':', Type],
    // named member — share the name + `?`, then branch property | method
    [alt(Ident, Number_, String_, PrivateField), opt('?'), propOrMethod],
  ];
});

const Type = rule($ => {
  const fnType = [opt(TypeParams), '(', sep(typeFnParam(), ','), ')', '=>', ReturnType];  // (a: T) => R  /  <T>(…) => R (the return may be a type predicate)
  return [
    // A bare type reference / entity name. The type-predicate `x is T` is NOT here for the
    // PARSER: tsc's parser accepts `x is T` ONLY in a function RETURN-TYPE position (see
    // ReturnType below), so a predicate in any other type slot (var/param/property
    // annotation, cast, type argument, union member, …) is a parse error. (`asserts x` is
    // different — tsc's parser accepts it in EVERY position, so it stays in this general
    // Type, below.) tsRelax: tree-sitter KEEPS the predicate in the general type (its
    // status-quo shape, GLR-cheap), since a highlighter may over-accept a stray predicate
    // — adding the return-only ReturnType to ~18 slots for tree-sitter inflates its table.
    tsRelax(Ident, [Ident, opt('is', Type)]),
    [$, sameLine, '<', sep($, ','), '>'],   // type-arg application T<A> — `<` must be on the same line (no ASI), like the postfix `[`/`!` arms below
    [$, sameLine, '[', ']'],   // array type T[] — `[` must be on the same line (no ASI)
    [$, '|', $],
    [$, '&', $],
    ['|', $],   // leading pipe: type T = | A | B
    ['&', $],   // leading amp:  type T = & A & B
    ['keyof', $],
    ['typeof', TypeofRef],
    ['readonly', $],
    ['(', $, ')'],
    fnType,                          // function type
    [opt('abstract'), 'new', ...fnType],  // constructor type (= `new` + function type)
    // tuple element: `...`? (name `?`? `:`)? `...`? Type `?`?  — the second `...`
    // covers a named rest member `n: ...T[]` (TS: RestType after the label); the
    // trailing `?` covers optional members `n: T?` / `T?` (TS: OptionalType).
    // Elements are comma-SEPARATED: a `,` is required between elements (`[A B]` and
    // even `[A\n B]` are tsc's "',' expected" — unlike object types, a newline does NOT
    // separate tuple members), while the LAST element needs none (`]`-ahead). Trailing
    // comma is covered by the `,` arm before the closing-`]` iteration fails to start.
    ['[', many(opt('...'), opt(Ident, opt('?'), ':'), opt('...'), $, opt('?'), alt([','], [not(not(']'))])), ']'],
    // object type literal: members are SEPARATED by `;` / `,` / a newline (the type
    // analog of statement ASI) — two members on one line with no separator reject
    // (`{ a: T b: U }` is tsc's "';' expected"). The `}`-ahead arm lets the last member
    // need no trailing separator; `;`/`,` also cover an explicit trailing delimiter.
    ['{', many(TypeMember, alt([';'], [','], [not(sameLine)], [not(not('}'))])), '}'],
    ['asserts', Ident, opt('is', $)],
    [$, 'extends', $, '?', $, ':', $],
    // infer U | infer U extends T | infer U extends T ? X : Y (conditional binds to the infer)
    ['infer', Ident, opt('extends', $, opt('?', $, ':', $))],
    String_,
    Number_,
    HexNumber, OctalNumber, BinaryNumber, BigInt_,
    ['-', alt(Number_, BigInt_)],
    'true', 'false', 'null', 'undefined', 'void', 'this',
    ['unique', $],   // `unique` is a general prefix type operator (tsc parses `unique <Type>`); `unique symbol` is the checker-valid case
    ['import', '(', $, ')'],
    Template,
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
    ['function', '(', sep(Param, ','), ')', opt(':', $)],   // function(this: T, string): U
    // postfix nullable `T?`: tsc takes the `?` only when the NEXT token cannot start
    // a type — otherwise the `?` belongs to a conditional type / an expression-level
    // ternary after `as T`. tsc tests token-level isStartOfType; `not(alt('new', $))`
    // mirrors it as a lookahead ('new' alone, a type START that a full type parse may
    // still fail on, e.g. `x as T ? new X : y`). No line break before postfix (tsc).
    [$, sameLine, '?', not(alt('new', $))],
    [$, sameLine, '!'],   // postfix non-nullable: T!
  ];
}, { type: true });

// ── Expressions ──

const Prop = rule($ => {
  // ( … ): T { … }, params+body routed to a [Await]/[Yield] family (see memTail); the
  // MemberName and return type stay outside it (a computed key inherits the enclosing
  // context, type positions are not parameterized).
  const propTail = (ctx) => ['(', sep(ctx(Param), ','), ')', opt(":", ReturnType), ctx(Block)];
  // tsc parses a full modifier soup before ANY object-literal member and a `?` then
  // `!` after its name (`{ static m() {} }`, `{ export p: 1 }`, `{ a! }`, `{ a?() {} }`
  // are all parse-clean — rejecting them is the checker's job). `const`/`default` are
  // NOT parsed as modifiers there (tsc parse errors), so they stay out of the soup.
  // The soup arms are many1 + a plain fallback arm, so a member NAMED like a modifier
  // (`{ static: 1 }`, `{ async }`) falls through to the plain shapes.
  // `async` is pulled out of the soup into the dedicated async method arms below (so the
  // body gets its [Await] context); `static`/`get`/… stay lenient modifiers.
  const propMod = alt('public', 'private', 'protected', 'static', 'abstract', 'readonly', 'override', 'accessor', 'export', 'declare', 'in', 'out');
  return [
    ['...', Expr],                                                     // spread
    // accessor (get/set), with any modifier soup (lenient, tsc-shaped) — body resets
    [many(propMod), alt('get', 'set'), MemberName, '(', opt(sep(resetCtx(Param), ',')), ')', opt(":", ReturnType), opt(resetCtx(Block))],  // body optional: `{ get foo() }` is a tsc-clean (error-recovery) parse
    // method: modifiers?/generator?, any member name (incl `#x`, computed `[e]`), then ( … ) { … }
    [many1(propMod), opt('*'), MemberName, opt('?'), opt('!'), opt(TypeParams), ...propTail(resetCtx)],
    // async/generator method, 4-way split (each routes params+body to its family).
    // async carries its own modifier run (order-free, like the class member arms).
    ['async', many(propMod), '*', MemberName, opt('?'), opt('!'), opt(TypeParams), ...propTail(asyncGenCtx)],
    ['async', many(propMod), alt('get', 'set'), MemberName, '(', opt(sep(awaitCtx(Param), ',')), ')', opt(":", ReturnType), opt(awaitCtx(Block))],  // async accessor (semantic error; parses)
    ['async', many(propMod), MemberName, opt('?'), opt('!'), opt(TypeParams), ...propTail(awaitCtx)],
    ['*', MemberName, opt('?'), opt('!'), opt(TypeParams), ...propTail(yieldCtx)],
    [MemberName, opt('?'), opt('!'), opt(TypeParams), ...propTail(resetCtx)],
    // value property — any member name incl computed `[e]: v` (MemberName covers `[Expr]`)
    [many1(propMod), MemberName, opt('?'), opt('!'), ':', Expr],
    [MemberName, opt('?'), opt('!'), ':', Expr],
    ['[', Expr, many(',', Expr), ']', ':', Expr],                      // computed comma list (lenient)
    // shorthand (Ident only): x | x = v | x? | x! | x?! — a reserved word here is
    // invalid (`var v = { class }`); a reserved word as a property KEY (`{ class: 1 }`)
    // is fine, already handled by the value-property branch above. tsc parses `?` then
    // `!` (that order) after the name; `{ a!? }` is a tsc parse error and stays one.
    [notReserved, Ident, opt('?'), opt('!'), opt('=', Expr)],
  ];
});

// A function/method/accessor/arrow/fn-type RETURN type. Beyond an ordinary Type it may be
// a TYPE PREDICATE `x is T` / `this is T` — a narrowing guard tsc's parser accepts ONLY in
// return position. The SUBJECT is a bare identifier or `this` (a number/string/qualified/
// parenthesized subject rejects); `await`/`yield` are accepted as ordinary-identifier
// subjects. The `is` TARGET is an ordinary (non-predicate) Type, so `x is y is z` rejects.
// `asserts` predicates are NOT here — they live in the general Type (tsc parses them in any
// position), and a return type written `asserts x` falls through to the Type arm below.
// A function/method/accessor/arrow/fn-type RETURN type. For the PARSER it adds the type
// predicate `x is T` / `this is T` (subject = identifier or `this`; target = an ordinary
// non-predicate Type, so `x is y is z` rejects) on top of an ordinary Type — and the
// predicate appears ONLY here (return position), nowhere else. It stays TRANSPARENT (the
// strict side is a plain `alt`, not a rule), so a normal return is a bare `Type` node —
// identical CST shape to a pre-predicate return slot, leaving AST lowering / cst-match
// unaffected. tsRelax: tree-sitter renders just `Type` here (the predicate lives in its
// general type instead), so adding ReturnType to ~18 slots doesn't inflate its GLR table.
const ReturnType = tsRelax(alt([alt(Ident, 'this'), 'is', Type], Type), Type);

const ClassHeritage = rule($ => [
  // Non-constructor primaries: tsc PARSES `extends undefined/true/42/"x"` cleanly
  // (rejecting them is the CHECKER's job), so the heritage grammar must too. The
  // identifier-reference head is reserved-guarded (notReservedExpr, the same guard the
  // expression NUD uses): a prefix-operator / statement keyword with NO bare-expression
  // role — `void`, `typeof`, `delete`, `enum`, `case`, `throw`, … — is not a valid base
  // (tsc parses `extends void {}` as "Expression expected"), while `this`/`await`/`yield`/
  // `async`/plain identifiers are. Literals stay listed first so they keep their leaf scope.
  // (leds below also cover `A?.B` — tsc parses optional chains in heritage cleanly)
  Number_, String_, 'true', 'false', 'null', 'undefined',
  [notReservedExpr, Ident],
  // The heritage clause is a LeftHandSideExpression, not just a dotted name: a
  // parenthesized expression (`extends (B)`, `extends (cond ? A : B)`) and a class
  // EXPRESSION (`extends class {}`, `extends class Q extends P {}`) are both valid
  // bases. (Before, only `Ident` was a base, so `extends (B)` was rejected and
  // `extends class {}` only "worked" by mis-reading `class` as the superclass name.)
  ['(', Expr, ')'],
  ['class', opt(notReserved, Ident), opt(TypeParams), opt('extends', $), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}'],
  [$, '.', Ident],
  [$, '?.', Ident],
  [$, '<', sep(Type, ','), '>'],
  [$, '(', sep(Expr, ','), ')'],
]);

// Heritage clauses, shared by every class shape: tsc parses REPEATED and order-free
// `extends`/`implements` clauses (`class D extends A extends B implements I`), each a
// comma list; element parses stop at the next clause keyword (the not() guard), and a
// clause may even be EMPTY (`class M extends { }` — tsc reads `{` as the body).
const heritageClauses = many(alt(
  ['extends', sep(alt([not(alt('extends', 'implements')), ClassHeritage]), ',')],
  ['implements', sep(alt([not(alt('extends', 'implements')), ClassHeritage]), ',')],
));

const NewTarget = rule($ => [
  Ident,
  // a `new` expression is itself a valid new-target (NewExpression : `new` NewExpression),
  // so `new new Foo()()` / `new new f` chain — mirrors the Expr `new` arm but recurses here.
  ['new', not('<'), $, opt(alt(['<', sep(Type, ','), '>', opt('(', sep(Expr, ','), ')')], ['(', sep(Expr, ','), ')']))],
  [$, '.', Ident],
  [$, '[', Expr, ']'],
  ['(', Expr, ')'],
]);

const Expr = rule($ => [
  // A standalone identifier expression, but never a reserved word that has no expression
  // role (see notReservedExpr). This kills the bare-identifier fallback for keywords like
  // `catch`/`throw` and the prefix operators `void`/`typeof`/`delete`, so `catch(x){}`
  // with no `try`, `void ;`, and `throw ;` are rejected as TS does. (`enum` is included —
  // it previously had its own `not('enum')` guard for the same reason.)
  // Keyword-valued literals come BEFORE the bare-identifier nud: a longest-match TIE
  // (both are one token) goes to the first-listed alternative, so listing the literals
  // first makes `this`/`true`/… arrive as $keyword leaves — the tree records what the
  // word IS instead of the bare-identifier fallback winning the tie and stamping Ident.
  'true', 'false', 'null', 'undefined', 'this',
  // `super` is a CONSTRAINED primary (mirrors tsc's parseSuperExpression): it MUST be
  // immediately followed by a call `(args)`, a member `.name`/`.#priv`, or an element
  // `[expr]` access. Bare `super`, `super<T>()`, `super?.x`, a super-tagged-template, and
  // `super = …` are all parse errors. Modeling super as a bare atom would let the generic
  // LEDs (type-arg call, optional chain, tagged template, assignment) attach and re-open
  // that whole class; further access chains off the RESULT normally (`super.x<T>()`).
  ['super', alt(['(', sep($, ','), ')'], ['.', alt(Ident, PrivateField)], ['[', $, ']'])],
  // bare-identifier NUD — excludes `super` AND `new` (reserved one-token text matches
  // handled by their own arms above; without these guards a failed `super`/`new` arm would
  // slide the keyword in here as an Ident — e.g. `new <T>Foo()` reparsing as `(new < T) > Foo()`).
  [not('super'), not('new'), notReservedExpr, Ident],
  Number_,
  String_,
  Template,
  Regex_,
  [$, op, $],
  [prefix, $],
  [$, postfix],
  ['...', $],
  // typed call / tagged template: f<T>(…) | f<T>`…` — a call/tag may itself be
  // continued by member access (`f<T>().x`), so this is an ordinary access tail.
  [$, '<', sep(Type, ','), '>', alt(['(', sep($, ','), ')'], Template)],
  // bare instantiation `f<T>` (no call/tag): allowed only when the next token
  // can't start an expression — otherwise `<`/`>` were comparisons (`f < a, b > 7`),
  // the disambiguation TS makes via canFollowTypeArgumentsInExpression. Ending in a
  // negative lookahead, this LED closes the access tail (it asserts nothing follows),
  // so a `.`/`?.` property access can't chain off it: `Foo<T>.Bar` is rejected
  // (TS1477 — a bare instantiation is not a valid base for property access). A `[`,
  // `(`, or `` ` `` continuation still reparses the `<…>` as comparisons (those start
  // an expression, so `not($)` fails the bare arm), matching TS.
  [$, '<', sep(Type, ','), '>', not(Expr)],
  [$, '(', sep($, ','), ')'],
  [$, '.', alt(Ident, PrivateField)],
  // optional chaining: ?.x | ?.#x | ?.(args) | ?.[i] | ?.`…` | ?.<T>(args). A private member
  // `a?.#x` IS valid current ECMAScript (V8 + Babel accept; tsc's lone parse rejection is a bug
  // being removed in TS#60263), so PrivateField stays — the CST producer models the syntax, not
  // a tsc-only restriction. Any "no private in optional chain" rule, were it real, would be a
  // Static-Semantics check in a CST consumer, never a parse-level exclusion here.
  [$, '?.', alt(Ident, PrivateField, ['(', sep($, ','), ')'], ['[', $, ']'], Template, ['<', sep(Type, ','), '>', '(', sep($, ','), ')'])],   // optional typed call `a?.<T>(args)`
  [$, '[', $, ']'],
  [$, sameLine, '!'],   // TS non-null assertion — RESTRICTED (no line break before `!`, like postfix ++/--); a LHS-chain tail (access can follow: `x!.y`, `x!()`)
  [$, '?', $, ':', $],
  [$, 'as', Type],
  [$, 'instanceof', $],
  [$, 'in', $],
  [$, Template],
  // `new.target` meta-property — the ONLY form where `new` is not followed by a target.
  // Listed before the `new T` arm and matched by the dedicated `new` arms (NOT the bare
  // identifier nud, which excludes `new`), so `new <T>Foo()` — where the `new T` arm fails
  // on the leading `<` — can no longer fall through to `new` as an identifier and reparse
  // as the comparison `(new < T) > Foo()` (tsc: "Expression expected").
  ['new', '.', 'target'],
  // new T | new T(args) | new T<X> | new T<X>(args). An optional chain may NOT follow a bare
  // `new` (no Arguments): a NewExpression is not a valid `?.` base (the base must be a
  // MemberExpression / CallExpression — i.e. a `new` WITH `( )`), so `new a?.b`, `new a<T>?.b`,
  // `new class{}?.x`, `new new a()?.x` have no parse tree (tsc + V8 + babel all reject). The
  // `not('?.')` guards exactly the no-call exits; `new a()?.b` (Arguments consumed) chains via
  // the outer `?.` LED unchanged.
  ['new', NewTarget, alt(
    ['<', sep(Type, ','), '>', alt(['(', sep($, ','), ')'], not('?.'))],
    ['(', sep($, ','), ')'],
    not('?.'),
  )],
  ['new', 'class', notReserved, Ident, opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}', alt(['(', sep($, ','), ')'], not('?.'))],
  ['new', 'class', opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}', alt(['(', sep($, ','), ')'], not('?.'))],
  ['[', many(opt($), ','), opt($), ']'],
  ['{', sep(Prop, ','), '}'],
  // Arrow functions, async/non-async SPLIT so the [Await] grammar parameter routes
  // each arm's params + body to the right rule family (await-yield-fork.ts): an async
  // arrow's params and body are await-context (`async (a = await) =>` rejects), a
  // plain arrow's body resets. Type params/annotations stay PLAIN (not await-context).
  // capExpr('?'): an ArrowFunction is the LOWEST-precedence AssignmentExpression — neither a
  // binary/logical/conditional operand nor an assignment target — so each arm is capped BELOW
  // the conditional `?`: it parses only at an assignment-or-looser minBp and admits no led once
  // parsed (`() => {} || a` rejects, NOT `(() => {}) || a`); a `||`/`?:` INSIDE an expression
  // body (`() => a || b`) is unaffected. Body `alt(Block, $)` (Block FIRST) = the spec's
  // ConciseBody `[lookahead ≠ {] AssignmentExpression | { FunctionBody }`.
  capExpr('?', 'async', opt(TypeParams), '(', sep(awaitCtx(Param), ','), ')', opt(":", ReturnType), '=>', awaitCtx(alt(Block, $))),
  capExpr('?', opt(TypeParams), '(', sep(Param, ','), ')', opt(":", ReturnType), '=>', resetCtx(alt(Block, $))),
  // async arrow with a BARE parameter: `async err => …`. tsc requires async and the
  // parameter on the same line (`async\nx => …` is `async;` then a plain arrow — ASI).
  // Without this arm the bare form only "parsed" by splitting into two statements.
  capExpr('?', 'async', sameLine, awaitCtx(notReservedExpr, Ident), '=>', awaitCtx(alt(Block, $))),
  capExpr('?', notReservedExpr, Ident, '=>', resetCtx(alt(Block, $))),
  ['yield', alt(['*', $], [opt($)])],   // yield e | yield* e (delegate) | yield
  ['(', $, many(',', $), ')'],
  [$, 'satisfies', Type],
  ['import', alt(['(', $, ')'], ['.', 'meta'], ['<', sep(Type, ','), '>', opt('(', sep($, ','), ')')])],   // import(e) | import.meta | import<T>(args) (instantiation-expression; checker rejects)
  PrivateField,
  HexNumber, OctalNumber, BinaryNumber, BigInt_,
  ...tsFnArms([opt(notReserved, Ident)], Block),
  // named vs anonymous kept separate (greedy opt(Ident) would eat a leading
  // `extends`/`implements`); decorator dimension is a `many` (a class expression may
  // carry ≥2 decorators, `x = @d @d class C {}`, like the declaration arm below).
  [many(DecoratorExpr), 'class', notReserved, Ident, opt(TypeParams), heritageClauses, '{', many(ClassMember), '}'],
  [many(DecoratorExpr), 'class', opt(TypeParams), heritageClauses, '{', many(ClassMember), '}'],
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
  [Ident, ':', BindingElement],
  // shorthand `a` / shorthand-with-default `a = 1` — the name is a BindingIdentifier,
  // so a reserved word is invalid (`{ while }`, `{ class }`).
  [notReserved, Ident, opt('=', Expr)],
  [alt(String_, Number_, ['[', Expr, ']']), ':', BindingElement],  // "s"/0/[e]: elem
  // rest: ...r | ...{ a } — tsc also parses `...r: name` and `...r = init` (the
  // object-binding-element shape is uniform; "rest can't have a property name /
  // initializer" are checker errors, both parse-clean).
  ['...', alt([notReserved, Ident], BindingPattern), opt(':', BindingElement), opt('=', Expr)],
]);

const BindingElement = rule($ => [
  [alt([notReserved, Ident], BindingPattern), opt('=', Expr)],  // a | { a }  (optionally = default)
]);

const ArrayBindingElement = rule($ => [
  BindingElement,
  ['...', alt([notReserved, Ident], BindingPattern)],    // [...rest] | [...{ a }]
]);

const BindingPattern = rule($ => [
  ['{', sep(BindingProperty, ','), '}'],                  // { a, b: c, ...rest }
  ['[', opt(ArrayBindingElement), many(',', opt(ArrayBindingElement)), ']'],  // [a, , b, ...rest]
]);

// ── Bindings & Parameters ──

const Binding = rule($ => [
  [alt([notReserved, Ident, opt('!')], BindingPattern), opt(':', Type), opt('=', Expr)],
]);

// A binding in a for-head: identical to Binding except the initializer is a
// no-`in` expression, so `for (var a = 1 in xs)` reads `a = 1` then the for-in
// `in` (TS's [~In] grammar), rather than greedily parsing `1 in xs`.
const ForBinding = rule($ => [
  [alt([notReserved, Ident, opt('!')], BindingPattern), opt(':', Type), opt('=', exclude('in', Expr))],
]);


const Param = rule($ => {
  const tail = [opt('?'), opt(':', Type), opt('=', Expr)];   // ?  : T  = E
  const body = alt(
    // The plain-name arm EXCLUDES `this`: tsc's parser treats `this` as a special
    // parameter form accepting ONLY bare `this` or `this: T` (the dedicated arm below)
    // — `this?`, `this = 1`, `this: T = 1`, and any decorated/modified `this`
    // (`@dec this`, `public this`) are parse errors there. Letting `this` match as a
    // plain Ident here would re-open that whole class via the tail/decorator/modifier
    // paths. (A truly reserved param name like `function f(while)` stays an accepted
    // over-accept; it's out of this gap's scope.)
    [not('this'), Ident, ...tail],
    [BindingPattern, ...tail],
    // a rest element, by contrast, can never validly be a reserved word (`...while`),
    // and `...this` is invalid too, so guarding the rest name is FN-safe.
    ['...', alt([notReserved, Ident], BindingPattern), opt('?'), opt(':', Type), opt('=', Expr)],   // rest (`?`/initializer are CHECKER errors in tsc, not parse errors)
  );
  return [
    // `this`-param: bare `this` or `this: T` ONLY — no `?`, no default, no decorator,
    // no modifier (tsc's parser rejects all of those). This is the SOLE way `this`
    // reaches param position; the plain-name arm above excludes it.
    ['this', opt(':', Type)],
    // optional decorators + optional parameter modifiers, then the binding.
    // many1 → with modifiers; the no-modifier branch also catches a param NAMED
    // like a modifier (`public: T`), which many() would otherwise eat. tsc parses
    // the FULL modifier soup on any parameter (`f(static x)`, `f(export x)`,
    // `f(async x)` are parse-clean — validity is the checker's job); only
    // `const`/`default` are parse errors there and stay out.
    [opt(DecoratorExpr), many1(alt('public', 'private', 'protected', 'readonly', 'override', 'static', 'abstract', 'accessor', 'async', 'export', 'declare', 'in', 'out')), body],
    [opt(DecoratorExpr), body],
  ];
});

const ForHead = rule($ => {
  const cTail = [';', opt(Expr, many(',', Expr)), ';', opt(Expr, many(',', Expr))];  // `; cond ; update`
  return [
    // declared head: `let/const/var/using/await using <bindings>` then C-style or in/of.
    // ForBinding gives a no-`in` initializer so `for (var a = 1 in xs)` parses.
    // `for (using of of …)` has no parse tree: the spec's `[lookahead != using of]` on the
    // `using` ForDeclaration arm suppresses the using-DECL reading, and `using` as an
    // identifier then fails (`using of of` reads as two for-of keywords). Guard the exact
    // triple only — `for (using of ;…)` (C-style, binding named `of`) and `for (await using
    // of of …)` (the await-using arm) stay valid.
    [not(['using', 'of', 'of']), alt('let', 'const', 'var', 'using', ['await', 'using']), sep(ForBinding, ','), alt(
      cTail,
      // the for-in OBJECT is a full Expression (comma included: `for (a in b, c)`);
      // for-of takes an AssignmentExpression - no comma (tsc rejects `for (x of a, b)`)
      ['in', Expr, many(',', Expr)],
      ['of', Expr],
    )],
    [opt(Expr, many(',', Expr)), ...cTail],   // C-style, no declaration: `for (i=0; …; …)` / `for (;;)`
    // for-in/of, no declaration: `for (x of xs)`. The target Expr parses in a no-`in`
    // context (same exclude as binding initializers): the `in` belongs to the for-head,
    // not to an in-LED inside the target — without it `for (key in obj)` swallowed the
    // `in`, the arm failed, and the statement fell back to a CALL parse `for(...)`.
    [exclude('in', Expr), 'in', Expr, many(',', Expr)],
    [exclude('in', Expr), 'of', Expr],
  ];
});

const SwitchCase = rule($ => [
  ['case', Expr, many(',', Expr), ':'],
  ['default', ':'],
  Stmt,
]);

const Stmt = rule($ => [
  Block,
  [alt('let', 'const', 'var'), sep(Binding, ','), asi()],
  ['if', '(', Expr, many(',', Expr), ')', $, opt('else', $)],
  ['for', opt('await'), '(', ForHead, ')', $],
  ['while', '(', Expr, many(',', Expr), ')', $],
  ['do', $, 'while', '(', Expr, many(',', Expr), ')', opt(';')],
  ['switch', '(', Expr, many(',', Expr), ')', '{', many(SwitchCase), '}'],
  ['return', opt(Expr, many(',', Expr)), asi()],
  ['throw', Expr, many(',', Expr), asi()],
  // The label is a RESTRICTED production (`break [no LineTerminator here] Label`)
  // and a label can't be a reserved word — without both, `break` ⏎ `case "X":`
  // inside a switch eats `case` as the label and the whole switch cascades.
  ['break', opt(sameLine, notReserved, Ident), asi()],
  ['continue', opt(sameLine, notReserved, Ident), asi()],
  ['try', Block, opt('catch', opt('(', alt(Param, BindingPattern), ')'), Block), opt('finally', Block)],
  [notReserved, Ident, ':', $],
  ';',
  ['debugger', asi()],
  ['with', '(', Expr, ')', $],
  // A `using` / `await using` declaration binding is a BindingIdentifier — NOT a pattern. The
  // `not(alt('[','{'))` routes a `[`/`{` start to the expression arm instead: `using [a] = b`
  // is `using[a] = b` (element-assignment on the identifier `using`) and stays valid, while
  // `using {a} = b` / `await using [a] = null` (no derivation — V8 + babel reject; tsc is
  // lenient on the `{` form) correctly fail. (Guards the first binding; see ForHead for for-of.)
  [opt('await'), 'using', not(alt('[', '{')), sep(Binding, ','), asi()],
  Decl,
  // ExpressionStatement lookahead restriction (ES2023 §14.5): a statement may not
  // begin with `function` / `async function` — those are declarations at statement
  // level. Without this guard, longest-match lets the expression arm win whenever a
  // call/member tail makes it LONGER (`function f(){}\n(g)()` merged into one
  // IIFE-style expression statement; tsc keeps them separate). `{` needs no guard
  // (the Block alternative ties in length and wins as the first-listed alternative).
  // `class` is NOT guarded yet: the class-DECLARATION arm is narrower than tsc's
  // (extends-expression heritage, bare `;` class elements, decorator placements), so
  // 31 tsc-valid corpus files still rely on the class-EXPRESSION fallback — widen the
  // declaration arm first, then guard.
  [not(alt('function', 'class', ['async', 'function'], ['let', '['])), Expr, many(',', Expr), asi()],
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
  // The type-param NAME is `notReserved, Ident`: `in` LEXES as an Ident, so an un-guarded
  // Ident would wrongly accept it as the name — but `in` is a reserved word there (tsc
  // rejects `<in>`/`<in in>`/`<out in>` "'in' is a reserved word"). `notReserved` forbids
  // `in` while allowing `out` and the other contextual keywords; `in` stays a variance
  // modifier (`<in T>`/`<in out>`/`<in out T>` parse). Guards arm 1's name too.
  const name = [notReserved, Ident];
  return [
    [many1(mod), ...name, ...tail],  // modifier soup + name: `<const in T>`, `<in T>`, `<in out T>`
    [mod, ...name, ...tail],         // single modifier + name: `<out out>`, `<in out>`
    [...name, ...tail],              // bare name: `<T>`, `<out>` (NOT `<in>`)
  ];
});

const TypeParams = rule($ => [
  ['<', sep(TypeParam, ','), '>'],
]);

// ── Declarations ──

const InterfaceMember = rule($ => {
  const callSig = [opt(TypeParams), '(', sep(typeFnParam(), ','), ')', opt(":", ReturnType)];  // `<T>( … ): Ret`
  const propOrMethod = alt(callSig, [opt(':', Type)]);  // after a name: method | property (bare = implicit any)
  return [
    // call / construct signature (construct = call sig with a leading `new`)
    [opt('new'), ...callSig],
    // getter / setter (`get`/`set` as a member NAME falls through to the named branch)
    [alt('get', 'set'), MemberName, '(', sep(typeFnParam(), ','), ')', opt(":", ReturnType)],
    // mapped type: static? (+/-)? readonly? [ K in T (as U)? ] (+/-)? ?? : T
    [opt('static'), opt(alt('+', '-')), opt('readonly'), '[', Ident, 'in', Type, opt('as', Type), ']', opt(alt('+', '-')), opt('?'), ':', Type],
    // readonly property (readonly index sig is the bracketed branch below)
    ['readonly', MemberName, opt('?'), ':', Type],
    // named / computed member (MemberName includes `[Expr]`) — branch property | method.
    // Placed before the index signature so a bare `[expr]` parses as a computed
    // property (TS: `[p]` is a computed property, not an indexer).
    [MemberName, opt('?'), propOrMethod],
    // index signature: static? readonly? [ Param,* ] (: T)?  — TS parses the brackets
    // as a full parameter list, so `[]`, `[a?]`, `[public a]`, `[a: T, b: U]` all parse
    // (the extra forms are grammar-errors TS reports post-parse, but the parser accepts).
    [opt('static'), opt('readonly'), '[', sep(typeFnParam(), ','), ']', opt(':', Type)],
  ];
});

const MemberName = rule($ => [
  Ident,
  PrivateField,
  String_,
  Number_,
  HexNumber,
  OctalNumber,
  BinaryNumber,
  BigInt_,
  ['[', Expr, ']'],
]);

// Branched: parse the modifier list ONCE, then branch on the member kind, so a
// member's shared `modifiers …` prefix isn't re-parsed per alternative. Inner
// alt() is first-match, so branches are ordered specific-before-general
// (generator/accessor/index-sig before the MemberName method/field split).
// A modifier KEYWORD counts as a modifier only when what follows can still be a
// member (tsc's disambiguation): followed by '('/'='/':'/';'/'?'/'!'/'<'/'{'/'}'
// it is the member NAME instead ('public() {}', 'static = 1'). 'declare' is a real
// class modifier; 'export'/'in'/'out' are parse-tolerated by tsc (semantic errors).
// `async` is NOT a generic class-member modifier here: it leads the async/async-generator
// method arms below (which give the body its [Await] context), so the modifier soup must
// not swallow it into a plain method (the class analog of the Decl modifier-prefix fix).
const Modifier = alt([alt('public', 'private', 'protected', 'static', 'abstract', 'readonly', 'override', 'accessor', 'declare', 'export', 'in', 'out', 'const'), not(alt('(', '=', ':', ';', '?', '!', '<', '{', '}'))]);
// A class-member modifier run allows AT MOST ONE `static` — this is SYNTAX, not a deferred
// duplicate-modifier check: ECMAScript's ClassElement production has a single `static` slot,
// and `static static x` is rejected by BOTH tsc AND babel (the only valid reading of a second
// `static` is a member NAME — `static static(){}` / `static static = 1` parse — so once the
// name slot is taken, a trailing field name has no production). Two static MODIFIERS is simply
// not a grammar-sanctioned tree. (Duplicate NON-static modifiers like `public public` are a
// different matter — tsc parses them as a checker error, babel parse-rejects them; we follow
// tsc and keep them in the run as a faithful CST, leaving the duplicate as a downstream
// semantic check.) So the run is: non-static modifiers, then OPTIONALLY one `static` followed
// by more non-static modifiers. (The second `many` sits INSIDE the opt — two adjacent
// delimiter-less `many`s would be ambiguous.) This precise shape DOUBLES the modifier-vs-
// member-name decision boundaries against the member alt, which explodes tree-sitter's GLR
// table — so it is wrapped in tsRelax with plain `many(Modifier)` as the relaxed rendering: a
// legitimate CAPABILITY bridge (GLR cannot express the at-most-one-static refinement cheaply),
// and a highlighter over-accepting `static static` is harmless and measured.
const NonStaticMod = alt([alt('public', 'private', 'protected', 'abstract', 'readonly', 'override', 'accessor', 'declare', 'export', 'in', 'out', 'const'), not(alt('(', '=', ':', ';', '?', '!', '<', '{', '}'))]);
const modRun = tsRelax([many(NonStaticMod), opt('static', many(NonStaticMod))], many(Modifier));
const callTail = ['(', sep(Param, ','), ')', opt(":", ReturnType), opt(Block), opt(';')] as const;
// Class member ( params ): T body, params+body routed to a [Await]/[Yield] family:
// plain methods reset (a method body has its OWN, non-inherited context — the spec's
// implicit function boundary), generators yield, async await, async-generators both.
// MemberName, type params, and the return type stay OUTSIDE the family (a computed key
// `[e]` is evaluated in the ENCLOSING context, and type positions are not parameterized).
const memTail = (ctx) => ['(', sep(ctx(Param), ','), ')', opt(":", ReturnType), opt(ctx(Block)), opt(';')];
const ClassMember = rule($ => [
  ';',   // tsc's SemicolonClassElement: `class C { ; }` is parse-clean
  ['constructor', '(', sep(resetCtx(Param), ','), ')', resetCtx(Block), opt(';')],
  [many(DecoratorExpr), many(Modifier), 'static', awaitCtx(Block)],   // static block body is [+Await] (await reserved); decorators/modifiers parse (SEMANTIC errors)
  // decorators PREFIX a member, before any modifier — tsc parse-rejects
  // `public @dec method()` ("Decorators are not valid here") and an orphan
  // `@dec` with no member, which a standalone sibling alternative tolerated
  [
    many(DecoratorExpr),
    modRun,
    alt(
      // `async` is order-free among modifiers (tsc parses any order; the checker
      // validates), so it carries its own inner modifier run and an async member's
      // body is [+Await]/[+Await,+Yield].
      ['async', many(Modifier), '*', MemberName, opt('?'), opt(TypeParams), ...memTail(asyncGenCtx)],   // async generator method
      ['async', many(Modifier), alt('get', 'set'), MemberName, opt(TypeParams), '(', opt(sep(awaitCtx(Param), ',')), ')', opt(":", ReturnType), opt(awaitCtx(Block)), opt(';')],  // async accessor (semantic error; parses)
      ['async', many(Modifier), 'static', awaitCtx(Block)],                              // `async static { }` (semantic error; parses)
      ['async', many(Modifier), MemberName, opt('?'), opt(TypeParams), ...memTail(awaitCtx)],            // async method
      ['*', MemberName, opt('?'), opt(TypeParams), ...memTail(yieldCtx)],                // generator method
      [alt('get', 'set'), MemberName, opt(TypeParams), '(', opt(sep(resetCtx(Param), ',')), ')', opt(":", ReturnType), opt(resetCtx(Block)), opt(';')],  // accessor (type params parse; semantic error)
      ['[', Ident, ':', Type, opt(','), ']', opt(':', Type), asi()],          // index signature; member separator = ; / newline / }
      // a bare identifier `constructor` member MUST be a call signature — tsc rejects a
      // `constructor` field/property ("'(' expected"): `constructor;`, `constructor = 1`,
      // `constructor: T`, even modified (`public constructor;`). TypeParams parse; `?`/`!`
      // do not. A string / #private / computed name `constructor` is NOT the identifier,
      // so it stays a valid field (the `not('constructor')` generic arm below covers it).
      ['constructor', opt(TypeParams), ...memTail(resetCtx)],
      [not('constructor'), MemberName, alt(
        [opt('?'), opt(TypeParams), ...memTail(resetCtx)],                       // method (requires `(`)
        // field (all-optional → catch-all). A field NOT ended by ';' must not be
        // followed by a SAME-LINE decorator: tsc reads that '@' as belonging to
        // THIS property ("Decorators must precede the name and all keywords") —
        // `x @dec y()` and `x = 1 @dec y()` reject, `x; @dec` and newline accept
        [opt('!'), opt('?'), opt(':', Type), opt('=', resetCtx(Expr)), alt([';'], [not(sameLine)], [not(not('}'))])],
      )],
    ),
  ],
  // Fallbacks for a member NAMED like a modifier (`static = 1`, `get = 1`, `async() {}`):
  // many(Modifier) would eat the name, so the member kind alt fails and we land here.
  [not('constructor'), MemberName, opt('!'), opt('?'), opt(':', Type), opt('=', resetCtx(Expr)), alt([';'], [not(sameLine)], [not(not('}'))])],
  // `constructor` excluded here too (`constructor?()`/`constructor!()` are tsc parse
  // errors): every VALID `constructor(…)` is caught by the dedicated arms above, so a
  // `constructor` reaching this method fallback is always a malformed form.
  [not('constructor'), MemberName, opt('?'), opt(TypeParams), '(', sep(resetCtx(Param), ','), ')', opt(":", ReturnType), opt(resetCtx(Block)), opt(';')],
]);

const EnumMember = rule($ => [
  [MemberName, opt('=', Expr)],
]);

// Per-specifier `type` modifier (`import { type A }`, `export { type A as B }`). A LONE
// `type` is the specifier NAME (`{ type }`, `{ type as B }`, `{ type, x }`), so the
// modifier reading fires only when a real binding name follows on the same line — the
// not(',', '}', 'as') guard keeps the bare-name reading reachable.
const typeMod = () => opt('type', sameLine, not(alt(',', '}', 'as')));
const ImportSpecifier = rule($ => [
  [typeMod(), Ident, opt('as', Ident)],
  // arbitrary module namespace identifier (ES2022): `import { "str" as x }`. The
  // string form REQUIRES the rename (`{ "a" }` / `{ "a" as "b" }` are tsc parse
  // errors on the import side — the local binding must be an identifier).
  [typeMod(), String_, 'as', Ident],
]);

// Export specifiers are WIDER than import ones: a ModuleExportName (identifier or
// string) is valid on BOTH sides and may stand alone (`export { x as "s" }`,
// `export { "a" as "b" } from "m"`, `export { "a" }` — all tsc parse-clean).
const ExportSpecifier = rule($ => [
  // `type` modifier disambiguation (tsc's multi-token lookahead). `type` is the modifier
  // when followed by a real name that ISN'T `as` (arm 1), or by `as` that is itself the
  // name — `{ type as }`, no rename target after (arm 2). Otherwise `type` is the name:
  // `{ type }`, `{ type as B }` (renamed), `{ type, x }` all take arm 3.
  ['type', sameLine, not('as'), not(alt(',', '}')), alt(Ident, String_), opt('as', alt(Ident, String_))],
  // name is `as`: `{ type as }` (no rename) or `{ type as as Y }` (DOUBLE as = rename).
  // A single `{ type as Y }` is NOT this arm — the not(Ident/String) / second-`as` guard
  // rejects it so it falls to arm 3 as name=`type` renamed to Y.
  ['type', sameLine, 'as', alt([not(alt(Ident, String_))], ['as', alt(Ident, String_)])],
  [alt(Ident, String_), opt('as', alt(Ident, String_))],
]);

const ImportClause = rule($ => [
  // deferred import (TS 5.9): `import defer * as ns from "m"`. `defer` is a phase
  // modifier here, ONLY valid immediately before the namespace `* as`. As a keyword
  // literal it still lexes as an Ident, so `defer` stays an ordinary binding name in
  // every other position (`const defer = 1`, `import defer from "m"`, `defer()`).
  ['defer', '*', 'as', Ident],
  // default import, optionally followed by named `{…}` or namespace `* as x`
  [Ident, opt(',', alt(['{', sep(ImportSpecifier, ','), '}'], ['*', 'as', Ident]))],
  ['{', sep(ImportSpecifier, ','), '}'],
  ['*', 'as', Ident],
]);

const Decl = rule($ => [
  // Function declarations live here (not in Stmt) so that at statement level a
  // leading `function` is preferred as a declaration over an IIFE expression-
  // statement: Program tries Decl before Stmt, so `function f(){}\n()=>{}` parses
  // as a declaration + arrow rather than longest-matching `function f(){}()` (IIFE).
  ...tsFnArms([notReserved, Ident], alt(Block, [not('{'), opt(';')])),
  // The declaration NAME slots below carry `notReserved` (same guard as the type-alias
  // name): a reserved word is not a legal declaration name (`interface void {}`,
  // `class while {}`, `enum for {}`, `namespace debugger {}` — all TS errors), while a
  // contextual keyword name (`interface any`, `class string`, `enum number`) stays valid.
  // tsc parses REPEATED `extends` clauses on an interface (`interface I extends A
  // extends B`) — the parser accepts them and the checker reports the duplicate;
  // mirror with many() rather than a single opt() clause.
  ['interface', notReserved, Ident, opt(TypeParams), heritageClauses, '{', many(InterfaceMember, opt(alt(';', ','))), '}'],   // shared heritage: repeated/order-free extends+implements, `extends Foo?.Bar`, empty `extends {`
  ['type', notReserved, Ident, opt(TypeParams), '=', Type, opt(';')],   // type-alias name can't be a reserved word (`type void = …`); contextual type keywords (`string`/`any`/…) stay valid
  // class decl: optional decorators + optional `abstract`. gen-tm expands the
  // opt()/many() to recover the `class Ident … { … }` shape for highlighting.
  [many(DecoratorExpr), opt('abstract'), 'class', notReserved, Ident, opt(TypeParams), heritageClauses, '{', many(ClassMember), '}'],
  // NAMELESS class declaration: tsc parses `class { … }` at statement level cleanly
  // ("a class declaration without 'default' must have a name" is a checker error).
  // Named/anonymous are separate arms, mirroring the class-expression pair above.
  [many(DecoratorExpr), opt('abstract'), 'class', opt(TypeParams), heritageClauses, '{', many(ClassMember), '}'],
  ['enum', notReserved, Ident, '{', sep(EnumMember, ','), '}'],
  ['declare', 'function', opt('*'), notReserved, Ident, opt(TypeParams), '(', sep(Param, ','), ')', opt(":", ReturnType), opt(';')],
  // ambient module shorthand `declare module "foo";` (no body — the module arm below
  // requires `{…}`) and `declare global { … }` (global-scope augmentation; `global`
  // is a contextual-keyword block, not a namespace name). tsc accepts both.
  ['declare', 'module', String_, opt(';')],
  ['declare', 'global', '{', many(Stmt), '}'],
  ['declare', alt($, Stmt)],
  // A leading `async`/`abstract` modifier before any declaration: tsc's parser
  // accepts it (the checker rejects invalid combinations like `async class`); the
  // dedicated arms above (function's async arm, class's opt('abstract')) match
  // valid combinations first and keep their flat shape, so only otherwise-invalid
  // pairings fall to this modifier-prefix arm. `async` is split out with a
  // `not('function')` guard: `async function` MUST take the async-function arm so
  // its params/body carry the [Await] context — otherwise this lenient prefix would
  // catch the async arm's await-context rejections (e.g. `async function f(a=await)`)
  // and re-accept them as a plain function with a stray `async` modifier.
  // A leading modifier soup before a declaration — mirrors the decorator-prefix arm
  // below (var/let/const/using are Stmt-level forms `$`=Decl alone can't reach). tsc
  // parses the soup before any of these (`accessor var x`, `public using y`); invalid
  // combinations are the checker's line. Restricted to Decl + var/let/const + using —
  // NOT an arbitrary expression statement (`public someExpr;` must stay a reject).
  [many1(alt('abstract', 'public', 'private', 'protected', 'readonly', 'static', 'override', 'accessor')), alt(
    $,
    [alt('let', 'const', 'var'), sep(Binding, ','), asi()],
    [opt('await'), 'using', not(alt('[', '{')), Binding, many(',', Binding), opt(';')],
  )],
  ['async', not('function'), $],
  ['namespace', notReserved, Ident, many('.', Ident), '{', many(Stmt), '}'],   // dotted name: `namespace A.B.C { … }`
  ['module', alt([notReserved, Ident, many('.', Ident)], String_), '{', many(Stmt), '}'],   // `module A.B.C { … }` | `module "x" { … }`
  ['export', 'as', 'namespace', notReserved, Ident, opt(';')],   // UMD NamespaceExportDeclaration — BEFORE the lenient `export alt($, Stmt)` (else `as` wraps as an expr-statement)
  ['export', alt($, Stmt)],
  // decorators before export/default/etc. — tsc allows either order. The variable-
  // statement alternates mirror tsc's parseDeclaration surface: after decorators it
  // accepts var/let/const and `using` statements too (`@dec var x` is parse-clean,
  // "decorators are not valid here" is the checker's line), but NOT arbitrary
  // statements (`@dec if (…)` is a tsc parse error).
  [many1(DecoratorExpr), alt(
    $,
    [alt('let', 'const', 'var'), sep(Binding, ','), asi()],
    // `using` requires a real binding here: `@dec using x` is parse-clean but
    // `using 1` is a tsc parse error (zero-binding `var;` by contrast is clean,
    // so the var/let/const alternative above keeps the lenient sep()).
    [opt('await'), 'using', not(alt('[', '{')), Binding, many(',', Binding), opt(';')],
  )],
  // decorators may also sit BETWEEN `export` and `default` (`export @dec default
  // class C {}` — tsc parses the soup in either spot; ordering is a checker error).
  ['export', many(DecoratorExpr), 'default', alt(
    ...tsFnArms([opt(notReserved, Ident)], alt(Block, [not('{'), opt(';')])),  // function
    ['abstract', 'class', notReserved, Ident, opt(TypeParams), heritageClauses, '{', many(ClassMember), '}'],  // named abstract class
    ['abstract', 'class', opt(TypeParams), heritageClauses, '{', many(ClassMember), '}'],          // anonymous abstract class
    ['interface', notReserved, Ident, opt(TypeParams), heritageClauses, '{', many(InterfaceMember, opt(alt(';', ','))), '}'],   // export default interface (interface is not an Expr)
    [Expr, opt(';')],   // catch-all: export default <expr>
  )],
  ['export', opt('type'), '*', alt(['from', String_, opt(';')], ['as', alt(Ident, String_), 'from', String_, opt(';')])],   // export (type)? * (as ns)? from "m" — alias is a ModuleExportName
  ['export', '{', sep(ExportSpecifier, ','), '}', opt('from', String_), opt(';')],
  ['export', '=', Expr, opt(';')],
  ['export', 'type', '{', sep(ExportSpecifier, ','), '}', opt('from', String_), opt(';')],
  ['const', 'enum', notReserved, Ident, '{', sep(EnumMember, ','), '}'],
  ['import', alt(
    [ImportClause, 'from', String_, opt(';')],          // import X from "m"  (also `import type from "m"` = default named `type`)
    ['type', ImportClause, 'from', String_, opt(';')],  // import type X from "m"
    ['type', Ident, '=', Expr, opt(';')],               // import type X = require(…) / = ns.Foo (type-only import-equals)
    [Ident, '=', Expr, opt(';')],                       // import x = expr  (also `import type = …` where `type` is the binding name)
    [String_, opt(';')],                                // import "m"
  )],
  [many(DecoratorExpr), 'export', alt($, Stmt)],
]);

// ── Entry ──

const Program = rule($ => [
  many(alt(Decl, Stmt)),   // Decl first: prefer declaration over IIFE expression-statement
]);

// ── Grammar ──

export default defineGrammar({
  name: 'typescript',
  scopeName: 'source.ts',

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

  rules: {
    Type, TypeMember, DecoratorExpr, TypeofRef,
    Expr, Prop, MemberName, NewTarget, ClassHeritage,
    Stmt, Block,
    BindingProperty, BindingElement, ArrayBindingElement, BindingPattern,
    Binding, ForBinding, Param, ForHead, SwitchCase,
    TypeParams, TypeParam,
    Decl, InterfaceMember, ClassMember, EnumMember,
    ImportClause, ImportSpecifier, ExportSpecifier,
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
