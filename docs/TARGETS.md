# Emitted parsers: targets, API and cost model

The grammar derives a parser library in TypeScript, Go or Rust, and an emitted JavaScript
parser. [`emitParser(grammar, target)`](../src/emit.ts) is the single emitter. It returns
**one self-contained source file**: no imports of monogram or anything on the producer's disk,
no I/O, so the output can be copied anywhere and compiled offline. Every target embeds its own
lexer and exposes it publicly next to the parser.

```ts
import { writeFileSync } from 'node:fs';
import { emitParser, jsTarget, tsTarget, goTarget, rustTarget } from './src/emit.ts';
import grammar from './typescript.ts';

writeFileSync('parser.ts', emitParser(grammar, tsTarget));   // or jsTarget / goTarget / rustTarget

// in the emitted TypeScript module:
const tokens = tokenize(src);   // the lexer alone: a fresh array the caller owns
const cst    = parse(src);      // lex + parse; null when the input is rejected
```

## Per target

| target | output | tokenizer | parser |
| --- | --- | --- | --- |
| `jsTarget` | one `.ts` module | `tokenize(src): Token[]` (`type, text, offset, k, t, newlineBefore, commentBefore, multilineFlowBefore`) | arena parser: `parse(src)` → node handle (`visit` / `tree` / `tokenAt`), incremental `parseEdited`, isolated documents via `createParser()` (`parse` / `edit` / `visit` / `tree` / `tokenAt(handle, i)`) |
| `tsTarget` | one `.ts` module | `tokenize(src): Token[]` | `parse(src)` → plain-object CST of spans (`Leaf { tokenType, offset, end }`, `Node { rule, children, offset, end }`), `parseWith`, `createDoc` (incremental) |
| `goTarget` | `package parser` | `Tokenize(src) ([]Token, error)` — a `*LexError` on malformed input | `ParseWith`, `NewDoc` (incremental; each `Doc` owns its tree, read via `CstJSON`; different `Doc`s may be used from concurrent goroutines) |
| `rustTarget` | one library crate file | `tokenize(src) -> Vec<Token>` — panics on malformed input (documented `# Panics`) | `parse_with`, `Doc` (incremental) |

`tokenize` never touches parser state: its result is independent of every tree, handle and
earlier result, and a parse is unaffected by any tokenize call before or after it.

## What each target accepts

`jsTarget` is the emitted JavaScript path. Grammars it can specialize get a lexer fused into
the arena's token columns; grammars that need the general lexing machinery (indent, newline
and markup modes) carry the interpreter's lexer inlined into the module.

The portable targets (`tsTarget` / `goTarget` / `rustTarget`) implement the token-stream and
newline modes. They refuse indent and markup grammars (`buildIR` in
[`src/emit-portable.ts`](../src/emit-portable.ts)) rather than emit a lexer that would
mis-tokenize them. So YAML and HTML have the interpreter and `jsTarget` only.

What `jsTarget` has and the portable targets do not yet, the precondition for retiring it, is
listed in [ROADMAP.md](ROADMAP.md#1-one-portable-engine-one-shared-runtime-description).

## The `jsTarget` handle API

- The module-level `tree` / `visit` / `tokenAt` always read the module's default document,
  never a `createParser()` instance's; an instance reads its own through its methods.
- Reads never switch documents, so a `visit` callback may read, traverse, parse, edit or
  tokenize any *other* document (or the module one) without disturbing the traversal.
- Parsing or editing the document being visited throws and leaves it unchanged.
- `createParser()` is total: every text yields a tree plus `errors`
  ([TOTAL-PARSING.md](TOTAL-PARSING.md)).

## Errors and tokens

- Lexical errors follow each language's mechanism: the JS/TS lexers throw, Go's `Tokenize`
  returns the error (`ParseWith` and the `Doc` constructors panic with the same `*LexError`),
  Rust panics.
- The `tsTarget` CST carries spans only: a leaf is located by its `offset`/`end`.
- Lexers scan every `>` alone (so `>>` closing two type-argument lists is two tokens). At an
  operator site the parser composes `>>`, `>>>`, `>=`, `>>=`, `>>>=` from adjacent `>`, `>`
  and `=` tokens, so an operator leaf at a `>` spans that run of `tokenize(src)` tokens and
  every other leaf is exactly one.
- Go and Rust CST leaves index the token stream, which a `CstBuilder` keeps (Go `Toks`;
  Rust's `cst_json_with` / `slim_json_with` read it from the builder).
- Byte-based Go/Rust use UTF-8 offsets: identical to the JS interpreter's for ASCII; for
  non-ASCII text the offset units differ.

## Builder reuse and the cost model

Passing a `CstBuilder` (Rust also `SlimBuilder`) that has parsed before to `ParseWith` /
`parse_with` reuses it. Its token stream, its arena and the engine's transient buffers are
emptied with their capacity kept: the scratch stack, the top-level entry list, the lexer's
bracket and template stacks (Rust: the builder's `Workspace`, which a custom builder can hand
over through `Builder::workspace_mut`).

This holds also after a rejected parse or a lexer error, except that after a Rust lexer panic
the next parse allocates the lexer's two small stacks again. The CST of the earlier parse is
gone: its handles must not be read after the new parse.

Cost model:

- Keep the builder across parses and, in Rust and Go, a parse allocates nothing after warm-up
  (once the builder has seen an input at least as large). [ALLOCATIONS.md](ALLOCATIONS.md)
  pins this for Go (0 allocations per parse in reuse mode).
- A fresh builder per parse allocates content-sized buffers each time, and above the
  allocator's large-allocation threshold (glibc: mmap, up to 32 MB) those are faulted in
  again on every parse.

The CLI shape `test/portable-targets.ts` runs (stdin → CST JSON) is a *harness* wrapper,
`target.emitRunner()`, written next to the library by the gate; it is not part of the parser.

## How the portable parsers are checked

The real [`javascript.ts`](../javascript.ts) and [`typescript.ts`](../typescript.ts) grammars
emit to TypeScript, Go and Rust. That includes the `[Await]/[Yield]` context (rule forks in
the interpreter, one context word in these parsers), left recursion, the regex/division and
template state machines, arrow functions, and the TS type grammar.

[`test/portable-targets.ts`](../test/portable-targets.ts) compiles and runs all three on every
CI run, for the two real grammars plus focused fixtures. Every emitted parser must agree with
the reference interpreter on accept/reject and, where both accept, on the tree of rule nodes.
The inputs are hand-written accept/reject lists and a corpus derived from each grammar:

- generated inputs, and one-token mutants of them;
- for the ECMAScript grammars, the expressions an operator check refuses;
- each token's edges derived from its pattern: alternatives, repeat bounds, class boundaries,
  escapes, line terminators inside it.

On that corpus every lexer must also give the interpreter lexer's token stream. A token
pattern means what its regex means: the emitted scanners back up out of a choice exactly where
that regex would ([`src/lex-match-plan.ts`](../src/lex-match-plan.ts)), and
[`test/lex-family.ts`](../test/lex-family.ts) checks every scanner against its token's regex.

## AST shapes

`emitTs(grammar, { shape })` ([`src/target-ts.ts`](../src/target-ts.ts)) and
`emitRust(grammar, { shape })` ([`src/target-rust.ts`](../src/target-rust.ts)) append a
declarative AST layer (`parseAst`) to the CST parser. The Go target has none. Spec format,
primitives and contracts: [SHAPE.md](SHAPE.md). Gates: `shape-codegen`, `shape-rust`,
`shape-parity`, `ast-builder`.
