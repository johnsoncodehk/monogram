// Gate: the EMITTED parser (emit-parser.ts) is type-checked TypeScript.
//
// emitParser produces a standalone TS module — explicit types on every declaration
// (the monomorphic Doc state struct, the matcher/runtime signatures, the baked op /
// rule tables). This gate compiles that module under `tsc --strict --noEmit` and
// fails on ANY diagnostic. Two properties it guards by construction:
//   - the type CONTRACT is real and consistent (no implicit any, no arity looseness,
//     no shape drift between the swapped buffers and the doc struct) — the part that
//     ports to a Go/Rust target;
//   - the emitted source stays ERASABLE TypeScript (annotations only): Node runs the
//     emitted parser by stripping types, and the CST-identity gate (emit-parser-verify)
//     proves the stripped runtime is byte-for-byte the interpreter.
//
// SCOPE: the self-contained emit path — soa token columns + an emitted lexer — which
// is every grammar WITHOUT markup / indent / newline modes (emitLexer covers them).
// The ts/js family (+ the jsx/tsx variants) goes through it and is enforced here.
// yaml / html take the FALLBACK path (emitLexer returns null → the parser imports
// createLexer) plus the non-soa piece-text layer; that path carries additional
// untyped surface and a pre-existing latent scope issue the gate surfaced (the
// non-soa editCore branch references cs/ceOld/parenCachePos declared only in the soa
// branch). Typing it is tracked separately — listed as DEFERRED below, not silently
// dropped.
import { emitParser } from '../src/emit-parser.ts';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { CstGrammar } from '../src/types.ts';

// Enforced: the self-contained soa + emitted-lexer path.
const CHECKED: Array<[string, string]> = [
  ['typescript', '../typescript.ts'],
  ['javascript', '../javascript.ts'],
  ['typescriptreact', '../typescriptreact.ts'],
  ['javascriptreact', '../javascriptreact.ts'],
];
// Deferred: the fallback-lexer / non-soa path (logged, not gated yet).
const DEFERRED = ['yaml', 'html'];

const TSC_FLAGS = [
  '--strict', '--noEmit', '--target', 'ES2022',
  '--module', 'ES2022', '--moduleResolution', 'Bundler', '--skipLibCheck',
];

let failures = 0;
for (const [name, path] of CHECKED) {
  let grammar: CstGrammar;
  try {
    grammar = (await import(path)).default;
  } catch {
    console.log(`  ${name}: (grammar not present — skipped)`);
    continue;
  }
  const out = `/tmp/emit-tsc-gate-${name}.ts`;
  writeFileSync(out, emitParser(grammar));
  try {
    execFileSync('npx', ['tsc', ...TSC_FLAGS, out], { stdio: 'pipe' });
    console.log(`  ${name}: ✓ emitted parser type-checks (tsc --strict)`);
  } catch (e: any) {
    failures++;
    const log = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
    const errs = log.split('\n').filter((l: string) => l.includes('error TS'));
    console.log(`  ${name}: ✗ ${errs.length} tsc error(s):`);
    for (const l of errs.slice(0, 30)) console.log(`      ${l.replace(out, `emit(${name})`)}`);
    if (errs.length > 30) console.log(`      … and ${errs.length - 30} more`);
  }
}
console.log(`  deferred (fallback-lexer / non-soa path, not yet typed): ${DEFERRED.join(', ')}`);

if (failures > 0) {
  console.error(`\n✗ emitted parser fails strict type-check for ${failures} grammar(s)`);
  process.exit(1);
}
console.log('\n✓ emitted parser type-checks under tsc --strict (soa + emitted-lexer family)');
