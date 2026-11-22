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
  token, in a raw frame; the dialect fixture's `<style>`. A declaration's `unlessBodyStarts`
  makes the body ordinary children when the pattern matches at its start.
- **Tag start** (`tagStart`): a `tagOpen` opens a tag only before a declared character; any other
  is text in the children (the text run goes on over it) and the ordinary scan's in code.
- **Text tokens** (`textTokens`): tokens tried in the children before the text run, each with an
  optional `after` class; comments in text (`/* */` anywhere, `//` at a run's start or after a
  blank).
- The text dialect fixture `test/fixtures/textdialect.ts` (text children, `{}` holes, an
  `operand` entry, raw `<script>` and a `<style>` raw unless its body starts with `{`), with its
  rows in `test/text-dialect.ts`.
- A lex error inside an undecided type-parameter signature is the signature's rewind verdict in
  every lexing mode (strict and recovering), so both passes lex one stream.

Not built, in this order (each its own change with its gate):
1. **Directives**: openers derived from the grammar, the directive frame and its continuations
   ("Directives (designed)" below). Proven on the text dialect fixture.
2. **Root region**: `html.ts` re-expressed as a file that starts inside a children frame that
   never pops, only if every `html.ts` artifact and `conformance/html` stay byte-identical;
   otherwise markup mode stays and the blocking difference is recorded here.

The portable lexers (TypeScript, Go, Rust) carry the same frames (below, "The portable lexers"):
JSX, TSX and the dialect fixture have portable parsers, checked against the interpreter by
`test/portable-targets.ts`.

## The model: a region is a declared lexer state

One frame stack. A frame is a state; each state has a small ordered list of its own tokens tried
before the ordinary scan, an optional run token, the openers that push another state, and its
closer.

| state | run token | own tokens (tried first) | pushes | pops at |
|---|---|---|---|---|
| code hole (`{`, template `${`) | none: ordinary scan | none | element (entry rule), template, hole | its closer at brace count 0 |
| children | `text`, OPTIONAL: absent = children are code | `textTokens` | tag (at `tagOpen`; with `tagStart`, only before its class), hole, directive (planned) | the close tag of the last open element |
| tag (open / close) | none: ordinary scan, no regex | `tagTokens` | hole, nested element after `=`, type-argument depth (TS) | `tagClose` / self-close |
| raw text | ONE raw token up to `tagOpen + closeMarker + name` | none | none | after the raw token (the close tag is lexed outside) |
| directive (planned; code) | ordinary scan | none | as a code hole | its body's closer at count 0, unless a continuation literal follows |
| root (planned; whole-file markup) | the children state | as children | as children | never |

Common to every state: a frame is pushed before its opener token and popped after its closer
token, the token kinds come from the grammar's token declarations, and no state is
reconstructed on relex. What is specific to a region is data: the run token and its stop test,
the tag-start class, the raw-text tag set, its case rule and body condition, the directive openers.

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
  rawText?: [{ tags: ['style'], token: 'StyleBody', ignoreCase?: true, unlessBodyStarts?: seq(star(blank), '{'),
               embed?: { style: 'source.css' } }],
  tagStart?: oneOf('/', '>', '{', '$', '_', range('A', 'Z'), range('a', 'z')),  // one-unit class
  textTokens?: [{ token: 'BlockComment' }, { token: 'LineComment', after: blank }],
}
```

The region's own tokens (`text`, `closeTag`, `selfClose`, `tagTokens`, the `rawText` tokens) are not scan matchers
outside the region, so `</` and `/>` are tokens only where an element says so:
`a </* c */ b`, `new Map</* c */string, X>()`, `x = />/.test(s)` lex as tsc lexes them.

`rawText` is a list of declarations, each in the shape of `MarkupConfig.rawText` plus its own
`ignoreCase` (an evaluated dialect has a case-insensitive `<script>` and an exact-case `<style>`).
`embed` is highlighter data; the lexer does not read it. `unlessBodyStarts` is a pattern tested at
the body's first unit: when it matches, the element has ordinary children (the evaluated dialect
reads `<style>{css}</style>` as an element with a hole, and `<style> /* c */ {x}` as CSS: blanks
are skipped, comments are not). `tagStart` is a one-unit class (`MarkupConfig.tagOpenAfter` is
the same fact for a markup file): a `tagOpen` opens a tag, from code, in the children or after
an attribute's `=`, only when the unit after it is in the class. In the children any other
`tagOpen` is text: the run is the text token's class runs joined by such `tagOpen`s, so the text
token's own pattern no longer describes the whole run (its class excludes the `tagOpen`). In code
it is lexed by the ordinary scan (an operator).

`textTokens` (needs `text`) are scan tokens tried, in order, in the children before the text run;
they keep their ordinary meaning in code (the same `BlockComment` is a comment in both). A text run
stops where one of them matches: at the run's first unit always, further in the run only right
after a unit of its `after` class when it has one. So `a //b` is text then a comment, `a//b` and
`https://x` are text, and `//` right after a tag, a hole or another comment is a comment (a new run
starts there; the evaluated dialect keeps `/* a */// b` as text, its block comment not ending the
run). A skip token is skipped, as in code; any other is pushed. An unterminated `/*` matches
nothing, so it is text.

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
raw frame, pushes ONE token of the declaration's `token` over the body, and pops the frame
(unless the declaration's `unlessBodyStarts` matches at the body's start: then the children are
lexed as usual). An
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

## Directives (designed)

A directive is a children item `@if (head) { children }`, optionally followed by continuations
(`@else if (…) { … }`, `@else { … }`, `@empty { … }`, `@catch (e) { … }`, `@pending { … }`).
Its head is code, its body is children closed by the hole closer. Nothing about it is
dialect-specific in the lexer; every literal comes from the grammar.

**Declaration: none.** The directive table is DERIVED, as the entry is, by
`directivesOf(grammar, region)` (`src/grammar-analysis.ts`, planned) and recorded by
`lexSpecOf` as `elementDirectives`:
- the CHILDREN items are the items that can stand between an open tag's `tagClose` and the
  `closeTag` in an element arm (the `many(Child)` there), and, transitively, the items of every
  BODY;
- an OPENER is a literal that can begin a children item, other than `tagOpen` and `hole.open`,
  with its REQUIRED NEXT: the literal sequences that must follow it in that arm, up to the first
  `(` or `hole.open` (`@if` → `(`; `@for` → `(` or `await (`; `@try` → `{`). An arm whose opener
  is followed by anything else (an expression: `@case x:`) gives no opener: the lexer cannot
  test it, and the derivation says so loudly;
- the HEAD is the `( … )` group, when the required next ends with `(`; the BODY is the
  `hole.open … hole.close` group that follows, whose items are children items;
- a CONTINUATION is a literal that can follow a body in its rule (`opt('@else', …)`), with its
  own required next (`@else` → `{` or `if (`).
Before deriving it, the table's shape is: `{ openers: { lit, next: string[][] }[], continuations:
{ lit, next: string[][] }[] }`; that shape is what the portable lexers receive.

**The opener test** at a unit q of the children (a run's start, or inside a run: `a@if (` ends the
text before the `@`): the opener literal at q; when it ends with an identifier character, the unit
after it is not an identifier continuation (`@iffy` is text); then code trivia (whitespace and the
grammar's skip tokens); then one of the required next sequences, each literal separated by trivia.
Any other `@word` is text. Its read (from q to the unit after the last literal it tested) is
recorded in `lxLookEnd`: a comment in the trivia can reach the end of the file.

**Frame kind and encoding.** An element frame (kind 2) with sub-state 3, the one free sub-state:
- HEAD: the count field (bits 4 and up) holds `p + 1`, `p` the paren-head stack depth when the
  head began. The head is lexed by the ordinary scan as code (regex allowed: `prevIsValue` treats
  sub-state 3 as code, not as a tag). A `hole.open` at paren depth `p` is the body's opener and
  sets the count field to 0; a `hole.open` deeper pushes an element hole.
- BODY: count field 0. Lexed as children (text, text tokens, holes, openers) with two
  differences from an element's children: a `tagOpen` pushes a NEW element frame (as an entry
  from code does, `6`), and a stray close tag pushes a close-tag frame (`10`) that pops at its
  `tagClose`, so the parser sees the stray tag and the body frame survives. A `hole.close` at
  count 0 is the body's closer: the token is pushed inside the frame, then the CONTINUATION test
  runs after it (blanks, the continuation literal, its required next; read recorded): on a match
  the frame returns to HEAD with the current paren depth, and the continuation's tokens are lexed
  as head code; otherwise the frame pops.
- `@{ … }` (a children item whose opener literal ends with `hole.open` and whose group holds code,
  not children items) is a code block: an element hole (kind 1) pushed before its opener token,
  popped at its closer at brace count 0, as any hole.
A grammar without directives keeps sub-states 0-2 only; its lexer is byte-identical.

**Entry / exit.** Entered only from the children (an element's or a body's): a directive is a
children item. Exit: the body's closer with no continuation after it. In code an opener literal is
an ordinary token; a directive at statement level in code would need its own entry rule (as an
element there does), which is the line-start class below.

**Relex anchors.** Unchanged rule: the frame is pushed before the opener token and popped after
the last body's closer, so every directive token records depth > 0 and the token after the frame
records the enclosing frame's depth (always > 0: a directive lives in children). The two reads
past a token's end + 1, the opener test and the continuation test, are recorded in `lxLookEnd`,
so a comment left open in the trivia (`@if /* (`) flags what follows.

**What stays undecidable** (lexer-local): an opener whose required next is not a literal
(`@case x:` inside a switch body: the text run cannot tell where it starts; the derivation
refuses such an arm by name instead of letting the run swallow it); a directive at statement level in code (the
line-start entry class); an `@word (` in text that the author meant as text (the evaluated
dialect lexes it as a directive too, so the derived test agrees with it).

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
reconstructed. Every token inside an undecided type-parameter signature, and the token that
decides it, records one level deeper (the signature is lexer state, as a frame is).

A token is also decided by what its lexer READ: its match, and the failed attempts before it at
its start (the anchor rule, stated at the top of `src/relex-family.ts`). The read bounds are the
shared functions of `src/lex-match-plan.ts`: `failRead` and `readEndWalk` for a failed attempt,
`overTrigger` and `examinedUnits` for a match (a lazy repeat bounded as the regex runs it, so a
block comment reads nothing past its `*/`). The portable relex checks them at relex time. The
interpreter's lexer (`src/emit-lexer.ts`, windowed) records them while lexing: `lxLookEnd` is the
exclusive end of the furthest read any decision so far made, and a token pushed while it is past
the token's end + 1 carries flag 32: it is no restart anchor and no resync point. Such reads: a regex attempt that
falls back to division (to the end of its line), an unterminated block comment (to the end of the
file), a number that backed up inside its own pattern (`1._x`), and a type-parameter head veto
(its match and the unit its trailing lookahead reads: it decides the `<` before it; a failed head
opens an element, whose frame already holds what it read).

Resync compares the paren-head stacks by their trajectory since the divergence point; a `(`
stands on it at the depth before its own push, so an entry both lexes pushed after the
divergence (`if (q)` edited to `ifx (q)`: a control head in one, not in the other) is never taken
as shared.

Reads of the region's own decisions: a tag start reads the unit after the `tagOpen` (within the
`tagOpen` token's end + 1, or inside the text token that goes on over it); a raw-text body
condition reads the body's leading blanks and one unit after them, all inside the element frame
(the element's close tag, or the end of the file, comes after them): neither is recorded. A text
token's attempt is a scan matcher's attempt and is recorded as one (its `readEndWalk` end, its
over-read): an unterminated `/*` in text reads to the end of the file, past the element's close
tag, so every token after it carries flag 32 (`<p>q /*</p>; z = 1;` with `*/` inserted at the
end: without the record a restart at `1` keeps `</p>` as a close tag).

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

## The portable lexers

Built from one plan (`ElementPlan`, `src/emit-portable.ts`) and one family of shared routines
(`src/lex-family.ts`, `elementFns`), printed by each target:
- the frame step (`lexElFrame`): what an element frame on top of the stack lexes at a position
  (children: close tag, nested tag, hole, text run; tag: tag tokens, self-close, tag close with
  type-argument depth, nested element after `=`, hole), as (end, kind, literal, new top frame,
  frame to push, type-argument depth, look end);
- the type-parameter vetoes (`lexElOpens`): the head and signature patterns matched as the
  interpreter's regexes match them, and how far they read;
- the raw body (`lexElRaw`) and the read end of a signature's decision (`lexElReach`).
The printers place these in the dispatch loop and keep the state: the frame stack (the template
stack, with element holes counting braces as template holes do), whether the last token ended an
element, the type-argument depth, the look end, where a kept signature ends, and (raw text) each
element frame's tagOpen token index.

Differences from the interpreter, none visible in the token stream:
- A type-parameter signature is decided before its `tagOpen` is lexed: the lexer lexes the group
  as code to its verdict (a lex error there is the verdict "element"), rewinds, and then lexes
  the `tagOpen` as the verdict says. A kept signature is lexed twice; in exchange every lexer
  step yields one token, so a Doc records the lexer state after each token as before. Rust has
  no catchable lexer error, so its error routines return a sentinel while a signature is
  undecided.
- Relex: a token's depth (`relexDepth`, `src/relex-family.ts`) is the frames open after it, plus
  one when it ended an element, plus one when it starts before the look end: the furthest any
  lookahead read (the vetoes' patterns, a signature's group and the token deciding it, a tag
  token's failed attempt). Anchors and resync need depth 0, as for templates.
- A region's own tokens carry no literal id (0), as in the interpreter: the parser matches a
  literal by its id alone, so a text `if` must never be the keyword. A Doc rebuilding ids from
  text applies the same class test.

## What the portable lexers need

1. Frame kinds: template hole, element hole, element frame, and a raw frame (kind 3): one body
   token up to `tagOpen + closeMarker + name`, pushed inside the frame; the close tag is lexed
   after the pop. Per declaration: tag names, token kind, `ignoreCase`. Empty body = no token;
   no close tag = to the end of the file; only an open tag ended by `tagClose` enters it.
   `unlessBodyStarts` per declaration: a pattern tested at the body's first unit; when it
   matches, no raw frame (the children are lexed as usual).
2. The tag-name span: the index of the token right after `tagOpen` in an open tag, kept per
   open tag, so the tag's end can test it against the raw-text set.
3. Optional children text: absent means children are lexed as code, with tags, close tags and
   holes still tracked; a `tagOpen` in the children always opens a nested tag.
4. Per-state ordered token lists tried before the ordinary scan: `tagTokens` (in a tag, outside
   holes and type arguments) and `textTokens` (in the children, before the text run; a text
   token's `after` class tested on the unit before it inside a run; its failed attempt and its
   over-read recorded as the scan matcher's).
5. The text-run stop test: the text token's class, plus the tag-start test (a `tagOpen` stops the
   run only when the unit after it is in `tagStart`; otherwise the run goes on over it), plus
   the text tokens (a run stops before one that matches, `after` permitting), plus (planned)
   directive openers; more than a character class. The tag-start test
   also gates every other place a `tagOpen` opens a tag: the entry from code and the nested
   element after `=` in a tag.
6. Entry as a switch on the derived value: `operand` (`!prevIsValue()` + the `typeParameters`
   vetoes) or `always`.
7. A root region that never pops, with the depth counted excluding it.
8. Unchanged: one stack; push before the opener, pop after the closer; restart and resync at
   depth 0; a token inside an undecided signature records depth + 1; the depth record saturates
   at 255. The type-parameter head veto is a READ (anchor rule (ii)), not a depth: its match
   decides the `<` and reads up to the unit after it (its trailing lookahead), `overTrigger` /
   `examinedUnits` of `head`; the portable relex checks it with the other reads.
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
- `textTokens`: the children's patterns include the text tokens before the text pattern, and the
  text pattern stops before them (`(?!/\*)`, `//` only after a blank).
- `tagStart`: the tag-open pattern requires the declared next-character class; the children's
  text pattern also covers a `tagOpen` not followed by it.
- `unlessBodyStarts`: the raw-text `begin` requires the body not to start with the pattern (a
  negative lookahead after the open tag), and the element otherwise takes the children patterns.
- Root region: today's markup TextMate output is that case; nothing changes unless `html.ts`
  moves.

## Consumers (the evidence the model was built from)

| consumer | where it starts | children / body | text versus code | raw text |
|---|---|---|---|---|
| JSX / TSX | entered from code at an operand position; `<` is also an operator | text + holes + elements | stop characters `{ < > }` | none |
| a TSX template dialect (evaluated as data) | code; an element is render output only at a line start or after `;` | text + holes + elements + directives (`@if (`, `@for (`, `@for await (`, `@switch (`, `@try {`; continuations `@else`, `@empty`, `@case X:`, `@default:`, `@pending`, `@catch (`) + `@{ … }` code blocks, whose bodies are code; `//` and `/* */` comments in text | at every index of a text run: `<` followed by `/ > { @ $ _ A-Z a-z`, `{`, `}`, and a directive opener (`@`, a keyword, its required next character); any other `@word` is text | `<script>` (case-insensitive) and `<style>` (exact case); raw only when the body does not start with `{` |
| `test/fixtures/elementdialect.ts` | code; `<` only opens tags | code: elements, directives, `{expr}`, strings | n/a | `<style>` (exact case) |
| `test/fixtures/textdialect.ts` | code, at an operand position; `<` is also relational | text + holes + elements + comments | `<` before `/ > { $ _ A-Z a-z`, `{`, `}`, `/*`, `//` after a blank | `<script>` (any case); `<style>` (exact case) unless its body starts with `{` |
| HTML (`html.ts`, markup mode) | the whole file is children (a root region) | text + elements + comments + raw text | `tagOpen` followed by `tagOpenAfter` | `<script>`, `<style>`, … case-insensitive, with embeds |
| Vue / Svelte / Astro (not built) | root region | text + elements + holes + directives | as HTML plus the hole opener | `<script>` / `<style>` with `lang=` embeds |

Directive openers and continuations are derived from the grammar ("Directives (designed)").

## Owed

- In the portable lexers: `tagStart`, `unlessBodyStarts`, `textTokens`, directives and the root
  region, as they are built here (until then `buildIR` refuses a grammar that declares one of
  them, as out of scope); a raw-text grammar that also declares a type-parameter signature is
  refused (the signature's rewind does not restore the raw-text tag records).
- Directives, the root region: the build order above.
- Re-measuring the five undecidable JSX shapes on a larger TSX corpus.
- The tm-dialect expected-fail rows are TextMate-side (children repository, dynamic tags, the
  `<style>` embed, React vocabulary); they move with the generators.
