// Gate: the TARGET-AGNOSTIC emitter (issue #6) — `emitParser(grammar, target)`
// derives a parser in EACH target language that accepts/rejects the same inputs the
// interpreter (createParser) does. The agnosticism proof by EXECUTION: every grammar is
// rendered to TypeScript, Go, and Rust; the Go/Rust sources are COMPILED and RUN, and each
// parser's accept/reject outcome is compared against the createParser oracle over an
// adversarial corpus (accept-parity on valid input, reject-parity on malformed input).
//
// The gate checks ACCEPT/REJECT PARITY, not byte-identical CST: the portable targets are
// free to use a different internal node shape (arena, compressed CST) as long as they agree
// with the oracle on what parses and what fails. A small CST-shape snapshot on tiny inputs
// guards against accidental semantic drift within a single target run.
//
// Each grammar is checked twice: on its hand-written accept/reject lists below, and on the
// PARITY CORPUS (test/parity-corpus.ts — the generated inputs, their one-token mutants, the
// refused-operand matrix and the token edges that cst-text-invariant.ts runs the interpreter and
// the emitted parser on). A hand-written list holds the inputs someone thought of; the corpus
// holds the ones the grammar derives, and every engine must give each of them the oracle's
// verdict and, when it accepts, the oracle's rule skeleton — and every lexer must give each of
// them the oracle lexer's token stream (kind, text, newline-before; text rather than offsets,
// whose units differ by target), or fail on it as the oracle lexer does.
//
//   - calc:   operator precedence/associativity, prefix unary, nested grouping.
//   - minijs: a real JavaScript SUBSET — a string/comment lexer, the full operator ladder,
//             call/member/index chains, arrays, and statement forms (the grammar the Go/Rust
//             output is benchmarked against oxc with).
//
// The javascript case also runs a Unicode corpus (non-ASCII accept/reject with lexer messages,
// edits next to multi-byte characters) on the same three parsers.
//
// Go/Rust toolchains are optional: a missing `go`/`rustc` is logged and skipped (the TS
// rendering, which needs only node, always runs).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createParser } from '../src/gen-parser.ts';
import { compileTokenizer, lexSpecOf } from '../src/emit-lexer.ts';
import { emitParser, jsTarget, tsTarget, goTarget, rustTarget } from '../src/emit.ts';
import { objectify } from './emitted-obj.ts';
import { buildLexIdPlan, portableIR } from '../src/emit-portable.ts';
import { asGoMain } from './go-main.ts';
import { parityInputs, type Tok } from './parity-corpus.ts';
import { CTX_CASES, CTX_DOCS, ctxEdits } from './context-cases.ts';
import { goBuild, scratchDir } from './scratch.ts';
import type { CstGrammar } from '../src/types.ts';

type Case = { grammar: string; path: string; accept: string[]; reject: string[]; tsOnly?: boolean };
// A for-head's no-`in` region (`exclude('in', Expr)`, a `suppress` step): it holds for the Pratt call
// it wraps, a nested call (parentheses, arguments, an object, array or template, a function or arrow
// block body) has `in` again, and every alternative of the head that fails inside or after it backs
// out of it. Each verdict is tsc's parser's too.
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
const CASES: Case[] = [
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
    ],
    reject: ['for (x y) z;', 'for x in y;', 'for (in y) z;', 'for (x in) z;'],
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
      'x = a.new / 2 / 3;', 'x = a.default / b / c;', 'x = a?.typeof / 2 / 3;', 'x = a.return / 2 / 3;', 'class C { #x = 1; m() { return this.#x / 2 / 3; } }',
      'function f() { return /re/.test(x); }', 'x = typeof /re/;', 'switch (a) { case /re/: break; }',
      'x.y.z++;', '(a++).b;', 'a++ instanceof B;', 'a++\n(x);',
      'for (a in b) c;',
      'for (a = x in b) c;',
      'for (a in b) { d = c in e; }',
      'new a.b();', '((((x))));',
      'for (a = x + y in b) c;',
      ...NO_IN_HEADS.accept, ...FOR_HEADS.accept, ...RESERVED_EXPRS.accept, ...EXPORT_DECLS.accept,
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
      // `export <statement>`, an expression statement over a `let` with no binding, the
      // `yield` form over the prefix operator when it reaches farther.
      'export default function () {}', 'export default function f() {}', 'export default class {}',
      'export default 1 + 2;', 'let * aa;', 'let => aa;', 'function* g() { yield a + b; yield; yield* o; yield x++; }',
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
      // … and on a tie the earliest-declared: `yield x++` is the prefix operator's node, which no
      // postfix or `**` may take as its operand.
      'function* g() { yield x++ ++; }', 'function* g() { yield x++ --; }', 'function* g() { yield -x ** 2; }',
      '1 + () => 2;', 'a++.b;', 'f(a, b,',
      // … so nothing after a line break is a postfix operator: `x\n++\n++\ny` is `x; ++ ++y`,
      // `x\n++` is `x; ++`, and `(x\n++)` leaves `++` with no operand.
      'x\n++\n++\ny;', 'x\n++\n++y;', 'x\n--\n--\ny;', 'x\n++\n--\ny;', 'var z =\nx\n++\n++\ny;',
      'function f() { return x\n++\n++\ny; }', 'f()\n++\n++\ny;', 'a[0]\n--\n--y;', '{ x\n++\n++\ny }',
      'x\n++;', 'x\n--', '(x\n++);', 'a = [x\n++];', 'x\n++\n-y;', 'x\n++\ny++;', 'x\n++ ++y;', 'class C { p = x\n++ }', 'class C { p = x\n++\ny }',
      'for (a = (x in b)) c;',
      'for (a = b ? x in c : y in d) e;',
      ...NO_IN_HEADS.reject, ...FOR_HEADS.reject, ...RESERVED_EXPRS.reject, ...EXPORT_DECLS.reject,
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
      ...NO_IN_HEADS.accept, ...FOR_HEADS.accept, ...RESERVED_EXPRS.accept, ...EXPORT_DECLS.accept, 'for (let a: T of b); for (var a: T in b); for (var a: T = 1;;);',
      'export default /re/.test(x);', 'export default /=/;', 'switch (a) { default: /re/.test(x); }',
      // ... but as a member name a keyword is a value and a `/` after it divides, as after a private name
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
      'const f = <>() => 1;', 'const f = async <>(a) => 1;', 'const f = <in T>() => 1;', 'f(<in out T>(a) => a);', ...NO_IN_HEADS.reject, ...FOR_HEADS.reject, ...RESERVED_EXPRS.reject, ...EXPORT_DECLS.reject, ...CTX_CASES.typescript.reject, ...TS_DECORATORS.reject, ...TEMPLATE_STEPS.ts.reject, ...TS_MEMBER_DECORATORS.reject, ...TS_MODULES.reject, ...TRY_STATEMENTS.reject, ...TS_TRY.reject, 'for (var a!: T;;);', 'for (let a!: T of b);',
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
      'x = <a b="c" d={e}>t {f} <g/> h</a>;', 'x = <></>;', 'x = a < b > c;', 'x = <a>{`t${<b/>}`}</a>;',
      'f = <T,>(x: T) => x;', 'f = <T extends U>(x: T) => x;', 'f = <T>(x: T) => x;', 'f = <T>(x): T => x;',
      "x = <b>(it's)</b>;", 'x = <b>(x) y</b>;', 'type F = <T>(x: T) => T;', 'x = <List<string>>t</List>;',
      'x = <a>{ {} }</a>;', 'x = <a b="\\" />;', 'if (a) <a/>; else <b></b>', 'x = <T>(x: <U>() => U) => x;',
      'x = <a>{/* c */}</a>;', 'x = (<a/>) / 2;', 'x = <a/> / 2 / 3;', 'x = <a>{(<b/>)}</a>;', 'let f: <T>(x: T) => T;',
      'x = <a>text\nmore</a>;', 'let m = new Map</* c */string, X>();', 'const x: number = 1;',
    ],
    reject: ['x = <a x=<b/> />;', 'x = <a>}</a>;', 'x = <a>></a>;', 'x = <b>{x}</b>\n/re/.test(y);', 'x = <a/>\n<b/>;', 'x = <a>;', 'x = </a>;'],
  },
  {
    grammar: 'javascriptreact', path: '../javascriptreact.ts',
    accept: [
      'x = <a b="c" d={e}>t {f} <g/> h</a>;', 'x = <></>;', 'x = a < b > c;', 'x = <a>{`t${<b/>}`}</a>;',
      "x = <b>(it's)</b>;", 'x = <a>{ {} }</a>;', 'if (a) <a/>; else <b></b>', 'x = (<a/>) / 2;', 'x = <a/> / 2 / 3;',
      "let a = <><p>It's</p>{`${<b/>}`}</>;\nx</*c*/y;", 'x = <a.b c:d="e" {...f}/>;',
    ],
    reject: ['x = <a>}</a>;', 'x = <a>;', 'x = </a>;', 'f = <T,>(x) => x;'],
  },
  {
    // code children, and the derived entry: every `<` in code opens an element
    grammar: 'elementdialect', path: './fixtures/elementdialect.ts',
    accept: [
      'component C(a) {\n  <a k="v">@if (a) { <b/> } @else { "e" } {a}</a> "z" <c/>\n}',
      'component D() { <a><b>{1}</b><{t} id="d">"s"</{t}></a> }\ncomponent E() { "q" }',
    ],
    reject: ['component C() { /> }', 'component C() { </a> }', 'component C() { <a> }'],
  },
];
// The element-region grammars' cases may be run alone: PORTABLE_GRAMMARS=a,b (a development aid;
// the gate runs every case).
const ONLY = process.env.PORTABLE_GRAMMARS?.split(',');

// tsc's JSX conformance cases (each `// @filename` part one input), when the pinned corpus is present.
const JSX_GRAMMARS = new Set(['typescriptreact', 'javascriptreact']);
const JSX_CORPUS = '/tmp/ts-repo/tests/cases/conformance/jsx';
function jsxCorpus(): string[] {
  if (!existsSync(JSX_CORPUS)) { console.log(`  (no ${JSX_CORPUS}: the JSX conformance parity inputs are skipped)`); return []; }
  return readdirSync(JSX_CORPUS).sort().flatMap((f) => readFileSync(`${JSX_CORPUS}/${f}`, 'utf8').split(/^\/\/\s*@filename:.*$/im));
}
const sortKeys = (o: unknown): unknown =>
  Array.isArray(o) ? o.map(sortKeys)
  : (o && typeof o === 'object') ? Object.fromEntries(Object.keys(o as object).sort().map((k) => [k, sortKeys((o as Record<string, unknown>)[k])]))
  : o;
const canon = (o: unknown) => JSON.stringify(sortKeys(o));

// Rule-node skeleton: the tree of rule labels with all leaves (trivia/punct/semantic tokens)
// stripped. Two CSTs that differ only in their leaves — e.g. after Phase 5's trivia compression
// — share a skeleton; a semantic restructure (a node relabeled, merged, or dropped) does not.
// A node is a RULE node iff it carries a non-empty `rule` label (Rust leaves use rule:""; TS
// leaves omit the key entirely), so this is target-agnostic over the canon'd JSON.
const skelObj = (o: unknown): unknown => {
  if (Array.isArray(o)) return o.map(skelObj).filter((x) => x !== null);
  if (o && typeof o === 'object') {
    const r = (o as { rule?: string }).rule;
    if (r && r !== '') return { r, k: skelObj((o as { children?: unknown }).children ?? []) };
  }
  return null;
};
const skeleton = (cstStr: string) => skelObj(JSON.parse(cstStr));

const TMP = scratchDir('portable-targets');
const have = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { stdio: 'pipe' }); return true; } catch { return false; } };
const HAS_GO = have('go', ['version']);
const HAS_RUST = have('rustc', ['--version']);
if (!HAS_GO) console.log('  go: (toolchain absent — skipped)');
if (!HAS_RUST) console.log('  rust: (toolchain absent — skipped)');

type Outcome = { ok: true; cst: string } | { ok: false; err?: string };
function runProc(cmd: string, args: string[], src: string): Outcome {
  const r = spawnSync(cmd, args, { input: src, encoding: 'utf8', maxBuffer: 32 << 20 });
  if (r.status !== 0) return { ok: false, err: r.stderr ?? '' };
  try { return { ok: true, cst: canon(JSON.parse(r.stdout)) }; }
  catch { return { ok: false, err: 'bad json' }; }
}
function runTokSpans(cmd: string, args: string[], src: string): string | null {
  const r = spawnSync(cmd, args, { input: src, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout;
}
// A native runner's `batch` mode: NUL-separated inputs in, one line per input out — the CST
// JSON, "-" for a rejected input, "!" and the message for a lexer error. An input holding a NUL
// cannot travel that way and runs alone.
function runBatch(cmd: string, srcs: string[]): Outcome[] {
  const sent = srcs.filter((s) => !s.includes('\0'));
  const r = spawnSync(cmd, ['batch'], { input: sent.join('\0'), encoding: 'utf8', maxBuffer: 1 << 30 });
  const lines = (r.stdout ?? '').split('\n');
  if (r.status !== 0 || lines.length !== sent.length + 1) {
    throw new Error(`${cmd} batch: exit ${r.status}, ${lines.length - 1} lines for ${sent.length} inputs\n${(r.stderr ?? '').slice(0, 2000)}`);
  }
  let li = 0;
  return srcs.map((src): Outcome => {
    if (src.includes('\0')) return runProc(cmd, [], src);
    const line = lines[li++];
    if (line === '-') return { ok: false };
    if (line.startsWith('!')) return { ok: false, err: line.slice(1) };
    return { ok: true, cst: canon(JSON.parse(line)) };
  });
}
// rescanChecks / rescanRepairs: the Doc's totals of fresh lexes that checked a relex (a rejected parse,
// a lexer error) and of those that replaced the relexed stream: a relex defect the Doc repaired.
type Align = { oldN: number; newN: number; prefix: number; suffix: number; relexed?: number; reused?: number; rescanChecks?: number; rescanRepairs?: number; streamEq?: boolean; treeEq?: boolean };
type EditOutcome = Outcome & { align?: Align };
function parseAlignStderr(stderr: string): Align | undefined {
  for (const line of stderr.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t) as Align; } catch { /* keep scanning */ }
  }
  return undefined;
}
function runEditSession(cmd: string, args: string[], json: string): EditOutcome {
  const r = spawnSync(cmd, args, { input: json, encoding: 'utf8', maxBuffer: 32 << 20 });
  const align = parseAlignStderr(r.stderr ?? '');
  if (r.status !== 0) return { ok: false, align, err: r.stderr ?? '' };
  try {
    return { ok: true, cst: canon(JSON.parse(r.stdout)), align };
  } catch { return { ok: false, align, err: 'bad json' }; }
}

// The ts target's library runs in this process: one module load per grammar instead of one
// node start per input. Go/Rust run their emitted CLI runner per input (a native start is ~1 ms).
type TsDoc = { edit(edits: { start: number; end: number; text: string }[]): unknown; align(): unknown; root(): unknown };
type TsLib = {
  parse(src: string): unknown; tokenize(src: string): { kind: string; text: string; nl: boolean; lid: number }[];
  createDoc(src: string, opts: { validate?: boolean; builder?: unknown }): TsDoc;
  /** The library's lid_of, exported by the gate (TS_LID_OF) — the id a Doc gives a rebuilt token. */
  __lid_of(text: string): number;
};
// The gate's one addition to the imported ts library: its lid_of, which the runners' lid-of mode
// exposes for go / rust.
const TS_LID_OF = '\nexport const __lid_of = lid_of;\n';
// A builder that keeps nothing but shifts, so a ts Doc given it takes the builder engine.
const TS_PROBE_BUILDER = { leaf: () => 1, node: () => 1, shift: (h: number) => h };
const errText = (e: unknown) => String((e as Error)?.message ?? e);
function tsRun(lib: TsLib, src: string): Outcome {
  try {
    const root = lib.parse(src);
    return root === null ? { ok: false } : { ok: true, cst: canon(root) };
  } catch (e) { return { ok: false, err: errText(e) }; }
}
function tsEditSession(lib: TsLib, json: string, fast: boolean): EditOutcome {
  let doc: TsDoc, a: unknown;
  try {
    const { init, batches } = JSON.parse(json) as { init: string; batches: EditBatch[] };
    doc = lib.createDoc(init, { validate: !fast });
    for (const batch of batches) doc.edit(batch.map(([start, end, text]) => ({ start, end, text })));
    a = doc.align();
  } catch (e) { return { ok: false, err: errText(e) }; }
  // Through JSON, as the CLI runner reports it: a field left undefined is absent.
  const align = a ? JSON.parse(JSON.stringify(a)) as Align : undefined;
  try {
    const root = doc.root();
    return root === null ? { ok: false, align } : { ok: true, cst: canon(root), align };
  } catch (e) { return { ok: false, align, err: errText(e) }; }
}

// A token stream as JSON rows [kind, text, newline-before, lid], or null for a lexer error.
type TokStream = string | null;
/** The rows without their lid: what the oracle lexer (which has no literal ids) also gives. */
const unLid = (t: TokStream): TokStream => (t === null || t === 'NUL' ? t : JSON.stringify((JSON.parse(t) as unknown[][]).map((r) => r.slice(0, 3))));
function tokBatch(cmd: string, srcs: string[]): TokStream[] {
  const sent = srcs.filter((s) => !s.includes('\0'));
  const r = spawnSync(cmd, ['batch-tokens'], { input: sent.join('\0'), encoding: 'utf8', maxBuffer: 1 << 30 });
  const lines = (r.stdout ?? '').split('\n');
  if (r.status !== 0 || lines.length !== sent.length + 1) {
    throw new Error(`${cmd} batch-tokens: exit ${r.status}, ${lines.length - 1} lines for ${sent.length} inputs\n${(r.stderr ?? '').slice(0, 2000)}`);
  }
  let li = 0;
  return srcs.map((src): TokStream => {
    if (src.includes('\0')) return 'NUL';
    const line = lines[li++];
    return line.startsWith('!') ? null : JSON.stringify(JSON.parse(line));
  });
}
const tsTokens = (lib: TsLib, src: string): TokStream => {
  try { return JSON.stringify(lib.tokenize(src).map((t) => [t.kind, t.text, t.nl, t.lid])); } catch { return null; }
};
// The Doc path: each input typed into an empty Doc in one edit, so the whole text is parsed from
// tokens the Doc rebuilds from its metadata. One outcome per input (a rejection carries no message).
function docBatch(cmd: string, mode: string, srcs: string[]): (string | null)[] {
  const sent = srcs.filter((s) => !s.includes('\0'));
  const r = spawnSync(cmd, [mode], { input: sent.join('\0'), encoding: 'utf8', maxBuffer: 1 << 30 });
  const lines = (r.stdout ?? '').split('\n');
  if (r.status !== 0 || lines.length !== sent.length + 1) {
    throw new Error(`${cmd} ${mode}: exit ${r.status}, ${lines.length - 1} lines for ${sent.length} inputs\n${(r.stderr ?? '').slice(0, 2000)}`);
  }
  let li = 0;
  return srcs.map((src) => (src.includes('\0') ? 'NUL' : lines[li++]!));
}
const docOutcomes = (lines: (string | null)[]): Outcome[] => lines.map((l) => (l === '-' || l === null ? { ok: false } : l === 'NUL' ? { ok: false, err: 'NUL' } : { ok: true, cst: canon(JSON.parse(l)) }));
const verdicts = (lines: (string | null)[]): (boolean | null)[] => lines.map((l) => (l === 'NUL' ? null : l === '+'));
function lidBatch(cmd: string, texts: string[]): number[] {
  const r = spawnSync(cmd, ['lid-of'], { input: texts.join('\0'), encoding: 'utf8', maxBuffer: 1 << 30 });
  const lines = (r.stdout ?? '').split('\n');
  if (r.status !== 0 || lines.length !== texts.length + 1) throw new Error(`${cmd} lid-of: exit ${r.status}, ${lines.length - 1} lines for ${texts.length} texts\n${(r.stderr ?? '').slice(0, 2000)}`);
  return lines.slice(0, -1).map(Number);
}
function tsDoc(lib: TsLib, src: string, builder: boolean): { ok: boolean; cst?: string } {
  try {
    const doc = builder ? lib.createDoc('', { builder: TS_PROBE_BUILDER }) : lib.createDoc('');
    doc.edit([{ start: 0, end: 0, text: src }]);
    const root = doc.root();
    return root === null ? { ok: false } : builder ? { ok: true } : { ok: true, cst: canon(root) };
  } catch { return { ok: false }; }
}

type Runner = {
  label: string;
  run: (src: string) => Outcome;
  /** `run` over a whole corpus: one outcome per input, in order. */
  batch: (srcs: string[]) => Outcome[];
  /** The lexer alone over a whole corpus. */
  tokens: (srcs: string[]) => TokStream[];
  /** Each input typed into an empty CST Doc ("-" rejected, else its CST JSON). */
  doc: (srcs: string[]) => Outcome[];
  /** The same through the builder Doc, where the target has one apart from the CST Doc: accepted or not. */
  docBuilder?: (srcs: string[]) => (boolean | null)[];
  /** The target's lid_of over texts. */
  lidOf: (texts: string[]) => number[];
  edit: (json: string, fast: boolean) => EditOutcome;
  spans: { cmd: string; args: string[] };
  /** Doc.edit offsets are UTF-8 bytes (go/rust), not UTF-16 units (ts). */
  utf8Edits: boolean;
};

type AlignMeta = { kind: string; off: number; end: number; nl: boolean };
const oracleToks = (g: CstGrammar, src: string): AlignMeta[] => {
  const tokenize = compileTokenizer(lexSpecOf(g));
  return tokenize(src).map((t) => ({ kind: t.type, off: t.offset, end: t.offset + t.text.length, nl: t.newlineBefore }));
};
const computeAlign = (oldText: string, oldToks: AlignMeta[], newText: string, newToks: AlignMeta[]): Align => {
  const oldN = oldToks.length, newN = newToks.length;
  let prefix = 0;
  while (prefix < oldN && prefix < newN) {
    const o = oldToks[prefix], n = newToks[prefix];
    if (o.kind !== n.kind || o.off !== n.off || o.end !== n.end || o.nl !== n.nl) break;
    if (oldText.slice(o.off, o.end) !== newText.slice(n.off, n.end)) break;
    prefix++;
  }
  const delta = newText.length - oldText.length;
  const minN = Math.min(oldN, newN);
  let suffix = 0;
  while (prefix + suffix < minN) {
    const o = oldToks[oldN - 1 - suffix], n = newToks[newN - 1 - suffix];
    if (o.kind !== n.kind || o.nl !== n.nl || n.off !== o.off + delta || n.end !== o.end + delta) break;
    if (oldText.slice(o.off, o.end) !== newText.slice(n.off, n.end)) break;
    suffix++;
  }
  return { oldN, newN, prefix, suffix };
};
const expectAlign = (g: CstGrammar, init: string, batches: EditBatch[]): Align => {
  let text = init;
  for (let i = 0; i < batches.length - 1; i++) for (const [s, e, r] of batches[i]) text = text.slice(0, s) + r + text.slice(e);
  const oldText = text;
  const batch = batches[batches.length - 1];
  for (const [s, e, r] of batch) text = text.slice(0, s) + r + text.slice(e);
  return computeAlign(oldText, oracleToks(g, oldText), text, oracleToks(g, text));
};

type EditBatch = [number, number, string][];
type EditScenario = {
  init: string;
  batches: EditBatch[];
  large?: boolean;
  maxRelexed?: number;
  fullRelex?: boolean;
  /** Minimum reused top-level kids (tree reuse) — all targets. */
  minReused?: number;
  /** Exact reused count — all targets. */
  reused?: number;
  /** Reused must be strictly less than this (lookahead / ext gate) — all targets. */
  maxReused?: number;
  /** Long arena session: assert treeEq after every cumulative batch prefix. */
  longSession?: boolean;
};
const calcLargeInit = '1+2*3+'.repeat(199) + '1+2*3';
const calcReuseInit = Array.from({ length: 40 }, (_, i) => `let x${i}=${i};`).join('\n');
const calcReuseMid = calcReuseInit.indexOf('let x20=') + 'let x20='.length;
const calcReuseFirstEq = calcReuseInit.indexOf('=') + 1;
const calcReuseLastEq = calcReuseInit.lastIndexOf('=') + 1;
const calcReuseSemi = calcReuseInit.indexOf(';');
const calcLongInit = Array.from({ length: 80 }, (_, i) => `let y${i}=${i};`).join('\n');
const calcLongBatches: EditBatch[] = Array.from({ length: 24 }, (_, i) => {
  const needle = `let y${i}=`;
  const at = calcLongInit.indexOf(needle) + needle.length;
  return [[at, at + 1, String((i * 7 + 3) % 10)]] as EditBatch;
});
const envspecLargeInit = 'A=1\n'.repeat(300);
const envReuseInit = Array.from({ length: 40 }, (_, i) => `K${i}=${i}`).join('\n');
const envReuseMid = envReuseInit.indexOf('K20=') + 'K20='.length;
const envReuseFirstEq = envReuseInit.indexOf('=') + 1;
const envReuseLastEq = envReuseInit.lastIndexOf('=') + 1;
const envFlowInit = 'A=1\nB=fn(a,\nb)\nC=3';
const envFlowEdit = envFlowInit.indexOf('fn(a') + 'fn('.length; // 'a' inside hanging flow stmt
const envMultiBatches: EditBatch[] = [
  [[envReuseMid, envReuseMid + 1, '9']],
  [[envReuseInit.indexOf('K5=') + 'K5='.length, envReuseInit.indexOf('K5=') + 'K5='.length + 1, '7']],
  [[envReuseLastEq, envReuseLastEq + 1, '8']],
];
// Shape-B adopted Seg.Ext must shift with tokDelta: insert-front (adopt suffix) then poke a later
// value whose align.prefix sits in the stale-ext..shifted-ext window — unshifted Ext over-reuses.
const envSegExtInit = Array.from({ length: 8 }, (_, i) => `K${i}=${i}`).join('\n');
const envSegExtIns = 'Z=9\n';
const envSegExtPoke = envSegExtInit.indexOf('K3=') + 'K3='.length + envSegExtIns.length;
const regexjsLargeInit = 'var r = /abc/g; a / b;\n'.repeat(60);
const regexjsAfterParen = 'if (a) /b/g; c / d / e;';
const tplLargeInit = ('`a${x}b`; f(1);\n').repeat(50);
const jsLargeInit = ('var r = /a/g; `t${x}u`; f(1);\n').repeat(40);
const jsLargeEdit = jsLargeInit.indexOf('f(1)', 600) + 2;
const jsLookaheadInit = 'let x = (a)\nfoo;\nbar;';
const jsLookaheadEdit = jsLookaheadInit.indexOf('\n') + 1; // first char of peeked-into second stmt
// Edits that move a body in and out of an async / generator function, and keystrokes inside and
// around such bodies (test/context-cases.ts): one session per document, the tree ≡ a fresh parse
// after every batch.
const CTX_EDITS: EditScenario[] = CTX_DOCS.map((init) => ({ init, batches: ctxEdits(init).map((e): EditBatch => [[e.start, e.end, e.text]]), longSession: true }));
// Documents for the exhaustive one-character edits (above the edit sessions): template holes, and
// a `/` decided by what follows it.
const HOLE_EDIT_GRAMMARS = new Set(['javascript', 'typescript']);
// Element regions share the frame stack: text, tags, holes, templates in holes, a type-parameter
// signature decided by lexing its group (an edit can flip it), an attribute string, `</*` outside
// elements, code children with directives and a dynamic tag (as test/incremental-grammars.ts).
const FRAME_INS = ['`', '$', '{', '}', '(', ')', '<', '>', '/', ':', ',', '=', 'x', ' ', '\n', '"', "'", '\\'];
const FRAME_EDIT_DOCS: Record<string, string[]> = {
  typescriptreact: [
    "let a = <p>It's {x} 50%</p>;\nlet b = 1;",
    'f(<a b={c > d}><i/>t</a>, `x${<b>y</b>}`);',
    'type F = <T>(x: T) => T;\nlet g = <T,>(y: T) => <q>{y}</q>;',
    'let h = <T>(x: T) => x; z = 1;',
    'let m = new Map</* c */string, X>();',
    'let a = <a b="\\" c=\'d\ne\'>t</a>;\nlet z = "q";',
  ],
  javascriptreact: ['let s = `a${b}c${`${d}`}`;\nx = 1;', "let a = <><p>It's</p>{`${<b/>}`}</>;\nx</*c*/y;", 'x = <a/> / 2; y = <b c={1}>t</b>;'],
  elementdialect: [
    'component C(a) {\n  <a k="v">@if (a) { <b/> } @else { "e" } {a}</a> "z" <c/>\n}',
    'component D() { <a><b>{1}</b><{t} id="d">"s"</{t}></a> }\ncomponent E() { "q" }',
  ],
};
const HOLE_EDIT_DOCS = [
  'f(a, `x${b + c}`);',
  'let q = 1;\nf(`x${(b)}y${c}`);',
  'g(`a${`b${c}d`}e`, 1);',
  'h(`${ {a: "}"}.a }${\'`\'}`);',
  'k(`${a // c\n}`);',
  // A `/` whose kind (regex or division) is decided by text after it: a regex attempt that
  // fails falls back to division, so an edit later on can change it.
  'let m = f() < / 2;',
  'x = y / z / w;',
  'if (f() < /re/.test(s)) g();',
  // Whether `/` after `)` is a regex or a division depends on the keyword before the matching `(`:
  // an edit to the keyword changes how text to its right lexes.
  'if (q) /r/.test(s);',
  'ifx (q) / r / 2;',
  'while (a) /re/;',
];
// Documents whose tokens are decided by reading past their end + 1, each with the texts inserted
// at every offset (and every character deleted): a number that tried a longer form and backed
// up (`1._x`), a run of such tries (`1._1_1_x`), an insertion right after the last unit such a
// read cannot pass (`x = 1.` + `_5`, `a = 0` + `xF`), an identifier escape, a block comment left
// open (its attempt reads to the end of the source and falls back to `/`).
const LOOK_EDIT_DOCS: { doc: string; ins: string[] }[] = [
  { doc: 'x = 1._x;', ins: ['5', '_', 'x', '.'] },
  { doc: 'x = 1._1_1_x;', ins: ['5', '_'] },
  // `1._` backs up to `1` (its fraction tried `._`); inserting a digit after `_` makes one number.
  { doc: 'x = 1._ ;', ins: ['5', '1'] },
  { doc: 'x = 1._1_ ;', ins: ['5'] },
  { doc: 'x = 1.', ins: ['_5', '_', '5', 'e'] },
  { doc: 'a = 0', ins: ['xF', 'x', 'F', 'n'] },
  { doc: 'a = 1', ins: ['e+5', 'e5', 'e+'] },
  { doc: 'x = a\\u0041;', ins: ['b', '{', '}', '\\', 'u'] },
  { doc: 'x = y /* c', ins: ['*/', '*', '/'] },
  { doc: 'x = y / 2; /* c\nz', ins: ['*/', '/'] },
];
// Edits whose relexed stream is known to differ from a fresh lex, each with its cause; the gate
// fails when one passes.
const HOLE_EDIT_EXPECTED_FAIL: { doc: string; edit: [number, number, string]; reason: string }[] = [];
// Insert each of a few characters that open, close or end something at every offset, and delete
// every character.
function oneCharEdits(doc: string, ins: string[] = ['x', ' ', '}', '{', '`', '$', '/']): [number, number, string][] {
  const out: [number, number, string][] = [];
  for (let at = 0; at <= doc.length; at++) {
    for (const ch of ins) out.push([at, at, ch]);
    if (at < doc.length) out.push([at, at + 1, '']);
  }
  return out;
}
const EDIT_SCENARIOS: Record<string, EditScenario[]> = {
  calc: [
    { init: '1+2*3', batches: [[[3, 3, '4']]] },
    { init: '1+2*3', batches: [[[1, 3, '']]] },
    { init: '1+2*3', batches: [[[2, 5, '(7-8)']]] },
    { init: '1+2*3', batches: [[[0, 0, '9-']], [[7, 8, '']]] },
    { init: calcLargeInit, batches: [[[600, 601, '9']]], large: true, maxRelexed: 8 },
    { init: '1 2;', batches: [[[1, 2, '']]] },
    { init: calcLargeInit, batches: [[[calcLargeInit.length, calcLargeInit.length, '+4']]], maxRelexed: 5 },
    { init: calcLargeInit, batches: [[[0, 1, '9']]], maxRelexed: 8 },
    // S7b tree-reuse scenarios
    { init: calcReuseInit, batches: [[[calcReuseMid, calcReuseMid + 1, '9']]], minReused: 30 },
    { init: calcReuseInit, batches: [[[calcReuseFirstEq, calcReuseFirstEq + 1, '9']]], minReused: 1 },
    { init: calcReuseInit, batches: [[[calcReuseLastEq, calcReuseLastEq + 1, '9']]], minReused: 1 },
    { init: calcReuseInit, batches: [[[calcReuseSemi - 1, calcReuseSemi + 1, '9;']]], minReused: 1 },
    { init: calcReuseInit, batches: [[[calcReuseMid, calcReuseMid + 1, '9']], [[calcReuseMid, calcReuseMid + 1, '8']]], minReused: 30 },
    // Boundary-hit must be exact (===): merging b;c via `;`→`+` lands on `d`; a `>=` mutant would adopt too early.
    { init: 'a;\nb;\nc;\nd;', batches: [[[4, 5, '+']]] },
    // Mid overshoot past suffix candidates → tryReuseTop fails, full-parse fallback (reused:0) still ≡ fresh.
    { init: 'a;\nb;\nc;\nd;', batches: [[[7, 8, '+']]], reused: 0 },
    // S7c long arena session: ≥20 continuous edits; each cumulative prefix treeEq + final ≡ fresh.
    { init: calcLongInit, batches: calcLongBatches, longSession: true, minReused: 1 },
    // Reject-then-edit: batch 1 breaks the doc; batch 2 must not resurrect a partial old
    // tree via reuse (a Go parse wrapper without the full-consumption guard did exactly that).
    { init: 'let a = 1;\nlet b = 2;\nlet c = 3;', batches: [[[19, 20, '']], [[29, 30, '4']]], reused: 0 },
    // Reject-then-repair: same setup, batch 2 restores validity; must parse fresh (reused:0) ≡ fresh.
    { init: 'let a = 1;\nlet b = 2;\nlet c = 3;', batches: [[[19, 20, '']], [[19, 19, '2']]], reused: 0 },
    // Relex across the edit merges tokens (`12`+`34` → `1234`): resync only after the merge.
    { init: '12+34+56', batches: [[[2, 3, '']]] },
  ],
  javascript: [
    { init: 'let a = 1;\nf(a);', batches: [[[8, 9, '42']]] },
    { init: 'let a = 1;\nf(a);', batches: [[[11, 16, '']]] },
    { init: 'let a = 1;\nf(a);', batches: [[[4, 5, 'b'], [12, 13, 'b']]] },
    { init: 'let a = 1;\nf(a);', batches: [[[16, 16, '\ng(b);']], [[0, 4, 'var']]] },
    { init: 'let a = 1;\nf(a);\n'.repeat(80), batches: [[[688, 689, '9']]], large: true, maxRelexed: 15 },
    { init: 'var q = `x${a/b}y`;', batches: [[[12, 13, 'c']]] },
    // predecessor peeked into second stmt (ext > tokEnd); editing that region must not keep stmt0
    { init: jsLookaheadInit, batches: [[[jsLookaheadEdit, jsLookaheadEdit + 1, '+']]], maxReused: 1 },
    // Same-text token re-entering at template depth 1 must not resync (see templatejs).
    { init: 'a = {b} // `\n;', batches: [[[4, 5, '`${']]] },
    // Edit inside a hole: regex/division state and template depth both resume from the anchor.
    { init: 'a; `b${x}c`; d / e / f;', batches: [[[7, 8, 'g / h']]] },
    // Division → regex flip far from the edit; suffix adoption needs equal prev-token/paren state.
    { init: 'x = a / b / c; `t${y}u`;', batches: [[[4, 6, '']]] },
    { init: jsLargeInit, batches: [[[jsLargeEdit, jsLargeEdit + 1, '9']]], large: true, maxRelexed: 15 },
    ...CTX_EDITS,
  ],
  // The same edits of the [Await]/[Yield] context (test/context-cases.ts) on the typescript grammar.
  typescript: [
    ...CTX_EDITS,
  ],
  templatejs: [
    { init: '`a${x}b`;', batches: [[[4, 5, 'y']]] },
    { init: '`a${ {x} }b`;', batches: [[[6, 7, 'y']]] },
    { init: '`a${x}b`;', batches: [[[2, 4, '']]] },
    { init: '`a${x}b${y}c`;', batches: [[[6, 7, 'z']]] },
    { init: ('`a${x}b`; f(1);\n').repeat(50), batches: [[[600, 601, '9']]], large: true, maxRelexed: 15 },
    { init: '`a`; z; `b${x}c`;', batches: [[[5, 6, 'w']]] },
    // Removing a hole: the head/tail split of the first template disappears.
    { init: '`a${x}b` + c + `d${y}e`;', batches: [[[2, 6, '']]] },
    // Adding a hole next to an existing one: template depth after the edit differs from the old stream.
    { init: 'f(`a${x}b`, c);', batches: [[[8, 8, '${y}']]] },
    // `{` → `${`: the old `b` (td 0) reappears at the shifted offset inside a hole (td 1) with equal text —
    // adopting it would keep `}` as a brace; the comment-swallowed backtick keeps both texts lexable.
    { init: 'a = {b} // `\n;', batches: [[[4, 5, '`${']]] },
    // Edit inside the first hole: anchor search must back off to a td == 0 token, then resync.
    { init: tplLargeInit, batches: [[[3, 4, 'y']]], maxRelexed: 15 },
  ],
  envspec: [
    // Existing scenes — reused pinned from S8 measurement (was 0 under shape-A-only).
    { init: 'A=1\nB=2', batches: [[[2, 2, '3']]], minReused: 1 },
    { init: envspecLargeInit, batches: [[[600, 601, '9']]], large: true, maxRelexed: 10, minReused: 200 },
    // Comma→digit rejects the doc → full-parse fallback, reused:0.
    { init: 'A=fn(1,\n2)\nB=3', batches: [[[6, 7, '9']]], reused: 0 },
    { init: 'A=fn(1,\n2)\nB=3', batches: [[[4, 4, '(']]], reused: 0 },
    { init: 'A=1\n# note\nB=2', batches: [[[7, 7, 'x']]], minReused: 1 },
    { init: 'A=1\n\n\nB=2', batches: [[[4, 4, '\n']]], minReused: 1 },
    { init: 'A=1\nB=2\nC=3', batches: [[[3, 4, '\r\n\r\n']]] },
    { init: 'A=1\r\nB=2', batches: [[[4, 5, '']]] },
    { init: envspecLargeInit, batches: [[[envspecLargeInit.length, envspecLargeInit.length, 'Z=9']]], large: true, maxRelexed: 10, minReused: 200 },
    { init: 'A=fn(1,\n2)\nB=3', batches: [[[0, 0, 'X']], [[7, 7, '0']]], minReused: 1 },
    // S8 segment-reuse scenes
    { init: envReuseInit, batches: [[[envReuseMid, envReuseMid + 1, '9']]], minReused: 30 },
    { init: envReuseInit, batches: [[[envReuseFirstEq, envReuseFirstEq + 1, '9']]], minReused: 1 },
    { init: envReuseInit, batches: [[[envReuseLastEq, envReuseLastEq + 1, '9']]], minReused: 1 },
    { init: 'A=1\n\n\n\nB=2', batches: [[[4, 5, '']]], minReused: 1 }, // blank-line fold
    { init: 'A=1\n\nB=2', batches: [[[4, 4, '\n']]], minReused: 1 }, // blank-line expand
    { init: envFlowInit, batches: [[[envFlowEdit, envFlowEdit + 1, 'x']]], minReused: 2 }, // mid flow stmt; sides reused
    { init: envReuseInit, batches: envMultiBatches, longSession: true, minReused: 1 },
    // Go adopted Seg.Ext + tokDelta (pre-fix: reused 9 from stale keep-prefix watermarks).
    { init: envSegExtInit, batches: [[[0, 0, envSegExtIns]], [[envSegExtPoke, envSegExtPoke + 1, '9']]], reused: 8 },
    // Dropping a flow `(`: later tokens change flowDepth, so equal-text old tokens are not adopted.
    { init: 'A=fn(1,\n2)\nB=3\nC=4', batches: [[[4, 5, '']]] },
    // Opening a flow at the head swallows the next line break.
    { init: 'A=fn(1,\n2)\nB=3\nC=4', batches: [[[0, 0, 'X=g(\n']]] },
  ],
  envtpl: [
    { init: 'A=`x${B}y`\nC=2', batches: [[[6, 7, 'Q']]], fullRelex: true },
    { init: 'A=fn(`a`,\nb)\nB=`q${r}s`', batches: [[[4, 5, '']]], fullRelex: true },
    { init: 'A=1\nB=2', batches: [[[3, 3, '\nC=`z`']]], fullRelex: true },
  ],
  regexjs: [
    { init: 'var re = /[a-z]+/i; x / y;', batches: [[[11, 12, '0']]] },
    { init: 'x = a / b / c;', batches: [[[4, 6, '']]] },
    { init: 'if (x) /y/;', batches: [[[0, 2, 'f']]] },
    { init: regexjsLargeInit, batches: [[[600, 601, '9']]], large: true, maxRelexed: 15 },
    { init: 'f(x); a / b;', batches: [[[2, 2, '(']]] },
    { init: 'if (x) /y/;', batches: [[[11, 11, ' /z/;']]] },
    // `if (a)` → `f (a)`: the paren head flag flips, `/b/g` becomes division; adoption waits for equal state.
    { init: regexjsAfterParen, batches: [[[0, 2, 'f']]] },
    // `(a) / b` → `if (a) / b`: the reverse flip.
    { init: '(a) / b / c; d / e;', batches: [[[0, 0, 'if ']]] },
    // Edit at the head of a large doc: resume right after it.
    { init: regexjsLargeInit, batches: [[[4, 5, 's']]], maxRelexed: 15 },
  ],
};
const applyEdits = (init: string, batches: EditBatch[]): string => {
  let text = init;
  for (const batch of batches) for (const [start, end, repl] of batch) text = text.slice(0, start) + repl + text.slice(end);
  return text;
};

// ── Unicode on the real javascript grammar ──
// Every target accepts the oracle's non-ASCII inputs (no panic / no silent reject) with the same
// rule skeleton, rejects what it rejects with the same primary lexer message, and an edit next
// to a multi-byte character (go/rust Doc.edit offsets are UTF-8 bytes) ≡ a fresh parse.
const UNICODE_ACCEPT: string[] = [
  // template head / middle / tail each carry non-ASCII
  'const head = `héllo`;',
  'const mid = `pré${x}süff`;',
  'const both = `頭${a}中${b}尾🎉`;',
  // comments
  '/* 多行注释 🚀 */\nconst a = 1;',
  '// кириллица коммент\nconst b = 2;',
  // string / regex
  'const s = "日本語🎉";',
  'const r = /[α-ω]+/u;',
  // CJK / emoji ZWJ / combining / 4-byte
  'const z = "👨‍👩‍👧‍👦";',
  'const c = "e\u0301";',
  'const u = "\u{1F600}";',
  'const mix = `café /* not comment */`;',
  'const line = "你好"; // 行尾é',
  // critical closed forms (guard against over-reject after unterminated fix)
  '/* abc */',
  '`cafe`',
  '"abc"',
  "const x = /* abc */ 1;",
  'const x = `cafe`;',
  'const x = "abc";',
  // Unicode whitespace between tokens (JS \s non-ASCII set) — interpreter skips these
  'const a =\u00A01;',              // NBSP
  'const b\u3000= 2;',              // ideographic space
  '\uFEFFconst c = 3;',             // BOM
  'const d\u2003=\u20024;',         // EM space / EN space
  'const e\u202F= 5;',              // narrow NBSP
  'const f\u1680= 6;',              // Ogham space mark
  'const g\u2000=\u200A7;',         // en-quad / hair space (range ends)
  // Unicode identifiers (ID_Start letters) — interpreter's \p{ID_Start} fallback
  'const \u03B1 = \u03B2;',         // α = β
  'const caf\u00E9 = 1;',           // precomposed é
  'const \u5909\u6570 = 42;',       // CJK identifier
  'let \u03C2 = \u03B1 + \u03B2;',  // Greek mix in expression
];

// Non-ASCII at and inside tokens, compared as token streams (kind, text, newline flag, literal id)
// in the parity corpus of the ECMAScript grammars: a lexer that tries at a non-ASCII byte only the
// candidates that can begin with one must still give the interpreter's tokens.
const NON_ASCII_LEX: string[] = [
  ...UNICODE_ACCEPT,
  'a\u2028b', 'a\u2029b', 'x\u00A0=\u00A0y;', '\uFEFFx\uFEFF;', 'a\u2028\u2029\u3000b', 'return\u2028x;',
  '/* é\u2028 */ x', '/* 日本 */ x\n// é\u2029\ny', '// a\u2028\nb', '/** ドキュメント\u2029 */ y', '/* — ’ … */ z', '// — ’ …\nz',
  'const r = /日本語/u.test(s);', 'x = a / 日 / b;', 'const t = `日本${変数}語 😀`;', "s = '日本\\'語' + \"é\";",
  'const 変数 = 関数(引数, ŉame);', 'let café = naïve + résumé;', 'é', '😀', 'a\u0301b', 'x\u200Cy', '#!é\nx',
  // Identifier characters by Unicode property, across scripts and planes: combining marks (Mn, Mc),
  // ZWJ, connector punctuation (Pc), Other_ID_Start / Other_ID_Continue, letter numbers (Nl),
  // astral ID_Start and ID_Continue, and characters that are letters but not ID_Start
  // (Pattern_Syntax U+2E2F) or symbols (U+2603), which start no identifier.
  'x\u200Dy', 'क्षत्रिय = 1;', 'a\u203Fb + \u2040', '℘ + ℮ + ゛', 'a\u00B7b', 'ⅰⅱ + Ⅻ', 'ab\u0903c',
  '𝑥 = 𝑦 + 1;', 'let 𐐀𐐁 = 1;', 'a\u{E0100}b', '_\u0301', '$\u200C', 'x\u{1F600}', '\u2E2F', 'a\u2E2Fb', 'x = \u2603;',
  'éa1 + a1é', 'α.β?.γ', 'x\u0301\u0301\u0301',
  // Identifier escapes, checked against the same classes: an escape must decode to an
  // IdentifierStart (first) or IdentifierPart character. Accepted: letters, a leading-zero
  // braced escape, a non-ASCII ID_Start, an astral one as a surrogate-pair escape (as the
  // interpreter decodes it), a combining mark after the first character, a private name.
  // Refused: NUL, a private-use and a non-character code point, a digit or combining mark first,
  // lone surrogates, a code point past U+10FFFF, a symbol, a digit-first private name.
  'a\\u0062c', '\\u{000000061}b', '\\u00e9t\\u00E9', '\\uD835\\uDC9C', 'x\\u{1D465}', 'a\\u0301', '#\\u0061 in o', 'class C { #\\u{61}b; }',
  '\\u0000', 'a\\uF000', 'a\\u{10FFFF}', '\\u0030a', '\\u0301a', 'a\\uD800', 'a\\uDC00b', '\\uD835\\u0041', 'a\\u{110000}', 'x\\u2603', 'class C { #\\u0030; }',
];

// Every LineTerminator (LF, CR, LS, PS, and CR LF) ends a line comment, a shebang and a
// triple-slash directive, sets the newline flag of the next token, and ends a regular expression
// (a refusal); compared as token streams in the parity corpus of the ECMAScript grammars.
const LINE_TERMINATORS: string[] = ['\n', '\r', '\u2028', '\u2029', '\r\n'].flatMap((t) => [
  `// c${t}x;`, `x // c${t}++y`, `a${t}// c${t}b`, `//${t}`, `// é${t}x`, `// \u2028 é \u2029${t}x`,
  `#! sh${t}x;`, `#!${t}x`, `/// <reference path="a" />${t}x;`, `/// <a${t}x`,
  `return // c${t}x;`, `x = y${t}// c${t}/re/g.exec(z)`, `/a${t}b/;`, `/[${t}]/;`, `/a/${t}/b/`,
  `x${t}++y`, `a = \`x${t}y\`;`, `a = \`\${b // c${t}}\`;`, `/* c${t} */ x`,
]);

/** Reject cases. `lexMsg` set ⇒ expect that primary lexer message (≡ oracle). */
const UNICODE_REJECT: { src: string; lexMsg: string | null }[] = [
  { src: '/* abc', lexMsg: null }, // unterminated block → `/`+`*` puncts → parse reject (not a lex throw)
  { src: '`cafe', lexMsg: 'Unterminated template literal at offset 5' },
  { src: '"abc', lexMsg: 'Unexpected character at offset 0: \'"\'' },
  { src: "'abc", lexMsg: "Unexpected character at offset 0: '''" },
  { src: 'const x = `cafe', lexMsg: 'Unterminated template literal at offset 15' },
  { src: 'const x = "abc', lexMsg: 'Unexpected character at offset 10: \'"\'' },
  // emoji is not ID_Start; ZWSP is not JS \s — all targets must reject (messages differ in
  // encoding of the offending char across targets, so no lexMsg pin)
  { src: 'const \u{1F600} = 1;', lexMsg: null },
  { src: 'const x\u200B= 1;', lexMsg: null },
];

// init = 'const x = "café";' — JS indices: " @10, c@11, a@12, f@13, é@14, "@15, ;@16
const UNICODE_EDITS: { name: string; init: string; batches: EditBatch[]; restores?: boolean; repairs?: string }[] = [
  { name: 'edit-before-multibyte', init: 'const x = "café";', batches: [[[14, 14, 'X']]] },
  { name: 'edit-replace-multibyte', init: 'const x = "café";', batches: [[[14, 15, 'e']]] },
  { name: 'edit-after-multibyte', init: 'const x = "café";', batches: [[[15, 15, '!']]] },
  // delete the closing backtick / `*/` → reject; restore → accept (edit ≡ fresh)
  { name: 'edit-unterm-template-restore', init: 'const x = `cafe`;', batches: [[[15, 16, '']], [[15, 15, '`']]], restores: true },
  // `/* abc ` without its `*/` lexes as `/`, `*`, `abc`: a `/` decided by text past its end (a block
  // comment attempt that fell back to division, reading to the end of the source), so no relex
  // anchor when `*/` comes back (relex-family.ts, the anchor rule).
  { name: 'edit-unterm-block-restore', init: '/* abc */\nconst a = 1;', batches: [[[7, 9, '']], [[7, 7, '*/']]], restores: true },
];

/** Primary lexer-error text shared with the generated lexer (emit-lexer.ts). */
function primaryLexMsg(err?: string): string | null {
  if (!err) return null;
  const u = err.match(/Unterminated template literal at offset \d+/);
  if (u) return u[0];
  const c = err.match(/Unexpected character at offset \d+: '[\s\S]'/);
  return c ? c[0] : null;
}
/** UTF-16 edit batches → the UTF-8 byte offsets go/rust Doc.edit takes. */
function toUtf8Batches(init: string, batches: EditBatch[]): EditBatch[] {
  const u8 = (s: string, jsIdx: number) => Buffer.byteLength(s.slice(0, jsIdx), 'utf8');
  let text = init;
  const out: EditBatch[] = [];
  for (const batch of batches) {
    const b: EditBatch = [];
    const sorted = [...batch].sort((a, c) => c[0] - a[0]);
    for (const [s, e, r] of sorted) b.push([u8(text, s), u8(text, e), r]);
    b.reverse();
    out.push(b);
    for (const [s, e, r] of batch) text = text.slice(0, s) + r + text.slice(e);
  }
  return out;
}

function unicodeParity(r: Runner, oracleOut: (src: string) => Outcome): void {
  let acc = 0, snap = 0;
  for (const src of UNICODE_ACCEPT) {
    const want = oracleOut(src);
    const got = r.run(src);
    if (!want.ok) {
      failures++;
      console.log(`  javascript/unicode: oracle REJECT unexpected on ${JSON.stringify(src)}`);
      continue;
    }
    if (!got.ok) {
      failures++;
      console.log(`  javascript/unicode/${r.label}: ACCEPT fail (panic/reject) on ${JSON.stringify(src)} err=${(got.err ?? '').slice(0, 240)}`);
      continue;
    }
    acc++;
    if (canon(skeleton(want.cst)) !== canon(skeleton(got.cst))) {
      snap++;
      failures++;
      console.log(`  javascript/unicode/${r.label}: SHAPE drift on ${JSON.stringify(src)}`);
    }
  }
  console.log(`  javascript/unicode/${r.label}: ${acc}/${UNICODE_ACCEPT.length} accept ≡ oracle${snap ? ` · ${snap} shape drift` : ''}`);

  let rej = 0;
  for (const { src, lexMsg } of UNICODE_REJECT) {
    const want = oracleOut(src);
    const got = r.run(src);
    if (want.ok || got.ok) {
      failures++;
      console.log(`  javascript/unicode/${r.label}: REJECT mismatch on ${JSON.stringify(src)} (oracle ok=${want.ok}, ${r.label} ok=${got.ok})`);
      continue;
    }
    if (lexMsg !== null) {
      const gotMsg = primaryLexMsg(got.err);
      const wantMsg = primaryLexMsg(want.err) ?? lexMsg;
      if (gotMsg !== wantMsg) {
        failures++;
        console.log(`  javascript/unicode/${r.label}: REJECT msg drift on ${JSON.stringify(src)}\n    want ${wantMsg}\n    got  ${gotMsg ?? got.err}`);
        continue;
      }
    }
    rej++;
  }
  console.log(`  javascript/unicode/${r.label}: ${rej}/${UNICODE_REJECT.length} reject ≡ oracle`);

  let editOk = 0;
  const payload = (init: string, batches: EditBatch[]) => JSON.stringify({ init, batches: r.utf8Edits ? toUtf8Batches(init, batches) : batches });
  for (const sc of UNICODE_EDITS) {
    // After the first batch alone, an unterminated-restore case must reject.
    if (sc.restores) {
      const mid = applyEdits(sc.init, sc.batches.slice(0, 1));
      const midEdit = r.edit(payload(sc.init, sc.batches.slice(0, 1)), false);
      const midFresh = r.run(mid);
      const midOracle = oracleOut(mid);
      if (midEdit.ok || midFresh.ok || midOracle.ok) {
        failures++;
        console.log(`  javascript/unicode/${r.label}: edit mid-state should reject (${sc.name}) mid=${JSON.stringify(mid)} edit=${midEdit.ok} fresh=${midFresh.ok} oracle=${midOracle.ok}`);
      }
    }
    const final = applyEdits(sc.init, sc.batches);
    const a = r.edit(payload(sc.init, sc.batches), false);
    const b = r.run(final);
    const o = oracleOut(final);
    if (!a.ok || !b.ok || !o.ok) {
      failures++;
      console.log(`  javascript/unicode/${r.label}: edit-session final should accept (${sc.name}) final=${JSON.stringify(final)} A ok=${a.ok} B ok=${b.ok} oracle ok=${o.ok} err=${(a.ok ? '' : a.err ?? '').slice(0, 240)}`);
    } else if (a.cst === b.cst) editOk++;
    else {
      failures++;
      console.log(`  javascript/unicode/${r.label}: edit-session mismatch (${sc.name}) final=${JSON.stringify(final)}`);
    }
    // A re-scan that replaced the relexed stream is a relex defect: only the listed ones may.
    const repaired = (a.align?.rescanRepairs ?? 0) > 0;
    if (repaired !== !!sc.repairs) {
      failures++;
      console.log(`  javascript/unicode/${r.label}: ${repaired ? `the Doc's re-scan repaired the relexed stream (${sc.name}): a relex defect` : `expected-fail passes now, remove it (${sc.repairs}): ${sc.name}`}`);
    }
  }
  console.log(`  javascript/unicode/${r.label}: ${editOk}/${UNICODE_EDITS.length} edit-sessions ≡ fresh`);
}

// The grammars the refused-operand matrix is written for.
const ECMASCRIPT = new Set(['javascript', 'typescript']);
// EXPECTED-FAIL on the parity corpus, still run and counted: inputs on which the portable
// parsers are known to disagree with the oracle, by cause. Each entry is owed as its own fix;
// when none of an entry's inputs disagrees any more the gate fails until the entry is removed.
// A disagreement on any input not listed here fails the gate.
// An entry names its inputs, or the oracle lexer error that selects them (`oracleLexError`),
// and the targets it holds for (all when absent).
type ExpectedFail = { grammars: string[]; reason: string; inputs?: string[]; oracleLexError?: RegExp; targets?: string[] };
const CORPUS_EXPECTED_FAIL: ExpectedFail[] = [
  {
    // Owed: the interpreter's Unicode identifier fallback (LX_UNI_IDENT, and the TS target's copy)
    // starts with [$_\p{ID_Start}], so an ASCII `$` the grammar's identifier pattern excludes is
    // an identifier there; Go and Rust enter the fallback only at a non-ASCII byte. Go / Rust
    // follow the identifier pattern; aligning the interpreter changes its lexing of every grammar
    // whose identifier pattern lacks `$` or `_` (envspec, html), which is the maintainer's call.
    grammars: ['envspec', 'envtpl'],
    reason: 'an ASCII `$` outside the identifier pattern is an identifier to the interpreter\'s Unicode fallback only',
    inputs: ['#\n$ x #\n$ x'],
    targets: ['go', 'rust'],
  },
];
let corpusMs = 0, corpusInputs = 0;

let failures = 0;
for (const c of CASES) {
  if (ONLY && !ONLY.includes(c.grammar)) continue;
  const grammar: CstGrammar = (await import(c.path)).default;
  const oracle = createParser(grammar);
  const oracleOut = (src: string): Outcome => {
    try { return { ok: true, cst: canon(oracle.parse(src)) }; } catch (e) { return { ok: false, err: errText(e) }; }
  };

  const dir = `${TMP}/${c.grammar}`;
  mkdirSync(dir, { recursive: true });
  const runners: Runner[] = [];

  // emitParser is the parser LIBRARY (exports a `parse` entry, no I/O); the executable CLI
  // runner (stdin → CST JSON) is the target's emitRunner(), assembled in HERE — the harness's
  // job, not the parser's. ts/rust append the runner to the library (one file); Go needs it as
  // a SEPARATE runner.go in the same `package main` (its import rules forbid appending inline).
  // The ts library is also imported on its own; its CLI runner serves only tok-spans, which reads
  // the parser cursor from inside the module.
  const tsLibSrc = emitParser(grammar, tsTarget);
  const tsFile = `${dir}/p.ts`;
  writeFileSync(tsFile, tsLibSrc + (tsTarget.emitRunner?.() ?? ''));
  writeFileSync(`${dir}/lib.ts`, tsLibSrc + TS_LID_OF);
  const tsLib = await import(`${dir}/lib.ts`) as TsLib;
  runners.push({
    label: 'typescript', run: (src) => tsRun(tsLib, src), batch: (srcs) => srcs.map((src) => tsRun(tsLib, src)), tokens: (srcs) => srcs.map((src) => tsTokens(tsLib, src)),
    doc: (srcs) => srcs.map((src) => tsDoc(tsLib, src, false) as Outcome), docBuilder: (srcs) => srcs.map((src) => tsDoc(tsLib, src, true).ok), lidOf: (texts) => texts.map((t) => tsLib.__lid_of(t)),
    edit: (json, fast) => tsEditSession(tsLib, json, fast),
    spans: { cmd: 'node', args: [tsFile, 'tok-spans'] }, utf8Edits: false,
  });

  if (HAS_GO && !c.tsOnly) {
    const gdir = `${dir}/go`; mkdirSync(gdir, { recursive: true });
    writeFileSync(`${gdir}/parser.go`, asGoMain(emitParser(grammar, goTarget)));
    writeFileSync(`${gdir}/runner.go`, goTarget.emitRunner?.() ?? '');
    writeFileSync(`${gdir}/go.mod`, 'module p\n\ngo 1.21\n');
    goBuild(['-o', `${gdir}/p`, '.'], { cwd: gdir });
    const bin = `${gdir}/p`;
    runners.push({
      label: 'go', run: (src) => runProc(bin, [], src), batch: (srcs) => runBatch(bin, srcs), tokens: (srcs) => tokBatch(bin, srcs),
      doc: (srcs) => docOutcomes(docBatch(bin, 'batch-doc', srcs)), docBuilder: (srcs) => verdicts(docBatch(bin, 'batch-doc-builder', srcs)), lidOf: (texts) => lidBatch(bin, texts),
      edit: (json, fast) => runEditSession(bin, [fast ? 'edit-session-fast' : 'edit-session'], json),
      spans: { cmd: bin, args: ['tok-spans'] }, utf8Edits: true,
    });
  }
  if (HAS_RUST && !c.tsOnly) {
    const rfile = `${dir}/main.rs`;
    const bin = `${dir}/pr`;
    writeFileSync(rfile, emitParser(grammar, rustTarget) + (rustTarget.emitRunner?.() ?? ''));
    execFileSync('rustc', ['-A', 'warnings', rfile, '-o', bin], { stdio: 'pipe' });
    runners.push({
      label: 'rust', run: (src) => runProc(bin, [], src), batch: (srcs) => runBatch(bin, srcs), tokens: (srcs) => tokBatch(bin, srcs),
      doc: (srcs) => docOutcomes(docBatch(bin, 'batch-doc', srcs)), lidOf: (texts) => lidBatch(bin, texts),
      edit: (json, fast) => runEditSession(bin, [fast ? 'edit-session-fast' : 'edit-session'], json),
      spans: { cmd: bin, args: ['tok-spans'] }, utf8Edits: true,
    });
  }

  // tok-spans: top-level kids record parse-consumption [tokStart, tokEnd); cross-target
  // identity + contiguous partition of the consumed token stream. Empty accept inputs are
  // still run (identity), but contiguous checks skip when there are no kids.
  // envspec: a Newline token spans its line break and occupies a token index like any other;
  // if contiguous ever fails here, partition by grammar with evidence rather than relaxing.
  {
    const spanRunners = runners.map((r) => ({ label: r.label, ...r.spans }));

    const parseSpans = (out: string) => {
      const lines = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd().split('\n').filter(Boolean);
      const totalLine = lines[lines.length - 1]!;
      const kids = lines.slice(0, -1).map((line) => {
        const [name, a, b] = line.split('\t');
        return { name: name!, tokStart: Number(a), tokEnd: Number(b) };
      });
      const [, , tot] = totalLine.split('\t');
      return { kids, total: Number(tot) };
    };
    const assertPartition = (src: string, out: string, label: string) => {
      const { kids, total } = parseSpans(out);
      if (kids.length === 0) {
        if (total !== 0) {
          failures++;
          console.log(`  ${c.grammar}/${label}: tok-spans empty kids but total=${total} on ${JSON.stringify(src)}`);
        }
        return;
      }
      if (kids[0]!.tokStart !== 0) {
        failures++;
        console.log(`  ${c.grammar}/${label}: tok-spans first tokStart want=0 got=${kids[0]!.tokStart} on ${JSON.stringify(src)}`);
      }
      if (kids[kids.length - 1]!.tokEnd !== total) {
        failures++;
        console.log(`  ${c.grammar}/${label}: tok-spans last tokEnd want=${total} got=${kids[kids.length - 1]!.tokEnd} on ${JSON.stringify(src)}`);
      }
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i]!;
        if (k.tokStart > k.tokEnd) {
          failures++;
          console.log(`  ${c.grammar}/${label}: tok-spans inverted span ${k.name} [${k.tokStart},${k.tokEnd}) on ${JSON.stringify(src)}`);
        }
        if (i > 0 && kids[i - 1]!.tokEnd !== k.tokStart) {
          failures++;
          console.log(`  ${c.grammar}/${label}: tok-spans gap/overlap at kid ${i}: prevEnd=${kids[i - 1]!.tokEnd} start=${k.tokStart} on ${JSON.stringify(src)}`);
          console.log(`      spans:\n${out}`);
        }
      }
    };

    const cases = c.accept.slice(0, 2);
    for (const src of cases) {
      const outs: Array<{ label: string; out: string | null }> = spanRunners.map((r) => ({
        label: r.label,
        out: runTokSpans(r.cmd, r.args, src),
      }));
      const ref = outs[0]!;
      if (ref.out === null) {
        failures++;
        console.log(`  ${c.grammar}/${ref.label}: tok-spans reject/fail on accept case ${JSON.stringify(src)}`);
        continue;
      }
      for (const o of outs.slice(1)) {
        if (o.out === null) {
          failures++;
          console.log(`  ${c.grammar}/${o.label}: tok-spans reject/fail on accept case ${JSON.stringify(src)}`);
          continue;
        }
        if (o.out !== ref.out) {
          failures++;
          console.log(`  ${c.grammar}: tok-spans cross-target mismatch ${ref.label}≢${o.label} on ${JSON.stringify(src)}`);
          console.log(`      ${ref.label}: ${JSON.stringify(ref.out)}`);
          console.log(`      ${o.label}: ${JSON.stringify(o.out)}`);
        }
      }
      for (const o of outs) {
        if (o.out !== null) assertPartition(src, o.out, o.label);
      }
    }

    if (c.grammar === 'calc') {
      const src = 'let a=1;\n2+3;\nlet b=a;';
      const out = runTokSpans(spanRunners[0]!.cmd, spanRunners[0]!.args, src);
      if (out === null) {
        failures++;
        console.log(`  calc: tok-spans reject on trailing-punct probe`);
      } else {
        for (const r of spanRunners.slice(1)) {
          const o = runTokSpans(r.cmd, r.args, src);
          if (o !== out) {
            failures++;
            console.log(`  calc: tok-spans cross-target mismatch on trailing-punct probe (${r.label})`);
          }
        }
        const { kids } = parseSpans(out);
        const first = kids[0];
        if (!first || first.tokEnd !== 5) {
          failures++;
          console.log(`  calc: first Stmt tokEnd want=5 got=${first?.tokEnd} (name=${first?.name}) on trailing-punct probe`);
          console.log(`      spans:\n${out}`);
        } else {
          console.log(`  calc: tok-spans trailing-punct Stmt tokEnd=5 ✓`);
        }
      }
    }
    console.log(`  ${c.grammar}: tok-spans checked on ${cases.length} accept case(s)${c.grammar === 'calc' ? ' + trailing-punct probe' : ''}`);
  }

  // The jsTarget parser (emit-parser.ts, not built from the portable IR) on the same hand-written
  // lists: the oracle's verdict on each, and on each accepted input the oracle's CST byte for byte
  // (its contract, emit-parser-verify.ts). Its suppress gates (the no-`in` for-heads of
  // NO_IN_HEADS) are compiled from the grammar analysis like the portable targets', by a
  // different emitter, so they are checked here too.
  {
    const jsFile = `${dir}/js.mts`;
    writeFileSync(jsFile, emitParser(grammar, jsTarget));
    const js = await import(jsFile);
    const jsOut = (src: string): Outcome => {
      try { const r = js.parse(src); return { ok: true, cst: canon(objectify(js.tree, (fns) => js.visit(r, fns))) }; } catch (e) { return { ok: false, err: errText(e) }; }
    };
    let acc = 0, rej = 0;
    for (const src of c.accept) {
      const want = oracleOut(src), got = jsOut(src);
      if (want.ok === got.ok && (!want.ok || want.cst === (got as { cst: string }).cst)) { acc++; continue; }
      failures++;
      console.log(`  ${c.grammar}/js: ACCEPT ${want.ok === got.ok ? 'CST' : 'verdict'} mismatch on ${JSON.stringify(src)} (oracle ok=${want.ok}, js ok=${got.ok})`);
    }
    for (const src of c.reject) {
      const want = oracleOut(src), got = jsOut(src);
      if (!want.ok && !got.ok) { rej++; continue; }
      failures++;
      console.log(`  ${c.grammar}/js: REJECT mismatch on ${JSON.stringify(src)} (oracle ok=${want.ok}, js ok=${got.ok})`);
    }
    console.log(`  ${c.grammar}/js: ${acc}/${c.accept.length} accept ≡ oracle CST · ${rej}/${c.reject.length} reject ≡ oracle`);
  }

  for (const r of runners) {
    let acc = 0, rej = 0, snap = 0;
    for (const src of c.accept) {
      const want = oracleOut(src), got = r.run(src);
      if (want.ok && got.ok) {
        acc++;
        // Shape snapshot on every accepted input: the rule-node skeleton (rule labels tree,
        // trivia/punct leaves stripped) must match the oracle's. Robust to leaf-level CST
        // compression (Phase 5) but catches semantic restructure (a node becoming a different
        // rule / merging / disappearing) — e.g. the rust prefix arm once dropped its operand
        // subtree, visible only on inputs beyond the first two.
        if (src && canon(skeleton(want.cst)) !== canon(skeleton(got.cst))) {
          snap++;
          failures++;
          console.log(`  ${c.grammar}/${r.label}: SHAPE drift on ${JSON.stringify(src)}`);
          console.log(`      want ${canon(skeleton(want.cst)).slice(0, 160)}`);
          console.log(`      got  ${canon(skeleton(got.cst)).slice(0, 160)}`);
        }
        continue;
      }
      failures++;
      console.log(`  ${c.grammar}/${r.label}: ACCEPT mismatch on ${JSON.stringify(src)} (oracle ok=${want.ok}, ${r.label} ok=${got.ok})`);
    }
    for (const src of c.reject) {
      const want = oracleOut(src), got = r.run(src);
      if (!want.ok && !got.ok) { rej++; continue; }
      failures++;
      console.log(`  ${c.grammar}/${r.label}: REJECT mismatch on ${JSON.stringify(src)} (oracle ok=${want.ok}, ${r.label} ok=${got.ok})`);
    }
    console.log(`  ${c.grammar}/${r.label}: ${acc}/${c.accept.length} accept ≡ oracle · ${rej}/${c.reject.length} reject ≡ oracle${snap ? ` · ${snap} shape drift` : ''}`);

    // Every one-character insertion and deletion at every offset of small documents with template
    // holes (nested, holding strings, braces, templates, comments): the edited Doc ≡ a fresh parse
    // of the edited text, on the verdict and the CST, and its own validation (stream and tree
    // against a fresh lex and parse) holds. Exhaustive, not random: a random edit rarely lands
    // inside a hole, where the relex window must not restart.
    if (HOLE_EDIT_GRAMMARS.has(c.grammar) || FRAME_EDIT_DOCS[c.grammar]) {
      const sessions = (HOLE_EDIT_GRAMMARS.has(c.grammar) ? [...HOLE_EDIT_DOCS.map((doc) => ({ doc, ins: undefined as string[] | undefined })), ...LOOK_EDIT_DOCS] : FRAME_EDIT_DOCS[c.grammar]!.map((doc) => ({ doc, ins: FRAME_INS })))
        .flatMap(({ doc: init, ins }) => oneCharEdits(init, ins).map((e) => ({ init, e, final: init.slice(0, e[0]) + e[2] + init.slice(e[1]) })));
      const fresh = r.batch(sessions.map((x) => x.final));
      const bad: string[] = [];
      let knownHit = 0, checks = 0, repairs = 0;
      sessions.forEach((x, i) => {
        const a = r.edit(JSON.stringify({ init: x.init, batches: [[x.e]] }), false), b = fresh[i]!;
        // The relexed stream itself (before the Doc parses it) ≡ a fresh lex: its alignment with
        // the old stream is the oracle's. A Doc that re-scans when its parse fails would hide a
        // wrong relex from the verdict and the tree, not from this.
        let want: Align | null = null;
        try { want = expectAlign(grammar, x.init, [[x.e]]); } catch { /* the edited text does not lex */ }
        const why = a.ok !== b.ok ? `edited ${a.ok ? 'accepts' : 'rejects'}, fresh ${b.ok ? 'accepts' : 'rejects'}`
          : a.ok && a.cst !== b.cst ? 'CSTs differ'
          : a.align && (a.align.streamEq === false || a.align.treeEq === false) ? `validation streamEq=${a.align.streamEq} treeEq=${a.align.treeEq}`
          : want && (!a.align || a.align.oldN !== want.oldN || a.align.newN !== want.newN || a.align.prefix !== want.prefix || a.align.suffix !== want.suffix) ? `relexed stream ≠ a fresh lex (align ${JSON.stringify(a.align)}, oracle ${JSON.stringify(want)})`
          : (a.align?.rescanRepairs ?? 0) > 0 ? `the Doc's re-scan replaced the relexed stream (align ${JSON.stringify(a.align)})` : '';
        checks += a.align?.rescanChecks ?? 0; repairs += a.align?.rescanRepairs ?? 0;
        const known = HOLE_EDIT_EXPECTED_FAIL.find((k) => k.doc === x.init && JSON.stringify(k.edit) === JSON.stringify(x.e));
        if (known) { if (!why) bad.push(`expected-fail passes now, remove it (${known.reason}): ${JSON.stringify(x.init)} edit ${JSON.stringify(x.e)}`); else knownHit++; return; }
        if (why) bad.push(`${why}: ${JSON.stringify(x.init)} edit ${JSON.stringify(x.e)}`);
      });
      console.log(`  ${c.grammar}/${r.label}: ${sessions.length - bad.length - knownHit}/${sessions.length} one-character edits in and around template holes, regex attempts and reads past a token's end ≡ fresh (${knownHit} expected-fail; the Doc re-scanned ${checks} times, ${repairs} of them replacing the relexed stream)`);
      for (const smp of bad.slice(0, 6)) console.log(`      ${smp}`);
      failures += bad.length;
    }

    const editScenarios = EDIT_SCENARIOS[c.grammar];
    if (editScenarios) {
      let editOk = 0, alignOk = 0, fastOk = 0;
      const runEdit = (json: string) => r.edit(json, false);
      const runFast = (json: string) => r.edit(json, true);
      for (const sc of editScenarios) {
        const final = applyEdits(sc.init, sc.batches);
        const payload = JSON.stringify({ init: sc.init, batches: sc.batches });
        const a = runEdit(payload);
        const b = r.run(final);
        if (a.ok === b.ok && (!a.ok || a.cst === b.cst) && a.ok === oracleOut(final).ok) editOk++;
        else {
          failures++;
          console.log(`  ${c.grammar}/${r.label}: edit-session mismatch (final=${JSON.stringify(final)}) A ok=${a.ok} B ok=${b.ok}`);
        }
        if ((a.align?.rescanRepairs ?? 0) > 0) {
          failures++;
          console.log(`  ${c.grammar}/${r.label}: the Doc's re-scan replaced the relexed stream (final=${JSON.stringify(final)}): a relex defect`);
        }
        const want = expectAlign(grammar, sc.init, sc.batches);
        if (a.align && a.align.oldN === want.oldN && a.align.newN === want.newN && a.align.prefix === want.prefix && a.align.suffix === want.suffix) {
          alignOk++;
          if (sc.large && want.prefix + want.suffix < want.oldN - 8) {
            failures++;
            console.log(`  ${c.grammar}/${r.label}: large-doc align too narrow prefix+suffix=${want.prefix + want.suffix} oldN=${want.oldN}`);
          }
          if (a.align.streamEq !== true) {
            failures++;
            console.log(`  ${c.grammar}/${r.label}: streamEq want=true got=${JSON.stringify(a.align.streamEq)}`);
          }
          if (a.align.treeEq !== true) {
            failures++;
            console.log(`  ${c.grammar}/${r.label}: treeEq want=true got=${JSON.stringify(a.align.treeEq)}`);
          }
          if (a.align.reused === undefined) {
            failures++;
            console.log(`  ${c.grammar}/${r.label}: reused field missing got=${JSON.stringify(a.align)}`);
          }
          if (sc.reused !== undefined && a.align.reused !== sc.reused) {
            failures++;
            console.log(`  ${c.grammar}/${r.label}: reused want=${sc.reused} got=${JSON.stringify(a.align.reused)}`);
          }
          if (sc.minReused !== undefined && (a.align.reused === undefined || a.align.reused < sc.minReused)) {
            failures++;
            console.log(`  ${c.grammar}/${r.label}: reused want>=${sc.minReused} got=${JSON.stringify(a.align.reused)}`);
          }
          if (sc.maxReused !== undefined && (a.align.reused === undefined || a.align.reused > sc.maxReused)) {
            failures++;
            console.log(`  ${c.grammar}/${r.label}: reused want<=${sc.maxReused} got=${JSON.stringify(a.align.reused)}`);
          }
          if (sc.longSession) {
            for (let bi = 1; bi < sc.batches.length; bi++) {
              const prefixPayload = JSON.stringify({ init: sc.init, batches: sc.batches.slice(0, bi) });
              const p = runEdit(prefixPayload);
              if (p.align?.treeEq !== true) {
                failures++;
                console.log(`  ${c.grammar}/${r.label}: longSession batch ${bi} treeEq want=true got=${JSON.stringify(p.align?.treeEq)}`);
              }
            }
          }
          if (sc.maxRelexed !== undefined && (a.align.relexed === undefined || a.align.relexed > sc.maxRelexed)) {
            failures++;
            console.log(`  ${c.grammar}/${r.label}: relexed want<=${sc.maxRelexed} got=${JSON.stringify(a.align.relexed)}`);
          }
          if (sc.fullRelex && a.align.relexed !== want.newN) {
            failures++;
            console.log(`  ${c.grammar}/${r.label}: fullRelex want relexed=${want.newN} got=${JSON.stringify(a.align.relexed)}`);
          }
        } else {
          failures++;
          console.log(`  ${c.grammar}/${r.label}: token-align mismatch want=${JSON.stringify(want)} got=${JSON.stringify(a.align)}`);
        }
        const f = runFast(payload);
        const sixEq = !!(a.align && f.align
          && a.align.oldN === f.align.oldN && a.align.newN === f.align.newN
          && a.align.prefix === f.align.prefix && a.align.suffix === f.align.suffix
          && a.align.relexed === f.align.relexed && a.align.reused === f.align.reused);
        const noValidateKeys = f.align !== undefined && !('streamEq' in f.align) && !('treeEq' in f.align);
        const outEq = a.ok === f.ok && (!a.ok || a.cst === f.cst);
        if (sixEq && noValidateKeys && outEq) fastOk++;
        else {
          failures++;
          console.log(`  ${c.grammar}/${r.label}: fast≢validated sixEq=${sixEq} noValidateKeys=${noValidateKeys} outEq=${outEq} validated=${JSON.stringify(a.align)} fast=${JSON.stringify(f.align)}`);
        }
      }
      console.log(`  ${c.grammar}/${r.label}: ${editOk}/${editScenarios.length} edit-sessions ≡ fresh`);
      console.log(`  ${c.grammar}/${r.label}: ${alignOk}/${editScenarios.length} token-alignments ≡ oracle`);
      console.log(`  ${c.grammar}/${r.label}: ${fastOk}/${editScenarios.length} fast ≡ validated`);
    }
    if (c.grammar === 'javascript') unicodeParity(r, oracleOut);
  }

  // ── Parity corpus: every runner ≡ the oracle on verdict, and on the rule skeleton when both accept ──
  {
    const t0 = Date.now();
    const tokenize = compileTokenizer(lexSpecOf(grammar)) as (s: string) => Tok[];
    const inputs: { src: string; kind: string }[] = [...parityInputs(grammar, tokenize, { refusedOperands: ECMASCRIPT.has(c.grammar) }),
      ...(ECMASCRIPT.has(c.grammar) ? NON_ASCII_LEX.map((src) => ({ src, kind: 'non-ASCII lexing' })) : []),
      ...(ECMASCRIPT.has(c.grammar) ? LINE_TERMINATORS.map((src) => ({ src, kind: 'line terminators' })) : []),
      ...(JSX_GRAMMARS.has(c.grammar) ? jsxCorpus().map((src) => ({ src, kind: 'tsc JSX conformance' })) : [])];
    const want = inputs.map((i) => oracleOut(i.src));
    const wantToks = inputs.map((i): TokStream => {
      try { return JSON.stringify(tokenize(i.src).map((t) => [t.type, t.text, (t as unknown as { newlineBefore: boolean }).newlineBefore])); } catch { return null; }
    });
    const known = CORPUS_EXPECTED_FAIL.filter((e) => e.grammars.includes(c.grammar));
    // The grammar's literal table: lids[i] is the text of literal id i (lids[0] = '', no literal).
    const lids = buildLexIdPlan(portableIR(grammar)).lids;
    const lidIndex = new Map(lids.map((t, i) => [t, i]));
    const lidOfText = (t: string) => lidIndex.get(t) ?? 0;
    const lexErr = inputs.map((i): string => { try { tokenize(i.src); return ''; } catch (e) { return errText(e); } });
    for (const r of runners) {
      const got = r.batch(inputs.map((i) => i.src));
      const gotToks = r.tokens(inputs.map((i) => i.src));
      const by = new Map<string, number>();
      const samples: string[] = [];
      const mine = known.map((e) => !e.targets || e.targets.includes(r.label));
      const knownHits = known.map(() => 0);
      let bad = 0;
      inputs.forEach((input, i) => {
        const w = want[i], g = got[i];
        let what = '';
        if (w.ok !== g.ok) what = `oracle ${w.ok ? 'accepts' : 'rejects'}, ${r.label} ${g.ok ? 'accepts' : 'rejects'}`;
        else if (w.ok && g.ok && canon(skeleton(w.cst)) !== canon(skeleton(g.cst))) what = 'both accept, rule skeletons differ';
        // A target that died in its lexer agrees with the oracle only when the oracle's
        // rejection is a lexer error too (its parser's own rejections all begin `Parse error`).
        else if (!w.ok && !g.ok && g.err !== undefined && g.err !== '' && r.label !== 'typescript' && (w.err ?? '').startsWith('Parse error')) what = `oracle rejects in its parser, ${r.label} failed before parsing (${g.err})`;
        else if (gotToks[i] !== 'NUL' && wantToks[i] !== unLid(gotToks[i]!)) what = wantToks[i] === null ? `oracle lexer fails, ${r.label} lexes` : gotToks[i] === null ? `oracle lexes, ${r.label} lexer fails` : 'token streams differ';
        if (!what) return;
        const k = known.findIndex((e, j) => mine[j] && (e.inputs ? e.inputs.includes(input.src) : e.oracleLexError!.test(lexErr[i])));
        if (k >= 0) { knownHits[k]++; return; }
        bad++;
        const key = `${input.kind}: ${what}`;
        by.set(key, (by.get(key) ?? 0) + 1);
        if (samples.length < 12) samples.push(`${key} — ${JSON.stringify(input.src.length > 100 ? input.src.slice(0, 100) + '…' : input.src)}`);
      });
      console.log(`  ${c.grammar}/${r.label}: corpus ${inputs.length - bad}/${inputs.length} ≡ oracle (verdict + rule skeleton + token stream)`);
      known.forEach((e, k) => {
        if (!mine[k]) return;
        console.log(`      expected-fail: ${knownHits[k]} inputs disagree${e.inputs ? ` (of ${e.inputs.length} listed)` : ''} — ${e.reason}`);
        if (knownHits[k] === 0) { failures++; console.log(`  ${c.grammar}/${r.label}: no listed input disagrees any more: remove this CORPUS_EXPECTED_FAIL entry (${e.reason})`); }
      });
      for (const [key, n] of by) console.log(`      ${String(n).padStart(5)}  ${key}`);
      for (const smp of samples) console.log(`      ${smp}`);
      failures += bad;

      // One literal id per text: the id the lexer gives a token, and the one lid_of gives the
      // same text when a Doc rebuilds that token from its metadata, are both the text's index in
      // the grammar's literal table (0: no literal) — for every token of the corpus and for
      // every literal of the table.
      const lidBad: string[] = [];
      const texts = new Set<string>(lids.slice(1));
      inputs.forEach((input, i) => {
        if (gotToks[i] === null || gotToks[i] === 'NUL') return;
        for (const [kind, text, , lid] of JSON.parse(gotToks[i]!) as [string, string, boolean, number][]) {
          texts.add(text);
          if (lid !== lidOfText(text)) lidBad.push(`lexer gives ${kind} ${JSON.stringify(text)} lid ${lid}, the table ${lidOfText(text)} — in ${JSON.stringify(input.src.slice(0, 80))}`);
        }
      });
      const textList = [...texts].filter((t) => !t.includes('\0'));
      r.lidOf(textList).forEach((got, j) => { if (got !== lidOfText(textList[j]!)) lidBad.push(`lid_of(${JSON.stringify(textList[j])}) = ${got}, the table ${lidOfText(textList[j]!)}`); });
      console.log(`  ${c.grammar}/${r.label}: literal ids ${lidBad.length ? `${lidBad.length} MISMATCH` : `≡ the table`} (the lexer's on every corpus token, lid_of's on ${textList.length} texts: every token text and every literal)`);
      for (const smp of [...new Set(lidBad)].slice(0, 8)) console.log(`      ${smp}`);
      failures += lidBad.length;

      // The Doc path ≡ a fresh parse: the verdict, and the CST when both accept.
      const srcs = inputs.map((i) => i.src);
      const docs = r.doc(srcs), builders = r.docBuilder?.(srcs);
      const docBad: string[] = [];
      inputs.forEach((input, i) => {
        const f = got[i]!, d = docs[i]!;
        if (d.ok === false && d.err === 'NUL') return;
        const at = JSON.stringify(input.src.length > 100 ? input.src.slice(0, 100) + '…' : input.src);
        if (f.ok !== d.ok) docBad.push(`fresh parse ${f.ok ? 'accepts' : 'rejects'}, Doc ${d.ok ? 'accepts' : 'rejects'} — ${at}`);
        else if (f.ok && d.ok && f.cst !== d.cst) docBad.push(`both accept, CSTs differ — ${at}`);
        const b = builders?.[i];
        if (b !== undefined && b !== null && b !== f.ok) docBad.push(`fresh parse ${f.ok ? 'accepts' : 'rejects'}, builder Doc ${b ? 'accepts' : 'rejects'} — ${at}`);
      });
      console.log(`  ${c.grammar}/${r.label}: Doc ${docBad.length ? `${docBad.length} MISMATCH` : '≡ fresh parse'} (each input typed into an empty ${builders ? 'CST and builder Doc' : 'Doc'}: verdict${builders ? 's' : ''} + CST)`);
      for (const smp of docBad.slice(0, 8)) console.log(`      ${smp}`);
      failures += docBad.length;
    }
    corpusMs += Date.now() - t0;
    corpusInputs += inputs.length;
  }
}
console.log(`  parity corpus: ${corpusInputs} inputs over ${CASES.length} grammars, ${(corpusMs / 1000).toFixed(1)}s`);

// A grammar the portable rendering cannot express is refused at emit time, never mis-parsed.
// Longest match takes no alternative that advances nothing, so an entry rule that has to CHOOSE
// its empty alternative (to accept the empty input) has no rendering.
{
  const { token, rule, defineGrammar, many, seq, range, star } = await import('../src/api.ts');
  const Num = token(seq(range('0', '9'), star(range('0', '9'))), { scope: 'constant.numeric' });
  const Program = rule(() => [[Num, ';'], [many(Num)]]);
  const g = defineGrammar({ name: 'emptyentry', scopeName: 'source.emptyentry', tokens: { Number: Num }, prec: [], rules: { Program } });
  for (const [label, target] of [['typescript', tsTarget], ['go', goTarget], ['rust', rustTarget]] as const) {
    let msg = '';
    try { emitParser(g, target); } catch (e) { msg = errText(e); }
    if (/entry rule Program has several alternatives and can match the empty input/.test(msg)) continue;
    failures++;
    console.log(`  emptyentry/${label}: an entry rule with an empty alternative among several was not refused (${msg || 'emitted'})`);
  }
  console.log('  emptyentry: an entry rule that must choose its empty alternative is refused by every target');
}

if (failures > 0) {
  console.error(`\n✗ portable targets diverge from the interpreter (${failures} case(s))`);
  process.exit(1);
}
console.log('\n✓ portable parsers (ts/go/rust) derived from each grammar ≡ interpreter on accept/reject parity (compiled & run)');
