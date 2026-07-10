// A token-stress grammar for the portable lexer's GENERAL matcher (stage 1 of real-grammar
// support). It uses the STATELESS real-JS token shapes the 4-shape fast paths can't handle —
// `\u`-escaped identifiers, the decimal/hex number family with a `(?!IdentChar)` boundary,
// both-quote strings with escapes, and comments — so the portable lexer must compile the raw
// token-pattern AST to a backtracking-free matcher. A trivial parser (a stream of value
// tokens) makes the emitted CST essentially the token stream, so checking it against
// createParser verifies the LEXER. (Stateful tokens — regex, templates — are NOT here; they
// need cross-token lexer state, the next stage.)
import {
  token, rule, defineGrammar,
  seq, oneOf, range, star, plus, repeat, optPattern, altPattern, noneOf, anyChar, notFollowedBy, many,
} from '../../src/api.ts';

const digit = range('0', '9');
const hexDigit = oneOf(digit, range('a', 'f'), range('A', 'F'));
const idChar = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const uEsc = altPattern(seq('\\u', repeat(hexDigit, 4, 4)), seq('\\u{', plus(hexDigit), '}'));
const boundary = notFollowedBy(idChar);   // a number can't be glued to an identifier char

const Hex = token(seq('0', oneOf('x', 'X'), plus(hexDigit), boundary), { scope: 'constant.numeric.hex' });
const Number_ = token(seq(plus(digit), star(seq('_', plus(digit))), optPattern(seq('.', plus(digit))), boundary), { scope: 'constant.numeric' });
const Ident = token(seq(altPattern(oneOf(range('a', 'z'), range('A', 'Z'), '_', '$'), uEsc), star(altPattern(idChar, uEsc))), { identifier: true });
const Str = token(altPattern(
  seq('"', star(altPattern(noneOf('"', '\\'), seq('\\', anyChar()))), '"'),
  seq("'", star(altPattern(noneOf("'", '\\'), seq('\\', anyChar()))), "'"),
), { scope: 'string.quoted' });
const LineComment = token(seq('//', star(noneOf('\n'))), { skip: true, scope: 'comment.line' });
const BlockComment = token(seq('/*', star(altPattern(noneOf('*'), seq('*', noneOf('/')))), '*/'), { skip: true, scope: 'comment.block' });

// Value = one value token; Program = a stream of them. (Lexer-level disambiguation — Hex vs
// Number — comes from token DECLARATION ORDER, which both engines follow.)
const Value = rule(($) => [Hex, Number_, Ident, Str]);
const Program = rule(($) => [many(Value)]);

export default defineGrammar({
  name: 'richtokens',
  scopeName: 'source.richtokens',
  tokens: { Hex, Number: Number_, Ident, Str, LineComment, BlockComment },
  rules: { Value, Program },
});
