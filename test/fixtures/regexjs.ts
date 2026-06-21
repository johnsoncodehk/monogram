// minijs + REGEX literals — exercises the portable lexer's STATEFUL regex-vs-division
// disambiguation (stage 3). A `/` is a regex in expression context but division after a
// value; `if (x) /re/` is a regex (control-head paren), `obj.for(x) / y` is division
// (member name, not a head). The regexContext config + paren-head/bang state are ported
// from createLexer; the gate checks the emitted CST is byte-identical on inputs that mix
// regex literals and division.
import {
  token, rule, defineGrammar, left, right, op, prefix, alt,
  seq, oneOf, range, star, sep, opt, many, altPattern, noneOf, anyChar,
} from '../../src/api.ts';

const digit = range('0', '9');
const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');

const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(digit, star(digit)), { scope: 'constant.numeric' });
const Str = token(seq('"', star(altPattern(noneOf('"', '\\'), seq('\\', anyChar()))), '"'), { scope: 'string.quoted.double' });
const LineComment = token(seq('//', star(noneOf('\n'))), { skip: true, scope: 'comment.line' });
const BlockComment = token(seq('/*', star(altPattern(noneOf('*'), seq('*', noneOf('/')))), '*/'), { skip: true, scope: 'comment.block' });

// Regex literal: `/ body / flags`, body is non-(/\[)newline chars, escapes, or `[...]` classes.
const rxClass = seq('[', star(altPattern(noneOf(']', '\\', '\n'), seq('\\', noneOf('\n')))), ']');
const rxChar = altPattern(noneOf('/', '\\', '[', '\n'), seq('\\', noneOf('\n')), rxClass);
const rxFirst = altPattern(noneOf('/', '\\', '[', '*', '\n'), seq('\\', noneOf('\n')), rxClass);
const Regex = token(seq('/', rxFirst, star(rxChar), '/', star(idCont)), {
  regex: true, scope: 'string.regexp',
  regexContext: {
    divisionAfterTypes: ['Ident', 'Number', 'Str'],
    divisionAfterTexts: [')', ']', 'this', 'true', 'false', 'null'],
    regexAfterTexts: ['return', 'typeof', 'delete', 'void', 'in', 'instanceof', 'new', 'do', 'else'],
    regexAfterParenKeywords: ['if', 'while', 'for'],
    memberAccessTexts: ['.'],
    postfixAfterValueTexts: [],
  },
});

const jsPrec = [
  right('='),
  left('||'), left('&&'),
  left('==', '!=', '===', '!=='),
  left('<', '>', '<=', '>='),
  left('+', '-'),
  left('*', '/', '%'),
  right(prefix('!', '-', '+', '~')),
];

const Expr = rule(($) => [
  Number_, Str, Ident, Regex,
  ['(', $, ')'],
  ['[', opt(sep($, ',')), ']'],
  [prefix, $],
  [$, op, $],
  [$, '(', opt(sep($, ',')), ')'],
  [$, '.', Ident],
  [$, '[', $, ']'],
]);

const Block = rule(($) => [['{', many(Stmt), '}']]);
const Stmt = rule(($) => [
  Block,
  [alt('var', 'let', 'const'), Ident, opt('=', Expr), ';'],
  ['if', '(', Expr, ')', Stmt, opt('else', Stmt)],
  ['while', '(', Expr, ')', Stmt],
  ['return', opt(Expr), ';'],
  ['function', Ident, '(', opt(sep(Ident, ',')), ')', Block],
  [Expr, ';'],
]);
const Program = rule(($) => [many(Stmt)]);

export default defineGrammar({
  name: 'regexjs',
  scopeName: 'source.regexjs',
  tokens: { LineComment, BlockComment, Number: Number_, Str, Regex, Ident },
  prec: jsPrec,
  rules: { Expr, Block, Stmt, Program },
});
