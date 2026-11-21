// Fixture: literals of every shape a literal id is looked up by. The portable targets' lid_of
// finds a token's literal id from its text, through a length × first-unit prefilter and (Rust)
// a table split by first-byte class; each shape here is one a narrower prefilter or split once
// missed or could miss:
//   - `@` and `@@`: first byte `@`, not followed by an identifier start (not a keyword shape);
//   - `café`: a keyword whose UTF-16 length (4) differs from its UTF-8 length (5);
//   - `$x`, `_`: keywords led by `$` / `_`;
//   - `at`, `ate`: a word that is a prefix of another word and of identifiers (`atom`).
// Each statement is one literal, then an identifier, then `;`.
import { token, rule, defineGrammar, seq, oneOf, range, star, many } from '../../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });

const Stmt = rule(() => [
  ['@', Ident, ';'],
  ['@@', Ident, ';'],
  ['café', Ident, ';'],
  ['$x', Ident, ';'],
  ['_', Ident, ';'],
  ['at', Ident, ';'],
  ['ate', Ident, ';'],
]);
const Program = rule(() => [many(Stmt)]);

export default defineGrammar({
  name: 'lidshapes',
  scopeName: 'source.lidshapes',
  tokens: { Ident },
  prec: [],
  rules: { Stmt, Program },
});
