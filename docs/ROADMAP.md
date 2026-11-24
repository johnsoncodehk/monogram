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

**Why.** There are two execution paths today besides the interpreter (`src/interpreter.ts`, the
reference): the emitted JavaScript parser (`jsTarget`: `src/target-js.ts`, with the lexer
emitter in `src/lexer.ts`) and the portable targets (`tsTarget`, `goTarget`,
`rustTarget`: `src/parser-ir.ts` plus one printer each in `src/target-*.ts`). The shared
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
`incremental-grammars`, `exhaustive-edits`, `diagnostic-labels`,
`target-js-verify`, `emit-reject-messages`,
`emit-reentrancy`, `emit-standalone`, `cst-match-totality`, `template-holes`,
`nullable-rules`, `conformance/html` (engine parity), the JS rows of `alloc-work`, and the
benches `test/head-to-head.ts` and `test/recovery-conformance.ts`. The project listed under
"Used by" ships the TextMate grammars and the language configuration, not a parser. The
interpreter and several gates use `compileTokenizer` from `src/lexer.ts` as their lexer,
so that part of the file is not retired with `jsTarget`.

**Done means:** the three printers hold only their language's spelling (syntax, type spelling,
compiler facts with a reason each) over one shared runtime description; the portable TS target
has every row of the table above; `jsTarget` and its gates are gone, the gates ported to the
portable targets.
Acceptance: adding a target means writing one renderer.

## 2. Editor artifacts derived from grammar data, not built-in vocabulary

**Why.** The highlighters are what the project's user ships, and what the first outside
evaluation asked for. That evaluation (a TSX dialect; reproduced on master `1d41fb2`) found the
parser accepts each dialect form but every form fails in at least one generator: 26 of its 38
editor test cases fail and innermost-scope agreement is 80.0%. The causes are in the engine:

- `src/gen-textmate.ts` detects element syntax from the grammar, then emits a fixed repository of
  patterns that reads no rule (`generateJsxPatterns`), so a dialect's additions never reach
  the output; JSDoc has a built-in sub-grammar in the same way. No gate checks the generators
  for language-specific code; `test/agnostic.ts` covers the parser.
- A token-stream grammar cannot enter a text or raw-text region for one construct. The parser's
  JSX child is `Ident | Number | String` and a few punctuators, so `<p>Don't</p>` is a parse
  error in Monogram's own TSX grammar; embeds (`source.css` in `<style>`) exist only in
  whole-file markup mode.
- tree-sitter node names are the rule names (one `expr` node for every expression), only two
  field names exist, and only `highlights.scm` is generated. Generating the TypeScript and TSX
  parsers costs about 12 CPU-minutes each (10,085 and 12,847 states) against 5 s for
  JavaScript.
- `gen-textmate`'s alternative expansion runs out of memory on some grammar shapes (a second
  decorator run on class members), which has forced grammar rules to be written as lookahead
  instead of structure.

**Plan.** Gates first (in place since PR #153: a dialect fixture and generator-agnosticism
checks with their expected failures recorded, captures-with-`patterns` counts pinned, all six
tree-sitter packages built with every query compiled); then keyword boundaries from each
literal's own characters, scope names as data, bounded alternative expansion, tree-sitter node
and field names from the grammar's `arm` / `field` names, and **lexer regions declared in the
grammar**: nested text and raw-text regions with embeds, of which whole-file markup is the
special case. Lexer regions are also what the portable targets need to stop refusing markup
grammars (item 1) and what fixes TSX's own text.

**Done means:** every expected-fail row of the dialect and agnosticism gates passes; no
generated TextMate grammar has a capture with `patterns`; element patterns come from the
grammar's rules; a dialect's grammar file is all a dialect needs.

## 3. Second-language proof

**Why.** Everything measured so far is the TypeScript / JavaScript family, whose grammars and
engine grew together. Whether the design holds for other languages is unknown until a grammar
of a different family runs on it untuned.

**Plan.** A grammar from a different language family, with no language-specific tuning of the
engine or the printers, compared against that language's fastest hand-written parser.
Scheduled after the shared layer (item 1) converges.

A first, partial result exists: the TSX dialect of item 2. The parser side held (each dialect
form parses; whole files fail only where text regions are needed); the generators did not.

**Done means:** the gap is known and published.

## 4. Decisions made at generation time, and a grammar that means what it says

**Why.** A parser's least work is one look at each token and one construction of each node;
anything more is the parser finding out at run time what the grammar could have told the
generator. Measured on `checker.ts` (master before this item): two candidates both succeed in
2.2% of choices, yet 31% of rule calls happen inside attempts that are thrown away, almost all
of them candidates that provably fail on their first one or two tokens (an expression is
attempted at every statement and fails 39,829 times out of 44,949). That is about the size of
the parser-side instruction gap to a hand-written parser. The same missing analysis is why the
engine lacks what the specification's notation has, and the grammar imitates it with lookahead
or duplicated arms.

**Plan.**

- **Refutation guards**: a candidate that cannot match the buffered token is not attempted.
  First piece: a candidate's leading one-token tests become its guard (PR #157); then
  complement guards for unguarded candidates, guards on repetition bodies, two-token guards
  where they pay. The interpreter keeps full longest match and takes no guard; gates check every
  refusal against it.
- **Committed choices**: where the analysis proves one viable alternative, take it without a
  candidate frame.
- **A build-time decision report** per grammar: for each choice point, decided by one token,
  by two, by declaration order, by longest match (with a witness), or dead. A first run found
  alternatives that can never win (the keyword types shadowed by the identifier arm) and four
  ambiguities resolved only by arm order.
- **Parameterised productions, completed**, as the notation of the specification rather than
  per-case engine features: `[In]` (today `exclude('in', …)` at each `for` head site); the
  `[Yield]` / `[Await]` line-break and assignment cases (`function* g() { yield⏎* x; }` parses
  today); module-level `await`; and "left context" as a parameter (`Decl[±Prefixed]` for the
  decorator and modifier placement cases owed in `typescript.ts`).
- **Cover grammars.** Arrow parameters and a parenthesised expression are two arms, each parsed
  in full; a cover grammar parses the text once and decides after.
- **Total parsing in the portable engine** follows from committed choices: the expected set at
  a failure is the failing decision's keys, and recovery synchronises on what may follow.

**Done means:** the decision report exists for every grammar and has no unexplained entry; each
listed case is expressed by a mechanism, its grammar workaround deleted, and the case is a
test; the portable parsers recover from errors.

## 5. Output contract: grammar plus shape spec

**Why.** The grammar is shape-agnostic: one grammar must be able to give a tsc-shaped AST and
ESTree, each consumer writing only a spec. The first spec format ([SHAPE.md](SHAPE.md)) binds by
position and arm index, needs hand-written functions, and had never been compared with a
reference parser (its ESTree-like fixture matched acorn on 0 of 1,330 files).

**State.**

- Stable names in the grammar API (`arm(name, …)`, `field(name, item)`), transparent to every
  parser and carried by the portable IR (PRs #146, #152).
- Spec v2 (`src/shape2-schema.ts`, `src/shape2-eval.ts`): a closed calculus over those names:
  a node's value synthesized from its arm's named children, synthesized and inherited scalar
  attributes, a fixed operator set, no escape to code; a reference interpreter and a load-time
  type check (PR #151).
- An oracle harness against `tsc` and acorn, and a recorded scoreboard (PRs #146, #155). On the
  expression subset, two declarative specs over the one grammar: ESTree equals acorn on 36,360
  of 37,081 expression statements of real JavaScript (98.1%; the rest is one recorded gap, the
  directive prologue), and the tsc shape equals `tsc` on 9,478 of 9,490 (99.9%; the 12 are
  grammar defects).

**Plan.** Statements, declarations and types in both shapes, scored per statement and per
file; then the spec compiled at generation time and fused into the engine plan, so a rule
function constructs the consumer's typed node directly (a CST is one shape among others);
incrementality declared in the spec for representation choices only (positions, shareable
nodes, parent pointers) and derived otherwise from the calculus's dependencies.

**Done means:** two reference shapes, a tsc-shaped AST and ESTree, each equal node for node to
its reference parser on the recorded corpora; specs bind by name only; the shape layer is
generated from the shared layer for all three targets and the first format is deleted.

## 6. test262 as JavaScript's oracle

**Why.** JavaScript syntax follows the ECMAScript productions ([CORRECTNESS.md](CORRECTNESS.md)).
`tsc` is the oracle for TypeScript-only syntax only; measured against `tsc`'s JS-mode parser
(the former `JS-CONFORMANCE.md` record) the remaining disagreements are mostly where `tsc`'s
parser accepts what the specification rejects.

**Done means:** a gate runs `javascript.ts` over test262's syntax tests (positive and negative
parse cases), with a pinned record of every file in the style of the former `JS-CONFORMANCE.md`.

## 7. Every target measured on every pull request

**Why.** A change that improves one target and leaves the others behind must show on the pull
request that makes it (the first day of Go instruction counts found 17% of a Go parse inside
the map runtime). A wall-clock number without the CPU model is not evidence ([MEASUREMENT.md](MEASUREMENT.md)).

**State.** In place since PR #140: the profile job's summary has, per input, Rust and Go
instruction counts and TypeScript / JavaScript block-execution counts and allocations side by
side, A against M, lists single-target changes, and names the runner's CPU. Block counts detect
a change of control flow, not its cost or direction. Fresh-mode Go and a deterministic cost
measure for V8 are still missing.

## 8. Speed, memory and size

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
- **JavaScript productions still accepted against the specification** and the remaining
  TypeScript-only gaps against `tsc`'s parser: recorded per case in [CORRECTNESS.md](CORRECTNESS.md)
  and the grammar files; several wait on item 4.

## Not planned

**Lezer.** Monogram's backtracking grammar can't be mechanically derived into Lezer's
build-time LR(1) automaton (combinatorial table blowup and unresolvable `<` ambiguity
conflicts); tree-sitter's runtime GLR absorbs it instead.
