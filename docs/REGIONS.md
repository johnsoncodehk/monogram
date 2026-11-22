# Lexer regions

A **lexer region** is a part of a token-stream file that the lexer reads differently: the
children of a JSX element, the body of a `<style>` element, a directive's body in a template
dialect. A grammar declares its regions as data; the lexer runs them as STATES on one frame
stack, and stays a pure function of the text. This is the one current design (roadmap item 2):
what is built, the model it is built toward, and what the portable lexers and the editor
generators need from it. [`docs/GRAMMAR.md`](GRAMMAR.md) has the grammar author's view.

## Status

Built (the interpreter's lexer, `src/emit-lexer.ts`, which the emitted JS parser shares):
- **Element regions** (`ElementRegion`, grammar field `elements`, `src/types.ts`): elements entered
  from code, with text or code children, holes, close / self-close tokens that exist only inside
  an element, and TypeScript's type-parameter vetoes. JSX / TSX declare one (`withJsx` in
  `javascriptreact.ts`); so does the dialect fixture `test/fixtures/elementdialect.ts`.
- **Tag tokens** (`tagTokens`): tokens lexed only inside a tag (JSX's attribute string, no escapes).
- **Code children**: without a `text` token, children are lexed by the ordinary scan.
- **Derived entry**: how code enters a region is a fact of the grammar
  (`tagOpenOnlyOpensTags`, `src/grammar-analysis.ts`).
- **Raw text** (`rawText`): an element whose tag name is declared raw has its whole body as ONE
  token, in a raw frame; the dialect fixture's `<style>`.
- A lex error inside an undecided type-parameter signature is the signature's rewind verdict in
  every lexing mode (strict and recovering), so both passes lex one stream.

Not built, in this order (each its own change with its gate):
1. **Text tokens, directive openers, tag start**: `textTokens` (tokens tried before the text run:
   comments in text, directive openers), directive openers derived from the grammar, `tagStart`
   (a text run stops at `tagOpen` only when a declared character follows). Proven on a second
   fixture shaped like a TSX template dialect: text children, directives, `{}` holes, raw
   `<style>` / `<script>`.
2. **Root region**: `html.ts` re-expressed as a file that starts inside a children frame that
   never pops, only if every `html.ts` artifact and `conformance/html` stay byte-identical;
   otherwise markup mode stays and the blocking difference is recorded here.

The portable lexers (TypeScript, Go, Rust) have no frames yet: `buildIR` refuses a grammar that
declares `elements`, loudly, as it refuses markup.

## The model: a region is a declared lexer state

One frame stack. A frame is a state; each state has a small ordered list of its own tokens tried
before the ordinary scan, an optional run token, the openers that push another state, and its
closer.

| state | run token | own tokens (tried first) | pushes | pops at |
|---|---|---|---|---|
| code hole (`{`, template `${`) | none: ordinary scan | none | element (entry rule), template, hole | its closer at brace count 0 |
| children | `text`, OPTIONAL: absent = children are code | `textTokens` (planned) | tag (at `tagOpen`, + `tagStart` planned), hole, directive (planned) | the close tag of the last open element |
| tag (open / close) | none: ordinary scan, no regex | `tagTokens` | hole, nested element after `=`, type-argument depth (TS) | `tagClose` / self-close |
| raw text | ONE raw token up to `tagOpen + closeMarker + name` | none | none | after the raw token (the close tag is lexed outside) |
| directive (planned; code) | ordinary scan | none | as a code hole | its body's closer at count 0, unless a continuation literal follows |
| root (planned; whole-file markup) | the children state | as children | as children | never |

Common to every state: a frame is pushed before its opener token and popped after its closer
token, the token kinds come from the grammar's token declarations, and no state is
reconstructed on relex. What is specific to a region is data: the run token and its stop test,
the tag-start class, the raw-text tag set and its case rule, the directive openers.

## Declaration

```ts
elements: {
  tagOpen: '<', tagClose: '>', closeMarker: '/',
  text?: 'JSXText',           // children text run: its pattern (a run of a character class) IS the scan.
                              //   ABSENT → the children are code
  closeTag: 'JSXClose',       // token TYPE of tagOpen+closeMarker, lexed only in children
  selfClose: 'JSXSelfClose',  // token TYPE of closeMarker+tagClose, lexed only in a tag
  hole: { open: '{', close: '}' },
  tagTokens?: ['JSXString'],  // token TYPES lexed only in a tag, tried before the ordinary scan there
  typeParameters?: { head, signature },  // a tagOpen at an operand position that begins type parameters
  rawText?: [{ tags: ['style'], token: 'StyleBody', ignoreCase?: true, embed?: { style: 'source.css' } }],
}
```

The region's own tokens (`text`, `closeTag`, `selfClose`, `tagTokens`, the `rawText` tokens) are not scan matchers
outside the region, so `</` and `/>` are tokens only where an element says so:
`a </* c */ b`, `new Map</* c */string, X>()`, `x = />/.test(s)` lex as tsc lexes them.

`rawText` is a list of declarations, each in the shape of `MarkupConfig.rawText` plus its own
`ignoreCase` (an evaluated dialect has a case-insensitive `<script>` and an exact-case `<style>`).
`embed` is highlighter data; the lexer does not read it. Planned fields: `textTokens`, `tagStart`.

## Frame encoding

The template-hole stack is the frame stack (`templateStack`, one number per frame; `tkDp[i]`
records its depth at each token, saturating at 255; only a zero is read). The low 2 bits are
the kind:
- 0, template hole: the brace count above (step 4 with `elements`; the plain count without);
- 1, element hole: the brace count above, step 4. Its closer at count 0 pops it; the closer
  token is pushed inside the frame;
- 2, element frame: the sub-state in bits 2-3 (0 children, 1 open tag, 2 close tag) and the
  open-element count above, step 16;
- 3, raw-text frame: holds exactly the raw body token (pushed after it, popped after the token).

An element entered from code pushes one element frame (`6`: kind 2, open tag). Nested
elements in its children share that frame through the count. An open tag's end adds one; a
close tag's or a self-close's end removes one; at none the frame pops, and the token that popped
it carries flag 16, so `prevIsValue` treats it as a value. In a tag the ordinary tokens are
lexed with no regex; `<` after the tag name counts type-argument depth (`<List<string>>`);
`<` after `=` opens a nested element; a hole opener pushes an element hole. In the children:
`tagOpen + closeMarker` is the close-tag token (sub-state close tag), another `tagOpen` opens a
nested tag, a hole opener pushes a hole, and then either one text token (with `text`) or the
ordinary scan (code children: whitespace, comments, strings and every other token as in code).

**Raw text.** The element frame keeps, per frame, the index of its current tag's `tagOpen` token
(the tag NAME is the token after it; markup's `curTag` is the same fact). When an OPEN tag ends
with `tagClose` (not a self-close) and its name is one of a `rawText` declaration's `tags` (in
any case when that declaration has `ignoreCase`), the lexer finds the first
`tagOpen + closeMarker + name` after the tag (case-insensitively under `ignoreCase`), pushes a
raw frame, pushes ONE token of the declaration's `token` over the body, and pops the frame. An
empty body is no token; with no close tag the body runs to the end of the file. The close tag
is then lexed in the children as any close tag. A dynamic tag (`<{x}>`) has no name token and is
never raw.

A grammar without `elements` gets the lexer it had before regions existed, byte for byte.

## Entry from code

How code enters an element is a fact of the grammar, computed once by
`tagOpenOnlyOpensTags(grammar, region)` (`src/grammar-analysis.ts`) and recorded by
`lexSpecOf` as `elementEntry: 'always'`. It is true when:
- every occurrence of the `tagOpen` literal in a rule is the first item of a sequence that also
  references the region's close-tag or self-close token (an element arm);
- no operator table lists it, and no `sep` uses it as its delimiter;
- no other literal, operator or scanned token can begin with it (`<=`, `<<`, a token whose
  pattern starts with `<`): the entry test runs before the ordinary scan, so such a token could
  never be lexed at a code position.

Then (`always`) every `tagOpen` in code, outside a tag, opens an element. Otherwise (the
`operand` entry) only a `tagOpen` where an operand may start opens one: `!prevIsValue()`, the
position where a regex literal may start, unless `typeParameters` says it begins a
type-parameter list. Declaring `typeParameters` on an `always` grammar is an error: a `tagOpen`
used only for tags cannot begin a type-parameter list.

| grammar | `tagOpenOnlyOpensTags` | why |
|---|---|---|
| JavaScript, TypeScript, JSX, TSX | false | `<` is a relational operator; in TS it also opens type arguments |
| `test/fixtures/elementdialect.ts` | true | `<` begins only element arms |
| a template dialect whose `<` is relational | false | it needs its own entry rule (below) |

`test/tag-open-entry.ts` checks each grammar and one near-miss per clause, and shows the lexer's
two behaviours on a toy where they differ (an element right after a value).

### TypeScript's vetoes (`typeParameters`)

- `head`: a character pattern tested right after the `<`: tsc's own JSX lookahead. `<T,`,
  `<T =`, `<const T,`, `<T extends U` begin type parameters; `extends=` / `extends>` /
  `extends/` are attributes.
- `signature`: type positions (`type F = <T>(x: T) => T`, `{ <T>(x: T): T }`, `new <T>() => T`).
  tsc knows it is in a type; a lexer cannot. For a head `<Name>(`, the lexer lexes the `( … )`
  group as code; if the token after `)` is one of `then` (`=>`, `:`) it keeps those tokens,
  otherwise, or on a lex error inside the group (in every lexing mode), it rewinds to an element.
  The rewind is bounded by one bracket group and is deterministic.

## What a lexer-local region cannot decide

tsc's scanner is driven by its parser: the parser knows whether a `<` is in a type or an
expression, and rescans children as text. Here the lexer runs before the parser and is a pure
function of the text, so the region is entered from what the lexer sees. In general form: these
are the shapes whose token stream depends on parser context. Each is an expected-fail row whose
cause is "needs parser context", not to be shaved with more lexer heuristics.

| shape | witness | lexer reads | tsc reads | row |
|---|---|---|---|---|
| an attribute-less element whose text starts with `( … ):` or `( … ) =>` | `<li>(1): one</li>` | a type-parameter signature | text | `tsx-conformance` |
| a call signature with type parameters and no return type | `interface I { <T>(x: T); }` | an element | a signature | `tsx-conformance` |
| a comment inside a type-parameter head | `<T /* c */,>(x: T) => x` | an element | type parameters | `tsx-conformance` |
| an element after a statement that ASI ends on a value (the `prevIsValue` class, as `/re/` there) | `import a from "b"`⏎`<h>it's</h>;` | a comparison | an element | `tsx-conformance` |
| (planned) an element on the line after a value, in a grammar whose `<` is also relational | `x`⏎`<b/>` | a comparison | the evaluated dialect: an element (its line-start rule) | the dialect fixture's gate |

Counts over the reachable real TSX (868 units: every `.tsx` file and `.tsx` / `.jsx`
`@filename` section of tsc's tests, the evaluated dialect's own sources; 1,410 JSX elements):
0, 0, 0 and 2 for the first four; the positive side of the signature rewind occurs 2 times. The
corpus is small: these counts show the shapes are rare in tsc's tests, not in code at large.
(The attribute-string backslash, once a fifth row, was a missing tag-only token, not parser
context; `tagTokens` fixed it.)

Not cases: code children and directive bodies (code frames); a directive opener in text that
the author meant as text (the evaluated dialect lexes it as a directive too, so a derived
opener test agrees with it).

**The principled alternative (not built).** The token stream would depend on parser context, as
in tsc. Here that is more than a mode switch: the packrat memo is keyed by token index, longest-
match candidates speculate over one stream, three targets lex in one batch before parsing, and
relex anchors assume one stream. The smallest version is a local lattice: where both readings of
a `<` are viable the lexer records both, rejoining at the first offset where the two frame
stacks are equal (frames are integers, so the test is cheap), and positions become lattice
nodes. The element reading of a type-position `<T>(x: T) => T` never rejoins, so it needs a bound.

## Relex

The rule is the template rule, unchanged: a window restarts at a token recorded at depth 0
(outside every frame) and resyncs only at depth 0 on both sides; the frame stack is never
reconstructed. A token whose lexing was decided by later text records one level deeper:
- every token inside an undecided type-parameter signature, and the token that decides it;
- every token inside the characters a type-parameter head veto read (the `<` it decided
  included).

Per state: a frame is pushed before its opener and popped after its closer, so the opener and
everything inside record depth > 0 and the token after the closer may record 0. Raw text:
the raw token is inside its frame, the close tag outside; the raw token's end is decided by the
text after it (the first close tag), and it lies inside its element frame, so it is never an
anchor. Root region (planned):
depth is counted excluding the root frame, so a markup file gets depth-0 anchors (the state
"root children, no open frame" is the default) and the "stateful grammar restarts at the file
head" rule goes away for markup once HTML runs on the model.

`test/incremental-grammars.ts` has the exhaustive frame class: every one-character insertion of
the characters that open, close or change a frame, and every deletion, at every offset of
documents with frames (templates, JSX text and holes, signatures, attribute strings, code
children with directives, dynamic tags and an element right after a value): edited ≡ fresh.

## What the portable lexers need

1. Frame kinds: template hole, element hole, element frame, and a raw frame (kind 3): one body
   token up to `tagOpen + closeMarker + name`, pushed inside the frame; the close tag is lexed
   after the pop. Per declaration: tag names, token kind, `ignoreCase`. Empty body = no token;
   no close tag = to the end of the file; only an open tag ended by `tagClose` enters it.
2. The tag-name span: the index of the token right after `tagOpen` in an open tag, kept per
   open tag, so the tag's end can test it against the raw-text set.
3. Optional children text: absent means children are lexed as code, with tags, close tags and
   holes still tracked; a `tagOpen` in the children always opens a nested tag.
4. Per-state ordered token lists tried before the ordinary scan: `tagTokens` (in a tag, outside
   holes and type arguments) and `textTokens` (planned: comments in text, directive openers).
5. The text-run stop test: the text token's class, plus a tag-start test (`tagOpen` followed by
   a declared class), plus directive openers; more than a character class.
6. Entry as a switch on the derived value: `operand` (`!prevIsValue()` + the `typeParameters`
   vetoes) or `always`.
7. A root region that never pops, with the depth counted excluding it.
8. Unchanged: one stack; push before the opener, pop after the closer; restart and resync at
   depth 0; a token decided by later text records depth + 1; the depth record saturates at 255.
9. An error inside an undecided type-parameter signature is the rewind verdict in every mode.

## What the generators need

- Region-only tokens (`text`, `tagTokens`): no flat top-level match (done in `gen-tm` /
  `gen-monarch`; the element patterns paint them).
- Code children: the element body patterns include the code grammar (`$self`) instead of the
  fixed JSX children repository.
- Raw text with an embed: TextMate `begin` (open tag) / `end` (`</name`) with `contentName` and
  an `include` of the embed scope; tree-sitter a raw-text external token plus `injections.scm`;
  Monarch `nextEmbedded` at the open tag's end and `@pop` at the close tag.
- Directives in children: keyword patterns inside the children, from the same opener literals
  (keyword + required next literal), and continuation keywords after a body.
- `tagStart`: the tag-open pattern requires the declared next-character class.
- Root region: today's markup TextMate output is that case; nothing changes unless `html.ts`
  moves.

## Consumers (the evidence the model was built from)

| consumer | where it starts | children / body | text versus code | raw text |
|---|---|---|---|---|
| JSX / TSX | entered from code at an operand position; `<` is also an operator | text + holes + elements | stop characters `{ < > }` | none |
| a TSX template dialect (evaluated as data) | code; an element is render output only at a line start or after `;` | text + holes + elements + directives (`@if (`, `@for (`, `@for await (`, `@switch (`, `@try {`; continuations `@else`, `@empty`, `@case X:`, `@default:`, `@pending`, `@catch (`) + `@{ … }` code blocks, whose bodies are code; `//` and `/* */` comments in text | at every index of a text run: `<` followed by `/ > { @ $ _ A-Z a-z`, `{`, `}`, and a directive opener (`@`, a keyword, its required next character); any other `@word` is text | `<script>` (case-insensitive) and `<style>` (exact case); raw only when the body does not start with `{` |
| `test/fixtures/elementdialect.ts` | code; `<` only opens tags | code: elements, directives, `{expr}`, strings | n/a | `<style>` (exact case) |
| HTML (`html.ts`, markup mode) | the whole file is children (a root region) | text + elements + comments + raw text | `tagOpen` followed by `tagOpenAfter` | `<script>`, `<style>`, … case-insensitive, with embeds |
| Vue / Svelte / Astro (not built) | root region | text + elements + holes + directives | as HTML plus the hole opener | `<script>` / `<style>` with `lang=` embeds |

Directive openers are to be derived from the grammar: the literals that can begin a children
item other than `tagOpen` and the hole opener, each with the literal that must follow it in that
rule when there is one (`@if` `(`; `@try` `{`). A continuation literal (`@else`, `@empty`,
`@catch`) is one that follows a directive body in its rule.

## Owed

- The portable lexers' frames for JSX / TSX and the dialect (the list above). Until then
  `buildIR` refuses `elements`, and `guard-lead` / `predictive-first` skip the JSX grammars.
- Text tokens / directive openers / tag start, the root region: the build order above.
- A raw-text body condition (the evaluated dialect reads `<style>{css}</style>` as an element
  with a hole, not raw text): not declared; it belongs with the TSRX-shaped fixture.
- The relex bound of a failed attempt and of an over-read inside a token (a regex attempt that
  falls back to division, `let m = f() < / 2;` with `/` inserted; `x = 1._x;` → `1._5`; an
  unterminated block comment; the head veto's trailing lookahead), and the paren-head keyword
  case (`if` → `ifx` before `(q) / r /`), once the shared bound functions are in
  `src/lex-match-plan.ts`.
- Re-measuring the five undecidable JSX shapes on a larger TSX corpus.
- The tm-dialect expected-fail rows are TextMate-side (children repository, dynamic tags, the
  `<style>` embed, React vocabulary); they move with the generators.
