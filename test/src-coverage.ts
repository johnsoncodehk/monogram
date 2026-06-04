// src-coverage.ts — shared, language-agnostic harness for the source-coverage-anchored
// parser-alignment metric. The two entrypoints (src-coverage-ts.ts = accept/reject,
// src-coverage-html.ts = structural tree-equality) are thin adapters over this core.
//
// METRIC. Use block-level coverage of the OFFICIAL parser's source as the denominator.
// A "branch" = one block-range of one function in the official parser. Per corpus file:
//   cov(f)   = official-parser branches whose hit-count rose while parsing f.
//   agree(f) = the adapter's oracle verdict (accept/reject, or tree-equality) matches Monogram.
// Classify every branch seen across the corpus:
//   reachable             = hit by >=1 file.
//   covered-and-agreed    = hit by >=1 file with agree(f).
//   covered-but-disagreed = reachable, hit ONLY by files with !agree(f)  <- localized divergence.
//   uncovered             = instrumented but never hit (corpus gap).
// Headline   alignment%     = covered-and-agreed / reachable.
// Blind-spot completeness%  = reachable / total-branches-seen   (reported separately, never folded in).
// The covered-but-disagreed branches, mapped offset->source-line, ARE the auto-generated
// replacement for the hand-curated issue ledger.
//
// THE ONE INVARIANT (hard-won): the official parser is invoked EXACTLY ONCE per file, by
// adapter.runOfficial, and the coverage snapshot is taken immediately after — BEFORE
// adapter.agree runs Monogram. Parsing the official parser twice pre-warms the very
// branches we want to attribute and the per-file delta collapses to ~0.
//
// Coverage is in-process via node:inspector precise coverage (callCount + detailed block
// ranges). Run the adapters with bare node (Node 24+), not tsx.

import inspector from 'node:inspector';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface CorpusItem { code: string; origin?: string }

// agree() returns at least { agree }, plus any mode-specific fields renderHeader/Footer use.
export interface AgreeResult { agree: boolean; [k: string]: unknown }

export interface BranchKeyParts { url: string; fnName: string; start: number; end: number }
export interface Denominator { label: string; keep: (p: BranchKeyParts) => boolean }

export interface Adapter {
  name: string;
  oracle: string;                                    // e.g. "accept/reject" or "structural tree-equality (parse5)"
  urlMatch: (url: string) => boolean;                // which official-parser source files form the universe
  loadCorpus: () => CorpusItem[];
  warmup: () => void;                                // run the official parser on a few snippets (under coverage)
  runOfficial: (code: string) => unknown;           // the ONE measured official parse; return value handed to agree()
  agree: (code: string, official: unknown) => AgreeResult; // runs Monogram + compares
  denominators: Denominator[];                       // one or more branch-set views to report
  renderHeader?: (results: AgreeResult[], corpus: CorpusItem[]) => void; // mode-specific top summary
  renderFooter?: (results: AgreeResult[], corpus: CorpusItem[]) => void; // mode-specific tail (e.g. failing files)
  ledgerTop?: number;                                // disagree rows to print per denominator (default 15)
}

interface BranchState {
  url: string; fnName: string; start: number; end: number;
  reachable: boolean; agreedHit: boolean; fails: string[];
}

const SEP = '\t'; // never appears in a url or a JS function name

export async function run(adapter: Adapter): Promise<void> {
  const session = new inspector.Session();
  session.connect();
  const post = (m: string, p?: unknown): Promise<any> =>
    new Promise((res, rej) => session.post(m, p as any, (e: any, r: any) => (e ? rej(e) : res(r))));

  // Universe of branches, keyed url+fn+offsets; parts stored so denominator.keep can filter
  // even the count=0-only (uncovered) branches.
  const branches = new Map<string, BranchState>();

  // Snapshot -> Map<key, count> for the adapter's urls; also registers every range (incl.
  // count=0) into the universe so uncovered branches are counted.
  const snapshot = async (): Promise<Map<string, number>> => {
    const { result } = await post('Profiler.takePreciseCoverage');
    const m = new Map<string, number>();
    for (const s of result) {
      if (!s.url || !adapter.urlMatch(s.url)) continue;
      for (const fn of s.functions) {
        const name = fn.functionName || '(anonymous)';
        for (const r of fn.ranges) {
          const key = s.url + SEP + name + SEP + r.startOffset + SEP + r.endOffset;
          m.set(key, r.count);
          if (!branches.has(key)) {
            branches.set(key, { url: s.url, fnName: name, start: r.startOffset, end: r.endOffset, reachable: false, agreedHit: false, fails: [] });
          }
        }
      }
    }
    return m;
  };

  const corpus = adapter.loadCorpus();

  await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  adapter.warmup();

  const results: AgreeResult[] = [];
  const t0 = Date.now();
  let done = 0;
  for (const item of corpus) {
    // Per-file before/after bracketing. takePreciseCoverage RESETS counters on each take, so
    // `after` reports only what ran since `before` — i.e. runOfficial's coverage alone (the
    // `before` take flushes the prior interval). A cross-file rolling baseline would instead
    // compare two different files' deltas and under-attribute shared branches, so we bracket
    // each file. The only official-parser work between the two takes is runOfficial.
    const before = await snapshot();
    const official = adapter.runOfficial(item.code);   // measured: the only official parse
    const after = await snapshot();                    // snapshot BEFORE Monogram runs
    const hits: string[] = [];
    for (const [key, count] of after) if (count > (before.get(key) ?? 0)) hits.push(key);
    const verdict = adapter.agree(item.code, official); // Monogram, post-snapshot (filtered by url anyway)
    results.push(verdict);
    for (const key of hits) {
      const st = branches.get(key);
      if (!st) continue;
      st.reachable = true;
      if (verdict.agree) st.agreedHit = true;
      else if (st.fails.length < 4 && !st.fails.includes(item.code)) st.fails.push(item.code);
    }
    if (++done % 500 === 0) process.stderr.write(`  ..${done}/${corpus.length}\n`);
  }
  const elapsed = (Date.now() - t0) / 1000;
  await post('Profiler.stopPreciseCoverage');

  // ---- offset -> 1-based source line, lazily per url (file:// or plain path) ----
  const srcCache = new Map<string, { text: string; starts: number[] } | null>();
  const srcOf = (url: string) => {
    if (srcCache.has(url)) return srcCache.get(url) ?? null;
    let v: { text: string; starts: number[] } | null = null;
    try {
      const path = url.startsWith('file:') ? fileURLToPath(url) : url;
      const text = readFileSync(path, 'utf8');
      const starts = [0];
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
      v = { text, starts };
    } catch { v = null; }
    srcCache.set(url, v);
    return v;
  };
  const lineAt = (url: string, off: number): { line: number; text: string } => {
    const s = srcOf(url);
    if (!s) return { line: 0, text: '' };
    let lo = 0, hi = s.starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s.starts[mid] <= off) lo = mid; else hi = mid - 1; }
    const line = lo + 1;
    const start = s.starts[line - 1] ?? 0, end = s.starts[line] ?? s.text.length;
    return { line, text: s.text.slice(start, end).replace(/\n$/, '').trim() };
  };
  const shortUrl = (url: string) => url.replace(/^.*[/\\]node_modules[/\\]/, '');

  // ---- report ----
  const agreeCount = results.reduce((n, r) => n + (r.agree ? 1 : 0), 0);
  console.log('='.repeat(78));
  console.log(`  Source-coverage parser-alignment metric — ${adapter.name} (oracle = ${adapter.oracle})`);
  console.log('='.repeat(78));
  console.log(`  corpus: ${corpus.length} files · agree ${agreeCount}/${corpus.length} · wall-clock ${elapsed.toFixed(1)}s`);
  adapter.renderHeader?.(results, corpus);

  const ledgerTop = adapter.ledgerTop ?? 15;
  const denomSummary: { label: string; alignment: number; completeness: number }[] = [];
  for (const den of adapter.denominators) {
    let totalSeen = 0, reachable = 0, agreed = 0, disagreed = 0;
    const dis: BranchState[] = [];
    for (const st of branches.values()) {
      if (!den.keep(st)) continue;
      totalSeen++;
      if (!st.reachable) continue;
      reachable++;
      if (st.agreedHit) agreed++;
      else { disagreed++; dis.push(st); }
    }
    const uncovered = totalSeen - reachable;
    const alignment = reachable ? (agreed / reachable) * 100 : 0;
    const completeness = totalSeen ? (reachable / totalSeen) * 100 : 0;
    denomSummary.push({ label: den.label, alignment, completeness });
    console.log(`\n────── denominator: ${den.label} ──────`);
    console.log(`  total branches seen (reachable+uncovered) : ${totalSeen}`);
    console.log(`  reachable (hit >=1 file)                  : ${reachable}`);
    console.log(`    covered-and-agreed                      : ${agreed}`);
    console.log(`    covered-but-disagreed                   : ${disagreed}`);
    console.log(`  uncovered (corpus gap)                    : ${uncovered}`);
    console.log(`  ALIGNMENT%    (agreed/reachable)          : ${alignment.toFixed(2)}%`);
    console.log(`  COMPLETENESS% (reachable/total-seen)      : ${completeness.toFixed(2)}%`);

    dis.sort((a, b) => b.fails.length - a.fails.length || a.url.localeCompare(b.url) || a.start - b.start);
    const top = Math.min(ledgerTop, dis.length);
    console.log(`  covered-but-disagreed ledger (top ${top} of ${dis.length}; each is one official-parser decision):`);
    for (let i = 0; i < top; i++) {
      const st = dis[i];
      const { line, text } = lineAt(st.url, st.start);
      console.log(`   ${(i + 1).toString().padStart(2)}. ${shortUrl(st.url)} ${st.fnName} @${st.start}${line ? ` (L${line})` : ''}`);
      if (text) console.log(`       src: ${text.slice(0, 100)}`);
      const ex = st.fails.slice(0, 3).map((s) => JSON.stringify(s.length > 60 ? s.slice(0, 57) + '...' : s)).join('  ');
      console.log(`       e.g. ${ex || '(none captured)'}`);
    }
  }

  adapter.renderFooter?.(results, corpus);
  // Machine-readable summary line for the README coverage-table generator (test/coverage-table.ts).
  console.log('##COV## ' + JSON.stringify({
    name: adapter.name, oracle: adapter.oracle, files: results.length,
    agreePct: results.length ? (100 * agreeCount) / results.length : null,
    denoms: denomSummary,
  }));
  console.log('\nDone.');
}
