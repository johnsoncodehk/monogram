# Upstream issue ledger

A maintained accounting of [microsoft/TypeScript-TmLanguage](https://github.com/microsoft/TypeScript-TmLanguage/issues) issues against Monogram: what we solve, what we don't, and — for what we don't — *why*, with an honest verdict per issue.

**The honest frame.** Monogram **generates** a TextMate grammar, so anything genuinely impossible in the TextMate model is impossible in *our* TM output too. The advantage is not magic regex power — it is that we derive the TM patterns from a parser proven against the conformance suite, so we get *right* the disambiguation that is **TM-expressible but infeasible to hand-write**. That means an unsolved issue is usually one of: *(a)* in our backlog (TM-expressible, parser-derivable, not done yet), *(b)* out of our current grammar scope (TSX, JSDoc-content), *(c)* not a grammar's job at all (semantic tokens, theming, tooling), or *(d)* genuinely TM-format-impossible. Only **(d)** is "TM can't" — and we don't claim it without proof (see [the discipline](#classifying-an-unsolved-issue)).

**As of 2026-05-29** — 106 open upstream issues.

| Verdict | Count | Meaning |
|---|---:|---|
| ✅ **Solved** | **50** | parser-derived TM gets it right; replayed green in [`test/test-issues.ts`](../test/test-issues.ts) (313 checks). **All 50 are still open upstream.** |
| 🔧 Backlog (our domain) | ~6 | TM-expressible + parser-derivable; not done yet, or a residual gap. |
| 📦 Out of scope (now) | 8 + 16 | TSX dialect (8); JSDoc *embedded-content* highlighting (16) — needs the embedded-grammar pipeline. |
| 🧠 Needs semantics | ~6 | type/symbol resolution — **no syntax highlighter (TM or parser) can do this**; the language server's job. |
| 🛠 Not a grammar concern | ~20 | theming, semantic-token config, scope-name data, tooling, IDE support. |
| ⛔ Proven TM-impossible | 0 confirmed | none yet proven (requires a failing generated-TM + a passing parser-target — see discipline). |

The headline: **Monogram already solves 50 of the 106 still-open official issues (~47%)** — exactly the regex-vs-division / generic-vs-comparison / multiline-context class that a hand-written grammar perpetually loses to.

---

## ✅ Solved (50)

All replayed in [`test/test-issues.ts`](../test/test-issues.ts) and all still open upstream. Grouped by the ambiguity class — every one is something a regex grammar cannot reliably decide but a parser settles for free.

**Regex literal vs. division `/`** — the lexer uses parser context (what the previous token *is*) to decide:
`#853` (after `throw`/`void`/`typeof`/`await`/`yield`), `#804` (`/[a\-b]/` char class), `#1024` (regex on a new line), `#883` (`for (const x of /re/.exec…)`), `#1055` (backtick inside a regex), `#1063` (`\cJ`/`\cj` control-char escapes), `#1021` (the `v` unicode-sets flag).

**Generic type-args `<…>` vs. less-than `<`** — the parser knows when `<` opens type arguments:
`#1050`, `#978` (`typeof x < y`), `#859` (`as` cast inside `<>`), `#884` (`0 < x && 1 > 0`), `#904` (`bad < obj.two`), `#1020` (`new Map<…>` with no parens), `#855` (`<` with a `/* comment */` inside the args), `#1027` (nested `>>` closes two arg-lists, not a shift), `#994` (default type-arg *value* is colored), `#995` (paren-wrapped `as keyof typeof`), `#992` (a type *named* `type`).

**Multiline / whitespace-fragile generics, types, unions** — structure, not column position, decides; a later construct never "breaks":
`#1002`, `#1014`, `#1019`, `#1028`, `#1035`, `#1040`, `#1041`, `#1043`, `#1051`, `#1053`, `#1056`, `#1059`, `#819`, `#876`, `#889`, `#890`, `#894`, `#896`, `#911`, `#973`, `#981`, `#983`, `#873`.

**Member / call scoping, keywords-as-names, control flow:** `#736` (method call → `entity.name.function`), `#770` (call parens are punctuation), `#869` (`x in obj ? a : b` ternary), `#788` (optional chaining `?.`), `#1025` (`for…of`/`in` with no surrounding space), `#815` (a method *named* `new`), `#881` (`override` modifier), `#1066` (triple-slash `/// <reference>` directive), `#891` (`from` as an ordinary identifier/binding is a *variable*, not a keyword — see [the contextual-keyword fix](#-backlog--our-domain-not-yet-solved-6)).

> Each maps to one or more cases in `test/test-issues.ts`; grep the issue number there for the exact input + expected scopes.

---

## Classifying an unsolved issue

When an issue is **not** solved, it gets exactly one verdict, and **⛔ TM-impossible requires evidence** — you may not assert it from intuition:

1. **🔧 Backlog** — reproduce it; if a parser-derived TM pattern *can* express the fix, it's backlog. Fix it in `examples/typescript.ts`, add a case to `test/test-issues.ts`, move it to Solved.
2. **📦 Out of scope** — the construct belongs to a dialect/region we don't generate yet (TSX, JSDoc body).
3. **🧠 Needs semantics** — the correct scope depends on resolving a symbol's *kind* (type/value/namespace) or type relationships. See [Proof A](#proof-a). Out of scope for every grammar, ours included.
4. **⛔ TM-impossible** — *only* when you can show **(i)** our own generated `tmLanguage.json` cannot express it (a concrete failing pattern) **and (ii)** our tree-sitter or Lezer target (real parsers) *does* get it right. See [Proof B](#proof-b). File the failing-TM + passing-parser pair as the proof. **Currently 0 issues have cleared this bar.**

---

## 🔧 Backlog — our domain, not yet solved (≈6)

TM-expressible parse/lex disambiguation in Monogram's wheelhouse, still open after the verification pass (11 candidates that *were* here are now confirmed-correct and in Solved, including #891):

- `#1071` `import.meta.dirname` — **contested:** we scope `import` as `keyword.control.import` (defensible — it *is* the import meta-property keyword) and `meta`/`dirname` as properties, with no breakage; the reporter wants `import` non-keyworded. Left until the intended scope is settled.
- `#1048` multiline `extends` in a generic with split parens; `#857` multiple `export default` overloads; `#497` `import` declaration / semicolon scoping; `#810` trailing newline scope in a line comment; `#1039` `String.raw` escape-token visibility.

**Contextual keywords (the `#891` class).** A word that is a keyword in some positions but a valid identifier elsewhere (`from`, `as`, `of`, …) was mis-scoped as a keyword *everywhere* by the flat global keyword match. **Fixed** for the always-before-a-fixed-token case: a scope-keyword the grammar *always* places immediately before the string token (only `from`: `'from' String_`) is emitted with a `(?=\s*["'])` lookahead, so `const from = 1` / `from()` / the `import from from "x"` binding scope as `variable`/`entity.name.function` (matching official) while the import-source `from` stays a keyword.

**FIXED — `as`/`keyof`/`is`/`infer`/`satisfies`/`asserts` (the contextual-operator class).** These are keywords in operator/type position but valid identifiers elsewhere (`const as = 1`); the flat keyword match over-scoped the identifier uses. Unlike `from` (one mechanism), these were scoped by **four at once** — the flat keyword group, the per-keyword `keyword.operator.expression.as` begin rule, the `type-inner` injection, and the structural type rules — which is why a first naive attempt (de-keywording only the flat group) failed: it didn't fix `const as` AND regressed `keyof`/`is`/`infer` in type position to `entity.name.type`. The landed fix reconciles all four: the keyword.operator.expression group is split into reserved operators (`typeof`/`new`/`void`/`delete`/`instanceof` — unconditional) vs contextual operators (a positional guard `(?=\s+OPERAND|\s*$)` — keyword iff followed by whitespace+an operand, or at EOL for multiline casts), the per-keyword begin rules get the same guard, and type-inner re-injects both so type-position uses keep keyword scope. The contextual set is derived agnostically from the grammar's `not(...)` reserved guards (no hardcoded words). Now `const as/keyof/is = 1` → `variable`, `x as T`/`as (A|B)`/`import * as ns`/`keyof T`/`p is T`/`infer U` → keyword — matching official. `of` as an identifier (`const of = 1`) — **the official grammar mis-scopes it too**, so a both-wrong case, not a gap.

> Action: run each through `test/test-issues.ts` to confirm before claiming. Listing here ≠ "breaks in Monogram" — it means "not yet correct-and-tested."

## 📦 Out of current scope

**TSX dialect (8)** — Monogram's grammar is TypeScript, not TSX. TSX layers the JSX dialect on top; a TSX grammar is future work using the same approach. Notably several are *generic-default-in-TSX* (`#1042`, `#990`, `#967`, `#979`, `#1033`) — the TS-side disambiguation Monogram already does; only the TSX wrapper is missing. Also `#1047` (Vue), `#908`, `#627`.

**JSDoc embedded content (16)** — JSDoc is an `embed` region. Monogram marks it (`embed: 'jsdoc'` → TextMate `contentName`) but does not yet *generate* a JSDoc sub-grammar, so JSDoc-body highlighting is unsolved until the embedded-grammar pipeline (the ["Embedded languages" design goal](../README.md#embedded-languages)) is built. This is a *scope* gap, not a TM limitation — JSDoc highlighting is perfectly expressible in TM. Issues: `#1049 #1046 #1037 #1031 #1029 #1023 #993 #986 #965 #910 #877 #860 #856 #799 #693` (and JSDoc-flavored `#900`).

## 🧠 Needs semantics — no syntax highlighter can do these

Resolving these requires knowing a symbol's declared kind or type — see [Proof A](#proof-a). VS Code already covers them via the **semantic-token provider** (the TS language server), which is the correct layer; a grammar (TM *or* parser) is the wrong tool. `#939` (distinguish `import` *types* from values), `#645` (color `UPPER_CASED` as constant — a convention, not syntax), `#1038` (Symbol suggestion), parts of `#997`/`#879` (which scope a name *should* get).

## 🛠 Not a grammar concern (≈20)

Theming / token-color config (`#1064`, `#991`), scope-name data & spelling fixes (`#1034`, `#1031`, `#799`, `#879`, `#630`), and tooling / meta / IDE-support (`#1045` package-lock, `#742`, `#714`, `#462` Emacs, `#256` TextMate 2, `#693` example-body embedding, `#781` HTML comments, `#915` unicode identifiers, `#950`/`#988`/`#989`/`#1003`/`#1052`/`#691` "this file breaks" reports needing triage). Several "Other" reports are unreduced repros — they move to Backlog or Needs-semantics once minimized.

---

## The impossibility proofs

### Proof A
**A purely syntactic highlighter — TextMate grammar *or* CST parser — cannot resolve a symbol's *kind*.** Both see only the token stream, never the resolved program. Whether `Foo` in `Foo.Bar` is a namespace or a class, whether an `import` binds a type or a value, whether `MAX` is a constant — all require name resolution / type-checking against declarations that may be in another file. Monogram's parser is a *concrete syntax tree* builder; it has no symbol table either. So semantic-coloring issues are unsolvable by **every** layer here — the job belongs to a semantic-token provider (language server). This is *not* a TextMate-specific weakness; it is the boundary of syntax highlighting itself. (Monogram's win is making the *syntactic* layer exact, so only the genuinely-semantic residue is left for the server.)

### Proof B
**A TextMate grammar is a line-oriented pushdown machine whose only inter-line memory is a finite stack of scope contexts**; each step is a single Oniguruma match (bounded even with `\g<>` subexpression recursion, which is per-line). Where correct highlighting requires context *not* captured by the enclosing-scope stack — an unbounded lookback to a token that is not an ancestor context — no TextMate grammar can express it, the official one or ours. Monogram's **tree-sitter and Lezer** targets are real incremental parsers holding the full tree, so they resolve such cases exactly; the generated TM target (like the official) can only approximate.

> **But beware over-claiming this.** The 50 solved cases include heavy multiline / whitespace / nested-generic scenarios long *assumed* "impossible for TextMate" — they are not; they are TM-*expressible* once a parser tells you the right pattern. So this bucket is narrow, and we keep it empty until an issue is *proven* into it (failing generated-TM + passing parser-target). Don't reach for "TM can't" when the honest answer is "we haven't derived the pattern yet."

---

## Maintenance protocol

- **Refresh the universe:** `gh issue list --repo microsoft/TypeScript-TmLanguage --state open --limit 300 --json number,title`.
- **Solved set is the source of truth:** the issue numbers in `test/test-issues.ts` (`grep -oE '#[0-9]+' test/test-issues.ts | sort -u`). Solving an issue = add its repro case there (it must pass against the *generated* `tmLanguage.json`), then move it to [Solved](#-solved-39).
- **Every unsolved issue carries one verdict** from [the discipline](#classifying-an-unsolved-issue). "⛔ TM-impossible" is the only verdict that needs attached evidence.
- Counts above are a point-in-time snapshot; re-run the cross-reference (solved ∩ open) when updating.
