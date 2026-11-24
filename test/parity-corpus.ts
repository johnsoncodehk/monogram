// The inputs the engine-parity gates run every engine on, built once per grammar:
//   • the generative corpus (grammar-gen, deterministic) — legal by construction;
//   • MUTANTS of it — one token deleted or doubled. A legal corpus cannot show a parser
//     accepting what it should reject: the mutants are near-miss inputs, most of them invalid;
//   • for the ECMAScript grammars, expressions the operator checks refuse (`++ ++y`, `x++ ++`,
//     `-x = 1`, `-x ** 2`), in every position where an expression is optional or repeated;
//   • TOKEN EDGES (test/token-edges.ts) — texts derived from each token's pattern and escape
//     patterns at their boundaries, most of them near misses, each put in place of an occurrence
//     of that token in the shortest generated input that has one (a skipped token, which leaves
//     no occurrence, goes before and between the first tokens of the shortest input; a token no
//     generated input holds goes where the identifier token stands). The generated inputs
//     hold each token in its conservative form; the lexers disagree at the edges.
// Consumers: test/cst-text-invariant.ts (interpreter ≡ emitted parser) and
// test/portable-targets.ts (interpreter ≡ portable ts / go / rust parsers).
import { generateInputs } from './grammar-gen.ts';
import { tokenEdgeTexts } from './token-edges.ts';
import type { Grammar } from '../src/grammar/types.ts';

export type Tok = { offset: number; text: string; type: string };
export type ParityInput = {
  src: string;
  kind: 'generated' | 'mutant' | 'refused-operand' | 'token-edge';
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
  grammar: Grammar, tokenize: (src: string) => Tok[], opts: { refusedOperands: boolean },
): Generator<ParityInput> {
  const lex = (src: string): Tok[] | null => { try { return tokenize(src); } catch { return null; } };
  // Per token type, the shortest generated input holding it, and where (the token edges' context).
  const site = new Map<string, { src: string; at: Tok }>();
  let shortest: { src: string; toks: Tok[] } | null = null;
  for (const input of generateInputs(grammar, { depth: 5, nestDepth: 5, cap: 7, fuzzRounds: 250, maxInputs: 1500, seed: 5 })) {
    const toks = lex(input.text);
    if (toks === null) continue;
    yield { src: input.text, kind: 'generated', toks };
    for (const m of mutants(input.text, toks)) yield { src: m, kind: 'mutant', toks: lex(m) };
    for (const t of toks) {
      const s = site.get(t.type);
      if (t.text.length > 0 && (!s || input.text.length < s.src.length)) site.set(t.type, { src: input.text, at: t });
    }
    if (toks.length >= 2 && (!shortest || input.text.length < shortest.src.length)) shortest = { src: input.text, toks };
  }
  if (opts.refusedOperands) {
    for (const h of HOLES) for (const r of REFUSED) { const src = h.replace('@', r); yield { src, kind: 'refused-operand', toks: lex(src) }; }
  }
  const identSite = site.get(grammar.tokens.find((t) => t.identifier)?.name ?? '');
  for (const decl of grammar.tokens) {
    // A token the generated inputs never hold is tried where the identifier token stands.
    const s = site.get(decl.name) ?? (decl.flags.includes('skip') ? undefined : identSite);
    const place = s
      ? (t: string) => s.src.slice(0, s.at.offset) + t + s.src.slice(s.at.offset + s.at.text.length)
      : shortest && decl.flags.includes('skip')
        ? (t: string) => { const a = shortest!.toks[1].offset; return t + ' ' + shortest!.src.slice(0, a) + t + ' ' + shortest!.src.slice(a); }
        : null;
    if (place === null) continue;
    for (const t of tokenEdgeTexts(decl)) { const src = place(t); yield { src, kind: 'token-edge', toks: lex(src) }; }
  }
}
