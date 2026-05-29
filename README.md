# Monogram

Define a language's grammar **once**. Monogram validates that grammar by running it as a real parser against the language's official conformance suite — then derives a **TextMate syntax highlighter** from the same, proven grammar. The highlighter's correctness flows down from a parser-verified model instead of up from regex guesswork.

> *mono + grammar: one grammar, many derived artifacts.*

## The idea

A TextMate grammar is a pile of regexes guessing at a language's structure. It's written by hand, independently of any parser, and it's perpetually wrong at the edges — VS Code's official TypeScript grammar carries [100+ open issues](https://github.com/microsoft/TypeScript-TmLanguage/issues) for exactly this reason. Everyone who tries to fix it is competing on the same losing axis: *who can hand-write better regexes.*

Monogram inverts the dependency:

1. **Write the grammar, then prove it.** The grammar is executable. Monogram runs it as a recursive-descent + Pratt parser over the TypeScript conformance suite and measures conformance *bidirectionally* — it must accept what `tsc` accepts **and** reject what `tsc` rejects. Today it parses **100% of valid single-file cases** (3376 / 3376 — zero valid-code gaps) and agrees with `tsc` **bidirectionally on 96.7%** (3544 / 3664); the remaining gap is *over-acceptance* (the grammar is still too permissive on some invalid inputs), and the goal is 100% both ways — a *verified, complete model* of the language's syntax, not an approximation.

2. **Derive the highlighter from the proven grammar.** The TextMate grammar is generated from that same parser-validated grammar — never hand-written. Its correctness is underwritten by the parser conformance run, not by regex tuning.

That's the whole point, and it's a categorical advantage, not an incremental one: a highlighter derived from a parser-complete grammar isn't *a better hand-written grammar* — it's playing a different game. You cannot out-regex it, because its correctness comes from a dimension hand-written grammars never operate in. Push the grammar to 100% parser coverage and the highlighter comes along for free, correct by construction.

## What you get

From one grammar definition (a small TypeScript combinator API):

- **A lexer** — tokenizes source straight from the grammar's token definitions; usable on its own (`createLexer(grammar).tokenize`).
- **A CST parser** — recursive descent + Pratt operator precedence on top of the lexer, producing a full-fidelity concrete syntax tree where every token is a node.
- **A TextMate grammar** — a `.tmLanguage.json` for editor syntax highlighting, derived from the same rules.
- **A VS Code language configuration** — a `language-configuration.json` (comments, bracket pairs, auto-closing/surrounding pairs, folding, indentation) for editor behavior.

And — from the same grammar — first-pass generators for the rest of the editor ecosystem (validated structurally; some parts are scaffolds):

- **tree-sitter** — `grammar.js` + `queries/highlights.scm` + an external-scanner scaffold (Neovim / Helix / Zed / GitHub).
- **Lezer** — a CodeMirror 6 grammar + `styleTags` + a JS external tokenizer.
- **Monarch** — a Monaco (web) tokenizer.
- **CST node types** — TypeScript types (a discriminated union keyed by rule) for typed tree consumers.

## Results

Validated on TypeScript (grammar: [`examples/typescript.ts`](examples/typescript.ts), 537 lines):

```
Valid-code coverage  100%    3376 / 3376 valid single-file conformance cases parse   (zero gaps)
Bidirectional        96.7%   3544 / 3664 — also rejects what tsc rejects   (goal: 100%, gap = over-acceptance)
Highlighter          99.3%   589 / 593 tokens match VS Code's official grammar
Generated grammar    42 KB   vs the official hand-written 226 KB
Engine               language-agnostic — no TypeScript-specific code
```

The parser number is the one that matters: it's the grammar's correctness proof. Most remaining failures are intentional *error* tests that the TypeScript compiler also rejects. The highlighter accuracy is what that proof buys you — and the four remaining differences are deliberate (see [Known differences](#known-differences-from-the-official-highlighter)).

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

The parser uses these rules to build a CST. The highlighter reads the same rule **shapes** and infers scopes — with no manual scope assignment:

- `foo(x)` → `foo` is `entity.name.function` (from the `$ '(' …` call form)
- `obj.name` → `name` is `entity.other.property` (from the `$ '.' Ident` form)
- `'class' Ident` → `Ident` is `entity.name.type` (from declaration structure)
- `':' Type` → enter type-annotation highlighting (from the `type` rule flag)
- `Expr '<' Type '>' '('` → a generic call, not a comparison (from rule structure)

## A language-agnostic engine

Nothing in the engine knows about TypeScript. Everything language-specific lives in the grammar — keywords, which token is the identifier, template-literal delimiters, and the regex-vs-division lexer ambiguity are all *declared per token*:

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

## Embedded languages, without the broken seams

Editors highlight embedded snippets — CSS in a template string, a regex literal, SQL in a query, JSDoc in a comment — by handing the region to another language's grammar at the boundary. In VS Code that only works if the host grammar and the embedded grammar, written independently by different plugin authors, *both* implement the boundary correctly. Nothing checks that the two halves agree, so embedded highlighting is flaky exactly at the seams.

Monogram declares embedding points in the grammar itself (a token's `embed` annotation). When the languages on both sides are Monogram grammars, one system owns the whole boundary: it can generate the host and the embedded grammar together and exercise the seam in a single integrated self-test, so the boundary is *verified* rather than left to two strangers happening to agree. The cross-language robustness problem dissolves for the same reason the highlighter does — one source of truth, checked end to end.

## Usage

Requires Node 24+ (runs `.ts` directly — no build step, no `tsx`).

```bash
npm install

# generate the TextMate grammar from the grammar definition
node src/cli.ts examples/typescript.ts        # → examples/typescript.tmLanguage.json
```

Parse some source into a CST:

```ts
import { createParser } from './src/gen-parser.ts';
import grammar from './examples/typescript.ts';

const { parse } = createParser(grammar);
const cst = parse('const x = f(a, b)');        // → concrete syntax tree
```

Tests:

```bash
node test/sanity-check.ts        # quick smoke test
node test/run-conformance.ts     # parser vs the TypeScript conformance suite — the correctness proof
node test/coverage.ts            # highlighter vs VS Code's official grammar
node test/agnostic.ts            # proves the engine is language-agnostic
```

## Known differences from the official highlighter

On the comparison sample, **4 tokens** are scoped differently from VS Code's official TypeScript grammar. All are intentional — in some, Monogram is arguably *more* correct:

| Token | Monogram | Official | Why we keep ours |
|---|---|---|---|
| `console` in `console.log` | `support.variable` | `variable.other.object` | We highlight built-in globals (`console`, `window`, …) distinctly — a deliberate, common choice. |
| `transform` (a function parameter) | `variable.parameter` | `entity.name.function` | It **is** a parameter. Official's heuristic mis-reads `name: (…) => T` as a function definition; we're more correct. |
| `error` (the method in `console.error(…)`) | `entity.name.function` | `variable.other` | We scope a called method as a function name — arguably more informative. |

> Built-in class names in **type** position (e.g. `Error` in `extends Error`) now correctly emit `entity.name.type`, matching official; in **value** position (`new Error()`) they remain `support.class`, also matching official.

Matching the official grammar *exactly* would, in cases like `transform`, make the output worse. The metric counts these as differences, not defects.

## Architecture

```
examples/typescript.ts                one grammar (TypeScript combinator API)
        │
        ├─ src/gen-lexer.ts  ───────▶ lexer → tokens        (standalone: createLexer)
        │        ▲ composed by
        ├─ src/gen-parser.ts ───────▶ CST parser   (recursive descent + Pratt + packrat memo;
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

Every highlighter target (TextMate, tree-sitter queries, Lezer styleTags, Monarch) is produced by the *same* structural scope-inference (`gen-tm`), retargeted per format — so highlighting stays consistent across ecosystems.

- **One grammar, many derived artifacts.** `gen-lexer` builds a tokenizer from the token definitions + lexer hints; `gen-parser` composes that lexer and interprets the rules to build a CST; `gen-tm` reads the same rule *shapes* to derive TextMate patterns; `gen-vscode-config` derives the editor config (comments, brackets, auto-close) from the same tokens and `scopes`. Shared structural primitives (`grammar-utils.ts`) — e.g. one keyword/punctuation predicate — keep them consistent.
- **CST, not AST.** The parser keeps every token (punctuation, keywords) as a node — required for the highlighter and for lossless source reconstruction. Roughly 2× the nodes of an AST, by design.
- **Every stage is language-agnostic.** All language specifics live in the grammar; lexer, parser and generator are generic, reusable runtimes.

## Prior art

| Tool | Parser | Highlighting | Single source |
|------|:---:|:---:|:---:|
| TextMate grammars | — | manual regex | — |
| tree-sitter | yes | queries (separate) | — |
| ANTLR | yes | — | — |
| Langium | yes | Monarch (separate) | — |
| ungrammar | AST types | — | — |
| **Monogram** | **CST (100% valid / 96.7% bidir)** | **auto-derived (99.3%)** | **yes** |
