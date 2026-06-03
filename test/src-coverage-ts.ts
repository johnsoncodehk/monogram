// src-coverage-ts.ts — PROTOTYPE of a source-coverage-anchored parser-alignment metric.
//
// IDEA: The hand-curated issue ledger has no DENOMINATOR. Use *source-code coverage of
// the OFFICIAL parser* (typescript.js) as the denominator instead. Each instrumented
// block-range ("branch") in the official parser ≈ a syntactic decision; a corpus that
// covers all branches has exercised the whole grammar. Bidirectional accept/reject
// agreement, attributed PER-BRANCH, then yields a principled alignment number anchored
// on the official parser's own source — and the per-branch DISAGREE list is the
// auto-generated replacement for the issue ledger.
//
// METRIC (per corpus file f):
//   cov(f)  = block-ranges in typescript.js executed while parsing f (inspector diff).
//   O(f)    = official verdict: accept iff sourceFile.parseDiagnostics.length === 0.
//   M(f)    = Monogram verdict: accept iff our parser parses f without throwing.
//   agree(f)= O(f) === M(f).
// Branch classification across the corpus:
//   reachable            = branches hit by >=1 file.
//   covered-and-agreed   = branches hit by >=1 file with agree(f)=true.
//   covered-but-disagreed= reachable branches hit ONLY by files with agree(f)=false.
//   uncovered            = instrumented but never hit (corpus gap).
// Headline   alignment%          = covered-and-agreed / reachable.
// Blind-spot corpus-completeness% = reachable / total-branches-seen.
//
// ORACLE + CORPUS + MONOGRAM-INVOCATION are REUSED from test/conformance-matrix.ts:
//   - oracle:  ts.createSourceFile(...) then (sf as any).parseDiagnostics.length === 0
//   - monogram: createParser(grammar).parse(code) in try/catch
//   - corpus:  /tmp/ts-repo/tests/cases/conformance, .ts (not .d.ts), single-file only
//
// Run (Node 24+, bare node — NOT tsx):
//   node test/src-coverage-ts.ts            # default subset (env SUBSET, default 400)
//   node test/src-coverage-ts.ts 1000       # subset size as arg
//   node test/src-coverage-ts.ts all        # full single-file corpus
//
// Self-contained: no package.json / shared-src edits. Coverage is in-process via
// node:inspector precise coverage (callCount + detailed block ranges).

import inspector from 'node:inspector';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { createParser } from '../src/gen-parser.ts';

// ---- REUSED from conformance-matrix.ts: grammar, parser, corpus path, walk, isMulti ----
const grammar = (await import('../typescript.ts')).default;
const { parse } = createParser(grammar);
const base = '/tmp/ts-repo/tests/cases/conformance';

function walk(d: string): string[] {
  let o: string[] = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.isDirectory()) o = o.concat(walk(f));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) o.push(f);
  }
  return o;
}
const isMulti = (t: string) => /^\s*\/\/\s*@filename:/im.test(t);

// ---- oracle + monogram verdicts (mirror conformance-matrix.ts exactly) ----
let officialThrew = 0;
function officialAccepts(code: string): boolean {
  // Mirror conformance-matrix.ts (accept iff parseDiagnostics is empty). One guard it
  // lacks: on a handful of malformed inputs the official parser itself throws a
  // Debug.assert (e.g. `await using` edge cases) — a TS parser bug, not an accept. Treat
  // a throw as a reject and tally it as a caveat (these files still get coverage from the
  // partial parse that ran before the throw).
  try {
    const sf = ts.createSourceFile('t.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const diags = (sf as any).parseDiagnostics as ts.Diagnostic[] | undefined;
    return (diags?.length ?? 0) === 0;
  } catch {
    officialThrew++;
    return false;
  }
}
function monogramAccepts(code: string): boolean {
  try { parse(code); return true; } catch { return false; }
}

// ---- inspector precise coverage harness ----
const TS_URL = 'node_modules/typescript/lib/typescript.js';
const session = new inspector.Session();
session.connect();
const post = (m: string, p?: any): Promise<any> =>
  new Promise((res, rej) => session.post(m, p, (e: any, r: any) => (e ? rej(e) : res(r))));

// A branch is one block-range of one function in typescript.js, keyed by
// functionName|startOffset|endOffset. detailed:true gives nested block ranges; we count
// every range as a distinct branch (function-entry range + each conditional sub-block).
type RangeIndex = Map<string, number>; // key -> cumulative count at snapshot time
function indexTsRanges(result: any[]): RangeIndex {
  const m: RangeIndex = new Map();
  for (const s of result) {
    if (!s.url || !s.url.includes(TS_URL)) continue;
    for (const fn of s.functions) {
      const name = fn.functionName || '(anonymous)';
      for (const r of fn.ranges) {
        m.set(`${name}|${r.startOffset}|${r.endOffset}`, r.count);
      }
    }
  }
  return m;
}

// parser/scanner-only name filter: the functions that make *syntactic* decisions.
// Anchored ^ so it matches function NAMES, not substrings; excludes the *Object wrappers
// (TokenObject/NodeObject/SourceFileObject) which are AST node classes, not parser fns.
const PARSER_NAME_RE =
  /^(parse|reParse|reScan|scan(?!ner)|nextToken|tryParse|lookAhead|speculationHelper|isStartOf|isListElement|isListTerminator|canParseSemicolon|canFollow|nextTokenIs|nextTokenCan|parseList|parseDelimitedList)/;
function isParserBranch(key: string): boolean {
  const name = key.slice(0, key.indexOf('|'));
  return PARSER_NAME_RE.test(name);
}

// offset -> 1-based line in typescript.js, for human-navigable disagree locations.
const tsSrc = readFileSync(require_resolve_ts(), 'utf8');
function require_resolve_ts(): string {
  // typescript resolves to lib/typescript.js in this repo (verified). Build the path
  // off the import without a bundler-specific resolver.
  return new URL('../node_modules/typescript/lib/typescript.js', import.meta.url).pathname;
}
// Precompute line-start offsets for O(log n) offset->line lookup.
const lineStarts: number[] = [0];
for (let i = 0; i < tsSrc.length; i++) if (tsSrc.charCodeAt(i) === 10) lineStarts.push(i + 1);
function offsetToLine(off: number): number {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}
function lineText(line: number): string {
  const start = lineStarts[line - 1] ?? 0;
  const end = lineStarts[line] ?? tsSrc.length;
  return tsSrc.slice(start, end).replace(/\n$/, '').trim();
}

// ---- corpus selection ----
const all = walk(base).sort();
const arg = process.argv[2];
const SUBSET = arg === 'all' ? Infinity : Number(arg ?? process.env.SUBSET ?? 400);
// Deterministic, structurally-spread subset: stride-sample the sorted list so every
// directory (classes/expressions/parser/types/...) is represented, not just the first N.
function pick(files: string[], n: number): string[] {
  if (!isFinite(n) || n >= files.length) return files;
  const out: string[] = [];
  const stride = files.length / n;
  for (let i = 0; i < n; i++) out.push(files[Math.floor(i * stride)]);
  return out;
}

// Load + filter to single-file cases up front (so SUBSET counts real cases).
const cases: { file: string; code: string }[] = [];
for (const f of all) {
  const code = readFileSync(f, 'utf8');
  if (isMulti(code)) continue;
  cases.push({ file: f, code });
}
const chosen = pick(cases, SUBSET);

console.log(`Corpus: ${all.length} .ts files, ${cases.length} single-file cases; running ${chosen.length}.`);

// ---- per-branch accumulators ----
// For each branch key seen, track whether it was hit by any agreeing file and any
// disagreeing file. reachable = seen at all. covered-and-agreed = hitByAgree.
// covered-but-disagreed = hitByDisagree && !hitByAgree.
type Branch = { hitByAgree: boolean; hitByDisagree: boolean };
const branches = new Map<string, Branch>();
// total-branches-seen = every range that EXISTS in any snapshot of typescript.js
// (covered or not). We grow it as functions lazily compile.
const everSeen = new Set<string>();

// For the disagree ledger: which disagreeing files hit each branch (capped per branch).
const disagreeExamples = new Map<string, Set<string>>();

let TP = 0, FN = 0, FP = 0, TN = 0;

await post('Profiler.enable');
await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

// Warm up: compile the parser paths once so the FIRST measured file isn't credited with
// the entire lazy-compile of typescript.js. (Lazy functions still appearing later are
// fine — they enter everSeen when first observed.)
for (const w of ['const x=1;', 'class C<T>{m(){}}', 'type T=A|B;', 'function*g(){yield 1}', 'enum E{A}']) {
  ts.createSourceFile('w.ts', w, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

const t0 = Date.now();
let lastIndex: RangeIndex = indexTsRanges((await post('Profiler.takePreciseCoverage')).result);
for (const k of lastIndex.keys()) everSeen.add(k);

let done = 0;
for (const { file, code } of chosen) {
  const O = officialAccepts(code); // also (re)runs the official parser → its branches register
  const M = monogramAccepts(code);
  const agree = O === M;
  if (O && M) TP++; else if (O && !M) FN++; else if (!O && M) FP++; else TN++;

  const after = indexTsRanges((await post('Profiler.takePreciseCoverage')).result);
  const rel = file.replace(base + '/', '');
  for (const [key, count] of after) {
    everSeen.add(key);
    const prev = lastIndex.get(key) ?? 0;
    if (count > prev) {
      // this branch's count increased while processing THIS file → hit by this file
      const b = branches.get(key) ?? { hitByAgree: false, hitByDisagree: false };
      if (agree) b.hitByAgree = true; else b.hitByDisagree = true;
      branches.set(key, b);
      if (!agree) {
        const set = disagreeExamples.get(key) ?? new Set<string>();
        if (set.size < 4) set.add(rel);
        disagreeExamples.set(key, set);
      }
    }
  }
  lastIndex = after;
  if (++done % 100 === 0) process.stderr.write(`  ..${done}/${chosen.length}\n`);
}
const elapsed = (Date.now() - t0) / 1000;
await post('Profiler.stopPreciseCoverage');

// ---- compute ratios for a given branch-set predicate ----
function report(label: string, keep: (key: string) => boolean) {
  let reachable = 0, agreed = 0, disagreed = 0, totalSeen = 0;
  const disagreeKeys: string[] = [];
  for (const key of everSeen) if (keep(key)) totalSeen++;
  for (const [key, b] of branches) {
    if (!keep(key)) continue;
    reachable++;
    if (b.hitByAgree) agreed++;
    else if (b.hitByDisagree) { disagreed++; disagreeKeys.push(key); }
  }
  const uncovered = totalSeen - reachable;
  const alignment = reachable ? (agreed / reachable) * 100 : 0;
  const completeness = totalSeen ? (reachable / totalSeen) * 100 : 0;
  console.log(`\n========== ${label} ==========`);
  console.log(`  total branches seen (covered+lazy) : ${totalSeen}`);
  console.log(`  reachable (hit >=1 file)           : ${reachable}`);
  console.log(`    covered-and-agreed               : ${agreed}`);
  console.log(`    covered-but-disagreed            : ${disagreed}`);
  console.log(`  uncovered (corpus gap)             : ${uncovered}`);
  console.log(`  ALIGNMENT%  (agreed/reachable)        : ${alignment.toFixed(2)}%`);
  console.log(`  COMPLETENESS% (reachable/total-seen)  : ${completeness.toFixed(2)}%`);
  return disagreeKeys;
}

console.log(`\n--- verdict confusion matrix (mirrors conformance-matrix.ts) ---`);
console.log(`  TP=${TP} (both accept)  FN=${FN} (TS accept, we reject)`);
console.log(`  FP=${FP} (TS reject, we accept)  TN=${TN} (both reject)`);
console.log(`  bidirectional agree: ${(((TP + TN) / (TP + FN + FP + TN)) * 100).toFixed(2)}%`);
if (officialThrew) console.log(`  caveat: official parser THREW on ${officialThrew} file(s) — counted as reject (TS Debug.assert edge cases)`);
console.log(`  wall-clock: ${elapsed.toFixed(1)}s for ${chosen.length} files (coverage diff + both parsers)`);

const allKeys = report('A) DENOMINATOR = all of typescript.js', () => true);
const parserKeys = report('B) DENOMINATOR = parser/scanner-named functions only', isParserBranch);

// ---- ranked covered-but-disagreed ledger (the auto-generated issue list) ----
// Rank by how many distinct disagreeing files hit the branch (broad divergence first),
// then group by function so the output reads like a ledger of localized divergences.
function ledger(label: string, keys: string[]) {
  const rows = keys.map((key) => {
    const [name, startStr, endStr] = key.split('|');
    const start = Number(startStr);
    const line = offsetToLine(start);
    const examples = [...(disagreeExamples.get(key) ?? new Set())];
    return { name, start, end: Number(endStr), line, examples, key };
  });
  // dedupe to the *function* level for readability, keeping the widest example set.
  const byFn = new Map<string, { name: string; start: number; line: number; examples: Set<string>; ranges: number }>();
  for (const r of rows) {
    const e = byFn.get(r.name) ?? { name: r.name, start: r.start, line: r.line, examples: new Set<string>(), ranges: 0 };
    e.ranges++;
    if (r.start < e.start) { e.start = r.start; e.line = r.line; }
    for (const x of r.examples) if (e.examples.size < 4) e.examples.add(x);
    byFn.set(r.name, e);
  }
  const sorted = [...byFn.values()].sort((a, b) => b.examples.size - a.examples.size || b.ranges - a.ranges);
  console.log(`\n========== ${label}: covered-but-disagreed ledger (${rows.length} branches across ${sorted.length} functions) ==========`);
  console.log(`  (official source = typescript.js; line is in that bundle since TS ships no .map)`);
  for (const e of sorted.slice(0, 15)) {
    console.log(`\n  ${e.name}  (typescript.js:${e.line}, offset ${e.start}; ${e.ranges} disagreeing branch${e.ranges > 1 ? 'es' : ''})`);
    console.log(`    src: ${lineText(e.line).slice(0, 110)}`);
    console.log(`    failing examples: ${[...e.examples].join(', ') || '(none captured)'}`);
  }
}
ledger('B) parser/scanner-filtered (recommended denominator)', parserKeys);
// The all-typescript.js view additionally surfaces divergences in binder/JSDoc/error
// helpers that the parser/scanner name-filter drops — shown for completeness.
ledger('A) all-typescript.js', allKeys);

console.log(`\nDone.`);
