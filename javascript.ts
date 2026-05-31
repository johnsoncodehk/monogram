// JavaScript grammar for Monogram — the STANDALONE BASE of the ECMAScript family.
//
// JavaScript is the syntactic SUBSET of TypeScript (TS = JS + a type layer), so
// this file owns the shared, type-free ECMAScript *vocabulary* — the token set,
// the `notReserved`/`notReservedExpr` reserved-word guards, the precedence ladder
// (`ecmaPrec`), and the JS scope map (`jsScopes`) — and exports it. The TS grammar
// (the sibling superset file) then imports that vocabulary and EXTENDS it with the
// type layer. The dependency runs subset → superset only: this file imports nothing
// from the TS grammar (it has no type knowledge) and must stand alone — its only
// import is the engine's combinator API.
//
// The rules are NOT shared either direction: combinator rules bind their
// references at definition time, so a JS rule must reference the OTHER JS rule
// consts — it can't reuse TS's rule objects (and vice-versa). Each file therefore
// keeps its own rule consts; only the vocabulary above is shared.
//
// This grammar is the TS grammar with every type construct removed: no type
// annotations, type parameters/arguments, `interface`/`type`/`enum`/`namespace`/
// `declare`/`module`-as-type declarations, `as`/`satisfies`/`<T>`-cast/non-null
// (`!`) expressions, and no type-optional `?` on params/members. Everything that
// is real JavaScript is kept: functions/arrows/classes (static, async, accessor,
// get/set, generators, private `#x`, static blocks), the full expression and
// operator set (`??`, `?.`, `**`, optional chaining), destructuring, template
// literals (tagged + interpolated), regex, every module import/export VALUE form,
// control flow, numeric literals, and Stage-3 decorators on classes.

import {
  token, rule, defineGrammar,
  left, right, none, noUnaryLhs,
  op, prefix, postfix, sameLine,
  sep, opt, many, many1, alt, exclude, not,
} from './src/api.ts';

// ── Tokens ──

const Ident        = token(/(?:[a-zA-Z_$]|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\})(?:[a-zA-Z0-9_$]|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\})*/, { identifier: true });
// Numeric tokens end with `(?![0-9A-Za-z_$\\])`: the spec rule that a numeric literal
// may not be immediately followed by an IdentifierStart or DecimalDigit. Without it,
// `0b2`/`0B1102110`/`0o81010` would munch a valid prefix (`0b1`, `0B110`) and leave the
// rest as a second token, so the file parses as two statements instead of being rejected.
// With it the bad literal matches no token and the lexer throws — the correct rejection.
// (ASCII IdentifierStart + `\` for `\u`-escapes; the lexer compiles patterns without the
// /u flag so \p{L} is unavailable, and every affected conformance case is ASCII.)
const HexNumber    = token(/0[xX][0-9a-fA-F]+(_[0-9a-fA-F]+)*(?![0-9A-Za-z_$\\])/,            { scope: 'constant.numeric.hex' });
const OctalNumber  = token(/0[oO][0-7]+(_[0-7]+)*(?![0-9A-Za-z_$\\])/,                         { scope: 'constant.numeric.octal' });
const BinaryNumber = token(/0[bB][01]+(_[01]+)*(?![0-9A-Za-z_$\\])/,                            { scope: 'constant.numeric.binary' });
const BigInt_      = token(/[0-9]+(_[0-9]+)*n(?![0-9A-Za-z_$\\])/,                              { scope: 'constant.numeric.bigint' });
const Number_      = token(/[0-9]+(_[0-9]+)*(?:\.[0-9]*(_[0-9]+)*)?(?:[eE][+-]?[0-9]+(_[0-9]+)*)?(?![0-9A-Za-z_$\\])/);
// A well-formed JS escape, used in the string-body pattern below. `\u`/`\x` must
// match their strict forms — a `\u{cp}` with cp ≤ 0x10FFFF, a 4-hex `\uXXXX`, or a
// 2-hex `\xXX` — while `\` + any *other* char (\n, \\, \q non-escape, line
// continuation) stays valid via `[^ux]`. A malformed `\u`/`\x` (e.g. `\u{110000}`,
// `\u{r}`, `\u{}`, `\u{67`) matches no escape, so the string matches no token and the
// lexer throws — TS's exact rejection. The in-range codepoint is `0*` leading zeros
// then 1–5 hex (0–0xFFFFF) or `10`+4 hex (0x100000–0x10FFFF).
const codePoint = String.raw`0*(?:[0-9a-fA-F]{1,5}|10[0-9a-fA-F]{4})`;
const escape    = String.raw`\\(?:u\{${codePoint}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[^ux])`;
const String_      = token(new RegExp(`"(?:[^"\\\\]|${escape})*"|'(?:[^'\\\\]|${escape})*'`), {
  string: true,
  escape: /\\(?:[nrtbfv0'"\\]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]+\})/,
});
const Template     = token(/`(?:[^`\\$]|\\.|\$(?!\{))*`/, {
  escape: /\\(?:[nrtbfv0'"\\`$]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]+\})/,
  // Same well-formed-escape rule as strings; the lexer rejects a malformed `\u`/`\x`
  // in an *untagged* template (`\u{110000}`, `\u{r}`), but allows it when tagged.
  escapeValid: new RegExp(escape),
  template: { open: '`', interpOpen: '${', interpClose: '}' },
});
const Regex_       = token(/\/(?:[^\/\\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[gimsuydv]*/, {
  regex: true,
  regexContext: {
    divisionAfterTypes: ['Ident', 'Number', 'String', 'Template', 'BigInt'],
    divisionAfterTexts: [')', ']', '++', '--', 'this', 'super', 'true', 'false', 'null', 'undefined'],
    regexAfterTexts: ['in', 'of', 'instanceof', 'typeof', 'delete', 'void', 'await', 'yield', 'throw', 'return', 'case', 'do', 'else', 'new'],
    // `kw ( … )` heads (control-flow): the closing `)` is a statement head, not a
    // value, so `if (a) /re/` parses `/re/` as a regex rather than division.
    regexAfterParenKeywords: ['if', 'while', 'for', 'with'],
    // member accessors: after one, those keywords are property NAMES, so
    // `obj.for(x) / y` stays a method call + division.
    memberAccessTexts: ['.', '?.'],
  },
});
const Decorator    = token(/@(?:[a-zA-Z_$][a-zA-Z0-9_$.]*)?/,                { scope: 'entity.name.function.decorator' });
const PrivateField = token(/#[a-zA-Z_$][a-zA-Z0-9_$]*/,                     { scope: 'variable.other.property' });
const Shebang      = token(/^#![^\n]*/,           { skip: true, scope: 'comment.line.shebang' });
const JSDoc        = token(/\/\*\*(?!\/)[\s\S]*?\*\//,  { skip: true, scope: 'comment.block.documentation', embed: 'jsdoc' });
const TripleSlash  = token(/\/\/\/\s*<[^\n]*/,    { skip: true, scope: 'comment.line.triple-slash' });
const LineComment  = token(/\/\/[^\n]*/,           { skip: true });
const BlockComment = token(/\/\*[\s\S]*?\*\//,     { skip: true });

// The token consts, reserved-word guards, precedence ladder, and scope map are
// pure ECMAScript vocabulary — no rule wiring — so the TS grammar imports them from
// here and extends them rather than duplicating them.
export {
  Shebang, JSDoc, TripleSlash, LineComment, BlockComment,
  Ident, HexNumber, OctalNumber, BinaryNumber, BigInt_,
  Number_, String_, Template, Regex_, Decorator, PrivateField,
};

// ── Always-reserved words ──
// The `Ident` token deliberately swallows keywords (they lex as identifiers), so
// every keyword can otherwise fall back to a bare identifier. These words are
// reserved in EVERY context (ECMAScript ReservedWord ∪ TS's always-reserved), so
// they are valid as an identifier NOWHERE — not as an expression, a shorthand
// property, or a binding name. `notReserved` is a zero-width guard placed before an
// identifier position to forbid exactly these. Excluded on purpose: contextual
// keywords (as/async/from/type/of/…) and strict-mode-only reserved words
// (let/static/implements/yield/await/…) — those ARE valid identifiers in some
// context a CFG can't detect (sloppy mode, non-generator/non-async), so forbidding
// them here would reject valid code (`var let = 1`, `function f(yield) {}`).
export const notReserved = not(alt(
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
));

// A NARROWER guard for the *expression* identifier-NUD only. The full `notReserved`
// set can NOT be used at expression position: most always-reserved words legitimately
// begin an expression via their own dedicated forms (`new`/`new.target`, `class`/
// `function` expressions, `import(…)`/`import<T>`, `super`, `this`, `true`/`false`/
// `null`, …), and TS's own error-recovery tolerates several reserved words sliding into
// the bare-identifier fallback inside otherwise-valid files (e.g. `export default …`,
// undeclared `for (x in …)`, `class … extends (e)`, a decorator before `export`). The
// words below have NO such role: they are the prefix operators `void`/`typeof`/`delete`
// (which must take an operand) plus the `catch`/`throw` keywords and `enum`. Forbidding
// the bare-identifier fallback for exactly these rejects `catch(x){}` with no `try`,
// `void ;`/`typeof ;`/`delete ;` (operatorless prefix op), and `throw ;` — while leaving
// every valid expression (and TS's recovery cases) untouched. Verified: widening this
// set to other reserved words regresses valid code; these five are the FN-safe maximum.
export const notReservedExpr = not(alt(
  'catch', 'delete', 'enum', 'throw', 'typeof', 'void',
));

// ── Precedence ladder (shared ECMAScript operator precedence) ──

export const ecmaPrec = [
  right('=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^='),
  right('??=', '||=', '&&='),
  left('??'),
  left('||'),
  left('&&'),
  left('|'),
  left('^'),
  left('&'),
  none('==', '!=', '===', '!=='),
  none('<', '>', '<=', '>='),
  left('<<', '>>', '>>>'),
  left('+', '-'),
  left('*', '/', '%'),
  right(noUnaryLhs('**')),   // `-x ** y` is a syntax error: a unary-prefix expr can't be a `**` LHS
  right(prefix('!', '~', '+', '-', 'typeof', 'void', 'delete', 'await', 'yield')),
  right(prefix('++', '--')),
  left(postfix('++', '--')),
];

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

// ── Scope map ──
// The JS scope map: scopes every real-JS token. The TS grammar imports this and
// extends it with the type-only scope keys (storage.type.interface/type/enum/
// namespace, the keyof/as/satisfies/is/infer/asserts keyword.operator.expression
// entries, support.type.primitive) — those names are plain identifiers in JS, not
// types, so they are deliberately absent here.
export const jsScopes = {
  'keyword.control.conditional': ['if', 'else'],
  'keyword.control.switch': ['switch', 'case', 'default'],
  'keyword.control.loop': ['for', 'while', 'do', 'in', 'of', 'break', 'continue'],
  'keyword.control.flow': ['return', 'await', 'yield'],
  'keyword.control.trycatch': ['try', 'catch', 'finally', 'throw'],
  'keyword.control': ['debugger', 'with'],
  'keyword.control.import': ['import'],
  'keyword.control.export': ['export'],
  'keyword.control.from': ['from'],
  'storage.type': ['let', 'const', 'var', 'using'],
  // `const` also carries this marker subtype — a no-op for the keyword's own color
  // (`storage.type` wins, being declared first), but it tells the highlighter generator
  // that a `const` binding names a CONSTANT. See gen-tm's const-binding rule.
  'storage.type.const': ['const'],
  'storage.type.function': ['function', 'constructor'],
  'storage.type.class': ['class'],
  'storage.modifier': ['static', 'async', 'accessor'],
  'storage.type.property': ['get', 'set'],
  'keyword.other.extends': ['extends'],
  'keyword.operator.expression': ['instanceof', 'new', 'delete', 'void', 'typeof'],
  'keyword.operator.assignment': ['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '??=', '||=', '&&='],
  'keyword.operator.comparison': ['==', '!=', '===', '!=='],
  'keyword.operator.relational': ['<', '>', '<=', '>='],
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
  'constant.language.boolean.true': ['true'],
  'constant.language.boolean.false': ['false'],
  'constant.language.null': ['null', 'undefined'],
  'variable.language.this': ['this'],
  'variable.language.super': ['super'],
  'support.class': ['Promise', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'RegExp', 'Date', 'Object', 'Function', 'Symbol'],
  'support.variable': ['console', 'window', 'document', 'process', 'module', 'require', 'exports', 'global', 'globalThis'],
  'support.variable.property': ['.length', '.prototype', '.constructor'],
};

// ── Grammar ──

export default defineGrammar({
  name: 'javascript',
  scopeName: 'source.js',

  tokens: {
    // Comments must come before Regex_ to avoid /** ... */ being matched as regex
    Shebang, JSDoc, TripleSlash, LineComment, BlockComment,
    Ident, HexNumber, OctalNumber, BinaryNumber, BigInt: BigInt_,
    Number: Number_, String: String_, Template, Regex: Regex_,
    Decorator, PrivateField,
  },

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

  scopes: jsScopes,

  entry: Program,
  // The expression rule — lets gen-tm derive a `#expression` sub-grammar (used by
  // expression-only embeds like Vue's `{{ }}`, where statements are invalid).
  expression: Expr,
});
