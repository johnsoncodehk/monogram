// A toy ELEMENT DIALECT whose tag token can FAIL where another token then lexes: the attribute
// string `'…'` (a `tagTokens` token, docs/REGIONS.md) stops at `>`, so in `<a k='v>` it fails
// after reading to the `>`, and the ordinary scan lexes the `'` there as the prime operator of
// code. That failed read is a read past the `'` token's end: an edit inside it (`<a k='v'>`)
// must relex from the `'`. In JSX a failed attribute string is a lex error (the ordinary string
// fails too), so only a grammar like this one can check that the portable lexers record it
// (test/portable-targets.ts, the one-character edits).
import { token, rule, defineGrammar, seq, oneOf, range, star, opt, many, noneOf } from '../../src/api.ts';

const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_');

const Ident = token(seq(idStart, star(idCont)), { identifier: true, scope: 'variable' });
const Str = token(seq('"', star(noneOf('"', '\n')), '"'), { string: true, scope: 'string.quoted.double' });
// lexed only inside a tag: fails at a `>` before its closing quote
const AttrStr = token(seq("'", star(noneOf("'", '>')), "'"), { string: true, scope: 'string.quoted.single' });
const CloseOpen = token(seq('<', '/'));
const SelfClose = token(seq('/', '>'));

const Expr = rule(($) => [Ident, Str, ['(', $, ')'], [$, "'"]]);
const Container = rule(() => [['{', Expr, '}']]);
const Attr = rule(() => [[Ident, opt('=', Value)], Container]);
const Value = rule(() => [AttrStr, Str, Container, [Ident, "'"]]);
const Node = rule(() => [Element, Container, Str]);
const Element = rule(() => [
  ['<', Ident, many(Attr), SelfClose],
  ['<', Ident, many(Attr), '>', many(Node), CloseOpen, Ident, '>'],
]);
const Program = rule(() => [many(Node)]);

export default defineGrammar({
  name: 'tagtokdialect',
  scopeName: 'source.tagtokdialect',
  tokens: { Ident, Str, AttrStr, CloseOpen, SelfClose },
  elements: { tagOpen: '<', tagClose: '>', closeMarker: '/', closeTag: 'CloseOpen', selfClose: 'SelfClose', hole: { open: '{', close: '}' }, tagTokens: ['AttrStr'] },
  rules: { Expr, Container, Attr, Value, Node, Element, Program },
});
