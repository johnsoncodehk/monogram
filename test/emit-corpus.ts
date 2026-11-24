// emit-corpus.ts — the IN-REPO TypeScript corpus for the three engine-parity gates
// (target-js-verify / emit-reject-messages / emit-lexer-verify).
//
// The parity gates only need the two engines to AGREE — accept-identically (and produce
// the byte-identical CST / token stream) or reject-identically (same error message). A
// file BOTH engines reject is therefore a perfectly valid parity sample. That frees the
// gate from any external corpus: it runs on
//
//   1) a curated set of TS snippets covering every production class (small, stable, so the
//      gate exercises constructs the repo sources happen not to use), and
//   2) the repo's OWN hand-written .ts sources (src/*.ts + the root grammar models, as of the pinned commit REPO_CORPUS_AT) — large,
//      diverse, real-world TypeScript with zero vendoring and no license question.
//
// This is what makes the parity check CORPUS-FREE, so it runs in `npm run check` on every
// machine and every CI run — the mechanism that forces a interpreter change to propagate to
// target-js (issue #45 A2/A4). When the optional /tmp/ts-repo corpus is also present the
// gates additionally sweep it for breadth; absent, that sweep is skipped.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FETCH_HINT, haveCorpusCommit, REPO_CORPUS_AT } from './corpus-pin.ts';

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
  `new \`a\${0}b\`; new \`abc\`(1); new tag\`x\${y + 1}\`(); new a.b\`x\`(1); new \`x\`.y(); new a\`x\`.b\`y\`(1); new new a\`x\`()();`,
  `(function () {})(); (() => {})(); (class {});`,
  // — restricted productions: a line break before `++`/`--` ends the operand (ASI) —
  `x\n++\ny; a = b\n--c\nd ++\n++\ne; f()\n++\ng.h; i /* c */ ++; j // c\n++\nk;`,
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

// ── 1a) Valid snippets for the CST gates only ───────────────────────────────────────────
// Parsed by the interpreter-vs-emitted parity gates like CURATED_TS, but kept out of it:
// CURATED_TS also seeds the ESTree shape corpora (shape-parity / shape-rust), and the
// hand-written Rust ESTree customs have no schema for these — their `$template` schema is one
// `Type` hole between a head and a tail, and a type alias binds only a `Type` kid, so a
// template-literal type with several holes, or standing alone as an annotation, has no Rust
// tree to compare. The portable Rust parser itself is covered by portable-targets.
export const CURATED_TS_CST: string[] = [
  // a template's holes are parsed by the rule its reference declares: types in a
  // template-literal type, expressions in a template-literal expression, at any nesting
  `type TL = \`a\${T[]}b\${A | B}\`; const tl = \`a\${y as \`b\${T[]}\`}c\`; new \`x\${y as T[]}\`;`,
  // The dimensions of each flattened-alternative family (formerly test/refactor-guard.ts): every
  // combination of the optional parts must still parse after a grammar de-duplication. Kept out
  // of CURATED_TS: in the shape corpora the Rust ESTree customs build a different tree for some of
  // them (an arrow's return type as its body, `<const A>` as a parameter named `const`), and in the
  // portable recovery mutation corpus one mutant of the `types` row is accepted by the interpreter
  // and rejected by every portable target (both reported, not fixed here).
  // arrow functions (async? typeParams? returnType?)
  `(x) => x; (x): number => x; async (x) => x; async (x): number => x; <T>(x: T) => x; <T>(x: T): T => x; async <T>(x: T) => x; async <T>(x: T): T => x; (x) => { return x; }; x => x;`,
  // function expressions
  `var a = function () {}; var a = function f() {}; var a = function* () {}; var a = function* f() {}; var a = async function () {}; var a = async function* f() {}; var a = function f<T>(x: T) {};`,
  // function declarations
  `function f() {} function* f() {} async function f() {} async function* f() {} function f(); function f<T>(x: T): T {}`,
  // constructor types
  `type C = new () => X; type C = new <T>() => X; type C = abstract new () => X; type C = abstract new <T>() => X;`,
  // class expressions (anon + extends: an optional name must NOT eat `extends`)
  `var a = class C {}; var a = class {}; var a = class C extends B {}; var a = class C implements I {}; var a = class extends B {}; var a = class implements I {}; var a = @dec class C {}; var a = new class {}; var a = new class {}(); var a = new class C extends B {}();`,
  // type parameters: modifiers, and names that look like modifiers (`out` is a contextual name;
  // `in` is reserved, so `<in = any>` is a tsc parse error, dd789de)
  `type T<A> = A; type T<A extends B> = A; type T<A extends B = C> = A; type T<A = B> = A; type T<const A> = A; type T<in A> = A; type T<out A> = A; type T<in out A> = A; type T<out A extends B> = A; type T<out> = out; interface I<out = any> {}`,
  // declarations
  `class C {} abstract class C {} @d class C {} @d abstract class C extends B {} declare function f(): void; declare function* f(): void; export default function f() {} export default async function f() {} export default abstract class C {} module "m" {} module M {} export { a, b }; export type { A }; export type { A } from "m";`,
  // parameters (Ident / BindingPattern / rest, with ?/:type/=default dimensions)
  `function f(a) {} function f(a: T) {} function f(a?) {} function f(a?: T) {} function f(a?: T = x) {} function f(a = 1) {} function f(a: T = 1) {} function f(a? = 1) {} function f(...a) {} function f(...a: T[]) {} function f(this: T) {} class C { constructor(public a: T) {} } class C { constructor(public readonly a: T) {} } function f({ a, b }) {} function f({ a }: T) {} function f({ a } = {}) {} function f(...{ a }) {} class C { m(@d a: T) {} } function f(a: T, b?: U, ...c: V[]) {}`,
  // types
  `type F = (a: T) => R; type F = <T>(a: T) => R; function f(x): asserts x {} function f(x): asserts x is T {} type X<T> = T extends infer U ? U : never; type X<T> = T extends infer U extends string ? U : never; type X<T> = T extends (infer U extends number ? 1 : 0) ? U : never; type C = new <T>(a: T) => R;`,
  // class members (fields NAMED `static` / `get`, a method NAMED `async`)
  `class C { x: T = 1; } class C { public static readonly x = 1; } class C { m() {} } class C { public static async m() {} } class C { *m() {} } class C { m<T>(a: T): T { return a; } } class C { m(): void; } class C { get x() { return 1; } } class C { set x(v) {} } class C { public static get x() { return 1; } } class C { get x(): T; } class C { constructor() {} } class C { [k: string]: T; } class C { static {} } class C { static = 1; } class C { get = 1; } class C { async() {} } class C { @d m() {} }`,
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
  `x\n++\n++\ny;`,
  `(x\n++);`,
  `var z =\nx\n--\n--y;`,
  `x /*\n*/ ++;`,
];

// ── 2) The repo's own sources, PINNED ───────────────────────────────────────────────────
// The hand-written .ts sources (src/*.ts + the root grammar models) as they were at ONE commit,
// read from git's objects, not from the working tree. Pinned so that the corpus is an input that
// does not move with every commit: read live, every src change was an input of every gate that
// imports this module (`node test/check.ts --changed` ran five of them for any printer change),
// and the corpus itself changed under the gates. What pinning gives up: new code in src/ is not
// parsed by these gates until the pin moves; new SYNTAX is the conformance corpora's job (test262,
// the tsc corpus, the curated lists above), not this one's. Move the pin (any commit of master)
// when the corpus should see newer sources; the gates' counts in their output change then.
// The pin and its fetch live in test/corpus-pin.ts: the commit is fetched once, before any gate
// runs (CI's workflow, test/check.ts); a gate that finds it missing fails (no silent empty corpus,
// and no fetch racing another gate's).
export { REPO_CORPUS_AT };
const git = (args: string[], input?: string): Buffer => execFileSync('git', ['-C', ROOT, ...args], { input, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] });
function corpusCommit(): string {
  if (!haveCorpusCommit()) throw new Error(`emit-corpus: ${FETCH_HINT}`);
  return REPO_CORPUS_AT;
}

// (the byte-identical CST compare is O(tree size); a 250 KB cap keeps the rich, deeply-
// nested sources like target-js.ts while dropping the multi-hundred-KB ones).
const SIZE_CAP = 250 * 1024;
const GENERATED = /\.cst-match\.ts$|\.d\.ts$/;

/** The pinned corpus's files: path at the commit and blob id (root *.ts and src/*.ts, generated ones and those above the cap left out). */
export function repoTsFiles(): { name: string; blob: string }[] {
  const at = corpusCommit();
  const out: { name: string; blob: string }[] = [];
  // (the directory is spelled `dir` + '/' so that test/gate-deps.ts does not read a literal 'src/'
  // as "this gate reads every file under src/": the point of the pin)
  const dir = 'src';
  for (const [tree, prefix] of [[at, ''], [`${at}:${dir}`, dir + '/']] as const) {
    for (const line of git(['ls-tree', '-l', tree]).toString('utf8').split('\n')) {
      // <mode> blob <id> <size>\t<name>
      const m = /^\d+ blob ([0-9a-f]+) +(\d+)\t(.+)$/.exec(line);
      if (!m || !/\.ts$/.test(m[3]!) || GENERATED.test(m[3]!) || +m[2]! > SIZE_CAP) continue;
      out.push({ name: prefix + m[3], blob: m[1]! });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The full in-repo parity corpus as { name, code } — curated snippets + the pinned repo sources. */
export function inRepoCorpus(): { name: string; code: string }[] {
  const out = [
    ...CURATED_TS.map((code, i) => ({ name: `curated#${i}`, code })),
    ...CURATED_TS_CST.map((code, i) => ({ name: `cst#${i}`, code })),
    ...CURATED_TS_INVALID.map((code, i) => ({ name: `invalid#${i}`, code })),
  ];
  const files = repoTsFiles();
  // one `git cat-file --batch` for every blob: `<id> blob <size>\n<bytes>\n` per entry
  const buf = git(['cat-file', '--batch'], files.map((f) => f.blob).join('\n') + '\n');
  let at = 0;
  for (const f of files) {
    const nl = buf.indexOf(10, at);
    const size = +buf.subarray(at, nl).toString('latin1').split(' ')[2]!;
    out.push({ name: f.name, code: buf.subarray(nl + 1, nl + 1 + size).toString('utf8') });
    at = nl + 1 + size + 1;
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
