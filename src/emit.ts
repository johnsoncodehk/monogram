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
  // The lexer source `emitParser` embeds into the parser (a fragment — no type decls / exports).
  // null ⇒ no separate lexer to embed (jsTarget markup/indent → the createLexer runtime fallback).
  embedLexer(grammar: CstGrammar): string | null;
  // PUBLIC: a COMPLETE, standalone tokenizer module — type decls + the lexer + `tokenize(src)`.
  // null where the lexer is not separable from the parser: jsTarget fuses lexing into its arena
  // pipeline (no token list), so there is no standalone tokenizer to emit.
  emitLexer(grammar: CstGrammar): string | null;
  emitParser(grammar: CstGrammar, lexerSrc: string | null): string;   // the parser LIBRARY (exports `tokenize` + `parse`; no I/O)
  // A standalone CLI harness (stdin → CST JSON) APPENDED to the library to make it executable —
  // needed to run the compiled go/rust (and ts) parsers for verification. Not part of the parser.
  emitRunner?(): string;
}

// The two public emitters share each target's lexer codegen: `emitLexer` renders it as a
// standalone tokenizer, `emitParser` embeds the same lexer (via `embedLexer`) and adds the parser.
export function emitLexer(grammar: CstGrammar, target: Target): string | null {
  return target.emitLexer(grammar);
}

export function emitParser(grammar: CstGrammar, target: Target): string {
  return target.emitParser(grammar, target.embedLexer(grammar));
}

export { jsTarget } from './emit-parser.ts';
export { tsTarget } from './target-ts.ts';
export { goTarget } from './target-go.ts';
export { rustTarget } from './target-rust.ts';
