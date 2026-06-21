// Exercises the no-`in` (suppress) context. In a `for (binding in iterable)` head, the
// binding is parsed with the `in` LED DISABLED — `exclude('in', Expr)` — so the `in` belongs
// to the for-head, not to a relational expression inside the binding. Outside a for-head, `in`
// binds normally. The portable parser threads a suppressed-connector set into the led loop.
import {
  token, rule, defineGrammar, left, op, exclude,
  seq, oneOf, range, star, many,
} from '../../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });

const jsPrec = [left('||'), left('<', '>'), left('+', '-')];

const Expr = rule(($) => [
  Number_, Ident,
  ['(', $, ')'],
  [$, op, $],
  [$, 'in', $],
  [$, '.', Ident],
]);
const ForHead = rule(($) => [['for', '(', exclude('in', Expr), 'in', Expr, ')', Stmt]]);
const Stmt = rule(($) => [ForHead, [Expr, ';']]);
const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'noinjs',
  scopeName: 'source.noinjs',
  tokens: { Ident, Number: Number_ },
  prec: jsPrec,
  ledPrec: [{ connector: 'in', sameAs: '<', chainRhs: true }],
  rules: { Expr, ForHead, Stmt, Program },
});
