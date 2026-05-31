// ─────────────────────────────────────────────────────────────────────────────
//  js-highlight-bench.ts — JavaScript highlighter accuracy vs a NEUTRAL tsc-JS
//  oracle. The JS counterpart of highlight-bench.ts (TypeScript): it grades
//  Monogram's GENERATED javascript.tmLanguage.json against tsc's own
//  JS-mode parse tree (oracle.ts with ScriptKind.JS), at the token-FAMILY
//  granularity (scope-roles.ts) — the SAME absolute, theme-independent metric the
//  TS bench uses.
//
//  This is the absolute-correctness gate the old test/js-coverage.ts deferred
//  ("once the bench gains a JS oracle"): js-coverage measured agreement with the
//  incumbent official grammar (relative); this measures correctness against tsc.
//
//  Self-contained — no external corpus. Run: `node test/js-highlight-bench.ts`.
//  Set MONOGRAM_OFFICIAL_JS_TM to also grade VS Code's official JS grammar.
// ─────────────────────────────────────────────────────────────────────────────
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { oracle } from './oracle.ts';
import { ROLE_SPEC, roleFamily, acceptableFamilies } from './scope-roles.ts';
import { scopeFamily, familyAt } from './highlight-engines.ts';
import type { Family } from './scope-roles.ts';
import type { Span } from './highlight-engines.ts';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

function loadGrammar(scopeName: string, path: string): Promise<vsctm.IGrammar | null> {
  const content = readFileSync(path, 'utf-8');
  return new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (p: string[]) => new onig.OnigScanner(p),
      createOnigString: (s: string) => new onig.OnigString(s),
    }),
    loadGrammar: async (sn: string) => (sn === scopeName ? parseRawGrammar(content, 'g.json') : null),
  }).loadGrammar(scopeName);
}

// tokenize → per-token FAMILY span (mirrors highlight-bench's tmSpans + scopeFamily)
function tmFamilies(grammar: vsctm.IGrammar, text: string): Span[] {
  const spans: Span[] = [];
  let ruleStack = INITIAL, offset = 0;
  for (const line of text.split('\n')) {
    const r = grammar.tokenizeLine(line, ruleStack);
    for (const t of r.tokens) {
      const scope = t.scopes[t.scopes.length - 1];
      spans.push({ start: offset + t.startIndex, end: offset + t.endIndex, family: scopeFamily(scope) });
    }
    ruleStack = r.ruleStack;
    offset += line.length + 1;
  }
  return spans;
}

// ── Corpus: representative valid JavaScript across the highlight families ──
// Shared with test/highlight-bench.ts (the README table) so the 92.6% has one source.
import { JS_CORPUS as CORPUS } from './js-corpus.ts';

interface Score { name: string; correct: number; total: number; }
const fams: Family[] = ['type', 'value', 'property', 'keyword', 'literal', 'comment'];

function grade(name: string, grammar: vsctm.IGrammar): { score: Score; byFamily: Map<Family, { c: number; t: number }> } {
  const acc = { correct: 0, total: 0 };
  const byFamily = new Map<Family, { c: number; t: number }>(fams.map((f) => [f, { c: 0, t: 0 }]));
  for (const text of CORPUS) {
    const sf = ts.createSourceFile('c.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (((sf as any).parseDiagnostics?.length ?? 0) > 0) continue; // grade only clean parses
    const spans = tmFamilies(grammar, text);
    for (const g of oracle(text, ts.ScriptKind.JS)) {
      if (ROLE_SPEC[g.role].tier === 'lexical' || roleFamily(g.role) === 'punct') continue;
      const ok = acceptableFamilies(g.role);
      const fam = familyAt(spans, g.start);
      acc.total++;
      const bf = byFamily.get(roleFamily(g.role))!;
      bf.t++;
      if (fam && ok.has(fam)) { acc.correct++; bf.c++; }
    }
  }
  return { score: { name, correct: acc.correct, total: acc.total }, byFamily };
}

const MONO_PATH = 'javascript.tmLanguage.json';
if (!existsSync(MONO_PATH)) {
  console.error(`Monogram JS grammar not found at ${MONO_PATH}. Run: node src/cli.ts javascript.ts`);
  process.exit(1);
}
const mono = await loadGrammar('source.js', MONO_PATH);
if (!mono) throw new Error('failed to load Monogram JS grammar');

const results = [grade('Monogram (JS TextMate, derived)', mono)];

const OFFICIAL_JS = process.env.MONOGRAM_OFFICIAL_JS_TM
  ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/javascript/syntaxes/JavaScript.tmLanguage.json';
if (existsSync(OFFICIAL_JS)) {
  const off = await loadGrammar('source.js', OFFICIAL_JS);
  if (off) results.push(grade('official JavaScript TextMate', off));
}

console.log('\n── JavaScript token-family accuracy vs a neutral tsc-JS oracle ──');
console.log(`   (${CORPUS.length} snippets · the SAME absolute metric as the TS bench)\n`);
for (const { score: s } of results.sort((a, b) => b.score.correct / b.score.total - a.score.correct / a.score.total)) {
  console.log(`  ${s.name.padEnd(34)} ${((s.correct / s.total) * 100).toFixed(1)}%  (${s.correct}/${s.total})`);
}
console.log('\n  Monogram per-family:');
for (const [f, v] of results[0].byFamily) {
  if (v.t === 0) continue;
  console.log(`    ${f.padEnd(9)} ${((v.c / v.t) * 100).toFixed(0)}%  (${v.c}/${v.t})`);
}

// Gate: fail if Monogram's JS highlighter regresses below a conservative floor.
const FLOOR = 80;
const monoPct = (results[0].score.correct / results[0].score.total) * 100;
if (monoPct < FLOOR) {
  console.error(`\n✗ JS highlighter accuracy ${monoPct.toFixed(1)}% below floor ${FLOOR}%`);
  process.exit(1);
}
console.log(`\n✓ JS highlighter accuracy ${monoPct.toFixed(1)}% (floor ${FLOOR}%)`);
