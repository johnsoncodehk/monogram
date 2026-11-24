// Compare the Monogram-CST-lowered AST (test/ts-ast-lowering.ts) against the REAL tsc
// AST, pre-order, node by node, through the oracle harness (test/shape-oracle.ts) in its
// STRUCTURE view: kind (SyntaxKind names, canonicalised: an alias maps to the first name
// the enum declares), start (getStart, trivia-excluded), end, and the child list in
// forEachChild order. On a mismatch the subtree is skipped and counted. GATE semantics: the
// snippet battery (plus parserindenter.ts when the corpus is present) must be
// divergence-free — this is the parser↔tsc STRUCTURE conformance gate (it caught the
// mixfix-LED precedence bug that accept/reject and token-scope gates were blind to).
//
//   node test/ts-ast-verify.ts                  # snippet battery
//   node test/ts-ast-verify.ts <file.ts> [...]  # real files
import { existsSync, readFileSync } from 'node:fs';
import type ts from 'tsc-oracle';
import { createParser } from '../src/gen-parser.ts';
import { lowerProgram, Unlowered, type Ast } from './ts-ast-lowering.ts';
import { objTree } from './obj-tree.ts';
import { compareTrees, structureView, type NTree, type Producer } from './shape-oracle.ts';
import { canonicalKind, normaliseTs, tscProduce } from './shape-oracle-tsc.ts';

// The lowering runs against the INTERPRETER oracle through the object-tree adapter
// (absolute coordinates) — the grammar↔tsc structure contract is engine-independent,
// and the emitted tree's green (relative) coordinates stay the emitted gates' concern.
const grammar = (await import('../typescript.ts')).default;
const parser = createParser(grammar);

// The structure view's root is the statement list: a SourceFile's span includes trailing
// trivia, which a token-span tree has no place for, so the root's span is not compared.
const rootView = (children: NTree[]): NTree => ({ kind: 'SourceFile', start: 0, end: 0, fields: { children } });
// A name SyntaxKind does not have (the lowering's UnknownTypeNode placeholder) stays as
// written: it equals no tsc kind, so it is reported as a kind divergence.
const fromAst = (a: Ast): NTree => ({ kind: canonicalKind(a.kind) ?? a.kind, start: a.pos, end: a.end, fields: { children: a.children.map(fromAst) } });

/** tsc's tree in the structure view (statements only at the root). */
export function tscStructure(sf: ts.SourceFile): NTree {
  return rootView(sf.statements.map((s) => structureView(normaliseTs(s, sf))));
}

/** The tsc oracle in the structure view. Structural contract: VALID files only. When tsc
 * itself reports parse errors, its tree is an error-RECOVERY shape (each parser's recovery
 * strategy is its own) — comparing structures there compares recovery policies. */
export const tscStructureOracle: Producer = (code, path) => tscProduce(code, path, tscStructure);

/** The hand-written lowering as a harness candidate (structure view). */
export const loweringCandidate: Producer = (code) => {
  let rootObj;
  try { rootObj = parser.parse(code); }
  catch (e) { return { fail: `MONOGRAM REJECT ${(e as Error).message.slice(0, 60)}` }; }
  const adapter = objTree(rootObj as never, grammar);
  try { return { tree: rootView(lowerProgram(adapter, adapter.rootId, code).children.map(fromAst)) }; }
  catch (e) {
    if (e instanceof Unlowered) return { fail: `UNLOWERED ${e.what} @${e.at}` };
    return { fail: `LOWER THROW ${(e as Error).message.slice(0, 80)}` };
  }
};

function run(name: string, code: string): { ok: boolean; skipped?: boolean; line: string; samples: string[] } {
  const o = tscStructureOracle(code, 'f.ts');
  if ('skip' in o) return { ok: true, skipped: true, line: `${name}: SKIPPED (${o.skip})`, samples: [] };
  if ('fail' in o) return { ok: false, line: `${name}: ORACLE ${o.fail}`, samples: [] };
  const c = loweringCandidate(code, 'f.ts');
  if (!('tree' in c)) return { ok: false, line: `${name}: ${'fail' in c ? c.fail : c.skip}`, samples: [] };
  const st = compareTrees(o.tree, c.tree);
  const n = (cls: string) => st.divergences.filter((d) => d.cls === cls).length;
  const other = st.divergences.length - n('kind') - n('span') - n('list-length');
  return {
    ok: st.divergences.length === 0,
    line: `${name}: ${st.matched - 1 /* the root wrapper */} matched, ${n('kind')} kind / ${n('span')} span / ${n('list-length')} children mismatches${other ? ` / ${other} other` : ''}`,
    samples: st.divergences.slice(0, 12).map((d) => `${d.cls} at ${d.path} (${d.at}): tsc=${d.expected} mine=${d.got}`),
  };
}

export const SNIPPETS: [string, string][] = [
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
  // The `new` callee is a MemberExpression, and `MemberExpression TemplateLiteral` /
  // `PrimaryExpression : TemplateLiteral` are MemberExpressions: the template belongs to the
  // CALLEE and a following `( )` is the `new` Arguments — `new tag`x`()` is
  // New(TaggedTemplate(tag, `x`), args), never Call(TaggedTemplate(New(tag), `x`)).
  ['new-template-callee', 'new `a${0}b`; new `abc`; new `abc`(1); new `x`.y(1); new `x`[0];'],
  ['new-tagged-callee', 'new tag`x`(); new tag`x`; new a.b`x${y}`(1); new a`x`.b`y`(1); new a[0]`x`(); new (a)`x`();'],
  ['new-tagged-nested', 'new new a`x`()(); new a`x${new b`y`}`(); new a`x`()`y`; new a()`x`; new a`x`().b;'],
  ['unary', '!a; -b; +c; ~d; typeof e; void f; delete g.h; await p; ++i; j--;'],
  ['logical-assign', 'a ||= b; c &&= d; e ??= f;'],
  ['types-basic', 'const a: string = "x"; let b: number[] = []; var c: A | B;'],
  ['as-satisfies', 'const x = y as T; const z = w satisfies U;'],
  ['labeled', 'outer: for (;;) { break; }'],
  ['regex-div', 'const r = /ab+c/g; const q = a / b / c;'],
  ['elem-access', 'a[0] = b["k"];'],
  ['comma-empty', ';;'],
  // `yield [no LineTerminator here] AssignmentExpression` and `using [no LineTerminator here]
  // BindingList`: across a line break `yield` ends (ASI) and `using` is an identifier statement.
  ['no-line-terminator', 'function* g() { yield\n 1; yield *\n 2 }\n{ using\n l = " " }\nasync function f() { await using\n x = y; }'],
];

export const CORPUS_FILES = [
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/RealWorld/parserindenter.ts',
  '/tmp/ts-repo/tests/cases/conformance/fixSignatureCaching.ts',
];
if (import.meta.main) {
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
}
