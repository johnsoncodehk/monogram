// textmate-highlight-guards.ts — focused regression guards for TextMate-highlighter disambiguations
// that COMPILE cleanly (so the RedCMD/Onigmo guard passes) yet can silently mean the wrong
// thing. These were two green regressions in PR #13 (fixed 2026-06-07); kept here because the
// scope-gap corpus does not contain `<operator> !/re/` or multi-line generic calls, so neither
// the accuracy bench nor the Onigmo guard catches a re-break. Asserts SEMANTICS by tokenizing
// with vscode-oniguruma — the engine VS Code actually uses. See memory: redcmd-onigmo-guard.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

const grammarFiles: Record<string, string> = {
  'source.ts': 'typescript.tmLanguage.json',
  'source.tsx': 'typescriptreact.tmLanguage.json',
  'source.js.jsx': 'javascriptreact.tmLanguage.json',
};

function makeRegistry(): InstanceType<typeof Registry> {
  return new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (p: string[]) => new OnigScanner(p),
      createOnigString: (s: string) => new OnigString(s),
    }),
    loadGrammar: async (scopeName: string) => {
      const file = grammarFiles[scopeName];
      return file ? parseRawGrammar(readFileSync(file, 'utf-8'), file) : null;
    },
  });
}

const grammars: Record<string, vsctm.IGrammar> = {};
for (const scope of Object.keys(grammarFiles)) {
  const g = await makeRegistry().loadGrammar(scope);
  if (!g) throw new Error(`failed to load ${scope}`);
  grammars[scope] = g;
}

interface Check { line: number; text: string; scope: string; absent?: boolean; }
interface Case { label: string; scope: string; lines: string[]; checks: Check[]; }

const cases: Case[] = [
  // ── #2: a regex after a PREFIX `!` (`= !/re/`, `return !/re/`, `&& !/re/`, `! /re/`).
  // PR #13 emitted `s*` instead of `\s*` (a lone `\s` in a JS template literal collapses to
  // `s`), so the `(` of these forms lost regex highlighting whenever whitespace preceded `!`.
  { label: '#2 = !/re/ is a regex', scope: 'source.ts', lines: ['x = !/re/.test(y)'],
    checks: [{ line: 0, text: 're', scope: 'string.regexp' }] },
  { label: '#2 return !/re/ is a regex', scope: 'source.ts', lines: ['return !/re/.test(y)'],
    checks: [{ line: 0, text: 're', scope: 'string.regexp' }] },
  { label: '#2 a && !/re/ is a regex', scope: 'source.ts', lines: ['const ok = a && !/re/.test(y)'],
    checks: [{ line: 0, text: 're', scope: 'string.regexp' }] },
  { label: '#2 ! /re/ (space) is a regex', scope: 'source.ts', lines: ['if (! /re/.test(y)) {}'],
    checks: [{ line: 0, text: 're', scope: 'string.regexp' }] },
  { label: '#2 !!/re/ (chained) is a regex', scope: 'source.ts', lines: ['const b = !!/re/.test(y)'],
    checks: [{ line: 0, text: 're', scope: 'string.regexp' }] },
  // Control: postfix non-null `x! / y` is DIVISION, never a regex (must not over-trigger).
  { label: '#2 control: x! / y is division', scope: 'source.ts', lines: ['const z = x! / y'],
    checks: [{ line: 0, text: '/', scope: 'keyword.operator.arithmetic' },
             { line: 0, text: '/', scope: 'string.regexp', absent: true }] },
  // A keyword is a regex position only where what follows it in the grammar can begin with a
  // regex (after `const`, `var`, `let` or `extends` it cannot), and only where it IS the keyword:
  // after a member access (`.`, `?.`) the same word is a property name, so a `/` after it is a
  // division, also for the words that do take a regex (`new /re/`, `typeof /re/`).
  ...['new', 'const', 'var', 'let', 'extends', 'class', 'get', 'typeof', 'in', 'delete', 'return'].map((w) => ({
    label: `a / after the property .${w} is division`, scope: 'source.ts', lines: [`x = o.${w} / 2 / y`],
    checks: [{ line: 0, text: '/', scope: 'keyword.operator.arithmetic' },
             { line: 0, text: '/', scope: 'string.regexp', absent: true }] })),
  { label: 'a / after the property ?.new is division', scope: 'source.ts', lines: ['x = o?.new / 2 / y'],
    checks: [{ line: 0, text: '/', scope: 'keyword.operator.arithmetic' },
             { line: 0, text: '/', scope: 'string.regexp', absent: true }] },
  { label: 'new /re/ is a regex (a MemberExpression callee)', scope: 'source.ts', lines: ['x = new /re/g()'],
    checks: [{ line: 0, text: 're', scope: 'string.regexp' }] },
  { label: 'return /re/ is a regex', scope: 'source.ts', lines: ['return /re/.test(s)'],
    checks: [{ line: 0, text: 're', scope: 'string.regexp' }] },
  { label: 'typeof /re/ is a regex', scope: 'source.ts', lines: ['x = typeof /re/'],
    checks: [{ line: 0, text: 're', scope: 'string.regexp' }] },
  { label: 'of /re/ is a regex', scope: 'source.ts', lines: ['for (x of /a/g.exec(s)) {}'],
    checks: [{ line: 0, text: 'a', scope: 'string.regexp' }] },

  // ── #3: a generic-arrow `(` vs a generic-CALL / comparison `(` at end-of-line. PR #13
  // degraded the look-behind to `(?<=>)`, so multi-line `foo<Bar>(` / `a > (` were wrongly
  // scoped meta.parameters.arrow. Now owned by the #generic-arrow-function wrapper (no
  // look-behind), so only a real generic arrow opens params.
  { label: '#3 false-positive: multi-line generic CALL is NOT arrow params', scope: 'source.ts',
    lines: ['const r = useMemo<Foo>(', '  fn,', ')'],
    checks: [{ line: 0, text: '(', scope: 'punctuation.bracket.round' },
             { line: 0, text: '(', scope: 'meta.parameters.arrow', absent: true }] },
  { label: '#3 false-positive: multi-line comparison `a > (` is NOT arrow params', scope: 'source.ts',
    lines: ['const c = a > (', '  b', ')'],
    checks: [{ line: 0, text: '(', scope: 'meta.parameters.arrow', absent: true }] },
  // Positive: the deferred (`(`-at-end-of-line) generic arrow STILL opens a typed param list.
  { label: '#3 deferred multi-line generic arrow keeps typed params', scope: 'source.ts',
    lines: ['const f = <T extends X>(', '  a: T,', ') => a'],
    checks: [{ line: 0, text: '<', scope: 'meta.type.parameters' },
             { line: 0, text: 'extends', scope: 'keyword' },
             { line: 0, text: '(', scope: 'meta.parameters.arrow' },
             { line: 1, text: 'a', scope: 'variable.parameter' },
             { line: 1, text: 'T', scope: 'entity.name.type' }] },
  // Positive: single-line generic arrow unaffected.
  { label: '#3 single-line generic arrow opens params', scope: 'source.ts',
    lines: ['const g = <T,>(x: T) => x'],
    checks: [{ line: 0, text: '(', scope: 'meta.parameters.arrow' },
             { line: 0, text: 'x', scope: 'variable.parameter' }] },

  // ── .tsx: same disambiguation must hold alongside JSX.
  { label: '#3 tsx single-line generic arrow opens params', scope: 'source.tsx',
    lines: ['const g = <T,>(x: T) => x'],
    checks: [{ line: 0, text: '(', scope: 'meta.parameters.arrow' }] },
  { label: '#3 tsx deferred generic arrow keeps typed params', scope: 'source.tsx',
    lines: ['const f = <T,>(', '  x: T,', ') => x'],
    checks: [{ line: 0, text: '(', scope: 'meta.parameters.arrow' },
             { line: 1, text: 'x', scope: 'variable.parameter' }] },
  { label: '#3 tsx multi-line generic CALL is NOT arrow params', scope: 'source.tsx',
    lines: ['const r = useMemo<Foo>(', '  fn,', ')'],
    checks: [{ line: 0, text: '(', scope: 'meta.parameters.arrow', absent: true }] },
  { label: '#3 tsx JSX element is a tag, not arrow params', scope: 'source.tsx',
    lines: ['const e = <div>{x}</div>'],
    checks: [{ line: 0, text: 'div', scope: 'entity.name.tag' }] },

  // ── .tsx: an element starts where the LEXER enters it, after a text that is no value (the
  // derived operand-entry set, region-view.ts operandEntry). The hand list it replaced had no
  // `+`, `??`, `;`, `else`, `typeof`, … so these were comparisons in the highlighter only.
  ...([['a + <b/>', '+'], ['a ?? <b/>', '??'], ['f(); <b/>', ';'], ['typeof <b/>', 'typeof'], ['a !== <b/>', '!=='], ['a * <b/>', '*']] as const).map(([src, op]) => ({
    label: `tsx element after \`${op}\` is a tag`, scope: 'source.tsx', lines: [`x = ${src}`],
    checks: [{ line: 0, text: 'b', scope: 'entity.name.tag' }] })),
  // ... and nowhere a value stands: after `++` (a value ending with the operator `+`), after an
  // operand and a block comment, after an identifier.
  ...(['a++ <b', 'a /**/ <b', 'a <b'] as const).map((src) => ({
    label: `tsx \`${src}\` is a comparison`, scope: 'source.tsx', lines: [`x = ${src} > c`],
    checks: [{ line: 0, text: 'b', scope: 'entity.name.tag', absent: true }] })),

  // ── Zero-width guards in the grammar (the `>>`/`>=` rescan between the type arguments and
  // their `>`, `not(…)` inside a `not(…)`) must not hide the generic call or make a contextual
  // keyword look reserved.
  { label: 'generic call type arguments', scope: 'source.ts', lines: ['f<T>(x)'],
    checks: [{ line: 0, text: '<', scope: 'punctuation.definition.typeparameters.begin' },
             { line: 0, text: 'T', scope: 'entity.name.type' }] },
  { label: 'tsx generic call type arguments', scope: 'source.tsx', lines: ['f<T>(x)'],
    checks: [{ line: 0, text: '<', scope: 'punctuation.definition.typeparameters.begin' }] },
  { label: 'satisfies is contextual', scope: 'source.ts', lines: ['const satisfies = 1'],
    checks: [{ line: 0, text: 'satisfies', scope: 'keyword.operator', absent: true }] },
  // ── An element is entered only at an operand position (the lexer's `!prevIsValue()`): after
  // an expression-head keyword (`new`, `return`, …), but not when a member access precedes that
  // word, where it is a property name and so a value (`x.new <b> c` is two comparisons).
  ...(['source.tsx', 'source.js.jsx'] as const).flatMap(scope => [
    { label: `${scope}: \`x.new <b> c\` is no element`, scope, lines: ['y = x.new <b> c;'],
      checks: [{ line: 0, text: 'b', scope: 'entity.name.tag', absent: true }] },
    { label: `${scope}: \`x?.new <b> c\` is no element`, scope, lines: ['y = x?.new <b> c;'],
      checks: [{ line: 0, text: 'b', scope: 'entity.name.tag', absent: true }] },
    { label: `${scope}: \`x.return <b> c\` is no element`, scope, lines: ['y = x.return <b> c;'],
      checks: [{ line: 0, text: 'b', scope: 'entity.name.tag', absent: true }] },
    { label: `${scope}: \`return <b/>\` is an element`, scope, lines: ['return <b/>;'],
      checks: [{ line: 0, text: 'b', scope: 'entity.name.tag' }] },
    { label: `${scope}: \`renew <b/>\` is no element (a word, not \`new\`)`, scope, lines: ['y = renew <b> c;'],
      checks: [{ line: 0, text: 'b', scope: 'entity.name.tag', absent: true }] },
  ]),
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  const grammar = grammars[c.scope];
  const lineResults: vsctm.ITokenizeLineResult[] = [];
  let ruleStack = INITIAL;
  for (const line of c.lines) {
    const r = grammar.tokenizeLine(line, ruleStack);
    lineResults.push(r);
    ruleStack = r.ruleStack;
  }
  for (const check of c.checks) {
    const line = c.lines[check.line];
    let found = false;
    for (const token of lineResults[check.line].tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      if (text !== check.text) continue;
      found = true;
      const scopes = token.scopes.join(' ');
      const present = scopes.includes(check.scope);
      const ok = check.absent ? !present : present;
      if (ok) {
        passed++;
      } else {
        failed++;
        const want = check.absent ? `NOT contain '${check.scope}'` : `contain '${check.scope}'`;
        console.log(`FAIL [${c.label}] L${check.line} '${check.text}' expected to ${want}, got: ${scopes}`);
      }
      break;
    }
    if (!found) {
      failed++;
      console.log(`FAIL [${c.label}] L${check.line} token '${check.text}' not found`);
    }
  }
}

console.log(`\nTM highlight guards: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
