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
import type { Shape } from './shape2-eval.ts';

// What a portable target emits beyond the default module. `recovery`: total parsing's entry
// `parseTotal` (docs/TARGETS.md "Errors and tokens"); without it the module has no such symbol and
// is byte-identical to the default emission.
// `shape`: a parser that builds the shape's values instead of the CST (src/shape-plan.ts; S1: the
// TypeScript target only, its synthesized-only terms); the shape must be defined on `grammar`.
export interface EmitOptions { recovery?: boolean; shape?: Shape }

export interface Target {
  name: string;
  ext: string;                                    // emitted file extension (no dot)
  emitParser(grammar: CstGrammar, opts?: EmitOptions): string;   // the module: lexer + parser library, no I/O
  // A CLI harness (stdin → CST JSON) the verification gates APPEND to the library to make it
  // executable (Go: a separate runner.go). Not part of the parser.
  // With `opts.recovery` the runner also has the mode `batch-total` (the module must be emitted
  // with the same option).
  emitRunner?(opts?: EmitOptions): string;
}

export function emitParser(grammar: CstGrammar, target: Target, opts: EmitOptions = {}): string {
  return target.emitParser(grammar, opts);
}

export { jsTarget } from './emit-parser.ts';
export { tsTarget } from './target-ts.ts';
export { goTarget } from './target-go.ts';
export { rustTarget } from './target-rust.ts';
