# Highlighter back ends

A highlighter back end turns one grammar into the files an editor's highlighting engine loads:

| back end | engine | files |
|---|---|---|
| `textmate` | TextMate (vscode-textmate, Oniguruma) | `<name>.tmLanguage.json`, plus markup injections, alias grammars and the `contributes` snippet when the grammar declares them |
| `monarch` | Monaco's Monarch (JavaScript RegExp) | `<name>.monarch.json` |
| `treesitter-highlights` | tree-sitter queries | `tree-sitter/<name>/queries/highlights.scm` |

Each one registers with `defineHighlighter` (src/editor/define-highlighter.ts; the three are in
src/editor/highlighters.ts), and `src/cli.ts` writes what every registered back end renders.

## How it differs from a parser target

A parser target (`defineParserTarget`, src/targets/define-parser-target.ts, docs/TARGETS.md) prints one PARSER:
it is handed the shared algorithm families already printed in its language and adds its own
spelling, so every target runs the same algorithm. A highlighter has no parser to print. Its
engine sees only text, line by line, and has its own means of keeping context: lookbehind and
begin / end regions in TextMate, a state stack in Monarch, the syntax tree in tree-sitter. What the
back ends share is what is KNOWN about the grammar, not an algorithm:

- `facts`: `highlightFacts(grammar)` (src/editor/highlight-facts.ts: every detector's answer, computed
  once per grammar, for example the member-access texts, the declaration keywords, the follower
  sets of the keywords) and the role / classifier tables (src/editor/highlight-roles.ts);
- `ir`: the shared context IR, for the constructs moved into it (none yet; type context is the
  first). It holds facts and context boundaries, never a lowered pattern;
- `capabilities`: what the engine can express (lookbehind, how a region ends, `while`, recursion,
  captures, embedding, a state stack, Unicode classes, tree queries). A back end declares its
  engine's and never fakes one;
- `refusals`: the constructs a back end declines, each with its reason. A refusal is recorded (the
  CLI prints it, the agreement record lists it), never a silent omission. The IR does not shrink
  to what every engine can do.

The check that the back ends tell the same story is the agreement record
(`node test/monarch-dialect.ts --agreement`, test/textmate-monarch-agreement.json): TextMate's and
Monarch's tokens over the same real code, every disagreement counted by class, each class with who
is wrong by the grammar.
