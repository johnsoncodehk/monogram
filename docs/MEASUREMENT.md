# Measuring performance

What the project has learned about its own measurements, and the harnesses that apply it. Every
performance claim in a pull request or in the README comes from one of these, run in CI.

## What decides what

- **Instruction counts decide a logic change.** Callgrind counts are deterministic: the same
  commit gives the same count on any runner. A change that deletes work shows as fewer
  instructions; one that does not, does not.
- **But a Rust total moves with code layout, by up to about 1% of a parse.** In a function of
  thousands of instructions (`Expr_nud` is about 13k; the lexer's dispatch function likewise) any
  change, even a cold call site out of line, makes LLVM assign registers differently: single-stepping
  two builds showed the same branches taken and the cost per call moved by up to about ±10
  instructions, in a different direction on different inputs (PR #184). So for a change to parser or
  lexer logic, read in this order: (1) the work counters: a change that removes work is durable;
  (2) the Rust totals over the real inputs as a set (`checker.ts`, `typescript.js`, `parser.ts`,
  `typescript.d.ts`, `gen-tm.ts`, `typescript.ts`): the set must not get worse, and no real input
  may rise by more than about 0.3% without an explanation; the synthetic stress inputs
  (`dense-semi`, `dense-plus`, `nonascii`, `synth2mb`) are reported and may move inside that band;
  (3) an input that moves against the counters gets the per-function Callgrind (the full-scope
  profile), which says whether it is work or layout (same call counts, cost per call changed).
  Go instructions and TS block counts have no such band: a rise there is real.
- **For a change in memory behaviour, instructions are blind**: allocator calls and bytes and page
  faults decide. (PR #126: instructions flat, wall-clock +46%, explained entirely by page faults.)
- **Work counters** (tokens, nodes pushed, checkpoints, restores, peeks) say what the parser did.
  They are identical between two commits unless the grammar or the parser's search changed.
- **Wall-clock ratios between jobs are not comparable.** The same commit's ratio to oxc differed by
  25-40% between two runs: runner hardware. Only ratios inside one job, from alternating rounds,
  compare; and inside one job, moves of up to 5% without instruction-count support have been
  code-layout noise.
- **Every target is measured on the same inputs, side by side.** An improvement belongs to the
  generator, so a change that moves one target and not the others is listed in the profile's
  summary as "single-target". Go: Callgrind instructions of one `ParseWith`, comparable to Rust's
  (the Go runtime's own work inside the parse, allocation and growth, is included). TS target and
  emitted JS parser: V8 has no deterministic instruction count with the JIT on, so they are measured
  by V8 precise block coverage with counts: the block executions of one parse. That is exact and
  sees control flow (a loop that does fewer rounds, a lookup that becomes a switch, a copy removed),
  but not the cost inside one block (a string slice against a byte read is the same block count),
  and V8 reports a block that always runs with its function as part of the function's count. It
  detects a change of control flow, not its cost or direction: on PR #141 block counts rose 7-10%
  while time fell 10-28% and allocations 27%. So the exact allocations of the same parse
  (`test/bench-targets/allocs.ts`, alloc-work's counting) are reported beside them.
- **Go under Callgrind is deterministic only when built and run as the harness does**:
  `-tags faketime` (the runtime's clock stands still; with a real clock sysmon preempts the parse
  every 10 ms of wall time and the scheduler's work lands inside the measured region as often as
  Valgrind's speed allows), `GOGC=off GOMAXPROCS=1 GODEBUG=asyncpreemptoff=1`, and collection
  toggled by a client request around the parse (`--toggle-collect=<function>` ends early: Callgrind
  tracks returns by the stack pointer, and the Go runtime switches stacks). What remains random is a
  Go map's hash seed: a lookup's instructions differ between runs (up to 0.5% of a parse of
  `checker.ts`), their number does not. The Go column counts every instruction of the parse, and
  beside it the number of calls into the map runtime (`test/bench-targets/go-ir.ts`), which must be
  0 for the count to repeat: the Pratt operator tables were the last maps on the typescript
  grammar's parse path (PR #144); a parse that reads one does not repeat, and its cell is reported NOT RUN. Only
  reuse mode (a parse into the builder of a first one) is measured: a first parse into a new
  builder varied by up to 0.14% between runs in the page allocator's search
  (`runtime.(*pageAlloc).find`), with or without address randomization; a fresh parse's
  allocations are reported in `docs/ALLOCATIONS.md` (regenerated on master). The profile measures M twice; a Go / TS / JS cell whose
  two measurements differ by more than 0.01% is reported NOT RUN in the summary, without failing
  the job (the pull request may not touch the code it measures).
- **The fair comparison with oxc is reuse mode on both sides**: one kept `CstBuilder`
  (`parse_with`) against one `Allocator` `reset()` before each parse. Fresh mode (a new builder /
  allocator per parse) is reported beside it.

## The harnesses

| What | Where | When |
|---|---|---|
| Rust: instructions (Callgrind) per parse in both modes, lexer alone, work counters, allocator calls / bytes, page faults, peak; emitted sizes of every target | `test/bench-rust-profile/run.sh` (`PROFILE_SCOPE=pr`), `test/emit-sizes.ts`, report `test/bench-rust-profile/pr-summary.ts`; workflow `measure-profile` | every pull request touching `src/**`, a grammar file or the harness; A = merge base, M = head; the job summary shows the tables |
| Go target: Callgrind instructions per parse (reuse), through the direct engine (`CstBuilder`) and the builder engine (`SlimBuilder`); TS target and emitted JS parser: V8 block executions per parse; side by side with Rust per input, single-target changes listed | the same `run.sh` (section "Go and TS targets"), `test/bench-targets/go-main.go` (`count-*` modes), `test/bench-targets/blocks.ts`; on the main inputs | in the same `measure-profile` job |
| The same plus oxc beside A and M, native timings, phase regions, cache / branch simulation | the same `run.sh` with `PROFILE_SCOPE=full` | on demand: the `measure-profile-full` label on a pull request, or `measure-profile` workflow_dispatch with scope `full` |
| Rust wall-clock vs oxc: alternating rounds in one job, medians and per-round ratios, one job per mode | `test/bench-rust-oxc/run.sh` (`BENCH_BASE`, `BENCH_EXTRA`, `BENCH_GRAMMAR`, `BENCH_MODE`); workflow `measure-bench` | on demand: workflow_dispatch, or the `measure-bench` label on a pull request |
| TS target, emitted JS parser, Go: allocations and bytes per token and per node, by site, result vs overhead, reported in `docs/ALLOCATIONS.md` | `test/alloc-work.ts --write` (`test/alloc-instrument.ts`); the gate `alloc-work` checks only linearity and Go reuse = 0 | the report: the README auto-regen workflow on every master push that touches `src/**` or a grammar; the gate: every CI run |
| TS / JS / Go wall-clock A/B: alternating rounds in one job, a fresh process per measurement, medians and per-round ratios | `test/bench-targets/run.sh` (`TARGETS_BASE`, `TARGETS_COMMIT`, `TARGETS_GRAMMAR`, `TARGETS_ONLY`); workflow `measure-targets` | on demand: workflow_dispatch, or the `measure-targets` label on a pull request |

Failure policy of the pull-request profile: a measurement the harness did not produce fails the
job (NOT RUN is never a pass); a Go / TS / JS measurement that did not repeat is shown as NOT RUN
and does not fail it. A regression does not fail it (a threshold on instructions would be
arbitrary, and a grammar change legitimately changes work); it is listed at the top of the summary:
any input whose instructions rise by more than 0.5%, any rise in allocator calls per parse in reuse
mode, any emitted size up by more than 1%; and, separately, every input on which one target moves by
more than 0.1% while another stays within 0.01%.

Emitted sizes also have a RECORD, `docs/emit-sizes.json` (grammar × target, an emit option as
`<target>+<option>`), so that growth made of steps each under 1% accumulates visibly (Go +18% in
two days, 0016998 → d326d65, was seen only afterwards). The profile summary prints M against the
record beside A → M and lists a size more than ±0.25% from its record as a regression; that listing
is the check (it is not a gate of `node test/check.ts`, where it made unrelated landings re-record).
A landing that changes a size on purpose re-records with `node test/emit-size-record.ts --write`
and says why in its message: that diff is where the drift so far is accepted.

The inputs are fixed: `checker.ts` and `parser.ts` of TypeScript at the repository's one pin
(`TS_REPO_SHA` in the workflows), `typescript.js` / `typescript.d.ts` of the locked `typescript`
npm package, `gen-tm.ts` and `typescript.ts` of this repository as of `2632c2c`, a 2 MB synthetic
file, a non-ASCII-heavy file and two dense one-byte-token files. Three element inputs
([`test/bench-rust-profile/element-inputs.ts`](../test/bench-rust-profile/element-inputs.ts)):
`jsx-corpus.tsx` and `jsx-corpus.jsx`, the element code of the pinned tsc corpus's JSX
conformance cases, parsed by typescriptreact and javascriptreact; and `gen-tm.tsx`, the text of
`gen-tm.ts` parsed by typescriptreact, the control: the same tokens and tree as `gen-tm.ts`
through typescript, so its difference is what the element machinery costs code outside any
element.

## Recorded result: Rust against oxc

What is compared: monogram's Rust parser builds a **CST** (every token is a leaf) with the
`typescript.ts` grammar; [oxc](https://github.com/oxc-project/oxc) builds a typed **AST**. They
are not the same product, so a ratio compares two kinds of work on the same input, both parsing
as TypeScript. Which of the two costs more to build has NOT been measured here (an earlier
version of this page said a CST is the cheaper one; that was an assumption: a CST keeps every
token as a leaf, an AST drops most of them); a like-for-like figure needs a monogram parser that
builds an AST directly, which is in progress (builders generated from a `defineShape` shape).

Method: [`test/bench-rust-oxc`](../test/bench-rust-oxc/run.sh) against `oxc_parser` 0.126.0:
both parsers in one GitHub-hosted job, 9 alternating rounds, the median of the per-round time
ratios; instruction counts from [`test/bench-rust-profile`](../test/bench-rust-profile/run.sh)
(Callgrind, one parse plus the drop of what it built). Only ratios inside one job compare.
Reuse mode is the like-for-like mode for memory: one `CstBuilder` kept across parses
(`parse_with`) against one oxc `Allocator` `reset()` before each parse; fresh mode is a new
builder / allocator per parse.

### monogram `bf18adc` (2026-11-23)

Time: `measure-bench` run 45244727475 (both modes on AMD EPYC 9V74). Instructions:
`measure-profile` full scope, run 45242296642 at `7b713ea` (AMD EPYC 7763); no commit between
`7b713ea` and `bf18adc` changes an instruction count (`bf18adc`'s own profile: every input equal
to its base). oxc accepted every input in the table (an input either parser rejects gets no
ratio). Time per parse and instructions per parse, monogram ÷ oxc (below 1: monogram takes less):

| input | time, reuse (range over 9 rounds) | time, fresh | instructions, reuse | instructions, fresh |
|:--|--:|--:|--:|--:|
| `checker.ts` (TypeScript compiler, 3.2 MB) | 0.776 (0.754-0.786) | 0.849 | 0.885 | 0.889 |
| `typescript.js` (npm `typescript` 5.9.3, 9.1 MB) | 0.763 (0.759-0.774) | 0.802 | 0.881 | 0.882 |
| `parser.ts` (TypeScript compiler) | 0.746 (0.741-0.749) | 0.837 | 0.881 | 0.897 |
| `typescript.d.ts` (npm `typescript` 5.9.3) | 0.812 (0.809-0.821) | 0.789 | 1.005 | 1.022 |
| 2 MB synthetic file | 0.746 (0.712-0.762) | 0.889 | 0.919 | 0.921 |
| non-ASCII-heavy file | 0.689 (0.668-0.696) | 0.848 | 0.875 | 0.909 |
| [`src/gen-tm.ts`](../src/gen-tm.ts) at `2632c2c` | 0.768 (0.760-0.772) | 0.980 | 0.910 | 0.929 |
| [`typescript.ts`](../typescript.ts) at `2632c2c` | 0.645 (0.633-0.662) | 0.481 | 0.717 | 0.780 |
| dense `;` (1 MB of empty statements) | not timed | not timed | 0.966 | 0.968 |
| dense `a+a+…` (1 MB) | not timed | not timed | 0.805 | 0.806 |

How to read it:

- Monogram's parse takes less time than oxc's on every timed input in both modes, and executes
  fewer instructions on nine of the ten counted inputs; `typescript.d.ts` (type declarations) is
  level (0.5% more in reuse mode, 2.2% more in fresh mode).
- On `checker.ts` monogram runs 103.3M instructions per parse, oxc 116.7M.
- Time ratios depend on the runner's CPU model: one day earlier, `cdf0e6b` on an Intel Xeon 6975P-C gave
  0.680 to 0.860 in reuse mode (run 45222935238; `checker.ts` 0.805). Compare time ratios only
  within one job; the instruction columns are the stable ones.
- The products differ (CST against AST), as stated above; this is not a like-for-like claim.
- Not in the table: the TSX and JSX inputs. The oxc side of the harness parsed every file as
  plain TypeScript, so oxc rejected both, and a ratio printed for them would compare a parse
  with a rejection. The harness is being changed to take the source type from the file
  extension and to print a ratio only when both parsers accept; those rows are recorded after
  that.

### monogram `e6cc55c` (2026-11-22)

`measure-bench` run 45042153759 (reuse: AMD EPYC 9V45; fresh: AMD EPYC 9V74) and
`measure-profile` full scope, run 45042161482. Time per parse and instructions per parse,
monogram ÷ oxc (below 1: monogram takes less):

| input | time, reuse (range over 9 rounds) | time, fresh | instructions |
|:--|--:|--:|--:|
| `checker.ts` (TypeScript compiler, 3.2 MB) | 0.908 (0.870-0.935) | 0.922 | 1.03 |
| `typescript.js` (npm `typescript` 5.9.3, 9.1 MB) | 0.891 (0.868-0.917) | 0.872 | 1.04 |
| `parser.ts` (TypeScript compiler) | 0.898 (0.863-0.912) | 0.914 | 1.04 |
| `typescript.d.ts` (npm `typescript` 5.9.3) | 0.941 (0.915-0.982) | 0.839 | 1.13 |
| 2 MB synthetic file | 0.916 (0.876-0.953) | 1.032 | 1.10 |
| non-ASCII-heavy file | 0.733 (0.716-0.745) | 0.953 | 1.05 |
| [`src/gen-tm.ts`](../src/gen-tm.ts) at `2632c2c` | 0.882 (0.873-0.904) | 1.048 | 1.04 |
| [`typescript.ts`](../typescript.ts) at `2632c2c` | 0.723 (0.700-0.741) | 0.549 | 0.91 |
| dense `;` (1 MB of empty statements) | not timed | not timed | 1.34 |
| dense `a+a+…` (1 MB) | not timed | not timed | 0.99 |

How to read it:

- On these inputs and these two CPU models monogram's parse takes less time than oxc's in reuse
  mode on every timed input, while executing 3% to 13% more instructions on seven of those eight. Both hold at
  once because the cost per instruction differs; an earlier run of an older commit on an Intel
  Xeon ordered one input the other way. The ratios are not a property of the parsers alone.
- The products differ (CST against AST), as stated above. This is not a claim that monogram is
  the faster parser.
- Where monogram does more work: `typescript.d.ts` (type-declaration-heavy) and dense empty
  statements.
- On `checker.ts` monogram runs 120.2M instructions per parse (50.1M of them lexing), oxc
  116.6M.

### monogram `8d75e66` (2026-11-22, before the lexer and decision work)

The same method, two runs per mode (runner CPUs AMD EPYC 7763, one reuse run on an EPYC 9V74).
Time per parse, monogram ÷ oxc:

| input | reuse mode | fresh mode |
|:--|--:|--:|
| `checker.ts` | 1.032 / 1.091 | 1.063 / 1.041 |
| `typescript.js` | 1.024 / 1.039 | 0.999 / 0.985 |
| `parser.ts` | 1.030 / 1.074 | 1.048 / 1.052 |
| `typescript.d.ts` | 1.143 / 1.127 | 1.023 / 1.018 |
| 2 MB synthetic file | 1.150 / 1.117 | 1.159 / 1.159 |
| non-ASCII-heavy file | 1.435 / 1.402 | 1.360 / 1.356 |
| `src/gen-tm.ts` | 0.995 / 1.024 | 1.144 / 1.141 |
| `typescript.ts` | 0.906 / 0.992 | 0.718 / 0.714 |

There monogram executed 26% to 69% more instructions per parse than oxc (1.42 times on
`checker.ts`: 166.0M against 116.6M), measured again in the run above as its baseline.

These tables are hand-written from on-demand runs and are not regenerated. In reuse mode
monogram makes no allocator call per parse and neither parser takes a page fault.

## Recorded result: element dialects (TSX and JSX)

`measure-profile` run 45129600578 (AMD EPYC 7763), M = master `d326d65`. Per token: Rust and Go
Callgrind instructions of one parse (reuse mode) and of the Rust `lex(src)` alone; TS: V8 block
executions of one `parse(src)`.

| input (grammar) | tokens | Rust lexer | Rust parse | Go direct | Go builder | TS blocks |
|:--|--:|--:|--:|--:|--:|--:|
| `checker.ts` (typescript) | 348,866 | 142.3 | 298.9 | 463.0 | 491.2 | 87.7 |
| `gen-tm.ts` (typescript) | 50,156 | 158.6 | 329.8 | 525.9 | 557.4 | 114.7 |
| `jsx-corpus.tsx` (typescriptreact) | 37,054 | 203.7 | 433.5 | 755.8 | 784.5 | 130.9 |
| control: `gen-tm.tsx` (typescriptreact) | 50,156 | 163.5 | 334.5 | 534.2 | 553.5 | 114.8 |
| control against `gen-tm.ts` | | +3.1% | +1.4% | +1.6% | -0.7% | +0.06% |

How to read it:

- A TSX token costs the Rust lexer 45 instructions more than a `gen-tm.ts` token; about 5 of
  them are the element machinery's overhead on code (the control) and the rest is the token
  mix: text runs, tags and holes, which the frame step lexes.
- The control's Rust lexer +3.1% is no element work: Callgrind's per-line attribution puts it on
  register moves at the merges of the lexer's loops, not on an element line. Before the plain
  rounds ran in an inner loop of their own (`25b9ec7`), the control cost +18.1% Rust lexer,
  +8.6% Rust parse, +25.1% Go direct and +21.5% Go builder (`measure-profile` run 45126133065,
  A = `11a7c70`, AMD EPYC 9V45). The Rust lexer counts of `gen-tm.ts` and `gen-tm.tsx` are the
  same in both runs.
- That loop's one known cost: on element-dense JSX (`jsx-corpus.jsx`) an ordinary-scan round
  inside an element goes from the element loop to one plain round and back: +1.2% Rust lexer,
  +0.5% Rust parse against the single-loop lexer (run 45126133065).

The Go, TS and JS targets have not been compared with another parser on full TypeScript (an
earlier Go-vs-tsgo comparison used the JavaScript grammar on repeated snippets, and its harness
is gone). What each target allocates per parse is reported in [ALLOCATIONS.md](ALLOCATIONS.md);
`measure-targets` times them A/B on demand.
