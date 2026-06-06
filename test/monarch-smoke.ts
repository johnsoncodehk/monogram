// Structural smoke test for gen-monarch: generate the Monaco *Monarch* tokenizer
// from the TypeScript grammar and sanity-check the resulting object WITHOUT
// installing monaco. We validate it the way Monarch itself would consume it:
//   • the object shape (tokenizer/states/brackets/defaultToken)
//   • every `next`/`switchTo`/`include` resolves to a real state or builtin
//   • every rule regex compiles as a *JavaScript* RegExp (proves no Oniguruma)
//   • the headline features: preceding-context regex-vs-division, generics as a
//     type-argument state, and template `${}` interpolation via a state stack
// Plus a tiny non-TS grammar to prove the generator stays language-agnostic.
//
// Run with bare `node test/monarch-smoke.ts`.
import { generateMonarch, type MonarchLanguage, type MonarchRule, type MonarchAction } from '../src/gen-monarch.ts';
import { token, rule, defineGrammar, alt, many, left, seq, plus, oneOf, range, star, noneOf } from '../src/api.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { cond ? ok++ : (fail++, console.log('  ✗', label)); };

const grammar = (await import('../typescript.ts')).default;
const mon: MonarchLanguage = generateMonarch(grammar);
const digit = range('0', '9');

// ── Helpers to walk the generated tokenizer ──
const BUILTIN_TARGETS = new Set(['@pop', '@popall', '@push', '@rematch']);

function actionTargets(a: MonarchAction): string[] {
  if (!a || typeof a !== 'object') return [];
  if ('cases' in a) return Object.values(a.cases).flatMap(actionTargets);
  const out: string[] = [];
  if ('next' in a && a.next) out.push(a.next);
  if ('switchTo' in a && a.switchTo) out.push(a.switchTo);
  return out;
}
function ruleTargets(r: MonarchRule): string[] {
  if (!Array.isArray(r)) return [r.include];
  const out = actionTargets(r[1]);
  if (r.length === 3 && typeof r[2] === 'string') out.push(r[2]);
  return out;
}
function eachArrayRule(fn: (state: string, r: Extract<MonarchRule, unknown[]>) => void) {
  for (const [state, rules] of Object.entries(mon.tokenizer))
    for (const r of rules) if (Array.isArray(r)) fn(state, r);
}

// Resolve a state's rules the way Monarch does — flattening `{ include }`
// references transitively — so assertions don't depend on whether a rule lives
// directly in a state or in an included sub-state.
function rulesOf(state: string, seen = new Set<string>()): Extract<MonarchRule, unknown[]>[] {
  if (seen.has(state)) return [];
  seen.add(state);
  const out: Extract<MonarchRule, unknown[]>[] = [];
  for (const r of mon.tokenizer[state] ?? []) {
    if (Array.isArray(r)) out.push(r);
    else out.push(...rulesOf(r.include.replace(/^@/, ''), seen));
  }
  return out;
}
function findInState(state: string, pred: (r: Extract<MonarchRule, unknown[]>) => boolean) {
  return rulesOf(state).find(pred);
}

// ── 1. Top-level object shape ──
check('defaultToken is set', typeof mon.defaultToken === 'string' && mon.defaultToken.length > 0);
check('tokenPostfix derived from grammar name', mon.tokenPostfix === '.typescript');
check('has tokenizer object', mon.tokenizer && typeof mon.tokenizer === 'object');
check('has root state', Array.isArray(mon.tokenizer.root));
check('has value state (the value-position mode)', Array.isArray(mon.tokenizer.value));
check('brackets derived from punctuation.bracket.* scopes', mon.brackets.length === 3);
check('brackets include round/curly/square pairs',
  mon.brackets.some(b => b.open === '(' && b.close === ')') &&
  mon.brackets.some(b => b.open === '{' && b.close === '}') &&
  mon.brackets.some(b => b.open === '[' && b.close === ']'));

// ── 2. Every state reference resolves ──
const states = new Set(Object.keys(mon.tokenizer));
let dangling = 0;
for (const [, rules] of Object.entries(mon.tokenizer))
  for (const r of rules)
    for (const t of ruleTargets(r))
      if (t.startsWith('@') && !BUILTIN_TARGETS.has(t) && !states.has(t.slice(1))) dangling++;
check('no dangling state references', dangling === 0);
check('include targets exist', [...states].length > 0);

// ── 3. Every rule regex compiles as a JS RegExp (NO Oniguruma) ──
let badRegex = 0;
let onigurumaConstructs = 0;
eachArrayRule((_s, r) => {
  try { new RegExp(r[0]); } catch { badRegex++; }
  // Oniguruma-only constructs that must NOT appear: recursive subpattern \g<..>,
  // named-group backrefs \k<..>, possessive quantifiers, atomic groups (?>..).
  if (/\\g<|\\k<|[*+?]\+|\(\?>/.test(r[0])) onigurumaConstructs++;
});
check('all rule regexes compile as JavaScript RegExp', badRegex === 0);
check('no Oniguruma-only regex constructs', onigurumaConstructs === 0);

// ── 4. Regex-vs-division by PRECEDING context ──
// In expression position (`root`) a leading `/` starts a regex literal; in value
// position (`value`) `/` is the division operator. This is the win over Monaco's
// follow-heuristic.
function findRule(state: string, pred: (r: Extract<MonarchRule, unknown[]>) => boolean) {
  return (mon.tokenizer[state] as MonarchRule[]).find((r): r is Extract<MonarchRule, unknown[]> =>
    Array.isArray(r) && pred(r));
}
const rootRegex = findRule('root', r => {
  const a = r[1];
  return typeof a === 'object' && 'token' in a && a.token === 'regexp';
});
check('root (expression position) tokenizes a regex literal', !!rootRegex);
const valueSlash = findRule('value', r => /\//.test(r[0]) && !/regexp/.test(JSON.stringify(r[1])));
check('value (value position) treats / as the division operator',
  !!valueSlash && JSON.stringify(valueSlash[1]).includes('operator'));
// Sanity: the regex-literal rule actually matches a real regex and rejects a
// division context (compiled and run here as Monarch would at the cursor).
if (rootRegex) {
  const re = new RegExp('^(?:' + rootRegex[0] + ')');
  check('regex-literal rule matches /ab+c/gi', re.test('/ab+c/gi'));
  check('regex-literal rule does NOT match a bare /', !re.test('/ '));
}

// ── 5. Generics as a type-argument state (context-based type.identifier) ──
check('has a typeargs state', Array.isArray(mon.tokenizer.typeargs));
const typeIdentRule = findRule('typeargs', r => JSON.stringify(r[1]).includes('type.identifier'));
check('typeargs emits type.identifier for bare identifiers (beats capitalization heuristic)', !!typeIdentRule);
// The value-position `<` is GUARDED so only a real generic-arg list opens it.
const guardedAngle = findRule('value', r => r[0].startsWith('<') && JSON.stringify(r[1]).includes('typeargs'));
check('value-position `<` is guarded and opens the typeargs state', !!guardedAngle);
if (guardedAngle) {
  const re = new RegExp('^(?:' + guardedAngle[0] + ')');
  check('guard ACCEPTS a generic call  f<T>(…)', re.test('<T>(x)'));
  check('guard ACCEPTS a generic call  f<A, B>(…)', re.test('<A, B>(x)'));
  check('guard ACCEPTS one nested level f<Map<K,V>>(…)', re.test('<Map<K, V>>(x)'));
  check('guard ACCEPTS a tagged template f<T>`…`', re.test('<T>`x`'));
  check('guard REJECTS a comparison     a < b', !re.test('< b'));
  check('guard REJECTS chained compare  a < b > c (no confirm)', !re.test('< b > c'));
  check('guard REJECTS the <= operator', !re.test('<= 3'));
}
// In expression position a bare `<`/`>` is a comparison operator (like Monaco).
const exprComparison = findRule('root', r => r[0] === '<|>');
check('expression-position `<`/`>` is a comparison operator', !!exprComparison);

// ── 6. Template `${}` interpolation via a state stack (incl. nesting) ──
check('has a template state', Array.isArray(mon.tokenizer.template));
check('has a templateInterp state (the `${ … }` hole)', Array.isArray(mon.tokenizer.templateInterp));
check('has a bracketCounting state (nested `{}` inside a hole)', Array.isArray(mon.tokenizer.bracketCounting));
check('has a nested-template state for templates inside `${}` (state-stack nesting)',
  Array.isArray(mon.tokenizer.templateN));
check('has a nested-string state for strings inside `${}`',
  Object.keys(mon.tokenizer).some(s => /^string_.*N$/.test(s)));
// The hole opens with `${` pushing the interpolation state, and closes with `}` popping.
const interpOpen = findInState('template', r => JSON.stringify(r).includes('templateInterp'));
check('template body pushes the interpolation state on `${`', !!interpOpen);
const interpClose = findRule('templateInterp', r => r[0].includes('}') && JSON.stringify(r[1]).includes('@pop'));
check('interpolation hole pops back to the template on the closing `}`', !!interpClose);

// ── 7. Keyword / built-in dispatch via `cases` ──
const identCasesRule = findInState('root', r =>
  typeof r[1] === 'object' && 'cases' in r[1]);
check('root has an identifier rule with a `cases` dispatch', !!identCasesRule);
if (identCasesRule && typeof identCasesRule[1] === 'object' && 'cases' in identCasesRule[1]) {
  const cases = identCasesRule[1].cases;
  const tokenOf = (a: MonarchAction | undefined) =>
    a && typeof a === 'object' && 'token' in a ? a.token : a;
  check('control keyword `if` → keyword', tokenOf(cases['if']) === 'keyword');
  check('primitive type `string` → keyword', tokenOf(cases['string']) === 'keyword');
  check('built-in class `Promise` → type.identifier (a type reference)',
    tokenOf(cases['Promise']) === 'type.identifier');
  check('built-in value `console` → variable', tokenOf(cases['console']) === 'variable');
  check('a plain identifier falls through to the default → identifier',
    tokenOf(cases['@default']) === 'identifier');
}

// ── 8. Comments derived from skip tokens (line + block, block spans lines) ──
check('has at least one block-comment state', Object.keys(mon.tokenizer).some(s => s.startsWith('comment_')));
const lineComment = findInState('root', r => r[0].includes('//') && r[0].endsWith('$'));
check('line comment runs to end of line', !!lineComment);

// ── 9. Language-agnosticism — a tiny grammar named NOTHING like TS, with NO
//      template / regex / backtick, must still produce a valid tokenizer and
//      must NOT fabricate template/regex/generics states it has no basis for. ──
const Word = token(plus(range('a', 'z')), { identifier: true });
const Num = token(plus(digit));
const Str = token(seq('~', star(noneOf('~')), '~'), { string: true });
const Mini = rule(($: any) => [many(alt(Word, Num, Str, '+'))]);
const mini = defineGrammar({
  name: 'mini',
  tokens: { Word, Num, Str },
  prec: [left('+')],
  rules: { Mini },
  scopes: { 'keyword.operator.arithmetic': ['+'] },
  entry: Mini,
});
const miniMon = generateMonarch(mini);
check('agnostic: tiny grammar produces a tokenizer', !!miniMon.tokenizer.root);
check('agnostic: tokenPostfix uses the declared name (.mini)', miniMon.tokenPostfix === '.mini');
check('agnostic: NO template state when no template token is declared',
  !('template' in miniMon.tokenizer) && !('templateInterp' in miniMon.tokenizer));
check('agnostic: NO typeargs state when the grammar has no generics',
  !('typeargs' in miniMon.tokenizer));
check('agnostic: string state derived from the `~…~` token (not hardcoded quotes)',
  Object.keys(miniMon.tokenizer).some(s => s.startsWith('string_')));
// Every mini regex still compiles as a JS RegExp.
let miniBad = 0;
for (const rules of Object.values(miniMon.tokenizer))
  for (const r of rules) if (Array.isArray(r)) { try { new RegExp(r[0]); } catch { miniBad++; } }
check('agnostic: all mini regexes compile as JS RegExp', miniBad === 0);

console.log(fail === 0
  ? `\n${ok}/${ok} Monarch smoke checks pass`
  : `\n${fail} FAILED (of ${ok + fail})`);
process.exit(fail === 0 ? 0 : 1);
