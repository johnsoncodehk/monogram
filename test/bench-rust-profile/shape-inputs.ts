// The profile's `shape` row (run.sh, phase shape): node shape-inputs.ts <tree> <out dir> <input>...
// Writes <out dir>/shape.rs: the typed Rust shape-building parser (src/targets/rust-shape.ts) of the tsc
// expression shape's synthesized subset (test/fixtures/shape-tsc-synthesized.ts) from <tree>; and
// for each input <dir>/<name>.<ext> the COVERED part <dir>/<name>.cov.<ext>: every outermost
// expression statement (Stmt.expr) whose value the shape builds (not missing), in source order (a
// statement without its own `;` gets one on the next line). Found by the tree's TypeScript target
// building the same shape (its observeBuilt seam). Prints the coverage per input.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [tree0, outDir, ...inputs] = process.argv.slice(2);
const tree = resolve(tree0!);
const imp = (p: string) => import(pathToFileURL(join(tree, p)).href);
const { emitParser } = await imp('src/targets/target.ts');
const { tsTarget } = await imp('src/targets/target-ts.ts');
const { rustTarget } = await imp('src/targets/target-rust.ts');
const shape = (await imp('test/fixtures/shape-tsc-synthesized.ts')).default;
writeFileSync(join(outDir!, 'shape.rs'), emitParser(shape.source, rustTarget, { shape }));
const mod = resolve(outDir!, 'shape-ts.mts');
writeFileSync(mod, emitParser(shape.source, tsTarget, { shape }));
const m = await import(pathToFileURL(mod).href);
const arms = m.shapeArms as { rule: string; arm: string }[];
for (const input of inputs) {
  const src = readFileSync(input, 'utf8');
  const spans: [number, number][] = [];
  m.observeBuilt((id: number, off: number, end: number, v: unknown) => {
    const a = arms[id]!;
    if (a.rule === 'Stmt' && a.arm === 'expr' && !(v instanceof m.ShapeMissing)) spans.push([off, end]);
  });
  try { m.parse(src); } catch (e) { if (!(e instanceof m.ShapeMissing)) throw e; }
  m.observeBuilt(null);
  const uniq = [...new Map(spans.map((s) => [`${s[0]}:${s[1]}`, s])).values()].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const keep: [number, number][] = [];
  for (const s of uniq) { const last = keep[keep.length - 1]; if (last && s[0] < last[1]) continue; keep.push(s); }
  const text = keep.map(([a, b]) => { const t = src.slice(a, b); return t.trimEnd().endsWith(';') ? t + '\n' : t + '\n;\n'; }).join('');
  const out = input.replace(/(\.[a-z]+)$/, '.cov$1');
  writeFileSync(out, text);
  const bytes = keep.reduce((n, [a, b]) => n + (b - a), 0);
  console.log(`SHAPECOV ${input} statements=${keep.length} bytes=${bytes} of ${src.length} share=${(bytes / src.length).toFixed(4)} -> ${out}`);
}
rmSync(mod);
