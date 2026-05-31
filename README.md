# Monogram

Write a language's grammar **once**, as an executable definition. Monogram runs it as a real parser, proves it against the language's official conformance suite, then **derives the syntax highlighters** — TextMate, tree-sitter, Monarch — from that same proven grammar. Highlighting correctness flows *down* from a parser-verified model instead of *up* from hand-tuned regex.

> *mono + grammar — one grammar definition, many derived artifacts.*

**Status** — an active research project; four languages on one shared, [language-agnostic](#a-language-agnostic-engine) engine, each [proven as a parser](#the-idea) before its highlighter is trusted:

- **TypeScript** ([`typescript.ts`](typescript.ts)) — mature: 100% valid-code coverage, 97.8% bidirectional vs `tsc`.
- **JavaScript** ([`javascript.ts`](javascript.ts)) — the standalone ECMAScript base TypeScript [builds on](#adding-a-language) (subset → superset); parses real-world JS, with less conformance-corpus depth than TS so far.
- **HTML** ([`html.ts`](html.ts)) — the engine reaching *past token streams into markup*; ~95 lines, validated against [`parse5`](https://github.com/inikulin/parse5).
- **Vue** ([`vue.ts`](vue.ts)) — a dialect of `html.ts`: SFC blocks that embed Monogram's own TS/JS/CSS, plus directives and `{{ }}` interpolation.

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

A TextMate grammar is a pile of regexes guessing at a language's structure. It's written by hand, independently of any parser, and perpetually wrong at the edges — VS Code's official TypeScript grammar carries [100+ open issues](https://github.com/microsoft/TypeScript-TmLanguage/issues) for exactly this reason. Everyone trying to fix it competes on the same losing axis: *who can hand-write better regexes.*

Take `typeof x < y`. A regex highlighter has to guess whether `<` opens a generic argument list or is a less-than comparison — and it guesses wrong somewhere, forever. A **parser** doesn't guess; the grammar already decides. Monogram inverts the dependency:

1. **Write the grammar, then prove it.** The grammar is executable — Monogram runs it as a recursive-descent + [Pratt](https://en.wikipedia.org/wiki/Operator-precedence_parser) (operator-precedence) parser over the TypeScript conformance suite, measured *bidirectionally*: it must **accept** every input `tsc` accepts **and reject** every input it rejects. **100%** of valid single-file cases parse, **97.8%** bidirectional — the 2.2% gap is pure **over-acceptance** (invalid code rejected only by *context-sensitive* rules a context-free grammar can't express: reserved-word placement, `default abstract class`, `super` type-arguments), so nothing valid is ever missed.

2. **Derive the highlighters from that proven grammar**, never hand-write them. The TextMate, tree-sitter, and Monarch outputs are all generated from the one parser-validated definition, so their correctness is underwritten by the conformance run, not by regex tuning.

The result is correct on a dimension hand-written regex never touches. **One ~1,050-line grammar** (JavaScript + TypeScript) replaces the official **3331-line** hand-written TextMate; the derived **tree-sitter** scores **95.9%** token-family accuracy against a neutral `tsc` oracle versus the official tree-sitter's **92.7%** (a real GLR parser from the same grammar; CI-gated, `npm run gate:treesitter`); and [`test/test-issues.ts`](test/test-issues.ts) gates the output against **50** of the official grammar's own documented bugs (318 checks, 21 independently re-verified vs `tsc`, all still open upstream). The bug-for-bug comparison, for every language, is the [ledger below](#on-every-languages-own-bug-ledger); a few scope differences are [deliberate](#known-differences-from-the-official-highlighter).

## It makes a neglected layer worth touching again

Syntax grammars are critical infrastructure — every editor, every rendered code block, every diff on the web leans on them — yet they're hand-maintained piles of regex that almost no one is incentivized to improve. The work is thankless and *un-leveraged*: a better regex fixes one edge in one grammar, so bugs sit open for years (TypeScript's 100+). Deriving the highlighter from a proven grammar changes the economics. An improvement is now **provable** (the conformance run says so), **leveraged** (one grammar fix flows to TextMate *and* tree-sitter *and* Monarch, across every language on the engine), and a genuine parsing problem rather than regex archaeology. The foundational layer everyone depends on and no one wanted to maintain becomes interesting to work on.

## Proofs beyond TypeScript: HTML and Vue

**HTML** stresses the engine where TypeScript can't: markup has no token stream, has raw-text elements (`<script>`), and treats whitespace as significant. From a **~95-line** [`html.ts`](html.ts) all three engines still derive — TextMate, Monarch, and tree-sitter (25/25 tree-equivalent to `parse5`, via a generated C external scanner for `<script>`/`<style>` raw text), each gated against `parse5`. And the embed runs the *right* way down: a `<script>` body is highlighted by Monogram's **own proven JavaScript grammar**, so `<script>const x = 1 < 2</script>` colours `<` as a JS operator, not a tag — the very `<` disambiguation from the idea above, now working *inside* the embed.

**Vue** is a dialect of `html.ts`: its SFC blocks embed Monogram's own TS/JS/CSS, and template directives (`v-if`, `:bind`, `@on`, `#slot`) and `{{ }}` interpolation inject Monogram's own TypeScript onto the template. The two mechanisms the hand-written official grammar codes by hand — a `begin/while` raw-text boundary (so a `<script>`'s embed can't leak past `</script>`) and an expression-only `source.ts#expression` embed (so `{{ }}` doesn't accept statements) — Monogram *derives* from the grammar.

Where all of this lands against real reported bugs is the ledger.

## On every language's own bug ledger

The same question, every language at once: take the bugs reported against each *hand-written* official grammar and ask whether the *derived* grammar solves them. Which does **only** the official solve, which does **only** Monogram solve — and which do **both** still get wrong (a shared TextMate ceiling, no regex grammar reaches it)?

<!-- issues:start -->
<!-- generated by `npm run bench:issues` — do not edit by hand -->
_Real bugs reported against each hand-written **official** grammar — does Monogram's **derived** grammar solve them? Both grammars current; graded against the documented-correct scope. Auto-generated by `npm run bench:issues`._

| language | vs hand-written grammar | Monogram | official | only Monogram | only official | both solve | both miss |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|
| TypeScript | microsoft/TypeScript-TmLanguage | **64/74** | 32/74 | 32 | 0 | 32 | 10 |
| HTML | VS Code's html.tmLanguage | **8/8** | 7/8 | 1 | 0 | 7 | 0 |
| Vue | vuejs/language-tools vue.tmLanguage.json | **11/12** | 11/12 | 0 | 0 | 11 | 1 |

#### TypeScript
**Only Monogram solves (32):** #978, #859, #1020, #855, #853, #804, #869, #770, #1021, #1025, #815, #992, #995 · +14 more

**Only official solves (0):** —

**Both miss (10, shared TM ceilings):** #1050, #891 · +8 more · both solve: 32

#### HTML
| issue | Monogram | official |
|---|:--:|:--:|
| tmbundle#118 — trailing `/` in an unquoted URL value **(only Monogram)** | ✓ | · |
| tmbundle#124 — slash in unquoted value `foo/` | ✓ | ✓ |
| vscode#140360 — `/` inside an unquoted value (path) | ✓ | ✓ |
| tmbundle#84 — tag name a prefix of a sibling (`<i>`/`<input>`) | ✓ | ✓ |
| tmbundle#117 — SVG camelCase tag name | ✓ | ✓ |
| tmbundle#122 — `<` inside a quoted attr value | ✓ | ✓ |
| tmbundle#115 — `>` inside a quoted attr value | ✓ | ✓ |
| tmbundle#97 — space before `>` in an end tag | ✓ | ✓ |

#### Vue
| issue | Monogram | official |
|---|:--:|:--:|
| #6007/#2096/#520 — `as` type assertion in directive value _(both miss)_ | · | · |
| #3400 — `instanceof` in {{ }} | ✓ | ✓ |
| #5370 — `typeof x !==` in v-if | ✓ | ✓ |
| #5118 — `?.` / `??` in {{ }} | ✓ | ✓ |
| #1675 — arrow `=>` in {{ }} | ✓ | ✓ |
| #6039/#4741 — `<` operator in {{ }} (not a tag!) | ✓ | ✓ |
| #5722 — negated ternary + quotes in {{ }} | ✓ | ✓ |
| #5538/#2060 — trailing `export type` before </script> | ✓ | ✓ |
| #3999 — multi-line <script> start-tag attributes | ✓ | ✓ |
| #4769 — tag name starting with `template` | ✓ | ✓ |
| #5701 — `{{` inside a <script> string | ✓ | ✓ |
| #6070 — capitalized component then a <style> block | ✓ | ✓ |
<!-- issues:end -->

<sub>A sampled ledger of real tracker issues, not an exhaustive audit. Run `npm run bench:issues` to regenerate (needs the official grammars: VS Code's installed TS/JS/HTML, and the Vue fixtures — see [`test/vue-bench.ts`](test/vue-bench.ts)). Sources: [`test/issue-cases.ts`](test/issue-cases.ts), [`test/html-issue-cases.ts`](test/html-issue-cases.ts), [`test/vue-issue-cases.ts`](test/vue-issue-cases.ts).</sub>

## What you get

From one grammar definition (a small TypeScript combinator API), five outputs are **fully functional**:

- **A lexer** — tokenizes source straight from the grammar's token definitions; usable on its own (`createLexer(grammar).tokenize`).
- **A CST parser** — recursive descent + Pratt precedence on top of the lexer, producing a **CST** (concrete syntax tree): every token is a node, including punctuation and keywords — roughly 2× an AST's nodes, by design, which is exactly what the highlighter and lossless source reconstruction need.
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

This isn't hypothetical: **JavaScript is a second language on the same engine.** Since TypeScript = JavaScript + a type layer, [`javascript.ts`](javascript.ts) is the standalone ECMAScript base that owns the shared vocabulary (tokens, operator precedence, base scopes, reserved-word guards), and [`typescript.ts`](typescript.ts) *imports* it and adds the type layer — the dependency runs subset → superset only. JavaScript parses real-world JS ([`test/js-conformance.ts`](test/js-conformance.ts): 61/61 valid snippets accepted, TS-only syntax rejected, ground truth `tsc` in JS mode) and its derived highlighter is graded by the *same* neutral oracle ([`test/js-highlight-bench.ts`](test/js-highlight-bench.ts): **92.6%** token-family accuracy, ahead of the official JavaScript TextMate grammar's 90.7%). It doesn't yet have TypeScript's full conformance-corpus depth, but it proves the claim — a second language is *one grammar file on an unchanged engine*.

A **dialect** is cheaper still. [`typescriptreact.ts`](typescriptreact.ts) (`.tsx`) and [`javascriptreact.ts`](javascriptreact.ts) (`.jsx`) are *three lines each*: they take the proven TypeScript / JavaScript grammar and apply one shared JSX layer ([`jsx.ts`](jsx.ts)) — which prepends a `JSXElement` expression and drops the `<T>` cast — reusing the base's rules **verbatim, by name**, without re-declaring them. Same engine, same conformance discipline ([`test/tsx-conformance.ts`](test/tsx-conformance.ts), [`test/jsx-conformance.ts`](test/jsx-conformance.ts)), scope names matching VS Code's official `source.tsx` / `source.js.jsx`. (Vue, [above](#proofs-beyond-typescript-html-and-vue), is the same move for a markup base.)

A new language is **one grammar file, proven the way TypeScript is** — by its own parser conformance, not by eyeballing colors:

1. **Write the grammar** with the combinator API ([`src/api.ts`](src/api.ts)). All language-specifics live here; the engine stays untouched.
2. **Prove it as a parser** against the language's *own* official test suite, measured **bidirectionally** (accept what the reference accepts, reject what it rejects). A grammar is "ready" when valid-code coverage is 100% and bidirectional agreement is high — that run is the correctness proof.
3. **Bring the reference highlighter as the baseline.** Drop in the language's existing official TextMate grammar so coverage is *measured against the thing you're replacing*, not asserted.

The highlighter, lexer, and CST types fall out of step 1 automatically (the tree-sitter / Monarch generators give you a scaffold to finish); steps 2–3 are how the result earns trust. A new-language PR is reviewed on exactly two numbers: **parser conformance** and **highlighter coverage vs the official grammar**.

> The conformance and highlighter *harnesses* are currently TypeScript-specific — they call `tsc`'s `parseDiagnostics` and read VS Code's bundled TS grammar. A contributor adapts those harness scripts to their reference compiler's diagnostic API; the engine and generators themselves are reused unchanged.

## Embedded languages

Editors highlight embedded snippets (CSS in a template, JSDoc in a comment) by handing the region to another grammar at the boundary — flaky in VS Code, because the host and embedded grammars are written independently and nothing checks they agree on the seam. (HTML's `<script>` and Vue's blocks, [above](#proofs-beyond-typescript-html-and-vue), already exercise this by embedding Monogram's own grammars.)

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
node test/issue-table.ts --write                   # regenerate the cross-language issue ledger above
node test/scope-coverage.ts                        # drop-in COMPATIBILITY gaps vs official (scope fidelity, missing regex/JSDoc sub-grammars, TSX) — what correctness doesn't measure
```

> `test/run-conformance.ts` reports a *raw accept-rate* (94.2% over all 3776 files, multi-file cases included) — an acceptance-only sanity check, not the bidirectional proof. `conformance-matrix.ts` is the number this README quotes.

## Known differences from the official highlighter

A handful of token patterns are scoped differently from VS Code's official TypeScript grammar — all intentional, and in some Monogram is arguably *more* correct (these are *deliberate divergences*, distinct from the bug-class fixes the [ledger](#on-every-languages-own-bug-ledger) measures):

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

Every target is produced by the *same* structural scope-inference, retargeted per format — lexer, parser, and generators are generic runtimes; all language specifics live in the grammar.

## Prior art

| Tool | Parser | Highlighting | Single source |
|------|:---:|:---:|:---:|
| TextMate grammars | — | manual regex | — |
| tree-sitter | yes | queries (written separately) | — |
| ANTLR | yes | — | — |
| Langium | yes | Monarch (separate config) | — |
| ungrammar | AST types | — | — |
| **Monogram** | **CST, conformance-proven** | **derived from the parser grammar** | **yes** |

Every tool here has a real parser; none *derives the highlighter from the parser's own grammar as a single source* — the one thing Monogram is for.
