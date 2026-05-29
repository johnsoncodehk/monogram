# Monogram

Write a language's grammar **once**. Monogram runs that single definition as a real parser, proves it against the language's official conformance suite, and then **derives a syntax highlighter** — TextMate, tree-sitter, Lezer, Monarch — from the same proven grammar. The highlighter's correctness flows *down* from a parser-verified model instead of *up* from hand-tuned regex.

> *mono + grammar — one grammar definition, many derived artifacts.*

**Status:** an active research project with **two languages on one shared core**. TypeScript ([`examples/typescript.ts`](examples/typescript.ts)) is mature — 100% valid-code coverage, 97.8% bidirectional, and a highlighter graded *absolutely* against a neutral oracle (more correct than the official grammar on its own bug ledger; see [Results](#results)). JavaScript ([`examples/javascript.ts`](examples/javascript.ts)) is newer: it parses real-world JS and is the standalone ECMAScript base that the TypeScript grammar extends — but it does not yet have TypeScript-level conformance or highlighter-coverage validation. The engine is language-agnostic by construction and built for others to follow (see [Adding a language](#adding-a-language)).

## Quick start

Requires Node 24+ (runs `.ts` directly — no build step, no `tsx`).

```bash
npm install
node src/cli.ts examples/typescript.ts        # regenerate every artifact from the grammar
```

```ts
import { createParser } from './src/gen-parser.ts';
import grammar from './examples/typescript.ts';

const { parse } = createParser(grammar);
const cst = parse('const x = f(a, b)');        // → a concrete syntax tree
```

## The idea

A TextMate grammar is a pile of regexes guessing at a language's structure. It's written by hand, independently of any parser, and it's perpetually wrong at the edges — VS Code's official TypeScript grammar carries [100+ open issues](https://github.com/microsoft/TypeScript-TmLanguage/issues) for exactly this reason. Everyone trying to fix it competes on the same losing axis: *who can hand-write better regexes.*

Take `typeof x < y`. A regex highlighter has to guess whether `<` opens a generic argument list or is a less-than comparison — and it guesses wrong somewhere, forever. A **parser** doesn't guess; the grammar already decides. Monogram inverts the dependency:

1. **Write the grammar, then prove it.** The grammar is executable. Monogram runs it as a recursive-descent + [Pratt](https://en.wikipedia.org/wiki/Operator-precedence_parser) (operator-precedence) parser over the TypeScript conformance suite and measures *bidirectionally* — it must **accept** every input `tsc` accepts **and reject** every input `tsc` rejects. Today: **100%** of valid single-file cases parse, and **97.8%** bidirectional agreement (see [Results](#results)).

2. **Derive the highlighter from the proven grammar.** The TextMate grammar — and the tree-sitter / Lezer / Monarch ones — are generated from that same parser-validated definition, never hand-written. Their correctness is underwritten by the conformance run, not by regex tuning.

The remaining 2.2% bidirectional gap is **over-acceptance** — the grammar is still too permissive on some *invalid* inputs (valid-code coverage is already 100%; nothing valid is missed). Most of what's left is code `tsc`'s parser rejects via *context-sensitive* rules a context-free grammar can't express — reserved-word placement, modifier combinations like `default abstract class`, `super` type-arguments — the kind of constraint a highlighter grammar was never meant to enforce. We push as close to 100% both ways as a pure grammar can; that's the asymptote, and the highlighter rides down to it for free.

That's the categorical part: a highlighter derived from a parser-proven grammar isn't *a better hand-written grammar* — it's playing a different game. You can't out-regex it, because its correctness comes from a dimension hand-written grammars never operate in. The evidence is concrete — [`test/test-issues.ts`](test/test-issues.ts) replays **50 real bugs** from the official grammar's issue tracker (the `typeof x < y` ambiguities, regex-after-keyword cases, `as`-casts inside `<>`, nested `>>`), all **318** token checks pass, and **all 50 are still open upstream** — ~47% of the 106 open official issues. A separate *neutral-oracle* bench ([`test/highlight-bench.ts`](test/highlight-bench.ts)) then re-grades *both* grammars against `tsc` and independently confirms a large subset as objective fixes — official structurally wrong, Monogram right (see the [auto-generated head-to-head](#head-to-head-highlighter-correctness-vs-the-official-grammar)) — because those failure modes are *structurally precluded* by a parser rather than patched one regex at a time. The [**upstream issue ledger**](docs/upstream-issues.md) tracks exactly which issues we solve and gives an honest verdict on each one we don't (backlog / out-of-scope / needs-semantics / proven-TM-impossible).

## Results

Measured against the TypeScript compiler's own conformance suite (single-file cases; `tsc`'s `parseDiagnostics` is ground truth):

```
Valid-code coverage  100%    3376 / 3376 valid single-file cases parse        (zero gaps; no valid code missed)
Bidirectional        97.8%   3585 / 3664 — also rejects what tsc rejects      (gap = over-acceptance only)
Highlighter          graded absolutely vs a neutral tsc oracle — see Head-to-head below (auto-generated)
Official-grammar bugs  50    issues replayed (318 checks pass); 21 independently re-verified vs tsc — all still open upstream
Source size          628 lines — 5× fewer than the official 3331-line hand-written TextMate YAML
Engine               language-agnostic — zero TypeScript-specific code (proven by test/agnostic.ts)
```

Read the last two lines together — that's the whole argument. **One 628-line grammar replaces the official 3331-line hand-written TextMate YAML at a fifth the line count** *and* throws in a conformance-proven parser the official grammar never had. **Less to maintain, and demonstrably more correct.**

The valid-code/bidirectional numbers are the grammar's correctness proof; the highlighter correctness that proof buys is measured *absolutely* below — Monogram comes out **more correct than the official grammar on its own documented bug ledger**, not merely a faithful copy of it. (A few scope differences from official are deliberate — see [Known differences](#known-differences-from-the-official-highlighter).)

### Head-to-head: highlighter correctness vs the official grammar

**Auto-generated** by [`test/highlight-bench.ts`](test/highlight-bench.ts) — one row per language, more as Monogram gains them:

<!-- bench:start -->
<!-- generated by `npm run bench:readme` — do not edit by hand -->

Each bar = **% of that language's documented official-grammar bugs** the highlighter renders
correctly, graded against a neutral `tsc` oracle (100% = all of them). Monogram derives its
highlighter from its conformance-proven parser; the official one is hand-written regex.

```
TypeScript
  Monogram  ██████████████████░░░░  80%  (39/49)
  official  █████████░░░░░░░░░░░░░  39%  (19/49)
JavaScript
  pending — JS not yet on the neutral-oracle bench (see ROADMAP)
```

<sub>TypeScript = 49 oracle-adjudicable open [`microsoft/TypeScript-TmLanguage`](https://github.com/microsoft/TypeScript-TmLanguage/issues) issues ([`test/issue-cases.ts`](test/issue-cases.ts)) — 21 of Monogram's wins are fixes the official grammar gets *structurally* wrong. Per-issue breakdown: `node test/highlight-bench.ts`. Regenerate: `npm run bench:readme`.</sub>
<!-- bench:end -->

> **The other side of the ledger (honesty check).** On the *broad* TS parser-conformance corpus — not just the documented bugs — the two are now neck-and-neck: token-role accuracy is **tied at ~99%**, Monogram **leads on per-cell coverage** (100% of strict cells vs official's ~97%), and whole-file-perfect snippets are essentially level (~88% vs ~89%). The small residual is niche multiline type-annotation scoping, **not** the ambiguity class above. Clone the TS corpus to `/tmp/ts-repo` and run `node test/highlight-bench.ts` to see both corpora.

## What you get

From one grammar definition (a small TypeScript combinator API), three outputs are **fully functional**:

- **A lexer** — tokenizes source straight from the grammar's token definitions; usable on its own (`createLexer(grammar).tokenize`).
- **A CST parser** — recursive descent + Pratt precedence on top of the lexer, producing a **CST** (concrete syntax tree: every token is a node, including punctuation and keywords — not just the semantically meaningful nodes an AST keeps).
- **A TextMate grammar** — a `.tmLanguage.json` for VS Code / Sublime syntax highlighting, derived from the same rules. (TextMate *scopes* are the dot-separated labels — `entity.name.function`, `keyword.control` — that a theme maps to colors.)
- **A VS Code language configuration** — `language-configuration.json` (comments, bracket pairs, auto-close/surround, folding) derived from the same tokens.
- **CST node types** — a TypeScript discriminated union (keyed by rule) for typed tree consumers.

And — from the same grammar — **first-pass generators** for the rest of the ecosystem. These are structurally valid and a strong starting point, but each carries known incomplete sections (marked in the output) that need hand-tuning before production:

- **tree-sitter** — `grammar.js` + `queries/highlights.scm` + an external-scanner scaffold (template state machine stubbed).
- **Lezer** — a CodeMirror 6 grammar + `styleTags` + a JS tokenizer (a handful of token regexes can't be expressed in Lezer's static model; marked `INCOMPLETE`).
- **Monarch** — a Monaco (web) tokenizer (functional, bounded by JS-regex limits).

## The grammar is the source of truth

A grammar is a TypeScript module: tokens, operator precedence, and rules built from small combinators. A self-contained mini-example:

```ts
import { token, rule, defineGrammar, left, op, sep } from './src/api.ts';

const Ident  = token(/[a-zA-Z_$][a-zA-Z0-9_$]*/, { identifier: true });
const Number = token(/[0-9]+(\.[0-9]+)?/);

const Expr = rule($ => [
  Ident,
  Number,
  [$, op, $],                    // binary operators (precedence declared below)
  [$, '(', sep(Expr, ','), ')'], // call:    foo(a, b)
  [$, '.', Ident],               // member:  obj.name
]);

export default defineGrammar({
  name: 'mini',
  tokens: { Ident, Number },
  prec: [ left('+', '-'), left('*', '/') ],
  rules: { Expr },
  entry: Expr,
});
```

The parser uses these rules to build a CST. The highlighter reads the same rule **shapes** and infers most scopes structurally — with no per-rule annotation:

- `foo(x)` → `foo` is `entity.name.function` (from the `$ '(' …` call form)
- `obj.name` → `name` is `entity.other.property` (from the `$ '.' Ident` form)
- `'class' Ident` → `Ident` is `entity.name.type` (from declaration structure)
- `Expr '<' Type '>' '('` → a generic call, not a comparison (from rule structure)

Flat, irreducible facts — which keywords are control flow, which punctuation is an operator — are declared once in a small `scopes` map (≈45 lines for TypeScript) rather than inferred. Structure is derived; vocabulary is declared.

## A language-agnostic engine

Nothing in the engine knows about TypeScript. Everything language-specific lives in the grammar — keywords, which token is the identifier, template-literal delimiters, the regex-vs-division lexer ambiguity — all *declared per token*:

```ts
const Template = token(/`…`/, { template: { open: '`', interpOpen: '${', interpClose: '}' } });
const Regex    = token(/\/…\//, {
  regex: true,
  regexContext: {
    divisionAfterTypes: ['Ident', 'Number', 'String', 'Template'],
    divisionAfterTexts: [')', ']', 'this', 'true', /* … */],
    regexAfterTexts:    ['return', 'typeof', 'instanceof', /* … */],
  },
});
```

[`test/agnostic.ts`](test/agnostic.ts) proves it: the same engine parses a toy grammar whose identifier token is named `Word`, with no templates and no regex. Supporting a new language means writing a new grammar file, not changing the engine.

## Adding a language

This isn't hypothetical: **JavaScript is the second language on the same engine**, and it shares a core with TypeScript rather than duplicating it. JavaScript is the syntactic *subset* of the ECMAScript family (TypeScript = JavaScript + a type layer), so [`examples/javascript.ts`](examples/javascript.ts) is the standalone base that **owns and exports** the shared vocabulary — the token set, the operator-precedence ladder, the base scope map, and the reserved-word guards — and [`examples/typescript.ts`](examples/typescript.ts) *imports* that vocabulary and extends it with the type layer (type rules + the extra type scopes). The dependency runs subset → superset only; the JS grammar has no type knowledge and depends on nothing but the engine's combinator API. (The rules themselves are copied-and-stripped rather than shared, because combinator rules bind their references at definition time; only the vocabulary layer is imported.) JavaScript parses real-world JS — [`test/js-conformance.ts`](test/js-conformance.ts) accepts 61/61 curated valid-JS snippets and rejects TypeScript-only syntax (type annotations, `enum`, `!`, `<T>` casts), with ground truth being `tsc`'s own parser in JS mode. It does not yet have TypeScript's conformance- and coverage-level validation, but it already proves the claim below that a second language is *one grammar file on an unchanged engine*.

A new language is **one grammar file, proven the way TypeScript is** — by its own parser conformance, not by eyeballing colors:

1. **Write the grammar** with the combinator API ([`src/api.ts`](src/api.ts)). All language-specifics live here; the engine stays untouched.
2. **Prove it as a parser** against the language's *own* official test suite, measured **bidirectionally** (accept what the reference accepts, reject what it rejects). A grammar is "ready" when valid-code coverage is 100% and bidirectional agreement is high — that run is the correctness proof.
3. **Bring the reference highlighter as the baseline.** Drop in the language's existing official TextMate grammar so coverage is *measured against the thing you're replacing*, not asserted.

The highlighter, lexer, and CST types fall out of step 1 automatically (the tree-sitter / Lezer / Monarch generators give you a scaffold to finish); steps 2–3 are how the result earns trust. A new-language PR is reviewed on exactly two numbers: **parser conformance** and **highlighter coverage vs the official grammar**.

> The conformance and highlighter *harnesses* are currently TypeScript-specific — they call `tsc`'s `parseDiagnostics` and read VS Code's bundled TS grammar. A contributor adapts those harness scripts to their reference compiler's diagnostic API; the engine and generators themselves are reused unchanged.

## Embedded languages

Editors highlight embedded snippets — CSS in a template string, a regex literal, JSDoc in a comment — by handing the region to another grammar at the boundary. In VS Code that works only if the host grammar and the embedded grammar, written independently by different authors, *both* implement the boundary correctly; nothing checks that they agree, so embedded highlighting is flaky at the seams.

Monogram declares embedding points in the grammar (a token's `embed` annotation), which today emits the standard TextMate `contentName` injection — the same model VS Code uses. The larger payoff is the design goal it sets up but **does not yet implement**: when the languages on both sides are Monogram grammars, one system can generate host and embedded together and exercise the seam in a single integrated self-test — verifying the boundary instead of hoping two strangers agree. The annotation exists; the joint seam-test does not, yet.

## Tests

Self-contained (no external setup):

```bash
node test/sanity-check.ts        # quick smoke test
node test/agnostic.ts            # proves the engine is language-agnostic
node test/test-issues.ts         # replays 50 official-grammar bugs against the generated grammar
```

The conformance and highlighter benches read external grammars/corpora and are **excluded from CI** for that reason:

```bash
git clone https://github.com/microsoft/TypeScript /tmp/ts-repo   # the conformance corpus
node test/conformance-matrix.ts  # THE parser metric: bidirectional vs tsc — 100% valid / 97.8% both ways

# the highlighter bench reads VS Code's bundled TS grammar (macOS path; override with MONOGRAM_OFFICIAL_TM):
node test/highlight-bench.ts                       # absolute correctness, both grammars vs a neutral tsc oracle
node test/highlight-bench.ts --corpus adversarial  # documented bug ledger only (no /tmp/ts-repo needed)
node test/highlight-bench.ts --write-readme        # regenerate the head-to-head block above
```

> `test/run-conformance.ts` reports a *raw accept-rate* (94.2% over all 3776 files, multi-file cases included) — an acceptance-only sanity check, not the bidirectional proof. `conformance-matrix.ts` is the number this README quotes.

## Known differences from the official highlighter

A handful of token patterns are scoped differently from VS Code's official TypeScript grammar — all intentional, and in some Monogram is arguably *more* correct (these are *deliberate divergences*, distinct from the bug-class fixes the [bench](#head-to-head-highlighter-correctness-vs-the-official-grammar) measures):

| Token | Monogram | Official | Why we keep ours |
|---|---|---|---|
| `console` in `console.log` | `support.variable` | `variable.other.object` | We highlight built-in globals (`console`, `window`, …) distinctly — a deliberate, common choice. |
| `transform` (a function parameter) | `variable.parameter` | `entity.name.function` | It **is** a parameter. Official's heuristic mis-reads `name: (…) => T` as a function definition; we're more correct. |
| `error` (the method in `console.error(…)`) | `entity.name.function` | `variable.other.readwrite` | We scope a called method as a function name — arguably more informative. |

> Built-in class names in **type** position (e.g. `Error` in `extends Error`) correctly emit `entity.name.type`, matching official; in **value** position (`new Error()`) they remain `support.class`, also matching official.

Matching the official grammar *exactly* would, in cases like `transform`, make the output worse. The metric counts these as differences, not defects.

## Architecture

```
examples/typescript.ts                one grammar (TypeScript combinator API)
        │
        ├─ src/gen-lexer.ts  ───────▶ lexer → tokens        (standalone: createLexer)
        │        ▲ composed by
        ├─ src/gen-parser.ts ───────▶ CST parser   (recursive descent + Pratt + packrat memoization;
        │                             run against the conformance suite = the grammar's proof)
        │
        ├─ src/gen-tm.ts ───────────▶ typescript.tmLanguage.json            (TextMate highlighter)
        ├─ src/gen-vscode-config.ts ▶ typescript.language-configuration.json (editor behavior)
        ├─ src/gen-treesitter.ts ───▶ tree-sitter/  (grammar.js + highlights.scm + scanner.c)
        ├─ src/gen-lezer.ts ────────▶ lezer/        (grammar + styleTags + tokenizer)
        ├─ src/gen-monarch.ts ──────▶ typescript.monarch.json
        └─ src/gen-ast-types.ts ────▶ typescript.cst-types.ts

shared  src/grammar-utils.ts          structural helpers used across stages
        src/api.ts, types.ts          the grammar's combinator + type surface
```

Every highlighter target (TextMate, tree-sitter queries, Lezer styleTags, Monarch) is produced by the *same* structural scope-inference, retargeted per format — so highlighting stays consistent across ecosystems.

- **One grammar, many derived artifacts.** `gen-lexer` builds a tokenizer from the token definitions; `gen-parser` composes it and interprets the rules into a CST; `gen-tm` reads the same rule *shapes* to derive TextMate patterns; `gen-vscode-config` derives editor config from the same tokens and `scopes`. Shared structural primitives (`grammar-utils.ts`) keep them consistent.
- **CST, not AST.** Keeping every token (punctuation, keywords) as a node is required for the highlighter and for lossless source reconstruction — roughly 2× the nodes of an AST, by design.
- **Every stage is language-agnostic.** All language specifics live in the grammar; lexer, parser, and generators are generic, reusable runtimes.

## Prior art

| Tool | Parser | Highlighting | Single source |
|------|:---:|:---:|:---:|
| TextMate grammars | — | manual regex | — |
| tree-sitter | yes | queries (written separately) | — |
| ANTLR | yes | — | — |
| Langium | yes | Monarch (separate config) | — |
| ungrammar | AST types | — | — |
| **Monogram** | **CST, conformance-proven** | **derived from the parser grammar** | **yes** |

These tools all have real parsers; what none of them do is *derive the highlighter from the parser's own grammar as a single source* — which is the one thing Monogram is for. There are now **two languages on that single engine** — JavaScript and TypeScript, sharing one ECMAScript core (subset → superset) rather than two hand-maintained grammars. (Conformance and coverage numbers in [Results](#results).)
