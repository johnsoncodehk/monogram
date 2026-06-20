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
import type { CstGrammar, RuleExpr, RuleDecl } from './types.ts';

export interface OpInfo {
  lbp: number;
  rbp: number;
  assoc: 'left' | 'right' | 'none';
  position: 'infix' | 'prefix' | 'postfix';
  requireTarget?: boolean;
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

/** The entry rule is the last declared rule. */
export function findEntryRule(grammar: CstGrammar): string {
  return grammar.rules[grammar.rules.length - 1].name;
}

/**
 * Derive the full STRUCTURAL analysis, returned as plain data + live closures. Both engines
 * call this once and destructure; their downstream code keeps its own local names.
 */
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
        prefixOps.set(op.value, { lbp: 0, rbp: level.assoc === 'right' ? bp - 1 : bp, assoc: level.assoc, position: 'prefix', requireTarget: op.requireTarget });
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

  // Binary / relational / conditional connectors (the MIDDLE child of a `$ op $` LED) — a node
  // with one at child[1] is not a LeftHandSideExpression, so not an assignment target
  // (`a + b = c`, `a in b = c`). Ladder INFIX ops + alternative-form binary LEDs.
  const binaryConnectors = new Set<string>();
  for (const [v, info] of opTable) if (info.position === 'infix') binaryConnectors.add(v);
  for (const k of ledPrecByConnector.keys()) binaryConnectors.add(k);

  // A `cap`-group NUD (an ArrowFunction — the lowest-precedence AssignmentExpression) parses
  // only when minBp is LOOSER than the named connector's binding power; the value resolves
  // from the ladder or the ledPrec table.
  const connectorLbp = (connector: string): number => {
    const op = opTable.get(connector);
    if (op) return op.lbp;
    const lp = ledPrecByConnector.get(connector);
    if (lp) return lp.lbp;
    throw new Error(`capExpr: connector ${JSON.stringify(connector)} is not a ladder operator or ledPrec connector`);
  };
  const nudCapOf = (nud: RuleExpr): number | null =>
    nud.type === 'group' && nud.capBelow !== undefined ? connectorLbp(nud.capBelow) : null;

  // ── Pratt vs ordinary rules ──
  const prattRules = new Set<string>();
  for (const rule of grammar.rules) if (hasMarker(rule.body)) prattRules.add(rule.name);

  // For Pratt rules, split alternatives into NUD (atoms/prefix) and LED (left-recursive).
  function classifyAlts(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const nuds: RuleExpr[] = [];
    const leds: { expr: RuleExpr; items: RuleExpr[]; notLeftLeaf?: string[] }[] = [];
    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      // A LED arm may carry a leading `notLeftLeaf(...)` head-leaf guard before the self `$`
      // (`[notLeftLeaf('void',…), $, '.', Ident]`). Strip it into LED metadata; the self-ref is
      // the next item and `led.items` is everything after it — identical to a plain LED.
      const guard = items[0]?.type === 'notLeftLeaf' ? items[0].words : undefined;
      const head = guard ? 1 : 0;
      if (items[head]?.type === 'ref' && (items[head] as { name: string }).name === rule.name) {
        leds.push({ expr: alt, items: items.slice(head + 1), notLeftLeaf: guard });
      } else nuds.push(alt);
    }
    return { nuds, leds };
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

  return {
    tokenNames,
    opTable, prefixOps, noUnaryLhsOps, postfixOpValues, requireTargetOps,
    ledPrecByConnector, binaryConnectors, connectorLbp, nudCapOf,
    prattRules, classifyAlts, classifyLeftRec,
    nullableRules, exprNullable, leftRuleRefs, altsOf, itemsOf,
    isLeftRecursive, leftCorner, residualCorner, cornerCycle,
    maxBp, ruleByName, leftRecSet, prattClassified, leftRecClassified,
    templateTokenName, templateTokenNames,
    firstSets, exprFirst, ruleSecond, exprSecond,
  };
}
