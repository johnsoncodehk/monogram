// node tstok.ts <parser.ts> <file>: tokenize only; 20 warm-up runs, then the median and min of 101 runs.
import { readFileSync } from 'node:fs';
const [mod, path] = process.argv.slice(2);
const { tokenize } = await import(mod);
const src = readFileSync(path, 'utf8');
const n = tokenize(src).length;
for (let i = 0; i < 20; i++) tokenize(src);
const ts: number[] = [];
for (let i = 0; i < 101; i++) { const t = performance.now(); if (tokenize(src).length !== n) throw new Error('count'); ts.push(performance.now() - t); }
ts.sort((a, b) => a - b);
console.log(`tokenize ${n} toks median ${ts[50].toFixed(3)} ms  min ${ts[0].toFixed(3)} ms`);
