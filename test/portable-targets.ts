// Gate: the TARGET-AGNOSTIC emitter (issue #6) — `emitPortableParser(grammar, target)`
// derives a parser in EACH target language that produces the byte-identical CST the
// interpreter (createParser) does. This is the agnosticism proof by EXECUTION: the same
// examples/calc.ts grammar is rendered to TypeScript, Go, and Rust; the Go and Rust
// sources are COMPILED and RUN, and every parser's CST output is compared, node-for-node,
// against the createParser oracle over an adversarial corpus (operator precedence /
// associativity, prefix chains, nested grouping, multi-statement programs, and the empty
// program), plus reject-parity on malformed input.
//
// Go/Rust toolchains are optional: a missing `go` or `rustc` is logged and skipped (the
// TS rendering, which needs only node, always runs) — the same graceful-degrade pattern
// the external-corpus gates use, so this stays green on a machine without them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createParser } from '../src/gen-parser.ts';
import { emitPortableParser } from '../src/emit-portable.ts';
import { tsTarget } from '../src/target-ts.ts';
import { goTarget } from '../src/target-go.ts';
import { rustTarget } from '../src/target-rust.ts';

const grammar = (await import('../examples/calc.ts')).default;
const oracle = createParser(grammar);

// Accepted inputs — each must parse to the SAME CST in every language.
const ACCEPT = [
  '1;', 'a;', '',                               // atoms + the empty program
  '1 + 2 * 3;', '1 * 2 + 3;',                   // precedence both directions
  '1 - 2 - 3;', 'a / b / c;', '1 + 2 + 3 + 4;', // left-associativity
  '-a;', '-(-a);', '- - a;',                    // prefix + prefix chains
  '-a * b;', '-a + b * c;', '-(a + b) * c;',    // prefix vs infix vs grouping
  '(1);', '((a));', '(1 + 2) * (3 - 4);',       // nested grouping
  'a * b + c * d - e / f;',                     // mixed precedence ladder
  'let x = 1; let y = x + 2 * x; (y);',         // multi-statement program
  'let z = -(a * b) / (c - -d);', 'foo; bar; baz;',
];
// Malformed inputs — every parser must REJECT (the oracle throws; the emitted parsers exit 1).
const REJECT = ['1 +;', '(1;', '1 2;', 'let = 1;', ') ;', '* a;', 'let x 1;'];

type Json = unknown;
const sortKeys = (o: Json): Json =>
  Array.isArray(o) ? o.map(sortKeys)
  : (o && typeof o === 'object') ? Object.fromEntries(Object.keys(o as object).sort().map((k) => [k, sortKeys((o as Record<string, Json>)[k])]))
  : o;
const canon = (o: Json) => JSON.stringify(sortKeys(o));

function oracleOutcome(src: string): { ok: true; cst: string } | { ok: false } {
  try { return { ok: true, cst: canon(oracle.parse(src)) }; }
  catch { return { ok: false }; }
}

const TMP = '/tmp/portable-targets';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

function have(cmd: string, args: string[]): boolean {
  try { execFileSync(cmd, args, { stdio: 'pipe' }); return true; } catch { return false; }
}

// A runnable target: writes its source, (optionally) compiles, and returns a `run(src)->{ok,cst?}`.
type Runner = { label: string; run: (src: string) => { ok: true; cst: string } | { ok: false } };

function tsRunner(): Runner {
  const f = `${TMP}/calc.ts`;
  writeFileSync(f, emitPortableParser(grammar, tsTarget));
  return { label: 'typescript', run: (src) => runProc('node', [f], src) };
}
function goRunner(): Runner | null {
  if (!have('go', ['version'])) { console.log('  go: (toolchain absent — skipped)'); return null; }
  const dir = `${TMP}/go`; mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/main.go`, emitPortableParser(grammar, goTarget));
  writeFileSync(`${dir}/go.mod`, 'module calc\n\ngo 1.21\n');
  execFileSync('go', ['build', '-o', `${dir}/calc`, '.'], { cwd: dir, stdio: 'pipe' });
  return { label: 'go', run: (src) => runProc(`${dir}/calc`, [], src) };
}
function rustRunner(): Runner | null {
  if (!have('rustc', ['--version'])) { console.log('  rust: (toolchain absent — skipped)'); return null; }
  const dir = `${TMP}/rust`; mkdirSync(dir, { recursive: true });
  const f = `${dir}/main.rs`;
  writeFileSync(f, emitPortableParser(grammar, rustTarget));
  execFileSync('rustc', ['-O', f, '-o', `${dir}/calc`], { stdio: 'pipe' });
  return { label: 'rust', run: (src) => runProc(`${dir}/calc`, [], src) };
}
function runProc(cmd: string, args: string[], src: string): { ok: true; cst: string } | { ok: false } {
  try { return { ok: true, cst: canon(JSON.parse(execFileSync(cmd, args, { input: src, stdio: ['pipe', 'pipe', 'pipe'] }).toString())) }; }
  catch { return { ok: false }; }
}

const runners: Runner[] = [tsRunner(), goRunner(), rustRunner()].filter((r): r is Runner => r !== null);

let failures = 0;
for (const r of runners) {
  let acc = 0, rej = 0;
  for (const src of ACCEPT) {
    const want = oracleOutcome(src);
    const got = r.run(src);
    if (want.ok && got.ok && want.cst === got.cst) { acc++; continue; }
    failures++;
    console.log(`  ${r.label}: ACCEPT mismatch on ${JSON.stringify(src)}`);
    if (want.ok && got.ok) { console.log(`      want ${want.cst.slice(0, 140)}`); console.log(`      got  ${got.cst.slice(0, 140)}`); }
    else console.log(`      want.ok=${want.ok} got.ok=${got.ok}`);
  }
  for (const src of REJECT) {
    const want = oracleOutcome(src);
    const got = r.run(src);
    if (!want.ok && !got.ok) { rej++; continue; }
    failures++;
    console.log(`  ${r.label}: REJECT mismatch on ${JSON.stringify(src)} (oracle ok=${want.ok}, ${r.label} ok=${got.ok})`);
  }
  console.log(`  ${r.label}: ${acc}/${ACCEPT.length} accept ≡ oracle · ${rej}/${REJECT.length} reject ≡ oracle`);
}

if (failures > 0) {
  console.error(`\n✗ portable targets diverge from the interpreter (${failures} case(s))`);
  process.exit(1);
}
console.log(`\n✓ ${runners.map((r) => r.label).join(' + ')} parsers derived from one grammar ≡ interpreter CST (compiled & run)`);
