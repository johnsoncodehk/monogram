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
[`src/ir/parser-ir.ts`](../src/ir/parser-ir.ts)) rather than emit a lexer that would
mis-tokenize them. So YAML and HTML have the interpreter and `jsTarget` only.

They parse grammars with element regions (`elements`, [docs/REGIONS.md](REGIONS.md)): the
portable lexers carry the region's frame stack (a3fb3a9), so
[`typescriptreact.ts`](../typescriptreact.ts) (TSX), [`javascriptreact.ts`](../javascriptreact.ts)
(JSX), the code-children fixture [`test/fixtures/elementdialect.ts`](../test/fixtures/elementdialect.ts)
and the text dialect fixture [`test/fixtures/textdialect.ts`](../test/fixtures/textdialect.ts)
(text children with a tag start, raw text with a body condition, comments in text, derived
directives) emit to all three. What a region may declare that the portable lexers do not carry yet is
refused when the parser is emitted (`buildIR`), not mis-lexed: `rawText` together with a
type-parameter `signature`, directives together with a `signature` or without the regex context
(a head's depth is the paren-head stack's), a class beyond ASCII where one unit is tested
(`tagStart`, an `after` class, an identifier for the directive word test), a text token that may
begin beyond ASCII, and elements in a newline-mode grammar. The text dialect's stages
(`textDialect(parts)`: without text tokens or directives) are cases of their own in
`test/portable-targets.ts`.

An `identifier` token whose own pattern does not take an ASCII member of IdentifierPart
(`src/grammar/uni-ident.ts`: `$`, also an ASCII digit or letter the pattern leaves out) ends at such a
unit in every lexer: the interpreter extends an identifier the pattern cut short only when it stopped
at a unit beyond ASCII (`LX_UNI_CONT`), as the portable lexers do (`lxExt`), so the token's pattern
decides where an ASCII run ends; an extension, once begun, takes the whole IdentifierPart run
(`na|ïve`, `aé$`). Witness: an identifier `[a-z_][a-z0-9_]*` and the text `a$` (every lexer: `a`, then `$`
by the Unicode fallback; rows in `test/lexer-verify.ts`). No shipped grammar shows it: every
real identifier pattern takes `$` and all ASCII identifier characters.
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
against 142.3 on `checker.ts` and 158.6 on `gen-textmate.ts` through the typescript parser; the
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
  keep their form: TS `parse` throws, Go `ParseWith` panics with the `*LexError`, Rust
  `parse_with` / `parse` panic with the message. An incremental `Doc` exists for any text: a text
  that does not lex, at creation as after an edit, gives a Doc with no tree and no tokens whose
  lexer error is its accessor's value (offset and message, the values `tokenize` reports), and
  its next edit relexes the whole text. TS `createDoc`, Go `NewDoc` / `NewDocWith` and Rust
  `Doc::new` threw / panicked on such a text before (until `land/sound-doc-total`):
  - TS: `const d = createDoc(src);` then `d.root() === null`, `d.lexError()` → `{ off, message }` (null when it lexes);
  - Go (`Doc` and `DocWith`, the `Document` interface): `d := NewDoc(src)` then `d.Root() < 0`, `d.LexError()` → `*LexError{Off, Msg}` (nil when it lexes);
  - Rust: `let d = Doc::new(src)` then `d.root_handle().is_none()`, `d.lex_error()` → `Option<&LexError>` (`off`, `msg`).
  A recovering emission (`{ recovery: true }`) does not change this: its `parseTotal` gives no
  root and the lexer's error as its one diagnostic for such a text, and the `Doc` parses strictly.
  Inside the portable lexers an error is a returned value, never a throw or panic used for
  control flow.
- Total parsing is an emit option: `emitParser(grammar, target, { recovery: true })` appends a
  region to the module (the default emission is unchanged: all of it is in the module, in order;
  the TypeScript module also has the helpers and variables only the region reads, which the
  default one leaves out; without the option the entry below does not exist). It adds TS
  `parseTotal(src, builder) -> { root, errors }`, Go `ParseTotal(src, b) (h, ok, errs)`, Rust
  `parse_total(src, &mut b) -> (Option<H>, Vec<Diagnostic>)`. It never throws or panics on input:
  an accepted text gives `parseWith`'s root and no errors; a text the parser rejects gives a tree
  all the same, with its repairs: zero-width `$missing` nodes where a literal, a token or an
  operand the parse required is absent, `$error` nodes over tokens it skipped, and one diagnostic
  `{ offset, end, message, related? }` per repair, in order (a text the lexer refuses gives no
  tree and the lexer's error). The error of the strict parse comes with them (TS `strict`). It is
  the interpreter's primary error: the token where the entry rule stopped
  (`unexpected 'x'`, with `after successful parse` when the entry rule consumed tokens and input
  is left over). Its related location is the furthest token the parse examined, when that lies
  past the error. That token is usually the interpreter's `[farthest: …]` token, but not always:
  the interpreter counts the tokens a match advanced past, and the engine also counts a guard's
  read of the next token. Messages come from one formatter (`src/ir/recovery-family.ts`). Go and
  Rust spans are byte offsets. How good the recovered trees are is measured (not gated) on the
  seeded mutation corpus (`test/portable-recovery.ts`: each accepted list input with one token
  deleted, inserted or replaced; the rejected mutants, TS target). DAMAGE: the share whose
  `$error` nodes (all of them) hold more than N tokens. STABILITY: the share whose tree outside the
  damaged region (the edit's span widened over every `$missing` and `$error`) is the original
  text's: the top-level entries wholly before and wholly after it, in order, node kinds and
  leaves alike. The FALLBACK share: an `$error` child of the root (an entry skipped whole).

  | grammar (rejected mutants) | damage N = 1 | N = 3 | N = 5 | stable | fallback |
  |---|---|---|---|---|---|
  | javascript (787) | 25.0% | 14.0% | 8.6% | 75.3% | 33.9% |
  | typescript (1827) | 22.6% | 12.7% | 7.9% | 76.8% | 28.7% |

  The option also carries the parse plan as one int table (`parser-ir.ts` recoveryTables) and
  ONE interpreter of it (`src/ir/recovery-family.ts`, printed for each target), which later stages
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
that regex would ([`src/grammar/lex-match-plan.ts`](../src/grammar/lex-match-plan.ts)), and
[`test/lex-family.ts`](../test/lex-family.ts) checks every scanner against its token's regex.

## AST shapes

`emitTs(grammar, { shape })` ([`src/targets/target-ts.ts`](../src/targets/target-ts.ts)) and
`emitRust(grammar, { shape })` ([`src/targets/target-rust.ts`](../src/targets/target-rust.ts)) append a
declarative AST layer (`parseAst`) to the CST parser. The Go target has none. Spec format,
primitives and contracts: [SHAPE.md](SHAPE.md). Gates: `shape-rust`,
`shape-parity`, `builder-reuse`.
