import type { CstGrammar } from './types.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';

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
  const tokenMatchers = grammar.tokens.map(t => ({
    name: t.name,
    regex: new RegExp(`^(?:${t.pattern})`),
    blockRegex: t.blockPattern ? new RegExp(`^(?:${t.blockPattern})`) : null,
    skip: t.flags.includes('skip'),
    isRegex: t.flags.includes('regex'),
  }));

  // ── Lexer hints (declared per-token in the grammar; nothing here hardcodes a
  // specific language's tokens — see the `identifier`/`template`/`regexContext` opts) ──
  const identTokenName = grammar.tokens.find(t => t.identifier)?.name;
  // Unicode identifier fallback: a literal identifier character the declared identifier
  // token's (necessarily ASCII / escape-only — patterns compile without /u) pattern can't
  // match — `℘` (Other_ID_Start), accented letters, ZWNJ/ZWJ, combining marks. ID_Start /
  // ID_Continue are the spec's identifier classes (`$` and `_` are ID_Start; an
  // IdentifierPart additionally admits `$`, ZWNJ U+200C and ZWJ U+200D). Built once.
  const uniIdentRe = /^[$_\p{ID_Start}][$‌‍\p{ID_Continue}]*/u;
  // An IdentifierPart run (ID_Continue + `$`, ZWNJ, ZWJ): used to EXTEND an ASCII identifier
  // token that stopped at a continue-only Unicode char (`ab<ZWNJ>cd` — the ASCII pattern emits
  // `ab`, then this consumes `<ZWNJ>cd` and folds it back into the preceding identifier).
  const uniIdentContRe = /^[$‌‍\p{ID_Continue}]+/u;
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
  const templateEscapeValidRe = templateToken?.escapeValidPattern
    ? new RegExp(templateToken.escapeValidPattern, 'y')
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
  const unquotedValueRe = markup ? new RegExp(
    '^[^\\s' + ccEscape(attrQuoteChars.join('') + markup.tagOpen + markup.tagClose +
      (markup.attributeAssign ?? '=') + '`') + ']+',
  ) : null;
  // What char (right after `tagOpen`) actually opens a tag (markup.tagOpenAfter is a char-class
  // BODY, so it's used verbatim, not re-escaped). When declared, a `tagOpen` followed by anything
  // else is a literal text char (WHATWG tag-open state: `<p>a < b</p>` keeps `<` as text). ABSENT
  // → null, and a `tagOpen` always opens a tag (legacy behaviour, unchanged for other grammars).
  const tagOpenAfterRe = markup?.tagOpenAfter ? new RegExp('[' + markup.tagOpenAfter + ']') : null;

  // ── Indentation mode (opt-in; dormant unless the grammar declares `indent`) ──
  // Like markup, the INDENT/DEDENT/NEWLINE tokens are EMITTED by a state machine (not matched
  // by a regex) — so they are skipped in the regex loop and their grammar patterns are
  // placeholders. Indentation is suspended inside flow delimiters via a flow-depth counter.
  const indent = grammar.indent;
  const indentTokenNames = new Set<string>(
    indent ? ([indent.indentToken, indent.dedentToken, indent.newlineToken].filter(Boolean) as string[]) : [],
  );
  const flowOpenSet = new Set(indent?.flowOpen ?? []);
  const flowCloseSet = new Set(indent?.flowClose ?? []);
  // Block scalars (YAML | / >): an introducer char + indent/chomp indicators + optional trailing
  // comment to end-of-line is the SIGNATURE (so `a > b` isn't mistaken for one); the following
  // more-indented lines are verbatim content, emitted as one token (skipped in the regex loop).
  const blockScalarIntro = new Set(indent?.blockScalar?.introducers ?? []);
  // A trailing `#…` on the header line is a comment only after whitespace (`> # c`), never glued
  // to the indicator (`>#c` is invalid — §6.8); the `(?<=[ \t])` makes the comment require a
  // preceding space, so a glued `#` fails the signature and the `>`/`|` is not taken as a header.
  const blockScalarSig = /^[|>](?:[1-9][+-]?|[+-][1-9]?|[+-]|)[ \t]*(?:(?<=[ \t])#[^\n]*)?(?:\r?\n|$)/;
  if (indent?.blockScalar) indentTokenNames.add(indent.blockScalar.token);
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
    let lineStart = !!indent;        // at a block-context line boundary (file start counts as one)
    let emittedContent = false;      // any real (non-structural) token emitted yet — suppress a leading NEWLINE/DEDENT
    let currentLineCol = 0;          // leading-space column of the current logical line (bounds block scalars)
    const indentStack: number[] = [0];
    function push(t: Token): void {
      if (pendingNl) { t.newlineBefore = true; pendingNl = false; }
      if (pendingComment) { t.commentBefore = true; pendingComment = false; }
      tokens.push(t);
      if (indent) {
        if (!indentTokenNames.has(t.type)) emittedContent = true;   // a real token (not INDENT/DEDENT/NEWLINE)
        if (t.type === '') {                                         // track flow depth on punctuation literals
          if (flowOpenSet.has(t.text)) flowDepth++;
          else if (flowCloseSet.has(t.text)) flowDepth = Math.max(0, flowDepth - 1);
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
      if (indent && flowDepth === 0 && lineStart) {
        let p = pos, col = 0;
        while (p < source.length && source[p] === ' ') { p++; col++; }
        const ch = source[p];
        if (p >= source.length) { pos = p; lineStart = false; continue; }   // EOF — final DEDENTs emitted after the loop
        if (ch === '\n' || ch === '\r') {                                   // blank line — ignored for structure
          pos = p + 1; if (ch === '\r' && source[pos] === '\n') pos++;
          continue;                                                         // still at a line start
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
        if (ch === '\t') {
          let q = p; while (q < source.length && (source[q] === ' ' || source[q] === '\t')) q++;
          const after = source[q];
          if (q < source.length && after !== '\n' && after !== '\r' && startsBlockStructuralNode(source, q)) {
            throw new Error(`Tab character used in indentation at offset ${p}`);
          }
        }
        if (indent.comment && source.startsWith(indent.comment, p)) {       // comment-only line — ignored
          let e = p; while (e < source.length && source[e] !== '\n') e++;
          pos = e; pendingComment = true; continue;                         // next iteration consumes the newline
        }
        pos = p;                                                            // consume the leading indentation
        currentLineCol = col;                                               // bounds a block scalar started on this line
        const top = indentStack[indentStack.length - 1];
        if (col > top) {
          indentStack.push(col);
          push({ type: indent.indentToken, text: '', offset: pos });
        } else {
          while (indentStack.length > 1 && indentStack[indentStack.length - 1] > col) {
            indentStack.pop();
            push({ type: indent.dedentToken, text: '', offset: pos });
          }
          if (emittedContent && indentStack[indentStack.length - 1] === col) {
            push({ type: indent.newlineToken, text: '', offset: pos });     // sibling separator at this level
          }
        }
        lineStart = false;
        continue;
      }

      // Whitespace. In indentation mode, inline spaces/tabs are skipped but a NEWLINE is a
      // block-context line boundary (sets lineStart so the routine above runs next) — except
      // inside flow delimiters, where newlines are insignificant. Otherwise skip any run.
      if (indent) {
        const c = source[pos];
        if (c === ' ' || c === '\t') {
          // A TAB between a block indicator (`-`/`?`/map-`:`) and a NESTED block-structural node it
          // introduces is a §6.1 indentation error: the separation after the indicator counts as
          // the nested node's indentation (`-\t- x`, `?\tkey:`, `- \t-`, `:\tkey:`, `key:\t- a`). A
          // tab before a leaf scalar / flow / alias (`-\tplain`, `-\t[a]`, `-\t*a`) is harmless
          // separation, so the structural sniff gates it. After a `:` a node PROPERTY is the inline
          // value (`key:\t&a x` is legal), so the `:` case excludes properties (allowProperty=false)
          // while `-`/`?` include them (`-\t&a x` IS an error). Block context only (flowDepth===0).
          if (flowDepth === 0) {
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
          continue;
        }
      } else {
        const wsMatch = source.slice(pos).match(/^\s+/);
        if (wsMatch) { if (wsMatch[0].includes('\n')) pendingNl = true; pos += wsMatch[0].length; continue; }
      }

      // ── Block scalar (YAML | / >): from the introducer line, take all following lines more
      // indented than the current line's column as ONE verbatim token (blank lines included). ──
      if (indent?.blockScalar && flowDepth === 0 && blockScalarIntro.has(source[pos]) && blockScalarSig.test(source.slice(pos))) {
        const startPos = pos;
        let p = pos; while (p < source.length && source[p] !== '\n') p++; if (p < source.length) p++;  // skip the header line
        const parent = currentLineCol;
        while (p < source.length) {
          let q = p, c = 0;
          while (q < source.length && source[q] === ' ') { q++; c++; }
          if (q >= source.length) { p = q; break; }
          if (source[q] === '\n' || source[q] === '\r') {                 // blank line — part of the scalar
            p = q + 1; if (source[q] === '\r' && source[p] === '\n') p++;
            continue;
          }
          if (c > parent) { let e = q; while (e < source.length && source[e] !== '\n') e++; p = e < source.length ? e + 1 : e; }
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
          const vm = source.slice(pos).match(unquotedValueRe);
          if (vm) {
            push({ type: markup.unquotedValueToken, text: vm[0], offset: pos });
            pos += vm[0].length;
            continue;
          }
        }
      }

      const remaining = source.slice(pos);
      let matched = false;

      // Try token patterns in declaration order (the template token is handled above)
      for (const tm of tokenMatchers) {
        if (tm.name === templateTokenName) continue;
        if (markupTokenNames.has(tm.name)) continue;   // scanned by the markup state machine
        if (indentTokenNames.has(tm.name)) continue;    // emitted by the indentation state machine
        if (tm.isRegex) {
          // prev is a completed value → `/` is division, not a regex literal → skip.
          if (prevIsValue(tokens[tokens.length - 1])) continue;
        }
        // Outside flow collections, an indentation grammar may widen a token (its block variant
        // treats flow indicators as plain content); inside flow, the default restricted form wins.
        const re = tm.blockRegex && flowDepth === 0 ? tm.blockRegex : tm.regex;
        const m = remaining.match(re);
        if (m) {
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
          if (remaining.startsWith(lit)) {
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
            push({ type: '', text: lit, offset: pos });
            pos += lit.length;
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
          const cont = remaining.match(uniIdentContRe);
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
        const identMatch = remaining.match(uniIdentRe);
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
          if (!remaining.startsWith(pt.prefix)) continue;
          const m = remaining.slice(pt.prefix.length).match(uniIdentRe);
          if (m) {
            const text = pt.prefix + m[0];
            push({ type: pt.name, text, offset: pos });
            pos += text.length;
            matched = true;
            break;
          }
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

    return tokens;
  }

  return { tokenize };
}
