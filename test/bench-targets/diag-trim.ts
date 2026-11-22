// trim.ts <in.mts> <out.mts>: drop every top-level function that parseWith cannot reach (from
// parseWith and from all non-function top-level code), keeping the order of the rest.
import { readFileSync, writeFileSync } from 'node:fs';
const [inp, out] = process.argv.slice(2) as [string, string];
const lines = readFileSync(inp, 'utf8').split('\n');
type Blk = { name: string | null; text: string };
const blocks: Blk[] = [];
let i = 0;
while (i < lines.length) {
  const m = /^(?:export )?function\s*\*?\s*([A-Za-z0-9_$]+)/.exec(lines[i]!);
  if (!m) { blocks.push({ name: null, text: lines[i]! }); i++; continue; }
  let j = i;
  const nxt = lines[i + 1] ?? '';
  if (/^\s/.test(nxt) || nxt === '}') { j = i + 1; while (lines[j] !== '}') j++; }
  blocks.push({ name: m[1]!, text: lines.slice(i, j + 1).join('\n') });
  i = j + 1;
}
const fn = new Map(blocks.filter((b) => b.name).map((b) => [b.name!, b]));
const ids = (s: string) => new Set(s.split("\n").filter((l) => !/^\s*(\/\/|\/\*\*|\*)/.test(l)).join("\n").replace(/ \/\/ .*$/gm, "").match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
const keep = new Set<string>();
const par = new Map<string, string>();
const visit = (s: string, from = "TOP") => { for (const id of ids(s)) if (fn.has(id) && !keep.has(id)) { keep.add(id); par.set(id, from); visit(fn.get(id)!.text, id); } };
visit(blocks.filter((b) => !b.name).map((b) => b.text).join('\n'));
keep.add('parseWith'); visit(fn.get('parseWith')!.text);
// The direct engine's entries are dropped: parse / parseTokens / createDoc are not what parseWith runs.
const kept = blocks.filter((b) => !b.name || keep.has(b.name));
writeFileSync(out, kept.map((b) => b.text).join('\n'));
console.log('functions', fn.size, 'kept', [...fn.keys()].filter((k) => keep.has(k)).length);
if (process.env.WHY) { let k: string | undefined = process.env.WHY; const ch: string[] = []; while (k) { ch.push(k); k = par.get(k); } console.log(ch.join(" <- ")); }
