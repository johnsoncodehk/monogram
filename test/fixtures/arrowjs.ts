// Exercises the capBelow (assignment-level) Pratt construct — arrow functions. A `capExpr`
// NUD is parsed only when the enclosing minBp is LOOSER than its connector's binding power
// (so `1 + (() => x)` needs the parens) and, once parsed, admits NO led (it is "capped").
// The `=>` body's ctxMode (await/yield) is treated as transparent here — the context fork
// is NOT modelled, so this covers basic arrows, not async/await bodies.
import {
  token, rule, defineGrammar, left, right, op, capExpr, alt,
  seq, oneOf, range, star, sep, opt, many,
} from '../../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });

const jsPrec = [right('='), left('||'), left('+', '-'), left('*', '/')];

const Block = rule(($) => [['{', many(Stmt), '}']]);
const Expr = rule(($) => [
  Number_, Ident,
  ['(', $, ')'],
  capExpr('=', '(', opt(sep(Ident, ',')), ')', '=>', alt(Block, $)),   // (params) => body
  capExpr('=', Ident, '=>', alt(Block, $)),                             // x => body
  [$, op, $],
  [$, '(', opt(sep($, ',')), ')'],                                      // call
]);
const Stmt = rule(($) => [Block, [Expr, ';']]);
const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'arrowjs',
  scopeName: 'source.arrowjs',
  tokens: { Ident, Number: Number_ },
  prec: jsPrec,
  rules: { Expr, Block, Stmt, Program },
});
