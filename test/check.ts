// ─────────────────────────────────────────────────────────────────────────────
//  check.ts — the SINGLE gate runner. Runs every correctness GATE as a subprocess and
//  prints ONE ✓/✗ summary, exiting non-zero if any fails. `npm run check` answers
//  "is the repo healthy?" in one command + one output — instead of running a dozen
//  scripts with a dozen output formats. See TESTING.md for the report taxonomy
//  (gate / metric / ledger / bench); this runs the GATE tier (the CI-blocking pass/fail
//  checks that need no external corpus). Metrics live in the README coverage table
//  (`npm run coverage:table`), findings in the gap ledger (`KNOWN-GAPS.md`).
//
//  Assumes the generated grammars are current (`npm run gen`), as CI does before this.
//  Run:  node test/check.ts            # all gates
//        node test/check.ts yaml       # only gates whose group/name contains "yaml"
// ─────────────────────────────────────────────────────────────────────────────
import { execFile } from 'node:child_process';
import { cpus } from 'node:os';

interface Gate { group: string; name: string; args: string[] }
const GATES: Gate[] = [
  { group: 'core', name: 'sanity', args: ['test/sanity-check.ts'] },
  { group: 'core', name: 'agnostic', args: ['test/agnostic.ts'] },
  { group: 'core', name: 'refactor-guard', args: ['test/refactor-guard.ts'] },
  { group: 'core', name: 'cst-text-invariant', args: ['test/cst-text-invariant.ts'] },
  { group: 'conformance', name: 'ts-ast-structure', args: ['test/ts-ast-verify.ts'] },
  { group: 'core', name: 'cst-match-totality', args: ['test/cst-match-totality.ts'] },
  { group: 'core', name: 'incremental-verify', args: ['test/incremental-verify.ts'] },
  { group: 'emit-parity', name: 'emit-parser-verify', args: ['test/emit-parser-verify.ts'] },
  { group: 'emit-parity', name: 'emit-reject-messages', args: ['test/emit-reject-messages.ts'] },
  { group: 'emit-parity', name: 'emit-lexer-verify', args: ['test/emit-lexer-verify.ts'] },
  { group: 'core', name: 'multi-doc', args: ['test/multi-doc.ts'] },
  { group: 'core', name: 'recovery', args: ['test/recovery.ts'] },
  { group: 'core', name: 'incremental-grammars', args: ['test/incremental-grammars.ts'] },
  { group: 'core', name: 'exhaustive-edits', args: ['test/exhaustive-edits.ts'] },
  { group: 'core', name: 'issue-cases', args: ['test/test-issues.ts'] },
  { group: 'conformance', name: 'js', args: ['test/js-conformance.ts'] },
  { group: 'conformance', name: 'tsx', args: ['test/tsx-conformance.ts'] },
  { group: 'conformance', name: 'jsx', args: ['test/jsx-conformance.ts'] },
  { group: 'conformance', name: 'html', args: ['test/html-conformance.ts'] },
  { group: 'highlighter', name: 'tm-guards', args: ['test/tm-highlight-guards.ts'] },
  { group: 'highlighter', name: 'tm-completeness', args: ['test/tm-completeness.ts', '--check'] },
  { group: 'highlighter', name: 'tm-mutation', args: ['test/tm-mutation.ts'] },
  { group: 'highlighter', name: 'tm-diagnostics', args: ['test/redcmd-tm-diagnostics.ts'] },
  { group: 'highlighter', name: 'angle-depth', args: ['test/angle-depth-probe.ts'] },
  { group: 'highlighter', name: 'html-monarch', args: ['test/html-monarch.ts'] },
  { group: 'highlighter', name: 'html-embed-js', args: ['test/html-embed-js.ts'] },
  { group: 'highlighter', name: 'html-lexer-spike', args: ['test/html-lexer-spike.ts'] },
  { group: 'highlighter', name: 'self-close-sites', args: ['test/self-close-sites.ts'] },
  { group: 'highlighter', name: 'raw-text-case-sites', args: ['test/raw-text-case-sites.ts'] },
  { group: 'core', name: 'indent-extensions', args: ['test/indent-extensions.ts'] },
  { group: 'yaml', name: 'issue12-regressions', args: ['test/yaml-issue12-regressions.ts'] },
  { group: 'yaml', name: 'depth-witnesses', args: ['test/yaml-depth-witnesses.ts'] },
  { group: 'yaml', name: 'depth-sites', args: ['test/depth-sites.ts'] },
  { group: 'yaml', name: 'flow-sites', args: ['test/flow-sites.ts'] },
  { group: 'yaml', name: 'compact-nest-sites', args: ['test/compact-nest-sites.ts'] },
  { group: 'yaml', name: 'deepest-sibling', args: ['test/yaml-deepest-sibling-probe.ts'] },
  { group: 'yaml', name: 'blockscalar-depth', args: ['test/yaml-blockscalar-depth-probe.ts'] },
  { group: 'generative', name: 'scope≡role', args: ['test/generative.ts'] },
  { group: 'generative', name: 'gap-ledger-selftest', args: ['test/gap-ledger-selftest.ts'] },
  { group: 'generative', name: 'gap-ledger-check', args: ['test/gap-ledger.ts', '--check'] },
];

const filter = process.argv[2];
const gates = filter ? GATES.filter((g) => (g.group + ' ' + g.name).includes(filter)) : GATES;
if (!gates.length) { console.error(`no gate matches "${filter}"`); process.exit(1); }

const lastLine = (s: string): string => { const ls = s.trimEnd().split('\n').filter((l) => l.trim()); return ls.length ? ls[ls.length - 1].trim().slice(0, 70) : ''; };

interface Result { gate: Gate; ok: boolean; ms: number; summary: string; output: string }

// Each gate is an independent subprocess (it re-emits its own parser and reads its own
// corpus), so they run CONCURRENTLY across a worker pool — the gates share no mutable
// state and write DISTINCT /tmp/emitted-*.mjs files, so parallelism is safe and turns the
// wall-clock from sum-of-gates into ~max(sum/pool, slowest-gate). Results stream as each
// finishes (completion order); the final summary is printed in gate order.
function run(gate: Gate): Promise<Result> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    execFile('node', gate.args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = (stdout ?? '') + (stderr ?? '');
      resolve({ gate, ok: !err, ms: Date.now() - t0, summary: lastLine(output), output });
    });
  });
}

const POOL = Math.max(2, cpus().length - 2);
const results: Result[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (next < gates.length) {
    const gate = gates[next++];
    const r = await run(gate);
    results.push(r);
    process.stdout.write(`    ${r.ok ? '✓' : '✗'} ${(r.gate.group + '/' + r.gate.name).padEnd(34)} ${String(r.ms).padStart(6)}ms  ${r.ok ? r.summary : ''}\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(POOL, gates.length) }, worker));

const ordered = gates.map((g) => results.find((r) => r.gate === g)!);
const failed = ordered.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(70)}`);
console.log(`  ${ordered.length - failed.length}/${ordered.length} gates pass` + (failed.length ? `  — FAILED: ${failed.map((f) => f.gate.name).join(', ')}` : ' ✓'));
for (const f of failed) {
  console.log(`\n── ✗ ${f.gate.name} (node ${f.gate.args.join(' ')}) ──`);
  console.log(f.output.trimEnd().split('\n').slice(-25).join('\n'));
}
process.exit(failed.length ? 1 : 0);
