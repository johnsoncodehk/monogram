// JavaScript grammar for Monogram.
//
// JavaScript is a syntactic subset of TypeScript, so this grammar is the TS
// grammar (examples/typescript.ts) with every type construct removed: no type
// annotations, type parameters/arguments, `interface`/`type`/`enum`/`namespace`/
// `declare`/`module`-as-type declarations, `as`/`satisfies`/`<T>`-cast/non-null
// (`!`) expressions, and no type-optional `?` on params/members. Everything that
// is real JavaScript is kept: functions/arrows/classes (static, async, accessor,
// get/set, generators, private `#x`, static blocks), the full expression and
// operator set (`??`, `?.`, `**`, optional chaining), destructuring, template
// literals (tagged + interpolated), regex, every module import/export VALUE form,
// control flow, numeric literals, and Stage-3 decorators on classes.
//
// The type-free *vocabulary* (tokens, the precedence ladder) is imported from
// typescript.ts rather than duplicated; the rules are copied and stripped here
// because combinator rules bind their references at definition time — a JS rule
// must reference the OTHER JS rule consts, so it can't reuse the TS rule objects.

import {
  rule, defineGrammar,
  left, right, none, noUnaryLhs,
  op, prefix, postfix, sameLine,
  sep, opt, many, many1, alt, exclude, not,
} from '../src/api.ts';
import {
  ecmaTokens, ecmaPrec,
  Ident, HexNumber, OctalNumber, BinaryNumber, BigInt_,
  Number_, String_, Template, Regex_, Decorator, PrivateField,
  notReserved, notReservedExpr,
} from './typescript.ts';

// ── Decorators ──
// Stage-3 / JS-real decorators: `@dec` and `@dec(args)`. The TS-only
// `@dec<T>(args)` type-argument form is dropped.

const DecoratorExpr = rule($ => [
  [Decorator, opt('(', sep(Expr, ','), ')')],   // @dec | @dec(args)
]);

// ── Expressions ──

const Prop = rule($ => {
  const method = ['(', sep(Param, ','), ')', Block];   // ( … ) { … }
  return [
    ['...', Expr],                                                     // spread
    // accessor (get/set)
    [alt('get', 'set'), MemberName, '(', opt(sep(Param, ',')), ')', Block],
    // method: async?/generator?, any member name (incl `#x`, computed `[e]`), then ( … ) { … }
    [opt('async'), opt('*'), MemberName, ...method],
    // value property — any member name incl computed `[e]: v` (MemberName covers `[Expr]`)
    [MemberName, ':', Expr],
    ['[', Expr, many(',', Expr), ']', ':', Expr],                      // computed comma list (lenient)
    // shorthand (Ident only): x | x = v — a reserved word here is invalid
    // (`var v = { class }`); a reserved word as a property KEY (`{ class: 1 }`) is fine,
    // already handled by the `[MemberName, ':', Expr]` branch above.
    [notReserved, Ident, alt(['=', Expr], [])],
  ];
});

const ClassHeritage = rule($ => [
  Ident,
  [$, '.', Ident],
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
  // with no `try`, `void ;`, and `throw ;` are rejected as TS does.
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
  [$, '(', sep($, ','), ')'],
  [$, '.', alt(Ident, PrivateField)],
  // optional chaining: ?.x | ?.#x | ?.(args) | ?.[i] | ?.`…`
  [$, '?.', alt(Ident, PrivateField, ['(', sep($, ','), ')'], ['[', $, ']'], Template)],
  [$, '[', $, ']'],
  [$, '?', $, ':', $],
  [$, 'instanceof', $],
  [$, 'in', $],
  [$, Template],
  // new T | new T(args)
  ['new', NewTarget, opt('(', sep($, ','), ')')],
  ['new', 'class', Ident, opt('extends', ClassHeritage), '{', many(ClassMember), '}', opt('(', sep($, ','), ')')],
  ['new', 'class', opt('extends', ClassHeritage), '{', many(ClassMember), '}', opt('(', sep($, ','), ')')],
  ['[', many(opt($), ','), opt($), ']'],
  ['{', sep(Prop, ','), '}'],
  [opt('async'), '(', sep(Param, ','), ')', '=>', alt($, Block)],
  [Ident, '=>', alt($, Block)],
  ['yield', alt(['*', $], [opt($)])],   // yield e | yield* e (delegate) | yield
  ['(', $, many(',', $), ')'],
  ['import', alt(['(', $, ')'], ['.', 'meta'])],
  PrivateField,
  HexNumber, OctalNumber, BinaryNumber, BigInt_,
  [opt('async'), 'function', opt('*'), opt(Ident), '(', sep(Param, ','), ')', Block],
  // named vs anonymous kept separate (greedy opt(Ident) would eat a leading
  // `extends`); decorator dimension collapsed via opt(DecoratorExpr).
  [opt(DecoratorExpr), 'class', Ident, opt('extends', ClassHeritage), '{', many(ClassMember), '}'],
  [opt(DecoratorExpr), 'class', opt('extends', ClassHeritage), '{', many(ClassMember), '}'],
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
  [alt([notReserved, Ident], BindingPattern), opt('=', Expr)],
]);

// A binding in a for-head: identical to Binding except the initializer is a
// no-`in` expression, so `for (var a = 1 in xs)` reads `a = 1` then the for-in
// `in` (TS's [~In] grammar), rather than greedily parsing `1 in xs`.
const ForBinding = rule($ => [
  [alt([notReserved, Ident], BindingPattern), opt('=', exclude('in', Expr))],
]);

const Param = rule($ => {
  const body = alt(
    [Ident, opt('=', Expr)],
    [BindingPattern, opt('=', Expr)],
    // a rest element can never validly be a reserved word (`...while`), so guarding it is FN-safe.
    ['...', alt([notReserved, Ident], BindingPattern)],   // rest
  );
  return [
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

// ── Declarations ──

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
// (generator/accessor before the MemberName method/field split).
const Modifier = alt('static', 'accessor', 'async');
const callTail = ['(', sep(Param, ','), ')', opt(Block), opt(';')] as const;
const ClassMember = rule($ => [
  DecoratorExpr,
  ['constructor', '(', sep(Param, ','), ')', Block, opt(';')],
  ['static', Block],
  [
    many(Modifier),
    alt(
      ['*', MemberName, ...callTail],                                          // generator method
      [alt('get', 'set'), MemberName, '(', opt(sep(Param, ',')), ')', opt(Block), opt(';')],  // accessor
      [MemberName, alt(
        [...callTail],                                                         // method (requires `(`)
        [opt('=', Expr), opt(';')],                                            // field (all-optional → catch-all)
      )],
    ),
  ],
  // Fallbacks for a member NAMED like a modifier (`static = 1`, `get = 1`, `async() {}`):
  // many(Modifier) would eat the name, so the member kind alt fails and we land here.
  [MemberName, opt('=', Expr), opt(';')],
  [MemberName, '(', sep(Param, ','), ')', opt(Block), opt(';')],
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
  [opt('async'), 'function', opt('*'), Ident, '(', sep(Param, ','), ')', Block],
  // class decl: optional decorators. gen-tm expands the opt()/many() to recover
  // the `class Ident … { … }` shape for highlighting.
  [many(DecoratorExpr), 'class', Ident, opt('extends', ClassHeritage), '{', many(ClassMember), '}'],
  ['export', alt($, Stmt)],
  ['export', 'default', alt(
    [opt('async'), 'function', opt('*'), opt(Ident), '(', sep(Param, ','), ')', Block],  // function
    [Expr, opt(';')],   // catch-all: export default <expr>
  )],
  ['export', '*', alt(['from', String_, opt(';')], ['as', Ident, 'from', String_, opt(';')])],
  ['export', '{', sep(ImportSpecifier, ','), '}', opt('from', String_), opt(';')],
  ['import', alt(
    [ImportClause, 'from', String_, opt(';')],          // import X from "m"
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
  name: 'javascript',
  scopeName: 'source.js',

  tokens: ecmaTokens,

  prec: ecmaPrec,

  rules: {
    DecoratorExpr,
    Expr, Prop, MemberName, NewTarget, ClassHeritage,
    Stmt, Block,
    BindingProperty, BindingElement, ArrayBindingElement, BindingPattern,
    Binding, ForBinding, Param, ForHead, SwitchCase,
    Decl, ClassMember,
    ImportClause, ImportSpecifier,
    Program,
  },

  // JS subset of ecmaScopes: dropped storage.type.interface/type/enum/namespace,
  // the type-operator keyword.operator.expression entries (keyof/as/satisfies/is/
  // infer/asserts), and support.type.primitive (those names are plain identifiers
  // in JS, not types). Kept everything that scopes real JS tokens.
  scopes: {
    'keyword.control.conditional': ['if', 'else', 'switch', 'case', 'default'],
    'keyword.control.loop': ['for', 'while', 'do', 'in', 'of'],
    'keyword.control.flow': ['return', 'break', 'continue', 'await', 'yield'],
    'keyword.control.trycatch': ['try', 'catch', 'finally', 'throw'],
    'keyword.control': ['debugger', 'with'],
    'keyword.control.import': ['import', 'export', 'from'],
    'storage.type': ['let', 'const', 'var', 'using'],
    'storage.type.function': ['function', 'constructor'],
    'storage.type.class': ['class'],
    'storage.modifier': ['static', 'async', 'accessor'],
    'storage.type.property': ['get', 'set'],
    'keyword.other.extends': ['extends'],
    'keyword.operator.expression': ['instanceof', 'new', 'delete', 'void', 'typeof'],
    'keyword.operator.assignment': ['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '??=', '||=', '&&='],
    'keyword.operator.comparison': ['==', '!=', '===', '!=='],
    'keyword.operator.logical': ['||', '&&', '??'],
    'keyword.operator.arithmetic': ['+', '-', '*', '/', '%', '**'],
    'keyword.operator.increment-decrement': ['++', '--'],
    'keyword.operator.logical.prefix': ['!', '~'],
    'keyword.operator.bitwise': ['|', '&', '^'],
    'keyword.operator.bitwise.shift': ['<<', '>>', '>>>'],
    'storage.type.function.arrow': ['=>'],
    'punctuation.bracket.round': ['(', ')'],
    'punctuation.bracket.curly': ['{', '}'],
    'punctuation.bracket.square': ['[', ']'],
    'punctuation.accessor': ['.'],
    'punctuation.accessor.optional': ['?.'],
    'punctuation.terminator.statement': [';'],
    'punctuation.separator.comma': [','],
    'constant.language.boolean': ['true', 'false'],
    'constant.language.null': ['null', 'undefined'],
    'variable.language': ['this', 'super'],
    'support.class': ['Promise', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'RegExp', 'Date', 'Object', 'Function', 'Symbol'],
    'support.variable': ['console', 'window', 'document', 'process', 'module', 'require', 'exports', 'global', 'globalThis'],
    'support.variable.property': ['.length', '.prototype', '.constructor'],
  },

  entry: Program,
});
