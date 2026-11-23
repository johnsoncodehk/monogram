// treesitter-realcode.ts — REPORT-ONLY: the derived tree-sitter JavaScript and TypeScript grammars on
// REAL sources, against the interpreter. For every file the interpreter accepts: does tree-sitter
// report an ERROR / MISSING node; for each such file, the keyword the first ERROR node starts with (or
// holds first): the word a keyword-as-name reading would have to accept, as a histogram.
// Sources (all reachable on CI after `npm ci`): JavaScript: the npm / corepack bundled with node,
// node_modules' JavaScript (yaml, parse5, entities, acorn, typescript/lib); TypeScript:
// typescript/lib/*.d.ts, the repository's src/**/*.ts, test/*.ts and grammar files.
// Build the wasms first (as test/treesitter-jsx.ts). Run: node test/treesitter-realcode.ts
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createParser } from '../src/gen-parser.ts';
import { collectLiterals } from '../src/grammar-utils.ts';

const MAX = 3_000_000;   // bytes: the largest file read (typescript.js is ~9 MB: skipped)
const walk = (dir: string, re: RegExp, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '.git') walk(p, re, out); }
    else if (re.test(e.name) && statSync(p).size <= MAX) out.push(p);
  }
  return out;
};
const nodeLib = join(dirname(process.execPath), '..', 'lib', 'node_modules');
const SOURCES: Record<string, string[]> = {
  javascript: [
    ...walk(join(nodeLib, 'npm'), /\.js$/), ...walk(join(nodeLib, 'corepack'), /\.js$/),
    ...['yaml', 'parse5', 'entities', 'acorn'].flatMap(p => walk(`node_modules/${p}`, /\.js$/)),
    ...walk('node_modules/typescript/lib', /\.js$/),
  ],
  typescript: [
    ...walk('node_modules/typescript/lib', /\.d\.ts$/), ...walk('src', /\.ts$/), ...walk('test', /^[^.]+\.ts$/),
    ...readdirSync('.').filter(f => /^[a-z]+\.ts$/.test(f)),
  ],
};

const { Parser, Language } = await import('web-tree-sitter');
await Parser.init();
const firstError = (root: any): any => {
  const stack = [root];
  let best: any = null;
  while (stack.length) {
    const x = stack.pop();
    if (x.type === 'ERROR' || x.isMissing) { if (!best || x.startIndex < best.startIndex) best = x; continue; }
    if (x.hasError) stack.push(...x.children);
  }
  return best;
};
const lines: string[] = [];
for (const [lang, files] of Object.entries(SOURCES)) {
  const wasm = `tree-sitter/${lang}/tree-sitter-${lang}.wasm`;
  if (!existsSync(wasm)) { console.error(`✗ ${wasm} not found`); process.exitCode = 1; continue; }
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  const grammar = (await import(`../${lang}.ts`)).default;
  const interp = createParser(grammar);
  const keywords = new Set<string>();
  for (const r of grammar.rules) for (const l of collectLiterals(r.body)) if (/^[A-Za-z_$][\w$]*$/.test(l)) keywords.add(l);
  let accepted = 0, rejected = 0, tsError = 0, bytes = 0;
  const accepts = (t: string) => { try { interp.parse(t); return true; } catch { return false; } };
  const tsError1 = (t: string) => {
    const tree = parser.parse(t)!;
    const e = tree.rootNode.hasError ? firstError(tree.rootNode) : null;
    const r = e && { start: e.startIndex as number, missing: e.isMissing as boolean };
    tree.delete();
    return r;
  };
  // The interpreter's rule nodes containing an offset, outermost first.
  const chainAt = (cst: any, off: number) => {
    const out: any[] = [];
    for (let n = cst; n; n = (n.children ?? []).find((c: any) => c.rule && c.offset <= off && off < c.end)) out.push(n);
    return out;
  };
  // How a node of each rule stands alone as a program.
  const WRAP: Record<string, (t: string) => string> = {
    Stmt: t => t, Decl: t => t,
    ClassMember: t => `class C {\n${t}\n}`, TypeMember: t => `interface I {\n${t}\n}`,
    Prop: t => `x = {\n${t}\n};`, Expr: t => `(${t});`,
  };
  const word = (t: string, at: number) => t.slice(at).match(/^[A-Za-z_$][\w$]*/)?.[0];
  const byCause = new Map<string, { file: string; witness: string }[]>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    let cst: any;
    try { cst = interp.parse(src); } catch { rejected++; continue; }
    accepted++; bytes += src.length;
    const e = tsError1(src);
    if (!e) continue;
    tsError++;
    // Witness: the innermost statement / member / property / expression around the first ERROR that
    // the interpreter accepts alone (wrapped) and tree-sitter still rejects.
    let witness = '', errAt = -1;
    for (const n of chainAt(cst, Math.max(0, e.start - (e.missing ? 1 : 0))).reverse()) {
      const wrap = WRAP[n.rule];
      if (!wrap) continue;
      const w = wrap(src.slice(n.offset, n.end));
      if (w.length > 4000 || !accepts(w)) continue;
      const we = tsError1(w);
      if (!we) continue;
      witness = w; errAt = we.start;
      break;
    }
    let cause = '(no witness: context-dependent)';
    if (witness) {
      const wcst = interp.parse(witness) as any;
      const k = word(witness, errAt);
      const before = witness.slice(0, errAt).match(/\s*$/)![0];
      const where = chainAt(wcst, errAt).pop()?.rule ?? '?';
      if (k && keywords.has(k)) {
        const renamed = witness.slice(0, errAt) + 'zz9' + witness.slice(errAt + k.length);
        cause = accepts(renamed) && !tsError1(renamed) ? `keyword as a name: ${k} (${where})` : `at keyword ${k} (${where}); renaming it does not clear it`;
      } else if (before.includes('\n')) {
        const semi = witness.slice(0, errAt - before.length) + ';' + witness.slice(errAt - before.length);
        cause = accepts(semi) && !tsError1(semi) ? 'line break: a statement ends there (a `;` clears it)' : `after a line break, at ${JSON.stringify(witness.slice(errAt, errAt + 6))} (${where})`;
      } else {
        cause = `at ${JSON.stringify(witness.slice(errAt, errAt + 6))} (${where})${e.missing ? ', MISSING' : ''}`;
      }
    }
    const line = src.slice(0, e.start).split('\n').length;
    (byCause.get(cause) ?? byCause.set(cause, []).get(cause)!).push({ file: `${f}:${line}`, witness: witness || src.slice(Math.max(0, e.start - 40), e.start + 60) });
  }
  const rows = [...byCause].sort((a, b) => b[1].length - a[1].length);
  let cum = 0;
  const cell = (t: string) => t.replace(/`/g, "'").replace(/\|/g, '\\|');
  lines.push(`#### ${lang}: ${files.length} files, interpreter accepts ${accepted} (${(bytes / 1e6).toFixed(1)} MB), rejects ${rejected}; tree-sitter ERROR on ${tsError} of the accepted`, '',
    '| cause of the FIRST error | files | cumulative | shortest witness |', '|---|---:|---:|---|',
    ...rows.map(([k, xs]) => {
      cum += xs.length;
      const w = [...xs].sort((a, b) => a.witness.length - b.witness.length)[0].witness;
      return `| ${cell(k)} | ${xs.length} | ${cum} | \`${cell(JSON.stringify(w).slice(1, 161))}\` |`;
    }), '');
  for (const [k, xs] of rows) for (const x of xs) console.log(`RC ${lang} | ${k} | ${x.file} | ${JSON.stringify(x.witness).slice(0, 300)}`);
}
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### tree-sitter on real sources (report-only)\n\n${lines.join('\n')}\n`);
