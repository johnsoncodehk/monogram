// An ELEMENT DIALECT that is not React: the highlighter generators' measuring fixture
// (test/textmate-dialect.ts). Written from scratch to exercise the mechanisms a template dialect
// needs from the editor generators, under vocabulary that is NOT JSX's:
//   • keyword literals that begin with a non-word character (`@if`, `@else`, `@each`,
//     `@empty`), next to an annotation token (`@name`) that also begins with `@`;
//   • brace-delimited directive regions (`@if (c) { … }`) whose contents are elements again;
//   • a dynamic tag (`<{expr}>…</{expr}>`) and shorthand attributes (`<li {key}>`);
//   • custom-element tag names with dashes (`<my-card>`) and namespaced attribute names
//     (`on:click`); no upper/lower-case convention: every tag is a tag;
//   • an ELEMENT REGION (`elements`, docs/REGIONS.md) with CODE children (no text token): an
//     element's children are lexed as code, `</` and `/>` are tokens only inside an element,
//     and since `<` begins nothing but element arms here, every `<` in code opens an element
//     (the derived entry, grammar-analysis.ts tagOpenOnlyOpensTags);
//   • a raw-text element (`<style>…</style>`) whose body is CSS: the region's `rawText`
//     declaration makes the whole body ONE `StyleBody` token (docs/REGIONS.md, "Raw text").
// Program shape: `component Name(params) { nodes }`, optionally preceded by annotations.
import {
  token, rule, defineGrammar, left, right, prefix, op, alt, seq, oneOf, range, star, plus, sep, opt, many,
  altPattern, noneOf, anyChar,
} from '../../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');

const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });
const Str = token(seq('"', star(altPattern(noneOf('"', '\\'), seq('\\', anyChar()))), '"'), { string: true, scope: 'string.quoted.double' });
const LineComment = token(seq('//', star(noneOf('\n'))), { skip: true, scope: 'comment.line' });
// `@name`: an annotation. It also lexes `@if` … `@empty`, which the rules below use as
// keyword literals (a literal `@word` is matched by text against this token).
const Annotation = token(seq('@', idStart, star(idCont)), { scope: 'entity.name.function.decorator' });
const CloseOpen = token(seq('<', '/'));
const SelfClose = token(seq('/', '>'));
// the body of a raw-text element: lexed only by the region (its pattern is for the highlighters)
const StyleBody = token(plus(noneOf('<')), { scope: 'meta.embedded.block.css' });

const Expr = rule(($) => [
  Number_,
  Str,
  Ident,
  ['(', $, ')'],
  [prefix, $],
  [$, op, $],
  [$, '(', opt(sep($, ',')), ')'],
  [$, '.', Ident],
]);

const Container = rule(() => [['{', Expr, '}']]);
const TagName = rule(() => [[Ident, many('-', Ident)], Container]);
const AttrName = rule(() => [[Ident, opt(':', Ident)]]);
const Attr = rule(() => [[AttrName, opt('=', alt(Str, Container))], Container]);
const Node = rule(() => [Element, Directive, Container, Str, StyleBody]);
const Region = rule(() => [['{', many(Node), '}']]);
const Element = rule(() => [
  ['<', TagName, many(Attr), SelfClose],
  ['<', TagName, many(Attr), '>', many(Node), CloseOpen, TagName, '>'],
]);
const Directive = rule(($) => [
  ['@if', '(', Expr, ')', Region, opt('@else', alt($, Region))],
  ['@each', '(', Ident, 'of', Expr, ')', Region, opt('@empty', Region)],
]);
const Component = rule(() => [[many(Annotation), 'component', Ident, '(', opt(sep(Ident, ',')), ')', Region]]);
const Program = rule(() => [many(Component)]);

export default defineGrammar({
  name: 'elementdialect',
  scopeName: 'source.elementdialect',
  tokens: { Ident, Number: Number_, Str, LineComment, Annotation, CloseOpen, SelfClose, StyleBody },
  elements: { tagOpen: '<', tagClose: '>', closeMarker: '/', closeTag: 'CloseOpen', selfClose: 'SelfClose', hole: { open: '{', close: '}' },
    rawText: [{ tags: ['style'], token: 'StyleBody', embed: { style: 'source.css' } }] },
  prec: [left('==', '!='), left('+', '-'), right(prefix('!'))],
  scopes: {
    'keyword.control.conditional': ['@if', '@else'],
    'keyword.control.loop': ['@each', '@empty', 'of'],
    'storage.type.component': ['component'],
    'punctuation.definition.tag': ['<', '>'],
  },
  rules: { Expr, Container, TagName, AttrName, Attr, Node, Region, Element, Directive, Component, Program },
});
