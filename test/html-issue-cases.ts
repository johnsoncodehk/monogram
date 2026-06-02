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
const isJs = (s: string) => s.includes('source.js');                  // delegated to the JS grammar
const isCss = (s: string) => s.includes('source.css');                // delegated to the CSS grammar
const isTagPunct = (s: string) => s.includes('punctuation.definition.tag'); // a `<` `>` `/` delimiter

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

  // ── #81 (entities), #102 (`<style>`/`<script>` embedding) and #113 (`on*` JS) WERE Monogram-only
  //    gaps, now CLOSED: html.ts gained `markup.entity`, a `rawText.embed` map (delegating CSS — and
  //    Monogram's OWN JS — to the platform grammars), and `markup.attributeEmbed` (`on*`→source.js).
  //    All graded against the REAL embedded JS/CSS so a ✓ means *correctly highlighted*, not merely
  //    delegated — for #113 that's the whole point: the official DOES embed JS in `on*` yet still
  //    mis-reads `//` in the string as a comment (its inline-JS value rule hand-rolls a `//`
  //    splitter), so it can't win even with the embed; Monogram delegates the whole value to its
  //    own source.js (capture-bounded, the same helper Vue directive values use) and reads it right.
  { id: 'tmbundle#113', title: '`//` in an `onclick=` JS string read as a comment', src: `<input onclick="location.href='https://x.org/'">`,
    at: '//', want: s => s.includes('source.js') && !s.includes('comment') }, // official: hand-rolled // splitter reads it as a comment (bug); Monogram: capture-embedded source.js keeps it a string
  { id: 'tmbundle#81', title: 'character entity `&amp;` in text', src: '<p>x &amp; z</p>',
    at: '&amp;', want: s => s.includes('constant.character.entity') },        // both scope it now — Monogram via markup.entity (was a Text blob), official natively
  { id: 'tmbundle#102', title: '`<style>` element CSS is tokenized, not a flat blob', src: '<style>.a{color:red}</style>',
    at: 'color', want: s => s.includes('support.type.property-name.css') },   // both embed real CSS (color = property-name) — Monogram now delegates source.css like the official (was an untokenized blob)

  // ── Embedded-language boundaries & inline-language attributes. Graded against the REAL
  //    embeds (Monogram's own source.js, VS Code's source.css) so a ✓ means correctly
  //    highlighted, not merely delegated. These mix every honest verdict — only-Monogram,
  //    both-pass, AND only-official (#85), which is NOT a shared ceiling but a documented,
  //    PROVEN tradeoff: fixing it agnostically would regress #5538 and/or leak source.js onto
  //    the close `<` (#65/#74); the official only "wins" by hand-patching JS's comment grammar
  //    (non-agnostic). The full mechanism + the measured begin/end experiment are at #85 below.
  { id: 'tmbundle#104', title: 'mixed-case `onChange=` event handler still reads as JS', src: '<div onChange="cb()"></div>',
    at: 'cb', want: isJs },                                                   // official: case-sensitive `on*` list → `onChange` is meta.attribute.unrecognized, value stays a plain string; Monogram lower-cases the `on*` test so the value delegates to source.js like `onchange`
  { id: 'tmbundle#50', title: '`onclick=` event-handler value is colored as JS', src: '<button onclick="run(1)">x</button>',
    at: 'run', want: isJs },                                                  // both embed source.js in the (lower-case) handler value now (was a flat string) — `run` is entity.name.function.js
  { id: 'tmbundle#88', title: 'inline `style=` value embeds CSS', src: '<div style="color:red"></div>',
    at: 'red', want: isCss },                                                 // both embed source.css in the `style=` value now — Monogram delegates it via the same capture-bounded attribute embed as `on*`→source.js (markup.attributeEmbed `style`→source.css), matching VS Code's inline-CSS delegation
  { id: 'tmbundle#65', title: '`<` of `</script>` is HTML punctuation, not `source.js`', src: '<script>var a=1;</script>',
    at: '<', nth: 2, want: s => isTagPunct(s) && !isJs(s) },                  // official leaks the embedded source.js scope onto the close-tag `<` (vscode-textmate force-pops it as `source.js-ignored-vscode`), miscoloring it under a JS theme; Monogram closes the embed before the `<`
  { id: 'tmbundle#74', title: '`<` of `</style>` is HTML punctuation, not `source.css`', src: '<style>.a{}</style>',
    at: '<', nth: 2, want: s => isTagPunct(s) && !isCss(s) },                 // same leak for CSS: official tags the `</style>` `<` with source.css; Monogram does not
  { id: 'tmbundle#85', title: '`//</script>` on its own line still closes the script', src: '<script>\n//</script>\n<p>z</p>',
    at: 'z', want: s => !isJs(s) },                                          // ONLY-OFFICIAL, and a DEFENSIBLE tradeoff (proven, not a silent miss):
    //   The fix and the win are MUTUALLY EXCLUSIVE under the agnostic constraint, because of how
    //   vscode-textmate arbitrates a host region's close against a SEPARATE embedded grammar:
    //     • Monogram's multi-line raw-text region is `begin/while` (`while: ^(?!\s*</script…)`).
    //       `while`'s line-start re-check is the ONLY TextMate mechanism that force-UNWINDS a
    //       still-open embedded *multi-line* construct (a TS `meta.type.body`, a JS template/regex)
    //       at the close-tag line — which is exactly what wins #5538/#2060 (`export type T` with no
    //       `;` before `</script>`) and keeps the close `<` CLEAN tag punctuation (the #65/#74 win).
    //       But `while` is `^`-anchored, so it can only drop the region when a line *starts* with
    //       `</script>`; it structurally cannot catch the MID-LINE close in `//</script>` → #85 stuck.
    //     • Switching to `begin/end` (end = `(?=^\s*</tag)|(<)(?=/tag)`, both the line-start and the
    //       per-position alt, i.e. the official's own shape) was BUILT + MEASURED here: it still
    //       FAILS #85 *and* REGRESSES #5538 to 18/19. It fails #85 because Monogram embeds the REAL
    //       `source.js`, whose line comment is `match: //[^\n]*` — a leftmost-match that claims the
    //       whole `//</script>` line at col 0 before the host `end` (at col 2) is ever tried; an
    //       `end`/sibling rule cannot preempt an embedded rule that matches at an earlier column.
    //       It regresses #5538 because `begin/end` does NOT unwind the open embedded TS type-body at
    //       the close line (only `while` does) → that body swallows `</script>` and the template
    //       never recovers. (Confirmed: vue-issues 18/19, vue-dropin 18/19 under that form.)
    //   VS Code "wins" both ONLY by NOT using the real embed: it re-declares JS's own comment / block
    //   / string rules with a baked-in `end:(?=</script)|\n` guard before `include source.js`, so the
    //   comment voluntarily yields before the close tag. That is a JS-syntax-specific patch — to copy
    //   it, gen-tm.ts would have to KNOW the embedded language has `//`,`/*…*/`, backticks, regex (and
    //   rewrite each with a `</script>` guard), violating the agnostic constraint (delimiters/tag are
    //   config DATA; the embedded language's comment grammar is not). And the official PAYS for #85
    //   with the very leak Monogram beats it on: its `(<)(?=/script)` end marks EVERY close-tag `<`
    //   `source.js-ignored-vscode` (contains `source.js`) — see #65/#74, which Monogram keeps clean.
    //   So: Monogram trades the rare `//</script>` mid-comment close (multi-line `<script>` only; the
    //   single-line `<script>//…</script>` #72 closes fine on the inline path) to keep the common
    //   clean close (#65/#74) and the trailing-type unwind (#5538) — and stays language-agnostic.
  { id: 'tmbundle#51', title: 'self-closing `/` is tag punctuation', src: '<img src="a.png" />',
    at: '/', want: isTagPunct },                                             // both scope the `/` of `/>` as punctuation.definition.tag (was plain text in old TextMate)
  { id: 'tmbundle#82', title: '`<script type="application/json">` body is not parsed as HTML', src: '<script type="application/json">{"k":1}</script>',
    at: 'k', want: s => !isTag(s) && !s.includes('invalid') && !s.includes('.error') }, // the JSON body broke HTML highlighting historically; now neither treats its `{...}` as markup — official drops it into source.unknown, Monogram tokenizes it via source.js (JSON ⊂ JS), and `</script>` still closes
];
