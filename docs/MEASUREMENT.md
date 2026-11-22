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
- **The fair comparison with oxc is reuse mode on both sides**: one kept `CstBuilder`
  (`parse_with`) against one `Allocator` `reset()` before each parse. Fresh mode (a new builder /
  allocator per parse) is reported beside it.

## The harnesses

| What | Where | When |
|---|---|---|
| Rust: instructions (Callgrind) per parse in both modes, lexer alone, work counters, allocator calls / bytes, page faults, peak; emitted sizes of every target | `test/bench-rust-profile/run.sh` (`PROFILE_SCOPE=pr`), `test/emit-sizes.ts`, report `test/bench-rust-profile/pr-summary.ts`; workflow `measure-profile` | every pull request touching `src/**`, a grammar file or the harness; A = merge base, M = head; the job summary shows the tables |
| The same plus oxc beside A and M, native timings, phase regions, cache / branch simulation | the same `run.sh` with `PROFILE_SCOPE=full` | on demand: the `measure-profile-full` label on a pull request, or `measure-profile` workflow_dispatch with scope `full` |
| Rust wall-clock vs oxc: alternating rounds in one job, medians and per-round ratios, one job per mode | `test/bench-rust-oxc/run.sh` (`BENCH_BASE`, `BENCH_EXTRA`, `BENCH_GRAMMAR`, `BENCH_MODE`); workflow `measure-bench` | on demand: workflow_dispatch, or the `measure-bench` label on a pull request |
| TS target, emitted JS parser, Go: allocations and bytes per token and per node, by site, result vs overhead, pinned in `docs/ALLOCATIONS.md` | gate `alloc-work` (`test/alloc-work.ts`, `test/alloc-instrument.ts`) | every CI run (`node test/check.ts`); `--write` re-records |
| TS / JS / Go wall-clock A/B: alternating rounds in one job, a fresh process per measurement, medians and per-round ratios | `test/bench-targets/run.sh` (`TARGETS_BASE`, `TARGETS_COMMIT`, `TARGETS_GRAMMAR`, `TARGETS_ONLY`); workflow `measure-targets` | on demand: workflow_dispatch, or the `measure-targets` label on a pull request |

Failure policy of the pull-request profile: a measurement the harness did not produce fails the
job (NOT RUN is never a pass). A regression does not fail it (a threshold on instructions would be
arbitrary, and a grammar change legitimately changes work); it is listed at the top of the summary:
any input whose instructions rise by more than 0.5%, any rise in allocator calls per parse in reuse
mode, any emitted size up by more than 1%.

The inputs are fixed: `checker.ts` and `parser.ts` of TypeScript at the repository's one pin
(`TS_REPO_SHA` in the workflows), `typescript.js` / `typescript.d.ts` of the locked `typescript`
npm package, `gen-tm.ts` and `typescript.ts` of this repository as of `2632c2c`, a 2 MB synthetic
file, a non-ASCII-heavy file and two dense one-byte-token files.
