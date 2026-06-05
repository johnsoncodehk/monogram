import type { TokenCharClassItem, TokenPattern } from './types.ts';

export type TokenPatternInput = string | TokenPattern;
export type TokenPatternSource = RegExp | TokenPattern;
export type TokenCharClassInput = string | TokenPattern | TokenCharClassItem;

const mark = <T extends Omit<TokenPattern, '__kind'>>(node: T): TokenPattern => ({ __kind: 'token-pattern', ...node } as TokenPattern);

export function isTokenPattern(value: unknown): value is TokenPattern {
  return typeof value === 'object' && value !== null && (value as { __kind?: unknown }).__kind === 'token-pattern';
}

export function toTokenPattern(pattern: TokenPatternSource): TokenPattern {
  return pattern instanceof RegExp ? mark({ type: 'raw', value: pattern.source }) : pattern;
}

export function lit(value: string): TokenPattern {
  return mark({ type: 'literal', value });
}

export function named(name: string): TokenPattern {
  return mark({ type: 'named', name });
}

export function range(from: string, to: string): TokenCharClassItem {
  assertSingleChar(from, 'range lower bound');
  assertSingleChar(to, 'range upper bound');
  return { type: 'range', from, to };
}

export function oneOf(...items: TokenCharClassInput[]): TokenPattern {
  return mark({ type: 'charClass', negate: false, items: normalizeClassItems(items) });
}

export function noneOf(...items: TokenCharClassInput[]): TokenPattern {
  return mark({ type: 'charClass', negate: true, items: normalizeClassItems(items) });
}

export function seq(...items: TokenPatternInput[]): TokenPattern {
  const parts = items.map(toPatternInput);
  if (parts.length === 1) return parts[0];
  return mark({ type: 'seq', items: parts });
}

export function altPattern(...items: TokenPatternInput[]): TokenPattern {
  const parts = items.map(toPatternInput);
  if (parts.length === 1) return parts[0];
  return mark({ type: 'alt', items: parts });
}

export function optPattern(...items: TokenPatternInput[]): TokenPattern {
  return repeat(seq(...items), 0, 1);
}

export function star(body: TokenPatternInput, opts?: { greedy?: boolean }): TokenPattern {
  return repeat(body, 0, undefined, opts);
}

export function plus(body: TokenPatternInput, opts?: { greedy?: boolean }): TokenPattern {
  return repeat(body, 1, undefined, opts);
}

export function repeat(body: TokenPatternInput, min: number, max?: number, opts?: { greedy?: boolean }): TokenPattern {
  if (!Number.isInteger(min) || min < 0) throw new Error(`repeat min must be a non-negative integer, got ${min}`);
  if (max !== undefined && (!Number.isInteger(max) || max < min)) throw new Error(`repeat max must be an integer >= min, got ${max}`);
  return mark({ type: 'repeat', body: toPatternInput(body), min, max, greedy: opts?.greedy ?? true });
}

export function followedBy(body: TokenPatternInput): TokenPattern {
  return mark({ type: 'lookahead', body: toPatternInput(body), negate: false });
}

export function notFollowedBy(body: TokenPatternInput): TokenPattern {
  return mark({ type: 'lookahead', body: toPatternInput(body), negate: true });
}

export function precededBy(body: TokenPatternInput): TokenPattern {
  return mark({ type: 'lookbehind', body: toPatternInput(body), negate: false });
}

export function notPrecededBy(body: TokenPatternInput): TokenPattern {
  return mark({ type: 'lookbehind', body: toPatternInput(body), negate: true });
}

export function start(): TokenPattern {
  return mark({ type: 'anchor', kind: 'start' });
}

export function end(): TokenPattern {
  return mark({ type: 'anchor', kind: 'end' });
}

export function never(): TokenPattern {
  return mark({ type: 'never' });
}

export function tokenPatternToRegex(pattern: TokenPattern): string {
  return emit(pattern, Prec.Root);
}

const Prec = {
  Root: 0,
  Alt: 1,
  Seq: 2,
  Repeat: 3,
  Atom: 4,
} as const;
type Prec = typeof Prec[keyof typeof Prec];

const NAMED: Record<string, { atom: string; charClass?: string }> = {
  any: { atom: '[\\s\\S]' },
  digit: { atom: '[0-9]', charClass: '0-9' },
  hexDigit: { atom: '[0-9A-Fa-f]', charClass: '0-9A-Fa-f' },
  asciiLetter: { atom: '[A-Za-z]', charClass: 'A-Za-z' },
  idStart: { atom: '[a-zA-Z_$]', charClass: 'a-zA-Z_$' },
  idCont: { atom: '[a-zA-Z0-9_$]', charClass: 'a-zA-Z0-9_$' },
  whitespace: { atom: '\\s', charClass: '\\s' },
  nonWhitespace: { atom: '\\S', charClass: '\\S' },
  lineTerminator: { atom: '[\\n\\r\\u2028\\u2029]', charClass: '\\n\\r\\u2028\\u2029' },
  word: { atom: '\\w', charClass: '\\w' },
};

function emit(pattern: TokenPattern, parentPrec: Prec): string {
  switch (pattern.type) {
    case 'literal': return escapeRegexLiteral(pattern.value);
    case 'raw': return pattern.value;
    case 'named': return namedAtom(pattern.name);
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

function emitCharClass(pattern: Extract<TokenPattern, { type: 'charClass' }>): string {
  return `[${pattern.negate ? '^' : ''}${pattern.items.map(emitClassItem).join('')}]`;
}

function emitClassItem(item: TokenCharClassItem): string {
  switch (item.type) {
    case 'char': return escapeCharClassLiteral(item.value);
    case 'range': return `${escapeCharClassRangeEndpoint(item.from)}-${escapeCharClassRangeEndpoint(item.to)}`;
    case 'named': return namedClass(item.name);
  }
}

function namedAtom(name: string): string {
  const entry = NAMED[name];
  if (!entry) throw new Error(`Unknown named token pattern '${name}'`);
  return entry.atom;
}

function namedClass(name: string): string {
  const entry = NAMED[name];
  if (!entry?.charClass) throw new Error(`Named token pattern '${name}' cannot be used inside a character class`);
  return entry.charClass;
}

function toPatternInput(input: TokenPatternInput): TokenPattern {
  return typeof input === 'string' ? lit(input) : input;
}

function normalizeClassItems(items: TokenCharClassInput[]): TokenCharClassItem[] {
  return items.map(item => {
    if (typeof item === 'string') {
      assertSingleChar(item, 'character class literal');
      return { type: 'char', value: item };
    }
    if (isTokenPattern(item)) {
      if (item.type !== 'named') throw new Error(`Only named() token patterns can be embedded in oneOf()/noneOf()`);
      return { type: 'named', name: item.name };
    }
    return item;
  });
}

function assertSingleChar(value: string, label: string): void {
  if ([...value].length !== 1) throw new Error(`${label} must be exactly one character, got ${JSON.stringify(value)}`);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\f/g, '\\f').replace(/\v/g, '\\v');
}

function escapeCharClassLiteral(value: string): string {
  switch (value) {
    case '\\': return '\\\\';
    case ']': return '\\]';
    case '-': return '\\-';
    case '^': return '\\^';
    case '\n': return '\\n';
    case '\r': return '\\r';
    case '\t': return '\\t';
    case '\f': return '\\f';
    case '\v': return '\\v';
    default: return value;
  }
}

function escapeCharClassRangeEndpoint(value: string): string {
  switch (value) {
    case '\\': return '\\\\';
    case ']': return '\\]';
    case '-': return '\\-';
    case '\n': return '\\n';
    case '\r': return '\\r';
    case '\t': return '\\t';
    case '\f': return '\\f';
    case '\v': return '\\v';
    default: return value;
  }
}