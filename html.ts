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
import { token, rule, defineGrammar, many, opt, alt } from './src/api.ts';
import type { MarkupConfig } from './src/types.ts';

// ── Tokens ──
// Tag and attribute names: a letter, then name chars (incl. `-` for custom
// elements / data-*, `:` for namespaced names like `xlink:href`).
const Name = token(/[a-zA-Z][\w:.-]*/, { identifier: true });
// An OPEN void-element name (`br`, `img`, `meta`, …). The lexer retags these from
// Name (driven by `markup.voidTags`); the pattern is a placeholder, never matched
// fresh. A distinct token lets the parser's void branch match void elements without
// the generic engine knowing any tag names.
const VoidName = token(/[a-zA-Z][\w:.-]*/, { scope: 'entity.name.tag' });
// Quoted attribute value (double or single).
const AttrValue = token(/"[^"]*"|'[^']*'/, { string: true });
// Unquoted attribute value (`colspan=2`, `value=5px`, `data-x=foo`): any run that
// isn't whitespace, a quote, or a structural delimiter. Excludes `/` so a trailing
// `/>` self-close stays punctuation. Declared after Name → Name still wins for
// alphabetic values; this is the fallback for numbers / symbol-leading values.
const UnquotedValue = token(/[^\s"'<>=\/]+/, { scope: 'string.unquoted.html' });
// Markup-mode content tokens — emitted by the lexer state machine, not matched by
// these patterns (the patterns are placeholders; see gen-lexer markupTokenNames).
const Text = token(/[^<]+/, { scope: 'text.html' });
const RawText = token(/[^<]+/, { scope: 'source.embedded' });
const Comment = token(/<!--[\s\S]*?-->/, { scope: 'comment.block.html' });

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

// An element. Shapes tried in order (the parser backtracks):
//   1. void:           <br>  <img src="x">  <br/>   (name retagged to VoidName by the lexer)
//   2. self-closing:   <Foo/>  <svg .../>            (non-void, explicitly self-closed)
//   3. container:      <div>…</div>  <p>text</p>
// Void comes first so a `<br>` never enters the container branch and swallows its
// following siblings + a mismatched close tag.
const Element = rule($ => [
  ['<', VoidName, many(Attr), opt('/'), '>'],
  ['<', Name, many(Attr), '/', '>'],
  ['<', Name, many(Attr), '>', many(Node), '<', '/', Name, '>'],
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
  attributeAssign: '=',          // `name = value`
  attributeQuotes: ['"', "'"],   // quoted attribute values
  rawText: { tags: ['script', 'style', 'textarea', 'title'], token: 'RawText' },
  comment: { open: '<!--', close: '-->', token: 'Comment' },
  // The HTML void elements (no children, no close tag).
  voidTags: ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
             'link', 'meta', 'param', 'source', 'track', 'wbr'],
  voidNameToken: 'VoidName',
};

export default defineGrammar({
  name: 'html',
  scopeName: 'text.html.basic',
  tokens,
  rules,
  entry: Document,
  scopes,
  markup,
});
