// Gate class of the portable targets (test/portable-harness.ts), its own gate and CI only (tier
// 'ci': minutes, not the inner loop): the WIDE corpora. Every file of the tsc conformance corpus and
// of test262 through every runner, against the interpreter.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createParser } from '../src/gen-parser.ts';
import { canon, ECMASCRIPT, errText, finish, gate, prepareAll, selectedCases, skelObj, skeleton, type Case, type Runner } from './portable-harness.ts';
// Every rule level interpreted (test/portable-recovery.ts INTERP_ALL).
const INTERP_ALL = 1 << 30;

// ── The wide class: the pinned external corpora, WHOLE, every runner ≡ the interpreter ──
// The parity corpus holds what the grammar derives and what someone wrote down; the interpreter is
// also checked on two external corpora (conformance/js-corpus and conformance/test262), and the
// portable parsers must give every file of them the interpreter's verdict and, when both accept,
// its rule skeleton (the tree of rule nodes; the leaves are the lexer's, whose token streams the
// parity corpus compares). Each file is one input, its text whole:
//   - the tsc conformance corpus (/tmp/ts-repo/tests/cases/conformance, every .ts file), for the
//     TypeScript grammar and, read as JavaScript like conformance/js-corpus does, the JavaScript one;
//   - test262 (/tmp/test262 at test/test262.sha, every test under test/language and
//     test/annexB/language but the _FIXTURE modules), for the JavaScript grammar, valid and
//     invalid tests alike (the verdict to match is the interpreter's, not the front matter's).
// An absent corpus fails the class (it never passes unrun). The inputs go in chunks so no batch's
// CST output grows with the corpus.
const TS_CONFORMANCE = '/tmp/ts-repo/tests/cases/conformance';
const TEST262 = '/tmp/test262';
const TEST262_DIRS = ['test/language', 'test/annexB/language'];
const WIDE_CHUNK = 2000;
// EXPECTED-FAIL, still run and counted: the RECORD test/portable-wide-record.txt holds every file of
// the wide corpora on which a portable parser's verdict or tree is not the interpreter's, one line
// each: grammar, file, the targets that disagree, and its cause class (WIDE_CAUSES; each owed as its
// own fix). The class compares the run with the record and fails on ANY difference, naming each line
// that moved: a file that starts to disagree is a regression, one that stops is an improvement to
// record. `node test/portable-wide.ts --write` (re)writes the record; it refuses a
// disagreement no class explains (`unknown`) and a run without all three targets.
const WIDE_RECORD = new URL('./portable-wide-record.txt', import.meta.url).pathname;
const WIDE_WRITE = process.argv.includes('--write');
const WIDE_CAUSES: Record<string, string> = {
  'mixfix-rebind': 'the interpreter\'s mixfix operand re-bind (gen-parser.ts matchMixfixLed: a failed `<L1> $ <L2> …` led retries its operand capped at each depth-0 L2 inside it) has no counterpart in the portable engine',
  'hashbang-not-first': 'a `#!` after the start of the text: the interpreter\'s lexer takes it as a Shebang comment, the portable lexers do not (a HashbangComment begins the source text only, so the portable verdict is the spec\'s)',
};
const REBIND_FILES = new Set(['types/conditional/inferTypesWithExtends1.ts', 'types/conditional/inferTypesInvalidExtendsDeclaration.ts',
  ...[8, 9, 10, 11, 12].map((n) => `parser/ecmascript5/ArrowFunctionExpressions/parserArrowFunctionExpression${n}.ts`)]);
// The cause of one disagreement, from what the file is ('unknown' when no class explains it).
function wideCause(grammar: string, file: string, src: string): string {
  if (grammar === 'typescript' && REBIND_FILES.has(file)) return 'mixfix-rebind';
  if (src.indexOf('#!', 1) > 0) return 'hashbang-not-first';
  return 'unknown';
}
type WideLine = { grammar: string; file: string; targets: string[]; cause: string };
const wideKey = (l: { grammar: string; file: string }) => `${l.grammar}\t${l.file}`;
const wideText = (l: WideLine) => `${l.grammar}\t${l.file}\t${l.targets.join(',')}\t${l.cause}`;
const wideSeen: WideLine[] = [];
const wideGrammars = new Set<string>();
let wideTargets: string[] = [];
const walkFiles = (d: string, ext: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const f = `${d}/${e.name}`;
  return e.isDirectory() ? walkFiles(f, ext) : e.name.endsWith(ext) ? [f] : [];
});
function wideCorpora(grammar: string): { name: string; files: string[] }[] | string {
  if (!existsSync(TS_CONFORMANCE)) return `the tsc conformance corpus is absent at ${TS_CONFORMANCE} (provision it as CI does: .github/workflows/ci.yml, "Clone the pinned TS corpus")`;
  const out = [{ name: 'tsc conformance', files: walkFiles(TS_CONFORMANCE, '.ts').sort() }];
  if (grammar === 'javascript') {
    if (!TEST262_DIRS.every((d) => existsSync(`${TEST262}/${d}`))) return `the test262 corpus is absent at ${TEST262} (CI: "Clone the pinned test262 corpus")`;
    out.push({ name: 'test262', files: TEST262_DIRS.flatMap((d) => walkFiles(`${TEST262}/${d}`, '.js')).filter((f) => !f.endsWith('_FIXTURE.js')).sort() });
  }
  return out;
}
const wideName = (f: string) => (f.startsWith(TS_CONFORMANCE + '/') ? f.slice(TS_CONFORMANCE.length + 1) : f.slice(TEST262.length + 1));
function wideClass(c: Case, runners: Runner[], oracle: { parse: (src: string) => unknown }): void {
  const corpora = wideCorpora(c.grammar);
  if (typeof corpora === 'string') { console.log(`  ${c.grammar}: wide corpora NOT RUN: ${corpora}`); gate.failures++; return; }
  wideGrammars.add(c.grammar);
  wideTargets = runners.map((r) => r.label);
  for (const { name, files } of corpora) {
    const t0 = Date.now();
    const ms = new Map<string, number>(runners.map((r) => [r.label, 0]));
    const off = new Map<string, number>(runners.map((r) => [r.label, 0]));
    let oracleMs = 0, accepted = 0;
    // The fourth column: the strict interpreter of the recovery option (recovery-family.ts), every
    // rule level interpreted, against the TS target's native parse of the same file (verdict + tree).
    const tsr = runners.find((r) => r.label === 'typescript');
    let interpMs = 0, interpOff = 0;
    for (let i = 0; i < files.length; i += WIDE_CHUNK) {
      const chunk = files.slice(i, i + WIDE_CHUNK);
      const srcs = chunk.map((f) => readFileSync(f, 'utf8'));
      const o0 = Date.now();
      const want = srcs.map((src): { ok: boolean; skel?: string; stack?: boolean } => {
        try { return { ok: true, skel: canon(skelObj(JSON.parse(canon(oracle.parse(src))))) }; } catch (e) { return { ok: false, stack: errText(e).includes('Maximum call stack') }; }
      });
      oracleMs += Date.now() - o0;
      accepted += want.filter((w) => w.ok).length;
      const disagree = chunk.map((): string[] => []);
      let native: ReturnType<Runner['batch']> = [];
      for (const r of runners) {
        const r0 = Date.now();
        const got = r.batch(srcs);
        if (r === tsr) native = got;
        ms.set(r.label, ms.get(r.label)! + Date.now() - r0);
        chunk.forEach((_f, j) => {
          const w = want[j]!, g = got[j]!;
          if (w.stack) return;   // the interpreter's own stack, not a verdict
          if (w.ok !== g.ok || (w.ok && g.ok && w.skel !== canon(skeleton(g.cst)))) { disagree[j]!.push(r.label); off.set(r.label, off.get(r.label)! + 1); }
        });
      }
      if (tsr) {
        const i0 = Date.now();
        const got = tsr.interp(srcs, INTERP_ALL);
        interpMs += Date.now() - i0;
        got.forEach((g, j) => {
          const nat = native[j]!;
          if (g.ok !== nat.ok || (g.ok && g.cst !== nat.cst)) { interpOff++; if (interpOff <= 10) console.log(`      interpreter ≢ the TS target's native parse: ${wideName(chunk[j]!)}`); }
        });
      }
      chunk.forEach((f, j) => {
        if (!disagree[j]!.length) return;
        const file = wideName(f);
        wideSeen.push({ grammar: c.grammar, file, targets: disagree[j]!, cause: wideCause(c.grammar, file, srcs[j]!) });
      });
    }
    console.log(`  ${c.grammar}: wide corpus ${name}: ${files.length} files (${accepted} accepted by the interpreter, ${(oracleMs / 1000).toFixed(1)}s)`);
    for (const r of runners) console.log(`  ${c.grammar}/${r.label}: wide corpus ${name}: ${files.length - off.get(r.label)!}/${files.length} ≡ interpreter (verdict + rule skeleton), ${(ms.get(r.label)! / 1000).toFixed(1)}s`);
    if (tsr) {
      console.log(`  ${c.grammar}/typescript: wide corpus ${name}: the recovery interpreter (forced) ≡ the native parse (verdict + tree) on ${files.length - interpOff}/${files.length}, ${(interpMs / 1000).toFixed(1)}s`);
      gate.failures += interpOff;
    }
      }
}
// The run against the record (see WIDE_RECORD), for the grammars and targets this run covered.
function wideRecordCheck(): void {
  if (!wideGrammars.size) return;
  const record: WideLine[] = existsSync(WIDE_RECORD) ? readFileSync(WIDE_RECORD, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
    const [grammar, file, targets, cause] = l.split('\t');
    return { grammar: grammar!, file: file!, targets: targets!.split(','), cause: cause! };
  }) : [];
  const unknown = wideSeen.filter((l) => !(l.cause in WIDE_CAUSES));
  for (const l of unknown) console.log(`  wide record: no cause class explains ${l.grammar} ${l.file} (${l.targets.join(',')}): add one to WIDE_CAUSES`);
  gate.failures += unknown.length;
  const ran = (l: WideLine): WideLine => ({ ...l, targets: l.targets.filter((t) => wideTargets.includes(t)) });
  const want = new Map(record.filter((l) => wideGrammars.has(l.grammar)).map((l) => [wideKey(l), ran(l)] as const));
  const seen = new Map(wideSeen.map((l) => [wideKey(l), l] as const));
  const moved: string[] = [];
  for (const [k, l] of seen) { const w = want.get(k); if (!w || !w.targets.length) moved.push(`+ ${wideText(l)}`); else if (wideText(w) !== wideText(l)) moved.push(`~ ${wideText(w)}  →  ${wideText(l)}`); }
  for (const [k, w] of want) if (!seen.has(k) && w.targets.length) moved.push(`- ${wideText(w)}`);
  const byCause = new Map<string, number>();
  for (const l of wideSeen) byCause.set(`${l.grammar} ${l.cause}`, (byCause.get(`${l.grammar} ${l.cause}`) ?? 0) + 1);
  console.log(`  wide record: ${wideSeen.length} disagreeing files (${[...byCause].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}); ${moved.length ? `${moved.length} moved against ${WIDE_RECORD.split('/').pop()}` : 'as recorded'}`);
  for (const m of moved.slice(0, 40)) console.log(`      ${m}`);
  if (WIDE_WRITE) {
    if (unknown.length || wideTargets.length < 3) { console.log('  wide record: NOT written (an unknown cause, or not all three targets ran)'); gate.failures++; return; }
    const keep = record.filter((l) => !wideGrammars.has(l.grammar));
    const all = [...keep, ...wideSeen];
    // By class (grammar, cause), each with its count and its cause's text, then its files.
    const groups = new Map<string, WideLine[]>();
    for (const l of all) { const k = `${l.grammar} ${l.cause}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(l); }
    const body = [...groups.keys()].sort().map((k) => {
      const ls = groups.get(k)!;
      return `\n# ${k}: ${ls.length} file${ls.length === 1 ? '' : 's'}: ${WIDE_CAUSES[ls[0]!.cause]}\n${ls.map(wideText).sort().map((l) => `${l}\n`).join('')}`;
    }).join('');
    writeFileSync(WIDE_RECORD, `# GENERATED by node test/portable-wide.ts --write: the files of the wide corpora on which a portable\n# parser is not the interpreter, by class (grammar, cause: WIDE_CAUSES), one line per file: grammar, file, the\n# targets that disagree, cause. Every line is owed as its cause's fix.\n# ${[...groups.keys()].sort().map((k) => `${k} ${groups.get(k)!.length}`).join(', ') || 'none'}\n${body}`);
    console.log(`  wide record: written (${all.length} lines)`);
  } else gate.failures += moved.length;
}


for (const p of await prepareAll(selectedCases().filter((c) => ECMASCRIPT.has(c.grammar)))) wideClass(p.c, p.runners, createParser(p.grammar));
wideRecordCheck();
finish('the wide corpora (every file of the tsc conformance corpus and test262: verdict, rule skeleton)');
