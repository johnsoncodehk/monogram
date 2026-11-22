// Where a token pattern's matcher may commit, and where it has to try the rest of the pattern.
//
// A token pattern means what its regex (`tokenPatternToRegex`) means: the interpreter's lexer and
// every highlighter run that regex, and a regex alternation or repeat backs up and takes another
// choice when the rest of the pattern fails after the first one. The lex-scan family prints
// matchers without a regex engine; a matcher that commits to its first choice (the first
// alternative that matches, the most repeats) gives the regex's answer only where no other
// choice could let the rest of the pattern match. This module decides that per node, from the
// pattern alone, so the family commits exactly where committing is the regex's answer and
// carries the rest of the pattern (the continuation) into the choice everywhere else.
//
// Every judgement is sound and may be conservative: `committed` / `oneEnd` answer true only
// when proven, and a false answer costs a continuation-carrying matcher, never a wrong one.

import type { TokenCharClassItem, TokenPattern } from './types.ts';
import { oneUnit } from './text-units.ts';

// A set of characters as sorted disjoint inclusive code ranges. -1 is the end of input.
export type CSet = [number, number][];
const EOF = -1;
const TOP = 0x10ffff;
export const ALL: CSet = [[EOF, TOP]];
const NONE: CSet = [];
const CHARS: CSet = [[0, TOP]];

function norm(rs: [number, number][]): CSet {
  const s = rs.filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0]);
  const out: CSet = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
export const union = (a: CSet, b: CSet): CSet => norm([...a, ...b].map(([x, y]) => [x, y]));
export function complement(a: CSet): CSet {
  const out: [number, number][] = [];
  let lo = EOF;
  for (const [x, y] of norm(a.map(([p, q]) => [p, q]))) { if (x > lo) out.push([lo, x - 1]); lo = y + 1; }
  if (lo <= TOP) out.push([lo, TOP]);
  return out;
}
export const intersect = (a: CSet, b: CSet): CSet => complement(union(complement(a), complement(b)));
export const subset = (a: CSet, b: CSet): boolean => intersect(a, complement(b)).length === 0;
const isEmpty = (a: CSet) => a.length === 0;
const size = (a: CSet) => a.reduce((n, [x, y]) => n + (y - x + 1), 0);
const one = (c: number): CSet => [[c, c]];

function classSet(items: TokenCharClassItem[], negate: boolean): CSet {
  const pos = norm(items.map((it) => (it.type === 'char'
    ? [it.value.charCodeAt(0), it.value.charCodeAt(0)]
    : [it.from.charCodeAt(0), it.to.charCodeAt(0)])));
  return negate ? intersect(CHARS, complement(pos)) : pos;
}

type Info = {
  first: CSet;      // characters a consuming path can begin with
  nullable: boolean; // some path consumes nothing
  zfail: CSet;      // next characters (or EOF) at which every path that consumes nothing fails
  sure: CSet;       // next characters (or EOF) at which some path surely matches
  chars: CSet;      // every character any path can consume
  always: boolean;  // some path consumes nothing and nothing can make it fail
};
const memo = new WeakMap<object, Info>();
const LIT = new Map<string, Info>();

export function info(p: TokenPattern): Info {
  if (typeof p === 'string') {
    let r = LIT.get(p);
    if (!r) {
      r = p === ''
        ? { first: NONE, nullable: true, zfail: NONE, sure: ALL, chars: NONE, always: true }
        : { first: one(p.charCodeAt(0)), nullable: false, zfail: NONE, sure: p.length === 1 ? one(p.charCodeAt(0)) : NONE, chars: norm([...p].map((c) => [c.charCodeAt(0), c.charCodeAt(0)])), always: false };
      LIT.set(p, r);
    }
    return r;
  }
  const known = memo.get(p);
  if (known) return known;
  const r = compute(p);
  memo.set(p, r);
  return r;
}

function compute(p: Exclude<TokenPattern, string>): Info {
  switch (p.type) {
    case 'anyChar': return { first: CHARS, nullable: false, zfail: NONE, sure: CHARS, chars: CHARS, always: false };
    case 'charClass': { const s = classSet(p.items, p.negate); return { first: s, nullable: false, zfail: NONE, sure: s, chars: s, always: false }; }
    case 'anchor': return p.kind === 'end'
      ? { first: NONE, nullable: true, zfail: CHARS, sure: one(EOF), chars: NONE, always: false }
      : { first: NONE, nullable: true, zfail: NONE, sure: NONE, chars: NONE, always: false };
    case 'lookahead': {
      const b = info(p.body);
      return p.negate
        ? { first: NONE, nullable: true, zfail: b.sure, sure: failset(b), chars: NONE, always: false }
        : { first: NONE, nullable: true, zfail: failset(b), sure: b.sure, chars: NONE, always: false };
    }
    case 'lookbehind': case 'never': return { first: NONE, nullable: true, zfail: NONE, sure: NONE, chars: NONE, always: false };
    case 'alt': {
      const is = p.items.map(info);
      const nul = is.filter((i) => i.nullable);
      return {
        first: is.reduce((a, i) => union(a, i.first), NONE),
        nullable: nul.length > 0,
        zfail: nul.length ? nul.reduce((a, i) => intersect(a, i.zfail), ALL) : NONE,
        sure: is.reduce((a, i) => union(a, i.sure), NONE),
        chars: is.reduce((a, i) => union(a, i.chars), NONE),
        always: is.some((i) => i.always),
      };
    }
    case 'seq': return seqInfo(p.items.map(info));
    case 'repeat': {
      const b = info(p.body);
      if (p.min === 0) return { first: b.first, nullable: true, zfail: NONE, sure: ALL, chars: b.chars, always: true };
      return { first: b.first, nullable: b.nullable, zfail: b.zfail, sure: p.min === 1 && !b.nullable ? b.sure : NONE, chars: b.chars, always: b.always };
    }
  }
}

function seqInfo(is: Info[]): Info {
  let first = NONE, allNul = true, zfail = NONE;
  for (const i of is) {
    if (!allNul) break;
    first = union(first, intersect(i.first, complement(zfail)));
    zfail = union(zfail, i.zfail);
    allNul = i.nullable;
  }
  // Sure only for one item whose neighbours always match empty.
  const rest = is.filter((i) => !i.always);
  const sure = rest.length === 0 ? ALL : rest.length === 1 ? rest[0].sure : NONE;
  return { first, nullable: allNul, zfail: allNul ? zfail : NONE, sure, chars: is.reduce((a, i) => union(a, i.chars), NONE), always: is.every((i) => i.always) };
}

/** Every character (UTF-16 unit) a match attempt of p can examine and then go past: the units of
 *  its consuming atoms, lookahead bodies included. An attempt from a start position therefore
 *  reads, at the latest, up to and including the first unit outside this set: no path passes it.
 *  (A non-BMP character in a class stands for both surrogate ranges.) */
export function examinedUnits(p: TokenPattern): CSet {
  if (typeof p === 'string') return norm([...Array(p.length).keys()].map((i) => [p.charCodeAt(i), p.charCodeAt(i)]));
  switch (p.type) {
    case 'anyChar': return CHARS;
    case 'charClass': return union(classSet(p.items, p.negate), p.items.some((it) => (it.type === 'char' ? it.value : it.to).length > 1) ? [[0xd800, 0xdfff]] : NONE);
    case 'seq': case 'alt': return p.items.reduce((a, i) => union(a, examinedUnits(i)), NONE);
    case 'repeat': case 'lookahead': case 'lookbehind': return examinedUnits(p.body);
    case 'anchor': case 'never': return NONE;
  }
}

// n copies of a run of u units, where u may be Infinity: no copy reads nothing.
const times = (n: number, u: number): number => (n === 0 ? 0 : n * u);

/** The most units a match of p can consume (Infinity when unbounded). */
export function maxUnits(p: TokenPattern): number {
  if (typeof p === 'string') return p.length;
  switch (p.type) {
    case 'anyChar': case 'charClass': return 1;
    case 'seq': return p.items.reduce((a, i) => a + maxUnits(i), 0);
    case 'alt': return p.items.reduce((a, i) => Math.max(a, maxUnits(i)), 0);
    case 'repeat': { const b = maxUnits(p.body); return b === 0 ? 0 : p.max === undefined ? Infinity : times(p.max, b); }
    case 'lookahead': case 'lookbehind': case 'anchor': case 'never': return 0;
  }
}

/** The most units a FAILED match attempt of p, from its start, can read; -1 when p cannot fail.
 *  A candidate whose attempt fails after reading more than a few units was decided by text past
 *  its own start (a regex, an unterminated block comment): see `examinedUnits` for where it stops. */
export function failRead(p: TokenPattern): number {
  if (typeof p === 'string') return p.length === 0 ? -1 : p.length;
  switch (p.type) {
    case 'anyChar': case 'charClass': return 1;
    case 'anchor': return 1;
    case 'never': return 0;
    case 'lookbehind': return 0;
    case 'lookahead': return p.negate ? maxUnits(p.body) : failRead(p.body);
    case 'alt': return p.items.some((i) => failRead(i) < 0) ? -1 : p.items.reduce((a, i) => Math.max(a, failRead(i)), 0);
    case 'repeat': { const f = failRead(p.body); return p.min === 0 || f < 0 ? -1 : times(p.min - 1, maxUnits(p.body)) + f; }
    case 'seq': {
      let before = 0, most = -1;
      for (const i of p.items) {
        const f = failRead(i);
        if (f >= 0) most = Math.max(most, before + f);
        before += maxUnits(i);
      }
      return most;
    }
  }
}

/** Where a FAILED attempt of p at a position read to, as a walk: the fixed leading items of p (a
 *  literal, or a class of one-unit members), taken as the matcher takes them, so an attempt that
 *  failed among them read only up to the item that refused (as a whole literal); past them, it
 *  read at most up to and including the first unit outside `past` (the units the rest of p can
 *  examine and go past), or to the end of the source. A lexer's read-end routine is this walk
 *  (lex-family's `readEnd` prints the same one for the portable scanners). */
export type ReadEndWalk = { lead: ({ lit: string } | { cls: CSet })[]; past: CSet };
export function readEndWalk(p: TokenPattern): ReadEndWalk {
  const items = typeof p !== 'string' && p.type === 'seq' ? p.items : [p];
  const lead: ReadEndWalk['lead'] = [];
  let k = 0;
  for (; k < items.length; k++) {
    const it = items[k]!;
    if (typeof it === 'string' && it !== '') lead.push({ lit: it });
    else if (typeof it !== 'string' && it.type === 'charClass' && !it.negate && it.items.every((m) => oneUnit(m.type === 'char' ? m.value : m.to) && (m.type === 'char' || oneUnit(m.from)))) lead.push({ cls: classSet(it.items, false) });
    else break;
  }
  return { lead, past: examinedUnits({ type: 'seq', items: items.slice(k) }) };
}

/** The fewest units a match of p consumes. */
export function minUnits(p: TokenPattern): number {
  if (typeof p === 'string') return p.length;
  switch (p.type) {
    case 'anyChar': case 'charClass': return 1;
    case 'seq': return p.items.reduce((a, i) => a + minUnits(i), 0);
    case 'alt': return p.items.reduce((a, i) => Math.min(a, minUnits(i)), Infinity);
    case 'repeat': return p.min * minUnits(p.body);
    case 'lookahead': case 'lookbehind': case 'anchor': case 'never': return 0;
  }
}

/** The most units ANY match attempt of p (one that matches or one that fails), from its start,
 *  can read; Infinity when unbounded. The end anchor examines the unit after it (whether the
 *  source ends there), so it reads one. */
export function reach(p: TokenPattern): number {
  if (typeof p === 'string') return p.length;
  switch (p.type) {
    case 'anyChar': case 'charClass': return 1;
    case 'anchor': return p.kind === 'end' ? 1 : 0;
    case 'never': case 'lookbehind': return 0;
    case 'lookahead': return reach(p.body);
    case 'alt': return p.items.reduce((a, i) => Math.max(a, reach(i)), 0);
    case 'seq': {
      let before = 0, most = 0;
      for (const i of p.items) { most = Math.max(most, before + reach(i)); before += maxUnits(i); }
      return most;
    }
    case 'repeat': {
      const b = maxUnits(p.body);
      if (b === 0) return reach(p.body);
      if (p.max === undefined) return Infinity;
      return times(Math.max(0, p.max - 1), b) + reach(p.body);
    }
  }
}

/** The most units a SUCCESSFUL match of p reads at or after the end of its match (Infinity when
 *  unbounded): the tests that decided where the match ends. A repeat's last, failed attempt, an
 *  alternative tried and abandoned, a trailing lookahead, the end anchor. A lexer's relex keeps a
 *  token that ends before an edit only if the token could not have read the edited text.
 *  Where committing to the first choice is the regex's answer (`committed`), the attempts the match
 *  made are those of its own shape, bounded node by node; elsewhere the regex may back up out of
 *  any choice after reading further, and only the pattern's whole reach bounds it. */
export function overRead(p: TokenPattern): number {
  if (!commits(p, ACCEPT, true)) {
    const r = reach(p);
    return r === Infinity ? Infinity : Math.max(0, r - minUnits(p));
  }
  return Math.max(0, ovr(p, []));
}

// The units node p, followed in its match by `rest`, reads at or after the end of the whole
// match (the match is committed: every attempt is one of the shape's own). Negative: none.
function ovr(p: TokenPattern, rest: TokenPattern[]): number {
  const after = rest.reduce((a, i) => a + minUnits(i), 0);
  if (typeof p === 'string') return -after;
  switch (p.type) {
    case 'anyChar': case 'charClass': case 'never': case 'lookbehind': return -after;
    case 'anchor': return (p.kind === 'end' ? 1 : 0) - after;
    case 'lookahead': return reach(p.body) - after;
    case 'seq': return p.items.reduce((a, it, k) => Math.max(a, ovr(it, [...p.items.slice(k + 1), ...rest])), -after);
    case 'alt': {
      // The chosen item's own reads, and the attempts of the items before it, which began where
      // the alternative begins: the alternative consumed at least its fewest units past there.
      const own = p.items.reduce((a, it) => Math.max(a, ovr(it, rest)), -Infinity);
      const tried = p.items.slice(0, -1).reduce((a, it) => Math.max(a, failRead(it)), -1);
      return Math.max(own, tried < 0 ? -Infinity : tried - minUnits(p) - after);
    }
    case 'repeat': {
      // Each iteration's own reads, then the attempt that ended the repeat (none once it reached
      // its maximum, so the bound takes it as made). When the rest consumes the unit the repeat
      // stopped at and no iteration can begin with that unit, that attempt read only it.
      const own = ovr(p.body, rest);
      // Lazy: the rest was tried first at every count and failed before it matched, so each of
      // those attempts began at least one unit before where the matching rest begins.
      if (!p.greedy) return Math.max(own, failRead({ type: 'seq', items: rest }) - 1 - after);
      const f = failRead(p.body);
      if (f < 0) return own;
      const ri = info({ type: 'seq', items: rest });
      const one = rest.length > 0 && !ri.nullable && isEmpty(intersect(info(p.body).first, ri.first));
      return Math.max(own, (one ? 1 : f) - after);
    }
  }
}

/** The units at the end of a successful match of p at which it can have read more than one unit
 *  past its end (the attempt that read that far began by taking that unit): elsewhere a match
 *  reads at most the unit at its end. Every unit read past the end is then one of
 *  `examinedUnits(p)`. */
export function overTrigger(p: TokenPattern): CSet {
  if (overRead(p) <= 1) return NONE;
  if (commits(p, ACCEPT, true)) return trig(p, []);
  // The regex may back up out of any choice. An attempt that read past the end of the match took
  // the end's unit as one more unit of some path that consumed the match's text: a unit the
  // pattern's derivative by that text can begin with (`deriv` over-approximates it). Every such
  // derivative is explored, over the units the pattern tells apart; a zero-width test that reads
  // more than one unit is taken as reading anywhere.
  return derivFollow(p) ?? examinedUnits(p);
}

// The units some path of p can take right after having consumed a whole match of p: the union of
// the first units of p's derivatives by every text p matches. null when the derivatives do not
// close within a bound.
function derivFollow(p: TokenPattern): CSet | null {
  // One representative per run of units no class of p tells apart.
  const cuts = new Set<number>([0, 0x10000]);
  const walk = (q: TokenPattern): void => {
    if (typeof q === 'string') { for (const ch of q) { const c = ch.charCodeAt(0); cuts.add(c); cuts.add(c + 1); } return; }
    switch (q.type) {
      case 'charClass': for (const it of q.items) { const a = (it.type === 'char' ? it.value : it.from).charCodeAt(0), b = (it.type === 'char' ? it.value : it.to).charCodeAt(0); cuts.add(a); cuts.add(b + 1); } return;
      case 'seq': case 'alt': q.items.forEach(walk); return;
      case 'repeat': case 'lookahead': case 'lookbehind': walk(q.body); return;
      default: return;
    }
  };
  walk(p);
  let wideLook = false;
  const looks = (q: TokenPattern): void => {
    if (typeof q === 'string') return;
    if (q.type === 'lookahead' && reach(q.body) > 1) wideLook = true;
    if (q.type === 'seq' || q.type === 'alt') q.items.forEach(looks);
    if (q.type === 'repeat' || q.type === 'lookahead') looks(q.body);
  };
  looks(p);
  if (wideLook) return null;
  const reps = [...cuts].sort((a, b) => a - b).filter((c) => c < 0x10000);
  const runs: [number, number][] = reps.map((c, i) => [c, (reps[i + 1] ?? 0x10000) - 1]);
  const seen = new Map<string, TokenPattern>();
  const todo: TokenPattern[] = [];
  const add = (q: TokenPattern): void => { const n = simplify(q), k = JSON.stringify(n); if (!seen.has(k)) { seen.set(k, n); todo.push(n); } };
  // The derivatives by a non-empty text: the start pattern itself only once a unit is consumed.
  for (const [c] of runs) { const d = deriv(p, c); if (d !== null) add(d); }
  let out: CSet = NONE;
  while (todo.length) {
    if (seen.size > 400) return null;
    const q = todo.pop()!;
    const qi = info(q);
    // q accepts here: the text so far is a whole match; q's consuming starts are the follow.
    if (qi.nullable) out = union(out, qi.first);
    for (const [c] of runs) { const d = deriv(q, c); if (d !== null) add(d); }
  }
  return out;
}

// Flattens seqs and alts and drops empty literals, so equal derivatives print alike.
function simplify(p: TokenPattern): TokenPattern {
  if (typeof p === 'string') return p;
  switch (p.type) {
    case 'seq': {
      const items = p.items.map(simplify).flatMap((i) => (typeof i !== 'string' && i.type === 'seq' ? i.items : i === '' ? [] : [i]));
      return items.length === 0 ? '' : items.length === 1 ? items[0]! : { type: 'seq', items };
    }
    case 'alt': {
      const seenK = new Set<string>();
      const items = p.items.map(simplify).flatMap((i) => (typeof i !== 'string' && i.type === 'alt' ? i.items : [i])).filter((i) => { const k = JSON.stringify(i); if (seenK.has(k)) return false; seenK.add(k); return true; });
      return items.length === 1 ? items[0]! : { type: 'alt', items };
    }
    case 'repeat': return { ...p, body: simplify(p.body) };
    default: return p;
  }
}

// The units at the whole match's end at which an attempt of node p (followed by `rest`) that
// reads more than one unit past that end can begin; as `ovr`, an attempt that began before the
// end takes the end's unit as one of its own.
function trig(p: TokenPattern, rest: TokenPattern[]): CSet {
  const after = rest.reduce((a, i) => a + minUnits(i), 0);
  if (typeof p === 'string') return NONE;
  switch (p.type) {
    case 'anyChar': case 'charClass': case 'never': case 'lookbehind': case 'anchor': return NONE;
    case 'lookahead': return reach(p.body) - after > 1 ? examinedUnits(p.body) : NONE;
    case 'seq': return p.items.reduce((a, it, k) => union(a, trig(it, [...p.items.slice(k + 1), ...rest])), NONE);
    case 'alt': {
      let s = p.items.reduce((a, it) => union(a, trig(it, rest)), NONE);
      for (const it of p.items.slice(0, -1)) if (failRead(it) - minUnits(p) - after > 1) s = union(s, examinedUnits(it));
      return s;
    }
    case 'repeat': {
      const own = trig(p.body, rest);
      if (!p.greedy) return failRead({ type: 'seq', items: rest }) - 1 - after > 1 ? union(own, examinedUnits({ type: 'seq', items: rest })) : own;
      const f = failRead(p.body);
      if (f < 0) return own;
      const ri = info({ type: 'seq', items: rest });
      const one = rest.length > 0 && !ri.nullable && isEmpty(intersect(info(p.body).first, ri.first));
      if ((one ? 1 : f) - after <= 1) return own;
      // The attempt that ended the repeat began at the end itself (nothing follows) with the
      // body's first unit, or before it and took the end's unit on the way.
      return union(own, rest.every((i) => maxUnits(i) === 0) && !info(p.body).nullable ? info(p.body).first : examinedUnits(p.body));
    }
  }
}

// The next characters at which a pattern surely fails.
const failset = (i: Info): CSet => intersect(complement(i.first), i.nullable ? i.zfail : ALL);

/** What follows a node: the characters at which it surely fails, whether it always matches, and
 *  the pattern it is (null where it is not one pattern, as inside a repeat). */
export type Cont = { fail: CSet; total: boolean; rest: TokenPattern | null };
export const ACCEPT: Cont = { fail: NONE, total: true, rest: '' };
// A continuation nothing is known of: every end of a node can go on.
const ANY: Cont = { fail: NONE, total: false, rest: null };

/** The continuation `items` then `after`. */
export function contOf(items: TokenPattern[], after: Cont): Cont {
  let c = after;
  for (let k = items.length - 1; k >= 0; k--) {
    const i = info(items[k]);
    c = {
      fail: intersect(complement(i.first), i.nullable ? union(i.zfail, c.fail) : ALL),
      total: c.total && i.always,
      rest: c.rest === null ? null : c.rest === '' ? items[k] : { type: 'seq', items: [items[k], c.rest] },
    };
  }
  return c;
}

/** Whether a repeat of `body` followed by `c` can only go on from where the body stops matching:
 *  at an earlier repeat the body matched again, and there the continuation fails. */
export function exitsWhereBodyStops(body: TokenPattern, c: Cont): boolean {
  const b = info(body);
  return !b.nullable && (c.total || subset(b.first, c.fail) || (c.rest !== null && disjoint(body, c.rest)));
}
const inLoop = (body: TokenPattern, c: Cont): Cont => ({ fail: intersect(failset(info(body)), c.fail), total: c.total, rest: null });

// Where a pattern can start matching: a consuming start, or a next character an empty path allows.
const startset = (i: Info): CSet => union(i.first, i.nullable ? complement(i.zfail) : NONE);

// The rest of p after it consumed c (an over-approximation), null when p cannot consume c.
function deriv(p: TokenPattern, c: number): TokenPattern | null {
  if (typeof p === 'string') return p.length > 0 && p.charCodeAt(0) === c ? p.slice(1) : null;
  switch (p.type) {
    case 'anyChar': return c === EOF ? null : '';
    case 'charClass': return subset(one(c), classSet(p.items, p.negate)) ? '' : null;
    case 'anchor': case 'lookahead': case 'lookbehind': case 'never': return null;
    case 'alt': {
      const ds = p.items.map((it) => deriv(it, c)).filter((d): d is TokenPattern => d !== null);
      return ds.length === 0 ? null : ds.length === 1 ? ds[0] : { type: 'alt', items: ds };
    }
    case 'seq': {
      const out: TokenPattern[] = [];
      for (let k = 0; k < p.items.length; k++) {
        const head = p.items[k], rest = p.items.slice(k + 1);
        const d = deriv(head, c);
        if (d !== null) out.push({ type: 'seq', items: [d, ...rest] });
        const hi = info(head);
        if (!hi.nullable || subset(one(c), hi.zfail)) break;
      }
      return out.length === 0 ? null : out.length === 1 ? out[0] : { type: 'alt', items: out };
    }
    case 'repeat': {
      if (p.max === 0) return null;
      const d = deriv(p.body, c);
      if (d === null) return null;
      return { type: 'seq', items: [d, { ...p, min: Math.max(0, p.min - 1), max: p.max === undefined ? undefined : p.max - 1 }] };
    }
  }
}

// No position where both a and b can match. Characters both can start with are followed one
// derivative deep at a time, a few levels, while they are few.
function disjoint(a: TokenPattern, b: TokenPattern, depth = 0): boolean {
  const common = intersect(startset(info(a)), startset(info(b)));
  if (isEmpty(common)) return true;
  if (depth >= 4 || size(common) > 8 || subset(one(EOF), common)) return false;
  const ia = info(a), ib = info(b);
  for (const [lo, hi] of common) {
    for (let c = lo; c <= hi; c++) {
      // Both can match before c; one of them by matching nothing there, so both match.
      if ((ia.nullable && !subset(one(c), ia.zfail)) || (ib.nullable && !subset(one(c), ib.zfail))) return false;
      const da = deriv(a, c), db = deriv(b, c);
      if (da === null || db === null) continue;
      if (!disjoint(da, db, depth + 1)) return false;
    }
  }
  return true;
}
const pairwiseDisjoint = (items: TokenPattern[]): boolean =>
  items.every((a, i) => items.every((b, j) => j <= i || disjoint(a, b)));

/** Whether committing to p's first choices — the first matching alternative, the most repeats —
 *  then running the continuation gives the regex's answer for p followed by that continuation,
 *  and whether committing fails exactly where the regex fails. */
export function committed(p: TokenPattern, c: Cont): boolean {
  return commits(p, c, false);
}

// `committed`, and with `lazy` also a lazy repeat whose continuation is the rest of the whole
// pattern (`c.rest` is a pattern, not inside a loop): the regex tries that rest first at every
// count and, once it matches, the whole match is over, so nothing backs into the repeat. A
// matcher printed from `committed` takes the most repeats, so only the read bounds (`overRead`,
// `overTrigger`), which follow the lazy repeat as the regex runs it, ask with `lazy`.
function commits(p: TokenPattern, c: Cont, lazy: boolean): boolean {
  if (typeof p === 'string') return true;
  switch (p.type) {
    case 'anyChar': case 'charClass': case 'anchor': case 'never': case 'lookbehind': return true;
    case 'lookahead': return commits(p.body, ACCEPT, lazy);
    case 'seq': return p.items.every((it, k) => commits(it, contOf(p.items.slice(k + 1), c), lazy));
    case 'alt': return (c.total || pairwiseDisjoint(p.items)) && p.items.every((it) => commits(it, c, lazy));
    case 'repeat':
      if (!p.greedy) return lazy && c.rest !== null && commits(p.body, ANY, lazy);
      return exitsWhereBodyStops(p.body, c) && commits(p.body, inLoop(p.body, c), lazy);
  }
}

/** Whether p has at most one end from any start at which the continuation c can go on (with
 *  no continuation given: at most one end at all). */
export function oneEnd(p: TokenPattern, c: Cont = ANY): boolean {
  const i = info(p);
  // Every path consumes a run of characters the continuation refuses: only the run's end can go on.
  if (subset(i.chars, c.fail)) return true;
  if (typeof p === 'string') return true;
  switch (p.type) {
    case 'anyChar': case 'charClass': case 'anchor': case 'lookahead': case 'lookbehind': case 'never': return true;
    case 'seq': return p.items.every((it, k) => oneEnd(it, contOf(p.items.slice(k + 1), { ...c, total: false })));
    case 'alt': return pairwiseDisjoint(p.items) && p.items.every((it) => oneEnd(it, c));
    case 'repeat':
      if (p.max === p.min) return oneEnd({ type: 'seq', items: Array(p.min).fill(p.body) }, c);
      return exitsWhereBodyStops(p.body, { ...c, total: false }) && oneEnd(p.body, inLoop(p.body, c));
  }
}

/** Whether every path of p consumes exactly one unit, in every target's units. */
export function oneChar(p: TokenPattern): boolean {
  // A literal or class member beyond ASCII is more than one unit in a UTF-8 target.
  if (typeof p === 'string') return oneUnit(p);
  if (p.type === 'anyChar') return true;
  // A negated class takes one unit.
  if (p.type === 'charClass') return p.negate || p.items.every((it) => oneUnit(it.type === 'char' ? it.value : it.to));
  if (p.type === 'alt') return p.items.every(oneChar);
  if (p.type === 'seq') {
    const consuming = p.items.filter((it) => typeof it === 'string' ? it.length > 0 : !(it.type === 'lookahead' || it.type === 'anchor'));
    return consuming.length === 1 && oneChar(consuming[0]);
  }
  return false;
}

// Whether some match of p can span exactly `text` from its start. Every zero-width test (a
// lookaround or an anchor) is taken as passing and a character may be one or two units (a
// surrogate pair), so the answer is a superset of the texts p's tokens can have: false proves that
// no token of p is `text`, whatever surrounds it.
export function mayMatchText(p: TokenPattern, text: string): boolean {
  return endsOf(p, text, new Set([0])).has(text.length);
}
function endsOf(p: TokenPattern, t: string, from: Set<number>): Set<number> {
  const out = new Set<number>();
  if (typeof p === 'string') {
    for (const i of from) if (t.startsWith(p, i)) out.add(i + p.length);
    return out;
  }
  switch (p.type) {
    case 'anyChar':
      for (const i of from) { if (i < t.length) out.add(i + 1); if (i + 1 < t.length) out.add(i + 2); }
      return out;
    case 'charClass':
      for (const i of from) {
        if (i >= t.length) continue;
        const hit = (w: number) => p.items.some((it) => (it.type === 'char'
          ? t.startsWith(it.value, i) && it.value.length === w
          : w === 1 && t.charCodeAt(i) >= it.from.charCodeAt(0) && t.charCodeAt(i) <= it.to.charCodeAt(0)));
        for (const w of [1, 2]) if (i + w <= t.length && (p.negate || hit(w))) out.add(i + w);
      }
      return out;
    case 'seq': {
      let cur = from;
      for (const it of p.items) cur = endsOf(it, t, cur);
      return cur;
    }
    case 'alt':
      for (const it of p.items) for (const e of endsOf(it, t, from)) out.add(e);
      return out;
    case 'repeat': {
      // Positions after k copies, for k = 0, 1, …; a position seen before adds nothing new.
      let cur = from;
      const seen = new Set<number>();
      for (let k = 0; cur.size > 0 && (p.max === undefined || k <= p.max); k++) {
        if (k >= p.min) for (const e of cur) out.add(e);
        const fresh = new Set([...cur].filter((e) => !seen.has(e) || k < p.min));
        for (const e of cur) seen.add(e);
        if (fresh.size === 0) break;
        cur = endsOf(p.body, t, fresh);
      }
      return out;
    }
    case 'lookahead': case 'lookbehind': case 'anchor':
      return new Set(from);
    case 'never':
      return out;
  }
}
