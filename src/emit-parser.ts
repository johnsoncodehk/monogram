// ── emit-parser ──
//
// An EMITTER (vs the createParser RUNTIME INTERPRETER in gen-parser.ts). It takes
// the same CstGrammar, re-derives the SAME static analysis createParser does
// (precedence/binding-power tables, Pratt NUD/LED classification, FIRST sets,
// nullability, mixfix/access-tail detection), and emits SELF-CONTAINED JavaScript
// for a parser that bakes those tables in as constants and emits the PER-RULE +
// PER-ARM matching as SPECIALIZED straight-line code — replacing the interpreter's
// matchExpr/matchSeq/matchQuantifier/matchSep tree-walk dispatch.
//
// The algorithmic CONTROL cores (the Pratt precedence loop, the left-recursion
// loop, the longest-match non-recursive loop, the mixfix operand re-bind, the
// packrat memo, save/restore backtracking) stay as a generic runtime that the
// emitted code CALLS — copied VERBATIM from gen-parser.ts so their longest-match /
// tail-closing / suppress / mixfix semantics are byte-identical to the oracle.
// What those loops used to dispatch per arm (matchExpr(alt) / matchSeq(items)) is
// now a GENERATED specialized matcher per NUD/LED/alt arm, so the interpretive
// dispatch — the ~third of parse time the CPU profile attributes to matchExpr +
// per-arm re-classification — is removed.
//
// The LEXER is identical in both worlds and is OUTSIDE this optimization, so the
// emitted code imports the fixed createLexer RUNTIME and feeds it the grammar's
// baked token+config DATA (a "grammar-lite"); it never imports the grammar
// DEFINITION object. createParser is the correctness oracle — the emitted parser
// must reproduce its CST byte-for-byte.

import type { CstGrammar, RuleExpr, RuleDecl, PrecLevel } from './types.ts';
import { isKeywordLiteral, collectLiterals } from './grammar-utils.ts';
import { emitLexer } from './emit-lexer.ts';

// ── Static analysis (re-derived; mirrors gen-parser.ts exactly) ──

interface OpInfo {
  lbp: number;
  rbp: number;
  assoc: 'left' | 'right' | 'none';
  position: 'infix' | 'prefix' | 'postfix';
}

type FirstTok = { lit: string } | { tok: string } | null;
type MixfixInfo = { openLit: string; sepLit: string };

function hasMarker(expr: RuleExpr): boolean {
  if (expr.type === 'op' || expr.type === 'prefix' || expr.type === 'postfix') return true;
  if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(hasMarker);
  if (expr.type === 'quantifier' || expr.type === 'group') return hasMarker(expr.body);
  if (expr.type === 'sep') return hasMarker(expr.element);
  return false;
}

function findEntryRule(grammar: CstGrammar): string {
  return grammar.rules[grammar.rules.length - 1].name;
}

/** Build the full static analysis createParser performs, returned as plain data. */
function analyze(grammar: CstGrammar) {
  const tokenNames = new Set(grammar.tokens.map(t => t.name));

  // Precedence table — identical to gen-parser.ts.
  const opTable = new Map<string, OpInfo>();
  const prefixOps = new Map<string, OpInfo>();
  const noUnaryLhsOps = new Set<string>();
  const postfixOpValues = new Set<string>();
  for (let i = 0; i < grammar.precs.length; i++) {
    const level = grammar.precs[i];
    const bp = (i + 1) * 2;
    for (const op of level.operators) {
      if (op.position === 'prefix') {
        prefixOps.set(op.value, { lbp: 0, rbp: level.assoc === 'right' ? bp - 1 : bp, assoc: level.assoc, position: 'prefix' });
      } else if (op.position === 'postfix') {
        postfixOpValues.add(op.value);
        opTable.set(op.value, { lbp: bp, rbp: 0, assoc: level.assoc, position: 'postfix' });
      } else {
        const lbp = bp;
        const rbp = level.assoc === 'right' ? bp - 1 : bp;
        opTable.set(op.value, { lbp, rbp, assoc: level.assoc, position: 'infix' });
        if (op.noUnaryLhs) noUnaryLhsOps.add(op.value);
      }
    }
  }

  // Alternative-form LED binding powers (mirrors gen-parser.ts — the two engines must
  // resolve IDENTICAL lbp numbers or their CSTs diverge).
  const ledPrecByConnector = new Map<string, { lbp: number; rhsBp: number | null }>();
  for (const lp of grammar.ledPrecs ?? []) {
    const anchorOp = lp.sameAs ?? lp.below;
    if (!anchorOp) throw new Error(`ledPrec ${lp.connector}: needs sameAs or below`);
    const op = opTable.get(anchorOp);
    if (!op) throw new Error(`ledPrec ${lp.connector}: anchor ${JSON.stringify(anchorOp)} is not a ladder operator`);
    const lbp = lp.sameAs !== undefined ? op.lbp : op.lbp - 1;
    ledPrecByConnector.set(lp.connector, { lbp, rhsBp: lp.chainRhs ? lbp : null });
  }

  // Pratt rules.
  const prattRules = new Set<string>();
  for (const rule of grammar.rules) if (hasMarker(rule.body)) prattRules.add(rule.name);

  function classifyAlts(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const nuds: RuleExpr[] = [];
    const leds: { expr: RuleExpr; items: RuleExpr[] }[] = [];
    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      if (items[0]?.type === 'ref' && items[0].name === rule.name) leds.push({ expr: alt, items: items.slice(1) });
      else nuds.push(alt);
    }
    return { nuds, leds };
  }
  function classifyLeftRec(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const atoms: RuleExpr[] = [];
    const continuations: RuleExpr[][] = [];
    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      if (items[0]?.type === 'ref' && items[0].name === rule.name) continuations.push(items.slice(1));
      else atoms.push(alt);
    }
    return { atoms, continuations };
  }
  function isLeftRecursive(rule: RuleDecl): boolean {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    return alts.some(alt => {
      const items = alt.type === 'seq' ? alt.items : [alt];
      return items[0]?.type === 'ref' && items[0].name === rule.name;
    });
  }

  const maxBp = (grammar.precs.length + 1) * 2;
  const ruleByName = new Map<string, RuleDecl>(grammar.rules.map(r => [r.name, r]));
  const leftRecSet = new Set<string>(grammar.rules.filter(isLeftRecursive).map(r => r.name));
  const prattClassified = new Map<string, ReturnType<typeof classifyAlts>>();
  const leftRecClassified = new Map<string, ReturnType<typeof classifyLeftRec>>();
  for (const rule of grammar.rules) {
    if (prattRules.has(rule.name)) prattClassified.set(rule.name, classifyAlts(rule));
    else if (leftRecSet.has(rule.name)) leftRecClassified.set(rule.name, classifyLeftRec(rule));
  }

  const templateTokenName = grammar.tokens.find(t => t.template)?.name;
  const templateTokenNames = new Set<string>(grammar.tokens.filter(t => t.template).map(t => t.name));

  // First-token dispatch.
  function firstTokenOf(alt: RuleExpr): FirstTok {
    const items = alt.type === 'seq' ? alt.items : [alt];
    const first = items[0];
    if (!first) return null;
    if (first.type === 'literal') return { lit: first.value };
    if (first.type === 'ref' && tokenNames.has(first.name)) return { tok: first.name };
    return null;
  }

  // Mixfix operand re-bind shape: `<lit L1> $self <lit L2> …`.
  function selfRefName(e: RuleExpr | undefined, ruleName: string): boolean {
    return !!e && e.type === 'ref' && e.name === ruleName;
  }
  function mixfixOf(items: RuleExpr[], ruleName: string): MixfixInfo | null {
    if (items.length >= 4 && items[0]?.type === 'literal' && selfRefName(items[1], ruleName) && items[2]?.type === 'literal') {
      return { openLit: items[0].value, sepLit: items[2].value };
    }
    return null;
  }

  // Access-tail + tail-closing LED classification (Pratt).
  // Returns, per Pratt rule, parallel arrays of flags aligned to the leds array.
  const ledMeta = new Map<string, { accessTail: boolean[]; tailClosing: boolean[]; mixfix: (MixfixInfo | null)[]; first: FirstTok[]; prec: ({ lbp: number; rhsBp: number | null } | null)[] }>();
  for (const [ruleName, { leds }] of prattClassified.entries()) {
    const accessTail: boolean[] = [];
    const tailClosing: boolean[] = [];
    const mixfix: (MixfixInfo | null)[] = [];
    const first: FirstTok[] = [];
    const prec: ({ lbp: number; rhsBp: number | null } | null)[] = [];
    for (const led of leds) {
      const it = led.items;
      let isAccessTail = false, isTailClosing = false;
      if (it.length > 0 && it[0].type !== 'op' && it[0].type !== 'postfix') {
        const last = it[it.length - 1];
        const lastIsOperand = selfRefName(last, ruleName);
        const wordConnector = it[0].type === 'literal' && /^[A-Za-z]/.test(it[0].value);
        if (!lastIsOperand && !wordConnector) isAccessTail = true;
        if (last.type === 'not') isTailClosing = true;
      }
      accessTail.push(isAccessTail);
      tailClosing.push(isTailClosing);
      mixfix.push(mixfixOf(led.items, ruleName));
      first.push(firstTokenOf({ type: 'seq', items: led.items } as RuleExpr));
      const firstItem = led.items[0];
      const lp = firstItem?.type === 'literal' ? ledPrecByConnector.get(firstItem.value) ?? null : null;
      if (lp !== null && lp.rhsBp !== null) {
        const last = led.items[led.items.length - 1];
        if (!(last?.type === 'ref' && last.name === ruleName)) {
          throw new Error(`ledPrec ${firstItem.type === 'literal' ? firstItem.value : '?'}: chainRhs requires a trailing self-operand`);
        }
      }
      prec.push(lp);
    }
    ledMeta.set(ruleName, { accessTail, tailClosing, mixfix, first, prec });
  }

  // Left-rec continuation mixfix.
  const contMeta = new Map<string, (MixfixInfo | null)[]>();
  for (const [ruleName, { continuations }] of leftRecClassified.entries()) {
    contMeta.set(ruleName, continuations.map(c => mixfixOf(c, ruleName)));
  }

  // Nullability.
  const nullableRules = new Set<string>();
  function exprNullable(e: RuleExpr): boolean {
    switch (e.type) {
      case 'literal': return false;
      case 'ref': return tokenNames.has(e.name) ? false : nullableRules.has(e.name);
      case 'seq': return e.items.every(exprNullable);
      case 'alt': return e.items.some(exprNullable);
      case 'quantifier': return e.kind === '+' ? exprNullable(e.body) : true;
      case 'group': return exprNullable(e.body);
      case 'not': return true;
      case 'sep': return true;
      default: return true;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      if (!nullableRules.has(rule.name) && exprNullable(rule.body)) { nullableRules.add(rule.name); changed = true; }
    }
  }

  // FIRST sets.
  //
  // Reserved-aware keys: a `not(alt('if', 'var', …))` guard immediately before the
  // first consuming element proves those keyword texts can never be this position's
  // token. A token-name key gathered under such a guard becomes a QUALIFIED key
  // ('\0Q:'-prefixed, registered in qualKeys) and is emitted as TM[0] plus every
  // non-excluded keyword t-bit instead of the blanket k-bit — so a reserved-keyword
  // lookahead no longer admits identifier-led alternatives it provably cannot start
  // (the dominant longest-match waste: expr-stmt/labeled-stmt arms on 'var'/'if'/…).
  // Sound: every pruned (alt, token) pair fails its not-guard before consuming.
  const qualKeys = new Map<string, { tok: string; except: Set<string> }>();
  function qualKey(tok: string, except: Set<string>): string {
    const sorted = [...except].sort();
    const key = '\u0000Q:' + tok + ':' + sorted.join(',');
    if (!qualKeys.has(key)) qualKeys.set(key, { tok, except: new Set(sorted) });
    return key;
  }
  // null = the key is guarded out entirely (a keyword literal inside its own not-class).
  function excludeKey(k: string, pending: Set<string>): string | null {
    const q = qualKeys.get(k);
    if (q) return qualKey(q.tok, new Set([...q.except, ...pending]));
    if (tokenNames.has(k)) return qualKey(k, pending);
    if (pending.has(k)) return null;
    return k;
  }
  // A not() whose body is purely keyword literals (the reserved-word guard shape).
  function notKeywordClass(body: RuleExpr): Set<string> | null {
    const items = body.type === 'alt' ? body.items : [body];
    const out = new Set<string>();
    for (const it of items) {
      if (it.type !== 'literal' || !isKeywordLiteral(it.value)) return null;
      out.add(it.value);
    }
    return out.size > 0 ? out : null;
  }
  const firstSets = new Map<string, Set<string> | null>();
  function exprFirst(e: RuleExpr): Set<string> | null {
    switch (e.type) {
      case 'literal': return new Set([e.value]);
      case 'ref': {
        if (tokenNames.has(e.name)) return new Set([e.name]);
        return firstSets.has(e.name) ? firstSets.get(e.name)! : new Set();
      }
      case 'seq': {
        const acc = new Set<string>();
        let pending: Set<string> | null = null;
        for (const item of e.items) {
          if (item.type === 'prefix') {
            // A pratt prefix form ([prefix, operand]): its first token is one of the
            // prefix-operator literals — a real set, not unknown. Keeps FIRST(Expr)
            // from collapsing to null/always-admit.
            for (const op of prefixOps.keys()) {
              const ek = pending ? excludeKey(op, pending) : op;
              if (ek !== null) acc.add(ek);
            }
            return acc;
          }
          if (item.type === 'not') {
            const kws = notKeywordClass(item.body);
            if (kws) pending = pending ? new Set([...pending, ...kws]) : kws;
            continue;
          }
          if (item.type === 'op' || item.type === 'postfix' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore') continue;
          const f = exprFirst(item);
          if (f === null) return null;
          for (const k of f) {
            const ek = pending ? excludeKey(k, pending) : k;
            if (ek !== null) acc.add(ek);
          }
          if (!exprNullable(item)) return acc;
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
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore': return new Set();
      case 'sep': return exprFirst(e.element);
      default: return null;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      const prev = firstSets.get(rule.name);
      if (prev === null) continue;
      const next = exprFirst(rule.body);
      if (next === null) { firstSets.set(rule.name, null); changed = true; continue; }
      const merged = prev ? new Set(prev) : new Set<string>();
      let grew = false;
      for (const k of next) if (!merged.has(k)) { merged.add(k); grew = true; }
      if (grew || prev === undefined) { firstSets.set(rule.name, merged); changed = true; }
    }
  }

  // Deep per-alternative FIRST set + nullability for the longest-match dispatch — the
  // emitted mirror of gen-parser.ts's altMightStart. An alternative whose FIRST element
  // is a rule ref (`Decl …`, `Expr …`) is pruned when the lookahead can't begin that
  // rule (resolved through the transitive firstSets), not only when it begins with a
  // known literal/token. Sound: exprFirst over-approximates (never omits a startable
  // token) and a nullable alt is always tried (its empty match never wins longest-match).
  const altDeepFirst = new Map<RuleExpr, Set<string> | null>();
  const altNullable = new Map<RuleExpr, boolean>();
  for (const rule of grammar.rules) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    for (const alt of alts) { altDeepFirst.set(alt, exprFirst(alt)); altNullable.set(alt, exprNullable(alt)); }
  }

  // SECOND sets: the keys admissible as a match's SECOND token, plus whether a
  // one-token match exists (len1). Refines the longest-match dispatch: an admitted
  // alternative whose SECOND set excludes the actual second token — and that cannot
  // end after one token — provably fails, so its arm can be skipped. Over-approximated
  // everywhere (unknown shapes → TOP, no guard exclusions applied at depth 2), and
  // op/prefix/postfix pratt items are one-op-token consumers with known literal sets.
  type Sec = { s: Set<string> | null; len1: boolean };
  const SEC_TOP: Sec = { s: null, len1: true };
  const ruleSecond = new Map<string, Sec>();
  const opKeys = new Set<string>([...opTable.keys(), ...postfixOpValues]);
  // SECOND inputs use PLAIN FIRST semantics (no reserved-qualified keys, prefix → top),
  // an exact mirror of gen-parser's exprFirst: the interpreter computes the same SECOND
  // sets, and the prune decisions must be ENGINE-IDENTICAL — an arm skipped by only one
  // engine would consume a token in the other and skew the farthest-position error state
  // (the emit-reject-messages gate caught exactly this).
  const firstSetsPlain = new Map<string, Set<string> | null>();
  function exprFirstPlain(e: RuleExpr): Set<string> | null {
    switch (e.type) {
      case 'literal': return new Set([e.value]);
      case 'ref': {
        if (tokenNames.has(e.name)) return new Set([e.name]);
        return firstSetsPlain.has(e.name) ? firstSetsPlain.get(e.name)! : new Set();
      }
      case 'seq': {
        const acc = new Set<string>();
        for (const item of e.items) {
          if (item.type === 'prefix') return null;
          if (item.type === 'op' || item.type === 'postfix' || item.type === 'not' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore') continue;
          const f = exprFirstPlain(item);
          if (f === null) return null;
          for (const k of f) acc.add(k);
          if (!exprNullable(item)) return acc;
        }
        return acc;
      }
      case 'alt': {
        const acc = new Set<string>();
        for (const item of e.items) {
          const f = exprFirstPlain(item);
          if (f === null) return null;
          for (const k of f) acc.add(k);
        }
        return acc;
      }
      case 'quantifier': case 'group': return exprFirstPlain(e.body);
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore': return new Set();
      case 'sep': return exprFirstPlain(e.element);
      default: return null;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      const prev = firstSetsPlain.get(rule.name);
      if (prev === null) continue;
      const next = exprFirstPlain(rule.body);
      if (next === null) { firstSetsPlain.set(rule.name, null); changed = true; continue; }
      const merged = prev ? new Set(prev) : new Set<string>();
      let grew = false;
      for (const k of next) if (!merged.has(k)) { merged.add(k); grew = true; }
      if (grew || prev === undefined) { firstSetsPlain.set(rule.name, merged); changed = true; }
    }
  }
  // FIRST of a seq suffix for second-token purposes (op items consume an op literal;
  // zero-width skipped; nullable items scanned through), and its nullability.
  function suffixFirst(items: RuleExpr[], j: number): Set<string> | null {
    const acc = new Set<string>();
    for (let i = j; i < items.length; i++) {
      const item = items[i];
      if (item.type === 'not' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore') continue;
      if (item.type === 'op' || item.type === 'postfix') { for (const k of opKeys) acc.add(k); return acc; }
      if (item.type === 'prefix') { for (const k of prefixOps.keys()) acc.add(k); return acc; }
      const f = exprFirstPlain(item);
      if (f === null) return null;
      for (const k of f) acc.add(k);
      if (!exprNullable(item)) return acc;
    }
    return acc;
  }
  function suffixNullable(items: RuleExpr[], j: number): boolean {
    for (let i = j; i < items.length; i++) {
      const item = items[i];
      if (item.type === 'not' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore') continue;
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
          if (item.type === 'not' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore') continue;
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
          const bf = exprFirstPlain(e.body);
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
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore':
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
  const altSecond = new Map<RuleExpr, Sec>();
  for (const rule of grammar.rules) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    for (const alt of alts) altSecond.set(alt, exprSecond(alt));
  }

  // ── Lever 1: integer token kinds ──
  // Replace the per-call string dispatch in literal/token matching and FIRST gating
  // (matchLiteral / matchToken / the membershipFn byte tables) with integer compares.
  // Two int fields are interned onto each token at parse time (see the emitted tokenize
  // wiring):
  //   tok.k = TYPE kind   — an int for tok.type ('' punctuation → PUNCT sentinel;
  //                         each declared token name → its own int; the three
  //                         template-token-kinds $templateHead/$templateMiddle/
  //                         $templateTail get their own ints below PUNCT-named).
  //   tok.t = LITERAL kind — if tok.text is a known keyword literal (for a named,
  //                         non-'' token) OR a known punctuation literal (for a ''
  //                         token), that literal's int; else 0 (NONE). Keyword ints
  //                         and punct ints occupy DISJOINT ranges, so tok.t alone
  //                         disambiguates keyword-vs-punct.
  // A keyword token (an identifier-type token whose text is e.g. "if") therefore has
  // tok.k = <Ident kind> AND tok.t = <KW_if>, so it matches BOTH the identifier
  // token-name key and the keyword key — exactly the dual-match keyMatchesTok did.
  //
  // Kind ranges (so a single >= test answers "is a declared token name"):
  //   PUNCT = 1; $templateHead = 2, $templateMiddle = 3, $templateTail = 4;
  //   declared token names: 5, 6, … (NAMED_MIN = 5).
  const KIND_PUNCT = 1;
  const KIND_TEMPLATE_HEAD = 2;
  const KIND_TEMPLATE_MIDDLE = 3;
  const KIND_TEMPLATE_TAIL = 4;
  const KIND_NAMED_MIN = 5;
  const typeKind = new Map<string, number>();
  typeKind.set('', KIND_PUNCT);
  typeKind.set('$templateHead', KIND_TEMPLATE_HEAD);
  typeKind.set('$templateMiddle', KIND_TEMPLATE_MIDDLE);
  typeKind.set('$templateTail', KIND_TEMPLATE_TAIL);
  let nextKind = KIND_NAMED_MIN;
  for (const name of tokenNames) if (!typeKind.has(name)) typeKind.set(name, nextKind++);

  // Literal ints: keyword literals in [1 .. kwCount], punct literals after, disjoint.
  // The vocabulary must be a SUPERSET of every string classifyKey()/matchLiteralCall()
  // is ever called with — otherwise an unlisted literal gets int 0 (NONE) and a t===0
  // compare would false-match every plain token. classifyKey/matchLiteral see:
  //   • every `literal` node value reachable in a rule body — INCLUDING inside `not`
  //     (the reserved-word negative-lookahead), which shared collectLiterals
  //     deliberately does NOT descend into; so we walk the full tree here.
  //   • every operator value (prefix/infix/postfix) — keyword-shaped ops like `delete`
  //     are matched as literals inside the reserved-word `not`, yet live only in `precs`.
  //   • every FIRST-set member (defensive; these are literals or token names).
  const allLiterals = new Set<string>();
  function collectAllLiterals(e: RuleExpr): void {
    switch (e.type) {
      case 'literal': allLiterals.add(e.value); return;
      case 'seq': case 'alt': e.items.forEach(collectAllLiterals); return;
      case 'quantifier': case 'group': case 'not': collectAllLiterals(e.body); return;
      case 'sep': collectAllLiterals(e.element); allLiterals.add(e.delimiter); return;
      default: return;
    }
  }
  for (const rule of grammar.rules) collectAllLiterals(rule.body);
  for (const level of grammar.precs) for (const op of level.operators) allLiterals.add(op.value);
  for (const fs of firstSets.values()) if (fs) for (const k of fs) if (!tokenNames.has(k) && !qualKeys.has(k)) allLiterals.add(k);
  const kwLitKind = new Map<string, number>();
  const puLitKind = new Map<string, number>();
  let nextLit = 1;
  for (const lit of allLiterals) if (isKeywordLiteral(lit) && !kwLitKind.has(lit)) kwLitKind.set(lit, nextLit++);
  for (const lit of allLiterals) if (!isKeywordLiteral(lit) && !puLitKind.has(lit)) puLitKind.set(lit, nextLit++);

  // Pre-classify a FIRST-set key the SAME way keyMatchesTok does, into an int
  // descriptor the emitted checks consume. Order MUST match keyMatchesTok:
  // tokenNames.has → token-name; else isKeywordLiteral → keyword; else punct.
  type KeyDesc =
    | { kind: 'tok'; k: number; template: boolean }
    | { kind: 'kw'; t: number }
    | { kind: 'punct'; t: number; v: string };
  function classifyKey(key: string): KeyDesc {
    if (tokenNames.has(key)) {
      return { kind: 'tok', k: typeKind.get(key)!, template: templateTokenNames.has(key) };
    }
    if (isKeywordLiteral(key)) {
      // A keyword key whose literal int we know (it is a literal in some rule body).
      // If somehow not in the vocabulary (defensive), fall back to a never-matching 0.
      return { kind: 'kw', t: kwLitKind.get(key) ?? 0 };
    }
    return { kind: 'punct', t: puLitKind.get(key) ?? 0, v: key };
  }
  // A sentinel kind for any non-'' token type the lexer did not declare (unreachable
  // for this closed lexer, but kept faithful): one past the max declared kind, so it
  // is >= NAMED_MIN (behaves as "a named token" for the keyword-by-text branch) yet
  // collides with NO real token-name kind (so matchToken(name) never false-matches it).
  const KIND_NAMED_FALLBACK = nextKind;
  const symtab = {
    KIND_PUNCT, KIND_TEMPLATE_HEAD, KIND_NAMED_MIN, KIND_NAMED_FALLBACK,
    typeKind, kwLitKind, puLitKind, classifyKey,
  };

  return {
    grammar, tokenNames, opTable, prefixOps, noUnaryLhsOps, postfixOpValues,
    prattRules, leftRecSet, ruleByName, prattClassified, leftRecClassified,
    maxBp, templateTokenName, templateTokenNames, firstTokenOf, altDeepFirst, altNullable,
    altSecond, ledMeta, contMeta, nullableRules, firstSets, symtab, qualKeys,
  };
}

// ── Code-emission helpers ──

const J = (v: unknown) => JSON.stringify(v);
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Emit a specialized matcher BODY for a RuleExpr — straight-line code that mirrors
 * matchExpr/matchSeq/matchQuantifier/matchSep exactly, but with each step inlined as
 * a direct call (matchLiteral('x'), the ref's parse function, matchToken, an unrolled
 * quantifier loop, the zero-width assertions, sep). Pushes matched leaves/nodes into a
 * local array `out` (declared by the caller). On failure it `pos = <saveVar>; return null`.
 * Returns a string of statements. `saveVar` is the position to restore to on failure.
 *
 * The semantics are a 1:1 transcription of the interpreter's matchExpr switch, so the
 * emitted code accepts/rejects and shapes the CST identically.
 */
class Emitter {
  private buf: string[] = [];
  private tmp = 0;
  // Generated compound-matcher helpers, deduplicated by their structural key so an
  // expr shared across rules emits one helper. Each is a fn returning children[]|null
  // (the matchExpr contract) — control flow is `return`, never `break`, so inlined
  // loops (quantifier/sep) never clash with an enclosing construct's loop.
  private helpers = new Map<string, string>();   // structural key → fn name
  private helperDefs: string[] = [];
  // Deduped FIRST-set membership tables + their per-set test fns, hoisted to module
  // level. The longest-match alt guards and the rule-ref guards sit on the hottest
  // dispatch paths; each set bakes to two Uint8Array byte tables (indexed by tok.k /
  // tok.t) so the test is two loads + an or — no per-desc loop. Spliced at the same
  // `//${HELPERS}` sentinel (top-level, above the rule fns).
  private u8Consts = new Map<string, string>();     // `${size}:${ones}` → const name
  private memberFns = new Map<string, string>();    // `${kConst}|${tConst}` → fn name
  private u32Consts = new Map<string, string>();    // mask-table values → const name
  private u8Emitted = false;
  readonly a: ReturnType<typeof analyze>;
  constructor(a: ReturnType<typeof analyze>) { this.a = a; }

  // Token-text materialization: a source-span slice for an emitted (SoA) lexer, the
  // converter-filled text column for createLexer-fallback grammars (synthetic tokens
  // there — indent/dedent etc. — have text that is NOT a source span). Chosen at emit
  // time; the runtime has a single form.
  soa = false;
  textAt(idx: string): string {
    return this.soa ? `src.slice(tkOff[${idx}], tkEnd[${idx}])` : `tkText[${idx}]`;
  }
  private id() { return `_t${this.tmp++}`; }

  emit(line = '') { this.buf.push(line); }
  // The compound-matcher helpers are function declarations (hoisted), but they must sit
  // BELOW the module's import statements. The header emits a `${HELPERS}` sentinel right
  // after the imports/tables; we splice the collected helpers there.
  toString() {
    // MEMO_RULES is known only after every memoized rule allocated its slot.
    this.helperDefs.push(`const MEMO_RULES = ${this.memoIdx.size};`);
    const src = this.buf.join('\n');
    return src.replace('//${HELPERS}', this.helperDefs.join('\n\n'));
  }

  // Per-memoized-rule slot in the parse-wide memo array (replaces the string-keyed
  // outer Map: parseRuleEntry runs per rule entry, so the name hash was on a hot path).
  private memoIdx = new Map<string, number>();
  memoIndex(name: string): number {
    let i = this.memoIdx.get(name);
    if (i === undefined) { i = this.memoIdx.size; this.memoIdx.set(name, i); }
    return i;
  }

  // Reference to a rule's parse function (token refs are inlined where used).
  private ruleFn(name: string) { return `R_${sanitize(name)}`; }

  /**
   * Emit (once) a helper fn for a compound `expr` and return its name. The helper
   * has the matchExpr contract: returns the matched children array or null, with pos
   * restored on failure. Using a function (not inlined statements) means failure is a
   * `return null` and loops use `return`, so nested compounds never have a `break`
   * that escapes to the wrong loop — the one real hazard of inlining the tree-walk.
   */
  private matchFn(expr: RuleExpr): string {
    const key = JSON.stringify(expr);
    const existing = this.helpers.get(key);
    if (existing) return existing;
    const name = `m${this.helpers.size}`;
    this.helpers.set(key, name);
    const body: string[] = [`function ${name}() {`];
    const single = this.singleLeafBody(expr);
    if (single) {
      // Matcher produces exactly one child: the matcher call already pushes it —
      // no save needed (a failing single matcher consumes nothing).
      body.push(single);
    } else {
      body.push(`  const _save = pos; const _sn = scn;`);
      body.push(this.matchInto(expr, `pos = _save; scn = _sn; return false;`));
      body.push(`  return true;`);
    }
    body.push(`}`);
    this.helperDefs.push(body.join('\n'));
    return name;
  }

  // Public wrapper so free-function emitters (emitArmNamed) can reuse the single-leaf
  // specialization.
  singleLeafBodyPublic(expr: RuleExpr): string | null { return this.singleLeafBody(expr); }

  // If `expr` matches exactly one child (a single literal, a single non-template token
  // ref, or a single rule ref — possibly wrapped in a transparent group / one-item seq),
  // return a body that just delegates to the (already pushing) matcher call — skipping
  // the save/restore (a failing single matcher consumes nothing and pushes nothing).
  // Else null. Excludes template-token refs (two-branch) and suppress-groups.
  private singleLeafBody(expr: RuleExpr): string | null {
    const a = this.a;
    // Unwrap transparent wrappers that don't themselves emit/consume.
    while (true) {
      if (expr.type === 'group' && !(expr.suppress && expr.suppress.length)) { expr = expr.body; continue; }
      if (expr.type === 'seq') {
        const real = expr.items.filter(it => it.type !== 'op' && it.type !== 'prefix' && it.type !== 'postfix');
        if (real.length === 1) { expr = real[0]; continue; }
      }
      break;
    }
    if (expr.type === 'literal') {
      return `  return ${this.matchLiteralCall(expr.value)};`;
    }
    if (expr.type === 'ref') {
      if (a.tokenNames.has(expr.name)) {
        if (a.templateTokenNames.has(expr.name)) return null;   // two-branch (template) — not single-leaf
        return `  return ${this.matchTokenCall(expr.name)};`;
      }
      // Rule ref: keep the FIRST-set guard, then the call.
      const guard = this.firstGuard(expr.name);
      const guardLine = guard ? `  if (${guard}) { return false; }\n` : '';
      return `${guardLine}  return ${this.ruleFn(expr.name)}();`;
    }
    return null;
  }

  /**
   * Generate statements that match `expr`, PUSHING children onto the scratch stack
   * (the arena protocol — every matcher/rule call pushes its own result), and on any
   * failure execute `onFail` (which restores pos + scn and returns). Simple/flat
   * shapes are INLINED here (specialized straight-line code, no matchExpr switch);
   * compound shapes (alt / quantifier / sep / nested seq with a contained loop)
   * delegate to a generated helper fn via matchFn — keeping control flow `return`-based.
   */
  matchInto(expr: RuleExpr, onFail: string): string {
    const a = this.a;
    switch (expr.type) {
      case 'literal': {
        return `if (!${this.matchLiteralCall(expr.value)}) { ${onFail} }`;
      }
      case 'ref': {
        if (a.tokenNames.has(expr.name)) {
          // Template tokens: route to parseTemplateExpr first (interpolated templates).
          if (a.templateTokenNames.has(expr.name)) {
            return `if (!parseTemplateExpr() && !${this.matchTokenCall(expr.name)}) { ${onFail} }`;
          }
          return `if (!${this.matchTokenCall(expr.name)}) { ${onFail} }`;
        }
        // Rule ref: FIRST-set guard (ruleMightStart) baked as a direct check, then call.
        const guard = this.firstGuard(expr.name);
        return [
          guard ? `if (${guard}) { ${onFail} }` : ``,
          `if (!${this.ruleFn(expr.name)}()) { ${onFail} }`,
        ].filter(Boolean).join('\n');
      }
      case 'seq': {
        // Inline each item in order; share the caller's onFail (which restores to the
        // seq's save point). matchSeq skips op/prefix/postfix markers. A nested seq is
        // flattened inline too — its failure restores to the SAME save point (the whole
        // matcher fn's _save), exactly like matchSeq's single saved/restore.
        const parts: string[] = [];
        for (const item of expr.items) {
          if (item.type === 'op' || item.type === 'prefix' || item.type === 'postfix') continue;
          parts.push(this.matchInto(item, onFail));
        }
        return parts.join('\n');
      }
      case 'alt': {
        // matchExpr 'alt': try each arm (a helper fn) from a shared save; first
        // success wins — its children are already on scratch.
        const save = this.id(), sn = this.id(), r = this.id();
        const lines: string[] = [`const ${save} = pos; const ${sn} = scn;`, `let ${r} = false;`];
        for (const item of expr.items) {
          const fn = this.matchFn(item);
          lines.push(`if (!${r}) { pos = ${save}; scn = ${sn}; ${r} = ${fn}(); }`);
        }
        lines.push(`if (!${r}) { pos = ${save}; scn = ${sn}; ${onFail} }`);
        return lines.join('\n');
      }
      case 'quantifier':
        return this.matchQuantifierInto(expr.body, expr.kind, onFail);
      case 'group': {
        // A suppress-carrying group stages the LED-connector exclusion for the next
        // parseRule, then matches its body (same as matchExpr 'group').
        const pre = (expr.suppress && expr.suppress.length)
          ? `suppressNext = new Set(${J(expr.suppress)});`
          : ``;
        return [pre, this.matchInto(expr.body, onFail)].filter(Boolean).join('\n');
      }
      case 'not': {
        // Zero-width negative lookahead: succeed (no children) iff body does NOT match.
        const kinds = this.notKwKinds(expr.body);
        if (kinds) {
          // Fast: one keyword-kind membership test (no body matcher, nothing pushed).
          const cond = kinds.map(k => `_tt === ${k}`).join(' || ');
          return `if (pos < cap && tkK[pos] >= K_NAMED_MIN) { const _tt = tkT[pos]; if (${cond}) { ${onFail} } }`;
        }
        const save = this.id(), sn = this.id(), fn = this.matchFn(expr.body), m = this.id();
        return [
          `{ const ${save} = pos; const ${sn} = scn; const ${m} = ${fn}(); pos = ${save}; scn = ${sn};`,
          `  if (${m}) { ${onFail} } }`,
        ].join('\n');
      }
      case 'sameLine':
        return `if (!(pos < cap && (tkFl[pos] & 1) === 0)) { ${onFail} }`;
      case 'noCommentBefore':
        return `if (!(pos < cap && (tkFl[pos] & 2) === 0)) { ${onFail} }`;
      case 'noMultilineFlowBefore':
        return `if (!(pos < cap && (tkFl[pos] & 4) === 0)) { ${onFail} }`;
      case 'sep':
        return this.matchSepInto(expr.element, expr.delimiter, onFail);
      default:
        // op/prefix/postfix — handled by Pratt; in matchExpr these return null.
        return `{ ${onFail} }`;
    }
  }

  // Quantifier: body is matched via a helper fn (pushes + boolean), so the loop here
  // uses `return`/`break` only against ITS OWN while — no nested-loop hazard.
  private matchQuantifierInto(body: RuleExpr, kind: '*' | '+' | '?', onFail: string): string {
    const fn = this.matchFn(body);
    if (kind === '?') {
      // Try once; on failure the helper restored pos/scn itself.
      return `${fn}();`;
    }
    if (kind === '*') {
      const before = this.id(), bsn = this.id();
      return [
        `while (true) {`,
        `  const ${before} = pos; const ${bsn} = scn;`,
        `  if (!${fn}()) break;`,
        `  if (pos === ${before} && scn === ${bsn}) break;`,
        `}`,
      ].join('\n');
    }
    // '+': first mandatory, then the same loop.
    const before = this.id(), bsn = this.id();
    return [
      `if (!${fn}()) { ${onFail} }`,
      `while (true) {`,
      `  const ${before} = pos; const ${bsn} = scn;`,
      `  if (!${fn}()) break;`,
      `  if (pos === ${before} && scn === ${bsn}) break;`,
      `}`,
    ].join('\n');
  }

  // sep = (element (delimiter element)*)?  — never fails (matches zero elements).
  // element matched via helper fn. A delimiter with no following element stays kept
  // (trailing-delimiter semantics) — it was already pushed by its matcher.
  private matchSepInto(element: RuleExpr, delimiter: string, _onFail: string): string {
    const fn = this.matchFn(element);
    return [
      `if (${fn}()) {`,
      `  while (true) {`,
      `    const _ds = pos; if (!${this.matchLiteralCall(delimiter)}) { pos = _ds; break; }`,
      `    if (!${fn}()) break;`,
      `  }`,
      `}`,
    ].join('\n');
  }

  // Baked FIRST-set guard for a rule ref: the NEGATED ruleMightStart condition (so
  // the caller writes `if (<guard>) { onFail }`). Returns '' when the rule can always
  // start (nullable / null FIRST set) → no guard (matches ruleMightStart returning true).
  firstGuard(name: string): string {
    const a = this.a;
    if (a.nullableRules.has(name)) return '';
    const fs = a.firstSets.get(name);
    if (!fs || fs.size === 0) return '';
    // ruleMightStart: true iff some key in fs matches peek(); guard = NOT that. The set
    // is baked as a per-set membership fn over two byte tables (see membershipFn).
    return `!${this.membershipFn(fs)}(pos)`;
  }

  // Deep per-alternative dispatch condition (mirrors gen-parser.ts altMightStart): the
  // POSITIVE "this alt might start at startTok" test for the longest-match loops. `true`
  // when the alt is nullable or its FIRST set is unknown/empty (always tried — an empty
  // match never wins longest-match); else a membership test over the alt's transitive
  // FIRST set, baked as a hoisted int-descriptor array (same encoding firstGuard uses).
  altGuard(alt: RuleExpr): string {
    const a = this.a;
    if (a.altNullable.get(alt)) return 'true';
    const fs = a.altDeepFirst.get(alt);
    if (!fs || fs.size === 0) return 'true';
    return `${this.membershipFn(fs)}(saved)`;
  }

  // A `not(...)` over a literal / alternation of KEYWORD literals → the int keyword-kinds,
  // else null. Lets the not be one membership test instead of matching each keyword arm
  // (mirrors gen-parser.ts notKwSet; emits the same check matchKwLit uses, so byte-identical).
  notKwKinds(body: RuleExpr): number[] | null {
    const kinds: number[] = [];
    const collect = (e: RuleExpr): boolean =>
      e.type === 'literal' ? (isKeywordLiteral(e.value) ? (kinds.push(this.a.symtab.kwLitKind.get(e.value)!), true) : false)
        : e.type === 'alt' ? e.items.every(collect)
        : false;
    return collect(body) && kinds.length > 0 ? kinds : null;
  }

  // Register (deduped) a FIRST-set's membership test as a module-level fn over two
  // byte tables and return the fn's NAME. Test: `!tok || (KT[tok.k] | TT[tok.t])` —
  // faithful to the old per-desc loop because the kw int range and the punct int range
  // are DISJOINT (so the loop's k!==K_PUNCT / k===K_PUNCT guards were redundant), and
  // a punct desc's text.startsWith(v) arm is enumerated over the closed punct
  // vocabulary at emit time. The one narrowing: a K_PUNCT token whose text is OUTSIDE
  // the vocabulary (t=0) can't startsWith-match here — such a token is unreachable
  // (the lexer scans only vocabulary puncts; `>`-split rests stay in-vocabulary),
  // and the full-corpus byte-identical gate covers it empirically.
  membershipFn(fs: Set<string>): string {
    const { kArr, tArr } = this.membershipTables(fs);
    const fnKey = `${kArr}|${tArr}`;
    let nm = this.memberFns.get(fnKey);
    if (!nm) {
      nm = `_q${this.memberFns.size}`;
      this.memberFns.set(fnKey, nm);
      this.helperDefs.push(`function ${nm}(i) { return i >= cap || (${kArr}[tkK[i]] | ${tArr}[tkT[i]]) !== 0; }`);
    }
    return nm;
  }

  // The first-token gate for an alt/LED whose tok is already known non-null: the same
  // two-table membership as membershipFn, open-coded (no call). null FirstTok → no gate.
  ftCond(ft: FirstTok, idxVar: string): string | null {
    if (!ft) return null;
    const key = 'tok' in ft ? ft.tok : ft.lit;
    const { kArr, tArr } = this.membershipTables(new Set([key]));
    return `(${kArr}[tkK[${idxVar}]] | ${tArr}[tkT[${idxVar}]]) !== 0`;
  }

  // A FIRST set's admitted (tok.k, tok.t) index sets — the shared classification behind
  // the byte tables and the alt-dispatch masks (same split keyMatchesTok used).
  private firstSetOnes(fs: Set<string>): { kOnes: Set<number>; tOnes: Set<number> } {
    const st = this.a.symtab;
    const kOnes = new Set<number>(), tOnes = new Set<number>();
    for (const key of [...fs].sort()) {
      const q = this.a.qualKeys.get(key);
      if (q) {
        // Reserved-qualified token key: admit by t instead of the blanket k-bit —
        // t=0 (covers plain members of the token class; over-admits other t=0 kinds
        // harmlessly) plus every keyword t outside the guard class.
        tOnes.add(0);
        for (const [text, id] of st.kwLitKind) if (!q.except.has(text)) tOnes.add(id);
        continue;
      }
      const d = st.classifyKey(key);
      if (d.kind === 'tok') {
        kOnes.add(d.k);
        if (d.template) kOnes.add(st.KIND_TEMPLATE_HEAD);
      } else if (d.kind === 'kw') {
        if (d.t === 0) throw new Error(`emit: FIRST key ${J(key)} missing from the literal vocabulary`);
        tOnes.add(d.t);
      } else {
        if (d.t === 0) throw new Error(`emit: FIRST key ${J(key)} missing from the literal vocabulary`);
        for (const [text, id] of st.puLitKind) if (text.startsWith(d.v)) tOnes.add(id);
      }
    }
    return { kOnes, tOnes };
  }

  private kSize(): number { return this.a.symtab.KIND_NAMED_FALLBACK + 1; }
  private tSize(): number {
    const st = this.a.symtab;
    let n = 1;
    for (const v of st.kwLitKind.values()) n = Math.max(n, v + 1);
    for (const v of st.puLitKind.values()) n = Math.max(n, v + 1);
    return n;
  }

  // Build (deduped) the two byte tables for a FIRST set's membership test.
  private membershipTables(fs: Set<string>): { kArr: string; tArr: string } {
    const { kOnes, tOnes } = this.firstSetOnes(fs);
    return {
      kArr: this.u8Const(this.kSize(), [...kOnes].sort((a, b) => a - b)),
      tArr: this.u8Const(this.tSize(), [...tOnes].sort((a, b) => a - b)),
    };
  }

  // Per-alternative dispatch masks for a longest-match alt list (one bit per alt):
  //   mask = startTok ? KM[startTok.k] | TM[startTok.t] : ALL
  // and each alt's guard is one bit test — replacing a per-alt membership call with a
  // shared pair of loads. Bit i is set exactly where altGuard(alt_i) is true: an
  // always-tried alt (nullable / unknown-FIRST) has its bit in every k slot, and a null
  // lookahead (EOF) admits every alt, mirroring the per-alt guards' !tok → true.
  //
  // Lists over 32 alts span MULTIPLE mask words (one table pair + one local per word;
  // alt i lives in word i>>5, bit i&31) — there is deliberately NO arm-count ceiling:
  // a single-word cap silently dropped a rule back to serial per-alt guards the moment
  // a grammar widening pushed it past 32 (R_Type crossed at 33 and cost ~25% whole-parse
  // until the cliff was found), and dispatch must degrade smoothly, not cliff.
  // null only when the list is too small for the tables to pay.
  altMaskDispatch(alts: RuleExpr[], maskVar: string): { maskInit: string; bit: (i: number) => string } | null {
    if (alts.length < 3) return null;
    const a = this.a;
    const words = Math.ceil(alts.length / 32);
    const wVar = (w: number) => (words === 1 ? maskVar : `${maskVar}_w${w}`);
    const kMask = Array.from({ length: words }, () => new Array<number>(this.kSize()).fill(0));
    const tMask = Array.from({ length: words }, () => new Array<number>(this.tSize()).fill(0));
    const all = new Array<number>(words).fill(0);
    alts.forEach((alt, i) => {
      const w = i >> 5;
      const bit = (1 << (i & 31)) | 0;
      all[w] |= bit;
      const fs = a.altDeepFirst.get(alt);
      if (a.altNullable.get(alt) || !fs || fs.size === 0) {
        for (let k = 0; k < kMask[w].length; k++) kMask[w][k] |= bit;
        return;
      }
      const { kOnes, tOnes } = this.firstSetOnes(fs);
      for (const k of kOnes) kMask[w][k] |= bit;
      for (const t of tOnes) tMask[w][t] |= bit;
    });
    // SECOND-token refinement: drop an admitted alt when the actual second token can't
    // be its second token and it can't end after one. An alt with unknown/len1/nullable
    // SECOND keeps its bit everywhere (and in the EOF-after-one mask `alw2`). Sound:
    // a pruned arm needs a second token it provably can't accept — it would fail.
    // (The '>'-split is covered: a '>' SECOND key sets every '>'-led punct bit via
    // firstSetOnes' startsWith expansion, so post-splice second tokens stay admitted.)
    const k2Mask = Array.from({ length: words }, () => new Array<number>(this.kSize()).fill(0));
    const t2Mask = Array.from({ length: words }, () => new Array<number>(this.tSize()).fill(0));
    const alw2 = new Array<number>(words).fill(0);
    let refines = false;
    alts.forEach((alt, i) => {
      const w = i >> 5;
      const bit = (1 << (i & 31)) | 0;
      const sec = a.altSecond.get(alt);
      // The always conditions MIRROR gen-parser's altMightSecond null-keys cases
      // exactly (incl. empty-set → always) — engine-identical prune decisions.
      if (a.altNullable.get(alt) || !sec || sec.s === null || sec.len1 || sec.s.size === 0) {
        for (let k = 0; k < k2Mask[w].length; k++) k2Mask[w][k] |= bit;
        alw2[w] |= bit;
        return;
      }
      refines = true;
      const { kOnes, tOnes } = this.firstSetOnes(sec.s);
      for (const k of kOnes) k2Mask[w][k] |= bit;
      for (const t of tOnes) t2Mask[w][t] |= bit;
    });
    const inits: string[] = [];
    for (let w = 0; w < words; w++) {
      const kArr = this.u32Const(kMask[w]);
      const tArr = this.u32Const(tMask[w]);
      if (!refines) {
        inits.push(`const ${wVar(w)} = saved < tokN ? (${kArr}[tkK[saved]] | ${tArr}[tkT[saved]]) : ${all[w]};`);
      } else {
        const k2Arr = this.u32Const(k2Mask[w]);
        const t2Arr = this.u32Const(t2Mask[w]);
        inits.push(`const ${wVar(w)} = saved < tokN ? ((${kArr}[tkK[saved]] | ${tArr}[tkT[saved]]) & (saved + 1 < cap ? (${k2Arr}[tkK[saved + 1]] | ${t2Arr}[tkT[saved + 1]]) : ${alw2[w]})) : ${all[w]};`);
      }
    }
    return {
      maskInit: inits.join(' '),
      bit: (i: number) => `${wVar(i >> 5)} & ${(1 << (i & 31)) | 0}`,
    };
  }

  // Bitmask dispatch over a list of first-TOKEN gates (the LED chain): the same mask
  // tables as altMaskDispatch, built from per-LED FirstTok keys (null ft = always
  // admitted); the lookahead is known non-null at the LED loop head. Multi-word over
  // 32 entries, same scheme as altMaskDispatch — no arm-count cliff.
  ftMaskDispatch(fts: FirstTok[], maskVar: string, tokVar: string): { maskInit: string; bit: (i: number) => string } | null {
    if (fts.length < 3) return null;
    const words = Math.ceil(fts.length / 32);
    const wVar = (w: number) => (words === 1 ? maskVar : `${maskVar}_w${w}`);
    const kMask = Array.from({ length: words }, () => new Array<number>(this.kSize()).fill(0));
    const tMask = Array.from({ length: words }, () => new Array<number>(this.tSize()).fill(0));
    fts.forEach((ft, i) => {
      const w = i >> 5;
      const bit = (1 << (i & 31)) | 0;
      if (!ft) { for (let k = 0; k < kMask[w].length; k++) kMask[w][k] |= bit; return; }
      const key = 'tok' in ft ? ft.tok : ft.lit;
      const { kOnes, tOnes } = this.firstSetOnes(new Set([key]));
      for (const k of kOnes) kMask[w][k] |= bit;
      for (const t of tOnes) tMask[w][t] |= bit;
    });
    const inits: string[] = [];
    for (let w = 0; w < words; w++) {
      inits.push(`const ${wVar(w)} = ${this.u32Const(kMask[w])}[tkK[${tokVar}]] | ${this.u32Const(tMask[w])}[tkT[${tokVar}]];`);
    }
    return {
      maskInit: inits.join(' '),
      bit: (i: number) => `${wVar(i >> 5)} & ${(1 << (i & 31)) | 0}`,
    };
  }

  // A deduped Int32Array const (the per-rule alt-dispatch mask tables).
  private u32Const(values: number[]): string {
    const key = values.join(',');
    let nm = this.u32Consts.get(key);
    if (!nm) {
      nm = `_am${this.u32Consts.size}`;
      this.u32Consts.set(key, nm);
      this.helperDefs.push(`const ${nm} = Int32Array.from([${key}]);`);
    }
    return nm;
  }

  // A deduped Uint8Array const with 1s at `ones` (the byte tables behind membershipFn).
  private u8Const(size: number, ones: number[]): string {
    const key = `${size}:${ones.join(',')}`;
    let nm = this.u8Consts.get(key);
    if (!nm) {
      if (!this.u8Emitted) {
        this.helperDefs.push(`function u8(n, ones) { const a = new Uint8Array(n); for (let i = 0; i < ones.length; i++) a[ones[i]] = 1; return a; }`);
        this.u8Emitted = true;
      }
      nm = `_qb${this.u8Consts.size}`;
      this.u8Consts.set(key, nm);
      this.helperDefs.push(`const ${nm} = u8(${size}, [${ones.join(',')}]);`);
    }
    return nm;
  }

  // ── Lever 1 emit helpers ──
  // Specialized literal matcher call: keyword → matchKwLit, punct → matchPuLit, each
  // with the value's baked int (so the runtime does int compares, not string work).
  matchLiteralCall(value: string): string {
    const d = this.a.symtab.classifyKey(value);
    if (d.kind === 'kw') return `matchKwLit(${d.t})`;
    if (d.kind === 'punct') return value === '>' ? `matchPuLitGT(${d.t})` : `matchPuLit(${d.t})`;
    // A literal key that classifies as a token-name (a token name used as a literal):
    // unreachable for real grammars, but stay safe via the generic matchLiteral.
    return `matchLiteral(${J(value)})`;
  }
  // Specialized token matcher call: tok.k === <name kind>.
  matchTokenCall(name: string): string {
    const k = this.a.symtab.typeKind.get(name);
    return k === undefined ? `matchLiteral(${J(name)})` : `matchTokK(${k})`;
  }
}

// ── Top-level emit ──

export function emitParser(grammar: CstGrammar): string {
  const a = analyze(grammar);
  const e = new Emitter(a);
  const entry = findEntryRule(grammar);

  // Grammar-lite for the lexer: ONLY what createLexer reads (tokens, precs, the
  // literals via rules, markup, indent). We bake the token/precs/markup/indent DATA
  // and replace `rules` with ONE synthetic rule whose body is an `alt` of every
  // literal the real rules contribute — so createLexer's `allLiterals` set (and thus
  // its punctuation table) is identical, without baking the grammar definition.
  const allLits = new Set<string>();
  for (const rule of grammar.rules) for (const l of collectLiterals(rule.body)) allLits.add(l);
  const litRuleBody: RuleExpr = { type: 'alt', items: [...allLits].map(v => ({ type: 'literal', value: v } as RuleExpr)) };
  const lexGrammar = {
    tokens: grammar.tokens,
    precs: grammar.precs,
    rules: [{ name: '$lits', body: litRuleBody, flags: [] }],
    markup: grammar.markup,
    indent: grammar.indent,
    newline: grammar.newline,
    scopeOverrides: [],
  };

  // ── Header: imports + baked tables + grammar-lite ──
  e.emit(`// GENERATED by src/emit-parser.ts — do not edit. Specialized parser for grammar ${J(grammar.name ?? '')}.`);
  // The lexer: EMITTED (specialized, standalone — see emit-lexer.ts) when the grammar
  // is a plain token stream; the data-driven createLexer runtime otherwise
  // (markup/indent/newline state machines stay interpreter-only).
  const st = a.symtab;
  const lexSrc = emitLexer(grammar, {
    typeKind: st.typeKind, kwLitKind: st.kwLitKind, puLitKind: st.puLitKind,
    KIND_PUNCT: st.KIND_PUNCT, KIND_NAMED_FALLBACK: st.KIND_NAMED_FALLBACK,
  });
  e.soa = lexSrc !== null;
  if (!lexSrc) {
    e.emit(`import { createLexer } from ${J(resolveLexerImport())};`);
    e.emit(``);
    e.emit(`const LEX_GRAMMAR = ${J(lexGrammar)};`);
  }
  e.emit(``);
  // ── Lever 1: integer token-kind tables (see analyze()'s symtab) ──
  // TYPE_KIND: tok.type → int. LIT_KW / LIT_PU: tok.text → keyword / punct literal int.
  // Every token is BORN with tok.k (type kind) + tok.t (literal kind) and the stamp
  // flags — one monomorphic shape, one allocation, no post-pass.
  e.emit(`const TYPE_KIND = new Map(${J([...st.typeKind])});`);
  e.emit(`const LIT_KW = new Map(${J([...st.kwLitKind])});`);
  e.emit(`const LIT_PU = new Map(${J([...st.puLitKind])});`);
  e.emit(`const K_PUNCT = ${st.KIND_PUNCT};`);
  e.emit(`const K_TEMPLATE_HEAD = ${st.KIND_TEMPLATE_HEAD};`);
  e.emit(`const K_TEMPLATE_MIDDLE = ${st.KIND_TEMPLATE_HEAD + 1};`);
  e.emit(`const K_TEMPLATE_TAIL = ${st.KIND_TEMPLATE_HEAD + 2};`);
  e.emit(`const K_NAMED_MIN = ${st.KIND_NAMED_MIN};`);
  e.emit(`const K_NAMED_FALLBACK = ${st.KIND_NAMED_FALLBACK};`);
  // The template token's own kind (-1 when the grammar has no template token).
  e.emit(`const K_TPL_TOKEN = ${a.templateTokenName ? st.typeKind.get(a.templateTokenName) : -1};`);
  e.emit(``);
  if (lexSrc) {
    e.emit(lexSrc);
  } else {
    e.emit(`const { tokenize } = createLexer(LEX_GRAMMAR, {`);
    e.emit(`  typeKind: TYPE_KIND, kwLit: LIT_KW, puLit: LIT_PU,`);
    e.emit(`  punctKind: K_PUNCT, namedFallback: K_NAMED_FALLBACK,`);
    e.emit(`});`);
  }
  e.emit(``);
  // Baked maps. Emit as object literals → Map.
  e.emit(`const opTable = new Map(${J([...a.opTable])});`);
  e.emit(`const prefixOps = new Map(${J([...a.prefixOps])});`);
  // The same op tables re-keyed by the literal int (tok.t): the Pratt loops look an
  // operator up for EVERY token they reach, and tok.t is already interned — an array
  // load replaces the string-keyed Map.get. Equivalent because a token's text can equal
  // an operator value only for punct tokens and keyword-shaped idents, exactly the
  // classes tok.t indexes (operator values are in the literal vocabulary by construction).
  {
    let tSize = 1;
    for (const v of st.kwLitKind.values()) tSize = Math.max(tSize, v + 1);
    for (const v of st.puLitKind.values()) tSize = Math.max(tSize, v + 1);
    const byT = (m: Map<string, unknown>) => {
      const arr: unknown[] = new Array(tSize).fill(null);
      for (const [value, info] of m) {
        const d = st.classifyKey(value);
        if (d.kind === 'tok' || d.t === 0) throw new Error(`emit: operator ${J(value)} missing from the literal vocabulary`);
        arr[d.t] = info;
      }
      return arr;
    };
    e.emit(`const OP_BY_T = ${J(byT(a.opTable))};`);
    e.emit(`const PREFIX_BY_T = ${J(byT(a.prefixOps))};`);
  }
  e.emit(`const noUnaryLhsOps = new Set(${J([...a.noUnaryLhsOps])});`);
  {
    let tSize = 1;
    for (const v of st.kwLitKind.values()) tSize = Math.max(tSize, v + 1);
    for (const v of st.puLitKind.values()) tSize = Math.max(tSize, v + 1);
    const nu = new Array<number>(tSize).fill(0);
    for (const v of a.noUnaryLhsOps) {
      const d = st.classifyKey(v);
      if (d.kind !== 'tok' && d.t > 0) nu[d.t] = 1;
    }
    e.emit(`const NOUNARY_T = Uint8Array.from([${nu.join(',')}]);`);
  }
  e.emit(`const postfixOpValues = new Set(${J([...a.postfixOpValues])});`);
  e.emit(`const tokenNames = new Set(${J([...a.tokenNames])});`);
  e.emit(`const templateTokenNames = new Set(${J([...a.templateTokenNames])});`);
  e.emit(`const templateTokenName = ${J(a.templateTokenName ?? null)};`);
  e.emit(`const maxBp = ${a.maxBp};`);
  e.emit(`const ENTRY = ${J(entry)};`);
  // Rule-name table: rowRule stores the index; '$template' takes the slot after the
  // declared rules (parseTemplateExpr's synthetic node).
  e.emit(`const RULE_NAMES = ${J([...grammar.rules.map(r => r.name), '$template'])};`);
  e.emit(`const RID_TEMPLATE = ${grammar.rules.length};`);
  e.emit(`const prattRuleNames = new Set(${J([...a.prattRules])});`);
  // The expression rule the template-interpolation fallback (findExprRule) picks:
  // first pratt rule that isn't Type, in declaration order. Bake the resolved name.
  const exprRuleName = (() => {
    for (const r of grammar.rules) if (a.prattRules.has(r.name) && r.name !== 'Type') return r.name;
    return grammar.rules[0].name;
  })();
  e.emit(`const EXPR_RULE = ${J(exprRuleName)};`);
  e.emit(``);
  // Compound-matcher helper fns are spliced in here (after imports/tables).
  e.emit(`//\${HELPERS}`);
  e.emit(``);

  // ── Shared runtime (copied semantics from gen-parser.ts) ──
  emitRuntime(e);

  // ── Per-rule parse functions ──
  emitRuleFns(e, a);

  // ── parse() driver ──
  emitDriver(e, a, entry);

  return e.toString();
}

// The lexer + utils imports are resolved relative to where the emitted file is
// written. Callers write the emitted file and decide the path; by default we emit
// absolute file: paths to THIS repo's src so the emitted file works from anywhere
// (e.g. /tmp). resolveLexerImport returns that absolute specifier.
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
function resolveLexerImport(): string { return pathResolve(__dir, 'gen-lexer.ts'); }

// ── Runtime: the generic engine state + control loops, emitted verbatim ──
// These are copied from gen-parser.ts so their semantics are byte-identical. The
// ONLY change: where the interpreter called matchExpr(alt)/matchSeq(items) per arm,
// these call the GENERATED per-arm matcher functions (installed via the rule fns).
function emitRuntime(e: Emitter) {
  // Column element type: Uint8 when the kind/literal id spaces fit a byte.
  const st = e.a.symtab;
  let tMax = 1;
  for (const v of st.kwLitKind.values()) tMax = Math.max(tMax, v);
  for (const v of st.puLitKind.values()) tMax = Math.max(tMax, v);
  const K_ARR = st.KIND_NAMED_FALLBACK <= 255 ? 'Uint8Array' : 'Uint16Array';
  const T_ARR = tMax <= 255 ? 'Uint8Array' : 'Uint16Array';
  e.emit(String.raw`
// ── Token stream: struct-of-arrays (no per-token object, no eager text) ──
// tkK = type kind, tkT = literal kind, tkOff/tkEnd = source span, tkFl = stamp bits
// (1 newlineBefore, 2 commentBefore, 4 multilineFlowBefore). Token text is materialized
// only when a CST leaf is built. The arrays persist across parses (pointer-free, no
// write-barrier or pinning cost) and grow by doubling.
let tkK = new ${K_ARR}(4096);
let tkT = new ${T_ARR}(4096);
let tkOff = new Int32Array(4096);
let tkEnd = new Int32Array(4096);
let tkFl = new Uint8Array(4096);
// lexer-state depth records per token (windowed relex restart/resync safety):
// tkDp = template-interp stack depth, tkPd = paren-head stack depth, both AS RECORDED
// at the token's push (the convention per token kind is fixed by the lexer's code
// path; determinism is what the predicates rely on, depth-0 is the safe state).
let tkDp = new Uint8Array(4096);
let tkPd = new Uint16Array(4096);
let tkCap = 4096;
let tokN = 0;
let src = '';
${e.soa ? '' : 'let tkText = [];   // fallback-lexer text column (synthetic tokens are not source spans)'}
function growTok() {
  tkCap *= 2;
  const k = new ${K_ARR}(tkCap); k.set(tkK); tkK = k;
  const t = new ${T_ARR}(tkCap); t.set(tkT); tkT = t;
  const o = new Int32Array(tkCap); o.set(tkOff); tkOff = o;
  const e2 = new Int32Array(tkCap); e2.set(tkEnd); tkEnd = e2;
  const f = new Uint8Array(tkCap); f.set(tkFl); tkFl = f;
  const d = new Uint8Array(tkCap); d.set(tkDp); tkDp = d;
  const q = new Uint16Array(tkCap); q.set(tkPd); tkPd = q;
}

// ── CST arena: nodes are rows in parallel columns; leaves are TOKEN REFERENCES ──
// A node is an integer id (row index). A leaf needs no storage at all — the token
// columns above already hold its span; a kids entry encodes which token and HOW it
// was matched (the match path decides the materialized tokenType):
//   entry >= 0  → node id
//   entry <  0  → leaf: ~((tokenIndex << 2) | kind), kind 0 = type-derived
//                 ($punct / token name / template part), 1 = '$keyword', 2 = '$operator'
// Rows store ABSOLUTE offsets in this phase (the green {rel,len} re-base is the
// incremental round's move; flipping the stored form regenerates matchers only).
let rowRule = new Uint16Array(8192);    // rule id (index into RULE_NAMES)
let rowLen = new Int32Array(8192);
let rowTokLen = new Int32Array(8192);   // subtree token count
let rowStart = new Int32Array(8192);    // first index into kids
let rowCount = new Int32Array(8192);
// lookahead GAP: how far past its own first token the node's parse may have READ
// (ext − start, a length — position-independent like everything green). Adoption
// validity across edits compares q + rowExt + slack against the damage start.
let rowExt = new Int32Array(8192);
// adoption eligibility: set ONLY where the old parse MEMOIZED the node — a row built
// under a suppress (no-'in') or parseLimit-capped context is a context-dependent
// parse and must never be adopted into a normal entry (the memo carry never stored
// those; adoption must not widen the contract).
let rowOK = new Uint8Array(8192);
// transient BUILD coordinates (absolute), valid for rows completed in the current
// parse and REFRESHED at memo-hit time for reused roots — parents read them at
// finishNode to write the children's relative fields; never part of the green tree.
let absChar = new Int32Array(8192);
let absTok = new Int32Array(8192);
let rowCap = 8192;
let nodeN = 0;
let kids = new Int32Array(16384);
// A node child's RELATIVE coordinates live in the PARENT's kids stream (parallel to
// kids), not on the child row: a memo-reused subtree can be a child of several
// longest-match CANDIDATES, and a losing candidate completing after the winner would
// clobber child-side rel fields. The parent owns its edges; rows own only lengths.
let kidRel = new Int32Array(16384);
let kidTokRel = new Int32Array(16384);
let kidCap = 16384;
let kidN = 0;
// Scratch: completed-but-unattached children of in-progress arms. Every
// save/restore of pos pairs with a save/restore of scn — they travel together.
let sc = new Int32Array(4096);
let scCap = 4096;
let scn = 0;
function growRows() {
  rowCap *= 2;
  const r = new Uint16Array(rowCap); r.set(rowRule); rowRule = r;
  const l = new Int32Array(rowCap); l.set(rowLen); rowLen = l;
  const tl = new Int32Array(rowCap); tl.set(rowTokLen); rowTokLen = tl;
  const s = new Int32Array(rowCap); s.set(rowStart); rowStart = s;
  const c = new Int32Array(rowCap); c.set(rowCount); rowCount = c;
  const x = new Int32Array(rowCap); x.set(rowExt); rowExt = x;
  const ok = new Uint8Array(rowCap); ok.set(rowOK); rowOK = ok;
  const ac = new Int32Array(rowCap); ac.set(absChar); absChar = ac;
  const at = new Int32Array(rowCap); at.set(absTok); absTok = at;
}
function growKids(n) {
  while (kidN + n > kidCap) kidCap *= 2;
  const k = new Int32Array(kidCap); k.set(kids.subarray(0, kidN)); kids = k;
  const r = new Int32Array(kidCap); r.set(kidRel.subarray(0, kidN)); kidRel = r;
  const t = new Int32Array(kidCap); t.set(kidTokRel.subarray(0, kidN)); kidTokRel = t;
}
function scPush(e) {
  if (scn === scCap) { scCap *= 2; const s = new Int32Array(scCap); s.set(sc); sc = s; }
  sc[scn++] = e;
}
function entryOff(e) { return e >= 0 ? absChar[e] : tkOff[(~e) >>> 2]; }
function entryEnd(e) { return e >= 0 ? absChar[e] + rowLen[e] : tkEnd[(~e) >>> 2]; }
function entryTok(e) { return e >= 0 ? absTok[e] : (~e) >>> 2; }
function entryTokEnd(e) { return e >= 0 ? absTok[e] + rowTokLen[e] : ((~e) >>> 2) + 1; }
// Complete a node whose children are scratch[mark..scn): copy them into kids, write
// the row, truncate scratch, return the id. Empty children = a zero-width node
// at the current token (the old offset() rule).
function finishNode(rid, mark) {
  const n = scn - mark;
  if (nodeN === rowCap) growRows();
  const id = nodeN++;
  let myOff, myEnd, myTok, myTokEnd;
  if (n > 0) {
    if (kidN + n > kidCap) growKids(n);
    const ks = kidN;
    myOff = entryOff(sc[mark]);
    myEnd = entryEnd(sc[scn - 1]);
    myTok = entryTok(sc[mark]);
    myTokEnd = entryTokEnd(sc[scn - 1]);
    // GREEN conversion: scratch entries carry ABSOLUTE coordinates; the kids span is
    // written position-independent — a leaf becomes node-relative-token-encoded, a
    // child node gets its rel fields written here (its own row knows only lengths).
    for (let i = 0; i < n; i++) {
      const e = sc[mark + i];
      if (e < 0) {
        kids[ks + i] = ~(((((~e) >>> 2) - myTok) << 2) | ((~e) & 3));
      } else {
        kids[ks + i] = e;
        kidRel[ks + i] = absChar[e] - myOff;
        kidTokRel[ks + i] = absTok[e] - myTok;
      }
    }
    kidN += n;
    rowStart[id] = ks;
  } else {
    rowStart[id] = kidN;
    myOff = offset(); myEnd = myOff;
    myTok = pos; myTokEnd = pos;
  }
  rowRule[id] = rid; rowLen[id] = myEnd - myOff; rowCount[id] = n;
  rowTokLen[id] = myTokEnd - myTok;
  rowExt[id] = maxPos - myTok;
  rowOK[id] = 0;
  absChar[id] = myOff; absTok[id] = myTok;
  scn = mark;
  return id;
}
// Complete a LED/continuation wrap: children = [lhs, ...scratch[mark..scn)].
function finishWrap(rid, lhsId, mark) {
  const n = scn - mark;
  if (nodeN === rowCap) growRows();
  const id = nodeN++;
  if (kidN + n + 1 > kidCap) growKids(n + 1);
  const ks = kidN;
  const myOff = absChar[lhsId];
  const myTok = absTok[lhsId];
  const myEnd = n > 0 ? entryEnd(sc[scn - 1]) : myOff + rowLen[lhsId];
  const myTokEnd = n > 0 ? entryTokEnd(sc[scn - 1]) : myTok + rowTokLen[lhsId];
  kids[ks] = lhsId;
  kidRel[ks] = 0;
  kidTokRel[ks] = 0;
  for (let i = 0; i < n; i++) {
    const e = sc[mark + i];
    if (e < 0) {
      kids[ks + 1 + i] = ~(((((~e) >>> 2) - myTok) << 2) | ((~e) & 3));
    } else {
      kids[ks + 1 + i] = e;
      kidRel[ks + 1 + i] = absChar[e] - myOff;
      kidTokRel[ks + 1 + i] = absTok[e] - myTok;
    }
  }
  kidN += n + 1;
  rowRule[id] = rid; rowLen[id] = myEnd - myOff;
  rowStart[id] = ks; rowCount[id] = n + 1;
  rowTokLen[id] = myTokEnd - myTok;
  rowExt[id] = maxPos - myTok;
  rowOK[id] = 0;
  absChar[id] = myOff; absTok[id] = myTok;
  scn = mark;
  return id;
}

// ── per-parse state (module-level closures, reset by parse()) ──
let pos = 0;
let maxPos = 0;
let memoNode = [];
let memoEnd = [];
let memoExt = [];   // per-entry lookahead extent (see parseRuleEntry)
let parseLimit = -1;
// cap = the exclusive lookahead bound: min(parseLimit-or-∞, tokN), maintained at the
// parseLimit set/restore sites and the one token-stream mutation (the '>' splice).
let cap = 0;
let currentPrattContext = null;
let suppressNext = null;
let suppressCur = null;

function offset() {
  if (pos < cap) return tkOff[pos];
  return tokN > 0 ? tkEnd[tokN - 1] : 0;
}

// ── Lever 1: integer-kind matchers ──
// All matchers PUSH their leaf entry onto the scratch stack and return a boolean
// (the arena protocol) — leaves cost no allocation, only an int.
// Keyword literal: the interpreter required tok.type !== '' && tokenNames.has(tok.type)
// && tok.text === value. With interned kinds that is tok.k >= K_NAMED_MIN (a declared
// token name; '' is PUNCT, templates are below NAMED_MIN) && tok.t === KW(value).
function matchKwLit(kw) {
  // A kw-range t can only come from a named token (template spans never intern to a
  // keyword), so the old k >= K_NAMED_MIN guard was redundant — one int compare.
  if (pos >= cap || tkT[pos] !== kw) return false;
  scPush(~((pos << 2) | 1));
  if (++pos > maxPos) maxPos = pos;
  return true;
}
// Punct literal: tok.type === '' && tok.text === value, with the gt-splice fallback.
// tok.t === PU(value) is the exact-text fast path; the splice handles a longer
// gt-led token matching the gt key. value/pu are baked by the caller.
function matchPuLit(pu) {
  // A pu-range t can only come from a punct token, so the old k === K_PUNCT guard was
  // redundant — one int compare. The '>'-split lives only in matchPuLitGT ('>' sites).
  if (pos >= cap || tkT[pos] !== pu) return false;
  scPush(~(pos << 2));
  if (++pos > maxPos) maxPos = pos;
  return true;
}
function matchPuLitGT(pu) {
  if (pos >= cap) return false;
  const off = tkOff[pos];
  if (tkT[pos] === pu) {
    scPush(~(pos << 2));
    if (++pos > maxPos) maxPos = pos;
    return true;
  }
  // Split multi-'>' tokens: '>>', '>>>', '>>=', '>>>=' can yield a single '>': shift the
  // columns up one slot and write the '>' + rest pair in place (both born flag-less,
  // matching the old mkPunct pair).
  if (tkK[pos] === K_PUNCT && tkEnd[pos] - off > 1 && ${e.soa ? 'src.charCodeAt(off) === 62' : "tkText[pos].charCodeAt(0) === 62"}) {
    const end0 = tkEnd[pos];
    ${e.soa ? '' : 'const restText = tkText[pos].slice(1);'}
    if (tokN === tkCap) growTok();
    tkK.copyWithin(pos + 1, pos, tokN);
    tkT.copyWithin(pos + 1, pos, tokN);
    tkOff.copyWithin(pos + 1, pos, tokN);
    tkEnd.copyWithin(pos + 1, pos, tokN);
    tkDp.copyWithin(pos + 1, pos, tokN);
    tkPd.copyWithin(pos + 1, pos, tokN);
    tkFl.copyWithin(pos + 1, pos, tokN);
    ${e.soa ? '' : "tkText.splice(pos, 1, '>', restText);"}
    tkT[pos] = pu; tkEnd[pos] = off + 1; tkFl[pos] = 0;
    tkOff[pos + 1] = off + 1; tkFl[pos + 1] = 0;
    tkT[pos + 1] = ${e.soa ? 'LIT_PU.get(src.slice(off + 1, end0)) ?? 0' : 'LIT_PU.get(restText) ?? 0'};
    tokN++;
    if (parseLimit < 0) cap = tokN;
    // Token indices shifted: drop the per-rule memo arrays (recreated lazily at the new size).
    memoNode.fill(undefined);
    memoEnd.fill(undefined);
    memoExt.fill(undefined);
    // GREEN tree: no kids/scratch fixup — every completed row and scratch entry lies
    // wholly BEFORE the splice point (token pos is being consumed right now), and the
    // carried memo was just cleared, so nothing reachable references shifted indices.
    scPush(~(pos << 2));
    if (++pos > maxPos) maxPos = pos;
    return true;
  }
  return false;
}
// Generic matchLiteral kept for any unspecialized site: classify value via the baked
// tables (no per-call isKeywordLiteral / string compares) and delegate.
function matchLiteral(value) {
  const kw = LIT_KW.get(value);
  if (kw !== undefined) return matchKwLit(kw);
  if (value === '>') return matchPuLitGT(LIT_PU.get(value) ?? 0);
  return matchPuLit(LIT_PU.get(value) ?? 0);
}

// Match a token ref by its baked TYPE kind: tok.type === name  ⟺  tok.k === nameKind.
// (No named-token kind equals K_NAMED_FALLBACK, so an unforeseen type never matches.)
// The materialized tokenType is type-derived (kind 0) — name needs no baking here.
function matchTokK(nameKind) {
  if (pos >= cap || tkK[pos] !== nameKind) return false;
  scPush(~(pos << 2));
  if (++pos > maxPos) maxPos = pos;
  return true;
}

// (First-token / FIRST-set gating is baked at emit time: per-set _qN byte-table fns
// for rule/alt guards, and open-coded two-table loads for the LED dispatch — see
// membershipFn / ftCond in the emitter.)
function parseTemplateExpr() {
  if (pos >= cap) return false;
  const k = tkK[pos];
  if (k === K_TPL_TOKEN) {
    scPush(~(pos << 2));
    if (++pos > maxPos) maxPos = pos;
    return true;
  }
  if (k === K_TEMPLATE_HEAD) {
    const mark = scn;
    scPush(~(pos << 2));
    if (++pos > maxPos) maxPos = pos;
    const interpRule = currentPrattContext ?? EXPR_RULE;
    while (true) {
      RULES[interpRule]();
      if (pos >= cap) break;
      const nk = tkK[pos];
      if (nk === K_TEMPLATE_MIDDLE) {
        scPush(~(pos << 2));
        if (++pos > maxPos) maxPos = pos;
        continue;
      }
      if (nk === K_TEMPLATE_TAIL) {
        scPush(~(pos << 2));
        if (++pos > maxPos) maxPos = pos;
        break;
      }
      break;
    }
    scPush(finishNode(RID_TEMPLATE, mark));
    return true;
  }
  return false;
}
`);
}

// Emit the per-rule parse functions + the RULES dispatch table.
function emitRuleFns(e: Emitter, a: ReturnType<typeof analyze>) {
  const ruleFn = (name: string) => `R_${sanitize(name)}`;
  // SPINE rules — the entry rule's repetition units (the rules its body references
  // directly): the natural reuse granularity for incremental re-parsing, so they get
  // memoized through parseRuleEntry like pratt/left-rec rules. Without this only
  // expression/type subtrees reuse and every statement re-walks on each edit.
  // Derived from the grammar shape — no language names.
  const spine = new Set<string>();
  {
    const entryRule = a.grammar.rules[a.grammar.rules.length - 1];
    const walk = (x: RuleExpr): void => {
      switch (x.type) {
        case 'ref': if (a.ruleByName.has(x.name)) spine.add(x.name); return;
        case 'seq': case 'alt': x.items.forEach(walk); return;
        case 'quantifier': case 'group': walk(x.body); return;
        case 'sep': walk(x.element); return;
        default: return;
      }
    };
    walk(entryRule.body);
    spine.delete(entryRule.name);
  }
  for (const rule of a.grammar.rules) {
    if (a.prattRules.has(rule.name)) emitPrattRule(e, a, rule);
    else if (a.leftRecSet.has(rule.name)) emitLeftRecRule(e, a, rule);
    else emitNonRecRule(e, a, rule, spine.has(rule.name) && !a.prattRules.has(rule.name) && !a.leftRecSet.has(rule.name));
  }
  // Dispatch table (string rule name → fn), for parseTemplateExpr's dynamic interp rule.
  e.emit(`const RULES = {`);
  for (const rule of a.grammar.rules) e.emit(`  ${J(rule.name)}: ${ruleFn(rule.name)},`);
  e.emit(`};`);
}

// Non-recursive rule: longest-match over alts (mirrors parseNonRec). A better arm is
// committed to the arena IMMEDIATELY (finishNode also truncates scratch back to mark);
// a not-better arm's children are dropped by the next arm's scn reset (a beaten
// committed candidate stays as an arena hole — the measured 3-5% discard class).
function emitNonRecRule(e: Emitter, a: ReturnType<typeof analyze>, rule: RuleDecl, memoized = false) {
  const ruleFn = `R_${sanitize(rule.name)}`;
  const rid = a.grammar.rules.indexOf(rule);
  const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
  // A memoized (spine) rule splits into the public wrapper (parseRuleEntry owns the
  // push+boolean contract and the memo) and an id-returning core, exactly like the
  // pratt/left-rec rules.
  if (memoized) {
    e.emit(`function ${ruleFn}() { return parseRuleEntry(${e.memoIndex(rule.name)}, ${rid}, ${J(rule.name)}, ${ruleFn}_core); }`);
    e.emit(`function ${ruleFn}_core(_minBp) {`);
  } else {
    e.emit(`function ${ruleFn}() {`);
  }
  e.emit(`  const saved = pos; const mark = scn;`);
  e.emit(`  let bestId = -1; let bestPos = saved;`);
  const dispatch = e.altMaskDispatch(alts, '_am');
  if (dispatch) e.emit(`  ${dispatch.maskInit}`);
  alts.forEach((alt, i) => {
    e.emit(`  // alt ${i}`);
    e.emit(`  if (${dispatch ? dispatch.bit(i) : e.altGuard(alt)}) {`);
    e.emit(`    pos = saved; scn = mark;`);
    e.emit(`    if (arm_${sanitize(rule.name)}_${i}() && pos > bestPos) {`);
    e.emit(`      bestId = finishNode(${rid}, mark);`);
    e.emit(`      bestPos = pos;`);
    e.emit(`    }`);
    e.emit(`  }`);
  });
  if (memoized) {
    e.emit(`  if (bestId >= 0) { pos = bestPos; scn = mark; return bestId; }`);
    e.emit(`  pos = saved; scn = mark; return -1;`);
  } else {
    e.emit(`  if (bestId >= 0) { pos = bestPos; scn = mark; scPush(bestId); return true; }`);
    e.emit(`  pos = saved; scn = mark; return false;`);
  }
  e.emit(`}`);
  // Arm matchers.
  alts.forEach((alt, i) => emitArm(e, a, rule.name, i, alt));
}

// Left-recursive (non-Pratt) rule: atom then continuations (mirrors parseLeftRec).
function emitLeftRecRule(e: Emitter, a: ReturnType<typeof analyze>, rule: RuleDecl) {
  const ruleFn = `R_${sanitize(rule.name)}`;
  const { atoms, continuations } = a.leftRecClassified.get(rule.name)!;
  const contMix = a.contMeta.get(rule.name)!;
  // A left-rec rule, like a Pratt rule, goes through parseRule's memo + context +
  // suppress wrapper in the interpreter — so currentPrattContext is set to this rule
  // (the template-interpolation rule resolution depends on it: a `${…}` hole inside a
  // template-literal TYPE must parse as Type, not the default expression rule).
  const rid = a.grammar.rules.indexOf(rule);
  e.emit(`function ${ruleFn}() { return parseRuleEntry(${e.memoIndex(rule.name)}, ${rid}, ${J(rule.name)}, ${ruleFn}_lr); }`);
  e.emit(`function ${ruleFn}_lr(_minBp) {`);
  e.emit(`  const saved = pos; const mark = scn;`);
  e.emit(`  let node = -1; let bestAtomPos = saved;`);
  const atomDispatch = e.altMaskDispatch(atoms, '_am');
  if (atomDispatch) e.emit(`  ${atomDispatch.maskInit}`);
  atoms.forEach((atom, i) => {
    e.emit(`  if (${atomDispatch ? atomDispatch.bit(i) : e.altGuard(atom)}) {`);
    e.emit(`    pos = saved; scn = mark;`);
    e.emit(`    if (atom_${sanitize(rule.name)}_${i}() && pos > bestAtomPos) {`);
    e.emit(`      node = finishNode(${rid}, mark);`);
    e.emit(`      bestAtomPos = pos;`);
    e.emit(`    }`);
    e.emit(`  }`);
  });
  e.emit(`  scn = mark;`);
  e.emit(`  if (node < 0) { pos = saved; return -1; }`);
  e.emit(`  pos = bestAtomPos;`);
  e.emit(`  outer: while (true) {`);
  e.emit(`    const contSaved = pos; const contMark = scn;`);
  continuations.forEach((cont, i) => {
    e.emit(`    pos = contSaved; scn = contMark;`);
    e.emit(`    { let ok = cont_${sanitize(rule.name)}_${i}();`);
    if (contMix[i]) {
      e.emit(`      if (!ok) { pos = contSaved; scn = contMark; ok = matchMixfixLed_${sanitize(rule.name)}_cont_${i}(); }`);
    }
    e.emit(`      if (ok) {`);
    e.emit(`        node = finishWrap(${rid}, node, contMark);`);
    e.emit(`        continue outer;`);
    e.emit(`      } }`);
  });
  e.emit(`    pos = contSaved; scn = contMark; break;`);
  e.emit(`  }`);
  e.emit(`  return node;`);
  e.emit(`}`);
  // Atom + continuation matchers.
  atoms.forEach((atom, i) => emitArmNamed(e, a, `atom_${sanitize(rule.name)}_${i}`, atom));
  continuations.forEach((cont, i) => {
    emitArmNamed(e, a, `cont_${sanitize(rule.name)}_${i}`, { type: 'seq', items: cont } as RuleExpr);
    if (contMix[i]) emitMixfixLed(e, a, `matchMixfixLed_${sanitize(rule.name)}_cont_${i}`, rule.name, cont, contMix[i]!);
  });
}

// Pratt rule (mirrors parsePratt). minBp is a parameter; the NUD/LED arms are
// specialized functions; the control loop is copied verbatim.
function emitPrattRule(e: Emitter, a: ReturnType<typeof analyze>, rule: RuleDecl) {
  const ruleFn = `R_${sanitize(rule.name)}`;
  const sn = sanitize(rule.name);
  const { nuds, leds } = a.prattClassified.get(rule.name)!;
  const meta = a.ledMeta.get(rule.name)!;

  // R_<rule>() wraps parseRule's memo/context handling, then calls the bp-taking core.
  const rid = a.grammar.rules.indexOf(rule);
  e.emit(`function ${ruleFn}() { return parseRuleEntry(${e.memoIndex(rule.name)}, ${rid}, ${J(rule.name)}, ${ruleFn}_pratt); }`);
  e.emit(`function ${ruleFn}_pratt(minBp) {`);
  e.emit(`  const saved = pos; const mark = scn;`);
  e.emit(`  let lhs = -1; let bestNudPos = saved;`);
  // NUD loop.
  const nudDispatch = e.altMaskDispatch(nuds, '_am');
  if (nudDispatch) e.emit(`  ${nudDispatch.maskInit}`);
  nuds.forEach((nud, i) => {
    const items = nud.type === 'seq' ? nud.items : [nud];
    e.emit(`  // nud ${i}`);
    e.emit(`  if (${nudDispatch ? nudDispatch.bit(i) : e.altGuard(nud)}) {`);
    e.emit(`    pos = saved; scn = mark;`);
    if (items[0]?.type === 'prefix') {
      // prefix $ pattern: identical to parsePratt's prefix branch.
      e.emit(`    if (pos < cap) {`);
      e.emit(`      const info = PREFIX_BY_T[tkT[pos]];`);
      e.emit(`      if (info) {`);
      e.emit(`        scPush(~((pos << 2) | 2));`);
      e.emit(`        if (++pos > maxPos) maxPos = pos;`);
      e.emit(`        const rhs = ${ruleFn}_pratt(info.rbp);`);
      e.emit(`        if (rhs >= 0 && pos > bestNudPos) { scPush(rhs); lhs = finishNode(${rid}, mark); bestNudPos = pos; }`);
      e.emit(`      }`);
      e.emit(`    }`);
    } else {
      e.emit(`    if (nud_${sn}_${i}() && pos > bestNudPos) {`);
      e.emit(`      lhs = finishNode(${rid}, mark);`);
      e.emit(`      bestNudPos = pos;`);
      e.emit(`    }`);
    }
    e.emit(`  }`);
  });
  e.emit(`  scn = mark;`);
  e.emit(`  if (lhs < 0) { pos = saved; return -1; }`);
  e.emit(`  pos = bestNudPos;`);
  e.emit(`  let tailClosed = false;`);
  e.emit(`  while (true) {`);
  e.emit(`    if (pos >= cap) break;`);
  e.emit(`    const ledSaved = pos; const ledMark = scn;`);
  e.emit(`    let matched = false;`);
  // Non-op LED loop. The shared `maxBp > minBp` is hoisted out of the per-led conds,
  // and the per-led first-token gates collapse into one bitmask pair of loads.
  const realLeds = leds.map((led, i) => ({ led, i }))
    .filter(({ led }) => led.items[0]?.type !== 'op' && led.items[0]?.type !== 'postfix');
  if (realLeds.length > 0) {
    const ledMask = e.ftMaskDispatch(realLeds.map(({ i }) => meta.first[i]), '_lm', 'pos');
    e.emit(`    if (maxBp > minBp) {`);
    if (ledMask) e.emit(`    ${ledMask.maskInit}`);
    realLeds.forEach(({ led, i }, j) => {
      const conds: string[] = [];
      if (meta.accessTail[i]) conds.push(`!(tailClosed)`);
      // Precedence gate for alternative-form LEDs (see LedPrec): without it they bind
      // maximally tight (`a == b ? c : d` mis-grouped as `a == (b ? c : d)`).
      if (meta.prec[i]) conds.push(`${meta.prec[i]!.lbp} > minBp`);
      // suppress: skip a LED whose first literal connector is in suppressCur.
      const firstLit = (led.items[0]?.type === 'literal') ? led.items[0].value : null;
      if (firstLit !== null) conds.push(`!(suppressCur && suppressCur.has(${J(firstLit)}))`);
      if (ledMask) conds.push(ledMask.bit(j));
      else {
        const ftc = e.ftCond(meta.first[i], 'pos');   // pos < cap here (the loop breaks above)
        if (ftc) conds.push(ftc);
      }
      e.emit(`    // led ${i}`);
      e.emit(`    if (${['!matched', ...conds].join(' && ')}) {`);
      e.emit(`      pos = ledSaved; scn = ledMark;`);
      e.emit(`      let ok = led_${sn}_${i}();`);
      if (meta.mixfix[i]) {
        e.emit(`      if (!ok) { pos = ledSaved; scn = ledMark; ok = matchMixfixLed_${sn}_led_${i}(); }`);
      }
      e.emit(`      if (ok) {`);
      e.emit(`        lhs = finishWrap(${rid}, lhs, ledMark);`);
      if (meta.tailClosing[i]) e.emit(`        tailClosed = true;`);
      e.emit(`        matched = true;`);
      e.emit(`      }`);
      e.emit(`    }`);
    });
    e.emit(`    }`);
  }
  e.emit(`    if (matched) continue;`);
  // Operator LED ($ op $ / postfix), copied verbatim. The no-unary-LHS check is a byte
  // table over t (a token's text equals an op value iff its t-int matches — vocabulary).
  // The lhs head probe reads the arena row instead of an object's children array.
  e.emit(`    const info = OP_BY_T[tkT[pos]];`);
  e.emit(`    if (info && info.lbp > minBp) {`);
  e.emit(`      if (info.position === 'postfix') {`);
  e.emit(`        if (!tailClosed) {`);
  e.emit(`          scPush(~((pos << 2) | 2));`);
  e.emit(`          if (++pos > maxPos) maxPos = pos;`);
  e.emit(`          lhs = finishWrap(${rid}, lhs, ledMark);`);
  e.emit(`          tailClosed = true; matched = true;`);
  e.emit(`        }`);
  e.emit(`      } else {`);
  e.emit(`        if (NOUNARY_T[tkT[pos]] !== 0 && rowCount[lhs] > 0) {`);
  e.emit(`          const _h = kids[rowStart[lhs]];`);
  e.emit(`          if (_h < 0 && ((~_h) & 3) === 2) {`);
  e.emit(`            const _ht = absTok[lhs] + ((~_h) >>> 2);`);
  e.emit(`            const _htext = ${e.soa ? 'src.slice(tkOff[_ht], tkEnd[_ht])' : 'tkText[_ht]'};`);
  e.emit(`            if (prefixOps.has(_htext) && !postfixOpValues.has(_htext)) { return -1; }`);
  e.emit(`          }`);
  e.emit(`        }`);
  e.emit(`        scPush(~((pos << 2) | 2));`);
  e.emit(`        if (++pos > maxPos) maxPos = pos;`);
  e.emit(`        const rhs = ${ruleFn}_pratt(info.rbp);`);
  e.emit(`        if (rhs >= 0) { scPush(rhs); lhs = finishWrap(${rid}, lhs, ledMark); matched = true; }`);
  e.emit(`        else { pos = ledSaved; scn = ledMark; }`);
  e.emit(`      }`);
  e.emit(`      if (matched) continue;`);
  e.emit(`    }`);
  e.emit(`    if (!matched) { pos = ledSaved; scn = ledMark; break; }`);
  e.emit(`  }`);
  e.emit(`  return lhs;`);
  e.emit(`}`);

  // NUD arm matchers (skip prefix nuds — handled inline above).
  nuds.forEach((nud, i) => {
    const items = nud.type === 'seq' ? nud.items : [nud];
    if (items[0]?.type === 'prefix') return;
    emitArmNamed(e, a, `nud_${sn}_${i}`, nud);
  });
  // LED arm matchers (skip operator leds).
  leds.forEach((led, i) => {
    if (led.items[0]?.type === 'op' || led.items[0]?.type === 'postfix') return;
    const lp = meta.prec[i];
    if (lp && lp.rhsBp !== null) {
      // Chain-rhs led ('in'/'instanceof'): trailing self-operand at the level's bp
      // (left-chaining like a ladder op's rhs), bypassing the bp-0 rule entry.
      e.emit(`function led_${sn}_${i}() {`);
      e.emit(`  const _save = pos; const _sn = scn;`);
      e.emit(e.matchInto({ type: 'seq', items: led.items.slice(0, -1) } as RuleExpr, 'pos = _save; scn = _sn; return false;'));
      e.emit(`  const _rhs = ${ruleFn}_pratt(${lp.rhsBp});`);
      e.emit(`  if (_rhs < 0) { pos = _save; scn = _sn; return false; }`);
      e.emit(`  scPush(_rhs);`);
      e.emit(`  return true;`);
      e.emit(`}`);
    } else {
      emitArmNamed(e, a, `led_${sn}_${i}`, { type: 'seq', items: led.items } as RuleExpr);
    }
    if (meta.mixfix[i]) emitMixfixLed(e, a, `matchMixfixLed_${sn}_led_${i}`, rule.name, led.items, meta.mixfix[i]!);
  });
}

// Emit `arm_<rule>_<i>()` — a matchExpr(alt) specialization returning children|null.
function emitArm(e: Emitter, a: ReturnType<typeof analyze>, ruleName: string, i: number, alt: RuleExpr) {
  emitArmNamed(e, a, `arm_${sanitize(ruleName)}_${i}`, alt);
}

// Emit a named matcher fn for `expr`: pushes the matched children onto scratch and
// returns a boolean, restoring pos AND scn on failure (the arena matcher contract).
function emitArmNamed(e: Emitter, a: ReturnType<typeof analyze>, fnName: string, expr: RuleExpr) {
  e.emit(`function ${fnName}() {`);
  const single = e.singleLeafBodyPublic(expr);
  if (single) {
    e.emit(single);
  } else {
    e.emit(`  const _save = pos; const _sn = scn;`);
    e.emit(e.matchInto(expr, 'pos = _save; scn = _sn; return false;'));
    e.emit(`  return true;`);
  }
  e.emit(`}`);
}

// Emit a specialized matchMixfixLed for a LED/cont (mirrors the interpreter's
// matchMixfixLed exactly; the rest-matching uses an inlined matchSeq of items[3:]).
function emitMixfixLed(e: Emitter, a: ReturnType<typeof analyze>, fnName: string, ruleName: string, items: RuleExpr[], info: MixfixInfo) {
  const ruleFn = `R_${sanitize(ruleName)}`;
  const restItems = items.slice(3);
  e.emit(`function ${fnName}() {`);
  e.emit(`  const saved = pos; const _sn = scn;`);
  e.emit(`  if (!${e.matchLiteralCall(info.openLit)}) { pos = saved; scn = _sn; return false; }`);
  e.emit(`  const afterOpen = pos; const aoMark = scn;`);
  e.emit(`  if (!${ruleFn}()) { pos = saved; scn = _sn; return false; }`);
  e.emit(`  const greedyEnd = pos;`);
  e.emit(`  if (${e.matchLiteralCall(info.sepLit)}) { pos = saved; scn = _sn; return false; }`);
  const pu = (lit: string) => a.symtab.puLitKind.get(lit) ?? -1;
  // The separator is a literal, so it classifies as kw/punct (both carry t); a
  // token-name key (impossible here) gets the never-matching -1.
  const sepDesc = a.symtab.classifyKey(info.sepLit);
  const sepT = sepDesc.kind === 'tok' ? -1 : sepDesc.t;
  e.emit(`  let depth = 0; const candidates = [];`);
  e.emit(`  for (let i = afterOpen; i < greedyEnd; i++) {`);
  e.emit(`    if (tkK[i] !== K_PUNCT) continue;`);
  e.emit(`    const t = tkT[i];`);
  e.emit(`    if (t === ${pu('(')} || t === ${pu('[')} || t === ${pu('{')}) depth++;`);
  e.emit(`    else if (t === ${pu(')')} || t === ${pu(']')} || t === ${pu('}')}) depth--;`);
  e.emit(`    else if (depth === 0 && t === ${sepT}) candidates.push(i);`);
  e.emit(`  }`);
  e.emit(`  for (const sepIdx of candidates) {`);
  e.emit(`    pos = afterOpen; scn = aoMark;`);
  e.emit(`    const prevLimit = parseLimit; parseLimit = sepIdx; cap = sepIdx;`);
  e.emit(`    const reOperand = ${ruleFn}();`);
  e.emit(`    parseLimit = prevLimit; cap = prevLimit >= 0 ? prevLimit : tokN;`);
  e.emit(`    if (!reOperand || pos !== sepIdx) continue;`);
  e.emit(`    if (!${e.matchLiteralCall(info.sepLit)}) continue;`);
  // rest = matchSeq(items[3:]) — inline (pushes; restores pos/scn on failure).
  e.emit(`    const rest = (function(){ const _save = pos; const _rsn = scn;`);
  e.emit(e.matchInto({ type: 'seq', items: restItems } as RuleExpr, 'pos = _save; scn = _rsn; return false;'));
  e.emit(`      return true; })();`);
  e.emit(`    if (!rest) continue;`);
  e.emit(`    return true;`);
  e.emit(`  }`);
  e.emit(`  pos = saved; scn = _sn; return false;`);
  e.emit(`}`);
}

// Emit parseRuleEntry (memo + context handling for pratt/left-rec rules, mirrors
// parseRule's pratt/left-rec branch) and the parse() driver.
function emitDriver(e: Emitter, a: ReturnType<typeof analyze>, entry: string) {
  e.emit(String.raw`
// parseRule for a pratt/left-rec rule: memo + context + suppress, then the core.
// The memo is per-rule arrays indexed by start pos (lazily sized to the token count,
// undefined-holed): a lookup is two array loads, a store allocates nothing — no Map
// hashing and no {node, end} wrapper per store. The core returns a node ID (or -1);
// this wrapper owns the public arena contract (push the id, return a boolean).
//
// memoExt records each entry's LOOKAHEAD EXTENT — the farthest token index the parse
// may have READ (not merely consumed) — which is what incremental invalidation must
// intersect with an edit's damage window: a PEG parse probes beyond its end (failed
// longer arms, not() lookaheads, SECOND-token dispatch). The extent comes for free
// from the global advance watermark: maxPos at frame exit, +2 covering the stop-token
// and SECOND-token reads past it. Left-to-right parsing keeps the watermark near the
// current frontier, so the value is tight on the dominant flow and only OVER-
// invalidates (soundly) near big-backtrack clusters.
function parseRuleEntry(idx, rid, name, core) {
  const mySup = suppressNext;
  suppressNext = null;
  const capped = parseLimit >= 0;
  const start = pos;
  // Capture the arrays together: a '>'-splice inside core() detaches them via
  // fill(undefined), and the store below must then write into the DETACHED arrays
  // (i.e. be discarded), exactly like the old per-rule Map did.
  let me = memoEnd[idx];
  let mn = memoNode[idx];
  let mx = memoExt[idx];
  if (!mySup && !capped && me !== undefined) {
    const e = me[start];
    if (e !== undefined) {
      pos = e;
      // The jump SEMANTICALLY reads everything the stored parse read: keep the advance
      // watermark ≥ the entry's watermark, or an ENCLOSING rule that completes right
      // after a reused subtree stores a watermark smaller than what its result depends
      // on (including the child's own over-probing failed arms), and a later edit in
      // the gap keeps the stale entry alive. A guaranteed batch no-op: the watermark is
      // monotone and was already ≥ this value when the entry was stored.
      const ex = mx[start];
      if (ex > maxPos) maxPos = ex;
      const id = mn[start];
      if (id >= 0) {
        // refresh the reused root's transient BUILD coordinates to the current stream
        // (its green internals are position-independent; only the attachment point —
        // what the enclosing finishNode reads — must be current).
        absTok[id] = start;
        absChar[id] = tkOff[start];
        scPush(id);
        return true;
      }
      return false;
    }
  }
  if (!mySup && !capped && adoptRoot >= 0) {
    // map the new position into OLD token coordinates; inside the damage = no mapping
    const q = start < adoptDmgStart ? start
      : start >= adoptDmgOldEnd + adoptDelta ? start - adoptDelta : -1;
    if (q >= 0) {
      const aid = adoptSeek(q, rid);
      if (aid >= 0) {
        pos = start + rowTokLen[aid];
        const ext = start + rowExt[aid];
        if (ext > maxPos) maxPos = ext;
        absTok[aid] = start;
        absChar[aid] = tkOff[start];
        if (me === undefined) {
          me = new Array(tokN + 1);
          mn = new Array(tokN + 1);
          mx = new Array(tokN + 1);
          memoEnd[idx] = me;
          memoNode[idx] = mn;
          memoExt[idx] = mx;
        }
        me[start] = pos;
        mn[start] = aid;
        mx[start] = maxPos;
        scPush(aid);
        return true;
      }
    }
  }
  const prevContext = currentPrattContext;
  currentPrattContext = name;
  const prevSup = suppressCur;
  suppressCur = mySup;
  let result;
  try {
    result = core(0);
  } finally {
    currentPrattContext = prevContext;
    suppressCur = prevSup;
  }
  if (!mySup && !capped) {
    if (me === undefined) {
      me = new Array(tokN + 1);
      mn = new Array(tokN + 1);
      mx = new Array(tokN + 1);
      memoEnd[idx] = me;
      memoNode[idx] = mn;
      memoExt[idx] = mx;
    }
    me[start] = pos;
    mn[start] = result;
    mx[start] = maxPos;   // the TRUE probe watermark — the +2 read slack (stop token,
                          // SECOND-token dispatch) is applied at INVALIDATION time
    if (result >= 0) rowOK[result] = 1;

  }
  if (result >= 0) { scPush(result); return true; }
  return false;
}

// Token text at an arbitrary index (cold paths: errors, the tokenAt debug view).
function tokTextAt(i) {
  return ${e.soa ? 'src.slice(tkOff[i], tkEnd[i])' : 'tkText[i]'};
}
// The k → type-name inverse, for reconstructing a token object (tokenAt).
const K_NAMES = [];
for (const [n, k] of TYPE_KIND) K_NAMES[k] = n;
// A per-token object view over the columns (gates / debugging — the parser never builds these).
export function tokenAt(i) {
  return {
    type: K_NAMES[tkK[i]] ?? '',
    text: tokTextAt(i),
    offset: tkOff[i],
    k: tkK[i],
    t: tkT[i],
    newlineBefore: (tkFl[i] & 1) !== 0,
    commentBefore: (tkFl[i] & 2) !== 0,
    multilineFlowBefore: (tkFl[i] & 4) !== 0,
  };
}

// The CST is span-only: a node's text is derived from the source it was parsed from.
export function getText(node, source) {
  return source.slice(node.offset, node.end);
}

// ── Arena tree access ──
// The arena IS the tree: parse() returns the root node id and consumers traverse
// via visit()/the accessors — nothing is materialized on the parse path. All views
// are valid until the NEXT parse (the columns are reused).
function leafTokenType(entry, tokBase) {
  const tok = tokBase + ((~entry) >>> 2);
  const kind = (~entry) & 3;
  return kind === 1 ? '$keyword'
    : kind === 2 ? '$operator'
    : tkK[tok] === K_PUNCT ? '$punct'
    : (K_NAMES[tkK[tok]] ?? '');
}
// Raw arena accessors. An ENTRY is a node id (>= 0) or a leaf (< 0, token-encoded);
// offsetOf/endOf/textOf accept either.
// GREEN accessors: positions are RELATIVE — a node knows (rel, len) against its
// parent and (tokRel, tokLen) in tokens; consumers descend with (charBase, tokBase)
// — the node's own absolute start coordinates. Leaf spans come from the token
// columns at tokBase + the entry's node-relative token index.
export const tree = {
  ruleNameOf: (id) => RULE_NAMES[rowRule[id]],
  ruleIdOf: (id) => rowRule[id],
  lenOf: (id) => rowLen[id],
  tokLenOf: (id) => rowTokLen[id],
  // a node CHILD's relative coordinates live on the parent edge (kids-parallel)
  childRelAt: (id, i) => kidRel[rowStart[id] + i],
  childTokRelAt: (id, i) => kidTokRel[rowStart[id] + i],
  // base-threaded spans: nodes from their bases, leaves from the token columns
  offsetOf: (entry, charBase, tokBase) => entry >= 0 ? charBase : tkOff[tokBase + ((~entry) >>> 2)],
  endOf: (entry, charBase, tokBase) => entry >= 0 ? charBase + rowLen[entry] : tkEnd[tokBase + ((~entry) >>> 2)],
  childCount: (id) => rowCount[id],
  childAt: (id, i) => kids[rowStart[id] + i],
  // Bulk child load into a caller-owned array; returns the count. One call per node
  // instead of childCount+childAt-per-probe (the generated matchers' hot path).
  childrenInto: (id, out2) => {
    const n2 = rowCount[id];
    const cs2 = rowStart[id];
    for (let i2 = 0; i2 < n2; i2++) out2[i2] = kids[cs2 + i2];
    return n2;
  },
  isLeaf: (entry) => entry < 0,
  leafToken: (entry, tokBase) => tokBase + ((~entry) >>> 2),
  leafTokenType,
  // Int-world leaf accessors (the match-path encoding): kind bits — 0 type-derived,
  // 1 '$keyword', 2 '$operator' — and the token's TYPE kind int (1 = punctuation).
  leafKindOf: (entry) => (~entry) & 3,
  leafTokKindOf: (entry, tokBase) => tkK[tokBase + ((~entry) >>> 2)],
  leafOffsetOf: (entry, tokBase) => tkOff[tokBase + ((~entry) >>> 2)],
  leafEndOf: (entry, tokBase) => tkEnd[tokBase + ((~entry) >>> 2)],
  textOf: (entry, source, charBase, tokBase) => entry >= 0
    ? source.slice(charBase, charBase + rowLen[entry])
    : source.slice(tkOff[tokBase + ((~entry) >>> 2)], tkEnd[tokBase + ((~entry) >>> 2)]),
};
// Depth-first traversal from a node id or leaf entry:
//   enter(id)         — each NODE before its children; return false to skip its subtree
//   leave(id)         — each node after its children
//   leaf(entry, tok)  — each leaf (tok = its token index)
// Depth-first traversal threading the RED coordinates: enter/leave receive the
// node's absolute (charBase, tokBase); leaf receives its absolute token index.
// Call with the root only — the bases default from the root's rel fields.
export function visit(entry, fns, charBase, tokBase) {
  if (charBase === undefined) { charBase = rootCharBase; tokBase = rootTokBase; }
  if (entry < 0) { if (fns.leaf) fns.leaf(entry, tokBase + ((~entry) >>> 2)); return; }
  if (fns.enter && fns.enter(entry, charBase, tokBase) === false) return;
  const n = rowCount[entry];
  const cs = rowStart[entry];
  for (let i = 0; i < n; i++) {
    const e = kids[cs + i];
    if (e < 0) { if (fns.leaf) fns.leaf(e, tokBase + ((~e) >>> 2)); }
    else visit(e, fns, charBase + kidRel[cs + i], tokBase + kidTokRel[cs + i]);
  }
  if (fns.leave) fns.leave(entry, charBase, tokBase);
}
// Materialize the classic object CST from a node id — a BRIDGE for tests/debugging
// (the byte-identical gate against the interpreter), not a parse-path product.
export function toObject(id, charBase, tokBase) {
  if (charBase === undefined) { charBase = rootCharBase; tokBase = rootTokBase; }
  const n = rowCount[id];
  const cs = rowStart[id];
  const children = new Array(n);
  for (let i = 0; i < n; i++) {
    const entry = kids[cs + i];
    children[i] = entry >= 0 ? toObject(entry, charBase + kidRel[cs + i], tokBase + kidTokRel[cs + i])
      : { tokenType: leafTokenType(entry, tokBase), offset: tkOff[tokBase + ((~entry) >>> 2)], end: tkEnd[tokBase + ((~entry) >>> 2)] };
  }
  return { rule: RULE_NAMES[rowRule[id]], children, offset: charBase, end: charBase + rowLen[id] };
}

// Parse to the ARENA: returns the root node id.
function lexInto(source) {
${e.soa ? `  tokenize(source);` : String.raw`  src = source;
  const _toks = tokenize(source);
  const _n = _toks.length;
  while (tkCap < _n + 1) growTok();
  tkText.length = 0;
  for (let _i = 0; _i < _n; _i++) {
    const _t = _toks[_i];
    tkK[_i] = _t.k; tkT[_i] = _t.t; tkOff[_i] = _t.offset; tkEnd[_i] = _t.offset + _t.text.length;
    tkFl[_i] = (_t.newlineBefore ? 1 : 0) | (_t.commentBefore ? 2 : 0) | (_t.multilineFlowBefore ? 4 : 0);
    tkDp[_i] = 0; tkPd[_i] = 0;
    tkText[_i] = _t.text;
  }
  tokN = _n;`}
}

function farthest(errPos) {
  if (maxPos <= errPos || maxPos >= tokN) return '';
  return ' [farthest: offset ' + tkOff[maxPos] + " near '" + tokTextAt(maxPos).slice(0, 20) + "']";
}

// Run the entry rule over the CURRENT token stream (shared by parse / parseEdited —
// everything per-parse EXCEPT the memo and the arena cursor, which parseEdited carries).
function runParse(entryRule) {
  pos = 0;
  maxPos = 0;
  parseLimit = -1;
  cap = tokN;
  currentPrattContext = null;
  suppressNext = null;
  suppressCur = null;
  scn = 0;
  const entry = entryRule ?? ENTRY;
  if (tokN === 0) {
    const rid = RULE_NAMES.indexOf(entry);
    const er = finishNode(rid < 0 ? 0 : rid, scn);
    rootCharBase = absChar[er]; rootTokBase = absTok[er];
    return er;
  }
  if (!RULES[entry]()) {
    const hasTok = pos < cap;
    throw new Error('Parse error at offset ' + (hasTok ? tkOff[pos] : 0) + ': unexpected ' + (hasTok ? "'" + tokTextAt(pos) + "'" : 'end of input') + farthest(pos));
  }
  if (pos < tokN) {
    throw new Error('Parse error at offset ' + tkOff[pos] + ": unexpected '" + tokTextAt(pos) + "' after successful parse" + farthest(pos));
  }
  const rootId = sc[--scn];
  rootCharBase = absChar[rootId]; rootTokBase = absTok[rootId];
  return rootId;
}

// Source of the last COMPLETED parse — the token columns, arena and memo describe it.
// null whenever the module state is not a coherent snapshot (no parse yet, or the last
// attempt threw), so parseEdited falls back to a full parse.
let lastSrc = null;
// the LAST parse root's absolute coordinates (the descent origin — see visit/toObject)
let rootCharBase = 0;
let rootTokBase = 0;

// ── M4: old-tree ADOPTION (cursor reuse) ──
// During an incremental re-parse, a rule entry first asks the PREVIOUS tree: is there
// an old node of this rule starting at the corresponding old position whose lookahead
// stayed clear of the damage? Adoption is STATELESS — nothing is consumed, so PEG
// backtracking needs no cursor rollback, and a node refused under one candidate arm
// can be adopted by the next. The memo stays purely intra-parse.
let lastRoot = -1;           // previous parse's root id + its absolute first token
let lastRootTok = 0;
let adoptRoot = -1;          // previous root id (-1 = no adoption)
let adoptRootTok = 0;        // its absolute first token (old coords)
let adoptDmgStart = 0;       // damage window in OLD token coords: [adoptDmgStart, adoptDmgOldEnd)
let adoptDmgOldEnd = 0;
let adoptDelta = 0;          // new-minus-old token delta past the damage
// cached descent path (top-down): ids + their absolute old token bases
let adoptPath = [];
let adoptBase = [];
function adoptSeek(q, rid) {
  // reuse the cached path while it still CONTAINS q (strictly inside, not at start)
  let depth = 0;
  while (depth < adoptPath.length) {
    const id = adoptPath[depth];
    const b = adoptBase[depth];
    if (b < q && q < b + rowTokLen[id]) depth++;
    else break;
  }
  adoptPath.length = depth;
  adoptBase.length = depth;
  let id, base;
  if (depth === 0) {
    if (q < adoptRootTok || q >= adoptRootTok + rowTokLen[adoptRoot]) return -1;
    id = adoptRoot; base = adoptRootTok;
    if (base === q) { /* root itself starts at q — fall through to the chain walk */ }
    adoptPath.push(id); adoptBase.push(base);
  } else {
    id = adoptPath[depth - 1]; base = adoptBase[depth - 1];
  }
  // descend: containment steps are committed to the cache; the exploratory chain of
  // nodes starting EXACTLY at q is walked in locals (a later seek with another rule
  // must see the same chain).
  for (;;) {
    // binary search the first child whose END exceeds q
    const cs = rowStart[id];
    const n = rowCount[id];
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const e = kids[cs + mid];
      const end = e < 0 ? base + ((~e) >>> 2) + 1 : base + kidTokRel[cs + mid] + rowTokLen[e];
      if (end <= q) lo = mid + 1; else hi = mid;
    }
    if (lo >= n) return -1;
    const e = kids[cs + lo];
    if (e < 0) return -1;                                  // the position is a leaf here
    const cb = base + kidTokRel[cs + lo];
    if (cb > q) return -1;                                 // a gap — nothing starts at q
    if (cb === q) {
      // the exploratory chain: every node from here down whose start is exactly q
      let xid = e, xb = cb;
      for (;;) {
        if (rowOK[xid] !== 0 && rowRule[xid] === rid
            && (q + rowExt[xid] + 2 <= adoptDmgStart || q >= adoptDmgOldEnd)) {
          return xid;
        }
        const xcs = rowStart[xid];
        if (rowCount[xid] === 0) return -1;
        const fe = kids[xcs];
        if (fe < 0 || kidTokRel[xcs] !== 0) return -1;
        xid = fe; xb = xb;
      }
    }
    // containment: commit and descend
    id = e; base = cb;
    adoptPath.push(id); adoptBase.push(base);
  }
}
// The spare token-column buffer set (parseEdited ping-pongs between the live set and
// this one, so steady-state edits never allocate columns).
let altK = null, altT = null, altOff = null, altEnd = null, altFl = null, altDp = null, altPd = null;
let altCap = 0;
let altN = 0;   // old-stream token count while a window lex runs (lexCore's resync bound)
function swapBuffers() {
  let x;
  x = tkK; tkK = altK; altK = x;
  x = tkT; tkT = altT; altT = x;
  x = tkOff; tkOff = altOff; altOff = x;
  x = tkEnd; tkEnd = altEnd; altEnd = x;
  x = tkFl; tkFl = altFl; altFl = x;
  x = tkDp; tkDp = altDp; altDp = x;
  x = tkPd; tkPd = altPd; altPd = x;
  x = tkCap; tkCap = altCap; altCap = x;
}
${e.soa ? '' : 'let altText = [];'}

export function parse(source, entryRule) {
  lastSrc = null;
  adoptRoot = -1;
  lexInto(source);
  memoNode = new Array(MEMO_RULES);
  memoEnd = new Array(MEMO_RULES);
  memoExt = new Array(MEMO_RULES);
  nodeN = 0;
  kidN = 0;
  const root = runParse(entryRule);
  lastRoot = root;
  lastRootTok = rootTokBase;
  lastSrc = source;
  return root;
}

// ── Incremental re-parse ──
// No edit protocol: the caller hands the NEW source; the damage window is DERIVED by
// diffing the old and new token columns (longest identical prefix; longest suffix
// identical modulo the character delta). Reuse then flows through the carried memo:
//   - prefix entries survive when their lookahead extent never reached the damage;
//   - suffix entries survive shifted by the token delta (their reads are wholly inside
//     the suffix, which is identical modulo position);
//   - damaged-region entries are dropped and re-parsed.
// The old arena is re-based in place (rows starting at/after the suffix shift by the
// char delta; reused leaf entries by the token delta; rows STARTING inside the damage
// are unreachable garbage — their values no longer matter), and new rows append after
// the old ones. A full parse() compacts (resets the arena); long edit sessions grow
// until then. Lexing is FULL-FILE by design: the lexer carries cross-token state
// (template nesting, regex context, markup modes), full lexing is a small share of a
// parse, and the diff is what localizes the damage — not the lexer.
export function parseEdited(source, entryRule) {
  if (lastSrc === null) return parse(source, entryRule);
  const oSrc = lastSrc;
  lastSrc = null;
${e.soa ? String.raw`  // ── M1: WINDOWED re-lex ──
  // Char-level envelope (cheapest possible without an edit protocol).
  const oldLen = oSrc.length, newLen = source.length;
  const minL = oldLen < newLen ? oldLen : newLen;
  let cs = 0;
  while (cs < minL && oSrc.charCodeAt(cs) === source.charCodeAt(cs)) cs++;
  let ce = 0;
  while (ce < minL - cs && oSrc.charCodeAt(oldLen - 1 - ce) === source.charCodeAt(newLen - 1 - ce)) ce++;
  const ceOld = oldLen - ce, ceNew = newLen - ce;
  const charDelta = newLen - oldLen;
  // Restart anchor: the last token B ending at/before the damage whose recorded
  // depths are zero and whose shape carries no cross-token lexer flag (')' control-
  // head, postfix-ambiguous op). B = -1 restarts at the file head — always sound.
  const B = findRestart(cs);
  const initParens = B >= 0 ? reconstructParens(B) : [];
  const oN = tokN;
  // first old token at/after the damage end — the resync search floor
  let r0 = oN;
  { let lo = 0, hi = oN;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tkOff[mid] < ceOld) lo = mid + 1; else hi = mid; }
    r0 = lo; }
  // Lex the window into the spare buffers (the old stream stays live for resync).
  if (altK === null || altCap < tkCap) {
    altK = new tkK.constructor(tkCap); altT = new tkT.constructor(tkCap);
    altOff = new Int32Array(tkCap); altEnd = new Int32Array(tkCap); altFl = new Uint8Array(tkCap);
    altDp = new Uint8Array(tkCap); altPd = new Uint16Array(tkCap);
    altCap = tkCap;
  }
  altN = oN;
  swapBuffers();              // live = scratch, alt = OLD stream
  src = source;
  tokN = 0;
  const startOff = B >= 0 ? altEnd[B] : 0;
  const R0 = lexCore(source, startOff, B >= 0 ? altK[B] : -1, B >= 0 ? altT[B] : 0, r0, ceNew, charDelta, cs, initParens);
  const W = tokN;
  const R = R0 >= 0 ? R0 : oN;
  swapBuffers();              // live = OLD stream again; window sits in the alt buffers
  tokN = oN;
  // TRUE token prefix p: the window re-derives [B+1 .. p) byte-identically; only past
  // p is real damage (compared BEFORE the splice clobbers the old slots).
  let p = B + 1;
  { let i = 0;
    while (i < W && p < R && altK[i] === tkK[p] && altT[i] === tkT[p] && altOff[i] === tkOff[p]
        && altEnd[i] === tkEnd[p] && altFl[i] === tkFl[p]) { i++; p++; }
  }
  const dOldEnd = R;
  const tokenDelta = (B + 1 + W) - R;
  // ── splice: old[0..B] + window[0..W) + old[R..oN), then shift the suffix spans ──
  const nN = B + 1 + W + (oN - R);
  while (tkCap < nN + 1) growTok();
  tkK.copyWithin(B + 1 + W, R, oN); tkT.copyWithin(B + 1 + W, R, oN);
  tkOff.copyWithin(B + 1 + W, R, oN); tkEnd.copyWithin(B + 1 + W, R, oN);
  tkFl.copyWithin(B + 1 + W, R, oN); tkDp.copyWithin(B + 1 + W, R, oN); tkPd.copyWithin(B + 1 + W, R, oN);
  if (W > 0) {
    tkK.set(altK.subarray(0, W), B + 1); tkT.set(altT.subarray(0, W), B + 1);
    tkOff.set(altOff.subarray(0, W), B + 1); tkEnd.set(altEnd.subarray(0, W), B + 1);
    tkFl.set(altFl.subarray(0, W), B + 1); tkDp.set(altDp.subarray(0, W), B + 1); tkPd.set(altPd.subarray(0, W), B + 1);
  }
  if (charDelta !== 0) {
    for (let i = B + 1 + W; i < nN; i++) { tkOff[i] += charDelta; tkEnd[i] += charDelta; }
  }
  tokN = nN;
  const nN2 = nN;` : String.raw`  // (fallback-lexer grammars keep the full-relex + token-diff path)
  const oK = tkK, oT = tkT, oOff = tkOff, oEnd = tkEnd, oFl = tkFl, oN = tokN;
  const oText = tkText;
  if (altK === null || altK.length !== tkCap) {
    altK = new tkK.constructor(tkCap); altT = new tkT.constructor(tkCap);
    altOff = new Int32Array(tkCap); altEnd = new Int32Array(tkCap); altFl = new Uint8Array(tkCap);
    altDp = new Uint8Array(tkCap); altPd = new Uint16Array(tkCap);
  }
  tkK = altK; tkT = altT; tkOff = altOff; tkEnd = altEnd; tkFl = altFl;
  { const _d = tkDp; tkDp = altDp; altDp = _d; const _q = tkPd; tkPd = altPd; altPd = _q; }
  tkText = altText; tkText.length = 0;
  altK = oK; altT = oT; altOff = oOff; altEnd = oEnd; altFl = oFl;
  altText = oText;
  lexInto(source);
  const nN = tokN;
  const charDelta = source.length - oSrc.length;
  const minN = oN < nN ? oN : nN;
  let p = 0;
  while (p < minN && oK[p] === tkK[p] && oT[p] === tkT[p] && oFl[p] === tkFl[p]
      && oOff[p] === tkOff[p] && oEnd[p] === tkEnd[p] && oText[p] === tkText[p]) p++;
  let s = 0;
  while (s < minN - p) {
    const i = oN - 1 - s, j = nN - 1 - s;
    if (oK[i] === tkK[j] && oT[i] === tkT[j] && oFl[i] === tkFl[j]
      && oOff[i] + charDelta === tkOff[j] && oEnd[i] + charDelta === tkEnd[j] && oText[i] === tkText[j]) s++;
    else break;
  }
  const dOldEnd = oN - s;
  const tokenDelta = nN - oN;
  const nN2 = nN;`}
  // M4: NO memo carry — the memo is intra-parse; reuse flows through old-tree
  // adoption (parseRuleEntry consults the previous root via adoptSeek), so the whole
  // O(rules × n) carry/invalidate machinery is gone.
  memoNode = new Array(MEMO_RULES);
  memoEnd = new Array(MEMO_RULES);
  memoExt = new Array(MEMO_RULES);
  adoptRoot = lastRoot;
  adoptRootTok = lastRootTok;
  adoptDmgStart = p;
  adoptDmgOldEnd = dOldEnd;
  adoptDelta = tokenDelta;
  adoptPath.length = 0;
  adoptBase.length = 0;
  const root = runParse(entryRule);
  adoptRoot = -1;
  lastRoot = root;
  lastRootTok = rootTokBase;
  lastSrc = source;
  return root;
}

export { tokenize };
export function createParser() { return { parse, parseEdited, tree, visit, toObject, tokenize }; }
`);
}
