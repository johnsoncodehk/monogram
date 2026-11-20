# Monogram — Roadmap

## Generation targets (one grammar → every ecosystem)

All emitted by `node src/cli.ts <grammar>.ts` (e.g. `typescript.ts`). Every highlighter is derived from one structural inference (`gen-tm` and the tree-sitter / Monarch generators), retargeted per format.

| Target | Artifact | Status |
|---|---|---|
| Lexer | generated lexer (`emit-lexer.ts`) → tokens | ✅ |
| CST parser | `createParser` → CST | ✅ aligned to the official parser — see the **Parser** column (agree · covered) in the README Status table |
| TextMate | `.tmLanguage.json` | ✅ measured against the official grammar on all 6 languages — see the README **Highlighter** table (the [vscode#203212](https://github.com/microsoft/vscode/issues/203212) comparison) |
| VS Code language-config | `.language-configuration.json` | ✅ comments / brackets / folding derived from the same tokens |
| tree-sitter | `grammar.js` + `queries/highlights.scm` + external scanner | ✅ derived highlighter **95.9%** token-family accuracy vs a neutral `tsc` oracle (beats official tree-sitter 92.7%); CI-gated, builds to wasm |
| Monarch | Monaco tokenizer JSON | 🟡 first pass — bounded by JS-regex limits |
| CST node types | TS discriminated union | 🟡 structural — named-field accessors need grammar field labels |

**Lezer was dropped** — Monogram's non-deterministic (backtracking) grammar can't be mechanically derived into Lezer's build-time LR(1) automaton (combinatorial table blowup + unresolvable `<`-ambiguity conflicts); tree-sitter's runtime GLR absorbs it instead.

## How quality is measured

Three parser-grounded layers (in `test/`), each comparing against the language's **official parser** as a neutral oracle. Current numbers live in the README Status table:

- **`src-coverage`** — Monogram's parser vs the official parser (per-file verdict agreement, weighted by source-coverage of the official parser, with the blind-spot reported as `covered`). The first proof: a derived highlighter can only be as correct as the parser it comes from.
- **`scope-gap`** — both TextMate grammars (official + Monogram) graded against the parser's token roles (`test/scope-roles.ts`, the frozen neutral answer key). The vscode#203212 money metric.
- **`issue-table`** — per-issue, Monogram vs official.

## What's next

- **Parser-acceptance long tail vs tsc** (measured by `test/recovery-conformance.ts` over the 355 single-file conformance tests tsc's parser rejects: recall 86.65%, precision 67.83%, first-error agreement 303/355, and 4 files we parse-accept that tsc's parser rejects; an accept/reject flip-scan over the same corpus also finds 12 files tsc's parser accepts that we reject). The `[Await]`/`[Yield]` files and the per-shape strictness classes listed here before (`public @dec method`, `const #foo`, `001`, `class C { var x }`, `new C0 32`, template-literal module names, `extends void`, `super<T>` tagged templates) no longer appear. What remains, by direction:
  - **We accept, tsc's parser rejects** (4 files, one each): `obj?.#field`, the README's documented divergence (`privateIdentifierChain.1.ts`); `await` at a module's top level, which we parse as an identifier — `await (1,)`, `await <number, string>(1)`, `class C extends await<string>` (`topLevelAwaitErrors.1.ts`); `import rect = module("rect")`, whose right side we parse as a call (`parser519458.ts`); and `x⏎++⏎++⏎y`, where we attach the `++` after the line break to `x` as a postfix (`parserS7.9_A5.7_T1.ts`).
  - **tsc's parser accepts, we reject** (12 files): `using {a} = null` / `await using {a} = null`, the README's documented divergence (2); `new` applied directly to a template literal, `` new `abc${0}abc`(…) `` (4; acorn accepts it too); a type predicate outside a return type — a property `isFSO: this is FileSystemObject`, a variable `var x: this is string`, a setter parameter `set p1(x: this is string)` (4); a method named `static` after an accessibility modifier, `public static() {}` (1); and `private` on a type-literal member, `var x: { private y: string }` (1; the same modifier on an interface member parses).
- **More vscode#203212 bundles** — low-effort first (ini, diff, git config, xml); the large ones (ruby, perl, c/c++, groovy) each need an instrumentable official parser (WASM / native-coverage) + a corpus.
- **Incremental lex for stateful grammars** — token-stream grammars already re-lex only a local window around an edit, but indent / markup / newline grammars still re-lex from the file head on every edit, because their lexer carries cross-line state (indent stack, flow depth, markup mode) that no token records. Planned: incremental lex for those modes too.
- **Field labels** in the grammar DSL → richer named-field AST types.
- **Highlighter long tail** — the few remaining per-language divergences are documented (in the PR) as either the shared TextMate-vs-parser ceiling or proven architectural floors; where a construct provably exceeds the TextMate model, the derived **tree-sitter** target (a real whole-tree parser) resolves it.
