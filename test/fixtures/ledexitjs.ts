// A led whose connector is also a postfix operator: `a!(b)` is the led `$ '!' '(' $ ')'`, and
// `a!` alone is the postfix `!`. When the led fails after its connector (`a!;`), the reference
// goes on to the operator table, where the postfix binds; a portable engine that ends its LED loop
// once a lid's leds failed must not end it for this lid (emit-portable prattLedExits).
import {
  token, rule, defineGrammar, left, postfix, op,
  seq, oneOf, range, star, many,
} from '../../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });

const prec = [
  left('+'),
  left(postfix('!')),
];

const Expr = rule(($) => [
  Ident,
  ['(', $, ')'],
  [$, op, $],
  [$, '!', '(', $, ')'],   // a led led by the postfix operator's literal
  [$, postfix],
]);
const Stmt = rule(($) => [[Expr, ';']]);
const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'ledexitjs',
  scopeName: 'source.ledexitjs',
  tokens: { Ident },
  prec,
  rules: { Expr, Stmt, Program },
});
