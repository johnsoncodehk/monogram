// Exercises the portable parser's general inline `alt(...)` of NON-literals (the first
// parser-algebra construct javascript.ts needs that buildIR previously rejected). Object
// keys are `alt(Ident, Str, Number)` — a backtracking alternation of token references
// inside a rule sequence, not the all-literal fast path.
import {
  token, rule, defineGrammar, left, op,
  seq, oneOf, range, star, sep, opt, many, alt, noneOf,
} from '../src/api.ts';

const digit = range('0', '9');
const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');

const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(digit, star(digit)), { scope: 'constant.numeric' });
const Str = token(seq('"', star(noneOf('"', '\n')), '"'), { scope: 'string.quoted.double' });

const jsPrec = [left('+', '-'), left('*', '/')];

// key = a NON-literal inline alternation (Ident | Str | Number).
const KeyVal = rule(($) => [[alt(Ident, Str, Number_), ':', Expr]]);
const Expr = rule(($) => [
  Number_, Str, Ident,
  ['(', $, ')'],
  ['{', opt(sep(KeyVal, ',')), '}'],   // object literal
  [$, op, $],
]);
const Stmt = rule(($) => [[Expr, ';']]);
const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'altjs',
  scopeName: 'source.altjs',
  tokens: { Ident, Number: Number_, Str },
  prec: jsPrec,
  rules: { KeyVal, Expr, Stmt, Program },
});
