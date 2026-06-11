# Total parsing: the formal spine

How the handle API (`createParser()`) parses *every* text into a tree plus
`cst.errors` while keeping two byte-identity guarantees no mainstream engine
makes, and why each piece is sound. The implementation lives in
`src/emit-parser.ts` (emitted runtime) and is held exact by the gates listed at
the end.

## The contract

For every input text and every edit sequence:

1. **Totality** — `parse`/`edit` never throw on input. Every text yields a root
   and a (possibly empty) `errors` list. Only API misuse throws.
2. **Strict-path identity** — a text the strict grammar accepts parses
   byte-identically to the strict module-level parser, with `errors = []`.
   Error tolerance costs valid input *nothing*, by construction (below), not by
   testing.
3. **Edit/fresh identity** — after any edit, tree *and* errors are
   byte-identical to a fresh parse of the same text — broken states included.

## Two passes, strict first

`parse`/`edit` run the **strict** parser first. Only when it rejects does the
text re-run with `recovering = true`. Guarantee 2 is therefore structural: the
valid path never executes a single recovery branch. The recovering run is where
everything below lives.

## The bar discipline

A naive "recover at any failure" breaks both identities: PEG longest-match
exploration *fails constantly* on valid arms, so an always-on recovery rescues
losing arms and perturbs valid shapes; and an incremental run that reuses old
rows explores *less* than a fresh run, so any failure-count-dependent decision
desynchronizes the two.

Recovery instead fires only at positions a strict pass has *proven* to fail:

- Each recovering **attempt** runs strictly except at an ordered list of
  **bars** (token indices). A recovery action is allowed only inside a bar's
  window (below).
- An attempt that fails *past* its bars aborts and appends a new bar at the
  attempt's farthest-fail watermark (`maxPos`), monotonically increasing.
- Attempt k runs under the first k bars; the loop is capped (32), then degrades
  to a deterministic free-fire pass (`recoverFree`) and, past even that, to a
  zero-width `$error` root. Never a crash.

**Determinism theorem.** The bar list is a pure function of the token stream:
bar k+1 is the strict-modulo-bars farthest-fail of a deterministic parse under
bars 1..k. Hence fresh and incremental recovering parses derive byte-identical
bar lists, which is the keystone of guarantee 3. This forces every ingredient
below to be *adoption-invariant*: nothing about reuse may change any watermark
or any fire decision.

## Recovery actions, all position-pure

Every action's fire condition is a pure function of `(position, bar list)` —
no counters, no budgets, no global parse state. (A budgeted design was tried
and failed exactly here: bar₂'s decisions depended on bar₁'s spending, which an
adopted region replays differently.)

- **Skip absorption** — at a repetition whose element fails with
  `recoverArmed(from, reach)` (∃ bar in `[from, reach]` with `reach ≤ bar+2`,
  where `reach` is the *failing element's frame-local* probe watermark, not the
  global one — a frontier parked on a far bar must not arm unrelated loops),
  absorb tokens to the loop's FIRST set / threaded closer / EOF into an
  `$error` row. Leaves keep text-tiling; the diagnostic quotes the first
  absorbed token.
- **Missing-token synthesis** (`missTok`) — a *required* literal/token matcher
  failing at `missAt(pos)` (∃ bar in `[pos, pos+2]`) materializes a zero-width
  `$missing` row instead of failing: the construct completes (a call keeps its
  Call shape with `)` marked missing) and the diagnostic reads `expected ')'`.
- **Missing-nonterminal synthesis** (`missRule`) — the same at a required rule
  reference's fail exit: `expected Expr`.
- **Commitment semantics** — synthesis is suppressed inside *uncommitted*
  probes: `not()` and separator probes (`probing`), and optional groups that
  have not consumed past their entry (`probeBase`). Once an optional consumes a
  real token it is committed and synthesizes like required content (`const a =
  ;` synthesizes the initializer; a bare `const a` does not invent one). This
  is tsc's required-only semantics, derived rather than hand-coded.

## Three structural theorems the gates forced

Each of these was surfaced as an `edit ≠ fresh` divergence by the generative
cross-grammar gate, then closed structurally — not patched per-case.

**T1 — Zero-width success is a synthesis-only artifact.** A strict parser can
never succeed at width zero inside a loop (it would not terminate), so *every*
loop must discard zero-width elements: plain repetitions break on
`pos === before`, hooked repetitions discard and re-arm, left-recursion
continuations and Pratt LEDs refuse zero-width wraps. Without this, synthesis
inside a loop spins unboundedly.

**T2 — Same-position re-entry is a real cycle class.** Zero-width synthesis
(and, under recovering, the opened dispatch guards) lets a rule re-enter
itself at the same position through paths no grammar check can rule out.
`recRunning` maps each in-flight `(rule, position)` frame to an entry serial;
re-entry fails with PEG cycle semantics. The refinement that matters for reuse:
a cycle refusal that leans on a frame entered *before* the current one makes
the current frame's result a function of its **ancestor stack**, not of the
text — such results are *tainted* (memo-stamped own-generation-only, taint
propagating to whoever reuses them). Internal cycles (both ends inside the
frame) replay from the window text alone and do not taint.

**T3 — The bar protocol's inputs must be adoption-invariant.** Bar k+1 is
derived from a watermark, so watermarks must be *exact* and *reuse-stable*:
`frameMax` is a frame-local advance watermark (reset at rule entry, folded to
the parent at exit) that makes every stored extent the frame's true probe
reach; memo jumps and adoptions re-raise it to the stored extent, so a reused
subtree contributes the same watermark the parse that built it did.

## The window-replay theorem

Define a frame's **window** as `[start, start + ext + 2]` over token indices,
where `ext` is its exact probe extent (T3) and `+2` covers the stop-token and
SECOND-token dispatch reads.

**Theorem.** Every recovery decision being position-pure, a frame's behavior —
result, probe extent, internal fires and synthesis included — is completely
determined by its window's *text* and its window's *bars*, modulo the
external-cycle dependence of T2.

Corollaries, each carrying one optimization:

- **Recovering adoption** (`barsWindowEq`): an old-tree row whose window sees
  the same (shifted) bars the build run saw there replays identically — even
  rows *containing* `$error`/`$missing` (an error region is exactly what stays
  stable across far edits). Broken-state keystrokes go incremental.
- **Cross-attempt memo survival**: attempts within one sequence parse the same
  stream under a monotonically growing bar list, so a memo entry whose window
  is **bar-free** behaved strictly (no synthesis, no arming; opened dispatch
  guards add only non-consuming probes) and is a pure function of window text —
  valid in every later attempt. Tainted entries (T2) are excluded; this
  exclusion is precisely what the first survival attempt missed and the gates
  rejected. Survival is edit-side only: the fresh path's attempt loop resets
  the arena per attempt, so earlier attempts' rows are clobbered there.
- **Recovering surgery**: a splice whose damage and re-parsed span sit clear of
  every bar window *commutes with every recovery decision* — kept rows replay
  at shifted positions, and the fresh parse behaves strictly across the span,
  exactly like the strict re-parse the surgery runs. Attempt k's bars are a
  prefix of the final list, so one check against the final list covers every
  attempt. The spliced tree keeps its bar list, suffix bars shifted.

**Known caveat (open).** Taint is tracked on memo entries, not on rows: a
tainted frame's *successful* row is still adoptable by `adoptSeek`. No gate
has constructed a divergence through this path; the candidate fix is a taint
bit on `rowRM` propagated like error containment.

## Lexer resync under depth shifts

The windowed re-lex adopts the old token suffix at the first aligned token
where the old suffix's lexing is reproducible from observable state. Two
sufficient conditions (both require empty template stacks on both sides — an
interpolation entry's brace counter is mutable state no record captures — and
a candidate token that carries no cross-token lexer flag its adopted successor
reads):

- **Equal-depth**: neither lex dipped below the candidate's paren depth since
  the divergence point (damage start; before it, identical bytes from an
  identical anchor state give identical stacks). Every open entry is then
  common to both lexes: the stacks are content-equal, and every future pop
  behaves identically. O(1), the common case.
- **Shifted-depth**: the old suffix never pops an entry open at the candidate
  (its recorded depth column never dips below the candidate's depth;
  pop-on-empty counts as −1). No open entry's head-ness is ever read again, so
  stack *contents* are irrelevant and the depths may differ by an arbitrary
  shift δ — the splice re-bases the adopted depth records by δ, restoring true
  absolute depths (`(`-head bits are local facts of their own neighbors and
  stay valid). This is what makes a paren-balance-changing edit O(window)
  instead of a relex-to-EOF.

## Diagnostics are data, derived from the tree

`cst.errors` is rebuilt at settle from structured lexer entries plus the
`$error`/`$missing` rows found by descending the structurally-propagated
`rowRM` spine — never collected during parsing. That is what makes adoption
safe for diagnostics: an adopted error region re-derives byte-identical
messages from the current token columns. Two derived enrichments:

- **Viable sets** — for a required literal in a seq, the companion literals
  *provably still accepted* when it fails: repetitions before it are always
  re-enterable (their nullable-prefix-reachable literals stay viable);
  nullable one-shot items are crossed but contribute nothing, since they may
  already have consumed. `expected ',' or ']'` never names an impossible
  continuation — a static FIRST union would (after `[1, 2` an expression is
  not viable), and tsc under-reports the same position as `')' expected`.
- **Paired openers** — for each literal, intersect the sets of preceding
  literals across all its seq occurrences; a unique survivor is its structural
  opener (`)`←`(`, `]`←`[`, `while`←`do` — derived, no bracket list), attached
  as `related` info pointing at the opener leaf among the `$missing`'s earlier
  siblings.

## Measured (9 MB TypeScript, single-character edits, median)

| phase | Monogram | tsc `updateSourceFile` | tree-sitter |
|---|---:|---:|---:|
| fresh parse | **177 ms** | 212 ms | 458 ms |
| valid keystroke | 0.37 ms | 37 ms | **0.20 ms** |
| breaking edit | 13 ms | 13.3 ms | **0.26 ms** |
| while-broken keystroke | **0.21 ms** | 13.6 ms | 0.31 ms |
| fixing edit | 1.0 ms | 14.1 ms | **0.20 ms** |

(`test/head-to-head.ts`.) The transition rows measure a first-touch 4.5 MB
cursor jump: profiling splits the 13 ms into lexer-layer suffix bookkeeping
(a one-time suffix-min allocation plus EOF-relative re-basing of the token
columns across the jump) with the strict-fail pass at 0.35 ms and the
recovery attempts at 0.6 ms; repeated break/fix transitions at one cursor
position settle to ~2 ms. The remaining gap to tree-sitter is array-storage
suffix splicing, not parsing.

Error-report agreement with tsc's parser on the conformance files it rejects
(`test/recovery-conformance.ts`, ±8 chars): recall 59.1%, precision 82.4%,
first-error agreement 57.5%.

## The gates that hold all of this exact

- `test/incremental-grammars.ts` — generative inputs × seeded edits × all 7
  grammars: every step's tree+errors byte-equal to fresh, self-consistent
  spans, no throws (672 steps).
- `test/incremental-verify.ts`, `test/multi-doc.ts` — real-file edit scripts
  and interleaved documents under the same byte-equality.
- `test/recovery.ts` — strict-path identity on valid texts, totality and
  determinism on an invalid corpus, a char-by-char typing session, and
  exact-match diagnostic pins (synthesis quality must not silently regress to
  absorption).
- `test/emit-parser-verify.ts` / `test/emit-lexer-verify.ts` — emitted runtime
  ≡ interpreter on the corpus, token streams and error messages included.
