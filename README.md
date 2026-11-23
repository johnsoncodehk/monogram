# Monogram

Monogram takes one grammar file, written in TypeScript with a small combinator API, and
derives from it a parser that is checked against the language's reference parser, the
syntax highlighters (TextMate, tree-sitter, Monarch), and self-contained parsers in
TypeScript, Go and Rust.

> *mono + grammar: one grammar definition, many derived artifacts.*

The aim: write one grammar, get a proven parser in each target language in the same class as
the best hand-written parser for that language, plus highlighters. What is demonstrated today
is the TypeScript / JavaScript family: there the Rust target is near a leading hand-written
parser, oxc, which builds an AST where Monogram builds a CST ([Speed](#speed)). The other
targets and languages have not been compared with a hand-written parser yet.

A hand-written highlighter guesses at structure with regexes: in `typeof x < y` it must guess
whether `<` opens a type-argument list or compares. A parser does not guess. Monogram runs the
grammar as a parser first, measures it against the language's own parser, and only then
derives the highlighters from the same definition.

Grammars in this repository, all on one engine that knows no language:

| Grammar | File | Checked against |
|---|---|---|
| TypeScript | [`typescript.ts`](typescript.ts) | `tsc`'s parser and AST |
| JavaScript | [`javascript.ts`](javascript.ts) (TypeScript builds on it) | the ECMAScript productions; `tsc`'s JS-mode parser as a measure |
| JSX / TSX | [`javascriptreact.ts`](javascriptreact.ts), [`typescriptreact.ts`](typescriptreact.ts) | `tsc` |
| HTML | [`html.ts`](html.ts) | [`parse5`](https://github.com/inikulin/parse5), tree for tree |
| YAML | [`yaml.ts`](yaml.ts) (indentation-sensitive) | the [`yaml`](https://github.com/eemeli/yaml) parser over [yaml-test-suite](https://github.com/yaml/yaml-test-suite); highlighter against [RedCMD/YAML-Syntax-Highlighter](https://github.com/RedCMD/YAML-Syntax-Highlighter) |

## Used by

Projects shipping Monogram-derived grammars:

- [**vuejs/language-tools**](https://github.com/vuejs/language-tools) — the Vue TextMate grammars + VS Code language configuration ([vuejs/language-tools#6085](https://github.com/vuejs/language-tools/pull/6085)).

Using Monogram in your project? Open a PR to add it here.

## Quick start

Requires Node 24+, which runs `.ts` directly (no build step).

```bash
npm install
```

A complete grammar, saved as `mini.ts` at the repository root:

```ts
import {
  token, rule, defineGrammar, left, op, sep,
  seq, oneOf, range, plus, star, optPattern,
} from './src/api.ts';

const digit = range('0', '9');
const Ident = token(seq(
  oneOf(range('a', 'z'), range('A', 'Z'), '_', '$'),
  star(oneOf(range('a', 'z'), range('A', 'Z'), digit, '_', '$')),
), { identifier: true });
const Number = token(seq(plus(digit), optPattern(seq('.', plus(digit)))));
const Space = token(plus(oneOf(' ', '\t', '\n')), { skip: true });

const Expr = rule($ => [
  Ident,
  Number,
  [$, op, $],                    // binary operators, precedence below
  [$, '(', sep(Expr, ','), ')'], // call: f(a, b)
  [$, '.', Ident],               // member: obj.name
]);

export default defineGrammar({
  name: 'mini',
  tokens: { Ident, Number, Space },
  prec: [left('+', '-'), left('*', '/')],
  rules: { Expr },
  entry: Expr,
});
```

The highlighters and editor files:

```bash
node src/cli.ts mini.ts
# → mini.tmLanguage.json, mini.language-configuration.json, mini.monarch.json,
#   tree-sitter/mini/{grammar.js, queries/highlights.scm, src/scanner.c, package.json},
#   mini.cst-match.ts
```

The parsers (`npm run gen` regenerates the committed artifacts of every grammar the same way):

```ts
import { writeFileSync } from 'node:fs';
import { createParser } from './src/gen-parser.ts';
import { emitParser, tsTarget, goTarget, rustTarget } from './src/emit.ts';
import grammar from './mini.ts';

const { parse } = createParser(grammar);        // the interpreter: the reference parser
const cst = parse('f(a, b.c) + 1 * 2');          // a CST; throws on a syntax error

writeFileSync('parser.ts', emitParser(grammar, tsTarget));    // one self-contained file each,
writeFileSync('parser.go', emitParser(grammar, goTarget));    // with its own lexer, no imports
writeFileSync('parser.rs', emitParser(grammar, rustTarget));  // of monogram
```

## What you get

| Output | How | Status |
|---|---|---|
| Interpreter parser (CST) | `createParser(grammar)`, [`src/gen-parser.ts`](src/gen-parser.ts) | The reference. Every other parser is gated against it. All six grammars. |
| Portable parsers: TypeScript, Go, Rust | `emitParser(grammar, tsTarget \| goTarget \| rustTarget)` | Checked against the interpreter (accept/reject, and the rule tree when both accept) on every CI run, gate `portable-targets`: per grammar the parity corpus (generated inputs, their one-token mutants and the hand-written lists: about 11,300 inputs for TypeScript and JavaScript), a seeded mutation corpus, and every file of two external corpora: the tsc conformance corpus (5,695 files, TypeScript and JavaScript grammars) and test262 (24,677 tests, JavaScript grammar). Known disagreements, each owed and listed in [test/portable-wide-record.txt](test/portable-wide-record.txt): 7 tsc conformance files the portable parsers reject (`T extends infer U extends string ? U : never`, `b ? (c) : d => e`: the interpreter's mixfix operand re-bind), and 505 test262 files from two lexer differences (a private name with a non-ASCII character, `#℘`; a `#!` after the start of the text). Token-stream and newline grammars, and grammars with element regions: TSX, JSX and code-children dialects. Refused, never mis-lexed: indent (YAML) and markup (HTML) grammars, and the region features the portable lexers do not carry yet ([TARGETS](docs/TARGETS.md#what-each-target-accepts)). |
| Emitted JavaScript parser | `emitParser(grammar, jsTarget)` | All six grammars. To be retired once the portable TS target covers it ([ROADMAP](docs/ROADMAP.md)). |
| Incremental `Doc` | TS `createDoc`, Go `NewDoc`, Rust `Doc`; `jsTarget`'s `createParser().edit` | Every edited re-parse equals a fresh parse, gated. |
| Total parsing with diagnostics | `jsTarget`'s `createParser()`: a tree plus `errors` for every text | `jsTarget` only. The portable parsers reject without recovery. |
| TextMate grammar + VS Code language configuration | `node src/cli.ts` | All six grammars; compared with the official grammars below. |
| tree-sitter grammar + highlight queries | `node src/cli.ts` | Builds to wasm in CI; TypeScript query accuracy gated. |
| Monarch tokenizer (Monaco) | `node src/cli.ts` | Functional, bounded by JavaScript regex limits. |
| Shape-mapped AST | `emitTs(grammar, { shape })`, `emitRust(grammar, { shape })` | TypeScript and Rust. Go not yet. |

**Changed interface (Rust):** the emitted Rust parser's `tokenize(src)` returns
`Result<Vec<Token>, LexError>` since `f5a1c3e`; before, it returned `Vec<Token>` and panicked on
input it cannot tokenize. `parse_with`, `parse` and `Doc::new` still panic. The TS and Go
surfaces are unchanged ([docs/TARGETS.md](docs/TARGETS.md#errors-and-tokens)).

The CST holds every token, punctuation and keywords included, which is what highlighting and
lossless source reconstruction need. Per-target API, error mechanisms and the builder-reuse
cost model: [docs/TARGETS.md](docs/TARGETS.md). Total parsing: [docs/TOTAL-PARSING.md](docs/TOTAL-PARSING.md).

## Evidence

### Conformance

- **TypeScript**: the CST lowered to `tsc`'s AST equals it node by node (kind, start, end)
  on the gate's battery (`conformance/ts-ast-structure`, [`test/ts-ast-verify.ts`](test/ts-ast-verify.ts)).
- **JavaScript**: against `tsc`'s JS-mode parser on every single-file case of the pinned
  TypeScript conformance corpus, 4428 of 4462 files agree; the record lists every other file
  ([docs/JS-CONFORMANCE.md](docs/JS-CONFORMANCE.md), gate `conformance/js-corpus`).
- **JavaScript against test262**: JavaScript is checked against test262, the language's conformance
  suite (24,677 syntax tests, gate `conformance/test262`, [docs/TEST262.md](docs/TEST262.md)). 98.7%
  of the 20,200 valid tests parse. 30.2% of the 4,477 invalid ones are rejected; the rest are early
  errors for a checker over the tree, not built yet (1,940), rules that need the script / module goal
  or strict mode (436), and grammar bugs being fixed (747). The TypeScript grammar parses 99.9% of
  the valid tests; the 10 it rejects, tsc rejects too.
- **Where Monogram departs from `tsc` on purpose**, following the ECMAScript productions:
  [docs/CORRECTNESS.md](docs/CORRECTNESS.md).

The parser column for TypeScript, JavaScript, JSX and TSX is alignment with `tsc`'s parser, not conformance (JavaScript's conformance is test262: [docs/TEST262.md](docs/TEST262.md)).

Against each official parser and highlighter over pinned corpora (generated by the
`readme-bench` workflow; how to read the columns: [docs/HIGHLIGHTER-EVIDENCE.md](docs/HIGHLIGHTER-EVIDENCE.md#reading-the-coverage-table)):

<!-- coverage:start -->
| Grammar | Parser — agree · covered | Highlighter — Monogram vs official |
|---|---|---|
| TypeScript | 99.1% · 76.4% | 99.0% vs 99.3% |
| JavaScript | 95.3% · 64.2% | 99.1% vs 81.9% |
| JSX | 100.0% · 52.5% | 94.3% vs 94.3% |
| TSX | 97.5% · 65.7% | 95.6% vs 95.4% |
| HTML | 95.3% · 49.3% | 100.0% vs 98.8% |
| YAML | 100.0% · 73.9% | 100.0% vs 99.5% |
<!-- coverage:end -->

### Highlighters

On the bugs filed against each hand-written official grammar:

<!-- issues:start -->
<!-- generated by `npm run bench:issues` — do not edit by hand -->
_Each hand-written **official** grammar vs Monogram's **derived** one, on the bugs filed against it: **TypeScript 26/26** (official 8/26) · **TSX 11/11** (official 5/11) · **HTML 20/20** (official 13/20) · **YAML 8/8** (official 8/8). Per-issue detail in `docs/HIGHLIGHTER-EVIDENCE.md`, auto-generated by `npm run bench:issues`._
<!-- issues:end -->

The derived tree-sitter queries score 96.3% token-family accuracy against a `tsc` oracle,
the official tree-sitter grammar 92.5% (gate `gate:treesitter`, CI on `3a18a69`). The ledger
per issue, the deliberate differences from the official grammar, and what TextMate provably
cannot express: [docs/HIGHLIGHTER-EVIDENCE.md](docs/HIGHLIGHTER-EVIDENCE.md).

### Speed

- The recorded comparison is Rust against [oxc](https://github.com/oxc-project/oxc) on the
  same inputs, parsing as TypeScript, both in one CI job with alternating rounds
  ([docs/MEASUREMENT.md](docs/MEASUREMENT.md#recorded-result-rust-against-oxc)).
- Monogram builds a CST and oxc a typed AST: not the same product, and a CST is the cheaper one
  to build. A like-for-like figure waits for a monogram parser that builds an AST.
- On monogram `e6cc55c`, on two AMD EPYC runner models, a parse with a kept builder takes 6%
  to 28% less time than oxc's on the eight timed inputs (9% less on the TypeScript compiler's
  `checker.ts`) while executing 3% to 13% more instructions on seven of them. An earlier
  comparison on another CPU ordered one input the other way: the ratio is not a property of the
  parsers alone.
- Before the lexer and decision work of 2026-11-22 the same comparison had oxc ahead on most
  inputs, with monogram at 1.42 times oxc's instructions on `checker.ts`; it is 1.03 times now.
- Every pull request that touches the parser is measured against its merge base on every
  target: Rust and Go instruction counts (Callgrind), TypeScript and JavaScript block-execution
  counts, allocator calls and page faults. A change that moves one target only is listed as
  such ([docs/MEASUREMENT.md](docs/MEASUREMENT.md)).
- TSX and JSX through the portable parsers, on `d326d65` (AMD EPYC 7763): plain TypeScript
  parsed by the TSX parser costs 1.4% more Rust instructions per parse than by the TypeScript
  parser (Go +1.6% direct, -0.7% builder engine; TS +0.06% blocks); a token of tsc's JSX
  conformance code costs the Rust lexer 203.7 instructions against 142.3 on `checker.ts`
  ([docs/MEASUREMENT.md](docs/MEASUREMENT.md#recorded-result-element-dialects-tsx-and-jsx)).

### Allocations and sizes

- With a kept builder, a Go parse allocates nothing (0 allocations per parse in reuse mode,
  pinned for each input in [docs/ALLOCATIONS.md](docs/ALLOCATIONS.md), gate `alloc-work`);
  the same record pins the TS and JS targets.
- Emitted parser sizes (`node test/emit-sizes.ts` on `d326d65`, recorded by the profile run
  45129600578):

| grammar | TypeScript | Go | Rust | emitted JS (`jsTarget`) |
|---|--:|--:|--:|--:|
| `typescript.ts` | 279,033 B | 510,353 B | 371,413 B | 1,462,627 B |
| `javascript.ts` | 193,639 B | 331,230 B | 273,387 B | 869,603 B |
| `typescriptreact.ts` | 309,794 B | 545,370 B | 408,054 B | 1,516,020 B |
| `javascriptreact.ts` | 206,830 B | 350,928 B | 288,389 B | 921,558 B |

## Design

```
grammar (*.ts, src/api.ts)
   │
   ├─ analysis (src/grammar-analysis.ts) ─▶ interpreter: src/gen-parser.ts (the reference)
   │
   ├─ IR: parse plan + lexer plans (src/emit-portable.ts, src/lex-family.ts,
   │      src/lex-match-plan.ts, src/algo-ir.ts)
   │        └─▶ one engine, rendered per target: src/target-ts.ts, target-go.ts, target-rust.ts
   │
   ├─ emitted JS parser: src/emit-parser.ts + src/emit-lexer.ts   (to be retired)
   │
   └─ highlighters: src/gen-tm.ts (TextMate), src/gen-treesitter.ts, src/gen-monarch.ts,
                    src/gen-vscode-config.ts (language configuration)
```

The structure is that of compiler infrastructure. A grammar is a **front end**, one per source
language. Analysis and the IR are the **middle**, where optimisations live: done once, every
language and target benefits. A printer is a **back end**, one per target language, and should
only spell IR operations in its language. (The analogy is LLVM's N languages × M targets; its
limit is that these back ends emit source code, so the last optimisation step belongs to each
language's own compiler.)

Today the back ends are still thick: most of each printer's runtime is hand-written per
printer. Making them thin, so that adding a target means writing one renderer, is roadmap
item 1.

**Grammar and AST shape are separate.** The grammar describes syntax and knows no AST. A
consumer supplies a `ShapeSpec` that maps the CST to its AST ([docs/SHAPE.md](docs/SHAPE.md)).
Today a shape spec binds partly by position and arm index (`{ at: n }`, `altIndices`); stable
names in the grammar API are planned, so a grammar change cannot move an AST.

**Correctness policy.** JavaScript syntax follows the ECMAScript productions. TypeScript-only
syntax follows what `tsc`'s parser accepts. Static semantics (early errors, valid assignment
targets, checker rules) are a consumer's job, not the parser's ([docs/CORRECTNESS.md](docs/CORRECTNESS.md)).

**The engine knows no language.** Keywords, the identifier token, template delimiters and the
regex-versus-division decision are declared on the grammar's tokens. [`test/agnostic.ts`](test/agnostic.ts)
runs a grammar with none of them; [`html.ts`](html.ts) is markup on the same engine.

## Adding a language

1. **Write the grammar** with [`src/api.ts`](src/api.ts): tokens, precedence, rules. Rules
   choose by longest match; only the entry rule may match the empty string. The full rules:
   [docs/GRAMMAR.md](docs/GRAMMAR.md). `node src/cli.ts <grammar.ts> --decisions` also writes
   `<name>.decisions.md`: how the generated parser decides each choice point, and the dead
   alternatives and declaration-order ties to fix, each with its action (example:
   [test/fixtures/decisionsjs.decisions.md](test/fixtures/decisionsjs.decisions.md)).
2. **Check it as a parser** against the language's own test suite, in both directions: accept
   what the reference accepts, reject what it rejects.
3. **Compare the highlighter** with the official TextMate grammar as the baseline.

The lexer, the CST types and the highlighters come from step 1; a dialect reuses a base
grammar's rules by name. The conformance and highlighter harnesses are written for the
languages here (they call `tsc`, parse5 and VS Code's grammars); point them at your own
reference parser. The test taxonomy (gates, metrics, ledger, benches): [docs/TESTING.md](docs/TESTING.md).

### A dialect with elements

A language with JSX-like elements declares them once on the grammar, as an `elements` region:
the tag delimiters (`tagOpen`, `tagClose`, `closeMarker`), the `closeTag` and `selfClose`
tokens and the `hole` braces, and as needed

| field | what it declares |
|---|---|
| `text` | children are text; leave it out and children are code |
| `tagTokens` | tokens lexed only inside a tag (attribute strings) |
| `rawText` | tags such as `<style>` / `<script>` whose body is one raw token, with `ignoreCase`, `unlessBodyStarts` and an `embed` scope such as `source.css` |
| `tagStart` | which characters after the tag opener open a tag; otherwise it is text |
| `textTokens` | tokens tried before a text run (comments in text), with an `after` class |
| `highlight` | highlighter data: tag-name scopes, patterns inside text, a children scope |

Directives in children (`@if (…) { … } @else { … }`) and dynamic tags (`<{expr}>`) need no
declaration: they are derived from the rules. How code enters an element is derived too, from
whether the tag opener is also an operator in the grammar.

From that one file the lexer tokenizes elements, and the generated TextMate grammar highlights
tags, attributes, holes, code or text children, raw bodies in their embedded language, comments
in text, directives and dynamic tags. JSX and TSX are declared this way
([`javascriptreact.ts`](javascriptreact.ts)); two fixtures exercise the rest
([`test/fixtures/elementdialect.ts`](test/fixtures/elementdialect.ts),
[`test/fixtures/textdialect.ts`](test/fixtures/textdialect.ts)). The model, what a lexer-local
region cannot decide, and the generators' limits with a witness each:
[docs/REGIONS.md](docs/REGIONS.md).

The generated Monarch grammar (Monaco) highlights tags, attributes, holes, text or code children,
dynamic tags, raw bodies in their embedded language, comments in text and directives from the
same declaration.

Not there yet: the tree-sitter generator still carries
its own JSX vocabulary and reads none of the other region features; the portable parsers (TypeScript, Go, Rust) parse JSX and TSX but refuse a
grammar that has directives (they carry `tagStart`, `unlessBodyStarts` and `textTokens`).

**Changed behaviour:** a grammar that declares no region gets no element layer. Elements are no
longer guessed from a `/>` token or a rule that starts with `<`.

## Where this is going

[docs/ROADMAP.md](docs/ROADMAP.md), in order: one portable engine and shared runtime for all
targets (and retiring the emitted JS parser); editor artifacts derived from grammar data, with
lexer regions a grammar can declare; a second language family compared against its fastest
hand-written parser; decisions made at generation time instead of attempts at parse time, with
the specification's parameterised productions and cover grammars; grammar plus shape spec as
the output contract; test262 as JavaScript's oracle; and every target measured on every pull
request.

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
