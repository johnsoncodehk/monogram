// ─────────────────────────────────────────────────────────────────────────────
//  highlight-bench.ts — absolute syntactic-highlighting correctness, both ways.
//
//  Measures, for the OFFICIAL TextMate grammar and for MONOGRAM's generated one,
//  what fraction of the language's distinct highlighting decisions each renders
//  correctly — graded against a neutral tsc-derived oracle, ceiling 100%.
//
//  Design (see the conversation that produced it):
//   • Oracle  = tsc parser only (createSourceFile + token walk). NEVER Monogram's
//               CST, never the official grammar. tsc is the independent third party.
//   • Grading = role granularity via the frozen neutral table in scope-roles.ts.
//   • Two corpora, each answering a different question:
//       – parser conformance (/tmp/ts-repo .../parser): breadth. Denominator =
//         distinct CELLS (role,context), so corpus redundancy can't inflate ("灌水").
//       – adversarial bug ledger (test/issue-cases.ts): the documented official-grammar
//         issues, graded PER ISSUE — the denominator the bug tracker itself defines.
//   • Reports: per-issue handled %, verified Monogram fixes (official wrong / Mono
//     right), per-snippet, per-cell, token accuracy, and a self-audit of every miss.
//
//  Run:
//    node test/highlight-bench.ts                       # both corpora
//    node test/highlight-bench.ts --corpus adversarial  # documented bug ledger only
//    node test/highlight-bench.ts --write-readme        # regenerate the README block
//    node test/highlight-bench.ts --debug 'typeof x < y'  # audit one snippet
//    node test/highlight-bench.ts --gran role|parent|parent2   # context-granularity knob
//
//  Official grammar path override:  MONOGRAM_OFFICIAL_TM=/path/to/TypeScript.tmLanguage.json
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { R, ROLE_SPEC, gradeScope, isCorrect, normScope, roleFamily, acceptableFamilies } from './scope-roles.ts';
import type { RoleName, Verdict, Family } from './scope-roles.ts';
import { tests as issueTests, multiLineTests as issueMultiLine } from './issue-cases.ts';
import { scopeFamily, treesitterFamilies, loadTreeSitter, familyAt, loadMonogramTreeSitter, monogramTreesitterFamilies } from './highlight-engines.ts';
import type { Span } from './highlight-engines.ts';
import { oracle, type GoldToken } from './oracle.ts';
import { JS_CORPUS } from './js-corpus.ts';
import { JSX_CORPUS } from './tsx-corpus.ts';

const normScopeShort = (s: string): string => (s ? normScope(s) : '(none)');

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getFlag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIMIT = getFlag('--limit') ? parseInt(getFlag('--limit')!, 10) : Infinity;
const GRAN = (getFlag('--gran') ?? 'parent') as 'role' | 'parent' | 'parent2';
const DEBUG_CODE = getFlag('--debug');

const PARSER_DIR = '/tmp/ts-repo/tests/cases/conformance/parser';
const OFFICIAL_PATH =
  process.env.MONOGRAM_OFFICIAL_TM ??
  '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json';
const MONOGRAM_PATH = 'examples/typescript.tmLanguage.json';
// JavaScript grammars — only used to fill the README per-language table's JS row.
const OFFICIAL_JS_PATH =
  process.env.MONOGRAM_OFFICIAL_JS_TM ??
  '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/javascript/syntaxes/JavaScript.tmLanguage.json';
const MONOGRAM_JS_PATH = 'examples/javascript.tmLanguage.json';
// TSX grammars — for the README's JSX-dialect agreement line (no neutral oracle exists).
const OFFICIAL_TSX_PATH =
  process.env.MONOGRAM_OFFICIAL_TSX ??
  '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/typescript-basics/syntaxes/TypeScriptReact.tmLanguage.json';
const MONOGRAM_TSX_PATH = 'examples/tsx.tmLanguage.json';

// ── TextMate grammar loading (vscode-textmate + oniguruma) ───────────────────
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

function makeRegistry(scopeName: string, content: string): vsctm.Registry {
  return new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
      createOnigString: (s: string) => new OnigString(s),
    }),
    loadGrammar: async (sn: string) => (sn === scopeName ? parseRawGrammar(content, 'g.json') : null),
  });
}

if (!existsSync(OFFICIAL_PATH)) {
  console.error(`Official grammar not found at:\n  ${OFFICIAL_PATH}\nSet MONOGRAM_OFFICIAL_TM=/path/to/TypeScript.tmLanguage.json`);
  process.exit(1);
}
if (!existsSync(MONOGRAM_PATH)) {
  console.error(`Monogram grammar not found at ${MONOGRAM_PATH}. Run: node src/cli.ts examples/typescript.ts`);
  process.exit(1);
}

const officialGrammar = await makeRegistry('source.ts', readFileSync(OFFICIAL_PATH, 'utf-8')).loadGrammar('source.ts');
const monogramGrammar = await makeRegistry('source.ts', readFileSync(MONOGRAM_PATH, 'utf-8')).loadGrammar('source.ts');
if (!officialGrammar || !monogramGrammar) throw new Error('failed to load a grammar');

// JS grammars are optional (README JS row): load if both are present, else skip the row.
const jsMonogramGrammar = existsSync(MONOGRAM_JS_PATH)
  ? await makeRegistry('source.js', readFileSync(MONOGRAM_JS_PATH, 'utf-8')).loadGrammar('source.js') : null;
const jsOfficialGrammar = existsSync(OFFICIAL_JS_PATH)
  ? await makeRegistry('source.js', readFileSync(OFFICIAL_JS_PATH, 'utf-8')).loadGrammar('source.js') : null;
// TSX grammars are optional (README JSX-dialect agreement line).
const tsxMonogramGrammar = existsSync(MONOGRAM_TSX_PATH)
  ? await makeRegistry('source.tsx', readFileSync(MONOGRAM_TSX_PATH, 'utf-8')).loadGrammar('source.tsx') : null;
const tsxOfficialGrammar = existsSync(OFFICIAL_TSX_PATH)
  ? await makeRegistry('source.tsx', readFileSync(OFFICIAL_TSX_PATH, 'utf-8')).loadGrammar('source.tsx') : null;

const GRAMMARS: { key: 'official' | 'monogram'; g: vsctm.IGrammar }[] = [
  { key: 'official', g: officialGrammar },
  { key: 'monogram', g: monogramGrammar },
];

// ── the ORACLE: tsc → per-token (span, role) ──────────────────────────────────
// ── TextMate tokenization → tokens with absolute offsets ──────────────────────
interface TmToken { start: number; end: number; scope: string; }

function tmTokenize(grammar: vsctm.IGrammar, text: string): TmToken[] {
  const lines = text.split('\n');
  const toks: TmToken[] = [];
  let ruleStack = INITIAL;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const r = grammar.tokenizeLine(line, ruleStack);
    for (const t of r.tokens) {
      toks.push({
        start: offset + t.startIndex,
        end: offset + t.endIndex,
        scope: t.scopes[t.scopes.length - 1],
      });
    }
    ruleStack = r.ruleStack;
    offset += line.length + 1; // + '\n'
  }
  return toks;
}

// scope of the TM token covering offset `pos` (binary search; '' if none)
function scopeAt(toks: TmToken[], pos: number): string {
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans >= 0 && toks[ans].end > pos) return toks[ans].scope;
  return '';
}

// ── cell key (the context-granularity knob) ───────────────────────────────────
function cellKey(t: GoldToken): string {
  if (t.cat !== 'id') return `${t.role}`; // literals/keywords/punct: context doesn't move the scope
  if (GRAN === 'role') return `${t.role}`;
  if (GRAN === 'parent2') return `${t.role}@${t.parentKind}>${t.grandKind}`;
  return `${t.role}@${t.parentKind}`;
}

// ─── debug mode: dump alignment for one snippet, then exit ─────────────────────
if (DEBUG_CODE) {
  const gold = oracle(DEBUG_CODE);
  const tmO = tmTokenize(officialGrammar, DEBUG_CODE);
  const tmM = tmTokenize(monogramGrammar, DEBUG_CODE);
  console.log(`\nDEBUG  «${DEBUG_CODE}»   gran=${GRAN}\n`);
  console.log('token'.padEnd(14) + 'role'.padEnd(16) + 'cell'.padEnd(30) + 'official'.padEnd(26) + 'monogram');
  console.log('─'.repeat(120));
  for (const t of gold) {
    if (t.role === R.punct || t.role === R.op) continue;
    const so = scopeAt(tmO, t.start), sm = scopeAt(tmM, t.start);
    const vo = gradeScope(t.role, so), vm = gradeScope(t.role, sm);
    const mark = (v: Verdict) => (v === 'exact' ? '✓' : v === 'family' ? '≈' : '✗');
    console.log(
      JSON.stringify(t.text).slice(0, 13).padEnd(14) +
      t.role.padEnd(16) + cellKey(t).padEnd(30) +
      `${mark(vo)} ${so || '(none)'}`.padEnd(26) + `${mark(vm)} ${sm || '(none)'}`,
    );
  }
  process.exit(0);
}

// ── shared types + scoring helpers ────────────────────────────────────────────
type G = 'official' | 'monogram';
interface Cell {
  role: RoleName;
  tier: 'strict' | 'lenient';
  key: string;
  occ: number;
  files: Set<number>;
  correct: { official: number; monogram: number };
  exact: { official: number; monogram: number };
  example: { text: string; official: string; monogram: string };
}
interface Miss { n: number; ex: string; role: RoleName }

const cellCorrect = (c: Cell, g: G) => c.correct[g] * 2 >= c.occ; // majority of occurrences
const cellExact = (c: Cell, g: G) => c.exact[g] * 2 >= c.occ;
const count = (list: Cell[], pred: (c: Cell) => boolean) => list.filter(pred).length;
const pct = (n: number, d: number) => (d === 0 ? '  n/a' : ((n / d) * 100).toFixed(1).padStart(5));
const L = '═'.repeat(74);

// ── grade a list of {name,text} inputs, print its report, return per-input pass ─
interface InputResult { name: string; okO: boolean; okM: boolean; graded: number }
interface BenchSummary {
  label: string; nFiles: number;
  snip: { o: number; m: number; n: number };
  strict: { n: number; oRole: number; mRole: number; oExact: number; mExact: number };
  token: { n: number; oRole: number; oExact: number; mRole: number; mExact: number };
}
function runBench(label: string, corpusDesc: string, inputs: { name: string; text: string }[]): { perInput: InputResult[]; summary: BenchSummary } {
  const perInput: InputResult[] = [];
  const cells = new Map<string, Cell>();
  const seenRoles = new Set<string>();
  const misses: Record<G, Map<string, Miss>> = { official: new Map(), monogram: new Map() };
  let nFiles = 0, nSkippedInvalid = 0, nSkippedMulti = 0, nErrored = 0;
  const tokAcc: Record<G, { correct: number; exact: number; total: number }> = {
    official: { correct: 0, exact: 0, total: 0 },
    monogram: { correct: 0, exact: 0, total: 0 },
  };
  // per-snippet pass: did the grammar get EVERY graded token's role right in this
  // input? The right metric for a curated probe set (each snippet = one bug pattern),
  // where cell-majority would let easy uses outvote the one token under test.
  const snipPass: Record<G, number> = { official: 0, monogram: 0 };

  for (let fi = 0; fi < inputs.length; fi++) {
    const text = inputs[fi].text;
    if (/^\s*\/\/\s*@filename:/im.test(text)) { nSkippedMulti++; continue; } // multi-file concat
    const sf = ts.createSourceFile('c.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (((sf as any).parseDiagnostics?.length ?? 0) > 0) { nSkippedInvalid++; continue; } // invalid → not gradable

    let gold: GoldToken[], tmO: TmToken[], tmM: TmToken[];
    try {
      gold = oracle(text);
      tmO = tmTokenize(officialGrammar, text);
      tmM = tmTokenize(monogramGrammar, text);
    } catch { nErrored++; continue; }
    nFiles++;
    const ok: Record<G, boolean> = { official: true, monogram: true };
    let gradedHere = 0;

    for (const t of gold) {
      seenRoles.add(t.role);
      const tier = ROLE_SPEC[t.role].tier;
      if (tier === 'lexical') continue; // lexical floor: excluded from every headline
      gradedHere++;

      const so = scopeAt(tmO, t.start);
      const sm = scopeAt(tmM, t.start);
      const vo = gradeScope(t.role, so);
      const vm = gradeScope(t.role, sm);

      const rec = (g: G, v: Verdict, scope: string) => {
        tokAcc[g].total++;
        if (isCorrect(v)) tokAcc[g].correct++;
        else {
          ok[g] = false;
          const k = `${t.role} → ${normScopeShort(scope)}`;
          const m = misses[g].get(k) ?? { n: 0, ex: t.text, role: t.role };
          m.n++; misses[g].set(k, m);
        }
        if (v === 'exact') tokAcc[g].exact++;
      };
      rec('official', vo, so);
      rec('monogram', vm, sm);

      const key = cellKey(t);
      let c = cells.get(key);
      if (!c) {
        c = { role: t.role, tier, key, occ: 0, files: new Set(), correct: { official: 0, monogram: 0 }, exact: { official: 0, monogram: 0 }, example: { text: t.text, official: so, monogram: sm } };
        cells.set(key, c);
      }
      c.occ++;
      c.files.add(fi);
      if (isCorrect(vo)) c.correct.official++;
      if (isCorrect(vm)) c.correct.monogram++;
      if (vo === 'exact') c.exact.official++;
      if (vm === 'exact') c.exact.monogram++;
    }
    if (ok.official) snipPass.official++;
    if (ok.monogram) snipPass.monogram++;
    perInput.push({ name: inputs[fi].name, okO: ok.official, okM: ok.monogram, graded: gradedHere });
  }

  const cellList = [...cells.values()];
  const strictCells = cellList.filter((c) => c.tier === 'strict');
  const lenientCells = cellList.filter((c) => c.tier === 'lenient');
  const Sn = strictCells.length, Ln = lenientCells.length;

  console.log('\n' + L);
  console.log(`  Highlight Correctness Bench — ${label}`);
  console.log(L);
  console.log(`  corpus     ${corpusDesc}  ·  granularity = ${GRAN}`);
  console.log(`  inputs     ${nFiles} graded · ${nSkippedInvalid} invalid-skipped · ${nSkippedMulti} multifile-skipped · ${nErrored} errored`);
  console.log(`  cells      ${Sn} strict (graded) · ${Ln} lenient (contested) · ${cellList.length} total · ${tokAcc.official.total} tokens`);
  console.log(L);
  console.log('  Per-SNIPPET — input fully role-correct (every probe right; best for curated sets)');
  for (const g of ['official', 'monogram'] as const) {
    console.log(`    ${g.padEnd(14)}    ${pct(snipPass[g], nFiles)}%  (${snipPass[g]}/${nFiles})`);
  }
  console.log('');
  console.log('  Per-CELL — strict cells (one defensible answer each), frequency-neutral');
  console.log('                       role-correct          exact-scope');
  for (const g of ['official', 'monogram'] as const) {
    const cc = count(strictCells, (c) => cellCorrect(c, g));
    const ce = count(strictCells, (c) => cellExact(c, g));
    console.log(`    ${g.padEnd(14)}    ${pct(cc, Sn)}%  (${cc}/${Sn})        ${pct(ce, Sn)}%  (${ce}/${Sn})`);
  }
  console.log('');
  console.log('  Lenient cells (contested role; a fail = painted as the WRONG kind entirely)');
  for (const g of ['official', 'monogram'] as const) {
    const cc = count(lenientCells, (c) => cellCorrect(c, g));
    console.log(`    ${g.padEnd(14)}    ${pct(cc, Ln)}%  (${cc}/${Ln})`);
  }
  console.log('');
  console.log('  Secondary — every graded token (frequency-weighted, real-world feel)');
  for (const g of ['official', 'monogram'] as const) {
    const ta = tokAcc[g];
    console.log(`    ${g.padEnd(14)}    role ${pct(ta.correct, ta.total)}%   exact ${pct(ta.exact, ta.total)}%`);
  }
  console.log(L);

  // per-role cell coverage (tier-marked)
  const roleNames = [...new Set(cellList.map((c) => c.role))].sort();
  console.log('\n── per-role CELL coverage (role-correct) ──');
  console.log('  role'.padEnd(22) + 'tier'.padEnd(9) + 'cells'.padStart(6) + 'official'.padStart(11) + 'monogram'.padStart(11));
  for (const role of roleNames) {
    const rc = cellList.filter((c) => c.role === role);
    const o = count(rc, (c) => cellCorrect(c, 'official'));
    const m = count(rc, (c) => cellCorrect(c, 'monogram'));
    console.log(`  ${role.padEnd(20)}${ROLE_SPEC[role].tier.padEnd(9)}${String(rc.length).padStart(6)}${`${o}/${rc.length}`.padStart(11)}${`${m}/${rc.length}`.padStart(11)}`);
  }

  // disagreements (strict + lenient): the deltas that matter
  const disagree = cellList
    .filter((c) => cellCorrect(c, 'official') !== cellCorrect(c, 'monogram'))
    .sort((a, b) => b.occ - a.occ);
  console.log(`\n── cells where the grammars DISAGREE (${disagree.length}) ──`);
  for (const c of disagree.slice(0, 22)) {
    const winner = cellCorrect(c, 'monogram') ? '+monogram' : '+official';
    console.log(`  ${winner} ${c.key}`.padEnd(50) + `occ=${c.occ}`.padStart(8) +
      `  «${c.example.text}» off=${normScopeShort(c.example.official)} mono=${normScopeShort(c.example.monogram)}`);
  }

  // SELF-AUDIT: where each grammar loses — read these before trusting the %.
  for (const g of ['official', 'monogram'] as const) {
    const top = [...misses[g].entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
    const totalMiss = [...misses[g].values()].reduce((s, m) => s + m.n, 0);
    console.log(`\n── ${g} role-level MISSES (${totalMiss} tokens, top ${top.length}) ──`);
    for (const [k, m] of top) console.log(`  ${String(m.n).padStart(5)}×  ${k.padEnd(46)} e.g. «${m.ex}»`);
  }

  // blind spots: roles never exercised by this corpus
  const allRoles = Object.keys(ROLE_SPEC).filter((r) => ROLE_SPEC[r as RoleName].tier !== 'lexical');
  const unseen = allRoles.filter((r) => !seenRoles.has(r));
  console.log('\n── blind spots (roles with 0 graded tokens here) ──');
  console.log(unseen.length ? '  ' + unseen.join(', ') : '  none — every role exercised');
  console.log(L + '\n');

  const summary: BenchSummary = {
    label, nFiles,
    snip: { o: snipPass.official, m: snipPass.monogram, n: nFiles },
    strict: {
      n: Sn,
      oRole: count(strictCells, (c) => cellCorrect(c, 'official')),
      mRole: count(strictCells, (c) => cellCorrect(c, 'monogram')),
      oExact: count(strictCells, (c) => cellExact(c, 'official')),
      mExact: count(strictCells, (c) => cellExact(c, 'monogram')),
    },
    token: {
      n: tokAcc.official.total,
      oRole: tokAcc.official.correct, oExact: tokAcc.official.exact,
      mRole: tokAcc.monogram.correct, mExact: tokAcc.monogram.exact,
    },
  };
  return { perInput, summary };
}

// ── aggregate per-input results by documented ISSUE (the denominator the bug
// ledger defines): an issue "handled" iff every one of its cases is role-correct.
interface IssueStats { total: number; adj: number; offPass: number; monoPass: number; fixes: string[]; regress: string[]; bothFail: string[] }
function reportByIssue(perInput: InputResult[]): IssueStats {
  const issueOf = (name: string): string | null => (name.match(/#(\d+)/)?.[1] ?? null);
  const byIssue = new Map<string, { okO: boolean; okM: boolean; graded: number; ex: string }>();
  for (const r of perInput) {
    const k = issueOf(r.name);
    if (!k) continue;
    const e = byIssue.get(k) ?? { okO: true, okM: true, graded: 0, ex: r.name };
    e.okO = e.okO && r.okO;
    e.okM = e.okM && r.okM;
    e.graded += r.graded;
    byIssue.set(k, e);
  }
  const all = [...byIssue.entries()];
  // only issues the neutral oracle can actually adjudicate (have role-graded tokens)
  const adj = all.filter(([, e]) => e.graded > 0);
  const D = adj.length;
  const offPass = adj.filter(([, e]) => e.okO).length;
  const monoPass = adj.filter(([, e]) => e.okM).length;
  const byNum = (a: string, b: string) => +a - +b;
  const fixes = adj.filter(([, e]) => !e.okO && e.okM).map(([k]) => k).sort(byNum);
  const regress = adj.filter(([, e]) => e.okO && !e.okM).map(([k]) => k).sort(byNum);
  const bothFail = adj.filter(([, e]) => !e.okO && !e.okM).map(([k]) => k).sort(byNum);

  console.log('\n' + L);
  console.log('  PER-ISSUE — documented bugs as the denominator (neutral tsc oracle)');
  console.log(L);
  console.log(`  ${all.length} documented issues · ${D} oracle-adjudicable (rest hinge on exact-scope`);
  console.log(`  or lexical tokens the syntactic oracle does not judge)`);
  console.log(`    official handles    ${pct(offPass, D)}%  (${offPass}/${D})`);
  console.log(`    monogram handles    ${pct(monoPass, D)}%  (${monoPass}/${D})`);
  console.log('');
  console.log(`  Verified Monogram fixes — official WRONG, Monogram right (${fixes.length}):`);
  console.log(`    ${fixes.length ? '#' + fixes.join(' #') : '(none)'}`);
  console.log(`  Monogram worse than official (${regress.length}): ${regress.length ? '#' + regress.join(' #') : '(none)'}`);
  console.log(`  Both wrong (${bothFail.length}): ${bothFail.length ? '#' + bothFail.join(' #') : '(none)'}`);
  console.log(L + '\n');
  return { total: all.length, adj: D, offPass, monoPass, fixes, regress, bothFail };
}

// ── README auto-generation: per-language token-FAMILY accuracy table ───────────
// Monogram's DERIVED TextMate highlighter vs each ecosystem's official hand-written
// grammar, all graded at the FAMILY level against the same tsc oracle. See
// highlight-engines.ts (TS engine list) / familyAccuracy (per-grammar grading).
interface EngineScore { name: string; correct: number; total: number }

const tmSpans = (grammar: vsctm.IGrammar, text: string): Span[] =>
  tmTokenize(grammar, text).map((t) => ({ start: t.start, end: t.end, family: scopeFamily(t.scope) }));

// Grade each engine's token-FAMILY classification against the tsc oracle over `inputs`.
// mtsOk = Monogram's own compiled tree-sitter is available (opt-in via MONOGRAM_TS_WASM;
// kept OUT of the auto-chart since CI can't build that wasm — surfaced only by --engines).
async function engineFamilyScores(inputs: { name: string; text: string }[], tsOk: boolean, mtsOk = false): Promise<EngineScore[]> {
  const engines: { name: string; spans: (t: string) => Span[] }[] = [
    { name: 'Monogram (TextMate, derived)', spans: (t) => tmSpans(monogramGrammar, t) },
    { name: 'official TextMate', spans: (t) => tmSpans(officialGrammar, t) },
  ];
  if (tsOk) engines.splice(2, 0, { name: 'official tree-sitter', spans: treesitterFamilies });
  if (mtsOk) engines.push({ name: 'Monogram (tree-sitter, derived)', spans: monogramTreesitterFamilies });

  const acc: Record<string, { correct: number; total: number }> = {};
  for (const e of engines) acc[e.name] = { correct: 0, total: 0 };

  for (const inp of inputs) {
    const sf = ts.createSourceFile('c.ts', inp.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (((sf as any).parseDiagnostics?.length ?? 0) > 0) continue; // grade only valid inputs
    let gold: GoldToken[];
    try { gold = oracle(inp.text); } catch { continue; }
    const per = engines.map((e) => { try { return { name: e.name, spans: e.spans(inp.text) }; } catch { return { name: e.name, spans: [] as Span[] }; } });
    for (const g of gold) {
      if (ROLE_SPEC[g.role].tier === 'lexical' || roleFamily(g.role) === 'punct') continue;
      const ok = acceptableFamilies(g.role);
      for (const pe of per) {
        acc[pe.name].total++;
        const fam = familyAt(pe.spans, g.start);
        if (fam && ok.has(fam)) acc[pe.name].correct++;
      }
    }
  }
  return engines.map((e) => ({ name: e.name, ...acc[e.name] }));
}

// Grade ONE TextMate grammar's token-FAMILY classification against the tsc oracle
// over `texts` (parsed in `scriptKind` mode) → {correct, total}. The same metric as
// engineFamilyScores, factored out so the README table can grade JavaScript too.
function familyAccuracy(grammar: vsctm.IGrammar, texts: string[], scriptKind: ts.ScriptKind): { correct: number; total: number } {
  let correct = 0, total = 0;
  for (const text of texts) {
    const sf = ts.createSourceFile(scriptKind === ts.ScriptKind.JS ? 'c.js' : 'c.ts', text, ts.ScriptTarget.Latest, true, scriptKind);
    if (((sf as any).parseDiagnostics?.length ?? 0) > 0) continue; // grade only valid inputs
    let gold: GoldToken[];
    try { gold = oracle(text, scriptKind); } catch { continue; }
    const spans = tmSpans(grammar, text);
    for (const g of gold) {
      if (ROLE_SPEC[g.role].tier === 'lexical' || roleFamily(g.role) === 'punct') continue;
      total++;
      const fam = familyAt(spans, g.start);
      if (fam && acceptableFamilies(g.role).has(fam)) correct++;
    }
  }
  return { correct, total };
}

// TSX/JSX has no neutral tsc oracle (tsc exposes no per-token JSX scope roles), so the
// JSX dialect is measured as drop-in AGREEMENT with the official TypeScriptReact grammar:
// of the tokens where official emits a JSX-meaningful scope, the fraction Monogram matches
// at family / exact level. Mirrors test/tsx-highlight.ts's opt-in view.
const JSX_SCOPE = /\b(tag|jsx|attribute-name|character\.entity|definition\.entity|section\.embedded)\b/;
function jsxAgreement(monoG: vsctm.IGrammar, offG: vsctm.IGrammar, texts: string[]): { exact: number; family: number; graded: number } {
  let exact = 0, family = 0, graded = 0;
  for (const text of texts) {
    const mt = tmTokenize(monoG, text), ot = tmTokenize(offG, text);
    for (const o of ot) {
      if (o.scope === 'source.tsx' || !JSX_SCOPE.test(o.scope)) continue; // only JSX-dialect tokens
      if (!text.slice(o.start, o.end).trim()) continue; // skip whitespace (it carries the region scope, not a token's)
      graded++;
      const m = mt.find((x) => x.start <= o.start && o.start < x.end);
      if (!m) continue;
      if (normScope(m.scope) === normScope(o.scope)) { exact++; family++; }
      else if (scopeFamily(m.scope) === scopeFamily(o.scope)) family++;
    }
  }
  return { exact, family, graded };
}

interface LangRow { lang: string; mono: { correct: number; total: number }; off: { correct: number; total: number } }
const rowPct = (x: { correct: number; total: number }): string => (x.total ? `${(x.correct / x.total * 100).toFixed(1)}%` : '—');

function buildBenchMarkdown(rows: LangRow[], jsx?: { exact: number; family: number; graded: number }): string {
  const out: string[] = [];
  out.push('<!-- generated by `npm run bench:readme` — do not edit by hand -->');
  out.push('');
  out.push('**Token-family accuracy vs a neutral `tsc` oracle** — for each token, did the highlighter put it in the');
  out.push('right family (*type / value / keyword / literal / comment / property*)? That is where the errors that matter');
  out.push("live (a **value** painted as a **type**, a **regex** as an **operator**). Monogram's TextMate output is *derived*");
  out.push('from its conformance-proven parser; each baseline is the official hand-written grammar for that language.');
  out.push('');
  out.push('| Language | Monogram (derived) | Official |');
  out.push('| --- | --- | --- |');
  for (const r of rows) out.push(`| ${r.lang} | **${rowPct(r.mono)}** | ${rowPct(r.off)} |`);
  out.push('');
  if (jsx && jsx.graded > 0) {
    const ex = (jsx.exact / jsx.graded * 100).toFixed(1), fa = (jsx.family / jsx.graded * 100).toFixed(1);
    out.push('');
    out.push(`**TSX** (the JSX dialect) has no neutral \`tsc\` oracle to grade against — tsc exposes no per-token JSX scope roles — so it is measured as drop-in agreement with the official **TypeScriptReact** grammar over a JSX corpus ([\`test/tsx-corpus.ts\`](test/tsx-corpus.ts)): Monogram matches it on **${fa}%** of JSX tokens at the family level (**${ex}%** exact). The non-JSX code in a \`.tsx\` file is the TypeScript row above.`);
  }
  out.push('');
  out.push("<sub>Higher = more correct. TypeScript is graded on the ambiguity-rich documented-bug ledger ([`test/issue-cases.ts`](test/issue-cases.ts)) — the cases where a hand-written regex grammar slips; JavaScript on a representative corpus ([`test/js-corpus.ts`](test/js-corpus.ts)). The same TypeScript grammar also derives a **tree-sitter** highlighter that scores **95.9%** — above official tree-sitter (92.7%). Regenerate: `npm run bench:readme`.</sub>");
  return out.join('\n');
}

function writeReadmeBlock(markdown: string): void {
  const path = 'README.md';
  const START = '<!-- bench:start -->';
  const END = '<!-- bench:end -->';
  let readme: string;
  try { readme = readFileSync(path, 'utf-8'); } catch { console.error(`cannot read ${path}`); return; }
  const block = `${START}\n${markdown}\n${END}`;
  const s = readme.indexOf(START), e = readme.indexOf(END);
  let next: string;
  if (s >= 0 && e > s) {
    next = readme.slice(0, s) + block + readme.slice(e + END.length);
  } else {
    console.error(`markers not found in README.md — add a "${START} … ${END}" block where you want the comparison.`);
    return;
  }
  if (next !== readme) {
    writeFileSync(path, next);
    console.log(`✓ README.md bench block updated (${markdown.split('\n').length} lines)`);
  } else {
    console.log('README.md bench block already current.');
  }
}

// ── corpus loaders ────────────────────────────────────────────────────────────
async function allTs(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await allTs(full)));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}

// ── run selected corpora ──────────────────────────────────────────────────────
const WRITE_README = argv.includes('--write-readme');
const WHICH = getFlag('--corpus') ?? 'both'; // --write-readme respects --corpus (CI uses adversarial = deterministic, no TS clone)

let issueStats: IssueStats | null = null;

if (WHICH === 'parser' || WHICH === 'both') {
  if (!existsSync(PARSER_DIR)) {
    const msg = `Parser corpus not found at ${PARSER_DIR}\n  git clone https://github.com/microsoft/TypeScript /tmp/ts-repo`;
    if (WRITE_README) console.error(`(skipping parser corpus — ${msg.split('\n')[0]})`);
    else { console.error(msg); process.exit(1); }
  } else {
    let files = (await allTs(PARSER_DIR)).sort();
    if (Number.isFinite(LIMIT)) files = files.slice(0, LIMIT);
    const inputs: { name: string; text: string }[] = [];
    for (const f of files) {
      try { inputs.push({ name: f, text: readFileSync(f, 'utf-8') }); } catch { /* skip unreadable */ }
    }
    runBench('parser conformance corpus', 'tests/cases/conformance/parser (TS parser test suite)', inputs);
  }
}

if (WHICH === 'adversarial' || WHICH === 'both') {
  // The adversarial corpus IS the documented bug ledger: every case from
  // test/issue-cases.ts (the microsoft/TypeScript-TmLanguage issues Monogram claims
  // to fix), graded by the NEUTRAL tsc oracle, then aggregated per documented issue.
  const advInputs = [
    ...issueTests.map((t) => ({ name: t.label, text: t.input })),
    ...issueMultiLine.map((t) => ({ name: t.label, text: t.lines.join('\n') })),
  ];
  const distinct = new Set(advInputs.map((i) => i.name.match(/#(\d+)/)?.[1]).filter(Boolean)).size;
  const res = runBench(
    'adversarial — documented official-grammar bug ledger',
    `${distinct} issues / ${advInputs.length} cases from test/issue-cases.ts`,
    advInputs,
  );
  issueStats = reportByIssue(res.perInput);
}

if (WRITE_README) {
  // Per-language table: Monogram's DERIVED TextMate highlighter vs each language's
  // official hand-written grammar, graded by the same tsc oracle. TypeScript on the
  // ambiguity-rich documented-bug ledger (issue-cases), JavaScript on its representative
  // corpus. Both numbers share their source with the standalone benches.
  const advTexts = [
    ...issueTests.map((t) => t.input),
    ...issueMultiLine.map((t) => t.lines.join('\n')),
  ];
  const rows: LangRow[] = [
    {
      lang: 'TypeScript',
      mono: familyAccuracy(monogramGrammar, advTexts, ts.ScriptKind.TS),
      off: familyAccuracy(officialGrammar, advTexts, ts.ScriptKind.TS),
    },
  ];
  if (jsMonogramGrammar && jsOfficialGrammar) {
    rows.push({
      lang: 'JavaScript',
      mono: familyAccuracy(jsMonogramGrammar, JS_CORPUS, ts.ScriptKind.JS),
      off: familyAccuracy(jsOfficialGrammar, JS_CORPUS, ts.ScriptKind.JS),
    });
  } else {
    console.error('(skipping JavaScript row — official JS grammar not found; set MONOGRAM_OFFICIAL_JS_TM)');
  }
  const jsx = (tsxMonogramGrammar && tsxOfficialGrammar)
    ? jsxAgreement(tsxMonogramGrammar, tsxOfficialGrammar, JSX_CORPUS)
    : (console.error('(skipping TSX line — official TypeScriptReact grammar not found; set MONOGRAM_OFFICIAL_TSX)'), undefined);
  writeReadmeBlock(buildBenchMarkdown(rows, jsx));
}

// --engines: print per-engine family accuracy to the terminal (NOT the README).
// Set MONOGRAM_TS_WASM (+ MONOGRAM_TS_QUERY) to also grade Monogram's OWN compiled
// tree-sitter — the opt-in measurement that needs a locally-built wasm.
if (argv.includes('--engines')) {
  const advInputs = [
    ...issueTests.map((t) => ({ name: t.label, text: t.input })),
    ...issueMultiLine.map((t) => ({ name: t.label, text: t.lines.join('\n') })),
  ];
  const tsOk = await loadTreeSitter();
  const mtsWasm = process.env.MONOGRAM_TS_WASM;
  const mtsOk = mtsWasm
    ? await loadMonogramTreeSitter(mtsWasm, process.env.MONOGRAM_TS_QUERY ?? 'examples/tree-sitter/typescript/queries/highlights.scm')
    : false;
  const scores = await engineFamilyScores(advInputs, tsOk, mtsOk);
  console.log('\n── token-family accuracy vs tsc oracle (issue-cases corpus) ──');
  for (const s of [...scores].sort((a, b) => b.correct / b.total - a.correct / a.total)) {
    console.log(`  ${s.name.padEnd(32)} ${((s.correct / s.total) * 100).toFixed(1)}%  (${s.correct}/${s.total})`);
  }
}

// --miss-mts: dump Monogram tree-sitter's MISSES grouped by (role → got/want family),
// flagging how many official tree-sitter gets right (= the closeable gap). Needs
// MONOGRAM_TS_WASM. The diagnostic that drives chasing the accuracy number up.
if (argv.includes('--miss-mts')) {
  const advInputs = [
    ...issueTests.map((t) => ({ name: t.label, text: t.input })),
    ...issueMultiLine.map((t) => ({ name: t.label, text: t.lines.join('\n') })),
  ];
  const tsOk = await loadTreeSitter();
  const mtsWasm = process.env.MONOGRAM_TS_WASM;
  if (!mtsWasm || !(await loadMonogramTreeSitter(mtsWasm, process.env.MONOGRAM_TS_QUERY ?? 'examples/tree-sitter/typescript/queries/highlights.scm'))) {
    console.error('set MONOGRAM_TS_WASM (and optionally MONOGRAM_TS_QUERY) to a built wasm'); process.exit(1);
  }
  const focus = process.env.MISS_ROLE; // set to a role to print each miss's snippet+context
  const groups = new Map<string, { n: number; offRight: number; ex: Set<string> }>();
  for (const inp of advInputs) {
    const sf = ts.createSourceFile('c.ts', inp.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (((sf as any).parseDiagnostics?.length ?? 0) > 0) continue;
    let gold: GoldToken[]; try { gold = oracle(inp.text); } catch { continue; }
    const mts = monogramTreesitterFamilies(inp.text);
    const off = tsOk ? treesitterFamilies(inp.text) : [];
    for (const g of gold) {
      if (ROLE_SPEC[g.role].tier === 'lexical' || roleFamily(g.role) === 'punct') continue;
      const ok = acceptableFamilies(g.role);
      const fam = familyAt(mts, g.start);
      if (fam && ok.has(fam)) continue; // correct
      const offFam = familyAt(off, g.start);
      const key = `${g.role.padEnd(13)} got:${(fam || '∅').padEnd(9)} want:{${[...ok].join('|')}}`;
      if (!groups.has(key)) groups.set(key, { n: 0, offRight: 0, ex: new Set() });
      const e = groups.get(key)!; e.n++; if (offFam && ok.has(offFam)) e.offRight++; if (e.ex.size < 6) e.ex.add(g.text);
      if (focus && g.role === focus) {
        const ctx = inp.text.slice(Math.max(0, g.start - 20), g.start + 20).replace(/\n/g, '⏎');
        console.log(`  «${g.text}» got:${fam || '∅'} off:${offFam || '∅'}  …${ctx}…`);
      }
    }
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log('\n── Monogram tree-sitter MISSES (worst first; offRight = official gets it → closeable) ──');
  let total = 0;
  for (const [k, v] of rows) { total += v.n; console.log(`  n=${String(v.n).padStart(2)}  off=${v.offRight}/${v.n}  ${k}  e.g. ${[...v.ex].join('  ')}`); }
  console.log(`  ── ${total} misses total ──`);
}
