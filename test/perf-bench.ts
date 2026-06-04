// ─────────────────────────────────────────────────────────────────────────────
//  perf-bench.ts — tokenization WALL-TIME & catastrophic-backtracking probe.
//
//  Monogram's TextMate grammar is GENERATED. Its regexes (balanced-angle `\g<B>`
//  recursion, the arrow/generic disambiguation lookaheads, the comparison-vs-type
//  `<…>` patterns) are correctness-driven and have never been measured for speed.
//  Hand-written grammars like the official one are battle-tested against pathological
//  input; a generated one can hide an exponential-backtracking landmine in a regex
//  that only a degenerate line ever steps on. This bench is the measure-first probe:
//  it tokenizes large realistic files AND adversarial degenerate lines, times each,
//  ranks them slowest-first, and FLAGS any input whose cost looks super-linear —
//  naming the construct so the landmine can be found before a real file hits it.
//
//  It is self-contained and READ-ONLY w.r.t. the grammar: it loads
//  typescript.tmLanguage.json and tokenizes, nothing else.
//
//  Run:
//    node test/perf-bench.ts                         # Monogram only
//    MONOGRAM_OFFICIAL_TM=/path/to/TypeScript.tmLanguage.json node test/perf-bench.ts
//                                                     # + official grammar, side by side
//
//  Gate: exits 1 if ANY input exceeds HARD_CEILING_MS (a single line/file should
//  never take seconds); else prints a verdict and exits 0.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;

// ── thresholds ────────────────────────────────────────────────────────────────
const HARD_CEILING_MS = 2000;   // any single input above this ⇒ FAIL (exit 1)
const SHORT_LINE_CHARS = 400;   // "a short line" — degenerate lines live well under this
const SHORT_LINE_SLOW_MS = 50;  // a short line over this is a backtracking smell
const OUTLIER_FACTOR = 8;       // chars/ms this far below the median ⇒ flagged outlier
const WARMUP_RUNS = 1;          // JIT warmup before the timed runs
const TIMED_RUNS = 3;           // best-of-N (min) — least noisy estimate of true cost

// ── grammar paths ──────────────────────────────────────────────────────────────
const MONOGRAM_PATH = 'typescript.tmLanguage.json';
const OFFICIAL_PATH = process.env.MONOGRAM_OFFICIAL_TM; // opt-in side-by-side

// ── TextMate grammar loading (oniguruma + Registry; copied from the scope-gap bench)
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

function makeRegistry(scopeName: string, content: string): vsctm.Registry {
  return new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
      createOnigString: (s: string) => new OnigString(s),
    }),
    loadGrammar: async (sn: string) => (sn === scopeName ? parseRawGrammar(content, 'g.json') : null),
  });
}

if (!existsSync(MONOGRAM_PATH)) {
  console.error(`Monogram grammar not found at ${MONOGRAM_PATH}. Run: node src/cli.ts typescript.ts`);
  process.exit(1);
}
const monogramGrammar = await makeRegistry('source.ts', readFileSync(MONOGRAM_PATH, 'utf-8')).loadGrammar('source.ts');
if (!monogramGrammar) throw new Error('failed to load Monogram grammar');

let officialGrammar: vsctm.IGrammar | null = null;
if (OFFICIAL_PATH) {
  if (!existsSync(OFFICIAL_PATH)) {
    console.error(`MONOGRAM_OFFICIAL_TM set but file not found:\n  ${OFFICIAL_PATH}`);
    process.exit(1);
  }
  officialGrammar = await makeRegistry('source.ts', readFileSync(OFFICIAL_PATH, 'utf-8')).loadGrammar('source.ts');
  if (!officialGrammar) throw new Error('failed to load official grammar');
}

// ── tokenize line by line (same shape as the scope-gap bench's tmTokenize) ───────────
// Returns total token count so the work can't be optimized away and so we can sanity
// the grammar actually ran. Carries the rule stack across lines, exactly like an editor.
function tokenizeAll(grammar: vsctm.IGrammar, text: string): number {
  const lines = text.split('\n');
  let ruleStack = INITIAL;
  let nTokens = 0;
  for (let i = 0; i < lines.length; i++) {
    const r = grammar.tokenizeLine(lines[i], ruleStack);
    nTokens += r.tokens.length;
    ruleStack = r.ruleStack;
  }
  return nTokens;
}

// best-of-N wall time (ms) after a warmup. min() = the run least perturbed by GC/noise,
// the standard way to estimate a deterministic operation's true cost.
function timeTokenize(grammar: vsctm.IGrammar, text: string): { ms: number; tokens: number } {
  let tokens = 0;
  for (let i = 0; i < WARMUP_RUNS; i++) tokens = tokenizeAll(grammar, text);
  let best = Infinity;
  for (let i = 0; i < TIMED_RUNS; i++) {
    const t0 = performance.now();
    tokens = tokenizeAll(grammar, text);
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return { ms: best, tokens };
}

// ── input corpora ────────────────────────────────────────────────────────────────
interface Input { name: string; klass: 'large' | 'patho'; text: string; note: string }

// (a) LARGE realistic — synthesize a multi-thousand-line file out of representative
// constructs (classes/generics/imports/arrow chains/object literals), then read a few
// of the biggest real conformance files if present.
const SYNTH_BLOCKS = [
  // a class with generics, members, methods, access chains, async, casts
  `export class Widget$I<T extends Record<string, unknown>, U = T[keyof T]> extends Base$I<T> implements IFoo, IBar<U> {
  private readonly id: number = $I;
  static count: Map<string, Array<{ k: string; v: U }>> = new Map();
  constructor(public name: string, protected items: ReadonlyArray<T> = []) { super(name); }
  get first(): U | undefined { return this.items[0]?.value as U; }
  async load$I(opts: { retries?: number; signal?: AbortSignal }): Promise<Result<T, Error>> {
    const xs = this.items.filter((x) => x != null).map((x) => ({ ...x, seen: true }));
    return xs.length ? { ok: true, value: xs[0] as unknown as T } : { ok: false, error: new Error('empty') };
  }
}`,
  // imports / exports
  `import { type A$I, B$I, C$I as D$I } from './module-$I';
import * as ns$I from '../lib/ns-$I';
export { B$I };
export type { A$I };
export default function make$I(): A$I { return null as unknown as A$I; }`,
  // arrow chains, object literals, generics in calls, mapped types
  `const pipe$I = <X, Y, Z>(f: (x: X) => Y, g: (y: Y) => Z) => (x: X): Z => g(f(x));
const cfg$I = { host: 'localhost', port: 80 + $I, nested: { a: [1, 2, 3], b: { c: { d: true } } }, fn: (a: number, b: number) => a + b };
const result$I = items.map((i) => i * 2).filter((i) => i > $I).reduce((a, b) => a + b, 0);
type Mapped$I<T> = { [K in keyof T]: T[K] extends Function ? never : T[K] };`,
  // interfaces, unions, conditional types, switch
  `interface Shape$I<T = unknown> { kind: 'a' | 'b' | 'c'; data: T; meta?: Record<string, number>; }
type Deep$I<T> = T extends Array<infer E> ? Deep$I<E> : T extends object ? { [K in keyof T]: Deep$I<T[K]> } : T;
function handle$I(s: Shape$I): string { switch (s.kind) { case 'a': return 'A'; case 'b': return 'B'; default: return 'C'; } }`,
];

function synthLarge(targetLines: number): string {
  const out: string[] = [];
  let lines = 0;
  let i = 0;
  while (lines < targetLines) {
    const block = SYNTH_BLOCKS[i % SYNTH_BLOCKS.length].replace(/\$I/g, String(i));
    out.push(block, '');
    lines += block.split('\n').length + 1;
    i++;
  }
  return out.join('\n');
}

// (b) PATHOLOGICAL stress — each targets a specific backtracking hot spot. Kept to a
// SINGLE line (or few) so a large time = super-linear cost on a tiny input = a smell.
const NESTED = 40;
const CHAIN = 500;

function pathoInputs(): Input[] {
  const list: Input[] = [];

  // deeply nested generics: balanced-angle recursion stress
  list.push({
    name: `nested-generics ×${NESTED}`,
    klass: 'patho',
    note: 'Array<Array<…>> 40 deep — exercises the balanced-angle \\g<B> recursion',
    text: `type T = ${'Array<'.repeat(NESTED)}number${'>'.repeat(NESTED)};`,
  });

  // nested generics with no value/closer — forces the matcher to explore the whole
  // nest before failing the type position (worst case for angle backtracking)
  list.push({
    name: `nested-generics open ×${NESTED}`,
    klass: 'patho',
    note: 'open Array<Array<… with no value — worst case for angle backtracking',
    text: `const x: ${'Array<'.repeat(NESTED)}`,
  });

  // long binary-operator chain
  list.push({
    name: `binary-op chain ×${CHAIN}`,
    klass: 'patho',
    note: 'a + b + c + … 500 terms — operator-led repetition',
    text: `const n = ${Array.from({ length: CHAIN }, (_, i) => `a${i}`).join(' + ')};`,
  });

  // long relational/mixed-operator chain (the <…> comparison/type ambiguity zone)
  const relTerms = Array.from({ length: CHAIN }, (_, i) => `a${i}`);
  const relExpr = relTerms.map((t, i) => (i === 0 ? t : (i % 2 ? ' > ' : ' < ') + t)).join('');
  list.push({
    name: `mixed relational chain ×${CHAIN}`,
    klass: 'patho',
    note: 'a < b > c < d … relational operators — the <…> comparison/type ambiguity',
    text: `const b = ${relExpr};`,
  });

  // long run of bare < and > — the arrow/generic/comparison ambiguity hot spot
  const angles = Array.from({ length: CHAIN }, (_, i) => (i % 2 ? '>' : '<')).join(' ');
  list.push({
    name: `bare angle run ×${CHAIN}`,
    klass: 'patho',
    note: 'long run of < > < > … — the arrow/generic/comparison disambiguation hot spot',
    text: `x ${angles} y;`,
  });

  // a run of <T< openers — looks like the start of many nested generic params,
  // each forcing the arrow/generic lookahead to fire
  const opens = Array.from({ length: NESTED }, (_, i) => `<T${i}`).join('');
  list.push({
    name: `generic-param open run ×${NESTED}`,
    klass: 'patho',
    note: 'f<T0<T1<… — repeated generic-argument lookahead with no closer',
    text: `foo${opens}(a, b);`,
  });

  // very long single-line string literal (with escapes)
  list.push({
    name: 'long string literal',
    klass: 'patho',
    note: 'one ~20k-char string with escapes — string scanning / escape lookahead',
    text: `const s = "${'abc def ghi \\t \\n \\u0041 \\\\ '.repeat(700)}";`,
  });

  // very long template literal with many interpolations
  const interps = Array.from({ length: 300 }, (_, i) => `\${a${i} + b${i}}`).join(' x ');
  list.push({
    name: 'long template literal ×300 interp',
    klass: 'patho',
    note: 'template with 300 ${…} holes — template-substitution re-entry',
    text: 'const t = `' + interps + '`;',
  });

  // deeply nested parens
  list.push({
    name: `nested parens ×${CHAIN}`,
    klass: 'patho',
    note: '(((…))) 500 deep — paren grouping / arrow-vs-paren lookahead',
    text: `const p = ${'('.repeat(CHAIN)}1${')'.repeat(CHAIN)};`,
  });

  // deeply nested array/index brackets
  list.push({
    name: `nested brackets ×${CHAIN}`,
    klass: 'patho',
    note: '[[[…]]] 500 deep — array literal / index nesting',
    text: `const arr = ${'['.repeat(CHAIN)}1${']'.repeat(CHAIN)};`,
  });

  // deeply nested object literals
  const objOpen = Array.from({ length: NESTED }, (_, i) => `{ k${i}: `).join('');
  const objClose = ' }'.repeat(NESTED);
  list.push({
    name: `nested object literal ×${NESTED}`,
    klass: 'patho',
    note: '{ k: { k: … } } 40 deep — object-literal property re-entry',
    text: `const o = ${objOpen}1${objClose};`,
  });

  // long single-line regex literal (alternations + classes + quantifiers)
  const reBody = Array.from({ length: 200 }, (_, i) => `(a${i}|b${i})[0-9]+`).join('|');
  list.push({
    name: 'long regex literal',
    klass: 'patho',
    note: 'one long /…/ literal with 200 alternations — regex-context scanning',
    text: `const re = /${reBody}/g;`,
  });

  // arrow disambiguation: many parenthesized things that could be params or exprs
  const arrowish = Array.from({ length: 200 }, (_, i) => `(a${i}: number, b${i}: string) => a${i}`).join(', ');
  list.push({
    name: 'arrow-vs-paren ambiguity ×200',
    klass: 'patho',
    note: 'long list of (x: T, y: U) => … — the arrow-parameter lookahead, repeated',
    text: `const fns = [${arrowish}];`,
  });

  // near-pathological MIX: nested generics + relational chain + template-with-<>, one line
  const mix = `type M = Array<Map<string, ${'Array<'.repeat(15)}number${'>'.repeat(15)}>>;` +
    ` const q = ${Array.from({ length: 120 }, (_, i) => `a${i}`).join(' < ')};` +
    ' const w = `' + Array.from({ length: 60 }, (_, i) => `\${f${i}(x < y)}`).join('') + '`;';
  list.push({
    name: 'near-pathological MIX',
    klass: 'patho',
    note: 'nested generics + long relational chain + template-with-<> on one line',
    text: mix,
  });

  return list;
}

// ── assemble inputs ──────────────────────────────────────────────────────────────
const inputs: Input[] = [];

// (a) synthesized large files
inputs.push({ name: 'synthesized ~1500-line TS', klass: 'large', note: 'repeated classes/generics/imports/arrows/objects', text: synthLarge(1500) });
inputs.push({ name: 'synthesized ~3000-line TS', klass: 'large', note: 'repeated classes/generics/imports/arrows/objects', text: synthLarge(3000) });

// (a) real files from /tmp/ts-repo, if present (the biggest few)
const REAL_CANDIDATES = [
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/parserRealSource11.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserharness.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/parserRealSource7.ts',
];
let nReal = 0;
for (const p of REAL_CANDIDATES) {
  if (existsSync(p)) {
    try {
      const text = readFileSync(p, 'utf-8');
      inputs.push({ name: `real: ${p.split('/').pop()}`, klass: 'large', note: `real conformance file (${text.split('\n').length} lines)`, text });
      nReal++;
    } catch { /* skip unreadable */ }
  }
}

// (b) pathological stress
inputs.push(...pathoInputs());

// ── measure ──────────────────────────────────────────────────────────────────────
interface Row {
  name: string;
  klass: 'large' | 'patho';
  note: string;
  chars: number;
  lines: number;
  longestLine: number;
  monoMs: number;
  monoTokens: number;
  monoCpms: number; // chars / ms
  offMs?: number;
  offCpms?: number;
}

const rows: Row[] = [];
for (const inp of inputs) {
  const chars = inp.text.length;
  const lineArr = inp.text.split('\n');
  const longestLine = Math.max(...lineArr.map((l) => l.length));
  const m = timeTokenize(monogramGrammar, inp.text);
  const row: Row = {
    name: inp.name,
    klass: inp.klass,
    note: inp.note,
    chars,
    lines: lineArr.length,
    longestLine,
    monoMs: m.ms,
    monoTokens: m.tokens,
    monoCpms: chars / Math.max(m.ms, 1e-6),
  };
  if (officialGrammar) {
    const o = timeTokenize(officialGrammar, inp.text);
    row.offMs = o.ms;
    row.offCpms = chars / Math.max(o.ms, 1e-6);
  }
  rows.push(row);
}

// ── analysis: flag backtracking smells ──────────────────────────────────────────
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const medianCpms = median(rows.map((r) => r.monoCpms));

interface Flag { row: Row; reasons: string[] }
const flags: Flag[] = [];
for (const r of rows) {
  const reasons: string[] = [];
  // a short line that takes a long time = super-linear cost on tiny input
  if (r.longestLine <= SHORT_LINE_CHARS && r.monoMs > SHORT_LINE_SLOW_MS) {
    reasons.push(`short input (${r.longestLine} ch on longest line) took ${r.monoMs.toFixed(1)} ms (> ${SHORT_LINE_SLOW_MS} ms)`);
  }
  // throughput far below the median = anomalously expensive per char
  if (r.monoCpms * OUTLIER_FACTOR < medianCpms) {
    reasons.push(`throughput ${r.monoCpms.toFixed(0)} ch/ms is ${(medianCpms / Math.max(r.monoCpms, 1e-6)).toFixed(0)}× below median (${medianCpms.toFixed(0)} ch/ms)`);
  }
  // absolute ceiling breach
  if (r.monoMs > HARD_CEILING_MS) {
    reasons.push(`EXCEEDS HARD CEILING ${HARD_CEILING_MS} ms`);
  }
  if (reasons.length) flags.push({ row: r, reasons });
}

// ── report (ranked, slowest first) ───────────────────────────────────────────────
const L = '═'.repeat(96);
const fmt = (n: number, w = 9, d = 2) => n.toFixed(d).padStart(w);
const kib = (n: number) => (n / 1024).toFixed(1);

console.log('\n' + L);
console.log('  Monogram TextMate grammar — TOKENIZATION PERFORMANCE & backtracking probe');
console.log(L);
console.log(`  grammar    ${MONOGRAM_PATH}`);
console.log(`  method     best-of-${TIMED_RUNS} (min) after ${WARMUP_RUNS} warmup · performance.now() · line-by-line w/ carried rule stack`);
console.log(`  inputs     ${rows.length} total · ${rows.filter((r) => r.klass === 'large').length} large (${nReal} real from /tmp/ts-repo) · ${rows.filter((r) => r.klass === 'patho').length} pathological`);
console.log(`  thresholds hard-ceiling ${HARD_CEILING_MS} ms · short-line ${SHORT_LINE_CHARS} ch / slow > ${SHORT_LINE_SLOW_MS} ms · outlier ${OUTLIER_FACTOR}× below median`);
if (officialGrammar) console.log(`  official   ${OFFICIAL_PATH}  (side-by-side enabled)`);
console.log(L);

const ranked = [...rows].sort((a, b) => b.monoMs - a.monoMs);

// header
const head = officialGrammar
  ? '  ' + 'input'.padEnd(34) + 'cls'.padEnd(7) + 'KiB'.padStart(8) + 'mono ms'.padStart(11) + 'ch/ms'.padStart(10) + 'off ms'.padStart(11) + 'mono/off'.padStart(10)
  : '  ' + 'input'.padEnd(34) + 'cls'.padEnd(7) + 'KiB'.padStart(8) + 'ms'.padStart(11) + 'ch/ms'.padStart(10) + 'tokens'.padStart(10);
console.log(head);
console.log('  ' + '─'.repeat(94));
for (const r of ranked) {
  const flagged = flags.some((f) => f.row === r) ? ' ⚠' : '';
  if (officialGrammar) {
    const ratio = r.offMs ? r.monoMs / Math.max(r.offMs, 1e-6) : NaN;
    console.log(
      '  ' + r.name.padEnd(34) + r.klass.padEnd(7) +
      kib(r.chars).padStart(8) + fmt(r.monoMs, 11) + fmt(r.monoCpms, 10, 0) +
      fmt(r.offMs ?? 0, 11) + (Number.isFinite(ratio) ? `${ratio.toFixed(2)}×` : '  n/a').padStart(10) + flagged,
    );
  } else {
    console.log(
      '  ' + r.name.padEnd(34) + r.klass.padEnd(7) +
      kib(r.chars).padStart(8) + fmt(r.monoMs, 11) + fmt(r.monoCpms, 10, 0) +
      String(r.monoTokens).padStart(10) + flagged,
    );
  }
}
console.log(L);

// ── backtracking-smell section ───────────────────────────────────────────────────
console.log('\n── backtracking smells (flagged inputs, worst-throughput first) ──');
if (!flags.length) {
  console.log('  none — every input scaled roughly linearly; no catastrophic-backtracking signal.');
} else {
  const flagsRanked = [...flags].sort((a, b) => a.row.monoCpms - b.row.monoCpms);
  for (const f of flagsRanked) {
    console.log(`  ⚠ ${f.row.name}  [${f.row.note}]`);
    console.log(`      ${f.row.monoMs.toFixed(1)} ms · ${f.row.monoCpms.toFixed(0)} ch/ms · longest line ${f.row.longestLine} ch`);
    for (const reason of f.reasons) console.log(`      - ${reason}`);
  }
}

// the single worst input by absolute time (the headline finding)
const worst = ranked[0];
console.log('\n── slowest input overall ──');
console.log(`  «${worst.name}»  ${worst.monoMs.toFixed(1)} ms  (${worst.monoCpms.toFixed(0)} ch/ms, ${kib(worst.chars)} KiB, longest line ${worst.longestLine} ch)`);
console.log(`  construct: ${worst.note}`);

// worst PATHOLOGICAL line specifically (the backtracking landmine candidate)
const worstPatho = ranked.find((r) => r.klass === 'patho');
if (worstPatho) {
  console.log('\n── slowest PATHOLOGICAL line (backtracking-landmine candidate) ──');
  console.log(`  «${worstPatho.name}»  ${worstPatho.monoMs.toFixed(1)} ms  (${worstPatho.monoCpms.toFixed(0)} ch/ms, longest line ${worstPatho.longestLine} ch)`);
  console.log(`  construct: ${worstPatho.note}`);
  if (worstPatho.monoMs <= SHORT_LINE_SLOW_MS) {
    console.log('  → fast; no catastrophic-backtracking landmine detected in the pathological set.');
  }
}

if (officialGrammar) {
  const withRatio = rows.filter((r) => r.offMs !== undefined);
  const ratios = withRatio.map((r) => r.monoMs / Math.max(r.offMs!, 1e-6));
  const slowestVsOff = [...withRatio].sort((a, b) => (b.monoMs / Math.max(b.offMs!, 1e-6)) - (a.monoMs / Math.max(a.offMs!, 1e-6)))[0];
  console.log('\n── Monogram vs official (relative tokenization time) ──');
  console.log(`  median mono/official ratio: ${median(ratios).toFixed(2)}×   (>1 = Monogram slower)`);
  console.log(`  worst relative: «${slowestVsOff.name}» ${(slowestVsOff.monoMs / Math.max(slowestVsOff.offMs!, 1e-6)).toFixed(2)}× (mono ${slowestVsOff.monoMs.toFixed(1)} ms vs off ${slowestVsOff.offMs!.toFixed(1)} ms)`);
}

// ── verdict / gate ──────────────────────────────────────────────────────────────
const breaches = rows.filter((r) => r.monoMs > HARD_CEILING_MS);
console.log('\n' + L);
if (breaches.length) {
  console.log(`  VERDICT: FAIL — ${breaches.length} input(s) exceeded the ${HARD_CEILING_MS} ms hard ceiling:`);
  for (const b of breaches) console.log(`    ✗ ${b.name}: ${b.monoMs.toFixed(1)} ms  [${b.note}]`);
  console.log(L + '\n');
  process.exit(1);
} else {
  const maxMs = Math.max(...rows.map((r) => r.monoMs));
  const smell = flags.length ? `${flags.length} throughput outlier(s) flagged above — inspect, but none breached the ceiling` : 'no throughput outliers';
  console.log(`  VERDICT: PASS — all ${rows.length} inputs under the ${HARD_CEILING_MS} ms ceiling (worst ${maxMs.toFixed(1)} ms).`);
  console.log(`           ${smell}.`);
  console.log(L + '\n');
  process.exit(0);
}
