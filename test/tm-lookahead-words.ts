// Gate: a word inside a lookahead is not that word occurring there.
//
// `not(x)` / `not(not(x))` consume nothing; what they hold says what may FOLLOW the position,
// not what is matched at it. The TextMate generator reads one fact off lookaheads on purpose:
// which words are reserved, i.e. excluded from the identifier token (`[not(alt('class', …)),
// Ident]`). A lookahead that only conditions what follows a keyword (`'export'` is a modifier
// unless `type` comes next with no name after it) excludes no identifier, so it must not make
// its words reserved: a reserved declaration keyword loses its declaration-only scope (the flat
// `\btype\b` match instead of the one that abstains before `.` / `?.`, so `type.x` would paint
// `type` as the keyword).
//
// The fixture has four declaration keywords, each scoped `storage.type.*`:
//   class      reserved: excluded from the identifier by a guard before `Word`
//   type       a valid identifier; also in a member-position lookahead after `export`, followed
//              by a further condition (`not(['type', not(Word)])`)
//   interface  a valid identifier; also in a positive lookahead after `declare`
//              (`not(not(['interface', Word]))`)
//   enum       a valid identifier; also excluded, alone, after `const` (`'const' not('enum') '{'`),
//              where what follows is no identifier
//
// Run with: node test/tm-lookahead-words.ts
import { token, rule, defineGrammar, alt, many, opt, not, seq, plus, star, oneOf, range } from '../src/api.ts';
import { generateTmLanguage } from '../src/gen-tm.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { if (cond) ok++; else { fail++; console.log('  ✗', label); } };

const WS = token(plus(oneOf(' ', '\t', '\n')), { skip: true });
const Word = token(seq(oneOf(range('a', 'z'), range('A', 'Z')), star(oneOf(range('a', 'z'), range('A', 'Z')))), { identifier: true });

const notReserved = not(alt('class', 'new'));
const Ty = rule(() => [Word]);
const Member = rule(() => [[
  opt(alt(
    ['export', not(['type', not(Word)])],
    ['declare', not(not(['interface', Word]))],
  )),
  Word, ':', Ty, ';',
]]);
const Expr = rule(($: any) => [[notReserved, Word], [$, '.', Word], ['new', Word]]);
const Decl = rule(() => [
  ['class', Word, '{', many(Member), '}'],
  ['interface', Word, '{', many(Member), '}'],
  ['type', Word, '=', '{', many(Member), '}'],
  ['enum', Word, '{', '}'],
  ['const', not('enum'), '{', '}'],
]);
const Stmt = rule(() => [Decl, [Expr, ';']]);
const Program = rule(() => [[many(Stmt)]]);

const g = defineGrammar({
  name: 'lookahead', scopeName: 'source.lookahead',
  tokens: { WS, Word },
  scopes: {
    'storage.type.class': ['class'],
    'storage.type.interface': ['interface'],
    'storage.type.type': ['type'],
    'storage.type.enum': ['enum'],
  },
  rules: { Ty, Member, Expr, Decl, Stmt, Program }, entry: Program,
});
const repo = generateTmLanguage(g).repository as Record<string, { match?: string }>;
// The flat keyword match of a word, and whether it abstains before a member accessor.
const entryOf = (word: string) => Object.entries(repo).find(([, v]) => typeof v.match === 'string' && new RegExp(`\\\\b\\((?:[a-z|]*\\|)?${word}(?:\\|[a-z|]*)?\\)\\\\b`).test(v.match));
const abstainsBeforeAccessor = (word: string) => !!entryOf(word)?.[1].match?.includes('(?!\\s*(?:\\.');

for (const w of ['type', 'interface', 'enum']) {
  check(`'${w}' has a keyword match`, !!entryOf(w));
  check(`'${w}' (a valid identifier, also inside a lookahead) keeps its declaration-only scope: abstains before '.'`, abstainsBeforeAccessor(w));
}
// Negative: a word the grammar excludes from the identifier token stays reserved.
check(`'class' has a keyword match`, !!entryOf('class'));
check(`'class' (excluded from the identifier) keeps the flat match`, !abstainsBeforeAccessor('class'));

console.log(fail === 0 ? `\n${ok}/${ok} lookahead-word checks pass` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
