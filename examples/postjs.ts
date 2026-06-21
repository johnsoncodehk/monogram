// Exercises the postfix-operator Pratt LED `[$, postfix]` (e.g. `x++`, `x--`) — a LED that
// consumes the operator and no right operand, binding tight. `++`/`--` are BOTH prefix (NUD,
// `++x`) and postfix (LED, `x++`); the engine resolves them by position.
import {
  token, rule, defineGrammar, left, right, op, prefix, postfix,
  seq, oneOf, range, star, many,
} from '../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });

const jsPrec = [
  left('+', '-'),
  left('*', '/'),
  right(prefix('-', '!', '++', '--')),
  left(postfix('++', '--')),
];

const Expr = rule(($) => [
  Number_, Ident,
  ['(', $, ')'],
  [prefix, $],
  [$, op, $],
  [$, '.', Ident],
  [$, postfix],          // postfix operator LED
]);
const Stmt = rule(($) => [[Expr, ';']]);
const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'postjs',
  scopeName: 'source.postjs',
  tokens: { Ident, Number: Number_ },
  prec: jsPrec,
  rules: { Expr, Stmt, Program },
});
