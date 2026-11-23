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
| `rustTarget` | one library crate file | `tokenize(src) -> Result<Vec<Token>, LexError>` — `Err` on malformed input (`LexError { off, msg }`, a `std::error::Error`); since f5a1c3e, before which it panicked | `parse_with`, `Doc` (incremental) |

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

They parse grammars with element regions (`elements`, [docs/REGIONS.md](REGIONS.md)): the
portable lexers carry the region's frame stack (a3fb3a9), so
[`typescriptreact.ts`](../typescriptreact.ts) (TSX), [`javascriptreact.ts`](../javascriptreact.ts)
(JSX) and the code-children fixture [`test/fixtures/elementdialect.ts`](../test/fixtures/elementdialect.ts)
emit to all three. What a region may declare that the portable lexers do not carry yet is
refused when the parser is emitted (`buildIR`), not mis-lexed: `textTokens`, directives in
children, `rawText` together with a type-parameter `signature`, and elements in a newline-mode
grammar. A tag start (`tagStart`) and a raw-text body condition (`unlessBodyStarts`) are carried:
the text dialect fixture without its text tokens and directives (`textDialect`, the case
`textdialect-tagstart` of `test/portable-targets.ts`) emits to all three.

Known difference between the interpreter's lexer and the portable lexers (owed): an
`identifier` token whose own pattern does not take an ASCII member of IdentifierPart
(`src/uni-ident.ts`: `$`, also an ASCII digit or letter the pattern leaves out). After the token
ends at such a unit and no token matches there, the interpreter extends the identifier over it
(`LX_UNI_CONT`, the whole IdentifierPart class); the portable lexers extend only over units beyond
ASCII (`lxExt`), and the unit begins a new identifier. Witness: an identifier `[A-Za-z_]
[A-Za-z0-9_]*` and the text `a$` (interpreter: one `Ident` `a$`; portable: `a`, `$`). No shipped
grammar shows it: every real identifier pattern takes `$` and all ASCII identifier characters.
The portable side follows the stated contract (the grammar's ASCII pattern decides ASCII; the
Unicode classes extend a token "the ASCII pattern cut short" at a unit beyond ASCII), so the
interpreter's extension is the one to narrow.

### Element dialects: evidence and cost

Parity (`test/portable-targets.ts`, every CI run; the same counts for TypeScript, Go and Rust):

| grammar | accept / reject ≡ interpreter | one-character edits ≡ fresh parse | parity corpus ≡ interpreter (verdict, rule skeleton, token stream) |
|---|---|---|---|
| typescriptreact | 35 / 13 | 5,731 | 11,346 (generated, plus tsc's JSX conformance cases) |
| javascriptreact | 19 / 9 | 2,182 | 11,427 |
| elementdialect | 7 / 5 | 4,557 | 2,133 |

Every corpus input also gives the same tree through an incremental `Doc` as through a fresh
parse.

Emitted sizes (`node test/emit-sizes.ts`, recorded by the profile run 45129600578 on master
d326d65):

| grammar | TypeScript | Go | Rust |
|---|--:|--:|--:|
| `typescriptreact.ts` | 309,794 B | 545,370 B | 408,054 B |
| `javascriptreact.ts` | 206,830 B | 350,928 B | 288,389 B |

Speed, from the same run ([MEASUREMENT.md](MEASUREMENT.md#recorded-result-element-dialects-tsx-and-jsx)
has the table): a token of tsc's JSX conformance code costs the Rust lexer 203.7 instructions,
against 142.3 on `checker.ts` and 158.6 on `gen-tm.ts` through the typescript parser; the
difference is the token mix (text runs, tags and holes). Plain TypeScript through the
typescriptreact parser costs, against the typescript parser, +3.1% Rust lexer, +1.4% Rust parse,
+1.6% Go (direct engine), -0.7% Go (builder engine), +0.06% TS blocks; the Rust lexer's +3.1% is
register moves at the lexer loop's merges, not element work.

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

- Lexical errors: the JS/TS `tokenize` throws; Go's `Tokenize` returns a `*LexError`; Rust's
  `tokenize` returns `Err(LexError)` (since f5a1c3e; it panicked before). The parse entry points
  keep their form: TS `parse` / `createDoc` throw, Go `ParseWith` and the `Doc` constructors
  panic with the `*LexError`, Rust `parse_with` / `parse` / `Doc::new` panic with the message.
  Inside the portable lexers an error is a returned value, never a throw or panic used for
  control flow.
- Total parsing is an emit option: `emitParser(grammar, target, { recovery: true })` appends a
  region to the module (the default emission is unchanged and is the module's prefix, byte for
  byte; without the option the entry below does not exist). It adds TS
  `parseTotal(src, builder) -> { root, errors }`, Go `ParseTotal(src, b) (h, ok, errs)`, Rust
  `parse_total(src, &mut b) -> (Option<H>, Vec<Diagnostic>)`. It never throws or panics on input:
  an accepted text gives `parseWith`'s root and no errors; a rejected one gives no root and one
  diagnostic `{ offset, end, message, related? }`, either the lexer error or the parse's primary
  error. The primary error is the interpreter's: the token where the entry rule stopped
  (`unexpected 'x'`, with `after successful parse` when the entry rule consumed tokens and input
  is left over). Its related location is the furthest token the parse examined, when that lies
  past the error. That token is usually the interpreter's `[farthest: …]` token, but not always:
  the interpreter counts the tokens a match advanced past, and the engine also counts a guard's
  read of the next token. Messages come from one formatter (`src/recovery-family.ts`). Go and
  Rust spans are byte offsets. Recovered trees (`$error` / `$missing`) are not there yet.
  The option also carries the parse plan as one int table (`emit-portable.ts` recoveryTables) and
  ONE interpreter of it (`src/recovery-family.ts`, printed for each target), which later stages
  make repair: TS `parseInterpreted(src, builder, depth)`, Go `ParseInterpreted`, Rust
  `parse_interpreted` parse as `parseWith` does (the same verdict and tree) with `depth` rule
  levels interpreted and the native functions below, and report the steps they interpreted.
- The `tsTarget` CST carries spans only: a leaf is located by its `offset`/`end`.
- Lexers scan every `>` alone (so `>>` closing two type-argument lists is two tokens). At an
  operator site the parser composes `>>`, `>>>`, `>=`, `>>=`, `>>>=` from adjacent `>`, `>`
  and `=` tokens, so an operator leaf at a `>` spans that run of `tokenize(src)` tokens and
  every other leaf is exactly one.
- Go and Rust CST leaves index the token stream, which a `CstBuilder` keeps (Go `Toks`;
  Rust's `cst_json_with` / `slim_json_with` read it from the builder).
- Byte-based Go/Rust use UTF-8 offsets: identical to the JS interpreter's for ASCII; for
  non-ASCII text the offset units differ.

## The builder contract

Accepting or rejecting is the parser's verdict, never the builder's (#178). A builder must keep
a node for the root, the entry rule, of every accepted parse. The built-in builders always do:
`CstBuilder`, and `SlimBuilder`, which keeps the root even with no child. A builder that keeps
nothing for the root is a programming error and fails loudly: Go panics (`errNoRoot`), Rust
panics (`Spanned::root`), TS throws (`runW`). It is never reported as a reject. A rejected input
still returns `ok == false` / `None` / `null`, whatever the builder.

To ask only whether a text parses, no target has an entry that builds nothing. The cheapest
existing way:

- Go: `ParseWith(src, cst)` with one `*CstBuilder` kept across calls. It runs the direct
  engine, not the `Builder` interface, and allocates nothing after warm-up. At #180 it was
  182.7M instructions on checker.ts against 212.8M for a kept `SlimBuilder` (profile job, `Go
  Ir reuse` and `Go Ir builder`). A lexer error panics with `*LexError`, so the caller
  recovers it as "does not parse".
- Rust: `parse_with(src, &mut b)` with one `CstBuilder` kept across calls; it allocates nothing
  after warm-up. A lexer error panics.
- TS: `parse(src) !== null`, which builds the plain-object CST. A lexer error throws.

Owed: an `accepts(src)` entry per target that lexes and runs the recognize forms the engine
already has for lookahead. It would keep no node, kid or scratch entry, take no checkpoint,
return `false` on a lexer error, and cost below the direct engine's parse. It is not measured:
the profile job would get it as a row.

## Builder reuse and the cost model

Passing a `CstBuilder` (Rust also `SlimBuilder`) that has parsed before to `ParseWith` /
`parse_with` reuses it. Its token stream, its arena and the engine's transient buffers are
emptied with their capacity kept: the scratch stack, the top-level entry list, the lexer's
bracket and template stacks (Rust: the builder's `Workspace`, which a custom builder can hand
over through `Builder::workspace_mut`).

This holds also after a rejected parse or a lexer error (since f5a1c3e also in Rust, where a
lexer panic used to drop the lexer's two small stacks). The CST of the earlier parse is
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
