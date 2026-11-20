// node hashes.ts <repo root> > out.txt : sha256 of emitParser(grammar, t) (+ emitRunner) for every grammar module.
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
const root = process.argv[2];
const { emitParser, tsTarget, goTarget, rustTarget } = await import(root + '/src/emit.ts');
const files = [...readdirSync(root).filter((f) => /^[a-z].*\.ts$/.test(f)).map((f) => root + '/' + f),
  ...readdirSync(root + '/test/fixtures').filter((f) => f.endsWith('.ts')).map((f) => root + '/test/fixtures/' + f)];
const h = (s: string) => createHash('sha256').update(s).digest('hex');
let n = 0;
for (const f of files.sort()) {
  let g: any;
  try { g = (await import(f)).default; } catch { continue; }
  if (!g || typeof g !== 'object' || !('rules' in g)) continue;
  for (const t of [tsTarget, goTarget, rustTarget]) {
    let out: string;
    try { out = emitParser(g, t); } catch (e) { out = 'THROW ' + (e as Error).message; }
    console.log(`${h(out)}  ${f.slice(root.length + 1)} ${t.name}`); n++;
  }
}
for (const t of [tsTarget, goTarget, rustTarget]) if (t.emitRunner) console.log(`${h(t.emitRunner())}  runner ${t.name}`);
console.error(`${n} outputs`);
