// A TEXT DIALECT: a template language of the shape of a TSX template dialect, written from
// scratch (our rule names, our rows) to show that such a dialect needs nothing but a grammar
// file (docs/REGIONS.md). Where `elementdialect.ts` has CODE children, this one has TEXT:
//   • element children are text runs (`Text`), `{expr}` holes and nested elements;
//   • `<` is also the relational operator, so an element is entered from code only where an
//     operand may start (the derived `operand` entry), and in the children `<` opens a tag only
//     before a tag-start character (`tagStart`): `<p>1 < 2</p>` is text; a dynamic tag is
//     `<{expr}>…</{expr}>`;
//   • raw-text elements: `<script>` (any case) is always raw; `<style>` is raw unless its body's
//     first non-blank character is the hole opener (`unlessBodyStarts`): `<style>{css}</style>`
//     is an element with a hole;
//   • comments in text (`textTokens`): `/* … */` anywhere in a run; `//` (to the end of the line)
//     at a run's start or right after a blank: `a //b` is a comment, `a//b` and `https://x` text.
// Program shape: `component Name(params) { statements }`; a statement is a declaration, a
// return, or an element (render output). An element after a value is a comparison (`a <b`), as
// after the close of another element on the same line: `<a/>; <b/>` separates two of them.
import {
  token, rule, defineGrammar, left, right, prefix, op, alt, seq, oneOf, range, star, plus, sep, opt, many,
  altPattern, noneOf, anyChar, notFollowedBy,
} from '../../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const blank = oneOf(' ', '\t', '\n', '\r');

const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Number_ = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });
const Str = token(altPattern(
  seq('"', star(altPattern(noneOf('"', '\\', '\n'), seq('\\', anyChar()))), '"'),
  seq("'", star(altPattern(noneOf("'", '\\', '\n'), seq('\\', anyChar()))), "'"),
), { string: true, scope: 'string.quoted' });
// a regex literal: it declares where an operand may start (`regexContext`), which is also where
// code may enter an element
const Regex = token(seq('/', plus(noneOf('/', '\n', '*')), '/'), {
  regex: true, scope: 'string.regexp',
  regexContext: { divisionAfterTypes: ['Ident', 'Number', 'Str'], divisionAfterTexts: [')'], regexAfterTexts: ['return'], regexAfterParenKeywords: [], memberAccessTexts: ['.'], postfixAfterValueTexts: [] },
});
const LineComment = token(seq('//', star(noneOf('\n'))), { skip: true, scope: 'comment.line' });
const BlockComment = token(seq('/*', star(seq(notFollowedBy('*/'), anyChar()), { greedy: false }), '*/'), { skip: true, scope: 'comment.block' });
// the region's own tokens (lexed only inside an element)
const Text = token(plus(noneOf('<', '{', '}')), { scope: 'string.unquoted.text' });
const CloseTag = token(seq('<', '/'));
const SelfClose = token(seq('/', '>'));
const StyleBody = token(plus(noneOf('<')), { scope: 'meta.embedded.block.css' });
const ScriptBody = token(plus(noneOf('<')), { scope: 'meta.embedded.block.js' });

const Expr = rule(($) => [
  Number_,
  Str,
  Ident,
  Regex,
  Element,
  ['(', $, ')'],
  [prefix, $],
  [$, op, $],
  [$, '(', opt(sep($, ',')), ')'],
  [$, '.', Ident],
]);

const Hole = rule(() => [['{', Expr, '}']]);
const TagName = rule(() => [[Ident, many('-', Ident)], Hole]);
const Attr = rule(() => [[Ident, opt('=', alt(Str, Hole))], Hole]);
const Child = rule(() => [Element, Hole, Text, StyleBody, ScriptBody]);
const Element = rule(() => [
  ['<', TagName, many(Attr), SelfClose],
  ['<', TagName, many(Attr), '>', many(Child), CloseTag, TagName, '>'],
  ['<', '>', many(Child), CloseTag, '>'],
]);
const Statement = rule(() => [
  ['const', Ident, '=', Expr, ';'],
  ['return', Expr, ';'],
  [Element, opt(';')],
]);
const Component = rule(() => [['component', Ident, '(', opt(sep(Ident, ',')), ')', '{', many(Statement), '}']]);
const Program = rule(() => [many(Component)]);

export default defineGrammar({
  name: 'textdialect',
  scopeName: 'source.textdialect',
  tokens: { Ident, Number: Number_, Str, Regex, LineComment, BlockComment, Text, CloseTag, SelfClose, StyleBody, ScriptBody },
  elements: {
    tagOpen: '<', tagClose: '>', closeMarker: '/', text: 'Text', closeTag: 'CloseTag', selfClose: 'SelfClose',
    hole: { open: '{', close: '}' },
    // what can follow `<` in an element arm: a close marker, a fragment's `>`, a dynamic tag's
    // hole, an identifier's first character
    tagStart: oneOf('/', '>', '{', '$', '_', range('A', 'Z'), range('a', 'z')),
    textTokens: [{ token: 'BlockComment' }, { token: 'LineComment', after: blank }],
    rawText: [
      { tags: ['style'], token: 'StyleBody', unlessBodyStarts: seq(star(blank), '{'), embed: { style: 'source.css' } },
      { tags: ['script'], token: 'ScriptBody', ignoreCase: true, embed: { script: 'source.js' } },
    ],
  },
  prec: [left('==', '!='), left('<', '>'), left('+', '-'), right(prefix('!'))],
  scopes: {
    'keyword.control': ['return'],
    'storage.type': ['component', 'const'],
    'punctuation.definition.tag': ['<', '>'],
  },
  rules: { Expr, Hole, TagName, Attr, Child, Element, Statement, Component, Program },
});
