// src-coverage-html.ts — HTML adapter for the source-coverage parser-alignment metric.
// Oracle = STRUCTURAL: HTML has no reject (parse5 recovers from anything to a tree), so
// agreement compares the produced element TREES. O(f) = parse5's tree; M(f) = Monogram's
// markup-mode CST normalized to the same shape; agree(f) = O(f) deep-equals M(f). The
// agnostic core (coverage harness, per-branch classification, ratios, offset->line disagree
// ledger) lives in ./src-coverage.ts — this file supplies the 4 knobs + a failing-files tail.
//
// REUSE. parse5 invocation (parseFragment), tree normalization (monoTree/p5Tree), the
// comparison (JSON.stringify deep-equal) and the Monogram-parser invocation are taken
// VERBATIM from test/html-conformance.ts. Corpus pools the fixtures from html-conformance.ts,
// html-bench.ts and html-issue-cases.ts, plus tricky tree-construction cases.
//
// Run: node test/src-coverage-html.ts
import { createParser } from '../src/gen-parser.ts';
import { parseFragment } from 'parse5';
import { cases as htmlIssueCases } from './html-issue-cases.ts';
import { run, type AgreeResult, type CorpusItem } from './src-coverage.ts';

const grammar = (await import('../html.ts')).default;
const { parse } = createParser(grammar);

import { monoTree, p5Tree } from './html-tree.ts';

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
const unsupportedCorpus: string[] = [
  '<ul><li>a<li>b</ul>', '<!DOCTYPE html><html><body>x</body></html>',
  '<p>a < b</p>', '<table><tr><td>1</td></tr></table>',
];
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
const trickyCorpus: string[] = [
  '<p>a<p>b<p>c', '<p>x<div>y</div>', '<ul><li>a<li>b<li>c</ul>',
  '<dl><dt>a<dd>b<dt>c<dd>d</dl>', '<b><i>x</b>y</i>', '<b>1<p>2</b>3', '<a><a>x</a></a>',
  '<table><tr><td>1</td></tr></table>', '<table>foo<tr><td>1</td></table>', '<table><td>x</td></table>',
  '<select><option>a<option>b</select>', '<div><p></div>', '<span><span><span>deep</span></span></span>',
  '<form><for>x</for></form>', '<div><i><input></i></div>', '<textarea>a<b>b</textarea>',
  '<title>a<b>b</title>', '<style>.a{color:red}</style>', '<script>if(a<b){}</script>',
  '<pre>\n  indented\n</pre>', '<h1>a</h1><h2>b</h2>', '<colgroup><col><col></colgroup>',
  '<ruby>han<rt>kan</rt></ruby>', '<menu><li>a<li>b</menu>',
];
const issueCorpus: string[] = htmlIssueCases.map((c) => c.src);

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

// ── Verdict state (mode-specific, surfaced in header/footer). ──
let monoThrew = 0;
const treeFails: { html: string; mono: string; off: string }[] = [];

await run({
  name: 'HTML',
  oracle: 'structural tree-equality (parse5)',
  urlMatch: (url) => /node_modules\/parse5\/dist\//.test(url),
  loadCorpus: (): CorpusItem[] => corpus.map((c) => ({ code: c.html, origin: c.origin })),
  warmup: () => { const o = { sourceCodeLocationInfo: true } as const; parseFragment('<div><p>a<b>x</b></p></div>', o); parseFragment('<table><tr><td>c</td></table>', o); },
  // CRITICAL: parseFragment is the ONE measured official parse. The agreement tree comes
  // from THIS call's result (reused below) — never re-parse parse5, or the per-file delta
  // collapses (the harness snapshots immediately after this returns, before Monogram runs).
  runOfficial: (html) => ({ tree: JSON.stringify(p5Tree(parseFragment(html, { sourceCodeLocationInfo: true }))) }),
  agree: (html, official): AgreeResult => {
    const off = (official as { tree: string }).tree;
    let monoStr = '<throw>', agree = false;
    try { monoStr = JSON.stringify(monoTree(parse(html), html)); agree = monoStr === off; }
    catch (e) { monoThrew++; monoStr = '<throw: ' + String((e as Error).message).split('\n')[0] + '>'; }
    if (!agree) treeFails.push({ html, mono: monoStr, off });
    return { agree };
  },
  denominators: [{ label: 'all of parse5 dist', keep: () => true }],
  ledgerTop: 12,
  renderHeader: (_results, corpus) => {
    for (const [origin, list] of sources) console.log(`    - ${list.length.toString().padStart(3)} from ${origin}`);
    console.log(`  Monogram declined (threw): ${monoThrew}/${corpus.length} (HTML has no reject; parse5 recovers from anything — see the footer for the declined-vs-wrong-tree split)`);
  },
  renderFooter: () => {
    // Classify the residual disagreements by NATURE (the honest breakdown — the headline
    // agree count above already counts BOTH; this separates them so the real gaps stay visible).
    // A THROW = Monogram declined the input (parse5 recovers from anything; on the current corpus
    // these are malformed — overlap/adoption-agency — or out-of-fragment, e.g. DOCTYPE, where a
    // CST parser declining is the B-lite design, not a wrong answer). A WRONG-TREE = Monogram
    // parsed but produced a structure != parse5: a positive wrong claim = a genuine structural gap.
    const wrong = treeFails.filter((f) => !f.mono.startsWith('<throw'));
    const threw = treeFails.filter((f) => f.mono.startsWith('<throw'));
    console.log(`\n  -- ${treeFails.length} disagreement(s) = ${threw.length} declined (threw) + ${wrong.length} WRONG-TREE (real structural gap) --`);
    if (wrong.length) {
      console.log(`  WRONG-TREE (Monogram parsed, structure != parse5 — the real gaps):`);
      for (const f of wrong) {
        console.log(`  x ${JSON.stringify(f.html)}`);
        console.log(`      mono   : ${f.mono.slice(0, 160)}`);
        console.log(`      parse5 : ${f.off.slice(0, 160)}`);
      }
    }
    if (threw.length) {
      console.log(`  declined (threw — parse5 recovers, Monogram does not):`);
      for (const f of threw) console.log(`  x ${JSON.stringify(f.html)}  ${f.mono.slice(0, 70)}`);
    }
  },
});
