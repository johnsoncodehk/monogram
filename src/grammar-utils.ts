// Structural primitives over the grammar AST (RuleExpr), shared by the parser
// generator (gen-parser) and the TextMate highlighter generator (gen-tm).
//
// Only PURE, structural helpers belong here — the small things both consumers
// build on. The high-level logic stays separate: gen-parser's parse strategy
// (FIRST sets, left-recursion, Pratt classification) answers "how to parse";
// gen-tm's shape detection answers "how to emit TextMate regexes". Those change
// for different reasons and must not be coupled.
import type { CstGrammar, RuleExpr } from './types.ts';

/** The ZERO-WIDTH MARKERS of the grammar language: assertions that consume nothing and build no
 *  child (a negative lookahead, the line and comment conditions, the left-leaf gate, a declared
 *  target check). Every reader that skips or names them asks this one set. */
export const ZERO_WIDTH_MARKERS: ReadonlySet<RuleExpr['type']> = new Set<RuleExpr['type']>(['not', 'sameLine', 'noCommentBefore', 'noMultilineFlowBefore', 'notLeftLeaf', 'target']);
export const isZeroWidthMarker = (t: RuleExpr['type']): boolean => ZERO_WIDTH_MARKERS.has(t);

/** The grammar's context parameters (docs/GRAMMAR.md "Contexts: `when`"), one bit each of the
 *  context WORD (bit 1 << index): `await` and `yield` are ECMAScript's [Await] / [Yield].
 *  `syncFn` is TRANSITIONAL (kind: transition; end state: the declared parameters with goals,
 *  where the Module goal's entry word sets `await`; exit: the goals step deletes it and the
 *  `await` operator's gate becomes `when('+await')`): it is set in a body where `await` is the
 *  operator in no goal (a non-async function, method, arrow, accessor, class element) and clear
 *  at the top level, which the one entry reads as both goals (Module: the operator, Script: the
 *  identifier), and in an async body. */
export const CTX_PARAMS = ['await', 'yield', 'syncFn'] as const;
export type CtxMode = 'await' | 'yield' | 'asyncgen' | 'reset';
/** A `when` condition (`'+yield'`, `'~syncFn'`, `'+a ~b'`: a conjunction) as the test
 *  `(word & mask) === val`. An unknown parameter is an error, not a condition that never holds. */
export function whenTest(cond: string): { mask: number; val: number } {
  let mask = 0, val = 0;
  for (const part of cond.trim().split(/\s+/)) {
    const i = CTX_PARAMS.indexOf(part.slice(1) as typeof CTX_PARAMS[number]);
    if ((part[0] !== '+' && part[0] !== '~') || i < 0) throw new Error(`when(${JSON.stringify(cond)}): '${part}' is not +p / ~p over the context parameters ${CTX_PARAMS.join(', ')}`);
    mask |= 1 << i; if (part[0] === '+') val |= 1 << i;
  }
  return { mask, val };
}
/** Whether some `when` of the grammar (an item or an operator) reads `syncFn`: only then does a
 *  reset body differ from the top level (the bit is set there), so a grammar that never reads it
 *  keeps one context for both. */
export function readsSyncFn(g: Pick<CstGrammar, 'rules' | 'precs'>): boolean {
  const bit = 1 << CTX_PARAMS.indexOf('syncFn');
  const reads = (c: string | undefined): boolean => c !== undefined && (whenTest(c).mask & bit) !== 0;
  if (g.precs.some((l) => l.operators.some((o) => reads(o.when)))) return true;
  const walk = (e: RuleExpr): boolean => {
    if (!e || typeof e !== 'object') return false;
    switch (e.type) {
      case 'group': return reads(e.when) || walk(e.body);
      case 'seq': case 'alt': return e.items.some(walk);
      case 'quantifier': case 'not': return walk(e.body);
      case 'sep': return walk(e.element);
      default: return false;
    }
  };
  return g.rules.some((r) => walk(r.body));
}
/** The word a context marker sets (awaitCtx / yieldCtx / asyncGenCtx / resetCtx). */
export function ctxWordOfMode(mode: CtxMode, splitSync: boolean): number {
  const sync = splitSync ? 4 : 0;
  return mode === 'await' ? 1 : mode === 'yield' ? 2 | sync : mode === 'asyncgen' ? 3 : sync;
}

/** True if `code` is an identifier-start character: a-z, A-Z, `_`, or `$`. */
export function isIdentStartCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95 || code === 36;
}

/**
 * Classify a grammar literal as a keyword/identifier-word (`new`, `readonly`, …)
 * vs punctuation (`=>`, `+`, `(`, …). Decided by the first character: every
 * literal/operator in the grammar is either identifier-shaped or starts with
 * punctuation, so the first char discriminates (verified: 0 divergence from a
 * full all-characters check across all 144 literals/operators/token names).
 *
 * charCode-based, NO regex — this runs in the parse hot path (matchLiteral,
 * keyMatchesTok), where a regex-per-call measurably regressed throughput.
 *
 * Single source of truth so the parser and the highlighter classify keywords
 * IDENTICALLY — the project's "single grammar → parser + highlighter, never
 * disagree" invariant would be violated by two private predicates.
 *
 * `@`-headed word literals (`@new`) are keyword-class too: a keyword literal
 * matches a NAMED token by exact text (matchLiteral's keyword branch), which is
 * exactly what a fused decorator-head token (`@new` lexed as one Decorator
 * token) needs — it can never be punctuation. A bare `@` stays punctuation.
 */
export function isKeywordLiteral(s: string): boolean {
  return isIdentStartCode(s.charCodeAt(0)) || (s.charCodeAt(0) === 64 && isIdentStartCode(s.charCodeAt(1)));
}

/** Every literal string reachable in a rule expression (incl. `sep` delimiters). */
export function collectLiterals(expr: RuleExpr): string[] {
  switch (expr.type) {
    case 'literal': return [expr.value];
    case 'seq': case 'alt': return expr.items.flatMap(collectLiterals);
    case 'quantifier': case 'group': return collectLiterals(expr.body);
    case 'sep': return [...collectLiterals(expr.element), expr.delimiter];
    default: return [];
  }
}

/** Every literal inside a `not(...)` lookahead of a rule expression. */
function lookaheadLiterals(expr: RuleExpr, out: Set<string>, inNot = false): void {
  switch (expr.type) {
    case 'literal': if (inNot) out.add(expr.value); return;
    case 'seq': case 'alt': for (const i of expr.items) lookaheadLiterals(i, out, inNot); return;
    case 'quantifier': case 'group': lookaheadLiterals(expr.body, out, inNot); return;
    case 'not': lookaheadLiterals(expr.body, out, true); return;
    case 'sep': lookaheadLiterals(expr.element, out, inNot); if (inNot) out.add(expr.delimiter); return;
    default: return;
  }
}

/**
 * The `>`-led operators (`>>`, `>=`, `>>>=`, …) composed from single-character tokens, longest
 * first; empty unless the grammar declares the re-scan (`composeGt`: `>` closes a bracket, such as
 * type arguments or a JSX tag, where a `>`-led operator could begin). Then the lexer scans every `>`
 * alone and an operator is composed where one is read from the run of adjacent single-character
 * tokens that follows (tsc's reScanGreaterToken), so no token is ever split. A composite must
 * therefore be an infix operator; one that is a rule literal is rejected. The re-scan used to be
 * INFERRED from `>` being a rule literal, which imposed TypeScript's lexing on any grammar that
 * spells `>` in a rule (docs/SECOND-LANGUAGE.md, W2).
 * `composeLt` declares the same for `<` (an opening bracket such as type arguments, where `<<`
 * may be two openings: `X<<T>() => T>`): then the `<`-led operators (`<<`, `<=`, `<<=`) are
 * composed too, from single `<` tokens. The composites of both, longest first; each begins at its
 * lead character's token (compositeLeads).
 */
export function gtComposites(grammar: CstGrammar): string[] {
  const leads = compositeLeads(grammar);
  if (leads.length === 0) return [];
  const ruleLits = new Set<string>();
  for (const r of grammar.rules) for (const l of collectLiterals(r.body)) ruleLits.add(l);
  const led = (l: string) => l.length > 1 && leads.includes(l[0]!);
  for (const l of ruleLits) {
    if (led(l)) throw new Error(`'${l}' is a rule literal, but '${l[0]}'-led punctuators are composed from single '${l[0]}' tokens and can only be operators`);
  }
  const ops = new Set<string>();
  for (const lv of grammar.precs) for (const o of lv.operators) {
    if (!led(o.value)) continue;
    if (o.position !== 'infix') throw new Error(`'${o.value}' is a ${o.position} operator, but a composed '${o.value[0]}'-led operator must be infix`);
    ops.add(o.value);
  }
  const look = new Set<string>();
  for (const r of grammar.rules) lookaheadLiterals(r.body, look);
  for (const l of look) {
    if (led(l) && !ops.has(l)) throw new Error(`'${l}' in a lookahead is a '${l[0]}'-led punctuator that is not an operator, so it is never composed`);
  }
  return [...ops].sort((a, b) => b.length - a.length);
}

/** The characters whose tokens a composite operator begins at (gtComposites): `>` under
 *  `composeGt`, `<` under `composeLt`; every one is a single-character punctuator of its own. */
export function compositeLeads(grammar: Pick<CstGrammar, 'composeGt' | 'composeLt'>): string[] {
  return [...grammar.composeGt ? ['>'] : [], ...grammar.composeLt ? ['<'] : []];
}

/** A literal text as regex source: every regex metacharacter escaped (the same in JavaScript's
 *  RegExp and Oniguruma). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
