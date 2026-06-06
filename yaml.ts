// yaml.ts — YAML on the shared Monogram core, using the engine's opt-in INDENTATION mode
// (`indent` config → the lexer emits INDENT/DEDENT/NEWLINE; see src/gen-lexer.ts). This is the
// first grammar that is indentation-sensitive rather than a token stream or markup.
//
// First-cut coverage: block + flow mappings & sequences, plain / single / double-quoted scalars,
// anchors (&a) / aliases (*a) / tags (!!t), comments (#), document markers (--- / ...).
// KNOWN first-cut gaps (the src-coverage metric localizes them against yaml-test-suite):
//   block scalars (`|`, `>`), plain scalars containing ':' (e.g. URLs) or trailing '# comment',
//   explicit/complex keys (`? key`), multi-line plain scalars, directives (`%YAML`).
import {
  token, rule, defineGrammar, alt, many, many1, opt, not, noCommentBefore, noMultilineFlowBefore,
  lit, seq, oneOf, noneOf, range, star, plus, repeat, followedBy, notFollowedBy,
  precededBy, notPrecededBy, never, end,
} from './src/api.ts';
import type { IndentConfig } from './src/types.ts';

// ── Structural tokens emitted by the lexer's indentation state machine. They are NEVER
// regex-matched (the patterns are placeholders — `(?!)` never matches); the lexer emits them
// and skips them in the regex loop via gen-lexer's indentTokenNames. The grammar references
// them like ordinary tokens (the parser matches by token TYPE). ──
const Indent = token(never(), {});
const Dedent = token(never(), {});
const Newline = token(never(), {});

// ── Scalars & lexical tokens (declaration order matters: earlier wins) ──
const hspace = oneOf(' ', '\t');
const lineBreak = seq(opt(lit('\r')), '\n');
const digit = range('0', '9');
const hexDigit = oneOf(digit, range('A', 'F'), range('a', 'f'));
const whitespace = oneOf('\t', '\n', '\f', '\r', ' ');
const nonWhitespace = noneOf(whitespace);
const hashAfterNonSpace = seq('#', precededBy(seq(nonWhitespace, '#')));
const DocStart = token(lit('---'), { scope: 'punctuation.definition.directives-end' });
const DocEnd = token(lit('...'), { scope: 'punctuation.definition.document-end' });
const Comment = token(seq('#', star(noneOf('\n'))), { skip: true, scope: 'comment.line.number-sign' });
// Double-quoted scalar body. The escape set is FIXED (YAML 1.2 §5.7): a `\` may only precede one
// of `0 a b t n v f r e " / \ N _ L P`, a literal space/tab, a `x`+2 / `u`+4 / `U`+8 hex escape, or
// a LINE BREAK (`\`-at-EOL = line continuation). Any other `\.` (`\.`, `\'`, `\q`, `\x4`) is illegal
// — validating the set rejects `55WF`/`HRE5`, and admitting `\`+newline accepts the folded
// multi-line scalars `565N`/`NP9H`/`Q8AD` (where the old `\\.` failed because `.` skips newlines).
const DQ_ESC = seq('\\', alt(
  oneOf('0', 'a', 'b', 't', 'n', 'v', 'f', 'r', 'e', '"', '/', '\\', 'N', '_', 'L', 'P', ' ', '\t'),
  seq('x', repeat(hexDigit, 2, 2)),
  seq('u', repeat(hexDigit, 4, 4)),
  seq('U', repeat(hexDigit, 8, 8)),
  lineBreak,
));
const DQuote = token(seq('"', star(alt(DQ_ESC, noneOf('"', '\\'))), '"'), { string: true, scope: 'string.quoted.double' });
const SQuote = token(seq("'", star(alt(seq("'", "'"), noneOf("'"))), "'"), { string: true, scope: 'string.quoted.single' });
const Anchor = token(seq('&', plus(noneOf(whitespace, '[', ']', '{', '}', ','))), { scope: 'entity.name.type.anchor' });
const Alias = token(seq('*', plus(noneOf(whitespace, '[', ']', '{', '}', ','))), { scope: 'variable.other.alias' });
const Tag = token(seq('!', alt(seq('<', star(noneOf('>')), '>'), star(noneOf(whitespace, '[', ']', '{', '}', ',')))), { scope: 'storage.type.tag' });
// The `%YAML` version directive has a FIXED arity: exactly one `major.minor` parameter (§6.8.1).
// A spaced trailing `# comment` is allowed; any other trailing token (`%YAML 1.2 foo`, a second
// version `%YAML 1.1 1.2`) is illegal. Declared BEFORE the generic Directive so a well-formed
// `%YAML X.Y` is taken here and trailing junk is LEFT for the parser to reject (it can't follow a
// directive). `%YAML1.2` (no space) is NOT a version directive — it falls to the generic Directive
// (an unknown directive named `YAML1.2`, which the `yaml` oracle accepts). Rejects H7TQ / ZYU8.
// Matches just `%YAML major.minor`, then a LOOKAHEAD requires the rest of the line to be only
// whitespace / a comment / EOL — a directive owns its whole line, so trailing junk (`%YAML 1.2 foo`,
// a second version `%YAML 1.1 1.2`) makes the lookahead FAIL and the token not match. The generic
// Directive below EXCLUDES the `%YAML␣` prefix, so such a malformed version line matches NEITHER
// token and the stray `%` then fails to lex → reject (H7TQ / ZYU8). The trailing comment is left
// OUTSIDE the token (only looked at) so a ` # comment` is tokenised/scoped as a Comment, not folded
// into the directive — keeps the highlighter's comment scope intact.
const YamlDirective = token(seq('%YAML', plus(hspace), plus(digit), '.', plus(digit), followedBy(seq(star(hspace), alt(lit('#'), '\r', '\n', end())))), { scope: 'keyword.other.directive', blockOnly: true });
// Directive (`%TAG …`, unknown `%FOO …`): runs to EOL but stops before a ` #` trailing comment — a
// `#` is a comment indicator only after whitespace, so a glued `#` (`%YAML 1.1#x`) stays part of
// the directive while a spaced ` # comment` falls to the Comment token (same rule as plain scalars).
// EXCLUDES the `%YAML␣` version form (handled by YamlDirective above) so a bad-arity version line is
// not silently re-absorbed here; `%YAML1.2` (no space) is NOT the version form, so it still matches.
const Directive = token(seq('%', notFollowedBy(seq('YAML', hspace)), star(alt(noneOf('\n', '#'), hashAfterNonSpace))), { scope: 'keyword.other.directive', blockOnly: true });
// Block scalar (| / >): EMITTED by the lexer's block-scalar mode (placeholder pattern, skipped
// in the regex loop) so the more-indented content lines arrive as a single token.
const BlockScalar = token(never(), { scope: 'string.unquoted.block' });
// Plain-scalar shapes shared by the key / number / boolean tokens below. The BODY is the same
// run of characters the general Plain scalar matches; the leading-char and the trailing context
// are what split a key (LHS of `: `) and a typed value (number / boolean / null) off the generic
// string-valued plain scalar — a finer SCOPE for the highlighter, while the parser still treats
// every one as a Scalar (they are all added to the `Scalar` rule, so the parse tree is unchanged).
const plainHeadChar = noneOf(whitespace, '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', "'", '"', '%', '@', '`');
const PLAIN_HEAD = alt(plainHeadChar, seq(oneOf('-', '?', ':'), followedBy(noneOf(whitespace, ',', '[', ']', '{', '}'))));
// A `#` is a COMMENT indicator only at line start or after whitespace; inside a plain scalar a
// `#` glued to a non-space char is ordinary content (`this is#not` is ONE key, `http://a#b` is a
// URL). So the body keeps a `#` whose preceding char is non-space — `#(?<=\S#)` matches the `#`
// then asserts the two chars ending here are «non-space»«#» — while ` #…` (space-prefixed) still
// ends the scalar and falls to the Comment token.
const plainBodyChar = noneOf(':', '#', '\n', ',', '[', ']', '{', '}');
const PLAIN_BODY = star(alt(plainBodyChar, seq(':', followedBy(noneOf(whitespace, ',', ']', '}'))), hashAfterNonSpace));
// BLOCK-context variants (used by the lexer only outside flow — see TokenDecl.blockPattern). The
// chars `,[]{}` are flow indicators ONLY inside a flow collection; in block context they are plain
// scalar content (`key: a,b`, `- bla]keks` are one scalar each; yaml-test-suite FBC9 / AZW3 / DBG4
// / S7BG / 2EBW). So the block body drops the `,[]{}` exclusions, and a `:` is content whenever it
// is followed by ANY non-space (only a `: `/`:`-EOL still ends the scalar as a key/value separator).
// A leading `[`/`{` still starts a FLOW collection and `,`/`]`/`}` are still illegal scalar STARTS,
// so the leading-char set is unchanged; only the `-?:` head loosens to allow a following flow char.
const PLAIN_HEAD_BLOCK = alt(plainHeadChar, seq(oneOf('-', '?', ':'), followedBy(noneOf(whitespace))));
const PLAIN_BODY_BLOCK = star(alt(noneOf(':', '#', '\n'), seq(':', followedBy(noneOf(whitespace))), hashAfterNonSpace));
// A plain scalar is a mapping KEY when a `:` key-separator (colon + whitespace / EOL, or—inside a
// flow collection—colon + `,`/`]`/`}`) follows it. Matched BEFORE the value/number tokens so a
// numeric-looking key (`123:`) is still a key (entity.name.tag), as the `yaml` oracle resolves it.
// A PLAIN scalar needs the colon to be followed by whitespace/EOL/flow-indicator, because a bare
// `:` glued to more text is plain-scalar content (`foo:bar` is one scalar, `http://x` a URL).
const KEY_SEP = followedBy(seq(star(hspace), ':', alt(whitespace, ',', '[', ']', '{', '}', end())));
// A QUOTED scalar, by contrast, is a mapping KEY whenever ANY `:` follows it (after optional
// spaces) — `"x":v` (glued) and `"x": v` are both keys, and a quoted scalar can never run past its
// closing quote, so the colon is always the entry separator, never scalar content. (In valid YAML a
// quoted scalar immediately followed by `:` is ALWAYS a key — verified against the `yaml` package:
// the only `"x":y` shapes it rejects are block-context errors, which the grader excludes. This is
// what colours the JSON-style flow key `{"foo":bar}` / `["k":v]`, vscode#203212 / yaml-test-suite
// C2DT·5T43·4MUZ.) Spaced/EOL still match (`(?=[\t ]*:)` covers `"x" : v` and `"x":`).
const QKEY_SEP = followedBy(seq(star(hspace), ':'));

// Plain scalar that is a mapping key → entity.name.tag (the YAML convention for a key name).
const Key = token(
  seq(PLAIN_HEAD, PLAIN_BODY, KEY_SEP),
  { scope: 'entity.name.tag', blockPattern: seq(PLAIN_HEAD_BLOCK, PLAIN_BODY_BLOCK, KEY_SEP) },
);
// Double-quoted scalar in KEY position (a `"…"` immediately followed by a `:` key-separator). An
// implicit key — a quoted scalar that is a mapping key — must be on a SINGLE line (§7.4.2 / the
// 1024-char implicit-key limit), so the KEY-position body forbids a real line break: the escape set
// drops the `\`-at-EOL line continuation and the unescaped class excludes `\n`/`\r`. A MULTI-LINE
// quoted scalar before a `:` therefore does NOT match the key token — it lexes as the plain DQuote
// value below (no `:` lookahead), so the block-key rule paths (which take only the key tokens) leave
// the `:` unconsumed → reject (yaml-test-suite 7LBH/D49Q/JKF3 multi-line block keys; the flow-seq
// single-pair multi-line key DK4H likewise). A multi-line quoted VALUE (`key: "a\nb"`) is unaffected
// (it isn't in key position). The escaped `\n` form (`"a\\nb":`, a literal backslash-n) stays a
// single-line key. Flow MAPPING keys come via FlowNode→DQuote (not this token), so `{ "a\nb": 1 }`
// — a legal multi-line flow-map key — is also unaffected.
const DQ_ESC_NONL = seq('\\', alt(
  oneOf('0', 'a', 'b', 't', 'n', 'v', 'f', 'r', 'e', '"', '/', '\\', 'N', '_', 'L', 'P', ' ', '\t'),
  seq('x', repeat(hexDigit, 2, 2)),
  seq('u', repeat(hexDigit, 4, 4)),
  seq('U', repeat(hexDigit, 8, 8)),
));
const DQuoteKey = token(
  seq('"', star(alt(DQ_ESC_NONL, noneOf('"', '\\', '\r', '\n'))), '"', QKEY_SEP),
  { string: true, scope: 'entity.name.tag' },
);
// Single-quoted scalar in KEY position (single-line — see DQuoteKey).
const SQuoteKey = token(
  seq("'", star(alt(seq("'", "'"), noneOf("'", '\r', '\n'))), "'", QKEY_SEP),
  { string: true, scope: 'entity.name.tag' },
);

// Value end-boundary for typed plain scalars (number / boolean / null): the scalar must be the
// WHOLE node, so it is followed by whitespace+comment, an end-of-value char (EOL / `,` / `]` /
// `}`), or a key-separator `:`. Mirrors the maintained RedCMD grammar's core-schema lookaheads.
const VALUE_END = followedBy(alt(
  seq(plus(hspace), '#'),
  seq(star(hspace), alt('\r', '\n', ',', '[', ']', '{', '}', seq(':', alt(whitespace, ',', '[', ']', '{', '}', end())))),
  end(),
));
// BLOCK-context value end-boundary: outside flow, `,`/`[`/`]`/`{`/`}` are NOT value terminators, so
// a typed look-alike GLUED to one is a plain string, not a number/bool (`key: 1,2` is the string
// "1,2", not the number 1 — yaml-test-suite DBG4). Dropping them lets such scalars fall through to
// the (block) Plain token; only ws+comment, a line break, or a `:`-separator still ends the value.
const VALUE_END_BLOCK = followedBy(alt(
  seq(plus(hspace), '#'),
  seq(star(hspace), alt('\r', '\n', seq(':', alt(whitespace, end())))),
  end(),
));
// A NON-SPECIFIC tag (`!` followed by whitespace) forces its plain scalar to resolve as a STRING
// regardless of the scalar's appearance (`! 12` is the string "12", not the number 12 — YAML 1.2
// §6.9.1 / yaml-test-suite S4JQ). So the typed value tokens (Num / BoolNull) MUST NOT fire on a
// scalar that is glued to a leading `!␣` tag — the negative lookbehind drops them so the scalar
// falls through to the generic Plain (`string.unquoted`). A *specific* tag (`!!int 12`, `!!bool …`)
// puts non-space chars between the `!` and the value, so this lookbehind leaves those untouched —
// they keep resolving by appearance, matching what the `yaml` oracle reports. TextMate 2.0 Onigmo
// rejects variable-length lookbehind, so this is a bounded set of fixed-width guards.
const NONSPECIFIC_TAG = seq(...Array.from({ length: 16 }, (_, index) =>
  notPrecededBy(seq('!', repeat(hspace, index + 1, index + 1))),
));
// Numeric plain scalars (YAML 1.2 core schema): decimal / octal / hex integers, floats, ±.inf,
// .nan. Anything outside the core schema (binary `0b…`, dates, `12:34:56`) stays a plain string,
// matching what the `yaml` oracle resolves to a number.
const sign = oneOf('+', '-');
const NUM_BODY = seq(NONSPECIFIC_TAG, alt(
  seq(opt(sign), '.', alt(lit('inf'), 'Inf', 'INF')),
  seq('.', alt(lit('nan'), 'NaN', 'NAN')),
  seq('0x', plus(hexDigit)),
  seq('0o', plus(range('0', '7'))),
  seq(opt(sign), alt(seq('.', plus(digit)), seq(plus(digit), opt(seq('.', star(digit))))), opt(seq(oneOf('e', 'E'), opt(sign), plus(digit)))),
));
const Num = token(
  seq(NUM_BODY, VALUE_END),
  { scope: 'constant.numeric', blockPattern: seq(NUM_BODY, VALUE_END_BLOCK) },
);
// Boolean / null plain scalars (core schema) → constant.language. Same non-specific-tag guard:
// `! true` is the string "true", not the boolean (yaml-test-suite cousins of S4JQ).
const BOOLNULL_BODY = seq(NONSPECIFIC_TAG, alt(lit('true'), 'True', 'TRUE', 'false', 'False', 'FALSE', 'null', 'Null', 'NULL', '~'));
const BoolNull = token(
  seq(BOOLNULL_BODY, VALUE_END),
  { scope: 'constant.language', blockPattern: seq(BOOLNULL_BODY, VALUE_END_BLOCK) },
);

// Plain scalar. Leading char: a non-indicator, OR one of `- ? :` when followed by a non-space
// (so `-1`, `?x`, `::v` are plain, but `- `, `? `, `: ` stay indicators). Body: the shared
// PLAIN_BODY (any non `:`/`,`/flow char, plus `:` not before space/`,`/`]`/`}`, plus a `#` glued
// to a non-space) — so `http://x`, `key:val` and `this is#not` are single plain scalars.
const Plain = token(
  seq(PLAIN_HEAD, PLAIN_BODY),
  { scope: 'string.unquoted', blockPattern: seq(PLAIN_HEAD_BLOCK, PLAIN_BODY_BLOCK) },
);

// A Scalar is any of the above scalar SHAPES. The key / number / boolean tokens are finer
// HIGHLIGHTING splits of the generic quoted/plain scalars; the parser accepts them all wherever
// a scalar is legal, so the parse tree (and the src-coverage metric) is unchanged.
const Scalar = rule(() => [DQuoteKey, SQuoteKey, DQuote, SQuote, BlockScalar, Key, Num, BoolNull, Plain]);
// A scalar eligible to be a BLOCK-mapping KEY: the SINGLE-LINE shapes only. An implicit key must be
// on one line, so the multi-line-capable DQuote/SQuote value tokens and the multi-line BlockScalar
// are excluded — a single-line quoted key always lexes as the (now newline-free) DQuoteKey/SQuoteKey,
// while a multi-line quoted scalar before `:` lexes as DQuote and so is NOT a key here, leaving the
// `:` unconsumed → reject (7LBH/D49Q/JKF3). Used by every block-key path (MappingOrScalar key arm,
// MappingFromScalar, BlockKey); flow-key paths keep their own tokens.
const BlockKeyScalar = rule(() => [DQuoteKey, SQuoteKey, Key, Num, BoolNull, Plain]);

// A NODE PROPERTY: an anchor and/or tag, in either order (`&a`, `!!t`, `&a !!t`, `!!t &a`).
// At least one is present (a bare node with no property is parsed by ContentNode). A property
// may be the WHOLE node (its content empty → a null/empty value): `&x` / `!!str` are valid nodes.
const Property = rule(() => [[Anchor, opt(Tag)], [Tag, opt(Anchor)]]);
// A node WITHOUT a property prefix: the bare content shapes. Split out so a property-led node
// (Property + content) and a bare node are FIRST-disjoint (Property begins with `&`/`!`,
// ContentNode with `-`/`?`/`{`/`[`/`*`/a scalar) — the parser never has to guess between them.
const ContentNode = rule(() => [alt(BlockSequence, ExplicitMapping, EmptyKeyMapping, FlowMapping, FlowSequence, MappingFromFlow, AliasOrKeyed, MappingOrScalar)]);

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
  // MappingFromFlow precedes the bare FlowMapping/FlowSequence: this is a NESTED alt (first-match,
  // not longest), so the flow-keyed-mapping form must be tried before the bare-flow form. It fails
  // fast when no `:` follows the flow, so a bare flow node still falls through to FlowMapping/Sequence.
  BlockSequence, ExplicitMapping, EmptyKeyMapping, MappingFromFlow, FlowMapping, FlowSequence, AliasOrKeyed, MappingOrScalar,
] as const;
// `not('-')` after the property: a block SEQUENCE may not begin INLINE after a node property — a
// `-` indicator must start a fresh line, so `&anchor - seq` / `!!seq - a` are illegal (the valid
// form has a Newline between, `&seq\n- a`, which the `[Newline, Node]` content branch matches; a
// numeric `-1` lexes as one Num/Plain token, not a `-` literal, so `&a -1` is unaffected). The
// guard fires only when a property is present, so the BARE inline block sequence (`- a`, no
// property) is matched by its own dedicated last branch below. yaml-test-suite SY6V.
const Node = rule(() => [
  [opt(Anchor), opt(Tag), not('-'), opt(alt(...nodeContentAlts()))],
  [Tag, Anchor, not('-'), opt(alt(...nodeContentAlts()))],
  BlockSequence,
]);

// A multi-line PLAIN scalar folded across an indented continuation: an unquoted scalar (plain /
// numeric-looking / bool-looking — a multi-line continuation makes them all plain strings, so
// `1\n more` is the string "1 more", yaml-test-suite cousins of A984) followed by an INDENTED run
// of further plain lines (`Indent Plain (Newline Plain)* Dedent`). The Indent/Dedent BOUND the
// fold, so it cannot run past the scalar's block — safe (no over-accept). A QUOTED scalar does NOT
// fold this way (`key: "x"\n  more` is illegal), so the head is the unquoted family only, never the
// quoted/block tokens. Each continuation line is guarded by `noCommentBefore`: a comment ENDS a
// plain scalar, so a line that follows a comment (an inline `b # c`, or a `# …` line between the
// scalar's lines) must NOT be folded in (yaml-test-suite 8XDJ / BF9H). yaml-test-suite 36F6 / A984
// / 4CQQ / 4ZYM.
// The `noCommentBefore` guards sit on the STRUCTURAL token (Indent / Newline), since the lexer
// stamps the comment flag onto the first token it emits after a skipped comment — which is that
// Indent / Newline, not the following Plain.
const foldedPlain = () => [alt(Num, BoolNull, Plain), noCommentBefore, Indent, alt(Num, BoolNull, Plain), many(noCommentBefore, Newline, alt(Num, BoolNull, Plain)), Dedent] as const;
// A SAME-COLUMN multi-line plain scalar that is the SOLE LEADING content of an INDENTED block
// (`key:\n  a\n  b` → "a b"; yaml-test-suite 4CQQ / RZT7 / UGM3). The continuation lines sit at the
// scalar's own column, bounded by the block's Indent/Dedent. Written as a whole `Indent … Dedent`
// (not just the inner run) and added as a sibling of the plain `[Indent, Node, Dedent]` value
// branch: the parser's longest-match picks this when the block's first node is a plain scalar with
// ≥1 same-column continuation line, and falls back to `[Indent, Node, Dedent]` otherwise. Because it
// requires the unquoted scalar to be the block's FIRST token, it never fires on a block that opens
// with a sequence / mapping (`key:\n - a\n - b\n invalid` keeps the trailing `invalid` unconsumed →
// reject, as the oracle requires). many1 = at least one continuation. Comment-guarded like
// foldedPlain. This is the in-block (bounded) same-column fold ONLY; the doc-level same-column fold
// is deliberately NOT modelled (it over-accepts `a: b\nc` / `- a\n- b\nc` and can't be CFG-gated).
const foldedPlainBlock = () => [Indent, alt(Num, BoolNull, Plain), many1(noCommentBefore, Newline, Plain), Dedent] as const;
// A DOCUMENT-BODY same-column (and across-indent) multi-line plain scalar fold: an unquoted scalar
// followed by ≥1 continuation that is either a SAME-column line (`Newline Plain`) or a more-indented
// run (`Indent Plain (Newline Plain)* Dedent`). At document-body level (no enclosing key/item) a
// same-column `Newline Plain` is a CONTINUATION of the scalar, not a sibling — `---word1\nword2`,
// `a\nb\n  c\nd\n\ne`, the directive-looking `---\nscalar\n%YAML 1.2` (the `%…` line folds as plain
// content), etc. (yaml-test-suite 82AN/9YRD/EX5H/EXG3/HS5T/XLQ9/M7A3). This is reachable ONLY from
// document-body positions; in a VALUE/ITEM position a same-column `Newline Plain` IS a sibling, so
// putting this in the shared MappingOrScalar would over-accept `a: b\nc` / `- a\n- b\nc`. The
// continuation must be a bare `Plain`: a `b: c` line lexes `b` as the Key token (a `:` follows), so
// it does NOT extend the fold and a structural continuation stays a reject (the FP gate). Each
// continuation is `noCommentBefore`-guarded — a comment ENDS a plain scalar (a `# …` line, or an
// inline `b # c`, must not be folded in). many1 ⇒ a bare single scalar is NOT a fold (it stays the
// ordinary Scalar/Node path), so DocFold only ever fires on a genuine ≥2-line plain scalar.
// A continuation LINE of a fold: a bare `Plain`, or a `%…` line that the lexer eagerly tokenised as
// a directive but which — because it follows a plain-scalar line inside a document body — is actually
// plain CONTENT (`---\nscalar\n%YAML 1.2`, XLQ9 — the "unmodeled doc fold" the directive-in-body
// rejection deliberately leaves; a `%…` as the FIRST body token has no preceding scalar so DocFold
// never reaches it and it stays a reject). The directive tokens carry no real key separator, so they
// can only ever be folded content here, never reintroduce a structural mapping.
const foldLine = () => alt(Plain, YamlDirective, Directive);
const DocFold = rule(() => [
  [alt(Num, BoolNull, Plain), many1(alt(
    [noCommentBefore, Newline, foldLine()],
    [noCommentBefore, Indent, foldLine(), many(noCommentBefore, Newline, foldLine()), Dedent],
  ))],
]);
// Scalar, optionally continued as a block mapping when a ':' follows. UN-FACTORED into a key arm
// (a SINGLE-LINE BlockKeyScalar then a required `:`) and a bare-value arm (any Scalar shape): a
// multi-line quoted scalar before `:` is not a BlockKeyScalar, so it falls to the value arm and the
// trailing `:` is left unconsumed → reject (7LBH/D49Q/JKF3). The parser's longest-match prefers the
// key arm for a single-line `key:` (it consumes more), so single-line mappings are unchanged.
const MappingOrScalar = rule(() => [
  foldedPlain(),
  [BlockKeyScalar, ':', opt(MapValueScalar), many(Newline, MapEntry)],
  Scalar,
]);
// An ALIAS, optionally continued as a block mapping when a ':' follows — an alias may be a
// block-mapping key (`*b : *a`; yaml-test-suite E76Z / 6M2F). Left-factored like MappingOrScalar so
// the bare-alias node and the alias-keyed mapping share no FIRST token (both begin with `*`; the
// trailing ':' decides).
//
// NOTE: a FLOW collection as a block-mapping KEY (`[a,b]: v`, `{}: c`; LX3P / 4FJ6) is modelled in
// BlockKey, not here (a flow opens with `[`/`{`, disjoint from the alias `*`). YAML requires an
// implicit key — flow-collection keys included — to be on a SINGLE line; the lexer DOES preserve
// that information (it stamps `multilineFlowBefore` on the token after a multi-line flow's close),
// so the single-line form (`[a,b]: v`) accepts and the multi-line form (`[23\n]: 42`, C2SP) is
// rejected by BlockKey's `noMultilineFlowBefore` guard. The bare flow collection is also a valid
// VALUE/node (FlowMapping/FlowSequence via ContentNode).
const AliasOrKeyed = rule(() => [
  [Alias, opt(':', opt(MapValueScalar), many(Newline, MapEntry))],
]);
// A block-mapping KEY: a plain/quoted scalar optionally carrying its OWN anchor/tag property
// (`&anchor c: 3` ZWK4, `!!str baz : …` HMQ5) — OR a bare ALIAS (`*b : v`, yaml-test-suite E76Z) —
// OR a single-line FLOW collection (`[flow]: v`, `{a: 1}: v`; LX3P / Q9WF / 6BFJ). An alias key may
// NOT take a property (`&b *alias` / `!!str *alias` are illegal — an alias is a reference,
// yaml-test-suite SU74), so it is a distinct branch with no property. A flow-collection key MUST be
// on ONE line (§7.4.2): the lexer stamps `multilineFlowBefore` on the token after a multi-line flow's
// close, and the `noMultilineFlowBefore` guard (checking the following `:`) rejects the multi-line
// form (`[23\n]: 42`, C2SP) while the single-line form accepts. A flow key may carry its own property
// (`&key [ … ]: v`, 6BFJ). Used by every implicit mapping entry.
const BlockKey = rule(() => [
  [opt(Property), BlockKeyScalar],
  Alias,
  [opt(Property), alt(FlowMapping, FlowSequence), noMultilineFlowBefore],
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
  [BlockKey, ':', opt(MapValueScalar)],
  ExplicitEntry,
  [':', opt(MapValueScalar)],
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
  [':', opt(MapValueScalar), many(Newline, MapEntryNoEmpty)],
]);
// A mapping entry that is NOT an empty-key entry (implicit `key: value` or explicit `? …`). Used as
// the continuation of an empty-key-led mapping to bar a second empty key (see EmptyKeyMapping).
const MapEntryNoEmpty = rule(() => [
  [BlockKey, ':', opt(MapValueScalar)],
  ExplicitEntry,
]);
// A SEQUENCE-item value (after `-`): an indented block, or an inline/empty node — including a
// compact inline block sequence (`- - a` is valid YAML). A property's same-column-after-newline
// content does NOT continue here (`- &x\n- 1` is two items, the first empty), so the property
// leads only to an INDENTED block or an inline value, never a [Newline, …] tail.
const Value = rule(() => [foldedPlainBlock(), [Indent, Node, Dedent], SeqValueNode]);
// A MAPPING value (after `:`): an indented block, or an inline/empty node that is NOT a block
// sequence — YAML forbids `key: - a` on one line (a block seq must begin on the next line). A
// property here may be followed by an INDENTED block (`a: !!seq\n  - x`) or be EMPTY (`a: &x\nb: c`
// → value null, `b` a sibling); a same-column line is the sibling, never the value.
//
// EXCEPTION: a block SEQUENCE may sit at the SAME column as its parent key and still be that key's
// value (`key:\n- a\n- b`; YAML's one structural same-column allowance — a mapping/scalar value
// MUST instead indent, but a `-`-led sequence need not). The `[Newline, BlockSequence]` branch is
// reachable only when the inline value was empty (an inline value emits its token before the
// Newline, so this branch's leading Newline can't match), so `key: v\n- a` stays a reject.
// yaml-test-suite AZ63 / RLU9 / 7ZZ5. The `[Indent, Property, Dedent, Newline, BlockSequence]`
// branch is the same allowance when the value carries a property on its own (more-indented) line
// and the sequence then dedents to the parent column (`seq:\n &anchor\n- a`; SKE5) — the property
// must indent (a col-0 `&a` is a reject), but its sequence content may share the key's column. The
// `[Property, Newline, BlockSequence]` branch is the INLINE-property form (`sequence: !!seq\n- a`;
// 57H4) — the property sits on the key's line, the sequence at the key's column. All three require
// a `-`-led sequence; a same-column scalar/mapping still goes through the sibling path.
const MapValue = rule(() => [foldedPlain(), foldedPlainBlock(), [Indent, Node, Dedent], [Indent, Property, Dedent, ContentNode], [Indent, Property, Dedent, Newline, BlockSequence], [Property, Newline, BlockSequence], [Newline, BlockSequence], MapValueNode]);
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
const CollectionContent = rule(() => [alt(BlockSequence, ExplicitMapping, FlowMapping, FlowSequence, MappingFromFlow, MappingFromScalar)]);
const MappingFromScalar = rule(() => [[BlockKeyScalar, ':', opt(MapValueScalar), many(Newline, MapEntry)]]);
// A block mapping whose FIRST entry's KEY is a single-line FLOW collection (`[a,b]: v`, `{x:1}: v`;
// yaml-test-suite LX3P / Q9WF / 6BFJ). The analogue of MappingFromScalar for a flow key: the flow
// collection, then a `:`-led entry, then any further entries. The `noMultilineFlowBefore` guard (on
// the following `:`) keeps it SINGLE-LINE — a multi-line flow key (`[23\n]: 42`, C2SP) is rejected.
// Property-less (a leading `&a`/`!t` on the key node is consumed by the caller, e.g. Node — 6BFJ).
const MappingFromFlow = rule(() => [[alt(FlowMapping, FlowSequence), noMultilineFlowBefore, ':', opt(MapValueScalar), many(Newline, MapEntry)]]);
// A node in MAP-VALUE position (after `:`): a property whose content is inline, INDENTED, or
// EMPTY (no same-column [Newline, …] tail — that line is a sibling); OR a bare inline content
// node (flow/alias/scalar-led). NEVER an inline block sequence (`key: - a` is invalid YAML).
// `not(Alias)` after the property: an ALIAS is a pure reference and cannot carry an anchor/tag, so
// a property glued to an inline alias (`key2: &b *a`) is illegal (yaml-test-suite SR86). The bare
// (property-less) inline alias stays legal via the second branch (MapInlineContent → Alias).
const MapValueNode = rule(() => [
  [Property, not(Alias), opt(alt([Indent, IndentedValueNode, Dedent], MapInlineContent))],
  MapInlineContent,
]);
const MapInlineContent = rule(() => [alt(FlowMapping, FlowSequence, Alias, MappingOrScalar)]);
// An IMPLICIT (`key: …`) or EMPTY-KEY (`: …`) value's INLINE content, restricted to SCALARS — never a
// compact mapping. YAML forbids a nested mapping as a compact (same-line) implicit/empty-key value:
// `a: b: c` and `: b: c` are "Nested mappings are not allowed in compact mapping" errors (yaml-test-suite
// ZCZ6 / ZL4Z). Only an EXPLICIT `? key`'s `:`-value may be a compact mapping (`? k\n: moon: white`,
// V9D5) — that path keeps the full MapValue. So this drops MappingOrScalar's compact-mapping branch,
// keeping its scalar / fold shapes plus flow / alias (`a: {x:1}`, `a: *x`, `a: hello world` stay legal).
const MapInlineScalar = rule(() => [alt(FlowMapping, FlowSequence, Alias, foldedPlain(), Scalar)]);
const MapValueNodeScalar = rule(() => [
  [Property, not(Alias), opt(alt([Indent, IndentedValueNode, Dedent], MapInlineScalar))],
  MapInlineScalar,
]);
// The IMPLICIT / EMPTY-KEY map value: every block / next-line-indented MapValue branch (where a nested
// mapping IS legal — `a:\n  b: c`), but the trailing INLINE node is scalar-only (no same-line compact
// mapping). The EXPLICIT `? key` value path keeps the full MapValue (compact mapping allowed there).
const MapValueScalar = rule(() => [foldedPlain(), foldedPlainBlock(), [Indent, Node, Dedent], [Indent, Property, Dedent, ContentNode], [Indent, Property, Dedent, Newline, BlockSequence], [Property, Newline, BlockSequence], [Newline, BlockSequence], MapValueNodeScalar]);
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
  [Property, opt(alt([Indent, DocFold, Dedent], [Indent, Node, Dedent], [Newline, DocFold], [Newline, Node], FlowMapping, FlowSequence, Alias, Scalar))],
  DocFold,
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
// A DIRECTIVE may NOT appear inside a `---` document body — it heads a NEW document and so only
// follows a `...` end marker (the `AfterDocEnd` `...`-then-directives path). The earlier in-body
// `many(directive)` allowance here was redundant with that path AND over-accepted a directive as the
// first body token (`%YAML 1.2\n---\n%YAML 1.2\n---`, yaml-test-suite MUS6). A doc-level `%…` line
// that is actually a plain scalar (`---\nscalar\n%YAML 1.2`, XLQ9) folds via the doc-body plain fold,
// not via this rule, so dropping the directive allowance does not regress it.
const ExplicitDocBody = rule(() => [
  [Newline, opt(Indent), opt(alt(DocFold, Node)), opt(Dedent)],
  InlineDocNode,
]);

// A document that follows a `...` document-end marker: a fresh `---` document, OR a BARE document
// (no `---`). A bare second document is legal ONLY after a `...` (`a\n...\nb` is two documents;
// yaml-test-suite 7Z25 / M7A3) — never after a plain line (`a\nb` is a single multi-line scalar),
// so the bare-doc branch lives behind a required DocEnd in NextDoc, not at stream top level. The
// bare branch is non-nullable (Node required) so the rule never matches empty (which would return
// null and break the `many`); its absence is handled by the `opt(AfterDocEnd)` caller.
// After `...` a fresh `---` document may be preceded by DIRECTIVES (`...\n%YAML 1.2\n---\n…`,
// `...\n%TAG ! …\n---\n…`; yaml-test-suite 6ZKB / 9DXL / 5TYM / 6WLZ / 9WXW) — a directive block
// applies to the document that follows it. The `many(...)` is zero-or-more so the plain `---`
// (no directives) is still covered by this branch; it can be empty, after which DocStart is
// required, so the branch's FIRST set is {directive, DocStart} — disjoint from the bare-doc Node.
const AfterDocEnd = rule(() => [
  [many(alt(YamlDirective, Directive), opt(Newline)), DocStart, opt(ExplicitDocBody)],
  [opt(Indent), alt(DocFold, Node), opt(Dedent)],
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
// Two top-level shapes:
//   (1) DIRECTIVE-LED — leading `%YAML`/`%TAG` directives apply to the document that follows, which
//       must be an EXPLICIT `---` document (§9.1.1). The `---` doc (and everything after) is OPTIONAL
//       so a directive-only stream that ends at EOF stays valid (`%YAML 1.2\n`, an implied empty
//       document; yaml-test-suite 9MMA) — but when the `---` is ABSENT nothing else may follow, so a
//       bare `...` after the directives (no intervening DocStart) is left unconsumed → reject
//       (yaml-test-suite B63P `%YAML 1.2\n...`). After the first `---`, normal multi-doc continuation.
//   (2) IMPLICIT — no leading directives: an implicit first (bare) document, then the same
//       multi-doc continuation. A bare `...` here is fine (it is the empty first document's end).
const streamTail = () => [many(opt(Newline), NextDoc), opt(Newline), opt(DocEnd), opt(Newline)] as const;
const Stream = rule(() => [
  [many1(alt(YamlDirective, Directive), opt(Newline)), opt(DocStart, opt(ExplicitDocBody), ...streamTail())],
  [opt(Indent), opt(alt(DocFold, Node)), opt(Dedent), ...streamTail()],
]);

const indent: IndentConfig = {
  indentToken: 'Indent',
  dedentToken: 'Dedent',
  newlineToken: 'Newline',
  flowOpen: ['[', '{'],
  flowClose: [']', '}'],
  comment: '#',
  blockScalar: { introducers: ['|', '>'], token: 'BlockScalar', documentMarkers: ['---', '...'] },
  compactIndicators: ['-', '?'],
  // Tag-handle per-document membership (§6.8.2 / §6.9.1): a named handle `!h!` used by a Tag must
  // have been declared by a `%TAG !h! …` directive in the SAME document's prologue (the default `!`
  // and `!!` handles are always valid). `Directive` carries the `%TAG …` declarations; a `---`
  // (DocStart) activates the accumulated prologue for the document it heads; a `...` (DocEnd) resets.
  // A YAML handle is `! ns-word-char* !` (ns-word-char = [0-9A-Za-z-]); the patterns capture it from a
  // tag's leading chars and from a directive's `%TAG␣<handle>` field. (yaml-test-suite QLJ7.)
  tagScope: {
    tagToken: 'Tag',
    directiveTokens: ['Directive'],
    activateTokens: ['DocStart'],
    resetTokens: ['DocEnd'],
    builtinHandles: ['!', '!!'],
    handlePattern: String.raw`^(![0-9A-Za-z-]*!|!)`,
    directiveHandlePattern: String.raw`%TAG[ \t]+(![0-9A-Za-z-]*!|!)`,
  },
};

export default defineGrammar({
  name: 'yaml',
  scopeName: 'source.yaml',
  // Declaration order = lexer precedence (earlier wins). The KEY tokens precede the quoted /
  // value tokens (a numeric- or quoted-looking key is still a key); the typed value tokens
  // (Num, BoolNull) precede the generic Plain so a number / boolean resolves to its own scope.
  tokens: { DocStart, DocEnd, YamlDirective, Directive, Comment, DQuoteKey, SQuoteKey, DQuote, SQuote, Anchor, Alias, Tag, BlockScalar, Key, Num, BoolNull, Plain, Indent, Dedent, Newline },
  // NOTE: the parser's entry rule is the LAST rule declared here (findEntryRule = rules[last]),
  // so `Stream` must come last.
  rules: {
    Property, ContentNode, Node, MappingOrScalar, AliasOrKeyed, BlockKey, ExplicitEntry, MapEntry, MapEntryNoEmpty, ExplicitMapping, EmptyKeyMapping, Value, MapValue, MapValueScalar,
    IndentedValueNode, CollectionContent, MappingFromScalar, MappingFromFlow,
    MapValueNode, MapInlineContent, MapValueNodeScalar, MapInlineScalar, SeqValueNode, SeqInlineContent, BlockSequence, SeqItem,
    FlowNode, FlowExplicit, FlowMapEntry, FlowMapping, FlowSeqEntry, FlowSeqKey, FlowSequence, Scalar, BlockKeyScalar, DocFold, InlineDocNode, ExplicitDocBody, AfterDocEnd, NextDoc, Stream,
  },
  entry: Stream,
  indent,
});
