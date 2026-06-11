// Gate: INCREMENTAL ≡ FRESH for EVERY GRAMMAR — the incremental/recovery gates
// were TypeScript-only while all grammars share the same emitted runtime, so the
// non-TS incremental behavior (markup lexer modes, the fallback-lexer path, other
// token algebras) was ungated. Grammar-agnostic by construction:
//
//   inputs come from the generative walker (grammar-gen), edit scripts are seeded
//   char-level mutations, and every step checks THREE things on the handle API:
//     1. edited tree + errors ≡ a fresh handle parse of the same text (byte-equal)
//     2. tree SELF-CONSISTENCY: every leaf span lies inside all its ancestors'
//        spans (the engine-internal invariant an external compare can miss when
//        both sides share a corruption)
//     3. totality: no step may throw
//
//   node test/incremental-grammars.ts
import { writeFileSync } from 'node:fs';
import { emitParser } from '../src/emit-parser.ts';
import { generateInputs } from './grammar-gen.ts';
import { objectify } from './emitted-obj.ts';

type Edit = { start: number; end: number; text: string };
type Diag = { offset: number; end: number; message: string };
type Cst = { root: number; errors: Diag[] };
type Parser = { parse(s: string): Cst; edit(cst: Cst, edits: Edit[]): void; visit(cst: Cst, fns: object): void; tree: import('./emitted-obj.ts').TreeView & { lenOf(id: number): number; leafOffsetOf(e: number, tb: number): number; leafEndOf(e: number, tb: number): number } };
type Em = { createParser(): Parser };

const GRAMMARS = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'yaml', 'html', 'vue'];

let seedState = 0x5EED1E55;
const rand = () => ((seedState = (seedState * 48271) % 0x7fffffff) / 0x7fffffff);
const randInt = (n: number) => Math.floor(rand() * n);
const INS = ['x', '1', ';', ' ', '"', '<', '>', '(', ')', '\n', '-', ':'];
function mutate(text: string): { next: string; edit: Edit } {
  if (text.length === 0) {
    const ins = INS[randInt(INS.length)];
    return { next: ins, edit: { start: 0, end: 0, text: ins } };
  }
  switch (randInt(3)) {
    case 0: {
      const at = randInt(text.length);
      const ins = INS[randInt(INS.length)];
      return { next: text.slice(0, at) + ins + text.slice(at), edit: { start: at, end: at, text: ins } };
    }
    case 1: {
      const at = randInt(Math.max(1, text.length - 4));
      const n = 1 + randInt(3);
      const end = Math.min(text.length, at + n);
      return { next: text.slice(0, at) + text.slice(end), edit: { start: at, end, text: '' } };
    }
    default: {
      const at = randInt(text.length);
      return { next: text.slice(0, at) + 'z' + text.slice(at + 1), edit: { start: at, end: at + 1, text: 'z' } };
    }
  }
}

function selfConsistent(p: Parser, c: Cst): string | null {
  const stack: [number, number][] = [];
  let bad: string | null = null;
  p.visit(c, {
    enter(id: number, cb: number) {
      const span: [number, number] = [cb, cb + p.tree.lenOf(id)];
      const top = stack[stack.length - 1];
      if (top !== undefined && (span[0] < top[0] || span[1] > top[1]) && bad === null) {
        bad = `node span [${span[0]},${span[1]}) outside parent [${top[0]},${top[1]})`;
      }
      stack.push(span);
    },
    leave() { stack.pop(); },
    leaf(e: number, tok: number) {
      if (bad !== null) return;
      const tb = tok - ((~e) >>> 2);
      const lo = p.tree.leafOffsetOf(e, tb), hi = p.tree.leafEndOf(e, tb);
      const top = stack[stack.length - 1];
      if (top !== undefined && (lo < top[0] || hi > top[1])) {
        bad = `leaf span [${lo},${hi}) outside parent [${top[0]},${top[1]})`;
      }
    },
  });
  return bad;
}

let totalSteps = 0, totalEqual = 0, totalErr = 0;
let fails = 0;
const failures: string[] = [];
for (const name of GRAMMARS) {
  const grammar = (await import(`../${name}.ts`)).default;
  const emPath = `/tmp/emitted-incr-${name}.mjs`;
  writeFileSync(emPath, emitParser(grammar));
  const em = (await import(emPath + '?v=' + process.pid)) as Em;
  const session = em.createParser();
  const fresh = em.createParser();

  // a handful of generated documents per grammar, a short edit session on each
  const inputs = generateInputs(grammar, { depth: 4, nestDepth: 4, cap: 5, fuzzRounds: 40, maxInputs: 24, seed: 11 });
  let docs = 0;
  for (const input of inputs) {
    if (input.text.length < 8) continue;
    if (docs >= 8) break;
    docs++;
    let text = input.text;
    let cst: Cst;
    try { cst = session.parse(text); } catch (e) {
      fails++; failures.push(`${name}: parse THREW on generated input: ${(e as Error).message.slice(0, 60)}`);
      continue;
    }
    for (let k = 0; k < 12; k++) {
      const { next, edit } = mutate(text);
      totalSteps++;
      if (process.env.TRACE && name === process.env.TRACE) console.log(`  [${name} doc${docs} step${k}]`, JSON.stringify(edit).slice(0, 70), '→', JSON.stringify(next.slice(0, 40)));
      let fc: Cst;
      try {
        session.edit(cst, [edit]);
        fc = fresh.parse(next);
      } catch (e) {
        fails++;
        if (failures.length < 10) failures.push(`${name} doc${docs} step${k}: THREW: ${(e as Error).message.slice(0, 80)}`);
        break;
      }
      if (fc.errors.length > 0) totalErr++;
      const a = JSON.stringify(objectify(fresh.tree, (fns) => fresh.visit(fc, fns))) + JSON.stringify(fc.errors);
      const b = JSON.stringify(objectify(session.tree, (fns) => session.visit(cst, fns))) + JSON.stringify(cst.errors);
      if (a !== b) {
        fails++;
        if (process.env.DUMP) {
          console.log('DOC:', JSON.stringify(text));
          console.log('NEXT:', JSON.stringify(next));
          console.log('FRESH errors:', JSON.stringify(fc.errors));
          console.log('INC errors:  ', JSON.stringify(cst.errors));
        }
        if (failures.length < 10) {
          let i = 0; while (i < a.length && a[i] === b[i]) i++;
          failures.push(`${name} doc${docs} step${k}: edit ≠ fresh @${i} edit=${JSON.stringify(edit).slice(0, 60)}\n      fresh: …${a.slice(Math.max(0, i - 40), i + 60)}…\n      inc:   …${b.slice(Math.max(0, i - 40), i + 60)}…`);
        }
        break;
      }
      const sc = selfConsistent(session, cst);
      if (sc !== null) {
        fails++;
        if (failures.length < 10) failures.push(`${name} doc${docs} step${k}: SELF-INCONSISTENT: ${sc}`);
        break;
      }
      totalEqual++;
      text = next;
    }
  }
}

console.log(`incremental-grammars: ${totalEqual}/${totalSteps} steps equal+consistent across ${GRAMMARS.length} grammars (${totalErr} recovered with errors)`);
for (const s of failures) console.log('  ✗ ' + s);
if (fails > 0) {
  console.error('✗ cross-grammar incremental equivalence violated');
  process.exit(1);
}
console.log('✓ every grammar: edited re-parses byte-identical to fresh, trees self-consistent, no throws');
