import type { CstGrammar, RuleExpr, RuleDecl, InjectClause } from './types.ts';
import { collectLiterals, isKeywordLiteral, stringDelimiters } from './grammar-utils.ts';

interface TmPattern {
  name?: string;
  contentName?: string;
  match?: string;
  begin?: string;
  end?: string;
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
  patterns: ({ include: string })[];
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

/**
 * Extract non-\w characters that are valid in identifiers from the Ident token regex.
 * E.g., `[a-zA-Z_$][a-zA-Z0-9_$]*` → `['$']` ($ is not covered by \w).
 * Returns escaped characters suitable for embedding in a regex character class.
 */
function identExtraChars(identRegex: string): string {
  const extras = new Set<string>();
  let inClass = false;
  for (let i = 0; i < identRegex.length; i++) {
    const c = identRegex[i];
    if (c === '\\') {
      // Skip the escape and, for braced escapes (`\p{L}`, `\u{...}`), the whole
      // `{...}` argument — otherwise the `{`/`}`/letters inside would be mistaken
      // for literal identifier characters.
      i++;
      if (identRegex[i + 1] === '{') { while (i < identRegex.length && identRegex[i] !== '}') i++; }
      continue;
    }
    if (c === '[') { inClass = true; continue; }
    if (c === ']') { inClass = false; continue; }
    if (inClass && !/[a-zA-Z0-9_\-^]/.test(c)) {
      extras.add(c);
    }
  }
  return [...extras].map(escapeForCharClass).join('');
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
 * Derives extra identifier characters (e.g., `$`) from the Ident token regex
 * instead of hardcoding them.
 */
function buildIdentLookbehind(identRegex: string): string {
  const extra = identExtraChars(identRegex);
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

/**
 * Extract begin/end delimiters from a block-style token pattern by splitting
 * on the "match-everything" body (e.g., [\s\S]*?).
 * Returns null if no such body is found (pattern is not block-style).
 */
function extractBlockDelimiters(pattern: string): [string, string] | null {
  const bodies = ['[\\s\\S]*?', '[\\s\\S]+?', '[^]*?'];
  for (const body of bodies) {
    const idx = pattern.indexOf(body);
    if (idx !== -1) {
      const begin = pattern.slice(0, idx);
      const end = pattern.slice(idx + body.length);
      if (begin && end) return [begin, end];
    }
  }
  return null;
}

/**
 * Detect the interpolation prefix character from a template token pattern.
 * Looks for `\X(?!\{)` patterns — meaning X followed by { starts interpolation.
 * E.g., `\$(?!\{)` → prefix is '$', so `${...}` is interpolation.
 *       `\#(?!\{)` → prefix is '#', so `#{...}` is interpolation (Ruby).
 * Returns null if no interpolation pattern is found.
 */
function extractInterpPrefix(pattern: string): string | null {
  for (let i = 0; i < pattern.length - 5; i++) {
    if (pattern[i] === '\\' && pattern.slice(i + 2, i + 5) === '(?!') {
      const rest = pattern.slice(i + 5);
      if (rest.startsWith('\\{)') || rest.startsWith('{)')) {
        return pattern[i + 1];
      }
    }
  }
  return null;
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

// ── Token classification ──

/**
 * Extract the literal prefix from a regex pattern (the characters before any metachar).
 * E.g., `\/\/[^\n]*` → `//`, `#[^\n]*` → `#`, `--.*` → `--`.
 */
function extractRegexLiteralPrefix(pattern: string): string {
  let prefix = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      // Escaped literal char (e.g. `\/` → `/`)
      if (!/[a-zA-Z0-9]/.test(next)) {
        prefix += next;
        i++;
      } else {
        break; // shorthand like \s, \d — not a literal
      }
    } else if ('[(.+*?^$|{'.includes(c)) {
      break; // regex metachar
    } else {
      prefix += c;
    }
  }
  return prefix;
}

/**
 * Derive a TextMate-conventional suffix for line comment scope based on the
 * literal prefix of the regex pattern.  E.g., `//` → `double-slash`,
 * `#` → `number-sign`.
 *
 * Uses a universal character-name mapping (not language-specific).
 */
function lineCommentScopeSuffix(pattern: string): string {
  const prefix = extractRegexLiteralPrefix(pattern);
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

function classifyToken(pattern: string, flags: string[]): { scope: string; isBlock?: boolean } {
  if (flags.includes('skip')) {
    // Block comment: pattern has a "match everything" body ([\s\S]*?, etc.)
    // Use extractBlockDelimiters — language-agnostic, works for any delimiter pair.
    if (extractBlockDelimiters(pattern)) {
      return { scope: 'comment.block', isBlock: true };
    }
    const suffix = lineCommentScopeSuffix(pattern);
    return { scope: `comment.line${suffix}` };
  }

  if (pattern.startsWith('\\d') || pattern.startsWith('[0-9]')) {
    // A `[0-9]`/`\d`-leading token is a base-10 (decimal) numeric. The TextMate
    // `.decimal`/`.hex`/`.octal`/`.binary` axis names the BASE, not int-vs-float —
    // an optional fraction/exponent does not change the base — so a single
    // base-10 token (matching `1`, `1.5`, `1e3` alike) is `constant.numeric.decimal`.
    // (Named bases get their scope from explicit token annotations.)
    return { scope: 'constant.numeric.decimal' };
  }

  if (pattern.includes('"')) return { scope: 'string.quoted.double' };
  if (pattern.includes("'")) return { scope: 'string.quoted.single' };
  if (pattern.includes('`')) return { scope: 'string.quoted.other.template' };

  return { scope: 'variable.other' };
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
function buildOperandStartClass(grammar: CstGrammar, identRegex: string): string {
  const chars = new Set<string>();
  // Identifier-start: $/_ plus the non-\w extras from the Ident token.
  chars.add('_');
  for (const ch of identExtraChars(identRegex)) chars.add(ch);
  // String / template delimiters (first char of any string/template token).
  for (const tok of grammar.tokens) {
    if (tok.string || tok.template) {
      const first = tok.pattern[0] === '\\' ? tok.pattern[1] : tok.pattern[0];
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
  const tokenText = (re: string): string | null => {
    // Recover the literal string a simple punctuation token matches: strip
    // regex escapes from a pattern that is only escaped literals (e.g. `\/>` →
    // `/>`, `<\/` → `</`). Bail (null) on any metachar — a real JSX delimiter
    // token is a fixed 2-char punctuation string.
    let out = '';
    for (let i = 0; i < re.length; i++) {
      const c = re[i];
      if (c === '\\') { const n = re[i + 1]; if (n === undefined || /[a-zA-Z0-9]/.test(n)) return null; out += n; i++; continue; }
      if ('[](){}.*+?^$|'.includes(c)) return null;
      out += c;
    }
    return out;
  };
  let selfCloseTok: string | null = null;
  let closeTok: string | null = null;
  for (const tok of grammar.tokens) {
    if (tok.flags.includes('skip') || tok.flags.includes('regex')) continue;
    const text = tokenText(tok.pattern);
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
  balancedAngles: string;  // recursive balanced `<…>` named group `(?<B>…)`
  arrowParamShape: string; // the arrow-shaped `(` confirm after `>`
}
function jsxDisambigDelims(grammar: CstGrammar, identRegex: string, separator: string, paramParens: { open: string; close: string } | null): JsxDisambigDelims {
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
  for (const t of grammar.tokens) if (t.string) for (const q of stringDelimiters(t.pattern)) quotes.add(q);
  const oc = `${escapeForCharClass(open)}${escapeForCharClass(close)}`;
  // Opaque alternatives in the comma scan: the `{…}` container and each `"…"`/`'…'`
  // attr string are skipped so a comma inside them is not a top-level separator.
  const opaqueStr = [...quotes].map(q => { const e = escapeRegex(q); return `${e}[^${escapeForCharClass(q)}]*${e}`; }).join('|');
  const negClass = `[^${oc}{}${[...quotes].map(escapeForCharClass).join('')}]`;  // none of < > { } " '
  const topComma = `(?:${negClass}|\\{[^{}]*\\}${opaqueStr ? '|' + opaqueStr : ''})*${escapeRegex(separator)}`;
  // Recursive balanced `<…>` (Oniguruma named-group recursion).
  const balancedAngles = `(?<B>[^${oc}]*(?:${escapeRegex(open)}\\g<B>${escapeRegex(close)}[^${oc}]*)*)`;
  // Arrow-shaped param list after `>`: the `(`/`)` are the arrow rule's own param
  // delimiters (detectArrowParamDelims); the tail is the curated first-token shapes
  // (see doc comment for why the parens derive but the tail stays literal). The
  // `close` glyph appears twice — the empty list `( )` and the single-param `(x)`
  // confirm — so both read from the same derived delimiter.
  const [pOpen, pClose] = paramParens ? [paramParens.open, paramParens.close] : ['(', ')'];
  const arrowParamShape = `${escapeRegex(pOpen)}\\s*(?:${escapeRegex(pClose)}|\\.\\.\\.|${identRegex}\\s*[:,?${escapeForCharClass(pClose)}]|[{\\[]|$)`;
  return { topComma, balancedAngles, arrowParamShape };
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
function generateJsxPatterns(langName: string, identRegex: string, jsx: JsxInfo, disambig: JsxDisambigDelims | null): Record<string, TmPattern> {
  const result: Record<string, TmPattern> = {};

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
  // A `.tsx` generic-arrow type-param list (`<T = X,>(…) =>`, `<const T,>(…) =>`)
  // sits in expression position too, so its leading `<` also satisfies the
  // expression-start lookbehind below. Unlike a JSX tag-open, it always carries a
  // TOP-LEVEL comma inside `<…>` (treating `{…}` opaquely) AND its `>` is followed
  // by an arrow-shaped `(`. We must NOT take such a `<` as JSX. The disambiguation
  // can't be left to pattern order: the expression-start prefix consumes leading
  // whitespace, so after `= <…` the JSX begin's match starts at that space — one
  // offset LEFT of #arrow-type-parameters' `<` — and vscode-textmate always keeps
  // the leftmost match regardless of order. So the carve-out is encoded locally as
  // a negative lookahead (checked at the `<`, after the ws is consumed) that mirrors
  // #arrow-type-parameters' positive guard exactly: same top-level-comma test, same
  // balanced-angle + arrow-param-shape confirm. JSX-only by construction (this
  // helper is reached only for a JSX/TSX grammar). Result: after `=`, `const`-value,
  // `return`, etc., the type-param list wins; every genuine JSX tag (no top-level
  // comma, or no trailing arrow-paren) is untouched.
  // Only a TS-family JSX grammar (one whose `<…>` is also a generic delimiter, so
  // #arrow-type-parameters exists) needs the carve-out. A plain JS `.jsx` grammar
  // has no generics, so `disambig` is null there and the guard stays empty — its
  // output is unchanged. The building-blocks (top-level-comma scan, balanced-angle,
  // arrow-param-shape) are derived from the grammar by jsxDisambigDelims and SHARED
  // with #arrow-type-parameters' positive guard so the two can never drift.
  const notArrowTypeParams = disambig
    ? `(?!<(?=${disambig.topComma})(?=${disambig.balancedAngles}>\\s*${disambig.arrowParamShape}))`
    : '';

  // Expression-start lookbehind (JSX `<` is never preceded by a value operand).
  // Variable-length lookbehind is supported by Oniguruma. After `++`/`--` is
  // excluded (those produce a value). Mirrors the official jsx-tag-in-expression.
  // The carve-out above is appended so a generic-arrow type-param list (which also
  // begins with `<` in expression position) is left to #arrow-type-parameters.
  const exprStart =
    `(?<!\\+\\+|--)(?<=[({\\[,?=:>&|]|&&|\\|\\||=>|\\breturn|\\byield|\\bdefault|\\bcase|^)\\s*${notArrowTypeParams}`;

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
      { include: '#jsx-self-closing-element' },
      { include: '#jsx-element' },
      { include: '#jsx-fragment' },
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
  result['jsx-attributes'] = {
    patterns: [
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

  // ── jsx-element: `<Tag …> children </Tag>` ──
  // Two-phase: an inner open-tag begin/end scopes the attributes up to `>`, then
  // a children begin/end (contentName meta.jsx.children) runs to the `</…>`.
  result['jsx-element'] = {
    name: `meta.tag.${langName}`,
    begin: `(?=(<)\\s*${nameRe}(?:\\s|/?>|<))`,
    // The closing tag's name is optional (our model doesn't enforce name-match,
    // matching TS treating a mismatch as a semantic — not parse — error). Wrap
    // the whole name in `(?:…)?` so the optional `?` attaches to the group, not
    // to `nameRe`'s trailing `(?<!\.|-)` lookbehind (a quantified zero-width
    // assertion is an invalid Oniguruma regex).
    end: `(${escapeRegex(jsx.closeTok)})\\s*(?:${nameRe})?\\s*(>)`,
    endCaptures: {
      '1': { name: tagBegin },
      ...nameCaptures(2),   // name sub-captures 2..6 (ns, sep, member, intrinsic, component)
      '7': { name: tagEnd },
    },
    patterns: [
      // open tag: `<Tag …>` — type-args (if any) then attributes, ends at `>`.
      {
        begin: `(<)\\s*${nameRe}`,
        beginCaptures: { '1': { name: tagBegin }, ...nameCaptures(2) },
        end: '(>)',
        endCaptures: { '1': { name: tagEnd } },
        patterns: [...tagTypeArgsInclude, { include: '#jsx-attributes' }],
      },
      // children region.
      {
        begin: '(?<=>)',
        end: `(?=${escapeRegex(jsx.closeTok)})`,
        contentName: `meta.jsx.children.${langName}`,
        patterns: [{ include: '#jsx-children' }],
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
  result['jsx-self-closing-element-in-expression'] = {
    begin: `${exprStart}(?=(<)\\s*${nameRe}${optTagTypeArgs}[^>]*${escapeRegex(jsx.selfCloseTok)})`,
    end: `(?!(<)\\s*${nameRe}${optTagTypeArgs}[^>]*${escapeRegex(jsx.selfCloseTok)})`,
    patterns: [{ include: '#jsx-self-closing-element' }],
  };
  result['jsx-element-in-expression'] = {
    begin: `${exprStart}(?=(<)\\s*${nameRe}(?:\\s|/?>|<))`,
    end: `(?!(<)\\s*${nameRe}(?:\\s|/?>|<))`,
    patterns: [{ include: '#jsx-element' }],
  };
  result['jsx-fragment-in-expression'] = {
    begin: `${exprStart}(?=(<)\\s*(>))`,
    end: '(?!(<)\\s*(>))',
    patterns: [{ include: '#jsx-fragment' }],
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
        const m = token.pattern.match(/^[`'"]/);
        if (m) return m[0];
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
): Record<string, TmPattern> {
  // Build recursive type regex
  const typeRegex = buildRecursiveTypeRegex(grammar, ambiguity.innerRuleName, identRegex);
  const confirm = buildConfirmPattern(ambiguity.confirmTokens);

  // Lookbehind: generic '<' must follow identifier / ] / )
  // Derives extra ident chars (e.g. $) from the Ident token regex.
  const lookbehind = buildIdentLookbehind(identRegex);

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
  // preceded — across any whitespace — by an operand-ending char: an identifier
  // char, `)`, `]`, a numeric/quote tail. This keeps `a < b > c`, `f() < g`,
  // `x] < y` as comparisons (variable-length lookbehind; Oniguruma supports it).
  // Casts after a keyword that ends in a letter (`return <T>x`) stay a comparison
  // here — rare, and never a regression (they were unhighlighted before too).
  const notAfter = `(?<![\\w$)\\]]\\s*)`;
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

  // Extract flags pattern from token regex
  // Pattern like: /\/(?:[^\/\\]|\\.)+\/[gimsuy]*/
  // Flags part is after the last \/ — look for a character class at the end
  let flagsPattern = '[a-z]*'; // safe fallback: any lowercase letter as flag
  const flagsMatch = regexToken.pattern.match(/\[([a-z]+)\]\*?\s*$/);
  if (flagsMatch) {
    flagsPattern = flagsMatch[0];
  }

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
  // Infix/prefix operators from prec table
  for (const level of grammar.precs) {
    for (const op of level.operators) {
      if (op.value.length === 1 && !/[a-zA-Z]/.test(op.value) &&
          op.position !== 'postfix' && op.value !== '/' && !seenChars.has(op.value)) {
        precedingChars.push(op.value);
        seenChars.add(op.value);
      }
    }
  }
  // Single-char structural punctuation from grammar rules (open brackets, separators)
  for (const rule of grammar.rules) {
    for (const lit of collectLiterals(rule.body)) {
      if (lit.length === 1 && !/[a-zA-Z]/.test(lit) &&
          !closeBrackets.has(lit) && !seenChars.has(lit)) {
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
    const prefix = extractRegexLiteralPrefix(tok.pattern);
    if (prefix.length >= 2 && prefix[0] === '/') {
      const ch = prefix[1];
      if (!commentSecondChars.includes(ch)) commentSecondChars.push(ch);
      const delims = extractBlockDelimiters(tok.pattern);
      if (delims) {
        const [begin, end] = delims;
        const sig = `${begin}${end}`;
        if (!seenBlock.has(sig)) { seenBlock.add(sig); blockComments.push({ begin, end }); }
      }
    }
  }

  return { flagsPattern, preceedingKeywords, precedingChars, commentSecondChars, blockComments };
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

  const fullLookbehind = keywordLookbehinds
    ? `(?:${charLookbehind}|${keywordLookbehinds}|${startOfLine})`
    : `(?:${charLookbehind}|${startOfLine})`;

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
      // Zero-width guards (`not(...)` / `sameLine`) consume no token, so they can sit
      // between the keyword and the name (e.g. `'type' not(reserved) Ident`) without
      // changing the `keyword name` highlight pattern — skip past them.
      if (item.type === 'not' || item.type === 'sameLine') {
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
  const namePat = identTok ? unicodeWidenIdentPattern(identTok.pattern) : '[a-zA-Z][\\w:.-]*';

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
  // script→source.js, style→source.css); else the HTML convention (script→source.js,
  // style→source.css) or the token's own scope. A `{ default, lang }` embed selects by a
  // `lang="…"` start-tag attribute → one region per lang (matched first), then the default.
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
    // (2) multi-line `begin/while` — the `while` re-checks each line and DROPS the region
    //     (popping any open embedded region) at the `</tag>` line, so the embed can't
    //     swallow past the close tag even mid-construct (fixes the trailing-type bug). The
    //     `^` anchor is required; the close tag itself is then matched by the host #tag.
    repository[key] = {
      name: `meta.${tag}.${L}`,
      begin: `(${o})(${tag})\\b${attrs}(${c})`,
      beginCaptures: { '1': { name: sOpen }, '2': { name: sName }, '3': attrCap, '4': { name: sClose } },
      while: `^(?!\\s*${o}${slash}${tag}[\\s${ccClose}])`,
      contentName: embed,
      patterns: [{ include: embed }],
    };
    top.push({ include: `#${key}-inline` });   // single-line first, then multi-line
    top.push({ include: `#${key}` });
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
    const closeAhead = `${o}${slash}${tag}[\\s${ccClose}]`;            // `</tag` then ws / `>`
    const content = (embed: string): TmPattern[] => [                 // body after `>`, bounded at `</tag>`
      { begin: `(?<=${c})(?=[^\\n]*${closeAhead})`, end: `(?=${closeAhead})`, contentName: embed, patterns: [{ include: embed }] },
      { begin: `(?<=${c})`, while: `^(?!\\s*${closeAhead})`, contentName: embed, patterns: [{ include: embed }] },
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
  for (const tag of m.rawText?.tags ?? []) {
    const spec = m.rawText!.embed?.[tag]
      ?? (tag === 'script' ? 'source.js' : tag === 'style' ? 'source.css' : (tokScope(m.rawText!.token) ?? `source.${L}`));
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
  repository['attribute'] = {
    patterns: [
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
    // `= "expr"` → the value is an EXPRESSION, CAPTURE-EMBEDDED so the embedded grammar is
    // BOUNDED to the quoted span. A begin/end region would let `msg as string`'s `as`-cast run
    // its type context over the closing quote (which looks like a string-literal-type) and
    // swallow the rest of the tag — the #5012 bug (vuejs/language-tools#5012). A capture's text
    // range can't be crossed, so the cast stops at the quote. Everything is config DATA: the
    // `=`/quotes from the markup config, the value scope from inject, and — so the engine never
    // invents a scope — the quote scope from `d.valueString` (omit it → quotes left unscoped).
    const valueCap = (q: string): TmPattern => {
      const captures: Record<string, TmCapture> = {
        '1': { name: d.eqScope },
        '3': { name: inj.exprEmbed, patterns: [{ include: inj.exprInclude }] },
      };
      if (d.valueString) { captures['2'] = { name: d.valueString.begin }; captures['4'] = { name: d.valueString.end }; }
      return { match: `(${assign})\\s*(${escapeRegex(q)})([^${escapeForCharClass(q)}]*)(${escapeRegex(q)})`, captures };
    };
    const values: TmPattern[] = [
      ...quotes.map(valueCap),
      // Multi-line value fallback (rare): a begin/end region embeds across lines (the capture
      // bound is single-line). A value whose closing quote is on a later line keeps this path.
      {
        begin: `(${assign})\\s*([${quoteCc}])`,
        beginCaptures: d.valueString ? { '1': { name: d.eqScope }, '2': { name: d.valueString.begin } } : { '1': { name: d.eqScope } },
        end: `\\2`,
        ...(d.valueString ? { endCaptures: { '0': { name: d.valueString.end } } } : {}),
        contentName: inj.exprEmbed, patterns: [{ include: inj.exprInclude }],
      },
    ];
    const dir: TmPattern[] = [];
    for (const c of d.control) {         // v-for / v-if … — distinct scope, value embedded
      dir.push({
        begin: `${beforeAttr}(${c.match})(?=[${assignCc}\\s${ccSlash}${ccClose}]|$)`,
        beginCaptures: { '1': { name: c.scope } },
        end: endAttr, patterns: values,
      });
    }
    for (const s of d.shorthand) {       // `:`/`@`/`#` (+ arg), value embedded
      dir.push({
        begin: `${beforeAttr}(${escapeRegex(s.char)})(\\[[^\\]]*\\]|[\\w.-]*)`,
        beginCaptures: { '1': { name: s.scope }, '2': { name: d.nameScope } },
        end: endAttr, patterns: values,
      });
    }
    dir.push({                            // long-form `v-name`(`:arg`), value embedded
      begin: `${beforeAttr}(${escapeRegex(d.prefix)}[\\w-]+)(?:(:)(\\[[^\\]]*\\]|[\\w.-]*))?`,
      beginCaptures: { '1': { name: d.nameScope }, '2': { name: d.eqScope }, '3': { name: d.nameScope } },
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
    case 'not': case 'sameLine': return true;                 // zero-width assertions
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
  const identToken = grammar.tokens.find(t => t.identifier)
    ?? grammar.tokens.find(t => classifyToken(t.pattern, t.flags).scope === 'variable.other');
  // Widen the identifier pattern so non-ASCII names (`Ω`, Cyrillic `А`) are scoped,
  // matching the parser lexer's Unicode fallback. This widened form is used only in
  // TextMate (Oniguruma) output, never by the lexer.
  const identPattern = identToken ? unicodeWidenIdentPattern(identToken.pattern) : '[a-zA-Z_]\\w*';

  // Contextual operator keywords (e.g. `as`/`keyof`/`is`/`satisfies`/`infer`):
  // keyword.operator.expression words that double as identifiers, so they are a
  // keyword ONLY in operator position — followed by whitespace then an operand.
  const contextualOps = findContextualOperatorKeywords(grammar);
  const operandStart = buildOperandStartClass(grammar, identPattern);
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
        const first = tok.pattern[0] === '\\' ? tok.pattern[1] : tok.pattern[0];
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
  const modifierGuard = `(?=\\s+(?:\\.\\.\\.|[[:alpha:]_${identExtraChars(identPattern)}\\[*#{"'0-9]))`;

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
    ? jsxDisambigDelims(grammar, identPattern, angleBracket.separator, detectArrowParamDelims(grammar))
    : null;

  if (angleBracket) {
    const abPatterns = generateAngleBracketPatterns(angleBracket, grammar, langName, identPattern);
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
    const jsxPatterns = generateJsxPatterns(langName, identPattern, jsx, angleDisambig);
    for (const [key, pattern] of Object.entries(jsxPatterns)) repository[key] = pattern;
    // The disambiguated, expression-position triggers go at the very top (before
    // #generic-call / #comparison): a `<` at expression-start with a tag-shaped
    // lookahead is JSX, never a comparison/generic (those follow a value operand).
    topPatterns.push({ include: '#jsx-self-closing-element-in-expression' });
    topPatterns.push({ include: '#jsx-element-in-expression' });
    topPatterns.push({ include: '#jsx-fragment-in-expression' });
    for (const tok of grammar.tokens) {
      const t = tok.pattern.replace(/\\(?![a-zA-Z0-9])/g, '');
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
    topPatterns.push({ include: '#regex-literal' });
  }

  // ── 2. Token patterns ──
  // Comment repository keys, collected in declaration order, so type contexts
  // (a multiline generic arg list spans several lines) can re-include them —
  // the official grammar allows a comment anywhere a type may appear.
  const commentIncludeKeys: string[] = [];
  for (const tok of grammar.tokens) {
    // Skip @regex tokens — handled by regex literal disambiguation above
    if (tok.flags.includes('regex')) continue;
    // Skip JSX delimiter tokens (`/>`, `</`) — scoped as tag punctuation inside
    // the JSX patterns, not as a flat `variable.other` token match.
    if (jsxOwnedTokens.has(tok.name)) continue;

    const classified = classifyToken(tok.pattern, tok.flags);
    const scope = tok.scope ?? classified.scope;  // @scope override wins
    const isBlock = classified.isBlock;
    const key = tok.name.toLowerCase();
    if (scope.startsWith('comment.')) commentIncludeKeys.push(key);

    if (scope === 'string.quoted.other.template') {
      const tmplEscape = tok.escapePattern ?? '\\\\.';
      // Extract template delimiter from the token pattern (first/last char)
      const tmplDelimChar = tok.pattern[0] === '\\' ? tok.pattern.slice(0, 2) : escapeRegex(tok.pattern[0]);
      const tmplPatterns: (TmPattern | { include: string })[] = [
        { match: tmplEscape, name: `constant.character.escape.${langName}` },
      ];
      // Detect interpolation prefix from the pattern (e.g., $ in \$(?!\{) → ${...})
      const interpPrefix = extractInterpPrefix(tok.pattern);
      if (interpPrefix) {
        tmplPatterns.push({
          begin: `${escapeRegex(interpPrefix)}\\{`,
          beginCaptures: { '0': { name: `punctuation.definition.template-expression.begin.${langName}` } },
          end: '\\}',
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

    } else if (tok.escapePattern && scope.startsWith('string.')) {
      // String with escape sequences: generate begin/end for each delimiter
      const escapePat: TmPattern = { match: tok.escapePattern, name: `constant.character.escape.${langName}` };
      const delimiters: [string, string][] = [];
      if (tok.pattern.includes('"')) delimiters.push(['"', 'string.quoted.double']);
      if (tok.pattern.includes("'")) delimiters.push(["'", 'string.quoted.single']);
      if (delimiters.length === 0) delimiters.push(['"', scope]); // fallback

      if (delimiters.length === 1) {
        const [delim, delimScope] = delimiters[0];
        repository[key] = {
          name: `${delimScope}.${langName}`,
          begin: escapeRegex(delim),
          beginCaptures: { '0': { name: `punctuation.definition.string.begin.${langName}` } },
          end: `${escapeRegex(delim)}|$`,
          endCaptures: { '0': { name: `punctuation.definition.string.end.${langName}` } },
          patterns: [escapePat],
        };
        topPatterns.push({ include: `#${key}` });
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
            patterns: [escapePat],
          };
          topPatterns.push({ include: `#${subKey}` });
        }
      }

    } else if (isBlock) {
      // Block comments: extract begin/end delimiters from the pattern.
      // E.g., \/\*[\s\S]*?\*\/  → begin: \/\*   end: \*\/
      //        <!--[\s\S]*?-->   → begin: <!--   end: -->
      const blockDelims = extractBlockDelimiters(tok.pattern);
      const beginDelim = blockDelims ? blockDelims[0] : tok.pattern.slice(0, 2);
      const endDelim = blockDelims ? blockDelims[1] : tok.pattern.slice(-2);

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
        name: `${emittedScope}.${langName}`,
        // The bare-identifier rule must scope non-ASCII names too (`Ω`, Cyrillic `А`).
        match: tok === identToken ? identPattern : tok.pattern,
      };
      topPatterns.push({ include: `#${key}` });
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

  // Type-object-type: { key: Type; ... } inside type contexts
  // Detect if any @type rule has '{' ... '}' alternatives
  const hasObjectType = grammar.rules.some(r =>
    r.flags.includes('type') && collectLiterals(r.body).includes('{')
  );
  if (hasObjectType && hasTypeAnnotations) {
    // Detect if the grammar has a private-field-like token (for member ident pattern)
    const hasPrivateFieldsForType = grammar.tokens.some(t => t.pattern.startsWith('#') || t.pattern.startsWith('\\#'));
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

  // Shared type inner patterns — exposed as a repository entry so all consumers
  // reference it via `{ include: '#type-inner' }`.  No shared mutable array;
  // later injections rebuild the patterns array non-destructively.
  // Type operators are derived from @type rule literals.
  const typeInnerPats: (TmPattern | { include: string })[] = [
    ...(repository['generic-type'] ? [{ include: '#generic-type' }] : []),
    ...(repository['type-object-type'] ? [{ include: '#type-object-type' }] : []),
    ...(repository['type-paren'] ? [{ include: '#type-paren' }] : []),
    ...(repository['type-predicate'] ? [{ include: '#type-predicate' }] : []),
    { include: '#simple-type' },
  ];
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
  repository['type-inner'] = { patterns: typeInnerPats };

  // Wire up deferred type-paren pattern (basic wiring; patched after type injections)
  if (repository['type-paren']) {
    repository['type-paren'].patterns = [{ include: '#type-inner' }];
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
  let typeAliasWhile: string | undefined;
  if (typeLiterals.size > 0) {
    const typeContinueOps = [...typeLiterals]
      .filter(l => !isKeywordLiteral(l) && l !== '=>' && l !== ']' && l !== ')' && l !== '}' && l !== '>')
      .map(escapeForCharClass).join('');
    const typeKwAlt = [...typeContextKeywords].map(escapeRegex).join('|');
    const whileParts: string[] = [];
    if (typeContinueOps) whileParts.push(`[${typeContinueOps}]`);
    if (typeKwAlt) whileParts.push(`(?:${typeKwAlt})\\b`);
    whileParts.push('//');
    whileParts.push('/\\*');
    // Identifiers: must not be statement keywords, and must not be followed
    // by ( or . (which indicate expression statements like foo() or foo.bar).
    // Use \b after the identifier to prevent backtracking to a partial match.
    if (stmtStartKeywords.size > 0) {
      const stmtAlt = [...stmtStartKeywords].map(escapeRegex).join('|');
      whileParts.push(`(?!${stmtAlt}\\b)${identPattern}\\b(?!\\s*[.(])`);
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
    const blockBeginCap = { '0': { name: `punctuation.definition.block.${langName}` } };
    const blockEndCap = { '0': { name: `punctuation.definition.block.${langName}` } };

    // code-block: self-recursive {} for method/function bodies (no class-member patterns)
    repository['code-block'] = {
      begin: '\\{',
      beginCaptures: blockBeginCap,
      end: '\\}',
      endCaptures: blockEndCap,
      patterns: [
        { include: '#code-block' },
        { include: '$self' },
      ],
    };

    // declaration-body: {} for class/interface bodies (has method-signature, member-type-annotation)
    repository['declaration-body'] = {
      begin: '\\{',
      beginCaptures: blockBeginCap,
      end: '\\}',
      endCaptures: blockEndCap,
      patterns: [
        { include: '#declaration-body' },
        { include: '$self' },
      ],
    };

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
        const arrowPos = `(?:(?<=\\basync\\s)|(?<![\\w$)\\]}]\\s*))`;
        // JSX-dialect disambiguator: in a `.tsx`/`.jsx` grammar a bare `<Foo>(…`
        // is a JSX element, so a generic-arrow type-param list is only recognised
        // when it carries a TOP-LEVEL comma inside the `<…>` (`<T,>`, `<T = X,>`,
        // `<const T,>`, `<T, U>`) — a tag-open never has one. `{…}` attr-value
        // containers and `"…"`/`'…'` attr strings are opaque, so a comma inside
        // `a={[1,2]}` or `a="x,y"` doesn't count. In a plain (non-JSX) TS grammar
        // this would wrongly reject no-comma generics like `<T>()`/`<T extends X>()`,
        // so the guard is gated on `jsx` and empty otherwise — keeping the TS output
        // byte-identical. The skip-set body (`angleDisambig.topComma`) is derived
        // from the grammar and SHARED with the carve-out appended to the JSX
        // expression-start triggers (see generateJsxPatterns), so the positive guard
        // here and its inverse there stay mutually exclusive by construction.
        const topComma = jsx ? `(?=${angleDisambig.topComma})` : '';
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
        topPatterns.push({ include: '#arrow-type-parameters' });
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
            repository['enum-body'] = {
              begin: '\\{',
              beginCaptures: { '0': { name: `punctuation.definition.block.${langName}` } },
              end: '\\}',
              endCaptures: { '0': { name: `punctuation.definition.block.${langName}` } },
              patterns: [{ include: '#enum-member' }, { include: '$self' }],
            };
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
        // or an expression like `foo()`).
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

      repository[key] = {
        name: `meta.${dpk.keyword}.${langName}`,
        begin: `\\b(${escapeRegex(dpk.keyword)})`,
        beginCaptures: {
          '1': { name: `${dpk.keywordScope}.${langName}` },
        },
        // End after the body `}` (the inner #code-block consumes a `{ … }` body
        // first), OR at a `;`/`}` ahead for a body-LESS overload signature
        // (`constructor(a);`) — without this the context would run away to the
        // enclosing block's `}` and swallow the next member. Mirrors #method-signature.
        end: '(?<=\\})|(?=[;}])',
        patterns: innerPatterns,
      };
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
    const hasPrivateFields = grammar.tokens.some(t => t.pattern.startsWith('#') || t.pattern.startsWith('\\#'));
    const memberIdentPattern = hasPrivateFields ? `#?${identPattern}` : identPattern;
    repository['member-type-annotation'] = {
      name: `meta.type.annotation.member.${langName}`,
      begin: `(${memberIdentPattern})(\\??)(\\s*:)`,
      beginCaptures: {
        '1': { name: `variable.object.property.${langName}` },
        '2': { name: `keyword.operator.optional.${langName}` },
        '3': { name: `keyword.operator.type.annotation.${langName}` },
      },
      end: '(?=[;=},)])',
      patterns: [{ include: '#type-inner' }],
    };
    const bodyPatterns = repository['declaration-body'].patterns!;
    bodyPatterns.splice(bodyPatterns.length - 1, 0, { include: '#member-type-annotation' });
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
  const importExportKws = new Set<string>();
  for (const [lit, scopes] of scopeOverrides) {
    if (scopes.some(s => s.startsWith('keyword.control.import'))) importExportKws.add(lit);
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
        }
        for (const item of alt) {
          if (item.type === 'quantifier' || item.type === 'group') walk(item.body);
          else if (item.type === 'sep') walk(item.element);
        }
      }
    };
    for (const rule of grammar.rules) walk(rule.body);
  }
  if (starAllKws.size > 0) {
    // Keyword keeps the scope it carries elsewhere (read from the scope map), so
    // capture 1 is not hardcoded to a specific scope string.
    const kwScope = getScope(scopeOverrides, [...starAllKws][0]) ?? 'keyword.control.import';
    repository['import-export-all'] = {
      match: `\\b(${[...starAllKws].map(escapeRegex).join('|')})\\s+(\\*)`,
      captures: {
        '1': { name: `${kwScope}.${langName}` },
        '2': { name: `constant.language.import-export-all.${langName}` },
      },
    };
    topPatterns.push({ include: '#import-export-all' });
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
    repository[key] = {
      name: `meta.${kw}-expr.${langName}`,
      begin: `\\b(${escapeRegex(kw)})\\b`,
      beginCaptures: {
        '1': { name: `${kwScope}.${langName}` },
      },
      end: ctorEnd,
      patterns: [
        {
          match: identPattern,
          name: `entity.name.function.${langName}`,
        },
      ],
    };
    topPatterns.push({ include: `#${key}` });
  }

  // ── 4b2. Property access detection ──
  const propAccess = detectPropertyAccess(grammar, tokenNames);
  // Lookbehind for property access: derives extra ident chars from the Ident token
  const propLookbehind = buildIdentLookbehind(identPattern);
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

      repository[key] = {
        name: `meta.type.${kw}.${langName}`,
        begin: `\\b(${escapeRegex(kw)})\\b${guard}`,
        beginCaptures: {
          '1': { name: `${kwScope}.${langName}` },
        },
        end: typeKwEnd,
        patterns: [{ include: '#type-inner' }],
      };
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
      const varAnnotEndParts = ['(?=[=;,])'];
      if (stmtStartKeywords.size > 0) {
        const stmtAlt = [...stmtStartKeywords].map(escapeRegex).join('|');
        varAnnotEndParts.push(`^\\s*(?=${stmtAlt})\\b`);
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
      const globalKws = kws.filter(k => !alwaysBeforeString(k) && !ctxOpSet.has(k) && !ctxModSet.has(k) && !contextDeclaredKws.has(k));
      if (globalKws.length > 0) {
        repository[key] = {
          match: `\\b(${globalKws.map(escapeRegex).join('|')})\\b`,
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
      const typeRelatedIncludes = [
        // Comments first: a `//` / `/* */` may sit anywhere in type position
        // (notably inside a multiline generic argument list). Without these the
        // `/` would fall through unmatched and the comment body would be
        // mis-scoped as a type name.
        ...commentIncludeKeys.map(key => ({ include: `#${key}` })),
        ...supportConstScopes.map(scope => ({ include: `#scope-${scope.replace(/\./g, '-')}` })),
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
  // like `(raw: unknown) => T` get variable.parameter scoping.
  if (repository['type-paren'] && repository['param-type-annotation']) {
    repository['type-paren'].patterns = [
      { include: '#param-type-annotation' },
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
    if (scope.startsWith('string.')) return 1;
    if (scope.includes('entity.name.function.decorator')) return 1.5;
    if (key === 'type-annotation-var' || key === 'type-annotation-return') return 1.8;
    if (key === 'object-method-key') return 1.85;
    if (key.endsWith('-expression') && key !== 'ternary-expression' && !key.startsWith('scope-')) return 1.9;
    if (key === 'arrow-function-params') return 1.95;
    if (key === 'ternary-expression') return 1.97;
    if (key.endsWith('-declaration') || key.endsWith('-definition') || key.endsWith('-typekw') || key.endsWith('-binding') || key.endsWith('-destructure')) return 2;
    // import/export namespace `*` must beat both the import/export keyword group
    // (which would consume the keyword alone) and the arithmetic-operator match.
    if (key === 'import-export-all') return 2;
    if (scope.includes('constant.numeric')) return 3; // stable sort preserves DSL token order
    if (scope.includes('keyword.operator') && key.startsWith('scope-')) return 4;
    if (scope.includes('keyword.control')) return 5;
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

  return {
    $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
    name: grammarName,
    scopeName,
    patterns: orderedPatterns,
    repository,
  };
}
