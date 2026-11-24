// A Pratt grammar with a CAPPED prefix operator and atLevel references: the portable proof of
// both (docs/SECOND-LANGUAGE.md, M4). Python's expression levels in miniature: `or`, `and`, the
// capped prefix `not`, a comparison, `|`, `+`, a tight prefix `-`. `not` begins an operand only at
// its own level or a looser one (`a == not b`, `-not a` have no parse); `'*' atLevel('|', Expr)`
// reads a bitwise-or only (`*a == b;` has no parse); the conditional `x if c else y` is a mixfix
// led below `or` whose middle operand is read at `or`'s level (`a if b if c else d else e;` has
// no parse).
import {
  token, rule, defineGrammar, left, right, op, prefix, cappedPrefix, atLevel,
  seq, oneOf, range, star, many,
} from '../../src/api.ts';

const identStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const identPart = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_');
const Ident = token(seq(identStart, star(identPart)), { identifier: true, scope: 'variable' });

const Expr = rule(($) => [
  Ident,
  ['(', $, ')'],
  [prefix, $],
  [$, op, $],
  [$, 'if', atLevel('or', Expr), 'else', $],
]);

const Stmt = rule(() => [
  ['*', atLevel('|', Expr), ';'],
  [Expr, ';'],
]);

const Program = rule(() => [many(Stmt)]);

export default defineGrammar({
  name: 'cappedcalc',
  scopeName: 'source.cappedcalc',
  tokens: { Ident },
  prec: [
    left('or'),
    left('and'),
    right(cappedPrefix('not')),
    left('==', '<'),
    left('|'),
    left('+'),
    right(prefix('-')),
  ],
  ledPrec: [{ connector: 'if', below: 'or' }],
  rules: { Expr, Stmt, Program },
});
