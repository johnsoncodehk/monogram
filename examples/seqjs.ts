// Exercises a grouped sub-sequence `seq` step: comma lists written as `star([',', $])` (a
// star whose body is the two-element sequence `, Expr`) rather than `sep(...)`, the shape
// javascript.ts uses for argument/array/sequence lists.
import {
  token, rule, defineGrammar, left, op,
  seq, oneOf, range, star, opt, many,
} from '../src/api.ts';
// `many(',', $)` is the rule-level `(',' Expr)*` — a star whose body is the sequence
// `, Expr`, exactly the shape javascript.ts uses for comma lists.

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });

const jsPrec = [left('+', '-'), left('*', '/')];
const Expr = rule(($) => [
  Number_, Ident,
  ['(', $, ')'],
  ['[', opt($, many(',', $)), ']'],               // array literal via star(seq)
  [$, op, $],
  [$, '(', opt($, many(',', $)), ')'],            // call args via star(seq)
]);
const Stmt = rule(($) => [[Expr, ';']]);
const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'seqjs',
  scopeName: 'source.seqjs',
  tokens: { Ident, Number: Number_ },
  prec: jsPrec,
  rules: { Expr, Stmt, Program },
});
