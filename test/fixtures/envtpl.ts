// Newline mode + template literals: the portable lexer mode with no windowed relex
// (every edit re-lexes the whole text). Kept tiny so portable-targets gates that mode.
import {
  token, rule, defineGrammar, many, opt, sep, seq, plus, oneOf, range, star, noneOf, never, altPattern, notFollowedBy, left, op,
} from '../../src/api.ts';
import type { NewlineConfig } from '../../src/grammar/types.ts';

const Newline = token(never(), {});
const Ident   = token(plus(oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_')), { identifier: true });
const Comment = token(seq('#', star(noneOf('\n'))), { skip: true });
const Template = token(
  seq('`', star(altPattern(noneOf('`', '\\', '$', '\n'), seq('\\', noneOf('\n')), seq('$', notFollowedBy('{')))), '`'),
  { template: { open: '`', interpOpen: '${', interpClose: '}' } },
);

const Value   = rule(($: any) => [Ident, Template, [$, '(', opt(sep($, ',')), ')'], [$, op, $]]);
const Stmt    = rule(() => [[Ident, '=', Value]]);
const Program = rule(() => [[opt(Stmt), many(Newline, opt(Stmt))]]);

const newline: NewlineConfig = { token: 'Newline', flowOpen: ['('], flowClose: [')'] };

export default defineGrammar({
  name: 'envtpl',
  scopeName: 'source.envtpl',
  tokens: { Comment, Ident, Template, Newline },
  prec: [left('+')],
  rules: { Value, Stmt, Program },
  entry: Program,
  expression: Value,
  newline,
});
