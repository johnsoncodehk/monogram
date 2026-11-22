// The Unicode identifier characters of a grammar's `identifier` / `identifierPrefix` tokens.
//
// A token pattern is ASCII (no /u flag, see javascript.ts), so the engine extends an identifier
// token with the characters below: a run starting at a non-ASCII ID_Start character is an
// identifier, and an ID_Continue run extends an identifier the ASCII pattern cut short
// (caf|é → café). The two classes are defined once, here, as RegExp sources: the interpreter's
// lexer (emit-lexer.ts) and the TS target compile them; Go and Rust print `uniIdentPlan()`,
// a table derived from the same classes by Node's own Unicode property support at generation
// time, so no character data is kept by hand and every target follows the interpreter's Unicode.

/** IdentifierStart's characters: ECMAScript's `$`, `_` and ID_Start. */
export const UNI_ID_START = '[$_\\p{ID_Start}]';
/** IdentifierPart's characters: ECMAScript's `$`, ZWNJ, ZWJ and ID_Continue (which holds `_`). */
export const UNI_ID_CONTINUE = '[$\\u200c\\u200d\\p{ID_Continue}]';

/**
 * Both classes over every code point as ONE three-valued class (IdentifierStart is a subset of
 * IdentifierPart): 0 neither, 1 IdentifierPart only, 2 both. Stored as a trie whose levels are
 * read in place from one string of 6-bit symbols (symbol v is the byte `UNI_SYM0 + v`), so a
 * target prints a string literal, not a list of numbers, and decodes nothing before a lookup.
 *
 * Lookup of cp: `i = entry(levels[0], cp >> levels[0].shift)` (cp past `topLen` entries is in
 * neither class); then for each further level `i = entry(level, i << level.fanBits |
 * (cp >> level.shift) & (2^fanBits - 1))`, where an entry is `width` symbols, most significant
 * first, at `level.at + j * width`. The last level's entry is a leaf of `2^leafBits` code points,
 * two to a symbol: class = `sym(leafAt + i * 2^(leafBits-1) + (cp & mask) >> 1) >> (cp & 1) * 2 & 3`.
 * Equal nodes of every level are stored once.
 */
export interface UniIdentPlan {
  data: string;
  topLen: number;
  levels: { at: number; width: 1 | 2; shift: number; fanBits: number }[];
  leafAt: number;
  leafBits: number;
}

/** The first symbol byte: symbols are `0`..`o`, so the only byte a string literal escapes is `\`. */
export const UNI_SYM0 = 0x30;
/** The levels' shifts, top first; the last is the leaf's (4 code points). The smallest of the
 *  measured shapes (uniz.ts in the lexer lane's scratch: 6.4 KB against 7.2 KB for 11,7,4). */
const SHIFTS = [11, 8, 5, 2];

let plan: UniIdentPlan | undefined;

/** The plan, derived at its first call (about 0.4 s: every code point is tested once). */
export function uniIdentPlan(): UniIdentPlan {
  if (plan) return plan;
  const isStart = new RegExp(`^${UNI_ID_START}$`, 'u');
  const isCont = new RegExp(`^${UNI_ID_CONTINUE}$`, 'u');
  const leafBits = SHIFTS[SHIFTS.length - 1]!;
  const leafSize = 1 << leafBits;
  // Leaves: the classes of 2^leafBits code points, two to a symbol.
  const leafSyms: number[] = [];
  const leafOf = new Map<string, number>();
  let ids: number[] = [];
  const cls = new Uint8Array(0x110000);
  for (let base = 0; base < 0x110000; base += leafSize) {
    const syms: number[] = [];
    for (let i = 0; i < leafSize; i += 2) {
      let v = 0;
      for (let k = 0; k < 2; k++) {
        const cp = base + i + k;
        if (cp >= 0xd800 && cp < 0xe000) continue; // a lone surrogate is no character
        const ch = String.fromCodePoint(cp);
        const c = (cls[cp] = isStart.test(ch) ? 2 : isCont.test(ch) ? 1 : 0);
        v |= c << (k * 2);
      }
      syms.push(v);
    }
    const key = syms.join(',');
    let id = leafOf.get(key);
    if (id === undefined) { id = leafOf.size; leafOf.set(key, id); leafSyms.push(...syms); }
    ids.push(id);
  }
  // Levels, leaf-most first: each groups 2^fanBits ids of the level below into a node.
  const nodes: { syms: number[]; width: 1 | 2; shift: number; fanBits: number }[] = [];
  let count = leafOf.size;
  for (let l = SHIFTS.length - 2; l >= 0; l--) {
    const fanBits = SHIFTS[l]! - SHIFTS[l + 1]!, fan = 1 << fanBits;
    const width = entryWidth(count);
    // 0x110000 is a multiple of every node's span (17 << 16), so every node is full.
    const nodeOf = new Map<string, number>();
    const syms: number[] = [], next: number[] = [];
    for (let j = 0; j < ids.length; j += fan) {
      const row = ids.slice(j, j + fan), key = row.join(',');
      let id = nodeOf.get(key);
      if (id === undefined) { id = nodeOf.size; nodeOf.set(key, id); for (const x of row) syms.push(...entry(x, width)); }
      next.push(id);
    }
    nodes.unshift({ syms, width, shift: SHIFTS[l + 1]!, fanBits });
    count = nodeOf.size; ids = next;
  }
  // Trailing top entries need none when they hold no character (checked below): past `topLen`
  // is "neither".
  const emptyTop = ids[ids.length - 1]!;
  while (ids.length > 0 && ids[ids.length - 1] === emptyTop) ids.pop();
  const topWidth = entryWidth(count);
  const top = ids.flatMap((x) => entry(x, topWidth));
  const all = [top, ...nodes.map((n) => n.syms), leafSyms];
  const ats: number[] = [];
  let at = 0;
  for (const part of all) { ats.push(at); at += part.length; }
  const data = String.fromCharCode(...all.flat().map((v) => UNI_SYM0 + v));
  plan = {
    data,
    topLen: ids.length,
    levels: [{ at: 0, width: topWidth, shift: SHIFTS[0]!, fanBits: 0 }, ...nodes.map((n, k) => ({ at: ats[k + 1]!, width: n.width, shift: n.shift, fanBits: n.fanBits }))],
    leafAt: ats[ats.length - 1]!,
    leafBits,
  };
  // The lookup the printers spell must give every code point its class.
  for (let cp = 0; cp < 0x110000; cp++) if (uniClassOf(plan, cp) !== cls[cp]) throw new Error(`uni-ident: the table misclassifies U+${cp.toString(16)}`);
  return plan;
}

const entryWidth = (count: number): 1 | 2 => {
  if (count > 1 << 12) throw new Error(`uni-ident: ${count} nodes need more than two symbols`);
  return count > 1 << 6 ? 2 : 1;
};
const entry = (x: number, width: 1 | 2) => (width === 1 ? [x] : [x >> 6, x & 63]);

/** The classes of cp by the plan, as the printers' lookups compute them (the plan's self-test). */
export function uniClassOf(p: UniIdentPlan, cp: number): number {
  const sym = (k: number) => p.data.charCodeAt(k) - UNI_SYM0;
  const ent = (l: UniIdentPlan['levels'][number], j: number) =>
    l.width === 1 ? sym(l.at + j) : (sym(l.at + j * 2) << 6) | sym(l.at + j * 2 + 1);
  const t = cp >> p.levels[0]!.shift;
  if (t >= p.topLen) return 0;
  let i = ent(p.levels[0]!, t);
  for (const l of p.levels.slice(1)) i = ent(l, (i << l.fanBits) | ((cp >> l.shift) & ((1 << l.fanBits) - 1)));
  const v = sym(p.leafAt + i * (1 << (p.leafBits - 1)) + ((cp & ((1 << p.leafBits) - 1)) >> 1));
  return (v >> ((cp & 1) * 2)) & 3;
}

/**
 * `uniClassOf`'s lookup as target-neutral expressions over the unsigned 32-bit variables `cp` and
 * `i`, every operator parenthesised (Go's precedence of `<<` / `&` / `|` is not C's): a printer
 * returns 0 when `top >= topLen`, then assigns each of `steps` to `i` in order and returns
 * `result`. `sym(k)` spells the symbol at index expression k as an unsigned 32-bit value.
 */
export function uniLookup(p: UniIdentPlan, sym: (k: string) => string): { top: string; steps: string[]; result: string } {
  const ent = (l: UniIdentPlan['levels'][number], j: string) =>
    l.width === 1 ? sym(`(${l.at} + ${j})`) : `((${sym(`(${l.at} + (${j} << 1))`)} << 6) | ${sym(`(${l.at} + (${j} << 1) + 1)`)})`;
  const top = `(cp >> ${p.levels[0]!.shift})`;
  const steps = [ent(p.levels[0]!, top), ...p.levels.slice(1).map((l) => ent(l, `((i << ${l.fanBits}) | ((cp >> ${l.shift}) & ${(1 << l.fanBits) - 1}))`))];
  const v = sym(`(${p.leafAt} + (i << ${p.leafBits - 1}) + ((cp & ${(1 << p.leafBits) - 1}) >> 1))`);
  return { top, steps, result: `((${v} >> ((cp & 1) << 1)) & 3)` };
}
