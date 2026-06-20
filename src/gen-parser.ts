import type { CstGrammar, RuleExpr, RuleDecl } from './types.ts';
import { isKeywordLiteral } from './grammar-utils.ts';
import { analyzeGrammar, findEntryRule } from './grammar-analysis.ts';
import { createLexer, type Token } from './gen-lexer.ts';
import { withAwaitYield } from './await-yield-fork.ts';

// ── CST output ──

export interface CstNode {
  rule: string;
  children: CstChild[];
  offset: number;
  end: number;
}

export interface CstLeaf {
  tokenType: string;
  offset: number;
  end: number;
}

export type CstChild = CstNode | CstLeaf;

// ── Precedence info ──

// ── Parser ──

// The CST is span-only: a node's text is derived from the source it was parsed from.
export function getText(node: { offset: number; end: number }, source: string): string {
  return source.slice(node.offset, node.end);
}

export function createParser(grammar: CstGrammar) {
  // [Await]/[Yield] fork — same rule-identity space as the emitted parser (no-op
  // without ctx markers). Keeps the interp ≡ emit equivalence the gates compare.
  grammar = withAwaitYield(grammar);
  const tokenNames = new Set(grammar.tokens.map(t => t.name));

  // The lexer is a separate stage, built from the same grammar (token defs + lexer hints).
  const { tokenize } = createLexer(grammar);

  // ── Markup optional-end-tag support (HTML omittable end tags; see MarkupConfig.optionalEndTags) ──
  // Pure DATA in the grammar's markup config drives a structural recognition here: the
  // engine finds the CONTAINER element arm — `tagOpen Name many(…) tagClose many(content)
  // tagOpen closeMarker Name tagClose` — by the markup delimiters + the name token, with NO
  // hardcoded tag names. When that arm is matched and the captured open-tag name is an
  // optional-end element, its content repetition STOPS at a trigger sibling start tag and its
  // close tag becomes OPTIONAL. Absent markup / optionalEndTags → `markupContainer` stays null
  // and parsing is byte-identical (the dedicated path is never taken).
  const markup = grammar.markup;
  // name → Set(lowercased trigger start-tags that implicitly close it).
  const optionalEnd = new Map<string, Set<string>>();
  if (markup?.optionalEndTags) {
    for (const [name, triggers] of Object.entries(markup.optionalEndTags)) {
      optionalEnd.set(name.toLowerCase(), new Set(triggers.map(t => t.toLowerCase())));
    }
  }
  type MarkupContainer = {
    arm: RuleExpr;          // the container alternative (a `seq`)
    items: RuleExpr[];      // its sequence items
    contentIdx: number;     // index of the `many(content)` quantifier
    closeStart: number;     // index where the close tag begins (tagOpen of `</name>`)
    nameTokens: Set<string>; // token name(s) that carry an element name (e.g. Name)
  };
  // Recognise the container arm structurally (only meaningful with markup + optionalEndTags).
  function detectMarkupContainer(): MarkupContainer | null {
    if (!markup || optionalEnd.size === 0) return null;
    const open = markup.tagOpen, close = markup.tagClose, cm = markup.closeMarker;
    if (!cm) return null;
    const isLit = (e: RuleExpr | undefined, v: string) => !!e && e.type === 'literal' && e.value === v;
    const isNameRef = (e: RuleExpr | undefined) =>
      !!e && e.type === 'ref' && tokenNames.has(e.name);
    for (const rule of grammar.rules) {
      const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
      for (const alt of alts) {
        const items = alt.type === 'seq' ? alt.items : [alt];
        const n = items.length;
        // Shape: open  Name  …  close  <content*>  open  closeMarker  Name  close
        if (n < 6) continue;
        if (!isLit(items[0], open) || !isNameRef(items[1])) continue;
        if (!(isLit(items[n - 4], open) && isLit(items[n - 3], cm) && isNameRef(items[n - 2]) && isLit(items[n - 1], close))) continue;
        // The content quantifier sits right before the close tag, after the open tag's `close`.
        const contentIdx = n - 5;
        const content = items[contentIdx];
        if (!content || content.type !== 'quantifier' || content.kind !== '*') continue;
        if (!isLit(items[contentIdx - 1], close)) continue;   // the open tag's `>` precedes content
        const nameTokens = new Set<string>();
        // Hoist to locals: TS narrows a plain const via `.type === 'ref'`, but not a
        // computed element access (`items[n-2]`) re-read after the guard.
        const openNameItem = items[1], closeNameItem = items[n - 2];
        if (openNameItem.type === 'ref') nameTokens.add(openNameItem.name);
        if (closeNameItem.type === 'ref') nameTokens.add(closeNameItem.name);
        return { arm: alt, items, contentIdx, closeStart: n - 4, nameTokens };
      }
    }
    return null;
  }
  const markupContainer = detectMarkupContainer();

  const {
    opTable, prefixOps, noUnaryLhsOps, postfixOpValues,
    ledPrecByConnector, binaryConnectors, nudCapOf,
    prattRules, prattClassified, leftRecClassified, leftRecSet, ruleByName,
    nullableRules, exprNullable, maxBp, templateTokenName, templateTokenNames,
    firstSets, exprFirst, exprSecond,
  } = analyzeGrammar(grammar);

  const PROF = !!process.env.PROF;   // per-rule call profiling (diagnostic)


  // Per-LED binding-power lookup (object-keyed like ledFirst): a led whose first
  // connector literal has a declared LedPrec is precedence-gated; chainRhs leds must
  // end in a self-operand (the trailing ref the chain re-parses at the level's bp).
  const ledPrecOf = new Map<object, { lbp: number; rhsBp: number | null }>();
  for (const [ruleName, { leds }] of prattClassified.entries()) {
    for (const led of leds) {
      const first = led.items[0];
      if (first?.type !== 'literal') continue;
      const lp = ledPrecByConnector.get(first.value);
      if (!lp) continue;
      if (lp.rhsBp !== null) {
        const last = led.items[led.items.length - 1];
        if (!(last?.type === 'ref' && last.name === ruleName)) {
          throw new Error(`ledPrec ${first.value}: chainRhs requires a trailing self-operand`);
        }
      }
      ledPrecOf.set(led, lp);
    }
  }
  // Per-LED notLeftLeaf head-leaf word set (object-keyed like ledFirst/ledPrecOf): the arm matches
  // only when the LEFT node's outermost (head) leaf text is NOT in this set.
  const ledNotLeftLeaf = new Map<object, Set<string>>();
  for (const { leds } of prattClassified.values()) {
    for (const led of leds) if (led.notLeftLeaf) ledNotLeftLeaf.set(led, new Set(led.notLeftLeaf));
  }


  // ── First-token dispatch ──
  // The single token an expression MUST begin with, if statically knowable (a leading
  // literal or token ref); `null` = not knowable (rule ref / prefix / optional first) →
  // always try. The alternative loops now use the deeper `altMightStart` (which resolves
  // a leading rule ref through `firstSets`); `firstTokenOf` remains the dispatch for the
  // Pratt LED continuations (`ledFirst`), whose connectors are operator literals for
  // which the single-token form is already exact.
  type FirstTok = { lit: string } | { tok: string } | null;
  function firstTokenOf(alt: RuleExpr): FirstTok {
    const items = alt.type === 'seq' ? alt.items : [alt];
    const first = items[0];
    if (!first) return null;
    if (first.type === 'literal') return { lit: first.value };
    if (first.type === 'ref' && tokenNames.has(first.name)) return { tok: first.name };
    return null;
  }
  // Does a FIRST-set key (a token name, or a literal keyword/punctuation) match a token?
  function keyMatchesTok(key: string, tok: Token): boolean {
    if (tokenNames.has(key)) {
      if (tok.type === key) return true;
      return templateTokenNames.has(key) && tok.type === '$templateHead';  // interpolated template
    }
    if (isKeywordLiteral(key)) {
      return tok.type !== '' && tok.text === key;       // keyword → ident token
    }
    return tok.type === '' && (tok.text === key || tok.text.startsWith(key));  // punctuation (startsWith covers split `>>`)
  }
  // Conservative: return true unless the alternative provably cannot start here.
  function canStart(first: FirstTok | undefined, tok: Token | null): boolean {
    if (!first || !tok) return true;
    return keyMatchesTok('tok' in first ? first.tok : first.lit, tok);
  }
  // First token of each Pratt LED continuation (the element right after `$`), so
  // the LED loop can skip leds whose continuation can't begin with the lookahead
  // — that loop was otherwise ~97% wasted matchSeq attempts that fail on token 1.
  const ledFirst = new Map<object, FirstTok>();
  for (const { leds } of prattClassified.values()) {
    for (const led of leds) ledFirst.set(led, firstTokenOf({ type: 'seq', items: led.items } as RuleExpr));
  }

  // ── Mixfix operand re-bound info ──
  // A LED of the shape `<lit L1> $self <lit L2> …` (e.g. a ternary `? $ : $`) has
  // an *inner* operand (`$self`, the bit between L1 and L2) that the greedy
  // non-backtracking engine may over-consume — swallowing the L2 the operator
  // itself needs (the classic conditional-`?:` vs arrow-return-type-`:` clash:
  // `b ? (c) : d => e`, where `(c): d => e` parses as one arrow, leaving no `:`).
  // When the normal match of such a LED fails, the LED loop retries the inner
  // operand with a position cap so it stops before an L2 at the operator's own
  // bracket-nesting depth, freeing that L2 for the operator. Language-agnostic:
  // keyed purely on the structural shape, no knowledge of `?`/`:`/arrows.
  function selfRefName(e: RuleExpr | undefined, ruleName: string): boolean {
    return !!e && e.type === 'ref' && e.name === ruleName;
  }
  type MixfixInfo = { openLit: string; sepLit: string };
  // A continuation `<lit L1> $self <lit L2> …` whose inner `$self` operand can
  // over-consume the `L2` the operator needs (e.g. ternary `? $ : $`, conditional
  // type `extends $ ? $ : $`). The re-bind retries that operand capped.
  function mixfixOf(items: RuleExpr[], ruleName: string): MixfixInfo | null {
    if (items.length >= 4
      && items[0]?.type === 'literal'
      && selfRefName(items[1], ruleName)
      && items[2]?.type === 'literal') {
      return { openLit: items[0].value, sepLit: items[2].value };
    }
    return null;
  }
  const ledMixfix = new Map<object, MixfixInfo>();
  for (const [ruleName, { leds }] of prattClassified.entries()) {
    for (const led of leds) {
      const info = mixfixOf(led.items, ruleName);
      if (info) ledMixfix.set(led, info);
    }
  }
  // Same re-bind for left-recursive (non-Pratt) rules like `Type`, whose
  // continuations carry the implicit leading `$`, so they are already stripped.
  const contMixfix = new Map<object, MixfixInfo>();
  for (const [ruleName, { continuations }] of leftRecClassified.entries()) {
    for (const cont of continuations) {
      const info = mixfixOf(cont, ruleName);
      if (info) contMixfix.set(cont, info);
    }
  }
  // Per-continuation notLeftLeaf head-leaf word set (object-keyed like contMixfix): the continuation
  // matches only when the LEFT node's outermost (head) leaf text is NOT in this set.
  const contNotLeftLeaf = new Map<object, Set<string>>();
  for (const { continuations, contNotLeftLeaf: words } of leftRecClassified.values()) {
    continuations.forEach((cont, i) => { if (words[i]) contNotLeftLeaf.set(cont, new Set(words[i]!)); });
  }

  // ── Access-tail LEDs (closed under a postfix operator) ──
  // A postfix operator (`a++`) turns its operand into an "update expression" that
  // member-access tails can no longer attach to: `a++[b]`, `a++.c`, `a++()`,
  // `a++<T>()`, `` a++`x` `` are all ill-formed (member access needs a primary, not
  // a postfix result). So once a postfix binds, such tails must NOT continue — the
  // bracketed term belongs to whatever follows (e.g. the next class field after an
  // ASI). Detected structurally, language-agnostically: an access tail is a non-op
  // LED that is "closed" (its last item is not a fresh same-rule operand, unlike a
  // binary/ternary `… in $` / `? $ : $`) AND whose connector is a punctuator, not a
  // word-operator — so `as`/`satisfies`/`in`/`instanceof`/`?:` still bind after `a++`.
  const accessTailLeds = new Set<object>();
  // ── Tail-closing LEDs (a LED that itself closes the access tail) ──
  // A LED ending in a zero-width *negative lookahead* (`… not($)`) asserts that
  // nothing may follow it, so its result cannot be the base of any further
  // member/element/call access — once it binds, the access tail is closed (no `.x`,
  // `[i]`, `(…)`, `<T>`, tagged template). Language-agnostic / structural: keyed on
  // the LED ending in a `not` assertion, with no knowledge of what it guards. (E.g.
  // a bare type-argument instantiation `Foo<T>` — written `… '>' not($)` — which TS
  // forbids from being followed by property access, TS1477.)
  const tailClosingLeds = new Set<object>();
  for (const [ruleName, { leds }] of prattClassified.entries()) {
    for (const led of leds) {
      const it = led.items;
      if (it.length === 0) continue;
      if (it[0].type === 'op' || it[0].type === 'postfix') continue;   // operator LEDs, not tails
      const last = it[it.length - 1];
      const lastIsOperand = selfRefName(last, ruleName);                // open binary/ternary operand
      const wordConnector = it[0].type === 'literal' && /^[A-Za-z]/.test(it[0].value);
      if (!lastIsOperand && !wordConnector) accessTailLeds.add(led);
      if (last.type === 'not') tailClosingLeds.add(led);
    }
  }

  // FIRST sets (plain) and the SECOND-token dispatch are single-sourced in
  // grammar-analysis.ts and destructured above; ruleMightStart / altMightStart /
  // altMightSecond below are the interpreter's dispatch built on top of them.
  // Can a (non-nullable) rule possibly begin with this token? Used to skip dead parseRule calls.
  function ruleMightStart(name: string, tok: Token | null): boolean {
    if (!tok || nullableRules.has(name)) return true;
    const fs = firstSets.get(name);
    if (!fs) return true;                                        // null/unknown → don't filter
    for (const k of fs) if (keyMatchesTok(k, tok)) return true;
    return false;
  }

  // ── Deep per-alternative dispatch ──
  // The shallow `firstTokenOf` above only prunes an alternative when its FIRST element
  // is a literal or a *token* ref; a leading *rule* ref (e.g. an alt `Decl …` / `Expr …`)
  // defeats it (→ null → always tried). But the longest-match loops try EVERY alt that
  // isn't pruned, so a rule-ref-led alt is speculatively parsed (and usually fails) at
  // every position — measured at ~57% of all alternative attempts on real TS. The full
  // transitive `firstSets` already knows what each rule can begin with, so resolve the
  // alt's FIRST set through it and prune the alt when the lookahead is provably outside.
  //
  // Sound by construction: `exprFirst` is a sound OVER-approximation (it never omits a
  // token a non-empty match could begin with), so an alt pruned here genuinely cannot
  // match non-empty at this token. A NULLABLE alt is always tried — its only extra match
  // is the empty one, and an empty match never wins the longest-match comparison
  // (`pos === saved`, never `> bestPos`), so behaviour is identical with or without it.
  // Strictly dominates `canStart(firstOf…)`: whenever the shallow check pruned, the deep
  // FIRST set (whose leading member is that same literal/token) prunes too.
  // Precompute each alt's dispatch keys ONCE: `null` = always try (nullable / unknowable
  // / empty FIRST — collapsed so the hot path is a single branch), else the flat array of
  // FIRST-set keys to test the lookahead against. Doing the nullability + FIRST resolution
  // here keeps `altMightStart` to a map lookup + a bounded scan — no per-call tree walk.
  const altDispatch = new Map<RuleExpr, string[] | null>();
  for (const rule of grammar.rules) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    for (const alt of alts) {
      const fs = exprNullable(alt) ? null : exprFirst(alt);
      altDispatch.set(alt, fs && fs.size > 0 ? [...fs] : null);
    }
  }
  function altMightStart(alt: RuleExpr, tok: Token | null): boolean {
    if (!tok) return true;
    const keys = altDispatch.get(alt);
    if (!keys) return true;                                      // always try (nullable / top / empty)
    for (let i = 0; i < keys.length; i++) if (keyMatchesTok(keys[i], tok)) return true;
    return false;
  }


  // null = always try (nullable / top / len1 / empty — the emit tables' always rows).
  const altSecondDispatch = new Map<RuleExpr, string[] | null>();
  for (const rule of grammar.rules) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    for (const alt of alts) {
      const sec = exprSecond(alt);
      const always = exprNullable(alt) || sec.s === null || sec.len1 || sec.s.size === 0;
      altSecondDispatch.set(alt, always ? null : [...sec.s!]);
    }
  }
  function altMightSecond(alt: RuleExpr, tok2: Token | null): boolean {
    const keys = altSecondDispatch.get(alt);
    if (!keys) return true;
    if (!tok2) return false;                                     // needs a second token; none exists
    for (let i = 0; i < keys.length; i++) if (keyMatchesTok(keys[i], tok2)) return true;
    return false;
  }

  // ── Fast `not(alt-of-keywords)` ──
  // A negative lookahead over a literal / alternation of KEYWORD literals (e.g. an
  // identifier that isn't a reserved word, `not('catch'|'delete'|…)`) is matched by trying
  // each literal in turn — O(N) matchLiteral calls (+ an `out` alloc each) at every position
  // the construct sits on, which on the identifier path is the hottest in the grammar. The
  // set of keywords is static, so collapse it to ONE membership test. Byte-identical: the
  // `not` fails iff some literal matches the token, and a keyword literal matches iff the
  // token is an ident-kind whose text equals it — exactly `kwSet.has(tok.text)`. Pure-keyword
  // bodies only (a punctuation literal would need matchLiteral's split-`>` semantics) → else
  // the recursive path stands. `null` cached = no fast form for this node.
  const notKwCache = new Map<RuleExpr, Set<string> | null>();
  function notKwSet(notNode: RuleExpr): Set<string> | null {
    const cached = notKwCache.get(notNode);
    if (cached !== undefined) return cached;
    const set = new Set<string>();
    const collect = (e: RuleExpr): boolean =>
      e.type === 'literal' ? (isKeywordLiteral(e.value) && (set.add(e.value), true))
        : e.type === 'alt' ? e.items.every(collect)
        : false;
    const body = (notNode as Extract<RuleExpr, { type: 'not' }>).body;
    const result = collect(body) && set.size > 0 ? set : null;
    notKwCache.set(notNode, result);
    return result;
  }

  // ── Parser core ──

  const profCounts = new Map<string, number>();
  function parse(source: string, entryRule?: string): CstNode {
    const tokens = tokenize(source);
    let pos = 0;
    let maxPos = 0;   // farthest token index ever ADVANCED past (diagnostic; updated at the pos++ sites, mirroring the emitted engine so reject messages stay engine-identical)
    // Cap-propagation flag (capExpr), mirrors the emitted engine: set true when a parsePratt
    // call returns a CAPPED assignment-level expression (an ArrowFunction). An enclosing
    // operator LED reads it right after parsing its RHS and refuses to continue (so the RHS of
    // `a = () => {}` admits no trailing `||`/`?:` — it stays unconsumed and the parse rejects).
    let _prattCapped = false;
    // Packrat memo for pratt/left-recursive rules (Expr, Type, …): cache the
    // parse result + end position by start position, so backtracking doesn't
    // re-parse the same rule at the same spot. Sound because those rules reset
    // currentPrattContext (result is context-independent). Cleared on a `>>`
    // token splice (matchLiteral), which shifts later positions.
    const memo = new Map<string, Map<number, { node: CstNode | null; end: number }>>();

    // Bounded-parse cap (token index). When >= 0, no token at index >= parseLimit
    // may be consumed — i.e. a sub-parse is forced to stop before that token. Used
    // for the mixfix-operand re-parse (see matchMixfixLed): re-running an over-greedy
    // operand so it leaves a required separator for the enclosing mixfix operator.
    // `null`-equivalent is -1 (no cap). A capped parse is position+cap dependent,
    // so it bypasses the packrat memo (which is keyed by start position only).
    let parseLimit = -1;

    function peek(): Token | null {
      if (parseLimit >= 0 && pos >= parseLimit) return null;
      return tokens[pos] ?? null;
    }

    function offset(): number {
      return peek()?.offset ?? (tokens.length > 0 ? tokens[tokens.length - 1].offset + tokens[tokens.length - 1].text.length : 0);
    }

    // Match a literal string against current token
    function matchLiteral(value: string): CstLeaf | null {
      const tok = peek();
      if (!tok) return null;

      if (isKeywordLiteral(value)) {
        // Keyword literal: match against Ident token with same text
        if (tok.type !== '' && tokenNames.has(tok.type) && tok.text === value) {
          if (++pos > maxPos) maxPos = pos;
          return { tokenType: '$keyword', offset: tok.offset, end: tok.offset + tok.text.length };
        }
        return null;
      }
      // Punctuation literal
      if (tok.type === '' && tok.text === value) {
        if (++pos > maxPos) maxPos = pos;
        return { tokenType: '$punct', offset: tok.offset, end: tok.offset + tok.text.length };
      }
      // Split multi-`>` tokens: `>>`, `>>>`, `>>=`, `>>>=` can yield a single `>`
      if (value === '>' && tok.type === '' && tok.text.length > 1 && tok.text[0] === '>') {
        const rest = tok.text.slice(1);
        tokens.splice(pos, 1,
          { type: '', text: '>', offset: tok.offset, k: 0, t: 0, newlineBefore: false, commentBefore: false, multilineFlowBefore: false },
          { type: '', text: rest, offset: tok.offset + 1, k: 0, t: 0, newlineBefore: false, commentBefore: false, multilineFlowBefore: false },
        );
        memo.clear();   // splice shifts later token indices → memo entries are stale
        if (++pos > maxPos) maxPos = pos;
        return { tokenType: '$punct', offset: tok.offset, end: tok.offset + 1 };
      }
      return null;
    }

    // Match a token ref
    function matchToken(name: string): CstLeaf | null {
      const tok = peek();
      if (!tok) return null;
      if (tok.type === name) {
        if (++pos > maxPos) maxPos = pos;
        return { tokenType: name, offset: tok.offset, end: tok.offset + tok.text.length };
      }
      return null;
    }

    let currentPrattContext: string | null = null;
    // LED-connector exclusion (no-`in`-style contexts). `suppressNext` is set by a
    // `group` node carrying `suppress`, then consumed by the NEXT pratt/left-rec
    // rule it wraps; `suppressCur` is that rule's active exclusion. Recursive
    // parsePratt (operator RHS) inherit it; a nested parseRule (bracketed group,
    // operand of a non-op LED) resets it — matching the spec's [~In] propagation.
    let suppressNext: Set<string> | null = null;
    let suppressCur: Set<string> | null = null;

    function parseTemplateExpr(): CstChild | null {
      const tok = peek();
      if (!tok) return null;
      if (tok.type === templateTokenName) {
        if (++pos > maxPos) maxPos = pos;
        return { tokenType: templateTokenName, offset: tok.offset, end: tok.offset + tok.text.length };
      }
      if (tok.type === '$templateHead') {
        const children: CstChild[] = [];
        const save = pos;
        if (++pos > maxPos) maxPos = pos;
        children.push({ tokenType: '$templateHead', offset: tok.offset, end: tok.offset + tok.text.length });
        const interpRule = currentPrattContext ?? findExprRule();
        // a head COMMITS to the full chain: every substitution must hold an
        // expression and every span must continue (middle) or close (tail) — an
        // unterminated template is a parse failure, not a shorter match
        while (true) {
          const exprNode = parseRule(interpRule);
          if (!exprNode) { pos = save; return null; }
          children.push(exprNode);
          const next = peek();
          if (!next) { pos = save; return null; }
          if (next.type === '$templateMiddle') {
            if (++pos > maxPos) maxPos = pos;
            children.push({ tokenType: '$templateMiddle', offset: next.offset, end: next.offset + next.text.length });
            continue;
          }
          if (next.type === '$templateTail') {
            if (++pos > maxPos) maxPos = pos;
            children.push({ tokenType: '$templateTail', offset: next.offset, end: next.offset + next.text.length });
            break;
          }
          pos = save;
          return null;
        }
        const startOff = childOffset(children[0]);
        const endOff = childEnd(children[children.length - 1]);
        return { rule: '$template', children, offset: startOff, end: endOff };
      }
      return null;
    }

    function findExprRule(): string {
      for (const r of grammar.rules) {
        if (prattRules.has(r.name) && r.name !== 'Type') return r.name;
      }
      return grammar.rules[0].name;
    }

    // Parse a rule by name
    function parseRule(name: string): CstNode | null {
      if (PROF) profCounts.set(name, (profCounts.get(name) ?? 0) + 1);
      const rule = ruleByName.get(name);
      if (!rule) throw new Error(`Unknown rule: ${name}`);

      const isPratt = prattRules.has(name);
      const isLeftRec = leftRecSet.has(name);
      // Non-recursive rules don't reset context and aren't memoized.
      if (!isPratt && !isLeftRec) return parseNonRec(rule);

      // Consume any pending LED exclusion: it applies to THIS rule only, so clear
      // the pending slot first (nested parseRule calls reset to allow-in).
      const mySup = suppressNext;
      suppressNext = null;

      // Memoizable (pratt / left-recursive): look up by start position. A
      // suppressed parse (no-`in` context) or a capped parse (parseLimit active,
      // from the mixfix re-bind retry) is context/position+cap dependent, so it
      // bypasses the position-keyed packrat memo entirely.
      const capped = parseLimit >= 0;
      const start = pos;
      let m = memo.get(name);
      if (!mySup && !capped) {
        const hit = m && m.get(start);
        if (hit !== undefined) { pos = hit.end; return hit.node; }
      }

      const prevContext = currentPrattContext;
      currentPrattContext = name;
      const prevSup = suppressCur;
      suppressCur = mySup;
      let result: CstNode | null;
      try {
        result = isPratt ? parsePratt(rule, 0) : parseLeftRec(rule);
      } finally {
        currentPrattContext = prevContext;
        suppressCur = prevSup;
      }
      if (!mySup && !capped) {
        if (!m) { m = new Map(); memo.set(name, m); }
        m.set(start, { node: result, end: pos });
      }
      return result;
    }

    // Non-recursive rule: try alternatives, pick longest match
    function parseNonRec(rule: RuleDecl): CstNode | null {
      const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
      const saved = pos;

      let bestNode: CstNode | null = null;
      let bestPos = saved;
      const startTok = tokens[saved] ?? null;
      const startTok2 = (parseLimit >= 0 && saved + 1 >= parseLimit) ? null : (tokens[saved + 1] ?? null);

      for (const alt of alts) {
        if (!altMightStart(alt, startTok)) continue;
        if (!altMightSecond(alt, startTok2)) continue;
        pos = saved;
        // The markup container arm (HTML element with children) is matched by a
        // dedicated path that honours optional end tags — content stops at a trigger
        // sibling and the close tag may be omitted (see matchMarkupContainer). For all
        // OTHER elements it reproduces the plain sequence match byte-for-byte.
        const children = (markupContainer && alt === markupContainer.arm)
          ? matchMarkupContainer()
          : matchExpr(alt);
        if (children !== null && pos > bestPos) {
          const startOff = children.length > 0 ? childOffset(children[0]) : offset();
          const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();
          bestNode = { rule: (rule.canon ?? rule.name), children, offset: startOff, end: endOff };
          bestPos = pos;
        }
      }

      if (bestNode) { pos = bestPos; return bestNode; }
      pos = saved;
      return null;
    }

    // Left-recursive rule without Pratt: parse atom then try continuations
    function parseLeftRec(rule: RuleDecl): CstNode | null {
      const { atoms, continuations } = leftRecClassified.get(rule.name)!;
      const saved = pos;

      // Parse atom (longest match)
      let node: CstNode | null = null;
      let bestAtomPos = saved;
      const startTok = tokens[saved] ?? null;
      const startTok2 = (parseLimit >= 0 && saved + 1 >= parseLimit) ? null : (tokens[saved + 1] ?? null);
      for (const atom of atoms) {
        if (!altMightStart(atom, startTok)) continue;
        if (!altMightSecond(atom, startTok2)) continue;
        pos = saved;
        const children = matchExpr(atom);
        if (children !== null && pos > bestAtomPos) {
          const startOff = children.length > 0 ? childOffset(children[0]) : offset();
          const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();
          node = { rule: (rule.canon ?? rule.name), children, offset: startOff, end: endOff };
          bestAtomPos = pos;
        }
      }
      if (!node) { pos = saved; return null; }
      pos = bestAtomPos;

      // Try continuations repeatedly
      outer: while (true) {
        const contSaved = pos;
        for (const cont of continuations) {
          // notLeftLeaf head-leaf gate: skip this continuation when the LEFT node's outermost (head)
          // leaf text is in its word set (e.g. `void`/`null`/`this` can't be `.`-qualified as a type).
          const nll = contNotLeftLeaf.get(cont);
          if (nll !== undefined && nll.has(headLeafText(node))) continue;
          pos = contSaved;
          let children = matchSeq(cont);
          // Mixfix operand re-bind (same fix parsePratt uses): a continuation of the
          // shape `<lit> $self <lit> …` (e.g. the conditional type `extends $ ? $ : $`)
          // can have its inner operand over-consume the separator the operator needs
          // (an `infer U extends T ? …` swallowing the conditional's `?`). Retry it
          // capped so the operand stops before that separator.
          if (children === null) {
            const mix = contMixfix.get(cont);
            if (mix) { pos = contSaved; children = matchMixfixLed({ items: cont }, rule.name, mix); }
          }
          if (children !== null) {
            node = {
              rule: (rule.canon ?? rule.name),
              children: [node, ...children],
              offset: node.offset,
              end: children.length > 0 ? childEnd(children[children.length - 1]) : node.end,
            };
            continue outer;
          }
        }
        pos = contSaved;
        break;
      }

      return node;
    }

    // Assignment-target shape test (ECMAScript AssignmentTargetType): a node is NOT a valid
    // LHS target iff its outermost form is a prefix-op (prefix-unary OR prefix-update `++x`)
    // — head child is an `$operator` leaf in prefixOps — or a postfix-update (`x++`) — tail
    // child is an `$operator` leaf in postfixOpValues. A parenthesized cover / member /
    // element / call / non-null (`!`) tail has no `$operator` leaf at head or tail → passes.
    const notAssignTarget = (node: CstNode): boolean => {
      const cs = node.children;
      if (cs.length === 0) return false;
      const head = cs[0];
      if (head && 'tokenType' in head && head.tokenType === '$operator'
          && prefixOps.has(source.slice(head.offset, head.end))) return true;
      const tail = cs[cs.length - 1];
      if (tail && 'tokenType' in tail && tail.tokenType === '$operator'
          && postfixOpValues.has(source.slice(tail.offset, tail.end))) return true;
      // a binary / relational / conditional expression (`a + b`, `a in b`, `a as T`) is not a
      // LeftHandSideExpression: its MIDDLE child is a binary-connector leaf. Member `a.b` /
      // element `a[b]` have a `$punct` leaf there, a paren cover has a NODE child → those pass.
      if (cs.length >= 3) { const m = cs[1]; if (m && 'tokenType' in m && binaryConnectors.has(source.slice(m.offset, m.end))) return true; }
      return false;
    };

    // Head-leaf TEXT of a node: descend the LEFTMOST-child spine to the OUTERMOST leaf and return
    // its source text (the same head leaf `notAssignTarget` reads, generalized to recurse through
    // child nodes). Drives the notLeftLeaf LED gate. A childless node returns '' (matches no word).
    const headLeafText = (node: CstNode): string => {
      let cur: CstChild = node;
      while (!('tokenType' in cur)) {
        if (cur.children.length === 0) return '';
        cur = cur.children[0];
      }
      return source.slice(cur.offset, cur.end);
    };

    // Pratt parser for rules with op/prefix/postfix
    function parsePratt(rule: RuleDecl, minBp: number): CstNode | null {
      const { nuds, leds } = prattClassified.get(rule.name)!;
      const saved = pos;
      _prattCapped = false;   // reset; set true only on a capped (arrow) return

      // NUD: parse atom or prefix (longest match)
      let lhs: CstNode | null = null;
      let bestNudPos = saved;
      // True iff the winning NUD is a capped (assignment-level) expression — an
      // ArrowFunction. Such a NUD admits no led; the led loop is skipped entirely.
      let capped = false;
      const startTok = tokens[saved] ?? null;
      const startTok2 = (parseLimit >= 0 && saved + 1 >= parseLimit) ? null : (tokens[saved + 1] ?? null);
      for (const nud of nuds) {
        // A capped NUD parses only at a minBp LOOSER than its cap: refused as the operand
        // of any tighter operator (so `a || () => {}` rejects — `||`'s rhs minBp >= cap).
        const capBp = nudCapOf(nud);
        if (capBp !== null && minBp >= capBp) continue;
        if (!altMightStart(nud, startTok)) continue;
        if (!altMightSecond(nud, startTok2)) continue;
        pos = saved;
        const items = nud.type === 'seq' ? nud.items : [nud];

        // prefix $ pattern
        if (items[0]?.type === 'prefix') {
          const tok = peek();
          if (tok) {
            const key = tok.text;
            const info = prefixOps.get(key);
            if (info) {
              if (++pos > maxPos) maxPos = pos;
              const opLeaf: CstLeaf = { tokenType: '$operator', offset: tok.offset, end: tok.offset + tok.text.length };
              const rhs = parsePratt(rule, info.rbp);
              // A target-requiring prefix (`++`/`--`) operand must be a LeftHandSideExpression
              // (`++-x`, `++ ++x`, `++x--` are syntax errors). Fail hard like noUnaryLhs.
              if (rhs && info.requireTarget && notAssignTarget(rhs)) return null;
              if (rhs && pos > bestNudPos) {
                lhs = { rule: (rule.canon ?? rule.name), children: [opLeaf, rhs], offset: opLeaf.offset, end: rhs.end };
                bestNudPos = pos;
                capped = false;   // a prefix NUD is never capped
              }
            }
          }
          continue;
        }

        const children = matchExpr(nud);
        if (children !== null && pos > bestNudPos) {
          const startOff = children.length > 0 ? childOffset(children[0]) : offset();
          const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();
          lhs = { rule: (rule.canon ?? rule.name), children, offset: startOff, end: endOff };
          bestNudPos = pos;
          capped = capBp !== null;   // the LONGEST match wins; record whether it is capped
        }
      }
      if (lhs) pos = bestNudPos;

      if (!lhs) { pos = saved; return null; }

      // A capped NUD (assignment-level arrow) admits no led: return it as-is so a trailing
      // tighter operator stays unconsumed and the enclosing parse rejects (`() => {} || a`).
      if (capped) { _prattCapped = true; return lhs; }

      // Once a postfix operator binds (`a++`), the operand is an update expression
      // that access tails (`[…]`, `.x`, `(…)`, `<T>`, tagged template) can't extend.
      let tailClosed = false;

      // LED loop
      while (true) {
        const tok = peek();
        if (!tok) break;

        const ledSaved = pos;
        let matched = false;

        // Check non-op LED patterns first ($ '.' Ident, $ '<' ... '>' '(', etc.)
        for (const led of leds) {
          if (led.items[0]?.type === 'op' || led.items[0]?.type === 'postfix') continue;
          if (maxBp <= minBp) continue;
          if (tailClosed && accessTailLeds.has(led)) continue;   // no access tail after a postfix
          // Skip a LED whose connector is excluded in this context (e.g. `in` under
          // a no-`in` for-head) — it rebinds to the enclosing rule instead.
          if (suppressCur && led.items[0]?.type === 'literal' && suppressCur.has(led.items[0].value)) continue;
          // Precedence gate for alternative-form LEDs: without it they bind maximally
          // tight (`a == b ? c : d` mis-grouped as `a == (b ? c : d)`).
          const lp = ledPrecOf.get(led);
          if (lp !== undefined && lp.lbp <= minBp) continue;
          // notLeftLeaf head-leaf gate: skip the arm when the LEFT node's outermost (head) leaf text
          // is in the arm's word set (e.g. `void`/`null`/`this` can't be `.`-qualified as a type).
          const nll = ledNotLeftLeaf.get(led);
          if (nll !== undefined && 'children' in lhs && nll.has(headLeafText(lhs))) continue;
          if (!canStart(ledFirst.get(led), tok)) continue;   // first-token dispatch for LED continuations

          pos = ledSaved;
          let children: CstChild[] | null;
          if (lp !== undefined && lp.rhsBp !== null) {
            // Chain-rhs led ('in'/'instanceof'): the trailing self-operand parses at the
            // level's bp (left-chaining like a ladder op), not as a full expression.
            const head = matchSeq(led.items.slice(0, -1));
            if (head !== null) {
              const rhs = parsePratt(rule, lp.rhsBp);
              children = rhs !== null ? [...head, rhs] : null;
            } else {
              children = null;
            }
            if (children === null) pos = ledSaved;
          } else {
            children = matchSeq(led.items);
          }
          // Mixfix operand re-bound: if a `<L1> $ <L2> …` LED failed, the inner
          // operand may have over-consumed the L2 it needs — retry it capped.
          if (children === null && ledMixfix.has(led)) {
            pos = ledSaved;
            children = matchMixfixLed(led, rule.name, ledMixfix.get(led)!);
          }
          if (children !== null) {
            lhs = {
              rule: (rule.canon ?? rule.name),
              children: [lhs, ...children],
              offset: lhs.offset,
              end: children.length > 0 ? childEnd(children[children.length - 1]) : lhs.end,
            };
            // A LED ending in a negative lookahead (e.g. a bare instantiation
            // `Foo<T>`) closes the access tail: nothing may chain off it.
            if (tailClosingLeds.has(led)) tailClosed = true;
            matched = true;
            break;
          }
        }

        if (matched) continue;

        // Then check $ op $ pattern
        const tokKey = tok.text;
        const info = opTable.get(tokKey);
        if (info && info.lbp > minBp) {
          if (info.position === 'postfix') {
            if (!tailClosed) {                                   // can't postfix an update expr (`a++ --`)
              // A target-requiring postfix (`++`/`--`) operand must be a LeftHandSideExpression
              // (`++x++`, `x++ ++` are syntax errors). Fail hard like noUnaryLhs.
              if (info.requireTarget && 'children' in lhs && notAssignTarget(lhs)) return null;
              if (++pos > maxPos) maxPos = pos;
              const opLeaf: CstLeaf = { tokenType: '$operator', offset: tok.offset, end: tok.offset + tok.text.length };
              lhs = { rule: (rule.canon ?? rule.name), children: [lhs, opLeaf], offset: lhs.offset, end: opLeaf.end };
              tailClosed = true;
              matched = true;
            }
          } else {
            // A target-requiring infix (`=`/`+=`/…) needs a LeftHandSideExpression LEFT operand
            // (`-x = 1`, `++x = 1`, `x++ = 1` are syntax errors). Fail hard like noUnaryLhs.
            if (info.requireTarget && 'children' in lhs && notAssignTarget(lhs)) return null;
            // A `noUnaryLhs` op (e.g. `**`) may not take a bare unary-prefix expression
            // (`-x`, `typeof x` — a prefix-op node whose op is NOT also a postfix, i.e.
            // not an update `++`/`--`) as its LEFT operand. Fail the whole expression
            // hard (return null) rather than just declining to bind — otherwise it could
            // reparse another way (left-assoc `(x ** -y) ** z`, or `typeof` as a bare
            // identifier splitting the statement). `(-x) ** y` is unaffected: lhs is then
            // a parenthesized node, not a prefix node.
            if (noUnaryLhsOps.has(tokKey) && 'children' in lhs) {
              const head = lhs.children[0];
              if (head !== undefined && 'tokenType' in head && head.tokenType === '$operator'
                  && prefixOps.has(source.slice(head.offset, head.end)) && !postfixOpValues.has(source.slice(head.offset, head.end))) {
                return null;
              }
            }
            if (++pos > maxPos) maxPos = pos;
            const opLeaf: CstLeaf = { tokenType: '$operator', offset: tok.offset, end: tok.offset + tok.text.length };
            const rhs = parsePratt(rule, info.rbp);
            // CAP PROPAGATION: an operator whose RHS is a capped assignment-level expression
            // (an ArrowFunction) is itself capped — it admits no further led, so a trailing
            // `|| x` / `? :` stays unconsumed (`a = () => {} || x` rejects). `_prattCapped` is
            // still true from the RHS, so an enclosing operator refuses it too (`b = a = arrow`).
            if (rhs && _prattCapped) {
              return { rule: (rule.canon ?? rule.name), children: [lhs, opLeaf, rhs], offset: lhs.offset, end: rhs.end };
            }
            if (rhs) {
              lhs = { rule: (rule.canon ?? rule.name), children: [lhs, opLeaf, rhs], offset: lhs.offset, end: rhs.end };
              matched = true;
            } else {
              pos = ledSaved;
            }
          }
          if (matched) continue;
        }

        if (!matched) { pos = ledSaved; break; }
      }

      return lhs;
    }

    // Match a RuleExpr, return children or null
    function matchExpr(expr: RuleExpr): CstChild[] | null {
      switch (expr.type) {
        case 'literal': {
          const leaf = matchLiteral(expr.value);
          return leaf ? [leaf] : null;
        }
        case 'ref': {
          if (tokenNames.has(expr.name)) {
            // Template tokens: also handle interpolated templates
            if (templateTokenNames.has(expr.name)) {
              const tmpl = parseTemplateExpr();
              if (tmpl) return [tmpl];
            }
            const leaf = matchToken(expr.name);
            return leaf ? [leaf] : null;
          }
          // Skip the rule entirely if the lookahead can't begin it (and it can't
          // match empty) — avoids speculatively parsing+failing rules like
          // DecoratorExpr/TypeParams at every position.
          if (!ruleMightStart(expr.name, peek())) return null;
          const node = parseRule(expr.name);
          return node ? [node] : null;
        }
        case 'seq':
          return matchSeq(expr.items);
        case 'alt': {
          const saved = pos;
          for (const item of expr.items) {
            pos = saved;
            const result = matchExpr(item);
            if (result !== null) return result;
          }
          pos = saved;
          return null;
        }
        case 'quantifier':
          return matchQuantifier(expr.body, expr.kind);
        case 'group':
          // A `suppress`-carrying group disables the listed LED connectors for the
          // rule it wraps: stage them for the next parseRule to pick up.
          if (expr.suppress && expr.suppress.length) suppressNext = new Set(expr.suppress);
          return matchExpr(expr.body);
        case 'not': {
          // Zero-width negative lookahead: succeed (no children) iff the body
          // does NOT match here; never consume input either way.
          const kw = notKwSet(expr);
          if (kw) {                                              // fast path: one membership test
            const tok = peek();
            const hit = !!tok && tok.type !== '' && tokenNames.has(tok.type) && kw.has(tok.text);
            return hit ? null : [];
          }
          const saved = pos;
          const m = matchExpr(expr.body);
          pos = saved;
          return m === null ? [] : null;
        }
        case 'sameLine': {
          // Zero-width "no LineTerminator here": succeed (no children) iff the
          // next token isn't preceded by a newline. At EOF there's no token to
          // continue onto, so the assertion fails (nothing same-line follows).
          const tok = peek();
          return tok && !tok.newlineBefore ? [] : null;
        }
        case 'noCommentBefore': {
          // Zero-width "no comment was skipped before the next token": succeed (no children) iff the
          // next token isn't flagged `commentBefore`. At EOF there is no continuation, so it fails.
          const tok = peek();
          return tok && !tok.commentBefore ? [] : null;
        }
        case 'noMultilineFlowBefore': {
          // Zero-width "the flow collection that just closed was single-line": succeed (no children)
          // iff the next token isn't flagged `multilineFlowBefore`. At EOF there is no continuation,
          // so it fails (a multi-line flow can't be an implicit block key — yaml-test-suite C2SP).
          const tok = peek();
          return tok && !tok.multilineFlowBefore ? [] : null;
        }
        case 'notLeftLeaf':
          // The head-leaf LED gate is applied in the Pratt LED loop (not here); the marker is
          // stripped from the LED arm's items, so it never reaches here. As a leaf-position no-op
          // it consumes nothing and succeeds (returns no children).
          return [];
        case 'sep':
          return matchSep(expr.element, expr.delimiter);
        default:
          // op / prefix / postfix markers are handled by the Pratt parser.
          return null;
      }
    }

    function matchSeq(items: RuleExpr[]): CstChild[] | null {
      const saved = pos;
      const children: CstChild[] = [];
      for (const item of items) {
        // Skip op/prefix/postfix markers in sequence (handled by Pratt)
        if (item.type === 'op' || item.type === 'prefix' || item.type === 'postfix') continue;
        const result = matchExpr(item);
        if (result === null) { pos = saved; return null; }
        children.push(...result);
      }
      return children;
    }

    // The markup container arm (`<tag …> content </tag>`), honouring optional end tags.
    // Identical to a plain matchSeq for ordinary elements; for an OPTIONAL-END element
    // (its open-tag name is a key in `optionalEnd`) the content stops at a trigger sibling
    // start tag and the close tag may be omitted. Reproduces the exact flat child list the
    // generic match would (open punctuation + name + attrs + content nodes + close), so the
    // CST — and every test that walks it — is unchanged for already-supported input.
    function matchMarkupContainer(): CstChild[] | null {
      const c = markupContainer!;
      const saved = pos;
      const children: CstChild[] = [];

      // Open tag: items[0 .. contentIdx-1]  (tagOpen, Name, many(Attr), …, tagClose).
      let openName = '';
      for (let i = 0; i < c.contentIdx; i++) {
        const item = c.items[i];
        if (item.type === 'op' || item.type === 'prefix' || item.type === 'postfix') continue;
        const result = matchExpr(item);
        if (result === null) { pos = saved; return null; }
        // The open-tag name leaf (a name token) — drives the optional-end lookup.
        if (item.type === 'ref' && c.nameTokens.has(item.name) && result[0] !== undefined && 'tokenType' in result[0]) {
          openName = source.slice(result[0].offset, result[0].end);
        }
        children.push(...result);
      }

      const triggers = optionalEnd.get(openName.toLowerCase());

      // Content: a `*` over the content rule. For an optional-end element, stop the
      // repetition when the next start tag is a trigger sibling (it belongs to the
      // PARENT's content, which resumes once this element closes implicitly). Content
      // already stops at any `</…>` (the content rule can't begin with closeMarker), so
      // an ancestor end tag closes the element too — no extra check needed.
      const contentBody = (c.items[c.contentIdx] as { body: RuleExpr }).body;
      while (true) {
        if (triggers && atTriggerStartTag(triggers)) break;
        const before = pos;
        const result = matchExpr(contentBody);
        if (result === null) { pos = before; break; }
        if (result.length === 0 && pos === before) break;
        children.push(...result);
      }

      // Close tag: items[closeStart .. end]  (tagOpen, closeMarker, Name, tagClose). Match
      // the whole sequence, but only ACCEPT it when the close-tag name equals the open-tag
      // name (case-insensitive — HTML tag names are ASCII-case-insensitive). A mismatched
      // close belongs to an ANCESTOR, so an optional-end element must not greedily consume it
      // (`<ul><li>a</ul>`: the li must leave `</ul>` for the ul). Name equality is the HTML
      // well-formed invariant, so this never rejects valid already-supported input.
      const beforeClose = pos;
      const close = matchSeq(c.items.slice(c.closeStart));
      if (close !== null) {
        const closeName = close.find((ch, i) => i > 0 && 'tokenType' in ch && c.nameTokens.has(ch.tokenType)) as CstLeaf | undefined;
        if (!closeName || source.slice(closeName.offset, closeName.end).toLowerCase() === openName.toLowerCase()) {
          children.push(...close);
          return children;
        }
        pos = beforeClose;   // mismatched close → not ours; fall through
      }
      // No (matching) close tag here. Allowed only for an optional-end element (it was closed
      // by a trigger sibling or an ancestor end tag); a normal element still REQUIRES its close.
      pos = beforeClose;
      if (triggers) return children;
      pos = saved;
      return null;
    }

    // Is the lookahead a start tag `tagOpen Name…` whose name is in `triggers`? (Used to
    // stop an optional-end element's content at a sibling that implicitly closes it.) A
    // close tag (`tagOpen closeMarker …`) is NOT a trigger — content stops at it anyway.
    function atTriggerStartTag(triggers: Set<string>): boolean {
      const t0 = tokens[pos];
      if (!t0 || t0.type !== '' || t0.text !== markup!.tagOpen) return false;
      const t1 = tokens[pos + 1];
      if (!t1) return false;
      if (markup!.closeMarker && t1.type === '' && t1.text === markup!.closeMarker) return false;
      if (!markupContainer!.nameTokens.has(t1.type)) return false;   // not a name token
      return triggers.has(t1.text.toLowerCase());
    }

    // Mixfix operand re-bound (see ledMixfix). The LED shape is
    // `<openLit> $self <sepLit> …rest`; the normal match already failed. Re-parse
    // the inner `$self` operand with a position cap so it stops before a `sepLit`
    // token at the *same* bracket depth as `openLit`, freeing that token for the
    // operator's own separator, then match `sepLit` and the rest uncapped.
    // `pos` is at `openLit` on entry. Returns the LED children or null (restored).
    function matchMixfixLed(led: { items: RuleExpr[] }, ruleName: string, info: { openLit: string; sepLit: string }): CstChild[] | null {
      const saved = pos;
      const openLeaf = matchLiteral(info.openLit);
      if (!openLeaf) { pos = saved; return null; }
      const afterOpen = pos;

      // Greedy parse of the operand, to (a) confirm the separator is missing right
      // after it (otherwise the failure is elsewhere → don't apply) and (b) bound
      // the scan window.
      const operand = parseRule(ruleName);
      if (!operand) { pos = saved; return null; }
      const greedyEnd = pos;
      // If the separator DOES match here, the LED's failure was later in `rest`,
      // not operand over-consumption — re-bounding wouldn't help.
      if (matchLiteral(info.sepLit)) { pos = saved; return null; }

      // Candidate separator positions: `sepLit` tokens at bracket depth 0 within
      // (afterOpen, greedyEnd). A nested same-shape operator (e.g. a nested
      // ternary) contributes its own depth-0 `sepLit`, so we try candidates in
      // order and accept the first where the capped operand lands exactly on it.
      let depth = 0;
      const candidates: number[] = [];
      for (let i = afterOpen; i < greedyEnd; i++) {
        const t = tokens[i];
        if (t.type !== '') continue;                 // only punctuation carries brackets/sep
        if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
        else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;
        else if (depth === 0 && t.text === info.sepLit) candidates.push(i);
      }

      for (const sepIdx of candidates) {
        // Re-parse the operand capped so it cannot consume the token at sepIdx;
        // accept only if the operand consumes everything up to exactly there.
        pos = afterOpen;
        const prevLimit = parseLimit;
        parseLimit = sepIdx;
        const reOperand = parseRule(ruleName);
        parseLimit = prevLimit;
        if (!reOperand || pos !== sepIdx) continue;

        const sepLeaf = matchLiteral(info.sepLit);
        if (!sepLeaf) continue;
        const rest = matchSeq(led.items.slice(3));
        if (rest === null) continue;
        return [openLeaf, reOperand, sepLeaf, ...rest];
      }

      pos = saved;
      return null;
    }

    function matchQuantifier(body: RuleExpr, kind: '*' | '+' | '?'): CstChild[] | null {
      if (kind === '?') {
        const result = matchExpr(body);
        return result ?? [];
      }
      if (kind === '*') {
        const children: CstChild[] = [];
        while (true) {
          const saved = pos;
          const result = matchExpr(body);
          if (result === null) { pos = saved; break; }
          if (result.length === 0 && pos === saved) break;
          children.push(...result);
        }
        return children;
      }
      // kind === '+'
      const first = matchExpr(body);
      if (first === null) return null;
      const children: CstChild[] = [...first];
      while (true) {
        const saved = pos;
        const result = matchExpr(body);
        if (result === null) { pos = saved; break; }
        if (result.length === 0 && pos === saved) break;
        children.push(...result);
      }
      return children;
    }

    function matchSep(element: RuleExpr, delimiter: string): CstChild[] | null {
      // sep = (element (delimiter element)*)?
      const saved = pos;
      const first = matchExpr(element);
      if (first === null) { pos = saved; return []; }
      const children: CstChild[] = [...first];
      while (true) {
        const delimSaved = pos;
        const delimLeaf = matchLiteral(delimiter);
        if (!delimLeaf) { pos = delimSaved; break; }
        const next = matchExpr(element);
        if (next === null) { children.push(delimLeaf); break; }   // trailing delimiter OK
        children.push(delimLeaf, ...next);
      }
      return children;
    }

    // Entry
    const entry = entryRule ?? findEntryRule(grammar);
    if (tokens.length === 0) {
      return { rule: entry, children: [], offset: 0, end: 0 };
    }
    const result = parseRule(entry);
    if (!result) {
      const tok = peek();
      throw new Error(`Parse error at offset ${tok?.offset ?? 0}: unexpected ${tok ? `'${tok.text}'` : 'end of input'}${farthest(pos)}`);
    }
    // Check all input consumed
    if (pos < tokens.length) {
      const tok = tokens[pos];
      throw new Error(`Parse error at offset ${tok.offset}: unexpected '${tok.text}' after successful parse${farthest(pos)}`);
    }
    return result;

    // Diagnostic: when backtracking reached further than the reported error
    // position, point at that deepest spot — it's usually nearer the real cause.
    function farthest(errPos: number): string {
      if (maxPos <= errPos || maxPos >= tokens.length) return '';
      const tok = tokens[maxPos];
      return ` [farthest: offset ${tok.offset} near '${tok.text.slice(0, 20)}']`;
    }
  }

  // API parity with the emitted engine's handle surface: edit() re-parses and
  // updates the SAME tree object in place (the handle is the document's tree —
  // edit returns nothing, exactly like the emitted engine; no reuse here), and
  // both are TOTAL: input errors land in the errors field, never a throw. The
  // interpreter has no recovery machinery, so an invalid text degrades to a
  // zero-width $error root plus the strict diagnostic.
  type Cst = { rule: string; children: unknown[]; offset: number; end: number; errors?: { offset: number; end: number; message: string }[] };
  const parseTotal = (source: string): Cst => {
    try {
      const t = parse(source) as Cst;
      t.errors = [];
      return t;
    } catch (e) {
      return { rule: '$error', children: [], offset: 0, end: 0, errors: [{ offset: 0, end: 0, message: (e as Error).message }] };
    }
  };
  const edit = (cst: Cst, source: string): void => {
    const next = parseTotal(source);
    cst.rule = next.rule; cst.children = next.children;
    cst.offset = next.offset; cst.end = next.end;
    cst.errors = next.errors;
  };
  return { parse, parseTotal, edit, tokenize, profCounts };
}

// ── Helpers ──

function childOffset(child: CstChild): number {
  return child.offset;
}

function childEnd(child: CstChild): number {
  return child.end;
}
