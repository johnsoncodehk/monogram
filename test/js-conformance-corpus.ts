// ─────────────────────────────────────────────────────────────────────────────
//  js-conformance-corpus.ts — the JavaScript grammar against tsc's JS-mode parser over the
//  pinned TypeScript conformance corpus (every single-file case under
//  /tmp/ts-repo/tests/cases/conformance, parsed as a .js file).
//
//  The corpus is TypeScript, and tsc's JS-mode parser is lenient: it parses type annotations,
//  `interface`, `enum`, `namespace`, `as`, ... and reports them afterwards as "... can only be
//  used in TypeScript files" (the diagnostics tsc's program reports for a .js file, codes
//  8000-8999). The JS grammar has no such productions. So "tsc accepts, we reject" is split by
//  tsc's own rule, not by a guess, into a cell per verdict pair:
//
//    tsc's verdict on the file as JavaScript       ×   monogram's JS grammar
//      js        tsc parses it, no diagnostic at all       accept | reject
//      ts-only   tsc parses it, reports TS-only syntax     accept | reject
//      js-error  tsc parses it, reports another JS-only    accept | reject
//                syntactic error (e.g. a misplaced decorator)
//      reject    tsc's parser reports a parse error        accept | reject
//
//  Agreement is js/accept, ts-only/reject, js-error/reject and reject/reject. Every other cell
//  is a disagreement and is listed by file: js/reject are candidate gaps (valid JavaScript per
//  tsc that the grammar rejects; tsc defers some non-JS forms, e.g. a class member's `export`
//  modifier, to its checker, so a file here still needs its derivation read before it is called
//  a gap), and the accept cells of ts-only / js-error / reject are over-acceptance.
//
//  Three outcomes are NOT verdicts, and each is reported as itself:
//    - the corpus is absent → the gate says NOT RUN and fails (it never passes unrun);
//    - tsc throws on a file (an oracle crash) → the file is excluded by name, and only if it is
//      listed in ORACLE_CRASHES below; an unlisted crash, or a listed file that no longer
//      crashes, fails the gate;
//    - monogram throws something that is not an input error (a crash) → its own cell,
//      `monogram-crash`, listed by file with the error.
//
//  The record: docs/JS-CONFORMANCE.md (generated, committed) holds every cell's count and every
//  disagreeing file. The gate regenerates it and fails on ANY difference, naming each file
//  that moved: a file entering a disagreement cell is a regression, a file leaving one is an
//  improvement that must be recorded. A grammar change that moves files is reviewed as the
//  regenerated record's diff.
//
//  Run (bare node):
//    node test/js-conformance-corpus.ts            # gate: fail if the record is stale
//    node test/js-conformance-corpus.ts --write    # (re)write docs/JS-CONFORMANCE.md
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createParser } from '../src/gen-parser.ts';
import { isInputError } from './input-error.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = join(ROOT, 'docs/JS-CONFORMANCE.md');
const REPO = '/tmp/ts-repo';
const BASE = `${REPO}/tests/cases/conformance`;
const WRITE = process.argv.includes('--write');

// Files tsc itself throws on in JS mode (a TypeScript bug, owned upstream). Each is excluded from
// the matrix by name; the gate fails if one stops throwing this error or an unlisted one throws.
const ORACLE_CRASHES: Record<string, { error: string; why: string }> = {
  'decorators/invalid/decoratorOnAwait.ts': {
    error: 'Debug Failure. False expression.',
    why: '`@dec await 1`: parseDeclaration reads `await` after a decorator as the start of an `await using` declaration, and parseVariableDeclarationList asserts isAwaitUsingDeclaration()',
  },
};

if (!existsSync(BASE)) {
  console.error(`✗ NOT RUN: the pinned TypeScript corpus is absent at ${BASE}.`);
  console.error('  Provision it as CI does (.github/workflows/ci.yml, "Clone the pinned TS corpus").');
  process.exit(1);
}
const corpusSha = readFileSync(`${REPO}/.git/HEAD`, 'utf8').trim();

const { parse } = createParser((await import('../javascript.ts')).default);

type Ours = { verdict: 'accept' | 'reject' } | { verdict: 'crash'; error: string };
const ours = (code: string): Ours => {
  try { parse(code); return { verdict: 'accept' }; }
  catch (e) { return isInputError(e) ? { verdict: 'reject' } : { verdict: 'crash', error: `${(e as Error)?.constructor?.name}: ${String((e as Error)?.message ?? e).slice(0, 120)}` }; }
};

// tsc's verdict on the text as a .js file: its parse diagnostics, then (for a parsed file) the
// JS-only syntactic diagnostics its program reports for .js files. The single-file program has
// no lib and resolves nothing: only syntactic diagnostics are asked for.
type Theirs = { verdict: 'js' | 'ts-only' | 'js-error' | 'reject' } | { verdict: 'oracle-crash'; error: string };
const theirs = (code: string): Theirs => {
  let sf: ts.SourceFile;
  try { sf = ts.createSourceFile('/t.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); }
  catch (e) { return { verdict: 'oracle-crash', error: String((e as Error)?.message ?? e).split('\n')[0] }; }
  if (((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length) return { verdict: 'reject' };
  const host: ts.CompilerHost = {
    getSourceFile: (n) => (n === sf.fileName ? sf : undefined), fileExists: (n) => n === sf.fileName, readFile: () => undefined,
    writeFile: () => {}, getDefaultLibFileName: () => '/lib.d.ts', useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (n) => n, getCurrentDirectory: () => '/', getNewLine: () => '\n',
  };
  const program = ts.createProgram({ rootNames: [sf.fileName], options: { allowJs: true, noLib: true, noResolve: true, types: [] }, host });
  const codes = program.getSyntacticDiagnostics(sf).map((d) => d.code);
  if (codes.some((c) => c >= 8000 && c < 9000)) return { verdict: 'ts-only' };
  return { verdict: codes.length ? 'js-error' : 'js' };
};

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const f = join(d, e.name);
  return e.isDirectory() ? walk(f) : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [f] : [];
});
const isMulti = (t: string) => /^\s*\/\/\s*@filename:/im.test(t);

// ── measure ──
const CELLS = [
  // [cell, agrees, meaning]
  ['js/accept', true, 'valid JavaScript per tsc, accepted'],
  ['js/reject', false, 'valid JavaScript per tsc, rejected: candidate gaps (read each derivation)'],
  ['ts-only/reject', true, 'TypeScript-only syntax per tsc, rejected'],
  ['ts-only/accept', false, 'TypeScript-only syntax per tsc, accepted: over-acceptance'],
  ['js-error/reject', true, 'a JS-only syntactic error per tsc, rejected'],
  ['js-error/accept', false, 'a JS-only syntactic error per tsc, accepted: over-acceptance'],
  ['reject/reject', true, 'a tsc parse error, rejected'],
  ['reject/accept', false, 'a tsc parse error, accepted: over-acceptance'],
  ['monogram-crash', false, 'monogram threw something other than an input error: a bug'],
] as const;
type Cell = (typeof CELLS)[number][0];
const cells = new Map<Cell, string[]>(CELLS.map(([c]) => [c, []]));
const crashNotes = new Map<string, string>();
const oracleCrashed = new Map<string, string>();
let multi = 0;
const t0 = performance.now();
for (const f of walk(BASE).sort()) {
  const code = readFileSync(f, 'utf8');
  if (isMulti(code)) { multi++; continue; }
  const name = f.slice(BASE.length + 1);
  const t = theirs(code);
  if (t.verdict === 'oracle-crash') { oracleCrashed.set(name, t.error); continue; }
  const o = ours(code);
  if (o.verdict === 'crash') { cells.get('monogram-crash')!.push(name); crashNotes.set(name, o.error); continue; }
  cells.get(`${t.verdict}/${o.verdict}` as Cell)!.push(name);
}
const ms = performance.now() - t0;

// ── the oracle-crash list is pinned in code, not in the record ──
const crashFailures: string[] = [];
for (const [name, error] of oracleCrashed) {
  const pin = ORACLE_CRASHES[name];
  if (!pin) crashFailures.push(`tsc throws on an unlisted file: ${name} (${error}) — list it in ORACLE_CRASHES with its cause`);
  else if (pin.error !== error) crashFailures.push(`tsc throws a different error on ${name}: ${error} (listed: ${pin.error})`);
}
for (const name of Object.keys(ORACLE_CRASHES)) {
  if (!oracleCrashed.has(name)) crashFailures.push(`a listed oracle crash no longer throws: ${name} — remove it from ORACLE_CRASHES; the file is measured again`);
}

// ── render the record ──
const measured = [...cells.values()].reduce((n, l) => n + l.length, 0);
const agree = CELLS.filter(([, a]) => a).reduce((n, [c]) => n + cells.get(c)!.length, 0);
const L: string[] = [];
L.push('# JS-CONFORMANCE — the JavaScript grammar against tsc\'s JS-mode parser (auto-generated)');
L.push('');
L.push('<!-- AUTO-GENERATED by `node test/js-conformance-corpus.ts --write`. Do not edit by hand. -->');
L.push('');
L.push('Every single-file case of the pinned TypeScript conformance corpus, parsed as a `.js` file by');
L.push('tsc and by `javascript.ts`. tsc\'s verdict is its parse diagnostics, then the JS-only syntactic');
L.push('diagnostics its program reports for a `.js` file; codes 8000-8999 ("... can only be used in');
L.push('TypeScript files") mark TypeScript-only syntax, which the JS grammar has no production for.');
L.push('The cells and the rules are documented in `test/js-conformance-corpus.ts`; the gate fails when');
L.push('this record is stale, so every file that moves between cells shows in its diff.');
L.push('');
L.push(`Corpus: \`microsoft/TypeScript@${corpusSha}\` \`tests/cases/conformance\` · oracle: \`typescript@${ts.version}\``);
L.push('');
L.push(`**${measured} files measured**, ${agree} agree (${(100 * agree / measured).toFixed(2)}%) · ${multi} multi-file cases skipped · ${Object.keys(ORACLE_CRASHES).length} excluded as oracle crashes (\`ORACLE_CRASHES\` in the test, by name).`);
L.push('');
L.push('| cell (tsc / monogram) | files | |');
L.push('|---|---:|---|');
for (const [c, a, meaning] of CELLS) L.push(`| \`${c}\` | ${cells.get(c)!.length} | ${a ? 'agree' : '**disagree**'}: ${meaning} |`);
for (const [c, a, meaning] of CELLS) {
  if (a) continue;
  L.push('');
  L.push(`## \`${c}\` (${cells.get(c)!.length})`);
  L.push('');
  L.push(`${meaning[0].toUpperCase()}${meaning.slice(1)}.`);
  L.push('');
  const l = cells.get(c)!;
  if (!l.length) L.push('_None._');
  for (const f of l) L.push(`- \`${f}\`${crashNotes.has(f) ? ` — ${crashNotes.get(f)}` : ''}`);
}
L.push('');
const record = L.join('\n');

// ── report ──
console.log(`── JS grammar vs tsc JS-mode, TS conformance corpus (${measured} files, ${(ms / 1000).toFixed(1)}s) ──`);
for (const [c, a] of CELLS) console.log(`  ${c.padEnd(16)} ${String(cells.get(c)!.length).padStart(5)}  ${a ? 'agree' : 'disagree'}`);
console.log(`  oracle crashes excluded: ${[...oracleCrashed.keys()].join(', ') || 'none'}`);
for (const m of crashFailures) console.log(`  ✗ ${m}`);

if (WRITE) {
  writeFileSync(RECORD, record);
  console.log(`\n✓ wrote ${RECORD.slice(ROOT.length + 1)}`);
  process.exit(crashFailures.length ? 1 : 0);
}

// Which file moved: read the committed record's per-cell lists.
const committed = existsSync(RECORD) ? readFileSync(RECORD, 'utf8') : '';
const stale = committed !== record;
if (stale) {
  const before = new Map<string, string>();
  let cur = '';
  for (const line of committed.split('\n')) {
    const h = /^## `([^`]+)`/.exec(line);
    if (h) { cur = h[1]; continue; }
    const m = /^- `([^`]+)`/.exec(line);
    if (m && cur) before.set(m[1], cur);
  }
  const after = new Map<string, string>();
  for (const [c, a] of CELLS) if (!a) for (const f of cells.get(c)!) after.set(f, c);
  console.log(`\n✗ ${RECORD.slice(ROOT.length + 1)} is stale${committed ? '' : ' (absent)'}:`);
  for (const [f, c] of after) if (before.get(f) !== c) console.log(`  regression: ${f} → ${c}${before.has(f) ? ` (was ${before.get(f)})` : ''}`);
  for (const [f, c] of before) if (!after.has(f)) console.log(`  improvement: ${f} left ${c}`);
  console.log('  (a change in a count, the corpus revision or the tsc version also makes it stale)');
  console.log('  review the moves, then record them: node test/js-conformance-corpus.ts --write');
}
if (stale || crashFailures.length) process.exit(1);
console.log(`\n✓ JS corpus matrix matches ${RECORD.slice(ROOT.length + 1)} (${agree}/${measured} agree)`);
