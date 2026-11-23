// The example grammar of the DECISION REPORT (`node src/cli.ts test/fixtures/decisionsjs.ts
// --decisions` writes test/fixtures/decisionsjs.decisions.md, the page README's "Adding a language"
// points at). It is small on purpose and has one finding of each kind a grammar author meets
// first: no word is reserved here, so Ident admits `true` and `this`:
//   • `'true'` is a DEAD alternative: Ident, declared first, takes every token it admits;
//   • `['this', opt('.', Ident)]` TIES Ident on a lone `this`: declaration order decides there.
import { token, rule, defineGrammar, left, op, seq, oneOf, range, star, opt, many } from '../../src/api.ts';

const digit = range('0', '9');
const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');

const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(digit, star(digit)), { scope: 'constant.numeric' });

const Expr = rule(($) => [
  Ident,
  Number_,
  'true',
  ['this', opt('.', Ident)],
  ['(', $, ')'],
  [$, op, $],
]);
const Stmt = rule(($) => [[Expr, ';']]);
const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'decisionsjs',
  scopeName: 'source.decisionsjs',
  tokens: { Ident, Number: Number_ },
  prec: [left('+', '-'), left('*', '/')],
  rules: { Expr, Stmt, Program },
});
