import type { CstGrammar, RuleExpr, RuleDecl } from './types.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';

interface TmPattern {
  name?: string;
  contentName?: string;
  match?: string;
  begin?: string;
  end?: string;
  while?: string;
  captures?: Record<string, { name: string }>;
  beginCaptures?: Record<string, { name: string }>;
  endCaptures?: Record<string, { name: string }>;
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
    if (c === '\\') { i++; continue; } // skip escaped sequences
    if (c === '[') { inClass = true; continue; }
    if (c === ']') { inClass = false; continue; }
    if (inClass && !/[a-zA-Z0-9_\-^]/.test(c)) {
      extras.add(c);
    }
  }
  return [...extras].map(escapeForCharClass).join('');
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

function inferIdentScope(keyword: string, scopeOverrides: Map<string, string[]>): string | null {
  const scope = getScope(scopeOverrides, keyword);
  if (!scope) return null;
  if (scope.startsWith('storage.type.function')) return 'entity.name.function';
  if (scope.startsWith('storage.type.') && scope !== 'storage.type') return 'entity.name.type';
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
    if (pattern.includes('\\.') || pattern.includes('.')) return { scope: 'constant.numeric.float' };
    return { scope: 'constant.numeric.integer' };
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

// ── Angle bracket disambiguation ──

interface AngleBracketAmbiguity {
  innerRuleName: string;     // e.g., 'Type'
  confirmTokens: string[];   // e.g., ['(', '`']  — chars that confirm > is generic-close
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
    return { innerRuleName, confirmTokens };
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
  const compScope = `keyword.operator.comparison.${langName}`;
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
      '3': { name: compScope },
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

  // ── Layer 4: flat comparison fallback ──
  result['comparison'] = {
    match: '[<>]',
    name: compScope,
  };

  return result;
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
  const commentSecondChars: string[] = [];
  for (const tok of grammar.tokens) {
    if (!tok.flags.includes('skip')) continue;
    const prefix = extractRegexLiteralPrefix(tok.pattern);
    if (prefix.length >= 2 && prefix[0] === '/') {
      const ch = prefix[1];
      if (!commentSecondChars.includes(ch)) commentSecondChars.push(ch);
    }
  }

  return { flagsPattern, preceedingKeywords, precedingChars, commentSecondChars };
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

  result['regex-literal'] = {
    name: `string.regexp.${langName}`,
    begin: `${fullLookbehind}\\s*(/)${commentExclude}`,
    beginCaptures: {
      '1': { name: `punctuation.definition.string.begin.regexp.${langName}` },
    },
    end: `(/)(${info.flagsPattern})`,
    endCaptures: {
      '1': { name: `punctuation.definition.string.end.regexp.${langName}` },
      '2': { name: `keyword.other.regexp.${langName}` },
    },
    patterns: [
      // Character class
      { begin: '\\[', end: '\\]', name: `constant.other.character-class.regexp.${langName}` },
      // Escape sequences
      { match: '\\\\.', name: `constant.character.escape.regexp.${langName}` },
    ],
  };

  return result;
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

export function generateTmLanguage(grammar: CstGrammar, langName: string): TmGrammar {
  const scopeName = `source.${langName}`;
  const repository: Record<string, TmPattern> = {};
  const topPatterns: { include: string }[] = [];

  const tokenNames = new Set(grammar.tokens.map(t => t.name));
  const { scopeOverrides } = grammar;

  // ── Shared values ──
  const identToken = grammar.tokens.find(t => classifyToken(t.pattern, t.flags).scope === 'variable.other');
  const identPattern = identToken ? identToken.pattern : '[a-zA-Z_]\\w*';

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

  // ── 1. Detect angle bracket ambiguity ──
  const angleBracket = detectAngleBracketAmbiguity(grammar);
  const angleBracketExclude = new Set(angleBracket ? ['<', '>'] : []);

  if (angleBracket) {
    const abPatterns = generateAngleBracketPatterns(angleBracket, grammar, langName, identPattern);
    for (const [key, pattern] of Object.entries(abPatterns)) {
      repository[key] = pattern;
    }
    // Add disambiguation layers to top patterns (order matters!)
    topPatterns.push({ include: '#generic-call' });
    topPatterns.push({ include: '#generic-call-eol' });
    topPatterns.push({ include: '#generic-call-multiline' });
    // comparison is added later in the ordering pass
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
  for (const tok of grammar.tokens) {
    // Skip @regex tokens — handled by regex literal disambiguation above
    if (tok.flags.includes('regex')) continue;

    const classified = classifyToken(tok.pattern, tok.flags);
    const scope = tok.scope ?? classified.scope;  // @scope override wins
    const isBlock = classified.isBlock;
    const key = tok.name.toLowerCase();

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
      // @embed(lang) — embedded language inside the block
      // Use contentName to mark the embedded region.
      // Avoid `include: source.X` since vscode-textmate skips the entire
      // begin/end rule when an included grammar fails to resolve.
      if (tok.embed) {
        blockEntry.contentName = `meta.embedded.block.${tok.embed}`;
      }
      repository[key] = blockEntry;
      topPatterns.push({ include: `#${key}` });

    } else {
      repository[key] = {
        name: `${scope}.${langName}`,
        match: tok.pattern,
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
    typeAliasWhile = `^\\s*(?:${whileParts.join('|')})`;
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
        innerPatterns.push({ include: decl.hasParams ? '#code-block' : '#declaration-body' });
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
      } else {
        beginRegex = `\\b(${escapeRegex(decl.keyword)})\\s+(${identPattern})`;
        captures['1'] = { name: `${decl.keywordScope}.${langName}` };
        captures['2'] = { name: `${decl.nameScope}.${langName}` };
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
    }
  }

  // ── 3c. Direct-param keywords (keyword directly followed by '(' — e.g., constructor) ──
  const directParamKws = detectDirectParamKeywords(grammar, scopeOverrides)
    .filter(d => !declarationKeywords.has(d.keyword));

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
        end: '(?<=\\})',
        patterns: innerPatterns,
      };
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
      begin: `\\b(${identPattern})\\s*(?=[<(])`,
      beginCaptures: {
        '1': { name: `entity.name.function.${langName}` },
      },
      end: '(?<=\\})|(?=[;\\}])',
      patterns: msInner,
    };

    const bodyPatterns = repository['declaration-body'].patterns!;
    bodyPatterns.splice(bodyPatterns.length - 1, 0, { include: '#method-signature' });
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
      const key = `scope-${scope.replace(/\./g, '-')}`;
      const isOperatorExpr = scope.startsWith('keyword.operator.expression');
      // Words always placed immediately before the string token (`from`) → string lookahead.
      // Contextual operator keywords (`as`/`keyof`/…) → operand lookahead.
      // Everything else → unconditional flat match.
      const beforeStringKws = kws.filter(k => alwaysBeforeString(k));
      const ctxOpKws = isOperatorExpr ? kws.filter(k => contextualOps.has(k) && !alwaysBeforeString(k)) : [];
      const ctxOpSet = new Set(ctxOpKws);
      const globalKws = kws.filter(k => !alwaysBeforeString(k) && !ctxOpSet.has(k));
      if (globalKws.length > 0) {
        repository[key] = {
          match: `\\b(${globalKws.map(escapeRegex).join('|')})\\b`,
          name: `${scope}.${langName}`,
        };
        topPatterns.push({ include: `#${key}` });
        if (isOperatorExpr) operatorExprIncludeKeys.push(key);
      }
      for (const kw of beforeStringKws) {
        const ckey = `${key}-${kw.replace(/[^a-z0-9]/gi, '')}`;
        repository[ckey] = {
          match: `\\b${escapeRegex(kw)}\\b(?=\\s*["'])`,
          name: `${scope}.${langName}`,
        };
        topPatterns.push({ include: `#${ckey}` });
      }
      // One positional entry per contextual operator keyword: keyword only when
      // followed by whitespace + an operand (a type/value start); otherwise the
      // word falls through to identifier scoping (variable.other).
      for (const kw of ctxOpKws) {
        const ckey = `${key}-${kw.replace(/[^a-z0-9]/gi, '')}`;
        repository[ckey] = {
          match: `\\b(${escapeRegex(kw)})\\b${ctxOpGuard}`,
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

  // Overridden keyword operators: merge into ONE pattern with capture-groups per scope.
  // This ensures longest-match-first across ALL scope groups (e.g. '===' before '=').
  if (overriddenOps.length > 0) {
    const opGroups = new Map<string, string[]>();
    for (const op of overriddenOps) {
      const scope = getScope(scopeOverrides,op)!;
      if (!opGroups.has(scope)) opGroups.set(scope, []);
      opGroups.get(scope)!.push(op);
    }
    // Sort groups by max operator length (descending) so longer operators match first;
    // use min length as tiebreaker so groups with all-long operators come first
    const sortedGroups = [...opGroups.entries()].sort((a, b) => {
      const maxA = Math.max(...a[1].map(o => o.length));
      const maxB = Math.max(...b[1].map(o => o.length));
      if (maxB !== maxA) return maxB - maxA;
      const minA = Math.min(...a[1].map(o => o.length));
      const minB = Math.min(...b[1].map(o => o.length));
      return minB - minA;
    });
    // Build combined regex: (group1_ops)|(group2_ops)|... with captures per group
    const parts: string[] = [];
    const captures: Record<string, { name: string }> = {};
    let captureIdx = 1;
    for (const [scope, ops] of sortedGroups) {
      const sorted = [...ops].sort((a, b) => b.length - a.length);
      parts.push(`(${sorted.map(escapeRegex).join('|')})`);
      captures[String(captureIdx)] = { name: `${scope}.${langName}` };
      captureIdx++;
    }
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
    if (key === 'generic-call') return -3;
    if (key === 'generic-call-eol') return -2;
    if (key === 'generic-call-multiline') return -1;
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
    if (key.endsWith('-declaration') || key.endsWith('-definition') || key.endsWith('-typekw')) return 2;
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

  return {
    $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
    name: langName,
    scopeName,
    patterns: orderedPatterns,
    repository,
  };
}
