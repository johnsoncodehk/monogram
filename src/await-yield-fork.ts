// Build-time grammar transform implementing the ECMAScript [Await]/[Yield] grammar
// parameters by NAME-FORKING the body-reachable rule closure into context families.
// Applied by the interpreter (gen-parser.ts), the jsTarget parser (emit-parser.ts) and the
// cst-match generator. The portable targets (emit-portable.ts) do not fork: they keep no
// incremental row keyed on a rule below the top level, so the context is a word their
// parser holds (see Ctx there).
//
// WHY a fork and not a runtime flag: Monogram's incremental adoption reuses a row iff
// its window (text + bars) replays identically — a row's parse must be a pure function
// of (window text, window bars) GIVEN ITS RULE. async/generator context flows from an
// ENCLOSING function OUTSIDE a row's window, so a runtime context flag read by core()
// but absent from the reuse key breaks that purity (a far `function`->`async function`
// edit, or even node surgery re-parsing a body statement with the ambient flag reset to
// its default, makes edit() diverge from a fresh parse). The fix that costs ZERO new
// reuse machinery: make the context part of the RULE IDENTITY. Every reuse predicate
// already keys on rowRule/rid (adoptSeek, runExtend, surgery's SURG_ELEM/RULE_FN_BY_ID),
// and the memo arrays are name-keyed, so an await-context Block is literally a different
// rule (Block$A) with its own rid and memo slot — a cross-family reuse is structurally
// UNREPRESENTABLE, not merely guarded. The window-replay theorem holds verbatim: the
// rule is part of the frame identity, never out-of-window text.
//
// HOW context boundaries are expressed: the grammar wraps each function/arrow/method/
// class BODY (and an async arm's params) in a context marker — awaitCtx / yieldCtx /
// asyncGenCtx for the operator contexts, resetCtx for the bodies that reset to none
// (a nested non-async function, a class body, a computed key, a field initializer).
// The markers are transparent `group` nodes carrying `ctxMode`; only this transform
// reads them. The fork is driven ENTIRELY by the markers — the reset boundary (open
// question #3) is explicit, not inferred.
//
// Forks collapse to their BASE rule for every DERIVED artifact via RuleDecl.canon: the
// emitted parser keeps the distinct name for memo/adoption identity but reports `canon`
// as the green-node rule name (so trees stay byte-identical to the base grammar), and
// the AST / TM / tree-sitter / cst-match generators skip forks (a fork's structure and
// scope are its base's).
//
// `when` (declared contexts, step 1; kind: transition; end state: one context word in every
// engine; exit: step 2 deletes this file): a family is a context word (ctxWordOfMode), so a
// `when` group's condition is a CONSTANT in each family and is evaluated here, once: where it
// holds the group is its body, where it does not it is NEVER (a match that always fails). A gated
// operator (PrecOperator.when) is shared by every family's Pratt rule, so the parser evaluates it
// against the rule's `ctx` (set here on every rule). The portable IR tests the same word at run
// time (emit-portable.ts); the parity gates hold the two together. When the grammar reads
// `syncFn` (readsSyncFn) a reset body is its own family ($N): it differs from the top level.
import type { CstGrammar, RuleDecl, RuleExpr } from './types.ts';
import { ctxWordOfMode, readsSyncFn, whenTest } from './grammar-utils.ts';

type Family = 'await' | 'yield' | 'asyncgen' | 'none';
const SUFFIX: Record<Family, string> = { await: '$A', yield: '$Y', asyncgen: '$AY', none: '$N' };
const RESERVED: Record<Family, string[]> = { await: ['await'], yield: ['yield'], asyncgen: ['await', 'yield'], none: [] };
/** A match that always fails: `not` of the empty sequence. */
const NEVER: RuleExpr = { type: 'not', body: { type: 'seq', items: [] } };


export function withAwaitYield(grammar: CstGrammar): CstGrammar {
  const byName = new Map(grammar.rules.map(r => [r.name, r]));
  const splitSync = readsSyncFn(grammar);
  // The family a marker routes into (null: the base family, the top level's).
  const familyOf = (mode: 'await' | 'yield' | 'asyncgen' | 'reset'): Family | null => (mode === 'reset' ? (splitSync ? 'none' : null) : mode);
  const wordOf = (fam: Family | null): number => (fam === null ? 0 : ctxWordOfMode(fam === 'none' ? 'reset' : fam, splitSync));

  // ── 1. Per-family closure: which rules need an $F clone. A rule S is in closure[F]
  // if it is reachable, via in-family refs, from a subtree marked mode F — where a
  // nested marker of mode M re-roots the walk into family M (or plain, for reset). ──
  const closure: Record<Family, Set<string>> = { await: new Set(), yield: new Set(), asyncgen: new Set(), none: new Set() };

  // Walk `expr` collecting the rule refs reachable WITHOUT crossing a ctx marker, and
  // recurse into nested markers under their own family. `intoFamily(name, F)` enrolls a
  // rule into closure[F] and (first time) walks its body under F.
  function walkExpr(expr: RuleExpr, fam: Family | null): void {
    if (!expr || typeof expr !== 'object') return;
    switch (expr.type) {
      case 'ref':
        if (fam && byName.has(expr.name)) intoFamily(expr.name, fam);
        // a template reference reaches its hole rule: the holes inherit the context
        if (fam && expr.hole !== undefined) intoFamily(expr.hole, fam);
        return;
      case 'group':
        if (expr.ctxMode) { walkExpr(expr.body, familyOf(expr.ctxMode)); return; }   // the base family (null): no clone needed
        walkExpr(expr.body, fam); return;
      case 'seq': case 'alt': expr.items.forEach(i => walkExpr(i, fam)); return;
      case 'quantifier': walkExpr(expr.body, fam); return;
      case 'not': walkExpr(expr.body, fam); return;
      case 'sep': walkExpr(expr.element, fam); return;
      default: return;   // literal / zero-width markers
    }
  }
  function intoFamily(name: string, fam: Family): void {
    if (closure[fam].has(name)) return;
    closure[fam].add(name);
    const r = byName.get(name);
    if (r) walkExpr(r.body, fam);   // refs inside an enrolled rule stay in-family
  }
  // Seed: scan every BASE rule body for ctx markers (the function/arrow/method/class
  // body roots) and walk their contents under the marked family.
  for (const r of grammar.rules) walkExpr(r.body, null);

  // ── 2. Rewrite an expr for emission in family `fam` (null = plain/base): a ref to a
  // rule in closure[fam] becomes the $F clone; a nested ctx marker switches family;
  // a reset marker drops to plain; a GUARD_RULE ref takes the family-suffixed guard. ──
  // A rebuilt node keeps the grammar names of the node it replaces (src/grammar-names.ts).
  function rewrite(expr: RuleExpr, fam: Family | null): RuleExpr {
    return keepNames(expr, rewriteNode(expr, fam));
  }
  function rewriteNode(expr: RuleExpr, fam: Family | null): RuleExpr {
    if (!expr || typeof expr !== 'object') return expr;
    switch (expr.type) {
      case 'ref': {
        if (fam && closure[fam].has(expr.name)) return { type: 'ref', name: expr.name + SUFFIX[fam] };
        if (fam && expr.hole !== undefined && closure[fam].has(expr.hole)) return { type: 'ref', name: expr.name, hole: expr.hole + SUFFIX[fam] };
        return expr;
      }
      case 'group': {
        if (expr.when !== undefined) {
          const { mask, val } = whenTest(expr.when);
          if ((wordOf(fam) & mask) !== val) return NEVER;
        }
        const inner = expr.ctxMode ? familyOf(expr.ctxMode) : fam;
        const body = rewrite(expr.body, inner);
        // strip the ctxMode marker from the emitted grammar (it has done its routing
        // job); keep `suppress` (no-in context), `capBelow` (assignment-level cap) and `atLevel`
        // (a Pratt rule read at a level), all still read by the parser engine. (tsRelaxed is gen-treesitter-only and the
        // post-fork grammar is the PARSER's, which uses `body` — so it is correctly dropped.)
        const g: RuleExpr = { type: 'group', body };
        if (expr.suppress !== undefined) g.suppress = expr.suppress;
        if (expr.capBelow !== undefined) g.capBelow = expr.capBelow;
        if (expr.atLevel !== undefined) g.atLevel = expr.atLevel;
        return g;
      }
      case 'seq': return { type: 'seq', items: expr.items.map(i => rewrite(i, fam)) };
      case 'alt': return { type: 'alt', items: expr.items.map(i => rewrite(i, fam)) };
      case 'quantifier': return { type: 'quantifier', body: rewrite(expr.body, fam), kind: expr.kind };
      case 'not': {
        // the bare-identifier reserved-word guard: inside a context family, also
        // forbid that family's keyword(s), so `await`/`yield` lose their identifier
        // reading (await with no operand then rejects — the prefix op needs one).
        const body = fam && expr.reservable && RESERVED[fam].length ? addReserved(rewrite(expr.body, fam), RESERVED[fam]) : rewrite(expr.body, fam);
        return expr.reservable ? { type: 'not', body, reservable: true } : { type: 'not', body };
      }
      case 'sep': return { type: 'sep', element: rewrite(expr.element, fam), delimiter: expr.delimiter };
      default: return expr;
    }
  }

  // ── 3. The forked rules (appended AFTER the base rules so every existing rid =
  // rules.indexOf is unchanged and the entry rule stays last). ──
  const forks: RuleDecl[] = [];
  const families: Family[] = ['await', 'yield', 'asyncgen', 'none'];
  for (const fam of families) {
    const suf = SUFFIX[fam];
    for (const name of closure[fam]) {
      const base = byName.get(name)!;
      // rewrite reroutes in-family refs to $F and extends any reservable guard with
      // the family's context keyword (see the 'not' case in rewrite()).
      forks.push({ name: name + suf, body: rewrite(base.body, fam), flags: [...base.flags], canon: name, ctx: wordOf(fam) });
    }
  }

  // ── 4. Rewrite the BASE rules in place: a base rule containing ctx markers must now
  // reference the $F clones at those roots (materialize the routing). Refs OUTSIDE any
  // marker stay plain. ──
  const baseRewritten: RuleDecl[] = grammar.rules.map(r => ({ ...r, body: rewrite(r.body, null), ctx: 0 }));

  // Insert the forks BEFORE the last rule, so a grammar that omits `entry` (findEntryRule
  // then reads the last rule) keeps its entry; a declared entry is looked up by name.
  // Existing rids shift only for the last rule; forks (body-internal rules) are never
  // the entry.
  if (forks.length === 0) return { ...grammar, rules: baseRewritten };
  const entry = baseRewritten[baseRewritten.length - 1];
  return { ...grammar, rules: [...baseRewritten.slice(0, -1), ...forks, entry] };
}

// Collapse the [Await]/[Yield] forks back to the base grammar for the DERIVED-artifact
// generators (AST types / TM scopes / tree-sitter rules): drop every fork rule and
// rewrite any reference to a fork (the base async arm's rerouted Block$A, etc.) back to
// its base name. The result is structurally the pre-fork grammar, so those generators
// emit byte-identically. Identity (returns the same object) when nothing is forked.
export function dropForks(grammar: CstGrammar): CstGrammar {
  const canonOf = new Map<string, string>();
  for (const r of grammar.rules) if (r.canon) canonOf.set(r.name, r.canon);
  if (canonOf.size === 0) return grammar;
  const reref = (e: RuleExpr): RuleExpr => keepNames(e, rerefNode(e));
  const rerefNode = (e: RuleExpr): RuleExpr => {
    if (!e || typeof e !== 'object') return e;
    switch (e.type) {
      case 'ref':
        if (canonOf.has(e.name)) return { type: 'ref', name: canonOf.get(e.name)! };
        if (e.hole !== undefined && canonOf.has(e.hole)) return { type: 'ref', name: e.name, hole: canonOf.get(e.hole)! };
        return e;
      case 'group': return { type: 'group', body: reref(e.body), ...(e.suppress !== undefined ? { suppress: e.suppress } : {}), ...(e.capBelow !== undefined ? { capBelow: e.capBelow } : {}), ...(e.atLevel !== undefined ? { atLevel: e.atLevel } : {}) };
      case 'seq': return { type: 'seq', items: e.items.map(reref) };
      case 'alt': return { type: 'alt', items: e.items.map(reref) };
      case 'quantifier': return { type: 'quantifier', body: reref(e.body), kind: e.kind };
      case 'not': return { type: 'not', body: reref(e.body) };
      case 'sep': return { type: 'sep', element: reref(e.element), delimiter: e.delimiter };
      default: return e;
    }
  };
  return { ...grammar, rules: grammar.rules.filter(r => !r.canon).map(r => ({ ...r, body: reref(r.body) })) };
}

// Add `words` to the INNER body of a reservable guard's not(...): the body is the
// alt of forbidden literals (`alt('catch','class',…)`) or a single literal. Returns
// the extended alt; the caller wraps it back in the `not`.
function addReserved(inner: RuleExpr, words: string[]): RuleExpr {
  const lits = words.map((w): RuleExpr => ({ type: 'literal', value: w }));
  if (inner.type === 'alt') return { type: 'alt', items: [...inner.items, ...lits] };
  return { type: 'alt', items: [inner, ...lits] };
}

// The `arm` / `field` names a node carries (src/grammar-names.ts) survive a transform that
// rebuilds it: the fork and its reversal change which rule a reference names, never what an
// item is called.
function keepNames(from: RuleExpr, to: RuleExpr): RuleExpr {
  if (!from || typeof from !== 'object' || from === to || (from.arm === undefined && from.field === undefined)) return to;
  const out = { ...to };
  if (from.arm !== undefined) out.arm = from.arm;
  if (from.field !== undefined) out.field = from.field;
  return out;
}
