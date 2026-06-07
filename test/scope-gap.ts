// ─────────────────────────────────────────────────────────────────────────────
//  scope-gap.ts — UNIFIED "true gap" harness. Score ANY language's OFFICIAL TextMate
//  grammar AND Monogram's derived grammar against the PARSER as the neutral oracle, and
//  report the gap. Generalizes the old per-issue highlight bench: a per-language adapter supplies a
//  roleOracle (parser → per-token structural ROLE) + the two grammars; this core tokenizes
//  both with vscode-textmate, grades each oracle token's scope via the FROZEN neutral table
//  in scope-roles.ts, and reports official% vs Monogram% correctness + the gap + the
//  divergent tokens (only-Monogram-correct / only-official-correct).
//
//  Anchored on microsoft/vscode#203212: VS Code's official grammars for these languages are
//  unmaintained textmate/*.tmbundle repos; the maintained PARSER is the authority. This is
//  the comparative "true gap" — how far each grammar is from the parser — on ONE scale, for
//  ANY language with a parser-role oracle (TS via oracle.ts; YAML/HTML/… plug in their own).
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { gradeScopeStack, isCorrect, ROLE_SPEC, normScope } from './scope-roles.ts';
import type { RoleName, Verdict } from './scope-roles.ts';

// A parser-assigned token role over a span. The per-language oracle returns these (e.g.
// oracle.ts for TS/JS). Only start/end/text/role are required by the harness.
export interface GoldToken { start: number; end: number; text: string; role: RoleName }

export interface ScopeGapAdapter {
  name: string;
  scopeName: string;              // grammar scope, e.g. 'source.ts'
  officialPath: string;          // the official .tmLanguage.json (the #203212 bundle)
  monogramPath: string;          // Monogram's derived .tmLanguage.json
  // Extra sub-grammar files (scopeName → path) the official/Monogram grammar `include`s — for
  // MULTI-FILE grammars (e.g. VS Code's YAML is a dispatcher that includes source.yaml.1.2 etc.).
  officialExtra?: Record<string, string>;
  monogramExtra?: Record<string, string>;
  loadCorpus: () => { name: string; text: string }[];
  roleOracle: (text: string) => GoldToken[];   // parser → per-token role (the neutral oracle)
  isGradable?: (text: string) => boolean;       // skip inputs the oracle can't judge (default: all)
  // Grade every non-whitespace codepoint of an oracle token, not just its start offset. Needed when
  // the oracle emits COARSE spans (a multi-line YAML plain scalar, a block-scalar body) whose role
  // must hold across the whole span: a token correct at its start but wrong mid-span (a `%YAML`
  // folded into a plain scalar, a block-scalar line bailing out to a comment) is otherwise invisible.
  // Default false (start-only) — opt in only where the oracle's spans are role-HOMOGENEOUS, i.e. the
  // role applies to every char (NOT e.g. a TS template literal whose `${…}` holes are expressions).
  fullSpan?: boolean;
  // Run the DIFFERENTIAL pass: report every position where Monogram and the official grammar paint
  // DIFFERENT visual token classes (comment/string/number/keyword/name) AND the oracle has NO opinion
  // there (no non-lexical gold token covers it). These are UNADJUDICATED divergences — the metric
  // cannot say who is right, so they are flagged for human review. This is the structural fix for the
  // "oracle is silent → blind spot" failure mode: a metric that only grades where its oracle speaks
  // can never see a bug in a construct the oracle does not model; the differential pass catches the
  // disagreement regardless, so a clean run means "no Monogram-wrong AND no unexamined divergence".
  differential?: boolean;
}

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;

let wasmReady: Promise<unknown> | null = null;
function ensureWasm(): Promise<unknown> {
  if (!wasmReady) {
    const require = createRequire(import.meta.url);
    const bin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
    wasmReady = loadWASM(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  }
  return wasmReady;
}
// Load a (possibly MULTI-FILE) grammar: `files` maps every scopeName the grammar references
// (its own + any sub-grammars it `include`s, e.g. YAML's source.yaml.1.2) to a file path.
function loadGrammarSet(mainScope: string, files: Record<string, string>) {
  const cache: Record<string, string> = {};
  const reg = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (p: string[]) => new OnigScanner(p),
      createOnigString: (s: string) => new OnigString(s),
    }),
    loadGrammar: async (sn: string) => {
      const p = files[sn];
      if (!p) return null;
      const content = cache[sn] ?? (cache[sn] = readFileSync(p, 'utf-8'));
      return parseRawGrammar(content, sn + '.json');
    },
  });
  return reg.loadGrammar(mainScope);
}

// Keep the FULL scope chain (not just the innermost) so grading can be STACK-AWARE: an
// official grammar that nests a role's scope as an ancestor of a more-specific refinement
// (e.g. a YAML key's entity.name.tag under punctuation.definition.string) must be credited.
interface TmToken { start: number; end: number; scopes: string[] }
function tmTokenize(grammar: vsctm.IGrammar, text: string): TmToken[] {
  const lines = text.split('\n');
  const toks: TmToken[] = [];
  let ruleStack = INITIAL, offset = 0;
  for (const line of lines) {
    const r = grammar.tokenizeLine(line, ruleStack);
    for (const t of r.tokens) toks.push({ start: offset + t.startIndex, end: offset + t.endIndex, scopes: t.scopes });
    ruleStack = r.ruleStack; offset += line.length + 1;
  }
  return toks;
}
// full scope chain of the TM token covering `pos` (binary search; [] if none)
function scopeAt(toks: TmToken[], pos: number): string[] {
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (toks[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans >= 0 && toks[ans].end > pos ? toks[ans].scopes : [];
}
const innerOf = (s: string[]): string => (s.length ? s[s.length - 1] : '(none)');
const isWs = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
// Grade an oracle token. start-only (default) reproduces the historical single-point sampling; full
// grades every non-whitespace codepoint in [start,end) and returns the WORST verdict (first WRONG
// position wins, with its scope for reporting) — so a coarse span that is right at its start but
// wrong mid-span reads WRONG. Whitespace is skipped (continuation indent is colourless either way).
interface SpanGrade { v: Verdict; scope: string; wrongAt?: number }
function gradeSpan(role: RoleName, toks: TmToken[], start: number, end: number, text: string, full: boolean): SpanGrade {
  if (!full) { const s = scopeAt(toks, start); return { v: gradeScopeStack(role, s), scope: innerOf(s) }; }
  let worst: Verdict = 'exact';
  for (let p = start; p < end; p++) {
    if (isWs(text.charCodeAt(p))) continue;
    const s = scopeAt(toks, p);
    const v = gradeScopeStack(role, s);
    if (v === 'wrong') return { v: 'wrong', scope: innerOf(s), wrongAt: p };
    if (v === 'family' && worst === 'exact') worst = 'family';
  }
  return { v: worst, scope: innerOf(scopeAt(toks, start)) };
}

// ─── differential pass: oracle-INDEPENDENT divergence detector ───────────────────────────────────
// Map a TM scope chain to a coarse VISUAL bucket — the level at which a highlight difference is
// actually visible (a comment vs a string vs a number vs a keyword). `name` (identifiers/entities) and
// `punct`/`none` are convention noise we don't flag on their own; a divergence is only interesting if
// at least one side is a visually-distinct class. Innermost wins; scan inner→outer for the first hit.
type Bucket = 'invalid' | 'comment' | 'string' | 'number' | 'keyword' | 'name' | 'punct' | 'none';
function scopeBucket(chain: string[]): Bucket {
  for (let i = chain.length - 1; i >= 0; i--) {
    const s = normScope(chain[i]);
    if (/^invalid/.test(s)) return 'invalid';   // an error overlay (official marks errors; a highlighter may legitimately highlight-normally instead)
    if (/^comment/.test(s)) return 'comment';
    if (/^constant\.numeric/.test(s)) return 'number';
    if (/^(string|constant\.character|constant\.other\.symbol)/.test(s)) return 'string';
    if (/^(keyword|storage|constant\.language|support\.constant|variable\.language)/.test(s)) return 'keyword';
    if (/^(entity|variable|support|constant)/.test(s)) return 'name';
    if (/^punctuation/.test(s)) return 'punct';
  }
  return 'none';
}
// Visually-distinct classes whose confusion is a real (not convention-noise) difference. `invalid`
// is reported but flagged separately below — official-marks-error vs Monogram-highlights-normally is a
// design stance (cf. monogram#12 #3 "should still be highlighted normally"), not necessarily a bug.
const DISTINCT = new Set<Bucket>(['invalid', 'comment', 'string', 'number', 'keyword']);
const involvesInvalid = (a: Bucket, b: Bucket): boolean => a === 'invalid' || b === 'invalid';
// a divergence matters when the two buckets differ AND at least one is a visually-distinct class
const interestingDivergence = (a: Bucket, b: Bucket): boolean => a !== b && (DISTINCT.has(a) || DISTINCT.has(b));

export interface Divergence { pos: number; text: string; mono: string; off: string; bM: Bucket; bO: Bucket }
// Positions where the two grammars disagree visually AND no non-lexical oracle token adjudicates.
function divergences(off: TmToken[], mono: TmToken[], gold: GoldToken[], text: string): Divergence[] {
  const cov = gold.filter((g) => { const t = ROLE_SPEC[g.role]?.tier; return t && t !== 'lexical'; }).map((g) => [g.start, g.end] as const);
  const isCovered = (p: number) => cov.some(([a, b]) => p >= a && p < b);
  const positions = [...new Set([...mono.map((t) => t.start), ...off.map((t) => t.start)])].sort((a, b) => a - b);
  const out: Divergence[] = [];
  for (const pos of positions) {
    if (pos >= text.length || isWs(text.charCodeAt(pos))) continue;
    if (isCovered(pos)) continue;                       // oracle already has an opinion here → graded above
    const cm = scopeAt(mono, pos), co = scopeAt(off, pos);
    const bM = scopeBucket(cm), bO = scopeBucket(co);
    if (!interestingDivergence(bM, bO)) continue;
    out.push({ pos, text: text.slice(pos, pos + 12), mono: innerOf(cm), off: innerOf(co), bM, bO });
  }
  return out;
}

export async function run(adapter: ScopeGapAdapter): Promise<void> {
  if (!existsSync(adapter.officialPath)) { console.error(`Official grammar not found:\n  ${adapter.officialPath}`); process.exit(1); }
  if (!existsSync(adapter.monogramPath)) { console.error(`Monogram grammar not found: ${adapter.monogramPath} (run: node src/cli.ts ${adapter.name}.ts)`); process.exit(1); }
  await ensureWasm();
  const official = await loadGrammarSet(adapter.scopeName, { [adapter.scopeName]: adapter.officialPath, ...(adapter.officialExtra ?? {}) });
  const monogram = await loadGrammarSet(adapter.scopeName, { [adapter.scopeName]: adapter.monogramPath, ...(adapter.monogramExtra ?? {}) });
  if (!official || !monogram) throw new Error('failed to load a grammar');

  const corpus = adapter.loadCorpus();
  const gradable = adapter.isGradable ?? (() => true);
  const fullSpan = adapter.fullSpan ?? false;

  let nFiles = 0;
  const tally = { oCorrect: 0, oExact: 0, mCorrect: 0, mExact: 0, total: 0 };
  const perRole = new Map<RoleName, { n: number; oC: number; mC: number }>();
  const onlyMono: { text: string; role: RoleName; o: string; m: string }[] = [];
  const onlyOff: { text: string; role: RoleName; o: string; m: string }[] = [];
  // per-snippet: did the grammar get EVERY graded token right in this input?
  const snip = { o: 0, m: 0, n: 0 };

  for (const { text } of corpus) {
    if (!gradable(text)) continue;
    let gold: GoldToken[], tmO: TmToken[], tmM: TmToken[];
    try { gold = adapter.roleOracle(text); tmO = tmTokenize(official, text); tmM = tmTokenize(monogram, text); } catch { continue; }
    nFiles++;
    let okO = true, okM = true, gradedHere = 0;
    for (const t of gold) {
      const tier = ROLE_SPEC[t.role]?.tier;
      if (!tier || tier === 'lexical') continue;   // lexical floor: excluded from the headline
      const go = gradeSpan(t.role, tmO, t.start, t.end, text, fullSpan);   // full scope CHAINS
      const gm = gradeSpan(t.role, tmM, t.start, t.end, text, fullSpan);
      const vo = go.v, vm = gm.v;
      const oc = isCorrect(vo), mc = isCorrect(vm);
      tally.total++; gradedHere++;
      if (oc) tally.oCorrect++; if (vo === 'exact') tally.oExact++;
      if (mc) tally.mCorrect++; if (vm === 'exact') tally.mExact++;
      const pr = perRole.get(t.role) ?? { n: 0, oC: 0, mC: 0 }; pr.n++; if (oc) pr.oC++; if (mc) pr.mC++; perRole.set(t.role, pr);
      if (!oc) okO = false; if (!mc) okM = false;
      if (mc && !oc && onlyMono.length < 40) onlyMono.push({ text: t.text, role: t.role, o: go.scope, m: gm.scope });
      if (oc && !mc && onlyOff.length < 40) onlyOff.push({ text: t.text, role: t.role, o: go.scope, m: gm.scope });
    }
    if (gradedHere) { snip.n++; if (okO) snip.o++; if (okM) snip.m++; }
  }

  const pct = (n: number, d = tally.total) => (d ? (100 * n / d).toFixed(1) : 'n/a');
  const gap = tally.total ? (100 * (tally.mCorrect - tally.oCorrect) / tally.total).toFixed(1) : 'n/a';
  console.log('='.repeat(78));
  console.log(`  Scope-gap vs the PARSER oracle — ${adapter.name}  (vscode#203212)`);
  console.log(`  official: ${adapter.officialPath.replace(/^.*\//, '')}    monogram: ${adapter.monogramPath}`);
  console.log('='.repeat(78));
  console.log(`  ${nFiles} files · ${tally.total} graded tokens (lexical-floor roles excluded)`);
  console.log(`  OFFICIAL  correct ${pct(tally.oCorrect)}%  (exact ${pct(tally.oExact)}%)`);
  console.log(`  MONOGRAM  correct ${pct(tally.mCorrect)}%  (exact ${pct(tally.mExact)}%)`);
  console.log(`  ══ GAP (Monogram − official) = ${gap} pts ══`);
  console.log(`  per-snippet all-tokens-correct: official ${pct(snip.o, snip.n)}%  monogram ${pct(snip.m, snip.n)}%  (n=${snip.n})`);

  const rows = [...perRole.entries()]
    .map(([role, r]) => ({ role, n: r.n, o: r.oC, m: r.mC, d: r.mC - r.oC }))
    .filter((r) => r.o !== r.m).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  if (rows.length) {
    console.log(`\n  per-role differences (correct official→monogram / occurrences):`);
    for (const r of rows.slice(0, 15)) console.log(`    ${r.role.padEnd(16)} ${String(r.o).padStart(6)} →${String(r.m).padStart(6)} / ${r.n}   ${r.d > 0 ? '+' : ''}${r.d}`);
  }
  console.log(`\n  only-Monogram-correct tokens (official wrong vs the parser) — ${onlyMono.length} shown:`);
  for (const x of onlyMono.slice(0, 12)) console.log(`    «${x.text.slice(0, 18)}» ${x.role}: official «${x.o}» → monogram «${x.m}»`);
  if (onlyOff.length) {
    console.log(`\n  only-official-correct tokens (Monogram wrong) — ${onlyOff.length} shown:`);
    for (const x of onlyOff.slice(0, 12)) console.log(`    «${x.text.slice(0, 18)}» ${x.role}: official «${x.o}» → monogram «${x.m}»`);
  }

  // ── DIFFERENTIAL pass: oracle-INDEPENDENT divergences (the blind-spot net) ───────────────────────
  let divTotal = 0;
  if (adapter.differential) {
    const all: Divergence[] = [];
    let divFiles = 0;
    for (const { text } of corpus) {   // ALL inputs, incl. ones the oracle/grader skip
      let gold: GoldToken[], tmO: TmToken[], tmM: TmToken[];
      try { gold = adapter.roleOracle(text); tmO = tmTokenize(official, text); tmM = tmTokenize(monogram, text); } catch { continue; }
      const ds = divergences(tmO, tmM, gold, text);
      if (ds.length) divFiles++;
      all.push(...ds);
    }
    divTotal = all.length;
    const genuine = all.filter((d) => !involvesInvalid(d.bM, d.bO));   // real class confusion (not error-overlay)
    const overlay = divTotal - genuine.length;                         // official-marks-error vs Monogram-normal
    const byPair = new Map<string, { n: number; sample: Divergence }>();
    for (const d of all) { const k = `${d.bM}≠${d.bO}`; const e = byPair.get(k); if (e) e.n++; else byPair.set(k, { n: 1, sample: d }); }
    console.log(`\n  ── DIFFERENTIAL (oracle-independent) — UNADJUDICATED divergences over ${divFiles} files ──`);
    console.log(`     positions where Monogram and official paint different VISUAL classes and the oracle is`);
    console.log(`     silent → the metric cannot adjudicate; each is a candidate bug for human review.`);
    console.log(`     ${genuine.length} genuine class-confusion  +  ${overlay} error-overlay (official invalid.illegal vs Monogram highlight-normally)`);
    for (const [k, e] of [...byPair.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
      const s = e.sample;
      console.log(`     ${k.padEnd(18)} ×${String(e.n).padStart(4)}   e.g. «${s.text.replace(/\n/g, '\\n')}» mono«${s.mono}» off«${s.off}»`);
    }
  }

  // Machine-readable summary for the README coverage-table generator (test/coverage-table.ts).
  console.log('##SCOPEGAP## ' + JSON.stringify({
    name: adapter.name, official: adapter.officialPath.replace(/^.*\//, ''), tokens: tally.total,
    officialPct: tally.total ? (100 * tally.oCorrect) / tally.total : null,
    monogramPct: tally.total ? (100 * tally.mCorrect) / tally.total : null,
    monogramWrong: onlyOff.length, unadjudicated: divTotal,
  }));
  console.log('\nDone.');
}
