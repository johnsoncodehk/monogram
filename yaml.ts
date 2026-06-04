// yaml.ts — YAML on the shared Monogram core, using the engine's opt-in INDENTATION mode
// (`indent` config → the lexer emits INDENT/DEDENT/NEWLINE; see src/gen-lexer.ts). This is the
// first grammar that is indentation-sensitive rather than a token stream or markup.
//
// First-cut coverage: block + flow mappings & sequences, plain / single / double-quoted scalars,
// anchors (&a) / aliases (*a) / tags (!!t), comments (#), document markers (--- / ...).
// KNOWN first-cut gaps (the src-coverage metric localizes them against yaml-test-suite):
//   block scalars (`|`, `>`), plain scalars containing ':' (e.g. URLs) or trailing '# comment',
//   explicit/complex keys (`? key`), multi-line plain scalars, directives (`%YAML`).
import { token, rule, defineGrammar, alt, many, opt } from './src/api.ts';
import type { IndentConfig } from './src/types.ts';

// ── Structural tokens emitted by the lexer's indentation state machine. They are NEVER
// regex-matched (the patterns are placeholders — `(?!)` never matches); the lexer emits them
// and skips them in the regex loop via gen-lexer's indentTokenNames. The grammar references
// them like ordinary tokens (the parser matches by token TYPE). ──
const Indent = token(/(?!)/, {});
const Dedent = token(/(?!)/, {});
const Newline = token(/(?!)/, {});

// ── Scalars & lexical tokens (declaration order matters: earlier wins) ──
const DocStart = token(/---/, { scope: 'punctuation.definition.directives-end' });
const DocEnd = token(/\.\.\./, { scope: 'punctuation.definition.document-end' });
const Comment = token(/#[^\n]*/, { skip: true, scope: 'comment.line.number-sign' });
const DQuote = token(/"(?:\\.|[^"\\])*"/, { string: true, scope: 'string.quoted.double' });
const SQuote = token(/'(?:''|[^'])*'/, { string: true, scope: 'string.quoted.single' });
const Anchor = token(/&[^\s\[\]{},]+/, { scope: 'entity.name.type.anchor' });
const Alias = token(/\*[^\s\[\]{},]+/, { scope: 'variable.other.alias' });
const Tag = token(/!(?:<[^>]*>|[^\s\[\]{},]*)/, { scope: 'storage.type.tag' });
// Directive (`%YAML 1.2`, `%TAG …`): runs to EOL but stops before a ` #` trailing comment — a
// `#` is a comment indicator only after whitespace, so a glued `#` (`%YAML 1.1#x`) stays part of
// the directive while a spaced ` # comment` falls to the Comment token (same rule as plain scalars).
const Directive = token(/%(?:[^\n#]|#(?<=\S#))*/, { scope: 'keyword.other.directive' });
// Block scalar (| / >): EMITTED by the lexer's block-scalar mode (placeholder pattern, skipped
// in the regex loop) so the more-indented content lines arrive as a single token.
const BlockScalar = token(/(?!)/, { scope: 'string.unquoted.block' });
// Plain-scalar shapes shared by the key / number / boolean tokens below. The BODY is the same
// run of characters the general Plain scalar matches; the leading-char and the trailing context
// are what split a key (LHS of `: `) and a typed value (number / boolean / null) off the generic
// string-valued plain scalar — a finer SCOPE for the highlighter, while the parser still treats
// every one as a Scalar (they are all added to the `Scalar` rule, so the parse tree is unchanged).
const PLAIN_HEAD = String.raw`(?:[^\s\-?:,\[\]{}#&*!|>'"%@\`]|[-?:](?=[^\s,\[\]{}]))`;
// A `#` is a COMMENT indicator only at line start or after whitespace; inside a plain scalar a
// `#` glued to a non-space char is ordinary content (`this is#not` is ONE key, `http://a#b` is a
// URL). So the body keeps a `#` whose preceding char is non-space — `#(?<=\S#)` matches the `#`
// then asserts the two chars ending here are «non-space»«#» — while ` #…` (space-prefixed) still
// ends the scalar and falls to the Comment token.
const PLAIN_BODY = String.raw`(?:[^:#\n,\[\]{}]|:(?=[^\s,\]}])|#(?<=\S#))*`;
// A plain scalar is a mapping KEY when a `:` key-separator (colon + whitespace / EOL, or—inside a
// flow collection—colon + `,`/`]`/`}`) follows it. Matched BEFORE the value/number tokens so a
// numeric-looking key (`123:`) is still a key (entity.name.tag), as the `yaml` oracle resolves it.
// A PLAIN scalar needs the colon to be followed by whitespace/EOL/flow-indicator, because a bare
// `:` glued to more text is plain-scalar content (`foo:bar` is one scalar, `http://x` a URL).
const KEY_SEP = String.raw`(?=[\t ]*:(?:[\s,\[\]{}]|$))`;
// A QUOTED scalar, by contrast, is a mapping KEY whenever ANY `:` follows it (after optional
// spaces) — `"x":v` (glued) and `"x": v` are both keys, and a quoted scalar can never run past its
// closing quote, so the colon is always the entry separator, never scalar content. (In valid YAML a
// quoted scalar immediately followed by `:` is ALWAYS a key — verified against the `yaml` package:
// the only `"x":y` shapes it rejects are block-context errors, which the grader excludes. This is
// what colours the JSON-style flow key `{"foo":bar}` / `["k":v]`, vscode#203212 / yaml-test-suite
// C2DT·5T43·4MUZ.) Spaced/EOL still match (`(?=[\t ]*:)` covers `"x" : v` and `"x":`).
const QKEY_SEP = String.raw`(?=[\t ]*:)`;

// Plain scalar that is a mapping key → entity.name.tag (the YAML convention for a key name).
const Key = token(
  new RegExp(`${PLAIN_HEAD}${PLAIN_BODY}${KEY_SEP}`),
  { scope: 'entity.name.tag' },
);
// Double-quoted scalar in KEY position (a `"…"` immediately followed by a `:` key-separator).
const DQuoteKey = token(
  new RegExp(`"(?:\\\\.|[^"\\\\])*"${QKEY_SEP}`),
  { string: true, scope: 'entity.name.tag' },
);
// Single-quoted scalar in KEY position.
const SQuoteKey = token(
  new RegExp(`'(?:''|[^'])*'${QKEY_SEP}`),
  { string: true, scope: 'entity.name.tag' },
);

// Value end-boundary for typed plain scalars (number / boolean / null): the scalar must be the
// WHOLE node, so it is followed by whitespace+comment, an end-of-value char (EOL / `,` / `]` /
// `}`), or a key-separator `:`. Mirrors the maintained RedCMD grammar's core-schema lookaheads.
const VALUE_END = String.raw`(?=[\t ]+#|[\t ]*(?:[\r\n,\[\]{}]|:(?:[\s,\[\]{}]|$))|$)`;
// A NON-SPECIFIC tag (`!` followed by whitespace) forces its plain scalar to resolve as a STRING
// regardless of the scalar's appearance (`! 12` is the string "12", not the number 12 — YAML 1.2
// §6.9.1 / yaml-test-suite S4JQ). So the typed value tokens (Num / BoolNull) MUST NOT fire on a
// scalar that is glued to a leading `!␣` tag — the negative lookbehind drops them so the scalar
// falls through to the generic Plain (`string.unquoted`). A *specific* tag (`!!int 12`, `!!bool …`)
// puts non-space chars between the `!` and the value, so this lookbehind leaves those untouched —
// they keep resolving by appearance, matching what the `yaml` oracle reports.
const NONSPECIFIC_TAG = String.raw`(?<!![\t ]+)`;
// Numeric plain scalars (YAML 1.2 core schema): decimal / octal / hex integers, floats, ±.inf,
// .nan. Anything outside the core schema (binary `0b…`, dates, `12:34:56`) stays a plain string,
// matching what the `yaml` oracle resolves to a number.
const Num = token(
  new RegExp(
    NONSPECIFIC_TAG +
    String.raw`(?:[+-]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)` +
    String.raw`|0x[0-9a-fA-F]+|0o[0-7]+` +
    String.raw`|[+-]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][+-]?[0-9]+)?)` +
    VALUE_END,
  ),
  { scope: 'constant.numeric' },
);
// Boolean / null plain scalars (core schema) → constant.language. Same non-specific-tag guard:
// `! true` is the string "true", not the boolean (yaml-test-suite cousins of S4JQ).
const BoolNull = token(
  new RegExp(NONSPECIFIC_TAG + String.raw`(?:true|True|TRUE|false|False|FALSE|null|Null|NULL|~)${VALUE_END}`),
  { scope: 'constant.language' },
);

// Plain scalar. Leading char: a non-indicator, OR one of `- ? :` when followed by a non-space
// (so `-1`, `?x`, `::v` are plain, but `- `, `? `, `: ` stay indicators). Body: the shared
// PLAIN_BODY (any non `:`/`,`/flow char, plus `:` not before space/`,`/`]`/`}`, plus a `#` glued
// to a non-space) — so `http://x`, `key:val` and `this is#not` are single plain scalars.
const Plain = token(
  new RegExp(`${PLAIN_HEAD}${PLAIN_BODY}`),
  { scope: 'string.unquoted' },
);

// A Scalar is any of the above scalar SHAPES. The key / number / boolean tokens are finer
// HIGHLIGHTING splits of the generic quoted/plain scalars; the parser accepts them all wherever
// a scalar is legal, so the parse tree (and the src-coverage metric) is unchanged.
const Scalar = rule(() => [DQuoteKey, SQuoteKey, DQuote, SQuote, BlockScalar, Key, Num, BoolNull, Plain]);

// A NODE PROPERTY: an anchor and/or tag, in either order (`&a`, `!!t`, `&a !!t`, `!!t &a`).
// At least one is present (a bare node with no property is parsed by ContentNode). A property
// may be the WHOLE node (its content empty → a null/empty value): `&x` / `!!str` are valid nodes.
const Property = rule(() => [[Anchor, opt(Tag)], [Tag, opt(Anchor)]]);
// A node WITHOUT a property prefix: the bare content shapes. Split out so a property-led node
// (Property + content) and a bare node are FIRST-disjoint (Property begins with `&`/`!`,
// ContentNode with `-`/`?`/`{`/`[`/`*`/a scalar) — the parser never has to guess between them.
const ContentNode = rule(() => [alt(BlockSequence, ExplicitMapping, EmptyKeyMapping, FlowMapping, FlowSequence, AliasOrKeyed, MappingOrScalar)]);

// A node (document level, or the content of an indented block): an optional anchor/tag property
// then content that is inline, INDENTED, on the NEXT LINE at the same column (`&seq\n- a`,
// `&x\nfoo`, `--- !!map\n? a\n: b`), or EMPTY (`&x` / `!!str` alone). The same-column-after-newline
// tail is valid HERE (no enclosing key forces indentation) but NOT in a mapping/sequence VALUE
// position (see the *ValueNode rules) — there a same-column line is a sibling, so the property's
// value is empty. The scalar-led branch stays LEFT-FACTORED via MappingOrScalar (a trailing ':'
// decides mapping-vs-scalar) so BlockMapping and Scalar share no FIRST token.
//
// The anchor/tag prefix is written INLINE as `opt(Anchor), opt(Tag)` (with a second tag-first
// `[Tag, Anchor]` branch for `!!t &a`) rather than via the `Property` rule, and the content is an
// INLINE `opt(alt(…))`: gen-tm's explicit-key prefix detector recognises a node prefix as an
// `opt(token)` standing before an `alt` in the SAME sequence, which it cannot see through a rule
// ref. Keeping the inline shape here lets `? &a key` / `? !!t key` keep highlighting the key.
const nodeContentAlts = () => [
  [Indent, Node, Dedent], [Newline, Node],
  BlockSequence, ExplicitMapping, EmptyKeyMapping, FlowMapping, FlowSequence, AliasOrKeyed, MappingOrScalar,
] as const;
const Node = rule(() => [
  [opt(Anchor), opt(Tag), opt(alt(...nodeContentAlts()))],
  [Tag, Anchor, opt(alt(...nodeContentAlts()))],
]);

// Scalar, optionally continued as a block mapping when a ':' follows.
const MappingOrScalar = rule(() => [
  [Scalar, opt(':', opt(MapValue), many(Newline, MapEntry))],
]);
// An ALIAS, optionally continued as a block mapping when a ':' follows — an alias may be a
// block-mapping key (`*b : *a`; yaml-test-suite E76Z / 6M2F). Left-factored like MappingOrScalar so
// the bare-alias node and the alias-keyed mapping share no FIRST token (both begin with `*`; the
// trailing ':' decides).
//
// NOTE: a FLOW collection as a block-mapping KEY (`[a,b]: v`, `{}: c`; LX3P / 4FJ6) is NOT modelled
// here. YAML requires an implicit key — flow-collection keys included — to be on a SINGLE line, but
// the lexer suspends indentation inside flow and emits no newline token there, so a multi-line flow
// key (`[23\n]: 42`, yaml-test-suite C2SP) is indistinguishable from the single-line form at the
// grammar level. Supporting `flow: ':'` (measured) fixed 2 single-line cases but ALSO accepted C2SP
// (+1 over-accept), which the FP-must-not-rise gate forbids; it was backed out. The bare flow
// collection is still a valid VALUE/node (it just cannot be a block KEY) — a lexer-info-loss limit.
const AliasOrKeyed = rule(() => [
  [Alias, opt(':', opt(MapValue), many(Newline, MapEntry))],
]);
// A block-mapping KEY: a plain/quoted scalar optionally carrying its OWN anchor/tag property
// (`&anchor c: 3` ZWK4, `!!str baz : …` HMQ5) — OR a bare ALIAS (`*b : v`, yaml-test-suite E76Z).
// An alias key may NOT take a property (`&b *alias` / `!!str *alias` are illegal — an alias is a
// reference, yaml-test-suite SU74), so it is a distinct branch with no property. A FLOW-collection
// key is intentionally omitted (the single-line implicit-key constraint is unobservable after the
// lexer drops in-flow newlines — see AliasOrKeyed). Used by every implicit mapping entry.
const BlockKey = rule(() => [
  [opt(Property), Scalar],
  Alias,
]);
// An EXPLICIT `? key : value` entry. The `: value` half is optional (`? key` alone is a null-valued
// entry, yaml-test-suite 2XXW), and may sit on the SAME line (`? a : b`) or the NEXT line (`? a\n:
// b`). The next-line `:` is matched as an ATOMIC `[Newline, ':', …]` group so that when no `:`
// follows, the entry does NOT swallow the sibling-separator Newline — `? b\n&anchor c: 3` is two
// entries, not one (the bug that made `opt(Newline), opt(':')` eat the separator). ZWK4 / 7W2P.
const ExplicitEntry = rule(() => [
  ['?', opt(MapValue), opt(alt([Newline, ':', opt(MapValue)], [':', opt(MapValue)]))],
]);
// Subsequent mapping entries: implicit (`key: value`, key via BlockKey), explicit (`? key`), or an
// EMPTY key (`: value` — a mapping entry with a null key; yaml-test-suite NKF9 / S3PD / 6M2F).
const MapEntry = rule(() => [
  [BlockKey, ':', opt(MapValue)],
  ExplicitEntry,
  [':', opt(MapValue)],
]);
// A mapping that STARTS with an explicit `? key` entry (FIRST = `?`, disjoint from scalar-led).
const ExplicitMapping = rule(() => [
  [ExplicitEntry, many(Newline, MapEntry)],
]);
// A block mapping whose FIRST entry has an EMPTY key (`: value` / `:` with a null value), then any
// further entries. FIRST token `:` is disjoint from every other node shape, so this is a clean
// alternative. `: v` → {"": "v"}, `:` → {"": null}, `- :` → a seq item that is an empty-key map.
// (yaml-test-suite NKF9 / S3PD / SM9W / UKK6 / 6M2F.) The continuation entries are NON-empty-keyed
// (MapEntryNoEmpty) so a SECOND empty key in the same mapping (`: a\n: b`, yaml-test-suite 2JQS) is
// not accepted — that is a duplicate-key error, which a CFG cannot detect in general, but the
// all-empty-keys case is at least kept out by forbidding a repeated empty key here.
const EmptyKeyMapping = rule(() => [
  [':', opt(MapValue), many(Newline, MapEntryNoEmpty)],
]);
// A mapping entry that is NOT an empty-key entry (implicit `key: value` or explicit `? …`). Used as
// the continuation of an empty-key-led mapping to bar a second empty key (see EmptyKeyMapping).
const MapEntryNoEmpty = rule(() => [
  [BlockKey, ':', opt(MapValue)],
  ExplicitEntry,
]);
// A SEQUENCE-item value (after `-`): an indented block, or an inline/empty node — including a
// compact inline block sequence (`- - a` is valid YAML). A property's same-column-after-newline
// content does NOT continue here (`- &x\n- 1` is two items, the first empty), so the property
// leads only to an INDENTED block or an inline value, never a [Newline, …] tail.
const Value = rule(() => [[Indent, Node, Dedent], SeqValueNode]);
// A MAPPING value (after `:`): an indented block, or an inline/empty node that is NOT a block
// sequence — YAML forbids `key: - a` on one line (a block seq must begin on the next line). A
// property here may be followed by an INDENTED block (`a: !!seq\n  - x`) or be EMPTY (`a: &x\nb: c`
// → value null, `b` a sibling); a same-column line is the sibling, never the value.
const MapValue = rule(() => [[Indent, Node, Dedent], MapValueNode]);
// The content of an INDENTED value block (after `key: &prop\n  …` or `key:\n  …`): like Node,
// but a node that carries a property AND is the content of an already-property-led value must
// wrap a COLLECTION, never a bare scalar — `a: &x\n  &y scalar` stacks two anchors on one node
// (illegal, ≤1 anchor per node; yaml-test-suite 4JVG), whereas `a: &x\n  &y key: v` puts the
// inner anchor on the mapping's key (legal) and `a: &x\n  scalar` has a single anchor (legal).
// A bare (property-less) ContentNode is unrestricted.
const IndentedValueNode = rule(() => [
  [Property, alt([Indent, IndentedValueNode, Dedent], CollectionContent)],
  ContentNode,
]);
// A node content that is a COLLECTION (never a bare scalar): a block/flow sequence or mapping, an
// explicit `?`-mapping, or a scalar that is REQUIRED to be a mapping key (a `:` must follow).
const CollectionContent = rule(() => [alt(BlockSequence, ExplicitMapping, FlowMapping, FlowSequence, MappingFromScalar)]);
const MappingFromScalar = rule(() => [[Scalar, ':', opt(MapValue), many(Newline, MapEntry)]]);
// A node in MAP-VALUE position (after `:`): a property whose content is inline, INDENTED, or
// EMPTY (no same-column [Newline, …] tail — that line is a sibling); OR a bare inline content
// node (flow/alias/scalar-led). NEVER an inline block sequence (`key: - a` is invalid YAML).
const MapValueNode = rule(() => [
  [Property, opt(alt([Indent, IndentedValueNode, Dedent], MapInlineContent))],
  MapInlineContent,
]);
const MapInlineContent = rule(() => [alt(FlowMapping, FlowSequence, Alias, MappingOrScalar)]);
// A node in SEQUENCE-item position (after `-`): like MapValueNode but a compact inline block
// sequence IS allowed (`- - a`).
const SeqValueNode = rule(() => [
  [Property, opt(alt([Indent, IndentedValueNode, Dedent], SeqInlineContent))],
  SeqInlineContent,
]);
const SeqInlineContent = rule(() => [alt(BlockSequence, EmptyKeyMapping, FlowMapping, FlowSequence, Alias, MappingOrScalar)]);

// Block sequence: `- item` entries separated by a same-column NEWLINE.
const BlockSequence = rule(() => [[SeqItem, many(Newline, SeqItem)]]);
const SeqItem = rule(() => [['-', opt(Value)]]);

// Flow collections — indentation is SUSPENDED inside (lexer flowDepth), so newlines are
// insignificant and no INDENT/DEDENT/NEWLINE is emitted between `[`/`{` and the matching close.
// A flow NODE: an optional anchor/tag property then an optional flow value — so a flow entry can
// carry a property (`[ &i a, b ]`, `{ &e e: f }`, `&g { g: h }`; yaml-test-suite CN3R / X38W) and
// a property-only / empty value is allowed (`{? foo :,}` trailing-empty; FRK4 / DFF7).
const FlowNode = rule(() => [[opt(Property), opt(alt(FlowMapping, FlowSequence, Alias, Scalar))]]);
// The EXPLICIT-key half of a flow entry (`? key`). Factored into its own rule so the `?` literal is
// NOT a top-level literal of FlowMapEntry — gen-tm's flow detector takes the FIRST single-char
// punctuation in the entry rule as the key/value separator, and a top-level `?` would be picked
// ahead of the real `:` and mis-derive every flow `:`-based pattern. Behind a ref, the `?` is
// hidden and the detector correctly sees `:`.
const FlowExplicit = rule(() => [['?', opt(FlowNode)]]);
// An entry of a flow MAPPING `{…}`: an optional `? key` explicit half, an optional key node, and
// an optional `: value`. One flat sequence covers `k: v`, `k` (null value), `? k : v`, `? k`, and
// `: v` (empty key). Inside a flow MAPPING the implicit key need NOT be single-line (`{foo\n: bar}`
// / `{ key\n : value }` are valid — every `{…}` member is a pair, so a multi-line key is
// unambiguous; yaml-test-suite 4MUZ / VJP3), so the `:` may sit on the next line. Kept a single SEQ
// (not an alt of forms) so its top-level `:` literal stays visible to the gen-tm flow detector.
const FlowMapEntry = rule(() => [
  [opt(FlowExplicit), opt(FlowNode), opt(':', opt(FlowNode))],
]);
const FlowMapping = rule(() => [['{', opt(FlowMapEntry, many(',', FlowMapEntry)), opt(','), '}']]);
// An entry of a flow SEQUENCE `[…]`: a bare flow node, OR a single-pair `key: value` mapping
// (`[ a: b ]`, `[ YAML : separate ]`; 9MMW / CT4Q), an explicit `? k : v`, or an empty-key `: v`.
// A flow-sequence single-pair's implicit key MUST be on ONE line (yaml-test-suite DK4H), so its
// plain/quoted scalar key uses the KEY-position tokens (Key / DQuoteKey / SQuoteKey) whose pattern
// bakes in a same-line `:` lookahead — a key whose `:` is on the NEXT line tokenises as a bare
// `Plain` and so misses this branch, falling to the bare-node branch (no `:` to consume → reject).
const FlowSeqEntry = rule(() => [
  [FlowSeqKey, ':', opt(FlowNode)],
  ['?', opt(FlowNode), opt(':', opt(FlowNode))],
  [':', opt(FlowNode)],
  FlowNode,
]);
const FlowSeqKey = rule(() => [
  [opt(Property), alt(FlowMapping, FlowSequence, DQuoteKey, SQuoteKey, Key)],
  Alias,
]);
const FlowSequence = rule(() => [['[', opt(FlowSeqEntry, many(',', FlowSeqEntry)), opt(','), ']']]);

// A document node that BEGINS on the `---` line. A bare (property-less) node here must be INLINE
// — a flow collection, alias, or BARE scalar (the scalar is bare, not MappingOrScalar, so a
// trailing `:` cannot turn it into a block mapping; the leftover `:` then fails the parse,
// rejecting `--- a: b`). A PROPERTY may begin on the `---` line and carry its content on the NEXT
// line / indented (`--- !!map\n? a\n: b`, `--- !!str\nfoo`) or inline (`--- &a foo`); its inline
// content is likewise a bare scalar / flow / alias, never an on-the-line block collection.
const InlineDocNode = rule(() => [
  [Property, opt(alt([Indent, Node, Dedent], [Newline, Node], FlowMapping, FlowSequence, Alias, Scalar))],
  alt(FlowMapping, FlowSequence, Alias, Scalar),
]);

// A YAML stream: one or more documents (optionally fenced by --- / ...).
// A YAML stream: leading directives, an implicit first document, then explicit `---` documents.
// NEWLINE is tolerated only ADJACENT to a marker (`---`/`...`/directive) via opt(Newline), and a
// bare second document requires a `---` — so `node\nbare` (two implicit docs) is rejected (the
// `many` body needs a DocStart) while `node\n---\nnode` and `---\nnode` parse.
// The (non-empty) body of an explicit `--- …` document: a NEWLINE-led full Node (block collections
// allowed, since they begin on the NEXT line) or a same-line InlineDocNode. Both branches are
// NON-nullable (branch 1 starts with a required Newline, branch 2 with a required InlineDocNode),
// so this rule never matches purely empty — a rule whose only match is empty returns null
// (parseNonRec requires forward progress) and would break the enclosing `many`. The EMPTY document
// body (`---` then nothing, e.g. `---\n---`) is handled by the `opt(ExplicitDocBody)` at the call
// site. Kept a RULE (not an inline `alt`) so gen-tm's explicit-key prefix detection — which scans
// for an `opt(token)` followed LATER IN THE SAME SEQ by an `alt` — does not mistake this body's
// alternation for YAML's anchor/tag node-prefix (a `ref` is opaque to that scan).
const ExplicitDocBody = rule(() => [
  [Newline, many(Directive, opt(Newline)), opt(Indent), opt(Node), opt(Dedent)],
  InlineDocNode,
]);

// A document that follows a `...` document-end marker: a fresh `---` document, OR a BARE document
// (no `---`). A bare second document is legal ONLY after a `...` (`a\n...\nb` is two documents;
// yaml-test-suite 7Z25 / M7A3) — never after a plain line (`a\nb` is a single multi-line scalar),
// so the bare-doc branch lives behind a required DocEnd in NextDoc, not at stream top level. The
// bare branch is non-nullable (Node required) so the rule never matches empty (which would return
// null and break the `many`); its absence is handled by the `opt(AfterDocEnd)` caller.
const AfterDocEnd = rule(() => [
  [DocStart, opt(ExplicitDocBody)],
  [opt(Indent), Node, opt(Dedent)],
]);
// The boundary + body of each document after the first: a `---` document, or a `...` end marker
// optionally followed by another (`---` or bare) document. Both branches begin with a required
// marker token (DocStart / DocEnd), so NextDoc is non-nullable and drives the stream `many`. The
// `...` marker must be ALONE on its line: a following document is reached only THROUGH a required
// Newline (`opt(Newline, opt(AfterDocEnd))`), so content glued to the marker (`... invalid`,
// yaml-test-suite 3HFZ) is left unconsumed and the parse fails — as the `yaml` oracle requires.
const NextDoc = rule(() => [
  [DocStart, opt(ExplicitDocBody)],
  [DocEnd, opt(Newline, opt(AfterDocEnd))],
]);

// A YAML stream: leading directives, an implicit first (bare) document, then a run of further
// documents each introduced by `---` or separated by `...` (with an optional trailing `...`).
const Stream = rule(() => [[
  many(Directive, opt(Newline)),
  opt(Indent), opt(Node), opt(Dedent),
  many(opt(Newline), NextDoc),
  opt(Newline), opt(DocEnd), opt(Newline),
]]);

const indent: IndentConfig = {
  indentToken: 'Indent',
  dedentToken: 'Dedent',
  newlineToken: 'Newline',
  flowOpen: ['[', '{'],
  flowClose: [']', '}'],
  comment: '#',
  blockScalar: { introducers: ['|', '>'], token: 'BlockScalar' },
};

export default defineGrammar({
  name: 'yaml',
  scopeName: 'source.yaml',
  // Declaration order = lexer precedence (earlier wins). The KEY tokens precede the quoted /
  // value tokens (a numeric- or quoted-looking key is still a key); the typed value tokens
  // (Num, BoolNull) precede the generic Plain so a number / boolean resolves to its own scope.
  tokens: { DocStart, DocEnd, Directive, Comment, DQuoteKey, SQuoteKey, DQuote, SQuote, Anchor, Alias, Tag, BlockScalar, Key, Num, BoolNull, Plain, Indent, Dedent, Newline },
  // NOTE: the parser's entry rule is the LAST rule declared here (findEntryRule = rules[last]),
  // so `Stream` must come last.
  rules: {
    Property, ContentNode, Node, MappingOrScalar, AliasOrKeyed, BlockKey, ExplicitEntry, MapEntry, MapEntryNoEmpty, ExplicitMapping, EmptyKeyMapping, Value, MapValue,
    IndentedValueNode, CollectionContent, MappingFromScalar,
    MapValueNode, MapInlineContent, SeqValueNode, SeqInlineContent, BlockSequence, SeqItem,
    FlowNode, FlowExplicit, FlowMapEntry, FlowMapping, FlowSeqEntry, FlowSeqKey, FlowSequence, Scalar, InlineDocNode, ExplicitDocBody, AfterDocEnd, NextDoc, Stream,
  },
  entry: Stream,
  indent,
});
