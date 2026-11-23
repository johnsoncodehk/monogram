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
  left, right, none, noUnaryLhs, lhsTarget, prefixTarget, postfixTarget,
  op, prefix, postfix, sameLine,
  sep, opt, many, many1, alt, exclude, not, reservableNot, capExpr, tsRelax, arm, field,
  awaitCtx, yieldCtx, asyncGenCtx, resetCtx,
  altPattern, optPattern, seq, oneOf, noneOf, range, anyChar, star, plus, repeat, notFollowedBy, start,
} from './src/api.ts';

// Build the four async×generator arms of a `function` form, routing each arm's params
// and body to its [Await]/[Yield] family: plain resets to none, generator -> yield,
// async -> await, async-generator -> both. `nameParts` is spread in after `function`
// (and `*` for the generator arms); `body` is the function body element. `async` and
// `function` share a line (`async [no LineTerminator here] function`): after a line break
// `async` is an identifier and `function` begins the next statement. Param/Block
// resolve at thunk-eval time (defined below), so this is safe to call inside a rule().
function fnArms(nameParts, body) {
  return [
    arm('function_', 'function', ...nameParts, '(', sep(field('parameter', Param), ','), ')', resetCtx(field('body', body))),
    arm('generator', 'function', field('asterisk', '*'), ...nameParts, '(', sep(yieldCtx(field('parameter', Param)), ','), ')', yieldCtx(field('body', body))),
    arm('asyncFunction', field('asyncKeyword', 'async'), sameLine, 'function', ...nameParts, '(', sep(awaitCtx(field('parameter', Param)), ','), ')', awaitCtx(field('body', body))),
    arm('asyncGenerator', field('asyncKeyword', 'async'), sameLine, 'function', field('asterisk', '*'), ...nameParts, '(', sep(asyncGenCtx(field('parameter', Param)), ','), ')', asyncGenCtx(field('body', body))),
  ];
}

// How a statement ends (ECMAScript 12.10, Automatic Semicolon Insertion; tsc's parseSemicolon):
// a `;`, or nothing when the next token is on a later line, is `}`, or is the end of the input
// (`not(sameLine)` holds there too). A same-line token can not end it, so two statements on one
// line need a `;` between them. A statement or declaration that ends in a block needs nothing.
// The one definition, for both grammars: TypeScript's declarations and members end this way too.
export const asi = () => alt([';'], [not(sameLine)], [not(not('}'))]);

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
// A decimal integer part is a single `0` or a `[1-9]`-led run — a leading `0` followed by
// a digit (legacy octal `0123`, leading-zero decimal `09`) is NOT a decimal literal: with
// intPart='0', the trailing digit trips numericTailGuard so the token fails to match and
// the lexer rejects it (tsc's scanner behavior). fracTail/expTail/BigInt keep `digits`
// (leading zeros legal there: `0.012`, `1e007`, `0n`).
const intPart = altPattern('0', seq(range('1', '9'), star(digit), star(seq('_', plus(digit)))));
const Number_      = token(seq(altPattern(seq(intPart, optPattern(fracTail)), seq('.', digits)), optPattern(expTail), numericTailGuard), { scope: 'constant.numeric.decimal' });
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
const regexClassBody = star(altPattern(noneOf(']', '\\', lineTerminator), regexEscape));
// RegularExpressionChar; the FIRST char additionally excludes `*` (RegularExpressionFirstChar)
// so `/*` is never a regex start — it is a block-comment open, and an unterminated `/* … /`
// is a lexical error, NOT a regex literal. (A `*` anywhere after the first char stays legal:
// `/a*/`.) Body is one-or-more total, so `//` remains a LineComment as before.
const regexChar      = altPattern(noneOf('/', '\\', '[', lineTerminator), regexEscape, seq('[', regexClassBody, ']'));
const regexFirstChar = altPattern(noneOf('/', '\\', '[', '*', lineTerminator), regexEscape, seq('[', regexClassBody, ']'));
const Regex_       = token(seq('/', regexFirstChar, star(regexChar), '/', star(identPart)), {   // flags: maximal-munch any IdentifierPart run (tsc lexes flags leniently; validity is a checker rule)
  regex: true,
  regexContext: {
    divisionAfterTypes: ['Ident', 'Number', 'String', 'Template', 'BigInt', 'PrivateField'],
    divisionAfterTexts: [')', ']', '++', '--', 'this', 'super', 'true', 'false', 'null', 'undefined'],
    regexAfterTexts: ['in', 'of', 'instanceof', 'typeof', 'delete', 'void', 'await', 'yield', 'throw', 'return', 'case', 'do', 'else', 'new', 'default'],
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
const Shebang      = token(seq(start(), '#!', star(noneOf(lineTerminator))), { skip: true, scope: 'comment.line.shebang' });
const JSDoc        = token(seq('/**', notFollowedBy('/'), star(seq(notFollowedBy('*/'), anyChar()), { greedy: false }), '*/'), { skip: true, scope: 'comment.block.documentation', embed: 'jsdoc' });
const TripleSlash  = token(seq('///', star(hspace), '<', star(noneOf(lineTerminator))), { skip: true, scope: 'comment.line.triple-slash' });
// SingleLineCommentChar / HashbangComment: any character but a LineTerminator (LF, CR, LS, PS).
const LineComment  = token(seq('//', star(noneOf(lineTerminator))), { skip: true });
const BlockComment = token(seq('/*', star(seq(notFollowedBy('*/'), anyChar()), { greedy: false }), '*/'), { skip: true });

// The token consts, reserved-word guards, precedence ladder, and scope map are
// pure ECMAScript vocabulary — no rule wiring — so the TS grammar imports them from
// here and extends them rather than duplicating them.
export {
  Shebang, JSDoc, TripleSlash, LineComment, BlockComment,
  Ident, HexNumber, OctalNumber, BinaryNumber, BigInt_,
  Number_, String_, Template, Regex_, Decorator, PrivateField,
};

// Where a statement may not be an expression statement (14.5, `ExpressionStatement : [lookahead ∉
// { {, function, async [no LineTerminator here] function, class, let [ }] Expression ;`): there
// `{` begins a block, `function` / `async function` / `class` a declaration, and `let [` a lexical
// declaration, so what an expression would read beyond them (`{}.x`, `class C {}.name`) is the
// next statement or no statement. A decorator begins a declaration too: the decorators proposal
// (ecma262 PR #2417) gives ClassDeclaration and ClassExpression the same `DecoratorList?` and adds
// `@` to the like lookahead of `export default`, and tsc's parseStatement routes `@` to
// parseDeclaration. Both grammars' expression statement is this one arm; an expression elsewhere
// (`({}).x`, `f({}.x)`, `x = @dec class {}`) is not restricted.
export const expressionStatement = (Expr) => [
  not(alt('{', 'function', 'class', Decorator)), not(alt(['async', sameLine, 'function'], ['let', '['])),
  field('first', Expr), many(field('comma', ','), field('rest', Expr)), asi(),
];
// An arrow's body (`ConciseBody : [lookahead ≠ {] ExpressionBody | { FunctionBody }`): after `=>`
// a `{` begins the function body, never an object literal, so `() => { b() {} }.x` has no parse.
export const conciseBody = (Block, Expr) => alt(arm('block', Block), arm('expression', not('{'), Expr));
// `export Declaration` / `export VariableStatement` (16.2.3 ExportDeclaration): what follows
// `export` is a declaration, never another statement, so `export if (x) {}`, `export x;`,
// `export ;` have no parse and `export { a }` is the export list, not `export` and a block. A
// declaration is `Decl` (`$`) or one of the statements that declare (`var` / `let` / `const`, and
// in TypeScript `using`, which tsc's parser takes there; `declarationWords`).
export const exportDeclaration = ($, Stmt, declarationWords) =>
  arm('exportDeclaration', field('exportKeyword', 'export'), field('declaration', alt(arm('decl', field('decl', $)), arm('variable', not(not(alt(...declarationWords))), field('stmt', Stmt)))));
// A module specifier and its import attributes (16.2.2 `FromClause : from ModuleSpecifier`,
// `WithClause : with { } | with { WithEntries ,opt }`, `WithEntries : AttributeKey : StringLiteral`,
// `AttributeKey : IdentifierName | StringLiteral`): the specifier and every attribute value are
// string literals (`import x from y`, `with { type: 1 }` have no parse), and nothing restricts a
// line break before `with`. tsc's parser takes any expression for both, the legacy `assert` for
// `with`, and no `with` past a line break (docs/CORRECTNESS.md).
// tree-sitter renders no attributes: after a specifier, `with` would also begin a `with`
// statement past an inserted `;`, which a CFG without lookahead cannot tell apart.
const withEntry = (rest = '') => [field(`attributeKey${rest}`, alt(Ident, String_)), ':', field(`attributeValue${rest}`, String_)];
export const moduleSpecifier = [field('source', String_), tsRelax(opt(field('withKeyword', 'with'), '{', opt(...withEntry(), many(',', ...withEntry('Rest')), opt(',')), field('attributesClose', '}')), [])];

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
// NOT reservable: tsc's PARSER accepts await/yield (and let/static/…) as binding
// identifiers even inside an async/generator body — the "reserved word" rule there is
// a CHECKER diagnostic, not a parse error (`async function f(){ let await = 1 }`,
// `function* g(){ function yield(){} }` both parse). The [Await]/[Yield] reservation
// that IS a parse error lives at expression position (notReservedExpr), where `await`
// must be the operator and so needs an operand.
export const reservedWords = [
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
];
export const notReserved = not(alt(...reservedWords));

// A BindingIdentifier: the name a binding introduces (a parameter, a variable, a destructured
// or rest name) is an identifier that is not a reserved word. This is the one definition every
// binding position spreads in; tsc's parser decides it once too (parseBindingIdentifier, which
// takes an identifier or any keyword after LastReservedWord, in every context), so contextual
// and strict-mode-only words stay names (`function f(yield, let, of) {}`).
export const bindingIdentifier = [notReserved, Ident];
// The same, as a function's or class's name: the child `name`.
export const bindingName = [notReserved, field('name', Ident)];

// ── The `for` statement (14.7.4 ForStatement, 14.7.5 ForInOfStatement) ──
// Both grammars build their ForBinding, ForHead and ForAwaitHead rules and their `for` statement
// from these, each with its own rules (TypeScript adds a binding's type annotation).
//
// A declaration in a head: `var`, `let` or `const` (ForBinding, a VariableDeclaration or
// LexicalBinding), or `using` / `await using` (explicit resource management, ForDeclaration[+Using]),
// then its bindings. A binding's initializer is Initializer[~In], so in `for (var a = 1 in xs)` the
// `in` is the head's. A `using` binding is a BindingIdentifier (ForBinding[~Pattern]), so `for (using
// [a] of b)` loops over `using[a]`, and there is no `using` for-in (that arm's ForDeclaration is
// [~Using]). `for (using of of …)` has no parse tree: the `using` declaration is suppressed by the
// spec's `[lookahead ≠ using of]` and `using` as an identifier then fails, so the guard is that
// triple; `for (using of ;…)` (a binding named `of`) and `for (await using of of …)` stay valid.
export const forBindingArms = (BindingPattern, Expr, annotation = []) => [
  [field('name', alt(bindingIdentifier, BindingPattern)), ...annotation, opt('=', exclude('in', field('value', Expr)))],
];
// `tails` are what may follow the first binding of a `var` / `let` / `const` declaration and of a
// `using` one: both grammars' heads parse it once and then branch.
const forDeclaration = (ForBinding, tails, usingTails) => alt(
  [field('kind', alt('let', 'const', 'var')), field('binding', ForBinding), field('tail', alt(...tails))],
  [not(['using', 'of', 'of']), field('kind', alt('using', ['await', 'using'])), not(alt('[', '{')), field('binding', ForBinding), field('tail', alt(...usingTails))],
);
// The head inside `for ( … )`:
// - `for ( [lookahead ≠ let [] Expression[~In]opt ; Expression opt ; Expression opt )` and the
//   declared C-style head: a first expression or initializer reads no `in` operator, so `for (a =
//   b in c;;)` has no parse (each comma operand is its own [~In] Pratt call);
// - `for ( [lookahead ≠ let [] LeftHandSideExpression in Expression )`: the left side reads no `in`
//   either, so the `in` is the head's (`for (key in obj)`); the object is a full Expression;
// - `for ( [lookahead ∉ { let, async of }] LeftHandSideExpression of AssignmentExpression )`: no
//   comma after `of`; `for (async of => {};;)` is a C-style head;
// - a declaration before `in` / `of` has one binding.
export const forHeadArms = (Expr, ForBinding) => {
  const cTail = [';', opt(field('condition', Expr), many(field('conditionComma', ','), field('conditionRest', Expr))), ';', opt(field('increment', Expr), many(field('incrementComma', ','), field('incrementRest', Expr)))];   // `; cond ; update`
  const cStyle = arm('classic', many(field('bindingComma', ','), field('bindingRest', ForBinding)), ...cTail);
  const forIn = arm('in_', 'in', field('right', Expr), many(field('rightComma', ','), field('rightRest', Expr))), forOf = arm('of', 'of', field('right', Expr));
  return [
    arm('declaration', forDeclaration(ForBinding, [cStyle, forIn, forOf], [cStyle, forOf])),
    arm('classic', not(['let', '[']), opt(exclude('in', field('initializer', Expr)), many(field('initializerComma', ','), exclude('in', field('initializerRest', Expr)))), ...cTail),
    arm('in_', not(['let', '[']), exclude('in', field('left', Expr)), 'in', field('right', Expr), many(field('rightComma', ','), field('rightRest', Expr))),
    arm('of', not(alt('let', ['async', 'of'])), exclude('in', field('left', Expr)), 'of', field('right', Expr)),
  ];
};
// The head inside `for await ( … )`: only the `of` forms, and its left side's lookahead is
// `[lookahead ≠ let]` alone, so `for await (async of x)` is a loop over `x`.
export const forAwaitHeadArms = (Expr, ForBinding) => [
  arm('declaration', forDeclaration(ForBinding, [arm('of', 'of', field('right', Expr))], [arm('of', 'of', field('right', Expr))])),
  arm('of', not('let'), exclude('in', field('left', Expr)), 'of', field('right', Expr)),
];
export const forStatement = ($, ForHead, ForAwaitHead) =>
  ['for', alt(['(', field('head', ForHead), ')'], [field('awaitKeyword', 'await'), '(', field('head', ForAwaitHead), ')']), field('body', $)];

// The guard of the *expression* identifier (IdentifierReference, and an arrow's lone
// BindingIdentifier): `Identifier : IdentifierName but not ReservedWord`, so no reserved word is
// one. A reserved word with no expression form of its own is no expression (`in;`, `x =
// default`, `f(export)`, `const;`, `void ;`, a colon-less `case`, `x = var`); one that begins an
// expression of its own (`this`, `true` / `false` / `null`, `super.x`, `new X`) is that
// expression's arm alone, never also an identifier (no tie for declaration order to decide) and
// never an arrow's parameter (`true => 1`, `this => 1`, `super => 1`). `undefined` is no reserved
// word: an ordinary identifier. Reservable: it also refuses the context's operator words
// (`await` / `yield`). TypeScript's guard leaves `import` out: `import` with no or a spread
// argument (`import()`, `import(...a)`) is read through this fallback, as tsc's parser does in
// files it accepts. Owed: that `import` is tsc-parser tolerance, not the productions.
export const notReservedExpr = reservableNot(alt(...reservedWords.filter((w) => w !== 'import')));
// JavaScript's: `import` is an expression only as ImportCall and `import.meta` (13.3.10
// `ImportCall : import ( AssignmentExpression ,opt ) | import ( AssignmentExpression ,
// AssignmentExpression ,opt )`), so `import()`, `import(a, b, c)` and `import(...a)` have no parse.
const notReservedJsExpr = reservableNot(alt(...reservedWords));

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
  // Assignment operators require a LeftHandSideExpression target (ECMAScript
  // AssignmentTargetType): `-x = 1`, `++x = 1`, `x++ = 1` are syntax errors; `x = 1`,
  // `x.y = 1`, `(x++) = 1` (a parenthesized cover) are fine.
  right(lhsTarget('=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=')),
  right(lhsTarget('??=', '||=', '&&=')),
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
  right(prefix('!', '~', '+', '-', 'typeof', 'void', 'delete', 'await')),
  // prefix `++`/`--` (update prefixes): the spec operand is a UnaryExpression
  // (`UpdateExpression : ++ UnaryExpression`) whose AssignmentTargetType must be simple — an
  // early error, like `a + b = c`, enforced by the same target check: `++-x`, `++x++`,
  // `++ ++x` reject (tsc reads the operand as a LeftHandSideExpression).
  right(prefixTarget('++', '--')),
  // postfix `++`/`--` operand IS a LeftHandSideExpression in the grammar
  // (`UpdateExpression : LeftHandSideExpression [no LT] ++`), so `++x++`, `x++ ++` are genuine
  // PRODUCTION-violations (operand `++x`/`x++` is an UpdateExpression, not a LHS) — no parse
  // tree exists, so the CST producer correctly rejects them. (Asymmetric with the prefix above
  // by the grammar's own slot types: prefix operand = UnaryExpression, postfix operand = LHS.)
  left(postfixTarget('++', '--')),
];

// ── Decorators ──
// Stage-3 / JS-real decorators: `@dec` and `@dec(args)`. The TS-only
// `@dec<T>(args)` type-argument form is dropped.

const DecoratorExpr = rule($ => [
  [Decorator, opt('(', sep(Expr, ','), ')')],   // @dec | @dec(args)
]);

// ── Expressions ──

const Prop = rule($ => {
  // ( … ) { … }, params+body routed to a [Await]/[Yield] family (see memTail); the
  // MemberName stays outside it (a computed key inherits the enclosing context).
  const propTail = (ctx) => [field('paren', '('), sep(ctx(field('parameter', Param)), ','), ')', ctx(field('body', Block))];
  return [
    arm('spread', '...', field('argument', Expr)),
    // accessor (get/set) — get/set bodies are plain (reset)
    arm('accessor', field('kind', alt('get', 'set')), field('key', MemberName), field('paren', '('), opt(sep(resetCtx(field('parameter', Param)), ',')), ')', resetCtx(field('body', Block))),
    // method, 4-way split on async × generator (each routes params+body to its family)
    arm('asyncGeneratorMethod', 'async', '*', field('key', MemberName), ...propTail(asyncGenCtx)),
    arm('asyncMethod', 'async', field('key', MemberName), ...propTail(awaitCtx)),
    arm('generatorMethod', '*', field('key', MemberName), ...propTail(yieldCtx)),
    arm('method', field('key', MemberName), ...propTail(resetCtx)),
    // value property — any member name incl computed `[e]: v` (MemberName covers `[Expr]`)
    arm('init', field('key', MemberName), ':', field('value', Expr)),
    // computed comma list (lenient): `[a, b]: v`. One expression in the brackets is the
    // value property above (`[e]` is a MemberName), so the list has at least one comma.
    arm('computedList', '[', Expr, many1(',', Expr), ']', ':', Expr),
    // shorthand (Ident only): x | x = v — a reserved word here is invalid
    // (`var v = { class }`); a reserved word as a property KEY (`{ class: 1 }`) is fine,
    // already handled by the `[MemberName, ':', Expr]` branch above.
    arm('shorthand', notReserved, field('name', Ident), field('initializer', alt(arm('assign', '=', field('value', Expr)), arm('none')))),
  ];
});

// A class heritage (`extends LeftHandSideExpression`) and a `new` callee (a MemberExpression)
// are ECMAScript productions, so their forms are stated here once and TypeScript's rules are
// built from them. A rule binds the rules it names when it is defined, so each grammar builds
// its own rule from these arms with its own `Expr` (and passes the forms its type layer adds).
//
// Heritage: `extends` takes a LeftHandSideExpression (15.7 `ClassHeritage : extends
// LeftHandSideExpression`), not an operator expression: a NewExpression or a CallExpression or an
// OptionalExpression. A NewExpression is a MemberExpression or `new NewExpression`, which is the
// grammar's `new` callee rule (`NewTarget`: every primary expression but a class expression,
// `super.x`, `new.target`, `import.meta`, the member and tagged-template forms, and `new` with or
// without Arguments: `extends function(){}`, `extends new B`, `extends [].x`, `extends {}`); a
// class expression (`classExpression`, which carries the grammar's own class body) is the rule's
// own arm, as it is the expression rule's. After it come the call tail and, past a call, the
// member, optional-chain and tagged-template tails (`extends f().x`, `extends a?.b`). A literal
// base parses; rejecting it is a checker's job. An arrow, a conditional or a binary operator
// is no LeftHandSideExpression (`extends a ? b : c {}` has no parse).
export const classHeritageArms = ($, Expr, NewTarget, classExpression, typeArgs = []) => [
  NewTarget,
  classExpression,
  [$, '.', alt(Ident, PrivateField)],
  [$, '?.', alt(Ident, PrivateField, ['(', sep(Expr, ','), ')'], ['[', Expr, ']'], Template)],
  [$, '[', Expr, ']'],
  ...typeArgs,
  [$, '(', sep(Expr, ','), ')'],
  [$, Template],
];

// The callee of `new` is a MemberExpression, never a CallExpression (`new a.b()` constructs
// `a.b`), so it has its own rule: Expr's call LED must not reach it. A template is part of it
// twice over — `PrimaryExpression : TemplateLiteral` and `MemberExpression : MemberExpression
// TemplateLiteral` — so in `new tag`x`()` the tagged template is the callee and `( )` are the
// `new` Arguments. A `new` with its Arguments is a MemberExpression too (`MemberExpression :
// new MemberExpression Arguments`), and one without is a NewExpression, so `new new Foo()()` and
// `new new Foo` chain: `newArgs` is the inner `new`'s optional Arguments, `taggedTemplate` any
// further tagged-template form of the grammar.
//
// The other MemberExpression forms (ECMA-262 13.3), each as the expression NUD / LED writes it:
// - PrimaryExpression: `this`, the literals (`new null()` and `new 1` are syntax; that they throw is
//   run time), an identifier that is not a reserved word (`identGuard`, the expression NUD's: `new
//   if()` has no derivation, and `new this` is ThisExpression, not an identifier), array and
//   object literals (`Prop`, the grammar's property rule), function expressions (`fnExprArms`, the
//   grammar's four forms), a template, a parenthesised expression. A class expression is the
//   expression rule's own `new class …` arms.
// - SuperProperty (`new super.x()`, `new super[x]`), MetaProperty (`new new.target()`, `new
//   import.meta.x()`), and the member forms, a private name included (`new X.#f()`).
export const newTargetArms = ($, Expr, newArgs, { identGuard, Prop, fnExprArms, taggedTemplate = [] }) => [
  'true', 'false', 'null', 'this',
  arm('ident', identGuard, Ident),
  Number_, HexNumber, OctalNumber, BinaryNumber, BigInt_, String_, Regex_,
  arm('superMember', field('superKeyword', 'super'), alt(['.', Ident], ['[', Expr, ']'])),
  arm('newDotTarget', field('newKeyword', 'new'), '.', field('targetKeyword', 'target')),
  arm('importMeta', 'import', '.', 'meta'),
  ['new', not('<'), $, newArgs],
  Template,
  arm('array', field('bracket', '['), opt(field('element', Expr)), many(field('comma', ','), opt(field('elementRest', Expr))), ']'),
  arm('object', '{', sep(field('property', Prop), ','), '}'),
  ...fnExprArms,
  [$, '.', alt(Ident, PrivateField)],
  [$, '[', Expr, ']'],
  [$, Template],
  ...taggedTemplate,
  ['(', field('first', Expr), many(field('comma', ','), field('rest', Expr)), ')'],
];

const ClassHeritage = rule($ => classHeritageArms($, Expr, NewTarget,
  ['class', opt(...bindingName), opt('extends', field('superClass', $)), field('bodyOpen', '{'), many(field('member', ClassMember)), field('bodyClose', '}')]));

const NewTarget = rule($ => newTargetArms($, Expr, opt('(', sep(Expr, ','), ')'),
  { identGuard: notReservedJsExpr, Prop, fnExprArms: fnArms([opt(...bindingName)], Block) }));

const Expr = rule($ => [
  // The keyword-valued literals and `this` (reserved words, so the identifier below refuses
  // them: each is its own arm alone).
  'true', 'false', 'null', 'this',
  // `super` is a CONSTRAINED primary (mirrors tsc's parseSuperExpression): MUST be
  // immediately followed by a call `(args)`, member `.name`/`.#priv`, or element `[expr]`.
  [field('superKeyword', 'super'), alt(['(', sep($, ','), ')'], ['.', alt(Ident, PrivateField)], ['[', $, ']'])],
  // A standalone identifier expression (IdentifierReference): never a reserved word (see
  // notReservedExpr), so `catch(x){}` with no `try`, `void ;` and `throw ;` are no expression.
  [notReservedJsExpr, Ident],
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
  [$, '(', sep($, ','), ')'],
  [$, '.', alt(Ident, PrivateField)],
  // optional chaining: ?.x | ?.#x | ?.(args) | ?.[i] | ?.`…`. A private member `?.#x` IS
  // valid current ECMAScript (V8 + Babel accept it; tsc's lone parse rejection is a bug being
  // removed in TS#60263) — so PrivateField stays. The CST producer models the syntax; it does
  // not adjudicate tsc-only restrictions.
  [$, '?.', alt(Ident, PrivateField, ['(', sep($, ','), ')'], ['[', $, ']'], Template)],
  [$, '[', $, ']'],
  [$, '?', field('then', $), ':', field('otherwise', $)],
  [$, 'instanceof', $],
  [$, 'in', $],
  [$, Template],
  // `new.target` meta-property — the only `new` form not followed by a target; matched by a
  // dedicated arm (NOT the bare identifier nud, which excludes `new`) so a failed `new T` arm
  // can't slide `new` in as an Ident (`new <T>Foo()` → the comparison `(new < T) > Foo()`).
  arm('newDotTarget', field('newKeyword', 'new'), '.', field('targetKeyword', 'target')),
  // new T | new T(args). An optional chain may NOT follow a bare `new` (no Arguments): a
  // NewExpression is not a valid `?.` base, so `new a?.b` / `new class{}?.x` have no parse tree
  // (tsc + V8 + babel all reject). `not('?.')` guards the no-call exit; `new a()?.b` chains via
  // the outer `?.` LED unchanged.
  arm('construct', 'new', not('<'), NewTarget, alt(['(', sep($, ','), ')'], not('?.'))),
  arm('newNamedClass', 'new', field('classKeyword', 'class'), ...bindingName, opt('extends', field('superClass', ClassHeritage)), field('bodyOpen', '{'), many(field('member', ClassMember)), field('bodyClose', '}'), field('newArguments', alt(arm('paren', '(', sep(field('argument', $), ','), ')'), arm('none', not('?.'))))),
  arm('newAnonymousClass', 'new', field('classKeyword', 'class'), opt('extends', field('superClass', ClassHeritage)), field('bodyOpen', '{'), many(field('member', ClassMember)), field('bodyClose', '}'), field('newArguments', alt(arm('paren', '(', sep(field('argument', $), ','), ')'), arm('none', not('?.'))))),
  // array literal `[a, , ...b,]`: an element or a hole, then `,` and an element or a hole, the
  // ArrayBindingPattern's form. Each element is parsed once: `many(opt($), ','), opt($)` parsed
  // the last one in the repetition, found no `,`, and parsed it again (twice per nesting level).
  arm('array', field('bracket', '['), opt(field('element', $)), many(field('comma', ','), opt(field('elementRest', $))), ']'),
  arm('object', '{', sep(field('property', Prop), ','), '}'),
  // Arrow functions, async/non-async SPLIT so the [Await] grammar parameter can route
  // each arm's params + body to the right rule family (await-yield-fork.ts): an async
  // arrow's params and body are await-context (`async (a = await) =>` rejects — await
  // needs an operand), a plain arrow's body resets to none.
  // capExpr('?'): an ArrowFunction is the LOWEST-precedence AssignmentExpression — it can be
  // neither the operand of a binary/logical/conditional operator nor an assignment target, so
  // each arm is capped BELOW the conditional `?`: it parses only at an assignment-or-looser
  // minBp and, once parsed, admits no led (`() => {} || a` rejects, NOT `(() => {}) || a`). A
  // `||`/`?:` INSIDE an expression body (`() => a || b`) is unaffected — parsed by the body `$`.
  // The body is a ConciseBody (`conciseBody`): `() => {}` is a block body, not an object literal
  // that absorbs a trailing `|| a` / `.x`, also where the block does not parse.
  arm('asyncArrow', capExpr('?', field('asyncKeyword', 'async'), '(', sep(awaitCtx(field('parameter', Param)), ','), ')', field('arrow', '=>'), awaitCtx(field('body', conciseBody(Block, $))))),
  arm('arrow', capExpr('?', '(', sep(field('parameter', Param), ','), ')', field('arrow', '=>'), resetCtx(field('body', conciseBody(Block, $))))),
  // async arrow with a BARE parameter: `async err => …` (ES2017). `async` and the
  // parameter must share a line (`async\nx => …` is `async;` then a plain arrow —
  // the spec's [no LineTerminator here] between async and the binding identifier).
  arm('asyncArrowIdentifier', capExpr('?', field('asyncKeyword', 'async'), sameLine, awaitCtx(notReservedJsExpr, field('parameter', Ident)), field('arrow', '=>'), awaitCtx(field('body', conciseBody(Block, $))))),
  arm('arrowIdentifier', capExpr('?', notReservedJsExpr, field('parameter', Ident), field('arrow', '=>'), resetCtx(field('body', conciseBody(Block, $))))),
  ['yield', alt(['*', $], [opt($)])],   // yield e | yield* e (delegate) | yield
  ['(', field('first', $), many(field('comma', ','), field('rest', $)), ')'],
  // ImportCall: one or two AssignmentExpressions, no spread (the `...` arm is Arguments'), and ImportMeta
  arm('import_', field('importKeyword', 'import'), field('form', alt(arm('call', '(', not('...'), field('source', $), opt(',', opt(not('...'), field('options', $), opt(','))), ')'), arm('meta', '.', field('metaKeyword', 'meta'))))),
  PrivateField,
  HexNumber, OctalNumber, BinaryNumber, BigInt_,
  // function expression, 4-way split on async × generator (see fnArms).
  ...fnArms([opt(...bindingName)], Block),
  // named vs anonymous kept separate (greedy opt(Ident) would eat a leading
  // `extends`). A ClassExpression takes a DecoratorList, as a ClassDeclaration does: any number
  // of decorators (`x = @a @b class {}`).
  arm('namedClass', many(field('decorator', DecoratorExpr)), 'class', ...bindingName, opt('extends', field('superClass', ClassHeritage)), field('bodyOpen', '{'), many(field('member', ClassMember)), field('bodyClose', '}')),
  arm('anonymousClass', many(field('decorator', DecoratorExpr)), 'class', opt('extends', field('superClass', ClassHeritage)), field('bodyOpen', '{'), many(field('member', ClassMember)), field('bodyClose', '}')),
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
  arm('pair', field('key', alt(String_, Number_, arm('computed', field('bracket', '['), field('expr', Expr), field('bracketClose', ']')))), ':', field('value', BindingElement)),  // "s"/0/[e]: elem
  arm('rest', field('ellipsis', '...'), field('argument', alt(bindingIdentifier, BindingPattern))),    // ...rest | ...{ a }
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
  [field('name', alt(bindingIdentifier, BindingPattern)), opt('=', field('value', Expr))],
]);

// A binding in a for-head (`forBindingArms`): Binding with a no-`in` initializer.
const ForBinding = rule($ => forBindingArms(BindingPattern, Expr));

// A parameter (FormalParameter) is a binding element: its name is a BindingIdentifier, so no
// reserved word names a parameter (`function f(in) {}`, `(class) => 1`), `this` included (a
// `this` parameter is TypeScript's).
const Param = rule($ => {
  const body = alt(
    arm('single', field('name', alt(bindingIdentifier, BindingPattern)), opt('=', field('value', Expr))),
    arm('rest', field('ellipsis', '...'), field('name', alt(bindingIdentifier, BindingPattern)), opt('=', field('value', Expr))),   // rest (an initializer is a CHECKER error in tsc, not a parse error)
  );
  return [
    arm('plain', opt(field('decorator', DecoratorExpr)), field('binding', body)),
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
// a FormalParameter: no initializer, rest or decorator (`catch (e = 1)`, `catch (...e)`, `catch
// (@d e)` have no parse).
const CatchParameter = rule($ => [
  bindingIdentifier,
  BindingPattern,
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
  // A do-while's `;` is optional even on its line (12.10.1: a `;` is inserted after the `)`
  // that ends it), so `do x; while (y) z` is two statements.
  ['do', field('body', $), 'while', '(', field('condition', Expr), many(field('conditionComma', ','), field('conditionRest', Expr)), ')', opt(';')],
  ['switch', '(', Expr, many(',', Expr), ')', '{', many(SwitchCase), '}'],
  // The expression is a RESTRICTED production (`return [no LineTerminator here] Expression`):
  // after a line break it starts the next statement, so `return` ⏎ `var b` is two.
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
  arm('using', opt(field('awaitKeyword', 'await')), field('usingKeyword', 'using'), field('binding', Binding), many(field('bindingComma', ','), field('bindingRest', Binding)), asi()),
  Decl,
  // Not after a start that begins a block or a declaration (`expressionStatement`): without the
  // lookahead, longest match lets the expression reading win wherever a tail makes it longer
  // (`{} .b`, `function f(){}\n(g)()`, `@dec class {}.x`).
  expressionStatement(Expr),
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
  arm('computed', field('bracket', '['), field('expr', Expr), field('bracketClose', ']')),
]);

// ── Member words ──
// A word that begins a member production (`static`, `async`, `accessor`, `get`, `set`, and
// TypeScript's modifiers, which build on this) is that keyword only where the start of a member
// follows it; otherwise it is the member's NAME (`static() {}`, `get = 1`, `static static;`,
// `@d accessor;`). The two readings part at that one token: the keyword reading goes on with a
// ClassElementName (an identifier name, a string, a number, a `#name`, `[`) or a `*`, the name
// reading with anything else (`(`, `=`, `;`, `}`, or, past a line break, the next member). What
// differs per word is one further condition, `memberWordRules`:
//   static        none: `static [ClassElementName | * | {]`, on any line (`static⏎x` is a
//                 static `x`; the static block `static {` is its own production)
//   get / set     the start is not `*` (`get ClassElementName`, on any line: `get⏎x() {}` is
//                 a getter, `get⏎*x() {}` a field `get` and a generator)
//   every other   the start is on the word's own line (`async [no LineTerminator here]`,
//                 `accessor [no LineTerminator here]`: `async⏎x() {}` is a field `async`)
// A word in no production takes a further token only where its own arm reads one (`accessor`
// a ClassElementName, no `*`), so the keyword reading fails there and so does the name reading,
// which cannot take a same-line member start either.
export const memberStart = alt(Ident, PrivateField, String_, Number_, HexNumber, OctalNumber, BinaryNumber, BigInt_, '[', '*');
export const memberAhead = not(not(memberStart));
export const memberWordRules: Record<string, unknown[]> = { static: [], get: [not('*')], set: [not('*')] };
// `ahead` is the follower test; TypeScript's parameter modifiers pass their own (a parameter may
// also start with `{` or `...`).
export const memberWord = (words: string[], rules: Record<string, unknown[]>, ahead: unknown = memberAhead) => {
  const sameLineWords = words.filter(w => !(w in rules));
  return alt([
    alt(
      ...words.filter(w => w in rules).map(w => [w, ...rules[w]]),
      ...(sameLineWords.length ? [[alt(...sameLineWords), sameLine]] : []),
    ),
    ahead,
  ]);
};
const staticWord = memberWord(['static'], memberWordRules);
const asyncWord = memberWord(['async'], memberWordRules);
const accessorWord = memberWord(['accessor'], memberWordRules);
const getSetWord = memberWord(['get', 'set'], memberWordRules);
// Class member ( params ) body, with params+body routed to a [Await]/[Yield] family:
// plain methods reset (a method body has its OWN, non-inherited context — the spec's
// implicit function boundary), generators yield, async await, async-generators both.
// The MemberName stays OUTSIDE the family: a computed key `[e]` is evaluated in the
// ENCLOSING context, so it must inherit, not reset.
// A method, accessor or constructor has a body (MethodDefinition), after which nothing is
// needed: a `;` there is an empty class element of its own. A field ends as a statement does.
const memTail = (ctx) => [field('paren', '('), sep(ctx(field('parameter', Param)), ','), ')', ctx(field('body', Block))];
// A class element (15.7 ClassElement, with the decorators proposal's DecoratorList and
// `accessor`): `;`, a static block, or a member's decorators, at most one `static`, and then one
// production, each word of which is a keyword only where `memberWord` says so. Inner alt() is
// first-match; its branches part at their first token (the word, `*`, or a name), so the first
// that matches is the only one. A member with no prefix whose name is the identifier
// `constructor` is the constructor (its keyword leaf); with a prefix it is a method named
// `constructor`.
const memberKinds = [
  arm('accessorField', field('accessorWord', accessorWord), field('key', MemberName), opt('=', resetCtx(field('value', Expr))), asi()),
  arm('async', field('asyncWord', asyncWord), field('form', alt(
    arm('generatorMethod', field('asterisk', '*'), field('key', MemberName), ...memTail(asyncGenCtx)),
    arm('method', field('key', MemberName), ...memTail(awaitCtx)),
  ))),
  arm('generatorMethod', field('asterisk', '*'), field('key', MemberName), ...memTail(yieldCtx)),
  arm('accessor', field('kind', getSetWord), field('key', MemberName), field('paren', '('), opt(sep(resetCtx(field('parameter', Param)), ',')), ')', resetCtx(field('body', Block))),
  // Where `get` / `set` is the accessor keyword it is no name (`get⏎x;` has no derivation; the
  // same-line words cannot end a field before a member start anyway).
  arm('named', not(getSetWord), field('key', MemberName), field('tail', alt(
    arm('method', ...memTail(resetCtx)),                                    // method (requires `(`)
    // field; it ends as a statement does
    arm('field', opt('=', resetCtx(field('value', Expr))), asi()),
  ))),
];
const ClassMember = rule($ => [
  arm('empty', ';'),   // SemicolonClassElement: `class C { ; }`
  arm('staticBlock', 'static', awaitCtx(field('body', Block))),   // ClassStaticBlock: the body is [+Await] (await reserved)
  arm('member', field('form', alt(
    arm('constructor', field('constructorKeyword', 'constructor'), ...memTail(resetCtx)),
    arm('element', many(field('decorator', DecoratorExpr)), opt(field('staticWord', staticWord)), field('member', alt(...memberKinds))),
  ))),
]);

const ImportSpecifier = rule($ => [
  // The spec's two arms: ModuleExportName `as` ImportedBinding | ImportedBinding. The local name
  // is a BindingIdentifier; the name read from the module, before `as`, is an IdentifierName:
  // `import { if as x }`, not `import { if }` / `{ x as if }`.
  arm('renamed', field('imported', Ident), 'as', notReserved, field('local', Ident)),
  arm('plain', notReserved, field('local', Ident)),
  // arbitrary module namespace identifier (ES2022): `import { "str" as x }` — the
  // string form requires the rename (the local binding must be an identifier).
  arm('stringRenamed', field('imported', String_), 'as', notReserved, field('local', Ident)),
]);

// Export specifiers are WIDER than import ones: a ModuleExportName (identifier or
// string) is valid on BOTH sides and may stand alone (`export { x as "s" }`,
// `export { "a" as "b" } from "m"`).
const ExportSpecifier = rule($ => [
  arm('specifier', field('local', alt(Ident, String_)), opt('as', field('exported', alt(Ident, String_)))),
]);

// `{ a, b as c }` (NamedImports) and `* as ns` (NameSpaceImport), alone or after a default binding.
const namedImports = () => [field('brace', '{'), sep(field('specifier', ImportSpecifier), ','), field('braceClose', '}')];
const namespaceImport = () => [field('star', '*'), 'as', notReserved, field('namespace', Ident)];
const ImportClause = rule($ => [
  // default import, optionally followed by named `{…}` or namespace `* as x`
  arm('defaultBinding', notReserved, field('name', Ident), opt(',', field('bindings', alt(arm('named', ...namedImports()), arm('namespace', ...namespaceImport()))))),
  arm('named', ...namedImports()),
  arm('namespace', ...namespaceImport()),
]);

// A class declaration from its `class` keyword on. Decl writes it once bare and once after a
// declaration's decorators (below); gen-tm expands it to recover the `class Ident … { … }` shape
// for highlighting.
const classDecl = ['class', ...bindingName, opt('extends', field('superClass', ClassHeritage)), field('bodyOpen', '{'), many(field('member', ClassMember)), field('bodyClose', '}')];
const Decl = rule($ => [
  // Function declarations live here (not in Stmt) so that at statement level a
  // leading `function` is preferred as a declaration over an IIFE expression-
  // statement: Program tries Decl before Stmt, so `function f(){}\n()=>{}` parses
  // as a declaration + arrow rather than longest-matching `function f(){}()` (IIFE).
  ...fnArms(bindingName, Block),
  classDecl,   // a class with no decorator; with them, the decorator arm below
  exportDeclaration($, Stmt, ['var', 'let', 'const']),
  // A declaration's decorators, parsed ONCE, then what they decorate. Under the decorators
  // proposal a DecoratorList belongs to a class: ClassDeclaration takes it (`@dec class C {}` is
  // one declaration), and so does an exported class, written before `export` or after it, not
  // both (`DecoratorList export [lookahead ≠ @] ClassDeclaration`, and the same with `default`).
  // So after the decorators come a class, or `export` / `export default` and an undecorated
  // class, read by the export arms (`$`); no other declaration takes decorators (`@dec function
  // f() {}`, `@dec export var x`, `@dec export { a }`, `@dec export default x`, `@dec export
  // @dec class C {}` have no parse). The inline alt is ordered, so a class is the first branch
  // and the only one that parses it.
  arm('decorated', many1(field('decorator', DecoratorExpr)), field('declaration', alt(arm('class_', ...classDecl), arm('export_', not(not(['export', opt('default'), 'class'])), field('decl', $))))),
  // A declaration that ends in a block needs nothing after it; every other one ends as a
  // statement does. After `default`, `function` and `class` start a declaration
  // (`export default [lookahead ∉ { function, async function, class }] AssignmentExpression`;
  // the inline alt is ordered, so their arms come first), so `export default class {} g()` is two.
  arm('exportDefault', field('exportKeyword', 'export'), field('defaultKeyword', 'default'), field('declaration', alt(
    ...fnArms([opt(...bindingName)], Block),  // function
    arm('namedClass', many(field('decorator', DecoratorExpr)), 'class', ...bindingName, opt('extends', field('superClass', ClassHeritage)), field('bodyOpen', '{'), many(field('member', ClassMember)), field('bodyClose', '}')),  // named class
    arm('anonymousClass', many(field('decorator', DecoratorExpr)), 'class', opt('extends', field('superClass', ClassHeritage)), field('bodyOpen', '{'), many(field('member', ClassMember)), field('bodyClose', '}')),                          // anonymous class
    arm('expression', field('expr', Expr), asi()),   // catch-all: export default <expr>
  ))),
  arm('exportAll', field('exportKeyword', 'export'), field('star', '*'), field('form', alt(arm('plain', 'from', ...moduleSpecifier), arm('aliased', 'as', field('exported', alt(Ident, String_)), 'from', ...moduleSpecifier))), asi()),   // the alias is a ModuleExportName
  arm('exportNamed', field('exportKeyword', 'export'), field('brace', '{'), sep(field('specifier', ExportSpecifier), ','), field('braceClose', '}'), opt('from', ...moduleSpecifier), asi()),
  arm('importDeclaration', field('importKeyword', 'import'), field('form', alt(
    arm('clause', field('clause', ImportClause), 'from', ...moduleSpecifier),   // import X from "m"
    arm('bare', ...moduleSpecifier),                                            // import "m"
  )), asi()),
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

  // Every keyword the grammar lets be a name is also a name in the tree-sitter grammar (`get` as a
  // property key, `of` as a binding): the name readings cost about 3 MB of parser.c in all.
  treeSitterContextualNames: 'all',
  // tree-sitter GLR conflicts: the fixpoint of `tree-sitter generate`'s own LR(1) analysis of this
  // grammar (`node test/collect-conflicts.ts`), minus the tuples it reports as unnecessary. ECMAScript
  // genuinely needs them: `(a, b)` is a parenthesised expression or arrow params until `=>`, `{` opens a
  // block, object literal or destructuring pattern, and nested `new new Foo()` self-conflicts on
  // NewTarget's leading `new`.
  treeSitterConflicts: [
    ['expr'], ['stmt'], ['stmt', 'decl'], ['expr', 'decl'], ['program', 'stmt'], ['expr', 'param'],
    ['expr', 'new_target'], ['expr', 'block'], ['expr', 'member_name'], ['expr', 'prop'],
    ['member_name', 'stmt'], ['decl'], ['expr', 'binding_pattern'], ['expr', 'binding_element'],
    ['prop', 'binding_property'], ['member_name', 'binding_property'], ['expr', 'block', 'decl'],
    ['expr', 'array_binding_element'], ['expr', 'binding_property'], ['prop', 'member_name'],
    ['prop', 'member_name', 'binding_property'], ['stmt', 'param'], ['class_member'],
    ['expr', 'prop', 'export_specifier'], ['expr', 'export_specifier'],
    // `export { a }` is an export list or `export` + an expression statement `{ a }` (the guard that
    // keeps a statement from starting with `{` is a lookahead tree-sitter drops); with the statement's
    // end a token of its own (the line-end token), both readings meet at `a` before `}`.
    ['prop', 'export_specifier'],
    // A heritage's member tail after its NewTarget base (`extends a.b {}`): NewTarget's own `.b`, or
    // the heritage's `.b` on the base `a`; the interpreter's NewTarget takes it (longest match), and
    // the heritage's tails are for a call's or class expression's result (`extends f().b`).
    ['new_target', 'class_heritage'],
  ],

  rules: {
    DecoratorExpr,
    Expr, Prop, MemberName, NewTarget, ClassHeritage,
    Stmt, Block,
    BindingProperty, BindingElement, ArrayBindingElement, BindingPattern,
    Binding, ForBinding, Param, CatchParameter, ForHead, ForAwaitHead, SwitchCase,
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
