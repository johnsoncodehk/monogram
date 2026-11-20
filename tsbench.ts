import { readFileSync } from 'node:fs';
const [mod, path] = process.argv.slice(2);
const { createDoc } = await import(mod);
const src = readFileSync(path, 'utf8');
const med = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
const dn: number[] = [];
for (let i = 0; i < 15; i++) { const t = performance.now(); const d = createDoc(src); dn.push(performance.now() - t); if (!d.root()) throw new Error('reject'); }
const d = createDoc(src);
const semis: number[] = []; for (let i = src.indexOf(';'); i >= 0; i = src.indexOf(';', i + 1)) semis.push(i + 1);
const ed: number[] = [];
for (let i = 0; i < 400; i++) {
  const at = semis[(i * 7919) % semis.length];
  const prev = semis[((i - 1) * 7919) % semis.length];
  const e = i % 2 === 0 ? { start: at, end: at, text: ' ' } : { start: prev, end: prev + 1, text: '' };
  const t = performance.now(); d.edit([e]); ed.push(performance.now() - t);
}
if (!d.root()) throw new Error('edit reject');
console.log(`createDoc ${med(dn).toFixed(3)}ms  edit median ${med(ed).toFixed(4)}ms`);
