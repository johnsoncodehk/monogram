# Total derivation: the completeness spine

Why `src/gen-tm.ts` emits *every* TextMate construct the grammar requires — not by
testing a corpus, but because the generator's input is a **closed, finite algebra**, so
"every obligation" is enumerable and each is discharged by a reachable emission. This is
the dual of the soundness ledger (`KNOWN-GAPS.md`, which finds *wrong* paints); here we
prove there are no *missing* ones. The proof is held exact by `test/tm-completeness.ts`
and the ledger at the end.

## The contract

For every grammar `G` built from the public `src/api.ts` combinators and lowered through
`defineGrammar()`:

1. **Closure** — `G` is a value of the closed `RuleExpr` / `TokenPattern` algebra (plus a
   finite set of config records). Nothing the API can express falls outside it; nothing in
   it is unreachable from the API.
2. **Coverage** — every highlighting obligation `G` induces (a token scope, a keyword, an
   operator, a region, an embed, a disambiguation, a config-driven construct) is emitted by
   `generateTmLanguage(G)`.
3. **Reachability** — every emitted repository entry is reachable from the root patterns or
   from a declared export surface; conversely every export surface resolves.

Three separations keep the claim honest:

- **Parser** completeness (does `G` accept the language?) is a *different* axis, measured by
  the conformance run and `test/src-coverage.ts`.
- **Highlighter** completeness (this document) is *coverage*: every obligation is
  recognised and scoped. Whether the scope is the *right* one at an ambiguous frontier is
  **soundness** — `test/scope-gap.ts` and `test/gap-ledger.ts`, a separate axis.
- **TextMate-engine** expressiveness (can the regex model express the obligation at all?)
  is bounded by Oniguruma, not by Monogram; §"The frontier" settles where that bound
  actually lies.

This is **not** the README corpus metrics (empirical agreement with external oracles). It
is the formal derivation property: the map from the DSL grammar to the emitted grammar
loses nothing representable.

## Why a closed algebra makes this finite

A TextMate grammar written by hand has no completeness theorem — there is no enumerable set
of "everything it should match." Monogram's does, because `generateTmLanguage` consumes a
value of a **closed union**: `RuleExpr` has 15 constructors and `TokenPattern` has 10
(`src/types.ts`), plus the finite config records (`TokenDecl`, `MarkupConfig`,
`IndentConfig`, `NewlineConfig`, the Pratt tables, `scopeOverrides`, `canonicalRepoNames`,
`aliasScopes`, `expressionRule`, `manifest`). An *obligation* is induced by a
constructor-occurrence or a config-field-occurrence. So completeness reduces to: **for each
obligation generator, the generator has a discharging, reachable emission** — three
mechanically-checkable layers. Both sides are finite — a finite `G`, a finite `gen-tm(G)`, and an
obligation taxonomy bounded by TextMate's finite construct kinds — so completeness is a **decidable**
property **per grammar**, checked a-priori on the emitted artifact with no corpus. The **algebra
closure** (Layer A) is what holds ∀ G by structural induction (the lowering/compilation is total over
the finite combinator algebra); the per-grammar **discharge** is then executed on the shipped set — a
decidable check run on concrete grammars, with the closure as its inductive backbone, not a mechanised
∀-G proof of discharge.

## Layer A — closure: the universe is the algebra, and lowering is total

**A1 — API lowering closure.** `toRuleExpr` (`src/api.ts`) is a total function with a finite
case analysis ending in a `throw`: it never silently drops an element, and its image is
exactly the `RuleExpr` union. Witnessed by instantiating *every* public combinator and
marker into one grammar and confirming the lowered bodies use all 15 constructors and
nothing outside them (`checkRuleExprClosure`). `formatExpr` in `src/cli.ts` is an
independent exhaustive `switch` over the same 15 — a second guard that the union is closed.

**A2 — TokenPattern compiler closure.** `tokenPatternToRegex`'s `emit` (`src/token-pattern.ts`)
is a single `switch` over the 10 `TokenPattern` constructors with no `default` — TypeScript
exhaustiveness makes a missing case a compile error. Witnessed by compiling every public
token builder to a regex (`checkTokenPatternClosure`).

**A3 — the literal-collection backbone is total.** Flat keyword / operator scoping is driven
by the shared `collectLiterals` (`src/grammar-utils.ts`), looped over every rule body. It
recurses into *all consuming* structural constructors (`seq`, `alt`, `quantifier`, `group`,
`sep`) and omits only the ones that carry no consumed literal: `not` (a negative lookahead —
the word is *absent* at the site) and `ref` (a cross-rule edge, collected when that rule's
own body is walked). So no consumed literal is silently dropped, and the flat keyword
obligation is discharged for *any* nesting. This is why a naïve end-to-end keyword probe is
vacuous — `collectLiterals` already covers every nesting (`checkCollectLiteralsClosure`).

The residual silent-drop risk therefore lives only in the **specialised region walkers** that
do *not* use `collectLiterals` (they hoist keywords out of a derived `<…>` / region scope).
Auditing the 48 RuleExpr walkers in `gen-tm.ts` found exactly one reachable gap:
`getTypeParamElementKeywords` omitted `sep`, so a keyword inside a `sep`-list within a
type-parameter element lost its keyword role inside `<…>`. No shipped grammar nests a keyword
that way (TS type-param keywords are direct), so it was latent — but it is a *supported*
combinator shape silently ignored, so it is **fixed** (one line: recurse into `sep.element`;
`not` stays omitted on purpose — a forbidden word; `ref` stays unresolved so a constraint
*type*'s own keywords like `keyof`/`typeof` are not mis-hoisted). The fix is byte-identical on
all six shipped grammars (latent), and the `kwsep` probe in `regionKeywordProbe` is a biting
regression guard (it fails without the fix).

## Layer B — coverage: every obligation has a reachable discharge

The obligation families, enumerated from `G`'s closed algebra **independently of gen-tm's own
detectors** (a detector that missed a shape would otherwise also miss its obligation —
co-blind):

- **Tokens.** Every non-`skip` token bears a leaf-scope obligation, discharged by exactly one
  family: the flat token loop (a `#<name>` entry), the regex-literal family (`regex`-flagged),
  the indent/markup engine (a `never()` placeholder the region machinery replaces), the markup
  region machinery (a `markup` grammar emits no per-token keys), or a region that owns the
  token's delimiter (the JSX `/>` / `</` punctuation). `tokenCensus` classifies every token and
  asserts **zero orphans** — the emitter-completeness proof for tokens.
- **Keyword literals & Pratt operators** bear a keyword-scope obligation, **discharged
  structurally** (`literalDischarge`): every alphabetic literal the grammar consumes (from
  `collectLiterals` over every rule, plus the prec / led tables) must appear, as a *scoped word*,
  in some **reachable** pattern whose scope is a keyword family (`keyword.` / `storage.` /
  `constant.language` / …). This is a finite scan of the emitted artifact — **no corpus** — asking
  only whether a scoping pattern is *present* (completeness); whether its guard fires correctly is
  soundness. **248/248** discharged across the six grammars. (The `op`/`prefix`/`postfix` markers
  carry no literal — they route to `collectLiterals`' default — and an operator's scope comes from
  the prec-table value, so those three constructors being unwalked is *benign*, confirmed by
  adversarial review.)
- **Shapes** (JSX elements, generic/cast angle brackets, regex context, declarations, ternary,
  conditional types, arrow params, contextual operators/modifiers) and **config surfaces**
  (markup, indent, newline, `expressionRule`, `aliasScopes`, `canonicalRepoNames`, `manifest`,
  `inject`) each emit a family of repository entries; that the detectors fire on the *shape*
  rather than on TypeScript-specific names — the detector-completeness requirement — is held by
  `test/agnostic.ts` (synthetic grammars with deliberately non-TS names/delimiters).

So token, keyword/operator, and reachability discharge are **decidable structural checks on the
emitted artifact** — the fixed denominator in the ledger, **952/952, no corpus**. A *redundant*
corpus cross-check (**leaf coverage**: over the deterministic grammar-derived corpus, every parsed
leaf whose by-construction role is content/keyword gets a non-root scope — **2433/2433**) is kept as
a differential witness on the soundness axis; it is not the guarantee.

## Measuring the detector — mutation testing

A passing checker is worthless if the checker is *blind* — the corpus-trap this project has been
bitten by. So the guarantee is not asserted, it is **measured**: `test/tm-mutation.ts` injects a
catalogue of known gaps into the emitted grammar (drop a key, drop all of a token's includes,
neuter a scope to the bare root, add a dead key, a dangling include, mis-scope a token to a wrong
role, reorder two disambiguation patterns) and records which detector layer — if any — kills each.
The honest, measured result:

- **Presence gaps** (a token / scope / key dropped or neutered): **16/16 killed · 12/16 by a
  CORPUS-FREE structural detector** (reachability dead/dangling · the token census · the flat-token
  neuter check). The remaining four — a *region* token neutered — are caught by a targeted
  differential witness, not corpus-free. **No presence gap survives; this is the gate.**
- **Wrong-role gaps** (a token still painted, but the wrong role): caught by the differential
  (a bucket change at the witness), *not* by the structural detector — a token that *is* painted
  satisfies presence. This is the completeness/soundness seam: presence ≠ correctness.
- **Ordering gaps** (two patterns reordered so a looser rule shadows a tighter one): a **measured
  blind spot**. TextMate is order-sensitive, and which pattern wins is a property of the emitted
  artifact's *sequence*, not the grammar's algebra — so no corpus-free structural check reaches it,
  and a scope-preserving reorder slips even the bucket-level differential.

The line is precise — and narrower than an earlier draft of it claimed (an adversarial review of
that draft is owed these corrections). **Completeness — every required construct PRESENT + REACHABLE
+ visually scoped — is checked structurally, no corpus**, and for a fixed `G` it is DECIDABLE (finite
`G`, finite `gen-tm(G)`, an obligation taxonomy bounded by TextMate's finite construct kinds). Three
honest bounds on that:

- **Presence, not identity.** The discharge is *presence* — a reachable repository entry whose scope
  is non-root — not a deeper *identity* of the matcher. The flat `match` is *derived from*
  `tokenPatternSource(t)` (widened to `identPattern` for the identifier token, so not literally equal);
  `tokenCensus` checks the entry exists and carries a visual scope, it does **not** re-verify the regex
  recognises the right bytes — that is soundness. (For markup grammars the census additionally checks
  that a token's *explicitly declared* scope is actually emitted, closing a co-blind path a review
  found — an unmodelled `<?…?>` construct that fell through to the bare root.)
- **Verified on the shipped set, not run ∀ G.** The Layer-A closure (A1/A2) is the inductive backbone
  — the algebra IS closed and lowering/compilation IS total ∀ G — but the per-grammar *discharge* is
  EXECUTED on the six shipped grammars plus synthetic witnesses, not run as a quantified proof over all `G`.
- **Ordering is decidable, not undecidable.** Which of two overlapping patterns *wins* is, for a fixed
  `G`, a finite index read (the emitted `patterns` list is finite, the winner is leftmost-by-order, and
  gen-tm computes that order by a deterministic sort). It is simply **not reachable by a corpus-free
  structural fold over the grammar** — a measurement limit, the wording §"Measuring the detector" uses,
  NOT undecidability. (An earlier draft called ordering "undecidable"; that was the same impossibility-
  without-proof over-claim the project guards against.)

What is genuinely beyond an a-priori check is **soundness** — whether the present constructs paint
*correctly on all inputs* (a wrong-role paint): a CFG-derived role vs a regex-stack-machine tokenizer
over an infinite input space. That is handled by-construction + `test/gap-ledger.ts`'s corpus, not
claimed decided here. So the honest scope: a structural **presence** proof, **decidable per grammar**,
**executed on the shipped set**, with the algebra-closure as its inductive backbone — and the detector's
power **measured** (mutation testing), not proven, for the shape class.

## Reachability — root ∪ export surfaces

Reachability is the transitive `#include` closure from the root `patterns`, **plus the declared
export surfaces** an external embedder reaches by a `<scope>#<key>` include: the `#expression`
sub-grammar (`expressionRule`), the `canonicalRepoNames` official keys, and `aliasScopes`. These
are root-unreachable *by design* — they are the grammar's public repository API. A naïve
root-only reachability flags ten keys as dead; the export-surface-aware closure flags **zero**.
A `canonicalRepoNames` entry whose structural *source* is absent in a shared map (e.g. `type`/
`new-expr` in JavaScript, which has no type layer; `cast` in `.tsx`, where `<T>expr` is JSX, so
only `as`-casts exist) induces no obligation and is correctly inert — distinct from a dangling
reference with a *present* source, of which there are none.

## The frontier — no proven impossibility

Three sites looked like TextMate impossibilities; under adversarial attack (the project's
discipline: a "can't" must survive a real attack before it is recorded), all three were
**refuted** with constructions tested in the production engine:

- **Cast/arrow "not after a value" across unbounded whitespace.** gen-tm emits a fixed-width
  negative-lookbehind ladder (`\s{k}`, k=0..16). The exact unbounded condition is a single
  variable-width lookbehind `(?<![\w$)\]]\s*)`, which **vscode-oniguruma compiles and runs
  correctly** (verified: suppresses `a   <b`, fires at expr-start). An Onigmo-portable
  alternative also exists (a region that *owns* the post-value whitespace boundary instead of
  looking behind it).
- **Arrow param list with nested parens** `(a = f(1)) => x`. The single-level `[^()]*` lookahead
  breaks at the inner `(`, but Oniguruma's recursive subroutine `(?<P>\((?:[^()]|\g<P>)*\))`
  matches balanced parens at arbitrary depth in a begin lookahead (verified to compile + match).
- **Regex after a control-flow head** `if (a) /re/`. A variable-width positive lookbehind
  `(?<=\b(?:if|while|for|with)\s*\([^()]*\))` (or the recursive form for nested heads)
  **compiles and matches in vscode-oniguruma** (verified: matches `if (a) /`, not `a / b`).

So none of these is a model impossibility. Each is (a) directly expressible in vscode-oniguruma
— the engine VS Code actually runs — and (b) approximated by a fixed-width form *deliberately*,
for **Onigmo portability** (RedCMD's YAML grammar runs under Onigmo, which rejects variable-width
lookbehind; the same source must compile under both, see `test/redcmd-tm-diagnostics.ts`). And
each is a **soundness-precision** matter, not a completeness gap: the `<` / `/` / arrow *is*
recognised and scoped; what is refined at the frontier is *which* role at the ambiguous boundary.
Improving that precision (var-width forms for the `vscode-oniguruma`-only grammars, `\g<>` for the
arrow region) is a separate, soundness-gated change. **The completeness obligation is discharged.**

## Soundness — no ceiling, audited not assumed

Completeness is *presence*; soundness is *correctness* — does each present construct read the
*right* scope on every input. Soundness is not decided here (`test/scope-gap.ts` / `gap-ledger`), but
one structural question about it **is** settled: does gen-tm have a *ceiling* — a scope obligation no
TextMate grammar can reproduce, the wall the naive "regex < CFG" intuition predicts? By exhaustive
audit the answer is **no ceiling on well-formed input** — and the reason is not that TextMate is
omnipotent but that gen-tm's *obligation space* is itself TextMate-bounded:

- **The obligation is the role map, not the parse.** A scope in Monogram is `f(token type)` [lex-time]
  or `f(literal text)` [`scopeOverrides`], plus a finite set of shape-detectors — there is no general
  *rule-context → scope* channel. So even when the CST encodes unbounded context (a cross-serial index,
  a depth parity), the highlighting obligation does not read it; there is nothing for TextMate to fail
  to reproduce. Two such candidates, built and run through `createParser` + the role map, both
  *dissolve* at the obligation layer.
- **The dichotomy.** A context-dependent scope is therefore one of: *lex-local* (a plain match),
  *bounded* (a fixed-width neighborhood), or *delimiter-carried recursion* — unbounded nesting whose
  every level has a **consumable** delimiter (`{`, `<`, `-`), so a `\G`/`\g<>`/self-include reproduces
  it to unbounded depth (the YAML compact block-sequence: 0 mismatch d=1..12). The only shape that
  *would* be a ceiling — unbounded, **non-delimiter**, parser-assigned context — is unconstructable
  here: a delimiter-less depth scope is one the *parser itself* cannot assign from finite roles.
- **The audit.** Every context-dependent scope channel was enumerated (independently re-derived from
  the emitted grammar — 78 keyword/identifier heads — and ground-truthed with `vscode-oniguruma` at
  deep nesting): each is lex-local, bounded, or delimiter-carried; the ceiling shape occurs **zero**
  times. Delimiter-carried reproduction was confirmed frame-per-level with no fixed-arity cap (enum
  d=25, generic d=60, JSX d=20, template `${}` d=20).

Honest bounds: this is **well-formed-input** soundness, and **strong evidence + a structural argument,
not a closed-form ∀-grammar proof** — it audits the channels gen-tm *emits* and infers "unbounded"
from monotone frame growth verified to depth 60. `highlighter ≡ parser` thus holds on well-formed
input but is **not a total equivalence**: broken/partial input still has local region-leaks where a
regex region's heuristic boundary diverges from the parse. The audit *derived* two such over-accepts
the corpus was blind to — an enum brace-leak and a `module`/`namespace`/`type` declaration-keyword
over-accept — and root-caused both in gen-tm. They were fixable bugs, not ceilings.

## The proof ledger

The fixed denominator is every measured obligation (token discharge + repository reachability +
leaf painting), summed across the six grammars; the numerator is the discharged count.
Auto-generated by `node test/tm-completeness.ts --write`; `--check` fails CI if it is stale.

<!-- COMPLETENESS-LEDGER:START — auto-generated by `node test/tm-completeness.ts --write`; do not edit by hand. -->

| Grammar | Tokens | Keyword literals | Repo keys (reachable) | Leaf cross-check (corpus) |
|---|---:|---:|---:|---:|
| typescript | 11/11 | 73/73 | 158/158 | 199/199 |
| javascript | 11/11 | 51/51 | 103/103 | 131/131 |
| typescriptreact | 13/13 | 73/73 | 171/171 | 169/169 |
| javascriptreact | 13/13 | 51/51 | 116/116 | 121/121 |
| html | 7/7 | 0/0 | 28/28 | 175/175 |
| yaml | 19/19 | 0/0 | 54/54 | 1638/1638 |
| **total** | **74/74** | **248/248** | **630/630** | **2433/2433** |

**Decidable completeness: 952/952 = 100.00%** (token discharge 74/74 · keyword-literal discharge 248/248 · repository reachability 630/630) — a structural check on the emitted artifact, no corpus. Leaf cross-check (corpus, redundant): 2433/2433. **0 open completeness gaps.**

<!-- COMPLETENESS-LEDGER:END -->

## The gates that hold this exact

- `test/tm-completeness.ts` — Layer A closure (RuleExpr / TokenPattern / `collectLiterals`), the
  `sep`-recursion regression guard, reachability, the token census (orphans + neuter), and leaf
  coverage with a fixed denominator. `npm run completeness`; `npm run completeness:check` gates the ledger.
- `test/tm-mutation.ts` — the **meta-gate**: injects known gaps and asserts every presence gap is
  killed with no false alarms, measuring (not asserting) the detector's power. `npm run completeness:mutation`.
- `test/agnostic.ts` — detector shape-completeness: the detectors fire on structure, not on TS
  names, so "every shape that bears the obligation is detected" holds for any grammar.
- `test/scope-gap.ts`, `test/gap-ledger.ts` — the **soundness** axis (is each painted scope
  correct?), the dual of this document, kept separate on purpose.
