import {
  rule, defineGrammar,
  op, prefix, postfix, sameLine,
  sep, opt, many, many1, alt, exclude, not,
} from '../src/api.ts';
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
  notReserved, notReservedExpr, ecmaPrec, jsScopes,
} from './javascript.ts';

// ── Type query reference (typeof's argument: just dotted identifiers) ──

const TypeofRef = rule($ => [
  Ident,
  [$, '.', Ident],
]);

// ── Decorators ──

const DecoratorExpr = rule($ => [
  [Decorator, opt(alt(
    ['(', sep(Expr, ','), ')'],                          // @dec(args)
    ['<', sep(Type, ','), '>', '(', sep(Expr, ','), ')'], // @dec<T>(args)
  ))],
]);

// ── Types ──

const TypeMember = rule($ => {
  const callSig = [opt(TypeParams), '(', sep(Param, ','), ')', opt(':', Type)];  // `<T>( … ): Ret`
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
        [':', Type, ']', opt(':', Type)],                                             // index:  k: T
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
  const fnType = [opt(TypeParams), '(', sep(Param, ','), ')', '=>', $];  // (a: T) => R  /  <T>(…) => R
  return [
    [Ident, opt('is', $)],   // T  |  type predicate `x is T`
    [$, '<', sep($, ','), '>'],
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
    ['[', many(opt('...'), opt(Ident, opt('?'), ':'), opt('...'), $, opt('?'), opt(',')), ']'],
    ['{', many(TypeMember, opt(alt(';', ','))), '}'],
    ['asserts', Ident, opt('is', $)],
    [$, 'extends', $, '?', $, ':', $],
    // infer U | infer U extends T | infer U extends T ? X : Y (conditional binds to the infer)
    ['infer', Ident, opt('extends', $, opt('?', $, ':', $))],
    String_,
    Number_,
    HexNumber, OctalNumber, BinaryNumber, BigInt_,
    ['-', alt(Number_, BigInt_)],
    'true', 'false', 'null', 'undefined', 'void', 'this',
    ['unique', 'symbol'],
    ['import', '(', $, ')'],
    Template,
    [$, sameLine, '[', $, ']'],   // indexed access T[K] — `[` must be on the same line (no ASI)
    [$, '.', Ident],
  ];
}, { type: true });

// ── Expressions ──

const Prop = rule($ => {
  const method = ['(', sep(Param, ','), ')', opt(':', Type), Block];   // ( … ): T { … }
  return [
    ['...', Expr],                                                     // spread
    // accessor (get/set), optionally with an accessibility modifier (lenient)
    [opt(alt('public', 'private', 'protected')), alt('get', 'set'), MemberName, '(', opt(sep(Param, ',')), ')', opt(':', Type), Block],
    // method: async?/generator?, any member name (incl `#x`, computed `[e]`), then ( … ) { … }
    [opt('async'), opt('*'), MemberName, opt(TypeParams), ...method],
    // value property — any member name incl computed `[e]: v` (MemberName covers `[Expr]`)
    [MemberName, ':', Expr],
    ['[', Expr, many(',', Expr), ']', ':', Expr],                      // computed comma list (lenient)
    // shorthand (Ident only): x | x = v | x? | x?: v — a reserved word here is invalid
    // (`var v = { class }`); a reserved word as a property KEY (`{ class: 1 }`) is fine,
    // already handled by the `[MemberName, ':', Expr]` branch above.
    [notReserved, Ident, alt(['=', Expr], ['?', opt(':', Expr)], [])],
  ];
});

const ClassHeritage = rule($ => [
  Ident,
  [$, '.', Ident],
  [$, '<', sep(Type, ','), '>'],
  [$, '(', sep(Expr, ','), ')'],
]);

const NewTarget = rule($ => [
  Ident,
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
  [notReservedExpr, Ident],
  Number_,
  String_,
  Template,
  Regex_,
  'true', 'false', 'null', 'undefined', 'this', 'super',
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
  // optional chaining: ?.x | ?.#x | ?.(args) | ?.[i] | ?.`…`
  [$, '?.', alt(Ident, PrivateField, ['(', sep($, ','), ')'], ['[', $, ']'], Template)],
  [$, '[', $, ']'],
  [$, '!'],   // TS non-null assertion — a LHS-chain tail (access can follow: `x!.y`, `x!()`), unlike update `++`/`--`
  [$, '?', $, ':', $],
  [$, 'as', Type],
  [$, 'instanceof', $],
  [$, 'in', $],
  [$, Template],
  // new T | new T(args) | new T<X> | new T<X>(args)
  ['new', NewTarget, opt(alt(
    ['<', sep(Type, ','), '>', opt('(', sep($, ','), ')')],
    ['(', sep($, ','), ')'],
  ))],
  ['new', 'class', Ident, opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}', opt('(', sep($, ','), ')')],
  ['new', 'class', opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}', opt('(', sep($, ','), ')')],
  ['[', many(opt($), ','), opt($), ']'],
  ['{', sep(Prop, ','), '}'],
  [opt('async'), opt(TypeParams), '(', sep(Param, ','), ')', opt(':', Type), '=>', alt($, Block)],
  [Ident, '=>', alt($, Block)],
  ['yield', alt(['*', $], [opt($)])],   // yield e | yield* e (delegate) | yield
  ['(', $, many(',', $), ')'],
  [$, 'satisfies', Type],
  ['import', alt(['(', $, ')'], ['.', 'meta'])],
  PrivateField,
  HexNumber, OctalNumber, BinaryNumber, BigInt_,
  [opt('async'), 'function', opt('*'), opt(Ident), opt(TypeParams), '(', sep(Param, ','), ')', opt(':', Type), Block],
  // named vs anonymous kept separate (greedy opt(Ident) would eat a leading
  // `extends`/`implements`); decorator dimension collapsed via opt(DecoratorExpr).
  [opt(DecoratorExpr), 'class', Ident, opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}'],
  [opt(DecoratorExpr), 'class', opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}'],
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
  ['...', alt([notReserved, Ident], BindingPattern)],    // ...rest | ...{ a }
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
    // NOTE: a plain parameter name is NOT reserved-guarded — `this` is a valid first
    // parameter even without an annotation (`function f(this, a)`: the implicit-any
    // `this`-param), and `this` is an always-reserved word; guarding here would reject
    // that valid form. (A truly reserved param name like `function f(while)` stays an
    // accepted over-accept; it's out of this gap's scope.)
    [Ident, ...tail],
    [BindingPattern, ...tail],
    // a rest element, by contrast, can never validly be a reserved word (`...while`),
    // and `...this` is invalid too, so guarding the rest name is FN-safe.
    ['...', alt([notReserved, Ident], BindingPattern), opt('?'), opt(':', Type)],   // rest
  );
  return [
    ['this', ':', Type],
    // optional decorators + optional parameter-property modifiers, then the binding.
    // many1 → with modifiers; the no-modifier branch also catches a param NAMED
    // like a modifier (`public: T`), which many() would otherwise eat.
    [opt(DecoratorExpr), many1(alt('public', 'private', 'protected', 'readonly')), body],
    [opt(DecoratorExpr), body],
  ];
});

const ForHead = rule($ => {
  const cTail = [';', opt(Expr, many(',', Expr)), ';', opt(Expr, many(',', Expr))];  // `; cond ; update`
  return [
    // declared head: `let/const/var/using/await using <bindings>` then C-style or in/of.
    // ForBinding gives a no-`in` initializer so `for (var a = 1 in xs)` parses.
    [alt('let', 'const', 'var', 'using', ['await', 'using']), sep(ForBinding, ','), alt(
      cTail,
      [alt('in', 'of'), Expr],
    )],
    [opt(Expr, many(',', Expr)), ...cTail],   // C-style, no declaration: `for (i=0; …; …)` / `for (;;)`
    [Expr, alt('in', 'of'), Expr],            // for-in/of, no declaration: `for (x of xs)`
  ];
});

const SwitchCase = rule($ => [
  ['case', Expr, many(',', Expr), ':'],
  ['default', ':'],
  Stmt,
]);

const Stmt = rule($ => [
  Block,
  [alt('let', 'const', 'var'), sep(Binding, ','), opt(';')],
  ['if', '(', Expr, many(',', Expr), ')', $, opt('else', $)],
  ['for', opt('await'), '(', ForHead, ')', $],
  ['while', '(', Expr, many(',', Expr), ')', $],
  ['do', $, 'while', '(', Expr, many(',', Expr), ')', opt(';')],
  ['switch', '(', Expr, many(',', Expr), ')', '{', many(SwitchCase), '}'],
  ['return', opt(Expr, many(',', Expr)), opt(';')],
  ['throw', Expr, many(',', Expr), opt(';')],
  ['break', opt(Ident), opt(';')],
  ['continue', opt(Ident), opt(';')],
  ['try', Block, opt('catch', opt('(', alt(Param, BindingPattern), ')'), Block), opt('finally', Block)],
  [Ident, ':', $],
  ';',
  ['debugger', opt(';')],
  ['with', '(', Expr, ')', $],
  [opt('await'), 'using', sep(Binding, ','), opt(';')],
  Decl,
  [Expr, many(',', Expr), opt(';')],
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
  const name = alt(Ident, 'in', 'out');  // a name may itself be a contextual variance keyword
  return [
    [many1(mod), Ident, ...tail],  // modifier soup + real-ident name: `<const in T>`, `<in T>`
    [mod, name, ...tail],          // single modifier + in/out-named param: `<in in>`, `<out out>`
    [name, ...tail],               // bare name, incl. `<in>`, `<out>`: `<T>`, `<in = any>`
  ];
});

const TypeParams = rule($ => [
  ['<', sep(TypeParam, ','), '>'],
]);

// ── Declarations ──

const InterfaceMember = rule($ => {
  const callSig = [opt(TypeParams), '(', sep(Param, ','), ')', opt(':', Type)];  // `<T>( … ): Ret`
  const propOrMethod = alt(callSig, [opt(':', Type)]);  // after a name: method | property (bare = implicit any)
  return [
    // call / construct signature (construct = call sig with a leading `new`)
    [opt('new'), ...callSig],
    // getter / setter (`get`/`set` as a member NAME falls through to the named branch)
    [alt('get', 'set'), MemberName, '(', sep(Param, ','), ')', opt(':', Type)],
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
    [opt('static'), opt('readonly'), '[', sep(Param, ','), ']', opt(':', Type)],
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
const Modifier = alt('public', 'private', 'protected', 'static', 'abstract', 'readonly', 'override', 'accessor', 'async');
const callTail = ['(', sep(Param, ','), ')', opt(':', Type), opt(Block), opt(';')] as const;
const ClassMember = rule($ => [
  DecoratorExpr,
  ['constructor', '(', sep(Param, ','), ')', Block, opt(';')],
  ['static', Block],
  [
    many(Modifier),
    alt(
      ['*', MemberName, opt('?'), opt(TypeParams), ...callTail],               // generator method
      [alt('get', 'set'), MemberName, '(', opt(sep(Param, ',')), ')', opt(':', Type), opt(Block), opt(';')],  // accessor
      ['[', Ident, ':', Type, ']', ':', Type, opt(';')],                        // index signature
      [MemberName, alt(
        [opt('?'), opt(TypeParams), ...callTail],                              // method (requires `(`)
        [opt('!'), opt('?'), opt(':', Type), opt('=', Expr), opt(';')],         // field (all-optional → catch-all)
      )],
    ),
  ],
  // Fallbacks for a member NAMED like a modifier (`static = 1`, `get = 1`, `async() {}`):
  // many(Modifier) would eat the name, so the member kind alt fails and we land here.
  [MemberName, opt('!'), opt('?'), opt(':', Type), opt('=', Expr), opt(';')],
  [MemberName, opt('?'), opt(TypeParams), '(', sep(Param, ','), ')', opt(':', Type), opt(Block), opt(';')],
]);

const EnumMember = rule($ => [
  [MemberName, opt('=', Expr)],
]);

const ImportSpecifier = rule($ => [
  [Ident, opt('as', Ident)],
]);

const ImportClause = rule($ => [
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
  [opt('async'), 'function', opt('*'), Ident, opt(TypeParams), '(', sep(Param, ','), ')', opt(':', Type), alt(Block, opt(';'))],
  ['interface', Ident, opt(TypeParams), opt('extends', sep(Type, ',')), '{', many(InterfaceMember, opt(alt(';', ','))), '}'],
  ['type', notReserved, Ident, opt(TypeParams), '=', Type, opt(';')],   // type-alias name can't be a reserved word (`type void = …`); contextual type keywords (`string`/`any`/…) stay valid
  // class decl: optional decorators + optional `abstract`. gen-tm expands the
  // opt()/many() to recover the `class Ident … { … }` shape for highlighting.
  [many(DecoratorExpr), opt('abstract'), 'class', Ident, opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}'],
  ['enum', Ident, '{', sep(EnumMember, ','), '}'],
  ['declare', 'function', opt('*'), Ident, opt(TypeParams), '(', sep(Param, ','), ')', opt(':', Type), opt(';')],
  ['declare', alt($, Stmt)],
  ['namespace', Ident, many('.', Ident), '{', many(Stmt), '}'],   // dotted name: `namespace A.B.C { … }`
  ['module', alt([Ident, many('.', Ident)], String_), '{', many(Stmt), '}'],   // `module A.B.C { … }` | `module "x" { … }`
  ['export', alt($, Stmt)],
  ['export', 'default', alt(
    [opt('async'), 'function', opt('*'), opt(Ident), opt(TypeParams), '(', sep(Param, ','), ')', opt(':', Type), alt(Block, opt(';'))],  // function
    ['abstract', 'class', Ident, opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}'],  // named abstract class
    ['abstract', 'class', opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}'],          // anonymous abstract class
    [Expr, opt(';')],   // catch-all: export default <expr>
  )],
  ['export', '*', alt(['from', String_, opt(';')], ['as', Ident, 'from', String_, opt(';')])],
  ['export', '{', sep(ImportSpecifier, ','), '}', opt('from', String_), opt(';')],
  ['export', '=', Expr, opt(';')],
  ['export', 'type', '{', sep(ImportSpecifier, ','), '}', opt('from', String_), opt(';')],
  ['const', 'enum', Ident, '{', sep(EnumMember, ','), '}'],
  ['import', alt(
    [ImportClause, 'from', String_, opt(';')],          // import X from "m"  (also `import type from "m"` = default named `type`)
    ['type', ImportClause, 'from', String_, opt(';')],  // import type X from "m"
    [Ident, '=', Expr, opt(';')],                       // import x = expr
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

  rules: {
    Type, TypeMember, DecoratorExpr, TypeofRef,
    Expr, Prop, MemberName, NewTarget, ClassHeritage,
    Stmt, Block,
    BindingProperty, BindingElement, ArrayBindingElement, BindingPattern,
    Binding, ForBinding, Param, ForHead, SwitchCase,
    TypeParams, TypeParam,
    Decl, InterfaceMember, ClassMember, EnumMember,
    ImportClause, ImportSpecifier,
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
    'keyword.control.export': jsScopes['keyword.control.export'],
    'keyword.control.from': jsScopes['keyword.control.from'],
    'storage.type': jsScopes['storage.type'],
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

  entry: Program,
});
