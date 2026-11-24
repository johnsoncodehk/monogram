// The highlighter generators' shared FACTS about a grammar: what a highlighter must know about the
// language, read from the CstGrammar, independent of how any one highlighter spells it.
//
// `highlightFacts(grammar)` is the one entry: each fact is computed on its first read and then kept
// on the grammar object (a WeakMap), so every generator that reads it on the same grammar (TextMate
// today; Monarch and tree-sitter's highlights to follow) gets the one computed answer instead of
// re-deriving it. A fact is a pure function of the grammar: nothing here may mutate the grammar or a
// fact a caller holds.
//
// The detectors below moved here from src/gen-tm.ts unchanged (bbcaf41). Some still return
// Oniguruma regex source rather than the neutral fact (noted at each); separating the fact from its
// spelling is owed, construct by construct, together with the readers that would spell it otherwise.
import type { CstGrammar, RuleExpr, RuleDecl, TokenDecl } from './types.ts';
import { collectLiterals, escapeRegex, isKeywordLiteral } from './grammar-utils.ts';
import { analyzeGrammar } from './grammar-analysis.ts';
import { expandArms } from './region-view.ts';   // small bodies only: getTypeParamElementKeywords, prefixPairKeywords
import { armGraph, armOrderKey, compareArmOrder, findWindows, foldArmsFrom, hasWindow, inArmOrder, reachable, reachesThrough, sortInArmOrder, type ArmGraph } from './arm-graph.ts';
import { compileTokenizer, lexSpecOf } from './emit-lexer.ts';
import { classifyToken } from './highlight-roles.ts';
import { info as patternInfo, type CSet } from './lex-match-plan.ts';
import { tokenPatternBlockDelimiterSources, tokenPatternBlockDelimiters, tokenPatternEqualsPattern, tokenPatternIsNever, tokenPatternLeadingSource, tokenPatternLiteralPrefix, tokenPatternNodeContainsLiteral, tokenPatternPrefixBeforeTrailingLookahead, tokenPatternQuoteDelimAndEscape, tokenPatternSource, tokenPatternStringDelimiters, tokenPatternTrailingCharClass } from './token-pattern.ts';

export interface ContextualPattern {
  keyword: string;
  identScope: string;
}

/**
 * Infer the identifier-scope that follows a keyword in definition patterns.
 * Driven entirely by `scopeOverrides` from the DSL `scopes` section:
 *   storage.type.function*  → entity.name.function
 *   storage.type.X (other)  → entity.name.type
 */
export function getScope(overrides: Map<string, string[]>, key: string): string | undefined {
  return overrides.get(key)?.[0];
}

// TextMate-convention remaps from a `storage.type.<kind>` declaration keyword to
// the leaf of the `entity.name.type.<leaf>` it introduces. Most kinds keep their
// own name (`class`→`class`, `interface`→`interface`, `enum`→`enum`); two follow
// the established convention of a different leaf: a `type` alias name is
// `.type.alias`, and a `namespace`/`module` name is `.type.module`. Driven by the
// scope subtype, not by any specific keyword — a grammar gets the finer name for
// free by scoping its declaration keyword `storage.type.<kind>`.
export const TYPE_NAME_LEAF: Record<string, string> = { type: 'alias', namespace: 'module', module: 'module' };

export function inferIdentScope(keyword: string, scopeOverrides: Map<string, string[]>): string | null {
  const scope = getScope(scopeOverrides, keyword);
  if (!scope) return null;
  if (scope.startsWith('storage.type.function')) return 'entity.name.function';
  if (scope.startsWith('storage.type.') && scope !== 'storage.type') {
    // Refine to `entity.name.type.<kind>` so themes keying on the full path color
    // the declared name like the official grammar (class → entity.name.type.class).
    const kind = scope.slice('storage.type.'.length).split('.')[0];
    const leaf = TYPE_NAME_LEAF[kind] ?? kind;
    return leaf ? `entity.name.type.${leaf}` : 'entity.name.type';
  }
  // Heritage keyword (TextMate convention `*.extends`, e.g. `keyword.other.extends`
  // / `storage.modifier.extends`): the identifier it introduces names a superclass.
  // Scope-convention driven (like the storage.type.* mappings above), not keyed on
  // any specific word — a grammar that scopes its inheritance keyword `*.extends`
  // gets `entity.other.inherited-class` for the following identifier automatically.
  if (/(^|\.)extends$/.test(scope)) return 'entity.other.inherited-class';
  return null;
}

/** Whether rule `refName` is the identifier token, or begins (through rule references at its head)
 *  with it: so a `keyword Ident` pattern is still detected when the identifier is reached through a
 *  rule reference (e.g. `extends ClassHeritage`, whose base alternative is `Ident`). */
export function startsWithIdent(grammar: CstGrammar, refName: string, identTokenName: string): boolean {
  return refName === identTokenName || ruleBeginsWith(grammar, refName, (h) => h.type === 'ref' && h.name === identTokenName);
}

export function findContextualPatterns(
  grammar: CstGrammar,
  expr: RuleExpr,
  tokenNames: Set<string>,
  identTokenName: string | null,
): ContextualPattern[] {
  const { scopeOverrides } = grammar;
  const patterns: ContextualPattern[] = [];

  function walkSeq(items: RuleExpr[]) {
    for (let i = 0; i < items.length - 1; i++) {
      const a = items[i];
      const b = items[i + 1];
      if (a.type !== 'literal' || !isKeywordLiteral(a.value) || b.type !== 'ref') continue;
      const scope = inferIdentScope(a.value, scopeOverrides);
      if (!scope) continue;
      // Direct identifier-token adjacency, or the identifier reached through a
      // rule-ref whose base alternative starts with the identifier token.
      const adjacent =
        tokenNames.has(b.name) ||
        (identTokenName !== null && startsWithIdent(grammar, b.name, identTokenName));
      if (adjacent) patterns.push({ keyword: a.value, identScope: scope });
    }
  }

  function walk(node: RuleExpr) {
    if (node.type === 'seq') walkSeq(node.items);
    if (node.type === 'seq' || node.type === 'alt') node.items.forEach(walk);
    if (node.type === 'quantifier' || node.type === 'group') walk(node.body);
    if (node.type === 'sep') walk(node.element);
  }

  walk(expr);
  return patterns;
}

// ── Type annotation detection ──

/**
 * Check if any rule contains a `':' @type-ref` sequence,
 * meaning the language uses `:` for type annotations.
 */
export function hasColonTypeAnnotation(grammar: CstGrammar, typeRuleNames: Set<string>): boolean {
  function walk(expr: RuleExpr): boolean {
    if (expr.type === 'seq') {
      for (let i = 0; i < expr.items.length - 1; i++) {
        if (expr.items[i].type === 'literal' && (expr.items[i] as { value: string }).value === ':' &&
            expr.items[i + 1].type === 'ref' && typeRuleNames.has((expr.items[i + 1] as { name: string }).name)) {
          return true;
        }
      }
    }
    if (expr.type === 'alt' || expr.type === 'seq') return expr.items.some(walk);
    if (expr.type === 'quantifier' || expr.type === 'group') return walk(expr.body);
    if (expr.type === 'sep') return walk(expr.element);
    return false;
  }
  return grammar.rules.some(r => walk(r.body));
}

/**
 * Derive the CLOSE brackets that terminate a destructuring BINDING PATTERN
 * (`{ a } : T`, `[ a ] : T`), data-driven from the grammar.
 *
 * A binding-pattern rule is one whose every alternative is a bracket-delimited
 * sequence (`OPEN … CLOSE`) AND which is referenced as a direct alternative
 * standing in for the identifier — i.e. it appears in an `alt(…)` whose items also
 * reach the grammar's identifier token (the `alt([Ident,…], BindingPattern)` shape
 * every binding/param uses). That co-reference is what distinguishes a binding
 * pattern from a same-bracketed block / object-type body, which never substitutes
 * for a name. The brackets themselves are read off the rule, not hardcoded: a
 * grammar whose patterns are delimited by other paired brackets yields those, and a
 * grammar with no destructuring binding yields the empty set (so the dependent rule
 * is omitted entirely). `:`/`?` stay literal here, matching the rest of this
 * generator's type-annotation derivations (`#param-type-annotation`, etc.).
 */
export function deriveBindingCloseBrackets(grammar: CstGrammar, identName: string | undefined): string[] {
  const PAIR: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const directRef = (expr: RuleExpr | undefined, name: string): boolean => {
    if (!expr) return false;
    if (expr.type === 'ref') return expr.name === name;
    if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(i => directRef(i, name));
    if (expr.type === 'quantifier' || expr.type === 'group' || expr.type === 'sameLine') {
      return directRef((expr as { body?: RuleExpr }).body, name);
    }
    if (expr.type === 'sep') return directRef((expr as { element: RuleExpr }).element, name);
    return false;
  };
  // Rule names that appear in an `alt` whose siblings reach the identifier token —
  // candidates for "stands in for a binding name".
  const nameSubstitutes = new Set<string>();
  const scan = (expr: RuleExpr | undefined): void => {
    if (!expr) return;
    if (expr.type === 'alt' && identName && expr.items.some(i => directRef(i, identName))) {
      for (const it of expr.items) if (it.type === 'ref') nameSubstitutes.add(it.name);
    }
    if (expr.type === 'seq' || expr.type === 'alt') for (const i of expr.items) scan(i);
    if (expr.type === 'quantifier' || expr.type === 'group' || expr.type === 'sameLine') {
      scan((expr as { body?: RuleExpr }).body);
    }
    if (expr.type === 'sep') scan((expr as { element: RuleExpr }).element);
  };
  for (const r of grammar.rules) scan(r.body);

  const closes = new Set<string>();
  for (const r of grammar.rules) {
    if (!nameSubstitutes.has(r.name)) continue;
    const alts = r.body.type === 'alt' ? r.body.items : [r.body];
    const allBracketed = alts.length > 0 && alts.every(a => {
      if (a.type !== 'seq' || a.items.length < 2) return false;
      const f = a.items[0], l = a.items[a.items.length - 1];
      return f.type === 'literal' && l.type === 'literal' &&
        PAIR[(f as { value: string }).value] === (l as { value: string }).value;
    });
    if (!allBracketed) continue;
    for (const a of alts as { items: RuleExpr[] }[]) {
      const l = a.items[a.items.length - 1];
      if (l.type === 'literal') closes.add((l as { value: string }).value);
    }
  }
  return [...closes];
}

/**
 * Derive the CLOSE bracket(s) of a COMPUTED MEMBER KEY (`[ expr ] : T`), data-driven
 * from the grammar. A member's `: Type` annotation only opens a type region when the
 * key is a plain identifier (`#member-type-annotation`'s ident-anchored begin); a
 * computed key ends in a non-identifier bracket (`['x']: T`, `[Symbol.iterator]: T`),
 * so its `:` would otherwise fall through to bare punctuation and the type name be
 * scoped as a value — the same gap `#param-bind-type-annotation` closes for binding
 * patterns. This finds the bracket that wraps a computed key: a member-NAME rule
 * (one whose `ref` stands immediately before a member `(':' Type)` annotation) that
 * has a `[ OPEN … CLOSE ]` alternative; the CLOSE is read off the rule, not hardcoded.
 */
export function deriveComputedMemberCloseBrackets(grammar: CstGrammar, typeRuleNames: Set<string>): string[] {
  const PAIR: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  // Member-NAME rules: a `ref` that, within some sequence, is followed (allowing an
  // intervening optional `?`/group) by a literal `:` then a type-rule ref — the
  // `key (?) : Type` member shape. Those refs name the rules that occupy a key slot.
  const memberNameRules = new Set<string>();
  // The member shape `key (?) (signature | (: Type)? (= Expr)?)`: an alternation one of whose
  // branches leads with a (possibly optional) `: <typeRef>` annotation. Only an alternation
  // counts, so a lone optional annotation (a binding pattern's `{ a }: T`) does not make its ref
  // a member key.
  const isAnnotation = (e: RuleExpr): boolean => {
    if (e.type === 'seq') {
      const [c, t] = e.items;
      return c?.type === 'literal' && (c as { value: string }).value === ':' && t?.type === 'ref' && typeRuleNames.has((t as { name: string }).name)
        || (c !== undefined && isAnnotation(c));
    }
    if (e.type === 'quantifier' || e.type === 'group') return isAnnotation((e as { body: RuleExpr }).body);
    return false;
  };
  const isMemberTail = (e: RuleExpr): boolean => e.type === 'alt' && e.items.some(isAnnotation);
  const scanSeq = (items: RuleExpr[]): void => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // A member KEY is never a type-rule ref itself (excludes a TYPE `ref` that
      // happens to sit before a `:` in a type-internal construct — a conditional
      // type `T extends U ? X : Y`, a mapped-type `[K in T]: U`, etc.).
      if (it.type !== 'ref' || typeRuleNames.has(it.name)) continue;
      // look ahead for `… : <typeRef>`, or the member tail above, after this ref (skip an
      // optional `?`/group)
      for (let j = i + 1; j < items.length; j++) {
        const nx = items[j];
        if (nx.type === 'literal' && (nx as { value: string }).value === ':') {
          const after = items[j + 1];
          if (after && after.type === 'ref' && typeRuleNames.has((after as { name: string }).name)) {
            memberNameRules.add((it as { name: string }).name);
          }
          break;
        }
        if (isMemberTail(nx)) { memberNameRules.add((it as { name: string }).name); break; }
        // allow an optional `?` or a small group/quantifier to sit between key and `:`
        if (nx.type === 'literal' && (nx as { value: string }).value === '?') continue;
        if (nx.type === 'quantifier' || nx.type === 'group') continue;
        break;
      }
    }
  };
  const walk = (expr: RuleExpr | undefined): void => {
    if (!expr) return;
    if (expr.type === 'seq') scanSeq(expr.items);
    if (expr.type === 'seq' || expr.type === 'alt') for (const i of expr.items) walk(i);
    if (expr.type === 'quantifier' || expr.type === 'group' || expr.type === 'sameLine') {
      walk((expr as { body?: RuleExpr }).body);
    }
    if (expr.type === 'sep') walk((expr as { element: RuleExpr }).element);
  };
  for (const r of grammar.rules) walk(r.body);

  // Does a rule-expr (transitively, within this alternative) reference a non-type
  // rule — i.e. wrap an EXPRESSION? A computed property KEY brackets an expression
  // (`[ Expr ]`); a TUPLE type brackets types (`[ Type, … ]`). Requiring an
  // expression ref inside the bracket pair keeps this to genuine computed keys.
  const wrapsExpr = (expr: RuleExpr | undefined): boolean => {
    if (!expr) return false;
    if (expr.type === 'ref') return !typeRuleNames.has(expr.name);
    if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(wrapsExpr);
    if (expr.type === 'quantifier' || expr.type === 'group' || expr.type === 'sameLine') {
      return wrapsExpr((expr as { body?: RuleExpr }).body);
    }
    if (expr.type === 'sep') return wrapsExpr((expr as { element: RuleExpr }).element);
    return false;
  };

  const closes = new Set<string>();
  for (const r of grammar.rules) {
    if (!memberNameRules.has(r.name)) continue;
    const alts = r.body.type === 'alt' ? r.body.items : [r.body];
    for (const a of alts) {
      if (a.type !== 'seq' || a.items.length < 2) continue;
      const f = a.items[0], l = a.items[a.items.length - 1];
      if (f.type === 'literal' && l.type === 'literal' &&
          PAIR[(f as { value: string }).value] === (l as { value: string }).value &&
          // the bracket must wrap an expression (computed key), not types (a tuple)
          a.items.slice(1, -1).some(wrapsExpr)) {
        closes.add((l as { value: string }).value);
      }
    }
  }
  return [...closes];
}

// ── Token lookups (the role tables are in src/highlight-roles.ts) ──

// The grammar's CALLEE token: one scoped as a function name whose pattern is gated on a
// following `(` (e.g. env-spec FUNCTION_NAME, `name(?=\s*\()`). Shared by the two derived
// call-argument regions (the contextualScopes call-args region and the lineComment
// continuation-bracket call variant), which must agree on what a callee looks like.
export function findCalleeToken(grammar: CstGrammar): TokenDecl | undefined {
  return grammar.tokens.find((t) => {
    const sc = t.scope ?? classifyToken(t).scope;
    return (sc.startsWith('variable.function') || sc.startsWith('entity.name.function')) && tokenPatternSource(t).includes('\\(');
  });
}

/**
 * The repository keys of the grammar's COMMENT token entries, in declaration
 * order. A token is a comment iff its emitted scope (the `@scope` override, else
 * the classified scope) starts with `comment.` — the same classification the
 * token-emission pass uses — and its repo key is `tok.name.toLowerCase()`, the
 * same key that pass registers the entry under. Deriving the keys this way (not
 * by hardcoding e.g. `"linecomment"`) lets any region that may legally contain a
 * comment — a multiline type-arg list, a JSX open tag — `#include` the real
 * comment entries the grammar declared, whatever they are named.
 */
export function commentRepoKeys(grammar: CstGrammar): string[] {
  const keys: string[] = [];
  for (const tok of grammar.tokens) {
    if (tok.flags.includes('regex')) continue;   // @regex tokens aren't comments
    const scope = classifyToken(tok).scope;
    if (scope.startsWith('comment.')) keys.push(tok.name.toLowerCase());
  }
  return keys;
}

/**
 * The full-match regexes of the grammar's BLOCK-comment tokens (a `comment.block…`
 * token whose pattern has a delimited body — `/* … *​/`, `(* … *)`, whatever the
 * grammar declared). Derived, never hardcoded: a token is a block comment iff its
 * classified scope is `comment.block…` AND the token-pattern IR reports a
 * begin/body/end shape — the same `isBlock` test `classifyToken` uses. The
 * token's own `pattern` IS its full match, so it can be embedded directly into a
 * lookahead to "see through" a block comment (a LINE comment can't precede
 * same-line code — it eats to EOL — so only block comments are collected here).
 */
export function blockCommentMatchers(grammar: CstGrammar): string[] {
  const pats: string[] = [];
  for (const tok of grammar.tokens) {
    if (tok.flags.includes('regex')) continue;
    const c = classifyToken(tok);
    const scope = c.scope;
    if (scope.startsWith('comment.') && c.isBlock) pats.push(tokenPatternSource(tok));
  }
  return pats;
}

// ── Type-keyword detection ──

/**
 * Find keywords that are directly followed by a @type rule ref.
 * E.g., 'extends' Type  →  the identifier after 'extends' is a type name.
 *
 * Excludes storage-modifier keywords (readonly etc.) which have dual
 * usage as modifiers in non-type contexts.
 */
export function findTypeKeywordPatterns(
  grammar: CstGrammar,
  typeRuleNames: Set<string>,
): string[] {
  const keywords: string[] = [];

  function isTypeRef(item: RuleExpr): boolean {
    if (item.type === 'ref') return typeRuleNames.has(item.name);
    if (item.type === 'sep') return isTypeRef(item.element);
    return false;
  }

  function checkSeq(items: RuleExpr[]) {
    for (let i = 0; i < items.length - 1; i++) {
      const a = items[i];
      const b = items[i + 1];
      if (a.type === 'literal' && isKeywordLiteral(a.value) && isTypeRef(b)) {
        if (!keywords.includes(a.value)) {
          keywords.push(a.value);
        }
      }
    }
  }

  function walk(expr: RuleExpr) {
    if (expr.type === 'seq') checkSeq(expr.items);
    if (expr.type === 'alt' || expr.type === 'seq') expr.items.forEach(walk);
    if (expr.type === 'quantifier' || expr.type === 'group') walk(expr.body);
    if (expr.type === 'sep') walk(expr.element);
  }

  for (const rule of grammar.rules) {
    walk(rule.body);
  }

  // Exclude dual-use keywords that shouldn't trigger type scope
  return keywords.filter(k => {
    const scope = getScope(grammar.scopeOverrides,k);
    if (!scope) return true;
    if (scope.startsWith('storage.modifier')) return false;
    if (scope.startsWith('keyword.control')) return false;
    return true;
  });
}

// ── Contextual operator keyword detection ──

/**
 * Collect the grammar's reserved words: the words some `not(...)` guard excludes from the
 * identifier token (`[not(alt('class', …)), Ident]` — binding name, shorthand property,
 * expression NUD). A word no guard excludes from it is never reserved by the grammar, i.e. it
 * is a valid identifier somewhere.
 *
 * A lookahead consumes nothing: what it holds says what may FOLLOW its position, not what is
 * matched there. So a guard excludes a word from the identifier only when both hold:
 *   - it rejects the one token `w` whatever comes after it: `w` is the guard's body or an
 *     alternative of it. `not(['type', not(Ident)])` rejects `type` only before a non-name,
 *     and `not(not(w))` requires `w`, so neither excludes `type` / `w`;
 *   - what follows the guard can begin with the identifier token (its FIRST set, read from
 *     grammar-analysis; a continuation that can end the rule counts as reaching it, since the
 *     caller's next item is not looked at). `'export' not('default') '{'` only says which
 *     token follows `export`.
 * Guards nested in a guard's body are conditions of that lookahead, never exclusions at a
 * consumed position, so they are not visited.
 *
 * Language-agnostic: reads only the `not` AST nodes, never specific words.
 */
export function collectReservedWords(grammar: CstGrammar): Set<string> {
  const reserved = new Set<string>();
  const identToken = grammar.tokens.find(t => t.identifier);
  if (!identToken) return reserved;
  const ident = identToken.name;
  const { exprFirst, exprNullable } = analyzeGrammar(grammar);
  const rejectedAlone = (e: RuleExpr): void => {
    if (e.type === 'literal') { if (isKeywordLiteral(e.value)) reserved.add(e.value); }
    else if (e.type === 'alt') e.items.forEach(rejectedAlone);
    else if (e.type === 'group') rejectedAlone(e.body);
    else if (e.type === 'seq' && e.items.length === 1) rejectedAlone(e.items[0]);
  };
  // `next`: the items that follow `e` inside its rule, in order.
  function walk(e: RuleExpr, next: RuleExpr[]): void {
    if (e.type === 'seq') e.items.forEach((item, i) => walk(item, [...e.items.slice(i + 1), ...next]));
    else if (e.type === 'alt') e.items.forEach(i => walk(i, next));
    else if (e.type === 'quantifier') walk(e.body, e.kind === '?' ? next : [{ type: 'quantifier', kind: '*', body: e.body }, ...next]);
    else if (e.type === 'group') walk(e.body, next);
    else if (e.type === 'sep') walk(e.element, next);
    else if (e.type === 'not') {
      const rest: RuleExpr = { type: 'seq', items: next };
      const first = exprFirst(rest);
      if (first === null || first.has(ident) || exprNullable(rest)) rejectedAlone(e.body);
    }
  }
  for (const rule of grammar.rules) walk(rule.body, []);
  return reserved;
}

/**
 * Find "contextual operator keywords": keyword.operator.expression-class words
 * that are NOT always-reserved (per collectReservedWords) and therefore double
 * as ordinary identifiers (`const as = 1`, `as()`, `as.x`). These are keywords
 * only in operator position — preceded by a value and/or followed by an operand
 * (`x as T`, `keyof T`, `p is T`, `infer U`, `x satisfies T`). The flat global
 * keyword match would otherwise mis-scope every identifier use as a keyword.
 *
 * Returns the words; the caller scopes them positionally (operand lookahead).
 * Reserved operator words (`typeof`, `new`, `void`, `delete`, `instanceof`) are
 * NOT returned — they can never be identifiers, so the flat match is correct.
 */
export function findContextualOperatorKeywords(grammar: CstGrammar): Set<string> {
  const reserved = collectReservedWords(grammar);
  const result = new Set<string>();
  for (const [kw, scopes] of grammar.scopeOverrides) {
    if (!isKeywordLiteral(kw)) continue;
    if (reserved.has(kw)) continue;
    if (scopes.some(s => s.startsWith('keyword.operator.expression'))) result.add(kw);
  }
  return result;
}

/**
 * Find "contextual accessibility modifiers": storage.modifier keywords that ALSO
 * double as ordinary identifiers / property names and therefore must only be
 * scoped `storage.modifier` when they actually stand in modifier position
 * (`public x`, `private static y`, `protected [e]`), falling through to the
 * surrounding identifier scoping otherwise (`var public = 1`, `x = private`,
 * `class C { public }`, `[public]: 0`).
 *
 * A storage.modifier keyword is a *pure prefix modifier* — and thus safe to
 * guard this way — when every token that can immediately follow it (its grammar
 * FOLLOW first-set) can also begin a class member / binding name: an identifier,
 * `[` (computed member / array binding), `*` (generator), `#` (private field),
 * `{`/`...` (a binding pattern / rest the shared member-body rules permit), or
 * another such modifier. Modifiers whose FOLLOW also contains a non-member token
 * — `(` / `=>` (`async () =>`), `{` reached as a *block* / `+`/`-` (`static {…}`,
 * `static +readonly [`), `<` (`async <T>()`), a type-operator operand
 * (`readonly (A|B)[]`), or a declaration keyword (`declare function`) — are NOT
 * pure prefixes: their flat unconditional match stays correct, so they are
 * excluded. Language-agnostic: reads only the rule graph and the scope map.
 */
export function findContextualAccessibilityModifiers(grammar: CstGrammar): Set<string> {
  const reserved = collectReservedWords(grammar);
  const modKws = new Set<string>();
  for (const [lit, scopes] of grammar.scopeOverrides) {
    if (!isKeywordLiteral(lit) || reserved.has(lit)) continue;
    if (scopes.some(s => s.startsWith('storage.modifier'))) modKws.add(lit);
  }
  if (modKws.size === 0) return modKws;

  const ruleByName = new Map(grammar.rules.map(r => [r.name, r]));
  const byName = new Map(grammar.rules.map(r => [r.name, r.body]));

  // Modifier literals an expression can END with (its last-set), peeking through
  // opt/many/group/alt — used to attribute the NEXT sibling's first-set as FOLLOW.
  const lastModifiers = (e: RuleExpr, out: Set<string>): void => {
    switch (e.type) {
      case 'literal': if (modKws.has(e.value)) out.add(e.value); return;
      case 'seq':   // looks back past nullable items, as FIRST looks past them
        for (let j = e.items.length - 1; j >= 0; j--) { lastModifiers(e.items[j], out); if (!ruleIsNullable(e.items[j], byName)) return; }
        return;
      case 'alt': for (const it of e.items) lastModifiers(it, out); return;
      case 'quantifier': case 'group': lastModifiers(e.body, out); return;
      case 'sep': lastModifiers(e.element, out); return;
    }
  };
  // First-set literals of an expression, resolving rule refs (so `Block` → `{`). A nullable item
  // (a zero-width lookahead, an `opt`, a `many`) is no occurrence of what follows it: FIRST looks
  // past it to the next item (`not(…)` says what may follow, it is not a follower itself).
  const firstOfItems = (items: RuleExpr[], from: number, out: Set<string>, seen: Set<string>): void => {
    for (let j = from; j < items.length; j++) {
      firstLiterals(items[j], out, seen);
      if (!ruleIsNullable(items[j], byName)) return;
    }
  };
  const firstLiterals = (e: RuleExpr, out: Set<string>, seen: Set<string>): void => {
    switch (e.type) {
      case 'literal': out.add(e.value); return;
      case 'ref': {
        if (seen.has(e.name)) return;
        seen.add(e.name);
        const r = ruleByName.get(e.name);
        if (r) firstLiterals(r.body, out, seen);
        return;
      }
      case 'seq': firstOfItems(e.items, 0, out, seen); return;
      case 'alt': for (const it of e.items) firstLiterals(it, out, seen); return;
      case 'quantifier': case 'group': firstLiterals(e.body, out, seen); return;
      case 'sep': firstLiterals(e.element, out, seen); return;
    }
  };

  const followers = new Map<string, Set<string>>();
  for (const m of modKws) followers.set(m, new Set());
  const walk = (e: RuleExpr): void => {
    if (e.type === 'seq') {
      for (let i = 0; i < e.items.length; i++) {
        const enders = new Set<string>();
        lastModifiers(e.items[i], enders);
        if (enders.size) for (const m of enders) firstOfItems(e.items, i + 1, followers.get(m)!, new Set());
      }
      e.items.forEach(walk);
    } else if (e.type === 'alt') e.items.forEach(walk);
    else if (e.type === 'quantifier' || e.type === 'group') walk(e.body);
    else if (e.type === 'sep') walk(e.element);
  };
  for (const r of grammar.rules) walk(r.body);

  // A follower literal begins a member/binding name iff its first char is an
  // identifier-start char or one of `[ * # " ' { ...` / a digit. Spread `...`
  // and a binding-pattern `{` are member/binding starts; `(` `<` `=>` `+` `-`
  // `=` `:` `;` etc. are not (they reveal a non-modifier production).
  const memberStart = (lit: string): boolean =>
    lit.length > 0 && (/[a-zA-Z_$\p{L}\p{Nl}]/u.test(lit[0]) || '[*#"\'{.0123456789'.includes(lit[0]));

  const result = new Set<string>();
  for (const m of modKws) {
    const f = followers.get(m)!;
    // Require at least one known follower: a modifier that never appears before
    // anything would never satisfy the member-start lookahead, so guarding it
    // would silently stop it from ever being scoped. Keep such a word flat.
    if (f.size > 0 && [...f].every(memberStart)) result.add(m);
  }
  return result;
}

/**
 * Read the NO-COMMA disambiguating constraint keyword(s) off the type-parameter
 * rule — the `.tsx` analogue of how the comma separator is read off `sep(…, ',')`.
 *
 * A `.tsx` `<…>` with a single type-param and NO trailing comma is ambiguous with a
 * JSX tag, EXCEPT when the param carries a CONSTRAINT keyword: `<T extends X>() =>`
 * is an unambiguous generic arrow (verified against tsc/ScriptKind.TSX — 0 parse
 * errors, an ArrowFunction), whereas a bare `<T>` / a modifier-only `<const T>` /
 * `<in T>` is parsed as JSX. So the constraint keyword (and ONLY it) is the second
 * no-comma signal a generic-arrow guard may rely on.
 *
 * The keyword is declared, not hardcoded: the type-param rule (the `sep` element of
 * the `'<' sep(TypeParam, ',') '>'` form) contains an OPTIONAL `[<word-literal>, Type]`
 * pair — the constraint (`opt('extends', Type)`). We surface every such WORD literal
 * (alphabetic, so it can be `\b`-bounded and JSX-attr-ambiguous — unlike the `=`
 * default, whose `[ '=' , Type]` pair is punctuation and is NOT a usable no-comma
 * signal: a top-level `=` also appears in JSX attributes, e.g. `<Foo a={x}>(c)</Foo>`,
 * and would mis-flip them). A grammar whose constraint keyword is something other than
 * `extends` yields THAT word; a type-param rule with no such constraint (e.g. the
 * agnostic test's bare `<T,>` generics) yields none, and the guard falls back to the
 * comma-only form — output unchanged. test/agnostic.ts proves the derivation.
 *
 * `typeArgRule` is the rule used inside a generic type-ARGUMENT list (`Foo<Type>`,
 * detectAngleBracketAmbiguity's innerRuleName, e.g. `Type`). Type-argument lists share
 * the same `'<' sep(…, ',') '>'` shape but their element is a TYPE, not a param
 * DECLARATION — and a type rule's own `opt('is', Type)` type-predicate would otherwise
 * be misread as a "constraint". So that rule is excluded from the param-rule scan.
 */
export function detectTypeParamConstraintKeywords(grammar: CstGrammar, typeArgRule: string | null): string[] {
  const g = armGraph(grammar);
  const sepElementRules = new Set<string>();
  for (const [, s] of findWindows(g, [isLit('<'), (e) => e.type === 'sep', isLit('>')], ruleRoots(g))) {
    const el = (g.node[s] as { element: RuleExpr }).element;
    if (el.type === 'ref' && el.name !== typeArgRule) sepElementRules.add(el.name);
  }
  return prefixPairKeywords(grammar, sepElementRules);
}

function prefixPairKeywords(grammar: CstGrammar, sepElementRules: Set<string>): string[] {
  // In each such rule, find the constraint keyword: the WORD literal that BEGINS an OPTIONAL
  // `[keyword, type…]` segment. "Optional" is read structurally from expandArms(body): the constraint
  // is exactly the segment by which one branch EXTENDS a prefix-shorter sibling — so `opt(kw, type)`
  // (a `?` body), a separate alt branch `alt([…, kw, type], […])`, and a `sep`-wrapped type ALL reduce
  // to "branch B = branch A ++ [kw, …]". The keyword is `B[len(A)]` when it is a word literal. This
  // reads the OPTIONALITY (the distinguishing fact), so a LEADING modifier (`const`/`in`/`out`, whose
  // own optionality makes `[name]` vs `[const,name]` — NOT a prefix pair) is not mistaken for it, and a
  // punctuation lead like `=` (the default) is excluded by the word test.
  const keywords = new Set<string>();
  const isWord = (s: string) => /^[A-Za-z_]/.test(s);
  const sig = (e: RuleExpr): string =>
    e.type === 'literal' ? 'L:' + (e as { value: string }).value
    : e.type === 'ref' ? 'R:' + (e as { name: string }).name
    : e.type === 'sep' ? 'S:' + sig((e as { element: RuleExpr }).element)
    : e.type === 'seq' || e.type === 'alt' ? e.type + '[' + (e as { items: RuleExpr[] }).items.map(sig).join(',') + ']'
    : e.type === 'quantifier' ? 'Q' + (e as { kind: string }).kind + sig((e as { body: RuleExpr }).body)
    : (e.type === 'group' || e.type === 'not') ? e.type[0] + sig((e as { body: RuleExpr }).body)
    : e.type;
  for (const rule of grammar.rules) {
    if (!sepElementRules.has(rule.name)) continue;
    const branches = expandArms(rule.body);
    for (const a of branches) for (const b of branches) {
      if (b.length <= a.length) continue;
      if (!a.every((it, i) => sig(it) === sig(b[i]))) continue;   // a is a strict prefix of b
      const head = b[a.length];
      if (head.type === 'literal' && isWord((head as { value: string }).value)) keywords.add((head as { value: string }).value);
    }
  }
  return [...keywords];
}

// ── Angle bracket disambiguation ──

export interface AngleBracketAmbiguity {
  innerRuleName: string;     // e.g., 'Type'
  confirmTokens: string[];   // e.g., ['(', '`']  — chars that confirm > is generic-close
  separator: string;         // the `sep` delimiter inside `<…>` (e.g. ',' from `sep(Type, ',')`)
}

/**
 * Detect if '<' appears both as an operator (prec table) and as a
 * delimiter (rule body) paired with '>'.  Collects ALL confirm tokens
 * across every matching alternative (e.g. '(' for calls, '`' for
 * tagged templates).
 */
export function detectAngleBracketAmbiguity(grammar: CstGrammar): AngleBracketAmbiguity | null {
  const precOps = new Set(grammar.precs.flatMap(l => l.operators.map(o => o.value)));
  if (!precOps.has('<') || !precOps.has('>')) return null;
  const confirmChar = (item: RuleExpr): string | null => {
    if (item.type === 'literal') return item.value;
    if (item.type === 'ref') {
      const token = grammar.tokens.find(t => t.name === item.name);
      const delimiter = token ? tokenPatternStringDelimiters(token)[0] : undefined;
      if (delimiter && /^[`'"]/.test(delimiter)) return delimiter[0];
    }
    return null;
  };
  const g = armGraph(grammar);
  const sepOfRef = (e: RuleExpr) => e.type === 'sep' && e.element.type === 'ref';
  let innerRuleName: string | null = null, separator: string | null = null;
  const confirmTokens: string[] = [];
  for (const [, s, , x] of sortInArmOrder(g, findWindows(g, [isLit('<'), sepOfRef, isLit('>'), () => true], ruleRoots(g)))) {
    const ch = confirmChar(g.node[x]);
    if (!ch || confirmTokens.includes(ch)) continue;
    const sep = g.node[s] as { element: { name: string }; delimiter: string };
    innerRuleName = sep.element.name;
    separator = sep.delimiter;
    confirmTokens.push(ch);
  }
  return innerRuleName && confirmTokens.length > 0 ? { innerRuleName, confirmTokens, separator: separator ?? ',' } : null;
}


/**
 * Detect an angle-bracket TYPE-ASSERTION (cast) alternative:
 *   '<' <typeRef> '>' <operand>
 * i.e. a literal `<`, then a single ref to a @type rule, then `>`, then a
 * following item (the operand the cast applies to). This is the TS prefix cast
 * `<Type>expr`, distinct from `'<' sep(Type) '>'` generics (whose second item is
 * a `sep`, not a bare ref). Also through a CAST-HEAD rule, `[<castHeadRef>, operand]`: a rule every
 * arm of which is exactly `'<' <typeRef> '>'` (the `<…>` hidden behind the ref boundary, resolved by
 * name as detectCallExpression reaches its arguments through a rule of their own). Over the
 * rule-body arms; the inner type rule name of the LAST match in arm order, or null.
 */
export function detectAngleBracketCast(grammar: CstGrammar): string | null {
  const typeRules = new Set(grammar.rules.filter(r => r.flags.includes('type')).map(r => r.name));
  if (typeRules.size === 0) return null;
  const g = armGraph(grammar);
  const typeRef = (e: RuleExpr) => e.type === 'ref' && typeRules.has(e.name);
  const lastKey = (w: number[], atStart = false) => armOrderKey(g, w, [], atStart, { atEnd: atStart, last: true });
  const castHeadMemo = new Map<string, string | null>();
  const castHeadType = (name: string): string | null => {
    if (castHeadMemo.has(name)) return castHeadMemo.get(name)!;
    const r = rootOfRule(g, grammar, name);
    let ty: string | null = null;
    if (r >= 0 && !g.nullable[r]) {
      // every arm `'<' T '>'`: each first is `<` (not an end), each next a type ref (not an end),
      // each next `>` ending the arm; the type of the last arm.
      const arms: number[][] = [];
      const ok = g.first[r].every(a => isLit('<')(g.node[a]) && !g.isLast[a] && g.follow[a].every(b => typeRef(g.node[b]) && !g.isLast[b]
        && g.follow[b].every(c => { arms.push([a, b, c]); return isLit('>')(g.node[c]) && g.isLast[c] && g.follow[c].length === 0; })));
      if (ok && arms.length) ty = (g.node[arms.map(w => ({ w, key: lastKey(w, true) })).sort((x, y) => compareArmOrder(y.key, x.key))[0].w[1]] as { name: string }).name;
    }
    castHeadMemo.set(name, ty);
    return ty;
  };
  const met: { ty: string; key: number[] }[] = [];
  for (const w of findWindows(g, [isLit('<'), typeRef, isLit('>'), () => true], ruleRoots(g))) met.push({ ty: (g.node[w[1]] as { name: string }).name, key: lastKey(w) });
  for (const w of findWindows(g, [(e) => e.type === 'ref' && grammar.rules.some(r => r.name === e.name), () => true], ruleRoots(g))) {
    const ty = castHeadType((g.node[w[0]] as { name: string }).name);
    if (ty) met.push({ ty, key: lastKey(w) });
  }
  return met.sort((x, y) => compareArmOrder(y.key, x.key))[0]?.ty ?? null;
}

// ── Conditional-type detection ──

/**
 * Detect a conditional-type production: a `{ type: true }` rule whose body
 * contains the literal sequence `<ref> KW <ref> '?' <ref> ':' <ref>` — i.e.
 * `Type extends Type ? Type : Type`, the ternary form of the type ternary.
 * Returns the connector keyword literal (`extends`) so the caller can look up
 * its scope from the derived scope map (NOT hardcoded). `null` if no rule has
 * the shape, in which case no `type-conditional` region is emitted.
 *
 * The first such window in arm order, in the arms of a type-flagged rule (or of a
 * `sep` element within one). Like detectTernary's window, but gated on a type-flagged rule and a
 * keyword connector between the head/check types — that connector is what
 * distinguishes a conditional `?`/`:` (a ternary) from an OPTIONAL `?`
 * (`{ a?: T }`). The emitted region anchors on the connector so the inner
 * ternary scope only exists inside a conditional.
 */
export function detectConditionalType(grammar: CstGrammar): string | null {
  const g = armGraph(grammar);
  const typeRoot = (r: number) => grammar.rules[g.ruleIndex[r]].flags.includes('type');
  const w = sortInArmOrder(g, findWindows(g, [isRefItem, isKeywordItem, isRefItem, isLit('?'), isRefItem, isLit(':'), isRefItem], typeRoot))[0];
  return w ? (g.node[w[1]] as { value: string }).value : null;
}


// ── Regex literal disambiguation ──

export interface RegexLiteralInfo {
  flagsPattern: string;   // e.g., '[gimsuy]*'
  preceedingKeywords: string[];  // keywords that can precede a regex literal
  precedingChars: string[];  // single-char operators/punctuation that can precede regex
  // Chars (e.g. `!`) that are AMBIGUOUS postfix/prefix ops: a regex may follow one ONLY in
  // its prefix form (`!/re/`), i.e. when the op-run is ITSELF in a regex-start position; in
  // postfix form (`x! / y` — non-null) a following `/` is division. Kept OUT of precedingChars
  // (which would make every `/` after one a regex) and handled by a recursive lookbehind that
  // checks the context BEFORE the op-run. From the grammar's regexContext.postfixAfterValueTexts.
  postfixAmbiguousChars: string[];
  commentSecondChars: string[];  // chars after '/' that start comments (e.g., ['/', '*'])
  // The member-access texts (`.`, `?.`: regexContext.memberAccessTexts): a keyword right after
  // one is a property NAME, not the keyword, so it is no regex position (`o.new / 2` divides).
  memberAccessTexts: string[];
  // Regex-escaped block-comment delimiter pairs that share the regex's `/` prefix
  // (e.g. `['\\/\\*', '\\*\\/']` for `/* … */`). A comment is transparent to the
  // regex-vs-division decision, so a regex literal may begin right after one.
  blockComments: { begin: string; end: string }[];
}

/**
 * Detect if a @regex token exists and '/' is also in the prec table (ambiguity).
 * Infer "regex-preceding keywords" from rule bodies: keywords directly before
 * an expression-rule reference indicate positions where regex can appear.
 *
 * E.g., 'return' Expr  →  'return' can precede regex
 *        'throw' Expr   →  'throw' can precede regex
 */
export function detectRegexLiteral(grammar: CstGrammar, tokenNames: Set<string>): RegexLiteralInfo | null {
  const regexToken = grammar.tokens.find(t => t.flags.includes('regex'));
  if (!regexToken) return null;

  // Check if '/' is in prec table (confirming ambiguity)
  const hasSlashOp = grammar.precs.some(level =>
    level.operators.some(op => op.value === '/' || op.value === '/=')
  );
  if (!hasSlashOp) {
    // No ambiguity — just generate a simple match pattern
    return null;
  }

  const flagChars = tokenPatternTrailingCharClass(regexToken);
  const flagsPattern = flagChars ? `[${flagChars}]*` : '[a-z]*';

  // Collect keywords that can directly precede a regex: a keyword followed by a reference to a
  // rule that can BEGIN with the regex token (grammar-analysis FIRST; null = anything, as a Pratt
  // expression rule is). A rule that cannot begin with one (a binding after `let` / `var`) does
  // not make the keyword a regex position: `o.var / 2` stays a division.
  const { exprFirst } = analyzeGrammar(grammar);
  const beginsRegex = (ref: RuleExpr): boolean => {
    const first = exprFirst(ref);
    return first === null || first.has(regexToken.name);
  };

  const preceedingKeywords = regexPrecedingKeywords(grammar, beginsRegex);
  const prefixOps = new Set<string>();

  // Prefix operators from prec table
  for (const level of grammar.precs) {
    for (const op of level.operators) {
      if (op.position === 'prefix' && isKeywordLiteral(op.value)) {
        prefixOps.add(op.value);
      }
    }
  }

  // Also add alphabetic prefix operators (typeof, void, delete, await, etc.)
  for (const op of prefixOps) {
    if (!preceedingKeywords.includes(op)) {
      preceedingKeywords.push(op);
    }
  }

  // Collect single-char operators/punctuation that can precede a regex literal.
  // Derived from prec table (infix/prefix operators) and grammar rule literals.
  const precedingChars: string[] = [];
  const seenChars = new Set<string>();
  // Close brackets precede division, not regex
  const closeBrackets = new Set([')', ']', '}']);
  // Ambiguous postfix/prefix op chars (TS `!`): handled by a dedicated recursive lookbehind,
  // so keep them OUT of the flat preceding-char class (else `x! / y` would lex as a regex).
  const regexCtx = grammar.tokens.find(t => t.regexContext)?.regexContext;
  const postfixAmbiguousChars = (regexCtx?.postfixAfterValueTexts ?? []).filter(c => c.length === 1);
  const postfixAmbiguousSet = new Set(postfixAmbiguousChars);
  // Infix/prefix operators from prec table
  for (const level of grammar.precs) {
    for (const op of level.operators) {
      if (op.value.length === 1 && !/[a-zA-Z]/.test(op.value) &&
          op.position !== 'postfix' && op.value !== '/' &&
          !postfixAmbiguousSet.has(op.value) && !seenChars.has(op.value)) {
        precedingChars.push(op.value);
        seenChars.add(op.value);
      }
    }
  }
  // Single-char structural punctuation from grammar rules (open brackets, separators)
  for (const rule of grammar.rules) {
    for (const lit of collectLiterals(rule.body)) {
      if (lit.length === 1 && !/[a-zA-Z]/.test(lit) &&
          !closeBrackets.has(lit) && !postfixAmbiguousSet.has(lit) && !seenChars.has(lit)) {
        precedingChars.push(lit);
        seenChars.add(lit);
      }
    }
  }

  // Derive comment-second-chars: skip tokens starting with '/' indicate which
  // chars after '/' start a comment (e.g., '/' for //, '*' for /*).
  // The regex literal must exclude these to avoid matching comment starts.
  // Also collect `/…`-prefixed BLOCK comment delimiter pairs (e.g. `/* … */`):
  // a comment is transparent to the regex-vs-division decision, so a regex may
  // begin right after one (`= /**/ /re/`). Sharing the `/` prefix is what makes
  // them ambiguous with the regex's opening `/`, so only those are relevant.
  const commentSecondChars: string[] = [];
  const blockComments: { begin: string; end: string }[] = [];
  const seenBlock = new Set<string>();
  for (const tok of grammar.tokens) {
    if (!tok.flags.includes('skip')) continue;
    const prefix = tokenPatternLiteralPrefix(tok) ?? '';
    if (prefix.length >= 2 && prefix[0] === '/') {
      const ch = prefix[1];
      if (!commentSecondChars.includes(ch)) commentSecondChars.push(ch);
      const delims = tokenPatternBlockDelimiters(tok);
      if (delims) {
        const [beginLit, endLit] = delims;
        const [begin, end] = tokenPatternBlockDelimiterSources(tok) ?? [escapeRegex(beginLit), escapeRegex(endLit)];
        const sig = `${begin}${end}`;
        if (!seenBlock.has(sig)) { seenBlock.add(sig); blockComments.push({ begin, end }); }
      }
    }
  }

  return { flagsPattern, preceedingKeywords, precedingChars, postfixAmbiguousChars, commentSecondChars, blockComments, memberAccessTexts: highlightFacts(grammar).memberAccessTexts };
}

// ── Declaration pattern detection ──

export interface DeclInfo {
  keyword: string;
  nameScope: string;      // entity.name.function | entity.name.type
  keywordScope: string;   // storage.type.function | storage.type.class etc.
  hasParams: boolean;     // has '(' ... ')' in the sequence
  hasTypeParams: boolean; // has ref to angle-bracket-sep rule (e.g., TypeParams)
  hasBody: boolean;       // has '{' ... '}' or Block ref
  // The body is OPTIONAL: the keyword appears in BOTH a body-having expansion and a
  // body-LESS one — i.e. `alt(Block, opt(';'))` (a function overload / ambient
  // `declare function f();`). Such a declaration must close its region on the
  // body-less `;` terminator too, not only `(?<=\})`, or the meta.function region
  // runs away into the next statement. Derived from the expanded sequences.
  optionalBody: boolean;
  typeParamKeywords: string[];  // keywords in type param rule (e.g., ['extends'])
  endHint?: string;       // for bodyless decls: next literal after name/type-params
  midLiterals: string[];  // non-alphabetic literals between keyword and name (e.g., ['*'] for function*)
  qualifiedName: boolean; // name is a dotted EntityName (e.g., `namespace A.B.C`): name followed by ('.' Ident)*
}

/** Whether some arm of `body` (a rule body) is exactly `'<' sep(…, ',') '>'` (a type-parameter
 *  list rule, however factored: a trailing `opt(',')`, an alt split, a group wrapper). */
export function isAngleBracketSepRule(grammar: CstGrammar, body: RuleExpr): boolean {
  const g = armGraph(grammar);
  const r = rootOfBody(g, body);
  if (r < 0) return false;
  return g.first[r].some(p => isLit('<')(g.node[p]) && !g.isLast[p] && g.follow[p].some(s => {
    const e = g.node[s];
    return e.type === 'sep' && e.delimiter === ',' && !g.isLast[s] && g.follow[s].some(t => isLit('>')(g.node[t]) && g.isLast[t]);
  }));
}

export function getTypeParamElementKeywords(body: RuleExpr, grammar: CstGrammar): string[] {
  // Find the `'<' sep '>'` adjacency in any NORMALISED branch (so a trailing `opt(',')` or an
  // alt-wrapped body still surfaces it; a small body: expandArms), then hoist
  // the element's keywords. Without this the keyword sub-pattern (the `\bextends\b` scoping inside
  // `<…>`) is dropped for those equivalent factorings even though the region itself is still emitted.
  let elementBody: RuleExpr | null = null;
  for (const items of expandArms(body)) {
    const i = items.findIndex(x => x.type === 'literal' && (x as { value: string }).value === '<');
    if (i >= 0 && items[i + 1]?.type === 'sep' && items[i + 2]?.type === 'literal' && (items[i + 2] as { value: string }).value === '>') {
      elementBody = (items[i + 1] as { element: RuleExpr }).element; break;
    }
  }
  if (!elementBody) return [];
  if (elementBody.type === 'ref') {
    const rule = grammar.rules.find(r => r.name === (elementBody as { name: string }).name);
    if (rule) elementBody = rule.body;
  }
  const keywords: string[] = [];
  function walk(e: RuleExpr) {
    // collect a literal the element CONSUMES that bears a scope obligation: a keyword, OR any
    // literal the grammar declares a scope for (e.g. a `&` separator scoped punctuation.separator)
    // — so a declared-scope PUNCTUATION inside the element keeps its scope inside `<…>` too, not
    // only keywords. The emit site picks the right boundary (`\b` for words, none for punctuation).
    if (e.type === 'literal' && (isKeywordLiteral(e.value) || grammar.scopeOverrides.has(e.value))) keywords.push(e.value);
    if (e.type === 'seq' || e.type === 'alt') e.items.forEach(walk);
    if (e.type === 'quantifier' || e.type === 'group') walk(e.body);
    // A keyword reached through a `sep` sub-list of the element is just as direct as one in a
    // seq/alt — recurse into its element so it is hoisted too (e.g. a type-param whose constraint
    // is a `&`-separated list carrying a keyword). `not` stays omitted on purpose: a literal under
    // a negative lookahead is a forbidden word, not present at the site, so it bears no scope; and
    // `ref` stays unresolved (like collectLiterals) so a constraint TYPE's own keywords — `keyof`,
    // `typeof` — are NOT mis-hoisted to type-parameter keyword scope.
    if (e.type === 'sep') walk(e.element);
  }
  walk(elementBody);
  return [...new Set(keywords)];
}

/**
 * Detect declaration patterns: rule alternatives that start with a keyword,
 * have an Ident name, and have a brace-delimited body or type parameters.
 *
 * E.g., 'class' Ident TypeParams? ... '{' ClassMember* '}'
 *       'function' Ident TypeParams? ... '(' Param ')' ... Block
 *       'type' Ident TypeParams? '=' Type ';'?
 *
 * Read per rule-body arm that begins with a keyword (with a name scope), then only non-keyword
 * literals (the mid literals: `function*`) and zero-width guards, then a token (the name). The rest
 * of each such arm is FOLDED over the arm graph (foldArmsFrom) into what the declaration needs, so
 * no arm is expanded: a body (a `{`, or a rule every arm of which is `{ … }`), parameters (a `(`),
 * type parameters (the first angle-sep rule before the first literal after the name) and the
 * literal after them (the end hint, for a body-less arm), a dotted name (`.` and a token right
 * after the name). Per keyword the arms' facts are joined: a flag is set when some arm has it; the
 * body is optional when one arm with parameters has a body and another has none; the
 * type-parameter keywords, the end hint and the order (of the keywords and of the mid literals)
 * are those of the first keyword-to-name prefix, in arm order, that has them. A keyword is a
 * declaration when some arm has a body or type parameters.
 */
export function detectDeclarations(grammar: CstGrammar): DeclInfo[] {
  const g = armGraph(grammar);
  const { tokenNames } = highlightFacts(grammar);
  const blockMemo = new Map<string, boolean>();
  // A rule every arm of which is `{ … }`.
  const isBlockRule = (name: string): boolean => {
    let b = blockMemo.get(name);
    if (b !== undefined) return b;
    const r = rootOfRule(g, grammar, name);
    b = r >= 0 && !g.nullable[r] && g.first[r].every(p => isLit('{')(g.node[p]) && !g.isLast[p])
      && rootPositions(g, r).every(p => !g.isLast[p] || isLit('}')(g.node[p]));
    blockMemo.set(name, b);
    return b;
  };
  const containsLiteral = (e: RuleExpr, value: string): boolean =>
    e.type === 'literal' ? e.value === value
    : e.type === 'seq' || e.type === 'alt' ? e.items.some(i => containsLiteral(i, value))
    : e.type === 'quantifier' || e.type === 'group' ? containsLiteral(e.body, value)
    : e.type === 'sep' ? containsLiteral(e.element, value) : false;
  const containsBlockRef = (e: RuleExpr): boolean =>
    e.type === 'ref' ? isBlockRule(e.name)
    : e.type === 'seq' || e.type === 'alt' ? e.items.some(containsBlockRef)
    : e.type === 'quantifier' || e.type === 'group' ? containsBlockRef(e.body)
    : e.type === 'sep' ? containsBlockRef(e.element) : false;
  const isBody = (e: RuleExpr) => isLit('{')(e) || containsBlockRef(e);
  const isParams = (e: RuleExpr) => containsLiteral(e, '(');
  const isGuard = (e: RuleExpr) => e.type === 'sameLine' || e.type === 'noCommentBefore' || e.type === 'noMultilineFlowBefore' || e.type === 'notLeftLeaf';
  const tpRuleOf = (e: RuleExpr): string | null => {
    if (e.type !== 'ref' || tokenNames.has(e.name)) return null;
    const rule = grammar.rules.find(r => r.name === e.name);
    return rule && isAngleBracketSepRule(grammar, rule.body) ? rule.name : null;
  };
  // The fold after the name. tp: 0 looking for the type-parameter rule (until a literal), 1 found
  // (looking for the end hint: the next literal), 2 done. qual: 0 next item, 1 after `.`, 2 a
  // dotted name, 3 not.
  type S = { body: boolean; params: boolean; tp: 0 | 1 | 2; tpRule: string | null; endHint: string | null; qual: 0 | 1 | 2 | 3 };
  const step = (s: S, e: RuleExpr): S => {
    const n = { ...s, body: s.body || isBody(e), params: s.params || isParams(e) };
    if (s.tp === 0) { const t = tpRuleOf(e); if (t) { n.tp = 1; n.tpRule = t; } else if (e.type === 'literal') n.tp = 2; }
    else if (s.tp === 1 && e.type === 'literal') { n.tp = 2; n.endHint = e.value; }
    n.qual = s.qual === 0 ? (isLit('.')(e) ? 1 : 3) : s.qual === 1 ? (e.type === 'ref' && tokenNames.has(e.name) ? 2 : 3) : s.qual;
    return n;
  };
  const key = (s: S) => `${+s.body}${+s.params}${s.tp}${s.tpRule}\0${s.endHint}\0${s.qual}`;
  type Prefix = { keyword: string; key: number[]; midLits: string[]; ends: S[] };
  const prefixes: Prefix[] = [];
  for (let r = 0; r < g.body.length; r++) {
    if (g.rootKind[r] !== 'rule') continue;
    for (const k of g.first[r]) {
      const kw = g.node[k];
      if (!isKeywordItem(kw) || !inferIdentScope(kw.value, grammar.scopeOverrides)) continue;
      const extend = (path: number[]): void => {
        for (const n of g.follow[path[path.length - 1]]) {
          const e = g.node[n];
          if (e.type === 'ref' && tokenNames.has(e.name)) {
            const mid = path.slice(1).map(p => g.node[p]);
            const init: S = { body: mid.some(isBody), params: mid.some(isParams), tp: 0, tpRule: null, endHint: null, qual: 0 };
            const ends = g.isLast[n] ? [init] : [];
            for (const f of g.follow[n]) ends.push(...foldArmsFrom(g, f, init, step, key));
            prefixes.push({ keyword: kw.value, key: armOrderKey(g, [...path, n], [], true), midLits: mid.flatMap(e => e.type === 'literal' ? [e.value] : []), ends });
          } else if ((e.type === 'literal' && !isKeywordLiteral(e.value)) || isGuard(e)) extend([...path, n]);
        }
      };
      extend([k]);
    }
  }
  prefixes.sort((a, b) => compareArmOrder(a.key, b.key));
  const results: DeclInfo[] = [];
  const keywords = [...new Set(prefixes.filter(p => p.ends.some(s => s.body || s.tpRule)).map(p => p.keyword))];
  for (const keyword of keywords) {
    const mine = prefixes.filter(p => p.keyword === keyword);
    const ends = mine.flatMap(p => p.ends);
    const tpRule = ends.find(s => s.tpRule)?.tpRule ?? null;
    const midLiterals: string[] = [];
    for (const p of mine) for (const l of p.midLits) if (!midLiterals.includes(l)) midLiterals.push(l);
    results.push({
      keyword,
      nameScope: inferIdentScope(keyword, grammar.scopeOverrides)!,
      keywordScope: getScope(grammar.scopeOverrides, keyword) ?? `storage.type.${keyword}`,
      hasParams: ends.some(s => s.params),
      hasTypeParams: tpRule !== null,
      hasBody: ends.some(s => s.body),
      optionalBody: ends.some(s => s.params && s.body) && ends.some(s => s.params && !s.body),
      typeParamKeywords: tpRule ? getTypeParamElementKeywords(grammar.rules.find(r => r.name === tpRule)!.body, grammar) : [],
      endHint: ends.find(s => !s.body && s.endHint !== null)?.endHint ?? undefined,
      midLiterals,
      qualifiedName: ends.some(s => s.qual === 2),
    });
  }
  return results;
}

// ── Value-position derivation (the depth-bug CLASS, one analysis) ──
//
// A flat per-line grammar carries no indent stack, so it re-introduces depth only where a region
// fires. The depth bugs (#23/#24, the `? a:\n  -` gap) are all ONE class: a structural INTRODUCER
// (`-`/`?`/`:`) opens an indented VALUE block, and the indicator at the deeper line must be scoped
// STRUCTURALLY — but a per-shape detector that did not cover that exact (introducer × enclosing
// position) combination lets a FOLD region claim the value line instead. detectExplicitKey (the
// `? key` shape) and detectBlockSequence (the `[item, (Newline item)*]` shape) are PARTIAL VIEWS of
// the SAME fact: those are two of the introducers that open a value block. This derives the WHOLE
// set from the IR so emission and verification share one source — a value-position no detector named
// can no longer be a silent gap.
//
// A VALUE-POSITION is an introducer literal `I` — drawn from `indent.compactIndicators ∪
// {keyValueSeparator}` (the structural single-char literals that lead a nested block) — that is
// IMMEDIATELY FOLLOWED, in some rule seq, by an (optional) element that REACHES, after an `Indent`
// boundary, a value/`Node` alternation (`Indent <…alt…> Dedent` — the recursive value). That is:
//   • `:` → MapValue/MapValueScalar (`[Indent, Node, Dedent]`), the block-mapping value;
//   • `-` → Value (`[Indent, Node, Dedent]`), the sequence-item value;
//   • `?` → MapValue (the explicit-key value half), AND the `:` inside ExplicitEntry.
// Returns null when the family has no such shape (every non-indentation grammar), so the value-
// position machinery is gated exactly like the detectors it subsumes.
//
// The set this returns is, by derivation, EXACTLY the introducer set the fold regions must yield to:
// at a value-position introducer that ends its line (`key:`-EOL, `?`-EOL, `-`-EOL) the indented block
// is a FRESH dispatch site (routed to the shared top-level dispatch, which the meta.stream wrapper
// re-anchors per line), NEVER a fold continuation. `structAhead`/`structRelease` (the fold-bounding
// lookaheads) are spelled from this same `{compactIndicators, keyValueSeparator}` set — so a fold
// releases at, and never opens past, a value-position. The explicit-key value (`? k:\n  -`) FALLS
// OUT as one instance: `? k:` is a `?`-led key whose trailing `:` opens a value block, so the
// explicit-key fold must NOT treat `k` as a foldable scalar (a bare `? a\n  b` fold has no such `:`).
export interface ValuePosition {
  introducer: string;   // the structural literal that opens the value block (`:` / `-` / `?`)
  source: 'keyValueSeparator' | 'compactIndicator';  // which config field the introducer came from
}
export function valuePositions(grammar: CstGrammar): ValuePosition[] | null {
  if (!grammar.indent) return null;
  const { indentToken } = grammar.indent;
  const ruleByName = new Map(grammar.rules.map(r => [r.name, r] as const));
  // The structural introducer literals: the compact indicators (`-`/`?`) and the key/value
  // separator (`:`) — the single-char literals that, in this family, can precede a nested block.
  const kvSep = grammar.indent.keyValueSeparator ?? ':';
  const introSource = new Map<string, 'keyValueSeparator' | 'compactIndicator'>();
  for (const c of grammar.indent.compactIndicators ?? []) if (c.length === 1) introSource.set(c, 'compactIndicator');
  if (kvSep.length === 1 && !introSource.has(kvSep)) introSource.set(kvSep, 'keyValueSeparator');
  if (!introSource.size) return null;

  // Does `e` (a rule body, transitively through refs) reach an `Indent <reaches value-alt> …`?
  // i.e. an `Indent` token followed in a seq by an element that contains an `alt` (the value/Node
  // alternation) — the recursive value block. A bounded visited-set guards the rule recursion.
  const reachesIndentedValue = (e: RuleExpr, seen: Set<string>): boolean => {
    const containsAlt = (x: RuleExpr, vseen: Set<string>): boolean =>
      x.type === 'alt' ? true
      : x.type === 'seq' ? x.items.some(it => containsAlt(it, vseen))
      : x.type === 'quantifier' || x.type === 'group' ? containsAlt(x.body, vseen)
      : x.type === 'sep' ? containsAlt(x.element, vseen)
      : x.type === 'ref' ? (vseen.has(x.name) ? false : (vseen.add(x.name), (() => { const r = ruleByName.get(x.name); return r ? containsAlt(r.body, vseen) : false; })()))
      : false;
    const walk = (x: RuleExpr): boolean => {
      if (x.type === 'seq') {
        for (let i = 0; i < x.items.length - 1; i++) {
          const cur = x.items[i];
          if (cur.type === 'ref' && cur.name === indentToken && containsAlt(x.items[i + 1], new Set())) return true;
        }
        return x.items.some(walk);
      }
      if (x.type === 'alt') return x.items.some(walk);
      if (x.type === 'quantifier' || x.type === 'group') return walk(x.body);
      if (x.type === 'sep') return walk(x.element);
      if (x.type === 'ref') { if (seen.has(x.name)) return false; seen.add(x.name); const r = ruleByName.get(x.name); return r ? walk(r.body) : false; }
      return false;
    };
    return walk(e);
  };

  // An introducer `I` is a value-position when some seq has `I` immediately followed by an element
  // that reaches an indented value block. `I` may be a head literal (`['-', opt(Value)]`,
  // `['?', opt(MapValue), …]`) or an inner one (the `:` inside an explicit entry's `[…, ':', opt(MapValue)]`).
  const found = new Set<string>();
  const visit = (e: RuleExpr): void => {
    if (e.type === 'seq') {
      for (let i = 0; i < e.items.length - 1; i++) {
        const lit = e.items[i];
        if (lit.type === 'literal' && introSource.has(lit.value) && reachesIndentedValue(e.items[i + 1], new Set())) found.add(lit.value);
      }
      e.items.forEach(visit);
    } else if (e.type === 'alt') e.items.forEach(visit);
    else if (e.type === 'quantifier' || e.type === 'group') visit(e.body);
    else if (e.type === 'sep') visit(e.element);
  };
  for (const r of grammar.rules) visit(r.body);
  if (!found.size) return null;
  // Order: key/value separator first, then compact indicators in declaration order (stable, for
  // a deterministic emit). The set — not the order — is what the emitter/verifier consume.
  const order = [kvSep, ...(grammar.indent.compactIndicators ?? [])];
  return [...found].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(introducer => ({ introducer, source: introSource.get(introducer)! }));
}

/**
 * Explicit mapping-key detection (e.g. YAML `? key` / `: value`).
 *
 * An indentation grammar may mark a mapping key NOT by a trailing key-separator on the key
 * itself but by a PRECEDING indicator (YAML's `?`): `? somekey` on one line, `: value` on
 * the next. The key scalar then carries no `:` and a flat per-token rule scopes it as an
 * ordinary string. The official grammar paints it as a key (entity.name.tag), so this derives
 * the shape and lets gen-tm emit a contextual rule scoping the scalar right after the
 * indicator as a key.
 *
 * detectExplicitKey is a PARTIAL VIEW of `valuePositions` (above): the `?` it finds is exactly the
 * `?` value-position introducer, here resolved to its key SCOPE + key BODY pattern (the extra facts
 * the `#explicit-key` match rule needs). It stays a focused helper so the emit site keeps the scope/
 * body it derives, but the value-position FACT (a `?`-led entry opens an indented value block) is
 * owned by `valuePositions`, which the fold regions consult so they yield at a `? key:` value site.
 *
 * Signal (all from the grammar, nothing hardcoded):
 *   • the grammar is INDENTATION-mode (`grammar.indent`) — the family this construct lives in;
 *   • some rule has an alternative `seq` whose HEAD is a single-char punctuation literal `I`
 *     and which contains, as a sibling, a `seq` headed by another single-char literal `S`
 *     (the value-separator) — i.e. the `I … S …` explicit-entry shape;
 *   • the grammar has a KEY token: a scalar token whose pattern ends in a lookahead that
 *     mentions `S` (`(?=…S…)`) — its scope is THE key scope, and the matching scalar WITHOUT
 *     the lookahead (same head, broadest scope) supplies the key BODY pattern.
 * Returns null when the shape is absent (so non-YAML grammars are unaffected).
 */
// Whether — and HOW — a grammar's plain scalars FOLD across lines, DETECTED from its rules (not
// hardcoded). The fold logic already lives in the PARSER rules (e.g. YAML's foldedPlain / foldedPlainBlock
// / DocFold, assembled from the lexer's Indent/Dedent/Newline tokens), so the derived highlighter reads
// it from there instead of re-encoding the same logic. A FOLD is a plain-scalar LEAF token that repeats
// across an indent boundary: `Indent <leaf> … Dedent` is a DEEPER continuation (§2a′), `Newline <leaf>`
// is a SAME-COLUMN continuation (§2a″). A leaf is a token declared with a `blockPattern` (the plain-scalar
// marker) and a scope. Crucially, an `Indent`/`Newline` followed by a RULE ref (a sequence item / mapping
// entry — e.g. BlockSequence's `many(Newline, SeqItem)`) is a SIBLING separator, not a fold — only a LEAF
// TOKEN after the boundary counts, which is what distinguishes a scalar continuing itself from a new node.
// Returns null when the grammar's plain scalars never fold → NO fold regions are emitted, so the
// highlighter generalises to any indentation language (a non-folding one gets nothing).
export function detectFold(grammar: CstGrammar): { hasDeeper: boolean; hasSameColumn: boolean } | null {
  if (!grammar.indent) return null;
  const { indentToken, newlineToken } = grammar.indent;
  const leafNames = new Set(grammar.tokens.filter(t => t.blockPattern && t.scope).map(t => t.name));
  if (!leafNames.size) return null;
  const refsLeaf = (e: RuleExpr): boolean =>
    e.type === 'ref' ? leafNames.has(e.name)
    : e.type === 'seq' || e.type === 'alt' ? e.items.some(refsLeaf)
    : e.type === 'quantifier' || e.type === 'group' ? refsLeaf(e.body)
    : e.type === 'sep' ? refsLeaf(e.element)
    : false;
  const isRefTo = (e: RuleExpr, name: string): boolean => e.type === 'ref' && e.name === name;
  let hasDeeper = false, hasSameColumn = false;
  const visit = (e: RuleExpr): void => {
    if (e.type === 'seq') {
      for (let i = 0; i < e.items.length - 1; i++) {
        if (isRefTo(e.items[i], indentToken) && refsLeaf(e.items[i + 1])) hasDeeper = true;
        if (isRefTo(e.items[i], newlineToken) && refsLeaf(e.items[i + 1])) hasSameColumn = true;
      }
      e.items.forEach(visit);
    } else if (e.type === 'alt') e.items.forEach(visit);
    else if (e.type === 'quantifier' || e.type === 'group') visit(e.body);
    else if (e.type === 'sep') visit(e.element);
  };
  for (const r of grammar.rules) visit(r.body);
  return (hasDeeper || hasSameColumn) ? { hasDeeper, hasSameColumn } : null;
}

export function detectExplicitKey(grammar: CstGrammar): { indicator: string; keyScope: string; keyBody: string; prefixGroups: { scope: string; pattern: string }[] } | null {
  if (!grammar.indent) return null;

  // Find a separator literal S that heads a nested seq sibling of a head-indicator literal I.
  const headSinglePunct = (e: RuleExpr): string | null =>
    e.type === 'literal' && e.value.length === 1 && !/[\w\s]/.test(e.value) ? e.value : null;
  let indicator: string | null = null;
  let separator: string | null = null;
  const visit = (e: RuleExpr): void => {
    if (e.type === 'seq') {
      const head = headSinglePunct(e.items[0]);
      if (head) {
        for (let i = 1; i < e.items.length; i++) {
          let inner = e.items[i];
          if (inner.type === 'quantifier') inner = inner.body;
          if (inner.type === 'seq') {
            const sep = headSinglePunct(inner.items[0]);
            if (sep && sep !== head) { indicator = head; separator = sep; }
          }
        }
      }
      e.items.forEach(visit);
    } else if (e.type === 'alt') e.items.forEach(visit);
    else if (e.type === 'quantifier' || e.type === 'group') visit(e.body);
    else if (e.type === 'sep') visit(e.element);
  };
  for (const r of grammar.rules) visit(r.body);
  if (!indicator || !separator) return null;
  const sep: string = separator;

  // KEY token = a plain-scalar token PLUS a trailing key-separator lookahead. The key token
  // supplies the scope; the body before its final lookahead supplies the emitted key body. The
  // emitted body comes from the key token's BLOCK-context variant (`blockPattern`) when it has one:
  // the explicit key (`? key`) lives in BLOCK context, where a flow indicator (`[`/`{`) AFTER the
  // node's first char is plain CONTENT, not a flow open (`? a[ b` is the one key "a[ b"). The FLOW
  // body (the default `pattern`) excludes `,[]{}`, so it would stop the key at a mid-key `[`/`{`,
  // leaving the rest for #flow-sequence/#flow-mapping to wrongly claim — the explicit-key analogue
  // of the fold-region distinction at the `keyColonGuard` site below. The BLOCK body (`[^:#\n]`) is
  // the SAME one the `#key` rule and the other block node contexts (root/map-value/seq-item) use, so
  // the explicit key absorbs the flow char exactly like them. A leading `[`/`{` still opens a flow
  // collection: the block body's HEAD (`PLAIN_HEAD_BLOCK`) excludes `[`/`{` as scalar STARTS, so the
  // match never begins on one (`? [a, b]:` stays a flow sequence). A token without a blockPattern
  // (every non-indentation grammar) falls back to the flow body — byte-identical.
  let keyScope: string | null = null;
  let keyBody: string | null = null;
  for (const k of grammar.tokens) {
    if (!k.scope || k.string) continue;
    const keyShape = tokenPatternPrefixBeforeTrailingLookahead(k);
    if (!keyShape || !tokenPatternNodeContainsLiteral(keyShape.lookahead, sep)) continue;
    const plain = grammar.tokens.find(t => t !== k && tokenPatternEqualsPattern(t, keyShape.body));
    if (!plain) continue;
    const blockShape = k.blockPattern ? tokenPatternPrefixBeforeTrailingLookahead({ pattern: k.blockPattern }) : null;
    keyScope = k.scope; keyBody = (blockShape ?? keyShape).bodySource; break;
  }
  if (!keyScope || !keyBody) return null;

  // NODE-PREFIX tokens — the optional decorators a value/node may carry BEFORE the scalar
  // (YAML's anchor `&a` and tag `!!t`): in an explicit entry `? &a a` / `? !!str a` the key
  // scalar is preceded by them, so the bare `(indicator)(ws)(key)` shape misses it. They are
  // exactly the tokens that appear as an `opt(token)` (a `?`-quantified ref to a TOKEN) as a
  // NON-FINAL element of some seq AND carry a real pattern (the structural indent/dedent/newline
  // placeholders are `(?!)` and excluded). Their patterns join into an optional, repeatable
  // `(?:<pat>[\t ]+)*` group inserted between the indicator's whitespace and the key body — so a
  // node decorated by any run of anchors/tags still resolves the trailing scalar as the key.
  // The prefix tokens are grouped BY SCOPE so §2b can emit one CAPTURING group per scope (anchor →
  // entity.name.type.anchor, tag → storage.type.tag): a `*`-repeated capture takes the LAST match,
  // which scopes the common single `? &a key` / `? !!t key` correctly (a rare multi-decorator run
  // scopes only its last anchor + last tag — acceptable). Derived from the grammar; empty when the
  // family has no such prefix token (most grammars).
  const tokenByName = new Map(grammar.tokens.map(t => [t.name, t] as const));
  const prefixByScope = new Map<string, Set<string>>();
  // A NODE-prefix token is an `opt(token)` that decorates a value: it sits in a seq whose tail
  // (after it) eventually reaches the VALUE ALTERNATION — i.e. the seq contains an `alt` later on.
  // This selects YAML's `opt(Anchor)`/`opt(Tag)` at the head of `Node`/`InlineNode` (each followed
  // by the collection/scalar `alt`) while EXCLUDING stream-level optionals like `opt(DocEnd)` /
  // `opt(Newline)`, whose seq is a flat marker list with no value alternation.
  const containsAlt = (e: RuleExpr): boolean =>
    e.type === 'alt' ? true
    : e.type === 'seq' ? e.items.some(containsAlt)
    : e.type === 'quantifier' || e.type === 'group' ? containsAlt(e.body)
    : e.type === 'sep' ? containsAlt(e.element)
    : false;
  const seqHasAltLater = (items: RuleExpr[], from: number): boolean => {
    for (let j = from; j < items.length; j++) if (containsAlt(items[j])) return true;
    return false;
  };
  const findPrefix = (e: RuleExpr): void => {
    if (e.type === 'seq') {
      for (let i = 0; i < e.items.length - 1; i++) {       // non-final items only
        const it = e.items[i];
        if (it.type === 'quantifier' && it.kind === '?' && it.body.type === 'ref' && seqHasAltLater(e.items, i + 1)) {
          const t = tokenByName.get(it.body.name);
          if (t && !tokenPatternIsNever(t) && !t.string && t.scope) {
            (prefixByScope.get(t.scope) ?? prefixByScope.set(t.scope, new Set()).get(t.scope)!).add(tokenPatternSource(t));
          }
        }
      }
      e.items.forEach(findPrefix);
    } else if (e.type === 'alt') e.items.forEach(findPrefix);
    else if (e.type === 'quantifier' || e.type === 'group') findPrefix(e.body);
    else if (e.type === 'sep') findPrefix(e.element);
  };
  for (const r of grammar.rules) findPrefix(r.body);
  const prefixGroups = [...prefixByScope].map(([scope, pats]) => ({ scope, pattern: [...pats].join('|') }));
  return { indicator, keyScope, keyBody, prefixGroups };
}

// ── Block-sequence detection (YAML `- item` block sequence) ──
//
// A flat per-line grammar cannot tell a COMPACT nested sequence's sibling from a plain-scalar fold:
// `- - a\n  - b` (the `  - b` is the INNER sequence's 2nd item) and `x: y\n  - b` (the `  - b` folds
// into the plain scalar `y`) share the same continuation line but get OPPOSITE answers — the decider
// is the ENCLOSING node column (an inner sequence at column 2 vs a mapping at column 0), which the
// line-relative `\1` of the §2a′ fold region cannot see (both lines start at column 0). monogram#24.
// The fix is a column-anchored region (§2c below) for the COMPACT block sequence, whose `\G`-anchored
// `while` (re-anchored each line by the meta.stream wrapper) reclaims a sibling `- ` at the inner
// indicator's column BEFORE the plain-scalar fold can swallow it. This detects the block-sequence rule
// + its indicator literal from the grammar so the region is DERIVED, not hardcoded.
//
// Signal (all from the grammar): a rule whose body is `[item, (Newline item)*]` — an item then a
// same-column-NEWLINE-separated run of further items — where `item` is a `ref` to a rule whose body is
// a `seq` headed by a SINGLE-char punctuation literal (the sequence indicator `-`). Returns the
// indicator literal, or null when the family has no such block sequence (every non-YAML grammar).
export function detectBlockSequence(grammar: CstGrammar): { indicator: string } | null {
  if (!grammar.indent) return null;
  const { newlineToken } = grammar.indent;
  const ruleByName = new Map(grammar.rules.map(r => [r.name, r] as const));
  const headSinglePunct = (e: RuleExpr): string | null =>
    e.type === 'literal' && e.value.length === 1 && !/[\w\s]/.test(e.value) ? e.value : null;
  // The item rule's indicator: unwrap a ref to a rule whose body's first seq element is a 1-char punct.
  const itemIndicator = (e: RuleExpr): string | null => {
    let body = e.type === 'ref' ? ruleByName.get(e.name)?.body : e;
    if (!body) return null;
    // a rule body written `[[...]]` is a single-alt seq; unwrap a lone-arm alt
    if (body.type === 'alt' && body.items.length === 1) body = body.items[0];
    return body.type === 'seq' ? headSinglePunct(body.items[0]) : null;
  };
  let indicator: string | null = null;
  const visit = (e: RuleExpr): void => {
    if (e.type === 'seq') {
      // `[…, item, (Newline item)*, …]`: an item ADJACENT to a `*`/`+` over a `[Newline, item]` seq.
      // Scanned pairwise (any k, not only items[0]/items[1]) so a leading element before the
      // sequence pattern does not hide it. NOT routed through expandArms on purpose — that would
      // expand the `(Newline item)*` quantifier this match depends on.
      for (let k = 0; k + 1 < e.items.length; k++) {
        const head = e.items[k];
        const q = e.items[k + 1];
        if (q.type === 'quantifier' && (q.kind === '*' || q.kind === '+') && q.body.type === 'seq'
          && q.body.items.length >= 2 && q.body.items[0].type === 'ref' && q.body.items[0].name === newlineToken) {
          const ind = itemIndicator(head);
          // the repeated element's item must share the head's indicator (a homogeneous sequence)
          if (ind && itemIndicator(q.body.items[1]) === ind) indicator = ind;
        }
      }
      e.items.forEach(visit);
    } else if (e.type === 'alt') e.items.forEach(visit);
    else if (e.type === 'quantifier' || e.type === 'group') visit(e.body);
    else if (e.type === 'sep') visit(e.element);
  };
  for (const r of grammar.rules) visit(r.body);
  return indicator ? { indicator } : null;
}

// ── Flow-collection detection (YAML `{ … }` mapping / `[ … ]` sequence) ──
//
// A flat per-token grammar cannot scope a flow MAPPING's keys: in `{ a: 1 }` the `a` is a key
// (entity.name.tag) but in `{ [1]: v }` the `1` is a SEQUENCE element (a value) — the distinction
// is the ENCLOSING bracket, which a context-free token can't see. The maintained RedCMD grammar
// solves this with nested begin/end FLOW REGIONS (a `{`…`}` / `[`…`]` region IS a scope-stack
// frame, so depth nests), scoping a scalar that leads an entry as a key inside a mapping and as a
// value inside a sequence. This derives that structure from the grammar's OWN flow rules — the
// bracket pair (from `indent.flowOpen`/`flowClose`), the entry/value separators, and whether a
// collection is a mapping (its entry carries a `:` key/value separator) or a sequence (it does not).
//
// Signal (all from the grammar, nothing hardcoded):
//   • the grammar is INDENTATION-mode AND declares `flowOpen`/`flowClose` bracket pairs;
//   • for a pair (O,C): a rule whose body is a `seq` headed by literal `O` and ended by literal `C`
//     — that is the flow-collection rule. Its entry-separator literal (the `,` repeated between
//     entries) and, for a mapping, its key/value-separator literal (the `:` inside the entry rule)
//     are read off the rule's own literals.
//   • the KEY scope + plain-scalar shape come from the same Key/Plain token pair detectExplicitKey
//     uses (a scalar token whose pattern is `<plain>(?=…sep…)` over a broader plain scalar).
// Returns null when the family has no flow collections (every non-YAML grammar).
// `punct` (when present) are the SPECIFIC open/close/separator scopes the grammar declared for THIS
// collection via `indent.flowScopes.byOpen[open]` (null → fall back to the generic `punctuation.*`).
// Scope strings are bare (no `.${lang}` suffix); the region builder appends it.
export interface FlowColl { open: string; close: string; sep: string; colon: string | null; punct: { begin: string; end: string; separator: string } | null; }
export function detectFlowCollections(grammar: CstGrammar): {
  colls: FlowColl[];
  plainStart: string;          // plain-scalar LEADING char class (no enclosing group)
  keyScope: string;            // the key scope (e.g. entity.name.tag)
  plainScope: string;          // the broad plain-scalar scope (e.g. string.unquoted)
  dq: string | null;           // double-quoted scalar body pattern (`"(?:\\.|…)*"`)
  sq: string | null;           // single-quoted scalar body pattern
  dqScope: string | null;      // double-quoted scalar scope (string.quoted.double)
  sqScope: string | null;      // single-quoted scalar scope
  dqEscape: string | null;     // in-string escape sub-pattern for the double quote
  sqEscape: string | null;     // in-string escape sub-pattern for the single quote
  keyValueScope: string | null;   // declared `:` key/value separator scope (indent.flowScopes.keyValue), bare
  explicitKeyScope: string | null; // declared `?` explicit-key indicator scope (indent.flowScopes.explicitKey), bare
} | null {
  const indent = grammar.indent;
  if (!indent || !indent.flowOpen?.length || !indent.flowClose?.length) return null;
  // top-level literals of a rule body: direct children only (unwrap quantifier/group/sep), do NOT
  // descend into `alt` or `ref` (those are nested sub-constructs, not THIS rule's own structure).
  const topLits = (e: RuleExpr, out: string[]): void => {
    if (e.type === 'literal') out.push(e.value);
    else if (e.type === 'seq') e.items.forEach(x => topLits(x, out));
    else if (e.type === 'quantifier' || e.type === 'group') topLits(e.body, out);
    else if (e.type === 'sep') { out.push(e.delimiter); topLits(e.element, out); }
  };
  // refs reachable anywhere inside an expr.
  const allRefs = (e: RuleExpr, out: Set<string>): void => {
    if (e.type === 'ref') out.add(e.name);
    else if (e.type === 'seq' || e.type === 'alt') e.items.forEach(x => allRefs(x, out));
    else if (e.type === 'quantifier' || e.type === 'group') allRefs(e.body, out);
    else if (e.type === 'sep') allRefs(e.element, out);
  };
  const ruleByName = new Map(grammar.rules.map(r => [r.name, r] as const));

  const colls: FlowColl[] = [];
  const n = Math.min(indent.flowOpen.length, indent.flowClose.length);
  for (let i = 0; i < n; i++) {
    const open = indent.flowOpen[i], close = indent.flowClose[i];
    // the collection rule: seq starting with lit(open), ending with lit(close).
    const collRule = grammar.rules.find(r => {
      const b = r.body;
      if (b.type !== 'seq' || b.items.length < 2) return false;
      const first = b.items[0], last = b.items[b.items.length - 1];
      return first.type === 'literal' && first.value === open && last.type === 'literal' && last.value === close;
    });
    if (!collRule) continue;
    // entry separator = a non-bracket single-char punctuation literal repeated in the collection
    // (the `,` of `many(',', Entry)` — surfaces as a top-level literal alongside the brackets).
    const collLits: string[] = []; topLits(collRule.body, collLits);
    const sep = collLits.find(l => l.length === 1 && l !== open && l !== close && !/[\w\s]/.test(l)) ?? ',';
    // mapping vs sequence: the ENTRY rule (a ref inside the collection) carries a `:` key/value
    // separator (top-level literal) → mapping; otherwise → sequence.
    const refs = new Set<string>(); allRefs(collRule.body, refs);
    let colon: string | null = null;
    for (const rn of refs) {
      const er = ruleByName.get(rn);
      if (!er) continue;
      const eLits: string[] = []; topLits(er.body, eLits);
      const c = eLits.find(l => l.length === 1 && l !== sep && l !== open && l !== close && !/[\w\s]/.test(l));
      if (c) { colon = c; break; }
    }
    // The grammar may DECLARE specific open/close/separator scopes for this collection (keyed by the
    // open bracket); absent → null → the region builder uses the generic `punctuation.${lang}`.
    const punct = indent.flowScopes?.byOpen?.[open] ?? null;
    colls.push({ open, close, sep, colon, punct });
  }
  if (!colls.length) return null;

  // The Key/Plain token pair (same shape detectExplicitKey pins): a non-string token whose IR
  // ends with a trailing lookahead. The body before the lookahead gives the plain scalar body;
  // its leading token gives the flow scalar start pattern.
  let keyScope: string | null = null, plainPat: string | null = null, plainScope: string | null = null, plainToken: TokenDecl | null = null;
  for (const k of grammar.tokens) {
    if (!k.scope || k.string || tokenPatternIsNever(k)) continue;
    const keyShape = tokenPatternPrefixBeforeTrailingLookahead(k);
    if (!keyShape) continue;
    const p = grammar.tokens.find(t => t !== k && tokenPatternEqualsPattern(t, keyShape.body) && !tokenPatternIsNever(t));
    if (p) { keyScope = k.scope; plainPat = keyShape.bodySource; plainScope = p.scope ?? null; plainToken = p; break; }
    if (keyScope) break;
  }
  if (!keyScope || !plainPat || !plainScope || !plainToken) return null;

  const lead = tokenPatternLeadingSource(plainToken);
  if (!lead) return null;
  const plainStart = lead;

  // Quoted-scalar tokens (string-flagged begin/end OR a match): give the flow quoted-KEY regions
  // (a quoted scalar in key position carries entity.name.tag). Detect by the `string` flag; the
  // body pattern is the token's `match` (key/quoted-scalar tokens are match-form here).
  const quoteByScope = (suffix: string) =>
    grammar.tokens.find(t => t.string && !tokenPatternIsNever(t) && t.scope?.startsWith(`string.quoted.${suffix}`) && !t.scope.includes('entity'));
  const dqTok = quoteByScope('double'), sqTok = quoteByScope('single');
  // The in-string escape: the FIRST sub-alternation of the quoted body after the opening quote
  // (`\\.` for double, `''` for single). Derive it from the token's own pattern.
  const quoteEscape = (tok: typeof dqTok): string | null => tok ? tokenPatternQuoteDelimAndEscape(tok)?.escape ?? null : null;

  return {
    colls, plainStart, keyScope, plainScope,
    dq: dqTok ? tokenPatternSource(dqTok) : null, sq: sqTok ? tokenPatternSource(sqTok) : null,
    dqScope: dqTok?.scope ?? null, sqScope: sqTok?.scope ?? null,
    dqEscape: quoteEscape(dqTok), sqEscape: quoteEscape(sqTok),
    keyValueScope: indent.flowScopes?.keyValue ?? null,
    explicitKeyScope: indent.flowScopes?.explicitKey ?? null,
  };
}


// ── Expression keywords (read by gen-tm's rule-rooted `#expression` derivation) ──

export const isExprKeyword = (s: string) => /^[a-zA-Z]/.test(s);

/** Whether a rule expression can match the empty string — so FIRST must look past it. */
export function ruleIsNullable(e: RuleExpr, byName: Map<string, RuleExpr>, seen = new Set<string>()): boolean {
  switch (e.type) {
    case 'seq': return e.items.every(i => ruleIsNullable(i, byName, seen));
    case 'alt': return e.items.some(i => ruleIsNullable(i, byName, seen));
    case 'quantifier': return e.kind === '*' || e.kind === '?';
    case 'group': return ruleIsNullable(e.body, byName, seen);
    case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore': case 'notLeftLeaf': return true;  // zero-width assertions
    case 'ref': { if (seen.has(e.name)) return false; seen.add(e.name); const b = byName.get(e.name); return b ? ruleIsNullable(b, byName, seen) : false; }
    default: return false;                                     // literal / token / op / prefix / postfix / sep
  }
}

/** FIRST set (literals only) — keywords that can BEGIN this rule. Follows refs only at
 *  START positions, so it never descends into a statement block (which always sits after
 *  `=>`, never at an alternative's start), and stops on cycles (left-recursion adds nothing). */
export function firstLiterals(e: RuleExpr, byName: Map<string, RuleExpr>, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  switch (e.type) {
    case 'literal': out.add(e.value); break;
    case 'alt': for (const i of e.items) for (const x of firstLiterals(i, byName, seen)) out.add(x); break;
    case 'seq': for (const i of e.items) { for (const x of firstLiterals(i, byName, seen)) out.add(x); if (!ruleIsNullable(i, byName)) break; } break;
    case 'quantifier': case 'group': for (const x of firstLiterals(e.body, byName, seen)) out.add(x); break;
    case 'sep': for (const x of firstLiterals(e.element, byName, seen)) out.add(x); break;
    case 'ref': if (!seen.has(e.name) && byName.has(e.name)) { seen.add(e.name); for (const x of firstLiterals(byName.get(e.name)!, byName, seen)) out.add(x); } break;
  }
  return out;
}

/** The keywords that may appear in an EXPRESSION: the expression rule's FIRST set + its
 *  DIRECT literals (to catch infix operators like `as`/`in`/`instanceof` that FIRST skips),
 *  plus the keywords the grammar SCOPES as expression-level operators / constants / globals
 *  (`typeof`/`void`/`delete` are precedence-driven, not rule literals — only their scopes show it). */
export function expressionKeywords(grammar: CstGrammar): Set<string> {
  const byName = new Map(grammar.rules.map(r => [r.name, r.body] as const));
  const kw = new Set<string>();
  const body = grammar.expressionRule ? byName.get(grammar.expressionRule) : undefined;
  if (body) {
    for (const l of collectLiterals(body)) if (isExprKeyword(l)) kw.add(l);
    for (const l of firstLiterals(body, byName)) if (isExprKeyword(l)) kw.add(l);
  }
  const exprScopePrefixes = ['keyword.operator', 'constant.language', 'variable.language', 'support.', 'storage.type.function', 'storage.type.class'];
  for (const [lit, scopes] of grammar.scopeOverrides) {
    if (isExprKeyword(lit) && scopes.some(s => exprScopePrefixes.some(p => s.startsWith(p)))) kw.add(lit);
  }
  return kw;
}

// ── Facts lifted from generateTmLanguage's closures ──

/** The characters an iterable may begin with directly after a contextual loop-connector keyword
 *  (`for(x of[1])`): the open brackets the rules use, the first character of each string / template
 *  delimiter, `/` with a regex token, `-` when a @type rule uses it. In discovery order. */
export function loopConnectorOpeners(grammar: CstGrammar): Set<string> {
  const loopConnOpeners = new Set<string>();
  const allLits = new Set<string>();
  for (const rule of grammar.rules) for (const l of collectLiterals(rule.body)) allLits.add(l);
  for (const open of ['(', '{', '[']) if (allLits.has(open)) loopConnOpeners.add(open);
  for (const tok of grammar.tokens) {
    if (tok.string || tok.template) {
      const first = tokenPatternStringDelimiters(tok)[0]?.[0];
      if (first && !/[a-zA-Z0-9]/.test(first)) loopConnOpeners.add(first);
    }
    if (tok.flags.includes('regex')) loopConnOpeners.add('/');
  }
  if ([...grammar.rules].some(r => r.flags.includes('type') && collectLiterals(r.body).includes('-'))) {
    loopConnOpeners.add('-');
  }
  return loopConnOpeners;
}

/** Every literal of the rules, then every precedence operator's text, in that order. */
export function allLiterals(grammar: CstGrammar): Set<string> {
  const allLiterals = new Set<string>();
  for (const rule of grammar.rules) {
    for (const lit of collectLiterals(rule.body)) {
      allLiterals.add(lit);
    }
  }
  for (const level of grammar.precs) {
    for (const op of level.operators) {
      allLiterals.add(op.value);
    }
  }
  return allLiterals;
}

/** Whether a @type rule uses `(`. */
export function parenType(grammar: CstGrammar): boolean {
  return grammar.rules.some(r =>
    r.flags.includes('type') && collectLiterals(r.body).includes('(')
  );
}

/** Whether a @type rule uses `[` and `]`. */
export function bracketType(grammar: CstGrammar): boolean {
  return grammar.rules.some(r =>
    r.flags.includes('type') && collectLiterals(r.body).includes('[') && collectLiterals(r.body).includes(']')
  );
}

/** Whether a @type rule uses `{`. */
export function objectType(grammar: CstGrammar): boolean {
  return grammar.rules.some(r =>
    r.flags.includes('type') && collectLiterals(r.body).includes('{')
  );
}

/** Whether a token begins with `#` (a private name). */
export function privateFields(grammar: CstGrammar): boolean {
  return grammar.tokens.some(t => tokenPatternLiteralPrefix(t)?.startsWith('#'));
}

/** Every literal of the @type rules, in rule order. */
export function typeLiterals(grammar: CstGrammar): Set<string> {
  const typeLiterals = new Set<string>();
  for (const rule of grammar.rules) {
    if (rule.flags.includes('type')) {
      for (const lit of collectLiterals(rule.body)) {
        typeLiterals.add(lit);
      }
    }
  }
  return typeLiterals;
}

/** The keyword literals of @type rules that are type-context keywords: every one except a
 *  keyword each of whose occurrences is directly followed by `(` (paren-gated). */
export function typeContextKeywords(grammar: CstGrammar): Set<string> {
  const typeLiterals = highlightFacts(grammar).typeLiterals;
  const parenGatedTypeKw = (kw: string): boolean => {
    let saw = false, gated = true;
    const walk = (e: RuleExpr): void => {
      if (!e || !gated) return;
      switch (e.type) {
        case 'seq':
          for (let i = 0; i < e.items.length; i++) {
            const it = e.items[i];
            if (it.type === 'literal' && it.value === kw) {
              saw = true;
              const next = e.items[i + 1];
              if (!(next && next.type === 'literal' && next.value === '(')) gated = false;
            } else walk(it);
          }
          return;
        case 'alt':
          for (const it of e.items) {
            if (it.type === 'literal' && it.value === kw) { saw = true; gated = false; } else walk(it);
          }
          return;
        // (`not` is absent: a lookahead's words are not literals OF the rule — the same
        // reading as collectLiterals, which produced `typeLiterals`. A reserved-word guard
        // `not(alt('function', …))` in a type rule is no occurrence of `function` in a type.)
        case 'quantifier': case 'group':
          if (e.body.type === 'literal' && e.body.value === kw) { saw = true; gated = false; } else walk(e.body);
          return;
        case 'sep':
          if (e.delimiter === kw) { saw = true; gated = false; }
          if (e.element.type === 'literal' && e.element.value === kw) { saw = true; gated = false; } else walk(e.element);
          return;
        case 'literal':
          if (e.value === kw) { saw = true; gated = false; }
          return;
        default: return;
      }
    };
    for (const r of grammar.rules) if (r.flags.includes('type')) walk(r.body);
    return saw && gated;
  };
  const typeContextKeywords = new Set<string>();
  for (const lit of typeLiterals) {
    if (isKeywordLiteral(lit) && !parenGatedTypeKw(lit)) typeContextKeywords.add(lit);
  }
  
  // Statement-starting keywords: alphabetic literals whose scope indicates
  // they begin a new statement or declaration, and are NOT type-context keywords.
  return typeContextKeywords;
}

/** The scope-mapped keywords (storage.type / keyword.control / storage.modifier) that are not
 *  type-context keywords: the words that may start a statement. */
export function statementStartKeywords(grammar: CstGrammar): Set<string> {
  const { scopeOverrides } = grammar;
  const typeContextKeywords = highlightFacts(grammar).typeContextKeywords;
  const stmtStartKeywords = new Set<string>();
  for (const [kw, scopes] of scopeOverrides) {
    if (!isKeywordLiteral(kw)) continue;
    if (typeContextKeywords.has(kw)) continue;
    if (scopes.some(s =>
      s.startsWith('storage.type') ||
      s.startsWith('keyword.control') ||
      s.startsWith('storage.modifier'))) {
      stmtStartKeywords.add(kw);
    }
  }
  return stmtStartKeywords;
}


/** The non-identifier token the grammar's own lexer gives a whole keyword text, if any. */
export function lexedByToken(grammar: CstGrammar): (kw: string) => TokenDecl | undefined {
  const lexKw = compileTokenizer(lexSpecOf(grammar));
  const lexedByToken = (kw: string): TokenDecl | undefined => {
    const toks = lexKw(kw);
    if (toks.length !== 1 || toks[0].text !== kw) return undefined;
    const tok = grammar.tokens.find(t => t.name === toks[0].type);
    return tok && !tok.identifier ? tok : undefined;
  };
  return lexedByToken;
}

/** Whether a literal occurs and every occurrence is directly followed by the string token. */
export function alwaysBeforeString(grammar: CstGrammar): (lit: string) => boolean {
  const stringTokName = grammar.tokens.find(t => t.string)?.name;
  const alwaysBeforeString = (lit: string): boolean => {
    if (!stringTokName) return false;
    let seen = false, ok = true;
    const walk = (e: RuleExpr | undefined): void => {
      if (!e) return;
      if (e.type === 'seq') {
        for (let i = 0; i < e.items.length; i++) {
          const it = e.items[i];
          if (it.type === 'literal' && it.value === lit) {
            seen = true;
            const nx = e.items[i + 1];
            if (!(nx && nx.type === 'ref' && nx.name === stringTokName)) ok = false;
          }
          walk(it);
        }
      } else if (e.type === 'alt') e.items.forEach(walk);
      else if (e.type === 'quantifier' || e.type === 'group') walk(e.body);
      else if (e.type === 'sep') walk(e.element);
    };
    for (const r of grammar.rules) walk(r.body);
    return seen && ok;
  };
  return alwaysBeforeString;
}

// ── Adjacency detectors over the arm graph (src/arm-graph.ts) ──
// Each asks for a window of consecutive arm items, which the arm graph answers without expanding
// the arms.

const isRefItem = (e: RuleExpr) => e.type === 'ref';
const isLit = (v: string) => (e: RuleExpr) => e.type === 'literal' && e.value === v;
const isAnyLit = (e: RuleExpr) => e.type === 'literal';

/** An `Expr '?' Expr ':' Expr` window: ref, `?`, ref, `:`, ref in a row. */
export function hasTernary(grammar: CstGrammar): boolean {
  return hasWindow(armGraph(grammar), [isRefItem, isLit('?'), isRefItem, isLit(':'), isRefItem]);
}

/** A ref directly followed by an item whose FIRST holds `(` (a call's argument list, written
 *  inline or as a rule of its own). */
export function hasCallExpression(grammar: CstGrammar): boolean {
  const byName = new Map(grammar.rules.map(r => [r.name, r.body]));
  return hasWindow(armGraph(grammar), [isRefItem, (e) => firstLiterals(e, byName).has('(')]);
}

/** `.` / `?.` directly followed by a token reference (a property name). */
export function propertyAccess(grammar: CstGrammar): { hasDot: boolean; hasOptionalChain: boolean } {
  const { tokenNames } = highlightFacts(grammar);
  const tokenRef = (e: RuleExpr) => e.type === 'ref' && tokenNames.has(e.name);
  const g = armGraph(grammar);
  return { hasDot: hasWindow(g, [isLit('.'), tokenRef]), hasOptionalChain: hasWindow(g, [isLit('?.'), tokenRef]) };
}

/** A token reference directly followed by `=>` (a bare arrow parameter: `x => x + 1`). */
export function hasBareArrowParam(grammar: CstGrammar): boolean {
  const { tokenNames } = highlightFacts(grammar);
  return hasWindow(armGraph(grammar), [(e) => e.type === 'ref' && tokenNames.has(e.name), isLit('=>')]);
}

// What may stand between an arrow's parameter list and its `=>`: anything but a literal other than
// `:` / `?` (a return-type annotation).
const betweenParamsAndArrow = (e: RuleExpr) => e.type !== 'literal' || e.value === ':' || e.value === '?';

/** The `open middle close … '=>'` windows (an arrow's parameter list), each as its three
 *  positions, in the order a scan of the expanded arms meets them. */
function arrowParamWindows(grammar: CstGrammar, open: (e: RuleExpr) => boolean, middle: (e: RuleExpr) => boolean, close: (e: RuleExpr) => boolean): number[][] {
  const g = armGraph(grammar);
  return findWindows(g, [open, middle, close])
    .filter(([, , c]) => reachesThrough(g, c, betweenParamsAndArrow, isLit('=>')))
    .map(w => ({ w, key: armOrderKey(g, w) }))
    .sort((a, b) => compareArmOrder(a.key, b.key))
    .map(({ w }) => w);
}

/** A `'(' X ')' … '=>'` window: a parenthesised arrow parameter list (`(x, y) => x + y`). */
export function hasParenArrowParams(grammar: CstGrammar): boolean {
  return arrowParamWindows(grammar, isLit('('), () => true, isLit(')')).length > 0;
}

/** The two literals around the `sep` of the first `open sep(…) close … '=>'` window: the arrow
 *  parameter list's delimiters, read from the grammar rather than assumed. */
export function arrowParamDelims(grammar: CstGrammar): { open: string; close: string } | null {
  const w = arrowParamWindows(grammar, isAnyLit, (e) => e.type === 'sep', isAnyLit)[0];
  if (!w) return null;
  const { node } = armGraph(grammar);
  return { open: (node[w[0]] as { value: string }).value, close: (node[w[2]] as { value: string }).value };
}

const isKeywordItem = (e: RuleExpr): e is { type: 'literal'; value: string } => e.type === 'literal' && isKeywordLiteral(e.value);
const ruleRoots = (g: ArmGraph) => (r: number) => g.rootKind[r] === 'rule';
const rootOfRule = (g: ArmGraph, grammar: CstGrammar, name: string): number => {
  const i = grammar.rules.findIndex(r => r.name === name);
  return i < 0 ? -1 : g.rootKind.findIndex((k, r) => k === 'rule' && g.ruleIndex[r] === i);
};

/** The keywords directly followed by `(` whose scope is storage.type.function (`function (…)`), in
 *  the order the arms meet them. */
export function directParamKeywords(grammar: CstGrammar): { keyword: string; keywordScope: string }[] {
  const g = armGraph(grammar);
  const met = findWindows(g, [isKeywordItem, isLit('(')])
    .filter(([k]) => getScope(grammar.scopeOverrides, (g.node[k] as { value: string }).value)?.startsWith('storage.type.function'))
    .map(w => ({ value: (g.node[w[0]] as { value: string }).value, window: w }));
  return inArmOrder(g, met).map(keyword => ({ keyword, keywordScope: getScope(grammar.scopeOverrides, keyword)! }));
}

/** Constructor-call keywords (`new NewTarget (…)`): a keyword scoped keyword.operator.expression,
 *  directly followed by a rule reference (the callee) with a `(` later in the arm; each with the
 *  rules that stand right after it (followed by anything), in the order a rule-body arm scan meets
 *  them. Rule bodies only. */
export function constructorKeywords(grammar: CstGrammar): { kw: string; callees: string[] }[] {
  const g = armGraph(grammar);
  const { tokenNames } = highlightFacts(grammar);
  const kwThenRule = [isKeywordItem, (e: RuleExpr) => e.type === 'ref' && !tokenNames.has(e.name)];
  const value = (p: number) => (g.node[p] as { value: string }).value;
  const name = (p: number) => (g.node[p] as { name: string }).name;
  const calleeWindows = findWindows(g, [...kwThenRule, () => true], ruleRoots(g));
  const calleePairs = inArmOrder(g, calleeWindows.map(w => ({ value: `${value(w[0])}\0${name(w[1])}`, window: w })));
  const met: { value: string; window: number[]; gapFree: boolean[] }[] = [];
  for (const [k, b] of findWindows(g, kwThenRule, ruleRoots(g))) {
    if (!getScope(grammar.scopeOverrides, value(k))?.startsWith('keyword.operator.expression')) continue;
    for (const p of reachable(g, b, () => true, isLit('('))) met.push({ value: value(k), window: [k, b, p], gapFree: [false, true] });
  }
  return inArmOrder(g, met).map(kw => ({ kw, callees: calleePairs.filter(c => c.startsWith(`${kw}\0`)).map(c => c.slice(kw.length + 1)) }));
}

/** The keywords directly followed (past `sameLine` assertions) by a non-token rule reference that
 *  `beginsRegex`, in the order the arms meet them. */
export function regexPrecedingKeywords(grammar: CstGrammar, beginsRegex: (ref: RuleExpr) => boolean): string[] {
  const g = armGraph(grammar);
  const { tokenNames } = highlightFacts(grammar);
  const met: { value: string; window: number[] }[] = [];
  for (let k = 0; k < g.node.length; k++) {
    const kw = g.node[k];
    if (!isKeywordItem(kw)) continue;
    const extend = (path: number[]): void => {
      for (const n of g.follow[path[path.length - 1]]) {
        const e = g.node[n];
        if (e.type === 'sameLine') extend([...path, n]);
        else if (e.type === 'ref' && !tokenNames.has(e.name) && beginsRegex(e)) met.push({ value: kw.value, window: [...path, n] });
      }
    };
    extend([k]);
  }
  return inArmOrder(g, met);
}

/** Whether rule `name` (or a rule its arms begin with, recursively) can begin with an item `head`
 *  matches. */
export function ruleBeginsWith(grammar: CstGrammar, name: string, head: (e: RuleExpr) => boolean, seen = new Set<string>()): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const g = armGraph(grammar);
  const r = rootOfRule(g, grammar, name);
  if (r < 0) return false;
  return g.first[r].some(p => head(g.node[p]) || (g.node[p].type === 'ref' && ruleBeginsWith(grammar, (g.node[p] as { name: string }).name, head, seen)));
}

/** The import / export keywords (scoped keyword.control.import, not phase modifiers), those that
 *  introduce a namespace `*` (directly, or through a rule that begins with one), and per such
 *  keyword the phase modifiers that may stand between it and the `*` (`import defer * as ns`). */
export function importStar(grammar: CstGrammar): { importExportKws: Set<string>; starAllKws: Set<string>; phaseModsByKw: Map<string, string[]> } {
  const g = armGraph(grammar);
  const { scopeOverrides } = grammar;
  const usedAsKeywordOnlyBeforeStar = (lit: string): boolean => {
    let beforeStar = false, elsewhere = false;
    const walk = (e: RuleExpr | undefined): void => {
      if (!e) return;
      if (e.type === 'seq') {
        for (let i = 0; i < e.items.length; i++) {
          const it = e.items[i];
          if (it.type === 'literal' && it.value === lit) {
            const nx = e.items[i + 1];
            if (nx && nx.type === 'literal' && nx.value === '*') beforeStar = true; else elsewhere = true;
          }
          walk(it);
        }
      } else if (e.type === 'alt') e.items.forEach(walk);
      else if (e.type === 'quantifier' || e.type === 'group') walk(e.body);
      else if (e.type === 'sep') walk(e.element);
    };
    for (const r of grammar.rules) walk(r.body);
    return beforeStar && !elsewhere;
  };
  const importExportKws = new Set<string>();
  for (const [lit, scopes] of scopeOverrides) {
    if (scopes.some(s => s.startsWith('keyword.control.import')) && !usedAsKeywordOnlyBeforeStar(lit)) importExportKws.add(lit);
  }
  // The `[K, '*']`-headed arms of a rule (K a keyword), through rule references at the head.
  const phaseStarKws = (refName: string, seen: Set<string> = new Set()): string[] => {
    if (seen.has(refName)) return [];
    seen.add(refName);
    const r = rootOfRule(g, grammar, refName);
    if (r < 0) return [];
    const heads: number[][] = [];
    for (const h of g.first[r]) {
      const e = g.node[h];
      if (e.type === 'ref') heads.push([h]);
      else if (isKeywordItem(e)) for (const n of g.follow[h]) if (isLit('*')(g.node[n])) heads.push([h, n]);
    }
    const out: string[] = [];
    for (const w of heads.map(w => ({ w, key: armOrderKey(g, w, [], true) })).sort((a, b) => compareArmOrder(a.key, b.key)).map(({ w }) => w)) {
      const e = g.node[w[0]];
      if (e.type === 'ref') out.push(...phaseStarKws(e.name, seen)); else out.push((e as { value: string }).value);
    }
    return out;
  };
  const starAllKws = new Set<string>();
  const phaseModsByKw = new Map<string, string[]>();
  const kwFirst = (e: RuleExpr) => e.type === 'literal' && importExportKws.has(e.value);
  for (const [a, b] of sortInArmOrder(g, findWindows(g, [kwFirst, (e) => isLit('*')(e) || e.type === 'ref']))) {
    const kw = (g.node[a] as { value: string }).value, next = g.node[b];
    if (next.type === 'literal' || (next.type === 'ref' && ruleBeginsWith(grammar, next.name, isLit('*')))) starAllKws.add(kw);
    if (next.type === 'ref') {
      const mods = phaseStarKws(next.name).filter(usedAsKeywordOnlyBeforeStar);
      if (mods.length) {
        starAllKws.add(kw);
        const cur = phaseModsByKw.get(kw) ?? [];
        for (const m of mods) if (!cur.includes(m)) cur.push(m);
        phaseModsByKw.set(kw, cur);
      }
    }
  }
  return { importExportKws, starAllKws, phaseModsByKw };
}

/** The import keywords directly followed by the identifier, or by a rule that begins with it (a
 *  default-import binding: `import x from …`). */
export function defaultBindImportKeywords(grammar: CstGrammar): Set<string> {
  const g = armGraph(grammar);
  const { identToken, importStar: { importExportKws } } = highlightFacts(grammar);
  const out = new Set<string>();
  if (!identToken) return out;
  const startsWithIdent = (e: RuleExpr) => e.type === 'ref' && (e.name === identToken.name || ruleBeginsWith(grammar, e.name, (h) => h.type === 'ref' && h.name === identToken.name));
  for (const [a] of sortInArmOrder(g, findWindows(g, [(e) => e.type === 'literal' && importExportKws.has(e.value), startsWithIdent]))) out.add((g.node[a] as { value: string }).value);
  return out;
}


/** The positions of a root (a root's positions are consecutive). */
const rootPositions = (g: ArmGraph, r: number): number[] => {
  const to = r + 1 < g.rootFrom.length ? g.rootFrom[r + 1] : g.node.length;
  return Array.from({ length: to - g.rootFrom[r] }, (_, i) => g.rootFrom[r] + i);
};
const rootOfBody = (g: ArmGraph, body: RuleExpr): number => g.body.indexOf(body);



/** Per keyword literal of the rules: what may directly follow it where it is the keyword (the
 *  literal FIRST and the token FIRST of each next item of its arms, through zero-width
 *  assertions), or null when that is open: it may end an arm (what follows is its rule's context),
 *  a next item may be empty, or it is also a precedence operator. A word followed by something
 *  outside a closed set is not that keyword there: it is a name (`set:`, `const from = 1`,
 *  `(of, x)`, `else?: T`). */
export function keywordFollowers(grammar: CstGrammar): Map<string, { literals: Set<string>; tokens: Set<string> } | null> {
  const g = armGraph(grammar);
  const byName = new Map(grammar.rules.map(r => [r.name, r.body] as const));
  const { tokenNames } = highlightFacts(grammar);
  const precOps = new Set(grammar.precs.flatMap(l => l.operators.map(o => o.value)));
  const zeroWidth = (e: RuleExpr) => ['sameLine', 'noCommentBefore', 'noMultilineFlowBefore', 'notLeftLeaf', 'not'].includes(e.type);
  // the token references that may begin an expression (refs followed at start positions only)
  const firstTokens = (e: RuleExpr, out: Set<string>, seen = new Set<string>()): void => {
    switch (e.type) {
      case 'ref':
        if (tokenNames.has(e.name)) out.add(e.name);
        else if (!seen.has(e.name) && byName.has(e.name)) { seen.add(e.name); firstTokens(byName.get(e.name)!, out, seen); }
        break;
      case 'alt': for (const i of e.items) firstTokens(i, out, seen); break;
      case 'seq': for (const i of e.items) { firstTokens(i, out, seen); if (!ruleIsNullable(i, byName)) break; } break;
      case 'quantifier': case 'group': firstTokens(e.body, out, seen); break;
      case 'sep': firstTokens(e.element, out, seen); break;
    }
  };
  // A word right after a member-access text (`import.source`, `new.target`) is a name there (the
  // member rule reads it), not the keyword: such an occurrence says nothing about what follows
  // the keyword.
  const member = new Set(highlightFacts(grammar).memberAccessTexts);
  const preds: number[][] = g.node.map(() => []);
  g.follow.forEach((ns, q) => { for (const n of ns) preds[n].push(q); });
  const atStart = new Set(g.first.flat());
  const afterMember = (p: number) => !atStart.has(p) && preds[p].length > 0
    && preds[p].every(q => { const x = g.node[q]; return x.type === 'literal' && member.has(x.value); });
  const out = new Map<string, { literals: Set<string>; tokens: Set<string> } | null>();
  for (let p = 0; p < g.node.length; p++) {
    const e = g.node[p];
    if (e.type !== 'literal' || !isKeywordLiteral(e.value)) continue;
    const k = e.value;
    if (out.get(k) === null) continue;
    if (afterMember(p)) { if (!out.has(k)) out.set(k, { literals: new Set(), tokens: new Set() }); continue; }
    if (precOps.has(k)) { out.set(k, null); continue; }
    const f = out.get(k) ?? { literals: new Set<string>(), tokens: new Set<string>() };
    let open = false;
    const seen = new Set<number>();
    const visit = (q: number) => {
      if (open || seen.has(q)) return;
      seen.add(q);
      if (g.isLast[q]) { open = true; return; }
      for (const n of g.follow[q]) {
        const x = g.node[n];
        if (zeroWidth(x)) { visit(n); continue; }
        if (ruleIsNullable(x, byName)) { open = true; return; }
        for (const l of firstLiterals(x, byName)) f.literals.add(l);
        firstTokens(x, f.tokens);
      }
    };
    visit(p);
    out.set(k, open ? null : f);
  }
  return out;
}

/** keywordFollowers as the highlighters test it: the keywords with a closed follower set, grouped
 *  by `followers` (the set's symbolic literals, longest first) and `starts` (the characters that
 *  begin a symbolic literal of the grammar, rule literal or precedence operator, and no token that
 *  may follow). A word of a group followed by a character of `starts` where no follower begins is
 *  a name. */
export function keywordNameGroups(grammar: CstGrammar): { words: string[]; followers: string[]; starts: string[] }[] {
  const longestFirst = (xs: Iterable<string>) => [...new Set(xs)].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const literals = [...grammar.rules.flatMap(r => [...collectLiterals(r.body)]), ...grammar.precs.flatMap(l => l.operators.map(o => o.value))].filter(l => !isKeywordLiteral(l));
  const litStarts = [...new Set(literals.map(l => l[0]))].sort();
  const tokenFirst = new Map(grammar.tokens.map(t => [t.name, patternInfo(t.pattern).first] as const));
  const inSet = (set: CSet, c: string) => { const u = c.charCodeAt(0); return set.some(([lo, hi]) => lo <= u && u <= hi); };
  const byKey = new Map<string, { words: string[]; followers: string[]; starts: string[] }>();
  for (const [word, f] of highlightFacts(grammar).keywordFollowers) {
    if (!f) continue;
    const followers = longestFirst([...f.literals].filter(l => !isKeywordLiteral(l)));
    const starts = litStarts.filter(c => ![...f.tokens].some(t => inSet(tokenFirst.get(t) ?? [], c)));
    if (!starts.length) continue;
    const key = `${followers.join('\0')}\u0001${starts.join('')}`;
    (byKey.get(key) ?? byKey.set(key, { words: [], followers, starts }).get(key)!).words.push(word);
  }
  return [...byKey.values()];
}

// ── Type positions ──

/** One TYPE POSITION of the grammar: a reference to a `@type` rule outside the `@type` rules, as a
 *  highlighter that sees only text reads it: what opens it, what stands before the opener, and
 *  what may follow the type there. Computed on the arm graph. */
export interface TypeContext {
  /** The rule whose arm holds the reference, and the reference's arm-graph position. */
  rule: string;
  position: number;
  /** The literal right before the reference (`:` `as` `=` `<` …). A reference that begins a
   *  `sep` element is opened by the sep's predecessor (the `<` of `'<', sep(Type, ','), '>'`).
   *  Null when no literal stands there. */
  opener: string | null;
  /** Per arm: the two items before the opener, nearest first, each its literal or `<Name>` (a
   *  token or rule reference, `<sameLine>` …): `['<Ident>', …]` for `x: T`. */
  left: string[][];
  /** The literals that may follow the type there, through rule ends (where the rule holding the
   *  reference may end, what follows its call sites), longest first. A `sep` element adds its
   *  delimiter; a precedence-operator item adds every binary operator. */
  closers: string[];
  /** The token references and zero-width items that may follow it (`<Template>`, `<sameLine>`). */
  closerTokens: string[];
  /** The delimiter when the reference is a whole `sep` element (`implements A, B`, `<A, B>`):
   *  after it another type of the list follows. */
  delimiter: string | null;
  /** The closers that are also CONTINUERS of the type (TypeBody.continuers): there the text alone
   *  does not tell whether the type goes on. `type`: the parser reads the type on (a
   *  left-recursive arm of the type rule takes the literal with no lookahead guard: its longest
   *  reading); `closer`: the type goes on only inside a construct (a conditional type's `?` /
   *  `:`) or behind a lookahead, so a reader of the text that does not track it ends the type. */
  conflicts: { literal: string; reads: 'type' | 'closer' }[];
}

/** What is known of a type's own text: the literals that may follow a COMPLETE type at bracket
 *  depth 0 (after a `@type` reference, or after an item an arm of a type rule may end with: never
 *  the FIRST of a type, which follows only an operator), and of those the ones a left-recursive
 *  arm reads with no lookahead guard after it. */
export interface TypeBody { continuers: string[]; unguarded: string[] }

const OPEN_CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
const zeroWidthItem = (e: RuleExpr) => ['sameLine', 'noCommentBefore', 'noMultilineFlowBefore', 'notLeftLeaf'].includes(e.type);
const longestFirstOf = (xs: Iterable<string>) => [...new Set(xs)].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));

/** typeBody: see TypeBody. Null without `@type` rules. */
export function typeBody(grammar: CstGrammar): TypeBody | null {
  const types = highlightFacts(grammar).typeRuleNames;
  if (!types.size) return null;
  const g = armGraph(grammar);
  const byName = new Map(grammar.rules.map(r => [r.name, r.body] as const));
  const isTypeRef = (e: RuleExpr) => e.type === 'ref' && types.has(e.name);
  const closeSet = new Set(Object.values(OPEN_CLOSE));
  const cont = new Set<string>();
  // the literal FIRST of the item at q, through zero-width items
  const firstLits = (q: number, seen = new Set<number>()): void => {
    if (seen.has(q)) return;
    seen.add(q);
    const x = g.node[q];
    if (zeroWidthItem(x)) { for (const n of g.follow[q]) firstLits(n, seen); return; }
    for (const l of firstLiterals(x, byName)) cont.add(l);
  };
  g.rootKind.forEach((kind, r) => {
    if (kind !== 'rule' || !types.has(grammar.rules[g.ruleIndex[r]].name)) return;
    const seen = new Set<string>();
    const todo: [number, number][] = g.first[r].map(p => [p, 0]);
    while (todo.length) {
      const [p, d] = todo.pop()!;
      const key = `${p},${d}`;
      if (seen.has(key) || d > 8) continue;
      seen.add(key);
      const e = g.node[p];
      const d2 = e.type === 'literal' && OPEN_CLOSE[e.value] ? d + 1 : e.type === 'literal' && closeSet.has(e.value) && d > 0 ? d - 1 : d;
      if (d2 === 0 && (isTypeRef(e) || g.isLast[p])) for (const q of g.follow[p]) firstLits(q);
      for (const q of g.follow[p]) todo.push([q, d2]);
    }
  });
  // a left-recursive arm of a type rule (`[$, …]`): the literal after the self-reference (through
  // zero-width items), unguarded unless a `not` lookahead after it rejects what begins an operand
  // (a token: `T ?` before a type start is no postfix `T?`; `not('|')` after a `|` rejects none)
  const { tokenNames } = highlightFacts(grammar);
  const rejectsOperand = (e: RuleExpr | undefined): boolean => {
    if (e?.type !== 'not') return false;
    const toks = new Set<string>();
    const walk = (x: RuleExpr, seen: Set<string>): void => {
      if (x.type === 'ref' && tokenNames.has(x.name)) toks.add(x.name);
      else if (x.type === 'ref' && byName.has(x.name) && !seen.has(x.name)) { seen.add(x.name); walk(byName.get(x.name)!, seen); }
      else if (x.type === 'alt') x.items.forEach(i => walk(i, seen));
      else if (x.type === 'seq' && x.items.length) walk(x.items[0], seen);
      else if (x.type === 'group' || x.type === 'quantifier') walk(x.body, seen);
    };
    walk(e.body, new Set());
    return toks.size > 0;
  };
  const unguarded = new Set<string>();
  for (const name of types) {
    const body = byName.get(name)!;
    for (const arm of body.type === 'alt' ? body.items : [body]) {
      const items = arm.type === 'seq' ? arm.items : [arm];
      let i = 0;
      while (i < items.length && zeroWidthItem(items[i])) i++;
      if (!(items[i] && isTypeRef(items[i]))) continue;
      i++;
      while (i < items.length && zeroWidthItem(items[i])) i++;
      const lit = items[i];
      if (lit?.type === 'literal' && !rejectsOperand(items[i + 1])) unguarded.add(lit.value);
    }
  }
  return { continuers: longestFirstOf(cont), unguarded: longestFirstOf([...unguarded].filter(l => cont.has(l))) };
}

/** The type positions of a grammar, and the keywords that open one (see TypeContext). */
export interface TypeContexts {
  sites: TypeContext[];
  /** Each keyword opener (`as`, `satisfies`, `is`, `implements` …) and, where the word stands in
   *  an arm without a type after it (`import * as ns from`, `{ a as b }`), the literals that may
   *  follow the item after it there (`from`, `,`, `}`): a reader that cannot tell the two arms
   *  apart ends the type at them. */
  openerWords: { word: string; elsewhere: string[] }[];
}

/** typeContexts: see TypeContexts. Empty without `@type` rules. */
export function typeContexts(grammar: CstGrammar): TypeContexts {
  const body = highlightFacts(grammar).typeBody;
  if (!body) return { sites: [], openerWords: [] };
  const { tokenNames, typeRuleNames: types } = highlightFacts(grammar);
  const g = armGraph(grammar);
  const byName = new Map(grammar.rules.map(r => [r.name, r.body] as const));
  const binary = grammar.precs.flatMap(l => l.operators.filter(o => o.position === 'infix').map(o => o.value));
  const ruleOf = (r: number) => grammar.rules[g.ruleIndex[r]].name;
  const preds: number[][] = g.node.map(() => []);
  g.follow.forEach((ns, q) => { for (const n of ns) preds[n].push(q); });
  const show = (e: RuleExpr) => e.type === 'literal' ? e.value : e.type === 'ref' ? `<${e.name}>` : `<${e.type}>`;
  type F = { lits: Set<string>; toks: Set<string> };
  const merge = (a: F, b: F) => { for (const l of b.lits) a.lits.add(l); for (const t of b.toks) a.toks.add(t); };
  // where a root may end: what follows its call sites (a rule's references, a sep element's sep)
  const followOfRoot = (r: number, seen: Set<number>): F => {
    const out: F = { lits: new Set(), toks: new Set() };
    if (seen.has(r)) return out;
    seen.add(r);
    const sep = g.rootKind[r] === 'sep' ? g.body[r] : null, name = ruleOf(r);
    g.node.forEach((e, p) => {
      if (sep ? !(e.type === 'sep' && e.element === sep) : !(e.type === 'ref' && e.name === name)) return;
      if (e.type === 'sep') out.lits.add(e.delimiter);
      merge(out, followOf(p, seen));
    });
    return out;
  };
  const followOf = (p: number, seen: Set<number>): F => {
    const out: F = { lits: new Set(), toks: new Set() };
    const visit = (q: number) => {
      const x = g.node[q];
      if (x.type === 'op') for (const o of binary) out.lits.add(o);
      else if (x.type === 'literal') out.lits.add(x.value);
      else if ((x.type === 'ref' && !tokenNames.has(x.name)) || x.type === 'sep') for (const l of firstLiterals(x, byName)) out.lits.add(l);
      else out.toks.add(show(x));
      if (zeroWidthItem(x)) for (const n of g.follow[q]) visit(n);
    };
    for (const q of g.follow[p]) visit(q);
    if (g.isLast[p]) merge(out, followOfRoot(g.root[p], seen));
    return out;
  };
  // the positions that may stand right before q, through zero-width items and root starts (a
  // root's first item: what stands before its call sites; a sep element's: before the sep, or its
  // delimiter)
  const callSites: number[][] = g.body.map(() => []);
  const rootOfRule = new Map<string, number>();
  g.rootKind.forEach((k, r) => { if (k === 'rule') rootOfRule.set(ruleOf(r), r); });
  const sepRoot = new Map(g.body.map((b, r) => [b, r] as const));
  g.node.forEach((x, s) => {
    if (x.type === 'sep' && sepRoot.has(x.element)) callSites[sepRoot.get(x.element)!].push(s);
    else if (x.type === 'ref' && rootOfRule.has(x.name)) callSites[rootOfRule.get(x.name)!].push(s);
  });
  const beforeMemo = new Map<number, number[]>();
  const before = (q0: number): number[] => {
    const hit = beforeMemo.get(q0);
    if (hit) return hit;
    const out = new Set<number>(), seen = new Set<number>();
    const walk = (q: number) => {
      if (seen.has(q)) return;
      seen.add(q);
      if (g.first[g.root[q]].includes(q)) for (const s of callSites[g.root[q]]) walk(s);
      for (const b of preds[q]) { if (zeroWidthItem(g.node[b])) walk(b); else out.add(b); }
    };
    walk(q0);
    const res = [...out];
    beforeMemo.set(q0, res);
    return res;
  };
  const leftOf = (o: number): string[][] => {
    const pairs = new Map<string, string[]>();
    for (const l of before(o)) {
      const seconds = before(l);
      for (const m of seconds.length ? seconds : [-1]) {
        const pair = [show(g.node[l]), ...m < 0 ? [] : [show(g.node[m])]];
        pairs.set(pair.join('\0'), pair);
      }
    }
    return [...pairs.values()];
  };
  const cont = new Set(body.continuers), unguarded = new Set(body.unguarded);
  const out: TypeContext[] = [];
  g.node.forEach((e, p) => {
    if (!(e.type === 'ref' && types.has(e.name)) || types.has(ruleOf(g.root[p]))) return;
    const openers = before(p).filter(q => g.node[q].type === 'literal');
    const f = followOf(p, new Set());
    const closers = longestFirstOf(f.lits);
    const r = g.root[p];
    const element = g.rootKind[r] === 'sep' && g.first[r].includes(p) && g.isLast[p];
    const sep = element ? g.node[callSites[r][0]] as { delimiter: string } : null;
    out.push({
      rule: ruleOf(r), position: p,
      opener: openers.length ? (g.node[openers[0]] as { value: string }).value : null,
      left: openers.flatMap(leftOf),
      closers, closerTokens: [...f.toks].sort(),
      delimiter: sep?.delimiter ?? null,
      conflicts: closers.filter(l => cont.has(l)).map(l => ({ literal: l, reads: unguarded.has(l) ? 'type' as const : 'closer' as const })),
    });
  });
  // a keyword that opens a type position somewhere: what follows the item after it elsewhere
  const opens = new Map<string, Set<string>>();
  for (const c of out) if (c.opener && isKeywordLiteral(c.opener)) opens.set(c.opener, new Set());
  g.node.forEach((e, p) => {
    if (e.type !== 'literal' || !opens.has(e.value)) return;
    for (const q of g.follow[p]) {
      const x = g.node[q];
      if (x.type === 'ref' && types.has(x.name)) continue;
      for (const l of followOf(q, new Set()).lits) opens.get(e.value)!.add(l);
    }
  });
  return { sites: out, openerWords: [...opens].map(([word, after]) => ({ word, elsewhere: longestFirstOf(after) })) };
}

// ── The facts object ──

// One entry per fact: how it is computed from the grammar. A fact that needs another reads it
// through `highlightFacts(g)`, so it too is computed once.
const FACTS = {
  /** Every token name: what tells a token reference from a rule reference. */
  tokenNames: (g: CstGrammar) => new Set(g.tokens.map(t => t.name)),
  /** The `@type` rules. */
  typeRuleNames: (g: CstGrammar) => new Set(g.rules.filter(r => r.flags.includes('type')).map(r => r.name)),
  /** THE identifier token as the TextMate grammar reads it: the one flagged `identifier: true`
   *  (the lexer's Unicode-identifier fallback), else the first token whose pattern AND resolved
   *  scope both classify as `variable.other` (a bare identifier with no explicit scope). The
   *  fallback is TextMate's alone: Monarch's differs (pattern classification only). */
  identToken: (g: CstGrammar): TokenDecl | undefined => g.tokens.find(t => t.identifier)
    ?? g.tokens.find(t => classifyToken(t, { explicitScope: false }).scope === 'variable.other'
      && classifyToken(t).scope === 'variable.other'),
  /** The member-access texts (`.`, `?.`: the lexer's `regexContext.memberAccessTexts`): a word
   *  right after one is a property name, never a keyword (the lexer's LX_MEMBER rule). */
  memberAccessTexts: (g: CstGrammar): string[] => g.tokens.find(t => t.regexContext)?.regexContext?.memberAccessTexts ?? [],
  /** The `@regex` token's name, if any. */
  regexTokenName: (g: CstGrammar) => g.tokens.find(t => t.flags.includes('regex'))?.name,
  contextualOperatorKeywords: (g: CstGrammar) => findContextualOperatorKeywords(g),
  contextualAccessibilityModifiers: (g: CstGrammar) => findContextualAccessibilityModifiers(g),
  angleBracket: (g: CstGrammar) => detectAngleBracketAmbiguity(g),
  angleBracketCast: (g: CstGrammar) => detectAngleBracketCast(g),
  arrowParamDelims: (g: CstGrammar) => arrowParamDelims(g),
  commentRepoKeys: (g: CstGrammar) => commentRepoKeys(g),
  blockCommentMatchers: (g: CstGrammar) => blockCommentMatchers(g),
  regexLiteral: (g: CstGrammar) => detectRegexLiteral(g, highlightFacts(g).tokenNames),
  calleeToken: (g: CstGrammar) => findCalleeToken(g),
  explicitKey: (g: CstGrammar) => detectExplicitKey(g),
  blockSequence: (g: CstGrammar) => detectBlockSequence(g),
  fold: (g: CstGrammar) => detectFold(g),
  valuePositions: (g: CstGrammar) => valuePositions(g),
  flowCollections: (g: CstGrammar) => detectFlowCollections(g),
  /** A `:` type annotation exists (some `':' <@type rule>` adjacency). */
  typeAnnotations: (g: CstGrammar) => highlightFacts(g).typeRuleNames.size > 0 && hasColonTypeAnnotation(g, highlightFacts(g).typeRuleNames),
  conditionalType: (g: CstGrammar) => detectConditionalType(g),
  declarations: (g: CstGrammar) => detectDeclarations(g),
  bindingCloseBrackets: (g: CstGrammar) => deriveBindingCloseBrackets(g, highlightFacts(g).identToken?.name),
  directParamKeywords: (g: CstGrammar) => directParamKeywords(g),
  reservedWords: (g: CstGrammar) => collectReservedWords(g),
  computedMemberCloseBrackets: (g: CstGrammar) => deriveComputedMemberCloseBrackets(g, highlightFacts(g).typeRuleNames),
  /** Every rule's keyword + identifier adjacencies, in rule order (duplicates kept). */
  contextualPatterns: (g: CstGrammar) => g.rules.flatMap(rule =>
    findContextualPatterns(g, rule.body, highlightFacts(g).tokenNames, highlightFacts(g).identToken?.name ?? null)),
  callExpression: (g: CstGrammar) => hasCallExpression(g),
  constructorKeywords: (g: CstGrammar) => constructorKeywords(g),
  propertyAccess: (g: CstGrammar) => propertyAccess(g),
  bareArrowParam: (g: CstGrammar) => hasBareArrowParam(g),
  parenArrowParams: (g: CstGrammar) => hasParenArrowParams(g),
  ternary: (g: CstGrammar) => hasTernary(g),
  /** Keywords directly followed by a `@type` rule reference (none without `@type` rules). */
  typeKeywords: (g: CstGrammar) => highlightFacts(g).typeRuleNames.size > 0 ? findTypeKeywordPatterns(g, highlightFacts(g).typeRuleNames) : [],
  expressionKeywords: (g: CstGrammar) => expressionKeywords(g),
  loopConnectorOpeners: (g: CstGrammar) => loopConnectorOpeners(g),
  allLiterals: (g: CstGrammar) => allLiterals(g),
  parenType: (g: CstGrammar) => parenType(g),
  bracketType: (g: CstGrammar) => bracketType(g),
  objectType: (g: CstGrammar) => objectType(g),
  privateFields: (g: CstGrammar) => privateFields(g),
  typeLiterals: (g: CstGrammar) => typeLiterals(g),
  typeContextKeywords: (g: CstGrammar) => typeContextKeywords(g),
  statementStartKeywords: (g: CstGrammar) => statementStartKeywords(g),
  importStar: (g: CstGrammar) => importStar(g),
  defaultBindImportKeywords: (g: CstGrammar) => defaultBindImportKeywords(g),
  lexedByToken: (g: CstGrammar) => lexedByToken(g),
  alwaysBeforeString: (g: CstGrammar) => alwaysBeforeString(g),
  keywordFollowers: (g: CstGrammar) => keywordFollowers(g),
  keywordNameGroups: (g: CstGrammar) => keywordNameGroups(g),
  typeBody: (g: CstGrammar) => typeBody(g),
  typeContexts: (g: CstGrammar) => typeContexts(g),
};

export type HighlightFacts = { readonly [K in keyof typeof FACTS]: ReturnType<(typeof FACTS)[K]> };

const factsOf = new WeakMap<CstGrammar, HighlightFacts>();

/** The facts of `grammar`, each computed on its first read and kept for the grammar's lifetime. */
export function highlightFacts(grammar: CstGrammar): HighlightFacts {
  let facts = factsOf.get(grammar);
  if (facts) return facts;
  const memo: Record<string, unknown> = {};
  facts = {} as HighlightFacts;
  for (const key of Object.keys(FACTS) as (keyof typeof FACTS)[]) {
    Object.defineProperty(facts, key, {
      enumerable: true,
      get: () => (key in memo ? memo[key] : (memo[key] = FACTS[key](grammar))),
    });
  }
  factsOf.set(grammar, facts);
  return facts;
}
