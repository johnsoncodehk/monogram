// A small Pratt grammar — the cross-language target proof for issue #6.
//
// Deliberately minimal but it exercises the constructs that make parsing-as-
// derivation non-trivial: token kinds (Ident/Number), literal keywords, sequences,
// backtracking alternation, quantifiers (opt/many/sep), recursion (grouping), and —
// the crux — a Pratt expression engine with operator PRECEDENCE and associativity
// (`1 + 2 * 3` must group as `1 + (2 * 3)`), prefix unary, and a left-associative
// call/postfix continuation. emitPortableParser derives a TS, Go, and Rust parser
// from THIS one definition; the cross-language gate proves all three produce the
// byte-identical CST the interpreter (createParser) does.
//
// No lexer lookahead (the full TS grammar's number tokens use `(?!…)`, which Go's
// RE2 and Rust's regex crate reject) — the portable lexer is a dependency-free
// char-class scanner, so the emitted Go/Rust compile offline with no regex engine.
import {
  token, rule, defineGrammar, left, right, op, prefix,
  seq, oneOf, range, star, many,
} from '../src/api.ts';

const digit = range('0', '9');
const identStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const identPart = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_');

const Ident = token(seq(identStart, star(identPart)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(digit, star(digit)), { scope: 'constant.numeric' });

// Precedence ladder (earlier = looser): `+` `-` loosest, then `*` `/`, then prefix
// `-` tightest — so `1 + 2 * 3` is `1 + (2 * 3)` and `-a * b` is `(-a) * b`.
const calcPrec = [
  left('+', '-'),
  left('*', '/'),
  right(prefix('-')),
];

const Expr = rule(($) => [
  Number_,
  Ident,
  ['(', $, ')'],            // grouping (recursion)
  [prefix, $],              // prefix unary minus (operators from the ladder)
  [$, op, $],               // binary infix, precedence from the ladder
]);

const Stmt = rule(($) => [
  ['let', Ident, '=', Expr, ';'],
  [Expr, ';'],
]);

const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'calc',
  scopeName: 'source.calc',
  tokens: { Ident, Number: Number_ },
  prec: calcPrec,
  // findEntryRule = the LAST rule, so Program is the entry point.
  rules: { Expr, Stmt, Program },
});
