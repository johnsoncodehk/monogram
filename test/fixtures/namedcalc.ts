// test/fixtures/calc.ts with every arm and child NAMED (`arm` / `field`, src/api.ts): the
// grammar test/grammar-names-transparent.ts proves names transparent with (same grammar name, so
// every emitted parser must be byte-identical to calc's).
import {
  token, rule, defineGrammar, left, right, op, prefix,
  seq, oneOf, range, star, many, arm, field,
} from '../../src/api.ts';

const digit = range('0', '9');
const identStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const identPart = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_');

const Ident = token(seq(identStart, star(identPart)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(digit, star(digit)), { scope: 'constant.numeric' });

const calcPrec = [
  left('+', '-'),
  left('*', '/'),
  right(prefix('-')),
];

const Expr = rule(($) => [
  arm('number', Number_),
  arm('name', Ident),
  arm('parenthesized', '(', field('expression', $), ')'),
  [prefix, $],
  [$, op, $],
]);

const Stmt = rule(() => [
  arm('letDeclaration', 'let', field('binding', Ident), '=', field('initializer', Expr), ';'),
  arm('expression', field('expression', Expr), ';'),
]);

const Program = rule(() => [arm('program', field('statements', many(field('statement', Stmt))))]);

export default defineGrammar({
  name: 'calc',
  scopeName: 'source.calc',
  tokens: { Ident, Number: Number_ },
  prec: calcPrec,
  rules: { Expr, Stmt, Program },
});
