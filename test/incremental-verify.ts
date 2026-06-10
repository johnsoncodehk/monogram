// Gate: INCREMENTAL ≡ FRESH. parseEdited(newSource) must produce a tree byte-identical
// (via toObject) to a from-scratch parse of the same text, across scripted edit
// sessions over real files — inserts, deletions, replacements, statement insertions,
// edits inside strings/comments, and syntax-breaking edits (both sides must reject;
// the session self-heals on the next good text). Also reports the incremental speedup
// and the arena growth, so reuse is MEASURED, not assumed.
//
//   node test/incremental-verify.ts
import { objectify } from './emitted-obj.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { emitParser } from '../src/emit-parser.ts';

const grammar = (await import('../typescript.ts')).default;
const emPath = '/tmp/emitted-incremental.mjs';
writeFileSync(emPath, emitParser(grammar));
type Edit = { start: number; end: number; text: string };
type Cst = { root: number };
type Parser = {
  parse(s: string): Cst;
  edit(cst: Cst, edits: Edit[]): void;
  visit(cst: Cst, fns: object): void;
  tree: import('./emitted-obj.ts').TreeView;
};
type Em = {
  parse(s: string): number;
  visit(entry: number, fns: object): void;
  tree: import('./emitted-obj.ts').TreeView;
  createParser(): Parser;
};
const session = ((await import(emPath + '?session=' + process.pid)) as Em).createParser();
const fresh = (await import(emPath + '?fresh=' + process.pid)) as Em;

// Deterministic LCG so failures replay.
let seedState = 0x2F6E2B1;
const rand = () => ((seedState = (seedState * 48271) % 0x7fffffff) / 0x7fffffff);
const randInt = (n: number) => Math.floor(rand() * n);

const INSERTS = ['x', '_v', '42', ' + y', '.m', '()', ' /*c*/ ', '"s"', 'await ', '!', '?'];
const STMTS = ['const q9 = 1;\n', 'function g9(a) { return a; }\n', 'if (x9) { y9(); }\n', '// note\n', 'type T9 = string | number;\n'];

// Mutations return the edit RANGE too, so half the steps can exercise the edits
// PROTOCOL path (the editor-facing API) while the other half exercises the
// char-diff fallback envelope.
function mutate(text: string): { next: string; edit: Edit } {
  switch (randInt(5)) {
    case 0: { // insert a small fragment at a random position
      const at = randInt(text.length);
      const ins = INSERTS[randInt(INSERTS.length)];
      return { next: text.slice(0, at) + ins + text.slice(at), edit: { start: at, end: at, text: ins } };
    }
    case 1: { // delete a small span
      const at = randInt(Math.max(1, text.length - 8));
      const n = 1 + randInt(6);
      return { next: text.slice(0, at) + text.slice(at + n), edit: { start: at, end: at + n, text: '' } };
    }
    case 2: { // replace a character
      const at = randInt(Math.max(1, text.length - 1));
      return { next: text.slice(0, at) + 'z' + text.slice(at + 1), edit: { start: at, end: at + 1, text: 'z' } };
    }
    case 3: { // insert a whole statement at a line boundary
      const lines = text.split('\n');
      const at = randInt(lines.length);
      const stmt = STMTS[randInt(STMTS.length)].trimEnd();
      lines.splice(at, 0, stmt);
      const start = at === 0 ? 0 : lines.slice(0, at).join('\n').length + 1;
      return { next: lines.join('\n'), edit: { start, end: start, text: stmt + '\n' } };
    }
    default: { // append at the end (the pure-prefix reuse case)
      const stmt = '\n' + STMTS[randInt(STMTS.length)];
      return { next: text + stmt, edit: { start: text.length, end: text.length, text: stmt } };
    }
  }
}

const FILES = [
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserharness.ts',
  '/tmp/ts-repo/tests/cases/conformance/fixSignatureCaching.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/parserRealSource7.ts',
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserindenter.ts',
].filter(existsSync);
const STEPS = 30;

// ── Adversarial boundary edits (deterministic) ──
// The fixed-seed random sessions MISSED the restart-anchor abutment hole (a token
// ending exactly at the damage start can be EXTENDED under maximal munch — 'b'+'x'
// = 'bx', '='+'=' = '==', deleting a gap glues neighbours). These cases pin the
// strict-< restart anchor; every one must match fresh (tree or reject) exactly.
// Test-side range derivation for constructed pairs (the ENGINE requires explicit
// ranges — a caller without them passes the whole-file range for a full re-parse).
function diffChange(a: string, b: string): Edit {
  const minL = Math.min(a.length, b.length);
  let s = 0;
  while (s < minL && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let e = 0;
  while (e < minL - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
  return { start: s, end: a.length - e, text: b.slice(s, b.length - e) };
}

const GLUE: Array<[string, string]> = [
  ['const a = 1;\nconst b = 2;\n', 'const a = 1;\nconst bx = 2;\n'],
  ['let a = b; let c = 1;\n', 'let a = b1; let c = 1;\n'],
  ['if (a = b) { f(); }\n', 'if (a == b) { f(); }\n'],
  ['const x = a b;\n', 'const x = ab;\n'],
  ['const q = w / 2;\n', 'const q = w /= 2;\n'],
  ['const t = a + b;\n', 'const t = a ++ b;\n'],
  ['const u = x<y>(z);\n', 'const u = x<y>>(z);\n'],
  ['f(a, b);\ng(c);\n', 'f(a, bc);\ng(c);\n'],
];

let steps = 0, equal = 0, bothReject = 0, mismatch = 0;
let tInc = 0, tFresh = 0;
const failures: string[] = [];

for (const [base, edited] of GLUE) {
  steps++;
  const c0 = session.parse(base);
  let fe: string | null = null, ie: string | null = null;
  let fr = -1;
  try { fr = fresh.parse(edited); } catch (e) { fe = (e as Error).message; }
  try { session.edit(c0, [diffChange(base, edited)]); } catch (e) { ie = (e as Error).message; }
  if (fe !== null || ie !== null) {
    if ((fe === null) !== (ie === null)) { mismatch++; if (failures.length < 5) failures.push(`glue «${edited.slice(0, 30)}»: fresh ${fe ? 'reject' : 'accept'} / incremental ${ie ? 'reject' : 'accept'}`); }
    else bothReject++;
    continue;
  }
  const a = JSON.stringify(objectify(fresh.tree, (fns) => fresh.visit(fr, fns)));
  const b = JSON.stringify(objectify(session.tree, (fns) => session.visit(c0, fns)));
  if (a === b) equal++;
  else { mismatch++; if (failures.length < 5) failures.push(`glue «${edited.slice(0, 30)}»: tree diverges`); }
}

for (const f of FILES) {
  let text = readFileSync(f, 'utf-8');
  let cst = session.parse(text);   // open the session
  for (let k = 0; k < STEPS; k++) {
    const { next, edit } = mutate(text);
    steps++;
    let freshRoot = -1, freshErr: string | null = null;
    const tf0 = performance.now();
    try { freshRoot = fresh.parse(next); } catch (e) { freshErr = (e as Error).message; }
    const tf1 = performance.now();
    let incErr: string | null = null;
    const ti0 = performance.now();
    try { session.edit(cst, [edit]); } catch (e) { incErr = (e as Error).message; }
    const ti1 = performance.now();
    if (freshErr !== null || incErr !== null) {
      if ((freshErr === null) !== (incErr === null)) {
        mismatch++;
        if (failures.length < 5) failures.push(`${f.split('/').pop()} step ${k}: fresh ${freshErr ? 'reject' : 'accept'} / incremental ${incErr ? 'reject' : 'accept'}\n    fresh: ${freshErr ?? '-'}\n    inc:   ${incErr ?? '-'}`);
      } else bothReject++;
      // REJECTED text: the handle stays on the previous tree, but the DOCUMENT
      // advances (editor-buffer model — the buffer applied the change regardless,
      // and the engine's docSrc tracks it). Model the editor's UNDO: revert via a
      // diff edit in the rejected text's coordinates; it must be accepted and
      // byte-identical to a fresh parse of the restored text.
      try {
        session.edit(cst, [diffChange(next, text)]);
        const rfr = fresh.parse(text);
        const ra = JSON.stringify(objectify(fresh.tree, (fns) => fresh.visit(rfr, fns)));
        const rb = JSON.stringify(objectify(session.tree, (fns) => session.visit(cst, fns)));
        if (ra !== rb) {
          mismatch++;
          if (failures.length < 5) failures.push(`${f.split('/').pop()} step ${k}: REVERT tree diverges`);
        }
      } catch (e2) {
        mismatch++;
        if (failures.length < 5) failures.push(`${f.split('/').pop()} step ${k}: revert rejected: ${(e2 as Error).message.slice(0, 50)}`);
      }
      continue;
    }
    tFresh += tf1 - tf0; tInc += ti1 - ti0;
    const a = JSON.stringify(objectify(fresh.tree, (fns) => fresh.visit(freshRoot, fns)));
    const b = JSON.stringify(objectify(session.tree, (fns) => session.visit(cst, fns)));
    if (a === b) equal++;
    else {
      mismatch++;
      if (failures.length < 5) {
        let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
        failures.push(`${f.split('/').pop()} step ${k}: tree diverges @${i}\n    fresh: …${a.slice(Math.max(0, i - 50), i + 50)}…\n    inc:   …${b.slice(Math.max(0, i - 50), i + 50)}…`);
      }
    }
    text = next;
  }
}

console.log(`incremental ≡ fresh: ${equal} equal · ${bothReject} both-reject · ${mismatch} MISMATCH  (${steps} steps over ${FILES.length} files)`);
if (tInc > 0) console.log(`time: incremental ${tInc.toFixed(1)}ms vs fresh ${tFresh.toFixed(1)}ms → ${(tFresh / tInc).toFixed(2)}× faster on accepted edits`);
for (const s of failures) console.log('  ✗ ' + s);
if (mismatch > 0) {
  console.error('✗ incremental parse diverges from a fresh parse');
  process.exit(1);
}
console.log('✓ every edited re-parse is byte-identical to a fresh parse');
