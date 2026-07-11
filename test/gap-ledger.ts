// ─────────────────────────────────────────────────────────────────────────────
//  gap-ledger.ts — a DETERMINISTIC, auto-maintained GAP LEDGER for Monogram.
//
//  The generative by-construction check (test/generative.ts) DISCOVERS divergences
//  where the flat TextMate highlighter and the Monogram parser disagree on the
//  visual role of a token in a grammar-DERIVED input — the floor-blind class the
//  corpus-bound scope-gap metric is blind to (monogram#23/#24). That check REPORTS
//  them; this ledger OPERATIONALIZES them into a stable, commit-trackable artifact:
//
//    1. DISCOVER — for each of the 7 grammars, generate inputs deterministically
//       (grammar-gen.ts), tokenize with the flat grammar + parse with the parser,
//       and collect the divergences using the SAME detector generative.ts uses
//       (generative-detect.ts) — not a reimplementation.
//    2. MINIMIZE — delta-debug (ddmin) each divergence's input down to a minimal
//       repro that still parses AND still exhibits the SAME divergence (same parser
//       role-bucket vs same highlighter bucket, identified by a position-independent
//       signature). The generator + ddmin are deterministic, so the minimal repro is
//       stable across runs and commits.
//    3. CLASSIFY — parse the minimal repro with the language's EXTERNAL authority
//       (typescript / yaml / parse5). File ONLY divergences the oracle accepts as
//       VALID input (a real highlighter gap on valid input). A repro the parser
//       accepts but the oracle rejects is a parser OVER-ACCEPT — a different concern;
//       it is DROPPED from the gap list (its count is reported, not listed).
//    4. FINGERPRINT — a stable id = hash(language, normalized repro, role, bucket),
//       so the same gap keeps the same id across commits.
//    5. EMIT — a sorted docs/KNOWN-GAPS.md (committed artifact): per gap, the language,
//       escaped minimal repro, role-vs-scope (want vs got), fingerprint, and a
//       machine-readable JSON block.
//
//  DETERMINISM is the whole point (a commit-trackable ledger): two runs produce a
//  BYTE-IDENTICAL docs/KNOWN-GAPS.md. The generator is a pure function of the grammar
//  (no seed), ddmin is deterministic, the oracle is deterministic, and the hash is
//  content-only — so nothing varies run-to-run.
//
//  Run (bare node):
//    node test/gap-ledger.ts            # print the ledger to stdout (don't write)
//    node test/gap-ledger.ts --write    # (re)write docs/KNOWN-GAPS.md
//    node test/gap-ledger.ts --check    # fail if docs/KNOWN-GAPS.md is stale (CI guard)
//    node test/gap-ledger.ts yaml       # one language
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import ts from 'typescript';
import { parseAllDocuments } from 'yaml';
import { parseFragment } from 'parse5';
import { createParser, type CstNode } from '../src/gen-parser.ts';
import type { CstGrammar } from '../src/types.ts';
import { generateInputs } from './grammar-gen.ts';
import {
  type TmTok, type Violation,
  buildRoleMap, leafRoles, anchoredScopes, collectViolations, isGated, GEN_OPTS,
} from './generative-detect.ts';

// ── language registry — the SAME per-language DATA shape as generative.ts's LANGS, plus an
//    `oracleAccepts(text)`: the external authority's verdict on whether the minimal repro is VALID
//    input. THAT is the only per-language wiring (a config table, like generative.ts's LANGS); the
//    ddmin / fingerprint / emit ENGINE below is language-agnostic. ──
interface LangCfg {
  name: string;
  module: string;          // grammar module (default export = CstGrammar)
  scopeName: string;       // TextMate scope, e.g. source.yaml
  tmPath: string;          // the derived flat .tmLanguage.json
  tmExtra?: Record<string, string>;  // extra scopeName → file for multi-file grammars
  oracleAccepts: (text: string) => boolean;   // the neutral oracle's "is this VALID input?" verdict
}

// ── oracle validity verdicts (DATA) ──────────────────────────────────────────────────────────────
// TS-family: tsc's own parser — zero parseDiagnostics means it accepts the text as valid source.
const tsAccepts = (kind: ts.ScriptKind) => (text: string): boolean => {
  try {
    const sf = ts.createSourceFile('gap.ts', text, ts.ScriptTarget.Latest, /*setParentNodes*/ false, kind);
    return ((sf as any).parseDiagnostics?.length ?? 0) === 0;
  } catch { return false; }
};
// YAML: the `yaml` package — a document with zero `.errors` is valid (the same independent authority
// the scope-gap YAML oracle uses). A throw or any error ⇒ not valid.
const yamlAccepts = (text: string): boolean => {
  try { const docs = parseAllDocuments(text); return docs.length > 0 && docs.every((d: any) => (d.errors?.length ?? 0) === 0); }
  catch { return false; }
};
// HTML: parse5 is error-TOLERANT (never throws), so "valid" = it recovered a real element structure —
// at least one element/tag node (not pure text / a dropped `</>`). This matches html-oracle.ts's own
// emission gate (it only emits tag/attr roles when parse5 reports a tagName + location).
const htmlAccepts = (text: string): boolean => {
  try {
    const frag: any = parseFragment(text, { sourceCodeLocationInfo: true });
    const hasEl = (nodes: any[]): boolean => nodes.some((n) => (n.tagName && n.sourceCodeLocation) || (n.childNodes && hasEl(n.childNodes)));
    return hasEl(frag.childNodes ?? []);
  } catch { return false; }
};
const LANGS: LangCfg[] = [
  { name: 'yaml', module: '../yaml.ts', scopeName: 'source.yaml', tmPath: 'yaml.tmLanguage.json', oracleAccepts: yamlAccepts },
  { name: 'typescript', module: '../typescript.ts', scopeName: 'source.ts', tmPath: 'typescript.tmLanguage.json', oracleAccepts: tsAccepts(ts.ScriptKind.TS) },
  { name: 'javascript', module: '../javascript.ts', scopeName: 'source.js', tmPath: 'javascript.tmLanguage.json', oracleAccepts: tsAccepts(ts.ScriptKind.JS) },
  { name: 'typescriptreact', module: '../typescriptreact.ts', scopeName: 'source.tsx', tmPath: 'typescriptreact.tmLanguage.json', oracleAccepts: tsAccepts(ts.ScriptKind.TSX) },
  { name: 'javascriptreact', module: '../javascriptreact.ts', scopeName: 'source.js.jsx', tmPath: 'javascriptreact.tmLanguage.json', oracleAccepts: tsAccepts(ts.ScriptKind.JSX) },
  { name: 'html', module: '../html.ts', scopeName: 'text.html.basic', tmPath: 'html.tmLanguage.json',
    tmExtra: { 'source.js': 'javascript.tmLanguage.json', 'source.css': 'html.tmLanguage.json' }, oracleAccepts: htmlAccepts },
];

// ── shared vscode-textmate tokenizer (one WASM load) ─────────────────────────────────────────────
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

// ── a divergence's POSITION-INDEPENDENT signature — what "the SAME divergence" means across the
//    shrinking candidates (their byte offsets all differ as the input shrinks). A divergence is the
//    same iff it is the same KIND (#23/#24), on the same TOKEN TYPE, painting the same wrong visual
//    BUCKET, on a leaf of the same TEXT (the `/` of a self-close, the `---` of a value-marker). The
//    `pos` is deliberately EXCLUDED — that is exactly the coordinate ddmin changes. ──
function sig(v: Violation): string { return `${v.kind}|${v.tokenType}|${v.got}|${v.text}`; }

// One repro's check: parse it (parser must still ACCEPT — a shrink that breaks parsing is not a valid
// candidate), tokenize, and report whether `target` (a divergence signature) still appears among the
// detected violations. Returns the matching Violation (for its fresh offsets) or null.
interface Probe { parse: (text: string, rule?: string) => CstNode; tm: vsctm.IGrammar; grammar: CstGrammar; roleOf: ReturnType<typeof buildRoleMap>; anchored: Map<string, Set<string>>; }
function reproStillDiverges(p: Probe, text: string, target: string): Violation | null {
  let cst: CstNode;
  try { cst = p.parse(text); } catch { return null; }      // parser must accept the shrunk input
  let toks: TmTok[];
  try { toks = tmTokenize(p.tm, text); } catch { return null; }
  const leaves = leafRoles(p.grammar, cst, text, p.roleOf);
  const vs = collectViolations({ input: text, strategy: 'fuzz', cst, toks, leaves, anchored: p.anchored });
  return vs.find((v) => sig(v) === target) ?? null;
}

// ── ddmin: delta-debugging minimization. Shrink `text` while `keeps(candidate)` stays true. Two
//    passes, both deterministic: (1) LINE granularity (drop a contiguous block of lines), then
//    (2) CHARACTER granularity (drop a contiguous run of chars). The classic ddmin schedule —
//    halving the chunk size when no removal at the current size helps — gives a 1-minimal result
//    (no single chunk at the finest granularity can be removed) and is order-deterministic. ──
function ddminBy<T>(units: T[], join: (us: T[]) => string, keeps: (text: string) => boolean): T[] {
  let cur = units;
  let n = 2;
  while (cur.length >= 2) {
    const chunk = Math.ceil(cur.length / n);
    let removedAny = false;
    // try removing each contiguous chunk (left to right) — deterministic order
    for (let i = 0; i < cur.length; i += chunk) {
      const candidate = [...cur.slice(0, i), ...cur.slice(i + chunk)];
      if (candidate.length && candidate.length < cur.length && keeps(join(candidate))) {
        cur = candidate;
        n = Math.max(n - 1, 2);
        removedAny = true;
        break;          // restart the schedule on the smaller input (deterministic)
      }
    }
    if (!removedAny) {
      if (n >= cur.length) break;       // finest granularity reached, nothing removable → 1-minimal
      n = Math.min(cur.length, n * 2);
    }
  }
  return cur;
}

function minimize(p: Probe, input: string, target: string): string {
  // sanity: the unshrunk input must actually exhibit the target (it came from detection, so it does)
  if (!reproStillDiverges(p, input, target)) return input;
  const keeps = (text: string) => text.trim().length > 0 && !!reproStillDiverges(p, text, target);
  // pass 1: drop whole lines (keeps the `\n` joins so indentation/line structure is preserved)
  let lines = input.split('\n');
  lines = ddminBy(lines, (us) => us.join('\n'), keeps);
  let cur = lines.join('\n');
  // pass 2: drop characters (the within-line minimization — trims `<aA aA = "a"/>` → `<a a="a"/>`)
  const chars = ddminBy([...cur], (us) => us.join(''), keeps);
  cur = chars.join('');
  return cur;
}

// ── fingerprint: a stable content hash. Inputs are LANGUAGE + the NORMALIZED minimal repro + the
//    parser ROLE side (expected buckets) + the highlighter BUCKET (got) — i.e. exactly the identity
//    of the gap, nothing run-dependent. Normalization (trim trailing whitespace per line, LF) keeps
//    the id stable against incidental formatting. 12 hex chars = 48 bits, ample for a small ledger. ──
function normalizeRepro(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '');
}
function fingerprint(g: Gap): string {
  const h = createHash('sha256');
  h.update(`${g.language} ${normalizeRepro(g.repro)} ${g.expected} ${g.got}`);
  return h.digest('hex').slice(0, 12);
}

// ── a filed gap (the ledger row) ──────────────────────────────────────────────────────────────────
interface Gap {
  id: string;            // fingerprint (filled after construction)
  language: string;
  kind: string;          // the divergence class (#23/#24)
  repro: string;         // the minimized input
  tokenType: string;     // the parser's token type for the divergent leaf
  tokenText: string;     // the divergent leaf's text (`/`, `---`, …)
  expected: string;      // by-construction declared role buckets (want)
  got: string;           // the visual bucket the highlighter painted (the wrong one)
  gotScope: string;      // the actual innermost scope the highlighter emitted
}

interface LangResult { name: string; kept: Gap[]; droppedOverAccept: number; discovered: number; }

async function runLang(cfg: LangCfg): Promise<LangResult> {
  if (!existsSync(cfg.tmPath)) return { name: cfg.name, kept: [], droppedOverAccept: 0, discovered: 0 };
  const grammar = (await import(cfg.module)).default as CstGrammar;
  const { parse } = createParser(grammar);
  const tm = await loadTm(cfg.scopeName, { [cfg.scopeName]: cfg.tmPath, ...(cfg.tmExtra ?? {}) });
  if (!tm) throw new Error(`failed to load ${cfg.tmPath}`);
  const roleOf = buildRoleMap(grammar);
  const anchored = anchoredScopes(grammar);
  const probe: Probe = { parse, tm, grammar, roleOf, anchored };

  // 1) DISCOVER — generate deterministically, then collect the DISCOVERED (report-only, !isGated)
  //    divergences over the full-document inputs. (The gated ones are generative.ts's hard failures;
  //    on this UNFIXED branch there are none. The ledger files the floor-blind DISCOVERED class.)
  const inputs = generateInputs(grammar, GEN_OPTS);   // SAME corpus generative.ts checks, or the ledger misses divergences the check reports
  const discoveredVs: Violation[] = [];
  for (const inp of inputs) {
    let cst: CstNode, toks: TmTok[];
    try { cst = parse(inp.text); } catch { continue; }       // only full-document (entry-rule) inputs
    try { toks = tmTokenize(tm, inp.text); } catch { continue; }
    const leaves = leafRoles(grammar, cst, inp.text, roleOf);
    const vs = collectViolations({ input: inp.text, strategy: inp.strategy, cst, toks, leaves, anchored });
    for (const v of vs) if (!isGated(v)) discoveredVs.push(v);
  }

  // dedupe by signature — keep the SHORTEST-input witness per distinct divergence (ddmin shrinks it
  // anyway, but starting from the shortest is faster and keeps the pre-ddmin choice deterministic).
  const bySig = new Map<string, Violation>();
  for (const v of discoveredVs) {
    const k = sig(v);
    const prev = bySig.get(k);
    if (!prev || v.input.length < prev.input.length || (v.input.length === prev.input.length && v.input < prev.input)) bySig.set(k, v);
  }

  // 2) MINIMIZE + 3) CLASSIFY each distinct divergence
  const kept: Gap[] = [];
  let droppedOverAccept = 0;
  for (const [target, v] of [...bySig.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const repro = minimize(probe, v.input, target);
    // re-detect on the minimized repro to read the divergent leaf's FINAL offsets/scope
    const finalV = reproStillDiverges(probe, repro, target) ?? v;
    // CLASSIFY: keep ONLY if the external oracle accepts the minimal repro as VALID input.
    if (!cfg.oracleAccepts(repro)) { droppedOverAccept++; continue; }
    const g: Gap = {
      id: '', language: cfg.name, kind: finalV.kind, repro,
      tokenType: finalV.tokenType, tokenText: finalV.text,
      expected: finalV.expected, got: finalV.got, gotScope: finalV.gotScope,
    };
    g.id = fingerprint(g);
    kept.push(g);
  }
  return { name: cfg.name, kept, droppedOverAccept, discovered: bySig.size };
}

// ── EMIT: KNOWN-GAPS.md (human-readable + machine-readable JSON block per gap) ────────────────────
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');

function renderMarkdown(gaps: Gap[], dropped: number, langCount: number): string {
  const lines: string[] = [];
  lines.push('# KNOWN-GAPS — Monogram flat-highlighter divergences (auto-generated)');
  lines.push('');
  lines.push('<!-- AUTO-GENERATED by `node test/gap-ledger.ts --write`. Do not edit by hand. -->');
  lines.push('');
  lines.push('A **gap** is a position where, on **valid input** (accepted by the language’s external');
  lines.push('authority — typescript / yaml / parse5), the **flat TextMate highlighter** paints a token a');
  lines.push('different visual role than the **Monogram parser** assigns it by construction. These are the');
  lines.push('floor-blind divergences the generative scope≡role check (`test/generative.ts`) DISCOVERS over');
  lines.push('grammar-derived inputs — the monogram#23/#24 class — which the corpus-bound scope-gap metric is');
  lines.push('blind to (a small/clean corpus may never contain the shape, and the role-graded metric ignores');
  lines.push('punctuation-floor mis-paints). Each gap’s input is **minimized** (delta-debugged to a minimal');
  lines.push('repro that still parses and still diverges) and **fingerprinted** (a content hash, stable across');
  lines.push('commits) so the ledger is deterministic and commit-trackable.');
  lines.push('');
  lines.push('Regenerate: `node test/gap-ledger.ts --write` · verify up-to-date: `node test/gap-ledger.ts --check`.');
  lines.push('');
  lines.push(`**${gaps.length} gap${gaps.length === 1 ? '' : 's'}** across ${langCount} grammars` +
    (dropped ? ` · ${dropped} divergence${dropped === 1 ? '' : 's'} dropped as parser over-accepts (oracle-rejected repro, not a highlighter gap)` : ' · 0 dropped') + '.');
  lines.push('');
  if (!gaps.length) {
    lines.push('_No gaps currently surface._ The generative check reports no valid-input flat-highlighter');
    lines.push('divergence on the derived corpus. (This is the ledger MECHANISM; it lists what the check finds.)');
    lines.push('');
    return lines.join('\n') + '\n';
  }
  for (const g of gaps) {
    lines.push(`## \`${g.id}\` — ${g.language}: ${g.kind}`);
    lines.push('');
    lines.push(`- **Language:** ${g.language}`);
    lines.push(`- **Minimal repro:** \`${esc(g.repro)}\``);
    lines.push(`- **Divergent token:** \`${esc(g.tokenText)}\` (parser token \`${g.tokenType}\`)`);
    lines.push(`- **Role vs scope:** want **${g.expected}**, got **${g.got}** (highlighter scope \`${g.gotScope}\`)`);
    lines.push(`- **Fingerprint:** \`${g.id}\``);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify({
      id: g.id, language: g.language, kind: g.kind, repro: g.repro,
      tokenType: g.tokenType, tokenText: g.tokenText,
      want: g.expected, got: g.got, gotScope: g.gotScope,
    }, null, 2));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// re-exports so the ENGINE is reusable/testable without re-running the driver (gap-ledger-selftest.ts
// asserts the oracle drop-path); the driver itself only runs when this file is the entry module.
export { runLang, minimize, reproStillDiverges, sig, fingerprint, normalizeRepro, loadTm, tmTokenize, LANGS };
export type { LangCfg, Gap, Probe, LangResult };

// ── driver (only when run directly, not when imported) ──────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const WRITE = args.includes('--write');
  const CHECK = args.includes('--check');
  const only = args.find((a) => !a.startsWith('--'));
  const targets = only ? LANGS.filter((l) => l.name === only || (only === 'tsfamily' && /script/.test(l.name))) : LANGS;
  if (!targets.length) { console.error(`unknown language: ${only}`); process.exit(1); }

  const results: LangResult[] = [];
  for (const cfg of targets) { console.error(`  gap-ledger: ${cfg.name}…`); results.push(await runLang(cfg)); }

  // sort gaps deterministically: by language order (LANGS), then by fingerprint
  const langOrder = new Map(LANGS.map((l, i) => [l.name, i]));
  const allGaps = results.flatMap((r) => r.kept).sort((a, b) =>
    (langOrder.get(a.language)! - langOrder.get(b.language)!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const droppedTotal = results.reduce((a, r) => a + r.droppedOverAccept, 0);
  const md = renderMarkdown(allGaps, droppedTotal, targets.length);

  // per-language summary to stderr (not part of the artifact, so it never affects determinism)
  for (const r of results) console.error(`    ${r.name}: ${r.kept.length} kept · ${r.droppedOverAccept} dropped (over-accept) · ${r.discovered} distinct divergence(s)`);
  console.error(`  TOTAL: ${allGaps.length} gaps · ${droppedTotal} dropped over-accepts`);

  const OUT = 'docs/KNOWN-GAPS.md';
  if (CHECK) {
    const existing = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (existing !== md) { console.error(`\n${OUT} is STALE — run \`node test/gap-ledger.ts --write\`.`); process.exit(1); }
    console.error(`\n${OUT} is up to date.`);
    return;
  }
  if (WRITE) { writeFileSync(OUT, md); console.error(`\n✓ wrote ${OUT} (${allGaps.length} gaps).`); }
  else { process.stdout.write(md); }
}

if ((import.meta as any).main) await main();
