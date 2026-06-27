// Portable-target peer benchmarks (methodology: profile-vs-tsc.mjs / profile-vs-peers.mjs)
//   tsTarget (typescript.ts)     vs tsc createSourceFile
//   goTarget (javascript.ts)       vs typescript-go parser.ParseSourceFile
//   rustTarget (javascript.ts)   vs oxc native (oxc_parser crate) AND oxc npm (parseSync)
//   node test/profile-portable-peers.mjs
//
// Prerequisites:
//   - go, rustc 1.92+
//   - git clone --depth 1 https://github.com/microsoft/typescript-go /tmp/typescript-go
//   - npm install oxc-parser  (optional — npm column skipped if missing)
//
// Corpus: valid snippets from test/portable-targets.ts, repeated to ~100 / 500 / 2000 KB.
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/portable-bench';
const TSGO_REPO = process.env.TSGO_REPO ?? '/tmp/typescript-go';
const OXC_BENCH = resolve(REPO, 'test/oxc-parse-bench');
const OXC_BIN = resolve(OXC_BENCH, 'target/release/oxc-parse-bench');

const TS_SNIPPETS = [
  'const a: number = 1;', 'let s: string;', 'type Alias = { a: number; b?: string };',
  'type U = "a" | "b" | "c";', 'function gen2<T, U extends T>(x: T, y: U): T { return x; }',
  'interface I<T> extends A<T> { m(x: T): T; }', 'const c = x as const;',
  'function isStr(x: unknown): x is string { return true; }', 'enum E { A, B, C }',
  'const n = maybe!;', 'let arr: number[];', 'type Fn = (x: number) => string;',
  'class C<in out T> { value!: T; }',
];
const JS_SNIPPETS = [
  'var x = 1, y = 2;', 'function f(a, b) { return a + b; }', 'const g = (x) => x * 2;',
  'x => x + 1;', 'a ? b : c;', 'a.b.c();', 'f(g(1, 2), 3);', '[1, 2, 3].map(f);',
  'for (let i = 0; i < n; i++) x();', 'for (const k in obj) { y(); }', 'while (x) { z(); }',
  'if (a) b(); else c();', 'class C extends B { m() {} get p() { return 1; } }', 'a++; b--;',
  'typeof x; void 0;', 'new Foo(1, 2); new.target;', 'a ?? b; a?.b?.c;',
  'try { f(); } catch (e) { g(); } finally { h(); }', 'switch (x) { case 1: f(); break; default: g(); }',
  'a instanceof B; a in obj;', '(function () {})(); (() => {})();', 'x = a && b || c;',
  'do { x(); } while (y);', 'function* gen() { yield* o(); }', 'const { a, b: c, ...r } = o;',
  'const [p, , q, ...z] = arr;', 'label: for (;;) { break label; }', 'async function h() { await x; }',
  'var re = /abc/g; x / y;', 'const t = `a${b}c`;',
];

function synth(name, snippets, targetKb) {
  const unit = snippets.join('\n') + '\n';
  const code = unit.repeat(Math.max(1, Math.ceil((targetKb * 1024) / unit.length)));
  return { name, code };
}

const CORPUS_TS = [100, 500, 2000].map((kb) => synth(`typescript-valid-${kb}kb`, TS_SNIPPETS, kb));
const CORPUS_JS = [100, 500, 2000].map((kb) => synth(`javascript-valid-${kb}kb`, JS_SNIPPETS, kb));

const { emitParser, tsTarget, goTarget, rustTarget } = await import(REPO + '/src/emit.ts');
const ts = (await import(REPO + '/node_modules/typescript/lib/typescript.js')).default;

let parseSync = null;
try {
  ({ parseSync } = await import('oxc-parser'));
} catch {
  console.log('oxc-parser npm package not installed — npm column will be skipped');
}

function time(fn, code, n) {
  const s = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn(code);
  return Number(process.hrtime.bigint() - s) / 1e6 / n;
}

function benchPair(label, rows, parseA, parseB, nameA, nameB) {
  console.log(`\n── ${label} ──`);
  console.log(`doc                              KB   ${nameA.padStart(10)}   ${nameB.padStart(10)}     ${nameA}/${nameB}`);
  console.log('-'.repeat(72));
  let ta = 0, tb = 0;
  for (const { name, code } of rows) {
    const iters = code.length > 1e6 ? 3 : code.length > 300_000 ? 10 : 20;
    for (let i = 0; i < 10 && i * code.length < 2e7; i++) { parseA(code); parseB(code); }
    let a = Infinity, b = Infinity;
    for (let r = 0; r < 5; r++) {
      a = Math.min(a, time(parseA, code, iters));
      b = Math.min(b, time(parseB, code, iters));
    }
    ta += a; tb += b;
    console.log(`${name.padEnd(30)}${(code.length / 1024).toFixed(0).padStart(5)}   ${a.toFixed(2).padStart(10)}   ${b.toFixed(2).padStart(10)}     ${(a / b).toFixed(2).padStart(6)}x`);
  }
  console.log('-'.repeat(72));
  console.log(`${'AGGREGATE'.padEnd(30)}        ${ta.toFixed(2).padStart(10)}   ${tb.toFixed(2).padStart(10)}     ${(ta / tb).toFixed(2).padStart(6)}x`);
}

function benchNative(bin, code, iters) {
  return Number(execFileSync(bin, [String(iters)], { input: code, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim());
}

function benchNativeRows(label, rows, monoBin, peerBin, nameA, nameB) {
  console.log(`\n── ${label} ──`);
  console.log(`doc                              KB   ${nameA.padStart(10)}   ${nameB.padStart(10)}     ${nameA}/${nameB}`);
  console.log('-'.repeat(72));
  let ta = 0, tb = 0;
  for (const { name, code } of rows) {
    const iters = code.length > 1e6 ? 5 : code.length > 300_000 ? 15 : 30;
    for (let i = 0; i < 3; i++) { benchNative(monoBin, code, iters); benchNative(peerBin, code, iters); }
    let a = Infinity, b = Infinity;
    for (let r = 0; r < 5; r++) {
      a = Math.min(a, benchNative(monoBin, code, iters));
      b = Math.min(b, benchNative(peerBin, code, iters));
    }
    ta += a; tb += b;
    console.log(`${name.padEnd(30)}${(code.length / 1024).toFixed(0).padStart(5)}   ${a.toFixed(2).padStart(10)}   ${b.toFixed(2).padStart(10)}     ${(a / b).toFixed(2).padStart(6)}x`);
  }
  console.log('-'.repeat(72));
  console.log(`${'AGGREGATE'.padEnd(30)}        ${ta.toFixed(2).padStart(10)}   ${tb.toFixed(2).padStart(10)}     ${(ta / tb).toFixed(2).padStart(6)}x`);
}

function benchRustOxcRows(label, rows, monoBin, oxcNativeBin) {
  const hasNpm = parseSync !== null;
  console.log(`\n── ${label} ──`);
  console.log(
    'doc                              KB     mono ms   oxc-rs ms' +
    (hasNpm ? '  oxc-npm ms   mono/oxc-rs  mono/oxc-npm' : '   mono/oxc-rs'),
  );
  console.log('-'.repeat(hasNpm ? 88 : 72));
  let ta = 0, trs = 0, tnpm = 0;
  const oxcNpm = hasNpm ? (code) => parseSync('bench.js', code) : null;
  for (const { name, code } of rows) {
    const iters = code.length > 1e6 ? 5 : code.length > 300_000 ? 15 : 30;
    for (let i = 0; i < 3; i++) {
      benchNative(monoBin, code, iters);
      benchNative(oxcNativeBin, code, iters);
      if (hasNpm) oxcNpm(code);
    }
    let a = Infinity, rs = Infinity, npm = Infinity;
    for (let r = 0; r < 5; r++) {
      a = Math.min(a, benchNative(monoBin, code, iters));
      rs = Math.min(rs, benchNative(oxcNativeBin, code, iters));
      if (hasNpm) npm = Math.min(npm, time(oxcNpm, code, iters));
    }
    ta += a; trs += rs; if (hasNpm) tnpm += npm;
    const kb = (code.length / 1024).toFixed(0).padStart(5);
    if (hasNpm) {
      console.log(
        `${name.padEnd(30)}${kb}   ${a.toFixed(2).padStart(10)}   ${rs.toFixed(2).padStart(10)}   ${npm.toFixed(2).padStart(10)}     ${(a / rs).toFixed(2).padStart(6)}x      ${(a / npm).toFixed(2).padStart(6)}x`,
      );
    } else {
      console.log(`${name.padEnd(30)}${kb}   ${a.toFixed(2).padStart(10)}   ${rs.toFixed(2).padStart(10)}     ${(a / rs).toFixed(2).padStart(6)}x`);
    }
  }
  console.log('-'.repeat(hasNpm ? 88 : 72));
  if (hasNpm) {
    console.log(
      `${'AGGREGATE'.padEnd(30)}        ${ta.toFixed(2).padStart(10)}   ${trs.toFixed(2).padStart(10)}   ${tnpm.toFixed(2).padStart(10)}     ${(ta / trs).toFixed(2).padStart(6)}x      ${(ta / tnpm).toFixed(2).padStart(6)}x`,
    );
  } else {
    console.log(`${'AGGREGATE'.padEnd(30)}        ${ta.toFixed(2).padStart(10)}   ${trs.toFixed(2).padStart(10)}     ${(ta / trs).toFixed(2).padStart(6)}x`);
  }
}

function buildTsgoBench() {
  if (!existsSync(TSGO_REPO)) {
    throw new Error(`typescript-go not found at ${TSGO_REPO} — git clone --depth 1 https://github.com/microsoft/typescript-go ${TSGO_REPO}`);
  }
  const cmdDir = resolve(TSGO_REPO, 'cmd/parsebench');
  mkdirSync(cmdDir, { recursive: true });
  copyFileSync(resolve(REPO, 'test/tsgo-parsebench/main.go'), resolve(cmdDir, 'main.go'));
  const out = `${TMP}/tsgobench/p`;
  mkdirSync(`${TMP}/tsgobench`, { recursive: true });
  execFileSync('go', ['build', '-o', out, './cmd/parsebench'], { cwd: TSGO_REPO, stdio: 'pipe' });
  return out;
}

function buildOxcNativeBench() {
  execFileSync('cargo', ['build', '--release', '--manifest-path', resolve(OXC_BENCH, 'Cargo.toml')], { stdio: 'pipe' });
  if (!existsSync(OXC_BIN)) throw new Error(`oxc bench binary missing after build: ${OXC_BIN}`);
  return OXC_BIN;
}

// ── tsTarget vs tsc ──
rmSync(`${TMP}/ts`, { recursive: true, force: true });
mkdirSync(`${TMP}/ts`, { recursive: true });
const tsGrammar = (await import(REPO + '/typescript.ts')).default;
writeFileSync(`${TMP}/ts/p.mts`, emitParser(tsGrammar, tsTarget));
const monoTs = await import(`${TMP}/ts/p.mts?v=${Date.now()}`);
const monoTsParse = (code) => {
  const root = monoTs.parse(monoTs.tokenize(code));
  if (root === null) throw new Error('parse failed');
};
const tscParse = (code) => ts.createSourceFile('f.ts', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
benchPair('tsTarget (typescript.ts) vs tsc createSourceFile', CORPUS_TS, monoTsParse, tscParse, 'mono ms', 'tsc ms');

// ── goTarget vs typescript-go parser ──
rmSync(`${TMP}/go`, { recursive: true, force: true });
mkdirSync(`${TMP}/go`, { recursive: true });
const jsGrammar = (await import(REPO + '/javascript.ts')).default;
writeFileSync(`${TMP}/go/parser.go`, emitParser(jsGrammar, goTarget));
writeFileSync(`${TMP}/go/runner.go`, goTarget.emitRunner());
writeFileSync(`${TMP}/go/go.mod`, 'module bench\n\ngo 1.21\n');
execFileSync('go', ['build', '-o', `${TMP}/go/p`, '.'], { cwd: `${TMP}/go`, stdio: 'pipe' });

const tsgoBin = buildTsgoBench();
benchNativeRows(
  'goTarget (javascript.ts) vs typescript-go ParseSourceFile',
  CORPUS_JS, `${TMP}/go/p`, tsgoBin, 'mono ms', 'tsgo ms',
);

// ── rustTarget vs oxc (native + npm) ──
rmSync(`${TMP}/rust`, { recursive: true, force: true });
mkdirSync(`${TMP}/rust`, { recursive: true });
writeFileSync(`${TMP}/rust/main.rs`, emitParser(jsGrammar, rustTarget) + rustTarget.emitRunner());
execFileSync('rustc', ['-O', '-A', 'warnings', `${TMP}/rust/main.rs`, '-o', `${TMP}/rust/p`], { stdio: 'pipe' });

const oxcNativeBin = buildOxcNativeBench();
benchRustOxcRows(
  'rustTarget (javascript.ts) vs oxc native + oxc npm',
  CORPUS_JS, `${TMP}/rust/p`, oxcNativeBin,
);

console.log('\nNote: Monogram builds a full CST; oxc/tsc/tsgo build AST/SourceFile.');
console.log('oxc-rs: test/oxc-parse-bench (oxc_parser crate, arena reset per iter).');
console.log('oxc-npm: oxc-parser parseSync (includes NAPI + JS AST materialization).');
console.log('Corpus: portable-targets gate snippets repeated to size.');
