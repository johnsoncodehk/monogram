# Monogram

Write a language's grammar **once**, as an executable definition. Monogram runs it as a real parser, proves it against the language's official conformance suite, then **derives the syntax highlighters** — TextMate, tree-sitter, Monarch — from that same proven grammar. Highlighting correctness flows *down* from a parser-verified model instead of *up* from hand-tuned regex.

> *mono + grammar — one grammar definition, many derived artifacts.*

**Status** — an active research project; four languages on one shared, [language-agnostic](#a-language-agnostic-engine) engine, each [proven as a parser](#the-idea) before its highlighter is trusted:

- **TypeScript** ([`typescript.ts`](typescript.ts)) — mature: 100% valid-code coverage, 97.8% bidirectional vs `tsc`.
- **JavaScript** ([`javascript.ts`](javascript.ts)) — the standalone ECMAScript base TypeScript [builds on](#adding-a-language) (subset → superset); parses real-world JS, with less conformance-corpus depth than TS so far.
- **HTML** ([`html.ts`](html.ts)) — the engine reaching *past token streams into markup*; ~95 lines, validated against [`parse5`](https://github.com/inikulin/parse5).
- **YAML** ([`yaml.ts`](yaml.ts)) — indentation-sensitive markup on the shared engine; validated against the maintained [RedCMD/YAML-Syntax-Highlighter](https://github.com/RedCMD/YAML-Syntax-Highlighter).

## Used by

Projects shipping Monogram-derived grammars:

- [**vuejs/language-tools**](https://github.com/vuejs/language-tools) — the Vue TextMate grammars + VS Code language configuration ([vuejs/language-tools#6085](https://github.com/vuejs/language-tools/pull/6085)).

Using Monogram in your project? Open a PR to add it here.

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

1. **Write the grammar, then prove it.** The grammar is executable — Monogram runs it as a recursive-descent + [Pratt](https://en.wikipedia.org/wiki/Operator-precedence_parser) (operator-precedence) parser over the TypeScript conformance suite, measured *bidirectionally*: it **accepts** what `tsc` accepts and **rejects** what `tsc` rejects — with `tsc` the [oracle, not the definition](#correctness-the-productions-not-tsc), the two diverging only where `tsc` itself does.

2. **Derive the highlighters from that proven grammar**, never hand-write them. The TextMate, tree-sitter, and Monarch outputs are all generated from the one parser-validated definition, so their correctness is underwritten by the conformance run, not by regex tuning.

That single source reaches across grammars, too: an embedded snippet runs *another Monogram grammar* — a `<script>` body is highlighted by Monogram's own JavaScript, so `<script>const x = 1 < 2</script>` colours `<` as a JS operator, the same ambiguity resolved *inside* the embed. Where VS Code's embeds fray — two independently-written grammars meeting with nothing checking the seam — Monogram owns both sides, so self-verifying that seam becomes possible (a design goal beyond today's standard `contentName` injection).

## How it measures up

Two numbers answer two different questions — read them together, not against each other:

- **Broad agreement** (the table just below) — over a whole corpus, does the derived grammar match the official **parser**'s accept/reject and the official **highlighter**'s token roles? This is dominated by the easy bulk of unambiguous tokens: the floor every grammar clears, not the interesting part.
- **The filed bugs** (the ledger under it) — on the exact cases reported against the hand-written official grammar, does the *derived* one fix them? This strips the easy bulk away and shows only the ambiguous frontier — generic-`<`-vs-less-than, regex-vs-division, whitespace-fragile multiline generics — where a parser-derived grammar pulls away from hand-tuned regex.

So the two aren't in tension: a near-tie in the broad table can sit right next to a lopsided ledger — the broad average dilutes the difference with easy tokens, while the ledger zooms in on the hard cases it buries.

### Correctness: the productions, not `tsc`

The conformance run measures Monogram against `tsc`, but `tsc` is the **oracle, not the definition**. What the grammar models is the language's **syntactic productions** — and the parser produces a [CST](#what-you-get), which is *pre-semantic*: whether an expression is a valid assignment target, or a `using` binding is an identifier rather than a pattern, is a **static-semantic** rule. That belongs to a CST *consumer* — the CST→AST lowering, or a validator that walks the tree — not to the parser. The parser's one job is to accept exactly the strings the productions derive.

This matters because `tsc`'s *parser* is not the same thing as the language. It draws its own parse-vs-check line, and on a handful of inputs it diverges from the grammar — and from the other engines (V8, Babel) — in **both** directions. Driving Monogram's accept/reject to *exactly* `tsc` would mean reproducing those quirks; instead it follows the productions:

| Input | Monogram | `tsc` parser | V8 / Babel | Why |
|---|---|:--:|:--:|---|
| `obj?.#field` | accept | reject | accept | A private member in an optional chain is valid current ECMAScript — V8 and Babel both accept it; `tsc`'s parser is the lone rejecter. |
| `let v: void.x` | reject | accept | reject | A qualified type name's root is an `IdentifierReference`; `void` is a keyword type, so no production qualifies it. (`undefined.x` *is* valid — `undefined` is identifier-rooted.) |
| `using {a} = b` | reject | accept | reject | A `using` binding is a `BindingIdentifier` (`BindingList[~Pattern]`); the object pattern has no production. `using [a] = b` *is* valid — there `using` is an identifier and `[a]` is an element access. |
| `++ -x` | accept | reject | reject | `++ UnaryExpression` derives it; "operand must be a simple target" is a static-semantic early error, which the parser leaves to a consumer. |

`tsc` rejecting the first and accepting the next two (its parser doesn't enforce those productions until the checker) is exactly why "match `tsc`" can't *be* the definition of correct — only the measurement oracle.

### Broad agreement vs the official grammar

**Parser** (Monogram vs the official parser, [`test/src-coverage.ts`](test/src-coverage.ts)) — **agree** = the same accept/reject verdict on each corpus file (for HTML, full **parse-tree equality** via parse5); **covered** = how much of the official parser's own branches the corpus exercises, so read `agree` as "on the covered portion." (For the non-HTML grammars `agree` is accept/reject; their parse-*tree* correctness is exercised by the Highlighter axis, whose roles are read off the tree.) **Highlighter** (Monogram's derived TextMate grammar vs the official one, [`test/scope-gap.ts`](test/scope-gap.ts)) — both graded against the parser's per-token roles, the [vscode#203212](https://github.com/microsoft/vscode/issues/203212) comparison.

<!-- coverage:start -->
| Grammar | Parser — agree · covered | Highlighter — Monogram vs official |
|---|---|---|
| TypeScript | 99.5% · 76.4% | 99.0% vs 99.3% |
| JavaScript | 96.0% · 65.5% | 99.0% vs 83.6% |
| JSX | 97.1% · 52.5% | 94.3% vs 94.3% |
| TSX | 96.7% · 65.7% | 95.6% vs 95.4% |
| HTML | 95.3% · 49.3% | 100.0% vs 98.8% |
| YAML | 100.0% · 73.9% | 100.0% vs 99.5% |
<!-- coverage:end -->

Measured against the *maintained* official grammar where it matters, not a dead bundle: JS/TS use Microsoft's maintained [TypeScript-TmLanguage](https://github.com/microsoft/TypeScript-TmLanguage); YAML uses the maintained [RedCMD/YAML-Syntax-Highlighter](https://github.com/RedCMD/YAML-Syntax-Highlighter) that VS Code switched to ([microsoft/vscode#232244](https://github.com/microsoft/vscode/pull/232244)); only HTML's baseline is the unmaintained [textmate/html.tmbundle](https://github.com/textmate/html.tmbundle) — the #203212 case Monogram targets.

### Every bug filed against the official grammar

Take the bugs reported against each *hand-written* official grammar and ask whether the *derived* grammar solves them — and which **both** still get wrong (the shared frontier neither reaches today).

<!-- issues:start -->
<!-- generated by `npm run bench:issues` — do not edit by hand -->
_Each hand-written **official** grammar vs Monogram's **derived** one, on the bugs filed against it: **TypeScript 26/26** (official 8/26) · **TSX 11/11** (official 5/11) · **HTML 20/20** (official 13/20) · **YAML 8/8** (official 8/8). Per-issue detail below — auto-generated by `npm run bench:issues`._

#### TypeScript
| issue | Monogram | official |
|---|:--:|:--:|
| [#1050](https://github.com/microsoft/TypeScript-TmLanguage/issues/1050) — typeof y < string is a relational operator not generic (cascade victim intact) | ✓ | · |
| [#978](https://github.com/microsoft/TypeScript-TmLanguage/issues/978) — typeof x < string then function (cascade victim intact) | ✓ | · |
| [#859](https://github.com/microsoft/TypeScript-TmLanguage/issues/859) — as cast inside < > comparison | ✓ | · |
| [#1020](https://github.com/microsoft/TypeScript-TmLanguage/issues/1020) — new Map<number, number>; (no parens) | ✓ | · |
| [#855](https://github.com/microsoft/TypeScript-TmLanguage/issues/855) — new Map</* comment */string, IArgs>() | ✓ | · |
| [#853](https://github.com/microsoft/TypeScript-TmLanguage/issues/853) — throw /foo/ is regex | ✓ | · |
| [#804](https://github.com/microsoft/TypeScript-TmLanguage/issues/804) — /[a\-b]/g char class recognized | ✓ | · |
| [#869](https://github.com/microsoft/TypeScript-TmLanguage/issues/869) — x in obj ? x : fallback ternary works | ✓ | · |
| [#770](https://github.com/microsoft/TypeScript-TmLanguage/issues/770) — function call parens are punctuation | ✓ | · |
| [#1021](https://github.com/microsoft/TypeScript-TmLanguage/issues/1021) — regex with the v (unicode-sets) flag is recognized | ✓ | · |
| [#1025](https://github.com/microsoft/TypeScript-TmLanguage/issues/1025) — for-of without surrounding space keeps `of` a loop keyword | ✓ | · |
| [#815](https://github.com/microsoft/TypeScript-TmLanguage/issues/815) — a class method named `new` is a method name, not the operator | ✓ | · |
| [#992](https://github.com/microsoft/TypeScript-TmLanguage/issues/992) — casting to a type named `type` does not break highlighting | ✓ | · |
| [#994](https://github.com/microsoft/TypeScript-TmLanguage/issues/994) — JSDoc `@template [Output=Value]` default — Monogram colors the param name, official misses it | ✓ | · |
| [#891](https://github.com/microsoft/TypeScript-TmLanguage/issues/891) — `from` as an ordinary variable is not a keyword | ✓ | · |
| [#814](https://github.com/microsoft/TypeScript-TmLanguage/issues/814) — `a instanceof B & c` keeps the operand a value, not a type | ✓ | · |
| [#950](https://github.com/microsoft/TypeScript-TmLanguage/issues/950) — default import named `type` — the binding is a variable, not the `type` keyword | ✓ | · |
| [#1058](https://github.com/microsoft/TypeScript-TmLanguage/issues/1058) — `import defer` should scope `defer` as a keyword | ✓ | · |

<details><summary>… and 8 more both grammars already handle (✓ / ✓)</summary>

| issue | Monogram | official |
|---|:--:|:--:|
| [#1063](https://github.com/microsoft/TypeScript-TmLanguage/issues/1063) — /\cJ/ control char escape | ✓ | ✓ |
| [#736](https://github.com/microsoft/TypeScript-TmLanguage/issues/736) — obj.example() method gets entity.name.function | ✓ | ✓ |
| [#788](https://github.com/microsoft/TypeScript-TmLanguage/issues/788) — optional chaining ?. is the optional accessor | ✓ | ✓ |
| [#881](https://github.com/microsoft/TypeScript-TmLanguage/issues/881) — `override` modifier on a method is storage.modifier | ✓ | ✓ |
| [#1066](https://github.com/microsoft/TypeScript-TmLanguage/issues/1066) — triple-slash reference directive is a comment | ✓ | ✓ |
| [#1027](https://github.com/microsoft/TypeScript-TmLanguage/issues/1027) — nested generic `>>` closes two type-arg lists, not a shift | ✓ | ✓ |
| [#956](https://github.com/microsoft/TypeScript-TmLanguage/issues/956) — `as const satisfies Foo` colors the satisfies keyword and the type | ✓ | ✓ |
| [#907](https://github.com/microsoft/TypeScript-TmLanguage/issues/907) — `typeof x extends string ? 1 : 2` conditional-type ternary | ✓ | ✓ |

</details>

#### TSX
| issue | Monogram | official |
|---|:--:|:--:|
| [#967](https://github.com/microsoft/TypeScript-TmLanguage/issues/967) — generic arrow with a default type in `.tsx` | ✓ | · |
| [#979](https://github.com/microsoft/TypeScript-TmLanguage/issues/979) — `const` modifier on a type parameter in `.tsx` | ✓ | · |
| [#1042](https://github.com/microsoft/TypeScript-TmLanguage/issues/1042)/[#990](https://github.com/microsoft/TypeScript-TmLanguage/issues/990) — default generic arrow function in `.tsx` | ✓ | · |
| [#627](https://github.com/microsoft/TypeScript-TmLanguage/issues/627) — member-expression JSX tag name | ✓ | · |
| [#1033](https://github.com/microsoft/TypeScript-TmLanguage/issues/1033) — generic arrow with a default + destructured param in `.tsx` | ✓ | · |
| [#825](https://github.com/microsoft/TypeScript-TmLanguage/issues/825) — `<` and tag name on separate lines | ✓ | · |

<details><summary>… and 5 more both grammars already handle (✓ / ✓)</summary>

| issue | Monogram | official |
|---|:--:|:--:|
| [#794](https://github.com/microsoft/TypeScript-TmLanguage/issues/794) — non-null `!` then `/` (division) in a JSX-attribute object | ✓ | ✓ |
| [#585](https://github.com/microsoft/TypeScript-TmLanguage/issues/585) — `//` line comment inside a JSX open tag | ✓ | ✓ |
| [#754](https://github.com/microsoft/TypeScript-TmLanguage/issues/754) — JSX element right after a `/**/` block comment | ✓ | ✓ |
| [#667](https://github.com/microsoft/TypeScript-TmLanguage/issues/667) — arrow function + ternary inside a JSX attribute | ✓ | ✓ |
| [#624](https://github.com/microsoft/TypeScript-TmLanguage/issues/624) — JSX element in an array after a template-literal attribute | ✓ | ✓ |

</details>

#### HTML
| issue | Monogram | official |
|---|:--:|:--:|
| [tmbundle#118](https://github.com/textmate/html.tmbundle/issues/118) — trailing `/` in an unquoted URL value | ✓ | · |
| [tmbundle#108](https://github.com/textmate/html.tmbundle/issues/108) — nested `<svg>` is a valid tag, not flagged invalid | ✓ | · |
| [tmbundle#113](https://github.com/textmate/html.tmbundle/issues/113) — `//` in an `onclick=` JS string read as a comment | ✓ | · |
| [tmbundle#104](https://github.com/textmate/html.tmbundle/issues/104) — mixed-case `onChange=` event handler still reads as JS | ✓ | · |
| [tmbundle#88](https://github.com/textmate/html.tmbundle/issues/88) — inline `style=` value embeds CSS | ✓ | · |
| [tmbundle#65](https://github.com/textmate/html.tmbundle/issues/65) — `<` of `</script>` is HTML punctuation, not `source.js` | ✓ | · |
| [tmbundle#74](https://github.com/textmate/html.tmbundle/issues/74) — `<` of `</style>` is HTML punctuation, not `source.css` | ✓ | · |

<details><summary>… and 13 more both grammars already handle (✓ / ✓)</summary>

| issue | Monogram | official |
|---|:--:|:--:|
| [tmbundle#124](https://github.com/textmate/html.tmbundle/issues/124) — slash in unquoted value `foo/` | ✓ | ✓ |
| [vscode#140360](https://github.com/microsoft/vscode/issues/140360) — `/` inside an unquoted value (path) | ✓ | ✓ |
| [tmbundle#84](https://github.com/textmate/html.tmbundle/issues/84) — tag name a prefix of a sibling (`<i>`/`<input>`) | ✓ | ✓ |
| [tmbundle#117](https://github.com/textmate/html.tmbundle/issues/117) — SVG camelCase tag name | ✓ | ✓ |
| [tmbundle#122](https://github.com/textmate/html.tmbundle/issues/122) — `<` inside a quoted attr value | ✓ | ✓ |
| [vscode#130284](https://github.com/microsoft/vscode/issues/130284) — `>` inside a quoted attr value does not close the tag early | ✓ | ✓ |
| [tmbundle#97](https://github.com/textmate/html.tmbundle/issues/97) — whitespace (incl. a line feed) before `>` in a raw-text end tag | ✓ | ✓ |
| [tmbundle#81](https://github.com/textmate/html.tmbundle/issues/81) — character entity `&amp;` in text | ✓ | ✓ |
| [tmbundle#102](https://github.com/textmate/html.tmbundle/issues/102) — `<style>` element CSS is tokenized, not a flat blob | ✓ | ✓ |
| [tmbundle#50](https://github.com/textmate/html.tmbundle/issues/50) — `onclick=` event-handler value is colored as JS | ✓ | ✓ |
| [tmbundle#85](https://github.com/textmate/html.tmbundle/issues/85) — `//</script>` on its own line still closes the script | ✓ | ✓ |
| [tmbundle#51](https://github.com/textmate/html.tmbundle/issues/51) — self-closing `/` is tag punctuation | ✓ | ✓ |
| [tmbundle#82](https://github.com/textmate/html.tmbundle/issues/82) — a `/>`-style `<script src=… />` does NOT self-close — its body is the script content | ✓ | ✓ |

</details>

#### YAML
_No asymmetries — both grammars handle all 8 filed bugs below._

<details><summary>… and 8 more both grammars already handle (✓ / ✓)</summary>

| issue | Monogram | official |
|---|:--:|:--:|
| [vscode#170032](https://github.com/microsoft/vscode/issues/170032) — document markers `---` / `...` are document structure, not stray punctuation | ✓ | ✓ |
| [atom/language-yaml#114](https://github.com/atom/language-yaml/issues/114) — a `#` in a block-scalar body is content, not a comment | ✓ | ✓ |
| [tmbundle#38](https://github.com/textmate/yaml.tmbundle/issues/38) — a block scalar with leading/internal EMPTY lines stays one string region | ✓ | ✓ |
| [tmbundle#18](https://github.com/textmate/yaml.tmbundle/issues/18) — JSON-ish punctuation (`{`/`}`) and a tab indicator inside a block scalar stay content | ✓ | ✓ |
| [johnsoncodehk/monogram#12](https://github.com/johnsoncodehk/monogram/issues/12) — an anchor `&a` in explicit-key (`?`) position is still an anchor | ✓ | ✓ |
| [johnsoncodehk/monogram#12](https://github.com/johnsoncodehk/monogram/issues/12) — a bare `?` opening an explicit multi-line sequence key is the map-key indicator | ✓ | ✓ |
| [atom/language-yaml#119](https://github.com/atom/language-yaml/issues/119) — an escape inside a double-quoted KEY is highlighted | ✓ | ✓ |
| [tmbundle#39](https://github.com/textmate/yaml.tmbundle/issues/39) — a plain scalar resolving to `null` is lexically a string that resolves to a constant | ✓ | ✓ |

</details>
<!-- issues:end -->

<sub>A sampled ledger of real tracker issues, not an exhaustive audit. Run `npm run bench:issues` to regenerate (needs the official grammars: VS Code's installed TS/JS/HTML). Sources: [`test/issue-cases.ts`](test/issue-cases.ts), [`test/html-issue-cases.ts`](test/html-issue-cases.ts).</sub>


### The ceiling — and the bar for claiming it

The **only-Monogram** wins above are all disambiguations that are *TextMate-expressible but infeasible to hand-write* — a parser supplies the pattern a human can't reliably guess. The **both-miss** cases are ones neither grammar gets *today* — not, by default, ones TextMate *can't*.

"TextMate can't express X" is not a guess or an assertion; it is a claim to be **proven from the model**. TextMate is a line-oriented matcher whose only cross-line memory is a finite stack of scope contexts, so a proof exhibits an X whose correct highlighting provably needs memory that model lacks — unbounded lookback to a token that is not an enclosing context. A failed *attempt* to derive a pattern is not such a proof: a cleverer pattern may exist, and most "impossible for TextMate" folklore is exactly this error — the multiline / nested-generic cases turn out TM-expressible once a parser supplies the pattern, which is why the derived grammar gets them right. Where a construct provably exceeds the model, Monogram's **tree-sitter** target — a real parser over the whole tree — resolves it.

### Total parsing under edits — measured against tsc and tree-sitter

The handle API (`createParser()`) is **total**: every text yields a tree plus `cst.errors`, with tsc-grade diagnostics (`expected ',' or ']'` where every listed token is *provably* still accepted at that position, `to match this '('` related info, zero-width `$missing` nodes that keep a call's shape when its `)` is missing). Two structural guarantees back it:

- **The valid path is byte-identical to the strict parser** — recovery runs only after a strict pass has rejected, so error tolerance costs valid input nothing, by construction.
- **Every edited re-parse is byte-identical to a fresh parse** of the same text — tree *and* errors, broken states included, held exact by generative edit scripts across all seven grammars in CI (`test/incremental-grammars.ts`).

One 9 MB TypeScript document, identical single-character edit scripts (`test/head-to-head.ts`, node v24, Apple silicon; ✎ = per keystroke, median):

| engine | fresh parse | valid ✎ | breaking ✎ | while-broken ✎ | fixing ✎ |
|---|---:|---:|---:|---:|---:|
| **Monogram** | **167 ms** | 0.37 ms | 12 ms | **0.22 ms** | 2.2 ms |
| tsc `updateSourceFile` | 207 ms | 35 ms | 12.0 ms | 11.9 ms | 11.9 ms |
| tree-sitter (official) | 430 ms | **0.18 ms** | **0.29 ms** | 0.30 ms | **0.22 ms** |

Monogram beats tsc on every phase (valid typing ~100×, while-broken ~50×) and beats or matches tree-sitter everywhere except the two **transition** edits (break/fix). Profiling attributes those almost entirely to the bench's 4.5 MB cursor jump: token-column offsets are EOF-relative-biased so that local typing never rewrites the suffix (that is what makes the valid keystroke 0.37 ms), and the bias boundary moves with the cursor — a far jump pays once, proportional to the jump distance, then repeated break/fix transitions at that position settle to **~1.6–2 ms** (the parser passes measure under 1 ms of that).

## What you get

From one grammar definition (a small TypeScript combinator API), five outputs are **fully functional**:

- **A lexer** — tokenizes source straight from the grammar's token definitions; usable on its own (`createLexer(grammar).tokenize`).
- **A CST parser** — recursive descent + Pratt precedence on top of the lexer, producing a **CST** (concrete syntax tree): every token is a node, including punctuation and keywords — roughly 2× an AST's nodes, by design, which is exactly what the highlighter and lossless source reconstruction need. A CST is *pre-semantic* (it models the productions, not static semantics — see [Correctness](#correctness-the-productions-not-tsc)).
- **A TextMate grammar** — a `.tmLanguage.json` for VS Code / Sublime syntax highlighting, derived from the same rules, including derived **JSDoc-body** and **regex-internal** sub-grammars. (TextMate *scopes* are the dot-separated labels — `entity.name.function`, `keyword.control` — that a theme maps to colors.)
- **A VS Code language configuration** — `language-configuration.json` (comments, bracket pairs, auto-close/surround, folding) derived from the same tokens.
- **CST node types** — a TypeScript discriminated union (keyed by rule) for typed tree consumers.

And — from the same grammar — generators for the rest of the ecosystem, at varying maturity:

- **tree-sitter** — `grammar.js` + a **structural** `queries/highlights.scm` + an external scanner for context-sensitive lexing. tree-sitter's GLR absorbs the grammar and compiles to wasm; the derived query scores **95.9%** token-family accuracy against a neutral `tsc` oracle — above the official tree-sitter's **92.7%** — and is CI-gated by `npm run gate:treesitter`.
- **Monarch** — a Monaco (web) tokenizer (functional, bounded by JS-regex limits).

## The grammar is the source of truth

A grammar is a TypeScript module: tokens, operator precedence, and rules built from small combinators. A self-contained mini-example:

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

Token patterns are **combinators, not regular expressions** — `seq` / `oneOf` / `range` / `noneOf` / `plus` / `star` / `altPattern` / `optPattern` / … assemble a structured pattern IR (regex is a *derived* backend, not the source of truth). A bare `RegExp` is not a valid token pattern: `token(/…/)` is a `TS2345` type error. Coming from regex:

| RegExp | Combinator |
|---|---|
| `/[ \t]+/` | `plus(oneOf(' ', '\t'))` |
| `/[A-Z_][A-Z0-9_]*/` | `seq(oneOf(range('A', 'Z'), '_'), star(oneOf(range('A', 'Z'), range('0', '9'), '_')))` |
| `/"[^"]*"/` | `seq('"', star(noneOf('"')), '"')` |
| `/\d+(\.\d+)?/` | `seq(plus(digit), optPattern(seq('.', plus(digit))))` |

Note `digit` above is just `range('0', '9')` — patterns are plain values you name and reuse, not magic strings.

The parser uses these rules to build a CST. The highlighter reads the same rule **shapes** and infers most scopes structurally — with no per-rule annotation:

- `foo(x)` → `foo` is `entity.name.function` (from the `$ '(' …` call form)
- `obj.name` → `name` is `entity.other.property` (from the `$ '.' Ident` form)
- `'class' Ident` → `Ident` is `entity.name.type` (from declaration structure)
- `Expr '<' Type '>' '('` → a generic call, not a comparison (from rule structure)

Flat, irreducible facts — which keywords are control flow, which punctuation is an operator — are declared once in a small `scopes` map (≈50 lines for TypeScript) rather than inferred. Structure is derived; vocabulary is declared.

## A language-agnostic engine

Nothing in the engine knows about TypeScript. Everything language-specific lives in the grammar — keywords, which token is the identifier, template-literal delimiters, the regex-vs-division lexer ambiguity — all *declared per token*:

```ts
import { token, seq, altPattern, noneOf, anyChar, oneOf, plus, star, notFollowedBy } from './src/api.ts';

const escaped = seq('\\', anyChar());

const Template = token(seq(
  '`',
  star(altPattern(noneOf('`', '\\', '$'), escaped, seq('$', notFollowedBy('{')))),
  '`',
), {
  template: { open: '`', interpOpen: '${', interpClose: '}' },
});
const Regex = token(seq(
  '/',
  plus(altPattern(
    noneOf('/', '\\', '[', '\n'),
    escaped,
    seq('[', star(altPattern(noneOf(']', '\\', '\n'), escaped)), ']'),
  )),
  '/',
  star(oneOf('g', 'i', 'm', 's', 'u', 'y', 'd', 'v')),
), {
  regex: true,
  regexContext: {
    divisionAfterTypes: ['Ident', 'Number', 'String', 'Template'],
    divisionAfterTexts: [')', ']', 'this', 'true', /* … */],
    regexAfterTexts:    ['return', 'typeof', 'instanceof', /* … */],
  },
});
```

[`test/agnostic.ts`](test/agnostic.ts) proves it directly — the same engine parses a toy grammar whose identifier token is `Word`, with no templates or regex. The deeper proof is [`html.ts`](html.ts): markup shares *nothing* with TypeScript's token stream, yet the same engine handles it.

### The emitted parser need not be JS — Go, Rust, native

The grammar also derives a **parser library in another language**. [`emitParser(grammar, target)`](src/emit.ts) runs one analysis into one language-agnostic IR, and each `Target` renders it — including its own regex-free lexer (`emitParser` reuses `emitLexer(grammar, target)`), so the output has no dependency on the JS runtime and compiles offline. What it emits is a **library** — no I/O — exposing two composable phases, `tokenize(src)` then `parse(tokens)`, so the lexer is reused at runtime (lex once, use the tokens *and* the CST):

```ts
import { emitParser, tsTarget, goTarget, rustTarget } from './src/emit.ts';
writeFileSync('parser.mts', emitParser(grammar, tsTarget));   // + goTarget / rustTarget

// in the emitted parser:
const tokens = tokenize(src);   // lex once
const cst    = parse(tokens);   // same tokens → CST — no re-lexing
```

Go and Rust expose the same `tokenize`/`parse` pair (Rust passes `src` to `parse` too, as it keeps no globals). The CLI shape `test/portable-targets.ts` runs (stdin → CST JSON) is a *harness* wrapper — `target.emitRunner()`, appended by the gate to make the library executable — not part of the parser.

The proof is the full languages: the real [`javascript.ts`](javascript.ts) and [`typescript.ts`](typescript.ts) grammars — including the `[Await]/[Yield]` fork, left recursion, the regex/division and template state machines, arrow functions, and the TS type grammar — emit to **TypeScript, Go, and Rust**, and every CST is byte-identical to the reference interpreter. [`test/portable-targets.ts`](test/portable-targets.ts) compiles and runs all three for sixteen grammars (the two real languages plus focused fixtures) on every CI run. The Rust output reaches [oxc](https://github.com/oxc-project/oxc) throughput and the Go output beats [tsgo](https://github.com/microsoft/typescript-go) on the same corpus (an arena keeps both near zero-allocation). Byte-based Go/Rust use UTF-8 offsets — identical to the JS interpreter's for ASCII; non-ASCII offset units differ inherently.

## Adding a language

A new language is **one grammar file** on the unchanged engine:

1. **Write the grammar** with the combinator API ([`src/api.ts`](src/api.ts)) — tokens, operator precedence, rules. Everything language-specific lives here.
2. **Prove it as a parser** against the language's own official test suite, measured **bidirectionally** (accept what the reference accepts, reject what it rejects).
3. **Drop in the official TextMate grammar** as the baseline, so highlighter coverage is measured against what you're replacing, not asserted.

The lexer, CST types, and all three highlighters fall out of step 1; a *dialect* (`.tsx`/`.jsx`, or a markup dialect on [`html.ts`](html.ts)) reuses a base grammar's rules by name in a few lines. The conformance/highlighter harnesses are currently TypeScript-specific (they call `tsc` and read VS Code's grammar) — point them at your own reference compiler.

## Known differences from the official highlighter

A handful of token patterns are scoped differently from VS Code's official TypeScript grammar — all intentional, and in some Monogram is arguably *more* correct (these are *deliberate divergences*, distinct from the bug-class fixes the [ledger](#every-bug-filed-against-the-official-grammar) measures):

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
        └─ src/gen-monarch.ts ──────▶ typescript.monarch.json

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
