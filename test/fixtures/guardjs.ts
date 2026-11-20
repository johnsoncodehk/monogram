// The portable parsers try a longest-match candidate only where its Guard admits the lookahead,
// and reach the candidates a token admits through a Dispatch (emit-portable.ts). Each shape below
// fails if one of them is applied where it does not hold:
//   • tie across Dispatch sections: `go;` is matched by `[Name, ';']` (keyed on the Ident kind)
//     and by `['go', ';']` (keyed on the literal, a section tried first); they tie and the
//     earlier-declared `Name` form wins, so a target that kept the first-tried candidate on a
//     tie builds `Stmt[go ;]` instead of `Stmt[Name ;]`. The same in a Pratt rule: `self` is
//     both the literal arm `'self'` and the arm `[Name]`; `nil` is the earlier-declared literal
//     arm, so it keeps the tie against `[Name]` tried after it.
//   • SECOND guard: `[Ident, ':', Stmt]` is tried only when the token after the identifier is
//     `:` — `x: y;` is a labelled statement, `x;` and `x y;` are not.
//   • no SECOND guard where a one-token match exists: `[Ident, opt('!', Ident)]` matches `x`
//     alone, so a guard on its second token (`!`) would refuse `{x}` (`[Ident, '?']` shares its
//     first token, so the alternatives are longest-match candidates, not a predictive switch).
import { token, rule, defineGrammar, left, op, seq, oneOf, range, star, opt, many, not } from '../../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });

const Name = rule(() => [Ident]);
const Expr = rule(($) => [
  'nil',
  [Name],
  'self',
  Number_,
  ['(', $, ')'],
  [$, op, $],
]);
const Atom = rule(() => [
  [Ident, opt('!', Ident)],
  [Ident, '?'],
  ['[', ']'],
]);
const Stmt = rule(($) => [
  ['stop', ';'],
  [Name, ';'],
  ['go', ';'],
  [Ident, ':', $],
  ['{', Atom, '}'],
  [not('go'), not('stop'), Expr, ';'],
]);
const Program = rule(() => [many(Stmt)]);

export default defineGrammar({
  name: 'guardjs',
  scopeName: 'source.guardjs',
  tokens: { Ident, Number: Number_ },
  prec: [left('+', '-')],
  rules: { Name, Expr, Atom, Stmt, Program },
});
