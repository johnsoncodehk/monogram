import type { CstGrammar, RuleExpr, RuleDecl, InjectClause, TokenDecl } from './types.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';
import {
  tokenEscapePatternSource,
  tokenPatternBlockDelimiterSources,
  tokenPatternBlockDelimiters,
  tokenPatternIdentifierExtraChars,
  tokenPatternEqualsPattern,
  tokenPatternIsNever,
  tokenPatternLeadingSource,
  tokenPatternLiteralText,
  tokenPatternLiteralPrefix,
  tokenPatternNodeContainsLiteral,
  tokenPatternPrefixBeforeTrailingLookahead,
  tokenPatternQuoteDelimAndEscape,
  tokenPatternSource,
  tokenPatternStartsWithDecimal,
  tokenPatternStringDelimiters,
  tokenPatternToRegex,
  tokenPatternTrailingCharClass,
} from './token-pattern.ts';

interface TmPattern {
  name?: string;
  contentName?: string;
  match?: string;
  begin?: string;
  end?: string;
  applyEndPatternLast?: boolean;
  while?: string;
  captures?: Record<string, TmCapture>;
  beginCaptures?: Record<string, TmCapture>;
  endCaptures?: Record<string, TmCapture>;
  patterns?: (TmPattern | { include: string })[];
  include?: string;
}

// A capture is itself a rule (vscode-textmate maps IRawCaptures → IRawRule): besides
// carrying a scope `name`, it may RE-TOKENIZE its span via `patterns`/`include`
// (capture-embed). Used to scope `<script>`'s start-tag attributes (#attribute) and to
// embed a single-line raw-text body (e.g. `<script>const x</script>` → source.js).
interface TmCapture {
  name?: string;
  patterns?: (TmPattern | { include: string })[];
  include?: string;
}

interface TmGrammar {
  $schema: string;
  name: string;
  scopeName: string;
  // Usually a flat include list; an indentation grammar with a block scalar wraps these in a
  // line-spanning `meta.stream` region (a `TmPattern` with begin/while/patterns) — see the grammar
  // root return — so the top level admits region wrappers too, like `TmPattern.patterns` does.
  patterns: (TmPattern | { include: string })[];
  repository: Record<string, TmPattern>;
}

// ── Helpers ──

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape a character for use inside a regex character class `[...]`.
 *  Inside `[...]`, the special chars are `[` (nested class in Oniguruma), `]`, `\\`, `^` (at start), and `-` (as range). */
function escapeForCharClass(s: string): string {
  return s.replace(/[\[\]\\^-]/g, '\\$&');
}

// An INDENT-BOUNDED region: capture the line's leading indent into `\1`, then stay open while each
// following line is BLANK or matches a `\1`-relative continuation condition (`cont`), releasing at a
// sibling/dedent. This is the shared shape of every YAML block-scalar and plain-fold region — the
// depth-bearing "indent region" (a TextMate rule-stack frame that remembers ONE nesting level's indent
// via the `\1` backref). The `^([ \t]*)` capture and the blank-line arm are standard; the caller passes
// the begin `lookahead` (+ optional `beginCaptures`), the `\1`-relative `cont` arm, and the `patterns`.
// `blankFirst` chooses the order of the blank vs `cont` arms in the `while` (block scalars list `cont`
// first; the plain folds list blank first) — kept as a knob so the emitted regex stays byte-identical
// to the prior hand-written regions. (The document-root block scalar uses a doc-marker bound, not a
// `\1`-indent bound, so it is NOT built through this helper.)
function emitIndentRegion(o: { lookahead: string; cont: string; blankFirst?: boolean; beginCaptures?: Record<string, TmCapture>; patterns: (TmPattern | { include: string })[] }): TmPattern {
  const blank = '[ \\t]*$';
  return {
    begin: `^([ \\t]*)${o.lookahead}`,
    ...(o.beginCaptures ? { beginCaptures: o.beginCaptures } : {}),
    while: `\\G(?=${o.blankFirst ? `${blank}|${o.cont}` : `${o.cont}|${blank}`})`,
    patterns: o.patterns,
  };
}

/**
 * Emit the shared "bracket-pair → begin/end region" skeleton.
 *
 * A bracket-delimited rule (`OPEN … CLOSE`) becomes a begin/end TextMate region so depth
 * nests on the scope stack: `begin: OPEN`, `end: CLOSE`, both delimiters scoped via a single
 * `'0'`-capture, and `patterns: bodyPatterns` (the body — which RE-INCLUDES the region itself
 * for nesting). This is the ONLY thing factored out: the structural begin/end + body wiring.
 *
 * Every construct-specific choice stays at the call site and is passed in: the literal brackets
 * (`{ }`, or YAML's bare `{`/`[`), the delimiter scope names, the body patterns (which decide the
 * recurse target — `$self`, `#code-block`, `#flow-node`, …), and the optional region `name`.
 * The CALLER decides "this rule IS a bracket region" with its own predicate; this helper only
 * lays down the skeleton once that decision is made (it never auto-fires on any `[OPEN,…,CLOSE]`).
 *
 * Key INSERTION ORDER is load-bearing — the grammar is `JSON.stringify`'d verbatim — so `name`
 * (when given) is emitted first, then always `begin, beginCaptures, end, endCaptures, patterns`.
 */
function emitBracketRegion(opts: {
  openLit: string;                                       // begin regex (already escaped)
  closeLit: string;                                      // end regex (already escaped)
  beginCapName: string;                                  // scope for the open delimiter ('0' capture)
  endCapName: string;                                    // scope for the close delimiter ('0' capture)
  bodyPatterns: (TmPattern | { include: string })[];     // region body (includes the recurse target)
  name?: string;                                         // optional region scope (emitted first)
}): TmPattern {
  const region: TmPattern = {};
  if (opts.name !== undefined) region.name = opts.name;
  region.begin = opts.openLit;
  region.beginCaptures = { '0': { name: opts.beginCapName } };
  region.end = opts.closeLit;
  region.endCaptures = { '0': { name: opts.endCapName } };
  region.patterns = opts.bodyPatterns;
  return region;
}

/**
 * Emit the shared "keyword → begin/end scope region" skeleton.
 *
 * A keyword-anchored rule opens on a single word and scopes a body until some lookahead/
 * lookbehind end: `begin: \b(kw)`, the keyword scoped via a single `'1'`-capture, `end` (a
 * caller-supplied boundary — almost always a lookahead), and `patterns: bodyPatterns`. This
 * centralizes the ONE footgun shared across these sites: the `\b(${escapeRegex(kw)})` begin
 * spelling and the `'1'` keyword capture. Everything construct-specific stays at the call
 * site and is passed in: the `end` boundary (each region computes its own terminator set),
 * the body patterns, the region `name`, and two begin tweaks —
 *   - `wordEnd`  : append a trailing `\b` after the captured keyword (`\b(kw)\b`). Most sites
 *                  want it; a site whose keyword is immediately followed by `(`/whitespace it
 *                  matches separately (e.g. `constructor` → `\b(kw)`) omits it.
 *   - `guard`    : an extra suffix after the (optionally word-ended) keyword — e.g. a
 *                  contextual-operator lookahead that keeps `as`/`is` off identifier uses.
 *
 * The CALLER decides "this rule IS a keyword region"; this helper only lays the structural
 * skeleton once that decision is made. Key INSERTION ORDER is load-bearing — the grammar is
 * `JSON.stringify`'d verbatim — so `name` (when given) is emitted first, then always
 * `begin, beginCaptures, end, patterns`.
 */
function emitKeywordRegion(opts: {
  kw: string;                                            // keyword literal (escaped by the helper)
  kwScope: string;                                       // scope for the keyword ('1' capture)
  end: string;                                           // end boundary (usually a lookahead)
  patterns: (TmPattern | { include: string })[];        // region body
  name?: string;                                         // optional region scope (emitted first)
  wordEnd?: boolean;                                     // append `\b` after the keyword (default false)
  guard?: string;                                        // extra begin suffix after the keyword (default '')
}): TmPattern {
  const region: TmPattern = {};
  if (opts.name !== undefined) region.name = opts.name;
  region.begin = `\\b(${escapeRegex(opts.kw)})${opts.wordEnd ? '\\b' : ''}${opts.guard ?? ''}`;
  region.beginCaptures = { '1': { name: opts.kwScope } };
  region.end = opts.end;
  region.patterns = opts.patterns;
  return region;
}

/**
 * Return escaped non-\w characters that are valid in identifiers, derived from the Ident token IR.
 */
function identExtraClass(token: TokenDecl | undefined): string {
  return token ? [...tokenPatternIdentifierExtraChars(token)].map(escapeForCharClass).join('') : '';
}

// Unicode identifier classes (the same set the parser's lexer accepts for non-ASCII
// identifiers): `\p{L}\p{Nl}` start, plus `\p{Nd}\p{Mn}\p{Mc}\p{Pc}` continue.
const UNICODE_ID_START = '\\p{L}\\p{Nl}';
const UNICODE_ID_CONTINUE = '\\p{L}\\p{Nl}\\p{Nd}\\p{Mn}\\p{Mc}\\p{Pc}';

/**
 * Widen an ASCII-only identifier regex so the emitted TextMate (Oniguruma) pattern
 * also scopes non-ASCII identifiers (e.g. `Ω`, Cyrillic `А`). The parser's lexer
 * already accepts these via a Unicode fallback; this gives the highlighter parity.
 *
 * An identifier character class is recognised by containing `_` or `$` (the
 * always-allowed identifier punctuation) — this avoids touching hex classes like
 * `[0-9a-fA-F]` used by embedded `\uXXXX`/`\u{...}` escape alternatives. The class is
 * widened in place: it gains the Unicode letter classes, plus the Unicode continue
 * classes when it ALSO contains digits (`0-9`, i.e. the identifier-CONTINUE class).
 * ASCII stays a strict subset, so existing matches are unchanged. Oniguruma supports
 * `\p{...}`; JS regex without the `/u` flag does not — but this widened form feeds
 * ONLY the TextMate emitter, never the lexer (which compiles the original ASCII token
 * pattern). If no identifier class is found, the pattern is returned unchanged.
 */
function unicodeWidenIdentPattern(identRegex: string): string {
  return identRegex.replace(/\[[^\]]*\]/g, cls => {
    if (!/[_$]/.test(cls)) return cls;                   // not an identifier class (e.g. hex) — leave alone
    const add = /0-9/.test(cls) ? UNICODE_ID_CONTINUE : UNICODE_ID_START;
    return cls.slice(0, -1) + add + ']';                 // insert before the closing `]`
  });
}

/**
 * Build a lookbehind that matches the end of an identifier, ] or ).
 * Derives extra identifier characters (e.g., `$`) from the Ident token IR
 * instead of hardcoding them.
 */
function buildIdentLookbehind(identToken: TokenDecl | undefined): string {
  const extra = identExtraClass(identToken);
    return `(?<=[\\w${extra}\\]\\)])`;
}

/**
 * Expand a rule expression into the set of concrete top-level item sequences,
 * resolving `?` (opt) into present/absent branches and `alt` into its branches.
 * `*`/`+` quantifiers, `sep`, refs and literals are kept as opaque items
 * (their internals are still reachable via recursive walks).
 *
 * This lets the shape/adjacency matchers below see the same flattened forms
 * they'd see if every optional combination were written out by hand — so the
 * grammar can use opt()/alt() for brevity without hiding patterns from gen-tm.
 *
 * Bounded by 2^(opts) per alternative; alternatives have few opts in practice.
 */
function expandAlts(expr: RuleExpr): RuleExpr[][] {
  switch (expr.type) {
    case 'seq': {
      let acc: RuleExpr[][] = [[]];
      for (const item of expr.items) {
        const branches = expandAlts(item);
        const next: RuleExpr[][] = [];
        for (const prefix of acc) for (const b of branches) next.push([...prefix, ...b]);
        acc = next;
      }
      return acc;
    }
    case 'alt':
      return expr.items.flatMap(expandAlts);
    case 'group':
      return expandAlts(expr.body);
    case 'quantifier': {
      // For shape/adjacency matching, "zero or one occurrence" captures every
      // adjacency a repetition can produce. `?`/`*` may be absent; `+` is always
      // present (one occurrence is enough to expose its inner adjacencies).
      const present = expandAlts(expr.body);
      return expr.kind === '+' ? present : [[], ...present];
    }
    default:
      return [[expr]];   // literal, ref, sep, op, prefix, postfix
  }
}

interface ContextualPattern {
  keyword: string;
  identScope: string;
}

/**
 * Infer the identifier-scope that follows a keyword in definition patterns.
 * Driven entirely by `scopeOverrides` from the DSL `scopes` section:
 *   storage.type.function*  → entity.name.function
 *   storage.type.X (other)  → entity.name.type
 */
function getScope(overrides: Map<string, string[]>, key: string): string | undefined {
  return overrides.get(key)?.[0];
}

// TextMate-convention remaps from a `storage.type.<kind>` declaration keyword to
// the leaf of the `entity.name.type.<leaf>` it introduces. Most kinds keep their
// own name (`class`→`class`, `interface`→`interface`, `enum`→`enum`); two follow
// the established convention of a different leaf: a `type` alias name is
// `.type.alias`, and a `namespace`/`module` name is `.type.module`. Driven by the
// scope subtype, not by any specific keyword — a grammar gets the finer name for
// free by scoping its declaration keyword `storage.type.<kind>`.
const TYPE_NAME_LEAF: Record<string, string> = { type: 'alias', namespace: 'module', module: 'module' };

function inferIdentScope(keyword: string, scopeOverrides: Map<string, string[]>): string | null {
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

/**
 * Does a rule, when expanded, have an alternative that begins with the given
 * identifier token? Used so a `keyword Ident` pattern is still detected when the
 * identifier is reached through a rule-ref (e.g. `extends ClassHeritage`, whose
 * base alternative is `Ident`). Bounded depth guards against ref cycles.
 */
function ruleStartsWithIdent(
  refName: string,
  identTokenName: string,
  rules: RuleDecl[],
  seen: Set<string> = new Set(),
): boolean {
  if (refName === identTokenName) return true;
  if (seen.has(refName)) return false;
  seen.add(refName);
  const rule = rules.find(r => r.name === refName);
  if (!rule) return false;
  for (const alt of expandAlts(rule.body)) {
    const head = alt[0];
    if (!head) continue;
    if (head.type === 'ref' && ruleStartsWithIdent(head.name, identTokenName, rules, seen)) return true;
  }
  return false;
}

function findContextualPatterns(
  expr: RuleExpr,
  tokenNames: Set<string>,
  scopeOverrides: Map<string, string[]>,
  rules: RuleDecl[],
  identTokenName: string | null,
): ContextualPattern[] {
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
        (identTokenName !== null && ruleStartsWithIdent(b.name, identTokenName, rules));
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
function hasColonTypeAnnotation(grammar: CstGrammar, typeRuleNames: Set<string>): boolean {
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
function deriveBindingCloseBrackets(grammar: CstGrammar, identName: string | undefined): string[] {
  const PAIR: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const directRef = (expr: RuleExpr | undefined, name: string): boolean => {
    if (!expr) return false;
    if (expr.type === 'ref') return expr.name === name;
    if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(i => directRef(i, name));
    if (expr.type === 'quantifier' || expr.type === 'group' || expr.type === 'not' || expr.type === 'sameLine') {
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
    if (expr.type === 'quantifier' || expr.type === 'group' || expr.type === 'not' || expr.type === 'sameLine') {
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
function deriveComputedMemberCloseBrackets(grammar: CstGrammar, typeRuleNames: Set<string>): string[] {
  const PAIR: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  // Member-NAME rules: a `ref` that, within some sequence, is followed (allowing an
  // intervening optional `?`/group) by a literal `:` then a type-rule ref — the
  // `key (?) : Type` member shape. Those refs name the rules that occupy a key slot.
  const memberNameRules = new Set<string>();
  const scanSeq = (items: RuleExpr[]): void => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // A member KEY is never a type-rule ref itself (excludes a TYPE `ref` that
      // happens to sit before a `:` in a type-internal construct — a conditional
      // type `T extends U ? X : Y`, a mapped-type `[K in T]: U`, etc.).
      if (it.type !== 'ref' || typeRuleNames.has(it.name)) continue;
      // look ahead for `… : <typeRef>` after this ref (skip an optional `?`/group)
      for (let j = i + 1; j < items.length; j++) {
        const nx = items[j];
        if (nx.type === 'literal' && (nx as { value: string }).value === ':') {
          const after = items[j + 1];
          if (after && after.type === 'ref' && typeRuleNames.has((after as { name: string }).name)) {
            memberNameRules.add((it as { name: string }).name);
          }
          break;
        }
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
    if (expr.type === 'quantifier' || expr.type === 'group' || expr.type === 'not' || expr.type === 'sameLine') {
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
    if (expr.type === 'quantifier' || expr.type === 'group' || expr.type === 'not' || expr.type === 'sameLine') {
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

// ── Token classification ──

/**
 * Derive a TextMate-conventional suffix for line comment scope based on the
 * literal prefix of the regex pattern.  E.g., `//` → `double-slash`,
 * `#` → `number-sign`.
 *
 * Uses a universal character-name mapping (not language-specific).
 */
function lineCommentScopeSuffix(prefix: string | undefined): string {
  if (!prefix) return '';
  const charName: Record<string, string> = {
    '/': 'slash', '#': 'number-sign', '-': 'dash', ';': 'semicolon',
    '%': 'percentage', '!': 'bang', "'": 'apostrophe', '*': 'asterisk',
  };
  const parts = [...prefix].map(ch => charName[ch] || ch);
  if (parts.length === 2 && parts[0] === parts[1]) {
    return `.double-${parts[0]}`;
  }
  return `.${parts.join('-')}`;
}

function classifyToken(token: TokenDecl, opts?: { explicitScope?: boolean }): { scope: string; isBlock?: boolean } {
  const useExplicitScope = opts?.explicitScope ?? true;
  const commentLike = token.flags.includes('skip') || token.scope?.startsWith('comment.');
  const isBlock = commentLike && !!tokenPatternBlockDelimiters(token);
  if (useExplicitScope && token.scope) return { scope: token.scope, isBlock: isBlock || undefined };
  if (token.flags.includes('skip')) {
    if (isBlock) {
      return { scope: 'comment.block', isBlock: true };
    }
    const suffix = lineCommentScopeSuffix(tokenPatternLiteralPrefix(token));
    return { scope: `comment.line${suffix}` };
  }

  if (tokenPatternStartsWithDecimal(token)) {
    // A `[0-9]`/`\d`-leading token is a base-10 (decimal) numeric. The TextMate
    // `.decimal`/`.hex`/`.octal`/`.binary` axis names the BASE, not int-vs-float —
    // an optional fraction/exponent does not change the base — so a single
    // base-10 token (matching `1`, `1.5`, `1e3` alike) is `constant.numeric.decimal`.
    // (Named bases get their scope from explicit token annotations.)
    return { scope: 'constant.numeric.decimal' };
  }

  const delimiters = tokenPatternStringDelimiters(token);
  if (delimiters.includes('"')) return { scope: 'string.quoted.double' };
  if (delimiters.includes("'")) return { scope: 'string.quoted.single' };
  if (delimiters.includes('`')) return { scope: 'string.quoted.other.template' };

  return { scope: 'variable.other' };
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
function commentRepoKeys(grammar: CstGrammar): string[] {
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
function blockCommentMatchers(grammar: CstGrammar): string[] {
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
function findTypeKeywordPatterns(
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
 * Collect the grammar's "always-reserved" words: the union of all literals
 * forbidden by a `not(...)` zero-width guard. These guards encode positions
 * where a reserved word may not stand in for an identifier (binding name,
 * shorthand property, expression NUD). A word that appears in NO such guard is
 * never reserved by the grammar, i.e. it is a valid identifier somewhere.
 *
 * Language-agnostic: reads only the `not` AST nodes, never specific words.
 */
function collectReservedWords(grammar: CstGrammar): Set<string> {
  const reserved = new Set<string>();
  function collectLits(e: RuleExpr, out: Set<string>): void {
    if (e.type === 'literal') { if (isKeywordLiteral(e.value)) out.add(e.value); return; }
    if (e.type === 'seq' || e.type === 'alt') e.items.forEach(i => collectLits(i, out));
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') collectLits(e.body, out);
    else if (e.type === 'sep') collectLits(e.element, out);
  }
  function walk(e: RuleExpr): void {
    if (e.type === 'not') collectLits(e.body, reserved);
    if (e.type === 'seq' || e.type === 'alt') e.items.forEach(walk);
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') walk(e.body);
    else if (e.type === 'sep') walk(e.element);
  }
  for (const rule of grammar.rules) walk(rule.body);
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
function findContextualOperatorKeywords(grammar: CstGrammar): Set<string> {
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
function findContextualAccessibilityModifiers(grammar: CstGrammar): Set<string> {
  const reserved = collectReservedWords(grammar);
  const modKws = new Set<string>();
  for (const [lit, scopes] of grammar.scopeOverrides) {
    if (!isKeywordLiteral(lit) || reserved.has(lit)) continue;
    if (scopes.some(s => s.startsWith('storage.modifier'))) modKws.add(lit);
  }
  if (modKws.size === 0) return modKws;

  const ruleByName = new Map(grammar.rules.map(r => [r.name, r]));

  // Modifier literals an expression can END with (its last-set), peeking through
  // opt/many/group/alt — used to attribute the NEXT sibling's first-set as FOLLOW.
  const lastModifiers = (e: RuleExpr, out: Set<string>): void => {
    switch (e.type) {
      case 'literal': if (modKws.has(e.value)) out.add(e.value); return;
      case 'seq': if (e.items.length) lastModifiers(e.items[e.items.length - 1], out); return;
      case 'alt': for (const it of e.items) lastModifiers(it, out); return;
      case 'quantifier': case 'group': lastModifiers(e.body, out); return;
      case 'sep': lastModifiers(e.element, out); return;
    }
  };
  // First-set literals of an expression, resolving rule refs (so `Block` → `{`).
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
      case 'seq': if (e.items.length) firstLiterals(e.items[0], out, seen); return;
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
        const nxt = e.items[i + 1];
        if (enders.size && nxt) for (const m of enders) firstLiterals(nxt, followers.get(m)!, new Set());
      }
      e.items.forEach(walk);
    } else if (e.type === 'alt') e.items.forEach(walk);
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') walk(e.body);
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
 * Build an Oniguruma character class matching the first character of any TYPE
 * or VALUE operand: identifier-start chars, string/template delimiters, the
 * grouping/opening brackets used in types & values (`(`, `{`, `[`), a digit,
 * and `-` (negative numeric literal types). Derived from the grammar's tokens
 * and rule literals — no hardcoded language keywords.
 *
 * A contextual operator keyword (see findContextualOperatorKeywords) is a
 * keyword exactly when followed by whitespace then one of these — distinguishing
 * `x as T` / `keyof U` (keyword) from `const as = 1` / `as()` / `as.x` (identifier:
 * the next char is `=` / `(` / `.`, none of which start an operand).
 */
function buildOperandStartClass(grammar: CstGrammar, identToken: TokenDecl | undefined): string {
  const chars = new Set<string>();
  // Identifier-start: $/_ plus the non-\w extras from the Ident token.
  chars.add('_');
  if (identToken) for (const ch of tokenPatternIdentifierExtraChars(identToken)) chars.add(ch);
  // String / template delimiters (first char of any string/template token).
  for (const tok of grammar.tokens) {
    if (tok.string || tok.template) {
      const first = tokenPatternStringDelimiters(tok)[0]?.[0];
      if (first && !/[a-zA-Z0-9]/.test(first)) chars.add(first);
    }
  }
  // Grouping/opening brackets that begin a grouped type or value.
  const allLits = new Set<string>();
  for (const rule of grammar.rules) for (const l of collectLiterals(rule.body)) allLits.add(l);
  for (const open of ['(', '{', '[']) if (allLits.has(open)) chars.add(open);
  // Negative numeric literal types (`-1`, `-2n`) appear as a `-` prefix in @type rules.
  const typeLits = new Set<string>();
  for (const rule of grammar.rules) {
    if (rule.flags.includes('type')) for (const l of collectLiterals(rule.body)) typeLits.add(l);
  }
  if (typeLits.has('-')) chars.add('-');
  const cls = [...chars].map(escapeForCharClass).join('');
  // `[:alpha:]` + `[:digit:]` cover the Unicode-agnostic letter/digit start.
  return `[[:alpha:][:digit:]${cls}]`;
}

function notAfterValueWithOptionalWhitespace(valueCharClass: string, maxWhitespace = 16): string {
  const assertions: string[] = [];
  for (let spaces = 0; spaces <= maxWhitespace; spaces++) {
    assertions.push(`(?<![${valueCharClass}]${'\\s'.repeat(spaces)})`);
  }
  return assertions.join('');
}

// ── JSX detection ──

interface JsxInfo {
  selfCloseTok: string;   // the literal text of the self-closing tag token (`/>`)
  closeTok: string;       // the literal text of the close-tag-open token (`</`)
  // The inner @type rule name a generic type-argument list on a tag carries, from
  // the element production `'<' TagName <opt '<' sep(Type, ',') '>'> …` (TS-family
  // JSX only; null for a type-free `.jsx` grammar, where a tag has no type args).
  typeArgRule: string | null;
}

/**
 * Detect a JSX/TSX dialect from the grammar, structurally and agnostically: a
 * JSX grammar declares two dedicated punctuation tokens whose patterns are
 * exactly the self-closing tag `/>` and the close-tag opener `</` (a JSX grammar
 * needs these to lex `<Tag/>` / `</Tag>` atomically — see javascriptreact.ts), AND
 * a rule that uses a literal `<` immediately before a rule reference (the JSX
 * element production `'<' TagName …`). The two tokens alone are the signal; the
 * `<`-before-ref check guards against a grammar that merely happens to declare
 * those token texts for some non-JSX purpose. Returns the token texts (so the
 * emitted patterns reference the grammar's own delimiters), or null.
 *
 * A non-JSX grammar (plain TypeScript/JavaScript) declares no such tokens, so
 * this returns null and NO JSX patterns are emitted — the TS/JS TextMate output
 * is therefore byte-identical to before this feature existed.
 */
function detectJsx(grammar: CstGrammar): JsxInfo | null {
  let selfCloseTok: string | null = null;
  let closeTok: string | null = null;
  for (const tok of grammar.tokens) {
    if (tok.flags.includes('skip') || tok.flags.includes('regex')) continue;
    const text = tokenPatternLiteralText(tok);
    if (text === '/>') selfCloseTok = text;
    else if (text === '</') closeTok = text;
  }
  if (!selfCloseTok || !closeTok) return null;

  // Confirm the JSX element production: a `<` literal directly before a rule ref.
  let hasElementShape = false;
  const walk = (e: RuleExpr): void => {
    if (e.type === 'seq') {
      for (let i = 0; i < e.items.length - 1; i++) {
        if (e.items[i].type === 'literal' && (e.items[i] as { value: string }).value === '<' &&
            e.items[i + 1].type === 'ref') hasElementShape = true;
      }
      e.items.forEach(walk);
    } else if (e.type === 'alt') e.items.forEach(walk);
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') walk(e.body);
    else if (e.type === 'sep') walk(e.element);
  };
  for (const rule of grammar.rules) walk(rule.body);
  if (!hasElementShape) return null;

  // Detect generic type-arguments on a tag: in an element alternative the tag
  // name ref is followed by an optional `'<' sep(Type, ',') '>'` group. Expanding
  // opt()/alt() surfaces the present branch as `… '<' ref(TagName) '<' sep '>' …`,
  // so scan each flattened sequence for the `'<' ref '<' sep '>'` shape and read
  // the sep element's ref — the @type rule scoped inside the type-arg list. Only
  // a TS-family JSX grammar declares this (the `.jsx` base omits `typeArgs`), so a
  // plain JS JSX grammar yields null here and emits no tag type-args patterns.
  let typeArgRule: string | null = null;
  const findTypeArgs = (items: RuleExpr[]): void => {
    for (let i = 0; i + 3 < items.length; i++) {
      if (items[i].type === 'literal' && (items[i] as { value: string }).value === '<' &&
          items[i + 1].type === 'ref' &&
          items[i + 2].type === 'literal' && (items[i + 2] as { value: string }).value === '<' &&
          items[i + 3].type === 'sep') {
        const sep = items[i + 3] as { type: 'sep'; element: RuleExpr };
        if (sep.element.type === 'ref') typeArgRule = sep.element.name;
      }
    }
  };
  for (const rule of grammar.rules) for (const seq of expandAlts(rule.body)) findTypeArgs(seq);

  return { selfCloseTok, closeTok, typeArgRule };
}

/**
 * The regex building-blocks used to disambiguate a `.tsx` generic-arrow type-param
 * list (`<T = X,>(…) =>`) from a JSX tag-open. Both #arrow-type-parameters' begin
 * guard AND its inverse (the carve-out appended to the JSX expression-start trigger
 * in generateJsxPatterns) scan the same `<…>` span, so they MUST stay mutually
 * inverse — built once, here, from the grammar's own declarations:
 *
 *   • `<` / `>` — the generic delimiters. Confirmed by detectAngleBracketAmbiguity
 *     (which gates on `<`/`>` being prec operators); re-read straight from
 *     `grammar.precs` so the chars come from the grammar, not a literal here.
 *   • `sep` (`,`) — the type-param separator, from `sep(Type, ',')` (carried on the
 *     AngleBracketAmbiguity that this is only built alongside).
 *   • the constraint keyword(s) (`extends`) — the NO-COMMA disambiguating signal, read
 *     off the type-param rule's `opt('extends', Type)` constraint (detectTypeParamConstraintKeywords).
 *     `<T extends X>(…) =>` is a generic arrow with no trailing comma; the keyword is
 *     matched at top level and NOT immediately followed by `=` (to exclude a JSX attr
 *     named `extends`). A grammar whose constraint word differs yields THAT word; one
 *     with no such constraint falls back to the comma-only form (test/agnostic.ts proves it).
 *   • quote chars (`"` / `'`) — the attr-value string delimiters, from the
 *     `string`-flagged token's pattern (same primitive gen-vscode-config uses, so a
 *     `~…~`-string grammar would yield `~`, never a hardcoded `"`).
 *   • `(` `)` — the arrow PARAM-LIST delimiters in the `arrowParamShape` confirm,
 *     from the arrow rule's own `'(' sep(Param,',') ')' … '=>'` (detectArrowParamDelims).
 *     A grammar whose arrow params use a different bracket yields THAT bracket
 *     (test/agnostic.ts proves this with a `⟨…⟩`-param grammar).
 *
 * NOT derived (left as a structural literal — and PROVEN irreducible, see below):
 *   • `{` `}` — the comma-nesting brace skipped inside the `<…>` scan so a comma
 *     inside a `{…}` is not a top-level separator. This is the LAST hardcoded
 *     delimiter, and it was investigated hard (can it be derived from the grammar's
 *     bracket declarations like the parens/quotes are?). The answer is NO, for a
 *     reason deeper than output-byte-identity:
 *
 *     The obvious derivation — "skip the UNION of every declared balanced bracket
 *     pair (`{}`, `[]`, `()`), read off the `punctuation.bracket.*` scopes" — DERIVES
 *     the `{` but is WRONG. Measured against tsc as ground truth (ScriptKind.TSX),
 *     the union makes the highlighter LESS correct, not more: it fixes ZERO cases and
 *     REGRESSES one — `<T = [a, b]>(x: T) => x` (single type-param, tuple default, no
 *     trailing comma), which tsc parses as a generic arrow. The cases one might hope
 *     the union fixes (`<T = [a, b],>`, `<T = (a, b),>` — bracket defaults WITH a
 *     trailing comma) already work WITHOUT it, and the fn-type default
 *     `<T = (a: number) => b,>` is missed by a DIFFERENT mechanism (the `>` inside
 *     `=>` ends `balancedAngles` early), which this skip does not touch.
 *
 *     Why the union regresses: the disambiguation's "top-level comma ⇒ arrow"
 *     heuristic is itself an approximation of tsc's rule (tsc disambiguates a
 *     single-param `<T = X>(…)=>` by the trailing `(…)=>` shape, with no comma
 *     needed). With `[]`/`()` left TRANSPARENT (not in the skip), the scan walks INTO
 *     a bracket default and finds its inner comma, so the heuristic fires
 *     correctly-by-accident for `<T = [a, b]>`. Making `[]`/`()` opaque (the union)
 *     suppresses that inner comma — faithful to the heuristic, but now a valid
 *     generic-arrow is mis-highlighted as JSX. "Balanced bracket" and "bracket that
 *     must be OPAQUE here" are DIFFERENT sets: only `{` belongs to the latter.
 *
 *     And `{` is genuinely the only one that MUST be opaque: the scan terminates on
 *     `<`/`>`, and among the brackets only the JSX expression CONTAINER `{…}` can
 *     appear bare in a tag-open / attribute position AND contain `<`/`>` (e.g.
 *     `a={x > 1 ? y : z}`) — so a container's inner `>` would end the scan early
 *     unless `{…}` is skipped. `(…)`/`[…]` never appear bare there (nested in JSX
 *     they are already inside a `{…}` container), so they must stay transparent.
 *     This positional uniqueness is a fact about the JSX ELEMENT production's shape,
 *     not a property of the bracket pair, so it can't be read off `bracketPairs` —
 *     and identifying "the container rule" structurally needs either a hardcoded
 *     base-rule stoplist (a WORSE hardcode) or a token-keyed reachability that
 *     over-collects in TSX (the tag's `opt('<', sep(Type), '>')` type-args drag in
 *     `Type`'s `()`/`[]`). So the `{` stays a literal — the one irreducible glyph,
 *     skipped as "any single-level `{…}`".
 *   • the arrow-param-shape TAIL `\s*(?: … | \.\.\. | IDENT\s*[:,?] | [{\[] | $)` —
 *     the curated first-token shapes of an arrow parameter list. The parens `(`/`)`
 *     ARE derived (from the arrow rule, see below), but this tail is a deliberately
 *     NARROWED subset of FIRST(Param): the grammar's `Param` rule is shared with
 *     constructors/methods, so its real FIRST set also contains `@`-decorators and
 *     `public`/`private`/`readonly` parameter-property modifiers — forms that are
 *     valid in a constructor but NOT in an arrow. That arrow-only narrowing is a
 *     semantic fact the CFG does not carry, so a faithful FIRST(Param) derivation
 *     would BROADEN this regex; the curated tail stays literal on purpose.
 */
interface JsxDisambigDelims {
  topComma: string;        // top-level-comma scan body: `(?:…opaque…)*,`
  topTypeParam: string;    // "is a type-param list" body: top-level comma OR constraint keyword
  balancedAngles: string;  // recursive balanced `<…>` named group `(?<B>…)`
  arrowParamShape: string; // the arrow-shaped `(` confirm after `>`
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
function detectTypeParamConstraintKeywords(grammar: CstGrammar, typeArgRule: string | null): string[] {
  // The type-param rule is the `sep` element of a `'<' sep(X, ',') '>'` body, EXCEPT
  // the type-argument inner rule (which has the same shape but is a type, not a param
  // declaration). In practice the remaining element is just `TypeParam`.
  const sepElementRules = new Set<string>();
  const scanForTypeParamSep = (items: RuleExpr[]): void => {
    for (let i = 0; i + 2 < items.length; i++) {
      if (items[i].type === 'literal' && (items[i] as { value: string }).value === '<' &&
          items[i + 1].type === 'sep' &&
          items[i + 2].type === 'literal' && (items[i + 2] as { value: string }).value === '>') {
        const sep = items[i + 1] as { type: 'sep'; element: RuleExpr };
        if (sep.element.type === 'ref' && sep.element.name !== typeArgRule) sepElementRules.add(sep.element.name);
      }
    }
  };
  for (const rule of grammar.rules) for (const seq of expandAlts(rule.body)) scanForTypeParamSep(seq);

  // In each such rule, find OPTIONAL `[<word-literal>, <ref>]` pairs — the constraint.
  // The literal must be a WORD (starts with a letter/`_`) so it is `\b`-bounded; a
  // punctuation lead like `=` (the default) is excluded on purpose (see doc above).
  const keywords = new Set<string>();
  const isWord = (s: string) => /^[A-Za-z_]/.test(s);
  const scanConstraint = (expr: RuleExpr): void => {
    if (expr.type === 'quantifier') {
      if (expr.kind === '?' && expr.body.type === 'seq') {
        const its = expr.body.items;
        if (its.length >= 2 && its[0].type === 'literal' && its[1].type === 'ref') {
          const lit = (its[0] as { value: string }).value;
          if (isWord(lit)) keywords.add(lit);
        }
      }
      scanConstraint(expr.body);
    } else if (expr.type === 'seq' || expr.type === 'alt') {
      for (const it of (expr as { items: RuleExpr[] }).items) scanConstraint(it);
    } else if (expr.type === 'group') {
      scanConstraint((expr as { body: RuleExpr }).body);
    }
  };
  for (const rule of grammar.rules) {
    if (sepElementRules.has(rule.name)) scanConstraint(rule.body);
  }
  return [...keywords];
}

function jsxDisambigDelims(grammar: CstGrammar, identRegex: string, separator: string, paramParens: { open: string; close: string } | null, typeArgRule: string | null): JsxDisambigDelims {
  // `<` / `>` from the prec table — the generic delimiters. detectAngleBracketAmbiguity
  // (the only caller's gate) already proved this grammar declares BOTH as prec
  // operators, so reading them back here sources the chars from the grammar's own
  // declarations rather than a literal in this generator. Falls back to the literal
  // pair only if a future caller bypasses that gate (keeps the regex well-formed).
  const precOps = new Set<string>();
  for (const level of grammar.precs) for (const op of level.operators) precOps.add(op.value);
  const [open, close] = precOps.has('<') && precOps.has('>') ? ['<', '>'] : ['<', '>'];
  // Attr-value string delimiters from the `string`-flagged token(s) (e.g. `"`, `'`).
  const quotes = new Set<string>();
  for (const t of grammar.tokens) if (t.string) for (const q of tokenPatternStringDelimiters(t)) quotes.add(q);
  const oc = `${escapeForCharClass(open)}${escapeForCharClass(close)}`;
  // Opaque alternatives in the comma scan: the `{…}` container and each `"…"`/`'…'`
  // attr string are skipped so a comma inside them is not a top-level separator.
  const opaqueStr = [...quotes].map(q => { const e = escapeRegex(q); return `${e}[^${escapeForCharClass(q)}]*${e}`; }).join('|');
  const negClass = `[^${oc}{}${[...quotes].map(escapeForCharClass).join('')}]`;  // none of < > { } " '
  // Shared top-level scan prefix: a run of (plain chars | opaque `{…}` | opaque
  // strings), so a comma / keyword inside a `{…}` container or a `"…"` attr string is
  // not seen as top-level.
  const skip = `(?:${negClass}|\\{[^{}]*\\}${opaqueStr ? '|' + opaqueStr : ''})*`;
  const topComma = `${skip}${escapeRegex(separator)}`;
  // The two NO-COMMA disambiguating signals are the constraint keyword(s) read off
  // the type-param rule (`extends`), matched at top level and — crucially — NOT
  // immediately followed by `=`. `<T extends X>` is a type-param (extends + a type);
  // `<Foo extends={x}>` is a JSX attr named `extends` (extends + `=`). The `(?!=)`
  // after optional whitespace is what tells them apart (verified vs tsc). Each keyword
  // is `\b`-bounded so it doesn't match inside a longer identifier. A grammar with no
  // such constraint keyword yields `topTypeParam === topComma` (comma-only) — output
  // unchanged for those (e.g. the agnostic test's bare `<T,>` generics).
  const constraintKeywords = detectTypeParamConstraintKeywords(grammar, typeArgRule);
  const constraintAlts = constraintKeywords.map(kw => `${skip}\\b${escapeRegex(kw)}\\b\\s*(?!=)`);
  const topTypeParam = constraintAlts.length ? `(?:${topComma}|${constraintAlts.join('|')})` : topComma;
  // Recursive balanced `<…>` (Oniguruma named-group recursion).
  const balancedAngles = `(?<B>[^${oc}]*(?:${escapeRegex(open)}\\g<B>${escapeRegex(close)}[^${oc}]*)*)`;
  // Arrow-shaped param list after `>`: the `(`/`)` are the arrow rule's own param
  // delimiters (detectArrowParamDelims); the tail is the curated first-token shapes
  // (see doc comment for why the parens derive but the tail stays literal). The
  // `close` glyph appears twice — the empty list `( )` and the single-param `(x)`
  // confirm — so both read from the same derived delimiter.
  const [pOpen, pClose] = paramParens ? [paramParens.open, paramParens.close] : ['(', ')'];
  const arrowParamShape = `${escapeRegex(pOpen)}\\s*(?:${escapeRegex(pClose)}|\\.\\.\\.|${identRegex}\\s*[:,?${escapeForCharClass(pClose)}]|[{\\[]|$)`;
  return { topComma, topTypeParam, balancedAngles, arrowParamShape };
}

/**
 * Generate the JSX TextMate repository entries (TypeScriptReact vocabulary).
 *
 * The hard part is the `<` disambiguation: a JSX element's `<` vs comparison
 * `a < b` vs generic `f<T>()`. As in the official TypeScriptReact grammar, JSX
 * is recognised only at an EXPRESSION-START position via a lookbehind: the `<`
 * (with no preceding value operand — not after an identifier / `)` / `]` / a
 * literal, but after `=`, `(`, `,`, `?`, `:`, `=>`, `&&`, `||`, `return`,
 * `yield`, `default`, `(`, `[`, `{`, or line start) followed by a tag-shaped
 * lookahead (`<` then an identifier/`>` then attribute/`>`/`/>`). A comparison's
 * `<` always follows a value operand, so it never matches; a generic call's `<`
 * follows an identifier, so it never matches either. (The `<T>expr` prefix cast
 * doesn't exist in .tsx.)
 *
 * Tag-name scoping mirrors the official: a lowercase intrinsic tag (`div`) →
 * entity.name.tag; an uppercase / dotted component (`Foo`, `Foo.Bar`) →
 * support.class.component. Scopes are namespaced with `langName` like every
 * other emitted scope.
 */
function generateJsxPatterns(langName: string, identRegex: string, jsx: JsxInfo, disambig: JsxDisambigDelims | null, commentKeys: string[] = [], blockCommentPats: string[] = []): Record<string, TmPattern> {
  const result: Record<string, TmPattern> = {};
  // Comment includes (`#linecomment`, `#blockcomment`, … — whatever the grammar
  // named its comment tokens; the keys are DERIVED via commentRepoKeys, never
  // hardcoded). A `//` line or `/* */` block comment is legal inside a JSX open
  // tag between attributes (tsc/ScriptKind.TSX parses `<button\n // hi\n/>` as a
  // JsxSelfClosingElement with the comment skipped — #585). Listed FIRST in the
  // open-tag attribute patterns so a leading `//` is taken as a comment rather
  // than falling through to the tag body as plain `meta.tag` text.
  const commentIncludes: { include: string }[] = commentKeys.map(k => ({ include: `#${k}` }));

  // Scope names (TypeScriptReact vocabulary, namespaced by langName).
  const tagBegin = `punctuation.definition.tag.begin.${langName}`;
  const tagEnd = `punctuation.definition.tag.end.${langName}`;
  const tagNs = `entity.name.tag.namespace.${langName}`;
  const tagNsSep = `punctuation.separator.namespace.${langName}`;
  const intrinsic = `entity.name.tag.${langName}`;
  const component = `support.class.component.${langName}`;
  // A dotted member-expression tag name (`comps.MyComp`, `a.b.C`): the leading
  // qualifier segment(s) are an object/namespace reference, the `.` a member
  // accessor, and the final segment the referenced component. Mirrors how the
  // grammar scopes a value member access `a.b` elsewhere (object identifier +
  // `punctuation.accessor` + member), and resolves #627 — where the official
  // grammar lumps the whole dotted name into one `support.class.component` token,
  // losing that `comps` is a reference and `.` an accessor.
  const tagObject = `variable.other.object.${langName}`;
  const tagAccessor = `punctuation.accessor.${langName}`;
  const attrName = `entity.other.attribute-name.${langName}`;
  const attrNsName = `entity.other.attribute-name.namespace.${langName}`;
  const attrAssign = `keyword.operator.assignment.${langName}`;
  const embeddedBegin = `punctuation.section.embedded.begin.${langName}`;
  const embeddedEnd = `punctuation.section.embedded.end.${langName}`;
  const strBegin = `punctuation.definition.string.begin.${langName}`;
  const strEnd = `punctuation.definition.string.end.${langName}`;
  // Generic type-arguments on a component tag (`<Box<number> …>`): `meta.type.parameters`
  // wrapper with `punctuation.definition.typeparameters.begin/end` delimiters, the
  // same scopes a generic call / declaration type-param list uses elsewhere (#1033).
  const typeParamsMeta = `meta.type.parameters.${langName}`;
  const tpBegin = `punctuation.definition.typeparameters.begin.${langName}`;
  const tpEnd = `punctuation.definition.typeparameters.end.${langName}`;
  // An OPTIONAL balanced `<…>` type-argument group following the tag name, for the
  // expression-position triggers' lookaheads (so `<Box<number> … />` / `<Box<A,B>>…`
  // is recognised as a tag — the type-arg `>` must not be mistaken for the tag's own
  // `>`). Oniguruma balanced-group recursion; the `?` makes it absent for a plain
  // `<div …>`. Emitted only for a TS-family JSX grammar (jsx.typeArgRule set).
  const optTagTypeArgs = jsx.typeArgRule
    ? '(?:\\s*<(?<TA>[^<>]*(?:<\\g<TA>>[^<>]*)*)>)?'
    : '';

  // An open tag is terminated by EITHER a plain `>` (children follow) or the
  // self-close `/>`. Both share their last character — the self-close token (`/>`)
  // is the open terminator (`>`) prefixed by a `/`. Derive both from the grammar's
  // own self-close token rather than hardcoding `>`/`/`: the terminator char is its
  // last char, the self-close prefix is everything before it. `tagEndAhead` is the
  // zero-width "open tag ends here" lookahead `(?=/?>)` (prefix optional → matches a
  // bare `>` or the full `/>`); a grammar whose self-close were spelled differently
  // (e.g. a hypothetical `|>`) would yield that spelling. This lets the open-tag body
  // stop just before the terminator, so the element's `end` can claim a self-close
  // `/>` (no children) while a bare `>` opens the children region instead.
  const tagEndChar = jsx.selfCloseTok.slice(-1);
  const selfClosePrefix = jsx.selfCloseTok.slice(0, -1);
  const tagEndAhead = `(?=${escapeRegex(selfClosePrefix)}?${escapeRegex(tagEndChar)})`;

  // A JSX tag name: optional `ns:` prefix, then a dotted member-expression OR a
  // lowercase-intrinsic OR a (non-dotted) component. Captures, in order:
  //   1 namespace, 2 `:`, 3 dotted-member, 4 intrinsic-name, 5 component-name.
  // The dotted-member alternative `Ident(?:\.Ident)+` is tried FIRST so any name
  // containing a `.` (`comps.MyComp`, `a.b.C`, `Foo.Bar`) is taken as a member
  // expression and re-tokenized (see `nameCaptures`) into object/accessor/
  // component — rather than the lowercase head leaking the rest into attributes
  // (the #627 bug) or the whole dotted name collapsing into one component token.
  // The remaining alternatives keep the original collapse: lowercase-only ⇒
  // intrinsic; anything else ⇒ component. The trailing `(?<!\.|-)` forbids a name
  // ending in a joiner. `[-:]` joiners stay inside intrinsic/component (only `.`
  // forms a member expression).
  const memberNameRe = `${identRegex}(?:\\.${identRegex})+`;     // dotted member
  const nameRe =
    `(?:(${identRegex})(:))?` +                                   // 1 ns, 2 ':'
    `(?:(${memberNameRe})` +                                      // 3 dotted member-expression
    `|([[:lower:]][-[:alnum:]]*)` +                               // 4 intrinsic (lowercase head)
    `|([_$[:upper:]][-_$[:alnum:].]*|${identRegex}(?:[-.][_$[:alnum:]]+)+))` +  // 5 component
    `(?<!\\.|-)`;
  // Re-tokenize the dotted-member capture (#627): each qualifier segment before a
  // `.` is an object reference, each `.` an accessor, the trailing segment the
  // referenced component. (A capture is itself a rule, so it may carry `patterns`.)
  const memberPatterns: TmPattern[] = [
    { match: `${identRegex}(?=\\s*\\.)`, name: tagObject },   // qualifier segment (before a `.`)
    { match: '\\.', name: tagAccessor },                      // member accessor
    { match: identRegex, name: component },                   // referenced component (final segment)
  ];
  const nameCaptures = (base: number): Record<string, TmCapture> => ({
    [String(base)]: { name: tagNs },
    [String(base + 1)]: { name: tagNsSep },
    [String(base + 2)]: { patterns: memberPatterns },   // dotted member: re-tokenized, no wrapper scope
    [String(base + 3)]: { name: intrinsic },
    [String(base + 4)]: { name: component },
  });

  // Generic-arrow carve-out (the inverse of #arrow-type-parameters' begin guard).
  // A `.tsx` generic-arrow type-param list (`<T = X,>(…) =>`, `<const T,>(…) =>`,
  // `<T extends X>(…) =>`) sits in expression position too, so its leading `<` also
  // satisfies the expression-start lookbehind below. Unlike a JSX tag-open, it
  // carries a TOP-LEVEL comma inside `<…>` (treating `{…}` opaquely) OR a top-level
  // constraint keyword (`extends`, the no-comma signal) AND its `>` is followed
  // by an arrow-shaped `(`. We must NOT take such a `<` as JSX. The disambiguation
  // can't be left to pattern order: the expression-start prefix consumes leading
  // whitespace, so after `= <…` the JSX begin's match starts at that space — one
  // offset LEFT of #arrow-type-parameters' `<` — and vscode-textmate always keeps
  // the leftmost match regardless of order. So the carve-out is encoded locally as
  // a negative lookahead (checked at the `<`, after the ws is consumed) that mirrors
  // #arrow-type-parameters' positive guard exactly: same top-level type-param test
  // (comma OR constraint keyword), same balanced-angle + arrow-param-shape confirm.
  // JSX-only by construction (this helper is reached only for a JSX/TSX grammar).
  // Result: after `=`, `const`-value, `return`, etc., the type-param list wins; every
  // genuine JSX tag (no top-level comma / constraint keyword, or no trailing
  // arrow-paren) is untouched.
  // Only a TS-family JSX grammar (one whose `<…>` is also a generic delimiter, so
  // #arrow-type-parameters exists) needs the carve-out. A plain JS `.jsx` grammar
  // has no generics, so `disambig` is null there and the guard stays empty — its
  // output is unchanged. The building-blocks (top-level type-param scan, balanced-angle,
  // arrow-param-shape) are derived from the grammar by jsxDisambigDelims and SHARED
  // with #arrow-type-parameters' positive guard so the two can never drift.
  const notArrowTypeParams = disambig
    ? `(?!<(?=${disambig.topTypeParam})(?=${disambig.balancedAngles}>\\s*${disambig.arrowParamShape}))`
    : '';

  // Expression-start lookbehind (JSX `<` is never preceded by a value operand).
  // Variable-length lookbehind is supported by Oniguruma. After `++`/`--` is
  // excluded (those produce a value). Mirrors the official jsx-tag-in-expression.
  // The lookbehind is ZERO-WIDTH and anchored on the operator/opener BEFORE any
  // leading comment, so the operand-vs-operator test is made at the real operator
  // — `a /**/ <b>` (an operand `a` precedes the comment) is NOT JSX, while
  // `= /**/ <b/>` (an operator precedes) is. (The official anchors on the block-
  // comment CLOSE `*​/` instead, which can't see past the comment to the operator,
  // so it wrongly flips `f /**/ <T>(x)` — a generic call — to a JSX tag.)
  const exprBehind =
    `(?<!\\+\\+|--)(?<=[({\\[,?=:>&|]|&&|\\|\\||=>|\\breturn|\\byield|\\bdefault|\\bcase|^)`;
  // The leading run skipped (inside a lookahead, so zero-width) between the
  // anchoring operator and the tag's `<`: whitespace plus any number of BLOCK
  // comments — a JSX element may legally follow a `/* … */` on the same line
  // (#754; tsc/ScriptKind.TSX parses `= /**/ <X/>` as a JsxSelfClosingElement).
  // The block-comment regexes are DERIVED from the grammar (blockCommentMatchers),
  // never hardcoded; a LINE comment can't precede same-line JSX (it eats to EOL).
  // The comment itself stays for the region's comment includes to scope.
  const leadComments = blockCommentPats.length
    ? `(?:(?:${blockCommentPats.join('|')})\\s*)*`
    : '';
  const leadSkip = `\\s*${leadComments}`;
  // Combined expression-start prefix: anchor on the operator, then (in a zero-width
  // lookahead) skip leading whitespace/comments and apply the generic-arrow
  // carve-out at the `<`. Each region appends its own tag-shaped lookahead body.
  const exprStartLA = (tagBody: string) => `${exprBehind}(?=${leadSkip}${notArrowTypeParams}${tagBody})`;
  // The matching region `end`: closes once the skip-run no longer reaches a tag.
  const exprEndLA = (tagBody: string) => `(?!${leadSkip}${tagBody})`;

  // ── jsx-children: what may appear between `>` and `</` ──
  // Raw text needs no pattern — anything that matches none of these falls through
  // to the enclosing region's `meta.jsx.children` contentName, so arbitrary text
  // punctuation (`It's 100% & more!`) is already covered. The one sub-token the
  // official grammar lifts out of that flat text is an HTML character entity
  // (`&nbsp;`, `&amp;`, `&#123;`, `&#x1F600;`), scoped `constant.character.entity`
  // with `&`/`;` as `punctuation.definition.entity`. A lone `&` (no `name;` tail)
  // matches nothing here and stays plain children text — matching official.
  result['jsx-entity'] = {
    match: '(&)(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*)(;)',
    captures: {
      '1': { name: `punctuation.definition.entity.${langName}` },
      '2': { name: `constant.character.entity.${langName}` },
      '3': { name: `punctuation.definition.entity.${langName}` },
    },
  };
  result['jsx-children'] = {
    patterns: [
      // A child element — `#jsx-element` covers BOTH the self-closing `<br/>` and the
      // open `<span>…</span>` shape (its `end` matches `/>` OR `</name>`), so the
      // separate `#jsx-self-closing-element` is NOT listed here: that rule's begin
      // (`<name`, CONSUMING — unlike `#jsx-element`'s zero-width lookahead begin)
      // would greedily claim a NON-self-closing child `<span>` and, never finding a
      // `/>`, run its region to EOF — mis-scoping the child's `>`, body and the rest
      // of the children as tag text (the top-level `-in-expression` triggers avoid
      // this with a `/>`-anchored lookahead, which can't be reproduced here because a
      // child's `/>` may sit past an embedded `{…}` the lookahead can't scan).
      { include: '#jsx-element' },
      { include: '#jsx-fragment' },
      // A tag whose `<` is alone at end-of-line, its NAME on a following line
      // (#825). In children a lone `<` is unambiguously a tag opener (a bare `<`
      // in JSX children is otherwise invalid — tsc rejects `<div>a < b</div>`),
      // so this multi-line opener can recover the split tag the single-line
      // `(<)\s*name` begins miss. Listed AFTER the single-line elements so a
      // normal `<span …>` on one line keeps its existing tokenization; it only
      // fires when the `<` reaches EOL with no name. See #jsx-element-multiline.
      { include: '#jsx-element-multiline' },
      { include: '#jsx-expression' },
      { include: '#jsx-entity' },
    ],
  };

  // ── jsx-expression: `{ … }` embedded-code container (attr value & children) ──
  result['jsx-expression'] = {
    name: `meta.embedded.expression.${langName}`,
    begin: '\\{',
    beginCaptures: { '0': { name: embeddedBegin } },
    end: '\\}',
    endCaptures: { '0': { name: embeddedEnd } },
    patterns: [{ include: '$self' }],
  };

  // ── jsx-string-*: attribute string values (own scope, no escapes/interp) ──
  for (const [q, key, scope] of [['"', 'jsx-string-double-quoted', 'string.quoted.double'], ["'", 'jsx-string-single-quoted', 'string.quoted.single']] as const) {
    result[key] = {
      name: `${scope}.${langName}`,
      begin: q,
      beginCaptures: { '0': { name: strBegin } },
      end: q,
      endCaptures: { '0': { name: strEnd } },
    };
  }

  // ── jsx-attributes: name (= value)? | spread {…} ──
  // A comment (`//` line / `/* */` block) is legal between attributes inside the
  // open tag, so the grammar's comment entries are included FIRST (#585) — before
  // the attribute-name match, which would otherwise swallow a `//`-led line as
  // tag text.
  result['jsx-attributes'] = {
    patterns: [
      ...commentIncludes,
      // `name` / `ns:name` (with optional namespace) immediately before ws / `=` / `/>` / `>`.
      {
        match: `\\s*(?:(${identRegex})(:))?([_$[:alpha:]][-_$[:alnum:].]*)(?=\\s|=|/?>|$)`,
        captures: {
          '1': { name: attrNsName },
          '2': { name: tagNsSep },
          '3': { name: attrName },
        },
      },
      // `=` assignment (only when a value follows).
      { match: `=(?=\\s*(?:'|"|\\{))`, name: attrAssign },
      { include: '#jsx-string-double-quoted' },
      { include: '#jsx-string-single-quoted' },
      { include: '#jsx-expression' },
    ],
  };

  // ── jsx-tag-type-arguments: `<…>` generic type args on a component tag (#1033) ──
  // A TS-family JSX tag may carry `<List<string>>` between the tag name and its
  // attributes. Inside an open tag a bare `<` can only open this list (attributes
  // never start with `<`), so a `<`/`>` begin/end region is unambiguous here. The
  // inner types reach `#type-inner` (primitives, nested generics, unions, …), so
  // `<number>` → support.type.primitive and `<Map<K,V>>` nests correctly — the
  // same vocabulary the non-JSX generic-call patterns use. Emitted only when the
  // grammar declares tag type-args (jsx.typeArgRule); the `.jsx` base omits them.
  const tagTypeArgsInclude: { include: string }[] = [];
  if (jsx.typeArgRule) {
    result['jsx-tag-type-arguments'] = {
      name: typeParamsMeta,
      begin: '(<)',
      beginCaptures: { '1': { name: tpBegin } },
      end: '(>)',
      endCaptures: { '1': { name: tpEnd } },
      patterns: [{ include: '#type-inner' }],
    };
    tagTypeArgsInclude.push({ include: '#jsx-tag-type-arguments' });
  }

  // ── jsx-self-closing-element: `<Tag …/>` ──
  result['jsx-self-closing-element'] = {
    name: `meta.tag.${langName}`,
    begin: `(<)\\s*${nameRe}`,
    beginCaptures: { '1': { name: tagBegin }, ...nameCaptures(2) },
    end: `(${escapeRegex(jsx.selfCloseTok)})`,
    endCaptures: { '1': { name: tagEnd } },
    // type-args (if any) come right after the name, before attributes.
    patterns: [...tagTypeArgsInclude, { include: '#jsx-attributes' }],
  };

  // ── jsx-element: `<Tag …/>` (self-closing) OR `<Tag …> children </Tag>` ──
  // ONE region covers BOTH shapes (like the official `jsx-tag`), so the self-close-vs-
  // open decision is NOT made by a brittle lookahead at the trigger (which can't see
  // a `>` buried in an attribute value — e.g. the `>` of an arrow `{x => …}` or a
  // string `attr=">"` — and would mis-route such a self-closing tag to the open form,
  // leaving `meta.jsx.children` running to EOF). Instead:
  //   • the open-tag BODY ends at the zero-width `(?=/?>)` lookahead — it stops just
  //     before the terminator without consuming it, so the terminator is decided here;
  //   • the element's `end` matches the self-close `/>` FIRST (closing the whole element,
  //     no children) and the `</…>` close second;
  //   • the children region's begin is the literal `>` (consumed, scoped tag-end). A
  //     self-close's `/>` is claimed by the element `end` before this can fire, so a
  //     self-closing tag never opens a children region.
  result['jsx-element'] = {
    name: `meta.tag.${langName}`,
    begin: `(?=(<)\\s*${nameRe}(?:\\s|/?>|<))`,
    // End on EITHER the self-close `/>` (capture 1) OR the `</name>` close (`</` is
    // capture 2, the name sub-captures 3..7, the `>` capture 8). The closing tag's
    // name is optional (our model doesn't enforce name-match, matching TS treating a
    // mismatch as a semantic — not parse — error). Wrap the whole name in `(?:…)?` so
    // the optional `?` attaches to the group, not to `nameRe`'s trailing `(?<!\.|-)`
    // lookbehind (a quantified zero-width assertion is an invalid Oniguruma regex).
    end: `(${escapeRegex(jsx.selfCloseTok)})|(${escapeRegex(jsx.closeTok)})\\s*(?:${nameRe})?\\s*(>)`,
    endCaptures: {
      '1': { name: tagEnd },   // self-close `/>`
      '2': { name: tagBegin }, // close-tag `</`
      ...nameCaptures(3),      // name sub-captures 3..7 (ns, sep, member, intrinsic, component)
      '8': { name: tagEnd },   // close-tag `>`
    },
    patterns: [
      // open tag: `<Tag …>` — type-args (if any) then attributes, ends (zero-width)
      // just before the terminator so the element `end` decides `/>` vs `>`.
      {
        begin: `(<)\\s*${nameRe}`,
        beginCaptures: { '1': { name: tagBegin }, ...nameCaptures(2) },
        end: tagEndAhead,
        patterns: [...tagTypeArgsInclude, { include: '#jsx-attributes' }],
      },
      // children region — opens on the bare `>` terminator (a self-close `/>` is
      // taken by the element `end` first), runs to the `</…>` close.
      {
        begin: `(${escapeRegex(tagEndChar)})`,
        beginCaptures: { '1': { name: tagEnd } },
        end: `(?=${escapeRegex(jsx.closeTok)})`,
        contentName: `meta.jsx.children.${langName}`,
        patterns: [{ include: '#jsx-children' }],
      },
    ],
  };

  // ── jsx-element-multiline: `<` alone at EOL, tag NAME on a later line (#825) ──
  // The single-line tag-open begins (`(<)\s*name`) can't span the `<`/name line
  // break because a TextMate `begin` regex is matched within ONE tokenizeLine, so
  // its `\s*` never crosses a newline. This region decouples the two: it opens on a
  // lone `<` (one whose only same-line tail is whitespace — `(<)(?=\s*$)`), scoping
  // it `punctuation.definition.tag.begin`, then its INNER patterns — applied
  // per-line while the region stays open — pick up the name (with leading
  // whitespace) when it arrives on a following line, exactly like a single-line
  // open tag's attributes are matched line by line.
  //
  // Children-only and unambiguous: in JSX children a bare `<` is ALWAYS a tag
  // opener (tsc rejects a stray `<` in children — `<div>a < b</div>` is a parse
  // error), so a lone `<` reaching EOL here can only be a split tag-open. The
  // `(?=\s*$)` guard means it fires ONLY when no name follows on the same line, so
  // a normal `<span …>` / self-closing `<br/>` / close `</span>` on one line keep
  // their existing (single-line) tokenization untouched. It lives only inside
  // `#jsx-children`, never at expression-start, so a split comparison `a <\n b` or
  // generic `f<\n T>` outside JSX is never reached.
  //
  // Handles BOTH shapes after the split: a self-closing `<\n name … />` ends at the
  // `/>` (first `end` alternative), and an open `<\n name …> … </name>` runs through
  // an inner open-tag-body (name + type-args + attributes up to `>`) into a children
  // region and ends at the matching `</name>` (second `end` alternative).
  result['jsx-element-multiline'] = {
    name: `meta.tag.${langName}`,
    begin: '(<)(?=\\s*$)',
    beginCaptures: { '1': { name: tagBegin } },
    // End on EITHER the self-close `/>` (self-closing split tag) OR the `</name>`
    // close (open split tag). The self-close alt is first so `/>` wins over a stray
    // `>` interpretation; its capture group is 1, the close-tag groups are 2 (`</`),
    // 3..7 (name sub-captures), 8 (`>`).
    end: `(?:(${escapeRegex(jsx.selfCloseTok)})|(${escapeRegex(jsx.closeTok)})\\s*(?:${nameRe})?\\s*(>))`,
    endCaptures: {
      '1': { name: tagEnd },
      '2': { name: tagBegin },
      ...nameCaptures(3),   // name sub-captures 3..7 (ns, sep, member, intrinsic, component)
      '8': { name: tagEnd },
    },
    patterns: [
      // children region — entered the moment the open tag's `>` has been seen, and
      // listed FIRST so its zero-width `(?<=>)` begin wins at the `>` boundary over
      // the open-tag-body's name match below. This is what stops the name pattern
      // from re-firing on a child word (e.g. `txt` in `<\n span>txt</span>`): once
      // `>` opens this region, matching is confined to `#jsx-children` (which does
      // NOT include the open-tag body), so a bare child word stays `meta.jsx.children`
      // instead of being mis-scoped as a second tag name. Before any `>` this begin
      // can't match (no preceding `>`), so the open-tag body picks up the name first.
      {
        begin: '(?<=>)',
        end: `(?=${escapeRegex(jsx.closeTok)})`,
        contentName: `meta.jsx.children.${langName}`,
        patterns: [{ include: '#jsx-children' }],
      },
      // open-tag body: the NAME (on a later line, leading ws consumed) then
      // type-args / attributes, up to — but not consuming — the `>` or `/>` (the
      // outer `end` closes a self-close `/>`; a plain `>` opens the children above).
      {
        begin: `\\s*${nameRe}`,
        beginCaptures: nameCaptures(1),
        end: `(>)|(?=${escapeRegex(jsx.selfCloseTok)})`,
        endCaptures: { '1': { name: tagEnd } },
        patterns: [...tagTypeArgsInclude, { include: '#jsx-attributes' }],
      },
    ],
  };

  // ── jsx-fragment: `<> children </>` ──
  result['jsx-fragment'] = {
    name: `meta.tag.${langName}`,
    begin: '(<)\\s*(>)',
    beginCaptures: { '1': { name: tagBegin }, '2': { name: tagEnd } },
    end: `(${escapeRegex(jsx.closeTok)})\\s*(>)`,
    endCaptures: { '1': { name: tagBegin }, '2': { name: tagEnd } },
    contentName: `meta.jsx.children.${langName}`,
    patterns: [{ include: '#jsx-children' }],
  };

  // ── Top-level expression-position entries (the disambiguated triggers) ──
  // These wrap the elements with the expression-start lookbehind so a `<` is
  // taken as JSX only where a value can't already be standing (mutually
  // exclusive with comparison / generic-call, whose `<` follows an operand).
  // The lookahead consumes an optional balanced `<…>` type-arg group after the
  // name (`<Box<number> … />`) so its inner `>` isn't mistaken for the tag's `>`,
  // letting the self-closing trigger win over the open-element one (included
  // first) for a self-closing tag that carries type args.
  // Each region's tag-shaped lookahead body (the part after the skip-run, starting
  // at the tag's `<`). Shared by the begin (zero-width, after the operator anchor +
  // ws/comment skip) and the end (closes when the skip-run no longer reaches a tag).
  // `commentIncludes` is prepended to `patterns` so a leading block comment skipped
  // by the lookahead is still scoped (`comment.block`) before #jsx-* takes the tag.
  const selfCloseBody = `(<)\\s*${nameRe}${optTagTypeArgs}[^>]*${escapeRegex(jsx.selfCloseTok)}`;
  result['jsx-self-closing-element-in-expression'] = {
    begin: exprStartLA(selfCloseBody),
    end: exprEndLA(selfCloseBody),
    patterns: [...commentIncludes, { include: '#jsx-self-closing-element' }],
  };
  const elementBody = `(<)\\s*${nameRe}(?:\\s|/?>|<)`;
  result['jsx-element-in-expression'] = {
    begin: exprStartLA(elementBody),
    end: exprEndLA(elementBody),
    patterns: [...commentIncludes, { include: '#jsx-element' }],
  };
  const fragmentBody = `(<)\\s*(>)`;
  result['jsx-fragment-in-expression'] = {
    begin: exprStartLA(fragmentBody),
    end: exprEndLA(fragmentBody),
    patterns: [...commentIncludes, { include: '#jsx-fragment' }],
  };

  return result;
}

// ── Angle bracket disambiguation ──

interface AngleBracketAmbiguity {
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
function detectAngleBracketAmbiguity(grammar: CstGrammar): AngleBracketAmbiguity | null {
  const precOps = new Set<string>();
  for (const level of grammar.precs) {
    for (const op of level.operators) {
      precOps.add(op.value);
    }
  }
  if (!precOps.has('<') || !precOps.has('>')) return null;

  let innerRuleName: string | null = null;
  let separator: string | null = null;
  const confirmTokens: string[] = [];

  // Resolve the leading character from an item after '>'
  function resolveConfirmChar(item: RuleExpr): string | null {
    if (item.type === 'literal') return (item as { value: string }).value;
    if (item.type === 'ref') {
      // If it references a token, extract its leading literal char
      const token = grammar.tokens.find(t => t.name === (item as { name: string }).name);
      if (token) {
        const delimiter = tokenPatternStringDelimiters(token)[0];
        if (delimiter && /^[`'"]/.test(delimiter)) return delimiter[0];
      }
    }
    return null;
  }

  function walkSeq(items: RuleExpr[]) {
    for (let i = 0; i < items.length - 2; i++) {
      if (items[i].type === 'literal' && (items[i] as { value: string }).value === '<' &&
          items[i + 1].type === 'sep' &&
          items[i + 2].type === 'literal' && (items[i + 2] as { value: string }).value === '>') {
        const sep = items[i + 1] as { type: 'sep'; element: RuleExpr; delimiter: string };
        const inner = sep.element.type === 'ref' ? sep.element.name : null;
        if (inner) {
          const nextItem = items[i + 3];
          if (nextItem) {
            const ch = resolveConfirmChar(nextItem);
            if (ch && !confirmTokens.includes(ch)) {
              innerRuleName = inner;
              separator = sep.delimiter;   // the generic type-param list's separator
              confirmTokens.push(ch);
            }
          }
        }
      }
    }
  }

  // Expand opt()/alt() so the confirm token after `>` is visible even when the
  // alternative is written `[$, '<', sep, '>', opt(alt(['(', …], Template))]`.
  for (const rule of grammar.rules) {
    for (const seq of expandAlts(rule.body)) walkSeq(seq);
  }

  if (innerRuleName && confirmTokens.length > 0) {
    return { innerRuleName, confirmTokens, separator: separator ?? ',' };
  }
  return null;
}

/**
 * Build a regex fragment that matches any of the confirm tokens.
 *   ['(']      → \(
 *   ['(', '`'] → [\(\`]
 */
function buildConfirmPattern(tokens: string[]): string {
  if (tokens.length === 1) return escapeRegex(tokens[0]);
  return `[${tokens.map(escapeRegex).join('')}]`;
}

/**
 * Check if a rule has a recursive generic alternative:
 *   Ident '<' sep(Self, ',') '>'
 */
function hasRecursiveGeneric(expr: RuleExpr, selfName: string): boolean {
  if (expr.type === 'alt') {
    return expr.items.some(item => hasRecursiveGeneric(item, selfName));
  }
  if (expr.type === 'seq') {
    for (let i = 0; i < expr.items.length - 2; i++) {
      if (expr.items[i].type === 'literal' && (expr.items[i] as { value: string }).value === '<' &&
          expr.items[i + 1].type === 'sep') {
        const sep = expr.items[i + 1] as { type: 'sep'; element: RuleExpr; delimiter: string };
        if (sep.element.type === 'ref' && sep.element.name === selfName &&
            expr.items[i + 2]?.type === 'literal' && (expr.items[i + 2] as { value: string }).value === '>') {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Build Oniguruma recursive regex for type arguments.
 *
 * From:  Type = Ident | Ident '<' sep(Type, ',') '>'
 * Build: (?<T>IDENT(?:\s*<\s*\g<T>(?:\s*,\s*\g<T>)*\s*>)?)
 */
function buildRecursiveTypeRegex(grammar: CstGrammar, typeName: string, identRegex: string): string {
  const typeRule = grammar.rules.find(r => r.name === typeName);
  if (typeRule && hasRecursiveGeneric(typeRule.body, typeName)) {
    return `(?<T>${identRegex}(?:\\s*<\\s*\\g<T>(?:\\s*,\\s*\\g<T>)*\\s*>)?)`;
  }
  return `(?<T>${identRegex})`;
}

/**
 * Detect an angle-bracket TYPE-ASSERTION (cast) alternative:
 *   '<' <typeRef> '>' <operand>
 * i.e. a literal `<`, then a single ref to a @type rule, then `>`, then a
 * following item (the operand the cast applies to). This is the TS prefix cast
 * `<Type>expr`, distinct from `'<' sep(Type) '>'` generics (whose second item is
 * a `sep`, not a bare ref). Returns the inner type rule name, or null.
 */
function detectAngleBracketCast(grammar: CstGrammar): string | null {
  const typeRuleNameSet = new Set(
    grammar.rules.filter(r => r.flags.includes('type')).map(r => r.name)
  );
  if (typeRuleNameSet.size === 0) return null;

  let found: string | null = null;
  const walkSeq = (items: RuleExpr[]): void => {
    for (let i = 0; i + 3 < items.length; i++) {
      const a = items[i], b = items[i + 1], c = items[i + 2], d = items[i + 3];
      if (a.type === 'literal' && a.value === '<' &&
          b.type === 'ref' && typeRuleNameSet.has(b.name) &&
          c.type === 'literal' && c.value === '>' &&
          d /* an operand follows the cast */) {
        found = b.name;
      }
    }
  };
  for (const rule of grammar.rules) {
    for (const seq of expandAlts(rule.body)) walkSeq(seq);
  }
  return found;
}

/**
 * Generate all TM repository entries for the 5-layer disambiguation.
 *
 * Layer 1: generic-call       — single-line, < types > CONFIRM on same line
 * Layer 2: generic-call-eol   — single-line, < types > at EOL
 * Layer 3: generic-call-multiline — speculative scope, no balanced > on line
 *          + angle-bracket-continuation (nested, for continuation lines)
 * Layer 4: comparison         — flat [<>] as operator
 * Support: generic-type, simple-type — inner type patterns
 */
function generateAngleBracketPatterns(
  ambiguity: AngleBracketAmbiguity,
  grammar: CstGrammar,
  langName: string,
  identRegex: string,
  identToken: TokenDecl | undefined,
): Record<string, TmPattern> {
  // Build recursive type regex
  const typeRegex = buildRecursiveTypeRegex(grammar, ambiguity.innerRuleName, identRegex);
  const confirm = buildConfirmPattern(ambiguity.confirmTokens);

  // Lookbehind: generic '<' must follow identifier / ] / )
  // Derives extra ident chars (e.g. $) from the Ident token IR.
  const lookbehind = buildIdentLookbehind(identToken);

  // Bail-out: expression-only operators (from prec table) that cannot appear
  // in type context.  Derived from @type rule literals plus angle brackets.
  const typeChars = new Set<string>();
  typeChars.add('<');
  typeChars.add('>');
  for (const rule of grammar.rules) {
    if (rule.flags.includes('type')) {
      for (const lit of collectLiterals(rule.body)) {
        if (lit.length === 1 && !/[a-zA-Z]/.test(lit)) {
          typeChars.add(lit);
        }
      }
    }
  }
  const bailoutChars = new Set<string>();
  for (const level of grammar.precs) {
    for (const op of level.operators) {
      if (op.value.length === 1 && !typeChars.has(op.value) && !/[a-zA-Z]/.test(op.value)) {
        bailoutChars.add(op.value);
      }
    }
  }
  // Add statement terminator only if the grammar actually uses it
  if (grammar.rules.some(r => collectLiterals(r.body).includes(';'))) {
    bailoutChars.add(';');
  }
  const bailoutCharset = [...bailoutChars].map(escapeForCharClass).join('');
  const bailout = bailoutCharset ? `(?=[${bailoutCharset}])` : '';

  // Scope names
  const tpBegin = `punctuation.definition.typeparameters.begin.${langName}`;
  const tpEnd = `punctuation.definition.typeparameters.end.${langName}`;
  const typeScope = `entity.name.type.${langName}`;
  const commaScope = `punctuation.separator.comma.${langName}`;
  // A bare `<`/`>` operator (not a type-parameter bracket) is RELATIONAL, the
  // TextMate convention the official grammar uses (`< > <= >=` = relational;
  // `== != === !==` = comparison). Matches official so themes color them alike.
  const relScope = `keyword.operator.relational.${langName}`;
  const angleOpen = `punctuation.bracket.angle.open.${langName}`;

  // All confirmed-generic scopes share type-inner (resolved at tokenize time).
  // No shared mutable array — each entry gets its own single-element patterns list.
  const typeInnerRef = (): (TmPattern | { include: string })[] => [{ include: '#type-inner' }];

  const result: Record<string, TmPattern> = {};

  // ── Layer 1: single-line generic call ──
  result['generic-call'] = {
    name: `meta.generic.${langName}`,
    begin: `${lookbehind}(<)(?=\\s*${typeRegex}\\s*(?:,\\s*\\g<T>)*\\s*>\\s*${confirm})`,
    beginCaptures: { '1': { name: tpBegin } },
    end: '(>)',
    endCaptures: { '1': { name: tpEnd } },
    patterns: typeInnerRef(),
  };

  // ── Layer 2: EOL generic (> at end of line, confirm on next) ──
  result['generic-call-eol'] = {
    name: `meta.generic.${langName}`,
    begin: `${lookbehind}(<)(?=\\s*${typeRegex}\\s*(?:,\\s*\\g<T>)*\\s*>\\s*$)`,
    beginCaptures: { '1': { name: tpBegin } },
    end: '(>)',
    endCaptures: { '1': { name: tpEnd } },
    patterns: typeInnerRef(),
  };

  // ── Layer 3: multiline speculative scope ──
  // Fires when '<' has no balanced '>' on the same line.
  const balanced = '(?<B>[^<>]*(?:<\\g<B>>[^<>]*)*)';
  result['generic-call-multiline'] = {
    name: `meta.angle-brackets.${langName}`,
    begin: `${lookbehind}(<)(?!${balanced}>)`,
    beginCaptures: { '1': { name: angleOpen } },
    end: `(>)(?=\\s*${confirm})|(>)(?=\\s*$)|(>)|${bailout}`,
    endCaptures: {
      '1': { name: tpEnd },
      '2': { name: tpEnd },
      '3': { name: relScope },
    },
    patterns: [
      { include: '#generic-type' },
      { match: `${identRegex}(?=\\s*[,>])`, name: typeScope },
      { match: ',', name: commaScope },
      { include: '#ident' },
      { include: '#angle-bracket-continuation' },
    ],
  };

  // ── Continuation scope (nested in multiline, activates at EOL) ──
  result['angle-bracket-continuation'] = {
    begin: '(?=\\s*$)',
    end: `(?=>)|${bailout}`,
    patterns: [
      { include: '#generic-type' },
      { match: `${identRegex}(?=\\s*[,>]|\\s*$)`, name: typeScope },
      { match: ',', name: commaScope },
      { include: '#ident' },
    ],
  };

  // ── Support: generic-type (begin/end for nested <> inside type args) ──
  result['generic-type'] = {
    name: `meta.type.generic.${langName}`,
    begin: `(${identRegex})(<)`,
    beginCaptures: {
      '1': { name: typeScope },
      '2': { name: tpBegin },
    },
    end: '(>)',
    endCaptures: { '1': { name: tpEnd } },
    patterns: typeInnerRef(),
  };

  // ── Support: simple-type (bare identifier as type name) ──
  result['simple-type'] = {
    match: identRegex,
    name: typeScope,
  };

  // ── Layer 4: flat relational fallback ──
  // A `<`/`>` that survives the generic/JSX/cast layers is a relational operator.
  result['comparison'] = {
    match: '[<>]',
    name: relScope,
  };

  return result;
}

/**
 * Generate the prefix type-assertion (cast) pattern: `<Type>operand`.
 *
 * Disambiguation from a `a < b > c` comparison chain is structural and matches
 * how TS itself parses a prefix cast:
 *   1. The `<` is at an EXPRESSION-START position — NOT preceded by an
 *      identifier / `]` / `)` (those open a generic call or are an operand the
 *      `<` compares against). A bare `<` after `=`, `(`, `,`, `return`, etc.
 *   2. A balanced `<…>` whose inner content is type-shaped (identifiers,
 *      qualified `.`, nested generics, `[]`, union/intersection), beginning with
 *      a type-start char.
 *   3. The `>` is immediately followed by an operand — the value being cast.
 * The inner type is scoped via #type-inner (qualified names, generics, etc.).
 */
function generateTypeCastPattern(
  langName: string,
  identRegex: string,
  operandStart: string,
): TmPattern {
  const tpBegin = `punctuation.definition.typeparameters.begin.${langName}`;
  const tpEnd = `punctuation.definition.typeparameters.end.${langName}`;
  // `<` only at expression-start. A prefix cast's `<` is never preceded by a value
  // OPERAND; a comparison's `<` always is (`a < b`). Reject the cast when `<` is
  // preceded — across bounded whitespace — by an operand-ending char: an identifier
  // char, `)`, `]`, a numeric/quote tail. This keeps `a < b > c`, `f() < g`,
  // `x] < y` as comparisons while staying compatible with TextMate 2.0 Onigmo.
  // Casts after a keyword that ends in a letter (`return <T>x`) stay a comparison
  // here — rare, and never a regression (they were unhighlighted before too).
  const notAfter = notAfterValueWithOptionalWhitespace('\\w$)\\]');
  // Type-shaped, balanced-angle inner content (kept to type characters so an
  // ordinary `a < b > c` comparison — whose operands are arbitrary expressions —
  // is not swallowed). `\g<TC>` recurses for nested generics like `<Array<T>>`.
  const typeChars = '[\\w$.,\\[\\]\\s|&]';
  const typeContent = `(?<TC>${typeChars}*(?:<\\g<TC>>${typeChars}*)*)`;
  // Content must START with a type-start char (identifier / `(` paren-type /
  // `{` object-type / `[` tuple-type) — never a digit or operator.
  const typeStart = `[[:alpha:]_$({\\[]`;
  return {
    name: `meta.cast.expr.${langName}`,
    begin: `${notAfter}(<)(?=\\s*${typeStart}${typeContent}>\\s*${operandStart})`,
    beginCaptures: { '1': { name: tpBegin } },
    end: '(>)',
    endCaptures: { '1': { name: tpEnd } },
    patterns: [{ include: '#type-inner' }],
  };
}

// ── Function call detection ──

/**
 * Detect if any rule has a call-expression pattern: Ref '(' ...
 * This indicates function-call syntax exists and we should highlight
 * identifiers before '(' as entity.name.function.
 */
function detectCallExpression(grammar: CstGrammar): boolean {
  function checkSeq(items: RuleExpr[]): boolean {
    for (let i = 0; i < items.length - 1; i++) {
      if (items[i].type === 'ref' &&
          items[i + 1].type === 'literal' &&
          (items[i + 1] as { value: string }).value === '(') {
        return true;
      }
    }
    return false;
  }

  function walk(expr: RuleExpr): boolean {
    if (expr.type === 'seq') return checkSeq(expr.items) || expr.items.some(walk);
    if (expr.type === 'alt') return expr.items.some(walk);
    if (expr.type === 'quantifier' || expr.type === 'group') return walk(expr.body);
    if (expr.type === 'sep') return walk(expr.element);
    return false;
  }

  return grammar.rules.some(r => walk(r.body));
}

// ── Property access detection ──

/**
 * Detect property access patterns in grammar rules: literal('.') followed by
 * a token ref, and literal('?.') followed by a token ref.
 */
function detectPropertyAccess(
  grammar: CstGrammar,
  tokenNames: Set<string>
): { hasDot: boolean; hasOptionalChain: boolean } {
  let hasDot = false;
  let hasOptionalChain = false;

  function checkSeq(items: RuleExpr[]): void {
    for (let i = 0; i < items.length - 1; i++) {
      if (items[i].type === 'literal' && items[i + 1].type === 'ref') {
        const lit = items[i] as { type: 'literal'; value: string };
        const ref = items[i + 1] as { type: 'ref'; name: string };
        if (tokenNames.has(ref.name)) {
          if (lit.value === '.') hasDot = true;
          if (lit.value === '?.') hasOptionalChain = true;
        }
      }
    }
  }

  function walk(expr: RuleExpr): void {
    if (expr.type === 'seq') { checkSeq(expr.items); expr.items.forEach(walk); }
    if (expr.type === 'alt') expr.items.forEach(walk);
    if (expr.type === 'quantifier' || expr.type === 'group') walk(expr.body);
    if (expr.type === 'sep') walk(expr.element);
  }

  for (const rule of grammar.rules) walk(rule.body);
  return { hasDot, hasOptionalChain };
}

// ── Arrow parameter detection ──

/**
 * Detect `TokenRef '=>'` pattern in grammar rules, indicating bare arrow
 * function syntax like `x => x + 1`. The identifier before `=>` should
 * get variable.parameter scope.
 */
function detectBareArrowParam(grammar: CstGrammar, tokenNames: Set<string>): boolean {
  function checkSeq(items: RuleExpr[]): boolean {
    for (let i = 0; i < items.length - 1; i++) {
      if (items[i].type === 'ref' && tokenNames.has((items[i] as { name: string }).name) &&
          items[i + 1].type === 'literal' &&
          (items[i + 1] as { type: 'literal'; value: string }).value === '=>') {
        return true;
      }
    }
    return false;
  }

  function walk(expr: RuleExpr): boolean {
    if (expr.type === 'seq') return checkSeq(expr.items) || expr.items.some(walk);
    if (expr.type === 'alt') return expr.items.some(walk);
    if (expr.type === 'quantifier' || expr.type === 'group') return walk(expr.body);
    if (expr.type === 'sep') return walk(expr.element);
    return false;
  }

  return grammar.rules.some(r => walk(r.body));
}

/**
 * Detect `'(' sep(Param, ',') ')' '=>'` pattern in grammar rules, indicating
 * parenthesized arrow function syntax like `(x, y) => x + y`.
 */
function detectParenArrowParams(grammar: CstGrammar): boolean {
  function checkSeq(items: RuleExpr[]): boolean {
    for (let i = 0; i < items.length - 3; i++) {
      if (items[i].type === 'literal' && (items[i] as { value: string }).value === '(' &&
          items[i + 2].type === 'literal' && (items[i + 2] as { value: string }).value === ')') {
        // Check if '=>' follows (possibly after optional return type annotation)
        for (let j = i + 3; j < items.length; j++) {
          const item = items[j];
          if (item.type === 'literal' && (item as { value: string }).value === '=>') return true;
          if (item.type === 'literal' && ![':', '?'].includes((item as { value: string }).value)) break;
          if (item.type === 'quantifier' || item.type === 'group') continue;
          if (item.type === 'ref') continue;
        }
      }
    }
    return false;
  }

  function walk(expr: RuleExpr): boolean {
    if (expr.type === 'seq') return checkSeq(expr.items) || expr.items.some(walk);
    if (expr.type === 'alt') return expr.items.some(walk);
    if (expr.type === 'quantifier' || expr.type === 'group') return walk(expr.body);
    if (expr.type === 'sep') return walk(expr.element);
    return false;
  }

  return grammar.rules.some(r => walk(r.body));
}

/**
 * Recover the OPEN/CLOSE delimiter glyphs of the arrow parameter list from the
 * same `'(' sep(Param, ',') ')' … '=>'` shape detectParenArrowParams matches —
 * but returning the two literal glyphs instead of a boolean. The arrow rule
 * (`[opt(async), opt(TypeParams), '(', sep(Param, ','), ')', opt(':',Type), '=>', …]`)
 * is the one grammar declaration that names the arrow param-list delimiters, so
 * the `.tsx` generic-arrow confirm (jsxDisambigDelims' arrowParamShape) reads its
 * `(`/`)` from HERE rather than baking the glyphs in. A grammar whose arrow params
 * use a different bracket therefore yields THAT bracket (test/agnostic.ts proves
 * this with a `⟨…⟩`-param grammar). Returns null only if no arrow rule is found
 * (then the caller keeps the regex well-formed with the literal pair).
 *
 * Shape-identical to detectParenArrowParams on purpose (raw-AST walk, the same
 * `i / i+2 / i+3…'=>'` scan): the two read the same production, so they can never
 * disagree about what the arrow param parens are.
 */
function detectArrowParamDelims(grammar: CstGrammar): { open: string; close: string } | null {
  let found: { open: string; close: string } | null = null;
  function checkSeq(items: RuleExpr[]): boolean {
    for (let i = 0; i < items.length - 3; i++) {
      const open = items[i], close = items[i + 2];
      if (open.type === 'literal' && close.type === 'literal' && items[i + 1].type === 'sep') {
        for (let j = i + 3; j < items.length; j++) {
          const item = items[j];
          if (item.type === 'literal' && (item as { value: string }).value === '=>') {
            found = { open: (open as { value: string }).value, close: (close as { value: string }).value };
            return true;
          }
          if (item.type === 'literal' && ![':', '?'].includes((item as { value: string }).value)) break;
          if (item.type === 'quantifier' || item.type === 'group') continue;
          if (item.type === 'ref') continue;
        }
      }
    }
    return false;
  }
  function walk(expr: RuleExpr): boolean {
    if (expr.type === 'seq') return checkSeq(expr.items) || expr.items.some(walk);
    if (expr.type === 'alt') return expr.items.some(walk);
    if (expr.type === 'quantifier' || expr.type === 'group') return walk(expr.body);
    if (expr.type === 'sep') return walk(expr.element);
    return false;
  }
  grammar.rules.some(r => walk(r.body));
  return found;
}

// ── Ternary expression detection ──

/**
 * Detect if any rule contains a ternary pattern: Expr '?' Expr ':' Expr.
 * Used to generate a begin/end scope for the ternary operator so that
 * '?' gets keyword.operator.ternary and ':' gets keyword.operator.ternary.
 */
function detectTernary(grammar: CstGrammar): boolean {
  function checkSeq(items: RuleExpr[]): boolean {
    for (let i = 0; i < items.length - 4; i++) {
      if (items[i + 1].type === 'literal' && (items[i + 1] as { value: string }).value === '?' &&
          items[i + 3].type === 'literal' && (items[i + 3] as { value: string }).value === ':' &&
          items[i].type === 'ref' && items[i + 2].type === 'ref' && items[i + 4].type === 'ref') {
        return true;
      }
    }
    return false;
  }

  function walk(expr: RuleExpr): boolean {
    if (expr.type === 'seq') return checkSeq(expr.items) || expr.items.some(walk);
    if (expr.type === 'alt') return expr.items.some(walk);
    if (expr.type === 'quantifier' || expr.type === 'group') return walk(expr.body);
    if (expr.type === 'sep') return walk(expr.element);
    return false;
  }

  return grammar.rules.some(r => walk(r.body));
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
 * Mirrors detectTernary's walk, but is gated on a type-flagged rule and a
 * keyword connector between the head/check types — that connector is what
 * distinguishes a conditional `?`/`:` (a ternary) from an OPTIONAL `?`
 * (`{ a?: T }`). The emitted region anchors on the connector so the inner
 * ternary scope only exists inside a conditional.
 */
function detectConditionalType(grammar: CstGrammar): string | null {
  let connector: string | null = null;

  function checkSeq(items: RuleExpr[]): void {
    // window: ref KW ref '?' ref ':' ref  (7 items)
    for (let i = 0; i + 6 < items.length; i++) {
      const kw = items[i + 1];
      const q = items[i + 3];
      const colon = items[i + 5];
      if (items[i].type === 'ref' &&
          kw.type === 'literal' && isKeywordLiteral((kw as { value: string }).value) &&
          items[i + 2].type === 'ref' &&
          q.type === 'literal' && (q as { value: string }).value === '?' &&
          items[i + 4].type === 'ref' &&
          colon.type === 'literal' && (colon as { value: string }).value === ':' &&
          items[i + 6].type === 'ref') {
        connector = (kw as { value: string }).value;
        return;
      }
    }
  }

  function walk(expr: RuleExpr): void {
    if (connector) return;
    if (expr.type === 'seq') { checkSeq(expr.items); expr.items.forEach(walk); }
    else if (expr.type === 'alt') expr.items.forEach(walk);
    else if (expr.type === 'quantifier' || expr.type === 'group') walk(expr.body);
    else if (expr.type === 'sep') walk(expr.element);
  }

  for (const rule of grammar.rules) {
    if (!rule.flags.includes('type')) continue;
    walk(rule.body);
    if (connector) break;
  }
  return connector;
}

// ── Direct-param keyword detection ──

/**
 * Detect keywords directly followed by '(' (no Ident in between) that have
 * a function-related scope. E.g., 'constructor' '(' sep(Param, ',') ')' Block.
 * These need parameter scoping but aren't caught by detectDeclarations
 * (which requires keyword-Ident-body sequences).
 */
function detectDirectParamKeywords(
  grammar: CstGrammar,
  scopeOverrides: Map<string, string[]>
): { keyword: string; keywordScope: string }[] {
  const results: { keyword: string; keywordScope: string }[] = [];
  const seen = new Set<string>();

  function checkSeq(items: RuleExpr[]): void {
    for (let i = 0; i < items.length - 1; i++) {
      if (items[i].type !== 'literal' || items[i + 1].type !== 'literal') continue;
      const kw = (items[i] as { value: string }).value;
      const next = (items[i + 1] as { value: string }).value;
      if (!isKeywordLiteral(kw) || next !== '(' || seen.has(kw)) continue;
      const scope = getScope(scopeOverrides,kw);
      if (scope && scope.startsWith('storage.type.function')) {
        seen.add(kw);
        results.push({ keyword: kw, keywordScope: scope });
      }
    }
  }

  function walk(expr: RuleExpr): void {
    if (expr.type === 'seq') { checkSeq(expr.items); expr.items.forEach(walk); }
    if (expr.type === 'alt') expr.items.forEach(walk);
    if (expr.type === 'quantifier' || expr.type === 'group') walk(expr.body);
  }

  for (const rule of grammar.rules) walk(rule.body);
  return results;
}

// ── Regex literal disambiguation ──

interface RegexLiteralInfo {
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
function detectRegexLiteral(grammar: CstGrammar, tokenNames: Set<string>): RegexLiteralInfo | null {
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

  // Collect keywords that can directly precede expressions
  // Walk rules, find literal-string → Ref(grammar-rule) sequences
  const exprRuleNames = new Set<string>();
  for (const rule of grammar.rules) {
    // Non-token rule names (grammar rules, not tokens)
    if (!tokenNames.has(rule.name)) {
      exprRuleNames.add(rule.name);
    }
  }

  const preceedingKeywords: string[] = [];
  const prefixOps = new Set<string>();

  // Prefix operators from prec table
  for (const level of grammar.precs) {
    for (const op of level.operators) {
      if (op.position === 'prefix' && isKeywordLiteral(op.value)) {
        prefixOps.add(op.value);
      }
    }
  }

  // Unwrap quantifier/group to get the inner ref
  function unwrapRef(expr: RuleExpr): RuleExpr {
    if (expr.type === 'quantifier' || expr.type === 'group') return unwrapRef(expr.body);
    return expr;
  }

  function checkSeq(items: RuleExpr[]) {
    for (let i = 0; i < items.length - 1; i++) {
      const a = items[i];
      const b = unwrapRef(items[i + 1]);
      // keyword Ref → keyword can precede an expression (and thus regex)
      if (a.type === 'literal' && isKeywordLiteral(a.value) &&
          b.type === 'ref' && exprRuleNames.has(b.name) &&
          !preceedingKeywords.includes(a.value)) {
        preceedingKeywords.push(a.value);
      }
    }
  }

  // Walk every expression body, checking each flattened alternative for a
  // keyword→expr-ref adjacency. `expandAlts` resolves `alt`/`opt`/`group` so a
  // keyword tucked inside an alternative (e.g. `alt('in','of') Expr` in a for-head)
  // is seen adjacent to the following ref — without it, only keywords written as a
  // bare literal directly before the ref (`'in' Expr` as an infix op) are collected,
  // so `of` would be missed. `sep`/quantifier inner bodies stay opaque to
  // `expandAlts`, so recurse into them to keep nested adjacencies reachable.
  function walk(expr: RuleExpr) {
    for (const seq of expandAlts(expr)) checkSeq(seq);
    if (expr.type === 'alt' || expr.type === 'seq') expr.items.forEach(walk);
    if (expr.type === 'quantifier' || expr.type === 'group') walk(expr.body);
    if (expr.type === 'sep') walk(expr.element);
  }

  for (const rule of grammar.rules) {
    walk(rule.body);
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

  return { flagsPattern, preceedingKeywords, precedingChars, postfixAmbiguousChars, commentSecondChars, blockComments };
}

/**
 * Generate TM patterns for regex literal disambiguation.
 *
 * Strategy: Use lookbehind to detect "expression start" positions.
 * Regex literals appear after operators, punctuation openers, keywords, and at line start.
 * Division '/' appears after values (identifiers, numbers, ')', ']').
 *
 * Two patterns generated:
 * 1. regex-literal: begin/end with lookbehind for expression-start context
 * 2. The '/' in the operators pattern handles division (already exists)
 */
function generateRegexLiteralPatterns(
  info: RegexLiteralInfo,
  langName: string,
): Record<string, TmPattern> {
  const result: Record<string, TmPattern> = {};

  // Build lookbehind: regex can appear after these contexts
  // Punctuation chars that can precede an expression:
  //   = ( [ { , ; : ! ~ ? | & ^ + - * % <
  // Also after keywords inferred from rules
  // We use alternation of lookbehinds because each has different length

  // Build character lookbehind from grammar-derived preceding chars
  const charEsc = info.precedingChars.map(escapeForCharClass).join('');
  const charLookbehind = charEsc ? `(?<=[${charEsc}])` : '(?<=[=])';

  const keywordLookbehinds = info.preceedingKeywords
    .map(kw => `(?<=\\b${escapeRegex(kw)})`)
    .join('|');

  // Also match at start of line
  const startOfLine = '(?<=^)';

  const lbAlts = [charLookbehind, keywordLookbehinds, startOfLine]
    .filter(Boolean).join('|');
  const fullLookbehind = `(?:${lbAlts})`;

  // Build comment exclusion: after '/' these chars would start a comment
  const commentExclude = info.commentSecondChars.length > 0
    ? `(?![${info.commentSecondChars.map(escapeForCharClass).join('')}])`
    : '';

  // A block comment is transparent to regex-vs-division: `= /**/ /re/` is a
  // regex. The lookbehind anchors on the real context token BEFORE the comment,
  // so consume an optional leading block comment here (scoped as a comment) and
  // then the opening `/`. `#regex-literal` is tried before the comment token
  // patterns, so this wins for `= /**/ /re/` while a value-context comment
  // (`a /**/ / b`) — where the lookbehind fails — still falls through to the
  // comment token + division operator.
  const commentBody = info.blockComments
    .map(c => `${c.begin}[\\s\\S]*?${c.end}`)
    .join('|');
  const commentPrefix = commentBody ? `(?:((?:${commentBody})\\s*))?` : '';
  // The opening-slash capture group index shifts when a comment-prefix group is present.
  const slashGroup = commentBody ? '2' : '1';
  const beginCaptures: Record<string, { name: string }> = {
    [slashGroup]: { name: `punctuation.definition.string.begin.regexp.${langName}` },
  };
  if (commentBody) beginCaptures['1'] = { name: `comment.block.${langName}` };

  // Ambiguous postfix/prefix op chars (TS `!`): a `/` may follow one ONLY when the op-run is
  // the PREFIX form (`= !/re/`, `return !!/x/`), not postfix non-null (`x! / y`). TextMate 2.0's
  // Onigmo rejects the old variable-length lookbehind that looked past the whole op-run, so this
  // separate pattern anchors on the fixed-width expression-start context and consumes the op-run.
  const prefixOpClass = info.postfixAmbiguousChars.map(escapeForCharClass).join('');
  if (prefixOpClass) {
    const prefixSlashGroup = commentBody ? '3' : '2';
    const prefixCaptures: Record<string, { name: string }> = {
      '1': { name: `keyword.operator.logical.prefix.${langName}` },
      [prefixSlashGroup]: { name: `punctuation.definition.string.begin.regexp.${langName}` },
    };
    if (commentBody) prefixCaptures['2'] = { name: `comment.block.${langName}` };
    result['regex-literal-prefix-ops'] = {
      name: `string.regexp.${langName}`,
      begin: `${fullLookbehind}\\s*([${prefixOpClass}](?:\\s*[${prefixOpClass}])*)\\s*${commentPrefix}(/)${commentExclude}`,
      beginCaptures: prefixCaptures,
      end: `(/)(${info.flagsPattern})`,
      endCaptures: {
        '1': { name: `punctuation.definition.string.end.regexp.${langName}` },
        '2': { name: `keyword.other.regexp.${langName}` },
      },
      patterns: [{ include: '#regexp' }],
    };
  }

  result['regex-literal'] = {
    name: `string.regexp.${langName}`,
    begin: `${fullLookbehind}\\s*${commentPrefix}(/)${commentExclude}`,
    beginCaptures,
    end: `(/)(${info.flagsPattern})`,
    endCaptures: {
      '1': { name: `punctuation.definition.string.end.regexp.${langName}` },
      '2': { name: `keyword.other.regexp.${langName}` },
    },
    // The regex BODY is sub-highlighted by the regex-internals sub-grammar
    // (#regexp), which recurses into groups/assertions. A regex body's grammar
    // is universal — independent of the host language — so its scopes carry NO
    // language suffix (the de-facto convention that `*.regexp` syntax scopes are
    // language-neutral terminals, the way the official grammar emits them).
    patterns: [{ include: '#regexp' }],
  };

  // Emit the regex-internals sub-grammar (#regexp + #regex-character-class).
  Object.assign(result, generateRegexInternalPatterns());

  return result;
}

/**
 * Generate the regex-internals sub-grammar — a TM repository fragment that
 * sub-highlights the BODY of a regex literal. It is emitted because the grammar
 * declares a `regex`-flagged token (so the host advertises regex literals); the
 * body grammar itself is the universal ECMAScript-style regex syntax, so the
 * patterns are language-independent and their scopes carry NO language suffix.
 *
 * Two repository entries, mirroring how a hand-written grammar layers this:
 *   #regexp                — anchors (`^ $ \b`), back-references (`\1`, `\k<n>`),
 *                            quantifiers (`* + ? {n,m}`), alternation (`|`),
 *                            assertion groups (`(?=…)`/`(?<=…)`…), capture /
 *                            non-capture / named groups (`(…)`/`(?:…)`/`(?<n>…)`)
 *                            and character-class sets (`[…]`). Groups recurse via
 *                            `#regexp`.
 *   #regex-character-class — single-char escapes/classes shared between the body
 *                            and the inside of a `[…]` set: `\d \w …` classes,
 *                            the `.` wildcard, numeric escapes (`\0nn`/`\xHH`/
 *                            `\uHHHH`), control escapes (`\cX`) and the catch-all
 *                            backslash escape (`\.`).
 */
function generateRegexInternalPatterns(): Record<string, TmPattern> {
  // One escaped numeric code-unit: octal `\0nn`, hex `\xHH`, unicode `\uHHHH`.
  const numericEscape = '\\\\(?:[0-7]{3}|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})';
  // A range endpoint inside `[…]`. The leading endpoint may be `.` (any char);
  // the trailing one excludes `]`/`\` so the class can still close. Capture
  // groups split the escape KINDS so each endpoint escape keeps its own scope.
  const rangeStart = `(?:.|(${numericEscape})|(\\\\c[A-Z])|(\\\\.))`;
  const rangeEnd = `(?:[^\\]\\\\]|(${numericEscape})|(\\\\c[A-Z])|(\\\\.))`;

  // The character-class set `[ … ]` (and negated `[^ … ]`). A range like `a-z`
  // is highlighted whole; anything else falls through to the shared single-char
  // escape patterns (#regex-character-class).
  const characterClassSet: TmPattern = {
    name: 'constant.other.character-class.set.regexp',
    begin: '(\\[)(\\^)?',
    beginCaptures: {
      '1': { name: 'punctuation.definition.character-class.regexp' },
      '2': { name: 'keyword.operator.negation.regexp' },
    },
    end: '(\\])',
    endCaptures: {
      '1': { name: 'punctuation.definition.character-class.regexp' },
    },
    patterns: [
      {
        name: 'constant.other.character-class.range.regexp',
        match: `${rangeStart}\\-${rangeEnd}`,
        captures: {
          '1': { name: 'constant.character.numeric.regexp' },
          '2': { name: 'constant.character.control.regexp' },
          '3': { name: 'constant.character.escape.backslash.regexp' },
          '4': { name: 'constant.character.numeric.regexp' },
          '5': { name: 'constant.character.control.regexp' },
          '6': { name: 'constant.character.escape.backslash.regexp' },
        },
      },
      { include: '#regex-character-class' },
    ],
  };

  const regexp: TmPattern = {
    patterns: [
      // Anchors: \b/\B word boundaries, ^ and $.
      { name: 'keyword.control.anchor.regexp', match: '\\\\[bB]|\\^|\\$' },
      // Back-references: numeric \1.. and named \k<name>.
      {
        match: '\\\\[1-9]\\d*|\\\\k<([a-zA-Z_$][\\w$]*)>',
        captures: {
          '0': { name: 'keyword.other.back-reference.regexp' },
          '1': { name: 'variable.other.regexp' },
        },
      },
      // Quantifiers: ? + * and {n,m}/{n,}/{,m}/{n} with an optional lazy `?`.
      {
        name: 'keyword.operator.quantifier.regexp',
        match: '[?+*]|\\{(\\d+,\\d+|\\d+,|,\\d+|\\d+)\\}\\??',
      },
      // Alternation.
      { name: 'keyword.operator.or.regexp', match: '\\|' },
      // Assertion groups: (?=…) (?!…) (?<=…) (?<!…). Recurses into #regexp.
      {
        name: 'meta.group.assertion.regexp',
        begin: '(\\()((\\?=)|(\\?!)|(\\?<=)|(\\?<!))',
        beginCaptures: {
          '1': { name: 'punctuation.definition.group.regexp' },
          '2': { name: 'punctuation.definition.group.assertion.regexp' },
          '3': { name: 'meta.assertion.look-ahead.regexp' },
          '4': { name: 'meta.assertion.negative-look-ahead.regexp' },
          '5': { name: 'meta.assertion.look-behind.regexp' },
          '6': { name: 'meta.assertion.negative-look-behind.regexp' },
        },
        end: '(\\))',
        endCaptures: { '1': { name: 'punctuation.definition.group.regexp' } },
        patterns: [{ include: '#regexp' }],
      },
      // Capture / non-capture / named groups: (…) (?:…) (?<name>…). Recurses.
      {
        name: 'meta.group.regexp',
        begin: '\\((?:(\\?:)|(?:\\?<([a-zA-Z_$][\\w$]*)>))?',
        beginCaptures: {
          '0': { name: 'punctuation.definition.group.regexp' },
          '1': { name: 'punctuation.definition.group.no-capture.regexp' },
          '2': { name: 'variable.other.regexp' },
        },
        end: '\\)',
        endCaptures: { '0': { name: 'punctuation.definition.group.regexp' } },
        patterns: [{ include: '#regexp' }],
      },
      // Character-class set `[ … ]`.
      characterClassSet,
      // Bare single-char escapes / classes / the `.` wildcard.
      { include: '#regex-character-class' },
    ],
  };

  const regexCharacterClass: TmPattern = {
    patterns: [
      // Built-in character classes (\d \w \s … and negations) plus `.`.
      { name: 'constant.other.character-class.regexp', match: '\\\\[wWsSdDtrnvf]|\\.' },
      // Numeric escapes: octal \0nn, hex \xHH, unicode \uHHHH.
      { name: 'constant.character.numeric.regexp', match: '\\\\([0-7]{3}|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})' },
      // Control escapes: \cX.
      { name: 'constant.character.control.regexp', match: '\\\\c[A-Z]' },
      // Catch-all backslash escape (\n \t \. \/ …).
      { name: 'constant.character.escape.backslash.regexp', match: '\\\\.' },
    ],
  };

  return { regexp, 'regex-character-class': regexCharacterClass };
}

/**
 * Generate a JSDoc-body sub-grammar (driven by a `@embed('jsdoc')` block token).
 *
 * JSDoc is a documentation convention layered ON a host language, not part of any
 * one language's syntax — `/** … *​/` blocks carry the same `@tag`/`{type}` grammar
 * whether they sit above JS, TS, or any other ECMAScript-family source. So the
 * sub-grammar is derived GENERICALLY from the `embed: 'jsdoc'` hint, not hardcoded
 * into a particular grammar: the only host-specific bit is the embedded-source scope
 * suffix (`meta.embedded.block.jsdoc`, `source.embedded.<lang>`), which is woven in
 * from `langName`. The `.jsdoc` scope names themselves are the host-independent
 * vocabulary the construct owns.
 *
 * Produces three repository entries the block-comment region includes via
 * `#docblock`:
 *   - docblock     — block tags (`@param`/`@returns`/`@type`/…), access/symbol-type
 *                    tags, name/type tags, `@example` (embedded source), inline tags
 *   - jsdoctype    — `{ … }` brace type-expressions (`{string}`)
 *   - inline-tags  — `{@link …}` / `{@tutorial …}` inline references
 *
 * Returns the repository entries; the caller wires `#docblock` into the block region
 * and emits the embedded-source content marker. Patterns mirror the official grammar
 * so the derived scopes are drop-in compatible.
 */
function generateJsdocPatterns(langName: string): Record<string, TmPattern> {
  const src = `source.embedded.${langName}`;
  // The full block-tag vocabulary (matched as a bare `storage.type.class.jsdoc`
  // fallback for any recognised tag that the structured patterns above did not
  // already consume). Kept verbatim so an unknown-but-valid tag still highlights.
  const allTags =
    '(?x) (@) (?:abstract|access|alias|api|arg|argument|async|attribute|augments|author|beta|borrows|bubbles ' +
    '|callback|chainable|class|classdesc|code|config|const|constant|constructor|constructs|copyright ' +
    '|default|defaultvalue|define|deprecated|desc|description|dict|emits|enum|event|example|exception ' +
    '|exports?|extends|extension(?:_?for)?|external|externs|file|fileoverview|final|fires|for|func ' +
    '|function|generator|global|hideconstructor|host|ignore|implements|implicitCast|inherit[Dd]oc ' +
    '|inner|instance|interface|internal|kind|lends|license|listens|main|member|memberof!?|method ' +
    '|mixes|mixins?|modifies|module|name|namespace|noalias|nocollapse|nocompile|nosideeffects ' +
    '|override|overview|package|param|polymer(?:Behavior)?|preserve|private|prop|property|protected ' +
    '|public|read[Oo]nly|record|require[ds]|returns?|see|since|static|struct|submodule|summary ' +
    '|suppress|template|this|throws|todo|tutorial|type|typedef|unrestricted|uses|var|variation ' +
    '|version|virtual|writeOnce|yields?) \\b';

  return {
    docblock: {
      patterns: [
        // @access / @api  →  private|protected|public
        {
          match: '(?x)\n((@)(?:access|api))\n\\s+\n(private|protected|public)\n\\b',
          captures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
            '3': { name: 'constant.language.access-type.jsdoc' },
          },
        },
        // @author  →  name <email>
        {
          match:
            '(?x)\n((@)author)\n\\s+\n(\n  [^@\\s<>*/]\n  (?:[^@<>*/]|\\*[^/])*\n)\n(?:\n  \\s*\n  (<)\n  ([^>\\s]+)\n  (>)\n)?',
          captures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
            '3': { name: 'entity.name.type.instance.jsdoc' },
            '4': { name: 'punctuation.definition.bracket.angle.begin.jsdoc' },
            '5': { name: 'constant.other.email.link.underline.jsdoc' },
            '6': { name: 'punctuation.definition.bracket.angle.end.jsdoc' },
          },
        },
        // @borrows <namepath> as <namepath>
        {
          match:
            '(?x)\n((@)borrows) \\s+\n((?:[^@\\s*/]|\\*[^/])+)    # <that namepath>\n\\s+ (as) \\s+              # as\n((?:[^@\\s*/]|\\*[^/])+)    # <this namepath>',
          captures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
            '3': { name: 'entity.name.type.instance.jsdoc' },
            '4': { name: 'keyword.operator.control.jsdoc' },
            '5': { name: 'entity.name.type.instance.jsdoc' },
          },
        },
        // @example  →  embedded source until the next tag / end of comment
        {
          name: 'meta.example.jsdoc',
          begin: '((@)example)\\s+',
          end: '(?=@|\\*/)',
          beginCaptures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
          },
          patterns: [
            { match: '^\\s\\*\\s+' },
            {
              contentName: 'constant.other.description.jsdoc',
              begin: '\\G(<)caption(>)',
              beginCaptures: {
                '0': { name: 'entity.name.tag.inline.jsdoc' },
                '1': { name: 'punctuation.definition.bracket.angle.begin.jsdoc' },
                '2': { name: 'punctuation.definition.bracket.angle.end.jsdoc' },
              },
              end: '(</)caption(>)|(?=\\*/)',
              endCaptures: {
                '0': { name: 'entity.name.tag.inline.jsdoc' },
                '1': { name: 'punctuation.definition.bracket.angle.begin.jsdoc' },
                '2': { name: 'punctuation.definition.bracket.angle.end.jsdoc' },
              },
            },
            { match: '[^\\s@*](?:[^*]|\\*[^/])*', captures: { '0': { name: src } } },
          ],
        },
        // @kind  →  class|constant|event|…
        {
          match:
            '(?x) ((@)kind) \\s+ (class|constant|event|external|file|function|member|mixin|module|namespace|typedef) \\b',
          captures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
            '3': { name: 'constant.language.symbol-type.jsdoc' },
          },
        },
        // @see  →  URL | namepath
        {
          match:
            '(?x)\n((@)see)\n\\s+\n(?:\n  # URL\n  (\n    (?=https?://)\n    (?:[^\\s*]|\\*[^/])+\n  )\n  |\n  # JSDoc namepath\n  (\n    (?!\n      # Avoid matching bare URIs (also acceptable as links)\n      https?://\n      |\n      # Avoid matching {@inline tags}; we match those below\n      (?:\\[[^\\[\\]]*\\])? # Possible description [preceding]{@tag}\n      {@(?:link|linkcode|linkplain|tutorial)\\b\n    )\n    # Matched namepath\n    (?:[^@\\s*/]|\\*[^/])+\n  )\n)',
          captures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
            '3': { name: 'variable.other.link.underline.jsdoc' },
            '4': { name: 'entity.name.type.instance.jsdoc' },
          },
        },
        // @template [Name=Default]  →  TS-flavored default type-parameter
        // (microsoft/TypeScript-TmLanguage#994). The square-bracket form starts
        // with `[`, so the identifier-list / brace patterns below never match it;
        // the official VS Code TS grammar lacks this case entirely and leaves the
        // whole `[Name=Default]` as bare comment text. Mirror the `@param
        // [opt=default]` bracket scopes; color the declared param NAME (and its
        // default) as a type name — beating the official, which colors neither.
        {
          match:
            '(?x)\n((@)template)\n\\s+\n(\\[)\\s*\n(                                  # 4: the declared type-parameter name\n  [A-Za-z_$][\\w$]*\n)\n(?:\n  \\s* (=) \\s*                      # 5: the `=` of the default\n  (                                # 6: the default type expression\n    (?>\n      "(?:\\*(?!/)|\\\\(?!")|[^*\\\\])*?" |\n      \'(?:\\*(?!/)|\\\\(?!\')|[^*\\\\])*?\' |\n      \\[ (?:\\*(?!/)|[^*])*? \\] |\n      (?:\\*(?!/)|\\s(?!\\s*\\])|[^*\\s\\[\\]])\n    )*\n  )\n)?\n\\s* (\\])',
          captures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
            '3': { name: 'punctuation.definition.optional-value.begin.bracket.square.jsdoc' },
            '4': { name: 'entity.name.type.jsdoc' },
            '5': { name: 'keyword.operator.assignment.jsdoc' },
            '6': { name: 'entity.name.type.jsdoc' },
            '7': { name: 'punctuation.definition.optional-value.end.bracket.square.jsdoc' },
          },
        },
        // @template  →  identifier list (no brace)
        {
          match:
            '(?x)\n((@)template)\n\\s+\n# One or more valid identifiers\n(\n  [A-Za-z_$]         # First character: non-numeric word character\n  [\\w$.\\[\\]]*        # Rest of identifier\n  (?:                # Possible list of additional identifiers\n    \\s* , \\s*\n    [A-Za-z_$]\n    [\\w$.\\[\\]]*\n  )*\n)',
          captures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
            '3': { name: 'variable.other.jsdoc' },
          },
        },
        // @template {Type} — brace constraint
        {
          begin: '(?x)((@)template)\\s+(?={)',
          beginCaptures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
          },
          end: '(?=\\s|\\*/|[^{}\\[\\]A-Za-z_$])',
          patterns: [
            { include: '#jsdoctype' },
            { name: 'variable.other.jsdoc', match: '([A-Za-z_$][\\w$.\\[\\]]*)' },
          ],
        },
        // @param/@arg/@member/… name  (no brace type)
        {
          match:
            '(?x)\n(\n  (@)\n  (?:arg|argument|const|constant|member|namespace|param|var)\n)\n\\s+\n(\n  [A-Za-z_$]\n  [\\w$.\\[\\]]*\n)',
          captures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
            '3': { name: 'variable.other.jsdoc' },
          },
        },
        // @typedef {Type} Name
        {
          begin: '((@)typedef)\\s+(?={)',
          beginCaptures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
          },
          end: '(?=\\s|\\*/|[^{}\\[\\]A-Za-z_$])',
          patterns: [
            { include: '#jsdoctype' },
            { name: 'entity.name.type.instance.jsdoc', match: '(?:[^@\\s*/]|\\*[^/])+' },
          ],
        },
        // @param {Type} name  (brace type + name, with [optional=default] form)
        {
          begin:
            '((@)(?:arg|argument|const|constant|member|namespace|param|prop|property|var))\\s+(?={)',
          beginCaptures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
          },
          end: '(?=\\s|\\*/|[^{}\\[\\]A-Za-z_$])',
          patterns: [
            { include: '#jsdoctype' },
            { name: 'variable.other.jsdoc', match: '([A-Za-z_$][\\w$.\\[\\]]*)' },
            {
              name: 'variable.other.jsdoc',
              match:
                '(?x)\n(\\[)\\s*\n[\\w$]+\n(?:\n  (?:\\[\\])?                                        # Foo[ ].bar properties within an array\n  \\.                                                # Foo.Bar namespaced parameter\n  [\\w$]+\n)*\n(?:\n  \\s*\n  (=)                                                # [foo=bar] Default parameter value\n  \\s*\n  (\n    # The inner regexes are to stop the match early at */ and to not stop at escaped quotes\n    (?>\n      "(?:(?:\\*(?!/))|(?:\\\\(?!"))|[^*\\\\])*?" |                      # [foo="bar"] Double-quoted\n      \'(?:(?:\\*(?!/))|(?:\\\\(?!\'))|[^*\\\\])*?\' |                      # [foo=\'bar\'] Single-quoted\n      \\[ (?:(?:\\*(?!/))|[^*])*? \\] |                                # [foo=[1,2]] Array literal\n      (?:(?:\\*(?!/))|\\s(?!\\s*\\])|\\[.*?(?:\\]|(?=\\*/))|[^*\\s\\[\\]])*   # Everything else\n    )*\n  )\n)?\n\\s*(?:(\\])((?:[^*\\s]|\\*[^\\s/])+)?|(?=\\*/))',
              captures: {
                '1': { name: 'punctuation.definition.optional-value.begin.bracket.square.jsdoc' },
                '2': { name: 'keyword.operator.assignment.jsdoc' },
                '3': { name: src },
                '4': { name: 'punctuation.definition.optional-value.end.bracket.square.jsdoc' },
                '5': { name: 'invalid.illegal.syntax.jsdoc' },
              },
            },
          ],
        },
        // @type/@returns/@throws/… {Type}  — brace type only
        {
          begin:
            '(?x)\n(\n  (@)\n  (?:define|enum|exception|export|extends|lends|implements|modifies\n  |namespace|private|protected|returns?|satisfies|suppress|this|throws|type\n  |yields?)\n)\n\\s+(?={)',
          beginCaptures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
          },
          end: '(?=\\s|\\*/|[^{}\\[\\]A-Za-z_$])',
          patterns: [{ include: '#jsdoctype' }],
        },
        // @alias/@augments/@extends/… <namepath>  (no brace)
        {
          match:
            '(?x)\n(\n  (@)\n  (?:alias|augments|callback|constructs|emits|event|fires|exports?\n  |extends|external|function|func|host|lends|listens|interface|memberof!?\n  |method|module|mixes|mixin|name|requires|see|this|typedef|uses)\n)\n\\s+\n(\n  (?:\n    [^{}@\\s*] | \\*[^/]\n  )+\n)',
          captures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
            '3': { name: 'entity.name.type.instance.jsdoc' },
          },
        },
        // @default/@license/@version  →  quoted string value
        {
          contentName: 'variable.other.jsdoc',
          begin: '((@)(?:default(?:value)?|license|version))\\s+(([\'\'"]))',
          beginCaptures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
            '3': { name: 'variable.other.jsdoc' },
            '4': { name: 'punctuation.definition.string.begin.jsdoc' },
          },
          end: '(\\3)|(?=$|\\*/)',
          endCaptures: {
            '0': { name: 'variable.other.jsdoc' },
            '1': { name: 'punctuation.definition.string.end.jsdoc' },
          },
        },
        // @default/@license/@version  →  bare value
        {
          match:
            '((@)(?:default(?:value)?|license|tutorial|variation|version))\\s+([^\\s*]+)',
          captures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
            '3': { name: 'variable.other.jsdoc' },
          },
        },
        // Any recognised tag name (bare) — fallback so the keyword still colors.
        {
          name: 'storage.type.class.jsdoc',
          match: allTags,
          captures: { '1': { name: 'punctuation.definition.block.tag.jsdoc' } },
        },
        // Inline `{@link …}` references anywhere in the body.
        { include: '#inline-tags' },
        // Unknown `@foo` tag followed by whitespace.
        {
          match: '((@)(?:[_$[:alpha:]][_$[:alnum:]]*))(?=\\s+)',
          captures: {
            '1': { name: 'storage.type.class.jsdoc' },
            '2': { name: 'punctuation.definition.block.tag.jsdoc' },
          },
        },
      ],
    },

    // `{ Type }` brace type-expression — the curly delimiters + the inner type.
    jsdoctype: {
      patterns: [
        {
          contentName: 'entity.name.type.instance.jsdoc',
          begin: '\\G({)',
          beginCaptures: {
            '0': { name: 'entity.name.type.instance.jsdoc' },
            '1': { name: 'punctuation.definition.bracket.curly.begin.jsdoc' },
          },
          end: '((}))\\s*|(?=\\*/)',
          endCaptures: {
            '1': { name: 'entity.name.type.instance.jsdoc' },
            '2': { name: 'punctuation.definition.bracket.curly.end.jsdoc' },
          },
          patterns: [{ include: '#brackets' }],
        },
      ],
    },

    // Inline `{@link …}` / `{@tutorial …}` references.
    'inline-tags': {
      patterns: [
        {
          name: 'constant.other.description.jsdoc',
          match:
            '(\\[)[^\\]]+(\\])(?={@(?:link|linkcode|linkplain|tutorial))',
          captures: {
            '1': { name: 'punctuation.definition.bracket.square.begin.jsdoc' },
            '2': { name: 'punctuation.definition.bracket.square.end.jsdoc' },
          },
        },
        {
          name: 'entity.name.type.instance.jsdoc',
          begin: '({)((@)(?:link(?:code|plain)?|tutorial))\\s*',
          beginCaptures: {
            '1': { name: 'punctuation.definition.bracket.curly.begin.jsdoc' },
            '2': { name: 'storage.type.class.jsdoc' },
            '3': { name: 'punctuation.definition.inline.tag.jsdoc' },
          },
          end: '}|(?=\\*/)',
          endCaptures: { '0': { name: 'punctuation.definition.bracket.curly.end.jsdoc' } },
          patterns: [
            {
              match: '\\G((?=https?://)(?:[^|}\\s*]|\\*[/])+)(\\|)?',
              captures: {
                '1': { name: 'variable.other.link.underline.jsdoc' },
                '2': { name: 'punctuation.separator.pipe.jsdoc' },
              },
            },
            {
              match: '\\G((?:[^{}@\\s|*]|\\*[^/])+)(\\|)?',
              captures: {
                '1': { name: 'variable.other.description.jsdoc' },
                '2': { name: 'punctuation.separator.pipe.jsdoc' },
              },
            },
          ],
        },
      ],
    },

    // `{ … }` brace-type body: nested brackets, kept shallow (matches the official
    // `#brackets` helper used inside `jsdoctype`).
    brackets: {
      patterns: [
        {
          begin: '{',
          beginCaptures: { '0': { name: 'punctuation.definition.bracket.curly.begin.jsdoc' } },
          end: '}|(?=\\*/)',
          endCaptures: { '0': { name: 'punctuation.definition.bracket.curly.end.jsdoc' } },
          patterns: [{ include: '#brackets' }],
        },
        {
          begin: '\\[',
          beginCaptures: { '0': { name: 'punctuation.definition.bracket.square.begin.jsdoc' } },
          end: '\\]|(?=\\*/)',
          endCaptures: { '0': { name: 'punctuation.definition.bracket.square.end.jsdoc' } },
          patterns: [{ include: '#brackets' }],
        },
      ],
    },
  };
}

// ── Declaration pattern detection ──

interface DeclInfo {
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

function isAngleBracketSepRule(body: RuleExpr): boolean {
  if (body.type !== 'seq' || body.items.length !== 3) return false;
  const [first, second, third] = body.items;
  return first.type === 'literal' && first.value === '<' &&
         second.type === 'sep' && second.delimiter === ',' &&
         third.type === 'literal' && third.value === '>';
}

function getTypeParamElementKeywords(body: RuleExpr, grammar: CstGrammar): string[] {
  if (body.type !== 'seq' || body.items.length !== 3) return [];
  const sep = body.items[1];
  if (sep.type !== 'sep') return [];
  let elementBody: RuleExpr = sep.element;
  if (elementBody.type === 'ref') {
    const rule = grammar.rules.find(r => r.name === (elementBody as { name: string }).name);
    if (rule) elementBody = rule.body;
  }
  const keywords: string[] = [];
  function walk(e: RuleExpr) {
    if (e.type === 'literal' && isKeywordLiteral(e.value)) keywords.push(e.value);
    if (e.type === 'seq' || e.type === 'alt') e.items.forEach(walk);
    if (e.type === 'quantifier' || e.type === 'group') walk(e.body);
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
 */
function detectDeclarations(grammar: CstGrammar, tokenNames: Set<string>): DeclInfo[] {
  const results: DeclInfo[] = [];

  function isBlockRule(name: string): boolean {
    const rule = grammar.rules.find(r => r.name === name);
    if (!rule) return false;
    const body = rule.body;
    if (body.type === 'seq' && body.items.length >= 2) {
      return body.items[0].type === 'literal' && (body.items[0] as { value: string }).value === '{' &&
             body.items[body.items.length - 1].type === 'literal' &&
             (body.items[body.items.length - 1] as { value: string }).value === '}';
    }
    return false;
  }

  function containsLiteral(expr: RuleExpr, value: string): boolean {
    if (expr.type === 'literal') return expr.value === value;
    if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(i => containsLiteral(i, value));
    if (expr.type === 'quantifier' || expr.type === 'group') return containsLiteral(expr.body, value);
    if (expr.type === 'sep') return containsLiteral(expr.element, value);
    return false;
  }

  function containsBlockRef(expr: RuleExpr): boolean {
    if (expr.type === 'ref') return isBlockRule(expr.name);
    if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(containsBlockRef);
    if (expr.type === 'quantifier' || expr.type === 'group') return containsBlockRef(expr.body);
    return false;
  }

  function analyzeSeq(items: RuleExpr[]) {
    if (items.length < 2) return;
    if (items[0]?.type !== 'literal' || !isKeywordLiteral((items[0] as { value: string }).value)) return;

    // Find the Ident (token ref) — may be items[1] directly, or after
    // intervening non-alphabetic literals (e.g., 'function' '*' Ident).
    let nameIdx = 1;
    while (nameIdx < items.length) {
      const item = items[nameIdx];
      if (item.type === 'ref' && tokenNames.has(item.name)) break;
      if (item.type === 'literal' && !isKeywordLiteral((item as { value: string }).value)) {
        nameIdx++;
        continue;
      }
      // Zero-width guards (`not(...)` / `sameLine` / `noCommentBefore` / `noMultilineFlowBefore`)
      // consume no token, so they can sit between the keyword and the name (e.g. `'type' not(reserved)
      // Ident`) without changing the `keyword name` highlight pattern — skip past them.
      if (item.type === 'not' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore') {
        nameIdx++;
        continue;
      }
      return; // unexpected item type — not a declaration pattern
    }
    if (nameIdx >= items.length) return;

    const keyword = (items[0] as { value: string }).value;

    // Collect non-alphabetic literals between keyword and name (e.g., '*' in function*)
    const midLits: string[] = [];
    for (let m = 1; m < nameIdx; m++) {
      if (items[m].type === 'literal') midLits.push((items[m] as { value: string }).value);
    }

    const nameScope = inferIdentScope(keyword, grammar.scopeOverrides);
    if (!nameScope) return;

    // Dotted EntityName: the name is immediately followed by a `('.' Ident)*`
    // repetition (e.g. `namespace A.B.C { … }`, `module A.B { … }`). The whole
    // dotted path names the declaration, so the trailing segments must read as
    // the name scope — not fall through to value member-access. expandAlts() has
    // already flattened the `*` quantifier to a single occurrence here, so the
    // tail surfaces as the literal `.` + Ident token-ref pair directly.
    const dot = items[nameIdx + 1];
    const seg = items[nameIdx + 2];
    const qualifiedName =
      !!dot && dot.type === 'literal' && (dot as { value: string }).value === '.' &&
      !!seg && seg.type === 'ref' && tokenNames.has((seg as { name: string }).name);

    const hasInlineBraces = items.some(i => i.type === 'literal' && (i as { value: string }).value === '{');
    const hasBlockRef = items.some(i => containsBlockRef(i));
    const hasBody = hasInlineBraces || hasBlockRef;

    let hasTypeParams = false;
    let typeParamKeywords: string[] = [];
    let endHint: string | undefined;
    for (let i = nameIdx + 1; i < items.length; i++) {
      const item = items[i];
      let refName: string | null = null;
      if (item.type === 'ref' && !tokenNames.has(item.name)) refName = item.name;
      if (item.type === 'quantifier' && item.body.type === 'ref' && !tokenNames.has(item.body.name)) {
        refName = item.body.name;
      }
      if (refName) {
        const rule = grammar.rules.find(r => r.name === refName);
        if (rule && isAngleBracketSepRule(rule.body)) {
          hasTypeParams = true;
          typeParamKeywords = getTypeParamElementKeywords(rule.body, grammar);
          if (!hasBody) {
            for (let j = i + 1; j < items.length; j++) {
              if (items[j].type === 'literal') {
                endHint = (items[j] as { value: string }).value;
                break;
              }
            }
          }
          break;
        }
      }
      if (item.type === 'literal') break;
    }

    const hasParams = items.some(i =>
      (i.type === 'literal' && (i as { value: string }).value === '(') || containsLiteral(i, '(')
    );

    // The same declaration keyword may surface across several expanded sequences
    // (e.g. async/`*`/typeParams present or absent). Merge into the existing
    // DeclInfo, OR-ing flags so no detail is lost regardless of expansion order.
    const existing = results.find(r => r.keyword === keyword);
    if (existing) {
      // A body-having expansion meeting a body-less one (or vice versa) for the same
      // keyword ⇒ the body is optional (`function f(){}` AND overload `function f();`).
      if (existing.hasBody !== hasBody && hasParams && existing.hasParams) existing.optionalBody = true;
      existing.hasBody = existing.hasBody || hasBody;
      existing.hasParams = existing.hasParams || hasParams;
      if (hasTypeParams && !existing.hasTypeParams) {
        existing.hasTypeParams = true;
        existing.typeParamKeywords = typeParamKeywords;
      }
      if (!existing.endHint && endHint) existing.endHint = endHint;
      for (const lit of midLits) {
        if (!existing.midLiterals.includes(lit)) existing.midLiterals.push(lit);
      }
      existing.qualifiedName = existing.qualifiedName || qualifiedName;
      return;
    }

    if (!hasBody && !hasTypeParams) return;

    results.push({
      keyword,
      nameScope,
      keywordScope: getScope(grammar.scopeOverrides, keyword) ?? `storage.type.${keyword}`,
      hasParams,
      hasTypeParams,
      hasBody,
      optionalBody: false,
      typeParamKeywords,
      endHint,
      midLiterals: midLits,
      qualifiedName,
    });
  }

  // Expand opt()/alt() so a DRY declaration like
  // `[opt('async'),'function',opt('*'),Ident,...]` is seen in its concrete forms
  // (the all-optionals-absent branch yields the same shape as a hand-written one).
  for (const rule of grammar.rules) {
    for (const seq of expandAlts(rule.body)) analyzeSeq(seq);
  }

  return results;
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
function detectFold(grammar: CstGrammar): { hasDeeper: boolean; hasSameColumn: boolean } | null {
  if (!grammar.indent) return null;
  const { indentToken, newlineToken } = grammar.indent;
  const leafNames = new Set(grammar.tokens.filter(t => t.blockPattern && t.scope).map(t => t.name));
  if (!leafNames.size) return null;
  const refsLeaf = (e: RuleExpr): boolean =>
    e.type === 'ref' ? leafNames.has(e.name)
    : e.type === 'seq' || e.type === 'alt' ? e.items.some(refsLeaf)
    : e.type === 'quantifier' || e.type === 'group' || e.type === 'not' ? refsLeaf(e.body)
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
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') visit(e.body);
    else if (e.type === 'sep') visit(e.element);
  };
  for (const r of grammar.rules) visit(r.body);
  return (hasDeeper || hasSameColumn) ? { hasDeeper, hasSameColumn } : null;
}

function detectExplicitKey(grammar: CstGrammar): { indicator: string; keyScope: string; keyBody: string; prefixGroups: { scope: string; pattern: string }[] } | null {
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
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') visit(e.body);
    else if (e.type === 'sep') visit(e.element);
  };
  for (const r of grammar.rules) visit(r.body);
  if (!indicator || !separator) return null;
  const sep: string = separator;

  // KEY token = a plain-scalar token PLUS a trailing key-separator lookahead. The key token
  // supplies the scope; the body before its final lookahead supplies the emitted key body.
  let keyScope: string | null = null;
  let keyBody: string | null = null;
  for (const k of grammar.tokens) {
    if (!k.scope || k.string) continue;
    const keyShape = tokenPatternPrefixBeforeTrailingLookahead(k);
    if (!keyShape || !tokenPatternNodeContainsLiteral(keyShape.lookahead, sep)) continue;
    const plain = grammar.tokens.find(t => t !== k && tokenPatternEqualsPattern(t, keyShape.body));
    if (plain) { keyScope = k.scope; keyBody = keyShape.bodySource; break; }
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
    : e.type === 'quantifier' || e.type === 'group' || e.type === 'not' ? containsAlt(e.body)
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
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') findPrefix(e.body);
    else if (e.type === 'sep') findPrefix(e.element);
  };
  for (const r of grammar.rules) findPrefix(r.body);
  const prefixGroups = [...prefixByScope].map(([scope, pats]) => ({ scope, pattern: [...pats].join('|') }));
  return { indicator, keyScope, keyBody, prefixGroups };
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
interface FlowColl { open: string; close: string; sep: string; colon: string | null; punct: { begin: string; end: string; separator: string } | null; }
function detectFlowCollections(grammar: CstGrammar): {
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
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') allRefs(e.body, out);
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

// ── Constructor-call keyword detection ──

function detectConstructorKeywords(
  grammar: CstGrammar,
  tokenNames: Set<string>,
  scopeOverrides: Map<string, string[]>
): string[] {
  const keywords: string[] = [];
  const seen = new Set<string>();

  function checkSeq(items: RuleExpr[]) {
    for (let i = 0; i < items.length - 2; i++) {
      const a = items[i];
      if (a.type !== 'literal') continue;
      if (!isKeywordLiteral(a.value) || seen.has(a.value)) continue;
      const b = items[i + 1];
      if (b.type !== 'ref') continue;
      if (tokenNames.has(b.name)) continue;
      for (let j = i + 2; j < items.length; j++) {
        if (items[j].type === 'literal' && (items[j] as { value: string }).value === '(') {
          const scope = getScope(scopeOverrides, a.value);
          if (scope && scope.startsWith('keyword.operator.expression')) {
            seen.add(a.value);
            keywords.push(a.value);
          }
          break;
        }
      }
    }
  }

  // Expand opt()/alt() so `new NewTarget (…)` is seen even when the call args
  // are folded into `opt(alt(['<'…], ['('…]))`.
  for (const rule of grammar.rules) {
    for (const seq of expandAlts(rule.body)) checkSeq(seq);
  }

  return keywords;
}

// ── Generator ──

// Patterns that embed a quoted attribute VALUE as an expression/source grammar, BOUNDED to the
// quoted span. SHARED by Vue directive values (`:x="e as T"`, `@click="…"`) and plain-HTML embed
// attributes (`on*="…"`→source.js). The per-quote form is a CAPTURE-embed (group 3 = the value),
// whose text range the embedded grammar physically cannot cross — so an `as`-cast type context
// can't run past the closing quote and swallow the rest of the tag (vuejs/language-tools#5012),
// and a derived JS grammar keeps a `//` inside a string a string, not a comment (html.tmbundle#113).
// The trailing begin/end is a multi-line fallback (the capture bound is single-line) for a value
// whose closing quote sits on a later line. `str` (the quote-punctuation scopes) is optional: omit
// it → quotes left unscoped (Vue passes it from `d.valueString`; HTML from the string-punct scopes).
// `assign` arrives pre-escaped; `quotes` raw; `quoteCc` is the char-class-escaped quote set.
// `valuePatterns` (optional) overrides the single `include` with an explicit pattern list (Vue
// `generic="…"` — a TS type-PARAMETER list: comments + variance keyword + types + commas + `=`,
// mirroring Volar's hand-written rule via the host's PUBLIC repository keys). When given it REPLACES
// `[{ include }]` everywhere the value is tokenized; the quote bounding is unchanged.
function embedValuePatterns(
  embed: string, include: string, eqScope: string,
  assign: string, quotes: string[], quoteCc: string,
  str?: { begin: string; end: string },
  valuePatterns?: (TmPattern | { include: string })[],
): TmPattern[] {
  const valuePats: (TmPattern | { include: string })[] = valuePatterns ?? [{ include }];
  const valueCap = (q: string): TmPattern => {
    const captures: Record<string, TmCapture> = {
      '1': { name: eqScope },
      '3': { name: embed, patterns: valuePats },
    };
    if (str) { captures['2'] = { name: str.begin }; captures['4'] = { name: str.end }; }
    return { match: `(${assign})\\s*(${escapeRegex(q)})([^${escapeForCharClass(q)}]*)(${escapeRegex(q)})`, captures };
  };
  return [
    ...quotes.map(valueCap),
    {
      begin: `(${assign})\\s*([${quoteCc}])`,
      beginCaptures: str ? { '1': { name: eqScope }, '2': { name: str.begin } } : { '1': { name: eqScope } },
      end: `\\2`,
      ...(str ? { endCaptures: { '0': { name: str.end } } } : {}),
      contentName: embed, patterns: valuePats,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Markup TextMate grammar (HTML/Vue). When a grammar declares `markup`, its
//  highlighter is a different shape from a token-stream language's: text between
//  tags is the (unscoped) root, and the colourable structure is tag regions,
//  attributes, comments, and raw-text element bodies. We derive those begin/end
//  regions from the markup config + the grammar's token/literal scopes — the same
//  "structural role → conventional scope" derivation the token-stream path uses,
//  just over markup roles. Nothing here hardcodes HTML: delimiters, raw-text tag
//  names, and comment delimiters are all grammar DATA.
// ─────────────────────────────────────────────────────────────────────────────
function generateMarkupTm(grammar: CstGrammar, grammarName: string, scopeName: string): TmGrammar {
  const m = grammar.markup!;
  const L = grammarName;                                   // scope suffix, e.g. 'html'
  const { scopeOverrides } = grammar;
  const tokScope = (name?: string) => grammar.tokens.find(t => t.name === name)?.scope;

  // Tag / attribute name pattern = the grammar's identifier token (widened for Unicode).
  const identTok = grammar.tokens.find(t => t.identifier);
  const namePat = identTok ? unicodeWidenIdentPattern(tokenPatternSource(identTok)) : '[a-zA-Z][\\w:.-]*';

  // Punctuation scope for the tag delimiters is declared in the grammar (`<`,`>`,`/` →
  // punctuation.definition.tag); begin/end leaves follow the TextMate convention.
  const tagPunct = getScope(scopeOverrides, m.tagOpen) ?? 'punctuation.definition.tag';
  const sOpen = `${tagPunct}.begin.${L}`;
  const sClose = `${tagPunct}.end.${L}`;
  const sName = `entity.name.tag.${L}`;
  const sAttr = `entity.other.attribute-name.${L}`;
  const sEq = `punctuation.separator.key-value.${L}`;
  const sStrPunctB = `punctuation.definition.string.begin.${L}`;
  const sStrPunctE = `punctuation.definition.string.end.${L}`;
  const o = escapeRegex(m.tagOpen), c = escapeRegex(m.tagClose), slash = escapeRegex(m.closeMarker ?? '/');
  // Attribute syntax from config (DATA, like the tag delimiters above) — no HTML literal is
  // baked into the emitter; defaults mirror closeMarker's `?? '/'` convention.
  const assign = escapeRegex(m.attributeAssign ?? '='), assignCc = escapeForCharClass(m.attributeAssign ?? '=');
  const attrQuotes = m.attributeQuotes ?? ['"', "'"], quoteCc = attrQuotes.map(escapeForCharClass).join('');
  const ccTagOpen = escapeForCharClass(m.tagOpen);

  const repository: Record<string, TmPattern> = {};
  const top: { include: string }[] = [];

  // Comment — `<!-- … -->`.
  if (m.comment) {
    repository['comment'] = {
      name: tokScope(m.comment.token) ?? `comment.block.${L}`,
      begin: escapeRegex(m.comment.open),
      end: escapeRegex(m.comment.close),
      captures: { '0': { name: `punctuation.definition.comment.${L}` } },
    };
    top.push({ include: '#comment' });
  }

  // Character entities (`&amp;` / `&#169;` / `&#xAB;`) in text. Driven by `markup.entity`
  // DATA (prefix / terminator / numeric+hex markers / scopes) — nothing HTML-specific is
  // baked in. Two captured forms: NAMED (a letter then name chars) → namedScope, or NUMERIC
  // (`#` then digits, or `#x` then hex) → numericScope; the prefix and terminator are the
  // entity punctuation. A lone prefix (no `name;` tail) matches nothing → stays plain text,
  // matching the official. Highlight-only: the lexer/parser still see one text token.
  if (m.entity) {
    const e = m.entity;
    const pfx = escapeRegex(e.prefix), term = escapeRegex(e.terminator);
    const numM = escapeRegex(e.numericMarker), hexM = escapeForCharClass(e.hexMarker);
    repository['entities'] = {
      patterns: [
        // Numeric / hex reference: `#` digits, or `#` `x`/`X` hex digits.
        { match: `(${pfx})(${numM}(?:[${hexM}${hexM.toUpperCase()}][0-9a-fA-F]+|[0-9]+))(${term})`,
          captures: { '1': { name: e.punctuationScope }, '2': { name: e.numericScope }, '3': { name: e.punctuationScope } } },
        // Named reference: a letter, then name chars (letters/digits).
        { match: `(${pfx})([a-zA-Z][a-zA-Z0-9]*)(${term})`,
          captures: { '1': { name: e.punctuationScope }, '2': { name: e.namedScope }, '3': { name: e.punctuationScope } } },
      ],
    };
    top.push({ include: '#entities' });
  }

  // Raw-text elements (script/style/…): the body is verbatim (CDATA-like), so it is a
  // single embedded region — `<`/`>` inside it never start a tag. The embedded grammar
  // comes from the declared `embed` map (Vue SFC blocks: template→text.html.basic,
  // script→source.js, style→source.css); else the token's own scope. Nothing HTML-specific
  // is baked in — a grammar that wants script→JS declares it (html.ts does). A `{ default, lang }`
  // embed selects by a `lang="…"` start-tag attribute → one region per lang (first), then default.
  const ccClose = escapeForCharClass(m.tagClose);
  // Capture-embed: the start-tag attributes (`lang="ts"`, …) are re-tokenized by #attribute
  // instead of being lumped; the body is re-tokenized by the embedded grammar.
  const attrCap = { patterns: [{ include: '#attribute' }] };
  const emitRaw = (key: string, tag: string, embed: string, langVal?: string) => {
    const attrs = langVal
      ? `([^${ccClose}]*\\blang\\s*=\\s*["']${langVal}["'][^${ccClose}]*)`   // start tag carries lang="<val>"
      : `([^${ccClose}]*)`;
    const bodyCap = { name: embed, patterns: [{ include: embed }] };          // capture re-tokenized as the embed
    // (1) single-line `<tag …>BODY</tag>` — one regex bounds the body at `</tag>` (so even
    //     a mid-construct embed can't escape), body + attrs re-tokenized via capture-embed.
    repository[`${key}-inline`] = {
      name: `meta.${tag}.${L}`,
      match: `(${o})(${tag})\\b${attrs}(${c})(.*?)(${o}${slash})(${tag})\\s*(${c})`,
      captures: {
        '1': { name: sOpen }, '2': { name: sName }, '3': attrCap, '4': { name: sClose },
        '5': bodyCap,
        '6': { name: sOpen }, '7': { name: sName }, '8': { name: sClose },
      },
    };
    // (1b) single-line OPEN+BODY then `</tag` whose `>` is DEFERRED to a later line — the whole
    //     `<tag …>BODY</tag` sits on ONE line but the close `>` (HTML allows whitespace, incl. line
    //     feeds, between the tag name and `>` of an END tag) lands on a subsequent line. The `(1)`
    //     `-inline` match needs `>` on the line, and the `begin/while` `(2)` below only re-checks at
    //     the NEXT line's start — so neither closes here and the trailing `</tag` would leak into the
    //     embed (textmate/html.tmbundle#97). This bounded `begin/end` claims the open tag + body +
    //     `</tag` (capture-embedding BODY so the close stays clean), then `end`s at the deferred `>`.
    //     The close must be on the SAME line as the open (so it doesn't collide with the `begin/while`,
    //     which owns the open-then-later-lines case); `(?=\s*$)` requires only whitespace after `</tag`
    //     to end-of-line, i.e. the `>` really is deferred. Agnostic: keys on the tag + `<`/`/`/`>`
    //     delimiters only, like every other raw-text rule.
    repository[`${key}-inline-ml`] = {
      name: `meta.${tag}.${L}`,
      begin: `(${o})(${tag})\\b${attrs}(${c})(.*?)(${o}${slash})(${tag})(?=\\s*$)`,
      beginCaptures: {
        '1': { name: sOpen }, '2': { name: sName }, '3': attrCap, '4': { name: sClose },
        '5': bodyCap, '6': { name: sOpen }, '7': { name: sName },
      },
      end: `(${c})`, endCaptures: { '1': { name: sClose } },
    };
    // (2) multi-line `begin/while` — the `while` re-checks each line and DROPS the region
    //     (popping any open embedded region) at the first line CONTAINING `</tag>` (the `.*`
    //     reaches it anywhere on the line, not just `^\s*` at the start). So the close wins even
    //     MID-LINE: a `</script>` after a JS `//` comment (tmbundle#85) — or inside a JS string —
    //     still closes the element, matching parse5 / the HTML tokenizer, which close at the FIRST
    //     `</script>` regardless of embedded-language context. The embed stays ONE continuous
    //     region across lines (the `while` only TESTS, never re-anchors), so a multi-line template
    //     literal / block comment in the body is unbroken; only a line that actually contains the
    //     close tag drops. The close-tag test is `</tag` then ws / `>` / END-OF-LINE (`$`): the EOL
    //     alternative drops a line whose `</tag` has its `>` DEFERRED to a later line (tmbundle#97),
    //     so that line leaves the embed and the sibling `#<key>-close-ml` re-embeds its pre-close
    //     content. CRUCIALLY the line-start drop FORCE-UNWINDS a still-open embedded region
    //     (e.g. a trailing unterminated `type T =` whose body would otherwise read `</script>` as
    //     `< script >` type-args) — an `end:(?=</tag)` lookahead can NOT do this (the innermost open
    //     embed region's patterns are evaluated before any outer `end`), so the `while` is load-
    //     bearing here (#5538/#2060, #65/#74). The dropped close LINE's pre-close content is then
    //     re-embedded by the sibling `#<key>-close` rule below. The close tag is matched by host #tag.
    repository[key] = {
      name: `meta.${tag}.${L}`,
      begin: `(${o})(${tag})\\b${attrs}(${c})`,
      beginCaptures: { '1': { name: sOpen }, '2': { name: sName }, '3': attrCap, '4': { name: sClose } },
      while: `^(?!.*${o}${slash}${tag}(?:[\\s${ccClose}]|$))`,
      contentName: embed,
      patterns: [{ include: embed }],
    };
    // (3) CLOSE LINE with leading content — `BODY</tag>` where BODY shares the close's line (the
    //     open tag was on an earlier line, so this is NOT the `-inline` single-line shape; and the
    //     `begin/while` above DROPS this line because it contains the close). Without this, that
    //     pre-close BODY falls to plain host text (the #2060 / #5538 same-line-close gap). Here it is
    //     re-tokenized as a BOUNDED capture-embed: BODY is captured up to the close and run through
    //     the embed in ISOLATION, so the embed's own greedy line-comment / regex / unterminated
    //     construct physically cannot reach across the close — the close stays clean tag punctuation
    //     AND its preceding code is highlighted. The BODY needs ≥1 char before the close, so a BARE
    //     close line (just `</tag>`) does NOT match here — it stays on the `begin/while` force-unwind
    //     path (preserving #5538's open-type unwind). The BODY is a tempered-greedy run
    //     `(?:(?!<tag\b).)+?` — any char that does NOT begin a `<tag` OPEN, so the rule cannot fire on
    //     a single-line `<tag>…</tag>` (that whole line is the `-inline` shape, claimed earlier) nor
    //     swallow a following block's open tag, yet a bare `<` in the body (`a < b`) is fine. Agnostic:
    //     keys only on the tag + `<`/`/`/`>` delimiters (DATA), never on the embed's syntax.
    repository[`${key}-close`] = {
      name: `meta.${tag}.${L}`,
      match: `^(\\s*)((?:(?!${o}${tag}\\b).)+?)(${o}${slash})(${tag})\\s*(${c})`,
      captures: { '2': bodyCap, '3': { name: sOpen }, '4': { name: sName }, '5': { name: sClose } },
    };
    // (3b) ORPHAN CLOSE LINE whose `>` is DEFERRED — `BODY</tag` ending the line, the `>` on a later
    //     one (the case-(3) sibling but with the close `>` split off, the tmbundle#97 deferred-`>`
    //     shape after the body sits on its own line). The widened `begin/while` (2) drops this line
    //     (its `</tag` is at end-of-line), so it lands here: a bounded `begin/end` that capture-embeds
    //     BODY (so the embed can't reach the close), opens at `</tag` with only whitespace after it
    //     (`(?=\s*$)` → the `>` is deferred), and `end`s at the deferred `>`. Same tempered-greedy
    //     BODY run as (3) so it can't swallow a following block's `<tag` OPEN; agnostic to the embed.
    repository[`${key}-close-ml`] = {
      name: `meta.${tag}.${L}`,
      begin: `^(\\s*)((?:(?!${o}${tag}\\b).)+?)(${o}${slash})(${tag})(?=\\s*$)`,
      beginCaptures: { '2': bodyCap, '3': { name: sOpen }, '4': { name: sName } },
      end: `(${c})`, endCaptures: { '1': { name: sClose } },
    };
    top.push({ include: `#${key}-inline` });      // single-line first, then multi-line
    top.push({ include: `#${key}-inline-ml` });   // single-line open+body+</tag with a DEFERRED `>` (#97)
    top.push({ include: `#${key}` });
    top.push({ include: `#${key}-close` });        // orphan close line (BODY</tag>) — after the open-tag rules
    top.push({ include: `#${key}-close-ml` });     // orphan close line with a DEFERRED `>` (#97)
  };
  // Multi-line START TAG variant — `<script\n  lang="ts"\n>` (force-expand-multiline
  // formatting; vuejs/language-tools#3999). A TextMate `begin` is single-line, so the entries
  // above (which need `>` on the line) can't open a tag whose `>` is on a later line. This is
  // ONE region for the whole element; inside, an attr phase consumes the start tag until a
  // known `lang=` (handed to a per-lang region selected by a line-agnostic LOOKAHEAD) or `>`,
  // then the body embeds via the same begin/while bound as the single-line path. Mirrors the
  // official grammar's #multi-line-script-tag-stuff. Mutually exclusive with the single-line
  // begin (this requires NO `>` on the opening line), so the single-line path is untouched.
  const emitRawMultiline = (tag: string, spec: string | { default: string; lang?: Record<string, string> }) => {
    const defaultEmbed = typeof spec === 'string' ? spec : spec.default;
    const langs = typeof spec === 'string' ? [] : Object.entries(spec.lang ?? {});
    const closeAhead = `${o}${slash}${tag}(?:[\\s${ccClose}]|$)`;      // `</tag` then ws / `>` / EOL (a DEFERRED `>` on a later line, tmbundle#97)
    const content = (embed: string): TmPattern[] => [                 // body after `>`, bounded at `</tag>`
      { begin: `(?<=${c})(?=[^\\n]*${closeAhead})`, end: `(?=${closeAhead})`, contentName: embed, patterns: [{ include: embed }] },
      { begin: `(?<=${c})`, while: `^(?!.*${closeAhead})`, contentName: embed, patterns: [{ include: embed }] },
    ];
    const langAlt = langs.map(([v]) => escapeRegex(v)).join('|');
    const langLA = langAlt ? `\\blang\\s*=\\s*["']?(?:${langAlt})\\b` : '';
    const pats: TmPattern[] = [
      // attr phase: consume the start tag until a recognised `lang=` (left for a lang region) or `>`
      { name: `meta.tag.${L}`, begin: `\\G${langLA ? `(?!${langLA})` : ''}`, end: langLA ? `(?=${langLA})|(${c})` : `(${c})`, endCaptures: { '1': { name: sClose } }, patterns: [{ include: '#attribute' }] },
    ];
    for (const [val, embed] of langs) {            // per-lang: lookahead-selected (works across lines)
      pats.push({
        begin: `(?=\\blang\\s*=\\s*["']?${escapeRegex(val)}\\b)`,
        end: `(?=${closeAhead})`,
        patterns: [{ begin: `\\G`, end: `(${c})`, endCaptures: { '1': { name: sClose } }, patterns: [{ include: '#attribute' }] }, ...content(embed)],
      });
    }
    pats.push(...content(defaultEmbed));           // default (no recognised lang)
    repository[`raw-${tag}-ml`] = {
      name: `meta.${tag}.${L}`,
      begin: `(${o})(${tag})\\b(?![^${ccClose}]*${c})`,               // `<tag` with NO `>` on this line
      beginCaptures: { '1': { name: sOpen }, '2': { name: sName } },
      end: `(${o}${slash})(${tag})\\s*(${c})`,
      endCaptures: { '1': { name: sOpen }, '2': { name: sName }, '3': { name: sClose } },
      patterns: pats,
    };
    top.push({ include: `#raw-${tag}-ml` });
  };
  // Custom-block embeds: ANY block tag carrying `lang="<lang>"` embeds the mapped scope in its body
  // (the SFC custom-block convention — `<i18n lang="yaml">`, `<docs lang="md">`, `<gql lang="gql">`).
  // One begin/end per lang: the tag NAME is captured (group 2) and the close is its BACKREFERENCE
  // (`</\2>`), so the region is tag-agnostic. Emitted BEFORE the named rawText blocks so a data lang
  // on a named tag still resolves here when that tag's lang map doesn't list it. The lookahead asserts
  // `lang=<lang>` in the start tag; the start-tag attrs re-tokenize via #attribute; body → the grammar.
  for (const [lang, scope] of Object.entries(m.customBlockEmbed ?? {})) {
    const key = `block-${lang}`;
    repository[key] = {
      name: `meta.embedded.block.${L}`,
      begin: `(${o})(${namePat})\\b(?=[^${ccClose}]*\\blang\\s*=\\s*["']?${escapeRegex(lang)}\\b)([^${ccClose}]*)(${c})`,
      beginCaptures: { '1': { name: sOpen }, '2': { name: sName }, '3': { patterns: [{ include: '#attribute' }] }, '4': { name: sClose } },
      end: `(${o}${slash})(\\2)\\s*(${c})`,
      endCaptures: { '1': { name: sOpen }, '2': { name: sName }, '3': { name: sClose } },
      contentName: scope,
      patterns: [{ include: scope }],
    };
    top.push({ include: `#${key}` });
  }
  for (const tag of m.rawText?.tags ?? []) {
    const spec = m.rawText!.embed?.[tag] ?? (tokScope(m.rawText!.token) ?? `source.${L}`);
    if (typeof spec === 'string') {
      emitRaw(`raw-${tag}`, tag, spec);
    } else {
      // lang-specific regions FIRST (they require the matching lang= attr), default LAST.
      for (const [langVal, langEmbed] of Object.entries(spec.lang ?? {})) emitRaw(`raw-${tag}-${langVal}`, tag, langEmbed, langVal);
      emitRaw(`raw-${tag}`, tag, spec.default);
    }
    emitRawMultiline(tag, spec);   // multi-line start-tag variant (one per tag, all langs inside)
  }

  // A tag — open `<div …`, close `</div>`, self-close `<br/>`, or void `<br>`, all the
  // same shape: `<` + optional `/` + name, attributes, then optional `/` + `>`.
  repository['tag'] = {
    name: `meta.tag.${L}`,
    begin: `(${o})(${slash}?)(${namePat})`,
    beginCaptures: { '1': { name: sOpen }, '2': { name: sOpen }, '3': { name: sName } },
    end: `(${slash}?)(${c})`,
    endCaptures: { '1': { name: sClose }, '2': { name: sClose } },
    patterns: [{ include: '#attribute' }],
  };
  top.push({ include: '#tag' });

  // Attributes inside a tag. The VALUE is scoped only inside a `= …` region, so a
  // value that happens to look like a name (`href=https://…`) is NOT mis-scoped as an
  // attribute name (a real bug in flat-pattern grammars), and an unquoted value may
  // contain `/` (URLs) — the HTML spec only bars whitespace / quotes / `<>` / `=` / backtick.
  // One string pattern per declared quote char (`"`→double, `'`→single by convention).
  const quoteKind = (q: string) => q === '"' ? 'double' : q === "'" ? 'single' : 'other';
  const strs = attrQuotes.map(q => ({
    begin: escapeRegex(q), end: escapeRegex(q), name: `string.quoted.${quoteKind(q)}.${L}`,
    beginCaptures: { '0': { name: sStrPunctB } }, endCaptures: { '0': { name: sStrPunctE } },
  }));
  const unquoted = { match: `[^\\s${quoteCc}${ccTagOpen}${escapeForCharClass(m.tagClose)}${assignCc}\`]+`, name: `string.unquoted.${L}` };
  // Embedded-value attributes (HTML event handlers: `on*`=…→source.js). Mirrors a Vue directive's
  // shape — an outer region keyed on the attribute NAME, then the SHARED capture-embed value
  // (embedValuePatterns) bounds the embed to the quoted span. Placed FIRST so it wins the
  // name/value tie on a real `on*`; leftmost-match still prefers the generic name rule for
  // `data-on…` (it matches at the earlier, true attribute start). `(?![\w:.-])` completes the name.
  const attrEmbed: TmPattern[] = (m.attributeEmbed ?? []).map(spec => ({
    begin: `(${tokenPatternToRegex(spec.namePattern)})(?![\\w:.-])`,
    beginCaptures: { '1': { name: sAttr } },
    end: `(?=[\\s${escapeForCharClass(m.tagClose)}${escapeForCharClass(m.closeMarker ?? '/')}])`,
    patterns: embedValuePatterns(spec.embed, spec.include ?? spec.embed, sEq, assign, attrQuotes, quoteCc, { begin: sStrPunctB, end: sStrPunctE }, spec.valuePatterns),
  }));
  repository['attribute'] = {
    patterns: [
      ...attrEmbed,                                                     // `on*`=…→embedded source (before the generic name)
      { match: `(${namePat})(?=\\s*${assign})`, name: sAttr },         // attribute name (followed by the assign char)
      {                                                                 // `= value`
        begin: `(${assign})\\s*`, beginCaptures: { '1': { name: sEq } },
        end: `(?=[\\s${escapeForCharClass(m.tagClose)}])`,
        patterns: [...strs, unquoted],
      },
      { match: `(${namePat})`, name: sAttr },                          // boolean attribute (no `=`)
    ],
  };

  // Thin-stub injection (Vue): merge the directive/interpolation rule BODIES into THIS host
  // grammar's repository, so the injection files can `include` them as text.html.vue#vue-directives.
  // Repo-only — NOT pushed to `top`, so they fire via injection, not the main SFC parse.
  const injectParts = buildMarkupInjectParts(grammar, scopeName);
  if (injectParts) Object.assign(repository, injectParts.repo);

  // Repository-key NAMING CONSTRAINT (官方命名「限制器」): same projection as the token-stream path —
  // markup grammars may also declare canonical names (none today), so the path is symmetric.
  applyCanonicalRepoNames(grammar, repository, top);

  return {
    $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
    name: grammarName,
    scopeName,
    patterns: top,
    repository,
  };
}

interface InjectionGrammar {
  $schema: string;
  scopeName: string;
  injectionSelector: string;
  patterns: ({ include: string })[];
  repository?: Record<string, TmPattern>;   // thin-stub injection files carry none (rules live in the host repo)
}

// One injectionSelector string from clauses. ALWAYS append `-exprEmbed` so the injection can't
// re-fire inside an expression it already embedded — otherwise a directive shorthand `:` matches
// the ternary `:` in `{{ a ? b : c }}` (its lookbehind `[\s<]` is satisfied by the space before
// the colon) and wrecks the rest of the file (vuejs/language-tools#5722). Mirrors the official's
// per-clause excludes (`-source.tsx -source.js.jsx`, `-comment.block`, …) which come from DATA.
function buildInjectionSelector(clauses: InjectClause[], exprEmbed: string): string {
  const guard = exprEmbed ? ` -${exprEmbed}` : '';
  return clauses.map(cl => `L:${cl.scope}${(cl.excludes ?? []).map((e: string) => ` -${e}`).join('')}${guard}`).join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Markup INJECTION (Vue directives + `{{ }}` interpolation). A Vue `<template>` reuses the
//  HTML grammar wholesale, so Vue syntax can't be baked in — it must be INJECTED onto HTML's
//  scopes (the official does the same). Each CONCERN becomes one THIN-STUB file (selector +
//  `include: <host>#<repoKey>`); the rule BODIES live in the HOST grammar's repository. This
//  shared builder returns both halves so generateMarkupTm (merges the repo) and
//  generateMarkupInjection (emits the files) can't drift. `mainScopeName` is the host scope
//  (text.html.vue) the stubs include from. Matches the official topology byte-for-byte at the
//  file level (vue-directives.json / vue-interpolations.json include text.html.vue#…).
// ─────────────────────────────────────────────────────────────────────────────
function buildMarkupInjectParts(grammar: CstGrammar, mainScopeName: string): { repo: Record<string, TmPattern>; files: InjectionGrammar[] } | null {
  const inj = grammar.markup?.inject;
  if (!inj) return null;
  const m = grammar.markup!;
  // Markup delimiters from config (DATA) — bakes in no HTML literal, matching generateMarkupTm.
  const ccOpen = escapeForCharClass(m.tagOpen), ccClose = escapeForCharClass(m.tagClose), ccSlash = escapeForCharClass(m.closeMarker ?? '/');
  const assign = escapeRegex(m.attributeAssign ?? '='), assignCc = escapeForCharClass(m.attributeAssign ?? '=');
  const quotes = m.attributeQuotes ?? ['"', "'"], quoteCc = quotes.map(escapeForCharClass).join('');
  const beforeAttr = `(?<=[\\s${ccOpen}])`;          // preceded by whitespace or tag-open
  const endAttr = `(?=[\\s${ccSlash}${ccClose}])`;   // ends at whitespace / close-marker / tag-close
  const $schema = 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json';
  const repo: Record<string, TmPattern> = {};
  const files: InjectionGrammar[] = [];
  const stub = (scopeName: string, selector: InjectClause[], repoKey: string): InjectionGrammar =>
    ({ $schema, scopeName, injectionSelector: buildInjectionSelector(selector, inj.exprEmbed), patterns: [{ include: `${mainScopeName}#${repoKey}` }] });

  // `{{ … }}` → an embedded expression (Monogram's own TS via `exprInclude`).
  if (inj.interpolation) {
    const ip = inj.interpolation;
    repo[ip.repoKey] = {
      begin: `(${escapeRegex(ip.open)})`,
      end: `(${escapeRegex(ip.close)})`,
      beginCaptures: { '1': { name: ip.beginScope } },
      endCaptures: { '1': { name: ip.endScope } },
      contentName: inj.exprEmbed,
      patterns: [{ include: inj.exprInclude }],
    };
    files.push(stub(ip.scopeName, ip.selector, ip.repoKey));
  }

  // Directives in attribute position. Each is a begin/end region (name … then value) so the
  // expression embed applies ONLY to a directive's value, never a plain HTML attribute.
  if (inj.directives) {
    const d = inj.directives;
    // `= "expr"` → the value is an EXPRESSION. Capture-embedded (bounded to the quoted span) so an
    // `as`-cast can't run its type context past the closing quote and swallow the tag (#5012). The
    // SAME embed-value helper plain-HTML `on*` attributes use — `d.valueString` (optional) scopes
    // the quotes; the value scope + include come from `inject`. See embedValuePatterns.
    const values = embedValuePatterns(inj.exprEmbed, inj.exprInclude, d.eqScope, assign, quotes, quoteCc, d.valueString);
    // The optional directive ARGUMENT, shared by the shorthand (`:arg`) and long-form (`v-bind:arg`)
    // begins. A DYNAMIC arg `[expr]` is itself an expression (`:[attr]`, `v-slot:[`k-${i}`]` —
    // vuejs/language-tools#4410/#2666): split into `[` + inner-embedded + `]`, the inner re-tokenized
    // by `exprInclude` (so `${idx}` lights as code). A STATIC arg is a plain name. This is the
    // official's arg shape `(?:(?:(\[)([^\]]*)(\]))|([\w-]+))?`. The embed scope/include come from
    // the `inject` config (NOT hardcoded — gen-tm stays agnostic); the only Vue-specific knowledge
    // is "a bracketed directive arg is an expression", which is the generic markup-injection rule.
    // Returns the regex fragment + the four capture entries indexed from `base` (so a head's own
    // groups precede the arg's). `[` / `]` reuse `eqScope` (punctuation), matching the official.
    const argFragment = `(?:(?:(\\[)([^\\]]*)(\\]))|([\\w-]+))?`;
    const argCaptures = (base: number): Record<string, TmCapture> => ({
      [base]: { name: d.eqScope },                                            // `[`
      [base + 1]: { name: inj.exprEmbed, patterns: [{ include: inj.exprInclude }] },  // dynamic arg → embedded
      [base + 2]: { name: d.eqScope },                                        // `]`
      [base + 3]: { name: d.nameScope },                                      // static arg name
    });
    const dir: TmPattern[] = [];
    for (const c of d.control) {         // v-for / v-if … — distinct scope, value embedded
      dir.push({
        begin: `${beforeAttr}(${tokenPatternToRegex(c.match)})(?=[${assignCc}\\s${ccSlash}${ccClose}]|$)`,
        beginCaptures: { '1': { name: c.scope } },
        end: endAttr, patterns: values,
      });
    }
    for (const s of d.shorthand) {       // `:`/`.`/`@`/`#` (+ arg), value embedded
      dir.push({
        begin: `${beforeAttr}(${escapeRegex(s.char)})${argFragment}`,
        beginCaptures: { '1': { name: s.scope }, ...argCaptures(2) },
        end: endAttr, patterns: values,
      });
    }
    dir.push({                            // long-form `v-name`(`:arg`), value embedded
      begin: `${beforeAttr}(${escapeRegex(d.prefix)}[\\w-]+)(?:(:)${argFragment})?`,
      beginCaptures: { '1': { name: d.nameScope }, '2': { name: d.eqScope }, ...argCaptures(3) },
      end: endAttr, patterns: values,
    });
    repo[d.repoKey] = { patterns: dir };
    files.push(stub(d.scopeName, d.selector, d.repoKey));
  }

  return { repo, files };
}

// The injection FILES (thin stubs, one per concern). The rule BODIES are merged into the host
// grammar's repository by generateMarkupTm. Returns [] when no injection is declared.
export function generateMarkupInjection(grammar: CstGrammar, grammarName: string): InjectionGrammar[] {
  return buildMarkupInjectParts(grammar, grammar.scopeName ?? `text.${grammarName}`)?.files ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
//  VS Code `contributes` snippet — the packaging that wires the generated grammars into an
//  editor (and makes Monogram's Vue a drop-in for vuejs/language-tools' files). Assembled from
//  the grammar's declared `manifest` DATA + what the emitter already knows: the main scopeName,
//  the injection scopeNames (generateMarkupInjection), and the standard generated filenames
//  (matching cli's naming). Returns null when no manifest is declared.
// ─────────────────────────────────────────────────────────────────────────────
interface ContributesSnippet {
  languages: { id: string; extensions: string[]; configuration: string }[];
  grammars: { language?: string; scopeName: string; path: string; injectTo?: string[]; embeddedLanguages?: Record<string, string> }[];
}
export function generateContributes(grammar: CstGrammar, grammarName: string): ContributesSnippet | null {
  const man = grammar.manifest;
  if (!man) return null;
  const scopeName = grammar.scopeName ?? `source.${grammarName}`;
  const grammars: ContributesSnippet['grammars'] = [
    // The main grammar — carries the embeddedLanguages map (template/script/style regions).
    { language: grammarName, scopeName, path: `./${grammarName}.tmLanguage.json`,
      ...(man.embeddedLanguages ? { embeddedLanguages: man.embeddedLanguages } : {}) },
    // Each injection (thin stub) loads into the declared host grammars (injectTo).
    ...generateMarkupInjection(grammar, grammarName).map(inj => ({
      scopeName: inj.scopeName, path: `./${inj.scopeName}.tmLanguage.json`,
      ...(man.injectTo ? { injectTo: man.injectTo } : {}),
    })),
    // Alias grammars (e.g. text.html.derivative) — re-exports, no language/injectTo.
    ...(grammar.aliasScopes ?? []).map(a => ({ scopeName: a.scope, path: `./${a.file}.tmLanguage.json` })),
  ];
  return {
    languages: [{ id: grammarName, extensions: man.extensions ?? [`.${grammarName}`], configuration: `./${grammarName}.language-configuration.json` }],
    grammars,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Alias grammar — a thin TextMate grammar that RE-EXPOSES a base grammar under another
//  scopeName by `include`-ing it wholesale. Monogram's `text.html.derivative` is exactly
//  this: the embedded-HTML-fragment scope that Vue/markdown/pug injections target, with the
//  same rules as text.html.basic. (VS Code ships html-derivative as a separate grammar for
//  the same reason; its body is also just the base's rules — for us there is no `invalid`
//  subset to strip, so a whole-grammar include is the faithful equivalent.)
// ─────────────────────────────────────────────────────────────────────────────
export function generateAliasGrammar(baseScopeName: string, aliasScope: string): { $schema: string; scopeName: string; patterns: ({ include: string })[] } {
  return {
    $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
    scopeName: aliasScope,
    patterns: [{ include: baseScopeName }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Rule-rooted `#expression` derivation
//
//  An expression-only embed (Vue `{{ }}`, directive values) must not treat a STATEMENT
//  keyword at its TOP level as a keyword — `{{ const x }}` / `{{ for(…) }}` / `{{ return x }}`
//  are invalid there. We derive the set of keywords that may appear in an EXPRESSION from
//  the grammar's DECLARED expression rule (`grammar.expressionRule` — gen-tm stays agnostic,
//  it reads a ref, it doesn't know "Expr"), then build a `#expression` repository entry =
//  the top-level patterns with statement-starters removed and mixed keyword groups narrowed
//  to their expression members. Nested blocks (`{ }`) re-enter `$self`, so a statement INSIDE
//  a function/arrow body in an expression still highlights — only the top level is filtered.
// ─────────────────────────────────────────────────────────────────────────────

const isExprKeyword = (s: string) => /^[a-zA-Z]/.test(s);

/** Whether a rule expression can match the empty string — so FIRST must look past it. */
function ruleIsNullable(e: RuleExpr, byName: Map<string, RuleExpr>, seen = new Set<string>()): boolean {
  switch (e.type) {
    case 'seq': return e.items.every(i => ruleIsNullable(i, byName, seen));
    case 'alt': return e.items.some(i => ruleIsNullable(i, byName, seen));
    case 'quantifier': return e.kind === '*' || e.kind === '?';
    case 'group': return ruleIsNullable(e.body, byName, seen);
    case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore': return true;  // zero-width assertions
    case 'ref': { if (seen.has(e.name)) return false; seen.add(e.name); const b = byName.get(e.name); return b ? ruleIsNullable(b, byName, seen) : false; }
    default: return false;                                     // literal / token / op / prefix / postfix / sep
  }
}

/** FIRST set (literals only) — keywords that can BEGIN this rule. Follows refs only at
 *  START positions, so it never descends into a statement block (which always sits after
 *  `=>`, never at an alternative's start), and stops on cycles (left-recursion adds nothing). */
function firstLiterals(e: RuleExpr, byName: Map<string, RuleExpr>, seen = new Set<string>()): Set<string> {
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
function expressionKeywords(grammar: CstGrammar): Set<string> {
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

/** The leading keyword alternation a pattern is anchored on (`\b(const)…`, `\b(in|for|…)…`),
 *  or null if it doesn't start by matching a keyword (lexical / operator / member-access). */
function leadingKeywordAnchors(re: string | undefined): string[] | null {
  if (!re) return null;
  const m = re.match(/^\\b\(([A-Za-z][A-Za-z0-9_$|]*)\)/);
  return m ? m[1].split('|') : null;
}

/** Build a `#expression` repository entry from the final top-level pattern order: drop the
 *  includes anchored solely on statement keywords, narrow mixed keyword groups to their
 *  expression members, keep everything lexical/operator. Mutates `repository` (adds the
 *  `#expression` entry + any `#expr-*` narrowed-group copies). */
function deriveExpressionEntry(grammar: CstGrammar, orderedPatterns: { include: string }[], repository: Record<string, TmPattern>): void {
  const exprKw = expressionKeywords(grammar);
  const exprPatterns: { include: string }[] = [];
  for (const { include } of orderedPatterns) {
    const key = include.slice(1);
    const entry = repository[key];
    const anchors = entry ? leadingKeywordAnchors(entry.begin ?? entry.match) : null;
    if (!entry || !anchors) { exprPatterns.push({ include }); continue; }  // lexical / operator / access → expression-level
    const kept = anchors.filter(a => exprKw.has(a));
    if (kept.length === 0) continue;                                       // pure statement-starter → drop
    if (kept.length === anchors.length) { exprPatterns.push({ include }); continue; }
    // MIXED keyword group (e.g. `in|for|while|…`) → narrow to its expression members. Only
    // safe for a plain match+name group (no begin/captures keyed to the alternation order).
    if (entry.match && !entry.begin && !entry.captures) {
      const narrowed = entry.match.replace(/^(\\b)\(([A-Za-z][A-Za-z0-9_$|]*)\)/, `$1(${kept.join('|')})`);
      if (narrowed !== entry.match) { repository[`expr-${key}`] = { ...entry, match: narrowed }; exprPatterns.push({ include: `#expr-${key}` }); continue; }
    }
    exprPatterns.push({ include });  // couldn't narrow safely → keep (conservative)
  }
  // A nested `{ }` (arrow/bare block) must re-enter the FULL grammar so statements INSIDE an
  // expression still highlight — `{{ (() => { const x = 1 })() }}`. #code-block re-includes
  // $self; without it an arrow body inherits #expression's top-level filtering and a statement
  // there would be dropped. (Function expressions already re-enter via #function-declaration.)
  // Put it first so a block `{` beats the bare-curly punctuation match.
  if (repository['code-block']) exprPatterns.unshift({ include: '#code-block' });
  repository['expression'] = { patterns: exprPatterns };
}

// Rewrite every `#oldKey` repository reference (in `include`, at any depth: nested `patterns`
// and `captures`/`beginCaptures`/`endCaptures`, since a capture IS a rule) to `#newKey`, per a
// rename map. `$self` and any non-`#` include (cross-grammar `source.x#key`) are left untouched.
// Pure string substitution on the reference NAME — no `match`/`begin`/`name` is read or changed.
function rewriteRepoRefs(node: unknown, rename: Map<string, string>): void {
  if (Array.isArray(node)) { for (const n of node) rewriteRepoRefs(n, rename); return; }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.include === 'string' && obj.include.startsWith('#')) {
    const to = rename.get(obj.include.slice(1));
    if (to !== undefined) obj.include = `#${to}`;
  }
  for (const k of ['patterns', 'captures', 'beginCaptures', 'endCaptures'] as const) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) rewriteRepoRefs(v, rename);
      else for (const cap of Object.values(v as Record<string, unknown>)) rewriteRepoRefs(cap, rename);
    }
  }
}

// The repository-key NAMING CONSTRAINT ("限制器"): the grammar may declare `canonicalRepoNames`,
// a DATA map { OFFICIAL repo KEY NAME → the structural key(s) gen-tm derived for the SAME construct }.
// For Monogram's source.ts to be a repository-level DROP-IN, the official NAMES that external grammars
// `#include` (`source.ts#type`, `#qstring-double`, `#comment`, …) must be the names Monogram NATIVELY
// emits. After the repository is built under structural names, this projects each structural identity
// through the constraint so the canonical official name is produced DIRECTLY:
//   • STRING value → 1:1 construct: RENAME the structural key to the official name and REWRITE every
//     `#…` reference to it (in the repository AND the top-level patterns). The structural name is gone
//     — there is ONE key, natively named (NOT a structural key + an additive alias).
//   • ARRAY value → a UNION the official grammar itself expresses as a `{patterns:[…]}` wrapper
//     (e.g. `#comment`, `#return-type`); Monogram derives the members as separate keys, so no single
//     rename carries the name. SYNTHESISE the wrapper `{patterns:[{include:#member}…]}` under the
//     official name. Members keep their structural names (referenced elsewhere) but are resolved
//     through the 1:1 renames first, so a renamed member is included by its FINAL name.
// An official name that already names a real Monogram key (e.g. `namespace-declaration`, `expression`)
// is LEFT ALONE — never clobbered. Purely a NAMING projection (no pattern bytes change), so emitted
// tokenization is byte-identical. The NAMES are language DATA in the grammar definition; gen-tm only
// looks them up + substitutes, so the engine stays language-agnostic (a grammar declaring none is
// unaffected — the agnostic-test grammars declare none, so no TS names leak into the engine).
function applyCanonicalRepoNames(
  grammar: CstGrammar,
  repository: Record<string, TmPattern>,
  topPatterns: { include: string }[],
): void {
  const map = grammar.canonicalRepoNames;
  if (!map) return;

  // Pass 1 — collect the 1:1 renames (string values) into oldStructural → officialName, skipping any
  // whose source is missing or whose TARGET name already names a real key (don't clobber it).
  const rename = new Map<string, string>();
  for (const [official, source] of Object.entries(map)) {
    if (typeof source !== 'string') continue;
    if (!(source in repository)) continue;           // structural key not derived for this language
    if (official !== source && official in repository) continue;  // target name already taken — leave alone
    rename.set(source, official);
  }

  // Apply the renames: move each repository entry to its official key, then rewrite EVERY reference
  // (repository entries + top-level patterns) from the old structural name to the official one.
  for (const [from, to] of rename) {
    if (from === to) continue;
    repository[to] = repository[from];
    delete repository[from];
  }
  for (const entry of Object.values(repository)) rewriteRepoRefs(entry, rename);
  rewriteRepoRefs(topPatterns, rename);

  // Pass 2 — synthesise the UNION wrapper keys (array values). Members are resolved through the
  // renames from pass 1 (a member that was itself renamed is included by its final official name).
  for (const [official, source] of Object.entries(map)) {
    if (!Array.isArray(source)) continue;
    if (official in repository) continue;            // already a real key — never clobber
    const patterns = source
      .filter(m => repository[rename.get(m) ?? m])   // keep only members that exist post-rename
      .map(m => ({ include: `#${rename.get(m) ?? m}` }));
    if (patterns.length) repository[official] = { patterns };
  }
}

export function generateTmLanguage(grammar: CstGrammar, langName: string): TmGrammar {
  // Honour the grammar's DECLARED scopeName (e.g. source.ts) and derive every scope's
  // language suffix from it (ts / js / tsx) instead of the raw grammar name
  // (typescript / …). Themes key on `keyword.control.ts`, not `…​.typescript`, so this
  // is what makes the derived grammar a drop-in for the official one. The raw name is
  // kept only for the display `name` field below.
  const grammarName = langName;
  const scopeName = grammar.scopeName ?? `source.${langName}`;
  // Markup languages (HTML/Vue) derive a region-based grammar, not the token-stream one.
  if (grammar.markup) return generateMarkupTm(grammar, grammarName, scopeName);
  langName = scopeName.replace(/^source\./, '');
  const repository: Record<string, TmPattern> = {};
  const topPatterns: { include: string }[] = [];

  const tokenNames = new Set(grammar.tokens.map(t => t.name));
  const { scopeOverrides } = grammar;

  // ── Shared values ──
  // THE identifier token: prefer the one the grammar explicitly flags as the
  // identifier (`identifier: true`), the same token the parser's lexer uses for
  // its Unicode-identifier fallback. Falling back to the first `variable.other`-
  // classified token is unsafe when a grammar declares OTHER unrecognised
  // punctuation tokens (e.g. JSX's `/>` / `</`, which also classify as
  // `variable.other` and would otherwise be mistaken for the identifier pattern,
  // corrupting every ident-derived pattern).
  // The fallback (a token whose PATTERN classifies as variable.other) also requires the token's
  // RESOLVED scope to be variable.other — else a grammar with no identifier token (YAML) picks the
  // first punctuation token whose pattern is unrecognised (e.g. `---`, classified variable.other),
  // mis-tagging it as the identifier and appending `.readwrite` to its real scope. An explicitly
  // scoped token (entity.other.document, variable.other.alias, …) is excluded; a true bare
  // identifier (JS `Ident`, no explicit scope) still qualifies.
  const identToken = grammar.tokens.find(t => t.identifier)
    ?? grammar.tokens.find(t => classifyToken(t, { explicitScope: false }).scope === 'variable.other'
      && classifyToken(t).scope === 'variable.other');
  // Widen the identifier pattern so non-ASCII names (`Ω`, Cyrillic `А`) are scoped,
  // matching the parser lexer's Unicode fallback. This widened form is used only in
  // TextMate (Oniguruma) output, never by the lexer.
  const identPattern = identToken ? unicodeWidenIdentPattern(tokenPatternSource(identToken)) : '[a-zA-Z_]\\w*';

  // Contextual operator keywords (e.g. `as`/`keyof`/`is`/`satisfies`/`infer`):
  // keyword.operator.expression words that double as identifiers, so they are a
  // keyword ONLY in operator position — followed by whitespace then an operand.
  const contextualOps = findContextualOperatorKeywords(grammar);
  const operandStart = buildOperandStartClass(grammar, identToken);
  // Keyword iff followed by whitespace + an operand, OR at end of line (the
  // operand continues on the next line — a cast/operator split across lines,
  // e.g. `x as\n  Foo`). `const as = 1` / `as()` / `as.x` still fall through
  // to `variable` (next char is `=` / `(` / `.`, none start an operand and
  // none is end-of-line).
  const ctxOpGuard = `(?=\\s+${operandStart}|\\s*$)`;

  // Guard for a contextual LOOP-connector keyword (`of`): like ctxOpGuard, but the
  // iterable can also sit DIRECTLY after the keyword (no space) when it starts with
  // a non-identifier char — `for(x of[1])`, `for(x of(a))`, `for(x of/re/.exec())`
  // (a word-boundary already prevents an identifier iterable from fusing: `ofx`).
  // So the keyword fires on `\s+`+operand, EOL, or an optional-space non-identifier
  // operand opener (brackets / string-template delimiters / `-` / a regex `/`). It
  // still falls through to `variable` before `=`,`;`,`,`,`)`,`.`,`:` (`const of=1`,
  // an `of` binding name / iterable). Derived from the grammar — no hardcoded chars.
  const loopConnOpeners = new Set<string>();
  {
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
  }
  const loopConnClass = [...loopConnOpeners].map(escapeForCharClass).join('');
  const ctxLoopGuard = loopConnClass
    ? `(?=\\s+${operandStart}|\\s*$|\\s*[${loopConnClass}])`
    : ctxOpGuard;

  // Accessibility-style modifiers (`public`/`private`/`protected`/…) that also
  // double as identifiers / property names. They are scoped `storage.modifier`
  // ONLY in true modifier position — followed by whitespace then a member /
  // binding start: a spread `...`, `[` (computed member / array binding), `*`
  // (generator), `#` (private field), a string/number-literal member name, or
  // an identifier-start char (the member name, or the next modifier). Anything
  // else (`public = 1`, `public;`, `[public]`, `private[key]`, `x = private`)
  // falls through to the surrounding identifier scoping. The flat unconditional
  // match would otherwise mis-paint every such identifier use as a modifier.
  const contextualModifiers = findContextualAccessibilityModifiers(grammar);
  // Member/binding/block-start char class — the runtime mirror of the FOLLOW
  // test in findContextualAccessibilityModifiers (memberStart): identifier-start
  // (letters + the Ident token's non-\w extras like `$`) plus `[ * # { " '` and
  // a digit, with the spread `...` handled separately. Must stay in sync with
  // that predicate: a modifier is guarded iff EVERY follower begins here, so the
  // lookahead has to accept every such follower (`static {` block, `public ...`
  // rest, `public [e]` computed, `private #x`, the next modifier / member name).
  const modifierGuard = `(?=\\s+(?:\\.\\.\\.|[[:alpha:]_${identExtraClass(identToken)}\\[*#{"'0-9]))`;

  // ── 1. Detect angle bracket ambiguity ──
  const angleBracket = detectAngleBracketAmbiguity(grammar);
  const angleBracketExclude = new Set(angleBracket ? ['<', '>'] : []);
  // The `.tsx` generic-arrow ⇄ JSX-tag disambiguation building-blocks, derived ONCE
  // from the grammar's declarations (generic `<`/`>`, the `sep` `,`, the `string`
  // quotes) and SHARED by both sides so they can't drift: #arrow-type-parameters'
  // positive begin guard (below) and its inverse — the carve-out appended to the JSX
  // expression-start trigger in generateJsxPatterns. Built only when `<…>` is a
  // generic delimiter; null for a plain JS `.jsx` grammar (no generics).
  const angleDisambig = angleBracket
    ? jsxDisambigDelims(grammar, identPattern, angleBracket.separator, detectArrowParamDelims(grammar), angleBracket.innerRuleName)
    : null;

  if (angleBracket) {
    const abPatterns = generateAngleBracketPatterns(angleBracket, grammar, langName, identPattern, identToken);
    for (const [key, pattern] of Object.entries(abPatterns)) {
      repository[key] = pattern;
    }
    // Prefix type-assertion (cast) `<Type>expr` — only if the grammar has a
    // `'<' <typeRef> '>' <operand>` alternative. Added BEFORE the generic-call
    // layers: the cast's `<` is at expression-start (negative ident lookbehind),
    // mutually exclusive with generic-call's ident lookbehind, but it must beat
    // the flat #comparison fallback so the inner type reaches #type-inner.
    const castTypeRule = detectAngleBracketCast(grammar);
    if (castTypeRule) {
      repository['type-cast'] = generateTypeCastPattern(langName, identPattern, operandStart);
      topPatterns.push({ include: '#type-cast' });
    }
    // Add disambiguation layers to top patterns (order matters!)
    topPatterns.push({ include: '#generic-call' });
    topPatterns.push({ include: '#generic-call-eol' });
    topPatterns.push({ include: '#generic-call-multiline' });
    // comparison is added later in the ordering pass
  }

  // ── 1a. Detect JSX/TSX dialect ──
  // Purely additive: emitted only when the grammar declares the JSX delimiter
  // tokens (`/>` and `</`) plus an element production. A non-JSX grammar yields
  // null here, so no JSX patterns are emitted and its output is unchanged.
  const jsx = detectJsx(grammar);
  // Token names whose scoping is OWNED by the JSX patterns (the `/>` and `</`
  // delimiters are scoped as tag punctuation inside the JSX begins/ends, so they
  // must NOT also get a flat `variable.other` token match in Section 2).
  const jsxOwnedTokens = new Set<string>();
  if (jsx) {
    // The grammar's comment repo keys (derived, not hardcoded) so a `//` / `/* */`
    // comment is recognised inside a JSX open tag — legal between attributes (#585).
    const jsxPatterns = generateJsxPatterns(langName, identPattern, jsx, angleDisambig, commentRepoKeys(grammar), blockCommentMatchers(grammar));
    for (const [key, pattern] of Object.entries(jsxPatterns)) repository[key] = pattern;
    // The disambiguated, expression-position triggers go at the very top (before
    // #generic-call / #comparison): a `<` at expression-start with a tag-shaped
    // lookahead is JSX, never a comparison/generic (those follow a value operand).
    topPatterns.push({ include: '#jsx-self-closing-element-in-expression' });
    topPatterns.push({ include: '#jsx-element-in-expression' });
    topPatterns.push({ include: '#jsx-fragment-in-expression' });
    for (const tok of grammar.tokens) {
      const t = tokenPatternLiteralText(tok);
      if (t === jsx.selfCloseTok || t === jsx.closeTok) jsxOwnedTokens.add(tok.name);
    }
  }

  // ── 1b. Detect regex literal disambiguation ──
  const regexInfo = detectRegexLiteral(grammar, tokenNames);
  if (regexInfo) {
    const rlPatterns = generateRegexLiteralPatterns(regexInfo, langName);
    for (const [key, pattern] of Object.entries(rlPatterns)) {
      repository[key] = pattern;
    }
    if (rlPatterns['regex-literal-prefix-ops']) topPatterns.push({ include: '#regex-literal-prefix-ops' });
    topPatterns.push({ include: '#regex-literal' });
  }

  // ── 2. Token patterns ──
  // Comment repository keys, collected in declaration order, so type contexts
  // (a multiline generic arg list spans several lines) can re-include them —
  // the official grammar allows a comment anywhere a type may appear.
  const commentIncludeKeys = commentRepoKeys(grammar);
  // Repository keys of the grammar's STRING- and NUMBER-family literal tokens,
  // collected in declaration order as their repo entries are built below. These
  // are the leaf literals that can appear inside a TYPE expression (a literal
  // type — `type X = "foo" | 1`, a generic arg `Foo<"a">`, a literal param-type
  // annotation), so the type-context regions (#type-inner et al.) re-include them
  // to KEEP the string/number scope instead of letting the literal fall through
  // to the region's own `meta.type.*` name. The classification is the same
  // scope-family test the token loop already uses, so the set is fully derived
  // from the grammar's own token scopes — no hardcoded `"`/digit literals.
  const literalLiteralKeys: string[] = [];
  const literalTokenNames = new Set<string>();
  const rememberLiteralKey = (scope: string, repoKey: string, tokName?: string) => {
    if (scope.startsWith('string.') || scope.startsWith('constant.numeric')) {
      literalLiteralKeys.push(repoKey);
      if (tokName) literalTokenNames.add(tokName);
    }
  };
  for (const tok of grammar.tokens) {
    // Skip @regex tokens — handled by regex literal disambiguation above
    if (tok.flags.includes('regex')) continue;
    // Skip JSX delimiter tokens (`/>`, `</`) — scoped as tag punctuation inside
    // the JSX patterns, not as a flat `variable.other` token match.
    if (jsxOwnedTokens.has(tok.name)) continue;

    const classified = classifyToken(tok);
    const scope = tok.scope ?? classified.scope;  // @scope override wins
    const isBlock = classified.isBlock;
    const key = tok.name.toLowerCase();

    if (scope === 'string.quoted.other.template') {
      const tmplEscape = tokenEscapePatternSource(tok) ?? '\\\\.';
      const tmplDelimChar = escapeRegex(tok.template?.open ?? tokenPatternLiteralPrefix(tok) ?? '`');
      const tmplPatterns: (TmPattern | { include: string })[] = [
        { match: tmplEscape, name: `constant.character.escape.${langName}` },
      ];
      if (tok.template) {
        tmplPatterns.push({
          begin: escapeRegex(tok.template.interpOpen),
          beginCaptures: { '0': { name: `punctuation.definition.template-expression.begin.${langName}` } },
          end: escapeRegex(tok.template.interpClose),
          endCaptures: { '0': { name: `punctuation.definition.template-expression.end.${langName}` } },
          name: `meta.embedded.expression.${langName}`,
          patterns: [{ include: '$self' }],
        });
      }
      repository[key] = {
        name: `${scope}.${langName}`,
        begin: tmplDelimChar,
        beginCaptures: { '0': { name: `punctuation.definition.string.template.begin.${langName}` } },
        end: tmplDelimChar,
        endCaptures: { '0': { name: `punctuation.definition.string.template.end.${langName}` } },
        patterns: tmplPatterns,
      };
      topPatterns.push({ include: `#${key}` });

    } else if (tokenEscapePatternSource(tok) && scope.startsWith('string.')) {
      // String with escape sequences: generate begin/end for each delimiter
      const escapePat: TmPattern = { match: tokenEscapePatternSource(tok)!, name: `constant.character.escape.${langName}` };
      // Highlight-only interpolation regions (e.g. env-spec `${…}` / `$(…)`): each becomes a nested
      // begin/end region — the same shape a template literal's hole gets. `begin`/`end` are
      // author-supplied regex SOURCES (not literals), so they are NOT re-escaped here.
      const interpPats: TmPattern[] = (tok.interpolation ?? []).map((interp) => {
        const p: TmPattern = { begin: escapeRegex(interp.begin), end: escapeRegex(interp.end), patterns: [{ include: interp.include ?? '$self' }] };
        if (interp.beginScope) p.beginCaptures = { '0': { name: `${interp.beginScope}.${langName}` } };
        if (interp.endScope) p.endCaptures = { '0': { name: `${interp.endScope}.${langName}` } };
        if (interp.contentScope) p.name = `${interp.contentScope}.${langName}`;
        return p;
      });
      const stringPats: (TmPattern | { include: string })[] = [escapePat, ...interpPats];
      const delimiters: [string, string][] = [];
      // Drive the delimiter scope off the EXTRACTED delimiter generically: `"`/`'` keep their
      // canonical scopes; any other delimiter (e.g. a backtick string) takes the token's own scope
      // instead of the old loop's `"`-fallback (which mis-delimited backtick strings).
      const scopeForDelim = (d: string) => d === '"' ? 'string.quoted.double' : d === "'" ? 'string.quoted.single' : scope;
      for (const delim of tokenPatternStringDelimiters(tok)) {
        delimiters.push([delim, scopeForDelim(delim)]);
      }
      if (delimiters.length === 0) delimiters.push(['"', scope]); // fallback: no delimiter extractable

      if (delimiters.length === 1) {
        const [delim, delimScope] = delimiters[0];
        repository[key] = {
          name: `${delimScope}.${langName}`,
          begin: escapeRegex(delim),
          beginCaptures: { '0': { name: `punctuation.definition.string.begin.${langName}` } },
          end: `${escapeRegex(delim)}|$`,
          endCaptures: { '0': { name: `punctuation.definition.string.end.${langName}` } },
          patterns: stringPats,
        };
        topPatterns.push({ include: `#${key}` });
        rememberLiteralKey(delimScope, key, tok.name);
      } else {
        // Multiple delimiters: generate separate entries
        for (const [delim, delimScope] of delimiters) {
          const subKey = delim === '"' ? `${key}-double` : `${key}-single`;
          repository[subKey] = {
            name: `${delimScope}.${langName}`,
            begin: escapeRegex(delim),
            beginCaptures: { '0': { name: `punctuation.definition.string.begin.${langName}` } },
            end: `${escapeRegex(delim)}|$`,
            endCaptures: { '0': { name: `punctuation.definition.string.end.${langName}` } },
            patterns: stringPats,
          };
          topPatterns.push({ include: `#${subKey}` });
          rememberLiteralKey(delimScope, subKey, tok.name);
        }
      }

    } else if (tok.string && scope.startsWith('string.') && tokenPatternQuoteDelimAndEscape(tok)) {
      // A quote-delimited string token that carries NO @escape declaration (e.g. YAML's
      // double/single-quoted scalars). A flat `match` is line-bounded, but such a string can
      // legally span newlines (a YAML flow scalar folds across lines). Emit a begin/end REGION
      // — which naturally spans lines — deriving the delimiter and the in-string escape SHAPE
      // (`\.` backslash-escape vs a doubled delimiter like `''`) straight from the token regex.
      // JS/TS strings declare an @escape and take the escapePattern branch above, so they are
      // untouched; this fires only for the otherwise-flat quoted-string token.
      const { delim, escape } = tokenPatternQuoteDelimAndEscape(tok)!;
      const isDoubledDelim = escape === escapeRegex(delim) + escapeRegex(delim);
      // A BACKSLASH-based escape string (e.g. YAML double-quoted): the valid escapes are scoped
      // constant.character.escape; any OTHER `\.` is an INVALID escape and must still be highlighted
      // (monogram#12 #5 — `"quoted \' scalar"`: `\'` is not a valid YAML escape but must not read as
      // plain string content). The invalid catch is listed AFTER the valid pattern (same start → the
      // valid escape wins the tie; only an unrecognised `\.` falls to it). NOT added for a doubled-
      // delimiter escape (`''`), where a lone `\` is literal content, not an escape.
      const escapePatterns: TmPattern[] = [{ match: escape, name: `constant.character.escape.${langName}` }];
      if (!isDoubledDelim) escapePatterns.push({ match: '\\\\.', name: `invalid.illegal.constant.character.escape.${langName}` });
      const region: TmPattern = {
        name: `${scope}.${langName}`,
        begin: escapeRegex(delim),
        beginCaptures: { '0': { name: `punctuation.definition.string.begin.${langName}` } },
        end: escapeRegex(delim),
        endCaptures: { '0': { name: `punctuation.definition.string.end.${langName}` } },
        patterns: escapePatterns,
      };
      // A doubled-delimiter escape (`''`) shares its first char with the region's `end`, so the
      // escape pattern must be tried BEFORE the end (else `'a''b'` closes at the inner pair).
      if (isDoubledDelim) region.applyEndPatternLast = true;
      repository[key] = region;
      topPatterns.push({ include: `#${key}` });
      rememberLiteralKey(scope, key, tok.name);

    } else if (tok.string && scope.startsWith('entity.name.tag')
        && tokenPatternPrefixBeforeTrailingLookahead(tok)
        && tokenPatternQuoteDelimAndEscape({ pattern: tokenPatternPrefixBeforeTrailingLookahead(tok)!.body })) {
      // A quoted KEY (`"a\nb": v` / `'a''b': v`) — scoped entity.name.tag, NOT string.*, so it skips
      // the value-string region above and would emit as a FLAT token, leaving its in-string escapes
      // un-sub-scoped. Emit a begin/end region so the escapes become constant.character.escape, but
      // GATE the begin on a lookahead that the close delim is followed by the key separator — the
      // token's OWN body + trailing key-sep lookahead, minus the opening delim — so a quoted VALUE
      // (no trailing separator) still falls through to its own string region. The delim/escape come
      // from the token's body (the 3-part `delim content delim`, after the key-sep lookahead is split
      // off); all derived from the token.
      const { delim, escape } = tokenPatternQuoteDelimAndEscape({ pattern: tokenPatternPrefixBeforeTrailingLookahead(tok)!.body })!;
      const region: TmPattern = {
        name: `${scope}.${langName}`,
        begin: `${escapeRegex(delim)}(?=${tokenPatternSource(tok).slice(escapeRegex(delim).length)})`,
        beginCaptures: { '0': { name: `punctuation.definition.string.begin.${langName}` } },
        end: escapeRegex(delim),
        endCaptures: { '0': { name: `punctuation.definition.string.end.${langName}` } },
        patterns: [{ match: escape, name: `constant.character.escape.${langName}` }],
      };
      if (escape === escapeRegex(delim) + escapeRegex(delim)) region.applyEndPatternLast = true;
      repository[key] = region;
      topPatterns.push({ include: `#${key}` });
      rememberLiteralKey(scope, key, tok.name);

    } else if (isBlock) {
      const blockDelims = tokenPatternBlockDelimiters(tok);
      const blockSources = tokenPatternBlockDelimiterSources(tok);
      const beginDelim = blockSources?.[0] ?? escapeRegex(blockDelims?.[0] ?? tokenPatternLiteralPrefix(tok) ?? '');
      const endDelim = blockSources?.[1] ?? escapeRegex(blockDelims?.[1] ?? '');

      const blockEntry: TmPattern = {
        name: `${scope}.${langName}`,
        begin: beginDelim,
        end: endDelim,
      };
      // @embed(lang) — embedded language inside the block.
      // Mark the region with `meta.embedded.block.<lang>` (a content scope, kept
      // even when a real sub-grammar is generated so the embedded-region marker
      // survives). Avoid `include: source.X` since vscode-textmate skips the
      // entire begin/end rule when an included grammar fails to resolve.
      if (tok.embed) {
        blockEntry.contentName = `meta.embedded.block.${tok.embed}`;
        // For embeds we can DERIVE a sub-grammar for, emit one and inject it into
        // the block region instead of leaving the body a single flat token. The
        // dispatch is keyed on the language-agnostic `embed` hint, so the host
        // grammar (JS, TS, …) needn't know anything about the embedded language.
        if (tok.embed === 'jsdoc') {
          const jsdoc = generateJsdocPatterns(langName);
          for (const [jk, jv] of Object.entries(jsdoc)) repository[jk] = jv;
          // The comment delimiters get the punctuation scope (official parity);
          // the `#docblock` sub-grammar then highlights tags / type-expressions.
          const commentPunct = `punctuation.definition.comment.${langName}`;
          blockEntry.beginCaptures = { '0': { name: commentPunct } };
          blockEntry.endCaptures = { '0': { name: commentPunct } };
          blockEntry.patterns = [{ include: '#docblock' }];
        }
      }
      repository[key] = blockEntry;
      topPatterns.push({ include: `#${key}` });

    } else {
      // The bare-identifier catch-all is scoped `variable.other.readwrite` — the
      // TextMate convention for a mutable variable *reference* (what hand-written
      // grammars use as their identifier default). `variable.other` alone is the
      // internal sentinel that *identifies* the identifier token (see identToken
      // above); the EMITTED scope refines it to the readwrite leaf so themes that
      // key on the full path color it like the official grammar. Same family
      // (`variable`) → correctness is unchanged; only the path is finer.
      const emittedScope = tok === identToken ? `${scope}.readwrite` : scope;
      repository[key] = {
        // A space-separated scope (e.g. `string.unquoted constant.language` for a YAML plain
        // scalar that resolves to a constant) becomes a multi-scope TM name — each part namespaced
        // with `langName` independently. No-op for the common single-scope case.
        name: emittedScope.split(' ').map(s => `${s}.${langName}`).join(' '),
        // The bare-identifier rule must scope non-ASCII names too (`Ω`, Cyrillic `А`).
        match: tok === identToken ? identPattern : tokenPatternSource(tok),
      };
      topPatterns.push({ include: `#${key}` });
      // Numeric-literal tokens (decimal/hex/octal/binary/bigint) land here — record
      // them so a literal type (`type X = 1 | 2`) keeps its `constant.numeric` scope.
      if (tok !== identToken) rememberLiteralKey(emittedScope, key, tok.name);
    }
  }

  // ── 2a. Block scalar (`|` / `>`) — a real begin/end region replacing the dead `(?!)` token ──
  // The BlockScalar token is emitted by the lexer's indentation state machine (its pattern is a
  // `never()` placeholder), so the flat token loop above produced a dead `(?!)` match for it and
  // the verbatim body was never scoped — it fell through to the comment / plain rules (`# x` inside
  // a body became a comment, the scalar "ended early", tabs mis-scoped). In TextMate the construct
  // is a REGION: the `|`/`>` introducer (+ optional indentation / chomping indicators) opens it and
  // the more-indented lines below are opaque string content, NEVER re-scanned. Everything is DERIVED
  // from `indent.blockScalar`: the introducer chars and the header signature, which mirrors the
  // lexer's `blockScalarSig` so the highlighter opens a region at EXACTLY the positions the parser
  // tokenises a BlockScalar — and never on a `|`/`>` that is plain-scalar content (`a: b | c`),
  // since the lookahead requires the rest of the header line to be only indicators + an optional
  // ` #comment`.
  const blockScalar = grammar.indent?.blockScalar;
  // Block-scalar helpers shared with §2b (the `? |` explicit-key block scalar): the introducer
  // sub-pattern, the funky body builder, the inner introducer rule, and the header-prefix includes.
  // Assigned inside §2a; reused in §2b so both block-scalar shapes use one portable structure.
  let bsIntro = '';
  let bsFunkyIntroRule: ((indicatorScope: string, contentScope: string) => TmPattern) | null = null;
  let bsHeaderIncludes: { include: string }[] = [];
  let bsIndicatorScope = '';
  let bsContentScope = '';
  if (blockScalar) {
    // YAML structural literals DERIVED from the indent config (kept data-driven, NOT hardcoded in the
    // generator) — used by the block-scalar value-prefix (`bsVp`) and the multi-line plain-scalar fold
    // regions (§2a′/§2a″): the comment introducer, the compact indicators (`-`/`?`) as an alternation
    // and a char class, the document markers (`---`/`...`), the flow brackets (for the key-scan
    // exclusion class), and the mapping key/value separator (`:`). The one structural literal WITHOUT a
    // dedicated field — node-property `&`/`!` in `bsProp` below — is anchor/tag-specific (it comes from
    // the Anchor/Tag tokens, not the indent config) and stays inline.
    const ind = grammar.indent!;
    const cmtLit = escapeRegex(ind.comment ?? '#');
    const compactAlt = (ind.compactIndicators ?? []).map((c) => `${escapeRegex(c)}[\\t ]`).join('|');
    const compactCls = `[${(ind.compactIndicators ?? []).map(escapeForCharClass).join('')}]`;
    const docAlt = (blockScalar.documentMarkers ?? []).map(escapeRegex).join('|');
    const flowEx = `[^\\n${[...(ind.flowOpen ?? []), ...(ind.flowClose ?? [])].map(escapeForCharClass).join('')}]`;
    const kvSep = escapeRegex(ind.keyValueSeparator ?? ':');
    const bsTok = grammar.tokens.find(t => t.name === blockScalar.token);
    const bsKey = blockScalar.token.toLowerCase();
    const bsScope = bsTok?.scope ?? 'string.unquoted.block';
    const introClass = `[${blockScalar.introducers.map(escapeForCharClass).join('')}]`;
    // introducer + indentation/chomping indicators (a digit and a `+`/`-`, in either order, or a
    // lone `+`/`-`), then a lookahead requiring the rest of the header line to be blank or a comment.
    const indicators = '(?:[1-9][-+]?|[-+][1-9]?|[-+])?';
    const intro = `${introClass}${indicators}`;
    const commentIncs = commentIncludeKeys.map(k => ({ include: `#${k}` }));
    const bsContent = `${bsScope}.${langName}`;
    // The introducer (`|`/`>` + chomping/indent) is a structural control sigil, not body content. Every
    // OTHER YAML indicator (`:`/`[`/`{`/`,`/`?`/`&`/`*`/`!`) is scoped non-string; the block-scalar
    // introducer was the lone exception (it inherited the body's string scope). Re-scope it via the
    // grammar's opt-in indicatorScope; absent → the body scope (legacy, introducer reads as content).
    const bsIndicator = blockScalar.indicatorScope ? `${blockScalar.indicatorScope}.${langName}` : bsContent;
    // A block scalar BODY must scope `string.unquoted.block` across EMPTY lines. A flat `begin`/`end`
    // region (the old textmate/yaml.tmbundle shape) collapses at the first LEADING empty line: the
    // inner indent rule has not opened yet, nothing is consumed, and the `(?!\G)` arm of the `end`
    // fires (vscode-textmate#114 — a top-level region's `\G` anchor dies once a line is not contiguous
    // with the begin's captured EOL). The maintained RedCMD grammar survives empties only because its
    // block scalar sits many `while: \G` regions deep and each parent re-anchors `\G` at every line,
    // blank ones included. We replicate the MINIMAL slice of that nesting, in three PORTABLE pieces
    // (no variable-length lookbehind — those are rejected by TextMate 2.0/Onigmo and GitHub-Linguist):
    //   1. a `meta.stream` parent (`begin: ^(?!\G)`/`while: ^`) wraps ALL top patterns (added at the
    //      grammar root below) so `\G` is re-anchored every line — the empty-line survival lever.
    //   2. the BODY is RedCMD's "funky wrapper" (`begin: $`/`while: \G`): three sub-rules auto-detect
    //      the content indent `\1`, scope it `string.unquoted.block`, and — via the middle rule's
    //      `end: \G(?!\1)(?=[\t ]*#)` — release at a SHALLOWER comment line (so a dedented `# c` is a
    //      real comment, not swallowed). Empty-line-proof.
    //   3. the OUTER region bounds SIBLINGS by the NODE indentation, captured by a FORWARD group: the
    //      begin starts AT LINE START `^([ \t]*)` and CONSUMES the indent into `\1`, with a lookahead
    //      (the value-prefix `bsVp` below) confirming the line actually carries a value-position block
    //      scalar. `while: \G(?=\1[ \t]|[ \t]*$)` continues while a line is blank or indented past the
    //      node and ends at a sibling at the node column. The header line's key / `:` / anchor / tag
    //      are re-scoped by the normal token includes (`bsHeaderIncs`) since the indent consume put
    //      them INSIDE the region; an inner `bsIntroRule` matches the `|`/`>` introducer (+ trailing
    //      comment) and runs the funky body.
    // Because the begin matches at LINE START it competes at column 0 with `#key`/quoted-keys (which
    // also start there); on a same-start tie oniguruma picks the FIRST listed pattern, so these rules
    // are ranked ABOVE the key/scalar tokens in scopeOrder. Their lookahead requires a real
    // `[|>]…(#|$)` value-position header, so they never steal a non-block-scalar line.
    const funkyBody = (content: string) => [
      {
        begin: '$',
        while: '\\G',
        patterns: [
          { begin: '\\G( ++)$', while: '\\G(?>(\\1)$|(?!\\1)( *+)($|.))', contentName: content },
          {
            begin: '\\G(?!$)(?=( *+))',
            end: '\\G(?!\\1)(?=[\\t ]*+#)',
            patterns: [
              { begin: '\\G( *+)', while: '\\G(?>(\\1)|( *+)($|[^\\t#]|[\\t ]++[^#]))', contentName: content },
            ],
          },
          { begin: '(?!\\G)(?=[\\t ]*+#)', while: '\\G', patterns: commentIncs },
        ],
      },
    ];
    // Inner introducer rule: leading `[\t ]*` skips the separator whitespace (the space after `:`/`-`),
    // captures the `|`/`>` (+indicators) and the rest-of-line trailing comment, then runs the funky
    // body (its `begin: $` opens at the header-line EOL). `while: \G` keeps it alive across the body.
    const bsIntroRule = (indicatorScope: string, contentScope: string) => ({
      begin: `[\\t ]*(${intro})(?=[\\t ]*(?:#|$))([\\t ]*.*)`,
      beginCaptures: { '1': { name: indicatorScope }, '2': { patterns: commentIncs } },
      while: '\\G',
      patterns: funkyBody(contentScope),
    });
    // The `|N`/`>N` indentation indicator (a digit with optional chomping in either order). For the
    // EXPLICIT-indent block scalars (§2a‴) the digit is LITERAL (one region per digit), so the floor is
    // known and the body needs no funky auto-detect: a simpler inner rule opens at the header EOL and
    // paints every line the outer `\1 {N}` bound admits as block content via `contentName` (a deeper
    // key-/comment-shaped body line is therefore NOT re-scoped — it is opaque block string).
    const bsDigitAlt = (n: number) => `(?:${n}[-+]?|[-+]${n})`;
    const bsExplicitIntroRule = (n: number) => ({
      begin: `[\\t ]*(${introClass}${bsDigitAlt(n)})(?=[\\t ]*(?:#|$))([\\t ]*.*)`,
      beginCaptures: { '1': { name: bsIndicator }, '2': { patterns: commentIncs } },
      while: '\\G',
      contentName: bsContent,
    });
    // Header-prefix token includes: re-scope the part of the header line BEFORE the introducer (a doc
    // marker / key / `:` / anchor / tag), since the line-start indent consume swallowed the engine
    // position past them. Derived from what this grammar actually emits (an unresolved include is a
    // no-op in vscode-textmate, but we list only the keys that exist to keep the grammar clean). The
    // explicit-key entries are emitted in §2b (after this block) so they are gated by the same
    // `detectExplicitKey` predicate; punctuation is emitted late so it is included unconditionally
    // here (an indentation grammar with a block scalar always has the `:`/`-` punctuation token).
    const bsHasExplicitKey = !!detectExplicitKey(grammar);
    const bsHeaderIncs = [
      ...(repository['docstart'] ? [{ include: '#docstart' }] : []),
      ...(repository['docend'] ? [{ include: '#docend' }] : []),
      ...(bsHasExplicitKey ? [{ include: '#explicit-key' }, { include: '#explicit-key-indicator' }] : []),
      ...(repository['dquotekey'] ? [{ include: '#dquotekey' }] : []),
      ...(repository['squotekey'] ? [{ include: '#squotekey' }] : []),
      ...(repository['key'] ? [{ include: '#key' }] : []),
      ...(repository['anchor'] ? [{ include: '#anchor' }] : []),
      ...(repository['tag'] ? [{ include: '#tag' }] : []),
      { include: '#punctuation' },
    ];
    // Value-PREFIX: the structural lead-in that may precede a value-position introducer on its header
    // line AFTER the node indent is stripped. A genuine `|`/`>` introducer is the FIRST value token, so
    // only separators (sequence dash `-`, explicit-key `?`, doc markers `---`/`...`), an optional
    // mapping key + `:` separator, and node properties (anchors `&` / tags `!`) may sit before it —
    // never plain-scalar content. This is what stops `a: foo|` / `a: foo |` (plain scalars that merely
    // END in a pipe) from opening a region: after `a: ` the next token is `foo`, not a separator/
    // key-colon/property, so the lookahead fails. The key arm matches up to the FIRST `: ` separator.
    const bsProp = '(?:[&!][^\\t\\n\\f\\r \\[\\]{},]*[\\t ]+)*';
    const bsVp = `(?:(?:${docAlt})[\\t ]+)?(?:${compactCls}[\\t ]+)*(?:[^\\n]*?${kvSep}[\\t ]+)?${bsProp}`;
    // Expose the introducer / inner-rule / header-includes to §2b (the `? |` explicit-key variant).
    bsIntro = intro;
    bsFunkyIntroRule = bsIntroRule;
    bsHeaderIncludes = bsHeaderIncs;
    bsIndicatorScope = bsIndicator;
    bsContentScope = bsContent;
    repository[bsKey] = emitIndentRegion({
      lookahead: `(?=${bsVp}${intro}[\\t ]*(?:#|$))`,
      cont: '\\1[ \\t]',
      patterns: [bsIntroRule(bsIndicator, bsContent), ...bsHeaderIncs],
    });
    // DOCUMENT-ROOT block scalar (`--- |` / bare `|` at column 0, NO mapping key / sequence dash
    // before it). Such a node sits at the document level, whose indentation is "-1", so its body may
    // begin at COLUMN 0 (W4TN `--- |` / M7A3 bare `|`, both valid YAML). The node-indent–bounded
    // `${bsKey}` region above fails here: its `while: \G(?=\1[ \t]|…)` has `\1` = the EMPTY column-0
    // node indent, so `\1[ \t]` degenerates to `[ \t]` (one leading space REQUIRED) and a column-0
    // body line matches neither arm → the region ends after the header and the body falls through to
    // the directive/key tokens (a `%`-led body line mis-scopes as a directive). A document-root scalar
    // is instead bounded by the next column-0 DOCUMENT MARKER (`---`/`...`) or EOF — exactly how the
    // maintained RedCMD grammar bounds it (its block scalar sits under the document region whose
    // `while: \G(?!(?:…|---)…)` releases only at a marker). Derived from `indent.blockScalar`: the
    // introducer chars (`intro`) and the `documentMarkers` (the only YAML-specific literals, read from
    // config — never hardcoded). The funky body still AUTO-DETECTS the content indent, so a doc-root
    // scalar with an INDENTED body releases at its dedent too; only a genuinely column-0 body (indent
    // 0) runs to the marker. Ranked ABOVE `${bsKey}` (scopeOrder) so it wins this column-0 case; its
    // lookahead requires the introducer to be the FIRST value token (after an optional marker), so it
    // never steals a `key: |` / `- |` / nested header (those keep their node-indent regions).
    const docMarkers = blockScalar.documentMarkers;
    if (docMarkers && docMarkers.length) {
      const docMarkAlt = docMarkers.map(escapeRegex).join('|');
      const docMark = `(?:${docMarkAlt})(?=[\\t ]|$)`;
      repository[`${bsKey}-doc`] = {
        begin: `^()(?=(?:${docMark}[\\t ]+)?${intro}[\\t ]*(?:#|$))`,
        while: `\\G(?!${docMark})`,
        patterns: [bsIntroRule(bsIndicator, bsContent), ...bsHeaderIncs],
      };
      topPatterns.push({ include: `#${bsKey}-doc` });
    }
    // Sequence entry whose mapping VALUE is the block scalar (`- a: |` … `  b:`): bound siblings at the
    // KEY column, not the dash column, else the next entry key is swallowed. The begin consumes the
    // leading indent `\1` AND the dash + its trailing spaces `\3`, and the bound `\1[ \t]\3[ \t]` is
    // one column past the key. A pure-space backref (`\1`, `\3`) standing in for the dash column keeps
    // it portable (no literal `- ` backref, which would never match space-indented body lines).
    repository[`${bsKey}-seq`] = emitIndentRegion({
      lookahead: `(-)([ \\t]+)(?=(?:[-?][\\t ]+)*[^\\n]*?:[\\t ]+${bsProp}${intro}[\\t ]*(?:#|$))`,
      beginCaptures: { '2': { name: `punctuation.${langName}` } },
      cont: '\\1[ \\t]\\3[ \\t]',
      patterns: [bsIntroRule(bsIndicator, bsContent), ...bsHeaderIncs],
    });
    topPatterns.push({ include: `#${bsKey}-seq` });

    // ── 2a‴. EXPLICIT-indent block scalars (`|N` / `>N`, monogram#12 #10) ──
    // An explicit indentation indicator (`|5`) PINS the content indent at parent+N, OVERRIDING the
    // funky body's auto-detect (which floors at the FIRST content line's indent). With `abc: |5` whose
    // first body line is at column 6, auto-detect floors at 6, so a real body line at column 5
    // (`# string 5`) is then SHALLOWER than the detected floor and RELEASED — re-scanned as a comment.
    // The fix pins the floor to parent+N. TextMate cannot use a CAPTURED digit as a repeat count
    // portably (RedCMD does, via Oniguruma `{\N}` backref-as-count + conditionals + subroutines — all
    // rejected by Onigmo / GitHub-Linguist), so the only portable spelling is a region per digit with a
    // LITERAL `{N}` count. Same structure as the auto-detect block scalars (forward-captured node indent
    // + an inner introducer rule that opens the body at the header EOL); only two things change: the
    // `while` bound is `\1 {N}` (parent+N) instead of `\1[ \t]` (parent+1), and the inner rule paints
    // the body via `contentName` instead of the funky auto-detect (the floor is already known). Emitted
    // for digits 1–9 in both value position (`key: |N`, nested, and doc-root `|N` / `--- |N` — `bsVp`
    // admits the optional `---` / key / properties) and sequence position (`- a: |N`, whose floor adds
    // the dash column via `\3` — same as `-seq`). Ranked above the auto-detect variants (scopeOrder).
    for (let n = 1; n <= 9; n++) {
      repository[`${bsKey}-explicit-${n}`] = emitIndentRegion({
        lookahead: `(?=${bsVp}${introClass}${bsDigitAlt(n)}[\\t ]*(?:#|$))`,
        cont: `\\1 {${n}}`,
        patterns: [bsExplicitIntroRule(n), ...bsHeaderIncs],
      });
      topPatterns.push({ include: `#${bsKey}-explicit-${n}` });
      repository[`${bsKey}-explicit-seq-${n}`] = emitIndentRegion({
        lookahead: `(-)([ \\t]+)(?=(?:[-?][\\t ]+)*[^\\n]*?:[\\t ]+${bsProp}${introClass}${bsDigitAlt(n)}[\\t ]*(?:#|$))`,
        beginCaptures: { '2': { name: `punctuation.${langName}` } },
        cont: `\\1[ \\t]\\3 {${n}}`,
        patterns: [bsExplicitIntroRule(n), ...bsHeaderIncs],
      });
      topPatterns.push({ include: `#${bsKey}-explicit-seq-${n}` });
    }

    // ── 2a′. Multi-line PLAIN scalar continuation (monogram#12 §6/§7) ──
    // A plain scalar may FOLD across a more-indented continuation line (`key: a\n  b` → "a b";
    // `? e\n  42` → the key "e 42"). The parser's lexer folds these into one scalar token, but a
    // flat per-line TextMate grammar cannot see that a deeper line is the CONTINUATION of the scalar
    // above it — so a continuation line that opens with a token-like char (`!`/digit/`%`) is wrongly
    // re-scanned as a tag / number / directive (`#tag`/`#num`/`#directive` fire at top level). The
    // HEADER line is already scoped correctly by the normal token includes (`#plain` paints the value),
    // so the fix is a REGION that consumes only the DEEPER continuation lines as opaque
    // `string.unquoted`, BEFORE those token rules get a chance. This mirrors the parser's `foldedPlain`
    // (`Plain Indent Plain* Dedent`): a value-position plain scalar followed by a MORE-indented run of
    // BARE plain lines (a continuation line is never a `key:`/`-`/`?` node — that would be a sibling).
    // Structure reuses the block-scalar region (§2a): the begin captures the node indent with a FORWARD
    // group `^([ \t]*)`; the `while` continues into BLANK lines and DEEPER lines that are BARE plain
    // content, and RELEASES at a SIBLING at the node column (so a same-column doc-body fold —
    // monogram#12 §9 — never over-fires) AND at the first deeper STRUCTURAL line (a mapping `key:`, seq
    // `- `, explicit `? `, or a comment). Releasing at a structural line is what lets a compact nested
    // mapping (`- a: x\n  b: 1`), a nested block scalar (`a: x\n  b: |`), or a comment line fall back to
    // the TOP-LEVEL patterns (which scope `b`/`|`/`#…` correctly) instead of being swallowed as string —
    // it mirrors the parser's foldedPlain, whose continuation is bare `Plain` lines only. The header
    // line is re-scoped by the normal token includes (`plainHeaderIncs`, matched at the value position
    // the begin's indent-consume leaves the engine at); a `continuationRule` matches each DEEPER
    // bare-plain line (`\G[\t ]+…`, which only fires at a re-anchored line start, so it never touches the
    // header line) and scopes it as string, stopping before an inline ` #` comment (which then falls to
    // `#comment`). Gated on a plain-scalar token, so the OTHER six grammars (no `#plain`) regenerate
    // byte-identical.
    // Whether — and HOW — this grammar's plain scalars fold is DETECTED from its rules (detectFold):
    // a deeper continuation (`Indent <leaf> … Dedent`) → the §2a′ region, a same-column continuation
    // (`Newline <leaf>`) → the §2a″ region. A grammar whose plain scalars never fold gets NEITHER (no
    // over-emission). This drives the fold-region emission FROM the grammar's fold rules — the same
    // rules the parser uses — rather than from the `repository['plain']` proxy.
    const fold = detectFold(grammar);
    if (repository['plain'] && fold) {
      // The plain-scalar match, used ONLY as a zero-width `(?=plainSrc)` value-head probe below. The
      // flow→block body loosening (`loosenBlockScalar`, in the flow section further down) runs AFTER
      // this point, so this is the flow-body snapshot — irrelevant here, since a lookahead only needs
      // the HEAD char class (identical in both variants) to confirm a plain value opens the line.
      const plainSrc = repository['plain'].match!;
      // The continuation is PLAIN-scalar content, so it takes the plain token's own scope
      // (`string.unquoted.<lang>`) — not the block-scalar body scope `bsContent`
      // (`string.unquoted.block.<lang>`), which would mis-label a folded plain run as a block scalar.
      const plainContent = repository['plain'].name!;
      // A line (after its leading indent) that opens a STRUCTURAL node or comment, NOT plain content:
      // a `#` comment, a `- `/`? ` indicator (a `-1`/`?x` plain scalar is NOT one — the indicator needs
      // a trailing space), or a mapping key (`…: ` / `…:`-EOL). `[^\n{}\[\]]*?` stops the key scan at a
      // flow bracket (a `{`/`[` is flow, handled elsewhere), and `:(?:[\t ]|$)` requires the colon to be
      // a real key separator (`http://x` keeps its glued `:` → still plain content). Used as a NEGATIVE
      // lookahead to bound the fold at the first sibling/comment line, matching the parser's foldedPlain.
      const structAhead = `(?:${cmtLit}|${compactAlt}|${flowEx}*?${kvSep}(?:[\\t ]|$))`;
      // Value-position lookahead: after the node indent is stripped, the line must carry an INLINE
      // BLOCK plain value — either `<key>: <plain>` (mapping value) or a `-`/`?` indicator + `<plain>`
      // (sequence entry / explicit key). The plain value is confirmed by `(?=plainSrc)`, which only
      // succeeds on a real plain-scalar head — so a tag/anchor/quoted/`|`/`>` value never triggers it,
      // and a BARE `key:` introducing a NESTED block (no inline value, EOL after `:`) is excluded
      // because both arms REQUIRE a value: the `:` arm needs `:[\t ]+` (colon + space + plain), and the
      // indicator arm needs `[-?][\t ]+` + plain. This is what keeps `key:\n  nested: v` and the bare
      // `a: b\nc: d` sibling out of the fold. The mapping-key run is `[^\n{}\[\]]*?` (NO flow brackets):
      // a flow collection (`{ a: b,\n  c }` / `a: { b: c,\n  d }`) is a multi-line begin/end region of
      // its own — a `{`/`[` before the `:` means the `:` is a FLOW separator, not a block one, so the
      // region must NOT open and steal those lines from #flow-mapping/#flow-sequence.
      // The key-scan up to the `:` separator. A leading / embedded QUOTED scalar is consumed as one
      // WHOLE escape-aware token (`fc.dq`/`fc.sq`) so its INTERNAL `:` is never mistaken for the key
      // separator: a line-start double/single-quoted scalar with an inner colon (`"a: b"`) is ONE
      // scalar, not a `key: value`, and must NOT open a fold (it falls to #dquote/#squote). The bare
      // run excludes the quote chars so a quote can ONLY match via the token branch — otherwise the
      // engine skips the (optional) token and the bare class re-swallows the opening quote, re-mis-
      // reading the inner colon. Derived from the grammar's quoted-scalar tokens; a grammar with no
      // quoted scalar keeps the plain `flowEx` scan (byte-identical).
      const fcQuote = detectFlowCollections(grammar);
      const quotedScalarToks = [fcQuote?.dq, fcQuote?.sq].filter((s): s is string => !!s);
      const quoteCharCls = quotedScalarToks.map(t => escapeForCharClass(t[0] === '\\' ? t.slice(0, 2) : t[0])).join('');
      const keyToSep = quotedScalarToks.length
        ? `(?:${quotedScalarToks.join('|')}|${flowEx.slice(0, -1)}${quoteCharCls}])*?`
        : `${flowEx}*?`;
      const plainVp = `(?:(?:${docAlt})[\\t ]+)?(?:(?:${compactCls}[\\t ]+)+(?:${keyToSep}${kvSep}[\\t ]+)?|${keyToSep}${kvSep}[\\t ]+)(?=${plainSrc})`;
      // Header-line token includes: the same shape any plain `key: value` line gets, so the header is
      // scoped identically to the top level (only the CONTINUATION changes). Includes the typed-value
      // tokens (`#num`/`#boolnull`) so a SINGLE-line `a: 1` keeps `constant.numeric`, and the full
      // key/sequence/comment set so a deeper STRUCTURAL line (which continuationRule skips) is scoped
      // correctly. Listed only when the key exists.
      const plainHeaderIncs = [
        ...(repository['docstart'] ? [{ include: '#docstart' }] : []),
        ...(repository['docend'] ? [{ include: '#docend' }] : []),
        ...(bsHasExplicitKey ? [{ include: '#explicit-key' }, { include: '#explicit-key-indicator' }] : []),
        ...(repository['dquotekey'] ? [{ include: '#dquotekey' }] : []),
        ...(repository['squotekey'] ? [{ include: '#squotekey' }] : []),
        ...(repository['key'] ? [{ include: '#key' }] : []),
        ...(repository['anchor'] ? [{ include: '#anchor' }] : []),
        ...(repository['alias'] ? [{ include: '#alias' }] : []),
        ...(repository['tag'] ? [{ include: '#tag' }] : []),
        ...(repository['num'] ? [{ include: '#num' }] : []),
        ...(repository['boolnull'] ? [{ include: '#boolnull' }] : []),
        { include: '#plain' },
        ...(repository['comment'] ? [{ include: '#comment' }] : []),
        { include: '#punctuation' },
      ];
      // The continuation-line consumer: `\G[\t ]+` anchors at a re-anchored LINE START with ≥1 leading
      // space (so it never matches the header line, where the engine sits past the indent) — the `while`
      // has already proven the line is a bare-plain continuation — and the body `(?:[^#\n]|#(?<=\S#))*`
      // swallows the line as one opaque plain run, stopping before an inline ` #` comment (a `#` is
      // content only when glued to a non-space, exactly as the plain-scalar body treats it) so the
      // comment falls to `#comment`. Scoped with the plain string scope.
      const continuationRule = { match: '\\G[\\t ]+(?:[^#\\n]|#(?<=[^\\t\\n\\f\\r ]#))*', name: plainContent };
      // Emitted only when the grammar actually has a DEEPER fold (`Indent <leaf> … Dedent`).
      if (fold.hasDeeper) {
        repository['plain-continuation'] = emitIndentRegion({
          lookahead: `(?=${plainVp})`,
          cont: `\\1[ \\t]+(?!${structAhead})`,
          blankFirst: true,
          patterns: [continuationRule, ...plainHeaderIncs],
        });
        topPatterns.push({ include: '#plain-continuation' });
      }

      // ── 2a‴. Multi-line EXPLICIT-KEY continuation (`? a\n  true`) ──
      // An explicit key (`? a`) may FOLD across deeper continuation lines exactly like a plain value —
      // `? a\n  true` is the ONE key "a true" (CST: a single key scalar). #plain-continuation already
      // opens on `? a` (its `?` is in `compactCls`), but it scopes the continuation as the VALUE plain
      // scope (`string.unquoted`); a KEY continuation must instead take the KEY scope (entity.name.tag),
      // so the folded key reads consistently with its first line (which #explicit-key scopes as the key).
      // Same structure as #plain-continuation, but pinned to the explicit-key INDICATOR (so a `- ` seq /
      // `key:` value fold stays on #plain-continuation) and the continuation takes the key scope. Ranked
      // ABOVE #plain-continuation (scopeOrder) so a `? `-led header takes the key-scoped continuation.
      const ekFold = detectExplicitKey(grammar);
      if (ekFold && fold.hasDeeper) {
        const ekContRule = { match: '\\G[\\t ]+(?:[^#\\n]|#(?<=[^\\t\\n\\f\\r ]#))*', name: `${ekFold.keyScope}.${langName}` };
        repository['explicit-key-continuation'] = emitIndentRegion({
          lookahead: `(?=${escapeRegex(ekFold.indicator)}[\\t ]+(?:${keyToSep}${kvSep}[\\t ]+)?(?=${plainSrc}))`,
          cont: `\\1[ \\t]+(?!${structAhead})`,
          blankFirst: true,
          patterns: [ekContRule, ...plainHeaderIncs],
        });
        topPatterns.push({ include: '#explicit-key-continuation' });
      }

      // ── 2a″. BARE plain-scalar SAME-COLUMN fold (monogram#12 §9) ──
      // A plain scalar that is itself a NODE (a document value, or the leading value of an indented
      // block) — NOT a `key:`/`-`/`?` — folds across SAME-COLUMN as well as deeper continuation lines:
      // `scalar\n%YAML 1.2` is the ONE plain scalar "scalar %YAML 1.2" (the `%YAML` line is plain
      // CONTENT, not a directive). The §2a′ region only handles a DEEPER continuation under an
      // inline-value header (`key: v\n  cont`); a bare scalar's continuation may sit at its OWN column,
      // which §2a′'s strictly-deeper `\1[ \t]+` misses. This region begins ONLY on a BARE plain scalar
      // line (a plain head that is NOT a mapping key, sequence `- `, explicit `? `, doc marker, comment,
      // or flow/quoted/anchor/tag — those are excluded by `structRelease`/the plain head class) and
      // folds forward over same-column-OR-deeper lines that are bare plain content, RELEASING at the
      // first STRUCTURAL line (a `key:`/`- `/`? `/doc marker/comment) at any depth and at a DEDENT below
      // the node column. Because it opens only on a BARE plain scalar and releases at structural lines,
      // a mapping/sequence sibling never folds: `a: b\nc: d` — both lines are keys, so it never opens;
      // `- a\n- b\nc` — the `-` lines are structural. The header line is scoped by the normal includes;
      // an inner `begin:$`/`while:\G` body swallows each following line as `string.unquoted` (stopping
      // before an inline ` #` comment, which then falls to `#comment`). structRelease extends §2a′'s
      // `structAhead` with the doc markers (a `---`/`...` ends a doc-body fold).
      const structRelease = `(?:${cmtLit}|${compactAlt}|(?:${docAlt})(?:[\\t ]|$)|${flowEx}*?${kvSep}(?:[\\t ]|$))`;
      // The HEADER line is scoped by the normal token includes (so a standalone bare `42`/`true` keeps
      // its `#num`/`#boolnull` typing). A CONTINUATION line that opens with a non-token char (`%`, which
      // no header include matches) would leave that char unscoped and let a LATER `#plain` claim only the
      // tail (`%YAML` → `%` unscoped + `YAML` string). A leftmost catch-all fixes this: `bareCont` is a
      // plain-body run with NO `\G` anchor, so on a continuation line it matches from column 0 (the `%`)
      // — leftmost-wins beats the `#plain` match that starts one char later — scoping the WHOLE line
      // string.unquoted; on the HEADER line the includes match at the same (leftmost) position and, being
      // listed first, win the tie, so header typing is preserved. It stops before a ` #` comment (a `#`
      // is content only when glued to a non-space, as the plain body treats it).
      const bareCont = { match: '(?:[^#\\n]|#(?<=[^\\t\\n\\f\\r ]#))+', name: plainContent };
      // Emitted only when the grammar actually has a SAME-COLUMN fold (`Newline <leaf>`).
      if (fold.hasSameColumn) {
        repository['plain-bare-fold'] = emitIndentRegion({
          lookahead: `(?=${plainSrc})(?!${structRelease})`,
          cont: `\\1(?=[ \\t]*\\S)(?![ \\t]*${structRelease})`,
          blankFirst: true,
          patterns: [...plainHeaderIncs, bareCont],
        });
        topPatterns.push({ include: '#plain-bare-fold' });
      }
    }
  }

  // ── 2b. Explicit mapping key (`? key`) ──
  // An indentation grammar may flag a mapping key by a PRECEDING indicator instead of a
  // trailing separator (YAML `? key`). The key scalar then has no `:` and the flat token loop
  // above scopes it as an ordinary string; re-scope the scalar that immediately follows the
  // indicator as a key. A flat per-token rule can't see the preceding indicator, but a
  // contextual MATCH can — the indicator is captured in the same rule. Derived from the grammar
  // (the indicator literal, the key scope, the key body); null for non-indentation grammars.
  const explicitKey = detectExplicitKey(grammar);
  if (explicitKey) {
    // `(indicator)( whitespace )(optional node-prefix: anchors/tags)(key-scalar)` on one line — the
    // dominant explicit-key shape. The node-prefix decorators (`? &a key` / `? !!t key`) get one
    // CAPTURING group per scope so they are scoped (anchor/tag), not silently consumed; the key
    // scalar's capture index follows them: 1=indicator, 2=ws, 3…N=prefix scopes, N+1=key.
    const prefixCaps: Record<string, { name: string }> = {};
    const prefixAlts: string[] = [];
    let grp = 3;
    for (const pg of explicitKey.prefixGroups) {
      prefixAlts.push(`(${pg.pattern})`);
      prefixCaps[String(grp)] = { name: `${pg.scope}.${langName}` };
      grp++;
    }
    const prefixGroup = prefixAlts.length ? `(?:(?:${prefixAlts.join('|')})[\\t ]+)*` : '';
    repository['explicit-key'] = {
      match: `(${escapeRegex(explicitKey.indicator)})([\\t ]+)${prefixGroup}(${explicitKey.keyBody})`,
      captures: {
        '1': { name: `punctuation.definition.map.key.${langName}` },
        ...prefixCaps,
        [String(grp)]: { name: `${explicitKey.keyScope}.${langName}` },
      },
    };
    topPatterns.push({ include: '#explicit-key' });

    // The explicit-key INDICATOR alone on its line — a multi-line / collection key whose body is on
    // the FOLLOWING lines (`?\n- a\n- b\n: …`), so the same-line `? key` rule above doesn't reach it.
    // Scope the bare indicator as the same map-key punctuation. The blank/comment-only rest-of-line
    // lookahead keeps it from stealing a `?` that is plain-scalar content (a plain scalar that merely
    // ends in `?` is matched as one token starting earlier, so leftmost-match leaves this alone).
    repository['explicit-key-indicator'] = {
      match: `(${escapeRegex(explicitKey.indicator)})(?=[\\t ]*(?:#|$))`,
      captures: { '1': { name: `punctuation.definition.map.key.${langName}` } },
    };
    topPatterns.push({ include: '#explicit-key-indicator' });

    // A block scalar can ALSO be an explicit key (`? |` / `? >`). An implicit key must be a single
    // line, so a multi-line block scalar key is ALWAYS `?`-introduced. The block scalar itself is
    // scoped like ANY block scalar — introducer (`|`/`>`) → the block-scalar keyword, body →
    // string.unquoted.block — and the KEY-ness is carried by the `?` (map-key punctuation) + the `:`
    // separator, NOT by recolouring the body as a name. (`|`/`>` is a control sigil, never a name; and
    // a block scalar should read the SAME in key or value position — the official grammar does exactly
    // this.) Same PORTABLE structure as §2a (forward-captured node indent + funky body), gated on the
    // `?` indicator. Ranked above the value-position block scalar (scopeOrder) so `? |` wins; a `: |`
    // value has no leading `?`, so it is untouched.
    if (blockScalar && bsFunkyIntroRule) {
      repository['blockscalar-key'] = {
        begin: `^([ \\t]*)(${escapeRegex(explicitKey.indicator)})([\\t ]+)(?=${bsIntro}[\\t ]*(?:#|$))`,
        beginCaptures: { '2': { name: `punctuation.definition.map.key.${langName}` } },
        while: '\\G(?=\\1[ \\t]|[ \\t]*$)',
        patterns: [bsFunkyIntroRule(bsIndicatorScope, bsContentScope), ...bsHeaderIncludes],
      };
      topPatterns.push({ include: '#blockscalar-key' });
    }
  }

  // ── 2b′. Malformed directive line (monogram#12 #4) ──
  // A directive owns its whole line (§6.8): `%YAML 1.2 foo` is an ILLEGAL directive (bad arity), and
  // the parser rejects it — YamlDirective's arity lookahead fails and the generic Directive excludes
  // the `%YAML␣` prefix, so NEITHER token matches and the trailing `foo` falls through to the plain-
  // scalar tokens, which paint it as a stray `string.unquoted`. But a `%` can never BEGIN a plain
  // scalar (YAML §7.3.3 — `%` is a c-indicator, excluded from ns-plain-first), so a `%`-led line the
  // clean directive tokens did NOT claim is always a malformed directive, never real scalar content.
  // Re-scope the whole line AS A DIRECTIVE (keyword.other.directive) — the malformed trailing token is
  // directive content (#4 `%YAML 1.2 foo`, #8 glued `%YAML 1.1#…`), and Monogram highlights questionable-
  // but-renderable content NORMALLY rather than splashing `invalid.illegal` (the #12 #3 stance; this also
  // matches the neutral `yaml`-CST oracle, which recovers such a line as a directive). The indicator
  // (`%`) is read from the directive tokens' leading literal (never hardcoded); ranked just BELOW the
  // clean directives and ABOVE the plain scalars (scopeOrder 6.5) so it only catches what they left and
  // beats the stray-scalar mis-scope. Highlight-only — the parser still rejects the line. The `^` anchor
  // pins it to a line-start `%` (an indented `%` mid-line — e.g. a `key: %v` value — stays a scalar).
  const directiveToks = grammar.tokens.filter(t => /(^|\.)keyword\.other\.directive(\.|$)/.test(t.scope ?? ''));
  if (directiveToks.length) {
    const lead = directiveToks.map(t => tokenPatternLeadingSource(t)).find((s): s is string => !!s);
    const indicator = lead ? [...lead][0] : '';
    if (indicator) {
      repository['directive-malformed'] = {
        match: `^[ \\t]*(${escapeRegex(indicator)}[^\\n]*?)[\\t ]*$`,
        captures: { '1': { name: `keyword.other.directive.${langName}` } },
      };
      topPatterns.push({ include: '#directive-malformed' });
    }
  }

  // ── 2c. Flow collections (`{ … }` mapping / `[ … ]` sequence) as nested begin/end regions ──
  // A flat token grammar mis-scopes a flow mapping's keys (the enclosing bracket — invisible to a
  // context-free token — decides whether an entry-leading scalar is a key or a sequence value).
  // Emit nested begin/end regions (the TM scope stack carries flow depth) modelled on the
  // maintained RedCMD grammar: inside a MAPPING the entry-leading scalar is a key (entity.name.tag),
  // inside a SEQUENCE a scalar is a key only when a `:` separator follows. All shapes — bracket
  // pair, `:`/`,` separators, plain/quoted scalar patterns, key scope — are DERIVED (see
  // detectFlowCollections); null for every non-flow grammar, so other families are untouched.
  const flow = detectFlowCollections(grammar);
  if (flow) {
    const ln = langName;
    const P = `punctuation.${ln}`;
    // Resolve a DECLARED bare scope (from indent.flowScopes) to a full scope, or fall back to the
    // generic `P`. The grammar supplies the language-flavoured names (mapping/sequence/key-value);
    // the engine only appends the language suffix — so gen-tm stays agnostic (no hardcoded names).
    const withLang = (bare: string | null): string => bare ? `${bare}.${ln}` : P;
    const kvScope = withLang(flow.keyValueScope);          // the flow-mapping `:` key/value separator
    const ekScope = withLang(flow.explicitKeyScope);       // the flow `?` explicit-key indicator
    // Comment includes (derived from the grammar's comment-scoped tokens — not a hardcoded key),
    // spread into every flow sub-region so a `#…` comment is scoped even mid-entry / mid-value.
    const commentIncs = commentIncludeKeys.map(k => ({ include: `#${k}` }));
    const start = flow.plainStart;                 // plain-scalar leading char class (bare)
    // The flow-boundary char class: every flow bracket (open AND close) + the entry separator
    // (`{`,`}`,`[`,`]`,`,`). A flow scalar/entry/value ends before any of them — a `,` (next entry),
    // a closer (`}`/`]`), or a nested-collection opener (`{`/`[`, which begins the value). The
    // key/value separator colon is NOT a boundary char (it separates key from value WITHIN an
    // entry); it is handled by the dedicated colonSep branch below.
    const closers = [...new Set(flow.colls.flatMap(c => [c.open, c.close, c.sep]))];
    const closeCls = closers.map(escapeForCharClass).join('');     // for a [...] class
    const colon = flow.colls.map(c => c.colon).find(Boolean) ?? ':';
    const eColon = escapeRegex(colon);
    // A flow scalar ENDS before: a separator-colon (`:` + flow-indicator/space/EOL), any closer
    // (`,`/`}`/`]`), or a ` #` comment. (No `$` — a multi-line flow scalar spans lines.)
    const colonSep = `${eColon}(?=[\\s${closeCls}]|$)`;
    const flowEnd = `(?=[\\t ]*(?:${colonSep}|[${closeCls}])|(?:^|[\\t ])#)`;
    const beforeClose = `(?=[${closeCls}])`;       // entry/value end: before a closer
    // Does a `:` separator follow the upcoming plain scalar? (sequence single-pair-map test)
    const hasColonAhead = `(?=(?:${start})(?:[^${escapeForCharClass(colon)}#${closeCls}]|${eColon}(?![\\s${closeCls}])|(?<=\\S)#)*${colonSep})`;

    // Build the quoted-key region for a string-flagged quote token (carries entity.name.tag). The
    // quote DELIMITER is the token pattern's first char (derived, never a hardcoded `"`/`'`), and
    // applyEndPatternLast is set when the escape IS the doubled quote (`''`) — otherwise an empty
    // `''` would be read as close-then-reopen instead of one escaped quote.
    const quoteChar = (pat: string): string => pat[0] === '\\' ? pat.slice(0, 2) : pat[0];
    const quoteKeyRegion = (q: string, scope: string, esc: string | null): TmPattern => ({
      name: `${scope}.${ln} ${flow.keyScope}.${ln}`,
      begin: escapeRegex(q), beginCaptures: { '0': { name: `punctuation.definition.string.begin.${ln}` } },
      end: escapeRegex(q), endCaptures: { '0': { name: `punctuation.definition.string.end.${ln}` } },
      ...(esc ? { patterns: [{ match: esc, name: `constant.character.escape.${ln}` }] } : {}),
      ...(esc === q + q ? { applyEndPatternLast: true } : {}),
    });
    const quoteIncludes: { include: string }[] = [];
    const quoteChars: string[] = [];
    if (flow.dq && flow.dqScope) { const q = quoteChar(flow.dq); quoteChars.push(q); repository['flow-key-double'] = quoteKeyRegion(q, flow.dqScope, flow.dqEscape); quoteIncludes.push({ include: '#flow-key-double' }); }
    if (flow.sq && flow.sqScope) { const q = quoteChar(flow.sq); quoteChars.push(q); repository['flow-key-single'] = quoteKeyRegion(q, flow.sqScope, flow.sqEscape); quoteIncludes.push({ include: '#flow-key-single' }); }
    const quoteCls = quoteChars.map(escapeForCharClass).join('');   // for a [...] class
    // A quoted-scalar match (for the sequence map-key lookahead "quoted then colon").
    const quoteAlts = [flow.dq, flow.sq].filter(Boolean) as string[];

    // The VALUE colon (a flow separator `:`); and the JSON-style value colon glued after a closed
    // key (`{"a":b}` — `:` preceded by a quote/closer/line-start, where no space-separator exists).
    repository['flow-map-value'] = {
      begin: colonSep, beginCaptures: { '0': { name: kvScope } }, end: beforeClose,
      patterns: [...commentIncs, { include: '#flow-node' }],
    };
    repository['flow-map-value-json'] = {
      begin: `(?<=[${quoteCls}${closeCls}])[\\t ]*${eColon}|(?<=^)[\\t ]*${eColon}`,
      beginCaptures: { '0': { name: kvScope } }, end: beforeClose,
      patterns: [...commentIncs, { include: '#flow-node' }],
    };
    // A plain scalar as a VALUE / as a KEY (entity.name.tag); both end at the flow boundary.
    repository['flow-plain'] = { begin: `(?=${start})`, end: flowEnd, name: `${flow.plainScope}.${ln}` };
    repository['flow-key-plain'] = { begin: `\\G(?=${start})`, end: flowEnd, name: `${flow.plainScope}.${ln} ${flow.keyScope}.${ln}` };

    // A flow NODE = any value in flow context (nested collection, alias/anchor/tag, quoted, typed,
    // plain). The decorator/scalar token includes are taken from the grammar's existing token keys.
    const has = (k: string) => !!repository[k];
    const nodeIncludes: { include: string }[] = [...commentIncs];
    for (const c of flow.colls) nodeIncludes.push({ include: c.colon ? '#flow-mapping' : '#flow-sequence' });
    for (const k of ['anchor', 'tag', 'alias', 'dquote', 'squote', 'num', 'boolnull']) if (has(k)) nodeIncludes.push({ include: `#${k}` });
    nodeIncludes.push({ include: '#flow-plain' });
    const seenInc = new Set<string>();
    repository['flow-node'] = { patterns: nodeIncludes.filter(p => !seenInc.has(p.include) && seenInc.add(p.include)) };

    // The explicit `? key` indicator (if the grammar models one): a `?` followed by a flow
    // boundary opens a key region. Derived from the explicit-key indicator when present.
    const qmark = explicitKey ? escapeRegex(explicitKey.indicator) : null;
    const explicitKeyEntry: TmPattern[] = qmark ? [{
      begin: `${qmark}(?=[\\s${closeCls}]|$)`, beginCaptures: { '0': { name: ekScope } }, end: beforeClose,
      patterns: [...commentIncs, { include: '#flow-mapping-map-key' }, { include: '#flow-map-value' }, { include: '#flow-node' }],
    }] : [];

    // Emit one region per collection. A MAPPING (`colon != null`): every entry-leading scalar is a
    // key. A SEQUENCE: a scalar is a key only when a `:` separator follows (single-pair map element).
    for (const c of flow.colls) {
      const eOpen = escapeRegex(c.open), eClose = escapeRegex(c.close), eSep = escapeRegex(c.sep);
      // The SPECIFIC open/close/separator scopes the grammar declared for THIS collection (mapping vs
      // sequence — the names are the grammar's, not the engine's); null → the generic `P`.
      const beginScope = c.punct ? `${c.punct.begin}.${ln}` : P;
      const endScope = c.punct ? `${c.punct.end}.${ln}` : P;
      const sepScope = c.punct ? `${c.punct.separator}.${ln}` : P;
      if (c.colon) {
        // A YAML flow mapping `{ … }` is a bracket region. CALLER predicate: detectFlowCollections
        // found a collection rule (`OPEN … CLOSE` seq) whose entry rule carries a `:` key/value
        // separator (`c.colon != null`). Recurse is via the body's `#flow-node` include (which
        // re-includes #flow-mapping/#flow-sequence for nested collections).
        repository['flow-mapping'] = emitBracketRegion({
          name: `meta.flow.mapping.${ln}`,
          openLit: eOpen, closeLit: eClose, beginCapName: beginScope, endCapName: endScope,
          bodyPatterns: [
            ...commentIncs, { match: eSep, name: sepScope },
            { include: '#flow-mapping-map-key' }, { include: '#flow-map-value-json' }, { include: '#flow-map-value' }, { include: '#flow-node' },
          ],
        });
        repository['flow-mapping-map-key'] = {
          patterns: [
            ...explicitKeyEntry,
            ...(quoteIncludes.length ? [{
              begin: `(?=[${quoteCls}])`, end: beforeClose,
              patterns: [...commentIncs, ...quoteIncludes, { include: '#flow-map-value-json' }, { include: '#flow-map-value' }],
            }] : []),
            { begin: `(?=${start})`, end: beforeClose,
              patterns: [...commentIncs, { include: '#flow-key-plain' }, { include: '#flow-map-value' }] },
          ],
        };
      } else {
        // A YAML flow sequence `[ … ]` is a bracket region. CALLER predicate: same collection-rule
        // shape, but the entry rule has NO `:` separator (`c.colon == null`). Same #flow-node recurse.
        repository['flow-sequence'] = emitBracketRegion({
          name: `meta.flow.sequence.${ln}`,
          openLit: eOpen, closeLit: eClose, beginCapName: beginScope, endCapName: endScope,
          bodyPatterns: [
            ...commentIncs, { match: eSep, name: sepScope },
            { include: '#flow-sequence-map-key' }, { include: '#flow-map-value-json' }, { include: '#flow-map-value' }, { include: '#flow-node' },
          ],
        });
        repository['flow-sequence-map-key'] = {
          patterns: [
            ...explicitKeyEntry,
            ...(quoteAlts.length ? [{
              begin: `(?=(?:${quoteAlts.join('|')})[\\t ]*${eColon})`, end: beforeClose,
              patterns: [...commentIncs, ...quoteIncludes, { include: '#flow-map-value-json' }, { include: '#flow-map-value' }],
            }] : []),
            { begin: `(?<=[\\t ${closeCls}]|^)${hasColonAhead}`, end: beforeClose,
              patterns: [...commentIncs, { include: '#flow-key-plain' }, { include: '#flow-map-value' }] },
          ],
        };
      }
    }
    // Top-level: the flow regions open on a `{`/`[` (which a plain scalar can never lead, so no
    // overlap with the scalar tokens); ranked before #punctuation so the bracket opens the region.
    for (const c of flow.colls) topPatterns.push({ include: c.colon ? '#flow-mapping' : '#flow-sequence' });

    // ── Block-context plain scalars absorb the flow-indicator chars (`{`,`}`,`[`,`]`,`,`) ──
    // These chars are indicators ONLY inside a flow region (now handled above); in BLOCK context
    // they are ordinary plain-scalar content (`- bla]keks: foo`, a key with `]`; a key full of
    // `[]{},` punctuation — yaml-test-suite AZW3 / 2EBW). The shared token EXCLUDES them from its
    // body (the parser's context-free lexer needs that to stop a flow scalar at a `,`/`]`), but the
    // block-context TM rule — reached only OUTSIDE a flow region (the flow regions never include the
    // top-level plain/key tokens; they use #flow-plain/#flow-key-plain) — can safely absorb them.
    // Transform: in the broad plain scalar (string.unquoted) and its key variant (the key scope),
    // drop the flow-boundary chars from the BODY's NEGATED character classes only — never from the
    // LEADING char (a scalar still can't START with `{`/`[`, which opens a flow region) nor from the
    // trailing key-separator's POSITIVE lookahead. Derived from `flowOpen`/`flowClose`/separator, so
    // it is agnostic and fires only for an indentation grammar that declares flow collections.
    const boundaryChars = new Set(flow.colls.flatMap(c => [c.open, c.close, c.sep]));
    const firstGroupLen = (pat: string): number => {
      if (pat[0] !== '(') return 0;
      let depth = 0;
      for (let i = 0; i < pat.length; i++) {
        if (pat[i] === '\\') { i++; continue; }
        if (pat[i] === '(') depth++;
        else if (pat[i] === ')') { depth--; if (depth === 0) return i + 1; }
      }
      return 0;
    };
    // Remove the boundary chars from every NEGATED class `[^…]` in `s` (positive classes untouched).
    // Handles both bare (`,`,`{`,`}`) and escaped (`\[`,`\]`) forms of a boundary char in the class.
    const stripBoundaryFromNegatedClasses = (s: string): string =>
      s.replace(/\[\^((?:\\.|[^\]\\])*)\]/g, (whole, inner: string) => {
        let out = '', i = 0;
        while (i < inner.length) {
          if (inner[i] === '\\') {
            if (boundaryChars.has(inner[i + 1])) { i += 2; continue; }   // drop escaped boundary char
            out += inner.slice(i, i + 2); i += 2; continue;
          }
          if (boundaryChars.has(inner[i])) { i++; continue; }            // drop bare boundary char
          out += inner[i++];
        }
        return `[^${out}]`;
      });
    const loosenBlockScalar = (pat: string): string => {
      const lead = firstGroupLen(pat);
      if (!lead) return pat;
      return pat.slice(0, lead) + stripBoundaryFromNegatedClasses(pat.slice(lead));
    };
    // Identify the block plain & key repo entries by their DERIVED scopes (not by name) and loosen.
    for (const entry of Object.values(repository)) {
      if (!entry.match || !entry.name) continue;
      const scope = entry.name.replace(new RegExp(`\\.${ln}$`), '');
      if (scope === flow.plainScope || scope === flow.keyScope) entry.match = loosenBlockScalar(entry.match);
    }
  }

  // ── 3. Collect all literals from rules ──
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

  const typeRuleNames = new Set(
    grammar.rules.filter(r => r.flags.includes('type')).map(r => r.name)
  );
  const hasTypeAnnotations = typeRuleNames.size > 0 && hasColonTypeAnnotation(grammar, typeRuleNames);

  // Ensure simple-type exists for type annotation inner patterns
  if (hasTypeAnnotations && !repository['simple-type']) {
    repository['simple-type'] = {
      match: identPattern,
      name: `entity.name.type.${langName}`,
    };
  }

  // Type-paren: (...) inside type contexts for grouped types and arrow function types
  const hasParenType = grammar.rules.some(r =>
    r.flags.includes('type') && collectLiterals(r.body).includes('(')
  );
  if (hasParenType && hasTypeAnnotations) {
    repository['type-paren'] = {
      begin: '\\(',
      end: '\\)',
      // patterns filled after type-inner is built
    };
  }

  // Type-bracket: `[ … ]` inside type contexts — a TUPLE type (`[A, B]`) or an
  // indexed-access type's index (`T[K]`). Without this region a tuple's inner `,`
  // (or an object-type member's `: [A, B]` value) prematurely satisfies the
  // enclosing type region's `end` (`#type-object-member` ends on `,`), so every
  // element after the first falls back to value mode. Modelled exactly like
  // #type-paren (recurse via #type-inner), keyed on the SAME signal — the grammar's
  // @type rules containing `[` and `]` (typeLiterals) — so it is agnostic and emitted
  // only when the language actually has bracket types. It is included in #type-inner
  // AFTER the `\[\]` empty-array-suffix match, so `T[]` still reads as an array
  // operator and only a `[` carrying content opens the tuple region.
  const hasBracketType = grammar.rules.some(r =>
    r.flags.includes('type') && collectLiterals(r.body).includes('[') && collectLiterals(r.body).includes(']')
  );
  if (hasBracketType && hasTypeAnnotations) {
    repository['type-bracket'] = {
      begin: '\\[',
      beginCaptures: { '0': { name: `punctuation.definition.block.${langName}` } },
      end: '\\]',
      endCaptures: { '0': { name: `punctuation.definition.block.${langName}` } },
      // patterns filled after type-inner is built
    };
  }

  // Type-object-type: { key: Type; ... } inside type contexts
  // Detect if any @type rule has '{' ... '}' alternatives
  const hasObjectType = grammar.rules.some(r =>
    r.flags.includes('type') && collectLiterals(r.body).includes('{')
  );
  if (hasObjectType && hasTypeAnnotations) {
    // Detect if the grammar has a private-field-like token (for member ident pattern)
    const hasPrivateFieldsForType = grammar.tokens.some(t => tokenPatternLiteralPrefix(t)?.startsWith('#'));
    const objMemberIdent = hasPrivateFieldsForType ? `#?${identPattern}` : identPattern;
    repository['type-object-member'] = {
      name: `meta.type.annotation.member.${langName}`,
      begin: `(${objMemberIdent})(\\??)(\\s*:)`,
      beginCaptures: {
        '1': { name: `variable.object.property.${langName}` },
        '2': { name: `keyword.operator.optional.${langName}` },
        '3': { name: `keyword.operator.type.annotation.${langName}` },
      },
      end: '(?=[;},])',
      // patterns filled after type-inner is built
    };
    repository['type-object-type'] = {
      name: `meta.object-type.${langName}`,
      begin: '\\{',
      beginCaptures: { '0': { name: `punctuation.definition.block.${langName}` } },
      end: '\\}',
      endCaptures: { '0': { name: `punctuation.definition.block.${langName}` } },
      // patterns filled after type-inner is built
    };
  }

  // Type predicate pattern: `ident <kw> Type` (e.g., TypeScript's `n is number`)
  // Detect: alphabetic keyword.operator.* keywords that exist ONLY in the scopes
  // section (not in grammar rules or prec table). These are type-level binary
  // operators that separate a subject from its predicate type.
  // Must come before simple-type so the subject gets variable.parameter.
  const typePredicateKws = [...scopeOverrides.entries()]
    .filter(([kw, scopes]) =>
      isKeywordLiteral(kw) &&
      !kw.startsWith('.') &&
      !allLiterals.has(kw) &&
      scopes.some(s => s.startsWith('keyword.operator'))
    );
  if (typePredicateKws.length > 0 && hasTypeAnnotations) {
    const kwAlt = typePredicateKws.map(([kw]) => escapeRegex(kw)).join('|');
    const kwScope = typePredicateKws[0][1][0]; // use first keyword's scope
    repository['type-predicate'] = {
      match: `(${identPattern})\\s+(${kwAlt})\\b`,
      captures: {
        '1': { name: `variable.parameter.${langName}` },
        '2': { name: `${kwScope}.${langName}` },
      },
    };
  }

  // Collect literals that appear in @type rules — used to conditionally include
  // type operators (|, &, [], =>) instead of hardcoding them.
  const typeLiterals = new Set<string>();
  for (const rule of grammar.rules) {
    if (rule.flags.includes('type')) {
      for (const lit of collectLiterals(rule.body)) {
        typeLiterals.add(lit);
      }
    }
  }

  // Literal types — a STRING/NUMBER literal can stand as a type (`type X =
  // "foo" | 1`, a generic arg `Foo<"a">`, a literal param-type `(p: "on") =>`).
  // If any @type rule references one of the grammar's string/number literal
  // tokens, re-include those leaf token repo entries inside the type context so
  // the literal keeps its `string`/`constant.numeric` scope rather than falling
  // through to the enclosing region's `meta.type.*` name. Both the trigger
  // (a literal-token ref reachable from a @type rule) and the included keys are
  // derived from the grammar's own tokens/rules — no hardcoded `"`/digit shapes.
  const typeRefsLiteralToken = literalTokenNames.size > 0 && grammar.rules.some(r => {
    if (!r.flags.includes('type')) return false;
    let found = false;
    const walk = (e: RuleExpr): void => {
      if (found || !e) return;
      switch (e.type) {
        case 'ref': if (literalTokenNames.has(e.name)) found = true; return;
        case 'seq': case 'alt': e.items.forEach(walk); return;
        case 'quantifier': case 'group': case 'not': walk(e.body); return;
        case 'sep': walk(e.element); return;
      }
    };
    walk(r.body);
    return found;
  });
  const literalTypeIncludes: { include: string }[] = typeRefsLiteralToken
    ? literalLiteralKeys.map(k => ({ include: `#${k}` }))
    : [];

  // Shared type inner patterns — exposed as a repository entry so all consumers
  // reference it via `{ include: '#type-inner' }`.  No shared mutable array;
  // later injections rebuild the patterns array non-destructively.
  // Type operators are derived from @type rule literals.
  const typeInnerPats: (TmPattern | { include: string })[] = hasTypeAnnotations ? [
    ...(repository['generic-type'] ? [{ include: '#generic-type' }] : []),
    ...(repository['type-object-type'] ? [{ include: '#type-object-type' }] : []),
    ...(repository['type-paren'] ? [{ include: '#type-paren' }] : []),
    ...(repository['type-predicate'] ? [{ include: '#type-predicate' }] : []),
    // Literal types (string/number literal standing as a type) — before
    // #simple-type so a `"foo"`/`1` keeps its literal scope instead of being
    // swallowed by the surrounding type region's name.
    ...literalTypeIncludes,
    { include: '#simple-type' },
  ] : [];
  // Union/intersection operators — only if present in @type rules
  const typeUnionOps = ['|', '&'].filter(op => typeLiterals.has(op));
  if (typeUnionOps.length > 0) {
    typeInnerPats.push({
      match: `[${typeUnionOps.map(escapeRegex).join('')}]`,
      name: `keyword.operator.type.${langName}`,
    });
  }
  // Array bracket type — only if @type rules contain both [ and ]
  if (typeLiterals.has('[') && typeLiterals.has(']')) {
    typeInnerPats.push({ match: '\\[\\]', name: `keyword.operator.type.array.${langName}` });
    // A `[` carrying content opens the recursive tuple / indexed-access region
    // (#type-bracket), listed AFTER the empty-array match so `T[]` stays an array op.
    if (repository['type-bracket']) typeInnerPats.push({ include: '#type-bracket' });
  }
  // Arrow function type — only if => appears in @type rules
  if (typeLiterals.has('=>')) {
    const arrowScope = getScope(scopeOverrides, '=>') ?? 'storage.type.function.arrow';
    typeInnerPats.push({ match: '=>', name: `${arrowScope}.${langName}` });
  }
  // Type annotation colon and comma
  if (typeLiterals.has(':')) {
    typeInnerPats.push({ match: ':', name: `keyword.operator.type.annotation.${langName}` });
  }
  if (typeLiterals.has(',')) {
    typeInnerPats.push({ match: ',', name: `punctuation.separator.comma.${langName}` });
  }
  // Conditional type `T extends U ? X : Y` — scope the connector (`extends`) and
  // the ternary `?`/`:` like the official `#type-conditional`. The region is
  // anchored on the connector keyword: that anchor is what disambiguates the
  // conditional ternary from an OPTIONAL `?` (`{ a?: T }`) or a tuple `[T?]` —
  // the ternary sub-region only exists once we're past an `extends`. Both the
  // connector and the type-inner key are DERIVED (the connector literal comes
  // from detectConditionalType walking the type rule's `<ref> kw <ref> ? <ref>
  // : <ref>` shape; its scope from the scope map; the recursive `#type` slots
  // reuse #type-inner). The inner `#type-inner` greedily consumes nested types
  // INCLUDING their own colons (object types `{ k: V }`, nested conditionals),
  // so the primary end `(?<=:)` matches only the conditional's own colon, and
  // nested conditionals recurse back through #type-inner → #type-conditional.
  //
  // The extra `(?=[;>])` end bounds a connector that is NOT actually a conditional
  // — chiefly a type-PARAMETER constraint that reached here unshadowed: a prefix
  // cast `<T extends number>(…` is type-shaped but has no `?`, so without a bound
  // the `(?<=:)` end would never match and the region would swallow the rest of
  // the file (the official's #type-conditional has this exact runaway). `;` and
  // `>` can never appear at the conditional's OWN nesting level inside a *valid*
  // check-type — object/paren/generic types (`{…}`, `(…)`, `<…>`) are child
  // regions that consume their own `;`/`>`, so a real `T extends U ? …` always
  // reaches `?` (then `:`) before either — so this bound never truncates a valid
  // conditional, it only lets the cast/constraint `>` (or a malformed `;`) close.
  const condConnector = detectConditionalType(grammar);
  if (condConnector) {
    const connScope = getScope(scopeOverrides, condConnector) ?? 'keyword.other';
    const ternaryScope = `keyword.operator.ternary.${langName}`;
    repository['type-conditional'] = {
      // Anchor on the connector, but NOT a member-access `.extends` (a property
      // named `extends`) — mirrors the official's `(?<!\.)` guard. Allowed after
      // `...` (a rest/spread before the head type). `\b` keeps it off `extendsX`.
      begin: `(?<![_$[:alnum:]])(?:(?<=\\.\\.\\.)|(?<!\\.))(${escapeRegex(condConnector)})\\s+`,
      beginCaptures: {
        '1': { name: `${connScope}.${langName}` },
      },
      end: '(?<=:)|(?=[;>])',
      patterns: [
        {
          begin: '\\?',
          beginCaptures: { '0': { name: ternaryScope } },
          end: ':',
          endCaptures: { '0': { name: ternaryScope } },
          patterns: [{ include: '#type-inner' }],
        },
        { include: '#type-inner' },
      ],
    };
    // Reachable from the type body: insert before #simple-type so the connector
    // opens the conditional region rather than being painted entity.name.type.
    const idx = typeInnerPats.findIndex(p => 'include' in p && p.include === '#simple-type');
    typeInnerPats.splice(idx === -1 ? typeInnerPats.length : idx, 0, { include: '#type-conditional' });
  }

  if (hasTypeAnnotations) repository['type-inner'] = { patterns: typeInnerPats };

  // Wire up deferred type-paren pattern (basic wiring; patched after type injections)
  if (repository['type-paren']) {
    repository['type-paren'].patterns = [{ include: '#type-inner' }];
  }
  // Wire up deferred type-bracket (tuple / indexed-access). A bare ident `[`-adjacent
  // and followed by `:` is an INDEX-SIGNATURE param (`[key: string]`) or a LABELLED
  // tuple element (`[first: A, …]`) — that leading identifier is a binding/parameter
  // name, NOT a type, so a narrow head match scopes it `variable.parameter` (and its
  // `:` as the annotation) BEFORE #type-inner would paint it entity.name.type. The
  // match is anchored to the `[` (lookbehind) and the `:`, so a plain tuple element
  // (`[A, B]`) / indexed-access index (`T[K]`) — ident NOT followed by `:` — falls
  // through to #type-inner and recurses as a type, as intended. (Anchoring on the `[`
  // rather than including the whole #type-object-member region avoids the member
  // rule's `,`/`}` end leaking across tuple elements.)
  // Mapped-type connector keyword(s) — the `in` of `{ [K in T]: V }`. Derived from
  // the grammar's own shape: a `[`-bracketed clause whose body is an identifier
  // immediately followed by an alternation that branches on a RESERVED keyword
  // (`[Ident, alt(['in', Type, …], [':', Type, …])]` in the type-member rule). In a
  // type-context `[…]` this keyword would otherwise be eaten by #simple-type and
  // mis-painted entity.name.type (it is a value-position operator, so it carries no
  // type-context keyword include); a head match restores its keyword scope and
  // paints the mapped key as a type name (matching the official mappedtype rule).
  // Keyword-agnostic: the connector + its scope both come from the grammar.
  const mappedTypeConnectors = new Set<string>();
  {
    const mtIdentName = identToken?.name;
    const walk = (e: RuleExpr | undefined, underBracket: boolean): void => {
      if (!e) return;
      if (e.type === 'seq') {
        const hasBracket = underBracket || e.items.some(it => it.type === 'literal' && it.value === '[');
        for (let i = 0; i < e.items.length; i++) {
          const a = e.items[i], b = e.items[i + 1];
          // Ident-ref directly followed by an alt whose a branch starts with a keyword
          if (hasBracket && a && a.type === 'ref' && a.name === mtIdentName && b && b.type === 'alt') {
            for (const branch of b.items) {
              const head = branch.type === 'seq' ? branch.items[0] : branch;
              if (head && head.type === 'literal' && isKeywordLiteral(head.value)) {
                mappedTypeConnectors.add(head.value);
              }
            }
          }
          walk(a, hasBracket);
        }
      } else if (e.type === 'alt') {
        for (const it of e.items) walk(it, underBracket);
      } else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') {
        walk(e.body, underBracket);
      } else if (e.type === 'sep') {
        walk(e.element, underBracket);
      }
    };
    if (mtIdentName) for (const r of grammar.rules) walk(r.body, false);
  }
  if (repository['type-bracket']) {
    const mappedTypeHeads = [...mappedTypeConnectors]
      .map(kw => ({ kw, scope: getScope(scopeOverrides, kw) }))
      .filter((x): x is { kw: string; scope: string } => !!x.scope)
      .map(({ kw, scope }) => ({
        // `[ K in …` — the mapped key is a type name, the connector keeps its scope.
        match: `(?<=\\[)\\s*(${identPattern})\\s+(${escapeRegex(kw)})\\b`,
        captures: {
          '1': { name: `entity.name.type.${langName}` },
          '2': { name: `${scope}.${langName}` },
        },
      }));
    repository['type-bracket'].patterns = [
      ...mappedTypeHeads,
      {
        match: `(?<=\\[)\\s*(${identPattern})(\\s*:)`,
        captures: {
          '1': { name: `variable.parameter.${langName}` },
          '2': { name: `keyword.operator.type.annotation.${langName}` },
        },
      },
      { include: '#type-inner' },
    ];
  }
  // Wire up deferred type-object patterns now that type-inner exists
  if (repository['type-object-member']) {
    repository['type-object-member'].patterns = [{ include: '#type-inner' }];
  }
  if (repository['type-object-type']) {
    repository['type-object-type'].patterns = [
      { include: '#type-object-member' },
      { include: '#type-inner' },
      { match: ';', name: `punctuation.separator.${langName}` },
    ];
  }

  // Collect alphabetic keywords that can appear inside type expressions
  // (e.g., keyof, typeof, readonly, extends, infer).
  const typeContextKeywords = new Set<string>();
  for (const lit of typeLiterals) {
    if (isKeywordLiteral(lit)) typeContextKeywords.add(lit);
  }

  // Statement-starting keywords: alphabetic literals whose scope indicates
  // they begin a new statement or declaration, and are NOT type-context keywords.
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

  // Build while pattern for type alias continuation.
  // A line continues the type alias if it starts with type-continuation content:
  // type operators, type keywords, comments, or identifiers that aren't statement keywords.
  // The alias body separator (the literal that introduces `= Body`) — the same
  // literal the type-alias detector keys on below (`decl.endHint === '='`), kept
  // in one place so the `while` and the detector agree on what a type alias is.
  const typeAliasSeparator = '=';
  let typeAliasWhile: string | undefined;
  if (typeLiterals.size > 0) {
    // Operators that may LEAD a continuation line (`| A`, `& B`, …). Closing
    // brackets (`]`/`)`/`}`/`>`) and `=>` are excluded — a line that opens with a
    // bare closer normally ENDS the type (it closes an enclosing block), so it
    // must NOT keep the region alive on its own (see the closer-run handling
    // below, which only continues when a closer is FOLLOWED by a type operator).
    const typeContinueOps = [...typeLiterals]
      .filter(l => !isKeywordLiteral(l) && l !== '=>' && l !== ']' && l !== ')' && l !== '}' && l !== '>')
      .map(escapeForCharClass).join('');
    const typeKwAlt = [...typeContextKeywords].map(escapeRegex).join('|');
    const whileParts: string[] = [];
    if (typeContinueOps) whileParts.push(`[${typeContinueOps}]`);
    if (typeKwAlt) whileParts.push(`(?:${typeKwAlt})\\b`);
    whileParts.push('//');
    whileParts.push('/\\*');
    // Multi-line type tail: a continuation line that OPENS with one or more
    // closing brackets that finish a multi-line sub-type (a `}` object body, a
    // `>` type-arg or type-PARAM list, a `)`/`]` paren/tuple) and is then
    // immediately followed by a token that keeps the type going:
    //   • a type-continuation operator `& Other` / `| Extra` (the union/
    //     intersection TAIL after a multi-line body — `} & Other`, `> & Extra`)
    //   • the body-introducing `=` (a multi-line type-PARAMETER list laid out
    //     before the `=`: `type T<\n  P extends X\n> = Body` — line 3 opens with
    //     the `>` that closes the params, then `= Body`)
    // Without this, such a line opened with `}`/`>`/`)`, failed the `while`, and
    // tore the region down — dropping the tail / body to expression mode (the
    // tail's `type.ref` and the body's types lost their scope). The trailing
    // operator/`=` is REQUIRED so a bare enclosing-block closer (`type T = X`
    // then a lone `}` ending a namespace/function body) still terminates the
    // alias. The closing brackets, the operators and the `=` body-introducer are
    // all the grammar's own type/assignment literals — agnostic.
    const typeCloserChars = [...typeLiterals]
      .filter(l => l === ']' || l === ')' || l === '}' || l === '>')
      .map(escapeForCharClass).join('');
    const aliasSep = escapeForCharClass(typeAliasSeparator);
    if (typeCloserChars && typeContinueOps) {
      whileParts.push(`[${typeCloserChars}](?:\\s*[${typeCloserChars}])*\\s*(?=[${typeContinueOps}${aliasSep}])`);
    }
    // Identifiers: must not be statement keywords, and must not be followed
    // by ( or . (which indicate expression statements like foo() or foo.bar).
    // Use \b after the identifier to prevent backtracking to a partial match.
    // The keyword alternation MUST be grouped — `(?:kw1|kw2)\b`, not `kw1|kw2\b` —
    // or the trailing `\b` binds to the LAST alternative only and the others match
    // a mere PREFIX: a continuation line opening with an identifier that starts with
    // a keyword (`getTranslationEntry`, `interfaceName`, `newThing`, `inferred`) would
    // fail the negative lookahead and tear the whole multi-line type region down,
    // dropping the tail to value mode (the type.ref miss this region exists to close).
    if (stmtStartKeywords.size > 0) {
      const stmtAlt = [...stmtStartKeywords].map(escapeRegex).join('|');
      whileParts.push(`(?!(?:${stmtAlt})\\b)${identPattern}\\b(?!\\s*[.(])`);
    } else {
      whileParts.push(`${identPattern}\\b(?!\\s*[.(])`);
    }
    // Zero-width lookahead: the `while` clause only TESTS that the next line
    // continues the type alias — it must not CONSUME the leading token, or it
    // would steal the first identifier / comment-opener of a continuation line
    // from the inner type patterns (e.g. a multiline generic arg list, where
    // the swallowed `string` / `//` then never reaches #type-inner and loses
    // its support.type.primitive / comment scope).
    typeAliasWhile = `^(?=\\s*(?:${whileParts.join('|')}))`;
  }

  // ── 3b. Declaration pattern detection & generation ──
  const declarations = detectDeclarations(grammar, tokenNames);
  const declarationKeywords = new Set(declarations.map(d => d.keyword));

  if (declarations.length > 0) {
    // A `{ … }` declaration body is a bracket region (begin `{` / end `}`), so its depth nests
    // on the scope stack. The CALLER's "this is a region" predicate: `detectDeclarations`
    // returned a decl with a brace body — these `{`/`}` come from a keyword-anchored declaration
    // rule, not from an arbitrary object-literal/binding-pattern `{}`. The bracket literals,
    // delimiter scope, and recurse target (the body's own `#…` include + `$self`) are the only
    // per-region bits; the begin/end skeleton is shared via emitBracketRegion.
    const blockCapName = `punctuation.definition.block.${langName}`;

    // code-block: self-recursive {} for method/function bodies (no class-member patterns)
    repository['code-block'] = emitBracketRegion({
      openLit: '\\{', closeLit: '\\}', beginCapName: blockCapName, endCapName: blockCapName,
      bodyPatterns: [
        { include: '#code-block' },
        { include: '$self' },
      ],
    });

    // declaration-body: {} for class/interface bodies (has method-signature, member-type-annotation)
    repository['declaration-body'] = emitBracketRegion({
      openLit: '\\{', closeLit: '\\}', beginCapName: blockCapName, endCapName: blockCapName,
      bodyPatterns: [
        { include: '#declaration-body' },
        { include: '$self' },
      ],
    });

    // Parameter type annotation + params scope (if lang has type annotations)
    if (declarations.some(d => d.hasParams)) {
      const paramsInnerPatterns: (TmPattern | { include: string })[] = [];

      // Self-recursive nested parens for default values: foo(x = bar())
      repository['nested-parens'] = {
        begin: '\\(',
        end: '\\)',
        patterns: [
          { include: '#nested-parens' },
          { include: '$self' },
        ],
      };

      if (hasTypeAnnotations) {
        repository['param-type-annotation'] = {
          name: `meta.type.annotation.parameter.${langName}`,
          begin: `(\\.\\.\\.)?\\s*(${identPattern})(\\??)(\\s*:)`,
          beginCaptures: {
            '1': { name: `keyword.operator.spread.${langName}` },
            '2': { name: `variable.parameter.${langName}` },
            '3': { name: `keyword.operator.optional.${langName}` },
            '4': { name: `keyword.operator.type.annotation.${langName}` },
          },
          end: '(?=[,)]|=(?!>))',
          patterns: [{ include: '#type-inner' }],
        };
        paramsInnerPatterns.push({ include: '#param-type-annotation' });

        // Destructuring-binding parameter type annotation: `{ a } : T`, `[ a ] : T`
        // (and with defaults `{ a = 0 } : T`). #param-type-annotation above only
        // opens on a SIMPLE-identifier param before `:`; when the param is a binding
        // pattern its `:` annotation would otherwise fall through to bare punctuation
        // and the type name be scoped as a value. The binding pattern's `{…}`/`[…]`
        // body — its bound names, nested patterns and `= default` expressions — is
        // consumed by `$self` exactly as before (so those scopes are unchanged); this
        // rule only opens the type region at the trailing `:`. The begin is anchored
        // by a lookbehind on the binding-pattern CLOSE bracket (derived from the
        // grammar, see deriveBindingCloseBrackets), which at param-list level can only
        // be a destructuring close — a default-value object/array literal is nested
        // inside `$self` and never surfaces here, so it cannot trigger this region.
        const bindCloses = deriveBindingCloseBrackets(grammar, identToken?.name);
        if (bindCloses.length) {
          const closeClass = bindCloses.map(escapeForCharClass).join('');
          repository['param-bind-type-annotation'] = {
            name: `meta.type.annotation.parameter.${langName}`,
            begin: `(?<=[${closeClass}])\\s*(\\??)\\s*(:)`,
            beginCaptures: {
              '1': { name: `keyword.operator.optional.${langName}` },
              '2': { name: `keyword.operator.type.annotation.${langName}` },
            },
            end: '(?=[,)]|=(?!>))',
            patterns: [{ include: '#type-inner' }],
          };
          paramsInnerPatterns.push({ include: '#param-bind-type-annotation' });
        }

        // Bare ':' return-type pattern (for use inside declaration scopes,
        // after declaration-params consumes the ')')
        repository['decl-return-type'] = {
          name: `meta.type.annotation.return.${langName}`,
          begin: '(:)',
          beginCaptures: {
            '1': { name: `keyword.operator.type.annotation.${langName}` },
          },
          end: '(?=[{;]|=>)',
          patterns: [{ include: '#type-inner' }],
        };
      }

      // Bare parameter name (no type annotation): the identifier at a
      // param-start position — directly after '(' or ',', and immediately
      // followed by a delimiter that ends a *bare* param: ',' (next param),
      // ')' (end of list), or '=' (default value). The lookbehind keeps this
      // from matching default-value expressions (e.g. `x = foo` → only `x`
      // matches; `foo` is preceded by '=', not '('/','). This gives
      // unannotated params in function/method/constructor signatures the
      // variable.parameter scope (the type-annotation path handles annotated
      // ones). The lookahead deliberately omits ':' and '?' so an annotated
      // param (`x: T`, `x?: T`, `...args: T[]`) is left for
      // #param-type-annotation — which is listed first AND, because this
      // matcher swallows leading whitespace (TextMate prefers the leftmost
      // match), would otherwise be pre-empted on rest params like `...args:`.
      repository['declaration-param-name'] = {
        match: `(?<=[,(])\\s*(\\.\\.\\.)?\\s*(${identPattern})(?=\\s*[,)=])`,
        captures: {
          '1': { name: `keyword.operator.spread.${langName}` },
          '2': { name: `variable.parameter.${langName}` },
        },
      };
      paramsInnerPatterns.push({ include: '#declaration-param-name' });

      paramsInnerPatterns.push({ include: '#nested-parens' });
      paramsInnerPatterns.push({ include: '$self' });

      repository['declaration-params'] = {
        name: `meta.parameters.${langName}`,
        begin: '\\(',
        end: '\\)',
        beginCaptures: { '0': { name: `punctuation.definition.parameters.begin.${langName}` } },
        endCaptures: { '0': { name: `punctuation.definition.parameters.end.${langName}` } },
        patterns: paramsInnerPatterns,
      };
    }

    // Type parameter list pattern (for <T extends U> in declarations)
    if (declarations.some(d => d.hasTypeParams)) {
      const allTypeParamKws = new Set(declarations.flatMap(d => d.typeParamKeywords));
      const tpInner: (TmPattern | { include: string })[] = [
        { include: '#declaration-type-params' },
      ];
      for (const kw of allTypeParamKws) {
        const scope = getScope(scopeOverrides,kw);
        if (scope) {
          tpInner.push({
            match: `\\b${escapeRegex(kw)}\\b`,
            name: `${scope}.${langName}`,
          });
        }
      }
      tpInner.push({ include: '#type-inner' });
      const eqScope = getScope(scopeOverrides,'=');
      if (eqScope) {
        tpInner.push({ match: '=', name: `${eqScope}.${langName}` });
      }
      const commaScope = getScope(scopeOverrides,',');
      if (commaScope) {
        tpInner.push({ match: ',', name: `${commaScope}.${langName}` });
      }

      repository['declaration-type-params'] = {
        name: `meta.type.parameters.${langName}`,
        begin: '<',
        beginCaptures: { '0': { name: `punctuation.definition.typeparameters.begin.${langName}` } },
        end: '>',
        endCaptures: { '0': { name: `punctuation.definition.typeparameters.end.${langName}` } },
        patterns: tpInner,
      };

      // Type parameters of a GENERIC ARROW in expression position, e.g.
      //   const f = <T, E extends string = string>(u: T) => u
      //   const g = async <T>(\n    u: string\n  ) => {}
      // The opening `<` here is NOT preceded by an identifier (that would be a
      // generic CALL `f<T>()`, handled by #generic-call), so the declaration
      // type-param list above — which fires only inside a named declaration's
      // begin/end scope — never reaches it. We re-use the SAME inner patterns
      // (`tpInner`), so `extends`/`in`/`out`/`const`, `=` defaults and nested
      // generics are scoped identically; only the trigger differs.
      //
      // Trigger (mutually exclusive with #generic-call's ident lookbehind and
      // with #comparison): the `<` sits at an arrow position — immediately
      // after `async`, or at expression-start (NOT after a value operand, so a
      // comparison `a < b > c` whose `<` always follows an operand is excluded)
      // — and is followed by a balanced `<…>` whose `>` is immediately followed
      // by a `(` that opens an arrow-shaped parameter list (`()`, `(…rest`,
      // `(name:`, `(name,`, `(name)`, `(name?`, a destructuring `{`/`[`, or `(`
      // at end of line for the multiline form). Requiring the trailing `(`
      // keeps a cast WITHOUT a following paren (`<Foo>bar`) on #type-cast and
      // never touches comparisons. When the `<…>` and `(` are all on the `<`
      // line, the whole type-param list (which may then close on a later line)
      // is scoped; the begin/end persists across lines until the matching `>`.
      if (angleBracket && angleDisambig) {
        const balancedAngles = angleDisambig.balancedAngles;
        const arrowParamShape = angleDisambig.arrowParamShape;
        const arrowPos = `(?:(?<=\\basync\\s)|${notAfterValueWithOptionalWhitespace('\\w$)\\]}')})`;
        // JSX-dialect disambiguator: in a `.tsx`/`.jsx` grammar a bare `<Foo>(…`
        // is a JSX element, so a generic-arrow type-param list is only recognised
        // when it carries a TOP-LEVEL comma inside the `<…>` (`<T,>`, `<T = X,>`,
        // `<const T,>`, `<T, U>`) OR a top-level CONSTRAINT keyword (`<T extends X>`,
        // the no-comma signal — `extends` is read off the type-param rule, and must
        // not be a JSX attr named `extends`, hence `\bextends\b\s*(?!=)`) — a tag-open
        // never has either. `{…}` attr-value containers and `"…"`/`'…'` attr strings
        // are opaque, so a comma inside `a={[1,2]}` / a keyword inside `a="extends x"`
        // doesn't count. In a plain (non-JSX) TS grammar this would wrongly reject
        // no-comma generics like `<T>()`, so the guard is gated on `jsx` and empty
        // otherwise — keeping the TS output byte-identical. The skip-set body
        // (`angleDisambig.topTypeParam`) is derived from the grammar and SHARED with
        // the carve-out appended to the JSX expression-start triggers (see
        // generateJsxPatterns), so the positive guard here and its inverse there stay
        // mutually exclusive by construction.
        const topComma = jsx ? `(?=${angleDisambig.topTypeParam})` : '';
        repository['arrow-type-parameters'] = {
          name: `meta.type.parameters.${langName}`,
          begin: `${arrowPos}(<)${topComma}(?=${balancedAngles}>\\s*${arrowParamShape})`,
          beginCaptures: {
            '1': { name: `punctuation.definition.typeparameters.begin.${langName}` },
          },
          end: '(>)',
          endCaptures: {
            '1': { name: `punctuation.definition.typeparameters.end.${langName}` },
          },
          patterns: tpInner,
        };
        // Generic-arrow WRAPPER. A confirmed generic arrow is a `<…>` type-param list
        // IMMEDIATELY followed by its param list `(…)`. The closing `>` of a generic ARROW
        // is indistinguishable — by a FIXED-WIDTH look-behind — from a generic CALL's `>`
        // (`foo<Bar>(`) or a comparison `>` (`a > (`): the deciding signal (the `<` sitting
        // at expression-start) is a VARIABLE distance back, and Onigmo rejects variable-width
        // look-behind. So rather than guess the params' `(` from behind, we OWN it: a
        // zero-width begin re-uses #arrow-type-parameters' EXACT disambiguation (arrow
        // position + `<…>` + `>\s*<arrow-param-shape>` confirm) to open a region holding the
        // type-param list AND the param list as children. No look-behind → correct AND
        // TextMate-2.0/Onigmo clean. The children carry the two metas (meta.type.parameters /
        // meta.parameters.arrow); the wrapper is unnamed. Same trigger position (and -7 rank)
        // as the old top-level #arrow-type-parameters, so all angle-bracket precedence holds.
        repository['generic-arrow-function'] = {
          begin: `${arrowPos}(?=<${topComma}${balancedAngles}>\\s*${arrowParamShape})`,
          end: '(?<=\\))',
          patterns: [
            { include: '#arrow-type-parameters' },
            { include: '#arrow-function-params-generic' },
          ],
        };
        topPatterns.push({ include: '#generic-arrow-function' });
      }
    }

    // Per-declaration begin/end scopes
    for (const decl of declarations) {
      const key = `${decl.keyword}-declaration`;
      const innerPatterns: (TmPattern | { include: string })[] = [];

      if (decl.hasTypeParams && repository['declaration-type-params']) {
        innerPatterns.push({ include: '#declaration-type-params' });
      }
      if (decl.hasParams && repository['declaration-params']) {
        innerPatterns.push({ include: '#declaration-params' });
      }
      if (decl.hasParams && repository['decl-return-type']) {
        innerPatterns.push({ include: '#decl-return-type' });
      }
      if (decl.hasBody) {
        // An enum body is special: its members are NAMES, not statements, and the
        // TextMate convention scopes them `variable.other.enummember` (parallel to
        // the `storage.type.enum` keyword → `entity.name.type.enum` name remap).
        // Keyed on the scope subtype, not the word "enum", so any grammar that
        // scopes its enum keyword `storage.type.enum` gets enum-member coloring for
        // free. A member is an identifier in member position — right after the `{`
        // or a `,` and immediately before `=` / `,` / `}` — which excludes any
        // identifier appearing in a member's initializer value (after `=`).
        const isEnum = /(^|\.)enum$/.test(decl.keywordScope);
        if (isEnum) {
          if (!repository['enum-body']) {
            repository['enum-member'] = {
              match: `(?<=[{,])\\s*(${identPattern})(?=\\s*[=,}])`,
              captures: { '1': { name: `variable.other.enummember.${langName}` } },
            };
            // enum-body is the same `{ … }` bracket region; only its body differs (members are
            // NAMES via #enum-member, not statements). CALLER predicate: a brace-bodied decl
            // whose keyword scope ends in `.enum`.
            repository['enum-body'] = emitBracketRegion({
              openLit: '\\{', closeLit: '\\}', beginCapName: blockCapName, endCapName: blockCapName,
              bodyPatterns: [{ include: '#enum-member' }, { include: '$self' }],
            });
          }
          innerPatterns.push({ include: '#enum-body' });
        } else {
          innerPatterns.push({ include: decl.hasParams ? '#code-block' : '#declaration-body' });
        }
      }

      let end = '(?<=\\})';
      const isTypeAlias = !decl.hasBody && decl.endHint === '=';
      if (isTypeAlias) {
        // Type alias: `type Foo = Type;` — scope covers the type body.
        // Use begin/while so the scope auto-closes when the next line
        // can't be part of a type expression (e.g., starts with a statement keyword
        // or an expression like `foo()`). `while` tears the WHOLE region (and any
        // open inner object-type/type-arg frames) down when it fails, so an inner
        // sub-type that doesn't close cleanly can never run away into later code —
        // the per-line re-test re-establishes the boundary every line.
        end = '(?=;)|;';
        if (!repository['type-body']) {
          const eqScope = getScope(scopeOverrides, '=') ?? 'keyword.operator.assignment';
          repository['type-body'] = {
            name: `meta.type.body.${langName}`,
            begin: '(=)',
            beginCaptures: {
              '1': { name: `${eqScope}.${langName}` },
            },
            end: '(?=[;])',
            patterns: [{ include: '#type-inner' }],
          };
        }
        innerPatterns.push({ include: '#type-body' });
      }

      innerPatterns.push({ include: '$self' });

      if (isTypeAlias) {
        // already set above
      } else if (!decl.hasBody && decl.endHint) {
        end = `(?=${escapeRegex(decl.endHint)})`;
      } else if (!decl.hasBody) {
        end = '(?=;|$)';
      } else if (decl.optionalBody) {
        // Body OPTIONAL (`function f(){}` OR overload/ambient `function f();`): close
        // after the body `}` as usual, but ALSO on a body-less `;` terminator —
        // otherwise the region runs into the next statement. The body's own `;`s are
        // inside the nested #code-block region, so the outer `(?=;)` only sees the
        // signature terminator (TM never tests the outer end inside a child region).
        end = '(?<=\\})|(?=;)';
      }

      // Build begin regex: keyword [midLiterals?] name
      // e.g., function* → \\b(function)\\s*(\\*)?\\s*(identPattern)
      let beginRegex: string;
      const captures: Record<string, { name: string }> = {};
      let nameCapIdx: number;
      if (decl.midLiterals.length > 0) {
        const midAlt = decl.midLiterals.map(escapeRegex).join('|');
        beginRegex = `\\b(${escapeRegex(decl.keyword)})\\s*(${midAlt})?\\s*(${identPattern})`;
        captures['1'] = { name: `${decl.keywordScope}.${langName}` };
        // capture 2 = mid literal (e.g., * for generator functions)
        if (decl.midLiterals.length === 1) {
          const midScope = getScope(scopeOverrides, decl.midLiterals[0]);
          if (midScope) captures['2'] = { name: `${midScope}.${langName}` };
        }
        captures['3'] = { name: `${decl.nameScope}.${langName}` };
        nameCapIdx = 3;
      } else {
        beginRegex = `\\b(${escapeRegex(decl.keyword)})\\s+(${identPattern})`;
        captures['1'] = { name: `${decl.keywordScope}.${langName}` };
        captures['2'] = { name: `${decl.nameScope}.${langName}` };
        nameCapIdx = 2;
      }
      // Dotted EntityName tail (`namespace A.B.C`): the `.segment` repetition
      // names the same declaration, so it shares the name scope. `identPattern`
      // is wholly non-capturing, so this whole `(.x)*` run is one capture group.
      if (decl.qualifiedName) {
        beginRegex += `((?:\\s*\\.\\s*${identPattern})*)`;
        captures[String(nameCapIdx + 1)] = { name: `${decl.nameScope}.${langName}` };
      }

      const declPattern: TmPattern = {
        name: `meta.${decl.keyword}.${langName}`,
        begin: beginRegex,
        beginCaptures: captures,
        patterns: innerPatterns,
      };
      if (isTypeAlias && typeAliasWhile) {
        declPattern.while = typeAliasWhile;
      } else {
        declPattern.end = end;
      }
      repository[key] = declPattern;
      topPatterns.push({ include: `#${key}` });

      // Anonymous form of a function-like declaration: the keyword followed
      // DIRECTLY by its parameter list with NO name (e.g. `function (x) {}`,
      // `function* () {}` — a function EXPRESSION). The named begin above
      // requires an identifier after the keyword, so without this the whole
      // parameter list (and any parameter TYPE annotations inside it) would
      // fall through to the flat value/property-access patterns and be
      // mis-scoped. Only emitted for function-like declarations (named via
      // entity.name.function) that have both a parameter list and a body —
      // the universal JS/TS anonymous-function-expression shape. Classes are
      // naturally excluded (their begin carries no params).
      if (decl.hasParams && decl.hasBody && decl.nameScope.includes('entity.name.function')) {
        const anonCaptures: Record<string, { name: string }> = {
          '1': { name: `${decl.keywordScope}.${langName}` },
        };
        let anonBegin: string;
        if (decl.midLiterals.length > 0) {
          const midAlt = decl.midLiterals.map(escapeRegex).join('|');
          anonBegin = `\\b(${escapeRegex(decl.keyword)})\\s*(${midAlt})?\\s*(?=\\()`;
          if (decl.midLiterals.length === 1) {
            const midScope = getScope(scopeOverrides, decl.midLiterals[0]);
            if (midScope) anonCaptures['2'] = { name: `${midScope}.${langName}` };
          }
        } else {
          anonBegin = `\\b(${escapeRegex(decl.keyword)})\\s*(?=\\()`;
        }
        const anonKey = `${decl.keyword}-anon-declaration`;
        repository[anonKey] = {
          name: `meta.${decl.keyword}.${langName}`,
          begin: anonBegin,
          beginCaptures: anonCaptures,
          end: '(?<=\\})',
          patterns: innerPatterns,
        };
        topPatterns.push({ include: `#${anonKey}` });
      }
    }
  }

  // ── 3c. Direct-param keywords (keyword directly followed by '(' — e.g., constructor) ──
  const directParamKws = detectDirectParamKeywords(grammar, scopeOverrides)
    .filter(d => !declarationKeywords.has(d.keyword));

  // Keywords whose ONLY valid keyword role is a dedicated declaration context
  // (a `*-declaration` begin/end injected into declaration bodies — e.g.
  // `constructor` inside a class body). Such a word is a contextual keyword that
  // doubles as an identifier everywhere else (`return constructor`, `{ constructor: 1 }`,
  // `let constructor = 2`), so it must be DROPPED from the flat global keyword match
  // (Section 5) — the declaration context already paints its keyword use, and the flat
  // match would otherwise mis-scope every identifier use. Same reserved-word test the
  // contextual-OPERATOR keywords use (collectReservedWords): only words the grammar
  // proves are valid identifiers somewhere are demoted; truly-reserved direct-param
  // keywords (none today) would stay in the flat match.
  const contextDeclaredKws = new Set<string>();
  const reservedWordsForCtx = collectReservedWords(grammar);

  if (directParamKws.length > 0 && repository['declaration-params']) {
    for (const dpk of directParamKws) {
      const key = `${dpk.keyword}-declaration`;
      const innerPatterns: (TmPattern | { include: string })[] = [
        { include: '#declaration-params' },
      ];
      if (repository['decl-return-type']) {
        innerPatterns.push({ include: '#decl-return-type' });
      }
      innerPatterns.push({ include: '#code-block' });
      innerPatterns.push({ include: '$self' });

      repository[key] = emitKeywordRegion({
        name: `meta.${dpk.keyword}.${langName}`,
        kw: dpk.keyword,
        kwScope: `${dpk.keywordScope}.${langName}`,
        // End after the body `}` (the inner #code-block consumes a `{ … }` body
        // first), OR at a `;`/`}` ahead for a body-LESS overload signature
        // (`constructor(a);`) — without this the context would run away to the
        // enclosing block's `}` and swallow the next member. Mirrors #method-signature.
        end: '(?<=\\})|(?=[;}])',
        patterns: innerPatterns,
      });
      // A non-reserved direct-param keyword is a contextual keyword: its keyword
      // role is now fully covered by this declaration context, so drop it from the
      // flat global match (Section 5) to keep its identifier uses un-keyworded.
      if (!reservedWordsForCtx.has(dpk.keyword)) contextDeclaredKws.add(dpk.keyword);
    }

    // Inject direct-param keyword patterns into declaration-body so they fire inside class bodies
    if (repository['declaration-body']) {
      const bodyPatterns = repository['declaration-body'].patterns!;
      const dpkIncludes = directParamKws.map(dpk => ({ include: `#${dpk.keyword}-declaration` }));
      bodyPatterns.splice(bodyPatterns.length - 1, 0, ...dpkIncludes);
    }
  }

  // ── 3d. Method signatures inside declaration bodies ──
  if (repository['declaration-body'] && repository['declaration-params']) {
    const msInner: (TmPattern | { include: string })[] = [];
    if (repository['declaration-type-params']) {
      msInner.push({ include: '#declaration-type-params' });
    }
    msInner.push({ include: '#declaration-params' });
    if (repository['decl-return-type']) {
      msInner.push({ include: '#decl-return-type' });
    }
    msInner.push({ include: '#code-block' });
    msInner.push({ include: '$self' });

    repository['method-signature'] = {
      name: `meta.method.${langName}`,
      // An optional `?` can sit between the name and its type-params/params
      // (`f2?(): void`, `f2?<T>(): T`). The lookahead still requires `<`/`(`
      // after the (optional) `?`, so this stays disjoint from a property
      // signature `name?: T` (which has `:` there).
      begin: `\\b(${identPattern})(\\?)?\\s*(?=[<(])`,
      beginCaptures: {
        '1': { name: `entity.name.function.${langName}` },
        '2': { name: `keyword.operator.optional.${langName}` },
      },
      end: '(?<=\\})|(?=[;\\}])',
      patterns: msInner,
    };

    const bodyPatterns = repository['declaration-body'].patterns!;
    bodyPatterns.splice(bodyPatterns.length - 1, 0, { include: '#method-signature' });

    // A method signature can also appear inside a type-literal `{ … }` (e.g.
    // `type T = { f2(): void }`). Without this, the name `f2` falls through to
    // #simple-type → entity.name.type. The method-signature pattern keys on
    // `ident` immediately before `<`/`(`, which is disjoint from the property
    // signature's `ident` before `?:`/`:` (#type-object-member), so it never
    // steals a property name — it just promotes method names to
    // entity.name.function. Injected ahead of the property/simple-type fallbacks.
    if (repository['type-object-type']) {
      repository['type-object-type'].patterns!.unshift({ include: '#method-signature' });
    }
  }

  // ── 3e. Member type annotations inside declaration bodies ──
  if (repository['declaration-body'] && hasTypeAnnotations) {
    // Detect if the grammar has a private-field-like token (e.g., #identifier)
    const hasPrivateFields = grammar.tokens.some(t => tokenPatternLiteralPrefix(t)?.startsWith('#'));
    const memberIdentPattern = hasPrivateFields ? `#?${identPattern}` : identPattern;
    repository['member-type-annotation'] = {
      name: `meta.type.annotation.member.${langName}`,
      begin: `(${memberIdentPattern})(\\??)(\\s*:)`,
      beginCaptures: {
        '1': { name: `variable.object.property.${langName}` },
        '2': { name: `keyword.operator.optional.${langName}` },
        '3': { name: `keyword.operator.type.annotation.${langName}` },
      },
      // The `=` boundary (member initializer `x: T = …`) is matched as `=(?!>)`
      // so the `=` of a function-type return arrow (`x: () => T`) does not close
      // the annotation early and strip the return type of its type scope.
      end: '(?=[;},)]|=(?!>))',
      patterns: [{ include: '#type-inner' }],
    };
    const bodyPatterns = repository['declaration-body'].patterns!;
    bodyPatterns.splice(bodyPatterns.length - 1, 0, { include: '#member-type-annotation' });

    // Computed-member-key type annotation: `[ 'k' ] : T`, `[Symbol.iterator]: T`.
    // #member-type-annotation above only opens on a SIMPLE-identifier key before `:`;
    // when the key is a computed `[ expr ]` the trailing `:` would otherwise fall
    // through to bare punctuation and the type name be scoped as a VALUE (the type.ref
    // miss this closes — e.g. `['x']: React.DOMAttributes<unknown>`). The key's
    // `[ expr ]` — its brackets and inner expression — is consumed by the body's
    // expression patterns (`$self`) exactly as before, so those scopes are unchanged;
    // this rule only opens the type region at the trailing `:`, anchored by a
    // lookbehind on the computed-key CLOSE bracket (derived from the grammar's member
    // rules, see deriveComputedMemberCloseBrackets), mirroring #param-bind-type-annotation.
    // An index signature `[k: T]: U` is unaffected: its inner `k:` opens
    // #member-type-annotation first (a leftmost match), whose region already spans the
    // trailing `]: U`, so this pattern never fires there.
    const memberKeyCloses = deriveComputedMemberCloseBrackets(grammar, typeRuleNames);
    if (memberKeyCloses.length) {
      const closeClass = memberKeyCloses.map(escapeForCharClass).join('');
      repository['member-bind-type-annotation'] = {
        name: `meta.type.annotation.member.${langName}`,
        begin: `(?<=[${closeClass}])\\s*(\\??)\\s*(:)`,
        beginCaptures: {
          '1': { name: `keyword.operator.optional.${langName}` },
          '2': { name: `keyword.operator.type.annotation.${langName}` },
        },
        end: '(?=[;},)]|=(?!>))',
        patterns: [{ include: '#type-inner' }],
      };
      bodyPatterns.splice(bodyPatterns.length - 1, 0, { include: '#member-bind-type-annotation' });
    }

    // Class-field INITIALIZER object literal (`foo = { … }`). Inside a declaration
    // body the `{ … }` after a field's `=` would otherwise be consumed by the
    // self-recursive #declaration-body block — which carries #member-type-annotation —
    // so an object-literal key (`{ a: PropTypes.number }`) is mis-read as a member
    // type annotation (key → variable.object.property, value → entity.name.type). A
    // field initializer is an EXPRESSION, not a class body: this region opens on the
    // member `=` (a lone assignment — the compound-operator lookbehind/ahead keep it
    // off `==`/`=>`/`>=`/`+=`) when an object `{` follows, and routes the `{ … }`
    // through #code-block (the self-recursive block that includes `$self` but NOT the
    // class-member patterns), so the object literal's keys/values read as plain
    // expression tokens exactly as a top-level `const x = { … }` does. Emitted only
    // when both the member-annotation regime (the source of the leak) and #code-block
    // exist, and keyed on the grammar's `{`/`=` — agnostic, no TS-specific names.
    if (repository['member-type-annotation'] && repository['code-block']) {
      const asgnScope = getScope(scopeOverrides, '=') ?? 'keyword.operator.assignment';
      repository['member-initializer-object'] = {
        begin: `(?<![=!<>+\\-*/%&|^~])(=)(?![=>])(?=\\s*\\{)`,
        beginCaptures: { '1': { name: `${asgnScope}.${langName}` } },
        end: '(?<=\\})',
        patterns: [{ include: '#code-block' }],
      };
      // Front of the body patterns: its `=`-anchored begin sits one position LEFT of
      // the bare `\{` self-recursion and of `$self`'s `=` operator match, so leftmost-
      // match makes it claim `= {` first; a non-object initializer (`= bar`) lacks the
      // `{` lookahead and is untouched.
      repository['declaration-body'].patterns!.unshift({ include: '#member-initializer-object' });
    }
  }

  // ── 4. Contextual patterns (keyword + Ident → entity.name.*) ──
  const contextualPatterns: ContextualPattern[] = [];
  for (const rule of grammar.rules) {
    contextualPatterns.push(...findContextualPatterns(rule.body, tokenNames, scopeOverrides, grammar.rules, identToken?.name ?? null));
  }

  const seenContextual = new Set<string>();
  for (const cp of contextualPatterns) {
    if (seenContextual.has(cp.keyword)) continue;
    // Skip keywords that are now handled as declaration scopes
    if (declarationKeywords.has(cp.keyword)) continue;
    seenContextual.add(cp.keyword);

    const key = `${cp.keyword}-definition`;
    const kwBaseScope = getScope(scopeOverrides,cp.keyword) ?? 'keyword.other';
    repository[key] = {
      match: `\\b(${escapeRegex(cp.keyword)})\\s+(${identPattern})`,
      captures: {
        '1': { name: `${kwBaseScope}.${langName}` },
        '2': { name: `${cp.identScope}.${langName}` },
      },
    };
    topPatterns.push({ include: `#${key}` });
  }

  // ── 4b. declaration-binding names (`const x`, `let {…}`, `var […]`) ──
  // The binding-introducer keywords are those scoped with the BARE `storage.type` — the
  // variable-declaration scope. `function`/`class`/`enum`/`namespace`/… all carry a more
  // specific `storage.type.*` subtype, so this excludes them; what's left is exactly the
  // `let`/`const`/`var`/`using` family. Keyed on the scope, not the words, so any grammar
  // that scopes its declaration keywords `storage.type` gets binding highlighting.
  //
  // A bound name takes the TextMate convention for its mutability: the `*.const`-marked
  // keyword (the immutable form) names CONSTANTS (`variable.other.constant`); the rest
  // name `variable.other.readwrite` (the same leaf the identifier catch-all emits). Two
  // region flavors are generated from one emitter, differing only in that name scope.
  //
  // Two forms, both confined so a non-destructuring grammar emits inert rules:
  //   • simple `const x` / `const x: T` / `const x =` — a binding-terminator lookahead
  //     `(?=\s*[=:;,]|$)` keeps `const enum E` from matching. Only the immutable form
  //     needs this; a plain `let x` already gets readwrite from the identifier catch-all.
  //   • destructuring `KEYWORD {…}` / `KEYWORD […]` — a region mirroring the grammar's
  //     BindingPattern: an ident in BINDING position takes the flavor's name scope, an
  //     ident before `:` is the property KEY, `...` is rest, and `= expr` is a default
  //     value (a normal expression — its idents are NOT bindings), nested patterns
  //     recurse. Matches the official object/array-binding-pattern scopes.
  const bindIntroducers = [...scopeOverrides].filter(([, scopes]) => scopes.includes('storage.type'));
  if (bindIntroducers.length) {
    // `variable.other.constant` / `variable.other.readwrite` are TextMate conventions, not
    // language words; the readwrite leaf mirrors the identifier catch-all (see above).
    const constantScope = `variable.other.constant.${langName}`;
    const readwriteScope = `variable.other.readwrite.${langName}`;
    const eqScope = `${getScope(scopeOverrides, '=') ?? 'keyword.operator.assignment'}.${langName}`;
    const commaScope = `${getScope(scopeOverrides, ',') ?? 'punctuation.separator.comma'}.${langName}`;

    // Shared default-value region: `= expr` is a normal expression, so its idents are NOT
    // bindings (matches official: `{ d = x }` → `x` is readwrite). Ends at the top-level
    // separator; nested `[]`/`{}`/`()` are consumed by $self.
    repository['bind-default'] = {
      begin: '(=)', beginCaptures: { '1': { name: eqScope } },
      end: '(?=[,}\\])])', patterns: [{ include: '$self' }],
    };
    // One binding-pattern region set per flavor, differing only in the binding-name scope.
    const emitBindRegions = (flavor: string, nameScope: string) => {
      repository[`${flavor}-bind-prop`] = { patterns: [
        { match: '(\\.\\.\\.)', name: `keyword.operator.rest.${langName}` },
        { match: `(${identPattern})(\\s*)(:)`, captures: { '1': { name: `variable.object.property.${langName}` }, '3': { name: `punctuation.destructuring.${langName}` } } },
        { include: '#bind-default' },
        { include: `#${flavor}-bind-object` },
        { include: `#${flavor}-bind-array` },
        { match: `(${identPattern})`, name: nameScope },
        { match: ',', name: commaScope },
      ] };
      repository[`${flavor}-bind-elem`] = { patterns: [
        { match: '(\\.\\.\\.)', name: `keyword.operator.rest.${langName}` },
        { include: '#bind-default' },
        { include: `#${flavor}-bind-object` },
        { include: `#${flavor}-bind-array` },
        { match: `(${identPattern})`, name: nameScope },
        { match: ',', name: commaScope },
      ] };
      repository[`${flavor}-bind-object`] = {
        begin: '\\{', beginCaptures: { '0': { name: `punctuation.definition.binding-pattern.object.${langName}` } },
        end: '\\}', endCaptures: { '0': { name: `punctuation.definition.binding-pattern.object.${langName}` } },
        patterns: [{ include: `#${flavor}-bind-prop` }],
      };
      repository[`${flavor}-bind-array`] = {
        begin: '\\[', beginCaptures: { '0': { name: `punctuation.definition.binding-pattern.array.${langName}` } },
        end: '\\]', endCaptures: { '0': { name: `punctuation.definition.binding-pattern.array.${langName}` } },
        patterns: [{ include: `#${flavor}-bind-elem` }],
      };
    };
    emitBindRegions('const', constantScope);
    emitBindRegions('mut', readwriteScope);

    for (const [lit, scopes] of bindIntroducers) {
      const isConst = scopes.some(s => /(^|\.)const$/.test(s));
      const flavor = isConst ? 'const' : 'mut';
      const kwScope = scopes.find(s => !/(^|\.)const$/.test(s)) ?? scopes[0];
      const kw = `${kwScope}.${langName}`;

      // simple `const x` — only the immutable form needs a rule (a plain `let x` already
      // gets readwrite from the identifier catch-all). Terminator lookahead avoids `const enum E`.
      if (isConst) {
        const key = `${lit}-binding`;
        if (!repository[key]) {
          repository[key] = {
            match: `\\b(${escapeRegex(lit)})\\s+(${identPattern})(?=\\s*[=:;,]|\\s*$)`,
            captures: { '1': { name: kw }, '2': { name: constantScope } },
          };
          topPatterns.push({ include: `#${key}` });
        }
      }

      // destructuring `KEYWORD {…}` / `KEYWORD […]`
      const dkey = `${lit}-destructure`;
      if (!repository[dkey]) {
        repository[dkey] = {
          begin: `\\b(${escapeRegex(lit)})\\s+(?=[{\\[])`,
          beginCaptures: { '1': { name: kw } },
          end: '(?<=[}\\]])',
          patterns: [{ include: `#${flavor}-bind-object` }, { include: `#${flavor}-bind-array` }],
        };
        topPatterns.push({ include: `#${dkey}` });
      }
    }
  }

  // ── 4a. Import/export namespace `*` → constant.language.import-export-all ──
  // A `*` directly after an import/export keyword (`import * as ns`, `export *`,
  // `export * as ns`) names the whole module, not multiplication. Both the trigger
  // keyword (scope `keyword.control.import`) and the `*` literal are read from the
  // grammar/scope map; the rule fires only on the keyword→`*` adjacency that
  // actually occurs in a rule, so an arithmetic `*` is never mis-scoped (import/
  // export keywords are reserved and can never be a multiplication operand).
  // A phase modifier is a keyword literal whose EVERY keyword occurrence in the
  // grammar sits immediately before the namespace `*` (e.g. `defer`, only ever in
  // `import defer * as ns`). Such a word is NOT reserved — it stays a valid binding
  // identifier elsewhere (`const defer = 1`, `defer()`, `import defer from "m"`) — so
  // it must be scoped POSITIONALLY (right before `*`, via #import-export-all below),
  // never in the flat keyword match. Words used as keywords in OTHER positions too
  // (`import`; `export`, before `*` AND in `export default …`) are NOT phase
  // modifiers — they keep their normal flat scoping and may introduce the `*`.
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
      else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') walk(e.body);
      else if (e.type === 'sep') walk(e.element);
    };
    for (const r of grammar.rules) walk(r.body);
    return beforeStar && !elsewhere;
  };
  // Star-introducing keywords (`import`/`export`): carry a keyword.control.import
  // subtype scope AND introduce a namespace `*`. Phase modifiers (which also carry
  // such a subtype, since `defer` is a deferred-IMPORT marker) are excluded — they
  // are not star-introducers, they sit BETWEEN the keyword and the `*`.
  const importExportKws = new Set<string>();
  for (const [lit, scopes] of scopeOverrides) {
    if (scopes.some(s => s.startsWith('keyword.control.import')) && !usedAsKeywordOnlyBeforeStar(lit)) importExportKws.add(lit);
  }
  // Does a rule have an alternative whose first item is the `*` literal? (e.g.
  // `import` → ImportClause, whose namespace branch begins `'*' 'as' Ident`.)
  const ruleStartsWithStar = (refName: string, seen: Set<string> = new Set()): boolean => {
    if (seen.has(refName)) return false;
    seen.add(refName);
    const rule = grammar.rules.find(r => r.name === refName);
    if (!rule) return false;
    for (const alt of expandAlts(rule.body)) {
      const head = alt[0];
      if (!head) continue;
      if (head.type === 'literal' && head.value === '*') return true;
      if (head.type === 'ref' && ruleStartsWithStar(head.name, seen)) return true;
    }
    return false;
  };
  const starAllKws = new Set<string>();   // import/export keywords that introduce a namespace `*`
  // Does an alternative begin `[K, '*', …]` where K is a keyword literal? (the
  // import phase-modifier shape — `defer * as ns`). Returns each such K reached
  // directly or through a rule-ref (e.g. `import ImportClause`, an ImportClause alt
  // being `['defer','*','as',Ident]`).
  const phaseStarKws = (refName: string, seen: Set<string> = new Set()): string[] => {
    if (seen.has(refName)) return [];
    seen.add(refName);
    const rule = grammar.rules.find(r => r.name === refName);
    if (!rule) return [];
    const out: string[] = [];
    for (const alt of expandAlts(rule.body)) {
      const head = alt[0], next = alt[1];
      if (head?.type === 'literal' && isKeywordLiteral(head.value) && next?.type === 'literal' && next.value === '*') out.push(head.value);
      else if (head?.type === 'ref') out.push(...phaseStarKws(head.name, seen));
    }
    return out;
  };
  // Map each star-introducing import keyword to the phase modifiers that may sit
  // between it and the `*` (e.g. `import` → [`defer`]). `export`'s `*` takes no
  // modifier, so its entry stays empty.
  const phaseModsByKw = new Map<string, string[]>();
  {
    const walk = (e: RuleExpr | undefined): void => {
      if (!e) return;
      for (const alt of expandAlts(e)) {
        for (let i = 0; i < alt.length - 1; i++) {
          const a = alt[i], b = alt[i + 1];
          if (a.type !== 'literal' || !importExportKws.has(a.value)) continue;
          // `*` directly after the keyword, or reached through the next rule-ref
          // (e.g. `import ImportClause`, whose namespace branch starts with `*`).
          if ((b.type === 'literal' && b.value === '*') || (b.type === 'ref' && ruleStartsWithStar(b.name))) {
            starAllKws.add(a.value);
          }
          // Phase modifier between the keyword and `*` (`import defer * as ns`):
          // a `[K,'*']`-headed alt reached through the next rule-ref, K used as a
          // keyword ONLY before `*`.
          if (b.type === 'ref') {
            const mods = phaseStarKws(b.name).filter(usedAsKeywordOnlyBeforeStar);
            if (mods.length) {
              starAllKws.add(a.value);
              const cur = phaseModsByKw.get(a.value) ?? [];
              for (const m of mods) if (!cur.includes(m)) cur.push(m);
              phaseModsByKw.set(a.value, cur);
            }
          }
        }
        for (const item of alt) {
          if (item.type === 'quantifier' || item.type === 'group') walk(item.body);
          else if (item.type === 'sep') walk(item.element);
        }
      }
    };
    for (const rule of grammar.rules) walk(rule.body);
  }
  // Collect the phase modifiers so the flat keyword match (section 5) can exclude
  // them — they are scoped here, positionally, instead.
  const phaseModifierKws = new Set<string>([...phaseModsByKw.values()].flat());
  if (starAllKws.size > 0) {
    // Keyword keeps the scope it carries elsewhere (read from the scope map), so
    // the keyword capture is not hardcoded to a specific scope string.
    const kwScope = getScope(scopeOverrides, [...starAllKws][0]) ?? 'keyword.control.import';
    if (phaseModifierKws.size === 0) {
      // No phase modifier in this language (e.g. JS, or TS without `import defer`):
      // emit the original flat keyword→`*` match verbatim — byte-identical output.
      repository['import-export-all'] = {
        match: `\\b(${[...starAllKws].map(escapeRegex).join('|')})\\s+(\\*)`,
        captures: {
          '1': { name: `${kwScope}.${langName}` },
          '2': { name: `constant.language.import-export-all.${langName}` },
        },
      };
    } else {
      // A phase modifier exists (`import defer * as ns`). One branch per
      // star-introducing keyword: a keyword that admits a modifier emits
      // `(import)\s+(?:(defer)\s+)?(\*)`; a bare one stays `(export)\s+(\*)`.
      // Capture groups number across branches in open-paren order, assigned as the
      // branches are built. The phase modifier is scoped from the map (a
      // keyword.control.import subtype), never a hardcoded word.
      const phaseScope = getScope(scopeOverrides, [...phaseModifierKws][0]) ?? kwScope;
      const captures: Record<string, { name: string }> = {};
      const branches: string[] = [];
      let g = 0;
      for (const kw of starAllKws) {
        const mods = phaseModsByKw.get(kw) ?? [];
        const kwG = ++g; captures[String(kwG)] = { name: `${kwScope}.${langName}` };
        let branch = `(${escapeRegex(kw)})\\s+`;
        if (mods.length) {
          const modG = ++g; captures[String(modG)] = { name: `${phaseScope}.${langName}` };
          branch += `(?:(${mods.map(escapeRegex).join('|')})\\s+)?`;
        }
        const starG = ++g; captures[String(starG)] = { name: `constant.language.import-export-all.${langName}` };
        branch += `(\\*)`;
        branches.push(branch);
      }
      repository['import-export-all'] = {
        match: `\\b(?:${branches.join('|')})`,
        captures,
      };
    }
    topPatterns.push({ include: '#import-export-all' });
  }

  // ── 4a-bis. Default-import binding name → variable.other.readwrite ──
  // The identifier directly after an import keyword that is immediately followed
  // by the module-source connector (`import X from "m"`) — or a `,` that begins a
  // mixed clause (`import X, { a } from "m"`) — is a BOUND NAME (the default
  // import), exactly like a `const` binding, NOT a type/keyword. The catch-all
  // already scopes a plain identifier `variable.other.readwrite`, but a *contextual
  // keyword* sitting in that slot (e.g. `import type from "m"`, where `type` is the
  // default binding literally named `type`, tsc isTypeOnly=false) is otherwise
  // claimed by its own keyword/declaration rule — the type-alias `type <name>`
  // region fires on `type from`. This rule restores the binding role.
  //
  // Fully derived, no hardcoded words:
  //   • trigger keywords = the import keywords (scope keyword.control.import*) whose
  //     rule places a bare identifier directly after them — directly, or through a
  //     ref whose first alternative starts with the identifier token (the default
  //     branch of an import-clause rule). Keywords that only ever take `{…}`/`*`
  //     (no default form) are excluded.
  //   • module-source connector = the keyword(s) scoped keyword.control.from.
  // The connector lookahead is the disambiguator the grammar itself uses: a default
  // binding is followed by the source connector or a `,`; a *modifier* keyword
  // (`import type X from`) is followed by the clause identifier instead, so the
  // modifier is left untouched (its own keyword/declaration rule still paints it).
  // Leftmost-match makes this win over the later `type <name>` region (which begins
  // one token further right), and the order rank (below) wins the position-0 tie
  // over the flat import-keyword / storage-keyword matches.
  //
  // GATED on the collision actually being possible: the only reason this is needed
  // is that a DECLARATION keyword (one with its own `keyword <name>` region) is also
  // a NON-reserved word, so it can legally stand as the bound default-import name and
  // its region would otherwise fire inside the import (TS `type`/`interface`/…). A
  // language whose declaration keywords are all reserved (plain JS: `function`/`class`)
  // has no such word in the binding slot — a plain identifier already gets readwrite
  // from the catch-all — so the rule is not emitted and the output stays byte-identical.
  const declReservedWords = collectReservedWords(grammar);
  const hasContextualDeclKeyword = declarations.some(d => !declReservedWords.has(d.keyword));
  const defaultBindImportKws = new Set<string>();
  {
    // True when the rule-ref `b` is the identifier token itself, or a rule whose
    // first alternative starts with it (`ruleStartsWithIdent` returns true for the
    // token name directly, so this covers both `import Ident` and `import ImportClause`).
    const startsWithIdentClause = (refName: string): boolean =>
      identToken ? ruleStartsWithIdent(refName, identToken.name, grammar.rules) : false;
    const walk = (e: RuleExpr | undefined): void => {
      if (!e) return;
      for (const alt of expandAlts(e)) {
        for (let i = 0; i < alt.length - 1; i++) {
          const a = alt[i], b = alt[i + 1];
          if (a.type !== 'literal' || !importExportKws.has(a.value)) continue;
          // A bare identifier directly after the keyword, or reached through the
          // next rule-ref whose first alternative is the identifier token.
          if (b.type === 'ref' && startsWithIdentClause(b.name)) {
            defaultBindImportKws.add(a.value);
          }
        }
        for (const item of alt) {
          if (item.type === 'quantifier' || item.type === 'group') walk(item.body);
          else if (item.type === 'sep') walk(item.element);
        }
      }
    };
    for (const rule of grammar.rules) walk(rule.body);
  }
  const moduleSourceKws = [...scopeOverrides]
    .filter(([, scopes]) => scopes.some(s => /(^|\.)keyword\.control\.from\b/.test(s)))
    .map(([lit]) => lit);
  if (hasContextualDeclKeyword && defaultBindImportKws.size > 0 && moduleSourceKws.length > 0 && identToken) {
    const kwScope = getScope(scopeOverrides, [...defaultBindImportKws][0]) ?? 'keyword.control.import';
    const fromAlt = moduleSourceKws.map(escapeRegex).join('|');
    repository['import-default-binding'] = {
      match: `\\b(${[...defaultBindImportKws].map(escapeRegex).join('|')})\\s+(${identPattern})(?=\\s*(?:(?:${fromAlt})\\b|,))`,
      captures: {
        '1': { name: `${kwScope}.${langName}` },
        '2': { name: `variable.other.readwrite.${langName}` },
      },
    };
    topPatterns.push({ include: '#import-default-binding' });
  }

  // ── 4b. Function call detection ──
  const hasCallExpr = detectCallExpression(grammar);
  if (hasCallExpr) {
    repository['function-call'] = {
      match: `(${identPattern})(?=\\s*\\()`,
      captures: {
        '1': { name: `entity.name.function.${langName}` },
      },
    };
    topPatterns.push({ include: '#function-call' });
  }

  // ── 4b1a. Object method key: `key: (params) => ...` or `key: function(...)` ──
  // In object literals, a property key followed by `:` and a function value
  // should be scoped as entity.name.function (not plain variable.other).
  if (hasCallExpr) {
    repository['object-method-key'] = {
      match: `(${identPattern})(?=\\s*:\\s*(?:\\w+\\s+)?[\\(])`,
      captures: {
        '1': { name: `entity.name.function.${langName}` },
      },
    };
    topPatterns.push({ include: '#object-method-key' });
  }

  // ── 4b1b. Constructor-call keywords (keyword + rule-ref + '(' → entity.name.function) ──
  const constructorKws = detectConstructorKeywords(grammar, tokenNames, scopeOverrides);
  for (const kw of constructorKws) {
    const kwScope = getScope(scopeOverrides, kw)!;
    const ctorEndChars = new Set<string>();
    for (const ch of ['(', ')', '}', ']', ',', '=']) {
      if (allLiterals.has(ch)) ctorEndChars.add(ch);
    }
    if (angleBracket) ctorEndChars.add('<');
    if (allLiterals.has(';')) ctorEndChars.add(';');
    const ctorEndEsc = [...ctorEndChars].map(escapeForCharClass).join('');
    const ctorEnd = ctorEndEsc ? `(?=[${ctorEndEsc}])` : '(?=[(])';
    const key = `${kw}-expression`;
    repository[key] = emitKeywordRegion({
      name: `meta.${kw}-expr.${langName}`,
      kw,
      kwScope: `${kwScope}.${langName}`,
      wordEnd: true,
      end: ctorEnd,
      patterns: [
        {
          match: identPattern,
          name: `entity.name.function.${langName}`,
        },
      ],
    });
    topPatterns.push({ include: `#${key}` });
  }

  // ── 4b2. Property access detection ──
  const propAccess = detectPropertyAccess(grammar, tokenNames);
  // Lookbehind for property access: derives extra ident chars from the Ident token
  const propLookbehind = buildIdentLookbehind(identToken);
  if (propAccess.hasDot || propAccess.hasOptionalChain) {
    if (propAccess.hasDot) {
      const dotScope = getScope(scopeOverrides,'.') ?? `punctuation.accessor.${langName}`;
      // Method call on property: obj.method() → entity.name.function
      repository['method-call'] = {
        match: `${propLookbehind}(\\.)\\s*(${identPattern})(?=\\s*\\()`,
        captures: {
          '1': { name: dotScope.includes(langName) ? dotScope : `${dotScope}.${langName}` },
          '2': { name: `entity.name.function.${langName}` },
        },
      };
      topPatterns.push({ include: '#method-call' });

      // Known properties: `.`-prefixed entries in scopeOverrides get specific scopes
      // (e.g., `.length` → support.variable.property) before the generic fallback.
      const knownProps = new Map<string, string[]>();
      for (const [key, scopes] of scopeOverrides) {
        if (key.startsWith('.') && key.length > 1) {
          const propName = key.slice(1);
          knownProps.set(propName, scopes);
        }
      }
      if (knownProps.size > 0) {
        const propGroups = new Map<string, string[]>();
        for (const [propName, scopes] of knownProps) {
          const scope = scopes[0];
          if (!propGroups.has(scope)) propGroups.set(scope, []);
          propGroups.get(scope)!.push(propName);
        }
        let propGroupIdx = 0;
        for (const [scope, props] of propGroups) {
          const propAlt = props.map(escapeRegex).join('|');
          const entryKey = propGroups.size === 1
            ? 'known-property-access'
            : `known-property-access-${propGroupIdx}`;
          repository[entryKey] = {
            match: `${propLookbehind}(\\.)\\s*(${propAlt})\\b`,
            captures: {
              '1': { name: dotScope.includes(langName) ? dotScope : `${dotScope}.${langName}` },
              '2': { name: `${scope}.${langName}` },
            },
          };
          topPatterns.push({ include: `#${entryKey}` });
          propGroupIdx++;
        }
      }

      // Property access: obj.prop → entity.other.property
      repository['property-access'] = {
        match: `${propLookbehind}(\\.)\\s*(${identPattern})`,
        captures: {
          '1': { name: dotScope.includes(langName) ? dotScope : `${dotScope}.${langName}` },
          '2': { name: `entity.other.property.${langName}` },
        },
      };
      topPatterns.push({ include: '#property-access' });
    }

    if (propAccess.hasOptionalChain) {
      const optScope = getScope(scopeOverrides,'?.') ?? `punctuation.accessor.optional.${langName}`;
      // Optional method call: obj?.method() → entity.name.function
      repository['optional-method-call'] = {
        match: `(\\?\\.)\\s*(${identPattern})(?=\\s*\\()`,
        captures: {
          '1': { name: optScope.includes(langName) ? optScope : `${optScope}.${langName}` },
          '2': { name: `entity.name.function.${langName}` },
        },
      };
      topPatterns.push({ include: '#optional-method-call' });

      // Optional property access: obj?.prop → entity.other.property
      repository['optional-property-access'] = {
        match: `(\\?\\.)\\s*(${identPattern})`,
        captures: {
          '1': { name: optScope.includes(langName) ? optScope : `${optScope}.${langName}` },
          '2': { name: `entity.other.property.${langName}` },
        },
      };
      topPatterns.push({ include: '#optional-property-access' });
    }
  }

  // ── 4b3. Arrow parameter detection ──
  if (detectBareArrowParam(grammar, tokenNames)) {
    repository['arrow-parameter'] = {
      match: `\\b(${identPattern})\\s*(?==>)`,
      captures: {
        '1': { name: `variable.parameter.${langName}` },
      },
    };
    topPatterns.push({ include: '#arrow-parameter' });
  }

  // Parenthesized arrow function params: (x, y) => ... and (x: Type) => ...
  if (detectParenArrowParams(grammar)) {
    const arrowInner: (TmPattern | { include: string })[] = [];
    if (hasTypeAnnotations && repository['param-type-annotation']) {
      arrowInner.push({ include: '#param-type-annotation' });
    }
    // Destructuring-binding param annotation (`({ a = 0 }: T) => …`), same rule as
    // the declaration-param list — emitted only when the grammar has binding patterns.
    if (repository['param-bind-type-annotation']) {
      arrowInner.push({ include: '#param-bind-type-annotation' });
    }
    // Bare parameter ident at param-start positions only (after '(' or ',').
    // Followed by ',', ')', '=' (default), ':' (type annotation), or '?' (optional).
    // Use lookbehind to avoid matching default value expressions like `= level`.
    arrowInner.push({
      match: `(?<=[,(])\\s*(\\.\\.\\.)?\\s*(${identPattern})(?=\\s*[,:)?=])`,
      captures: {
        '1': { name: `keyword.operator.spread.${langName}` },
        '2': { name: `variable.parameter.${langName}` },
      },
    });
    arrowInner.push({ include: '#nested-parens' });
    arrowInner.push({ include: '$self' });

    // The lookahead approach: match '(' only when we can confirm ')' is followed by
    // optional return-type and then '=>'. Use a non-nested lookahead for simplicity
    // (works for most practical cases).
    repository['arrow-function-params'] = {
      name: `meta.parameters.arrow.${langName}`,
      begin: `(\\()(?=[^()]*\\)\\s*(?::\\s*[^=>{]*)?\\s*=>)`,
      beginCaptures: {
        '1': { name: `punctuation.definition.parameters.begin.${langName}` },
      },
      end: '(\\))',
      endCaptures: {
        '1': { name: `punctuation.definition.parameters.end.${langName}` },
      },
      patterns: arrowInner,
    };
    topPatterns.push({ include: '#arrow-function-params' });

    // Generic-arrow param list `(…)` — e.g. the deferred multi-line form:
    //   const f = <T extends X>(
    //     a: T,
    //   ) => …
    // Reachable ONLY as a child of #generic-arrow-function, AFTER #arrow-type-parameters
    // has consumed the confirmed `<…>` and closed at its `>`. Because the wrapper already
    // proved this is a generic arrow, the very next `(` opens the arrow's param list with
    // NO look-behind — which is what makes it both correct AND Onigmo-clean (a fixed-width
    // look-behind can't tell a generic ARROW's `>` from a generic CALL's `foo<Bar>(` or a
    // comparison `a > (`, and the correct variable-width one is rejected by Onigmo). This
    // single typed region replaces #arrow-function-params for generic arrows, so it covers
    // BOTH the single-line `(x:T)=>x` and the deferred `(`-at-end-of-line form (their
    // annotations keep type scope). Emitted only when generic-arrow type params exist
    // (angleDisambig), so non-generic grammars are unaffected.
    if (angleBracket && angleDisambig) {
      repository['arrow-function-params-generic'] = {
        name: `meta.parameters.arrow.${langName}`,
        begin: '(\\()',
        beginCaptures: {
          '1': { name: `punctuation.definition.parameters.begin.${langName}` },
        },
        end: '(\\))',
        endCaptures: {
          '1': { name: `punctuation.definition.parameters.end.${langName}` },
        },
        patterns: arrowInner,
      };
    }
  }

  // ── 4b4. Ternary expression (? ... :) ──
  if (detectTernary(grammar)) {
    // Derive exclusion chars: second char of every multi-char literal starting with '?'
    // (e.g. '?.' → '.', '??' → '?', '??=' → '?') plus ':' for the ternary end itself.
    const ternaryExclude = new Set<string>();
    ternaryExclude.add(':'); // always exclude ':' — it's the ternary's own end marker
    for (const lit of allLiterals) {
      if (lit.length >= 2 && lit[0] === '?') {
        ternaryExclude.add(lit[1]);
      }
    }
    const ternaryExcludeStr = [...ternaryExclude].map(escapeForCharClass).join('');
    repository['ternary-expression'] = {
      name: `meta.ternary-expression.${langName}`,
      begin: `(\\?)(?![${ternaryExcludeStr}])`,
      beginCaptures: {
        '1': { name: `keyword.operator.ternary.${langName}` },
      },
      end: '(:)',
      endCaptures: {
        '1': { name: `keyword.operator.ternary.${langName}` },
      },
      patterns: [
        { include: '#ternary-expression' },
        { include: '$self' },
      ],
    };
    topPatterns.push({ include: '#ternary-expression' });
  }

  // ── 4c. Type-keyword patterns (keyword + @type rule → entity.name.type) ──
  // Keywords directly followed by a type reference get begin/end scopes
  // so complex types (string[], Promise<T>, { k: V }) are fully highlighted.
  const typeKws = typeRuleNames.size > 0
    ? findTypeKeywordPatterns(grammar, typeRuleNames)
    : [];
  const typeKwSet = new Set(typeKws);
  if (typeKws.length > 0) {

    // Build language-agnostic set of keywords that terminate a type context.
    // Includes type keywords + keyword.control/keyword.operator keywords.
    const typeTerminators = new Set<string>(typeKws);
    for (const [kw, scopes] of scopeOverrides) {
      if (isKeywordLiteral(kw) && scopes.some(s =>
        s.startsWith('keyword.control') || s.startsWith('keyword.operator'))) {
        typeTerminators.add(kw);
      }
    }
    const terminatorAlt = [...typeTerminators].map(escapeRegex).join('|');
    const typeKwEndChars = new Set<string>();
    for (const ch of [')', '}', '{', ']', ',', ';', '=', '>']) {
      if (allLiterals.has(ch)) typeKwEndChars.add(ch);
    }
    const typeKwEndEsc = [...typeKwEndChars].map(escapeForCharClass).join('');
    const typeKwEndParts: string[] = [];
    if (typeKwEndEsc) typeKwEndParts.push(`[${typeKwEndEsc}]`);
    if (terminatorAlt) typeKwEndParts.push(`\\b(?:${terminatorAlt})\\b`);
    const typeKwEnd = typeKwEndParts.length > 0
      ? `(?=${typeKwEndParts.join('|')})`
      : '(?=$)';

    for (const kw of typeKws) {
      const key = `${kw}-typekw`;
      const baseScope = getScope(scopeOverrides,kw) ?? 'keyword.other';
      const kwScope = `${baseScope}.${kw}`;
      // A contextual operator keyword (e.g. `as`/`keyof`/`is`/`satisfies`) opens
      // this type scope ONLY in operator position — followed by an operand. The
      // guard keeps `const as = 1` / `as()` / `as.x` from being mis-scoped as a
      // type keyword. Reserved type keywords (`extends`, `implements`) are
      // unconditional — they are never identifiers.
      const guard = contextualOps.has(kw) ? ctxOpGuard : '';

      repository[key] = emitKeywordRegion({
        name: `meta.type.${kw}.${langName}`,
        kw,
        kwScope: `${kwScope}.${langName}`,
        wordEnd: true,
        guard,
        end: typeKwEnd,
        patterns: [{ include: '#type-inner' }],
      });
      topPatterns.push({ include: `#${key}` });
    }
  }

  // ── 4d. Type annotation scope (let/const/var x: Type) ──
  if (hasTypeAnnotations) {
    // Variable-declaration keywords: those with exactly `storage.type` scope
    // (not storage.type.X), and not already handled as declaration keywords.
    const usedVarDecls = [...allLiterals].filter(l => {
      const scope = getScope(scopeOverrides,l);
      return scope === 'storage.type' && !declarationKeywords.has(l);
    });

    if (usedVarDecls.length > 0) {
      const kwAlt = usedVarDecls.map(escapeRegex).join('|');

      // Variable declaration: (let|const|var) ident :
      // The annotation ends at the initializer `=`, the statement `;`, or the
      // next declarator `,`. The `=` is matched as `=(?!>)` so the `=` of a
      // function-type return arrow (`const f: () => T = …`) does NOT prematurely
      // close the type region — keeping the post-arrow return type in type mode
      // (same arrow-vs-assignment guard #param-type-annotation already uses). The
      // `=>` arrow is the grammar's own type literal, so this stays agnostic.
      const varAnnotEndParts = ['(?=[;,]|=(?!>))'];
      if (stmtStartKeywords.size > 0) {
        const stmtAlt = [...stmtStartKeywords].map(escapeRegex).join('|');
        // Group the alternation so `\b` requires a WHOLE keyword: `^\s*(?=(?:kw)\b)`.
        // Ungrouped (`(?=kw1|kw2)\b`) the `\b` binds to the last alternative only and
        // the rest match a prefix, so a continuation line like `interfaceName: T` would
        // falsely look like a statement keyword and terminate the annotation early.
        varAnnotEndParts.push(`^\\s*(?=(?:${stmtAlt})\\b)`);
      }
      repository['type-annotation-var'] = {
        name: `meta.type.annotation.${langName}`,
        begin: `\\b(${kwAlt})\\s+(${identPattern})(\\s*:)`,
        beginCaptures: {
          '1': { name: `storage.type.${langName}` },
          '2': { name: `variable.other.${langName}` },
          '3': { name: `keyword.operator.type.annotation.${langName}` },
        },
        end: varAnnotEndParts.join('|'),
        patterns: [{ include: '#type-inner' }],
      };
      topPatterns.push({ include: '#type-annotation-var' });

      // Return type: ) :  (top-level, for arrow functions etc.)
      // Use lookbehind for ')' so it still fires after arrow-function-params
      // consumes ')' — the lookbehind checks the text, not the scope boundary.
      repository['type-annotation-return'] = {
        name: `meta.type.annotation.return.${langName}`,
        begin: '(?<=\\))(:)',
        beginCaptures: {
          '1': { name: `keyword.operator.type.annotation.${langName}` },
        },
        end: '(?=[{;]|=>)',
        patterns: [{ include: '#type-inner' }],
      };
      topPatterns.push({ include: '#type-annotation-return' });
    }
  }

  // ── 5. Keywords & constants (alphabetic literals) ──
  // Unified: all alphabetic literals are grouped by their scope from
  // the DSL `scopes` section.  Fallback: `keyword.other`.
  // Also includes extra identifiers from scopeOverrides that are NOT grammar
  // literals (e.g. `this`, `Promise`, `console`) — Phase 8 identifier scoping.
  const allKwLiterals = [...allLiterals].filter(l => isKeywordLiteral(l));
  const extraIdents = [...scopeOverrides.entries()]
    .filter(([k]) => isKeywordLiteral(k) && !allLiterals.has(k));

  if (allKwLiterals.length > 0 || extraIdents.length > 0) {
    const keywordGroups = new Map<string, string[]>();
    for (const kw of allKwLiterals) {
      const scopes = scopeOverrides.get(kw);
      if (scopes && scopes.length > 0) {
        for (const scope of scopes) {
          if (!keywordGroups.has(scope)) keywordGroups.set(scope, []);
          keywordGroups.get(scope)!.push(kw);
        }
      } else {
        if (!keywordGroups.has('keyword.other')) keywordGroups.set('keyword.other', []);
        keywordGroups.get('keyword.other')!.push(kw);
      }
    }
    for (const [ident, scopes] of extraIdents) {
      for (const scope of scopes) {
        if (!keywordGroups.has(scope)) keywordGroups.set(scope, []);
        keywordGroups.get(scope)!.push(ident);
      }
    }
    // Two classes of contextual keyword are scoped positionally instead of by the
    // flat global match (which would mis-scope their ordinary-identifier uses):
    //   1. Always-before-the-string-token (e.g. `'from' String_`): keyword only
    //      right before a string → `(?=\s*["'])` lookahead. `const from = 1`,
    //      `from()` fall through to identifier scoping. Keyed on the adjacency.
    //   2. Contextual OPERATOR keywords (`as`/`keyof`/`is`/`satisfies`/`infer`):
    //      keyword.operator.expression words that aren't always-reserved, so they
    //      double as identifiers. Keyword only in operator position (followed by
    //      `\s+` + an operand) → `ctxOpGuard`; `const as = 1`, `as()`, `as.x` fall
    //      through to `variable`. Reserved operator words (`typeof`, `new`, `void`,
    //      `delete`, `instanceof`) stay in the unconditional flat match.
    // Both are structural + agnostic: keyed on adjacency / the not()-reserved set,
    // never on a specific word.
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
    // Track scope-group keys that carry keyword.operator.expression matches, so
    // the type-inner injection below can re-include the SAME patterns (the flat
    // group and the per-word contextual-operator guards alike).
    const operatorExprIncludeKeys: string[] = [];
    for (const [scope, kws] of keywordGroups) {
      // `*.const` is a binding MARKER subtype (drives the const-binding rule), not a
      // keyword color — the keyword is already emitted by its primary scope group, so
      // skip a dead duplicate pattern here.
      if (/(^|\.)const$/.test(scope)) continue;
      const key = `scope-${scope.replace(/\./g, '-')}`;
      const isOperatorExpr = scope.startsWith('keyword.operator.expression');
      // A loop-connector keyword that the grammar proves is also a valid identifier
      // (NOT in any not()-reserved set — e.g. `of`, the for-of connector) is a
      // contextual keyword: it is the keyword ONLY in operator position (a value
      // ahead, `x of xs`), an identifier everywhere else (`const of = 1`, an `of`
      // binding name / iterable). Reserved loop words (`for`/`while`/`do`/`in`) stay
      // in the unconditional flat match. Scoped to keyword.control.LOOP on purpose:
      // other control keywords (`await`/`yield`/`return`) are real operators the
      // official grammar always keywords, even with no operand on the same line.
      // Same operand lookahead as the contextual-OPERATOR keywords; same reserved-
      // word test (collectReservedWords).
      const isContextualCtrl = scope.startsWith('keyword.control.loop');
      // Words always placed immediately before the string token (`from`) → string lookahead.
      // Contextual operator keywords (`as`/`keyof`/…) → operand lookahead.
      // Everything else → unconditional flat match.
      const beforeStringKws = kws.filter(k => alwaysBeforeString(k));
      const ctxOpKws = (isOperatorExpr || isContextualCtrl)
        ? kws.filter(k => (contextualOps.has(k) || (isContextualCtrl && !reservedWordsForCtx.has(k))) && !alwaysBeforeString(k))
        : [];
      const ctxOpSet = new Set(ctxOpKws);
      // Accessibility-style modifiers that double as identifiers (`public x` vs
      // `var public = 1`): scoped only in modifier position, via a member-start
      // lookahead. The rest of the group keeps the unconditional flat match.
      const ctxModKws = kws.filter(k => contextualModifiers.has(k) && !alwaysBeforeString(k) && !ctxOpSet.has(k));
      const ctxModSet = new Set(ctxModKws);
      // Drop keywords whose keyword role is owned by a dedicated declaration context
      // (e.g. `constructor` → #constructor-declaration in class bodies). They double
      // as identifiers everywhere else, so the flat match must not paint them.
      // Phase modifiers (`defer`, only ever before the namespace `*`) are likewise
      // scoped positionally by #import-export-all — never in the flat match, which
      // would mis-paint their ordinary-identifier uses (`const defer`, `defer()`,
      // `import defer from "m"`).
      const globalKws = kws.filter(k => !alwaysBeforeString(k) && !ctxOpSet.has(k) && !ctxModSet.has(k) && !contextDeclaredKws.has(k) && !phaseModifierKws.has(k));
      if (globalKws.length > 0) {
        // A `support.class` group names BUILTIN CLASS/TYPE identifiers (Object, Array,
        // Promise, …) — but, unlike a true keyword, those words also appear as runtime
        // VALUES: `Object.keys(x)` (member-access LHS), `Object(x)` (call). tsc/official
        // scope a builtin in value position as a value, NOT a class, so the unconditional
        // flat match over-paints it. Guard the flat match with a NEGATIVE lookahead that
        // makes it ABSTAIN when the builtin is immediately followed by a member accessor
        // (`.`/`?.`) or a call `(`; the word then falls through to the already-derived
        // value rules (#method-call/#property-access for the `.member`, #function-call for
        // a direct call, #ident for the bare LHS) — exactly as a non-builtin capitalised
        // name does. TYPE positions (annotation/heritage/type-args) reach the builtin
        // through `<`/whitespace, never `.`/`(`, so they still hit the flat match and keep
        // `support.class`; member-LHS/call positions are never type positions, so this is
        // type-position-safe by construction. Convention-driven (keys on the `support.class`
        // scope name like the storage.type.*/`*.extends` handling above), not on any word.
        // Value-position openers are the member accessors (`.`/`?.`) and the call `(`.
        // Detect each from the grammar's own punctuation data (its scope map / accessor
        // detection) rather than assuming the JS spellings: `.` via accessor detection
        // OR a `punctuation.accessor` scope entry, `?.` via its `punctuation.accessor`
        // (optional) scope entry, `(` via its `punctuation.bracket`/round scope entry.
        const accessorChar = (lit: string): string | undefined => {
          const sc = getScope(scopeOverrides, lit);
          return sc && /(^|\.)accessor(\.|$)/.test(sc) ? escapeRegex(lit) : undefined;
        };
        const callOpener = (): string | undefined => {
          for (const [lit, scopes] of scopeOverrides)
            if (/(^|\.)bracket\.round(\.|$)/.test(scopes[0] ?? '') && /[([{]/.test(lit)) return escapeRegex(lit);
          return undefined;
        };
        const valuePosOpeners = [
          propAccess.hasDot ? '\\.' : accessorChar('.'),
          accessorChar('?.'),
          callOpener(),
        ].filter((x): x is string => !!x);
        const isBuiltinClass = scope === 'support.class' || scope.startsWith('support.class.');
        const valueAbstain = isBuiltinClass && valuePosOpeners.length > 0
          ? `(?!\\s*(?:${valuePosOpeners.join('|')}))`
          : '';
        repository[key] = {
          match: `\\b(${globalKws.map(escapeRegex).join('|')})\\b${valueAbstain}`,
          name: `${scope}.${langName}`,
        };
        topPatterns.push({ include: `#${key}` });
        if (isOperatorExpr) operatorExprIncludeKeys.push(key);
      }
      // Contextual accessibility modifiers: one guarded entry, placed at the same
      // position as the flat group (before #ident) so a real modifier still wins,
      // while a non-modifier use falls through to the surrounding identifier scope.
      if (ctxModKws.length > 0) {
        const mkey = `${key}-accessibility`;
        repository[mkey] = {
          match: `\\b(${ctxModKws.map(escapeRegex).join('|')})\\b${modifierGuard}`,
          name: `${scope}.${langName}`,
        };
        topPatterns.push({ include: `#${mkey}` });
      }
      for (const kw of beforeStringKws) {
        const ckey = `${key}-${kw.replace(/[^a-z0-9]/gi, '')}`;
        repository[ckey] = {
          match: `\\b${escapeRegex(kw)}\\b(?=\\s*["'])`,
          name: `${scope}.${langName}`,
        };
        topPatterns.push({ include: `#${ckey}` });
      }
      // One positional entry per contextual keyword: keyword only when an operand
      // follows (a type/value start); otherwise the word falls through to identifier
      // scoping (variable.other). Operator keywords (`as`/`keyof`/…) require the
      // whitespace-separated operand of `ctxOpGuard`; a loop connector (`of`) also
      // accepts a no-space non-identifier iterable opener via `ctxLoopGuard`.
      const guard = isContextualCtrl ? ctxLoopGuard : ctxOpGuard;
      for (const kw of ctxOpKws) {
        const ckey = `${key}-${kw.replace(/[^a-z0-9]/gi, '')}`;
        repository[ckey] = {
          match: `\\b(${escapeRegex(kw)})\\b${guard}`,
          name: `${scope}.${langName}`,
        };
        topPatterns.push({ include: `#${ckey}` });
        if (isOperatorExpr) operatorExprIncludeKeys.push(ckey);
      }
    }

    // Inject type-related support patterns into type annotation contexts so
    // primitives (`string`, `number`, `void`) keep their specific scope in types.
    // NOTE: support.class is deliberately NOT injected here. In TYPE position the
    // official grammar scopes built-in class names (Error, Promise, Function, …) as
    // entity.name.type — a type reference — not support.class. Omitting it lets a
    // BARE built-in name fall through to #simple-type → entity.name.type (matching
    // official); support.class still applies in VALUE position via the global pattern.
    if (hasTypeAnnotations) {
      // Order matters: TM matches first pattern that matches, so more specific
      // type scopes (support.type.primitive) must come before broader ones
      // (keyword.operator.expression) to give `void` the right scope in types.
      // support.type / constant.language map 1:1 to a flat scope-include; the
      // keyword.operator.expression scope is split across operatorExprIncludeKeys
      // (the flat reserved group + each contextual-operator guard), all injected
      // LAST so a contextual operator keeps keyword scope in type position
      // (`keyof T`, `p is T`, `infer U`) yet a bare type name still reaches
      // #simple-type → entity.name.type.
      const supportConstScopes = [...keywordGroups.keys()]
        .filter(scope => scope.startsWith('support.type.')
          || scope.startsWith('constant.language.'));
      supportConstScopes.sort((a, b) => {
        const order = (s: string) => s.startsWith('support.type.') ? 0 : 1;
        return order(a) - order(b);
      });
      // TYPE-POSITION builtin literals — `undefined`/`null`/`true`/`false` are
      // value `constant.language.*` keywords in EXPRESSION position, but in a TYPE
      // they are primitive type-builtins (official's `type-builtin-literals` →
      // support.type.builtin: `this|true|false|undefined|null|object`). In type
      // position tsc lexes a bare `undefined` as a type keyword (support.type),
      // never the value constant; the literal-type `null`/`true`/`false` are
      // defensibly a type-builtin too. So a constant.language keyword that the
      // grammar ALSO admits in type position (it appears in a @type rule, i.e. is a
      // typeContextKeyword) is re-scoped support.type.builtin HERE — type-inner is
      // only reached in type position, so the value-context match is untouched.
      // `this`/`super` (variable.language) are deliberately excluded: a type `this`
      // is the polymorphic-this binding, defensibly variable.language, not a
      // type-builtin. Derived from the grammar's own typeContextKeywords ∩
      // constant.language groups — no hardcoded word list.
      const typeBuiltinLiterals = [...keywordGroups.entries()]
        .filter(([scope]) => scope.startsWith('constant.language.'))
        .flatMap(([, kws]) => kws)
        .filter(kw => typeContextKeywords.has(kw));
      const typeBuiltinKey = 'type-builtin-literals';
      if (typeBuiltinLiterals.length > 0) {
        repository[typeBuiltinKey] = {
          match: `\\b(${typeBuiltinLiterals.map(escapeRegex).join('|')})\\b`,
          name: `support.type.builtin.${langName}`,
        };
      }
      // TYPE-POSITION storage modifiers — `readonly` of `readonly T[]` (and the
      // index/mapped `readonly [`) is a `storage.modifier` keyword that ALSO heads a
      // type operator (it appears in a @type rule → typeContextKeyword). In type
      // position it would otherwise be eaten by #simple-type → entity.name.type; a
      // dedicated include keeps its storage.modifier scope (matching official, which
      // paints type-position `readonly` storage.modifier). Only storage.modifier
      // keywords that are typeContextKeywords are emitted (the pure declaration
      // modifiers `public`/`static`/… never reach type position), so this is exactly
      // `readonly` for TS — derived from the grammar, no hardcoded word.
      const typeStorageMods = new Map<string, string[]>();
      for (const [scope, kws] of keywordGroups) {
        if (!scope.startsWith('storage.modifier')) continue;
        const inType = kws.filter(kw => typeContextKeywords.has(kw));
        if (inType.length > 0) typeStorageMods.set(scope, inType);
      }
      const typeStorageModIncludes: { include: string }[] = [];
      for (const [scope, kws] of typeStorageMods) {
        const tmKey = `type-${scope.replace(/\./g, '-')}`;
        repository[tmKey] = {
          match: `\\b(${kws.map(escapeRegex).join('|')})\\b`,
          name: `${scope}.${langName}`,
        };
        typeStorageModIncludes.push({ include: `#${tmKey}` });
      }
      // The constant.language type-builtins are emitted by #type-builtin-literals
      // above, so drop their value-scope includes from the type-context injection
      // (otherwise the value scope would win first, since type-builtin runs after).
      const typeBuiltinLiteralSet = new Set(typeBuiltinLiterals);
      const supportConstIncludes = supportConstScopes.filter(scope => {
        if (!scope.startsWith('constant.language.')) return true;
        const kws = keywordGroups.get(scope) ?? [];
        // keep the include only if it still has keywords NOT promoted to type-builtin
        return kws.some(kw => !typeBuiltinLiteralSet.has(kw));
      });
      const typeRelatedIncludes = [
        // Comments first: a `//` / `/* */` may sit anywhere in type position
        // (notably inside a multiline generic argument list). Without these the
        // `/` would fall through unmatched and the comment body would be
        // mis-scoped as a type name.
        ...commentIncludeKeys.map(key => ({ include: `#${key}` })),
        // A LEADING `<…>` type-parameter list of a generic function-type
        // (`<T, U>(x: T) => U`, e.g. `declare const f: <T>(…) => …`). In type
        // position — the only place `#type-inner` is reached — a bare `<` (one not
        // preceded by a type name, which `#generic-type`'s `name<` already claims)
        // can only open such a list, so re-using the declaration type-param list
        // (`extends`/defaults/nested generics scoped identically) is unambiguous.
        // Without it the `<` falls through, the params get expression scopes and the
        // closing `>` is mis-read as a relational operator. Gated on the entry
        // existing (a grammar with no generic declarations emits none).
        ...(repository['declaration-type-params'] ? [{ include: '#declaration-type-params' }] : []),
        // type-builtin literals (undefined/null/true/false → support.type.builtin)
        // must precede the remaining support.type / constant.language includes.
        ...(typeBuiltinLiterals.length > 0 ? [{ include: `#${typeBuiltinKey}` }] : []),
        // type-position storage modifiers (`readonly T[]` → storage.modifier).
        ...typeStorageModIncludes,
        ...supportConstIncludes.map(scope => ({ include: `#scope-${scope.replace(/\./g, '-')}` })),
        ...operatorExprIncludeKeys.map(key => ({ include: `#${key}` })),
      ];
      if (typeRelatedIncludes.length > 0) {
        // Inject type-related scopes into type-inner (non-mutating rebuild).
        // All consumers reference #type-inner via include, so they see the
        // updated patterns automatically — no separate patching needed.
        if (repository['type-inner']) {
          const base = repository['type-inner'].patterns!;
          const idx = base.findIndex(
            p => 'include' in p && p.include === '#simple-type'
          );
          if (idx !== -1) {
            repository['type-inner'] = {
              patterns: [
                ...base.slice(0, idx),
                ...typeRelatedIncludes,
                ...base.slice(idx),
              ],
            };
          }
        }
        // generic-type, generic-call, generic-call-eol all reference #type-inner
        // via typeInnerRef(), so the injection above is automatically visible.
      }
    }
  }

  // Patch type-paren with param-type-annotation so function-type params
  // like `(raw: unknown) => T` get variable.parameter scoping. A destructuring-binding
  // function-type param (`({ a }: P) => void`) routes its `: P` through the same
  // binding rule (when the grammar emitted it).
  if (repository['type-paren'] && repository['param-type-annotation']) {
    repository['type-paren'].patterns = [
      { include: '#param-type-annotation' },
      ...(repository['param-bind-type-annotation'] ? [{ include: '#param-bind-type-annotation' }] : []),
      { include: '#type-inner' },
    ];
  }

  // ── 6. Operators and punctuation ──
  // Derive punctuation set from scopeOverrides: any literal with a `punctuation.*` scope.
  // Also: symbolic literals with no scope override and not in the prec table are structural
  // punctuation (e.g. `:` used for type annotations, object keys — not an expression operator).
  const punctuationChars = new Set<string>();
  for (const [lit, scopes] of scopeOverrides) {
    if (!isKeywordLiteral(lit) && !lit.startsWith('.') && scopes.some(s => s.startsWith('punctuation.'))) {
      punctuationChars.add(lit);
    }
  }
  const precOpSet = new Set<string>();
  for (const level of grammar.precs) {
    for (const op of level.operators) precOpSet.add(op.value);
  }
  for (const lit of allLiterals) {
    if (!isKeywordLiteral(lit) && !lit.startsWith('.') && !scopeOverrides.has(lit) && !precOpSet.has(lit)) {
      punctuationChars.add(lit);
    }
  }
  const symbolicLiterals = [...allLiterals].filter(l => !isKeywordLiteral(l));

  // Accessor literals already consumed by property-access capture patterns
  const accessorExclude = new Set<string>();
  if (propAccess.hasOptionalChain) accessorExclude.add('?.');

  // Exclude bare '<' and '>' when angle bracket disambiguation is active
  const allOperators = symbolicLiterals.filter(l =>
    !punctuationChars.has(l) && !angleBracketExclude.has(l) && !accessorExclude.has(l)
  );
  const punctuation = symbolicLiterals.filter(l => punctuationChars.has(l));

  // Split overridden operators: keyword.operator.* go into combined captures pattern;
  // non-keyword-operator scopes (e.g. storage.type.function.arrow for '=>') get standalone
  // patterns to avoid cross-group prefix conflicts (=> vs =).
  const overriddenOps = allOperators.filter(o => {
    const scope = getScope(scopeOverrides,o);
    return scope && scope.startsWith('keyword.operator.');
  });
  const structuralOps = allOperators.filter(o => {
    const scope = getScope(scopeOverrides,o);
    return scope && !scope.startsWith('keyword.operator.');
  });
  const operators = allOperators.filter(o => !scopeOverrides.has(o));

  // Structural operators: standalone patterns (e.g. '=>' → storage.type.function.arrow)
  if (structuralOps.length > 0) {
    const structGroups = new Map<string, string[]>();
    for (const op of structuralOps) {
      const scope = getScope(scopeOverrides,op)!;
      if (!structGroups.has(scope)) structGroups.set(scope, []);
      structGroups.get(scope)!.push(op);
    }
    for (const [scope, ops] of structGroups) {
      const key = `scope-${scope.replace(/\./g, '-')}`;
      if (!repository[key]) {
        const sorted = [...ops].sort((a, b) => b.length - a.length);
        repository[key] = {
          match: sorted.map(escapeRegex).join('|'),
          name: `${scope}.${langName}`,
        };
        topPatterns.push({ include: `#${key}` });
      }
    }
  }

  // Overridden keyword operators: ONE pattern whose alternatives are ordered
  // GLOBALLY by length descending, with a capture per operator mapped to its
  // scope. A regex alternation is ordered-first-match, NOT longest-match, so
  // grouping per scope and concatenating `(group1)|(group2)` lets a short op in
  // an earlier group shadow a longer op in a later one: e.g. `=` (assignment)
  // would match the first char of `===` (comparison) before the comparison group
  // is ever tried, tokenizing `===` as three `=`. Sorting EVERY operator into a
  // single global length-descending alternation is the only ordering that keeps
  // longer operators winning across scope boundaries (`===` before `=`, `>=`
  // before nothing-shorter, `**=` before `**` before `*`).
  if (overriddenOps.length > 0) {
    const flat = overriddenOps
      .map(op => ({ op, scope: getScope(scopeOverrides, op)! }))
      .sort((a, b) => b.op.length - a.op.length);
    const parts: string[] = [];
    const captures: Record<string, { name: string }> = {};
    flat.forEach((f, i) => {
      parts.push(`(${escapeRegex(f.op)})`);
      captures[String(i + 1)] = { name: `${f.scope}.${langName}` };
    });
    repository['operator-overrides'] = {
      match: parts.join('|'),
      captures,
    };
    topPatterns.push({ include: '#operator-overrides' });
  }

  if (operators.length > 0) {
    const sorted = [...operators].sort((a, b) => b.length - a.length);
    repository['operators'] = {
      match: sorted.map(escapeRegex).join('|'),
      name: `keyword.operator.${langName}`,
    };
    topPatterns.push({ include: '#operators' });
  }

  // Punctuation: split overridden (custom scope) vs generic
  const overriddenPunct = punctuation.filter(p => scopeOverrides.has(p));
  const genericPunct = punctuation.filter(p => !scopeOverrides.has(p));

  if (overriddenPunct.length > 0) {
    const punctGroups = new Map<string, string[]>();
    for (const p of overriddenPunct) {
      const scope = getScope(scopeOverrides,p)!;
      if (!punctGroups.has(scope)) punctGroups.set(scope, []);
      punctGroups.get(scope)!.push(p);
    }
    for (const [scope, ps] of punctGroups) {
      const key = `scope-${scope.replace(/\./g, '-')}`;
      const sorted = [...ps].sort((a, b) => b.length - a.length);
      if (!repository[key]) {
        repository[key] = {
          match: sorted.map(escapeRegex).join('|'),
          name: `${scope}.${langName}`,
        };
        topPatterns.push({ include: `#${key}` });
      }
    }
  }

  if (genericPunct.length > 0) {
    const sorted = [...genericPunct].sort((a, b) => b.length - a.length);
    repository['punctuation'] = {
      match: sorted.map(escapeRegex).join('|'),
      name: `punctuation.${langName}`,
    };
    topPatterns.push({ include: '#punctuation' });
  }

  // Add comparison fallback after operators when disambiguation is active
  if (angleBracket) {
    topPatterns.push({ include: '#comparison' });
  }

  // ── 7. Reorder for correct TextMate precedence ──
  // Stable sort: tokens/patterns sharing an order number keep their insertion order.
  function scopeOrder(include: string): number {
    const key = include.slice(1); // remove '#'
    // Generic-arrow type params (`<T>(…) =>`, `async <T>(…) =>`) must beat the
    // generic-call layers, #type-cast and #comparison: its trigger is the most
    // specific (arrow position + arrow-param confirm) and it fully scopes the
    // type-parameter list (extends / defaults), which the others do not.
    // JSX element triggers (expression-position, disambiguated) must beat the
    // generic-call / cast / comparison angle-bracket layers AND #arrow-type-
    // parameters: a `<` at expression-start with a tag-shaped lookahead is JSX,
    // and the lookahead is the most specific. Self-closing before open/fragment.
    // #generic-arrow-function is the top-level wrapper that now owns the generic-arrow
    // `<…>(…)`; it triggers at the same `<` position the old top-level #arrow-type-parameters
    // did, so it inherits the same -7 slot (#arrow-type-parameters is now only its child).
    if (key === 'generic-arrow-function') return -7;
    if (key === 'arrow-type-parameters') return -7;
    if (key === 'jsx-self-closing-element-in-expression') return -6;
    if (key === 'jsx-element-in-expression') return -5.5;
    if (key === 'jsx-fragment-in-expression') return -5;
    if (key === 'generic-call') return -3;
    if (key === 'generic-call-eol') return -2;
    if (key === 'generic-call-multiline') return -1;
    // Prefix cast `<Type>expr` — its `<` is expression-start (mutually exclusive
    // with the generic-call ident-lookbehind) but must beat #comparison's flat
    // `[<>]` and every value/property pattern so the inner type reaches type-inner.
    if (key === 'type-cast') return -0.5;
    const entry = repository[key];
    const scope = entry?.name ?? '';
    if (scope.startsWith('comment.')) return 0;
    // An explicit mapping-key rule (`? key`) is the most specific scalar context — its indicator
    // pins the following scalar as a key — so it must be tried before the bare key/plain scalars.
    if (key === 'explicit-key') return 0.8;
    // The bare explicit-key indicator (`?` alone on its line) must beat the generic `?` punctuation
    // token (rank 9) so it scopes as the map-key punctuation, not a plain bracket.
    if (key === 'explicit-key-indicator') return 0.82;
    // The value-position block scalars (`key: |` / `- |` / `--- |`) and the `? |` explicit-key
    // variant now begin AT LINE START (`^([ \t]*)`), so they compete at column 0 with #key /
    // quoted-keys / #docstart / #explicit-key (all of which also start there). On a same-start tie
    // oniguruma's scanner picks the FIRST listed pattern, so these MUST out-rank every key/scalar/
    // doc-marker token (rank ≥ 0.8) — their lookahead requires a real `[|>]…(#|$)` value-position
    // header, so they never steal a non-block-scalar line. Three precedence facts decide the order:
    //   • `-seq` (dash + KEY + `:`) and the plain rule BOTH match `- a: |`, but `-seq` bounds siblings
    //     at the deeper KEY column, so it must be tried first → lowest rank.
    //   • `blockscalar-key` (`?`-anchored) and the plain rule BOTH match `? |` (the plain VP admits a
    //     leading `?`), but the key variant scopes the body as the key NAME, so it must win → below
    //     the plain rule.
    //   • `-doc` (document-root: bare `|` / `--- |` at column 0, no key/dash) and the plain rule BOTH
    //     match a column-0 header, but `-doc` bounds the body at the next document marker (so a
    //     column-0 body survives, instead of the plain rule's node-indent `while` ending it early), so
    //     `-doc` must be tried first → above the plain rule. It never collides with `-seq`/`-key`
    //     (those carry a leading `-`/`?` its lookahead forbids).
    //   • the plain `blockscalar` is the fallback (bare `|`, `key: |`, `--- |` with an indented body).
    const bsRank = grammar.indent?.blockScalar?.token.toLowerCase();
    // EXPLICIT-indent block scalars (`|N`, §2a‴) must out-rank their auto-detect counterparts so a
    // `|N` header takes the digit-aware floor. The sequence variant (`- a: |N`) ranks above the value
    // variant: a `- …: |N` line matches BOTH (the value `bsVp` admits a leading `- `), and only the
    // sequence floor adds the dash column, so it must win. Both stay below `blockscalar-key` (0.55) so a
    // `? |N` explicit-key block scalar still scopes its `?` as the map key. (`-explicit-seq-` is tested
    // before `-explicit-` because the seq keys also start with the value prefix.)
    if (bsRank && key.startsWith(`${bsRank}-explicit-seq-`)) return 0.45;
    if (bsRank && key.startsWith(`${bsRank}-explicit-`)) return 0.57;
    if (bsRank && key === `${bsRank}-seq`) return 0.5;
    if (key === 'blockscalar-key') return 0.55;
    if (bsRank && key === `${bsRank}-doc`) return 0.58;
    if (bsRank && key === bsRank) return 0.6;
    // The multi-line plain-scalar continuation region (§2a′) also begins AT LINE START (`^([ \t]*)`),
    // so it competes at column 0 with #key / quoted-keys / #docstart / #explicit-key (rank ≥ 0.8) and
    // MUST out-rank them: on a same-start tie oniguruma picks the FIRST listed pattern, and the region
    // must open so it can claim the continuation lines (else #key/#explicit-key win the header and a
    // deeper `!`/digit/`%` line falls through to #tag/#num/#directive). It ranks BELOW the
    // block-scalar regions (≤ 0.6) so a `key: |` keeps its block-scalar region — its lookahead requires
    // a real plain VALUE head (never `|`/`>`), so the two never collide on the same line anyway.
    // The explicit-key continuation (`? a\n  true`) must out-rank #plain-continuation (0.7): both open
    // on a `? `-led header (the `?` is in compactCls), but the explicit-key variant scopes the folded
    // continuation as the KEY (entity.name.tag), so it must win for the `?` case; #plain-continuation
    // still handles `key:`/`- ` folds (its lookahead, unlike this one, is not pinned to the `?`).
    if (key === 'explicit-key-continuation') return 0.68;
    if (key === 'plain-continuation') return 0.7;
    // The BARE plain-scalar same-column fold (§2a″) likewise begins AT LINE START and must out-rank the
    // scalar tokens (#key/#num/#boolnull/#plain ≥ 0.8) so it opens on a bare value scalar and claims its
    // same-column/deeper continuation lines. Disjoint from #plain-continuation (that needs a key-colon/
    // indicator value header; this forbids them), so their relative order is irrelevant.
    if (key === 'plain-bare-fold') return 0.72;
    // A flow collection (`{ … }` / `[ … ]`) is a begin/end region opened by a bracket; it must be
    // tried before #punctuation (which would otherwise claim the `{`/`[` as a bare bracket) and
    // before the scalar tokens. Its `{`/`[` can never lead a plain scalar, so this ranking is safe.
    if (key === 'flow-mapping' || key === 'flow-sequence') return 0.85;
    // A top-level token-match scoped `entity.name.tag` (e.g. an indentation grammar's mapping
    // KEY — a scalar that is the LHS of `:`) is a NAME, more specific than any string/typed-value
    // scalar it overlaps, so it must be tried first. (Markup tag names live inside begin/end
    // regions, never as a top-level include, so this only ranks the YAML-style key scalar.)
    // A top-level token scoped `entity.name.tag` is a NAME (an indentation grammar's mapping KEY): a
    // flat `match` (plain key) OR a begin/end region (a quoted key with sub-scoped escapes). Either
    // must be tried before the value scalars / value-string regions it overlaps.
    if ((entry?.match || entry?.begin) && scope.startsWith('entity.name.tag')) return 0.9;
    // A document marker (`---`/`...`, scoped entity.other.document) is a `lit`+lookahead token that
    // OVERLAPS the plain scalar (`---` also matches PLAIN_HEAD), so it must out-rank the plain-scalar
    // catch-all (8.8) — else `---` paints as string.unquoted. Its lookahead pins it to a real marker.
    if (entry?.match && scope.startsWith('entity.other.document')) return 0.95;
    // An UNQUOTED plain-scalar catch-all (`string.unquoted`) is the least-specific scalar shape
    // (it has no opening delimiter and matches almost any bare run), so — unlike a quoted/regex
    // string — it must rank AFTER the typed-literal scalars (constant.numeric / constant.language)
    // that overlap it, while still beating structural punctuation (so `-1` reads as the scalar,
    // not a `-` operator). Only an indentation/plain-scalar grammar (YAML) has such a top-level
    // token; quoted strings keep rank 1, so the TS/JS/markup families are unaffected.
    if (scope.startsWith('string.unquoted')) return 8.8;
    if (scope.startsWith('string.')) return 1;
    if (scope.includes('entity.name.function.decorator')) return 1.5;
    if (key === 'type-annotation-var' || key === 'type-annotation-return') return 1.8;
    if (key === 'object-method-key') return 1.85;
    if (key.endsWith('-expression') && key !== 'ternary-expression' && !key.startsWith('scope-')) return 1.9;
    if (key === 'arrow-function-params') return 1.95;
    // The deferred-`(` generic-arrow param list ranks with #arrow-function-params so it
    // beats the bare bracket/punctuation rules that would otherwise claim the `(`.
    if (key === 'arrow-function-params-generic') return 1.95;
    if (key === 'ternary-expression') return 1.97;
    if (key.endsWith('-declaration') || key.endsWith('-definition') || key.endsWith('-typekw') || key.endsWith('-binding') || key.endsWith('-destructure')) return 2;
    // import/export namespace `*` must beat both the import/export keyword group
    // (which would consume the keyword alone) and the arithmetic-operator match.
    if (key === 'import-export-all') return 2;
    // A default-import binding name (`import X from`, `import type from`) must beat
    // the flat import keyword group AND the `type <name>` declaration/storage match
    // for the contextual-keyword-as-binding case; leftmost-match handles the region
    // one token to the right, this rank wins the position-0 tie.
    if (key === 'import-default-binding') return 2;
    if (scope.includes('constant.numeric')) return 3; // stable sort preserves DSL token order
    if (scope.includes('keyword.operator') && key.startsWith('scope-')) return 4;
    if (scope.includes('keyword.control')) return 5;
    // A malformed-directive fallback (monogram#12 #4) is scoped keyword.other.directive, so it would
    // otherwise tie the CLEAN directive tokens at 6. Rank it just below them and below constant.language
    // (7) — so a well-formed directive still wins — but ABOVE the plain scalars (string.unquoted 8.8) so
    // it claims a `%`-led line the clean tokens left, beating the stray-scalar mis-scope it exists to fix.
    if (key === 'directive-malformed') return 6.5;
    if (scope.includes('storage.') || scope.includes('keyword.other')) return 6;
    if (scope.includes('constant.language')) return 7;
    if (scope.includes('variable.language')) return 7.5;
    if (scope.includes('support.')) return 7.5;
    if (key === 'operator-overrides') return 8;
    if (scope.includes('keyword.operator') && key !== 'comparison') return 8;
    if (key === 'method-call' || key === 'optional-method-call') return 7.7;
    if (key === 'known-property-access' || key.startsWith('known-property-access-')) return 7.75;
    if (key === 'property-access' || key === 'optional-property-access') return 7.8;
    if (scope.includes('punctuation')) return 9;
    if (key === 'arrow-parameter') return 9.3;
    if (key === 'function-call') return 9.5;
    if (scope.includes('variable.') || key === 'ident') return 10;
    if (key === 'comparison') return 11;
    return 12;
  }

  const orderedPatterns = [...new Set(topPatterns.map(p => p.include))]
    .sort((a, b) => scopeOrder(a) - scopeOrder(b))
    .map(include => ({ include }));

  // Additive: a `#expression` sub-grammar for expression-only embeds (Vue `{{ }}`). The
  // top-level `patterns` (orderedPatterns / $self) are left untouched, so standalone
  // tokenization is unchanged — `#expression` is inert unless something includes it.
  if (grammar.expressionRule) deriveExpressionEntry(grammar, orderedPatterns, repository);

  // Repository-key NAMING CONSTRAINT (官方命名「限制器」): rename Monogram's structural keys to the
  // official names a drop-in must expose, and rewrite all references — in the repository AND the
  // top-level patterns. Runs last so `#expression` (a real key) is already in place; it never
  // clobbers a key that already matches by name. Pure rename → tokenization unchanged.
  applyCanonicalRepoNames(grammar, repository, orderedPatterns);

  // ── meta.stream wrapper (indentation grammars with a block scalar only) ──
  // A block scalar BODY must survive EMPTY lines (see §2a). The mechanism is a line-spanning
  // `while: \G` parent that RE-ANCHORS `\G` at the start of every line — including blank ones — so a
  // nested `while: \G` body region stays alive across blanks instead of collapsing. We wrap ALL top
  // patterns in RedCMD's two-arm `meta.stream` region: the first arm (`begin: ^(?!\G)`/`while: ^`)
  // drives normal top-of-stream tokenisation; the second (`begin: \G(?!$)`/`while: \G`) is the
  // embedded-start case (YAML inside a Markdown fence). Tokenisation of every construct is unchanged
  // — the wrapper only adds the persistent `\G` anchor the block scalar needs. Gated to grammars that
  // actually emit a block scalar so non-indentation languages (TS/HTML/…) stay byte-identical.
  let finalPatterns: ({ include: string } | TmPattern)[] = orderedPatterns;
  if (grammar.indent?.blockScalar) {
    finalPatterns = [
      { begin: '^(?!\\G)', while: '^', name: `meta.stream.${langName}`, patterns: orderedPatterns },
      { begin: '\\G(?!$)', while: '\\G', name: `meta.stream.${langName}`, patterns: orderedPatterns },
    ];
  }

  return {
    $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
    name: grammarName,
    scopeName,
    patterns: finalPatterns,
    repository,
  };
}
