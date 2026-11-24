// Gate class of the portable targets (test/portable-harness.ts): TOTAL PARSING.
import type { CstGrammar } from '../src/types.ts';
import { mutationEdits, type Mutant } from './mutation-corpus.ts';
import { CURATED_TS } from './emit-corpus.ts';
import { ECMASCRIPT, canon, finish, gate, parityCorpus, prepareAll, selectedCases, primaryLexMsg, type Case, type DiagRow, type Outcome, type Runner, type Total } from './portable-harness.ts';
import { checkContract, damage, summarize, withOperandSamples, type ContractRow } from './recovery-contract.ts';
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
//     × rules, and no scope (one top-level entry, a look-back over two, or the whole input) takes
//     more than RM_MAX_BARS + 1 attempts (riAttempts: one strict, one per bar); the attempts of an
//     input are the sum over its scopes;
//   - the strict error (`strict`: where the strict parse stopped, stage 1) is the interpreter's
//     primary error without its farthest hint, exactly (P7); its related location (the farthest
//     token the parse examined) is COUNTED against the hint, not pinned: the interpreter counts only
//     tokens a match advanced past, the engine also those a guard read (recovery-family.ts);
//   - the FIRST repair's offset is compared with the strict error's: equal / earlier / later,
//     counted (a repair is placed where the fix goes: a missing ')' before the '{' the strict parse
//     stopped at is equal; a look-back repair inside the entry before is earlier);
//   - Go and Rust give the TS target's tree and diagnostics (P6), their byte offsets mapped to
//     UTF-16 units over the input itself; the TS target gives the same outcome twice.
// The measurements the coordinator asked for (fallback share, `$error` spans, attempts, the steps
// of a recovery against a strict interpretation of the same input, P10's checkable share, each
// mutant's DAMAGE and STABILITY against its original: recovery-contract.ts damage) are printed for
// the TS target; docs/TARGETS.md records them. Not gated: the seeded mutants are redrawn whenever a
// grammar literal or an accept row changes, so a floor would be re-measured on every such change.
const RECOVERY_MUTANTS = 3, RECOVERY_SEED = 20261123;
// 3 -> 4 (the NUD, list and choice repairs): measured max 3.07 (typescript, `export @aa  true`: a
// short input, where the attempts' fixed work dominates); javascript 1.11.
const TOTAL_K = 4;
// The farthest-hint agreement is a floor per grammar (the count of rejects whose related location
// is the interpreter's farthest token): it may rise, never drop below what is recorded here.
// The mutants are drawn from the accept lists (seeded), so a list entry added or removed draws
// another set: the floor is re-measured then (typescript 5946 → 5925 when the cap-propagation accepts
// came; the same run without them gives 5951; 5950 with the re-bind's accepts).
// javascript 5441 -> 5439 (land/shape-ident-reserved): `undefined` is no grammar literal any more, so the
// mutation corpus (which substitutes grammar literals) holds other inputs (`with  undefined ) { }` mutants
// become others): the disagreements fall 186 -> 182, the agreements 5,441 -> 5,439 (of 5,621 rejects now).
// typescript 5950 -> 5946 (land/sound-cap-tail): the cap-through-a-trailing-operand accepts
// (`a ? b : () => {};`, `[...() => {}];`, …) draw another mutant set: 5,946 of 6,842 rejects agree.
// javascript 5439 -> 5412 (land/shape-test262-valid): the literals `defer` and `source` join the grammar,
// and the mutation corpus picks literals from the sorted list by a seeded index, so it is another
// population (javascript: 5,412 of 5,901 rejects agree; typescript's rises 5946 -> 5994). Most of javascript's new
// disagreements are one pattern, `import` and a token neither `(` nor `.` (`import ?. ;`): the
// interpreter's farthest is `import` itself (no hint), the engine's the token its form guard read. The
// interpreter's message on these inputs is master's. Re-measured on master 6cf16d04 (land/recovery-stage3)
// merged in: javascript 5,412 of 5,902 rejects agree, typescript 6,051 of 6,868.
// javascript 5412 -> 5349, typescript 6051 -> 6388 (land/grammar-decorators-2, on master 3587831d): `@`
// joins the grammar's literals and typescript's decorator list gains accepts, so both mutant sets are
// drawn again: javascript 5,349 of 5,850 rejects agree (91.4%, was 91.7%), typescript 6,388 of 6,845 (93.3%).
// javascript 5349 -> 5329, typescript 6388 -> 6372 (land/grammar-statement-declaration): no literal
// changes, but the mutants' verdicts do (a declaration in a sub-statement position, `export` and a
// statement that begins with a declaration word, no longer parse): javascript 5,329 of 5,991 rejects
// agree (88.9%, was 91.4% of 5,850), typescript 6,372 of 6,847 (93.1%). The javascript share falls
// (owed to the recovery lane): of the 662 disagreements 355 begin with `import` (the pattern above),
// 207 with `const` / `var` / `let` / `export` and 40 with `for` / `if`: inputs whose statement now
// nests (Stmt -> Statement) or whose `export` reads the declaring production itself, where one side
// names no related location (`let }aa ;`: the interpreter's farthest 5, the engine none; `export  ,aa ;`:
// the interpreter none, the engine 8).
const RECOVERY_FARTHEST_FLOOR: Record<string, number> = { javascript: 5329, typescript: 6372 };
const FARTHEST_HINT = / \[farthest: offset (\d+) near [\s\S]*\]$/;
// P10 EXPECTED-FAIL on `$missing`-only repairs, by class. GREEDY CAPTURE: the repair is right by
// position (each supplied token is where the derivation needs it), but the substituted token is
// read by an operator loop that ended before it: in `for (() of x);` the parse supplies '=>'
// (an arrow, its body `of` ended at `x`) and then 'in' (a for-in over x); in the substituted text
// `for (() => of in x);` the arrow body's operator loop takes `in x` (a binary `in`), so the
// for-in has nothing left. Still run and counted; when one holds again the gate fails until it is
// removed.
// The mutants are drawn from the accept lists (seeded), so the list is re-measured when they change.
// typescript 'for ((async) from y);' -> 'for (() of y);' (master 54c58d2a: two accept rows added at
// the front of the typescript list drew another mutant set). With the NUD repairs (an operand
// supplied or an extra token before it skipped) the parse repairs these inputs another way, and
// the greedy captures are the arrows it now builds: `for (of  y);` gets `of => y` and then 'in'
// supplied, and `of => y in x` is again the arrow body taking the `in`. The LOOKAHEAD BYPASS of
// stage 3 (`async { class C {}`: a supplied 'function' that the statement's
// `[lookahead ∉ { async function }]` refuses) is repaired another way now and no longer drawn.
// typescript + 'for (x = (y = (a in b)) declare c);' (master 69b46fa0, #199: its new literals draw
// another set): the parse supplies '=>' twice and 'in'; in `… =>  declare =>  c in  x` the arrow
// body takes the `in`. Re-measured on that merge: javascript unchanged.
// typescript, land/sound-lt-compose-row (its `<` composite accept rows draw another mutant set):
// the `asserts` and `declare` entries are no longer drawn; drawn instead, the same class:
// 'for (x = () => { for (accessor a in b); } in c);' (`accessor => a in b in x`) and
// 'for (global of of x);' (`global => of => of => x in x`).
// land/grammar-decorators-2 (`@` joins the literals: both sets drawn again): javascript draws neither
// 'for (from x = function () { return a in b; } in c);' nor 'for (of of async y);' and draws
// 'for (of of as y);' (`of => of => as => y in x`); typescript no longer draws 'for (global of of x);'
// and draws 'for (x = (y = (a in b)) constructor c);' (`… => constructor => c in x`) and
// 'for (get of of x);' (`get => of => of => x in x`): the same class, an arrow body taking the `in`.
const P10_GREEDY_CAPTURE: Record<string, string[]> = {
  javascript: ['for (async of x);', 'for (async of => 1 of x);', 'for (of of as y);'],
  typescript: ['for (of  y);', 'for ( of x);', 'for (async of x);', 'for (async of => 1 of x);', 'for (x = () => { for (accessor a in b); } in c);', 'for (x = (y = (a in b)) constructor c);', 'for (get of of x);'],
};
// LOOKAHEAD BYPASS: a lookahead passed on the real tokens, and a repair then supplied a token among
// the tokens it read, so the substituted text is not the one it judged. `class C { default class)
// {} }`: `default` is a class-member modifier only where `class` (or `function`, `interface`, ...)
// follows (typescript.ts defaultAhead): that lookahead read the real `class`; the member's form then
// supplied '*' before it (a generator method `*class() {}`), and `default *class() {}` has no parse
// (with the second-token waiver of riGuardIn off, the same repair: it is not the waiver).
// `f(class extends a?.b{ () {});`: the heritage element's `not(['{', '}', not(heritageFollowers)])`
// read `{ (` (no `}`: it passes), then the element `{` gets a supplied '}' and the call `()`: in the
// substituted text `{ } ()` is the `{}` the lookahead refuses there. Owed: a lookahead that passed
// seals the tokens it matched against later repairs. Measured and not taken (scratch recovery-9):
// sealing every token a passed lookahead READ (its examined extent; a negative one only its furthest
// token) fixes both but costs typescript 1.7 points of damage (more than 3 tokens in `$error`: 12.7%
// -> 14.4%; stable 76.8% -> 76.6%; 39 mutants worse, 3 better; javascript 14.0% -> 14.1%): the
// member-start lookaheads read past what they match, so the extent seals the member. The seal must
// be the span the lookahead MATCHED, which the native lookahead functions do not report.
// land/grammar-decorators-2's draw holds none of them (`f(class extends a?.b{ () {});` is not drawn).
const P10_LOOKAHEAD_BYPASS: Record<string, string[]> = {};
// NOT YET CLASSIFIED: drawn for the first time by the mutant set of land/sound-lt-compose-row (none
// holds a `<`, so that change does not touch their tokens or their parse: only the draw moved; the
// `default class)` lookahead bypass above left the draw with it). `class C { static export case
// type\nx = 1 }` is repaired to `static export * case ( type\n ,\nx = 1 ) }` and
// `export await using from x = y;` to `export await : using : from : x = y;`; the repaired texts
// are rejected. Owed to the recovery lane: name each one's class (or fix it) and move it.
// land/grammar-decorators-2's draw holds none of the three. The `export await using …` kind was the
// grammar's `export` lookahead admitting a Stmt: since land/grammar-statement-declaration `export`
// reads the declaring productions themselves, so that repair is no derivation any more.
const P10_UNCLASSIFIED: Record<string, string[]> = {};
const P10_EXPECTED: [string, Record<string, string[]>][] = [['greedy captures', P10_GREEDY_CAPTURE], ['lookahead bypasses', P10_LOOKAHEAD_BYPASS], ['unclassified redrawn mutants', P10_UNCLASSIFIED]];
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
  const edits = mutationEdits(grammar, (s) => tokenize(s).map((t) => ({ offset: t.offset, text: t.text })), [...c.accept, ...(c.grammar === 'typescript' ? CURATED_TS : [])], RECOVERY_MUTANTS, RECOVERY_SEED);
  const mutants = edits.map((m) => m.src);
  // (a mutant drawn twice: its first edit)
  const editOf = new Map<string, Mutant>();
  for (const m of edits) if (!editOf.has(m.src)) editOf.set(m.src, m);
  const srcs = [...new Set([...base, ...mutants, ...edits.map((m) => m.orig)])].filter((s) => !s.includes('\0'));
  const index = new Map(srcs.map((s, i) => [s, i]));
  const want = srcs.map((s) => oracleOut(s));
  const ascii = srcs.map((s) => /^[\x00-\x7f]*$/.test(s));
  const nRules = portableIR(grammar).rules.length;
  const lex = runners.find((r) => r.lexToks)!.lexToks!;
  // A sample token of each kind that is no literal, for P10's `expected <Kind>` repairs, and a
  // minimal operand of each Pratt rule, for its `expected <Rule>` (withOperandSamples).
  const kindSamples = new Map<string, string>();
  for (const a of c.accept) for (const t of lex(a) ?? []) if (t.kind !== '' && t.lid === 0 && !kindSamples.has(t.kind)) kindSamples.set(t.kind, t.text);
  const samples = withOperandSamples(portableIR(grammar), kindSamples);
  const mutantSet = new Set(mutants);
  let ref: Total[] | null = null;
  for (const r of runners) {
    const raw = r.total(srcs);
    const own = r.batch(srcs);
    const known = RECOVERY_VERDICT_EXPECTED_FAIL[c.grammar] ?? [];
    let knownHits = 0;
    const got = r.utf8Edits ? raw.map((t, i): Total => {
      const u = utf16Of(srcs[i]!);
      const row = ([o, e, m, ro, re, rm]: DiagRow): DiagRow => [u(o), u(e), m, ro < 0 ? ro : u(ro), re < 0 ? re : u(re), rm];
      return { ...t, cst: t.cst === undefined ? undefined : canon(mapTree(JSON.parse(t.cst), u)), errors: t.errors.map(row), strict: t.strict ? row(t.strict) : null };
    }) : raw;
    let primary = 0, farEq = 0, farN = 0, firstEq = 0, firstBefore = 0, firstAfter = 0, farFirstEq = 0, farFirstBefore = 0, farFirstAfter = 0;
    const p10Lists = P10_EXPECTED.map(([name, l]): [string, string[]] => [name, l[c.grammar] ?? []]);
    const greedy = p10Lists.flatMap(([, l]) => l);
    const p10Hits = p10Lists.map(() => 0);
    const p10Failing = new Set<string>();
    const bad: string[] = [];
    let acc = 0, rec = 0, lexEq = 0, maxK = 0, maxAtt = 0, maxScope = 0;
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
      if (g.strict === null) { bad.push(`a reject gave no strict error — ${at(i)}`); return; }
      const [off, , msg, relOff] = g.strict;
      const mine = `Parse error at offset ${off}: ${msg}`;
      if (mine !== werr.replace(FARTHEST_HINT, '')) bad.push(`P7: strict error ${JSON.stringify(mine)}, the interpreter's ${JSON.stringify(werr)} — ${at(i)}`);
      else primary++;
      const far = FARTHEST_HINT.exec(werr);
      farN++;
      if ((far ? Number(far[1]) : -1) === relOff) farEq++;
      const first = g.errors[0]?.[0] ?? -1;
      if (first === off) firstEq++; else if (first < off) firstBefore++; else firstAfter++;
      // The strict parse stops at the failing entry's start; where it got farthest is its related location.
      const fo = relOff >= 0 ? relOff : off;
      if (first === fo) farFirstEq++; else if (first < fo) farFirstBefore++; else farFirstAfter++;
      if (g.maxAttempts > RM_MAX_BARS + 1) bad.push(`recovery: a scope took ${g.maxAttempts} attempts, over ${RM_MAX_BARS + 1} — ${at(i)}`);
      let nTok = 0;
      try { nTok = tokenize(srcs[i]!).length; } catch { /* counted as no token */ }
      const bound = g.attempts * (nTok + 1) * nRules;
      maxK = Math.max(maxK, g.steps / Math.max(1, bound));
      if (g.steps > TOTAL_K * bound) bad.push(`recovery: ${g.steps} steps, over the bound ${TOTAL_K} × ${g.attempts} attempts × (tokens + 1) × ${nRules} rules — ${at(i)}`);
      maxAtt = Math.max(maxAtt, g.attempts);
      maxScope = Math.max(maxScope, g.maxAttempts);
      if (r.lexToks) {
        const toks = r.lexToks(srcs[i]!)!;
        const strict = r.interp([srcs[i]!], 1 << 30)[0]!.steps;
        const row = checkContract(srcs[i]!, toks, JSON.parse(g.cst), g.errors.map((e) => [e[0], e[1], e[2]]), g.steps, g.attempts, strict, samples,
          (s) => oracleOut(s).ok, bad, (k) => k === 'missing-only' && !greedy.includes(srcs[i]!));
        if (greedy.includes(srcs[i]!)) { if (row && row.p10 === 'missing-only' && !row.p10ok) p10Failing.add(srcs[i]!), p10Lists.forEach(([, l], j) => { if (l.includes(srcs[i]!)) p10Hits[j]!++; }); }
        const m = editOf.get(srcs[i]!), o = m && got[index.get(m.orig) ?? -1];
        if (row && m && o?.ok && o.cst !== undefined) Object.assign(row, damage(JSON.parse(g.cst), JSON.parse(o.cst), toks, m.at, m.ins, srcs[i]!.length - m.orig.length));
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
        if (g.ok !== t.ok || rows(g) !== rows(t) || g.cst !== t.cst || g.maxAttempts !== t.maxAttempts || (!lexNonAscii && JSON.stringify(g.strict) !== JSON.stringify(t.strict)) || g.steps !== t.steps && JSON.stringify(FACTS_OF[r.label]) === JSON.stringify(FACTS_OF.typescript)) bad.push(`P6: tree or diagnostics differ from the TS target's: ${JSON.stringify(g.errors)} vs ${JSON.stringify(t.errors)} — ${at(i)}`);
      });
    }
    interpCheck(c, grammar, r, srcs, own, tokenize, bad);
    if (knownHits !== known.length) bad.push(`expected-fail: ${knownHits} of ${known.length} listed verdict divergences remain: remove the ones that agree now`);
    if (r.lexToks) p10Lists.forEach(([name, l], j) => { if (p10Hits[j] !== l.length) bad.push(`P10 expected-fail: ${p10Hits[j]} of ${l.length} listed ${name} remain: remove the ones that hold now (${JSON.stringify(l.filter((x) => !p10Failing.has(x)))})`); });
    if (farEq < (RECOVERY_FARTHEST_FLOOR[c.grammar] ?? 0)) bad.push(`farthest agreement ${farEq} dropped below its recorded floor ${RECOVERY_FARTHEST_FLOOR[c.grammar]}`);
    console.log(`  ${c.grammar}/${r.label}: recovery ${bad.length ? `${bad.length} MISMATCH` : 'ok'} over ${srcs.length} inputs (${mutants.length} mutants): ${acc} accepted with no errors, ${rec} rejected and recovered (lexer ≡ oracle ${lexEq}; strict error ≡ interpreter ${primary}, farthest ≡ its hint on ${farEq}/${farN} (counted); the first repair at the strict error ${firstEq}, before it ${firstBefore}, after it ${firstAfter}; at its farthest token ${farFirstEq}, before ${farFirstBefore}, after ${farFirstAfter}); steps ≤ ${maxK.toFixed(3)} × attempts × (tokens + 1) × rules; attempts per input ≤ ${maxAtt}, per scope ≤ ${maxScope}`);
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

// Beyond ECMAScript, the grammars whose plan has a recovery encoding of its own (a capped prefix's
// cap on a REC_N_SEQ entry: recovery-family.ts riNudOf), on their lists.
const RECOVERY_GRAMMARS = new Set([...ECMASCRIPT, 'cappedcalc']);
for (const p of await prepareAll(selectedCases().filter((c) => RECOVERY_GRAMMARS.has(c.grammar)))) {
  if (!RECOVERY_GRAMMARS.has(p.c.grammar)) continue;
  const { c, grammar, runners, oracleOut, tokenize } = p;
  // The expected-fail inputs are run whatever the seeded mutants are (a new grammar literal reshuffles them).
  recoveryClass(c, grammar, runners, oracleOut, [...parityCorpus(p).map((i) => i.src), ...c.accept, ...c.reject, ...(c.grammar === 'typescript' ? CURATED_TS : []), ...(RECOVERY_VERDICT_EXPECTED_FAIL[c.grammar] ?? [])], tokenize);
}

finish('total parsing (parseTotal) on the corpus, the lists and the mutation corpus');
