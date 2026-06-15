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

The CI-blocking pass/fail checks (no external corpus needed). One runner, one ✓/✗ table, one
exit code — instead of a dozen scripts with a dozen formats. Covers: sanity / agnostic /
refactor-guard / issue-cases · conformance (js, tsx, jsx, html) · highlighter guards + RedCMD
diagnostics + Monarch + HTML embed/lexer · YAML
issue-12 + depth-witnesses · the generative **scope≡role** check + the gap-ledger selftest +
`--check`. `node test/check.ts <substr>` runs a subset (e.g. `… yaml`).

A gate is binary and authoritative: if `npm run check` is green, every guaranteed property holds.

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

`npm run bench:perf`, `bench:html-official`, `bench:issues` (the README bug ledger),
`gate:treesitter`, `compat`. Informational — perf, official-comparison detail, repo-compat. Not gates.

---

### TL;DR

```
npm run check          # gates — is it correct? (one ✓/✗ summary)
npm run coverage:table # metrics — how it compares to official (README table)
npm run ledger         # ledger — valid-input gaps the metric is blind to (KNOWN-GAPS.md)
```
