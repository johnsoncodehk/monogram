// node summarize.ts rows.txt: per input, the per-round ms/parse and MB/s of every parser, medians,
// and per-round time ratios with their range. Rows: "ROW <round> <variant> <file> <ms> <MB/s> (n=..)".
import { readFileSync } from 'node:fs';
type Row = { r: number; v: string; f: string; ms: number; mbps: number };
const rows: Row[] = [];
for (const line of readFileSync(process.argv[2], 'utf8').split('\n')) {
  const p = line.trim().split(/\s+/);
  if (p[0] !== 'ROW') continue;
  rows.push({ r: +p[1], v: p[2], f: p[3], ms: +p[4], mbps: +p[5] });
}
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const VS = ['A', 'P', 'Q', 'B', 'D', 'C'];
// time ratio X/Y: > 1 means X takes longer than Y.
const RATIOS: [string, string][] = [['B', 'A'], ['B', 'C'], ['A', 'C'], ['Q', 'P'], ['B', 'Q'], ['D', 'B'], ['D', 'C']];
const files = [...new Set(rows.map((x) => x.f))];
const summary: string[] = [];
for (const f of files) {
  const fr = rows.filter((x) => x.f === f);
  const rounds = [...new Set(fr.map((x) => x.r))].sort((a, b) => a - b);
  const vs = VS.filter((v) => fr.some((x) => x.v === v));
  const get = (r: number, v: string) => fr.find((x) => x.r === r && x.v === v);
  const rs = RATIOS.filter(([x, y]) => vs.includes(x) && vs.includes(y));
  console.log(`\n### ${f}   (ms/parse | MB/s; ratios are time ratios, >1 = first is slower)`);
  console.log(['round', ...vs.map((v) => `${v} ms`), ...vs.map((v) => `${v} MB/s`), ...rs.map(([x, y]) => `${x}/${y}`)].join('\t'));
  const ratioVals: Record<string, number[]> = {};
  for (const r of rounds) {
    const cells = [String(r)];
    for (const v of vs) cells.push(get(r, v)?.ms.toFixed(3) ?? '-');
    for (const v of vs) cells.push(get(r, v)?.mbps.toFixed(1) ?? '-');
    for (const [x, y] of rs) {
      const a = get(r, x), b = get(r, y);
      if (a && b && a.ms > 0 && b.ms > 0) { (ratioVals[x + '/' + y] ??= []).push(a.ms / b.ms); cells.push((a.ms / b.ms).toFixed(3)); } else cells.push('-');
    }
    console.log(cells.join('\t'));
  }
  const mcells = ['median'];
  for (const v of vs) mcells.push(med(fr.filter((x) => x.v === v).map((x) => x.ms)).toFixed(3));
  for (const v of vs) mcells.push(med(fr.filter((x) => x.v === v).map((x) => x.mbps)).toFixed(1));
  for (const [x, y] of rs) mcells.push(ratioVals[x + '/' + y] ? med(ratioVals[x + '/' + y]).toFixed(3) : '-');
  console.log(mcells.join('\t'));
  for (const [x, y] of rs) {
    const k = x + '/' + y, xs = ratioVals[k];
    if (!xs) continue;
    summary.push(`${f.padEnd(16)} ${k}  median ${med(xs).toFixed(3)}  range ${Math.min(...xs).toFixed(3)}-${Math.max(...xs).toFixed(3)}  (${xs.length} rounds)`);
  }
}
console.log('\n### per-round time ratios (>1 = first is slower)');
for (const s of summary) console.log(s);
