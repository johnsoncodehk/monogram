// ─────────────────────────────────────────────────────────────────────────────
//  scope-gap.ts — UNIFIED "true gap" harness. Score ANY language's OFFICIAL TextMate
//  grammar AND Monogram's derived grammar against the PARSER as the neutral oracle, and
//  report the gap. Generalizes highlight-bench.ts: a per-language adapter supplies a
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
import { gradeScope, isCorrect, ROLE_SPEC } from './scope-roles.ts';
import type { RoleName } from './scope-roles.ts';

// A parser-assigned token role over a span. The per-language oracle returns these (e.g.
// oracle.ts for TS/JS). Only start/end/text/role are required by the harness.
export interface GoldToken { start: number; end: number; text: string; role: RoleName }

export interface ScopeGapAdapter {
  name: string;
  scopeName: string;              // grammar scope, e.g. 'source.ts'
  officialPath: string;          // the official .tmLanguage.json (the #203212 bundle)
  monogramPath: string;          // Monogram's derived .tmLanguage.json
  loadCorpus: () => { name: string; text: string }[];
  roleOracle: (text: string) => GoldToken[];   // parser → per-token role (the neutral oracle)
  isGradable?: (text: string) => boolean;       // skip inputs the oracle can't judge (default: all)
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
function loadGrammar(scopeName: string, path: string) {
  const content = readFileSync(path, 'utf-8');
  const reg = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (p: string[]) => new OnigScanner(p),
      createOnigString: (s: string) => new OnigString(s),
    }),
    loadGrammar: async (sn: string) => (sn === scopeName ? parseRawGrammar(content, 'g.json') : null),
  });
  return reg.loadGrammar(scopeName);
}

interface TmToken { start: number; end: number; scope: string }
function tmTokenize(grammar: vsctm.IGrammar, text: string): TmToken[] {
  const lines = text.split('\n');
  const toks: TmToken[] = [];
  let ruleStack = INITIAL, offset = 0;
  for (const line of lines) {
    const r = grammar.tokenizeLine(line, ruleStack);
    for (const t of r.tokens) toks.push({ start: offset + t.startIndex, end: offset + t.endIndex, scope: t.scopes[t.scopes.length - 1] });
    ruleStack = r.ruleStack; offset += line.length + 1;
  }
  return toks;
}
// deepest scope of the TM token covering `pos` (binary search; '' if none)
function scopeAt(toks: TmToken[], pos: number): string {
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (toks[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans >= 0 && toks[ans].end > pos ? toks[ans].scope : '';
}

export async function run(adapter: ScopeGapAdapter): Promise<void> {
  if (!existsSync(adapter.officialPath)) { console.error(`Official grammar not found:\n  ${adapter.officialPath}`); process.exit(1); }
  if (!existsSync(adapter.monogramPath)) { console.error(`Monogram grammar not found: ${adapter.monogramPath} (run: node src/cli.ts ${adapter.name}.ts)`); process.exit(1); }
  await ensureWasm();
  const official = await loadGrammar(adapter.scopeName, adapter.officialPath);
  const monogram = await loadGrammar(adapter.scopeName, adapter.monogramPath);
  if (!official || !monogram) throw new Error('failed to load a grammar');

  const corpus = adapter.loadCorpus();
  const gradable = adapter.isGradable ?? (() => true);

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
      const so = scopeAt(tmO, t.start), sm = scopeAt(tmM, t.start);
      const oc = isCorrect(gradeScope(t.role, so)), mc = isCorrect(gradeScope(t.role, sm));
      tally.total++; gradedHere++;
      if (oc) tally.oCorrect++; if (gradeScope(t.role, so) === 'exact') tally.oExact++;
      if (mc) tally.mCorrect++; if (gradeScope(t.role, sm) === 'exact') tally.mExact++;
      const pr = perRole.get(t.role) ?? { n: 0, oC: 0, mC: 0 }; pr.n++; if (oc) pr.oC++; if (mc) pr.mC++; perRole.set(t.role, pr);
      if (!oc) okO = false; if (!mc) okM = false;
      if (mc && !oc && onlyMono.length < 40) onlyMono.push({ text: t.text, role: t.role, o: so || '(none)', m: sm || '(none)' });
      if (oc && !mc && onlyOff.length < 40) onlyOff.push({ text: t.text, role: t.role, o: so || '(none)', m: sm || '(none)' });
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
  console.log('\nDone.');
}
