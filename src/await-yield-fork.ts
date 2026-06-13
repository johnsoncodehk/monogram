// Build-time grammar transform implementing the ECMAScript [Await]/[Yield] grammar
// parameters by NAME-FORKING the body-reachable rule closure into context families.
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
import type { CstGrammar, RuleDecl, RuleExpr } from './types.ts';

type Family = 'await' | 'yield' | 'asyncgen';
const SUFFIX: Record<Family, string> = { await: '$A', yield: '$Y', asyncgen: '$AY' };
const RESERVED: Record<Family, string[]> = { await: ['await'], yield: ['yield'], asyncgen: ['await', 'yield'] };

// The reserved-word guard rules whose forked variant must additionally forbid the
// family's context keyword (so `await`/`yield` lose their bare-identifier reading).
const GUARD_RULES = new Set(['notReservedExpr', 'notReserved']);

export function withAwaitYield(grammar: CstGrammar): CstGrammar {
  const byName = new Map(grammar.rules.map(r => [r.name, r]));

  // ── 1. Per-family closure: which rules need an $F clone. A rule S is in closure[F]
  // if it is reachable, via in-family refs, from a subtree marked mode F — where a
  // nested marker of mode M re-roots the walk into family M (or plain, for reset). ──
  const closure: Record<Family, Set<string>> = { await: new Set(), yield: new Set(), asyncgen: new Set() };

  // Walk `expr` collecting the rule refs reachable WITHOUT crossing a ctx marker, and
  // recurse into nested markers under their own family. `intoFamily(name, F)` enrolls a
  // rule into closure[F] and (first time) walks its body under F.
  function walkExpr(expr: RuleExpr, fam: Family | null): void {
    if (!expr || typeof expr !== 'object') return;
    switch (expr.type) {
      case 'ref':
        if (fam && byName.has(expr.name)) intoFamily(expr.name, fam);
        return;
      case 'group':
        if (expr.ctxMode && expr.ctxMode !== 'reset') { walkExpr(expr.body, expr.ctxMode); return; }
        if (expr.ctxMode === 'reset') { walkExpr(expr.body, null); return; }   // plain family: no clone needed
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
  function rewrite(expr: RuleExpr, fam: Family | null): RuleExpr {
    if (!expr || typeof expr !== 'object') return expr;
    switch (expr.type) {
      case 'ref': {
        if (fam && GUARD_RULES.has(expr.name)) return { type: 'ref', name: expr.name + SUFFIX[fam] };
        if (fam && closure[fam].has(expr.name)) return { type: 'ref', name: expr.name + SUFFIX[fam] };
        return expr;
      }
      case 'group': {
        const inner = expr.ctxMode === 'reset' ? null : (expr.ctxMode ? expr.ctxMode : fam);
        const body = rewrite(expr.body, inner);
        // strip the ctxMode marker from the emitted grammar (it has done its routing
        // job); keep `suppress` (the no-in context, still read by the engine).
        return expr.suppress !== undefined ? { type: 'group', body, suppress: expr.suppress } : { type: 'group', body };
      }
      case 'seq': return { type: 'seq', items: expr.items.map(i => rewrite(i, fam)) };
      case 'alt': return { type: 'alt', items: expr.items.map(i => rewrite(i, fam)) };
      case 'quantifier': return { type: 'quantifier', body: rewrite(expr.body, fam), kind: expr.kind };
      case 'not': return { type: 'not', body: rewrite(expr.body, fam) };
      case 'sep': return { type: 'sep', element: rewrite(expr.element, fam), delimiter: expr.delimiter };
      default: return expr;
    }
  }

  // ── 3. The forked rules (appended AFTER the base rules so every existing rid =
  // rules.indexOf is unchanged and the entry rule stays last). ──
  const forks: RuleDecl[] = [];
  const families: Family[] = ['await', 'yield', 'asyncgen'];
  for (const fam of families) {
    const suf = SUFFIX[fam];
    for (const name of closure[fam]) {
      const base = byName.get(name)!;
      // a reserved-word guard in this family ALSO forbids the family's context keyword
      // (so await/yield lose their bare-identifier reading); other rules just reroute.
      const body = GUARD_RULES.has(name)
        ? addReserved(rewrite(base.body, fam), RESERVED[fam])
        : rewrite(base.body, fam);
      forks.push({ name: name + suf, body, flags: [...base.flags], canon: name });
    }
  }

  // ── 4. Rewrite the BASE rules in place: a base rule containing ctx markers must now
  // reference the $F clones at those roots (materialize the routing). Refs OUTSIDE any
  // marker stay plain. ──
  const baseRewritten: RuleDecl[] = grammar.rules.map(r => ({ ...r, body: rewrite(r.body, null) }));

  return { ...grammar, rules: [...baseRewritten, ...forks] };
}

// Add `words` to the not(alt(...)) reserved set of a guard rule's body. The guard is
// `not(alt('catch','class',...))` (a `not` over an `alt` of literals) or `not(literal)`.
function addReserved(body: RuleExpr, words: string[]): RuleExpr {
  if (body.type === 'not') {
    const inner = body.body;
    const lits = (w: string): RuleExpr => ({ type: 'literal', value: w });
    if (inner.type === 'alt') return { type: 'not', body: { type: 'alt', items: [...inner.items, ...words.map(lits)] } };
    return { type: 'not', body: { type: 'alt', items: [inner, ...words.map(lits)] } };
  }
  // a guard that is a seq containing a not(...) (e.g. notReservedExpr used in a seq):
  if (body.type === 'seq') return { type: 'seq', items: body.items.map(i => addReserved(i, words)) };
  if (body.type === 'group') return { type: 'group', body: addReserved(body.body, words), suppress: body.suppress };
  return body;
}
