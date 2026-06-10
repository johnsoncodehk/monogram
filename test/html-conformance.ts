// ─────────────────────────────────────────────────────────────────────────────
//  html-conformance.ts — HTML's conformance gate, oracle = `parse5` (the reference
//  WHATWG HTML parser). There is no `tsc` for HTML; B-lite measures the Monogram
//  parser against parse5 on WELL-FORMED input:
//    1. ACCEPTANCE — Monogram must parse every curated well-formed snippet (hard gate).
//    2. TREE-EQUIVALENCE — Monogram's element tree (tag names + nesting) must match
//       parse5's. This is the real conformance signal: same structure, not just "no throw".
//  parse5 recovers from anything (HTML has no invalid input), so a parse5-vs-Monogram
//  TREE match — not parse5 acceptance — is the bar. The `unsupported` list documents the
//  known B-lite gaps (optional close tags, DOCTYPE, full-document head/body insertion).
//
//  Run: node test/html-conformance.ts
// ─────────────────────────────────────────────────────────────────────────────
import { createParser } from '../src/gen-parser.ts';
import { parseFragment } from 'parse5';

const grammar = (await import('../html.ts')).default;
const { parse } = createParser(grammar);

import { monoTree, p5Tree } from './html-tree.ts';

// Curated WELL-FORMED HTML fragments (B-lite scope: proper nesting, explicit or
// self-closed/void tags). No DOCTYPE, no optional-close-tag leniency — those are
// in `unsupported`.
const corpus: string[] = [
  '<div></div>',
  '<div>hello</div>',
  '<div class="x" id="y">hi</div>',
  '<div class="a" data-n=5 disabled>hi</div>',
  '<p>a <b>bold</b> and <i>italic</i> c</p>',
  '<ul><li>one</li><li>two</li><li>three</li></ul>',
  '<section><h1>Title</h1><p>Body <a href="/x">link</a>.</p></section>',
  '<br/>',
  '<img src="a.png" alt="pic"/>',
  '<img src="a.png" alt="pic">',
  '<input type="text" placeholder="name" disabled>',
  '<p>line<br>break<br>here</p>',
  '<hr><hr>',
  '<meta charset="utf-8">',
  '<div><span>x</span><span>y</span></div>',
  '<table><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  '<nav><a href="/">Home</a> | <a href="/about">About</a></nav>',
  '<button type="submit" class="btn btn-primary">Go</button>',
  '<div><p>nested <strong>deep <em>deeper</em></strong> text</p></div>',
  '<figure><img src="p.jpg"><figcaption>cap</figcaption></figure>',
  '<script>var a = 1 < 2 && b > 3;</script>',
  '<style>.a > .b { color: red; }</style>',
  '<div><!-- a comment --><p>x</p></div>',
  '<p>Price: $5 — 50% off (today)!</p>',
  '<custom-element data-x="1"><slot-content>hi</slot-content></custom-element>',
  // Well-formed (proper nesting, explicit tags). parse5 inserts an implied <tbody> the
  // source omits; the oracle now normalises that synthesised container away, so this is a
  // true source-structure match — not the "B-lite gap" it was previously misfiled as.
  '<table><tr><td>1</td></tr></table>',
  // Optional (omittable) end tags — valid HTML now parsed (markup.optionalEndTags): an
  // element closes implicitly at a trigger sibling start tag (or any ancestor end tag).
  '<ul><li>a<li>b</ul>',
  '<p>a<p>b<p>c',
  '<dl><dt>a<dd>b<dt>c<dd>d</dl>',
  '<select><option>a<option>b</select>',
  '<p>x<div>y</div>',
  // Bare `<` that does not open a tag is TEXT (WHATWG tag-open state: `<` only opens a tag
  // before `[a-zA-Z/!?]`). parse5 keeps these as text; Monogram now matches (was a throw).
  '<p>a < b</p>',
  '<p>5 < 3</p>',
  // A raw-text element (script/style/textarea/title) is NEVER self-closing: a trailing `/>` is
  // IGNORED and the body runs as raw-text to the close tag. parse5 makes a <script> with body
  // "body"; Monogram now matches (the lexer drops the `/`, the parser raw-texts the body).
  '<script src="x"/>body</script>',
];

// Known B-lite gaps (documented, not gated): things parse5 handles via error-recovery
// or full-document construction that a well-formed CFG doesn't.
const unsupported: [string, string][] = [
  ['DOCTYPE', '<!DOCTYPE html><html><body>x</body></html>'],
];

let accepted = 0, treeMatch = 0;
const acceptFails: string[] = [], treeFails: string[] = [];
for (const html of corpus) {
  let mono: any;
  try { mono = parse(html); accepted++; }
  catch (e) { acceptFails.push(`${html}\n      → ${String((e as Error).message).split('\n')[0]}`); continue; }
  const a = JSON.stringify(monoTree(mono, html));
  const b = JSON.stringify(p5Tree(parseFragment(html, { sourceCodeLocationInfo: true })));
  if (a === b) treeMatch++;
  else treeFails.push(`${html}\n      mono:   ${a}\n      parse5: ${b}`);
}

console.log(`── HTML conformance vs parse5 (${corpus.length} well-formed fragments) ──`);
console.log(`  accepted     : ${accepted}/${corpus.length}`);
console.log(`  tree-match   : ${treeMatch}/${corpus.length}  (element names + nesting === parse5)`);
if (acceptFails.length) { console.log('\n  ACCEPT FAILURES (valid HTML we reject):'); for (const f of acceptFails) console.log('    - ' + f); }
if (treeFails.length)   { console.log('\n  TREE MISMATCHES (parsed, but wrong structure):'); for (const f of treeFails) console.log('    - ' + f); }
console.log(`\n  known B-lite gaps (documented, not gated): ${unsupported.map(u => u[0]).join(', ')}`);

if (accepted < corpus.length || treeMatch < corpus.length) {
  console.log('\n✗ HTML conformance FAILED');
  process.exit(1);
}
console.log('\n✓ HTML conformance: parses every well-formed fragment with the same element tree as parse5');
