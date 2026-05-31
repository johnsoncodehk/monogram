// ─────────────────────────────────────────────────────────────────────────────
//  highlight-engines.ts — run the OFFICIAL tree-sitter TypeScript highlighter
//  (and reuse the TextMate path) and reduce each to a neutral token FAMILY, so the
//  README chart can grade them against the same tsc oracle.
//
//  Each engine speaks a different vocabulary — TextMate scopes, tree-sitter
//  captures. Every map below is written from that vocabulary's STANDARD meaning
//  (frozen, auditable, identical spirit to scope-roles.ts) — never tuned to favour
//  Monogram. Family granularity is deliberately coarse (type / value / property /
//  keyword / literal / comment): it is where the meaningful errors live and it is
//  fair to each engine's native precision.
//
//  Sources (pinned, vendored):
//   • tree-sitter grammar : node_modules/@vscode/tree-sitter-wasm (recent ABI)
//   • tree-sitter query   : test/vendor/treesitter-typescript-highlights.scm
//                           (official tree-sitter-javascript ecma base + typescript additions)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import type { Family } from './scope-roles.ts';

export interface Span { start: number; end: number; family: Family }

/** family of the span covering `pos` (spans sorted by start); '' → unclassified. */
export function familyAt(spans: Span[], pos: number): Family | '' {
  let lo = 0, hi = spans.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // walk back over overlapping spans to find the innermost one covering pos
  for (let i = ans; i >= 0 && spans[i].start === spans[ans]?.start; i--) {
    if (spans[i].end > pos) return spans[i].family;
  }
  return ans >= 0 && spans[ans].end > pos ? spans[ans].family : '';
}

// ── TextMate scope → family ───────────────────────────────────────────────────
const LANG_SFX = /\.(tsx?|typescript|jsx?|javascript|js)$/;
export function scopeFamily(raw: string): Family {
  let s = raw;
  while (LANG_SFX.test(s)) s = s.replace(LANG_SFX, '');
  if (s.startsWith('comment')) return 'comment';
  if (s.startsWith('string') || s.startsWith('constant.numeric') || s.startsWith('constant.character') || s.includes('regexp')) return 'literal';
  if (s.startsWith('entity.name.type') || s.startsWith('entity.name.class') || s.startsWith('support.type') || s.startsWith('support.class') || s.includes('inherited-class')) return 'type';
  if (s.includes('.property') || s.startsWith('meta.object-literal.key') || s.startsWith('entity.name.property')) return 'property';
  if (s.startsWith('keyword') || s.startsWith('storage') || s.startsWith('constant.language') || s.startsWith('variable.language')) return 'keyword';
  if (s.startsWith('entity.name.function') || s.startsWith('variable') || s.startsWith('support.function') || s.startsWith('support.variable') || s.startsWith('entity.name') || s.startsWith('entity.other') || s.startsWith('meta.definition')) return 'value';
  return 'punct';
}

// ── tree-sitter capture → family ──────────────────────────────────────────────
const TS_FAMILY: Record<string, Family> = {
  type: 'type', 'type.builtin': 'type',
  function: 'value', 'function.method': 'value', 'function.builtin': 'value',
  variable: 'value', 'variable.parameter': 'value', 'variable.builtin': 'value',
  constructor: 'value', namespace: 'value', constant: 'value',
  property: 'property',
  keyword: 'keyword', 'constant.builtin': 'keyword', boolean: 'keyword',
  number: 'literal', string: 'literal', 'string.special': 'literal', 'string.regexp': 'literal',
  escape: 'literal', character: 'literal',
  comment: 'comment',
  operator: 'punct', punctuation: 'punct', 'punctuation.bracket': 'punct',
  'punctuation.delimiter': 'punct', 'punctuation.special': 'punct', embedded: 'punct',
};
function tsCaptureToFamily(name: string): Family | undefined {
  if (TS_FAMILY[name]) return TS_FAMILY[name];
  const head = name.split('.')[0]; // keyword.return → keyword, punctuation.x → punct
  return TS_FAMILY[head];
}

// tree-sitter needs an async one-time init (WASM runtime + grammar + query).
const TS_WASM = 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm';
const TS_QUERY = 'test/vendor/treesitter-typescript-highlights.scm';
let tsParser: any = null;
let tsQuery: any = null;

export async function loadTreeSitter(): Promise<boolean> {
  if (tsParser) return true;
  try {
    const { Parser, Language, Query } = await import('web-tree-sitter');
    await Parser.init();
    const lang = await Language.load(TS_WASM);
    tsParser = new Parser();
    tsParser.setLanguage(lang);
    tsQuery = new Query(lang, readFileSync(TS_QUERY, 'utf8'));
    return true;
  } catch (e) {
    console.error('tree-sitter init failed:', (e as Error).message);
    return false;
  }
}

// Shared capture→family reduction. Per captured node keep the family from the
// HIGHEST pattern index — tree-sitter highlighting is "last matching pattern wins"
// (e.g. the TS additions' capitalized-identifier `@type` overrides the ecma base `@variable`).
function tsFamiliesWith(parser: any, query: any, code: string): Span[] {
  const tree = parser.parse(code);
  const best = new Map<string, { start: number; end: number; family: Family; pat: number }>();
  for (const m of query.matches(tree.rootNode)) {
    const pat = m.patternIndex ?? m.pattern ?? 0;
    for (const c of m.captures) {
      const fam = tsCaptureToFamily(c.name);
      if (!fam) continue;
      const start = c.node.startIndex, end = c.node.endIndex;
      const key = start + ':' + end;
      const prev = best.get(key);
      if (!prev || pat >= prev.pat) best.set(key, { start, end, family: fam, pat });
    }
  }
  return [...best.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

export function treesitterFamilies(code: string): Span[] {
  if (!tsParser || !tsQuery) throw new Error('call loadTreeSitter() first');
  return tsFamiliesWith(tsParser, tsQuery, code);
}

// Monogram's OWN generated tree-sitter (compiled from tree-sitter, loaded
// from a prebuilt wasm). Gated behind explicit paths because building that wasm needs
// the wasi-sdk toolchain — not something CI does — so it's a local/opt-in measurement.
let mtsParser: any = null;
let mtsQuery: any = null;
export async function loadMonogramTreeSitter(wasmPath: string, queryPath: string): Promise<boolean> {
  if (mtsParser) return true;
  try {
    const { Parser, Language, Query } = await import('web-tree-sitter');
    await Parser.init();
    const lang = await Language.load(wasmPath);
    mtsParser = new Parser();
    mtsParser.setLanguage(lang);
    mtsQuery = new Query(lang, readFileSync(queryPath, 'utf8'));
    return true;
  } catch (e) {
    console.error('monogram tree-sitter init failed:', (e as Error).message);
    return false;
  }
}
export function monogramTreesitterFamilies(code: string): Span[] {
  if (!mtsParser || !mtsQuery) throw new Error('call loadMonogramTreeSitter() first');
  return tsFamiliesWith(mtsParser, mtsQuery, code);
}

// ─── self-test: dump families for a diagnostic snippet across all engines ───────
if (import.meta.url === `file://${process.argv[1]}`) {
  const code = 'const x: NS.Foo = bar(Baz); function g(p: number){ return p; } class C { m(): void {} } /* c */ const re = /ab/g;';
  const ts = await loadTreeSitter();
  const tk = ts ? treesitterFamilies(code) : [];
  console.log('token'.padEnd(12) + 'tree-sitter');
  console.log('─'.repeat(24));
  for (const m of code.matchAll(/[A-Za-z_$][\w$]*|\/ab\/g/g)) {
    const pos = m.index!;
    console.log(m[0].slice(0, 11).padEnd(12) + (ts ? (familyAt(tk, pos) || '·') : 'n/a'));
  }
}
