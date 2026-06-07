import type { TokenCharClassItem, TokenDecl, TokenPattern } from './types.ts';

export function range(from: string, to: string): TokenPattern {
  return { type: 'charClass', negate: false, items: [rangeItem(from, to)] };
}

function rangeItem(from: string, to: string): TokenCharClassItem {
  assertSingleChar(from, 'range lower bound');
  assertSingleChar(to, 'range upper bound');
  return { type: 'range', from, to };
}

export function anyChar(): TokenPattern {
  return { type: 'anyChar' };
}

export function oneOf(...items: TokenPattern[]): TokenPattern {
  return { type: 'charClass', negate: false, items: normalizeClassItems(items) };
}

export function noneOf(...items: TokenPattern[]): TokenPattern {
  return { type: 'charClass', negate: true, items: normalizeClassItems(items) };
}

export function seq(...items: TokenPattern[]): TokenPattern {
  if (items.length === 1) return items[0];
  return { type: 'seq', items };
}

export function altPattern(...items: TokenPattern[]): TokenPattern {
  if (items.length === 1) return items[0];
  return { type: 'alt', items };
}

export function optPattern(...items: TokenPattern[]): TokenPattern {
  return repeat(seq(...items), 0, 1);
}

export function star(body: TokenPattern, opts?: { greedy?: boolean }): TokenPattern {
  return repeat(body, 0, undefined, opts);
}

export function plus(body: TokenPattern, opts?: { greedy?: boolean }): TokenPattern {
  return repeat(body, 1, undefined, opts);
}

export function repeat(body: TokenPattern, min: number, max?: number, opts?: { greedy?: boolean }): TokenPattern {
  if (!Number.isInteger(min) || min < 0) throw new Error(`repeat min must be a non-negative integer, got ${min}`);
  if (max !== undefined && (!Number.isInteger(max) || max < min)) throw new Error(`repeat max must be an integer >= min, got ${max}`);
  return { type: 'repeat', body, min, max, greedy: opts?.greedy ?? true };
}

export function followedBy(body: TokenPattern): TokenPattern {
  return { type: 'lookahead', body, negate: false };
}

export function notFollowedBy(body: TokenPattern): TokenPattern {
  return { type: 'lookahead', body, negate: true };
}

export function precededBy(body: TokenPattern): TokenPattern {
  return { type: 'lookbehind', body, negate: false };
}

export function notPrecededBy(body: TokenPattern): TokenPattern {
  return { type: 'lookbehind', body, negate: true };
}

export function start(): TokenPattern {
  return { type: 'anchor', kind: 'start' };
}

export function end(): TokenPattern {
  return { type: 'anchor', kind: 'end' };
}

export function never(): TokenPattern {
  return { type: 'never' };
}

export function tokenPatternToRegex(pattern: TokenPattern): string {
  return emit(pattern, Prec.Root);
}

export function tokenPatternSource(token: Pick<TokenDecl, 'pattern'>): string {
  return tokenPatternToRegex(token.pattern);
}

export function tokenBlockPatternSource(token: Pick<TokenDecl, 'blockPattern'>): string | undefined {
  return token.blockPattern ? tokenPatternToRegex(token.blockPattern) : undefined;
}

export function tokenEscapePatternSource(token: Pick<TokenDecl, 'escapePattern'>): string | undefined {
  return token.escapePattern ? tokenPatternToRegex(token.escapePattern) : undefined;
}

export function tokenEscapeValidPatternSource(token: Pick<TokenDecl, 'escapeValidPattern'>): string | undefined {
  return token.escapeValidPattern ? tokenPatternToRegex(token.escapeValidPattern) : undefined;
}

export function tokenPatternLiteralPrefixes(token: Pick<TokenDecl, 'pattern'>): string[] {
  return unique(literalPrefixInfo(token.pattern).runs.filter(Boolean));
}

export function tokenPatternLiteralPrefix(token: Pick<TokenDecl, 'pattern'>): string | undefined {
  return tokenPatternLiteralPrefixes(token)[0];
}

export function tokenPatternStringDelimiters(token: Pick<TokenDecl, 'pattern'>): string[] {
  return tokenPatternLiteralPrefixes(token);
}

export function tokenPatternLiteralText(token: Pick<TokenDecl, 'pattern'>): string | null {
  return exactLiteralText(token.pattern);
}

export function tokenPatternQuoteDelimAndEscape(token: Pick<TokenDecl, 'pattern'>): { delim: string; escape: string } | null {
  const parts = seqParts(token.pattern);
  if (parts.length !== 3) return null;
  const delim = exactLiteralText(parts[0]);
  if (!delim || [...delim].length !== 1 || exactLiteralText(parts[2]) !== delim) return null;
  const escape = quoteEscapeSource(parts[1], delim);
  return escape ? { delim, escape } : null;
}

export function tokenPatternLeadingSource(token: Pick<TokenDecl, 'pattern'>): string | null {
  const parts = seqParts(token.pattern);
  return parts[0] ? tokenPatternToRegex(parts[0]) : null;
}

export function tokenPatternPrefixBeforeTrailingLookahead(token: Pick<TokenDecl, 'pattern'>): { body: TokenPattern; lookahead: TokenPattern; bodySource: string; lookaheadSource: string } | null {
  const parts = seqParts(token.pattern);
  const last = parts[parts.length - 1];
  if (!last || typeof last === 'string' || last.type !== 'lookahead' || last.negate) return null;
  const body = patternFromParts(parts.slice(0, -1));
  return body ? { body, lookahead: last.body, bodySource: tokenPatternToRegex(body), lookaheadSource: tokenPatternToRegex(last.body) } : null;
}

export function tokenPatternIsNever(token: Pick<TokenDecl, 'pattern'>): boolean {
  return typeof token.pattern !== 'string' && token.pattern.type === 'never';
}

export function tokenPatternEqualsPattern(token: Pick<TokenDecl, 'pattern'>, pattern: TokenPattern): boolean {
  return tokenPatternEquals(token.pattern, pattern);
}

export function tokenPatternNodeContainsLiteral(pattern: TokenPattern, value: string): boolean {
  return containsLiteral(pattern, value);
}

export function tokenPatternBlockDelimiters(token: Pick<TokenDecl, 'pattern'>): [string, string] | null {
  const prefix = literalPrefixInfo(token.pattern).runs.find(Boolean);
  const suffix = literalSuffixInfo(token.pattern).runs.find(Boolean);
  if (!prefix || !suffix || prefix === suffix) return null;
  return [prefix, suffix];
}

export function tokenPatternBlockDelimiterSources(token: Pick<TokenDecl, 'pattern'>): [string, string] | null {
  const parts = seqParts(token.pattern);
  const repeatIndex = parts.findIndex(part => typeof part !== 'string' && part.type === 'repeat');
  if (repeatIndex <= 0 || repeatIndex >= parts.length - 1) return null;
  const begin = patternSourceForParts(parts.slice(0, repeatIndex));
  const end = patternSourceForParts(parts.slice(repeatIndex + 1));
  return begin && end ? [begin, end] : null;
}

export function tokenPatternHasStartAnchor(token: Pick<TokenDecl, 'pattern'>): boolean {
  return hasLeadingStartAnchor(token.pattern);
}

export function tokenPatternStartsWithDecimal(token: Pick<TokenDecl, 'pattern'>): boolean {
  return startsWithDecimal(token.pattern);
}

export function tokenPatternContainsLiteral(token: Pick<TokenDecl, 'pattern'>, value: string): boolean {
  return containsLiteral(token.pattern, value);
}

export function tokenPatternIdentifierExtraChars(token: Pick<TokenDecl, 'pattern'>): string {
  const extras = new Set<string>();
  collectIdentifierExtras(token.pattern, extras);
  return [...extras].join('');
}

export function tokenPatternTrailingCharClass(token: Pick<TokenDecl, 'pattern'>): string | null {
  const last = lastConsumed(token.pattern);
  if (!last || typeof last === 'string' || last.type !== 'repeat' || last.min !== 0 || last.max !== undefined) return null;
  return charClassChars(last.body);
}

export type TokenPatternFirstSet = { ascii: Set<number>; nonAscii: boolean };

export function tokenPatternFirstCharSet(token: Pick<TokenDecl, 'pattern'>): TokenPatternFirstSet | null {
  if (typeof token.pattern !== 'string' && token.pattern.type === 'never') return emptyFirstSet();
  if (patternCanMatchEmpty(token.pattern)) return null;
  return firstCharSetFromPattern(token.pattern);
}

export function tokenBlockPatternFirstCharSet(token: Pick<TokenDecl, 'blockPattern'>): TokenPatternFirstSet | null {
  if (!token.blockPattern) return null;
  if (typeof token.blockPattern !== 'string' && token.blockPattern.type === 'never') return emptyFirstSet();
  if (patternCanMatchEmpty(token.blockPattern)) return null;
  return firstCharSetFromPattern(token.blockPattern);
}

const Prec = {
  Root: 0,
  Alt: 1,
  Seq: 2,
  Repeat: 3,
  Atom: 4,
} as const;
type Prec = typeof Prec[keyof typeof Prec];

function emit(pattern: TokenPattern, parentPrec: Prec): string {
  if (typeof pattern === 'string') return escapeRegexLiteral(pattern);
  switch (pattern.type) {
    case 'anyChar': return '[\\s\\S]';
    case 'charClass': return emitCharClass(pattern);
    case 'seq': return wrap(pattern.items.map(item => emit(item, Prec.Seq)).join(''), Prec.Seq, parentPrec);
    case 'alt': return wrap(pattern.items.map(item => emit(item, Prec.Alt)).join('|'), Prec.Alt, parentPrec);
    case 'repeat': {
      const body = emit(pattern.body, Prec.Repeat);
      const quant = quantifier(pattern.min, pattern.max) + (pattern.greedy ? '' : '?');
      return wrap(body + quant, Prec.Repeat, parentPrec);
    }
    case 'lookahead': return `(?${pattern.negate ? '!' : '='}${emit(pattern.body, Prec.Alt)})`;
    case 'lookbehind': return `(?<${pattern.negate ? '!' : '='}${emit(pattern.body, Prec.Alt)})`;
    case 'anchor': return pattern.kind === 'start' ? '^' : '$';
    case 'never': return '(?!)';
  }
}

function wrap(source: string, prec: Prec, parentPrec: Prec): string {
  return prec < parentPrec ? `(?:${source})` : source;
}

function quantifier(min: number, max: number | undefined): string {
  if (min === 0 && max === undefined) return '*';
  if (min === 1 && max === undefined) return '+';
  if (min === 0 && max === 1) return '?';
  if (max === undefined) return `{${min},}`;
  if (min === max) return `{${min}}`;
  return `{${min},${max}}`;
}

// A char class serializes to an explicit `[…]`, never a `\w`/`\d`/`\s` shorthand: Oniguruma's
// shorthands are Unicode-aware (`\d` matches U+FF10, `\w` matches `é`/`你`), so condensing an
// enumerated ASCII set to a shorthand would silently widen the meaning the IR declares.
function emitCharClass(pattern: Extract<TokenPattern, { type: 'charClass' }>): string {
  return `[${pattern.negate ? '^' : ''}${pattern.items.map(emitClassItem).join('')}]`;
}

function emitClassItem(item: TokenCharClassItem): string {
  switch (item.type) {
    case 'char': return escapeCharClassLiteral(item.value);
    case 'range': return `${escapeCharClassRangeEndpoint(item.from)}-${escapeCharClassRangeEndpoint(item.to)}`;
  }
}

function firstCharSetFromPattern(pattern: TokenPattern): TokenPatternFirstSet | null {
  if (typeof pattern === 'string') return firstCharSetFromLiteral(pattern);
  switch (pattern.type) {
    case 'anyChar': return fullFirstSet();
    case 'charClass': return firstCharSetFromClass(pattern);
    case 'seq': return firstCharSetFromSequence(pattern.items);
    case 'alt': return firstCharSetFromAlternatives(pattern.items);
    case 'repeat': return firstCharSetFromPattern(pattern.body);
    case 'lookahead':
    case 'lookbehind':
    case 'anchor': return emptyFirstSet();
    case 'never': return emptyFirstSet();
  }
}

function firstCharSetFromSequence(items: TokenPattern[]): TokenPatternFirstSet | null {
  const out = emptyFirstSet();
  for (const item of items) {
    const itemSet = firstCharSetFromPattern(item);
    if (!itemSet) return null;
    addFirstSet(out, itemSet);
    if (!patternCanMatchEmpty(item)) return out;
  }
  return null;
}

function firstCharSetFromAlternatives(items: TokenPattern[]): TokenPatternFirstSet | null {
  const out = emptyFirstSet();
  for (const item of items) {
    if (patternCanMatchEmpty(item)) return null;
    const itemSet = firstCharSetFromPattern(item);
    if (!itemSet) return null;
    addFirstSet(out, itemSet);
  }
  return out;
}

function firstCharSetFromLiteral(value: string): TokenPatternFirstSet {
  const out = emptyFirstSet();
  if (value.length > 0) addFirstChar(out, value.charCodeAt(0));
  return out;
}

function firstCharSetFromClass(pattern: Extract<TokenPattern, { type: 'charClass' }>): TokenPatternFirstSet | null {
  if (pattern.negate) return fullFirstSet();
  const out = emptyFirstSet();
  for (const item of pattern.items) {
    const itemSet = firstCharSetFromClassItem(item);
    if (!itemSet) return null;
    addFirstSet(out, itemSet);
  }
  return out;
}

function firstCharSetFromClassItem(item: TokenCharClassItem): TokenPatternFirstSet | null {
  switch (item.type) {
    case 'char': return firstCharSetFromLiteral(item.value);
    case 'range': return firstCharSetFromRange(item.from, item.to);
  }
}

function firstCharSetFromRange(from: string, to: string): TokenPatternFirstSet {
  const out = emptyFirstSet();
  const start = from.charCodeAt(0);
  const end = to.charCodeAt(0);
  if (Number.isNaN(start) || Number.isNaN(end)) return out;
  for (let code = Math.min(start, end); code <= Math.max(start, end); code++) addFirstChar(out, code);
  return out;
}

function patternCanMatchEmpty(pattern: TokenPattern): boolean {
  if (typeof pattern === 'string') return pattern.length === 0;
  switch (pattern.type) {
    case 'seq': return pattern.items.every(patternCanMatchEmpty);
    case 'alt': return pattern.items.some(patternCanMatchEmpty);
    case 'repeat': return pattern.min === 0 || patternCanMatchEmpty(pattern.body);
    case 'lookahead':
    case 'lookbehind':
    case 'anchor': return true;
    case 'anyChar':
    case 'charClass':
    case 'never': return false;
  }
}

function emptyFirstSet(): TokenPatternFirstSet {
  return { ascii: new Set<number>(), nonAscii: false };
}

function fullFirstSet(): TokenPatternFirstSet {
  const out = emptyFirstSet();
  for (let code = 0; code <= 127; code++) out.ascii.add(code);
  out.nonAscii = true;
  return out;
}

function addFirstSet(target: TokenPatternFirstSet, source: TokenPatternFirstSet): void {
  for (const code of source.ascii) target.ascii.add(code);
  target.nonAscii ||= source.nonAscii;
}

function addFirstChar(target: TokenPatternFirstSet, code: number): void {
  if (code <= 127) target.ascii.add(code);
  else target.nonAscii = true;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function exactLiteralText(pattern: TokenPattern): string | null {
  if (typeof pattern === 'string') return pattern;
  switch (pattern.type) {
    case 'seq': {
      let text = '';
      for (const item of pattern.items) {
        const part = exactLiteralText(item);
        if (part === null) return null;
        text += part;
      }
      return text;
    }
    default: return null;
  }
}

// A bare-string literal is a leaf; only an object `seq` node has sub-parts.
function seqParts(pattern: TokenPattern): TokenPattern[] {
  return typeof pattern !== 'string' && pattern.type === 'seq' ? pattern.items : [pattern];
}

function quoteEscapeSource(body: TokenPattern, delim: string): string | null {
  const inner = typeof body !== 'string' && body.type === 'repeat' ? body.body : body;
  const alternatives = typeof inner !== 'string' && inner.type === 'alt' ? inner.items : [inner];
  for (const alt of alternatives) {
    const literal = exactLiteralText(alt);
    if (literal === delim + delim) return tokenPatternToRegex(alt);
    const parts = seqParts(alt);
    if (exactLiteralText(parts[0]) === '\\') return tokenPatternToRegex(alt);
  }
  return null;
}

function isZeroWidth(pattern: TokenPattern): boolean {
  return typeof pattern !== 'string' && (pattern.type === 'lookahead' || pattern.type === 'lookbehind' || pattern.type === 'anchor');
}

function literalPrefixInfo(pattern: TokenPattern): { runs: string[]; complete: boolean } {
  if (typeof pattern === 'string') return { runs: [pattern], complete: true };
  switch (pattern.type) {
    case 'seq': {
      let runs = [''];
      for (const item of pattern.items) {
        if (isZeroWidth(item)) continue;
        const info = literalPrefixInfo(item);
        runs = combineRuns(runs, info.runs);
        if (!info.complete) return { runs, complete: false };
      }
      return { runs, complete: true };
    }
    case 'alt': {
      const infos = pattern.items.map(literalPrefixInfo);
      return { runs: unique(infos.flatMap(info => info.runs)), complete: infos.every(info => info.complete) };
    }
    case 'repeat': {
      if (pattern.min === 0) return { runs: [''], complete: false };
      const info = literalPrefixInfo(pattern.body);
      return { runs: info.runs, complete: false };
    }
    case 'lookahead':
    case 'lookbehind':
    case 'anchor':
      return { runs: [''], complete: true };
    case 'anyChar':
    case 'charClass':
    case 'never':
      return { runs: [''], complete: false };
  }
}

function literalSuffixInfo(pattern: TokenPattern): { runs: string[]; complete: boolean } {
  if (typeof pattern === 'string') return { runs: [pattern], complete: true };
  switch (pattern.type) {
    case 'seq': {
      let runs = [''];
      for (let i = pattern.items.length - 1; i >= 0; i--) {
        const item = pattern.items[i];
        if (isZeroWidth(item)) continue;
        const info = literalSuffixInfo(item);
        runs = combineRuns(info.runs, runs);
        if (!info.complete) return { runs, complete: false };
      }
      return { runs, complete: true };
    }
    case 'alt': {
      const infos = pattern.items.map(literalSuffixInfo);
      return { runs: unique(infos.flatMap(info => info.runs)), complete: infos.every(info => info.complete) };
    }
    case 'repeat': {
      if (pattern.min === 0) return { runs: [''], complete: false };
      const info = literalSuffixInfo(pattern.body);
      return { runs: info.runs, complete: false };
    }
    case 'lookahead':
    case 'lookbehind':
    case 'anchor':
      return { runs: [''], complete: true };
    case 'anyChar':
    case 'charClass':
    case 'never':
      return { runs: [''], complete: false };
  }
}

function combineRuns(left: string[], right: string[]): string[] {
  return unique(left.flatMap(a => right.map(b => a + b)));
}

function hasLeadingStartAnchor(pattern: TokenPattern): boolean {
  if (typeof pattern === 'string') return false;
  switch (pattern.type) {
    case 'anchor': return pattern.kind === 'start';
    case 'seq': return pattern.items.some(item => isZeroWidth(item) ? hasLeadingStartAnchor(item) : false);
    case 'alt': return pattern.items.some(hasLeadingStartAnchor);
    default: return false;
  }
}

function startsWithDecimal(pattern: TokenPattern): boolean {
  if (typeof pattern === 'string') return pattern.length > 0 && isAsciiDigit(pattern[0]);
  switch (pattern.type) {
    case 'seq': {
      const first = pattern.items.find(item => !isZeroWidth(item));
      return first ? startsWithDecimal(first) : false;
    }
    case 'alt': return pattern.items.some(startsWithDecimal);
    case 'repeat': return pattern.min > 0 && startsWithDecimal(pattern.body);
    case 'charClass': return charClassHasDigit(pattern);
    case 'anyChar': return false;
    default: return false;
  }
}

function charClassHasDigit(pattern: Extract<TokenPattern, { type: 'charClass' }>): boolean {
  if (pattern.negate) return false;
  return pattern.items.some(item => {
    if (item.type === 'char') return isAsciiDigit(item.value);
    if (item.type === 'range') return rangeOverlapsAsciiDigit(item.from, item.to);
    return false;
  });
}

function isAsciiDigit(value: string): boolean {
  return value >= '0' && value <= '9';
}

function rangeOverlapsAsciiDigit(from: string, to: string): boolean {
  const start = from.charCodeAt(0);
  const end = to.charCodeAt(0);
  return Math.min(start, end) <= 57 && Math.max(start, end) >= 48;
}

function containsLiteral(pattern: TokenPattern, value: string): boolean {
  if (typeof pattern === 'string') return pattern.includes(value);
  switch (pattern.type) {
    case 'seq':
    case 'alt': return pattern.items.some(item => containsLiteral(item, value));
    case 'repeat':
    case 'lookahead':
    case 'lookbehind': return containsLiteral(pattern.body, value);
    default: return false;
  }
}

function collectIdentifierExtras(pattern: TokenPattern, extras: Set<string>): void {
  if (typeof pattern === 'string') return;
  switch (pattern.type) {
    case 'charClass':
      if (pattern.negate) return;
      for (const item of pattern.items) collectClassItemExtras(item, extras);
      return;
    case 'seq':
    case 'alt':
      for (const item of pattern.items) collectIdentifierExtras(item, extras);
      return;
    case 'repeat':
    case 'lookahead':
    case 'lookbehind':
      collectIdentifierExtras(pattern.body, extras);
      return;
  }
}

function collectClassItemExtras(item: TokenCharClassItem, extras: Set<string>): void {
  if (item.type === 'char') {
    if (!/[a-zA-Z0-9_]/.test(item.value)) extras.add(item.value);
    return;
  }
}

function lastConsumed(pattern: TokenPattern): TokenPattern | null {
  if (typeof pattern === 'string') return pattern;
  switch (pattern.type) {
    case 'seq': {
      for (let i = pattern.items.length - 1; i >= 0; i--) {
        const item = pattern.items[i];
        if (isZeroWidth(item)) continue;
        return lastConsumed(item) ?? item;
      }
      return null;
    }
    case 'alt': return null;
    default: return isZeroWidth(pattern) ? null : pattern;
  }
}

function charClassChars(pattern: TokenPattern): string | null {
  if (typeof pattern === 'string' || pattern.type !== 'charClass' || pattern.negate) return null;
  let out = '';
  for (const item of pattern.items) {
    if (item.type !== 'char') return null;
    out += item.value;
  }
  return out;
}

function patternSourceForParts(parts: TokenPattern[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return tokenPatternToRegex(parts[0]);
  return tokenPatternToRegex({ type: 'seq', items: parts });
}

function patternFromParts(parts: TokenPattern[]): TokenPattern | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return { type: 'seq', items: parts };
}

function tokenPatternEquals(a: TokenPattern, b: TokenPattern): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'anyChar': return true;
    case 'charClass': {
      const other = b as typeof a;
      return a.negate === other.negate && a.items.length === other.items.length && a.items.every((item, i) => charClassItemEquals(item, other.items[i]));
    }
    case 'seq': {
      const other = b as typeof a;
      return a.items.length === other.items.length && a.items.every((item, i) => tokenPatternEquals(item, other.items[i]));
    }
    case 'alt': {
      const other = b as typeof a;
      return a.items.length === other.items.length && a.items.every((item, i) => tokenPatternEquals(item, other.items[i]));
    }
    case 'repeat': {
      const other = b as typeof a;
      return a.min === other.min && a.max === other.max && a.greedy === other.greedy && tokenPatternEquals(a.body, other.body);
    }
    case 'lookahead': {
      const other = b as typeof a;
      return a.negate === other.negate && tokenPatternEquals(a.body, other.body);
    }
    case 'lookbehind': {
      const other = b as typeof a;
      return a.negate === other.negate && tokenPatternEquals(a.body, other.body);
    }
    case 'anchor': return a.kind === (b as typeof a).kind;
    case 'never': return true;
  }
}

function charClassItemEquals(a: TokenCharClassItem, b: TokenCharClassItem): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'char': return a.value === (b as typeof a).value;
    case 'range': {
      const other = b as typeof a;
      return a.from === other.from && a.to === other.to;
    }
  }
}

function normalizeClassItems(items: TokenPattern[]): TokenCharClassItem[] {
  const out: TokenCharClassItem[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      assertSingleChar(item, 'character class literal');
      out.push({ type: 'char', value: item });
      continue;
    }
    if (item.type !== 'charClass' || item.negate) throw new Error('oneOf()/noneOf() inputs must be single-char strings or non-negated character-class patterns');
    out.push(...item.items);
  }
  return out;
}

function assertSingleChar(value: string, label: string): void {
  if ([...value].length !== 1) throw new Error(`${label} must be exactly one character, got ${JSON.stringify(value)}`);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\f/g, '\\f').replace(/\v/g, '\\v').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function escapeCharClassLiteral(value: string): string {
  switch (value) {
    case '\\': return '\\\\';
    case '[': return '\\[';
    case ']': return '\\]';
    case '-': return '\\-';
    case '^': return '\\^';
    case '\n': return '\\n';
    case '\r': return '\\r';
    case '\t': return '\\t';
    case '\f': return '\\f';
    case '\v': return '\\v';
    case '\u2028': return '\\u2028';
    case '\u2029': return '\\u2029';
    default: return value;
  }
}

function escapeCharClassRangeEndpoint(value: string): string {
  switch (value) {
    case '\\': return '\\\\';
    case '[': return '\\[';
    case ']': return '\\]';
    case '-': return '\\-';
    case '\n': return '\\n';
    case '\r': return '\\r';
    case '\t': return '\\t';
    case '\f': return '\\f';
    case '\v': return '\\v';
    case '\u2028': return '\\u2028';
    case '\u2029': return '\\u2029';
    default: return value;
  }
}