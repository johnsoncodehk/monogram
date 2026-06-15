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
import { createParser, type CstNode } from '../src/gen-parser.ts';
import type { CstGrammar } from '../src/types.ts';
import { generateInputs, type GenInput } from './grammar-gen.ts';
// The scope≡role divergence detection is factored into generative-detect.ts so the gap ledger
// (test/gap-ledger.ts) reuses the EXACT same logic. This driver's gate behaviour is unchanged.
import {
  type TmTok, type Violation,
  buildRoleMap, leafRoles, anchoredScopes, collectViolations, isGated, GEN_OPTS,
  commentWitnesses, collectCommentViolations,
} from './generative-detect.ts';

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
function tmTokenize(grammar: vsctm.IGrammar, text: string): TmTok[] {
  const toks: TmTok[] = []; let rs = INITIAL, off = 0;
  for (const line of text.split('\n')) { const r = grammar.tokenizeLine(line, rs); for (const t of r.tokens) toks.push({ start: off + t.startIndex, end: off + t.endIndex, scopes: t.scopes }); rs = r.ruleStack; off += line.length + 1; }
  return toks;
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────
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
  let checkedComments = 0;   // comment WITNESSES graded — was structurally 0 (comments are skip→no CST leaf)
  for (const inp of entryLegal) {
    let cst: CstNode, toks: TmTok[];
    try { cst = parse(inp.text); toks = tmTokenize(tm, inp.text); } catch { continue; }
    const leaves = leafRoles(grammar, cst, inp.text, roleOf);
    checkedTokens += leaves.length;
    // gate-1 (#24 structural-literal→content) + gate-2 (#23 anchored-marker misfire), via the shared
    // detector — identical logic to before, now reused by the gap ledger. The 200-cap is the running
    // total across all inputs (startCount), as the inline version was.
    violations.push(...collectViolations({ input: inp.text, strategy: inp.strategy, cst, toks, leaves, anchored, cap: 200, startCount: violations.length }));
    // COMMENT-WITNESS arm — a comment is a skip token (no CST leaf), so it is NEVER in `leaves`/`checkedTokens`
    // and the highlighter's comment scope was previously UNCHECKED (0% coverage). Grade the spans the
    // generator recorded as witnesses (grammar-gen §8): the highlighter must paint each `comment`. This is
    // the first consumer of `GenInput.tokens`. ALWAYS-gating (see isGated) — but ~0 on the correct grammars.
    const witnesses = commentWitnesses(grammar, inp);
    checkedComments += witnesses.length;
    violations.push(...collectCommentViolations({ grammar, input: inp.text, strategy: inp.strategy, witnesses, toks }));
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
  const gated = violations.filter(isGated);
  const discovered = violations.filter((v) => !isGated(v));
  console.log(`  scope≡role: ${checkedTokens} declared-scope tokens checked · ${gated.length} gated inconsistenc${gated.length === 1 ? 'y' : 'ies'} · ${discovered.length} report-only (allowlisted proven-limits — 0 by default; structural divergences GATE)`);
  // comment-witness coverage: how many injected comment spans were graded (was structurally 0 — a comment
  // is a skip token, dropped by the parser, so it never reached the leaf-walking scope≡role check).
  console.log(`  comment witnesses: ${checkedComments} comment span${checkedComments === 1 ? '' : 's'} graded (highlighter must paint COMMENT) · ${violations.filter((v) => v.kind.startsWith('#comment')).length} uncolored`);
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
