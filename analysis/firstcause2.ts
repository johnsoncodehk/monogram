// MODE=spans|error node firstcause2.ts <lang> <wasm> <out.jsonl> <file>... (W env = worktree; default mine).
// MODE=error (default): as below. MODE=spans: both accept with no ERROR but the expression spans differ
// (test/treesitter-verdicts.ts spanClass); the witness is minimal for that, with its first difference.
// Parsing goes through pair-safe chunks (web-tree-sitter splits surrogate pairs at 5119 units).
// node firstcause.ts <lang> <wasm> <out.jsonl> <file>...: for each real file the interpreter accepts and tree-sitter
// marks with an ERROR / MISSING node, the first cause: the top-level statement holding the first error node, then
// hierarchical delta debugging inside it (delete interpreter-CST subtrees while "interpreter accepts AND tree-sitter
// errs" holds), then a token-level 1-minimal pass. One JSON line per file: { file, offset, stmtLen, witness, steps, ms }.
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const W = process.env.W ?? '/home/linuxuser/projects/monogram/.claude/worktrees/agent-ae44134f2ffcb618c';
const MODE = process.env.MODE ?? 'error';
const [lang, wasm, out, ...files] = process.argv.slice(2);
const { Parser, Language } = await import(`${W}/node_modules/web-tree-sitter/web-tree-sitter.js`);
const { createParser } = await import(`${W}/src/gen-parser.ts`);
await Parser.init();
const p = new Parser(); p.setLanguage(await Language.load(wasm));
const interp = createParser((await import(`${W}/${lang}.ts`)).default);
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).file) : []);
const accepts = (s: string) => { try { return interp.parse(s); } catch { return null; } };
const firstError = (n: any): any => {
  if (n.type === 'ERROR' || n.isMissing) return n;
  if (!n.hasError) return null;
  for (const c of n.children) { const e = firstError(c); if (e) return e; }
  return n.hasError ? n : null;
};
const tsp = (src: string) => p.parse((i: number) => { let e = Math.min(src.length, i + 4096); if (e < src.length && (src.charCodeAt(e - 1) & 0xfc00) === 0xd800) e--; return src.slice(i, e); })!;
const tsErr = (s: string) => { const t = tsp(s); const e = t.rootNode.hasError; t.delete(); return e; };
const exprSpans = (n: any, out: string[] = []): string[] => { if (n.rule === 'Expr') out.push(`${n.offset}-${n.end}`); for (const c of n.children ?? []) if (c.rule) exprSpans(c, out); return out; };
// The first difference: [offset, description] (interpreter span missing, or a tree-sitter expr extra).
function spanDiff(s: string, cst: any): [number, string] | null {
  const t = tsp(s); if (t.rootNode.hasError) { t.delete(); return null; }
  const want = new Set(exprSpans(cst)); const got = new Map<string, any>();
  const visit = (n: any) => { if (n.type === 'expr') got.set(`${n.startIndex}-${n.endIndex}`, n); for (const c of n.namedChildren) visit(c); };
  visit(t.rootNode);
  let first: [number, string] | null = null;
  const note = (at: number, d: string) => { if (!first || at < first[0]) first = [at, d]; };
  for (const k of want) if (!got.has(k)) { const [a, b] = k.split('-').map(Number); note(a, `missing interpreter Expr ${JSON.stringify(s.slice(a, b))}`); }
  for (const [k, n] of got) if (!want.has(k)) note(n.startIndex, `extra tree-sitter expr ${JSON.stringify(s.slice(n.startIndex, n.endIndex))} under ${n.parent?.type}, ${n.toString().slice(0, 160)}`);
  t.delete(); return first;
}
let steps = 0;
const test = (s: string) => { steps++; if (MODE === 'spans') { const c = accepts(s); return c !== null && spanDiff(s, c) !== null; } return tsErr(s) && accepts(s) !== null; };
// Rule nodes of the interpreter's CST, as [offset, end] ranges, children first-to-last.
const kids = (n: any) => (n.children ?? []).filter((c: any) => c.rule !== undefined || c.tokenType !== undefined);
function hdd(src: string): string {
  // comments are no CST nodes: drop them all at once where the failure survives it
  for (const re of [/\/\*[\s\S]*?\*\//g, /\/\/[^\n]*/g]) { const c = src.replace(re, ''); if (c !== src && c.trim() && test(c)) src = c; }
  // level by level: at each pass, try to delete each node (largest first) of the current CST
  for (let changed = true; changed; ) {
    changed = false;
    const cst = accepts(src);
    if (!cst) break;
    const nodes: [number, number][] = [];
    const visit = (n: any) => { for (const c of kids(n)) { if (c.end > c.offset) nodes.push([c.offset, c.end]); visit(c); } };
    visit(cst);
    nodes.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
    for (const [a, b] of nodes) {
      if (b > src.length) continue;
      const cand = src.slice(0, a) + src.slice(b);
      if (cand.trim() && test(cand)) { src = cand; changed = true; break; }
    }
  }
  return src;
}
function tokenMin(src: string): string {
  // 1-minimal over maximal runs of word chars / single other chars
  for (let changed = true; changed; ) {
    changed = false;
    const toks = src.match(/\w+|\s+|[^\w\s]/g) ?? [];
    for (let i = 0; i < toks.length; i++) {
      if (/^\s+$/.test(toks[i])) continue;
      const cand = [...toks.slice(0, i), ...toks.slice(i + 1)].join('');
      if (cand.trim() && test(cand)) { src = cand; changed = true; break; }
    }
    if (!changed) {   // shrink identifiers to one letter
      for (let i = 0; i < toks.length; i++) {
        if (!/^[A-Za-z_$]\w+$/.test(toks[i])) continue;
        const cand = [...toks.slice(0, i), toks[i][0], ...toks.slice(i + 1)].join('');
        if (test(cand)) { src = cand; changed = true; break; }
      }
    }
    if (!changed) {   // collapse whitespace runs to one space / one newline
      const ws = src.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n');
      if (ws !== src && test(ws)) { src = ws; changed = true; }
    }
  }
  return src;
}
for (const file of files) {
  if (done.has(file)) continue;
  const t0 = performance.now();
  steps = 0;
  const src = readFileSync(file, 'utf8');
  const cst = accepts(src);
  const tree = tsp(src);
  const err = MODE === 'spans' ? (cst && spanDiff(src, cst) ? { startIndex: spanDiff(src, cst)![0] } : null) : firstError(tree.rootNode);
  const rec: any = { file };
  if (!cst || !err) { rec.skip = !cst ? 'interpreter rejects' : 'no error'; tree.delete(); appendFileSync(out, JSON.stringify(rec) + '\n'); continue; }
  rec.offset = err.startIndex;
  tree.delete();
  const tops = kids(cst);
  let i = tops.findIndex((c: any) => c.offset <= rec.offset && rec.offset < c.end);
  if (i === -1) i = tops.findIndex((c: any) => c.offset >= rec.offset);
  if (i === -1) i = tops.length - 1;
  // the statement alone, else with growing windows of the statements before it
  let snippet: string | null = null;
  for (const back of [0, 1, 3, 10, tops.length]) {
    const a = tops[Math.max(0, i - back)].offset, b = tops[i].end;
    const s = src.slice(a, b);
    if (test(s)) { snippet = s; rec.context = back; break; }
  }
  if (snippet === null) { rec.skip = 'not reproduced from its statements'; appendFileSync(out, JSON.stringify(rec) + '\n'); continue; }
  rec.stmtLen = snippet.length;
  rec.witness = tokenMin(hdd(snippet));
  rec.steps = steps;
  if (MODE === 'spans') rec.diff = spanDiff(rec.witness, accepts(rec.witness))?.[1];
  rec.ms = Math.round(performance.now() - t0);
  appendFileSync(out, JSON.stringify(rec) + '\n');
  console.log(JSON.stringify(rec));
}
