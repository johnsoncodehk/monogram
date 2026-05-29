// Structural primitives over the grammar AST (RuleExpr), shared by the parser
// generator (gen-parser) and the TextMate highlighter generator (gen-tm).
//
// Only PURE, structural helpers belong here — the small things both consumers
// build on. The high-level logic stays separate: gen-parser's parse strategy
// (FIRST sets, left-recursion, Pratt classification) answers "how to parse";
// gen-tm's shape detection answers "how to emit TextMate regexes". Those change
// for different reasons and must not be coupled.
import type { RuleExpr } from './types.ts';

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
 */
export function isKeywordLiteral(s: string): boolean {
  return isIdentStartCode(s.charCodeAt(0));
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
