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
//     at a run's start or right after a blank: `a //b` is a comment, `a//b` and `https://x` text;
//   • directives in the children (derived from the rules: grammar-analysis.ts directivesOf):
//     `@if (…) { children } @else if (…) { … } @else { … }`, `@for [await] (x of xs) { … }
//     @empty { … }`, `@try { … } @pending { … } @catch (e) { … }`, and the code block `@{ … }`.
//     An opener counts anywhere in a run (`a@if (`), only before its required next literal
//     (`@if x`, `@iffy` are text).
// Program shape: `component Name(params) { statements }`; a statement is a declaration, a
// return, or an element (render output). An element after a value is a comparison (`a <b`), as
// after the close of another element on the same line: `<a/>; <b/>` separates two of them.
// `textDialect(parts)` builds the dialect with only some of the region's features (the portable
// lexers' gate runs each stage: test/portable-targets.ts); the default export has them all.
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
// a directive word (`@if`, `@else`, …): the directive literals are keywords of this token, as `if` is
// of the identifier; any other `@word` in code is one too (in text it is text)
const AtWord = token(seq('@', idStart, star(idCont)), { scope: 'keyword.control.directive' });

export type TextDialectParts = { textTokens: boolean; directives: boolean };
export function textDialect(parts: TextDialectParts = { textTokens: true, directives: true }) {
  const Expr = rule(($) => [
    Number_,
    Str,
    Ident,
    Regex,
    Element,
    ['(', $, ')'],
    // a record and a list: braces and brackets inside a directive head (`@if ({a}.a) {`)
    ['{', opt(sep(Ident, ',')), '}'],
    ['[', opt(sep($, ',')), ']'],
    [$, '[', $, ']'],
    [prefix, $],
    [$, op, $],
    [$, '(', opt(sep($, ',')), ')'],
    [$, '.', Ident],
  ]);

  const Hole = rule(() => [['{', Expr, '}']]);
  const TagName = rule(() => [[Ident, many('-', Ident)], Hole]);
  const Attr = rule(() => [[Ident, opt('=', alt(Str, Hole))], Hole]);
  const Child = rule(() => [Element, Hole, Text, StyleBody, ScriptBody, ...(parts.directives ? [Directive] : [])]);
  // a directive's body: children closed by the hole closer
  const Body = rule(() => [['{', many(Child), '}']]);
  const Else = rule(($) => [['@else', 'if', '(', Expr, ')', Body, opt($)], ['@else', Body]]);
  const Directive = rule(() => [
    ['@if', '(', Expr, ')', Body, opt(Else)],
    ['@for', opt('await'), '(', Ident, 'of', Expr, ')', Body, opt('@empty', Body)],
    ['@try', Body, opt('@pending', Body), opt('@catch', '(', Ident, ')', Body)],
    // a code block: its group holds statements, not children
    ['@{', many(Statement), '}'],
  ]);
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

  return defineGrammar({
    name: 'textdialect',
    scopeName: 'source.textdialect',
    tokens: { Ident, AtWord, Number: Number_, Str, Regex, LineComment, BlockComment, Text, CloseTag, SelfClose, StyleBody, ScriptBody },
    elements: {
      tagOpen: '<', tagClose: '>', closeMarker: '/', text: 'Text', closeTag: 'CloseTag', selfClose: 'SelfClose',
      hole: { open: '{', close: '}' },
      // what can follow `<` in an element arm: a close marker, a fragment's `>`, a dynamic tag's
      // hole, an identifier's first character
      tagStart: oneOf('/', '>', '{', '$', '_', range('A', 'Z'), range('a', 'z')),
      ...(parts.textTokens ? { textTokens: [{ token: 'BlockComment' }, { token: 'LineComment', after: blank }] } : {}),
      rawText: [
        { tags: ['style'], token: 'StyleBody', unlessBodyStarts: seq(star(blank), '{'), embed: { style: 'source.css' } },
        { tags: ['script'], token: 'ScriptBody', ignoreCase: true, embed: { script: 'source.js' } },
      ],
    },
    prec: [left('==', '!='), left('<', '>'), left('+', '-'), right(prefix('!'))],
    scopes: {
      'keyword.control': ['return', '@if', '@else', '@for', '@empty', '@try', '@pending', '@catch', 'of', 'await', 'if'],
      'storage.type': ['component', 'const'],
      'punctuation.definition.tag': ['<', '>'],
    },
    rules: { Expr, Hole, TagName, Attr, Child, ...(parts.directives ? { Body, Else, Directive } : {}), Element, Statement, Component, Program },
  });
}

export default textDialect();
