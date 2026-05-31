// ─────────────────────────────────────────────────────────────────────────────
//  html-bench.ts — the HTML "competition": Monogram's DERIVED HTML TextMate grammar
//  vs the official VS Code hand-written HTML grammar, graded at the token-FAMILY level
//  against a NEUTRAL oracle. For TypeScript that oracle is `tsc`; for HTML it is
//  `parse5` (the reference WHATWG parser), which tells us the true ROLE of every span —
//  tag name, attribute name, attribute value, comment — independent of either grammar.
//
//  For each role-bearing span we sample one offset, ask each engine for its scope there,
//  and check the scope's family matches the role. Higher = more correct. Mirrors
//  test/highlight-bench.ts (the README TS/JS table), with parse5 in tsc's seat.
//
//  Set MONOGRAM_OFFICIAL_HTML to override the official grammar path.
//  Run: node test/html-bench.ts
// ─────────────────────────────────────────────────────────────────────────────
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseFragment } from 'parse5';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

const MONO = 'html.tmLanguage.json';
const OFFICIAL = process.env.MONOGRAM_OFFICIAL_HTML
  ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/html/syntaxes/html.tmLanguage.json';
if (!existsSync(OFFICIAL)) {
  // Like the other official-comparison benches, skip gracefully when VS Code's grammar
  // isn't on this machine (e.g. CI) rather than fail.
  console.log(`⊘ Skipped: official HTML grammar not found. Set MONOGRAM_OFFICIAL_HTML=/path/to/html.tmLanguage.json`);
  process.exit(0);
}

// vscode-textmate drops a begin/end rule whose patterns reference an unregistered
// grammar, so register tiny stubs for the scopes both grammars embed in <script>/<style>.
const embedStub = (scope: string) => JSON.stringify({ scopeName: scope, patterns: [{ match: '[^<]+', name: `${scope}` }] });
function load(path: string): Promise<vsctm.IGrammar | null> {
  const content = readFileSync(path, 'utf-8');
  return new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) }),
    loadGrammar: async (sn) => {
      if (sn === 'text.html.basic') return parseRawGrammar(content, 'g.json');
      if (sn === 'source.js' || sn === 'source.css' || sn === 'text.html.basic.js' || sn === 'source.css.embedded.html') return parseRawGrammar(embedStub(sn), sn + '.json');
      return null;
    },
  }).loadGrammar('text.html.basic');
}
const mono = (await load(MONO))!;
const official = (await load(OFFICIAL))!;

type Role = 'tag' | 'attribute' | 'string' | 'comment';
interface Span { offset: number; role: Role }

// Extract role-bearing offsets from parse5 (the neutral oracle). One representative
// offset per span; the whole span shares a scope, so one sample suffices.
function rolesOf(html: string): Span[] {
  const frag = parseFragment(html, { sourceCodeLocationInfo: true });
  const out: Span[] = [];
  const walk = (n: any) => {
    const L = n.sourceCodeLocation;
    if (n.tagName && L) {
      if (L.startTag) out.push({ offset: L.startTag.startOffset + 1, role: 'tag' });       // char after `<`
      if (L.endTag) out.push({ offset: L.endTag.startOffset + 2, role: 'tag' });            // char after `</`
      for (const loc of Object.values(L.attrs ?? {}) as any[]) {
        out.push({ offset: loc.startOffset, role: 'attribute' });                            // first char of attr name
        const text = html.slice(loc.startOffset, loc.endOffset);
        const eq = text.indexOf('=');
        if (eq >= 0) {
          let v = loc.startOffset + eq + 1;
          let end = loc.endOffset;
          if (html[v] === '"' || html[v] === "'") { v++; end--; }                            // skip surrounding quotes
          // grade EVERY char of the value — catches a literal `<` inside (e.g. title="x < y")
          for (let i = v; i < end; i++) if (!/\s/.test(html[i])) out.push({ offset: i, role: 'string' });
        }
      }
    } else if (n.nodeName === '#comment' && L) {
      // grade EVERY char inside the comment — catches a tag-shaped body (<!-- <div> -->)
      for (let i = L.startOffset + 4; i < L.endOffset - 3; i++) if (!/\s/.test(html[i])) out.push({ offset: i, role: 'comment' });
    }
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(frag);
  return out;
}

// Family of a TextMate scope path (most-specific scope wins).
function familyOf(scopes: string): Role | 'other' {
  const s = scopes;
  if (/entity\.name\.tag/.test(s)) return 'tag';
  if (/entity\.other\.attribute-name/.test(s)) return 'attribute';
  if (/\bstring\b/.test(s)) return 'string';
  if (/\bcomment\b/.test(s)) return 'comment';
  return 'other';
}
function scopeAt(g: vsctm.IGrammar, line: string, offset: number): string {
  const r = g.tokenizeLine(line, INITIAL);
  for (const t of r.tokens) if (offset >= t.startIndex && offset < t.endIndex) return t.scopes.join(' ');
  return '';
}

// Realistic single-line well-formed HTML (one line so offset === column).
const corpus: string[] = [
  '<div class="x" id="y">hello</div>',
  '<p>a <b>bold</b> and <i>italic</i> c</p>',
  '<ul><li>one</li><li>two</li></ul>',
  '<a href="https://example.com" target="_blank">link</a>',
  '<input type="text" placeholder="name" disabled>',
  '<img src="a.png" alt="pic">',
  '<br/><hr/>',
  '<button type="submit" class="btn btn-primary">Go</button>',
  '<meta charset="utf-8">',
  '<div data-id=42 hidden><span>x</span></div>',
  '<section id="main"><h1>Title</h1><p>Body.</p></section>',
  '<custom-element data-x="1"><slot-content>hi</slot-content></custom-element>',
  '<div><!-- a comment --><p>x</p></div>',
  '<form action="/submit" method="post"><label for="n">Name</label></form>',
  '<nav><a href="/">Home</a><a href="/about">About</a></nav>',
  // ── adversarial: where hand-written regex grammars tend to slip ──
  '<DIV CLASS="x">Hi</DIV>',                          // uppercase tag + attr names
  '<svg:rect width="10" height="10"/>',              // namespaced tag name
  '<a title="x < y & z">link</a>',                    // `<` inside an attribute value
  '<!-- <div class="x"> is not a tag -->',           // a tag-shaped comment body
  '<input disabled required readonly>',              // several boolean attributes
  '<my-widget data-config="{a:1}" aria-label="w">x</my-widget>',  // custom element + data-/aria-
  '<p>1 &lt; 2 &amp; 3</p>',                          // entities in text
  '<td colspan=2 rowspan=3>cell</td>',               // multiple unquoted numeric values
];

interface Tally { ok: number; total: number }
const tally = (): Record<Role, Tally> => ({ tag: { ok: 0, total: 0 }, attribute: { ok: 0, total: 0 }, string: { ok: 0, total: 0 }, comment: { ok: 0, total: 0 } });
const monoT = tally(), offT = tally();
let monoOk = 0, offOk = 0, total = 0;

for (const line of corpus) {
  for (const { offset, role } of rolesOf(line)) {
    total++;
    monoT[role].total++; offT[role].total++;
    if (familyOf(scopeAt(mono, line, offset)) === role) { monoOk++; monoT[role].ok++; }
    if (familyOf(scopeAt(official, line, offset)) === role) { offOk++; offT[role].ok++; }
  }
}

const pct = (n: number, d: number) => d === 0 ? '  n/a' : `${(100 * n / d).toFixed(1)}%`;
console.log(`── HTML token-family accuracy vs a neutral parse5 oracle (${total} role-bearing spans) ──\n`);
console.log(`  role         Monogram   official`);
for (const role of ['tag', 'attribute', 'string', 'comment'] as Role[]) {
  console.log(`  ${role.padEnd(11)}  ${pct(monoT[role].ok, monoT[role].total).padStart(6)}     ${pct(offT[role].ok, offT[role].total).padStart(6)}   (${monoT[role].total} spans)`);
}
console.log(`  ${'OVERALL'.padEnd(11)}  ${pct(monoOk, total).padStart(6)}     ${pct(offOk, total).padStart(6)}`);

// Qualitative differentiator: equal correctness, but Monogram's is DERIVED + smaller +
// uniform (no baked-in tag-name list to maintain), vs the official hand-written grammar.
const ruleCount = (path: string) => Object.keys(JSON.parse(readFileSync(path, 'utf-8')).repository ?? {}).length;
const lines = (path: string) => readFileSync(path, 'utf-8').split('\n').length;
console.log(`\n  Monogram: DERIVED from html.ts (${lines('html.ts')} lines) → ${ruleCount(MONO)} repository rules`);
console.log(`  Official: hand-written, ${ruleCount(OFFICIAL)} repository rules (with a baked-in HTML tag-name list)`);
console.log(`\n  Monogram (derived) vs official VS Code HTML grammar (hand-written), graded by parse5.`);

// Gate: the derived grammar must stay at least as correct as the official one.
if (monoOk < offOk) {
  console.log(`\n✗ Monogram (${pct(monoOk, total)}) trails official (${pct(offOk, total)})`);
  process.exit(1);
}
console.log(`\n✓ Monogram's derived HTML highlighter matches the official hand-written grammar on token-family correctness (${pct(monoOk, total)} vs ${pct(offOk, total)})`);
