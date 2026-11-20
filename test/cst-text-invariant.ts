// Gate: the CST contract.
//
//  SHAPE — a leaf is exactly {tokenType, offset, end}, a node exactly {rule, children, offset,
//    end}. No `text` (derivable: source.slice(offset, end)) and no `kind` (derivable: a leaf has
//    tokenType, a node has children — disjoint by construction) on either shape, and spans are
//    sane (0 ≤ offset ≤ end ≤ source.length).
//
//  TEXT — the tree IS the input: its leaves, in order, hold every token of the source, each
//    exactly once. A token the parser stepped over without placing it in a node (a failed
//    attempt that left the position advanced) breaks this, whatever the verdict. Checked on
//    every tree an engine hands out: the interpreter's and the emitted parser's accepted tree,
//    and the emitted parser's RECOVERED tree for a rejected input (recovery keeps the tokens it
//    cannot place in $error nodes, so that tree holds every token too).
//
// Inputs, per grammar:
//   • the generative corpus (grammar-gen, deterministic) — legal by construction;
//   • MUTANTS of it — one token deleted or doubled. A legal corpus cannot show a parser
//     accepting what it should reject, and that is where a dropped token hides: the mutants are
//     near-miss inputs, most of them invalid, each run through every engine;
//   • for the ECMAScript grammars, expressions the operator checks refuse (`++ ++y`, `x++ ++`,
//     `-x = 1`, `-x ** 2`), in every position where an expression is optional or repeated;
//   • a stride sample of the real-world TS conformance corpus when present (skipped silently
//     otherwise — check.ts gates must not require an external corpus).
//   node test/cst-text-invariant.ts
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser } from '../src/gen-parser.ts';
import { compileTokenizer, lexSpecOf } from '../src/emit-lexer.ts';
import { emitParser, jsTarget } from '../src/emit.ts';
import { objectify, type TreeView } from './emitted-obj.ts';
import { generateInputs } from './grammar-gen.ts';
import type { CstGrammar } from '../src/types.ts';

const GRAMMARS = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'yaml', 'html'];
// A directory of this run's own: two runs at once must not read each other's emitted module.
const TMP = mkdtempSync(join(tmpdir(), 'monogram-cst-text-invariant-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

let leaves = 0;
let bad = 0;
const samples: { tag: string; tokenType: string; text: string; span: string }[] = [];

type AnyCst = { kind?: string; tokenType?: string; rule?: string; text?: string; offset: number; end: number; children?: AnyCst[] };
function check(n: AnyCst, src: string, tag: string): void {
  if (n.children === undefined) {
    leaves++;
    const ok = !('text' in n) && !('kind' in n)
      && typeof n.tokenType === 'string' && !('rule' in n)
      && typeof n.offset === 'number' && typeof n.end === 'number'
      && n.offset >= 0 && n.offset <= n.end && n.end <= src.length;
    if (!ok) {
      bad++;
      if (samples.length < 8) samples.push({ tag, tokenType: n.tokenType ?? '', text: String('text' in n ? n.text : '<shape bad>'), span: src.slice(n.offset, n.end) });
    }
    return;
  }
  if ('kind' in n || 'tokenType' in n || typeof n.rule !== 'string') {
    bad++;
    if (samples.length < 8) samples.push({ tag, tokenType: '<node shape bad>', text: String(n.rule), span: '' });
  }
  for (const c of n.children) check(c, src, tag);
}

// ── TEXT: every token of the source is inside a leaf, leaves in source order ──
type Tok = { offset: number; text: string };
let trees = 0;
let textBad = 0;
const textSamples: string[] = [];
const textBadBy = new Map<string, number>();
let verdictBad = 0;
// EXPECTED-FAIL, still run and counted: grammars where the two engines are known to disagree for
// a reason that is not a position left advanced. Owed as its own fix; when a grammar listed
// here stops disagreeing the gate fails until its entry is removed.
const VERDICT_EXPECTED_FAIL: Record<string, string> = {
  html: 'a close tag whose name differs from its open tag (`<aA> </a>`): the interpreter rejects, the emitted parser accepts',
};
const verdictKnown = new Map<string, number>();
const verdictBadBy = new Map<string, number>();
const verdictSamples: string[] = [];
function checkText(tree: AnyCst, toks: Tok[], src: string, tag: string): void {
  trees++;
  const ls: AnyCst[] = [];
  (function walk(n: AnyCst) { if (n.children === undefined) ls.push(n); else for (const c of n.children) walk(c); })(tree);
  let why = '';
  for (let i = 1; i < ls.length && !why; i++) {
    if (ls[i].offset < ls[i - 1].end) why = `leaf at ${ls[i].offset} starts before the previous leaf ends (${ls[i - 1].end})`;
  }
  let li = 0;
  for (let i = 0; i < toks.length && !why; i++) {
    const s = toks[i].offset, e = s + toks[i].text.length;
    if (e === s) continue;                         // a zero-width layout token has no text to hold
    while (li < ls.length && ls[li].end <= s) li++;
    if (li >= ls.length || ls[li].offset > s || ls[li].end < e) why = `token ${JSON.stringify(toks[i].text)} at ${s} is in no leaf`;
  }
  if (!why) return;
  textBad++;
  textBadBy.set(tag, (textBadBy.get(tag) ?? 0) + 1);
  if (textSamples.length < 12) textSamples.push(`${tag}: ${why} — ${JSON.stringify(src.length > 90 ? src.slice(0, 90) + '…' : src)}`);
}

// One token deleted / one token doubled, at up to MUT_SITES evenly spread tokens of an input.
const MUT_SITES = 6;
function mutants(src: string, toks: Tok[]): string[] {
  const real = toks.filter((t) => t.text.length > 0);
  if (real.length === 0 || real.length > 60) return [];
  const out: string[] = [];
  const step = Math.max(1, Math.floor(real.length / MUT_SITES));
  for (let i = 0; i < real.length; i += step) {
    const s = real[i].offset, e = s + real[i].text.length;
    out.push(src.slice(0, s) + src.slice(e));
    out.push(src.slice(0, e) + ' ' + real[i].text + src.slice(e));
  }
  return out;
}

// Expressions an operator check refuses, in each position where an expression is optional or
// repeated — and in the plain positions beside them.
const REFUSED = ['++ ++y', '++-x', '++x++', 'x++ ++', 'x++ --', '-x = 1', 'a + b = 1', 'x++ = 1', '-x ** 2', 'typeof x ** 2', '= b'];
const HOLES = [
  '[@]', '[1, @]', '[@, 1]', 'f(@)', 'f(a, @)', 'new A(@)', 'a = [@]', 'x = { a: @ }', 'x = { ...@ }', 'class C { p = @ }',
  'for (@;;) {}', 'for (;@;) {}', 'for (;;@) {}', 'function f() { return @ }', 'function* g() { yield @ }', 'yield @', 'var z = @',
  'var z = 1, w = @', '`${@}`', 'a ? @ : b', 'a ? b : @', 'x => @', '(@)', 'a[@]', '- @', '[- @]', 'a + @', '[a + @]', 'f(a + @)', 'a = @', '[a = @]',
  'if (@) {}', 'while (@) {}', 'switch (@) {}', 'throw @', 'do {} while (@)', 'a?.[@]', 'a?.(@)', 'async () => { await @ }',
];
const curated = (): string[] => HOLES.flatMap((h) => REFUSED.map((r) => h.replace('@', r)));

type Emitted = {
  createParser(): {
    parse(s: string): { root: number; errors: unknown[] };
    visit(c: object, fns: object): void;
    tree: TreeView;
  };
};

for (const name of GRAMMARS) {
  const grammar: CstGrammar = (await import(`../${name}.ts`)).default;
  const parser = createParser(grammar);
  const tokenize = compileTokenizer(lexSpecOf(grammar)) as (s: string) => Tok[];
  const emPath = `${TMP}/${name}.mts`;
  writeFileSync(emPath, emitParser(grammar, jsTarget));
  const em = ((await import(emPath + '?v=' + process.pid)) as Emitted).createParser();

  // Every engine on one input; `legal` inputs also feed the shape check and the mutants.
  let parsed = 0, recovered = 0;
  const run = (src: string, tag: string): Tok[] | null => {
    let toks: Tok[];
    try { toks = tokenize(src); } catch { return null; }   // not lexable: no token stream to hold
    let cst: AnyCst | null = null;
    try { cst = parser.parse(src) as AnyCst; } catch { /* rejected */ }
    if (cst !== null) { check(cst, src, name); checkText(cst, toks, src, `${tag} interpreter`); parsed++; }
    const c = em.parse(src);
    const emTree = objectify(em.tree, (fns) => em.visit(c, fns)) as AnyCst;
    // The two engines are one parser: a position one of them fails to step back from shows
    // first as a verdict only one of them gives (`f(++ ++y)`).
    if ((cst !== null) !== (c.errors.length === 0)) {
      if (name in VERDICT_EXPECTED_FAIL) verdictKnown.set(name, (verdictKnown.get(name) ?? 0) + 1);
      else verdictBad++;
      verdictBadBy.set(tag, (verdictBadBy.get(tag) ?? 0) + 1);
      if (verdictSamples.length < 12) verdictSamples.push(`${tag}: interpreter ${cst !== null ? 'accepts' : 'rejects'}, emitted ${c.errors.length === 0 ? 'accepts' : 'rejects'} — ${JSON.stringify(src.length > 90 ? src.slice(0, 90) + '…' : src)}`);
    }
    if (c.errors.length === 0) checkText(emTree, toks, src, `${tag} emitted`);
    else { checkText(emTree, toks, src, `${tag} emitted (recovered)`); recovered++; }
    return toks;
  };

  let nMut = 0;
  for (const input of generateInputs(grammar, { depth: 5, nestDepth: 5, cap: 7, fuzzRounds: 250, maxInputs: 1500, seed: 5 })) {
    const toks = run(input.text, name);
    if (toks === null) continue;
    for (const m of mutants(input.text, toks)) { run(m, `${name} mutant`); nMut++; }
  }
  let nCur = 0;
  if (name !== 'yaml' && name !== 'html') for (const src of curated()) { run(src, `${name} refused-operand`); nCur++; }
  console.log(`${name.padEnd(18)} accepted: ${parsed}  recovered: ${recovered}  (mutants tried: ${nMut}, refused-operand inputs: ${nCur})`);
}

// Real-world TS sample (optional corpus).
const corpus = '/tmp/ts-repo/tests/cases/conformance';
if (existsSync(corpus)) {
  const files: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) files.push(p);
    }
  })(corpus);
  files.sort();
  const grammar: CstGrammar = (await import('../typescript.ts')).default;
  const parser = createParser(grammar);
  const tokenize = compileTokenizer(lexSpecOf(grammar)) as (s: string) => Tok[];
  const stride = Math.max(1, Math.floor(files.length / 300));
  let parsed = 0;
  for (let i = 0; i < files.length; i += stride) {
    const src = readFileSync(files[i], 'utf-8');
    let cst: AnyCst;
    try { cst = parser.parse(src) as AnyCst; } catch { continue; }
    check(cst, src, 'ts-corpus');
    checkText(cst, tokenize(src), src, 'ts-corpus interpreter');
    parsed++;
  }
  console.log(`${'ts-corpus'.padEnd(18)} corpus files parsed: ${parsed}`);
}

console.log(`leaves checked: ${leaves}, contract violations: ${bad}`);
for (const s of samples) console.log('  ', JSON.stringify(s).slice(0, 160));
console.log(`trees checked: ${trees}, trees not holding every token: ${textBad}`);
for (const [tag, n] of textBadBy) console.log(`   ${String(n).padStart(5)}  ${tag}`);
for (const s of textSamples) console.log('  ', s);
console.log(`inputs where the interpreter and the emitted parser give different verdicts: ${verdictBad}`);
let staleExpectedFail = false;
for (const [g, reason] of Object.entries(VERDICT_EXPECTED_FAIL)) {
  const n = verdictKnown.get(g) ?? 0;
  console.log(`   expected-fail ${g}: ${n} disagreeing inputs — ${reason}`);
  if (n === 0) { staleExpectedFail = true; console.error(`✗ ${g} no longer disagrees: remove its VERDICT_EXPECTED_FAIL entry`); }
}
for (const [tag, n] of verdictBadBy) console.log(`   ${String(n).padStart(5)}  ${tag}`);
for (const s of verdictSamples) console.log('  ', s);
if (bad > 0) console.error('✗ CST shape violates the contract');
if (textBad > 0) console.error('✗ a tree does not hold every token of its input');
if (verdictBad > 0) console.error('✗ the interpreter and the emitted parser disagree on a verdict');
if (bad > 0 || textBad > 0 || verdictBad > 0 || staleExpectedFail) process.exit(1);
console.log('✓ every leaf is {tokenType, offset, end} and every node {rule, children, offset, end}');
console.log('✓ every tree (accepted or recovered, interpreter and emitted) holds every token of its input, in order');
console.log(`✓ the interpreter and the emitted parser give the same verdict on every input (expected-fail: ${Object.keys(VERDICT_EXPECTED_FAIL).join(', ')})`);
