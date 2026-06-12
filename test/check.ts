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
import { execFileSync } from 'node:child_process';

interface Gate { group: string; name: string; args: string[] }
const GATES: Gate[] = [
  { group: 'core', name: 'sanity', args: ['test/sanity-check.ts'] },
  { group: 'core', name: 'agnostic', args: ['test/agnostic.ts'] },
  { group: 'core', name: 'refactor-guard', args: ['test/refactor-guard.ts'] },
  { group: 'core', name: 'cst-text-invariant', args: ['test/cst-text-invariant.ts'] },
  { group: 'core', name: 'adjacent', args: ['test/adjacent.ts'] },
  { group: 'conformance', name: 'ts-ast-structure', args: ['test/ts-ast-verify.ts'] },
  { group: 'core', name: 'cst-match-totality', args: ['test/cst-match-totality.ts'] },
  { group: 'core', name: 'incremental-verify', args: ['test/incremental-verify.ts'] },
  { group: 'core', name: 'multi-doc', args: ['test/multi-doc.ts'] },
  { group: 'core', name: 'issue-cases', args: ['test/test-issues.ts'] },
  { group: 'conformance', name: 'js', args: ['test/js-conformance.ts'] },
  { group: 'conformance', name: 'tsx', args: ['test/tsx-conformance.ts'] },
  { group: 'conformance', name: 'jsx', args: ['test/jsx-conformance.ts'] },
  { group: 'conformance', name: 'html', args: ['test/html-conformance.ts'] },
  { group: 'highlighter', name: 'tm-guards', args: ['test/tm-highlight-guards.ts'] },
  { group: 'highlighter', name: 'tm-diagnostics', args: ['test/redcmd-tm-diagnostics.ts'] },
  { group: 'highlighter', name: 'html-monarch', args: ['test/html-monarch.ts'] },
  { group: 'highlighter', name: 'html-embed-js', args: ['test/html-embed-js.ts'] },
  { group: 'highlighter', name: 'html-lexer-spike', args: ['test/html-lexer-spike.ts'] },
  { group: 'highlighter', name: 'self-close-sites', args: ['test/self-close-sites.ts'] },
  { group: 'highlighter', name: 'raw-text-case-sites', args: ['test/raw-text-case-sites.ts'] },
  { group: 'vue', name: 'directives', args: ['test/vue-directives.ts'] },
  { group: 'vue', name: 'embed-boundary', args: ['test/vue-embed-boundary.ts'] },
  { group: 'vue', name: 'interp-expr', args: ['test/vue-interp-expr.ts'] },
  { group: 'core', name: 'indent-extensions', args: ['test/indent-extensions.ts'] },
  { group: 'yaml', name: 'issue12-regressions', args: ['test/yaml-issue12-regressions.ts'] },
  { group: 'yaml', name: 'depth-witnesses', args: ['test/yaml-depth-witnesses.ts'] },
  { group: 'yaml', name: 'depth-sites', args: ['test/depth-sites.ts'] },
  { group: 'yaml', name: 'flow-sites', args: ['test/flow-sites.ts'] },
  { group: 'yaml', name: 'compact-nest-sites', args: ['test/compact-nest-sites.ts'] },
  { group: 'generative', name: 'scope≡role', args: ['test/generative.ts'] },
  { group: 'generative', name: 'gap-ledger-selftest', args: ['test/gap-ledger-selftest.ts'] },
  { group: 'generative', name: 'gap-ledger-check', args: ['test/gap-ledger.ts', '--check'] },
];

const filter = process.argv[2];
const gates = filter ? GATES.filter((g) => (g.group + ' ' + g.name).includes(filter)) : GATES;
if (!gates.length) { console.error(`no gate matches "${filter}"`); process.exit(1); }

const lastLine = (s: string): string => { const ls = s.trimEnd().split('\n').filter((l) => l.trim()); return ls.length ? ls[ls.length - 1].trim().slice(0, 70) : ''; };

interface Result { gate: Gate; ok: boolean; ms: number; summary: string; output: string }
const results: Result[] = [];
let curGroup = '';
for (const gate of gates) {
  if (gate.group !== curGroup) { curGroup = gate.group; process.stdout.write(`\n  ${curGroup}\n`); }
  const t0 = Date.now();
  let ok = true, output = '';
  try { output = execFileSync('node', gate.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }); }
  catch (e: any) { ok = false; output = (e.stdout ?? '') + (e.stderr ?? ''); }
  const ms = Date.now() - t0;
  const summary = lastLine(output);
  results.push({ gate, ok, ms, summary, output });
  process.stdout.write(`    ${ok ? '✓' : '✗'} ${gate.name.padEnd(22)} ${String(ms).padStart(6)}ms  ${ok ? summary : ''}\n`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(70)}`);
console.log(`  ${results.length - failed.length}/${results.length} gates pass` + (failed.length ? `  — FAILED: ${failed.map((f) => f.gate.name).join(', ')}` : ' ✓'));
for (const f of failed) {
  console.log(`\n── ✗ ${f.gate.name} (node ${f.gate.args.join(' ')}) ──`);
  console.log(f.output.trimEnd().split('\n').slice(-25).join('\n'));
}
process.exit(failed.length ? 1 : 0);
