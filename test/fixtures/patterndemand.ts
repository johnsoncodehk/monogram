// patterncalc's ECMAScript-style pattern in its ON-DEMAND form (AssignTargetContext.when 'demand';
// assign-targets.ts planDemand): the normal parse computes nothing, a container on the left of
// `=` is parsed again by its accumulating twin. A demand context's leaves are the arms the shallow
// check takes, so `f() = x`, `1 = x`, `[f()] = x` parse here (they do not in patterncalc); `[a + b] =
// x` and a rest element that is not last do not. `patternGrammar('eager')` is the same context
// computed in every form (patterndemand-eager.ts): both must give the same verdicts.
import {
  token, rule, defineGrammar, left, right, op, assignTargetOps, arm, field,
  seq, oneOf, range, star, many, opt, sep,
} from '../../src/api.ts';

const identStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const identPart = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_');
const Ident = token(seq(identStart, star(identPart)), { identifier: true, scope: 'variable' });
const Num = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });

export function patternGrammar(when: 'eager' | 'demand') {
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
  return defineGrammar({
    name: when === 'demand' ? 'patterndemand' : 'patterndemandeager',
    scopeName: `source.patterndemand${when === 'demand' ? '' : 'eager'}`,
    tokens: { Ident, Num },
    prec: [
      right(assignTargetOps('pattern', '=')),
      left('+'),
    ],
    rules: { Expr, Elem, Prop, Stmt, Program },
    assignTargets: {
      pattern: {
        leaves: ['ident', 'num', 'paren', 'member', 'call', 'shorthand'],
        containers: { array: 'all', object: 'all', spread: 'all', rest: 'all', init: 'value', '=': 'left' },
        last: ['spread', 'rest'],
        when,
      },
    },
  });
}

export default patternGrammar('demand');
