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
refactor-guard / issue-cases · conformance (js, js-corpus, tsx, jsx, html) · highlighter guards + RedCMD
diagnostics + Monarch + HTML embed/lexer · YAML
issue-12 + depth-witnesses · the generative **scope≡role** check + the gap-ledger selftest +
`--check`. `node test/check.ts <substr>` runs a subset (e.g. `… yaml`).

One gate needs an external corpus: `conformance/js-corpus` measures the JS grammar against tsc's
JS-mode parser over the pinned TypeScript conformance corpus at `/tmp/ts-repo` (CI clones it; the
step is in the CI workflow). Its result is pinned in the generated record `docs/JS-CONFORMANCE.md`
(regenerate: `node test/js-conformance-corpus.ts --write`), so any file moving between cells fails
it until recorded. Without the corpus the gate says NOT RUN and fails.

`conformance/test262` measures the JS grammar against test262, JavaScript's own conformance suite: every
test under `test/language/` and `test/annexB/language/` of the checkout at `/tmp/test262` (pin:
`test/test262.sha`, the one place it is stated; CI clones it), each test's expected parse verdict read
from its front matter. Every disagreement carries a cause class (`test/test262-classes.ts`); the files
are pinned in `test/test262-record.txt` and the scoreboard in the generated `docs/TEST262.md`
(regenerate: `node test/test262.ts --write`). A file moving in either direction fails it until recorded.

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
…): those run in CI on every `land/**` push and on master, and `--changed --all` runs them too. It
assumes the generated artifacts are current (`npm run gen`). A test-only or docs change takes
seconds; a grammar or generator change runs most of the inner tier (see the commit message of the
landing that introduced it for measured times).

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
