# Roadmap

The aim: write one grammar, get a proven parser in each target language in the same class as
the best hand-written parser for that language, plus highlighters.

The shape is that of compiler infrastructure: a grammar is a front end (one per source
language), analysis and the IR are the middle where optimisations live (done once, every
language and target benefits), and a printer is a back end (one per target language) that
should only spell IR operations in its language. Today the back ends are still thick; item 1
makes them thin.

The direction, in order. Each item says why, and what "done" means, so a pull request can say
which item it advances and a reader can check when an item is finished. What exists today is
in the [README](../README.md#what-you-get).

## 1. One portable engine, one shared runtime description

**Why.** There are two execution paths today besides the interpreter (`src/gen-parser.ts`, the
reference): the emitted JavaScript parser (`jsTarget`: `src/emit-parser.ts`, with the lexer
emitter in `src/emit-lexer.ts`) and the portable targets (`tsTarget`, `goTarget`,
`rustTarget`: `src/emit-portable.ts` plus one printer each in `src/target-*.ts`). The shared
layer of the portable targets covers the analysis, the parse plan (`ParserIR`), the token
scanners (`src/lex-family.ts`, `src/lex-match-plan.ts`) and the re-lex family
(`src/relex-family.ts`, through `src/algo-ir.ts`). The rest of each printer is a hand-written
copy of the same runtime in its language: the lexer main loop and its per-mode state, the
builder protocol and default builders, the parser engine's step walk and candidate frames, and
the incremental `Doc`. A mechanism added to one printer has to be written again in the other
two, and the copies drift.

**Plan.**

- The TypeScript target already runs on one builder-engine design, the Rust one: one child
  stack, integer marks, a node's children array allocated once at its size (PR #139).
- Algorithms over arrays, records and scalars (the lexer loop, incremental reuse and `Doc`
  orchestration, default builder bodies, the CST JSON writer) move into `algo-ir`, which needs
  a few more constructs for it (declared records, `switch`, `continue`, stack operations, bit
  operations, extern calls, an attempt-else-fallback block).
- The parser engine becomes a target-neutral **engine plan**: per rule, a list of tests,
  dispatches and frames (branch, candidate, star, opt, sep, lookahead, context), lowered once
  from `ParserIR`. Each printer supplies one function per frame kind. Frame spelling stays
  per target where it is a fact of that compiler (for example Rust's candidate macro, Go's
  inline budget), each with a stated reason.
- Each step is gated on byte-identical emitted output where it is a pure move, and on the
  measurement records where output changes.

**Retire `jsTarget`** once the portable TypeScript target covers what it does. Today
`jsTarget` has, and the portable targets do not:

| `jsTarget` capability | portable targets today |
|---|---|
| Total parsing: error recovery, `errors` with `expected …` messages and related spans, zero-width `$missing` nodes, diagnostic labels ([TOTAL-PARSING.md](TOTAL-PARSING.md)) | a rejected input gives `null` (TS) or a reject; no recovery |
| Indent-mode grammars (`yaml.ts`) | refused by `buildIR` |
| Markup grammars (`html.ts`) | refused by `buildIR` |
| Incremental editing for all six grammars, gated by `incremental-grammars` | `Doc` for token-stream and newline grammars |
| The arena handle API: `visit` / `tree` / `tokenAt`, isolated documents through `createParser()` | plain-object CST (TS), builder arenas (Go, Rust) |
| The generated destructurers `<name>.cst-match.ts`, which read the `jsTarget` arena through its `tree` export (`src/gen-cst-match.ts`) | none |

Who depends on `jsTarget` in this repository: the gates `recovery`, `multi-doc`,
`incremental-verify`, `incremental-grammars`, `exhaustive-edits`, `diagnostic-labels`,
`emit-parser-verify`, `emit-reject-messages`, `emit-tsc-gate`, `emit-tokenize`,
`emit-reentrancy`, `emit-standalone`, `cst-match-totality`, `template-holes`,
`nullable-rules`, `conformance/html` (engine parity), the JS rows of `alloc-work`, and the
benches `test/head-to-head.ts` and `test/recovery-conformance.ts`. The project listed under
"Used by" ships the TextMate grammars and the language configuration, not a parser. The
interpreter and several gates use `compileTokenizer` from `src/emit-lexer.ts` as their lexer,
so that part of the file is not retired with `jsTarget`.

**Done means:** the three printers hold only their language's spelling (syntax, type spelling,
compiler facts with a reason each) over one shared runtime description; the portable TS target
has every row of the table above; `jsTarget` and its gates are gone, the gates ported to the
portable targets.
Acceptance: adding a target means writing one renderer.

## 2. Second-language proof

**Why.** Everything measured so far is the TypeScript / JavaScript family, whose grammars and
engine grew together. Whether the design holds for other languages is unknown until a grammar
of a different family runs on it untuned.

**Plan.** A grammar from a different language family, with no language-specific tuning of the
engine or the printers, compared against that language's fastest hand-written parser.
Scheduled after the shared layer (item 1) converges.

**Done means:** the gap is known and published.

## 3. Engine expressiveness instead of grammar workarounds

**Why.** Where the engine lacks a mechanism the specification uses, the grammar imitates it
with lookahead or duplicated arms. That costs work at parse time, makes the grammar harder to
read than the specification, and leaves cases uncovered.

- **Parameterised productions, completed.** `[Await]` / `[Yield]` exist as contexts
  (`awaitCtx`, `yieldCtx`; one context word in the portable parsers). Still owed:
  - `[In]`, today imitated by `exclude('in', …)` at each `for` head site (`forHeadArms` in
    `javascript.ts`);
  - the `[Yield]` / `[Await]` line-break and assignment cases: `javascript.ts` reads `await`
    and `yield` as unary prefix operators (`ecmaPrec`) beside a `yield` arm, where the
    specification has YieldExpression at AssignmentExpression level with
    `[no LineTerminator here]` before its `*` or operand (so `function* g() { yield⏎* x; }`
    parses today);
  - module-level `await`: at a script's top level `await (1,);` parses as a call of an
    identifier `await`; a Module goal, where `await` is reserved, is not modelled.
- **Cover grammars.** Arrow parameters and a parenthesised expression (`(a, b)` until `=>`)
  are two arms, each parsed in full; a cover grammar parses the text once and decides after.
- **Left context.** The decorator and modifier placement cases listed as owed in
  `typescript.ts` (the declaration prefix comment before `classDecls`, and the member
  decorators' second run) each need to know what came before the arm.

**Done means:** each listed case is expressed by an engine mechanism, the grammar workaround it
replaces is deleted, and the case is a test.

## 4. Output contract: grammar plus ShapeSpec

**Why.** The grammar is shape-agnostic: one grammar must be able to give a tsc-shaped AST and
ESTree. A consumer supplies a `ShapeSpec` ([SHAPE.md](SHAPE.md)). Today a spec binds partly by
position and arm index (`{ at: n }` fields, `altIndices`, `ctx.altPath`), so a grammar change
that reorders or adds an arm can change an AST; grammar edits have kept arm order for that
reason (`typescript.ts`, `Param`, commit `2b2f65f`). That coupling is a defect.

**Done means:**

- stable arm and child names in the grammar API, and shape specs that bind by name only;
- two reference shapes as proof, a tsc-shaped AST and ESTree, each checked node for node
  against its reference parser (`tsc`; an ESTree parser);
- the shape layer generated from the shared layer for all three targets (today TS and Rust
  have one, Go none).

## 5. test262 as JavaScript's oracle

**Why.** JavaScript syntax follows the ECMAScript productions ([CORRECTNESS.md](CORRECTNESS.md)).
`tsc` is the oracle for TypeScript-only syntax only; measured against `tsc`'s JS-mode parser
([JS-CONFORMANCE.md](JS-CONFORMANCE.md)) the remaining disagreements are mostly where `tsc`'s
parser accepts what the specification rejects.

**Done means:** a gate runs `javascript.ts` over test262's syntax tests (positive and negative
parse cases), with a pinned record of every file in the style of `JS-CONFORMANCE.md`.

## 6. Every target measured on every pull request

**Why.** The per-PR `profile` job gives Callgrind instruction counts for Rust only. Go and TS
have allocation counts (`alloc-work`) and on-demand timing (`measure-targets`), but no work
measure: a change that improves Rust and leaves Go and TS behind shows in no Go or TS record.
A wall-clock number without the CPU model is not evidence ([MEASUREMENT.md](MEASUREMENT.md)).

**Done means:** the profile job's summary has, per input, a deterministic work count for Rust,
Go and TS side by side, A against M, and every wall-clock figure the project records names the
runner's CPU.

## 7. Speed, memory and size

Speed, memory and emitted size are all goals; none is absolute. A trade-off is judged case by
case on measured numbers (instructions, allocations, page faults, emitted bytes) and reported
with them.

A separate compact or table-driven target is not on the roadmap at present: the runtime is
being moved into the shared layer first (item 1), and after that a new target is one renderer.

## Also open

- **More vscode#203212 bundles**: low-effort first (ini, diff, git config, xml); the large ones
  (ruby, perl, c/c++, groovy) each need an instrumentable official parser and a corpus.
- **Incremental lex for stateful grammars**: token-stream grammars re-lex only a local window
  around an edit, but indent, markup and newline grammars re-lex from the file head on every
  edit, because their lexer carries cross-line state (indent stack, flow depth, markup mode)
  that no token records.
- **Highlighter long tail**: where a construct provably exceeds the TextMate model, the derived
  tree-sitter target resolves it ([HIGHLIGHTER-EVIDENCE.md](HIGHLIGHTER-EVIDENCE.md#the-ceiling-and-the-bar-for-claiming-it)).

## Not planned

**Lezer.** Monogram's backtracking grammar can't be mechanically derived into Lezer's
build-time LR(1) automaton (combinatorial table blowup and unresolvable `<` ambiguity
conflicts); tree-sitter's runtime GLR absorbs it instead.
