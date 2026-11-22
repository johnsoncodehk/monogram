// node summarize.ts results.txt: tables from run.sh's result lines (IR, COUNT, OXCCOUNT, OXCLEX,
// TIME, PERF, acceptance). Per input and parser: instructions per parse, per byte, per token; the
// lexer's share; work counts; heap traffic.
import { readFileSync } from 'node:fs';
const kv = (s: string) => Object.fromEntries([...s.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
const ir: Record<string, number> = {};
const count: Record<string, Record<string, string>> = {};
const oxc: Record<string, Record<string, string>> = {};
const oxclex: Record<string, Record<string, string>> = {};
const acc: Record<string, string> = {};
const time: Record<string, number> = {};
const bytes: Record<string, number> = {};
const files: string[] = [];
// FAULTS <mode> lines of the monogram count builds (`<v> FAULTS cold|warm|reuse <file> k=v…`) and
// OXCFAULTS <fresh|reuse> <file> k=v… of oxc-count.
const faults: Record<string, Record<string, string>> = {};
for (const line of readFileSync(process.argv[2], 'utf8').split('\n')) {
  const p = line.trim().split(/\s+/);
  if (p[0] === 'IR' && p[2] !== 'FAILED') ir[p[1]] = +p[2];
  else if (p[0] === 'OXCCOUNT') oxc[p[1]] = kv(line);
  else if (p[0] === 'OXCLEX') oxclex[p[1]] = kv(line);
  else if (p[1] === 'COUNT') count[`${p[0]}.${p[2]}`] = kv(line);
  else if (p[1] === 'FAULTS') faults[`${p[0]}.${p[2]}.${p[3]}`] = kv(line);
  else if (p[0] === 'OXCFAULTS') faults[`C.${p[1] === 'fresh' ? 'warm' : p[1]}.${p[2]}`] = kv(line);
  else if (p[1] === 'ACCEPT' || p[1] === 'REJECT') {
    acc[`${p[0]}.${p[2]}`] = p[1];
    const b = kv(line).bytes; if (b) bytes[p[2]] = +b;
    if (!files.includes(p[2])) files.push(p[2]);
  } else if (p[1] === 'TIME') time[`${p[0]}.${p[2]}.${p[3]}`] = +kv(line).ms;
}
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : '-');
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const M = (x: number) => (Number.isFinite(x) ? (x / 1e6).toFixed(1) + 'M' : '-');
// A missing cell (a reference crash on a pathological input leaves its counters absent) prints as '-'.
const row = (cells: (string | undefined)[], w: number[]) => console.log(cells.map((c = '-', i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join(' '));

console.log('\n## Instructions per parse (Callgrind Ir, one parse + drop of what it built)');
console.log('tokens: each parser\'s own count (monogram: its token array; oxc: TokensParserConfig). per oxc-token: both sides over oxc\'s count.');
const W1 = [16, 4, 7, 9, 9, 8, 8, 8, 9, 8, 8, 9, 8, 8];
row(['input', 'p', 'accept', 'tokens', 'Ir', 'Ir/byte', 'Ir/tok', 'Ir/oxtok', 'lex Ir', 'lex/tok', 'lex %', 'rest Ir', 'rest/tok', 'vs oxc'], W1);
for (const f of files) {
  const otok = +(oxc[f]?.tokens ?? NaN);
  const cIr = ir[`C.parse.${f}`];
  for (const v of ['C', 'A', 'M']) {
    const t = v === 'C' ? otok : +(count[`${v}.${f}`]?.tokens ?? NaN);
    const p = ir[`${v}.parse.${f}`], l = ir[`${v}.lex.${f}`];
    row([f, v, acc[`${v}.${f}`] ?? '-', f0(t), M(p), f1(p / bytes[f]), f1(p / t), f1(p / otok), M(l), f1(l / t), f0((100 * l) / p) + '%', M(p - l), f1((p - l) / t), f2(p / cIr)], W1);
  }
}
console.log('C lex = oxc Lexer alone (oxc-lex; no parser, so no regex/template re-lex). A/M lex = lex(src) alone, the token array parse_with builds first.');
console.log('tokenize (public, lex + Token mapping) Ir:', files.flatMap((f) => ['A', 'M'].map((v) => ir[`${v}.tokenize.${f}`] ? `${v}.${f}=${M(ir[`${v}.tokenize.${f}`])}` : '')).filter(Boolean).join(' '));

console.log('\n## Native time (profiled build, one bench loop each; indicative) and instructions per ns');
row(['input', 'p', 'ms', 'lex ms', 'Ir/ns'], [16, 4, 9, 9, 7]);
for (const f of files) for (const v of ['C', 'A', 'M']) {
  const ms = time[`${v}.parse.${f}`]; if (!ms) continue;
  row([f, v, f2(ms), f2(time[`${v}.lex.${f}`]), f2(ir[`${v}.parse.${f}`] / (ms * 1e6))], [16, 4, 9, 9, 7]);
}

console.log('\n## monogram work counts (count build): per parse');
const W2 = [16, 3, 8, 9, 9, 9, 9, 9, 9, 8, 8, 8, 9, 9];
row(['input', 'p', 'tokens', 'pushed', 'final', 'reach', 'discard', 'orphan', 'hiwater', 'push/fin', 'leaf/tok', 'peek/tok', 'ckpts', 'restores'], W2);
for (const f of files) for (const v of ['A', 'M']) {
  const c = count[`${v}.${f}`]; if (!c) continue;
  const n = (k: string) => +c[k];
  row([f, v, c.tokens, c.pushed_nodes, c.final_nodes, c.reachable_nodes, c.discarded_nodes, f0(n('final_nodes') - n('reachable_nodes')), c.arena_high_water_nodes,
    f2(n('pushed_nodes') / n('reachable_nodes')), f2(n('leaf_pushes') / n('tokens')), f2(n('peeks') / n('tokens')), c.checkpoints, c.restores], W2);
}
console.log('pushed = nodes pushed by finish/node; final = arena length at the end; reach = reachable from the root; discard = truncated by restore;');
console.log('orphan = left in the arena but unreachable; push/fin = pushed / reachable; leaf/tok = leaf handles pushed per token (1.00 = each token consumed once).');

console.log('\n## heap traffic per parse (counting global allocator; armed around the parse and the drop)');
const W3 = [16, 3, 9, 9, 9, 12, 9, 12, 10, 12];
row(['input', 'p', 'malloc', 'realloc', 'free', 'alloc B', 'B/byte', 'peak live B', 'peak/byte', 'arena/out B'], W3);
for (const f of files) {
  const o = oxc[f];
  if (o) row([f, 'C', o.malloc, o.realloc, o.free, o.alloc_bytes, f1(+o.alloc_bytes / bytes[f]), o.peak_live_bytes, f1(+o.peak_live_bytes / bytes[f]), o.arena_used_bytes], W3);
  for (const v of ['A', 'M']) {
    const c = count[`${v}.${f}`]; if (!c) continue;
    row([f, v, c.malloc, c.realloc, c.free, c.alloc_bytes, f1(+c.alloc_bytes / bytes[f]), c.peak_live_bytes, f1(+c.peak_live_bytes / bytes[f]), c.arena_capacity_bytes], W3);
    row(['  (lex alone)', v, c.lex_malloc, c.lex_realloc, c.lex_free, c.lex_alloc_bytes, f1(+c.lex_alloc_bytes / bytes[f]), c.lex_peak_live_bytes, f1(+c.lex_peak_live_bytes / bytes[f]), ''], W3);
  }
}
console.log('C arena/out = oxc Allocator used bytes after the parse; A/M arena/out = capacity bytes of the CST builder\'s nodes+kids+toks Vecs after the parse.');
console.log('\n## Per mode: instructions, faults, allocator calls per parse (steady loop: 3 warm-up parses, mean of 10)');
console.log('fresh = a new CstBuilder / Allocator per parse, dropped after it. reuse = one CstBuilder kept (parse_with) / one Allocator reset() before each parse.');
console.log('Ir: Callgrind, one parse (fresh: X.parse; reuse: X.parse-reuse, after one warm parse). allocs, B: malloc+realloc calls and bytes;');
console.log('fresh allocs/B are of the single counted parse (COUNT / OXCCOUNT), reuse ones the mean of the 10 measured parses. peak: fresh = peak live heap of one parse; reuse = max RSS of the loop.');
const W4 = [16, 6, 3, 9, 9, 10, 12, 12];
for (const mode of ['fresh', 'reuse']) {
  console.log(`\n### mode ${mode}`);
  row(['input', 'mode', 'p', 'Ir', 'flt/parse', 'allocs', 'alloc B', 'peak'], W4);
  for (const f of files) for (const v of ['A', 'M', 'C']) {
    const fl = faults[`${v}.${mode === 'fresh' ? 'warm' : 'reuse'}.${f}`];
    const irv = ir[`${v}.${mode === 'fresh' ? 'parse' : 'parse-reuse'}.${f}`];
    let allocs: string | undefined, ab: string | undefined, peak: string | undefined;
    if (mode === 'fresh') {
      const c = v === 'C' ? oxc[f] : count[`${v}.${f}`];
      if (c) { allocs = f0(+c.malloc + +c.realloc); ab = c.alloc_bytes; peak = c.peak_live_bytes; }
    } else if (fl) { allocs = fl.allocs_per_parse; ab = fl.alloc_bytes_per_parse; peak = fl.maxrss_kb ? `${fl.maxrss_kb}KiB rss` : undefined; }
    row([f, mode, v, M(irv), fl?.minflt_per_parse, allocs, ab, peak], W4);
  }
}

console.log('\n## oxc counts');
for (const f of files) if (oxc[f]) console.log(`${f}: tokens=${oxc[f].tokens} ast_nodes(enter_node)=${oxc[f].ast_nodes} arena_capacity=${oxc[f].arena_capacity_bytes} oxc-lex tokens=${oxclex[f]?.tokens ?? '-'}`);
