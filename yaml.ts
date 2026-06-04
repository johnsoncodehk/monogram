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
// Numeric plain scalars (YAML 1.2 core schema): decimal / octal / hex integers, floats, ±.inf,
// .nan. Anything outside the core schema (binary `0b…`, dates, `12:34:56`) stays a plain string,
// matching what the `yaml` oracle resolves to a number.
const Num = token(
  new RegExp(
    String.raw`(?:[+-]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)` +
    String.raw`|0x[0-9a-fA-F]+|0o[0-7]+` +
    String.raw`|[+-]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][+-]?[0-9]+)?)` +
    VALUE_END,
  ),
  { scope: 'constant.numeric' },
);
// Boolean / null plain scalars (core schema) → constant.language.
const BoolNull = token(
  new RegExp(String.raw`(?:true|True|TRUE|false|False|FALSE|null|Null|NULL|~)${VALUE_END}`),
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

// A node (a value in any context): optional anchor/tag prefix, then a collection, alias, or a
// scalar-led form. The scalar-led branch is LEFT-FACTORED: parse one scalar, then a trailing
// ':' decides whether it is a block mapping (this scalar is the first key) or a bare scalar —
// so BlockMapping and Scalar no longer share a FIRST token (which made the parser pick wrong).
const Node = rule(() => [
  [opt(Anchor), opt(Tag), alt(BlockSequence, ExplicitMapping, FlowMapping, FlowSequence, Alias, MappingOrScalar)],
]);

// Scalar, optionally continued as a block mapping when a ':' follows.
const MappingOrScalar = rule(() => [
  [Scalar, opt(':', opt(MapValue), many(Newline, MapEntry))],
]);
// Subsequent mapping entries: implicit (`key: value`) or explicit (`? key` / `: value`).
const MapEntry = rule(() => [
  [Scalar, ':', opt(MapValue)],
  ['?', opt(MapValue), opt(Newline), opt(':', opt(MapValue))],
]);
// A mapping that STARTS with an explicit `? key` entry (FIRST = `?`, disjoint from scalar-led).
const ExplicitMapping = rule(() => [
  ['?', opt(MapValue), opt(Newline), opt(':', opt(MapValue)), many(Newline, MapEntry)],
]);
// A SEQUENCE-item value (after `-`): an indented block, or any inline node — including a
// compact inline block sequence (`- - a` is valid YAML).
const Value = rule(() => [[Indent, Node, Dedent], Node]);
// A MAPPING value (after `:`): an indented block, or an inline node that is NOT a block
// sequence — YAML forbids `key: - a` on one line (a block seq must begin on the next line).
const MapValue = rule(() => [[Indent, Node, Dedent], InlineNode]);
const InlineNode = rule(() => [[opt(Anchor), opt(Tag), alt(FlowMapping, FlowSequence, Alias, MappingOrScalar)]]);

// Block sequence: `- item` entries separated by a same-column NEWLINE.
const BlockSequence = rule(() => [[SeqItem, many(Newline, SeqItem)]]);
const SeqItem = rule(() => [['-', opt(Value)]]);

// Flow collections — indentation is SUSPENDED inside (lexer flowDepth), so newlines are
// insignificant and no INDENT/DEDENT/NEWLINE is emitted between `[`/`{` and the matching close.
const FlowMapping = rule(() => [['{', opt(FlowEntry, many(',', FlowEntry)), opt(','), '}']]);
const FlowEntry = rule(() => [[FlowScalarOrNode, opt(':', FlowValue)]]);
const FlowValue = rule(() => [alt(FlowMapping, FlowSequence, Alias, Scalar)]);
const FlowScalarOrNode = rule(() => [alt(FlowMapping, FlowSequence, Alias, Scalar)]);
const FlowSequence = rule(() => [['[', opt(FlowValue, many(',', FlowValue)), opt(','), ']']]);

// A YAML stream: one or more documents (optionally fenced by --- / ...).
// A YAML stream: leading directives, an implicit first document, then explicit `---` documents.
// NEWLINE is tolerated only ADJACENT to a marker (`---`/`...`/directive) via opt(Newline), and a
// bare second document requires a `---` — so `node\nbare` (two implicit docs) is rejected (the
// `many` body needs a DocStart) while `node\n---\nnode` and `---\nnode` parse.
const Stream = rule(() => [[
  many(Directive, opt(Newline)),
  opt(Indent), opt(Node), opt(Dedent),
  many(opt(Newline), opt(DocEnd), opt(Newline), DocStart, opt(Newline), many(Directive, opt(Newline)), opt(Indent), opt(Node), opt(Dedent)),
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
    Node, MappingOrScalar, MapEntry, ExplicitMapping, Value, MapValue, InlineNode, BlockSequence, SeqItem,
    FlowMapping, FlowEntry, FlowValue, FlowScalarOrNode, FlowSequence, Scalar, Stream,
  },
  entry: Stream,
  indent,
});
