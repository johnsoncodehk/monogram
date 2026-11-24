// JavaScriptReact (`.jsx`) — JavaScript + JSX.
//
// This file plays two roles, mirroring how javascript.ts is both the JS grammar AND
// the owner of the shared ECMAScript vocabulary that typescript.ts imports:
//   1. It is the `.jsx` GRAMMAR — `export default withJsx(javascript, …)`.
//   2. It owns the shared JSX LAYER (`withJsx`), which typescriptreact.ts imports to
//      build the `.tsx` grammar. So `typescriptreact → javascriptreact` for the JSX
//      layer parallels `typescript → javascript` for the base vocabulary.
//
// `withJsx(base, …)` turns ANY ECMAScript-family base grammar — javascript.ts or
// typescript.ts — into its React/JSX dialect WITHOUT re-declaring the base's rules,
// so each react grammar stays a one-liner and the conformance-proven base files are
// untouched. Why post-process the BUILT grammar instead of importing + extending the
// rule objects: combinator rules bind their sibling references by OBJECT IDENTITY at
// definition time, so a JSX-aware `Expr` cannot be spliced into a frozen base by
// reference (the base's `Block`→`Stmt`→`Expr` chain still points at the non-JSX
// `Expr`). The BUILT grammar references rules by NAME, so we patch at that level — the
// JSX rules reference `Expr`/`Type`/`Block` by name and resolve against whichever base
// they are merged into.
//
// The dialect is exactly the JSX delta JavaScript/TypeScript-to-JSX needs:
//   1. Prepend a `JSXElement` alternative to `Expr` (a NUD: a leading `<` at
//      expression-start is JSX — comparison `<` and generic-call `f<T>` are LEDs that
//      need a left operand, so they never fire at expression-start).
//   2. Drop the `<T>expr` prefix cast from `Expr` (forbidden in .tsx/.jsx — the leading
//      `<` is JSX; `as`/`satisfies` casts are unaffected). It is the only `Expr`
//      alternative that begins with a literal `<`, so it is removed by shape.
//   3. Add the JSX rules, their four region tokens (`/>`, `</`, the children text, the attribute string) and
//      the ELEMENT REGION that lexes them (`elements`, see ELEMENTS): an element is
//      entered where an operand may start, its children are text, and `</` / `/>` are
//      tokens only inside it. Outside elements the base's lexing is unchanged.
//
// Generic type-arguments on a tag (`<List<string>>`) are TypeScript-only, so the JSX
// rules include them only when the base has a `Type` rule (TS) and omit them for the
// type-free JavaScript base.

import { token, rule, defineGrammar, sameLine, sep, opt, many, alt, seq, plus, star, noneOf, oneOf, range, altPattern, optPattern, notFollowedBy } from './src/api.ts';
import javascript, { Ident, Number_, String_ } from './javascript.ts';
import type { Grammar, RuleDecl, TokenDecl, RuleExpr, ElementRegion } from './src/grammar/types.ts';

// The element region's own tokens (see ELEMENTS below): each exists only inside an element.
// `/>` ends a self-closing tag, `</` opens a close tag in the children, and a children text run
// is one JSXText token: every character up to the next `{` or `<` (`>` and `}` are not text:
// tsc reports them in text, so they end the run and the parser rejects them).
const JSXSelfClose = token(seq('/', '>'));
const JSXClose = token(seq('<', '/'));
const JSXText = token(plus(noneOf('{', '<', '>', '}')));
// An attribute value string, lexed only inside a tag: tsc's `scanJsxAttributeValue` reads to the
// matching quote with no escapes (`b="\"` is the one-character string `\`), across lines.
const JSXString = token(altPattern(seq('"', star(noneOf('"')), '"'), seq("'", star(noneOf("'")), "'")), { scope: 'string.quoted' });

// A `<` at an operand position that begins a TYPE-PARAMETER list (TypeScript bases only), as
// tsc decides it under JSX: `<T,`, `<T =`, `<const T,`, `<T extends U` (not `extends=` /
// `extends>` / `extends/`, which are attributes), and a `<T>` head followed by a parameter
// list that ends in `=>` or `:` (a function / constructor type or a call signature in a type).
const ws = star(oneOf(' ', '\t', '\n', '\r'));
const idStart = oneOf(range('a', 'z'), range('A', 'Z'), '_', '$');
const idCont = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_', '$');
const typeParameterHead = seq(
  ws, optPattern(seq('const', plus(oneOf(' ', '\t', '\n', '\r')))), idStart, star(idCont), ws,
  altPattern(',', seq('=', notFollowedBy(oneOf('=', '>'))), seq('extends', notFollowedBy(idCont), ws, notFollowedBy(oneOf('=', '>', '/')))),
);
// React's highlighting vocabulary, as highlighter data on the region (the lexer does not read it;
// docs/REGIONS.md, "Highlighter data"):
//   • a tag name whose first character is a lowercase ASCII letter is an intrinsic element (tsc's
//     `isIntrinsicJsxName` reads the same range) → `entity.name.tag`; any other is a component →
//     `support.class.component`, as the official TypeScriptReact grammar scopes them;
//   • an HTML character entity in text (`&amp;`, `&#123;`, `&#x1F600;`): one scope-only pattern,
//     its `&` and `;` the entity punctuation (tsc does not decode entities; the text token keeps them);
//   • the children carry `meta.jsx.children`;
//   • `:` in a tag or attribute name is an XML namespace prefix (`svg:rect`, `xlink:href`).
const alnum = oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'));
const hex = oneOf(range('0', '9'), range('a', 'f'), range('A', 'F'));
const JSX_HIGHLIGHT = {
  tagName: [
    { match: range('a', 'z'), scope: 'entity.name.tag' },
    { scope: 'support.class.component' },
  ],
  text: [{
    match: seq('&', altPattern(seq('#', plus(range('0', '9'))), seq('#', oneOf('x', 'X'), plus(hex)), seq(oneOf(range('a', 'z'), range('A', 'Z')), star(alnum))), ';'),
    scope: 'constant.character.entity', delimiters: 'punctuation.definition.entity',
  }],
  childrenScope: 'meta.jsx.children',
  nameJoiners: [{ text: ':', scope: 'punctuation.separator.namespace', prefix: 'namespace' }],
};
const ELEMENTS = (hasTypes: boolean): ElementRegion => ({
  tagOpen: '<', tagClose: '>', closeMarker: '/',
  text: 'JSXText', closeTag: 'JSXClose', selfClose: 'JSXSelfClose',
  hole: { open: '{', close: '}' },
  tagTokens: ['JSXString'],
  name: 'jsx',
  highlight: JSX_HIGHLIGHT,
  ...hasTypes ? { typeParameters: { head: typeParameterHead, signature: { open: '(', close: ')', then: ['=>', ':'] } } } : {},
});

// Build the JSX rule + token DECLARATIONS (serialized, name-referenced). The JSX
// rules reference `Expr`/`Type` via stub rules of those names, so once spliced into a
// base grammar the names resolve to the base's real `Expr`/`Type`. Run through
// defineGrammar purely to serialize; only the JSX entries are kept.
function buildJsxDecls(hasTypes: boolean): { rules: RuleDecl[]; tokens: TokenDecl[] } {
  const Expr = rule(() => [Ident]); // stub → supplies the name "Expr"
  const Type = rule(() => [Ident]); // stub → supplies the name "Type"
  // A dotted / namespaced / hyphenated tag or attribute name: `Foo`, `Foo.Bar`,
  // `svg:rect`, `data-id` (the lexer splits `data-id` into `Ident '-' Ident`).
  const nameTail = many(alt(['.', Ident], [':', Ident], [sameLine, '-', Ident]));
  const typeArgs = hasTypes ? [opt('<', sep(Type, ','), '>')] : [];

  const JSXTagName = rule(() => [[Ident, nameTail]]);
  const JSXAttrValue = rule(() => [JSXString, ['{', Expr, '}']]);
  const JSXAttr = rule(() => [
    ['{', '...', Expr, '}'],                       // spread attribute {...expr}
    [Ident, nameTail, opt('=', JSXAttrValue)],     // name (= value)?
  ]);
  const JSXContainer = rule(() => [['{', opt('...'), opt(Expr), '}']]);
  const JSXChild = rule(() => [
    JSXElement,
    JSXContainer,
    JSXText,                                       // a text run (the element region's text token)
  ]);
  const JSXElement = rule(() => [
    ['<', JSXTagName, ...typeArgs, many(JSXAttr), JSXSelfClose],
    ['<', JSXTagName, ...typeArgs, many(JSXAttr), '>', many(JSXChild), JSXClose, opt(JSXTagName), '>'],
    ['<', '>', many(JSXChild), JSXClose, '>'],      // fragment
  ]);

  const g = defineGrammar({
    name: 'jsx-decls',
    tokens: { Ident, Number: Number_, String: String_, JSXSelfClose, JSXClose, JSXText, JSXString },
    rules: { Expr, Type, JSXTagName, JSXAttrValue, JSXAttr, JSXContainer, JSXChild, JSXElement },
    entry: JSXElement,
  });
  const ruleNames = new Set(['JSXTagName', 'JSXAttrValue', 'JSXAttr', 'JSXContainer', 'JSXChild', 'JSXElement']);
  const tokNames = new Set(['JSXSelfClose', 'JSXClose', 'JSXText', 'JSXString']);
  return {
    rules: g.rules.filter(r => ruleNames.has(r.name)),
    tokens: g.tokens.filter(t => tokNames.has(t.name)),
  };
}

// Repository-key NAMING CONSTRAINT — the JSX delta. The base's `canonicalRepoNames`
// (`jsBaseCanonical`, owned by javascript.ts) is inherited through the `{ ...base }` spread
// below; this adds ONLY the JSX-key correspondences, so BOTH the `.jsx` and `.tsx` dialects
// (each built via `withJsx`) emit the official names natively. Monogram's JSX decomposition
// differs from the official's (it splits element/fragment/self-closing where the official splits
// tag-with/without-attributes), so MOST JSX keys are deliberately NOT mapped — only a genuine 1:1
// is aligned. `jsx-children`, `jsx-string-double-quoted`, `jsx-string-single-quoted` ALREADY match
// by name (gen-textmate never clobbers an existing key, so listing them is unnecessary). Verified 1:1:
//   • `jsx-entities` ← `jsx-entity` — the JSX character-entity construct (`&amp;`/`&#65;`/`&#x41;`),
//     same emitted scopes (`constant.character.entity` + `punctuation.definition.entity`); the
//     official name is the plural wrapper, Monogram's is the single match rule. A pure rename.
// Deliberately NOT mapped (decompose/scope differently — a rename would NOT be a faithful
// projection, so it would mis-serve an `#include`): `jsx-evaluated-code` (Monogram's `jsx-expression`
// scopes the braces with `name`, the official scopes only the content with `contentName`, and embeds
// `$self` vs `#expression`), `jsx-tag-attributes` (Monogram's `jsx-attributes` is a bare wrapper; the
// official is a `meta.tag.attributes`-scoped begin/end region), and the whole `jsx-tag*` element
// family (a different structural split).
const JSX_CANONICAL: Record<string, string | string[]> = {
  'jsx-entities': 'jsx-entity',
};

const isLiteral = (e: RuleExpr, v: string): boolean => e.type === 'literal' && e.value === v;

/** Turn an ECMAScript-family base grammar into its React/JSX dialect. Imported by
 *  typescriptreact.ts. See the file header for why this post-processes the built grammar. */
export function withJsx(base: Grammar, opts: { name: string; scopeName: string }): Grammar {
  const hasTypes = base.rules.some(r => r.name === 'Type');
  const jsx = buildJsxDecls(hasTypes);

  // Patch Expr: prepend JSXElement, drop the literal-`<`-first cast alternative.
  const patched: RuleDecl[] = base.rules.map(r => {
    if (r.name !== 'Expr') return r;
    const alts = r.body.type === 'alt' ? r.body.items : [r.body];
    const kept = alts.filter(a => !(a.type === 'seq' && isLiteral(a.items[0], '<')));
    const jsxRef: RuleExpr = { type: 'ref', name: 'JSXElement' };
    return { ...r, body: { type: 'alt', items: [jsxRef, ...kept] } };
  });
  // The parser uses the LAST rule as the entry point, so splice the JSX rules in
  // BEFORE the base's entry rule rather than after it.
  const entry = patched[patched.length - 1];
  const rules: RuleDecl[] = [...patched.slice(0, -1), ...jsx.rules, entry];

  // The JSX tokens go right before the regex token (the declaration order the generators
  // read); the lexer scans them only inside an element region, entered where a regex literal
  // may start (the base's regexContext decides both).
  let placed = false;
  const tokens: TokenDecl[] = [];
  for (const t of base.tokens) {
    if (t.regexContext && !placed) {
      tokens.push(...jsx.tokens);
      placed = true;
      tokens.push(t);
    } else {
      tokens.push(t);
    }
  }
  if (!placed) tokens.push(...jsx.tokens); // base has no regex token — just append

  // Inherit the base's canonical repo-key names (jsBaseCanonical for the JS base, the full TS map
  // for the TS base) and add the JSX delta, so both the `.jsx` and `.tsx` dialects emit the official
  // names natively. Pure DATA merge — gen-textmate only looks them up, so the engine stays agnostic.
  return {
    ...base, name: opts.name, scopeName: opts.scopeName, rules, tokens,
    // `>` closes a JSX tag (`<a>>b</a>`), so `>`-led operators are composed from single `>` tokens.
    composeGt: true,
    elements: ELEMENTS(hasTypes),
    canonicalRepoNames: { ...base.canonicalRepoNames, ...JSX_CANONICAL },
    // The JSX layer's own tree-sitter GLR conflicts: `{` after a tag is a JSX expression container
    // or an expression, and over a type base `<T` may open a type parameter list or a JSX tag.
    treeSitterConflicts: [
      ...base.treeSitterConflicts ?? [],
      ['expr', 'jsxcontainer'],
      ...hasTypes ? [['type_param', 'jsxtag_name']] : [],
    ],
  };
}

// The `.jsx` grammar: the JavaScript base + the JSX layer above.
export default withJsx(javascript, { name: 'javascriptreact', scopeName: 'source.js.jsx' });
