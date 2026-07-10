// minijs + TEMPLATE LITERALS — exercises the portable lexer's second STATEFUL feature
// (stage 4): `${…}` interpolation. The lexer splits `` `a${x}b${y}c` `` into
// $templateHead·$templateMiddle·$templateTail around the holes, tracking a brace-depth
// stack so a nested `{…}` (or a nested template) inside a hole doesn't close it; the
// parser assembles the pieces and interpolated expressions into a `$template` node.
import {
  token, rule, defineGrammar, left, right, op, prefix, alt,
  seq, oneOf, range, star, sep, opt, many, altPattern, noneOf, notFollowedBy,
} from '../../src/api.ts';

const digit = range('0', '9');
const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');

const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(digit, star(digit)), { scope: 'constant.numeric' });
const Str = token(seq('"', star(altPattern(noneOf('"', '\\'), seq('\\', noneOf('\n')))), '"'), { scope: 'string.quoted.double' });
const LineComment = token(seq('//', star(noneOf('\n'))), { skip: true, scope: 'comment.line' });

// NoSubstitution template: backtick body excludes a real `${` (a `$` not followed by `{`
// stays literal); the `template` config drives the interpolated split in the lexer.
const Template = token(
  seq('`', star(altPattern(noneOf('`', '\\', '$'), seq('\\', noneOf('\n')), seq('$', notFollowedBy('{')))), '`'),
  { scope: 'string.template', template: { open: '`', interpOpen: '${', interpClose: '}' } },
);

const jsPrec = [
  right('='),
  left('||'), left('&&'),
  left('+', '-'),
  left('*', '/', '%'),
  right(prefix('!', '-', '+')),
];

const Expr = rule(($) => [
  Number_, Str, Template, Ident,
  ['(', $, ')'],
  ['{', opt(sep(Ident, ',')), '}'],     // shorthand object — gives a hole a nested `{ … }`
  [prefix, $],
  [$, op, $],
  [$, '(', opt(sep($, ',')), ')'],
  [$, '.', Ident],
  [$, Template],                        // tagged template — a postfix-token LED
]);

const Block = rule(($) => [['{', many(Stmt), '}']]);
const Stmt = rule(($) => [
  Block,
  [alt('var', 'let', 'const'), Ident, opt('=', Expr), ';'],
  ['if', '(', Expr, ')', Stmt, opt('else', Stmt)],
  ['return', opt(Expr), ';'],
  [Expr, ';'],
]);
const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'templatejs',
  scopeName: 'source.templatejs',
  tokens: { Ident, Number: Number_, Str, Template, LineComment },
  prec: jsPrec,
  rules: { Expr, Block, Stmt, Program },
});
