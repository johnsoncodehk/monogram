// The AST oracle harness: ONE normalised tree form, ONE comparison, ONE report. An oracle
// (test/shape-oracle-tsc.ts: the real `typescript` parser; test/shape-oracle-estree.ts: acorn)
// turns source text into an NTree; a CANDIDATE (anything monogram produces: the hand-written
// lowering, a ShapeSpec's parseAst, a spec interpreter) is a function from source text to an
// NTree in the same form. `compareTrees` walks both; `runCorpus` aggregates over files.
//
// The comparison (declared here, in one place):
// - A node is { kind, start, end, pos?, fields }. `kind` and both span ends are compared first;
//   a mismatch there is recorded and the subtree is skipped (its children would only repeat it).
//   `pos` (tsc's full start, leading trivia included) is compared only when the oracle and the
//   candidate both carry it.
// - Fields are compared BY NAME; their order is not compared (neither a tsc property list nor
//   an ESTree object is ordered by meaning). A field only one side has is a divergence.
// - A list is compared by length, then element by element, in order.
// - Scalars (string, number, boolean, null) are compared with ===; a record (a plain object
//   such as acorn's `regex: { pattern, flags }`) field by field.
// - Every divergence is counted; the FIRST (pre-order) is the file's reported one.
import { readdirSync, readFileSync, statSync } from 'node:fs';

export type NValue = NTree | NValue[] | string | number | boolean | null | NRecord;
export type NRecord = { record: Record<string, NValue> };
export type NTree = {
  kind: string;
  start: number;
  end: number;
  /** tsc only: the full start (`node.pos`, leading trivia included). */
  pos?: number;
  fields: Record<string, NValue>;
};

/** A shape's value (flat nodes, src/shape/shape2-eval.ts ShapeNode, their kind and span under the
 * shape's node keys) in the harness's form: every node an NTree, its fields apart. */
export function nestValue(v: unknown, keys: { kind: string; start: string; end: string }): NValue {
  if (v === null || typeof v !== 'object') return v as NValue;
  if (Array.isArray(v)) return v.map((x) => nestValue(x, keys));
  const o = v as Record<string, unknown>;
  if ('record' in o && !(keys.kind in o)) return { record: Object.fromEntries(Object.entries(o.record as object).map(([k, x]) => [k, nestValue(x, keys)])) };
  const fields: Record<string, NValue> = {};
  for (const [k, x] of Object.entries(o)) if (k !== keys.kind && k !== keys.start && k !== keys.end && x !== undefined) fields[k] = nestValue(x, keys);
  return { kind: o[keys.kind] as string, start: o[keys.start] as number, end: o[keys.end] as number, fields };
}

/** What a candidate or an oracle returns for one file. */
export type Produced = { tree: NTree } | { skip: string } | { fail: string };
export type Producer = (src: string, path: string) => Produced;

export type DivClass =
  | 'kind' | 'span' | 'pos' | 'field-missing' | 'field-extra' | 'list-length' | 'value' | 'type';
export type Divergence = { path: string; cls: DivClass; at: string; expected: string; got: string };
export type CompareStats = { matched: number; divergences: Divergence[] };

const isTree = (v: NValue): v is NTree => v !== null && typeof v === 'object' && !Array.isArray(v) && 'kind' in v;
const isRecord = (v: NValue): v is NRecord => v !== null && typeof v === 'object' && !Array.isArray(v) && 'record' in v;
const show = (v: NValue | undefined): string => {
  if (v === undefined) return '(absent)';
  if (isTree(v)) return `${v.kind}@${v.start}..${v.end}`;
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isRecord(v)) return JSON.stringify(v.record);
  return JSON.stringify(v);
};
const typeOf = (v: NValue): string => isTree(v) ? 'node' : Array.isArray(v) ? 'list' : isRecord(v) ? 'record' : v === null ? 'null' : typeof v;

/** Compare an oracle tree against a candidate tree; every divergence, pre-order. */
export function compareTrees(expected: NTree, got: NTree, limit = Infinity): CompareStats {
  const st: CompareStats = { matched: 0, divergences: [] };
  const div = (path: string, cls: DivClass, at: string, e: NValue | undefined, g: NValue | undefined): void => {
    if (st.divergences.length < limit) st.divergences.push({ path, cls, at, expected: show(e), got: show(g) });
    else st.divergences.length++;
  };
  const node = (e: NTree, g: NTree, path: string): void => {
    if (e.kind !== g.kind) return div(path, 'kind', e.kind, e.kind, g.kind);
    if (e.start !== g.start || e.end !== g.end) return div(path, 'span', e.kind, `${e.start}..${e.end}`, `${g.start}..${g.end}`);
    if (e.pos !== undefined && g.pos !== undefined && e.pos !== g.pos) return div(path, 'pos', e.kind, e.pos, g.pos);
    st.matched++;
    for (const k of Object.keys(e.fields)) {
      if (!(k in g.fields)) { div(`${path}.${k}`, 'field-missing', e.kind, e.fields[k], undefined); continue; }
      value(e.fields[k], g.fields[k], `${path}.${k}`, e.kind);
    }
    for (const k of Object.keys(g.fields)) if (!(k in e.fields)) div(`${path}.${k}`, 'field-extra', e.kind, undefined, g.fields[k]);
  };
  const value = (e: NValue, g: NValue, path: string, owner: string): void => {
    if (typeOf(e) !== typeOf(g)) return div(path, 'type', owner, e, g);
    if (isTree(e)) return node(e, g as NTree, path);
    if (Array.isArray(e)) {
      const ga = g as NValue[];
      if (e.length !== ga.length) return div(path, 'list-length', owner, e, ga);
      for (let i = 0; i < e.length; i++) value(e[i], ga[i], `${path}[${i}]`, owner);
      return;
    }
    if (isRecord(e)) {
      const gr = (g as NRecord).record;
      for (const k of Object.keys(e.record)) {
        if (!(k in gr)) div(`${path}.${k}`, 'field-missing', owner, e.record[k], undefined);
        else value(e.record[k], gr[k], `${path}.${k}`, owner);
      }
      for (const k of Object.keys(gr)) if (!(k in e.record)) div(`${path}.${k}`, 'field-extra', owner, undefined, gr[k]);
      return;
    }
    if (e !== g) div(path, 'value', owner, e, g);
  };
  node(expected, got, '$');
  return st;
}

/** The structure VIEW: kind + span + every child node in field order, names dropped. It is
 * what a candidate without field names (test/ts-ast-lowering.ts) can be compared on. A field
 * order matters here, so the oracle's field order is its child order (tsc: forEachChild). */
export function structureView(t: NTree, keep: (field: string, owner: NTree) => boolean = () => true): NTree {
  const children: NTree[] = [];
  const walk = (v: NValue): void => {
    if (isTree(v)) children.push(structureView(v, keep));
    else if (Array.isArray(v)) v.forEach(walk);
  };
  for (const [k, v] of Object.entries(t.fields)) if (keep(k, t)) walk(v);
  return { kind: t.kind, start: t.start, end: t.end, fields: { children } };
}

export type FileResult = { path: string; status: 'identical' | 'diverged' | 'skipped' | 'candidate-failed' | 'oracle-failed'; note?: string; matched?: number; divergences?: number; first?: Divergence };
export type CorpusReport = {
  corpus: string;
  files: number;
  compared: number;
  identical: number;
  skipped: number;
  oracleFailed: number;
  candidateFailed: number;
  matchedNodes: number;
  divergences: number;
  /** "<class> <kind>" -> count, over every divergence of every file (the first 64 of a file). */
  histogram: Record<string, number>;
  /** "<class> <kind>" -> count, over each file's FIRST divergence only. */
  firstHistogram: Record<string, number>;
  /** Why a candidate failed, first 60 chars -> count. */
  failures: Record<string, number>;
  results: FileResult[];
};

export type CorpusFile = { path: string; src: string };
export const readCorpus = (paths: string[]): CorpusFile[] => paths.map((path) => ({ path, src: readFileSync(path, 'utf-8') }));

/** Run a candidate against an oracle over a corpus. */
export function runCorpus(corpus: string, files: CorpusFile[], oracle: Producer, candidate: Producer): CorpusReport {
  const r: CorpusReport = { corpus, files: files.length, compared: 0, identical: 0, skipped: 0, oracleFailed: 0, candidateFailed: 0, matchedNodes: 0, divergences: 0, histogram: {}, firstHistogram: {}, failures: {}, results: [] };
  const bump = (h: Record<string, number>, k: string): void => { h[k] = (h[k] ?? 0) + 1; };
  for (const f of files) {
    const o = oracle(f.src, f.path);
    if ('skip' in o) { r.skipped++; r.results.push({ path: f.path, status: 'skipped', note: o.skip }); continue; }
    if ('fail' in o) { r.oracleFailed++; r.results.push({ path: f.path, status: 'oracle-failed', note: o.fail }); continue; }
    let c: Produced;
    try { c = candidate(f.src, f.path); } catch (e) { c = { fail: `THROW ${(e as Error).message}` }; }
    if ('skip' in c) { r.skipped++; r.results.push({ path: f.path, status: 'skipped', note: c.skip }); continue; }
    r.compared++;
    if ('fail' in c) {
      r.candidateFailed++;
      bump(r.failures, c.fail.replace(/ @\d+/g, "").slice(0, 60));
      r.results.push({ path: f.path, status: 'candidate-failed', note: c.fail });
      continue;
    }
    const st = compareTrees(o.tree, c.tree, 64);
    r.matchedNodes += st.matched;
    r.divergences += st.divergences.length;
    for (const d of st.divergences) if (d) bump(r.histogram, `${d.cls} ${d.at}`);
    if (st.divergences.length === 0) { r.identical++; r.results.push({ path: f.path, status: 'identical', matched: st.matched }); continue; }
    const first = st.divergences[0];
    bump(r.firstHistogram, `${first.cls} ${first.at}`);
    r.results.push({ path: f.path, status: 'diverged', matched: st.matched, divergences: st.divergences.length, first });
  }
  return r;
}

const top = (h: Record<string, number>, n: number): string[] =>
  Object.entries(h).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, v]) => `${String(v).padStart(7)}  ${k}`);

/** A plain-text report: the summary line, the first-divergence classes, failures, samples. */
export function formatReport(r: CorpusReport, opts: { top?: number; samples?: number } = {}): string {
  const n = opts.top ?? 15, s = opts.samples ?? 8;
  const out = [
    `${r.corpus}: ${r.files} files, ${r.compared} compared, ${r.identical} identical, ${r.compared - r.identical - r.candidateFailed} diverged, ${r.candidateFailed} candidate-failed, ${r.skipped} skipped, ${r.oracleFailed} oracle-failed; ${r.matchedNodes} nodes matched, ${r.divergences} divergences`,
  ];
  if (Object.keys(r.firstHistogram).length) out.push('  first divergence per file, by class and node kind:', ...top(r.firstHistogram, n).map((l) => '  ' + l));
  if (Object.keys(r.histogram).length) out.push('  all divergences, by class and node kind:', ...top(r.histogram, n).map((l) => '  ' + l));
  if (Object.keys(r.failures).length) out.push('  candidate failures:', ...top(r.failures, n).map((l) => '  ' + l));
  const ex = r.results.filter((x) => x.first).slice(0, s);
  if (ex.length) out.push('  samples:', ...ex.map((x) => `    ${x.path}: ${x.first!.cls} at ${x.first!.path} (${x.first!.at}): expected ${x.first!.expected}, got ${x.first!.got}`));
  return out.join('\n');
}

/** A ShapeSpec AST (what an emitted `parseAst` returns: `{ type, off?, end?, ...fields }`) in
 * the harness's form: `type` -> kind, `off` -> start; a span the spec did not emit is -1 (so it
 * is reported, never assumed); a string where the oracle has a node is reported as a `type`
 * divergence, not converted; an undefined field is absent; a plain object without `type` is a
 * record. */
export function fromShapeAst(v: unknown): NTree {
  const val = (x: unknown): NValue | undefined => {
    if (x === undefined) return undefined;
    if (x === null) return null;
    if (Array.isArray(x)) return x.map((e) => val(e) ?? null);
    if (typeof x === 'bigint') return `${x}n`;
    if (typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (typeof o.type === 'string') return fromShapeAst(o);
      const record: Record<string, NValue> = {};
      for (const [k, e] of Object.entries(o)) { const w = val(e); if (w !== undefined) record[k] = w; }
      return { record };
    }
    if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return x;
    return String(x);
  };
  const o = v as Record<string, unknown>;
  const fields: Record<string, NValue> = {};
  for (const [k, e] of Object.entries(o)) {
    if (k === 'type' || k === 'off' || k === 'end') continue;
    const w = val(e);
    if (w !== undefined) fields[k] = w;
  }
  return { kind: String(o.type), start: typeof o.off === 'number' ? o.off : -1, end: typeof o.end === 'number' ? o.end : -1, fields };
}

/** Single-file TS conformance cases: no `// @filename` (multi-file) directive. */
export function conformanceFiles(root = '/tmp/ts-repo/tests/cases/conformance'): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d).sort()) {
      const p = `${d}/${e}`;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(e) && !/^\s*\/\/\s*@filename\s*:/im.test(readFileSync(p, 'utf-8'))) out.push(p);
    }
  };
  walk(root);
  return out;
}

// ── Self-test (gate `shape-oracle`): each mutation of an oracle tree is reported once, with
// the right class, at the right path; the oracles' normalisation keeps what it declares. ──
if (import.meta.main) {
  const { tscOracle } = await import('./shape-oracle-tsc.ts');
  const { estreeOracle } = await import('./shape-oracle-estree.ts');
  let failed = 0;
  const check = (ok: boolean, what: string, detail = ''): void => {
    console.log(`${ok ? '✓' : '✗'} ${what}${ok || !detail ? '' : `\n    ${detail}`}`);
    if (!ok) failed++;
  };
  const tree = (p: Produced): NTree => { if (!('tree' in p)) throw new Error(JSON.stringify(p)); return p.tree; };
  const clone = (t: NTree): NTree => structuredClone(t);
  const at = (t: NTree, path: string): any => path.split(/\.|\[|\]/).filter(Boolean).slice(1).reduce((o: any, k) => (/^\d+$/.test(k) ? o[+k] : (o.fields ?? o.record)[k]), t);
  const one = (e: NTree, g: NTree, cls: DivClass, path: string, what: string): void => {
    const d = compareTrees(e, g).divergences;
    check(d.length === 1 && d[0].cls === cls && d[0].path === path, what, JSON.stringify(d));
  };

  const src = 'const a = f(b, c.d);';
  const t = tree(tscOracle(src, 'f.ts'));
  const self = compareTrees(t, clone(t));
  check(self.divergences.length === 0 && self.matched === 12, "tsc tree equals itself; 12 nodes matched", JSON.stringify(self));
  const call = '$.statements[0].declarationList.declarations[0].initializer';
  check(at(t, call).kind === 'CallExpression' && at(t, `${call}.arguments[1].name`).fields.text === 'd', 'tsc fields are named by property (initializer, arguments, name, text)');
  check(at(t, '$.statements[0].declarationList').fields.flags === 'Const', 'tsc syntactic flags: the declaration list is Const');
  check(t.kind === 'SourceFile' && 'endOfFileToken' in t.fields && t.pos === 0, 'tsc root: SourceFile with statements and endOfFileToken, pos recorded');
  { const g = clone(t); at(g, `${call}.arguments[1].name`).kind = 'PrivateIdentifier'; one(t, g, 'kind', `${call}.arguments[1].name`, 'a changed kind is reported at its path'); }
  { const g = clone(t); at(g, `${call}.arguments[1]`).kind = 'ElementAccessExpression'; one(t, g, 'kind', `${call}.arguments[1]`, 'a kind mismatch skips the subtree (one divergence)'); }
  { const g = clone(t); at(g, `${call}.arguments[0]`).end++; one(t, g, 'span', `${call}.arguments[0]`, 'a changed end is a span divergence'); }
  { const g = clone(t); at(g, `${call}.arguments[0]`).pos--; one(t, g, 'pos', `${call}.arguments[0]`, 'a changed full start is a pos divergence'); }
  { const g = clone(t); delete at(g, `${call}.arguments[0]`).pos; check(compareTrees(t, g).divergences.length === 0, 'pos is compared only when the candidate carries it'); }
  { const g = clone(t); delete at(g, call).fields.expression; one(t, g, 'field-missing', `${call}.expression`, 'a missing field is reported by name'); }
  { const g = clone(t); at(g, call).fields.optional = true; one(t, g, 'field-extra', `${call}.optional`, 'an extra field is reported by name'); }
  { const g = clone(t); at(g, `${call}.arguments`).pop(); one(t, g, 'list-length', `${call}.arguments`, 'a shorter list is a list-length divergence'); }
  { const g = clone(t); at(g, `${call}.arguments[0]`).fields.text = 'z'; one(t, g, 'value', `${call}.arguments[0].text`, 'a changed scalar is a value divergence'); }
  { const g = clone(t); at(g, call).fields.expression = 'f'; one(t, g, 'type', `${call}.expression`, 'a string where a node belongs is a type divergence'); }
  { const g = clone(t); const fs = at(g, call).fields; const { arguments: a, ...rest } = fs; at(g, call).fields = { arguments: a, ...rest };
    check(compareTrees(t, g).divergences.length === 0, 'field order is not compared'); }

  const sv = structureView(tree(tscOracle('a + b;', 'f.ts')));
  const bin = (sv.fields.children as NTree[])[0].fields.children as NTree[];
  check(JSON.stringify((bin[0].fields.children as NTree[]).map((c) => c.kind)) === '["Identifier","PlusToken","Identifier"]', 'structure view keeps forEachChild order (left, operatorToken, right)', JSON.stringify(bin));

  const e = tree(estreeOracle('x = [1, , /a/g, 2n];', 'f.js'));
  const arr = '$.body[0].expression.right';
  const els = at(e, `${arr}.elements`);
  check(els[1] === null && at(e, `${arr}.elements[2]`).fields.value === null && at(e, `${arr}.elements[3]`).fields.value === '2n', 'estree: hole is null, regex value null, bigint value text');
  { const g = clone(e); at(g, `${arr}.elements[2]`).fields.regex.record.flags = 'gi'; one(e, g, 'value', `${arr}.elements[2].regex.flags`, 'a record field divergence is reported at its path'); }
  { const g = clone(e); at(g, `${arr}.elements`)[1] = at(g, `${arr}.elements`)[0]; one(e, g, 'type', `${arr}.elements[1]`, 'a filled hole is a type divergence'); }
  check(e.fields.sourceType === 'module', 'estree: Module goal first');

  const es = tree(estreeOracle('x;\n\n', 'f.js'));
  one(es, fromShapeAst({ type: 'Program', off: 0, end: 4, body: [{ type: 'ExpressionStatement', off: 0, end: 2, expression: 'x' }], sourceType: 'module' }),
    'type', '$.body[0].expression', 'fromShapeAst: spans from off/end; a bare string where acorn has an Identifier is a type divergence');
  one(es, fromShapeAst({ type: 'Program', body: [], sourceType: 'module' }), 'span', '$', 'fromShapeAst: a span the spec did not emit is reported');

  const rep = runCorpus('selftest', [{ path: 'a', src }, { path: 'b', src: 'let q = 1;' }, { path: 'c', src: 'let = ;' }], tscOracle,
    (s, p) => p === 'b' ? { tree: (() => { const g = clone(tree(tscOracle(s, p))); at(g, '$.statements[0].declarationList').fields.flags = 'Const'; return g; })() } : tscOracle(s, p));
  check(rep.compared === 2 && rep.identical === 1 && rep.skipped === 1 && rep.firstHistogram['value VariableDeclarationList'] === 1
    && rep.results[1].first?.path === '$.statements[0].declarationList.flags', 'runCorpus: compared / identical / skipped / first divergence / histogram', JSON.stringify(rep));

  if (failed) { console.error(`✗ shape-oracle: ${failed} check(s) failed`); process.exit(1); }
  console.log('✓ shape-oracle harness self-test');
}
