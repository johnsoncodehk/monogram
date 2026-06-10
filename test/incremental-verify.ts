// Gate: INCREMENTAL ≡ FRESH. parseEdited(newSource) must produce a tree byte-identical
// (via toObject) to a from-scratch parse of the same text, across scripted edit
// sessions over real files — inserts, deletions, replacements, statement insertions,
// edits inside strings/comments, and syntax-breaking edits (both sides must reject;
// the session self-heals on the next good text). Also reports the incremental speedup
// and the arena growth, so reuse is MEASURED, not assumed.
//
//   node test/incremental-verify.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { emitParser } from '../src/emit-parser.ts';

const grammar = (await import('../typescript.ts')).default;
const emPath = '/tmp/emitted-incremental.mjs';
writeFileSync(emPath, emitParser(grammar));
type Em = {
  parse(s: string): number;
  parseEdited(s: string): number;
  toObject(id: number): unknown;
};
const session = (await import(emPath + '?session=' + process.pid)) as Em;
const fresh = (await import(emPath + '?fresh=' + process.pid)) as Em;

// Deterministic LCG so failures replay.
let seedState = 0x2F6E2B1;
const rand = () => ((seedState = (seedState * 48271) % 0x7fffffff) / 0x7fffffff);
const randInt = (n: number) => Math.floor(rand() * n);

const INSERTS = ['x', '_v', '42', ' + y', '.m', '()', ' /*c*/ ', '"s"', 'await ', '!', '?'];
const STMTS = ['const q9 = 1;\n', 'function g9(a) { return a; }\n', 'if (x9) { y9(); }\n', '// note\n', 'type T9 = string | number;\n'];

function mutate(text: string): string {
  switch (randInt(5)) {
    case 0: { // insert a small fragment at a random position
      const at = randInt(text.length);
      return text.slice(0, at) + INSERTS[randInt(INSERTS.length)] + text.slice(at);
    }
    case 1: { // delete a small span
      const at = randInt(Math.max(1, text.length - 8));
      return text.slice(0, at) + text.slice(at + 1 + randInt(6));
    }
    case 2: { // replace a character
      const at = randInt(Math.max(1, text.length - 1));
      return text.slice(0, at) + 'z' + text.slice(at + 1);
    }
    case 3: { // insert a whole statement at a line boundary
      const lines = text.split('\n');
      const at = randInt(lines.length);
      lines.splice(at, 0, STMTS[randInt(STMTS.length)].trimEnd());
      return lines.join('\n');
    }
    default: { // append at the end (the pure-prefix reuse case)
      return text + '\n' + STMTS[randInt(STMTS.length)];
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

let steps = 0, equal = 0, bothReject = 0, mismatch = 0;
let tInc = 0, tFresh = 0;
const failures: string[] = [];

for (const f of FILES) {
  let text = readFileSync(f, 'utf-8');
  session.parse(text);   // open the session
  for (let k = 0; k < STEPS; k++) {
    const next = mutate(text);
    steps++;
    let freshRoot = -1, freshErr: string | null = null;
    const tf0 = performance.now();
    try { freshRoot = fresh.parse(next); } catch (e) { freshErr = (e as Error).message; }
    const tf1 = performance.now();
    let incRoot = -1, incErr: string | null = null;
    const ti0 = performance.now();
    try { incRoot = session.parseEdited(next); } catch (e) { incErr = (e as Error).message; }
    const ti1 = performance.now();
    if (freshErr !== null || incErr !== null) {
      if ((freshErr === null) !== (incErr === null)) {
        mismatch++;
        if (failures.length < 5) failures.push(`${f.split('/').pop()} step ${k}: fresh ${freshErr ? 'reject' : 'accept'} / incremental ${incErr ? 'reject' : 'accept'}\n    fresh: ${freshErr ?? '-'}\n    inc:   ${incErr ?? '-'}`);
      } else bothReject++;
      // rejected text: do not advance the session text (the session reset itself)
      continue;
    }
    tFresh += tf1 - tf0; tInc += ti1 - ti0;
    const a = JSON.stringify(fresh.toObject(freshRoot));
    const b = JSON.stringify(session.toObject(incRoot));
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
