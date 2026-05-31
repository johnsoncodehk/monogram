# Monogram

Write a language's grammar **once**. Monogram runs that single definition as a real parser, proves it against the language's official conformance suite, and then **derives a syntax highlighter** — TextMate, tree-sitter, Monarch — from the same proven grammar. The highlighter's correctness flows *down* from a parser-verified model instead of *up* from hand-tuned regex.

> *mono + grammar — one grammar definition, many derived artifacts.*

**Status:** an active research project with **two languages on one shared core**. TypeScript ([`typescript.ts`](typescript.ts)) is mature — 100% valid-code coverage, 97.8% bidirectional, and a highlighter graded *absolutely* against a neutral oracle (more correct than the official grammar on its own bug ledger; see [Results](#results)). JavaScript ([`javascript.ts`](javascript.ts)) is newer: it parses real-world JS, is the standalone ECMAScript base that the TypeScript grammar extends, and its derived highlighter is graded by the *same* neutral oracle (92.6% — ahead of the official JavaScript grammar); it doesn't yet have TypeScript's full conformance-corpus depth. The engine is language-agnostic by construction and built for others to follow (see [Adding a language](#adding-a-language)).

## Quick start

Requires Node 24+ (runs `.ts` directly — no build step, no `tsx`).

```bash
npm install
node src/cli.ts typescript.ts        # regenerate every artifact from the grammar
```

```ts
import { createParser } from './src/gen-parser.ts';
import grammar from './typescript.ts';

const { parse } = createParser(grammar);
const cst = parse('const x = f(a, b)');        // → a concrete syntax tree
```

## The idea

A TextMate grammar is a pile of regexes guessing at a language's structure. It's written by hand, independently of any parser, and it's perpetually wrong at the edges — VS Code's official TypeScript grammar carries [100+ open issues](https://github.com/microsoft/TypeScript-TmLanguage/issues) for exactly this reason. Everyone trying to fix it competes on the same losing axis: *who can hand-write better regexes.*

Take `typeof x < y`. A regex highlighter has to guess whether `<` opens a generic argument list or is a less-than comparison — and it guesses wrong somewhere, forever. A **parser** doesn't guess; the grammar already decides. Monogram inverts the dependency:

1. **Write the grammar, then prove it.** The grammar is executable. Monogram runs it as a recursive-descent + [Pratt](https://en.wikipedia.org/wiki/Operator-precedence_parser) (operator-precedence) parser over the TypeScript conformance suite and measures *bidirectionally* — it must **accept** every input `tsc` accepts **and reject** every input `tsc` rejects. Today: **100%** of valid single-file cases parse, and **97.8%** bidirectional agreement (see [Results](#results)).

2. **Derive the highlighter from the proven grammar.** The TextMate grammar — and the tree-sitter / Monarch ones — are generated from that same parser-validated definition, never hand-written. Their correctness is underwritten by the conformance run, not by regex tuning.

The remaining 2.2% is pure **over-acceptance** (nothing valid is missed): invalid code `tsc` rejects via *context-sensitive* rules a context-free grammar can't express — reserved-word placement, `default abstract class`, `super` type-arguments. That's the asymptote of a pure grammar, and the highlighter rides down to it for free.

You can't out-regex a parser-derived grammar, because its correctness comes from a dimension hand-written grammars never touch. The evidence is concrete: [`test/test-issues.ts`](test/test-issues.ts) replays **50 real bugs** from the official grammar's tracker (318 token checks pass, **all 50 still open upstream**), and the [neutral-oracle bench](#results) confirms a large subset as objective fixes — official structurally wrong, Monogram right. The [**upstream issue ledger**](docs/upstream-issues.md) gives an honest verdict on every issue we *don't* solve, too.

## Results

```
Valid-code coverage  100%    3376 / 3376 valid single-file cases parse        (zero gaps; no valid code missed)
Bidirectional        97.8%   3585 / 3664 — also rejects what tsc rejects      (gap = over-acceptance only)
Official-grammar bugs  50    issues replayed (318 checks pass); 21 independently re-verified vs tsc — all still open upstream
Source size          ~1,050 lines (JS + TS together) — under a third of the official 3331-line TextMate grammar for TS alone
Engine               language-agnostic — zero TypeScript-specific code (proven by test/agnostic.ts)
```

Read the last two lines together — that's the whole argument. **Under a third of the official's hand-written line count, on a language-agnostic engine** — and it still ships a conformance-proven parser the official grammar never had, with a derived highlighter that comes out **more correct than official on its own documented bug ledger** (measured below; a few scope differences are [deliberate](#known-differences-from-the-official-highlighter)). Less to maintain, demonstrably more correct.

**Highlighter correctness, per language** — auto-generated by [`test/highlight-bench.ts`](test/highlight-bench.ts):

<!-- bench:start -->
<!-- generated by `npm run bench:readme` — do not edit by hand -->

**Token-family accuracy vs a neutral `tsc` oracle** — for each token, did the highlighter put it in the
right family (*type / value / keyword / literal / comment / property*)? That is where the errors that matter
live (a **value** painted as a **type**, a **regex** as an **operator**). Monogram's TextMate output is *derived*
from its conformance-proven parser; each baseline is the official hand-written grammar for that language.

| Language | Monogram (derived) | Official |
| --- | --- | --- |
| TypeScript | **87.6%** | 76.2% |


**TSX** (the JSX dialect) has no neutral `tsc` oracle to grade against — tsc exposes no per-token JSX scope roles — so it is measured as drop-in agreement with the official **TypeScriptReact** grammar over a JSX corpus ([`test/tsx-corpus.ts`](test/tsx-corpus.ts)): Monogram matches it on **100.0%** of JSX tokens at the family level (**98.7%** exact). The non-JSX code in a `.tsx` file is the TypeScript row above.

<sub>Higher = more correct. TypeScript is graded on the ambiguity-rich documented-bug ledger ([`test/issue-cases.ts`](test/issue-cases.ts)) — the cases where a hand-written regex grammar slips; JavaScript on a representative corpus ([`test/js-corpus.ts`](test/js-corpus.ts)). The same TypeScript grammar also derives a **tree-sitter** highlighter that scores **95.9%** — above official tree-sitter (92.7%). Regenerate: `npm run bench:readme`.</sub>
<!-- bench:end -->

Monogram is more correct than the official hand-written grammar in TypeScript and JavaScript, and matches it in TSX — all from one shared, conformance-proven core. (On *unambiguous* code the TextMate grammars are neck-and-neck at ~99%; the ledger above is the ambiguity-rich code where a parser-derived highlighter pulls clear. The tree-sitter output, derived from the *same* grammar, leads outright at 95.9% — CI-gated by `npm run gate:treesitter`, which builds the wasm and asserts it beats official.)

## What you get

From one grammar definition (a small TypeScript combinator API), three outputs are **fully functional**:

- **A lexer** — tokenizes source straight from the grammar's token definitions; usable on its own (`createLexer(grammar).tokenize`).
- **A CST parser** — recursive descent + Pratt precedence on top of the lexer, producing a **CST** (concrete syntax tree: every token is a node, including punctuation and keywords — not just the semantically meaningful nodes an AST keeps).
- **A TextMate grammar** — a `.tmLanguage.json` for VS Code / Sublime syntax highlighting, derived from the same rules, including derived **JSDoc-body** and **regex-internal** sub-grammars. (TextMate *scopes* are the dot-separated labels — `entity.name.function`, `keyword.control` — that a theme maps to colors.)
- **A VS Code language configuration** — `language-configuration.json` (comments, bracket pairs, auto-close/surround, folding) derived from the same tokens.
- **CST node types** — a TypeScript discriminated union (keyed by rule) for typed tree consumers.

And — from the same grammar — generators for the rest of the ecosystem, at varying maturity:

- **tree-sitter** — `grammar.js` + a **structural** `queries/highlights.scm` + an external scanner for context-sensitive lexing. Builds end-to-end (tree-sitter's GLR absorbs the grammar; compiles to wasm) and the *derived* query scores **95.9%** through the same oracle — **above official tree-sitter** (92.7%). **CI-gated**: `npm run gate:treesitter` builds the wasm (the tree-sitter CLI bundles its own toolchain — no emscripten) and fails if Monogram drops below a floor or stops beating official.
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

Flat, irreducible facts — which keywords are control flow, which punctuation is an operator — are declared once in a small `scopes` map (≈50 lines for TypeScript) rather than inferred. Structure is derived; vocabulary is declared.

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

This isn't hypothetical: **JavaScript is a second language on the same engine.** Since TypeScript = JavaScript + a type layer, [`javascript.ts`](javascript.ts) is the standalone ECMAScript base that owns the shared vocabulary (tokens, operator precedence, base scopes, reserved-word guards), and [`typescript.ts`](typescript.ts) *imports* it and adds the type layer — the dependency runs subset → superset only. JavaScript parses real-world JS ([`test/js-conformance.ts`](test/js-conformance.ts): 61/61 valid snippets accepted, TS-only syntax rejected, ground truth `tsc` in JS mode) and its derived highlighter is graded by the *same* neutral oracle ([`test/js-highlight-bench.ts`](test/js-highlight-bench.ts): **92.6%** token-family accuracy, ahead of the official JavaScript TextMate grammar's 90.7%). It doesn't yet have TypeScript's full conformance-corpus depth, but it proves the claim below — a second language is *one grammar file on an unchanged engine*.

A **dialect** is cheaper still. [`typescriptreact.ts`](typescriptreact.ts) (`.tsx`) and [`javascriptreact.ts`](javascriptreact.ts) (`.jsx`) are *three lines each*: they take the proven TypeScript / JavaScript grammar and apply one shared JSX layer ([`jsx.ts`](jsx.ts)) — which prepends a `JSXElement` expression and drops the `<T>` cast — reusing the base's rules **verbatim, by name**, without re-declaring them. Same engine, same conformance discipline ([`test/tsx-conformance.ts`](test/tsx-conformance.ts), [`test/jsx-conformance.ts`](test/jsx-conformance.ts)), scope names matching VS Code's official `source.tsx` / `source.js.jsx`.

A new language is **one grammar file, proven the way TypeScript is** — by its own parser conformance, not by eyeballing colors:

1. **Write the grammar** with the combinator API ([`src/api.ts`](src/api.ts)). All language-specifics live here; the engine stays untouched.
2. **Prove it as a parser** against the language's *own* official test suite, measured **bidirectionally** (accept what the reference accepts, reject what it rejects). A grammar is "ready" when valid-code coverage is 100% and bidirectional agreement is high — that run is the correctness proof.
3. **Bring the reference highlighter as the baseline.** Drop in the language's existing official TextMate grammar so coverage is *measured against the thing you're replacing*, not asserted.

The highlighter, lexer, and CST types fall out of step 1 automatically (the tree-sitter / Monarch generators give you a scaffold to finish); steps 2–3 are how the result earns trust. A new-language PR is reviewed on exactly two numbers: **parser conformance** and **highlighter coverage vs the official grammar**.

> The conformance and highlighter *harnesses* are currently TypeScript-specific — they call `tsc`'s `parseDiagnostics` and read VS Code's bundled TS grammar. A contributor adapts those harness scripts to their reference compiler's diagnostic API; the engine and generators themselves are reused unchanged.

## Embedded languages

Editors highlight embedded snippets (CSS in a template, JSDoc in a comment) by handing the region to another grammar at the boundary — flaky in VS Code, because the host and embedded grammars are written independently and nothing checks they agree on the seam.

Monogram declares embedding points in the grammar (a token's `embed` annotation), today emitting the standard TextMate `contentName` injection. The design goal it sets up — **not yet implemented** — is to generate both sides from Monogram grammars and verify the seam in one integrated self-test, instead of hoping two strangers agree.

## Tests

Self-contained (no external setup):

```bash
node test/sanity-check.ts        # quick smoke test
node test/agnostic.ts            # proves the engine is language-agnostic
node test/test-issues.ts         # replays 50 official-grammar bugs against the generated grammar
node test/js-conformance.ts      # JavaScript: 61/61 curated valid-JS accepted, TS-only syntax rejected
node test/js-highlight-bench.ts  # JavaScript highlighter accuracy vs the neutral tsc-JS oracle (92.6%)
```

The conformance and highlighter benches read external grammars/corpora and are **excluded from CI** for that reason:

```bash
git clone https://github.com/microsoft/TypeScript /tmp/ts-repo   # the conformance corpus
node test/conformance-matrix.ts  # THE parser metric: bidirectional vs tsc — 100% valid / 97.8% both ways

# the highlighter bench reads VS Code's bundled TS grammar (macOS path; override with MONOGRAM_OFFICIAL_TM):
node test/highlight-bench.ts                       # absolute correctness, both grammars vs a neutral tsc oracle
node test/highlight-bench.ts --corpus adversarial  # documented bug ledger only (no /tmp/ts-repo needed)
node test/highlight-bench.ts --write-readme        # regenerate the per-language table above
node test/scope-coverage.ts                        # drop-in COMPATIBILITY gaps vs official (scope fidelity, missing regex/JSDoc sub-grammars, TSX) — what correctness doesn't measure
```

> `test/run-conformance.ts` reports a *raw accept-rate* (94.2% over all 3776 files, multi-file cases included) — an acceptance-only sanity check, not the bidirectional proof. `conformance-matrix.ts` is the number this README quotes.

## Known differences from the official highlighter

A handful of token patterns are scoped differently from VS Code's official TypeScript grammar — all intentional, and in some Monogram is arguably *more* correct (these are *deliberate divergences*, distinct from the bug-class fixes the [bench](#results) measures):

| Token | Monogram | Official | Why we keep ours |
|---|---|---|---|
| `console` in `console.log` | `support.variable` | `variable.other.object` | We highlight built-in globals (`console`, `window`, …) distinctly — a deliberate, common choice. |
| `transform` (a function parameter) | `variable.parameter` | `entity.name.function` | It **is** a parameter. Official's heuristic mis-reads `name: (…) => T` as a function definition; we're more correct. |
| `error` (the method in `console.error(…)`) | `entity.name.function` | `variable.other.readwrite` | We scope a called method as a function name — arguably more informative. |

> Built-in class names in **type** position (e.g. `Error` in `extends Error`) correctly emit `entity.name.type`, matching official; in **value** position (`new Error()`) they remain `support.class`, also matching official.

Matching the official grammar *exactly* would, in cases like `transform`, make the output worse. The metric counts these as differences, not defects.

## Architecture

```
typescript.ts                one grammar (TypeScript combinator API)
        │
        ├─ src/gen-lexer.ts  ───────▶ lexer → tokens        (standalone: createLexer)
        │        ▲ composed by
        ├─ src/gen-parser.ts ───────▶ CST parser   (recursive descent + Pratt + packrat memoization;
        │                             run against the conformance suite = the grammar's proof)
        │
        ├─ src/gen-tm.ts ───────────▶ typescript.tmLanguage.json            (TextMate highlighter)
        ├─ src/gen-vscode-config.ts ▶ typescript.language-configuration.json (editor behavior)
        ├─ src/gen-treesitter.ts ───▶ tree-sitter/  (grammar.js + highlights.scm + scanner.c)
        ├─ src/gen-monarch.ts ──────▶ typescript.monarch.json
        └─ src/gen-ast-types.ts ────▶ typescript.cst-types.ts

shared  src/grammar-utils.ts          structural helpers used across stages
        src/api.ts, types.ts          the grammar's combinator + type surface
```

Every highlighter target is produced by the *same* structural scope-inference, retargeted per format. Two design choices worth noting:

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
