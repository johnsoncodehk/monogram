// Gate: an emitted jsTarget module is a self-contained deliverable.
//
// For every lexing mode the JS target supports (TypeScript: token stream, YAML: indent,
// HTML: markup, envspec: newline) the emitted source
//   1. has no import / require / dynamic import / import.meta and no producer filesystem path;
//   2. type-checks ALONE under `tsc --strict` from a temp directory outside the repository;
//   3. runs there under plain `node` (no monogram source reachable) and, per sample, agrees
//      with the runtime interpreter on accept/reject and the CST, and with the frozen lexer
//      golden on the full token stream (or lex error).
// The other shipped grammars (JavaScript, TypeScript React, JavaScript React) are type-checked
// too: their emitted module alone under `tsc --strict`, in one tsc run (formerly emit-tsc-gate:
// every grammar's emission — token width, mode-specific lexer code, empty vocab sets — stays
// type-sound and erasable).
// The portable TypeScript target's modules (default and with total parsing) type-check alone
// under `tsc --strict` plus noUnusedLocals, noUnusedParameters, allowUnusedLabels: false,
// allowUnreachableCode: false: an emitted module contains nothing unused (target-js is exempt
// from those four: see the section at the end).
//
//   node test/emit-standalone.ts
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitParser } from '../src/targets/target.ts';
import { jsTarget } from '../src/targets/target-js.ts';
import { tsTarget } from '../src/targets/target-ts.ts';
import { createParser } from '../src/interpreter/interpreter.ts';
import { goldenStream, streamOf } from './golden-lexer.ts';
import type { Grammar } from '../src/grammar/types.ts';
import { scratchDir } from './scratch.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

let ok = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};

const CASES: { name: string; path: string; samples: string[] }[] = [
  { name: 'typescript', path: '../typescript.ts', samples: ['let a = 1 + b;\n', 'function f(x: number) { return `t${x}` / 2; }\n', 'const r = /a+b/g.test(s);', 'let = ;'] },
  { name: 'yaml', path: '../yaml.ts', samples: ['a: 1\nb:\n  - x\n  - y\nc: {k: v, n: [1, 2]}\n', '# comment\nkey: "quoted"\nblock: |\n  line one\n  line two\n', 'a:\n'] },
  { name: 'html', path: '../html.ts', samples: ['<div class="a">hi<br>there</div>', '<!-- c --><p>a < b</p><script>if (a < b) {}</script>', '<ul><li>one</li><li>two</li></ul>', '<p>unclosed <b>bold'] },
  { name: 'envspec', path: './fixtures/envspec.ts', samples: ['A=1\nB=2\n', 'A=fn(1,\n2)\nB=3\n', 'A=1\n# c\nB=2', 'A=1\n\n\nB=2'] },
];

const RUNNER = (samples: string[]) => `import { parse, visit, tree, tokenize } from './parser.ts';
import { objectify } from './obj.ts';
declare const process: { stdout: { write(s: string): void } };
const samples: string[] = ${JSON.stringify(samples)};
const out = samples.map((s) => {
  let cst: unknown = null, err: string | null = null;
  try { const r = parse(s); cst = objectify(tree, (fns) => visit(r, fns)); } catch (e) { err = (e as Error).message; }
  let toks: unknown = null;
  try { toks = tokenize(s); } catch (e) { toks = { error: (e as Error).message }; }
  return { cst, err, toks };
});
process.stdout.write(JSON.stringify(out));
`;

const FORBIDDEN: [string, RegExp][] = [
  ['static import/export-from', /^\s*(?:import\s[^(]|export\s[^=]*\sfrom\s)/m],
  ['require()', /\brequire\s*\(/],
  ['dynamic import()', /(?:^|[=(,;\s])import\s*\(/m],
  ['import.meta', /\bimport\.meta\b/],
  ['file:// URL', /file:\/\//],
];

for (const c of CASES) {
  const grammar: Grammar = (await import(c.path)).default;
  const src = emitParser(grammar, jsTarget);
  const label = c.name;

  for (const [what, re] of FORBIDDEN) check(`${label}: no ${what}`, !re.test(src));
  check(`${label}: no producer path`, !src.includes(ROOT) && !src.includes(HERE) && !/\/(?:Users|home)\/[^\s'"`]/.test(src));

  const dir = scratchDir(`standalone-${c.name}`);
  check(`${label}: temp dir is outside the repository`, !resolve(dir).startsWith(ROOT));
  writeFileSync(join(dir, 'parser.ts'), src);
  writeFileSync(join(dir, 'obj.ts'), readFileSync(join(HERE, 'emitted-obj.ts'), 'utf8'));
  writeFileSync(join(dir, 'run.ts'), RUNNER(c.samples));

  const tsc = (files: string[], extra: string[] = []) => {
    try {
      execFileSync(TSC, ['--strict', '--noEmit', '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler', '--lib', 'ES2022', ...extra, ...files], { cwd: dir, stdio: 'pipe' });
      return '';
    } catch (e) { return String((e as { stdout?: Buffer }).stdout ?? e).slice(0, 600); }
  };
  const alone = tsc(['parser.ts']);
  check(`${label}: emitted module type-checks alone (tsc --strict)`, alone === '', alone);
  const withRunner = tsc(['run.ts'], ['--allowImportingTsExtensions']);
  check(`${label}: consumer program type-checks`, withRunner === '', withRunner);

  let results: { cst: unknown; err: string | null; toks: unknown }[] = [];
  try {
    results = JSON.parse(execFileSync(process.execPath, ['run.ts'], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 }));
    check(`${label}: runs under plain node outside the repository`, results.length === c.samples.length);
  } catch (e) { check(`${label}: runs under plain node outside the repository`, false, String(e).slice(0, 600)); continue; }

  const oracle = createParser(grammar);
  c.samples.forEach((s, i) => {
    const r = results[i];
    let want: unknown = null, wantOk = true;
    try { want = oracle.parse(s); } catch { wantOk = false; }
    const tag = JSON.stringify(s.slice(0, 28));
    check(`${label}: accept/reject ≡ interpreter for ${tag}`, wantOk === (r.err === null), `interp ${wantOk ? 'accept' : 'reject'}, emitted ${r.err ?? 'accept'}`);
    if (wantOk && r.err === null) check(`${label}: CST ≡ interpreter for ${tag}`, JSON.stringify(want) === JSON.stringify(r.cst));
    const wantToks = goldenStream(c.name, s);
    check(`${label}: tokens ≡ lexer golden for ${tag}`, wantToks !== undefined && JSON.stringify(wantToks) === JSON.stringify(streamOf(r.toks as any)),
      wantToks === undefined ? 'input not in the golden' : '');
  });
}

// The other shipped grammars: each emitted module type-checks alone under `tsc --strict`. One tsc
// run checks all of them (each file is standalone, so its diagnostics name only that file).
{
  const TSC_ONLY: [string, string][] = [['javascript', '../javascript.ts'], ['typescriptreact', '../typescriptreact.ts'], ['javascriptreact', '../javascriptreact.ts']];
  const dir = scratchDir('standalone-tsc');
  for (const [name, path] of TSC_ONLY) writeFileSync(join(dir, `${name}.ts`), emitParser((await import(path)).default as Grammar, jsTarget));
  let log = '';
  try {
    execFileSync(TSC, ['--strict', '--noEmit', '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler', '--lib', 'ES2022', ...TSC_ONLY.map(([n]) => `${n}.ts`)], { cwd: dir, stdio: 'pipe' });
  } catch (e) { log = String((e as { stdout?: Buffer }).stdout ?? e) || String(e); }
  // A failed run whose diagnostics name none of the files (tsc itself failed) fails every grammar.
  const attributed = TSC_ONLY.some(([n]) => log.includes(`${n}.ts(`));
  for (const [name] of TSC_ONLY) {
    const errs = log.split('\n').filter((l) => l.startsWith(`${name}.ts(`));
    check(`${name}: emitted module type-checks alone (tsc --strict)`, log === '' || (attributed && errs.length === 0),
      errs.slice(0, 10).join('\n') || log.slice(0, 600));
  }
}

// The portable TypeScript target's module (what a user of the target builds), default and with
// total parsing, for every grammar it emits: it type-checks alone under `tsc --strict` with the
// options that reject anything unused (as the project's own tsconfig.json), in one tsc run.
// target-js is exempt from these four options: it is retiring (replaced by this target) and its
// emission still has 159 such diagnostics (112 unreachable statements after a matcher's
// exhaustive return, 41 unused locals, 6 all-unused declarations); the exemption ends when
// src/targets/target-js.ts is deleted.
{
  const UNUSED = ['--noUnusedLocals', '--noUnusedParameters', '--allowUnusedLabels', 'false', '--allowUnreachableCode', 'false'];
  const PORTABLE: [string, string][] = [['typescript', '../typescript.ts'], ['javascript', '../javascript.ts'], ['typescriptreact', '../typescriptreact.ts'], ['javascriptreact', '../javascriptreact.ts']];
  const dir = scratchDir('standalone-ts-target');
  const files: string[] = [];
  for (const [name, path] of PORTABLE) {
    const grammar = (await import(path)).default as Grammar;
    for (const [suffix, opts] of [['', {}], ['-recovery', { recovery: true }]] as const) {
      writeFileSync(join(dir, `${name}${suffix}.ts`), emitParser(grammar, tsTarget, opts));
      files.push(`${name}${suffix}.ts`);
    }
  }
  let log = '';
  try {
    execFileSync(TSC, ['--strict', '--noEmit', '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler', '--lib', 'ES2022', ...UNUSED, ...files], { cwd: dir, stdio: 'pipe' });
  } catch (e) { log = String((e as { stdout?: Buffer }).stdout ?? e) || String(e); }
  const attributed = files.some((f) => log.includes(`${f}(`));
  for (const f of files) {
    const errs = log.split('\n').filter((l) => l.startsWith(`${f}(`));
    check(`tsTarget ${f}: type-checks alone (tsc --strict, nothing unused)`, log === '' || (attributed && errs.length === 0), errs.slice(0, 10).join('\n') || log.slice(0, 600));
  }
}

console.log(`\n${ok}/${ok + fail} standalone-emit checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
