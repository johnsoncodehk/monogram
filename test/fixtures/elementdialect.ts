// An ELEMENT DIALECT that is not React: the highlighter generators' measuring fixture
// (test/tm-dialect.ts). Written from scratch to exercise the mechanisms a template dialect
// needs from the editor generators, under vocabulary that is NOT JSX's:
//   • keyword literals that begin with a non-word character (`@if`, `@else`, `@each`,
//     `@empty`), next to an annotation token (`@name`) that also begins with `@`;
//   • brace-delimited directive regions (`@if (c) { … }`) whose contents are elements again;
//   • a dynamic tag (`<{expr}>…</{expr}>`) and shorthand attributes (`<li {key}>`);
//   • custom-element tag names with dashes (`<my-card>`) and namespaced attribute names
//     (`on:click`); no upper/lower-case convention: every tag is a tag;
//   • a raw-text element (`<style>…</style>`) whose body is CSS. A token-stream grammar has
//     no lexer region today, so the body is ONE token here (`StyleBlock`); the declared-region
//     mechanism (editor queue item 6) replaces this token with a region carrying an embed.
// Program shape: `component Name(params) { nodes }`, optionally preceded by annotations.
import {
  token, rule, defineGrammar, left, right, prefix, op, alt, seq, oneOf, range, star, sep, opt, many,
  altPattern, noneOf, anyChar, notFollowedBy,
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
const StyleBlock = token(seq('<style>', star(seq(notFollowedBy('</style>'), anyChar()), { greedy: false }), '</style>'), { scope: 'meta.embedded.block.css' });

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
const Node = rule(() => [Element, Directive, Container, Str]);
const Region = rule(() => [['{', many(Node), '}']]);
const Element = rule(() => [
  StyleBlock,
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
  tokens: { Ident, Number: Number_, Str, LineComment, Annotation, CloseOpen, SelfClose, StyleBlock },
  prec: [left('==', '!='), left('+', '-'), right(prefix('!'))],
  scopes: {
    'keyword.control.conditional': ['@if', '@else'],
    'keyword.control.loop': ['@each', '@empty', 'of'],
    'storage.type.component': ['component'],
    'punctuation.definition.tag': ['<', '>'],
  },
  rules: { Expr, Container, TagName, AttrName, Attr, Node, Region, Element, Directive, Component, Program },
});
