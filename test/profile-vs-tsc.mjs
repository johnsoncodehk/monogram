// CPU-profile the EMITTED Monogram parser vs the official tsc parser on the PR#4 bench
// files: per-file timing ratio, then a V8 profile of each engine with top self-time
// tables + layer shares (lexer / parser / GC).
//   node test/profile-vs-tsc.mjs                 # timing table + both profiles
//   node --no-turbo-inlining test/profile-vs-tsc.mjs   # honest per-fn attribution
// Writes /tmp/mono.cpuprofile + /tmp/tsc.cpuprofile (inspect via test/profile-lines.mjs).
import { Session } from 'node:inspector';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ts = (await import(REPO + '/node_modules/typescript/lib/typescript.js')).default;
const { emitParser } = await import(REPO + '/src/emit-parser.ts');
const grammar = (await import(REPO + '/typescript.ts')).default;

writeFileSync('/tmp/emitted-current.mjs', emitParser(grammar));
const emitted = await import('/tmp/emitted-current.mjs?v=' + Date.now());

const paths = [
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserharness.ts',
  '/tmp/ts-repo/tests/cases/conformance/fixSignatureCaching.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/parserRealSource7.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserindenter.ts',
];
const files = paths.map((p) => ({ name: p.split('/').pop(), code: readFileSync(p, 'utf-8') }));

const mono = (code) => emitted.parse(code);
const tscF = (code) => ts.createSourceFile('f.ts', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
const tscT = (code) => ts.createSourceFile('f.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function time(fn, code, n) {
  const s = process.hrtime.bigint();
  for (let i = 0; i < n; i++) { try { fn(code); } catch {} }
  return Number(process.hrtime.bigint() - s) / 1e6 / n;
}

for (const { code } of files) for (let i = 0; i < 10; i++) { try { mono(code); tscF(code); tscT(code); } catch {} }
console.log('file                          KB    mono ms   tsc(f) ms  tsc(t) ms   mono/tsc(f)  mono/tsc(t)');
console.log('-'.repeat(100));
let tm = 0, tf = 0, tt = 0;
for (const { name, code } of files) {
  let m = Infinity, f = Infinity, t = Infinity;
  for (let r = 0; r < 5; r++) {
    m = Math.min(m, time(mono, code, 20));
    f = Math.min(f, time(tscF, code, 20));
    t = Math.min(t, time(tscT, code, 20));
  }
  tm += m; tf += f; tt += t;
  console.log(`${name.padEnd(28)}${(code.length / 1024).toFixed(0).padStart(4)}   ${m.toFixed(2).padStart(7)}   ${f.toFixed(2).padStart(8)}   ${t.toFixed(2).padStart(8)}     ${(m / f).toFixed(2).padStart(6)}x      ${(m / t).toFixed(2).padStart(5)}x`);
}
console.log('-'.repeat(100));
console.log(`${'AGGREGATE'.padEnd(28)}       ${tm.toFixed(2).padStart(7)}   ${tf.toFixed(2).padStart(8)}   ${tt.toFixed(2).padStart(8)}     ${(tm / tf).toFixed(2).padStart(6)}x      ${(tm / tt).toFixed(2).padStart(5)}x`);

const session = new Session();
session.connect();
const post = (method, params) => new Promise((res, rej) => session.post(method, params, (e, r) => (e ? rej(e) : res(r))));
await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 100 });

async function profileEngine(fn, seconds) {
  for (const { code } of files) for (let i = 0; i < 5; i++) { try { fn(code); } catch {} }
  await post('Profiler.start');
  const s = process.hrtime.bigint();
  let rounds = 0;
  while (Number(process.hrtime.bigint() - s) / 1e9 < seconds) {
    for (const { code } of files) { try { fn(code); } catch {} }
    rounds++;
  }
  const { profile } = await post('Profiler.stop');
  return { profile, rounds };
}

function analyze(tag, profile, lexerRoots) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const childOf = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) childOf.set(c, n.id);
  const isLexerRoot = (n) => lexerRoots.test(n.callFrame.functionName || '');
  const lexerFlag = new Map();
  const flagOf = (id) => {
    if (lexerFlag.has(id)) return lexerFlag.get(id);
    const n = byId.get(id);
    const v = isLexerRoot(n) || (childOf.has(id) ? flagOf(childOf.get(id)) : false);
    lexerFlag.set(id, v);
    return v;
  };
  let total = 0, gc = 0, lexer = 0, idle = 0;
  const byFn = new Map();
  for (const n of profile.nodes) {
    const hc = n.hitCount || 0;
    if (!hc) continue;
    const fn = n.callFrame.functionName || '(anonymous)';
    if (fn === '(idle)' || fn === '(program)') { idle += hc; continue; }
    total += hc;
    if (fn === '(garbage collector)') { gc += hc; continue; }
    if (flagOf(n.id)) lexer += hc;
    const file = (n.callFrame.url || '').split('/').pop() || '(native)';
    byFn.set(`${fn}  @${file}:${n.callFrame.lineNumber + 1}`, (byFn.get(`${fn}  @${file}:${n.callFrame.lineNumber + 1}`) || 0) + hc);
  }
  const parser = total - gc - lexer;
  console.log(`\n══ ${tag} ══  ${total} samples (idle/program excluded: ${idle})`);
  console.log(`  layers: lexer ${(100 * lexer / total).toFixed(1)}%   parser ${(100 * parser / total).toFixed(1)}%   GC ${(100 * gc / total).toFixed(1)}%`);
  console.log('  self%  samples  function');
  for (const [k, v] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25))
    console.log(`  ${(100 * v / total).toFixed(1).padStart(5)}  ${String(v).padStart(7)}  ${k}`);
}

const pm = await profileEngine(mono, 4);
const pf = await profileEngine(tscF, 4);
writeFileSync('/tmp/mono.cpuprofile', JSON.stringify(pm.profile));
writeFileSync('/tmp/tsc.cpuprofile', JSON.stringify(pf.profile));

analyze(`Monogram emitted (${pm.rounds} rounds)`, pm.profile, /^tokenize$/);
analyze(`tsc setParentNodes=false (${pf.rounds} rounds)`, pf.profile, /^(scan|reScan\w+)$/);
console.log('\nwrote /tmp/mono.cpuprofile /tmp/tsc.cpuprofile');
