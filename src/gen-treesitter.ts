import type { CstGrammar, RuleExpr, RuleDecl } from './types.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';
import { tokenPatternIsNever, tokenPatternSource, tokenPatternStartsWithDecimal, tokenPatternStringDelimiters, tokenPatternTrailingCharClass } from './token-pattern.ts';

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

/**
 * Rewrite a JS token-pattern into one tree-sitter's `token()` regex engine accepts.
 *
 * tree-sitter's lexer DFA has no zero-width assertions: a leading `^` anchor and
 * any look-around group (`(?=…)`, `(?!…)`, `(?<=…)`, `(?<!…)`) make `tree-sitter
 * generate` fail outright. They exist in the source patterns only to help the
 * hand-written longest-match lexer (e.g. a numeric literal's `(?![0-9A-Za-z_$])`
 * boundary guard, the shebang's `^`); tree-sitter enforces the same boundaries
 * structurally via its DFA + lexical-precedence, so we strip them. This is the
 * standard practice for porting such patterns to tree-sitter and is purely
 * syntactic — no token-specific knowledge.
 */
function sanitizeTreeSitterRegex(pattern: string): string {
  let p = pattern;
  // 1. Drop a single leading `^` anchor (tree-sitter tokens are position-anchored).
  if (p.startsWith('^')) p = p.slice(1);

  // 2. Remove every look-around group, scanning with balanced-paren + escape +
  //    character-class awareness so nested groups inside the assertion go too.
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') { out += c + (p[i + 1] ?? ''); i++; continue; }
    // A character class `[…]` is opaque — copy it verbatim (it may contain `(`).
    if (c === '[') {
      let j = i + 1;
      let cls = '[';
      while (j < p.length) {
        cls += p[j];
        if (p[j] === '\\') { cls += p[j + 1] ?? ''; j += 2; continue; }
        if (p[j] === ']') { j++; break; }
        j++;
      }
      out += cls; i = j - 1; continue;
    }
    // A group that opens with a look-around prefix → skip the whole balanced group.
    if (c === '(' && /^\(\?(?:=|!|<=|<!)/.test(p.slice(i))) {
      let depth = 0, j = i;
      for (; j < p.length; j++) {
        const d = p[j];
        if (d === '\\') { j++; continue; }
        if (d === '[') { // skip a nested character class
          j++;
          while (j < p.length && p[j] !== ']') { if (p[j] === '\\') j++; j++; }
          continue;
        }
        if (d === '(') depth++;
        else if (d === ')') { depth--; if (depth === 0) break; }
      }
      i = j; // resume after the closing ')'
      continue;
    }
    out += c;
  }
  return out;
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
   * If the grammar declares an interpolated-template token, the plan for turning it
   * into a `template` RULE (delimiters + the `${ … }` hole) backed by an external
   * `template_chars` token. `null` when no template token exists.
   */
  templatePlan: TemplatePlan | null;
  /** String tokens carrying highlight-only interpolation regions, each re-expressed as a rule
   *  backed by an external `<rule>_chars` token (parallel to `templatePlan`). Empty if none. */
  interpolationPlans: InterpolationPlan[];
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
      // A token provided by the external scanner is referenced by its scanner
      // symbol name (e.g. `regex` → `regex_literal`), not its plain token snake.
      const scannerSym = ctx.scannerTokenFor.get(expr.name);
      const ref = scannerSym
        ? `$.${scannerSym}`
        : ctx.tokenNames.has(expr.name)
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
    case 'noCommentBefore':
      // Zero-width "no comment before" assertion (YAML plain-scalar fold) — like `sameLine`,
      // a scanner-level restriction; a no-op in the CFG.
      return 'blank()';
    case 'noMultilineFlowBefore':
      // Zero-width "preceding flow was single-line" assertion (YAML flow-as-block-key) — like
      // `noCommentBefore`, a scanner-level restriction; a no-op in the CFG.
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
  // The interpolated-template token is re-expressed as a `template` RULE (with
  // `${ … }` holes that re-enter the expression grammar), emitted separately.
  if (ctx.templatePlan && ctx.templatePlan.tokenName === name) return null;
  // A string token with interpolation regions is likewise re-expressed as a rule (emitted separately).
  if (ctx.interpolationPlans.some(ip => ip.tokenName === name)) return null;
  // Skip-flagged tokens (comments, whitespace) go in `extras`, not as a named
  // rule reference — but we still emit them so highlights can capture comments.
  // tree-sitter's token() DFA rejects zero-width assertions, so strip them first.
  if (tokenPatternIsNever(tok)) return 'token(/[^\\s\\S]/)';
  return `token(${jsRegexLiteral(sanitizeTreeSitterRegex(tokenPatternSource(tok)))})`;
}

// ── conflicts ────────────────────────────────────────────────────────────────

/**
 * The LR(1) conflict CLOSURE for a highly-ambiguous grammar like this one.
 *
 * Computing the exact, minimal set of N-way conflict tuples tree-sitter needs is
 * an LR(1)-table property — pairwise structural over-approximation is NOT enough
 * (some states genuinely need a specific 3- or 4-rule tuple, e.g. `block`/`expr`/
 * `decl` for `export { } <`). The standard tree-sitter authoring workflow is to
 * run `tree-sitter generate`, read the "Add a conflict for these rules: …"
 * suggestion, add it, and repeat to a fixpoint.
 *
 * `test/collect-conflicts.ts` automates exactly that loop across every derived grammar
 * and prints the tuples to add here. The closure is therefore DERIVED FROM THE GRAMMAR
 * (by tree-sitter's own analysis of it), keyed on snake rule names. Each tuple is applied
 * DEFENSIVELY below — only when every rule in it exists in the grammar — so the table is
 * inert for any other language and degrades to the purely-structural heuristics.
 *
 * After a grammar change, run `node test/collect-conflicts.ts`, paste any printed tuples
 * here, and re-run `npm run gen`. (CI only builds the typescript + html tree-sitters, so
 * this is the only check that catches a new conflict in the tsx/js/jsx grammars.)
 */
const LR_CONFLICT_CLOSURE: string[][] = [
  ['expr'], ['stmt'], ['stmt', 'decl'], ['expr', 'decl'], ['program', 'stmt'],
  ['type', 'type_param'], ['type_param'], ['expr', 'param'], ['expr', 'new_target'],
  ['expr', 'block'], ['expr', 'member_name'], ['expr', 'prop'], ['member_name', 'stmt'],
  ['decl'], ['binding'], ['type'], ['type', 'typeof_ref'], ['type', 'param'],
  ['type_member'], ['expr', 'binding_pattern'], ['expr', 'binding_element'],
  ['prop', 'binding_property'], ['member_name', 'binding_property'],
  ['expr', 'block', 'decl'], ['expr', 'prop', 'import_specifier'],
  ['expr', 'import_specifier'], ['type', 'expr'], ['type', 'binding_pattern'],
  ['type', 'binding_element'], ['type_member', 'binding_property'], ['type_member', 'expr'],
  ['expr', 'array_binding_element'], ['expr', 'binding_property'], ['prop', 'member_name'],
  ['type_member', 'class_member'], ['type_member', 'member_name'], ['type', 'binding'],
  ['interface_member'], ['type', 'decl'], ['typeof_ref', 'expr'], ['type', 'expr', 'param'],
  ['type_member', 'prop'], ['type', 'array_binding_element'], ['type', 'type_member'],
  ['prop', 'member_name', 'binding_property'], ['type', 'class_member'],
  ['type', 'expr', 'decl'], ['stmt', 'param'], ['expr', 'interface_member'],
  ['type', 'expr', 'binding_pattern'], ['type', 'expr', 'binding_element'],
  ['type_member', 'prop', 'binding_property'], ['type_member', 'member_name', 'binding_property'],
  ['type', 'interface_member'], ['type_member', 'interface_member'],
  ['type_member', 'expr', 'interface_member'], ['type', 'expr', 'array_binding_element'],
  ['type_member', 'prop', 'member_name'], ['type', 'expr', 'block'],
  ['type_member', 'expr', 'member_name'], ['type_member', 'expr', 'prop'],
  ['type_member', 'member_name', 'stmt'],
  ['type_member', 'prop', 'member_name', 'binding_property'],
  ['type', 'type_member', 'interface_member'], ['type_member', 'param'],
  ['type', 'type_member', 'class_member'],
  // class-expression heritage base (`extends class {}`) overlaps an object-type `{}`
  // after `extends`/`implements`; the two jsx tuples are latent tsx/jsx gaps surfaced
  // while completing the closure (CI builds only the typescript + html tree-sitters, so
  // tsx/jsx generate was never exercised). Each is inert for languages lacking the rule.
  ['type', 'class_heritage'], ['type_param', 'jsxtag_name'], ['expr', 'jsxcontainer'],
];

/**
 * Derive `conflicts` entries from the grammar's structural ambiguities, plus the
 * LR(1) closure above. The purely-structural heuristics (generics-vs-comparison,
 * arrow-vs-paren) document the *why*; the closure makes tree-sitter actually
 * generate. Both are keyed on grammar rule names — no language token list.
 */
function deriveConflicts(ctx: GrammarJsContext): string[][] {
  const conflicts: string[][] = [];
  const seen = new Set<string>();
  const push = (c: string[]) => {
    // De-dup; canonicalise tuple order so [a,b] and [b,a] collapse.
    const key = [...c].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push(c);
  };
  const g = ctx.grammar;
  const ruleSnakes = new Set(ctx.ruleSnake.values());

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
      if (a !== b) push([a, b]);
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
      push([ctx.ruleSnake.get(exprRule)!]);
    }
  }

  // 3. The LR(1) closure tree-sitter's own analysis reports for this grammar.
  //    Applied only for tuples whose rules all exist here (inert otherwise).
  for (const tuple of LR_CONFLICT_CLOSURE) {
    if (tuple.every(r => ruleSnakes.has(r))) push(tuple);
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

/**
 * Plan for an interpolated-template token. The single regex token (`Template`) is
 * re-expressed as a tree-sitter RULE so `${ … }` holes re-enter the expression
 * grammar, mirroring how gen-parser.ts/gen-lexer.ts split a template into
 * head/middle/tail spans around interpolation holes. All delimiters are DERIVED
 * from the token's `template` hint — nothing here is TS-specific.
 */
interface TemplatePlan {
  /** original token name (e.g. 'Template') — now emitted as a rule, not a token */
  tokenName: string;
  /** snake rule name the template rule is emitted under (keeps `$.template` refs valid) */
  ruleSnake: string;
  /** snake name of the `template_substitution` rule (the `${ … }` hole) */
  substRuleSnake: string;
  /** external scanner symbol (snake) for the literal text between delimiters */
  charsSnake: string;
  open: string;        // starts AND ends the literal (e.g. '`')
  interpOpen: string;  // starts a hole (e.g. '${')
  interpClose: string; // ends a hole (e.g. '}')
}

function planTemplate(grammar: CstGrammar): TemplatePlan | null {
  const tok = grammar.tokens.find(t => t.template);
  if (!tok || !tok.template) return null;
  const ruleSnake = toSnake(tok.name);
  return {
    tokenName: tok.name,
    ruleSnake,
    substRuleSnake: ruleSnake + '_substitution',
    charsSnake: ruleSnake + '_chars',
    open: tok.template.open,
    interpOpen: tok.template.interpOpen,
    interpClose: tok.template.interpClose,
  };
}

/**
 * A string token carrying highlight-only interpolation regions (e.g. env-spec `${…}` / `$(…)`),
 * re-expressed as a tree-sitter RULE (open delim + chars/interpolation runs + close delim) — the
 * same shape a template literal gets. The literal text between regions is an external
 * `<rule>_chars` token (the scanner stops it at the close delim or any region opener).
 */
interface InterpolationPlan {
  tokenName: string;     // original token name (e.g. 'DQ') — now emitted as a rule, not a token
  ruleSnake: string;     // snake rule name (e.g. 'dq') — keeps `$.dq` references valid
  charsSnake: string;    // external scanner symbol for the literal text (e.g. 'dq_chars')
  open: string;          // opening delimiter (e.g. '"')
  close: string;         // closing delimiter (same as open for a string token)
  regions: { ruleSnake: string; open: string; close: string }[]; // one sub-rule per interpolation entry
}

function planInterpolations(grammar: CstGrammar): InterpolationPlan[] {
  const plans: InterpolationPlan[] = [];
  for (const tok of grammar.tokens) {
    if (!tok.interpolation?.length) continue;
    const open = tokenPatternStringDelimiters(tok)[0] ?? '"';
    const ruleSnake = toSnake(tok.name);
    plans.push({
      tokenName: tok.name,
      ruleSnake,
      charsSnake: ruleSnake + '_chars',
      open,
      close: open,
      regions: tok.interpolation.map((interp, i) => ({
        ruleSnake: `${ruleSnake}_interpolation_${i + 1}`,
        open: interp.begin,
        close: interp.end,
      })),
    });
  }
  return plans;
}

/** Determine which tokens the external scanner must provide. */
function planScannerTokens(grammar: CstGrammar): Map<string, string> {
  const map = new Map<string, string>();
  // A newline-sensitive grammar's NEWLINE token is engine-emitted; in tree-sitter it becomes a
  // stateless external token (the scanner emits it at each significant line boundary). Listed
  // FIRST so it heads the enum / externals order.
  if (grammar.newline) map.set(grammar.newline.token, toSnake(grammar.newline.token));
  // The regex token: '/' is context-sensitive (regex vs division). The scanner
  // resolves it.
  const regexTok = grammar.tokens.find(t => t.flags.includes('regex'));
  if (regexTok) map.set(regexTok.name, toSnake(regexTok.name) + '_literal');
  return map;
}

/**
 * The ordered list of external scanner symbols (snake_case). This is the SINGLE
 * source of truth shared by grammar.js's `externals` block and scanner.c's
 * `TokenType` enum — tree-sitter matches them positionally, so both MUST agree.
 */
function externalSymbols(ctx: GrammarJsContext): string[] {
  const syms = [...ctx.scannerTokenFor.values()];
  if (ctx.templatePlan) syms.push(ctx.templatePlan.charsSnake);
  for (const ip of ctx.interpolationPlans) syms.push(ip.charsSnake);
  return syms;
}

// ── Markup tree-sitter (HTML/Vue), v1 ──
// A markup grammar gets a purpose-built tree-sitter grammar (element/tag/attribute/
// text/comment), derived from the markup config — the token-stream construction below
// doesn't model markup. v1 scope: WELL-FORMED structure; raw-text element bodies
// (<script>/<style>) are treated as ordinary text, so a literal `<` inside them isn't
// supported yet (a generated external scanner is the next increment). No external
// tokens → no scanner.c. Void elements use a higher-precedence `_void_name` token so
// `<br>` never enters the container branch (the same idea as the parser's VoidName).
function buildMarkupTreeSitter(grammar: CstGrammar, grammarName: string): TreeSitterOutput {
  const m = grammar.markup!;
  const idTok = grammar.tokens.find(t => t.identifier);
  const namePat = idTok ? tokenPatternSource(idTok) : '[a-zA-Z][\\w:.-]*';
  const o = m.tagOpen, c = m.tagClose, sl = m.closeMarker ?? '/';
  const voidAlt = (m.voidTags ?? []).join('|');
  const cOpen = m.comment?.open ?? '<!--', cClose = m.comment?.close ?? '-->';
  const rawTags = (m.rawText?.tags ?? []).map(t => t.toLowerCase());
  const hasRaw = rawTags.length > 0;
  const rawAlt = rawTags.join('|');

  // Raw-text elements (script/style/…) need an external scanner: their body is verbatim,
  // so a `<` inside it (`1 < 2`) is content, not a tag — which a CFG/regex can't express.
  // The `raw_text` external token is scanned by src/scanner.c (below) up to the matching
  // close tag. Without raw-text tags, no externals are needed (scanner.c stays empty).
  const rawRule = hasRaw
    ? `    raw_element: $ => seq('${o}', alias($._raw_name, $.tag_name), repeat($.attribute), '${c}', optional($.raw_text), '${o}${sl}', alias($._raw_name, $.tag_name), '${c}'),\n`
    : '';
  const rawNameRule = hasRaw ? `    _raw_name: $ => token(prec(2, /(${rawAlt})/i)),\n` : '';
  const rawChoice = hasRaw ? '      $.raw_element,\n' : '';

  const grammarJs = `// AUTO-GENERATED by src/gen-treesitter.ts (markup path) — do not edit by hand.
// Well-formed HTML structure (tags / attributes / text / comments) + raw-text elements.
// Raw-text element bodies (<script>/<style>) are one external \`raw_text\` token (see
// src/scanner.c), so a literal '<' inside them is content, not markup.
module.exports = grammar({
  name: '${grammarName}',${hasRaw ? '\n  externals: $ => [$.raw_text],' : ''}
  extras: $ => [/\\s+/],
  rules: {
    document: $ => repeat($._node),
    _node: $ => choice($.element, $.comment, $.text),
    element: $ => choice(
${rawChoice}      $.void_element,
      $.self_closing_tag,
      seq($.start_tag, repeat($._node), $.end_tag),
    ),
${rawRule}    start_tag: $ => seq('${o}', $.tag_name, repeat($.attribute), '${c}'),
    end_tag: $ => seq('${o}${sl}', $.tag_name, '${c}'),
    self_closing_tag: $ => seq('${o}', $.tag_name, repeat($.attribute), '${sl}${c}'),
    void_element: $ => seq('${o}', alias($._void_name, $.tag_name), repeat($.attribute), optional('${sl}'), '${c}'),
    attribute: $ => seq($.attribute_name, optional(seq('=', choice($.quoted_attribute_value, $.attribute_value)))),
    attribute_name: $ => /${namePat}/,
    attribute_value: $ => /[^\\s"'<>=\`]+/,
    quoted_attribute_value: $ => choice(seq('"', optional(/[^"]+/), '"'), seq("'", optional(/[^']+/), "'")),
    tag_name: $ => /${namePat}/,
    _void_name: $ => token(prec(1, /(${voidAlt})/i)),
${rawNameRule}    text: $ => /[^${o}]+/,
    comment: $ => token(seq('${cOpen}', /[\\s\\S]*?/, '${cClose}')),
  }
});
`;

  // tree-sitter highlight captures (the standard nvim/helix capture names).
  const highlightsScm = [
    '; AUTO-GENERATED by src/gen-treesitter.ts (markup path) — do not edit by hand.',
    '(tag_name) @tag',
    '(attribute_name) @attribute',
    '(quoted_attribute_value) @string',
    '(attribute_value) @string',
    '(comment) @comment',
    `"${o}" @punctuation.bracket`,
    `"${c}" @punctuation.bracket`,
    `"${o}${sl}" @punctuation.bracket`,
    `"${sl}${c}" @punctuation.bracket`,
    '"=" @punctuation.delimiter',
    '',
  ].join('\n');

  if (!hasRaw) return { grammarJs, highlightsScm, scannerC: '', externalTokens: [] };

  // External scanner: scan a raw-text body to (not including) the next `</` followed by a
  // raw-text tag name. Stateless — the close is the next such delimiter (well-formed input).
  // The tag-name set is DATA from markup.rawText.tags; nothing here hardcodes HTML.
  const rawTagInit = rawTags.map(t => `"${t}"`).join(', ');
  const scannerC = `// AUTO-GENERATED by src/gen-treesitter.ts (markup path) — do not edit by hand.
// Tree-sitter external scanner for raw-text element bodies (<script>/<style>/…).
// No libc: the wasm toolchain doesn't link <ctype.h>/<string.h> (their symbols become
// unresolved imports), so the ASCII helpers below are inlined.
#include "tree_sitter/parser.h"

enum TokenType { RAW_TEXT };

// Raw-text tag names — DERIVED from the grammar's markup.rawText.tags.
static const char *RAW_TAGS[] = { ${rawTagInit} };
static const unsigned RAW_TAG_COUNT = ${rawTags.length};

static int ascii_alpha(int ch) { return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'); }
static int ascii_lower(int ch) { return (ch >= 'A' && ch <= 'Z') ? ch + 32 : ch; }
static int name_eq(const char *a, const char *b) { while (*a && *b) { if (*a != *b) return 0; a++; b++; } return *a == *b; }

void *tree_sitter_${grammarName}_external_scanner_create(void) { return 0; }
void tree_sitter_${grammarName}_external_scanner_destroy(void *p) { (void)p; }
unsigned tree_sitter_${grammarName}_external_scanner_serialize(void *p, char *b) { (void)p; (void)b; return 0; }
void tree_sitter_${grammarName}_external_scanner_deserialize(void *p, const char *b, unsigned n) { (void)p; (void)b; (void)n; }

// Scan the verbatim body of a raw-text element. A '<' is content unless it begins the
// matching close tag '</name>' (name ∈ RAW_TAGS). We advance past a candidate '</name'
// to test it, but mark the token end BEFORE the '<', so the close tag is left to the
// parser. Returns false on an empty body (immediately a close tag) — the body is optional.
bool tree_sitter_${grammarName}_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  (void)payload;
  if (!valid_symbols[RAW_TEXT]) return false;
  lexer->result_symbol = RAW_TEXT;
  bool advanced = false;
  while (!lexer->eof(lexer)) {
    if (lexer->lookahead == '<') {
      lexer->mark_end(lexer);            // body ends here if this is the close tag
      lexer->advance(lexer, false);      // consume '<'
      if (lexer->lookahead == '/') {
        lexer->advance(lexer, false);    // consume '/'
        char name[16];
        unsigned n = 0;
        while (n < 15 && ascii_alpha((int)lexer->lookahead)) {
          name[n++] = (char)ascii_lower((int)lexer->lookahead);
          lexer->advance(lexer, false);
        }
        name[n] = '\\0';
        for (unsigned i = 0; i < RAW_TAG_COUNT; i++) {
          if (name_eq(name, RAW_TAGS[i])) return advanced;  // close tag → stop (end marked before '<')
        }
        advanced = true;                 // '</xxx' was body content; keep scanning
        continue;
      }
      advanced = true;                   // a lone '<' is body content
      continue;
    }
    lexer->advance(lexer, false);
    advanced = true;
  }
  lexer->mark_end(lexer);                 // EOF: the whole remainder is the body
  return advanced;
}
`;

  return { grammarJs, highlightsScm, scannerC, externalTokens: ['raw_text'] };
}

export function generateTreeSitter(grammar: CstGrammar, langName?: string): TreeSitterOutput {
  const name = (langName ?? (grammar as { name?: string }).name ?? 'language');
  const grammarName = toSnake(name);
  // Markup languages (HTML/Vue) get the purpose-built markup grammar, not the token-stream one.
  if (grammar.markup) return buildMarkupTreeSitter(grammar, grammarName);

  const tokenNames = new Set(grammar.tokens.map(t => t.name));
  const ruleSnake = new Map<string, string>();
  const tokenSnake = new Map<string, string>();
  for (const r of grammar.rules) ruleSnake.set(r.name, toSnake(r.name));
  for (const t of grammar.tokens) tokenSnake.set(t.name, toSnake(t.name));

  const prattRules = new Set<string>();
  for (const r of grammar.rules) if (hasMarker(r.body)) prattRules.add(r.name);

  const scannerTokenFor = planScannerTokens(grammar);
  const templatePlan = planTemplate(grammar);
  const interpolationPlans = planInterpolations(grammar);
  const externalSnake = new Set([...scannerTokenFor.values()]);
  if (templatePlan) externalSnake.add(templatePlan.charsSnake);
  for (const ip of interpolationPlans) externalSnake.add(ip.charsSnake);

  // Find the identifier nodes that follow a declaration keyword, so we can wrap
  // them in `field('name', …)` in grammar.js AND emit standard `name:` highlight
  // queries for them. Same shape rule gen-tm.ts uses (inferIdentScope).
  const nameFields = collectNameFields(grammar);

  const ctx: GrammarJsContext = {
    grammar, tokenNames, ruleSnake, tokenSnake, prattRules, externalSnake, scannerTokenFor,
    templatePlan,
    interpolationPlans,
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
  // Order MUST match the scanner.c TokenType enum (see externalSymbols()).
  const externalSyms = externalSymbols(ctx);
  if (externalSyms.length > 0) {
    const exts = externalSyms.map(s => `$.${s}`);
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

  // ── Template rule (interpolated template literal) ──
  // The single template token is re-expressed as a rule whose `${ … }` holes
  // re-enter the expression grammar — the tree-sitter analogue of the lexer's
  // head/middle/tail split. The literal text between delimiters is the external
  // `template_chars` token (the scanner stops it at a delimiter); the delimiters
  // and the brace are anonymous tokens. Delimiters all DERIVED from the hint.
  const tp = ctx.templatePlan;
  if (tp) {
    // The hole re-enters the expression rule (the first Pratt rule), matching the
    // parser's parseExpr inside an interpolation.
    const exprRuleName = [...ctx.prattRules][0];
    const exprSnake = exprRuleName ? ctx.ruleSnake.get(exprRuleName)! : null;
    const holeBody = exprSnake ? `$.${exprSnake}` : 'blank()';
    ruleEntries.push(
      `    ${tp.ruleSnake}: $ => seq(\n` +
      `      ${jsString(tp.open)},\n` +
      `      repeat(choice($.${tp.charsSnake}, $.${tp.substRuleSnake})),\n` +
      `      ${jsString(tp.open)}\n` +
      `    )`,
    );
    ruleEntries.push(
      `    ${tp.substRuleSnake}: $ => seq(${jsString(tp.interpOpen)}, ${holeBody}, ${jsString(tp.interpClose)})`,
    );
  }

  // String-interpolation tokens: re-expressed as a rule (open + chars/interpolation runs + close);
  // each interpolation region is a sub-rule whose hole re-enters the expression grammar (like a template).
  const interpExprName = [...ctx.prattRules][0];
  const interpExprSnake = interpExprName ? ctx.ruleSnake.get(interpExprName)! : null;
  const interpHole = interpExprSnake ? `optional($.${interpExprSnake})` : 'blank()';
  for (const ip of ctx.interpolationPlans) {
    const choices = [`$.${ip.charsSnake}`, ...ip.regions.map(r => `$.${r.ruleSnake}`)].join(', ');
    ruleEntries.push(
      `    ${ip.ruleSnake}: $ => seq(\n` +
      `      ${jsString(ip.open)},\n` +
      `      repeat(choice(${choices})),\n` +
      `      ${jsString(ip.close)}\n` +
      `    )`,
    );
    for (const r of ip.regions) {
      ruleEntries.push(
        `    ${r.ruleSnake}: $ => seq(${jsString(r.open)}, ${interpHole}, ${jsString(r.close)})`,
      );
    }
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
function tokenCapture(token: CstGrammar['tokens'][number]): string | null {
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
  nameFieldsByRule: { rule: string; capture: string; keyword: string }[],
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

  // From the scopes section first (authoritative). A `scopes` literal that is a
  // real grammar token (appears in rules/precs) becomes an anonymous-token capture;
  // one that is only an IDENTIFIER-NAME hint (a builtin/primitive/global — listed
  // in `scopes` but never a grammar token) CANNOT be an anonymous token (tree-sitter
  // would reject it as a bad node name), so it is matched on the identifier instead.
  // Type-ness is POSITIONAL: a blanket @type/@type.builtin predicate would mis-paint
  // value-position uses (e.g. `Array.from`), so those are left to the structural
  // type-reference capture below; only position-independent vocabulary (globals,
  // constants) is emitted as an #any-of? identifier predicate.
  const identNameHints: { lit: string; cap: string }[] = [];
  for (const [lit, scopes] of scopeOverrides) {
    if (lit.startsWith('.')) continue; // property-name overrides handled separately
    const cap = scopeToCapture(scopes[0]);
    if (!cap) continue;
    if (allLiterals.has(lit)) { add(cap, lit); continue; }      // real grammar token
    if (cap !== '@type' && cap !== '@type.builtin') identNameHints.push({ lit, cap });
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
    const cap = tokenCapture(tok);
    if (!cap) continue;
    // The interpolated-template token is now a RULE whose literal text is the
    // external `template_chars` node — capture THAT (and the delimiters below),
    // not the `template` node itself (which also contains substituted expressions).
    if (ctx.templatePlan && ctx.templatePlan.tokenName === tok.name) {
      tokenNodeCaptures.push({ query: `(${ctx.templatePlan.charsSnake})`, capture: cap });
      continue;
    }
    const snake = ctx.scannerTokenFor.get(tok.name) ?? ctx.tokenSnake.get(tok.name)!;
    tokenNodeCaptures.push({ query: `(${snake})`, capture: cap });
  }
  // Template delimiters: the backtick(s) read as string, the `${`/`}` hole markers
  // as punctuation — derived from the template hint, not hardcoded. Emitted as
  // anonymous-token captures scoped to inside the template rule so they don't grab
  // a stray `}`/backtick elsewhere.
  if (ctx.templatePlan) {
    const tpl = ctx.templatePlan;
    tokenNodeCaptures.push({ query: `(${tpl.ruleSnake} ${jsString(tpl.open)})`, capture: '@string' });
    tokenNodeCaptures.push({ query: `(${tpl.substRuleSnake} ${jsString(tpl.interpOpen)})`, capture: '@punctuation.special' });
    tokenNodeCaptures.push({ query: `(${tpl.substRuleSnake} ${jsString(tpl.interpClose)})`, capture: '@punctuation.special' });
  }
  // String-interpolation regions: the literal text reads as string; the region delimiters as
  // punctuation — same treatment as a template hole, derived from the interpolation metadata.
  for (const ip of ctx.interpolationPlans) {
    tokenNodeCaptures.push({ query: `(${ip.charsSnake})`, capture: '@string' });
    for (const r of ip.regions) {
      tokenNodeCaptures.push({ query: `(${r.ruleSnake} ${jsString(r.open)})`, capture: '@punctuation.special' });
      tokenNodeCaptures.push({ query: `(${r.ruleSnake} ${jsString(r.close)})`, capture: '@punctuation.special' });
    }
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
      const key = `${nf.rule}${nf.capture}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`(${nf.rule} name: (${identSnake}) ${nf.capture})`);
    }
    out.push('');
  }

  // ── Type-reference positions → @type (structural, no hardcoded vocabulary) ──
  // An identifier sitting inside a `type`-flagged rule's node IS a type reference
  // (primitive, user type, or a qualified-name part — the nesting carries each one).
  // This is the tree-sitter analogue of gen-tm's entity.name.type inference, and the
  // reason builtins/primitives need no @type predicate: position decides type-ness.
  // Keyword-anchored declaration names: the generic capture above is ambiguous when
  // one decl rule is shared across kinds (a `class` name vs a `function` name look
  // identical). Anchoring on the keyword token gives each kind its own capture, and
  // reaches names with no `name` field (a bare type-alias name). Emitted later, wins.
  if (identSnake && nameFieldsByRule.length > 0) {
    const seenKw = new Set<string>();
    const kwLines: string[] = [];
    for (const nf of nameFieldsByRule) {
      const key = `${nf.rule} ${nf.keyword} ${nf.capture}`;
      if (seenKw.has(key)) continue;
      seenKw.add(key);
      kwLines.push(`(${nf.rule} ${jsString(nf.keyword)} (${identSnake}) ${nf.capture})`);
    }
    if (kwLines.length > 0) {
      out.push(';; Declaration names, keyword-anchored (disambiguates shared decl rules).');
      out.push(...kwLines);
      out.push('');
    }
  }

  if (identSnake) {
    const typeFlagged = new Set(grammar.rules.filter(r => r.flags.includes('type')).map(r => r.name));
    const typeRuleSnakes = [...new Set([...typeFlagged].map(n => ctx.ruleSnake.get(n)!))].filter(Boolean);
    if (typeRuleSnakes.length > 0) {
      out.push(';; Type-reference identifiers (inside a type node) -> @type.');
      for (const ts of typeRuleSnakes) out.push(`(${ts} (${identSnake}) @type)`);
      out.push('');
    }

    // ── Structural member / type-param / property-access captures (derived from
    //    rule SHAPE; the tree-sitter analogue of gen-tm's per-position inference) ──
    const tokenNames = new Set(grammar.tokens.map(t => t.name));
    const identName = identTok ? identTok.name : '';
    const snake = (n: string) => ctx.ruleSnake.get(n);
    const struct: string[] = [];
    // type parameters: identifiers inside `< … >` whose rule is not already a type rule
    for (const n of angleTypeRules(grammar)) {
      if (typeFlagged.has(n)) continue; // type arguments already covered above
      const s = snake(n); if (s) struct.push(`(${s} (${identSnake}) @type)`);
    }
    // member-key (property-name) rules → @property
    const propRules = propertyNameRules(grammar, identName, tokenNames);
    for (const n of propRules) { const s = snake(n); if (s) struct.push(`(${s} (${identSnake}) @property)`); }
    // type-object member keys → @property
    for (const n of typeMemberRules(grammar)) { const s = snake(n); if (s) struct.push(`(${s} (${identSnake}) @property)`); }
    // property-access tail: obj.prop → @property (only when the grammar has `.` access)
    const exprRuleName = [...ctx.prattRules][0];
    const exprSnake = exprRuleName ? snake(exprRuleName) : null;
    if (exprSnake && hasPropertyAccess(grammar, identName)) struct.push(`(${exprSnake} (${exprSnake}) (${identSnake}) @property)`);
    // destructuring rename key `{ key: binding }` — the key, anchored on the trailing element
    for (const [n, el] of bindingKeyRules(grammar, identName)) {
      const s = snake(n), es = snake(el);
      if (s && es) struct.push(`(${s} (${identSnake}) @property (${es}))`);
    }
    if (struct.length > 0) {
      out.push(';; Structural member / type-param / property-access captures.');
      out.push(...struct);
      out.push('');
    }

    // Enum-like value members override the member-key → @property capture (later, wins).
    const valueMems = valueMemberRules(grammar, propRules);
    if (valueMems.size > 0) {
      out.push(';; Enum-like value members (override member-key, which would say @property).');
      for (const [ruleName, nameRule] of valueMems) {
        const rs = snake(ruleName), ns = snake(nameRule);
        if (rs && ns) out.push(`(${rs} (${ns} (${identSnake}) @variable))`);
      }
      out.push('');
    }
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

  // ── Builtin / global / constant identifier names (by text, via #any-of?) ──
  // These are in `scopes` but are NOT grammar tokens, so they match the identifier
  // text — the standard tree-sitter idiom — never an (invalid) anonymous token.
  if (identSnake && identNameHints.length > 0) {
    out.push(';; Builtin / global / constant identifier names.');
    const byCap = new Map<string, string[]>();
    for (const { lit, cap } of identNameHints) {
      if (!byCap.has(cap)) byCap.set(cap, []);
      byCap.get(cap)!.push(lit);
    }
    for (const [cap, lits] of byCap) {
      out.push(`((${identSnake}) ${cap}`);
      out.push(`  (#any-of? ${cap} ${lits.map(jsString).join(' ')}))`);
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
  /** per-rule capture for the standard `(rule name: (ident) @cap)` query, with the
   *  triggering keyword so highlights.scm can disambiguate shared decl rules. */
  byRule: { rule: string; capture: string; keyword: string }[];
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
  const byRule: { rule: string; capture: string; keyword: string }[] = [];

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
    if (item.type === 'not') return true; // zero-width lookahead between keyword and name (e.g. type-alias)
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
          byRule.push({ rule: ruleSnake.get(ruleName)!, capture: cap, keyword: a.value });
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

// ── Structural-role detectors (tree-sitter analogues of gen-tm's per-position
//    scope inference). Each derives a rule's role from its grammar SHAPE — never a
//    hardcoded rule name — so highlights.scm can capture that node's identifiers. ──

/** Top-level alternative branches of a rule body, each as a flat item list. */
function ruleBranches(body: RuleExpr): RuleExpr[][] {
  const seqItems = (e: RuleExpr): RuleExpr[] => (e.type === 'seq' ? e.items : [e]);
  if (body.type === 'alt') return body.items.map(seqItems);
  return [seqItems(body)];
}

/** Rules whose elements are separated/placed inside `< … >` — type params and args. */
function angleTypeRules(grammar: CstGrammar): Set<string> {
  const out = new Set<string>();
  const walk = (e: RuleExpr): void => {
    if (e.type === 'seq') {
      for (let i = 0; i < e.items.length; i++) {
        if (e.items[i].type === 'literal' && (e.items[i] as { value: string }).value === '<') {
          for (let j = i + 1; j < e.items.length; j++) {
            const s = e.items[j];
            if (s.type === 'literal' && (s as { value: string }).value === '>') break;
            if (s.type === 'sep' && s.element.type === 'ref') out.add(s.element.name);
            else if (s.type === 'ref') out.add(s.name);
          }
        }
      }
      e.items.forEach(walk);
    } else if (e.type === 'alt') e.items.forEach(walk);
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') walk(e.body);
    else if (e.type === 'sep') walk(e.element);
  };
  for (const r of grammar.rules) walk(r.body);
  return out;
}

/** A single "name form": a token ref or a computed `[ Expr ]`. */
function isNameForm(item: RuleExpr, tokenNames: Set<string>): boolean {
  if (item.type === 'ref' && tokenNames.has(item.name)) return true;
  if (item.type === 'seq' && item.items.length === 3) {
    const [a, , c] = item.items;
    return a.type === 'literal' && a.value === '[' && c.type === 'literal' && c.value === ']';
  }
  return false;
}

/** Rules that are a pure alternation of name forms — the PropertyName / member-key rule. */
function propertyNameRules(grammar: CstGrammar, identName: string, tokenNames: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const r of grammar.rules) {
    if (r.body.type !== 'alt') continue; // a property-name rule is an ALTERNATION of name forms
    const items = r.body.items;          // each alternative is one name form (a computed `[Expr]` is a seq → isNameForm handles it)
    if (items.length < 2) continue;
    const allName = items.every(it => isNameForm(it, tokenNames));
    const hasIdent = items.some(it => it.type === 'ref' && it.name === identName);
    if (allName && hasIdent) out.add(r.name);
  }
  return out;
}

/** Rule(s) that are the member-list element inside a `{ … }` within a `type`-flagged
 *  rule → type-object member keys. Members may be placed by `sep`, a `*`/`+` repetition,
 *  or a bare ref, so collect the list element(s) directly between the braces. */
function typeMemberRules(grammar: CstGrammar): Set<string> {
  const ruleNames = new Set(grammar.rules.map(r => r.name));
  const typeFlagged = new Set(grammar.rules.filter(r => r.flags.includes('type')).map(r => r.name));
  const out = new Set<string>();
  // a member-list element: a rule ref directly inside `{ … }`, or one repeated via sep/quantifier.
  const addMember = (e: RuleExpr): void => {
    if (e.type === 'ref') out.add(e.name);
    else if (e.type === 'sep') addMember(e.element);
    else if (e.type === 'quantifier' || e.type === 'group') addMember(e.body);
    else if (e.type === 'seq') e.items.forEach(addMember);
  };
  const walk = (e: RuleExpr): void => {
    if (e.type === 'seq') {
      for (let i = 0; i < e.items.length; i++) {
        if (e.items[i].type === 'literal' && (e.items[i] as { value: string }).value === '{') {
          for (let j = i + 1; j < e.items.length; j++) {
            const it = e.items[j];
            if (it.type === 'literal' && (it as { value: string }).value === '}') break;
            addMember(it);
          }
        }
      }
      e.items.forEach(walk);
    } else if (e.type === 'alt') e.items.forEach(walk);
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') walk(e.body);
    else if (e.type === 'sep') walk(e.element);
  };
  for (const r of grammar.rules) if (typeFlagged.has(r.name)) walk(r.body);
  // keep only RULE members that aren't themselves type rules (a type ref isn't a member key).
  return new Set([...out].filter(n => ruleNames.has(n) && !typeFlagged.has(n)));
}

/** Rules whose EVERY branch is `[ nameRule, opt(…) ]` → exclusively value members
 *  (an enum body), as opposed to a class body that merely has such a branch among
 *  methods/accessors. Maps rule → its nameRule. */
function valueMemberRules(grammar: CstGrammar, propNameRules: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of grammar.rules) {
    const branches = ruleBranches(r.body);
    if (branches.length === 0) continue;
    let nameRule: string | null = null;
    const allValue = branches.every(b => {
      if (b.length >= 1 && b[0].type === 'ref' && propNameRules.has(b[0].name)
          && b.slice(1).every(x => x.type === 'quantifier' || x.type === 'group')) {
        nameRule = b[0].name;
        return true;
      }
      return false;
    });
    if (allValue && nameRule) out.set(r.name, nameRule);
  }
  return out;
}

/** Does the grammar have a `.`/`?.` property access (literal followed by the identifier token)? */
function hasPropertyAccess(grammar: CstGrammar, identName: string): boolean {
  let found = false;
  const walk = (e: RuleExpr): void => {
    if (e.type === 'seq') {
      for (let i = 0; i < e.items.length - 1; i++) {
        const a = e.items[i], b = e.items[i + 1];
        if (a.type === 'literal' && (a.value === '.' || a.value === '?.') && b.type === 'ref' && b.name === identName) found = true;
      }
      e.items.forEach(walk);
    } else if (e.type === 'alt') e.items.forEach(walk);
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') walk(e.body);
    else if (e.type === 'sep') walk(e.element);
  };
  for (const r of grammar.rules) walk(r.body);
  return found;
}

/** Rules with a `[ identifier, ':', ruleRef ]` branch — a `key: binding` property whose
 *  KEY is a property name. The trailing rule ref distinguishes it from a shorthand
 *  binding (`{ a }`, where the identifier IS the binding), so the capture is anchored
 *  on that element. Returns rule → the element-rule that must follow the key. */
function bindingKeyRules(grammar: CstGrammar, identName: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of grammar.rules) {
    for (const b of ruleBranches(r.body)) {
      for (let i = 0; i + 2 < b.length; i++) {
        if (b[i].type === 'ref' && (b[i] as { name: string }).name === identName
            && b[i + 1].type === 'literal' && (b[i + 1] as { value: string }).value === ':'
            && b[i + 2].type === 'ref') {
          const element = (b[i + 2] as { name: string }).name;
          // skip a self-referential value (`Stmt: Ident ':' Stmt` is a labeled statement,
          // a jump target — not a destructuring key whose value is a sub-element rule).
          if (element !== r.name) out.set(r.name, element);
        }
      }
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. src/scanner.c — external scanner
//
// The context-sensitive lexing (regex-vs-division, template interpolation holes)
// can't be expressed by tree-sitter's regex lexer alone, so it needs an external
// scanner in C. Both pieces are COMPLETE and derived purely from the grammar's
// token hints (token enum, regex flag chars, template delimiters):
//
//   • scan_regex          — scans a `/.../flags` regex-literal body. tree-sitter's
//                           LR context (`valid_symbols`) already decides regex-vs-
//                           division, so the scanner just consumes the literal.
//   • scan_template_chars — scans the literal run inside a template, stopping at
//                           the closing delimiter or at an interpolation hole, so
//                           `${ … }` holes re-enter the expression grammar (the
//                           tree-sitter analogue of gen-lexer.ts's span scan).
//
// Nothing below is language-specific: the flag characters come from the regex
// token pattern, and the template open/interp delimiters come from the template
// token's `template` hint.
// ════════════════════════════════════════════════════════════════════════════

/** Emit a C string-literal initializer for the chars of `s` (e.g. "${" → {'$','{'}). */
function cCharList(s: string): string {
  return [...s].map(c => `'${c === '\\' || c === "'" ? '\\' + c : c}'`).join(', ');
}

function buildScannerC(
  grammar: CstGrammar,
  ctx: GrammarJsContext,
  grammarName: string,
): { scannerC: string; externalTokens: string[] } {
  const regexTok = grammar.tokens.find(t => t.flags.includes('regex'));
  const tp = ctx.templatePlan;

  // Single source of truth for the enum order — MUST match grammar.js externals.
  const externalTokens = externalSymbols(ctx);

  const needScanner = externalTokens.length > 0;

  const L: string[] = [];
  L.push('// Tree-sitter external scanner generated by monogram.');
  L.push('//');
  L.push('// COMPLETE — the regex-literal scan and the template-literal scan are both');
  L.push('// wired from the grammar\'s token hints (`regexContext` and `template`).');
  L.push('//');
  L.push('// All language-specific data below is DERIVED from the CstGrammar, not');
  L.push('// hardcoded: the regex flag chars and the template delimiters all come from');
  L.push('// the grammar\'s token hints.');
  L.push('');
  L.push('#include "tree_sitter/parser.h"');
  // ts_malloc/ts_calloc/ts_free moved out of parser.h into alloc.h in tree-sitter
  // 0.25+ — include it so the external scanner links against the overridable
  // allocators (raw <stdlib.h> would also work but loses ts_set_allocator support).
  L.push('#include "tree_sitter/alloc.h"');
  L.push('#include <string.h>');
  L.push('#include <wctype.h>');
  L.push('');

  // ── Token enum (order matches grammar.js `externals`) ──
  L.push('enum TokenType {');
  for (const s of externalTokens) {
    L.push(`  ${s.toUpperCase()},`);
  }
  if (externalTokens.length === 0) L.push('  NO_EXTERNAL_TOKENS,');
  L.push('};');
  L.push('');

  // ── Scanner state ──
  // The scanner is stateless: tree-sitter's LR context (valid_symbols) tells us
  // exactly when each external token is admissible, so brace-nesting inside holes
  // is tracked by the CFG (the `template_substitution` rule), not by the scanner.
  L.push('// The scanner is stateless — tree-sitter\'s `valid_symbols` already encodes');
  L.push('// the parse context (inside a regex slot? inside a template span?), and the');
  L.push('// `${ … }` brace nesting is handled by the template_substitution rule in the');
  L.push('// CFG, so there is nothing to (de)serialize.');
  L.push('typedef struct { char unused; } Scanner;');
  L.push('');

  // ── create/destroy ──
  L.push('void *tree_sitter_' + grammarName + '_external_scanner_create(void) {');
  L.push('  return ts_calloc(1, sizeof(Scanner));');
  L.push('}');
  L.push('');
  L.push('void tree_sitter_' + grammarName + '_external_scanner_destroy(void *payload) {');
  L.push('  ts_free(payload);');
  L.push('}');
  L.push('');

  // ── serialize/deserialize ──
  L.push('unsigned tree_sitter_' + grammarName + '_external_scanner_serialize(void *payload, char *buffer) {');
  L.push('  (void)payload; (void)buffer;');
  L.push('  return 0;');
  L.push('}');
  L.push('');
  L.push('void tree_sitter_' + grammarName + '_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {');
  L.push('  (void)payload; (void)buffer; (void)length;');
  L.push('}');
  L.push('');

  // ── helpers: advance ──
  L.push('static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }');
  L.push('static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }');
  L.push('');

  const nl = grammar.newline;
  if (nl) {
    const nlSym = ctx.scannerTokenFor.get(nl.token)!.toUpperCase();
    L.push('// ── Newline scan ────────────────────────────────────────────────');
    L.push('// A newline-sensitive grammar emits one NEWLINE token at each significant line');
    L.push('// boundary. tree-sitter only asks for it where the grammar permits it (statement');
    L.push('// boundaries); inside flow delimiters the rules never reference NEWLINE, so');
    L.push('// valid_symbols[NEWLINE] is false there and the line break falls through to');
    L.push('// `extras` as ordinary whitespace. Stateless: one line break (\\n / \\r / \\r\\n) per token.');
    L.push('static bool scan_newline(TSLexer *lexer) {');
    L.push('  if (lexer->lookahead == \'\\r\') { advance(lexer); if (lexer->lookahead == \'\\n\') advance(lexer); }');
    L.push('  else if (lexer->lookahead == \'\\n\') advance(lexer);');
    L.push('  else return false;');
    L.push(`  lexer->result_symbol = ${nlSym};`);
    L.push('  lexer->mark_end(lexer);');
    L.push('  return true;');
    L.push('}');
    L.push('');
  }

  if (regexTok) {
    // Derive the regex literal scan from the token pattern + hints.
    const flagChars = tokenPatternTrailingCharClass(regexTok) ?? 'gimsuyd';
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

  if (tp) {
    const charsSym = tp.charsSnake.toUpperCase();
    const openChars = cCharList(tp.open);
    const interpFirst = tp.interpOpen[0];        // the char that may begin a hole ('$')
    L.push('// ── Template-literal scan ───────────────────────────────────────');
    L.push('// Scans the literal run of characters inside a template, stopping just');
    L.push('// before the closing delimiter or before an interpolation hole, so a');
    L.push('// `${ … }` hole re-enters the expression grammar (mirrors gen-lexer.ts\'s');
    L.push('// scanTemplateSpan). The closing delimiter, the hole opener, and the hole');
    L.push('// closer are ordinary anonymous tokens matched by the CFG.');
    L.push('//');
    L.push(`// Template delimiters (derived from the grammar's template hint):`);
    L.push(`//   open        = ${jsString(tp.open)}`);
    L.push(`//   interpOpen  = ${jsString(tp.interpOpen)}`);
    L.push(`//   interpClose = ${jsString(tp.interpClose)}`);
    // The hole opener is at least one char (`$`); when it is multi-char (`${`) a
    // lone first char (`$` not followed by `{`) is literal text. We mark_end at the
    // top of every iteration so the emitted token always excludes a hole opener we
    // only peeked into — the proven tree-sitter-javascript pattern.
    const interpSecond = tp.interpOpen.length > 1 ? tp.interpOpen[1] : null;
    L.push('static bool scan_template_chars(TSLexer *lexer) {');
    L.push(`  const char open[] = {${openChars}};`);
    L.push('  bool has_content = false;');
    L.push('  for (;;) {');
    L.push('    // Freeze the token end here; any char we merely PEEK past below (a hole');
    L.push('    // opener) is then excluded from the emitted token.');
    L.push('    lexer->mark_end(lexer);');
    L.push('    int32_t c = lexer->lookahead;');
    L.push('    if (c == 0) return false; // EOF — let the CFG report the unterminated template');
    L.push('    // Closing delimiter: stop before it (it is an anonymous token).');
    L.push('    if (c == open[0]) break;');
    L.push(`    // Interpolation hole opener (interpOpen ${jsString(tp.interpOpen)}).`);
    L.push(`    if (c == '${interpFirst}') {`);
    if (interpSecond !== null) {
      // Multi-char opener: only a real `${` stops the run; a lone `$` is content.
      L.push('      advance(lexer); // past the opener\'s first char (peek)');
      L.push(`      if (lexer->lookahead == '${interpSecond}') break; // a real hole opener`);
      L.push('      has_content = true; // lone first char → literal text, keep scanning');
      L.push('      continue;');
    } else {
      L.push('      break; // single-char hole opener');
    }
    L.push('    }');
    L.push('    // Backslash escape: consume `\\` + next so an escaped delimiter stays literal.');
    L.push('    if (c == \'\\\\\') {');
    L.push('      advance(lexer);');
    L.push('      if (lexer->lookahead != 0) advance(lexer);');
    L.push('      has_content = true;');
    L.push('      continue;');
    L.push('    }');
    L.push('    advance(lexer);');
    L.push('    has_content = true;');
    L.push('  }');
    L.push('  if (!has_content) return false; // zero-width: let `${` / closing delimiter match');
    L.push(`  lexer->result_symbol = ${charsSym};`);
    L.push('  return true; // token end already frozen by the last mark_end');
    L.push('}');
    L.push('');
  }

  // ── Interpolated-string char scanners (one per string token carrying interpolation) ──
  // Each scans the literal run inside the string, stopping before the close delimiter or any
  // interpolation opener (so the opener re-enters the expression grammar via its sub-rule). The
  // openers are DATA from the interpolation metadata (decoded literals, length 1–2).
  {
    const cChar = (ch: string) => ch === '\\' ? "'\\\\'" : ch === "'" ? "'\\''" : `'${ch}'`;
    for (const ip of ctx.interpolationPlans) {
      const charsSym = ip.charsSnake.toUpperCase();
      const up = ip.ruleSnake.toUpperCase();
      const openerInit = ip.regions.map(r => jsString(r.open)).join(', ');
      L.push(`// ── Interpolated-string scan (${ip.tokenName}): literal text up to the close delim or an opener ──`);
      L.push(`static const char *${up}_OPENERS[] = { ${openerInit} };`);
      L.push(`static const unsigned ${up}_OPENER_COUNT = ${ip.regions.length};`);
      L.push(`static bool scan_${ip.ruleSnake}_chars(TSLexer *lexer) {`);
      L.push('  bool has_content = false;');
      L.push('  for (;;) {');
      L.push('    lexer->mark_end(lexer);');
      L.push('    int32_t c = lexer->lookahead;');
      L.push('    if (c == 0) return false; // EOF — let the CFG report the unterminated string');
      L.push(`    if (c == ${cChar(ip.close)}) break; // closing delimiter`);
      L.push('    bool first_match = false;');
      L.push(`    for (unsigned i = 0; i < ${up}_OPENER_COUNT; i++) if ((int32_t)${up}_OPENERS[i][0] == c) { first_match = true; break; }`);
      L.push('    if (first_match) {');
      L.push('      advance(lexer);                 // peek past the opener\'s first char');
      L.push('      int32_t c2 = lexer->lookahead;');
      L.push('      bool real = false;');
      L.push(`      for (unsigned i = 0; i < ${up}_OPENER_COUNT; i++)`);
      L.push(`        if ((int32_t)${up}_OPENERS[i][0] == c && (${up}_OPENERS[i][1] == 0 || (int32_t)${up}_OPENERS[i][1] == c2)) { real = true; break; }`);
      L.push('      if (real) break;                // a real opener — token ends before it (mark_end frozen above)');
      L.push('      has_content = true; continue;   // lone first char → literal content');
      L.push('    }');
      L.push('    if (c == \'\\\\\') { advance(lexer); if (lexer->lookahead != 0) advance(lexer); has_content = true; continue; }');
      L.push('    advance(lexer);');
      L.push('    has_content = true;');
      L.push('  }');
      L.push('  if (!has_content) return false;');
      L.push(`  lexer->result_symbol = ${charsSym};`);
      L.push('  return true;');
      L.push('}');
      L.push('');
    }
  }

  // ── scan() entry ──
  L.push('bool tree_sitter_' + grammarName + '_external_scanner_scan(void *payload, TSLexer *lexer,');
  L.push('                                                          const bool *valid_symbols) {');
  L.push('  (void)payload;');
  L.push('');
  if (grammar.newline) {
    const nlSym = ctx.scannerTokenFor.get(grammar.newline.token)!.toUpperCase();
    L.push('  // Newline first: a significant line boundary outranks every other external token.');
    L.push(`  if (valid_symbols[${nlSym}] && (lexer->lookahead == '\\n' || lexer->lookahead == '\\r')) {`);
    L.push('    if (scan_newline(lexer)) return true;');
    L.push('  }');
    L.push('');
  }
  if (tp && regexTok) {
    const charsSym = tp.charsSnake.toUpperCase();
    const regexSym = ctx.scannerTokenFor.get(regexTok.name)!.toUpperCase();
    L.push('  // Error-recovery sentinel: tree-sitter marks EVERY external valid when it is');
    L.push('  // guessing. The regex slot (expression start) and a template-chars slot');
    L.push('  // (inside a template) are never both genuinely valid at once, so treat that');
    L.push('  // combination as recovery and decline — the regular lexer takes over.');
    L.push(`  if (valid_symbols[${charsSym}] && valid_symbols[${regexSym}]) return false;`);
    L.push('');
  }
  if (tp) {
    const charsSym = tp.charsSnake.toUpperCase();
    L.push('  // Template chars run first: whitespace INSIDE a template is literal text,');
    L.push('  // so it must NOT be skipped (unlike the regex path below).');
    L.push(`  if (valid_symbols[${charsSym}]) {`);
    L.push('    if (scan_template_chars(lexer)) return true;');
    L.push('  }');
    L.push('');
  }
  if (regexTok) {
    const regexSym = ctx.scannerTokenFor.get(regexTok.name)!.toUpperCase();
    L.push('  // Skip leading whitespace (the regular lexer normally does this, but the');
    L.push('  // external scanner runs first when any external symbol is valid).');
    L.push(`  if (valid_symbols[${regexSym}]) {`);
    L.push('    while (iswspace(lexer->lookahead)) skip(lexer);');
    L.push('    if (lexer->lookahead == \'/\') {');
    L.push('      if (scan_regex(lexer)) return true;');
    L.push('    }');
    L.push('  }');
    L.push('');
  }
  for (const ip of ctx.interpolationPlans) {
    const charsSym = ip.charsSnake.toUpperCase();
    L.push(`  // ${ip.tokenName} interpolated-string literal text (whitespace inside is content, not skipped).`);
    L.push(`  if (valid_symbols[${charsSym}]) {`);
    L.push(`    if (scan_${ip.ruleSnake}_chars(lexer)) return true;`);
    L.push('  }');
    L.push('');
  }
  L.push('  return false;');
  L.push('}');
  L.push('');

  void needScanner;
  return { scannerC: L.join('\n'), externalTokens };
}
