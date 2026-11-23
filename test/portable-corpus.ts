// Gate class of the portable targets (test/portable-harness.ts): the PARITY CORPUS
// (test/parity-corpus.ts — the generated inputs, their one-token mutants, the refused-operand
// matrix and the token edges; non-ASCII and line-terminator texts for the ECMAScript grammars;
// tsc's JSX conformance cases for the JSX ones). Every engine gives each input the oracle's verdict
// and, when it accepts, the oracle's rule skeleton; every lexer gives the oracle lexer's token
// stream (kind, text, newline-before; text rather than offsets, whose units differ by target), or
// fails on it as the oracle lexer does; literal ids are the table's; the Doc path ≡ a fresh parse.
import { buildLexIdPlan, elementTokens, portableIR } from '../src/emit-portable.ts';
import { canon, errText, finish, gate, parityCorpus, prepareAll, skeleton, unLid, type TokStream } from './portable-harness.ts';
import { CASES } from './portable-cases.ts';


// EXPECTED-FAIL on the parity corpus, still run and counted: inputs on which the portable
// parsers are known to disagree with the oracle, by cause. Each entry is owed as its own fix;
// when none of an entry's inputs disagrees any more the gate fails until the entry is removed.
// A disagreement on any input not listed here fails the gate.
// An entry names its inputs, or the oracle lexer error that selects them (`oracleLexError`),
// and the targets it holds for (all when absent).
type ExpectedFail = { grammars: string[]; reason: string; inputs?: string[]; oracleLexError?: RegExp; targets?: string[] };
const CORPUS_EXPECTED_FAIL: ExpectedFail[] = [
  {
    // Owed: the interpreter's Unicode identifier fallback (LX_UNI_IDENT, and the TS target's copy)
    // starts with [$_\p{ID_Start}], so an ASCII `$` the grammar's identifier pattern excludes is
    // an identifier there; Go and Rust enter the fallback only at a non-ASCII byte. Go / Rust
    // follow the identifier pattern; aligning the interpreter changes its lexing of every grammar
    // whose identifier pattern lacks `$` or `_` (envspec, html), which is the maintainer's call.
    grammars: ['envspec', 'envtpl'],
    reason: 'an ASCII `$` outside the identifier pattern is an identifier to the interpreter\'s Unicode fallback only',
    inputs: ['#\n$ x #\n$ x'],
    targets: ['go', 'rust'],
  },
];
let corpusMs = 0, corpusInputs = 0;

for (const p of await prepareAll()) {
  const { c, grammar, runners, oracleOut, tokenize } = p;
  // ── Parity corpus: every runner ≡ the oracle on verdict, and on the rule skeleton when both accept ──
  {
    const t0 = Date.now();
    const inputs = parityCorpus(p);
    const want = inputs.map((i) => oracleOut(i.src));
    const wantToks = inputs.map((i): TokStream => {
      try { return JSON.stringify(tokenize(i.src).map((t) => [t.type, t.text, (t as unknown as { newlineBefore: boolean }).newlineBefore])); } catch { return null; }
    });
    const known = CORPUS_EXPECTED_FAIL.filter((e) => e.grammars.includes(c.grammar));
    // The grammar's literal table: lids[i] is the text of literal id i (lids[0] = '', no literal).
    const lids = buildLexIdPlan(portableIR(grammar)).lids;
    const lidIndex = new Map(lids.map((t, i) => [t, i]));
    const lidOfText = (t: string) => lidIndex.get(t) ?? 0;
    const lexErr = inputs.map((i): string => { try { tokenize(i.src); return ''; } catch (e) { return errText(e); } });
    for (const r of runners) {
      const got = r.batch(inputs.map((i) => i.src));
      const gotToks = r.tokens(inputs.map((i) => i.src));
      const by = new Map<string, number>();
      const samples: string[] = [];
      const mine = known.map((e) => !e.targets || e.targets.includes(r.label));
      const knownHits = known.map(() => 0);
      let bad = 0;
      inputs.forEach((input, i) => {
        const w = want[i], g = got[i];
        let what = '';
        if (w.ok !== g.ok) what = `oracle ${w.ok ? 'accepts' : 'rejects'}, ${r.label} ${g.ok ? 'accepts' : 'rejects'}`;
        else if (w.ok && g.ok && canon(skeleton(w.cst)) !== canon(skeleton(g.cst))) what = 'both accept, rule skeletons differ';
        // A target that died in its lexer agrees with the oracle only when the oracle's
        // rejection is a lexer error too (its parser's own rejections all begin `Parse error`).
        else if (!w.ok && !g.ok && g.err !== undefined && g.err !== '' && r.label !== 'typescript' && (w.err ?? '').startsWith('Parse error')) what = `oracle rejects in its parser, ${r.label} failed before parsing (${g.err})`;
        else if (gotToks[i] !== 'NUL' && wantToks[i] !== unLid(gotToks[i]!)) what = wantToks[i] === null ? `oracle lexer fails, ${r.label} lexes` : gotToks[i] === null ? `oracle lexes, ${r.label} lexer fails` : 'token streams differ';
        if (!what) return;
        const k = known.findIndex((e, j) => mine[j] && (e.inputs ? e.inputs.includes(input.src) : e.oracleLexError!.test(lexErr[i])));
        if (k >= 0) { knownHits[k]++; return; }
        bad++;
        const key = `${input.kind}: ${what}`;
        by.set(key, (by.get(key) ?? 0) + 1);
        if (samples.length < 12) samples.push(`${key} — ${JSON.stringify(input.src.length > 100 ? input.src.slice(0, 100) + '…' : input.src)}`);
      });
      console.log(`  ${c.grammar}/${r.label}: corpus ${inputs.length - bad}/${inputs.length} ≡ oracle (verdict + rule skeleton + token stream)`);
      known.forEach((e, k) => {
        if (!mine[k]) return;
        console.log(`      expected-fail: ${knownHits[k]} inputs disagree${e.inputs ? ` (of ${e.inputs.length} listed)` : ''} — ${e.reason}`);
        if (knownHits[k] === 0) { gate.failures++; console.log(`  ${c.grammar}/${r.label}: no listed input disagrees any more: remove this CORPUS_EXPECTED_FAIL entry (${e.reason})`); }
      });
      for (const [key, n] of by) console.log(`      ${String(n).padStart(5)}  ${key}`);
      for (const smp of samples) console.log(`      ${smp}`);
      gate.failures += bad;

      // One literal id per text: the id the lexer gives a token, and the one lid_of gives the
      // same text when a Doc rebuilds that token from its metadata, are both the text's index in
      // the grammar's literal table (0: no literal) — for every token of the corpus and for
      // every literal of the table. A token of an element region's own (text, raw text, tag
      // tokens, close / self-close) carries 0 whatever its text: it is never a literal.
      const regionTok = new Set(elementTokens(portableIR(grammar).elements));
      const lidBad: string[] = [];
      const texts = new Set<string>(lids.slice(1));
      inputs.forEach((input, i) => {
        if (gotToks[i] === null || gotToks[i] === 'NUL') return;
        for (const [kind, text, , lid] of JSON.parse(gotToks[i]!) as [string, string, boolean, number][]) {
          texts.add(text);
          const want = regionTok.has(kind) ? 0 : lidOfText(text);
          if (lid !== want) lidBad.push(`lexer gives ${kind} ${JSON.stringify(text)} lid ${lid}, its id ${want} — in ${JSON.stringify(input.src.slice(0, 80))}`);
        }
      });
      const textList = [...texts].filter((t) => !t.includes('\0'));
      r.lidOf(textList).forEach((got, j) => { if (got !== lidOfText(textList[j]!)) lidBad.push(`lid_of(${JSON.stringify(textList[j])}) = ${got}, the table ${lidOfText(textList[j]!)}`); });
      console.log(`  ${c.grammar}/${r.label}: literal ids ${lidBad.length ? `${lidBad.length} MISMATCH` : `≡ the table`} (the lexer's on every corpus token, lid_of's on ${textList.length} texts: every token text and every literal)`);
      for (const smp of [...new Set(lidBad)].slice(0, 8)) console.log(`      ${smp}`);
      gate.failures += lidBad.length;

      // The Doc path ≡ a fresh parse: the verdict, and the CST when both accept.
      const srcs = inputs.map((i) => i.src);
      const docs = r.doc(srcs), builders = r.docBuilder?.(srcs);
      const docBad: string[] = [];
      inputs.forEach((input, i) => {
        const f = got[i]!, d = docs[i]!;
        if (d.ok === false && d.err === 'NUL') return;
        const at = JSON.stringify(input.src.length > 100 ? input.src.slice(0, 100) + '…' : input.src);
        if (f.ok !== d.ok) docBad.push(`fresh parse ${f.ok ? 'accepts' : 'rejects'}, Doc ${d.ok ? 'accepts' : 'rejects'} — ${at}`);
        else if (f.ok && d.ok && f.cst !== d.cst) docBad.push(`both accept, CSTs differ — ${at}`);
        const b = builders?.[i];
        if (b !== undefined && b !== null && b !== f.ok) docBad.push(`fresh parse ${f.ok ? 'accepts' : 'rejects'}, builder Doc ${b ? 'accepts' : 'rejects'} — ${at}`);
      });
      console.log(`  ${c.grammar}/${r.label}: Doc ${docBad.length ? `${docBad.length} MISMATCH` : '≡ fresh parse'} (each input typed into an empty ${builders ? 'CST and builder Doc' : 'Doc'}: verdict${builders ? 's' : ''} + CST)`);
      for (const smp of docBad.slice(0, 8)) console.log(`      ${smp}`);
      gate.failures += docBad.length;
    }
    corpusMs += Date.now() - t0;
    corpusInputs += inputs.length;
  }
}
console.log(`  parity corpus: ${corpusInputs} inputs over ${CASES.length} grammars, ${(corpusMs / 1000).toFixed(1)}s`);

finish('the parity corpus (verdict, rule skeleton, token stream, literal ids, Doc)');
