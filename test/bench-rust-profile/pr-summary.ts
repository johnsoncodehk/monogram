// node pr-summary.ts <results.txt> <emit-sizes-A.json> <emit-sizes-M.json>: the Markdown report of
// one A/M profile (run.sh with PROFILE_SCOPE=pr) for a pull request's job summary.
//
// What decides what (docs/MEASUREMENT.md):
// - Callgrind instructions are deterministic: they decide a logic change. Any input whose
//   instructions rise by more than 0.5% is listed under "Regressions".
// - Work counters (tokens, nodes pushed, checkpoints, peeks, ...) must be identical unless the
//   pull request changes the grammar or the parser's search; which ones differ is listed.
// - For memory behaviour instructions are blind: allocator calls / bytes and page faults decide.
//   Any rise in allocator calls per parse in reuse mode is listed under "Regressions".
// - Emitted sizes: any increase above 1% is listed under "Regressions".
// A regression is reported, never a failure (the grammar legitimately changes work). A cell the
// harness did not produce for A or M is a failure: the report says NOT RUN and this exits 1.
//
// GRAMMAR_CHANGED=1 in the environment says the pull request touches a grammar file.
import { readFileSync } from 'node:fs';

// An optional fourth argument, M's size record (docs/emit-sizes.json), adds the drift of M against
// it: a size past test/emit-size-record.ts's tolerance is listed as a regression. This is the one
// place the record is compared on a landing (it is not a gate of test/check.ts: a gate made every
// unrelated landing re-record); a landing that moves a size on purpose re-records in its own diff.
const [resultsFile, sizesA, sizesM, sizeRecord] = process.argv.slice(2);
if (!resultsFile || !sizesA || !sizesM) throw new Error('usage: pr-summary.ts <results.txt> <emit-sizes-A.json> <emit-sizes-M.json>');
const kv = (s: string) => Object.fromEntries([...s.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));

const ir: Record<string, number> = {};
const irFailed: string[] = [];
const count: Record<string, Record<string, string>> = {};
const faults: Record<string, Record<string, string>> = {};
const acc: Record<string, string> = {};
const crashes: string[] = [];
const files: string[] = [];
// The other targets (run.sh, "Go and TS targets"): `GOIR <v>.<reuse|builder>.<file> <verdict> ir=<n>
// total=<n> mapir=<n> mapcalls=<n>` (test/bench-targets/go-ir.ts), `TSBLK <v>.<ts-parse|js-fresh>.<file>
// <verdict> blocks=<n> functions=<k>`; v = A, M or M2 (M again).
const work: Record<string, number> = {};
const workVerdict: Record<string, string> = {};
const goMap: Record<string, Record<string, string>> = {};
for (const line of readFileSync(resultsFile, 'utf8').split('\n')) {
  const p = line.trim().split(/\s+/);
  if (p[0] === 'IR') { if (p[2] === 'FAILED' || !/^\d+$/.test(p[2] ?? '')) irFailed.push(p[1]); else ir[p[1]] = +p[2]; continue; }
  if (p[0] === 'TSALLOC') {
    const [v, mode, ...rest] = p[1].split('.');
    const f = kv(line);
    if (/^\d+$/.test(f.allocs ?? '')) work[`${v}.${mode}-allocs.${rest.join('.')}`] = +f.allocs!;
    else irFailed.push(`${p[0]} ${p[1]}`);
    continue;
  }
  if (p[0] === 'GOIR' || p[0] === 'TSBLK') {
    const [v, mode, ...rest] = p[1].split('.');
    const key = `${v}.${p[0] === 'GOIR' ? 'go-' + mode : mode}.${rest.join('.')}`;
    // Go: every instruction of the parse, the map runtime's included (once the parse path reads no
    // map, as on the typescript grammar since the Pratt tables became arrays, the count repeats exactly).
    const f = kv(line), n = p[0] === 'GOIR' ? f.total : f.blocks, verdict = p[2];
    if (p[0] === 'GOIR') goMap[key] = f;
    if (/^\d+$/.test(n ?? '') && (verdict === 'ACCEPT' || verdict === 'REJECT')) { work[key] = +n!; workVerdict[key] = verdict; }
    else irFailed.push(`${p[0]} ${p[1]}`);
    continue;
  }
  if (p[0] !== 'A' && p[0] !== 'M') continue;
  const v = p[0];
  if (p[1] === 'COUNT') count[`${v}.${p[2]}`] = kv(line);
  else if (p[1] === 'FAULTS') faults[`${v}.${p[3]}.${p[2]}`] = kv(line);
  else if (p[1] === 'ACCEPT' || p[1] === 'REJECT') { acc[`${v}.${p[2]}`] = p[1]; if (!files.includes(p[2])) files.push(p[2]); }
  else if (/CRASH$/.test(p[1])) crashes.push(line.trim());
}

const out: string[] = [];
const say = (s = '') => out.push(s);
const notRun: string[] = [...crashes, ...irFailed.map((t) => `Callgrind ${t} FAILED`)];
const need = (what: string, x: unknown) => { if (x === undefined || (typeof x === 'number' && !Number.isFinite(x))) notRun.push(`${what} missing`); return x; };
if (files.length === 0) notRun.push('no input was parsed at all');

const pct = (a: number, m: number) => (a > 0 && Number.isFinite(a) && Number.isFinite(m) ? ((m / a - 1) * 100) : NaN);
const fpct = (x: number) => (Number.isFinite(x) ? (x === 0 ? '0' : (x > 0 ? '+' : '') + x.toFixed(2) + '%') : '-');
const num = (x: number | string | undefined) => (x === undefined || x === '' || !Number.isFinite(+x) ? '-' : (+x).toLocaleString('en-US', { maximumFractionDigits: 1 }));
const table = (head: string[], rows: string[][]) => {
  say('| ' + head.join(' | ') + ' |');
  say('|' + head.map((_, i) => (i === 0 ? ':--' : '--:')).join('|') + '|');
  for (const r of rows) say('| ' + r.join(' | ') + ' |');
};

const regress: string[] = [];
const IR_LIMIT = 0.5, SIZE_LIMIT = 1;

// ---- instructions (both modes, plus the lexer alone)
for (const f of files) for (const v of ['A', 'M']) {
  need(`${v} parse ${f} (COUNT)`, count[`${v}.${f}`]);
  for (const k of ['parse', 'parse-reuse', 'lex']) need(`${v} Callgrind ${k} ${f}`, ir[`${v}.${k}.${f}`]);
  for (const m of ['warm', 'reuse']) need(`${v} faults ${m} ${f}`, faults[`${v}.${f}.${m}`] ? 1 : undefined);
}
for (const f of files) for (const k of ['parse', 'parse-reuse', 'lex']) {
  const d = pct(ir[`A.${k}.${f}`], ir[`M.${k}.${f}`]);
  if (d > IR_LIMIT) regress.push(`instructions, ${k}, ${f}: ${fpct(d)} (${num(ir[`A.${k}.${f}`])} → ${num(ir[`M.${k}.${f}`])})`);
}
for (const f of files) {
  const a = +(faults[`A.${f}.reuse`]?.allocs_per_parse ?? NaN), m = +(faults[`M.${f}.reuse`]?.allocs_per_parse ?? NaN);
  if (m > a) regress.push(`allocator calls per parse in reuse mode, ${f}: ${num(a)} → ${num(m)}`);
}

// ---- emitted sizes
const sa = JSON.parse(readFileSync(sizesA, 'utf8')) as Record<string, Record<string, { bytes: number; sha: string }>>;
const sm = JSON.parse(readFileSync(sizesM, 'utf8')) as Record<string, Record<string, { bytes: number; sha: string }>>;
const sizeRows: string[][] = [];
const RECORD_TOLERANCE = 0.25; // test/emit-size-record.ts's TOLERANCE
const rec: Record<string, Record<string, number>> | null = sizeRecord ? (() => { try { return JSON.parse(readFileSync(sizeRecord, 'utf8')); } catch { return {}; } })() : null;
for (const g of Object.keys(sm)) for (const t of Object.keys(sm[g])) {
  const a = sa[g]?.[t], m = sm[g][t];
  const d = a ? pct(a.bytes, m.bytes) : NaN;
  if (d > SIZE_LIMIT) regress.push(`emitted size, ${g} ${t}: ${fpct(d)} (${num(a!.bytes)} → ${num(m.bytes)} bytes)`);
  const row = [g, t, a ? num(a.bytes) : '(absent)', num(m.bytes), fpct(d), a && a.sha === m.sha ? 'identical' : 'differs'];
  if (rec) {
    const r = rec[g]?.[t];
    const dr = r === undefined ? NaN : pct(r, m.bytes);
    if (!(Math.abs(dr) <= RECORD_TOLERANCE)) regress.push(`emitted size against the record, ${g} ${t}: ${r === undefined ? 'not recorded' : `${fpct(dr)} (${num(r)} → ${num(m.bytes)} bytes)`}`);
    row.push(r === undefined ? '(absent)' : num(r), fpct(dr));
  }
  sizeRows.push(row);
}
for (const g of Object.keys(sa)) for (const t of Object.keys(sa[g])) if (!sm[g]?.[t]) notRun.push(`emitted size ${g} ${t} missing for M`);

// ---- work counters
const WORK = ['tokens', 'final_nodes', 'final_kids', 'reachable_nodes', 'reachable_leaves', 'pushed_nodes', 'pushed_kids', 'leaf_pushes',
  'checkpoints', 'restores', 'restores_discarding', 'discarded_nodes', 'discarded_kids', 'arena_high_water_nodes', 'peeks'];
const workDiff: string[][] = [];
for (const f of files) {
  const a = count[`A.${f}`], m = count[`M.${f}`];
  if (!a || !m) continue;
  const diffs = WORK.filter((k) => a[k] !== m[k]).map((k) => `${k} ${num(a[k])} → ${num(m[k])}`);
  if (acc[`A.${f}`] !== acc[`M.${f}`]) diffs.unshift(`verdict ${acc[`A.${f}`]} → ${acc[`M.${f}`]}`);
  workDiff.push([f, diffs.length ? diffs.join('; ') : 'identical']);
}
const workChanged = workDiff.some((r) => r[1] !== 'identical');

// ---- every target side by side: Rust and Go instructions, TS-target and JS-target block executions
// A column "moves" when |Δ| > 0.1%; it "stays" when |Δ| <= 0.01% (the determinism bound below). An
// input on which one target moves and another stays is listed as single-target (reported, not failing).
const MOVE = 0.1, STILL = 0.01;
const cols: { target: string; head: string; get: (v: string, f: string) => number | undefined; key?: string }[] = [
  { target: 'Rust', head: 'Rust Ir fresh', get: (v, f) => ir[`${v}.parse.${f}`] },
  { target: 'Rust', head: 'Rust Ir reuse', get: (v, f) => ir[`${v}.parse-reuse.${f}`] },
  ...([['Go', 'Go Ir reuse', 'go-reuse'], ['Go', 'Go Ir builder', 'go-builder'], ['TS', 'TS blocks', 'ts-parse'], ['TS', 'TS allocs', 'ts-parse-allocs'],
    ['JS', 'JS blocks', 'js-fresh'], ['JS', 'JS allocs', 'js-fresh-allocs']] as const)
    .map(([target, head, key]) => ({ target, head, key, get: (v: string, f: string) => work[`${v}.${key}.${f}`] })),
];
const repeated = Object.keys(work).some((k) => k.startsWith('M2.'));
// The inputs the other targets were measured on (run.sh: its main inputs); each needs every cell.
const tfiles = files.filter((f) => Object.keys(work).some((k) => k.endsWith('.' + f)));
if (tfiles.length === 0) notRun.push('the Go, TS and JS targets were measured on no input');
let repeatMax = 0;
// A cell whose M does not repeat cannot be trusted: it is shown as NOT RUN and listed, and the job
// stays green (the code it measures may be untouched by the pull request; a red job would block it).
const untrusted: string[] = [];
const untrustedCell = new Set<string>();
for (const f of tfiles) for (const c of cols.slice(2)) {
  for (const v of ['A', 'M']) need(`${v} ${c.head} ${f}`, c.get(v, f));
  if (repeated && !c.key!.endsWith('-allocs')) {
    const m = c.get('M', f), m2 = c.get('M2', f);
    need(`M2 ${c.head} ${f}`, m2);
    const d = Math.abs(pct(m!, m2!));
    if (Number.isFinite(d)) repeatMax = Math.max(repeatMax, d);
    const mc = c.key!.startsWith('go-') ? goMap[`M.${c.key}.${f}`]?.mapcalls : undefined;
    if (d > STILL) {
      untrusted.push(`${c.head} ${f}: M measured twice differs by ${fpct(d)} (${num(m)} / ${num(m2)})` +
        (mc && mc !== '0' ? `: the parse makes ${num(mc)} calls into the Go map runtime, whose hash seed is random per process (read no map on the parse path)` : ''));
      untrustedCell.add(`${c.head}.${f}`);
    }
  }
}
const singleTarget: string[] = [];
const sideRows: string[][] = [];
for (const f of tfiles) {
  const moved = new Map<string, string[]>(), still = new Set(cols.map((c) => c.target));
  const cells = [f];
  for (const c of cols) {
    const d = pct(c.get('A', f)!, c.get('M', f)!);
    if (untrustedCell.has(`${c.head}.${f}`)) { cells.push('NOT RUN'); still.delete(c.target); continue; }
    cells.push(Number.isFinite(d) && d !== 0 ? (d > 0 ? '+' : '') + d.toFixed(3) + '%' : fpct(d));
    if (!Number.isFinite(d)) { still.delete(c.target); continue; }
    if (Math.abs(d) > STILL) still.delete(c.target);
    if (Math.abs(d) > MOVE) moved.set(c.target, [...(moved.get(c.target) ?? []), `${c.head} ${fpct(d)}`]);
  }
  // Go's map lookups from the parser's own code (go-ir.ts): shown here so that a lookup added or
  // removed on the parse path is visible in the same row.
  const ma = goMap[`A.go-reuse.${f}`]?.mapcalls, mm = goMap[`M.go-reuse.${f}`]?.mapcalls;
  cells.push(ma === mm ? num(mm) : `**${num(ma)} → ${num(mm)}**`);
  sideRows.push(cells);
  if (moved.size && still.size) singleTarget.push(`${f}: ${[...moved.values()].flat().join(', ')}; unchanged: ${[...still].join(', ')}`);
}
const grammarChanged = process.env.GRAMMAR_CHANGED === '1';

// ---- the report
const A = process.env.PROFILE_A_LABEL ?? 'A', M = process.env.PROFILE_M_LABEL ?? 'M';
say('## Rust parser profile: A = ' + A + ', M = ' + M);
say();
say('Deterministic measurements of the emitted Rust parser (typescript grammar; `jsx-corpus.tsx` by typescriptreact, `jsx-corpus.jsx` by javascriptreact: the element code of the pinned tsc corpus, test/bench-rust-profile/element-inputs.ts): Callgrind instructions, work counters, allocator calls, page faults; and emitted sizes. ' +
  'Instructions decide logic changes; allocator calls and page faults decide memory changes; no wall-clock time is measured here (on demand: the `measure-bench` workflow). ' +
  'The Go target, the TS target and the emitted JS parser are measured on the same inputs beside it (section "Every target").');
say();
say('**Reading the Rust instruction column** (docs/MEASUREMENT.md): for a logic change the work counters decide; Rust instructions move with code layout by up to about ±1% per input, so judge the real inputs as a set (none worse overall, none up by more than about 0.3% unexplained; synthetic inputs may move within that band), and check an input that moves against the counters with the per-function Callgrind; Go instructions and TS blocks have no such band.');
say();
if (process.env.RUNNER_CPU) { say('Runner: ' + process.env.RUNNER_CPU); say(); }
if (notRun.length) {
  say('### NOT RUN: the harness did not produce every measurement (this job fails)');
  for (const x of notRun) say('- ' + x);
  say();
}
if (untrusted.length) {
  say(`### NOT RUN: ${untrusted.length} measurement(s) did not repeat (shown as NOT RUN below; this does not fail the job)`);
  for (const x of untrusted) say('- ' + x);
  say();
}
if (regress.length) {
  say(`### Regressions (reported, not failing): ${regress.length}`);
  say(`Thresholds: instructions +${IR_LIMIT}%, any rise in reuse-mode allocator calls per parse, emitted size +${SIZE_LIMIT}% against A${rec ? ` and beyond ±${RECORD_TOLERANCE}% against the record` : ""}.`);
  for (const x of regress) say('- **' + x + '**');
} else say('### Regressions: none (instructions within +0.5%, reuse-mode allocator calls not up, emitted sizes within +1% of A and ±0.25% of the record)');
say();
say('### Every target, A → M');
if (singleTarget.length) {
  say(`**Single-target changes (reported, not failing): ${singleTarget.length}.** One target moves by more than ${MOVE}% while another stays within ${STILL}%: an improvement the other targets did not get, or a change that touched one printer only.`);
  for (const x of singleTarget) say('- ' + x);
} else say(`Single-target changes: none (no input where one target moves by more than ${MOVE}% while another stays within ${STILL}%).`);
say();
table(['input', ...cols.map((c) => c.head + ' Δ'), 'Go map calls (A → M)'], sideRows);
say();
say('Rust / Go: Callgrind instructions of one parse (Go reuse: `ParseWith` into the `CstBuilder` of a first parse, which runs the direct engine; Go builder: the same into a kept `SlimBuilder`, which runs the builder engine `parserW` through the `Builder` interface; reuse mode only: a first parse into a new builder varies between runs in the page allocator; built with `-tags faketime`, run with `GOGC=off GOMAXPROCS=1 GODEBUG=asyncpreemptoff=1`, the Go runtime\'s own work inside the parse included; the last column counts the calls from the parser\'s own code into the Go map runtime, which should be 0: a map\'s hash seed is random per process, so a parse that reads a map does not repeat its instruction count, and its Go cell becomes NOT RUN; the calling functions are in the artifact, `targets/*.map-callers.txt`). ' +
  'TS / JS blocks: V8 block executions of one `parse(src)` of the TS target and one `createParser().parse(src)` of the emitted JS parser (precise block coverage with counts). **They detect a change of control flow, not its cost or its direction**: on PR #141 they rose 7-10% while time fell 10-28% and allocations fell 27%. TS / JS allocs: the exact allocations of the same parse (test/alloc-instrument.ts, the alloc-work gate\'s counting), the cost signal beside them. ' +
  (repeated ? `M was measured twice for Go, TS and JS: the largest difference was ${fpct(repeatMax)}.` : 'M was measured once (PROFILE_TARGETS_REPEAT=0).'));
say();
say('<details><summary>Go, TS and JS counts A / M</summary>');
say();
table(['input', ...cols.slice(2).map((c) => c.head + ' A / M')], tfiles.map((f) => [f, ...cols.slice(2).map((c) =>
  num(c.get('A', f)) + ' / ' + num(c.get('M', f)) + (workVerdict[`M.${c.key}.${f}`] === 'REJECT' ? ' (M rejects)' : ''))]));
say();
say();
say('Go map lookups on the parse path (counted apart from Go Ir: calls into the map runtime, and their instructions in this run, which vary with the hash seed):');
say();
table(['input', 'calls A / M', 'map Ir A / M'], tfiles.map((f) => [f,
  ...['mapcalls', 'mapir'].map((k) => num(goMap[`A.go-reuse.${f}`]?.[k]) + ' / ' + num(goMap[`M.go-reuse.${f}`]?.[k]))]));
say();
say('</details>');
say();
say('### Work counters');
if (!workChanged) say('Identical on every input.');
else {
  say(grammarChanged ? 'Differ (this pull request changes a grammar file, so work may legitimately change):'
    : '**Differ although this pull request changes no grammar file** (the parser\'s search changed): check that this is intended.');
  say();
  table(['input', 'A → M'], workDiff);
}
say();
const modeTable = (mode: 'fresh' | 'reuse') => {
  const k = mode === 'fresh' ? 'parse' : 'parse-reuse';
  const fm = mode === 'fresh' ? 'warm' : 'reuse';
  const rows: string[][] = [];
  for (const f of files) {
    const cells = [f + (acc[`M.${f}`] === 'REJECT' ? ' (M rejects)' : '')];
    const ia = ir[`A.${k}.${f}`], im = ir[`M.${k}.${f}`];
    cells.push(num(ia), num(im), fpct(pct(ia, im)));
    const pick = (v: string) => {
      if (mode === 'fresh') { const c = count[`${v}.${f}`]; return c ? [+c.malloc + +c.realloc, +c.alloc_bytes, +faults[`${v}.${f}.warm`]?.minflt_per_parse, +c.peak_live_bytes] : []; }
      const fl = faults[`${v}.${f}.reuse`]; return fl ? [+fl.allocs_per_parse, +fl.alloc_bytes_per_parse, +fl.minflt_per_parse, +fl.maxrss_kb * 1024] : [];
    };
    const [a, m] = [pick('A'), pick('M')];
    for (let i = 0; i < 4; i++) cells.push(num(a[i]) + ' / ' + num(m[i]));
    rows.push(cells);
  }
  say(`### Mode ${mode}: ${mode === 'fresh' ? 'a new CstBuilder per parse, dropped after it' : 'one CstBuilder kept across parses (parse_with reuses its buffers)'}`);
  table(['input', 'Ir A', 'Ir M', 'Ir Δ', 'allocator calls A / M', 'alloc bytes A / M', 'page faults/parse A / M', mode === 'fresh' ? 'peak live bytes A / M' : 'max RSS bytes A / M'], rows);
  say();
};
modeTable('reuse');
modeTable('fresh');
say('Ir: Callgrind instructions of one parse (fresh: parse + drop; reuse: one parse into a builder that has parsed the input once). ' +
  'Fresh allocator calls / bytes / peak: one counted parse; reuse ones: the mean of 10 parses after 3 warm-up parses. Page faults: minor faults per parse over the same 10 (fresh: each dropping its buffers).');
say();
say('### Lexer alone (Callgrind, `lex(src)`)');
table(['input', 'Ir A', 'Ir M', 'Ir Δ'], files.map((f) => [f, num(ir[`A.lex.${f}`]), num(ir[`M.lex.${f}`]), fpct(pct(ir[`A.lex.${f}`], ir[`M.lex.${f}`]))]));
say();
say('### Emitted parser sizes (`emitParser`, bytes)');
table(["grammar", "target", "A", "M", "Δ", "output A vs M", ...(rec ? ['record', 'M vs record'] : [])], sizeRows);
if (rec) say(`The record is docs/emit-sizes.json of M; a size beyond ±${RECORD_TOLERANCE}% of it is listed as a regression above (a landing that changes the size on purpose re-records with \`node test/emit-size-record.ts --write\`).`);
say();
console.log(out.join('\n'));
if (notRun.length) { console.error('NOT RUN: ' + notRun.join('; ')); process.exit(1); }
