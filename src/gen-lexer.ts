import type { CstGrammar } from './types.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';
import { tokenBlockPatternFirstCharSet, tokenBlockPatternSource, tokenEscapeValidPatternSource, tokenPatternFirstCharSet, tokenPatternSource } from './token-pattern.ts';

// A lexer token: a declared token (type = its name) or a punctuation literal (type = '').
// `$templateHead/$templateMiddle/$templateTail` are synthetic types the lexer emits for
// the pieces of an interpolated template — role names, not language-specific.
export interface Token {
  type: string;   // token decl name (e.g. 'Ident'), or '' for punctuation literals
  text: string;
  offset: number;
  newlineBefore?: boolean;   // a line terminator preceded this token (drives ASI / "no LineTerminator here" rules)
  commentBefore?: boolean;   // a comment was skipped before this token (indentation grammars: a comment
                             // ENDS a plain scalar, so a folded multi-line scalar must not cross it)
  multilineFlowBefore?: boolean; // the flow collection that closed immediately before this token spanned >1 line
                             // (indentation grammars: a flow used as an implicit block KEY must be single-line, §7.4.2)
}

// Build a standalone lexer from the grammar's token definitions + lexer hints.
// It depends ONLY on tokens/precs — never on the parse rules — so it is the first
// derived stage: grammar → lexer → parser (and grammar → highlighter), all from one
// definition. The parser composes this (see gen-parser.ts).
export function createLexer(grammar: CstGrammar) {
  // Punctuation literals from rules + operators (everything that isn't a keyword word).
  const allLiterals = new Set<string>();
  for (const rule of grammar.rules) for (const l of collectLiterals(rule.body)) allLiterals.add(l);
  for (const level of grammar.precs)
    for (const op of level.operators) allLiterals.add(op.value);
  const punctLiterals = [...allLiterals]
    .filter(l => !isKeywordLiteral(l))
    .sort((a, b) => b.length - a.length);

  // Token matchers (order matters: earlier declarations win). `blockRegex` is the optional
  // block-context (flowDepth===0) variant for indentation grammars — see TokenDecl.blockPattern;
  // it is selected over `regex` only outside flow collections, so flow tokenization is unchanged.
  // The regexes are STICKY (`y`): a sticky `(?:p)` anchored at `lastIndex = pos` matches exactly
  // where `^(?:p)` would on `source.slice(pos)`, but WITHOUT allocating the rest-of-file slice
  // every position. The token patterns compile without flags (no `^`/`$`/`m`), so `y` ≡ the old
  // `^`-anchored form. `lastIndex` is set immediately before each `exec` in the loop (a stale
  // value from a prior matcher's exec must never leak in).
  // ── Win B: conservative first-char dispatch ──────────────────────────────────────────────
  // The filter is derived from Token Pattern IR. `null` means "no filter, always try"; that is
  // always sound, only slower. Final matching still uses the emitted sticky RegExp below.

  const tokenMatchers = grammar.tokens.map(t => {
    const pattern = tokenPatternSource(t);
    const blockPattern = tokenBlockPatternSource(t);
    return {
      name: t.name,
      regex: new RegExp(`(?:${pattern})`, 'y'),
      blockRegex: blockPattern ? new RegExp(`(?:${blockPattern})`, 'y') : null,
      skip: t.flags.includes('skip'),
      isRegex: t.flags.includes('regex'),
      isString: !!t.string,
      blockOnly: !!t.blockOnly,   // matched only outside flow (flowDepth===0) — see TokenDecl.blockOnly
      // First-char filters for the default and block patterns (computed once). A char the set rejects
      // can't start this token → the loop skips it. `null` = couldn't prove a filter → always try.
      first: tokenPatternFirstCharSet(t),
      blockFirst: blockPattern ? tokenBlockPatternFirstCharSet(t) : null,
    };
  });

  // ── Lexer hints (declared per-token in the grammar; nothing here hardcodes a
  // specific language's tokens — see the `identifier`/`template`/`regexContext` opts) ──
  const identTokenName = grammar.tokens.find(t => t.identifier)?.name;
  // Unicode identifier fallback: a literal identifier character the declared identifier
  // token's (necessarily ASCII / escape-only — patterns compile without /u) pattern can't
  // match — `℘` (Other_ID_Start), accented letters, ZWNJ/ZWJ, combining marks. ID_Start /
  // ID_Continue are the spec's identifier classes (`$` and `_` are ID_Start; an
  // IdentifierPart additionally admits `$`, ZWNJ U+200C and ZWJ U+200D). Built once.
  const uniIdentRe = /^[$_\p{ID_Start}][$‌‍\p{ID_Continue}]*/u;
  // Sticky (`y`) twins of the two Unicode-identifier regexes, used by the per-position scan loop
  // to match at `lastIndex = pos` without slicing the rest of the source. The `^` anchor is
  // dropped (under `y`, `^` without the `m` flag only matches at index 0, so it would fail at any
  // pos>0); a bare sticky match at `lastIndex` is exactly the old `^`-on-slice behaviour. `identTextValid`
  // still uses the `^`-anchored `uniIdentRe` (it validates a whole decoded string from index 0).
  const uniIdentReY = /[$_\p{ID_Start}][$‌‍\p{ID_Continue}]*/uy;
  // An IdentifierPart run (ID_Continue + `$`, ZWNJ, ZWJ): used to EXTEND an ASCII identifier
  // token that stopped at a continue-only Unicode char (`ab<ZWNJ>cd` — the ASCII pattern emits
  // `ab`, then this consumes `<ZWNJ>cd` and folds it back into the preceding identifier).
  const uniIdentContReY = /[$‌‍\p{ID_Continue}]+/uy;
  // Sticky whitespace run, for the non-indentation hot path: matched at `lastIndex = pos` so the
  // common "skip a run of whitespace" step never slices the rest of the source. (Indentation
  // grammars use their own char-by-char line-boundary logic, not this.)
  const wsReY = /\s+/y;
  // Prefixed-identifier tokens (e.g. `#name`): same Unicode fallback behind a fixed literal
  // prefix, tagged with that token's name (so `#℘` lexes as the private-name token, not Ident).
  const prefixedIdentTokens = grammar.tokens
    .filter(t => t.identifierPrefix)
    .map(t => ({ name: t.name, prefix: t.identifierPrefix as string }));
  // Token names that denote an identifier (the bare one + any prefixed) — the ones the
  // continue-run extension above may legitimately grow.
  const identLikeTokenNames = new Set<string>(
    [identTokenName, ...prefixedIdentTokens.map(t => t.name)].filter(Boolean) as string[],
  );
  // Per token name, the fixed literal prefix to strip before validating its identifier body
  // (the bare identifier token has none). Used by identTextValid below.
  const identPrefixByName = new Map<string, string>(prefixedIdentTokens.map(t => [t.name, t.prefix]));
  // An identifier token's ASCII pattern admits `\uXXXX` / `\u{cp}` escapes but cannot (no /u
  // flag) check that the ESCAPED codepoint is a legal identifier character — so `!` (`!`)
  // or a ZWNJ-at-start would wrongly tokenize. Validate post-match: decode every escape, then
  // require the decoded text to be a well-formed IdentifierName (uniIdentRe). A pure-ASCII /
  // escape-free identifier needs no decoding (fast path). Returns false ⇒ reject (lex error,
  // TS's "Invalid character"). Only ever REJECTS escaped identifiers, so it cannot accept more.
  const decodeEsc = /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g;
  function identTextValid(name: string, text: string): boolean {
    const prefix = identPrefixByName.get(name) ?? '';
    const body = text.slice(prefix.length);
    if (!body.includes('\\')) return true;   // no escapes → the regex already validated it
    let bad = false;
    const decoded = body.replace(decodeEsc, (_m, braced, fixed) => {
      const cp = parseInt(braced ?? fixed, 16);
      if (cp > 0x10FFFF) { bad = true; return ''; }
      return String.fromCodePoint(cp);
    });
    if (bad) return false;
    const m = decoded.match(uniIdentRe);
    return m !== null && m[0].length === decoded.length;
  }
  const templateToken = grammar.tokens.find(t => t.template);
  const templateTokenName = templateToken?.name;
  const tplOpen = templateToken?.template?.open ?? '';
  const tplInterpOpen = templateToken?.template?.interpOpen ?? '';
  const tplInterpClose = templateToken?.template?.interpClose ?? '';
  const tplBraceOpen = tplInterpOpen.slice(-1);                          // brace that deepens interp nesting ('{' of '${')
  const tplOpenCode = tplOpen.length === 1 ? tplOpen.charCodeAt(0) : -1; // fast path when the open delimiter is one char
  // A valid single escape sequence inside a template; when declared, an escape that
  // does not match it is a scan error — but only outside tag position (a tagged
  // template legally carries invalid escapes). Sticky `y` so it matches at `pos`.
  const templateEscapeValidPattern = templateToken ? tokenEscapeValidPatternSource(templateToken) : undefined;
  const templateEscapeValidRe = templateEscapeValidPattern
    ? new RegExp(templateEscapeValidPattern, 'y')
    : null;

  // Regex-vs-division context: declared by the grammar's `regex` token. ($templateTail
  // is the lexer's own synthetic template-end token — always a completed value, so `/`
  // after it is division in any language; added here rather than asked of the grammar.)
  const regexCtx = grammar.tokens.find(t => t.regexContext)?.regexContext;
  const divisionPrevTypes = new Set([...(regexCtx?.divisionAfterTypes ?? []), '$templateTail']);
  const divisionPrevTexts = new Set(regexCtx?.divisionAfterTexts ?? []);
  const expressionStartKeywords = new Set(regexCtx?.regexAfterTexts ?? []);
  // Keywords that head a `kw ( … )` control group; the matching `)` is a statement
  // head (not a value), so a following `/` is a regex, not division.
  const parenHeadKeywords = new Set(regexCtx?.regexAfterParenKeywords ?? []);
  // Member-access texts (`.`/`?.`): a keyword right after one is a property name, so
  // the control-head rule above does not apply (`obj.for(x) / y` is a call/division).
  const memberAccessTexts = new Set(regexCtx?.memberAccessTexts ?? []);
  // Postfix ops ambiguous with a prefix op of the same spelling (TS `!`): value-producing
  // only in postfix position (after a value), so a following `/` is division then but a
  // regex when it's the prefix form (`!/re/`). Resolved per-occurrence (see lastBangWasPostfix).
  const postfixAfterValueTexts = new Set(regexCtx?.postfixAfterValueTexts ?? []);

  // ── Markup mode (opt-in; entirely dormant unless the grammar declares `markup`) ──
  // Drives a text/tag/raw-text state machine in tokenize(); all delimiters are grammar
  // DATA (nothing here hardcodes `<`/`>`/HTML), and transitions are keyed only on the
  // tokens the lexer itself emits, so it needs no parser feedback.
  const markup = grammar.markup;
  const rawTextTagSet = new Set((markup?.rawText?.tags ?? []).map(t => t.toLowerCase()));
  const voidTagSet = new Set((markup?.voidTags ?? []).map(t => t.toLowerCase()));
  // Markup content tokens are emitted by the state machine, not matched by a regex in
  // the normal loop (like the template token) — else a greedy text pattern would hijack
  // tag-mode tokenizing. The void-name token is a RETAG target (never matched fresh),
  // skipped here too so its placeholder pattern can't shadow the identifier token.
  const markupTokenNames = new Set<string>(
    [markup?.textToken, markup?.rawText?.token, markup?.comment?.token, markup?.voidNameToken,
     markup?.unquotedValueToken].filter(Boolean) as string[],
  );
  // Character set BOUNDING an unquoted attribute value (HTML `href=foo`): everything except
  // whitespace, the attribute quotes, the tag delimiters, the assign char and a backtick — `/`
  // is INCLUDED (URLs / paths). Mirrors gen-tm's derived `string.unquoted` value pattern exactly,
  // so the lexer and the highlighter agree on the value span. Built once; used by the tag-mode
  // value scan below. Only meaningful when `markup.unquotedValueToken` is declared.
  const attrQuoteChars = markup?.attributeQuotes ?? ['"', "'"];
  const ccEscape = (s: string) => s.replace(/[\[\]\\^-]/g, '\\$&');   // escape char-class metachars
  // Sticky (`y`): scanned at `lastIndex = pos` in tag mode (no rest-of-source slice). No `^`
  // anchor (under `y` it would only match at index 0); set lastIndex right before exec.
  const unquotedValueRe = markup ? new RegExp(
    '[^\\s' + ccEscape(attrQuoteChars.join('') + markup.tagOpen + markup.tagClose +
      (markup.attributeAssign ?? '=') + '`') + ']+',
    'y',
  ) : null;
  // What char (right after `tagOpen`) actually opens a tag (markup.tagOpenAfter is a char-class
  // BODY, so it's used verbatim, not re-escaped). When declared, a `tagOpen` followed by anything
  // else is a literal text char (WHATWG tag-open state: `<p>a < b</p>` keeps `<` as text). ABSENT
  // → null, and a `tagOpen` always opens a tag (legacy behaviour, unchanged for other grammars).
  const tagOpenAfterRe = markup?.tagOpenAfter ? new RegExp('[' + markup.tagOpenAfter + ']') : null;

  // ── Indentation / newline mode (opt-in; dormant unless the grammar declares `indent` or `newline`) ──
  // Like markup, the INDENT/DEDENT/NEWLINE tokens are EMITTED by a state machine (not matched
  // by a regex) — so they are skipped in the regex loop and their grammar patterns are
  // placeholders. Indentation is suspended inside flow delimiters via a flow-depth counter.
  // `newline` is the line-boundary + flow-suspension LAYER that `indent` builds on: an indent
  // grammar gets the full stack + INDENT/DEDENT/NEWLINE; a newline-only grammar emits just the
  // NEWLINE token at each significant line boundary (no stack). `lineSensitive` gates the shared
  // machinery; `indent`/`newline` are mutually exclusive (defineGrammar rejects declaring both).
  const indent = grammar.indent;
  const newline = grammar.newline;
  const lineSensitive = !!indent || !!newline;
  const lineComment = (indent ?? newline)?.comment;   // line-comment introducer (both modes skip comment-only lines)
  const indentTokenNames = new Set<string>(
    indent ? ([indent.indentToken, indent.dedentToken, indent.newlineToken].filter(Boolean) as string[])
           : newline ? [newline.token] : [],
  );
  const flowOpenSet = new Set((indent ?? newline)?.flowOpen ?? []);
  const flowCloseSet = new Set((indent ?? newline)?.flowClose ?? []);
  // String-literal token names (the `string`-flagged tokens — quoted scalars in YAML). Used by the
  // flow mapping-separator guard below: a quoted scalar can never run past its closing quote, so a
  // `:` immediately after one (inside flow) is ALWAYS the mapping `key: value` separator, never the
  // start of a plain scalar — derived from the `string` flag, not a hardcoded token name.
  const stringTokenNames = new Set(grammar.tokens.filter(t => t.string).map(t => t.name));
  // Plain-scalar token names: the tokens carrying a block-context pattern variant (`blockPattern`).
  // In YAML these are exactly the UNQUOTED scalar family (plain / key / number / boolean-null) — the
  // ones whose flow-vs-block forms differ because flow indicators are content in block. Used by the
  // flow multi-line-plain FOLD post-pass: a plain scalar folded across a flow-internal newline arrives
  // as ADJACENT plain tokens (a space-separated plain is already one token; only a NEWLINE splits it),
  // which the post-pass re-merges. Derived from `blockPattern`, not a hardcoded token name.
  const plainScalarTokenNames = new Set(grammar.tokens.filter(t => tokenBlockPatternSource(t)).map(t => t.name));
  // The generic (catch-all) plain-scalar token: the LAST-declared blockPattern token. Declaration
  // order is specific-before-general (YAML: Key, Num, BoolNull, Plain — the typed/key shapes win
  // earlier, so the broadest string-valued plain is necessarily last). Used as the type emitted for
  // a folded plain-scalar CONTINUATION line — a more-indented line after a plain LEAF whose leading
  // glyph (`-`/`&`/`!`/`[`/`?`/`*`) is plain CONTENT here, not structure (so it can't be lexed by
  // the plain head pattern, which forbids those starts). Null when no blockPattern token exists.
  const plainContinuationTokenName = [...grammar.tokens].reverse().find(t => tokenBlockPatternSource(t))?.name ?? null;
  // The generic plain token's FLOW pattern (its `pattern`, not the block variant) — used by the flow
  // illegal-head continuation fallback: a char that no token can START here (e.g. YAML's `%`/`@`/backtick,
  // illegal as a plain START) is, when it follows a plain scalar inside a flow collection, mid-scalar
  // CONTENT. We then consume that one head char plus whatever plain BODY follows (matched by this
  // pattern at the next position), emit it as a plain-continuation token, and let the flow fold post-pass
  // merge it with the preceding scalar. Compiled once; null when no generic plain token exists.
  const plainFlowRe = (() => {
    const t = [...grammar.tokens].reverse().find(t => tokenBlockPatternSource(t));
    return t ? new RegExp(`^(?:${tokenPatternSource(t)})`) : null;
  })();
  // Does the line content starting at `start` carry a KEY SEPARATOR — an unquoted `:` followed by
  // whitespace / EOL / a flow indicator (`,`/`[`/`]`/`{`/`}`)? This is the colon-sniff shared with
  // startsBlockStructuralNode (skipping "…"/'…' regions, stopping at a ` #` comment / EOL), isolated
  // so the plain-continuation FOLD can ask it WITHOUT the leading-glyph structural checks: a fold
  // line begins with content (an `&`/`!`/`-`/… that is scalar content), so only a real key separator
  // makes it a mapping line that must NOT fold (`k: a\n  b: c` stays a reject). Returns false ⇒ no
  // separator ⇒ the line is plain content eligible to fold.
  function lineHasKeySeparator(src: string, start: number): boolean {
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (ch === '\n' || ch === '\r') break;
      // A quoted region (`"…"`/`'…'`) is skipped so a `:` inside it isn't a separator. An UNTERMINATED
      // quote (the closing one is missing before EOL) means this line is NOT a quoted key — the quote
      // and everything after it to EOL is plain CONTENT, so no key separator can follow → stop scanning
      // the line (break, NOT continue, which would leak the scan into the next line — yaml-test-suite
      // FBC9, a plain continuation `!"#$…` whose lone `"` previously made the scan cross into `safe
      // question mark: …` and wrongly report a separator).
      if (ch === '"') {
        i++; while (i < src.length && src[i] !== '"' && src[i] !== '\n' && src[i] !== '\r') { if (src[i] === '\\') i++; i++; }
        if (src[i] !== '"') break; continue;
      }
      if (ch === "'") {
        i++; while (i < src.length && src[i] !== '\n' && src[i] !== '\r') { if (src[i] === "'" && src[i + 1] !== "'") break; if (src[i] === "'") i++; i++; }
        if (src[i] !== "'") break; continue;
      }
      if ((ch === ' ' || ch === '\t') && src[i + 1] === '#') break;            // trailing comment → any sep would be earlier
      if (ch === ':') { const n = src[i + 1]; if (n === undefined || n === ' ' || n === '\t' || n === '\n' || n === '\r' || n === ',' || n === '[' || n === ']' || n === '{' || n === '}') return true; }
    }
    return false;
  }
  // Block scalars (YAML | / >): an introducer char + indent/chomp indicators + optional trailing
  // comment to end-of-line is the SIGNATURE (so `a > b` isn't mistaken for one); the following
  // more-indented lines are verbatim content, emitted as one token (skipped in the regex loop).
  const blockScalarIntro = new Set(indent?.blockScalar?.introducers ?? []);
  // A trailing `#…` on the header line is a comment only after whitespace (`> # c`), never glued
  // to the indicator (`>#c` is invalid — §6.8); the `(?<=[ \t])` makes the comment require a
  // preceding space, so a glued `#` fails the signature and the `>`/`|` is not taken as a header.
  // Sticky (`y`): tested at `lastIndex = pos` (no rest-of-source slice). The leading `^` is dropped
  // (under `y` it would only match at index 0); the trailing `$` is kept — under `y` without `m` it
  // anchors at the very end of `source`, the same position the end of the old `source.slice(pos)`
  // denoted, so the "newline-or-EOF" alternation is unchanged.
  const blockScalarSig = /[|>](?:[1-9][+-]?|[+-][1-9]?|[+-]|)[ \t]*(?:(?<=[ \t])#[^\n]*)?(?:\r?\n|$)/y;
  if (indent?.blockScalar) indentTokenNames.add(indent.blockScalar.token);
  // Col-0 strings (`---`/`...`) that always end a block scalar — a document boundary outranks
  // indentation — and, when one heads the introducer's line, mark a document-ROOT scalar.
  const blockScalarDocMarkers = indent?.blockScalar?.documentMarkers ?? [];
  // A marker only counts at a line edge: it must be followed by whitespace / EOL (so `---`/`...`
  // terminate, but `----`/`...x` do not — those are ordinary content).
  const markerAt = (src: string, i: number): boolean =>
    blockScalarDocMarkers.some((m) => {
      if (!src.startsWith(m, i)) return false;
      const a = src[i + m.length];
      return a === undefined || a === ' ' || a === '\t' || a === '\n' || a === '\r';
    });
  // Compact-notation entry indicators (`-`/`?`) whose inline content's column is the real
  // indentation of the nested node (see IndentConfig.compactIndicators).
  const compactIndicatorSet = new Set(indent?.compactIndicators ?? []);
  // Tag-handle per-document membership (IndentConfig.tagScope). All token names + patterns are DATA;
  // dormant unless declared. The handle/directive patterns are compiled once; the builtin handles
  // seed every document's declared set. See the push() membership check below.
  const tagScope = indent?.tagScope;
  const tagScopeTagToken = tagScope?.tagToken;
  const tagScopeDirectiveTokens = new Set(tagScope?.directiveTokens ?? []);
  const tagScopeActivateTokens = new Set(tagScope?.activateTokens ?? []);
  const tagScopeResetTokens = new Set(tagScope?.resetTokens ?? []);
  const tagScopeBuiltins = new Set(tagScope?.builtinHandles ?? []);
  const tagScopeHandleRe = tagScope ? new RegExp(tagScope.handlePattern) : null;
  const tagScopeDirectiveRe = tagScope ? new RegExp(tagScope.directiveHandlePattern) : null;
  // Does the line content starting at `start` begin a BLOCK-STRUCTURAL node — one whose leading
  // whitespace serves as its indentation (so a tab there is a §6.1 error)? True for a `-`/`?`
  // indicator, an empty-`:` key, a node property (`&`/`!`), or a plain/quoted scalar that is a
  // mapping KEY (an unquoted `:` separator — `:` then ws/EOL/flow-indicator — follows it before
  // the line ends). False for a flow collection (`[`/`{`), a bare alias (`*`), or a leaf plain
  // scalar with no key separator — there the post-space column already satisfies the indent, so a
  // following tab is legal separation, not indentation. (Only consulted for tab-indent detection.)
  const sepAfter = (c: string | undefined) => c === undefined || c === ' ' || c === '\t' || c === '\n' || c === '\r';
  // `allowProperty` (default true): does a node property `&`/`!` count as establishing indentation
  // here? It does after a leading-indent or a `-`/`?` indicator (`-\t&a x` is an error), but NOT
  // after a `:` map separator (`key:\t&a x` / `:\t&a x` are legal — the property is the inline
  // value). The `yaml` oracle draws exactly this line; the flag lets the `:` callers opt out.
  function startsBlockStructuralNode(src: string, start: number, allowProperty = true): boolean {
    const c0 = src[start];
    if (c0 === '[' || c0 === '{' || c0 === '*') return false;               // flow collection / alias → not indentation
    if ((c0 === '-' || c0 === '?' || c0 === ':') && sepAfter(src[start + 1])) return true; // indicator / empty key
    if ((c0 === '&' || c0 === '!') && allowProperty) return true;          // node property → establishes a node here
    if (c0 === '&' || c0 === '!') return false;                            // property after `:` → inline value, legal
    // Scalar key sniff: scan the line for an unquoted `:` followed by ws/EOL/flow-indicator (a
    // block key separator), skipping over "…"/'…' regions and stopping at a ` #` comment / EOL.
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (ch === '\n' || ch === '\r') break;
      if (ch === '"') { i++; while (i < src.length && src[i] !== '"' && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } continue; }
      if (ch === "'") { i++; while (i < src.length && src[i] !== '\n') { if (src[i] === "'" && src[i + 1] !== "'") break; if (src[i] === "'") i++; i++; } continue; }
      if ((ch === ' ' || ch === '\t') && src[i + 1] === '#') break;          // trailing comment → key sep would be earlier
      if (ch === ':') { const n = src[i + 1]; if (n === undefined || n === ' ' || n === '\t' || n === '\n' || n === '\r' || n === ',' || n === '[' || n === ']' || n === '{' || n === '}') return true; }
    }
    return false;
  }
  // For a compact entry indicator (`- `/`? `): does its INLINE content begin a nested block
  // COLLECTION whose own indentation is this content's column — a `-`/`?` indicator, or a mapping
  // key (a scalar with an inline `:`)? It looks THROUGH a leading property prefix (`- &a key: v`,
  // `- !!seq key: v`), but a property that stands ALONE on the line (`- !!seq`, with the collection
  // on a separately-indented next line) does NOT nest here — the property is just a prefix, so we
  // must not push its column. (Distinct from startsBlockStructuralNode, which accepts a bare
  // property because for the §6.1 tab check a property always establishes a node.)
  function compactNestsHere(src: string, start: number): boolean {
    let i = start;
    // Skip an optional node-property prefix (one or two of `&anchor` / `!tag`, space-separated).
    for (let n = 0; n < 2; n++) {
      if (src[i] === '&' || src[i] === '!') {
        i++; while (i < src.length && !sepAfter(src[i]) && src[i] !== ',') i++;
        while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
      } else break;
    }
    if (i >= src.length || src[i] === '\n' || src[i] === '\r') return false;   // property alone on the line → no nest
    if ((src[i] === '-' || src[i] === '?') && sepAfter(src[i + 1])) return true; // nested indicator
    return startsBlockStructuralNode(src, i, false);                            // a mapping key (the `:`-sniff)
  }

  // Scan from inside a template span to its next boundary: an interpolation hole
  // (`interpOpen`) or the closing delimiter (`open`). Delimiters come from the
  // grammar's template token; only called when such a token is declared.
  function scanTemplateSpan(source: string, pos: number, validateEscapes: boolean): { endsWithInterp: boolean; end: number } {
    while (pos < source.length) {
      if (source.startsWith(tplInterpOpen, pos)) {
        return { endsWithInterp: true, end: pos + tplInterpOpen.length };
      } else if (source[pos] === '\\') {
        // In tag position invalid escapes are legal (validateEscapes=false): just skip
        // `\` + next char. Otherwise the escape must match the token's declared
        // escapeValid pattern, else it's a scan error (e.g. `\u{110000}`, `\u{r}`).
        if (validateEscapes && templateEscapeValidRe) {
          templateEscapeValidRe.lastIndex = pos;
          const m = templateEscapeValidRe.exec(source);
          if (!m) throw new Error(`Invalid escape sequence in template at offset ${pos}`);
          pos += m[0].length;
        } else {
          pos += 2;
        }
      } else if (source.startsWith(tplOpen, pos)) {
        return { endsWithInterp: false, end: pos + tplOpen.length };
      } else {
        pos++;
      }
    }
    throw new Error(`Unterminated template literal at offset ${pos}`);
  }

  function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let pos = 0;
    const templateStack: number[] = [];
    // For each open `(`, whether it heads a control group (`if`/`while`/…) so the
    // matching `)` is a statement head, not a value. `lastCloseWasParenHead` carries
    // that to the regex-vs-division check (consulted only when prev is `)`).
    const parenHeadStack: boolean[] = [];
    let lastCloseWasParenHead = false;
    // Whether the most-recently-emitted ambiguous postfix/prefix op (e.g. `!`) was in
    // POSTFIX position — i.e. followed a value, so it is itself value-producing (non-null
    // `x!`) and a following `/` is division. False ⇒ it was the prefix form (`!x`, `!/re/`),
    // so a `/` right after it is a regex. Read by prevIsValue when prev is such a token.
    let lastBangWasPostfix = false;
    // A line terminator was seen since the last emitted token (skipped whitespace
    // or comments). Stamped onto the next real token as `newlineBefore`, then
    // cleared — so the parser can honor "no LineTerminator here" restrictions
    // (e.g. an array/indexed-access type's `[` must be on the same line).
    let pendingNl = false;
    // A comment was skipped since the last emitted token. Stamped onto the next token as
    // `commentBefore` (indentation grammars only — it drives the YAML rule that a comment ENDS a
    // plain scalar, so a multi-line fold must not absorb a line that follows a comment).
    let pendingComment = false;
    // The OUTERMOST flow collection currently open contained a newline (indentation grammars). Set on
    // a flow-internal newline; when the flow returns to depth 0, if set, the flow spanned >1 line and
    // the NEXT token is stamped `multilineFlowBefore` (so a multi-line flow can't be an implicit block
    // KEY, §7.4.2). Reset when the outermost flow opens.
    let flowSawNewline = false;
    let pendingMultilineFlow = false;  // stamp `multilineFlowBefore` onto the next token (a multi-line flow just closed)
    // Markup state machine — active only when `markup` is declared. 'tag' is also the
    // resting mode for token-stream grammars, where the text/raw-text branches below
    // never fire (markup is undefined) → tokenization is byte-identical to before.
    type MarkupMode = 'text' | 'tag' | 'rawtext';
    let mode: MarkupMode = markup ? 'text' : 'tag';
    let curTag = '';            // tag name being read in tag mode (decides raw-text entry)
    let inTagName = false;      // the next tag-mode token is (part of) the tag name
    let sawCloseMarker = false; // this tag began `</…` → a close tag, never a raw-text opener
    // True iff a `tagOpen` at `i` actually OPENS a tag: with no `tagOpenAfter` declared, always
    // (legacy — every `tagOpen` opens a tag); otherwise only when the char right after it matches
    // the opener set (WHATWG tag-open state). A `tagOpen` at EOF (`<` last) opens nothing → text.
    const opensTag = (i: number): boolean =>
      !tagOpenAfterRe || (i + markup!.tagOpen.length < source.length
        && tagOpenAfterRe.test(source[i + markup!.tagOpen.length]));
    // Indentation state — active only when `indent` is declared (dormant otherwise).
    let flowDepth = 0;               // >0 while inside flow delimiters ([ ] { }) → indentation suspended
    let lineStart = lineSensitive;   // at a block-context line boundary (file start counts as one)
    let emittedContent = false;      // any real (non-structural) token emitted yet — suppress a leading NEWLINE/DEDENT
    let currentLineCol = 0;          // leading-space column of the current logical line (bounds block scalars)
    let atLineLead = false;          // the next emitted token is the FIRST content token of its line (compact-indicator probe)
    // Column of the most recent line-lead explicit-key `?` indicator that is still awaiting its paired
    // `:` value-half (−1 = none). A line-lead `:` at this SAME column is an EXPLICIT-value separator, the
    // one position where a compact same-line block sequence (`: - one`) is legal; a `:` at any other
    // column (a misaligned `m:\n  ? a\n: -x`, or a bare empty-key `: - x` with no `?` at all) is NOT and
    // must reject. Set when a line-lead `?` is emitted; cleared at a document boundary / when indentation
    // dedents below it. (yaml-test-suite 5WE3 / KK5P — the compact `: -` edge.)
    let lastExplicitKeyCol = -1;
    const indentStack: number[] = [0];
    // §7.4 multi-line flow indentation: when the OUTERMOST flow collection opens as a block VALUE or
    // ITEM (the `[`/`{` directly follows a `:`/`-` indicator), every CONTENT line of that flow must be
    // indented strictly MORE than the enclosing block node's column `n` — else the flow is
    // mis-indented (yaml-test-suite 9C9N / VJP3 / Y79Y). `-1` ⇒ the rule is OFF (a top-level / doc-root
    // flow whose content may sit at column 0, or a flow not in value/item position). Captured when
    // flowDepth goes 0→1; reset to -1 when it returns to 0.
    let flowValueIndent = -1;
    // Tag-handle membership state (IndentConfig.tagScope; dormant unless declared). `declaredHandles`
    // = handles valid in the CURRENT document body (seeded with the builtins, reset at each boundary);
    // `pendingHandles` = handles a directive prologue has declared, awaiting the `---` that activates
    // them for the document they head. Both reset per document — like the indent stack.
    const declaredHandles = new Set(tagScopeBuiltins);
    let pendingHandles = new Set<string>();
    function push(t: Token): void {
      if (pendingNl) { t.newlineBefore = true; pendingNl = false; }
      if (pendingComment) { t.commentBefore = true; pendingComment = false; }
      if (pendingMultilineFlow) { t.multilineFlowBefore = true; pendingMultilineFlow = false; }
      tokens.push(t);
      if (lineSensitive) {
        if (!indentTokenNames.has(t.type)) {
          emittedContent = true;                                     // a real token (not INDENT/DEDENT/NEWLINE)
          atLineLead = false;                                        // line-lead consumed once a real token lands
        }
        if (t.type === '') {                                         // track flow depth on punctuation literals
          if (flowOpenSet.has(t.text)) {
            // Entering the OUTERMOST flow (0→1): if it opens right after a `:`/`-` block indicator,
            // it is a block VALUE/ITEM → arm the §7.4 indent rule with n = the current block column
            // (the indent-stack top). Anywhere else (top-level / after `,` / as a key) the rule is OFF.
            // The §7.4 / multi-line-flow bookkeeping is indent-only (a newline grammar has no stack).
            if (flowDepth === 0 && indent) {
              const prevTok = tokens[tokens.length - 2];   // the token before this just-pushed open
              flowValueIndent = (prevTok && prevTok.type === '' && (prevTok.text === ':' || prevTok.text === '-'))
                ? indentStack[indentStack.length - 1] : -1;
              flowSawNewline = false;                      // start tracking whether this flow spans >1 line
            }
            flowDepth++;
          } else if (flowCloseSet.has(t.text)) {
            flowDepth = Math.max(0, flowDepth - 1);
            if (flowDepth === 0 && indent) {
              flowValueIndent = -1;
              if (flowSawNewline) pendingMultilineFlow = true;   // a multi-line flow just closed → flag the next token
              flowSawNewline = false;
            }
          }
        }
      }
      // ── Tag-handle per-document MEMBERSHIP (IndentConfig.tagScope) ──
      if (tagScope) {
        if (tagScopeDirectiveTokens.has(t.type)) {
          // A directive (`%TAG !h! …`) STAGES its handle into the prologue; it activates for the next
          // `---`-headed document, not the current line. A directive with no handle (`%YAML 1.2`,
          // unknown `%FOO`) yields no match → ignored.
          const m = tagScopeDirectiveRe!.exec(t.text);
          if (m && m[1]) pendingHandles.add(m[1]);
        } else if (tagScopeActivateTokens.has(t.type)) {
          // `---`: the prologue's staged handles become valid for THIS document; reset to builtins +
          // prologue and clear the accumulator (the next document starts a fresh prologue).
          declaredHandles.clear();
          for (const h of tagScopeBuiltins) declaredHandles.add(h);
          for (const h of pendingHandles) declaredHandles.add(h);
          pendingHandles = new Set();
        } else if (tagScopeResetTokens.has(t.type)) {
          // `...`: the document ends; named handles do NOT carry to a following bare document. Reset to
          // builtins and clear any pending prologue (a directive block after `...` re-accumulates and
          // activates at the next `---`).
          declaredHandles.clear();
          for (const h of tagScopeBuiltins) declaredHandles.add(h);
          pendingHandles = new Set();
        } else if (t.type === tagScopeTagToken) {
          // A tag's handle must be a builtin or have been declared in this document's prologue. A
          // verbatim/primary tag (`!<uri>`, `!foo`, `!`) resolves to the primary `!` handle (a builtin),
          // so only an UNDECLARED named handle (`!h!suffix` with `!h!` ∉ declared) is a parse error —
          // a MEMBERSHIP check, not URI resolution (a declared-but-unknown prefix stays accepted).
          const m = tagScopeHandleRe!.exec(t.text);
          const handle = m ? m[1] : null;
          if (handle && !tagScopeBuiltins.has(handle) && !declaredHandles.has(handle)) {
            throw new Error(`Undeclared tag handle '${handle}' at offset ${t.offset}`);
          }
        }
      }
    }
    // Is the previous token a completed VALUE? Then `/` after it is division (not a
    // regex) and a template after it is TAGGED (not a fresh literal). Same question,
    // shared by the regex-vs-division check and template escape validation.
    function prevIsValue(prev: Token | undefined): boolean {
      if (!prev) return false;
      // An ambiguous postfix/prefix op (e.g. `!`) is a value only in postfix position
      // (it followed a value) — recorded when it was emitted (lastBangWasPostfix).
      if (postfixAfterValueTexts.has(prev.text)) return lastBangWasPostfix;
      const isExprKeyword = prev.type === identTokenName && expressionStartKeywords.has(prev.text);
      const isParenHead = prev.text === ')' && lastCloseWasParenHead;
      return !isExprKeyword && !isParenHead && (divisionPrevTypes.has(prev.type) || divisionPrevTexts.has(prev.text));
    }

    while (pos < source.length) {
      // ── Markup TEXT mode: a run of text up to the next tag — whitespace and arbitrary
      // punctuation INCLUDED (not skipped, not rejected). Comments and a tag-open are
      // dispatched here; everything else up to the next tagOpen is one text token. ──
      if (markup && mode === 'text') {
        if (markup.comment && source.startsWith(markup.comment.open, pos)) {
          const idx = source.indexOf(markup.comment.close, pos + markup.comment.open.length);
          const end = idx < 0 ? source.length : idx + markup.comment.close.length;
          push({ type: markup.comment.token, text: source.slice(pos, end), offset: pos });
          pos = end;
          continue;
        }
        if (source.startsWith(markup.tagOpen, pos) && opensTag(pos)) {
          push({ type: '', text: markup.tagOpen, offset: pos });
          pos += markup.tagOpen.length;
          mode = 'tag'; inTagName = true; sawCloseMarker = false; curTag = '';
          continue;
        }
        // End the text run at the next REAL tag-open. A `tagOpen` not followed by an opener
        // char (`<` before a space/digit/`=`, or at EOF) is a literal text char, so it does NOT
        // end the run — the loop steps past it (WHATWG tag-open state; matches parse5 on
        // `<p>a < b</p>`). `pos` here is already a non-opening char (the dispatch above handled
        // a real tag/comment), so the run is always ≥ 1 char and progress is guaranteed.
        let p = pos;
        while (p < source.length && !(source.startsWith(markup.tagOpen, p) && opensTag(p))) p++;
        push({ type: markup.textToken, text: source.slice(pos, p), offset: pos });
        pos = p;
        continue;
      }

      // ── Markup RAW-TEXT mode: verbatim element content (script/style/…), scanned to
      // the matching close tag, so `<`/`>` inside it (e.g. `a < b`, `1<2`) stay text. ──
      if (markup && mode === 'rawtext') {
        const needle = (markup.tagOpen + (markup.closeMarker ?? '') + curTag).toLowerCase();
        const idx = source.toLowerCase().indexOf(needle, pos);
        const end = idx < 0 ? source.length : idx;
        if (end > pos) push({ type: markup.rawText!.token, text: source.slice(pos, end), offset: pos });
        pos = end;
        mode = 'text'; curTag = '';   // the close tag re-tokenizes via text → tag
        continue;
      }

      // ── Indentation mode: at a block-context line start, skip blank/comment lines, measure
      // the next content line's leading-space column, and emit NEWLINE / INDENT / DEDENT(s)
      // before that line's tokens (relative to the indentation stack). ──
      if (lineSensitive && flowDepth === 0 && lineStart) {
        let p = pos, col = 0;
        while (p < source.length && source[p] === ' ') { p++; col++; }
        const ch = source[p];
        if (p >= source.length) { pos = p; lineStart = false; continue; }   // EOF — final DEDENTs emitted after the loop
        if (ch === '\n' || ch === '\r') {                                   // blank line — ignored for structure
          pos = p + 1; if (ch === '\r' && source[pos] === '\n') pos++;
          continue;                                                         // still at a line start
        }
        // A WHITESPACE-ONLY line that contains a TAB (`\t`, ` \t`, `\t `) is ALSO blank — the
        // space-only branch above (which only counted a run of spaces into `col`) does not see it,
        // so without this it would be mis-measured as structure (a spurious INDENT/NEWLINE) or hit
        // the §6.1 tab-error below. Scan the full leading space/tab run; if it ends at a line break
        // or EOF the line is empty → skip it and stay at a line start. Must run BEFORE the §6.1
        // tab check / any indent emission. (yaml-test-suite DK95 ` \t\nfoo: 1`, `foo: 1\n\t\nbar`,
        // `foo: 1\n \t\nbar`; NB6Z a `  \t` blank line inside an indented same-column scalar fold.)
        if (ch === '\t') {
          let b = p; while (b < source.length && (source[b] === ' ' || source[b] === '\t')) b++;
          const bc = source[b];
          if (b >= source.length || bc === '\n' || bc === '\r') {
            pos = b; if (bc === '\r' && source[pos + 1] === '\n') pos += 2; else if (bc !== undefined) pos++;
            continue;
          }
        }
        // YAML (§6.1) forbids a TAB in indentation. The tricky part: a tab is illegal only where
        // the leading whitespace IS a node's indentation — i.e. the line begins a block-structural
        // node (a `-`/`?` indicator, an empty-`:` key, a node property `&`/`!`, or a scalar that is
        // a mapping KEY because a `:` separator follows it). A tab is HARMLESS before a flow
        // collection (`\t[…]`, `\t{…}`) or a leaf plain-scalar / alias continuation (`x:\n \tval`),
        // where the column past the spaces already satisfies the parent's indent. A tab-bearing
        // line that is ALL whitespace up to its terminator is left for the indent logic below
        // (its emitted NEWLINE/DEDENT either reject in value position or are harmless between
        // siblings — matching the `yaml` oracle, which is context-sensitive there). We reject only
        // the structural case, so no valid leaf-continuation is mis-rejected.
        if (indent && ch === '\t') {   // §6.1 tab-in-indentation error is YAML-specific (newline mode has no stack)
          let q = p; while (q < source.length && (source[q] === ' ' || source[q] === '\t')) q++;
          const after = source[q];
          if (q < source.length && after !== '\n' && after !== '\r' && startsBlockStructuralNode(source, q)) {
            throw new Error(`Tab character used in indentation at offset ${p}`);
          }
        }
        if (lineComment && source.startsWith(lineComment, p)) {             // comment-only line — ignored
          let e = p; while (e < source.length && source[e] !== '\n') e++;
          pos = e; pendingComment = true; continue;                         // next iteration consumes the newline
        }
        pos = p;                                                            // consume the leading indentation
        // ── newline-only mode: no indent stack — emit ONE NEWLINE at this real line boundary (a
        // leading boundary before any content is suppressed via emittedContent) and move on. ──
        if (!indent) {
          if (emittedContent) push({ type: newline!.token, text: '', offset: pos });
          lineStart = false;
          atLineLead = true;
          continue;
        }
        currentLineCol = col;                                               // bounds a block scalar started on this line
        const top = indentStack[indentStack.length - 1];
        if (col > top) {
          // PLAIN-SCALAR CONTINUATION fold: a more-indented line right after a plain LEAF (Plain /
          // Num / BoolNull — never a Key, which is always glued to a `:` and so never the last token
          // here) is a CONTINUATION of that scalar (`a\n  - b` folds to "a - b"; also `&`/`!`/`[`/
          // `?`/`*`-led — those glyphs are plain content mid-scalar). A plain scalar is a LEAF (it
          // cannot own nested structure), so a deeper following line is a continuation or an error —
          // UNLESS the line read-as-plain carries a key separator (`  b: c`), which would make it a
          // nested mapping (kept a reject). When eligible, consume the WHOLE line as one generic-plain
          // CONTINUATION token (its leading glyph stays content) so the foldedPlain grammar rule
          // (`leaf Indent Plain (Newline Plain)* Dedent`) absorbs it. The strictly-deeper gate (col >
          // top) is load-bearing: a SAME-column line is a sibling/dedent, not a fold. yaml-test-suite
          // 3MYT / A2M4 / AB8U / FBC9 / JTV5.
          const prevReal = tokens[tokens.length - 1];
          if (plainContinuationTokenName && prevReal && plainScalarTokenNames.has(prevReal.type)
              && !lineHasKeySeparator(source, pos)) {
            indentStack.push(col);
            push({ type: indent.indentToken, text: '', offset: pos });
            let e = pos;
            while (e < source.length && source[e] !== '\n' && source[e] !== '\r'
                   && !(indent.comment !== undefined && (source[e] === ' ' || source[e] === '\t') && source.startsWith(indent.comment, e + 1))) e++;
            // Trim trailing inline whitespace (a ` #…` comment or EOL follows) so the comment/EOL is
            // handled by the normal loop on the next pass — the fold token is the bare content.
            let end = e; while (end > pos && (source[end - 1] === ' ' || source[end - 1] === '\t')) end--;
            push({ type: plainContinuationTokenName, text: source.slice(pos, end), offset: pos });
            pos = e;
            lineStart = false;
            // If a trailing comment / EOL remains on the line, leaving lineStart=false lets the loop
            // skip it (a ` #` falls to the Comment token, stamping pendingComment so a NEXT line won't
            // re-fold across the comment); the following newline then sets lineStart for the next line.
            continue;
          }
          indentStack.push(col);
          push({ type: indent.indentToken, text: '', offset: pos });
        } else {
          while (indentStack.length > 1 && indentStack[indentStack.length - 1] > col) {
            indentStack.pop();
            push({ type: indent.dedentToken, text: '', offset: pos });
          }
          // Dedenting to/below the pending explicit-key column ends that `? key` scope — a `:` arriving
          // here can no longer be its compact-`:`-value half (yaml-test-suite KK5P misalignment guard).
          if (col < lastExplicitKeyCol) lastExplicitKeyCol = -1;
          if (emittedContent && indentStack[indentStack.length - 1] === col) {
            push({ type: indent.newlineToken, text: '', offset: pos });     // sibling separator at this level
          }
        }
        lineStart = false;
        atLineLead = true;          // the next real token is this line's first — eligible for a compact-indicator push
        continue;
      }

      // Whitespace. In an indentation / newline grammar, inline spaces/tabs are skipped but a
      // NEWLINE is a block-context line boundary (sets lineStart so the routine above runs next) —
      // except inside flow delimiters, where newlines are insignificant. Otherwise skip any run.
      if (lineSensitive) {
        const c = source[pos];
        if (c === ' ' || c === '\t') {
          // A TAB between a block indicator (`-`/`?`/map-`:`) and a NESTED block-structural node it
          // introduces is a §6.1 indentation error: the separation after the indicator counts as
          // the nested node's indentation (`-\t- x`, `?\tkey:`, `- \t-`, `:\tkey:`, `key:\t- a`). A
          // tab before a leaf scalar / flow / alias (`-\tplain`, `-\t[a]`, `-\t*a`) is harmless
          // separation, so the structural sniff gates it. After a `:` a node PROPERTY is the inline
          // value (`key:\t&a x` is legal), so the `:` case excludes properties (allowProperty=false)
          // while `-`/`?` include them (`-\t&a x` IS an error). Block context only (flowDepth===0).
          if (indent && flowDepth === 0) {   // §6.1 tab-after-indicator error is YAML-specific
            const prev = tokens[tokens.length - 1];
            const isIndicator = prev && prev.type === '' && (prev.text === '-' || prev.text === '?' || prev.text === ':');
            if (isIndicator) {
              let q = pos; while (q < source.length && (source[q] === ' ' || source[q] === '\t')) q++;
              if (source.slice(pos, q).includes('\t') && startsBlockStructuralNode(source, q, prev!.text !== ':')) {
                throw new Error(`Tab character used in indentation at offset ${pos}`);
              }
            }
          }
          pos++; continue;
        }
        if (c === '\n' || c === '\r') {
          pos++; if (c === '\r' && source[pos] === '\n') pos++;
          if (flowDepth === 0) lineStart = true;
          else if (indent) {
            flowSawNewline = true;   // this outermost flow spans >1 line → it can't be an implicit block key
            // §7.4: inside a value/item-position flow, a CONTENT line must be indented MORE than the
            // enclosing block column `n` (flowValueIndent). The indentation column is the leading-SPACE
            // count (a TAB is NOT indentation per §6.1, so a line starting with a tab has column 0 →
            // fails the check — yaml-test-suite Y79Y). A WHITESPACE-ONLY (blank) line — spaces AND/OR
            // tabs to the line end — is ignored, as is a COMMENT-only line; a line whose first content
            // char is the flow CLOSE delimiter (`]`/`}`) is allowed at any column (the closer may dedent).
            if (flowValueIndent >= 0) {
              let col = 0; while (source[pos + col] === ' ') col++;     // indentation = leading spaces only
              let q = pos + col; while (source[q] === ' ' || source[q] === '\t') q++;   // first content char
              const fc = source[q];
              const blank = fc === undefined || fc === '\n' || fc === '\r';
              const isComment = indent!.comment !== undefined && source.startsWith(indent!.comment, q);
              const isClose = fc !== undefined && flowCloseSet.has(fc);
              if (!blank && !isComment && !isClose && col <= flowValueIndent) {
                throw new Error(`Flow collection line is not sufficiently indented at offset ${q}`);
              }
            }
          }
          continue;
        }
      } else {
        wsReY.lastIndex = pos;
        const wsMatch = wsReY.exec(source);
        if (wsMatch) { if (wsMatch[0].includes('\n')) pendingNl = true; pos += wsMatch[0].length; continue; }
      }

      // ── Block scalar (YAML | / >): from the introducer line, take all following lines more
      // indented than the PARENT node as ONE verbatim token (blank lines included). The content
      // indentation auto-detects from the first non-empty body line; for a document-root scalar the
      // parent indentation is -1, so that first line (and the whole body) may sit at column 0. ──
      if (indent?.blockScalar && flowDepth === 0 && blockScalarIntro.has(source[pos])
          && ((blockScalarSig.lastIndex = pos), blockScalarSig.test(source))) {
        const startPos = pos;
        // The header line's text before the introducer decides the parent indentation. If the line
        // begins with a document marker (`--- >`) or with the introducer itself (a bare top-level
        // `>`/`|` at col 0), this is the document's ROOT node → parent = -1 (col-0 body allowed).
        // Otherwise something precedes it on the line (a `key:` / `-`) at currentLineCol → parent =
        // currentLineCol (so body must be MORE indented than the key/indicator, as before).
        let lineBegin = startPos; while (lineBegin > 0 && source[lineBegin - 1] !== '\n') lineBegin--;
        const before = source.slice(lineBegin, startPos).replace(/^[ \t]+/, '');   // line content before the introducer
        const atRoot = currentLineCol === 0 && (before === '' || blockScalarDocMarkers.some((m) => before === m + ' ' || before.startsWith(m + ' ')));
        // The PARENT NODE's indentation — the block level this value belongs to. When the introducer
        // sits inline with its key/indicator, currentLineCol IS that level (= the stack top); when it
        // sits on its OWN more-indented line (a property line then `>N` on the next, M5C3), currentLineCol
        // is the property line's column, NOT the parent — so use the stack top, which has already
        // dedented back to the owning block level. Equivalent to the stack top in both cases.
        const parentNode = indentStack[indentStack.length - 1];
        const parent = atRoot ? -1 : parentNode;
        // Does the header carry an EXPLICIT indentation indicator (`|N`/`>N`, a digit right after the
        // introducer / chomp char)? If so the content column is PINNED at parentNode + N (§8.1.1.1):
        // content lines are those at column ≥ that pin, and the auto-detect / leading-blank rule below
        // does not apply (a leading-more-indented blank line is then legal — `>3`). M5C3 `>1` after a
        // property line: parentNode = the `folded` key column (0), so content sits at column 1.
        const indMatch = source.slice(startPos + 1).match(/^[+-]?([1-9])/);
        const explicitIndicator = !!indMatch;
        const pinnedContentCol = indMatch && !atRoot ? parentNode + Number(indMatch[1]) : -1;
        let p = pos; while (p < source.length && source[p] !== '\n') p++; if (p < source.length) p++;  // skip the header line
        // §8.1.1.1: with NO explicit indicator the content indentation is auto-detected from the
        // first non-empty line, and a LEADING blank line may not be MORE indented than that content
        // (else the indentation is ambiguous → an error). Track the deepest leading-blank column;
        // when the first content line lands, a deeper leading blank with no explicit indicator is a
        // parse error. (yaml-test-suite 5LLU `> \n  \n   \n invalid`, S98Z `>` then deeper blanks +
        // ` # comment`, W9L4 `|` then a 5-space blank before 2-space content.)
        let maxLeadingBlankCol = -1, sawContent = false;
        while (p < source.length) {
          let q = p, c = 0;
          while (q < source.length && source[q] === ' ') { q++; c++; }
          if (q >= source.length) { p = q; break; }
          if (source[q] === '\n' || source[q] === '\r') {                 // blank line — part of the scalar
            if (!sawContent && c > maxLeadingBlankCol) maxLeadingBlankCol = c; // a leading blank's column
            p = q + 1; if (source[q] === '\r' && source[p] === '\n') p++;
            continue;
          }
          if (source[q] === '\t') {                                        // a TAB in a blank line of the body
            let t = q; while (t < source.length && (source[t] === ' ' || source[t] === '\t')) t++;
            if (t >= source.length || source[t] === '\n' || source[t] === '\r') {
              // Whitespace-only line with a tab: the tab sits at column c. A tab at column ≤ the
              // parent indent is a §6.1 indentation error inside the scalar (the line cannot be a
              // more-indented content/blank line — `foo: |\n\t\nbar` Y79Y); a DEEPER tab (column >
              // parent) is harmless blank content. Throw only the shallow case.
              if (c <= parent) throw new Error(`Tab character used in indentation at offset ${q}`);
              if (!sawContent && c > maxLeadingBlankCol) maxLeadingBlankCol = c;
              p = t + 1; if (source[t] === '\r' && source[p] === '\n') p++;
              continue;
            }
          }
          if (c === 0 && markerAt(source, q)) break;                       // a col-0 `---`/`...` ends the scalar
          // A content line is one indented more than the parent node — OR, with an EXPLICIT indicator,
          // one at/above the pinned content column (parentNode + N). The pin lets content sit shallower
          // than a property line that introduced the scalar (M5C3 `>1` content at col 1, property at col 3).
          const isContent = pinnedContentCol >= 0 ? c >= pinnedContentCol : c > parent;
          if (isContent) {
            if (!sawContent && maxLeadingBlankCol > c && !explicitIndicator) { // §8.1.1.1 leading blank more-indented than content
              throw new Error(`Block scalar leading empty line is more indented than content at offset ${q}`);
            }
            sawContent = true;
            let e = q; while (e < source.length && source[e] !== '\n') e++; p = e < source.length ? e + 1 : e;
          }
          else break;                                                     // dedent → the block scalar ends
        }
        push({ type: indent.blockScalar!.token, text: source.slice(startPos, p), offset: startPos });
        pos = p;
        lineStart = true;
        continue;
      }

      // Close an interpolation hole (interpClose at baseline depth) → resume the template span.
      if (templateStack.length > 0 && source.startsWith(tplInterpClose, pos)) {
        const depth = templateStack[templateStack.length - 1];
        if (depth === 0) {
          templateStack.pop();
          const startPos = pos;
          pos += tplInterpClose.length;
          // Continuation spans (middle/tail): skip escape validation — the whole
          // template's tagged-ness was decided at its head and isn't re-derivable from
          // the prev token here (it's the interpolation's last token).
          const { endsWithInterp, end } = scanTemplateSpan(source, pos, false);
          if (endsWithInterp) {
            push({ type: '$templateMiddle', text: source.slice(startPos, end), offset: startPos });
            templateStack.push(0);
          } else {
            push({ type: '$templateTail', text: source.slice(startPos, end), offset: startPos });
          }
          pos = end;
          continue;
        } else {
          templateStack[templateStack.length - 1]--;
        }
      }

      // Track nested opening braces inside an interpolation hole
      if (templateStack.length > 0 && source.startsWith(tplBraceOpen, pos)) {
        templateStack[templateStack.length - 1]++;
      }

      // Template literal (simple or interpolated) — only if the grammar declares a template token.
      if (templateToken && (tplOpenCode >= 0 ? source.charCodeAt(pos) === tplOpenCode : source.startsWith(tplOpen, pos))) {
        const startPos = pos;
        // A template right after a value is TAGGED — invalid escapes are then legal
        // (cooked = undefined), so validate escapes only for an untagged literal.
        const tagged = prevIsValue(tokens[tokens.length - 1]);
        pos += tplOpen.length;
        const { endsWithInterp, end } = scanTemplateSpan(source, pos, !tagged);
        if (endsWithInterp) {
          push({ type: '$templateHead', text: source.slice(startPos, end), offset: startPos });
          templateStack.push(0);
        } else {
          push({ type: templateTokenName!, text: source.slice(startPos, end), offset: startPos });
        }
        pos = end;
        continue;
      }

      // ── Markup UNQUOTED attribute value: the moment we sit right after an `attributeAssign`
      // in tag mode (whitespace already skipped) and the next char doesn't open a quoted value,
      // scan the WHOLE unquoted value as one token — up to whitespace or `tagClose`. This is the
      // WHATWG unquoted-value state: `/` is a value char here, so `href=https://x/` keeps its
      // trailing `/` and `href=/css/app.css` works, while the `/>` self-close marker (which only
      // appears where NO value is being read) still tokenizes as punctuation. Scanning whole also
      // beats the declaration-order race that would let the identifier token grab `https:` alone. ──
      if (markup && mode === 'tag' && markup.unquotedValueToken && unquotedValueRe) {
        const prev = tokens[tokens.length - 1];
        if (prev && markup.attributeAssign && prev.text === markup.attributeAssign
            && !attrQuoteChars.includes(source[pos])) {
          unquotedValueRe.lastIndex = pos;
          const vm = unquotedValueRe.exec(source);
          if (vm) {
            push({ type: markup.unquotedValueToken, text: vm[0], offset: pos });
            pos += vm[0].length;
            continue;
          }
        }
      }

      // Flow mapping-separator after a quoted key or a closed flow collection (indentation grammars):
      // inside a flow collection a `:` immediately following a quoted (string) scalar OR a flow-CLOSE
      // delimiter (`]`/`}`) is the `key: value` separator, NOT the start of a plain scalar. The
      // plain-scalar token's head admits a leading `:` (`[:value]` is a legal `:`-led plain), so
      // without this guard it greedily swallows the separator-plus-value (`"k":v` → DQuoteKey + Plain
      // `:v`; `{a:1}:v` → … `}` + Plain `:v`), eating the entry separator. Neither a quoted scalar nor
      // a flow collection can run past its closing delimiter, so a `:` glued to one is unambiguously
      // the separator — emit it as the `:` punctuation literal here. Gated on flow (block-context `:`
      // separators are handled by the KEY-position lookaheads). yaml-test-suite 5MUD / 5T43 / 9MMW
      // / C2DT / K3WX (quoted key) and the flow-collection-key cohort.
      if (indent && flowDepth > 0 && source[pos] === ':') {
        const prevTok = tokens[tokens.length - 1];
        if (prevTok && (stringTokenNames.has(prevTok.type) || (prevTok.type === '' && flowCloseSet.has(prevTok.text)))) {
          push({ type: '', text: ':', offset: pos });
          pos += 1;
          continue;
        }
      }

      let matched = false;

      // Try token patterns in declaration order (the template token is handled above). Each matcher
      // is a STICKY regex; setting `lastIndex = pos` and `exec(source)` matches exactly at `pos`
      // with no rest-of-source slice (the old `remaining.match(/^…/)` allocated the whole tail every
      // position — the O(N²) cost this loop removes). The per-position char code feeds the first-char
      // filter (Win B): a matcher whose proven first-char set excludes it is skipped without running
      // the regex (so a `(` skips all 16 word/number/string/comment regexes before the punct loop).
      const cc = source.charCodeAt(pos);
      for (const tm of tokenMatchers) {
        if (tm.name === templateTokenName) continue;
        if (markupTokenNames.has(tm.name)) continue;   // scanned by the markup state machine
        if (indentTokenNames.has(tm.name)) continue;    // emitted by the indentation state machine
        if (tm.blockOnly && flowDepth > 0) continue;    // line-structural token (YAML directive) — content in flow
        if (tm.isRegex) {
          // prev is a completed value → `/` is division, not a regex literal → skip.
          if (prevIsValue(tokens[tokens.length - 1])) continue;
        }
        // Outside flow collections, an indentation grammar may widen a token (its block variant
        // treats flow indicators as plain content); inside flow, the default restricted form wins.
        const useBlock = !!(tm.blockRegex && flowDepth === 0);
        // First-char filter: skip a matcher whose proven set can't begin with `cc`. `null` ⇒ no proof
        // ⇒ always try (sound). For cc ≥ 128 (non-ASCII), only matchers whose set admits non-ASCII run.
        const filt = useBlock ? tm.blockFirst : tm.first;
        if (filt && (cc > 127 ? !filt.nonAscii : !filt.ascii.has(cc))) continue;
        const re = useBlock ? tm.blockRegex! : tm.regex;
        re.lastIndex = pos;
        const m = re.exec(source);
        if (m) {
          // Document marker inside a multi-line QUOTED scalar (indentation grammars): a col-0
          // `---`/`...` followed by ws/EOL is an UNCONDITIONAL document boundary that outranks an
          // open quote (§9.1.1 — a quoted scalar may not span a document boundary). The quote regex
          // greedily swallowed it; scan the matched text's INTERNAL lines (right after each `\n`) and
          // if one begins at column 0 with such a marker, TRUNCATE the match to just before that
          // `\n`. The now-unterminated quote leaves an opening delimiter the parser can't complete
          // (and the trailing real quote later lex-errors) → reject, while the marker re-lexes as
          // DocStart/DocEnd. FN-safe: a mid-line / indented / non-marker `---` keeps markerAt false.
          // (yaml-test-suite 5TRB `---\n"\n---\n"`, 9MQT `--- "a\n... x\nb"`, RXY3 `---\n'\n...\n'`.)
          if (tm.isString && indent?.blockScalar && m[0].includes('\n')) {
            let cut = -1;
            for (let k = 0; k < m[0].length; k++) {
              if (m[0][k] === '\n' && markerAt(source, pos + k + 1)) { cut = k; break; }
            }
            if (cut >= 0) {
              push({ type: tm.name, text: m[0].slice(0, cut), offset: pos });
              pos += cut;
              matched = true;
              break;
            }
          }
          // MULTI-LINE QUOTED scalar indentation (indentation grammars, block context only): each
          // non-blank CONTINUATION line of a `"…"`/`'…'` that spans newlines must be indented MORE than
          // the scalar's parent node — leading SPACES strictly greater than parentCol (a TAB is not
          // indentation per §6.1, so a leading tab counts as 0 spaces → fails where indentation is
          // required; a tab AFTER enough spaces is content). yaml rejects an under-indented continuation
          // as "Missing closing quote" (the scalar can't continue). parentCol is context-sensitive:
          //  • inline VALUE / compact (`foo: "a\nb`, `- "a\nb`) → currentLineCol (the indicator's line);
          //  • inline after a doc marker (`--- "a\nb`) → -1 (a doc-root scalar may sit at column 0);
          //  • LINE-LEAD own-line value (`k:\n  "a\n  b`) → the enclosing block level (stack[len-2]);
          //  • LINE-LEAD at the document root (a bare top-level `"a\nb`, or `---\n"a\nb`) → -1.
          // Blank (whitespace-only) continuation lines are skipped — they are folded line breaks, legal
          // at any column. Flow is exempt (indentation suspended). yaml-test-suite DK95[1] / QB6E.
          if (tm.isString && indent?.blockScalar && flowDepth === 0 && m[0].includes('\n')) {
            const prevT = tokens[tokens.length - 1];
            const prevIsDocMarker = !!prevT && blockScalarDocMarkers.includes(prevT.text);
            let parentCol: number;
            if (atLineLead) parentCol = indentStack.length > 1 ? indentStack[indentStack.length - 2] : -1;
            else if (prevIsDocMarker) parentCol = -1;
            else parentCol = currentLineCol;
            let bad = -1;
            for (let k = 0; k < m[0].length; k++) {
              if (m[0][k] !== '\n') continue;
              let e = k + 1; while (e < m[0].length && m[0][e] !== '\n') e++;   // the continuation line
              const line = m[0].slice(k + 1, e);
              if (line.trim() === '') continue;                                // blank line — a folded break, any column
              const sp = line.length - line.replace(/^ +/, '').length;        // leading SPACES (a tab is not indentation)
              if (sp <= parentCol) { bad = pos + k + 1; break; }
            }
            if (bad >= 0) throw new Error(`Multi-line quoted scalar continuation is not sufficiently indented at offset ${bad}`);
          }
          // Comment-separation (indentation grammars): a comment indicator (`#`) opens a comment
          // only at line start or after whitespace (§6.6). A `#` GLUED to a preceding non-space
          // (`]#x`, `,#x`, `"v"#c`) is NOT a comment — it is invalid content, so refuse the comment
          // match here and let it fall through to a lex error. (A `#` inside a plain scalar is
          // absorbed by the scalar token itself, so this only ever fires on a stray glued `#`.)
          if (indent?.comment && m[0].startsWith(indent.comment) && pos > 0) {
            const before = source[pos - 1];
            if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r') break;
          }
          // An identifier(-prefix) token whose `\u` escapes decode to a non-identifier
          // codepoint (`!` = `!`, a ZWNJ at start) is a lex error, not a token.
          if (identLikeTokenNames.has(tm.name) && !identTextValid(tm.name, m[0])) {
            throw new Error(`Invalid identifier escape at offset ${pos}: '${m[0]}'`);
          }
          if (!tm.skip) {
            push({ type: tm.name, text: m[0], offset: pos });
          } else {
            if (m[0].includes('\n')) pendingNl = true;   // a skipped comment spanning a newline still terminates the previous line
            // An inline comment (indentation grammars) ENDS a plain scalar — flag the next token so a
            // multi-line fold won't reabsorb a post-comment line (yaml-test-suite 8XDJ / BF9H).
            if (indent?.comment && m[0].startsWith(indent.comment)) pendingComment = true;
          }
          pos += m[0].length;
          matched = true;
          break;
        }
      }

      if (!matched) {
        // Try punctuation literals (longest first)
        for (const lit of punctLiterals) {
          if (source.startsWith(lit, pos)) {
            // Track control-head parens so a `/` after `if (…)`/`while (…)` is a regex.
            // The keyword must be a real keyword head, not a member name: `obj.for(x) / y`
            // is a method call + division, so skip when the keyword is itself preceded by
            // a member accessor (e.g. `.`/`?.`, from divisionAfterTexts) → property access.
            if (lit === '(') {
              const prev = tokens[tokens.length - 1];
              const beforePrev = tokens[tokens.length - 2];
              const isMemberName = !!beforePrev && memberAccessTexts.has(beforePrev.text);
              parenHeadStack.push(
                !isMemberName && !!prev && prev.type === identTokenName && parenHeadKeywords.has(prev.text),
              );
            } else if (lit === ')') {
              lastCloseWasParenHead = parenHeadStack.pop() ?? false;
            }
            // An ambiguous postfix/prefix op (`!`): it is the value-producing postfix form
            // iff it follows a value (computed BEFORE pushing it, so prev is the token
            // before it). Chains correctly (`a!!`): each `!` reads the prior one's flag.
            if (postfixAfterValueTexts.has(lit)) lastBangWasPostfix = prevIsValue(tokens[tokens.length - 1]);
            // COMPACT NOTATION (YAML): when this `-`/`?` indicator is the FIRST token of its line
            // and its nested node begins INLINE with block-structural content (a `key:` mapping or a
            // further `-`/`?` indicator), the node's real indentation is that content's column, not
            // the indicator's. Push that column and emit an INDENT right after the indicator so the
            // compact line yields the same shape as the next-line-indented form (a following sibling
            // line aligned with the content then DEDENTs/NEWLINEs correctly). A leaf scalar after the
            // indicator (`- a`) is NOT structural → no push (so simple sequences are unchanged).
            const wasLineLead = atLineLead;
            // Track a line-lead `?` explicit-key column so its paired `:` can legalise a compact `: -`.
            if (indent && flowDepth === 0 && wasLineLead && lit === '?') lastExplicitKeyCol = currentLineCol;
            push({ type: '', text: lit, offset: pos });
            pos += lit.length;
            // The EXPLICIT-value half of a `? key` entry whose value is a `-` SEQUENCE on the SAME line
            // (`? k\n: - one\n  - two`; yaml-test-suite 5WE3 / KK5P) needs the SAME compact push as a
            // `-`/`?` indicator — without it the items split across indent levels (the `- one` never opens
            // a block, so the aligned `- two` folds as a plain continuation). This compact `: -` is legal
            // ONLY as an explicit value: the `:` must be LINE-LEAD and sit at the SAME column as its
            // paired `?` (lastExplicitKeyCol). A `:` at any other column — an inline `? k : - one`, an
            // implicit `key: - b`, a MISALIGNED `m:\n  ? a\n: - x` (the `:` dedented below its `?`), or a
            // bare empty-key `: - x` (no `?` at all) — is a §-illegal same-line block-seq value that yaml
            // rejects, so it must NOT push (leaving the items unindented → the parser rejects, as before).
            // Restricted to a `-` value (a `: key: v` compact-mapping value is the separate ZCZ6 concern).
            const dashAfter = (i: number): boolean => {
              let q = i; while (q < source.length && source[q] === ' ') q++;
              return q > i && source[q] === '-' && sepAfter(source[q + 1]);
            };
            const colonPairsExplicit = wasLineLead && lit === ':' && currentLineCol === lastExplicitKeyCol;
            const compactColon = colonPairsExplicit && dashAfter(pos);
            // A line-lead `:` at its `?`'s column USES UP that pairing — the explicit entry now has its
            // value, so a SECOND `: …` at the same column (`? a\n: - b\n: - c`, yaml-test-suite cousin) is
            // a bare empty-key entry, not another explicit value → it must not get the compact push.
            if (colonPairsExplicit) lastExplicitKeyCol = -1;
            if (indent && flowDepth === 0 && (compactColon || (wasLineLead && compactIndicatorSet.has(lit)))) {
              // Only SPACES separate the indicator from its inline content: a TAB there is the
              // nested node's indentation, which §6.1 forbids — so leave it for the whitespace
              // branch's tab check to reject (`-\t-`, `?\tkey:`) rather than nesting it.
              let q = pos; while (q < source.length && source[q] === ' ') q++;
              const contentCol = currentLineCol + (q - (pos - lit.length));
              const c = source[q];
              if (q > pos && c !== undefined && c !== '\n' && c !== '\r'
                  && !(indent.comment && source.startsWith(indent.comment, q))
                  && contentCol > indentStack[indentStack.length - 1]
                  && compactNestsHere(source, q)) {
                indentStack.push(contentCol);
                push({ type: indent.indentToken, text: '', offset: q });
                atLineLead = true;     // the inline content is itself a fresh line-lead (so `? - x` nests once more if `- x` is structural)
              }
            }
            matched = true;
            break;
          }
        }
      }

      if (!matched && identLikeTokenNames.size) {
        // Extend a just-emitted identifier token that the ASCII pattern cut short at a
        // continue-only Unicode char: `ab<ZWNJ>cd` lexes `ab` (ASCII), then this absorbs
        // `<ZWNJ>cd` into it. Only when the previous token is an identifier(-prefix) token
        // immediately adjacent to `pos` (no whitespace/other token between).
        const prev = tokens[tokens.length - 1];
        if (prev && identLikeTokenNames.has(prev.type) && prev.offset + prev.text.length === pos) {
          uniIdentContReY.lastIndex = pos;
          const cont = uniIdentContReY.exec(source);
          if (cont) {
            prev.text += cont[0];
            pos += cont[0].length;
            matched = true;
          }
        }
      }

      if (!matched && identTokenName) {
        // Fallback: a Unicode identifier the declared identifier token's pattern may have
        // missed (e.g. accented or non-Latin names, `℘`, ZWNJ/ZWJ). Tagged with that token's name.
        uniIdentReY.lastIndex = pos;
        const identMatch = uniIdentReY.exec(source);
        if (identMatch) {
          push({ type: identTokenName, text: identMatch[0], offset: pos });
          pos += identMatch[0].length;
          matched = true;
        }
      }

      if (!matched && prefixedIdentTokens.length) {
        // Same Unicode fallback for a prefixed-identifier token (`#℘`): match the literal
        // prefix, then a Unicode IdentifierName on the rest, and emit the whole as one token.
        for (const pt of prefixedIdentTokens) {
          if (!source.startsWith(pt.prefix, pos)) continue;
          uniIdentReY.lastIndex = pos + pt.prefix.length;
          const m = uniIdentReY.exec(source);
          if (m) {
            const text = pt.prefix + m[0];
            push({ type: pt.name, text, offset: pos });
            pos += text.length;
            matched = true;
            break;
          }
        }
      }

      // FLOW illegal-head plain CONTINUATION (indentation grammars): a char that no token can START
      // here (a plain-scalar HEAD forbids `%`/`@`/backtick — illegal plain STARTS), when it directly
      // follows a plain scalar INSIDE a flow collection, is mid-scalar CONTENT (`{ matches\n% : 20 }`
      // → key "matches %"; yaml-test-suite UT92). Consume that head char plus whatever plain BODY
      // follows (the generic plain flow pattern at the next position), emit it as a plain-continuation
      // token, and let the flow fold post-pass merge it with the preceding scalar. Gated on flowDepth>0
      // AND prev being a plain-family token, so a leading illegal char with no preceding plain (`{ % :
      // 20 }`) still falls through to the lex error below. Fully derived — no hardcoded char set.
      if (!matched && indent && flowDepth > 0 && plainContinuationTokenName && plainFlowRe) {
        const prevTok = tokens[tokens.length - 1];
        if (prevTok && plainScalarTokenNames.has(prevTok.type)) {
          const bodyM = source.slice(pos + 1).match(plainFlowRe);     // plain BODY after the illegal head char
          const text = source[pos] + (bodyM ? bodyM[0] : '');
          push({ type: plainContinuationTokenName, text, offset: pos });
          pos += text.length;
          matched = true;
        }
      }

      if (!matched) {
        throw new Error(`Unexpected character at offset ${pos}: '${source[pos]}'`);
      }

      // ── Markup TAG mode: track the tag being read so the closing `tagClose` knows
      // whether to enter raw-text mode. Runs only for tokens emitted in tag mode (the
      // text/raw-text branches `continue` above, never reaching here). ──
      if (markup && mode === 'tag') {
        const last = tokens[tokens.length - 1];
        if (last) {
          if (last.text === markup.tagClose) {
            const isRaw = !sawCloseMarker && rawTextTagSet.has(curTag.toLowerCase());
            mode = isRaw ? 'rawtext' : 'text';
            // A raw-text element is NEVER self-closing (WHATWG): a `/` right before the
            // `>` of `<script …/>` is IGNORED, not a self-close marker — the body runs as
            // raw-text to the matching close tag (or EOF). Drop that `/` token so the parser
            // sees a plain raw-text START tag (`<script …>`), not the self-close arm. (Void /
            // non-raw self-close like `<br/>`, `<div/>` are untouched — they don't enter
            // raw-text, so this never fires for them.) Matches parse5.
            if (isRaw && markup.closeMarker) {
              const slash = tokens[tokens.length - 2];
              if (slash && slash.type === '' && slash.text === markup.closeMarker) {
                tokens.splice(tokens.length - 2, 1);
              }
            }
            inTagName = false; sawCloseMarker = false;
          } else if (inTagName) {
            if (markup.closeMarker && last.text === markup.closeMarker) sawCloseMarker = true;
            else {
              curTag = last.text; inTagName = false;
              // An OPEN void-element name → retag so the parser's void branch matches it.
              if (markup.voidNameToken && !sawCloseMarker && voidTagSet.has(curTag.toLowerCase())) {
                last.type = markup.voidNameToken;
              }
            }
          }
        }
      }
    }

    // Indentation mode: unwind any still-open blocks at EOF (emit the closing DEDENTs).
    if (indent) {
      while (indentStack.length > 1) {
        indentStack.pop();
        push({ type: indent.dedentToken, text: '', offset: pos });
      }
    }

    // Multi-line PLAIN-scalar FOLD inside flow (indentation grammars): a plain scalar may span several
    // lines inside a flow collection (`{ multi\n  line: value }` → key "multi line"). The lexer breaks
    // it at each newline (a `\n` is not plain-scalar content), so it arrives as ADJACENT plain-scalar
    // tokens with no punctuation between (a SPACE-separated plain is already one token — only a newline
    // splits one — so two consecutive plain tokens were necessarily newline-separated, i.e. a fold).
    // Merge each such run into one token, taking the LAST token's TYPE (a trailing `key:` line makes the
    // whole fold a key; an unkeyed run stays a plain value) and the first's offset/leading flags. Only
    // inside flow (block context separates siblings with a NEWLINE token, so plains are never adjacent
    // there). yaml-test-suite 8KB6 / NJ66 / CT4Q. A `,`/`:`/bracket between scalars is a separate token,
    // so it naturally breaks the run (the next scalar isn't adjacent) — no over-merge across separators.
    if (indent && plainScalarTokenNames.size) {
      const merged: Token[] = [];
      let depth = 0;
      for (const t of tokens) {
        const prev = merged[merged.length - 1];
        // A comment ENDS a plain scalar (§6.6), so a scalar that follows a skipped comment (flagged
        // `commentBefore`) must NOT fold into the previous one — yaml-test-suite CML9 rejects
        // `[ word1\n# c\n word2 ]`. Guarding on `t.commentBefore` keeps that a reject.
        if (depth > 0 && prev && !t.commentBefore
            && plainScalarTokenNames.has(prev.type) && plainScalarTokenNames.has(t.type)) {
          prev.text += ' ' + t.text;   // fold: newline+indent → a single space
          prev.type = t.type;          // the run's type is its LAST line's (key-ness follows the trailing `:`)
        } else {
          merged.push(t);
        }
        if (t.type === '') {
          if (flowOpenSet.has(t.text)) depth++;
          else if (flowCloseSet.has(t.text)) depth = Math.max(0, depth - 1);
        }
      }
      return merged;
    }

    return tokens;
  }

  return { tokenize };
}
