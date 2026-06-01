// html-issue-cases.ts — REAL bugs documented against the official html.tmbundle / VS Code
// HTML grammar, as DATA (no side effects). Each snippet is valid HTML (parse5 parses it);
// the question is whether the grammar scopes the marked span correctly. Shared by the
// README cross-language ✓ table (test/issue-table.ts). The companion html-bench.ts grades
// the same snippets per-char against parse5; here each carries an explicit checkpoint so the
// grammars can be graded uniformly with TS/Vue. ids cite the upstream trackers.

export interface HtmlCase { id: string; title: string; src: string; at: string; nth?: number; want: (scope: string) => boolean; }

const isTag = (s: string) => s.includes('entity.name.tag');
const isString = (s: string) => s.includes('string');                 // a quoted/unquoted attr VALUE
const notAttrName = (s: string) => !s.includes('entity.other.attribute-name');
const isText = (s: string) => s.includes('text') && !s.includes('entity') && !s.includes('string');

export const cases: HtmlCase[] = [
  { id: 'tmbundle#118', title: 'trailing `/` in an unquoted URL value', src: '<a href=https://example.org/>foo</a>',
    at: '/', nth: 2, want: isString },                                        // the trailing `/` is still the VALUE (official breaks before it)
  { id: 'tmbundle#124', title: 'slash in unquoted value `foo/`', src: '<img class=foo/>',
    at: 'foo', want: s => isString(s) && notAttrName(s) },
  { id: 'vscode#140360', title: '`/` inside an unquoted value (path)', src: '<link rel=stylesheet href=/css/app.css>',
    at: '/', want: isString },                                                // the slash is part of the VALUE, not punctuation
  { id: 'tmbundle#84', title: 'tag name a prefix of a sibling (`<i>`/`<input>`)', src: '<div><i><input></i></div>',
    at: 'input', want: isTag },                                               // <input> is a tag, not swallowed by <i>
  { id: 'tmbundle#117', title: 'SVG camelCase tag name', src: '<svg><animateTransform attributeName="x"/></svg>',
    at: 'animateTransform', want: isTag },
  { id: 'tmbundle#122', title: '`<` inside a quoted attr value', src: '<a data-q="a < b">y</a>',
    at: 'b', want: isString },                                                // still inside the string, not a new tag
  { id: 'tmbundle#115', title: '`>` inside a quoted attr value', src: '<button title="a > b">go</button>',
    at: 'go', want: isText },                                                 // the `>` didn't close the tag early
  { id: 'tmbundle#97', title: 'space before `>` in an end tag', src: '<section>x</section >',
    at: 'section', nth: 1, want: isTag },                                     // the close tag name is still a tag
  { id: 'tmbundle#108', title: 'nested `<svg>` is a valid tag, not flagged invalid', src: '<svg><svg></svg></svg>',
    at: 'svg', nth: 1, want: s => isTag(s) && !s.includes('invalid') },       // official's SVG-child whitelist marks a nested <svg> invalid.illegal; Monogram's generic nesting accepts it

  // ── #81 (entities) and #102 (`<style>`/`<script>` embedding) WERE Monogram-only gaps, now
  //    CLOSED: html.ts gained `markup.entity` and a `rawText.embed` map (delegating CSS — and
  //    Monogram's OWN JS — to the platform grammars), so both now grade ✓✓. #113 is the one
  //    remaining HTML both-miss: the official embeds JS in `on*` but mis-reads `//` in the
  //    string (the bug), and Monogram doesn't embed attribute JS at all. All graded against the
  //    REAL embedded JS/CSS so a ✓ means *correctly highlighted*, not merely delegated.
  { id: 'tmbundle#113', title: '`//` in an `onclick=` JS string read as a comment', src: `<input onclick="location.href='https://x.org/'">`,
    at: '//', want: s => s.includes('source.js') && !s.includes('comment') }, // official: real JS embed reads // as a comment (bug); Monogram: value is one HTML string, no source.js
  { id: 'tmbundle#81', title: 'character entity `&amp;` in text', src: '<p>x &amp; z</p>',
    at: '&amp;', want: s => s.includes('constant.character.entity') },        // both scope it now — Monogram via markup.entity (was a Text blob), official natively
  { id: 'tmbundle#102', title: '`<style>` element CSS is tokenized, not a flat blob', src: '<style>.a{color:red}</style>',
    at: 'color', want: s => s.includes('support.type.property-name.css') },   // both embed real CSS (color = property-name) — Monogram now delegates source.css like the official (was an untokenized blob)
];
