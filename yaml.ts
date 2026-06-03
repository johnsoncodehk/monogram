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
const DocStart = token(/---/, { scope: 'punctuation.definition.directives-end.yaml' });
const DocEnd = token(/\.\.\./, { scope: 'punctuation.definition.document-end.yaml' });
const Comment = token(/#[^\n]*/, { skip: true, scope: 'comment.line.number-sign.yaml' });
const DQuote = token(/"(?:\\.|[^"\\])*"/, { string: true, scope: 'string.quoted.double.yaml' });
const SQuote = token(/'(?:''|[^'])*'/, { string: true, scope: 'string.quoted.single.yaml' });
const Anchor = token(/&[^\s\[\]{},]+/, { scope: 'entity.name.type.anchor.yaml' });
const Alias = token(/\*[^\s\[\]{},]+/, { scope: 'variable.other.alias.yaml' });
const Tag = token(/!(?:<[^>]*>|[^\s\[\]{},]*)/, { scope: 'storage.type.tag.yaml' });
const Directive = token(/%[^\n]*/, { scope: 'keyword.other.directive.yaml' });
// Block scalar (| / >): EMITTED by the lexer's block-scalar mode (placeholder pattern, skipped
// in the regex loop) so the more-indented content lines arrive as a single token.
const BlockScalar = token(/(?!)/, { scope: 'string.unquoted.block.yaml' });
// Plain scalar. Leading char: a non-indicator, OR one of `- ? :` when followed by a non-space
// (so `-1`, `?x`, `::v` are plain, but `- `, `? `, `: ` stay indicators). Body: any non
// `:`/`#`/`,`/flow char, plus `:` when NOT followed by space/`,`/`]`/`}` — YAML treats only `: `
// as a key separator, so `http://x` and `key:val` are single plain scalars.
const Plain = token(
  /(?:[^\s\-?:,\[\]{}#&*!|>'"%@`]|[-?:](?=[^\s,\[\]{}]))(?:[^:#\n,\[\]{}]|:(?=[^\s,\]}]))*/,
  { scope: 'string.unquoted.yaml' },
);

const Scalar = rule(() => [DQuote, SQuote, BlockScalar, Plain]);

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
  tokens: { DocStart, DocEnd, Directive, Comment, DQuote, SQuote, Anchor, Alias, Tag, BlockScalar, Plain, Indent, Dedent, Newline },
  // NOTE: the parser's entry rule is the LAST rule declared here (findEntryRule = rules[last]),
  // so `Stream` must come last.
  rules: {
    Node, MappingOrScalar, MapEntry, ExplicitMapping, Value, MapValue, InlineNode, BlockSequence, SeqItem,
    FlowMapping, FlowEntry, FlowValue, FlowScalarOrNode, FlowSequence, Scalar, Stream,
  },
  entry: Stream,
  indent,
});
