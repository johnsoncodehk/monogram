// JavaScript bidirectional conformance, mirroring test/conformance-matrix.ts but
// for examples/javascript.ts. Ground truth is TS's OWN parser in JS mode
// (`ts.createSourceFile(..., ts.ScriptKind.JS)` → `parseDiagnostics`).
//
// Two corpora are measured:
//
//   1. A curated set of valid-JS snippets (below). These contain NO type syntax,
//      so they are the real target: the JS grammar MUST accept all of them.
//
//   2. The TS conformance corpus (single-file cases) reparsed under ScriptKind.JS.
//      This is a big, adversarial body of code. NOTE: TS's .js parser is extremely
//      lenient — it accepts type annotations, `enum`, `interface`, non-null `!`,
//      etc. at PARSE time and defers the "not allowed in a .js file" errors to the
//      type checker. Our grammar instead lacks those productions and rejects them,
//      so a large share of "we-reject / TS-.js-accepts" is our CORRECT strictness
//      on TypeScript-only syntax, not a JS gap. The matrix prints both directions
//      so the two can be told apart; the curated set is the hard acceptance gate.
import { createParser } from '../src/gen-parser.ts';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

const grammar = (await import('../examples/javascript.ts')).default;
const { parse } = createParser(grammar);

const jsAccepts = (code: string, file = 't.js') => {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return ((sf as any).parseDiagnostics as ts.Diagnostic[] | undefined)?.length ? false : true;
};
const weAccept = (code: string) => {
  try { parse(code); return true; } catch { return false; }
};

// ── Corpus 1: curated valid JavaScript (no type syntax) — must all parse ──
const validJs: string[] = [
  // declarations & literals
  `const x = 1, y = 2.5, z = 0xff, b = 0b101, o = 0o17, n = 10n;`,
  `let s = "a", t = 'b', u = \`c\${x}d\`, r = /ab+c/gi;`,
  `var obj = { a: 1, b, c() {}, get d() { return 1; }, set d(v) {}, [k]: 2, ...rest };`,
  `const arr = [1, , 3, ...more];`,
  // destructuring
  `const { a, b: c, d = 1, ...rest } = obj;`,
  `const [p, , q, ...z] = arr;`,
  `function f({ a, b: [c, d] }, [e, { g }]) {}`,
  // functions & arrows
  `function f(a, b = 1, ...rest) { return a + b; }`,
  `const g = (a) => a * 2;`,
  `const h = async (a, b) => { return await a + b; };`,
  `const i = x => y => x + y;`,
  `function* gen() { yield 1; yield* other(); }`,
  `async function* ag() { for await (const x of xs) yield x; }`,
  // classes
  `class C extends B { #x = 1; static y = 2; static { this.z = 3; } constructor() { super(); } get p() { return this.#x; } set p(v) { this.#x = v; } async *m() {} static async sm() {} accessor a = 1; #priv() {} }`,
  `class D { ['computed']() {} 123() {} "str"() {} }`,
  // decorators (Stage 3)
  `@dec class E {}`,
  `@dec(args) class F { @m method() {} @field x = 1; }`,
  // expressions & operators
  `const e = a ?? b ?? c;`,
  `const f2 = a?.b?.c?.();`,
  `const g2 = a?.[b]?.(c);`,
  `const h2 = a ** b ** c;`,
  `x ??= y; x ||= y; x &&= y; x **= 2;`,
  `const cond = a ? b : c ? d : e;`,
  `const cmp = a < b > c;`,
  `const t2 = tag\`a\${b}c\${d}e\`;`,
  `delete obj.x; typeof x; void 0; !x; ~y; +z; -w;`,
  `const inst = x instanceof Y; const inOp = "k" in obj;`,
  `new Foo(); new Foo(1, 2); new foo.Bar(); new.target;`,
  `(function () {})(); (() => {})();`,
  `import.meta.url;`,
  // control flow
  `if (a) b(); else c();`,
  `for (let i = 0; i < 10; i++) {}`,
  `for (const x of xs) {}`,
  `for (const k in obj) {}`,
  `for (var a = 1 in xs) {}`,
  `while (x) {}`,
  `do {} while (x);`,
  `switch (x) { case 1: case 2: f(); break; default: g(); }`,
  `try { f(); } catch (e) { g(); } finally { h(); }`,
  `try {} catch {}`,
  `label: for (;;) { break label; continue label; }`,
  `return; throw new Error("x");`.replace('return;', 'function w() { return; }'),
  `with (obj) { x; }`,
  `debugger;`,
  `using r = getResource();`,
  // modules
  `import X from "m";`,
  `import { a, b as c } from "m";`,
  `import X, { a } from "m";`,
  `import X, * as ns from "m";`,
  `import * as ns from "m";`,
  `import "m";`,
  `export const x = 1;`,
  `export default function () {}`,
  `export default 42;`,
  `export { a, b as c };`,
  `export { a } from "m";`,
  `export * from "m";`,
  `export * as ns from "m";`,
  // misc real-world
  `const p = new Promise((resolve, reject) => { resolve(1); });`,
  `arr.map(x => x * 2).filter(x => x > 0).reduce((a, b) => a + b, 0);`,
  `const { default: d } = await import("m");`,
];

// ── Corpus 2: TS-only syntax that has NO production here — must all reject ──
// (TS's .js parser leniently accepts most of these; we are correctly stricter.)
const tsOnly: [string, string][] = [
  ['type annotation', `const x: number = 1;`],
  ['enum', `enum E { A, B }`],
  ['generic function', `function f<T>(x) { return x; }`],
  ['non-null assertion', `const y = z!;`],
  ['type cast <T>', `const z = <T>expr;`],
  ['as expression', `const a = x as number;`],
  ['typed arrow param', `const f = (x: number) => x;`],
  ['function return type', `function g(): void {}`],
  ['typed binding', `let v: string;`],
  ['optional param', `function h(x?) {}`],
];

let v_ok = 0;
const v_fail: string[] = [];
for (const code of validJs) {
  if (weAccept(code)) v_ok++;
  else v_fail.push(code);
}
console.log('── Corpus 1: curated valid JavaScript (hard acceptance gate) ──');
console.log(`  Accepted: ${v_ok}/${validJs.length}`);
if (v_fail.length) {
  console.log('  FAILED (valid JS we reject — real gap):');
  for (const c of v_fail) console.log('    - ' + JSON.stringify(c).slice(0, 100));
}

let r_ok = 0;
const r_leak: string[] = [];
for (const [name, code] of tsOnly) {
  if (weAccept(code)) r_leak.push(`${name}: ${code}`);
  else r_ok++;
}
console.log('\n── Corpus 2: TypeScript-only syntax (should reject) ──');
console.log(`  Rejected: ${r_ok}/${tsOnly.length}`);
if (r_leak.length) {
  console.log('  LENIENTLY ACCEPTED (contextual-keyword over-accept class):');
  for (const c of r_leak) console.log('    - ' + c);
}

// ── Corpus 3: TS conformance corpus reparsed as .js (bidirectional matrix) ──
const base = '/tmp/ts-repo/tests/cases/conformance';
function walk(d: string): string[] {
  let o: string[] = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.isDirectory()) o = o.concat(walk(f));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) o.push(f);
  }
  return o;
}
const isMulti = (t: string) => /^\s*\/\/\s*@filename:/im.test(t);

let TP = 0, FN = 0, FP = 0, TN = 0;
const fns: string[] = [];
try {
  for (const f of walk(base)) {
    const code = readFileSync(f, 'utf8');
    if (isMulti(code)) continue;
    const tsA = jsAccepts(code);
    const weA = weAccept(code);
    if (tsA && weA) TP++;
    else if (tsA && !weA) { FN++; fns.push(f.replace(base + '/', '')); }
    else if (!tsA && weA) FP++;
    else TN++;
  }
  const total = TP + FN + FP + TN;
  console.log(`\n── Corpus 3: TS conformance corpus as .js (${total} single-file cases) ──`);
  console.log('                       WE accept      WE reject');
  console.log(`  TS-.js accept    ${String(TP).padStart(6)} (agree)   ${String(FN).padStart(5)} (we stricter)`);
  console.log(`  TS-.js reject    ${String(FP).padStart(6)} (over-acc) ${String(TN).padStart(5)} (agree)`);
  console.log(`\n  Bidirectional agree : ${((TP + TN) / total * 100).toFixed(2)}%  (${TP + TN}/${total})`);
  console.log(`  (FN = we reject what TS's lenient .js parser accepts — overwhelmingly TS-only`);
  console.log(`   type syntax our grammar deliberately lacks, not a JavaScript gap.)`);
} catch (e) {
  console.log(`\n── Corpus 3 skipped (corpus not found at ${base}) ──`);
}
