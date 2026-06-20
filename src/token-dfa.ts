// ─────────────────────────────────────────────────────────────────────────────
//  token-dfa.ts — derive a char-code DFA matcher from a token's structured pattern IR
//  (src/token-pattern.ts): a scanner that dispatches on char codes instead of executing a
//  regex per token (issue #5). KEPT as the measurement behind that issue — `compileTokenDfa`
//  is exercised only by test/token-dfa-verify.ts, which found a GENERIC DFA interpreter to be
//  net-negative vs V8's JIT-compiled sticky regex on all 12 TS tokens (Ident 0.30×). The
//  emitter that would have turned the DFA into specialized straight-line JS was never wired in
//  (zero callers) and is removed; revisit from this measurement if char-code scanning is
//  pursued again.
//
//  The lexer matches one token at a time, anchored at `pos`, taking that token's
//  greedy/longest match (sticky `re.lastIndex = pos; re.exec(s)`). This compiles the
//  REGULAR subset of the IR — literal · charClass · anyChar · seq · alt · greedy
//  repeat · never, plus a single TRAILING lookahead over a char class (the `(?!…)`
//  guard the numeric tokens end with) — to an NFA (Thompson), then a DFA (subset
//  construction), and runs it over `charCodeAt` code units. `match(s, pos)` returns
//  the same match length the token's sticky regex would, or -1.
//
//  Anything outside that subset (mid-pattern look-around, lookbehind, anchors, a
//  non-greedy quantifier) → `compileTokenDfa` returns null and the caller keeps using
//  the regex. So the scanner is byte-identical by construction: a DFA where the IR is
//  regular, the proven regex elsewhere. Char classes are matched over UTF-16 code
//  units (0..0xFFFF) exactly like the non-`/u` regexes the lexer emits today.
// ─────────────────────────────────────────────────────────────────────────────

import type { TokenPattern, TokenCharClassItem } from './types.ts';

// UTF-16 code-unit alphabet. Negated classes complement within [0, MAX_CODE].
const MAX_CODE = 0xffff;

// A half-open is avoided: ranges are inclusive [lo, hi] of code units.
export interface Range { lo: number; hi: number }

// ── Char-class → sorted, merged, inclusive ranges ──
function classRanges(items: TokenCharClassItem[], negate: boolean): Range[] {
  const raw: Range[] = [];
  for (const item of items) {
    if (item.type === 'char') {
      const c = item.value.charCodeAt(0);
      raw.push({ lo: c, hi: c });
    } else {
      const a = item.from.charCodeAt(0), b = item.to.charCodeAt(0);
      raw.push({ lo: Math.min(a, b), hi: Math.max(a, b) });
    }
  }
  const merged = mergeRanges(raw);
  return negate ? complementRanges(merged) : merged;
}

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out: Range[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1], r = sorted[i];
    if (r.lo <= last.hi + 1) last.hi = Math.max(last.hi, r.hi);
    else out.push({ ...r });
  }
  return out;
}

function complementRanges(ranges: Range[]): Range[] {
  // ranges are sorted+merged; complement within [0, MAX_CODE].
  const out: Range[] = [];
  let next = 0;
  for (const r of ranges) {
    if (r.lo > next) out.push({ lo: next, hi: r.lo - 1 });
    next = r.hi + 1;
  }
  if (next <= MAX_CODE) out.push({ lo: next, hi: MAX_CODE });
  return out;
}

// ── NFA (Thompson) ──
// A transition is either an epsilon move or a move on any code unit inside `ranges`.
interface NfaState { eps: number[]; trans: { ranges: Range[]; to: number }[] }

class UnsupportedPattern extends Error {}

class Nfa {
  states: NfaState[] = [];
  newState(): number { this.states.push({ eps: [], trans: [] }); return this.states.length - 1; }
  eps(a: number, b: number): void { this.states[a].eps.push(b); }
  move(a: number, ranges: Range[], b: number): void { this.states[a].trans.push({ ranges, to: b }); }
}

// Build an NFA fragment for `pattern`; returns [start, accept]. Throws UnsupportedPattern
// for any non-regular construct so the caller can fall back to the regex.
function build(nfa: Nfa, pattern: TokenPattern): [number, number] {
  if (typeof pattern === 'string') return buildLiteral(nfa, pattern);
  switch (pattern.type) {
    case 'anyChar': {
      const s = nfa.newState(), a = nfa.newState();
      nfa.move(s, [{ lo: 0, hi: MAX_CODE }], a);
      return [s, a];
    }
    case 'charClass': {
      const ranges = classRanges(pattern.items, pattern.negate);
      const s = nfa.newState(), a = nfa.newState();
      if (ranges.length) nfa.move(s, ranges, a);   // empty class → no edge → never matches
      return [s, a];
    }
    case 'seq': {
      if (pattern.items.length === 0) { const s = nfa.newState(); return [s, s]; }
      let [start, acc] = build(nfa, pattern.items[0]);
      for (let i = 1; i < pattern.items.length; i++) {
        const [s2, a2] = build(nfa, pattern.items[i]);
        nfa.eps(acc, s2);
        acc = a2;
      }
      return [start, acc];
    }
    case 'alt': {
      const s = nfa.newState(), a = nfa.newState();
      for (const item of pattern.items) {
        const [s2, a2] = build(nfa, item);
        nfa.eps(s, s2);
        nfa.eps(a2, a);
      }
      return [s, a];
    }
    case 'repeat': {
      if (!pattern.greedy) throw new UnsupportedPattern('non-greedy repeat');
      // min mandatory copies, then either an unbounded star or (max-min) optional copies.
      const s = nfa.newState();
      let acc = s;
      for (let i = 0; i < pattern.min; i++) {
        const [s2, a2] = build(nfa, pattern.body);
        nfa.eps(acc, s2);
        acc = a2;
      }
      if (pattern.max === undefined) {
        // star: acc --eps--> bodyStart, bodyAccept --eps--> acc (loop) and onward.
        const [s2, a2] = build(nfa, pattern.body);
        const a = nfa.newState();
        nfa.eps(acc, s2);
        nfa.eps(a2, s2);   // loop
        nfa.eps(acc, a);   // skip (zero more)
        nfa.eps(a2, a);    // exit after >=1
        return [s, a];
      } else {
        const a = nfa.newState();
        let cur = acc;
        for (let i = pattern.min; i < pattern.max; i++) {
          const [s2, a2] = build(nfa, pattern.body);
          nfa.eps(cur, s2);
          nfa.eps(cur, a);   // optional: skip the rest
          cur = a2;
        }
        nfa.eps(cur, a);
        return [s, a];
      }
    }
    case 'never': {
      const s = nfa.newState(), a = nfa.newState();   // no edge s→a → never accepts
      return [s, a];
    }
    // Non-regular: the caller must fall back to the regex.
    case 'lookahead':
    case 'lookbehind':
    case 'anchor':
      throw new UnsupportedPattern(pattern.type);
  }
}

function buildLiteral(nfa: Nfa, literal: string): [number, number] {
  const start = nfa.newState();
  let cur = start;
  for (let i = 0; i < literal.length; i++) {
    const c = literal.charCodeAt(i);
    const next = nfa.newState();
    nfa.move(cur, [{ lo: c, hi: c }], next);
    cur = next;
  }
  return [start, cur];
}

// ── Subset construction → DFA ──
interface DfaState { accept: boolean; edges: { ranges: Range[]; to: number }[] }

function epsilonClosure(nfa: Nfa, set: Set<number>): Set<number> {
  const stack = [...set], out = new Set(set);
  while (stack.length) {
    const s = stack.pop()!;
    for (const t of nfa.states[s].eps) if (!out.has(t)) { out.add(t); stack.push(t); }
  }
  return out;
}

function setKey(set: Set<number>): string {
  return [...set].sort((a, b) => a - b).join(',');
}

// Partition boundaries: every code unit where some transition's membership flips. We
// build a sorted list of "cut points" so the alphabet splits into intervals on which
// every NFA transition is constant — the classic DFA alphabet partition.
function buildDfa(nfa: Nfa, start: number, accept: number): DfaState[] {
  const startSet = epsilonClosure(nfa, new Set([start]));
  const dfa: DfaState[] = [];
  const index = new Map<string, number>();
  const queue: Set<number>[] = [];

  const intern = (set: Set<number>): number => {
    const key = setKey(set);
    let id = index.get(key);
    if (id === undefined) {
      id = dfa.length;
      index.set(key, id);
      dfa.push({ accept: set.has(accept), edges: [] });
      queue.push(set);
    }
    return id;
  };

  intern(startSet);
  while (queue.length) {
    const set = queue.shift()!;
    const id = index.get(setKey(set))!;
    // Collect this state's outgoing transitions, then split into disjoint intervals.
    const trans: { ranges: Range[]; to: number }[] = [];
    for (const ns of set) for (const tr of nfa.states[ns].trans) trans.push(tr);
    if (trans.length === 0) continue;
    // Cut points: for every range [lo,hi] add boundaries at lo and hi+1.
    const cuts = new Set<number>();
    for (const tr of trans) for (const r of tr.ranges) { cuts.add(r.lo); cuts.add(r.hi + 1); }
    const points = [...cuts].sort((a, b) => a - b);
    // For each elementary interval [points[i], points[i+1]-1], gather NFA targets.
    const edges: { ranges: Range[]; to: number }[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const lo = points[i], hi = points[i + 1] - 1;
      if (hi < lo) continue;
      const targets = new Set<number>();
      for (const tr of trans) {
        for (const r of tr.ranges) if (r.lo <= lo && hi <= r.hi) { targets.add(tr.to); break; }
      }
      if (targets.size === 0) continue;
      const toId = intern(epsilonClosure(nfa, targets));
      edges.push({ ranges: [{ lo, hi }], to: toId });
    }
    // Merge adjacent intervals that go to the same DFA state (compacts the table).
    edges.sort((a, b) => a.ranges[0].lo - b.ranges[0].lo);
    const merged: { ranges: Range[]; to: number }[] = [];
    for (const e of edges) {
      const last = merged[merged.length - 1];
      if (last && last.to === e.to && last.ranges[last.ranges.length - 1].hi + 1 === e.ranges[0].lo) {
        last.ranges[last.ranges.length - 1].hi = e.ranges[0].hi;
      } else merged.push({ ranges: [{ ...e.ranges[0] }], to: e.to });
    }
    dfa[id].edges = merged;
  }
  return dfa;
}

function dfaNext(state: DfaState, code: number): number {
  for (const e of state.edges) {
    for (const r of e.ranges) {
      if (code < r.lo) break;       // ranges are sorted ascending
      if (code <= r.hi) return e.to;
    }
  }
  return -1;
}

// Run the DFA from `pos`, recording every accepting length. Returns the lengths in
// DESCENDING order (longest first) — what a greedy regex would prefer, and what the
// trailing-lookahead retry needs.
function runAcceptLengths(dfa: DfaState[], s: string, pos: number): number[] {
  const accepts: number[] = [];
  let state = 0, i = pos;
  if (dfa[0].accept) accepts.push(0);
  while (state >= 0 && i < s.length) {
    const next = dfaNext(dfa[state], s.charCodeAt(i));
    if (next < 0) break;
    state = next;
    i++;
    if (dfa[state].accept) accepts.push(i - pos);
  }
  return accepts.reverse();
}

// ── Public compile ──
export interface TokenDfa {
  /** Match length at `pos`, or -1 — byte-identical to the token's sticky regex exec. */
  match(s: string, pos: number): number;
}

// `DfaState` / `buildDfa` are consumed by `compileTokenDfa` below (the measured interpreter).

// A trailing `(?!class)` / `(?=class)` over a single char class is the only look-around
// the numeric tokens use; supported by retrying shorter body matches until the assertion
// at the body's end holds. Detected structurally on the IR.
function trailingLookahead(pattern: TokenPattern): { body: TokenPattern; ranges: Range[]; negate: boolean } | null {
  if (typeof pattern === 'string' || pattern.type !== 'seq') return null;
  const last = pattern.items[pattern.items.length - 1];
  if (typeof last === 'string' || last.type !== 'lookahead') return null;
  const inner = last.body;
  if (typeof inner === 'string' || inner.type !== 'charClass') return null;   // only a char-class assertion
  const body: TokenPattern = pattern.items.length === 2
    ? pattern.items[0]
    : { type: 'seq', items: pattern.items.slice(0, -1) };
  return { body, ranges: classRanges(inner.items, inner.negate), negate: last.negate };
}

function inRanges(ranges: Range[], code: number): boolean {
  for (const r of ranges) if (code >= r.lo && code <= r.hi) return true;
  return false;
}

/**
 * Compile a token's pattern to a char-code DFA matcher, or return null if the pattern
 * uses a construct outside the supported regular subset (caller falls back to regex).
 */
export function compileTokenDfa(pattern: TokenPattern): TokenDfa | null {
  try {
    const look = trailingLookahead(pattern);
    if (look) {
      const nfa = new Nfa();
      const [start, accept] = build(nfa, look.body);
      const dfa = buildDfa(nfa, start, accept);
      const { ranges, negate } = look;
      return {
        match(s, pos) {
          const lens = runAcceptLengths(dfa, s, pos);   // longest first
          for (const len of lens) {
            const at = pos + len;
            const has = at < s.length && inRanges(ranges, s.charCodeAt(at));
            // negative lookahead succeeds when the char is absent (incl. EOF); positive needs it present.
            if (negate ? !has : has) return len;
          }
          return -1;
        },
      };
    }
    const nfa = new Nfa();
    const [start, accept] = build(nfa, pattern);
    const dfa = buildDfa(nfa, start, accept);
    return {
      match(s, pos) {
        const lens = runAcceptLengths(dfa, s, pos);
        return lens.length ? lens[0] : -1;
      },
    };
  } catch (e) {
    if (e instanceof UnsupportedPattern) return null;
    throw e;
  }
}
