// ─────────────────────────────────────────────────────────────────────────────
//  vue-issues.ts — Monogram's DERIVED Vue grammar vs the hand-written official, on REAL
//  highlighting bugs reported against vuejs/language-tools' vue.tmLanguage.json (the same
//  approach as html-bench, which tests documented textmate/html.tmbundle issues — not a
//  self-curated corpus). Each case is a faithful repro from an actual issue.
//
//  Most are CLOSED — the hand-written grammar accumulated + hand-fixed them over many
//  releases. The thesis question: does the DERIVED grammar exhibit them, or is it correct
//  BY CONSTRUCTION? The headline family is TS operators inside template expressions
//  (instanceof / typeof / ?? / ?. / => / <): the official had to patch each in the Vue
//  grammar; Monogram embeds its OWN proven TS (source.ts#expression) and gets them free.
//
//  The breakage SIGNATURE of these bugs is that highlighting LEAKS past the construct and
//  the rest of the file loses correct scopes. So every case checks a DOWNSTREAM marker
//  (`<b>DONE</b>`) recovers to HTML — not just the bug site.
//
//  Run: node test/vue-issues.ts   (needs test/fixtures/vue-official — see vue-bench.ts header)
// ─────────────────────────────────────────────────────────────────────────────
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const FIX = 'test/fixtures/vue-official';
if (!existsSync(`${FIX}/vue.tmLanguage.json`)) { console.log('⊘ Skipped: official Vue grammars not found (see test/vue-bench.ts header to fetch).'); process.exit(0); }
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));
const onigLib = Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) });
const read = (p: string) => readFileSync(p, 'utf-8');
const stub = (sn: string) => parseRawGrammar(JSON.stringify({ scopeName: sn, patterns: [{ match: '[^\\n]+', name: sn }] }), `${sn}.json`);

function mkRegistry(official: boolean) {
  return new Registry({
    onigLib,
    loadGrammar: async (sn) => {
      if (sn === 'text.html.vue') return parseRawGrammar(read(official ? `${FIX}/vue.tmLanguage.json` : 'vue.tmLanguage.json'), 'vue.json');
      if (sn === 'text.html.basic') return parseRawGrammar(read('html.tmLanguage.json'), 'html.json');
      if (sn === 'source.ts') return parseRawGrammar(read('typescript.tmLanguage.json'), 'ts.json');
      if (sn === 'source.js') return parseRawGrammar(read('javascript.tmLanguage.json'), 'js.json');
      if (sn === 'vue.injection') return parseRawGrammar(read('vue.injection.tmLanguage.json'), 'inj.json');
      if (sn === 'vue.directives') return parseRawGrammar(read(`${FIX}/vue-directives.json`), 'dir.json');
      if (sn === 'vue.interpolations') return parseRawGrammar(read(`${FIX}/vue-interpolations.json`), 'int.json');
      if (sn.startsWith('source.')) return stub(sn);
      return null;  // text.* → no-op include (text.html.basic does the parsing)
    },
    getInjections: (sn) => official
      ? (sn === 'text.html.vue' ? ['vue.directives', 'vue.interpolations'] : undefined)
      : ((sn === 'text.html.basic' || sn === 'text.html.vue') ? ['vue.injection'] : undefined),
  });
}
async function loadVue(official: boolean) {
  const reg = mkRegistry(official);
  if (official) { await reg.loadGrammar('vue.directives'); await reg.loadGrammar('vue.interpolations'); }
  else { await reg.loadGrammar('vue.injection'); }
  return (await reg.loadGrammar('text.html.vue'))!;
}
const monoVue = await loadVue(false), offVue = await loadVue(true);

function scopeLookup(grammar: any, src: string): (offset: number) => string {
  const lines = src.split('\n'); const lineStart: number[] = []; let acc = 0;
  for (const l of lines) { lineStart.push(acc); acc += l.length + 1; }
  const lineToks: any[][] = []; let stack: any = INITIAL;
  for (const l of lines) { const r = grammar.tokenizeLine(l, stack); lineToks.push(r.tokens); stack = r.ruleStack; }
  return (offset: number) => {
    let li = 0; while (li + 1 < lineStart.length && lineStart[li + 1] <= offset) li++;
    const col = offset - lineStart[li];
    for (const t of lineToks[li] ?? []) if (col >= t.startIndex && col < t.endIndex) return t.scopes.join(' ');
    return '';
  };
}
const familyOf = (s: string) => s.includes('source.ts') || s.includes('source.ts.embedded') ? 'ts'
  : s.includes('source.js') ? 'js' : s.includes('source.css') ? 'css' : s.includes('text.html') ? 'html' : 'other';

// at(text[, nth]) → scope string at the middle of the nth occurrence of `text`.
function makeAt(look: (o: number) => string, src: string) {
  return (text: string, nth = 0) => {
    let i = -1; for (let k = 0; k <= nth; k++) i = src.indexOf(text, i + 1);
    return i < 0 ? '__NOT_FOUND__' : look(i + Math.floor(text.length / 2));
  };
}

interface Check { at: string; nth?: number; want: (s: string) => boolean; desc: string }
interface Case { id: string; title: string; src: string; checks: Check[] }
const embedded = (s: string) => s.includes('source.ts') || s.includes('source.js');
const htmlText = (s: string) => familyOf(s) === 'html';          // recovered to HTML (didn't leak into the embed)
const DONE = '\n  <b>DONE</b>\n</template>';                     // downstream marker — must recover to HTML

const cases: Case[] = [
  // ── TS operators inside template expressions — Monogram embeds proven TS, gets these free ──
  { id: '#3400', title: '`instanceof` in {{ }}', src: `<template>\n  <div>{{ err instanceof Error }}</div>${DONE}`,
    checks: [{ at: 'instanceof', want: embedded, desc: 'instanceof embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers to HTML' }] },
  { id: '#5370', title: '`typeof x !==` in v-if', src: `<template>\n  <p v-if="typeof x !== 'number'">a</p>${DONE}`,
    checks: [{ at: 'typeof', want: embedded, desc: 'typeof embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#5118', title: '`?.` / `??` in {{ }}', src: `<template>\n  <div>{{ a?.b ?? c }}</div>${DONE}`,
    checks: [{ at: '??', want: embedded, desc: 'nullish embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#1675', title: 'arrow `=>` in {{ }}', src: `<template>\n  <div>{{ items.map(i => i.id) }}</div>${DONE}`,
    checks: [{ at: '=>', want: embedded, desc: 'arrow embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#6039/#4741', title: '`<` operator in {{ }} (not a tag!)', src: `<template>\n  <div>{{ a < b }}</div>${DONE}`,
    checks: [{ at: 'DONE', want: htmlText, desc: 'the `<` is not mistaken for a tag — downstream recovers' }] },
  { id: '#5722', title: 'negated ternary + quotes in {{ }}', src: `<template>\n  <div>{{ !ok ? 'yes' : 'no' }}</div>${DONE}`,
    checks: [{ at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  // ── `as` type assertion (the #5012 intra-line ceiling family) ──
  { id: '#6007/#2096/#520', title: '`as` type assertion in directive value', src: `<template>\n  <Foo :schema="x as JSONSchema" />${DONE}`,
    checks: [{ at: 'as', want: embedded, desc: '`as` embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers (begin/while bounds it)' }] },
  // ── script / boundary family ──
  { id: '#5538/#2060', title: 'trailing `export type` before </script>', src: `<script lang="ts">\nexport type T = number\n</script>\n<template>\n  <p>hi</p>${DONE}`,
    checks: [{ at: 'hi', want: htmlText, desc: '</script> ends the embed — template is HTML' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#3999', title: 'multi-line <script> start-tag attributes', src: `<script\n  lang="ts"\n>\nconst x = 1\n</script>`,
    checks: [{ at: 'const', want: embedded, desc: 'body still embeds as TS across the multi-line tag' }] },
  // ── tag / interpolation edge cases ──
  { id: '#4769', title: 'tag name starting with `template`', src: `<template>\n  <templatex>{{ y }}</templatex>${DONE}`,
    checks: [{ at: 'y', want: embedded, desc: 'interpolation inside a template-prefixed tag works' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#5701', title: '`{{` inside a <script> string', src: `<script>\nconst s = "{{ not interp }}"\n</script>\n<template>\n  <p>{{ real }}</p>${DONE}`,
    checks: [{ at: 'real', want: embedded, desc: 'the real interpolation still embeds as TS' }, { at: 'DONE', want: htmlText, desc: 'downstream recovers' }] },
  { id: '#6070', title: 'capitalized component then a <style> block', src: `<template>\n  <MyComp @click="f">x</MyComp>\n</template>\n<style>\n.a { color: red }\n</style>`,
    checks: [{ at: 'color', want: s => familyOf(s) === 'css', desc: '<style> after a capitalized tag still embeds as CSS' }] },
];

// Expected outcomes — a SNAPSHOT of the honest current state, so this gate catches a
// REGRESSION (a ✓ that flips to ✗) or an unexpected change. Two cases are Monogram gaps:
//   #6007 — shared #5012 intra-line `as` ceiling (both fail; pure-TM limit, semantic-only).
//   #3999 — multi-line <script> start tag: Monogram's raw-text region assumes a single-line
//           start tag (the begin needs `>` on the line). Fixable via a raw-text restructure;
//           niche (only with html.format.wrapAttributes=force-expand-multiline). KNOWN GAP.
const expect: Record<string, { mono: boolean; off: boolean }> = {
  '#3400': { mono: true, off: true }, '#5370': { mono: true, off: true }, '#5118': { mono: true, off: true },
  '#1675': { mono: true, off: true }, '#6039/#4741': { mono: true, off: true }, '#5722': { mono: true, off: true },
  '#6007/#2096/#520': { mono: false, off: false }, '#5538/#2060': { mono: true, off: true },
  '#3999': { mono: false, off: true }, '#4769': { mono: true, off: true }, '#5701': { mono: true, off: true },
  '#6070': { mono: true, off: true },
};

let mPass = 0, oPass = 0; const rows: string[] = []; const deviations: string[] = [];
for (const c of cases) {
  const mAt = makeAt(scopeLookup(monoVue, c.src), c.src), oAt = makeAt(scopeLookup(offVue, c.src), c.src);
  const mOk = c.checks.every(ch => ch.want(mAt(ch.at, ch.nth)));
  const oOk = c.checks.every(ch => ch.want(oAt(ch.at, ch.nth)));
  if (mOk) mPass++; if (oOk) oPass++;
  const gap = !mOk && oOk ? '  ← Monogram gap' : (!mOk && !oOk ? '  ← shared ceiling' : '');
  rows.push(`  ${c.id.padEnd(16)} ${(mOk ? '✓' : '✗').padEnd(9)} ${(oOk ? '✓' : '✗').padEnd(9)} ${c.title}${gap}`);
  const e = expect[c.id];
  if (e && (e.mono !== mOk || e.off !== oOk)) deviations.push(`  ${c.id}: expected Monogram ${e.mono}/official ${e.off}, got ${mOk}/${oOk}`);
}

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log('  REAL reported highlighting issues vs vuejs/language-tools vue.tmLanguage.json');
console.log('  (both grammars CURRENT; both embed Monogram\'s source.ts — isolates the Vue layer)');
console.log('══════════════════════════════════════════════════════════════════════');
console.log(`  ${'issue'.padEnd(16)} ${'Monogram'.padEnd(9)} ${'official'.padEnd(9)} title`);
for (const r of rows) console.log(r);
console.log('  ' + '─'.repeat(60));
console.log(`  ${'PASS'.padEnd(16)} ${(`${mPass}/${cases.length}`).padEnd(9)} ${oPass}/${cases.length}`);
console.log(`\n  Honest reading: these are REAL bugs the hand-written grammar accumulated + hand-fixed`);
console.log(`  over many releases. Monogram WINS the operator family (instanceof / typeof / ?? / ?. /`);
console.log(`  => / <) BY CONSTRUCTION — it embeds its own proven TS, never a per-operator patch.`);
console.log(`  Monogram GAPS: #6007 (shared #5012 \`as\` intra-line ceiling — both fail, semantic-only);`);
console.log(`  #3999 (multi-line <script> start tag — single-line-only raw-text region; fixable, niche).`);
// Gate: reality must match the recorded snapshot — catches a regression or an unexpected change.
if (deviations.length) { console.log('\n✗ Result changed from the recorded snapshot (update expect{} if intended):'); for (const d of deviations) console.log(d); process.exit(1); }
console.log(`\n✓ Matches the recorded snapshot: Monogram ${mPass}/${cases.length}, official ${oPass}/${cases.length} on real reported issues.`);
