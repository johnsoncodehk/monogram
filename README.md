# Monogram

Write a language's grammar **once**, as an executable definition. Monogram runs it as a real parser, proves it against the language's official conformance suite, then **derives the syntax highlighters** — TextMate, tree-sitter, Monarch — from that same proven grammar. Highlighting correctness flows *down* from a parser-verified model instead of *up* from hand-tuned regex.

> *mono + grammar — one grammar definition, many derived artifacts.*

**Status** — an active research project; four languages on one shared, [language-agnostic](#a-language-agnostic-engine) engine, each [proven as a parser](#the-idea) before its highlighter is trusted:

- **TypeScript** ([`typescript.ts`](typescript.ts)) — mature: 100% valid-code coverage, 97.8% bidirectional vs `tsc`.
- **JavaScript** ([`javascript.ts`](javascript.ts)) — the standalone ECMAScript base TypeScript [builds on](#adding-a-language) (subset → superset); parses real-world JS, with less conformance-corpus depth than TS so far.
- **HTML** ([`html.ts`](html.ts)) — the engine reaching *past token streams into markup*; ~95 lines, validated against [`parse5`](https://github.com/inikulin/parse5).
- **Vue** ([`vue.ts`](vue.ts)) — a dialect of `html.ts`: SFC blocks that embed Monogram's own TS/JS/CSS, plus directives and `{{ }}` interpolation.

<!-- coverage:start -->
Per-grammar alignment vs the **official parser** as the neutral oracle (`node test/coverage-table.ts --write`). *Parser* = Monogram's parser vs the official parser: `branch` = source-coverage-anchored branch alignment, `agree` = bidirectional accept/reject (tree-equality for structural oracles) — `test/src-coverage.ts`. *Highlighter* = Monogram's derived TextMate grammar vs the official one, both graded against the parser's token roles — `test/scope-gap.ts`, the [vscode#203212](https://github.com/microsoft/vscode/issues/203212) comparison.

| Grammar | Parser (branch · agree) | Highlighter — Monogram vs official |
|---|---|---|
| TypeScript | 97.7% · 97.1% | 99.4% vs 99.0% |
| JavaScript | 97.3% · 92.2% | 87.9% vs 83.6% |
| JSX | 100.0% · 97.1% | 94.6% vs 92.9% |
| TSX | 99.4% · 96.7% | 94.3% vs 95.1% |
| HTML | 84.3% · 77.9% | 100.0% vs 97.6% |
| YAML | 83.0% · 63.1% | 46.5% vs 89.7% |
| Vue | — | 98.8% vs 98.0% |
<!-- coverage:end -->

<sub>**Which “official” grammar each row compares against:** HTML’s is the unmaintained [`textmate/html.tmbundle`](https://github.com/textmate/html.tmbundle) — the #203212 case Monogram targets. YAML’s is the maintained [RedCMD/YAML-Syntax-Highlighter](https://github.com/RedCMD/YAML-Syntax-Highlighter) that VS Code switched to ([microsoft/vscode#232244](https://github.com/microsoft/vscode/pull/232244)) — so YAML’s gap is Monogram vs a *maintained* grammar, not a dead bundle. JS/TS use Microsoft’s maintained [TypeScript-TmLanguage](https://github.com/microsoft/TypeScript-TmLanguage).</sub>

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

1. **Write the grammar, then prove it.** The grammar is executable — Monogram runs it as a recursive-descent + [Pratt](https://en.wikipedia.org/wiki/Operator-precedence_parser) (operator-precedence) parser over the TypeScript conformance suite, measured *bidirectionally*: it must **accept** every input `tsc` accepts **and reject** every input it rejects.

2. **Derive the highlighters from that proven grammar**, never hand-write them. The TextMate, tree-sitter, and Monarch outputs are all generated from the one parser-validated definition, so their correctness is underwritten by the conformance run, not by regex tuning.

That single source reaches across grammars, too: an embedded snippet runs *another Monogram grammar* — a `<script>` body is highlighted by Monogram's own JavaScript, so `<script>const x = 1 < 2</script>` colours `<` as a JS operator, the same ambiguity resolved *inside* the embed. Where VS Code's embeds fray — two independently-written grammars meeting with nothing checking the seam — Monogram owns both sides, so self-verifying that seam becomes possible (a design goal beyond today's standard `contentName` injection).

## Comparison

The same question, every language at once: take the bugs reported against each *hand-written* official grammar and ask whether the *derived* grammar solves them. Which does **only** the official solve, which does **only** Monogram solve — and which do **both** still get wrong (the shared frontier neither reaches today)?

<!-- issues:start -->
<!-- generated by `npm run bench:issues` — do not edit by hand -->
_Each hand-written **official** grammar vs Monogram's **derived** one, on the bugs filed against it: **TypeScript 26/26** (official 8/26) · **TSX 11/11** (official 5/11) · **HTML 20/20** (official 13/20) · **Vue 23/23** (official 18/23). Per-issue detail below — auto-generated by `npm run bench:issues`._

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

#### Vue
| issue | Monogram | official |
|---|:--:|:--:|
| [#6007](https://github.com/vuejs/language-tools/issues/6007)/[#2096](https://github.com/vuejs/language-tools/issues/2096)/[#520](https://github.com/vuejs/language-tools/issues/520) — `as` type assertion in directive value | ✓ | · |
| [#2060](https://github.com/vuejs/language-tools/issues/2060)-inline — `` const a = 1;</script> `` (content on the close line) embeds + clean close | ✓ | · |
| [#2060](https://github.com/vuejs/language-tools/issues/2060)-inline-adjacent — an unterminated union before a same-line `` </script> ``, then a second `<script setup>` block | ✓ | · |
| [#5660](https://github.com/vuejs/language-tools/issues/5660) — `as const` cast in a v-for value | ✓ | · |
| [#4716](https://github.com/vuejs/language-tools/issues/4716)/[#5571](https://github.com/vuejs/language-tools/issues/5571) — `as` cast followed by another attribute | ✓ | · |

<details><summary>… and 18 more both grammars already handle (✓ / ✓)</summary>

| issue | Monogram | official |
|---|:--:|:--:|
| [#3400](https://github.com/vuejs/language-tools/issues/3400) — `instanceof` in {{ }} | ✓ | ✓ |
| [#5370](https://github.com/vuejs/language-tools/issues/5370) — `typeof x !==` in v-if | ✓ | ✓ |
| [#5118](https://github.com/vuejs/language-tools/issues/5118) — `?.` / `??` in {{ }} | ✓ | ✓ |
| [#1675](https://github.com/vuejs/language-tools/issues/1675) — arrow `=>` in {{ }} | ✓ | ✓ |
| [#6039](https://github.com/vuejs/language-tools/issues/6039)/[#4741](https://github.com/vuejs/language-tools/issues/4741) — `<` operator in {{ }} (not a tag!) | ✓ | ✓ |
| [#5722](https://github.com/vuejs/language-tools/issues/5722) — negated ternary + quotes in {{ }} | ✓ | ✓ |
| [#5538](https://github.com/vuejs/language-tools/issues/5538)/[#2060](https://github.com/vuejs/language-tools/issues/2060) — trailing `export type` before `` </script> `` | ✓ | ✓ |
| [#3999](https://github.com/vuejs/language-tools/issues/3999) — a force-wrapped multi-line `<script lang="ts">` start tag keeps the body as the `ts` family (no .ts→.js flip) | ✓ | ✓ |
| [#4769](https://github.com/vuejs/language-tools/issues/4769) — tag name starting with `template` | ✓ | ✓ |
| [#5701](https://github.com/vuejs/language-tools/issues/5701) — `{{` inside a `<script>` string | ✓ | ✓ |
| [#6070](https://github.com/vuejs/language-tools/issues/6070) — capitalized component then a `<style>` block | ✓ | ✓ |
| [#4291](https://github.com/vuejs/language-tools/issues/4291) — `<script lang="tsx">` body embeds the DECLARED `source.tsx` (not a source.js fallback) | ✓ | ✓ |
| [#4291](https://github.com/vuejs/language-tools/issues/4291)-jsx — `<script lang="jsx">` body embeds the DECLARED `source.js.jsx` | ✓ | ✓ |
| generic="T" — `generic="T extends U">` type-param list embeds as TS | ✓ | ✓ |
| [#4410](https://github.com/vuejs/language-tools/issues/4410) — dynamic directive argument `:[attr]` | ✓ | ✓ |
| [#3727](https://github.com/vuejs/language-tools/issues/3727) — `.prop` modifier shorthand | ✓ | ✓ |
| [#2666](https://github.com/vuejs/language-tools/issues/2666) — dynamic slot name from a template literal | ✓ | ✓ |
| [#2560](https://github.com/vuejs/language-tools/issues/2560)/[#1290](https://github.com/vuejs/language-tools/issues/1290) — `type` as a v-for loop variable | ✓ | ✓ |

</details>
<!-- issues:end -->

<sub>A sampled ledger of real tracker issues, not an exhaustive audit. Run `npm run bench:issues` to regenerate (needs the official grammars: VS Code's installed TS/JS/HTML, and the Vue fixtures — see [`test/vue-bench.ts`](test/vue-bench.ts)). Sources: [`test/issue-cases.ts`](test/issue-cases.ts), [`test/html-issue-cases.ts`](test/html-issue-cases.ts), [`test/vue-issue-cases.ts`](test/vue-issue-cases.ts).</sub>


### The ceiling — and the bar for claiming it

Deriving from a proven parser wins the disambiguation that is *TextMate-expressible but infeasible to hand-write* — regex-vs-division, generic-vs-comparison, whitespace-fragile multiline generics — the **only-Monogram** column. The **both-miss** cases are ones neither grammar gets *today* — not, by default, ones TextMate *can't*.

"TextMate can't express X" is not a guess or an assertion; it is a claim to be **proven from the model**. TextMate is a line-oriented matcher whose only cross-line memory is a finite stack of scope contexts, so a proof exhibits an X whose correct highlighting provably needs memory that model lacks — unbounded lookback to a token that is not an enclosing context. A failed *attempt* to derive a pattern is not such a proof: a cleverer pattern may exist, and most "impossible for TextMate" folklore is exactly this error — the multiline / nested-generic cases turn out TM-expressible once a parser supplies the pattern, which is why the derived grammar gets them right. Where a construct provably exceeds the model, Monogram's **tree-sitter** target — a real parser over the whole tree — resolves it.

## What you get

From one grammar definition (a small TypeScript combinator API), five outputs are **fully functional**:

- **A lexer** — tokenizes source straight from the grammar's token definitions; usable on its own (`createLexer(grammar).tokenize`).
- **A CST parser** — recursive descent + Pratt precedence on top of the lexer, producing a **CST** (concrete syntax tree): every token is a node, including punctuation and keywords — roughly 2× an AST's nodes, by design, which is exactly what the highlighter and lossless source reconstruction need.
- **A TextMate grammar** — a `.tmLanguage.json` for VS Code / Sublime syntax highlighting, derived from the same rules, including derived **JSDoc-body** and **regex-internal** sub-grammars. (TextMate *scopes* are the dot-separated labels — `entity.name.function`, `keyword.control` — that a theme maps to colors.)
- **A VS Code language configuration** — `language-configuration.json` (comments, bracket pairs, auto-close/surround, folding) derived from the same tokens.
- **CST node types** — a TypeScript discriminated union (keyed by rule) for typed tree consumers.

And — from the same grammar — generators for the rest of the ecosystem, at varying maturity:

- **tree-sitter** — `grammar.js` + a **structural** `queries/highlights.scm` + an external scanner for context-sensitive lexing. tree-sitter's GLR absorbs the grammar and compiles to wasm; the derived query scores **95.9%** token-family accuracy against a neutral `tsc` oracle — above the official tree-sitter's **92.7%** — and is CI-gated by `npm run gate:treesitter`.
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

[`test/agnostic.ts`](test/agnostic.ts) proves it directly — the same engine parses a toy grammar whose identifier token is `Word`, with no templates or regex. The deeper proof is [`html.ts`](html.ts): markup shares *nothing* with TypeScript's token stream, yet the same engine handles it (and Vue layers SFC blocks + `{{ }}` interpolation on top).

## Adding a language

A new language is **one grammar file** on the unchanged engine:

1. **Write the grammar** with the combinator API ([`src/api.ts`](src/api.ts)) — tokens, operator precedence, rules. Everything language-specific lives here.
2. **Prove it as a parser** against the language's own official test suite, measured **bidirectionally** (accept what the reference accepts, reject what it rejects).
3. **Drop in the official TextMate grammar** as the baseline, so highlighter coverage is measured against what you're replacing, not asserted.

The lexer, CST types, and all three highlighters fall out of step 1; a *dialect* (`.tsx`/`.jsx` via [`jsx.ts`](jsx.ts), or Vue on [`html.ts`](html.ts)) reuses a base grammar's rules by name in a few lines. The conformance/highlighter harnesses are currently TypeScript-specific (they call `tsc` and read VS Code's grammar) — point them at your own reference compiler.

## Known differences from the official highlighter

A handful of token patterns are scoped differently from VS Code's official TypeScript grammar — all intentional, and in some Monogram is arguably *more* correct (these are *deliberate divergences*, distinct from the bug-class fixes the [ledger](#comparison) measures):

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
