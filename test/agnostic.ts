// Proof that gen-parser is language-agnostic: a tiny grammar whose tokens are
// named NOTHING like TypeScript's, with no template/regex/backtick at all, run
// on the same engine. If the engine still hardcoded 'Ident'/'Template'/backtick,
// these assertions would fail.
import { token, rule, defineGrammar, alt, many, opt, sep, none } from '../src/api.ts';
import { createParser } from '../src/gen-parser.ts';
import { generateLanguageConfig } from '../src/gen-vscode-config.ts';
import { generateTmLanguage } from '../src/gen-tm.ts';

const Word = token(/[a-z]+/, { identifier: true });   // identifier token, ASCII-only on purpose, NOT named "Ident"
const Num = token(/[0-9]+/);
const Program = rule(($: any) => [many(alt(Word, Num, '+'))]);

const g = defineGrammar({ name: 'mini', tokens: { Word, Num }, rules: { Program }, entry: Program });
const { tokenize, parse } = createParser(g);

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { cond ? ok++ : (fail++, console.log('  ✗', label)); };

// 1. Ordinary identifier → tagged with the DECLARED token name, not 'Ident'.
check("ident token named 'Word'", tokenize('foo')[0].type === 'Word');

// 2. Unicode identifier the ASCII pattern can't match → engine's Unicode fallback
//    must tag it with the DECLARED identifier name ('Word'), proving no hardcoded 'Ident'.
const uni = tokenize('Ωmega');
check("unicode fallback uses declared name", uni[0].type === 'Word' && uni[0].text === 'Ωmega');

// 3. No template token declared → a backtick is NOT specially handled (it's an
//    unexpected char), proving the template machinery is gated on the declaration.
let backtickHandled = true;
try { tokenize('`x`'); } catch { backtickHandled = false; }
check('template machinery gated off when undeclared', !backtickHandled);

// 4. The whole thing parses end-to-end on the shared engine.
check('parses on the shared engine', parse('foo + 12 + bar').kind === 'node');

// 5. gen-vscode-config derives string delimiters from the `string` flag, not a
//    hardcoded JS quote set: a `~…~` string token must yield `~` (and never `"`).
const Str = token(/~[^~]*~/, { string: true });
const StrProg = rule(() => [Word, Str]);
const gc = defineGrammar({ name: 'mini2', tokens: { Word, Str }, rules: { StrProg }, entry: StrProg });
const cfg = generateLanguageConfig(gc);
check('language-config quotes derived from grammar (~, not hardcoded \")',
  !!cfg.surroundingPairs?.some(p => p[0] === '~') && !cfg.surroundingPairs?.some(p => p[0] === '"'));

// 6. gen-tm's `.tsx` generic-arrow ⇄ JSX-tag disambiguation skip-set derives its
//    opaque attribute-string delimiter from the `string`-flagged token too — NOT a
//    hardcoded `"`/`'`. A tiny TS-family-JSX grammar (JSX `/>`/`</` tokens + `<…>`
//    generics) whose strings are `~…~` must produce a carve-out that treats `~…~`
//    as opaque (`~[^~]*~`) and never mentions `"[^"]*"`. Proves the JSX delimiter
//    derivation (jsxDisambigDelims) is data-driven, like gen-vscode-config's quotes.
const JTilde   = token(/~[^~]*~/, { string: true });    // ← non-quote attr-string delimiter
const JSelfEnd = token(/\/>/);                           // JSX self-closing tag
const JCloseTg = token(/<\//);                           // JSX close-tag opener
const JType    = rule(() => [[Word]]);
const JGeneric = rule(($: any) => [['<', sep(JType, ','), '>', '(', sep($, ','), ')']]);  // <T, U>(…) generics
const JElement = rule(($: any) => [['<', Word, opt(JTilde), alt(JSelfEnd, ['>', JCloseTg, Word, '>'])]]); // <Tag …/> JSX
const JExpr    = rule(() => [Word, JTilde, JGeneric, JElement]);
const JProgram = rule(() => [[many(JExpr)]]);
const gj = defineGrammar({
  name: 'minijsx', scopeName: 'source.minijsx',
  tokens: { JSelfEnd, JCloseTg, JTilde, Word },
  prec: [none('<', '>')],
  rules: { JType, JGeneric, JElement, JExpr, JProgram }, entry: JProgram,
});
const jbegin = generateTmLanguage(gj, 'minijsx').repository['jsx-self-closing-element-in-expression']?.begin ?? '';
check('gen-tm JSX disambiguation skip-set quotes derived from grammar (~, not hardcoded \")',
  jbegin.includes('~[^~]*~') && !jbegin.includes('"[^"]*"') && !jbegin.includes("'[^']*'"));

console.log(fail === 0 ? `\n${ok}/${ok} agnosticism checks pass — engine has no TS-specific token assumptions` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
