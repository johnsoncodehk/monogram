// Structural primitives over the grammar AST (RuleExpr), shared by the parser
// generator (gen-parser) and the TextMate highlighter generator (gen-tm).
//
// Only PURE, structural helpers belong here — the small things both consumers
// build on. The high-level logic stays separate: gen-parser's parse strategy
// (FIRST sets, left-recursion, Pratt classification) answers "how to parse";
// gen-tm's shape detection answers "how to emit TextMate regexes". Those change
// for different reasons and must not be coupled.
import type { CstGrammar, RuleExpr } from './types.ts';

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
 * first; empty unless `>` is also a rule literal (it closes type arguments). Then the lexer scans
 * every `>` alone and an operator is composed where one is read from the run of adjacent
 * single-character tokens that follows (tsc's reScanGreaterToken), so no token is ever split.
 * A composite must therefore be an infix operator; one that is a rule literal is rejected.
 */
export function gtComposites(grammar: CstGrammar): string[] {
  const ruleLits = new Set<string>();
  for (const r of grammar.rules) for (const l of collectLiterals(r.body)) ruleLits.add(l);
  if (!ruleLits.has('>')) return [];
  const gtLed = (l: string) => l.length > 1 && l.charCodeAt(0) === 62;
  for (const l of ruleLits) {
    if (gtLed(l)) throw new Error(`'${l}' is a rule literal, but '>'-led punctuators are composed from single '>' tokens and can only be operators`);
  }
  const ops = new Set<string>();
  for (const lv of grammar.precs) for (const o of lv.operators) {
    if (!gtLed(o.value)) continue;
    if (o.position !== 'infix') throw new Error(`'${o.value}' is a ${o.position} operator, but a composed '>'-led operator must be infix`);
    ops.add(o.value);
  }
  const look = new Set<string>();
  for (const r of grammar.rules) lookaheadLiterals(r.body, look);
  for (const l of look) {
    if (gtLed(l) && !ops.has(l)) throw new Error(`'${l}' in a lookahead is a '>'-led punctuator that is not an operator, so it is never composed`);
  }
  return [...ops].sort((a, b) => b.length - a.length);
}

/** A literal text as regex source: every regex metacharacter escaped (the same in JavaScript's
 *  RegExp and Oniguruma). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
