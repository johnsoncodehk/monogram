// Exercises precedence-gated mixfix LEDs: the ternary `? :` (a led that binds LOOSER than the
// operators, so `a == b ? c : d` groups as `(a == b) ? c : d`) and `in`/`instanceof` (chain-rhs
// leds at the relational level — `a in b in c` left-chains as `(a in b) in c`). Both need the
// led-precedence gate the portable parser previously lacked (its mixfix leds bound maximally tight).
import {
  token, rule, defineGrammar, left, right, op,
  seq, oneOf, range, star, many,
} from '../../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });

const jsPrec = [
  right('='),
  left('||'),
  left('==', '!='),
  left('<', '>'),
  left('+', '-'),
  left('*', '/'),
];

const Expr = rule(($) => [
  Number_, Ident,
  ['(', $, ')'],
  [$, op, $],
  [$, '?', $, ':', $],          // ternary (binds below `||`)
  [$, 'in', $],                 // relational chain-rhs
  [$, 'instanceof', $],
]);
const Stmt = rule(($) => [[Expr, ';']]);
const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'ledjs',
  scopeName: 'source.ledjs',
  tokens: { Ident, Number: Number_ },
  prec: jsPrec,
  ledPrec: [
    { connector: '?', below: '||' },
    { connector: 'in', sameAs: '<', chainRhs: true },
    { connector: 'instanceof', sameAs: '<', chainRhs: true },
  ],
  rules: { Expr, Stmt, Program },
});
