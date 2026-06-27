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
// Both emit paths are covered: the self-contained path (soa columns + an emitted
// lexer — the ts/js family) and the fallback path (yaml/html: emitLexer returns null
// so the parser imports createLexer, plus the non-soa piece-text layer). Checking
// every grammar is what forces grammar-specific emission (token width, soa vs piece
// layer, empty vocab sets, the fallback createLexer contract) to stay type-sound —
// and it already paid off: the fallback editCore branch referenced cs/ceOld/
// parenCachePos declared only in the soa branch (unreached at runtime, invisible
// until this gate), now hoisted/gated correctly.
import { emitParser, jsTarget } from '../src/emit.ts';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { CstGrammar } from '../src/types.ts';

const GRAMMARS: Array<[string, string]> = [
  ['typescript', '../typescript.ts'],
  ['javascript', '../javascript.ts'],
  ['typescriptreact', '../typescriptreact.ts'],
  ['javascriptreact', '../javascriptreact.ts'],
  ['yaml', '../yaml.ts'],
  ['html', '../html.ts'],
];

// --allowImportingTsExtensions: the fallback-lexer grammars import createLexer from
// '…/src/gen-lexer.ts' (an absolute path baked at emit time); harmless for the
// self-contained grammars, which import nothing.
const TSC_FLAGS = [
  '--strict', '--noEmit', '--target', 'ES2022', '--module', 'ES2022',
  '--moduleResolution', 'Bundler', '--skipLibCheck', '--allowImportingTsExtensions',
];

let failures = 0;
for (const [name, path] of GRAMMARS) {
  let grammar: CstGrammar;
  try {
    grammar = (await import(path)).default;
  } catch {
    console.log(`  ${name}: (grammar not present — skipped)`);
    continue;
  }
  const out = `/tmp/emit-tsc-gate-${name}.ts`;
  writeFileSync(out, emitParser(grammar, jsTarget));
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

if (failures > 0) {
  console.error(`\n✗ emitted parser fails strict type-check for ${failures} grammar(s)`);
  process.exit(1);
}
console.log('\n✓ emitted parser type-checks under tsc --strict for every grammar');
