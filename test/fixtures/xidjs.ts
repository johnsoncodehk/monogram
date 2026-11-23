// Fixture: an identifier token that declares its language's Unicode classes (`identifierClasses`),
// here Python's (`_` + XID_Start, XID_Continue) instead of ECMAScript's (`$`, `_`, ZWNJ / ZWJ,
// ID_Start / ID_Continue). The ASCII pattern has no `$`, so every character below is decided by the
// lexer's Unicode fallback, whose classes are the declared ones in the interpreter and every target:
//   `℘`, `ℕ` begin an identifier in both; `ำ` (U+0E33) continues one in both;
//   `ͺ` (U+037A) and `$` begin one in ECMAScript only.
// (ZWNJ is no difference: Unicode 15.1 put it in ID_Continue and XID_Continue alike.)
import { token, rule, defineGrammar, seq, oneOf, range, star, many } from '../../src/api.ts';

const Ident = token(
  seq(oneOf(range('a', 'z'), range('A', 'Z'), '_'), star(oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_'))),
  { identifier: true, identifierClasses: { start: '[_\\p{XID_Start}]', continue: '[\\p{XID_Continue}]' } },
);

const Stmt = rule(() => [[Ident, '=', Ident, ';']]);
const Program = rule(() => [[many(Stmt)]]);

export default defineGrammar({
  name: 'xidjs',
  tokens: { Ident },
  rules: { Stmt, Program },
  entry: Program,
});
