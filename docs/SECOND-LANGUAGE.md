# The second language: Python

monogram's claim is that one grammar file gives a proven parser, highlighters and portable
TypeScript / Go / Rust parsers. Every engine mechanism so far was added for JavaScript and
TypeScript. To test whether the model is general, [`python.ts`](../python.ts) writes a language with
no kinship to tsc. This file counts every place where the ENGINE had to change and every place
where the grammar had to work AROUND the engine. The workarounds count as findings about the
model as much as the engine changes do.

**Count: engine mechanisms needed 5 (all 5 general: none is Python-specific); landed 3 (M3, M4,
M5). Grammar workarounds 3, all removed: W1 and W2 by M4, W3 by M5. Engine behaviours that turned out to be one language's, found by the second: 2 (indent
mode was YAML's; the `>` re-scan was TypeScript's, guessed from a `>` literal).**

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

## Work per token

The interpreter counts rule invocations (`PROF=1`, `profCounts` of `src/interpreter.ts`; a memo hit
counts as an invocation). It has no checkpoint or restore counters: those are the portable engine's
(`portable-work`), which cannot take Python before M1's portable step. A rule invocation is a frame,
not a unit of work: `typescript.ts` holds atoms, member access, calls and every operator in ONE
Pratt rule (`Expr`) whose loop consumes most tokens without a new frame, where `python.ts` splits
them into `Atom`, `Primary` and `BitwiseOr`. The comparable measure is the portable engine's work
counters (item 5 of the plan); this one says where the frames go.

| grammar | input | tokens | rule invocations | per token |
|---|---|---:|---:|---:|
| `python.ts` | CPython `Lib/*.py` (top level, 168 files) | 603426 | 6227033 | **10.32** |
| `typescript.ts` | this repository's `src/*.ts` (42 files) | 388605 | 218087 | 0.56 |

By cause (`python.ts`; the rule-to-cause map is in the measuring script, rows below):

| cause | rules | per token | share |
|---|---|---:|---:|
| the ladder written as rules (W1) | `Disjunction` 1.16, `Conjunction` 1.17, `Inversion` 1.18 | 3.51 | 34.0% |
| the assignment head parsed as targets (W3) | `TPrimary` 0.86, `SingleSubscriptAttributeTarget` 0.43, `TargetWithStarAtom` 0.20, `StarTarget(s)`, `StarAtom`, `SingleTarget`, `Assignment`, `DelTarget(s)` | 2.22 | 21.5% |
| the Pratt expression itself | `BitwiseOr` 1.18, `Primary` 0.33 | 1.51 | 14.6% |
| the expression entry layers | `Expression` 0.58, `StarExpression` 0.22, `StarExpressions` 0.22, `NamedExpression`, `StarNamedExpression(s)`, `Expressions`, `AssignmentExpression`, `YieldExpr`, `Lambdef` | 1.27 | 12.3% |
| atoms, displays, arguments, patterns | `Atom` 0.48, … | 1.24 | 12.0% |
| statement dispatch | `Statement(s)`, `SimpleStmt(s)`, `CompoundStmt`, `Block` | 0.58 | 5.6% |
| soft keywords | `MatchStmt`, `SubjectExpr`, `CaseBlock` | 0.00 | 0% |

`typescript.ts`: `Expr` 0.29, `Stmt` 0.08, `Type` 0.04, `MemberName` 0.03, every other rule under 0.03.

Why the ladder costs a third: a non-recursive rule is matched by trying EVERY arm its first token
admits and keeping the longest (`parseNonRec`), and only Pratt and left-recursive rules are memoised.
`Expression`'s first two arms both begin with `Disjunction`, so every expression descends
`Disjunction` → `Conjunction` → `Inversion` twice (each about twice `Expression`'s 0.58); the second
descent stops at the bottom only because `BitwiseOr` is a Pratt rule with a memo. The same rule
explains the assignment head: `SimpleStmt` tries its `Assignment` arm (the head as targets) and its
`StarExpressions` arm (the same text as expressions) on every expression statement.

### What the language costs, and what transcribing a PEG costs

python.gram is a reference grammar for a memoising PEG parser, and `python.ts` transcribed it. Three
of the causes above are that transcription, not Python:

- **The ladder (W1, 3.51).** `not` / `and` / `or` are three rule levels because a Pratt `not` would
  bind everywhere (W1). With M4 they are Pratt levels of the one expression rule: the three frames
  per operand go, and `Expression`'s second arm becomes a memo hit.
- **The assignment head (W3, 2.22).** JavaScript does not parse an assignment's left side twice: `=`
  is an operator whose left operand must have a target SHAPE (`lhsAssignTarget`, checked by
  `notAssignTarget` on the operand's outermost node). Python cannot use it as it stands, for three
  reasons. (1) The check is negative and shallow: it refuses an operator form (`a + b = 1`, `-a = 1`,
  `not a = 1`, `a == b = 1` would be refused) but admits every other form, and Python's targets are a
  POSITIVE set: a name, an attribute, a subscript, and a tuple, list or parenthesis of targets, a
  starred target inside one; `f() = 1`, `None = 1`, `[x for x in y] = 1`, `(a, f()) = x`, `(yield) = 1`
  and `lambda: 1 = 2` are syntax errors in `ast.parse`. (2) It does not recurse into the containers
  (`(a, f()) = x`). (3) Python's `=` is a statement separator, not an expression operator (`(a = 1)`
  is invalid), so the constraint belongs on a rule REFERENCE (the head of the statement), and three
  contexts admit different sets: star targets (`=`, `for`, `with … as`, comprehensions), a single
  target (augmented and annotated assignment: no tuple or list), del targets (no star). JavaScript
  needs the same thing and does not have it either: `[a+b] = x`, `[1] = x`, `({a: 1} = x)` parse with
  `javascript.ts` (docs/CORRECTNESS.md classes AssignmentTargetType as static semantics there; for
  Python the reference grammar makes it syntax). The candidate generalisation: a declared target
  shape on a reference (the arms that are leaves, the arms that are containers recursed into, per
  context), checked on the CST of the ONE parse. The `for` head then reads the expression list
  under `exclude('in')`, as JavaScript's for-in head does. W3 would go, and 2.22 per token with it,
  for a walk of the head's nodes on statements that have a `=`.
- **The expression entry layers (1.27).** Which of them are real: the comma lists (`Expressions`,
  `StarExpressions`, `StarNamedExpressions`) build tuples: real, and rules. The rest are CONTEXTS that
  admit or refuse one form each: a starred operand (`*a` in a list or a call, never `x = (*a)`), a
  named expression (`f(a := 1)` but not `x = y := 1`), the conditional and `lambda` (refused where a
  disjunction is required: `a if lambda: b else c`, `[x for x in lambda: y]`), `yield`. Python.gram
  says each context with a rule frame; on this engine each is an entry LEVEL into the one Pratt rule:
  the conditional a mixfix led below `or` whose condition is read at `or`'s level, `lambda` a capped
  nud (`capExpr`, as JavaScript's arrow function), `:=` the lowest level. That needs M4's level
  reference (below). `Atom` / `Primary` as rules separate from the Pratt rule are this grammar's
  layout choice; `typescript.ts` folds them into `Expr`.

Transcribed: **10.3 rule invocations per token**. With M4 (the ladder as one Pratt rule, the
conditional a mixfix led, `lambda` a capped nud, the starred and comprehension contexts read
`atLevel`): **5.63** on the same 603426 tokens, measured:

| cause (with M4) | per token | share |
|---|---:|---:|
| the assignment head parsed as targets (W3, removed by M5: below) | 2.22 | 39.4% |
| the expression entry layers | 1.26 | 22.5% |
| atoms, displays, arguments, patterns | 1.24 | 22.1% |
| statement dispatch | 0.58 | 10.2% |
| the Pratt expression (`Primary`; `Expression` counts as an entry) | 0.33 | 5.8% |

The entry layers left are real contexts: the comma lists, `StarExpression` (`*` admits a
bitwise-or only), `NamedExpression` (`:=` takes a name on its left). Each is one frame per
expression over the one Pratt rule; the ladder frames are gone.

With M5 (`python.ts` declares its three target contexts: the statement head is parsed once, as
star expressions, and checked where a `=`, augmented or annotation tail is taken; the `for` heads,
`with … as` and `del` read expressions under `assignTarget(ctx)`; the targets rule family is gone):
**2.88** on the same 603426 tokens (the estimate was 3.4), measured:

| cause (with M4 and M5) | per token | share |
|---|---:|---:|
| the expression entry layers (`ForTargets` counted here) | 1.08 | 37.6% |
| atoms, displays, arguments, patterns | 0.86 | 29.7% |
| statement dispatch | 0.58 | 19.9% |
| the Pratt expression (`Primary`) | 0.33 | 11.5% |
| an assignment's value (`AssignValue`, the frame that reads a chain's next `=`) | 0.04 | 1.3% |

`Atom` fell from 0.48 to 0.33 and `Expression` from 0.58 to 0.46 with the target family: the
second reading of every head reached them too. What is left is the language and the grammar's
layout: statements, atoms, displays, arguments, and the Pratt loop.

## The table

| # | kind | what | why the grammar file could not say it | general? | cost |
|---|---|---|---|---|---|
| L1 | engine behaviour that was one language's (owed to M1) | the indent mechanism was YAML's, not general: three behaviours defaulted into every indent grammar. (1) A `#` opens a comment only after whitespace (YAML §6.6), so `x=1#c` does not lex: 82 files. (2) Leading whitespace counts spaces only, so a form feed (which Python's tokenizer reads as a column reset) is content: 18 files. A tab is YAML's §6.1 error or skipped, never measured. (3) A bracket opened after `:` must indent its lines (YAML §7.4), so `if x: [\n1]` throws. `keyValueSeparator` also defaults to `:` and feeds YAML's tab sniffs | indent mode (`IndentConfig`, `src/emit-lexer.ts`) has no declaration for any of them | general: every indent grammar | 100 of 1731 files rejected wrongly; no `TabError` |
| L2 | engine behaviour that was one language's (closed by M3: `python.ts` declares `identifierClasses`, so `x = $` and `ͺ = 1` reject, as `ast.parse` does) | `x = $` accepts: `$` is an identifier character | the Unicode identifier fallback is ECMAScript's (`src/uni-ident.ts`: `$`, ZWNJ / ZWJ, ID_Start / ID_Continue); Python's is `_` + XID_Start / XID_Continue | general: Go, Rust, Java each differ | accepts invalid code |
| W1 | workaround (removed by M4) | `not`, `and`, `or` are rules (python.gram's layers), not Pratt levels | an engine prefix operator binds with lbp 0 (`src/grammar-analysis.ts`), so a Pratt `not` would be admitted as the operand of a tighter infix: `a == not b` would parse | general: any language with a prefix operator looser than an infix (SQL `NOT`, Haskell's `-`) | two rule levels and a rule-call per operand that one Pratt frame would not need (rule calls per token: below) |
| W2 | workaround, around a TypeScript behaviour (removed by M4; the inference itself is now a declaration, `composeGt`: 66a0f88) | comparisons are a Pratt level, so `a < b < c` is left-nested binary operators, not python.gram's one n-ary `Compare` | written as a rule level, `>=` and `>>=` become rule literals next to `>`, and `gtComposites` (`src/grammar-utils.ts`) infers TypeScript's re-scan of `>` from `>` being a rule literal: every `>`-led punctuator is then composed from single `>` tokens, and a `>`-led rule literal is refused | the inference is TypeScript's; what it should be is a declaration (Rust, C++, Java and C# close generics with `>>` too) | a shape that wants one comparison node flattens the chain; and the comparisons sit inside `BitwiseOr`, so a context that admits a bitwise-or only (`'*' BitwiseOr`, `'**' BitwiseOr`) admits a comparison: `[*a == b]` and `{**a == b}` parse, `ast.parse` rejects both (not in the corpus, which is valid code) |
| W3 | workaround (python.gram's own method; removed by M5) | an assignment's head is parsed as targets (`t_primary` arms end in `&t_lookahead`, written `not(not(…))`), and the same text as an expression by the expression-statement arm | no cover grammar: the grammar says targets and expressions separately, as python.gram does; `f().x = 1` assigns, `f() = 1` has no derivation | the cover-grammar mechanism (roadmap) would serve every language with destructuring | the head of an expression statement is parsed twice: 2.22 rule invocations per token, 21.5% (Work per token, where JavaScript's `lhsAssignTarget` is measured against it and found short) |
| M1 | mechanism (approved; design agreed) | the offside layer: a core (column stack, Indent / Dedent / Newline, bracket suspension, blank and comment-only lines, a declared tab and form-feed policy, a loud error on a dedent to an unknown column) with YAML's behaviours as declared extensions; interpreter first, then a portable line-start step | indent mode is YAML's (L1) and interpreter-only (`src/parser-ir.ts` refuses it) | general: Python, YAML, F#, Nim, CoffeeScript, Sass, Pug | |
| M2 | mechanism (approved; design pending) | templates generalised for f-strings: several template tokens, an open distinct from the close with a prefix class, `{{` / `}}` escapes, a hole tail with a format-spec text mode and nested holes; 3.10's "a hole may not hold the closing quote" as a per-token option | one template token per grammar, whose `open` both opens and closes it | general: C# interpolated strings, Kotlin, Swift, Scala | |
| M3 | mechanism (landed: 8e67723) | the identifier token's Unicode classes declared on the grammar (L2) | `src/uni-ident.ts` hard-codes ECMAScript's | general | |
| M4 | mechanism (this landing) | `cappedPrefix(...)`: a prefix operator that begins an operand only at its own level or a looser one; `atLevel(op, Rule)`: a Pratt rule read at an operator's level (docs/GRAMMAR.md). The interpreter tests the cap in its prefix nud and reads `atLevel` through `parsePratt`; the portable engine lowers a capped operator to a sequence arm `op operand` under the existing `capBelow` guard and `atLevel` to the existing `ruleBp` step, so no printer changed and every shipped grammar's emitted parser is byte-identical | a prefix operator bound at every operand position (W1), and no reference could name a level (`'*' bitwise_or`) | general: SQL `NOT`, Haskell's `-`, any ladder whose contexts start at different levels | none for grammars that do not use it; for Python 10.32 -> 5.63 rule invocations per token, and `[*a == b]`, `{**a == b}`, `a if b if c else d else e`, `a if lambda: b else c`, `[x for x in lambda: y]` now reject, as `ast.parse` does (the corpus record does not move: Lib/ holds none of them) |
| M5 | mechanism (landed: the contexts, their portable plan and cost; `python.ts` adopts them in this landing) | a declared target shape: contexts over stable arm names (leaves, containers recursed through named children, `last` arms) and a zero-width `assignTarget(ctx)` marker after the reference it checks, so an assignment's head is parsed once and checked only when the `=` tail is taken (docs/GRAMMAR.md "Declared assignment-target contexts"; `python.ts`'s contexts `star`, `single`, `del`; a single target is the one child of a list with no ',' after it, each of its leaves `last`). A target may open an `opt` or a disjoint-literal alternation branch, reading the reference before it, so one arm holds the expression statement and every assignment. An `exclude` holds for the one Pratt frame it enters, so the `for` head's list excludes `in` per element (`ForTargets`). JavaScript needs it too: the AssignmentPattern refinement (rest last, no getter or method in a pattern object: about 27 test262 files) is the spec's supplemental grammar, i.e. syntax; AssignmentTargetType of a leaf stays an early error | W3; JavaScript's `lhsAssignTarget` is shallow and negative | general | Python 5.63 -> 2.88 rule invocations per token; the CPython record does not move (1626 of 1731 agree: Lib/ is valid code, and every disagreement is L1's or an encoding's), and the reject direction is the verdict scan's: its Python half now puts every operand form, and every form with a continuation, in the eight target positions (`e = x`, `y = e = x`, `e += x`, `e: int`, `del e`, `for e in x`, `[y for e in x]`, `with x as e`): 21232 inputs (was 7520), ast.parse agreeing on all but one new class of 3, `py-ann-paren-trailer`: `(a).x: int` rejects in CPython because python.gram's annotation group `('(' single_target ')' \| single_subscript_attribute_target)` commits to its first alternative (a PEG artifact; the transcribed rules had it, a context cannot say it) |

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
