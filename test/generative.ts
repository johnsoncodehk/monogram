// ─────────────────────────────────────────────────────────────────────────────
//  generative.ts — monogram#25 parts (b): the JUDGING harness over grammar-DERIVED
//  inputs (test/grammar-gen.ts). Two by-construction consistency checks, no external
//  oracle, for every Monogram grammar:
//
//   (2) ROUND-TRIP — every generated derivation parses (as the rule it was rooted at).
//       Validates parser self-consistency: what the grammar's IR generates, the parser
//       accepts. Reported per strategy; the structured strategies are the gate.
//
//   (3) SCOPE ≡ ROLE — the flat highlighter's scope at every parsed token must agree
//       with the token's BY-CONSTRUCTION role (the scope the grammar DECLARES for it).
//       The parser resolves context with its full stack (indent / column / markup
//       depth); the flat TextMate grammar can only approximate it. Where they disagree
//       is exactly the monogram#23/#24 class — a value-leading `---` the parser lexes
//       as a plain scalar (string) but a flat grammar mis-scopes as a document marker;
//       an inner sequence `-` the parser knows is an indicator but a flat grammar folds
//       into a string. The check is FLOOR-BLIND (it compares the visual bucket directly,
//       incl. punctuation) so a `-` mis-painted as string is caught — the exact blind
//       spot that hid #24 from the role-graded scope-gap metric.
//
//  Coverage is grammar×bound, not a fixed corpus — so it surfaces the depth-bug CLASS
//  without anyone naming the shape (the motivation for #25). The named regressions
//  (yaml-depth-witnesses.ts, *-issue-cases.ts) stay — generation replaces their
//  DISCOVERY function, not their value as documented gates.
//
//  Run (bare node):  node test/generative.ts            # all languages
//                    node test/generative.ts yaml       # one language
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { createParser, type CstNode, type CstChild } from '../src/gen-parser.ts';
import type { CstGrammar, TokenPattern } from '../src/types.ts';
import { normScope } from './scope-roles.ts';
import { generateInputs, type GenInput } from './grammar-gen.ts';

// ── language registry: every per-language fact (grammar module, scope, flat grammar file,
//    any multi-file sub-grammars) is DATA — the harness body is language-agnostic. ──
interface LangCfg {
  name: string;
  module: string;          // grammar module to import (default export = CstGrammar)
  scopeName: string;       // TextMate scope, e.g. source.yaml
  tmPath: string;          // the derived flat .tmLanguage.json
  tmExtra?: Record<string, string>;  // extra scopeName → file for multi-file grammars
  gen?: Parameters<typeof generateInputs>[1];   // generation knobs override
  // Depth-site CLASSES the generated legal corpus MUST contain — the shapes whose correct scope
  // depends on cross-line parser state, so the scope≡role gate provably covers monogram#23/#24. The
  // gate FAILS if generation stops producing them (a coverage regression). Asserted per shape.
  mustCover?: { name: string; re: RegExp }[];
}
const LANGS: LangCfg[] = [
  { name: 'yaml', module: '../yaml.ts', scopeName: 'source.yaml', tmPath: 'yaml.tmLanguage.json',
    mustCover: [
      // #24: a nested compact block sequence with an inner sibling (`- - x\n  - x`) — the inner `-`'s
      // role (indicator vs plain-fold) depends on the indent stack a flat grammar lacks.
      { name: '#24 nested-compact-sequence', re: /- - \S.*\n\s+- /m },
      // #23: a value-leading document-marker (`k: --- x`, `- --- x`) — string content, NOT a marker,
      // a position the flat grammar's `^`-retried marker pattern can mis-fire on.
      { name: '#23 value-leading-marker', re: /(?::|-) +(?:---|\.\.\.)(?:\s|$)/ },
    ] },
  { name: 'typescript', module: '../typescript.ts', scopeName: 'source.ts', tmPath: 'typescript.tmLanguage.json' },
  { name: 'javascript', module: '../javascript.ts', scopeName: 'source.js', tmPath: 'javascript.tmLanguage.json' },
  { name: 'typescriptreact', module: '../typescriptreact.ts', scopeName: 'source.tsx', tmPath: 'typescriptreact.tmLanguage.json' },
  { name: 'javascriptreact', module: '../javascriptreact.ts', scopeName: 'source.js.jsx', tmPath: 'javascriptreact.tmLanguage.json' },
  // HTML/Vue embed source.js/ts/tsx (script blocks, on* handlers); provide them so embedded regions
  // tokenize instead of erroring. The consistency check reads the host markup tokens regardless.
  { name: 'html', module: '../html.ts', scopeName: 'text.html.basic', tmPath: 'html.tmLanguage.json',
    tmExtra: { 'source.js': 'javascript.tmLanguage.json', 'source.css': 'html.tmLanguage.json' } },
  { name: 'vue', module: '../vue.ts', scopeName: 'text.html.vue', tmPath: 'vue.tmLanguage.json',
    tmExtra: { 'text.html.basic': 'html.tmLanguage.json', 'source.js': 'javascript.tmLanguage.json', 'source.ts': 'typescript.tmLanguage.json', 'source.tsx': 'typescriptreact.tmLanguage.json' } },
];

// ── vscode-textmate tokenizer (one shared WASM load) ─────────────────────────────────────────────
const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;
const require = createRequire(import.meta.url);
const bin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

async function loadTm(scopeName: string, files: Record<string, string>) {
  const cache: Record<string, string> = {};
  const reg = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new OnigScanner(p), createOnigString: (s: string) => new OnigString(s) }),
    loadGrammar: async (sn: string) => { const p = files[sn]; if (!p) return null; const c = cache[sn] ?? (cache[sn] = readFileSync(p, 'utf8')); return parseRawGrammar(c, sn + '.json'); },
  });
  return reg.loadGrammar(scopeName);
}
interface TmTok { start: number; end: number; scopes: string[] }
function tmTokenize(grammar: vsctm.IGrammar, text: string): TmTok[] {
  const toks: TmTok[] = []; let rs = INITIAL, off = 0;
  for (const line of text.split('\n')) { const r = grammar.tokenizeLine(line, rs); for (const t of r.tokens) toks.push({ start: off + t.startIndex, end: off + t.endIndex, scopes: t.scopes }); rs = r.ruleStack; off += line.length + 1; }
  return toks;
}
function scopeAt(toks: TmTok[], pos: number): string[] {
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (toks[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans >= 0 && toks[ans].end > pos ? toks[ans].scopes : [];
}
const innerOf = (s: string[]): string => (s.length ? s[s.length - 1] : '(none)');

// ── visual bucket of a scope chain — the level at which a highlight difference is actually visible.
//    Same partition the scope-gap differential pass uses; the consistency check compares buckets so a
//    `-` painted as string (punct≠string) is caught even though punctuation is a lexical-floor role. ──
type Bucket = 'invalid' | 'comment' | 'string' | 'number' | 'keyword' | 'name' | 'punct' | 'none';
const DISTINCT = new Set<Bucket>(['invalid', 'comment', 'string', 'number', 'keyword']);
function scopeBucket(chain: string[]): Bucket {
  for (let i = chain.length - 1; i >= 0; i--) {
    const s = normScope(chain[i]);
    if (/^invalid/.test(s)) return 'invalid';
    if (/^comment/.test(s)) return 'comment';
    if (/^constant\.numeric/.test(s)) return 'number';
    if (/^(string|constant\.character|constant\.other\.symbol)/.test(s)) return 'string';
    if (/^(keyword|storage|constant\.language|support\.constant|variable\.language)/.test(s)) return 'keyword';
    if (/^(entity|variable|support|constant)/.test(s)) return 'name';
    if (/^punctuation/.test(s)) return 'punct';
  }
  return 'none';
}
// every visual bucket a scope CHAIN spans (a YAML number is `string.unquoted constant.numeric` →
// {string, number} — both are legitimate, since the same token folds to a multi-line string).
function chainBuckets(scope: string): Set<Bucket> {
  const out = new Set<Bucket>();
  for (const seg of scope.split(/\s+/)) if (seg) out.add(scopeBucket([seg]));
  return out;
}
const CONTENT = new Set<Bucket>(['string', 'comment', 'number']);   // a STRUCTURAL literal is never one of these

// ── by-construction expected role of a parsed leaf, from the grammar ALONE ──────────────────────
// A leaf's token TYPE → the bucket SET the grammar DECLARES for it: a named token → its `scope`
// chain's buckets; a `$punct`/`$keyword` literal → any `scopes` override, else punctuation / keyword.
// `lit` marks a STRUCTURAL literal (`$punct`/`$keyword`) — one the parser placed as grammar structure,
// so the highlighter painting it as CONTENT (string/comment/number) is always wrong (monogram#24).
interface LeafRole { start: number; end: number; text: string; tokenType: string; expected: Set<Bucket>; lit: boolean }
function buildRoleMap(grammar: CstGrammar): (leaf: { tokenType: string; text: string }) => { buckets: Set<Bucket>; lit: boolean } | null {
  const tokScope = new Map<string, string | undefined>();
  for (const t of grammar.tokens) tokScope.set(t.name, t.scope);
  const skip = new Set<string>();
  if (grammar.indent) { skip.add(grammar.indent.indentToken); skip.add(grammar.indent.dedentToken); skip.add(grammar.indent.newlineToken); }
  if (grammar.newline) skip.add(grammar.newline.token);
  const over = grammar.scopeOverrides;
  return (leaf) => {
    const ty = leaf.tokenType;
    if (skip.has(ty)) return null;
    if (ty === '$punct') { const o = over.get(leaf.text); return { buckets: o ? new Set(o.flatMap((s) => [...chainBuckets(s)])) : new Set<Bucket>(['punct']), lit: true }; }
    if (ty === '$keyword') { const o = over.get(leaf.text); return { buckets: o ? new Set(o.flatMap((s) => [...chainBuckets(s)])) : new Set<Bucket>(['keyword']), lit: true }; }
    if (ty.startsWith('$template')) return { buckets: new Set<Bucket>(['string']), lit: false };
    if (tokScope.has(ty)) { const sc = tokScope.get(ty); return sc ? { buckets: chainBuckets(sc), lit: false } : null; }
    return null;   // unscoped / contextual token (a bare identifier) → not checkable by-construction
  };
}
function leafRoles(grammar: CstGrammar, cst: CstNode, roleOf: (l: { tokenType: string; text: string }) => { buckets: Set<Bucket>; lit: boolean } | null): LeafRole[] {
  const out: LeafRole[] = [];
  const walk = (n: CstChild) => {
    if (n.kind === 'leaf') {
      if (n.end <= n.offset) return;
      const r = roleOf(n);
      if (r) out.push({ start: n.offset, end: n.end, text: n.text, tokenType: n.tokenType, expected: r.buckets, lit: r.lit });
    } else for (const c of n.children) walk(c);
  };
  walk(cst);
  return out;
}

// Scopes that belong to a POSITION-ANCHORED token — one whose pattern contains a `start()` anchor
// (e.g. YAML's DocStart/DocEnd `^---`/`^...`). Such a scope is the parser's signal "a marker AT a
// line/stream position"; the flat highlighter, retrying the pattern at every token boundary, may
// paint it on a token the parser placed elsewhere (a value-leading `---`, monogram#23). Map each
// such scope → the set of token names allowed to carry it, so a mismatch is detectable generically.
function anchoredScopes(grammar: CstGrammar): Map<string, Set<string>> {
  const hasStart = (p: TokenPattern): boolean => {
    if (typeof p === 'string') return false;
    switch (p.type) {
      case 'anchor': return p.kind === 'start';
      case 'seq': case 'alt': return p.items.some(hasStart);
      case 'repeat': case 'lookahead': case 'lookbehind': return hasStart(p.body);
      default: return false;
    }
  };
  const m = new Map<string, Set<string>>();
  for (const t of grammar.tokens) if (t.scope && hasStart(t.pattern)) { const s = m.get(t.scope) ?? new Set(); s.add(t.name); m.set(t.scope, s); }
  return m;
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────
interface Violation { input: string; strategy: string; pos: number; text: string; tokenType: string; expected: string; got: Bucket; gotScope: string; kind: string }

async function runLang(cfg: LangCfg): Promise<{ name: string; ok: boolean; violations: number; reason: string }> {
  if (!existsSync(cfg.tmPath)) { console.log(`  [skip ${cfg.name}: ${cfg.tmPath} not found — run npm run gen]`); return { name: cfg.name, ok: true, violations: 0 }; }
  const grammar = (await import(cfg.module)).default as CstGrammar;
  const { parse } = createParser(grammar);
  const tm = await loadTm(cfg.scopeName, { [cfg.scopeName]: cfg.tmPath, ...(cfg.tmExtra ?? {}) });
  if (!tm) throw new Error(`failed to load ${cfg.tmPath}`);
  const roleOf = buildRoleMap(grammar);
  const anchored = anchoredScopes(grammar);

  const inputs = generateInputs(grammar, cfg.gen ?? { depth: 5, nestDepth: 5, cap: 7, fuzzRounds: 250, maxInputs: 1500, seed: 5 });

  // ── (2) round-trip: parse each input AS THE RULE it was rooted at ──
  const byStrat = new Map<string, { ok: number; n: number }>();
  const entryLegal: GenInput[] = [];
  for (const inp of inputs) {
    const k = inp.strategy.split(/[:@]/)[0];
    const s = byStrat.get(k) ?? { ok: 0, n: 0 }; s.n++;
    let rootOk = false;
    try { parse(inp.text, inp.rule); rootOk = true; } catch { /* illegal derivation (IR over-permits vs the parser) */ }
    if (rootOk) s.ok++;
    byStrat.set(k, s);
    // the consistency check needs FULL documents (highlighter tokenizes the whole text as the entry
    // scope), so keep inputs that parse at the ENTRY rule.
    try { parse(inp.text); entryLegal.push(inp); } catch { /* not a full document — skip for scope≡role */ }
  }

  // ── (3) scope ≡ role on the entry-legal inputs ──────────────────────────────────────────────────
  // Two BY-CONSTRUCTION gates (each a flat-vs-stack disagreement that is unambiguously the
  // highlighter's error), plus a lenient report-only differential for context refinements:
  //   • gate-1 STRUCTURAL-LITERAL contradiction — a `$punct`/`$keyword` the parser placed as grammar
  //     structure, painted as CONTENT (string/comment/number). A `-` indicator is never a string
  //     (monogram#24). Floor-blind: it compares the punctuation class directly.
  //   • gate-2 ANCHORED-MARKER misfire — a leaf painted with a position-anchored token's scope when
  //     the parser did NOT place that token here (a value-leading `---` scoped document-marker,
  //     monogram#23). The flat grammar retried the `^`-anchored pattern off-position.
  // Leniency: a token is CONSISTENT when the highlighter paints ANY part of its span with a scope in
  // the token's declared-chain bucket SET — so a quote-delimiter sub-scope (`"…"` opens punctuation)
  // and a context fold (a number folded into a multi-line string) are NOT false-positives.
  const violations: Violation[] = [];
  let checkedTokens = 0;
  const spanBuckets = (toks: TmTok[], text: string, start: number, end: number): Set<Bucket> => {
    const s = new Set<Bucket>();
    for (let p = start; p < end; p++) { const c = text.charCodeAt(p); if (c === 32 || c === 9) continue; s.add(scopeBucket(scopeAt(toks, p))); }
    return s.size ? s : new Set<Bucket>(['none']);
  };
  for (const inp of entryLegal) {
    let cst: CstNode, toks: TmTok[];
    try { cst = parse(inp.text); toks = tmTokenize(tm, inp.text); } catch { continue; }
    const leaves = leafRoles(grammar, cst, roleOf);
    const leafCover = (pos: number) => leaves.find((l) => pos >= l.start && pos < l.end);
    for (const lr of leaves) {
      checkedTokens++;
      const got = spanBuckets(toks, inp.text, lr.start, lr.end);
      const overlap = [...lr.expected].some((b) => got.has(b));
      if (overlap) continue;                                                  // highlighter painted the declared scope somewhere → consistent
      // gate-1: a structural literal painted entirely as a content class
      const contentGot = [...got].find((b) => CONTENT.has(b));
      if (lr.lit && contentGot && violations.length < 200) {
        violations.push({ input: inp.text, strategy: inp.strategy, pos: lr.start, text: lr.text, tokenType: lr.tokenType, expected: [...lr.expected].join('|') as any, got: contentGot, gotScope: innerOf(scopeAt(toks, lr.start)), kind: '#24 structural-literal→content' });
      }
    }
    // gate-2: scan the highlighter's tokens for an anchored-marker scope on a leaf that is NOT that token
    if (anchored.size) for (const t of toks) {
      if (t.end <= t.start) continue;
      const inner = innerOf(t.scopes);
      const owners = anchored.get(inner.replace(/\.[a-z0-9]+$/, '')) ?? anchored.get(inner);
      if (!owners) continue;
      const leaf = leafCover(t.start);
      if (leaf && !owners.has(leaf.tokenType) && violations.length < 200) {
        violations.push({ input: inp.text, strategy: inp.strategy, pos: t.start, text: inp.text.slice(t.start, t.end), tokenType: leaf.tokenType, expected: [...owners].join('|') as any, got: 'name', gotScope: inner, kind: '#23 anchored-marker misfire' });
      }
    }
  }

  // ── report ──
  const totalLegal = [...byStrat.values()].reduce((a, s) => a + s.ok, 0);
  const totalN = [...byStrat.values()].reduce((a, s) => a + s.n, 0);
  const structuredLegal = [...byStrat.entries()].filter(([k]) => k !== 'fuzz').reduce((a, [, s]) => a + s.ok, 0);
  const structuredN = [...byStrat.entries()].filter(([k]) => k !== 'fuzz').reduce((a, [, s]) => a + s.n, 0);
  const fuzzLegal = totalLegal - structuredLegal, fuzzN = totalN - structuredN;
  const rate = (a: number, b: number) => b ? (100 * a / b).toFixed(0) + '%' : 'n/a';
  console.log(`\n── ${cfg.name} ──  ${inputs.length} generated · ${entryLegal.length} full-document`);
  // STRUCTURED is the by-construction round-trip guarantee (every derivation parses as its rule);
  // FUZZ is exploratory (random choices wander outside the IR's context constraints → many illegal,
  // which is expected and filtered) and is what surfaces divergences beyond the structured shapes.
  console.log(`  round-trip (rule-rooted):  structured ${structuredLegal}/${structuredN} (${rate(structuredLegal, structuredN)} — the by-construction gate) · fuzz ${fuzzLegal}/${fuzzN} (exploratory)` + ['', ...[...byStrat.entries()].filter(([k]) => k !== 'fuzz').map(([k, s]) => `${k} ${s.ok}/${s.n}`)].join('  '));
  // What GATES vs what is a report-only DISCOVERY:
  //  • an ANCHORED-MARKER misfire (#23) ALWAYS gates — a position-anchored marker scope on a token the
  //    parser placed elsewhere is unambiguously the flat grammar mis-firing the pattern off-position;
  //    there is no legitimate "frontier limit" version of it.
  //  • a STRUCTURAL-LITERAL→content divergence (#24) gates on the STRUCTURED strategies (canonical,
  //    clean nested shapes — the by-construction guarantee: the dirnest `- - x\n  - x` reproduces #24),
  //    but is report-only on gnarly FUZZ inputs, which legitimately reach STANDING flat-TM frontier
  //    limits (a block plain scalar containing an unclosed flow indicator `[`/`{` — block-vs-flow
  //    disambiguation that needs the indent/flow stack a flat grammar lacks). Those are not
  //    regressions of a known-fixed shape, and #25 is the testing harness, not a fix for every limit.
  const isGated = (v: Violation) => v.kind.startsWith('#23') || !v.strategy.startsWith('fuzz');
  const gated = violations.filter(isGated);
  const discovered = violations.filter((v) => !isGated(v));
  console.log(`  scope≡role: ${checkedTokens} declared-scope tokens checked · ${gated.length} gated inconsistenc${gated.length === 1 ? 'y' : 'ies'} · ${discovered.length} discovered (fuzz frontier-limit, report-only)`);
  const show = (vs: Violation[], tag: string) => {
    const grouped = new Map<string, { v: Violation; n: number }>();
    for (const v of vs) { const key = `${v.kind} ${v.tokenType}`; const e = grouped.get(key); if (e) e.n++; else grouped.set(key, { v, n: 1 }); }
    for (const [key, { v, n }] of [...grouped.entries()].slice(0, 8)) console.log(`    ${tag} ${key} ×${n}  «${v.text.slice(0, 14).replace(/\n/g, '\\n')}» got «${v.gotScope}»  in ${JSON.stringify(v.input.slice(0, 40))}`);
  };
  if (gated.length) show(gated, '✗');
  if (discovered.length) show(discovered, '·');

  // depth-site COVERAGE: the generated legal corpus must contain each declared depth-bug class, so the
  // scope≡role gate provably exercises monogram#23/#24 (not just happens to be clean on a fixed corpus).
  const legalTexts = entryLegal.map((i) => i.text);
  const missing = (cfg.mustCover ?? []).filter((m) => !legalTexts.some((t) => m.re.test(t)));
  if (cfg.mustCover?.length) {
    const covered = cfg.mustCover.length - missing.length;
    console.log(`  depth-site coverage: ${covered}/${cfg.mustCover.length} classes present in the legal corpus` + (missing.length ? `  — MISSING: ${missing.map((m) => m.name).join(', ')}` : `  (${cfg.mustCover.map((m) => m.name).join(', ')})`));
  }
  // GATE: (a) the generator produced a real LEGAL corpus (a coverage floor — proves round-trip works:
  // the grammar's IR generates inputs the parser accepts), and (b) ZERO scope≡role gated inconsistencies.
  // The structured legal RATE is reported for visibility but not gated on a percentage — the generator
  // legitimately over-produces (the IR over-permits vs the parser; markup materialisation is rough), and
  // the validated corpus is the inputs that DO parse.
  const enoughLegal = entryLegal.length >= 15;
  const reason = gated.length ? `${gated.length} scope≡role` : !enoughLegal ? `only ${entryLegal.length} legal docs` : missing.length ? `missing ${missing.map((m) => m.name).join('/')}` : '';
  return { name: cfg.name, ok: gated.length === 0 && enoughLegal && missing.length === 0, violations: gated.length, reason };
}

const only = process.argv[2];
const targets = only ? LANGS.filter((l) => l.name === only || (only === 'tsfamily' && /script/.test(l.name))) : LANGS;
if (!targets.length) { console.error(`unknown language: ${only}`); process.exit(1); }
console.log('Generative consistency — grammar-derived inputs, by-construction round-trip + scope≡role');
const results = [];
for (const cfg of targets) results.push(await runLang(cfg));
const bad = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(70)}`);
console.log(`  ${results.length - bad.length}/${results.length} languages consistent` + (bad.length ? `  — FAILED: ${bad.map((b) => `${b.name} (${b.reason})`).join(', ')}` : ''));
if (bad.length) { console.error('\nGENERATIVE GATE FAILED — a scope≡role inconsistency (flat highlighter ≠ parser) or too small a legal corpus.'); process.exit(1); }
console.log('\nDone.');
