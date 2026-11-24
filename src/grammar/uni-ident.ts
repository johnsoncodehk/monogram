// The Unicode identifier characters of a grammar's `identifier` / `identifierPrefix` tokens.
//
// A token pattern is ASCII (no /u flag, see javascript.ts), so the engine extends an identifier
// token with the characters below: a run starting at a non-ASCII ID_Start character is an
// identifier, and an ID_Continue run extends an identifier the ASCII pattern cut short
// (caf|é → café). The two classes are defined once, here, as RegExp sources: the interpreter's
// lexer (lexer.ts) and the TS target compile them; Go and Rust print `uniIdentPlan()`,
// a table derived from the same classes by Node's own Unicode property support at generation
// time, so no character data is kept by hand and every target follows the interpreter's Unicode.
// A grammar may declare other classes on its identifier token (`identifierClasses`, e.g. Python's
// XID_Start / XID_Continue); every consumer takes them from identifierClassesOf.
import type { IdentifierClasses, TokenDecl } from './types.ts';

/** IdentifierStart's characters: ECMAScript's `$`, `_` and ID_Start. */
export const UNI_ID_START = '[$_\\p{ID_Start}]';
/** IdentifierPart's characters: ECMAScript's `$`, ZWNJ, ZWJ and ID_Continue (which holds `_`). */
export const UNI_ID_CONTINUE = '[$\\u200c\\u200d\\p{ID_Continue}]';

/** The classes a grammar gets when its identifier token declares none: ECMAScript's. */
export const ECMASCRIPT_IDENTIFIER: IdentifierClasses = { start: UNI_ID_START, continue: UNI_ID_CONTINUE };

/**
 * A grammar's identifier classes: the ones its identifier token declares (`identifierClasses`), or
 * ECMAScript's. A prefixed-identifier token (`identifierPrefix`) names the same IdentifierName
 * behind its prefix, so it declares none of its own: one that does is refused.
 */
export function identifierClassesOf(tokens: readonly TokenDecl[]): IdentifierClasses {
  const ident = tokens.find((t) => t.identifier);
  for (const t of tokens) {
    if (t.identifierClasses && !t.identifier) throw new Error(`token ${t.name}: identifierClasses belongs on the identifier token (a prefixed identifier takes the identifier's classes)`);
  }
  return ident?.identifierClasses ?? ECMASCRIPT_IDENTIFIER;
}

/**
 * Both classes over every code point as ONE three-valued class (IdentifierStart is a subset of
 * IdentifierPart): 0 neither, 1 IdentifierPart only, 2 both. Stored as a trie whose levels are
 * read in place from one string of 6-bit symbols (symbol v is the byte `UNI_SYM0 + v`), so a
 * target prints a string literal, not a list of numbers, and decodes nothing before a lookup.
 *
 * Every level names its children by id, and ids 0, 1 and 2 are the nodes whose code points all
 * have that class (stored nowhere): a lookup ends at the first such id, so a code point in a
 * uniform block (most of CJK, for one) costs one level. Another id k names the stored node k - 3
 * of the next level. Lookup of cp: `i = entry(levels[0], cp >> levels[0].shift)` (cp past
 * `topLen` entries is in neither class); then, while i > 2, for each further level
 * `i = entry(level, (i - 3) << level.fanBits | (cp >> level.shift) & (2^fanBits - 1))`, where an
 * entry is `width` symbols, most significant first, at `level.at + j * width`. Past the last
 * level, i - 3 is a leaf of `2^leafBits` code points, two to a symbol (two bits each). Equal nodes
 * of every level are stored once. Ahead of the trie, the first `flatLen` code points (ASCII and
 * Latin-1, which end or continue most non-ASCII identifier runs) are stored flat, two to a symbol
 * from `flatAt`: one read each.
 */
export interface UniIdentPlan {
  data: string;
  topLen: number;
  levels: { at: number; width: 1 | 2; shift: number; fanBits: number }[];
  leafAt: number;
  leafBits: number;
  flatAt: number;
  flatLen: number;
}

/** The first symbol byte: symbols are `0`..`o`, so the only byte a string literal escapes is `\`. */
export const UNI_SYM0 = 0x30;
/** The levels' shifts, top first; the last is the leaf's (4 code points). The smallest of the
 *  measured shapes (uniz.ts in the lexer lane's scratch: 6.4 KB against 7.2 KB for 11,7,4). */
const SHIFTS = [11, 8, 5, 2];
/** Ids below this are uniform nodes (their class); see UniIdentPlan. */
const UNIFORM = 3;
/** The code points stored flat ahead of the trie. */
const FLAT = 256;

const plans = new Map<string, UniIdentPlan>();

/** The plan of the classes `c`, derived at its first call for them (about 1 s: every code point is
 *  tested, then looked up). */
export function uniIdentPlan(c: IdentifierClasses = ECMASCRIPT_IDENTIFIER): UniIdentPlan {
  const key = `${c.start}\u0000${c.continue}`;
  const known = plans.get(key);
  if (known) return known;
  const isStart = new RegExp(`^${c.start}$`, 'u');
  const isCont = new RegExp(`^${c.continue}$`, 'u');
  const cls = new Uint8Array(0x110000);
  for (let cp = 0; cp < 0x110000; cp++) {
    if (cp >= 0xd800 && cp < 0xe000) continue; // a lone surrogate is no character
    const ch = String.fromCodePoint(cp);
    cls[cp] = isStart.test(ch) ? 2 : isCont.test(ch) ? 1 : 0;
  }
  const leafBits = SHIFTS[SHIFTS.length - 1]!;
  const leafSize = 1 << leafBits;
  // Leaves: the classes of 2^leafBits code points, two to a symbol; a uniform one is its class.
  const leafSyms: number[] = [];
  const leafOf = new Map<string, number>();
  let ids: number[] = [];
  for (let base = 0; base < 0x110000; base += leafSize) {
    const row = cls.subarray(base, base + leafSize);
    if (row.every((c) => c === row[0])) { ids.push(row[0]!); continue; }
    const syms: number[] = [];
    for (let i = 0; i < leafSize; i += 2) syms.push(row[i]! | (row[i + 1]! << 2));
    const key = syms.join(',');
    let id = leafOf.get(key);
    if (id === undefined) { id = UNIFORM + leafOf.size; leafOf.set(key, id); leafSyms.push(...syms); }
    ids.push(id);
  }
  // Levels, leaf-most first: each groups 2^fanBits ids of the level below into a node; a node of
  // one uniform id is that id.
  const nodes: { syms: number[]; width: 1 | 2; shift: number; fanBits: number }[] = [];
  let count = UNIFORM + leafOf.size;
  for (let l = SHIFTS.length - 2; l >= 0; l--) {
    const fanBits = SHIFTS[l]! - SHIFTS[l + 1]!, fan = 1 << fanBits;
    const width = entryWidth(count);
    // 0x110000 is a multiple of every node's span (17 << 16), so every node is full.
    const nodeOf = new Map<string, number>();
    const syms: number[] = [], next: number[] = [];
    for (let j = 0; j < ids.length; j += fan) {
      const row = ids.slice(j, j + fan);
      if (row[0]! < UNIFORM && row.every((x) => x === row[0])) { next.push(row[0]!); continue; }
      const key = row.join(',');
      let id = nodeOf.get(key);
      if (id === undefined) { id = UNIFORM + nodeOf.size; nodeOf.set(key, id); for (const x of row) syms.push(...entry(x, width)); }
      next.push(id);
    }
    nodes.unshift({ syms, width, shift: SHIFTS[l + 1]!, fanBits });
    count = UNIFORM + nodeOf.size; ids = next;
  }
  // Trailing top entries of no character need none: past `topLen` is "neither".
  while (ids.length > 0 && ids[ids.length - 1] === 0) ids.pop();
  const topWidth = entryWidth(count);
  const top = ids.flatMap((x) => entry(x, topWidth));
  const flat: number[] = [];
  for (let cp = 0; cp < FLAT; cp += 2) flat.push(cls[cp]! | (cls[cp + 1]! << 2));
  const all = [top, ...nodes.map((n) => n.syms), leafSyms, flat];
  const ats: number[] = [];
  let at = 0;
  for (const part of all) { ats.push(at); at += part.length; }
  const data = String.fromCharCode(...all.flat().map((v) => UNI_SYM0 + v));
  const plan: UniIdentPlan = {
    data,
    topLen: ids.length,
    levels: [{ at: 0, width: topWidth, shift: SHIFTS[0]!, fanBits: 0 }, ...nodes.map((n, k) => ({ at: ats[k + 1]!, width: n.width, shift: n.shift, fanBits: n.fanBits }))],
    leafAt: ats[ats.length - 2]!,
    leafBits,
    flatAt: ats[ats.length - 1]!,
    flatLen: FLAT,
  };
  // The lookup the printers spell, run here over the same string, must give every code point its class.
  const l = uniLookup(plan, (k) => `D.charCodeAt(${k})`);
  const classOf = new Function('D', `return (cp) => { let i; if (cp < ${plan.flatLen}) return ${l.flat}; if (${l.top} >= ${plan.topLen}) return 0; ${l.steps.map((e) => `i = ${e}; if (i < ${l.uniform}) return i;`).join(' ')} return ${l.result}; }`)(data) as (cp: number) => number;
  for (let cp = 0; cp < 0x110000; cp++) if (classOf(cp) !== cls[cp]) throw new Error(`uni-ident: the table misclassifies U+${cp.toString(16)}`);
  plans.set(key, plan);
  return plan;
}

/**
 * The code points of one class (`c.start` or `c.continue`, a RegExp source) as sorted inclusive
 * ranges, derived by Node's Unicode like uniIdentPlan: for a target whose regular expressions take
 * ranges but whose Unicode tables are its own (tree-sitter's), so it follows the interpreter's
 * Unicode, not another version. `from` drops the code points below it (0x80: beyond ASCII).
 */
export function uniClassRanges(cls: string, from = 0): [number, number][] {
  const re = new RegExp(`^${cls}$`, 'u');
  const out: [number, number][] = [];
  let lo = -1;
  for (let cp = from; cp <= 0x110000; cp++) {
    const ok = cp < 0x110000 && !(cp >= 0xd800 && cp < 0xe000) && re.test(String.fromCodePoint(cp));
    if (ok && lo < 0) lo = cp;
    else if (!ok && lo >= 0) { out.push([lo, cp - 1]); lo = -1; }
  }
  return out;
}

const entryWidth = (count: number): 1 | 2 => {
  if (count > 1 << 12) throw new Error(`uni-ident: ${count} ids need more than two symbols`);
  return count > 1 << 6 ? 2 : 1;
};
const entry = (x: number, width: 1 | 2) => (width === 1 ? [x] : [x >> 6, x & 63]);

/**
 * The lookup of a code point's class (UniIdentPlan) as target-neutral expressions over the
 * unsigned 32-bit variables `cp` and `i`, every operator parenthesised (Go's precedence of `<<` /
 * `&` / `|` is not C's): a printer returns `flat` when `cp < flatLen`, 0 when `top >= topLen`, then assigns each of `steps` to
 * `i` in order, returning i as soon as it is below `uniform`, and returns `result` after the last.
 * `byte(k)` spells the data string's byte at index expression k as an unsigned 32-bit value.
 * Constants are folded into one term per index (an index sum is written with `+`, its constant
 * last, and stays non-negative: i >= uniform there), and a leaf symbol's four low bits are its
 * value (UNI_SYM0 is a multiple of 16), so a leaf needs no subtraction.
 */
export function uniLookup(p: UniIdentPlan, byte: (k: string) => string): { flat: string; top: string; steps: string[]; result: string; uniform: number } {
  if (UNI_SYM0 % 16 !== 0) throw new Error('uni-ident: a leaf symbol must keep its value in its low four bits');
  const term = (k: number) => (k === 0 ? '' : k > 0 ? ` + ${k}` : ` - ${-k}`);
  // The entry at (j << fanBits) + x of a level whose j is an id (i), or at j for the top.
  const ent = (l: UniIdentPlan['levels'][number], j: string, base: number) =>
    l.width === 1 ? `(${byte(`(${j}${term(l.at - base)})`)} - ${UNI_SYM0})`
      : `(((${byte(`((${j} << 1)${term(l.at - 2 * base)})`)} << 6) + ${byte(`((${j} << 1)${term(l.at + 1 - 2 * base)})`)}) - ${UNI_SYM0 * 65})`;
  const top = `(cp >> ${p.levels[0]!.shift})`;
  const steps = [ent(p.levels[0]!, top, 0), ...p.levels.slice(1).map((l) =>
    ent(l, `((i << ${l.fanBits}) + ((cp >> ${l.shift}) & ${(1 << l.fanBits) - 1}))`, UNIFORM << l.fanBits))];
  const half = p.leafBits - 1;
  const pair = (k: string) => `((${byte(k)} >> ((cp & 1) << 1)) & 3)`;
  return { flat: pair(`((cp >> 1) + ${p.flatAt})`), top, steps, result: pair(`((i << ${half}) + ((cp & ${(1 << p.leafBits) - 1}) >> 1)${term(p.leafAt - (UNIFORM << half))})`), uniform: UNIFORM };
}
