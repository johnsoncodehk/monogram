// gen-lezer.ts — derive a Lezer grammar (CodeMirror 6's parser generator) from
// one CstGrammar. Sibling to gen-tm.ts: where gen-tm emits a TextMate grammar by
// INFERRING highlight scopes from rule shapes, this emits a Lezer `.grammar` text
// plus a `styleTags({...})` block (from @lezer/highlight) and an external
// tokenizer (JS) for the context-sensitive lexing the token hints describe.
//
// Stays LANGUAGE-AGNOSTIC: everything is derived from the grammar data
// (tokens / precs / rules / scopeOverrides + the lexer hints), never from a
// hardcoded TS token list. Where Lezer's static model genuinely cannot express
// a construct (e.g. arbitrary JS regex in @tokens, or Pratt-style operator
// soup), the limitation is mapped to the nearest Lezer idiom and the gap is
// marked with an `// INCOMPLETE:` comment in the emitted text.

import type { CstGrammar, RuleExpr, RuleDecl, TokenDecl } from './types.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';

// `defineGrammar` returns `CstGrammar & { name }` at runtime (see api.ts / cli.ts);
// the static `CstGrammar` type omits it, so accept the optional carrier here.
type LezerGrammar = CstGrammar & { name?: string };

// ── Output shape ──

export interface LezerOutput {
  /** The `.grammar` source text for @lezer/generator's `buildParser`. */
  grammar: string;
  /** `import {styleTags, tags as t} from "@lezer/highlight"` + a styleTags({...}) call. */
  styleTags: string;
  /** JS source for the external tokenizer module (regex-vs-division + templates). */
  externalTokenizer: string;
  /** Diagnostics: things that could not be fully expressed in Lezer's static model. */
  incomplete: string[];
}

// ── Helpers (local; mirror gen-tm's structural intent) ──

/** A Lezer string-literal token: double-quoted, backslash-escaped. */
function lezerString(s: string): string {
  return '"' + s.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

/** Turn a grammar literal into a safe Lezer identifier fragment (for synthetic names). */
function safeIdent(s: string): string {
  if (isKeywordLiteral(s)) return s.replace(/[^a-zA-Z0-9_]/g, '_');
  // punctuation → spelled-out-ish; keep it deterministic & collision-resistant
  const names: Record<string, string> = {
    '(': 'ParenL', ')': 'ParenR', '[': 'BracketL', ']': 'BracketR',
    '{': 'BraceL', '}': 'BraceR', '<': 'AngleL', '>': 'AngleR',
    '.': 'Dot', ',': 'Comma', ';': 'Semi', ':': 'Colon', '?': 'Question',
    '=>': 'Arrow', '...': 'Spread', '?.': 'QuestionDot',
  };
  if (names[s]) return names[s];
  return 'Op_' + [...s].map(c => c.charCodeAt(0).toString(16)).join('');
}

// ── Token classification (same semantics as gen-tm.classifyToken) ──
// Reused so the Lezer node names + style tags agree with the TextMate scopes:
// the project invariant is "one grammar → parser + highlighter, never disagree".

interface TokenClass {
  scope: string;
  isBlock?: boolean;
}

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

function classifyToken(tok: TokenDecl): TokenClass {
  const { pattern, flags } = tok;
  if (flags.includes('skip')) {
    if (extractBlockDelimiters(pattern)) return { scope: 'comment.block', isBlock: true };
    return { scope: 'comment.line' };
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

/** The scope gen-tm would assign a token: explicit @scope wins, else classify.
 *  A `regex`-flagged token is the regex-literal token — gen-tm scopes it
 *  `string.regexp` (via its regex-literal disambiguation), so match that here. */
function tokenScope(tok: TokenDecl): string {
  if (tok.scope) return tok.scope;
  if (tok.flags.includes('regex')) return 'string.regexp';
  return classifyToken(tok).scope;
}

// ── TextMate scope → @lezer/highlight tag ──
// Lezer's standard tag vocabulary (@lezer/highlight `tags`). We map the SAME
// scope strings gen-tm produces onto the closest Lezer tag. Longest scope
// prefix wins, so `keyword.control.import` and `keyword.operator.arithmetic`
// can resolve more specifically than bare `keyword`.
//
// Values are JS expressions evaluated against the imported `t` (= tags), e.g.
// `t.keyword`, `t.function(t.variableName)`, `t.controlKeyword`.

const SCOPE_TAG_RULES: { prefix: string; tag: string }[] = [
  // comments
  { prefix: 'comment.block.documentation', tag: 't.docComment' },
  { prefix: 'comment.line', tag: 't.lineComment' },
  { prefix: 'comment.block', tag: 't.blockComment' },
  { prefix: 'comment', tag: 't.comment' },
  // strings / regex / templates
  { prefix: 'string.regexp', tag: 't.regexp' },
  { prefix: 'string.quoted.other.template', tag: 't.special(t.string)' },
  { prefix: 'string', tag: 't.string' },
  { prefix: 'constant.character.escape', tag: 't.escape' },
  // numbers / language constants
  { prefix: 'constant.numeric', tag: 't.number' },
  { prefix: 'constant.language.boolean', tag: 't.bool' },
  { prefix: 'constant.language.null', tag: 't.null' },
  { prefix: 'constant.language', tag: 't.atom' },
  { prefix: 'constant', tag: 't.constant(t.name)' },
  // entities (names introduced by declarations)
  { prefix: 'entity.name.function.decorator', tag: 't.meta' },
  { prefix: 'entity.name.function', tag: 't.function(t.definition(t.variableName))' },
  { prefix: 'entity.name.type', tag: 't.typeName' },
  { prefix: 'entity.name.tag', tag: 't.tagName' },
  { prefix: 'entity.name', tag: 't.definition(t.name)' },
  { prefix: 'entity.other.property', tag: 't.propertyName' },
  { prefix: 'entity.other', tag: 't.name' },
  // variables / properties / parameters
  { prefix: 'variable.parameter', tag: 't.definition(t.variableName)' },
  { prefix: 'variable.language', tag: 't.special(t.variableName)' },
  { prefix: 'variable.other.property', tag: 't.propertyName' },
  { prefix: 'variable.other', tag: 't.variableName' },
  { prefix: 'variable', tag: 't.variableName' },
  // storage (declaration / modifier keywords)
  { prefix: 'storage.type.function.arrow', tag: 't.function(t.punctuation)' },
  { prefix: 'storage.type.function', tag: 't.definitionKeyword' },
  { prefix: 'storage.type.class', tag: 't.definitionKeyword' },
  { prefix: 'storage.type.interface', tag: 't.definitionKeyword' },
  { prefix: 'storage.type.type', tag: 't.definitionKeyword' },
  { prefix: 'storage.type.enum', tag: 't.definitionKeyword' },
  { prefix: 'storage.type.namespace', tag: 't.definitionKeyword' },
  { prefix: 'storage.type', tag: 't.definitionKeyword' },
  { prefix: 'storage.modifier', tag: 't.modifier' },
  { prefix: 'storage', tag: 't.keyword' },
  // keywords
  { prefix: 'keyword.control.import', tag: 't.moduleKeyword' },
  { prefix: 'keyword.control', tag: 't.controlKeyword' },
  { prefix: 'keyword.operator.expression', tag: 't.operatorKeyword' },
  { prefix: 'keyword.operator.logical', tag: 't.logicOperator' },
  { prefix: 'keyword.operator.comparison', tag: 't.compareOperator' },
  { prefix: 'keyword.operator.arithmetic', tag: 't.arithmeticOperator' },
  { prefix: 'keyword.operator.bitwise', tag: 't.bitwiseOperator' },
  { prefix: 'keyword.operator.assignment', tag: 't.definitionOperator' },
  { prefix: 'keyword.operator', tag: 't.operator' },
  { prefix: 'keyword.other', tag: 't.keyword' },
  { prefix: 'keyword', tag: 't.keyword' },
  // support (built-in libs)
  { prefix: 'support.type', tag: 't.standard(t.typeName)' },
  { prefix: 'support.class', tag: 't.standard(t.className)' },
  { prefix: 'support.function', tag: 't.standard(t.function(t.variableName))' },
  { prefix: 'support.variable', tag: 't.standard(t.variableName)' },
  { prefix: 'support', tag: 't.standard(t.name)' },
  // punctuation
  { prefix: 'punctuation.terminator', tag: 't.punctuation' },
  { prefix: 'punctuation.separator', tag: 't.separator' },
  { prefix: 'punctuation.accessor', tag: 't.derefOperator' },
  { prefix: 'punctuation.bracket.round', tag: 't.paren' },
  { prefix: 'punctuation.bracket.square', tag: 't.squareBracket' },
  { prefix: 'punctuation.bracket.curly', tag: 't.brace' },
  { prefix: 'punctuation.bracket.angle', tag: 't.angleBracket' },
  { prefix: 'punctuation', tag: 't.punctuation' },
];

function scopeToTag(scope: string | undefined): string | null {
  if (!scope) return null;
  let best: { prefix: string; tag: string } | null = null;
  for (const rule of SCOPE_TAG_RULES) {
    if (scope === rule.prefix || scope.startsWith(rule.prefix + '.')) {
      if (!best || rule.prefix.length > best.prefix.length) best = rule;
    }
  }
  return best ? best.tag : null;
}

// ── Contextual name inference (mirrors gen-tm.inferIdentScope) ──
// keyword + Ident in a definition position → the Ident is a function/type name.

function inferIdentScope(keyword: string, scopeOverrides: Map<string, string[]>): string | null {
  const scope = scopeOverrides.get(keyword)?.[0];
  if (!scope) return null;
  if (scope.startsWith('storage.type.function')) return 'entity.name.function';
  if (scope.startsWith('storage.type.') && scope !== 'storage.type') return 'entity.name.type';
  return null;
}

// ── Rule-expr → Lezer expression ──
// Maps our RuleExpr onto Lezer's rule-body syntax:
//   literal   → "kw"  (keyword)  |  reference to a synthetic punctuation token
//   ref(tok)  → Token node name
//   ref(rule) → Rule node name
//   seq       → space-separated
//   alt       → ( a | b | c )
//   quantifier→ x* / x+ / x?
//   group     → ( … )
//   sep(e,d)  → ( e (d e)* )?
//   op/prefix/postfix (Pratt markers) → handled specially by the rule emitter
//
// `litToken` maps a literal string to the token NAME the @tokens block declares
// for it (keywords use their @specialize'd word; punctuation uses safeIdent).

function exprToLezer(
  expr: RuleExpr,
  ctx: {
    selfName: string;
    tokenNames: Set<string>;
    litToken: (lit: string) => string;
    prec: (markerKey: string) => string; // '' if none
  },
): string {
  switch (expr.type) {
    case 'literal':
      return ctx.litToken(expr.value);
    case 'ref':
      // Token refs and rule refs both surface as their (Capitalized) node name.
      return expr.name;
    case 'seq':
      return expr.items
        .map(i => exprToLezer(i, ctx))
        .filter(s => s.length > 0)
        .join(' ');
    case 'alt':
      // An alternative that reduces to empty (an epsilon / fully-optional branch)
      // must be the explicit `()` — a bare `|` is a Lezer syntax error.
      return '(' + expr.items.map(i => exprToLezer(i, ctx) || '()').join(' | ') + ')';
    case 'group':
      return '(' + exprToLezer(expr.body, ctx) + ')';
    case 'quantifier': {
      const inner = exprToLezer(expr.body, ctx);
      // Lezer postfix operators bind to a single term; wrap multi-token bodies.
      const needsGroup = /\s/.test(inner) && !(inner.startsWith('(') && inner.endsWith(')'));
      const term = needsGroup ? `(${inner})` : inner;
      return term + expr.kind;
    }
    case 'sep': {
      const e = exprToLezer(expr.element, ctx);
      const d = ctx.litToken(expr.delimiter);
      const term = /\s/.test(e) ? `(${e})` : e;
      // element (delim element)*  — trailing-delimiter tolerance is handled by the
      // external/real parser; Lezer keeps the canonical separated-list shape.
      return `(${term} (${d} ${term})*)?`;
    }
    // Pratt markers: replaced by precedence-annotated self-references.
    case 'op':
      return ''; // handled in emitPrattRule
    case 'prefix':
      return '';
    case 'postfix':
      return '';
    default:
      return '';
  }
}

// ── Precedence model ──
// Our precs are an ordered list of levels (index 0 = loosest). Lezer wants a
// `@precedence { name1, name2, ... }` block listing names from HIGHEST to LOWEST,
// with optional `@left`/`@right`/`@cut` per group, then `!name` markers on the
// ambiguous reductions. We synthesize one precedence name per level.

interface PrecModel {
  block: string;                       // the `@precedence { ... }` text
  nameOf: Map<string, string>;         // operator value → precedence name
  assocOf: Map<string, 'left' | 'right' | 'none'>;
  levelName: (idx: number) => string;  // level index → precedence name
}

function buildPrecModel(grammar: CstGrammar): PrecModel {
  const nameOf = new Map<string, string>();
  const assocOf = new Map<string, 'left' | 'right' | 'none'>();
  const levelName = (idx: number) => `l${idx}`;

  // Lezer lists precedences high→low; our level 0 is loosest (lowest), so reverse.
  const lines: string[] = [];
  for (let i = grammar.precs.length - 1; i >= 0; i--) {
    const level = grammar.precs[i];
    const tag = level.assoc === 'left' ? ' @left' : level.assoc === 'right' ? ' @right' : '';
    lines.push(`  ${levelName(i)}${tag}`);
    for (const op of level.operators) {
      nameOf.set(op.value, levelName(i));
      assocOf.set(op.value, level.assoc);
    }
  }
  const block = `@precedence {\n${lines.join(',\n')}\n}`;
  return { block, nameOf, assocOf, levelName };
}

// ── Pratt rule emission ──
// A Pratt rule (one containing op/prefix/postfix markers, e.g. Expr) is the only
// place where Lezer's static model and our combinator model truly diverge. We
// translate the operator alternatives into binary/unary rule alternatives with
// `!precName` markers; the @precedence block resolves associativity & binding.
//
// `[$, op, $]`        → Self !prec BinaryOp Self      (per operator level)
// `[prefix, $]`       → PrefixOp !prec Self
// `[$, postfix]`      → Self !prec PostfixOp
//
// Operators are grouped by precedence level so each level's `!ln` marker carries
// its associativity from the @precedence block.

function emitPrattRule(
  rule: RuleDecl,
  grammar: CstGrammar,
  prec: PrecModel,
  ctx: Parameters<typeof exprToLezer>[1],
  incomplete: string[],
): string {
  const self = rule.name;
  const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];

  const atomAlts: string[] = [];   // non-operator alternatives (NUDs)
  let hasInfix = false, hasPrefix = false, hasPostfix = false;

  for (const alt of alts) {
    const items = alt.type === 'seq' ? alt.items : [alt];
    const kinds = items.map(i => i.type);
    if (kinds.includes('op')) { hasInfix = true; continue; }
    if (kinds.includes('prefix')) { hasPrefix = true; continue; }
    if (kinds.includes('postfix')) { hasPostfix = true; continue; }
    // Plain alternative (atom, call, member-access, literal, …). Left-recursive
    // alternatives like `$ '(' … ')'` are fine in Lezer (GLR) with a !prec marker
    // at the application precedence (highest level).
    const body = exprToLezer(alt, ctx);
    if (body.length > 0) atomAlts.push(body);
  }

  // Group operators by precedence level (preserves assoc via the @precedence block).
  const infixByLevel = new Map<string, string[]>();
  const prefixByLevel = new Map<string, string[]>();
  const postfixByLevel = new Map<string, string[]>();
  for (let i = 0; i < grammar.precs.length; i++) {
    for (const op of grammar.precs[i].operators) {
      const name = prec.levelName(i);
      const tok = ctx.litToken(op.value);
      const bucket =
        op.position === 'prefix' ? prefixByLevel :
        op.position === 'postfix' ? postfixByLevel : infixByLevel;
      if (!bucket.has(name)) bucket.set(name, []);
      bucket.get(name)!.push(tok);
    }
  }

  const opAlts: string[] = [];
  if (hasInfix) {
    for (const [name, toks] of infixByLevel) {
      const opExpr = toks.length === 1 ? toks[0] : `(${toks.join(' | ')})`;
      // `Self !level Op Self` — the marker on the reduction picks left/right assoc.
      opAlts.push(`${self} !${name} ${opExpr} ${self}`);
    }
  }
  if (hasPrefix) {
    for (const [name, toks] of prefixByLevel) {
      const opExpr = toks.length === 1 ? toks[0] : `(${toks.join(' | ')})`;
      opAlts.push(`!${name} ${opExpr} ${self}`);
    }
  }
  if (hasPostfix) {
    for (const [name, toks] of postfixByLevel) {
      const opExpr = toks.length === 1 ? toks[0] : `(${toks.join(' | ')})`;
      opAlts.push(`${self} !${name} ${opExpr}`);
    }
  }

  if (hasInfix || hasPrefix || hasPostfix) {
    incomplete.push(
      `Rule ${self}: Pratt operators (op/prefix/postfix) mapped to precedence-marked ` +
      `binary/unary alternatives. Lezer is GLR + @precedence, not Pratt, so deeply ` +
      `overloaded operators (e.g. '<' as both comparison and type-args, '+' infix vs ` +
      `prefix) may need hand-tuning or the external tokenizer to fully disambiguate.`,
    );
  }

  const allAlts = [...atomAlts, ...opAlts];
  // Wrap each alternative; one per line for readability.
  const bodyText = allAlts.map(a => `    ${a}`).join(' |\n');
  return `${self} {\n${bodyText}\n}`;
}

// ── Plain (non-Pratt) rule emission ──

function emitPlainRule(rule: RuleDecl, ctx: Parameters<typeof exprToLezer>[1]): string {
  const body = exprToLezer(rule.body, ctx);
  return `${rule.name} {\n  ${body}\n}`;
}

// ── @tokens block: best-effort JS-regex → Lezer token expression ──
// Lezer's token syntax is NOT regex; it is a small grammar (string literals,
// char sets `$[...]`, `?`/`*`/`+`, `|`, `( )`, ranges in sets). We translate the
// SIMPLE shapes (identifiers, numbers, fixed delimiters) and, for the
// context-sensitive / complex tokens (regex literal, template, multi-branch
// string escapes), declare an `@external tokens` hook instead and mark INCOMPLETE.

interface TokenEmit {
  /** Lines for the `@tokens { ... }` block (may be empty when external). */
  tokenLines: string[];
  /** Names handed to the external tokenizer. */
  externalNames: string[];
  /** Keyword literals that become `@specialize` over the identifier token. */
  keywordTokenName: string | null;
}

/**
 * Convert a JS regex source to a Lezer token expression where feasible.
 * Returns null when the pattern uses features Lezer tokens can't express
 * directly (lookaround, backrefs, the `regex`/`template` context tokens), so the
 * caller can route it to the external tokenizer.
 */
function jsRegexToLezer(pattern: string): string | null {
  // Bail on constructs Lezer's token grammar cannot model.
  if (/\(\?[:=!<]/.test(pattern)) return null;   // groups w/ lookaround/non-capturing semantics
  if (/\\[bBkg]/.test(pattern)) return null;      // word boundaries / backrefs
  if (/\\p\{/.test(pattern)) return null;         // unicode property escapes (Lezer uses @asciiLetter etc.)
  if (/[*+?]\?/.test(pattern)) return null;       // lazy quantifiers — Lezer tokens are greedy/longest-match
  if (/\{\d/.test(pattern)) return null;          // counted repetition {n}/{n,m} — Lezer has no equivalent
  // Shorthand classes inside a [...] set (e.g. [\s\S], [\d_]) have no Lezer
  // char-set equivalent; route those tokens to the external tokenizer instead.
  if (/\[[^\]]*\\[sSdDwW][^\]]*\]/.test(pattern)) return null;

  let out = '';
  let i = 0;
  const n = pattern.length;

  function classToLezer(): string | null {
    // consume a [...] class starting at pattern[i] === '['
    let j = i + 1;
    let negated = false;
    if (pattern[j] === '^') { negated = true; j++; }
    let inner = '';
    while (j < n && pattern[j] !== ']') {
      if (pattern[j] === '\\') {
        const c = pattern[j + 1];
        // Lezer char sets accept the same escapes inside $[ ... ]
        if (c === 'n') inner += '\\n';
        else if (c === 't') inner += '\\t';
        else if (c === 'r') inner += '\\r';
        else inner += '\\' + c;
        j += 2;
        continue;
      }
      inner += pattern[j];
      j++;
    }
    if (j >= n) return null; // unterminated
    i = j + 1;
    return (negated ? '![' : '$[') + inner + ']';
  }

  while (i < n) {
    const c = pattern[i];
    if (c === '[') {
      const cls = classToLezer();
      if (cls === null) return null;
      out += cls;
      continue;
    }
    if (c === '\\') {
      const next = pattern[i + 1];
      if (next === 'd') { out += '$[0-9]'; i += 2; continue; }
      if (next === 'w') { out += '$[a-zA-Z0-9_]'; i += 2; continue; }
      if (next === 's') { out += '$[ \\t\\n\\r]'; i += 2; continue; }
      if (next === 'D' || next === 'W' || next === 'S') return null; // negated shorthand: punt
      // escaped literal char → string literal
      out += lezerString(next);
      i += 2;
      continue;
    }
    if (c === '(') {
      // capture/non-capture group → Lezer grouping (drop capture semantics)
      out += '(';
      i++;
      continue;
    }
    if (c === ')') { out += ')'; i++; continue; }
    if (c === '|') { out += ' | '; i++; continue; }
    if (c === '*' || c === '+' || c === '?') { out += c; i++; continue; }
    if (c === '.') { out += '![\\n]'; i++; continue; } // any char except newline (approx)
    if (c === '^' || c === '$') { i++; continue; }      // anchors: implicit in Lezer tokens
    // ordinary char → string literal (coalesce runs for readability)
    let lit = '';
    while (i < n && !'[](){}|*+?.^$\\'.includes(pattern[i])) { lit += pattern[i]; i++; }
    if (lit.length === 0) { // a brace etc. we didn't special-case
      out += lezerString(pattern[i]);
      i++;
    } else {
      out += lezerString(lit);
    }
  }
  return out.trim();
}

function emitTokens(grammar: CstGrammar, litToken: (lit: string) => string, incomplete: string[]): TokenEmit {
  const tokenLines: string[] = [];
  const externalNames: string[] = [];
  const identToken = grammar.tokens.find(t => t.identifier);
  const keywordTokenName = identToken?.name ?? null;

  for (const tok of grammar.tokens) {
    // Context-sensitive tokens → external tokenizer.
    if (tok.regexContext || tok.template || tok.flags.includes('regex')) {
      externalNames.push(tok.name);
      tokenLines.push(`  // INCOMPLETE: ${tok.name} is produced by the external tokenizer`);
      tokenLines.push(`  // (context-sensitive: ${tok.regexContext ? 'regex-vs-division' : tok.template ? 'template interpolation' : 'regex literal'}).`);
      continue;
    }
    // skip tokens (comments / whitespace) → declared but routed via @skip too.
    const lez = jsRegexToLezer(tok.pattern);
    if (lez === null) {
      externalNames.push(tok.name);
      const block = tok.flags.includes('skip') && extractBlockDelimiters(tok.pattern);
      if (block) {
        // Block comment/span: a multi-char close delimiter can't be a single
        // longest-match Lezer token, so it belongs in the external tokenizer.
        tokenLines.push(`  // INCOMPLETE: ${tok.name} block span ${JSON.stringify(block[0])}…${JSON.stringify(block[1])} → external tokenizer.`);
        incomplete.push(`Block-style token ${tok.name} (delimiters ${JSON.stringify(block[0])}…${JSON.stringify(block[1])}) routed to the external tokenizer; Lezer single tokens can't longest-match a multi-char close delimiter.`);
      } else {
        tokenLines.push(`  // INCOMPLETE: ${tok.name} regex /${tok.pattern}/ exceeds Lezer token syntax; external tokenizer.`);
      }
      continue;
    }
    tokenLines.push(`  ${tok.name} { ${lez} }`);
  }

  // Punctuation & operator literals get their own simple string tokens.
  const litNames = new Set<string>();
  const seen = new Set<string>();
  const addLit = (lit: string) => {
    if (isKeywordLiteral(lit)) return;     // keywords specialize the identifier token
    if (seen.has(lit)) return;
    seen.add(lit);
    const name = litToken(lit);
    litNames.add(`  ${name} { ${lezerString(lit)} }`);
  };
  for (const rule of grammar.rules) for (const lit of collectLiterals(rule.body)) addLit(lit);
  for (const level of grammar.precs) for (const op of level.operators) addLit(op.value);
  tokenLines.push(...[...litNames].sort());

  if (!keywordTokenName) {
    incomplete.push('No identifier token (@identifier) found — keywords cannot be @specialize\'d; emitted as bare string tokens.');
  }

  return { tokenLines, externalNames, keywordTokenName };
}

// ── External tokenizer (JS) ──
// Lezer's external tokenizer IS JavaScript (unlike a Lezer-native C-like scanner),
// so we implement the regex-vs-division + template interpolation logic fairly
// fully, driven by the grammar's token hints — the same data gen-lexer.ts uses.

function emitExternalTokenizer(grammar: LezerGrammar, externalNames: string[]): string {
  const identToken = grammar.tokens.find(t => t.identifier);
  const regexToken = grammar.tokens.find(t => t.regexContext || t.flags.includes('regex'));
  const templateToken = grammar.tokens.find(t => t.template);
  const ctx = regexToken?.regexContext;

  const divisionAfterTexts = ctx?.divisionAfterTexts ?? [];
  const regexAfterTexts = ctx?.regexAfterTexts ?? [];
  const regexSource = regexToken?.pattern ?? '';
  const tpl = templateToken?.template;

  // Tokens this module is expected to supply (everything that didn't fit Lezer's
  // static @tokens grammar). Only the context-sensitive ones (regex/template) are
  // implemented below; the rest are simple longest-match tokens whose JS regex is
  // listed for completion.
  const simpleExternal = externalNames.filter(
    n => !(grammar.tokens.find(t => t.name === n)?.regexContext)
      && !(grammar.tokens.find(t => t.name === n)?.flags.includes('regex'))
      && !(grammar.tokens.find(t => t.name === n)?.template),
  );
  const simpleDocs = simpleExternal
    .map(n => {
      const t = grammar.tokens.find(tk => tk.name === n)!;
      return `//   ${n}: /${t.pattern}/${t.flags.includes('skip') ? '  (skip)' : ''}`;
    })
    .join('\n');

  // Emit a self-contained module. Token term ids are injected by @lezer/generator
  // at build time from the grammar's `@external tokens` declaration (imported here
  // by name); we reference them through the generated `terms` parameter.
  return `// External tokenizer for ${grammar.name ?? 'grammar'} (generated by gen-lezer.ts).
//
// Lezer external tokenizers are plain JS, so we implement the context-sensitive
// lexing that the grammar's token HINTS describe — the same logic gen-lexer.ts
// uses — more fully than a Lezer-native C scanner could. Wire the exported
// tokenizers into the .grammar via:
//
//   @external tokens contextTokens from "./tokens.js" { Regex${templateToken ? ', Template, TemplateHead, TemplateMiddle, TemplateTail' : ''} }
//
// This module must also supply these tokens that exceeded Lezer's @tokens syntax
// (straightforward longest-match scanners — INCOMPLETE, regex listed for porting):
${simpleDocs || '//   (none)'}
//
// NOTE: \`@lezer/generator\` passes the matching term ids in; the names below must
// match the @external tokens { ... } list. Replace the term imports accordingly.

import { ExternalTokenizer } from "@lezer/lr";
// import { Regex${templateToken ? ', Template, TemplateHead, TemplateMiddle, TemplateTail' : ''} } from "./parser.terms.js";

// Characters/texts after which \`/\` is DIVISION (value-producing), not a regex.
const divisionAfterTexts = ${JSON.stringify(divisionAfterTexts)};
// Keywords that re-enter expression position, so \`/\` after them IS a regex.
const regexAfterTexts = ${JSON.stringify(regexAfterTexts)};

// The JS regex for a regex literal (from the grammar's @regex token).
// Built via RegExp(source) so the pattern's own \\/ escapes survive verbatim
// (embedding in a /.../ literal would double-escape them). 'y' = sticky.
const REGEX_LITERAL = new RegExp(${JSON.stringify(regexSource)}, "y");

${identToken ? `const IDENT_CHAR = /[\\p{L}\\p{Nl}\\p{Nd}\\p{Mn}\\p{Mc}\\p{Pc}_$]/u;` : ''}

/**
 * Regex-vs-division tokenizer. Lezer calls this where a \`Regex\` token is valid.
 * We decide using the PREVIOUS significant token's text/type, mirroring
 * gen-lexer.ts's \`divisionPrevTexts\`/\`expressionStartKeywords\` logic.
 *
 * INCOMPLETE: Lezer's \`InputStream\` does not expose the previous token's TYPE,
 * only characters. We approximate the "division after a value" rule by scanning
 * backwards over whitespace to the previous non-space char and checking the
 * divisionAfterTexts set. Token-TYPE-sensitive cases (Ident/Number/String/…)
 * are handled by Lezer's own tokens taking priority; this hook only fires the
 * regex when a \`/\` is genuinely in expression position.
 */
export const contextTokens = new ExternalTokenizer((input, stack) => {
  const next = input.next;
  if (next !== ${"/".charCodeAt(0)} /* '/' */) return;

  // Look back at the previous non-whitespace char already consumed.
  let back = -1;
  let prev = input.peek(back);
  while (prev === 32 || prev === 9 || prev === 10 || prev === 13) { back--; prev = input.peek(back); }

  if (prev >= 0) {
    const prevChar = String.fromCharCode(prev);
    // After a closing bracket / identifier char / digit → division, not regex.
    if (prevChar === ")" || prevChar === "]" || prevChar === "}") return;
    if (/[A-Za-z0-9_$]/.test(prevChar)) {
      // Could be an identifier OR an expression-start keyword (return, typeof, …).
      // Read the whole preceding word and consult regexAfterTexts.
      let w = "", b = back;
      let ch = input.peek(b);
      while (ch >= 0 && /[A-Za-z0-9_$]/.test(String.fromCharCode(ch))) { w = String.fromCharCode(ch) + w; b--; ch = input.peek(b); }
      if (!regexAfterTexts.includes(w)) return;   // a plain identifier → division
      // else: keyword like \`return\` → fall through and match a regex literal
    }
  }

  // Try to match a regex literal at the current position.
  REGEX_LITERAL.lastIndex = 0;
  let s = "";
  // Re-read from the input stream char-by-char to feed the sticky regex.
  // (InputStream is forward-only; accumulate then test.)
  let i = 0, c = input.peek(i);
  // Bound the scan to a single line to avoid runaway on malformed input.
  while (c >= 0 && c !== 10 && i < 5000) { s += String.fromCharCode(c); i++; c = input.peek(i); }
  const m = REGEX_LITERAL.exec(s);
  if (m && m.index === 0) {
    input.advance(m[0].length);
    input.acceptToken(/* Regex */ 1);
  }
});
${tpl ? emitTemplateTokenizer(tpl) : '// (No template token declared — template tokenizer omitted.)\n'}`;
}

function emitTemplateTokenizer(tpl: NonNullable<TokenDecl['template']>): string {
  return `
// ── Template-literal tokenizer ──
// Splits an interpolated template into Head / Middle / Tail around \`${tpl.interpOpen}…${tpl.interpClose}\`
// holes, matching gen-lexer.ts's scanTemplateSpan. Delimiters come from the
// grammar's template token hint (language-agnostic).
const TPL_OPEN = ${JSON.stringify(tpl.open)};
const TPL_INTERP_OPEN = ${JSON.stringify(tpl.interpOpen)};
const TPL_INTERP_CLOSE = ${JSON.stringify(tpl.interpClose)};

/**
 * INCOMPLETE: a production template tokenizer must track interpolation-brace
 * nesting depth across tokenizer invocations (Lezer re-enters per token). The
 * scaffold below tokenizes a non-interpolated template fully and emits a
 * Head token up to the first interpolation; the Middle/Tail transitions need a
 * small stack threaded through the parser's context (\`stack\`). Mark and finish
 * when wiring into a concrete @lezer/lr build.
 */
export const templateTokens = new ExternalTokenizer((input, stack) => {
  let i = 0;
  // expect the opening delimiter
  for (let k = 0; k < TPL_OPEN.length; k++) {
    if (input.peek(i) !== TPL_OPEN.charCodeAt(k)) return;
    i++;
  }
  // scan to closing delimiter or interpolation hole
  while (true) {
    const c = input.peek(i);
    if (c < 0) return;                          // unterminated
    if (c === 92 /* \\\\ */) { i += 2; continue; }
    if (startsWith(input, i, TPL_INTERP_OPEN)) {
      input.advance(i + TPL_INTERP_OPEN.length);
      input.acceptToken(/* TemplateHead */ 2);  // INCOMPLETE: distinguish Head vs Middle via stack
      return;
    }
    if (startsWith(input, i, TPL_OPEN)) {
      input.advance(i + TPL_OPEN.length);
      input.acceptToken(/* Template */ 3);
      return;
    }
    i++;
  }
});

function startsWith(input, at, s) {
  for (let k = 0; k < s.length; k++) {
    if (input.peek(at + k) !== s.charCodeAt(k)) return false;
  }
  return true;
}
`;
}

// ── styleTags emission ──
// styleTags maps node names (and "Keyword/...":-style selectors) to highlight
// tags. We derive the mapping the SAME way gen-tm derives scopes:
//   • each declared token → its classified/overridden scope → tag
//   • each keyword literal → its scopeOverride scope → tag, grouped by tag
//   • contextual keyword+Ident name positions are documented (Lezer expresses
//     these via distinct node names in the tree, not regex captures).

function emitStyleTags(grammar: CstGrammar, ctx: { litToken: (lit: string) => string }, incomplete: string[]): string {
  const entries: { selector: string; tag: string }[] = [];

  // 1. Token nodes → tags.
  for (const tok of grammar.tokens) {
    if (tok.flags.includes('skip')) {
      // comments still get a node if declared via @skip {{ }}; map by scope.
      const tag = scopeToTag(tokenScope(tok));
      if (tag) entries.push({ selector: tok.name, tag });
      continue;
    }
    if (tok.identifier) continue; // identifier handled via keyword specialization + variableName default
    const tag = scopeToTag(tokenScope(tok));
    if (tag) entries.push({ selector: tok.name, tag });
  }

  // The identifier token itself defaults to a variable name.
  const identToken = grammar.tokens.find(t => t.identifier);
  if (identToken) {
    entries.push({ selector: identToken.name, tag: 't.variableName' });
  }

  // 2. Keyword literals → tags, grouped so identical tags share one selector.
  //    Keywords specialize the identifier token, so their node name is the
  //    @specialize name == the keyword's token name (we emit `litToken(kw)`).
  const tagToKeywords = new Map<string, string[]>();
  const allLiterals = new Set<string>();
  for (const rule of grammar.rules) for (const l of collectLiterals(rule.body)) allLiterals.add(l);
  for (const level of grammar.precs) for (const op of level.operators) allLiterals.add(op.value);
  // Include extra identifiers that only appear in scopeOverrides (e.g. `this`, built-ins).
  for (const [lit] of grammar.scopeOverrides) allLiterals.add(lit);

  for (const lit of allLiterals) {
    if (!isKeywordLiteral(lit)) continue;
    if (lit.startsWith('.')) continue; // `.length`-style property overrides: not standalone words
    const scope = grammar.scopeOverrides.get(lit)?.[0] ?? 'keyword.other';
    const tag = scopeToTag(scope) ?? 't.keyword';
    const name = ctx.litToken(lit);
    if (!tagToKeywords.has(tag)) tagToKeywords.set(tag, []);
    tagToKeywords.get(tag)!.push(name);
  }
  for (const [tag, names] of tagToKeywords) {
    const uniq = [...new Set(names)].sort();
    entries.push({ selector: uniq.join('/'), tag });
  }

  // 3. Punctuation / operator literal tokens → tags by scope override.
  const punctTagGroups = new Map<string, string[]>();
  for (const lit of allLiterals) {
    if (isKeywordLiteral(lit) || lit.startsWith('.')) continue;
    const scope = grammar.scopeOverrides.get(lit)?.[0];
    const tag = scopeToTag(scope);
    if (!tag) continue;
    const name = ctx.litToken(lit);
    if (!punctTagGroups.has(tag)) punctTagGroups.set(tag, []);
    punctTagGroups.get(tag)!.push(name);
  }
  for (const [tag, names] of punctTagGroups) {
    const uniq = [...new Set(names)].sort();
    entries.push({ selector: uniq.join('/'), tag });
  }

  // 4. Contextual definition names (keyword + Ident → entity.name.*). In Lezer
  //    these are expressed by giving the name position its own node (e.g.
  //    `FunctionDeclaration { kw Ident:Name … }` styled `Name/...`). We surface
  //    the inferred mapping as a comment so the grammar author can add nodes.
  const ctxNames = new Map<string, string>(); // keyword → name scope
  for (const rule of grammar.rules) {
    collectContextualNames(rule.body, grammar, ctxNames);
  }
  const ctxComments: string[] = [];
  for (const [kw, scope] of ctxNames) {
    const tag = scopeToTag(scope);
    if (tag) ctxComments.push(`//   after "${kw}" → name node should be styled ${tag} (${scope})`);
  }
  if (ctxComments.length > 0) {
    incomplete.push(
      'Contextual name positions (keyword + Ident → entity.name.*) require dedicated ' +
      'Lezer node names to style; emitted as comments in the styleTags block.',
    );
  }

  // Build the styleTags({...}) text. Deduplicate identical selectors (last wins
  // would lose info, so we keep first occurrence per selector).
  const seenSel = new Set<string>();
  const lines: string[] = [];
  for (const { selector, tag } of entries) {
    if (!selector) continue;
    if (seenSel.has(selector)) continue;
    seenSel.add(selector);
    lines.push(`  ${quoteSelector(selector)}: ${tag},`);
  }

  const header = `import { styleTags, tags as t } from "@lezer/highlight";\n\n`;
  const ctxBlock = ctxComments.length > 0
    ? `// Contextual definition-name positions (give these their own node names):\n${ctxComments.join('\n')}\n\n`
    : '';
  return `${header}${ctxBlock}export const highlighting = styleTags({\n${lines.join('\n')}\n});\n`;
}

/** A styleTags selector needs quoting when it contains non-identifier chars. */
function quoteSelector(sel: string): string {
  // Selectors that are pure identifiers or identifier/identifier groups are fine bare,
  // but JS object keys with `/` or punctuation must be string-quoted.
  if (/^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(sel)) return `"${sel}"`;
  return `"${sel.replace(/"/g, '\\"')}"`;
}

function collectContextualNames(expr: RuleExpr, grammar: CstGrammar, out: Map<string, string>): void {
  const tokenNames = new Set(grammar.tokens.map(t => t.name));
  function walkSeq(items: RuleExpr[]) {
    for (let i = 0; i < items.length - 1; i++) {
      const a = items[i], b = items[i + 1];
      if (a.type === 'literal' && isKeywordLiteral(a.value) && b.type === 'ref' && tokenNames.has(b.name)) {
        const scope = inferIdentScope(a.value, grammar.scopeOverrides);
        if (scope && !out.has(a.value)) out.set(a.value, scope);
      }
    }
  }
  function walk(node: RuleExpr) {
    if (node.type === 'seq') walkSeq(node.items);
    if (node.type === 'seq' || node.type === 'alt') node.items.forEach(walk);
    if (node.type === 'quantifier' || node.type === 'group') walk(node.body);
    if (node.type === 'sep') walk(node.element);
  }
  walk(expr);
}

// ── @skip + @tokens assembly ──

function findEntryRule(grammar: CstGrammar): string {
  // Mirror gen-parser: entry is the last declared rule.
  return grammar.rules[grammar.rules.length - 1].name;
}

// ── Top-level generator ──

export function generateLezer(grammar: LezerGrammar): LezerOutput {
  const incomplete: string[] = [];
  const tokenNames = new Set(grammar.tokens.map(t => t.name));

  // Literal → token name. Keywords specialize the identifier token, so their
  // "token" is a @specialize alias spelled with a safe identifier; punctuation
  // gets a synthetic punctuation-token name.
  const keywordSpecialName = (kw: string) => `kw_${kw.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const litToken = (lit: string): string =>
    isKeywordLiteral(lit) ? keywordSpecialName(lit) : safeIdent(lit);

  const prec = buildPrecModel(grammar);
  const exprCtx = {
    selfName: '',
    tokenNames,
    litToken,
    prec: (key: string) => prec.nameOf.get(key) ?? '',
  };

  // ── Rules ──
  const prattRuleNames = new Set<string>();
  for (const rule of grammar.rules) {
    if (hasMarker(rule.body)) prattRuleNames.add(rule.name);
  }

  const ruleTexts: string[] = [];
  const entry = findEntryRule(grammar);
  // Lezer needs exactly one `@top` rule. PROMOTE the grammar's entry rule to @top
  // (prefix its own definition) rather than emitting a separate wrapper — a wrapper
  // named `Program` would collide with an entry rule that is itself named `Program`.
  for (const rule of grammar.rules) {
    const localCtx = { ...exprCtx, selfName: rule.name };
    const text = prattRuleNames.has(rule.name)
      ? emitPrattRule(rule, grammar, prec, localCtx, incomplete)
      : emitPlainRule(rule, localCtx);
    ruleTexts.push(rule.name === entry ? `@top ${text}` : text);
  }

  // ── Keyword specialization ──
  // All keyword literals are matched as the identifier token then @specialize'd.
  const identToken = grammar.tokens.find(t => t.identifier);
  const keywordLits = new Set<string>();
  const allLiterals = new Set<string>();
  for (const rule of grammar.rules) for (const l of collectLiterals(rule.body)) allLiterals.add(l);
  for (const level of grammar.precs) for (const op of level.operators) allLiterals.add(op.value);
  for (const lit of allLiterals) if (isKeywordLiteral(lit) && !lit.startsWith('.')) keywordLits.add(lit);

  const specializeLines: string[] = [];
  if (identToken && keywordLits.size > 0) {
    // Lezer has no `@specialize<tok, name> { … }` block form — each keyword is its own
    // rule that specializes the identifier token (the inline `@specialize<tok, "word">`
    // expression, as in @lezer/javascript's `kw<term>` template).
    for (const kw of [...keywordLits].sort()) {
      specializeLines.push(`${keywordSpecialName(kw)} { @specialize<${identToken.name}, ${lezerString(kw)}> }`);
    }
  } else if (keywordLits.size > 0) {
    incomplete.push('Keywords present but no @identifier token to @specialize over.');
  }

  // ── @tokens block ──
  const tokenEmit = emitTokens(grammar, litToken, incomplete);

  // ── @skip ──
  const skipTokens = grammar.tokens.filter(t => t.flags.includes('skip'));
  const skipNames = skipTokens.map(t => t.name);
  // External tokens declaration for the context-sensitive tokens.
  const externalLine = tokenEmit.externalNames.length > 0
    ? `@external tokens contextTokens from "./tokens.js" {\n${tokenEmit.externalNames.map(n => `  ${n}`).join(',\n')}\n}`
    : '';

  // ── @detectDelim + dialect-free assembly ──
  const grammarText = assembleGrammar({
    grammarName: grammar.name ?? 'grammar',
    precBlock: prec.block,
    skipNames,
    ruleTexts,
    specializeLines,
    tokenLines: tokenEmit.tokenLines,
    externalLine,
    incomplete,
  });

  const styleTags = emitStyleTags(grammar, { litToken }, incomplete);
  const externalTokenizer = emitExternalTokenizer(grammar, tokenEmit.externalNames);

  return { grammar: grammarText, styleTags, externalTokenizer, incomplete };
}

interface AssembleArgs {
  grammarName: string;
  precBlock: string;
  skipNames: string[];
  ruleTexts: string[];
  specializeLines: string[];
  tokenLines: string[];
  externalLine: string;
  incomplete: string[];
}

function assembleGrammar(a: AssembleArgs): string {
  const parts: string[] = [];
  parts.push(`// Lezer grammar for ${a.grammarName}, generated by gen-lezer.ts.`);
  parts.push(`// Build with @lezer/generator's buildParser(); pair with the styleTags`);
  parts.push(`// block and the external tokenizer module emitted alongside.`);
  parts.push('');
  parts.push(a.precBlock);
  parts.push('');
  parts.push(...a.ruleTexts);
  parts.push('');
  if (a.specializeLines.length > 0) {
    // @specialize is used inline at the keyword reference sites; we also surface
    // the table for reference. (In a hand-finished grammar, the @specialize call
    // wraps the identifier token usage.)
    parts.push('// Keyword specialization over the identifier token:');
    parts.push(...a.specializeLines);
    parts.push('');
  }
  if (a.skipNames.length > 0) {
    parts.push(`@skip { ${a.skipNames.join(' | ')} }`);
    parts.push('');
  }
  parts.push('@tokens {');
  parts.push(...a.tokenLines);
  parts.push('}');
  if (a.externalLine) {
    parts.push('');
    parts.push(a.externalLine);
  }
  if (a.incomplete.length > 0) {
    parts.push('');
    parts.push('// ── INCOMPLETE / hand-tuning notes ──');
    for (const note of a.incomplete) parts.push(`// - ${note}`);
  }
  return parts.join('\n') + '\n';
}

// ── shared with gen-parser: does this rule use Pratt markers? ──
function hasMarker(expr: RuleExpr): boolean {
  if (expr.type === 'op' || expr.type === 'prefix' || expr.type === 'postfix') return true;
  if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(hasMarker);
  if (expr.type === 'quantifier' || expr.type === 'group') return hasMarker(expr.body);
  if (expr.type === 'sep') return hasMarker(expr.element);
  return false;
}
