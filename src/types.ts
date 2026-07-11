export type TokenPattern =
  // A bare string IS a literal pattern. Object variants are discriminated by `type` alone — no
  // `__kind` marker (nothing reads it; walkers switch on `type` after a `typeof` string check).
  | string
  | { type: 'anyChar' }
  | { type: 'charClass'; negate: boolean; items: TokenCharClassItem[] }
  | { type: 'seq'; items: TokenPattern[] }
  | { type: 'alt'; items: TokenPattern[] }
  | { type: 'repeat'; body: TokenPattern; min: number; max?: number; greedy: boolean }
  | { type: 'lookahead'; body: TokenPattern; negate: boolean }
  | { type: 'lookbehind'; body: TokenPattern; negate: boolean }
  | { type: 'anchor'; kind: 'start' | 'end' }
  | { type: 'never' };

export type TokenCharClassItem =
  | { type: 'char'; value: string }
  | { type: 'range'; from: string; to: string };

export interface TokenDecl {
  name: string;
  pattern: TokenPattern;
  flags: string[];
  scope?: string;         // @scope(...) override
  escapePattern?: TokenPattern; // @escape pattern — escape sequence pattern (highlight only)
  interpolation?: StringInterpolation[]; // highlight-only interpolation regions inside a string token (e.g. `${…}` / `$(…)`)
  // Highlight-only: this comment-scoped token matches only the INTRODUCER (e.g. a bare `#`)
  // while the comment runs to end-of-line with content the PARSER still tokenizes (a
  // structured-comment dialect — env-spec decorator comments). Highlighter generators emit a
  // to-end-of-line region carrying this token's comment scope so prose dims like any comment;
  // `richStarters` names tokens that keep FULL token highlighting when one of them (after
  // optional blanks) opens the comment body (`# @decorator(...)`). The lexer/parser are
  // unaffected — exactly like `interpolation`, this is generator metadata.
  // `continuationBrackets`: bracket pairs that, when left OPEN inside a rich comment, continue
  // the construct across consecutive introducer-prefixed lines (env-spec multi-line decorator
  // calls/literals — `# @import(` … `#   KEY1,` … `# )`). Each opens a begin/end region that
  // outlives the line-scoped comment region (a TextMate child region suspends its parent's end),
  // with the line-start introducer scoped as a continuation marker rather than a new comment.
  // `markup`: doc-markup patterns highlighted inside PLAIN comment bodies (declared as
  // token-pattern IR — e.g. `**bold**` / `__italic__` — nothing language-specific here).
  lineComment?: {
    richStarters?: string[];
    continuationBrackets?: [string, string][];
    markup?: { pattern: TokenPattern; scope: string }[];
  };
  escapeValidPattern?: TokenPattern; // one well-formed escape; engine-scanned tokens reject non-matching `\`-escapes (skipped in tag position)
  embed?: string;         // @embed(lang) — embedded language scope name
  // ── Lexer hints (keep the engine language-agnostic; all optional) ──
  identifier?: boolean;          // THE identifier token: engine uses its name for the
                                 // Unicode-identifier fallback and regex division-after context.
  identifierPrefix?: string;     // a prefixed-identifier token (e.g. `#name`): the engine's Unicode
                                 // ID fallback also matches `<prefix>`+non-ASCII-identifier under this name.
  template?: TemplateDelimiters; // a template-literal token: engine tokenizes interpolation holes.
  regexContext?: RegexContext;   // a `regex`-flagged token: when `/` is a regex vs division.
  string?: boolean;              // a string-literal token: its delimiters drive editor auto-close/surround.
  // Block-context pattern variant (indentation grammars only): the pattern the lexer uses OUTSIDE
  // flow collections (flowDepth===0), where chars that are flow indicators (`,`/`[`/`]`/`{`/`}`)
  // are ordinary scalar content. The default `pattern` is the flow-restricted form and is what
  // gen-tm reads, so the highlighter is unaffected; only the PARSER's lexer consults this in block
  // context. (YAML plain scalars: `a,b`/`bla]keks` are one scalar in block, two tokens in flow.)
  blockPattern?: TokenPattern;
  // Block-context ONLY token (indentation grammars only): when set, the lexer matches this token
  // ONLY outside flow collections (flowDepth===0); inside flow its leading indicator is ordinary
  // content. YAML directives (`%YAML`/`%TAG`) are line-structural — a `%` inside `[ ]`/`{ }` is
  // plain scalar content, not a directive (yaml-test-suite UT92 `{ matches\n% : 20 }`). DATA, so
  // the engine stays agnostic (a grammar declaring none is unaffected). Highlight-only generators
  // ignore it (a `%`-led directive in flow is vanishingly rare and the flat TM grammar is unchanged).
  blockOnly?: boolean;
}

/**
 * A highlight-only interpolation region inside a string token (e.g. an env-spec `"…${expr}…"`
 * or `"…$(expr)…"`). The lexer/parser stay token-based — these only tell the highlight
 * generators (TextMate / Monarch / tree-sitter) to re-express the string as nested regions.
 * `begin`/`end` are regex-source fragments; scopes omit the language suffix (generators add it).
 */
export interface StringInterpolation {
  begin: string;          // LITERAL begin delimiter, NOT a regex (e.g. '${'); generators escape it as needed
  end: string;            // LITERAL end delimiter, NOT a regex (e.g. '}')
  beginScope?: string;    // delimiter scope for the opener (without language suffix)
  endScope?: string;      // delimiter scope for the closer (without language suffix)
  contentScope?: string;  // body / container scope (without language suffix)
  include?: string;       // TextMate include inside the body (default '$self')
}

/** Delimiters an interpolated template literal is made of (e.g. JS: `` ` ``, `${`, `}`). */
export interface TemplateDelimiters {
  open: string;        // starts AND ends a template literal (e.g. '`')
  interpOpen: string;  // starts an interpolation hole (e.g. '${')
  interpClose: string; // ends an interpolation hole, also the brace used for nesting depth (e.g. '}')
}

/** When the regex token's `/` is a division operator instead of a regex literal. */
export interface RegexContext {
  divisionAfterTypes: string[]; // token TYPE names after which `/` is division (value-producing tokens)
  divisionAfterTexts: string[]; // token TEXTs after which `/` is division (e.g. ')', 'this', 'true')
  regexAfterTexts: string[];    // keyword TEXTs that (re)enter expression position → `/` is a regex
  // keyword TEXTs that, when they head a parenthesized group `kw ( … )`, make the
  // matching `)` a control-head (not a value) so a following `/` is a regex, not
  // division (e.g. `if (a) /re/.test(x)`). Overrides `)` being in divisionAfterTexts.
  regexAfterParenKeywords?: string[];
  // member-access TEXTs (e.g. '.', '?.'): after one of these, an identifier is a
  // property NAME, not a keyword, so `obj.for(x) / y` is a call + division (the
  // `regexAfterParenKeywords` control-head rule does not apply).
  memberAccessTexts?: string[];
  // postfix-unary operator TEXTs that are AMBIGUOUS with a prefix operator of the
  // same spelling (TS non-null `!`, also logical-not `!`). Such a token is
  // value-producing — so a following `/` is DIVISION and a following template is
  // TAGGED — ONLY when it follows a value (postfix `x!`); when it follows a
  // non-value/expression-start it is the prefix operator (`!x`, `!/re/`), so a `/`
  // right after it is a REGEX. (Unconditional postfix ops like `++`/`--` go in
  // `divisionAfterTexts` instead — a `/` can never directly follow their prefix
  // form, so they need no value-context check.)
  postfixAfterValueTexts?: string[];
}

/** A raw-text element's embed, selected by a `lang="…"` attribute on the start tag. */
export interface RawEmbed {
  default: string;                  // embed scope when no (or an unlisted) lang= attribute
  lang?: Record<string, string>;    // lang attribute value → embed scope (e.g. { ts: 'source.ts' })
  // Whether the embedded language can swallow the close tag mid-line or leave an open construct at
  // the close that misreads it — i.e. whether the body must FORCE-CLOSE mid-line and FORCE-UNWIND an
  // open embedded region at the close tag. TRUE for `<script>` (JS `//</script>` on one line must
  // still close — tmbundle#85; an unterminated `type T =` must unwind before `</script>` is read as
  // type-args — #5538/#2060): the body uses a `begin/while` open region whose `.*` drops at the first
  // line CONTAINING the close, plus separate close-LINE rules. That `while` drop is what makes a non-
  // first DIALECT's close-line content land on a lang-INDEPENDENT close rule (only the first fires),
  // so a multi-dialect `forceClose` embed cannot keep per-dialect close lines — script accepts this
  // (mid-line force-close is the priority for JS). FALSE (the default for a `{ default, lang }` embed)
  // is for a well-behaved embed like CSS — no greedy line-comment swallows `</style>`, nothing leaves
  // an open construct — so the body uses a lookahead-`end` region (matching the official Vue grammar):
  // the embed stays active up to `</tag` so a WITH-CONTENT close line keeps its DIALECT (issue #43).
  forceClose?: boolean;
}

/**
 * Declarative markup-mode tokenization (opt-in, e.g. HTML/Vue). When a grammar
 * declares `markup`, the lexer runs a text / tag / raw-text STATE MACHINE instead
 * of the pure token stream: text between tags is one TEXT token (whitespace and
 * arbitrary punctuation included, not skipped), `<…>` is tokenized as a tag, and
 * raw-text elements (`<script>`/`<style>`/…) scan verbatim to their close tag.
 *
 * Every delimiter is grammar DATA — nothing in the lexer hardcodes `<`/`>`/HTML —
 * so the engine stays language-agnostic. Mode transitions are LEXER-LOCAL (keyed
 * on the tokens the lexer itself emits: tagOpen/tagClose and the tag name), so the
 * lexer never needs parser feedback and the "lexer depends only on tokens, not
 * rules" architecture is preserved. ABSENT for token-stream languages (JS/TS),
 * where the machine is dormant and tokenization is byte-identical to before.
 */
export interface MarkupConfig {
  textToken: string;   // token TYPE emitted for a run of text between tags
  tagOpen: string;     // opens a tag and ends a text run (e.g. '<')
  tagClose: string;    // closes a tag → return to text/raw-text (e.g. '>')
  closeMarker?: string; // marks a close tag when it directly follows tagOpen (e.g. '/' in '</'); such a tag never opens raw text
  // What CHAR (right after `tagOpen`) actually opens a tag — a regex char-class BODY (the part
  // inside `[…]`), e.g. HTML's WHATWG tag-open state `'a-zA-Z/!?'`. A `tagOpen` NOT followed by
  // such a char is a literal text character, not a tag start: `<p>a < b</p>` → the `<` is text
  // (parse5 agrees), so the text run keeps going instead of ending and throwing on a non-tag `<`.
  // Pure DATA (every markup language declares its own opener set). ABSENT → legacy behaviour:
  // every `tagOpen` ends the text run and opens a tag (a bare `<` then errors downstream).
  tagOpenAfter?: string;
  // Attribute syntax (the host markup's `name="value"`): the name/value separator and the
  // quote characters. Kept as DATA so the markup + injection emitters bake in no HTML-specific
  // assumption (the same reason tagOpen/tagClose are data). Default to the near-universal `=`
  // and `" '`; a grammar declares them (see html.ts) and the injection layer reads them too.
  attributeAssign?: string;    // e.g. '='
  attributeQuotes?: string[];  // e.g. ['"', "'"]
  // Token TYPE the lexer emits for an UNQUOTED attribute value (HTML `href=foo`, `colspan=2`).
  // When declared, the lexer SCANS the whole value as one token the moment it sits right after an
  // `attributeAssign` (and the next char is not a quote) — stopping only at whitespace or `tagClose`,
  // exactly the WHATWG unquoted-value state. This is what lets a value contain `/` (URLs / paths:
  // `href=https://x/`, `href=/css/app.css`): once a value is being read, `/` is a value char, so the
  // `/>` self-close marker stays punctuation ONLY where no value is being read (after the tag name,
  // after whitespace, or after a completed attribute). Scanning the value whole also sidesteps the
  // declaration-order token race (the identifier token would otherwise grab `https:` and stop at the
  // first `/`). ABSENT → values are tokenized by the ordinary matchers (legacy behaviour).
  unquotedValueToken?: string;
  // Attributes whose VALUE is embedded source, selected by a name pattern (HTML event handlers:
  // `on*`→source.js, like the official). The value is CAPTURE-embedded (bounded to the quoted
  // span) via the SAME helper Vue directive values use — so the embedded grammar can't run past
  // the closing quote (the #5012 fix), and a derived JS grammar reads `//` inside a string as
  // string content, not a comment (the official hand-rolls a `//` splitter here and mis-fires:
  // textmate/html.tmbundle#113). Highlight-only; the parser never sees attribute values as code.
  // `include` (optional) overrides what the value is tokenized BY when it differs from the embed
  // SCOPE — e.g. an inline `style="…"` carries a CSS *declaration list* (no selector/braces), so it
  // embeds scope `source.css` but is tokenized by `source.css#rule-list-innards` (property:value),
  // not the stylesheet root (which would mis-read `color:red` as a selector). Defaults to `embed`.
  // `valuePatterns` (optional) overrides the single `include` with an EXPLICIT list of TextMate
  // patterns to tokenize the value by — for a value that is not one homogeneous embed but a small
  // grammar of its own (Vue `generic="…"` is a TS type-PARAMETER list: comments + a variance
  // keyword + types + commas + `=` defaults). Each entry is a plain fragment ({include} or
  // {name,match}); when present it REPLACES `include` inside the value span (the quote bounding is
  // unchanged). Lets an embed mirror a hand-written grammar's value rule verbatim (e.g. Volar's
  // `vue-directives-generic-attr`) using the host's PUBLIC repository keys.
  attributeEmbed?: { namePattern: TokenPattern; embed: string; include?: string; valuePatterns?: RepoAlias[] }[];
  // Elements whose content is raw (CDATA-like): after the start tag's `tagClose`,
  // everything up to the matching `tagOpen+closeMarker+name` is one `token`. `embed`
  // optionally maps a tag → the grammar scope to embed in its body (e.g. Vue SFC blocks:
  // template→text.html.basic, script→source.js, style→source.css); without it the body
  // is scoped by `token` (HTML's script/style convention → source.js/css). A tag may
  // instead map to `{ default, lang }` to pick the embed by a `lang="…"` attribute on the
  // start tag (Vue: `<script lang="ts">`→source.ts, `<style lang="scss">`→source.css.scss).
  rawText?: { tags: string[]; token: string; embed?: Record<string, string | RawEmbed> };
  // Custom-block embeds: ANY top-level block tag (not just the named rawText ones) whose start
  // tag carries `lang="<lang>"` embeds the mapped scope in its body — the Vue SFC custom-block
  // convention (`<i18n lang="yaml">`→source.yaml, `<docs lang="md">`→text.html.markdown, also
  // `<script lang="coffee">`, `<style lang="sass">`). Keyed by lang → embed scope; matches a
  // generic tag name and closes on its backreferenced `</tag>`. Tried BEFORE the named rawText
  // blocks, so an exotic lang wins over a named block's default (a `<script lang="coffee">`
  // embeds source.coffee, not the script default). The common langs stay on the named blocks.
  customBlockEmbed?: Record<string, string>;
  comment?: { open: string; close: string; token: string }; // e.g. `<!--` … `-->`
  // Void elements (`<br>`, `<img>`, `<meta>`, …) — no children, no close tag. The
  // lexer RETAGS an OPEN void-tag name from the identifier token to `voidNameToken`,
  // so the parser's void-element branch matches it by token type and never tries to
  // parse children / a close tag (which would otherwise swallow following siblings).
  // Keeps the generic parser name-blind: the void set is pure data, applied in the lexer.
  voidTags?: string[];
  voidNameToken?: string;
  // Elements whose END tag is OPTIONAL (HTML's omittable end tags: `<li>` closes at the
  // next `<li>`, `<p>` at the next block element, `<tr>`/`<td>` at the next row/cell, …).
  // Each entry maps an element NAME → the set of sibling START-tag names that implicitly
  // CLOSE it (the WHATWG "optional tag" follow set). Such an element's content `many(Node)`
  // STOPS when the next start tag is one of these triggers, and its close tag is OPTIONAL
  // (it may be omitted entirely — closed by a trigger sibling OR by any ancestor end tag,
  // the latter handled for free because content already stops at any `</`). Pure DATA, so
  // the engine stays name-blind: the parser recognises the container element arm STRUCTURALLY
  // (from tagOpen/tagClose/closeMarker + the name token) and consults this map by the captured
  // open-tag name. Highlight-only generators IGNORE it (a flat per-tag TM grammar does not
  // model element containment, so the derived TextMate/Monarch/tree-sitter output is unchanged);
  // it is purely a PARSER concern. ABSENT → every element requires an explicit close (B-lite).
  optionalEndTags?: Record<string, string[]>;
  // Character entities in text (HTML: `&amp;`, `&#169;`, `&#xAB;`). When declared, a run
  // of text is no longer one opaque blob in the highlighter: an entity is lifted out and
  // scoped on its own (the official HTML grammar does the same — see textmate/html.tmbundle#81).
  // Pure DATA (the prefix char, the `;` terminator, and the scope names), so the emitter bakes
  // in no HTML-specific assumption — a different markup language declares its own. ABSENT →
  // text stays one blob (current behaviour). Highlight-only: the parser still emits one text
  // token (an entity is ordinary text to the grammar), so conformance is unchanged.
  entity?: MarkupEntity;
  // Markup-injection layer (Vue: directives + `{{ }}` interpolation). Because the
  // `<template>` body reuses the HTML grammar WHOLESALE (it `embed`s text.html.basic),
  // Vue syntax can't be baked into HTML — it must be INJECTED onto HTML's scopes, the
  // same reason the official Vue grammar uses an injection grammar. gen-tm derives a
  // separate injection grammar (injectionSelector over `into`) from this declaration.
  inject?: MarkupInject;
}

/** Character entities in markup text (HTML `&amp;` / `&#169;` / `&#xAB;`). All DATA, so the
 *  emitter hardcodes nothing HTML-specific. `prefix`+`terminator` delimit an entity; `numericMarker`
 *  introduces a numeric reference, `hexMarker` (after it) a hex one. The scope names follow the
 *  official HTML grammar's: named/numeric entity bodies and the prefix/terminator punctuation. */
export interface MarkupEntity {
  prefix: string;            // starts an entity reference (e.g. '&')
  terminator: string;        // ends it (e.g. ';')
  numericMarker: string;     // marks a numeric reference after the prefix (e.g. '#' → `&#169;`)
  hexMarker: string;         // marks a hex numeric reference after numericMarker (e.g. 'x' → `&#xAB;`); case-insensitive
  namedScope: string;        // scope for a named entity body, e.g. constant.character.entity.named.html
  numericScope: string;      // scope for a numeric entity body, e.g. constant.character.entity.html
  punctuationScope: string;  // scope for the prefix/terminator punctuation, e.g. punctuation.definition.entity.html
}

/** One injectionSelector clause: a host scope plus the scopes that disqualify it, e.g.
 *  `{scope:'text.pug', excludes:['comment','string.comment']}` → `L:text.pug -comment -string.comment`.
 *  The emitter always appends `-exprEmbed` (so the injection can't re-fire inside an expression
 *  it already embedded — the #5722 guard). */
export interface InjectClause { scope: string; excludes?: string[] }

/** A markup-injection layer (Vue directives + `{{ }}` interpolation) injected onto a host
 *  grammar's scopes. Each CONCERN (interpolation / directives) becomes one THIN-STUB grammar
 *  file: its `scopeName` + `selector`, with `patterns:[{include: <host>#<repoKey>}]`. The rule
 *  BODIES live in the host (main) grammar's repository under `repoKey` — exactly the official
 *  Vue topology (`vue-directives.json` / `vue-interpolations.json` include `text.html.vue#…`),
 *  so the files are byte-diffable against it. All scope names + delimiters are DATA. */
export interface MarkupInject {
  exprEmbed: string;     // scope wrapping an embedded expression (e.g. source.ts.embedded.html.vue)
  exprInclude: string;   // grammar to tokenize the expression (e.g. source.ts#expression — Monogram's own TS)
  // `{{ … }}` interpolation in text content → injected onto the embedded-HTML scope.
  interpolation?: {
    scopeName: string;        // emitted file's scopeName, e.g. vue.interpolations
    repoKey: string;          // main-grammar repository key the stub includes, e.g. vue-interpolations
    selector: InjectClause[]; // host scopes (e.g. text.html.derivative / markdown / pug)
    open: string; close: string; beginScope: string; endScope: string;
  };
  // Directives in tag-attribute position → injected onto the tag scope.
  directives?: {
    scopeName: string;        // emitted file's scopeName, e.g. vue.directives
    repoKey: string;          // main-grammar repository key the stub includes, e.g. vue-directives
    selector: InjectClause[]; // host scopes (e.g. meta.tag / meta.element)
    control: { match: TokenPattern; scope: string }[];  // e.g. [{match:lit('v-for'), scope:'keyword.control.loop.vue'}, …]
    shorthand: { char: string; scope: string }[];  // e.g. [{char:':', scope:'punctuation.attribute-shorthand.bind.html.vue'}, …]
    prefix: string;        // long-form directive prefix, e.g. 'v-'
    nameScope: string;     // scope for a directive name / argument (entity.other.attribute-name.html.vue)
    eqScope: string;       // scope for the `=` before a directive value (punctuation.separator.key-value.html.vue)
    // Optional scope for the quotes around a directive value. DATA, so the engine names them
    // from the grammar instead of inventing a scope string; omit → quotes left unscoped.
    valueString?: { begin: string; end: string };
  };
}

/** A small TextMate-rule fragment a grammar may inline as DATA — either a reuse `include` of an
 *  existing internal repository key, or an inline `match` with a scope `name` (e.g. an attribute
 *  value sub-pattern; see `MarkupConfig.attributeEmbed.valuePatterns`). gen-tm passes it through
 *  verbatim, so it stays language-agnostic (the engine never inspects the strings). */
export interface RepoAlias {
  include?: string;   // e.g. '#type-inner'  (reuse an existing internal key)
  name?: string;      // scope for an inline match
  match?: string;     // inline pattern
}

/**
 * Opt-in indentation-sensitive tokenization (YAML / Python-like). When a grammar declares
 * `indent`, the lexer tracks an indentation STACK and, at each block-context line start,
 * emits INDENT / DEDENT / NEWLINE tokens by comparing the line's leading-space column to the
 * stack top (deeper → INDENT + push; shallower → DEDENT per popped level; equal → NEWLINE
 * sibling-separator). Indentation is SUSPENDED inside flow delimiters (`[ ] { }`) — newlines
 * there are insignificant — via a flow-depth counter. Blank lines and comment-only lines do
 * not affect indentation. The three tokens are emitted by the engine (not matched by a
 * regex), exactly like markup's text token, so the grammar declares them with placeholder
 * patterns and names them here. ABSENT for token-stream languages → tokenization is
 * byte-identical (the whole mechanism is dormant, like `markup`).
 */
export interface IndentConfig {
  indentToken: string;    // token TYPE emitted when a line's column exceeds the stack top
  dedentToken: string;    // token TYPE emitted (once per popped level) when it drops below
  newlineToken: string;   // token TYPE emitted at a same-column line boundary (sibling separator)
  flowOpen?: string[];    // punctuation that suspends indentation while open (e.g. ['[', '{'])
  flowClose?: string[];   // matching closers (e.g. [']', '}'])
  // Per-collection SCOPES for the flow structural punctuation, keyed by the OPEN bracket. The flow
  // region the highlighter derives (gen-tm §2c) otherwise paints every `{ } [ ] ,` as a generic
  // `punctuation.${lang}` — graded only at the FAMILY tier. Declaring a `begin`/`end`/`separator`
  // scope here lets the open/close brackets and the in-collection comma carry the SPECIFIC
  // convention (a `{…}` is a "mapping", a `[…]` a "sequence" — language-FLAVOURED names that must
  // come from the grammar, not the neutral engine). `keyValue` (optional) re-scopes the `:`
  // key/value separator inside a flow mapping, and `explicitKey` the `?` explicit-key indicator.
  // Scope strings are WITHOUT the trailing `.${lang}` segment (gen-tm appends it, like
  // `blockScalar.indicatorScope`). Absent → the generic `punctuation.${lang}` (legacy). A bracket
  // pair with no entry in `byOpen` likewise falls back to the generic scope, so partial
  // declarations are safe. (e.g. YAML: `{` → punctuation.definition.mapping.begin, `}` → …end,
  // `,` in `{…}` → punctuation.separator.mapping; `[` → …sequence.begin, etc.)
  flowScopes?: {
    byOpen: Record<string, { begin: string; end: string; separator: string }>;
    keyValue?: string;     // the flow-mapping `:` key/value separator (e.g. punctuation.separator.key-value)
    explicitKey?: string;  // the flow `?` explicit-key indicator (e.g. punctuation.definition.key-value)
  };
  comment?: string;       // line-comment introducer ignored for indentation (e.g. '#')
  // The mapping KEY/VALUE separator literal (YAML `:`). The ONE source of truth for "what glyph
  // separates a mapping key from its value": BOTH the lexer's key-line sniffs (`lineHasKeySeparator`,
  // `startsBlockStructuralNode`, the compact-key pairing) AND the derived highlighter's multi-line
  // plain-scalar fold regions (gen-tm §2a′/§2a″) recognise a `key:`-led line as STRUCTURAL from this
  // field — so parser and highlighter agree for ANY separator. Declared here (not hardcoded) so the
  // region code stays data-driven. Absent → defaults to ':'.
  keyValueSeparator?: string;
  // Block scalars (YAML `|` / `>`): when the rest of a line is an introducer + indicators, the
  // following more-indented lines are verbatim content emitted as ONE token (like raw-text, but
  // bounded by indentation rather than a close tag). `introducers` are the leading chars (['|','>']).
  // `documentMarkers` (e.g. ['---','...']) are col-0 strings that ALWAYS terminate a block scalar
  // (a doc boundary outranks indentation) and, when one heads the introducer's line (`--- >`),
  // mark it a document-ROOT scalar whose content may sit at column 0 (auto-detected, parent = -1).
  // `indicatorScope` (optional) re-scopes just the `|`/`>`(+chomping/indent) introducer — a structural
  // control sigil, not content; absent → the block-scalar token's own scope (introducer reads as the
  // body string). The body always keeps the token scope; only the introducer capture is re-scoped.
  blockScalar?: { introducers: string[]; token: string; documentMarkers?: string[]; indicatorScope?: string };
  // Flow `:` key-separator carve-out MEMBERSHIP: token TYPES after which a `:` glued inside a flow
  // collection is the `key: value` SEPARATOR (forced `:` punctuation), never the start of a `:`-led
  // plain scalar. A quoted scalar / flow-close can never run past its closer, so a `:` immediately
  // after one is unambiguously the separator (YAML: the quoted-key tokens). This is an EXPLICIT,
  // mode-neutral list — the carve-out is OFF unless a token is named here. (Was derived from the
  // `string` flag, which silently enlisted every string-region token; an indentation grammar with
  // `:name`-shaped tokens after values keeps `string: true` for region scoping / auto-close
  // derivation WITHOUT being dragged into separator emission.) Flow-CLOSE delimiters (`flowClose`)
  // are always part of the carve-out — a `:` after `]`/`}` is structurally the separator regardless.
  // Absent / empty → no carve-out (the `:` lexes normally). The separator glyph itself is
  // `keyValueSeparator`. yaml-test-suite 5MUD / 5T43 / 9MMW / C2DT / K3WX.
  flowSeparatorAfterTokens?: string[];
  // Plain-scalar CONTINUATION fold MEMBERSHIP: the token TYPES that participate in YAML's plain-scalar
  // folding — a more-indented line right after one of these LEAF scalars (or an adjacent one inside a
  // flow collection) is a CONTINUATION of that scalar, not a new node. Drives the block-context fold
  // (a deeper line after a plain leaf), the flow illegal-head continuation, and the flow multi-line
  // merge post-pass. The LAST-named token is the generic catch-all used as the emitted CONTINUATION
  // token type and whose `pattern` matches a folded body (declaration order is specific-before-general,
  // so the broadest plain is last). This is an EXPLICIT, mode-neutral list — folding is OFF unless a
  // token is named here. (Was derived from `blockPattern`, which gave YAML plain-scalar folding to ANY
  // block-pattern token; an indentation grammar can now carry a `blockPattern` token WITHOUT inheriting
  // the fold.) Absent / empty → no folding. yaml-test-suite 3MYT / A2M4 / AB8U / FBC9 / JTV5 / UT92.
  foldTokens?: string[];
  // A comment introducer immediately followed by this string is NOT a comment line — it falls
  // through to ordinary tokenization (e.g. comment '//' + commentExcept '!' → `//!` doc-comment
  // lines lex as real tokens and stay visible to the indent stack, while `//` lines vanish).
  commentExcept?: string;
  // Raw content blocks: a line-TRAILING introducer (`tag:mode` at end of line, or a bare `:mode`
  // at the line lead) captures all following more-indented lines as ONE verbatim token — the
  // analogue of `blockScalar` for languages whose raw regions are introduced from the END of a
  // line (Pug-style filters/content modes) rather than by a leading `|`/`>`. `signature` is a
  // sticky-regex SOURCE matched at the introducer char through end-of-line (default
  // `:(?:[A-Za-z][A-Za-z0-9-]*)?[ \t]*(?:\r?\n|$)`); `introChar` is its first char (a cheap
  // pre-filter, default ':'). The introducer must be GLUED to the line's content (no top-level
  // whitespace before it — whitespace inside balanced parens/quotes is fine) or sit at line lead.
  rawBlock?: { token: string; signature?: string; introChar?: string };
  // Compact-notation indicators (YAML `-` / `?`): a block entry indicator whose nested node begins
  // INLINE on the same line (`- item: a`, `? - x`). The node's true indentation is then the column
  // of its first char AFTER the indicator, not the indicator's own column — so a following SIBLING
  // line aligned with that content (`- item: a` / `  quantity: b`) is a sibling, not a child. When
  // the FIRST such indicator on a line is followed by inline block-structural content, the lexer
  // pushes that content column (emitting one INDENT after the indicator) so the compact form yields
  // the same INDENT/NEWLINE/DEDENT shape as the equivalent next-line-indented form. Absent → off.
  compactIndicators?: string[];
  // Tag-handle per-document MEMBERSHIP (YAML §6.8.2 / §6.9.1): a `%TAG !h! prefix` directive declares
  // the named handle `!h!` for the document it heads ONLY. A tag using a named handle that was not
  // declared in the SAME document's directive prologue is a parse error (a membership check — NOT URI
  // resolution; a declared-but-unknown prefix stays accepted). The handle set is bounded, declared
  // before any use, and reset at each document boundary — exactly like the indent stack. All token
  // NAMES and patterns are DATA (populated in the grammar), so the engine stays language-agnostic.
  // Absent → no membership check (every tag accepted, the legacy behaviour). yaml-test-suite QLJ7.
  tagScope?: {
    tagToken: string;            // the tag token's name — checked for handle membership (e.g. 'Tag')
    directiveTokens: string[];   // token names that may DECLARE a handle (e.g. ['Directive'] — `%TAG …`)
    activateTokens: string[];    // boundary tokens that ACTIVATE the pending prologue for the doc they head (e.g. ['DocStart'] — `---`)
    resetTokens: string[];       // boundary tokens that RESET the handle set to the builtins (e.g. ['DocEnd'] — `...`)
    builtinHandles: string[];    // handles always valid without declaration (e.g. ['!', '!!'])
    handlePattern: string;       // ^-anchored regex; group 1 = the handle prefixing a TAG token (e.g. '(![0-9A-Za-z-]*!|!)')
    directiveHandlePattern: string; // regex over a DIRECTIVE token's text; group 1 = the handle it declares (e.g. '%TAG[ \\t]+(![0-9A-Za-z-]*!|!)')
  };
}

/**
 * Opt-in NEWLINE-sensitive tokenization, INDEPENDENT of `indent`. For grammars that are
 * newline-aware but NOT indentation-aware — statements are line-delimited, but nesting is via
 * delimiters / expressions, not indentation (e.g. dotenv-style env specs). The lexer emits a single
 * NEWLINE token at each significant line boundary (suppressed inside flow delimiters, and on blank /
 * comment-only lines), with NO indent stack and NO INDENT/DEDENT tokens. `indent` is the richer
 * layer built ON TOP of this same line-boundary + flow-suspension machinery (indent = newline +
 * indent stack + YAML block-scalar semantics), so declaring BOTH is rejected. The NEWLINE token is
 * engine-emitted (declared with a placeholder `never()` pattern and named here), exactly like the
 * indent tokens. ABSENT for token-stream / indentation languages → dormant, tokenization
 * byte-identical.
 */
export interface NewlineConfig {
  token: string;        // token TYPE emitted at each significant line boundary (engine-emitted, like the indent tokens)
  flowOpen?: string[];  // punctuation that SUSPENDS newline significance while open (e.g. ['(', '[', '{'])
  flowClose?: string[]; // matching closers (e.g. [')', ']', '}'])
  comment?: string;     // line-comment introducer; a comment-only line emits no NEWLINE (e.g. '#')
}

export interface PrecOperator {
  value: string;
  position: 'infix' | 'prefix' | 'postfix';
  noUnaryLhs?: boolean;  // infix op whose left operand may not be a bare unary-prefix expression (e.g. JS `**`)
  // Operator whose left operand (infix) / operand (postfix) must be a valid assignment
  // target (LeftHandSideExpression) — NOT a prefix-unary, prefix-update, or postfix-update
  // expression. ECMAScript AssignmentTargetType, enforced at parse time (JS `=`/`+=`/…,
  // postfix `++`/`--`). A parenthesized cover or member/element/call/non-null tail passes.
  requireTarget?: boolean;
}

export interface PrecLevel {
  assoc: 'left' | 'right' | 'none';
  operators: PrecOperator[];
}

/** Binding power for an ALTERNATIVE-form Pratt LED (a rule alternative `[$, connector, …]`
 *  like the conditional `?:` or `as Type`). Without one, such a LED fires inside ANY
 *  operator's right operand — i.e. it binds maximally tight, which mis-associates
 *  `a == b ? c : d` as `a == (b ? c : d)`. The anchor names a ladder operator:
 *  `sameAs` borrows its lbp, `below` sits one notch under it (between ladder levels —
 *  levels are spaced 2 apart). `chainRhs` parses the led's TRAILING self-operand at this
 *  lbp (left-chaining, like a ladder op's rhs) instead of as a full expression. */
export interface LedPrec {
  connector: string;     // the led's first literal after the self-operand ('?', 'in', 'as', …)
  sameAs?: string;       // lbp = lbp(thisLadderOp)
  below?: string;        // lbp = lbp(thisLadderOp) - 1
  chainRhs?: boolean;    // trailing self-operand at this lbp (default: full expression)
}

export type RuleExpr =
  | { type: 'seq'; items: RuleExpr[] }
  | { type: 'alt'; items: RuleExpr[] }
  | { type: 'literal'; value: string }
  | { type: 'ref'; name: string }
  | { type: 'quantifier'; body: RuleExpr; kind: '*' | '+' | '?' }
  // `ctxMode` marks a subtree as [Await]/[Yield] context (the spec's grammar parameter):
  // the await-yield-fork build transform reads it to name-fork the body-reachable rule
  // closure into $A/$Y/$AY families. Every OTHER consumer treats this exactly like a
  // plain transparent group (recurse into `body`), so the marker is invisible outside
  // the fork transform.
  // `tsRelaxed`: a TREE-SITTER-ONLY alternate rendering. The parser (and every other
  // generator) uses `body` — the strict form; gen-treesitter renders `tsRelaxed` instead.
  // Lets a PARSER-only constraint that is correct but tree-sitter-GLR-hostile (e.g.
  // at-most-one-`static`, or restricting a type predicate to return position) keep the
  // derived highlighter at its cheap status-quo shape — a highlighter may over-accept a
  // rare malformed form harmlessly. Like every group field, it is transparent (no node).
  // capBelow: this NUD alternative is a complete assignment-level expression (an
  // ArrowFunction — the LOWEST-precedence ECMAScript AssignmentExpression). It may be
  // parsed only when the enclosing Pratt minBp is LOOSER than the named connector's
  // binding power, and once parsed admits NO led (a tighter operator can neither take it
  // as an operand nor continue it). Read only by the expression-engine Pratt core.
  // `tsRuleName`: when a tsRelaxed group carries it, gen-treesitter emits `tsRelaxed` ONCE
  // as a shared rule of this name and renders each reference as `$.<name>` — sharing its
  // states instead of inlining (and duplicating) them at every use site (issue #46).
  // Visibility follows tree-sitter's `_`-prefix convention.
  | { type: 'group'; body: RuleExpr; suppress?: string[]; ctxMode?: 'await' | 'yield' | 'asyncgen' | 'reset'; tsRelaxed?: RuleExpr; tsRuleName?: string; capBelow?: string }   // suppress: LED connectors disabled while parsing body (e.g. no-`in`)
  // Zero-width negative lookahead: matches (consuming nothing) iff `body` does
  // NOT match at the current position. Used to express disambiguations the
  // longest-match parser can't reach by structure alone (e.g. a `<…>` type-arg
  // list in expression position is only a bare instantiation when it isn't
  // followed by something that starts an expression). Non-consuming → invisible
  // to highlighting / AST shape / other generators.
  // `reservable`: this is the bare-identifier reserved-word guard (notReservedExpr).
  // The await-yield-fork transform, when cloning a rule into the $A/$Y/$AY family,
  // adds that family's context keyword(s) to the inner alt — so `await`/`yield` lose
  // their identifier reading inside an async/generator body. Invisible elsewhere.
  | { type: 'not'; body: RuleExpr; reservable?: boolean }
  // Zero-width "no LineTerminator here" assertion: matches (consuming nothing)
  // iff the NEXT token is on the same line (no preceding newline). Encodes
  // ECMAScript/TS restricted productions like an array/indexed-access type's `[`,
  // which must not follow a line terminator. Non-consuming → invisible to other
  // generators (they treat it as a no-op marker).
  | { type: 'sameLine' }
  // Zero-width "no comment was skipped before the next token" assertion (indentation grammars):
  // matches (consuming nothing) iff the next token is not flagged `commentBefore`. Encodes YAML's
  // rule that a comment ENDS a plain scalar, so a multi-line fold cannot cross a comment. Like
  // `sameLine`, non-consuming → invisible to other generators (a no-op marker).
  | { type: 'noCommentBefore' }
  // Zero-width "the preceding flow collection was single-line" assertion (indentation grammars):
  // matches (consuming nothing) iff the next token is NOT flagged `multilineFlowBefore`. Encodes
  // YAML's §7.4.2 rule that a flow collection used as an implicit block KEY must be on one line
  // (`[flow]: v` is a key, `[23\n]: v` is not). Like `noCommentBefore`, non-consuming → invisible
  // to other generators (a no-op marker).
  | { type: 'noMultilineFlowBefore' }
  // Zero-width LEFT-operand head-leaf guard for a Pratt LED arm (it sits at the HEAD of a LED
  // alternative, before the self `$`). It gates the arm on the LEFT node's OUTERMOST (head) leaf
  // token TEXT: when that text is in `words`, the LED arm is treated as NOT-matched (skipped), so
  // the connector rebinds to nothing and the parse rejects. Encodes TS's rule that a qualified type
  // name `A.B` has an IdentifierReference root — the keyword/literal types `void`/`null`/`true`/
  // `false`/`this` are NOT qualifiable (`void.x` has no parse tree). It mirrors the AssignmentTargetType
  // gate (`_notTarget`) which reads the same head leaf, but predicated on TEXT membership rather than
  // operator-tag shape. Like the other zero-width markers it consumes nothing → invisible to every
  // generator (a no-op in the CFG): gen-treesitter renders it `blank()` and drops it from the seq,
  // so the derived GLR grammar keeps the UNCONSTRAINED `.` LED (a left-leaf predicate is not
  // expressible in GLR, and a stray `void.x` is harmless for a highlighter) — no tsRelax needed.
  | { type: 'notLeftLeaf'; words: string[] }
  | { type: 'sep'; element: RuleExpr; delimiter: string }
  | { type: 'op' }
  | { type: 'prefix' }
  | { type: 'postfix' };

export interface RuleDecl {
  name: string;
  body: RuleExpr;
  flags: string[];
  // Set by the await-yield-fork transform on a generated [Await]/[Yield] family clone:
  // the BASE rule name this fork collapses to for every DERIVED artifact (green-node
  // type, AST type union, TM scope, tree-sitter rule, cst-match dispatch). The emitted
  // parser keeps the distinct `name` for its memo/adoption rule identity, but reports
  // `canon` as the node's rule name so trees stay byte-identical to the base grammar.
  canon?: string;
}

export interface CstGrammar {
  tokens: TokenDecl[];
  precs: PrecLevel[];
  ledPrecs?: LedPrec[];
  rules: RuleDecl[];
  scopeOverrides: Map<string, string[]>;
  // Highlight-only CONTEXTUAL token scopes: token T carries scope S when it appears within
  // rule R (T's immediate enclosing rule). Generators consume this at their own fidelity:
  // tree-sitter emits exact `(rule (token) @capture)` queries; the TextMate generator applies
  // the override inside its derived bracket-construct regions (call args, continuation
  // brackets) — the flat top-level rules keep the token's declared scope.
  contextualScopes?: { token: string; within: string[]; scope: string }[];  // literal → scope overrides from `scopes` section (multiple if keyword appears in multiple groups)
  name?: string;
  scopeName?: string;  // declared TextMate scope name (e.g. source.ts); its suffix drives every scope's language tag
  markup?: MarkupConfig;  // opt-in markup-mode tokenization (HTML/Vue); absent for token-stream languages
  indent?: IndentConfig;  // opt-in indentation-sensitive tokenization (YAML); absent → byte-identical token stream
  newline?: NewlineConfig;  // opt-in NEWLINE-sensitive tokenization, independent of indent (no indent stack); absent → byte-identical token stream
  expressionRule?: string;  // name of the rule that produces an EXPRESSION; lets gen-tm derive a `#expression` sub-grammar (for expression-only embeds, e.g. Vue `{{ }}`)
  // Extra TextMate grammars that just RE-EXPOSE this one under another scopeName (thin
  // `{scopeName, patterns:[{include: <this.scopeName>}]}` wrappers). HTML declares
  // text.html.derivative this way — the embedded-fragment scope Vue/markdown/pug inject onto;
  // VS Code ships it as a separate grammar for the same reason. gen-tm emits one file each.
  aliasScopes?: { scope: string; file: string }[];
  // Repository-key NAMING CONSTRAINT ("限制器"): a DATA map { OFFICIAL key name → the structural
  // key(s) gen-tm derived for the SAME construct }. For Monogram's source.ts to be a repository-level
  // DROP-IN, the key NAMES external grammars `#include` (`source.ts#type`, `#qstring-double`,
  // `#comment`, …) must be the names Monogram NATIVELY emits — not a structural name (`#type-inner`)
  // plus an additive alias. This map CONSTRAINS gen-tm's key emission: after the repository is built
  // with structural names, gen-tm projects the structural identity through this constraint, producing
  // the canonical official name DIRECTLY (the structural name ceases to exist — it is RENAMED, not
  // aliased) and rewriting every `#…` reference to that key consistently, so the repository holds ONE
  // key, natively named. Two value forms encode the two construct↔key relationships gen-tm derives:
  //   • a STRING (`'type': 'type-inner'`) → the official construct maps 1:1 to one structural key;
  //     RENAME that key (and all references) to the official name. The old name is gone.
  //   • an ARRAY (`'comment': ['jsdoc','linecomment',…]`) → the official key is a UNION the official
  //     grammar itself expresses as a `{patterns:[…]}` wrapper; Monogram derives the members as
  //     separate, independently-referenced keys, so no single rename can carry the official name.
  //     gen-tm SYNTHESISES the wrapper key `{patterns:[{include:#member}…]}` under the official name,
  //     each member resolved through any 1:1 rename above (so a renamed member is referenced by its
  //     final name). The members keep their own structural names (they are used elsewhere too).
  // It is purely a NAMING projection — no `match`/`begin`/`name`/scope changes — so the tokenization of
  // every input is byte-for-byte identical (it is a rename, not a pattern edit). An official name that
  // already exists as a real Monogram key (e.g. `namespace-declaration`, `expression`) is left ALONE
  // (never clobbered). The NAMES are language-specific DATA and live in the grammar definition
  // (typescript.ts may know TS names, as it knows the `scopes` map); gen-tm applies the map generically
  // (look up + substitute), so the engine stays language-agnostic — a grammar declaring none is
  // unaffected. REPLACES `repoAliases` (which left a redundant 2nd entry); this leaves none.
  canonicalRepoNames?: Record<string, string | string[]>;
  // VS Code extension `contributes` data — packaging info a consumer needs to wire the
  // generated grammars into an editor (and to make Monogram's Vue a true drop-in for
  // vuejs/language-tools' files). All DATA the grammar declares; gen emits a pasteable
  // `<name>.contributes.json` snippet. Absent → no manifest emitted.
  manifest?: ContributesManifest;
}

/** VS Code `contributes` packaging for a grammar. The emitter pairs this with what it
 *  already knows (scopeName, name, the injection scopeNames, the generated filenames) to
 *  build a `{languages, grammars}` snippet — so the only DATA here is what isn't derivable. */
export interface ContributesManifest {
  extensions?: string[];                       // language file extensions (e.g. ['.vue']); default ['.' + name]
  // Host grammars each injection loads into (VS Code `injectTo`). For Vue: the SFC itself plus
  // the places a Vue template appears — text.html.vue / markdown / derivative / pug. This is a
  // packaging fact (which document languages activate the injection), distinct from a selector.
  injectTo?: string[];
  // scope → VS Code language id for the main grammar's embedded regions (template/script/style),
  // so the editor knows each embed's language for IntelliSense / indentation / comments.
  embeddedLanguages?: Record<string, string>;
}
