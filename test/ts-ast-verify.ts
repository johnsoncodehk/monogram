// Compare the Monogram-CST-lowered AST (test/ts-ast-lowering.ts) against the REAL tsc
// AST, pre-order, node by node: kind (compared as ts.SyntaxKind NUMBERS — names are
// looked up forward, dodging enum aliases), start (getStart, trivia-excluded) and end.
// On a mismatch the subtree is skipped and counted. GATE semantics: the snippet battery
// (plus parserindenter.ts when the corpus is present) must be divergence-free — this is
// the parser↔tsc STRUCTURE conformance gate (it caught the mixfix-LED precedence bug
// that accept/reject and token-scope gates were blind to).
//
//   node test/ts-ast-verify.ts                  # snippet battery
//   node test/ts-ast-verify.ts <file.ts> [...]  # real files
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { createParser } from '../src/gen-parser.ts';
import { lowerProgram, Unlowered, type Ast } from './ts-ast-lowering.ts';

const grammar = (await import('../typescript.ts')).default;
const parser = createParser(grammar);

const kindNum = (name: string): number => {
  const v = (ts.SyntaxKind as unknown as Record<string, number>)[name];
  if (v === undefined) throw new Error(`unknown SyntaxKind name: ${name}`);
  return v;
};

interface Stats { matched: number; kindMiss: number; spanMiss: number; childMiss: number; samples: string[] }

function tscChildren(n: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  n.forEachChild((c) => { out.push(c); });
  return out;
}

function compare(mine: Ast, theirs: ts.Node, sf: ts.SourceFile, st: Stats): void {
  const tKind = theirs.kind;
  const tStart = theirs.getStart(sf);
  const tEnd = theirs.end;
  if (kindNum(mine.kind) !== tKind) {
    st.kindMiss++;
    if (st.samples.length < 12) st.samples.push(`kind: mine=${mine.kind} tsc=${ts.SyntaxKind[tKind]} @${tStart}..${tEnd} «${sf.text.slice(tStart, Math.min(tEnd, tStart + 30)).replace(/\n/g, '\\n')}»`);
    return;
  }
  if (mine.pos !== tStart || mine.end !== tEnd) {
    st.spanMiss++;
    if (st.samples.length < 12) st.samples.push(`span: ${mine.kind} mine=${mine.pos}..${mine.end} tsc=${tStart}..${tEnd} «${sf.text.slice(tStart, Math.min(tEnd, tStart + 30)).replace(/\n/g, '\\n')}»`);
    return;
  }
  st.matched++;
  const tc = tscChildren(theirs);
  if (mine.children.length !== tc.length) {
    st.childMiss++;
    if (st.samples.length < 12) st.samples.push(`children: ${mine.kind} mine=[${mine.children.map((c) => c.kind).join(' ')}] tsc=[${tc.map((c) => ts.SyntaxKind[c.kind]).join(' ')}] @${tStart}`);
    return;
  }
  for (let i = 0; i < tc.length; i++) compare(mine.children[i], tc[i], sf, st);
}

function run(name: string, code: string): { ok: boolean; skipped?: boolean; line: string; samples: string[] } {
  // Structural contract: VALID files only. When tsc itself reports parse errors, its
  // tree is an error-RECOVERY shape (each parser's recovery strategy is its own) —
  // comparing structures there compares recovery policies, not the grammar.
  {
    const probe = ts.createSourceFile('f.ts', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS) as ts.SourceFile & { parseDiagnostics: unknown[] };
    if (probe.parseDiagnostics.length > 0) {
      return { ok: true, skipped: true, line: `${name}: SKIPPED (tsc reports ${probe.parseDiagnostics.length} parse error(s) — recovery shapes are out of contract)`, samples: [] };
    }
  }
  let cst;
  try { cst = parser.parse(code); }
  catch (e) { return { ok: false, line: `${name}: MONOGRAM REJECT ${(e as Error).message.slice(0, 60)}`, samples: [] }; }
  let mine: Ast;
  try { mine = lowerProgram(cst, code); }
  catch (e) {
    if (e instanceof Unlowered) return { ok: false, line: `${name}: UNLOWERED ${e.what} @${e.at}`, samples: [] };
    return { ok: false, line: `${name}: LOWER THROW ${(e as Error).message.slice(0, 80)}`, samples: [] };
  }
  const sf = ts.createSourceFile('f.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const st: Stats = { matched: 0, kindMiss: 0, spanMiss: 0, childMiss: 0, samples: [] };
  // SourceFile itself: compare statements list against my root children.
  const tc = sf.statements as readonly ts.Node[];
  if (mine.children.length !== tc.length) {
    return { ok: false, line: `${name}: top-level count mine=${mine.children.length} tsc=${tc.length}`, samples: [] };
  }
  for (let i = 0; i < tc.length; i++) compare(mine.children[i], tc[i], sf, st);
  const miss = st.kindMiss + st.spanMiss + st.childMiss;
  return {
    ok: miss === 0,
    line: `${name}: ${st.matched} matched, ${st.kindMiss} kind / ${st.spanMiss} span / ${st.childMiss} children mismatches`,
    samples: st.samples,
  };
}

const SNIPPETS: [string, string][] = [
  ['var-binary', 'const a = 1 + 2 * b;'],
  ['call', 'f(x, y);'],
  ['member-chain', 'a.b?.c!.d;'],
  ['paren-arrow', '(x) => x + 1;'],
  ['arrow-noparen', 'const f = x => x * 2;'],
  ['arrow-async-bare', 'g(1, async err => { h(err); }); const k = async x => x + 1;'],
  ['arrow-async-paren', 'const p = async (a, b) => a + b;'],
  ['if-else', 'if (a) b(); else { c(); }'],
  ['class', 'class A extends B { m(p: T): U { return p; } }'],
  ['class-members', 'class C { static x = 1; #p: number; get v() { return 1; } constructor(a) {} }'],
  ['function', 'function g(a = 1, ...rest) { return a; }'],
  ['destructure', 'let { a, b: [c] } = o;'],
  ['ternary', 'x = cond ? t : f;'],
  ['for-in', 'for (const k in o) {}'],
  ['for-of', 'for (const v of xs) {}'],
  ['for-classic', 'for (let i = 0; i < n; i++) { f(i); }'],
  ['while-do', 'while (a) { b(); } do { c(); } while (d);'],
  ['try', 'try { f(); } catch (e) { g(e); } finally { h(); }'],
  ['try-finally-only', 'try { f(); } finally { h(); }'],
  ['try-catch-pattern', 'try { f(); } catch ({ message }) { g(message); }'],
  ['switch', 'switch (x) { case 1: f(); break; default: g(); }'],
  ['object', 'const o = { a, b: 1, "c": 2, [k]: 3, m() { return 1; } };'],
  ['array-spread', 'const xs = [1, , 2, ...rest];'],
  ['template', 'const s = `a ${x + 1} b ${y} c`;'],
  ['tagged-template', 'tag`v=${v}`;'],
  ['new', 'const i = new C(a, b); const j = new D;'],
  ['unary', '!a; -b; +c; ~d; typeof e; void f; delete g.h; await p; ++i; j--;'],
  ['logical-assign', 'a ||= b; c &&= d; e ??= f;'],
  ['types-basic', 'const a: string = "x"; let b: number[] = []; var c: A | B;'],
  ['as-satisfies', 'const x = y as T; const z = w satisfies U;'],
  ['labeled', 'outer: for (;;) { break; }'],
  ['regex-div', 'const r = /ab+c/g; const q = a / b / c;'],
  ['elem-access', 'a[0] = b["k"];'],
  ['comma-empty', ';;'],
];

const CORPUS_FILES = [
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserindenter.ts',
  '/tmp/ts-repo/tests/cases/conformance/fixSignatureCaching.ts',
];
const files = process.argv.slice(2);
let pass = 0, fail = 0;
if (files.length > 0) {
  for (const f of files) {
    const code = readFileSync(f, 'utf-8');
    const r = run(f.split('/').pop()!, code);
    console.log((r.ok ? '✓ ' : '✗ ') + r.line);
    for (const s of r.samples) console.log('    ', s);
    r.ok ? pass++ : fail++;
  }
} else {
  for (const [name, code] of SNIPPETS) {
    const r = run(name, code);
    console.log((r.ok ? '✓ ' : '✗ ') + r.line);
    for (const s of r.samples) console.log('    ', s);
    r.ok ? pass++ : fail++;
  }
  for (const cf of CORPUS_FILES) {
    if (!existsSync(cf)) continue;
    const r = run(cf.split('/').pop()!, readFileSync(cf, 'utf-8'));
    console.log((r.ok ? '✓ ' : '✗ ') + r.line);
    for (const s of r.samples) console.log('    ', s);
    r.ok ? pass++ : fail++;
  }
}
console.log(`\n${pass} clean, ${fail} with divergences`);
if (fail > 0) {
  console.error('✗ lowered AST diverges from tsc');
  process.exit(1);
}
console.log('✓ lowered AST ≡ tsc node-by-node');
