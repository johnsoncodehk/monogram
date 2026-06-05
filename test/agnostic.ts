// Proof that gen-parser is language-agnostic: a tiny grammar whose tokens are
// named NOTHING like TypeScript's, with no template/regex/backtick at all, run
// on the same engine. If the engine still hardcoded 'Ident'/'Template'/backtick,
// these assertions would fail.
import { token, rule, defineGrammar, alt, many, opt, sep, none, seq, plus, oneOf, range, anyChar, star, noneOf } from '../src/api.ts';
import { tokenPatternStartsWithDecimal } from '../src/token-pattern.ts';
import { createParser } from '../src/gen-parser.ts';
import { generateLanguageConfig } from '../src/gen-vscode-config.ts';
import { generateTmLanguage } from '../src/gen-tm.ts';

const Word = token(plus(range('a', 'z')), { identifier: true });   // identifier token, ASCII-only on purpose, NOT named "Ident"
const digit = range('0', '9');
const word = oneOf(range('A', 'Z'), range('a', 'z'), digit, '_');
const nonWhitespace = noneOf(oneOf('\t', '\n', '\f', '\r', ' '));
const Num = token(plus(digit));
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

check('token-pattern decimal-start fact handles range/char-class IR',
  tokenPatternStartsWithDecimal(Num) &&
  tokenPatternStartsWithDecimal(token(plus(word))) &&
  !tokenPatternStartsWithDecimal(token(plus(nonWhitespace))) &&
  !tokenPatternStartsWithDecimal(token(plus(anyChar()))));

// 5. gen-vscode-config derives string delimiters from the `string` flag, not a
//    hardcoded JS quote set: a `~…~` string token must yield `~` (and never `"`).
const Str = token(seq('~', star(noneOf('~')), '~'), { string: true });
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
const JTilde   = token(seq('~', star(noneOf('~')), '~'), { string: true });    // ← non-quote attr-string delimiter
const JSelfEnd = token(seq('/', '>'));                           // JSX self-closing tag
const JCloseTg = token(seq('<', '/'));                           // JSX close-tag opener
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

// 7. gen-tm's `.tsx` generic-arrow confirm (#arrow-type-parameters' arrowParamShape)
//    reads the arrow PARAM-LIST delimiters from the arrow rule's own
//    `'(' sep(Param,',') ')' … '=>'` (detectArrowParamDelims) — NOT a hardcoded `(`.
//    A TS-family-JSX grammar whose arrow params are delimited by `⟨…⟩` (with a
//    type-param-bearing declaration so #arrow-type-parameters is emitted at all)
//    must produce a confirm that uses `⟨`/`⟩` and never a literal `\(`. Proves the
//    param-paren derivation is data-driven; the curated param-shape TAIL
//    (`\.\.\.`, `[:,?]`, `[{\[]`, `$`) stays literal on purpose (it is a deliberately
//    NARROWED subset of FIRST(Param), which the shared CFG rule cannot express).
const AType  = rule(() => [[Word]]);
const ATP    = rule(($: any) => [['<', sep(AType, ','), '>']]);                         // <T,> generic delimiters
const AParam = rule(($: any) => [[Word, opt(':', AType)]]);
const ADecl  = rule(($: any) => [['fn', Word, opt(ATP), '⟨', sep(AParam, ','), '⟩', '{', '}']]); // decl w/ type-params
const AArrow = rule(($: any) => [[opt(ATP), '⟨', sep(AParam, ','), '⟩', '=>', Word]]);  // arrow, params in ⟨…⟩
const ACall  = rule(($: any) => [[Word, '<', sep(AType, ','), '>', '⟨', sep(Word, ','), '⟩']]); // generic-call confirm
const AAttr  = rule(($: any) => [[Word, opt('=', Word)]]);
const AElem  = rule(($: any) => [['<', Word, many(AAttr), alt(JSelfEnd, ['>', JCloseTg, Word, '>'])]]); // JSX tag
const AExpr  = rule(() => [Word, ACall, AArrow, AElem]);
const AStmt  = rule(() => [ADecl, AExpr]);
const AProg  = rule(() => [[many(AStmt)]]);
const ga = defineGrammar({
  name: 'angjsx', scopeName: 'source.angjsx',
  tokens: { JSelfEnd, JCloseTg, Word },
  prec: [none('<', '>')],
  scopes: { 'storage.type.function': ['fn'] },  // so `fn` is a detected declaration keyword
  rules: { AType, ATP, AParam, ADecl, AArrow, ACall, AAttr, AElem, AExpr, AStmt, AProg }, entry: AProg,
});
const abegin = generateTmLanguage(ga, 'angjsx').repository['arrow-type-parameters']?.begin ?? '';
check('gen-tm arrow-param confirm parens derived from arrow rule (⟨⟩, not hardcoded `(`)',
  abegin.includes('⟨') && abegin.includes('⟩') && !abegin.includes('\\('));

// 8. gen-tm's `.tsx` NO-COMMA generic-arrow disambiguator reads the CONSTRAINT
//    keyword off the type-PARAM rule (`opt('extends', Type)` in TS), NOT a hardcoded
//    `extends`. A single no-comma type-param `<T extends X>(…)=>` is a generic arrow
//    (vs JSX) precisely because of that keyword. A TS-family-JSX grammar whose
//    type-param rule's constraint keyword is `subtypeof` (and whose type-ARGUMENT
//    rule has its OWN `opt('is', …)` predicate, which must NOT be mistaken for a
//    constraint) must produce a guard mentioning `\bsubtypeof\b` and NEVER `\bextends\b`
//    nor `\bis\b`. Proves the keyword derivation is data-driven and scoped to the
//    param rule, not the type-arg rule.
const CType   = rule(($: any) => [[Word, opt('is', Word)]]);                            // type, with an `is` predicate
const CTParam = rule(($: any) => [[Word, opt('subtypeof', CType)]]);                    // type-PARAM: name + constraint
const CTP     = rule(($: any) => [['<', sep(CTParam, ','), '>']]);                      // <T subtypeof X,> type-param list
const CParam  = rule(($: any) => [[Word, opt(':', CType)]]);
const CDecl   = rule(($: any) => [['fn', Word, opt(CTP), '(', sep(CParam, ','), ')', '{', '}']]); // decl w/ type-params (emits arrow-type-parameters)
const CArrow  = rule(($: any) => [[opt(CTP), '(', sep(CParam, ','), ')', '=>', Word]]); // arrow w/ type-params
const CCall   = rule(($: any) => [[Word, '<', sep(CType, ','), '>', '(', sep(Word, ','), ')']]); // generic-call (type-ARGS use CType)
const CAttr   = rule(($: any) => [[Word, opt('=', Word)]]);
const CElem   = rule(($: any) => [['<', Word, many(CAttr), alt(JSelfEnd, ['>', JCloseTg, Word, '>'])]]);
const CExpr   = rule(() => [Word, CCall, CArrow, CElem]);
const CStmt   = rule(() => [CDecl, CExpr]);
const CProg   = rule(() => [[many(CStmt)]]);
const gc2 = defineGrammar({
  name: 'conjsx', scopeName: 'source.conjsx',
  tokens: { JSelfEnd, JCloseTg, Word },
  prec: [none('<', '>')],
  scopes: { 'storage.type.function': ['fn'] },  // so `fn` is a detected declaration keyword
  rules: { CType, CTParam, CTP, CParam, CDecl, CArrow, CCall, CAttr, CElem, CExpr, CStmt, CProg }, entry: CProg,
});
// BOTH sides of the disambiguation must carry the DERIVED keyword: the positive
// #arrow-type-parameters begin guard AND the inverse JSX-trigger carve-out.
const ctm = generateTmLanguage(gc2, 'conjsx');
const cbegin = ctm.repository['arrow-type-parameters']?.begin ?? '';
const ccarve = ctm.repository['jsx-self-closing-element-in-expression']?.begin ?? '';
const kwOk = (s: string) => s.includes('\\bsubtypeof\\b') && !s.includes('\\bextends\\b') && !s.includes('\\bis\\b');
check('gen-tm no-comma constraint keyword derived from type-param rule (subtypeof, not hardcoded `extends`/`is`)',
  kwOk(cbegin) && kwOk(ccarve));

console.log(fail === 0 ? `\n${ok}/${ok} agnosticism checks pass — engine has no TS-specific token assumptions` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
