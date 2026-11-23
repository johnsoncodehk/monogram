// ─────────────────────────────────────────────────────────────────────────────
//  test262.ts — the JavaScript grammar against test262, the language's own conformance suite:
//  every test under test/language/ and test/annexB/language/ of the pinned tc39/test262 checkout
//  at /tmp/test262 (pin: test/test262.sha; CI clones it, locally run
//  ~/.cache/monogram-agents/restore-test262.sh <repo> or the clone step of .github/workflows/ci.yml).
//  test262 is used as DATA: test sources are parsed, never run, and none is copied into this repo.
//
//  The expected verdict comes from each test's front matter (`/*--- … ---*/`):
//    negative.phase == parse   the source must not parse (negative.type is SyntaxError)
//    anything else             it must parse (a resolution or runtime error still parses)
//  The runs test262 prescribes: `module` → the Module goal; otherwise a Script, in sloppy mode
//  (`noStrict`, `raw`), in strict mode (`onlyStrict`: `"use strict";` prepended), or both.
//  `javascript.ts` has one entry and no goal or strict switch, so its verdict is the same in every
//  run: it parses the text of the first run once. acorn and tsc, the calibration columns, can tell
//  the runs apart and are judged on all of them (right only if right in every run).
//
//  Every disagreement gets a CAUSE CLASS (test/test262-classes.ts) with the verdict on what should
//  happen. The record: test/test262-record.txt (every disagreeing file and its class; agreeing
//  files are implied) and docs/TEST262.md (the scoreboard, the classes, the calibration), both
//  generated. The gate regenerates them and fails on ANY difference, in either direction: a file
//  that starts to disagree is a regression, a file that stops is an improvement to record. It also
//  fails while a disagreement has no class (`accept/unknown`, `reject/unknown`).
//
//  Run (bare node):
//    node test/test262.ts            # gate: fail if the record is stale
//    node test/test262.ts --write    # (re)write test/test262-record.txt and docs/TEST262.md
//  Both print what moved against the committed record, per class (files leaving it, files
//  entering it), short enough to quote in the landing's commit message.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { createParser } from '../src/gen-parser.ts';
import { isInputError } from './input-error.ts';
import { CLASSES, UNKNOWN, classify, type CauseClass, type TestInfo, type Verdict } from './test262-classes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = join(ROOT, 'test/test262-record.txt');
const DOC = join(ROOT, 'docs/TEST262.md');
const PIN = readFileSync(join(ROOT, 'test/test262.sha'), 'utf8').trim();
const CORPUS = '/tmp/test262';
const DIRS = ['test/language', 'test/annexB/language'];
const WRITE = process.argv.includes('--write');
const WRITE_CMD = 'node test/test262.ts --write';

if (!DIRS.every((d) => existsSync(join(CORPUS, d)))) {
  console.error(`✗ NOT RUN: the pinned test262 corpus is absent at ${CORPUS} (${DIRS.join(', ')}).`);
  console.error('  Provision it as CI does (.github/workflows/ci.yml, "Clone the pinned test262 corpus").');
  process.exit(1);
}
const head = readFileSync(join(CORPUS, '.git/HEAD'), 'utf8').trim();
if (head !== PIN) {
  console.error(`✗ NOT RUN: ${CORPUS} is at ${head}, the pin (test/test262.sha) is ${PIN}. Re-clone it.`);
  process.exit(1);
}

// ── the corpus ──
type Goal = 'script' | 'module';
interface Run { goal: Goal; strict: boolean; text: string }
interface Test extends TestInfo { expect: 'accept' | 'reject'; runs: Run[] }
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const f = join(d, e.name);
  return e.isDirectory() ? walk(f) : e.name.endsWith('.js') ? [f] : [];
});
const loadErrors: string[] = [];
let fixtures = 0;
const tests: Test[] = [];
for (const dir of DIRS) for (const f of walk(join(CORPUS, dir)).sort()) {
  const path = f.slice(CORPUS.length + 1);
  if (path.endsWith('_FIXTURE.js')) { fixtures++; continue; }   // a module another test imports, not a test
  const full = readFileSync(f, 'utf8');
  const m = /\/\*---([\s\S]*?)---\*\//.exec(full);
  if (!m) { loadErrors.push(`${path}: no front matter`); continue; }
  const meta = (parseYaml(m[1]) ?? {}) as { flags?: string[]; features?: string[]; description?: string; negative?: { phase?: string; type?: string } };
  const flags = meta.flags ?? [];
  const neg = meta.negative;
  if (neg && neg.phase === 'parse' && neg.type !== 'SyntaxError') { loadErrors.push(`${path}: a parse-phase negative of type ${neg.type}`); continue; }
  const runs: Run[] = flags.includes('module') ? [{ goal: 'module', strict: true, text: full }]
    : flags.includes('onlyStrict') ? [{ goal: 'script', strict: true, text: `"use strict";\n${full}` }]
    : flags.includes('noStrict') || flags.includes('raw') ? [{ goal: 'script', strict: false, text: full }]
    : [{ goal: 'script', strict: false, text: full }, { goal: 'script', strict: true, text: `"use strict";\n${full}` }];
  tests.push({ path, flags, features: meta.features ?? [], description: String(meta.description ?? ''), src: full.slice(m.index + m[0].length), expect: neg?.phase === 'parse' ? 'reject' : 'accept', runs });
}
if (loadErrors.length) { for (const e of loadErrors) console.error(`✗ ${e}`); process.exit(1); }

// ── the parsers ──
type V = 'accept' | 'reject';
const { parse } = createParser((await import('../javascript.ts')).default);
const crashNotes = new Map<string, string>();
const ours = (t: Test): V | 'crash' => {
  try { parse(t.runs[0].text); return 'accept'; }
  catch (e) {
    if (isInputError(e)) return 'reject';
    crashNotes.set(t.path, `${(e as Error)?.constructor?.name}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return 'crash';
  }
};
const acornRun = (r: Run): V => {
  try { acorn.parse(r.text, { ecmaVersion: 'latest', sourceType: r.goal }); return 'accept'; } catch { return 'reject'; }
};
const moduleIndicator = ts.getSetExternalModuleIndicator({ moduleDetection: ts.ModuleDetectionKind.Force });
const tscRun = (r: Run): { parser: V; binder: V } => {
  const sf = ts.createSourceFile('/t.js', r.text, r.goal === 'module' ? { languageVersion: ts.ScriptTarget.Latest, setExternalModuleIndicator: moduleIndicator } : ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const parser: V = ((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length ? 'reject' : 'accept');
  (ts as unknown as { bindSourceFile: (s: ts.SourceFile, o: ts.CompilerOptions) => void }).bindSourceFile(sf, {});
  const binder: V = parser === 'reject' || (sf as unknown as { bindDiagnostics: unknown[] }).bindDiagnostics.length ? 'reject' : 'accept';
  return { parser, binder };
};
// right iff the expected verdict in every run
const rightInAll = (t: Test, vs: V[]) => vs.every((v) => v === t.expect);

// ── measure ──
type Cell = 'agree-accept' | 'agree-reject' | 'we-accept' | 'we-reject' | 'crash';
interface Row { t: Test; cell: Cell; cls?: CauseClass; acorn: boolean; tscParser: boolean; tscBinder: boolean; acornAccepts: boolean }
const rows: Row[] = [];
const t0 = performance.now();
let oursMs = 0;
for (const t of tests) {
  const s = performance.now();
  const o = ours(t);
  oursMs += performance.now() - s;
  const cell: Cell = o === 'crash' ? 'crash' : o === t.expect ? (o === 'accept' ? 'agree-accept' : 'agree-reject') : (o === 'accept' ? 'we-accept' : 'we-reject');
  const cls = cell === 'we-accept' || cell === 'we-reject' ? classify(t, cell) : undefined;
  const av = t.runs.map(acornRun);
  const tv = t.runs.map(tscRun);
  rows.push({ t, cell, cls, acorn: rightInAll(t, av), tscParser: rightInAll(t, tv.map((x) => x.parser)), tscBinder: rightInAll(t, tv.map((x) => x.binder)), acornAccepts: av.every((v) => v === 'accept') });
}
const ms = performance.now() - t0;

// ── typescript.ts on the valid tests ──
// TypeScript is a superset of JavaScript, so every test262 test that must parse must parse with
// `typescript.ts` too, unless TypeScript rejects that syntax by design: tsc's own parser, on the file
// as a `.ts` file, then rejects it as well (its diagnostic is the evidence). A rejected file is one of:
//   ts/by-design       tsc's .ts parser rejects it too (listed with tsc's diagnostic)
//   ts/as-javascript   tsc accepts it, and `javascript.ts` rejects it as well: the JavaScript record's
//                      class is the cause, referenced, not repeated
//   ts/unknown         tsc accepts it and only `typescript.ts` rejects it: a TypeScript grammar bug
//                      no class names yet; the gate fails while there is one
// The negative tests are not asked of the TypeScript grammar: it is held to tsc's parser there.
const tsGrammar = createParser((await import('../typescript.ts')).default);
type TsCell = 'ts/by-design' | 'ts/as-javascript' | 'ts/unknown' | 'ts/crash';
interface TsRow { r: Row; cell: TsCell; note: string }
const tsRows: TsRow[] = [];
let tsMs = 0;
let tsValid = 0;
for (const r of rows) {
  if (r.t.expect !== 'accept') continue;
  tsValid++;
  const s = performance.now();
  let failed: unknown = null;
  try { tsGrammar.parse(r.t.runs[0].text); } catch (e) { failed = e ?? new Error('throw'); }
  tsMs += performance.now() - s;
  if (failed === null) continue;
  if (!isInputError(failed)) { tsRows.push({ r, cell: 'ts/crash', note: `${(failed as Error)?.constructor?.name}: ${String((failed as Error)?.message ?? failed).slice(0, 120)}` }); continue; }
  const sf = ts.createSourceFile('/t.ts', r.t.runs[0].text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const d = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics[0];
  if (d) tsRows.push({ r, cell: 'ts/by-design', note: `tsc TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}` });
  else if (r.cls) tsRows.push({ r, cell: 'ts/as-javascript', note: r.cls.id });
  else tsRows.push({ r, cell: 'ts/unknown', note: 'tsc accepts it, javascript.ts accepts it' });
}

// ── render ──
const count = (f: (r: Row) => boolean) => rows.reduce((n, r) => n + (f(r) ? 1 : 0), 0);
const pct = (a: number, b: number) => (b ? (100 * a / b).toFixed(1) : '0.0');
const area = (p: string) => p.startsWith('test/annexB/') ? `annexB/${p.split('/')[3]}` : p.split('/')[2];
const short = (p: string) => p.replace(/^test\//, '');
const cell = (s: string) => s.replace(/\|/g, '\\|');   // a table cell: GFM ends a cell at any unescaped pipe, inside code too
const CELLS: Cell[] = ['agree-accept', 'agree-reject', 'we-accept', 'we-reject', 'crash'];

// The record: every disagreeing file under its class, sorted.
const allClasses = [...CLASSES, UNKNOWN['we-accept'], UNKNOWN['we-reject']];
const byClass = new Map<string, Row[]>();
for (const r of rows) if (r.cls) { if (!byClass.has(r.cls.id)) byClass.set(r.cls.id, []); byClass.get(r.cls.id)!.push(r); }
const crashes = rows.filter((r) => r.cell === 'crash');
const R: string[] = [`# test262 disagreements with javascript.ts at tc39/test262@${PIN}. Generated by \`${WRITE_CMD}\`; do not edit.`, '# Under each "## <class>" (test/test262-classes.ts), one path under test/ per line.'];
for (const c of allClasses) {
  const rs = byClass.get(c.id) ?? [];
  if (rs.length) R.push(`## ${c.id}`, ...rs.map((r) => short(r.t.path)));
}
if (crashes.length) R.push('## crash', ...crashes.map((r) => short(r.t.path)));
for (const c of ['ts/by-design', 'ts/as-javascript', 'ts/unknown', 'ts/crash'] as const) {
  const rs = tsRows.filter((x) => x.cell === c);
  if (rs.length) R.push(`## ${c}`, ...rs.map((x) => short(x.r.t.path)));
}
const record = R.join('\n') + '\n';

const VERDICT_TEXT: Record<Verdict, string> = {
  'grammar-bug': 'grammar bug: fix',
  adding: 'syntax being added (decided)',
  'needs-parameter': 'needs a parameterised production the engine lacks (roadmap item 4)',
  'early-error': 'early error: a checker over the tree, not the grammar: not built',
  unknown: '**unclassified: read these**',
};
const D: string[] = [];
const total = rows.length;
const agree = count((r) => r.cell === 'agree-accept' || r.cell === 'agree-reject');
const negatives = count((r) => r.t.expect === 'reject');
D.push('# TEST262 — the JavaScript grammar against test262 (auto-generated)');
D.push('');
D.push(`<!-- AUTO-GENERATED by \`${WRITE_CMD}\`. Do not edit by hand. -->`);
D.push('');
D.push('test262 is the ECMAScript conformance suite, and JavaScript\'s oracle here ([ROADMAP](ROADMAP.md) item 6;');
D.push('`tsc` remains the oracle for TypeScript-only syntax, [CORRECTNESS.md](CORRECTNESS.md)). Every test under');
D.push('`test/language/` and `test/annexB/language/` is parsed by the interpreter over `javascript.ts`, and its');
D.push('verdict compared with the one the test\'s front matter states: a test whose `negative.phase` is `parse`');
D.push('must not parse; every other test must (a resolution or runtime error still parses). The sources are read');
D.push('from a checkout, never run, never copied into this repository. The harness and its rules:');
D.push('[`test/test262.ts`](../test/test262.ts); the classes: [`test/test262-classes.ts`](../test/test262-classes.ts);');
D.push('every disagreeing file: [`test/test262-record.txt`](../test/test262-record.txt). The gate `conformance/test262`');
D.push(`fails when either is stale; \`${WRITE_CMD}\` re-records.`);
D.push('');
D.push(`Corpus: \`tc39/test262@${PIN}\` (pin: \`test/test262.sha\`) · ${total} tests (${negatives} parse-negative) · ${fixtures} \`_FIXTURE.js\` modules skipped (imported by tests, not tests).`);
D.push('');
D.push('Goal and mode: `javascript.ts` has one entry, `Program`, and no script / module goal or strict mode switch');
D.push('(the [Await] / [Yield] contexts are its only parameters). So it gives every run of a test the same verdict:');
D.push('a test that test262 runs both sloppy and strict, or only in one mode, or as a module, is parsed once (the');
D.push('first run\'s text: `"use strict";` prepended for `onlyStrict`). What depends on the goal or the mode is a class');
D.push('of its own below (`needs-parameter`).');
D.push('');
D.push(`**${agree} of ${total} agree (${pct(agree, total)}%).**`);
D.push('');
D.push('## Scoreboard');
D.push('');
D.push('| directory | files | agree-accept | agree-reject | WE-ACCEPT | WE-REJECT | crash |');
D.push('|---|---:|---:|---:|---:|---:|---:|');
const areas = [...new Set(rows.map((r) => area(r.t.path)))].sort((a, b) => (a.startsWith('annexB/') ? 1 : 0) - (b.startsWith('annexB/') ? 1 : 0) || a.localeCompare(b));
for (const a of areas) {
  const rs = rows.filter((r) => area(r.t.path) === a);
  D.push(`| \`${a}\` | ${rs.length} | ${CELLS.map((c) => rs.filter((r) => r.cell === c).length).join(' | ')} |`);
}
D.push(`| **total** | **${total}** | ${CELLS.map((c) => `**${count((r) => r.cell === c)}**`).join(' | ')} |`);
D.push('');
D.push('WE-ACCEPT: test262 says SyntaxError, the grammar parses. WE-REJECT: test262 parses, the grammar rejects.');
D.push('');
D.push('## Classes');
D.push('');
D.push('Every disagreement has one cause class, the first whose predicate holds (the order of');
D.push('`test/test262-classes.ts`); each class was read on a sample of its files. Verdicts: **grammar bug** (no goal');
D.push('or mode derives it, or derivable syntax refused); **adding** (valid syntax the grammar lacks, decided to add);');
D.push('**needs-parameter** (the script / module goal, strict mode, [Return] or another parameterised production the');
D.push('engine lacks: roadmap item 4); **early error** (a static-semantic rule: not the context-free grammar\'s,');
D.push('[CORRECTNESS.md](CORRECTNESS.md), but a checker\'s over the tree, which is not built; see "Early errors" below).');
D.push('"acorn agrees": acorn, a production parser that implements most early errors, gets these files right (in every');
D.push('run); where it does not, the rule is outside even its syntactic layer.');
const VERDICT_ORDER: Verdict[] = ['unknown', 'grammar-bug', 'adding', 'needs-parameter', 'early-error'];
for (const dir of ['we-reject', 'we-accept'] as const) {
  D.push('');
  D.push(`### ${dir === 'we-reject' ? 'WE-REJECT: valid JavaScript the grammar refuses' : 'WE-ACCEPT: SyntaxErrors the grammar parses'}`);
  D.push('');
  D.push('| class | files | acorn agrees | verdict | witnesses |');
  D.push('|---|---:|---:|---|---|');
  const cs = allClasses.filter((c) => c.direction === dir && byClass.get(c.id)?.length)
    .sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) || byClass.get(b.id)!.length - byClass.get(a.id)!.length || a.id.localeCompare(b.id));
  for (const c of cs) {
    const rs = byClass.get(c.id)!;
    const step = rs.length / Math.min(3, rs.length);
    const wit = [0, 1, 2].slice(0, Math.min(3, rs.length)).map((i) => `\`${short(rs[Math.floor(i * step)].t.path)}\``).join('<br>');
    D.push(`| \`${c.id}\`: ${cell(c.title)} | ${rs.length} | ${rs.filter((r) => r.acorn).length} | ${VERDICT_TEXT[c.verdict]} | ${wit} |`);
  }
  D.push('');
  D.push('| verdict | files |');
  D.push('|---|---:|');
  for (const v of VERDICT_ORDER) {
    const n = cs.filter((c) => c.verdict === v).reduce((s, c) => s + byClass.get(c.id)!.length, 0);
    if (n) D.push(`| ${VERDICT_TEXT[v]} | ${n} |`);
  }
  D.push('');
  for (const c of cs) D.push(`- \`${c.id}\` — ${c.why}`);
}
if (crashes.length) {
  D.push('');
  D.push('### Crashes (the interpreter threw something that is not an input error: a bug)');
  D.push('');
  for (const r of crashes) D.push(`- \`${short(r.t.path)}\` — ${crashNotes.get(r.t.path)}`);
}
D.push('');
D.push('## TypeScript: `typescript.ts` on the valid tests');
D.push('');
D.push('TypeScript is a superset of JavaScript, so every test that must parse must parse with `typescript.ts` too,');
D.push('unless TypeScript rejects that syntax by design: then tsc\'s own parser, on the file as a `.ts` file, rejects it as');
D.push('well, and its diagnostic is the evidence. A file `javascript.ts` also rejects is referenced by its JavaScript');
D.push('class, not classed again. A rejection tsc does not share and the JavaScript grammar does not either would be a');
D.push('TypeScript grammar bug with no class yet (`ts/unknown`), and fails the gate. The negative tests are not asked of');
D.push('the TypeScript grammar; there it is held to tsc\'s parser ([CORRECTNESS.md](CORRECTNESS.md)).');
D.push('');
const tsCount = (c: TsCell) => tsRows.filter((x) => x.cell === c).length;
D.push(`**${tsValid - tsRows.length} of ${tsValid} valid tests parse (${pct(tsValid - tsRows.length, tsValid)}%)** · by design ${tsCount('ts/by-design')} · as in JavaScript ${tsCount('ts/as-javascript')} · unclassified ${tsCount('ts/unknown')} · crash ${tsCount('ts/crash')}`);
D.push('');
const groupBy = (c: TsCell) => {
  const m = new Map<string, TsRow[]>();
  for (const x of tsRows.filter((y) => y.cell === c)) { const k = c === 'ts/by-design' ? `${x.r.cls?.id ?? 'javascript.ts parses it'} · ${x.note.replace(/^(tsc TS\d+).*$/, '$1')}` : x.note; if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); }
  return [...m].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
};
if (tsRows.length) {
  D.push('| cell | cause | files | witness | evidence |');
  D.push('|---|---|---:|---|---|');
  for (const c of ['ts/by-design', 'ts/as-javascript', 'ts/unknown', 'ts/crash'] as const) {
    for (const [k, xs] of groupBy(c)) D.push(`| \`${c}\` | ${c === 'ts/by-design' ? `TypeScript rejects it (JavaScript class \`${k.split(' · ')[0]}\`)` : c === 'ts/as-javascript' ? `the JavaScript class \`${k}\`` : k} | ${xs.length} | \`${short(xs[0].r.t.path)}\` | ${c === 'ts/by-design' ? cell(xs[0].note) : c === 'ts/as-javascript' ? 'tsc\'s .ts parser accepts it' : cell(xs[0].note)} |`);
  }
  D.push('');
}
D.push('## Early errors: a checker over the tree, not the grammar: not built');
D.push('');
D.push('The static-semantic rules ("It is a Syntax Error if …") stay out of the context-free grammar, but not out of');
D.push('the project: acorn enforces all but a handful of them (the calibration below), so a JavaScript front end is');
D.push('expected to. They belong to a pass over the parsed tree, which does not exist yet. This table is its');
D.push('specification, ranked by the files each rule decides: **tree** means the node and its ancestors suffice; **scope**');
D.push('means the pass must collect the names each scope (or class) declares.');
D.push('');
D.push('| class | files | needs | what the checker reads |');
D.push('|---|---:|---|---|');
const early = CLASSES.filter((c) => c.checker && byClass.get(c.id)?.length).sort((a, b) => byClass.get(b.id)!.length - byClass.get(a.id)!.length || a.id.localeCompare(b.id));
for (const c of early) D.push(`| \`${c.id}\`: ${cell(c.title)} | ${byClass.get(c.id)!.length} | ${c.checker!.needs} | ${cell(c.checker!.reads)} |`);
const earlyBy = (n: 'tree' | 'scope') => early.filter((c) => c.checker!.needs === n).reduce((s, c) => s + byClass.get(c.id)!.length, 0);
D.push('');
D.push(`Tree alone: ${earlyBy('tree')} files; scope analysis: ${earlyBy('scope')} files. The strict-mode and Module-goal rules (\`needs-parameter\` above) are early errors too where they forbid a name or a statement; they are counted there because they need the goal and mode first.`);
D.push('');
D.push('## Calibration: production parsers on the same files');
D.push('');
D.push('How many test262 parse verdicts each parser gets right (read-only; no gate rides on these columns beyond');
D.push('the record being current). acorn: `ecmaVersion: \'latest\'`, `sourceType` per the test, strict runs with');
D.push('`"use strict";` prepended, right only if right in every run. tsc: `ts.createSourceFile` as a `.js` file (a');
D.push('module test forced to module detection), right only if no parse diagnostic exactly where test262 expects');
D.push('none; "+ binder" also counts the binder\'s diagnostics (`bindSourceFile`: strict-mode words, duplicate');
D.push('declarations, labels, which tsc reports outside its parser; it includes TypeScript\'s own checks).');
D.push('');
D.push(`| parser | right | of ${total} | on the ${total - negatives} valid tests | on the ${negatives} parse-negative tests |`);
D.push('|---|---:|---:|---:|---:|');
const calib = (name: string, f: (r: Row) => boolean) => {
  const right = count(f);
  const pos = count((r) => r.t.expect === 'accept' && f(r));
  const neg = count((r) => r.t.expect === 'reject' && f(r));
  D.push(`| ${name} | ${right} | ${pct(right, total)}% | ${pos} (${pct(pos, total - negatives)}%) | ${neg} (${pct(neg, negatives)}%) |`);
};
calib('`javascript.ts` (interpreter)', (r) => r.cell === 'agree-accept' || r.cell === 'agree-reject');
calib(`acorn ${acorn.version}`, (r) => r.acorn);
calib(`tsc ${ts.version} parser`, (r) => r.tscParser);
calib(`tsc ${ts.version} parser + binder`, (r) => r.tscBinder);
const weAcc = rows.filter((r) => r.cell === 'we-accept');
D.push('');
D.push(`Of the ${weAcc.length} WE-ACCEPT files, acorn also accepts ${weAcc.filter((r) => r.acornAccepts).length} (in every run), tsc's parser ${weAcc.filter((r) => !r.tscParser).length}, tsc's parser + binder ${weAcc.filter((r) => !r.tscBinder).length}.`);
D.push('');
const doc = D.join('\n');

// ── report ──
console.log(`── javascript.ts vs test262 (${total} tests; ${(ms / 1000).toFixed(1)}s, of which the interpreter ${(oursMs / 1000).toFixed(1)}s) ──`);
for (const c of CELLS) console.log(`  ${c.padEnd(13)} ${String(count((r) => r.cell === c)).padStart(6)}`);
console.log(`  typescript.ts: ${tsValid - tsRows.length}/${tsValid} valid tests parse (${(tsMs / 1000).toFixed(1)}s); ${['ts/by-design', 'ts/as-javascript', 'ts/unknown', 'ts/crash'].map((c) => `${c} ${tsCount(c as TsCell)}`).join(', ')}`);
const unknown = [...rows.filter((r) => r.cls?.verdict === 'unknown'), ...tsRows.filter((x) => x.cell === 'ts/unknown' || x.cell === 'ts/crash').map((x) => x.r)];
for (const r of rows.filter((x) => x.cls?.verdict === 'unknown')) console.log(`  ✗ unclassified ${r.cell}: ${short(r.t.path)} — read it, then add or widen a class in test/test262-classes.ts`);
for (const x of tsRows.filter((y) => y.cell === 'ts/unknown' || y.cell === 'ts/crash')) console.log(`  ✗ ${x.cell}: ${short(x.r.t.path)} — ${x.note}: only typescript.ts rejects this valid test`);


// ── what moved against the committed record ──
// A file's move is one of: it left a class (it agrees now: an improvement), it entered a class (a
// regression), or it changed class. `--write` prints this per class so a landing can quote it; the
// gate prints it too, and every file when there are few.
const committed = existsSync(RECORD) ? readFileSync(RECORD, 'utf8') : '';
const committedDoc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
const parseRec = (s: string) => {
  const m = new Map<string, string>();
  let cur = '';
  for (const l of s.split('\n')) {
    if (l.startsWith('## ')) cur = l.slice(3);
    else if (l && !l.startsWith('#')) m.set(cur.startsWith('ts/') ? `(typescript.ts) ${l}` : l, cur);   // a file has one JavaScript and at most one TypeScript entry
  }
  return m;
};
const before = parseRec(committed), after = parseRec(record);
const left = new Map<string, string[]>(), entered = new Map<string, string[]>();
const push = (m: Map<string, string[]>, k: string, f: string) => { if (!m.has(k)) m.set(k, []); m.get(k)!.push(f); };
for (const [f, c] of before) if (after.get(f) !== c) push(left, c, f);
for (const [f, c] of after) if (before.get(f) !== c) push(entered, c, f);
const moves = [...left.values(), ...entered.values()].reduce((n, l) => n + l.length, 0);
const summary = (): string[] => {
  const L: string[] = [];
  const agreeing = (f: string) => !after.has(f);
  const fresh = (f: string) => !before.has(f);
  for (const [c, fs] of [...left].sort((a, b) => b[1].length - a[1].length)) {
    const now = fs.filter(agreeing).length;
    L.push(`  ${c}: −${fs.length} (${now} agree now${fs.length - now ? `, ${fs.length - now} to another class` : ''})  e.g. ${fs.slice(0, 2).join(', ')}`);
  }
  for (const [c, fs] of [...entered].sort((a, b) => b[1].length - a[1].length)) {
    const nw = fs.filter(fresh).length;
    L.push(`  ${c}: +${fs.length} (${nw} newly disagreeing${fs.length - nw ? `, ${fs.length - nw} from another class` : ''})  e.g. ${fs.slice(0, 2).join(', ')}`);
  }
  return L;
};
if (moves) {
  console.log(`\nAgainst the committed record: ${moves} move(s); agree ${count((r) => r.cell === 'agree-accept' || r.cell === 'agree-reject')} of ${total}${committed ? ` (was ${total - before.size})` : ''}.`);
  for (const l of summary()) console.log(l);
}

if (WRITE) {
  writeFileSync(RECORD, record);
  writeFileSync(DOC, doc);
  console.log(`\n✓ wrote ${RECORD.slice(ROOT.length + 1)} and ${DOC.slice(ROOT.length + 1)}`);
  process.exit(unknown.length ? 1 : 0);
}

const stale = committed !== record || committedDoc !== doc;
if (stale) {
  console.log(`\n✗ the test262 record is stale${committed ? '' : ' (absent)'}.`);
  if (moves && moves <= 50) {
    for (const [f, c] of after) if (before.get(f) !== c) console.log(`  ${before.has(f) ? 'moved' : 'regression'}: ${f} → ${c}${before.has(f) ? ` (was ${before.get(f)})` : ''}`);
    for (const [f, c] of before) if (!after.has(f)) console.log(`  improvement: ${f} agrees now (was ${c})`);
  }
  if (!moves) console.log('  (no file moved; docs/TEST262.md differs: a count, a witness, a version, a class text or the calibration)');
  console.log(`  review the moves, then re-record: ${WRITE_CMD}`);
}
if (stale || unknown.length) process.exit(1);
console.log(`\n✓ test262 matches the record (${agree}/${total} agree)`);
