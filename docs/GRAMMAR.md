# Writing a grammar

A grammar is a TypeScript module built from the combinators of [`src/api.ts`](../src/api.ts):
tokens, operator precedence, and rules. Everything language-specific lives in it; the engine
knows no language. The README has a minimal example; this file has the rules a grammar
author needs.

## Token patterns are combinators

Token patterns are **combinators, not regular expressions**: `seq` / `oneOf` / `range` /
`noneOf` / `plus` / `star` / `altPattern` / `optPattern` / … assemble a structured pattern IR.
Regex is a *derived* backend, not the source of truth. A bare `RegExp` is not a valid token
pattern: `token(/…/)` is a `TS2345` type error.

| RegExp | Combinator |
|---|---|
| `/[ \t]+/` | `plus(oneOf(' ', '\t'))` |
| `/[A-Z_][A-Z0-9_]*/` | `seq(oneOf(range('A', 'Z'), '_'), star(oneOf(range('A', 'Z'), range('0', '9'), '_')))` |
| `/"[^"]*"/` | `seq('"', star(noneOf('"')), '"')` |
| `/\d+(\.\d+)?/` | `seq(plus(digit), optPattern(seq('.', plus(digit))))` |

`digit` above is `range('0', '9')`: patterns are plain values you name and reuse.

## Language facts are declared per token

Keywords, which token is the identifier, template-literal delimiters and the regex-versus-division
lexer ambiguity are declared on the tokens:

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

The template token says how a template is tokenized. Which rule parses its `${…}` holes is
declared where the token is *referenced*, because one token can serve two productions: a bare
reference takes the grammar's `expression` rule, and `withHoles(Template, rule)` names another
(TypeScript's template-literal type writes `withHoles(Template, $)` inside `Type`). A template
reference with neither is a `defineGrammar` error; no engine guesses the rule from where the
reference was reached ([`test/template-holes.ts`](../test/template-holes.ts)).

## Element regions

A token-stream grammar can contain markup elements whose children are text (JSX) or code. The
grammar declares the region as data, `elements` (`ElementRegion` in [`src/types.ts`](../src/types.ts)).
The design, its frame encoding, its relex rules and what is planned are in
[`docs/REGIONS.md`](REGIONS.md). [`javascriptreact.ts`](../javascriptreact.ts) declares JSX's in `withJsx`:

```ts
elements: {
  tagOpen: '<', tagClose: '>', closeMarker: '/',
  text: 'JSXText',            // token(plus(noneOf('{', '<', '>', '}'))): its pattern is the text scan
  closeTag: 'JSXClose',       // `</`, lexed only in children
  selfClose: 'JSXSelfClose',  // `/>`, lexed only in a tag
  hole: { open: '{', close: '}' },
  typeParameters: { head: /* `<T,` `<T =` `<T extends U` */, signature: { open: '(', close: ')', then: ['=>', ':'] } },
}
```

How code enters an element is derived from the grammar (`tagOpenOnlyOpensTags` in
[`src/grammar-analysis.ts`](../src/grammar-analysis.ts)). When the grammar uses `tagOpen` only to
open tags (every `<` begins an element arm, no operator or other token begins with it), every
`tagOpen` in code opens an element. JSX's `<` is also a comparison, so there a `tagOpen` opens an
element only where a regex literal could start (the `regexContext` decision).
In a tag the ordinary tokens are lexed; after an open tag the children are one text token per
run (or, with no `text` token, code), holes, and nested elements; `</` and `/>` are tokens only
there ([`test/fixtures/elementdialect.ts`](../test/fixtures/elementdialect.ts) has code children). Element frames share the
template literal's hole stack, so an incremental re-lex restarts outside every element as it
restarts outside every template. `typeParameters` is TypeScript's: a `<` at an operand position
that begins a type-parameter list (tsc's own JSX lookahead for `<T,` / `<T extends U`, and a
`<T>(…)` signature, which the lexer decides by lexing the group and keeping or discarding it).
A grammar that declares no `typeParameters` gets no such rewind.

A template dialect whose text may contain a bare `<` declares `tagStart`, the one-character class
a `<` must be followed by to open a tag (`<p>1 < 2</p>` is then text); a raw-text declaration can
carry `unlessBodyStarts`, a pattern under which the body is ordinary children instead (a
`<style>` whose body starts with `{` holds an expression). [`test/fixtures/textdialect.ts`](../test/fixtures/textdialect.ts)
declares both, with `textTokens` (comments in text: tokens tried before the text run, `//` only
after a blank) and directives in its children (`@if (…) { … } @else { … }`), which need no
declaration: their openers, heads, bodies and continuations are derived from the rules, and an arm
the lexer could not find in text is refused by name at load. [`test/text-dialect.ts`](../test/text-dialect.ts) has its rows.

### What a lexer-local region cannot decide

tsc's scanner is driven by its parser: the parser knows whether a `<` is in a type or an
expression, and rescans children as text. Monogram's lexer runs before the parser and is a
pure function of the text, so the region is entered from what the lexer sees. That is an
approximation of a decision that belongs to the parser, and it differs from tsc on exactly
these shapes. Each is an expected-fail row in [`test/tsx-conformance.ts`](../test/tsx-conformance.ts)
whose cause is "needs parser context"; they are not to be shaved with more lexer heuristics:

| Shape | Witness | Lexer reads | tsc reads |
|---|---|---|---|
| an attribute-less element whose text starts with `( … ):` | `<li>(1): one</li>` | a type-parameter signature | text |
| a call signature with type parameters and no return type | `interface I { <T>(x: T); }` | an element | a signature |
| a comment inside a type-parameter head | `<T /* c */,>(x: T) => x` | an element | type parameters |
| an element right after a statement that ASI ends on a value | `import a from "b"`⏎`<h>it's</h>;` | a comparison (as for `/re/` there) | an element |

(A backslash in an attribute string, once a fifth row, needed a tag-only string token, not
parser context: `tagTokens` fixed it.) [`docs/REGIONS.md`](REGIONS.md) has the counts over the
reachable real TSX and the cases planned regions add.

[`test/agnostic.ts`](../test/agnostic.ts) parses a toy grammar whose identifier token is
`Word`, with no templates or regex, on the same engine. [`html.ts`](../html.ts) is markup and
shares no token with TypeScript.

## How a rule chooses

A rule chooses among its alternatives by **longest match**: every alternative is a candidate,
the one that consumes the most input wins, and the earliest-declared one wins a tie. This holds
in the interpreter, the emitted JS parser and the portable TypeScript/Go/Rust parsers alike, so
the order of a rule's alternatives decides only ties.

For an expression rule that holds for the forms an expression can *start* with (atoms,
bracketed forms, the prefix-operator arm, arrow-like capped forms). Its continuations
(`[$, '.', Ident]`, `[$, '(', …, ')']`) are tried in declaration order, before the operators,
and the first that matches is taken. An inline `alt(...)` inside an alternative is ordered
choice too: the first branch that matches.

## No nullable rule except the entry

`defineGrammar` rejects a rule other than the entry that can match the **empty string**
([`test/nullable-rules.ts`](../test/nullable-rules.ts)). A rule never succeeds with an empty
match (an empty alternative cannot win longest-match), so a nullable rule's empty case would be
unreachable and a reference to it would fail silently wherever it should match nothing.

Write the repetition inline at the use site (`[many(NL), Stmt]`, not `[Filler, Stmt]` with
`Filler = rule(() => [[many(NL)]])`), or make the rule non-empty and wrap references in
`opt(...)` (YAML's empty node in `key:` is `opt(Node)` at the use site, not a nullable `Node`).

## Diagnostic labels

The total parser's `expected …` messages name the missing token or rule by its grammar name
(`expected 'Number'`, `expected Expr`). When a grammar name is an internal identifier rather
than a word an end user should read, give it a display label: `token(pattern, { label: 'a number' })`
/ `rule(fn, { label: 'an expression' })` render `expected a number` / `expected an expression`.
Labels change message text only: leaf `tokenType`s, `ruleNameOf`, the CST and every derived
artifact keep the grammar name, so adding labels parses byte-identically
([`test/diagnostic-labels.ts`](../test/diagnostic-labels.ts)).

## What the highlighter infers, and what you declare

The highlighter reads the same rule **shapes** the parser uses and infers most scopes
structurally, with no per-rule annotation:

- `foo(x)`: `foo` is `entity.name.function` (from the `$ '(' …` call form)
- `obj.name`: `name` is `entity.other.property` (from the `$ '.' Ident` form)
- `'class' Ident`: `Ident` is `entity.name.type` (from declaration structure)
- `Expr '<' Type '>' '('`: a generic call, not a comparison (from rule structure)

Flat facts (which keywords are control flow, which punctuation is an operator) are declared
once in a `scopes` map (`jsScopes` in [`javascript.ts`](../javascript.ts), which
[`typescript.ts`](../typescript.ts) extends). TextMate *scopes* are the dot-separated labels
(`entity.name.function`, `keyword.control`) that a theme maps to colours.

## Keywords as names in the tree-sitter grammar

`treeSitterContextualNames` (`'all'` or a list) says which keywords the generated tree-sitter grammar also reads as a name where the grammar allows one (`get` as a property key, `out` as a parameter). Each one trades parse-table size (parser.c) against ERRORs on valid code that uses that keyword as a name; a keyword left out is the keyword wherever it is valid. The shipped lists were chosen on real code: JavaScript takes every keyword (about 3 MB in all); TypeScript takes the words whose name use was the first ERROR of real files (lib .d.ts files and this repository), with each word's measured cost in the comment beside the list.

## Dialects

A dialect (`.tsx`/`.jsx`, or a markup dialect on [`html.ts`](../html.ts)) reuses a base
grammar's rules by name: [`typescriptreact.ts`](../typescriptreact.ts) is 13 lines.
TypeScript's grammar imports JavaScript's vocabulary (tokens, reserved-word guards, precedence,
scope map) and adds the type layer; the dependency runs subset to superset only.
