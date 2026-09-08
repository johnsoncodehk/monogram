// Gate: a createLexer-FALLBACK grammar (indent / newline / markup) can be emitted as a STANDALONE
// module — `emitParser(grammar, jsTarget, { lexerRuntime: 'inline' })`.
//
// By default such a grammar's emitted parser imports the data-driven lexer runtime from THIS
// repo by absolute path (`import { createLexer } from "…/src/gen-lexer.ts"`), which is right for
// the in-repo gates and wrong for anyone shipping the emitted file: it only loads on the machine
// that emitted it. 'inline' copies the runtime into the module; `{ import: spec }` writes a
// caller-owned specifier instead. This gate proves, for YAML and HTML:
//   1. the inline module has NO import statement at all, and loads from a directory outside the repo;
//   2. it parses byte-identically to the interpreter (the same trees the import path produces);
//   3. it type-checks under `tsc --strict` WITHOUT --allowImportingTsExtensions (no .ts import remains);
//   4. `{ import }` writes exactly the given specifier, and the default is unchanged.
//
// Run with: node test/emit-standalone.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { emitParser, jsTarget } from '../src/emit.ts';
import { createParser } from '../src/gen-parser.ts';
import { objectify } from './emitted-obj.ts';
import type { CstGrammar } from '../src/types.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { if (cond) ok++; else { fail++; console.log('  ✗', label); } };

const SAMPLES: Record<string, string[]> = {
  yaml: ['a: 1\nb:\n  - x\n  - y\nc: {k: v, n: [1, 2]}\n', '# comment\nkey: "quoted"\nblock: |\n  line one\n  line two\n', 'a:\n'],
  html: ['<div class="a">hi<br>there</div>', '<!-- c --><p>a < b</p><script>if (a < b) {}</script>', '<ul><li>one</li><li>two</li></ul>', '<p>unclosed <b>bold'],
};

// A directory OUTSIDE the repo: a relative or absolute import into src/ cannot resolve from here by accident.
const dir = mkdtempSync(join(tmpdir(), 'monogram-standalone-'));
const TSC_FLAGS = ['--strict', '--noEmit', '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler', '--skipLibCheck'];

for (const [name, samples] of Object.entries(SAMPLES)) {
  let grammar: CstGrammar;
  try { grammar = (await import(`../${name}.ts`)).default; } catch { console.log(`  ${name}: (grammar not present — skipped)`); continue; }
  check(`${name}: is a createLexer-fallback grammar (embedLexer is null)`, jsTarget.embedLexer(grammar) === null);

  // ── default: unchanged (absolute import into this repo) ──
  const dflt = emitParser(grammar, jsTarget);
  check(`${name}: default still imports createLexer by absolute path`, /^import \{ createLexer \} from "\/.*\/src\/gen-lexer\.ts";$/m.test(dflt));

  // ── { import: spec }: the caller's specifier, verbatim ──
  const spec = emitParser(grammar, jsTarget, { lexerRuntime: { import: 'monogram/lexer' } });
  check(`${name}: { import } writes the given specifier`, spec.includes('import { createLexer } from "monogram/lexer";'));
  check(`${name}: { import } output is otherwise the default output`, spec.replace('"monogram/lexer"', '__X__') === dflt.replace(/"\/.*\/src\/gen-lexer\.ts"/, '__X__'));

  // ── 'inline': standalone ──
  const inline = emitParser(grammar, jsTarget, { lexerRuntime: 'inline' });
  check(`${name}: inline output has no import statement`, !/^import\s/m.test(inline));
  check(`${name}: inline output has no export but the parser API (no runtime export leaked)`, !/^export (function|const) (createLexer|collectLiterals|tokenPatternSource)\b/m.test(inline));
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, inline);
  let mod: any = null;
  try { mod = await import(file + '?v=' + Date.now()); } catch (e) { console.log(`  ${name}: inline module failed to load: ${(e as Error).message.split('\n')[0]}`); }
  check(`${name}: inline module loads from outside the repo`, !!mod);
  if (!mod) continue;

  // The claim is inline ≡ the default (import-path) emitted engine, tree AND errors, on valid and
  // broken input alike; and where that engine parses cleanly, ≡ the interpreter too (emit-parser-verify
  // owns emitted-vs-interpreter parity in general; recovery output is the emitted engine's own).
  const dfltFile = join(dir, `${name}-default-import.ts`);
  writeFileSync(dfltFile, dflt.replace(/^import \{ createLexer \} from "(\/.*\/src\/gen-lexer\.ts)";$/m, (_m, p) => `import { createLexer } from ${JSON.stringify(p)};`));
  const pd = (await import(dfltFile + '?v=' + Date.now())).createParser();
  const interp = createParser(grammar);
  const p = mod.createParser();
  const treeOf = (parser: any, src: string) => { const cst = parser.parse(src); const obj = objectify(parser.tree, (fns: any) => parser.visit(cst, fns)); return JSON.stringify({ ...obj, errors: cst.errors }); };
  for (const src of samples) {
    const viaInline = treeOf(p, src), viaImport = treeOf(pd, src);
    check(`${name}: inline ≡ default emitted engine for ${JSON.stringify(src.slice(0, 24))}`, viaInline === viaImport);
    if (JSON.parse(viaImport).errors.length === 0) {
      check(`${name}: inline ≡ interpreter on the clean parse of ${JSON.stringify(src.slice(0, 24))}`, viaInline === JSON.stringify(interp.parseTotal(src)));
    }
  }

  try {
    execFileSync('npx', ['tsc', ...TSC_FLAGS, file], { stdio: 'pipe' });
    check(`${name}: inline module type-checks (tsc --strict, no --allowImportingTsExtensions)`, true);
  } catch (e: any) {
    const log = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
    console.log(log.split('\n').slice(0, 8).join('\n'));
    check(`${name}: inline module type-checks (tsc --strict, no --allowImportingTsExtensions)`, false);
  }
}

// ── A self-contained grammar (specialized lexer embedded) ignores the option: byte-identical output ──
{
  let ts: CstGrammar | null = null;
  try { ts = (await import('../typescript.ts')).default; } catch { console.log('  typescript: (grammar not present — skipped)'); }
  if (ts) {
    check('typescript: embeds its own lexer (not a fallback grammar)', jsTarget.embedLexer(ts) !== null);
    const base = emitParser(ts, jsTarget);
    check("typescript: lexerRuntime 'inline' is a no-op (byte-identical output)", emitParser(ts, jsTarget, { lexerRuntime: 'inline' }) === base);
    check("typescript: lexerRuntime { import } is a no-op (byte-identical output)", emitParser(ts, jsTarget, { lexerRuntime: { import: 'monogram/lexer' } }) === base);
  }
}

console.log(`\n${ok}/${ok + fail} standalone-emit checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
