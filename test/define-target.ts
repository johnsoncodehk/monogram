// Gate: the shared algorithm core is target-language-agnostic and the portable targets register
// themselves independently.
//
//   1. core modules (algo-ir / relex-family / define-target) import no target module, name no
//      target, keep no host switch, and none of their string literals carries punctuation —
//      every operator, delimiter, comment marker and keyword comes from a target's Lowering
//      (test/syntax-agnostic.ts prints the family through a non-C lowering);
//   2. exactly one `defineTarget(...)` call per target module (target-ts / target-go /
//      target-rust), each with its own `Lowering`; no target module imports another target
//      module, an algorithm family, or the IR printer — families arrive via `shared`;
//   3. the registry holds exactly those three targets, each the module's exported target,
//      refuses a second registration under the same name, and a target without a Lowering
//      cannot be handed shared algorithms.
//
//   node test/define-target.ts
import { readFileSync } from 'node:fs';
import { tsTarget, goTarget, rustTarget } from '../src/emit.ts';
import { defineTarget, registeredTargets } from '../src/define-target.ts';

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  ✗ ${msg}`); };

const CORE = ['algo-ir.ts', 'relex-family.ts', 'define-target.ts'];
const TARGETS = [
  { file: 'target-ts.ts', target: tsTarget, name: 'typescript' },
  { file: 'target-go.ts', target: goTarget, name: 'go' },
  { file: 'target-rust.ts', target: rustTarget, name: 'rust' },
];

const code = (s: string) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, '')).join('\n');
const imports = (s: string) => [...s.matchAll(/^import [^;]*? from '([^']+)'/gms)].map((m) => m[1]);
// String literals with interpolations removed; import paths and error messages skipped.
const literals = (s: string) => [...s.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)]
  .map((m) => { let l = m[0]; while (/\$\{[^{}]*\}/.test(l)) l = l.replace(/\$\{[^{}]*\}/g, ''); return l; })
  .filter((l) => !/^.\.\//.test(l) && !/^.(algo-ir|defineTarget|relex-family):/.test(l));

const TARGET_NAMES = /\b(ts|go|rust|typescript|golang|TS|Go|Rust|TypeScript|Golang)\b/;
const HOST_SWITCH = /\b(host|Host|HOSTS)\b/;
const PUNCT = /[^\w\s]/;
// Line separators, and the parsed language's own `(` token text (grammar data), are not target syntax.
const NOT_SYNTAX = new Set(["'\\n'", "'('"]);
// Doc and comment prose (the lowering decides how comments are written) is not syntax.
const isProse = (body: string) => (body.match(/[A-Za-z]{2,}/g) ?? []).length >= 4;

for (const f of CORE) {
  const s = code(src(f));
  for (const i of imports(s)) if (/target-/.test(i)) fail(`${f}: core imports target module ${i}`);
  if (HOST_SWITCH.test(s)) fail(`${f}: core mentions a host switch (${s.match(HOST_SWITCH)![0]})`);
  for (const l of literals(s)) {
    if (TARGET_NAMES.test(l)) fail(`${f}: literal names a target: ${l.slice(0, 80)}`);
    const body = l.slice(1, -1);
    if (!NOT_SYNTAX.has(l) && !isProse(body) && PUNCT.test(body)) fail(`${f}: literal carries surface syntax (${body.match(PUNCT)![0]}): ${l.slice(0, 80)}`);
  }
}

const defineCalls = new Map<string, number>();
for (const f of ['emit.ts', 'emit-portable.ts', 'emit-parser.ts', ...CORE, ...TARGETS.map((t) => t.file)]) {
  const n = (code(src(f)).match(/(?<!function )\bdefineTarget\(/g) ?? []).length;
  if (n) defineCalls.set(f, n);
}
for (const t of TARGETS) {
  const s = code(src(t.file));
  if (defineCalls.get(t.file) !== 1) fail(`${t.file}: ${defineCalls.get(t.file) ?? 0} defineTarget calls, want 1`);
  if (!/^const \w+Lowering: Lowering = \{/m.test(s)) fail(`${t.file}: defines no Lowering of its own`);
  for (const i of imports(s)) {
    if (/\/target-/.test(i)) fail(`${t.file}: imports another target module ${i}`);
    if (/relex-family/.test(i)) fail(`${t.file}: imports an algorithm family directly (${i}); use shared`);
  }
  if (/\b(printFns|emitRelexFamily)\b/.test(s)) fail(`${t.file}: prints shared algorithms itself; use shared`);
}
for (const [f] of defineCalls) if (!TARGETS.some((t) => t.file === f)) fail(`${f}: defineTarget called outside a target module`);

const reg = registeredTargets();
const names = reg.map((t) => t.name).sort();
if (names.join() !== 'go,rust,typescript') fail(`registry holds [${names}], want [go, rust, typescript]`);
for (const t of TARGETS) {
  const r = reg.find((x) => x.name === t.name);
  if (r !== t.target) fail(`${t.name}: registered target is not ${t.file}'s export`);
}
if (new Set(reg.map((t) => t.lowering)).size !== reg.length) fail('targets share a Lowering object');
try {
  defineTarget({ name: 'go', ext: 'go', lowering: goTarget.lowering, emitParser: () => '' });
  fail('a second defineTarget("go") was accepted');
} catch { /* expected */ }
const bare = defineTarget({ name: 'no-lowering-probe', ext: 'txt', emitParser: (_g, shared) => shared.relexFamily({} as never) });
try {
  bare.emitParser({} as never);
  fail('a target without a Lowering was handed shared algorithms');
} catch (e) {
  if (!/supplies no Lowering/.test((e as Error).message)) fail(`unexpected error for a target without a Lowering: ${(e as Error).message}`);
}

if (failures > 0) {
  console.error(`\n✗ defineTarget: ${failures} problem(s)`);
  process.exit(1);
}
console.log('✓ defineTarget: target-agnostic core; typescript / go / rust each registered once from its own module');
