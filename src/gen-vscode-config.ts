import type { CstGrammar } from './types.ts';
import { collectLiterals } from './grammar-utils.ts';

// Generate a VS Code `language-configuration.json` from the grammar. This is the
// editor-behavior artifact (comments, bracket pairs, auto-close/surround, folding,
// indentation) — distinct from highlighting (gen-tm) — and is derived entirely from
// the grammar's token definitions, lexer hints, and `scopes` section.

interface AutoPair { open: string; close: string; notIn?: string[]; }
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
  onEnterRules?: { beforeText: string; afterText?: string; action: { indent: string; appendText?: string; removeText?: number } }[];
}

// ── regex-source helpers: pull literal delimiters out of a token's pattern ──

// The literal "runs" in a regex source, skipping char classes and metachars and
// unescaping `\/`,`\*`,… (but treating `\s`,`\d`,`\b`,… as run boundaries).
// e.g. `\/\*[\s\S]*?\*\/` → ['/*', '*/'];  `\/\/[^\n]*` → ['//'].
function literalRuns(src: string): string[] {
  const runs: string[] = [];
  let cur = '', inClass = false, i = 0;
  if (src[i] === '^') i++;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1] ?? ''; i++;
      if (/[a-zA-Z]/.test(n)) { if (cur) { runs.push(cur); cur = ''; } continue; } // \s \d \b … → boundary
      if (!inClass) cur += n;                                                       // \/ \* \. … → literal char
      continue;
    }
    if (c === '[') { if (cur) { runs.push(cur); cur = ''; } inClass = true; continue; }
    if (c === ']') { inClass = false; continue; }
    if (inClass) continue;
    if ('(){}.*+?|$'.includes(c)) { if (cur) { runs.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) runs.push(cur);
  return runs;
}

// Split a regex source into its TOP-LEVEL `|` alternatives (depth 0, outside
// char classes). e.g. a string token `"(?:…)*"|'(?:…)*'` → ['"(?:…)*"', "'(?:…)*'"].
function topLevelAlternatives(src: string): string[] {
  const out: string[] = [];
  let cur = '', depth = 0, inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { cur += c + (src[i + 1] ?? ''); i++; continue; }
    if (inClass) { cur += c; if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; cur += c; continue; }
    if (c === '(') { depth++; cur += c; continue; }
    if (c === ')') { depth--; cur += c; continue; }
    if (c === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Delimiter(s) of a string token: the leading literal of each top-level
// alternative (any char — `"`, `'`, `«`, `"""`, …; NOT hardcoded to JS quotes).
function stringDelimiters(src: string): string[] {
  return topLevelAlternatives(src).map(b => literalRuns(b)[0]).filter(Boolean);
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
    const src = t.pattern;
    const runs = literalRuns(src);
    if (!runs.length) continue;
    const isBlock = /\[\\s\\S\]|\[\^\]/.test(src);             // has a "match anything" body
    const isLine = /\[\^\\n\]/.test(src) || /\.[*+]/.test(src); // runs to end of line
    if (isBlock && runs.length >= 2) blockCands.push([runs[0], runs[runs.length - 1]]);
    else if (isLine) lineCands.push({ marker: runs[0], anchored: src.startsWith('^') });
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
  for (const t of grammar.tokens) if (t.string) for (const q of stringDelimiters(t.pattern)) quotes.add(q);
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
  if (ident) config.wordPattern = ident.pattern;

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

  return config;
}
