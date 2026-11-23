// Gate class of the portable targets (test/portable-harness.ts): TOTAL PARSING.
import type { CstGrammar } from '../src/types.ts';
import { mutationCorpus } from './mutation-corpus.ts';
import { CURATED_TS } from './emit-corpus.ts';
import { ECMASCRIPT, canon, finish, gate, parityCorpus, prepareAll, selectedCases, primaryLexMsg, type Case, type DiagRow, type Outcome, type Runner, type Total } from './portable-harness.ts';
import { checkContract, summarize, type ContractRow } from './recovery-contract.ts';
import { RM_MAX_BARS } from '../src/recovery-family.ts';
import type { Tok } from './parity-corpus.ts';
import { portableIR, type PortableFacts } from '../src/emit-portable.ts';
import { FACTS as TS_FACTS } from '../src/target-ts.ts';
import { FACTS as GO_FACTS } from '../src/target-go.ts';
import { FACTS as RS_FACTS } from '../src/target-rust.ts';


// ── The recovery class: total parsing, `parseTotal` (the emit option `recovery`) ──
// On the parity corpus, the hand-written lists and a seeded MUTATION corpus (test/mutation-corpus.ts:
// each accepted list input with one token deleted, inserted or replaced), for every runner:
//   - the verdict (a tree and no diagnostic) is the oracle's and parse()'s, and an accepted text's
//     root is parse()'s CST byte for byte (P2, P3);
//   - a lexer error gives no tree and one diagnostic, the oracle lexer's message (a message, whose
//     text holds a byte offset, is compared on ASCII inputs only in Go and Rust);
//   - a parser reject gives a tree (P1) that keeps the contract (test/recovery-contract.ts: P4
//     lossless, P5 one diagnostic per repair node, P10 repair validity where it is checkable: GATED
//     for repairs that are only `$missing`, COUNTED for repairs with an `$error`: blanking a skipped
//     span changes what a lookahead or an automatic semicolon of the entry before it saw);
//   - termination: the interpreted steps of a recovery are at most TOTAL_K × attempts × (tokens + 1)
//     × rules, and no scope takes more than RM_MAX_BARS + 1 attempts (riAttempts: one strict, one
//     per bar), so an input takes at most (RM_MAX_BARS + 1) × (2 × scopes + 1) — scopes: its
//     repairs + 1 (each scope that is not the first ends in a repair, or a look-back);
//   - Go and Rust give the TS target's tree and diagnostics (P6), their byte offsets mapped to
//     UTF-16 units over the input itself; the TS target gives the same outcome twice.
// The measurements the coordinator asked for (fallback share, `$error` spans, attempts, the steps
// of a recovery against a strict interpretation of the same input, P10's checkable share) are
// printed for the TS target.
const RECOVERY_MUTANTS = 3, RECOVERY_SEED = 20261123;
const TOTAL_K = 3;
// EXPECTED-FAIL, still run and counted: mutants on which the portable parsers' verdict (parse and
// parseTotal alike) is not the oracle's. Not total parsing's property (parseTotal's verdict is its
// own parse()'s, checked below); found by the mutation corpus, each owed as its own fix. When one
// agrees again the gate fails until it is removed.
const RECOVERY_VERDICT_EXPECTED_FAIL: Record<string, string[]> = {};
// The UTF-16 offset of each UTF-8 byte offset of src that starts a character.
function utf16Of(src: string): (b: number) => number {
  const at = new Map<number, number>();
  let b = 0, u = 0;
  for (const ch of src) { at.set(b, u); b += Buffer.byteLength(ch); u += ch.length; }
  at.set(b, u);
  return (x) => { const y = at.get(x); if (y === undefined) throw new Error(`byte offset ${x} splits a character`); return y; };
}
// A CST JSON's offsets mapped by u.
const mapTree = (x: unknown, u: (b: number) => number): unknown => {
  if (Array.isArray(x)) return x.map((y) => mapTree(y, u));
  if (x === null || typeof x !== 'object') return x;
  return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, k === 'offset' || k === 'end' ? u(y as number) : mapTree(y, u)]));
};
function recoveryClass(c: Case, grammar: CstGrammar, runners: Runner[], oracleOut: (src: string) => Outcome, base: string[], tokenize: (s: string) => Tok[]): void {
  const mutants = mutationCorpus(grammar, (s) => tokenize(s).map((t) => ({ offset: t.offset, text: t.text })), [...c.accept, ...(c.grammar === 'typescript' ? CURATED_TS : [])], RECOVERY_MUTANTS, RECOVERY_SEED);
  const srcs = [...new Set([...base, ...mutants])].filter((s) => !s.includes('\0'));
  const want = srcs.map((s) => oracleOut(s));
  const ascii = srcs.map((s) => /^[\x00-\x7f]*$/.test(s));
  const nRules = portableIR(grammar).rules.length;
  const lex = runners.find((r) => r.lexToks)!.lexToks!;
  // A sample token of each kind that is no literal, for P10's `expected <Kind>` repairs.
  const samples = new Map<string, string>();
  for (const a of c.accept) for (const t of lex(a) ?? []) if (t.kind !== '' && t.lid === 0 && !samples.has(t.kind)) samples.set(t.kind, t.text);
  const mutantSet = new Set(mutants);
  let ref: Total[] | null = null;
  for (const r of runners) {
    const raw = r.total(srcs);
    const own = r.batch(srcs);
    const known = RECOVERY_VERDICT_EXPECTED_FAIL[c.grammar] ?? [];
    let knownHits = 0;
    const got = r.utf8Edits ? raw.map((t, i): Total => {
      const u = utf16Of(srcs[i]!);
      return { ...t, cst: t.cst === undefined ? undefined : canon(mapTree(JSON.parse(t.cst), u)), errors: t.errors.map(([o, e, m, ro, re, rm]): DiagRow => [u(o), u(e), m, ro < 0 ? ro : u(ro), re < 0 ? re : u(re), rm]) };
    }) : raw;
    const bad: string[] = [];
    let acc = 0, rec = 0, lexEq = 0, maxK = 0, maxAtt = 0;
    const rows: (ContractRow | null)[] = [];
    const at = (i: number) => JSON.stringify(srcs[i]!.length > 90 ? srcs[i]!.slice(0, 90) + '…' : srcs[i]);
    got.forEach((g, i) => {
      const w = want[i]!;
      if ((w.err ?? '').includes('Maximum call stack')) return;
      if (g.ok !== own[i]!.ok) { bad.push(`parse ${own[i]!.ok ? 'accepts' : 'rejects'}, parseTotal ${g.ok ? 'accepts' : 'rejects'} — ${at(i)}`); return; }
      if (g.ok !== w.ok) {
        if (known.includes(srcs[i]!)) { knownHits++; return; }
        bad.push(`oracle ${w.ok ? 'accepts' : 'rejects'}, parseTotal ${g.ok ? 'accepts' : 'rejects'} — ${at(i)}`); return;
      }
      if (w.ok) {
        acc++;
        if (g.cst !== undefined && r.lexToks) {
          const p = r.run(srcs[i]!);
          if (!p.ok || p.cst !== g.cst) bad.push(`parseTotal's root is not parse()'s — ${at(i)}`);
        }
        return;
      }
      const werr = w.err ?? '';
      if (!werr.startsWith('Parse error')) {
        if (g.root || g.errors.length !== 1) { bad.push(`a lexer error gave ${g.root ? 'a tree and ' : ''}${g.errors.length} diagnostics — ${at(i)}`); return; }
        if (!r.utf8Edits || ascii[i]) {
          if (primaryLexMsg(werr) !== primaryLexMsg(g.errors[0]![2])) bad.push(`lexer error ${JSON.stringify(g.errors[0]![2])}, the oracle's ${JSON.stringify(werr)} — ${at(i)}`);
          else lexEq++;
        } else lexEq++;
        return;
      }
      rec++;
      if (!g.root || g.cst === undefined) { bad.push(`P1: a reject gave no tree — ${at(i)}`); return; }
      let nTok = 0;
      try { nTok = tokenize(srcs[i]!).length; } catch { /* counted as no token */ }
      const bound = g.attempts * (nTok + 1) * nRules;
      maxK = Math.max(maxK, g.steps / Math.max(1, bound));
      if (g.steps > TOTAL_K * bound) bad.push(`recovery: ${g.steps} steps, over the bound ${TOTAL_K} × ${g.attempts} attempts × (tokens + 1) × ${nRules} rules — ${at(i)}`);
      maxAtt = Math.max(maxAtt, g.attempts);
      if (g.attempts > (RM_MAX_BARS + 1) * (2 * (g.errors.length + 1) + 1)) bad.push(`recovery: ${g.attempts} attempts for ${g.errors.length} repairs — ${at(i)}`);
      if (r.lexToks) {
        const toks = r.lexToks(srcs[i]!)!;
        const strict = r.interp([srcs[i]!], 1 << 30)[0]!.steps;
        const row = checkContract(srcs[i]!, toks, JSON.parse(g.cst), g.errors.map((e) => [e[0], e[1], e[2]]), g.steps, g.attempts, strict, samples,
          (s) => oracleOut(s).ok, bad, (k) => k === 'missing-only');
        if (mutantSet.has(srcs[i]!)) rows.push(row);
      }
    });
    if (r.lexToks) {
      const again = r.total(srcs);
      got.forEach((g, i) => { if (JSON.stringify(g) !== JSON.stringify(again[i])) bad.push(`a second parseTotal differs — ${at(i)}`); });
      ref = got;
    } else if (ref !== null) {
      got.forEach((g, i) => {
        const t = ref![i]!;
        const lexNonAscii = !ascii[i] && !(want[i]!.err ?? '').startsWith('Parse error');
        const rows = (x: Total) => JSON.stringify(lexNonAscii ? x.errors.map((e) => [e[0], e[1]]) : x.errors);
        if (g.ok !== t.ok || rows(g) !== rows(t) || g.cst !== t.cst || g.steps !== t.steps && JSON.stringify(FACTS_OF[r.label]) === JSON.stringify(FACTS_OF.typescript)) bad.push(`P6: tree or diagnostics differ from the TS target's: ${JSON.stringify(g.errors)} vs ${JSON.stringify(t.errors)} — ${at(i)}`);
      });
    }
    interpCheck(c, grammar, r, srcs, own, tokenize, bad);
    if (knownHits !== known.length) bad.push(`expected-fail: ${knownHits} of ${known.length} listed verdict divergences remain: remove the ones that agree now`);
    console.log(`  ${c.grammar}/${r.label}: recovery ${bad.length ? `${bad.length} MISMATCH` : 'ok'} over ${srcs.length} inputs (${mutants.length} mutants): ${acc} accepted with no errors, ${rec} rejected and recovered (lexer ≡ oracle ${lexEq}); steps ≤ ${maxK.toFixed(3)} × attempts × (tokens + 1) × rules; attempts ≤ ${maxAtt}`);
    if (r.lexToks) console.log(summarize(`  ${c.grammar}/${r.label} on the mutants`, rows).split('\n').map((l, j) => (j ? `    ${l}` : l)).join('\n'));
    for (const smp of bad.slice(0, 10)) console.log(`      ${smp}`);
    gate.failures += bad.length;
  }
}

// ── The strict interpreter (recovery-family.ts, stage 2) ≡ the native parse ──
// FORCED: every rule level interpreted (INTERP_ALL), so the equality is not that of the native
// functions with themselves, and at INTERP_MIXED levels, where interpreted frames call native ones
// and native ones nothing interpreted. On every input of the recovery class (valid and rejected):
// the same verdict and the same tree; in the TS target the same leaves offered to the builder (the
// candidates tried are the native ones: the interpreter takes them in declaration order where
// their guards admit the token; the nodes a longest match finishes depend on that order, so they
// are reported, not compared). The targets interpret alike: two targets whose parse plans are one
// (the same PortableFacts, so the same table) take the same step count on every input (a plan with
// more guards takes fewer steps). Termination (recovery-1/DESIGN.md): the steps of a run are at most
// INTERP_K × (tokens + 1) × rules, with k recorded here from the measurement.
const INTERP_ALL = 1 << 30, INTERP_MIXED = 2;
const INTERP_K = 3;
const interpRef = new Map<string, number[]>();
const FACTS_OF: Record<string, PortableFacts> = { typescript: TS_FACTS, go: GO_FACTS, rust: RS_FACTS };
function interpCheck(c: Case, grammar: CstGrammar, r: Runner, srcs: string[], own: Outcome[], tokenize: (s: string) => Tok[], bad: string[]): void {
  const at = (i: number) => JSON.stringify(srcs[i]!.length > 90 ? srcs[i]!.slice(0, 90) + '…' : srcs[i]);
  const nRules = portableIR(grammar).rules.length;
  for (const depth of [INTERP_ALL, INTERP_MIXED]) {
    const got = r.interp(srcs, depth);
    const key = `${c.grammar}/${depth}/${JSON.stringify(FACTS_OF[r.label])}`;
    const ref = interpRef.get(key);
    if (!ref) interpRef.set(key, got.map((g) => g.steps));
    let ok = 0, rej = 0, leafEq = 0, maxK = 0;
    got.forEach((g, i) => {
      const o = own[i]!;
      if (g.ok !== o.ok) { bad.push(`interpreter (depth ${depth}) ${g.ok ? 'accepts' : 'rejects'}, the native parse ${o.ok ? 'accepts' : 'rejects'} — ${at(i)}`); return; }
      if (g.ok && g.cst !== o.cst) { bad.push(`interpreter (depth ${depth}): a tree other than the native parse's — ${at(i)}`); return; }
      if (g.ok) ok++; else rej++;
      if (g.leaves) { if (g.leaves[0] === g.leaves[1]) leafEq++; else bad.push(`interpreter (depth ${depth}): ${g.leaves[1]} leaves offered, the native parse ${g.leaves[0]} — ${at(i)}`); }
      if (ref && ref[i] !== g.steps) bad.push(`interpreter (depth ${depth}): ${g.steps} steps, a target of the same plan ${ref[i]} — ${at(i)}`);
      let nTok = 0;
      try { nTok = tokenize(srcs[i]!).length; } catch { /* a lexer error: the interpreter takes no step */ }
      const bound = (nTok + 1) * nRules;
      maxK = Math.max(maxK, g.steps / bound);
      if (g.steps > INTERP_K * bound) bad.push(`interpreter (depth ${depth}): ${g.steps} steps, over the bound ${INTERP_K} × (tokens + 1) × ${nRules} rules — ${at(i)}`);
    });
    console.log(`  ${c.grammar}/${r.label}: interpreter ${depth === INTERP_ALL ? 'forced (every level)' : `${depth} levels`} ≡ native: ${ok} accepted, ${rej} rejected${r.label === 'typescript' ? `, leaves equal on ${leafEq}` : (ref ? ', steps ≡ the target of the same plan' : ', the first of its plan')}; steps ≤ ${maxK.toFixed(3)} × (tokens + 1) × rules`);
  }
}

for (const p of await prepareAll(selectedCases().filter((c) => ECMASCRIPT.has(c.grammar)))) {
  if (!ECMASCRIPT.has(p.c.grammar)) continue;
  const { c, grammar, runners, oracleOut, tokenize } = p;
  recoveryClass(c, grammar, runners, oracleOut, [...parityCorpus(p).map((i) => i.src), ...c.accept, ...c.reject, ...(c.grammar === 'typescript' ? CURATED_TS : [])], tokenize);
}

finish('total parsing (parseTotal) on the corpus, the lists and the mutation corpus');
