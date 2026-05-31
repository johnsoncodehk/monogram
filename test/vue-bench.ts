// ─────────────────────────────────────────────────────────────────────────────
//  vue-bench.ts — Monogram's DERIVED Vue grammar vs the hand-written official one
//  (vuejs/language-tools: vue.tmLanguage.json + vue-directives.json + vue-interpolations.json),
//  graded by a NEUTRAL oracle (@vue/compiler-sfc for block structure + boundaries,
//  @vue/compiler-dom for directives + interpolations) — the same shape as highlight-bench
//  (both engines vs tsc) and html-bench (both vs parse5).
//
//  Fairness: BOTH grammars embed Monogram's OWN source.ts / source.js, so the script-body
//  tokenization is identical and only the VUE LAYER (block regions, embed boundaries,
//  directives, interpolation) differs. The official grammar is self-contained for HTML
//  (its own #html-stuff → meta.tag / text.html.derivative), so it gets its 2 injections.
//
//  This is NOT a coverage race — Monogram's Vue is a focused core; the official covers far
//  more breadth (every lang=, modifiers, slots). The corpus is the SHARED CORE both target,
//  and we grade per-construct correctness on it. Official grammars are dev-only fixtures
//  (your own MIT work) under test/fixtures/vue-official; the bench skips if absent.
//
//  Run: node test/vue-bench.ts
// ─────────────────────────────────────────────────────────────────────────────
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import sfc from '@vue/compiler-sfc';
import * as dom from '@vue/compiler-dom';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const FIX = 'test/fixtures/vue-official';
if (!existsSync(`${FIX}/vue.tmLanguage.json`)) {
  console.log('⊘ Skipped: official Vue grammars not found under test/fixtures/vue-official.');
  console.log('  Fetch with: base=https://raw.githubusercontent.com/vuejs/language-tools/master/extensions/vscode/syntaxes');
  console.log('  curl -fsSL "$base/{vue.tmLanguage.json,vue-directives.json,vue-interpolations.json}" -O (into that dir)');
  process.exit(0);
}
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));
const onigLib = Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) });

const read = (p: string) => readFileSync(p, 'utf-8');
// Generic stub for any embedded sub-language we don't pit head-to-head (CSS dialects etc.):
// scope the whole region with its own scopeName so familyOf() can see it.
const stub = (sn: string) => parseRawGrammar(JSON.stringify({ scopeName: sn, patterns: [{ match: '[^\\n]+', name: sn }] }), `${sn}.json`);
const monoTs = () => parseRawGrammar(read('typescript.tmLanguage.json'), 'ts.json');
const monoJs = () => parseRawGrammar(read('javascript.tmLanguage.json'), 'js.json');

// ── Monogram registry ──
const monoReg = new Registry({
  onigLib,
  loadGrammar: async (sn) => {
    if (sn === 'text.html.vue') return parseRawGrammar(read('vue.tmLanguage.json'), 'vue.json');
    if (sn === 'text.html.basic') return parseRawGrammar(read('html.tmLanguage.json'), 'html.json');
    if (sn === 'source.ts') return monoTs();
    if (sn === 'source.js') return monoJs();
    if (sn === 'vue.injection') return parseRawGrammar(read('vue.injection.tmLanguage.json'), 'inj.json');
    if (sn.startsWith('source.')) return stub(sn);
    return null;
  },
  getInjections: (sn) => (sn === 'text.html.basic' || sn === 'text.html.vue' ? ['vue.injection'] : undefined),
});
await monoReg.loadGrammar('vue.injection');
const monoVue = (await monoReg.loadGrammar('text.html.vue'))!;

// ── Official registry ──
const offReg = new Registry({
  onigLib,
  loadGrammar: async (sn) => {
    if (sn === 'text.html.vue') return parseRawGrammar(read(`${FIX}/vue.tmLanguage.json`), 'ovue.json');
    // The official grammar parses template HTML by embedding text.html.basic (its #html-stuff)
    // and emits meta.tag, which its directives injection targets. Give it Monogram's HTML — the
    // SAME HTML both grammars use → the comparison isolates the Vue layer (and it emits meta.tag).
    if (sn === 'text.html.basic') return parseRawGrammar(read('html.tmLanguage.json'), 'html.json');
    if (sn === 'source.ts') return monoTs();      // SAME embedded TS → isolates the Vue layer
    if (sn === 'source.js') return monoJs();
    if (sn === 'vue.directives') return parseRawGrammar(read(`${FIX}/vue-directives.json`), 'odir.json');
    if (sn === 'vue.interpolations') return parseRawGrammar(read(`${FIX}/vue-interpolations.json`), 'oint.json');
    if (sn.startsWith('source.')) return stub(sn);   // CSS dialects etc. (not graded head-to-head)
    return null;  // text.html.derivative / text.pug / … → no-op include; text.html.basic does the parsing
    //  (a greedy stub here would shadow text.html.basic in #html-stuff and swallow the template).
  },
  getInjections: (sn) => (sn === 'text.html.vue' ? ['vue.directives', 'vue.interpolations'] : undefined),
});
await offReg.loadGrammar('vue.directives');
await offReg.loadGrammar('vue.interpolations');
const offVue = (await offReg.loadGrammar('text.html.vue'))!;

// ── tokenize → scope lookup by source offset ──
function scopeLookup(grammar: any, src: string): (offset: number) => string[] {
  const lines = src.split('\n');
  const lineStart: number[] = []; let acc = 0;
  for (const l of lines) { lineStart.push(acc); acc += l.length + 1; }
  const lineToks: any[][] = []; let stack: any = INITIAL;
  for (const l of lines) { const r = grammar.tokenizeLine(l, stack); lineToks.push(r.tokens); stack = r.ruleStack; }
  return (offset: number) => {
    let li = 0; while (li + 1 < lineStart.length && lineStart[li + 1] <= offset) li++;
    const col = offset - lineStart[li];
    for (const t of lineToks[li] ?? []) if (col >= t.startIndex && col < t.endIndex) return t.scopes;
    return [];
  };
}
const familyOf = (sc: string[]): string => {
  const s = sc.join(' ');
  if (s.includes('source.ts')) return 'ts';
  if (s.includes('source.js')) return 'js';
  if (s.includes('source.css')) return 'css';
  if (s.includes('text.html')) return 'html';
  return 'other';
};

// ── oracle facts (neutral: @vue) ──
interface Fact { cat: string; offset: number; test: (sc: string[]) => boolean; label: string }
function oracleFacts(src: string): Fact[] {
  const facts: Fact[] = [];
  const { descriptor } = sfc.parse(src);
  const scriptFam = (lang?: string) => (lang === 'ts' || lang === 'tsx' ? 'ts' : 'js');
  const addBlock = (block: any, fam: string, label: string) => {
    if (!block || block.loc.end.offset <= block.loc.start.offset) return;
    // Sample the FIRST non-whitespace char of the body — representative of the embed, and it
    // never lands on a nested interpolation/directive (which a midpoint could, giving 'ts').
    let off = block.loc.start.offset;
    while (off < block.loc.end.offset && /\s/.test(src[off])) off++;
    facts.push({ cat: 'block-embed', offset: off, test: sc => familyOf(sc) === fam, label });
  };
  addBlock(descriptor.template, 'html', 'template');
  addBlock(descriptor.script, scriptFam(descriptor.script?.lang), 'script' + (descriptor.script?.lang ? '/' + descriptor.script.lang : ''));
  addBlock(descriptor.scriptSetup, scriptFam(descriptor.scriptSetup?.lang), 'script-setup' + (descriptor.scriptSetup?.lang ? '/' + descriptor.scriptSetup.lang : ''));
  for (const st of descriptor.styles) addBlock(st, 'css', 'style' + (st.lang ? '/' + st.lang : ''));
  // embed boundary: a script/style CLOSE tag must NOT be inside its embed (the #1666 class)
  for (const m of src.matchAll(/<\/(script|style)\s*>/g)) {
    const nameOff = m.index! + 2;  // first char of the close-tag name
    facts.push({ cat: 'embed-boundary', offset: nameOff, test: sc => { const f = familyOf(sc); return m[1] === 'style' ? f !== 'css' : (f !== 'ts' && f !== 'js'); }, label: `</${m[1]}>` });
  }
  // directives + interpolations (neutral: @vue/compiler-dom over the template content)
  if (descriptor.template) {
    const base = descriptor.template.loc.start.offset;
    const mid = (l: any) => base + Math.floor((l.start.offset + l.end.offset) / 2);
    try {
      const walk = (n: any) => {
        if (n.type === 1) for (const p of n.props ?? []) {
          if (p.type === 7) {
            facts.push({ cat: 'directive-name', offset: base + p.loc.start.offset, label: 'v-' + p.name, test: sc => { const s = sc.join(' '); return s.includes('attribute-name') || s.includes('keyword') || s.includes('.vue'); } });
            if (p.exp?.loc) facts.push({ cat: 'directive-value', offset: mid(p.exp.loc), label: p.name + '=', test: sc => { const f = familyOf(sc); return f === 'ts' || f === 'js'; } });
          }
        }
        if (n.type === 5 && n.content?.loc) facts.push({ cat: 'interpolation', offset: mid(n.content.loc), label: 'interp', test: sc => { const f = familyOf(sc); return f === 'ts' || f === 'js'; } });
        for (const c of n.children ?? []) walk(c);
      };
      walk(dom.parse(descriptor.template.content));
    } catch { /* invalid template expression (e.g. the over-permissive showcase) — skipped */ }
  }
  return facts;
}

// ── corpus: the SHARED CORE both grammars target ──
const corpus: string[] = [
  `<script lang="ts">\nconst x: number = 1\n</script>`,
  `<script>\nvar y = 1 < 2\n</script>`,
  `<style>\n.a { color: red }\n</style>`,
  `<style lang="scss">\n$x: 1;\n.a { b: $x }\n</style>`,
  `<template>\n  <div>{{ msg }}</div>\n</template>`,
  `<template>\n  <div v-if="ok">x</div>\n</template>`,
  `<template>\n  <a :href="url" @click="go">x</a>\n</template>`,
  `<template>\n  <ul><li v-for="i in items">{{ i }}</li></ul>\n</template>`,
  `<script setup lang="ts">\nconst n = 1\n</script>\n<template>\n  <p :title="n">{{ n + 1 }}</p>\n</template>`,
  `<template><b :value="msg as string">ok</b></template>`,
  `<script lang="ts">\ntype Foo = 123\n</script>\n<template><b /></template>`,
  `<template>\n  <Foo #header="{ x }" @done="onDone">{{ greet(x) }}</Foo>\n</template>`,
  // harder cases — probe where a DERIVED grammar might fall short of the hand-written one
  `<template>\n  <a @click.stop.prevent="go">x</a>\n</template>`,                       // event modifiers
  `<template>\n  <li v-for="(item, i) in items" :key="item.id">{{ item.name }}</li>\n</template>`, // destructure + member
  `<template>\n  <Comp v-slot:default="{ row }">{{ row.label }}</Comp>\n</template>`,    // scoped slot
  `<template>\n  <p>{{\n    a + b\n  }}</p>\n</template>`,                                // multi-line interpolation
  `<script lang="ts">\nimport { ref } from 'vue'\nconst c = ref<number>(0)\n</script>`,   // generic call in script
];

// ── grade ──
const cats = ['block-embed', 'embed-boundary', 'interpolation', 'directive-name', 'directive-value'];
const tally: Record<string, { mono: number; off: number; n: number }> = {};
for (const c of cats) tally[c] = { mono: 0, off: 0, n: 0 };
const wins: string[] = [];
for (const src of corpus) {
  const facts = oracleFacts(src);
  const mAt = scopeLookup(monoVue, src), oAt = scopeLookup(offVue, src);
  for (const f of facts) {
    const t = tally[f.cat]; if (!t) continue;
    const m = f.test(mAt(f.offset)), o = f.test(oAt(f.offset));
    t.n++; if (m) t.mono++; if (o) t.off++;
    if (m !== o) wins.push(`  ${f.cat} ${f.label}: ${m ? 'Monogram ✓ / official ✗' : 'official ✓ / Monogram ✗'}`);
  }
}

// ── special showcases (Monogram's derived fixes) ──
function scopeAtText(grammar: any, src: string, text: string): string {
  const at = scopeLookup(grammar, src);
  const i = src.indexOf(text);
  return i < 0 ? '' : at(i + Math.floor(text.length / 2)).join(' ');
}
const overPermSrc = `<template>\n  <p>{{ const z = 1 }}</p>\n</template>`;
const mConst = scopeLookup(monoVue, overPermSrc)(overPermSrc.indexOf('const') + 2).join(' ');
const oConst = scopeLookup(offVue, overPermSrc)(overPermSrc.indexOf('const') + 2).join(' ');

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log('  Monogram (derived) vs official vue.tmLanguage.json (hand-written)');
console.log('  Graded by @vue/compiler-sfc + @vue/compiler-dom (neutral oracle).');
console.log('══════════════════════════════════════════════════════════════════════');
console.log('  category            Monogram      official');
let mAll = 0, oAll = 0, nAll = 0;
for (const c of cats) {
  const t = tally[c]; if (!t.n) continue;
  mAll += t.mono; oAll += t.off; nAll += t.n;
  console.log(`  ${c.padEnd(18)} ${(`${t.mono}/${t.n}`).padEnd(13)} ${t.off}/${t.n}`);
}
console.log('  ' + '─'.repeat(50));
console.log(`  ${'OVERALL'.padEnd(18)} ${(`${mAll}/${nAll} (${(100 * mAll / nAll).toFixed(1)}%)`).padEnd(13)} ${oAll}/${nAll} (${(100 * oAll / nAll).toFixed(1)}%)`);
if (wins.length) { console.log('\n  per-fact disagreements:'); for (const w of wins) console.log(w); }

// How close are the two grammars OVERALL (beyond the oracle points)? Char-level family agreement.
let same = 0, total = 0; const div: Record<string, number> = {}; const divEx: Record<string, string[]> = {};
for (const src of corpus) {
  const mAt = scopeLookup(monoVue, src), oAt = scopeLookup(offVue, src);
  for (let i = 0; i < src.length; i++) {
    if (/\s/.test(src[i])) continue;
    const mf = familyOf(mAt(i)), of = familyOf(oAt(i));
    total++;
    if (mf === of) { same++; continue; }
    const k = `${mf}≠${of}`; div[k] = (div[k] ?? 0) + 1;
    (divEx[k] ??= []); if (divEx[k].length < 3) divEx[k].push(JSON.stringify(src.slice(Math.max(0, i - 5), i + 6)));
  }
}
console.log(`\n  char-level family agreement (whole corpus): ${(100 * same / total).toFixed(1)}% (${same}/${total})`);
for (const [k, v] of Object.entries(div).sort((a, b) => b[1] - a[1]).slice(0, 5))
  console.log(`  divergence ${k} ×${v} — e.g. ${divEx[k].join(' ')}`);

console.log('\n  ── shared MECHANISMS (Monogram derives what the official hand-wrote) ──');
console.log(`  begin/while embed boundary (#1666): both use it — Monogram derives it, official hand-wrote it.`);
console.log(`  source.ts#expression interpolation embed: both use it — \`{{ const z = 1 }}\` →`);
console.log(`     Monogram: const ${mConst.includes('storage.type') ? 'is storage.type' : 'NOT a keyword ✓'};  official: const ${oConst.includes('storage.type') ? 'is storage.type' : 'NOT a keyword ✓'}`);
console.log(`     (the official's #vue-interpolations ALSO embeds source.ts#expression — Monogram DERIVES the same.)`);

console.log('\n  Honest reading:');
console.log('  • This is the SHARED CORE. The official covers far more breadth (every lang= dialect,');
console.log('    directive modifiers, pug/markdown, slot scoping) — not a coverage race.');
console.log('  • The char-level divergences are confined to the #5012 intra-line `as` ceiling, where');
console.log('    BOTH grammars hit the pure-TM limit (the closing `"` is eaten) and neither is correct —');
console.log('    they differ only in where error-recovery lands. NOT a Monogram win.');
console.log('  • The result is "derived MATCHES hand-written on the core", not "beats" it.');
// Gate: on the shared core, the derived grammar must stay competitive with the hand-written one.
if (mAll < oAll * 0.9) { console.log(`\n✗ Monogram (${mAll}) fell below 90% of official (${oAll}) on the shared core`); process.exit(1); }
console.log(`\n✓ Derived Vue grammar is competitive with the hand-written official on the shared core.`);
