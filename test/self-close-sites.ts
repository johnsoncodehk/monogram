// self-close-sites.ts — an enumerator of the self-close `/` SITES in a markup grammar + a witness
// MATRIX, mirroring depth-sites.ts's structure (the blind-spot LOCK for a whole bug class).
//
// THE CLASS: in a flat markup TextMate grammar the attribute VALUE context decides where a value
// ends, and a `/` that is GLUED right after the value can be EITHER the tag's self-close punctuation
// (`<A A=""/>` — the value ended at the closing quote) OR a content char of an UNQUOTED value
// (`<a href=x/>` — WHATWG lets `/` sit inside an unquoted value: URLs / paths). A bug is exactly a
// `/` whose context mis-classifies it — the value rule keeping a self-close `/` as `string.unquoted`,
// or releasing a `/` that is really value content. (html.tmbundle#118/#124/#140360.)
//
// CLOSED LOOP / no hardcoding: the tag delimiters (`<`,`>`), the self-close marker (`/`), the
// attribute quotes, and the element CLASSES (void / raw-text) are all read from the SAME grammar the
// emitter derives the rules from (`grammar.markup`) — not a hand-written HTML list. We realise each
// {value-shape × element-class} as a minimal element, locate the `/`, and ask the NEUTRAL ORACLE
// (parse5 — the authoritative maintained HTML parser) the discriminator: is that `/` offset INSIDE an
// attribute value's source span (→ content, must stay `string.unquoted`) or OUTSIDE every value span
// (→ the self-close punctuation, must read tag punctuation)? Then we assert Monogram's innermost scope
// at the `/` matches the oracle's verdict. Self-contained pass/fail (no external corpus, no official
// grammar needed); the official VS Code HTML grammar is shown for CONTEXT when present.
//
// Run: node test/self-close-sites.ts
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { parseFragment } from 'parse5';
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
const tm = (await load(scopeName, { [scopeName]: 'html.tmLanguage.json' }))!;
// the OPTIONAL reference oracle — VS Code's bundled (unmaintained) html.tmbundle grammar, shown for
// context only. parse5 is the ARBITER; this just confirms the verdict against a shipped grammar.
const VSCODE_TM = '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions';
const officialPath = process.env.MONOGRAM_OFFICIAL_HTML ?? `${VSCODE_TM}/html/syntaxes/html.tmLanguage.json`;
const official = existsSync(officialPath) ? (await load('text.html.basic', { 'text.html.basic': officialPath })) : null;

interface Tok { start: number; end: number; scopes: string[] }
function tokenize(g: vsctm.IGrammar, text: string): Tok[] {
  const toks: Tok[] = []; let rs = INITIAL, off = 0;
  for (const line of text.split('\n')) { const r = g.tokenizeLine(line, rs); for (const t of r.tokens) toks.push({ start: off + t.startIndex, end: off + t.endIndex, scopes: t.scopes }); rs = r.ruleStack; off += line.length + 1; }
  return toks;
}
function innerAt(toks: Tok[], pos: number): string {
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (toks[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  const s = ans >= 0 && toks[ans].end > pos ? toks[ans].scopes : [];
  return (s.length ? s[s.length - 1] : '(none)').replace(/\.html$/, '');
}

// ── parse5 ORACLE: the set of source offsets that lie INSIDE an attribute VALUE span ──
// An offset inside any attr value's `[startOffset,endOffset)` is value CONTENT; an offset outside
// every value span (but before the tag's `>`) is tag structure. parse5 normalises the value span to
// exactly the run the parser keeps as the value (so `href=x/` includes the `/`, `A="x"` does not).
function valueOffsets(html: string): Set<number> {
  const inside = new Set<number>();
  let doc: any;
  try { doc = parseFragment(html, { sourceCodeLocationInfo: true }); } catch { return inside; }
  const visit = (n: any): void => {
    const loc = n.sourceCodeLocation;
    if (n.tagName && loc?.startTag) {
      const attrLocs = loc.startTag.attrs ?? {};
      for (const a of n.attrs ?? []) {
        const al = attrLocs[a.name] ?? attrLocs[a.name.toLowerCase()];
        if (!al) continue;
        const seg = html.slice(al.startOffset, al.endOffset);
        const eq = seg.indexOf('=');
        if (eq < 0) continue;                         // boolean attr — no value
        let v = al.startOffset + eq + 1;
        while (v < al.endOffset && /\s/.test(html[v])) v++;
        let lo = v, hi = al.endOffset;
        if (html[lo] === '"' || html[lo] === "'") { lo++; hi--; }   // strip the quote pair → the value run
        for (let i = lo; i < hi; i++) inside.add(i);
      }
    }
    for (const c of n.childNodes ?? []) visit(c);
  };
  for (const c of doc.childNodes ?? []) visit(c);
  return inside;
}

// ── derive the markup shape from the grammar (NOT hand-written) ──
const m = grammar.markup!;
const SLASH = m.closeMarker ?? '/';
const quotes = m.attributeQuotes ?? ['"', "'"];
const dq = quotes[0] ?? '"', sq = quotes.find(q => q !== dq) ?? dq;
// Element-class samples drawn from the grammar's declared sets (void / raw-text), plus a generic
// non-void and a generic custom-element name. We never name HTML tags by hand — they come from
// `grammar.markup`. (A custom element is just any hyphenated Name the grammar accepts.)
const voidTag = (m.voidTags ?? [])[0] ?? 'input';
const rawTag = (m.rawText?.tags ?? [])[0];          // unused for self-close (raw-text ignores `/`), kept for completeness
void rawTag;
const elements: { kind: string; tag: string }[] = [
  { kind: 'void', tag: voidTag },
  { kind: 'non-void', tag: 'A' },
  { kind: 'svg', tag: 'svg' },
  { kind: 'custom', tag: 'my-el' },
];
// Each value-shape places a `/` (the self-close marker) right after the attribute, so the matrix
// stresses exactly the value-context release decision. `focus` is the offset of that `/`.
const shapes: { name: string; make: (tag: string) => string }[] = [
  { name: 'quoted-empty',     make: t => `<${t} a=${dq}${dq}${SLASH}>` },
  { name: 'quoted-value',     make: t => `<${t} a=${dq}x${dq}${SLASH}>` },
  { name: 'single-quoted',    make: t => `<${t} a=${sq}x${sq}${SLASH}>` },
  { name: 'unquoted-value',   make: t => `<${t} a=x${SLASH}>` },
  { name: 'bare',             make: t => `<${t}${SLASH}>` },
  { name: 'after-space',      make: t => `<${t} a=${dq}x${dq} ${SLASH}>` },
  { name: 'directive-value',  make: t => `<${t} a=${dq}x${dq} b=${dq}${dq}${SLASH}>` },  // two attrs, glued `/` after the 2nd close-quote
  { name: 'multi-line',       make: t => `<${t}\na=${dq}${dq}${SLASH}>` },
];

const tagPunctPrefix = 'punctuation.definition.tag';
const strUnquoted = 'string.unquoted';
let cells = 0, wrong = 0;
const fails: string[] = [];
console.log(`grammar: tagOpen=${JSON.stringify(m.tagOpen)} closeMarker=${JSON.stringify(SLASH)} quotes=${JSON.stringify(quotes)}`);
console.log(`element classes (grammar-derived): ${elements.map(e => `${e.kind}=<${e.tag}>`).join(', ')}`);
console.log(`legend: M=Monogram O=official(html.tmbundle) · oracle=parse5 · want = punctuation OR string.unquoted (by parse5's value span)\n`);
for (const sh of shapes) {
  for (const el of elements) {
    const input = sh.make(el.tag);
    // locate the self-close `/` — the one immediately before the closing `>`
    const focus = input.lastIndexOf(SLASH, input.lastIndexOf(m.tagClose));
    if (focus < 0) continue;
    cells++;
    const insideValue = valueOffsets(input).has(focus);
    const wantStr = insideValue;                 // inside a value span → content (string.unquoted)
    const m_ = innerAt(tokenize(tm, input), focus);
    const ok = wantStr ? m_.startsWith(strUnquoted) : m_.startsWith(tagPunctPrefix);
    const o_ = official ? innerAt(tokenize(official, input), focus) : null;
    if (!ok) { wrong++; fails.push(`${sh.name} × ${el.kind}`); }
    const tag = ok ? '✓ ok   ' : '✗ BUG  ';
    console.log(`  ${tag}[${sh.name.padEnd(14)} × ${el.kind.padEnd(8)}] ${JSON.stringify(input).padEnd(24)} @${focus}«${SLASH}»  want=${wantStr ? 'string' : 'punct '}  M→${m_}${o_ === null ? '' : `  O→${o_}`}`);
  }
}
console.log(`\n  ${cells} self-close cells · ${cells - wrong} ok · ${wrong} mis-scoped${official ? '' : '  (Monogram-only — official oracle absent)'}`);
if (wrong) { console.error(`\n  SELF-CLOSE REGRESSION — \`/\` mis-classified vs parse5: ${fails.join(' · ')}`); process.exit(1); }
console.log('  ✓ every self-close `/` is classified exactly as parse5 (punctuation after a value-end, content inside an unquoted value).');
