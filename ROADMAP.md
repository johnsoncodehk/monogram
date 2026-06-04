# Monogram — Roadmap

## Generation targets (one grammar → every ecosystem)

All emitted by `node src/cli.ts <grammar>.ts` (e.g. `typescript.ts`). Every highlighter is derived from one structural inference (`gen-tm` and the tree-sitter / Monarch generators), retargeted per format.

| Target | Artifact | Status |
|---|---|---|
| Lexer | `createLexer` → tokens | ✅ |
| CST parser | `createParser` → CST | ✅ aligned to the official parser — see the **Parser** column (agree · covered) in the README Status table |
| TextMate | `.tmLanguage.json` | ✅ matches or **beats the official grammar on all 7 measured languages** — see the README **Highlighter** table (the [vscode#203212](https://github.com/microsoft/vscode/issues/203212) comparison) |
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

- **More vscode#203212 bundles** — low-effort first (ini, diff, git config, xml); the large ones (ruby, perl, c/c++, groovy) each need an instrumentable official parser (WASM / native-coverage) + a corpus.
- **Field labels** in the grammar DSL → richer named-field AST types.
- **Highlighter long tail** — the few remaining per-language divergences are documented (in the PR) as either the shared TextMate-vs-parser ceiling or proven architectural floors; where a construct provably exceeds the TextMate model, the derived **tree-sitter** target (a real whole-tree parser) resolves it.
