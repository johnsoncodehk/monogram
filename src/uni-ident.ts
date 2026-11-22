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
 * Both classes over every code point, as a three-level table: `top[cp >> 10]` names a block,
 * `blocks[block << 4 | (cp >> 6) & 15]` a leaf, and bit `cp & 63` of `start[leaf]` /
 * `cont[leaf]` says whether cp is in the class. Equal blocks and equal leaves are stored once
 * (about 8 KB for Unicode 15). A code point at or past `top.length << 10` is in neither class.
 */
export interface UniIdentPlan {
  top: number[];
  blocks: number[];
  start: bigint[];
  cont: bigint[];
}

/** The three levels' shifts, which every printer's lookup spells out. */
export const UNI_LEAF_BITS = 6;
export const UNI_BLOCK_BITS = 4;

let plan: UniIdentPlan | undefined;

/** The plan, derived at its first call (about 0.4 s: every code point is tested once). */
export function uniIdentPlan(): UniIdentPlan {
  if (plan) return plan;
  const isStart = new RegExp(`^${UNI_ID_START}$`, 'u');
  const isCont = new RegExp(`^${UNI_ID_CONTINUE}$`, 'u');
  const leafSize = 1 << UNI_LEAF_BITS, blockSize = 1 << UNI_BLOCK_BITS;
  const start: bigint[] = [], cont: bigint[] = [];
  const leafOf = new Map<string, number>();
  const leafIds: number[] = [];
  for (let base = 0; base < 0x110000; base += leafSize) {
    let s = 0n, c = 0n;
    for (let i = 0; i < leafSize; i++) {
      const cp = base + i;
      if (cp >= 0xd800 && cp < 0xe000) continue; // a lone surrogate is no character
      const ch = String.fromCodePoint(cp);
      if (isStart.test(ch)) s |= 1n << BigInt(i);
      if (isCont.test(ch)) c |= 1n << BigInt(i);
    }
    const key = `${s},${c}`;
    let id = leafOf.get(key);
    if (id === undefined) { id = start.length; leafOf.set(key, id); start.push(s); cont.push(c); }
    leafIds.push(id);
  }
  const blocks: number[] = [];
  const blockOf = new Map<string, number>();
  const top: number[] = [];
  for (let i = 0; i < leafIds.length; i += blockSize) {
    const row = leafIds.slice(i, i + blockSize);
    const key = row.join(',');
    let id = blockOf.get(key);
    if (id === undefined) { id = blockOf.size; blockOf.set(key, id); blocks.push(...row); }
    top.push(id);
  }
  // Trailing blocks with no character in either class need no entry: past `top` is "neither".
  const empty = blockOf.get(Array(blockSize).fill(leafOf.get('0,0')).join(','));
  while (top.length > 0 && top[top.length - 1] === empty) top.pop();
  plan = { top, blocks, start, cont };
  return plan;
}
