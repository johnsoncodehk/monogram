// ─────────────────────────────────────────────────────────────────────────────
//  src-coverage-html.ts — PROTOTYPE of a source-coverage-anchored parser-alignment
//  metric for HTML (the STRUCTURAL oracle case).
//
//  THE IDEA. "How aligned is Monogram's HTML parser with the official one?" is today
//  judged by a hand-curated issue ledger with NO DENOMINATOR. Here the denominator is
//  *source-code coverage of the OFFICIAL parser* (parse5). Each block-range in parse5's
//  source ~ one syntactic decision (an insertion-mode / adoption / tokenizer branch). A
//  corpus that covers all branches has exercised the whole grammar. Agreement on that
//  corpus, ATTRIBUTED PER-BRANCH, gives a principled alignment number anchored on the
//  official parser's own source.
//
//  HTML has NO reject — parse5 recovers from anything to a tree — so "agreement" compares
//  the produced TREES, not accept/reject. O(f) = parse5's element tree; M(f) = Monogram's
//  markup-mode CST normalized to the same shape. agree(f) = O(f) deep-equals M(f).
//
//  PER-BRANCH COVERAGE. node:inspector precise coverage (detailed:true -> block ranges =
//  our "branches"). V8's coverage counters are CUMULATIVE; Profiler.takePreciseCoverage
//  reports the functions touched since the previous take, so (after - before) for a given
//  branch key = the ranges file f executed. It also reports count=0 ranges inside any
//  function that ran at all = instrumented-but-never-TAKEN branches.
//
//  CLASSIFICATION of every branch seen across the corpus:
//    reachable             = hit (positive delta) by >=1 corpus file.
//    covered-and-agreed    = hit by >=1 file where agree(f).
//    covered-but-disagreed = reachable but hit ONLY by files where !agree(f)  <- localized divergence.
//    uncovered             = in the instrumented universe but never taken (corpus blind spot).
//  Reported ratios (kept separate):
//    alignment%            = covered-and-agreed / reachable      <- headline
//    corpus-completeness%  = reachable / total-branches-seen     <- honest blind-spot gauge
//
//  REUSE. parse5 invocation (parseFragment), tree normalization (monoTree/p5Tree), tree
//  comparison (JSON.stringify deep-equal) and the Monogram-parser invocation
//  (createParser(grammar).parse) are taken VERBATIM from test/html-conformance.ts — the
//  repo already solved cross-parser tree matching; this prototype does not reinvent it.
//  The corpus pools the fragments from html-conformance.ts, html-bench.ts and
//  html-issue-cases.ts, plus a handful of tricky tree-construction cases.
//
//  Run: node test/src-coverage-html.ts
// ─────────────────────────────────────────────────────────────────────────────
import inspector from 'node:inspector';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createParser } from '../src/gen-parser.ts';
import { parseFragment } from 'parse5';
import { cases as htmlIssueCases } from './html-issue-cases.ts';

const grammar = (await import('../html.ts')).default;
const { parse } = createParser(grammar);

// ── Tree normalization + comparison — VERBATIM from test/html-conformance.ts. ──
// Element tree (tag + nested elements only) from the Monogram CST.
interface El { tag: string; children: El[] }
function monoTree(node: any): El[] {
  const out: El[] = [];
  for (const c of node.children ?? []) collect(c, out);
  return out;
}
function collect(node: any, out: El[]): void {
  if (node.kind === 'leaf') return;
  if (node.rule === 'Element') {
    const name = (node.children ?? []).find(
      (c: any) => c.kind === 'leaf' && (c.tokenType === 'Name' || c.tokenType === 'VoidName'),
    );
    out.push({ tag: (name?.text ?? '').toLowerCase(), children: monoTree(node) });
    return;
  }
  for (const c of node.children ?? []) collect(c, out);
}
// Same element tree from a parse5 fragment (the OFFICIAL / oracle tree).
function p5Tree(node: any): El[] {
  const out: El[] = [];
  for (const c of node.childNodes ?? []) {
    if (c.tagName) out.push({ tag: c.tagName.toLowerCase(), children: p5Tree(c) });
  }
  return out;
}

// ── Corpus. Pool every existing HTML fixture in the repo + tricky tree-construction. ──
const conformanceCorpus: string[] = [
  '<div></div>', '<div>hello</div>', '<div class="x" id="y">hi</div>',
  '<div class="a" data-n=5 disabled>hi</div>', '<p>a <b>bold</b> and <i>italic</i> c</p>',
  '<ul><li>one</li><li>two</li><li>three</li></ul>',
  '<section><h1>Title</h1><p>Body <a href="/x">link</a>.</p></section>',
  '<br/>', '<img src="a.png" alt="pic"/>', '<img src="a.png" alt="pic">',
  '<input type="text" placeholder="name" disabled>', '<p>line<br>break<br>here</p>',
  '<hr><hr>', '<meta charset="utf-8">', '<div><span>x</span><span>y</span></div>',
  '<table><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  '<nav><a href="/">Home</a> | <a href="/about">About</a></nav>',
  '<button type="submit" class="btn btn-primary">Go</button>',
  '<div><p>nested <strong>deep <em>deeper</em></strong> text</p></div>',
  '<figure><img src="p.jpg"><figcaption>cap</figcaption></figure>',
  '<script>var a = 1 < 2 && b > 3;</script>', '<style>.a > .b { color: red; }</style>',
  '<div><!-- a comment --><p>x</p></div>', '<p>Price: $5 — 50% off (today)!</p>',
  '<custom-element data-x="1"><slot-content>hi</slot-content></custom-element>',
];
// The html-conformance "unsupported" set: parse5 error-recovery / full-document cases.
const unsupportedCorpus: string[] = [
  '<ul><li>a<li>b</ul>', '<!DOCTYPE html><html><body>x</body></html>',
  '<p>a < b</p>', '<table><tr><td>1</td></tr></table>',
];
// html-bench corpus (realistic single-line + adversarial).
const benchCorpus: string[] = [
  '<div class="x" id="y">hello</div>', '<p>a <b>bold</b> and <i>italic</i> c</p>',
  '<ul><li>one</li><li>two</li></ul>', '<a href="https://example.com" target="_blank">link</a>',
  '<input type="text" placeholder="name" disabled>', '<img src="a.png" alt="pic">',
  '<br/><hr/>', '<button type="submit" class="btn btn-primary">Go</button>',
  '<meta charset="utf-8">', '<div data-id=42 hidden><span>x</span></div>',
  '<section id="main"><h1>Title</h1><p>Body.</p></section>',
  '<custom-element data-x="1"><slot-content>hi</slot-content></custom-element>',
  '<div><!-- a comment --><p>x</p></div>',
  '<form action="/submit" method="post"><label for="n">Name</label></form>',
  '<nav><a href="/">Home</a><a href="/about">About</a></nav>',
  '<DIV CLASS="x">Hi</DIV>', '<svg:rect width="10" height="10"/>',
  '<a title="x < y & z">link</a>', '<!-- <div class="x"> is not a tag -->',
  '<input disabled required readonly>',
  '<my-widget data-config="{a:1}" aria-label="w">x</my-widget>',
  '<p>1 &lt; 2 &amp; 3</p>', '<td colspan=2 rowspan=3>cell</td>',
];
// Tricky tree-construction the existing fixtures touch only lightly: implied tags,
// <p> auto-close, table foster-parenting, <li>/<dd> siblings, formatting-element
// adoption (<b><i></b></i>), raw-text, void elements, nested same-name.
const trickyCorpus: string[] = [
  '<p>a<p>b<p>c',                                   // <p> auto-close chain (implied closes)
  '<p>x<div>y</div>',                               // <div> auto-closes the open <p>
  '<ul><li>a<li>b<li>c</ul>',                       // <li> siblings (implied <li> close)
  '<dl><dt>a<dd>b<dt>c<dd>d</dl>',                  // <dt>/<dd> implied-close siblings
  '<b><i>x</b>y</i>',                               // adoption agency (formatting reconstruct)
  '<b>1<p>2</b>3',                                  // adoption across a block element
  '<a><a>x</a></a>',                                // nested <a> -> adoption
  '<table><tr><td>1</td></tr></table>',             // implied <tbody> insertion
  '<table>foo<tr><td>1</td></table>',               // foster-parenting stray text out of table
  '<table><td>x</td></table>',                      // implied <tbody><tr> before <td>
  '<select><option>a<option>b</select>',            // <option> implied close in <select>
  '<div><p></div>',                                 // <p> implicitly closed by </div>
  '<span><span><span>deep</span></span></span>',    // deep same-name nesting
  '<form><for>x</for></form>',                      // tag a prefix of an open tag name
  '<div><i><input></i></div>',                      // void <input> not swallowed by <i>
  '<textarea>a<b>b</textarea>',                     // raw-text-ish: <b> is literal text
  '<title>a<b>b</title>',                           // RCDATA: <b> is literal text in <title>
  '<style>.a{color:red}</style>',                   // raw-text CSS
  '<script>if(a<b){}</script>',                     // raw-text JS with a bare <
  '<pre>\n  indented\n</pre>',                       // <pre> leading-newline handling
  '<h1>a</h1><h2>b</h2>',                            // sibling headings
  '<colgroup><col><col></colgroup>',                // <col> void in table column group
  '<ruby>han<rt>kan</rt></ruby>',                   // <ruby>/<rt> implied close
  '<menu><li>a<li>b</menu>',                         // <li> in <menu>
];
// Documented-bug snippets from html-issue-cases.ts (imported as DATA).
const issueCorpus: string[] = htmlIssueCases.map((c) => c.src);

// De-dup while preserving provenance for the report.
const sources: [string, string[]][] = [
  ['html-conformance.ts (well-formed)', conformanceCorpus],
  ['html-conformance.ts (unsupported/recovery)', unsupportedCorpus],
  ['html-bench.ts', benchCorpus],
  ['html-issue-cases.ts', issueCorpus],
  ['tricky tree-construction (added here)', trickyCorpus],
];
const seen = new Set<string>();
const corpus: { html: string; origin: string }[] = [];
for (const [origin, list] of sources) for (const html of list) {
  if (seen.has(html)) continue;
  seen.add(html);
  corpus.push({ html, origin });
}

// ── Coverage session. detailed:true -> block-level ranges = our "branches". ──
const session = new inspector.Session();
session.connect();
const post = (method: string, params?: any): Promise<any> =>
  new Promise((res, rej) => session.post(method, params, (e: any, r: any) => (e ? rej(e) : res(r))));

await post('Profiler.enable');
await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

// Warm parse5 so every script is registered with the profiler before we diff.
parseFragment('<div><p>a<b>x</b></p></div>');
parseFragment('<table><tr><td>c</td></table>');

const PARSE5_RE = /node_modules\/parse5\/dist\//;
const SEP = ' :: ';   // a delimiter that never appears in a URL or a JS function name
// Relative path INSIDE parse5's dist, e.g. "parser/index.js" — strip everything up to
// and including ".../node_modules/parse5/dist/" (it is an infix of a file:// URL).
const rel = (url: string) => url.replace(/^.*node_modules\/parse5\/dist\//, '');
// A branch key is stable across snapshots: relUrl + functionName + range offsets.
const branchKey = (url: string, fnName: string, s: number, e: number) =>
  [rel(url), fnName, s, e].join(SEP);

// Absolute path to parse5's dist/ — captured from a coverage URL (the script urls ARE
// file:// paths into dist). parse5's "exports" map blocks require.resolve of subpaths,
// so this is the reliable way to read its source for the offset->line mapping.
let parse5DistDir = '';

// Snapshot -> Map<branchKey, count>, only parse5 dist scripts. Includes count=0 ranges
// (instrumented-but-not-taken) inside any function that ran.
function snapshot(result: any[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of result) {
    if (!PARSE5_RE.test(s.url)) continue;
    if (!parse5DistDir) parse5DistDir = fileURLToPath(s.url).replace(/parse5[/\\]dist[/\\].*$/, 'parse5/dist/');
    for (const fn of s.functions) {
      for (const r of fn.ranges) {
        m.set(branchKey(s.url, fn.functionName, r.startOffset, r.endOffset), r.count);
      }
    }
  }
  return m;
}

// Per-branch aggregate state across the whole corpus.
interface BranchState {
  url: string; fnName: string; start: number; end: number;
  reachable: boolean;     // taken (positive delta) by >=1 file
  agreedHit: boolean;     // taken by >=1 agreeing file
  exampleFails: string[]; // disagreeing files that took it (for the ranked report)
}
const branches = new Map<string, BranchState>();
// Every branch key parse5 ever reported (count>0 OR count=0) = the instrumented universe.
const universe = new Set<string>();
function ensure(key: string): BranchState {
  let st = branches.get(key);
  if (!st) {
    const [url, fnName, s, e] = key.split(SEP);
    st = { url, fnName, start: Number(s), end: Number(e), reachable: false, agreedHit: false, exampleFails: [] };
    branches.set(key, st);
  }
  return st;
}

const wall0 = performance.now();
let monoThrew = 0;
let agreeCount = 0;
const treeFails: { html: string; origin: string; mono: string; off: string }[] = [];

for (const { html, origin } of corpus) {
  // Attribute parse5 branches to THIS file: snapshot, parse, snapshot.
  // CRITICAL: the agreement tree must come from the SAME parse5 call we measure — parsing
  // f twice (once for the agreement check, once for coverage) pre-warms the very branches
  // we want to attribute and the delta collapses to ~0. So ONE call drives both, and that
  // call is the only parse5 work inside the before/after window.
  const before = snapshot((await post('Profiler.takePreciseCoverage')).result);
  const offTreeRoot = parseFragment(html);               // the OFFICIAL parser on f (measured)
  const after = snapshot((await post('Profiler.takePreciseCoverage')).result);

  // Agreement verdict (Monogram tree vs parse5 tree). Monogram's parse runs OUTSIDE the
  // window so it never pollutes parse5's coverage (it is filtered by url anyway).
  let agree = false, monoStr = '<throw>';
  const offStr = JSON.stringify(p5Tree(offTreeRoot));
  try {
    monoStr = JSON.stringify(monoTree(parse(html)));
    agree = monoStr === offStr;
  } catch (e) {
    monoThrew++;
    monoStr = '<throw: ' + String((e as Error).message).split('\n')[0] + '>';
  }
  if (agree) agreeCount++;
  else treeFails.push({ html, origin, mono: monoStr, off: offStr });

  // Record the instrumented universe (every reported range) + reachability (positive delta).
  for (const [key, cnt] of after) {
    universe.add(key);
    const st = ensure(key);
    const prev = before.get(key) ?? 0;
    if (cnt <= prev) continue;                           // this branch was NOT taken by f
    st.reachable = true;
    if (agree) st.agreedHit = true;
    else if (st.exampleFails.length < 4 && !st.exampleFails.includes(html)) st.exampleFails.push(html);
  }
  for (const key of before.keys()) universe.add(key);    // also count branches seen pre-parse
}
const wall = performance.now() - wall0;
await post('Profiler.stopPreciseCoverage');

// Make sure every universe key has a state object (count=0-only branches = uncovered).
for (const key of universe) ensure(key);

// ── Classify. ──
let reachable = 0, agreed = 0, disagreed = 0, uncovered = 0;
const disagreedList: BranchState[] = [];
for (const st of branches.values()) {
  if (!st.reachable) { uncovered++; continue; }
  reachable++;
  if (st.agreedHit) agreed++;
  else { disagreed++; disagreedList.push(st); }    // reachable, never via an agreeing file
}
const totalSeen = branches.size;
const pct = (n: number, d: number) => (d === 0 ? '  n/a' : `${(100 * n / d).toFixed(1)}%`);

// ── Map a parse5 range start-offset to its 1-based source line (best-effort). ──
// parse5's dist is NOT minified, so offset -> line is meaningful. parse5DistDir was
// captured from a coverage URL above (its "exports" map blocks require.resolve subpaths).
const srcCache = new Map<string, string>();
function srcLineAt(relPath: string, offset: number): string {
  if (!parse5DistDir) return '';
  let text = srcCache.get(relPath);
  if (text === undefined) {
    try { text = readFileSync(parse5DistDir + relPath, 'utf-8'); }
    catch { text = ''; }
    srcCache.set(relPath, text);
  }
  if (!text) return '';
  const line = text.slice(0, offset).split('\n').length;
  const lineText = (text.split('\n')[line - 1] ?? '').trim();
  return `L${line}: ${lineText.slice(0, 100)}`;
}

// ── Report. ──
console.log('===========================================================================');
console.log('  Source-coverage parser-alignment metric — HTML (oracle = parse5, structural)');
console.log('===========================================================================\n');
console.log(`  corpus            : ${corpus.length} files (deduped), wall-clock ${(wall / 1000).toFixed(2)}s`);
for (const [origin, list] of sources) console.log(`    - ${list.length.toString().padStart(3)} from ${origin}`);
console.log(`  Monogram threw    : ${monoThrew}/${corpus.length}  (HTML has no reject; a throw = a Monogram parser gap)`);
console.log(`  tree-agree(f)     : ${agreeCount}/${corpus.length}  files where Monogram's tree === parse5's tree`);
console.log('');
console.log('  -- branch classification (block-level coverage of parse5 dist source) --');
console.log(`    total branches seen (reachable + uncovered) : ${totalSeen}`);
console.log(`    reachable (taken by >=1 file)                : ${reachable}`);
console.log(`      covered-and-agreed                         : ${agreed}`);
console.log(`      covered-but-disagreed                      : ${disagreed}`);
console.log(`    uncovered (instrumented, never taken)        : ${uncovered}`);
console.log('');
console.log('  -- headline ratios --');
console.log(`    alignment%            (agreed / reachable)      = ${pct(agreed, reachable)}`);
console.log(`    corpus-completeness%  (reachable / total-seen)  = ${pct(reachable, totalSeen)}`);
console.log('');

// covered-but-disagreed, ranked: a branch reached ONLY by files Monogram gets wrong.
// Rank by how many distinct failing files took it (more files => a more central divergence).
disagreedList.sort((a, b) => b.exampleFails.length - a.exampleFails.length || a.url.localeCompare(b.url) || a.start - b.start);
console.log(`  -- covered-but-disagreed branches (${disagreedList.length}) — ranked; each is a parse5 decision`);
console.log('     every input exercising it is one whose tree Monogram gets wrong --');
const TOP = Math.min(12, disagreedList.length);
for (let i = 0; i < TOP; i++) {
  const st = disagreedList[i];
  console.log(`  ${(i + 1).toString().padStart(2)}. ${st.url}  ${st.fnName || '(top-level)'}  @${st.start}`);
  const line = srcLineAt(st.url, st.start);
  if (line) console.log(`      ${line}`);
  console.log(`      e.g. ${st.exampleFails.slice(0, 3).map((s) => JSON.stringify(s)).join('  ')}`);
}
if (disagreedList.length > TOP) console.log(`  ... and ${disagreedList.length - TOP} more.`);
console.log('');

// The disagreeing files themselves — this is what drives the disagreed branches.
console.log(`  -- files where Monogram's tree != parse5's tree (${treeFails.length}) --`);
for (const f of treeFails) {
  console.log(`  x ${JSON.stringify(f.html)}   [${f.origin}]`);
  console.log(`      mono   : ${f.mono.slice(0, 160)}`);
  console.log(`      parse5 : ${f.off.slice(0, 160)}`);
}
console.log('\n  (prototype — see header for method)');
