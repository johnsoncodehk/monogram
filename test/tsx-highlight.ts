// ─────────────────────────────────────────────────────────────────────────────
//  tsx-highlight.ts — the JSX *highlighter* gate (tsx-conformance.ts is the JSX
//  *parser* gate). It checks the scopes Monogram's GENERATED tsx.tmLanguage.json
//  emits for the JSX-dialect constructs the TS/JS benches can't reach: element &
//  fragment tags, attributes, expression containers, raw text children, and HTML
//  character entities.
//
//  Two views:
//    1. CURATED checks — a hard gate: specific JSX tokens must carry specific
//       scopes (the same style as test/issue-cases.ts). These encode the JSX
//       contract and catch regressions in the dialect patterns.
//    2. DROP-IN agreement (opt-in: set MONOGRAM_OFFICIAL_TSX) — over a JSX corpus,
//       the share of official-emitted scopes Monogram matches at family / exact
//       granularity. For the JSX dialect the official TypeScriptReact grammar is
//       the de-facto reference (tsc exposes no neutral per-token JSX scope roles
//       the way scope-roles.ts does for TS), so this is an agreement measure, not
//       an absolute-accuracy one — hence opt-in and not the hard gate.
//
//  Run: `node test/tsx-highlight.ts`  (set MONOGRAM_OFFICIAL_TSX for the drop-in view)
// ─────────────────────────────────────────────────────────────────────────────
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { scopeFamily } from './highlight-engines.ts';
import { JSX_CORPUS } from './tsx-corpus.ts';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

function load(scopeName: string, path: string): Promise<vsctm.IGrammar | null> {
  const content = readFileSync(path, 'utf-8');
  return new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (p: string[]) => new onig.OnigScanner(p),
      createOnigString: (s: string) => new onig.OnigString(s),
    }),
    loadGrammar: async (sn: string) => (sn === scopeName ? parseRawGrammar(content, 'g.json') : null),
  }).loadGrammar(scopeName);
}

interface Tok { start: number; end: number; text: string; scope: string }
function tokenize(g: vsctm.IGrammar, text: string): Tok[] {
  const out: Tok[] = [];
  let rs = INITIAL, off = 0;
  for (const line of text.split('\n')) {
    const r = g.tokenizeLine(line, rs);
    for (const t of r.tokens) out.push({ start: off + t.startIndex, end: off + t.endIndex, text: line.slice(t.startIndex, t.endIndex), scope: t.scopes[t.scopes.length - 1] });
    rs = r.ruleStack; off += line.length + 1;
  }
  return out;
}
// Strip only a TRAILING language suffix (`…​.tsx`/`.ts`/`.js`); never a mid-path
// `.jsx` (it is structural, e.g. `meta.jsx.children`).
const norm = (s: string) => s.replace(/\.(tsx|ts|js)$/, '');

const MONO_PATH = 'typescriptreact.tmLanguage.json';
if (!existsSync(MONO_PATH)) {
  console.error(`Monogram TSX grammar not found at ${MONO_PATH}. Run: node src/cli.ts typescriptreact.ts`);
  process.exit(1);
}
const mono = (await load('source.tsx', MONO_PATH))!;

// ── 1. Curated checks: (snippet, substring, expected-scope-substring) ──
// The expected scope is matched modulo the language suffix and as a path prefix,
// so `entity.name.tag` accepts `entity.name.tag.tsx`.
const checks: { label: string; code: string; want: { text: string; scope: string }[] }[] = [
  {
    label: 'element tag + close',
    code: `const a = <div></div>;`,
    want: [
      { text: 'div', scope: 'entity.name.tag' },
      { text: '<', scope: 'punctuation.definition.tag.begin' },
    ],
  },
  {
    label: 'attributes: name, =, string, expression container',
    code: `const b = <input type="text" value={v} />;`,
    want: [
      { text: 'type', scope: 'entity.other.attribute-name' },
      { text: 'text', scope: 'string.quoted.double' },
      { text: 'value', scope: 'entity.other.attribute-name' },
      { text: 'v', scope: 'variable.other' },
    ],
  },
  {
    label: 'raw text with arbitrary punctuation → meta.jsx.children',
    code: `const c = <p>It's 100% & more (really)!</p>;`,
    want: [
      { text: `It's 100% & more (really)!`, scope: 'meta.jsx.children' },
    ],
  },
  {
    label: 'HTML named entity',
    code: `const d = <span>&nbsp;</span>;`,
    want: [
      { text: '&', scope: 'punctuation.definition.entity' },
      { text: 'nbsp', scope: 'constant.character.entity' },
      { text: ';', scope: 'punctuation.definition.entity' },
    ],
  },
  {
    label: 'HTML numeric + hex entity',
    code: `const e = <span>&#123;&#x1F600;</span>;`,
    want: [
      { text: '#123', scope: 'constant.character.entity' },
      { text: '#x1F600', scope: 'constant.character.entity' },
    ],
  },
  {
    label: 'lone & in text stays plain children (no false entity)',
    code: `const f = <p>Tom & Jerry</p>;`,
    want: [
      { text: 'Tom & Jerry', scope: 'meta.jsx.children' },
    ],
  },
  {
    label: 'text interleaved with expression container',
    code: `const g = <p>Hello {name}, welcome</p>;`,
    want: [
      { text: 'Hello ', scope: 'meta.jsx.children' },
      { text: 'name', scope: 'variable.other' },
      { text: ', welcome', scope: 'meta.jsx.children' },
    ],
  },
  {
    label: 'fragment children',
    code: `const h = <><span>1</span></>;`,
    want: [
      { text: 'span', scope: 'entity.name.tag' },
    ],
  },
  // ── Generic-arrow type params after `=` (NOT JSX) ──
  // Reported microsoft/TypeScript-TmLanguage bugs the official .tsx grammar
  // breaks (it emits `meta.tag` / `invalid.illegal.attribute`). A type-param
  // list with a `=` default or `const` modifier carries a trailing comma
  // (`<T = X,>`, `<const T,>`) so it parses as an arrow, not a tag. The `<`/`>`
  // must be type-parameter punctuation and `=>` the arrow operator — even after
  // `=`, which is where the disambiguation is hardest (the JSX expression-start
  // trigger also fires there). See gen-tm's #arrow-type-parameters carve-out.
  {
    label: '#967: <T = void,> generic arrow after `=` (default) is type-params not JSX',
    code: `const f = <T = void,>(): G<T> => true;`,
    want: [
      { text: '<', scope: 'punctuation.definition.typeparameters.begin' },
      { text: '=>', scope: 'storage.type.function.arrow' },
    ],
  },
  {
    label: '#979: <const T,> generic arrow after `=` (const modifier) is type-params not JSX',
    code: `export const always = <const T,>(v: T) => v;`,
    want: [
      { text: '<', scope: 'punctuation.definition.typeparameters.begin' },
      { text: '=>', scope: 'storage.type.function.arrow' },
    ],
  },
  {
    label: '#1042/#990: <T = string,> generic arrow after `=` (default) is type-params not JSX',
    code: `const f = <T = string,>(x: T) => x;`,
    want: [
      { text: '<', scope: 'punctuation.definition.typeparameters.begin' },
      { text: '=>', scope: 'storage.type.function.arrow' },
    ],
  },
  {
    label: '<T = unknown,> generic arrow after `=` (default) is type-params not JSX',
    code: `const x = <T = unknown,>(p: T) => p;`,
    want: [
      { text: '<', scope: 'punctuation.definition.typeparameters.begin' },
      { text: '=>', scope: 'storage.type.function.arrow' },
    ],
  },
];

const scopeAt = (toks: Tok[], text: string): string | null => {
  const t = toks.find((x) => x.text === text);
  return t ? norm(t.scope) : null;
};
let pass = 0, total = 0;
const fails: string[] = [];
for (const { label, code, want } of checks) {
  const toks = tokenize(mono, code);
  for (const w of want) {
    total++;
    const got = scopeAt(toks, w.text);
    // prefix match (modulo suffix): want `entity.name.tag` accepts `entity.name.tag.begin`? no —
    // we want the LEAF to START WITH the expected path, so `entity.name.tag` ⊆ `entity.name.tag`.
    if (got && (got === w.want || got.startsWith(w.scope))) pass++;
    else fails.push(`  [${label}] «${w.text}» want ⊇ ${w.scope}  got ${got ?? '(none)'}`);
  }
}
console.log('── JSX highlighter — curated scope checks ──');
console.log(`  ${pass}/${total} checks pass`);
if (fails.length) { console.log('  FAILURES:'); for (const f of fails) console.log(f); }

// ── 2. Drop-in agreement vs the official TypeScriptReact grammar (opt-in) ──
const OFF = process.env.MONOGRAM_OFFICIAL_TSX
  ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/typescript-basics/syntaxes/TypeScriptReact.tmLanguage.json';
const CORPUS = JSX_CORPUS;
if (existsSync(OFF)) {
  const off = (await load('source.tsx', OFF))!;
  let exact = 0, fam = 0, graded = 0;
  for (const code of CORPUS) {
    const mt = tokenize(mono, code), ot = tokenize(off, code);
    for (const o of ot) {
      if (!o.text.trim() || o.scope === 'source.tsx') continue; // only where official colors
      // only JSX-dialect tokens (skip the shared TS surface already graded elsewhere)
      if (!/\b(tag|jsx|attribute-name|character\.entity|definition\.entity|section\.embedded)\b/.test(o.scope)) continue;
      graded++;
      const m = mt.find((x) => x.start <= o.start && o.start < x.end);
      if (!m) continue;
      if (norm(m.scope) === norm(o.scope)) { exact++; fam++; }
      else if (scopeFamily(m.scope) === scopeFamily(o.scope)) fam++;
    }
  }
  console.log('\n── JSX dialect drop-in vs official TypeScriptReact (agreement, opt-in) ──');
  console.log(`  graded ${graded} JSX tokens · exact ${(exact / graded * 100).toFixed(1)}%  family ${(fam / graded * 100).toFixed(1)}%`);
} else {
  console.log('\n  (set MONOGRAM_OFFICIAL_TSX to also measure JSX drop-in agreement vs official)');
}

const FLOOR = checks.reduce((n, c) => n + c.want.length, 0);
if (pass < FLOOR) { console.log(`\n✗ JSX highlighter curated checks ${pass}/${FLOOR}`); process.exit(1); }
console.log(`\n✓ JSX highlighter: ${pass}/${total} curated scope checks pass`);
