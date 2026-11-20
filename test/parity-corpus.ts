// The inputs the engine-parity gates run every engine on, built once per grammar:
//   • the generative corpus (grammar-gen, deterministic) — legal by construction;
//   • MUTANTS of it — one token deleted or doubled. A legal corpus cannot show a parser
//     accepting what it should reject: the mutants are near-miss inputs, most of them invalid;
//   • for the ECMAScript grammars, expressions the operator checks refuse (`++ ++y`, `x++ ++`,
//     `-x = 1`, `-x ** 2`), in every position where an expression is optional or repeated.
// Consumers: test/cst-text-invariant.ts (interpreter ≡ emitted parser) and
// test/portable-targets.ts (interpreter ≡ portable ts / go / rust parsers).
import { generateInputs } from './grammar-gen.ts';
import type { CstGrammar } from '../src/types.ts';

export type Tok = { offset: number; text: string };
export type ParityInput = {
  src: string;
  kind: 'generated' | 'mutant' | 'refused-operand';
  /** The token stream, or null when the input does not lex (a mutant can lose a closing quote). */
  toks: Tok[] | null;
};

// One token deleted / one token doubled, at up to MUT_SITES evenly spread tokens of an input.
const MUT_SITES = 6;
function mutants(src: string, toks: Tok[]): string[] {
  const real = toks.filter((t) => t.text.length > 0);
  if (real.length === 0 || real.length > 60) return [];
  const out: string[] = [];
  const step = Math.max(1, Math.floor(real.length / MUT_SITES));
  for (let i = 0; i < real.length; i += step) {
    const s = real[i].offset, e = s + real[i].text.length;
    out.push(src.slice(0, s) + src.slice(e));
    out.push(src.slice(0, e) + ' ' + real[i].text + src.slice(e));
  }
  return out;
}

// Expressions an operator check refuses, in each position where an expression is optional or
// repeated — and in the plain positions beside them.
const REFUSED = ['++ ++y', '++-x', '++x++', 'x++ ++', 'x++ --', '-x = 1', 'a + b = 1', 'x++ = 1', '-x ** 2', 'typeof x ** 2', '= b'];
const HOLES = [
  '[@]', '[1, @]', '[@, 1]', 'f(@)', 'f(a, @)', 'new A(@)', 'a = [@]', 'x = { a: @ }', 'x = { ...@ }', 'class C { p = @ }',
  'for (@;;) {}', 'for (;@;) {}', 'for (;;@) {}', 'function f() { return @ }', 'function* g() { yield @ }', 'yield @', 'var z = @',
  'var z = 1, w = @', '`${@}`', 'a ? @ : b', 'a ? b : @', 'x => @', '(@)', 'a[@]', '- @', '[- @]', 'a + @', '[a + @]', 'f(a + @)', 'a = @', '[a = @]',
  'if (@) {}', 'while (@) {}', 'switch (@) {}', 'throw @', 'do {} while (@)', 'a?.[@]', 'a?.(@)', 'async () => { await @ }',
];

/** Every parity input of a grammar, in a fixed order. A generated input that does not lex is
 *  dropped with its mutants; a mutant that does not lex is yielded with `toks: null`. */
export function* parityInputs(
  grammar: CstGrammar, tokenize: (src: string) => Tok[], opts: { refusedOperands: boolean },
): Generator<ParityInput> {
  const lex = (src: string): Tok[] | null => { try { return tokenize(src); } catch { return null; } };
  for (const input of generateInputs(grammar, { depth: 5, nestDepth: 5, cap: 7, fuzzRounds: 250, maxInputs: 1500, seed: 5 })) {
    const toks = lex(input.text);
    if (toks === null) continue;
    yield { src: input.text, kind: 'generated', toks };
    for (const m of mutants(input.text, toks)) yield { src: m, kind: 'mutant', toks: lex(m) };
  }
  if (opts.refusedOperands) {
    for (const h of HOLES) for (const r of REFUSED) { const src = h.replace('@', r); yield { src, kind: 'refused-operand', toks: lex(src) }; }
  }
}
