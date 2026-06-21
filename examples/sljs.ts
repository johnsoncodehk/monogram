// Exercises the `sameLine` zero-width assertion (no line terminator before the next token).
// A `return` takes a value only when it is on the SAME line (ASI-style restricted production):
// `return 1;` keeps the value, `return\n1;` does not. Verifies the lexer's newline-before
// tracking — including a block comment that spans a newline.
import {
  token, rule, defineGrammar, left, op,
  seq, oneOf, range, star, opt, many, altPattern, noneOf, sameLine,
} from '../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });
const LineComment = token(seq('//', star(noneOf('\n'))), { skip: true, scope: 'comment.line' });
const BlockComment = token(seq('/*', star(altPattern(noneOf('*'), seq('*', noneOf('/')))), '*/'), { skip: true, scope: 'comment.block' });

const jsPrec = [left('+', '-'), left('*', '/')];
const Expr = rule(($) => [Number_, Ident, ['(', $, ')'], [$, op, $]]);
const Ret = rule(($) => [['return', opt(sameLine, Expr), ';']]);   // `return` + a SAME-LINE value
const Stmt = rule(($) => [Ret, [Expr, ';']]);
const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'sljs',
  scopeName: 'source.sljs',
  tokens: { Ident, Number: Number_, LineComment, BlockComment },
  prec: jsPrec,
  rules: { Expr, Ret, Stmt, Program },
});
