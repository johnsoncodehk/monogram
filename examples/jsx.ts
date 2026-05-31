// Shared JSX dialect layer for the ECMAScript family.
//
// `withJsx(base, …)` turns ANY ECMAScript-family base grammar — javascript.ts or
// typescript.ts — into its React/JSX dialect, WITHOUT re-declaring the base's rules.
// This is how typescriptreact.ts and javascriptreact.ts reuse their bases: each is
// three lines (`import base; export default withJsx(base, …)`), and the
// conformance-proven base files stay untouched.
//
// Why post-process the BUILT grammar instead of importing + extending the rule
// objects: combinator rules bind their sibling references by OBJECT IDENTITY at
// definition time, so a JSX-aware `Expr` cannot be spliced into a frozen base by
// reference (the base's `Block`→`Stmt`→`Expr` chain still points at the non-JSX
// `Expr`). The BUILT grammar, however, references rules by NAME, so we patch at
// that level — the JSX rules reference `Expr`/`Type`/`Block` by name and resolve
// against whichever base they are merged into.
//
// The dialect is exactly the JSX delta TypeScript/JavaScript-to-JSX needs:
//   1. Prepend a `JSXElement` alternative to `Expr` (a NUD: a leading `<` at
//      expression-start is JSX — comparison `<` and generic-call `f<T>` are LEDs
//      that need a left operand, so they never fire at expression-start).
//   2. Drop the `<T>expr` prefix cast from `Expr` (forbidden in .tsx/.jsx — the
//      leading `<` is JSX; `as`/`satisfies` casts are unaffected). It is the only
//      `Expr` alternative that begins with a literal `<`, so it is removed by shape.
//   3. Add the JSX rules + the `/>` / `</` atomic tokens (placed before the regex
//      token so `</div>` lexes a close-tag, not a regex literal), and mark `>` / `}`
//      as division-context so a following `/` after a tag/container isn't a regex.
//
// Generic type-arguments on a tag (`<List<string>>`) are TypeScript-only, so the
// JSX rules include them only when the base has a `Type` rule (TS) and omit them
// for the type-free JavaScript base.

import { token, rule, defineGrammar, sameLine, sep, opt, many, alt } from '../src/api.ts';
import { Ident, Number_, String_ } from './javascript.ts';
import type { CstGrammar, RuleDecl, TokenDecl, RuleExpr } from '../src/types.ts';

// `/>` (self-closing) and `</` (close-tag open) are atomic JSX punctuation tokens.
export const JSXSelfClose = token(/\/>/);
export const JSXClose = token(/<\//);

// Build the JSX rule + token DECLARATIONS (serialized, name-referenced). The JSX
// rules reference `Expr`/`Type` via stub rules of those names, so once spliced into
// a base grammar the names resolve to the base's real `Expr`/`Type`. Run through
// defineGrammar purely to serialize; only the JSX entries are kept.
function buildJsxDecls(hasTypes: boolean): { rules: RuleDecl[]; tokens: TokenDecl[] } {
  const Expr = rule($ => [Ident]); // stub → supplies the name "Expr"
  const Type = rule($ => [Ident]); // stub → supplies the name "Type"
  // A dotted / namespaced / hyphenated tag or attribute name: `Foo`, `Foo.Bar`,
  // `svg:rect`, `data-id` (the lexer splits `data-id` into `Ident '-' Ident`).
  const nameTail = many(alt(['.', Ident], [':', Ident], [sameLine, '-', Ident]));
  const typeArgs = hasTypes ? [opt('<', sep(Type, ','), '>')] : [];

  const JSXTagName = rule($ => [[Ident, nameTail]]);
  const JSXAttrValue = rule($ => [String_, ['{', Expr, '}']]);
  const JSXAttr = rule($ => [
    ['{', '...', Expr, '}'],                       // spread attribute {...expr}
    [Ident, nameTail, opt('=', JSXAttrValue)],     // name (= value)?
  ]);
  const JSXContainer = rule($ => [['{', opt('...'), opt(Expr), '}']]);
  const JSXChild = rule($ => [
    JSXElement,
    JSXContainer,
    Ident, Number_, String_,                       // tokenizable text words
    alt(',', '.', ':', ';', '!', '?'),             // common sentence punctuation
  ]);
  const JSXElement = rule($ => [
    ['<', JSXTagName, ...typeArgs, many(JSXAttr), JSXSelfClose],
    ['<', JSXTagName, ...typeArgs, many(JSXAttr), '>', many(JSXChild), JSXClose, opt(JSXTagName), '>'],
    ['<', '>', many(JSXChild), JSXClose, '>'],      // fragment
  ]);

  const g = defineGrammar({
    name: 'jsx-decls',
    tokens: { Ident, Number: Number_, String: String_, JSXSelfClose, JSXClose },
    rules: { Expr, Type, JSXTagName, JSXAttrValue, JSXAttr, JSXContainer, JSXChild, JSXElement },
    entry: JSXElement,
  });
  const ruleNames = new Set(['JSXTagName', 'JSXAttrValue', 'JSXAttr', 'JSXContainer', 'JSXChild', 'JSXElement']);
  const tokNames = new Set(['JSXSelfClose', 'JSXClose']);
  return {
    rules: g.rules.filter(r => ruleNames.has(r.name)),
    tokens: g.tokens.filter(t => tokNames.has(t.name)),
  };
}

const isLiteral = (e: RuleExpr, v: string): boolean => e.type === 'literal' && e.value === v;

export function withJsx(base: CstGrammar, opts: { name: string; scopeName: string }): CstGrammar {
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

  // Insert the JSX tokens immediately before the regex token (so `</`,`/>` lex
  // atomically) and extend its division-context with `>` / `}`.
  let placed = false;
  const tokens: TokenDecl[] = [];
  for (const t of base.tokens) {
    if (t.regexContext && !placed) {
      tokens.push(...jsx.tokens);
      placed = true;
      const dat = t.regexContext.divisionAfterTexts ?? [];
      const add = ['>', '}'].filter(x => !dat.includes(x));
      tokens.push({ ...t, regexContext: { ...t.regexContext, divisionAfterTexts: [...dat, ...add] } });
    } else {
      tokens.push(t);
    }
  }
  if (!placed) tokens.push(...jsx.tokens); // base has no regex token — just append

  return { ...base, name: opts.name, scopeName: opts.scopeName, rules, tokens };
}
