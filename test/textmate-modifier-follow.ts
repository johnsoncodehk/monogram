// Gate: what follows a modifier word is read past zero-width and optional items.
//
// The TextMate generator scopes a `storage.modifier` word as a CONTEXTUAL modifier (a match that
// requires a member or binding name after it: `public x`, never `public(`) when every token that
// can follow the word in the grammar begins a name. That FOLLOW set is the FIRST set of the next
// item, and a lookahead (`not(…)`) or an `opt(…)` consumes nothing, so the next item's FIRST set
// includes what comes after it. A lookahead says what may FOLLOW; it is no follower itself.
// Reading the lookahead as the follower (or stopping at an optional item) hides the `(` / `<`
// that follow the word in an arrow-like form, and the word is wrongly painted only before a name.
//
// The fixture has three modifier words:
//   async   before an arrow-like form: `async <T>(a)` or `async (a)`, with a lookahead between
//           the word and the optional type-parameter list: followed by `<` and `(`, so it stays a
//           flat keyword match
//   lazy    before `*`? then `(`: flat (the `opt('*')`, whose `*` alone would begin a member, is
//           looked past)
//   public  before a computed member name (`*`? `[`), past a lookahead: contextual
// `async` and `lazy` also begin a computed member (`async [x];`), so a `<` / `(` the reading
// misses would make them contextual.
//
// Run with: node test/textmate-modifier-follow.ts
import { token, rule, defineGrammar, alt, many, opt, not, seq, plus, star, oneOf, range } from '../src/api.ts';
import { generateTmLanguage } from '../src/gen-textmate.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { if (cond) ok++; else { fail++; console.log('  ✗', label); } };

const WS = token(plus(oneOf(' ', '\t', '\n')), { skip: true });
const Word = token(seq(oneOf(range('a', 'z'), range('A', 'Z')), star(oneOf(range('a', 'z'), range('A', 'Z')))), { identifier: true });

const TypeParams = rule(() => [['<', Word, '>']]);
const Member = rule(() => [
  ['public', not('x'), opt('*'), '[', Word, ']', ';'],
  [alt('async', 'lazy'), '[', Word, ']', ';'],   // also before a computed member: what follows decides
]);
const Expr = rule(() => [
  Word,
  ['async', not(['<', not(Word)]), opt(TypeParams), '(', Word, ')'],
  ['lazy', opt('*'), '(', Word, ')'],
]);
const Stmt = rule(() => [['class', Word, '{', many(Member), '}'], [Expr, ';']]);
const Program = rule(() => [[many(Stmt)]]);

const g = defineGrammar({
  name: 'modfollow', scopeName: 'source.modfollow',
  tokens: { WS, Word },
  scopes: { 'storage.modifier': ['async', 'lazy', 'public'], 'storage.type.class': ['class'] },
  rules: { TypeParams, Member, Expr, Stmt, Program }, entry: Program,
});
const repo = generateTmLanguage(g).repository as Record<string, { match?: string }>;
const entriesOf = (word: string) => Object.values(repo).filter(v => typeof v.match === 'string' && new RegExp(`\\\\b\\((?:[a-z|]*\\|)?${word}(?:\\|[a-z|]*)?\\)\\\\b`).test(v.match));
// A contextual modifier's match requires what follows (`(?=\s+…)`); a flat one does not.
const contextual = (word: string) => entriesOf(word).some(v => v.match!.includes(')\\b(?=\\s+'));
const flat = (word: string) => entriesOf(word).some(v => !v.match!.includes(')\\b(?='));

for (const w of ['async', 'lazy']) {
  check(`'${w}' has a keyword match`, entriesOf(w).length > 0);
  check(`'${w}' (followed by '<' or '(') is a flat modifier match, not one that requires a name after it`, flat(w) && !contextual(w));
}
check(`'public' (followed by a member start, past a lookahead and an optional '*') is a contextual modifier`, contextual('public'));

console.log(fail === 0 ? `\n${ok}/${ok} modifier-follow checks pass` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
