// A rule chooses among its alternatives by LONGEST MATCH — the alternative that consumes the
// most input wins, the earliest-declared one on a tie — in every engine. Each pair below
// declares the alternative that matches LESS first, or puts the two in different kinds of NUD
// arm (a prefix operator and a literal-led form on the same word), so an engine that takes the
// first alternative that matches, or tries its arms in an order of its own, parses differently:
//   • `this` / `this is $`          two literal-led NUD arms, the shorter declared first;
//   • prefix `yield` / `yield …`    a prefix operator and a literal-led NUD on one word: the
//                                   prefix arm is declared first and wins the tie on `yield x++`,
//                                   so its node closes the tail and `yield x++ ++` is refused,
//                                   while `yield a + b` is the literal-led arm (it is longer);
//   • Ident / Ident `=>` $          a plain NUD and a capped one that extends it;
//   • `let` Ident* / Expr `;`       two statement alternatives: `let * a;` is an expression;
//   • `export` Stmt / `export default` Expr `;`   the first ends early inside the second.
// The shapes are the ones javascript.ts has (its `yield`, `let` and `export default` arms).
import {
  token, rule, defineGrammar, left, right, op, prefix, postfix,
  seq, oneOf, range, star, sep, opt, many, alt, not, capExpr,
} from '../../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });

const reserved = alt('this', 'is', 'yield', 'export');

const jsPrec = [
  right('='),
  left('+', '-'),
  left('*', '/'),
  right(prefix('-', 'yield')),
  left(postfix('++')),
];

const Expr = rule(($) => [
  Number_,
  [not(reserved), Ident],
  capExpr('=', not(reserved), Ident, '=>', $),
  'this',
  ['this', 'is', $],
  [prefix, $],
  ['yield', alt(['*', $], [opt($)])],
  ['(', $, ')'],
  [$, op, $],
  [$, postfix],
  [$, '.', Ident],
]);
const Stmt = rule(() => [
  ['let', sep(Ident, ','), opt(';')],
  [Expr, ';'],
]);
const Decl = rule(() => [
  ['export', Stmt],
  ['export', 'default', Expr, ';'],
]);
const Program = rule(() => [many(alt(Decl, Stmt))]);

export default defineGrammar({
  name: 'longestjs',
  scopeName: 'source.longestjs',
  tokens: { Ident, Number: Number_ },
  prec: jsPrec,
  rules: { Expr, Stmt, Decl, Program },
});
