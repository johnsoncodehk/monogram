// A word literal is lexed as the identifier token, so an alternative led by a word does not
// exclude one led by the identifier: when the word's alternative fails, the identifier's must
// still be tried. Both an inline `alt(...)` (ordered choice) and a rule's own alternatives
// (longest match) have such a pair here, with nothing before it that a dispatch could lean on.
import { token, rule, defineGrammar, seq, oneOf, range, star, many, alt } from '../../src/api.ts';

const digit = range('0', '9');
const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(digit, star(digit)), { scope: 'constant.numeric' });

// inline: `let get x;` (the word, then a name) or `let get = 1;` (the word as the name)
const Let = rule(() => [['let', alt(['get', Ident], [Ident, '=', Number_]), ';']]);
// rule alternatives: `get x()` or `get()`
const Call = rule(() => [['get', Ident, '(', ')'], [Ident, '(', ')']]);
const Stmt = rule(() => [Let, ['do', Call, ';']]);
const Program = rule(() => [many(Stmt)]);

export default defineGrammar({
  name: 'wordjs',
  scopeName: 'source.wordjs',
  tokens: { Ident, Number: Number_ },
  rules: { Let, Call, Stmt, Program },
});
