// ─────────────────────────────────────────────────────────────────────────────
//  html-lexer-spike.ts — proves the gen-lexer markup state machine (the B-lite
//  lexer re-architecture) tokenizes markup CORRECTLY, before any parser/generator
//  work depends on it. The risk it retires: can the lexer handle the things that
//  block a token-stream lexer on markup —
//    • raw-text elements: `<script>1 < 2</script>` — the `< 2` is RAW, not a tag;
//    • comments: `<!-- a < b -->` — the `< b` is not a tag;
//    • arbitrary text: `<p>Price: $5 — 50% (今天)!</p>` — never throws;
//    • tags / attributes / self-close / nesting / close tags.
//  All delimiters come from the grammar's `markup` config (no hardcoded HTML), so
//  this also demonstrates the machine is language-agnostic. Non-regression of the
//  existing token-stream languages is proved separately (agnostic.ts + the JS/TS
//  conformance gates) — they declare no `markup`, so the machine stays dormant.
//
//  Run: node test/html-lexer-spike.ts
// ─────────────────────────────────────────────────────────────────────────────
import { token, rule, defineGrammar, seq, plus, oneOf, range, anyChar, star, noneOf } from '../src/api.ts';
import { createLexer } from '../src/gen-lexer.ts';

// A minimal markup grammar: just enough tokens + a stub rule (so the `< > / =`
// punctuation literals are collected) + the declarative markup config. The lexer
// uses only tokens/literals/markup — it never parses the rule.
const word = oneOf(range('A', 'Z'), range('a', 'z'), range('0', '9'), '_');
const Name = token(seq(oneOf(range('a', 'z'), range('A', 'Z')), star(oneOf(word, '-'))), { identifier: true });
const AttrValue = token(seq('"', star(noneOf('"')), '"'), { string: true });
// Content tokens are emitted by the state machine; their patterns are placeholders
// (the lexer skips them in the regex-matcher loop — see markupTokenNames).
const Text = token(plus(noneOf('<')), { scope: 'text' });
const RawText = token(plus(noneOf('<')), { scope: 'source' });
const Comment = token(seq('<!--', star(anyChar(), { greedy: false }), '-->'), { scope: 'comment.block.html' });

const Element = rule($ => [['<', Name, '=', AttrValue, '/', '>']]); // mentions every punctuation literal

const html = defineGrammar({
  name: 'html-spike',
  tokens: { Name, AttrValue, Text, RawText, Comment },
  rules: { Element },
  entry: Element,
  markup: {
    textToken: 'Text',
    tagOpen: '<',
    tagClose: '>',
    closeMarker: '/',
    rawText: { tags: ['script', 'style', 'textarea', 'title'], token: 'RawText' },
    comment: { open: '<!--', close: '-->', token: 'Comment' },
  },
});

const { tokenize } = createLexer(html);

type Pair = [string, string]; // [token type ('' = punctuation literal), text]
interface Case { label: string; input: string; expect: Pair[] }

const cases: Case[] = [
  {
    label: 'tag + attribute + text + close tag',
    input: '<div class="x">hi</div>',
    expect: [
      ['', '<'], ['Name', 'div'], ['Name', 'class'], ['', '='], ['AttrValue', '"x"'], ['', '>'],
      ['Text', 'hi'],
      ['', '<'], ['', '/'], ['Name', 'div'], ['', '>'],
    ],
  },
  {
    label: 'RAW TEXT: `< 2` inside <script> is content, not a tag',
    input: '<script>var a = 1 < 2;</script>',
    expect: [
      ['', '<'], ['Name', 'script'], ['', '>'],
      ['RawText', 'var a = 1 < 2;'],
      ['', '<'], ['', '/'], ['Name', 'script'], ['', '>'],
    ],
  },
  {
    label: 'comment: `< b` inside <!-- --> is not a tag',
    input: '<!--a<b--><p>x</p>',
    expect: [
      ['Comment', '<!--a<b-->'],
      ['', '<'], ['Name', 'p'], ['', '>'],
      ['Text', 'x'],
      ['', '<'], ['', '/'], ['Name', 'p'], ['', '>'],
    ],
  },
  {
    label: 'self-closing tag with attribute',
    input: '<img src="a.png"/>',
    expect: [
      ['', '<'], ['Name', 'img'], ['Name', 'src'], ['', '='], ['AttrValue', '"a.png"'], ['', '/'], ['', '>'],
    ],
  },
  {
    label: 'arbitrary text (punctuation + Unicode) never throws',
    input: '<p>Price: $5 — 50% off (今天)!</p>',
    expect: [
      ['', '<'], ['Name', 'p'], ['', '>'],
      ['Text', 'Price: $5 — 50% off (今天)!'],
      ['', '<'], ['', '/'], ['Name', 'p'], ['', '>'],
    ],
  },
  {
    label: 'nested elements + significant text between siblings',
    input: '<ul><li>a</li> <li>b</li></ul>',
    expect: [
      ['', '<'], ['Name', 'ul'], ['', '>'],
      ['', '<'], ['Name', 'li'], ['', '>'], ['Text', 'a'], ['', '<'], ['', '/'], ['Name', 'li'], ['', '>'],
      ['Text', ' '],
      ['', '<'], ['Name', 'li'], ['', '>'], ['Text', 'b'], ['', '<'], ['', '/'], ['Name', 'li'], ['', '>'],
      ['', '<'], ['', '/'], ['Name', 'ul'], ['', '>'],
    ],
  },
  {
    label: 'style raw-text (CSS `>` child combinator stays content)',
    input: '<style>a > b { color: red }</style>',
    expect: [
      ['', '<'], ['Name', 'style'], ['', '>'],
      ['RawText', 'a > b { color: red }'],
      ['', '<'], ['', '/'], ['Name', 'style'], ['', '>'],
    ],
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  let actual: Pair[];
  try {
    actual = tokenize(c.input).map(t => [t.type, t.text] as Pair);
  } catch (e) {
    console.log(`✗ ${c.label}\n    threw: ${(e as Error).message}`);
    fail++;
    continue;
  }
  const a = JSON.stringify(actual), e = JSON.stringify(c.expect);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.log(`✗ ${c.label}`);
    console.log(`    input:    ${c.input}`);
    console.log(`    expected: ${e}`);
    console.log(`    actual:   ${a}`);
  }
}

console.log(`\nhtml-lexer-spike: ${pass}/${cases.length} cases pass`);
if (fail > 0) {
  console.log('✗ lexer markup state machine FAILED');
  process.exit(1);
}
console.log('✓ lexer markup state machine: raw-text, comments, arbitrary text, tags all correct');
