// Proof that gen-parser is language-agnostic: a tiny grammar whose tokens are
// named NOTHING like TypeScript's, with no template/regex/backtick at all, run
// on the same engine. If the engine still hardcoded 'Ident'/'Template'/backtick,
// these assertions would fail.
import { token, rule, defineGrammar, alt, many } from '../src/api.ts';
import { createParser } from '../src/gen-parser.ts';

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

console.log(fail === 0 ? `\n${ok}/${ok} agnosticism checks pass — engine has no TS-specific token assumptions` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
