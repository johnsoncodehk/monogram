// The v2 expression-subset scoreboard: each ShapeSpec v2 fixture, evaluated by the reference
// interpreter (src/shape2-eval.ts) on the interpreter CST, against its reference parser through
// the oracle harness (test/shape-oracle.ts), statement by statement:
//
//   estree  test/fixtures/shape-v2-estree-expr.ts on javascript.ts, against acorn
//   tsc     test/fixtures/shape-v2-tsc-expr.ts on typescript.ts, against tsc's parser
//
// Three VIEWS, each its own unit (see `runShape`): one EXPRESSION STATEMENT (anywhere in a file:
// nested ones too), one TOP-LEVEL STATEMENT (an element of the root's statement list), one whole
// FILE. The oracle's units and the candidate's are paired by start offset; each candidate is
// evaluated in the context of its file (its ancestors and, through a thread, its left siblings:
// the directive prologue), and each pair is compared with `compareTrees`. A unit whose evaluation
// reaches an arm the spec does not map is OUTSIDE THE SUBSET (counted by that arm), not compared.
// Files the oracle skips (acorn rejects / tsc reports parse errors) and files the grammar rejects
// are counted apart.
//
//   node --stack-size=7000 test/shape2-oracle.ts estree|tsc [corpus...] [--out r.json] [--samples N]
//     corpora: realjs (the local real-JS list), node_modules (PACKAGES' JavaScript),
//     conformance, conformance/<dir>, or file paths
//   node --stack-size=7000 test/shape2-oracle.ts --check
//     the GATE (report-only): runs the CI corpus of each shape and fails only on a REGRESSION
//     against the record test/shape2-oracle-record.json (fewer identical or compared statements,
//     more divergent ones); `--write` re-records it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser } from '../src/target.ts';
import { tsTarget } from '../src/target-ts.ts';
import { scratchDir } from './scratch.ts';
import { createParser, type CstLeaf, type CstNode } from '../src/gen-parser.ts';
import type { CstGrammar } from '../src/types.ts';
import { armNameOf, evaluator, ShapeUnmapped, type Shape, type ShapeNode } from '../src/shape2-eval.ts';
import { compareTrees, conformanceFiles, type Divergence, type NTree, type NValue } from './shape-oracle.ts';

export const REALJS_LIST = '/home/linuxuser/.cache/monogram-agents/scratch/fix-grammar-queue-2/realjs-files.txt';
const RECORD = new URL('./shape2-oracle-record.json', import.meta.url);
/** The corpus each shape is gated on, available in CI: the JavaScript of installed packages
 * (PACKAGES) for acorn, the pinned TypeScript checkout's expression cases for tsc. */
const CI_CORPUS: Record<string, string> = { estree: 'node_modules', tsc: 'conformance/expressions' };

type OracleShape = { name: 'estree' | 'tsc'; grammar: CstGrammar; shape: Shape; oracle: (src: string, path: string) => NTree | string };

async function shapeOf(name: string): Promise<OracleShape> {
  if (name === 'estree') {
    const { parseEstree, normaliseEstree } = await import('./shape-oracle-estree.ts');
    const { estreeExprShape } = await import('./fixtures/shape-v2-estree-expr.ts');
    return {
      name, grammar: (await import('../javascript.ts')).default, shape: estreeExprShape,
      oracle: (src) => { const r = parseEstree(src); return r ? normaliseEstree(r.tree) : 'acorn rejects it'; },
    };
  }
  if (name === 'tsc') {
    const { tscOracle } = await import('./shape-oracle-tsc.ts');
    const { tscExprShape } = await import('./fixtures/shape-v2-tsc-expr.ts');
    return {
      name, grammar: (await import('../typescript.ts')).default, shape: tscExprShape,
      oracle: (src, path) => { const r = tscOracle(src, path); return 'tree' in r ? r.tree : 'skip' in r ? r.skip : r.fail; },
    };
  }
  throw new Error(`unknown shape ${name}`);
}

/** The unit a scoreboard counts. */
export const VIEWS = ['expression statement', 'top-level statement', 'file'] as const;
export type View = (typeof VIEWS)[number];

export type Scoreboard = {
  shape: string;
  corpus: string;
  view: View;
  files: number;
  filesSkipped: number;          // the oracle skips the file
  filesRejected: number;         // the grammar (interpreter) rejects it
  units: number;                 // the oracle's units (statements / files) in compared files
  unpaired: number;              // an oracle unit with no candidate unit at its start
  outOfSubset: number;           // the candidate unit reaches an unmapped arm
  evalErrors: number;            // the evaluator threw something else (a spec / interpreter bug)
  compared: number;
  identical: number;
  /** first divergence per compared unit: "<class> <node kind>" -> count */
  firstByKind: Record<string, number>;
  /** first divergence per compared unit, by cause (see causeOf) */
  firstByCause: Record<string, number>;
  /** the unmapped arm each out-of-subset unit reached first */
  unmapped: Record<string, number>;
  samples: { path: string; at: number; text: string; first: Divergence }[];
};

/** The cause a first divergence is filed under. */
function causeOf(d: Divergence): string {
  const field = d.path.slice(d.path.lastIndexOf('.') + 1);
  if (d.cls === 'span' || d.cls === 'pos') return `position: ${d.at} span`;
  if (d.cls === 'value' && ['value', 'raw', 'name', 'text', 'bigint', 'numericLiteralFlags', 'singleQuote', 'hasExtendedUnicodeEscape'].includes(field)) return `leaf cooking: ${d.at}.${field}`;
  if (d.cls === 'field-missing' || d.cls === 'field-extra') return `${d.cls}: ${d.at}.${field}`;
  return `${d.cls}: ${d.at}`;
}

const bump = (h: Record<string, number>, k: string): void => { h[k] = (h[k] ?? 0) + 1; };
const isTree = (v: NValue): v is NTree => v !== null && typeof v === 'object' && !Array.isArray(v) && 'kind' in v;

function oracleStatements(t: NTree, out: Map<number, NTree>): void {
  if (t.kind === 'ExpressionStatement') out.set(t.start, t);
  const walk = (v: NValue): void => { if (isTree(v)) oracleStatements(v, out); else if (Array.isArray(v)) v.forEach(walk); };
  for (const v of Object.values(t.fields)) walk(v);
}

/** The file view does not compare the root's own extent and end-of-file leaf: acorn's Program
 * spans the whole source, tsc's SourceFile ends at the end of the source and holds an
 * `endOfFileToken`, i.e. both cover trailing trivia, which no CST node spans (queue item 6,
 * positions and trivia). acorn's `sourceType` is the goal the oracle was RUN with (a parse
 * option: Module is tried first), not syntax of the file. Everything below the root is compared. */
const ROOT_NOT_COMPARED = ['sourceType', 'endOfFileToken'];
const rootView = (o: NTree, got: NTree): [NTree, NTree] => [
  { kind: o.kind, start: 0, end: 0, fields: Object.fromEntries(Object.entries(o.fields).filter(([k]) => !ROOT_NOT_COMPARED.includes(k))) },
  { ...got, start: 0, end: 0 },
];

/** Every view (VIEWS) of one shape over one corpus: each oracle unit is paired with the
 * candidate's by start offset, evaluated in its file's context (its ancestors and, through a
 * thread, its left siblings), and compared by `compareTrees`.
 * - expression statement: every ExpressionStatement, nested ones included;
 * - top-level statement: every element of the root's statement list (ESTree `body`, tsc
 *   `statements`), against the root's CST children;
 * - file: the root (see ROOT_NOT_COMPARED). A file is outside the subset when any of it is. */
export function runShape(shape: OracleShape, corpus: string, paths: string[], samples = 12): Scoreboard[] {
  const loaded: Shape = shape.shape;
  const parser = createParser(shape.grammar);
  const boards = Object.fromEntries(VIEWS.map((view): [View, Scoreboard] => [view, {
    shape: shape.name, corpus, view, files: paths.length, filesSkipped: 0, filesRejected: 0, units: 0, unpaired: 0, outOfSubset: 0, evalErrors: 0,
    compared: 0, identical: 0, firstByKind: {}, firstByCause: {}, unmapped: {}, samples: [],
  }])) as Record<View, Scoreboard>;
  const all = Object.values(boards);
  for (const path of paths) {
    const src = readFileSync(path, 'utf-8');
    const o = shape.oracle(src, path);
    if (typeof o === 'string') { for (const r of all) r.filesSkipped++; continue; }
    let cst: CstNode;
    try { cst = parser.parse(src); } catch { for (const r of all) r.filesRejected++; continue; }
    const valueAt = evaluator(loaded, cst, src);
    /** Score one oracle unit against the candidate CST node at its start (undefined: none). */
    const score = (r: Scoreboard, expected: NTree, n: CstNode | undefined, view = (e: NTree, g: NTree): [NTree, NTree] => [e, g]): void => {
      r.units++;
      if (!n) { r.unpaired++; return; }
      let value;
      try { value = valueAt(n) as ShapeNode; } catch (e) {
        if (e instanceof ShapeUnmapped) { r.outOfSubset++; bump(r.unmapped, `${e.rule}.${e.arm}`); return; }
        r.evalErrors++; bump(r.unmapped, `ERROR ${(e as Error).message.slice(0, 80)}`); return;
      }
      r.compared++;
      const st = compareTrees(...view(expected, value as NTree), 1);
      if (st.divergences.length === 0) { r.identical++; return; }
      const first = st.divergences[0];
      bump(r.firstByKind, `${first.cls} ${first.at}`);
      bump(r.firstByCause, causeOf(first));
      if (r.samples.length < samples) r.samples.push({ path: path.replace(/^.*?\/(node_modules|tests\/cases)\//, '$1/'), at: n.offset, text: src.slice(n.offset, Math.min(n.end, n.offset + 100)), first });
    };
    const want = new Map<number, NTree>();
    oracleStatements(o, want);
    const got = new Map<number, CstNode>();
    const walk = (x: CstNode | CstLeaf): void => {
      if ('tokenType' in x) return;
      if (x.rule === 'Stmt' && armNameOf(loaded, x, src) === 'expr') got.set(x.offset, x);
      x.children.forEach(walk);
    };
    walk(cst);
    for (const [at, expected] of want) score(boards['expression statement'], expected, got.get(at));
    const tops = new Map(cst.children.filter((x): x is CstNode => !('tokenType' in x)).map((x) => [x.offset, x]));
    for (const expected of (o.fields.body ?? o.fields.statements) as NTree[]) score(boards['top-level statement'], expected, tops.get(expected.start));
    score(boards.file, o, cst, rootView);
  }
  return VIEWS.map((v) => boards[v]);
}

/** The EMITTED shape-building parser (TypeScript target, emit option `shape`, src/shape-plan.ts)
 * against the evaluator, on every expression statement (nested ones too) of the corpus: the
 * value the parser built for the statement's node (observeBuilt: the last one built for that
 * node's arm and span) must be the evaluator's value of it. A statement the evaluator cannot give
 * (an unmapped arm) is outside the shape; one whose built value is missing as `unsupported` is
 * outside what the emitted plans build yet (the plan's reason counted); the rest are compared. */
export type BuiltBoard = {
  shape: string; corpus: string; files: number; filesRejected: number; units: number; outOfShape: number; unsupported: number;
  notBuilt: number; compared: number; identical: number; reasons: Record<string, number>; samples: string[];
};
export async function runBuilt(shape: OracleShape, corpus: string, paths: string[], samples = 6): Promise<BuiltBoard> {
  const file = join(scratchDir('shape2-oracle'), `built-${shape.name}.ts`);
  writeFileSync(file, emitParser(shape.grammar, tsTarget, { shape: shape.shape }));
  const m = await import(file);
  const arms = m.shapeArms as { rule: string; arm: string }[];
  const parser = createParser(shape.grammar);
  const b: BuiltBoard = { shape: shape.name, corpus, files: paths.length, filesRejected: 0, units: 0, outOfShape: 0, unsupported: 0, notBuilt: 0, compared: 0, identical: 0, reasons: {}, samples: [] };
  for (const path of paths) {
    const src = readFileSync(path, 'utf-8');
    let cst: CstNode;
    try { cst = parser.parse(src); } catch { b.filesRejected++; continue; }
    const valueAt = evaluator(shape.shape, cst, src);
    const built = new Map<string, unknown>();
    m.observeBuilt((id: number, off: number, end: number, v: unknown) => { const a = arms[id]!; built.set(`${a.rule}.${a.arm}@${off}:${end}`, v); });
    try { m.parse(src); } catch (e) { if (!(e instanceof m.ShapeMissing)) throw e; }
    m.observeBuilt(null);
    const units: CstNode[] = [];
    const walk = (x: CstNode | CstLeaf): void => {
      if ('tokenType' in x) return;
      if (x.rule === 'Stmt' && armNameOf(shape.shape, x, src) === 'expr') units.push(x);
      x.children.forEach(walk);
    };
    walk(cst);
    for (const n of units) {
      b.units++;
      let want: unknown;
      try { want = valueAt(n); } catch (e) { if (e instanceof ShapeUnmapped) { b.outOfShape++; continue; } throw e; }
      const got = built.get(`Stmt.expr@${n.offset}:${n.end}`);
      if (got === undefined) { b.notBuilt++; continue; }
      if (got instanceof m.ShapeMissing) {
        const g = got as { why: string; where: string };
        if (g.why === 'unsupported') { b.unsupported++; bump(b.reasons, g.where.replace(/^[^(]*\(/, '(')); continue; }
        b.notBuilt++; bump(b.reasons, `UNMAPPED but evaluated: ${g.where}`); continue;
      }
      b.compared++;
      if (JSON.stringify(got) === JSON.stringify(want)) b.identical++;
      else if (b.samples.length < samples) b.samples.push(`${path}@${n.offset} ${JSON.stringify(src.slice(n.offset, Math.min(n.end, n.offset + 80)))}\n      built ${JSON.stringify(got).slice(0, 300)}\n      eval  ${JSON.stringify(want).slice(0, 300)}`);
    }
  }
  return b;
}
export function formatBuilt(b: BuiltBoard): string {
  return [
    `${b.shape} on ${b.corpus}, emitted shape-building parser (TypeScript) vs the evaluator, unit "expression statement": ${b.files} files (${b.filesRejected} rejected by the grammar); ` +
      `${b.units} units: ${b.outOfShape} outside the shape, ${b.unsupported} outside what the plans build yet, ${b.notBuilt} not built, ${b.compared} compared, ${b.identical} identical, ${b.compared - b.identical} diverged`,
    '  outside what the plans build yet, by reason:', ...top(b.reasons, 12),
    ...(b.samples.length ? ['  divergent samples:', ...b.samples.map((x) => `    ${x}`)] : []),
  ].join('\n');
}

const top = (h: Record<string, number>, n = 15): string[] =>
  Object.entries(h).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, v]) => `    ${String(v).padStart(6)}  ${k}`);
export function formatScoreboard(r: Scoreboard): string {
  return [
    `${r.shape} on ${r.corpus}, unit "${r.view}": ${r.files} files (${r.filesSkipped} skipped by the oracle, ${r.filesRejected} rejected by the grammar); ` +
      `${r.units} units: ${r.compared} compared, ${r.identical} identical, ${r.compared - r.identical} diverged, ` +
      `${r.outOfSubset} outside the subset, ${r.unpaired} unpaired, ${r.evalErrors} evaluation errors`,
    '  first divergence by cause:', ...top(r.firstByCause),
    '  first divergence by class and node kind:', ...top(r.firstByKind),
    '  outside the subset, by the first unmapped arm:', ...top(r.unmapped, 12),
    '  samples:', ...r.samples.map((s) => `    ${s.path}@${s.at} ${JSON.stringify(s.text)}: ${s.first.cls} at ${s.first.path} (${s.first.at}): expected ${s.first.expected}, got ${s.first.got}`),
  ].join('\n');
}

export function corpusPaths(c: string): string[] {
  if (c === 'realjs') return readFileSync(REALJS_LIST, 'utf-8').split('\n').filter(Boolean);
  if (c === 'conformance') return conformanceFiles();
  if (c.startsWith('conformance/')) return conformanceFiles(`/tmp/ts-repo/tests/cases/${c}`);
  if (c === 'node_modules') return packageJs();
  return [c];
}

/** The JavaScript of a fixed set of installed packages (pinned by package-lock.json, the same
 * files on every platform). */
const PACKAGES = ['acorn', 'entities', 'parse5', 'vscode-oniguruma', 'vscode-textmate', 'web-tree-sitter', 'yaml'];
function packageJs(): string[] {
  const root = new URL('../node_modules/', import.meta.url).pathname;
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(m|c)?js$/.test(e.name)) out.push(p);
    }
  };
  for (const pkg of PACKAGES) walk(root + pkg);
  return out;
}

type Record_ = Record<string, Pick<Scoreboard, 'corpus' | 'view' | 'units' | 'compared' | 'identical' | 'outOfSubset'>>;
const keyOf = (r: Scoreboard): string => `${r.shape} ${r.corpus} ${r.view}`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
  if (args[0] === '--check') {
    // The gate: report-only; fails on a regression against the record, never on divergence.
    const write = args.includes('--write');
    const record: Record_ = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf-8')) : {};
    const next: Record_ = {};
    const problems: string[] = [];
    for (const name of ['estree', 'tsc']) {
      for (const r of runShape(await shapeOf(name), CI_CORPUS[name], corpusPaths(CI_CORPUS[name]), 4)) {
        console.log(formatScoreboard(r));
        next[keyOf(r)] = { corpus: r.corpus, view: r.view, units: r.units, compared: r.compared, identical: r.identical, outOfSubset: r.outOfSubset };
        const was = record[keyOf(r)];
        if (!was) { problems.push(`${keyOf(r)}: no record (run with --check --write)`); continue; }
        if (r.identical < was.identical) problems.push(`${keyOf(r)}: identical ${was.identical} -> ${r.identical}`);
        if (r.compared < was.compared) problems.push(`${keyOf(r)}: compared ${was.compared} -> ${r.compared}`);
        if (r.compared - r.identical > was.compared - was.identical) problems.push(`${keyOf(r)}: diverged ${was.compared - was.identical} -> ${r.compared - r.identical}`);
      }
    }
    if (write) { writeFileSync(RECORD, JSON.stringify(next, null, 1) + '\n'); console.log(`recorded ${RECORD.pathname}`); }
    else if (problems.length) { console.error(`shape2-oracle: REGRESSION against the record:\n  ${problems.join('\n  ')}`); process.exit(1); }
    else console.log('shape2-oracle: no regression against the record');
  } else if (args[0] === '--built') {
    const shape = await shapeOf(args[1] ?? '');
    for (const c of args.slice(2).length ? args.slice(2) : [CI_CORPUS[shape.name]!]) console.log(formatBuilt(await runBuilt(shape, c, corpusPaths(c))));
  } else {
    const shape = await shapeOf(args.shift() ?? '');
    const samples = args.indexOf('--samples') >= 0 ? Number(args.splice(args.indexOf('--samples'), 2)[1]) : 12;
    const reports = (args.length ? args : ['conformance']).flatMap((c) => runShape(shape, c, corpusPaths(c), samples));
    for (const r of reports) console.log(formatScoreboard(r));
    if (out) writeFileSync(out, JSON.stringify(reports, null, 1));
  }
}
