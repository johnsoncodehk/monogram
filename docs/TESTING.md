# Testing — the report taxonomy

The suite produces **four kinds of report**, each answering a different question. They are
*not* interchangeable, and no one number is "the" test result. Read them in this order.

| Kind | Question it answers | One command | Output |
|---|---|---|---|
| **1. Gate** | Is the repo CORRECT? (pass/fail) | `npm run check` | one ✓/✗ summary + exit code |
| **2. Metric** | How does Monogram compare to the OFFICIAL grammar/parser? | `npm run coverage:table` | the README coverage table |
| **3. Ledger** | What valid-input highlighter GAPS exist that the metric is blind to? | `npm run ledger` | `KNOWN-GAPS.md` (+ auto-filed issues) |
| **4. Bench** | How fast / how much is covered? (informational) | `npm run bench:*`, `npm run bench:perf` | per-tool numbers, on demand |

---

## 1. Gates — `npm run check`

The CI-blocking pass/fail checks. One runner, one ✓/✗ table, one
exit code — instead of a dozen scripts with a dozen formats. Covers: sanity / agnostic /
issue-cases · conformance (js, tsx, jsx, html, test262) · highlighter guards + RedCMD
diagnostics + Monarch + HTML embed/lexer · YAML issue-12 + the TextMate site checks · the
generative **scope≡role** check (with its detector's mutation proof). `node test/check.ts <substr>`
runs a subset (e.g. `… yaml`).

Gates that need an external corpus (the TypeScript conformance corpus at `/tmp/ts-repo`, test262 at
`/tmp/test262`; CI clones both) say NOT RUN without it and fail.

### Records that are not gates

- `docs/ALLOCATIONS.md` (what one parse allocates per target, by site) is a REPORT: `node
  test/alloc-work.ts --write` writes it, and the README auto-regen workflow (`readme-bench.yml`)
  rewrites it on master. The gate `alloc-work` checks only its invariants: per-token counts do not
  grow with the input, and a reused Go builder allocates nothing.
- `docs/emit-sizes.json` (emitted parser bytes) is compared by the `measure profile` job, which
  lists a size more than ±0.25% from the record as a regression. A landing that changes a size on
  purpose re-records it (`node test/emit-size-record.ts --write`).

### Gate renames, merges and deletions (2026-11-23)

The old gates map to new ones as follows. Cases are each gate's own count line, or ✓ lines /
`fail(` sites where it prints none. "before" is the absorber's cases plus the absorbed gate's.

| old gate | now | cases before → after (dropped) |
|---|---|---|
| emit-parity/ast-builder | emit-parity/builder-reuse | 343 + 115 → 448 (10: the demo ESTree golden) |
| emit-parity/emit-tsc-gate | emit-parity/emit-standalone (also tsc --strict on js, jsx, tsx) | 83 + 6 → 86 (3 duplicate tsc runs) |
| emit-parity/emit-tokenize | emit-parity/emit-reentrancy | 63 + 39 → 100 (2; 13 reduced to what emit-lexer-verify does not check) |
| emit-parity/emit-ts-cst | emit-parity/emit-portable-split | 80 + 21 → 101 |
| emit-parity/shape-codegen | emit-parity/shape-parity | 85 + 21 → 105 (1 duplicate) |
| emit-parity/syntax-agnostic | emit-parity/define-target | 16 + 4 → 20 checks |
| emit-parity/relex-family | emit-parity/lex-family (tier ci) | 45 + 5 → 50 checks |
| core/incremental-verify | core/incremental-grammars | 29,109 + 256 → 29,245 steps (120 seeded random steps) |
| core/refactor-guard | CURATED_TS_CST of test/emit-corpus.ts (emit-parser-verify, emit-reject-messages) | 112 → 107 snippets (5 exact duplicates) |
| highlighter/html-monarch | highlighter/monarch-dialect | 150 rows + 14 checks → 164 rows |
| highlighter/html-embed-js | highlighter/raw-text-case-sites | 16 + 7 → 16 cells + 7 checks |
| highlighter/self-close-sites | generative/scope≡role | 6 languages, 32 cells → same |
| generative/gap-ledger-selftest | generative/scope≡role (its mutation proof and classifier locks) | 13 → 6 moved, 7 ledger-only dropped |
| yaml/depth-witnesses, depth-sites, flow-sites, compact-nest-sites, deepest-sibling, blockscalar-depth | yaml/tm-sites (`test/yaml-sites.ts`) | 22 + 16 + 8 + 57 + 576 + 72 → 751 |
| emit-parity/decision-dead | emit-parity/decision-report (the witnesses, then the dead alternatives; the pages are `npm run gen` outputs) | unchanged |
| emit-parity/portable-targets/edits-1 … edits-5 | edits-1, edits-2 | unchanged (grammars regrouped) |
| conformance/js-corpus | deleted, with `docs/JS-CONFORMANCE.md` (test262 is JavaScript's oracle) | |
| generative/gap-ledger-check | deleted (`npm run ledger:check` remains, for gap-issues.yml) | |
| highlighter/tm-capture-patterns | deleted (a pinned count with no decision attached) | |
| emit-parity/emit-size-record | not a gate: the profile job compares the record | |

`conformance/test262` measures the JS grammar against test262, JavaScript's own conformance suite: every
test under `test/language/` and `test/annexB/language/` of the checkout at `/tmp/test262` (pin:
`test/test262.sha`, the one place it is stated; CI clones it), each test's expected parse verdict read
from its front matter. Every disagreement carries a cause class (`test/test262-classes.ts`); the files
are pinned in `test/test262-record.txt` and the scoreboard in the generated `docs/TEST262.md`
(regenerate: `node test/test262.ts --write`). A file moving in either direction fails it until recorded.

`conformance/cpython` (`node test/cpython.ts`; not a gate of `check.ts` but the CI job `python`, which
installs the oracle) measures `python.ts` (interpreter) against `ast.parse` of Python 3.10.12 over every
`.py` file of CPython's `Lib/` at the pin in `test/cpython.sha` (the job clones it; locally
`~/.cache/monogram-agents/restore-cpython.sh <repo>`; another Python is NOT RUN). Every
disagreement carries a cause class (in `test/cpython.ts`); the files are pinned in
`test/cpython-record.txt` (regenerate: `node test/cpython.ts --write`). It is the second language's
oracle: [docs/SECOND-LANGUAGE.md](SECOND-LANGUAGE.md).

A gate is binary and authoritative: if `npm run check` is green, every guaranteed property holds.

### The inner loop — `node test/check.ts --changed [<base>]`

What an agent or a developer runs while working: only the gates whose inputs changed since `<base>`
(default `origin/master`; committed, staged, unstaged and untracked changes all count), and only the
gates not of tier `ci`. A gate's inputs are DERIVED from its source by `test/gate-deps.ts` (its module
graph and every repository path a string literal in it names; a template's holes match any text),
plus the `reads` its entry in `test/check.ts` declares; a change to `test/check.ts`, `package.json`,
the lockfile or `tsconfig.json` runs every gate. It prints each skipped gate and why. It GUARANTEES
that no skipped gate of the inner tier could have seen the change: CI runs every gate with
`CHECK_TRACE_DEPS=1`, which traces the files each gate opens and fails when one is not among its
derived inputs. It does NOT run the `ci` tier (whole-corpus crosses and gates of more than about ten
seconds: the portable-targets corpus / edits / recovery classes, test262, tm-mutation, look-extent,
…): those run in CI on every `land/**` push and on master, `--changed --all` runs them too, and a
`ci`-tier gate whose own script changed runs in the inner loop (the change is to that gate). It
assumes the generated artifacts are current (`npm run gen`). Inputs are split BY TARGET: each emit
target's module (`src/emit-parser.ts`, `src/target-ts.ts`, `src/target-go.ts`, `src/target-rust.ts`)
imports only the core `src/target.ts`, never another target (`src/emit.ts`, the public surface,
re-exports all four: a gate that imports it depends on every target), so a gate of one target does
not run for another target's change; a gate marked `targets: true` (the portable-targets classes),
whose inputs changed only in some targets' code, runs with `CHECK_TARGETS=<those targets>` and checks
only them (the TypeScript target, their reference, always runs). A test-only or docs change takes
seconds; a grammar or generator change runs most of the inner tier (see the commit message of the
landing that introduced it for measured times).

### The tiers: `--quick`, `--changed`, CI

Three tiers for three moments, each a subset of the next, all selected by the same derived inputs:

| tier | command | what runs | when |
|---|---|---|---|
| quick | `node test/check.ts --quick` | the affected gates listed in `QUICK_GATES` (`test/check.ts`), each with `CHECK_QUICK=1`: its declared sample | after every edit: it must stay in seconds |
| inner | `node test/check.ts --changed` | every affected gate not of tier `ci`, whole | before pushing a `land/**` branch |
| CI | `npm run check` (every push of `land/**`, master) | every gate, the `ci` tier included, whole; plus the other jobs (tree-sitter, engine parity over the full corpus, the artifacts' drift) | the truth |

A red quick run is a real failure of the change (fix it before going on); a green quick run is
NOT a green `--changed`, and a green `--changed` is not a green CI. The quick tier is not asked to
catch everything: it is the part of `--changed` that fits in seconds.

The quick tier's samples (`QUICK` in `test/check-targets.ts`): the portable-targets classes run
three grammars (`calc`, `templatejs`, and `javascript` on the TypeScript target only:
`QUICK_GRAMMARS` in `test/portable-harness.ts`), and `javascript` on Go too when the Go target's own
code changed (`CHECK_QUICK_GO=1`, set by `check.ts`: only a Go compile sees a variable declared and
not used, the commonest Go printer mistake, and a small grammar's parser may not reach the code that
has it); edits-small runs one in three of its exhaustive one-character edits (`QUICK_EDIT_STRIDE`,
`test/portable-edits.ts`); `emit-portable-library` runs its source checks of every target's emitted library (the
exported surface, package-level state, imports) and the TypeScript target's runtime checks, not the
Go / Rust build and run. A gate in `QUICK_GATES` without a sample runs whole (it costs about a
second). `--quick` prints the affected gates it leaves out.

Measured cost (`.github/workflows/measure-inner-loop.yml`, a 4-core runner, seconds, cold = empty
build cache and Go cache / warm = the same command again; the change is the named commit's files):

QUICK_TIMING_TABLE

On the shared 2-core box (load about 5), warm: a Rust printer change QUICK_BOX_RUST s.

What each tier catches, measured on the real failures of `land/**` branches (2026-11-22/23: the
first failing head of each, put back onto the tree; `test/inner-loop-measure.sh catch`, judged by
the failing gate and message of the original CI run): of the 12 that reproduce, `--quick` caught 7
(a probable eighth), `--changed` 10, CI all 12. The quick tier's misses, by class:
- a Go compile error in code only a real grammar's parser reaches (land/decisions-commit: `declared
  and not used` in the javascript grammar's Go parser; `--changed` caught it in the native gates).
  Since covered: `CHECK_QUICK_GO` compiles the javascript grammar's Go parser when the Go target's
  code changed.
- jsTarget's emitted code under `tsc --strict` (land/regions-spec-lex-error: `emit-standalone`, a
  `--changed` gate). Left out of the quick tier on purpose: jsTarget is being retired.
- inputs only the wide corpora hold (land/lexer-ident-ext, land/lexer-small-items: a Unicode
  identifier and a lexer item seen only by the parity corpus / edits-2 / wide / test262, the `ci`
  tier). `--changed` misses them too: only CI sees this class.

What `--quick` does not run at all: a Rust parser of a real grammar, the Go parser of a real grammar
unless the Go target changed, the Go / Rust library build and run, every `ci`-tier gate (the parity
corpus, edits-1 / edits-2, recovery, wide, test262, look-extent, tm-mutation, ...), the native work
and allocation gates (portable-work, lexer-work, lexer-reservation, builder-reuse,
emit-portable-split, alloc-work), jsTarget's standalone type check (emit-standalone), and the
generated artifacts' drift (CI runs `npm run gen` and diffs).

The caches (`test/build-cache.ts`, `test/emit-cache.ts`): Go / Rust builds and emitted parsers are
kept under `<os tmpdir>/monogram-build-cache/`, keyed by content (a changed input misses; nothing to
invalidate by hand); entries older than a day, then the least recently used above 3 GB, are dropped.
To clear: `rm -rf "$(node -p 'require("os").tmpdir()')/monogram-build-cache"`; to bypass the
emission cache: `MONOGRAM_EMIT_CACHE=0`.

### Before adding a gate

Name the real failure it would catch that no existing gate catches. Prefer widening the inputs of an
existing check (a new row, a new corpus, a new grammar) to adding a gate; a number pinned with no
decision attached to it is a report, not a gate.

### The portable-targets gates

`emit-parity/portable-targets/*` prove the portable TypeScript, Go and Rust parsers ≡ the interpreter.
`test/portable-harness.ts` holds what the classes share (the runners, emission, the Go / Rust BUILD
CACHE: an entry per sha-256 of the emitted sources, the build command and the toolchain, under
`<tmpdir>/monogram-build-cache/`, built once by whichever process takes its lock, swept when unused
for 24 h or above 3 GB); `test/portable-cases.ts` the grammars and their hand-written lists; one file
per class: `portable-lists.ts` (lists, jsTarget on them, tok-spans, Unicode, default prefix, empty
entry), `portable-edits.ts` (one-character edits, edit sessions), `portable-corpus.ts` (the parity
corpus: verdict, skeleton, tokens, literal ids, Doc; sharded by grammar in `check.ts`),
`portable-recovery.ts` (total parsing). `--grammars=a,b` (or `PORTABLE_GRAMMARS`) and
`PORTABLE_TARGETS=go,rust` narrow a run.

## 2. Metrics — `npm run coverage:table`

The COMPARATIVE numbers (Monogram **vs the official** grammar / parser) the README publishes:
- **Parser** (`test/src-coverage*`) — Monogram's accept/reject (and HTML tree shape) vs the
  official parser, weighted by the official parser's own branch coverage.
- **Highlighter** (`test/scope-gap*`) — Monogram's TextMate grammar vs the official one, both
  graded against the parser's per-token roles ([vscode#203212](https://github.com/microsoft/vscode/issues/203212)).

These need the external corpora (the TS repo, Test262, yaml-test-suite) + the VS Code / official
grammars — so they run locally / in the README-bench workflow, **not** in `check`. Both run
through ONE data-driven driver each (`scope-gap-run.ts <lang>`, `src-coverage-run.ts <lang>`).

> A metric number is **comparative and bounded**: "100%" means "100% of the *graded* tokens (the
> oracle has a role for, above the punctuation floor) on the *fixed corpus*" — never "perfect".

## 3. Ledger — `KNOWN-GAPS.md` (`npm run ledger`)

The metric above is corpus-bound, oracle-limited, and excludes the punctuation floor — so it is
structurally blind to a whole class of real bugs. The **generative scope≡role check**
(`test/generative.ts`, a gate) is **floor-blind** and **systematic** (it generates inputs from the
grammar, deterministically), so it finds divergences where Monogram's own highlighter disagrees
with its own parser. `test/gap-ledger.ts` operationalizes those into `KNOWN-GAPS.md`: each gap is
**delta-debug-minimized**, **oracle-classified** (only valid-input gaps kept), and **fingerprinted**
(stable across commits). `.github/workflows/gap-issues.yml` projects the ledger onto GitHub issues
idempotently (open on appearance, auto-close on fix).

### Why a gate AND a metric, AND a ledger — they catch DIFFERENT classes

- A **metric** "Monogram-wrong" is a disagreement with the EXTERNAL oracle (tsc / the official
  grammar) — mostly *semantic identifier* roles (is `e` a type or a value?). Monogram's parser and
  highlighter **agree** there (self-consistent); they just make a different *semantic* call than
  tsc. The gate/ledger can't see it (no self-inconsistency, and a CFG can't decide it).
- A **ledger/gate** gap is a disagreement between Monogram's highlighter and its own PARSER — a
  *structural* mis-paint (a `-` indicator scoped as a string/name) the metric floors out and the
  corpus may never contain. The metric can't see it.

Neither subsumes the other. `check` (self-consistency) does **not** replace the metric
(external-semantic alignment) or the negative tests — round-trip proves only self-consistency.

## 4. Bench — on demand

`npm run bench:perf`, `bench:html-official`, `bench:issues` (the bug ledger in `HIGHLIGHTER-EVIDENCE.md`, its summary in the README),
`gate:treesitter`, `compat`. Informational — perf, official-comparison detail, repo-compat. Not gates.

---

### TL;DR

```
npm run check          # gates — is it correct? (one ✓/✗ summary)
npm run coverage:table # metrics — how it compares to official (README table)
npm run ledger         # ledger — valid-input gaps the metric is blind to (KNOWN-GAPS.md)
```
