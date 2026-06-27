// Exercises two general Pratt NUD shapes javascript.ts needs (beyond bare-token / prefix /
// bracket): a reserved-word-GUARDED identifier `[not(kw)… Ident]` (zero-width negative
// lookahead before a token) and a quantifier-first NUD `[Decorator? "class" Ident? …]` (a
// class expression). Both compile to a general backtracking NUD sequence; the `not` step
// consumes nothing. (Arrow functions — group{capBelow,ctxMode} — are deferred.)
import {
  token, rule, defineGrammar, left, op,
  seq, oneOf, range, star, sep, opt, many, alt, not, noneOf,
} from '../../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });
const Decorator = token(seq('@', idStart, star(idCont)), { scope: 'meta.decorator' });

const reserved = alt('if', 'else', 'while', 'return', 'class', 'new', 'extends');

const Expr = rule(($) => [
  Number_,
  [not(reserved), Ident],                                          // reserved-word-guarded identifier
  [opt(Decorator), 'class', opt(Ident), opt('extends', $), '{', many(ClassMember), '}'],  // class expr (quantifier-first NUD)
  ['new', $],                                                      // literal-led NUD (bracket)
  ['(', $, ')'],
  [$, op, $],
  [$, '.', Ident],
  [$, '(', opt(sep($, ',')), ')'],
]);
const ClassMember = rule(($) => [[opt(Decorator), Ident, '(', ')', '{', '}']]);

const jsPrec = [left('+', '-'), left('*', '/')];
const Stmt = rule(($) => [[Expr, ';']]);
const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'nudjs',
  scopeName: 'source.nudjs',
  tokens: { Decorator, Ident, Number: Number_ },
  prec: jsPrec,
  rules: { Expr, ClassMember, Stmt, Program },
});
