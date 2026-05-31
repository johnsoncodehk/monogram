// ─────────────────────────────────────────────────────────────────────────────
//  html-treesitter.ts — gates the DERIVED tree-sitter HTML grammar (v1). Loads the
//  wasm built from tree-sitter/html/grammar.js, parses well-formed HTML, and checks
//    1. NO ERROR nodes (the GLR parser accepts it), and
//    2. TREE-EQUIVALENCE — the element tree (tag names + nesting) matches parse5,
//  the same oracle html-conformance.ts uses for the recursive-descent parser.
//
//  v1 scope: raw-text element bodies (<script>/<style>) are ordinary text, so a literal
//  `<` inside them isn't supported yet (an external scanner is the next increment) —
//  see `unsupported`. Build the wasm first:
//    cd tree-sitter/html && npx tree-sitter generate && npx tree-sitter build --wasm .
//
//  Run: node test/html-treesitter.ts
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync } from 'node:fs';
import { parseFragment } from 'parse5';

const WASM = 'tree-sitter/html/tree-sitter-html.wasm';
if (!existsSync(WASM)) {
  console.error(`✗ Monogram tree-sitter wasm not found at ${WASM}\n  Build it: cd tree-sitter/html && npx tree-sitter generate && npx tree-sitter build --wasm .`);
  process.exit(1);
}

const { Parser, Language } = await import('web-tree-sitter');
await Parser.init();
const lang = await Language.load(WASM);
const parser = new Parser();
parser.setLanguage(lang);

interface El { tag: string; children: El[] }

// Element tree (tag + nested elements only) from a tree-sitter node.
function tsTree(node: any): El[] {
  const out: El[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'element') out.push({ tag: ownTag(child), children: tsTree(child) });
  }
  return out;
}
function ownTag(element: any): string {
  // element's first named child is start_tag | self_closing_tag | void_element; the
  // tag_name lives directly under it (the void name is aliased to tag_name).
  const head = element.namedChildren[0];
  const tn = head?.namedChildren.find((c: any) => c.type === 'tag_name');
  return (tn?.text ?? '').toLowerCase();
}
function hasError(root: any): boolean {
  const he = root.hasError;
  if (typeof he === 'function') return root.hasError();
  if (typeof he === 'boolean') return he;
  // fallback: walk for an ERROR node
  const stack = [root];
  while (stack.length) { const n = stack.pop(); if (n.type === 'ERROR' || n.isMissing) return true; stack.push(...n.children); }
  return false;
}

// Same element tree from a parse5 fragment.
function p5Tree(node: any): El[] {
  const out: El[] = [];
  for (const c of node.childNodes ?? []) if (c.tagName) out.push({ tag: c.tagName.toLowerCase(), children: p5Tree(c) });
  return out;
}

// Well-formed corpus — like html-conformance.ts, but raw-text bodies carry no inner `<`
// (the v1 limitation). Element nesting must match parse5.
const corpus: string[] = [
  '<div></div>',
  '<div>hello</div>',
  '<div class="x" id="y">hi</div>',
  '<p>a <b>bold</b> and <i>italic</i> c</p>',
  '<ul><li>one</li><li>two</li><li>three</li></ul>',
  '<br/>',
  '<img src="a.png" alt="pic">',
  '<input type="text" placeholder="name" disabled>',
  '<p>line<br>break<br>here</p>',
  '<hr><hr>',
  '<meta charset="utf-8">',
  '<div><span>x</span><span>y</span></div>',
  '<table><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  '<section><h1>Title</h1><p>Body <a href="/x">link</a>.</p></section>',
  '<button type="submit" class="btn">Go</button>',
  '<div><p>nested <strong>deep <em>deeper</em></strong> text</p></div>',
  '<figure><img src="p.jpg"><figcaption>cap</figcaption></figure>',
  '<script>var a = 1;</script>',                      // raw text w/o inner `<`
  '<style>.a { color: red; }</style>',                // raw text w/o inner `<`
  '<div><!-- a comment --><p>x</p></div>',
  '<custom-element data-x="1"><slot-content>hi</slot-content></custom-element>',
];

// Deferred to the external-scanner increment (documented, not gated).
const unsupported: [string, string][] = [
  ['raw-text body with a literal `<`', '<script>if (a < b) {}</script>'],
  ['optional close tags / DOCTYPE / implicit tbody', '<ul><li>a<li>b</ul>'],
];

let parsed = 0, treeMatch = 0;
const errFails: string[] = [], treeFails: string[] = [];
for (const html of corpus) {
  const tree = parser.parse(html);
  if (hasError(tree.rootNode)) { errFails.push(html); continue; }
  parsed++;
  const a = JSON.stringify(tsTree(tree.rootNode));
  const b = JSON.stringify(p5Tree(parseFragment(html)));
  if (a === b) treeMatch++;
  else treeFails.push(`${html}\n      tree-sitter: ${a}\n      parse5:      ${b}`);
}

console.log(`── HTML tree-sitter (v1) vs parse5 (${corpus.length} well-formed fragments) ──`);
console.log(`  parsed (no ERROR) : ${parsed}/${corpus.length}`);
console.log(`  tree-match        : ${treeMatch}/${corpus.length}  (element names + nesting === parse5)`);
if (errFails.length) { console.log('\n  PARSE ERRORS:'); for (const f of errFails) console.log('    - ' + f); }
if (treeFails.length) { console.log('\n  TREE MISMATCHES:'); for (const f of treeFails) console.log('    - ' + f); }
console.log(`\n  v1 deferred (external scanner — documented, not gated): ${unsupported.map(u => u[0]).join(', ')}`);

if (parsed < corpus.length || treeMatch < corpus.length) {
  console.log('\n✗ HTML tree-sitter FAILED');
  process.exit(1);
}
console.log('\n✓ HTML tree-sitter: parses every well-formed fragment with the same element tree as parse5');
