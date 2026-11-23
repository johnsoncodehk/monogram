// The emit layer's core: the `Target` interface and `emitParser`, with no target attached. Each
// target's module (emit-parser.ts, target-ts.ts, target-go.ts, target-rust.ts) imports only this,
// so a consumer that uses one target loads one target: the test runner (test/gate-deps.ts) reads
// a gate's inputs from its imports, and a gate of one target must not depend on the others.
// src/emit.ts is the public surface: this module and every target.
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

