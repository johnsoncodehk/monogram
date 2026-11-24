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
//   HTML SITES (runHtmlSites, with html) — the self-close `/` site matrix against parse5, the
//       detector's mutation proof, and the classifier lock (see that section).
//
//  Coverage is grammar×bound, not a fixed corpus — so it surfaces the depth-bug CLASS
//  without anyone naming the shape (the motivation for #25). The named regressions
//  (yaml-sites.ts, *-issue-cases.ts) stay — generation replaces their
//  DISCOVERY function, not their value as documented gates.
//
//  Run (bare node):  node test/generative.ts            # all languages
//                    node test/generative.ts yaml       # one language
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { parseFragment } from 'parse5';
import { createParser, type CstNode } from '../src/interpreter.ts';
import { scratchDir } from './scratch.ts';
import type { Grammar } from '../src/types.ts';
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
  module: string;          // grammar module to import (default export = Grammar)
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
  if (!existsSync(cfg.tmPath)) { console.log(`  [skip ${cfg.name}: ${cfg.tmPath} not found — run npm run gen]`); return { name: cfg.name, ok: true, violations: 0, reason: '' }; }
  const grammar = (await import(cfg.module)).default as Grammar;
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

// ── HTML: the self-close `/` sites, and the detector's own mutation proof ───────────────────────────
// (1) SELF-CLOSE SITES — in a flat markup grammar the attribute VALUE context decides where a value ends,
// and a `/` GLUED right after the value is EITHER the tag's self-close punctuation (`<A A=""/>`: the value
// ended at the quote) OR content of an UNQUOTED value (`<a href=x/>`: WHATWG lets `/` sit in an unquoted
// value). A bug is a `/` whose context mis-classifies it (html.tmbundle#118/#124/#140360; generation
// found it, fe4afc0). Each {value shape × element class} is realised as a minimal element (the
// delimiters, self-close marker, quotes and the void class read from `grammar.markup`); the NEUTRAL
// ORACLE parse5 says whether the `/` lies inside an attribute value's source span (→ must stay
// `string.unquoted`) or outside every value span (→ must read tag punctuation).
// (2) MUTATION PROOF — on a copy of the html grammar with the attribute value-context `end` rolled back
// (the `(?<=[quotes])(?=/)` self-close release arm dropped, reintroducing the self-close gap) the
// scope≡role detector must FIND the divergence, and on the shipped grammar it must not: the detector is
// not blind, independent of whether the shipped grammar is currently clean.
// (3) CLASSIFIER LOCK — a structural-literal / anchored-marker / comment divergence GATES on every
// strategy, never conceded as a report-only "fuzz frontier limit" (fe4afc0: the concession had hidden
// the self-close bug the generator printed).
async function runHtmlSites(): Promise<{ name: string; ok: boolean; violations: number; reason: string }> {
  const cfg = LANGS.find((l) => l.name === 'html')!;
  const grammar = (await import(cfg.module)).default as Grammar;
  const m = grammar.markup!;
  const failsAt: string[] = [];
  // (1)
  const tm = (await loadTm(cfg.scopeName, { [cfg.scopeName]: 'html.tmLanguage.json' }))!;
  const innerAt = (toks: TmTok[], pos: number): string => {
    const t = toks.find((x) => x.start <= pos && pos < x.end);
    const s = t ? t.scopes : [];
    return (s.length ? s[s.length - 1] : '(none)').replace(/\.html$/, '');
  };
  // parse5: the source offsets INSIDE an attribute VALUE span (normalised to exactly the run the parser
  // keeps as the value: `href=x/` includes the `/`, `A="x"` does not)
  const valueOffsets = (html: string): Set<number> => {
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
          if (html[lo] === '"' || html[lo] === "'") { lo++; hi--; }
          for (let i = lo; i < hi; i++) inside.add(i);
        }
      }
      for (const c of n.childNodes ?? []) visit(c);
    };
    for (const c of doc.childNodes ?? []) visit(c);
    return inside;
  };
  const SLASH = m.closeMarker ?? '/';
  const quotes = m.attributeQuotes ?? ['"', "'"];
  const dq = quotes[0] ?? '"', sq = quotes.find((q) => q !== dq) ?? dq;
  const elements = [{ kind: 'void', tag: (m.voidTags ?? [])[0] ?? 'input' }, { kind: 'non-void', tag: 'A' }, { kind: 'svg', tag: 'svg' }, { kind: 'custom', tag: 'my-el' }];
  const shapes: { name: string; make: (t: string) => string }[] = [
    { name: 'quoted-empty', make: (t) => `<${t} a=${dq}${dq}${SLASH}>` },
    { name: 'quoted-value', make: (t) => `<${t} a=${dq}x${dq}${SLASH}>` },
    { name: 'single-quoted', make: (t) => `<${t} a=${sq}x${sq}${SLASH}>` },
    { name: 'unquoted-value', make: (t) => `<${t} a=x${SLASH}>` },
    { name: 'bare', make: (t) => `<${t}${SLASH}>` },
    { name: 'after-space', make: (t) => `<${t} a=${dq}x${dq} ${SLASH}>` },
    { name: 'directive-value', make: (t) => `<${t} a=${dq}x${dq} b=${dq}${dq}${SLASH}>` },  // the glued `/` after the 2nd close-quote
    { name: 'multi-line', make: (t) => `<${t}\na=${dq}${dq}${SLASH}>` },
  ];
  let cells = 0;
  for (const sh of shapes) for (const el of elements) {
    const input = sh.make(el.tag);
    const focus = input.lastIndexOf(SLASH, input.lastIndexOf(m.tagClose));   // the `/` right before the closing `>`
    if (focus < 0) continue;
    cells++;
    const wantStr = valueOffsets(input).has(focus);
    const got = innerAt(tmTokenize(tm, input), focus);
    if (!(wantStr ? got.startsWith('string.unquoted') : got.startsWith('punctuation.definition.tag'))) failsAt.push(`self-close ${sh.name} × ${el.kind} ${JSON.stringify(input)}: want ${wantStr ? 'string.unquoted' : 'punctuation.definition.tag'}, got ${got}`);
  }
  // (2)
  const { parse } = createParser(grammar);
  const roleOf = buildRoleMap(grammar), anchored = anchoredScopes(grammar);
  const shippedTm = (await loadTm(cfg.scopeName, { [cfg.scopeName]: cfg.tmPath, ...(cfg.tmExtra ?? {}) }))!;
  const raw = JSON.parse(readFileSync(cfg.tmPath, 'utf8'));
  let rolled = 0;
  for (const p of raw.repository?.attribute?.patterns ?? []) {
    if (typeof p.begin === 'string' && /^\(=\)/.test(p.begin) && typeof p.end === 'string' && /\(\?<=/.test(p.end)) {
      p.end = p.end.replace(/\|\(\?<=\[[^\]]*\]\)\(\?=[^)]*\)\s*$/, '');
      rolled++;
    }
  }
  if (!rolled) failsAt.push('mutation proof: the attribute value-context `end` to roll back is not in html.tmLanguage.json (grammar shape changed?)');
  const file = join(scratchDir('generative'), 'html-perturbed.tmLanguage.json');
  writeFileSync(file, JSON.stringify(raw));
  // every embed that pointed back at the html grammar (`source.css`) points at the perturbed copy too:
  // vscode-textmate shares rule state across a recursive self-embed
  const extra = Object.fromEntries(Object.entries(cfg.tmExtra ?? {}).map(([sn, p]) => [sn, p === cfg.tmPath ? file : p]));
  const perturbedTm = (await loadTm(cfg.scopeName, { [cfg.scopeName]: file, ...extra }))!;
  // the self-close `/` divergence (a structural-literal→content #24), found by token
  const diverges = (t: vsctm.IGrammar, text: string): boolean => {
    let cst: CstNode, toks: TmTok[];
    try { cst = parse(text); toks = tmTokenize(t, text); } catch { return false; }
    const leaves = leafRoles(grammar, cst, text, roleOf);
    return collectViolations({ input: text, strategy: 'fuzz', cst, toks, leaves, anchored }).some((v) => v.text === '/');
  };
  const probe = '<aA aA = "a"/>';   // the generator's tight-markup shape
  if (!diverges(perturbedTm, probe)) failsAt.push(`mutation proof: the detector does not find the self-close \`/\` divergence on ${JSON.stringify(probe)} with the rolled-back grammar`);
  if (diverges(shippedTm, probe)) failsAt.push(`mutation proof: the shipped grammar diverges on ${JSON.stringify(probe)}`);
  // (3)
  for (const kind of ['#24 structural-literal→content', 'structural-literal→name', '#23 anchored-marker misfire', '#comment uncolored']) {
    if (!isGated({ kind })) failsAt.push(`classifier lock: a \`${kind}\` divergence does not gate`);
  }
  console.log(`\n── html sites ──  ${cells} self-close cells vs parse5 · detector mutation proof (rolled-back + shipped) · 4 classifier-lock kinds · ${failsAt.length} wrong`);
  for (const f of failsAt) console.log(`    ✗ ${f}`);
  return { name: 'html sites', ok: failsAt.length === 0, violations: failsAt.length, reason: `${failsAt.length} wrong` };
}

const only = process.argv[2];
const targets = only ? LANGS.filter((l) => l.name === only || (only === 'tsfamily' && /script/.test(l.name))) : LANGS;
if (!targets.length) { console.error(`unknown language: ${only}`); process.exit(1); }
console.log('Generative consistency — grammar-derived inputs, by-construction round-trip + scope≡role');
const results = [];
for (const cfg of targets) results.push(await runLang(cfg));
if (targets.some((l) => l.name === 'html')) results.push(await runHtmlSites());
const bad = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(70)}`);
console.log(`  ${results.length - bad.length}/${results.length} languages (+ html sites) consistent` + (bad.length ? `  — FAILED: ${bad.map((b) => `${b.name} (${b.reason})`).join(', ')}` : ''));
if (bad.length) { console.error('\nGENERATIVE GATE FAILED — a scope≡role inconsistency (flat highlighter ≠ parser) or too small a legal corpus.'); process.exit(1); }
console.log('\nDone.');
