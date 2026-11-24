// The DECISION REPORT pages of the root grammars (docs/decisions/<grammar>.md) and of the example
// fixture, and their gates. The page itself (how the parser decides every choice point, the static
// findings and the action each suggests) is src/decision-report.ts, the module
// `node src/cli.ts <grammar.ts> --decisions` writes for any grammar. What this script adds is what
// needs the parser to RUN:
//   • the witness of every static tie: its token alone, parsed as the list's rule by the ParserIR
//     engine of test/ir-engine.ts, must show the tie (else the gate fails);
//   • the ties OBSERVED on pinned inputs (files under node_modules, fixed by package-lock.json; the
//     repository's own sources change with every commit, a page derived from them would too): every
//     frame where a later-declared candidate ended where the winner ended (count and first place);
//   • `--dead`: each dead alternative is removed from the grammar and no tree on the corpora changes
//     (with a mutation proof: removing a tie loser that is not dead must change some input).
//
//   node test/decision-report.ts --gen      # `npm run gen`'s step: (re)write docs/decisions/*.md and the
//                                           # example page (CI's artifact drift step checks them)
//   node test/decision-report.ts            # the gate: every static tie's witness shows the tie, and --dead
//   node test/decision-report.ts --dead     # only: every dead alternative is dead on the corpora
//   node test/decision-report.ts --observe <grammar.ts> <input>...   # any grammar: its page with the ties observed on those inputs (stdout)
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { portableIR, type ParserIR } from '../src/parser-ir.ts';
import { analyzeDecisions, renderDecisions, decisionReport, type DecisionFindings } from '../src/decision-report.ts';
import { emitParser } from '../src/target.ts';
import { tsTarget } from '../src/target-ts.ts';
import { nameRule } from '../src/grammar-names.ts';
import { engine, canon, type Tok } from './ir-engine.ts';
import { scratchDir } from './scratch.ts';
import type { Grammar, RuleExpr } from '../src/types.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const NM = `${ROOT}node_modules`;
const OUT = `${ROOT}docs/decisions`;
const GRAMMARS = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'] as const;
// The example page README's "Adding a language" points at: what the CLI writes next to a grammar.
const EXAMPLE = 'test/fixtures/decisionsjs.ts';
const filesUnder = (dir: string, ext: RegExp): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (ext.test(e.name)) out.push(p); } };
  walk(dir);
  return out;
};
const JS_PINNED = [`${NM}/acorn/dist/acorn.mjs`, ...filesUnder(`${NM}/parse5/dist`, /\.js$/)];
const TS_PINNED = [`${NM}/tsc-oracle/lib/typescript.d.ts`, `${NM}/tsc-oracle/lib/lib.es5.d.ts`, ...JS_PINNED];
const PINNED: Record<string, string[]> = { typescript: TS_PINNED, typescriptreact: TS_PINNED, javascript: JS_PINNED, javascriptreact: JS_PINNED };

type Lib = { tokenize(s: string): Array<{ kid: number; lid: number; off: number; end: number; nl: boolean }>; parse(s: string): unknown };
const dir = scratchDir('decision-report');
async function targetOf(grammar: Grammar, tag: string): Promise<Lib> {
  const file = `${dir}/${tag}.ts`;
  writeFileSync(file, emitParser(grammar, tsTarget));
  return await import(file) as Lib;
}
const toksOf = (lib: Lib, text: string): Tok[] | null => {
  try { return lib.tokenize(text).map((t) => ({ kid: t.kid, lid: t.lid, off: t.off, end: t.end, nl: t.nl })); } catch { return null; }
};
const code = (s: string) => '`' + s.replace(/`/g, 'ˋ').replace(/\|/g, '\\|') + '`';
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

// ── observed ties: the engine over inputs ──
async function observe(ir: ParserIR, lib: Lib, files: string[], rel: (f: string) => string): Promise<Map<string, { n: number; at: string }>> {
  const seen = new Map<string, { n: number; at: string }>();
  let where = '', text = '', toks: Tok[] = [];
  const run = engine(ir, null, {
    check: false,
    onTie: (list, w, l, at) => {
      const k = `${list}|${w}|${l}`;
      const e = seen.get(k);
      if (e) { e.n++; return; }
      const off = toks[at]!.off, line = text.slice(0, off).split('\n').length;
      const le = text.indexOf('\n', off);
      seen.set(k, { n: 1, at: `${where}:${line}: ${code(clip(text.slice(off, le < 0 ? text.length : le).trim(), 60))}` });
    },
  });
  for (const f of files) {
    text = readFileSync(f, 'utf8');
    const t = toksOf(lib, text);
    if (t === null) continue;
    toks = t; where = rel(f);
    run(toks, text);
  }
  return seen;
}
function addObserved(rep: DecisionFindings, obs: Map<string, { n: number; at: string }>): void {
  for (const [k, o] of obs) {
    const [list, w, l] = k.split('|') as [string, string, string];
    let t = rep.ties.find((x) => x.list === list && x.winner === +w && x.loser === +l);
    if (!t) {
      const lm = rep.lists.find((x) => x.list === list)!;
      t = { list, rule: lm.rule, winner: +w, loser: +l, wName: lm.cands[+w]!.name, lName: lm.cands[+l]!.name, tokens: [] };
      rep.ties.push(t);
    }
    t.observed = o;
  }
}
// A static tie's witness, its token alone parsed as the list's rule: the engine must observe the tie.
function witnessFailures(g: string, ir: ParserIR, lib: Lib, rep: DecisionFindings): string[] {
  const out: string[] = [];
  for (const t of rep.ties) {
    if (t.witness === undefined) continue;
    const toks = toksOf(lib, t.witness);
    let shown = false;
    if (toks !== null && toks.length === 1) engine(ir, null, { check: false, onTie: (list, w, l) => { if (list === t.list && w === t.winner && l === t.loser) shown = true; } })(toks, t.witness, t.rule);
    if (!shown) out.push(`${g}: ${t.list}: the tie of ${t.wName} (#${t.winner}) and ${t.lName} (#${t.loser}) at ${code(t.witness)} is not observed when ${code(t.witness)} is parsed as ${t.rule}`);
  }
  return out;
}

// ── the pages ──
async function page(g: string): Promise<{ text: string; report: DecisionFindings; failures: string[] }> {
  const grammar: Grammar = (await import(`${ROOT}${g}.ts`)).default;
  const ir = portableIR(grammar);
  const lib = await targetOf(grammar, g);
  const rep = analyzeDecisions(ir);
  const failures = witnessFailures(g, ir, lib, rep);
  addObserved(rep, await observe(ir, lib, PINNED[g]!, (f) => f.slice(NM.length + 1)));
  const text = renderDecisions(g, ir, portableIR(grammar, { calleeFirstGuards: false }), rep, { command: 'npm run gen', observed: 'the pinned inputs' });
  return { text, report: rep, failures };
}
// The example: exactly what the CLI writes next to the grammar, plus its witnesses checked.
async function examplePage(): Promise<{ file: string; text: string; report: DecisionFindings; failures: string[] }> {
  const grammar: Grammar = (await import(`${ROOT}${EXAMPLE}`)).default;
  const name = grammar.name;
  const { text, findings } = decisionReport(grammar, name);
  const failures = witnessFailures(name, portableIR(grammar), await targetOf(grammar, `example-${name}`), findings);
  return { file: `${ROOT}${EXAMPLE.replace(/[^/]+$/, '')}${name}.decisions.md`, text, report: findings, failures };
}

// ── dead alternatives on the corpora ──
// A grammar without one alternative (by its rule and arm name).
function without(grammar: Grammar, rule: string, arm: string): Grammar {
  return {
    ...grammar,
    rules: grammar.rules.map((r) => {
      if (r.name !== rule) return r;
      if (r.body.type !== 'alt') throw new Error(`${rule} has one alternative`);
      const names = nameRule(r);
      const items = r.body.items.filter((e: RuleExpr) => names.armOf.get(e)?.name !== arm);
      if (items.length !== r.body.items.length - 1) throw new Error(`${rule}: no single arm named ${arm}`);
      return { ...r, body: { ...r.body, items } };
    }),
  };
}
async function deadGate(): Promise<number> {
  const CORPUS = '/tmp/ts-repo/tests/cases/conformance';
  const stride = <T>(xs: T[], n: number): T[] => (xs.length <= n ? xs : xs.filter((_, i) => i % Math.ceil(xs.length / n) === 0));
  const corpus = stride(filesUnder(CORPUS, /\.ts$/).filter((f) => statSync(f).size < 20000), 600);
  if (corpus.length === 0) { console.log(`decision-report --dead: NOT RUN: the conformance corpus ${CORPUS} is missing`); return 1; }
  const inputs: Record<string, string[]> = {
    typescript: [...TS_PINNED, ...readdirSync(`${ROOT}src`).filter((f) => f.endsWith('.ts')).map((f) => `${ROOT}src/${f}`), ...corpus],
    javascript: [...JS_PINNED, ...filesUnder(`${NM}/entities/dist`, /\.js$/), ...filesUnder(`${NM}/yaml/dist`, /\.js$/), ...corpus],
  };
  let failures = 0;
  for (const g of ['typescript', 'javascript'] as const) {
    const grammar: Grammar = (await import(`${ROOT}${g}.ts`)).default;
    const ir = portableIR(grammar);
    const rep = analyzeDecisions(ir);
    const base = await targetOf(grammar, `${g}-base`);
    const texts = inputs[g]!.map((f) => readFileSync(f, 'utf8'));
    const want = texts.map((t) => { try { const x = base.parse(t); return x === null ? null : JSON.stringify(canon(x)); } catch { return 'throws'; } });
    console.log(`  ${g}: ${texts.length} inputs (${want.filter((x) => x !== null && x !== 'throws').length} accepted)`);
    const changed = async (rule: string, arm: string, tag: string): Promise<number> => {
      const lib = await targetOf(without(grammar, rule, arm), tag);
      let n = 0;
      texts.forEach((t, i) => { let got: string | null; try { const x = lib.parse(t); got = x === null ? null : JSON.stringify(canon(x)); } catch { got = 'throws'; } if (got !== want[i]) n++; });
      return n;
    };
    for (const [k, d] of rep.dead.entries()) {
      const n = await changed(d.rule, d.name, `${g}-dead${k}`);
      console.log(`  ${g}: ${d.list}: without ${d.name} (#${d.arm}): ${n} input(s) parse differently`);
      if (n > 0) { console.log(`  FAIL ${g}: ${d.list}: ${d.name} is reported dead but removing it changes ${n} input(s)`); failures++; }
    }
    // The mutation proof: removing a tie's loser that is not dead must change some input, or the corpora cannot tell.
    const deadSet = new Set(rep.dead.map((d) => `${d.list}|${d.arm}`));
    const live = rep.ties.filter((t) => !deadSet.has(`${t.list}|${t.loser}`));
    let proved = false;
    for (const [k, t] of live.entries()) {
      const n = await changed(t.rule, t.lName, `${g}-live${k}`);
      console.log(`  ${g}: mutation: without ${t.lName} (#${t.loser}) of ${t.list}, a tie loser that is not dead: ${n} input(s) parse differently`);
      if (n > 0) { proved = true; break; }
    }
    if (!proved && rep.dead.length > 0) { console.log(`  FAIL ${g}: no live tie loser changes an input when removed: the corpora cannot show that a removal is noticed`); failures++; }
  }
  return failures;
}

// ── main ──
const argv = process.argv.slice(2);
if (argv[0] === '--observe') {
  const [file, ...inputs] = argv.slice(1);
  if (!file || inputs.length === 0) { console.error('usage: node test/decision-report.ts --observe <grammar.ts> <input>...'); process.exit(1); }
  const grammar: Grammar = (await import(resolve(file))).default;
  const name = grammar.name;
  const ir = portableIR(grammar);
  const rep = analyzeDecisions(ir);
  addObserved(rep, await observe(ir, await targetOf(grammar, `observe-${name}`), inputs.map((f) => resolve(f)), (f) => f));
  process.stdout.write(renderDecisions(name, ir, portableIR(grammar, { calleeFirstGuards: false }), rep, { command: `node test/decision-report.ts --observe ${name}.ts <inputs>`, observed: `${inputs.length} given input${inputs.length > 1 ? 's' : ''}` }));
  process.exit(0);
}
const mode = argv.includes('--gen') ? 'gen' : argv.includes('--dead') ? 'dead' : 'check';
const t0 = Date.now();
let failures = 0;
// The gate runs the witness checks, then the dead alternatives (formerly the gate decision-dead:
// one process, the grammars' IR built once each). Whether the committed pages are current is the
// artifact drift step's question (`npm run gen` writes them; CI fails on a diff), not the gate's.
if (mode === 'dead') failures += await deadGate();
else {
  if (mode === 'gen') mkdirSync(OUT, { recursive: true });
  const pages: Array<{ file: string; text: string; report: DecisionFindings; failures: string[] }> = [];
  for (const g of GRAMMARS) pages.push({ file: `${OUT}/${g}.md`, ...(await page(g)) });
  pages.push(await examplePage());
  for (const { file, text, report, failures: f } of pages) {
    const rel = file.slice(ROOT.length);
    const counts = `${report.dead.length} dead, ${report.ties.length} ties, ${report.unreached.length} unreached`;
    if (mode === 'gen') {
      // the page is written whatever the witnesses say: the gate reports them
      const old = existsSync(file) ? readFileSync(file, 'utf8') : null;
      if (old !== text) writeFileSync(file, text);
      console.log(`  ${old === text ? '· unchanged' : '✓ wrote'} ${rel}: ${counts}`);
      continue;
    }
    for (const x of f) { console.log(`  FAIL ${x}`); failures++; }
    console.log(`  ${rel}: ${f.length ? f.length + ' witness failure(s)' : 'witnesses hold'} (${counts})`);
  }
  if (mode === 'check') failures += await deadGate();
}
console.log(`decision-report${mode === 'check' ? '' : ' --' + mode}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${failures} failures`);
process.exit(failures ? 1 : 0);
