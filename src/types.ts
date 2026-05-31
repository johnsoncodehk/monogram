export interface TokenDecl {
  name: string;
  pattern: string;
  flags: string[];
  scope?: string;         // @scope(...) override
  escapePattern?: string; // @escape /pattern/ — escape sequence regex (highlight only)
  escapeValidPattern?: string; // one well-formed escape; engine-scanned tokens reject non-matching `\`-escapes (skipped in tag position)
  embed?: string;         // @embed(lang) — embedded language scope name
  // ── Lexer hints (keep the engine language-agnostic; all optional) ──
  identifier?: boolean;          // THE identifier token: engine uses its name for the
                                 // Unicode-identifier fallback and regex division-after context.
  template?: TemplateDelimiters; // a template-literal token: engine tokenizes interpolation holes.
  regexContext?: RegexContext;   // a `regex`-flagged token: when `/` is a regex vs division.
  string?: boolean;              // a string-literal token: its delimiters drive editor auto-close/surround.
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
}

/** A raw-text element's embed, selected by a `lang="…"` attribute on the start tag. */
export interface RawEmbed {
  default: string;                  // embed scope when no (or an unlisted) lang= attribute
  lang?: Record<string, string>;    // lang attribute value → embed scope (e.g. { ts: 'source.ts' })
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
  // Elements whose content is raw (CDATA-like): after the start tag's `tagClose`,
  // everything up to the matching `tagOpen+closeMarker+name` is one `token`. `embed`
  // optionally maps a tag → the grammar scope to embed in its body (e.g. Vue SFC blocks:
  // template→text.html.basic, script→source.js, style→source.css); without it the body
  // is scoped by `token` (HTML's script/style convention → source.js/css). A tag may
  // instead map to `{ default, lang }` to pick the embed by a `lang="…"` attribute on the
  // start tag (Vue: `<script lang="ts">`→source.ts, `<style lang="scss">`→source.css.scss).
  rawText?: { tags: string[]; token: string; embed?: Record<string, string | RawEmbed> };
  comment?: { open: string; close: string; token: string }; // e.g. `<!--` … `-->`
  // Void elements (`<br>`, `<img>`, `<meta>`, …) — no children, no close tag. The
  // lexer RETAGS an OPEN void-tag name from the identifier token to `voidNameToken`,
  // so the parser's void-element branch matches it by token type and never tries to
  // parse children / a close tag (which would otherwise swallow following siblings).
  // Keeps the generic parser name-blind: the void set is pure data, applied in the lexer.
  voidTags?: string[];
  voidNameToken?: string;
  // Markup-injection layer (Vue: directives + `{{ }}` interpolation). Because the
  // `<template>` body reuses the HTML grammar WHOLESALE (it `embed`s text.html.basic),
  // Vue syntax can't be baked into HTML — it must be INJECTED onto HTML's scopes, the
  // same reason the official Vue grammar uses an injection grammar. gen-tm derives a
  // separate injection grammar (injectionSelector over `into`) from this declaration.
  inject?: MarkupInject;
}

/** A markup-injection layer (e.g. Vue directives + interpolation) injected onto a host
 *  grammar's scopes. All scope names + delimiters are DATA, so the emitter is generic. */
export interface MarkupInject {
  into: string[];        // host scopes to inject onto (e.g. ['text.html.basic']) → L:<scope>
  exprEmbed: string;     // scope wrapping an embedded expression (e.g. source.ts.embedded.html.vue)
  exprInclude: string;   // grammar to tokenize the expression (e.g. source.ts — Monogram's own TS)
  // `{{ … }}` interpolation in text.
  interpolation?: { open: string; close: string; beginScope: string; endScope: string };
  // Directives in tag-attribute position.
  directives?: {
    control: { match: string; scope: string }[];  // e.g. [{match:'v-for', scope:'keyword.control.loop.vue'}, …]
    shorthand: { char: string; scope: string }[];  // e.g. [{char:':', scope:'punctuation.attribute-shorthand.bind.html.vue'}, …]
    prefix: string;        // long-form directive prefix, e.g. 'v-'
    nameScope: string;     // scope for a directive name / argument (entity.other.attribute-name.html.vue)
    eqScope: string;       // scope for the `=` before a directive value (punctuation.separator.key-value.html.vue)
  };
}

export interface PrecOperator {
  value: string;
  position: 'infix' | 'prefix' | 'postfix';
  noUnaryLhs?: boolean;  // infix op whose left operand may not be a bare unary-prefix expression (e.g. JS `**`)
}

export interface PrecLevel {
  assoc: 'left' | 'right' | 'none';
  operators: PrecOperator[];
}

export type RuleExpr =
  | { type: 'seq'; items: RuleExpr[] }
  | { type: 'alt'; items: RuleExpr[] }
  | { type: 'literal'; value: string }
  | { type: 'ref'; name: string }
  | { type: 'quantifier'; body: RuleExpr; kind: '*' | '+' | '?' }
  | { type: 'group'; body: RuleExpr; suppress?: string[] }   // suppress: LED connectors disabled while parsing body (e.g. no-`in`)
  // Zero-width negative lookahead: matches (consuming nothing) iff `body` does
  // NOT match at the current position. Used to express disambiguations the
  // longest-match parser can't reach by structure alone (e.g. a `<…>` type-arg
  // list in expression position is only a bare instantiation when it isn't
  // followed by something that starts an expression). Non-consuming → invisible
  // to highlighting / AST shape / other generators.
  | { type: 'not'; body: RuleExpr }
  // Zero-width "no LineTerminator here" assertion: matches (consuming nothing)
  // iff the NEXT token is on the same line (no preceding newline). Encodes
  // ECMAScript/TS restricted productions like an array/indexed-access type's `[`,
  // which must not follow a line terminator. Non-consuming → invisible to other
  // generators (they treat it as a no-op marker).
  | { type: 'sameLine' }
  | { type: 'sep'; element: RuleExpr; delimiter: string }
  | { type: 'op' }
  | { type: 'prefix' }
  | { type: 'postfix' };

export interface RuleDecl {
  name: string;
  body: RuleExpr;
  flags: string[];
}

export interface CstGrammar {
  tokens: TokenDecl[];
  precs: PrecLevel[];
  rules: RuleDecl[];
  scopeOverrides: Map<string, string[]>;  // literal → scope overrides from `scopes` section (multiple if keyword appears in multiple groups)
  name?: string;
  scopeName?: string;  // declared TextMate scope name (e.g. source.ts); its suffix drives every scope's language tag
  markup?: MarkupConfig;  // opt-in markup-mode tokenization (HTML/Vue); absent for token-stream languages
  expressionRule?: string;  // name of the rule that produces an EXPRESSION; lets gen-tm derive a `#expression` sub-grammar (for expression-only embeds, e.g. Vue `{{ }}`)
}
