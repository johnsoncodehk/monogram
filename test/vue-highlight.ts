// ─────────────────────────────────────────────────────────────────────────────
//  vue-highlight.ts — gates the DERIVED Vue SFC TextMate grammar (vue.tmLanguage.json,
//  increment 1: block skeleton + block-level embeds). A .vue file is highlighted by
//  COMPOSING Monogram's own grammars: <template> embeds Monogram's HTML, <script> its
//  proven JS/TS, <style> CSS (delegated). Tokenizes an SFC with those registered and
//  asserts each block delegates to the right sub-language.
//
//  Increment 2 (Vue directives v-if/:bind/@event/#slot + {{ }} interpolation) is not
//  covered here yet — :class / {{ }} inside <template> are still plain HTML.
//
//  Run: node test/vue-highlight.ts
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
    if (sn === 'text.html.basic') return parseRawGrammar(read('html.tmLanguage.json'), 'html.json');   // Monogram's HTML
    if (sn === 'source.js') return parseRawGrammar(read('javascript.tmLanguage.json'), 'js.json');     // Monogram's JS
    if (sn === 'source.css') return parseRawGrammar(cssStub, 'css.json');
    return null;
  },
});
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

const sfc = [
  '<template>',
  '  <div class="box"><span>hi</span></div>',
  '</template>',
  '',
  '<script>',
  'const n = 1 < 2;',
  '</script>',
  '',
  '<style>',
  '.box { color: red }',
  '</style>',
].join('\n');
const toks = tokenize(sfc);

let pass = 0, fail = 0;
const find = (text: string, pred: (s: string) => boolean) => toks.find(t => t.text === text && pred(t.scopes));
function check(label: string, cond: boolean, detail = '') {
  if (cond) pass++; else { fail++; console.log(`✗ ${label}${detail ? '\n    ' + detail : ''}`); }
}

// ── blocks recognized as Vue SFC blocks ──
check('<template> block → meta.template.vue', !!find('template', s => s.includes('meta.template.vue') && s.includes('entity.name.tag.vue')));
check('<script> block → meta.script.vue', !!find('script', s => s.includes('meta.script.vue') && s.includes('entity.name.tag.vue')));
check('<style> block → meta.style.vue', !!find('style', s => s.includes('meta.style.vue') && s.includes('entity.name.tag.vue')));

// ── <template> body is Monogram's HTML ──
check('<template> body embeds HTML (div → entity.name.tag.html)', !!find('div', s => s.includes('text.html.basic') && s.includes('entity.name.tag.html')));
check('<template> body: attribute → HTML attribute-name', !!find('class', s => s.includes('text.html.basic') && s.includes('entity.other.attribute-name')));

// ── <script> body is Monogram's JS (the headline: < is a JS operator, not a tag) ──
check('<script> body embeds JS (const → storage.type.js)', !!find('const', s => s.includes('source.js') && s.includes('storage.type')));
check('<script> body: `<` is a JS operator, not a tag', !!find('<', s => s.includes('source.js') && s.includes('keyword.operator')));

// ── <style> body is CSS ──
check('<style> body embeds CSS', toks.some(t => t.text.includes('color') && t.scopes.includes('source.css')));

console.log(`\nvue-highlight: ${pass}/${pass + fail} checks pass`);
if (fail > 0) { console.log('✗ Vue SFC highlighter FAILED'); process.exit(1); }
console.log('✓ Vue SFC: <template>→Monogram HTML, <script>→Monogram JS, <style>→CSS, all composed from one engine');
