// The highlighters' ROLE tables in one place: what a token or a TextMate scope is, in each
// highlighter's vocabulary. TextMate's scope inference (`classifyToken`, the comment / quote scope
// conventions), Monarch's token names (`scopeToMonarch`, `classifyTokenScope`) and tree-sitter's
// highlight captures (`scopeToCapture`, `tokenCapture`). Moved here unchanged from
// src/highlight-facts.ts, src/gen-monarch.ts and src/gen-treesitter.ts; where the three disagree
// (numbers: TextMate `constant.numeric.decimal`, Monarch float / integer; a regex token) the
// disagreement is theirs, kept as it was, and now visible side by side.
import type { CstGrammar, TokenDecl } from './types.ts';
import { tokenPatternBlockDelimiters, tokenPatternContainsLiteral, tokenPatternLiteralPrefix, tokenPatternStartsWithDecimal, tokenPatternStringDelimiters } from './token-pattern.ts';

// ── TextMate ──

/**
 * Derive a TextMate-conventional suffix for line comment scope based on the
 * literal prefix of the regex pattern.  E.g., `//` → `double-slash`,
 * `#` → `number-sign`.
 *
 * Uses a universal character-name mapping (not language-specific).
 */
export function lineCommentScopeSuffix(prefix: string | undefined): string {
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

/** The TextMate scope of a string quoted by `delim`: `"` double, `'` single; null for any other
 *  delimiter (each caller says what such a string takes). The one place this convention lives. */
export function quoteScope(delim: string): string | null {
  return delim === '"' ? 'string.quoted.double' : delim === "'" ? 'string.quoted.single' : null;
}

export function classifyToken(token: TokenDecl, opts?: { explicitScope?: boolean }): { scope: string; isBlock?: boolean } {
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
  for (const q of ['"', "'"]) if (delimiters.includes(q)) return { scope: quoteScope(q)! };
  if (delimiters.includes('`')) return { scope: 'string.quoted.other.template' };

  return { scope: 'variable.other' };
}

// ── Monarch ──

// ── TextMate-scope → Monarch-token mapping ──
//
// gen-tm already INFERS a TextMate scope for every construct. Monarch uses a
// flatter, theme-oriented vocabulary (keyword, type.identifier, number.hex,
// delimiter.*, …). We map the inferred TM scope to its closest Monarch token so
// BOTH highlighters agree on roles while each speaks its engine's idiom. Driven
// by scope PREFIXES — language-agnostic.
export function scopeToMonarch(scope: string): string {
  // A space-separated scope is `ancestor… leaf`; a single Monarch token wants the LEAF (the
  // semantic type), not the string ancestor that only supplies the TextMate chain.
  if (scope.includes(' ')) scope = scope.slice(scope.lastIndexOf(' ') + 1);
  if (scope.startsWith('comment')) return 'comment';
  if (scope.startsWith('string.regexp')) return 'regexp';
  if (scope.startsWith('string')) return 'string';
  if (scope.startsWith('constant.numeric')) {
    const kind = scope.slice('constant.numeric.'.length);
    const map: Record<string, string> = {
      hex: 'number.hex', octal: 'number.octal', binary: 'number.binary',
      float: 'number.float', integer: 'number', bigint: 'number',
    };
    return map[kind] ?? 'number';
  }
  if (scope.startsWith('constant.language')) return 'keyword';      // true/false/null
  if (scope.startsWith('variable.language')) return 'keyword';      // this/super
  if (scope.startsWith('constant')) return 'constant';
  if (scope.startsWith('storage.type.function.arrow')) return 'operator';
  if (scope.startsWith('storage')) return 'keyword';
  if (scope.startsWith('keyword.operator')) return 'operator';
  if (scope.startsWith('keyword')) return 'keyword';
  if (scope.startsWith('entity.other.document')) return 'delimiter';  // YAML --- / ... markers
  if (scope.startsWith('entity.name.function.decorator')) return 'annotation';
  if (scope.startsWith('entity.name.function')) return 'identifier';
  if (scope.startsWith('entity.name.type')) return 'type.identifier';
  if (scope.startsWith('entity')) return 'identifier';
  if (scope.startsWith('support.type')) return 'keyword';          // primitive types
  if (scope.startsWith('support.class')) return 'type.identifier'; // built-in classes
  if (scope.startsWith('support.variable')) return 'variable';
  if (scope.startsWith('support')) return 'identifier';
  if (scope.startsWith('punctuation.bracket')) {
    if (scope.includes('round')) return 'delimiter.parenthesis';
    if (scope.includes('curly')) return 'delimiter.bracket';
    if (scope.includes('square')) return 'delimiter.square';
    if (scope.includes('angle')) return 'delimiter.angle';
    return 'delimiter.bracket';
  }
  if (scope.startsWith('punctuation')) return 'delimiter';
  if (scope.startsWith('variable')) return 'variable';
  return 'identifier';
}

// ── Token classification (parallels gen-tm.classifyToken) ──
//
// Resolve the highlight role of a *declared token* from its pattern + flags +
// any `@scope` override. Same inference gen-tm performs → consistent roles.
export function classifyTokenScope(token: TokenDecl): string {
  if (token.scope) return token.scope;
  if (token.flags.includes('skip')) {
    if (tokenPatternBlockDelimiters(token)) return 'comment.block';
    return 'comment.line';
  }
  if (tokenPatternStartsWithDecimal(token)) {
    if (tokenPatternContainsLiteral(token, '.')) return 'constant.numeric.float';
    return 'constant.numeric.integer';
  }
  const delimiters = tokenPatternStringDelimiters(token);
  if (delimiters.includes('"')) return 'string.quoted.double';
  if (delimiters.includes("'")) return 'string.quoted.single';
  if (delimiters.includes('`')) return 'string.quoted.other.template';
  return 'variable.other';
}

// ── tree-sitter ──

/**
 * Map a TextMate scope (the same scopes the DSL `scopes` section uses, and the
 * same ones gen-tm.ts infers) to a tree-sitter highlight capture name.
 * Falls back conservatively. Language-agnostic: keyed on scope PREFIX families,
 * not on specific keywords.
 */
export function scopeToCapture(scope: string): string | null {
  // A space-separated scope is `ancestor… leaf` (e.g. `string.unquoted constant.numeric` for a
  // plain scalar that resolves to a number); a single tree-sitter capture wants the LEAF — the
  // semantic type — not the string ancestor that only supplies context for the TextMate chain.
  if (scope.includes(' ')) scope = scope.slice(scope.lastIndexOf(' ') + 1);
  // Ordered most-specific-first.
  const table: [string, string][] = [
    ['comment.block.documentation', '@comment.documentation'],
    ['comment', '@comment'],
    ['constant.numeric', '@number'],
    ['constant.language.boolean', '@constant.builtin'],
    ['constant.language', '@constant.builtin'],
    ['constant.character.escape', '@string.escape'],
    ['constant.other', '@constant'],
    ['string.regexp', '@string.regexp'],
    ['string', '@string'],
    ['entity.name.function.decorator', '@function.macro'],
    ['entity.name.function', '@function'],
    ['entity.name.type', '@type'],
    ['entity.name', '@constructor'],
    ['entity.other.attribute-name', '@attribute'],
    ['entity.other.document', '@punctuation.delimiter'],  // YAML --- / ... markers
    ['entity.other.property', '@property'],
    ['support.type.primitive', '@type.builtin'],
    ['support.type', '@type.builtin'],
    ['support.class', '@type'],
    ['support.variable.property', '@property.builtin'],
    ['support.variable', '@variable.builtin'],
    ['support.function', '@function.builtin'],
    ['variable.language', '@variable.builtin'],
    ['variable.parameter', '@variable.parameter'],
    ['variable.other.property', '@property'],
    ['variable.object.property', '@property'],
    ['variable.other', '@variable'],
    ['variable', '@variable'],
    ['storage.type.function.arrow', '@keyword.function'],
    ['storage.type.function', '@keyword.function'],
    ['storage.type', '@keyword'],
    ['storage.modifier', '@keyword'],
    ['keyword.control.import', '@keyword.import'],
    ['keyword.control.conditional', '@keyword.conditional'],
    ['keyword.control.loop', '@keyword.repeat'],
    ['keyword.control.flow', '@keyword.return'],
    ['keyword.control.trycatch', '@keyword.exception'],
    ['keyword.control', '@keyword'],
    ['keyword.operator.expression', '@keyword.operator'],
    ['keyword.operator', '@operator'],
    ['keyword.other', '@keyword'],
    ['keyword', '@keyword'],
    ['punctuation.terminator', '@punctuation.delimiter'],
    ['punctuation.separator', '@punctuation.delimiter'],
    ['punctuation.accessor', '@punctuation.delimiter'],
    ['punctuation.bracket', '@punctuation.bracket'],
    ['punctuation', '@punctuation.delimiter'],
  ];
  for (const [prefix, cap] of table) {
    if (scope === prefix || scope.startsWith(prefix + '.')) return cap;
  }
  return null;
}

/**
 * Infer the capture for a token (by its classification), independent of the
 * `scopes` section — for numbers/strings/comments that don't appear there.
 * Mirrors gen-tm.ts's classifyToken families but emits captures.
 */
export function tokenCapture(token: CstGrammar['tokens'][number]): string | null {
  if (token.scope) {
    const cap = scopeToCapture(token.scope);
    if (cap) return cap;
  }
  if (token.flags.includes('skip')) {
    return '@comment';
  }
  if (token.flags.includes('regex')) return '@string.regexp';
  if (tokenPatternStartsWithDecimal(token)) return '@number';
  const delimiters = tokenPatternStringDelimiters(token);
  if (token.string || delimiters.includes('"') || delimiters.includes("'") || delimiters.includes('`')) return '@string';
  return null;
}
