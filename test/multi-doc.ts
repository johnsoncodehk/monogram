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
type Edit = { start: number; end: number; text: string };
type Cst = { root: number };
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
const INS = ['x', '1', ' + q', '.m', '(/*c*/)', '"s"'];
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

function diffChange(a: string, b: string): Edit {
  const minL = Math.min(a.length, b.length);
  let s = 0;
  while (s < minL && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let e = 0;
  while (e < minL - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
  return { start: s, end: a.length - e, text: b.slice(s, b.length - e) };
}

const p1 = em.createParser();
const p2 = em.createParser();
const f = em.createParser();
let cstA = p1.parse(textA);
let cstB = p2.parse(textB);

let steps = 0, equal = 0, bothReject = 0, mismatch = 0, reverts = 0;
const failures: string[] = [];
for (let k = 0; k < 60; k++) {
  const onA = (k & 1) === 0;
  const text = onA ? textA : textB;
  const { next, edit } = mutate(text);
  steps++;
  let fe: string | null = null, ie: string | null = null;
  let fc: Cst | null = null;
  try { fc = f.parse(next); } catch (e) { fe = (e as Error).message; }
  try { (onA ? p1 : p2).edit(onA ? cstA : cstB, [edit]); } catch (e) { ie = (e as Error).message; }
  if (fe !== null || ie !== null) {
    if ((fe === null) !== (ie === null)) { mismatch++; if (failures.length < 5) failures.push(`step ${k} (${onA ? 'A' : 'B'}): fresh ${fe ? 'reject' : 'accept'} / edit ${ie ? 'reject' : 'accept'}`); }
    else bothReject++;
    // the DOCUMENT advances on reject (editor-buffer model): later coordinates
    // are against the rejected text. Model the editor's UNDO: revert to the last
    // good text via a diff edit in the rejected text's coordinates — it must be
    // ACCEPTED and byte-identical to a fresh parse (the post-reject recovery path
    // gets exercised every time a mutation breaks the document).
    const good = onA ? textA : textB;
    const rv = diffChange(next, good);
    try {
      (onA ? p1 : p2).edit(onA ? cstA : cstB, [rv]);
      const fb = f.parse(good);
      const ra = JSON.stringify(objectify(f.tree, (fns) => f.visit(fb, fns)));
      const qq = onA ? p1 : p2;
      const rb = JSON.stringify(objectify(qq.tree, (fns) => qq.visit(onA ? cstA : cstB, fns)));
      if (ra === rb) reverts++;
      else { mismatch++; if (failures.length < 5) failures.push(`step ${k} (${onA ? 'A' : 'B'}): REVERT tree diverges`); }
    } catch (e2) {
      mismatch++;
      if (failures.length < 5) failures.push(`step ${k} (${onA ? 'A' : 'B'}): revert rejected: ${(e2 as Error).message.slice(0, 50)}`);
    }
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
  p.edit(c1, [{ start: 7, end: 7, text: 'b' }]);   // 'const a = 1;' -> 'const ab = 1;'
  const after = obj(c1);
  if (after !== before && after.includes('"end":8')) contract++;   // same handle, new tree
  else failures.push('in-place edit did not update the handle');
  try { p2.edit(c1, [{ start: 0, end: 1, text: 'q' }]); failures.push('foreign handle did not throw'); } catch { contract++; }
  let rejected = false;
  try { p.edit(c1, [{ start: 6, end: 8, text: ']' }]); } catch { rejected = true; }   // 'const ab…' -> 'const ] = 1;'
  if (rejected && obj(c1) === after) contract++;   // reject keeps the tree
  else failures.push('reject-then-read flow broke');
  // coordinates after a REJECT are against the editor's buffer (the rejected text):
  // fixing the same spot in those coordinates must recover the session
  let recovered = false;
  try { p.edit(c1, [{ start: 6, end: 7, text: 'ab' }]); recovered = true; } catch { /* must not throw */ }
  if (recovered && obj(c1).includes('"end":13')) contract++;   // 'const ] = 1;' -> 'const ab = 1;'
  else failures.push('post-reject coordinates did not track the document text');
  const c2 = p.parse('let q = 1;');
  try { obj(c1); failures.push('re-opened document: old handle did not throw'); } catch { contract++; }
  // missing ranges: ONE usage only — edit() without ranges must throw, not
  // silently fall back to O(file) diff scans
  let needsRanges = false;
  try { (p as unknown as { edit(c: Cst): void }).edit(c2); } catch { needsRanges = true; }
  if (needsRanges) contract++;
  else failures.push('edit() without changes did not throw');
  // a REJECTING parse() resets the arena too — it must invalidate prior handles
  try { p.parse('const ] = ;'); } catch { /* expected reject */ }
  let dead = false;
  try { obj(c2); } catch { dead = true; }
  if (dead) contract++;
  else failures.push('rejecting parse() left the old handle readable over a reset arena');
}

console.log(`multi-doc: ${equal} equal · ${bothReject} both-reject (${reverts} reverts verified) · ${mismatch} MISMATCH (${steps} interleaved steps) · contract ${contract}/7`);
for (const s of failures) console.log('  ✗ ' + s);
if (mismatch > 0 || contract !== 7 || failures.length > 0) {
  console.error('✗ document isolation / handle contract violated');
  process.exit(1);
}
console.log('✓ documents are isolated; handles enforce the in-place-edit contract');
