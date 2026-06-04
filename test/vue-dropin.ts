// ─────────────────────────────────────────────────────────────────────────────
//  vue-dropin.ts — proves Monogram's Vue grammar is a true DROP-IN for vuejs/language-tools'
//  three Vue grammar files, by running it on VS Code's REAL HTML grammars (text.html.basic +
//  text.html.derivative) and real source.ts — the environment a published Vue extension sees.
//
//  Why this is distinct from vue-grammar-harness.ts: that harness embeds MONOGRAM's own HTML
//  for fairness (isolating the Vue layer in the head-to-head). But Monogram's basic emits no
//  `meta.attribute`, so the official directive selector's excludes are no-ops there — the
//  official-HTML path is UNDER-tested. This test closes that gap: it wires Monogram's vue
//  grammar + the two thin-stub injections onto VS Code's actual derivative/basic/ts, with the
//  official `injectTo`, and asserts the real reported regression cases still hold. If VS Code
//  isn't installed (CI without it), it SKIPS — like html-bench / the scope-gap benches (dev-only).
//
//  Run: node test/vue-dropin.ts
// ─────────────────────────────────────────────────────────────────────────────
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cases } from './vue-issue-cases.ts';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const VSC = process.env.MONOGRAM_VSCODE_EXT ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions';
const offHtml = `${VSC}/html/syntaxes/html.tmLanguage.json`;
const offDerivative = `${VSC}/html/syntaxes/html-derivative.tmLanguage.json`;
if (!existsSync(offHtml) || !existsSync(offDerivative)) {
  console.log('⊘ Skipped: VS Code HTML grammars not found (set MONOGRAM_VSCODE_EXT=/path/to/.../extensions). Dev-only, like html-bench.');
  process.exit(0);
}
const offTs = `${VSC}/typescript-basics/syntaxes/TypeScript.tmLanguage.json`;

const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));
const onigLib = Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) });
const read = (p: string) => readFileSync(p, 'utf-8');
const stub = (sn: string) => parseRawGrammar(JSON.stringify({ scopeName: sn, patterns: [{ match: '[^\\n]+', name: sn }] }), `${sn}.json`);

// Monogram's Vue layer (main grammar + two thin-stub injections) on VS Code's REAL HTML + TS.
const INJECT_TO = ['text.html.vue', 'text.html.markdown', 'text.html.derivative', 'text.pug'];
const registry = new Registry({
  onigLib,
  loadGrammar: async (sn) => {
    if (sn === 'text.html.vue') return parseRawGrammar(read('vue.tmLanguage.json'), 'vue.json');
    if (sn === 'vue.directives') return parseRawGrammar(read('vue.directives.tmLanguage.json'), 'dir.json');
    if (sn === 'vue.interpolations') return parseRawGrammar(read('vue.interpolations.tmLanguage.json'), 'int.json');
    if (sn === 'text.html.basic') return parseRawGrammar(read(offHtml), 'html.json');             // VS Code's REAL HTML
    if (sn === 'text.html.derivative') return parseRawGrammar(read(offDerivative), 'der.json');    // VS Code's REAL derivative
    if (sn === 'source.ts') return existsSync(offTs) ? parseRawGrammar(read(offTs), 'ts.json') : parseRawGrammar(read('typescript.tmLanguage.json'), 'ts.json');
    if (sn === 'source.js') return parseRawGrammar(read('javascript.tmLanguage.json'), 'js.json');
    if (sn.startsWith('source.')) return stub(sn);   // css dialects etc.
    return null;
  },
  getInjections: (sn) => {
    // Mirror VS Code's injectTo: each injection fires when one of the host grammars is active.
    const base = sn.split(' ')[0];
    return INJECT_TO.some(h => base === h || base.startsWith(h + '.')) ? ['vue.directives', 'vue.interpolations'] : undefined;
  },
});
await registry.loadGrammar('vue.directives');
await registry.loadGrammar('vue.interpolations');
const vue = (await registry.loadGrammar('text.html.vue'))!;

function lookup(src: string): (offset: number) => string {
  const lines = src.split('\n'); const ls: number[] = []; let a = 0;
  for (const l of lines) { ls.push(a); a += l.length + 1; }
  const lt: any[][] = []; let st: any = INITIAL;
  for (const l of lines) { const r = vue.tokenizeLine(l, st); lt.push(r.tokens); st = r.ruleStack; }
  return (o: number) => { let li = 0; while (li + 1 < ls.length && ls[li + 1] <= o) li++; const c = o - ls[li]; for (const t of lt[li] ?? []) if (c >= t.startIndex && c < t.endIndex) return t.scopes.join(' '); return ''; };
}
const makeAt = (src: string) => { const lk = lookup(src); return (text: string, nth = 0) => { let i = -1; for (let k = 0; k <= nth; k++) i = src.indexOf(text, i + 1); return i < 0 ? '__NF__' : lk(i + Math.floor(text.length / 2)); }; };

// EVERY reported case is a drop-in regression gate — run them ALL on the OFFICIAL host grammars,
// so each is validated on BOTH host axes: vue-issues.ts runs the same cases on MONOGRAM's embedded
// source.ts/html, this runs them on VS Code's REAL HTML + official source.ts (the published
// environment). A case that passes on Monogram's host but fails here is a DROP-IN bug — e.g.
// `generic="…"`, whose type-param value must tokenize under the OFFICIAL TS grammar's repo keys
// (`#type`/`#comment`), not just Monogram's (`#type-inner`/`#blockcomment`). There are no `monoGap`
// Vue cases (all reported bugs are solved); a future unsolvable one can't be a clean drop-in, so it
// would (correctly) fail here and must be handled consciously rather than silently skipped.
const skippedMonoGap = cases.filter((c) => c.monoGap);
if (skippedMonoGap.length) console.log(`  ⚠ ${skippedMonoGap.length} monoGap case(s) present — they are STILL run below (every case is a drop-in gate): ${skippedMonoGap.map(c => c.id).join(', ')}`);
const dropinCases = cases;
let pass = 0, fail = 0; const failures: string[] = [];
for (const c of dropinCases) {
  const at = makeAt(c.src);
  const ok = c.checks.every(ch => ch.want(at(ch.at, ch.nth)));
  if (ok) pass++; else { fail++; failures.push(`  ✗ ${c.id} ${c.title}`); }
}

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log('  Monogram Vue as a DROP-IN on VS Code\'s REAL HTML grammars (text.html.derivative');
console.log('  + text.html.basic) + real source.ts — the published-extension environment.');
console.log('══════════════════════════════════════════════════════════════════════');
console.log(`  reported regression cases: ${pass}/${dropinCases.length} pass on the OFFICIAL host (same cases vue-issues.ts runs on Monogram's host — every case validated on BOTH axes)`);
for (const f of failures) console.log(f);
if (fail > 0) { console.log('\n✗ Monogram Vue is NOT a clean drop-in on the official HTML (a case regressed)'); process.exit(1); }
console.log('  ✓ directives fire on the official meta.tag, interpolation in text.html.derivative,');
console.log('    and the #6007 `as`-cast still recovers — Monogram replaces the 3 official files.');
