// Gate class of the portable targets (test/portable-harness.ts): TOTAL PARSING.
import type { CstGrammar } from '../src/types.ts';
import { mutationCorpus } from './mutation-corpus.ts';
import { CURATED_TS } from './emit-corpus.ts';
import { ECMASCRIPT, finish, gate, parityCorpus, prepareAll, selectedCases, primaryLexMsg, type Case, type DiagRow, type Outcome, type Runner, type Total } from './portable-harness.ts';
import type { Tok } from './parity-corpus.ts';


// ── The recovery class: total parsing, `parseTotal` (the emit option `recovery`) ──
// On the parity corpus, the hand-written lists and a seeded MUTATION corpus (test/mutation-corpus.ts:
// each accepted list input with one token deleted, inserted or replaced), for every runner:
//   - the verdict is the oracle's, and errors are empty exactly when it accepts (and, in the TS
//     target, the root is parse()'s CST byte for byte);
//   - a reject gives one diagnostic (no recovery yet): a lexer error's message is the oracle
//     lexer's, and a parser reject's primary error is the interpreter's message without its
//     farthest hint (`Parse error at offset O: ` + message), exactly;
//   - the related location (the farthest token the parse examined) is COUNTED against the
//     interpreter's farthest hint, not pinned: the interpreter counts only tokens a match advanced
//     past, the engine also those a guard read (recovery-family.ts);
//   - Go and Rust give the TS target's diagnostics, their byte offsets mapped to UTF-16 units over
//     the input itself, so non-ASCII inputs compare exactly too (a lexer message, whose text holds
//     a byte offset, is compared on ASCII inputs only);
//   - the TS target gives the same outcome twice.
const RECOVERY_MUTANTS = 3, RECOVERY_SEED = 20261123;
// The farthest-hint agreement is a floor per grammar (the count of rejects whose related location
// is the interpreter's farthest token): it may rise, never drop below what is recorded here.
// javascript 5441 -> 5439 (land/shape-ident-reserved): `undefined` is no grammar literal any more, so the
// mutation corpus (which substitutes grammar literals) holds other inputs (`with  undefined ) { }` mutants
// become others): the disagreements fall 186 -> 182, the agreements 5,441 -> 5,439 (of 5,621 rejects now).
const RECOVERY_FARTHEST_FLOOR: Record<string, number> = { javascript: 5439, typescript: 5946 };
// EXPECTED-FAIL, still run and counted: mutants on which the portable parsers' verdict (parse and
// parseTotal alike) is not the oracle's. Not total parsing's property (parseTotal's verdict is its
// own parse()'s, checked below); found by the mutation corpus, each owed as its own fix. When one
// agrees again the gate fails until it is removed.
const RECOVERY_VERDICT_EXPECTED_FAIL: Record<string, string[]> = {
  // The interpreter accepts the reserved word `if` as a type (a TypeReference), the portable
  // parsers refuse it: `T extends number ? if : "o"`.
  typescript: ['type Cond<T> = T extends string ? "s" : T extends number ? if : "o";'],
};
const FARTHEST_HINT = / \[farthest: offset (\d+) near [\s\S]*\]$/;
// The UTF-16 offset of each UTF-8 byte offset of src that starts a character.
function utf16Of(src: string): (b: number) => number {
  const at = new Map<number, number>();
  let b = 0, u = 0;
  for (const ch of src) { at.set(b, u); b += Buffer.byteLength(ch); u += ch.length; }
  at.set(b, u);
  return (x) => { const y = at.get(x); if (y === undefined) throw new Error(`byte offset ${x} splits a character`); return y; };
}
function recoveryClass(c: Case, grammar: CstGrammar, runners: Runner[], oracleOut: (src: string) => Outcome, base: string[], tokenize: (s: string) => Tok[]): void {
  const mutants = mutationCorpus(grammar, (s) => tokenize(s).map((t) => ({ offset: t.offset, text: t.text })), [...c.accept, ...(c.grammar === 'typescript' ? CURATED_TS : [])], RECOVERY_MUTANTS, RECOVERY_SEED);
  const srcs = [...new Set([...base, ...mutants])].filter((s) => !s.includes('\0'));
  const want = srcs.map((s) => oracleOut(s));
  const ascii = srcs.map((s) => /^[\x00-\x7f]*$/.test(s));
  let ref: Total[] | null = null;
  for (const r of runners) {
    const raw = r.total(srcs);
    const own = r.batch(srcs);
    const known = RECOVERY_VERDICT_EXPECTED_FAIL[c.grammar] ?? [];
    let knownHits = 0;
    const got = r.utf8Edits ? raw.map((t, i): Total => {
      const u = utf16Of(srcs[i]!);
      return { ...t, errors: t.errors.map(([o, e, m, ro, re, rm]): DiagRow => [u(o), u(e), m, ro < 0 ? ro : u(ro), re < 0 ? re : u(re), rm]) };
    }) : raw;
    const bad: string[] = [];
    let acc = 0, rej = 0, primary = 0, lexEq = 0, farEq = 0, farN = 0;
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
        if (g.errors.length) bad.push(`accepted with ${g.errors.length} error(s) — ${at(i)}`);
        else acc++;
        if (g.cst !== undefined) {
          const p = r.run(srcs[i]!);
          if (!p.ok || p.cst !== g.cst) bad.push(`parseTotal's root is not parse()'s — ${at(i)}`);
        }
        return;
      }
      rej++;
      if (g.errors.length !== 1) { bad.push(`a reject gave ${g.errors.length} diagnostics, not 1 — ${at(i)}`); return; }
      const [off, , msg, relOff] = g.errors[0]!;
      const werr = w.err ?? '';
      if (werr.startsWith('Parse error')) {
        const mine = `Parse error at offset ${off}: ${msg}`;
        if (mine !== werr.replace(FARTHEST_HINT, '')) bad.push(`primary error ${JSON.stringify(mine)}, the interpreter's ${JSON.stringify(werr)} — ${at(i)}`);
        else primary++;
        const far = FARTHEST_HINT.exec(werr);
        farN++;
        if ((far ? Number(far[1]) : -1) === relOff) farEq++;
      } else if (!r.utf8Edits || ascii[i]) {
        if (primaryLexMsg(werr) !== primaryLexMsg(msg)) bad.push(`lexer error ${JSON.stringify(msg)}, the oracle's ${JSON.stringify(werr)} — ${at(i)}`);
        else lexEq++;
      } else lexEq++;
    });
    if (r.label === 'typescript') {
      const again = r.total(srcs);
      got.forEach((g, i) => { if (JSON.stringify(g) !== JSON.stringify(again[i])) bad.push(`a second parseTotal differs — ${at(i)}`); });
      ref = got;
    } else if (ref !== null) {
      got.forEach((g, i) => {
        const t = ref![i]!;
        const lexNonAscii = !ascii[i] && !(want[i]!.err ?? '').startsWith('Parse error');
        const rows = (x: Total) => JSON.stringify(lexNonAscii ? x.errors.map((e) => [e[0], e[1]]) : x.errors);
        if (g.ok !== t.ok || rows(g) !== rows(t)) bad.push(`diagnostics differ from the TS target's: ${JSON.stringify(g.errors)} vs ${JSON.stringify(t.errors)} — ${at(i)}`);
      });
    }
    if (knownHits !== known.length) bad.push(`expected-fail: ${knownHits} of ${known.length} listed verdict divergences remain: remove the ones that agree now`);
    if (farEq < (RECOVERY_FARTHEST_FLOOR[c.grammar] ?? 0)) bad.push(`farthest agreement ${farEq} dropped below its recorded floor ${RECOVERY_FARTHEST_FLOOR[c.grammar]}`);
    console.log(`  ${c.grammar}/${r.label}: recovery ${bad.length ? `${bad.length} MISMATCH` : 'ok'} over ${srcs.length} inputs (${mutants.length} mutants): ${acc} accepted with no errors, ${rej} rejected: primary ≡ interpreter ${primary}, lexer ≡ oracle ${lexEq}; farthest ≡ the interpreter's hint on ${farEq}/${farN} (counted)`);
    for (const smp of bad.slice(0, 10)) console.log(`      ${smp}`);
    gate.failures += bad.length;
  }
}

for (const p of await prepareAll(selectedCases().filter((c) => ECMASCRIPT.has(c.grammar)))) {
  if (!ECMASCRIPT.has(p.c.grammar)) continue;
  const { c, grammar, runners, oracleOut, tokenize } = p;
  recoveryClass(c, grammar, runners, oracleOut, [...parityCorpus(p).map((i) => i.src), ...c.accept, ...c.reject, ...(c.grammar === 'typescript' ? CURATED_TS : [])], tokenize);
}

finish('total parsing (parseTotal) on the corpus, the lists and the mutation corpus');
