// node listspans.ts <lang> <wasm> <root> <dir>... : the real files both accept with no ERROR whose
// expression spans differ, with the class test/treesitter-verdicts.ts spanClass gives; and the files
// tree-sitter marks with an ERROR that the interpreter accepts. One line each: `<class> <file>`.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const W = process.env.W ?? '/home/linuxuser/projects/monogram/.claude/worktrees/agent-ae44134f2ffcb618c';
const [lang, wasm, root, ...dirs] = process.argv.slice(2);
const { Parser, Language } = await import(`${W}/node_modules/web-tree-sitter/web-tree-sitter.js`);
const { createParser } = await import(`${W}/src/gen-parser.ts`);
await Parser.init();
const p = new Parser(); p.setLanguage(await Language.load(wasm));
const interp = createParser((await import(`${W}/${lang}.ts`)).default);
const tsp = (src: string) => p.parse((i: number) => { let e = Math.min(src.length, i + 4096); if (e < src.length && (src.charCodeAt(e - 1) & 0xfc00) === 0xd800) e--; return src.slice(i, e); })!;
const re = lang === 'javascript' ? /\.js$/ : /\.ts$/;
const walk = (d: string, out: string[] = []): string[] => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) { const q = join(d, e.name); if (e.isDirectory()) walk(q, out); else if (re.test(e.name)) out.push(q); } return out; };
const exprSpans = (n: any, out: string[] = []): string[] => { if (n.rule === 'Expr') out.push(`${n.offset}-${n.end}`); for (const c of n.children ?? []) if (c.rule) exprSpans(c, out); return out; };
const errs = (r: any) => { let k = 0; const st = [r]; while (st.length) { const x = st.pop(); if (x.type === 'ERROR' || x.isMissing) k++; st.push(...x.children); } return k; };
for (const f of dirs.flatMap(d => walk(join(root, d)))) {
  const src = readFileSync(f, 'utf8');
  let cst: any; try { cst = interp.parse(src); } catch { continue; }
  const t = tsp(src);
  if (errs(t.rootNode) > 0) { console.log('ERROR', relative(root, f)); t.delete(); continue; }
  const want = new Set(exprSpans(cst)); const got = new Map<string, any>();
  const visit = (n: any) => { if (n.type === 'expr') got.set(`${n.startIndex}-${n.endIndex}`, n); for (const c of n.namedChildren) visit(c); };
  visit(t.rootNode);
  let first: [number, string] | null = null;
  const note = (at: number, c: string) => { if (!first || at < first[0]) first = [at, c]; };
  for (const k of want) if (!got.has(k)) note(Number(k.split('-')[0]), 'other');
  for (const [k, n] of got) {
    if (want.has(k)) continue;
    const head = n.child(0)?.type, par = n.parent;
    const atStmt = par?.type === 'stmt' && par.startIndex === n.startIndex;
    note(n.startIndex, atStmt && (head === 'function' || head === 'class' || head === 'async') ? 'declaration-as-expression-statement'
      : atStmt && head === '{' ? 'block-as-object-literal' : head === '{' && n.previousSibling?.type === '=>' ? 'arrow-body-as-object-literal' : 'other');
  }
  if (first) console.log((first as [number, string])[1], relative(root, f));
  t.delete();
}
