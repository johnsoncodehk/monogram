// Token-edge texts, derived from a grammar's token definitions the way grammar-gen derives inputs
// from its rules: walk a token's pattern and emit its EDGES — every alternative, every repeat at
// its bounds (min, min+1, max, max+1), every char-class range at both ends and just outside them,
// every lookahead's forbidden or required character placed where the lookahead looks — one choice
// varied at a time from a base derivation. A token that declares escape patterns (a string or a
// template: `escape`, `escapeValid`) gets those patterns' edges spliced inside its base text, and
// every text also appears with a line terminator inside it and with its last character dropped.
//
// Most of these texts are near misses, which is the point: they are where two scanners of one
// token pattern disagree (a matcher that does not backtrack where the pattern's alternation has
// to, a fast path that reads a different shape than the pattern, an escape check one engine does
// not run). The parity gates place them in a grammar-derived context (test/parity-corpus.ts).
import type { TokenDecl, TokenPattern, TokenCharClassItem } from '../src/types.ts';

type Forms = { base: string; vars: string[] };

// Characters an `anyChar` or a negated class is probed with: delimiters, escapes, line terminators.
const PROBES = ['x', '\n', '\r', '\u2028', '*', '/', '\\', '`', '"', "'", '$', '{', '}', '0', 'é'];
const LINE_TERMINATORS = ['\n', '\u2028'];
// Per-pattern cap on varied texts: the walk is linear in the pattern's choices, this only bounds
// a pathological pattern.
const MAX_VARS = 400;

const chr = (n: number) => String.fromCharCode(n);
const inItems = (items: TokenCharClassItem[], ch: string) =>
  items.some((it) => (it.type === 'char' ? it.value === ch : ch >= it.from && ch <= it.to));

function classEdges(items: TokenCharClassItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.type === 'char') out.push(it.value);
    else out.push(it.from, it.to);
  }
  return out;
}
// The characters just outside each range / char of a class that are not in the class.
function classNeighbours(items: TokenCharClassItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const lo = (it.type === 'char' ? it.value : it.from).charCodeAt(0);
    const hi = (it.type === 'char' ? it.value : it.to).charCodeAt(0);
    for (const c of [lo - 1, hi + 1]) if (c >= 0 && c <= 0xffff && !inItems(items, chr(c))) out.push(chr(c));
  }
  return out;
}
const uniq = (xs: string[]) => [...new Set(xs)];
const cap = (xs: string[]) => uniq(xs).slice(0, MAX_VARS);

// `least`: the base derivation takes every repeat at its minimum (else at least once), so the
// shortest forms of a token are varied too.
function forms(p: TokenPattern, least = false): Forms | null {
  if (typeof p === 'string') return { base: p, vars: [] };
  switch (p.type) {
    case 'never': return null;
    case 'anchor': case 'lookbehind': return { base: '', vars: [] };
    case 'anyChar': return { base: 'x', vars: PROBES.filter((c) => c !== 'x') };
    case 'charClass': {
      if (p.negate) {
        const allowed = PROBES.filter((c) => !inItems(p.items, c));
        const base = allowed.find((c) => !/[\n\r\u2028\u2029]/.test(c)) ?? allowed[0];
        if (base === undefined) return null;
        return { base, vars: uniq([...allowed, ...classEdges(p.items)]).filter((c) => c !== base) };
      }
      const edges = uniq(classEdges(p.items));
      const base = edges.find((c) => !/[\n\r\u2028\u2029]/.test(c)) ?? edges[0];
      if (base === undefined) return null;
      return { base, vars: [...edges, ...classNeighbours(p.items)].filter((c) => c !== base) };
    }
    case 'lookahead': {
      // Zero-width: the edge is the character it tests, placed where it looks.
      const f = forms(p.body, least);
      return { base: '', vars: f ? cap([f.base, ...f.vars]) : [] };
    }
    case 'seq': {
      const fs = p.items.map((it) => forms(it, least));
      if (fs.some((f) => f === null)) return null;
      const bases = fs.map((f) => f!.base);
      const base = bases.join('');
      const vars: string[] = [];
      fs.forEach((f, i) => {
        for (const v of f!.vars) vars.push(bases.slice(0, i).join('') + v + bases.slice(i + 1).join(''));
      });
      return { base, vars: cap(vars) };
    }
    case 'alt': {
      const fs = p.items.map((it) => forms(it, least)).filter((f): f is Forms => f !== null);
      if (fs.length === 0) return null;
      return { base: fs[0].base, vars: cap(fs.flatMap((f, i) => (i === 0 ? f.vars : [f.base, ...f.vars]))) };
    }
    case 'repeat': {
      const f = forms(p.body, least);
      if (f === null) return p.min === 0 ? { base: '', vars: [] } : null;
      const top = p.max !== undefined ? [p.max, p.max + 1] : [p.min + 2];
      const counts = uniq([Math.max(0, p.min - 1), p.min, p.min + 1, ...top].map(String)).map(Number);
      const n = least ? p.min : Math.max(p.min, 1);
      const base = f.base.repeat(n);
      const vars = counts.filter((c) => c !== n).map((c) => f.base.repeat(c));
      // The bounds again with the body's first other edge, so a run is not only its base text.
      if (f.vars.length > 0) for (const c of top) vars.push(f.vars[0].repeat(c));
      for (const v of f.vars) vars.push(v + f.base.repeat(Math.max(n - 1, 0)));
      return { base, vars: cap(vars) };
    }
  }
}

// The characters a pattern's trailing lookahead tests, in each alternative that ends in one.
function trailingLooks(p: TokenPattern): string[] {
  if (typeof p === 'string') return [];
  if (p.type === 'lookahead') { const f = forms(p.body); return f ? [f.base, ...f.vars] : []; }
  if (p.type === 'seq') return p.items.length ? trailingLooks(p.items[p.items.length - 1]) : [];
  if (p.type === 'alt') return p.items.flatMap(trailingLooks);
  return [];
}

/** The edge texts of one token: its pattern's edges, its escape patterns' edges inside its base
 *  text, its shortest forms followed by what a trailing lookahead tests, and line-terminator /
 *  truncation near misses of each. Deterministic. */
export function tokenEdgeTexts(decl: TokenDecl): string[] {
  const f = forms(decl.pattern);
  if (f === null) return [];
  const short = forms(decl.pattern, true);
  const texts = [f.base, ...f.vars, ...(short ? [short.base, ...short.vars] : [])];
  // A few of the characters a trailing lookahead tests, spread over them, after each shortest form.
  const looks = uniq(trailingLooks(decl.pattern));
  const probes = uniq([0, 1, 2, 3].map((k) => looks[Math.floor((k * (looks.length - 1)) / 3)]).filter((c) => c !== undefined));
  const followed = short ? probes.flatMap((look) => [short.base, ...short.vars].map((t) => t + look)) : [];
  // An escape pattern's edges spliced after the opening delimiter of the token's base text.
  for (const ep of [decl.escapeValidPattern, decl.escapePattern]) {
    const e = ep ? forms(ep) : null;
    if (!e || f.base.length < 2) continue;
    for (const esc of [e.base, ...e.vars]) texts.push(f.base.slice(0, 1) + esc + f.base.slice(1));
  }
  const out: string[] = [];
  for (const t of uniq(texts)) {
    out.push(t);
    if (t.length > 1) out.push(t.slice(0, -1));
    const mid = Math.ceil(t.length / 2);
    if (t.length >= 2) for (const lt of LINE_TERMINATORS) out.push(t.slice(0, mid) + lt + t.slice(mid));
  }
  return uniq([...out, ...followed]).filter((t) => t.length > 0);
}
