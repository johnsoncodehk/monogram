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

// Per-emit options. Only `jsTarget` reads them today; the portable targets embed their own lexer
// and have nothing to resolve.
export interface EmitOptions {
  // How a createLexer-FALLBACK grammar (indent / newline / markup: the data-driven lexer state
  // machines are interpreter-only, so `embedLexer` is null) reaches the lexer runtime at load time:
  //   'import' (default) — `import { createLexer } from "<absolute path to this repo's src/gen-lexer.ts>"`,
  //                        resolved at emit time; the emitted file runs from anywhere on THIS machine.
  //   'inline'           — the runtime (src/gen-lexer.ts + the two helpers it uses + the type
  //                        declarations) is copied verbatim into the module. The output is then
  //                        STANDALONE: no import, no path, no dependency on monogram at load time.
  //   { import: spec }   — a caller-supplied specifier (a package entry, a relative path the caller
  //                        controls). The caller owns making `spec` resolve to gen-lexer's exports.
  // Self-contained grammars (token-stream languages) embed a specialized lexer and ignore this.
  lexerRuntime?: 'import' | 'inline' | { import: string };
}

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
  emitParser(grammar: CstGrammar, lexerSrc: string | null, opts?: EmitOptions): string;   // the parser LIBRARY (exports `tokenize` + `parse`; no I/O)
  // A standalone CLI harness (stdin → CST JSON) APPENDED to the library to make it executable —
  // needed to run the compiled go/rust (and ts) parsers for verification. Not part of the parser.
  emitRunner?(): string;
}

// The two public emitters share each target's lexer codegen: `emitLexer` renders it as a
// standalone tokenizer, `emitParser` embeds the same lexer (via `embedLexer`) and adds the parser.
export function emitLexer(grammar: CstGrammar, target: Target): string | null {
  return target.emitLexer(grammar);
}

export function emitParser(grammar: CstGrammar, target: Target, opts?: EmitOptions): string {
  return target.emitParser(grammar, target.embedLexer(grammar), opts);
}

export { jsTarget } from './emit-parser.ts';
export { tsTarget } from './target-ts.ts';
export { goTarget } from './target-go.ts';
export { rustTarget } from './target-rust.ts';
