// The emitted Rust module keeps only the top-level items something reaches. The Rust printer writes
// its runtime library (helpers, tables, constants, small structs) as text, whole; which of it a
// grammar's rules use is known only once the rules are printed, so the one place that decides it is
// the printed module itself (as js-unreferenced.ts for the JavaScript-syntax targets): a top-level
// item is kept when a kept item names it, starting from every `pub` item, every `impl` / `trait` /
// `macro_rules!` block, `fn main`, `const _` and every inner attribute. What nothing reaches is not
// printed (rustc's dead_code lint would otherwise report it in the user's build).
//
// Only whole top-level items go: a method, field or macro rule nothing uses is decided where it is
// printed. The scanner knows the syntax the printer writes: line and block comments, string literals
// (with escapes; raw strings `r#"…"#`), character literals versus lifetimes, brackets. A top-level
// item ends at a `;` at depth 0, or at the `}` that closes a block-bodied item (`fn`, `impl`,
// `struct` / `enum` / `trait` / `mod` with a body, `macro_rules!`); the comment and attribute lines
// just above an item belong to it. A name counts as named by an item when it occurs there as an
// identifier that is not a field or method (`.name`); an occurrence inside a string or comment does
// not count.

interface Item { text: string; names: string[]; refs: Set<string>; root: boolean }

const isIdStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isId = (c: number): boolean => isIdStart(c) || (c >= 48 && c <= 57);
const BLOCK_ITEM = /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:fn|impl|struct|enum|trait|mod|union|macro_rules!)\b/;

function split(src: string): { text: string; refs: Set<string> }[] {
  const out: { text: string; refs: Set<string> }[] = [];
  const n = src.length;
  let start = 0, depth = 0, i = 0, head = '';
  let refs = new Set<string>();
  const end = (at: number): void => {
    // the rest of the line, when only blanks or a comment follow
    const m = /^[ \t]*(?:\/\/[^\n]*)?\n/.exec(src.slice(at));
    const to = m ? at + m[0].length : at;
    out.push({ text: src.slice(start, to), refs }); start = to; i = to; refs = new Set(); head = '';
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    const ch = src[i]!;
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? n : nl + 1; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (ch === '"') { for (i++; i < n && src[i] !== '"'; i++) if (src[i] === '\\') i++; i++; continue; }
    if (ch === '\'') {
      // a character literal ('x', '\n', '\u{..}'), else a lifetime ('a)
      if (src[i + 1] === '\\') { for (i += 2; i < n && src[i] !== '\''; i++) if (src[i] === '\\') i++; i++; continue; }
      const cp = src.codePointAt(i + 1)!, w = cp > 0xffff ? 2 : 1;
      if (src[i + 1 + w] === '\'') { i += 2 + w; continue; }
      i++; while (i < n && isId(src.charCodeAt(i))) i++; continue;
    }
    if (isIdStart(c)) {
      let j = i + 1; while (j < n && isId(src.charCodeAt(j))) j++;
      const word = src.slice(i, j);
      // a raw string r"…" / r#"…"# (and br…)
      if ((word === 'r' || word === 'br') && (src[j] === '"' || src[j] === '#')) {
        let k = j, hashes = 0; while (src[k] === '#') { hashes++; k++; }
        if (src[k] === '"') { const close = '"' + '#'.repeat(hashes); const e = src.indexOf(close, k + 1); i = e < 0 ? n : e + close.length; continue; }
      }
      if (word === 'b' && (src[j] === '"' || src[j] === '\'')) { i = j; continue; }
      let p = i - 1; while (p >= 0 && (src[p] === ' ' || src[p] === '\n')) p--;
      if (src[p] !== '.' || src[p - 1] === '.') refs.add(word);
      if (depth === 0 && head === '' && !/^(?:pub|unsafe)$/.test(word)) head = src.slice(i, i + 40);
      i = j; continue;
    }
    if (ch === '#' && depth === 0 && (src[i + 1] === '[' || src[i + 1] === '!')) {
      // an attribute: part of the item it precedes (an inner attribute `#![..]` is an item of its own)
      const inner = src[i + 1] === '!';
      let d = 0; for (; i < n; i++) { if (src[i] === '[') d++; else if (src[i] === ']' && --d === 0) { i++; break; } }
      if (inner) end(i);
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; i++; continue; }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth--; i++;
      if (depth === 0 && ch === '}' && BLOCK_ITEM.test(head) && src[i] !== ';') end(i);
      continue;
    }
    if (ch === ';' && depth === 0) { end(i + 1); continue; }
    i++;
  }
  if (start < n) out.push({ text: src.slice(start), refs });
  return out;
}

// The names an item declares, and whether it is a root (kept whatever names it).
function declared(text: string): { names: string[]; root: boolean } {
  const code = text.replace(/^(?:\s|\/\/[^\n]*\n|#\[[^\n]*\]\s*)*/, '');
  if (code === '' || /^#!/.test(code) || /^pub\b/.test(code)) return { names: [], root: true };
  const m = /^(?:unsafe\s+)?(fn|struct|enum|const|static|type|union|macro_rules!)\s*(?:mut\s+)?([A-Za-z_]\w*)/.exec(code);
  if (!m || m[2] === '_' || (m[1] === 'fn' && m[2] === 'main')) return { names: [], root: true };
  return { names: [m[2]!], root: false };
}

export function dropUnreferencedRs(src: string): string {
  const items: Item[] = split(src).map(({ text, refs }) => ({ text, refs, ...declared(text) }));
  const byName = new Map<string, Item[]>();
  for (const s of items) for (const nm of s.names) { const l = byName.get(nm); if (l) l.push(s); else byName.set(nm, [s]); }
  const kept = new Set<Item>();
  const work: Item[] = [];
  const keep = (s: Item): void => { if (!kept.has(s)) { kept.add(s); work.push(s); } };
  for (const s of items) if (s.root) keep(s);
  while (work.length > 0) {
    const s = work.pop()!;
    for (const r of s.refs) for (const d of byName.get(r) ?? []) if (d !== s) keep(d);
  }
  return items.filter((s) => kept.has(s)).map((s) => s.text).join('');
}
