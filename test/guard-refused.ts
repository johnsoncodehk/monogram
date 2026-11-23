// Gate: NOTHING A GUARD REFUSES ON A REAL INPUT COULD HAVE CHANGED THE PARSE. The portable
// parsers decide some choices without trying them: a longest-match candidate whose Guard refuses
// the buffered token (its FIRST set, its lead tests, the refusal by the complement of its FIRST:
// emit-portable.ts Guard), a candidate its Dispatch never reaches for that token, an ordered or
// predictive branch outside its FIRST set, and a star / opt / sep body outside its body guard
// (Step.guard). Each is sound only if the thing refused could not have changed the parse there:
// test/guard-lead.ts proves lead tests equal the steps they took over, test/guard-refutation.ts
// probes every refused symbol over a few short continuations. This gate closes the rest on real
// inputs: wherever a guard refuses, it ATTEMPTS the refused thing anyway, unguarded, from the very
// state the parser was in (position, children, builder, context, suppress set), and fails when
// that attempt would have changed the outcome:
//   • a longest-match candidate (rd alternative, NUD sequence or capped arm): it matches and ends
//     past the winner, or at the winner's end while declared before it (it would have won);
//   • an ordered or predictive branch: it matches before the branch that won (or none won);
//   • a star / opt / sep body: it matches non-empty (the loop would have gone on);
//   • a COMMITTED choice (emit-portable.ts Commit): at a key the commit switch decides, every
//     candidate other than the committed one (all of them, where it fails or the key fails the
//     list) is attempted from the list's start: none may have won.
// It also checks every MARK THE PLAN ELIDES (Step.clean: a frame over a body that fails clean takes
// none): wherever such a body fails on a real input, the state a mark protects (position, scratch
// list, nodes) and the context and suppress sets must be as the body found it:
//   • a star / opt / sep body marked `clean` (a repetition of one Pratt call the next step dooms may
//     fail dirty, but then every step that follows it must fail from where the body stopped);
//   • an ordered / predictive branch marked clean, an rd rule marked clean (its PREDICTIVE / SINGLE
//     entry), a committed candidate the plan runs without undo (CommitAct.clean);
//   • a led arm marked `ledClean`: its block puts the position and the scratch list back itself, so
//     the nodes must be as before.
// Its mutation proof takes for clean one frame (a branch, a repetition body) that failed dirty on an
// input: it must be reported.
// The check runs on the IR, not on a target: guards are IR data, and each target renders a subset
// of them (Rust leaves body guards out of Pratt arms), so one check bounds all three. Its engine is
// an interpreter of the ParserIR that follows the portable engine step for step (the rule, Pratt
// and step shells of emit-portable.ts, as test-scale code); so that it cannot drift from what the
// targets run, every input's result is compared with the TS target's `parse` of the same text:
// accept / reject and, when accepted, the whole tree.
// Inside an attempt made for a check, further refusals are not checked (each check costs about
// one extra parse of the refused part; checking inside them would nest that cost).
//
//   node test/guard-refused.ts          [--strict-empty]   (also: GUARD_REFUSED_FILES=<n> to widen the corpus sample)
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { portableIR, buildLexIdPlan } from '../src/emit-portable.ts';
import { engine, canon, type Tok, type Mutation } from './ir-engine.ts';
import { emitParser } from '../src/target.ts';
import { tsTarget } from '../src/target-ts.ts';
import { scratchDir } from './scratch.ts';
import type { CstGrammar } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const CORPUS = '/tmp/ts-repo/tests/cases/conformance';
const SAMPLE = Number(process.env.GUARD_REFUSED_FILES ?? 300);

// ── inputs ──
function filesUnder(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (ext.test(e.name)) out.push(p); } };
  walk(dir);
  return out;
}
const stride = <T>(xs: T[], n: number): T[] => (xs.length <= n ? xs : xs.filter((_, i) => i % Math.ceil(xs.length / n) === 0));
const tsCorpus = filesUnder(CORPUS, /\.tsx?$/).filter((f) => statSync(f).size < 20000);
const corpus = stride(tsCorpus.filter((f) => !f.endsWith('.tsx')), SAMPLE);
if (corpus.length === 0) { console.log(`guard-refused: NOT RUN: the conformance corpus ${CORPUS} is missing`); process.exit(1); }
const tsxCorpus = tsCorpus.filter((f) => f.endsWith('.tsx'));
const NM = `${ROOT}node_modules`;
// An input: a file, or a text written here (named by its grammar and index).
type Input = string | { name: string; text: string };
const tsInputs: Input[] = [
  ...readdirSync(`${ROOT}src`).filter((f) => f.endsWith('.ts')).map((f) => `${ROOT}src/${f}`),
  ...readdirSync(ROOT).filter((f) => f.endsWith('.ts')).map((f) => `${ROOT}${f}`),
  `${NM}/typescript/lib/typescript.d.ts`, `${NM}/typescript/lib/lib.es5.d.ts`,
  ...corpus,
];
const jsInputs: Input[] = [
  // A repetition body under a full mark that fails with a node built (`return`'s opt(Expr): `a + 1`
  // is built, then `=` needs a target): the leaves-only mark's mutation proof. A rejected input.
  { name: 'javascript#0', text: 'function f() { return a + 1 = 2; }' },
  `${NM}/acorn/dist/acorn.mjs`,
  ...filesUnder(`${NM}/parse5/dist`, /\.js$/), ...filesUnder(`${NM}/entities/dist`, /\.js$/), ...filesUnder(`${NM}/yaml/dist`, /\.js$/),
  ...corpus,
];
// JSX written here: elements, fragments, attributes, spreads, holes, text, elements inside holes,
// relational `<` next to elements. The corpus has no .jsx file; its .tsx files are also fed to the
// JavaScript dialect, which accepts the ones with no type syntax.
const jsxTexts = [
  'const a = <div className="x" {...rest}>Hello {name}, <b>welcome</b></div>;',
  'const l = <><span>1</span><span>2</span></>;\nconst m = <ul>{items.map((x) => <li key={x.id}>{x.name}</li>)}</ul>;',
  'function Card({ title }) {\n  return <section className="card"><h2>{title}</h2>{/* c */}</section>;\n}',
  'const q = ok ? <Yes /> : <No />;\nrender(<App config={cfg} a-b={`${t}`} />, root);\nlet z = a < b > c;',
  'const s = <Foo.Bar baz={1}>{cond && <i>t</i>}&nbsp;x</Foo.Bar>;\nx = y < z;',
];
const tsxTexts = [
  ...jsxTexts,
  'const g = <T,>(y: T) => <q>{y}</q>;\nfunction F<P extends object>(p: P): JSX.Element { return <div {...p} />; }',
  'let m = new Map<string, X>();\nconst e = <C<number> a={1} />;\ntype F = <T>(x: T) => T;',
];
// The element dialect's own inputs (the shapes test/incremental-grammars.ts edits).
const dialectTexts = [
  'component C(a) {\n  <a k="v">@if (a) { <b/> } @else { "e" } {a}</a> "z" <c/>\n}',
  'component D() { <a><b>{1}</b><{t} id="d">"s"</{t}></a> }\ncomponent E() { "q" }',
  'component S() { <a><style k="v">.a { b: "c" } <i></style>"t"</a> <style></style> }',
  '@x @y component L(a, b) { @each (i of a.b(1, 2)) { <my-card on:click={!a == b}/> } @empty { "none" } <p {k}>{a + b - 1}</p> }',
  // failures where a mark is elided (an empty argument list, a member access that does not
  // continue) and a repetition body that fails dirty (`-` with no name after it): rejected inputs
  'component F() { <a>{f()}{g(a, b)}{a.b}</a> }', 'component G() { <a- /> }', 'component H() { {a.} }',
];
// the text dialect (test/fixtures/textdialect.ts): text children with tag starts, raw text,
// comments in text and directives; and rejected inputs
const textDialectTexts = [
  'component C(a) {\n  <p k="v">1 < 2 {a} <b/>x<9 <></></p>;\n  const z = a <b;\n  return <{a}>y</{a}>;\n}',
  'component S() { <style>{a}</style>; <style> .x{}</style>; <script>a<b</script> }',
  'component C(a) {\n  <p>hi // n\n a/* c */b {a}// m\n</p>;\n  const z = 1; /* k */\n}',
  'component C(a) {\n  <p>x @if (a) { y <b/> } @else if ({a}.a) {m} @else { n } z@for await (i of a) {{i}} @empty {e}</p>;\n}',
  'component C(a) { <p>@try {t} @pending {p} @catch (e) {c} @{ const q = 1; <b/> }</p>; }',
  'component C(a) { <p>@if (a) {y</p>; }', 'component C(a) { <p k=< b>x</p> }', 'component C(a) { const b = < 1; }',
];
const texts = (g: string, xs: string[]): Input[] => xs.map((text, i) => ({ name: `${g}#${i}`, text }));
const GRAMMARS: Array<[string, Input[]]> = [
  ['typescript', tsInputs],
  ['javascript', jsInputs],
  ['typescriptreact', [...texts('typescriptreact', tsxTexts), ...tsxCorpus]],
  ['javascriptreact', [...texts('javascriptreact', jsxTexts), ...jsInputs, ...tsxCorpus]],
  ['test/fixtures/elementdialect', texts('elementdialect', dialectTexts)],
  ['test/fixtures/textdialect', texts('textdialect', textDialectTexts)],
];

let failures = 0;
const t0 = Date.now();
// The leaves-only mark's mutation proof needs a repetition body that failed with a node built under
// a full mark; most grammars' inputs have none (javascript's), and the check is one engine for every
// grammar, so the proof is required once over the run, not per grammar.
let leavesProved = 0;
const dir = scratchDir('guard-refused');
for (const [g, inputs] of GRAMMARS) {
  const grammar: CstGrammar = (await import(`${ROOT}${g}.ts`)).default;
  const ir = portableIR(grammar);
  const file = `${dir}/${g.replace(/\//g, '_')}.ts`;
  writeFileSync(file, emitParser(grammar, tsTarget));
  const lib = await import(file) as { tokenize(s: string): Tok[]; parse(s: string): unknown };
  const run = engine(ir);
  let n = 0, accepted = 0, checks = 0, cleanChecks = 0, leavesChecks = 0, drift = 0, bad = 0;
  type Proof = { at: string; tokens: Tok[]; text: string; m: Mutation };
  const proof: { body?: Proof; cand?: Proof; commit?: Proof; clean?: Proof; leaves?: Proof; pair?: Proof } = {};
  for (const input of inputs) {
    const text = typeof input === 'string' ? readFileSync(input, 'utf8') : input.text;
    let tokens: Tok[];
    try { tokens = lib.tokenize(text).map((t) => ({ kid: t.kid, lid: t.lid, off: t.off, end: t.end, nl: t.nl })); } catch { continue; }
    n++;
    const want = lib.parse(text);
    const got = run(tokens, text);
    checks += got.checked; cleanChecks += got.cleanChecked; leavesChecks += got.leavesChecked;
    if (got.accept) accepted++;
    const name = typeof input !== 'string' ? input.name : input.startsWith(ROOT) ? input.slice(ROOT.length) : input.slice(CORPUS.length - 'conformance'.length);
    if (got.accept !== (want !== null) || (got.accept && JSON.stringify(got.tree) !== JSON.stringify(canon(want)))) {
      drift++;
      if (drift <= 5) console.log(`  DRIFT ${g} ${name}: the engine ${got.accept ? 'accepts' : 'rejects'}, the TS target ${want !== null ? 'accepts' : 'rejects'}${got.accept && want !== null ? ' with another tree' : ''}`);
    }
    for (const u of got.unsound) { bad++; if (bad <= 12) console.log(`  FAIL ${g} ${name}: ${u}`); }
    if (!proof.body && got.found.body) proof.body = { at: name, tokens, text, m: { step: got.found.body.step, lid: got.found.body.lid } };
    if (!proof.cand && got.found.cand) proof.cand = { at: name, tokens, text, m: { guard: got.found.cand.guard, lid: got.found.cand.lid, pos: got.found.cand.pos } };
    if (!proof.pair && got.found.pair) proof.pair = { at: name, tokens, text, m: { lid: got.found.pair.lid, pair: { guard: got.found.pair.guard, pos: got.found.pair.pos } } };
    if (!proof.clean && got.found.dirty) proof.clean = { at: name, tokens, text, m: { lid: 0, clean: got.found.dirty } };
    if (!proof.leaves && got.found.built) proof.leaves = { at: name, tokens, text, m: { lid: 0, leaves: got.found.built.step } };
    if (!proof.commit && got.found.commit) { const c = got.found.commit; proof.commit = { at: name, tokens, text, m: { lid: c.lid, commit: { list: c.list, kid: c.kid, arm: c.arm } } }; }
  }
  // The mutation proof: a body guard, then a candidate guard, made to refuse a literal it admitted
  // where its body / candidate matched; the gate must report it on that input.
  const ids = buildLexIdPlan(ir);
  const what = { body: 'guarded body matched from a literal', cand: 'guarded candidate matched from a literal', commit: 'committed choice matched from a literal', clean: 'branch or repetition body failed dirty', leaves: 'repetition body under a full mark failed with a node built', pair: 'candidate admitted by a pair test won' } as const;
  for (const kind of ['body', 'cand', 'commit', 'clean', 'leaves', 'pair'] as const) {
    const p = proof[kind];
    // A grammar whose plan has no pair (Guard.pairs) has none to mutate.
    if (!p && kind === 'pair' && !ir.rules.some((r) => r.kind === 'rd' && r.altGuard.some((g) => g?.pairs))) continue;
    if (!p && kind === 'leaves') { console.log(`  ${g}: no ${what[kind]} (the leaves-only mark's proof is required once over the run)`); continue; }
    if (!p) { console.log(`  FAIL ${g}: no ${what[kind]}: the mutation proof has nothing to mutate`); failures++; continue; }
    const caught = engine(ir, p.m)(p.tokens, p.text).unsound.length;
    const did = kind === 'pair' ? `the pair tests that admitted ${JSON.stringify(ids.lids[p.m!.lid])} in ${p.at} made to refuse the second token` : kind === 'leaves' ? `the ${p.m!.leaves!.t} body that failed with a node built in ${p.at} taken to fail with leaves only` : kind === 'clean' ? `${p.m!.clean!.i < 0 ? `the ${p.m!.clean!.step.t} body` : `branch ${p.m!.clean!.i} of a choice`} that failed dirty in ${p.at} taken for clean`
      : kind === 'commit' ? `the ${p.m!.commit!.list} list that committed at ${JSON.stringify(ids.lids[p.m!.lid])} in ${p.at} made to commit to its candidate ${p.m!.commit!.arm}`
      : `the ${kind === 'body' ? 'body guard' : 'candidate guard'} that admitted ${JSON.stringify(ids.lids[p.m!.lid])} in ${p.at} made to refuse it`;
    console.log(`  ${g}: mutation: ${did}: ${caught} unsound ${kind === 'clean' || kind === 'leaves' ? 'elided mark(s)' : 'refusal(s)'} reported`);
    if (kind === 'leaves' && caught > 0) leavesProved++;
    if (caught === 0) { console.log(`  FAIL ${g}: the mutated ${kind === 'clean' || kind === 'leaves' ? 'frame' : 'guard'} was not caught`); failures++; }
  }
  failures += drift + bad;
  console.log(`  ${g}: ${n} inputs (${accepted} accepted), ${checks} refusals attempted, ${cleanChecks} failures where a mark is elided, ${leavesChecks} where the mark is the position and the scratch list only, ${bad} would have changed the parse, ${drift} differ from the TS target`);
  if (checks === 0) { console.log(`  FAIL ${g}: no refusal was attempted: the gate checks nothing`); failures++; }
  if (cleanChecks === 0) { console.log(`  FAIL ${g}: no body failed where a mark is elided: the gate checks nothing there`); failures++; }
  if (leavesChecks === 0 && JSON.stringify(ir.rules).includes('"leaves":true')) { console.log(`  FAIL ${g}: no body failed under a leaves-only mark: the gate checks nothing there`); failures++; }
}
if (leavesProved === 0) { console.log('  FAIL: no grammar had a repetition body that failed with a node built: the leaves-only mark\'s mutation proof has nothing to mutate'); failures++; }
console.log(`guard-refused: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${failures} failures`);
process.exit(failures ? 1 : 0);
