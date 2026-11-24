// What one parse allocates, per target, grammar and input. Counts, not timings, in the style of
// lexer-work / portable-work. The GATE is the two invariants below (linearity, a reused Go builder
// allocates nothing); the full table is a REPORT, docs/ALLOCATIONS.md, written by `--write` and
// regenerated on master by the README auto-regen workflow (.github/workflows/readme-bench.yml).
//
//   • TS target (`parse`, and `parseWith(src, cstBuilder)`) and the emitted JS parser (`jsTarget`:
//     a new `createParser()` per parse, and the module's one document reused): EXACT counts of the
//     objects, arrays, closures, strings and array growths one parse creates, by site
//     (test/alloc-instrument.ts rewrites the emitted module to count them), and their bytes by a
//     model of V8's layout. For the TS target every object of the returned tree is traced back to
//     its site, so a site's allocations split into RESULT (reachable from the returned CST) and
//     OVERHEAD (garbage once the parse returns). A JS-target parse writes into its document's
//     arena: in reuse mode every allocation is overhead; fresh − reuse is the document's set-up.
//   • Go target (a new CstBuilder per ParseWith, and one reused): runtime.MemStats deltas with the
//     collector off (Mallocs, TotalAlloc: exact), and by allocation site through
//     runtime.MemProfile at MemProfileRate = 1; the result is the final capacity of the builder's
//     Nodes / Kids / Toks, everything else (growth copies, scratch, entries) is overhead.
//   • Linearity: allocations per token on an input repeated 4× may not exceed the single copy's by
//     more than LINEAR_TOL (JS/TS) — work per token must not grow with the input. Go bytes per token
//     may vary within GEOMETRIC_TOL (slices grow geometrically).
//   • The report: `--write` rewrites docs/ALLOCATIONS.md. The gate does NOT compare against it: an
//     exact record made every landing that moved one allocation re-record (21 landings did, none
//     of them on purpose), while a change in what a parse allocates is judged from the profile
//     job's allocator counters (docs/MEASUREMENT.md).
// A measured `heapUsed` delta of the uninstrumented parser (young generation large enough that no
// GC runs inside the parse) is printed beside the model as a cross-check, never recorded.
// Inputs: files of the locked npm packages (present in every CI job after `npm ci`), not repo
// sources that move with the grammar. Missing go → its section says NOT RUN (and the gate fails
// only on what ran).
//
//   node test/alloc-work.ts [--write]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser } from '../src/target.ts';
import { jsTarget } from '../src/emit-parser.ts';
import { tsTarget } from '../src/target-ts.ts';
import { goTarget } from '../src/target-go.ts';
import { instrument, type SiteInfo } from './alloc-instrument.ts';
import { scratchDir } from './scratch.ts';
import { cachedGoBuild } from './build-cache.ts';

const WRITE = process.argv.includes('--write');
const HEAP_CHILD = process.argv.indexOf('--heap-child');
const RECORD = new URL('../docs/ALLOCATIONS.md', import.meta.url);
// Bytes of an arena-backed parse (Go, the JS target's document) grow geometrically, so its bytes per
// token move with where the input falls between two growths: GEOMETRIC_TOL. Counts stay within LINEAR_TOL.
const LINEAR_TOL = 0.01, GEOMETRIC_TOL = 0.5;
const TOP_SITES = 15;

const nm = (p: string) => readFileSync(new URL('../node_modules/' + p, import.meta.url), 'utf8');
const TSSERVER = nm('tsc-oracle/lib/_tsserver.js');
const INPUTS: Record<string, string> = {
  'acorn.js': nm('acorn/dist/acorn.js'),
  'lib.es5.d.ts': nm('tsc-oracle/lib/lib.es5.d.ts'),
  '_tsserver.js': TSSERVER,
  '_tsserver.js ×4': (TSSERVER + '\n').repeat(4),
};
const GRAMMAR_INPUTS: Record<string, string[]> = {
  typescript: ['acorn.js', 'lib.es5.d.ts', '_tsserver.js', '_tsserver.js ×4'],
  javascript: ['acorn.js', '_tsserver.js', '_tsserver.js ×4'],
};
const LINEAR: [string, string][] = [['_tsserver.js', '_tsserver.js ×4']];
const SITES_FOR = 'acorn.js'; // the input whose per-site table is recorded
const pkgVersion = (p: string) => JSON.parse(nm(p + '/package.json')).version as string;

type SiteRow = { kind: string; type: string; text: string; fns: number; n: number; bytes: number; inResult: number };
type Measure = { target: string; grammar: string; input: string; mode: string; bytes: number; tokens: number; nodes: number;
  allocs: number; allocBytes: number; resultAllocs: number | null; resultBytes: number | null; sites: SiteRow[] };

// ── the heap cross-check child: one uninstrumented parse per input, used_heap_size delta ──
if (HEAP_CHILD >= 0) {
  const [file, target, ...inputs] = process.argv.slice(HEAP_CHILD + 1);
  const { getHeapStatistics } = await import('node:v8');
  const { PerformanceObserver } = await import('node:perf_hooks');
  const m = await import(file!);
  let gcs = 0;
  new PerformanceObserver((l) => { gcs += l.getEntries().length; }).observe({ entryTypes: ['gc'] });
  const gc = (globalThis as any).gc as () => void;
  const tick = () => new Promise((r) => setTimeout(r, 50));
  const p = target === 'js' ? m.createParser() : null;
  const once = (src: string) => (target === 'js' ? p.parse(src) : m.parse(src));
  for (const name of inputs) {
    const src = INPUTS[name]!;
    // Ten warm parses: compiled and optimized code, feedback vectors and lazy tables are not per parse.
    for (let i = 0; i < 10; i++) once(src);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      gc(); await tick();
      const g0 = gcs, u0 = getHeapStatistics().used_heap_size;
      const r = once(src);
      const u1 = getHeapStatistics().used_heap_size;
      (globalThis as any).sink = r;
      await tick();
      if (gcs === g0 && u1 >= u0) seen.push(u1 - u0);
      (globalThis as any).sink = null;
    }
    console.log(`${name}\t${seen.length ? Math.min(...seen) : -1}`);
  }
  process.exit(0);
}

// The Go helper (package parser) and driver: one warm ParseWith, then the measured one with the
// collector off; MemStats deltas, and the heap profile (MemProfileRate = 1, every allocation)
// before and after, by the innermost function of the parser package on each allocation's stack.
const GO_HELPER = `package parser

import (
	"runtime"
	"runtime/debug"
	"strings"
	"unsafe"
)

type AllocOut struct {
	Ok          bool
	Tokens      int
	Nodes       int
	Mallocs     uint64
	TotalAlloc  uint64
	ResultBytes uint64
	Sites       map[string][2]int64
}

func profileBySite() map[string][2]int64 {
	runtime.GC()
	runtime.GC()
	n, _ := runtime.MemProfile(nil, true)
	var rs []runtime.MemProfileRecord
	for {
		rs = make([]runtime.MemProfileRecord, n+64)
		m, ok := runtime.MemProfile(rs, true)
		if ok {
			rs = rs[:m]
			break
		}
		n = m
	}
	out := map[string][2]int64{}
	for _, r := range rs {
		fr := runtime.CallersFrames(r.Stack())
		key := ""
		for {
			f, more := fr.Next()
			if i := strings.Index(f.Function, "/parser."); i >= 0 {
				key = f.Function[i+len("/parser."):]
				break
			}
			if !more {
				break
			}
		}
		if key == "" || strings.HasPrefix(key, "profileBySite") || strings.HasPrefix(key, "MeasureAllocs") {
			continue // the measurement's own allocations
		}
		v := out[key]
		out[key] = [2]int64{v[0] + r.AllocObjects, v[1] + r.AllocBytes}
	}
	return out
}

// MeasureAllocs: mode fresh = a new CstBuilder after a first parse; reuse = the CstBuilder of a first
// parse (the native engine); slim-reuse = the SlimBuilder of a first parse (the builder engine
// behind the Builder interface).
func MeasureAllocs(src string, mode string) AllocOut {
	var b Builder = &CstBuilder{}
	if mode == "slim-reuse" {
		b = &SlimBuilder{}
	}
	ParseWith(src, b)
	if mode == "fresh" {
		b = &CstBuilder{}
	}
	// One P while measuring. An allocation under 16 B without pointers goes to its P's current
	// 16 B tiny block, and the heap profile records a block, not each allocation in it. With
	// several Ps a parse preempted on one P can resume on another, whose block is filled to another
	// offset, so whether one allocation opens a block varied between runs (go fresh _tsserver.js:
	// 60 or 61 allocations, 5 runs in 40). With one P the parse's tiny allocations fill blocks in
	// its own order from the empty block ReadMemStats leaves (it flushes every P's cache).
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(1))
	old := debug.SetGCPercent(-1)
	defer debug.SetGCPercent(old)
	before := profileBySite()
	var m0, m1 runtime.MemStats
	runtime.ReadMemStats(&m0)
	_, ok := ParseWith(src, b)
	runtime.ReadMemStats(&m1)
	after := profileBySite()
	sites := map[string][2]int64{}
	for k, v := range after {
		d := [2]int64{v[0] - before[k][0], v[1] - before[k][1]}
		if d[0] != 0 || d[1] != 0 {
			sites[k] = d
		}
	}
	var nodes []Node
	var kids []int32
	var toks []Tok
	switch x := b.(type) {
	case *CstBuilder:
		nodes, kids, toks = x.Nodes, x.Kids, x.Toks
	case *SlimBuilder:
		nodes, kids, toks = x.Nodes, x.Kids, x.Toks
	}
	res := uint64(cap(nodes))*uint64(unsafe.Sizeof(Node{})) + uint64(cap(kids))*4 + uint64(cap(toks))*uint64(unsafe.Sizeof(Tok{}))
	return AllocOut{ok, len(toks), len(nodes), m1.Mallocs - m0.Mallocs, m1.TotalAlloc - m0.TotalAlloc, res, sites}
}
`;
const GO_MAIN = `package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sort"

	"consumer/parser"
)

func main() {
	runtime.MemProfileRate = 1
	for i, f := range os.Args[1:] {
		b, err := os.ReadFile(f)
		if err != nil {
			panic(err)
		}
		for _, mode := range []string{"fresh", "reuse", "slim-reuse"} {
			o := parser.MeasureAllocs(string(b), mode)
			type site struct {
				Fn      string \`json:"fn"\`
				Objects int64  \`json:"objects"\`
				Bytes   int64  \`json:"bytes"\`
			}
			var ss []site
			for k, v := range o.Sites {
				ss = append(ss, site{k, v[0], v[1]})
			}
			sort.Slice(ss, func(a, b int) bool { return ss[a].Fn < ss[b].Fn })
			line, _ := json.Marshal(map[string]any{"file": i, "mode": mode, "ok": o.Ok, "tokens": o.Tokens, "nodes": o.Nodes,
				"mallocs": o.Mallocs, "totalAlloc": o.TotalAlloc, "resultBytes": o.ResultBytes, "sites": ss})
			fmt.Println(string(line))
		}
	}
}
`;

const dir = scratchDir('alloc-work');
const grammars: Record<string, any> = {
  typescript: (await import('../typescript.ts')).default,
  javascript: (await import('../javascript.ts')).default,
};
const measures: Measure[] = [];
const notRun: string[] = [];
const crossCheck: string[] = [];
const have = (cmd: string, arg: string) => { try { execFileSync(cmd, [arg], { stdio: 'pipe' }); return true; } catch { return false; } };

// ── TS target and emitted JS parser: instrumented counts ──
type Alloc = { on: boolean; counts: Map<string, { n: number; bytes: number }>; site: WeakMap<object, number> };
const st: Alloc = { on: false, counts: new Map(), site: new WeakMap() };
(globalThis as any).__alloc = st;

function rows(sites: SiteInfo[], inResult: Map<number, number>): SiteRow[] {
  return [...st.counts].map(([k, v]) => {
    const [id, type] = k.split('\t');
    const s = sites[+id!]!;
    return { kind: s.kind, type: type!, text: s.text, fns: s.fns.size, n: v.n, bytes: v.bytes, inResult: inResult.get(+id!) ?? 0 };
  });
}

for (const target of ['ts', 'js'] as const) for (const [gname, g] of Object.entries(grammars)) {
  const plain = emitParser(g, target === 'ts' ? tsTarget : jsTarget);
  const { code, sites } = instrument(plain, `${target}-${gname}.ts`);
  const file = join(dir, `${target}-${gname}.mjs`);
  writeFileSync(file, code);
  const m = await import(file);
  const modes = target === 'ts' ? ['parse', 'parseWith'] : ['fresh', 'reuse'];
  for (const input of GRAMMAR_INPUTS[gname]!) {
    const src = INPUTS[input]!;
    const tokens = m.tokenize(src).length;
    for (const mode of modes) {
      const once = () => {
        if (target === 'ts') return mode === 'parse' ? m.parse(src) : m.parseWith(src, m.cstBuilder);
        return mode === 'fresh' ? m.createParser().parse(src) : m.parse(src); // reuse: the module's one document
      };
      // One warm parse first: what a module builds once (lazy tables) is not per parse.
      if (once() === null) throw new Error(`${target} ${gname} rejects ${input}`);
      st.counts = new Map(); st.site = new WeakMap();
      st.on = true;
      const r = once();
      st.on = false;
      let nodes = 0, resultAllocs: number | null = null, resultBytes: number | null = null;
      const inResult = new Map<number, number>();
      if (target === 'ts') {
        // Trace the returned tree back to its sites: nodes, their children arrays, leaves.
        const stack: any[] = [r];
        while (stack.length) {
          const x = stack.pop();
          const id = st.site.get(x);
          if (id !== undefined) inResult.set(id, (inResult.get(id) ?? 0) + 1);
          if (x.children) {
            nodes++;
            const cid = st.site.get(x.children);
            if (cid !== undefined) inResult.set(cid, (inResult.get(cid) ?? 0) + 1);
            for (const c of x.children) stack.push(c);
          }
        }
      } else { m.parse(src); nodes = m.__arenaStats().nodeN; }
      const rs = rows(sites, inResult);
      if (target === 'ts') {
        resultAllocs = rs.reduce((a, s) => a + s.inResult, 0);
        // A site's objects are one shape, so its result bytes are its share of its bytes.
        resultBytes = rs.reduce((a, s) => a + (s.n ? Math.round((s.bytes * s.inResult) / s.n) : 0), 0);
      }
      measures.push({ target, grammar: gname, input, mode, bytes: Buffer.byteLength(src), tokens, nodes,
        allocs: rs.reduce((a, s) => a + s.n, 0), allocBytes: rs.reduce((a, s) => a + s.bytes, 0), resultAllocs, resultBytes, sites: rs });
    }
  }
  // Cross-check, typescript grammar only: the uninstrumented module's measured heap growth per parse.
  if (gname === 'typescript') {
    const pfile = join(dir, `${target}-${gname}-plain.mts`);
    writeFileSync(pfile, plain);
    try {
      const out = execFileSync(process.execPath, ['--expose-gc', '--max-semi-space-size=256', new URL(import.meta.url).pathname, '--heap-child', pfile, target, ...GRAMMAR_INPUTS[gname]!], { encoding: 'utf8', maxBuffer: 1 << 24 });
      for (const line of out.trim().split('\n')) {
        const [input, used] = line.split('\t');
        const mm = measures.find((x) => x.target === target && x.grammar === gname && x.input === input && x.mode === (target === 'ts' ? 'parse' : 'reuse'))!;
        crossCheck.push(`${target} ${gname} ${input} (${mm.mode}): modeled ${fmt(mm.allocBytes)} B, measured heapUsed growth ${+used! < 0 ? 'n/a (a GC ran in every try)' : fmt(+used!) + ' B'}`);
      }
    } catch (e: any) { crossCheck.push(`${target}: heap cross-check failed: ${String(e.message).split('\n')[0]}`); }
  }
}

// ── Go target ──
// The Go rows' attribution to functions is a function of the source AND the toolchain (the same
// commit attributed one 16 B slice growth to (*engine).matchLit under go1.27.4 and to
// (*engine).finish under go1.26.11), the totals equal: the report names the toolchain it was made
// with. The invariants hold under any toolchain.
let goVersion = '';
if (!have('go', 'version')) notRun.push('go: toolchain not found');
else {
  goVersion = execFileSync('go', ['version'], { encoding: 'utf8' }).trim().split(' ')[2]!;
  for (const [gname, g] of Object.entries(grammars)) {
    const gdir = join(dir, 'go-' + gname);
    mkdirSync(join(gdir, 'parser'), { recursive: true });
    writeFileSync(join(gdir, 'go.mod'), 'module consumer\n\ngo 1.21\n');
    writeFileSync(join(gdir, 'parser', 'parser.go'), emitParser(g, goTarget));
    writeFileSync(join(gdir, 'parser', 'allocwork.go'), GO_HELPER);
    writeFileSync(join(gdir, 'main.go'), GO_MAIN);
    cachedGoBuild(['-o', 'consumer', '.'], { cwd: gdir });
    const files = GRAMMAR_INPUTS[gname]!.map((input, i) => { const f = join(gdir, `in${i}.txt`); writeFileSync(f, INPUTS[input]!); return f; });
    const out = execFileSync(join(gdir, 'consumer'), files, { encoding: 'utf8', maxBuffer: 1 << 26 });
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    GRAMMAR_INPUTS[gname]!.forEach((input, i) => {
      for (const mode of ['fresh', 'reuse', 'slim-reuse']) {
        const o = lines.find((x: any) => x.file === i && x.mode === mode);
        if (!o) { notRun.push(`go ${gname} ${input} ${mode}: no output`); continue; }
        if (!o.ok) throw new Error(`go ${gname} rejects ${input}`);
        const result = mode === 'fresh' ? o.resultBytes : 0;
        const sites: SiteRow[] = ((o.sites ?? []) as any[]).map((s) => ({ kind: 'heap', type: 'Go', text: s.fn, fns: 1, n: s.objects, bytes: s.bytes, inResult: 0 }));
        // The record counts what the heap profile attributes to the parser's own code (every
        // allocation, MemProfileRate = 1). MemStats counts the whole process: a difference is the
        // runtime's (seen once on a reused builder: 6 allocations, 5,320 B, not reproduced), printed only.
        const allocs = sites.reduce((a, s) => a + s.n, 0), allocBytes = sites.reduce((a, s) => a + s.bytes, 0);
        if (allocs !== o.mallocs || allocBytes !== o.totalAlloc) crossCheck.push(`go ${gname} ${input} ${mode}: MemStats ${o.mallocs} allocations / ${o.totalAlloc} B, the parser's own (heap profile) ${allocs} / ${allocBytes} B`);
        measures.push({ target: 'go', grammar: gname, input, mode, bytes: Buffer.byteLength(INPUTS[input]!), tokens: o.tokens, nodes: o.nodes,
          allocs, allocBytes, resultAllocs: mode === 'fresh' ? 3 : 0, resultBytes: result, sites });
      }
    });
  }
}

// ── checks ──
let ok = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};
for (const [small, big] of LINEAR) for (const a of measures.filter((x) => x.input === small)) {
  const b = measures.find((x) => x.target === a.target && x.grammar === a.grammar && x.mode === a.mode && x.input === big)!;
  const label = `${a.target} ${a.grammar} ${a.mode}: per token on ${big} vs ${small}`;
  if (a.target === 'go') {
    const ra = a.allocBytes / a.tokens, rb = b.allocBytes / b.tokens;
    check(`${label}: bytes within ${GEOMETRIC_TOL * 100}%`, a.allocBytes === 0 ? b.allocBytes === 0 : rb <= ra * (1 + GEOMETRIC_TOL), `${ra.toFixed(1)} → ${rb.toFixed(1)} B per token`);
    check(`${label}: allocations not up`, b.allocs / b.tokens <= a.allocs / a.tokens || b.allocs === a.allocs, `${a.allocs} → ${b.allocs}`);
  } else {
    const ra = a.allocs / a.tokens, rb = b.allocs / b.tokens;
    check(`${label}: allocations within ${LINEAR_TOL * 100}%`, rb <= ra * (1 + LINEAR_TOL), `${ra.toFixed(3)} → ${rb.toFixed(3)} per token`);
    const ba = a.allocBytes / a.tokens, bb = b.allocBytes / b.tokens, tol = a.target === 'js' ? GEOMETRIC_TOL : LINEAR_TOL;
    check(`${label}: modeled bytes within ${tol * 100}%`, bb <= ba * (1 + tol), `${ba.toFixed(1)} → ${bb.toFixed(1)} B per token`);
  }
}
for (const x of measures.filter((x) => x.target === 'go' && (x.mode === 'reuse' || x.mode === 'slim-reuse')))
  check(`go ${x.grammar} ${x.input} ${x.mode}: a reused builder allocates nothing`, x.allocs === 0 && x.allocBytes === 0, `${x.allocs} allocations, ${x.allocBytes} B`);

// ── the record ──
function fmt(x: number): string { return Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '-'; }
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const md: string[] = [];
const say = (s = '') => md.push(s);
say('# ALLOCATIONS: what one parse allocates, per target (auto-generated)');
say();
say('<!-- AUTO-GENERATED by `node test/alloc-work.ts --write`. Do not edit by hand. -->');
say();
say('A REPORT, not a gate: `node test/alloc-work.ts --write` writes it and the README auto-regen workflow');
say('(.github/workflows/readme-bench.yml) rewrites it on master. The gate `alloc-work` checks only the invariants');
say('(per-token counts do not grow with the input; a reused Go builder allocates nothing). The counts are exact:');
say('TS target and emitted JS parser by instrumentation of the emitted module (test/alloc-instrument.ts), Go by');
say('`runtime.MemStats` with the collector off. Bytes: Go exact (`TotalAlloc`); TS / JS modeled from V8\'s layout');
say('(pointer compression; the model is in test/alloc-instrument.ts; the gate prints a measured `heapUsed` delta');
say('beside it). One warm parse runs before the measured one; what a module builds once is not counted.');
say();
say(`Go rows measured with ${goVersion}. Which function an allocation is attributed to depends on the toolchain (one`);
say('commit: a 16 B slice growth in `(*engine).matchLit` under go1.27.4, in `(*engine).finish` under go1.26.11), so the');
say('rows hold for this toolchain only.');
say();
say(`Inputs (locked npm packages): \`acorn@${pkgVersion('acorn')}\` \`dist/acorn.js\`, \`typescript@${pkgVersion('tsc-oracle')}\` \`lib/lib.es5.d.ts\` and \`lib/_tsserver.js\` (also repeated 4×: per-token counts must not grow with size).`);
say();
say('Modes. TS target: `parse(src)` and `parseWith(src, cstBuilder)`: one engine, run with the CST builder; `parse` adds no step of its own.');
say('JS target: `fresh` = a new `createParser()` per parse, `reuse` = one parser, its document reused. Go: `fresh` = a new');
say('`CstBuilder` per `ParseWith`, `reuse` = one kept. RESULT = what the returned tree holds (TS: objects reachable from');
say('it; Go fresh: the final capacity of `Nodes` / `Kids` / `Toks`); OVERHEAD = everything else, garbage once the parse');
say('returns. Tokens: each target\'s own `tokenize` count. Nodes: rule nodes of the result (JS, Go: the arena\'s node count).');
say();
say('## Per parse');
say();
say('| target | grammar | input | mode | tokens | nodes | allocations | per token | per node | bytes | B per token | B per node | result allocs | result bytes | overhead bytes |');
say('|:--|:--|:--|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
for (const x of measures) {
  say(`| ${x.target} | ${x.grammar} | ${x.input} | ${x.mode} | ${fmt(x.tokens)} | ${fmt(x.nodes)} | ${fmt(x.allocs)} | ${f2(x.allocs / x.tokens)} | ${f2(x.allocs / x.nodes)} | ${fmt(x.allocBytes)} | ${f1(x.allocBytes / x.tokens)} | ${f1(x.allocBytes / x.nodes)} | ${x.resultAllocs === null ? '-' : fmt(x.resultAllocs)} | ${x.resultBytes === null ? '-' : fmt(x.resultBytes)} | ${x.resultBytes === null ? '-' : fmt(x.allocBytes - x.resultBytes)} |`);
}
say();
// The per-site tables: the recorded input under the typescript grammar, and any Go parse with a
// reused builder that allocates (it should allocate nothing).
for (const x of measures.filter((x) => (x.input === SITES_FOR && x.grammar === 'typescript') || (x.target === 'go' && x.mode !== 'fresh' && x.allocs > 0))) {
  const sorted = [...x.sites].sort((a, b) => b.bytes - a.bytes || b.n - a.n || a.text.localeCompare(b.text));
  say(`## Where: ${x.target} target, ${x.mode}, ${x.grammar} grammar, ${x.input} (top ${Math.min(TOP_SITES, sorted.length)} of ${sorted.length} sites by bytes)`);
  say();
  if (x.target === 'go') {
    say('| site (innermost function in the parser package) | allocations | bytes | share |');
    say('|:--|--:|--:|--:|');
    for (const s of sorted.slice(0, TOP_SITES)) say(`| \`${s.text}\` | ${fmt(s.n)} | ${fmt(s.bytes)} | ${f1((100 * s.bytes) / x.allocBytes)}% |`);
  } else {
    say('| kind | site (literals folded) | in functions | allocations | per token | modeled bytes | share | in result |');
    say('|:--|:--|--:|--:|--:|--:|--:|--:|');
    for (const s of sorted.slice(0, TOP_SITES)) {
      const kind = s.kind === s.type ? s.kind : `${s.kind} → ${s.type}`;
      say(`| ${kind} | \`${s.text.replace(/\|/g, '\\|').replace(/`/g, "'")}\` | ${s.fns} | ${fmt(s.n)} | ${f2(s.n / x.tokens)} | ${fmt(s.bytes)} | ${f1((100 * s.bytes) / x.allocBytes)}% | ${x.target === 'ts' ? fmt(s.inResult) : '-'} |`);
    }
  }
  say();
}
const text = md.join('\n');

for (const c of crossCheck) console.log('  cross-check: ' + c);
if (goVersion) console.log(`  go: ${goVersion}`);
for (const n of notRun) console.log(`  NOT RUN: ${n}`);
// A report with a target missing is not written (the auto-regen job would commit a partial table).
if (WRITE && notRun.length === 0) { writeFileSync(RECORD, text); console.log('  wrote docs/ALLOCATIONS.md'); }
else if (WRITE) console.log('  docs/ALLOCATIONS.md NOT written: a target did not run');
console.log(`alloc-work: ${measures.length} measurements, targets ${[...new Set(measures.map((x) => x.target))].join(' / ')}`);
console.log(`\n${ok} ok, ${fail} failed${notRun.length ? `, NOT RUN: ${notRun.join('; ')}` : ''}`);
process.exit(fail === 0 && notRun.length === 0 ? 0 : 1);
