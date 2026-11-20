// node summarize.ts results/results.log: per row and variant, the median over rounds of each
// number the harness prints (rows: gobench, goprof, goedit, gotok in.ts|2mb, rust, rstok, ts, tstok).
import { readFileSync } from 'node:fs';
const rows = new Map<string, Map<string, number[][]>>();
const order: string[] = [];
for (const line of readFileSync(process.argv[2]!, 'utf8').split('\n')) {
  const m = line.match(/^\d+ (\S+) (\S+)\s+(in\.ts |2mb   )?(.*)$/);
  if (!m) continue;
  const [, v, h, sub, rest] = m;
  const key = `${h}${sub ? ' ' + sub.trim() : ''}`;
  const nums = [...rest!.replace(/^\S*in\.ts:/, '').matchAll(/(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1]));
  if (!rows.has(key)) { rows.set(key, new Map()); order.push(key); }
  const byV = rows.get(key)!;
  if (!byV.has(v!)) byV.set(v!, []);
  byV.get(v!)!.push(nums);
}
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]!; };
for (const key of order) {
  console.log(key);
  for (const [v, runs] of rows.get(key)!) {
    const cols = runs[0]!.map((_, i) => med(runs.map((r) => r[i]!)));
    console.log(`  ${v.padEnd(5)} n=${runs.length}  ${cols.join('  ')}`);
  }
}
