// emit-corpus.ts — the IN-REPO TypeScript corpus for the three engine-parity gates
// (emit-parser-verify / emit-reject-messages / emit-lexer-verify).
//
// The parity gates only need the two engines to AGREE — accept-identically (and produce
// the byte-identical CST / token stream) or reject-identically (same error message). A
// file BOTH engines reject is therefore a perfectly valid parity sample. That frees the
// gate from any external corpus: it runs on
//
//   1) a curated set of TS snippets covering every production class (small, stable, so the
//      gate exercises constructs the repo sources happen not to use), and
//   2) the repo's OWN hand-written .ts sources (src/** + the root grammar models) — large,
//      diverse, real-world TypeScript with zero vendoring and no license question.
//
// This is what makes the parity check CORPUS-FREE, so it runs in `npm run check` on every
// machine and every CI run — the mechanism that forces a gen-parser change to propagate to
// emit-parser (issue #45 A2/A4). When the optional /tmp/ts-repo corpus is also present the
// gates additionally sweep it for breadth; absent, that sweep is silently skipped (the same
// pattern js-conformance.ts uses for its TS-conformance corpus).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 1) Curated construct-coverage snippets ──────────────────────────────────────────────
// One per line of grammar surface; deliberately broad so a regression in any production
// shows even when the repo sources don't happen to use it.
export const CURATED_TS: string[] = [
  // — literals & declarations —
  `const x = 1, y = 2.5, z = 0xff, b = 0b101, o = 0o17, n = 10n, big = 1_000_000;`,
  `let s = "a", t = 'b', u = \`c\${x}d\`, r = /ab+c/giu;`,
  `var obj = { a: 1, b, c() {}, get d() { return 1; }, set d(v) {}, [k]: 2, ...rest };`,
  `const arr = [1, , 3, ...more];`,
  `const tpl = tag\`a\${b + 1}c\${d}e\`, nested = \`x\${\`y\${z}\`}w\`;`,
  // — destructuring —
  `const { a, b: c, d = 1, ...rest } = obj;`,
  `const [p, , q, ...zz] = arr;`,
  `function fd({ a, b: [c, d] }, [e, { g }]) {}`,
  // — functions & arrows —
  `function f(a, b = 1, ...rest) { return a + b; }`,
  `const g = (a) => a * 2, h = async (a, b) => { return await a + b; }, i = x => y => x + y;`,
  `function* gen() { yield 1; yield* other(); }`,
  `async function* ag() { for await (const x of xs) yield x; }`,
  // — classes —
  `class C extends B { #x = 1; static y = 2; static { this.z = 3; } constructor() { super(); } get p() { return this.#x; } set p(v) { this.#x = v; } async *m() {} static async sm() {} accessor a = 1; #priv() {} }`,
  `class D { ['computed']() {} 123() {} "str"() {} }`,
  `@dec class E {}`,
  `@dec(args) class F { @m method() {} @field x = 1; }`,
  // — operators & expressions —
  `const e = a ?? b ?? c, f2 = a?.b?.c?.(), g2 = a?.[b]?.(c), h2 = a ** b ** c;`,
  `x ??= y; x ||= y; x &&= y; x **= 2; a |= b; a &= b; a ^= c; a <<= 1; a >>>= 2;`,
  `const cond = a ? b : c ? d : e, cmp = a < b === c > d, seq = (a, b, c);`,
  `delete obj.x; typeof x; void 0; !x; ~y; +z; -w; a in obj; a instanceof Y;`,
  `new Foo(); new Foo(1, 2); new foo.Bar(); new.target; import.meta.url;`,
  `(function () {})(); (() => {})(); (class {});`,
  // — control flow —
  `if (a) b(); else if (c) d(); else e();`,
  `for (let i = 0; i < 10; i++) {} for (const x of xs) {} for (const k in obj) {}`,
  `while (x) {} do {} while (x);`,
  `switch (x) { case 1: case 2: f(); break; default: g(); }`,
  `try { f(); } catch (e) { g(); } finally { h(); } try {} catch {}`,
  `label: for (;;) { break label; continue label; }`,
  `function w() { return; throw new Error("x"); }`,
  `with (obj) { x; } debugger; using r = getResource();`,
  // — modules —
  `import X from "m"; import { a, b as c } from "m"; import X, * as ns from "m"; import "m";`,
  `export const xx = 1; export default function () {} export default 42; export { a, b as c };`,
  `export { a } from "m"; export * from "m"; export * as ns from "m";`,
  // — TypeScript: type annotations & aliases —
  `const a1: number = 1; let s1: string; const f3: (x: number) => string = String;`,
  `type Alias = { a: number; b?: string; readonly c: boolean; [k: string]: unknown };`,
  `type Union = "a" | "b" | "c"; type Inter = A & B & C; type Tup = [number, string?, ...boolean[]];`,
  `type Fn = <T>(x: T) => T; type Ctor = new (x: number) => Foo; type Idx = Obj["key"];`,
  // — TS: generics, constraints, defaults, variance —
  `function gen2<T, U extends T = T>(x: T, y: U): [T, U] { return [x, y]; }`,
  `class Box<in out T> { value!: T; }`,
  `interface I<T = unknown> extends A<T>, B { method<U>(x: U): T; }`,
  // — TS: advanced types —
  `type Cond<T> = T extends string ? "s" : T extends number ? "n" : "o";`,
  `type Infer<T> = T extends Array<infer E> ? E : never;`,
  `type Mapped<T> = { readonly [K in keyof T]?: T[K] };`,
  `type Remap<T> = { [K in keyof T as \`get\${string & K}\`]: () => T[K] };`,
  `type TLit = \`\${number}px\` | \`\${number}%\`;`,
  `type KeyOf = keyof typeof obj; type Q = A.B.C<number>;`,
  // — TS: assertions, predicates, modifiers —
  `const c1 = x as const, c2 = y as number, c3 = <T>z, c4 = w satisfies Foo;`,
  `function isStr(x: unknown): x is string { return typeof x === "string"; }`,
  `function assert(x: unknown): asserts x is Foo {}`,
  `const nn = maybe!; const chain = a!.b!.c;`,
  // — TS: enums, namespaces, ambient, overloads —
  `enum E { A, B = 2, C } const enum CE { X, Y }`,
  `namespace N { export const v = 1; export namespace M { export type T = number; } }`,
  `declare const g3: number; declare function h3(x: number): void; declare module "m" { const v: number; }`,
  `function ov(x: number): number; function ov(x: string): string; function ov(x: any): any { return x; }`,
  `abstract class AC { abstract m(): void; protected readonly p = 1; private q?: string; }`,
  `class PP { constructor(public readonly a: number, private b: string) {} }`,
  `import type { T } from "m"; import { type U, value } from "m"; export type { T };`,
  // — non-ASCII whitespace + chars (exercises the lexer's cc>127 dispatch) —
  `const a =  1; const b = 2;`,           // U+00A0 nbsp, U+2003 em-space between tokens
  `const c = 3; const d = 4; const e = 5;`,    // U+2028 / U+2029 line separators
  `const sigma = α + β; const n = "café — naïve ≡ x";`, // non-ASCII identifiers + string/punct
];

// ── 1b) Deliberately malformed snippets ─────────────────────────────────────────────────
// Syntax errors BOTH engines must reject WITH THE SAME error message — the coverage
// emit-reject-messages.ts needs (the repo sources and valid snippets are all accepted, so
// without these the message-parity gate would have nothing to compare). Each exercises a
// distinct error path (unexpected token, missing operand, unterminated construct, …) so a
// drift in the farthest-position / SECOND-set error machinery surfaces here.
export const CURATED_TS_INVALID: string[] = [
  `const x = ;`,
  `function f(a,,b) {}`,
  `function (a) {}`,
  `if (x {}`,
  `for (;;`,
  `const a = 1 +;`,
  `throw;`,
  `const o2 = { a: 1 b: 2 };`,
  `const { a: } = obj;`,
  `const [ , , ] = ;`,
  `a ? b ;`,
  `import { a from "m";`,
  `do x; while;`,
  `type T = { a: };`,
  `a = = b;`,
  `const o = { ...,  };`,
  `x => => y;`,
  `switch (x) { case: break; }`,
  `try { } catch (e: ) {}`,
  `enum { A, B }`,
  `const t = \`a\${}b\`;`,
  `1 instanceof;`,
  `new;`,
  `a.;`,
  `(a, , b)`,
];

// ── 2) The repo's own hand-written .ts sources ──────────────────────────────────────────
// Excludes generated artifacts (*.cst-match.ts) and caps file size so the gate stays fast
// (the byte-identical CST compare is O(tree size); a 250 KB cap keeps the rich, deeply-
// nested sources like emit-parser.ts while dropping the multi-hundred-KB ones).
const SIZE_CAP = 250 * 1024;
const isGenerated = (f: string) => f.endsWith('.cst-match.ts') || f.endsWith('.d.ts');

export function repoTsFiles(): string[] {
  const out: string[] = [];
  const take = (full: string, name: string) => {
    if (!name.endsWith('.ts') || isGenerated(name)) return;
    try { if (statSync(full).size <= SIZE_CAP) out.push(full); } catch { /* ignore */ }
  };
  for (const f of readdirSync(ROOT)) take(join(ROOT, f), f);              // root grammar models
  for (const f of readdirSync(join(ROOT, 'src'))) take(join(ROOT, 'src', f), f);  // src/**
  return out.sort();
}

/** The full in-repo parity corpus as { name, code } — curated snippets + repo sources. */
export function inRepoCorpus(): { name: string; code: string }[] {
  const out = [
    ...CURATED_TS.map((code, i) => ({ name: `curated#${i}`, code })),
    ...CURATED_TS_INVALID.map((code, i) => ({ name: `invalid#${i}`, code })),
  ];
  for (const f of repoTsFiles()) {
    try { out.push({ name: f.slice(ROOT.length + 1), code: readFileSync(f, 'utf8') }); } catch { /* ignore */ }
  }
  return out;
}

/** Optional external corpus (/tmp/ts-repo) for breadth — empty when absent. */
export function externalTsFiles(base = '/tmp/ts-repo/tests/cases'): string[] {
  try { statSync(base); } catch { return []; }
  const out: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
    }
  })(base);
  return out.sort();
}
