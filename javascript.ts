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
  altPattern, optPattern, seq, oneOf, noneOf, range, anyChar, star, plus, repeat, notFollowedBy, start,
} from './src/api.ts';

// ── Tokens ──

// IdentifierName, ASCII + `\u`-escape forms. The `\uXXXX` / `\u{cp}` alternatives let an
// identifier (or a private `#name`) spell any character via an escape — e.g. `\u{6F}_` or
// `#\u{6F}_` — which the spec permits anywhere an IdentifierStart/Part is allowed. Non-ASCII
// *literal* identifier characters (`℘`, accented letters, ZWNJ/ZWJ, combining marks) are matched
// by the lexer's Unicode ID_Start/ID_Continue fallback instead (no /u flag is compiled here —
// YAML's token patterns use escapes that /u rejects — so \p{…} cannot live in these patterns).
const digit = range('0', '9');
const hexDigit = oneOf(digit, range('A', 'F'), range('a', 'f'));
const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), digit, '_', '$');
const lineTerminator = oneOf('\n', '\r', '\u2028', '\u2029');
const hspace = oneOf(' ', '\t');
const uEsc = altPattern(seq('\\u', repeat(hexDigit, 4, 4)), seq('\\u{', plus(hexDigit), '}'));
const identStart = altPattern(idStart, uEsc);
const identPart = altPattern(idCont, uEsc);
const numericTailGuard = notFollowedBy(oneOf(range('0', '9'), range('A', 'Z'), range('a', 'z'), '_', '$', '\\'));
const digits = seq(plus(digit), star(seq('_', plus(digit))));
const Ident        = token(seq(identStart, star(identPart)), { identifier: true });
// Numeric tokens end with `(?![0-9A-Za-z_$\\])`: the spec rule that a numeric literal
// may not be immediately followed by an IdentifierStart or DecimalDigit. Without it,
// `0b2`/`0B1102110`/`0o81010` would munch a valid prefix (`0b1`, `0B110`) and leave the
// rest as a second token, so the file parses as two statements instead of being rejected.
// With it the bad literal matches no token and the lexer throws — the correct rejection.
// (ASCII IdentifierStart + `\` for `\u`-escapes; the lexer compiles patterns without the
// /u flag so \p{L} is unavailable, and every affected conformance case is ASCII.)
// Radix literals may carry a trailing `n` BigInt suffix (`0x5an`/`0o17n`/`0b101n`); the `n` is
// only valid here (radix forms have no fractional part), so it lives on each radix token rather
// than on the decimal `BigInt_` below. The shared `(?!IdentifierStart|DecimalDigit)` tail still
// rejects a stray trailing identifier (`0x5anabc`).
const HexNumber    = token(seq('0', oneOf('x', 'X'), plus(hexDigit), star(seq('_', plus(hexDigit))), optPattern('n'), numericTailGuard), { scope: 'constant.numeric.hex' });
const OctalNumber  = token(seq('0', oneOf('o', 'O'), plus(range('0', '7')), star(seq('_', plus(range('0', '7')))), optPattern('n'), numericTailGuard), { scope: 'constant.numeric.octal' });
const BinaryNumber = token(seq('0', oneOf('b', 'B'), plus(oneOf('0', '1')), star(seq('_', plus(oneOf('0', '1')))), optPattern('n'), numericTailGuard), { scope: 'constant.numeric.binary' });
const BigInt_      = token(seq(digits, 'n', numericTailGuard), { scope: 'constant.numeric.bigint' });
// DecimalLiteral, including the leading-dot form (`.5`, `.0e1`): an integer part with optional
// fraction/exponent, OR a bare fraction `.digits` with optional exponent. Same trailing guard.
// Scope is set explicitly (not inferred from a `[0-9]`-leading pattern) because the leading-dot
// alternative makes the pattern start with `(?:` — gen-tm's decimal-numeric detector keys on a
// `[0-9]`/`\d` prefix, so without this the token would lose its `constant.numeric` scope.
const fracTail = seq('.', star(digit), star(seq('_', plus(digit))));
const expTail = seq(oneOf('e', 'E'), optPattern(oneOf('+', '-')), digits);
const Number_      = token(seq(altPattern(seq(digits, optPattern(fracTail)), seq('.', digits)), optPattern(expTail), numericTailGuard), { scope: 'constant.numeric.decimal' });
// A well-formed JS escape, used in the string-body pattern below. `\u`/`\x` must
// match their strict forms — a `\u{cp}` with cp ≤ 0x10FFFF, a 4-hex `\uXXXX`, or a
// 2-hex `\xXX` — while `\` + any *other* char (\n, \\, \q non-escape, line
// continuation) stays valid via `[^ux]`. A malformed `\u`/`\x` (e.g. `\u{110000}`,
// `\u{r}`, `\u{}`, `\u{67`) matches no escape, so the string matches no token and the
// lexer throws — TS's exact rejection. The in-range codepoint is `0*` leading zeros
// then 1–5 hex (0–0xFFFFF) or `10`+4 hex (0x100000–0x10FFFF).
const codePoint = seq(star('0'), altPattern(repeat(hexDigit, 1, 5), seq('10', repeat(hexDigit, 4, 4))));
const escape = seq('\\', altPattern(seq('u{', codePoint, '}'), seq('u', repeat(hexDigit, 4, 4)), seq('x', repeat(hexDigit, 2, 2)), noneOf('u', 'x')));
const highlightedEscape = seq('\\', altPattern(
  oneOf('n', 'r', 't', 'b', 'f', 'v', '0', "'", '"', '\\'),
  seq('x', repeat(hexDigit, 2, 2)),
  seq('u', repeat(hexDigit, 4, 4)),
  seq('u{', plus(hexDigit), '}'),
));
const String_      = token(altPattern(seq('"', star(altPattern(noneOf('"', '\\'), escape)), '"'), seq("'", star(altPattern(noneOf("'", '\\'), escape)), "'")), {
  string: true,
  escape: highlightedEscape,
});
const Template     = token(seq('`', star(altPattern(noneOf('`', '\\', '$'), seq('\\', noneOf(lineTerminator)), seq('$', notFollowedBy('{')))), '`'), {
  escape: seq('\\', altPattern(
    oneOf('n', 'r', 't', 'b', 'f', 'v', '0', "'", '"', '\\', '`', '$'),
    seq('x', repeat(hexDigit, 2, 2)),
    seq('u', repeat(hexDigit, 4, 4)),
    seq('u{', plus(hexDigit), '}'),
  )),
  // Same well-formed-escape rule as strings; the lexer rejects a malformed `\u`/`\x`
  // in an *untagged* template (`\u{110000}`, `\u{r}`), but allows it when tagged.
  escapeValid: escape,
  template: { open: '`', interpOpen: '${', interpClose: '}' },
});
const regexEscape = seq('\\', noneOf(lineTerminator));
const regexClassBody = star(altPattern(noneOf(']', '\\', '\n'), regexEscape));
const Regex_       = token(seq('/', plus(altPattern(noneOf('/', '\\', '[', '\n'), regexEscape, seq('[', regexClassBody, ']'))), '/', star(oneOf('g', 'i', 'm', 's', 'u', 'y', 'd', 'v'))), {
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
    // `!` is BOTH prefix logical-not and (in TS) postfix non-null. It is value-producing —
    // so a following `/` is division (`x! / y`) and a following template is tagged — only in
    // its postfix form (after a value); as prefix-not a following `/` is a regex (`!/re/`).
    // Resolved per-occurrence from the preceding context (the lexer/highlighter check whether
    // the `!` itself follows a value). In valid JS `!` is only ever prefix, so this is inert
    // for JS (a `!` never follows a value) — it earns its keep in the shared TS layer.
    postfixAfterValueTexts: ['!'],
  },
});
// `@name` / `@ns.name` — each dotted segment is an IdentifierName, so it admits the same
// `\u`-escape forms as `Ident` (`@℘`, `@ZW_‌_NJ`); the parser owns the `(args)` tail.
const Decorator    = token(seq('@', optPattern(seq(identStart, star(altPattern(identPart, '.'))))), { scope: 'entity.name.function.decorator' });
// PrivateIdentifier: `#` + an IdentifierName, so it admits the same `\u`-escape forms as `Ident`
// (`#\u{6F}_`). A non-ASCII literal `#name` (`#℘`, `#ZWNJ`) is handled by the lexer's Unicode
// fallback, which recognises this token's leading `#` as a name prefix.
const PrivateField = token(seq('#', identStart, star(identPart)), { scope: 'variable.other.property', identifierPrefix: '#' });
const Shebang      = token(seq(start(), '#!', star(noneOf('\n'))), { skip: true, scope: 'comment.line.shebang' });
const JSDoc        = token(seq('/**', notFollowedBy('/'), star(seq(notFollowedBy('*/'), anyChar()), { greedy: false }), '*/'), { skip: true, scope: 'comment.block.documentation', embed: 'jsdoc' });
const TripleSlash  = token(seq('///', star(hspace), '<', star(noneOf('\n'))), { skip: true, scope: 'comment.line.triple-slash' });
const LineComment  = token(seq('//', star(noneOf('\n'))), { skip: true });
const BlockComment = token(seq('/*', star(seq(notFollowedBy('*/'), anyChar()), { greedy: false }), '*/'), { skip: true });

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
// words below have NO such role: the prefix operators `void`/`typeof`/`delete` (which
// must take an operand), the `catch`/`throw` keywords, `enum`, `case` (a bare `case`
// expression let `case 1 y();` inside a switch parse as three statements), and
// `class` (a valid class expression always out-matches the bare-identifier fallback,
// so forbidding the fallback only rejects broken classes — `class extends D ;` with
// no body parsed as three statements). Forbidding the bare-identifier fallback for
// exactly these rejects `catch(x){}` with no `try`, `void ;`/`typeof ;`/`delete ;`
// (operatorless prefix op), `throw ;`, a colon-less `case`, and a body-less `class`
// — while leaving every valid expression (and TS's recovery cases) untouched.
// Verified by a zero-flip accept/reject scan over the conformance corpus; widening
// further regresses: `extends` is load-bearing for tsc's tolerated heritage shapes
// (`interface I extends { }` reads `{` as the body, `extends A extends B`,
// `extends Foo?.Bar` — all parse-accepted by tsc through the identifier fallback).
export const notReservedExpr = not(alt(
  'break', 'case', 'catch', 'class', 'continue', 'debugger', 'delete', 'do',
  'else', 'enum', 'finally', 'for', 'if', 'return', 'switch', 'throw', 'try',
  'typeof', 'void', 'while', 'with',
));

// ── Precedence ladder (shared ECMAScript operator precedence) ──

// Binding powers for the ALTERNATIVE-form LEDs (rule alternatives `[$, connector, …]`).
// The conditional sits between the assignment levels and `??` (its branches stay full
// assignment expressions); `in`/`instanceof` sit AT the relational level and left-chain
// their right operand like the ladder relationals they are.
export const jsLedPrecs = [
  { connector: '?', below: '??' },
  { connector: 'in', sameAs: '<', chainRhs: true },
  { connector: 'instanceof', sameAs: '<', chainRhs: true },
];

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
  // Non-constructor primaries: parse-clean in tsc/V8 grammar terms (runtime/checker errors).
  Number_, String_, 'true', 'false', 'null', 'undefined',
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
  // Keyword-valued literals come BEFORE the bare-identifier nud: a longest-match TIE
  // (both are one token) goes to the first-listed alternative, so listing the literals
  // first makes `this`/`true`/… arrive as $keyword leaves — the tree records what the
  // word IS instead of the bare-identifier fallback winning the tie and stamping Ident.
  'true', 'false', 'null', 'undefined', 'this', 'super',
  [notReservedExpr, Ident],
  Number_,
  String_,
  Template,
  Regex_,
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
  // async arrow with a BARE parameter: `async err => …` (ES2017). `async` and the
  // parameter must share a line (`async\nx => …` is `async;` then a plain arrow —
  // the spec's [no LineTerminator here] between async and the binding identifier).
  ['async', sameLine, Ident, '=>', alt($, Block)],
  [Ident, '=>', alt($, Block)],
  ['yield', alt(['*', $], [opt($)])],   // yield e | yield* e (delegate) | yield
  ['(', $, many(',', $), ')'],
  ['import', alt(['(', $, ')'], ['.', 'meta'])],
  PrivateField,
  HexNumber, OctalNumber, BinaryNumber, BigInt_,
  [opt('async'), 'function', opt('*'), opt(Ident), '(', sep(Param, ','), ')', Block],
  // named vs anonymous kept separate (greedy opt(Ident) would eat a leading
  // `extends`); decorator dimension collapsed via opt(DecoratorExpr).
  [opt(DecoratorExpr), 'class', Ident, many('extends', sep(alt([not('extends'), ClassHeritage]), ',')), '{', many(ClassMember), '}'],
  [opt(DecoratorExpr), 'class', many('extends', sep(alt([not('extends'), ClassHeritage]), ',')), '{', many(ClassMember), '}'],
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
    ['...', alt([notReserved, Ident], BindingPattern), opt('=', Expr)],   // rest (an initializer is a CHECKER error in tsc, not a parse error)
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
  [alt('let', 'const', 'var'), sep(Binding, ','), opt(';')],
  ['if', '(', Expr, many(',', Expr), ')', $, opt('else', $)],
  ['for', opt('await'), '(', ForHead, ')', $],
  ['while', '(', Expr, many(',', Expr), ')', $],
  ['do', $, 'while', '(', Expr, many(',', Expr), ')', opt(';')],
  ['switch', '(', Expr, many(',', Expr), ')', '{', many(SwitchCase), '}'],
  ['return', opt(Expr, many(',', Expr)), opt(';')],
  ['throw', Expr, many(',', Expr), opt(';')],
  // The label is a RESTRICTED production (`break [no LineTerminator here] Label`)
  // and a label can't be a reserved word — without both, `break` ⏎ `case "X":`
  // inside a switch eats `case` as the label and the whole switch cascades.
  ['break', opt(sameLine, notReserved, Ident), opt(';')],
  ['continue', opt(sameLine, notReserved, Ident), opt(';')],
  ['try', Block, opt('catch', opt('(', alt(Param, BindingPattern), ')'), Block), opt('finally', Block)],
  [Ident, ':', $],
  ';',
  ['debugger', opt(';')],
  ['with', '(', Expr, ')', $],
  [opt('await'), 'using', sep(Binding, ','), opt(';')],
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
  [not(alt('function', 'class', ['async', 'function'])), Expr, many(',', Expr), opt(';')],
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
// modifier only when NOT followed by name-making tokens (see typescript.ts)
const Modifier = alt([alt('static', 'accessor', 'async'), not(alt('(', '=', '{', '}'))]);
const callTail = ['(', sep(Param, ','), ')', opt(Block), opt(';')] as const;
const ClassMember = rule($ => [
  ';',   // SemicolonClassElement: `class C { ; }`
  ['constructor', '(', sep(Param, ','), ')', Block, opt(';')],
  [many(DecoratorExpr), many(Modifier), 'static', Block],   // decorated/modified static block parses (both SEMANTIC errors)
  // decorators PREFIX a member, before any modifier (see typescript.ts)
  [
    many(DecoratorExpr),
    many(Modifier),
    alt(
      ['*', MemberName, ...callTail],                                          // generator method
      [alt('get', 'set'), MemberName, '(', opt(sep(Param, ',')), ')', opt(Block), opt(';')],  // accessor
      [MemberName, alt(
        [...callTail],                                                         // method (requires `(`)
        // field catch-all; a ';'-less field must not be followed by a same-line
        // decorator (see typescript.ts)
        [opt('=', Expr), alt([';'], [not(sameLine)], [not(not('}'))])],
      )],
    ),
  ],
  // Fallbacks for a member NAMED like a modifier (`static = 1`, `get = 1`, `async() {}`):
  // many(Modifier) would eat the name, so the member kind alt fails and we land here.
  [MemberName, opt('=', Expr), alt([';'], [not(sameLine)], [not(not('}'))])],
  [MemberName, '(', sep(Param, ','), ')', opt(Block), opt(';')],
]);

const ImportSpecifier = rule($ => [
  [Ident, opt('as', Ident)],
  // arbitrary module namespace identifier (ES2022): `import { "str" as x }` — the
  // string form requires the rename (the local binding must be an identifier).
  [String_, 'as', Ident],
]);

// Export specifiers are WIDER than import ones: a ModuleExportName (identifier or
// string) is valid on BOTH sides and may stand alone (`export { x as "s" }`,
// `export { "a" as "b" } from "m"`).
const ExportSpecifier = rule($ => [
  [alt(Ident, String_), opt('as', alt(Ident, String_))],
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
  [many(DecoratorExpr), 'class', Ident, many('extends', sep(alt([not('extends'), ClassHeritage]), ',')), '{', many(ClassMember), '}'],
  ['export', alt($, Stmt)],
  [many1(DecoratorExpr), $],   // decorators before export/default/etc.
  ['export', 'default', alt(
    [opt('async'), 'function', opt('*'), opt(Ident), '(', sep(Param, ','), ')', Block],  // function
    [Expr, opt(';')],   // catch-all: export default <expr>
  )],
  ['export', '*', alt(['from', String_, opt(';')], ['as', Ident, 'from', String_, opt(';')])],
  ['export', '{', sep(ExportSpecifier, ','), '}', opt('from', String_), opt(';')],
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

// Repository-key NAMING CONSTRAINT (官方命名「限制器」) — the SHARED ECMAScript half. For Monogram's
// source.js to be a repository-level DROP-IN for VS Code's official JavaScript grammar (and for the
// shared half of source.ts), the official repository KEY NAMES that external grammars `#include`
// (`source.js#qstring-double`, `#comment`, `#punctuation-comma`, …) must be the names Monogram
// NATIVELY emits. Monogram derives those keys under its OWN structural names (`#string-double`,
// `#linecomment`/`#blockcomment`, `#scope-punctuation-separator-comma`, …), so this maps each
// OFFICIAL name → the structural key(s) gen-tm derived for the SAME construct; gen-tm projects the
// repository through it at generation time, emitting the canonical name NATIVELY (a STRING value
// RENAMES the structural key — its old name ceases to exist — and rewrites every `#…` reference; an
// ARRAY value SYNTHESISES the `{patterns:[…]}` union the official grammar itself writes, resolving
// each member through the 1:1 renames first and dropping members absent from this grammar). It is
// PURELY a naming projection — no `match`/`begin`/`name` changes — so emitted tokenization is
// byte-for-byte unchanged (verified: test/repo-compat.ts + the byte-identical scope-array diff). The
// NAMES are ECMAScript DATA and belong here (the grammar definition may know JS — it already carries
// `jsScopes`); gen-tm only looks them up + substitutes, so the engine stays language-agnostic.
//
// This file OWNS the shared ECMAScript vocabulary, so it owns these shared canonical names too;
// typescript.ts imports + spreads this map and adds its TS-only entries (type-parameters, casts,
// type-object, return-type, …). Every entry here was verified 1:1 against the official JavaScript
// grammar (same construct + same emitted scope) — see the per-construct audit. Official names that
// ALREADY name a real Monogram key (`expression`, `template`) are omitted (gen-tm never clobbers an
// existing key). Deliberately NOT mapped: `null-literal`/`undefined-literal` (Monogram folds
// `null`+`undefined` into ONE `constant.language.null` key — official splits them, so neither is a
// clean 1:1) and `numericConstant-literal` (NaN/Infinity — Monogram has no such key).
export const jsBaseCanonical: Record<string, string | string[]> = {
  // 1:1 — RENAME the structural key (and every reference) to the official name.
  type: 'type-inner',
  'qstring-double': 'string-double',
  'qstring-single': 'string-single',
  'punctuation-comma': 'scope-punctuation-separator-comma',
  'punctuation-semicolon': 'scope-punctuation-terminator-statement',
  'punctuation-accessor': 'scope-punctuation-accessor',
  regex: 'regex-literal',
  'new-expr': 'new-expression',
  'parameter-name': 'declaration-param-name',
  directives: 'tripleslash',
  'this-literal': 'scope-variable-language-this',
  'super-literal': 'scope-variable-language-super',
  // Unions (official wrapper keys): members keep their structural names but are resolved through the
  // 1:1 renames above first — e.g. `tripleslash` → `directives`, `string-double` → `qstring-double`.
  comment: ['jsdoc', 'tripleslash', 'linecomment', 'blockcomment'],
  string: ['string-single', 'string-double', 'template'],
  'boolean-literal': ['scope-constant-language-boolean-true', 'scope-constant-language-boolean-false'],
  'numeric-literal': ['hexnumber', 'binarynumber', 'octalnumber', 'number', 'bigint'],
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
  ledPrec: jsLedPrecs,

  rules: {
    DecoratorExpr,
    Expr, Prop, MemberName, NewTarget, ClassHeritage,
    Stmt, Block,
    BindingProperty, BindingElement, ArrayBindingElement, BindingPattern,
    Binding, ForBinding, Param, ForHead, SwitchCase,
    Decl, ClassMember,
    ImportClause, ImportSpecifier, ExportSpecifier,
    Program,
  },

  scopes: jsScopes,
  canonicalRepoNames: jsBaseCanonical,

  entry: Program,
  // The expression rule — lets gen-tm derive a `#expression` sub-grammar (used by
  // expression-only embeds like Vue's `{{ }}`, where statements are invalid).
  expression: Expr,
});
