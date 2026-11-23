// The generated-artifact drift step, by changed inputs (ci.yml "Generate editor artifacts"):
// `npm run gen` is a list of steps (package.json "gen": `node … <script> [<grammar>] …` joined by
// &&); a step runs only when one of its inputs changed since the merge base with master, where its
// inputs are what test/gate-deps.ts derives for its script (and, for src/cli.ts, the grammar it is
// given). The workflow then diffs the committed artifacts as before: a step that did not run left its
// committed artifacts as they are, which is what it would have written, since nothing it reads changed.
//   node test/gen-changed.ts [<base>]   the steps whose inputs changed since <base> (default origin/master)
//   node test/gen-changed.ts --all       every step (master pushes: the full regeneration)
//   node test/gen-changed.ts --list ...  only print which steps would run and why
// Also run every step: a change to package.json, to this script or to test/gate-deps.ts, and a change
// to a committed artifact itself (a hand edit must be regenerated over to be seen).
// A skipped src/cli.ts step still writes its grammar's gitignored `<name>.cst-match.ts` (the gates
// import it), from generateCstMatch alone.
// With GEN_TRACE_DEPS=1 (CI) every step that runs is traced (test/trace-reads.ts) and the run fails
// when the step read a repository file that is not among its derived inputs: the check that keeps a
// skip sound, exercised on every step by the full regeneration of each master push.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ROOT, edges, gateDeps } from './gate-deps.ts';

// The committed outputs (ci.yml's `git diff --exit-code` pathspecs, as regular expressions).
const ARTIFACT = /^(?:[^/]+\.(?:tmLanguage|language-configuration|monarch|contributes)\.json|tree-sitter\/.*|docs\/COMPLETENESS\.md|docs\/decisions\/.*|test\/fixtures\/decisionsjs\.decisions\.md)$/;
const GLOBAL = ['package.json', 'package-lock.json', 'test/gen-changed.ts', 'test/gate-deps.ts'];

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const listOnly = argv.includes('--list');
const base = argv.find((a) => !a.startsWith('--')) ?? 'origin/master';
const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const changedNow = (): Set<string> => new Set([
  ...git('diff', '--name-only', git('merge-base', base, 'HEAD')[0]!),
  ...git('ls-files', '--others', '--exclude-standard'),
]);

type Step = { argv: string[]; script: string; grammar?: string; inputs: Set<string> };
const steps: Step[] = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.gen as string).split('&&').map((s) => {
  const words = s.trim().split(/\s+/);
  if (words[0] !== 'node') throw new Error(`gen-changed: a gen step that is not \`node …\`: ${s.trim()}`);
  const files = words.slice(1).filter((w) => !w.startsWith('-'));
  const script = files[0]!;
  const grammar = script === 'src/cli.ts' ? files[1] : undefined;
  // src/cli.ts names its outputs and its grammar through the grammar's name (`${langName}.cst-match.ts`),
  // literals that would make every grammar an input of every step: its inputs are its own modules'
  // and its one grammar's
  const inputs = grammar ? new Set([script, ...edges(script).filter((f) => f.startsWith('src/')).flatMap((f) => [...gateDeps(f)]), ...gateDeps(grammar)]) : gateDeps(script);
  return { argv: words.slice(1), script, grammar, inputs };
});

const TRACE = process.env.GEN_TRACE_DEPS === '1' ? mkdtempSync(join(tmpdir(), 'monogram-gen-trace-')) : null;
let changed = all ? new Set<string>() : changedNow();
const global = all ? ['--all'] : [...GLOBAL.filter((f) => changed.has(f)), ...[...changed].filter((f) => ARTIFACT.test(f)).slice(0, 1).map((f) => `artifact ${f}`)];
console.log(`gen-changed: ${all ? 'every step' : `${changed.size} file(s) changed since ${base}`}${global.length && !all ? ` (every step: ${global.join(', ')})` : ''}`);
const untraced: string[] = [];
for (const [i, st] of steps.entries()) {
  const label = st.argv.filter((w) => !w.startsWith('-')).join(' ');
  const hit = global.length ? global[0] : [...changed].find((f) => st.inputs.has(f));
  if (hit) {
    console.log(`  run  ${label}   (${hit === global[0] ? hit : `input ${hit}`})`);
    if (listOnly) continue;
    const trace = TRACE ? join(TRACE, String(i)) : null;
    // under /usr/bin/time where it exists: `generate <command>: wall, CPU, peak memory` (CI reads it)
    const node = ['node', ...(trace ? ['--import', './test/trace-reads.ts'] : []), ...st.argv];
    const cmd = existsSync('/usr/bin/time') ? ['/usr/bin/time', '-f', `generate node ${st.argv.join(' ')}: %e s wall, %U s user, %M KB peak`, ...node] : node;
    execFileSync(cmd[0]!, cmd.slice(1), { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...(trace ? { CHECK_TRACE: trace } : {}) } });
    if (trace) {
      // a gitignored <g>.cst-match.ts stands for its grammar <g>.ts (it is generated from it)
      // (the committed artifacts are outputs: the trace sees a write as an open)
      const extra = readFileSync(trace, 'utf8').split('\n').filter((f) => f && !ARTIFACT.test(f) && !st.inputs.has(f.replace(/\.cst-match\.ts$/, '.ts')));
      for (const f of extra) untraced.push(`${label}: read ${f}, which is not among its ${st.inputs.size} derived inputs`);
    }
    // what this step wrote is an input of the steps after it (tm-completeness reads the TextMate grammars)
    if (!all) changed = new Set([...changed, ...changedNow()]);
    continue;
  }
  console.log(`  skip ${label}   (none of its ${st.inputs.size} input file(s) changed)`);
  if (!listOnly) console.log(`generate node ${st.argv.join(' ')}: skipped`);
  if (st.grammar && !listOnly) {
    // the gitignored per-arm destructurers the gates import, as src/cli.ts names and writes them
    const { generateCstMatch } = await import('../src/gen-cst-match.ts');
    const grammar = (await import(resolve(ROOT, st.grammar))).default;
    const name = grammar.name ?? basename(st.grammar, '.ts');
    grammar.name = name;
    const text = generateCstMatch(grammar);
    writeFileSync(join(ROOT, dirname(st.grammar), `${name}.cst-match.ts`), text.endsWith('\n') ? text : text + '\n');
  }
}
if (TRACE) rmSync(TRACE, { recursive: true, force: true });
if (untraced.length) {
  for (const u of untraced) console.error(`  ✗ ${u}`);
  console.error('gen-changed: a step reads a file test/gate-deps.ts does not derive for it, so a change to that file would skip the step: make the read derivable (a literal path, or an import)');
  process.exit(1);
}
