// Isolated newline-mode grammar (dotenv / env-spec flavour) for portable-targets gate.
// Exercises engine-emitted NEWLINE tokens: line-boundary separators, flow ( … ) suspension,
// blank-line folding, comment-only lines — with NO indent stack (see test/newline-mode.ts).
import {
  token, rule, defineGrammar, many, opt, sep, seq, plus, oneOf, range, star, noneOf, never,
} from '../../src/api.ts';
import type { NewlineConfig } from '../../src/types.ts';

const Newline = token(never(), {});
const Ident   = token(plus(oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_')), { identifier: true });
const Comment = token(seq('#', star(noneOf('\n'))), { skip: true });

const Value   = rule(($: any) => [Ident, [Ident, '(', sep($, ','), ')']]);
const Stmt    = rule(() => [[Ident, '=', Value]]);
const Program = rule(() => [[opt(Stmt), many(Newline, opt(Stmt))]]);

const newline: NewlineConfig = { token: 'Newline', flowOpen: ['('], flowClose: [')'], comment: '#' };

export default defineGrammar({
  name: 'envspec',
  scopeName: 'source.envspec',
  tokens: { Comment, Ident, Newline },
  rules: { Value, Stmt, Program },
  entry: Program,
  newline,
});
