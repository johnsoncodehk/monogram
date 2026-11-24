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

## Operator levels beyond binary and unary

Two declarations let one expression rule carry a ladder whose levels are not all reachable from
every operand position (Python's, [`python.ts`](../python.ts); fixture
[`test/fixtures/cappedcalc.ts`](../test/fixtures/cappedcalc.ts)):

- `cappedPrefix(...ops)` in a precedence level declares prefix operators capped at that level.
  Such an operator begins an operand only where an operator of its level or a looser one could
  stand. A plain `prefix(...)` binds at any operand position (`2 ** -1`), which suits a tight unary
  and is wrong for a loose one:

  ```ts
  prec: [left('or'), left('and'), right(cappedPrefix('not')), left('==', '<'), left('+'), right(prefix('-'))],
  // a and not b, not a == b (= not (a == b)): parse.   a == not b, -not a: no parse.
  ```

  Its node is the sequence `op operand` with the operator as a literal leaf, so the operand-shape
  checks (`lhsAssignTarget`, `noUnaryLhs`) do not treat it as a unary.
- `atLevel(op, Rule)` reads the expression rule `Rule` at `op`'s level: only that level's operators
  and tighter ones continue it, as they would continue an operand of `op`. It is how a context
  that a reference grammar writes with a lower level's rule is written against one ladder:

  ```ts
  const StarExpression = rule(() => [['*', atLevel('|', Expression)], Expression]);
  // *a | b: parses.   *a == b: no parse (a starred operand is a bitwise-or).
  ```

  The body must be a reference to a Pratt rule; anything else is refused by name.

## Contexts: `when`

A grammar's productions can depend on where they stand: ECMAScript's `[Yield]` and `[Await]`
parameters make `yield` and `await` operators inside a generator / async body and identifiers
elsewhere. The context is one word the parser holds; the markers `awaitCtx` / `yieldCtx` /
`asyncGenCtx` / `resetCtx` set it for a body (a function's, an arrow's, a method's: an arrow's
body does not inherit the context unless the arrow is async), and `when(cond, ...items)` makes
the items exist only where the condition holds:

```ts
arm('yield_', capExpr('?', when('+yield', 'yield', alt(arm('star', sameLine, '*', $), arm('expr', opt(sameLine, $)))))),
right(prefix('!', '~', '+', '-', 'typeof', 'void', 'delete', when('~syncFn', 'await'))),   // a gated operator
// function* g() { yield a; }: a YieldExpression.   iter = yield();: a call of the identifier yield.
```

A condition is a conjunction of `+p` / `~p` over the parameters of
[`src/grammar-utils.ts`](../src/grammar-utils.ts) `CTX_PARAMS` (`await`, `yield`, `syncFn`); with
no items, `when(cond)` is a zero-width test. tree-sitter, TextMate and Monarch erase the
condition: they render the items everywhere.

Every engine holds the context as ONE word (step 2): the interpreter, the jsTarget parser and the
portable parsers set it at a context marker for the marker's body and put it back after, and read
it at a `when`, a gated operator and the reserved-word guard (`reservableNot`, whose context words
are `CTX_WORDS`). A rule's parse is a function of its position and of the word masked by the bits
the rule can read (`ctxObserves`, computed once from the grammar: a `when`, a gated operator or the
guard reachable from the rule without a marker in between); that pair is the key of the
interpreter's and jsTarget's packrat memo, and jsTarget's incremental rows carry the masked word
(`rowCtx`) beside the rule, compared by every reuse check. Rules are the grammar's own (no copies
per context).

**Transition** (declared contexts; step 2 of the design landed): the end state is named boolean
parameters declared by the grammar, set / cleared at a reference (`ctx({p: true}, ...)`), read by
`when`, held as the one word in every engine. Reached: the one word in every engine (the rule fork
is deleted). Owed, each with its step: `in` as a parameter, which needs the set / clear equations
(`ctx(...)` replacing the four markers, which today set the whole word) and deletes `exclude` and
the suppress machinery (step 3); the guard's context words written as `when` items inside it,
deleting `reservableNot` and `CTX_WORDS` (step 3, with `ctx(...)`); TypeScript's contexts (step 4);
the script / module goals: `syncFn` stands in for them (set in a non-async function body, so the
top level reads `await` both ways and `await(x)` at the top level is still the operator); the goals
step sets `await` in the Module goal's entry word, the gate becomes `when('+await')` and `syncFn` is
deleted (step 5); `??` mixing is not a context (a form, step 6).

## Declared assignment-target contexts

`lhsAssignTarget` checks only the outermost shape of an operand (no prefix or postfix operator, no binary
node). A language whose targets are DESTRUCTURING patterns, such as ECMAScript's `[a, ...b] = x` or
Python's `a, *b = x` and `del a, b.c`, declares what may stand there instead. Each target context
names arms by their stable names (see `arm`):

```ts
assignTargets: {
  pattern: {
    leaves: ['ident', 'member', 'paren', 'shorthand'],   // arms that are a target as they are
    containers: { array: 'all', object: 'all', init: 'value', '=': 'left' },   // arms whose children must be targets
    last: ['spread'],   // arms that pass only as a container's final child, with no ',' after it
  },
},
```

A node passes a context when its arm is a leaf, or a container whose children at the named child
(`'all'`: every rule child; a binary operator's text with `'left'`: its left operand) all pass. A
node whose arm is one rule reference and nothing else (a unit arm that belongs to no context)
passes when its child passes. Two markers read a context:

- `assignTarget('ctx')` after a rule reference in a sequence matches nothing and holds when the node just
  before it passes: `[Exprs, assignTarget('star'), '=', Exprs]`. The head is parsed once, as an
  expression, and checked only where the `=` tail is taken. Literals may stand between the two, and
  the target may open an `opt` or a branch of an alternation whose branches all begin with
  different literals, reading the rule reference before it: Python's statement head is one arm,
  `[StarExpressions, opt(alt(['=', assignTarget('star'), …], [AugAssign, assignTarget('single'), …], …))]`.
  Anywhere else (after a repetition, an `opt`, a token) the generator refuses it: what the target
  reads must be one rule's node, with no other rule run between.
- `assignTargetOps('ctx', ...ops)` in a precedence level: the left operand of these infix operators must
  pass the context (ECMAScript's `=` takes a pattern; `+=` keeps `lhsAssignTarget`).

A grammar declares at most three contexts. The portable engine computes the check as part of the
form every Pratt call already returns, so a grammar without `assignTargets` emits the same parser as
before.

A context may instead be computed ON DEMAND (`when: 'demand'`), for a language where the question
is rare (ECMAScript's `=` meets an array or object literal a few times in thousands): the normal
parse computes nothing, and an array or object literal on the left of the `assignTargetOps` operator is
parsed again by its accumulating twin, from its first token to the operator (the shared
`reparseFrom`, `src/reparse-family.ts`). Its leaves must be exactly the arms the shallow check
takes (the generator names any arm that breaks this); it must be the grammar's only context, no
`assignTarget(...)` marker may read it, and a `last` arm must be a container. A nested container is
parsed again by its own twin, so each token is parsed at most once more per enclosing container.
Fixture: [`test/fixtures/patterndemand.ts`](../test/fixtures/patterndemand.ts) (the same rows as
its eager twin). The retiring jsTarget keeps the shallow check for such a grammar. The interpreter checks the same thing by walking its tree. Fixtures:
[`test/fixtures/patterncalc.ts`](../test/fixtures/patterncalc.ts) (an ECMAScript-style pattern)
and [`test/fixtures/startargets.ts`](../test/fixtures/startargets.ts) (Python's star, single and
del targets). Three things refuse a grammar that declares contexts, by name: total parsing (`{
recovery: true }`), the typed-AST shape forms and the retiring jsTarget emitter (which takes an
on-demand context as the shallow check, below; the Rust typed-AST form likewise, for now).

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
