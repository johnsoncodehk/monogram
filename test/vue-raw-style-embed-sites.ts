// vue-raw-style-embed-sites.ts — an enumerator of the <style lang="…"> RAW-STYLE EMBED across
// (dialect × structural position), tokenised with the REAL oniguruma engine and graded against an
// INDEPENDENT oracle: the dialect scope the GRAMMAR ITSELF declares for the embed.
//
// THE CLASS (issue #43): a <style lang="X"> body delegates to the CSS dialect grammar source.css.X
// the grammar's own embed map names. The derived TextMate grammar splits that delegation into per-
// dialect open + close rules; the CLOSE rule's match is language-INDEPENDENT (the lang lives on the
// OPEN tag, not on `</style>`), so every dialect's close rule shares one regex and only the first-
// listed fires — a non-first dialect's CLOSE-LINE content (the pre-`</style>` text) is then embedded
// in the WRONG dialect. A bug is exactly: content that should be source.css.X carries some other
// source.css.* instead.
//
// WHY THE EXISTING GATES MISSED IT (see issue #43 discussion): scope-gap-vue grades the Vue shell
// (tags/directives/interpolation) against @vue/compiler-sfc+parse5+tsc — it has NO CSS oracle, so the
// embedded dialect is structurally ungraded. This test adds that missing axis: an oracle that is the
// grammar's DECLARED embed scope (not Monogram's parser, which raw-texts the body as a blob), and
// DERIVED witnesses (each dialect × each structural position) rather than a thin corpus.
//
// CLOSED LOOP / no hardcoding: the dialects + their expected scopes come from the SAME grammar source
// the emitter derives the rules from (`grammar.markup.rawText.embed.style`).
//
// Run: node test/vue-raw-style-embed-sites.ts
import { tokenize } from './vue-grammar-harness.ts';
import grammar from '../vue.ts';

const style = (grammar as any).markup?.rawText?.embed?.style;
if (!style) { console.error('vue grammar has no markup.rawText.embed.style'); process.exit(1); }

// [langAttr | null (default), expectedScope]; closed-loop from the grammar's own embed map.
const dialects: [string | null, string][] = [
  [null, style.default],
  ...Object.entries(style.lang as Record<string, string>).map(([k, v]) => [k, v] as [string, string]),
];

// Structural positions. Each builds a <style> block; `find` is the CSS-content selector token whose
// scope chain MUST contain the dialect's declared scope, and `pos` labels where it sits.
function witnesses(lang: string | null): { pos: string; src: string; find: string }[] {
  const open = lang === null ? '<style>' : `<style lang="${lang}">`;
  return [
    // baseline: content on its OWN line, close on its own line (the path that already works).
    { pos: 'content-line', src: `${open}\n.midline { a: 1 }\n</style>`, find: 'midline' },
    // THE BUG: content on the SAME line as the close `</style>` — the per-dialect close rule's capture.
    { pos: 'close-line  ', src: `${open}\n.firstline { a: 1 }\n.closeline { b: 2 }</style>`, find: 'closeline' },
    // single-line: open, content, and close all on one line.
    { pos: 'single-line ', src: `${open}.oneline { c: 3 }</style>`, find: 'oneline' },
  ];
}

const cssScope = (chain: string) => chain.split(' ').find(s => s.startsWith('source.css') || s === 'source.sass' || s === 'source.stylus' || s === 'source.postcss') ?? '(none)';

let cells = 0, wrong = 0;
const fails: string[] = [];
for (const [lang, expected] of dialects) {
  for (const w of witnesses(lang)) {
    cells++;
    const toks = await tokenize('mono', w.src);
    const t = toks.find(x => x.text.includes(w.find));
    const got = t ? cssScope(t.scopes) : '(token not found)';
    const ok = t !== undefined && t.scopes.split(' ').includes(expected);
    if (!ok) { wrong++; fails.push(`<style ${lang === null ? '(default)' : `lang="${lang}"`}> @ ${w.pos.trim()}: want ${expected}, got ${got}`); }
    console.log(`  ${ok ? '✓ ok  ' : '✗ BUG '}[${(lang ?? 'default').padEnd(7)} × ${w.pos}] want ${expected.padEnd(16)} got ${got}`);
  }
}

console.log(`\n  ${cells} raw-style-embed cells · ${cells - wrong} ok · ${wrong} wrong`);
if (wrong) {
  console.error(`\n  RAW-STYLE EMBED BUG — a <style lang="X"> body embedded in the wrong CSS dialect:\n    ${fails.join('\n    ')}`);
  process.exit(1);
}
console.log('  ✓ every <style lang="X"> body — at every structural position — embeds the dialect the grammar declares.');
