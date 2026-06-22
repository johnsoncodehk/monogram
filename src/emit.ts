// The emit layer's public surface: exactly two APIs, both parameterized by a `Target`.
//
//   emitLexer(grammar, target)  → the lexer source for that target
//   emitParser(grammar, target) → the parser source for that target, REUSING emitLexer
//
// A `Target` owns BOTH halves, so emitParser(grammar, target) reuses the SAME target's lexer —
// jsTarget's parser embeds jsTarget's SoA-int lexer, goTarget's parser embeds goTarget's
// Tok-list lexer. No cross-target lexer format is shared, so the optimized JS path keeps its
// integer-bitmask token dispatch while the portable targets keep their clean byte scanner.
//
// Targets: `jsTarget` (the optimized SoA parser, emit-parser.ts) and the portable
// `tsTarget`/`goTarget`/`rustTarget` (emit-portable.ts + target-*.ts).
import type { CstGrammar } from './types.ts';

export interface Target {
  name: string;
  ext: string;                                                  // emitted file extension (no dot)
  emitLexer(grammar: CstGrammar): string | null;               // null ⇒ runtime-lexer fallback (jsTarget markup/indent grammars)
  emitParser(grammar: CstGrammar, lexerSrc: string | null): string;   // the parser LIBRARY (exports a `parse` entry; no I/O)
  // A standalone CLI harness (stdin → CST JSON) APPENDED to the library to make it
  // executable — needed to run the compiled go/rust (and ts) parsers for verification.
  // Not part of the parser. jsTarget omits it (it is consumed by `import`, not as a CLI).
  emitRunner?(): string;
}

export function emitLexer(grammar: CstGrammar, target: Target): string | null {
  return target.emitLexer(grammar);
}

export function emitParser(grammar: CstGrammar, target: Target): string {
  return target.emitParser(grammar, emitLexer(grammar, target));   // ← parser reuses lexer
}

export { jsTarget } from './emit-parser.ts';
export { tsTarget } from './target-ts.ts';
export { goTarget } from './target-go.ts';
export { rustTarget } from './target-rust.ts';
