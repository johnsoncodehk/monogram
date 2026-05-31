// ─────────────────────────────────────────────────────────────────────────────
//  vue-interp-expr.ts — `{{ }}` / directive values embed an EXPRESSION, not a whole
//  program. Vue interpolation can't contain statements: `{{ const x = 1 }}` is invalid.
//  The embed therefore uses `source.ts#expression` (a rule-rooted sub-grammar derived
//  from the TS grammar's expression rule) instead of the whole `source.ts`.
//
//  The faithful behaviour (what makes this hard):
//    - a STATEMENT keyword at the TOP of the interpolation (`const`/`let`/`for`/`return`)
//      must NOT highlight as a keyword — it isn't a valid expression there.
//    - an EXPRESSION operator (`typeof`/`as`/`new`/`in`) MUST still highlight.
//    - a statement INSIDE a nested block — `{{ (() => { const x = 1 })() }}` — MUST still
//      highlight `const`, because the arrow body re-enters the full grammar ($self). This
//      is the nuance a naive "drop const everywhere" gets wrong.
//
//  Run: node test/vue-interp-expr.ts
// ─────────────────────────────────────────────────────────────────────────────
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

const read = (p: string) => readFileSync(p, 'utf-8');
const cssStub = JSON.stringify({ scopeName: 'source.css', patterns: [{ match: '[^<]+', name: 'source.css' }] });
const registry = new Registry({
  onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) }),
  loadGrammar: async (sn) => {
    if (sn === 'text.html.vue') return parseRawGrammar(read('vue.tmLanguage.json'), 'vue.json');
    if (sn === 'text.html.basic') return parseRawGrammar(read('html.tmLanguage.json'), 'html.json');
    if (sn === 'source.ts') return parseRawGrammar(read('typescript.tmLanguage.json'), 'ts.json');
    if (sn === 'source.js') return parseRawGrammar(read('javascript.tmLanguage.json'), 'js.json');
    if (sn === 'source.css') return parseRawGrammar(cssStub, 'css.json');
    if (sn === 'vue.injection') return parseRawGrammar(read('vue.injection.tmLanguage.json'), 'inj.json');
    return null;
  },
  getInjections: (sn) => (sn === 'text.html.basic' || sn === 'text.html.vue' ? ['vue.injection'] : undefined),
});
await registry.loadGrammar('vue.injection');
const vue = (await registry.loadGrammar('text.html.vue'))!;

interface Tok { text: string; scopes: string }
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let stack: any = INITIAL;
  for (const line of src.split('\n')) {
    const r = vue.tokenizeLine(line, stack);
    for (const t of r.tokens) { const text = line.slice(t.startIndex, t.endIndex); if (text.trim()) out.push({ text, scopes: t.scopes.join(' ') }); }
    stack = r.ruleStack;
  }
  return out;
}
const tok = (toks: Tok[], text: string) => toks.find(t => t.text === text);

let pass = 0, fail = 0;
function check(label: string, cond: boolean) { if (cond) pass++; else { fail++; console.log(`✗ ${label}`); } }
const wrap = (expr: string) => `<template>\n  <p>{{ ${expr} }}</p>\n</template>`;

// ── statement keywords at the TOP of an interpolation must NOT be keywords ──
{
  const t = tokenize(wrap('const foo = 1'));
  const k = tok(t, 'const');
  check('`{{ const foo }}`: const reaches the TS embed', !!k && k.scopes.includes('source.ts'));
  check('`{{ const foo }}`: const is NOT scoped storage.type (not a valid expression)', !!k && !k.scopes.includes('storage.type'));
}
{
  const t = tokenize(wrap('return x'));
  const k = tok(t, 'return');
  check('`{{ return x }}`: return is NOT scoped keyword.control', !!k && !k.scopes.includes('keyword.control'));
}
{
  const t = tokenize(wrap('for (;;) {}'));
  const k = tok(t, 'for');
  check('`{{ for }}`: for is NOT scoped keyword.control (mixed loop group filtered)', !!k && !k.scopes.includes('keyword.control'));
}

// ── expression operators MUST still highlight ──
{
  const t = tokenize(wrap('typeof x'));
  const k = tok(t, 'typeof');
  check('`{{ typeof x }}`: typeof IS scoped keyword.operator (kept)', !!k && k.scopes.includes('keyword.operator'));
}
{
  const t = tokenize(wrap('x as Foo'));
  const k = tok(t, 'as');
  check('`{{ x as Foo }}`: as IS scoped keyword.operator (kept)', !!k && k.scopes.includes('keyword.operator'));
}
{
  const t = tokenize(wrap('new Date()'));
  const k = tok(t, 'new');
  check('`{{ new Date() }}`: new IS scoped (kept)', !!k && (k.scopes.includes('keyword.operator') || k.scopes.includes('new')));
}

// ── THE NUANCE: a statement inside a nested block re-enters $self → const valid there ──
{
  const t = tokenize(wrap('(() => { const x = 1 })()'));
  const k = tok(t, 'const');
  check('`{{ (()=>{const x})() }}`: NESTED const IS storage.type (re-enters $self via the block)', !!k && k.scopes.includes('storage.type'));
}

console.log(`\nvue-interp-expr: ${pass}/${pass + fail} checks pass`);
if (fail > 0) { console.log('✗ interpolation expression-scoping FAILED'); process.exit(1); }
console.log('✓ `{{ }}` embeds source.ts#expression: statements suppressed at top, operators kept, nested blocks intact');
