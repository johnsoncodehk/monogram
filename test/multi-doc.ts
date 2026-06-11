// Gate: DOCUMENTS ARE ISOLATED and the handle API is TOTAL. Each parser instance
// keeps one document's state behind a lazily-swapped register set — a missed swap
// field shows up as cross-document corruption. Two instances edit two different
// sources interleaved (with the module-level default-doc API mixed in between);
// every edited tree AND its errors field must be byte-identical to a fresh handle
// parse of the same text — syntax-breaking edits included (parse/edit never throw
// on input; the strict→recovering two-pass produces the error tree). Also pins the
// handle contract: in-place edits, API misuse throws, re-opening invalidates.
//
//   node test/multi-doc.ts
import { writeFileSync } from 'node:fs';
import { emitParser } from '../src/emit-parser.ts';
import { objectify } from './emitted-obj.ts';

const grammar = (await import('../typescript.ts')).default;
const emPath = '/tmp/emitted-multidoc.mjs';
writeFileSync(emPath, emitParser(grammar));
type Edit = { start: number; end: number; text: string };
type Cst = { root: number; errors: { offset: number; end: number; message: string }[] };
type Parser = { parse(s: string): Cst; edit(cst: Cst, edits: Edit[]): void; visit(cst: Cst, fns: object): void; tree: import('./emitted-obj.ts').TreeView };
type Em = { parse(s: string): number; createParser(): Parser };
const em = (await import(emPath + '?v=' + process.pid)) as Em;

// Two synthetic documents (no corpus dependency — the gate always exercises).
const mk = (tag: string, n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += `function ${tag}_${i}(a) { if (a > ${i}) { return a * ${i}; } const v_${i} = { x: ${i} }; return v_${i}.x; }\n`;
  return s;
};
let textA = mk('alpha', 400);
let textB = `(function () {\n${mk('beta', 300)}})();\n`;

let seed = 0x51C0FFEE;
const rand = () => ((seed = (seed * 48271) % 0x7fffffff) / 0x7fffffff);
const randInt = (n: number) => Math.floor(rand() * n);
const INS = ['x', '1', ' + q', '.m', '(/*c*/)', '"s"', ';'];
function mutate(text: string): { next: string; edit: Edit } {
  switch (randInt(3)) {
    case 0: {
      const at = randInt(text.length);
      const ins = INS[randInt(INS.length)];
      return { next: text.slice(0, at) + ins + text.slice(at), edit: { start: at, end: at, text: ins } };
    }
    case 1: {
      const at = randInt(Math.max(1, text.length - 6));
      const n = 1 + randInt(4);
      return { next: text.slice(0, at) + text.slice(at + n), edit: { start: at, end: at + n, text: '' } };
    }
    default: {
      const at = randInt(Math.max(1, text.length - 1));
      return { next: text.slice(0, at) + 'z' + text.slice(at + 1), edit: { start: at, end: at + 1, text: 'z' } };
    }
  }
}

const p1 = em.createParser();
const p2 = em.createParser();
const f = em.createParser();
const cstA = p1.parse(textA);
const cstB = p2.parse(textB);

let steps = 0, equal = 0, withErrors = 0, mismatch = 0;
const failures: string[] = [];
for (let k = 0; k < 60; k++) {
  const onA = (k & 1) === 0;
  const text = onA ? textA : textB;
  const { next, edit } = mutate(text);
  steps++;
  // parse/edit are TOTAL: syntax-breaking steps produce error trees compared
  // exactly like valid ones (tree AND the errors field, byte-identical)
  const fc = f.parse(next);
  (onA ? p1 : p2).edit(onA ? cstA : cstB, [edit]);
  if (fc.errors.length > 0) withErrors++;
  // mix the module-level default doc in between: it must not disturb either instance
  if (k % 5 === 0) em.parse('const mix = ' + k + ';');
  const a = JSON.stringify(objectify(f.tree, (fns) => f.visit(fc, fns))) + JSON.stringify(fc.errors);
  const q = onA ? p1 : p2;
  const b = JSON.stringify(objectify(q.tree, (fns) => q.visit(onA ? cstA : cstB, fns))) + JSON.stringify((onA ? cstA : cstB).errors);
  if (a === b) equal++;
  else {
    mismatch++;
    if (failures.length < 5) {
      let i = 0; while (i < a.length && a[i] === b[i]) i++;
      failures.push(`step ${k} (${onA ? 'A' : 'B'}): tree/errors diverge @${i}`);
    }
  }
  if (onA) textA = next; else textB = next;
}

// handle contract: edit mutates the handle IN PLACE and is TOTAL — invalid text
// produces an error tree plus cst.errors, never a throw; API MISUSE (no changes,
// foreign handles, out-of-range coordinates) still throws; re-opening via parse()
// invalidates prior handles regardless of outcome.
let contract = 0;
{
  const p = em.createParser();
  const c1 = p.parse('const a = 1;');
  const obj = (h: Cst) => JSON.stringify(objectify(p.tree, (fns) => p.visit(h, fns)));
  if (c1.errors.length === 0) contract++;
  else failures.push('valid parse reported errors');
  p.edit(c1, [{ start: 7, end: 7, text: 'b' }]);   // 'const a = 1;' -> 'const ab = 1;'
  const after = obj(c1);
  if (after.includes('"end":8') && c1.errors.length === 0) contract++;   // same handle, new tree
  else failures.push('in-place edit did not update the handle');
  try { p2.edit(c1, [{ start: 0, end: 1, text: 'q' }]); failures.push('foreign handle did not throw'); } catch { contract++; }
  // an INVALID edit is total: error tree + diagnostics, handle stays live
  p.edit(c1, [{ start: 6, end: 8, text: ']' }]);   // 'const ab…' -> 'const ] = 1;'
  if (c1.errors.length > 0 && obj(c1) !== after) contract++;
  else failures.push('invalid edit did not surface errors');
  // fixing it in the editor's coordinates drains the errors
  p.edit(c1, [{ start: 6, end: 7, text: 'ab' }]);  // -> 'const ab = 1;'
  if (c1.errors.length === 0 && obj(c1) === after) contract++;
  else failures.push('fixing edit did not drain errors');
  // misuse still throws
  let needsRanges = false;
  try { (p as unknown as { edit(c: Cst): void }).edit(c1); } catch { needsRanges = true; }
  if (needsRanges) contract++;
  else failures.push('edit() without changes did not throw');
  let oob = false;
  try { p.edit(c1, [{ start: 5, end: 99999, text: '' }]); } catch { oob = true; }
  if (oob) contract++;
  else failures.push('out-of-range change did not throw');
  // a REJECTING-grammar parse() is total too, and re-opening kills old handles
  const c2 = p.parse('const ] = ;');
  if (c2.errors.length > 0) contract++;
  else failures.push('invalid parse() reported no errors');
  let dead = false;
  try { obj(c1); } catch { dead = true; }
  if (dead) contract++;
  else failures.push('re-opened document: old handle did not throw');
}

console.log(`multi-doc: ${equal} equal (${withErrors} recovered with errors) · ${mismatch} MISMATCH (${steps} interleaved steps) · contract ${contract}/9`);
for (const s of failures) console.log('  ✗ ' + s);
if (mismatch > 0 || contract !== 9 || failures.length > 0) {
  console.error('✗ document isolation / handle contract violated');
  process.exit(1);
}
console.log('✓ documents are isolated; the total in-place handle contract holds');
