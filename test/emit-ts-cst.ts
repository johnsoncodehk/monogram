// Gate: the tsTarget CST contract.
//
// The CST is source spans: nodes { rule, children, offset, end }, leaves { tokenType, offset, end }.
// Token indices are not part of the CST — no node or leaf, from parse(), parseWith(cstBuilder)
// or a createDoc() session, carries one. The lexer scans every '>' alone; an operator leaf at a
// '>' spans the adjacent tokens composing a '>'-led operator (`>>`, `>>>=`, ...), every other leaf
// is exactly one tokenize() token.
// Incremental sessions — the CST fast path and a consumer builder — equal a fresh parse after
// every edit, including edits around composed '>' operators.
//
//   node test/emit-ts-cst.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser, tsTarget } from '../src/emit.ts';
import { scratchDir } from './scratch.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};

type Cst = { rule: string; children: Cst[]; offset: number; end: number } | { tokenType: string; offset: number; end: number };
type Tok = { kind: string; text: string; off: number; end: number };
type Edit = { start: number; end: number; text: string };
type Doc<H> = { root(): H | null; edit(e: Edit[]): H | null };
type B = { leaf(tt: string, kid: number, lid: number, off: number, end: number): unknown; node(rule: string, kids: unknown[], off: number, end: number): unknown; shift?(h: unknown, bd: number, td: number): unknown };
type Mod = {
  tokenize(s: string): Tok[]; parse(s: string): Cst | null; parseWith<H>(s: string, b: B): H | null;
  cstBuilder: B; createDoc<H = Cst>(s: string, opts?: { builder?: B; validate?: boolean }): Doc<H>;
};

const grammar = (await import('../typescript.ts')).default;
const dir = scratchDir('ts-cst');
const file = join(dir, 'parser.ts');
writeFileSync(file, emitParser(grammar, tsTarget));
const m = (await import(file)) as Mod;

const NODE_KEYS = JSON.stringify(['rule', 'children', 'offset', 'end']);
const LEAF_KEYS = JSON.stringify(['tokenType', 'offset', 'end']);
function shapeErrors(c: Cst | null): number {
  if (c === null) return 1;
  if ('children' in c) return (JSON.stringify(Object.keys(c)) === NODE_KEYS ? 0 : 1) + c.children.reduce((a, k) => a + shapeErrors(k), 0);
  return JSON.stringify(Object.keys(c)) === LEAF_KEYS ? 0 : 1;
}
const leavesOf = (c: Cst, out: { offset: number; end: number }[] = []) => {
  if ('children' in c) c.children.forEach((k) => leavesOf(k, out)); else out.push(c);
  return out;
};

const SPLIT = 'let x: Array<Array<number>> = y; foo(bar);\nlet z: Map<string, Set<number>>= q;\nconst w = 1;\n';
for (const s of [SPLIT, 'let a = b >> c; let d: A<B<C<D>>> = e >>> f;\n', 'function f<T>(x: Array<T>): T { return x[0]; }\n']) {
  const tag = JSON.stringify(s.slice(0, 30));
  const cst = m.parse(s);
  check(`parse() CST has only span fields for ${tag}`, shapeErrors(cst) === 0);
  check(`parseWith(cstBuilder) CST has only span fields for ${tag}`, shapeErrors(m.parseWith<Cst>(s, m.cstBuilder)) === 0);
  check(`createDoc().root() has only span fields for ${tag}`, shapeErrors(m.createDoc(s).root()) === 0);
  const toks = m.tokenize(s);
  check(`tokenize() never composes '>' for ${tag}`, toks.every((t) => t.text[0] !== '>' || t.text === '>'));
  const runOk = (l: Cst & { tokenType: string }) => {
    const i = toks.findIndex((t) => t.off === l.offset), j = toks.findIndex((t) => t.end === l.end);
    if (i < 0 || j < i) return false;
    if (i === j) return true;
    return l.tokenType === '$operator' && toks[i]!.text === '>' && toks.slice(i + 1, j + 1).every((t, k) => t.off === toks[i + k]!.end && t.text.length === 1);
  };
  const bad = leavesOf(cst!).filter((l) => !runOk(l as Cst & { tokenType: string }));
  check(`every leaf is one tokenize() token or a composed '>' operator for ${tag}`, bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  const composed = leavesOf(cst!).filter((l) => l.end - l.offset > 1 && s[l.offset] === '>').map((l) => s.slice(l.offset, l.end));
  check(`composed operator leaves for ${tag}`, JSON.stringify(composed) === JSON.stringify([...s.matchAll(/ (>>>?=?|>=) /g)].map((x) => x[1])), JSON.stringify(composed));
}

// Incremental sessions around composed '>' operators.
const edits: Edit[] = [];
{
  let t = SPLIT;
  for (let i = 0; i < 18; i++) {
    const semis = [...t.matchAll(/;/g)].map((x) => x.index!);
    const p = semis[(i * 7) % semis.length]! + 1;
    const ins = i % 3 === 0 ? ' let k: A<B<C>> = 1;' : i % 3 === 1 ? '\n' : ' ';
    edits.push({ start: p, end: p, text: ins });
    t = t.slice(0, p) + ins + t.slice(p);
  }
  const gt = t.indexOf('>>');
  edits.push({ start: gt, end: gt + 2, text: '> >' }, { start: gt, end: gt + 3, text: '>>' });
}
const mirror: B = {
  leaf: (tt, _k, _l, off, end) => (tt === '$punct' ? null : { tt, off, end }),
  node: (r, c, off, end) => ({ r, c, off, end }),
  shift: (h, bd) => { const go = (x: any) => { x.off += bd; x.end += bd; if (x.c) x.c.forEach(go); }; go(h); return h; },
};
for (const [label, mk, fresh] of [
  ['createDoc (CST fast path)', () => m.createDoc(SPLIT), (s: string) => m.parse(s)],
  ['createDoc (CST, validate)', () => m.createDoc(SPLIT, { validate: true }), (s: string) => m.parse(s)],
  ['createDoc (consumer builder)', () => m.createDoc(SPLIT, { builder: mirror }), (s: string) => m.parseWith(s, mirror)],
] as [string, () => Doc<unknown>, (s: string) => unknown][]) {
  const d = mk();
  let text = SPLIT, bad = 0, first = '';
  for (const e of edits) {
    text = text.slice(0, e.start) + e.text + text.slice(e.end);
    let got = '';
    try { d.edit([e]); got = JSON.stringify(d.root()); } catch (err) { got = 'threw ' + (err as Error).message; }
    if (got !== JSON.stringify(fresh(text))) { bad++; if (!first) first = JSON.stringify(text); }
  }
  check(`${label} ≡ fresh parse after every edit around '>' composites`, bad === 0, `${bad}/${edits.length} steps differ, first on ${first}`);
}

console.log(`\n${ok}/${ok + fail} ts-cst checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
