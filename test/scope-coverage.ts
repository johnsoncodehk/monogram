// ─────────────────────────────────────────────────────────────────────────────
//  scope-coverage.ts — what Monogram is MISSING to be a drop-in REPLACEMENT for the
//  official grammar. This is NOT correctness (highlight-bench.ts already grades that
//  against a neutral tsc oracle); it is drop-in COMPATIBILITY against the official
//  scope vocabulary — the coverage + fidelity that "more correct on the bug ledger"
//  does not capture. Three views, each a quantified, repeatable gap:
//
//    1. VOCABULARY    — scopes the official grammar emits that Monogram NEVER does,
//                       grouped by category (the missing sub-grammars: regex
//                       internals, JSDoc body, …).
//    2. FIDELITY      — per meaningful token (oracle positions) on a corpus:
//                       exact / family-only / missing / divergent vs official.
//                       `missing` = we emit no scope where official colors (a pure
//                       coverage gap); `family-only` = right family, different scope
//                       (a theme MAY still recolor); `divergent` includes our
//                       deliberate bug-fixes, so it is not all deficiency.
//    3. SUB-GRAMMAR   — inside a regex / JSDoc comment / tagged template, how many
//                       distinct scopes each grammar emits (the 1-vs-N internal gap).
//
//  Run: MONOGRAM_OFFICIAL_TM=/path/to/TypeScript.tmLanguage.json node test/scope-coverage.ts
// ─────────────────────────────────────────────────────────────────────────────
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { oracle } from './oracle.ts';
import { scopeFamily } from './highlight-engines.ts';
import { ROLE_SPEC, roleFamily, normScope } from './scope-roles.ts';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

const MONO_PATH = 'typescript.tmLanguage.json';
const OFFICIAL_PATH = process.env.MONOGRAM_OFFICIAL_TM
  ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json';
if (!existsSync(OFFICIAL_PATH)) {
  console.error(`Official grammar not found. Set MONOGRAM_OFFICIAL_TM=/path/to/TypeScript.tmLanguage.json`);
  process.exit(1);
}

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
const mono = (await load('source.ts', MONO_PATH))!;
const official = (await load('source.ts', OFFICIAL_PATH))!;
const ROOT_MONO = 'source.ts', ROOT_OFF = 'source.ts';

interface Tok { start: number; end: number; scope: string }
function tokenize(g: vsctm.IGrammar, text: string): Tok[] {
  const out: Tok[] = [];
  let rs = INITIAL, off = 0;
  for (const line of text.split('\n')) {
    const r = g.tokenizeLine(line, rs);
    for (const t of r.tokens) out.push({ start: off + t.startIndex, end: off + t.endIndex, scope: t.scopes[t.scopes.length - 1] });
    rs = r.ruleStack; off += line.length + 1;
  }
  return out;
}
const scopeAt = (toks: Tok[], pos: number): string => {
  for (const t of toks) if (t.start <= pos && pos < t.end) return t.scope;
  return '';
};

// ── 1. VOCABULARY — official scopes Monogram never emits ──
function vocab(g: any): Set<string> {
  const s = new Set<string>();
  const walk = (o: any): void => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.name === 'string') o.name.split(/\s+/).forEach((x: string) => s.add(x));
    if (typeof o.contentName === 'string') s.add(o.contentName);
    for (const k in o) walk(o[k]);
  };
  walk(JSON.parse(readFileSync(g, 'utf-8')));
  return s;
}
function category(scope: string): string {
  if (scope.includes('.regexp')) return 'regexp     (regex internals)';
  if (scope.includes('.jsdoc')) return 'jsdoc      (doc-comment body)';
  if (/\bjsx\b|\.tsx\b/.test(scope)) return 'jsx/tsx    (React dialect)';
  if (scope.includes('.template') || scope.includes('embedded')) return 'embedded   (template-literal langs)';
  const head = scope.split('.')[0];
  return `${head.padEnd(11)}(finer ${head})`;
}
const monoVocab = vocab(MONO_PATH), offVocab = vocab(OFFICIAL_PATH);
const officialOnly = [...offVocab].filter((x) => !monoVocab.has(x) && x.includes('.') && !/^source\.|\.tsx?$/.test(x));
const byCat = new Map<string, string[]>();
for (const s of officialOnly) { const c = category(s); (byCat.get(c) ?? byCat.set(c, []).get(c)!).push(s); }

console.log('═══ DROP-IN COMPATIBILITY vs official (coverage + fidelity, NOT correctness) ═══\n');
const monoSN = JSON.parse(readFileSync(MONO_PATH, 'utf-8')).scopeName;
const offSN = JSON.parse(readFileSync(OFFICIAL_PATH, 'utf-8')).scopeName;
console.log(`scopeName        Monogram=${monoSN}   official=${offSN}   ${monoSN === offSN ? '(match → drop-in scopeName ✓)' : '(mismatch → not a drop-in)'}`);
console.log(`scope vocabulary Monogram=${monoVocab.size}   official=${offVocab.size}\n`);
console.log(`── 1. VOCABULARY: ${officialOnly.length} official scopes Monogram never emits (pure coverage gaps) ──`);
for (const [cat, list] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(list.length).padStart(3)}  ${cat}`);
}

// ── 2. FIDELITY — per oracle-token scope relationship vs official, on a corpus ──
const CORPUS: string[] = [
  `import { readFile } from 'fs'; export const x: number = 1;`,
  `function greet<T extends string>(name: T, opts?: { loud: boolean }): string { return name; }`,
  `class Animal { #legs = 4; static kingdom = 'A'; get legs() { return this.#legs; } move(d: number): void {} }`,
  `interface Shape { area(): number; readonly name: string; }`,
  `type Result<T> = { ok: true; value: T } | { ok: false; error: Error };`,
  `const arr = [1, 2, 3].map((n) => n * 2).filter((n) => n > 2);`,
  `const { a, b: renamed, ...rest } = config; const [first, ...more] = list;`,
  `let { p, q: aliased } = opts; var [head, ...tail] = items;`,
  `const re = /^\\d{3}-(\\w+)$/gi; const ok = re.test(input);`,
  `const t = \`Hello \${user.name}, you have \${count} messages\`;`,
  `enum Color { Red, Green = 2, Blue } namespace NS { export const v = 1; }`,
  `async function load(url: string) { const r = await fetch(url); return r.json() as Promise<Data>; }`,
  `/** @param {string} name the user @returns {void} */\nfunction doc(name) {}`,
  `@Component({ selector: 'app' }) class C { @Input() value = 0; }`,
  `export default function App() { return null; } export * from './mod';`,
];
type Rel = 'exact' | 'family' | 'missing' | 'divergent';
const tally: Record<Rel, number> = { exact: 0, family: 0, missing: 0, divergent: 0 };
const missingEx = new Map<string, { n: number; ex: string }>();
// family-only + divergent detail, keyed by the (mono→official) scope SHAPE so the
// fix target is unambiguous: which Monogram scope to rewrite to which official path.
const diffEx = new Map<string, { n: number; ex: string; rel: 'family' | 'divergent' }>();
let graded = 0;
for (const text of CORPUS) {
  const mt = tokenize(mono, text), ot = tokenize(official, text);
  for (const g of oracle(text)) {
    if (ROLE_SPEC[g.role].tier === 'lexical' || roleFamily(g.role) === 'punct') continue;
    const off = scopeAt(ot, g.start), mn = scopeAt(mt, g.start);
    if (!off || off === ROOT_OFF) continue; // official emits nothing → no compat signal
    graded++;
    // normalise the language suffix (.ts / .typescript / .tsx) so we measure the
    // STRUCTURAL scope path, not the systematic source.ts-vs-source.typescript skew.
    const rec = (rel: 'family' | 'divergent') => {
      const k = `${normScope(mn)}  →  ${normScope(off)}`;
      const e = diffEx.get(k) ?? { n: 0, ex: g.text, rel }; e.n++; diffEx.set(k, e);
    };
    if (normScope(mn) === normScope(off)) tally.exact++;
    else if (!mn || mn === ROOT_MONO) {
      tally.missing++;
      const k = `${g.role} (official: ${normScope(off)})`;
      const e = missingEx.get(k) ?? { n: 0, ex: g.text }; e.n++; missingEx.set(k, e);
    } else if (scopeFamily(mn) === scopeFamily(off)) { tally.family++; rec('family'); }
    else { tally.divergent++; rec('divergent'); }
  }
}
const pct = (n: number) => ((n / graded) * 100).toFixed(1);
console.log(`\n── 2. FIDELITY: ${graded} meaningful tokens (where official emits a scope; scope`);
console.log(`        paths compared MODULO the .ts/.typescript language suffix) ──`);
console.log(`  exact        ${pct(tally.exact)}%  same scope PATH → theme colors match (once suffix aligned)`);
console.log(`  family-only  ${pct(tally.family)}%  right family, different/coarser path → theme MAY recolor`);
console.log(`  missing      ${pct(tally.missing)}%  we emit NO scope where official colors → coverage gap`);
console.log(`  divergent    ${pct(tally.divergent)}%  different family (includes our deliberate bug-fixes)`);
if (missingEx.size) {
  console.log(`  top "missing" (we color nothing where official does):`);
  for (const [k, v] of [...missingEx.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6))
    console.log(`    ${String(v.n).padStart(2)}× ${k}  e.g. «${v.ex}»`);
}
// family-only + divergent breakdown — the exact fix targets (Monogram path → official path)
const fam = [...diffEx.entries()].filter(([, v]) => v.rel === 'family').sort((a, b) => b[1].n - a[1].n);
const div = [...diffEx.entries()].filter(([, v]) => v.rel === 'divergent').sort((a, b) => b[1].n - a[1].n);
if (fam.length) {
  console.log(`\n  family-only fix targets (Monogram → official, ${fam.length} distinct):`);
  for (const [k, v] of fam) console.log(`    ${String(v.n).padStart(2)}×  ${k}   e.g. «${v.ex}»`);
}
if (div.length) {
  console.log(`\n  divergent (different family — may be a deliberate bug-fix; ${div.length} distinct):`);
  for (const [k, v] of div) console.log(`    ${String(v.n).padStart(2)}×  ${k}   e.g. «${v.ex}»`);
}

// ── 3. SUB-GRAMMAR DENSITY — distinct scopes INSIDE the construct, measured over the
//      exact char range where the OFFICIAL grammar emits the category's scopes ──
console.log(`\n── 3. SUB-GRAMMAR density (distinct scopes in the region official sub-highlights) ──`);
const probes: { label: string; text: string; cat: RegExp }[] = [
  { label: 'regex internals', text: `const re = /^\\d{3}-(\\w+)$/gi;`, cat: /\.regexp/ },
  { label: 'JSDoc body', text: `/** @param {string} n @returns {void} */\nlet x = 1;`, cat: /\.jsdoc/ },
  { label: 'tagged template (css`…`)', text: 'const s = css`.a { color: red }`;', cat: /\.css|source\.css|meta\.embedded/ },
];
for (const p of probes) {
  const ot = tokenize(official, p.text), mt = tokenize(mono, p.text);
  const offIn = ot.filter((t) => p.cat.test(t.scope));
  if (!offIn.length) { console.log(`  ${p.label.padEnd(26)} official emits no such sub-scopes here (skip)`); continue; }
  const lo = Math.min(...offIn.map((t) => t.start)), hi = Math.max(...offIn.map((t) => t.end));
  const offN = new Set(offIn.map((t) => t.scope)).size;
  const monoN = new Set(mt.filter((t) => t.start >= lo && t.start < hi).map((t) => t.scope)).size;
  const flag = monoN <= 1 ? '  ← MISSING sub-grammar (we emit one flat token)' : '';
  console.log(`  ${p.label.padEnd(26)} official=${offN} scopes  Monogram=${monoN}${flag}`);
}

// ── 4. DIALECT — does Monogram even tokenize TSX/JSX? ──
console.log(`\n── 4. DIALECT: TSX/JSX ──`);
const jsx = `const el = <div className="x">{items.map(i => <Item key={i} />)}</div>;`;
const mScopes = new Set(tokenize(mono, jsx).map((t) => t.scope).filter((s) => s !== ROOT_MONO));
console.log(`  <div>…</div> JSX → Monogram emits ${mScopes.size} non-root scopes (TS grammar has no JSX productions;`);
console.log(`  the official ships a SEPARATE TypeScriptReact grammar — a whole dialect Monogram lacks).`);

console.log(`\n═══ These are the gaps to close for a drop-in replacement; none are measured by the correctness bench. ═══`);
