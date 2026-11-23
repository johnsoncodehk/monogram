// node test/cpuprofile-top.ts <file.cpuprofile> [n]: the n functions (default 25) with the most
// self time and the most total (inclusive) time in a V8 CPU profile (`node --cpu-prof`), by
// function and source line. A reading aid for a slow generator or gate, not a gate.
import { readFileSync } from 'node:fs';

type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount: number; children?: number[] };
const prof = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { nodes: Node[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number };
const n = Number(process.argv[3] ?? 25);
const byId = new Map(prof.nodes.map((x) => [x.id, x]));
const parent = new Map<number, number>();
for (const x of prof.nodes) for (const c of x.children ?? []) parent.set(c, x.id);
const totalMs = (prof.endTime - prof.startTime) / 1000;
const msPerHit = totalMs / Math.max(1, prof.samples.length);
const key = (x: Node) => `${x.callFrame.functionName || '(anonymous)'} ${x.callFrame.url.replace(/^.*\/(src|test)\//, '$1/')}:${x.callFrame.lineNumber + 1}`;
const self = new Map<string, number>(), incl = new Map<string, number>();
for (const id of prof.samples) {
  const leaf = byId.get(id)!;
  self.set(key(leaf), (self.get(key(leaf)) ?? 0) + 1);
  const seen = new Set<string>();
  for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
    const k = key(byId.get(cur)!);
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + 1);
  }
}
const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, h]) => `  ${(h * msPerHit / 1000).toFixed(1).padStart(7)} s  ${k}`).join('\n');
console.log(`profile: ${(totalMs / 1000).toFixed(1)} s, ${prof.samples.length} samples\n── self ──\n${top(self)}\n── inclusive ──\n${top(incl)}`);
