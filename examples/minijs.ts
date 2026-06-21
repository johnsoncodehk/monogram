// A real JavaScript SUBSET — the grammar that makes the portable Go/Rust targets
// "comparable with oxc": rich enough that parsing a corpus is realistic work
// (strings, comments, the full operator-precedence ladder, call/member/index
// chains, arrays, and the common statement forms), so the emitted Rust parser can
// be benchmarked against oxc on the same bytes.
//
// Derived from ONE definition by emitPortableParser into TypeScript, Go, and Rust;
// the cross-language gate proves all three produce the byte-identical CST that the
// interpreter (createParser) does. The portable lexer is regex-free (char scanner
// driven by token-pattern.ts's structural recognizers), so the Go/Rust output
// compiles offline.
//
// Deliberately omitted (ambiguity / scope, not capability): object literals (the
// `{`-block-vs-object split), ternary, template literals, regex literals, keyword
// operators (typeof/void/...), and `for`. The subset stays unambiguous and real.
import {
  token, rule, defineGrammar, left, right, op, prefix, alt,
  seq, oneOf, range, star, sep, opt, many, altPattern, noneOf, anyChar,
} from '../src/api.ts';

const digit = range('0', '9');
const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');

const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(digit, star(digit)), { scope: 'constant.numeric' });
const Str = token(seq('"', star(altPattern(noneOf('"', '\\'), seq('\\', anyChar()))), '"'), { scope: 'string.quoted.double' });
const LineComment = token(seq('//', star(noneOf('\n'))), { skip: true, scope: 'comment.line' });
const BlockComment = token(seq('/*', star(altPattern(noneOf('*'), seq('*', noneOf('/')))), '*/'), { skip: true, scope: 'comment.block' });

// Operator-precedence ladder (earlier = looser), mirroring JavaScript.
const jsPrec = [
  right('='),
  left('||'), left('&&'),
  left('|'), left('^'), left('&'),
  left('==', '!=', '===', '!=='),
  left('<', '>', '<=', '>='),
  left('<<', '>>'),
  left('+', '-'),
  left('*', '/', '%'),
  right(prefix('!', '-', '+', '~')),
];

const Expr = rule(($) => [
  Number_,
  Str,
  Ident,
  ['(', $, ')'],                        // grouping
  ['[', opt(sep($, ',')), ']'],         // array literal
  [prefix, $],                          // prefix unary
  [$, op, $],                           // binary infix (precedence from the ladder)
  [$, '(', opt(sep($, ',')), ')'],      // call
  [$, '.', Ident],                      // member access
  [$, '[', $, ']'],                     // computed index
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
  name: 'minijs',
  scopeName: 'source.minijs',
  tokens: { Ident, Number: Number_, Str, LineComment, BlockComment },
  prec: jsPrec,
  rules: { Expr, Block, Stmt, Program },
});
