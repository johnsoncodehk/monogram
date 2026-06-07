// HTML — a markup language on the shared Monogram core. Unlike the token-stream
// languages (javascript.ts / typescript.ts), HTML opts into the lexer's MARKUP
// MODE (see `markup` below): text between tags is one token, raw-text elements
// (<script>/<style>) scan verbatim to their close tag, and comments are scanned
// whole. The parser then consumes that stream with ordinary recursive-descent
// rules — element nesting, attributes, text/comment/raw nodes.
//
// Scope: B-lite — WELL-FORMED HTML (proper nesting / explicit or self-closing
// tags). It does not implement the WHATWG error-recovery tree-construction
// algorithm (that is not a context-free grammar); conformance is measured against
// `parse5` on well-formed input. See memory: html-vue-markup.
import { token, rule, defineGrammar, many, opt, alt, altPattern, seq, oneOf, noneOf, range, anyChar, star, plus, notFollowedBy } from './src/api.ts';
import type { MarkupConfig } from './src/types.ts';

// ── Tokens ──
// ASCII word chars [A-Za-z0-9_] — NOT `\w` (Oniguruma treats `\w` as Unicode-aware); tag/attr
// names and the `on*` embed selector are intentionally ASCII, so the IR enumerates the set.
const word = oneOf(range('A', 'Z'), range('a', 'z'), range('0', '9'), '_');
const whitespace = oneOf('\t', '\n', '\f', '\r', ' ');

// Tag and attribute names: a letter, then name chars (incl. `-` for custom
// elements / data-*, `:` for namespaced names like `xlink:href`).
const Name = token(seq(oneOf(range('a', 'z'), range('A', 'Z')), star(oneOf(word, ':', '.', '-'))), { identifier: true });
// An OPEN void-element name (`br`, `img`, `meta`, …). The lexer retags these from
// Name (driven by `markup.voidTags`); the pattern is a placeholder, never matched
// fresh. A distinct token lets the parser's void branch match void elements without
// the generic engine knowing any tag names.
const VoidName = token(seq(oneOf(range('a', 'z'), range('A', 'Z')), star(oneOf(word, ':', '.', '-'))), { scope: 'entity.name.tag' });
// Quoted attribute value (double or single).
const AttrValue = token(altPattern(seq('"', star(noneOf('"')), '"'), seq("'", star(noneOf("'")), "'")), { string: true });
// Unquoted attribute value (`colspan=2`, `value=5px`, `href=https://x/`, `href=/a/b.css`):
// per WHATWG, an unquoted value ends ONLY at whitespace or `>`, so `/` is a legal value char
// (URLs / paths). The lexer scans the whole value as ONE token the moment it follows `=` (see
// markup.unquotedValueToken below) — so the leading `/` of a path and the trailing `/` of a URL
// stay in the value, while a `/>` self-close (where no value is being read) stays punctuation.
// `\`` excluded to mirror the highlighter's value pattern. The leading-char-class scan in the
// lexer makes this token's own pattern a backstop (it is no longer subject to the Name-first race).
const UnquotedValue = token(plus(noneOf(whitespace, '"', "'", '<', '>', '=', '`')), { scope: 'string.unquoted.html' });
// Markup-mode content tokens — emitted by the lexer state machine, not matched by
// these patterns (the patterns are placeholders; see gen-lexer markupTokenNames).
const Text = token(plus(noneOf('<')), { scope: 'text.html' });
const RawText = token(plus(noneOf('<')), { scope: 'source.embedded' });
const Comment = token(seq('<!--', star(seq(notFollowedBy('-->'), anyChar()), { greedy: false }), '-->'), { scope: 'comment.block.html' });

// ── Rules ──
// An attribute: a name, optionally `= value` (quoted, or an unquoted name/number).
const Attr = rule($ => [
  [Name, opt('=', alt(AttrValue, Name, UnquotedValue))],
]);

// A child node inside an element. RawText only ever appears as the sole child of a
// raw-text element (the lexer guarantees this), but listing it here keeps the rule
// uniform — `many(Node)` over a <script> body is exactly one RawText token.
const Node = rule($ => [
  Element,
  Comment,
  RawText,
  Text,
]);

// An element. Shapes tried in order (the parser keeps the LONGEST match, so the close-tag
// container always wins over the to-EOF arm when a close tag is present):
//   1. void:           <br>  <img src="x">  <br/>   (name retagged to VoidName by the lexer)
//   2. self-closing:   <Foo/>  <svg .../>            (non-void, explicitly self-closed)
//   3. container:      <div>…</div>  <p>text</p>
//   4. raw-text to EOF: <script …>body            (a raw-text element with its close tag
//      OMITTED — body runs to EOF). The RawText body token is the discriminator: the lexer
//      emits RawText ONLY inside a raw-text element (<script>/<style>/<textarea>/<title>), so
//      this arm can never fire for an ordinary element. It also catches `<script …/>body`
//      because the lexer (per WHATWG) IGNORES the self-close `/` on a raw-text tag and runs
//      the body as raw-text — matching parse5 (`<script src=… />…</…>` is NOT self-closed).
// Void comes first so a `<br>` never enters the container branch and swallows its
// following siblings + a mismatched close tag.
const Element = rule($ => [
  ['<', VoidName, many(Attr), opt('/'), '>'],
  ['<', Name, many(Attr), '/', '>'],
  ['<', Name, many(Attr), '>', many(Node), '<', '/', Name, '>'],
  ['<', Name, many(Attr), '>', RawText],
]);

// A document: a sequence of top-level nodes (elements, comments, text, doctype).
// The DOCTYPE is lexed as a comment-shaped token only if declared; for now a
// leading `<!doctype html>` is matched structurally as an element-ish node is not
// — kept out of the minimal corpus. Document is LAST → it is the parser entry.
const Document = rule($ => [
  [many(alt(Element, Comment, Text))],
]);

// The reusable pieces. Exported so a DIALECT (vue.ts) can build a sibling grammar from
// the SAME tokens/rules/scopes via its OWN `defineGrammar` call — rather than spreading
// html.ts's already-built grammar (which bypasses the API). Calling `defineGrammar` twice
// with these shared refs is safe: it only reads them (no mutation).
export const tokens = { Name, VoidName, AttrValue, UnquotedValue, Text, RawText, Comment };
export const rules = { Element, Attr, Node, Document };
export const scopes: Record<string, string[]> = {
  'entity.name.tag': [],            // tag names — refined by the highlighter from rule shape
  'punctuation.definition.tag': ['<', '>', '/'],
};
export const markup: MarkupConfig = {
  textToken: 'Text',
  tagOpen: '<',
  tagClose: '>',
  closeMarker: '/',
  // WHATWG tag-open state: `<` opens a tag ONLY before a letter (tag name), `/` (close tag),
  // or `!`/`?` (markup-declaration / bogus-comment). A `<` before anything else (`<` then a
  // space/digit/`=`, or at EOF) is a literal text char — so `<p>a < b</p>` and `<p>5 < 3</p>`
  // are text, matching parse5, instead of throwing. (`<p>a<b</p>` — `<`+letter — still opens a
  // tag and is rejected as malformed, exactly as before; that is a different branch.)
  tagOpenAfter: 'a-zA-Z/!?',
  attributeAssign: '=',          // `name = value`
  attributeQuotes: ['"', "'"],   // quoted attribute values
  unquotedValueToken: 'UnquotedValue', // scan a whole unquoted value after `=` (so `/` in a URL/path stays in the value, not a self-close)
  // `on*` event-handler attributes carry JS, and `style` carries CSS — embed the platform's
  // source.js / source.css, capture-bounded to the quoted value. The JS embed also beats the
  // official, whose inline-JS value rule hand-rolls a `//` splitter that mis-reads `//` inside a
  // string as a comment (html.tmbundle#113); the `style`→source.css embed matches the official's
  // inline-CSS delegation (html.tmbundle#88). `data-on…` / `style-…` aren't grabbed — the `(?![\w:.-])`
  // name boundary + leftmost-match keep the generic attribute-name rule winning at the true start.
  // `style="…"` carries a CSS DECLARATION LIST (no selector/braces), so it embeds scope source.css
  // but is tokenized by source.css#rule-list-innards — `color`→property-name, `red`→value — instead
  // of the stylesheet root (which mis-reads `color:red` as a selector). This is GRANULAR, beating
  // VS Code's own HTML grammar (a flat source.css blob there) and matching the hand-written Vue
  // grammar's `#vue-directives-style-attr` (its "Copy from source.css#rule-list-innards").
  attributeEmbed: [
    { namePattern: seq('on', plus(word)), embed: 'source.js' },
    { namePattern: 'style', embed: 'source.css', include: 'source.css#rule-list-innards' },
  ],
  // Raw-text element bodies are scanned verbatim by the parser, but the HIGHLIGHTER
  // delegates `<script>`/`<style>` to the platform's real JS/CSS grammars (exactly as
  // the official HTML grammar embeds source.js / source.css — Monogram has no own CSS
  // grammar). `embed` is highlight-only data; the parser still raw-texts every body, so
  // conformance is unchanged. `textarea`/`title` have no embed → their body stays scoped
  // by `token` (source.embedded), matching the official's plain raw-text content.
  rawText: { tags: ['script', 'style', 'textarea', 'title'], token: 'RawText',
             embed: { script: 'source.js', style: 'source.css' } },
  comment: { open: '<!--', close: '-->', token: 'Comment' },
  // Character entities (`&amp;`, `&#169;`, `&#xAB;`) in text — lifted out of the text blob and
  // scoped individually, like the official grammar (textmate/html.tmbundle#81). Highlight-only.
  entity: {
    prefix: '&', terminator: ';', numericMarker: '#', hexMarker: 'x',
    namedScope: 'constant.character.entity.named.html',
    numericScope: 'constant.character.entity.html',
    punctuationScope: 'punctuation.definition.entity.html',
  },
  // The HTML void elements (no children, no close tag).
  voidTags: ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
             'link', 'meta', 'param', 'source', 'track', 'wbr'],
  voidNameToken: 'VoidName',
  // HTML's OPTIONAL (omittable) end tags. Each element maps to the sibling start tags that
  // implicitly close it (the WHATWG "an end tag may be omitted if …" follow set); it also
  // closes on any ancestor end tag (handled for free — content stops at every `</…>`). This
  // is the context-free slice of HTML5 recovery a recursive-descent parser can express (a
  // FOLLOW condition on the next token), unlike adoption-agency / foster-parenting (which
  // need the imperative tree-construction stack and are out of scope). Pure DATA — the engine
  // recognises the element arm structurally and stays tag-name-blind. Highlight-only
  // generators ignore it (a flat per-tag grammar models no containment).
  optionalEndTags: {
    li: ['li'],
    dt: ['dt', 'dd'],
    dd: ['dt', 'dd'],
    option: ['option', 'optgroup'],
    optgroup: ['optgroup'],
    p: ['p', 'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset',
        'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
        'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'pre', 'section', 'table', 'ul'],
    tr: ['tr'],
    td: ['td', 'th', 'tr'],
    th: ['td', 'th', 'tr'],
    thead: ['tbody', 'tfoot'],
    tbody: ['thead', 'tbody', 'tfoot'],
    tfoot: ['thead', 'tbody'],
  },
};

export default defineGrammar({
  name: 'html',
  scopeName: 'text.html.basic',
  tokens,
  rules,
  entry: Document,
  scopes,
  markup,
  // text.html.derivative — the embedded-HTML-fragment scope. Same rules as text.html.basic,
  // re-exposed under the scopeName that Vue/markdown/pug injections target (Vue's <template>
  // embeds this, not basic). Mirrors VS Code's separate html-derivative grammar.
  aliasScopes: [{ scope: 'text.html.derivative', file: 'html-derivative' }],
});
