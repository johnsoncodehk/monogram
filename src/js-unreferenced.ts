// The emitted JavaScript / TypeScript module keeps only the top-level declarations something
// reaches. A printer writes its runtime library (helpers, tables, constants) as text, whole; which
// of it a grammar's rules call is known only once the rules are printed, so the one place that
// decides it is the printed module itself: a top-level declaration is kept when a kept statement
// names it, starting from every statement that is not a declaration and every `export`. What
// nothing reaches is not printed (tsc's noUnusedLocals would otherwise report it in the user's
// build). Used by both JavaScript-syntax targets (target-ts.ts, target-js.ts).
//
// The scanner knows the syntax the printers write: comments, strings, template literals (with
// `${}` holes), regular-expression literals (a `/` where an operand starts), brackets. A top-level
// statement ends at a `;` at depth 0 (with the rest of its line when that is only a comment), at
// the closing brace of a block-bodied declaration, or before a line that begins with a
// declaration keyword at depth 0; the comment lines just above a statement belong to it. A name
// counts as named by a statement when it occurs there as an identifier that is not a property
// (`.name`); an occurrence inside a string or comment does not count. A statement that declares
// more than one name is kept when any of them is reached.

interface Stmt { text: string; names: string[]; refs: Set<string>; root: boolean }

const isIdStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
const isId = (c: number): boolean => isIdStart(c) || (c >= 48 && c <= 57);
// After one of these a `/` begins a regular expression, not a division.
const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);
const stripLead = (t: string): string => t.replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
const DECL_HEAD = /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|type|interface|class|enum)\b/;
const BLOCK_DECL = /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|enum)\b/;

function split(src: string): { text: string; refs: Set<string> }[] {
  const out: { text: string; refs: Set<string> }[] = [];
  const n = src.length;
  let start = 0, depth = 0, i = 0;
  let refs = new Set<string>();
  let lastSig = '';            // the last significant token: a punctuator, a word, or 'a' for an operand
  let sawCode = false;         // the current statement has code (not only comments and blanks)
  const holes: number[] = [];  // for each open template-literal hole, the depth it opened at
  const end = (at: number): void => { out.push({ text: src.slice(start, at), refs }); start = at; i = at; refs = new Set(); sawCode = false; lastSig = ''; };
  const endLine = (): void => { const nl = src.indexOf('\n', i); end(nl < 0 ? n : nl + 1); };
  const template = (): void => {   // i is just after a backquote or a hole's closing brace
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 92) { i += 2; continue; }
      if (c === 96) { i++; lastSig = 'a'; return; }
      if (c === 36 && src.charCodeAt(i + 1) === 123) { i += 2; holes.push(depth); depth++; lastSig = '{'; return; }
      i++;
    }
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 10) {
      i++;
      if (depth === 0 && sawCode && DECL_HEAD.test(src.slice(i, i + 40))) end(i);
      continue;
    }
    if (c === 32 || c === 9 || c === 13) { i++; continue; }
    if (c === 47 && src.charCodeAt(i + 1) === 47) { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === 47 && src.charCodeAt(i + 1) === 42) { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    sawCode = true;
    if (c === 39 || c === 34) {
      i++;
      while (i < n) { const d = src.charCodeAt(i); if (d === 92) { i += 2; continue; } i++; if (d === c) break; }
      lastSig = 'a'; continue;
    }
    if (c === 96) { i++; template(); continue; }
    if (c === 47 && (lastSig === '' || REGEX_AFTER.has(lastSig) || REGEX_AFTER_WORD.has(lastSig))) {
      i++;
      let cls = false;
      while (i < n) { const d = src.charCodeAt(i); if (d === 92) { i += 2; continue; } i++; if (d === 91) cls = true; else if (d === 93) cls = false; else if (d === 47 && !cls) break; }
      while (i < n && isId(src.charCodeAt(i))) i++;
      lastSig = 'a'; continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isId(src.charCodeAt(j))) j++;
      const w = src.slice(i, j);
      let k = i - 1;
      while (k >= 0 && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 10 || src.charCodeAt(k) === 9)) k--;
      if (!(src.charCodeAt(k) === 46 && src.charCodeAt(k - 1) !== 46)) refs.add(w);   // `.name` is a property; `...name` is not
      lastSig = w; i = j; continue;
    }
    if (c >= 48 && c <= 57) { while (i < n && (isId(src.charCodeAt(i)) || src.charCodeAt(i) === 46)) i++; lastSig = 'a'; continue; }
    i++;
    if (c === 123 || c === 40 || c === 91) { depth++; lastSig = String.fromCharCode(c); continue; }
    if (c === 125 || c === 41 || c === 93) {
      depth--;
      lastSig = String.fromCharCode(c);
      if (c === 125 && holes.length > 0 && holes[holes.length - 1] === depth) { holes.pop(); template(); continue; }
      if (c === 125 && depth === 0 && BLOCK_DECL.test(stripLead(src.slice(start, i)))) {
        // A block-bodied declaration ends at its closing brace, unless what follows on the line
        // continues it (an object return type: `): { a: T } {`, `} | null {`).
        const next = /^[ \t]*([^ \t])/.exec(src.slice(i, i + 80))?.[1];
        if (next === undefined || next === '\n' || next === '/' || !/[{|&,;.)\]?:=<>]/.test(next)) { endLine(); continue; }
      }
      continue;
    }
    if (c === 59 && depth === 0) {
      const nl = src.indexOf('\n', i);
      if (/^\s*(?:\/\/.*)?$/.test(src.slice(i, nl < 0 ? n : nl))) endLine(); else end(i);
      continue;
    }
    lastSig = String.fromCharCode(c);
  }
  if (start < n) end(n);
  return out;
}

// The names a statement declares, and whether it is a root (not a declaration, or exported).
function declared(text: string): { names: string[]; root: boolean } {
  const body = stripLead(text);
  if (/^(?:export|declare)\b/.test(body)) return { names: [], root: true };
  const m = /^(?:async\s+)?function\*?\s*([A-Za-z_$][\w$]*)/.exec(body) ?? /^(?:type|interface|class|enum|const\s+enum)\s+([A-Za-z_$][\w$]*)/.exec(body);
  if (m) return { names: [m[1]!], root: false };
  const v = /^(?:const|let|var)\s+/.exec(body);
  if (!v) return { names: [], root: true };
  const rest = body.slice(v[0].length);
  const first = /^[A-Za-z_$][\w$]*/.exec(rest)?.[0];
  if (first === undefined) return { names: [], root: true };   // a destructuring pattern
  // `let a = 0, b = 1;`: the names after a comma at depth 0 (strings skipped; a comma inside a
  // type argument, `Record<number, number>`, is followed by a type, not by `name =`).
  const names = [first];
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (c === '\'' || c === '"' || c === '`') { for (i++; i < rest.length && rest[i] !== c; i++) if (rest[i] === '\\') i++; }
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) break;
    else if (c === ',' && depth === 0) { const w = /^\s*([A-Za-z_$][\w$]*)\s*[=:,;]/.exec(rest.slice(i + 1)); if (w) names.push(w[1]!); }
  }
  return { names, root: false };
}

export function dropUnreferenced(src: string): string {
  const stmts: Stmt[] = split(src).map(({ text, refs }) => ({ text, refs, ...declared(text) }));
  const byName = new Map<string, Stmt[]>();
  for (const s of stmts) for (const nm of s.names) { const l = byName.get(nm); if (l) l.push(s); else byName.set(nm, [s]); }
  const kept = new Set<Stmt>();
  const work: Stmt[] = [];
  const keep = (s: Stmt): void => { if (!kept.has(s)) { kept.add(s); work.push(s); } };
  for (const s of stmts) if (s.root) keep(s);
  while (work.length > 0) {
    const s = work.pop()!;
    for (const r of s.refs) for (const d of byName.get(r) ?? []) if (d !== s) keep(d);
  }
  // A kept top-level variable that is only ever assigned is not read either: its declaration and
  // its assignments go (an assignment that is a statement of its own, of a value without a call;
  // where any occurrence is anything else, the variable stays).
  const live = stmts.filter((s) => kept.has(s));
  for (const s of live) {
    if (s.names.length !== 1 || !/^(?:let|var) [\w$]+(?:: [\w$<>[\] |]+)? = [\w$.'"-]*;\s*$/.test(stripLead(s.text))) continue;
    const nm = s.names[0]!.replace(/\$/g, '\\$');
    const any = new RegExp(`(?<![\\w$.])${nm}(?![\\w$])`, 'g');
    const write = new RegExp(`(^|[;{}]|\\n)([ \\t]*)${nm} = [\\w$.\\[\\] +\\-]*;`, 'g');
    const users = live.filter((o) => o !== s && o.refs.has(s.names[0]!));
    if (users.every((o) => (o.text.match(any) ?? []).length === (o.text.match(write) ?? []).length)) {
      s.text = '';
      for (const o of users) o.text = o.text.replace(write, '$1');
    }
  }
  return live.map((s) => s.text).join('');
}
