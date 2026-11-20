// ─────────────────────────────────────────────────────────────────────────────
//  html-conformance.ts — HTML's conformance gate, oracle = `parse5` (the reference
//  WHATWG HTML parser). There is no `tsc` for HTML; B-lite measures the Monogram
//  parser against parse5 on WELL-FORMED input:
//    1. ACCEPTANCE — Monogram must parse every curated well-formed snippet (hard gate).
//    2. TREE-EQUIVALENCE — Monogram's element tree (tag names + nesting) must match
//       parse5's. This is the real conformance signal: same structure, not just "no throw".
//  parse5 recovers from anything (HTML has no invalid input), so a parse5-vs-Monogram
//  TREE match — not parse5 acceptance — is the bar. The `unsupported` list documents the
//  known B-lite gaps (DOCTYPE, full-document head/body insertion).
//    3. REJECTION — the `malformed` list: input outside the well-formed language (an end tag
//       that closes no open element) must be REJECTED. parse5 cannot be the oracle for a
//       verdict (it recovers from anything); the rule is the WHATWG syntax itself — §13.1.2.2:
//       an end tag's name is the name of the element it ends — which the tree-construction
//       stage reports as a parse error for every input listed.
//    4. ENGINE PARITY — the emitted parser (src/emit-parser.ts) is held to all of the above:
//       the same verdict as the interpreter on every input here, and a byte-identical CST on
//       every accepted one. (emit-parser-verify.ts pins that parity for TypeScript only; the
//       markup element arm — optional end tags, the end tag's name — is exercised here.)
//
//  Run: node test/html-conformance.ts
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createParser } from '../src/gen-parser.ts';
import { emitParser, jsTarget } from '../src/emit.ts';
import { objectify, type TreeView } from './emitted-obj.ts';
import { parseFragment } from 'parse5';
import { scratchDir } from './scratch.ts';

const grammar = (await import('../html.ts')).default;
const { parse } = createParser(grammar);

// The emitted parser for the same grammar, in a directory of this run's own.
const TMP = scratchDir('html-conformance');
writeFileSync(join(TMP, 'html.mts'), emitParser(grammar, jsTarget));
const emitted = ((await import(join(TMP, 'html.mts'))) as {
  createParser(): { parse(s: string): { root: number; errors: unknown[] }; visit(c: object, fns: object): void; tree: TreeView };
}).createParser();
// The emitted parser's verdict and (when it accepts) its CST as the interpreter shapes one.
function emittedParse(html: string): unknown | null {
  const c = emitted.parse(html);
  return c.errors.length === 0 ? objectify(emitted.tree, (fns) => emitted.visit(c, fns)) : null;
}

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
  // Tag names are ASCII case-insensitive (WHATWG §13.1.2): an end tag names its element in
  // any case.
  '<a></A>',
  '<DIV><Span>x</SPAN></div>',
  // …and so are the optional-end-tag names and their trigger siblings.
  '<UL><LI>a<li>b</Ul>',
  '<P>a<DIV>b</div>',
  // An optional-end element closed by an ANCESTOR's end tag, at each depth.
  '<ul><li>a</ul>',
  '<div><p>a</div>',
  '<table><tr><td>a<td>b<tr><td>c</table>',
  '<div><ul><li>a<p>b</ul></div>',
  // An optional end tag that IS written still closes its own element.
  '<ul><li>a</li><li>b</li></ul>',
  '<p>a</p><p>b</p>',
  // An optional-end element left open at the end of input.
  '<p>a',
  '<li>a<li>b',
];

// MALFORMED: an end tag whose name is not its element's. Not in the well-formed language —
// every engine rejects. (Near misses of the accepted cases above: the name differs outright,
// is a strict prefix or extension of the open name, differs after a shared prefix, or the two
// end tags of properly opened elements are crossed.)
const malformed: string[] = [
  '<a></b>',
  '<aA></a>',
  '<aA> </a>',
  '<a></aA>',
  '<ab></ac>',
  '<div><span></div></span>',
  '<div><span>x</div>',
  '<a><b></a></b>',
  // An optional-end element does not take another element's end tag either: `</div>` and
  // `</span>` close nothing here.
  '<p>a</div>',
  '<div><p>a</span></div>',
  '<ul><li>a</ol>',
  // A non-optional element still requires its end tag.
  '<div>',
  '<div><span></div>',
  // A stray end tag.
  '</a>',
  '<p></p></p>',
];

// Known B-lite gaps (documented, not gated): things parse5 handles via error-recovery
// or full-document construction that a well-formed CFG doesn't.
const unsupported: [string, string][] = [
  ['DOCTYPE', '<!DOCTYPE html><html><body>x</body></html>'],
];

let accepted = 0, treeMatch = 0, emittedSame = 0;
const acceptFails: string[] = [], treeFails: string[] = [], emittedFails: string[] = [];
for (const html of corpus) {
  let mono: any;
  try { mono = parse(html); accepted++; }
  catch (e) { acceptFails.push(`${html}\n      → ${String((e as Error).message).split('\n')[0]}`); continue; }
  const em = emittedParse(html);
  if (em === null) emittedFails.push(`${html}\n      → the emitted parser rejects`);
  else if (JSON.stringify(em) !== JSON.stringify(mono)) emittedFails.push(`${html}\n      → the emitted parser's CST differs from the interpreter's`);
  else emittedSame++;
  const a = JSON.stringify(monoTree(mono, html));
  const b = JSON.stringify(p5Tree(parseFragment(html, { sourceCodeLocationInfo: true })));
  if (a === b) treeMatch++;
  else treeFails.push(`${html}\n      mono:   ${a}\n      parse5: ${b}`);
}

let rejected = 0;
const rejectFails: string[] = [];
for (const html of malformed) {
  let interp = false;
  try { parse(html); } catch { interp = true; }
  const em = emittedParse(html) === null;
  if (interp && em) rejected++;
  else rejectFails.push(`${html}\n      → interpreter ${interp ? 'rejects' : 'ACCEPTS'}, emitted parser ${em ? 'rejects' : 'ACCEPTS'}`);
}

console.log(`── HTML conformance vs parse5 (${corpus.length} well-formed fragments) ──`);
console.log(`  accepted     : ${accepted}/${corpus.length}`);
console.log(`  tree-match   : ${treeMatch}/${corpus.length}  (element names + nesting === parse5)`);
console.log(`  emitted      : ${emittedSame}/${corpus.length}  (emitted parser accepts, CST === interpreter's)`);
console.log(`  rejected     : ${rejected}/${malformed.length}  (malformed fragments, both engines)`);
if (acceptFails.length) { console.log('\n  ACCEPT FAILURES (valid HTML we reject):'); for (const f of acceptFails) console.log('    - ' + f); }
if (treeFails.length)   { console.log('\n  TREE MISMATCHES (parsed, but wrong structure):'); for (const f of treeFails) console.log('    - ' + f); }
if (emittedFails.length) { console.log('\n  EMITTED-PARSER FAILURES (the two engines differ on valid HTML):'); for (const f of emittedFails) console.log('    - ' + f); }
if (rejectFails.length) { console.log('\n  REJECT FAILURES (malformed HTML an engine accepts):'); for (const f of rejectFails) console.log('    - ' + f); }
console.log(`\n  known B-lite gaps (documented, not gated): ${unsupported.map(u => u[0]).join(', ')}`);

if (accepted < corpus.length || treeMatch < corpus.length || emittedSame < corpus.length || rejected < malformed.length) {
  console.log('\n✗ HTML conformance FAILED');
  process.exit(1);
}
console.log('\n✓ HTML conformance: both engines parse every well-formed fragment to one CST, with the same element tree as parse5, and reject every malformed one');
