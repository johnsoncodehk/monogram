import {
  token, rule, defineGrammar,
  left, right, none,
  op, prefix, postfix, sameLine,
  sep, opt, many, many1, alt, exclude, not,
} from '../src/api.ts';

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
    // shorthand (Ident only): x | x = v | x? | x?: v
    [Ident, alt(['=', Expr], ['?', opt(':', Expr)], [])],
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
  // `enum` is reserved — it can't be a standalone expression identifier. Without this
  // an invalid `enum E { a: 1 }` (where the enum Decl fails on `:`) would fall back to
  // parsing `enum` as an identifier expr + `E` + `{…}` block, wrongly accepting it.
  [not('enum'), Ident],
  Number_,
  String_,
  Template,
  Regex_,
  'true', 'false', 'null', 'undefined', 'this', 'super',
  [$, op, $],
  [prefix, $],
  [$, postfix],
  ['...', $],
  // instantiation / typed call / tagged template: f<T> | f<T>(…) | f<T>`…`
  // A bare instantiation `f<T>` (no call/tag) only when the next token can't
  // start an expression — otherwise `<`/`>` were comparisons (`f < a, b > 7`):
  // the same disambiguation TS makes via canFollowTypeArgumentsInExpression.
  [$, '<', sep(Type, ','), '>', alt(['(', sep($, ','), ')'], Template, not(Expr))],
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
  [Ident, alt(['=', Expr], [':', BindingElement], [])],  // a | a = 1 | a: elem
  [alt(String_, Number_, ['[', Expr, ']']), ':', BindingElement],  // "s"/0/[e]: elem
  ['...', alt(Ident, BindingPattern)],                   // ...rest | ...{ a }
]);

const BindingElement = rule($ => [
  [alt(Ident, BindingPattern), opt('=', Expr)],          // a | { a }  (optionally = default)
]);

const ArrayBindingElement = rule($ => [
  BindingElement,
  ['...', alt(Ident, BindingPattern)],                   // [...rest] | [...{ a }]
]);

const BindingPattern = rule($ => [
  ['{', sep(BindingProperty, ','), '}'],                  // { a, b: c, ...rest }
  ['[', opt(ArrayBindingElement), many(',', opt(ArrayBindingElement)), ']'],  // [a, , b, ...rest]
]);

// ── Bindings & Parameters ──

const Binding = rule($ => [
  [alt([Ident, opt('!')], BindingPattern), opt(':', Type), opt('=', Expr)],
]);

// A binding in a for-head: identical to Binding except the initializer is a
// no-`in` expression, so `for (var a = 1 in xs)` reads `a = 1` then the for-in
// `in` (TS's [~In] grammar), rather than greedily parsing `1 in xs`.
const ForBinding = rule($ => [
  [alt([Ident, opt('!')], BindingPattern), opt(':', Type), opt('=', exclude('in', Expr))],
]);

const Param = rule($ => {
  const tail = [opt('?'), opt(':', Type), opt('=', Expr)];   // ?  : T  = E
  const body = alt(
    [Ident, ...tail],
    [BindingPattern, ...tail],
    ['...', alt(Ident, BindingPattern), opt('?'), opt(':', Type)],   // rest
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
  ['type', Ident, opt(TypeParams), '=', Type, opt(';')],
  // class decl: optional decorators + optional `abstract`. gen-tm expands the
  // opt()/many() to recover the `class Ident … { … }` shape for highlighting.
  [many(DecoratorExpr), opt('abstract'), 'class', Ident, opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}'],
  ['enum', Ident, '{', sep(EnumMember, ','), '}'],
  ['declare', 'function', opt('*'), Ident, opt(TypeParams), '(', sep(Param, ','), ')', opt(':', Type), opt(';')],
  ['declare', alt($, Stmt)],
  ['namespace', Ident, '{', many(Stmt), '}'],
  ['module', alt(String_, Ident), '{', many(Stmt), '}'],
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

  prec: [
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
    right('**'),
    right(prefix('!', '~', '+', '-', 'typeof', 'void', 'delete', 'await', 'yield')),
    right(prefix('++', '--')),
    left(postfix('++', '--')),
  ],

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
    'storage.type.interface': ['interface'],
    'storage.type.type': ['type'],
    'storage.type.enum': ['enum'],
    'storage.type.namespace': ['namespace', 'module'],
    'storage.modifier': [
      'public', 'private', 'protected',
      'static', 'readonly', 'abstract', 'override', 'declare', 'async', 'accessor',
    ],
    'storage.type.property': ['get', 'set'],
    'keyword.other.extends': ['extends', 'implements'],
    'keyword.operator.expression': ['typeof', 'keyof', 'instanceof', 'as', 'new', 'delete', 'void', 'is', 'satisfies', 'asserts', 'infer'],
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
    'support.type.primitive': ['string', 'number', 'boolean', 'object', 'symbol', 'bigint', 'any', 'unknown', 'never', 'void'],
    'support.class': ['Promise', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'RegExp', 'Date', 'Object', 'Function', 'Symbol'],
    'support.variable': ['console', 'window', 'document', 'process', 'module', 'require', 'exports', 'global', 'globalThis'],
    'support.variable.property': ['.length', '.prototype', '.constructor'],
  },

  entry: Program,
});
