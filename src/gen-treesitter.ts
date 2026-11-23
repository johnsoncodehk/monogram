import type { CstGrammar, RuleExpr, RuleDecl, TokenPattern } from './types.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';
import { buildLr, END, type LeafGraph, type LrAnalysis } from './lr-automaton.ts';
import { info as tokenPatternInfo, type CSet } from './lex-match-plan.ts';
import { tokenPatternFirstCharSet, type TokenPatternFirstSet, tokenPatternIsNever, tokenPatternLiteralPrefix, tokenPatternLiteralPrefixes, tokenPatternSource, tokenPatternStartsWithDecimal, tokenPatternStringDelimiters, tokenPatternTrailingCharClass } from './token-pattern.ts';

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
  /** tree-sitter.json source (see buildTreeSitterJson: it selects ABI 15) */
  treeSitterJson: string;
  /** names of the external tokens the scanner provides (empty if none needed) */
  externalTokens: string[];
  /** Every zero-width assertion of the grammar's rule trees (as tree-sitter sees them: the relaxed
   *  side of a tsRelax group), one record per occurrence, with how grammar.js renders it. A CFG has
   *  no lookahead, so only `lowered` is rendered; every other class is dropped, and the class says
   *  whether that drop is exact. See classifyAssertions. */
  assertions: AssertionRecord[];
  /** The keywords the generated grammar reads both as the keyword and as the word token (contextual
   *  keywords: renderWordStep). Absent for a grammar without a word token. */
  contextualKeywords?: string[];
}

/** How grammar.js renders a zero-width assertion. `reserved-set`: a one-token exclusion of word-shaped
 *  literals directly before the word token, rendered as a tree-sitter reserved word set on that token
 *  (see planReservedSets): exact in every parse state that shifts no differently-reserved word token;
 *  where one does, tree-sitter applies ONE set per state (the highest id), and the sets are ordered so
 *  that the less reserving reading wins, so it never rejects more than the grammar. Exact: `lowered` (rendered by a CFG rewrite),
 *  `vacuous` (FIRST/FOLLOW prove the assertion holds wherever the CFG reaches it, so dropping it
 *  changes nothing). Every other class is DROPPED and the generated grammar may accept more than the
 *  grammar does; the class names the lowering that would make it exact:
 *  - `scanner`: a line-terminator / comment / flow-state condition, lowerable to an external scanner
 *    token that sees the skipped text (tree-sitter-javascript's `_automatic_semicolon` technique);
 *  - `reserved`: one-token exclusion of identifier-shaped literals before the `word` token that is
 *    not rendered as a reserved word set (see `reserved-set`);
 *  - `lookahead1`: one-token lookahead over any other continuation (no tree-sitter primitive; exact
 *    only by a FIRST-restricted copy of the continuation, which planFirstFilters builds for a
 *    POSITIVE one; a negative one would copy nearly the whole continuation: every negative condition
 *    copied measured JavaScript ×1.94 / TypeScript ×2.03 LALR table entries, so it stays dropped);
 *  - `lookahead`: a lookahead over more than one token or a nested assertion: not expressible;
 *  - `left-context`: a predicate on the left operand's head leaf (notLeftLeaf): not expressible. */
export type AssertionClass = 'lowered' | 'vacuous' | 'reserved-set' | 'scanner' | 'reserved' | 'lookahead1' | 'lookahead' | 'left-context';
export const EXACT_ASSERTION_CLASSES: readonly AssertionClass[] = ['lowered', 'vacuous'];
export interface AssertionRecord {
  /** grammar rule whose tree holds the assertion */
  rule: string;
  kind: 'not' | 'sameLine' | 'noCommentBefore' | 'noMultilineFlowBefore' | 'notLeftLeaf';
  cls: AssertionClass;
  /** the assertion, written compactly (`not("{" | Ident)`), cut at 160 characters */
  text: string;
}

function assertionText(e: RuleExpr): string {
  const f = (x: RuleExpr): string => {
    switch (x.type) {
      case 'literal': return JSON.stringify(x.value);
      case 'ref': return x.name;
      case 'seq': return x.items.length === 1 ? f(x.items[0]) : `[${x.items.map(f).join(' ')}]`;
      case 'alt': return `(${x.items.map(f).join(' | ')})`;
      case 'quantifier': return f(x.body) + x.kind;
      case 'group': return f(x.tsRelaxed ?? x.body);
      case 'sep': return `sep(${f(x.element)}, ${JSON.stringify(x.delimiter)})`;
      case 'not': return `not(${f(x.body)})`;
      case 'notLeftLeaf': return `notLeftLeaf(${x.words.join(' ')})`;
      default: return x.type;
    }
  };
  const t = f(e);
  return t.length > 160 ? t.slice(0, 157) + '...' : t;
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
  /** planZeroWidth: the line-break assertions rendered as zero-width external tokens. */
  zeroWidth: ZeroWidthPlan;
  /** original token name → external scanner token name (snake) if scanner-provided */
  scannerTokenFor: Map<string, string>;
  /** flow-delimiter LITERAL char (`[` `]` `{` `}`) → synthetic external scanner token (snake). These
   *  bare literals in the flow rules are swapped for refs to the scanner token (renderExpr). Empty for
   *  non-flow grammars. See flowSyntheticTokens. */
  flowLiteralTokens: Map<string, string>;
  /** Non-start rules whose body can derive the empty string. tree-sitter rejects these, so their
   *  bodies are made non-empty and every reference to them is wrapped in optional() (ε-elimination,
   *  see makeNonEmpty / wrapNullableRefs). Empty for grammars with no nullable non-start rules. */
  nullableNonStart: Set<string>;
  /** FIRST/FOLLOW terminal sets of the tree-sitter view of the grammar (see greedyTail). */
  terminalSets: TerminalSets;
  /** Rules declared as a conflict of their own (`[$.rule]`): GLR keeps every parse of their
   *  productions, so no static resolution is added to them. Set when conflicts are emitted. */
  glrRules: Set<string>;
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
  /**
   * Shared rules extracted from tsRelax(..., ruleName) groups: name → relaxed body. The body
   * is emitted ONCE as a rule and every reference renders as `$.<name>`, so a tree-sitter-only
   * relaxed form is SHARED across all its use sites instead of inlined (and duplicated) at each
   * — the difference is large for a rule used in many type positions (the fn-type/method param,
   * issue #46). Visibility follows tree-sitter's `_`-prefix convention. Empty when the grammar
   * uses no named tsRelax.
   */
  tsSharedRules: Map<string, RuleExpr>;
  /** Every assertion node classifyAssertions saw. renderExpr refuses one it did not (an assertion
   *  reached by no classified path would be dropped without a record). */
  classifiedAssertions: Set<RuleExpr>;
  /** The word token (keyword extraction) and the reserved word sets its guards render to. With no
   *  set, no word step is wrapped (the grammar.js of a grammar without such guards is unchanged). */
  reserved: { word: string | undefined; isWordLiteral: (text: string) => boolean; plan: ReservedSets };
  /** Every literal renderExpr wrote into a rule. A reserved word must be a token of the generated
   *  grammar (tree-sitter: "Reserved word 'enum' must be a token"); a word no rule writes gets a
   *  token rule of its own (buildGrammarJs). */
  renderedLiterals: Set<string>;
  /** The one-token lookaheads rendered as FIRST-filtered copies: a reference to a copy renders as
   *  `alias($._copy, $.original)`. */
  firstFilters: FirstFilterPlan;
  /** collectWordLiterals: the keywords of the generated grammar. */
  wordLiterals: string[];
  /** planContextualWords: per word-token step, the keywords it also reads as a name, and the
   *  conflicts that adds. Null for a grammar without a word token or keywords. */
  contextual: ContextualPlan | null;
  /** The `_names_<n>` rule of each keyword set (namesKey), filled as word steps render. */
  namesRules: Map<string, string>;
  /** The keywords given both readings (buildGrammarJs fills it). */
  bothReadings: string[];
}

function hasMarker(expr: RuleExpr): boolean {
  if (expr.type === 'op' || expr.type === 'prefix' || expr.type === 'postfix') return true;
  if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(hasMarker);
  if (expr.type === 'quantifier' || expr.type === 'group') return hasMarker(expr.body);
  if (expr.type === 'sep') return hasMarker(expr.element);
  return false;
}

/** Pre-scan every rule body for named tsRelax groups (`tsRuleName`), collecting name → relaxed
 *  body. Done before conflicts/rules are emitted so the shared rule names are known to
 *  deriveConflicts (a declared tuple may name one) and the bodies can be emitted as shared rules. */
function collectTsSharedRules(grammar: CstGrammar): Map<string, RuleExpr> {
  const out = new Map<string, RuleExpr>();
  const walk = (e: RuleExpr): void => {
    switch (e.type) {
      case 'group':
        if (e.tsRuleName && !out.has(e.tsRuleName)) out.set(e.tsRuleName, e.tsRelaxed ?? e.body);
        // Walk the relaxed subtree (what tree-sitter actually emits), not the strict body.
        walk(e.tsRelaxed ?? e.body); break;
      case 'seq': case 'alt': e.items.forEach(walk); break;
      case 'quantifier': walk(e.body); break;
      case 'sep': walk(e.element); break;
    }
  };
  for (const r of grammar.rules) walk(r.body);
  return out;
}

// ── Lowering `not(L)` before an optional `L…` continuation ──────────────────
// A tree-sitter CFG has no lookahead, so `not` renders to `blank()`. One shape is still exactly
// expressible: an item that ENDS in `not(L)` followed, in the same seq, by an optional item every
// non-empty match of which STARTS with literal L. After the assertion that item can only match
// empty, so it is dropped from the asserting branch. When the asserting item is an `alt`, its
// asserting arms are split into a sibling seq so the continuation stays for the other arms:
//   seq(alt(A, [':', V, not(':')]), opt(':', W))  →  choice(seq(alt(A), opt(':', W)), seq(':', V))
// (YAML FlowMapEntry: without this the empty-key arm takes a second `: value`, `{: a : b}`.)
function notLiteral(e: RuleExpr): string | null {
  return e.type === 'not' && e.body.type === 'literal' ? e.body.value : null;
}
function endsInNot(e: RuleExpr): string | null {
  const n = endingNot(e);
  return n ? notLiteral(n) : null;
}
function endingNot(e: RuleExpr): RuleExpr | null {
  if (e.type === 'seq') return e.items.length ? endingNot(e.items[e.items.length - 1]) : null;
  return notLiteral(e) !== null ? e : null;
}
function startsWithLiteral(e: RuleExpr, lit: string): boolean {
  if (e.type === 'literal') return e.value === lit;
  if (e.type === 'seq') return e.items.length > 0 && startsWithLiteral(e.items[0], lit);
  if (e.type === 'alt') return e.items.length > 0 && e.items.every(i => startsWithLiteral(i, lit));
  if (e.type === 'group') return startsWithLiteral(e.tsRelaxed ?? e.body, lit);
  return false;
}
function optionalStartingWith(e: RuleExpr, lit: string): boolean {
  return e.type === 'quantifier' && e.kind !== '+' && startsWithLiteral(e.body, lit);
}
/** `onGuard` receives each `not` node the lowering makes exact. */
function lowerNotBeforeOptional(expr: RuleExpr & { type: 'seq' }, onGuard?: (guard: RuleExpr) => void): RuleExpr | null {
  const items = expr.items;
  for (let i = 0; i + 1 < items.length; i++) {
    const item = items[i], next = items[i + 1];
    const direct = notLiteral(item);
    if (direct !== null && optionalStartingWith(next, direct)) {
      onGuard?.(item);
      return { type: 'seq', items: [...items.slice(0, i + 1), ...items.slice(i + 2)] };
    }
    if (item.type !== 'alt') continue;
    const guarded = item.items.filter(a => { const l = endsInNot(a); return l !== null && optionalStartingWith(next, l); });
    if (guarded.length === 0) continue;
    for (const a of guarded) onGuard?.(endingNot(a)!);
    const plain = item.items.filter(a => !guarded.includes(a));
    const pre = items.slice(0, i);
    const guardedSeq: RuleExpr = { type: 'seq', items: [...pre, guarded.length === 1 ? guarded[0] : { type: 'alt', items: guarded }, ...items.slice(i + 2)] };
    if (plain.length === 0) return guardedSeq;
    const plainSeq: RuleExpr = { type: 'seq', items: [...pre, plain.length === 1 ? plain[0] : { type: 'alt', items: plain }, ...items.slice(i + 1)] };
    return { type: 'alt', items: [plainSeq, guardedSeq] };
  }
  return null;
}

/**
 * Render a non-Pratt RuleExpr to a tree-sitter DSL expression string.
 * Pratt markers (op/prefix/postfix) are handled separately by buildPrattRule,
 * so a bare marker here renders to a harmless `blank()` (it never actually
 * appears outside a Pratt rule in practice).
 */
/** A literal token written into a rule (every rule-body literal goes through here: renderedLiterals). */
function ruleLiteral(text: string, ctx: GrammarJsContext): string {
  ctx.renderedLiterals.add(text);
  return jsString(text);
}

// ── contextual keywords ──
// The interpreter's word token reads every word, and a literal matches a word by its text, so a keyword
// the grammar writes (`static`, `type`, `of`, …) is also a name wherever no guard excludes it.
// tree-sitter's keyword extraction lexes such a word as the KEYWORD in every state where the keyword is
// valid, so the name reading of the same text is lost there (`class C { static() {} }`). The name
// reading is rendered where the two can meet, and the parser forks between them (GLR):
//   - a word-token step planContextualWords gives keywords renders as `choice(<word token>, $._names_<n>)`;
//   - `_names_<n>` is one rule per distinct keyword set: the keywords aliased to the word token's node,
//     at dynamic precedence -1 (where both readings parse, the keyword's is kept). A keyword stays the
//     plain string everywhere else, so the reading costs one symbol per set and one goto per state;
//   - after a keyword K, the parser holds the items that read K as the keyword and the `_names_<n>`
//     items that reduce it: their conflicts are derived from the same automaton (contextualConflicts)
//     and every tuple names a `_names_<n>`, so it covers no conflict without a name reading.

/** The words a guard directly before a word-token step excludes there, and the reserved set it renders
 *  to (null: none renders, the step is `unreserved`). */
interface WordGuard { set: string | null; words: string[] }

/** The keyword-set key of a `_names_<n>` rule. */
const namesKey = (words: readonly string[]) => words.join(' ');

/** A word-token step: the word token under its reserved set, or a keyword the plan gives the step,
 *  read as the word token. */
function renderWordStep(node: RuleExpr, ref: string, guard: WordGuard | undefined, ctx: GrammarJsContext): string {
  const word = ctx.reserved.plan.sets.length ? `reserved(${jsString(guard?.set ?? UNRESERVED_SET)}, ${ref})` : ref;
  if (!ctx.contextual) return word;
  const words = ctx.contextual.plan.get(node);
  if (!words) throw new Error('gen-treesitter: a word-token step planContextualWords did not reach');
  if (words.length === 0) return word;
  const key = namesKey(words);
  let name = ctx.namesRules.get(key);
  if (!name) ctx.namesRules.set(key, name = `_names_${ctx.namesRules.size + 1}`);
  return `choice(${word}, $.${name})`;
}

// ── which keywords a word-token step must also read as a name (planContextualWords) ──
// tree-sitter lexes a keyword's text as the word token in every state where the keyword is not valid,
// so a word step needs to read K as a name only where K is ALSO valid in a state that shifts the step:
// as a shift, or as the lookahead of a reduction there. That is asked of the LR automaton of the
// generated grammar (treeSitterLeafGraph, with the zero-width tokens as terminals: lr-automaton.ts):
// every LR(1) state tree-sitter builds has the item core of one of its states, and a reduction's
// lookahead there is within that core's LALR(1) lookahead, so the sets are a superset (sound: a keyword
// left out of a step would be an ERROR on valid code). The answer feeds back (a step that reads K as a
// name makes K valid in its states, and a K shift advances it), so the automaton is rebuilt until no
// set grows. A keyword the guard before a step excludes (a reserved word there) is never given to it,
// and a step node rendered at several leaves (a shared subtree) has one set for all of them.
interface ContextualPlan {
  /** Per word-token step node: the keywords it also reads as a name (sorted; empty: none). */
  plan: Map<RuleExpr, string[]>;
  /** The conflicts the name readings add, each sorted: `{ names: key }` a `_names_<n>` rule by its
   *  keyword set, `{ rule }` a rule of the generated grammar by its name in the leaf graph. */
  conflicts: ConflictVar[][];
}

/** Per word-token step node: the words the guards right before it exclude (reservedGuardWords of every
 *  `not` in front of it, through the other zero-width items there). A step without one is absent. */
function wordStepGuards(grammar: CstGrammar, word: string | undefined, isWordLiteral: (text: string) => boolean): Map<RuleExpr, Set<string>> {
  const out = new Map<RuleExpr, Set<string>>();
  const seen = new Set<RuleExpr>();
  const walk = (e: RuleExpr): void => {
    e = tsView(e);
    if (seen.has(e)) return;
    seen.add(e);
    if (e.type === 'seq') {
      e.items.forEach((item, i) => {
        if (item.type !== 'not') return;
        let j = i + 1;
        while (j < e.items.length && ASSERTION_KINDS.has(tsView(e.items[j]).type)) j++;
        const ws = reservedGuardWords(item, e.items[j], word, isWordLiteral);
        if (!ws) return;
        const step = tsView(e.items[j]);
        const s = out.get(step) ?? out.set(step, new Set()).get(step)!;
        for (const w of ws) s.add(w);
      });
      e.items.forEach(walk);
    } else if (e.type === 'alt') e.items.forEach(walk);
    else if (e.type === 'quantifier') walk(e.body);
    else if (e.type === 'sep') walk(e.element);
  };
  for (const r of grammar.rules) walk(r.body);
  for (const b of collectTsSharedRules(grammar).values()) walk(b);
  return out;
}

function planContextualWords(grammar: CstGrammar, graph: TsLeafGraph, word: string, words: string[],
  isWordLiteral: (text: string) => boolean): ContextualPlan {
  // The words a guard before each word step excludes (wordStepGuards), keyed by the step's node.
  const exclOf = new Map<RuleExpr, Set<string>>([...wordStepGuards(grammar, word, isWordLiteral)].map(([n, ws]) => [n, new Set(ws)]));
  const exclude = (node: RuleExpr, ws: Iterable<string>) => { const s = exclOf.get(node) ?? exclOf.set(node, new Set()).get(node)!; for (const w of ws) s.add(w); };
  // A step that is a whole alternative by itself (zero-width guards, then the word token) never reads a
  // keyword K that an EARLIER alternative of the same choice always matches alone (`'K'`, or `'K'`
  // with only optional parts after it): the interpreter's choice keeps the earlier one, by longest
  // match (it is at least as long; a tie goes to the earlier) or by ordered choice (it matches first).
  // So `this` / `true` / … listed before the identifier atom are never an identifier there. A node
  // the grammar shares between several places is shadowed only by what every place shadows, and not
  // at all when one of its places is no such alternative.
  const shadowedAt = new Map<RuleExpr, Map<RuleExpr, Set<string>>>();
  const parents = new Map<RuleExpr, Set<RuleExpr>>();
  const noteParent = (child: RuleExpr, parent: RuleExpr) => { const c = tsView(child); (parents.get(c) ?? parents.set(c, new Set()).get(c)!).add(parent); };
  const wordStep = (e: RuleExpr): RuleExpr | null => {
    const v = tsView(e);
    if (v.type === 'ref') return v.name === word && v.hole === undefined ? v : null;
    if (v.type !== 'seq' || !v.items.length) return null;
    const last = tsView(v.items[v.items.length - 1]);
    return last.type === 'ref' && last.name === word && v.items.slice(0, -1).every(i => ASSERTION_KINDS.has(tsView(i).type)) ? last : null;
  };
  const matchesWordAlone = (e: RuleExpr): string[] => {
    const v = tsView(e);
    if (v.type === 'literal') return isWordLiteral(v.value) ? [v.value] : [];
    if (v.type === 'alt') return v.items.flatMap(matchesWordAlone);
    if (v.type !== 'seq' || !v.items.length) return [];
    const first = tsView(v.items[0]);
    const optionalRest = v.items.slice(1).every(i => { const t = tsView(i); return t.type === 'quantifier' && t.kind !== '+'; });
    return first.type === 'literal' && isWordLiteral(first.value) && optionalRest ? [first.value] : [];
  };
  const seen = new Set<RuleExpr>();
  const markGuards = (e: RuleExpr): void => {
    e = tsView(e);
    if (seen.has(e)) return;
    seen.add(e);
    if (e.type === 'seq' || e.type === 'alt') for (const i of e.items) noteParent(i, e);
    else if (e.type === 'quantifier') noteParent(e.body, e);
    else if (e.type === 'sep') noteParent(e.element, e);
    if (e.type === 'seq') e.items.forEach(markGuards);
    else if (e.type === 'alt') {
      const earlier = new Set<string>();
      for (const item of e.items) {
        const step = wordStep(item);
        if (step) (shadowedAt.get(step) ?? shadowedAt.set(step, new Map()).get(step)!).set(e, new Set(earlier));
        for (const w of matchesWordAlone(item)) earlier.add(w);
      }
      e.items.forEach(markGuards);
    } else if (e.type === 'quantifier') markGuards(e.body);
    else if (e.type === 'sep') markGuards(e.element);
  };
  for (const r of grammar.rules) markGuards(r.body);
  for (const b of collectTsSharedRules(grammar).values()) markGuards(b);
  for (const [step, byAlt] of shadowedAt) {
    // The step's places: its choices directly, or through the one guard sequence that holds it.
    const ps = [...parents.get(step) ?? []];
    const places = ps.length === 1 && ps[0].type === 'seq' ? [...parents.get(ps[0]) ?? []] : ps;
    if (!places.length || !places.every(p => byAlt.has(p))) continue;
    const sets = places.map(p => byAlt.get(p)!);
    exclude(step, [...sets[0]].filter(w => sets.every(s => s.has(w))));
  }
  const steps: number[] = [];
  for (let l = 0; l < graph.sym.length; l++) if (graph.sym[l] === word && graph.nt[l] < 0) steps.push(l);
  const isStep = new Uint8Array(graph.sym.length);
  for (const l of steps) isStep[l] = 1;
  // One set per step node, shared by its leaves.
  const setOfNode = new Map<RuleExpr | null, Set<string>>();
  const allowed = new Map<number, Set<string>>();
  for (const l of steps) {
    const n = graph.node[l];
    let s = n ? setOfNode.get(n) : undefined;
    if (!s) { s = new Set(); if (n) setOfNode.set(n, s); }
    allowed.set(l, s);
  }
  const keywords = words.map(w => [w, `'${w}`] as const);
  const alsoShifts = (l: number) => isStep[l] ? [...allowed.get(l)!].map(w => `'${w}`) : [];
  let lr = buildLr(graph, { alsoShifts });
  for (;;) {
    let grew = false;
    lr.states.forEach((st, s) => {
      const here = st.next.filter(l => isStep[l]);
      if (!here.length) return;
      const valid = lr.valid(s);
      for (const l of here) {
        const a = allowed.get(l)!, ex = graph.node[l] && exclOf.get(graph.node[l]!);
        for (const [w, t] of keywords) if (valid.has(t) && !a.has(w) && !ex?.has(w)) { a.add(w); grew = true; }
      }
    });
    if (!grew) break;
    lr = buildLr(graph, { alsoShifts });
  }
  const plan = new Map<RuleExpr, string[]>();
  for (const l of steps) if (graph.node[l]) plan.set(graph.node[l]!, [...allowed.get(l)!].sort());

  // The conflicts the name readings add: those of the automaton with them that the automaton without
  // them (the grammar as it was, whose conflicts the grammar declares) does not have.
  const before = conflictTuples(graph, buildLr(graph), () => [], () => null);
  const after = conflictTuples(graph, lr, alsoShifts, (l, w) => isStep[l] && allowed.get(l)!.has(w) ? namesKey([...allowed.get(l)!].sort()) : null);
  return { plan, conflicts: [...after].filter(([k]) => !before.has(k)).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([, t]) => t) };
}

// ── the conflicts of an automaton (conflictTuples) ──
// tree-sitter names a conflict by the rules of its items: every item of the state that shifts the
// lookahead (past its first step), and every item that reduces on it, a repetition's helper rule
// counted as the rule that holds it; the grammar must declare exactly that set. A name reading adds
// items of one shape: after a keyword K, `_names_<n>` items that reduce K for the steps that read it as
// a name (`namesOf`: the set of a step leaf advanced by K, else null). For each state of the automaton
// and each lookahead, the shifting rules are exact (they follow from the item core) and the reducing
// ones are the LALR(1) union over the LR(1) states of that core, where any part of them may reduce on
// that lookahead: so every tuple of the shifting rules and a part of the reducing ones with two actions
// is listed (a part tree-sitter does not meet is reported by it as an unnecessary conflict, never
// missed). Whether precedence resolves one is left to tree-sitter: it consults the declared conflicts
// only for what precedence leaves.
type ConflictVar = { names: string } | { rule: string };
function conflictTuples(graph: TsLeafGraph, lr: LrAnalysis, alsoShifts: (leaf: number) => string[],
  namesOf: (leaf: number, keyword: string) => string | null): Map<string, ConflictVar[]> {
  const firstOfRule = new Map<number, Set<string>>();
  const firstOf = (r: number): Set<string> => {
    let out = firstOfRule.get(r);
    if (out) return out;
    firstOfRule.set(r, out = new Set());
    const seenL = new Set<number>();
    const go = (ls: number[]) => {
      for (const x of ls) {
        if (seenL.has(x)) continue; seenL.add(x);
        const n = graph.nt[x];
        if (n < 0) { out!.add(graph.sym[x]); for (const t of alsoShifts(x)) out!.add(t); continue; }
        go(graph.first[n]);
        if (graph.nullable[n]) go(graph.follow[x]);
      }
    };
    go(graph.first[r]);
    return out;
  };
  // The terminals that may come next after a leaf in its rule (through nullable rules), and whether
  // its rule may end there.
  const nextMemo = new Map<number, { terms: Set<string>; end: boolean }>();
  const nextOf = (l: number) => {
    let r = nextMemo.get(l);
    if (r) return r;
    const terms = new Set<string>(); let end = graph.isLast[l];
    const seenL = new Set<number>();
    const go = (ls: number[]) => {
      for (const x of ls) {
        if (seenL.has(x)) continue; seenL.add(x);
        const n = graph.nt[x];
        if (n < 0) { terms.add(graph.sym[x]); for (const t of alsoShifts(x)) terms.add(t); continue; }
        for (const t of firstOf(n)) terms.add(t);
        if (graph.nullable[n]) { go(graph.follow[x]); if (graph.isLast[x]) end = true; }
      }
    };
    go(graph.follow[l]);
    nextMemo.set(l, r = { terms, end });
    return r;
  };
  const out = new Map<string, ConflictVar[]>();
  const done = new Set<string>();
  const laMemo = new Map<number, Map<number, Set<string>>>();
  lr.states.forEach(st => {
    for (const [sym, to] of st.goto) {
      // A state is read once per kind of entry: by a keyword (its steps then reduce a `_names_<n>`), or
      // by anything else.
      const w = sym.startsWith("'") ? sym.slice(1) : null;
      const key = `${to}|${w !== null && st.next.some(l => namesOf(l, w) !== null) ? w : ''}`;
      if (done.has(key)) continue;
      done.add(key);
      const target = lr.states[to];
      let laOf = laMemo.get(to);
      if (!laOf) { const la = lr.itemLookaheads(to); laMemo.set(to, laOf = new Map(target.items.map((it, i) => [it, la[i]]))); }
      type Var = { key: string; v: ConflictVar };
      const shifts = new Map<string, Map<string, Var>>();
      const reduces = new Map<string, Map<string, Var>>();
      const add = (m: Map<string, Map<string, Var>>, t: string, v: Var) => (m.get(t) ?? m.set(t, new Map()).get(t)!).set(v.key, v);
      for (const it of target.items) {
        if (it < 0) continue;
        const n = nextOf(it);
        const names = w !== null && graph.sym[it] !== sym ? namesOf(it, w) : null;
        if (names !== null) {
          // `_names_<n> → K •`: it reduces on whatever may follow the step.
          const v = { key: `#${names}`, v: { names } };
          for (const t of n.terms) add(reduces, t, v);
          if (n.end) for (const t of laOf.get(it)!) add(reduces, t, v);
          continue;
        }
        const rule = graph.ruleNames[graph.rule[it]];
        const v = { key: `@${rule}`, v: { rule } };
        for (const t of n.terms) add(shifts, t, v);
        if (n.end) for (const t of laOf.get(it)!) add(reduces, t, v);
      }
      for (const [t, rm] of reduces) {
        const rs = [...rm.values()];
        const sh = [...(shifts.get(t)?.values() ?? [])];
        if (!sh.length && rs.length < 2) continue;
        if (rs.length > 12) throw new Error(`gen-treesitter: ${rs.length} rules reduce on one lookahead (${t}); the conflict parts are enumerated`);
        for (let m = 1; m < 1 << rs.length; m++) {
          const part = rs.filter((_, i) => (m >> i) & 1);
          if (!sh.length && part.length < 2) continue;
          const vars = new Map<string, ConflictVar>();
          for (const v of [...sh, ...part]) vars.set(v.key, v.v);
          const keys = [...vars.keys()].sort();
          out.set(keys.join('\u0000'), keys.map(k => vars.get(k)!));
        }
      }
    }
  });
  return out;
}

/** Every word-shaped literal the rendered rules write (renderExpr's literal / sep / Pratt operator
 *  cases, over the tree-sitter view of each group), sorted. buildGrammarJs checks the rendering wrote
 *  no other. */
function collectWordLiterals(grammar: CstGrammar, isWordLiteral: (text: string) => boolean): string[] {
  const out = new Set<string>();
  const walk = (e: RuleExpr): void => {
    e = tsView(e);
    switch (e.type) {
      case 'literal': out.add(e.value); return;
      case 'seq': case 'alt': e.items.forEach(walk); return;
      case 'quantifier': walk(e.body); return;
      case 'sep': walk(e.element); out.add(e.delimiter); return;
    }
  };
  for (const r of grammar.rules) walk(r.body);
  for (const lvl of grammar.precs) for (const o of lvl.operators) out.add(o.value);
  return [...out].filter(isWordLiteral).sort();
}

function renderExpr(expr: RuleExpr, ctx: GrammarJsContext, wordGuard?: WordGuard): string {
  switch (expr.type) {
    case 'literal': {
      // A flow-collection delimiter literal (`[` `]` `{` `}`) is emitted by the external scanner (so
      // flow_depth persists), so reference its synthetic scanner token instead of the bare string —
      // aliased back to the literal, so the tree carries the same anonymous `"{"` node a plain literal
      // would (the hidden external alone is no node: a query naming `"{"` would not compile).
      const flowSym = ctx.flowLiteralTokens.get(expr.value);
      if (flowSym) return `alias($.${flowSym}, ${jsString(expr.value)})`;
      return ruleLiteral(expr.value, ctx);
    }
    case 'ref': {
      // A template reference is the template RULE of the hole rule it declares (see
      // TemplatePlan.holes), aliased to the one `template` node kind.
      if (expr.hole !== undefined && ctx.templatePlan) {
        const tp = ctx.templatePlan;
        const variant = tp.holes.find(h => h.rule === expr.hole)!;
        return variant.ruleSnake === tp.ruleSnake ? `$.${tp.ruleSnake}` : `alias($.${variant.ruleSnake}, $.${tp.ruleSnake})`;
      }
      // A token provided by the external scanner is referenced by its scanner
      // symbol name (e.g. `regex` → `regex_literal`), not its plain token snake.
      const scannerSym = ctx.scannerTokenFor.get(expr.name);
      const aliased = ctx.firstFilters.aliasOf.get(expr.name);
      if (aliased !== undefined) {
        const as = ctx.tokenNames.has(aliased) ? ctx.tokenSnake.get(aliased)! : ctx.ruleSnake.get(aliased)!;
        const copy = `alias($.${ctx.ruleSnake.get(expr.name)!}, $.${as})`;
        const step = ctx.firstFilters.stepOf.get(expr);
        return step && ctx.nameFieldNodes.has(step) ? `field('name', ${copy})` : copy;
      }
      const ref = scannerSym
        ? `$.${scannerSym}`
        : ctx.tokenNames.has(expr.name)
        ? `$.${ctx.tokenSnake.get(expr.name) ?? toSnake(expr.name)}`
        : `$.${ctx.ruleSnake.get(expr.name) ?? toSnake(expr.name)}`;
      // Every word-token step names its reserved set once any guard renders to one: a guarded step
      // its guard's, every other step the empty `unreserved` (planReservedSets: why all of them).
      const word = expr.name === ctx.reserved.word ? renderWordStep(expr, ref, wordGuard, ctx) : ref;
      // The identifier right after a definition keyword carries a `name` field so
      // highlights.scm can capture it with the standard `name:` query form.
      if (ctx.nameFieldNodes.has(expr)) return `field('name', ${word})`;
      return word;
    }
    case 'seq': {
      const lowered = lowerNotBeforeOptional(expr);
      if (lowered) return renderExpr(lowered, ctx);
      // A reserved-word guard renders as its set on the word-token step it guards (the guard itself,
      // zero-width, still renders to blank()).
      const setAt = new Map<number, WordGuard>();
      expr.items.forEach((item, i) => {
        if (item.type !== 'not') return;
        let j = i + 1;
        while (j < expr.items.length && ASSERTION_KINDS.has(tsView(expr.items[j]).type)) j++;
        const words = reservedGuardWords(item, expr.items[j], ctx.reserved.word, ctx.reserved.isWordLiteral);
        if (words) setAt.set(j, { set: ctx.reserved.plan.nameOf(words), words });
      });
      const parts = expr.items.map((item, i) => {
        const set = setAt.get(i);
        if (set === undefined) return renderExpr(item, ctx);
        const v = tsView(item);
        if (v !== item && item.type === 'group' && item.tsRuleName) throw new Error('gen-treesitter: a reserved-word guard before a named tsRelax group');
        return renderExpr(v, ctx, set);
      }).filter(p => p !== 'blank()');
      if (parts.length === 0) return 'blank()';
      if (parts.length === 1) return parts[0];
      return `seq(${parts.join(', ')})`;
    }
    case 'alt': {
      // A line-end alternative: its arms that consume nothing are its zero-width token (planZeroWidth).
      const zw = ctx.zeroWidth.tokenOf.get(expr);
      const parts = zw
        ? [...expr.items.filter(i => { const v = tsView(i); return !(v.type === 'seq' ? v.items : [v]).every(x => ASSERTION_KINDS.has(tsView(x).type)); }).map(i => renderExpr(i, ctx)), `$.${zw.snake}`]
        : expr.items.map(i => renderExpr(i, ctx));
      return `choice(${parts.join(', ')})`;
    }
    case 'quantifier': {
      const body = renderExpr(expr.body, ctx);
      if (expr.kind === '?') return `optional(${body})`;
      if (expr.kind === '*') return `repeat(${body})`;
      return `repeat1(${body})`;
    }
    case 'group': {
      // A tsRelax group carries a tree-sitter-only alternate rendering (a parser-strict
      // constraint the highlighter relaxes — see RuleExpr.group.tsRelaxed). Render that
      // instead of the strict body; every other consumer uses `body`.
      const relaxed = expr.tsRelaxed ?? expr.body;
      // Named tsRelax: emit the relaxed body ONCE as a shared rule and reference it, so its
      // states are shared across all use sites rather than inlined at each.
      if (expr.tsRuleName) {
        if (!ctx.tsSharedRules.has(expr.tsRuleName)) ctx.tsSharedRules.set(expr.tsRuleName, relaxed);
        return `$.${expr.tsRuleName}`;
      }
      return renderExpr(relaxed, ctx);
    }
    case 'sameLine': {
      // A same-line marker rendered as its zero-width token (planZeroWidth).
      const zw = ctx.zeroWidth.tokenOf.get(expr);
      if (zw) return `$.${zw.snake}`;
    }
    // falls through
    case 'not':
    case 'noCommentBefore':
    case 'noMultilineFlowBefore':
    case 'notLeftLeaf':
      // A zero-width assertion consumes nothing and a CFG has no lookahead, so it renders to a
      // no-op. Never silently: classifyAssertions recorded it with whether the drop is exact (the
      // `assertions` ledger of the output); one it did not reach is a generator defect.
      if (!ctx.classifiedAssertions.has(expr)) throw new Error(`gen-treesitter: ${expr.type} assertion rendered without a classification (rule walk missed it)`);
      return 'blank()';
    case 'sep': {
      // sep(elem, ',') = optional(seq(elem, repeat(seq(',', elem)), optional(',')))
      // Trailing delimiter is allowed (matches the parser's matchSep behavior).
      const elem = renderExpr(expr.element, ctx);
      const delim = ruleLiteral(expr.delimiter, ctx);
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
    // The operands as the marker arm writes them (a FIRST-filtered copy's left operand is the copy).
    const { left, right } = operands[position];
    for (const { num, assoc, ops } of byLevel.values()) {
      const opLits = ops.map(o => ruleLiteral(o, ctx));
      const opChoice = opLits.length === 1 ? opLits[0] : `choice(${opLits.join(', ')})`;
      let inner: string;
      if (position === 'infix') inner = `seq(${left}, field('operator', ${opChoice}), ${right})`;
      else if (position === 'prefix') inner = `seq(field('operator', ${opChoice}), ${right})`;
      else inner = `seq(${left}, ${postfixBetween}field('operator', ${opChoice}))`;

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
  const atomBranches: string[] = [], atomAlts: RuleExpr[] = [];
  // What stands between the operand and a postfix operator (`[$, sameLine, postfix]`): a same-line
  // marker renders as its zero-width token, any other assertion as nothing.
  let postfixBetween = '';
  const operands = { infix: { left: '', right: '' }, prefix: { left: '', right: '' }, postfix: { left: '', right: '' } };

  for (const alt of alts) {
    const items = alt.type === 'seq' ? alt.items : [alt];
    const markerPos = items.findIndex(i => i.type === 'op' || i.type === 'prefix' || i.type === 'postfix');
    if (markerPos !== -1) {
      const m = items[markerPos];
      operands[m.type === 'op' ? 'infix' : m.type === 'prefix' ? 'prefix' : 'postfix'] = {
        left: m.type === 'prefix' ? '' : renderExpr(items[0], ctx),
        right: m.type === 'postfix' ? '' : renderExpr(items[markerPos + 1], ctx),
      };
      if (m.type === 'op') sawInfix = true;
      else if (m.type === 'prefix') sawPrefix = true;
      else if (m.type === 'postfix') {
        sawPostfix = true;
        for (const b of items.slice(1, markerPos)) { const r = renderExpr(b, ctx); if (r !== 'blank()') postfixBetween += `${r}, `; }
      }
      // Operator branches are emitted from the prec table below (one per level),
      // not from this skeletal `[$, op, $]` alternative.
      continue;
    }
    // Non-operator alternative: an atom or a left-recursive continuation
    // (member access `[$, '.', Ident]`, call `[$, '(', …, ')']`, generics, etc.).
    // Render as-is; give it a baseline precedence so it doesn't outrank operators.
    atomBranches.push(renderExpr(alt, ctx));
    atomAlts.push(alt);
  }

  if (sawInfix) emitOperatorBranches('infix');
  if (sawPrefix) emitOperatorBranches('prefix');
  if (sawPostfix) emitOperatorBranches('postfix');

  // Atoms get a baseline prec of 0; the postfix/call/member continuations that
  // are left-recursive get a HIGH prec so they bind tighter than binary ops
  // (matches the Pratt parser's maxBp for non-operator LED patterns).
  const high = nLevels + 1;
  const selfSnake = ctx.ruleSnake.get(rule.name);
  for (const [i, ab] of atomBranches.entries()) {
    // Heuristic: a branch that starts with the self-reference is a left-recursive
    // continuation (call/member/index/generic) — bind tight.
    if (ab.startsWith(`seq($.${selfSnake}`) || ab === `$.${selfSnake}` || ab.startsWith(`seq(alias($.${selfSnake}, `)) {
      // The precedence decides at the continuation's operator; a continuation that ENDS in another
      // rule's reference leaves that last step out of it (see openTail).
      const tail = openTail(rule.name, atomAlts[i], ctx.grammar);
      if (tail === null) { branches.push(`prec.left(${high}, ${ab})`); continue; }
      const t = renderExpr(tail, ctx);
      if (!ab.endsWith(`, ${t})`)) throw new Error(`gen-treesitter: the continuation ${ab} does not end in its operand ${t}`);
      branches.push(`seq(prec.left(${high}, ${ab.slice(0, ab.length - t.length - 3)})), ${t})`);
    } else {
      branches.push(ab);
    }
  }

  return `choice(\n      ${branches.join(',\n      ')}\n    )`;
}

/**
 * The operand a Pratt continuation ends in, when that operand is ANOTHER rule with continuations of
 * its own (TypeScript's `[$, 'as', Type]`: Type continues with `[ ]`, `|`, `&`, `<`, `.`, `?` …).
 *
 * tree-sitter takes a production's reduce precedence and associativity from its LAST step. Under
 * the continuation's high left precedence, `x as T` reduced before any of Type's own continuation
 * tokens could shift (Type's productions have the default precedence), so `x as T[]` became
 * `(x as T)[` and an ERROR. The interpreter reads the operand like any rule: whole, greedily,
 * falling back to the shorter operand only where the longer one fails (`x as T < b`: no type
 * arguments close, so `<` compares). The generator's rule: a continuation's precedence decides at
 * its operator, so it covers the steps up to the operand (`seq(prec.left(N, seq($.expr, "as")),
 * $.type)`: the shift of `as` against the other operators reads the first step); the last step,
 * a reference to another rule that has continuations, carries neither precedence nor
 * associativity (a nested `prec` would still inherit the outer `left`), so after the operand each
 * token that continues the operand AND can follow the expression is an LR conflict between the two
 * readings, declared (deriveConflicts) and kept by GLR, which drops the one that fails as the
 * interpreter's fallback does. A token that only one reading takes needs no conflict.
 * An operand that is itself a precedence-climbing rule would carry its own levels: not modelled,
 * so it fails loudly.
 */
function openTail(self: string, alt: RuleExpr, grammar: CstGrammar): RuleExpr | null {
  const leftRecursive = (e: RuleExpr, name: string) => {
    const v = tsView(e);
    const head = (v.type === 'seq' ? v.items : [v]).find(i => !ASSERTION_KINDS.has(i.type));
    return head?.type === 'ref' && head.name === name;
  };
  if (alt.type !== 'seq' || !leftRecursive(alt, self)) return null;
  const last = alt.items[alt.items.length - 1];
  if (last.type !== 'ref' || last.name === self) return null;
  const r = grammar.rules.find(x => x.name === last.name);
  if (!r) return null;
  const open = (r.body.type === 'alt' ? r.body.items : [r.body]).some(a => leftRecursive(a, r.name));
  if (!open) return null;
  if (hasMarker(r.body)) throw new Error(`gen-treesitter: the continuation of ${self} ends in ${r.name}, a precedence-climbing rule; its levels are not rendered on the last step`);
  return last;
}

/** The [rule, operand] pairs whose continuations meet after an openTail operand (deriveConflicts). */
function openTailConflicts(ctx: GrammarJsContext): string[][] {
  const out: string[][] = [];
  for (const name of ctx.prattRules) {
    const rule = ctx.grammar.rules.find(r => r.name === name)!;
    for (const alt of rule.body.type === 'alt' ? rule.body.items : [rule.body]) {
      const tail = openTail(name, alt, ctx.grammar);
      if (tail?.type === 'ref') out.push([ctx.ruleSnake.get(name)!, ctx.ruleSnake.get(tail.name)!]);
    }
  }
  return out;
}

// ── Nullable-rule elimination (ε-elimination) ────────────────────────────────
// tree-sitter rejects a NON-START rule that can match the empty string. An indentation grammar like
// YAML has several (a YAML node/entry may be NULL: `key:` with no value, `{a: }`, an empty doc), so
// `node`/`flow_node`/`flow_map_entry`/… are nullable. We push the emptiness to the CALL SITES: make
// each such rule's body NON-EMPTY (`makeNonEmpty`) and wrap every reference to it in `optional(...)`
// (`wrapNullableRefs`). The accepted language is identical (rule-or-empty at each use), and ONLY the
// tree-sitter target is touched — the parser and the other generators never see this. Computed once
// and gated on the grammar actually having nullable non-start rules, so every grammar that already
// `generate`s (no such rules) is byte-identical.

/** Non-start rules whose body can derive ε. `isTerminal` flags tokens / external symbols (never nullable). */
function computeNullableNonStart(grammar: CstGrammar, startName: string, isTerminal: (name: string) => boolean): Set<string> {
  const ruleNames = new Set(grammar.rules.map(r => r.name));
  const nullable = new Set<string>();
  const exprNullable = (e: RuleExpr): boolean => {
    switch (e.type) {
      case 'literal': return e.value === '';
      case 'ref': return ruleNames.has(e.name) && !isTerminal(e.name) && nullable.has(e.name);
      case 'seq': return e.items.every(exprNullable);
      case 'alt': return e.items.some(exprNullable);
      case 'quantifier': return e.kind === '+' ? exprNullable(e.body) : true; // ?,* match empty
      case 'group': return exprNullable(e.body);
      case 'sep': return true;  // renders to optional(seq(...))
      default: return true;     // not/sameLine/noCommentBefore/noMultilineFlowBefore/op/prefix/postfix → blank()
    }
  };
  let changed = true;
  while (changed) { changed = false; for (const r of grammar.rules) if (!nullable.has(r.name) && exprNullable(r.body)) { nullable.add(r.name); changed = true; } }
  nullable.delete(startName); // the start rule MAY be nullable in tree-sitter
  return nullable;
}

/** Wrap every reference to a made-non-empty (`nn`) rule in optional() — the may-be-empty form. */
function wrapNullableRefs(e: RuleExpr, nn: Set<string>): RuleExpr {
  switch (e.type) {
    case 'ref': return nn.has(e.name) ? { type: 'quantifier', kind: '?', body: e } : e;
    case 'seq': return { type: 'seq', items: e.items.map(i => wrapNullableRefs(i, nn)) };
    case 'alt': return { type: 'alt', items: e.items.map(i => wrapNullableRefs(i, nn)) };
    case 'quantifier': return { ...e, body: wrapNullableRefs(e.body, nn) };
    case 'group': return { ...e, body: wrapNullableRefs(e.body, nn) };
    case 'sep': return { ...e, element: wrapNullableRefs(e.element, nn) };
    default: return e;
  }
}

/** Whether e is nullable AFTER the transform (a ref to an `nn` rule is now wrapped optional → nullable;
 *  every other ref is non-nullable, since `nn` is exactly the made-non-empty set). */
function exprNullableAfter(e: RuleExpr, nn: Set<string>): boolean {
  switch (e.type) {
    case 'literal': return e.value === '';
    case 'ref': return nn.has(e.name);
    case 'seq': return e.items.every(i => exprNullableAfter(i, nn));
    case 'alt': return e.items.some(i => exprNullableAfter(i, nn));
    case 'quantifier': return e.kind === '+' ? exprNullableAfter(e.body, nn) : true;
    case 'group': return exprNullableAfter(e.body, nn);
    case 'sep': return true;
    default: return true;
  }
}

/** The non-empty form of a (nullable) expr — its language minus ε. `null` if that language is empty
 *  (a purely zero-width expr). The chosen non-empty position is rendered UNWRAPPED; the rest get the
 *  may-be-empty form `wrapNullableRefs`. */
function makeNonEmpty(e: RuleExpr, nn: Set<string>): RuleExpr | null {
  const T = (x: RuleExpr) => wrapNullableRefs(x, nn);
  const NE = (x: RuleExpr) => makeNonEmpty(x, nn);
  const nul = (x: RuleExpr) => exprNullableAfter(x, nn);
  switch (e.type) {
    case 'literal': return e.value === '' ? null : e;
    case 'ref': return e;                                   // an nn rule (now non-empty) or a non-nullable rule/terminal
    case 'group': { const b = NE(e.body); return b ? { ...e, body: b } : null; }
    case 'alt': {
      const parts: RuleExpr[] = [];
      for (const m of e.items) { const r = nul(m) ? NE(m) : T(m); if (r) parts.push(r); }
      return parts.length === 0 ? null : parts.length === 1 ? parts[0] : { type: 'alt', items: parts };
    }
    case 'seq': {
      if (e.items.some(i => !nul(i))) return T(e);          // a non-nullable element already forces non-empty
      const branches: RuleExpr[] = [];                       // all nullable → "first non-empty element is at i"
      for (let i = 0; i < e.items.length; i++) {
        const head = NE(e.items[i]);
        if (!head) continue;
        const tail = e.items.slice(i + 1).map(T);
        branches.push(tail.length ? { type: 'seq', items: [head, ...tail] } : head);
      }
      return branches.length === 0 ? null : branches.length === 1 ? branches[0] : { type: 'alt', items: branches };
    }
    case 'quantifier': {
      if (e.kind === '?') return nul(e.body) ? NE(e.body) : T(e.body);   // optional(x) non-empty = x non-empty
      const head = nul(e.body) ? NE(e.body) : T(e.body);                 // *,+ non-empty = one non-empty iter, then repeat
      return head ? { type: 'seq', items: [head, { type: 'quantifier', kind: '*', body: T(e.body) }] } : null;
    }
    case 'sep': {
      const head = nul(e.element) ? NE(e.element) : T(e.element);
      if (!head) return null;
      const d: RuleExpr = { type: 'literal', value: e.delimiter };
      return { type: 'seq', items: [head, { type: 'quantifier', kind: '*', body: { type: 'seq', items: [d, T(e.element)] } }, { type: 'quantifier', kind: '?', body: d }] };
    }
    default: return null;                                   // not/sameLine/…: zero-width, no non-empty form
  }
}

/** Build a single rule's body string (Pratt or plain). */
function buildRuleBody(rule: RuleDecl, ctx: GrammarJsContext): string {
  if (ctx.prattRules.has(rule.name)) return buildPrattRule(rule, ctx);
  const nn = ctx.nullableNonStart;
  const body = nn.size === 0 ? rule.body
    : nn.has(rule.name) ? (makeNonEmpty(rule.body, nn) ?? rule.body) : wrapNullableRefs(rule.body, nn);
  const follow = ctx.terminalSets.follow.get(rule.name)!;
  const glr = ctx.glrRules.has(ctx.ruleSnake.get(rule.name)!);
  const greedy = (alt: RuleExpr) => !glr && greedyTail(alt, follow, ctx.terminalSets.firstOf);
  if (body.type === 'alt' && body.items.some(greedy)) {
    return `choice(${body.items.map(a => greedy(a) ? `prec.right(${renderExpr(a, ctx)})` : renderExpr(a, ctx)).join(', ')})`;
  }
  return greedy(body) ? `prec.right(${renderExpr(body, ctx)})` : renderExpr(body, ctx);
}

// ── greedy repetition tails ──────────────────────────────────────────────────
//
// A PEG quantifier is greedy: `[Stmt, opt(Newline)]` takes the newline whenever one follows, even
// where the rule's context could also begin with it (`many(Line)` with `Line = … | Newline`). The
// CFG tree-sitter derives from the same rule is ambiguous there — shift the newline into this
// production or reduce and let the context take it — and `tree-sitter generate` stops on the
// unresolved conflict. `prec.right` on the production says what the PEG does: prefer the shift.
// It is emitted only where the conflict can arise, i.e. where the trailing quantifier's FIRST set
// meets the rule's FOLLOW set, and only on a rule not declared as its own conflict: there GLR
// already keeps both parses, and a static preference would override it (the PEG's preference holds
// within one alternative, but its outer ordered choices can still backtrack past it, which GLR
// models and a fixed shift does not).

type TerminalSets = { follow: Map<string, Set<string>>; firstOf: (e: RuleExpr) => Set<string>; nullable: (e: RuleExpr) => boolean };

const EOF_TERMINAL = '$eof';

function tsView(e: RuleExpr): RuleExpr {
  return e.type === 'group' ? tsView(e.tsRelaxed ?? e.body) : e;
}

function computeTerminalSets(grammar: CstGrammar, tokenNames: Set<string>): TerminalSets {
  const ops = { op: new Set<string>(), prefix: new Set<string>(), postfix: new Set<string>() };
  for (const lvl of grammar.precs) for (const o of lvl.operators) ops[o.position === 'prefix' ? 'prefix' : o.position === 'postfix' ? 'postfix' : 'op'].add(`'${o.value}`);
  const first = new Map<string, Set<string>>(grammar.rules.map(r => [r.name, new Set<string>()]));
  const nullable = new Set<string>();
  const follow = new Map<string, Set<string>>(grammar.rules.map(r => [r.name, new Set<string>()]));
  const nul = (e: RuleExpr): boolean => {
    e = tsView(e);
    switch (e.type) {
      case 'literal': return false;
      case 'ref': return !tokenNames.has(e.name) && nullable.has(e.name);
      case 'seq': return e.items.every(nul);
      case 'alt': return e.items.some(nul);
      case 'quantifier': return e.kind !== '+' || nul(e.body);
      case 'op': case 'prefix': case 'postfix': return false;
      default: return true;
    }
  };
  const fst = (e: RuleExpr, out: Set<string>): Set<string> => {
    e = tsView(e);
    switch (e.type) {
      case 'literal': out.add(`'${e.value}`); break;
      case 'ref': if (tokenNames.has(e.name)) out.add(e.name); else for (const t of first.get(e.name) ?? []) out.add(t); break;
      case 'seq': for (const i of e.items) { fst(i, out); if (!nul(i)) break; } break;
      case 'alt': for (const i of e.items) fst(i, out); break;
      case 'quantifier': fst(e.body, out); break;
      case 'sep': fst(e.element, out); break;
      case 'op': case 'prefix': case 'postfix': for (const t of ops[e.type]) out.add(t); break;
    }
    return out;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of grammar.rules) {
      if (!nullable.has(r.name) && nul(r.body)) { nullable.add(r.name); changed = true; }
      const f = first.get(r.name)!, n = f.size;
      fst(r.body, f);
      if (f.size !== n) changed = true;
    }
  }
  const union = (a: Set<string>, b: Set<string>) => { const s = new Set(a); for (const x of b) s.add(x); return s; };
  let grew = false;
  const walk = (e: RuleExpr, after: Set<string>): void => {
    e = tsView(e);
    switch (e.type) {
      case 'ref': {
        const f = follow.get(e.name);
        if (f) for (const t of after) if (!f.has(t)) { f.add(t); grew = true; }
        break;
      }
      case 'seq': {
        let cur = after;
        for (let i = e.items.length - 1; i >= 0; i--) {
          walk(e.items[i], cur);
          cur = nul(e.items[i]) ? union(fst(e.items[i], new Set()), cur) : fst(e.items[i], new Set());
        }
        break;
      }
      case 'alt': for (const i of e.items) walk(i, after); break;
      case 'quantifier': walk(e.body, e.kind === '?' ? after : union(fst(e.body, new Set()), after)); break;
      case 'sep': walk(e.element, union(new Set([`'${e.delimiter}`]), after)); break;
    }
  };
  follow.get(grammar.rules[grammar.rules.length - 1].name)!.add(EOF_TERMINAL);
  do {
    grew = false;
    for (const r of grammar.rules) walk(r.body, follow.get(r.name)!);
  } while (grew);
  return { follow, firstOf: (e) => fst(e, new Set()), nullable: nul };
}

/** The alternative ends in a greedy quantifier (after some consumed prefix) whose FIRST set meets
 *  the rule's FOLLOW set. */
function greedyTail(alt: RuleExpr, follow: Set<string>, firstOf: TerminalSets['firstOf']): boolean {
  alt = tsView(alt);
  if (alt.type !== 'seq') return false;
  const consuming = alt.items.filter(i => { const v = tsView(i); return !(v.type === 'not' || v.type === 'sameLine' || v.type === 'noCommentBefore' || v.type === 'noMultilineFlowBefore' || v.type === 'notLeftLeaf'); });
  if (consuming.length < 2) return false;
  const tail = tsView(consuming[consuming.length - 1]);
  const starts = tail.type === 'quantifier' ? firstOf(tail.body)
    : tail.type === 'sep' ? firstOf(tail).add(`'${tail.delimiter}`)   // sep may end in an optional delimiter
    : null;
  return !!starts && [...starts].some(t => follow.has(t));
}

// ── zero-width assertions: what grammar.js does with each ───────────────────
//
// The ledger is decided HERE, beside the rendering decision, so no assertion is dropped without a
// record. Each assertion occurrence is classified against the terminals the CFG can see next at its
// position (P: FIRST of the rest of its seq, plus the enclosing FOLLOW where that rest is nullable).
// Keyword extraction is modelled: a `word`-shaped literal that is not valid in a state is lexed as
// the word token, so a word-shaped literal and the word token stand for each other's text.

/** A `not(S)` whose next consuming item is the word token, S a choice of word-shaped literals: the
 *  words it reserves there (sorted, distinct), else null. */
function reservedGuardWords(guard: RuleExpr, next: RuleExpr | undefined, word: string | undefined, isWordLiteral: (text: string) => boolean): string[] | null {
  if (guard.type !== 'not' || !word) return null;
  const v = next && tsView(next);
  if (!v || v.type !== 'ref' || v.name !== word) return null;
  const words = new Set<string>();
  const collect = (e: RuleExpr): boolean => {
    e = tsView(e);
    if (e.type === 'literal') { words.add(e.value); return isWordLiteral(e.value); }
    if (e.type === 'alt') return e.items.every(collect);
    if (e.type === 'seq' && e.items.length === 1) return collect(e.items[0]);
    return false;
  };
  return collect(guard.body) ? [...words].sort() : null;
}

// ── reserved word sets ──
// tree-sitter gives each parse state ONE reserved set: the highest-id set among its items that shift
// the word token (ids in declaration order; the first, global set is id 0). So the sets are rendered
// as a CHAIN, most reserving first, and every word-token step that no guard reserves gets the last,
// empty set `unreserved`: wherever two readings share a state, the less reserving one wins and the
// generated grammar never rejects more than the grammar. A guard set that is no subset of the chain's
// smallest so far stays unrendered (`reserved`).
interface ReservedSets { sets: { name: string; words: string[] }[]; nameOf: (words: string[]) => string | null }
const UNRESERVED_SET = 'unreserved';
function planReservedSets(guards: string[][]): ReservedSets {
  const distinct = new Map<string, string[]>();
  for (const w of guards) distinct.set(w.join(' '), w);
  const chain: { name: string; words: string[] }[] = [];
  for (const words of [...distinct.values()].sort((a, b) => b.length - a.length || a.join(' ').localeCompare(b.join(' ')))) {
    const last = chain[chain.length - 1];
    if (last && !words.every(w => last.words.includes(w))) continue;
    chain.push({ name: `reserved_${chain.length + 1}`, words });
  }
  const byKey = new Map(chain.map(c => [c.words.join(' '), c.name]));
  return { sets: chain, nameOf: words => byKey.get(words.join(' ')) ?? null };
}

const ASSERTION_KINDS = new Set<RuleExpr['type']>(['not', 'sameLine', 'noCommentBefore', 'noMultilineFlowBefore', 'notLeftLeaf']);

function classifyAssertions(grammar: CstGrammar, tokenNames: Set<string>, sets: TerminalSets): { records: AssertionRecord[]; recordOf: Map<RuleExpr, AssertionRecord[]>; nodes: Set<RuleExpr>; reservedSets: ReservedSets; isWordLiteral: (text: string) => boolean } {
  const records: AssertionRecord[] = [];
  const recordOf = new Map<RuleExpr, AssertionRecord[]>();
  const nodes = new Set<RuleExpr>();
  const identTok = grammar.tokens.find(t => t.identifier);
  const word = identTok?.name;
  const identRe = identTok ? new RegExp(`^(?:${tokenPatternSource(identTok)})$`, 'u') : null;
  const wordShaped = (t: string) => t === word || (t.startsWith("'") && !!identRe && identRe.test(t.slice(1)));
  // Could the text that lexes as `a` here start the way `b`'s text does? Two word-shaped terminals
  // meet only through keyword extraction (one of them is the word token). Any other pair meets when
  // their first characters can: tree-sitter's context-aware lexer may lex a prefix (`>` of `>>`)
  // where the interpreter's lexer takes the longer token, so equal first characters count.
  const firstChars = (t: string): TokenPatternFirstSet | null => {
    if (t === EOF_TERMINAL) return { ascii: new Set(), nonAscii: false };
    if (t.startsWith("'")) {
      const c = t.codePointAt(1)!;
      return c < 128 ? { ascii: new Set([c]), nonAscii: false } : null;
    }
    const tok = grammar.tokens.find(x => x.name === t);
    return tok ? tokenPatternFirstCharSet(tok) : null;
  };
  const overlap = (a: string, b: string) => {
    if (a === b) return true;
    if (wordShaped(a) && wordShaped(b)) return a === word || b === word;
    const fa = firstChars(a), fb = firstChars(b);
    if (!fa || !fb) return true;
    return (fa.nonAscii && fb.nonAscii) || [...fa.ascii].some(c => fb.ascii.has(c));
  };
  // A literal the CFG can see that the lexer could also cut from a longer literal (`>` from `>>`).
  const literals = new Set<string>();
  for (const r of grammar.rules) for (const l of collectLiterals(r.body)) literals.add(l);
  for (const lvl of grammar.precs) for (const o of lvl.operators) literals.add(o.value);
  const prefixOfLonger = (t: string) => t.startsWith("'") && !wordShaped(t) && [...literals].some(l => l.length > t.length - 1 && l.startsWith(t.slice(1)));
  const meets = (xs: Set<string>, ys: Set<string>) => [...xs].some(x => [...ys].some(y => overlap(x, y)));
  // The terminals of a one-token expression (literal / token / choice of them), else null.
  const tokSet = (e: RuleExpr): Set<string> | null => {
    e = tsView(e);
    if (e.type === 'literal') return new Set([`'${e.value}`]);
    if (e.type === 'ref') return tokenNames.has(e.name) ? new Set([e.name]) : null;
    if (e.type === 'seq' && e.items.length === 1) return tokSet(e.items[0]);
    if (e.type === 'alt') {
      const out = new Set<string>();
      for (const i of e.items) { const s = tokSet(i); if (!s) return null; for (const t of s) out.add(t); }
      return out;
    }
    return null;
  };
  const isWordLiteral = (text: string) => !!identRe && identRe.test(text);
  // Guards rendered as a reserved set: their word list, by occurrence (finalised by planReservedSets).
  const guardWords = new Map<AssertionRecord, string[]>();

  const classify = (e: RuleExpr, P: Set<string>, next: RuleExpr | undefined): AssertionClass => {
    if (e.type === 'sameLine' || e.type === 'noCommentBefore' || e.type === 'noMultilineFlowBefore') return 'scanner';
    if (e.type === 'notLeftLeaf') return 'left-context';
    if (e.type !== 'not') throw new Error(`classifyAssertions: ${e.type} is not an assertion`);
    const body = tsView(e.body);
    if (body.type === 'sameLine') return 'scanner';                      // not(sameLine): a line terminator here
    if (body.type === 'not') {                                           // positive lookahead not(not(Y))
      const S = tokSet(body.body);
      if (!S) return 'lookahead';
      // Exact when every terminal the CFG can see here is one Y matches.
      const covered = [...P].every(p => (S.has(p) || (word !== undefined && S.has(word) && wordShaped(p) && p !== word)) && !prefixOfLonger(p));
      return covered ? 'vacuous' : 'lookahead1';
    }
    if (ASSERTION_KINDS.has(body.type)) return 'lookahead';
    // Negative lookahead not(X): exact when X cannot start at any terminal the CFG sees here.
    if (!sets.nullable(body) && !meets(sets.firstOf(body), P)) return 'vacuous';
    if (reservedGuardWords(e, next, word, isWordLiteral)) return 'reserved';
    return tokSet(body) ? 'lookahead1' : 'lookahead';
  };

  const lowered = new Set<RuleExpr>();
  let rule = '';
  // `next`: the next consuming item after `e`; `nextInSeq`: the same, when it is in e's own seq (the
  // only place renderExpr can attach a reserved set to).
  const visit = (e: RuleExpr, after: Set<string>, next?: RuleExpr, nextInSeq?: RuleExpr): void => {
    e = tsView(e);
    if (ASSERTION_KINDS.has(e.type)) {
      nodes.add(e);
      const rec: AssertionRecord = { rule, kind: e.type as AssertionRecord['kind'], cls: lowered.has(e) ? 'lowered' : classify(e, after, next), text: assertionText(e) };
      const words = rec.cls === 'reserved' ? reservedGuardWords(e, nextInSeq, word, isWordLiteral) : null;
      if (words) guardWords.set(rec, words);
      records.push(rec);
      (recordOf.get(e) ?? recordOf.set(e, []).get(e)!).push(rec);
      return;
    }
    switch (e.type) {
      case 'seq': {
        // Mirror renderExpr: a lowerable seq is walked in its lowered form.
        const low = lowerNotBeforeOptional(e, g => lowered.add(g));
        if (low) return visit(low, after, next);
        let cur = after;
        let nextItem = next, nextIn: RuleExpr | undefined;
        for (let i = e.items.length - 1; i >= 0; i--) {
          const item = e.items[i];
          visit(item, cur, nextItem, nextIn);
          if (!ASSERTION_KINDS.has(tsView(item).type)) nextItem = nextIn = item;
          if (sets.nullable(item)) { const s = new Set(cur); for (const t of sets.firstOf(item)) s.add(t); cur = s; }
          else cur = sets.firstOf(item);
        }
        return;
      }
      case 'alt': for (const i of e.items) visit(i, after, next); return;
      case 'quantifier': {
        if (e.kind === '?') return visit(e.body, after, next);
        const s = new Set(after); for (const t of sets.firstOf(e.body)) s.add(t);
        return visit(e.body, s, undefined);
      }
      case 'sep': {
        const s = new Set(after); s.add(`'${e.delimiter}`);
        return visit(e.element, s, undefined);
      }
    }
  };
  for (const r of grammar.rules) { rule = r.name; visit(r.body, sets.follow.get(r.name)!); }
  const reservedSets = planReservedSets([...guardWords.values()]);
  for (const [rec, words] of guardWords) if (reservedSets.nameOf(words)) rec.cls = 'reserved-set';
  return { records, recordOf, nodes, reservedSets, isWordLiteral };
}

// ── Positive one-token lookaheads as FIRST-filtered copies (planFirstFilters) ──
// A CFG has no lookahead, but a positive lookahead on the NEXT token is a property of the strings
// that follow: `not(not(Y)) R` derives exactly the strings of R whose first token is in Y. Such a site
// renders exactly as a COPY of R restricted by its first token: an alternative whose FIRST is inside Y
// is kept (the same node), one whose FIRST is outside is dropped, and one with both is restricted in
// its left corner, recursively, so a rule met there is copied too: one copy per rule and condition
// (`_stmt_first_1`), shared by every site and every recursion with that condition (left recursion maps
// to the copy itself). A copy is a hidden rule rendered as `alias($._stmt_first_1, $.stmt)`, so the
// tree is the one the uncopied rule gives. Keyword extraction is modelled as in classifyAssertions: the
// word token stands for the word-shaped literals it can lex, so a condition naming a word keeps the word
// step only as that word: a NAMES rule of the words (`_ident_names_1`), aliased to the word token.
// Only POSITIVE conditions: they keep the few alternatives that start as Y does. A negative one
// (`not(X)`) keeps nearly everything, so its copy is nearly the whole continuation (measured with the
// LALR entries model: the expression statement's `not('{' | 'function' | 'class' | Decorator)` +27% JS
// table entries, the concise body's `not('{')` +34% JS, TypeScript's `not('static')` +26%; every
// condition together doubles both grammars): they stay dropped, recorded in the ledger.
// What a positive condition cannot render exactly stays recorded (the ledger keeps its class):
// - a lookahead over token SEQUENCES (`'var' | ['await' 'using']`) renders as the condition on their
//   first tokens, a superset of what it accepts;
// - a Pratt rule reached in a left corner (only through a word the condition names, `export let = 1`,
//   or a keyword prefix operator, TypeScript's `export await using`) would be copied whole for those:
//   it is left out (the generated grammar already lexes that word as the keyword there);
// - a condition that reaches past the end of its sequence (an optional item last) is the condition on
//   what follows the rule: rendered only where no terminal of the rule's FOLLOW is in Y (the empty rest
//   is dropped), else left dropped; likewise a nullable rule or a named tsRelax group in a left corner.
interface FirstFilterPlan {
  /** The grammar as tree-sitter renders it: the sites rewritten, the copies after their originals. */
  grammar: CstGrammar;
  /** A copy rule → the rule (or, for a names rule, the word token) whose node it renders as. */
  aliasOf: Map<string, string>;
  /** A copy rule → its hidden snake name. */
  snakeOf: Map<string, string>;
  /** The assertion nodes every site of which renders exactly (the ledger's `lowered`). */
  lowered: Set<RuleExpr>;
  /** A names reference → the word step it stands for (its `name` field, if it has one). */
  stepOf: Map<RuleExpr, RuleExpr>;
}
class FirstFilterResidual extends Error {}

function planFirstFilters(grammar: CstGrammar, tokenNames: Set<string>, sets: TerminalSets, word: string | undefined,
  isWordLiteral: (text: string) => boolean, recordOf: Map<RuleExpr, AssertionRecord[]>): FirstFilterPlan {
  const plan: FirstFilterPlan = { grammar, aliasOf: new Map(), snakeOf: new Map(), lowered: new Set(), stepOf: new Map() };
  if (grammar.indent || grammar.newline) return plan;
  const rules = new Map(grammar.rules.map(r => [r.name, r]));
  const isWordShaped = (t: string) => t.startsWith("'") && isWordLiteral(t.slice(1));
  const tokSet = (e: RuleExpr): Set<string> | null => {
    e = tsView(e);
    if (e.type === 'literal') return new Set([`'${e.value}`]);
    if (e.type === 'ref') return tokenNames.has(e.name) ? new Set([e.name]) : null;
    if (e.type === 'seq' && e.items.length === 1) return tokSet(e.items[0]);
    if (e.type === 'alt') {
      const out = new Set<string>();
      for (const i of e.items) { const s = tokSet(i); if (!s) return null; for (const t of s) out.add(t); }
      return out;
    }
    return null;
  };
  // A positive lookahead over token SEQUENCES (`"var" | ["await" "using"]`, `["export" "default"?
  // "class"]`) as a trie: each first token -> what must follow it (null: nothing more). Null when the
  // lookahead is not a choice of token sequences (an optional item expands to both paths).
  const trieOf = (e: RuleExpr): Cond | null => {
    const root: Cond = new Map();
    const add = (at: Cond, path: Set<string>[]) => {
      for (const t of path[0]) {
        if (path.length === 1) { at.set(t, null); continue; }
        if (at.get(t) === null) continue;                // a shorter path already satisfies it
        const next = at.get(t) ?? new Map();
        at.set(t, next);
        add(next, path.slice(1));
      }
    };
    const v0 = tsView(e);
    for (const a of v0.type === 'alt' ? v0.items : [v0]) {
      const v = tsView(a);
      let paths: Set<string>[][] = [[]];
      for (const item of v.type === 'seq' ? v.items : [v]) {
        const it = tsView(item);
        const opt = it.type === 'quantifier' && it.kind === '?';
        const ts = tokSet(it.type === 'quantifier' && it.kind === '?' ? it.body : it);
        if (!ts) return null;
        paths = paths.flatMap(q => opt ? [q, [...q, ts]] : [[...q, ts]]);
      }
      for (const q of paths) { if (!q.length) return null; add(root, q); }
    }
    return root;
  };
  // A site whose rendering accepts more than its condition (a Pratt corner left out), noted while it
  // is filtered; a copy remembers it for every later site that reuses it.
  const inexact = new Set<RuleExpr>();
  let siteInexact = false;
  // The condition of a positive lookahead the ledger left dropped (`lookahead1`: one token;
  // `lookahead`: token sequences).
  const conditionOf = (e: RuleExpr): Cond | null => {
    if (e.type !== 'not') return null;
    const b = tsView(e.body);
    if (b.type !== 'not') return null;
    const cls = (recordOf.get(e) ?? []).map(r => r.cls);
    if (!cls.includes('lookahead1') && !cls.includes('lookahead')) return null;
    return trieOf(b.body);
  };
  // A condition on the first token alone: its tokens.
  const flat = (c: Cond): Set<string> | null => [...c.values()].every(v => v === null) ? new Set(c.keys()) : null;
  const condKey = (c: Cond): string => [...c].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([t, n]) => n ? `${t}(${condKey(n)})` : t).join(' ');
  const keyOf = (y: Set<string>) => [...y].sort().join(' ');
  type Cond = Map<string, Cond | null>;
  // A terminal against Y: does a token it stands for start as Y allows. A word-shaped literal passes
  // where Y holds the word token; the word token passes where Y holds it, and otherwise may only be the
  // words of Y that the step's own guards do not reserve.
  const test = (t: string, y: Set<string>, reservedHere: ReadonlySet<string> = NO_WORDS): boolean | string[] => {
    if (t !== word) return y.has(t) || (word !== undefined && isWordShaped(t) && y.has(word));
    if (y.has(t)) return true;
    const words = [...y].filter(x => isWordShaped(x) && !reservedHere.has(x.slice(1))).map(x => x.slice(1)).sort();
    return words.length ? words : false;
  };
  const NO_WORDS: ReadonlySet<string> = new Set();
  const copies = new Map<string, string | null>();          // `rule|Y` → copy name (null: it cannot be built)
  const copyBodies = new Map<string, RuleExpr>();           // copy (or names) rule → body
  const copiesOf = new Map<string, string[]>();             // rule → its copies, in order
  const inexactCopies = new Set<string>();
  const namesRules = new Map<string, string>();             // words → names rule
  const namesRef = (words: string[], step: RuleExpr): RuleExpr => {
    const k = words.join(' ');
    let n = namesRules.get(k);
    if (!n) {
      n = `${word}$names${namesRules.size + 1}`;
      namesRules.set(k, n);
      plan.aliasOf.set(n, word!);
      plan.snakeOf.set(n, `_${toSnake(word!)}_names_${namesRules.size}`);
      copyBodies.set(n, words.length === 1 ? { type: 'literal', value: words[0] } : { type: 'alt', items: words.map(w => ({ type: 'literal', value: w })) });
    }
    const ref: RuleExpr = { type: 'ref', name: n };
    plan.stepOf.set(ref, step);
    return ref;
  };
  const copyOf = (name: string, y: Set<string>): string => copyBy(name, keyOf(y), () => filt(rules.get(name)!.body, y));
  const copyBy = (name: string, cond: string, build: () => RuleExpr | null): string => {
    const key = `${name}|${cond}`;
    const have = copies.get(key);
    if (have === null) throw new FirstFilterResidual(`${name} under ${cond}`);
    if (have) { if (inexactCopies.has(have)) siteInexact = true; return have; }
    const list = copiesOf.get(name) ?? copiesOf.set(name, []).get(name)!;
    const copy = `${name}$first${list.length + 1}`;
    plan.snakeOf.set(copy, `_${toSnake(name)}_first_${list.length + 1}`);
    copies.set(key, copy);
    list.push(copy);
    const outer = siteInexact;
    siteInexact = false;
    try {
      const body = build();
      if (!body) throw new FirstFilterResidual(`${name} has no string under ${cond}`);
      copyBodies.set(copy, body);
      plan.aliasOf.set(copy, name);
      if (siteInexact) inexactCopies.add(copy);
      siteInexact ||= outer;
      return copy;
    } catch (err) {
      copies.set(key, null);
      plan.snakeOf.delete(copy);
      list.pop();
      throw err;
    }
  };
  // Every non-empty string of `e` whose first token passes Y (null: none); `e` itself when that is all
  // of them.
  const filt = (e: RuleExpr, y: Set<string>): RuleExpr | null => {
    switch (e.type) {
      case 'literal': return test(`'${e.value}`, y) === true ? e : null;
      case 'ref': {
        if (e.hole !== undefined || tokenNames.has(e.name) || !rules.has(e.name)) return test(e.name, y) === true ? e : null;
        if (sets.nullable(e)) throw new FirstFilterResidual(`nullable rule ${e.name} in a left corner`);
        // The word token is decided at its step (by the words the step's guards reserve).
        let pass = 0, fail = 0, partial = 0;
        for (const t of sets.firstOf(e)) { const r = test(t, y); if (r === true) pass++; else if (r === false) fail++; else partial++; }
        if (!fail && !partial) return e;
        if (!pass && !partial) return null;
        if (hasMarker(rules.get(e.name)!.body)) { siteInexact = true; return null; }
        return { ...e, name: copyOf(e.name, y) };
      }
      case 'group': {
        if (e.tsRuleName) throw new FirstFilterResidual('a named tsRelax group in a left corner');
        const v = e.tsRelaxed ?? e.body;
        const r = filt(v, y);
        return r === v ? e : r;
      }
      case 'seq': {
        const alts = filtItems(e.items, 0, y);
        if (!alts) return null;
        if (alts.length === 1 && alts[0].length === e.items.length && alts[0].every((x, i) => x === e.items[i])) return e;
        const seqs = alts.map(items => items.length === 1 ? items[0] : { type: 'seq' as const, items });
        return seqs.length === 1 ? seqs[0] : { type: 'alt', items: seqs };
      }
      case 'alt': {
        const items = e.items.map(i => filt(i, y));
        if (items.every((x, i) => x === e.items[i])) return e;
        const kept = items.filter((x): x is RuleExpr => x !== null);
        return kept.length === 0 ? null : kept.length === 1 ? kept[0] : { type: 'alt', items: kept };
      }
      case 'quantifier': {
        const b = filt(e.body, y);
        if (!b) return null;
        if (e.kind === '+' && b === e.body) return e;
        return e.kind === '?' ? b : { type: 'seq', items: [b, { type: 'quantifier', kind: '*', body: e.body }] };
      }
      case 'sep': {
        const b = filt(e.element, y);
        if (!b) return null;
        const d: RuleExpr = { type: 'literal', value: e.delimiter };
        return { type: 'seq', items: [b, { type: 'quantifier', kind: '*', body: { type: 'seq', items: [d, e.element] } }, { type: 'quantifier', kind: '?', body: d }] };
      }
      case 'prefix': case 'op': case 'postfix':
        throw new FirstFilterResidual(`a Pratt ${e.type} marker in a left corner`);   // reached only through hasMarker above
      default: return null;                         // a zero-width assertion alone: no non-empty string
    }
  };
  // The item lists (alternatives) of `items[i..]` restricted by Y on their first token; `end`: what may
  // follow the list (its rule's FOLLOW, for an arm of the rule), else null.
  const filtItems = (items: RuleExpr[], i: number, y: Set<string>, end: Set<string> | null = null): RuleExpr[][] | null => {
    if (i >= items.length) return null;
    const x = items[i], v = tsView(x);
    if (ASSERTION_KINDS.has(v.type)) {
      const rest = filtItems(items, i + 1, y, end);
      return rest && rest.map(r => [x, ...r]);
    }
    if (v.type === 'ref' && v.name === word) {
      // The word step: the words its own guards (the `not`s right before it) already reserve.
      const reservedHere = new Set<string>();
      for (let j = i - 1; j >= 0 && ASSERTION_KINDS.has(tsView(items[j]).type); j--) {
        const ws = reservedGuardWords(items[j], x, word, isWordLiteral);
        if (ws) for (const w of ws) reservedHere.add(w);
      }
      const r = test(word, y, reservedHere);
      if (r === false) return null;
      return [[r === true ? x : namesRef(r, v), ...items.slice(i + 1)]];
    }
    const out: RuleExpr[][] = [];
    const own = filt(x, y);
    if (own) out.push([own, ...items.slice(i + 1)]);
    if (sets.nullable(x)) {
      if (i + 1 < items.length) {
        const rest = filtItems(items, i + 1, y, end);
        if (rest) out.push(...rest);
      } else if (!end || [...end].some(t => test(t, y) !== false)) {
        throw new FirstFilterResidual('the condition reaches past the end of its sequence');
      }   // else: nothing that may follow passes, so the empty rest is dropped
    }
    return out.length ? out : null;
  };
  // A condition over token sequences: the first token passes with what must follow it, which the items
  // after it in the same sequence then meet (an alternative or an optional item is spread into the
  // sequence, a rule whose FIRST meets a longer path is copied under the condition). A path that would
  // run past the sequence's end is left recorded.
  const itemsOf = (e: RuleExpr): RuleExpr[] => { const v = tsView(e); return v.type === 'seq' ? v.items : [v]; };
  const deepItems = (items: RuleExpr[], i: number, c: Cond, end: Set<string> | null): RuleExpr[][] | null => {
    const y = flat(c);
    if (y) return filtItems(items, i, y, end);
    if (i >= items.length) throw new FirstFilterResidual('a token sequence runs past the end of its sequence');
    const x = items[i], v = tsView(x), rest = items.slice(i + 1);
    const prefix = (r: RuleExpr[][] | null) => r && r.map(xs => [x, ...xs]);
    const spread = (arms: RuleExpr[][]) => {
      const out = arms.map(a => deepItems([...a, ...rest], 0, c, end)).filter((r): r is RuleExpr[][] => !!r).flat();
      return out.length ? out : null;
    };
    if (ASSERTION_KINDS.has(v.type)) return prefix(deepItems(items, i + 1, c, end));
    if (v.type === 'ref' && v.name === word) {
      // The word step as each word of the condition its guards do not reserve: one names reading per
      // continuation (the words that end the condition share one).
      const reservedHere = new Set<string>();
      for (let j = i - 1; j >= 0 && ASSERTION_KINDS.has(tsView(items[j]).type); j--) for (const w of reservedGuardWords(items[j], x, word, isWordLiteral) ?? []) reservedHere.add(w);
      if (c.has(word)) throw new FirstFilterResidual('a token sequence through the word token');
      const out: RuleExpr[][] = [];
      const ending = [...c].filter(([t, n]) => n === null && isWordShaped(t) && !reservedHere.has(t.slice(1))).map(([t]) => t.slice(1)).sort();
      if (ending.length) out.push([namesRef(ending, v), ...rest]);
      for (const [t, n] of c) {
        if (n === null || !isWordShaped(t) || reservedHere.has(t.slice(1))) continue;
        const r = deepItems(items, i + 1, n, end);
        if (r) out.push(...r.map(xs => [namesRef([t.slice(1)], v), ...xs]));
      }
      return out.length ? out : null;
    }
    if (v.type === 'literal' || (v.type === 'ref' && v.name !== word && (tokenNames.has(v.name) || !rules.has(v.name)))) {
      const t = v.type === 'literal' ? `'${v.value}` : v.name;
      const n = c.has(t) ? c.get(t)! : word !== undefined && isWordShaped(t) && c.has(word) ? c.get(word)! : undefined;
      if (n === undefined) return null;
      return n === null ? [[x, ...rest]] : prefix(deepItems(items, i + 1, n, end));
    }
    if (v.type === 'alt') return spread(v.items.map(itemsOf));
    if (v.type === 'seq') return spread([v.items]);
    if (v.type === 'quantifier' && v.kind === '?') return spread([itemsOf(v.body), []]);
    if (v.type === 'quantifier') return spread(v.kind === '*' ? [[...itemsOf(v.body), x], []] : [[...itemsOf(v.body), { type: 'quantifier', kind: '*', body: v.body }]]);
    if (v.type === 'ref' && rules.has(v.name) && v.name !== word) {
      if (sets.nullable(v)) throw new FirstFilterResidual(`nullable rule ${v.name} in a left corner`);
      const first = sets.firstOf(v);
      const deep = [...c].filter(([t, n]) => n !== null && (first.has(t) || (t === word && [...first].some(isWordShaped))));
      if (!deep.length) {
        const own = filt(x, new Set([...c].filter(([, n]) => n === null).map(([t]) => t)));
        return own ? [[own, ...rest]] : null;
      }
      if (hasMarker(rules.get(v.name)!.body)) { siteInexact = true; return null; }
      const body = rules.get(v.name)!.body;
      const copy = copyBy(v.name, condKey(c), () => {
        const arms = deepItems([body], 0, c, null);
        return arms && (arms.length === 1 ? { type: 'seq', items: arms[0] } : { type: 'alt', items: arms.map(a => ({ type: 'seq' as const, items: a })) });
      });
      return [[{ ...v, name: copy }, ...rest]];
    }
    throw new FirstFilterResidual(`a token sequence through ${v.type}`);
  };
  // What may follow a site's sequence, when that sequence is an arm of its rule.
  const armEnds = new Map<RuleExpr, Set<string>>();
  for (const r of grammar.rules) for (const a of r.body.type === 'alt' ? r.body.items : [r.body]) if (a.type === 'seq') armEnds.set(a, sets.follow.get(r.name)!);

  // ── the sites: a sequence's positive conditions and the item they stand before ──
  const rendered = new Map<RuleExpr, boolean>();           // condition node → rendered at every site so far
  const memo = new Map<RuleExpr, RuleExpr>();
  const rw = (e: RuleExpr): RuleExpr => {
    const m = memo.get(e);
    if (m) return m;
    let out: RuleExpr = e;
    switch (e.type) {
      case 'seq': {
        let items = e.items.map(rw);
        if (!lowerNotBeforeOptional(e)) {
          for (let i = 0; i < items.length; i++) {
            const y0 = conditionOf(tsView(items[i]));
            if (!y0) continue;
            // The positive conditions up to the next consuming item (more than one meet as one-token
            // conditions only).
            let y: Cond = y0, j = i + 1;
            const conds = [tsView(items[i])];
            let unmet = false;
            for (; j < items.length && ASSERTION_KINDS.has(tsView(items[j]).type); j++) {
              const c = conditionOf(tsView(items[j]));
              if (!c) continue;
              const a = flat(y), b = flat(c);
              if (a && b) y = new Map([...a].filter(t => b.has(t)).map(t => [t, null]));
              else unmet = true;
              conds.push(tsView(items[j]));
            }
            let alts: RuleExpr[][] | null = null;
            siteInexact = false;
            try { alts = j < items.length && !unmet ? deepItems(items, i, y, armEnds.get(e) ?? null) : null; } catch (err) { if (!(err instanceof FirstFilterResidual)) throw err; }
            for (const c of conds) { rendered.set(c, (rendered.get(c) ?? true) && !!alts); if (siteInexact) inexact.add(c); }
            if (!alts) { i = j - 1; continue; }
            const head = items.slice(0, i);
            items = [...head, ...(alts.length === 1 ? alts[0] : [{ type: 'alt' as const, items: alts.map(a => ({ type: 'seq' as const, items: a })) }])];
            i = alts.length === 1 ? head.length + (j - i) : items.length;
          }
        }
        if (items.length !== e.items.length || items.some((x, k) => x !== e.items[k])) out = { ...e, items };
        break;
      }
      case 'alt': { const items = e.items.map(rw); if (items.some((x, k) => x !== e.items[k])) out = { ...e, items }; break; }
      case 'quantifier': { const b = rw(e.body); if (b !== e.body) out = { ...e, body: b }; break; }
      case 'sep': { const el = rw(e.element); if (el !== e.element) out = { ...e, element: el }; break; }
      case 'group': {
        if (e.tsRuleName) break;
        if (e.tsRelaxed) { const t = rw(e.tsRelaxed); if (t !== e.tsRelaxed) out = { ...e, tsRelaxed: t }; }
        else { const b = rw(e.body); if (b !== e.body) out = { ...e, body: b }; }
        break;
      }
    }
    memo.set(e, out);
    return out;
  };
  const rewritten = grammar.rules.map(r => { const b = rw(r.body); return b === r.body ? r : { ...r, body: b }; });
  // A copy's body holds the original nodes, so a site inside it is the site of the original: rewrite
  // the copies' bodies with the same memo (a copy made while rewriting one is rewritten in turn).
  for (let changed = true; changed; ) {
    changed = false;
    for (const [n, b] of copyBodies) { const r = rw(b); if (r !== b) { copyBodies.set(n, r); changed = true; } }
  }
  for (const [n, ok] of rendered) if (ok && !inexact.has(n)) plan.lowered.add(n);
  // Only the copies a rendered rule reaches (one made for a site that then failed is not).
  const reached = new Set<string>();
  const reach = (e: RuleExpr): void => {
    switch (e.type) {
      case 'ref': if (copyBodies.has(e.name) && !reached.has(e.name)) { reached.add(e.name); reach(copyBodies.get(e.name)!); } return;
      case 'seq': case 'alt': e.items.forEach(reach); return;
      case 'quantifier': reach(e.body); return;
      case 'sep': reach(e.element); return;
      case 'group': reach(e.tsRelaxed ?? e.body); return;
    }
  };
  for (const r of rewritten) reach(r.body);
  for (const n of [...copyBodies.keys()]) if (!reached.has(n)) { copyBodies.delete(n); plan.aliasOf.delete(n); plan.snakeOf.delete(n); }
  if (!copyBodies.size) return plan;
  const out: RuleDecl[] = [];
  const entry = rewritten[rewritten.length - 1];
  const copiesFor = (r: RuleDecl) => (copiesOf.get(r.name) ?? []).filter(c => reached.has(c)).map(c => ({ ...r, name: c, body: copyBodies.get(c)! }));
  for (const r of rewritten.slice(0, -1)) out.push(r, ...copiesFor(r));
  out.push(...copiesFor(entry));
  for (const n of namesRules.values()) if (reached.has(n)) out.push({ name: n, body: copyBodies.get(n)!, flags: [] });
  out.push(entry);
  plan.grammar = { ...grammar, rules: out };
  return plan;
}

// ── The tree-sitter view as Glushkov positions ───────────────────────────────
// What an LR question about the generated grammar is asked over (lr-automaton.ts): every literal /
// token / rule reference of a rendered rule body is one leaf. It follows renderExpr: the tree-sitter
// view of each group (a named tsRelax group is its own rule), the lowered `not` before an optional,
// zero-width assertions dropped except the ones a plan renders as a zero-width external token
// (`zeroWidth`: a `sameLine` node, or an `alt` whose pure-assertion arms become one token), and a
// Pratt rule as its operator productions (one choice of operators per position, as buildPrattRule
// renders them; what stands between the operand and a postfix operator is kept).
interface TsLeafGraph extends LeafGraph {
  /** Per leaf: the RuleExpr it was built from (null for a synthesized one). */
  node: (RuleExpr | null)[];
  ruleNames: string[];
}

function treeSitterLeafGraph(grammar: CstGrammar, tokenNames: Set<string>, scannerTokens: Set<string>, prattRules: Set<string>,
  zeroWidth: Map<RuleExpr, string>): TsLeafGraph {
  const sym: string[] = [], nt: number[] = [], rule: number[] = [], follow: number[][] = [], isLast: boolean[] = [];
  const node: (RuleExpr | null)[] = [];
  const ruleNames: string[] = [];
  const ruleIdx = new Map<string, number>();
  const ruleOf = (name: string) => { let i = ruleIdx.get(name); if (i === undefined) { i = ruleNames.length; ruleNames.push(name); ruleIdx.set(name, i); } return i; };
  for (const r of grammar.rules) ruleOf(r.name);
  const shared = collectTsSharedRules(grammar);
  type G = { first: number[]; last: number[]; nullable: boolean };
  const EMPTY: G = { first: [], last: [], nullable: true };
  let cur = 0;
  const leaf = (s: string, n: RuleExpr | null, ref: number): G => {
    const id = sym.length;
    sym.push(s); nt.push(ref); rule.push(cur); follow.push([]); isLast.push(false); node.push(n);
    return { first: [id], last: [id], nullable: false };
  };
  const link = (from: number[], to: number[]) => { for (const f of from) for (const t of to) follow[f].push(t); };
  const seq = (gs: G[]): G => gs.reduce((a, b) => {
    link(a.last, b.first);
    return { first: a.nullable ? [...a.first, ...b.first] : a.first, last: b.nullable ? [...a.last, ...b.last] : b.last, nullable: a.nullable && b.nullable };
  }, EMPTY);
  const alt = (gs: G[]): G => ({ first: gs.flatMap(g => g.first), last: gs.flatMap(g => g.last), nullable: gs.length === 0 || gs.some(g => g.nullable) });
  const star = (g: G): G => { link(g.last, g.first); return { ...g, nullable: true }; };
  const pureAssertion = (e: RuleExpr) => { const v = tsView(e); return (v.type === 'seq' ? v.items : [v]).every(i => ASSERTION_KINDS.has(tsView(i).type)); };
  const build = (e: RuleExpr): G => {
    // A named tsRelax group is its own rule (renderExpr references it; its body renders once, from
    // the first occurrence: collectTsSharedRules), so it is a reference here, not its body inlined.
    if (e.type === 'group' && e.tsRuleName) return leaf(e.tsRuleName, null, ruleOf(e.tsRuleName));
    e = tsView(e);
    switch (e.type) {
      case 'literal': return leaf(`'${e.value}`, e, -1);
      case 'ref':
        if (e.hole !== undefined || tokenNames.has(e.name) || scannerTokens.has(e.name)) return leaf(e.name, e, -1);
        return leaf(e.name, e, ruleOf(e.name));
      case 'seq': {
        const low = lowerNotBeforeOptional(e);
        if (low) return build(low);
        return seq(e.items.map(i => {
          const z = zeroWidth.get(tsView(i));
          if (z) return leaf(z, tsView(i), -1);
          return ASSERTION_KINDS.has(tsView(i).type) ? EMPTY : build(i);
        }));
      }
      case 'alt': {
        const z = zeroWidth.get(e);
        if (!z) return alt(e.items.map(build));
        return alt([...e.items.filter(i => !pureAssertion(i)).map(build), leaf(z, e, -1)]);
      }
      case 'sameLine': { const z = zeroWidth.get(e); return z ? leaf(z, e, -1) : EMPTY; }
      case 'quantifier': { const g = build(e.body); if (e.kind === '?') return { ...g, nullable: true }; const s = star(g); return e.kind === '+' ? { ...s, nullable: g.nullable } : s; }
      case 'sep': {
        const el = build(e.element);
        const tail = star(seq([leaf(`'${e.delimiter}`, null, -1), build(e.element)]));
        return { ...seq([el, tail, { ...leaf(`'${e.delimiter}`, null, -1), nullable: true }]), nullable: true };
      }
      default: return EMPTY;
    }
  };
  const ops = (pos: 'infix' | 'prefix' | 'postfix'): RuleExpr => ({ type: 'alt', items: grammar.precs.flatMap(l => l.operators.filter(o => (o.position === 'prefix' || o.position === 'postfix' ? o.position : 'infix') === pos).map(o => ({ type: 'literal' as const, value: o.value }))) });
  const bodyOf = (name: string): RuleExpr => {
    const r = grammar.rules.find(x => x.name === name);
    if (!r) return shared.get(name)!;
    if (!prattRules.has(name)) return r.body;
    const alts = r.body.type === 'alt' ? r.body.items : [r.body];
    const itemsOf = (a: RuleExpr) => a.type === 'seq' ? a.items : [a];
    const out = alts.filter(a => !itemsOf(a).some(i => i.type === 'op' || i.type === 'prefix' || i.type === 'postfix'));
    for (const pos of ['op', 'prefix', 'postfix'] as const) {
      const arm = alts.find(a => itemsOf(a).some(i => i.type === pos));
      if (!arm) continue;
      const items = itemsOf(arm), at = items.findIndex(i => i.type === pos);
      // What stands between the operand and the operator (a postfix operator's `sameLine`). The
      // operands are the arm's own (a FIRST-filtered copy's left operand is the copy).
      const between = pos === 'prefix' ? [] : items.slice(1, at);
      const left = items[0], right = items[at + 1];
      out.push({ type: 'seq', items: pos === 'op' ? [left, ...between, ops('infix'), right] : pos === 'prefix' ? [ops('prefix'), right] : [left, ...between, ops('postfix')] });
    }
    return { type: 'alt', items: out };
  };
  const first: number[][] = [], nullable: boolean[] = [];
  for (let i = 0; i < ruleNames.length; i++) {   // ruleNames grows while tsRelax rules are met
    cur = i;
    const g = build(bodyOf(ruleNames[i]));
    for (const l of g.last) isLast[l] = true;
    first[i] = g.first; nullable[i] = g.nullable;
  }
  return { sym, nt, rule, follow, isLast, first, nullable, entry: ruleOf(grammar.rules[grammar.rules.length - 1].name), node, ruleNames };
}

// ── Zero-width tokens: `sameLine` and the line-end alternatives (planZeroWidth) ──
// A CFG cannot see a line break. Two shapes of the grammar's line-break assertions are rendered as
// zero-width EXTERNAL tokens, which the generated scanner returns by looking at the input:
//   - a line-end alternative: an `alt` whose arms that consume nothing are `not(sameLine)` (a line
//     break before the next token, or the end of the input) or a positive one-token lookahead
//     `not(not(Y))` (JavaScript's asi(): `;`, or a line break, or `}`). Its token stands for those arms.
//   - a same-line marker: a `sameLine` item of a sequence (a restricted production: `return` and its
//     argument, a postfix `++`, `async` and `function`). Its token stands where the assertion is.
// The scanner cannot see the parse state, only which external tokens it holds valid. So each token
// carries two sets of terminals, both derived from the LR automaton of the generated grammar
// (lr-automaton.ts) over every state where the token is valid:
//   - AFTER: what may come right after the token (the terminals valid once it is shifted);
//   - CONT: what the same states can take WITHOUT the token (a continuation of what precedes it:
//     an infix operator after an expression, `(` of a call).
// The token is returned when its assertion holds, the next token is in AFTER and it is not in CONT:
// a continuation wins, as in the interpreter, where what precedes the assertion has already consumed
// every token it can (`a \n (b)` is a call, `a \n ++b` two statements, since the postfix `++` is
// behind its own same-line marker and so in no CONT). A same-line marker whose AFTER meets its CONT
// would lose the tokens they share, so it stays dropped (recorded as before); a line-end alternative
// whose CONT holds the word token (every word after a line break would continue) likewise.
// Tokens with the same assertion and the same two sets are one external token.
export interface ZeroWidthToken {
  snake: string;
  /** A line-end alternative (its arms below) or a same-line marker. */
  kind: 'line-end' | 'same-line';
  /** line-end: a `not(sameLine)` arm (a line break before the next token, or the end of the input). */
  lineBreak: boolean;
  /** line-end: the terminals of its `not(not(Y))` arms. */
  ahead: string[];
  after: Set<string>;
  cont: Set<string>;
  /** The guards (the words each excludes) of the word-token steps that may come right after the
   *  token: a keyword one of them does not exclude is the word token there, so AFTER holds it. */
  afterWordGuards: Set<string>[];
}
interface ZeroWidthPlan {
  tokens: ZeroWidthToken[];
  /** The rendered node (a `sameLine`, or an `alt` with line-end arms) → its token. */
  tokenOf: Map<RuleExpr, ZeroWidthToken>;
  /** The assertion nodes the tokens render (the ledger's `lowered`). */
  lowered: Set<RuleExpr>;
}


function planZeroWidth(grammar: CstGrammar, tokenNames: Set<string>, scannerTokens: Set<string>, prattRules: Set<string>,
  isWordLiteral: (text: string) => boolean, reserved: Set<string>): ZeroWidthPlan {
  const plan: ZeroWidthPlan = { tokens: [], tokenOf: new Map(), lowered: new Set() };
  // A grammar with its own line handling (NEWLINE tokens, indentation) has its own scanner rules.
  if (grammar.indent || grammar.newline) return plan;
  const word = grammar.tokens.find(t => t.identifier)?.name;
  const guards = wordStepGuards(grammar, word, isWordLiteral);
  const tokSet = (e: RuleExpr): string[] | null => {
    e = tsView(e);
    if (e.type === 'literal') return [`'${e.value}`];
    if (e.type === 'ref') return tokenNames.has(e.name) ? [e.name] : null;
    if (e.type === 'seq' && e.items.length === 1) return tokSet(e.items[0]);
    if (e.type === 'alt') { const out: string[] = []; for (const i of e.items) { const s = tokSet(i); if (!s) return null; out.push(...s); } return out; }
    return null;
  };
  // ── candidates ──
  type Cand = { node: RuleExpr; kind: ZeroWidthToken['kind']; lineBreak: boolean; ahead: string[]; asserts: RuleExpr[] };
  const cands: Cand[] = [];
  const seen = new Set<RuleExpr>();
  const armItems = (a: RuleExpr) => { const v = tsView(a); return (v.type === 'seq' ? v.items : [v]).map(tsView); };
  const walk = (e: RuleExpr): void => {
    e = tsView(e);
    if (seen.has(e)) return;
    seen.add(e);
    switch (e.type) {
      case 'seq':
        for (const i of e.items) {
          const v = tsView(i);
          if (v.type === 'sameLine') cands.push({ node: v, kind: 'same-line', lineBreak: false, ahead: [], asserts: [v] });
          else walk(i);
        }
        return;
      case 'alt': {
        const pure = e.items.filter(a => armItems(a).every(i => ASSERTION_KINDS.has(i.type)));
        let lineBreak = false; const ahead: string[] = []; let ok = pure.length > 0 && pure.length < e.items.length;
        for (const a of pure) {
          const items = armItems(a);
          if (items.length !== 1 || items[0].type !== 'not') { ok = false; break; }
          const body = tsView((items[0] as RuleExpr & { type: 'not' }).body);
          if (body.type === 'sameLine') { lineBreak = true; continue; }
          const y = body.type === 'not' ? tokSet(body.body) : null;
          if (!y) { ok = false; break; }
          ahead.push(...y);
        }
        if (ok && lineBreak) cands.push({ node: e, kind: 'line-end', lineBreak, ahead, asserts: pure.map(a => armItems(a)[0]) });
        for (const a of e.items) walk(a);
        return;
      }
      case 'quantifier': return walk(e.body);
      case 'sep': return walk(e.element);
    }
  };
  for (const r of grammar.rules) walk(r.body);
  for (const b of collectTsSharedRules(grammar).values()) walk(b);
  if (!cands.length) return plan;

  // ── AFTER / CONT of the live candidates, over the automaton where each is its own terminal and
  // every other candidate renders as nothing (as a dropped one will) ──
  const analyze = (live: Set<number>) => {
  const termOf = new Map(cands.flatMap((c, i) => live.has(i) ? [[c.node, `@zw${i}`] as [RuleExpr, string]] : []));
  const graph = treeSitterLeafGraph(grammar, tokenNames, scannerTokens, prattRules, termOf);
  const lr = buildLr(graph);
  const after = cands.map(() => new Set<string>()), cont = cands.map(() => new Set<string>());
  const afterGuards = cands.map(() => new Map<string, Set<string>>());
  const idOf = (t: string) => t.startsWith('@zw') ? +t.slice(3) : -1;
  const valid = lr.states.map((_, s) => lr.valid(s));
  // The terminals that may come first after a leaf in its rule (through nullable rules).
  const firstMemo = new Map<number, Set<string>>();
  const firstAfter = (l: number): Set<string> => {
    let out = firstMemo.get(l);
    if (out) return out;
    firstMemo.set(l, out = new Set());
    const seenL = new Set<number>();
    const go = (ls: number[]) => {
      for (const x of ls) {
        if (seenL.has(x)) continue; seenL.add(x);
        const n = graph.nt[x];
        if (n < 0) { out!.add(graph.sym[x]); continue; }
        go(graph.first[n]);
        if (graph.nullable[n]) go(graph.follow[x]);
      }
    };
    go(graph.follow[l]);
    return out;
  };
  lr.states.forEach((st, s) => {
    // CONT: the terminals SHIFTED where the token is valid (a reduction's lookahead is no
    // continuation: the `)` after `(a` is valid after `a` in no state that also ends a statement;
    // the shift sets are exact per LR(0) core, the lookaheads a union over its contexts), and of
    // those only the ones that EXTEND a construct already complete (an item after a rule reference:
    // the operator after an expression, the `(` of a call, `[`, a template, `of`). A terminal that
    // starts an operand after a terminal (the optional argument of `yield`, `=>` after a parameter
    // name, a prefix `++` after `yield`) is where the grammar would need a line-break restriction of
    // its own; the scanner cannot tell that state from the many where the same terminal follows the
    // token, so there the token wins.
    const extends_ = new Set<string>();
    for (const it of st.items) if (it >= 0 && graph.nt[it] >= 0) for (const t of firstAfter(it)) extends_.add(t);
    for (const t of valid[s]) {
      const i = idOf(t);
      if (i < 0) continue;
      for (const u of extends_) if (idOf(u) < 0) cont[i].add(u);
    }
    for (const [sym, to] of st.goto) {
      const i = idOf(sym);
      if (i < 0) continue;
      for (const u of valid[to]) if (idOf(u) < 0) after[i].add(u);
      // The word steps that may come next, by their guards: where one lets a keyword be a name,
      // the keyword is the word token after the token (the async arrow's parameter guard lets `true`
      // be one in `async true => 1`; a class member name after `async` is unguarded).
      for (const l of lr.states[to].next) {
        if (graph.sym[l] !== word || graph.nt[l] >= 0) continue;
        const ex = (graph.node[l] && guards.get(graph.node[l]!)) || new Set<string>();
        afterGuards[i].set([...ex].sort().join(' '), ex);
      }
    }
  });
  return { after, cont, afterGuards };
  };
  // A keyword the word token can also lex (one no reserved set excludes from it everywhere).
  const wordShaped = (t: string) => t === word || (t.startsWith("'") && isWordLiteral(t.slice(1)) && !reserved.has(t.slice(1)));
  const meets = (a: Set<string>, b: Set<string>) =>
    [...a].some(t => b.has(t)) || (!!word && ((a.has(word) && [...b].some(wordShaped)) || (b.has(word) && [...a].some(wordShaped))));
  const rejects = (i: number, r: ReturnType<typeof analyze>) =>
    !r.after[i].size || (cands[i].kind === 'same-line' ? meets(r.after[i], r.cont[i]) : (!!word && r.cont[i].has(word)));
  // A dropped candidate renders as nothing, which changes what the others can see (a postfix `!`
  // whose marker is dropped is a direct continuation): analyze again until nothing more drops.
  const live = new Set(cands.map((_, i) => i));
  let res = analyze(live);
  for (;;) {
    const out = [...live].filter(i => rejects(i, res));
    if (!out.length) break;
    for (const i of out) live.delete(i);
    res = analyze(live);
  }
  const { after, cont, afterGuards } = res;
  const byKey = new Map<string, ZeroWidthToken>();
  const counters = { 'line-end': 0, 'same-line': 0 };
  cands.forEach((c, i) => {
    if (!live.has(i)) return;
    // Line-end alternatives with the same arms are ONE token whose sets are the union over its uses:
    // a token per statement kind would keep tree-sitter from sharing the states of an expression's
    // end between the statements it can end (JavaScript, measured locally: 2,462 states with four
    // line-end tokens, 1,818 with one; master 1,812). The price: the scanner reads one CONT for every
    // use, so a token that continues only some statement (an operator after an expression) also keeps
    // a line break from ending the others (`break\n(x)` is `break (x)`, an ERROR, where the grammar
    // ends `break` at the line break). Same-line markers keep one token per distinct pair of sets:
    // their CONT differs in what must stay possible on the same line (`return x`).
    const key = c.kind === 'line-end'
      ? [c.kind, c.lineBreak, [...c.ahead].sort().join(' ')].join('|')
      : [c.kind, [...after[i]].sort().join(' '), [...cont[i]].sort().join(' ')].join('|');
    let tok = byKey.get(key);
    if (!tok) {
      tok = { snake: `_${c.kind === 'line-end' ? 'line_end' : 'same_line'}_${++counters[c.kind]}`, kind: c.kind, lineBreak: c.lineBreak, ahead: [...new Set(c.ahead)].sort(), after: new Set(), cont: new Set(), afterWordGuards: [] };
      byKey.set(key, tok);
      plan.tokens.push(tok);
    }
    for (const x of after[i]) tok.after.add(x);
    for (const x of cont[i]) tok.cont.add(x);
    for (const ex of afterGuards[i].values()) tok.afterWordGuards.push(ex);
    plan.tokenOf.set(c.node, tok);
    for (const a of c.asserts) plan.lowered.add(a);
  });
  return plan;
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
  // A token with a BLOCK-context variant (YAML's scalar tokens: a block plain/key stops at a `: `
  // separator and a value end, where the flow variant runs through them) — emit the block pattern.
  // The tree-sitter grammar is block-context at the top level; flow collections are their own rules.
  // Block-only (no `pattern`) and dual tokens both resolve here; YAML is the only grammar with a
  // blockPattern, so every other language is unaffected (byte-identical).
  const src = tokenPatternSource({ pattern: shortestUntil(tok.blockPattern ?? tok.pattern, name) });
  return `token(${jsRegexLiteral(sanitizeTreeSitterRegex(src))})`;
}

// ── A non-greedy run up to a terminator, as a regular expression ──
// tree-sitter's lexer is a DFA that takes the LONGEST token: a non-greedy repeat renders greedy and
// its look-ahead is dropped (sanitizeTreeSitterRegex), so `'/*' (not '*/' any)*? '*/'` became
// `/\*[\s\S]*\*\//`, which runs from the first `/*` to the LAST `*/` of the input: two block
// comments with code between them were one comment (`/** a */ interface P { /** b */ }` an ERROR).
// The language the pattern means, every string without the terminator and then the terminator, is
// regular, and is written here directly: `(?:[^a]|a+[^ab])*a+b` for a two-character terminator `ab`
// (a ≠ b), `[^a]*a` for one character. Any other non-greedy repeat has no rendering: it fails loudly.
function shortestUntil(p: TokenPattern, token: string): TokenPattern {
  if (typeof p === 'string') return p;
  const lazyRun = (x: TokenPattern): string | null => {
    if (typeof x === 'string' || x.type !== 'repeat' || x.greedy || x.min !== 0 || x.max !== undefined) return null;
    const b = x.body;
    if (typeof b === 'string' || b.type !== 'seq' || b.items.length !== 2) return null;
    const [la, any] = b.items;
    if (typeof la === 'string' || la.type !== 'lookahead' || !la.negate || typeof la.body !== 'string') return null;
    return typeof any !== 'string' && any.type === 'anyChar' ? la.body : null;
  };
  const not = (...cs: string[]): TokenPattern => ({ type: 'charClass', negate: true, items: cs.map(value => ({ type: 'char' as const, value })) });
  const plus = (c: string): TokenPattern => ({ type: 'repeat', body: c, min: 1, greedy: true });
  switch (p.type) {
    case 'seq': {
      const items: TokenPattern[] = [];
      for (let i = 0; i < p.items.length; i++) {
        const t = lazyRun(p.items[i]);
        if (t !== null && p.items[i + 1] === t) {
          const [a, b] = [...t];
          if (t.length === 1) items.push({ type: 'repeat', body: not(a), min: 0, greedy: true }, a);
          else if (t.length === 2 && a !== b) items.push({ type: 'repeat', body: { type: 'alt', items: [not(a), { type: 'seq', items: [plus(a), not(a, b)] }] }, min: 0, greedy: true }, plus(a), b);
          else throw new Error(`gen-treesitter: token ${token}: a non-greedy run up to ${JSON.stringify(t)} has no tree-sitter rendering`);
          i++;
          continue;
        }
        items.push(shortestUntil(p.items[i], token));
      }
      return { ...p, items };
    }
    case 'alt': return { ...p, items: p.items.map(x => shortestUntil(x, token)) };
    case 'repeat':
      if (!p.greedy) throw new Error(`gen-treesitter: token ${token}: a non-greedy repeat has no tree-sitter rendering (the lexer takes the longest match)`);
      return { ...p, body: shortestUntil(p.body, token) };
    default: return p;
  }
}

// ── conflicts ────────────────────────────────────────────────────────────────

/**
 * Derive `conflicts` entries: the purely-structural heuristics (generics-vs-comparison,
 * arrow-vs-paren), plus the tuples the grammar itself declares in `treeSitterConflicts`.
 *
 * The exact, minimal set of N-way tuples is an LR(1)-table property — pairwise structural
 * over-approximation is NOT enough (some states need a specific 3- or 4-rule tuple, e.g.
 * `block`/`expr`/`decl` for `export { } <`), and reproducing it here would mean re-deriving
 * tree-sitter's own table construction. So the grammar declares tree-sitter's analysis of it as
 * data (`node test/collect-conflicts.ts` runs the generate→"add a conflict" loop to a fixpoint and
 * prints the tuples), and this emits exactly those — no name-keyed table shared across languages.
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

  // 3. A continuation that ends in another rule meets that rule's continuations (openTail).
  for (const c of openTailConflicts(ctx)) push(c);

  // 4. The tuples the grammar declares. A symbol may be a RULE, a TOKEN (YAML's `key`/`plain` are
  //    tokens that conflict on a trailing `:`), or a shared hidden tsRelax rule (`type_fn_param`);
  //    all three are valid `$.<name>` conflict symbols. A name the grammar does not define is a
  //    declaration error, not a tuple to skip.
  const tokenSnakes = new Set(ctx.tokenSnake.values());
  const templateRules = new Set((ctx.templatePlan?.holes ?? []).flatMap(h => [h.ruleSnake, h.substRuleSnake]));
  for (const tuple of g.treeSitterConflicts ?? []) {
    const unknown = tuple.filter(r => !ruleSnakes.has(r) && !tokenSnakes.has(r) && !ctx.tsSharedRules.has(r) && !templateRules.has(r));
    if (unknown.length) throw new Error(`${g.name ?? 'grammar'}: treeSitterConflicts [${tuple.join(', ')}] names undefined symbol(s): ${unknown.join(', ')}`);
    push(tuple);
  }

  // A FIRST-filtered copy meets what its original meets: every tuple naming a copied rule is
  // declared for each choice of the original or one of its copies in that place; and a copy meets its
  // original where the grammar had two alternatives over the same strings, which one rule kept as one
  // item (TypeScript's `export default @d class`: the decorated-declaration arm reads its decorators
  // through the copy, the class arm through the original).
  const copiesOf = new Map<string, string[]>();
  for (const [copy, of] of ctx.firstFilters.aliasOf) {
    if (ctx.tokenNames.has(of)) continue;
    const o = ctx.ruleSnake.get(of)!;
    (copiesOf.get(o) ?? copiesOf.set(o, []).get(o)!).push(ctx.ruleSnake.get(copy)!);
  }
  if (copiesOf.size) {
    for (const tuple of [...conflicts]) {
      let variants: string[][] = [[]];
      for (const r of tuple) variants = variants.flatMap(v => [r, ...(copiesOf.get(r) ?? [])].map(x => [...v, x]));
      for (const v of variants) push(v);
    }
    for (const [o, cs] of copiesOf) for (const c of cs) push([o, c]);
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
 * grammar, mirroring how gen-parser.ts/emit-lexer.ts split a template into
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
  /**
   * One template rule per HOLE RULE the grammar's template references declare (RuleExpr
   * ref.hole), in first-reference order: an LR rule cannot take the hole's rule as a parameter.
   * The template whose holes are the grammar's `expression` rule is emitted under
   * `ruleSnake` / `substRuleSnake`; every other one under those names prefixed with its hole
   * rule (`type_template`), and referenced through `alias(…)` to the unprefixed names, so the
   * tree and the highlight queries see one `template` / `template_substitution` node kind.
   */
  holes: Array<{ rule: string; ruleSnake: string; substRuleSnake: string }>;
}

function planTemplate(grammar: CstGrammar): TemplatePlan | null {
  const tok = grammar.tokens.find(t => t.template);
  if (!tok || !tok.template) return null;
  const ruleSnake = toSnake(tok.name);
  const substRuleSnake = ruleSnake + '_substitution';
  const holeRules = new Set<string>();
  const walk = (e: RuleExpr): void => {
    switch (e.type) {
      case 'ref': if (e.hole !== undefined) holeRules.add(e.hole); return;
      case 'seq': case 'alt': e.items.forEach(walk); return;
      case 'quantifier': walk(e.body); return;
      case 'group': walk(e.body); if (e.tsRelaxed) walk(e.tsRelaxed); return;
      case 'sep': walk(e.element); return;
      default: return;
    }
  };
  for (const r of grammar.rules) walk(r.body);
  const taken = new Set([...grammar.rules.map(r => toSnake(r.name)), ...grammar.tokens.map(t => toSnake(t.name))]);
  const holes = [...holeRules].map((rule) => {
    if (rule === grammar.expressionRule) return { rule, ruleSnake, substRuleSnake };
    const prefixed = `${toSnake(rule)}_${ruleSnake}`;
    if (taken.has(prefixed) || taken.has(`${prefixed}_substitution`)) {
      throw new Error(`${grammar.name ?? 'grammar'}: the tree-sitter rule for '${tok.name}' with '${rule}' holes would be named '${prefixed}', which the grammar already defines`);
    }
    return { rule, ruleSnake: prefixed, substRuleSnake: `${prefixed}_substitution` };
  });
  return {
    tokenName: tok.name,
    ruleSnake,
    substRuleSnake,
    charsSnake: ruleSnake + '_chars',
    open: tok.template.open,
    interpOpen: tok.template.interpOpen,
    interpClose: tok.template.interpClose,
    holes,
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

/** The block-context SCALAR tokens of an indentation grammar (those carrying a `blockPattern`), split
 *  by their scope leaf: PLAIN `string.unquoted…`, KEY `entity.name.tag…`, NUM `constant.numeric…`,
 *  bool/null `constant.language…`. All are scanned in C (see scan_scalar) — a YAML plain/key boundary
 *  (`:(?=\S)`, `#`-after-space) is a look-around a tree-sitter token DFA can't honour, and a typed
 *  value emitted by the regex lexer would not carry the key-vs-value decision the GLR parser needs to
 *  chain top-level mapping entries. Any field may be absent. */
function planPlainScalarTokens(grammar: CstGrammar): { plain?: string; key?: string; num?: string; boolnull?: string } {
  if (!grammar.indent) return {};
  // Every token carrying a `blockPattern` is a block-context scalar; emitting num/bool-null from the
  // scanner too (classified by shape) — not via a regex token + decline — keeps every scalar an
  // external token, so the key-vs-value decision is carried and `x: 1\ny: 2` chains correctly.
  // Split by the scope leaf (the convention is data in the grammar): plain `string.unquoted`, key
  // `entity.name.tag`, num `constant.numeric`, bool/null `constant.language`.
  const fam = grammar.tokens.filter(t => t.blockPattern !== undefined && typeof t.blockPattern !== 'string');
  const num = fam.find(t => (t.scope ?? '').includes('constant.numeric'))?.name;
  const boolnull = fam.find(t => (t.scope ?? '').includes('constant.language'))?.name;
  const key = fam.find(t => (t.scope ?? '').startsWith('entity.name.tag'))?.name;
  const plain = fam.find(t => (t.scope ?? '').startsWith('string.unquoted') && !(t.scope ?? '').includes('constant.'))?.name;
  return { plain, key, num, boolnull };
}

/**
 * Synthetic external tokens for the flow-collection delimiters (`[` `]` `{` `}`). YAML's flow brackets
 * suspend indentation and turn `,`/brackets into structural separators; a tree-sitter external scanner
 * can only KEEP that state (flow_depth) across a token if it RETURNS that token (mutations during a
 * `false` return are discarded — the pre-scan state is restored before the internal bracket is lexed).
 * So the brackets are emitted by the scanner as external tokens. They have no token name in the source
 * grammar (they are bare literals in the flow rules), so we synthesize a stable name per delimiter char
 * and (a) register them as externals here and (b) substitute the matching literal in the rendered rules
 * (renderExpr). Returns [] for non-flow grammars. Order: every opener (in flowOpen order) then every
 * closer (flowClose order) — the enum / grammar.js externals follow this order.
 */
const FLOW_CHAR_NAMES: Record<string, string> = {
  '[': 'lbracket', ']': 'rbracket', '{': 'lbrace', '}': 'rbrace', '(': 'lparen', ')': 'rparen',
};
function flowSyntheticTokens(grammar: CstGrammar): { sym: string; char: string; open: boolean }[] {
  const ind = grammar.indent;
  if (!ind || !(ind.flowOpen?.length || ind.flowClose?.length)) return [];
  const name = (c: string) => `_flow_${FLOW_CHAR_NAMES[c] ?? `u${c.charCodeAt(0)}`}`;
  return [
    ...(ind.flowOpen ?? []).map(c => ({ sym: name(c), char: c, open: true })),
    ...(ind.flowClose ?? []).map(c => ({ sym: name(c), char: c, open: false })),
  ];
}

/**
 * The document-marker glyphs (`---` / `...`) of an indentation grammar, matched to
 * `indent.blockScalar.documentMarkers` by token literal prefix — used by the external scanner's
 * scan_scalar to claim a non-marker glyph as plain and decline a true marker (the markers stay
 * INTERNAL tokens; see planScannerTokens). Longest glyph first (so a 3-char glyph beats a prefix of
 * it). Empty unless the grammar declares documentMarkers.
 */
function documentMarkerGlyphs(grammar: CstGrammar): string[] {
  const markers = grammar.indent?.blockScalar?.documentMarkers;
  if (!markers || markers.length === 0) return [];
  const out = new Set<string>();
  for (const tok of grammar.tokens) {
    const lit = tokenPatternLiteralPrefix(tok);
    if (lit && markers.includes(lit)) out.add(lit);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Determine which tokens the external scanner must provide. */
function planScannerTokens(grammar: CstGrammar): Map<string, string> {
  const map = new Map<string, string>();
  // A newline-sensitive grammar's NEWLINE token is engine-emitted; in tree-sitter it becomes a
  // stateless external token (the scanner emits it at each significant line boundary). Listed
  // FIRST so it heads the enum / externals order.
  if (grammar.newline) map.set(grammar.newline.token, toSnake(grammar.newline.token));
  // An indentation-sensitive grammar (YAML): INDENT / DEDENT / NEWLINE and the block-scalar body are
  // engine-emitted — the lexer's indent stack (src/emit-lexer.ts) decides them, not a regex — so their
  // token IR is `never()`. In tree-sitter they become EXTERNAL tokens the C scanner (src/scanner.c)
  // provides; without this they would serialize as never-match token rules (`token(/[^\s\S]/)`) that
  // the parser can never match (and the block-scalar body would orphan the scalar). Ordered
  // indent/dedent/newline/body so grammar.js's `externals` and scanner.c's enum agree positionally.
  if (grammar.indent) {
    const ind = grammar.indent;
    map.set(ind.indentToken, toSnake(ind.indentToken));
    map.set(ind.dedentToken, toSnake(ind.dedentToken));
    map.set(ind.newlineToken, toSnake(ind.newlineToken));
    if (ind.blockScalar) map.set(ind.blockScalar.token, toSnake(ind.blockScalar.token));
    // The PLAIN and KEY scalars (a `:` is content unless followed by space/EOL; a `#` starts a
    // comment only after a space) need look-ahead at their boundary, which a tree-sitter `token()`
    // DFA lacks — so they too become external tokens, scanned by `scan_scalar` in C. Appended AFTER
    // the block scalar so the enum stays INDENT,DEDENT,NEWLINE,BLOCK_SCALAR,PLAIN,KEY. (Num/BoolNull
    // are NOT plain-family — their boundary is DFA-expressible — so they stay regex token rules.)
    const { plain, key, num, boolnull } = planPlainScalarTokens(grammar);
    if (plain) map.set(plain, toSnake(plain));
    if (key) map.set(key, toSnake(key));
    if (num) map.set(num, toSnake(num));
    if (boolnull) map.set(boolnull, toSnake(boolnull));
    // The flow-collection delimiter tokens (`[ ] { }`) — emitted by the scanner so flow_depth persists
    // (a TRUE return). The synthetic name IS the snake symbol; the matching literal in the flow rules is
    // swapped for a ref to it in renderExpr. Appended last so the scalar-token positions are unchanged.
    for (const { sym } of flowSyntheticTokens(grammar)) map.set(sym, sym);
    // Document markers (`---` / `...`) stay INTERNAL tokens (NOT added here). Their IR is
    // `literal + a sep look-ahead`; tree-sitter's token() DFA drops the look-ahead, leaving a bare
    // `---`/`...`. That is fine: the external scalar scanner CLAIMS a non-marker glyph (`---foo`) as a
    // plain scalar (so it never reaches the internal token) and DECLINES a true sep-bounded marker (so
    // the internal token lexes it — see scan_scalar's document-marker probe). Making them external
    // instead perturbs the GLR parse tables — a marker token's valid-symbol set then shifts the lexer's
    // scalar/indent decisions at unrelated boundaries (a same-column block sequence after a key
    // mis-lexes) — so keeping them internal leaves the tables byte-identical to a no-marker build.
  }
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
  for (const t of ctx.zeroWidth.tokens) syms.push(t.snake);
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
function buildMarkupTreeSitter(grammar: CstGrammar, grammarName: string): Omit<TreeSitterOutput, 'treeSitterJson'> {
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

  if (!hasRaw) return { grammarJs, highlightsScm, scannerC: '', externalTokens: [], assertions: [] };

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

  return { grammarJs, highlightsScm, scannerC, externalTokens: ['raw_text'], assertions: [] };
}

export function generateTreeSitter(grammar: CstGrammar, langName?: string): TreeSitterOutput {
  const name = (langName ?? (grammar as { name?: string }).name ?? 'language');
  const grammarName = toSnake(name);
  // Markup languages (HTML/Vue) get the purpose-built markup grammar, not the token-stream one.
  const out = grammar.markup ? buildMarkupTreeSitter(grammar, grammarName) : buildTokenTreeSitter(grammar, grammarName);
  return { ...out, treeSitterJson: buildTreeSitterJson(grammar, grammarName) };
}

/** tree-sitter.json, the package's tree-sitter metadata. `tree-sitter generate` emits ABI 15 only
 *  for a package that has one (it reads `metadata.version`); without it the parser is ABI 14, which
 *  has no reserved word sets: a 0.26 CLI then drops grammar.js's `reserved` silently. */
function buildTreeSitterJson(grammar: CstGrammar, grammarName: string): string {
  return JSON.stringify({
    grammars: [{ name: grammarName, scope: grammar.scopeName ?? `source.${grammarName}`, path: '.', highlights: 'queries/highlights.scm' }],
    metadata: { version: '0.0.0', license: 'MIT' },
  }, null, 2);
}

function buildTokenTreeSitter(source: CstGrammar, grammarName: string): Omit<TreeSitterOutput, 'treeSitterJson'> {
  const tokenNames = new Set(source.tokens.map(t => t.name));
  // The ledger is the source grammar's; the one-token lookaheads it leaves dropped render as
  // FIRST-filtered copies (planFirstFilters), and everything below renders the grammar with them.
  const assertions = classifyAssertions(source, tokenNames, computeTerminalSets(source, tokenNames));
  const firstFilters = planFirstFilters(source, tokenNames, computeTerminalSets(source, tokenNames),
    source.tokens.find(t => t.identifier)?.name, assertions.isWordLiteral, assertions.recordOf);
  for (const n of firstFilters.lowered) for (const rec of assertions.recordOf.get(n)!) rec.cls = 'lowered';
  const grammar = firstFilters.grammar;
  const ruleSnake = new Map<string, string>();
  const tokenSnake = new Map<string, string>();
  for (const r of grammar.rules) ruleSnake.set(r.name, firstFilters.snakeOf.get(r.name) ?? toSnake(r.name));
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
  const nameFields = collectNameFields(source);

  // ε-elimination set (see makeNonEmpty): the start rule is the entry rule, emitted FIRST below.
  const entryName = grammar.rules[grammar.rules.length - 1].name;
  const isTerminalName = (n: string) => tokenNames.has(n) || scannerTokenFor.has(n);
  const nullableNonStart = computeNullableNonStart(grammar, entryName, isTerminalName);

  const flowLiteralTokens = new Map<string, string>();
  for (const { sym, char } of flowSyntheticTokens(grammar)) flowLiteralTokens.set(char, sym);

  const terminalSets = computeTerminalSets(grammar, tokenNames);
  const zeroWidth = planZeroWidth(grammar, tokenNames, new Set(scannerTokenFor.keys()), prattRules, assertions.isWordLiteral,
    new Set(assertions.reservedSets.sets[0]?.words ?? []));
  for (const n of zeroWidth.lowered) for (const rec of assertions.recordOf.get(n)!) rec.cls = 'lowered';
  for (const t of zeroWidth.tokens) externalSnake.add(t.snake);
  const wordTok = grammar.tokens.find(t => t.identifier)?.name;
  const wordLiterals = wordTok ? collectWordLiterals(grammar, assertions.isWordLiteral) : [];
  // The keywords given a name reading: the grammar's declared subset (`treeSitterContextualNames`), or
  // every keyword. A listed word that is no keyword some step reads as a name is a declaration error.
  const declared = grammar.treeSitterContextualNames;
  const names = declared === undefined || declared === 'all' ? wordLiterals : declared;
  const contextual = wordTok && names.length
    ? planContextualWords(grammar,
      treeSitterLeafGraph(grammar, tokenNames, new Set(scannerTokenFor.keys()), prattRules, new Map([...zeroWidth.tokenOf].map(([n, t]) => [n, t.snake]))),
      wordTok, names, assertions.isWordLiteral)
    : null;
  if (Array.isArray(declared)) {
    const read = new Set([...contextual?.plan.values() ?? []].flat());
    const idle = declared.filter(w => !read.has(w));
    if (idle.length) throw new Error(`${grammar.name ?? 'grammar'}: treeSitterContextualNames lists ${idle.join(', ')}, which no word step reads as a name`);
  }
  const ctx: GrammarJsContext = {
    grammar, tokenNames, ruleSnake, tokenSnake, prattRules, externalSnake, scannerTokenFor, zeroWidth,
    flowLiteralTokens,
    nullableNonStart,
    terminalSets,
    classifiedAssertions: assertions.nodes,
    reserved: { word: grammar.tokens.find(t => t.identifier)?.name, isWordLiteral: assertions.isWordLiteral, plan: assertions.reservedSets },
    renderedLiterals: new Set(),
    namesRules: new Map(),
    bothReadings: [],
    wordLiterals,
    contextual,
    glrRules: new Set(),
    templatePlan,
    interpolationPlans,
    nameFieldNodes: nameFields.nodes,
    tsSharedRules: collectTsSharedRules(grammar),
    firstFilters,
  };

  const grammarJs = buildGrammarJs(ctx, grammarName);
  const highlightsScm = buildHighlightsScm(source, ctx, nameFields.byRule);
  const { scannerC, externalTokens } = buildScannerC(grammar, ctx, grammarName);

  return { grammarJs, highlightsScm, scannerC, externalTokens, assertions: assertions.records, ...(ctx.reserved.word ? { contextualKeywords: ctx.bothReadings } : {}) };
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

  // ── reserved word sets (planReservedSets): written once the rules are rendered (a word must be
  // a token: see renderedLiterals) ──
  const reservedAt = lines.length;

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

  // ── conflicts ── (written once the rules are rendered: the contextual-keyword pairs are known then)
  const conflicts = deriveConflicts(ctx);
  for (const c of conflicts) if (c.length === 1) ctx.glrRules.add(c[0]);
  const conflictsAt = lines.length;

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

  // Shared rules from named tsRelax (e.g. the type-only fn-param). Emitted right AFTER the
  // entry rule (index 1), never first: the entry rule must stay the start symbol, AND
  // tree-sitter's state count is sensitive to rule ORDER — placing the type-param rule EARLY
  // collapses ~2k more states than placing it last (measured, issue #46). Emitted once so
  // their states are shared across every reference rather than inlined at each use site.
  // (Visibility follows the tree-sitter convention: a `_`-prefixed name is hidden; the
  // type-fn-param is deliberately VISIBLE so its param-name child is not spliced into the
  // enclosing `type` node — see typescript.ts.)
  const sharedEntries: string[] = [];
  for (const [name, body] of ctx.tsSharedRules) {
    sharedEntries.push(`    ${name}: $ => ${renderExpr(body, ctx)}`);
  }
  if (sharedEntries.length) ruleEntries.splice(1, 0, ...sharedEntries);

  // Token rules (named) — those not provided by the scanner. Skip tokens are
  // included so `extras` references resolve.
  const tokenBodies = new Set<string>();
  for (const tok of grammar.tokens) {
    const tokenBody = buildTokenBody(tok.name, ctx);
    if (tokenBody === null) continue;
    const snake = ctx.tokenSnake.get(tok.name)!;
    ruleEntries.push(`    ${snake}: $ => ${tokenBody}`);
    tokenBodies.add(tokenBody);
  }

  // ── Template rule (interpolated template literal) ──
  // The single template token is re-expressed as a rule whose `${ … }` holes
  // re-enter the expression grammar — the tree-sitter analogue of the lexer's
  // head/middle/tail split. The literal text between delimiters is the external
  // `template_chars` token (the scanner stops it at a delimiter); the delimiters
  // and the brace are anonymous tokens. Delimiters all DERIVED from the hint.
  const tp = ctx.templatePlan;
  for (const variant of tp ? tp.holes : []) {
    // The hole re-enters the rule the template reference declares, as the parser does.
    const substRef = variant.substRuleSnake === tp!.substRuleSnake
      ? `$.${variant.substRuleSnake}`
      : `alias($.${variant.substRuleSnake}, $.${tp!.substRuleSnake})`;
    ruleEntries.push(
      `    ${variant.ruleSnake}: $ => seq(\n` +
      `      ${jsString(tp!.open)},\n` +
      `      repeat(choice($.${tp!.charsSnake}, ${substRef})),\n` +
      `      ${jsString(tp!.open)}\n` +
      `    )`,
    );
    ruleEntries.push(
      `    ${variant.substRuleSnake}: $ => seq(${jsString(tp!.interpOpen)}, $.${ctx.ruleSnake.get(variant.rule)!}, ${jsString(tp!.interpClose)})`,
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

  // ── reserved word sets: the first set is global (id 0) and stays empty, so a step outside every
  // set keeps tree-sitter's default keyword extraction. A reserved word that no rule writes (JS
  // `enum`: a ReservedWord of the lexical grammar that no syntactic production uses) is no token,
  // and tree-sitter can only reserve a token: it gets a hidden token rule of its own, referenced by
  // the sets only (tree-sitter keeps a rule a reserved set names; the word is checked to be a plain
  // word, so it is also its own regex). It is a keyword (word-shaped, no
  // other token matches it) that no parse state shifts, so where it is reserved it is an error,
  // and elsewhere keyword extraction gives the word token, exactly as for any keyword.
  // ── contextual keywords (see renderWordStep): one `_names_<n>` rule per keyword set the steps
  // read as a name, and the conflicts planContextualWords derived for them ──
  const unlisted = [...ctx.renderedLiterals].filter(w => ctx.reserved.isWordLiteral(w) && !ctx.wordLiterals.includes(w));
  if (ctx.wordLiterals.length && unlisted.length) throw new Error(`gen-treesitter: rules wrote keyword(s) collectWordLiterals missed: ${unlisted.join(', ')}`);
  const wordSnake = ctx.reserved.word && ctx.tokenSnake.get(ctx.reserved.word);
  const ruleNames = new Set([...ctx.ruleSnake.values(), ...ctx.tokenSnake.values(), ...ctx.tsSharedRules.keys()]);
  const nameRead = new Set<string>();
  for (const [key, name] of ctx.namesRules) {
    if (ruleNames.has(name)) throw new Error(`gen-treesitter: contextual-keyword rule name ${name} collides with a rule`);
    const ws = key.split(' ');
    const body = ws.length === 1 ? jsString(ws[0]) : `choice(${ws.map(jsString).join(', ')})`;
    ruleEntries.push(`    ${name}: $ => prec.dynamic(-1, alias(${body}, $.${wordSnake}))`);
    for (const w of ws) nameRead.add(w);
  }
  // A keyword some step reads as a name but no rule writes is no keyword token: it must still be one
  // (the reserved sets below name only tokens).
  for (const w of nameRead) ctx.renderedLiterals.add(w);
  ctx.bothReadings.push(...ctx.wordLiterals.filter(w => nameRead.has(w)));
  const contextualConflicts: string[][] = [];
  for (const c of ctx.contextual?.conflicts ?? []) {
    const names = c.map(v => 'names' in v ? ctx.namesRules.get(v.names) : ctx.ruleSnake.get(v.rule) ?? (ctx.tsSharedRules.has(v.rule) ? v.rule : undefined));
    if (names.some(n => n === undefined)) throw new Error(`gen-treesitter: a contextual-keyword conflict names an unrendered rule: ${JSON.stringify(c.filter((_, i) => names[i] === undefined))}`);
    contextualConflicts.push([...new Set(names as string[])].sort());
  }
  const allConflicts = [...conflicts, ...contextualConflicts];
  const head: string[] = [];
  if (allConflicts.length > 0) {
    head.push('  conflicts: $ => [');
    for (const c of allConflicts) head.push('    [' + c.map(n => `$.${n}`).join(', ') + '],');
    head.push('  ],', '');
  }
  lines.splice(conflictsAt, 0, ...head);

  const reservedSets = ctx.reserved.plan.sets;
  if (reservedSets.length) {
    const ownToken = new Map<string, string>();
    for (const { words } of reservedSets) for (const w of words) {
      if (ctx.renderedLiterals.has(w) || tokenBodies.has(jsString(w)) || ownToken.has(w)) continue;
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(w)) throw new Error(`gen-treesitter: reserved word ${JSON.stringify(w)} is no rendered token and cannot name a token rule`);
      const name = `_reserved_${w}`;
      if ([...ctx.ruleSnake.values(), ...ctx.tokenSnake.values()].includes(name)) throw new Error(`gen-treesitter: reserved-word token rule ${name} collides with a rule`);
      // ruleLiteral saw every rule literal: a second token for a written word would shadow it
      if (ruleEntries.some(e => e.includes(jsString(w)))) throw new Error(`gen-treesitter: reserved word ${JSON.stringify(w)} is written by a rule that bypassed ruleLiteral`);
      ownToken.set(w, name);
    }
    const word = (w: string) => ownToken.has(w) ? `$.${ownToken.get(w)}` : jsString(w);
    const block = ['  reserved: {', '    global: $ => [],'];
    for (const { name, words } of reservedSets) block.push(`    ${name}: $ => [${words.map(word).join(', ')}],`);
    block.push(`    ${UNRESERVED_SET}: $ => [],`, '  },', '');
    lines.splice(reservedAt, 0, ...block);
    // A pattern, not a string: tree-sitter turns a rule that is one token into that token only when
    // the token is auxiliary (a pattern) or the rule visible; a hidden rule over a string stays a
    // non-terminal, which a reserved set cannot hold ("Cannot store non-terminals in a TokenSet").
    // Lexical precedence 1: a keyword must be PREFERRED over the word token on their common string
    // (identify_keywords: does_match_same_string), which a string literal is implicitly and a
    // pattern declared after the word token is not (without it `var enum = 1;` stayed accepted).
    for (const [w, name] of ownToken) ruleEntries.push(`    ${name}: $ => token(prec(1, /${w}/))`);
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

  // From the scopes section first (authoritative). A word has up to two roles, each
  // on its own node kind, so the two never compete for one node:
  //  - as a real grammar token (appears in rules/precs) it is an anonymous-token
  //    capture, from its first scope;
  //  - as an IDENTIFIER-NAME hint (a `support.*` scope: a builtin/global name the
  //    runtime provides) it is matched on the identifier, by text. tree-sitter lexes
  //    a word that is also a keyword literal as the keyword only where that keyword
  //    is valid and as the `word` identifier elsewhere (`declare module "m"` vs
  //    `module.exports`), so a hint keeps its role wherever the word is an
  //    identifier, whether or not the grammar also uses it as a keyword. A hint
  //    that is never a grammar token could not be an anonymous token anyway
  //    (tree-sitter rejects it as a bad node name).
  // Type-ness is POSITIONAL: a blanket @type/@type.builtin predicate would mis-paint
  // value-position uses (e.g. `Array.from`), so those are left to the structural
  // type-reference capture below; only position-independent vocabulary (globals,
  // constants) is emitted as an #any-of? identifier predicate.
  const identNameHints: { lit: string; cap: string }[] = [];
  for (const [lit, scopes] of scopeOverrides) {
    if (lit.startsWith('.')) continue; // property-name overrides handled separately
    if (allLiterals.has(lit)) {                                  // real grammar token
      const cap = scopeToCapture(scopes[0]);
      if (cap) add(cap, lit);
    }
    const nameScope = scopes.find(s => s === 'support' || s.startsWith('support.'));
    const nameCap = nameScope && scopeToCapture(nameScope);
    if (nameCap && nameCap !== '@type' && nameCap !== '@type.builtin') identNameHints.push({ lit, cap: nameCap });
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
  if (ctx.templatePlan && ctx.templatePlan.holes.length > 0) {
    // Every template rule is (or is aliased to) these two node kinds — see TemplatePlan.holes.
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
    // type-object member keys → @property. Only where the identifier is a direct child of the
    // member's node: a pattern naming a child the node cannot have is a query error, and a key
    // held by a member-name rule is already captured through that rule above.
    for (const n of typeMemberRules(grammar)) {
      const s = snake(n);
      if (s && refsDirectly(grammar.rules.find(r => r.name === n)!.body, identName)) struct.push(`(${s} (${identSnake}) @property)`);
    }
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

  // ── Contextual token scopes (grammar.contextualScopes, highlight-only) ──
  // Token T carries scope S within rule R (T's immediate enclosing rule) — expressed
  // exactly as `(rule (token) @capture)` queries. Emitted LAST: highlight resolution is
  // last-wins (nvim-treesitter / tree-sitter-cli), so these override the token's flat
  // capture above inside their declared rules only.
  const ctxQueries: string[] = [];
  for (const entry of grammar.contextualScopes ?? []) {
    const cap = scopeToCapture(entry.scope);
    if (!cap) continue;
    const tokSnake = ctx.tokenSnake.get(entry.token);
    if (!tokSnake) continue;
    for (const ruleName of entry.within) {
      const ruleSnake = ctx.ruleSnake.get(ruleName);
      if (!ruleSnake) continue;
      ctxQueries.push(`(${ruleSnake} (${tokSnake}) ${cap})`);
    }
  }
  if (ctxQueries.length) {
    out.push(';; Contextual token scopes (grammar.contextualScopes).');
    for (const q of ctxQueries) out.push(q);
    out.push('');
  }

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
  // optional like `opt(Ident)`, or like `opt(notReserved, Ident)`: a zero-width lookahead
  // before the identifier, as between the keyword and the name)? Used to locate
  // anonymous-decl name slots.
  function isIdentRef(item: RuleExpr): RuleExpr | null {
    if (item.type === 'ref' && item.name === identName && tokenNames.has(item.name)) return item;
    if (item.type === 'quantifier' || item.type === 'group') return isIdentRef(item.body);
    if (item.type === 'seq') {
      const rest = item.items.filter(i => i.type !== 'not');
      return rest.length === 1 ? isIdentRef(rest[0]) : null;
    }
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
    else if (e.type === 'quantifier' || e.type === 'group') walk(e.body);
    else if (e.type === 'sep') walk(e.element);
  };
  for (const r of grammar.rules) walk(r.body);
  return out;
}

/** A single "name form": a token ref or a computed `[ Expr ]`. */
function isNameForm(item: RuleExpr, tokenNames: Set<string>): boolean {
  if (item.type === 'ref' && tokenNames.has(item.name)) return true;
  // a computed name: whatever the brackets hold (`[ Expr ]`, `[ Expr , … ]`)
  if (item.type === 'seq' && item.items.length >= 3) {
    const a = item.items[0], c = item.items[item.items.length - 1];
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
// Does this rule body reference `name` itself (not through another rule), in its tree-sitter
// rendering (a tsRelaxed group renders its relaxed form)?
function refsDirectly(e: RuleExpr, name: string): boolean {
  switch (e.type) {
    case 'ref': return e.name === name;
    case 'seq': case 'alt': return e.items.some(i => refsDirectly(i, name));
    case 'quantifier': return refsDirectly(e.body, name);
    case 'group': return e.tsRuleName ? false : refsDirectly(e.tsRelaxed ?? e.body, name);   // a named tsRelaxed group is its own node
    case 'sep': return refsDirectly(e.element, name);
    default: return false;
  }
}

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
    else if (e.type === 'quantifier' || e.type === 'group') walk(e.body);
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
    else if (e.type === 'quantifier' || e.type === 'group') walk(e.body);
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
//                           tree-sitter analogue of emit-lexer.ts's span scan).
//
// Nothing below is language-specific: the flag characters come from the regex
// token pattern, and the template open/interp delimiters come from the template
// token's `template` hint.
// ════════════════════════════════════════════════════════════════════════════

/** Emit a C string-literal initializer for the chars of `s` (e.g. "${" → {'$','{'}). */
/** A C condition: `v` (a code point) is in the set (UTF-16 units; a set holding surrogates holds the
 *  non-BMP characters). */
function cCharSetTest(set: CSet, v: string): string {
  const parts: string[] = [];
  for (const [lo, hi] of set) {
    const a = Math.max(lo, 0), b = hi;
    if (b < a) continue;
    parts.push(a === b ? `${v} == ${a}` : `(${v} >= ${a} && ${v} <= ${b})`);
    if (a <= 0xdfff && b >= 0xd800) parts.push(`${v} > 0xffff`);
  }
  return parts.length ? parts.join(' || ') : 'false';
}

// ── The scanner of the zero-width tokens (planZeroWidth) ──
// Every table here is derived: the literals are the generated grammar's, matched longest-first (a
// word-shaped one only when no word character follows, the word token's own characters); a token
// that is no literal is known by its first character; a skip token's opening literal (`//`, `/*`)
// defers the decision: the scanner declines, tree-sitter lexes the comment as an extra and asks again
// in the same state, now after it. A line break is one of the characters that set the lexer's
// `newlineBefore` (src/emit-lexer.ts: \n \r U+2028 U+2029) in the whitespace before the next token.
// What the scanner cannot see: a line break inside a skipped block comment (the comment is an extra
// already consumed when it is asked again), and a literal that is the prefix of a longer non-literal
// token (`.` before `.5`).
function zeroWidthScannerC(ctx: GrammarJsContext, regexSym: string | null): { helpers: string[]; call: string[] } {
  const { grammar } = ctx;
  const tokens = ctx.zeroWidth.tokens;
  if (!tokens.length) return { helpers: [], call: [] };
  const word = ctx.reserved.word;
  const isWordLit = ctx.reserved.isWordLiteral;
  // ── kinds: literals (longest match), skip openers, tokens by first character ──
  const lits = new Set<string>([...ctx.renderedLiterals]);
  for (const t of tokens) for (const s of [t.after, t.cont, t.ahead]) for (const x of s) if (x.startsWith("'")) lits.add(x.slice(1));
  const literals = [...lits].sort();
  const litId = new Map(literals.map((l, i) => [l, i]));
  const SKIP = -2;
  // A skip token the scanner skips itself (so a line break inside or after it is seen): its opening
  // literal, and how it ends: a closing literal (the last item of its sequence) or the line (a final
  // run of characters that excludes the line terminator). Any other skip token's opener defers.
  type Skip = { opener: string; closer: string | null };
  const skips: Skip[] = [];
  const deferOpeners = new Set<string>();
  for (const t of grammar.tokens) {
    if (!t.flags.includes('skip')) continue;
    const p = t.pattern;
    const last = typeof p !== 'string' && p.type === 'seq' ? p.items[p.items.length - 1] : null;
    const closer = typeof last === 'string' ? last
      : last && last.type === 'repeat' && typeof last.body !== 'string' && last.body.type === 'charClass' && last.body.negate
        && last.body.items.some(it => it.type === 'char' && it.value === '\n') ? null : undefined;
    for (const o of tokenPatternLiteralPrefixes(t)) {
      if (closer === undefined) deferOpeners.add(o);
      else if (!skips.some(k => k.opener === o)) skips.push({ opener: o, closer });
    }
  }
  // An opener that extends another one with the same end (`/**` of `/*`, `///` of `//`) is read as
  // that one: the shorter opener's body takes the rest (`/**/` closes at its `*/`).
  for (let i = skips.length - 1; i >= 0; i--)
    if (skips.some(k => k !== skips[i] && k.closer === skips[i].closer && skips[i].opener.startsWith(k.opener))) skips.splice(i, 1);
  const kindTokens = grammar.tokens.filter(t => !t.flags.includes('skip') && !tokenPatternIsNever(t)).map(t => t.name);
  if (kindTokens.length > 64) throw new Error(`gen-treesitter: ${kindTokens.length} non-literal tokens; the zero-width scanner's token mask holds 64`);
  const cRanges = cCharSetTest;
  const H: string[] = [];
  H.push('// ── Zero-width tokens: line-end alternatives and same-line markers (planZeroWidth) ──');
  H.push('static bool zw_line_terminator(int32_t c) { return c == \'\\n\' || c == \'\\r\' || c == 0x2028 || c == 0x2029; }');
  const wordTok = word ? grammar.tokens.find(t => t.name === word) : undefined;
  H.push(`static bool zw_word_char(int32_t c) { return ${wordTok ? cRanges(tokenPatternInfo(wordTok.pattern).chars, 'c') : 'false'}; }`);
  H.push('// The non-literal tokens the next character may start, one bit each:');
  kindTokens.forEach((n, i) => H.push(`//   ${i}: ${n}`));
  H.push('static uint64_t zw_token_candidates(int32_t c) {');
  H.push('  uint64_t m = 0;');
  kindTokens.forEach((n, i) => {
    const tok = grammar.tokens.find(t => t.name === n)!;
    H.push(`  if (${cRanges(tokenPatternInfo(tok.pattern).first, 'c')}) m |= (uint64_t)1 << ${i};`);
  });
  H.push('  return m;');
  H.push('}');
  // The longest literal (or skip opener) at the input, as a trie of nested switches.
  type Node = { kids: Map<number, Node>; lit?: number; skip?: number };
  const root: Node = { kids: new Map() };
  const insert = (text: string, mark: (n: Node) => void) => {
    let n = root;
    for (const ch of text) { const c = ch.codePointAt(0)!; if (!n.kids.has(c)) n.kids.set(c, { kids: new Map() }); n = n.kids.get(c)!; }
    mark(n);
  };
  literals.forEach((l, i) => insert(l, n => { n.lit = i; }));
  for (const o of deferOpeners) insert(o, n => { n.skip = SKIP; });
  skips.forEach((k, i) => insert(k.opener, n => { n.skip = -10 - i; }));
  H.push(`// The literals, by id: ${literals.map((l, i) => `${i} ${JSON.stringify(l)}`).join(', ')}`);
  H.push(`// The skip tokens skipped here: ${skips.map((k, i) => `${i} ${JSON.stringify(k.opener)} to ${k.closer === null ? 'the line end' : JSON.stringify(k.closer)}`).join(', ')}`);
  H.push('static bool zw_skip_comment(TSLexer *lexer, int k, bool *line_break) {   // past its end; false at an unterminated one');
  H.push('  switch (k) {');
  skips.forEach((k, i) => {
    if (k.closer === null) { H.push(`    case ${i}: while (!lexer->eof(lexer) && !zw_line_terminator(lexer->lookahead)) skip(lexer); return true;`); return; }
    const cs = [...k.closer].map(c => c.codePointAt(0)!);
    H.push(`    case ${i}: { static const int32_t close[] = { ${cs.join(', ')} }; unsigned at = 0;`);
    H.push('      while (!lexer->eof(lexer)) {');
    H.push('        int32_t c = lexer->lookahead;');
    H.push('        if (zw_line_terminator(c)) *line_break = true;');
    H.push('        skip(lexer);');
    H.push(`        if (c == close[at]) { if (++at == ${cs.length}) return true; } else at = c == close[0] ? 1 : 0;`);
    H.push('      }');
    H.push('      return false; }');
  });
  H.push('  }');
  H.push('  return false;');
  H.push('}');
  H.push(`static int zw_literal(TSLexer *lexer) {   // the longest literal id; -10 - k: skip token k; ${SKIP}: an opener to defer; -1: none`);
  H.push('  int best = -1;');
  const emit = (n: Node, depth: number, text: string) => {
    const pad = '  '.repeat(depth + 1);
    if (!n.kids.size) return;
    H.push(`${pad}switch (lexer->lookahead) {`);
    for (const [c, k] of [...n.kids].sort((a, b) => a[0] - b[0])) {
      const t = text + String.fromCodePoint(c);
      H.push(`${pad}  case ${c}:`);
      H.push(`${pad}    skip(lexer);`);
      if (k.skip !== undefined) H.push(`${pad}    best = ${k.skip};`);
      else if (k.lit !== undefined) H.push(isWordLit(t) ? `${pad}    if (!zw_word_char(lexer->lookahead)) best = ${k.lit};` : `${pad}    best = ${k.lit};`);
      emit(k, depth + 2, t);
      H.push(`${pad}    break;`);
    }
    H.push(`${pad}}`);
  };
  emit(root, 0, '');
  H.push('  return best;');
  H.push('}');
  // Per token: is a literal / a token / the end of the input in AFTER, in CONT, in its lookahead arms.
  // A word-shaped literal is also the word token where the set has that (keyword extraction lexes it
  // as the word token where the keyword itself is not valid).
  const exact = (set: Iterable<string>, kindLit: string) => new Set(set).has(`'${kindLit}`);
  const reservedWords = new Set(ctx.reserved.plan.sets[0]?.words ?? []);
  const has = (set: Iterable<string>, kindLit: string) => { const s = new Set(set); return s.has(`'${kindLit}`) || (!!word && isWordLit(kindLit) && !reservedWords.has(kindLit) && s.has(word)); };
  const mask = (set: Iterable<string>) => { const s = new Set(set); let m = 0n; kindTokens.forEach((n, i) => { if (s.has(n)) m |= 1n << BigInt(i); }); return `0x${m.toString(16)}ull`; };
  const boolRow = (f: (l: string) => boolean) => `{ ${literals.map(l => (f(l) ? 1 : 0)).join(', ')} }`;
  H.push('typedef struct { int symbol; bool line_end; bool line_break; bool after_end; uint64_t after_tok, cont_tok, ahead_tok; const bool *after_exact, *after_lit, *cont_lit, *ahead_lit; } ZeroWidth;');
  tokens.forEach(t => {
    const S = t.snake.toUpperCase();
    H.push(`static const bool ${S}_AFTER_EXACT[] = ${boolRow(l => exact(t.after, l))};`);
    H.push(`static const bool ${S}_AFTER[] = ${boolRow(l => has(t.after, l) || (isWordLit(l) && t.afterWordGuards.some(ex => !ex.has(l))))};`);
    H.push(`static const bool ${S}_CONT[] = ${boolRow(l => has(t.cont, l))};`);
    H.push(`static const bool ${S}_AHEAD[] = ${boolRow(l => t.ahead.includes(`'${l}`))};`);
  });
  H.push('static const ZeroWidth ZERO_WIDTH[] = {');
  for (const t of tokens) {
    const S = t.snake.toUpperCase();
    H.push(`  { ${S}, ${t.kind === 'line-end'}, ${t.lineBreak}, ${t.after.has(END)}, ${mask(t.after)}, ${mask(t.cont)}, ${mask(t.ahead)}, ${S}_AFTER_EXACT, ${S}_AFTER, ${S}_CONT, ${S}_AHEAD },`);
  }
  H.push('};');
  H.push('// A line-end token where its assertion holds (a line break or the end of the input, or a lookahead');
  H.push('// arm\'s token next); a same-line marker where no line break comes first. Either only when the next');
  H.push('// token may follow it (AFTER) and does not continue what precedes it (CONT).');
  H.push('// 1: returned; 0: declined; 2: declined before anything but whitespace was read, `/` next (regex).');
  H.push('static int scan_zero_width(TSLexer *lexer, const bool *valid_symbols) {');
  H.push('  lexer->mark_end(lexer);');
  H.push('  bool line_break = false, end;');
  H.push('  uint64_t cand; int lit;');
  H.push('  for (;;) {');
  H.push('    while (iswspace(lexer->lookahead)) { if (zw_line_terminator(lexer->lookahead)) line_break = true; skip(lexer); }');
  if (regexSym) H.push(`    if (valid_symbols[${regexSym}] && lexer->lookahead == '/') return 2;`);
  H.push('    end = lexer->eof(lexer);');
  H.push('    cand = 0; lit = -1;');
  H.push('    if (!end) { cand = zw_token_candidates(lexer->lookahead); lit = zw_literal(lexer); }');
  H.push('    if (lit > -10) break;');
  H.push('    if (!zw_skip_comment(lexer, -10 - lit, &line_break)) return 0;');
  H.push('  }');
  H.push(`  if (lit == ${SKIP}) return 0;`);
  H.push('  // Two passes: a keyword the token names itself first, then a keyword read as the word token.');
  H.push('  for (int pass = 0; pass < 2; pass++)');
  H.push(`  for (unsigned i = 0; i < ${tokens.length}; i++) {`);
  H.push('    const ZeroWidth *z = &ZERO_WIDTH[i];');
  H.push('    if (!valid_symbols[z->symbol]) continue;');
  H.push('    bool ahead = !end && (lit >= 0 ? z->ahead_lit[lit] : (cand & z->ahead_tok) != 0);');
  H.push('    bool holds = z->line_end ? ((z->line_break && (line_break || end)) || ahead) : (!line_break && !end);');
  H.push('    if (!holds) continue;');
  H.push('    bool after = end ? z->after_end : lit >= 0 ? (pass == 0 ? z->after_exact[lit] : z->after_lit[lit]) : (cand & z->after_tok) != 0;');
  H.push('    bool cont = !end && (lit >= 0 ? z->cont_lit[lit] : (cand & z->cont_tok) != 0);');
  H.push('    if (after && !cont) { lexer->result_symbol = z->symbol; return 1; }');
  H.push('  }');
  H.push('  return 0;');
  H.push('}');
  H.push('');
  const C: string[] = [];
  C.push('  // Zero-width tokens (a line-end alternative, a same-line marker) where one is valid.');
  C.push(`  if (${tokens.map(t => `valid_symbols[${t.snake.toUpperCase()}]`).join(' || ')}) {`);
  C.push('    int zw = scan_zero_width(lexer, valid_symbols);');
  C.push('    if (zw == 1) return true;');
  C.push('    if (zw == 0) return false;');
  C.push('  }');
  C.push('');
  return { helpers: H, call: C };
}

function cCharList(s: string): string {
  return [...s].map(c => `'${c === '\\' || c === "'" ? '\\' + c : c}'`).join(', ');
}

// ── Indentation external scanner (YAML) ──────────────────────────────────────
// An indentation-sensitive grammar emits INDENT / DEDENT / NEWLINE from a line-leading-column state
// machine that a regex lexer cannot express, so they become external tokens scanned here. This C
// scanner mirrors the indent-stack logic of src/emit-lexer.ts: at each line boundary it measures the
// next content line's column and emits INDENT (deeper → push), DEDENT (shallower → pop, one per call
// until the stack top is reached), or NEWLINE (same column → a sibling separator). Flow context needs
// no special handling: inside `[`/`{` the grammar never references these tokens, so valid_symbols is
// false there and the line break falls through to `extras`. The indent stack lives in the Scanner
// struct and is (de)serialized for incremental re-parsing. Block-scalar bodies are scanned verbatim
// up to the first line at or below the parent indentation. All language data (the comment introducer,
// the block-scalar introducer chars, the document markers) is DERIVED from `grammar.indent`.
function buildIndentScannerC(grammar: CstGrammar, ctx: GrammarJsContext, grammarName: string): { scannerC: string; externalTokens: string[] } {
  const ind = grammar.indent!;
  const externalTokens = externalSymbols(ctx); // order MUST match grammar.js externals
  const sym = (tokenName: string) => ctx.scannerTokenFor.get(tokenName)!.toUpperCase();
  const INDENT = sym(ind.indentToken), DEDENT = sym(ind.dedentToken), NEWLINE = sym(ind.newlineToken);
  const BLOCK = ind.blockScalar ? sym(ind.blockScalar.token) : null;
  // The block-context SCALAR externals — plain, key, and the typed num / bool-null — all scanned by
  // scan_scalar (a `:` is a separator only before space/EOL/flow-indicator; a `#` a comment only after
  // a space; a typed run is classified by shape). Emitting num/bool-null from the scanner (not via a
  // regex token + decline) makes EVERY scalar an external token that carries the key-vs-value decision,
  // which the GLR parser needs to chain top-level mapping entries.
  const { plain: plainTok, key: keyTok, num: numTok, boolnull: boolnullTok } = planPlainScalarTokens(grammar);
  const PLAIN = plainTok ? sym(plainTok) : null;
  const KEY = keyTok ? sym(keyTok) : null;
  const NUM = numTok ? sym(numTok) : null;
  const BOOLNULL = boolnullTok ? sym(boolnullTok) : null;
  const SCALAR = PLAIN || KEY || NUM || BOOLNULL; // scan_scalar is emitted when at least one exists
  const scalarGate = [PLAIN, KEY, NUM, BOOLNULL].filter(Boolean).map(s => `valid_symbols[${s}]`).join(' || ') || '0';
  const want = (s: string | null) => (s ? `valid_symbols[${s}] != 0` : 'false');
  const cmt = ind.comment ?? '#';
  const cmtC = cmt.length === 1 ? (cmt === '\\' || cmt === "'" ? `'\\${cmt}'` : `'${cmt}'`) : null;
  const introCond = (ind.blockScalar?.introducers ?? []).map(c => `lexer->lookahead == '${c}'`).join(' || ') || '0';
  const enumBody = externalTokens.map(s => `  ${s.toUpperCase()},`).join('\n');
  const G = grammarName;
  // Compact-notation entry indicators (YAML `-` / `?`) — DERIVED from grammar.indent.compactIndicators
  // (nothing hardcoded). A `lexer->lookahead == 'c'` disjunction reused by the scanner's compact logic.
  // (The other inline-content leads — node-property `&`/`!`, flow `[`/`{`, alias `*` — are mirrored as
  //  literals from emit-lexer's startsBlockStructuralNode, which itself treats them as fixed YAML
  //  syntax; only the entry indicators are config-driven, matching IndentConfig.compactIndicators.)
  const compactIndicators = ind.compactIndicators ?? [];
  const compactIndicatorCond = (v: string) => compactIndicators.map(c => `${v} == '${c}'`).join(' || ') || '0';
  const hasCompact = compactIndicators.length > 0 && SCALAR;
  // Flow-collection delimiters (`[ ] { }`) — DERIVED from grammar.indent.flowOpen / flowClose. Inside a
  // flow collection (flow_depth > 0) indentation is SUSPENDED and `,`/`[`/`]`/`{`/`}` are item/collection
  // boundaries; in block context (flow_depth == 0) those same chars are ordinary plain-scalar content
  // (mirrors the flowDepth counter in src/emit-lexer.ts, the parser's lexer). tree-sitter discards an
  // external scanner's struct mutations on a `false` return (it restores the pre-scan serialized state
  // before lexing the internal bracket), so a counter cannot be maintained by peeking-then-returning-
  // false at the bracket; instead the flow OPEN/CLOSE brackets are emitted as EXTERNAL tokens by the
  // scanner (a TRUE return DOES persist), and flow_depth is bumped there. The brackets are synthesized
  // external tokens (no token name in yaml.ts) — see flowSyntheticTokens / the literal substitution in
  // renderExpr. flow_depth is then carried in the Scanner struct (serialize/deserialize).
  const flowOpen = ind.flowOpen ?? [];
  const flowClose = ind.flowClose ?? [];
  const charLit = (c: string) => (c === '\\' || c === "'" ? `'\\${c}'` : `'${c}'`);
  // Run-boundary chars inside a flow collection: the closers/openers + the entry separator `,`. A plain
  // scalar still cannot START with one of these (only contain them in block context).
  const hasFlow = flowOpen.length > 0 || flowClose.length > 0;
  const flowBreakCond = (v: string) => [...flowOpen, ...flowClose].map(c => `${v} == ${charLit(c)}`).concat(`${v} == ','`).join(' || ');
  // The synthetic external token name + char for each flow delimiter (open then close), in the SAME
  // order they were registered in ctx.scannerTokenFor (so the enum / grammar.js externals positions
  // agree). Built by flowSyntheticTokens(grammar) and shared with the grammar.js side.
  const flowTokens = flowSyntheticTokens(grammar); // [{ sym, char, open }]

  // DOCUMENT MARKERS (`---` / `...`) — INTERNAL tokens; the external scalar scanner only CLAIMS a non-
  // marker glyph as plain and DECLINES a true (sep-bounded) marker so the internal token lexes it.
  const markers = documentMarkerGlyphs(grammar);
  const hasMarkers = markers.length > 0 && SCALAR;
  const cChar = (ch: string) => (ch === '\\' || ch === "'" ? `'\\${ch}'` : `'${ch}'`);
  // Advance over one glyph char (counting `matched`) — DON'T push to the run or mark the token end yet.
  // The probe commits (mark_end) only on the plain-content path; a true-marker decline marks nothing, so
  // the probed chars roll back cleanly and tree-sitter then lexes the internal marker token.
  const eatGlyphChar = (ch: string) => `if (lexer->lookahead == ${cChar(ch)}) { lexer->advance(lexer, false); matched++; }`;
  // Replay the k matched glyph chars into the run as scalar content (a non-marker glyph: `---foo`,
  // `--x`). The lexer is already positioned past them; the main loop continues the run from here.
  const replayGlyph = (glyph: string) => [...glyph].map((ch, k) =>
    `if (matched > ${k}) { if (blen < sizeof(buf)) buf[blen++] = ${cChar(ch)}; }`).join(' ');
  const markerProbe = !hasMarkers ? '' : `
  // DOCUMENT-MARKER probe (column 0). A \`---\`/\`...\` glyph that is sep-bounded (ws / EOL / EOF) is a
  // document marker — an INTERNAL token (its IR's sep look-ahead is beyond a tree-sitter token() DFA,
  // but this external scanner decides the boundary). The glyph is matched WITHOUT marking the token end:
  //   • a FULL glyph + separator      → a TRUE marker: set s->marker_decline and return false; nothing
  //     was marked, so the probed chars roll back and the internal \`---\`/\`...\` token lexes it (a non-
  //     marker glyph never reaches that token, so its dropped look-ahead is moot).
  //   • a LONE indicator char + sep   → a block indicator (\`- \`/\`? \`); decline so the internal \`-\`/\`?\`
  //     token takes it.
  //   • anything else (\`---foo\`, \`-1\`) → plain content: replay the matched glyph chars and fall through
  //     to the scalar loop, which continues the run (so the marker glyph is CLAIMED as a plain scalar).
  // Markers (and which lead chars are block indicators) are DERIVED from grammar.indent.
  if (${hasCompact ? 'compact_col < 0 && ' : ''}lexer->get_column(lexer) == 0) {${markers.map(glyph => `
    if (lexer->lookahead == ${cChar(glyph[0])}) {
      unsigned matched = 0;
      ${[...glyph].map(eatGlyphChar).join('\n      ')}
      int32_t mn = lexer->lookahead;
      bool msep = (mn == 0 || mn == ' ' || mn == '\\t' || mn == '\\n' || mn == '\\r');
      if (matched == ${glyph.length} && msep) { s->marker_decline = true; return false; }${compactIndicators.includes(glyph[0]) ? `
      if (matched == 1 && msep) return false; // lone \`${glyph[0]}\` + separator → block indicator, not content` : ''}
      ${replayGlyph(glyph)} if (matched > 0) { has_content = true; lexer->mark_end(lexer); }
    }`).join('')}
  }`;

  const scannerC = `// Tree-sitter external scanner generated by monogram (indentation path).
//
// Mirrors the indent-stack state machine of src/emit-lexer.ts: INDENT / DEDENT / NEWLINE are emitted
// from the line-leading column relative to an indent stack; a block-scalar body is scanned verbatim.
// All language data (comment introducer, block-scalar introducers, document markers) is DERIVED from
// the grammar's \`indent\` config — nothing below is hand-tuned for a specific language.

#include "tree_sitter/parser.h"
#include "tree_sitter/alloc.h"
#include <string.h>
#include <stdint.h>

enum TokenType {
${enumBody}
};

typedef struct {
  uint32_t len;          // indent-stack depth (>= 1; stack[0] == 0, the document level)
  uint32_t cap;
  int16_t *stack;        // indentation columns
  int16_t pending_col;   // column of the line boundary mid-processing (-1 = none)
  bool pending_newline;  // a NEWLINE is still owed once dedents reach pending_col
  bool started;          // any content lexed yet (suppresses a leading NEWLINE)${hasCompact ? `
  bool at_line_lead;     // the next real content token is its line's first (compact-indicator probe)
  bool property_lead;    // the line's FIRST token is a node property (\`&\`/\`!\`) — its inline content sits
                         // at the SAME node level, so it must NOT take the compact mapping-key push (\`&a
                         // a: b\` is the key \`a\` carrying anchor \`&a\`, not \`&a\`-then-INDENTED-\`a: b\`).
                         // emit-lexer clears atLineLead on the property token (it sees every token); the
                         // scanner does not lex the property, so it LATCHES this at the line lead and reads
                         // it at the push. It must survive the property's INTERNAL lex (which the scanner
                         // declines via a FALSE return) — tree-sitter deserializes the serialized fields on
                         // a false return, so a SERIALIZED flag would be rolled back; this one is therefore
                         // NOT serialized and NOT reset in deserialize (it keeps its in-memory value across
                         // the decline). It is RE-DERIVED from the lead char at every line boundary, so it
                         // is always correct at the only points it is read (a line lead).` : ''}${hasFlow ? `
  uint16_t flow_depth;   // > 0 inside flow collections ([ ] { }) → indentation suspended, ,/[/]/{/}` : ''}${hasMarkers ? `
  bool marker_decline;   // transient: scan_scalar saw a true \`---\`/\`...\` → external declines so the
                         // internal marker token lexes it. Set+consumed within one scan; not serialized.` : ''}
} Scanner;

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }
static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static void push_indent(Scanner *s, int16_t col) {
  if (s->len == s->cap) { s->cap *= 2; s->stack = ts_realloc(s->stack, s->cap * sizeof(int16_t)); }
  s->stack[s->len++] = col;
}

void *tree_sitter_${G}_external_scanner_create(void) {
  Scanner *s = ts_malloc(sizeof(Scanner));
  s->cap = 16; s->len = 1;
  s->stack = ts_malloc(s->cap * sizeof(int16_t));
  s->stack[0] = 0;
  s->pending_col = -1; s->pending_newline = false; s->started = false;${hasCompact ? `
  s->at_line_lead = true; s->property_lead = false;` : ''}${hasFlow ? `
  s->flow_depth = 0;` : ''}${hasMarkers ? `
  s->marker_decline = false;` : ''}
  return s;
}

void tree_sitter_${G}_external_scanner_destroy(void *payload) {
  Scanner *s = (Scanner *)payload;
  ts_free(s->stack);
  ts_free(s);
}

unsigned tree_sitter_${G}_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = (Scanner *)payload;
  unsigned n = 0;
  buffer[n++] = s->started ? 1 : 0;
  buffer[n++] = s->pending_newline ? 1 : 0;${hasCompact ? `
  buffer[n++] = s->at_line_lead ? 1 : 0;` : ''}
  memcpy(&buffer[n], &s->pending_col, sizeof(int16_t)); n += sizeof(int16_t);${hasFlow ? `
  memcpy(&buffer[n], &s->flow_depth, sizeof(uint16_t)); n += sizeof(uint16_t);` : ''}
  uint32_t count = s->len;
  while (n + sizeof(uint32_t) + count * sizeof(int16_t) > TREE_SITTER_SERIALIZATION_BUFFER_SIZE && count > 0) count--;
  memcpy(&buffer[n], &count, sizeof(uint32_t)); n += sizeof(uint32_t);
  memcpy(&buffer[n], s->stack, count * sizeof(int16_t)); n += count * sizeof(int16_t);
  return n;
}

void tree_sitter_${G}_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *s = (Scanner *)payload;
  s->len = 1; s->stack[0] = 0; s->pending_col = -1; s->pending_newline = false; s->started = false;${hasCompact ? `
  s->at_line_lead = true;` : ''}${hasFlow ? `
  s->flow_depth = 0;` : ''}${hasMarkers ? `
  s->marker_decline = false;` : ''}
  if (length < ${hasCompact ? 3 : 2} + sizeof(int16_t)${hasFlow ? ' + sizeof(uint16_t)' : ''} + sizeof(uint32_t)) return;
  unsigned n = 0;
  s->started = buffer[n++] != 0;
  s->pending_newline = buffer[n++] != 0;${hasCompact ? `
  s->at_line_lead = buffer[n++] != 0;` : ''}
  memcpy(&s->pending_col, &buffer[n], sizeof(int16_t)); n += sizeof(int16_t);${hasFlow ? `
  memcpy(&s->flow_depth, &buffer[n], sizeof(uint16_t)); n += sizeof(uint16_t);` : ''}
  uint32_t count; memcpy(&count, &buffer[n], sizeof(uint32_t)); n += sizeof(uint32_t);
  if (count == 0) return; // keep stack[0] = 0
  while (s->cap < count) { s->cap *= 2; s->stack = ts_realloc(s->stack, s->cap * sizeof(int16_t)); }
  memcpy(s->stack, &buffer[n], count * sizeof(int16_t));
  s->len = count;
}

${BLOCK ? `// A block scalar (\`|\` / \`>\`): the introducer + indicators + the verbatim more-indented body, as
// one token. The body runs while a line is blank or indented MORE than the parent block level (the
// stack top); it ends at the first non-blank line at or below the parent, or a column-0 document
// marker, or EOF. mark_end is advanced only over lines that belong to the scalar, so the next node's
// indentation is left for the normal boundary logic.
//
// A ROOT block scalar (the document's own node — stack depth 1) has an effective parent indentation of
// -1, not 0: its body may sit at column 0 (\`--- >\\nline1\`, yaml-test-suite DK3J / FP8R). So at root,
// only a column-0 DOCUMENT MARKER (\`---\` / \`...\`) — never plain column-0 text — ends it. The marker
// is matched without committing the line (no mark_end), so a non-marker column-0 line stays body.${markers.length > 0 ? `` : ''}
static bool scan_block_scalar(Scanner *s, TSLexer *lexer) {
  bool root = s->len == 1;           // a document-root block scalar: body may reach column 0
  int parent = root ? -1 : s->stack[s->len - 1];
  advance(lexer); // the introducer (| or >)
  while (lexer->lookahead == '+' || lexer->lookahead == '-' || (lexer->lookahead >= '0' && lexer->lookahead <= '9')) advance(lexer);
  while (lexer->lookahead != 0 && lexer->lookahead != '\\n' && lexer->lookahead != '\\r') advance(lexer);
  lexer->mark_end(lexer); // the header line belongs to the scalar
  for (;;) {
    if (lexer->lookahead == '\\r') { advance(lexer); if (lexer->lookahead == '\\n') advance(lexer); }
    else if (lexer->lookahead == '\\n') advance(lexer);
    else break; // EOF
    int col = 0;
    while (lexer->lookahead == ' ') { advance(lexer); col++; }
    int32_t c = lexer->lookahead;
    if (c == 0 || c == '\\n' || c == '\\r') { lexer->mark_end(lexer); continue; } // blank line → body${markers.length > 0 ? `
    if (root && col == 0) {                 // a column-0 document marker ends a root block scalar
      bool is_marker = false;${markers.map(glyph => `
      if (!is_marker && c == ${cChar(glyph[0])}) {
        unsigned m = 0; ${[...glyph].map(ch => `if (lexer->lookahead == ${cChar(ch)}) { advance(lexer); m++; }`).join(' ')}
        int32_t a = lexer->lookahead;
        if (m == ${glyph.length} && (a == 0 || a == ' ' || a == '\\t' || a == '\\n' || a == '\\r')) is_marker = true;
      }`).join('')}
      if (is_marker) break;                 // leave the marker line for the next token (no mark_end)
      // not a marker: the chars probed above are body; fall through to consume the rest of the line.
    }` : ''}
    if (col <= parent) break; // dedent to/below parent ends the scalar (the line is the next node)
    while (lexer->lookahead != 0 && lexer->lookahead != '\\n' && lexer->lookahead != '\\r') advance(lexer);
    lexer->mark_end(lexer);
  }
  lexer->result_symbol = ${BLOCK};
  return true;
}
` : ''}${hasCompact ? `
// Compact block notation (\`- a: 1\` / \`- - x\` / \`- &a k: v\` / \`? key\`): a sequence/explicit-key
// indicator whose inline content itself begins a block node nests at the content's column, not the
// indicator's. The indicator chars are DERIVED from grammar.indent.compactIndicators. Mirrors
// compactNestsHere / startsBlockStructuralNode in src/emit-lexer.ts: the inline content is
// block-structural when, after an optional node-property prefix (\`&anchor\` / \`!tag\`, 0-2
// space-separated), it is a further indicator, or a mapping KEY (an unquoted \`:\` then ws/EOL/
// flow-indicator before a \` #\` comment / EOL, scanned quote-aware). A bare scalar / flow / alias does
// NOT nest. The property / flow / alias glyphs are fixed YAML syntax (as in emit-lexer); only the entry
// indicators are config-driven.
static inline bool compact_is_indicator(int32_t c) { return ${compactIndicatorCond('c')}; }
static inline bool compact_sep_after(int32_t c) {
  return c == 0 || c == ' ' || c == '\\t' || c == '\\n' || c == '\\r';
}
// The inline content (lookahead is positioned at it) begins a block-structural node. Advances; the
// caller has frozen a zero-width token end before it and discards the advances (returning the INDENT
// zero-width on a hit, or rewinding on a miss).
static bool compact_content_is_structural(TSLexer *lexer) {
  for (int n = 0; n < 2; n++) {                       // skip 0-2 node-property prefixes (\`&anchor\` / \`!tag\`)
    int32_t c = lexer->lookahead;
    if (c == '&' || c == '!') {
      advance(lexer);
      while (lexer->lookahead != 0 && !compact_sep_after(lexer->lookahead) && lexer->lookahead != ',') advance(lexer);
      while (lexer->lookahead == ' ' || lexer->lookahead == '\\t') advance(lexer);
    } else break;
  }
  int32_t c0 = lexer->lookahead;
  if (c0 == 0 || c0 == '\\n' || c0 == '\\r') return false;            // property alone on the line → no nest
  if (compact_is_indicator(c0)) { advance(lexer); return compact_sep_after(lexer->lookahead); } // nested indicator
  if (c0 == '[' || c0 == '{' || c0 == '*') return false;            // flow collection / alias → not a key
  for (;;) {                                          // scalar KEY sniff (quote-aware), like startsBlockStructuralNode
    int32_t ch = lexer->lookahead;
    if (ch == 0 || ch == '\\n' || ch == '\\r') break;
    if (ch == '"') {
      advance(lexer);
      while (lexer->lookahead != 0 && lexer->lookahead != '"' && lexer->lookahead != '\\n') { if (lexer->lookahead == '\\\\') advance(lexer); advance(lexer); }
      if (lexer->lookahead == '"') advance(lexer);
      continue;
    }
    if (ch == '\\'') {
      advance(lexer);
      while (lexer->lookahead != 0 && lexer->lookahead != '\\n') { if (lexer->lookahead == '\\'') { advance(lexer); if (lexer->lookahead != '\\'') break; } advance(lexer); }
      continue;
    }
    if (ch == ' ' || ch == '\\t') { advance(lexer); if (lexer->lookahead == '#') break; continue; } // trailing comment
    if (ch == ':') {
      advance(lexer);
      int32_t n = lexer->lookahead;
      if (n == 0 || n == ' ' || n == '\\t' || n == '\\n' || n == '\\r' || n == ',' || n == '[' || n == ']' || n == '{' || n == '}') return true;
      continue;
    }
    advance(lexer);
  }
  return false;
}
` : ''}${SCALAR ? `
// A PLAIN / KEY scalar. A tree-sitter token() DFA can't decide a plain scalar's boundary (a \`:\` is
// content unless followed by space/EOL/flow-indicator; a \`#\` starts a comment only after a space),
// so we scan it here where look-ahead IS available. The run starts at the current column and ends
// BEFORE the first key/value \`:\`-separator, comment, flow indicator, newline, or EOF; trailing
// whitespace is trimmed. KEY vs PLAIN is decided by whether a \`:\`-separator immediately follows.
//
// A number- or bool/null-SHAPED run is left to the regex \`num\`/\`bool_null\` tokens (return false →
// tree-sitter rolls back our advances and the typed token matches) — but ONLY where such a token is
// valid. A multi-line plain fold's continuation line is plain-ONLY (its KEY symbol is not valid), so
// a numeric-looking continuation ("123" under a plain scalar) must stay PLAIN, not be handed to num.
//${hasCompact ? `
// COMPACT mapping-KEY support: when \`compact_col >= 0\` (a line-lead indicator's scalar-led inline
// content, deeper than the stack top — see the caller), the run is scanned WITHOUT marking the token
// end (the caller pre-marked a zero-width end at the content start). A KEY run pushes \`compact_col\`
// and emits a zero-width INDENT — the nested mapping's real indent — and the key is re-lexed on the
// next call (then compact_col is no longer deeper, so this path is skipped). A leaf scalar (no \`:\`)
// is emitted as usual, its end marked at the run end. Mirrors compactNestsHere's mapping-key arm.` : ''}
static bool scan_scalar(TSLexer *lexer, bool want_key, bool want_plain, bool want_num, bool want_boolnull${hasFlow ? `,
                        int flow_depth` : ''}${(hasCompact || hasMarkers) ? `,
                        Scanner *s` : ''}${hasCompact ? `,
                        int16_t compact_col, int indent_sym` : ''}) {${hasCompact ? `
  bool cm = compact_col >= 0;   // compact-eligible: suppress per-char mark_end (zero-width INDENT on KEY)` : ''}
  char buf[64];
  unsigned blen = 0;        // run text (capped) — for the number/bool-null shape test
  bool has_content = false;
  bool stopped_at_kv = false; // ended at a \`:\`-separator → this scalar is a mapping KEY
${markerProbe}
  for (;;) {
    int32_t c = lexer->lookahead;
    if (c == 0) break;                                             // EOF
    if (c == '\\n' || c == '\\r') {${hasFlow ? `
      // Inside a flow collection a plain scalar FOLDS across a line break (\`{ multi\\n line: v}\` → the
      // key is \`multi line\`): the break + surrounding whitespace (and blank/comment-only lines) collapse
      // to one space and the run continues on the next line. Peek past that trivia run WITHOUT committing
      // (mark_end stays at the last content char, so a decline trims it): if the next significant char
      // ENDS the scalar — EOF, a flow indicator/terminator (\`, [ ] { }\`), or a line-leading \`#\` comment —
      // the break is trailing trivia and the scalar stops here; otherwise fold to a space and continue.
      if (flow_depth > 0 && has_content) {
        while (lexer->lookahead == ' ' || lexer->lookahead == '\\t' ||
               lexer->lookahead == '\\n' || lexer->lookahead == '\\r') lexer->advance(lexer, false);
        int32_t nx = lexer->lookahead;
        if (nx == 0 || nx == '#' || (${flowBreakCond('nx')})) break; // scalar ends — the trivia is trailing
        if (blen < sizeof(buf)) buf[blen++] = ' ';                  // the folded break becomes one space
        continue;                                                   // next content char marks the new token end
      }` : ''}
      break;                                                       // block context (or no content yet): the line break ends the scalar
    }
    ${hasFlow ? `if (flow_depth > 0 && (${flowBreakCond('c')})) break; // flow indicators end a scalar — ONLY inside a flow collection` : `if (c == ',' || c == '[' || c == ']' || c == '{' || c == '}') break; // flow indicators end a scalar`}
    if (!has_content && (c == '-' || c == '?')) {
      // A leading \`-\`/\`?\` is a block indicator (seq entry / explicit key) when followed by space/EOL/
      // flow-indicator, and scalar content otherwise (\`-1\`, \`?x\`). Peek the next char to decide.
      lexer->advance(lexer, false);
      int32_t n = lexer->lookahead;
      if (n == 0 || n == ' ' || n == '\\t' || n == '\\n' || n == '\\r'${hasFlow ? ` ||
          (flow_depth > 0 && (${flowBreakCond('n')}))` : ` ||
          n == ',' || n == '[' || n == ']' || n == '{' || n == '}'`}) return false; // indicator, not a scalar
      if (blen < sizeof(buf)) buf[blen++] = (char)c;               // \`-\`/\`?\` glued to non-space is content
      has_content = true;
      ${hasCompact ? 'if (!cm) ' : ''}lexer->mark_end(lexer);
      continue;
    }
    if (c == ':') {
      lexer->advance(lexer, false);                               // past the ':' to peek the next char
      int32_t n = lexer->lookahead;
      if (n == 0 || n == ' ' || n == '\\t' || n == '\\n' || n == '\\r'${hasFlow ? ` ||
          (flow_depth > 0 && (${flowBreakCond('n')}))` : ` ||
          n == ',' || n == '[' || n == ']' || n == '{' || n == '}'`}) {
        stopped_at_kv = true; break;                              // ':' is a key/value separator → end before it
      }
      if (blen < sizeof(buf)) buf[blen++] = ':';                  // ':' glued to non-space is content
      has_content = true;
      ${hasCompact ? 'if (!cm) ' : ''}lexer->mark_end(lexer);
      continue;
    }
    if (c == ' ' || c == '\\t') {
      lexer->advance(lexer, false);                               // past the space to peek the next char
      if (lexer->lookahead == '#') break;                        // " #" begins a comment → end before the space
      if (blen < sizeof(buf)) buf[blen++] = ' ';                  // interior space (e.g. "hello world")
      continue;                                                   // do NOT mark_end → trailing spaces are trimmed
    }
    if (blen < sizeof(buf)) buf[blen++] = (char)c;
    has_content = true;
    lexer->advance(lexer, false);
    ${hasCompact ? 'if (!cm) ' : ''}lexer->mark_end(lexer);                                       // token end follows the last content char
  }
  if (!has_content) return false;
${hasCompact ? `
  // COMPACT mapping KEY: the inline content after a line-lead indicator is a mapping key → its column
  // is the nested mapping's indent. Push it and emit the zero-width INDENT (the caller pre-marked the
  // end at the content start); the key is re-lexed on the next call. A leaf falls through to normal
  // classification, with its end marked here (run end) since per-char marking was suppressed.
  if (cm) {
    if (stopped_at_kv) {
      push_indent(s, compact_col);
      s->at_line_lead = true;     // the key is itself this line's fresh lead (re-lexed next call)
      lexer->result_symbol = indent_sym;
      return true;                // zero-width INDENT at the content start (advances discarded)
    }
    lexer->mark_end(lexer);       // leaf: take the whole run (trailing-space trim is skipped in compact mode)
  }
` : ''}
  // Number / bool-null SHAPE test (so the typed regex tokens still classify \`1\`/\`true\`). Decide KEY
  // vs PLAIN first, because a typed-looking run is only deferred where a typed token is valid: a KEY
  // position admits num/bool_null (block_key_scalar), and a non-KEY value position likewise — but a
  // plain-ONLY fold continuation (neither KEY here, and the run is not a key) must stay PLAIN.
  // numeric / bool-null SHAPE test — a loose superset is fine for classification (only a typed-shaped
  // run is emitted as NUM/BOOL_NULL; a run with any other char is PLAIN), at the cost of mis-typing a
  // rare plain like \`1abc\` as numeric (the documented imprecise edge).
  bool numeric = blen > 0;
  for (unsigned i = 0; i < blen; i++) {
    char ch = buf[i];
    bool ok = (ch >= '0' && ch <= '9') || ch == '.' || ch == '+' || ch == '-' || ch == 'e' || ch == 'E' ||
              ch == 'x' || ch == 'o' || ch == 'n' /* inf/nan */ || ch == 'a' || ch == 'f' || ch == 'i' ||
              ch == 'I' || ch == 'N' || ch == 'F' || (ch >= 'A' && ch <= 'F');
    if (!ok) { numeric = false; break; }
  }
  // also require at least one digit OR a .inf/.nan/~ shape so a bare "e"/"a" word isn't called numeric
  if (numeric) {
    bool any_digit = false;
    for (unsigned i = 0; i < blen; i++) if (buf[i] >= '0' && buf[i] <= '9') { any_digit = true; break; }
    if (!any_digit) numeric = false;
  }
  bool boolnull = false;
  {
    static const char *WORDS[] = { "true","True","TRUE","false","False","FALSE","null","Null","NULL","~" };
    for (unsigned w = 0; w < sizeof(WORDS)/sizeof(WORDS[0]); w++) {
      const char *p = WORDS[w]; unsigned i = 0;
      while (i < blen && p[i] && buf[i] == p[i]) i++;
      if (i == blen && p[i] == 0) { boolnull = true; break; }
    }
  }
  // Classify + emit. The external scalar token CARRIES the key-vs-value decision (a trailing \`: \`
  // means KEY), which the GLR parser needs to chain mapping entries — so a typed value is emitted as
  // NUM/BOOL_NULL here, NOT deferred to a regex token (deferring drops the disambiguation and
  // mis-parses a top-level \`x: 1\\ny: 2\`). A key wins first; then the typed shapes; then PLAIN. Each
  // is gated on its token being admissible here (valid_symbols), falling through otherwise.
  if (stopped_at_kv && want_key) { lexer->result_symbol = ${KEY ?? PLAIN}; return true; }
  if (numeric && want_num) { lexer->result_symbol = ${NUM ?? PLAIN}; return true; }
  if (boolnull && want_boolnull) { lexer->result_symbol = ${BOOLNULL ?? PLAIN}; return true; }
  if (want_plain) { lexer->result_symbol = ${PLAIN ?? KEY}; return true; }
  if (want_key) { lexer->result_symbol = ${KEY ?? PLAIN}; return true; }
  return false;
}
` : ''}
bool tree_sitter_${G}_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;
  bool want_indent = valid_symbols[${INDENT}];
  bool want_dedent = valid_symbols[${DEDENT}];
  bool want_newline = valid_symbols[${NEWLINE}];${BLOCK ? `\n  bool want_block = valid_symbols[${BLOCK}];` : ''}${hasMarkers ? `
  // Content lies to our left whenever we are not at column 0 — including right after an INTERNAL token
  // (e.g. a \`---\`/\`...\` document marker, whose match the scanner never sees). Mark started so the line
  // boundary that follows emits its NEWLINE (the leading-NEWLINE suppression is only for blank lines at
  // the very start of input, which are always at column 0). Without this, the NEWLINE after a leading
  // \`---\` would be dropped and the document body could not attach.
  if (lexer->get_column(lexer) > 0) s->started = true;` : ''}

  // Finish a line boundary already in progress: emit the remaining DEDENTs (one per call), then the
  // owed NEWLINE when the stack top reaches the boundary column. No input is consumed here.
  if (s->pending_col >= 0) {
    int top = s->stack[s->len - 1];
    if (s->pending_col < top) {
      if (want_dedent) { s->len--; lexer->result_symbol = ${DEDENT}; return true; }
      s->pending_col = -1; s->pending_newline = false; return false;
    }
    bool owed = s->pending_newline;
    int16_t col = s->pending_col;
    s->pending_col = -1; s->pending_newline = false;
    if (col == top && owed && want_newline && s->started) { lexer->result_symbol = ${NEWLINE}; return true; }
    return false;
  }
${hasFlow ? `
  // Inside a flow collection (flow_depth > 0) a line break is INSIGNIFICANT — indentation is suspended,
  // so a flow scalar / nested bracket may sit on a following line (\`[a,\\n b]\`). tree-sitter's \`/\\s/\`
  // extra cannot skip the newline here: the external scanner is consulted first, and a \`false\` return
  // (the only way to "decline") rolls back any advance, so the newline is never consumed and the parser
  // stalls into error recovery. So when in flow, the scanner itself eats the flow-insignificant run
  // (spaces, tabs, newlines, comments) as the LEADING trivia of the next token it returns — the bracket
  // emission and scalar scan below both return TRUE, which makes the skip stick. (In block context this
  // is skipped: a newline IS significant and drives the INDENT/DEDENT/NEWLINE boundary logic.)
  if (s->flow_depth > 0) {
    for (;;) {
      int32_t c = lexer->lookahead;
      if (c == ' ' || c == '\\t' || c == '\\n' || c == '\\r') skip(lexer);
      ${cmtC ? `else if (c == ${cmtC}) { while (lexer->lookahead != 0 && lexer->lookahead != '\\n' && lexer->lookahead != '\\r') skip(lexer); }` : ''}
      else break;
    }
  }
  // Flow-collection delimiters ([ ] { }). These are emitted as EXTERNAL tokens (not the internal DFA) so
  // flow_depth — the open-bracket nesting that suspends indentation — PERSISTS: tree-sitter keeps an
  // external scanner's struct mutations only across a token it RETURNS (on a \`false\` return it restores
  // the pre-scan serialized state, so a peek-then-false counter is silently rolled back before the
  // internal bracket is lexed). Each is gated on its own valid_symbols, so a \`[\`/\`{\` that is plain
  // content (a scalar contains but never STARTS with one — handled in scan_scalar) is NOT consumed here:
  // at those positions the flow token isn't valid and we fall through. Skip inline space/tab first (the
  // flow newline skip above already ran when in flow; in block a newline still drives the indent logic).
  {
    while (lexer->lookahead == ' ' || lexer->lookahead == '\\t') skip(lexer);
    int32_t fc = lexer->lookahead;
${flowTokens.map(t => `    if (fc == ${charLit(t.char)} && valid_symbols[${t.sym.toUpperCase()}]) {
      advance(lexer); lexer->mark_end(lexer); lexer->result_symbol = ${t.sym.toUpperCase()};
      ${t.open ? 'if (s->flow_depth < UINT16_MAX) s->flow_depth++;' : 'if (s->flow_depth > 0) s->flow_depth--;'}
      s->started = true;${hasCompact ? ' s->at_line_lead = false;' : ''} return true;
    }`).join('\n')}
  }
` : ''}${hasCompact ? `
  // Compact block notation (\`- a: 1\` / \`- - x\` / \`- &a k: v\` / \`? key\`). The line-lead indicator was
  // just lexed by tree-sitter's internal DFA, so at_line_lead is still set (the scanner emits no
  // indicator token to clear it) and tree-sitter now wants the nested node's INDENT on the SAME line.
  // When the inline content begins a block node, its column — not the indicator's — is the node's
  // indentation: emit a zero-width INDENT there and push it (the DEDENT logic closes it when a
  // shallower line arrives). The work splits by what leads the inline content, because the sniff
  // ADVANCES (irrecoverably) and external-scanner state changes are reverted on a false return:
  //   • a node-property / flow / alias / nested-indicator lead — sniff it here; a structural hit pushes
  //     INDENT, a miss returns false so tree-sitter rewinds and the leading char (all INTERNAL-lexable,
  //     or the scalar handled on the next call) is re-lexed.
  //   • a plain/quoted SCALAR lead — fall through to scan_scalar (below), which pushes the compact
  //     INDENT itself when the run is a mapping KEY. (A bare scalar must NOT be sniffed-then-rewound: a
  //     plain scalar is external-only, so a false return here would loop.)
  if (want_indent && s->at_line_lead${hasFlow ? ' && s->flow_depth == 0' : ''}) {
    while (lexer->lookahead == ' ' || lexer->lookahead == '\\t') skip(lexer);
    int32_t c = lexer->lookahead;
    // GENUINE line lead: the line's first token is not yet lexed, so its column == the stack top (a
    // line boundary set top to the lead column; at stream start both are the document level). Once a
    // token has been lexed on this line the next content is DEEPER than top. Record whether that first
    // token is a node PROPERTY (\`&\`/\`!\`): a property leads a node, so its inline content is at the
    // SAME level (no compact push), whereas a compact indicator (\`-\`/\`?\`) DOES open a nested level
    // for its content. This is the one fact lost when the property is lexed internally (the scanner
    // never sees it), so it is latched here and checked at the two compact-push sites below.
    if ((int16_t)lexer->get_column(lexer) == s->stack[s->len - 1]) s->property_lead = (c == '&' || c == '!');
    bool nonscalar_lead = c == '&' || c == '!' || c == '[' || c == '{' || c == '*' || compact_is_indicator(c);
    // A property that LEADS the line (property_lead) does not nest — skip the compact push so its key
    // stays at the node's level (\`&a a: b\` / \`!!str &a1 "foo":\`). A property that follows a compact
    // indicator (\`- &a k: v\`) is NOT a line lead (property_lead was set false at the \`-\`), so it still
    // pushes via compact_content_is_structural's property-skip.
    if (nonscalar_lead && !s->property_lead && (int16_t)lexer->get_column(lexer) > s->stack[s->len - 1]) {
      int16_t col = (int16_t)lexer->get_column(lexer);
      lexer->mark_end(lexer); // freeze the zero-width INDENT end at the content column before the sniff advances
      if (compact_content_is_structural(lexer)) {
        push_indent(s, col);
        // A NESTED indicator's content is itself a fresh line-lead (so \`- - x\` nests once more); but a
        // node-property prefix (\`- &a k: v\`) is followed INLINE by its own mapping KEY at the SAME level
        // — that key must NOT push again, so clear the lead for the property / direct-key case.
        s->at_line_lead = compact_is_indicator(c);
        lexer->result_symbol = ${INDENT};
        return true;
      }
      return false; // not block-structural → rewind; the internal-lexable lead (or next-call scalar) re-lexes
    }
  }
` : ''}${BLOCK ? `
  // A block scalar value (\`key: |\`): scan its body before the indent logic — its more-indented
  // lines are content, not nested structure. Skip the inline space after the \`:\`/\`-\` first. Block
  // scalars are a block-context construct — inside a flow collection \`|\`/\`>\` are plain content.
  if (want_block${hasFlow ? ' && s->flow_depth == 0' : ''}) {
    while (lexer->lookahead == ' ' || lexer->lookahead == '\\t') skip(lexer);
    if (${introCond}) { if (scan_block_scalar(s, lexer)) {${hasCompact ? ' s->at_line_lead = false;' : ''} return true; } }
  }
` : ''}${SCALAR ? `
  // A SCALAR (plain / key / num / bool-null) on the CURRENT line — NOT at a line boundary (a leading
  // newline falls through to the indent logic so INDENT/DEDENT/NEWLINE are emitted first). Skip inline
  // spaces/tabs, then if the next char could begin a plain scalar (not a newline/EOF and not a YAML
  // indicator — a leading \`-\`/\`?\`/\`:\` is resolved inside scan_scalar), scan it where look-ahead is
  // available. scan_scalar classifies the run and emits the admissible token.
  if (${scalarGate}) {
    while (lexer->lookahead == ' ' || lexer->lookahead == '\\t') skip(lexer);
    int32_t h = lexer->lookahead;
    bool indicator = h == 0 || h == '\\n' || h == '\\r' || h == ',' || h == '[' || h == ']' || h == '{' ||
                     h == '}' || h == '#' || h == '&' || h == '*' || h == '!' || h == '|' || h == '>' ||
                     h == '\\'' || h == '"' || h == '%' || h == '@' || h == '\`';
    if (!indicator) {
      // A false scan_scalar is only rolled back if this whole call returns false. Once it has advanced
      // (a lone \`:\` it declined, a num-shaped run with no num token valid), falling through to the
      // indent logic would emit a NEWLINE/DEDENT whose span swallows that content, so decline instead.
      uint32_t scan_col = lexer->get_column(lexer);${hasCompact ? `
      // Compact mapping-KEY (part B): a line-lead indicator's scalar-led inline content, deeper than the
      // stack top. scan_scalar then pushes the nested mapping's INDENT (zero-width, pre-marked here) if
      // the run is a KEY, or emits the leaf scalar otherwise (so \`- x\` stays a plain item, no push).
      // \`!s->property_lead\`: a key after a LINE-LEAD node property (\`&a a: b\`) sits at the node's level,
      // not a compact-nested one — so do NOT pre-mark a compact INDENT; scan_scalar then emits the key as
      // an ordinary value-position scalar (the enclosing Node carries the property). A key after a compact
      // indicator (\`- a: 1\`) has property_lead == false and still nests.
      int16_t compact_col = -1;
      if (want_indent && s->at_line_lead && !s->property_lead && (int16_t)lexer->get_column(lexer) > s->stack[s->len - 1]) {
        compact_col = (int16_t)lexer->get_column(lexer);
        lexer->mark_end(lexer); // zero-width INDENT end at the content start (used iff the run is a KEY)
      }
      if (scan_scalar(lexer, ${want(KEY)}, ${want(PLAIN)}, ${want(NUM)}, ${want(BOOLNULL)}${hasFlow ? ', s->flow_depth' : ''}, s, compact_col, ${INDENT})) { s->started = true; s->at_line_lead = (lexer->result_symbol == ${INDENT}); return true; }${hasMarkers ? `
      if (s->marker_decline) { s->marker_decline = false; return false; } // a true \`---\`/\`...\` here → let the internal marker token lex it` : ''}` : `
      if (scan_scalar(lexer, ${want(KEY)}, ${want(PLAIN)}, ${want(NUM)}, ${want(BOOLNULL)}${hasFlow ? ', s->flow_depth' : ''}${hasMarkers ? ', s' : ''})) { s->started = true; return true; }${hasMarkers ? `
      if (s->marker_decline) { s->marker_decline = false; return false; }` : ''}`}
      if (lexer->get_column(lexer) != scan_col) return false;
    }
  }
` : ''}
  if (!want_indent && !want_dedent && !want_newline) return false; // no indent tokens valid${hasFlow ? `
  // Inside a flow collection a newline is INSIGNIFICANT (indentation suspended): emit NO INDENT/DEDENT/
  // NEWLINE so the line break is consumed by tree-sitter's \`/\\s/\` extra and the flow spans the line.
  if (s->flow_depth > 0) return false;` : ''}

  // Skip blank lines, comment-only lines, and leading whitespace, noting whether a line break was
  // crossed (only a real boundary drives the indent logic).
  bool found_eol = false;
  for (;;) {
    int32_t c = lexer->lookahead;
    if (c == '\\n') { skip(lexer); found_eol = true; }
    else if (c == '\\r') { skip(lexer); if (lexer->lookahead == '\\n') skip(lexer); found_eol = true; }
    else if (c == ' ' || c == '\\t') { skip(lexer); }
    ${cmtC ? `else if (c == ${cmtC}) { while (lexer->lookahead != 0 && lexer->lookahead != '\\n' && lexer->lookahead != '\\r') skip(lexer); }` : ''}
    else break; // content or EOF
  }

  if (lexer->eof(lexer)) {
    if (s->len > 1 && want_dedent) { s->len--; lexer->result_symbol = ${DEDENT}; return true; } // close open blocks at EOF
    return false;
  }
  bool was_started = s->started;
  s->started = true; // content lies ahead — mark started even on a mid-line return
  if (!found_eol) return false; // not at a line boundary

  int16_t col = (int16_t)lexer->get_column(lexer);
  lexer->mark_end(lexer); // INDENT/DEDENT/NEWLINE are zero-width at the content column
  int top = s->stack[s->len - 1];${hasCompact ? `
  s->at_line_lead = true; // a real line boundary — the next real token leads its line
  // Latch whether THIS new line is led by a node property (\`&\`/\`!\`) — the lookahead is the line's
  // first content char (blanks/comments already skipped). A property leads a node, so its inline content
  // is at the same level and must NOT take a compact push (the gates below check property_lead). This is
  // a TRUE-return site so the latch persists through the property's internal lex; it is also re-derived
  // for the FIRST line (which reaches no boundary) by the compact block's genuine-line-lead detection.
  s->property_lead = (lexer->lookahead == '&' || lexer->lookahead == '!');` : ''}

  if (col > top) {
    if (want_indent) { push_indent(s, col); lexer->result_symbol = ${INDENT}; return true; }
    return false;
  }
  if (col == top) {
    if (want_newline && was_started) { lexer->result_symbol = ${NEWLINE}; return true; }
    return false;
  }
  // col < top: a dedent. Emit one DEDENT now; queue the rest + the trailing NEWLINE for re-entry.
  if (want_dedent) {
    s->pending_col = col; s->pending_newline = true;
    s->len--; lexer->result_symbol = ${DEDENT}; return true;
  }
  return false;
}
`;
  return { scannerC, externalTokens };
}

function buildScannerC(
  grammar: CstGrammar,
  ctx: GrammarJsContext,
  grammarName: string,
): { scannerC: string; externalTokens: string[] } {
  if (grammar.indent) return buildIndentScannerC(grammar, ctx, grammarName);
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
    L.push('// A newline-sensitive grammar emits one NEWLINE token per line break outside flow.');
    L.push('// tree-sitter only asks for it where the grammar permits it (statement');
    L.push('// boundaries, blank lines); inside flow delimiters the rules never reference NEWLINE, so');
    L.push('// valid_symbols[NEWLINE] is false there and the line break falls through to');
    L.push('// `extras` as ordinary whitespace. Stateless: one line break (\\n / \\r / \\r\\n) per token.');
    L.push('// Spaces and tabs before the break are skipped here, as the lexer skips them inline; left to');
    L.push('// `extras`, they would carry the break away with them.');
    L.push('static bool scan_newline(TSLexer *lexer) {');
    L.push('  while (lexer->lookahead == \' \' || lexer->lookahead == \'\\t\') skip(lexer);');
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
    // The flags: the token's final run (`star(identPart)` in JavaScript: any identifier character, as
    // tsc lexes them; `/foo/v` is a regex with the `v` flag). Its characters when the run is no plain
    // class; the fixed list only for a pattern with no final run.
    const rp = regexTok.pattern;
    const lastItem = typeof rp !== 'string' && rp.type === 'seq' ? rp.items[rp.items.length - 1] : null;
    const flagRun = lastItem && typeof lastItem !== 'string' && lastItem.type === 'repeat' && lastItem.min === 0 && lastItem.max === undefined ? lastItem.body : null;
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
    if (flagRun && tokenPatternTrailingCharClass(regexTok) === null) {
      L.push(`  while (!lexer->eof(lexer) && (${cCharSetTest(tokenPatternInfo(flagRun).chars, 'lexer->lookahead')})) advance(lexer);`);
    } else {
      L.push(`  const char *flags = ${jsString(flagChars)};`);
      L.push('  while (lexer->lookahead != 0 && strchr(flags, (char)lexer->lookahead) != NULL) advance(lexer);');
    }
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
    L.push('// `${ … }` hole re-enters the expression grammar (mirrors emit-lexer.ts\'s');
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

  const zw = zeroWidthScannerC(ctx, regexTok ? ctx.scannerTokenFor.get(regexTok.name)!.toUpperCase() : null);
  L.push(...zw.helpers);

  // ── scan() entry ──
  L.push('bool tree_sitter_' + grammarName + '_external_scanner_scan(void *payload, TSLexer *lexer,');
  L.push('                                                          const bool *valid_symbols) {');
  L.push('  (void)payload;');
  L.push('');
  if (grammar.newline) {
    const nlSym = ctx.scannerTokenFor.get(grammar.newline.token)!.toUpperCase();
    L.push('  // Newline first: a line break outranks every other external token.');
    L.push(`  if (valid_symbols[${nlSym}] && scan_newline(lexer)) return true;`);
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
  L.push(...zw.call);
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
