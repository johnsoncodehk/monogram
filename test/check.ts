// ─────────────────────────────────────────────────────────────────────────────
//  check.ts — the SINGLE gate runner. Runs every correctness GATE as a subprocess and
//  prints ONE ✓/✗ summary, exiting non-zero if any fails. `npm run check` answers
//  "is the repo healthy?" in one command + one output — instead of running a dozen
//  scripts with a dozen output formats. See docs/TESTING.md for the report taxonomy
//  (gate / metric / ledger / bench); this runs the GATE tier (the CI-blocking pass/fail
//  checks). Gates that need a pinned external corpus (the TypeScript corpus at /tmp/ts-repo, the
//  test262 checkout at /tmp/test262) say NOT RUN without it and fail, they never pass unrun.
//  Metrics live in the README coverage table (`npm run coverage:table`), findings in the
//  gap ledger (`docs/KNOWN-GAPS.md`).
//
//  Assumes the generated grammars are current (`npm run gen`), as CI does before this.
//  Run:  node test/check.ts            # all gates
//        node test/check.ts yaml       # only gates whose group/name contains "yaml"
// ─────────────────────────────────────────────────────────────────────────────
import { execFile, execFileSync } from 'node:child_process';
import { cpus, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// tier 'ci': the gate runs in CI (and with --all), not in the inner loop (`--changed`): a
// whole-corpus cross or a gate of more than about ten seconds whose inputs rarely change.
// reads: inputs the gate opens through a path test/gate-deps.ts cannot derive from its source.
// targets: the gate runs each emit target's checks apart, honouring CHECK_TARGETS=js,ts,go,rust
// (a target's checks use no other target's code, except the TypeScript target as a reference, which
// always runs): `--changed` narrows it to the targets whose code changed (test/gate-deps.ts).
// quick: the gate is in the QUICK tier (`--quick`): it runs whole (it costs about a second), or its
// declared sample when it is given CHECK_QUICK=1 (test/check-targets.ts).
interface Gate { group: string; name: string; args: string[]; tier?: 'ci'; reads?: string[]; targets?: true; quick?: true; env?: Record<string, string> }
// The edits class's grammars in two shards of about equal time. Measured on CI (land/testinfra-batch-edit,
// 45203634706, after the runners' batch-edit-session mode): the five former shards took 26.7 s
// (typescriptreact), 31.4 (elementdialect, javascript, tagtokdialect), 30.2 (typescript,
// javascriptreact), 16.2 (textdialect-tagstart, textdialect-text), 9.3 (textdialect, textdialect-dir).
const PORTABLE_EDIT_SHARDS = ['typescriptreact,typescript,javascriptreact', 'elementdialect,javascript,tagtokdialect,textdialect-tagstart,textdialect-text,textdialect,textdialect-dir'];
const EDIT_GRAMMARS = new Set(PORTABLE_EDIT_SHARDS.join(',').split(','));
const GATES: Gate[] = [
  { group: 'core', name: 'agnostic', args: ['test/agnostic.ts'] },
  { group: 'core', name: 'tag-open-entry', args: ['test/tag-open-entry.ts'] },
  { group: 'core', name: 'text-dialect', args: ['test/text-dialect.ts'] },
  { group: 'core', name: 'left-recursion', args: ['test/left-recursion.ts'] },
  { group: 'core', name: 'nullable-rules', args: ['test/nullable-rules.ts'] },
  { group: 'core', name: 'template-holes', args: ['test/template-holes.ts'] },
  { group: 'core', name: 'newline-mode', args: ['test/newline-mode.ts'] },
  { group: 'core', name: 'diagnostic-labels', args: ['test/diagnostic-labels.ts'] },
  { group: 'core', name: 'interpolation-metadata', args: ['test/interpolation-metadata.ts'] },
  { group: 'core', name: 'cst-text-invariant', args: ['test/cst-text-invariant.ts'] },
  { group: 'conformance', name: 'ts-ast-structure', args: ['test/ts-ast-verify.ts'] },
  { group: 'conformance', name: 'shape-oracle', args: ['test/shape-oracle.ts'] },
  { group: 'conformance', name: 'shape2-oracle', args: ['--stack-size=7000', 'test/shape2-oracle.ts', '--check'], tier: 'ci' },
  { group: 'core', name: 'cst-match-totality', args: ['test/cst-match-totality.ts'] },
  { group: 'core', name: 'grammar-names', args: ['test/grammar-names-transparent.ts'] },
  { group: 'core', name: 'shape2-eval', args: ['--stack-size=7000', 'test/shape2-eval.ts'] },
  { group: 'emit-parity', name: 'emit-parser-verify', args: ['test/emit-parser-verify.ts'] },
  { group: 'emit-parity', name: 'emit-reject-messages', args: ['test/emit-reject-messages.ts'] },
  { group: 'emit-parity', name: 'emit-lexer-verify', args: ['test/emit-lexer-verify.ts'] },
  { group: 'emit-parity', name: 'emit-reentrancy', args: ['test/emit-reentrancy.ts'] },
  { group: 'emit-parity', name: 'emit-standalone', args: ['test/emit-standalone.ts'] },
  { group: 'emit-parity', name: 'emit-portable-library', args: ['test/emit-portable-library.ts'] },
  { group: 'emit-parity', name: 'emit-portable-split', args: ['test/emit-portable-split.ts'] },
  // The portable targets ≡ the interpreter, one gate per class (test/portable-harness.ts); the
  // edits class is sharded by grammar (PORTABLE_EDIT_SHARDS). The Go / Rust builds are shared through the
  // harness's build cache, so the shards build each grammar once between them.
  { group: 'emit-parity', name: 'portable-targets/lists', args: ['test/portable-lists.ts'], targets: true },
  ...PORTABLE_EDIT_SHARDS.map((gs, i): Gate => ({ group: 'emit-parity', name: `portable-targets/edits-${i + 1}`, args: ['test/portable-edits.ts', `--grammars=${gs}`], tier: 'ci', targets: true })),
  // the grammars of no shard: their edit sessions (calc, envspec, …: a few seconds)
  { group: 'emit-parity', name: 'portable-targets/edits-small', args: ['test/portable-edits.ts', `--grammars-except=${[...EDIT_GRAMMARS].join(',')}`], targets: true },
  { group: 'emit-parity', name: 'portable-targets/corpus', args: ['test/portable-corpus.ts'], tier: 'ci', targets: true },
  { group: 'emit-parity', name: 'portable-targets/recovery', args: ['test/portable-recovery.ts'], tier: 'ci', targets: true },
  // every file of the tsc conformance corpus and test262 (the pinned corpora at /tmp): about a minute
  { group: 'emit-parity', name: 'portable-targets/wide', args: ['test/portable-wide.ts'], tier: 'ci' },
  { group: 'emit-parity', name: 'portable-work', args: ['test/portable-work.ts'] },
  { group: 'emit-parity', name: 'predictive-first', args: ['test/predictive-first.ts'] },
  { group: 'emit-parity', name: 'guard-lead', args: ['test/guard-lead.ts'] },
  { group: 'emit-parity', name: 'guard-refutation', args: ['test/guard-refutation.ts'] },
  { group: 'emit-parity', name: 'guard-refused', args: ['--stack-size=7000', 'test/guard-refused.ts'], tier: 'ci' },
  { group: 'emit-parity', name: 'decision-report', args: ['--stack-size=7000', 'test/decision-report.ts', '--check'], tier: 'ci' },
  { group: 'emit-parity', name: 'look-extent', args: ['test/look-extent.ts'], tier: 'ci' },
  { group: 'emit-parity', name: 'lexer-work', args: ['test/lexer-work.ts'] },
  { group: 'emit-parity', name: 'lexer-reservation', args: ['test/lexer-reservation.ts'] },
  { group: 'emit-parity', name: 'alloc-work', args: ['test/alloc-work.ts'], tier: 'ci' },
  { group: 'emit-parity', name: 'builder-reuse', args: ['test/builder-reuse.ts'] },
  { group: 'emit-parity', name: 'define-target', args: ['test/define-target.ts'] },
  { group: 'emit-parity', name: 'lex-family', args: ['test/lex-family.ts'], tier: 'ci' },
  { group: 'emit-parity', name: 'shape-rust', args: ['test/shape-rust.ts'], tier: 'ci' },
  { group: 'emit-parity', name: 'shape-parity', args: ['test/shape-parity.ts'] },
  { group: 'core', name: 'multi-doc', args: ['test/multi-doc.ts'] },
  { group: 'core', name: 'recovery', args: ['test/recovery.ts'] },
  { group: 'core', name: 'incremental-grammars', args: ['test/incremental-grammars.ts'], tier: 'ci' },
  { group: 'core', name: 'exhaustive-edits', args: ['test/exhaustive-edits.ts'], tier: 'ci' },
  { group: 'core', name: 'issue-cases', args: ['test/test-issues.ts'] },
  { group: 'core', name: 'env-spec-regressions', args: ['test/env-spec-regressions.ts'] },
  { group: 'conformance', name: 'js', args: ['test/js-conformance.ts'] },
  { group: 'conformance', name: 'test262', args: ['test/test262.ts'], tier: 'ci' },
  { group: 'conformance', name: 'tsx', args: ['test/tsx-conformance.ts'] },
  { group: 'conformance', name: 'jsx', args: ['test/jsx-conformance.ts'] },
  { group: 'conformance', name: 'html', args: ['test/html-conformance.ts'] },
  { group: 'highlighter', name: 'tm-guards', args: ['test/tm-highlight-guards.ts'] },
  { group: 'highlighter', name: 'tm-completeness', args: ['test/tm-completeness.ts', '--check'] },
  { group: 'highlighter', name: 'tm-mutation', args: ['test/tm-mutation.ts'], tier: 'ci' },
  { group: 'highlighter', name: 'tm-diagnostics', args: ['test/redcmd-tm-diagnostics.ts'] },
  { group: 'highlighter', name: 'tm-lookahead-words', args: ['test/tm-lookahead-words.ts'] },
  { group: 'highlighter', name: 'tm-modifier-follow', args: ['test/tm-modifier-follow.ts'] },
  { group: 'highlighter', name: 'tm-dialect', args: ['test/tm-dialect.ts'] },
  { group: 'highlighter', name: 'treesitter-assertions', args: ['test/treesitter-assertions.ts'] },
  { group: 'highlighter', name: 'angle-depth', args: ['test/angle-depth-probe.ts'] },
  { group: 'highlighter', name: 'monarch-dialect', args: ['test/monarch-dialect.ts'] },
  { group: 'highlighter', name: 'raw-text-case-sites', args: ['test/raw-text-case-sites.ts'] },
  { group: 'core', name: 'indent-extensions', args: ['test/indent-extensions.ts'] },
  { group: 'yaml', name: 'issue12-regressions', args: ['test/yaml-issue12-regressions.ts'] },
  // the YAML TextMate site checks, one section each (formerly depth-witnesses, depth-sites, flow-sites,
  // compact-nest-sites, deepest-sibling, blockscalar-depth)
  { group: 'yaml', name: 'tm-sites', args: ['test/yaml-sites.ts'] },
  { group: 'generative', name: 'scope≡role', args: ['test/generative.ts'] },
];
// The QUICK tier (`--quick`, the loop of seconds): the affected gates of this list run (sampled where
// a gate has a sample: CHECK_QUICK=1); every other affected gate is printed as left to `--changed` /
// CI. Chosen from the real failures of land/** branches (2026-11-22/23: which gates caught them) and
// the CI times (each about 3 s or less there, or sampled to that).
const QUICK_GATES = new Set([
  'emit-parity/portable-targets/lists', 'emit-parity/portable-targets/edits-small', 'emit-parity/define-target',
  'emit-parity/shape-parity', 'emit-parity/guard-refutation', 'emit-parity/guard-lead', 'emit-parity/predictive-first',
  'emit-parity/emit-reentrancy', 'core/recovery', 'core/template-holes', 'core/diagnostic-labels', 'core/issue-cases',
  'core/env-spec-regressions', 'core/nullable-rules', 'core/agnostic', 'core/tag-open-entry', 'core/left-recursion',
  'core/indent-extensions', 'core/text-dialect', 'conformance/js', 'conformance/tsx', 'conformance/jsx', 'conformance/html',
  'conformance/ts-ast-structure', 'highlighter/tm-guards', 'highlighter/treesitter-assertions', 'highlighter/tm-dialect',
  'highlighter/tm-diagnostics', 'highlighter/angle-depth', 'highlighter/monarch-dialect', 'highlighter/raw-text-case-sites',
  'highlighter/tm-lookahead-words', 'highlighter/tm-modifier-follow', 'yaml/tm-sites', 'yaml/issue12-regressions',
]);
for (const g of GATES) if (QUICK_GATES.has(`${g.group}/${g.name}`)) g.quick = true;
if (QUICK_GATES.size !== GATES.filter((g) => g.quick).length) throw new Error('check.ts: a QUICK_GATES name names no gate');

// Usage: check.ts [<substr>]                  every gate (CI), or those whose group/name holds substr
//        check.ts --changed [<base>] [<substr>] the INNER LOOP: the gates of tier other than 'ci'
//                                               whose inputs changed since <base> (default
//                                               origin/master: committed, staged, unstaged and
//                                               untracked changes); prints what it skips and why
//        check.ts --all ...                     with --changed: the 'ci' tier too
const argv = process.argv.slice(2);
//        check.ts --changed --list ...          only print what would run and what is skipped
//        check.ts --changed --commit=<rev> ...  the files <rev> changed (its diff from its parent)
//                                               instead of the working tree's: how long the inner
//                                               loop takes for a past commit
const quickMode = argv.includes('--quick');
const changedMode = argv.includes('--changed') || quickMode;
const all = argv.includes('--all');
const listOnly = argv.includes('--list');
const commit = argv.find((a) => a.startsWith('--commit='))?.slice('--commit='.length);
const rest = argv.filter((a) => a !== '--changed' && a !== '--quick' && a !== '--all' && a !== '--list' && !a.startsWith('--commit='));
let base = 'origin/master';
if (changedMode && rest.length && !GATES.some((g) => (g.group + ' ' + g.name).includes(rest[0]!)) && !rest[0]!.startsWith('-')) base = rest.shift()!;
const filter = rest[0];
let gates = filter ? GATES.filter((g) => (g.group + ' ' + g.name).includes(filter)) : GATES;
if (!gates.length) { console.error(`no gate matches "${filter}"`); process.exit(1); }

if (changedMode) {
  const { gateTargetDeps, gateDeps } = await import('./gate-deps.ts');
  const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const changed = new Set(commit ? git('diff', '--name-only', `${commit}^`, commit) : [
    ...git('diff', '--name-only', `${git('merge-base', base, 'HEAD')[0]}`),
    ...git('ls-files', '--others', '--exclude-standard'),
  ]);
  // A change to the runner, the package manifest or the TypeScript setup can affect every gate.
  const GLOBAL = ['test/check.ts', 'package.json', 'package-lock.json', 'tsconfig.json'];
  const global = GLOBAL.filter((f) => changed.has(f));
  console.log(`  --changed: ${changed.size} file(s) changed ${commit ? `by ${commit}` : `since ${base}`}${global.length ? ` (global: ${global.join(', ')})` : ''}`);
  const run: Gate[] = [], skipped: string[] = [], notQuick: Gate[] = [];
  for (const g of gates) {
    const label = `${g.group}/${g.name}`;
    const script = g.args.find((a) => a.endsWith('.ts'))!;
    // a gate of the ci tier runs when its own script changed: the change is to that gate
    if (g.tier === 'ci' && !all && !changed.has(script)) { skipped.push(`${label.padEnd(36)} tier ci (runs in CI; --all runs it)`); continue; }
    if (quickMode && !g.quick && !changed.has(script)) { notQuick.push(g); continue; }
    const { common, targets } = gateTargetDeps(script, g.reads);
    const size = common.size + [...targets.values()].reduce((n, t) => n + t.size, 0);
    if (global.length || [...changed].some((f) => common.has(f))) { run.push(g); continue; }
    const hitTargets = [...targets].filter(([, fs]) => [...changed].some((f) => fs.has(f))).map(([t]) => t);
    if (!hitTargets.length) { skipped.push(`${label.padEnd(36)} none of its ${size} input file(s) changed`); continue; }
    // only target code changed: a gate that runs its targets apart runs those targets
    run.push(g.targets && hitTargets.length < targets.size ? { ...g, env: { CHECK_TARGETS: hitTargets.join(',') } } : g);
  }
  for (const s of skipped) console.log(`    · skip ${s}`);
  // the gates --changed would run that the quick tier leaves out: they run in `--changed` and CI
  const affected = notQuick.filter((g) => [...changed].some((f) => gateDeps(g.args.find((a) => a.endsWith('.ts'))!, g.reads).has(f)) || global.length);
  if (affected.length) console.log(`    · not in the quick tier (\`--changed\` and CI run them): ${affected.map((g) => `${g.group}/${g.name}`).join(', ')}`);
  gates = quickMode ? run.map((g) => (g.quick ? { ...g, env: { ...g.env, CHECK_QUICK: '1' } } : g)) : run;
  if (listOnly) { for (const g of gates) console.log(`    → run  ${g.group}/${g.name}${g.env ? `  (${Object.entries(g.env).map(([k, v]) => `${k}=${v}`).join(' ')})` : ''}`); console.log(`  ${gates.length} gate(s) to run, ${skipped.length} skipped`); process.exit(0); }
  if (!gates.length) { console.log('\n  no gate is affected by the change ✓'); process.exit(0); }
}

const lastLine = (s: string): string => { const ls = s.trimEnd().split('\n').filter((l) => l.trim()); return ls.length ? ls[ls.length - 1].trim().slice(0, 70) : ''; };

interface Result { gate: Gate; ok: boolean; ms: number; summary: string; output: string }

// Each gate is an independent subprocess (it re-emits its own parser and reads its own
// corpus), so they run CONCURRENTLY across a worker pool — the gates share no mutable
// state and write only into their own per-run scratch dirs (test/scratch.ts), so parallelism
// is safe — within one invocation and across concurrent ones — and turns the
// wall-clock from sum-of-gates into ~max(sum/pool, slowest-gate). Results stream as each
// finishes (completion order); the final summary is printed in gate order.
// With CHECK_TRACE_DEPS=1 (CI) each gate runs with test/trace-reads.ts preloaded, which lists the
// repository files it opened; a file test/gate-deps.ts does not derive for it fails the run below.
const TRACE = process.env.CHECK_TRACE_DEPS === '1' ? mkdtempSync(join(tmpdir(), 'monogram-check-trace-')) : null;
const traceFile = (gate: Gate) => join(TRACE!, `${gate.group}-${gate.name}`.replace(/[^A-Za-z0-9.-]/g, '_'));
function run(gate: Gate): Promise<Result> {
  const t0 = Date.now();
  const args = TRACE ? ['--import', './test/trace-reads.ts', ...gate.args] : gate.args;
  const env = { ...process.env, ...gate.env, ...(TRACE ? { CHECK_TRACE: traceFile(gate) } : {}) };
  return new Promise((resolve) => {
    execFile('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env }, (err, stdout, stderr) => {
      const output = (stdout ?? '') + (stderr ?? '');
      resolve({ gate, ok: !err, ms: Date.now() - t0, summary: lastLine(output), output });
    });
  });
}

// CI runs a gate per core (a GitHub runner: 4 cores, 16 GB); a developer box keeps two cores free.
const POOL = process.env.CI ? cpus().length : Math.max(2, cpus().length - 2);
const results: Result[] = [];
let next = 0;
// The 'ci' tier holds the long gates: they start first, so the slowest one is not the last to begin.
const queue = [...gates.filter((g) => g.tier === 'ci'), ...gates.filter((g) => g.tier !== 'ci')];
async function worker(): Promise<void> {
  while (next < queue.length) {
    const gate = queue[next++];
    const r = await run(gate);
    results.push(r);
    // CHECK_OUT_DIR (CI, uploaded as the job's `gate-output` artifact): every gate's whole output
    if (process.env.CHECK_OUT_DIR) { mkdirSync(process.env.CHECK_OUT_DIR, { recursive: true }); writeFileSync(join(process.env.CHECK_OUT_DIR, `${gate.group}-${gate.name}.txt`.replace(/[^A-Za-z0-9.-]/g, '_')), r.output); }
    process.stdout.write(`    ${r.ok ? '✓' : '✗'} ${(r.gate.group + '/' + r.gate.name + (r.gate.env?.CHECK_TARGETS ? ` [${r.gate.env.CHECK_TARGETS}]` : '') + (r.gate.env?.CHECK_QUICK ? ' [quick]' : '')).padEnd(34)} ${String(r.ms).padStart(6)}ms  ${r.ok ? r.summary : ''}\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(POOL, gates.length) }, worker));

const ordered = gates.map((g) => results.find((r) => r.gate === g)!);
if (TRACE) {
  const { gateDeps } = await import('./gate-deps.ts');
  for (const r of ordered) {
    let traced: string[] = [];
    try { traced = readFileSync(traceFile(r.gate), 'utf8').split('\n').filter(Boolean); } catch { continue; }
    const deps = gateDeps(r.gate.args.find((a) => a.endsWith('.ts'))!, r.gate.reads);
    const missing = traced.filter((f) => !deps.has(f));
    if (!missing.length) continue;
    r.ok = false;
    r.output += `\n✗ gate-deps: the gate opened ${missing.length} repository file(s) test/gate-deps.ts does not derive for it, so \`check.ts --changed\` could skip it wrongly: ${missing.join(', ')}\n  name each in the gate's \`reads\` (test/check.ts), or make the path a literal in the gate's source`;
  }
  rmSync(TRACE, { recursive: true, force: true });
}
const failed = ordered.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(70)}`);
console.log(`  ${ordered.length - failed.length}/${ordered.length} gates pass` + (failed.length ? `  — FAILED: ${failed.map((f) => f.gate.name).join(', ')}` : ' ✓'));
for (const f of failed) {
  console.log(`\n── ✗ ${f.gate.name} (node ${f.gate.args.join(' ')}) ──`);
  console.log(f.output.trimEnd().split('\n').slice(-25).join('\n'));
}
process.exit(failed.length ? 1 : 0);
