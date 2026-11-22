// A lookahead's body is printed in recognize form (emit-portable.ts, Forms): it advances and
// reports whether it matched, building nothing. Each shape below fails if a form is missing or
// does not do what the building form does:
//   • a rule reached both from a lookahead and from a consuming position (`Head`: the `if` arm's
//     `not(Head)` and the first arm) has both forms; its longest match ties (`x:` is matched by
//     both alternatives' prefixes, `x::` only by the second), so a recognize form that kept the
//     first candidate would end in the wrong place (`on x::1;`).
//   • a rule reached only from lookaheads (`Only`, recursive) has only its recognize form, and it
//     too ends where its longest alternative ends (`do x.y;`).
//   • a lookahead that reaches a Pratt rule (`go`: `not([Expr, '='])`), directly or through an rd
//     rule (`at`: `Wrap` calls `Expr`), runs the Pratt rule's building form and drops the node,
//     undoing what it built along with the position.
//   • a `suppress` step inside a lookahead (`in`: `exclude('in', Expr)`) disables its connector (the
//     led `[$, 'in', $]`) there as it does anywhere: `in a in b;` is refused because the lookahead's `Expr` stops
//     before the second `in`.
import { token, rule, defineGrammar, left, op, seq, oneOf, range, star, many, opt, not, exclude } from '../../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });

const Expr = rule(($) => [
  Ident,
  Number_,
  ['(', $, ')'],
  [$, op, $],
  [$, 'in', $],
]);
const Head = rule(() => [
  [Ident, ':'],
  [Ident, ':', ':'],
]);
const Only = rule(($) => [
  [Ident],
  [Ident, '.', Ident],
  ['(', $, ')'],
]);
const Wrap = rule(() => [['[', Expr, ']']]);
const Stmt = rule(() => [
  [Head, Expr, ';'],
  ['if', not(Head), Expr, ';'],
  ['on', not(not([Head, Number_])), Ident, ':', ':', Number_, ';'],
  ['do', not(not([Only, ';'])), Ident, opt('.', Ident), ';'],
  ['go', not([Expr, '=']), Expr, ';'],
  ['go', Expr, '=', Expr, ';'],
  ['at', not(not([Wrap, '!'])), Wrap, '!', ';'],
  ['in', not(not([exclude('in', Expr), ';'])), Expr, ';'],
]);
const Program = rule(() => [many(Stmt)]);

export default defineGrammar({
  name: 'lookrec',
  scopeName: 'source.lookrec',
  tokens: { Ident, Number: Number_ },
  prec: [left('+', '-')],
  rules: { Expr, Head, Only, Wrap, Stmt, Program },
});
