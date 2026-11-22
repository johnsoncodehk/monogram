# Measuring performance

What the project has learned about its own measurements, and the harnesses that apply it. Every
performance claim in a pull request or in the README comes from one of these, run in CI.

## What decides what

- **Instruction counts decide a logic change.** Callgrind counts are deterministic: the same
  commit gives the same count on any runner. A change that deletes work shows as fewer
  instructions; one that does not, does not.
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
  and V8 reports a block that always runs with its function as part of the function's count.
- **Go under Callgrind is deterministic only when built and run as the harness does**:
  `-tags faketime` (the runtime's clock stands still; with a real clock sysmon preempts the parse
  every 10 ms of wall time and the scheduler's work lands inside the measured region as often as
  Valgrind's speed allows), `GOGC=off GOMAXPROCS=1 GODEBUG=asyncpreemptoff=1`, and collection
  toggled by a client request around the parse (`--toggle-collect=<function>` ends early: Callgrind
  tracks returns by the stack pointer, and the Go runtime switches stacks). What remains random is a
  Go map's hash seed: a lookup's instructions differ between runs (up to 0.5% of a parse of
  `checker.ts`), their number does not. So the Go column counts the parse WITHOUT the calls into the
  map runtime and lists the number of those calls beside it (`test/bench-targets/go-ir.ts`); once no
  map is read on the parse path the two agree. Only reuse mode (a parse into the builder of a first
  one) is measured: a first parse into a new builder varied by up to 0.14% between runs in the
  page allocator's search (`runtime.(*pageAlloc).find`), with or without address randomization; a
  fresh parse's allocations are pinned by `alloc-work`. The profile measures M twice and fails if
  the two differ by more than 0.01%.
- **The fair comparison with oxc is reuse mode on both sides**: one kept `CstBuilder`
  (`parse_with`) against one `Allocator` `reset()` before each parse. Fresh mode (a new builder /
  allocator per parse) is reported beside it.

## The harnesses

| What | Where | When |
|---|---|---|
| Rust: instructions (Callgrind) per parse in both modes, lexer alone, work counters, allocator calls / bytes, page faults, peak; emitted sizes of every target | `test/bench-rust-profile/run.sh` (`PROFILE_SCOPE=pr`), `test/emit-sizes.ts`, report `test/bench-rust-profile/pr-summary.ts`; workflow `measure-profile` | every pull request touching `src/**`, a grammar file or the harness; A = merge base, M = head; the job summary shows the tables |
| Go target: Callgrind instructions per parse (reuse); TS target and emitted JS parser: V8 block executions per parse; side by side with Rust per input, single-target changes listed | the same `run.sh` (section "Go and TS targets"), `test/bench-targets/go-main.go` (`count-*` modes), `test/bench-targets/blocks.ts`; on the main inputs | in the same `measure-profile` job |
| The same plus oxc beside A and M, native timings, phase regions, cache / branch simulation | the same `run.sh` with `PROFILE_SCOPE=full` | on demand: the `measure-profile-full` label on a pull request, or `measure-profile` workflow_dispatch with scope `full` |
| Rust wall-clock vs oxc: alternating rounds in one job, medians and per-round ratios, one job per mode | `test/bench-rust-oxc/run.sh` (`BENCH_BASE`, `BENCH_EXTRA`, `BENCH_GRAMMAR`, `BENCH_MODE`); workflow `measure-bench` | on demand: workflow_dispatch, or the `measure-bench` label on a pull request |
| TS target, emitted JS parser, Go: allocations and bytes per token and per node, by site, result vs overhead, pinned in `docs/ALLOCATIONS.md` | gate `alloc-work` (`test/alloc-work.ts`, `test/alloc-instrument.ts`) | every CI run (`node test/check.ts`); `--write` re-records |
| TS / JS / Go wall-clock A/B: alternating rounds in one job, a fresh process per measurement, medians and per-round ratios | `test/bench-targets/run.sh` (`TARGETS_BASE`, `TARGETS_COMMIT`, `TARGETS_GRAMMAR`, `TARGETS_ONLY`); workflow `measure-targets` | on demand: workflow_dispatch, or the `measure-targets` label on a pull request |

Failure policy of the pull-request profile: a measurement the harness did not produce fails the
job (NOT RUN is never a pass). A regression does not fail it (a threshold on instructions would be
arbitrary, and a grammar change legitimately changes work); it is listed at the top of the summary:
any input whose instructions rise by more than 0.5%, any rise in allocator calls per parse in reuse
mode, any emitted size up by more than 1%; and, separately, every input on which one target moves by
more than 0.1% while another stays within 0.01%.

The inputs are fixed: `checker.ts` and `parser.ts` of TypeScript at the repository's one pin
(`TS_REPO_SHA` in the workflows), `typescript.js` / `typescript.d.ts` of the locked `typescript`
npm package, `gen-tm.ts` and `typescript.ts` of this repository as of `2632c2c`, a 2 MB synthetic
file, a non-ASCII-heavy file and two dense one-byte-token files.

## Recorded result: Rust against oxc (2026-11-22, monogram `8d75e66`)

What is compared: monogram's Rust parser builds a **CST** (every token is a leaf) with the
`typescript.ts` grammar; [oxc](https://github.com/oxc-project/oxc) builds an **AST**. They are
not the same product, so the ratio compares two kinds of work on the same input, both parsing
as TypeScript.

Measured on monogram `8d75e66` against `oxc_parser` 0.126.0 with
[`test/bench-rust-oxc`](../test/bench-rust-oxc/run.sh): both parsers in one GitHub-hosted job,
9 alternating rounds, the median of the per-round time ratios. Two runs per mode, each cell
gives both: pull request #126's final runs, and this repository's `measure-bench` runs on pull
request #131 (runner CPUs AMD EPYC 7763, except the second reuse run on an EPYC 9V74). Only
ratios inside one job compare: the spread between the two runs is the runner's. Time per
parse, monogram ÷ oxc (above 1: oxc is faster):

| input | reuse mode | fresh mode |
|:--|--:|--:|
| `checker.ts` (TypeScript compiler, 3.2 MB) | 1.032 / 1.091 | 1.063 / 1.041 |
| `typescript.js` (npm `typescript` 5.9.3, 9.1 MB) | 1.024 / 1.039 | 0.999 / 0.985 |
| `parser.ts` (TypeScript compiler) | 1.030 / 1.074 | 1.048 / 1.052 |
| `typescript.d.ts` (npm `typescript` 5.9.3) | 1.143 / 1.127 | 1.023 / 1.018 |
| 2 MB synthetic file | 1.150 / 1.117 | 1.159 / 1.159 |
| non-ASCII-heavy file | 1.435 / 1.402 | 1.360 / 1.356 |
| [`src/gen-tm.ts`](../src/gen-tm.ts) at `2632c2c` | 0.995 / 1.024 | 1.144 / 1.141 |
| [`typescript.ts`](../typescript.ts) at `2632c2c` | 0.906 / 0.992 | 0.718 / 0.714 |

Reuse mode is the like-for-like comparison: one `CstBuilder` kept across parses (`parse_with`)
against one oxc `Allocator` `reset()` before each parse. There monogram makes no allocator call
per parse and oxc 22 to 21,842; neither takes a page fault; oxc executes fewer instructions per
parse, from 16% fewer (`typescript.ts`) to 39% (the non-ASCII file), 30% on `checker.ts`
(Callgrind, [`test/bench-rust-profile`](../test/bench-rust-profile/run.sh)). Fresh mode is a
new builder / allocator per parse.

This table is hand-written from two on-demand `measure-bench` runs and is not regenerated.
Later pull requests on 2026-11-22 (lexer and builder work) lowered the Rust parser's
instruction count per parse by roughly a fifth, by the per-PR profile job; no wall-clock
comparison with oxc has been recorded since, and a new one depends on the runner's CPU.

The Go, TS and JS targets have not been compared with another parser on full TypeScript (an
earlier Go-vs-tsgo comparison used the JavaScript grammar on repeated snippets, and its harness
is gone). What each target allocates per parse is pinned in [ALLOCATIONS.md](ALLOCATIONS.md);
`measure-targets` times them A/B on demand.
