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
// Plain scalar: a run that does not START with a YAML indicator and contains no ':' / '#' /
// newline / flow punctuation (first cut — real YAML permits ':' mid-scalar and trailing ' #').
const Plain = token(/[^\s\-?:,\[\]{}#&*!|>'"%@`][^:#\n,\[\]{}]*/, { scope: 'string.unquoted.yaml' });

const Scalar = rule(() => [DQuote, SQuote, Plain]);

// A node (a value in any context): optional anchor/tag prefix, then a collection, alias, or a
// scalar-led form. The scalar-led branch is LEFT-FACTORED: parse one scalar, then a trailing
// ':' decides whether it is a block mapping (this scalar is the first key) or a bare scalar —
// so BlockMapping and Scalar no longer share a FIRST token (which made the parser pick wrong).
const Node = rule(() => [
  [opt(Anchor), opt(Tag), alt(BlockSequence, FlowMapping, FlowSequence, Alias, MappingOrScalar)],
]);

// Scalar, optionally continued as a block mapping when a ':' follows.
const MappingOrScalar = rule(() => [
  [Scalar, opt(':', opt(Value), many(Newline, MapEntry))],
]);
// Subsequent mapping entries (the first key+':' is consumed by MappingOrScalar above).
const MapEntry = rule(() => [[Scalar, ':', opt(Value)]]);
// A value after `:` (or `-`) is either an indented block (INDENT … DEDENT) or an inline node.
const Value = rule(() => [[Indent, Node, Dedent], Node]);

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
const Stream = rule(() => [many(alt(DocStart, DocEnd, Node))]);

const indent: IndentConfig = {
  indentToken: 'Indent',
  dedentToken: 'Dedent',
  newlineToken: 'Newline',
  flowOpen: ['[', '{'],
  flowClose: [']', '}'],
  comment: '#',
};

export default defineGrammar({
  name: 'yaml',
  scopeName: 'source.yaml',
  tokens: { DocStart, DocEnd, Comment, DQuote, SQuote, Anchor, Alias, Tag, Plain, Indent, Dedent, Newline },
  // NOTE: the parser's entry rule is the LAST rule declared here (findEntryRule = rules[last]),
  // so `Stream` must come last.
  rules: {
    Node, MappingOrScalar, MapEntry, Value, BlockSequence, SeqItem,
    FlowMapping, FlowEntry, FlowValue, FlowScalarOrNode, FlowSequence, Scalar, Stream,
  },
  entry: Stream,
  indent,
});
