// The emit layer's public surface: ONE function, parameterized by a `Target`.
//
//   emitParser(grammar, target) → one self-contained source module for that target
//
// The module holds the grammar's lexer AND parser and imports nothing from monogram: it
// exposes a public tokenizer (the lexer alone, returning tokens the caller owns) beside
// the parser API. Inside each target the lexer and parser stay separate generators that
// read one shared token-id assignment — jsTarget's SoA-int lexer, goTarget's Tok-list
// lexer — so no cross-target token format exists.
//
// Targets: `jsTarget` (the optimized SoA parser, emit-parser.ts) and the portable
// `tsTarget`/`goTarget`/`rustTarget` (emit-portable.ts + target-*.ts), each registered by its
// own module through `defineTarget` (define-target.ts) with the Lowering of the shared algorithms.
import type { CstGrammar } from './types.ts';

export interface Target {
  name: string;
  ext: string;                                    // emitted file extension (no dot)
  emitParser(grammar: CstGrammar): string;        // the module: lexer + parser library, no I/O
  // A CLI harness (stdin → CST JSON) the verification gates APPEND to the library to make it
  // executable (Go: a separate runner.go). Not part of the parser.
  emitRunner?(): string;
}

export function emitParser(grammar: CstGrammar, target: Target): string {
  return target.emitParser(grammar);
}

export { jsTarget } from './emit-parser.ts';
export { tsTarget } from './target-ts.ts';
export { goTarget } from './target-go.ts';
export { rustTarget } from './target-rust.ts';
