import type { CstGrammar, RuleExpr, RuleDecl } from './types.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';

// ════════════════════════════════════════════════════════════════════════════
// gen-treesitter — derive a tree-sitter parser package from one CstGrammar.
//
// Emits three artifacts, all from grammar DATA (never hardcoded TS tokens):
//   1. grammar.js              — the tree-sitter DSL grammar (rules + Pratt precs)
//   2. queries/highlights.scm  — capture names inferred from rule SHAPES, the
//                                same structural inference gen-tm.ts uses for
//                                TextMate scopes, re-targeted to @keyword/@type/…
//   3. src/scanner.c           — external-scanner scaffold for context-sensitive
//                                lexing (regex-vs-division, template holes),
//                                driven by the `regexContext`/`template` hints.
//
// The hard part (a fully working C scanner) is intentionally PARTIAL: the token
// enum, the serialize/deserialize, and the regex-vs-division decision are wired
// from grammar data; the template-hole state machine is stubbed with the derived
// delimiters and clearly-marked TODOs.
// ════════════════════════════════════════════════════════════════════════════

export interface TreeSitterOutput {
  /** grammar.js source */
  grammarJs: string;
  /** queries/highlights.scm source */
  highlightsScm: string;
  /** src/scanner.c source (external scanner scaffold) */
  scannerC: string;
  /** names of the external tokens the scanner provides (empty if none needed) */
  externalTokens: string[];
}

// ── Identifier / naming helpers ─────────────────────────────────────────────

// tree-sitter rule/field names must be snake_case identifiers. Our grammar names
// are PascalCase (`TypeMember`) — convert deterministically and reversibly enough
// to stay readable.
function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

function jsString(s: string): string {
  return JSON.stringify(s);
}

/** Escape a JS regex body for embedding inside a `/.../ ` literal in grammar.js. */
function jsRegexLiteral(pattern: string): string {
  // The pattern came from RegExp.source, so it is already a valid regex body.
  // Forward slashes must be escaped for a `/.../` literal — but ONLY the ones not
  // already escaped (`\/` must stay `\/`, not become `\\/` which would un-escape
  // the slash and terminate the literal early). Walk char-by-char, skipping the
  // char after every backslash.
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      out += c + (pattern[i + 1] ?? '');
      i++;
      continue;
    }
    out += c === '/' ? '\\/' : c;
  }
  return '/' + out + '/';
}

// ════════════════════════════════════════════════════════════════════════════
// 1. grammar.js
// ════════════════════════════════════════════════════════════════════════════

interface GrammarJsContext {
  grammar: CstGrammar;
  tokenNames: Set<string>;
  /** rule name → snake_case rule name */
  ruleSnake: Map<string, string>;
  /** token name → snake_case token name */
  tokenSnake: Map<string, string>;
  /** Pratt rules (contain op/prefix/postfix markers) keyed by ORIGINAL name */
  prattRules: Set<string>;
  /** external token names provided by the scanner (snake_case) */
  externalSnake: Set<string>;
  /** original token name → external scanner token name (snake) if scanner-provided */
  scannerTokenFor: Map<string, string>;
  /**
   * Ref nodes (the identifier right after a definition keyword) that should be
   * wrapped in `field('name', …)` so highlights.scm can target them with the
   * STANDARD `(rule name: (ident) @type)` form instead of a custom predicate.
   * Keyed by node identity (the exact RuleExpr object in the grammar AST).
   */
  nameFieldNodes: Set<RuleExpr>;
}

function hasMarker(expr: RuleExpr): boolean {
  if (expr.type === 'op' || expr.type === 'prefix' || expr.type === 'postfix') return true;
  if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(hasMarker);
  if (expr.type === 'quantifier' || expr.type === 'group') return hasMarker(expr.body);
  if (expr.type === 'sep') return hasMarker(expr.element);
  return false;
}

/**
 * Render a non-Pratt RuleExpr to a tree-sitter DSL expression string.
 * Pratt markers (op/prefix/postfix) are handled separately by buildPrattRule,
 * so a bare marker here renders to a harmless `blank()` (it never actually
 * appears outside a Pratt rule in practice).
 */
function renderExpr(expr: RuleExpr, ctx: GrammarJsContext): string {
  switch (expr.type) {
    case 'literal':
      return jsString(expr.value);
    case 'ref': {
      const ref = ctx.tokenNames.has(expr.name)
        ? `$.${ctx.tokenSnake.get(expr.name) ?? toSnake(expr.name)}`
        : `$.${ctx.ruleSnake.get(expr.name) ?? toSnake(expr.name)}`;
      // The identifier right after a definition keyword carries a `name` field so
      // highlights.scm can capture it with the standard `name:` query form.
      if (ctx.nameFieldNodes.has(expr)) return `field('name', ${ref})`;
      return ref;
    }
    case 'seq': {
      const parts = expr.items.map(i => renderExpr(i, ctx)).filter(p => p !== 'blank()');
      if (parts.length === 0) return 'blank()';
      if (parts.length === 1) return parts[0];
      return `seq(${parts.join(', ')})`;
    }
    case 'alt': {
      const parts = expr.items.map(i => renderExpr(i, ctx));
      return `choice(${parts.join(', ')})`;
    }
    case 'quantifier': {
      const body = renderExpr(expr.body, ctx);
      if (expr.kind === '?') return `optional(${body})`;
      if (expr.kind === '*') return `repeat(${body})`;
      return `repeat1(${body})`;
    }
    case 'group':
      return renderExpr(expr.body, ctx);
    case 'not':
      // Zero-width negative lookahead: not expressible in a tree-sitter CFG, and
      // it consumes nothing, so it drops to a no-op (the surrounding choice keeps
      // the bare form, as the grammar did before the assertion was added).
      return 'blank()';
    case 'sameLine':
      // Zero-width "no LineTerminator here" assertion — tree-sitter handles this
      // class of restriction with an external scanner, not the CFG; as a CFG node
      // it consumes nothing, so render a no-op.
      return 'blank()';
    case 'sep': {
      // sep(elem, ',') = optional(seq(elem, repeat(seq(',', elem)), optional(',')))
      // Trailing delimiter is allowed (matches the parser's matchSep behavior).
      const elem = renderExpr(expr.element, ctx);
      const delim = jsString(expr.delimiter);
      return `optional(seq(${elem}, repeat(seq(${delim}, ${elem})), optional(${delim})))`;
    }
    case 'op':
    case 'prefix':
    case 'postfix':
      return 'blank()';
  }
}

/**
 * Build a Pratt/precedence-driven expression rule.
 *
 * Our DSL writes operator alternatives compactly via markers: `[$, op, $]`,
 * `[prefix, $]`, `[$, postfix]`. The concrete operators + associativity live in
 * the `precs` table. tree-sitter has no Pratt engine, but it expresses the same
 * thing with numeric precedence on explicit `seq` rules:
 *
 *   level i (0-based) → precedence number = i + 1  (higher binds tighter)
 *   left  assoc       → prec.left(N, seq(expr, OP, expr))
 *   right assoc       → prec.right(N, seq(expr, OP, expr))
 *   none  assoc       → prec(N, seq(expr, OP, expr))
 *   prefix            → prec.right(N, seq(OP, expr))     (unary binds to its right)
 *   postfix           → prec.left(N, seq(expr, OP))
 *
 * The non-operator alternatives of the rule (atoms: literals, refs, brackets,
 * the member/call/`<>` continuations) are emitted as ordinary choices, each
 * given a baseline precedence so atoms don't fight with operators.
 */
function buildPrattRule(rule: RuleDecl, ctx: GrammarJsContext): string {
  const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
  const branches: string[] = [];

  // Precedence number for each grammar level: later levels (deeper in the array)
  // bind tighter, so index → number = index + 1.
  const levels = ctx.grammar.precs;
  const nLevels = levels.length;

  // Group operators of a position by their (num, assoc) so each precedence level
  // becomes one tree-sitter branch with the right prec wrapper.
  function emitOperatorBranches(position: 'infix' | 'prefix' | 'postfix') {
    const byLevel = new Map<string, { num: number; assoc: 'left' | 'right' | 'none'; ops: string[] }>();
    for (let i = 0; i < nLevels; i++) {
      const lvl = levels[i];
      const ops = lvl.operators.filter(o => o.position === position).map(o => o.value);
      if (ops.length === 0) continue;
      byLevel.set(String(i), { num: i + 1, assoc: lvl.assoc, ops });
    }
    const selfRef = `$.${ctx.ruleSnake.get(rule.name)}`;
    for (const { num, assoc, ops } of byLevel.values()) {
      const opChoice = ops.length === 1 ? jsString(ops[0]) : `choice(${ops.map(jsString).join(', ')})`;
      let inner: string;
      if (position === 'infix') inner = `seq(${selfRef}, field('operator', ${opChoice}), ${selfRef})`;
      else if (position === 'prefix') inner = `seq(field('operator', ${opChoice}), ${selfRef})`;
      else inner = `seq(${selfRef}, field('operator', ${opChoice}))`;

      const wrapper =
        position === 'prefix' ? 'prec.right' :
        position === 'postfix' ? 'prec.left' :
        assoc === 'left' ? 'prec.left' :
        assoc === 'right' ? 'prec.right' :
        'prec';
      branches.push(`${wrapper}(${num}, ${inner})`);
    }
  }

  let sawInfix = false, sawPrefix = false, sawPostfix = false;
  const atomBranches: string[] = [];

  for (const alt of alts) {
    const items = alt.type === 'seq' ? alt.items : [alt];
    const markerPos = items.findIndex(i => i.type === 'op' || i.type === 'prefix' || i.type === 'postfix');
    if (markerPos !== -1) {
      const m = items[markerPos];
      if (m.type === 'op') sawInfix = true;
      else if (m.type === 'prefix') sawPrefix = true;
      else if (m.type === 'postfix') sawPostfix = true;
      // Operator branches are emitted from the prec table below (one per level),
      // not from this skeletal `[$, op, $]` alternative.
      continue;
    }
    // Non-operator alternative: an atom or a left-recursive continuation
    // (member access `[$, '.', Ident]`, call `[$, '(', …, ')']`, generics, etc.).
    // Render as-is; give it a baseline precedence so it doesn't outrank operators.
    atomBranches.push(renderExpr(alt, ctx));
  }

  if (sawInfix) emitOperatorBranches('infix');
  if (sawPrefix) emitOperatorBranches('prefix');
  if (sawPostfix) emitOperatorBranches('postfix');

  // Atoms get a baseline prec of 0; the postfix/call/member continuations that
  // are left-recursive get a HIGH prec so they bind tighter than binary ops
  // (matches the Pratt parser's maxBp for non-operator LED patterns).
  const high = nLevels + 1;
  const selfSnake = ctx.ruleSnake.get(rule.name);
  for (const ab of atomBranches) {
    // Heuristic: a branch that starts with the self-reference is a left-recursive
    // continuation (call/member/index/generic) — bind tight.
    if (ab.startsWith(`seq($.${selfSnake}`) || ab === `$.${selfSnake}`) {
      branches.push(`prec.left(${high}, ${ab})`);
    } else {
      branches.push(ab);
    }
  }

  return `choice(\n      ${branches.join(',\n      ')}\n    )`;
}

/** Build a single rule's body string (Pratt or plain). */
function buildRuleBody(rule: RuleDecl, ctx: GrammarJsContext): string {
  if (ctx.prattRules.has(rule.name)) return buildPrattRule(rule, ctx);
  return renderExpr(rule.body, ctx);
}

// ── Token rules ──────────────────────────────────────────────────────────────

/**
 * Render a token declaration to a tree-sitter token rule body.
 * Scanner-provided tokens (regex literal, template pieces) are NOT emitted as
 * regex here — they appear in `externals` and reference the external symbol.
 */
function buildTokenBody(name: string, ctx: GrammarJsContext): string | null {
  const tok = ctx.grammar.tokens.find(t => t.name === name)!;
  if (ctx.scannerTokenFor.has(name)) return null; // provided by external scanner
  // Skip-flagged tokens (comments, whitespace) go in `extras`, not as a named
  // rule reference — but we still emit them so highlights can capture comments.
  return `token(${jsRegexLiteral(tok.pattern)})`;
}

// ── conflicts ────────────────────────────────────────────────────────────────

/**
 * Derive `conflicts` entries from known structural ambiguities in the grammar.
 *
 * tree-sitter resolves LR conflicts at generation time; genuine ambiguities the
 * grammar can't statically separate must be declared so the GLR runtime explores
 * both. We derive (not hardcode) the classic ones from grammar shape:
 *
 *  - `<>` generics vs `<`/`>` comparison: '<' and '>' are BOTH prec operators
 *    AND delimiters of a `'<' sep(Type,',') '>'` form (detected like gen-tm).
 *  - arrow params vs parenthesized expression: a rule has both `'(' … ')' '=>'`
 *    and a `'(' Expr … ')'` form.
 *  - ASI / optional `;`: rules whose statement form ends with `opt(';')`.
 */
function deriveConflicts(ctx: GrammarJsContext): string[][] {
  const conflicts: string[][] = [];
  const g = ctx.grammar;

  const precOps = new Set<string>();
  for (const lvl of g.precs) for (const o of lvl.operators) precOps.add(o.value);

  // 1. Generics vs comparison: the rule that contains BOTH `<`/`>` as a delimiter
  //    pair AND references the Pratt expression rule (so `<` is also comparison).
  if (precOps.has('<') && precOps.has('>')) {
    // The expression rule and the type rule frequently conflict on `<`.
    const exprRule = [...ctx.prattRules][0];
    const typeRule = g.rules.find(r => r.flags.includes('type'));
    if (exprRule && typeRule) {
      const a = ctx.ruleSnake.get(exprRule)!;
      const b = ctx.ruleSnake.get(typeRule.name)!;
      if (a !== b) conflicts.push([a, b]);
    }
  }

  // 2. Arrow-param list vs parenthesized expr — both begin `(` in the expr rule.
  //    tree-sitter can't decide `(x)` is params-of-arrow vs grouping until `=>`.
  const exprRule = [...ctx.prattRules][0];
  if (exprRule) {
    const body = g.rules.find(r => r.name === exprRule)!.body;
    const alts = body.type === 'alt' ? body.items : [body];
    const hasArrow = alts.some(a => seqHasArrowParen(a));
    const hasParenExpr = alts.some(a => seqHasParenExpr(a, exprRule));
    if (hasArrow && hasParenExpr) {
      // Self-conflict signals the GLR runtime to keep both interpretations.
      conflicts.push([ctx.ruleSnake.get(exprRule)!]);
    }
  }

  return conflicts;
}

function seqHasArrowParen(alt: RuleExpr): boolean {
  const items = alt.type === 'seq' ? alt.items : [alt];
  let sawClose = false;
  for (const it of items) {
    if (it.type === 'literal' && it.value === ')') sawClose = true;
    if (sawClose && it.type === 'literal' && it.value === '=>') return true;
  }
  return false;
}

function seqHasParenExpr(alt: RuleExpr, selfName: string): boolean {
  const items = alt.type === 'seq' ? alt.items : [alt];
  for (let i = 0; i < items.length - 1; i++) {
    if (items[i].type === 'literal' && (items[i] as { value: string }).value === '(') {
      const next = items[i + 1];
      if (next.type === 'ref' && next.name === selfName) return true;
      if (next.type === 'sep' && next.element.type === 'ref' && next.element.name === selfName) return true;
    }
  }
  return false;
}

// ── extras / word / externals ────────────────────────────────────────────────

/** Determine which tokens the external scanner must provide. */
function planScannerTokens(grammar: CstGrammar): Map<string, string> {
  const map = new Map<string, string>();
  // The regex token: '/' is context-sensitive (regex vs division). The scanner
  // resolves it.
  const regexTok = grammar.tokens.find(t => t.flags.includes('regex'));
  if (regexTok) map.set(regexTok.name, toSnake(regexTok.name) + '_literal');
  return map;
}

export function generateTreeSitter(grammar: CstGrammar, langName?: string): TreeSitterOutput {
  const name = (langName ?? (grammar as { name?: string }).name ?? 'language');
  const grammarName = toSnake(name);

  const tokenNames = new Set(grammar.tokens.map(t => t.name));
  const ruleSnake = new Map<string, string>();
  const tokenSnake = new Map<string, string>();
  for (const r of grammar.rules) ruleSnake.set(r.name, toSnake(r.name));
  for (const t of grammar.tokens) tokenSnake.set(t.name, toSnake(t.name));

  const prattRules = new Set<string>();
  for (const r of grammar.rules) if (hasMarker(r.body)) prattRules.add(r.name);

  const scannerTokenFor = planScannerTokens(grammar);
  const externalSnake = new Set([...scannerTokenFor.values()]);

  // Find the identifier nodes that follow a declaration keyword, so we can wrap
  // them in `field('name', …)` in grammar.js AND emit standard `name:` highlight
  // queries for them. Same shape rule gen-tm.ts uses (inferIdentScope).
  const nameFields = collectNameFields(grammar);

  const ctx: GrammarJsContext = {
    grammar, tokenNames, ruleSnake, tokenSnake, prattRules, externalSnake, scannerTokenFor,
    nameFieldNodes: nameFields.nodes,
  };

  const grammarJs = buildGrammarJs(ctx, grammarName);
  const highlightsScm = buildHighlightsScm(grammar, ctx, nameFields.byRule);
  const { scannerC, externalTokens } = buildScannerC(grammar, ctx, grammarName);

  return { grammarJs, highlightsScm, scannerC, externalTokens };
}

function buildGrammarJs(ctx: GrammarJsContext, grammarName: string): string {
  const { grammar } = ctx;
  const lines: string[] = [];

  lines.push('/**');
  lines.push(' * @file Tree-sitter grammar generated by monogram from a single CstGrammar.');
  lines.push(' * @license MIT');
  lines.push(' *');
  lines.push(' * GENERATED — do not edit by hand. Regenerate from the source grammar.');
  lines.push(' */');
  lines.push('');
  lines.push('/// <reference types="tree-sitter-cli/dsl" />');
  lines.push('// @ts-check');
  lines.push('');
  lines.push(`module.exports = grammar({`);
  lines.push(`  name: ${jsString(grammarName)},`);
  lines.push('');

  // ── extras (skipped tokens: whitespace + comments) ──
  const skipTokens = grammar.tokens.filter(t => t.flags.includes('skip'));
  const extras: string[] = ['/\\s/'];
  for (const t of skipTokens) {
    extras.push(`$.${ctx.tokenSnake.get(t.name)}`);
  }
  lines.push('  extras: $ => [');
  lines.push('    ' + extras.join(',\n    '));
  lines.push('  ],');
  lines.push('');

  // ── word (the identifier token drives keyword extraction) ──
  const identTok = grammar.tokens.find(t => t.identifier);
  if (identTok) {
    lines.push(`  word: $ => $.${ctx.tokenSnake.get(identTok.name)},`);
    lines.push('');
  }

  // ── externals (scanner-provided tokens) ──
  if (ctx.scannerTokenFor.size > 0) {
    const exts = [...ctx.scannerTokenFor.values()].map(s => `$.${s}`);
    lines.push('  externals: $ => [');
    lines.push('    ' + exts.join(',\n    '));
    lines.push('  ],');
    lines.push('');
  }

  // ── conflicts ──
  const conflicts = deriveConflicts(ctx);
  if (conflicts.length > 0) {
    lines.push('  conflicts: $ => [');
    for (const c of conflicts) {
      lines.push('    [' + c.map(n => `$.${n}`).join(', ') + '],');
    }
    lines.push('  ],');
    lines.push('');
  }

  // ── supertypes are skipped (would need a hand-curated list) ──

  lines.push('  rules: {');

  // The FIRST rule in tree-sitter is the start symbol. Our entry rule is the last
  // declared one (findEntryRule). Put it first so tree-sitter uses it as start.
  const entryName = grammar.rules[grammar.rules.length - 1].name;
  const orderedRules = [
    grammar.rules[grammar.rules.length - 1],
    ...grammar.rules.slice(0, grammar.rules.length - 1),
  ];

  const ruleEntries: string[] = [];

  // Grammar (entry) and other rules.
  for (const rule of orderedRules) {
    const snake = ctx.ruleSnake.get(rule.name)!;
    const body = buildRuleBody(rule, ctx);
    ruleEntries.push(`    ${snake}: $ => ${body}`);
  }

  // Token rules (named) — those not provided by the scanner. Skip tokens are
  // included so `extras` references resolve.
  for (const tok of grammar.tokens) {
    const tokenBody = buildTokenBody(tok.name, ctx);
    if (tokenBody === null) continue;
    const snake = ctx.tokenSnake.get(tok.name)!;
    ruleEntries.push(`    ${snake}: $ => ${tokenBody}`);
  }

  lines.push(ruleEntries.join(',\n\n'));
  lines.push('  }');
  lines.push('});');
  lines.push('');

  // A trailing comment naming the entry rule, for humans.
  lines.push(`// entry rule: ${ctx.ruleSnake.get(entryName)}`);
  lines.push('');

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// 2. queries/highlights.scm
//
// Reuse the SAME rule-shape inference family gen-tm.ts uses, but instead of
// emitting TextMate scopes we emit tree-sitter capture names. The mapping from a
// TextMate scope family → capture name is a small, language-agnostic table
// (tree-sitter's standard capture vocabulary).
// ════════════════════════════════════════════════════════════════════════════

/**
 * Map a TextMate scope (the same scopes the DSL `scopes` section uses, and the
 * same ones gen-tm.ts infers) to a tree-sitter highlight capture name.
 * Falls back conservatively. Language-agnostic: keyed on scope PREFIX families,
 * not on specific keywords.
 */
function scopeToCapture(scope: string): string | null {
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
function tokenCapture(pattern: string, flags: string[], explicitScope?: string): string | null {
  if (explicitScope) {
    const cap = scopeToCapture(explicitScope);
    if (cap) return cap;
  }
  if (flags.includes('skip')) {
    return '@comment';
  }
  if (flags.includes('regex')) return '@string.regexp';
  if (pattern.startsWith('\\d') || pattern.startsWith('[0-9]')) return '@number';
  if (pattern.includes('"') || pattern.includes("'")) return '@string';
  if (pattern.includes('`')) return '@string';
  return null;
}

interface ScmRule {
  /** s-expression query text (without the trailing capture) */
  query: string;
  /** capture name, e.g. '@keyword' */
  capture: string;
  /** optional comment line above */
  comment?: string;
}

/**
 * Build highlights.scm. Strategy, mirroring gen-tm.ts but for tree-sitter:
 *
 *  A. Literal-keyword captures: every keyword literal in the grammar grouped by
 *     its `scopes` entry → `[ "kw" … ] @capture`. (gen-tm's section 5.)
 *  B. Operator/punctuation literal captures, derived from scopes + prec table.
 *  C. Token-node captures: numbers/strings/comments/regex/templates/decorators
 *     by token classification → `(token_name) @capture`. (gen-tm's section 2.)
 *  D. Contextual node captures using FIELDS we emitted in grammar.js: the
 *     identifier after a definition keyword carries a `name` field, queried as
 *     `(rule name: (ident) @type)` — derived via the same inferIdentScope rule.
 *
 * tree-sitter matches LATER patterns as higher priority within highlights.scm,
 * so specific patterns (literal keyword lists) are emitted AFTER the broad
 * identifier fallback.
 */
function buildHighlightsScm(
  grammar: CstGrammar,
  ctx: GrammarJsContext,
  nameFieldsByRule: { rule: string; capture: string }[],
): string {
  const { scopeOverrides } = grammar;
  const out: string[] = [];

  out.push(';; -----------------------------------------------------------------');
  out.push(';; Tree-sitter highlight queries generated by monogram.');
  out.push(';; Capture names follow the standard tree-sitter highlight vocabulary');
  out.push(';; (@keyword, @function, @type, @string, @property, @operator, …).');
  out.push(';; Inferred from rule SHAPES + the grammar\'s `scopes` section — the same');
  out.push(';; structural inference the TextMate generator uses.');
  out.push(';; -----------------------------------------------------------------');
  out.push('');

  // Collect every literal that appears in rules + prec table.
  const allLiterals = new Set<string>();
  for (const rule of grammar.rules) for (const lit of collectLiterals(rule.body)) allLiterals.add(lit);
  for (const lvl of grammar.precs) for (const op of lvl.operators) allLiterals.add(op.value);

  // ── A+B. Literal captures grouped by capture name ──
  // keyword literals (identifier-shaped) and symbolic operators/punctuation.
  const captureGroups = new Map<string, Set<string>>();
  const add = (cap: string, lit: string) => {
    if (!captureGroups.has(cap)) captureGroups.set(cap, new Set());
    captureGroups.get(cap)!.add(lit);
  };

  // From the scopes section first (authoritative).
  for (const [lit, scopes] of scopeOverrides) {
    if (lit.startsWith('.')) continue; // property-name overrides handled separately
    const cap = scopeToCapture(scopes[0]);
    if (cap) add(cap, lit);
  }
  // Keyword literals with no scope override → @keyword.
  for (const lit of allLiterals) {
    if (!isKeywordLiteral(lit)) continue;
    if (scopeOverrides.has(lit)) continue;
    add('@keyword', lit);
  }
  // Symbolic operators from the prec table with no override → @operator.
  for (const lvl of grammar.precs) {
    for (const op of lvl.operators) {
      if (isKeywordLiteral(op.value)) continue;
      if (scopeOverrides.has(op.value)) continue;
      add('@operator', op.value);
    }
  }
  // Remaining symbolic literals with no override → @punctuation.delimiter.
  for (const lit of allLiterals) {
    if (isKeywordLiteral(lit)) continue;
    if (scopeOverrides.has(lit)) continue;
    if ([...grammar.precs].some(l => l.operators.some(o => o.value === lit))) continue;
    add('@punctuation.delimiter', lit);
  }

  // ── C. Token-node captures (numbers, strings, comments, regex, decorators) ──
  // These reference the named token rule by its snake name.
  const tokenNodeCaptures: ScmRule[] = [];
  for (const tok of grammar.tokens) {
    if (tok.identifier) continue; // identifier handled by fallback + keyword lists
    const cap = tokenCapture(tok.pattern, tok.flags, tok.scope);
    if (!cap) continue;
    const snake = ctx.scannerTokenFor.get(tok.name) ?? ctx.tokenSnake.get(tok.name)!;
    tokenNodeCaptures.push({ query: `(${snake})`, capture: cap });
  }

  // ── D. Contextual node captures via emitted fields ──
  // Operators carry an `operator` field in Pratt rules; they're already covered by
  // the literal @operator lists below (longest-match-first), so we don't emit a
  // separate field query for them. The `name` field (declaration names) IS used.
  const identTok = grammar.tokens.find(t => t.identifier);
  const identSnake = identTok ? ctx.tokenSnake.get(identTok.name)! : null;

  // ── Emit identifier fallback FIRST (lowest priority) ──
  if (identSnake) {
    out.push(';; Bare identifier (lowest priority; specific patterns below win).');
    out.push(`(${identSnake}) @variable`);
    out.push('');
  }

  // ── Definition names via the `name` field emitted in grammar.js ──
  // The identifier after a declaration keyword was wrapped in field('name', …),
  // so we query it with the STANDARD tree-sitter form (no custom predicate).
  // Capture chosen by the same inferIdentScope rule gen-tm uses
  // (storage.type.function* → @function; storage.type.X → @type).
  if (identSnake && nameFieldsByRule.length > 0) {
    out.push(';; Declaration names (via the `name` field) → @function / @type.');
    // De-dup by (rule, capture) and group: one query per rule.
    const seen = new Set<string>();
    for (const nf of nameFieldsByRule) {
      const key = `${nf.rule} ${nf.capture}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`(${nf.rule} name: (${identSnake}) ${nf.capture})`);
    }
    out.push('');
  }

  // ── Token-node captures (strings/numbers/comments/regex/decorator) ──
  if (tokenNodeCaptures.length > 0) {
    out.push(';; Literal token nodes.');
    for (const r of tokenNodeCaptures) {
      out.push(`${r.query} ${r.capture}`);
    }
    out.push('');
  }

  // ── Known property names from `.name` overrides → @property.builtin etc. ──
  const knownProps = new Map<string, string>();
  for (const [lit, scopes] of scopeOverrides) {
    if (lit.startsWith('.') && lit.length > 1) {
      const cap = scopeToCapture(scopes[0]);
      if (cap) knownProps.set(lit.slice(1), cap);
    }
  }
  if (identSnake && knownProps.size > 0) {
    out.push(';; Well-known property names.');
    const byCap = new Map<string, string[]>();
    for (const [prop, cap] of knownProps) {
      if (!byCap.has(cap)) byCap.set(cap, []);
      byCap.get(cap)!.push(prop);
    }
    for (const [cap, props] of byCap) {
      const list = props.map(jsString).join(' ');
      out.push(`((${identSnake}) ${cap}`);
      out.push(`  (#any-of? ${cap} ${list}))`);
    }
    out.push('');
  }

  // ── Keyword / operator / punctuation literal lists (highest priority) ──
  // Sort captures into a stable, readable order.
  const order = [
    '@keyword', '@keyword.function', '@keyword.import', '@keyword.conditional',
    '@keyword.repeat', '@keyword.return', '@keyword.exception', '@keyword.operator',
    '@type', '@type.builtin', '@constant.builtin', '@variable.builtin',
    '@operator', '@punctuation.bracket', '@punctuation.delimiter',
  ];
  const sortedCaps = [...captureGroups.keys()].sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  out.push(';; Keyword, operator, and punctuation literals.');
  for (const cap of sortedCaps) {
    const lits = [...captureGroups.get(cap)!].sort((a, b) => b.length - a.length);
    if (lits.length === 1) {
      out.push(`${jsString(lits[0])} ${cap}`);
    } else {
      // tree-sitter list form: [ "a" "b" "c" ] @capture
      const chunked = chunk(lits.map(jsString), 8).map(c => '  ' + c.join(' '));
      out.push('[');
      out.push(chunked.join('\n'));
      out.push(`] ${cap}`);
    }
  }
  out.push('');

  return out.join('\n');
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface NameFieldPlan {
  /** the exact identifier ref nodes to wrap in field('name', …) */
  nodes: Set<RuleExpr>;
  /** per-rule capture for the standard `(rule name: (ident) @cap)` query */
  byRule: { rule: string; capture: string }[];
}

/**
 * Find every `<definition-keyword> … <Ident>` adjacency and plan a `name` field
 * for that identifier. Capture is classified the same way gen-tm.ts's
 * inferIdentScope does:
 *   storage.type.function* → the name is a @function
 *   storage.type.X (other) → the name is a @type
 *
 * Returns BOTH the set of ref nodes to wrap (by identity) AND the (rule,capture)
 * pairs so highlights.scm can emit a standard `name:` query per rule. The Ident
 * may be separated from the keyword by non-keyword literals (e.g. `function *`),
 * mirroring detectDeclarations' nameIdx scan.
 */
function collectNameFields(grammar: CstGrammar): NameFieldPlan {
  const tokenNames = new Set(grammar.tokens.map(t => t.name));
  const identName = grammar.tokens.find(t => t.identifier)?.name;
  const ruleSnake = new Map(grammar.rules.map(r => [r.name, toSnake(r.name)]));
  const nodes = new Set<RuleExpr>();
  const byRule: { rule: string; capture: string }[] = [];

  function inferCapture(keyword: string): string | null {
    const scope = grammar.scopeOverrides.get(keyword)?.[0];
    if (!scope) return null;
    if (scope.startsWith('storage.type.function')) return '@function';
    if (scope.startsWith('storage.type.') && scope !== 'storage.type') return '@type';
    return null;
  }

  // Does an item carry the identifier token name (possibly the body of an
  // optional like `opt(Ident)`)? Used to locate anonymous-decl name slots.
  function isIdentRef(item: RuleExpr): RuleExpr | null {
    if (item.type === 'ref' && item.name === identName && tokenNames.has(item.name)) return item;
    if (item.type === 'quantifier' || item.type === 'group') return isIdentRef(item.body);
    return null;
  }
  // Is this item a "skippable" decoration between the keyword and the name —
  // a non-keyword literal (`*`) or an optional/group wrapping one (`opt('*')`)?
  function isSkippableModifier(item: RuleExpr): boolean {
    if (item.type === 'literal') return !isKeywordLiteral(item.value);
    if (item.type === 'quantifier' || item.type === 'group') {
      const b = item.body;
      return b.type === 'literal' && !isKeywordLiteral(b.value);
    }
    return false;
  }

  function walkSeq(items: RuleExpr[], ruleName: string) {
    for (let i = 0; i < items.length - 1; i++) {
      const a = items[i];
      if (a.type !== 'literal' || !isKeywordLiteral(a.value)) continue;
      const cap = inferCapture(a.value);
      if (!cap) continue;
      // Find the next IDENT ref, skipping intervening modifiers like `*` / `opt('*')`
      // (mirrors detectDeclarations' nameIdx scan). Stop at the first non-skippable.
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        const ident = isIdentRef(b);
        if (ident) {
          nodes.add(ident);
          byRule.push({ rule: ruleSnake.get(ruleName)!, capture: cap });
          break;
        }
        if (isSkippableModifier(b)) continue; // e.g. '*' or opt('*')
        break; // anything else → not a `keyword … name` declaration shape
      }
    }
  }
  function walk(node: RuleExpr, ruleName: string) {
    if (node.type === 'seq') walkSeq(node.items, ruleName);
    if (node.type === 'seq' || node.type === 'alt') node.items.forEach(i => walk(i, ruleName));
    if (node.type === 'quantifier' || node.type === 'group') walk(node.body, ruleName);
    if (node.type === 'sep') walk(node.element, ruleName);
  }
  for (const rule of grammar.rules) walk(rule.body, rule.name);
  return { nodes, byRule };
}

// ════════════════════════════════════════════════════════════════════════════
// 3. src/scanner.c — external scanner scaffold
//
// The context-sensitive lexing (regex-vs-division, template interpolation holes)
// can't be expressed by tree-sitter's regex lexer alone, so it needs an external
// scanner in C. We scaffold the full interface and wire in the grammar-derived
// data (token enum, the division-after sets, the template delimiters). The
// actual scan() body is PARTIAL — the regex-literal scan is implemented; the
// template state machine is stubbed with the derived delimiters and TODOs.
// ════════════════════════════════════════════════════════════════════════════

function buildScannerC(
  grammar: CstGrammar,
  ctx: GrammarJsContext,
  grammarName: string,
): { scannerC: string; externalTokens: string[] } {
  const regexTok = grammar.tokens.find(t => t.flags.includes('regex'));
  const templateTok = grammar.tokens.find(t => t.template);

  const externalTokens: string[] = [];
  for (const s of ctx.scannerTokenFor.values()) externalTokens.push(s);

  // If there is genuinely nothing context-sensitive, emit a no-op scanner.
  const needScanner = !!regexTok;

  const L: string[] = [];
  L.push('// Tree-sitter external scanner generated by monogram.');
  L.push('//');
  L.push('// PARTIAL IMPLEMENTATION — the regex-literal scan is wired from the');
  L.push('// grammar\'s `regexContext` hint; the template-interpolation machinery is');
  L.push('// stubbed (delimiters are filled in, the state machine is a TODO).');
  L.push('//');
  L.push('// All language-specific data below is DERIVED from the CstGrammar, not');
  L.push('// hardcoded: the division-after character sets, the regex flag chars, and');
  L.push('// the template delimiters all come from the grammar\'s token hints.');
  L.push('');
  L.push('#include "tree_sitter/parser.h"');
  L.push('#include <string.h>');
  L.push('#include <wctype.h>');
  L.push('');

  // ── Token enum ──
  L.push('enum TokenType {');
  for (const s of externalTokens) {
    L.push(`  ${s.toUpperCase()},`);
  }
  if (externalTokens.length === 0) L.push('  NO_EXTERNAL_TOKENS,');
  L.push('};');
  L.push('');

  // ── Scanner state ──
  L.push('// Scanner state: depth of nested `{` inside each open template');
  L.push('// interpolation hole, mirroring the JS lexer\'s templateStack. Kept tiny');
  L.push('// and trivially (de)serializable.');
  L.push('typedef struct {');
  L.push('  uint8_t interp_depth_stack[32];');
  L.push('  uint8_t interp_stack_len;');
  L.push('} Scanner;');
  L.push('');

  // ── create/destroy ──
  L.push('void *tree_sitter_' + grammarName + '_external_scanner_create(void) {');
  L.push('  Scanner *s = ts_malloc(sizeof(Scanner));');
  L.push('  s->interp_stack_len = 0;');
  L.push('  return s;');
  L.push('}');
  L.push('');
  L.push('void tree_sitter_' + grammarName + '_external_scanner_destroy(void *payload) {');
  L.push('  ts_free(payload);');
  L.push('}');
  L.push('');

  // ── serialize/deserialize ──
  L.push('unsigned tree_sitter_' + grammarName + '_external_scanner_serialize(void *payload, char *buffer) {');
  L.push('  Scanner *s = (Scanner *)payload;');
  L.push('  unsigned len = 0;');
  L.push('  buffer[len++] = (char)s->interp_stack_len;');
  L.push('  for (unsigned i = 0; i < s->interp_stack_len; i++) buffer[len++] = (char)s->interp_depth_stack[i];');
  L.push('  return len;');
  L.push('}');
  L.push('');
  L.push('void tree_sitter_' + grammarName + '_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {');
  L.push('  Scanner *s = (Scanner *)payload;');
  L.push('  s->interp_stack_len = 0;');
  L.push('  if (length > 0) {');
  L.push('    s->interp_stack_len = (uint8_t)buffer[0];');
  L.push('    for (unsigned i = 0; i < s->interp_stack_len && i + 1 < length; i++) s->interp_depth_stack[i] = (uint8_t)buffer[i + 1];');
  L.push('  }');
  L.push('}');
  L.push('');

  // ── helpers: advance ──
  L.push('static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }');
  L.push('static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }');
  L.push('');

  if (needScanner && regexTok) {
    // Derive the regex literal scan from the token pattern + hints.
    const flagMatch = regexTok.pattern.match(/\[([a-z]+)\]\*?\s*$/i);
    const flagChars = flagMatch ? flagMatch[1] : 'gimsuyd';
    const rc = regexTok.regexContext;
    const divTexts = rc?.divisionAfterTexts ?? [];
    const regexAfter = rc?.regexAfterTexts ?? [];

    const regexSym = ctx.scannerTokenFor.get(regexTok.name)!.toUpperCase();

    L.push('// ── Regex-literal scan ──────────────────────────────────────────');
    L.push('// `/` is a regex literal ONLY in expression-start position. tree-sitter');
    L.push('// gives us `valid_symbols`: it asks for the regex token exactly where the');
    L.push('// grammar permits it (i.e. NOT after a value/`)`/`]`), so the bulk of the');
    L.push('// regex-vs-division decision is already made by the LR context. We only');
    L.push('// need to scan the literal body here.');
    L.push('//');
    L.push(`// Regex flag characters (derived from the token pattern): "${flagChars}"`);
    if (divTexts.length) L.push(`// Division-after texts (informational; LR ctx handles these): ${divTexts.join(' ')}`);
    if (regexAfter.length) L.push(`// Regex-after keywords (informational): ${regexAfter.join(' ')}`);
    L.push('static bool scan_regex(TSLexer *lexer) {');
    L.push('  if (lexer->lookahead != \'/\') return false;');
    L.push('  advance(lexer); // consume opening /');
    L.push('  // Empty regex `//` is actually a comment — bail so the lexer matches that.');
    L.push('  if (lexer->lookahead == \'/\' || lexer->lookahead == \'*\') return false;');
    L.push('  bool in_class = false;');
    L.push('  for (;;) {');
    L.push('    int32_t c = lexer->lookahead;');
    L.push('    if (c == 0 || c == \'\\n\') return false; // unterminated');
    L.push('    if (c == \'\\\\\') { advance(lexer); if (lexer->lookahead == 0) return false; advance(lexer); continue; }');
    L.push('    if (c == \'[\') { in_class = true; advance(lexer); continue; }');
    L.push('    if (c == \']\') { in_class = false; advance(lexer); continue; }');
    L.push('    if (c == \'/\' && !in_class) { advance(lexer); break; }');
    L.push('    advance(lexer);');
    L.push('  }');
    L.push('  // Trailing flag characters.');
    L.push(`  const char *flags = ${jsString(flagChars)};`);
    L.push('  while (lexer->lookahead != 0 && strchr(flags, (char)lexer->lookahead) != NULL) advance(lexer);');
    L.push(`  lexer->result_symbol = ${regexSym};`);
    L.push('  lexer->mark_end(lexer);');
    L.push('  return true;');
    L.push('}');
    L.push('');
  }

  // ── scan() entry ──
  L.push('bool tree_sitter_' + grammarName + '_external_scanner_scan(void *payload, TSLexer *lexer,');
  L.push('                                                          const bool *valid_symbols) {');
  L.push('  Scanner *s = (Scanner *)payload;');
  L.push('  (void)s;');
  L.push('');
  L.push('  // Skip leading whitespace (the regular lexer normally does this, but the');
  L.push('  // external scanner runs first when any external symbol is valid).');
  L.push('  while (iswspace(lexer->lookahead)) skip(lexer);');
  L.push('');
  if (needScanner && regexTok) {
    const regexSym = ctx.scannerTokenFor.get(regexTok.name)!.toUpperCase();
    L.push(`  if (valid_symbols[${regexSym}] && lexer->lookahead == '/') {`);
    L.push('    if (scan_regex(lexer)) return true;');
    L.push('  }');
    L.push('');
  }
  if (templateTok && templateTok.template) {
    const t = templateTok.template;
    L.push('  // ── TEMPLATE INTERPOLATION (TODO — STUB) ─────────────────────────');
    L.push(`  // Template delimiters (derived from the grammar's template hint):`);
    L.push(`  //   open        = ${jsString(t.open)}`);
    L.push(`  //   interpOpen  = ${jsString(t.interpOpen)}`);
    L.push(`  //   interpClose = ${jsString(t.interpClose)}`);
    L.push('  //');
    L.push('  // A full implementation tracks `{`-nesting inside each open hole using');
    L.push('  // s->interp_depth_stack (mirroring gen-lexer.ts\'s templateStack) and emits');
    L.push('  // template-head / template-middle / template-tail tokens so `${ … }` holes');
    L.push('  // re-enter the expression grammar. Not implemented here.');
    L.push('  //');
    L.push('  // NOTE: this scaffold treats the whole template as a single token via the');
    L.push('  // regex rule in grammar.js, so simple (non-interpolated) templates already');
    L.push('  // highlight; interpolation holes are NOT yet re-parsed as expressions.');
    L.push('');
  }
  L.push('  return false;');
  L.push('}');
  L.push('');

  return { scannerC: L.join('\n'), externalTokens };
}
