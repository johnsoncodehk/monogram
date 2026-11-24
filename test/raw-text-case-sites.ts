// raw-text-case-sites.ts — an enumerator of the RAW-TEXT element sites across LETTER CASE + a witness
// MATRIX, mirroring the depth-sites section of yaml-sites.ts (the blind-spot LOCK for a bug class).
//
// THE CLASS: HTML tag names are CASE-INSENSITIVE. A raw-text element (`<script>`/`<style>`/
// `<textarea>`/`<title>`) scans its body VERBATIM to its close tag, so a `<x` inside the body is NOT
// a tag — it is literal raw-text content. The Monogram LEXER folds case (`.toLowerCase()`), so the
// PARSER raw-texts `<SCRIPT>` exactly like `<script>`. If the flat TextMate emitter keys the raw-text
// region on CASE-SENSITIVE lowercase literals, a mixed-case open tag (`<SCRIPT>`, `<Script>`,
// `<ScRiPt>`) falls through to the generic `#tag` rule, and the highlighter then INVENTS tags inside
// the body (`<b` → entity.name.tag) and paints the close-tag NAME as an attribute name. A bug is
// exactly a mixed-case raw-text element whose body or close differs from its lowercase twin.
//
// CLOSED LOOP / no hardcoding: the raw-text element NAMES come from the SAME grammar source the
// emitter derives the rules from (`grammar.markup.rawText.tags`) — not a hand-written list. For each
// raw-text tag we build a body containing a `<x` (the would-be invented tag) and grade two ROLES:
//   (A) the BODY `<x` must NOT be painted as markup — no `entity.name.tag` anywhere in its scope chain
//       (its lowercase twin is raw-text content / an embedded sublanguage; a tag scope is the bug);
//   (B) the CLOSE-TAG NAME must be `entity.name.tag` (a raw-text close, not an attribute name).
// The LOWERCASE form is the by-construction-correct PRESERVE baseline; every cased variant must match
// it on both roles. Self-contained pass/fail; the official VS Code HTML grammar is shown for context.
// A second section checks the <script> body is delegated to Monogram's own JavaScript grammar.
//
// Run: node test/raw-text-case-sites.ts
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import grammar from '../html.ts';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;
const require = createRequire(import.meta.url);
await loadWASM(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));

function load(scopeName: string, files: Record<string, string>) {
  const cache: Record<string, string> = {};
  const reg = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) }),
    loadGrammar: async (sn: string) => { const p = files[sn]; if (!p) return null; const c = cache[sn] ?? (cache[sn] = readFileSync(p, 'utf8')); return parseRawGrammar(c, sn + '.json'); },
  });
  return reg.loadGrammar(scopeName);
}
const scopeName = grammar.scopeName;
if (!scopeName) throw new Error('html.ts declares no scopeName');
const tm = (await load(scopeName, { [scopeName]: 'html.tmLanguage.json' }))!;
const VSCODE_TM = '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions';
const officialPath = process.env.MONOGRAM_OFFICIAL_HTML ?? `${VSCODE_TM}/html/syntaxes/html.tmLanguage.json`;
const official = existsSync(officialPath) ? (await load('text.html.basic', { 'text.html.basic': officialPath })) : null;

interface Tok { start: number; end: number; scopes: string[] }
function tokenize(g: vsctm.IGrammar, text: string): Tok[] {
  const toks: Tok[] = []; let rs = INITIAL, off = 0;
  for (const line of text.split('\n')) { const r = g.tokenizeLine(line, rs); for (const t of r.tokens) toks.push({ start: off + t.startIndex, end: off + t.endIndex, scopes: t.scopes }); rs = r.ruleStack; off += line.length + 1; }
  return toks;
}
// the token covering `pos` (or null) — returns its WHOLE scope chain
function chainAt(toks: Tok[], pos: number): string[] {
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (toks[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans >= 0 && toks[ans].end > pos ? toks[ans].scopes : [];
}
const innermost = (chain: string[]): string => (chain.length ? chain[chain.length - 1] : '(none)').replace(/\.html$/, '');
const hasTagName = (chain: string[]): boolean => chain.some(s => /(^|\.)entity\.name\.tag(\.|$)/.test(s));

// ── case variants (derived, not hand-listed) ──
function variants(tag: string): { label: string; tag: string }[] {
  const upper = tag.toUpperCase();
  const title = tag[0].toUpperCase() + tag.slice(1);
  const alt = [...tag].map((ch, i) => (i % 2 ? ch.toUpperCase() : ch)).join('');   // aLtErNaTiNg
  const out = [{ label: 'lower', tag }, { label: 'UPPER', tag: upper }, { label: 'Title', tag: title }];
  if (alt !== title && alt !== upper && alt !== tag) out.push({ label: 'aLt', tag: alt });
  return out;
}

const m = grammar.markup!;
const O = m.tagOpen, C = m.tagClose, S = m.closeMarker ?? '/';
const rawTags = m.rawText?.tags ?? [];
const BODY = `a${O}b`;        // a raw-text body containing a would-be `<b` open tag (the invented-tag trap)
let cells = 0, wrong = 0;
const fails: string[] = [];
console.log(`raw-text tags (grammar-derived): ${rawTags.map(t => JSON.stringify(t)).join(', ')}`);
console.log(`legend: M=Monogram O=official · body \`${O}b\` must NOT be a tag · close NAME must be entity.name.tag\n`);
for (const tag of rawTags) {
  for (const v of variants(tag)) {
    const openTag = `${O}${v.tag}${C}`;
    const closeTag = `${O}${S}${v.tag}${C}`;
    const input = openTag + BODY + closeTag;
    cells++;
    const toks = tokenize(tm, input);
    // (A) body `<b` — the `<` of the would-be tag sits at openTag.length + BODY.indexOf('<')
    const ltPos = openTag.length + BODY.indexOf(O);
    const bodyLtChain = chainAt(toks, ltPos);
    const bodyNamePos = ltPos + 1;                      // the `b` right after `<`
    const bodyNameChain = chainAt(toks, bodyNamePos);
    const bodyOk = !hasTagName(bodyLtChain) && !hasTagName(bodyNameChain);
    // (B) close-tag NAME — first char of the name after `</`
    const closeNamePos = openTag.length + BODY.length + (`${O}${S}`).length;
    const closeChain = chainAt(toks, closeNamePos);
    const closeOk = hasTagName(closeChain);
    const ok = bodyOk && closeOk;
    if (!ok) { wrong++; fails.push(`${tag} × ${v.label}${!bodyOk ? ' (body painted markup)' : ''}${!closeOk ? ' (close name not tag)' : ''}`); }
    const o_ = official ? (() => { const ot = tokenize(official, input); return `body→${innermost(chainAt(ot, bodyNamePos))} close→${innermost(chainAt(ot, closeNamePos))}`; })() : null;
    console.log(`  ${ok ? '✓ ok   ' : '✗ BUG  '}[${tag.padEnd(9)} × ${v.label.padEnd(6)}] ${JSON.stringify(input).padEnd(34)} M: body→${innermost(bodyNameChain)} close→${innermost(closeChain)}${o_ === null ? '' : `  ||  O: ${o_}`}`);
  }
}
console.log(`\n  ${cells} raw-text-case cells · ${cells - wrong} ok · ${wrong} wrong${official ? '' : '  (Monogram-only — official oracle absent)'}`);

// ── the <script> body is Monogram's own JavaScript grammar (source.js) ──
// The HTML grammar loaded with Monogram's javascript.tmLanguage.json registered as `source.js` (and a
// CSS stub): the body is delegated to it, JS strings / comments inside it stay JS (no false boundary),
// and `</script>` returns to HTML. With the official VS Code HTML grammar present (readme-bench sets
// MONOGRAM_OFFICIAL_HTML) the script-region BOUNDARY is compared with it, both embedding Monogram's JS.
const cssStub = JSON.stringify({ scopeName: 'source.css', patterns: [{ match: '[^<]+', name: 'source.css' }] });
const loadEmbedding = (htmlPath: string) => new Registry({
  onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) }),
  loadGrammar: async (sn: string) => {
    if (sn === 'text.html.basic') return parseRawGrammar(readFileSync(htmlPath, 'utf8'), 'html.json');
    if (sn === 'source.js') return parseRawGrammar(readFileSync('javascript.tmLanguage.json', 'utf8'), 'js.json');
    if (sn === 'source.css') return parseRawGrammar(cssStub, 'css.json');
    return null;
  },
}).loadGrammar('text.html.basic');
const embed = (await loadEmbedding('html.tmLanguage.json'))!;
let embedChecks = 0;
const embedFails: string[] = [];
const embedCheck = (label: string, cond: boolean) => { embedChecks++; if (!cond) { embedFails.push(label); console.log(`  ✗ ${label}`); } };
// the tokens of `src` as [text, joined scopes]
const embedToks = (src: string) => { const out: { text: string; scopes: string }[] = []; for (const t of tokenize(embed, src)) { const text = src.slice(t.start, t.end); if (text) out.push({ text, scopes: t.scopes.join(' ') }); } return out; };
const findTok = (toks: { text: string; scopes: string }[], text: string, pred: (s: string) => boolean) => toks.find(t => t.text === text && pred(t.scopes));
{
  const toks = embedToks('<script>const x = 1 < 2;</script>');
  embedCheck('<script>: `const` is JS storage.type (delegated to source.js)', !!findTok(toks, 'const', s => s.includes('source.js') && s.includes('storage.type')));
  embedCheck('<script>: the `<` of `1 < 2` is a JS keyword.operator inside source.js, not an HTML tag', !!findTok(toks, '<', s => s.includes('source.js') && s.includes('keyword.operator')));
  embedCheck('<script>: a `script` tag name is HTML (entity.name.tag.html), outside source.js', !!findTok(toks, 'script', s => s.includes('entity.name.tag.html') && !s.includes('source.js')));
}
embedCheck('<script>: `//` inside a JS string is string content, not a comment or a boundary',
  !!findTok(embedToks('<script>var u = "http://example.com";</script>'), 'http://example.com', s => s.includes('source.js') && s.includes('string')));
embedCheck('<script>: `</div>` inside a JS string does not end the embed',
  embedToks('<script>let s = "</div> ok";</script>').some(t => t.text.includes('div') && t.scopes.includes('source.js') && t.scopes.includes('string')));
{
  const toks = embedToks('<script>\n// a line comment\nlet y = 3;\n</script>');
  embedCheck('<script>: a `//` line comment is a JS comment', toks.some(t => t.text.includes('line comment') && t.scopes.includes('source.js') && t.scopes.includes('comment')));
  embedCheck('<script>: JS after the comment still highlights (`let` storage.type)', !!findTok(toks, 'let', s => s.includes('source.js') && s.includes('storage.type')));
}
if (official) {
  const off = (await loadEmbedding(officialPath))!;
  // per-character mask: is this offset inside an embedded source.js region (robust to the two
  // grammars splitting tokens differently)? <script> only: both embed `source.js` there.
  const jsMask = (g: vsctm.IGrammar, src: string): boolean[] => {
    const mask: boolean[] = [];
    for (const t of tokenize(g, src)) { const e = t.scopes.some(s => s.startsWith('source.js')); for (let i = t.start; i < t.end; i++) mask[i] = e; }
    return mask;
  };
  const cases = [
    '<script>const x = 1 < 2;</script>',
    '<script>var u = "http://example.com";</script>',
    '<script>let s = "</div> ok";</script>',
    '<script type="module">import x from "y"; x < 2;</script>',
    '<script>\nfunction f(a) { return a < 10; }\n</script>',
  ];
  let agree = 0, total = 0;
  for (const src of cases) {
    const mm = jsMask(embed, src), om = jsMask(off, src);
    for (let i = 0; i < src.length; i++) { if (src[i] === '\n') continue; total++; if (!!mm[i] === !!om[i]) agree++; }
  }
  console.log(`  <script> boundary vs official (both embedding Monogram's JS): ${agree}/${total} chars delegated identically`);
  // the known divergences: 5 chars where the official grammar starts source.js right after
  // `<script ...>` while Monogram starts at the first token
  embedCheck(`official-boundary ratchet (${agree}/${total} ≥ 216/221)`, agree >= 216 && total === 221);
}
console.log(`  ${embedChecks} <script>-embed checks · ${embedChecks - embedFails.length} ok`);

if (wrong || embedFails.length) {
  if (wrong) console.error(`\n  RAW-TEXT-CASE REGRESSION — mixed-case raw-text element tokenised as markup: ${fails.join(' · ')}`);
  if (embedFails.length) console.error(`\n  <script> EMBED REGRESSION: ${embedFails.join(' · ')}`);
  process.exit(1);
}
console.log('  ✓ every raw-text element (all casings) keeps its body raw (no invented tag) and its close name a tag — matching the lexer\'s case fold; a <script> body is Monogram\'s JS.');
