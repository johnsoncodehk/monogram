// Fixture: literals and delimiters beyond ASCII. A character beyond ASCII is one or two UTF-16
// units (the interpreter's and the TS target's) but two to four UTF-8 bytes (Go's and Rust's), so
// every length the generator prints for a literal has to be its length in the target's units:
//   - punctuators of 2-, 3- and 4-byte characters (`±` `¬` `§`, `→` `≠`, `🜂`), each alone, as the
//     prefix of a longer literal (`→` / `→→`, `≠` / `≠=`, `🜂` / `🜂=`), and led by an ASCII
//     character that is a literal of its own (`-` / `-→`);
//   - a composed `>` operator whose last character is beyond ASCII (`>` `→` → `>→`);
//   - a string, a line comment, a block comment and a template whose delimiters are beyond ASCII
//     (`¦…¦`, `※…`, `«…»`, `‖…¤⟨…⟩…‖`);
//   - a token whose pattern gives back repeats of a literal beyond ASCII (`^°*(?!;)`): the repeats
//     end one literal apart, two bytes in Go / Rust, so `^°;` is the Deg `^` then `°` `;` there
//     too, never a Deg ending inside the `°`.
import {
  token, rule, defineGrammar, left, right, op, prefix, postfix,
  seq, oneOf, range, star, many, altPattern, noneOf, notFollowedBy, anyChar,
} from '../../src/api.ts';

const digit = range('0', '9');
const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');

const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(digit, star(digit)), { scope: 'constant.numeric' });
const Str = token(seq('¦', star(altPattern(noneOf('¦', '\\'), seq('\\', anyChar()))), '¦'), { scope: 'string.quoted.other' });
const LineComment = token(seq('※', star(noneOf('\n'))), { skip: true, scope: 'comment.line' });
const BlockComment = token(seq('«', star(seq(notFollowedBy('»'), anyChar())), '»'), { skip: true, scope: 'comment.block' });
const Template = token(
  seq('‖', star(altPattern(noneOf('‖', '\\', '¤'), seq('\\', noneOf('\n')), seq('¤', notFollowedBy('⟨')))), '‖'),
  { scope: 'string.template', template: { open: '‖', interpOpen: '¤⟨', interpClose: '⟩' } },
);
const Deg = token(seq('^', star('°'), notFollowedBy(';')), { scope: 'constant.other' });

const prec = [
  left('→', '≠', '≠=', '±', '🜂', '🜂='),
  left('>', '>→'),
  left('+', '-'),
  right(prefix('-', '¬')),
  left(postfix('°')),
];

const Expr = rule(($) => [
  Number_, Str, Template, Deg, Ident,
  ['(', $, ')'],
  [prefix, $],
  [$, op, $],
  [$, postfix],
]);

const Stmt = rule(() => [
  ['let', Ident, '=', Expr, ';'],
  ['§', Ident, ';'],
  ['→→', Expr, ';'],
  ['-→', Ident, ';'],
  ['>', Expr, ';'],
  [Expr, ';'],
]);
const Program = rule(() => [many(Stmt)]);

export default defineGrammar({
  name: 'unilits',
  scopeName: 'source.unilits',
  tokens: { Ident, Number: Number_, Str, Template, Deg, LineComment, BlockComment },
  prec,
  rules: { Expr, Stmt, Program },
  expression: Expr,
});
