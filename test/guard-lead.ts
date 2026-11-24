// Gate: A GUARD'S LEAD TESTS ARE THE TESTS IT TOOK OVER. Every portable target runs a longest-match
// candidate's leading one-token tests (`ahead` / `aheadCtx` steps) as its Guard's `lead` tests, on
// the token it has buffered at the candidate's start, before the candidate's frame, and runs only
// the steps after them inside the frame (emit-portable.ts Guard, leadOf). That is the same parse
// only if (1) the steps taken over are exactly the candidate's first `skip` steps, (2) each is a
// zero-width test of the token at the candidate's start alone — an `ahead` or `aheadCtx` step, not a
// shared step's call, not a `ctx` / `suppress` / `look` / `sameLine` step, nothing that consumes —
// and (3) the lead tests (adjacent negative tests merged into one set) accept exactly the tokens
// the steps accept, in every [Await] / [Yield] context (or fewer: a lead test may also refuse by the
// complement of the candidate's FIRST, which test/guard-refutation.ts proves). This checks all three for every candidate
// of every portable grammar: (3) over every pair of literal id and kind id of the lexer plan (a
// superset of the tokens a lexer can make) and every context, through the bit table every target
// prints (tokenSetBits).
//
//   node test/guard-lead.ts
import { readdirSync } from 'node:fs';
import { portableIR, buildLexIdPlan, tokenSetBits, ctxWordLids, guardedSteps, type ParserIR, type Guard, type Step } from '../src/emit-portable.ts';
import type { Grammar } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const paths = [
  ...readdirSync(`${ROOT}test/fixtures`).filter((f) => f.endsWith('.ts') && !f.startsWith('shape-')).map((f) => `${ROOT}test/fixtures/${f}`),
  ...['javascript', 'typescript', 'javascriptreact', 'typescriptreact'].map((g) => `${ROOT}${g}.ts`),
];

let failures = 0, sites = 0, grammars = 0, checks = 0;
const fail = (msg: string) => { failures++; if (failures <= 20) console.log(`  FAIL ${msg}`); };
for (const path of paths) {
  const grammar: Grammar = (await import(path)).default;
  if (!grammar || !Array.isArray(grammar.rules)) continue;
  let ir: ParserIR;
  try { ir = portableIR(grammar); } catch (e) {
    if (/out of scope|not in scope|portable:/.test((e as Error).message)) continue;
    throw e;
  }
  grammars++;
  const ids = buildLexIdPlan(ir);
  const bits = tokenSetBits(ids, ir.tokenSets);
  const inSet = (k: number, lid: number, kid: number): boolean => {
    const w = k >>> 5, m = 1 << (k & 31);
    return ((bits.words[lid * bits.width + w]! | bits.words[(bits.kidBase + kid) * bits.width + w]!) & m) !== 0;
  };
  const ctxLids = ctxWordLids(ir, ids);
  const ctxWord = (ctx: number, lid: number): boolean => ctxLids.some((w: { bit: number; lid: number }) => (ctx & w.bit) !== 0 && w.lid === lid);
  const stepOk = (s: Step, lid: number, kid: number, ctx: number): boolean =>
    s.t === 'ahead' ? inSet(s.set, lid, kid) === s.is
      : s.t === 'aheadCtx' ? (inSet(s.set, lid, kid) || ctxWord(ctx, lid)) === s.is
        : true;
  const check = (where: string, g: Guard, steps: Step[]) => {
    if (g === null || g.lead.length === 0) {
      if (g !== null && g.skip !== 0) fail(`${where}: steps taken over without lead tests`);
      return;
    }
    sites++;
    const taken = steps.slice(0, g.skip);
    // (1) and (2): the first `skip` steps, each a test of the start token alone.
    for (const s of taken) if ((s.t !== 'ahead' && s.t !== 'aheadCtx') || ('share' in s && s.share !== undefined)) fail(`${where}: took over a ${s.t} step`);
    if (guardedSteps(g, steps).length !== steps.length - g.skip) fail(`${where}: guardedSteps is not the steps after the lead`);
    // (3): the same tokens accepted, in every context.
    for (let ctx = 0; ctx < 4; ctx++) for (let lid = 0; lid < ids.lids.length; lid++) for (let kid = 0; kid < ids.kids.length; kid++) {
      checks++;
      const want = taken.every((s) => stepOk(s, lid, kid, ctx));
      const got = g.lead.every((l) => ((inSet(l.set, lid, kid) || (l.ctx && ctxWord(ctx, lid))) === l.is));
      // A lead test may refuse MORE than the steps it took over (a refusal by the complement of the
      // candidate's FIRST: test/guard-refutation.ts proves those); it must never admit what they refuse.
      if (got && !want) { fail(`${where}: token (lid ${JSON.stringify(ids.lids[lid])}, kind ${JSON.stringify(ids.kids[kid])}) in context ${ctx}: steps ${want}, lead ${got}`); return; }
    }
  };
  for (const r of ir.rules) {
    const name = `${path.slice(ROOT.length)} ${r.name}`;
    if (r.kind === 'rd') r.altGuard.forEach((g, i) => check(`${name} alt ${i}`, g, r.alts[i]!));
    else {
      r.nudSeqGuard.forEach((g, i) => check(`${name} nud seq ${i}`, g, r.nudSeqs[i]!));
      r.nudCappedGuard.forEach((g, i) => check(`${name} capped ${i}`, g, r.nudCapped[i]!.steps));
    }
  }
}
console.log(`guard-lead: ${grammars} grammars, ${sites} candidates with lead tests, ${checks} token × context checks, ${failures} failures`);
if (sites === 0) { console.log('  FAIL no candidate has lead tests: the gate checks nothing'); process.exit(1); }
process.exit(failures ? 1 : 0);
