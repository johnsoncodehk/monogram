// Behavior-guard for grammar de-duplication: every construct whose flattened
// alternatives we intend to collapse must still parse (and the negative cases
// must still fail). Run before/after each collapse — the conformance suite
// doesn't cover all of these edge combinations.
import { createParser } from '../src/gen-parser.ts';
const grammar = (await import('../typescript.ts')).default;
const { parse } = createParser(grammar);

const should = {
  // arrow functions (async? typeParams? returnType?)
  'arrow plain': '(x) => x;',
  'arrow ret': '(x): number => x;',
  'arrow async': 'async (x) => x;',
  'arrow async ret': 'async (x): number => x;',
  'arrow generic': '<T>(x: T) => x;',
  'arrow generic ret': '<T>(x: T): T => x;',
  'arrow async generic': 'async <T>(x: T) => x;',
  'arrow async generic ret': 'async <T>(x: T): T => x;',
  'arrow block body': '(x) => { return x; };',
  'arrow ident param': 'x => x;',
  // function expressions
  'fnexpr anon': 'var a = function () {};',
  'fnexpr named': 'var a = function f() {};',
  'fnexpr gen': 'var a = function* () {};',
  'fnexpr gen named': 'var a = function* f() {};',
  'fnexpr async': 'var a = async function () {};',
  'fnexpr async gen named': 'var a = async function* f() {};',
  'fnexpr generic': 'var a = function f<T>(x: T) {};',
  // function declarations
  'fndecl': 'function f() {}',
  'fndecl gen': 'function* f() {}',
  'fndecl async': 'async function f() {}',
  'fndecl async gen': 'async function* f() {}',
  'fndecl overload': 'function f();',
  'fndecl generic ret': 'function f<T>(x: T): T {}',
  // constructor types
  'ctortype': 'type C = new () => X;',
  'ctortype generic': 'type C = new <T>() => X;',
  'ctortype abstract': 'type C = abstract new () => X;',
  'ctortype abstract generic': 'type C = abstract new <T>() => X;',
  // class expressions
  'classexpr named': 'var a = class C {};',
  'classexpr anon': 'var a = class {};',
  'classexpr extends': 'var a = class C extends B {};',
  'classexpr impl': 'var a = class C implements I {};',
  'classexpr anon extends': 'var a = class extends B {};',     // anon + extends: opt(Ident) must NOT eat `extends`
  'classexpr anon impl': 'var a = class implements I {};',
  'classexpr decorated': 'var a = @dec class C {};',
  'newclass anon': 'var a = new class {};',
  'newclass anon call': 'var a = new class {}();',
  'newclass named extends': 'var a = new class C extends B {}();',
  // type parameters (modifiers + names that look like modifiers)
  'tp plain': 'type T<A> = A;',
  'tp extends': 'type T<A extends B> = A;',
  'tp extends default': 'type T<A extends B = C> = A;',
  'tp default': 'type T<A = B> = A;',
  'tp const': 'type T<const A> = A;',
  'tp in': 'type T<in A> = A;',
  'tp out': 'type T<out A> = A;',
  'tp in out': 'type T<in out A> = A;',
  'tp out extends': 'type T<out A extends B> = A;',
  'tp name-out': 'type T<out> = out;',      // `out` as the param NAME, not modifier
  'tp name-in default': 'interface I<in = any> {}',
  // declarations
  'decl class': 'class C {}',
  'decl abstract class': 'abstract class C {}',
  'decl decorated class': '@d class C {}',
  'decl decorated abstract class': '@d abstract class C extends B {}',
  'decl fn': 'function f() {}',
  'decl fn gen': 'function* f() {}',
  'decl async fn gen': 'async function* f() {}',
  'declare fn': 'declare function f(): void;',
  'declare fn gen': 'declare function* f(): void;',
  'export default fn': 'export default function () {}',
  'export default fn named': 'export default function f() {}',
  'export default async fn': 'export default async function f() {}',
  'export default abstract class': 'export default abstract class C {}',
  'module string': 'module "m" {}',
  'module ident': 'module M {}',
  'export braces': 'export { a, b };',
  'export braces from': 'export { a } from "m";',
  'export type braces': 'export type { A };',
  'export type braces from': 'export type { A } from "m";',
  // parameters (Ident / BindingPattern / rest, with ?/:type/=default dimensions)
  'param bare': 'function f(a) {}',
  'param type': 'function f(a: T) {}',
  'param opt': 'function f(a?) {}',
  'param opt type': 'function f(a?: T) {}',
  'param opt type default': 'function f(a?: T = x) {}',
  'param default': 'function f(a = 1) {}',
  'param type default': 'function f(a: T = 1) {}',
  'param opt default': 'function f(a? = 1) {}',
  'param rest': 'function f(...a) {}',
  'param rest type': 'function f(...a: T[]) {}',
  'param this': 'function f(this: T) {}',
  'param modifier': 'class C { constructor(public a: T) {} }',
  'param modifier readonly': 'class C { constructor(public readonly a: T) {} }',
  'param pattern': 'function f({ a, b }) {}',
  'param pattern type': 'function f({ a }: T) {}',
  'param pattern default': 'function f({ a } = {}) {}',
  'param pattern rest': 'function f(...{ a }) {}',
  'param decorator': 'class C { m(@d a: T) {} }',
  'param multi': 'function f(a: T, b?: U, ...c: V[]) {}',
  // types
  'fntype': 'type F = (a: T) => R;',
  'fntype generic': 'type F = <T>(a: T) => R;',
  'asserts': 'function f(x): asserts x {}',
  'asserts is': 'function f(x): asserts x is T {}',
  'infer': 'type X<T> = T extends infer U ? U : never;',
  'infer extends': 'type X<T> = T extends infer U extends string ? U : never;',
  'infer extends cond': 'type X<T> = T extends (infer U extends number ? 1 : 0) ? U : never;',
  'ctortype roundtrip': 'type C = new <T>(a: T) => R;',
  // class members
  'cm field': 'class C { x: T = 1; }',
  'cm field mods': 'class C { public static readonly x = 1; }',
  'cm method': 'class C { m() {} }',
  'cm method mods': 'class C { public static async m() {} }',
  'cm method gen': 'class C { *m() {} }',
  'cm method generic': 'class C { m<T>(a: T): T { return a; } }',
  'cm method overload': 'class C { m(): void; }',
  'cm getter': 'class C { get x() { return 1; } }',
  'cm setter': 'class C { set x(v) {} }',
  'cm getter mods': 'class C { public static get x() { return 1; } }',
  'cm getter overload': 'class C { get x(): T; }',
  'cm ctor': 'class C { constructor() {} }',
  'cm index': 'class C { [k: string]: T; }',
  'cm static block': 'class C { static {} }',
  'cm named-static': 'class C { static = 1; }',        // field NAMED `static`
  'cm named-get': 'class C { get = 1; }',              // field NAMED `get`
  'cm named-async method': 'class C { async() {} }',   // method NAMED `async`
  'cm decorator': 'class C { @d m() {} }',
};

let ok = 0, bad = 0;
for (const [label, code] of Object.entries(should)) {
  try { parse(code); ok++; }
  catch (e: any) { bad++; console.log(`SHOULD-PASS FAILED: ${label}  (${code})\n   ${e.message.replace(/\s*\[far.*/, '')}`); }
}
console.log(`${ok}/${ok + bad} guard cases pass`);
process.exit(bad === 0 ? 0 : 1);
