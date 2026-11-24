// node official.ts <lang> <ours.wasm> <theirs.wasm> <root> <out.json> <dir>...
// Over the real files the interpreter accepts: ERROR files and expression-span-equal files for our
// generated grammar (nodes `expr`, as test/treesitter-verdicts.ts) and for an official grammar (nodes
// whose type is a subtype of its `expression` / `primary_expression` supertypes, plus
// sequence_expression; an identifier that is a binding name, a label, a parameter or a property key
// is no expression). Both parsed through pair-safe chunks. Writes totals and up to 40 sample first
// differences per side.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const W = process.env.W ?? '/home/linuxuser/projects/monogram/.claude/worktrees/agent-ae44134f2ffcb618c';
const [lang, oursW, theirsW, root, out, ...dirs] = process.argv.slice(2);
const { Parser, Language } = await import(`${W}/node_modules/web-tree-sitter/web-tree-sitter.js`);
const { createParser } = await import(`${W}/src/gen-parser.ts`);
await Parser.init();
const mk = async (w: string) => { const p = new Parser(); const L = await Language.load(w); p.setLanguage(L); return { p, L }; };
const ours = await mk(oursW), theirs = await mk(theirsW);
const interp = createParser((await import(`${W}/${lang}.ts`)).default);
const tsp = (p: any, src: string) => p.parse((i: number) => { let e = Math.min(src.length, i + 4096); if (e < src.length && (src.charCodeAt(e - 1) & 0xfc00) === 0xd800) e--; return src.slice(i, e); })!;
const L = theirs.L;
const exprTypes = new Set<string>(['sequence_expression']);
for (const s of L.supertypes ?? []) {
  const name = L.nodeTypeForId(s);
  if (name !== 'expression' && name !== 'primary_expression') continue;
  for (const t of L.subtypes(s) ?? []) { const n = L.nodeTypeForId(t); if (n) exprTypes.add(n); }
}
exprTypes.delete('primary_expression');
// An official wasm without supertype tables (tree-sitter-typescript in @vscode/tree-sitter-wasm): the
// JavaScript wasm's expression types (EXPR_FROM) and TypeScript's own expression nodes.
if (exprTypes.size === 1 && process.env.EXPR_FROM) {
  const J = await Language.load(process.env.EXPR_FROM);
  for (const s of J.supertypes) { const nm = J.nodeTypeForId(s); if (nm === 'expression' || nm === 'primary_expression') for (const t of J.subtypes(s)) { const n = J.nodeTypeForId(t); if (n && n !== 'primary_expression') exprTypes.add(n); } }
  for (const n of ['as_expression', 'satisfies_expression', 'non_null_expression', 'type_assertion', 'instantiation_expression']) exprTypes.add(n);
}
const NOT_EXPR_FIELDS = new Set(['name', 'label', 'parameter', 'key', 'property', 'alias']);
const re = lang === 'javascript' ? /\.js$/ : /\.ts$/;
const walk = (d: string, o: string[] = []): string[] => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) { const q = join(d, e.name); if (e.isDirectory()) walk(q, o); else if (re.test(e.name)) o.push(q); } return o; };
const exprSpans = (n: any, o: string[] = []): string[] => { if (n.rule === 'Expr') o.push(`${n.offset}-${n.end}`); for (const c of n.children ?? []) if (c.rule) exprSpans(c, o); return o; };
const errs = (r: any) => { let k = 0; const st = [r]; while (st.length) { const x = st.pop(); if (x.type === 'ERROR' || x.isMissing) k++; st.push(...x.children); } return k; };
const oursExpr = (n: any) => n.type === 'expr';
const theirsExpr = (n: any) => {
  if (!exprTypes.has(n.type)) return false;
  const par = n.parent; if (!par) return false;
  for (let i = 0; i < par.childCount; i++) if (par.child(i)?.id === n.id) { const f = par.fieldNameForChild(i); return !(f && NOT_EXPR_FIELDS.has(f)); }
  return true;
};
const firstDiff = (src: string, want: Set<string>, root: any, isExpr: (n: any) => boolean): string | null => {
  const got = new Map<string, any>();
  const visit = (n: any) => { if (isExpr(n)) got.set(`${n.startIndex}-${n.endIndex}`, n); for (const c of n.namedChildren) visit(c); };
  visit(root);
  let first: [number, string] | null = null;
  const note = (at: number, d: string) => { if (!first || at < first[0]) first = [at, d]; };
  for (const k of want) if (!got.has(k)) { const [a, b] = k.split('-').map(Number); note(a, `missing ${JSON.stringify(src.slice(a, Math.min(b, a + 60)))}`); }
  for (const [k, n] of got) if (!want.has(k)) note(n.startIndex, `extra ${n.type} ${JSON.stringify(src.slice(n.startIndex, Math.min(n.endIndex, n.startIndex + 60)))} under ${n.parent?.type}`);
  return first ? (first as [number, string])[1] : null;
};
const R = { files: 0, interpAccepts: 0, ours: { error: 0, spanEqual: 0, compared: 0 }, theirs: { error: 0, spanEqual: 0, compared: 0 }, exprTypes: [...exprTypes].sort(), samples: { ours: [] as string[], theirs: [] as string[] } };
for (const f of dirs.flatMap(d => walk(join(root, d)))) {
  R.files++;
  const src = readFileSync(f, 'utf8');
  let cst: any; try { cst = interp.parse(src); } catch { continue; }
  R.interpAccepts++;
  const want = new Set(exprSpans(cst));
  for (const [side, x, isExpr] of [['ours', ours, oursExpr], ['theirs', theirs, theirsExpr]] as const) {
    const t = tsp(x.p, src);
    const r = R[side];
    if (errs(t.rootNode) > 0) r.error++;
    else {
      r.compared++;
      const d = firstDiff(src, want, t.rootNode, isExpr);
      if (!d) r.spanEqual++;
      else if (R.samples[side].length < 40) R.samples[side].push(`${relative(root, f)}: ${d}`);
    }
    t.delete();
  }
}
writeFileSync(out, JSON.stringify(R, null, 1));
console.log(JSON.stringify({ files: R.files, interpAccepts: R.interpAccepts, ours: R.ours, theirs: R.theirs }));
