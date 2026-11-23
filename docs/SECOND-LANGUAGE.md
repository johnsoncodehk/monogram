# The second language: Python

monogram's claim is that one grammar file gives a proven parser, highlighters and portable
TypeScript / Go / Rust parsers. Every engine mechanism so far was added for JavaScript and
TypeScript. To test whether the model is general, [`python.ts`](../python.ts) writes a language with
no kinship to tsc. This file counts every place where the ENGINE had to change and every place
where the grammar had to work AROUND the engine. The workarounds count as findings about the
model as much as the engine changes do.

**Count: engine mechanisms needed 3 (all 3 general: none is Python-specific); landed 0. Grammar
workarounds 3. Engine behaviours that turned out to be one language's, found by the second: 2
(indent mode was YAML's; the `>` re-scan is TypeScript's).**

The definition is CPython 3.10's `Grammar/python.gram` and its tokenizer. The oracle is `ast.parse`
of Python 3.10.12, never `compile()`: compile adds symbol-table and compiler errors (`return`
outside a function, `nonlocal` at module level, a lone `*a`), which are not syntax. The language
version is pinned to 3.10.12, the box's python3, so this syntax is unchecked: 3.11's `except*` and
starred subscripts (`a[*b]`), and 3.12's type parameters (`def f[T]()`), `type` statement and PEP 701
f-strings (a replacement field may reuse the string's quote and nest without limit).

## Verdict agreement

`conformance/cpython` ([`test/cpython.ts`](../test/cpython.ts)) parses every `.py` file of CPython's
`Lib/` (the standard library and its test suite) at v3.10.12 (pin: `test/cpython.sha`) with the
interpreter over `python.ts` and compares each verdict with `ast.parse` given the file's bytes.
The files are data: parsed by both, never executed, never copied into this repository. Every
disagreement carries a class. The record is [`test/cpython-record.txt`](../test/cpython-record.txt).

First grammar, today's engine: **1626 of 1731 files agree** (1619 accept, 7 reject); WE-ACCEPT 2,
WE-REJECT 103. Every disagreement is one of the engine rows below or not syntax:

| class | files | row |
|---|---:|---|
| `reject/comment-after-code` | 82 | L1 |
| `reject/form-feed` | 18 | L1 |
| `reject/not-utf8` (a coding cookie of another encoding; the harness reads UTF-8) | 3 | not syntax |
| `accept/encoding-declaration` (a cookie the decoder refuses) | 2 | not syntax |

The corpus is nearly all valid code (9 files the reference rejects), so it measures the accept
direction. The reject direction comes from single-token mutants of the same files, judged by
`ast.parse` (next landing).

## The table

| # | kind | what | why the grammar file could not say it | general? | cost |
|---|---|---|---|---|---|
| L1 | engine behaviour that was one language's (owed to M1) | the indent mechanism was YAML's, not general: three behaviours defaulted into every indent grammar. (1) A `#` opens a comment only after whitespace (YAML §6.6), so `x=1#c` does not lex: 82 files. (2) Leading whitespace counts spaces only, so a form feed (which Python's tokenizer reads as a column reset) is content: 18 files. A tab is YAML's §6.1 error or skipped, never measured. (3) A bracket opened after `:` must indent its lines (YAML §7.4), so `if x: [\n1]` throws. `keyValueSeparator` also defaults to `:` and feeds YAML's tab sniffs | indent mode (`IndentConfig`, `src/emit-lexer.ts`) has no declaration for any of them | general: every indent grammar | 100 of 1731 files rejected wrongly; no `TabError` |
| L2 | engine behaviour that was one language's (owed to M3) | `x = $` accepts: `$` is an identifier character | the Unicode identifier fallback is ECMAScript's (`src/uni-ident.ts`: `$`, ZWNJ / ZWJ, ID_Start / ID_Continue); Python's is `_` + XID_Start / XID_Continue | general: Go, Rust, Java each differ | accepts invalid code |
| W1 | workaround | `not`, `and`, `or` are rules (python.gram's layers), not Pratt levels | an engine prefix operator binds with lbp 0 (`src/grammar-analysis.ts`), so a Pratt `not` would be admitted as the operand of a tighter infix: `a == not b` would parse | general: any language with a prefix operator looser than an infix (SQL `NOT`, Haskell's `-`) | two rule levels and a rule-call per operand that one Pratt frame would not need (rule calls per token: below) |
| W2 | workaround, around a TypeScript behaviour | comparisons are a Pratt level, so `a < b < c` is left-nested binary operators, not python.gram's one n-ary `Compare` | written as a rule level, `>=` and `>>=` become rule literals next to `>`, and `gtComposites` (`src/grammar-utils.ts`) infers TypeScript's re-scan of `>` from `>` being a rule literal: every `>`-led punctuator is then composed from single `>` tokens, and a `>`-led rule literal is refused | the inference is TypeScript's; what it should be is a declaration (Rust, C++, Java and C# close generics with `>>` too) | the verdict is the same; a shape that wants one comparison node flattens the chain |
| W3 | workaround (python.gram's own method) | an assignment's head is parsed as targets (`t_primary` arms end in `&t_lookahead`, written `not(not(…))`), and the same text as an expression by the expression-statement arm | no cover grammar: the grammar says targets and expressions separately, as python.gram does; `f().x = 1` assigns, `f() = 1` has no derivation | the cover-grammar mechanism (roadmap) would serve every language with destructuring | the head of an expression statement is parsed twice (below) |
| M1 | mechanism (approved; design agreed) | the offside layer: a core (column stack, Indent / Dedent / Newline, bracket suspension, blank and comment-only lines, a declared tab and form-feed policy, a loud error on a dedent to an unknown column) with YAML's behaviours as declared extensions; interpreter first, then a portable line-start step | indent mode is YAML's (L1) and interpreter-only (`src/emit-portable.ts` refuses it) | general: Python, YAML, F#, Nim, CoffeeScript, Sass, Pug | |
| M2 | mechanism (approved; design pending) | templates generalised for f-strings: several template tokens, an open distinct from the close with a prefix class, `{{` / `}}` escapes, a hole tail with a format-spec text mode and nested holes; 3.10's "a hole may not hold the closing quote" as a per-token option | one template token per grammar, whose `open` both opens and closes it | general: C# interpolated strings, Kotlin, Swift, Scala | |
| M3 | mechanism (approved) | the identifier token's Unicode classes declared on the grammar (L2) | `src/uni-ident.ts` hard-codes ECMAScript's | general | |

`\` line joining needed nothing: it is a skip token (`LineJoin`). Soft keywords (`match`, `case`,
`_`), the conditional expression (a mixfix led, like `?:`), `lambda` (an arm that admits no led), the
walrus, comprehensions, decorators, `async`, every `match` pattern and the parameter-order rules
needed nothing either.

## Highlighters (not in the first pass)

- TextMate: colour needs no indentation, but gen-tm's indent paths are YAML's (value-position
  introducers from `compactIndicators`, block scalars) and must stay off for Python. Soft keywords
  (`match`, `case`) need a one-line lookahead (`match … :` at the end of the line). f-strings need
  M2 (one template token per grammar today).
- Monarch: the same one-template-token limit (`src/gen-monarch.ts`).
- tree-sitter: needs an INDENT / DEDENT / NEWLINE external scanner. The existing one
  (`buildIndentScannerC`) is YAML's (plain and block-scalar externals); a Python one comes from M1's
  core. Soft keywords cost GLR conflicts or `treeSitterContextualNames`. f-string bodies need
  scanner string-content tokens.
