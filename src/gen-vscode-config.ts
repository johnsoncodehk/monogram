import type { CstGrammar } from './types.ts';
import { collectLiterals } from './grammar-utils.ts';
import { tokenPatternBlockDelimiters, tokenPatternHasStartAnchor, tokenPatternLiteralPrefix, tokenPatternSource, tokenPatternStringDelimiters } from './token-pattern.ts';

// Generate a VS Code `language-configuration.json` from the grammar. This is the
// editor-behavior artifact (comments, bracket pairs, auto-close/surround, folding,
// indentation) — distinct from highlighting (gen-tm) — and is derived entirely from
// the grammar's token definitions, lexer hints, and `scopes` section.

interface AutoPair { open: string; close: string; notIn?: string[]; }
// A VS Code onEnter `beforeText`/`afterText` is a regex SOURCE — a bare string (case-sensitive)
// or `{ pattern, flags }` (e.g. `i`, for case-insensitive tag matching in markup).
type EnterText = string | { pattern: string; flags: string };
export interface LanguageConfig {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: [string, string][];
  autoClosingPairs?: AutoPair[];
  surroundingPairs?: [string, string][];
  colorizedBracketPairs?: [string, string][];
  autoCloseBefore?: string;
  folding?: { markers: { start: string; end: string } };
  wordPattern?: string;
  indentationRules?: { increaseIndentPattern: string; decreaseIndentPattern: string };
  onEnterRules?: { beforeText: EnterText; afterText?: EnterText; action: { indent: string; appendText?: string; removeText?: number } }[];
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escClass = (s: string) => s.replace(/[\]^\\-]/g, '\\$&');

export function generateLanguageConfig(grammar: CstGrammar): LanguageConfig {
  const config: LanguageConfig = {};

  // Rule-body literals — to detect generic `<…>` brackets and the `:` separator.
  // (Both are already in the grammar's rules; nothing is added to the grammar.)
  const ruleLits = new Set<string>();
  for (const r of grammar.rules) for (const l of collectLiterals(r.body)) ruleLits.add(l);
  const hasAngle = ruleLits.has('<') && ruleLits.has('>'); // language uses <…> as generic brackets

  // ── Comments — from `skip` tokens, classified line/block by pattern shape ──
  const lineCands: { marker: string; anchored: boolean }[] = [];
  const blockCands: [string, string][] = [];
  for (const t of grammar.tokens) {
    if (!t.flags.includes('skip')) continue;
    const block = tokenPatternBlockDelimiters(t);
    if (block) {
      blockCands.push(block);
      continue;
    }
    const marker = tokenPatternLiteralPrefix(t);
    if (marker) lineCands.push({ marker, anchored: tokenPatternHasStartAnchor(t) });
  }
  // Canonical line comment: the non-anchored one with the shortest marker (// over ///, not #!).
  const lineComment = lineCands.filter(c => !c.anchored).sort((a, b) => a.marker.length - b.marker.length)[0]?.marker;
  // Canonical block comment: the shortest opener (/* over the /** doc variant).
  const blockComment = blockCands.slice().sort((a, b) => a[0].length - b[0].length)[0];
  // A markup grammar's comment is declared in its markup config (e.g. `<!--`…`-->`),
  // not as a skip token, so take it from there when present.
  const markupBlock: [string, string] | undefined = grammar.markup?.comment
    ? [grammar.markup.comment.open, grammar.markup.comment.close]
    : undefined;
  if (lineComment || blockComment || markupBlock) {
    config.comments = {};
    if (lineComment) config.comments.lineComment = lineComment;
    if (blockComment ?? markupBlock) config.comments.blockComment = blockComment ?? markupBlock;
  }

  // ── Brackets — from `punctuation.bracket.*` scopes + template interpolation ──
  const byScope = new Map<string, string[]>();
  for (const [lit, scopes] of grammar.scopeOverrides)
    for (const s of scopes) (byScope.get(s) ?? byScope.set(s, []).get(s)!).push(lit);

  const brackets: [string, string][] = [];
  const tpl = grammar.tokens.find(t => t.template)?.template;
  if (tpl) brackets.push([tpl.interpOpen, tpl.interpClose]); // ${ … }
  for (const [scope, lits] of byScope) {
    if (scope.startsWith('punctuation.bracket.') && lits.length === 2) {
      brackets.push([lits[0], lits[1]]); // scopes list open before close (declaration order)
    }
  }
  const plain = brackets.filter(([o]) => o.length === 1); // (), {}, [] — for colorize/indent
  if (brackets.length) {
    config.brackets = brackets;
    // Generic `<>` colorizes (and surrounds) but is NOT auto-closed/matched —
    // `<` `>` double as comparison operators, like VS Code's own config.
    config.colorizedBracketPairs = hasAngle ? [...plain, ['<', '>'] as [string, string]] : plain;
  }

  // ── Quotes — delimiters of `string`-flagged tokens + the template open ──
  const quotes = new Set<string>();
  for (const t of grammar.tokens) if (t.string) for (const q of tokenPatternStringDelimiters(t)) quotes.add(q);
  if (tpl) quotes.add(tpl.open);

  // ── Auto-closing + surrounding pairs ──
  const autoClosing: AutoPair[] = brackets.map(([open, close]) => ({ open, close }));
  for (const q of quotes) autoClosing.push({ open: q, close: q, notIn: ['string', 'comment'] });
  // Doc-comment opener (e.g. /** … */) auto-completes its closer.
  const doc = blockComment && blockCands.find(([b]) => b.length > blockComment[0].length && b.startsWith(blockComment[0]));
  if (doc) autoClosing.push({ open: doc[0], close: ' ' + doc[1], notIn: ['string'] });
  if (autoClosing.length) config.autoClosingPairs = autoClosing;

  const surrounding: [string, string][] = [...brackets, ...[...quotes].map(q => [q, q] as [string, string])];
  if (hasAngle) surrounding.push(['<', '>']);
  if (surrounding.length) config.surroundingPairs = surrounding;

  // ── autoCloseBefore — closers, separators, `=`, `:`, generic `>`, template ` ──
  const before = new Set<string>();
  for (const [, close] of brackets) if (close.length === 1) before.add(close);
  if (hasAngle) before.add('>');
  for (const [scope, lits] of byScope)
    if (/^punctuation\.(terminator|separator|accessor)/.test(scope) || scope === 'keyword.operator.assignment')
      for (const l of lits) if (l.length === 1) before.add(l);     // ; , . =
  if (ruleLits.has(':')) before.add(':');                          // type-annotation / key separator
  if (tpl?.open.length === 1) before.add(tpl.open);                // `
  if (before.size) config.autoCloseBefore = [...before].join('') + ' \n\t';

  // ── Folding markers — region/endregion using the derived line comment ──
  if (lineComment) {
    const c = escRe(lineComment);
    config.folding = { markers: { start: `^\\s*${c}\\s*#?region\\b`, end: `^\\s*${c}\\s*#?endregion\\b` } };
  }

  // ── Word pattern — the identifier token ──
  const ident = grammar.tokens.find(t => t.identifier);
  if (ident) config.wordPattern = tokenPatternSource(ident);

  // ── Indentation — derived from the single-char bracket pairs ──
  if (plain.length) {
    config.indentationRules = {
      decreaseIndentPattern: `^\\s*[${plain.map(([, c]) => escClass(c)).join('')}].*$`,
      increaseIndentPattern: `^.*(${plain.map(([o, c]) => `${escRe(o)}[^${escClass(c)}]*`).join('|')})$`,
    };
  }

  // ── onEnterRules — comment continuation (line + C-style block / JSDoc) ──
  const onEnter: NonNullable<LanguageConfig['onEnterRules']> = [];
  if (blockComment && blockComment[1] === blockComment[1][0] + '/') {  // C-style block: close is <cont>/
    const cont = blockComment[1][0];                                   // continuation char, e.g. '*'
    const c = escRe(cont), cls = escClass(cont);
    const open = escRe((doc && doc[0]) || blockComment[0]);            // '/\*\*' (JSDoc) or '/\*'
    const body = `([^${cls}]|${c}(?!/))*`;
    onEnter.push(
      { beforeText: `^\\s*${open}(?!/)${body}$`, afterText: `^\\s*${c}/$`, action: { indent: 'indentOutdent', appendText: ` ${cont} ` } },
      { beforeText: `^\\s*${open}(?!/)${body}$`, action: { indent: 'none', appendText: ` ${cont} ` } },
      { beforeText: `^(\\t|[ ])*${c}([ ]${body})?$`, action: { indent: 'none', appendText: `${cont} ` } },
      { beforeText: `^(\\t|[ ])*[ ]${c}/\\s*$`, action: { indent: 'none', removeText: 1 } },
    );
  }
  if (lineComment) { // continue `// …` on Enter (the lookbehind avoids URLs / escapes)
    onEnter.push({ beforeText: `(?<!\\\\|\\w:)${escRe(lineComment)}\\s*\\S`, afterText: `^(?!\\s*$).+`, action: { indent: 'none', appendText: `${lineComment} ` } });
  }
  if (onEnter.length) config.onEnterRules = onEnter;

  // ── Markup languages (HTML / Vue) — tag-structural editor behavior ──
  // A markup grammar (`grammar.markup`) carries the structural DATA — tag delimiters, the
  // void / raw-text element sets, the comment delimiters, the embed scopes — needed to DERIVE
  // the editor behavior a hand-written HTML/Vue language-configuration provides (tag-aware
  // indent / onEnter, region folding, comment + embedded-language brackets), which the token /
  // scope heuristics above cannot produce for a markup language. Everything below is derived
  // from that data; nothing is HTML-hardcoded — the same branch fits any markup grammar.
  const mk = grammar.markup;
  if (mk) {
    const tagOpen = mk.tagOpen, tagClose = mk.tagClose, closeMarker = mk.closeMarker ?? '/';
    const to = escRe(tagOpen), tc = escRe(tagClose), cm = escRe(closeMarker);
    const tcCls = escClass(tagClose), toCls = escClass(tagOpen);
    const tagName = ident ? tokenPatternSource(ident) : '[A-Za-z][\\w:.\\-]*'; // tag-name capture
    const nameClass = '[A-Za-z0-9_:.\\-]';                                      // tag-name body char class
    const cOpen = mk.comment?.open, cClose = mk.comment?.close;

    // A file that EMBEDS a programming language (a rawText / attribute / interpolation embed whose
    // scope is `source.*`) is edited with that language's brackets — `{}` `[]` `()`, backtick, the
    // JSDoc `/** */` — and a general word pattern, exactly as VS Code's HTML config does for its
    // embedded JS/CSS. A markup-only embed (e.g. Vue `<template>` → text.html.*) does not trigger it.
    const embedScopes: string[] = [];
    if (mk.rawText?.embed) for (const e of Object.values(mk.rawText.embed)) embedScopes.push(typeof e === 'string' ? e : e.default);
    if (mk.attributeEmbed) for (const a of mk.attributeEmbed) embedScopes.push(a.embed);
    if (mk.customBlockEmbed) embedScopes.push(...Object.values(mk.customBlockEmbed));
    if (mk.inject?.exprEmbed) embedScopes.push(mk.inject.exprEmbed);
    const embedsCode = embedScopes.some(s => s?.startsWith('source.'));

    // Tags that must NOT indent-on-Enter / increase indent: void elements (no children) + raw-text
    // elements whose body is a PROGRAMMING language (`source.*`, its own grammar owns indentation).
    // A raw-text block embedding MARKUP (Vue `<template>` → text.html.*) is excluded, so it indents.
    const codeRawTags = (mk.rawText?.tags ?? []).filter(t => {
      const e = mk.rawText!.embed?.[t];
      const s = typeof e === 'string' ? e : e?.default;
      return !!s?.startsWith('source.');
    });
    const voidAlt = [...new Set([...(mk.voidTags ?? []), ...codeRawTags])].map(escRe).join('|');

    // ── Brackets ── the comment pair, plus the embedded language's `{}` `()`.
    const brk: [string, string][] = [];
    if (cOpen && cClose) brk.push([cOpen, cClose]);
    if (embedsCode) brk.push(['{', '}'], ['(', ')']);
    if (brk.length) config.brackets = brk;
    config.colorizedBracketPairs = []; // markup defers bracket colorization to the editor default

    // ── Auto-closing / surrounding ── embedded brackets, the attribute quotes, the comment, and
    // (when code is embedded) the backtick string + JSDoc opener.
    const quotes = mk.attributeQuotes ?? ['"', "'"];
    const auto: AutoPair[] = [];
    if (embedsCode) auto.push({ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' });
    for (const q of quotes) auto.push({ open: q, close: q });
    if (cOpen && cClose) auto.push({ open: cOpen, close: cClose, notIn: ['comment', 'string'] });
    if (embedsCode) auto.push({ open: '`', close: '`', notIn: ['string', 'comment'] }, { open: '/**', close: ' */', notIn: ['string'] });
    config.autoClosingPairs = auto;

    const surround: [string, string][] = [...quotes.map(q => [q, q] as [string, string])];
    if (embedsCode) surround.push(['{', '}'], ['[', ']'], ['(', ')']);
    if (hasAngle) surround.push(['<', '>']);
    if (embedsCode) surround.push(['`', '`']);
    config.surroundingPairs = surround;

    // ── autoCloseBefore ── embedded-code separators / closers, the angle brackets, quotes.
    const before: string[] = [];
    if (embedsCode) before.push(';', ':', '.', ',', '=', '}', ')', ']');
    before.push('>', '<');
    if (embedsCode) before.push('`');
    before.push(...quotes);
    config.autoCloseBefore = [...new Set(before)].join('') + ' \n\t';

    // ── Folding ── region markers expressed with the block-comment delimiters.
    if (cOpen && cClose) {
      const o = escRe(cOpen), c = escRe(cClose);
      config.folding = { markers: { start: `^\\s*${o}\\s*#region\\b.*${c}`, end: `^\\s*${o}\\s*#endregion\\b.*${c}` } };
    }

    // ── Word pattern ── an embedded-code file gets the general word pattern (a tag-name pattern
    // would stop selection at the first separator and never select code identifiers); otherwise
    // leave the identifier-token pattern derived above. `-` stays a word char (kebab-case names,
    // CSS custom properties), matching the editor default for HTML.
    if (embedsCode) {
      config.wordPattern = '(-?\\d*\\.\\d\\w*)|([^\\`\\~\\!\\@\\$\\^\\&\\*\\(\\)\\=\\+\\[\\{\\]\\}\\\\\\|\\;\\:\\\'\\"\\,\\.\\<\\>\\/\\s]+)';
    }

    // ── onEnter ── indent inside an opened tag (outdent when the close tag is on the next line),
    // skipping void / code-raw elements. The attribute-skip clause is built from the quote chars.
    const qAlts = quotes.map(q => `${escRe(q)}[^${escClass(q)}]*${escRe(q)}`).join('|');
    const attrSkip = `(?:[^${escClass(quotes.join(''))}${escClass(closeMarker)}${tcCls}]|${qAlts})*?`;
    const beforeOpen = `${to}(?!(?:${voidAlt}))(${tagName})(?:${attrSkip}(?!${cm})${tc})[^${toCls}]*$`;
    const afterClose = `^${to}${cm}(${tagName})\\s*${tc}`;
    config.onEnterRules = [
      { beforeText: { pattern: beforeOpen, flags: 'i' }, afterText: { pattern: afterClose, flags: 'i' }, action: { indent: 'indentOutdent' } },
      { beforeText: { pattern: beforeOpen, flags: 'i' }, action: { indent: 'indent' } },
    ];

    // ── Indentation ── increase after a non-void / non-self-closed open tag (and an open comment /
    // brace when code is embedded); decrease on a close tag / comment-close / `}`.
    const incComment = cOpen && cClose ? `|${escRe(cOpen)}(?!.*${escRe(cClose)})` : '';
    const decComment = cClose ? `|${escRe(cClose)}` : '';
    config.indentationRules = {
      increaseIndentPattern: `${to}(?!\\?|(?:${voidAlt})\\b|[^${tcCls}]*${cm}${tc})(${nameClass}+)(?=\\s|${tc})\\b[^${tcCls}]*${tc}(?!.*${to}${cm}\\1${tc})${incComment}${embedsCode ? `|\\{[^}"']*$` : ''}`,
      decreaseIndentPattern: `^\\s*(${to}${cm}${nameClass}+\\b[^${tcCls}]*${tc}${decComment}${embedsCode ? `|\\}` : ''})`,
    };
  }

  return config;
}
