// Python 3.10 grammar for Monogram: the second-language proof (docs/SECOND-LANGUAGE.md).
//
// The definition is CPython 3.10's Grammar/python.gram (the PEG the reference parser is generated
// from), its tokenizer (Parser/tokenizer.c) and the language reference's lexical analysis; the
// oracle is `ast.parse` of the box's python3 (3.10.12). The `invalid_*` rules of python.gram are
// error reporting, not syntax, and are not modelled. Rules here keep python.gram's names (in
// PascalCase) so a disagreement can be traced to the production it came from.
//
// Indentation is the engine's opt-in indent mode (IndentConfig): the lexer emits Indent when a
// line's column exceeds the stack top, Dedent per popped level, and Newline between two lines at
// the same column (YAML's sibling separator). That carries the same information as CPython's
// NEWLINE / INDENT / DEDENT: a suite is `Indent Stmt (Newline Stmt)* Dedent` and the statement after
// a compound statement's suite is reached through `Dedent Newline`.
//
// f-strings are lexed as plain strings: their replacement fields are not parsed yet (the engine's
// template tokens cannot spell them; mechanism 2 of docs/SECOND-LANGUAGE.md). The corpus check
// records the inputs that differ for that reason as their own class.

import {
  token, rule, defineGrammar,
  left, right, op, prefix, cappedPrefix, atLevel, capExpr,
  opt, many, many1, alt, not,
  altPattern, optPattern, seq, oneOf, noneOf, range, anyChar, star, plus, never, notFollowedBy,
} from './src/api.ts';
import type { IndentConfig, TokenPattern } from './src/types.ts';

// ── Structural tokens: emitted by the lexer's indent mode, never matched by a pattern ──
const Indent = token(never(), {});
const Dedent = token(never(), {});
const Newline = token(never(), {});

// ── Lexical tokens (declaration order = lexer precedence: earlier wins) ──
const digit = range('0', '9');
const nonZero = range('1', '9');
const hexDigit = oneOf(digit, range('a', 'f'), range('A', 'F'));
const lineBreak = altPattern(seq('\r', optPattern('\n')), '\n');

// A comment runs to the end of the line. Comment-only lines are skipped by the indent mode itself
// (IndentConfig.comment) so they never move the column stack.
const Comment = token(seq('#', star(noneOf('\n', '\r'))), { skip: true, scope: 'comment.line.number-sign' });
// Explicit line joining (2.1.5): a backslash right before a line break joins the two lines.
const LineJoin = token(seq('\\', lineBreak), { skip: true });

// Strings (2.4.1). A prefix is any case of r, u, b, br/rb, f, fr/rf; `ur` is not a prefix. Raw or
// not, a backslash always takes the next character for the literal's END (r'\'' is one literal);
// what differs is which escapes are well formed: a non-raw str rejects a truncated \x / \u / \U /
// \N{…} (the decoder's SyntaxError), a non-raw bytes literal \x only, and bytes hold ASCII only.
const ci = (s: string) => seq(...[...s].map((c) => oneOf(c.toLowerCase(), c.toUpperCase())));
const strEscape = seq('\\', altPattern(
  seq('x', hexDigit, hexDigit),
  seq('u', hexDigit, hexDigit, hexDigit, hexDigit),
  seq('U', hexDigit, hexDigit, hexDigit, hexDigit, hexDigit, hexDigit, hexDigit, hexDigit),
  seq('N{', plus(noneOf('}', '\n', '\r')), '}'),
  noneOf('x', 'u', 'U', 'N'),
));
const bytesEscape = seq('\\', altPattern(seq('x', hexDigit, hexDigit), noneOf('x')));
const rawEscape = seq('\\', anyChar());
// The four quote forms of one body: `chars(q)` is what a body may hold besides an escape and,
// in a long form, a quote not starting the closer.
const quoted = (esc: TokenPattern, chars: (q: string, long: boolean) => TokenPattern) => altPattern(
  seq("'''", star(altPattern(chars("'", true), esc, seq("'", notFollowedBy("''")))), "'''"),
  seq('"""', star(altPattern(chars('"', true), esc, seq('"', notFollowedBy('""')))), '"""'),
  seq("'", star(altPattern(chars("'", false), esc)), "'"),
  seq('"', star(altPattern(chars('"', false), esc)), '"'),
);
const strChars = (q: string, long: boolean) => long ? noneOf(q, '\\') : noneOf(q, '\\', '\n', '\r');
// A bytes body is ASCII: the class is spelled as the ASCII range minus the quote, `\` and (short
// forms) line breaks.
const bytesChars = (q: string, long: boolean) => noneOf(q, '\\', ...(long ? [] : ['\n', '\r']), range('\u0080', '￿'));
const String_ = token(seq(optPattern(altPattern(ci('u'), ci('f'))), quoted(strEscape, strChars)), { string: true });
const RawString = token(seq(altPattern(ci('rf'), ci('fr'), ci('r')), quoted(rawEscape, strChars)), { string: true });
const Bytes = token(seq(ci('b'), quoted(bytesEscape, bytesChars)), { string: true });
const RawBytes = token(seq(altPattern(ci('rb'), ci('br')), quoted(seq('\\', noneOf(range('\u0080', '￿'))), bytesChars)), { string: true });

// Numbers (2.4.5 - 2.4.7). Underscores only between digits. A decimal integer other than zero
// has no leading zero (`0777` lexes as `0` then `777`, two atoms: rejected by the grammar).
const digitPart = seq(digit, star(seq(optPattern('_'), digit)));
const pointFloat = altPattern(seq(optPattern(digitPart), '.', digitPart), seq(digitPart, '.'));
const exponent = seq(oneOf('e', 'E'), optPattern(oneOf('+', '-')), digitPart);
const floatNumber = altPattern(seq(altPattern(pointFloat, digitPart), exponent), pointFloat);
const Imaginary = token(seq(altPattern(floatNumber, digitPart), oneOf('j', 'J')), { scope: 'constant.numeric' });
const Float = token(floatNumber, { scope: 'constant.numeric' });
const Integer = token(altPattern(
  seq('0', oneOf('x', 'X'), plus(seq(optPattern('_'), hexDigit))),
  seq('0', oneOf('o', 'O'), plus(seq(optPattern('_'), range('0', '7')))),
  seq('0', oneOf('b', 'B'), plus(seq(optPattern('_'), oneOf('0', '1')))),
  seq(nonZero, star(seq(optPattern('_'), digit))),
  seq(plus('0'), star(seq(optPattern('_'), '0'))),
), { scope: 'constant.numeric' });

// NAME (2.3): ASCII here; a character beyond ASCII goes through the lexer's Unicode fallback, which
// reads Python's classes as declared: `_` + XID_Start, then XID_Continue (no `$`, no ZWNJ / ZWJ).
const Name = token(seq(oneOf(range('a', 'z'), range('A', 'Z'), '_'), star(oneOf(range('a', 'z'), range('A', 'Z'), digit, '_'))), {
  identifier: true, identifierClasses: { start: '[_\\p{XID_Start}]', continue: '[\\p{XID_Continue}]' },
});

// ── Keywords (2.3.1). Soft keywords (`match`, `case`, `_`) are names everywhere but where an arm
// spells them. ──
export const keywords = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
];
const notKw = not(alt(...keywords));
const NAME = () => [notKw, Name] as const;

// t_lookahead: what may follow a t_primary.
const tLookahead = alt('(', '[', '.');
const followedByTrailer = not(not(tLookahead));

// ── Expressions (python.gram "EXPRESSIONS"): ONE Pratt rule from `lambda` down to `await`.
// python.gram's levels (expression, disjunction, conjunction, inversion, comparison, bitwise_or …)
// are binding powers here. `not` is a CAPPED prefix (cappedPrefix): it begins an operand only at
// its own level or a looser one, so `a and not b` parses and `a == not b`, `-not x` do not. A
// context that python.gram writes with a lower level's rule reads this rule at that level
// (atLevel): `'*' bitwise_or` is `['*', atLevel('|', Expression)]`, a comprehension's iterable
// and condition are disjunctions (`atLevel('or', …)`). The conditional is a mixfix led below `or`
// whose condition is a disjunction; `lambda` is a capped nud (capExpr) below the conditional: no
// operator takes it as an operand and nothing continues it. The comparisons are left-nested
// binary operators (python.gram's `comparison` is one n-ary node; the verdict is the same). The
// two-word operators are led arms at the comparison level (ledPrec). `**` binds tighter than a
// unary prefix on its left (`-x ** y` is `-(x ** y)`) and takes a unary on its right (`2 ** -1`);
// `await` takes a primary only. ──
const Expression = rule(($) => [
  Primary,
  ['await', Primary],
  [$, 'not', 'in', $],
  [$, 'in', $],
  [$, 'is', 'not', $],
  [$, 'is', $],
  [$, op, $],
  [prefix, $],
  [$, 'if', atLevel('or', Expression), 'else', $],
  capExpr('if', 'lambda', opt(LambdaParameters), ':', $),
]);
const Disjunction = () => atLevel('or', Expression);
const BitwiseOr = () => atLevel('|', Expression);
const Expressions = rule(() => [[Expression, many(',', Expression), opt(',')]]);

const AssignmentExpression = rule(() => [[...NAME(), ':=', Expression]]);
const NamedExpression = rule(() => [AssignmentExpression, [Expression, not(':=')]]);
const StarExpression = rule(() => [['*', BitwiseOr()], Expression]);
const StarExpressions = rule(() => [[StarExpression, many(',', StarExpression), opt(',')]]);
const StarNamedExpression = rule(() => [['*', BitwiseOr()], NamedExpression]);
const StarNamedExpressions = rule(() => [[StarNamedExpression, many(',', StarNamedExpression), opt(',')]]);
const YieldExpr = rule(() => [['yield', 'from', Expression], ['yield', opt(StarExpressions)]]);

// primary: atom and its trailers.
const Primary = rule(($) => [
  Atom,
  [$, '.', ...NAME()],
  [$, Genexp],
  [$, '(', opt(Arguments), ')'],
  [$, '[', Slices, ']'],
]);
const Slice = rule(() => [
  [opt(Expression), ':', opt(Expression), opt(':', opt(Expression))],
  NamedExpression,
]);
const Slices = rule(() => [[Slice, many(',', Slice), opt(',')]]);

const Strings = rule(() => [[many1(alt(String_, RawString, Bytes, RawBytes))]]);
const Atom = rule(() => [
  [...NAME()],
  'True', 'False', 'None', '...',
  Strings,
  Imaginary, Float, Integer,
  Tuple, Group, Genexp,
  List, Listcomp,
  Dict, Set, Dictcomp, Setcomp,
]);
const Group = rule(() => [['(', alt(YieldExpr, NamedExpression), ')']]);
const Tuple = rule(() => [['(', opt(StarNamedExpression, ',', opt(StarNamedExpressions)), ')']]);
const List = rule(() => [['[', opt(StarNamedExpressions), ']']]);
const Set = rule(() => [['{', StarNamedExpressions, '}']]);
const Kvpair = rule(() => [[Expression, ':', Expression]]);
const DoubleStarredKvpair = rule(() => [['**', BitwiseOr()], Kvpair]);
const Dict = rule(() => [['{', opt(DoubleStarredKvpair, many(',', DoubleStarredKvpair), opt(',')), '}']]);
const ForIfClause = rule(() => [[opt('async'), 'for', StarTargets, 'in', Disjunction(), many('if', Disjunction())]]);
const ForIfClauses = rule(() => [[many1(ForIfClause)]]);
const Listcomp = rule(() => [['[', NamedExpression, ForIfClauses, ']']]);
const Setcomp = rule(() => [['{', NamedExpression, ForIfClauses, '}']]);
const Dictcomp = rule(() => [['{', Kvpair, ForIfClauses, '}']]);
const Genexp = rule(() => [['(', alt(AssignmentExpression, [Expression, not(':=')]), ForIfClauses, ')']]);

// arguments: positional (starred or named, never `name=`), then keywords: `*x` may mix with
// `k=v`, `**m` comes after every `*x`.
const KwargOrStarred = rule(() => [[...NAME(), '=', Expression], ['*', Expression]]);
const KwargOrDoubleStarred = rule(() => [[...NAME(), '=', Expression], ['**', Expression]]);
const Kwargs = rule(() => [
  [KwargOrStarred, many(',', KwargOrStarred), ',', KwargOrDoubleStarred, many(',', KwargOrDoubleStarred)],
  [KwargOrStarred, many(',', KwargOrStarred)],
  [KwargOrDoubleStarred, many(',', KwargOrDoubleStarred)],
]);
const PositionalArg = rule(() => [['*', Expression], [alt(AssignmentExpression, [Expression, not(':=')]), not('=')]]);
const Args = rule(() => [
  [PositionalArg, many(',', PositionalArg), opt(',', Kwargs)],
  Kwargs,
]);
const Arguments = rule(() => [[Args, opt(','), not(not(')'))]]);

// lambda: python.gram's lambda_parameters, the parameter forms without annotations, ended by `:`.
// parameters: the same with annotations, ended by `)`. One builder serves both (closer, param).
function paramForms(param: () => unknown[], close: string) {
  const end = alt(',', not(not(close)));
  const noDefault = () => [...param(), end];
  const withDefault = () => [...param(), '=', Expression, end];
  const maybeDefault = () => [...param(), opt('=', Expression), end];
  const slash = alt(['/', ','], ['/', not(not(close))]);
  const kwds = () => ['**', ...noDefault()];
  const starEtc = () => alt(
    ['*', ...noDefault(), many(...maybeDefault()), opt(...kwds())],
    ['*', ',', many1(...maybeDefault()), opt(...kwds())],
    kwds(),
  );
  return [
    [many1(...noDefault()), slash, many(...noDefault()), many(...withDefault()), opt(starEtc())],
    [many(...noDefault()), many1(...withDefault()), slash, many(...withDefault()), opt(starEtc())],
    [many1(...noDefault()), many(...withDefault()), opt(starEtc())],
    [many1(...withDefault()), opt(starEtc())],
    [starEtc()],
  ];
}
const Parameters = rule(() => paramForms(() => [...NAME(), opt(':', Expression)], ')'));
const LambdaParameters = rule(() => paramForms(() => [...NAME()], ':'));

// ── Targets (python.gram "TARGETS"). A t_primary arm holds only when another trailer follows
// (`&t_lookahead`), so the LAST `.name` / `[…]` of a chain is the target's: `f().x = 1` assigns,
// `f() = 1` has no derivation. An assignment statement's head is parsed as targets here and its
// expression-statement reading as expressions: the head twice (docs/SECOND-LANGUAGE.md). ──
const TPrimary = rule(($) => [
  [Atom, followedByTrailer],
  [$, '.', ...NAME(), followedByTrailer],
  [$, '[', Slices, ']', followedByTrailer],
  [$, Genexp, followedByTrailer],
  [$, '(', opt(Arguments), ')', followedByTrailer],
]);
const SingleSubscriptAttributeTarget = rule(() => [
  [TPrimary, '.', ...NAME(), not(tLookahead)],
  [TPrimary, '[', Slices, ']', not(tLookahead)],
]);
const SingleTarget = rule(($) => [SingleSubscriptAttributeTarget, [...NAME()], ['(', $, ')']]);
const TargetWithStarAtom = rule(() => [SingleSubscriptAttributeTarget, StarAtom]);
const StarTarget = rule(($) => [['*', not('*'), $], TargetWithStarAtom]);
const StarTargets = rule(() => [[StarTarget, many(',', StarTarget), opt(',')]]);
const StarAtom = rule(() => [
  [...NAME()],
  ['(', TargetWithStarAtom, ')'],
  ['(', opt(alt([StarTarget, many1(',', StarTarget), opt(',')], [StarTarget, ','])), ')'],
  ['[', opt(StarTarget, many(',', StarTarget), opt(',')), ']'],
]);
const DelTarget = rule(($) => [
  SingleSubscriptAttributeTarget,
  [...NAME()],
  ['(', $, ')'],
  ['(', opt(DelTargets), ')'],
  ['[', opt(DelTargets), ']'],
]);
const DelTargets = rule(() => [[DelTarget, many(',', DelTarget), opt(',')]]);

// ── Simple statements ──
const AugAssign = () => alt('+=', '-=', '*=', '@=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '**=', '//=');
const AnnotatedRhs = () => alt(YieldExpr, StarExpressions);
const Assignment = rule(() => [
  [...NAME(), ':', Expression, opt('=', AnnotatedRhs())],
  [alt(['(', SingleTarget, ')'], SingleSubscriptAttributeTarget), ':', Expression, opt('=', AnnotatedRhs())],
  [many1(StarTargets, '='), alt(YieldExpr, StarExpressions), not('=')],
  [SingleTarget, AugAssign(), alt(YieldExpr, StarExpressions)],
]);
const DottedName = rule(() => [[...NAME(), many('.', ...NAME())]]);
const DottedAsName = rule(() => [[DottedName, opt('as', ...NAME())]]);
const ImportFromAsName = rule(() => [[...NAME(), opt('as', ...NAME())]]);
const ImportFromAsNames = () => [ImportFromAsName, many(',', ImportFromAsName)];
const ImportFromTargets = () => alt(['(', ...ImportFromAsNames(), opt(','), ')'], [...ImportFromAsNames(), not(',')], '*');
const ImportStmt = rule(() => [
  ['import', DottedAsName, many(',', DottedAsName)],
  ['from', many(alt('.', '...')), DottedName, 'import', ImportFromTargets()],
  ['from', many1(alt('.', '...')), 'import', ImportFromTargets()],
]);
const SimpleStmt = rule(() => [
  Assignment,
  StarExpressions,
  ['return', opt(StarExpressions)],
  ImportStmt,
  ['raise', Expression, opt('from', Expression)],
  'raise',
  'pass',
  ['del', DelTargets],
  YieldExpr,
  ['assert', Expression, opt(',', Expression)],
  'break',
  'continue',
  ['global', ...NAME(), many(',', ...NAME())],
  ['nonlocal', ...NAME(), many(',', ...NAME())],
]);
const SimpleStmts = rule(() => [[SimpleStmt, many(';', SimpleStmt), opt(';')]]);

// ── Compound statements. A suite is a simple-statement list on the header's line or an indented
// block; a continuation clause (elif / else / except / finally) sits on a later line at the
// header's column, so a Newline comes before it. ──
const Block = rule(() => [[Indent, Statements, Dedent], SimpleStmts]);
const ElseBlock = () => [Newline, 'else', ':', Block];
const ElifStmt = rule(($) => [[Newline, 'elif', NamedExpression, ':', Block, opt(alt($, ElseBlock()))]]);
const IfStmt = rule(() => [['if', NamedExpression, ':', Block, opt(alt(ElifStmt, ElseBlock()))]]);
const WhileStmt = rule(() => [['while', NamedExpression, ':', Block, opt(...ElseBlock())]]);
const ForStmt = rule(() => [[opt('async'), 'for', StarTargets, 'in', StarExpressions, ':', Block, opt(...ElseBlock())]]);
const WithItem = rule(() => [[Expression, 'as', StarTarget, not(not(alt(',', ')', ':')))], Expression]);
const WithStmt = rule(() => [
  [opt('async'), 'with', '(', WithItem, many(',', WithItem), opt(','), ')', ':', Block],
  [opt('async'), 'with', WithItem, many(',', WithItem), ':', Block],
]);
const ExceptBlock = rule(() => [[Newline, 'except', opt(Expression, opt('as', ...NAME())), ':', Block]]);
const FinallyBlock = () => [Newline, 'finally', ':', Block];
const TryStmt = rule(() => [
  ['try', ':', Block, ...FinallyBlock()],
  ['try', ':', Block, many1(ExceptBlock), opt(...ElseBlock()), opt(...FinallyBlock())],
]);
const Decorator = () => ['@', NamedExpression, Newline];
const FunctionDef = rule(() => [[many(...Decorator()), opt('async'), 'def', ...NAME(), '(', opt(Parameters), ')', opt('->', Expression), ':', Block]]);
const ClassDef = rule(() => [[many(...Decorator()), 'class', ...NAME(), opt('(', opt(Arguments), ')'), ':', Block]]);

// ── match (PEP 634). `match`, `case` and `_` are soft keywords: names elsewhere. ──
const SignedNumber = () => alt([opt('-'), alt(Integer, Float, Imaginary)]);
const ComplexNumber = () => [opt('-'), alt(Integer, Float), alt('+', '-'), Imaginary];
const LiteralPattern = rule(() => [
  [SignedNumber(), not(alt('+', '-'))],
  ComplexNumber(),
  Strings, 'None', 'True', 'False',
]);
const Attr = rule(() => [[...NAME(), many1('.', ...NAME())]]);
const NameOrAttr = () => [...NAME(), many('.', ...NAME())];
const PatternCaptureTarget = rule(() => [[not('_'), ...NAME(), not(alt('.', '(', '='))]]);
const ClosedPattern = rule(() => [
  LiteralPattern,
  PatternCaptureTarget,
  '_',
  [Attr, not(alt('.', '(', '='))],
  ['(', Pattern, ')'],
  ['[', opt(MaybeSequencePattern), ']'],
  ['(', opt(OpenSequencePattern), ')'],
  MappingPattern,
  ClassPattern,
]);
const OrPattern = rule(() => [[ClosedPattern, many('|', ClosedPattern)]]);
const Pattern = rule(($) => [[OrPattern, 'as', PatternCaptureTarget], OrPattern]);
const StarPattern = rule(() => [['*', alt(PatternCaptureTarget, '_')]]);
const MaybeStarPattern = () => alt(StarPattern, Pattern);
const MaybeSequencePattern = rule(() => [[MaybeStarPattern(), many(',', MaybeStarPattern()), opt(',')]]);
const OpenSequencePattern = rule(() => [[MaybeStarPattern(), ',', opt(MaybeSequencePattern)]]);
const KeyValuePattern = rule(() => [[alt(LiteralPattern, Attr), ':', Pattern]]);
const DoubleStarPattern = () => ['**', PatternCaptureTarget];
const MappingPattern = rule(() => [
  ['{', '}'],
  ['{', ...DoubleStarPattern(), opt(','), '}'],
  ['{', KeyValuePattern, many(',', KeyValuePattern), ',', ...DoubleStarPattern(), opt(','), '}'],
  ['{', KeyValuePattern, many(',', KeyValuePattern), opt(','), '}'],
]);
const KeywordPattern = rule(() => [[...NAME(), '=', Pattern]]);
const ClassPattern = rule(() => [
  [...NameOrAttr(), '(', ')'],
  [...NameOrAttr(), '(', Pattern, many(',', Pattern), opt(','), ')'],
  [...NameOrAttr(), '(', KeywordPattern, many(',', KeywordPattern), opt(','), ')'],
  [...NameOrAttr(), '(', Pattern, many(',', Pattern), ',', KeywordPattern, many(',', KeywordPattern), opt(','), ')'],
]);
const Patterns = rule(() => [OpenSequencePattern, Pattern]);
const CaseBlock = rule(() => [['case', Patterns, opt('if', NamedExpression), ':', Block]]);
const SubjectExpr = rule(() => [[StarNamedExpression, ',', opt(StarNamedExpressions)], NamedExpression]);
const MatchStmt = rule(() => [['match', SubjectExpr, ':', Indent, CaseBlock, many(Newline, CaseBlock), Dedent]]);

const CompoundStmt = rule(() => [FunctionDef, IfStmt, ClassDef, WithStmt, ForStmt, TryStmt, WhileStmt, MatchStmt]);
const Statement = rule(() => [CompoundStmt, SimpleStmts]);
const Statements = rule(() => [[Statement, many(Newline, Statement)]]);
const File = rule(() => [[opt(Statements)]]);

const indent: IndentConfig = {
  indentToken: 'Indent',
  dedentToken: 'Dedent',
  newlineToken: 'Newline',
  flowOpen: ['(', '[', '{'],
  flowClose: [')', ']', '}'],
  comment: '#',
};

export default defineGrammar({
  name: 'python',
  scopeName: 'source.python',
  tokens: { Comment, LineJoin, RawBytes, Bytes, RawString, String: String_, Imaginary, Float, Integer, Name, Indent, Dedent, Newline },
  prec: [
    left('or'),
    left('and'),
    right(cappedPrefix('not')),
    left('==', '!=', '<', '<=', '>', '>='),
    left('|'),
    left('^'),
    left('&'),
    left('<<', '>>'),
    left('+', '-'),
    left('*', '/', '//', '%', '@'),
    right(prefix('+', '-', '~')),
    right('**'),
  ],
  rules: {
    Expression, Expressions,
    AssignmentExpression, NamedExpression, StarExpression, StarExpressions, StarNamedExpression, StarNamedExpressions, YieldExpr,
    Primary, Slice, Slices, Strings, Atom, Group, Tuple, List, Set, Kvpair, DoubleStarredKvpair, Dict,
    ForIfClause, ForIfClauses, Listcomp, Setcomp, Dictcomp, Genexp,
    KwargOrStarred, KwargOrDoubleStarred, Kwargs, PositionalArg, Args, Arguments,
    Parameters, LambdaParameters,
    TPrimary, SingleSubscriptAttributeTarget, SingleTarget, TargetWithStarAtom, StarTarget, StarTargets, StarAtom, DelTarget, DelTargets,
    Assignment, DottedName, DottedAsName, ImportFromAsName, ImportStmt, SimpleStmt, SimpleStmts,
    Block, ElifStmt, IfStmt, WhileStmt, ForStmt, WithItem, WithStmt, ExceptBlock, TryStmt, FunctionDef, ClassDef,
    LiteralPattern, Attr, PatternCaptureTarget, ClosedPattern, OrPattern, Pattern, StarPattern, MaybeSequencePattern, OpenSequencePattern,
    KeyValuePattern, MappingPattern, KeywordPattern, ClassPattern, Patterns, CaseBlock, SubjectExpr, MatchStmt,
    CompoundStmt, Statement, Statements, File,
  },
  ledPrec: [
    { connector: 'if', below: 'or' },
    { connector: 'not', sameAs: '<', chainRhs: true },
    { connector: 'in', sameAs: '<', chainRhs: true },
    { connector: 'is', sameAs: '<', chainRhs: true },
  ],
  entry: File,
  indent,
});
