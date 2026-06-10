// Benchmark the EMITTED Monogram parsers against the reference parser of each
// ecosystem, same methodology as profile-vs-tsc.mjs (warmup ×10, min of 5 rounds):
//   - javascript.ts vs acorn (the ESTree reference implementation), on real-world
//     JS from node_modules — including acorn parsing itself and the 8.7MB
//     typescript.js bundle.
//   - html.ts vs parse5 (the WHATWG reference implementation), on synthesized
//     well-formed documents (Monogram's HTML grammar is the well-formed subset,
//     so the corpus is generated from a representative block — disclosed as such).
// Output shapes differ by design — Monogram builds a full CST (every token a
// leaf), acorn an ESTree AST, parse5 a DOM-shaped tree — so this is parse-to-tree
// wall time on identical inputs, not equal-work accounting.
//   node test/profile-vs-peers.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const acorn = await import(REPO + '/node_modules/acorn/dist/acorn.mjs');
const parse5 = await import(REPO + '/node_modules/parse5/dist/index.js');
const { emitParser } = await import(REPO + '/src/emit-parser.ts');

writeFileSync('/tmp/emitted-peers-js.mjs', emitParser((await import(REPO + '/javascript.ts')).default));
writeFileSync('/tmp/emitted-peers-html.mjs', emitParser((await import(REPO + '/html.ts')).default));
const monoJs = await import('/tmp/emitted-peers-js.mjs?v=' + Date.now());
const monoHtml = await import('/tmp/emitted-peers-html.mjs?v=' + Date.now());

function time(fn, code, name, n) {
  const s = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn(code, name);
  return Number(process.hrtime.bigint() - s) / 1e6 / n;
}
function bench(rows, parseA, parseB) {
  let ta = 0, tb = 0;
  for (const { name, code } of rows) {
    const iters = code.length > 1e6 ? 3 : 20;
    for (let i = 0; i < 10 && i * code.length < 2e7; i++) { parseA(code, name); parseB(code, name); }
    let a = Infinity, b = Infinity;
    for (let r = 0; r < 5; r++) {
      a = Math.min(a, time(parseA, code, name, iters));
      b = Math.min(b, time(parseB, code, name, iters));
    }
    ta += a; tb += b;
    console.log(`${name.padEnd(30)}${(code.length / 1024).toFixed(0).padStart(5)}   ${a.toFixed(2).padStart(8)}   ${b.toFixed(2).padStart(8)}     ${(a / b).toFixed(2).padStart(6)}x`);
  }
  console.log('-'.repeat(72));
  console.log(`${'AGGREGATE'.padEnd(30)}        ${ta.toFixed(2).padStart(8)}   ${tb.toFixed(2).padStart(8)}     ${(ta / tb).toFixed(2).padStart(6)}x`);
}

// ── JavaScript vs acorn ──
const jsFiles = [
  'node_modules/acorn/dist/acorn.js',
  'node_modules/@vue/compiler-core/dist/compiler-core.cjs.js',
  'node_modules/parse5/dist/parser/index.js',
  'node_modules/typescript/lib/typescript.js',
].map((p) => ({ name: p.split('/').pop(), code: readFileSync(resolve(REPO, p), 'utf-8') }));

// acorn needs the right sourceType per file (ESM dist files vs scripts) — detect once.
const sourceType = new Map(jsFiles.map(({ name, code }) => {
  try { acorn.parse(code, { ecmaVersion: 'latest' }); return [name, 'script']; }
  catch { return [name, 'module']; }
}));
const acornParse = (code, name) => acorn.parse(code, { ecmaVersion: 'latest', sourceType: sourceType.get(name) });

console.log('── JavaScript: emitted javascript.ts vs acorn (ESTree reference) ──');
console.log('file                             KB    mono ms   acorn ms   mono/acorn');
console.log('-'.repeat(72));
bench(jsFiles, (c) => monoJs.parse(c), (c, name) => acornParse(c, name));

// ── HTML vs parse5 ──
const block = `
<section class="card" data-id="42">
  <h2 id="t42">Title &amp; subtitle</h2>
  <p>Some <em>emphasized</em> and <strong>bold</strong> text with an <a href="/x?a=1&amp;b=2">anchor</a>.</p>
  <ul>
    <li>alpha</li>
    <li>beta <span class="tag">x</span></li>
  </ul>
  <table>
    <tr><th>k</th><th>v</th></tr>
    <tr><td>1</td><td>one</td></tr>
  </table>
  <!-- block comment -->
  <img src="/img.png" alt="pic"/>
  <input type="text" value="v" disabled/>
</section>`;
// Fragment-level on both sides (Monogram's HTML grammar is the well-formed
// FRAGMENT subset — no doctype/html scaffolding), so parse5 gets parseFragment.
const doc = (n) => `<div id="root">
  <style>.card { color: #333; } .tag::after { content: "*"; }</style>
  <script>function f(a, b) { return a < b ? a : b; }</script>${block.repeat(n)}
</div>`;
const htmlDocs = [50, 200, 800].map((kb) => {
  const n = Math.round((kb * 1024) / block.length);
  const code = doc(n);
  return { name: `synthetic-${(code.length / 1024).toFixed(0)}kb.html`, code };
});

console.log('\n── HTML: emitted html.ts vs parse5 (WHATWG reference) ──');
console.log('doc                              KB    mono ms  parse5 ms   mono/parse5');
console.log('-'.repeat(72));
// Sanity: both sides must actually parse the synthetic corpus.
for (const { name, code } of htmlDocs) { monoHtml.parse(code); parse5.parseFragment(code); }
bench(htmlDocs, (c) => monoHtml.parse(c), (c) => parse5.parseFragment(c));
