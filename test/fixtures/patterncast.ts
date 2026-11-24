// patterncalc (declared target contexts) plus a PREFIX-SHAPED NUD: `cast` (`<T>e`, TypeScript's type
// assertion) ends in its operand read at the prefix level (atLevel), so its node's form has the
// prefix-unary low bits (FORM_UNARY, parser-ir PrattRule.nudBracketForm) OR'd with the pass bits
// of the context it is a leaf of (assign-targets.ts). Both meanings are read in one grammar:
// `<T>a = x` passes the pattern context, while `++<T>a` (a target-requiring prefix) and `<T>a ** b`
// (a noUnaryLhs operator) are refused by the low bits, as `-a ** b` is.
import {
  token, rule, defineGrammar, left, right, op, prefix, prefixAssignTarget, noUnaryLhs, assignTargetOps, atLevel, arm, field,
  seq, oneOf, range, star, many, opt, sep,
} from '../../src/api.ts';

const identStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const identPart = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_');
const Ident = token(seq(identStart, star(identPart)), { identifier: true, scope: 'variable' });
const Num = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });

const Expr = rule(($) => [
  arm('ident', Ident),
  arm('num', Num),
  arm('paren', '(', $, ')'),
  arm('array', '[', opt(sep(Elem, ',')), opt(','), ']'),
  arm('object', '{', opt(sep(Prop, ',')), '}'),
  arm('cast', '<', Ident, '>', atLevel('-', $)),
  [prefix, $],
  [$, op, $],
  arm('member', $, '.', Ident),
  arm('call', $, '(', ')'),
]);

const Elem = rule(() => [
  arm('spread', '...', Expr),
  arm('elem', Expr),
]);

const Prop = rule(() => [
  arm('init', Ident, ':', field('value', Expr)),
  arm('rest', '...', Expr),
  arm('shorthand', Ident),
]);

const Stmt = rule(() => [[Expr, ';']]);

const Program = rule(() => [many(Stmt)]);

export default defineGrammar({
  name: 'patterncast',
  scopeName: 'source.patterncast',
  tokens: { Ident, Num },
  prec: [
    right(assignTargetOps('pattern', '=')),
    left('+'),
    right(noUnaryLhs('**')),
    right(prefix('-')),
    right(prefixAssignTarget('++')),
  ],
  rules: { Expr, Elem, Prop, Stmt, Program },
  assignTargets: {
    pattern: {
      leaves: ['ident', 'paren', 'member', 'shorthand', 'cast'],
      containers: { array: 'all', object: 'all', spread: 'all', rest: 'all', init: 'value', '=': 'left' },
      last: ['spread', 'rest'],
    },
  },
});
