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
import { writeFileSync } from 'node:fs';
import { emitParser } from '../src/emit-parser.ts';

const grammar = (await import('../typescript.ts')).default;
const emPath = '/tmp/emitted-multidoc.mjs';
writeFileSync(emPath, emitParser(grammar));
type Edit = { start: number; oldEnd: number; newEnd: number };
type Cst = { root: number };
type Parser = { parse(s: string): Cst; edit(cst: Cst, s: string, edits?: Edit[]): Cst; toObject(cst: Cst): unknown; visit(cst: Cst, fns: object): void };
type Em = { parse(s: string): number; toObject(id: number): unknown; createParser(): Parser };
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
  let fc: Cst | null = null, ic: Cst | null = null;
  try { fc = f.parse(next); } catch (e) { fe = (e as Error).message; }
  try { ic = (onA ? p1 : p2).edit(onA ? cstA : cstB, next); } catch (e) { ie = (e as Error).message; }
  if (fe !== null || ie !== null) {
    if ((fe === null) !== (ie === null)) { mismatch++; if (failures.length < 5) failures.push(`step ${k} (${onA ? 'A' : 'B'}): fresh ${fe ? 'reject' : 'accept'} / edit ${ie ? 'reject' : 'accept'}`); }
    else bothReject++;
    continue;
  }
  // mix the module-level default doc in between: it must not disturb either instance
  if (k % 5 === 0) em.parse('const mix = ' + k + ';');
  const a = JSON.stringify(f.toObject(fc!));
  const b = JSON.stringify((onA ? p1 : p2).toObject(ic!));
  if (a === b) equal++;
  else {
    mismatch++;
    if (failures.length < 5) {
      let i = 0; while (i < a.length && a[i] === b[i]) i++;
      failures.push(`step ${k} (${onA ? 'A' : 'B'}): tree diverges @${i}`);
    }
  }
  if (onA) { textA = next; cstA = ic!; } else { textB = next; cstB = ic!; }
}

// handle contract
let contract = 0;
{
  const p = em.createParser();
  const c1 = p.parse('const a = 1;');
  const c2 = p.edit(c1, 'const ab = 1;');
  try { p.edit(c1, 'const x = 2;'); failures.push('stale handle did not throw'); } catch { contract++; }
  try { p.toObject(c1); failures.push('stale toObject did not throw'); } catch { contract++; }
  try { p2.edit(c2, 'const y = 3;'); failures.push('foreign handle did not throw'); } catch { contract++; }
  // a rejected edit leaves the handle valid
  let rejected = false;
  try { p.edit(c2, 'const ] = ;'); } catch { rejected = true; }
  const c3 = rejected ? p.edit(c2, 'const ab = 12;') : null;
  if (!rejected || c3 === null) failures.push('reject-then-edit flow broke');
  else contract++;
}

console.log(`multi-doc: ${equal} equal · ${bothReject} both-reject · ${mismatch} MISMATCH (${steps} interleaved steps) · contract ${contract}/4`);
for (const s of failures) console.log('  ✗ ' + s);
if (mismatch > 0 || contract !== 4 || failures.length > 0) {
  console.error('✗ document isolation / handle contract violated');
  process.exit(1);
}
console.log('✓ documents are isolated; handles enforce the in-place-edit contract');
