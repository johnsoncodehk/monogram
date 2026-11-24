// A seeded MUTATION corpus: valid inputs with ONE token deleted, inserted or replaced (by a
// literal of the grammar), at seeded positions. The tokens are the oracle lexer's. Each mutant
// is a near miss of a valid text: most are rejected, at the place the edit broke, which is what
// total parsing's diagnostics (and later its repairs) are measured on. Deterministic: the same
// seed gives the same corpus.
import type { CstGrammar } from '../src/types.ts';

// xorshift32: a small seeded generator, the same sequence on every machine.
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** The literals the grammar's rules name, sorted. */
export function grammarLiterals(grammar: CstGrammar): string[] {
  const out = new Set<string>();
  const walk = (e: unknown): void => {
    if (!e || typeof e !== 'object') return;
    const x = e as { type?: string; value?: unknown };
    if (x.type === 'literal' && typeof x.value === 'string' && x.value.length) out.add(x.value);
    for (const v of Object.values(e)) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v); }
  };
  for (const r of Object.values(grammar.rules)) walk(r);
  return [...out].sort();
}

/** `perInput` mutants of each input the lexer accepts (an input it refuses gives none). */
export function mutationCorpus(grammar: CstGrammar, tokenize: (s: string) => { offset: number; text: string }[], inputs: string[], perInput: number, seed: number): string[] {
  return mutationEdits(grammar, tokenize, inputs, perInput, seed).map((m) => m.src);
}
/** A mutant and its edit: the input it came from, whose text [at, at + del) became the `ins`
 *  characters of the mutant at `at` (the inserted or replacing literal; a deletion inserts none). */
export type Mutant = { src: string; orig: string; at: number; del: number; ins: number };
export function mutationEdits(grammar: CstGrammar, tokenize: (s: string) => { offset: number; text: string }[], inputs: string[], perInput: number, seed: number): Mutant[] {
  const lits = grammarLiterals(grammar);
  const R = rng(seed);
  const out: Mutant[] = [];
  for (const src of inputs) {
    let toks: { offset: number; text: string }[];
    try { toks = tokenize(src); } catch { continue; }
    if (toks.length === 0) continue;
    for (let k = 0; k < perInput; k++) {
      const t = toks[Math.floor(R() * toks.length)]!, op = Math.floor(R() * 3), lit = lits[Math.floor(R() * lits.length)]!;
      const a = t.offset, b = t.offset + t.text.length;
      out.push(op === 0 ? { src: src.slice(0, a) + src.slice(b), orig: src, at: a, del: b - a, ins: 0 }
        : op === 1 ? { src: `${src.slice(0, a)}${lit} ${src.slice(a)}`, orig: src, at: a, del: 0, ins: lit.length }
        : { src: src.slice(0, a) + lit + src.slice(b), orig: src, at: a, del: b - a, ins: lit.length });
    }
  }
  return out;
}
