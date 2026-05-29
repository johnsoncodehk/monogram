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

export interface PrecOperator {
  value: string;
  position: 'infix' | 'prefix' | 'postfix';
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
}
