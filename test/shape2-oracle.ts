// The v2 expression-subset scoreboard: each ShapeSpec v2 fixture, evaluated by the reference
// interpreter (src/shape2-eval.ts) on the interpreter CST, against its reference parser through
// the oracle harness (test/shape-oracle.ts), statement by statement:
//
//   estree  test/fixtures/shape-v2-estree-expr.ts on javascript.ts, against acorn
//   tsc     test/fixtures/shape-v2-tsc-expr.ts on typescript.ts, against tsc's parser
//
// Unit = one EXPRESSION STATEMENT (anywhere in a file: nested ones too). The oracle's
// ExpressionStatement nodes and the candidate's (`Stmt.expr` arms) are paired by start offset;
// each candidate is evaluated in the context of its file (its ancestors and, through a thread,
// its left siblings: the directive prologue), and each pair is compared with `compareTrees`. A statement whose evaluation reaches an arm the spec
// does not map is OUTSIDE THE SUBSET (counted by that arm), not compared. Files the oracle skips
// (acorn rejects / tsc reports parse errors) and files the grammar rejects are counted apart.
//
//   node --stack-size=7000 test/shape2-oracle.ts estree|tsc [corpus...] [--out r.json] [--samples N]
//     corpora: realjs (the local real-JS list), node_modules (PACKAGES' JavaScript),
//     conformance, conformance/<dir>, or file paths
//   node --stack-size=7000 test/shape2-oracle.ts --check
//     the GATE (report-only): runs the CI corpus of each shape and fails only on a REGRESSION
//     against the record test/shape2-oracle-record.json (fewer identical or compared statements,
//     more divergent ones); `--write` re-records it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createParser, type CstLeaf, type CstNode } from '../src/gen-parser.ts';
import type { CstGrammar } from '../src/types.ts';
import { armNameOf, evaluator, loadShape2, Shape2Unmapped, type LoadedShape2, type S2Node } from '../src/shape2-eval.ts';
import type { Shape2Spec } from '../src/shape2-schema.ts';
import { compareTrees, conformanceFiles, type Divergence, type NTree, type NValue } from './shape-oracle.ts';

export const REALJS_LIST = '/home/linuxuser/.cache/monogram-agents/scratch/fix-grammar-queue-2/realjs-files.txt';
const RECORD = new URL('./shape2-oracle-record.json', import.meta.url);
/** The corpus each shape is gated on, available in CI: the JavaScript of installed packages
 * (PACKAGES) for acorn, the pinned TypeScript checkout's expression cases for tsc. */
const CI_CORPUS: Record<string, string> = { estree: 'node_modules', tsc: 'conformance/expressions' };

type Shape = { name: 'estree' | 'tsc'; grammar: CstGrammar; spec: Shape2Spec; oracle: (src: string, path: string) => NTree | string };

async function shapeOf(name: string): Promise<Shape> {
  if (name === 'estree') {
    const { parseEstree, normaliseEstree } = await import('./shape-oracle-estree.ts');
    const { estreeExprShape } = await import('./fixtures/shape-v2-estree-expr.ts');
    return {
      name, grammar: (await import('../javascript.ts')).default, spec: estreeExprShape,
      oracle: (src) => { const r = parseEstree(src); return r ? normaliseEstree(r.tree) : 'acorn rejects it'; },
    };
  }
  if (name === 'tsc') {
    const { tscOracle } = await import('./shape-oracle-tsc.ts');
    const { tscExprShape } = await import('./fixtures/shape-v2-tsc-expr.ts');
    return {
      name, grammar: (await import('../typescript.ts')).default, spec: tscExprShape,
      oracle: (src, path) => { const r = tscOracle(src, path); return 'tree' in r ? r.tree : 'skip' in r ? r.skip : r.fail; },
    };
  }
  throw new Error(`unknown shape ${name}`);
}

export type Scoreboard = {
  shape: string;
  corpus: string;
  files: number;
  filesSkipped: number;          // the oracle skips the file
  filesRejected: number;         // the grammar (interpreter) rejects it
  statements: number;            // the oracle's expression statements in compared files
  unpaired: number;              // an oracle statement with no candidate statement at its start
  outOfSubset: number;           // the candidate statement reaches an unmapped arm
  evalErrors: number;            // the evaluator threw something else (a spec / interpreter bug)
  compared: number;
  identical: number;
  /** first divergence per compared statement: "<class> <node kind>" -> count */
  firstByKind: Record<string, number>;
  /** first divergence per compared statement, by cause (see causeOf) */
  firstByCause: Record<string, number>;
  /** the unmapped arm each out-of-subset statement reached first */
  unmapped: Record<string, number>;
  samples: { path: string; at: number; text: string; first: Divergence }[];
};

/** The cause a first divergence is filed under. */
function causeOf(d: Divergence): string {
  const field = d.path.slice(d.path.lastIndexOf('.') + 1);
  if (d.cls === 'span' || d.cls === 'pos') return `position: ${d.at} span`;
  if (d.cls === 'field-missing' && field === 'directive') return 'gap: directive prologue (a statement\'s position among its siblings)';
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

export function runShape(shape: Shape, corpus: string, paths: string[], samples = 12): Scoreboard {
  const loaded: LoadedShape2 = loadShape2(shape.grammar, shape.spec);
  const parser = createParser(shape.grammar);
  const r: Scoreboard = { shape: shape.name, corpus, files: paths.length, filesSkipped: 0, filesRejected: 0, statements: 0, unpaired: 0, outOfSubset: 0, evalErrors: 0, compared: 0, identical: 0, firstByKind: {}, firstByCause: {}, unmapped: {}, samples: [] };
  for (const path of paths) {
    const src = readFileSync(path, 'utf-8');
    const o = shape.oracle(src, path);
    if (typeof o === 'string') { r.filesSkipped++; continue; }
    let cst: CstNode;
    try { cst = parser.parse(src); } catch { r.filesRejected++; continue; }
    const want = new Map<number, NTree>();
    oracleStatements(o, want);
    r.statements += want.size;
    const got = new Map<number, CstNode>();
    const walk = (x: CstNode | CstLeaf): void => {
      if ('tokenType' in x) return;
      if (x.rule === 'Stmt' && armNameOf(loaded, x, src) === 'expr') got.set(x.offset, x);
      x.children.forEach(walk);
    };
    walk(cst);
    const valueAt = evaluator(loaded, cst, src);   // each statement in its context (a directive's prologue)
    for (const [at, expected] of want) {
      const n = got.get(at);
      if (!n) { r.unpaired++; continue; }
      let value;
      try { value = valueAt(n) as S2Node; } catch (e) {
        if (e instanceof Shape2Unmapped) { r.outOfSubset++; bump(r.unmapped, `${e.rule}.${e.arm}`); continue; }
        r.evalErrors++; bump(r.unmapped, `ERROR ${(e as Error).message.slice(0, 80)}`); continue;
      }
      r.compared++;
      const st = compareTrees(expected, value as NTree, 1);
      if (st.divergences.length === 0) { r.identical++; continue; }
      const first = st.divergences[0];
      bump(r.firstByKind, `${first.cls} ${first.at}`);
      bump(r.firstByCause, causeOf(first));
      if (r.samples.length < samples) r.samples.push({ path: path.replace(/^.*?\/(node_modules|tests\/cases)\//, '$1/'), at, text: src.slice(at, Math.min(n.end, at + 100)), first });
    }
  }
  return r;
}

const top = (h: Record<string, number>, n = 15): string[] =>
  Object.entries(h).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, v]) => `    ${String(v).padStart(6)}  ${k}`);
export function formatScoreboard(r: Scoreboard): string {
  return [
    `${r.shape} on ${r.corpus}: ${r.files} files (${r.filesSkipped} skipped by the oracle, ${r.filesRejected} rejected by the grammar); ` +
      `${r.statements} expression statements: ${r.compared} compared, ${r.identical} identical, ${r.compared - r.identical} diverged, ` +
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

type Record_ = Record<string, Pick<Scoreboard, 'corpus' | 'statements' | 'compared' | 'identical' | 'outOfSubset'>>;
const keyOf = (r: Scoreboard): string => `${r.shape} ${r.corpus}`;

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
      const r = runShape(await shapeOf(name), CI_CORPUS[name], corpusPaths(CI_CORPUS[name]), 4);
      console.log(formatScoreboard(r));
      next[keyOf(r)] = { corpus: r.corpus, statements: r.statements, compared: r.compared, identical: r.identical, outOfSubset: r.outOfSubset };
      const was = record[keyOf(r)];
      if (!was) { problems.push(`${keyOf(r)}: no record (run with --check --write)`); continue; }
      if (r.identical < was.identical) problems.push(`${keyOf(r)}: identical ${was.identical} -> ${r.identical}`);
      if (r.compared < was.compared) problems.push(`${keyOf(r)}: compared ${was.compared} -> ${r.compared}`);
      if (r.compared - r.identical > was.compared - was.identical) problems.push(`${keyOf(r)}: diverged ${was.compared - was.identical} -> ${r.compared - r.identical}`);
    }
    if (write) { writeFileSync(RECORD, JSON.stringify(next, null, 1) + '\n'); console.log(`recorded ${RECORD.pathname}`); }
    else if (problems.length) { console.error(`shape2-oracle: REGRESSION against the record:\n  ${problems.join('\n  ')}`); process.exit(1); }
    else console.log('shape2-oracle: no regression against the record');
  } else {
    const shape = await shapeOf(args.shift() ?? '');
    const samples = args.indexOf('--samples') >= 0 ? Number(args.splice(args.indexOf('--samples'), 2)[1]) : 12;
    const reports = (args.length ? args : ['conformance']).map((c) => runShape(shape, c, corpusPaths(c), samples));
    for (const r of reports) console.log(formatScoreboard(r));
    if (out) writeFileSync(out, JSON.stringify(reports, null, 1));
  }
}
