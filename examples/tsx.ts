// TSX grammar for Monogram — TypeScript + JSX (the `.tsx` dialect).
//
// TSX is the SUPERSET of TypeScript that adds JSX expressions. Following the
// ECMAScript-family layering (javascript.ts = base, typescript.ts = + type
// layer), this file is the SUPERSET-of-the-superset: it imports the shared
// type-free vocabulary owned by javascript.ts AND re-derives the TypeScript
// type/expression/statement layer, then EXTENDS the expression grammar with JSX
// element productions. The dependency runs base → TS → TSX only; this file adds
// JSX and changes nothing about how TypeScript itself parses.
//
// Why the TS rules are RE-DECLARED here rather than imported from typescript.ts:
// combinator rules bind their references at definition time (a rule object
// captures the exact sibling rule objects it was built with), so a JSX `Expr`
// that must reference a JSX-aware `Expr`/`Type`/`Block` cannot reuse the TS
// grammar's frozen rule objects. Each grammar therefore keeps its own rule
// consts; only the token/precedence/scope VOCABULARY (owned by javascript.ts) is
// shared. The TS layer below is a faithful copy of typescript.ts with exactly
// two JSX-driven changes, both isolated to this file:
//
//   1. The `<T>expr` prefix-cast alternative is REMOVED from Expr. In a .tsx
//      file a leading `<` at expression-start is always JSX (TS itself forbids
//      the angle-bracket cast in .tsx — you must write `expr as T`), so the cast
//      production would fight the JSX element production. (`as`/`satisfies`
//      casts are kept — they are unaffected.)
//   2. A JSXElement alternative is ADDED to Expr's NUD set (it begins with a
//      literal `<` at expression-start). Comparison `<` and generic-call `f<T>`
//      are LED forms that require a left operand, so they never fire at
//      expression-start; with the cast gone, a NUD `<` is unambiguously JSX.
//
// The `<`-disambiguation that makes this safe is the same not()/sameLine/
// lookahead machinery typescript.ts already uses for generics — see the JSX
// section. Two extra tokens (`/>` and `</`) are declared BEFORE the regex token
// so a self-closing / closing tag lexes atomically instead of being swallowed by
// a regex literal (`</div>` would otherwise scan `/div>…/` as a regex).

import {
  token, rule, defineGrammar,
  op, prefix, postfix, sameLine,
  sep, opt, many, many1, alt, exclude, not,
} from '../src/api.ts';
import {
  Shebang, JSDoc, TripleSlash, LineComment, BlockComment,
  Ident, HexNumber, OctalNumber, BinaryNumber, BigInt_,
  Number_, String_, Template, Decorator, PrivateField,
  notReserved, notReservedExpr, ecmaPrec, jsScopes,
} from './javascript.ts';

// ── JSX-specific tokens ──
// `/>` (self-closing) and `</` (close-tag open) are atomic punctuation in JSX.
// They are declared as TOKENS (not bare rule literals) and placed BEFORE the
// regex token in the `tokens` map below, so the lexer — which tries token
// matchers in declaration order — consumes them before the regex token can
// munch the `/` as the start of a regex literal. (`<` and `>` stay single-char
// punctuation, shared with comparison/generics.)
const JSXSelfClose = token(/\/>/);
const JSXClose     = token(/<\//);

// TSX-local regex token: identical to javascript.ts's `Regex_` but with `>` and
// `}` added to `divisionAfterTexts`. After a JSX tag-close `>` or an expression-
// container `}`, a following `/` begins a CLOSE/SELF-CLOSE tag (or division),
// never a regex — so `<a>{x}</a>` and `<span/>` lex correctly. This divergence
// is contained to the TSX grammar; the shared `Regex_` (used by JS/TS) is
// untouched. `</` / `/>` are matched by the dedicated tokens above anyway; this
// extra context only prevents a regex from starting after `>`/`}` in odd spots.
const Regex_ = token(/\/(?:[^\/\\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[gimsuydv]*/, {
  regex: true,
  regexContext: {
    divisionAfterTypes: ['Ident', 'Number', 'String', 'Template', 'BigInt'],
    divisionAfterTexts: [')', ']', '++', '--', 'this', 'super', 'true', 'false', 'null', 'undefined', '>', '}'],
    regexAfterTexts: ['in', 'of', 'instanceof', 'typeof', 'delete', 'void', 'await', 'yield', 'throw', 'return', 'case', 'do', 'else', 'new'],
    regexAfterParenKeywords: ['if', 'while', 'for', 'with'],
    memberAccessTexts: ['.', '?.'],
  },
});

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
    [opt('new'), ...callSig],
    [opt(alt('+', '-')), opt('readonly'), '[', alt(
      [Ident, alt(
        ['in', Type, opt('as', Type), ']', opt(alt('+', '-')), opt('?'), ':', Type],  // mapped: K in T (as U)?
        [':', Type, ']', opt(':', Type)],                                             // index:  k: T
      )],
      [Expr, ']', opt('?'), propOrMethod],                                            // computed: expr
      [']', opt(':', Type)],                                                          // empty index sig: []  /  []: T
    )],
    ['readonly', Ident, opt('?'), ':', Type],
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
    ['[', many(opt('...'), opt(Ident, opt('?'), ':'), opt('...'), $, opt('?'), opt(',')), ']'],
    ['{', many(TypeMember, opt(alt(';', ','))), '}'],
    ['asserts', Ident, opt('is', $)],
    [$, 'extends', $, '?', $, ':', $],
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

// ── JSX ──
// A JSX element is an EXPRESSION (a NUD on Expr): it begins with a literal `<`
// at expression-start. Comparison `<` (`a < b`) and generic-call `f<T>()` are
// LED forms — they need a left operand — so they never start an expression; and
// the `<T>expr` prefix cast is removed below (forbidden in .tsx). A leading `<`
// is therefore unambiguously JSX, exactly the disambiguation TS makes in a .tsx
// source file.
//
// Children are modelled as a loose run of: nested elements, `{ expr }`
// expression containers (also `{}` empty / `{...spread}`), and "word" text
// (identifiers / numbers / strings, the tokenizable share of JSX text). Raw text
// containing arbitrary punctuation (apostrophes, `!`, etc.) is out of scope — it
// is not tokenizable without a dedicated JSX text lexer mode — so such children
// are reported as unsupported rather than mis-parsed.

// A dotted / namespaced / hyphenated JSX tag name: `Foo`, `Foo.Bar.Baz`,
// `svg:rect`, `my-element` (HTML custom element). The lexer emits `data-foo` as
// `Ident '-' Ident`, so the `-`/`.`/`:` joiners are explicit segments here.
const JSXTagName = rule($ => [
  [Ident, many(alt(['.', Ident], [':', Ident], [sameLine, '-', Ident]))],
]);

// A JSX attribute value: a string literal, or an `{ expr }` container.
const JSXAttrValue = rule($ => [
  String_,
  ['{', Expr, '}'],
]);

const JSXAttr = rule($ => [
  // spread attribute `{...expr}`
  ['{', '...', Expr, '}'],
  // attribute name, optional `= value`. The name may be namespaced (`a:b`),
  // dotted, or hyphenated (`data-foo`, `aria-label`) — the `-`/`.`/`:` joiners
  // are explicit because the lexer splits `data-foo` into `Ident '-' Ident`.
  // The leading `-` joiner requires `sameLine` so it can't fuse a value across a
  // newline (it stays a binding/attr name, not a subtraction).
  [Ident, many(alt(['.', Ident], [':', Ident], [sameLine, '-', Ident])), opt('=', JSXAttrValue)],
]);

// A child expression container: `{ expr }`, `{}` (empty), or `{...expr}` (spread
// children). Comments inside are handled by the lexer's skip tokens.
const JSXContainer = rule($ => [
  ['{', opt('...'), opt(Expr), '}'],
]);

const JSXChild = rule($ => [
  JSXElement,
  JSXContainer,
  // tokenizable text words — identifiers/keywords (Ident swallows keywords) and
  // numbers. Adjacent words repeat via many() in the element body below.
  Ident,
  Number_,
  String_,
  // Common SENTENCE punctuation between words (`Hello {name}, welcome` / `Cost:
  // 5` / `Done!`). This is the tokenizable share of free JSX text — it does NOT
  // cover HTML entities (`&nbsp;`), `%`, apostrophes, or operator-like glyphs,
  // which the lexer can't tokenize as text without a dedicated JSX text mode
  // (see test/tsx-conformance.ts Corpus 3). `<`/`{`/`}` are excluded (they open
  // a nested element / expression container / close one), as is `/` (a `</`
  // close-tag opener / would re-enter regex context).
  alt(',', '.', ':', ';', '!', '?'),
]);

const JSXElement = rule($ => [
  // self-closing: `<Tag attr=… />`
  ['<', JSXTagName, opt('<', sep(Type, ','), '>'), many(JSXAttr), JSXSelfClose],
  // open + children + close: `<Tag …> children </Tag>`. The closing tag's name
  // is optional in our model (the parser does not enforce name-matching — TS
  // reports a mismatch as a semantic error, not a parse error).
  ['<', JSXTagName, opt('<', sep(Type, ','), '>'), many(JSXAttr), '>',
    many(JSXChild),
    JSXClose, opt(JSXTagName), '>'],
  // fragment: `<> children </>`
  ['<', '>', many(JSXChild), JSXClose, '>'],
]);

// ── Expressions ──

const Prop = rule($ => {
  const method = ['(', sep(Param, ','), ')', opt(':', Type), Block];   // ( … ): T { … }
  return [
    ['...', Expr],                                                     // spread
    [opt(alt('public', 'private', 'protected')), alt('get', 'set'), MemberName, '(', opt(sep(Param, ',')), ')', opt(':', Type), Block],
    [opt('async'), opt('*'), MemberName, opt(TypeParams), ...method],
    [MemberName, ':', Expr],
    ['[', Expr, many(',', Expr), ']', ':', Expr],                      // computed comma list (lenient)
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
  // JSX element — a NUD beginning with `<` (see the JSX section). Placed first so
  // a leading `<` is taken as JSX before any other interpretation.
  JSXElement,
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
  [$, '<', sep(Type, ','), '>', alt(['(', sep($, ','), ')'], Template)],
  [$, '<', sep(Type, ','), '>', not(Expr)],
  [$, '(', sep($, ','), ')'],
  [$, '.', alt(Ident, PrivateField)],
  [$, '?.', alt(Ident, PrivateField, ['(', sep($, ','), ')'], ['[', $, ']'], Template)],
  [$, '[', $, ']'],
  [$, '!'],   // TS non-null assertion
  [$, '?', $, ':', $],
  [$, 'as', Type],
  [$, 'instanceof', $],
  [$, 'in', $],
  [$, Template],
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
  [opt(DecoratorExpr), 'class', Ident, opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}'],
  [opt(DecoratorExpr), 'class', opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}'],
  // NOTE: the `['<', Type, '>', $]` prefix-cast alternative present in
  // typescript.ts is intentionally ABSENT — `<T>expr` casts are disallowed in
  // .tsx (use `expr as T`); a leading `<` is JSX (handled by the first alt).
]);

// ── Statements ──

const Block = rule($ => [
  ['{', many(Stmt), '}'],
]);

// ── Destructuring Patterns ──

const BindingProperty = rule($ => [
  [Ident, ':', BindingElement],
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

const ForBinding = rule($ => [
  [alt([notReserved, Ident, opt('!')], BindingPattern), opt(':', Type), opt('=', exclude('in', Expr))],
]);

const Param = rule($ => {
  const tail = [opt('?'), opt(':', Type), opt('=', Expr)];   // ?  : T  = E
  const body = alt(
    [Ident, ...tail],
    [BindingPattern, ...tail],
    ['...', alt([notReserved, Ident], BindingPattern), opt('?'), opt(':', Type)],   // rest
  );
  return [
    ['this', ':', Type],
    [opt(DecoratorExpr), many1(alt('public', 'private', 'protected', 'readonly')), body],
    [opt(DecoratorExpr), body],
  ];
});

const ForHead = rule($ => {
  const cTail = [';', opt(Expr, many(',', Expr)), ';', opt(Expr, many(',', Expr))];  // `; cond ; update`
  return [
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
    [opt('new'), ...callSig],
    [alt('get', 'set'), MemberName, '(', sep(Param, ','), ')', opt(':', Type)],
    [opt('static'), opt(alt('+', '-')), opt('readonly'), '[', Ident, 'in', Type, opt('as', Type), ']', opt(alt('+', '-')), opt('?'), ':', Type],
    ['readonly', MemberName, opt('?'), ':', Type],
    [MemberName, opt('?'), propOrMethod],
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
  [Ident, opt(',', alt(['{', sep(ImportSpecifier, ','), '}'], ['*', 'as', Ident]))],
  ['{', sep(ImportSpecifier, ','), '}'],
  ['*', 'as', Ident],
]);

const Decl = rule($ => [
  [opt('async'), 'function', opt('*'), Ident, opt(TypeParams), '(', sep(Param, ','), ')', opt(':', Type), alt(Block, opt(';'))],
  ['interface', Ident, opt(TypeParams), opt('extends', sep(Type, ',')), '{', many(InterfaceMember, opt(alt(';', ','))), '}'],
  ['type', notReserved, Ident, opt(TypeParams), '=', Type, opt(';')],
  [many(DecoratorExpr), opt('abstract'), 'class', Ident, opt(TypeParams), opt('extends', ClassHeritage), opt('implements', sep(Type, ',')), '{', many(ClassMember), '}'],
  ['enum', Ident, '{', sep(EnumMember, ','), '}'],
  ['declare', 'function', opt('*'), Ident, opt(TypeParams), '(', sep(Param, ','), ')', opt(':', Type), opt(';')],
  ['declare', alt($, Stmt)],
  ['namespace', Ident, many('.', Ident), '{', many(Stmt), '}'],
  ['module', alt([Ident, many('.', Ident)], String_), '{', many(Stmt), '}'],
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
    [ImportClause, 'from', String_, opt(';')],          // import X from "m"
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
  name: 'tsx',
  scopeName: 'source.tsx',

  tokens: {
    // Comments must come before the regex token. The JSX tag tokens `/>` and
    // `</` must ALSO precede the regex token so a self-closing / closing tag is
    // not swallowed as a regex literal.
    Shebang, JSDoc, TripleSlash, LineComment, BlockComment,
    JSXSelfClose, JSXClose,
    Ident, HexNumber, OctalNumber, BinaryNumber, BigInt: BigInt_,
    Number: Number_, String: String_, Template, Regex: Regex_,
    Decorator, PrivateField,
  },

  prec: ecmaPrec,

  rules: {
    Type, TypeMember, DecoratorExpr, TypeofRef,
    JSXElement, JSXTagName, JSXAttr, JSXAttrValue, JSXContainer, JSXChild,
    Expr, Prop, MemberName, NewTarget, ClassHeritage,
    Stmt, Block,
    BindingProperty, BindingElement, ArrayBindingElement, BindingPattern,
    Binding, ForBinding, Param, ForHead, SwitchCase,
    TypeParams, TypeParam,
    Decl, InterfaceMember, ClassMember, EnumMember,
    ImportClause, ImportSpecifier,
    Program,
  },

  // TSX extends the TS scope map with the JSX scope vocabulary (entity.name.tag,
  // support.class.component, entity.other.attribute-name, the tag/embedded
  // punctuation). The non-JSX entries mirror typescript.ts exactly.
  scopes: {
    'keyword.control.conditional': jsScopes['keyword.control.conditional'],
    'keyword.control.loop': jsScopes['keyword.control.loop'],
    'keyword.control.flow': jsScopes['keyword.control.flow'],
    'keyword.control.trycatch': jsScopes['keyword.control.trycatch'],
    'keyword.control': jsScopes['keyword.control'],
    'keyword.control.import': jsScopes['keyword.control.import'],
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
