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
