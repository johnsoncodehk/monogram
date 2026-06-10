// Gate: DOCUMENTS ARE ISOLATED. The handle API (createParser → parse/edit with
// explicit tree handles) keeps one document's state per parser instance behind a
// lazily-swapped register set — a missed swap field shows up as cross-document
// corruption. Two instances edit two different sources interleaved (plus the
// module-level default-doc API mixed in between); every edited tree must be
// byte-identical (toObject) to a fresh parse of the same text. Also pins the
// handle contract: stale and foreign handles throw instead of silently reading
// an in-place-mutated tree, and a REJECTED edit leaves the old handle valid.
//
//   node test/multi-doc.ts
import { objectify } from './emitted-obj.ts';
import { writeFileSync } from 'node:fs';
import { emitParser } from '../src/emit-parser.ts';

const grammar = (await import('../typescript.ts')).default;
const emPath = '/tmp/emitted-multidoc.mjs';
writeFileSync(emPath, emitParser(grammar));
type Edit = { start: number; oldEnd: number; newEnd: number };
type Cst = { root: number };
type Parser = { parse(s: string): Cst; edit(cst: Cst, s: string, edits?: Edit[]): void; visit(cst: Cst, fns: object): void; tree: import('./emitted-obj.ts').TreeView };
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
const INS = ['x', '1', ' + q', '.m', '(/*c*/)', '"s"'];
function mutate(text: string): string {
  switch (randInt(3)) {
    case 0: { const at = randInt(text.length); return text.slice(0, at) + INS[randInt(INS.length)] + text.slice(at); }
    case 1: { const at = randInt(Math.max(1, text.length - 6)); return text.slice(0, at) + text.slice(at + 1 + randInt(4)); }
    default: { const at = randInt(Math.max(1, text.length - 1)); return text.slice(0, at) + 'z' + text.slice(at + 1); }
  }
}

const p1 = em.createParser();
const p2 = em.createParser();
const f = em.createParser();
let cstA = p1.parse(textA);
let cstB = p2.parse(textB);

let steps = 0, equal = 0, bothReject = 0, mismatch = 0;
const failures: string[] = [];
for (let k = 0; k < 60; k++) {
  const onA = (k & 1) === 0;
  const text = onA ? textA : textB;
  const next = mutate(text);
  steps++;
  let fe: string | null = null, ie: string | null = null;
  let fc: Cst | null = null;
  try { fc = f.parse(next); } catch (e) { fe = (e as Error).message; }
  try { (onA ? p1 : p2).edit(onA ? cstA : cstB, next); } catch (e) { ie = (e as Error).message; }
  if (fe !== null || ie !== null) {
    if ((fe === null) !== (ie === null)) { mismatch++; if (failures.length < 5) failures.push(`step ${k} (${onA ? 'A' : 'B'}): fresh ${fe ? 'reject' : 'accept'} / edit ${ie ? 'reject' : 'accept'}`); }
    else bothReject++;
    continue;
  }
  // mix the module-level default doc in between: it must not disturb either instance
  if (k % 5 === 0) em.parse('const mix = ' + k + ';');
  const a = JSON.stringify(objectify(f.tree, (fns) => f.visit(fc!, fns)));
  const q = onA ? p1 : p2;
  const b = JSON.stringify(objectify(q.tree, (fns) => q.visit(onA ? cstA : cstB, fns)));
  if (a === b) equal++;
  else {
    mismatch++;
    if (failures.length < 5) {
      let i = 0; while (i < a.length && a[i] === b[i]) i++;
      failures.push(`step ${k} (${onA ? 'A' : 'B'}): tree diverges @${i}`);
    }
  }
  if (onA) textA = next; else textB = next;
}

// handle contract: edit mutates the handle IN PLACE (no return — no clone illusion);
// only parse() re-opening the document invalidates old handles; rejects keep the tree.
let contract = 0;
{
  const p = em.createParser();
  const c1 = p.parse('const a = 1;');
  const obj = (h: Cst) => JSON.stringify(objectify(p.tree, (fns) => p.visit(h, fns)));
  const before = obj(c1);
  p.edit(c1, 'const ab = 1;');
  const after = obj(c1);
  if (after !== before && after.includes('"end":8')) contract++;   // same handle, new tree
  else failures.push('in-place edit did not update the handle');
  try { p2.edit(c1, 'const y = 3;'); failures.push('foreign handle did not throw'); } catch { contract++; }
  let rejected = false;
  try { p.edit(c1, 'const ] = ;'); } catch { rejected = true; }
  if (rejected && obj(c1) === after) contract++;   // reject keeps the tree
  else failures.push('reject-then-read flow broke');
  const c2 = p.parse('let q = 1;');
  try { obj(c1); failures.push('re-opened document: old handle did not throw'); } catch { contract++; }
  // a REJECTING parse() resets the arena too — it must invalidate prior handles
  try { p.parse('const ] = ;'); } catch { /* expected reject */ }
  let dead = false;
  try { obj(c2); } catch { dead = true; }
  if (dead) contract++;
  else failures.push('rejecting parse() left the old handle readable over a reset arena');
}

console.log(`multi-doc: ${equal} equal · ${bothReject} both-reject · ${mismatch} MISMATCH (${steps} interleaved steps) · contract ${contract}/5`);
for (const s of failures) console.log('  ✗ ' + s);
if (mismatch > 0 || contract !== 5 || failures.length > 0) {
  console.error('✗ document isolation / handle contract violated');
  process.exit(1);
}
console.log('✓ documents are isolated; handles enforce the in-place-edit contract');
