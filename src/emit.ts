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
// Targets: `jsTarget` (the optimized SoA parser, target-js.ts) and the portable
// `tsTarget`/`goTarget`/`rustTarget` (parser-ir.ts + target-*.ts), each registered by its
// own module through `defineParserTarget` (define-parser-target.ts) with the Lowering of the shared algorithms.
export { emitParser, type EmitOptions, type Target } from './targets/target.ts';
export { jsTarget } from './targets/target-js.ts';
export { tsTarget } from './targets/target-ts.ts';
export { goTarget } from './targets/target-go.ts';
export { rustTarget } from './targets/target-rust.ts';
