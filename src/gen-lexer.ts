import type { CstGrammar } from './types.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';

// A lexer token: a declared token (type = its name) or a punctuation literal (type = '').
// `$templateHead/$templateMiddle/$templateTail` are synthetic types the lexer emits for
// the pieces of an interpolated template — role names, not language-specific.
export interface Token {
  type: string;   // token decl name (e.g. 'Ident'), or '' for punctuation literals
  text: string;
  offset: number;
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

  // Token matchers (order matters: earlier declarations win)
  const tokenMatchers = grammar.tokens.map(t => ({
    name: t.name,
    regex: new RegExp(`^(?:${t.pattern})`),
    skip: t.flags.includes('skip'),
    isRegex: t.flags.includes('regex'),
  }));

  // ── Lexer hints (declared per-token in the grammar; nothing here hardcodes a
  // specific language's tokens — see the `identifier`/`template`/`regexContext` opts) ──
  const identTokenName = grammar.tokens.find(t => t.identifier)?.name;
  const templateToken = grammar.tokens.find(t => t.template);
  const templateTokenName = templateToken?.name;
  const tplOpen = templateToken?.template?.open ?? '';
  const tplInterpOpen = templateToken?.template?.interpOpen ?? '';
  const tplInterpClose = templateToken?.template?.interpClose ?? '';
  const tplBraceOpen = tplInterpOpen.slice(-1);                          // brace that deepens interp nesting ('{' of '${')
  const tplOpenCode = tplOpen.length === 1 ? tplOpen.charCodeAt(0) : -1; // fast path when the open delimiter is one char

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

  // Scan from inside a template span to its next boundary: an interpolation hole
  // (`interpOpen`) or the closing delimiter (`open`). Delimiters come from the
  // grammar's template token; only called when such a token is declared.
  function scanTemplateSpan(source: string, pos: number): { endsWithInterp: boolean; end: number } {
    while (pos < source.length) {
      if (source[pos] === '\\') {
        pos += 2;
      } else if (source.startsWith(tplInterpOpen, pos)) {
        return { endsWithInterp: true, end: pos + tplInterpOpen.length };
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

    while (pos < source.length) {
      // Skip whitespace
      const wsMatch = source.slice(pos).match(/^\s+/);
      if (wsMatch) { pos += wsMatch[0].length; continue; }

      // Close an interpolation hole (interpClose at baseline depth) → resume the template span.
      if (templateStack.length > 0 && source.startsWith(tplInterpClose, pos)) {
        const depth = templateStack[templateStack.length - 1];
        if (depth === 0) {
          templateStack.pop();
          const startPos = pos;
          pos += tplInterpClose.length;
          const { endsWithInterp, end } = scanTemplateSpan(source, pos);
          if (endsWithInterp) {
            tokens.push({ type: '$templateMiddle', text: source.slice(startPos, end), offset: startPos });
            templateStack.push(0);
          } else {
            tokens.push({ type: '$templateTail', text: source.slice(startPos, end), offset: startPos });
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
        pos += tplOpen.length;
        const { endsWithInterp, end } = scanTemplateSpan(source, pos);
        if (endsWithInterp) {
          tokens.push({ type: '$templateHead', text: source.slice(startPos, end), offset: startPos });
          templateStack.push(0);
        } else {
          tokens.push({ type: templateTokenName!, text: source.slice(startPos, end), offset: startPos });
        }
        pos = end;
        continue;
      }

      const remaining = source.slice(pos);
      let matched = false;

      // Try token patterns in declaration order (the template token is handled above)
      for (const tm of tokenMatchers) {
        if (tm.name === templateTokenName) continue;
        if (tm.isRegex) {
          const prev = tokens[tokens.length - 1];
          if (prev) {
            // Expression-start keywords (in, throw, return, etc.) flip back to regex context
            const isExprKeyword = prev.type === identTokenName && expressionStartKeywords.has(prev.text);
            // A `)` that closed a control head (`if (…) /re/`) is not a value → regex.
            const isParenHead = prev.text === ')' && lastCloseWasParenHead;
            if (!isExprKeyword && !isParenHead && (divisionPrevTypes.has(prev.type) || divisionPrevTexts.has(prev.text))) {
              continue;
            }
          }
        }
        const m = remaining.match(tm.regex);
        if (m) {
          if (!tm.skip) {
            tokens.push({ type: tm.name, text: m[0], offset: pos });
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
            tokens.push({ type: '', text: lit, offset: pos });
            pos += lit.length;
            matched = true;
            break;
          }
        }
      }

      if (!matched && identTokenName) {
        // Fallback: a Unicode identifier the declared identifier token's pattern may have
        // missed (e.g. accented or non-Latin names). Tagged with that token's name.
        const identMatch = remaining.match(/^[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}_$]*/u);
        if (identMatch) {
          tokens.push({ type: identTokenName, text: identMatch[0], offset: pos });
          pos += identMatch[0].length;
          matched = true;
        }
      }

      if (!matched) {
        throw new Error(`Unexpected character at offset ${pos}: '${source[pos]}'`);
      }
    }

    return tokens;
  }

  return { tokenize };
}
