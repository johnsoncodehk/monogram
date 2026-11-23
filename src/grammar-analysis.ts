// grammar-analysis.ts — the STRUCTURAL static analysis both parser engines derive from a
// CstGrammar, single-sourced. createParser (gen-parser.ts, the runtime interpreter / oracle)
// and emitParser (emit-parser.ts, the standalone compiler) must agree on precedence/binding
// power, NUD/LED (Pratt) and atom/continuation (left-rec) classification, nullability, and —
// critically — what counts as left-recursive. These are pure functions of the grammar, so a
// second hand-written copy is not an independent oracle, only a place for the two to DRIFT.
// One of those drifts was real: the emitter classified left recursion by the syntactic
// `items[0]===self` test while the interpreter used the left-corner transitive closure, so a
// rule recursive only INDIRECTLY or behind a nullable prefix would be routed differently and
// produce divergent CSTs (issue #45 A3). Single-sourcing makes them agree by construction.
//
// What stays per-engine (NOT here): the FIRST/SECOND sets (the emitter's are the richer
// reserved-aware "qualKeys" variant) and every parse CONTROL loop. The interpreter keeps its
// loops independent so it remains a genuine oracle for the emitter's loops — an oracle sharing
// the suspect machinery could not catch bugs in it.
import type { CstGrammar, RuleExpr, RuleDecl, ElementRegion } from './types.ts';
import { tokenPatternFirstCharSet } from './token-pattern.ts';

export interface OpInfo {
  lbp: number;
  rbp: number;
  assoc: 'left' | 'right' | 'none';
  position: 'infix' | 'prefix' | 'postfix';
  requireTarget?: boolean;
  // A capped prefix operator (PrecOperator.capped): it begins an operand only while minBp < capBp
  // (its own level's binding power).
  capBp?: number;
}

/** A rule's SECOND-token dispatch summary: the keys admissible as the second token (null =
 *  top/anything) and whether a one-token match exists. */
export type Sec = { s: Set<string> | null; len1: boolean };

/** True if an expression carries a Pratt marker (op/prefix/postfix) anywhere. */
export function hasMarker(expr: RuleExpr): boolean {
  if (expr.type === 'op' || expr.type === 'prefix' || expr.type === 'postfix') return true;
  if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(hasMarker);
  if (expr.type === 'quantifier' || expr.type === 'group') return hasMarker(expr.body);
  if (expr.type === 'sep') return hasMarker(expr.element);
  return false;
}

/** The entry rule: the declared `entry` (`CstGrammar.entryRule`), else the last declared rule. */
export function findEntryRule(grammar: CstGrammar): string {
  return grammar.entryRule ?? grammar.rules[grammar.rules.length - 1].name;
}

/**
 * Derive the full STRUCTURAL analysis, returned as plain data + live closures. Both engines
 * call this once and destructure; their downstream code keeps its own local names.
 */
/**
 * The rules that can derive the EMPTY string (fixpoint over the rule bodies), plus the expression
 * predicate behind it. Single-sourced here because two consumers need the same answer: the
 * analysis below (left-corner edges, alt dispatch) and `defineGrammar`, which REJECTS a nullable
 * non-entry rule at definition time. The engine never lets a rule succeed with an empty match
 * (`parseNonRec` keeps an alternative only when it advanced, `pos > bestPos`), so a nullable
 * rule's empty case is unreachable: a reference to it FAILS wherever it would have matched
 * nothing, which silently drops whole parses (`[Filler, Stmt]` with a `Filler = rule(() =>
 * [[many(NL)]])` rejects every `Stmt`). The entry rule is exempt (an empty document is handled
 * by the driver).
 */
export function computeNullableRules(grammar: CstGrammar): { nullableRules: Set<string>; exprNullable: (e: RuleExpr) => boolean } {
  const tokenNames = new Set(grammar.tokens.map(t => t.name));
  const nullableRules = new Set<string>();
  function exprNullable(e: RuleExpr): boolean {
    switch (e.type) {
      case 'literal': return false;
      case 'ref': return tokenNames.has(e.name) ? false : nullableRules.has(e.name);
      case 'seq': return e.items.every(exprNullable);
      case 'alt': return e.items.some(exprNullable);
      case 'quantifier': return e.kind === '+' ? exprNullable(e.body) : true;
      case 'group': return exprNullable(e.body);
      case 'not': return true;                                   // zero-width assertion: consumes nothing
      case 'sep': return true;                                   // sep matches zero elements
      default: return true;                                      // op/prefix/postfix markers don't consume
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      if (!nullableRules.has(rule.name) && exprNullable(rule.body)) { nullableRules.add(rule.name); changed = true; }
    }
  }
  return { nullableRules, exprNullable };
}

/** The markup CONTAINER arm — `tagOpen Name … tagClose content* tagOpen closeMarker Name tagClose`
 *  (an HTML element with children) — and the data its two rules read:
 *    • the end tag's name is the start tag's (compared ASCII-case-insensitively);
 *    • an element named in `optionalEnd` stops its content at a start tag whose name is one of
 *      its triggers, and its end tag may be omitted (MarkupConfig.optionalEndTags).
 *  Recognised STRUCTURALLY, from the markup delimiters and the name token — no tag name is
 *  known here. A pure function of the grammar: both engines match this arm with their own
 *  control, over this one description of it. null → the grammar has no such arm (no markup
 *  config, no closeMarker, or no optionalEndTags) and every arm is a plain sequence. */
export interface MarkupContainer {
  arm: RuleExpr;            // the container alternative (a `seq`)
  items: RuleExpr[];        // its sequence items
  openNameIdx: number;      // index of the start tag's name (a token ref)
  contentIdx: number;       // index of the `content*` quantifier
  closeStart: number;       // index where the end tag begins (its tagOpen)
  closeNameIdx: number;     // index of the end tag's name (a token ref)
  nameTokens: Set<string>;  // token name(s) that carry an element name (e.g. Name)
  optionalEnd: Map<string, Set<string>>;  // lowercased name → lowercased trigger start-tag names
}
export function markupContainerOf(grammar: CstGrammar): MarkupContainer | null {
  const markup = grammar.markup;
  if (!markup?.optionalEndTags) return null;
  const optionalEnd = new Map<string, Set<string>>();
  for (const [name, triggers] of Object.entries(markup.optionalEndTags)) {
    optionalEnd.set(name.toLowerCase(), new Set(triggers.map(t => t.toLowerCase())));
  }
  if (optionalEnd.size === 0) return null;
  const open = markup.tagOpen, close = markup.tagClose, cm = markup.closeMarker;
  if (!cm) return null;
  const tokenNames = new Set(grammar.tokens.map(t => t.name));
  const isLit = (e: RuleExpr | undefined, v: string) => !!e && e.type === 'literal' && e.value === v;
  for (const rule of grammar.rules) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      const n = items.length;
      // Shape: open  Name  …  close  <content*>  open  closeMarker  Name  close
      if (n < 6) continue;
      const openName = items[1], closeName = items[n - 2];
      if (!isLit(items[0], open) || openName.type !== 'ref' || !tokenNames.has(openName.name)) continue;
      if (!(isLit(items[n - 4], open) && isLit(items[n - 3], cm) && closeName.type === 'ref' && tokenNames.has(closeName.name) && isLit(items[n - 1], close))) continue;
      // The content quantifier sits right before the end tag, after the start tag's `close`.
      const contentIdx = n - 5;
      const content = items[contentIdx];
      if (!content || content.type !== 'quantifier' || content.kind !== '*') continue;
      if (!isLit(items[contentIdx - 1], close)) continue;   // the start tag's `>` precedes content
      return {
        arm: alt, items, openNameIdx: 1, contentIdx, closeStart: n - 4, closeNameIdx: n - 2,
        nameTokens: new Set([openName.name, closeName.name]), optionalEnd,
      };
    }
  }
  return null;
}

export function analyzeGrammar(grammar: CstGrammar) {
  const tokenNames = new Set(grammar.tokens.map(t => t.name));

  // ── Precedence table ──
  const opTable = new Map<string, OpInfo>();
  const prefixOps = new Map<string, OpInfo>();
  // Infix ops whose LEFT operand may not be a bare unary-prefix expression (e.g. `**`).
  const noUnaryLhsOps = new Set<string>();
  const postfixOpValues = new Set<string>();
  // Infix/prefix/postfix ops whose operand must be a valid assignment target (see
  // PrecOperator.requireTarget).
  const requireTargetOps = new Set<string>();
  for (let i = 0; i < grammar.precs.length; i++) {
    const level = grammar.precs[i];
    const bp = (i + 1) * 2;
    for (const op of level.operators) {
      if (op.position === 'prefix') {
        prefixOps.set(op.value, { lbp: 0, rbp: level.assoc === 'right' ? bp - 1 : bp, assoc: level.assoc, position: 'prefix', requireTarget: op.requireTarget, ...(op.capped ? { capBp: bp } : {}) });
        if (op.requireTarget) requireTargetOps.add(op.value);
      } else if (op.position === 'postfix') {
        postfixOpValues.add(op.value);
        opTable.set(op.value, { lbp: bp, rbp: 0, assoc: level.assoc, position: 'postfix', requireTarget: op.requireTarget });
        if (op.requireTarget) requireTargetOps.add(op.value);
      } else {
        const lbp = bp;
        const rbp = level.assoc === 'right' ? bp - 1 : bp;
        opTable.set(op.value, { lbp, rbp, assoc: level.assoc, position: 'infix', requireTarget: op.requireTarget });
        if (op.noUnaryLhs) noUnaryLhsOps.add(op.value);
        if (op.requireTarget) requireTargetOps.add(op.value);
      }
    }
  }

  // Alternative-form LED binding powers (see LedPrec in types.ts): resolve the ladder
  // anchors to concrete lbp numbers. Levels are spaced 2 apart, so `below` (lbp-1) sits
  // BETWEEN two ladder levels without colliding with any op's lbp/rbp.
  const ledPrecByConnector = new Map<string, { lbp: number; rhsBp: number | null }>();
  for (const lp of grammar.ledPrecs ?? []) {
    const anchorOp = lp.sameAs ?? lp.below;
    if (!anchorOp) throw new Error(`ledPrec ${lp.connector}: needs sameAs or below`);
    const op = opTable.get(anchorOp);
    if (!op) throw new Error(`ledPrec ${lp.connector}: anchor ${JSON.stringify(anchorOp)} is not a ladder operator`);
    const lbp = lp.sameAs !== undefined ? op.lbp : op.lbp - 1;
    ledPrecByConnector.set(lp.connector, { lbp, rhsBp: lp.chainRhs ? lbp : null });
  }

  // Alternative-form binary connectors (`?`, `in`, `as`, …: the MIDDLE child of a ledPrec LED) —
  // a node with one at child[1] is not a LeftHandSideExpression, so not an assignment target
  // (`a in b = c`). Ladder INFIX ops are recognized by their operator-tagged leaf instead: the
  // same text as a LED literal (`<` of `f<T>()`) is punctuation and keeps the call a target.
  const binaryConnectors = new Set<string>(ledPrecByConnector.keys());

  // A `cap`-group NUD (an ArrowFunction — the lowest-precedence AssignmentExpression) parses
  // only when minBp is LOOSER than the named connector's binding power; the value resolves
  // from the ladder or the ledPrec table.
  const connectorLbp = (connector: string): number => {
    const op = opTable.get(connector);
    if (op) return op.lbp;
    const lp = ledPrecByConnector.get(connector);
    if (lp) return lp.lbp;
    throw new Error(`capExpr / atLevel: connector ${JSON.stringify(connector)} is not a ladder operator or ledPrec connector`);
  };
  const nudCapOf = (nud: RuleExpr): number | null =>
    nud.type === 'group' && nud.capBelow !== undefined ? connectorLbp(nud.capBelow) : null;
  // An atLevel group (`atLevel(op, R)`): the minBp R is read at, so that op's level and every
  // tighter one bind (lbp > minBp) and every looser one does not.
  const atLevelBp = (g: RuleExpr): number | null =>
    g.type === 'group' && g.atLevel !== undefined ? connectorLbp(g.atLevel) - 1 : null;

  // ── Pratt vs ordinary rules ──
  const prattRules = new Set<string>();
  for (const rule of grammar.rules) if (hasMarker(rule.body)) prattRules.add(rule.name);
  // atLevel reads a Pratt rule at a binding power: refuse it on anything else, by name.
  const checkAtLevel = (e: RuleExpr, inRule: string): void => {
    if (e.type === 'group' && e.atLevel !== undefined) {
      if (e.body.type !== 'ref' || !prattRules.has(e.body.name)) throw new Error(`atLevel('${e.atLevel}', …) in rule ${inRule}: its body must be a reference to a Pratt rule`);
      atLevelBp(e);   // the operator resolves, or this throws naming it
    }
    if (e.type === 'seq' || e.type === 'alt') for (const i of e.items) checkAtLevel(i, inRule);
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') checkAtLevel(e.body, inRule);
    else if (e.type === 'sep') checkAtLevel(e.element, inRule);
  };
  for (const rule of grammar.rules) checkAtLevel(rule.body, rule.name);

  // For Pratt rules, split alternatives into NUD (atoms/prefix) and LED (left-recursive).
  function classifyAlts(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const nuds: RuleExpr[] = [];
    const leds: { expr: RuleExpr; items: RuleExpr[]; notLeftLeaf?: string[] }[] = [];
    // The postfix-operator arm written `[$, sameLine, postfix]`: a restricted production
    // (ECMAScript `LeftHandSideExpression [no LineTerminator here] ++`). The operator binds
    // only on its operand's line; after a line break it is left to whatever follows the
    // operand. The arm's `led.items` stay `[postfix]`, like the unrestricted `[$, postfix]`.
    let postfixSameLine = false;
    for (const alt of alts) {
      let items = alt.type === 'seq' ? alt.items : [alt];
      const self = items[0]?.type === 'notLeftLeaf' ? 1 : 0;
      if (items[self + 1]?.type === 'sameLine' && items[self + 2]?.type === 'postfix') {
        postfixSameLine = true;
        items = [...items.slice(0, self + 1), ...items.slice(self + 2)];
      }
      // A LED arm may carry a leading `notLeftLeaf(...)` head-leaf guard before the self `$`
      // (`[notLeftLeaf('void',…), $, '.', Ident]`). Strip it into LED metadata; the self-ref is
      // the next item and `led.items` is everything after it — identical to a plain LED.
      const guard = items[0]?.type === 'notLeftLeaf' ? items[0].words : undefined;
      const head = guard ? 1 : 0;
      if (items[head]?.type === 'ref' && (items[head] as { name: string }).name === rule.name) {
        leds.push({ expr: alt, items: items.slice(head + 1), notLeftLeaf: guard });
      } else nuds.push(alt);
    }
    return { nuds, leds, postfixSameLine };
  }

  // For non-Pratt left-recursive rules, split into atoms and continuations.
  function classifyLeftRec(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const atoms: RuleExpr[] = [];
    const continuations: RuleExpr[][] = [];
    const contNotLeftLeaf: (string[] | null)[] = [];
    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      // A continuation may carry a leading `notLeftLeaf(...)` head-leaf guard before the self `$`.
      const guard = items[0]?.type === 'notLeftLeaf' ? items[0].words : undefined;
      const head = guard ? 1 : 0;
      if (items[head]?.type === 'ref' && (items[head] as { name: string }).name === rule.name) {
        continuations.push(items.slice(head + 1));
        contNotLeftLeaf.push(guard ?? null);
      } else atoms.push(alt);
    }
    return { atoms, continuations, contNotLeftLeaf };
  }

  // ── Left recursion = a left-corner cycle ──
  // What "left-recursive" MEANS is the left-corner relation, not the syntactic `items[0]===self`
  // shape: a rule is left-recursive iff it can derive ITSELF as its leftmost symbol without
  // consuming input — i.e. reach itself through the transitive closure of the left-corner edge
  // map. That captures DIRECT recursion (A → A …), INDIRECT cycles (A → B → A) and recursion
  // HIDDEN behind a nullable prefix (A → opt(x) A …) alike. The narrower `items[0]===self` test
  // is NOT the definition; it only identifies which alternatives the local atom/continuation
  // (and Pratt NUD/LED) transform peels into an iterative loop — see the residual graph below.
  //
  // Nullability feeds the left-corner edges (a nullable leftmost element passes through to the
  // next), so compute it first. op/prefix/postfix consume an operator token → left-edge BARRIERS.
  const { nullableRules, exprNullable } = computeNullableRules(grammar);

  // The set of rules reachable at the LEFT CORNER of an expression: every rule ref that could be
  // the leftmost symbol, looking through nullable prefixes and stopping at the first non-nullable
  // element or operator barrier.
  function leftRuleRefs(e: RuleExpr): Set<string> {
    switch (e.type) {
      case 'ref': return tokenNames.has(e.name) ? new Set() : new Set([e.name]);
      case 'seq': {
        const acc = new Set<string>();
        for (const item of e.items) {
          if (item.type === 'op' || item.type === 'prefix' || item.type === 'postfix') break;  // operator token → barrier
          for (const r of leftRuleRefs(item)) acc.add(r);
          if (!exprNullable(item)) break;            // a non-nullable element ends the left edge
        }
        return acc;
      }
      case 'alt': { const acc = new Set<string>(); for (const b of e.items) for (const r of leftRuleRefs(b)) acc.add(r); return acc; }
      case 'quantifier': case 'group': return leftRuleRefs(e.body);
      case 'sep': return leftRuleRefs(e.element);
      default: return new Set();                     // literal / not / sameLine / … : no leftmost rule ref
    }
  }

  function altsOf(rule: RuleDecl): RuleExpr[] {
    return rule.body.type === 'alt' ? rule.body.items : [rule.body];
  }
  function itemsOf(alt: RuleExpr): RuleExpr[] {
    return alt.type === 'seq' ? alt.items : [alt];
  }
  // Does this alternative begin with a DIRECT self-reference (`A → A …`)? This is the ONLY thing
  // `items[0]===self` decides: which alts the local transform peels into an iterative loop (and so
  // which edges drop out of the residual graph). It is no longer a standalone definition of LR.
  function peelsDirect(rule: RuleDecl, alt: RuleExpr): boolean {
    const items = itemsOf(alt);
    // A leading zero-width `notLeftLeaf(...)` head-leaf guard precedes the self `$` in a LED arm;
    // the arm is still DIRECT left-recursion (the local Pratt transform peels it), so look past it.
    const head = items[0]?.type === 'notLeftLeaf' ? 1 : 0;
    return items[head]?.type === 'ref' && (items[head] as { name: string }).name === rule.name;
  }
  // The PURE left-corner edge map, over ALL alternatives. This is the relation that DEFINES LR.
  const leftCorner = new Map<string, Set<string>>();
  for (const rule of grammar.rules) {
    const edges = new Set<string>();
    for (const alt of altsOf(rule)) for (const r of leftRuleRefs(alt)) edges.add(r);
    leftCorner.set(rule.name, edges);
  }
  // The RESIDUAL left-corner edge map: `leftCorner` minus each rule's direct `items[0]===self`
  // alts — the edges the local transform turns into an iterative loop. A left-recursive rule is
  // HANDLEABLE iff peeling its direct self-alts breaks every cycle through it.
  const residualCorner = new Map<string, Set<string>>();
  for (const rule of grammar.rules) {
    const edges = new Set<string>();
    for (const alt of altsOf(rule)) {
      if (peelsDirect(rule, alt)) continue;          // peeled into an iterative loop → not a recursive descent
      for (const r of leftRuleRefs(alt)) edges.add(r);
    }
    residualCorner.set(rule.name, edges);
  }
  // Find a cycle start → … → start in a left-corner graph, returned as a path naming the
  // genuinely-recursive edges; null if `start` cannot reach itself.
  function cornerCycle(graph: Map<string, Set<string>>, start: string): string[] | null {
    const stack: { node: string; path: string[] }[] = [{ node: start, path: [start] }];
    const seen = new Set<string>();
    while (stack.length) {
      const { node, path } = stack.pop()!;
      for (const next of graph.get(node) ?? []) {
        if (next === start) return [...path, next];
        if (!seen.has(next)) { seen.add(next); stack.push({ node: next, path: [...path, next] }); }
      }
    }
    return null;
  }
  // THE definition of left recursion: the rule reaches itself through the transitive closure of
  // the pure left-corner relation.
  function isLeftRecursive(rule: RuleDecl): boolean {
    return cornerCycle(leftCorner, rule.name) !== null;
  }

  const maxBp = (grammar.precs.length + 1) * 2;
  const ruleByName = new Map<string, RuleDecl>(grammar.rules.map(r => [r.name, r]));

  // Left-recursive rules split two ways against the local transform:
  //   • HANDLEABLE — peeling the direct `items[0]===self` alts breaks every cycle (residual graph
  //     acyclic for this rule). These go in leftRecSet; classifyLeftRec / the Pratt path handle them.
  //   • UNHANDLEABLE — a cycle survives in the residual graph (INDIRECT, or HIDDEN behind a nullable
  //     prefix). The local transform cannot peel it and recursive descent would not terminate, so
  //     reject it at build time. This is the correct product behavior in BOTH engines.
  const leftRecSet = new Set<string>();
  for (const rule of grammar.rules) {
    if (!isLeftRecursive(rule)) continue;
    const residual = cornerCycle(residualCorner, rule.name);
    if (residual) {
      throw new Error(
        `Unhandled left recursion in rule '${rule.name}': it can derive itself as its leftmost `
        + `symbol without consuming input (left-corner cycle ${residual.join(' → ')}). The engine `
        + `transforms only DIRECT left recursion (an alternative beginning with the rule itself); `
        + `this cycle is indirect or hidden behind a nullable prefix, so recursive descent would `
        + `not terminate. Break the cycle or rewrite it as a direct left-recursive/precedence rule.`,
      );
    }
    leftRecSet.add(rule.name);
  }

  const prattClassified = new Map<string, ReturnType<typeof classifyAlts>>();
  const leftRecClassified = new Map<string, ReturnType<typeof classifyLeftRec>>();
  for (const rule of grammar.rules) {
    if (prattRules.has(rule.name)) prattClassified.set(rule.name, classifyAlts(rule));
    else if (leftRecSet.has(rule.name)) leftRecClassified.set(rule.name, classifyLeftRec(rule));
  }

  const templateTokenName = grammar.tokens.find(t => t.template)?.name;
  const templateTokenNames = new Set<string>(grammar.tokens.filter(t => t.template).map(t => t.name));

  // ── Plain FIRST sets ──
  // The set of tokens each rule can begin with (null = "anything" — left-recursive / prefix
  // rules). This is the PLAIN variant (no reserved-qualified keys, prefix → top). The emitter
  // adds a richer reserved-aware "qualKeys" FIRST on top, for its own FIRST dispatch only; the
  // SECOND sets below feed off the PLAIN one in BOTH engines, so single-sourcing it here keeps
  // their prune decisions engine-identical (the emit-reject-messages gate depends on that).
  const firstSets = new Map<string, Set<string> | null>();   // null = top (anything)
  function exprFirst(e: RuleExpr): Set<string> | null {
    switch (e.type) {
      case 'literal': return new Set([e.value]);
      case 'ref': {
        if (tokenNames.has(e.name)) return new Set([e.name]);
        return firstSets.has(e.name) ? firstSets.get(e.name)! : new Set();  // unresolved → empty this round
      }
      case 'seq': {
        const acc = new Set<string>();
        for (const item of e.items) {
          if (item.type === 'prefix') return null;               // prefix op → any operator token: give up
          if (item.type === 'op' || item.type === 'postfix' || item.type === 'not' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore' || item.type === 'notLeftLeaf') continue;
          const f = exprFirst(item);
          if (f === null) return null;
          for (const k of f) acc.add(k);
          if (!exprNullable(item)) return acc;                   // stop at first non-nullable element
        }
        return acc;
      }
      case 'alt': {
        const acc = new Set<string>();
        for (const item of e.items) {
          const f = exprFirst(item);
          if (f === null) return null;
          for (const k of f) acc.add(k);
        }
        return acc;
      }
      case 'quantifier': case 'group': return exprFirst(e.body);
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore': case 'notLeftLeaf': return new Set();
      case 'sep': return exprFirst(e.element);
      default: return null;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      const prev = firstSets.get(rule.name);
      if (prev === null) continue;                               // null is terminal
      const next = exprFirst(rule.body);
      if (next === null) { firstSets.set(rule.name, null); changed = true; continue; }
      const merged = prev ? new Set(prev) : new Set<string>();
      let grew = false;
      for (const k of next) if (!merged.has(k)) { merged.add(k); grew = true; }
      if (grew || prev === undefined) { firstSets.set(rule.name, merged); changed = true; }
    }
  }

  // ── SECOND-token dispatch refinement ──
  // The keys admissible as a match's SECOND token, plus whether a one-token match exists
  // (len1). An admitted alternative whose SECOND set excludes the actual second token — and
  // that cannot end after one token — provably fails, so its arm is skipped before it runs.
  // Over-approximated everywhere (unknown shapes → top, op/prefix/postfix items are one-op-
  // token consumers with known literal sets). Both engines consume this verbatim, so the
  // prune decisions are engine-identical by construction.
  const SEC_TOP: Sec = { s: null, len1: true };
  const ruleSecond = new Map<string, Sec>();
  const opKeys = new Set<string>([...opTable.keys(), ...postfixOpValues]);
  function suffixFirst(items: RuleExpr[], j: number): Set<string> | null {
    const acc = new Set<string>();
    for (let i = j; i < items.length; i++) {
      const item = items[i];
      if (item.type === 'not' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore' || item.type === 'notLeftLeaf') continue;
      if (item.type === 'op' || item.type === 'postfix') { for (const k of opKeys) acc.add(k); return acc; }
      if (item.type === 'prefix') { for (const k of prefixOps.keys()) acc.add(k); return acc; }
      const f = exprFirst(item);
      if (f === null) return null;
      for (const k of f) acc.add(k);
      if (!exprNullable(item)) return acc;
    }
    return acc;
  }
  function suffixNullable(items: RuleExpr[], j: number): boolean {
    for (let i = j; i < items.length; i++) {
      const item = items[i];
      if (item.type === 'not' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore' || item.type === 'notLeftLeaf') continue;
      if (item.type === 'op' || item.type === 'prefix' || item.type === 'postfix') return false;
      if (!exprNullable(item)) return false;
    }
    return true;
  }
  function exprSecond(e: RuleExpr): Sec {
    switch (e.type) {
      case 'literal': return { s: new Set(), len1: true };
      case 'ref':
        if (tokenNames.has(e.name)) return { s: new Set(), len1: true };
        return ruleSecond.get(e.name) ?? { s: new Set(), len1: false };
      case 'seq': {
        const acc = new Set<string>();
        let len1 = false;
        const items = e.items;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type === 'not' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore' || item.type === 'notLeftLeaf') continue;
          let isec: Sec;
          let itemNullable: boolean;
          if (item.type === 'op' || item.type === 'postfix' || item.type === 'prefix') {
            isec = { s: new Set(), len1: true };
            itemNullable = false;
          } else {
            isec = exprSecond(item);
            itemNullable = exprNullable(item);
          }
          if (isec.s === null) return SEC_TOP;
          for (const k of isec.s) acc.add(k);
          if (isec.len1) {
            const rf = suffixFirst(items, i + 1);
            if (rf === null) return SEC_TOP;
            for (const k of rf) acc.add(k);
            if (suffixNullable(items, i + 1)) len1 = true;
          }
          if (!itemNullable) return { s: acc, len1 };
        }
        return { s: acc, len1 };
      }
      case 'alt': {
        const acc = new Set<string>();
        let len1 = false;
        for (const item of e.items) {
          const sec = exprSecond(item);
          if (sec.s === null) return SEC_TOP;
          for (const k of sec.s) acc.add(k);
          len1 ||= sec.len1;
        }
        return { s: acc, len1 };
      }
      case 'quantifier': {
        const sec = exprSecond(e.body);
        if (sec.s === null) return SEC_TOP;
        const acc = new Set(sec.s);
        if (e.kind !== '?' && sec.len1) {
          const bf = exprFirst(e.body);
          if (bf === null) return SEC_TOP;
          for (const k of bf) acc.add(k);
        }
        return { s: acc, len1: sec.len1 };
      }
      case 'group': return exprSecond(e.body);
      case 'sep': {
        const sec = exprSecond(e.element);
        if (sec.s === null) return SEC_TOP;
        const acc = new Set(sec.s);
        if (sec.len1) acc.add(e.delimiter);
        return { s: acc, len1: sec.len1 };
      }
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore': case 'notLeftLeaf':
        return { s: new Set(), len1: false };
      case 'op': case 'prefix': case 'postfix':
        return { s: new Set(), len1: true };
      default: return SEC_TOP;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      const prev = ruleSecond.get(rule.name);
      if (prev && prev.s === null && prev.len1) continue;
      const next = exprSecond(rule.body);
      let nv: Sec;
      if (!prev) nv = next;
      else if (next.s === null || prev.s === null) nv = { s: null, len1: prev.len1 || next.len1 };
      else nv = { s: new Set([...prev.s, ...next.s]), len1: prev.len1 || next.len1 };
      const grew = !prev || (nv.s === null) !== (prev.s === null) || nv.len1 !== prev.len1
        || (nv.s !== null && prev.s !== null && nv.s.size > prev.s.size);
      if (grew) { ruleSecond.set(rule.name, nv); changed = true; }
    }
  }

  // ── SECOND by FIRST ──
  // exprSecond is ONE set for every match, whatever its first token; a list whose candidates all
  // continue with a name after their own first word (`const x` / `enum X`) has no separating
  // second set there. exprSecondBy keeps it per first token: for each key k the expression's
  // non-empty matches can begin with, the keys their second token can be (and whether a match of
  // one token begins with k), by the same over-approximation as exprSecond (null: not known, a
  // Pratt marker or a shape it does not follow). Per rule a fixpoint, as ruleSecond.
  type SecBy = Map<string, Sec>;
  const ruleSecondBy = new Map<string, SecBy | null>();
  const isZeroWidth = (t: RuleExpr['type']) => t === 'not' || t === 'sameLine' || t === 'noCommentBefore' || t === 'noMultilineFlowBefore' || t === 'notLeftLeaf';
  const addSec = (m: SecBy, k: string, x: Sec): void => {
    const o = m.get(k);
    if (o === undefined) m.set(k, { s: x.s === null ? null : new Set(x.s), len1: x.len1 });
    else m.set(k, { s: o.s === null || x.s === null ? null : new Set([...o.s, ...x.s]), len1: o.len1 || x.len1 });
  };
  // x continued by what can follow a one-token match: `follow` (null: anything).
  const extend = (x: Sec, follow: Set<string> | null, followNullable: boolean): Sec =>
    !x.len1 ? x : { s: x.s === null || follow === null ? null : new Set([...x.s, ...follow]), len1: followNullable };
  function exprSecondBy(e: RuleExpr): SecBy | null {
    switch (e.type) {
      case 'literal': return new Map([[e.value, { s: new Set(), len1: true }]]);
      case 'ref':
        if (tokenNames.has(e.name)) return new Map([[e.name, { s: new Set(), len1: true }]]);
        return ruleSecondBy.has(e.name) ? ruleSecondBy.get(e.name)! : new Map();
      case 'seq': {
        const out: SecBy = new Map();
        const items = e.items;
        for (let i = 0; i < items.length; i++) {
          const item = items[i]!;
          if (isZeroWidth(item.type)) continue;
          if (item.type === 'op' || item.type === 'postfix' || item.type === 'prefix') return null;
          const m = exprSecondBy(item);
          if (m === null) return null;
          const rf = suffixFirst(items, i + 1), rn = suffixNullable(items, i + 1);
          for (const [k, x] of m) addSec(out, k, extend(x, rf, rn));
          if (!exprNullable(item)) return out;
        }
        return out;
      }
      case 'alt': {
        const out: SecBy = new Map();
        for (const item of e.items) { const m = exprSecondBy(item); if (m === null) return null; for (const [k, x] of m) addSec(out, k, x); }
        return out;
      }
      case 'quantifier': {
        const m = exprSecondBy(e.body);
        if (m === null || e.kind === '?') return m;
        const bf = exprFirst(e.body);
        const out: SecBy = new Map();
        for (const [k, x] of m) addSec(out, k, extend(x, bf, true));
        return out;
      }
      case 'group': return exprSecondBy(e.body);
      case 'sep': {
        const m = exprSecondBy(e.element);
        if (m === null) return null;
        const out: SecBy = new Map();
        for (const [k, x] of m) addSec(out, k, extend(x, new Set([e.delimiter]), true));
        return out;
      }
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore': case 'notLeftLeaf': return new Map();
      default: return null;
    }
  }
  const sameSecBy = (x: SecBy | null, y: SecBy | null | undefined): boolean => {
    if (x === null || y === null || y === undefined) return x === y;
    if (x.size !== y.size) return false;
    for (const [k, a] of x) {
      const b = y.get(k);
      if (b === undefined || a.len1 !== b.len1 || (a.s === null) !== (b.s === null) || (a.s !== null && a.s.size !== b.s!.size)) return false;
    }
    return true;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      const prev = ruleSecondBy.get(rule.name);
      if (prev === null) continue;                               // null is terminal
      const next = exprSecondBy(rule.body);
      let nv: SecBy | null = next;
      if (next !== null && prev !== undefined) { nv = new Map(prev); for (const [k, x] of next) addSec(nv, k, x); }
      if (!sameSecBy(nv, prev)) { ruleSecondBy.set(rule.name, nv); changed = true; }
    }
  }

  // ── Suppress sets ──
  // The LED connectors a `suppress` group disables (`exclude('in', Expr)`: no `in` in a for-head)
  // are a constant of the grammar at each site, so a compiled parser never builds one at run time:
  // each distinct set is kept once here, sorted, in first-occurrence order over the rules; set 0 is
  // the empty set, the state outside every suppress group. A compiled parser holds the index of the
  // set in force, and which sets disable a led is decided here too (suppressedIn), so it tests an
  // index, never a set.
  const suppressSets: string[][] = [[]];
  const suppressSetIds = new Map<string, number>([['[]', 0]]);
  const suppressKey = (connectors: readonly string[]) => JSON.stringify([...new Set(connectors)].sort());
  const collectSuppress = (e: RuleExpr): void => {
    if (e.type === 'group' && e.suppress && e.suppress.length) {
      const key = suppressKey(e.suppress);
      if (!suppressSetIds.has(key)) { suppressSetIds.set(key, suppressSets.length); suppressSets.push(JSON.parse(key)); }
    }
    if (e.type === 'seq' || e.type === 'alt') e.items.forEach(collectSuppress);
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') collectSuppress(e.body);
    else if (e.type === 'sep') collectSuppress(e.element);
  };
  for (const rule of grammar.rules) collectSuppress(rule.body);
  // The index of a suppress group's connector set.
  const suppressSetOf = (connectors: readonly string[]): number => {
    const id = suppressSetIds.get(suppressKey(connectors));
    if (id === undefined) throw new Error(`suppress set ${suppressKey(connectors)} is not a group of this grammar`);
    return id;
  };
  // The sets that disable a led whose first literal is `connector` (none for a led without one):
  // the led is tried only while the set in force is none of them.
  const suppressedIn = (connector: string | null): number[] =>
    connector === null ? [] : suppressSets.flatMap((set, i) => (set.includes(connector) ? [i] : []));

  return {
    tokenNames,
    opTable, prefixOps, noUnaryLhsOps, postfixOpValues, requireTargetOps,
    ledPrecByConnector, binaryConnectors, connectorLbp, nudCapOf, atLevelBp,
    prattRules, classifyAlts, classifyLeftRec,
    nullableRules, exprNullable, leftRuleRefs, altsOf, itemsOf,
    isLeftRecursive, leftCorner, residualCorner, cornerCycle,
    maxBp, ruleByName, leftRecSet, prattClassified, leftRecClassified,
    templateTokenName, templateTokenNames,
    firstSets, exprFirst, ruleSecond, exprSecond, exprSecondBy,
    suppressSets, suppressSetOf, suppressedIn,
  };
}

// ── FIRST over concrete symbols (the guards of the compiled parsers) ──
// The plain FIRST above names a token kind or a literal text, and gives up where a Pratt rule's
// prefix operator leads. A compiled parser tests a token against a set in which a token is ONE
// symbol: its literal when its text is one of the grammar's literals, else its kind. A set over
// those symbols can say what a key set cannot — an identifier that is no reserved word — so the
// zero-width tests in front of a candidate fold into it. `first1(e)` is the set of symbols a
// NON-EMPTY match of `e` can begin with (a superset):
//   - a literal is its own symbol (a composed `>` operator begins at the `>` token); a token kind is
//     its kind's symbol plus every literal the lexer gives that kind (an interpolated template
//     kind also begins with its head);
//   - a prefix-operator item (`prefix $`) is each prefix operator of the precedence table;
//   - a `not` over a body that reads exactly one token removes that body's symbols from what the
//     items after it begin with; a reserved-word guard removes them except the context's words
//     (`maybeWords`: whether those are reserved is the context's, known only at run time);
//     `not(not(X))` keeps only X's FIRST; every other zero-width test keeps everything.
// Which kinds may carry a literal is the lexer plan's (`kindsOf`, a superset; none: no token does),
// handed in as data: this analysis knows the grammar, not the lexer. A symbol is a literal's text,
// or KIND + a token kind's name.
export const KIND = '\u0000';
export type ConcreteLex = { kindsOf: (lit: string) => readonly string[]; gtComps: readonly string[]; maybeWords: readonly string[] };
export function concreteFirst(grammar: CstGrammar, a: ReturnType<typeof analyzeGrammar>, lex: ConcreteLex) {
  const literals = new Set<string>();
  const collect = (e: RuleExpr): void => {
    if (e.type === 'literal') literals.add(e.value);
    else if (e.type === 'sep') { literals.add(e.delimiter); collect(e.element); }
    else if (e.type === 'seq' || e.type === 'alt') e.items.forEach(collect);
    else if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') collect(e.body);
  };
  grammar.rules.forEach((r) => collect(r.body));
  for (const lv of grammar.precs) for (const o of lv.operators) literals.add(o.value);
  const litSym = (v: string): string => (lex.gtComps.includes(v) ? '>' : v);
  const ofKind = new Map<string, string[]>();
  for (const l of literals) for (const k of lex.kindsOf(l)) (ofKind.get(k) ?? ofKind.set(k, []).get(k)!).push(l);
  const kindSyms = (k: string): string[] => [KIND + k, ...(ofKind.get(k) ?? []), ...(a.templateTokenNames.has(k) ? [KIND + '$templateHead'] : [])];
  // The one token a `not` body tests, as symbols (null: the body reads more, or not exactly one).
  const oneToken = (e: RuleExpr): string[] | null => {
    switch (e.type) {
      case 'literal': return lex.gtComps.includes(e.value) ? null : [e.value];
      case 'ref': return a.tokenNames.has(e.name) ? kindSyms(e.name) : null;
      case 'group': return e.suppress || e.ctxMode ? null : oneToken(e.body);
      case 'seq': return e.items.length === 1 ? oneToken(e.items[0]!) : null;
      case 'alt': { const out: string[] = []; for (const it of e.items) { const m = oneToken(it); if (m === null) return null; out.push(...m); } return out; }
      default: return null;
    }
  };
  type F = { syms: Set<string>; empty: boolean };
  const ruleF = new Map<string, F>(grammar.rules.map((r) => [r.name, { syms: new Set(), empty: false }]));
  // What a zero-width test before an item lets the item's first token be (null: anything).
  type Keep = (sym: string) => boolean;
  const keepOf = (e: RuleExpr): Keep | null => {
    if (e.type !== 'not') return null;
    if (e.body.type === 'not') { const f = first(e.body.body); return f.empty ? null : (s) => f.syms.has(s); }
    const m = oneToken(e.body);
    if (m === null) return null;
    const out = new Set(m);
    return e.reservable ? (s) => !out.has(s) || lex.maybeWords.includes(s) : (s) => !out.has(s);
  };
  const ZERO = new Set<RuleExpr['type']>(['not', 'sameLine', 'noCommentBefore', 'noMultilineFlowBefore', 'notLeftLeaf', 'op', 'postfix']);
  function seqF(items: readonly RuleExpr[]): F {
    const syms = new Set<string>();
    const keeps: Keep[] = [];
    for (const it of items) {
      if (ZERO.has(it.type)) { const k = keepOf(it); if (k) keeps.push(k); continue; }
      const f = first(it);
      for (const s of f.syms) if (keeps.every((k) => k(s))) syms.add(s);
      if (!f.empty) return { syms, empty: false };
    }
    return { syms, empty: true };
  }
  function first(e: RuleExpr): F {
    switch (e.type) {
      case 'literal': return { syms: new Set([litSym(e.value)]), empty: false };
      case 'ref': return a.tokenNames.has(e.name) ? { syms: new Set(kindSyms(e.name)), empty: false } : ruleF.get(e.name)!;
      case 'seq': return seqF(e.items);
      case 'alt': { const fs = e.items.map(first); return { syms: new Set(fs.flatMap((f) => [...f.syms])), empty: fs.some((f) => f.empty) }; }
      case 'quantifier': { const f = first(e.body); return { syms: f.syms, empty: e.kind === '+' ? f.empty : true }; }
      case 'group': return first(e.body);
      case 'sep': return { syms: first(e.element).syms, empty: true };
      case 'prefix': return { syms: new Set([...a.prefixOps.keys()].map(litSym)), empty: false };
      default: return seqF([e]);   // a zero-width test alone
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const r of grammar.rules) {
      const f = first(r.body), old = ruleF.get(r.name)!;
      const syms = new Set([...old.syms, ...f.syms]);
      if (syms.size !== old.syms.size || f.empty !== old.empty) { ruleF.set(r.name, { syms, empty: old.empty || f.empty }); changed = true; }
    }
  }
  return {
    /** The symbols a non-empty match of `e` can begin with. */
    first1: (e: RuleExpr): Set<string> => first(e).syms,
    /** The symbols a set of keys (each a literal text or a token kind, as exprFirst gives them) admits. */
    keySyms: (keys: Iterable<string>): Set<string> => new Set([...keys].flatMap((k) => (a.tokenNames.has(k) ? kindSyms(k) : [litSym(k)]))),
    /** The grammar's literal texts (rules and operators). */
    literals: [...literals],
    /** The grammar's literal texts a token of `kind` may be. */
    literalsOf: (kind: string): readonly string[] => ofKind.get(kind) ?? [],
  };
}

/**
 * Whether a grammar uses its element region's `tagOpen` ONLY to open tags (docs/REGIONS.md,
 * "Entry from code"). Then a `tagOpen` in code can only begin an element, and the lexer enters
 * the region at every code position; otherwise (JS / TS: `<` is a comparison and opens type
 * arguments) only where an operand may start. True when all of these hold:
 *   - every occurrence of the `tagOpen` literal in a rule is the FIRST item of a sequence that
 *     also references the region's `closeTag` or `selfClose` token (an element arm);
 *   - no operator table lists it, and no `sep` uses it as its delimiter;
 *   - no other literal, operator or scanned token can begin with it (`<=`, `<<`, a token whose
 *     pattern starts with `<`): the entry test runs before the ordinary scan, so such a token
 *     could never be lexed at a code position. The region's own tokens are not scanned in code.
 * A pure function of the grammar; the lexer reads it once (lexSpecOf).
 */
export function tagOpenOnlyOpensTags(grammar: CstGrammar, region: ElementRegion): boolean {
  const lit = region.tagOpen;
  if (grammar.precs.some((l) => l.operators.some((o) => o.value.startsWith(lit)))) return false;
  const closers = new Set([region.closeTag, region.selfClose]);
  const refsCloser = (e: RuleExpr): boolean => {
    switch (e.type) {
      case 'ref': return closers.has(e.name);
      case 'seq': case 'alt': return e.items.some(refsCloser);
      case 'quantifier': case 'group': return refsCloser(e.body);
      case 'sep': return refsCloser(e.element);
      default: return false;
    }
  };
  let ok = true;
  const walk = (e: RuleExpr, elementHead: boolean): void => {
    switch (e.type) {
      case 'literal': if (e.value.startsWith(lit) && !(elementHead && e.value === lit)) ok = false; return;
      case 'seq': { const arm = refsCloser(e); e.items.forEach((it, i) => walk(it, i === 0 && arm)); return; }
      case 'alt': for (const it of e.items) walk(it, false); return;
      case 'quantifier': case 'group': case 'not': walk(e.body, false); return;
      case 'sep': if (e.delimiter.startsWith(lit)) ok = false; walk(e.element, false); return;
      default: return;
    }
  };
  for (const r of grammar.rules) walk(r.body, false);
  if (!ok) return false;
  const own = new Set([region.text, region.closeTag, region.selfClose, ...region.tagTokens ?? [], ...(region.rawText ?? []).map((r) => r.token)]);
  const cc = lit.charCodeAt(0);
  for (const t of grammar.tokens) {
    if (own.has(t.name)) continue;
    const f = tokenPatternFirstCharSet(t);
    if (f === null || (cc < 128 ? f.ascii.has(cc) : f.nonAscii)) return false;
  }
  return true;
}

/** One derived directive literal and the literal sequences that must follow it (docs/REGIONS.md,
 *  "Directives"): each sequence ends with the head's `(` or the body's `hole.open`. */
export type DirectiveEntry = { lit: string; nexts: string[][] };
export type Directives = {
  openers: DirectiveEntry[];        // begin a children item: `@if` + `(`
  continuations: DirectiveEntry[];  // follow a directive body: `@else` + `{` / `if (`
  blocks: string[];                 // a children item `lit … hole.close` whose lit ends with hole.open: a code hole
  refused: { arm: string; reason: string }[];  // arms the lexer cannot find in text, with why
};

/**
 * The directives of a text-children element region, DERIVED from the grammar (docs/REGIONS.md,
 * "Directives"). The children items are the items repeated between an element arm's `tagClose`
 * and its `closeTag`, and the items of every directive body. An OPENER is a literal that begins a
 * children item, other than `tagOpen` and `hole.open`, with the literal sequences that must follow
 * it up to its head's `(` or its body's `hole.open`; the head is that parenthesised group, and the
 * BODY (a rule whose arms are `hole.open … hole.close`) must follow it. A CONTINUATION is a
 * literal that begins the item right after a body, with its own sequences. An arm the lexer could
 * not delimit (an expression or a token before the body, a body that does not follow the head)
 * is REFUSED by name, with the reason. Null for a region without `text` (code children lex a
 * directive as code).
 */
export function directivesOf(grammar: CstGrammar, region: ElementRegion): Directives | null {
  if (region.text === undefined) return null;
  const rules = new Map(grammar.rules.map((r) => [r.name, r]));
  const out: Directives = { openers: [], continuations: [], blocks: [], refused: [] };
  const show = (e: RuleExpr): string => {
    switch (e.type) {
      case 'literal': return JSON.stringify(e.value);
      case 'ref': return e.name;
      case 'seq': return e.items.map(show).join(' ');
      case 'alt': return `(${e.items.map(show).join(' | ')})`;
      case 'quantifier': return `${show(e.body)}${e.kind}`;
      case 'group': return show(e.body);
      default: return e.type;
    }
  };
  const seqOf = (e: RuleExpr): RuleExpr[] => (e.type === 'seq' ? e.items : e.type === 'group' ? seqOf(e.body) : [e]);
  const altsOf = (e: RuleExpr): RuleExpr[][] => (e.type === 'alt' ? e.items.flatMap(altsOf) : e.type === 'group' ? altsOf(e.body) : [seqOf(e)]);
  const isLit = (e: RuleExpr | undefined, v: string) => e?.type === 'literal' && e.value === v;
  // a body: a rule whose every arm is `hole.open … hole.close`
  const isBody = (e: RuleExpr | undefined): boolean => {
    if (e?.type !== 'ref') return false;
    const r = rules.get(e.name);
    return !!r && altsOf(r.body).every((a) => isLit(a[0], region.hole.open) && isLit(a[a.length - 1], region.hole.close));
  };
  class Refuse extends Error {}
  type Lead = { lits: string[]; items: RuleExpr[]; at: number };
  // the literal sequences from items[i] up to a `(` or a body, each with the items it ended in
  const leads = (items: RuleExpr[], i: number, seen: Set<string>): Lead[] => {
    const it = items[i];
    if (it === undefined) throw new Refuse('nothing follows it: no head and no body');
    const rest = items.slice(i + 1);
    switch (it.type) {
      case 'literal':
        if (it.value === '(' || it.value === region.hole.open) return [{ lits: [it.value], items, at: i }];
        return leads(items, i + 1, seen).map((l) => ({ ...l, lits: [it.value, ...l.lits] }));
      case 'ref': {
        if (isBody(it)) return [{ lits: [region.hole.open], items, at: i }];
        const r = rules.get(it.name);
        if (!r || seen.has(it.name)) throw new Refuse(`\`${it.name}\` stands between it and its body: the body's \`${region.hole.open}\` cannot be told from one inside it`);
        const s = new Set(seen).add(it.name);
        return altsOf(r.body).flatMap((a) => leads([...a, ...rest], 0, s));
      }
      case 'quantifier':
        if (it.kind !== '?') throw new Refuse(`\`${show(it)}\` stands between it and its body`);
        return [...leads([...seqOf(it.body), ...rest], 0, seen), ...leads(items, i + 1, seen)];
      case 'alt': return it.items.flatMap((a) => leads([...seqOf(a), ...rest], 0, seen));
      case 'group': return leads([...seqOf(it.body), ...rest], 0, seen);
      default: throw new Refuse(`\`${show(it)}\` stands between it and its body`);
    }
  };
  // the arms an item list can begin with, rule references and groups at its head expanded
  const arms = (items: RuleExpr[], seen: Set<string> = new Set()): RuleExpr[][] => {
    const [head, ...rest] = items;
    if (head === undefined) return [];
    if (head.type === 'ref') {
      const r = rules.get(head.name);
      if (!r || seen.has(head.name)) return r ? [] : [items];
      const s = new Set(seen).add(head.name);
      return altsOf(r.body).flatMap((a) => arms([...a, ...rest], s));
    }
    if (head.type === 'quantifier') return [...arms([...seqOf(head.body), ...rest], seen), ...(head.kind === '+' ? [] : arms(rest, seen))];
    if (head.type === 'alt' || head.type === 'group') return altsOf(head).flatMap((a) => arms([...a, ...rest], seen));
    return [items];
  };
  const done = new Set<string>();
  const bodies = new Set<string>();
  // a directive arm: items[0] is its literal; derive its sequences, check its head and body, and
  // take the arms of the item right after the body as continuations
  const directive = (items: RuleExpr[], name: string, into: DirectiveEntry[]): void => {
    const lit = (items[0] as { value: string }).value;
    const key = `${into === out.openers ? 'o' : 'c'} ${show({ type: 'seq', items })}`;
    if (done.has(key)) return;
    done.add(key);
    let ls: Lead[];
    const after: RuleExpr[][] = [];
    try {
      ls = leads(items, 1, new Set());
      for (const l of ls) {
        let body = l.at;
        if (l.lits[l.lits.length - 1] === '(') {
          let depth = 0, j = l.at;
          for (; j < l.items.length; j++) {
            if (isLit(l.items[j], '(')) depth++;
            else if (isLit(l.items[j], ')') && --depth === 0) break;
          }
          if (j >= l.items.length || !isBody(l.items[j + 1])) throw new Refuse('its head `( … )` is not followed by a body');
          body = j + 1;
        } else if (!isBody(l.items[body])) throw new Refuse(`its \`${region.hole.open}\` opens no body (a rule whose arms are \`${region.hole.open} … ${region.hole.close}\`)`);
        bodies.add((l.items[body] as { name: string }).name);
        after.push(...arms(l.items.slice(body + 1)));
      }
    } catch (e) {
      if (!(e instanceof Refuse)) throw e;
      out.refused.push({ arm: `${name}: ${show({ type: 'seq', items })}`, reason: e.message });
      return;
    }
    let ent = into.find((d) => d.lit === lit);
    if (!ent) into.push(ent = { lit, nexts: [] });
    for (const l of ls) if (!ent.nexts.some((x) => x.join(' ') === l.lits.join(' '))) ent.nexts.push(l.lits);
    for (const a of after) if (a[0]?.type === 'literal') directive(a, name, out.continuations);
  };
  const item = (e: RuleExpr, name: string) => {
    for (const a of arms([e])) {
      const h = a[0];
      if (h?.type !== 'literal' || h.value === region.tagOpen || h.value === region.hole.open) continue;
      if (h.value.endsWith(region.hole.open)) {
        if (!isLit(a[a.length - 1], region.hole.close)) out.refused.push({ arm: `${name}: ${show({ type: 'seq', items: a })}`, reason: `its literal ends with \`${region.hole.open}\` but the item does not end with \`${region.hole.close}\`` });
        else if (!out.blocks.includes(h.value)) out.blocks.push(h.value);
        continue;
      }
      directive(a, name, out.openers);
    }
  };
  // the children items: repeated between an element arm's tagClose and its closeTag
  const walk = (e: RuleExpr, name: string): void => {
    if (e.type === 'seq') {
      const k = e.items.findIndex((x) => x.type === 'ref' && x.name === region.closeTag);
      for (let i = 0; i < k; i++) if (isLit(e.items[i], region.tagClose)) for (let j = i + 1; j < k; j++) { const q = e.items[j]; if (q.type === 'quantifier') item(q.body, name); }
    }
    if (e.type === 'seq' || e.type === 'alt') e.items.forEach((x) => walk(x, name));
    else if (e.type === 'quantifier' || e.type === 'group') walk(e.body, name);
  };
  for (const r of grammar.rules) walk(r.body, r.name);
  // ... and the items of every directive body
  for (let seen = 0; seen < bodies.size;) {
    const name = [...bodies][seen++];
    for (const a of altsOf(rules.get(name)!.body)) for (const q of a) if (q.type === 'quantifier') item(q.body, name);
  }
  return out;
}
