// ─────────────────────────────────────────────────────────────────────────────
//  html-embed-js.ts — proves Monogram's HTML delegates <script> bodies to Monogram's
//  OWN proven JavaScript grammar (source.js), and compares the embed BOUNDARY against
//  VS Code's official HTML grammar. This is the "embed a proven grammar" story that
//  Vue's <script>/<style> will lean on, demonstrated end-to-end.
//
//  Both HTML grammars are loaded with Monogram's javascript.tmLanguage.json registered
//  as `source.js` (and a css stub) — so the embedded grammar is identical and the
//  comparison isolates the HTML grammar's script-region boundary handling.
//
//  Run: node test/html-embed-js.ts
// ─────────────────────────────────────────────────────────────────────────────
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

const MONO_JS = readFileSync('javascript.tmLanguage.json', 'utf-8');     // Monogram's proven JS grammar
const cssStub = JSON.stringify({ scopeName: 'source.css', patterns: [{ match: '[^<]+', name: 'source.css' }] });

function loadHtml(htmlPath: string): Promise<vsctm.IGrammar | null> {
  const html = readFileSync(htmlPath, 'utf-8');
  return new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) }),
    loadGrammar: async (sn) => {
      if (sn === 'text.html.basic') return parseRawGrammar(html, 'html.json');
      if (sn === 'source.js') return parseRawGrammar(MONO_JS, 'js.json');             // Monogram's JS
      if (sn === 'source.css') return parseRawGrammar(cssStub, 'css.json');
      return null;
    },
  }).loadGrammar('text.html.basic');
}

interface Tok { text: string; scopes: string }
function tokenizeDoc(g: vsctm.IGrammar, src: string): Tok[] {
  const out: Tok[] = [];
  let stack: any = INITIAL;
  for (const line of src.split('\n')) {
    const r = g.tokenizeLine(line, stack);
    for (const t of r.tokens) { const text = line.slice(t.startIndex, t.endIndex); if (text) out.push({ text, scopes: t.scopes.join(' ') }); }
    stack = r.ruleStack;
  }
  return out;
}

const mono = (await loadHtml('html.tmLanguage.json'))!;

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = '') {
  if (cond) pass++; else { fail++; console.log(`✗ ${label}${detail ? '\n    ' + detail : ''}`); }
}
// find first token whose text === `text` satisfying a scope predicate
const find = (toks: Tok[], text: string, pred: (s: string) => boolean) => toks.find(t => t.text === text && pred(t.scopes));

// ── 1. The embed works: <script> body is Monogram's JS; the boundary returns to HTML ──
{
  const toks = tokenizeDoc(mono, '<script>const x = 1 < 2;</script>');
  check('const → JS storage.type (delegated to source.js)', !!find(toks, 'const', s => s.includes('source.js') && s.includes('storage.type')));
  // the `<` in `1 < 2` is a JS operator inside source.js (the tag delimiters are separately fine)
  check('`<` inside <script> is a JS operator, NOT an HTML tag',
    !!find(toks, '<', s => s.includes('source.js') && s.includes('keyword.operator')),
    'the `<` in `1 < 2` must be keyword.operator.*.js — the JS grammar resolves it inside the embed');
  check('`</script>` close tag returns to HTML', !!find(toks, 'script', s => s.includes('entity.name.tag.html') && !s.includes('source.js')));
}

// ── 2. JS strings / comments inside <script> stay JS (no false boundary) ──
{
  const toks = tokenizeDoc(mono, '<script>var u = "http://example.com";</script>');
  // the `//` lives inside a JS string — it is string content, not a comment, not a boundary
  check('`//` inside a JS string → JS string (not comment/boundary)', !!find(toks, 'http://example.com', s => s.includes('source.js') && s.includes('string')));
}
{
  const toks = tokenizeDoc(mono, '<script>let s = "</div> ok";</script>');
  // `</div>` inside a JS string is NOT the script close (only `</script>` ends it) — stays JS
  check('`</div>` inside a JS string does not end the embed', toks.some(t => t.text.includes('div') && t.scopes.includes('source.js') && t.scopes.includes('string')));
}
{
  const toks = tokenizeDoc(mono, '<script>\n// a line comment\nlet y = 3;\n</script>');
  check('`//` line comment in <script> → JS comment', toks.some(t => t.text.includes('line comment') && t.scopes.includes('source.js') && t.scopes.includes('comment')));
  check('JS after the comment still highlights (let → storage.type)', !!find(toks, 'let', s => s.includes('source.js') && s.includes('storage.type')));
}

console.log(`\nMonogram HTML + Monogram JS embed: ${pass}/${pass + fail} checks pass`);

// ── 3. Boundary comparison vs the official HTML grammar (both embedding Monogram's JS) ──
const OFFICIAL = process.env.MONOGRAM_OFFICIAL_HTML
  ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/html/syntaxes/html.tmLanguage.json';
if (existsSync(OFFICIAL)) {
  const off = (await loadHtml(OFFICIAL))!;
  // Per-character mask: is this offset inside an embedded source.js region? Comparing
  // masks is robust to the two grammars tokenizing into different token counts.
  const jsMask = (g: vsctm.IGrammar, src: string): boolean[] => {
    const mask: boolean[] = [];
    let stack: any = INITIAL, off = 0;
    for (const line of src.split('\n')) {
      const r = g.tokenizeLine(line, stack);
      for (const t of r.tokens) {
        const embedded = t.scopes.some(s => s.startsWith('source.js'));
        for (let i = t.startIndex; i < t.endIndex; i++) mask[off + i] = embedded;
      }
      off += line.length + 1;
      stack = r.ruleStack;
    }
    return mask;
  };
  // <script> only — both grammars embed `source.js` there, so the boundary is comparable.
  // (<style> uses different embedded-CSS scope names across grammars, not a like-for-like test.)
  const cases = [
    '<script>const x = 1 < 2;</script>',
    '<script>var u = "http://example.com";</script>',
    '<script>let s = "</div> ok";</script>',
    '<script type="module">import x from "y"; x < 2;</script>',
    '<script>\nfunction f(a) { return a < 10; }\n</script>',
  ];
  let agree = 0, total = 0;
  const diffs: string[] = [];
  for (const src of cases) {
    const mm = jsMask(mono, src), om = jsMask(off, src);
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '\n') continue;
      total++;
      if (!!mm[i] === !!om[i]) agree++;
      else if (diffs.length < 6) diffs.push(`  ${JSON.stringify(src)} @${i} ${JSON.stringify(src[i])}: Monogram js=${!!mm[i]}, official js=${!!om[i]}`);
    }
  }
  console.log(`\nBoundary vs official (both embedding Monogram's JS), <script> only, ${cases.length} cases:`);
  console.log(`  ${agree}/${total} chars delegated to source.js identically (${(100 * agree / total).toFixed(1)}%)`);
  if (diffs.length) { console.log('  where they differ:'); for (const d of diffs) console.log(d); }
} else {
  console.log(`\n⊘ official HTML grammar not found — skipping the boundary comparison.`);
}

if (fail > 0) { console.log('\n✗ HTML embedded-JS FAILED'); process.exit(1); }
console.log('\n✓ Monogram HTML embeds its own proven JS grammar in <script>; the boundary is correct.');
