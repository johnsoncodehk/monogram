// A Pratt grammar whose `=` takes an ECMAScript-style PATTERN (Grammar.targets; api.ts
// targetOps): the portable proof of declared target contexts with containers, a field, and a
// `last` arm (docs/SECOND-LANGUAGE.md, M5). An array or object literal on the left of `=` is a
// pattern whose elements pass the context: an element may carry an initializer (`[a = 1] = x`:
// the `=` node's left operand), a property's value is checked (`{k: v}`), a rest element must be
// the last one with no ',' after it (`[...a, b] = x`, `[...a,] = x` have no parse); `[a + b] = x`,
// `f() = x` have none either: a binary or call node is no leaf of the context.
import {
  token, rule, defineGrammar, left, right, op, targetOps, arm, field,
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
  name: 'patterncalc',
  scopeName: 'source.patterncalc',
  tokens: { Ident, Num },
  prec: [
    right(targetOps('pattern', '=')),
    left('+'),
  ],
  rules: { Expr, Elem, Prop, Stmt, Program },
  targets: {
    pattern: {
      leaves: ['ident', 'paren', 'member', 'shorthand'],
      containers: { array: 'all', object: 'all', spread: 'all', rest: 'all', init: 'value', '=': 'left' },
      last: ['spread', 'rest'],
    },
  },
});
