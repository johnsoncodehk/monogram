// The grammars the portable-targets gates run (test/portable-harness.ts) and their hand-written
// accept / reject lists: each grammar is checked on its lists (test/portable-lists.ts) and on the
// PARITY CORPUS (test/portable-corpus.ts). A hand-written list holds the inputs someone thought
// of; the corpus holds the ones the grammar derives.
//
//   - calc:   operator precedence/associativity, prefix unary, nested grouping.
//   - minijs: a real JavaScript SUBSET — a string/comment lexer, the full operator ladder,
//             call/member/index chains, arrays, and statement forms (the grammar the Go/Rust
//             output is benchmarked against oxc with).
//
// The javascript case also runs a Unicode corpus (non-ASCII accept/reject with lexer messages,
// edits next to multi-byte characters) on the same three parsers.
//

import { CTX_CASES } from './context-cases.ts';

// `parts`: the module's `textDialect(parts)` builds the grammar (a stage of the text dialect)
// instead of its default export.
export type Case = { grammar: string; path: string; parts?: Record<string, boolean>; accept: string[]; reject: string[]; tsOnly?: boolean };
// A for-head's no-`in` region (`exclude('in', Expr)`, a `suppress` step): it holds for the Pratt call
// it wraps, a nested call (parentheses, arguments, an object, array or template, a function or arrow
// block body) has `in` again, and every alternative of the head that fails inside or after it backs
// out of it. Each verdict is tsc's parser's too.
// Cap propagation (the interpreter's, gen-parser.ts): an ArrowFunction is an AssignmentExpression,
// so it admits no operator after it, and an operator whose right operand is an arrow admits none
// either (`x = () => {} || a` is no derivation); a parenthesized or nested arrow (an argument, an
// element) does not cap what holds it. Each verdict is the productions'.
const CAP_PROPAGATION = {
  accept: ['x = (() => {}) || a;', 'x = f(() => {}) || a;', 'x = a || f(() => {}) || c;', 'x = [() => {}] || a;', 'x = a ? () => {} : b || c;', 'x = () => {}, y;'],
  reject: ['x = () => {} || a;', 'x = y => {} || a;', 'x = async () => {} || a;', 'x = () => {} ? a : b;', 'b = a = () => {} || c;'],
};
// The mixfix operand re-bind (the interpreter's matchMixfixLed, PrattRule.ledRebind): a led
// `<L1> $ <L2> …` whose greedy operand took the L2 it needs is retried with the operand capped at
// each depth-0 L2 inside it. TypeScript: an `infer` constraint takes the conditional's `?`
// (`infer U extends string ? U : never`, TS 4.7), a parenthesized arrow with a return type takes the
// ternary's `:` (`b ? (c) : d => e`), a postfix `T?` takes the conditional's `?` before a word that
// begins no type (`? if :`). The rejects miss the rest after the re-bound operand.
const REBIND = {
  ts: {
    accept: ['type X<T> = T extends infer U extends string ? U : never;', 'type X<T> = T extends (infer U extends number ? 1 : 0) ? U : never;',
      'type C<T> = T extends number ? if : "o";', 'type C<T> = T extends number[] ? if : "o";', 'let v = b ? (c) : d => e;', 'let v = a ? (b) => (c): d => e;',
      'let v = x ? y => ({ y }) : z => ({ z });', 'let v = a ? b ? c : (d) : e => f;', 'let v = a ? (b) : c => (d) : e => f;'],
    reject: ['type X<T> = T extends infer U extends string ? U;', 'type X<T> = T extends infer U extends string ? : never;', 'let v = b ? (c) : d =>;'],
  },
};
const NO_IN_HEADS = {
  accept: [
    'for (var a = (b in c) in d);', 'for (a = (b in c) in d);', 'for (x = (y = (a in b)) in c);',
    'for (x = () => { a in b; } in c);', 'for (x = function () { return a in b; } in c);',
    'for (var a = f(b in c) in d);', 'for (x = () => { for (a in b); } in c);',
    'for (var a = () => { for (b in c) d in e; } in f);', 'for (var a = (b, c in d) in e);',
    'for (let [a = b in c] of d);', 'for (var a = { b: c in d } in e);', 'for (var a = `${b in c}` in d);',
    'for (x = (() => a in b);;);', 'for (x = (a in b) in c in d);',
  ],
  reject: ['for (var a = b in c;;);', 'for (var a = b in c in d;;);', 'for (var a = b, c = d in e;;);'],
};
// The restrictions of a `for` head (14.7.4, 14.7.5), the same in both grammars: the C-style head's
// first expressions are Expression[~In] and do not begin with `let [`; a for-in left side does not
// begin with `let [`, a for-of one with `let` or `async of`, a `for await` one with `let`; a
// declaration before `in` / `of` has one binding, a `using` one no pattern and no `in`; `for await`
// has only the `of` forms. Each verdict
// is the productions'; test/js-conformance.ts lists where tsc's parser departs from them.
const FOR_HEADS = {
  accept: [
    'for (a = (b in c);;);', 'for (f(a in b), [c in d];;);', 'for (a; b in c; d in e);', 'for (x = a ? b in c : d;;);',
    'for (let;;);', 'for (let = 1;;);', 'for (let.x;;);', 'for ((let)[0] = 1;;);', 'for (let[a] = 1;;);',
    'for (let in x);', 'for (let.x in x);', 'for (let [a] in x);', 'for ((let) of x);', 'for (let of of x);',
    'for (async of => 1;;);', 'for (async.x of y);', 'for ((async) of y);', 'for (async in y);', 'for (of of y);',
    'for (using of x);', 'for (using [a] of x);', 'for (using [a] in x);', 'for (var a = 1 in b);', 'for (var a of b); for (var [a] in b);',
    'async function f() { for await (async of x); for await (x.y of z); for await (const [a] of b); for await ((let) of c); }',
    'async function f() { for await (var a of b) for await (using x of y) for await (await using x of y); }',
  ],
  reject: [
    'for (a = b in c;;);', 'for (a in b in c;;);', 'for (a in b;;);', 'for (a, b in c;;);', 'for (x = y = a in b;;);',
    'for (x = a, b in c;;);', 'for (let[0] = 1;;);', 'for (let[0] in x);', 'for (let.x of y);', 'for (let of x);',
    'for (let[0] of x);', 'for (async of x);', 'for (async of => 1 of x);', 'for (var a, b of c);',
    'for (let a, b in c);', 'for (const a, b of c);', 'for (using a, b of c);', 'for (using a in b);', 'for (using {a} of b);',
    'async function f() { for await (a in b); }', 'async function f() { for await (;;); }',
    'async function f() { for await (var a in b); }', 'async function f() { for await (let a = 1;;); }',
    'async function f() { for await (let.x of y); }', 'async function f() { for await (let of y); }',
  ],
};
// A repetition whose element is one Pratt call and whose next step refuses every token a dirty
// failure of the call stops at (emit-portable.ts, `doomed`: an argument list `(` sep(Expr) `)`)
// takes no mark per element: an element that fails after its NUD matched (an operator that needs a
// target) leaves the list to fail at `)`, and the call's frame undoes it. Each verdict is the
// productions'; the rejected ones are each such a failure, in one argument or a later one.
const CALL_ARGS = {
  accept: [
    'f();', 'f(a,);', 'f(a, b,);', 'f(a = b, c += d);', 'f(a)(b)(c, d);', 'new C(a, ...b);', 'f(...a, b);',
    'f(a ? b : c, d => e, [f] = g);', 'f((a + b));', 'f(a)[b] = c;',
  ],
  reject: [
    'f(a + b = c);', 'f(a, b + c = d);', 'f(a++ = b);', 'f(a, b * c = d);', 'f(-a ** b);', 'new C(a + b = c);',
    'f(a, b, c + d += e);', 'f(a)(b + c = d);', 'f(a, b++ ++);', 'f(a + b = c,);',
  ],
};
// An IdentifierReference is no reserved word: a reserved word with no expression form of its own
// is no expression, in both grammars (`notReservedExpr`).
const RESERVED_EXPRS = {
  accept: [
    'a in b;', 'a instanceof B;', 'x = function () {};', 'export default x;', 'f(this, null, true);',
    'var [a] = b;', 'var[a] = 1;', 'var [a, ...b] = c;', 'for (var [a] of b);', 'for (var a in b);', 'for (var of of y);',
  ],
  reject: [
    'in;', 'x\nin;', 'instanceof;', 'x = default;', 'f(export);', 'extends;', 'a\nextends;', 'x = function;',
    'x = const;', 'f(if);', 'x = a ? in : b;',
    // `var` begins only a variable statement or a for-head declaration, never an expression
    'x = var;', 'var.x;', 'f(...[var]);', 'for (var of X) {}', 'for (var of of) {}', 'for (var of of.x);', 'for (var in X) {}', 'for (var;;);',
    'var [...x = a] = a;', 'for (var [...x = a] of b);',
  ],
};
// `export` takes a declaration (16.2.3), never another statement, in both grammars
// (`exportDeclaration`); TypeScript's also takes `using`, as tsc's parser does.
// JavaScript decorators (the decorators proposal): a DecoratorList belongs to a class, a
// declaration or an expression, and an exported class takes it before `export` or after it,
// not both. No other declaration takes one.
const JS_DECORATORS = {
  accept: [
    '@d class C {}', '@a @b() class C {}', 'export @d class C {}', '@d export class C {}', '@a @b export class C {}',
    '@d\nexport class C {}', 'export default @d class {}', '@d export default class {}', '@d export default class C {}',
    'x = @d class {};', 'x = @a @b class C {};', 'f(@a @b class {});',
  ],
  reject: [
    '@d function f() {}', '@d async function f() {}', '@d var x;', '@d export var x;', '@d export function f() {}',
    '@d export { a };', '@d export * from "m";', '@d export default x;', '@d export default function () {}',
    '@d import x from "m";', '@d export @e class C {}', '@d export default @e class {}', '@d export x;',
    'export @d default class {}', '@d default class C {}', 'x = @d function () {};',
  ],
};
// A template token referenced outside a Pratt NUD / postfix position (a `tok` step that carries
// its hole rule: an optional-chain tail `?.` template, TypeScript's decorator tail) is matched with
// its `${…}` holes, as the interpreter does, in every target: with no hole, with several, nested.
const TEMPLATE_STEPS = {
  js: {
    accept: ['a?.`x${y}`;', 'a?.`x${y}m${z}t`;', 'a?.`x${`y${z}`}`;', 'a?.`x`;', 'a?.b`x${y}`;', 'a?.`x${y}`();', 'a?.`${a?.`${b}`}`;'],
    reject: ['a?.`x${`;', 'a?.`x${y`;', 'a?.`x${}`;', 'new a?.`x${y}`;', '@x`a${b}c` class C {}', 'a!`x${y}`;'],
  },
  ts: {
    accept: ['@x`a${b}c` class C {}', 'a?.`x${y}`;', 'a!`x${y}`;', 'a?.`x${y}m${z}t`;', 'a?.`x${`y${z}`}`;', '@x`${`a${b}`}` class C {}',
      '@x`a` class C {}', 'a?.`x`;', '@x.y`a${b}` class C {}', '@x`a${b}`.y class C {}', 'a?.b`x${y}`;', 'a?.`x${y}`();',
      'x = @d`${a}` class {};', 'a!?.`x${y}`;'],
    reject: ['a?.`x${`;', '@x`a${}` class C {}', 'a?.`x${y`;', 'new a?.`x${y}`;', '@x`a${b` class C {}', '@x`${}` class C {}'],
  },
};
// TypeScript decorators and modifiers before a declaration or a class expression, as tsc's
// parser reads them (parseModifiers): decorators, modifier words, and a second decorator run
// only after `export` / `default` (the two words a `@` may follow); every word is a modifier
// only where tsc's nextTokenCanFollowModifier says so, and a run holds one `static` at most.
const TS_DECORATORS = {
  accept: [
    '@d class C {}', '@d export class C {}', '@d export @e class C {}', 'export @d class C {}', 'public export @d class C {}',
    '@d export default @e class {}', '@d export {a};', '@d export = x;', '@d interface I {}', '@d enum E {}', '@d const enum E {}',
    '@d declare class C {}', '@d declare override class C {}', '@d export override class C {}', '@d override class C {}',
    '@d in class C {}', '@d out class C {}', '@d public static abstract class C {}', 'static\nclass C {}',
    'public\nclass C {}', '@d var x;', '@d function f() {}',
    'x = @d class {};', 'x = @d @e class C {};', 'x = @d export @e class {};', 'x = @d abstract class {};', 'x = @d async class {};',
    'x = @d default class {};', 'x = @d declare class {};', 'x = @d public static class {};', 'x = @d export default @e class {};',
    'x = @d in out class {};',
    // `async` before a declaration is a modifier word: the declaration follows on its line.
    'declare var x;', 'declare let x: T;', 'declare const enum E {}', 'declare using x = f();', 'declare await using x = f();',
    'async\nclass C {}', 'async class C {}',
    'export default @d function f() {}', 'export default @d var x;', 'export default @d interface I {}', 'export default @d public class {}',
    // tsc's parser reads `declare` before no declaration as an expression statement and skips the
    // error for its missing `;` (parseErrorForMissingSemicolonAfter), so these are two statements.
    'declare x;', 'declare @d class C {}', 'declare if (a) {}',
    'export @d default function f() {}', 'export @d default abstract class C {}', 'export default @d class C {}',
    // The lexer makes `@new` one Decorator token, so both DecoratorExpr arms begin with it: the
    // `'@new' NewTarget` arm is a longest-match candidate there, not a branch no token reaches.
    '@new Foo() class C {}', '@new Foo class C {}', 'class C { @new Foo() m() {} }',
  ],
  reject: [
    '@new class C {}', '@new Foo()() class C {}',
    'public @d class C {}', 'abstract @d class C {}', '@d public @e class C {}', '@d export abstract @e class C {}',
    'export abstract @d class C {}', 'static static class C {}', '@d static static class C {}', '@d default x;', '@d default @e @f x;',
    'x = abstract class {};', 'x = @d const class {};', 'x = @d static static class {};', 'x = @d export @e export @f class {};',
    'x = @d public @e class {};',
    'async @d class C {}', 'export @d default x;', 'export @d default @e class C {}',
  ],
};
// TypeScript decorators and modifiers of a parameter, as tsc's parser reads them
// (parseModifiers: a second decorator run after `export` / `default`, one `static` across both
// runs; a function type's first parameter takes no decorator, isUnambiguouslyStartOfFunctionType),
// of an object-literal member (a second run only: no member starts with `@`), and a class member's
// (`async` a word of its run; the member's second run is owed: see ClassMember in typescript.ts).
const TS_MEMBER_DECORATORS = {
  accept: [
    'function f(@a @b x) {}', 'class C { constructor(@a() @b() private x: T) {} }', 'class C { m(@a @b x) {} }',
    'function f(export @d x) {}', 'function f(@a export @b public x) {}', 'function f(@a default @b x) {}',
    'function f(public { a }) {}', 'function f(readonly ...a) {}', 'function f(export ...a) {}',
    'function f(public public x) {}', 'function f(public: T) {}', 'function f(public) {}',
    'function f(static, x) {}', 'function f(static\nx) {}', 'function f(export @a @b x) {}',
    'class C { export\n@d x() {} }', 'class C { default\n@d x() {} }', 'class C { @a @b x() {} }',
    'class C { @d static x() {} }', 'class C { static static() {} }',
    'class C { export\n@d static x() {} }', 'class C { async export\n@d x() {} }',
    'type T = (x, @a y) => 1;', 'type T = <U>(@a x) => 1;', 'type T = new (@a x) => 1;',
    'type T = (public x) => 1;', 'type T = { (@a x): void };', 'class C { async async x() {} }',
    'class C { static async async *x() {} }', 'class C { async static async x() {} }',
    'class C { async async; }', 'class C { async async get x() {} }',
    'class C { async async [k: string]: 1 }', 'function f(export @d static x) {}',
    'function f(@d export @e static x) {}', 'function f(export @d public static x) {}',
    'class C { constructor(export @d static x) {} }', 'x = { export @d m() {} };',
    'x = { static async export @d m() {} };', 'x = { export @d async static m() {} };',
    'x = { default @d static m() {} };', 'x = { export @d [k]: 1 };', 'x = { export\n@d m() {} };',
    'x = { async export @d async *m() {} };', 'x = { export @d async };', 'x = { export @d static: 1 };',
  ],
  reject: [
    'function f(public @d x) {}', 'function f(@a public @b x) {}', 'function f(static static x) {}',
    'function f(export { a }) {}', 'function f(default x) {}', 'function f(async\nx) {}',
    'function f(public\nx) {}', 'function f(@a export @b export @c x) {}', 'class C { export @d x() {} }',
    'class C { declare export @d x() {} }', 'class C { @d export @e default @f x() {} }', 'class C { static export @d static x() {} }',
    'class C { public @d x() {} }', 'class C { default @d x() {} }', 'class C { async @d x() {} }',
    'class C { @d static static x() {} }',
    'class C { export @d static static x() {} }', 'class C { async export @d x() {} }',
    'type T = (@a x) => 1;', 'type T = (export @a x) => 1;', 'let f: (@a x) => 1;',
    'class C { async static async static x() {} }', 'function f(static export @d static x) {}',
    'function f(export @d static static x) {}', 'x = { @d m() {} };', 'x = { export @d export @e m() {} };',
    'x = { export @d static static m() {} };', 'x = { static export @d static m() {} };',
    'x = { public @d m() {} };', 'x = { export @d };', 'x = { static\n@d m() {} };',
  ],
};
// Module items (16.2): a module specifier and every import attribute value are string literals,
// `with` may follow a line break, and an ImportCall takes one or two AssignmentExpressions. tsc's
// parser takes any expression for both, the legacy `assert`, no `with` past a line break, and
// `import x = …` in JavaScript too (docs/CORRECTNESS.md). TypeScript's specifier `type` is tsc's
// (parseImportOrExportSpecifier, line breaks aside).
const JS_MODULES = {
  accept: [
    'import x from "m" with { type: "json" };', 'import x from "m" with {};',
    'import x from "m" with { type: "json", };', 'import x from "m" with { "type": "json" };',
    'import x from "m" with { if: "x" };', 'import "m" with { type: "json" };',
    'import { a } from "m" with { type: "json" };', 'import x from "m"\nwith { type: "json" };',
    'export * from "m" with { type: "json" };', 'export * as ns from "m" with { type: "json" };',
    'export { a } from "m" with { type: "json" };', 'export * as "s s" from "m";',
    'export * as default from "m";', 'x = import("m");', 'x = import("m",);',
    'x = import("m", { with: { type: "json" } });', 'x = import("m", o,);', 'x = import.meta.url;',
    'x = import((a, b));',
  ],
  reject: [
    'import x from "m" with { type: 1 };', 'import x from "m" assert { type: "json" };',
    'import x from "m" with { type };', 'import x from "m" with { type: "json" } with { a: "b" };',
    'export { a } with { type: "json" };', 'import x = require("m");', 'import x = N.y;',
    'export import x = N;', 'import type = require("m");', 'x = import("m", a, b);', 'x = import();',
    'x = import(...a);', 'x = import;', 'import x from y;',
  ],
};
const TS_MODULES = {
  accept: [
    'import x from "m" with { type: "json" };', 'import x from "m" with {};',
    'import x from "m" with { type: "json", };', 'import x from "m" with { "type": "json" };',
    'import x from "m" with { if: "x" };', 'import "m" with { type: "json" };',
    'import { a } from "m" with { type: "json" };', 'import type X from "m" with { type: "json" };',
    'import defer * as ns from "m" with { type: "json" };', 'export * from "m" with { type: "json" };',
    'export * as ns from "m" with { type: "json" };', 'export { a } from "m" with { type: "json" };',
    'export type * from "m" with { type: "json" };', 'export type { a } from "m" with { type: "json" };',
    'import x from "m"\nwith { type: "json" };', 'import x from "m" with { type: "json", type: "css" };',
    'import { type as } from "m";', 'import { type as as as } from "m";', 'import { type as as } from "m";',
    'import { type as b } from "m";', 'import { type\na } from "m";', 'import { type if as x } from "m";',
    'import { type "s" as b } from "m";', 'import { type type } from "m";', 'export { type\na };',
    'export { type as as as };', 'export { type as };', 'export * as "s s" from "m";',
    'import defer from "m";',
  ],
  reject: [
    'import x from "m" with { type: 1 };', 'import x from "m" with { type: a };',
    'import x from "m" assert { type: "json" };', 'import "m" assert { type: "json" };',
    'export * from "m" assert { type: "json" };', 'import x from "m" with { type };',
    'import x from "m" with { [a]: "x" };', 'import x from "m" with { type: "json" } with { a: "b" };',
    'export { a } with { type: "json" };', 'import x = require("m") with { type: "json" };',
    'import x from y;', 'import x from `m`;', 'export { a } from y;',
    'import { type as as as as } from "m";', 'import { type if } from "m";',
    'import { type as as "s" } from "m";', 'import defer x from "m";', 'import defer { a } from "m";',
    'import source x from "m";',
  ],
};
// TryStatement (14.15): a Catch, a Finally or both; a CatchParameter is a BindingIdentifier or a
// BindingPattern (TypeScript adds a type annotation), never a FormalParameter.
const TRY_STATEMENTS = {
  accept: [
    'try {} catch (e) {}', 'try {} catch ({ a }) {}', 'try {} catch ([a]) {}', 'try {} catch {}', 'try {} finally {}',
    'try {} catch ({ a = 1, b: [c] }) {}', 'try {} catch ([a = 1, ...b]) {}', 'try {} catch (e) {} finally {}',
  ],
  reject: [
    'try {}', 'try {} catch (e = 1) {}', 'try {} catch (...e) {}', 'try {} catch (@d e) {}', 'try {} catch (e, f) {}',
    'try {} catch () {}', 'try {} catch (if) {}', 'try {} catch (e) {} catch (f) {}', 'try {} catch (a.b) {}',
  ],
};
const TS_TRY = {
  accept: ['try {} catch (e: unknown) {}', 'try {} catch (e: Error) {}', 'try {} catch ({ a }: T) {}'],
  reject: [
    'try {} catch (e: T = 1) {}', 'try {} catch (e?) {}', 'try {} catch (e?: T) {}', 'try {} catch (this) {}',
    'try {} catch (public e) {}', 'try {} catch (e!: T) {}', 'try {} catch (e: ) {}',
  ],
};
const EXPORT_DECLS = {
  accept: [
    'export var a = 1;', 'export let a\nx;', 'export const a = 1, b = 2;', 'export function f() {}', 'export async function f() {}',
    'export class C {}', 'export { a }', 'export { a }\nx;', 'export { a as b, c }', 'export { a } from "m"',
  ],
  reject: [
    'export if (x) {}', 'export ;', 'export x;', 'export x = 1;', 'export (x);', 'export { a } b', 'export { a }\n.b;',
    'export return;', 'export async\nfunction f() {}', 'export {} {}', 'export while (x) {}',
  ],
};
export const CASES: Case[] = [
  {
    grammar: 'calc', path: './fixtures/calc.ts',
    accept: [
      '1;', 'a;', '', '1 + 2 * 3;', '1 * 2 + 3;', '1 - 2 - 3;', 'a / b / c;', '1 + 2 + 3 + 4;',
      '-a;', '-(-a);', '- - a;', '-a * b;', '-a + b * c;', '-(a + b) * c;',
      '(1);', '((a));', '(1 + 2) * (3 - 4);', 'a * b + c * d - e / f;',
      'let x = 1; let y = x + 2 * x; (y);', 'let z = -(a * b) / (c - -d);', 'foo; bar; baz;',
    ],
    reject: ['1 +;', '(1;', '1 2;', 'let = 1;', ') ;', '* a;', 'let x 1;'],
  },
  {
    grammar: 'minijs', path: './fixtures/minijs.ts',
    accept: [
      '1;', 'a;', '', 'x = 1 + 2 * 3;', '-a * b + 1;', '(1 + 2) * 3;',
      'foo(a, b);', 'a.b.c;', 'a[0][1];', 'f()()();', 'a.b(c).d[e];',
      'let x = 1; let y = x + 2;', '[1, 2, 3];', '[];', '[a, [b, c]];',
      'if (x < 10) { x = x + 1; } else { y(); }', 'while (i) { i = i - 1; }',
      'function f(a, b) { return a + b; }', 'var s = "hi\\"x"; // c\n s.length;',
      '/* block */ a;', 'a === b !== c;', 'a && b || c;', '!a && -b;',
      'return;', 'return a + b;', 'const PI = 3;', '{ a; b; }',
      'f(g(h(x)), [1, 2], y.z);', 'while (a < b) { if (c) { d(); } e = e + 1; }',
    ],
    // (note: `let = 1;` is VALID minijs — no reserved-word guard, so `let` is an
    // identifier and it's an assignment expression; the oracle accepts it too.)
    reject: ['1 +;', '(1;', 'if x {}', 'foo(a,;', 'a.;', '[1,', 'function (){}'],
  },
  {
    // The general token-pattern matcher (stateless real-JS token tier): \u-escaped
    // identifiers, the decimal/hex number family with a boundary, both-quote strings —
    // compiled to a backtracking-free matcher in all three targets.
    grammar: 'richtokens', path: './fixtures/richtokens.ts',
    accept: [
      '123', '0xFF', '1_000_000', '3.14', 'foo', 'bar_$x9', '"hi"', "'single'",
      '"esc\\"q\\n"', '123 0xa foo "s" 3.14', '0xDEADbeef 42 _id $x cafe // line\n 7',
      '/* block */ 99 x', 'caf\\u00e9 \\u0041bc', '1_2_3 0X1F 10.5 a1 b2',
    ],
    reject: ['12abc', '0x', '"unterminated', '3.', '#'],   // ($ is a valid identifier start, not a reject)
  },
  {
    // The STATEFUL regex-vs-division lexer: `/` is a regex in expression context, division
    // after a value. Exercises every branch of prevIsValue — after `=`/keyword/`(`-head
    // (regex) vs after value/`)`/`]`/member/call (division), plus regex escapes & classes.
    grammar: 'regexjs', path: './fixtures/regexjs.ts',
    accept: [
      'a / b;', 'var r = /abc/g;', 'return /re/;', 'if (x) /re/;', '(a + b) / c;',
      'a.b / c;', 'foo(x) / y;', '[1, 2] / 3;', 'var x = a / b / c;',
      'var re = /[a-z]+/i; x / y;', 'f(/re/, a / b);', 'var z = /a\\/b/;',
      'var d = /\\d+\\w/g;', 'var k = /[\\]]/;', 'if (a) /x/; else b / c;',
    ],
    // (`var ;` is VALID — `var` is an identifier, so it's the expression statement `var;`.)
    reject: ['a / ;', 'if (x /re/;', '/re/', '* a;', 'a = = b;'],
  },
  {
    // STATEFUL template literals: the `${…}` interpolation split (head/middle/tail) with a
    // brace-depth stack — adjacent/multiple holes, exprs in holes, nested templates, and a
    // nested `{…}` object inside a hole (which must NOT close the hole).
    grammar: 'templatejs', path: './fixtures/templatejs.ts',
    accept: [
      'var a = `hello`;', 'var b = `hi ${name}!`;', 'var c = `${x}${y}`;',
      'var d = `a${ x + 1 }b${ y * 2 }c`;', 'var e = `outer ${ `inner ${z}` } end`;',
      'var f = `${ {a} }`;', 'var f2 = `${ {a, b} } and ${ c }`;', 'var g = `no holes $ here`;',
      'f(`${a}`, `${b}`);', 'var h = `${a}${b}${c}`;', 'return `${ {x, y} }`;',
      'tag`hello`;', 'tag`${a}${b}`;', 'String.raw`a${b}c`.length;', 'x.tag`${y}`;',  // tagged (postfix-token LED)
    ],
    reject: ['var x = `${ }`;', 'var y = `${a`;', '`${a} ${}`;'],
  },
  {
    // Newline-only mode (engine-emitted NEWLINE spanning every line break outside flow ( … )).
    grammar: 'envspec', path: './fixtures/envspec.ts',
    accept: [
      'A=1', 'A=1\nB=2', 'A=1\n', 'A=1\n# c\nB=2', 'A=fn(1,\n2)\nB=3',
      'A=1\n\n\nB=2', '\n\nA=1', 'A=fn(1,\n2)',
      '', '\n', 'A=1\n\n', 'A=1\n \t\nB=2', 'A=1\r\n\r\nB=2\r\n', 'A=1\rB=2', 'A=fn(1,\r\n2)\r\nB=3',
    ],
    reject: ['A B', 'A=', 'A=1 B=2', 'A=fn(1,'],
  },
  {
    // Newline mode + template literals: the lexer mode without windowed relex (full re-lex per edit).
    grammar: 'envtpl', path: './fixtures/envtpl.ts',
    accept: ['A=1', 'A=`x`', 'A=`x${B}y`\nC=2', 'A=fn(`a`,\nb)\nB=`q${r}s${t}u`', 'A=`${a + b}`'],
    reject: ['A=`x${B}', 'A=`x', 'A=`${}`'],
  },
  {
    // General (non-literal) inline alt: object keys are alt(Ident | Str | Number) — a
    // backtracking alternation of token refs inside a rule sequence.
    grammar: 'altjs', path: './fixtures/altjs.ts',
    accept: [
      '{a: 1};', '{"k": 2};', '{1: x};', '{a: 1, "b": 2, 3: c};', '{x: 1 + 2 * 3};',
      '({nested: {inner: 1}});', '{};', 'a + b;', '{k: (1 + 2)};',
    ],
    reject: ['{a:};', '{: 1};', '{a 1};', '{a: 1,, b: 2};'],
  },
  {
    // A word is lexed as the identifier token: an alternative led by the word does not
    // exclude one led by an identifier (inline alt and rule alternatives alike).
    grammar: 'wordjs', path: './fixtures/wordjs.ts',
    accept: ['let get x;', 'let get = 1;', 'let x = 2;', 'do get x();', 'do get();', 'do x();', 'let get get; do get get();'],
    reject: ['let get;', 'let get x = 1;', 'let = 1;', 'do get x;', 'do get;', 'do ();'],
  },
  {
    // General Pratt NUD sequences: a reserved-word-guarded identifier (`not(kw)… Ident`,
    // a zero-width negative lookahead) and a quantifier-first class expression.
    grammar: 'nudjs', path: './fixtures/nudjs.ts',
    accept: [
      'x;', 'foo + bar;', 'class C {};', 'class {};', 'class C extends B {};',
      '@dec class C { m(){} };', 'new Foo;', 'new C();', 'a.b.c;',
      'class C { @x m(){} n(){} };', 'x + class {} + y;',
    ],
    reject: ['if;', 'class;', 'new;', 'return + 1;'],   // reserved words can't be bare identifiers
  },
  {
    // Postfix-operator LED (`x++`/`x--`) + the access-tail closure: once a postfix binds, the
    // operand is an update expression, so a further postfix or an access tail (`.`/`[`/`(`)
    // can't attach (`a++--`, `a++.b` are ill-formed; `(a++).b` is fine). Closure belongs to
    // the node: an enclosing binary or prefix node is no access-tail base either.
    grammar: 'postjs', path: './fixtures/postjs.ts',
    accept: [
      'x++;', 'x--;', 'a + b++;', '++x;', 'x++ + y;', 'a.b++;', '(x)++;', '--a.b;',
      'x++ * 2;', '(a++).b;', 'x.y.z++;', '(a + b).c;', '-a.b;', 'a + b.c;',
    ],
    reject: ['a++--;', 'a++.b;', 'a++ ++;', '++;', 'a + b++.c;', '-a++.b;'],
  },
  {
    // A led whose connector is also a postfix operator: when the led fails after its connector,
    // the LED loop goes on to the operator table (the reference does), where the postfix binds.
    grammar: 'ledexitjs', path: './fixtures/ledexitjs.ts',
    accept: ['a!;', 'a!(b);', 'a!(b)!;', 'a! + b;', 'a!(b) + c!;', '(a!)!(b);'],
    reject: ['a!!(b);', 'a!(;', '!a;', 'a!b;', 'a!(b;'],
  },
  {
    // A grouped sub-sequence `seq` step: comma lists as `star([',', $])` (e.g. `many(',', $)`),
    // the array/argument-list shape javascript.ts uses.
    grammar: 'seqjs', path: './fixtures/seqjs.ts',
    accept: [
      '[1, 2, 3];', '[];', '[1];', 'f(1, 2);', 'f();', '[a + b, c];',
      'f(g(1, 2), 3);', '(x);', 'f(a)(b, c);', '[[1,2],[3,4]];',
    ],
    reject: ['[1 2];', 'f(1,);', '[, 1];', 'f(1 2);'],
  },
  {
    // The `sameLine` zero-width assertion (no line terminator before the next token):
    // `return` takes a value only on the same line. Also verifies the lexer's newline-before
    // tracking across a block comment that spans a newline.
    grammar: 'sljs', path: './fixtures/sljs.ts',
    accept: [
      'return 1;', 'return;', 'return 1 + 2;', '1 + 2;', 'return /* c */ 1;',
      '(a);', 'return (1);', 'return\t1;',
    ],
    // `\r`, LS, PS are JS line terminators just like `\n` (ASI / "no LineTerminator here"), so a
    // `return` followed by any of them takes no operand — across all four lexers (interpreter,
    // emitted JS, portable ts/go/rust). A `\t` (tab) is whitespace but NOT a terminator → accepted above.
    reject: ['return\n1;', 'return\nx;', 'return /*\n*/ 1;', 'return // c\n 1;', 'return\r1;', 'return\r\n1;', 'return /*\r*/ 1;', 'return\u20281;', 'return\u2029x;'],
  },
  {
    // capBelow (assignment-level) arrow functions: a NUD parsed only when minBp < the
    // connector's bp, admitting NO led once parsed; the `(x) => y` vs `(x)` ambiguity is
    // resolved by longest-match ordering (the arrow is tried first, falls back to grouping).
    grammar: 'arrowjs', path: './fixtures/arrowjs.ts',
    accept: [
      'x => x;', '(a, b) => a + b;', '() => {};', 'x = (() => 1);', 'f(() => 1, 2);',
      '(x);', 'a + b;', 'x => y => x;', '(() => 2);', '(a) => a;', 'x = y => y;', 'foo();',
      '(a,) => b;', '(a, b,) => a;',   // trailing comma in params (sep allows a trailing delimiter)
    ],
    reject: ['=> x;', 'x => ;', '1 + () => 2;', '(,) => b;'],
  },
  {
    // Precedence-gated mixfix LEDs: ternary `? :` (binds below the operators) and the
    // chain-rhs relational leds `in`/`instanceof` (`a in b in c` left-chains).
    grammar: 'ledjs', path: './fixtures/ledjs.ts',
    accept: [
      'a == b ? c : d;', 'a ? b : c ? d : e;', 'a + b ? c : d - e;', 'a in b;',
      'a in b in c;', 'x instanceof Y;', 'a < b in c;', '1 + 2 * 3 ? 4 : 5;',
      '(a ? b : c) + d;', 'a in b ? c : d;', 'a = b ? c : d;',
    ],
    reject: ['a ? b;', 'a ? : c;', 'in b;', 'a instanceof;'],
  },
  {
    // The no-`in` (suppress) context: a `for (binding in iterable)` head parses its binding
    // with the `in` led disabled, so `in` belongs to the for-head, not the binding.
    grammar: 'noinjs', path: './fixtures/noinjs.ts',
    accept: [
      'for (x in y) z;', 'x in y;', 'for (a.b in c) d;', 'a in b in c;',
      'for ((x) in y) z;', 'for (x in y) a in b;', 'for (x in a in b) z;',
      '(a in b);', 'for (a in b) for (c in d) e;',
      // a staged suppress set ends with its group, entered or not
      'for (; a in b) z;', 'for (x; a in b) z;', 'for (; a) z;', 'for (;) z;',
    ],
    reject: ['for (x y) z;', 'for x in y;', 'for (in y) z;', 'for (x in) z;', 'for (x in y; a) z;'],
  },
  {
    // Longest match among a rule's alternatives, the earliest-declared on a tie
    // (fixtures/longestjs.ts): each pair declares the shorter alternative first, and a prefix
    // operator shares its word with a literal-led NUD. `this is 1;`, `let * a;` and
    // `export default 1;` need the LATER alternative; `yield x++ ++;` is refused because the
    // prefix arm wins the tie on `yield x++` and its node closes the tail.
    grammar: 'longestjs', path: './fixtures/longestjs.ts',
    accept: [
      'this;', 'this is 1;', 'this is this is x;', 'yield;', 'yield x;', 'yield x++;', 'yield a + b;',
      'yield * a;', '(yield x)++;', 'x => x + 1;', 'x => y => 1;', 'let a, b;', 'let;', 'let * a;',
      'let = 1;', 'export let a;', 'export x;', 'export default 1;', 'export default 1 + 2;',
      'export default x => x;', 'export default;',
    ],
    reject: ['yield x++ ++;', 'yield -x++ ++;', 'this is;', 'x =>;', 'export;', 'x++ ++;', 'export default 1'],
  },
  {
    // The Guard and Dispatch a longest-match candidate is tried under (fixtures/guardjs.ts):
    // a tie between candidates reached through different Dispatch sections goes to the
    // earlier-declared one (`go;`, `self;` — the rule skeleton tells them apart), a SECOND guard
    // refuses only what cannot match (`x: y;` vs `x;`), and no SECOND guard sits on an
    // alternative that can match one token (`{x}`). A candidate that repeats an earlier one
    // behind optional steps is still tried wherever one of them begins (`@a emit x;`,
    // `pub emit x;`, `#(x);`).
    grammar: 'guardjs', path: './fixtures/guardjs.ts',
    accept: [
      'go;', 'stop;', 'x;', 'x: y;', 'x: go;', 'a: b: c;', '{x}', '{x!y}', '{x?}', '{[]}', 'self;', 'nil;',
      '(self);', 'self + 1;', '1 + x;', 'go; stop; x;',
      'emit x;', '@a emit x;', 'pub emit x;', '@a @b pub emit x;', '(x);', '#(x);', '#(1 + x) + 2;', '(#(x));',
    ],
    reject: ['x y;', 'x:', 'x: ;', '{}', '{x!}', 'go', '{x', ': x;', '@ emit x;', 'pub x;', '@a pub;', 'pub pub emit x;', '#x;', '##(x);'],
  },
  {
    // Lookahead bodies in recognize form (fixtures/lookrec.ts): a rule reached from a lookahead and
    // from a consuming position (`Head`), one reached only from lookaheads (`Only`), each ending
    // where its longest alternative ends (`on x::1;`, `do x.y;`); a lookahead that runs a Pratt
    // rule, directly (`go`) or through an rd rule (`at`), and one whose Pratt rule is parsed with a
    // connector suppressed (`in a in b;` refused).
    grammar: 'lookrec', path: './fixtures/lookrec.ts',
    accept: [
      '', 'x: 1;', 'x:: a + 1;', 'if a;', 'if a + 1;', 'on x::1;', 'do x;', 'do x.y;', 'go a;', 'go a + b;', 'go a = b;',
      'at [a]!;', 'at [a + b]!;', 'in a;', 'in a + b;', 'x: a in b;', 'x: 1; if b; go c = d; at [e]!; do f.g;',
    ],
    reject: ['if x: 1;', 'if x:: 1;', 'on x:1;', 'on x::y;', 'do 1;', 'do (x);', 'do x.;', 'go a = ;', 'at [a];', 'at [a]', 'in a in b;', 'x 1;'],
  },
  {
    // Literals of every shape lid_of looks a text up by (see the fixture): a token of each must
    // get its literal id from the lexer and from lid_of alike, on a fresh parse and in a Doc.
    grammar: 'lidshapes', path: './fixtures/lidshapes.ts',
    accept: [
      '', '@ a;', '@@ a;', 'café a;', '$x a;', '_ a;', 'at a;', 'ate atom;', 'at ate;', '@ café;',
      '@ a; @@ b; café c; $x f; _ g; at h; ate i;', '@a;@@b;$x c;',
    ],
    reject: ['a;', '@;', '@ a', '@@@ a;', '@ @@;', 'caf a;', 'cafe a;', '$ a;', '$xy a;', '__ a;', 'a t;', 'atom a;', 'atea;'],
  },
  {
    // Literals and delimiters beyond ASCII (see the fixture): every length a lexer advances by,
    // or a composed operator is measured by, is in the target's units (UTF-8 bytes in Go / Rust).
    grammar: 'unilits', path: './fixtures/unilits.ts',
    accept: [
      '', '1 → 2;', 'a ≠ b;', 'a ≠= b;', 'a ± b ± c;', 'a 🜂 b;', 'a 🜂= b;', '§ x;', '→→ a → b;', '-→ x;', '> a;', 'a > b;', 'a >→ b;',
      'a→b≠c±d🜂e;', 'a-b→c;', '-a → -b;', '¬a 🜂 ¬b;', '(a → b) ≠ c;', 'let x = a 🜂 ¬b;', '§x;§y;→→a;-→z;',
      '¦str¦ → x;', '¦a\\¦b¦;', '¦é→🜂¦;', 'a ※ comment → 🜂\n→ b;', '« block → » a;', '«é»a«»;',
      '‖tpl‖;', '‖a¤⟨x⟩b‖;', '‖¤⟨‖¤⟨a⟩‖⟩‖;', '‖é¤x¤⟨a → b⟩🜂‖;',
      '^°;', '^°°;', '^°°°;', '^°° ;', '^ ;', '^ °;', 'a° → ^°;', '^°° → b°;',
    ],
    reject: ['→;', 'a →;', 'a ≠≠ b;', '§;', '§ x', '→ a;', 'a -→ b;', 'a > → b;', 'a ≠ = b;', '🜂 a;', 'a 🜂🜂 b;', 'a ¬ b;', 'a →→ b;',
      '¦unterminated;', '«open a;', '‖a¤⟨x‖;', '^;', '^°°;;', '°;', '^° °° ;'],
  },
  {
    // An identifier token that declares Python's Unicode classes (see the fixture): the lexer's
    // fallback beyond ASCII uses them, not ECMAScript's, in every target.
    grammar: 'xidjs', path: './fixtures/xidjs.ts',
    accept: ['℘ = a;', 'ℕ = a℘;', 'aำ = b;', 'a = bำc;', '_ำ = x;'],
    reject: ['ͺ = a;', 'aͺ = b;', '$ = a;', 'é$ = a;', 'ำ = a;'],
  },
  {
    // A capped prefix (`not`) and atLevel references (see the fixture): `not` is never the operand
    // of a tighter operator, a level-read operand admits only its level and tighter ones.
    grammar: 'cappedcalc', path: './fixtures/cappedcalc.ts',
    accept: [
      'not a;', 'not not a;', 'not a == b;', 'a and not b;', 'a or not b and c;', 'not a or b;', 'not -a;',
      '- -a;', 'a if b else c;', 'a if b or c else d;', 'a if b else c if d else e;', 'not a if b else c;',
      '*a | b;', '*a + b;', '*(a == b);',
    ],
    reject: ['a == not b;', '-not a;', 'a + not b;', '*a == b;', '*not a;', 'a if b if c else d else e;', 'a if b else;'],
  },
  {
    // The REAL javascript.ts grammar — the proof
    // that the target-agnostic emitter handles a full language end-to-end in ts/go/rust.
    // ASCII corpus only (byte-based go/rust use UTF-8 offsets, identical to the JS oracle's
    // UTF-16 offsets for ASCII; non-ASCII offset units differ inherently).
    grammar: 'javascript', path: '../javascript.ts',
    accept: [
      'var x = 1, y = 2;', 'function f(a, b) { return a + b; }', 'const g = (x) => x * 2;',
      'x => x + 1;', 'a ? b : c;', 'a.b.c();', 'f(g(1, 2), 3);', '[1, 2, 3].map(f);',
      'for (let i = 0; i < n; i++) x();', 'for (const k in obj) { y(); }', 'while (x) { z(); }',
      'if (a) b(); else c();', 'class C extends B { m() {} get p() { return 1; } }', 'a++; b--;',
      'typeof x; void 0;', 'new Foo(1, 2); new.target;', 'a ?? b; a?.b?.c;',
      'try { f(); } catch (e) { g(); } finally { h(); }', 'switch (x) { case 1: f(); break; default: g(); }',
      'a instanceof B; a in obj;', '(function () {})(); (() => {})();', 'x = a && b || c;',
      'do { x(); } while (y);', 'function* gen() { yield* o(); }', 'const { a, b: c, ...r } = o;',
      'const [p, , q, ...z] = arr;', 'label: for (;;) { break label; }', 'async function h() { await x; }',
      '(() => {})();', '(() => {})() + 1;', 'f(() => a, () => b);', 'let g = () => x => x + 1;',
      // `export default` heads an expression: a `/` after `default` begins a regex (a division cannot follow it)
      'export default /re/.test(x);', 'export default /=/;', 'switch (a) { default: /re/.test(x); }',
      // ... but as a member name a keyword is a value and a `/` after it divides, as after a private name
      // after a template's tail a `/` divides, as after a template with no substitution
      'x = `${a}` / 2 / 3;', 'x = `a${b}c${d}` / e / f;',
      'x = a.new / 2 / 3;', 'x = a.default / b / c;', 'x = a?.typeof / 2 / 3;', 'x = a.return / 2 / 3;', 'class C { #x = 1; m() { return this.#x / 2 / 3; } }',
      'function f() { return /re/.test(x); }', 'x = typeof /re/;', 'switch (a) { case /re/: break; }',
      'x.y.z++;', '(a++).b;', 'a++ instanceof B;', 'a++\n(x);',
      'for (a in b) c;',
      'for (a = x in b) c;',
      'for (a in b) { d = c in e; }',
      'new a.b();', '((((x))));',
      'for (a = x + y in b) c;',
      ...CAP_PROPAGATION.accept, ...NO_IN_HEADS.accept, ...FOR_HEADS.accept, ...RESERVED_EXPRS.accept, ...CALL_ARGS.accept, ...EXPORT_DECLS.accept,
      ...CTX_CASES.javascript.accept, ...JS_DECORATORS.accept, ...TEMPLATE_STEPS.js.accept, ...JS_MODULES.accept, ...TRY_STATEMENTS.accept,
      // An assignment / update operand needs only a LeftHandSideExpression's shape; target validity is a consumer's.
      '-x++;', '(a) = 1;', 'a = b = c;', '1 = 2;', '1++;', '++1;', 'f() = 1;', 'f()++;', '++f();', 'this = 1;',
      '(a + b) = c;', '(a, b) = 1;', 'a?.b = 1;', 'a?.b++;', '[a + b] = c;', '({a: 1} = c);', 'new.target = 1;',
      'for (1 of x);', 'for (a + b in x);', 'for (f() in x);',
      // Postfix `++`/`--` is a restricted production (`LeftHandSideExpression [no LineTerminator
      // here] ++`): after a line break the operator is the prefix of the NEXT statement.
      'x\n++\ny;', 'x\n--\ny;', 'x ++\n++\ny;', 'x\n++y\n--\nz;', 'a = b\n++c;', 'f()\n++\ny.z;',
      'var z =\nx\n++\ny;', 'function f() { return x\n++\ny; }', '{ x\n++\ny }', 'a[0]\n--\ny;',
      // A template is part of the `new` callee (MemberExpression : MemberExpression
      // TemplateLiteral, PrimaryExpression : TemplateLiteral); its holes are expressions.
      'new `a${0}b`;', 'new `abc`;', 'new `abc`(1);', 'new `x${1 + 1}`.y(1);', 'new tag`x`();',
      'new tag`x${1 + 1}`();', 'new a.b`x${y}`(1);', 'new a`x`.b`y`(1);', 'new a[0]`x`();',
      'new (a)`x`();', 'new a`x${new b`y${0}`}`();', 'new a`x`()`y`;', 'new a`x`().b;', 'new a`x`()?.b;',
      'async function f() { new a`x${await b}`(); }',
      // The longest alternative wins, wherever it is declared: `export default …` over
      // `export <statement>`, an expression statement over a `let` with no binding. A
      // YieldExpression is an AssignmentExpression: its operand is one, and it is capped as an
      // arrow is (no operator takes it as an operand, here or after it).
      'export default function () {}', 'export default function f() {}', 'export default class {}',
      'export default 1 + 2;', 'let * aa;', 'let => aa;', 'function* g() { yield a + b; yield; yield* o; yield x++; }',
      'function* g() { x = yield a; f(yield, yield a); a ? yield : yield b; yield yield a; x ||= yield; (yield) ** 2; }',
      // A parameter name is a BindingIdentifier: any identifier but a reserved word. Contextual
      // and strict-mode-only words stay names; a reserved word is fine as a pattern's key or a
      // default's value, and as a prefix of a longer name.
      'function f(yield, await, let, static, of, async, get, set) {}', 'class C { m(implements, package, interface) {} }',
      'x = (let, of) => 1;', 'function f(inx, iff, newer) {}', 'function f({ in: a, if: b }, [c]) {}', 'function f(a = this, b = null) {}',
      // A function, class or import binding name is a BindingIdentifier too; the names an
      // import or export specifier reads from a module, an export's own names and member names
      // are IdentifierNames, where a reserved word is fine.
      'function of() {} class async {} x = class await {};', 'function iff() {} class inx {} import newer from "m";',
      'import let, { yield as static } from "m";', 'import type from "m";', 'import * as from from "m";',
      'import { if as x, default as y } from "m";', 'export { x as if, y as default };', 'export { if } from "m";',
      'export * as if from "m";', 'class C { if() {} static in = 1 }', 'x = { if() {}, in: 1 };',
      // A class heritage is a LeftHandSideExpression: a class expression, a parenthesised
      // expression, an optional chain, an element access or a tagged template is a base. A `new`
      // callee is a MemberExpression, `new MemberExpression Arguments` included. (Inside an
      // argument list, so no reading as several statements can stand in for these.)
      'f(class extends class {} {});', 'f(class extends class Q extends P {} {});', 'f(class extends (a) {});',
      'f(class extends (a ? b : c) {});', 'f(class extends (a, b) {});', 'f(class extends a?.b {});', 'f(class extends a?.b() {});',
      'f(class extends a[0] {});', 'f(class extends a`t` {});', 'f(class extends a.b(c).d {});', 'class A extends (B) {}',
      'f(new new Foo()());', 'f(new new Foo());', 'f(new new Foo().b());', 'f(new new new A()()());',
      // A statement ends at `;`, before a token on a later line, before `}` or at the end of the
      // input (ASI); one that ends in a block needs nothing more, and a do-while also ends at
      // its `)`. `return` takes an expression only on its own line.
      'a\nb', 'var a = 1\nvar b = 2', '{ a }', 'a\n(b)', 'do x; while (y) z', 'do {} while (y) z', 'if (a) b\nelse c',
      'function f() { return\nvar b }', 'function f() { return\nlet\nx = 1 }', 'L: for (;;) { break\nL }',
      'function f() {} g()', 'if (a) {} b', 'import a from "m"\nx', 'export { a }\nx', 'export default a\nb',
      'export default class {} g()', 'export default class C {} g()', 'class C { a\nb }', 'class C { m() {} n() {} }',
      'class C { m() {}; n() {} }', 'class C { get g() {} set s(v) {} }',
      // An expression statement does not begin with `{`, `function`, `async` `function` on one
      // line, `class`, `let [` or a decorator: there it is a block or a declaration, and what
      // follows is the next statement.
      '{}\n(x)', 'function f() {}\n(x)', 'class C {}\n[0]', '@dec class C {}\n(x)', 'async\nfunction f() {}\n(x)',
      'if (a) {}\n(x)', '({}).x;', '({ a: 1 }.x);', '(function () {})();', '(@dec class {}).x;', 'x = () => ({}).y;', 'let = 1;',
    ],
    reject: ['function (', 'a +;', 'if x {}', '{ a: }', 'for (;;', 'a ? b ;',
      '{ a: 1 }.x;', '{} .b;', '{}\n.b;', '{} = b;', '{ function () {} }', 'if (a) {} = b;', 'L: {}.x;', 'do {}\n(x)\nwhile (y)',
      '@dec class {}.x;', '@dec class C {}.x;', 'class C {}.name;', 'let[0] = 1;', '(async\nfunction f() {});',
      ...JS_DECORATORS.reject, ...JS_MODULES.reject, ...TRY_STATEMENTS.reject,
      // ... so no parameter list takes a reserved word as a name, `this` included (a `this`
      // parameter is TypeScript's).
      'function f(in) {}', 'function f(if, b) {}', 'x = function (a, while) {};', 'class C { m(in) {} }', 'x = { m(class) {} };',
      'class C { set s(this) {} }', 'function f(this) {}', 'x = (in) => 1;', 'x = async (for) => 1;', 'function* g(new = 1) {}',
      'class C { constructor(true) {} }', 'function f(null) {}', 'function f(...in) {}',
      // ... nor does a function, class or import binding name.
      'function if() {}', 'function* in() {}', 'async function new() {}', 'x = async function* this() {};',
      'x = function while() {};', 'export function var() {}', 'export default function if() {}', 'class while {}',
      'x = class do {};', 'export default class true {}', 'export class const {}', 'x = new class do {}();',
      'import if from "m";', 'import { a as if } from "m";', 'import { if } from "m";', 'import * as do from "m";',
      'import a, * as for from "m";', 'import { "a" as class } from "m";',
      // A `new` with no Arguments is not an optional-chain base, template callee or not.
      'new a`x`?.b;', 'new `x`?.b;', 'new a?.`x`;', 'new `a${}b`;', 'async function f() { new a`x${await}`(); }',
      // … and a YieldExpression is no operand and no assignment target (it is capped): no postfix,
      // `**`, binary operator or `=` takes it, before or after it.
      'function* g() { yield x++ ++; }', 'function* g() { yield x++ --; }', 'function* g() { yield -x ** 2; }',
      'function* g() { yield ** 2; }', 'function* g() { x = yield = 1; }', 'function* g() { a + yield b; }',
      '1 + () => 2;', 'a++.b;', 'f(a, b,',
      // … so nothing after a line break is a postfix operator: `x\n++\n++\ny` is `x; ++ ++y`,
      // `x\n++` is `x; ++`, and `(x\n++)` leaves `++` with no operand.
      'x\n++\n++\ny;', 'x\n++\n++y;', 'x\n--\n--\ny;', 'x\n++\n--\ny;', 'var z =\nx\n++\n++\ny;',
      'function f() { return x\n++\n++\ny; }', 'f()\n++\n++\ny;', 'a[0]\n--\n--y;', '{ x\n++\n++\ny }',
      'x\n++;', 'x\n--', '(x\n++);', 'a = [x\n++];', 'x\n++\n-y;', 'x\n++\ny++;', 'x\n++ ++y;', 'class C { p = x\n++ }', 'class C { p = x\n++\ny }',
      'for (a = (x in b)) c;',
      'for (a = b ? x in c : y in d) e;',
      ...CAP_PROPAGATION.reject, ...NO_IN_HEADS.reject, ...FOR_HEADS.reject, ...RESERVED_EXPRS.reject, ...CALL_ARGS.reject, ...EXPORT_DECLS.reject,
      ...CTX_CASES.javascript.reject, ...TEMPLATE_STEPS.js.reject,
      // An assignment / update operand (prefix ++/-- included) without a LeftHandSideExpression's shape has no parse.
      'a + b = c;', 'a++ = 1;', '-a = 1;', '++ -x;', '++x++;', '++ ++x;',
      // … wherever the expression is optional or repeated: a refused operand is not skipped.
      'a = [++ ++y];', '[++-x];', '[++x++];', 'a = [1, ++-x];', 'f(++ ++y);', 'f(a, ++ ++y);', 'new A(++ ++y);',
      '[x++ ++];', 'f(a, x++ --);', '[-x = 1];', 'f(a + b = 1);', '[-x ** 2];', 'f(a, typeof x ** 2);', 'x = { a: ++ ++y };',
      // … but not an operator expression, and a class expression base still needs its body.
      'f(class extends a + b {});', 'f(class extends void a {});', 'f(class extends a = b {});', 'f(class extends typeof a {});',
      'f(class extends a => b {});', 'f(class extends class {});', 'f(class extends if {});', 'f(class extends class extends {} {});',
      'f(new new Foo()?.b);',
      // … so two statements on one line need a `;` between them, and a method has a body.
      'a b', 'a = 1 b = 2', 'var a = 1 var b = 2', 'function f() { return a b }', 'throw a b', 'debugger x',
      'L: for (;;) { break L x }', 'a /* c */ b', 'if (a) b else c', 'do x while (y)', 'import in from "m"',
      'x = function this() {}', 'import "m" x', 'export * from "m" x', 'export default a b', 'export var a = 1 b',
      'class C { a b }', 'class C { m() n() {} }', 'class C { get g() set s(v) {} }', 'class C { m(); }',
      // an update expression is no callee: `a++(x)` is `a++` and `(x)` with nothing between them
      'a++(x);',
      // an `export`ed declaration is not a `using` one (explicit resource management; tsc's parser takes it)
      'export using x = y;'],
  },
  {
    // The real typescript.ts grammar — the second, most complex full language proving the
    // agnostic emitter (types, generics, interfaces, enums, assertions, variance). ASCII.
    grammar: 'typescript', path: '../typescript.ts',
    accept: [
      ...CAP_PROPAGATION.accept, ...NO_IN_HEADS.accept, ...FOR_HEADS.accept, ...RESERVED_EXPRS.accept, ...CALL_ARGS.accept, ...EXPORT_DECLS.accept, 'for (let a: T of b); for (var a: T in b); for (var a: T = 1;;);', ...REBIND.ts.accept,
      'export default /re/.test(x);', 'export default /=/;', 'switch (a) { default: /re/.test(x); }',
      // ... but as a member name a keyword is a value and a `/` after it divides, as after a private name
      // after a template's tail a `/` divides, as after a template with no substitution
      'x = `${a}` / 2 / 3;', 'x = `a${b}c${d}` / e / f;',
      'x = a.new / 2 / 3;', 'x = a.default / b / c;', 'x = a?.typeof / 2 / 3;', 'x = a.return / 2 / 3;', 'class C { #x = 1; m() { return this.#x / 2 / 3; } }',
      'function f() { return /re/.test(x); }', 'x = typeof /re/;', 'switch (a) { case /re/: break; }',
      ...CTX_CASES.typescript.accept, ...TS_DECORATORS.accept, ...TEMPLATE_STEPS.ts.accept, ...TS_MEMBER_DECORATORS.accept, ...TS_MODULES.accept, ...TRY_STATEMENTS.accept, ...TS_TRY.accept,
      // A class heritage is a LeftHandSideExpression (see the JavaScript cases).
      'f(class extends (a, b) {});', 'f(class extends a[0] {});', 'f(class extends a`t` {});', 'f(class extends a?.b() {});',
      // `return` takes an expression only on its own line (a restricted production), so a
      // reserved word after the line break starts the next statement.
      'function f() { return\nvar b }', 'function f() { return\nlet\nx = 1 }',
      'const a: number = 1;', 'let s: string;', 'type Alias = { a: number; b?: string };',
      'type U = "a" | "b" | "c";', 'function gen2<T, U extends T>(x: T, y: U): T { return x; }',
      'interface I<T> extends A<T> { m(x: T): T; }', 'const c = x as const;',
      'function isStr(x: unknown): x is string { return true; }', 'enum E { A, B, C }',
      'const n = maybe!;', 'let arr: number[];', 'type Fn = (x: number) => string;',
      'class C<in out T> { value!: T; }',
      // `<` heads both type-argument LEDs and the relational operator: a type-argument arm
      // that fails must leave `<` to the next arm and to the comparison.
      'a < b;', 'a < b >> c;', 'a < b > c;', 'f(a < b, c > d);', 'x = B<C>;', 'x = B<C>(1);',
      'x = y = 1;', '(a + b) = 1;', 'a.b = 1;', 'x++;', '++x;', '(-x) ** 2;', '++x ** 2;',
      'x ? a : b.c;', 'x as T.y;', 'x = B<C>\n++y;',
      // A bare instantiation `B<C>` ends where tsc's canFollowTypeArgumentsInExpression lets it.
      'x = B<C> as T;', 'x = B<C> satisfies T;', 'x = B<C> instanceof D;', 'x = B<C> <= 1;', 'x = B<C>\ny;',
      // tsc rescans the closing token of expression type arguments: `>>`/`>=`/… never close them.
      'f<A>>(x);', 'x = a<b>>>c;', 'new A<B>>(c);', 'f<A<B>>(x);', 'a < B<C>> c;',
      // Every '>' is its own token; operators compose from adjacent ones.
      'x = a >>>= b >>= c >= d >> e >>> f;', 'let t: A<B<C<D<E>>>> = a >>> b;',
      // A typed call / instantiation is a LeftHandSideExpression: its `<` is not an operator.
      'f<T>() = 1;', 'x = B<C> = 1;', 'x = B<C> += 1;', 'f<T>`x` = 1;', 'f<T>()++;', 'f<T>().x = 1;',
      '++(-x);', '++x.y;', '++f<T>();',
      // Postfix `++`/`--` is a restricted production: after a line break the operator is the
      // prefix of the next statement (ASI), never the postfix of the previous operand.
      'x\n++\ny;', 'x\n--\ny;', 'x ++\n++\ny;', 'x\n++y\n--\nz;', 'a = b\n++c;', 'f<T>()\n++\ny.z;', 'x!\n++\ny;',
      'var z: number =\nx\n++\ny;', 'function f() { return x\n++\ny; }', '{ x\n++\ny }', 'a[0]\n--\ny;',
      // A parenthesized / argument arrow does not cap the operator chain around it.
      'a + f(() => 1) + c;', 'a && (() => 1) && c;', 'x = (a = () => 1) || y;',
      // A modifier word is a modifier only while a member name can still follow it; before
      // `(` `=` `:` `;` `?` `!` `<` `,` `}` it is the member's NAME, whatever precedes it.
      'class C { public static() {} }', 'class C { public static; }', 'class C { readonly static = 1; }',
      'class C { declare public static: T; }', 'class C { abstract static?(): void; }', 'class C { private static<T>() {} }',
      'class C { override static!: T; }', 'class C { public static }', 'class C { static static() {} }', 'class C { public public() {} }',
      'class C { static() {} }', 'class C { static = 1; get = 2; async() {} }', 'class C { public static static() {} }',
      'class C { public static x; static public y; public static { } }',
      'x = { public static() {} };', 'x = { static public: 1 };', 'x = { readonly override<T>() {} };', 'x = { declare abstract?() {} };',
      'x = { async static() {} };', 'x = { async public declare() {} };', 'x = { static, public };',
      // tsc's rule, per word: a member start (a name, `[`, `*`) must follow, on the same line for
      // every word but `static` / `export` / `get` / `set`. Past a line break the word is the name.
      'class C { public static\n@dec x() {} }', 'class C { readonly public\n@dec x() {} }', 'class C { public\n@dec x() {} }',
      'class C { public\nx() {} }', 'class C { static\nx = 1; }', 'class C { export\nx() {} }', 'class C { async\nx() {} }',
      'class C { declare\nx: T; readonly\n[k]: T; }', 'x = { static\nx() {} };', 'x = { export\nx: 1 };',
      'class C { export type\nx() {} }', 'class C { get\nx() { return 1; } }', 'class C { static\n*g() {} }',
      // `async` is a modifier like the others, so it also precedes a field; the line rule holds for it too.
      'class C { async x; }', 'class C { static async x = 1; }', 'class C { async public\nx() {} }', 'class C { static async static\nx = 1; }',
      'x = { static: 1, public() {}, get: 2 };', 'x = { public static x() {}, static get y() { return 1; } };',
      // An object-literal member's run is one list, `async` one of its words, and every member
      // follows every run: an accessor, a `*` method, a method, a value, a shorthand. A method or
      // accessor ends as a function declaration does, with a block or none. An accessor's body
      // is never [Await], a method's is after a run that holds `async`.
      'x = { static async m() {} };', 'x = { static async *g() {} };', 'x = { async static *g() {} };', 'x = { async async m() {} };',
      'x = { public async static m() {} };', 'x = { async x: 1 };', 'x = { async x };', 'x = { static async };', 'x = { async async };',
      'x = { static x };', 'x = { static x = 1 };', 'x = { static x? };', 'x = { static x! };', 'x = { public x?! = 1 };',
      'x = { m() };', 'x = { m(): T };', 'x = { m(); };', 'x = { m();, n: 1 };', 'x = { m()\n, n: 1 };', 'x = { static async m(): T\n};',
      'x = { *g() };', 'x = { get x() };', 'x = { get x<T>() {} };', 'x = { async get x() { await = 1 } };', 'x = { static m() { await = 1 } };',
      // A computed name holds an Expression, a comma list included, in every member list.
      'x = { static [a, b]: 1 };', 'x = { [a, b]() {} };', 'x = { static *[a, b]() {} };', 'x = { get [a, b]() {} };',
      'class C { [1, 2]() {} }', 'interface I { [a.b, c](): T }', 'enum E { [1, 2] = 1 }',
      // `defer` leads the deferred import and is a default import's name (the emitted parsers
      // rejected these while ImportClause's alternatives were dispatched on the word; see wordjs).
      'import defer from "m";', 'import defer, { a } from "m";', 'import defer, * as ns from "m";', 'import defer * as ns from "m";',
      // `default` is a modifier when `class`, `function`, `interface`, or `abstract` / `async` then
      // `class` / `function` on their line follows (line breaks before them allowed); `export` is
      // one before such a `default`, and before `type` only when a member start other than `as` /
      // `*` follows the `type`; `const` before `enum` (any line), and in a class body before any
      // member start on its line. The same in every member list.
      'class C { default class() {} }', 'class C { default function(): T }', 'class C { export default class: T }',
      'declare class C { default interface: T }', '(class { default\nclass() {} })', 'class C { default abstract class() {} }',
      'class C { default async function() {} }', 'class C { static default class = 1 }', 'x = { default class() {} };',
      'x = { export default function: 1 };', 'x = { default\ninterface: 1 };', 'interface I { default class: T }',
      'interface I { export default interface(): T }', 'type A = { default abstract class?: T };',
      'type A = { export\ndefault\nfunction: T };', 'interface I { const enum: T }', 'x = { const enum: 1 };',
      'type A = { const\nenum: T };', 'x = { export const enum() {} };', 'class C { const enum: T }', 'class C { const\nenum: T }',
      'interface I { export type\nx: T }', 'class C { export type\n[k]: T }', 'class C { static export type\nx = 1 }',
      // `this is T` is a TYPE (tsc: parseNonArrayType), so it stands wherever a type does; its
      // target is a whole type. `x is T` exists only as a return type. `is` binds on the same line.
      'var x: this is string;', 'function f(x: this is string) { }', 'declare class W { set p(x: this is string); }',
      'class F { isFSO: this is F; m(): this is F { return true; } get g(): this is F { return true; } }',
      'type A = this is T;', 'type A = U | this is T | V;', 'type A = (this is T)[];', 'type A = G<this is T>;',
      'type A = keyof this is T;', 'type A = { p: this is T };', 'interface I { p: this is T }', 'type A = [a: this is T];',
      'var v = y as this is T;', 'var v = y satisfies this is T;', 'var v = <this is T>y;', 'type A = U extends this is T ? 1 : 2;',
      'var x: this is this is T;', 'var x: asserts y is this is T;', 'function f(x: any): x is this is T { }',
      'function f(x: any): (this is T) { }', 'type F = (x: any) => x is T;', 'var v = (x: any): x is T => true;',
      'var x: this is\n string;', 'class C { p: this\n is: number }', 'class C { m(x): x\n is: string }', 'type A = this[];',
      // An assignment target's shape is decided by the construct that built the node: a class
      // expression named like a connector is a PrimaryExpression, not an `as` / `satisfies` node.
      'x = class as {} = 1;', 'x = class satisfies {} = 1;', 'x = class as extends B {} = 1;',
      // A template's holes are parsed by the rule its reference declares: types in a
      // template-literal type, expressions everywhere else — the `new` callee included.
      'type X = `a${T[]}b`;', 'type X = `a${A | B}b${C["k"]}`;', 'type X = `${infer U extends string}x`;',
      '`a${0}b`;', 'tag`a${1 + 1}b`;', 'x = `a${y as `b${T[]}`}c`;',
      'new `a${0}b`;', 'new `abc`(1);', 'new tag`x${1 + 1}`();', 'new a.b`x${y}`(1);', 'new a<T>`x`();',
      'new `x${y as T[]}`;', 'new a`x${new b`y${0}`}`();',
      // An import-equals right-hand side is an EntityName (non-reserved identifiers joined by
      // `.`) or `require(` a string literal, or else an Expression `)`.
      'import r = m;', 'import r = a.b.c;', 'import r = a\n.b;', 'import r = a.let.async;', 'import r = require;', 'import r = require.x;',
      'import r = require("x");', "import r = require('x');", 'import r = require\n("x");', 'import r = require(x);', 'import r = require(1, 2);',
      'export import r = a.b;', 'import type r = require("x");', 'import type r = a.b;', 'import type = require("x");',
      'namespace N { import r = a.b }', 'declare module "m" {\nexport import r = require("x")\n}',
      // A declaration without a body ends where a statement does (tsc's parseSemicolon): at a
      // `;`, a line break, a `}` or the end of input. One that ends in a block needs nothing.
      'function f(): void\nfunction f() {}', 'function f(): void; g();', 'namespace N { function f(): void }',
      'function f() {} g();', 'function f() {};', 'class C {} g();', 'namespace N {} x;', 'enum E {} x;', 'interface I {} x;',
      'declare module "x" {} x;', 'export default function () {} g();', 'export default class {} g();', 'export default interface I {} x;',
      'export default @dec class {} g();', 'export default abstract class C {} g();', 'export default @dec abstract class C {}',
      'type A = B\nC;', 'namespace N { type A = B }', 'declare module "x"\nfoo();', 'declare function f()\ng();',
      'export = a\nb;', 'import "m"\nfoo();', 'export { a }; b();', 'export * from "m"\nfoo();', 'export as namespace N\nfoo();',
      'namespace N { export * from "m" }', 'declare module "m" { export default a }', 'function w() { type A = B }',
      'import r = a.b\nfoo();', 'import r = require("x")\n(g);', '@dec using x = y\nfoo();', 'type A = B;;',
      // A class member without a body ends as a statement does (a `;`, a line break, a `}`); one
      // with a block needs nothing, and a `;` after it is an empty class element of its own. A
      // type member (and a class index signature) may also end in `,`.
      'class C { m(); n() {} }', 'class C { m()\nn() {} }', 'class C { m() }', 'class C { m() {} n() {} }', 'class C { m() {}; }',
      'class C { m() {} ;; }', 'class C { get g()\nset s(v) {} }', 'class C { constructor()\nx }', 'class C { constructor() {} x }',
      'class C { static {} x }', 'class C { m(): void\nm() {} }', 'declare class C { m()\nn() }', 'class C { [k: string]: T, x }',
      'class C { [k: string]: T\nx }', 'class C { x // c\ny }', '(class { *g()\nh() {} })',
      'interface I { a\nb }', 'interface I { a, b }', 'interface I { a; b }', 'interface I { a: T, }', 'interface I { (): void\nx }',
      'interface I { new (): T, x }', 'interface I { [k: string]: T\nx }',
      'type A = { a\nb }', 'type A = { a, b; c }',
      // An interface member takes tsc's type-member modifiers (one member, not a word of its own).
      'interface I { public a: T }', 'interface I { static m(): void, x }', 'interface I { readonly [k: string]: T }',
      'interface I { private a\nb }', 'interface I { public\na }', 'interface I { readonly a }', 'interface I { static [e]: T }',
      // A type literal's members are an interface body's (tsc's one parseTypeMember): modifiers,
      // get / set with or without a body (after which nothing is needed), in every type position.
      'var x: { private y: string };', 'type X = { public x: T };', 'type A = { readonly a };', 'type A = { static m(): T; declare d: T, export e: T }',
      'function f(p: { protected a: T }): { readonly [k: string]: T } { return p }', 'type A = B<{ override a: T }> | { accessor b };',
      'type A = { get g(): T; set s(v: T) };', 'type A = { get g() {} y: T }', 'type A = { get g<U>(): U }', 'type A = { get\ng(): T }',
      'interface I { get g() { return 1 } set s(v) {} }', 'interface I { get g<U>(): U }', 'var x: { set s(v = 1) {} get [e](): T }',
      'type A = { public;\nget g(): T }', 'type A = { public\nin: T }', 'type A = { export type\nx: T }', 'type A = { f(): x is T }',
      // A mapped type is a type of its own, chosen where it starts; in a member list `[K in T]` is
      // a computed name.
      'type A = { -readonly [K in T]-?: U };', 'type A = { +readonly [K in T as U]+?: V; a: T }', 'type A = { [K in T] }',
      'type A = { readonly [K in T]\na: T }', 'interface I { [K in T]: U }', 'type A = { a: T; [K in T]?: U }', 'interface I { readonly [K in T]?: U }',
      // A property signature may have an initializer (tsc's parsePropertyOrMethodSignature; "an
      // interface property cannot have an initializer" is a checker error), an assignment
      // expression, after which the member ends as any other does. The member must still start
      // as tsc's isTypeMemberStart reads one: after a `?`, a `: T`, a computed name, a line
      // break, or a leading `get` / `set`.
      'interface I { a: T = 1 }', 'type A = { a?: T = f() }', 'var x: { a?: T = f() };', 'type A = { a? = 1 }', 'type A = { [e] = 1; b: T }',
      'type A = { get = 1, set = 2 }', 'type A = { public [e] = 1 }', 'type A = { readonly a: T = x => x, b: U }', "type A = { 's': T = a ? b : c\n}",
      'type A = { a\n= 1 }', 'type A = { public\n= 1 }', 'type A = { #p\n= 1 }', 'type A = { 0?: T = 1, 1n: U = 2 }', 'type A = { a: T = x\n.y }',
      'type A = { [K in T]: U; a: T = 1 }', 'function f(p: { a: T = 1 }): { b?: U = 2 } { return p }', 'type A = B<{ a: () => T = b = c }>;',
      // An index signature is one form in a class and an object type (tsc's isIndexSignature,
      // then parseIndexSignatureDeclaration): after any member modifiers, `async` included, its
      // brackets are a parameter list. A bracket tsc does not read as one is a computed name.
      'class C { async [k: string]: T }', 'declare class C { async [k: string]: T }', 'class C { static async [k: string]: T }',
      'class C { async static readonly [k: string]: T, x }', 'class C { @d async [k: string]: T }', 'class C { const [k: T]: U }',
      'class C { []: T }', 'class C { [a?]: T }', 'class C { [public a]: T }', 'class C { [a: T, b: U]: V }', 'class C { [...k: T[]]: U }',
      'class C { [a, b] }', 'class C { [a,]: T\nx }', 'declare class C { [k: T, ]: U; [a?] }', 'class C { [public: T]: U }',
      'class C { [e]: T; [e]() {} [e] = 1; [public]: T }', 'class C { [async (x) => x]: T }', 'type A = { [async (x) => x]: T }',
      'class C { async\n[k: T]: U }', 'class C { [a = 1]: T }',
      // A parameter name is a binding identifier in every parameter list, value or type: `this`
      // takes its own form, a modifier word before a name is a modifier and one alone is a name,
      // and a JSDoc function type's parameters are types (tsc's parseJSDocParameter).
      'function f(this: T, a) {}', 'type F = (this: T) => U;', 'function f(public a, readonly b: T) {}',
      'class C { constructor(private yield, protected await) {} }', 'type F = (yield: T, await: U, let: V, type: W) => X;',
      'interface I { [out: T]: U }', 'function f(in x) {}', 'function f(declare: T) {}', 'type F = new (inx: T, iff: U) => V;',
      'type F = function (in): U;', 'type F = function (this: T, string): U;', 'class C { [true]: T }',
      // An import, `infer` or mapped-type name is a binding identifier; an import
      // specifier's module-side name, a nested namespace name and an enum member are names.
      'import type { if as x } from "m";', 'import { type if as x } from "m";', 'import type = require("m");',
      'import defer * as async from "m";', 'type T = A extends infer string ? 1 : 0;',
      'namespace A.if {}', 'module A.in {}', 'enum E { if, in }',
      'type T = { [this in K]: 1 };', 'type T = { readonly [K in U]: 1 };',
      // An expression statement does not begin with `{`, `function`, `async` `function` on one
      // line, `class`, `let [` or a decorator (see the JavaScript cases); the TypeScript
      // declaration words stay contextual.
      '{}\n(x)', 'function f() {}\n(x)', 'class C {}\n[0]', '@dec class C {}\n(x)', 'async\nfunction f() {}\n(x)',
      'if (a) {}\n(x)', '({}).x;', '({ b(); }).x;', '(@dec class {}).x;', 'x = () => ({}).y;', 'let = 1;',
      'type = 1;', 'namespace.x;', 'declare(x);', 'abstract(x);', 'export using x = y;', 'export await using x = y;',
      // a `T?` is the postfix nullable only where no type starts after the `?` (tsc's isStartOfType)
      'let x: T?;', 'let x = y as T ? z : w;', 'type A = X extends Y ? T? : Z;', 'type A = [T?];', 'f(a as T?, b);',
      'let x: T?\nconst a = 1;', 'let x = y as T? -0x1 : U;', 'function f(): T?\nreturn {}', 'type A = { a: T?\nif : U };',
      'let x = y as T?\n(-z);', 'let x = y as T ? (-1) : 2;',
      // a union's constituent begins no `|`, an intersection's no `|` / `&` (tsc's type levels)
      'type T = | A | B;', 'type T = | & A;', 'type T = & A & B;', 'type T = A | & B & C;', 'type T = | (| A);', 'type T = [| A, & B];',
      // an arrow's type parameter list starts with a name or `const`; a declaration's may be empty
      'const f = <T,>() => 1;', 'const f = <const T>() => 1;', 'const f = async <out T>(a) => 1;', 'function f<>() {}',
      'type F = <>() => void;', 'class C { m<>() {} }',
    ],
    // Operators that require an assignment target or forbid a unary left operand.
    reject: ['interface {}', 'const x: = 1;', 'enum {}', 'a + ;',
      'type T = | | A;', 'type T = A | | B;', 'type T = A & | B;', 'type T = & & A;', 'type T = & | A;', 'f<| | A>();', 'let x: [| | A];',
      'const f = <>() => 1;', 'const f = async <>(a) => 1;', 'const f = <in T>() => 1;', 'f(<in out T>(a) => a);', ...REBIND.ts.reject, ...CAP_PROPAGATION.reject, ...NO_IN_HEADS.reject, ...FOR_HEADS.reject, ...RESERVED_EXPRS.reject, ...CALL_ARGS.reject, ...EXPORT_DECLS.reject, ...CTX_CASES.typescript.reject, ...TS_DECORATORS.reject, ...TEMPLATE_STEPS.ts.reject, ...TS_MEMBER_DECORATORS.reject, ...TS_MODULES.reject, ...TRY_STATEMENTS.reject, ...TS_TRY.reject, 'for (var a!: T;;);', 'for (let a!: T of b);',
      '{ a: 1 }.x;', '{} .b;', '{}\n.b;', '{} = b;', '{ function () {} }', 'if (a) {} = b;', 'L: {}.x;', 'do {}\n(x)\nwhile (y)',
      '{ b(); }.x;', '{ static x }.y;', '{ static x }', '@dec class {}.x;', '@dec class C {}.x;', 'class C {}.name;',
      'let[0] = 1;', '(async\nfunction f() {});',
      'import defer * from "m";', 'import defer * as from "m";',
      'let x: T? !;', 'let x = y as T? -0x1;', 'function f(): T?\n... {}', 'type A = { a: T?\n() };', 'let x: T? string;', 'let x: T?\nin;',
      'a + b = 1;', 'a < b = 1;', 'a in b = 1;', 'a as T = 1;', '-x = 1;', 'x++ = 1;', '++x++;', '++-x;', '++ ++x;', '-x ** 2;', 'typeof x ** 2;', 'm > B<C> >>= 1;',
      'x\n++\n++\ny;', 'x\n++\n++y;', 'x\n--\n--\ny;', 'x\n++\n--\ny;', 'var z =\nx\n++\n++\ny;',
      'function f() { return x\n++\n++\ny; }', 'f()\n++\n++\ny;', 'a[0]\n--\n--y;', '{ x\n++\n++\ny }',
      'x\n++;', 'x\n--', '(x\n++);', 'a = [x\n++];', 'x\n++\n-y;', 'x\n++\ny++;', 'x\n++ ++y;', 'x ++ ++\ny;', 'class C { p = x\n++ }', 'class C { p = x\n++\ny }',
      // Only an access tail extends an access tail.
      'a = x++.y;', '-B<C>.d;', 'x as T (1);', 'x = B<C>.d;', 'x = B<C>?.d;',
      'x = B<C> < 1;', 'x = B<C> >= 1;', 'x = B<C>!;', 'x = B<C> /re/;',
      // A refused operand is not skipped where the expression is optional or repeated.
      'a = [++ ++y];', '[++-x];', '[++x++];', 'a = [1, ++-x];', 'f(++ ++y);', 'f(a, ++ ++y);', 'new A(++ ++y);', 'f<T>(++ ++y);',
      '[x++ ++];', 'f(a, x++ --);', '[-x = 1];', 'f(a + b = 1);', '[-x ** 2];', 'f(a, typeof x ** 2);', 'x = { a: ++ ++y };', 'class C { p = ++ ++y }',
      'f(class extends a + b {});', 'f(class extends void a {});', 'f(class extends class {});', 'f(class extends if {});',
      'a > > b;', 'a >> = b;', 'a >\n= b;', 'a >>>>= b;',
      // Once a word is the member's name, nothing but the member's own tail may follow it.
      'class C { static static x; }', 'class C { public static<T> x; }', 'class C { public static?!: T; }', 'class C { public static x y; }', 'class C { public static = ; }',
      'x = { public static x y };', 'x = { public static: };', 'x = { public static() x };', 'x = { static public: 1 2 };',
      // `x is T` outside a return type; a predicate subject other than an identifier / `this`;
      // a line break before `is`.
      'var x: y is string;', 'function f(x: y is string) { }', 'class C { p: x is T; }', 'type A = x is T;',
      'type A = (x is T);', 'type A = U | x is T;', 'var v = y as x is T;', 'function f(x: any): (x is T) { }',
      'type A = this[] is T;', 'type A = (this) is T;', 'type A = void is T;', 'type A = this is T is U;',
      'function f(x: any): this is x is T { }', 'function f(x: any): x is y is T { }',
      'var x: this\n is string;', 'function f(): this\n is string { }', 'function f(x: any): x\n is string { }',
      'class C { p: this is }', 'var v = y as this is;', 'function f(x: any): void is T { }', 'function f(x: any): class is T { }',
      // A hole holds what its template's reference declares, nothing else.
      'x = `a${T[]}b`;', 'type X = `a${1 + 1}b`;', 'new `a${T[]}b`;', 'new a`x`?.b;', 'new a<T>`x`?.b;',
      // An import-equals right-hand side is no expression: no literal, `this`, `new`, keyword
      // segment, private name, optional chain or non-null tail.
      'import r = new x;', 'import r = new a.b();', 'import r = this;', 'import r = null;', 'import r = 1;', 'import r = "m";',
      'import r = (a);', 'import r = a.default;', 'import r = a.if;', 'import r = a.#p;', 'import r = a?.b;', 'import r = a!;',
      'export import r = this.x;', 'import type r = new x;', 'namespace N { import r = a.default }',
      // ... nor is a body-less declaration followed by a statement on its line.
      'type A = B C;', 'declare function f() g()', 'declare module "x" foo()', 'export as namespace N foo()',
      'export default a b', 'export * from "m" foo()', 'export type { A } b()', 'export = a b',
      'import a from "m" foo()', 'import "m" foo()', 'function f() g()', 'import r = a.b("x");', 'import rect = module("rect");',
      'export * as ns from "m" foo()', 'export type * from "m" foo()', 'import type A from "m" foo()', 'import type r = require("x") foo()',
      'export { a } from "m" b()', '@dec using x = y foo()', 'public using x = y foo()', 'export default function (): void g()',
      'function f(): void type B = C', 'namespace N { type A = B C }', 'declare module "m" { export = a b }',
      // `export default class` is a declaration, not a class expression with a tail.
      'export default class {}.x', 'export default class C {}\n.x;',
      // A word left alone on its line is a property of its own, so the next member needs a separator.
      'x = { public\nx() {} };', 'x = { public\nx: 1 };', 'x = { async\nx() {} };', 'x = { readonly\n[k]: 1 };', 'x = { static public\nx: 1 };',
      // `export` is no modifier before `*` / `as`; `get` / `set` before a name is the accessor keyword.
      'class C { export *g() {} }', 'class C { export as() {} }', 'class C { get\nx = 1; }', 'class C { async get\nx = 1; }',
      'class C { public @dec x() {} }', 'class C { export @dec x() {} }', 'class C { default x() {} }',
      // One `static` per member, on either side of `async`; a field's `!` sits on its line.
      'class C { static\nstatic x = 1; }', 'class C { static async static x = 1; }', 'class C { async static static x() {} }',
      'x = { static static x: 1 };', 'class C { x\n!: T; }', 'class C { async public\n!: T; }',
      'x = { static async static m() {} };', 'x = { async static static m() {} };', 'x = { static static async m() {} };',
      // An object-literal member: `async` on its line before the name; a shorthand is a
      // non-reserved identifier, alone; a method or accessor without a body ends as a statement
      // does, before a `,` only past a line break; `await` is the operator in an async method.
      'x = { static async\nm() {} };', 'x = { async\nx: 1 };', 'x = { async *g };', 'x = { static class };', 'x = { async class };',
      'x = { static [a, b] };', 'x = { [a, b] };', 'x = { [a,]: 1 };', 'x = { a!? };', 'x = { static a!? };', 'x = { static async x y };',
      'x = { m(), n: 1 };', 'x = { m(); n: 1 };', 'x = { get x(), y: 1 };', 'x = { m() n() };',
      'x = { static async m() { await; } };', 'x = { async static m() { await = 1 } };', 'x = { static async *g() { await; } };',
      'x = { public async m() { await = 1 } };',
      // Two members on one line need a separator: a body-less method, accessor or constructor
      // ends as a statement does; a type member ends in `,`, `;`, a line break or `}`.
      'class C { m() n() }', 'class C { foo() x; }', 'class C { m(): void m() {} }', 'class C { get g() set s(v) {} }',
      'class C { constructor() x }', 'declare class C { m() n() }', 'abstract class C { abstract m() n() }',
      '(class { *g() h() {} })', 'class C { async m() x }', 'class C { m() /* c */ n() }', 'class C { x, y }',
      'interface I { a b }', 'interface I { a: B c: D }', 'interface I { const private; }', 'interface I { p: x is T q: U }',
      'interface I { (): void x }', 'interface I { m(): void n(): void }', 'interface I { [k: string]: T x }',
      'interface I { a: T;; }', 'interface I { a,, }', 'type A = { a b }', 'type A = { a: T;; }',
      'interface I { public a b }', 'interface I { readonly get g(): T }', 'interface I { const a }', 'interface I { static static a }',
      // ... in a type literal as in an interface body. A block-bodied accessor needs nothing after
      // it, and a `;` there is no member; `get` before a name is the accessor keyword; past the
      // modifier words before it (line breaks included) an accessor is no member start.
      'type A = { public a b }', 'type A = { readonly get g(): T }', 'type A = { static static a }', 'var x: { const a };',
      'type A = { get g() {}; }', 'type A = { get g() {}, }', 'type A = { get\nx: T }', 'type A = { get g }',
      'type A = { public\nget g(): T }', 'interface I { public\nget g(): T }', 'interface I { readonly public\nget g(): T }',
      'type A = { export default: T }', 'interface I { export default: T }', 'class C { export default: T }', 'x = { export default: 1 };',
      // `default` before anything but a declaration keyword is the member's name; so is `export`
      // before such a `default`, or before a `type` that no member start other than `as` / `*`
      // follows; `const` outside a class body is no modifier but before `enum`.
      'class C { default abstract\nclass() {} }', 'class C { default async\nfunction() {} }', 'interface I { default default: T }',
      'class C { export default default: T }', 'class C { default static {} }', 'x = { default x: 1 };', 'type A = { default enum: T };',
      'type A = { export type: T };', 'interface I { export type?: T }', 'class C { export type() {} }', 'class C { export type\nas() {} }',
      'class C { export type *g() {} }', 'interface I { export type as: T }', 'x = { export type: 1 };', 'x = { export type\nas: 1 };',
      'interface I { export type x: T }', 'interface I { const x: T }', 'x = { const x: 1 };', 'type A = { const const: T };',
      'x = { const\nx: 1 };', 'interface I { export const x: T }', 'interface I { const enum x: T }',
      // A mapped type ends in a statement end, not a `,`, and takes no other `+` / `-`; a member
      // takes neither.
      'type A = { [K in T]: U, }', 'type A = { -[K in T]: U }', 'type A = { [K in T]-: U }', 'type A = { +readonly [k: string]: T }',
      'interface I { -readonly [K in T]-?: U }', 'type A = { a: T; -readonly [K in T]: U }', 'interface I { static [K in T]-?: U }',
      'type A = { [K in T]: U a: T }', 'type A = { p: x is T }', 'interface I { p: x is T; q: U }',
      // Only a property signature takes an initializer, and only one that starts as a member: a
      // bare name followed on its line by `=` does not; nor does a method, call / construct or
      // index signature, accessor or mapped type. The initializer is one assignment expression.
      'type A = { a = 1 }', "type A = { 's' = 1 }", 'type A = { 0 = 1 }', 'type A = { #p = 1 }', 'type A = { static a = 1 }',
      'type A = { readonly = 1 }', 'type A = { public get = 1 }', 'interface I { a = 1, b: T }', 'type A = { a; b = 1 }',
      'type A = { m(): T = 1 }', 'type A = { (): T = 1 }', 'type A = { new (): T = 1 }', 'interface I { [k: string]: T = 1 }',
      'type A = { get g(): T = 1 }', 'type A = { get a = 1 }', 'type A = { [K in T]: U = 1 }', 'type A = { a: T = }',
      'type A = { a: T = 1 b: U }', 'interface I { a: T == 1 }', 'type A = { a: T = 1 = }', 'type A = { a: T = x\n++y }',
      // A bracket that starts as an index signature is one, in a class as in an object type, so
      // it is neither a computed name (`[async x => x]`) nor a method, field or accessor name, and
      // it ends as a type member does. One that does not start so is no parameter list.
      'class C { [a, b](): T }', 'class C { [a?](): T }', 'class C { [k: T]() {} }', 'class C { async [k: T]() {} }',
      'class C { [a: T] = 1 }', 'class C { [a, b] = 1 }', 'class C { [k: T]!: U }', 'class C { [k: T]?: U }', 'class C { async [k: T]: U x }',
      'class C { [async x => x]: T }', 'class C { async [async x => x]() {} }', 'interface I { [async x => x]: T }', 'type A = { [async x => x](): T }',
      'class C { get [k: T]: U }', 'class C { [{ a }: T]: U }', 'interface I { [{ a }: T]: U }', 'class C { [k: T] {} }', 'class C { [k: T]<U>(): V }',
      // No parameter list takes a reserved word as a name: not a function's, method's, accessor's
      // or constructor's, not a function or constructor type's, not a call, construct, method or
      // index signature's, nor after a modifier or decorator.
      'function f(in) {}', 'function f(if: T) {}', 'class C { m(in) {} }', 'type F = (in: T) => U;', 'type F = (typeof: T) => U;',
      'type F = new (class: T) => U;', 'interface I { [in: T]: U }', 'class C { async [in: T]: U }', 'interface I { (in: T): U }',
      'interface I { new (var: T): U }', 'interface I { m(do?: T): U }', 'class C { [const: T]: U }', 'declare function f(in: T): void;',
      'class C { constructor(readonly default: T) {} }', 'function f(@d if) {}', 'type F = (a: T, delete: U) => V;',
      'abstract class C { abstract m(super: T): void }', 'x = (in: T) => 1;', 'class C { set s(null) {} }',
      // A JSDoc function type's list holds types: no name, annotation, default, decorator or
      // modifier, and a `this` / `new` label takes its `:`.
      'type F = function (a: T): U;', 'type F = function (a = 1): U;', 'type F = function (@d a): U;',
      'type F = function (public a): U;', 'type F = function (this): U;',
      // No import binding, `infer` or mapped-type name is a reserved word.
      'import if from "m";', 'import type in from "m";', 'import * as do from "m";', 'import type * as do from "m";',
      'import { a as if } from "m";', 'import { type a as if } from "m";', 'import { type if } from "m";',
      'import { if } from "m";', 'import type do = require("m");', 'import defer * as in from "m";',
      'import while = require("m");', 'type T = A extends infer if ? 1 : 0;', 'type T = A extends [infer in extends string] ? 1 : 0;',
      'type T = { [if in K]: 1 };'],
  },
  // Element regions (docs/REGIONS.md): the portable lexers' frame stack against the interpreter's
  // lexer. Text children, attribute strings, holes, templates in holes, type arguments on a tag,
  // nested elements after `=`, an element as a value for the regex test, and TypeScript's
  // type-parameter vetoes: the head (`<T,>`), and the signature the lexer decides by lexing its
  // group as code (kept: `<T>(x: T) => x`; an element: `<b>(it's)</b>`, a lex error in the group).
  {
    grammar: 'typescriptreact', path: '../typescriptreact.ts',
    accept: [
      // a template literal type in a tag's type arguments: its closer brings the tag frame back on top
      'x = <C<`a${string}`> />;', 'x = <C<`a${string}b`>>t</C>;',
      'x = <a b="c" d={e}>t {f} <g/> h</a>;', 'x = <></>;', 'x = a < b > c;', 'x = <a>{`t${<b/>}`}</a>;',
      'f = <T,>(x: T) => x;', 'f = <T extends U>(x: T) => x;', 'f = <T>(x: T) => x;', 'f = <T>(x): T => x;',
      "x = <b>(it's)</b>;", 'x = <b>(x) y</b>;', 'type F = <T>(x: T) => T;', 'x = <List<string>>t</List>;',
      'x = <a>{ {} }</a>;', 'x = <a b="\\" />;', 'if (a) <a/>; else <b></b>', 'x = <T>(x: <U>() => U) => x;',
      'x = <a>{/* c */}</a>;', 'x = (<a/>) / 2;', 'x = <a/> / 2 / 3;', 'x = <a>{(<b/>)}</a>;', 'let f: <T>(x: T) => T;',
      'x = <a>text\nmore</a>;', 'let m = new Map</* c */string, X>();', 'const x: number = 1;',
      // children text that spells a literal is text, never that literal (region tokens carry no
      // literal id): each parses differently, or not at all, where the text is taken as the literal
      "x = <a>if (x) {'{'}</a>;", 'x = <a>return</a>;', 'x = <a>function</a>;', 'x = <a>;</a>;', 'x = <a>class</a>;',
      'x = <a>{b}if{c}</a>;', 'x = <a><b>{c};</b>)</a>;', 'x = <a>as</a> as T;', 'x = <a>,</a>, 1;',
    ],
    reject: ['x = <a>=></a>;', 'x = <a x=<b/> />;', 'x = <a>}</a>;', 'x = <a>></a>;', 'x = <b>{x}</b>\n/re/.test(y);', 'x = <a/>\n<b/>;', 'x = <a>;', 'x = </a>;',
      // lexer errors: at the last character, inside a template hole inside an element hole, inside
      // an undecided type-parameter signature, and inside one nested in another (the outer's verdict)
      'x = <a/>;#', 'x = <a>{`${<b>{`${"}`}</b>}`}</a>;', 'f = <T,>(x: #', 'f = <T,>(x: <U,>(#', 'f = <T,>(x: <U,>(y: `${#'],
  },
  {
    grammar: 'javascriptreact', path: '../javascriptreact.ts',
    accept: [
      'x = <a b="c" d={e}>t {f} <g/> h</a>;', 'x = <></>;', 'x = a < b > c;', 'x = <a>{`t${<b/>}`}</a>;',
      "x = <b>(it's)</b>;", 'x = <a>{ {} }</a>;', 'if (a) <a/>; else <b></b>', 'x = (<a/>) / 2;', 'x = <a/> / 2 / 3;',
      "let a = <><p>It's</p>{`${<b/>}`}</>;\nx</*c*/y;", 'x = <a.b c:d="e" {...f}/>;',
      // children text that spells a literal is text, never that literal (region tokens carry no
      // literal id): each parses differently, or not at all, where the text is taken as the literal
      "x = <a>if (x) {'{'}</a>;", 'x = <a>return</a>;', 'x = <a>function</a>;', 'x = <a>;</a>;', 'x = <a>class</a>;',
      'x = <a>{b}if{c}</a>;', 'x = <a><b>{c};</b>)</a>;', 'x = <a>,</a>, 1;',
    ],
    reject: ['x = <a>}</a>;', 'x = <a>;', 'x = </a>;', 'f = <T,>(x) => x;', 'x = <a>=></a>;', 'x = <a>as</a> as T;',
      'x = <a/>;#', 'x = <a>{`${<b>{`${"}`}</b>}`}</a>;', 'x = <a b={`${#`}/>;'],
  },
  {
    // code children, and the derived entry: every `<` in code opens an element
    grammar: 'elementdialect', path: './fixtures/elementdialect.ts',
    accept: [
      'component C(a) {\n  <a k="v">@if (a) { <b/> } @else { "e" } {a}</a> "z" <c/>\n}',
      'component D() { <a><b>{1}</b><{t} id="d">"s"</{t}></a> }\ncomponent E() { "q" }',
      // a raw body is one token whatever it spells (a directive, a keyword, a closer, a hole), next to code children
      'component C() { <style>@if (a) { </style> }', 'component C() { <style>component</style> <a>@if (b) { <c/> }</a> }',
      'component C() { <a><style>}</style>"t"</a> }', 'component C() { <style>{a}</style> }', 'component C() { <style>x</STYLE></style> }',
    ],
    reject: ['component C() { /> }', 'component C() { </a> }', 'component C() { <a> }', 'component C() { <STYLE>x</STYLE> }', 'component C() { <style>x }'],
  },
  {
    // a tag token that fails where the ordinary scan then lexes (`'` with no closing quote on its
    // line): its failed read is a read past the next tokens' ends (test/fixtures/tagtokdialect.ts)
    grammar: 'tagtokdialect', path: './fixtures/tagtokdialect.ts',
    accept: ["<a k='v w' m=n'/>\n<b/>", "<a k=n'>{x}</a>", '<a k="s"><b/>{(y)\'}</a>\n{z\'}'],
    reject: ["<a k='v>", "<a k='v/>", "x'"],
  },
  {
    // the text dialect's tag start (`<` opens a tag only before a tagStart unit: in text any other
    // is text, in code the operator) and raw text whose body condition (`unlessBodyStarts`) makes
    // `<style>{a}</style>` an element with a hole (test/fixtures/textdialect.ts, without its text
    // tokens and directives)
    grammar: 'textdialect-tagstart', path: './fixtures/textdialect.ts', parts: { textTokens: false, directives: false },
    accept: [
      'component C(a) { <p>1 < 2 > 0</p>; <p>a<9 a <</p>; <p>< b</p>; }', 'component C(a) { <p>1<b/>2<>3</><{a}>x</{a}><_a/><$b/></p> }',
      'component C(a) { const c = a <c; return <p>x</p>; }', 'component C(a) { <p>1 < 2 <b>x</b> a<9 <></> <{a}>y</{a}></p>; }',
      'component C(a) { <p k={<b/>} m={a}/>; }',
      'component C() { <style>.a { b: c } <i></style>; <style>{a}</style>; <style> \n\t{a}</style>; <style>x{a}</style> }',
      'component C() { <style>/* c */{a}</style>; <style>  </style>; <script>{a}</script>; <SCRIPT>if (a<b) x</Script> }',
      'component C() { <STYLE>{a}</STYLE>; <STYLE>.a</STYLE>; <style></style>; <style/>; <p><style>{a}</style></p> }',
    ],
    reject: ['component C(a) { const b = < p/>; }', 'component C(a) { const b = < 1; }', 'component C(a) { <a/> <b/> }', 'component C() { <style>{.a}</style> }', 'component C() { <style>.a{}', 'component C(a) { <p k=< b>x</p> }', 'component C(a) { <p k=<b/>/> }'],
  },
  {
    // and comments in text (`textTokens`): `/* */` anywhere in a run, `//` at a run's start or after
    // a blank; an unterminated `/*` is text (its failed attempt reads to the end: a recorded read)
    grammar: 'textdialect-text', path: './fixtures/textdialect.ts', parts: { textTokens: true, directives: false },
    accept: [
      'component C(a) { <p>a/* c */b</p>; <p>hi // note\n x</p>; <p>a//b https://x.dev</p>; }',
      'component C(a) { <p><b>z</b>// n\n</p>; <p>{a}// n\n</p>; <p>a // </p>\n</p>; <p>q /*</p>; }',
      'component C(a) { <p>/* only */</p>; <p>/* a */// b\n</p>; const b = 1; // c\n/* d */ return b; }',
      'component C(a) { <p>hi // note\n a/* c */b <b>z</b>// n\n a//b</p>; <p>1 < 2 /* x */ <b/>a<9</p>; }',
      'component C() { <style>/* c */{a}</style>; }',
    ],
    reject: ['component C(a) { <p>a // </p> }', 'component C(a) { <p>a /* </p> */ }', 'component C() { <p>a<//* c */b>x</b></p> }'],
  },
  {
    // the whole text dialect: and directives (derived openers, heads lexed as code, bodies lexed as
    // children, continuations after a body; a code block): test/fixtures/textdialect.ts
    grammar: 'textdialect', path: './fixtures/textdialect.ts',
    accept: [
      'component C(a) { <p>@if (a) {y}</p>; <p>@if x</p>; <p>@iffy (a)</p>; <p>a@if (a) {y}</p>; <p>x y@if (a) {z}</p>; }',
      'component C(a) { <p>@for await (i of a) {y}</p>; <p>@for awaits (i)</p>; <p>@{ const q = 1; <b/> }</p>; }',
      'component C(a) { <p>@if /* c */ (a) {y}</p>; <p>@if // c\n (a) {y}</p>; <p>a @else {b}</p>; }',
      'component C(a) { <p>@if ({a}.a) { y }</p>; <p>@if ([{a}][0]) { y }</p>; }',
      'component C(a) { <p>@if (a) {y} @else {n}</p>; <p>@if (a) {y} @else if (a) {m} @else {n}</p>; <p>@if (a) {y} @else x</p>; }',
      'component C(a) { <p>@if (a) {y} @elsewhere {n}</p>; <p>@if (a) {y} t @else {n}</p>; <p>@else {n}</p>; }',
      'component C(a) { <p>@for (i of a) {<i>{i}</i>} @empty {none} @try {t} @pending {p} @catch (e) {c} @try {t} @catch (e) {c}</p>; }',
      'component C(a) { <p>@if (a) { <b>@for (i of a) { {i} // n\n }</b> } @else { /* c */ x }</p>; }',
      'component C(a) { <p>@{ const q = 1; <b/> } x</p>; <p>x @if (a) { yes <b/> } @else if (a) {m} @else { no } z</p>; }',
      'component C(a) { <p>@if (a) { <style>.a{}</style><style>{a}</style> } 1 < 2 /* c */ a // d\n</p>; }',
      'component C(a) { <p>@if (a) {y} @else /* {n}</p>; }',
    ],
    reject: ['component C(a) { <p>@if (a) {y</p>; }', 'component C(a) { <p>@if (a) { </q> y }</p>; }', 'component C(a) { <p>a } b</p>; }',
      'component C(a) { <p>@if (<b/>) {y}</p>; }'],
  },
  {
    // directives without text tokens: an opener's or a continuation's read through a comment left
    // open in its trivia is the only record of that read (with text tokens the comment is also a
    // text token's failed attempt, recorded as its own)
    grammar: 'textdialect-dir', path: './fixtures/textdialect.ts', parts: { textTokens: false, directives: true },
    accept: [
      'component C(a) { <p>@if (a) {y}</p>; <p>@if x</p>; <p>@iffy (a)</p>; <p>a@if (a) {y}</p>; <p>x y@if (a) {z}</p>; }',
      'component C(a) { <p>@for await (i of a) {y}</p>; <p>@for awaits (i)</p>; <p>@{ const q = 1; <b/> }</p>; }',
      'component C(a) { <p>@if /* c */ (a) {y}</p>; <p>@if // c\n (a) {y}</p>; <p>a @else {b}</p>; }',
      'component C(a) { <p>@if ({a}.a) { y }</p>; <p>@if ([{a}][0]) { y }</p>; }',
      'component C(a) { <p>@if (a) {y} @else {n}</p>; <p>@if (a) {y} @else if (a) {m} @else {n}</p>; <p>@if (a) {y} @else x</p>; }',
      'component C(a) { <p>@if (a) {y} @elsewhere {n}</p>; <p>@if (a) {y} t @else {n}</p>; <p>@else {n}</p>; }',
      'component C(a) { <p>@for (i of a) {<i>{i}</i>} @empty {none} @try {t} @pending {p} @catch (e) {c} @try {t} @catch (e) {c}</p>; }',
      'component C(a) { <p>@if (a) { <b>@for (i of a) { {i} // n\n }</b> } @else { /* c */ x }</p>; }',
      'component C(a) { <p>@{ const q = 1; <b/> } x</p>; <p>x @if (a) { yes <b/> } @else if (a) {m} @else { no } z</p>; }',
      'component C(a) { <p>@if (a) { <style>.a{}</style><style>{a}</style> } 1 < 2 /* c */ a // d\n</p>; }',
      'component C(a) { <p>@if (a) {y} @else /* {n}</p>; }',
    ],
    reject: ['component C(a) { <p>@if (a) {y</p>; }', 'component C(a) { <p>@if (a) { </q> y }</p>; }', 'component C(a) { <p>a } b</p>; }',
      'component C(a) { <p>@if (<b/>) {y}</p>; }'],
  },
];
