// JavaScript bidirectional conformance, mirroring the accept/reject oracle but
// for javascript.ts. Ground truth is TS's OWN parser in JS mode
// (`ts.createSourceFile(..., ts.ScriptKind.JS)` → `parseDiagnostics`).
//
// Two corpora are measured:
//
//   1. A curated set of valid-JS snippets (below). These contain NO type syntax,
//      so they are the real target: the JS grammar MUST accept all of them.
//
//   2. TypeScript-only syntax the JS grammar has no production for: it must reject all of them.
//
// JavaScript as a whole is measured against test262 (test/test262.ts, the specification's suite).
import { createParser } from '../src/interpreter/interpreter.ts';
import ts from 'tsc-oracle';
import { isInputError } from './input-error.ts';

const grammar = (await import('../javascript.ts')).default;
const { parse } = createParser(grammar);

const jsAccepts = (code: string, file = 't.js') => {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return ((sf as any).parseDiagnostics as ts.Diagnostic[] | undefined)?.length ? false : true;
};
const weAccept = (code: string) => {
  // a crash is not a rejection: it propagates and fails the gate
  try { parse(code); return true; } catch (e) { if (isInputError(e)) return false; throw e; }
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
  // after a prefix `++` / `--` an operand starts: `/` opens a regex (a postfix one is followed by division)
  `++/r/.lastIndex; --/r/.lastIndex; x = ++/r/.y; a++ / 2; a-- / 2 / 3;`,
  // a logical assignment's right operand is an AssignmentExpression
  `c ||= a = b; c ??= a += b; a = b &&= c;`,
  // a decorator's `@`, name and dotted segments are tokens of their own (trivia between them)
  `@ a class C {} @a . b class D {} @℘ class E {} @a.℘ class F {} @(a, b) class G {}`,
  `const cond = a ? b : c ? d : e;`,
  `const cmp = a < b > c;`,
  `const t2 = tag\`a\${b}c\${d}e\`;`,
  `delete obj.x; typeof x; void 0; !x; ~y; +z; -w;`,
  `const inst = x instanceof Y; const inOp = "k" in obj;`,
  `new Foo(); new Foo(1, 2); new foo.Bar(); new.target;`,
  // a template in the `new` callee (MemberExpression : MemberExpression TemplateLiteral)
  `new \`a\${0}b\`; new \`abc\`(1); new tag\`x\${y}\`(); new a.b\`x\`(1); new \`x\`.y(); new a\`x\`.b\`y\`(1);`,
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
  // a specifier's module-side name and an export's own name are IdentifierNames
  `import { if as x, default as y } from "m";`,
  `export { x as if };`,
  `export { if } from "m";`,
  `export * as if from "m";`,
  // misc real-world
  `const p = new Promise((resolve, reject) => { resolve(1); });`,
  `arr.map(x => x * 2).filter(x => x > 0).reduce((a, b) => a + b, 0);`,
  `const { default: d } = await import("m");`,
];

// ── Statement ends (ECMAScript 12.10, Automatic Semicolon Insertion) ──
// A statement that does not end in a block ends at a `;`, before a token on a later line,
// before `}`, or at the end of the input; a do-while also ends at its `)`. A restricted
// production (`return`/`break`/`continue` [no LineTerminator here] …) ends at a line break.
// Each case is checked against tsc's JS-mode parser too, so the expectation is the oracle's.
const statementEnds: { accept: string[]; reject: string[] } = {
  accept: [
    'a\nb', 'a = 1\nb = 2', 'var a = 1\nvar b = 2', 'let a\nconst b = 1', '{ a }', 'a', 'a;b',
    'a\n(b)', 'a\n[b]', 'a\n.b', 'a\n+b', 'a /* c\n */ b', 'a // c\nb', 'x = function () {}\n(b)',
    'do x; while (y) z', 'do {} while (y) z', 'do ; while (y) x', 'do x\nwhile (y)', 'if (a) b\nelse c',
    'function f() { return\nvar b }', 'function f() { return\nlet\nx = 1 }', 'function f() { return a; b }',
    'L: for (;;) { break\nL }', 'L: for (;;) { continue\nL }', 'debugger\nx', 'throw a\nb',
    'function f() {} g()', 'class A {} g()', 'if (a) {} b', 'try {} catch {} b', 'switch (a) {} b',
    'import "m"\nx', 'import a from "m"\nx', 'export { a }\nx', 'export * from "m"\nx',
    'export default a\nb', 'export default class {} g()', 'export default class C {} g()',
    'export default function () {} g()', 'export var a = 1\nb',
    'class C { a\nb }', 'class C { a = 1\nb() {} }', 'class C { m() {} n() {} }', 'class C { m() {}; n() {} }',
    'class C { get g() {} set s(v) {} }', 'class C { static {} a }', 'class C { a; b }',
    // An expression statement does not begin with `{`, `function`, `async` `function` on one
    // line, `class`, `let [` or a decorator (14.5): there the statement is a block or a
    // declaration, and what follows it is the next statement. In an expression it is a literal.
    '{}\n(x)', '{}\n[x]', 'function f() {}\n(x)', 'function* g() {}\n[0]', 'class C {}\n[0]', '@dec class C {}\n(x)',
    'async\nfunction f() {}', 'async\nfunction f() {}\n(x)', 'if (a) {}\n(x)', 'L: {}\n(x)', 'do {}\nwhile (y)',
    '({}).x', '({ a: 1 }.x)', '(function () {})()', '(class {}).name', '(@dec class {}).x', 'x = {}.y', 'f({}.x)',
    'x = () => ({}).y', 'x = () => {}\n(y)', 'export default {}.x', 'let = 1', 'let.x', 'async.x', 'async()',
    // Every LineTerminator (LF, CR, LS, PS) ends a line comment, a hashbang and a `///` line
    // (SingleLineCommentChar, HashbangComment exclude them all), so what follows is source.
    ...['\n', '\r', '\u2028', '\u2029', '\r\n'].flatMap((t) => [`{ a // c${t}}`, `#! sh${t}{ a }`, `/// <x${t}{ a }`, `function f() { return // c${t}1 }`]),
  ],
  reject: [
    'a b', 'a = 1 b = 2', 'var a = 1 var b = 2', 'let a const b = 1', 'function f() { return a b }',
    'throw a b', 'debugger x', 'L: for (;;) { break L x }', 'L: for (;;) { continue L x }', 'a /* c */ b',
    'if (a) b else c', 'do x while (y)', 'while (a) b c', 'for (;;) a b', 'M: a b',
    'import in from "m"', 'x = function this() {}', 'import "m" x', 'import a from "m" x',
    'export { a } from "m" x', 'export * from "m" x', 'export * as a from "m" x', 'export default a b',
    'export var a = 1 b',
    'class C { a b }', 'class C { a = 1 b }', 'class C { m() n() {} }', 'class C { get g() set s(v) {} }',
    '{ a: 1 }.x', '{ a: 1 }\n.x', '{} .b', '{}\n.b', '{} = b', '{ a } = b', '{}, b', '{} in b', '{ b() {} }.x',
    '{ ...a }.b', '{ function () {} }', 'if (a) {} = b', 'if (a) {} .b', 'while (a) {}, b', 'L: {}.x',
    'do {}\n(x)\nwhile (y)', 'function f() {}.x', 'function f() {} = b', 'async function f() {}.x', 'class C {}.name',
    '@dec class {}.x', '@dec class C {}.x', 'let[0] = 1', '(async\nfunction f() {})', 'x = async\nfunction () {}',
    // ... and a RegularExpressionLiteral holds none (RegularExpressionNonTerminator).
    ...['\n', '\r', '\u2028', '\u2029'].flatMap((t) => [`// c${t}a b`, `#! sh${t}a b`, `/// <x${t}a b`, `x = /a${t}b/`, `x = /[${t}]/`, `x = /\\${t}/`]),
  ],
};

// ── `for` heads (14.7.4 ForStatement, 14.7.5 ForInOfStatement) ──
// `for ( [lookahead ≠ let [] Expression[~In]opt ; …`, the `var` / lexical forms with [~In]
// initializers, `for ( [lookahead ≠ let [] LeftHandSideExpression in …`, `for ( [lookahead ∉
// { let, async of }] LeftHandSideExpression of …`, `for await ( [lookahead ≠ let] … of …` (only
// `of`), one ForBinding before `in` / `of`, and a `using` declaration with no pattern and no `in`
// (explicit resource management: ForDeclaration[+Using] takes ForBinding[~Pattern], the for-in
// arm's is [~Using]). `let` as an identifier is the sloppy reading
// (strict mode makes it an early error, which is not the parser's). The verdicts are the
// productions'; `tscDeparts` names each case tsc's JS-mode parser decides the other way.
const forHeads: { accept: string[]; reject: string[]; tscDeparts: string[] } = {
  accept: [
    'for (a = (b in c);;);', 'for (f(a in b);;);', 'for (x = [a in b];;);', 'for (a; b in c; d in e);',
    'for (x = a ? b in c : d;;);', 'for (let;;);', 'for (let = 1;;);', 'for (let.x;;);', 'for ((let)[0] = 1;;);',
    'for (let[a] = 1;;);', 'for (let in x);', 'for (let.x in x);', 'for (let [a] in x);', 'for ((let) of x);',
    'for (let of of x);', 'for (async of => 1;;);', 'for (async.x of y);', 'for ((async) of y);', 'for (of of y);',
    'for (var a = 1 in b);', 'for (var a = b ? c in d : e;;);', 'for (using of x);', 'for (using [a] of x);',
    'for (using [a] in x);',
    'async function f() { for await (async of x); }', 'async function f() { for await ((let) of x); }',
    'async function f() { for await (var [a] of b); }',
  ],
  reject: [
    'for (a = b in c;;);', 'for (a in b in c;;);', 'for (a in b;;);', 'for (a, b in c;;);', 'for (x = y = a in b;;);',
    'for (let[0] = 1;;);', 'for (let[0] in x);', 'for (let.x of y);', 'for (let of x);', 'for (async of x);',
    'for (async of => 1 of x);', 'for (var a, b of c);', 'for (let a, b in c);', 'for (const a, b of c);',
    'for (using a, b of c);', 'for (using a in b);', 'for (using {a} of b);', 'async function f() { for await (a in b); }', 'async function f() { for await (;;); }',
    'async function f() { for await (let.x of y); }', 'async function f() { for await (let of y); }',
    'for (var of x);', 'for (var in x);', 'for (var;;);', 'for (var of of);',
    // ForDeclaration: `using [no LineTerminator here] ForBinding`, `await [no LineTerminator here] using …`
    'for (using\n x of y);', 'async function f() { for (await using\n x of y); }',
  ],
  tscDeparts: [
    'for (var of x);', 'for (var in x);', 'for (var;;);', 'for (var of of);',
    'for (x = [a in b];;);', 'for (let = 1;;);', 'for (let.x;;);', 'for (let.x in x);',
    'for (let of x);', 'for (async of x);', 'for (async of => 1 of x);', 'for (var a, b of c);', 'for (let a, b in c);',
    'for (const a, b of c);', 'for (using a, b of c);', 'for (using a in b);', 'for (using {a} of b);',
    'async function f() { for await (let of y); }',
  ],
};

// ── Declaration lists and `with` (14.3 VariableStatement / LexicalDeclaration, 14.11) ──
// A VariableDeclarationList / BindingList has one or more declarations and no trailing comma, so a
// `var` / `let` / `const` / `using` statement needs a binding; `let;` and `let` alone are the
// expression statement of the identifier `let` (the sloppy reading), and so is `using;`. The object
// of `with ( Expression )` is an Expression, a comma list included.
const declarationLists: { accept: string[]; reject: string[]; tscDeparts: string[] } = {
  accept: [
    'let;', 'let', 'let\nx = 1;', 'var a, b;', 'let a = 1, b;', 'const a = 1, b = 2;', 'using;', 'using\nx;', 'using\nx = 1;',
    'with (a, b) c;', 'with (a) c;', 'with (a, b, c) {}',
  ],
  reject: [
    'var;', 'const;', 'var a,', 'var a,;', 'let a,;', 'const a = 1,;', 'var\n;', 'with () c;', 'with (a,) c;',
    // `await [no LineTerminator here] using`: across the break `await using` is an await expression
    'async function f() { await\n using x = y; }',
  ],
  tscDeparts: ['async function f() { await\n using x = y; }', 'var;', 'const;', 'var a,', 'var a,;', 'let a,;', 'const a = 1,;', 'var\n;'],
};

// ── `new` targets (13.3 MemberExpression) ──
// After `new` comes a MemberExpression: a PrimaryExpression (`this`, a literal, an identifier that
// is not a reserved word, an array or object literal, a function or class expression, a template,
// a parenthesised expression), a SuperProperty, a MetaProperty, `new MemberExpression Arguments`,
// or a member / private-member / tagged-template form of one. `new null()` and `new 1` are syntax
// (they throw at run time); `new if()` and `new typeof x` have no derivation.
const newTargets: { accept: string[]; reject: string[]; tscDeparts: string[] } = {
  accept: [
    'new this();', 'new this.x();', 'new null();', 'new true;', 'new 1;', 'new 0x1();', 'new "s";', 'new /r/g;', 'new `t`;',
    'new [a];', 'new {a}.b();', 'new function () {}();', 'new function* () {};', 'new async function () {};', 'new (a, b)();',
    'class A extends B { m() { new super.x(); new super[x](); } }', 'class A { #f; m() { new A.#f(); new this.#f.g(); } }',
    'function f() { new new.target(); }', 'new a.b[c]`t`(1);', 'new new A()();', 'new class {}();',
  ],
  reject: ['new if();', 'new typeof x;', 'new a?.b();', 'new super();', 'new;', 'new class;', 'new x.y?.();'],
  tscDeparts: ['new super();'],   // tsc parses a `super` call as a `new` callee and leaves it to the checker
};

// ── Class heritage (15.7 `ClassHeritage : extends LeftHandSideExpression`) ──
// One `extends`, one LeftHandSideExpression: a NewExpression (a MemberExpression, or `new` without
// Arguments), a CallExpression or an OptionalExpression. No list, no second `extends`, no empty
// heritage, no operator expression. acorn agrees with every verdict (checked below); `tscDeparts`
// names the cases tsc's JS-mode parser takes and leaves to its checker.
const classHeritage: { accept: string[]; reject: string[]; tscDeparts: string[] } = {
  accept: [
    'class A extends B {}', 'class A extends function () {} {}', 'class A extends new B {}', 'class A extends new B() {}',
    'class A extends [].x {}', 'class A extends {} {}', 'class A extends {}.x {}', 'class A extends {x} {}', 'class A extends this.x {}',
    'class A extends B.c().d {}', 'class A extends B?.c {}', 'class A extends (B, C) {}', 'class A extends class {} {}',
    'class A extends f`t` {}', 'class A extends 1 {}', 'x = class extends function () {} {};', 'x = class extends new B {};',
    'function f() { class A extends new.target {} }', 'class A extends B { m() { class C extends super.x {} } }',
  ],
  reject: [
    'class A extends B, C {}', 'class A extends B extends C {}', 'class A extends {}', 'class A extends {} ', 'class A extends a ? b : c {}',
    'class A extends async () => {} {}', 'class A extends x = y {}', 'class A extends if {}', 'x = class extends B, C {};',
    'class A extends !B {}', 'class A extends B++ {}', 'export default class extends B, C {}',
  ],
  // tsc reads `{}` before `.` as the class body (isValidHeritageClauseObjectLiteral), so `extends {}.x` has no base there.
  tscDeparts: ['class A extends {}.x {}', 'class A extends B, C {}', 'class A extends B extends C {}', 'class A extends {}', 'class A extends {} ', 'x = class extends B, C {};', 'export default class extends B, C {}'],
};
// TypeScript keeps tsc's parse (heritage is a clause list there: `extends` and `implements`, each a
// comma list, repeated in any order, the checker judging the rest), with the same elements: any
// LeftHandSideExpression with optional type arguments; an empty object literal is an element only
// before `,` / `{` / `extends` / `implements` (tsc's isValidHeritageClauseObjectLiteral), so in
// `class A extends {}` it is the body. Interfaces read the same clauses. tsc is the oracle here.
const tsHeritage: { accept: string[]; reject: string[] } = {
  accept: [
    'class A extends B, C {}', 'class A extends B extends C {}', 'class A extends {}', 'class A extends {} {}', 'class A extends {}, B {}',
    'class A extends {} implements I {}', 'class A extends {x} {}', 'class A extends function () {} {}', 'class A extends new B {}',
    'class A extends [].x {}', 'class A extends B<T> {}', 'class A<T> extends B<T> implements C<T>, D {}', 'class A implements I, J {}',
    'class A extends B implements I extends C {}', 'class A extends B, {}', 'interface I extends A, B {}', 'interface I extends {} {}', 'x = class extends {} {};',
  ],
  reject: ['class A extends {x}', 'class A extends { a: T; } {}', 'class A extends {}.x {}', 'class A extends a ? b : c {}', 'class A extends async () => {} {}', 'class A extends x = y {}', 'class A extends if {}'],
};

// ── Identifier references (13.1 IdentifierReference, BindingIdentifier : Identifier, and
// Identifier : IdentifierName but not ReservedWord) ──
// `true`, `false`, `null`, `this`, `super` and `new` are reserved words: each begins an expression
// of its own and is never an identifier, so never an arrow's parameter either. `undefined` is no
// reserved word: an ordinary identifier (a property of the global object), so a name, a parameter
// and a callee. Both grammars; JavaScript against acorn and tsc's JS mode, TypeScript against tsc.
const identifierReferences: { accept: string[]; reject: string[] } = {
  accept: [
    'x = undefined;', 'undefined;', 'undefined => 1;', 'async undefined => 1;', 'new undefined();', 'undefined.x = undefined[0];',
    'var undefined = 1;', 'function undefined(undefined) {}', 'x = true, y = false, z = null, w = this;', 'new this();', 'new true;',
    'x = async => 1;', 'x = async;',
  ],
  reject: [
    'true => 1;', 'false => 1;', 'null => 1;', 'this => 1;', 'super => 1;', 'new => 1;', 'async true => 1;', 'async false => 1;',
    'async null => 1;', 'async this => 1;', 'async super => 1;', 'x = (true) => 1;',
  ],
};

// ── Class element words (15.7 ClassElement, MethodDefinition; decorators proposal) ──
// `static`, `async`, `accessor`, `get` and `set` are the element's keyword only where the rest
// of that production follows; elsewhere the word is the element's name. `static` and `get` /
// `set` take a ClassElementName (or `static` a `*` / `{`) on any line, `async [no LineTerminator
// here]` a name or `*`, `accessor [no LineTerminator here]` a name, and an element has one
// `static`, after its decorators. A field is one name, so `get⏎x;` is no element.
// `tscDeparts` names each case tsc's JS-mode parser decides the other way.
const classElements: { accept: string[]; reject: string[]; tscDeparts: string[] } = {
  accept: [
    'class C { static static; }', 'class C { @d static; }', 'class C { static accessor; }', 'class C { accessor accessor; }',
    'class C { static; accessor; async; get; set }', 'class C { static\nx }', 'class C { get\nx() {} }',
    'class C { get\n*x() {} }', 'class C { async\nx() {} }', 'class C { async\n*x() {} }', 'class C { accessor\nx }',
    'class C { accessor\n*x() {} }', 'class C { accessor\n@d y() {} }', 'class C { static\n{} }',
    'class C { static async\n*x() {} }', 'class C { static async *x() {} }', 'class C { static get get() {} }',
    'class C { @d static accessor x = 1 }', 'class C { @d\nstatic async *[k]() {} }',
  ],
  reject: [
    'class C { static static x }', 'class C { accessor x() {} }', 'class C { accessor *x() {} }',
    'class C { accessor static x }', 'class C { accessor get x() {} }', 'class C { async static x() {} }',
    'class C { async get x() {} }', 'class C { async static {} }', 'class C { @d static {} }',
    'class C { static static {} }', 'class C { static @d x }', 'class C { get\nx; }', 'class C { set\nx = 1 }',
  ],
  tscDeparts: [
    'class C { accessor x() {} }', 'class C { accessor *x() {} }', 'class C { accessor static x }',
    'class C { accessor get x() {} }', 'class C { async static x() {} }', 'class C { async get x() {} }',
    'class C { async static {} }', 'class C { @d static {} }', 'class C { static static {} }',
  ],
};

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
  ['this parameter', `function h(this) {}`],
  ['nameless class declaration', `class extends B {}`],
  // a method has a body (MethodDefinition); one without is an overload signature
  ['bodiless method', `class C { m(); }`],
  ['bodiless accessor', `class C { get g() }`],
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

const s_fail: string[] = [];
for (const [want, codes] of [[true, statementEnds.accept], [false, statementEnds.reject]] as const) {
  for (const code of codes) {
    if (jsAccepts(code) !== want) s_fail.push(`tsc JS-mode does not ${want ? 'accept' : 'reject'} ${JSON.stringify(code)}: fix the case`);
    if (weAccept(code) !== want) s_fail.push(`we ${want ? 'reject' : 'accept'} ${JSON.stringify(code)}`);
  }
}
console.log('\n── Statement ends (ASI) ──');
console.log(`  ${statementEnds.accept.length + statementEnds.reject.length - s_fail.length}/${statementEnds.accept.length + statementEnds.reject.length} as the spec and tsc`);
for (const c of s_fail) console.log('    - ' + c);

const f_fail: string[] = [];
for (const [want, codes] of [[true, forHeads.accept], [false, forHeads.reject]] as const) {
  for (const code of codes) {
    const tscWant = forHeads.tscDeparts.includes(code) ? !want : want;
    if (jsAccepts(code) !== tscWant) f_fail.push(`tsc JS-mode ${tscWant ? 'rejects' : 'accepts'} ${JSON.stringify(code)}: fix the case or tscDeparts`);
    if (weAccept(code) !== want) f_fail.push(`we ${want ? 'reject' : 'accept'} ${JSON.stringify(code)}`);
  }
}
console.log('\n── for heads ──');
console.log(`  ${forHeads.accept.length + forHeads.reject.length - f_fail.length}/${forHeads.accept.length + forHeads.reject.length} as the productions (${forHeads.tscDeparts.length} where tsc departs)`);
for (const c of f_fail) console.log('    - ' + c);

const c_fail: string[] = [];
for (const [want, codes] of [[true, classElements.accept], [false, classElements.reject]] as const) {
  for (const code of codes) {
    const tscWant = classElements.tscDeparts.includes(code) ? !want : want;
    if (jsAccepts(code) !== tscWant) c_fail.push(`tsc JS-mode ${tscWant ? 'rejects' : 'accepts'} ${JSON.stringify(code)}: fix the case or tscDeparts`);
    if (weAccept(code) !== want) c_fail.push(`we ${want ? 'reject' : 'accept'} ${JSON.stringify(code)}`);
  }
}
console.log('\n── class element words ──');
console.log(`  ${classElements.accept.length + classElements.reject.length - c_fail.length}/${classElements.accept.length + classElements.reject.length} as the productions (${classElements.tscDeparts.length} where tsc departs)`);
for (const c of c_fail) console.log('    - ' + c);
const d_fail: string[] = [];
for (const [want, codes] of [[true, declarationLists.accept], [false, declarationLists.reject]] as const) {
  for (const code of codes) {
    const tscWant = declarationLists.tscDeparts.includes(code) ? !want : want;
    if (jsAccepts(code) !== tscWant) d_fail.push(`tsc JS-mode ${tscWant ? 'rejects' : 'accepts'} ${JSON.stringify(code)}: fix the case or tscDeparts`);
    if (weAccept(code) !== want) d_fail.push(`we ${want ? 'reject' : 'accept'} ${JSON.stringify(code)}`);
  }
}
console.log('\n── declaration lists and with ──');
console.log(`  ${declarationLists.accept.length + declarationLists.reject.length - d_fail.length}/${declarationLists.accept.length + declarationLists.reject.length} as the productions (${declarationLists.tscDeparts.length} where tsc departs)`);
for (const c of d_fail) console.log('    - ' + c);
const n_fail: string[] = [];
for (const [want, codes] of [[true, newTargets.accept], [false, newTargets.reject]] as const) {
  for (const code of codes) {
    const tscWant = newTargets.tscDeparts.includes(code) ? !want : want;
    if (jsAccepts(code) !== tscWant) n_fail.push(`tsc JS-mode ${tscWant ? 'rejects' : 'accepts'} ${JSON.stringify(code)}: fix the case or tscDeparts`);
    if (weAccept(code) !== want) n_fail.push(`we ${want ? 'reject' : 'accept'} ${JSON.stringify(code)}`);
  }
}
console.log('\n── new targets ──');
console.log(`  ${newTargets.accept.length + newTargets.reject.length - n_fail.length}/${newTargets.accept.length + newTargets.reject.length} as the productions (${newTargets.tscDeparts.length} where tsc departs)`);
for (const c of n_fail) console.log('    - ' + c);
const h_fail: string[] = [];
{
  const acorn = await import('acorn');
  const acornAccepts = (code: string) => { try { acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }); return true; } catch { return false; } };
  for (const [want, codes] of [[true, classHeritage.accept], [false, classHeritage.reject]] as const) {
    for (const code of codes) {
      const tscWant = classHeritage.tscDeparts.includes(code) ? !want : want;
      if (jsAccepts(code) !== tscWant) h_fail.push(`tsc JS-mode ${tscWant ? 'rejects' : 'accepts'} ${JSON.stringify(code)}: fix the case or tscDeparts`);
      if (acornAccepts(code) !== want) h_fail.push(`acorn ${want ? 'rejects' : 'accepts'} ${JSON.stringify(code)}: fix the case`);
      if (weAccept(code) !== want) h_fail.push(`we ${want ? 'reject' : 'accept'} ${JSON.stringify(code)}`);
    }
  }
  const tsParse = createParser((await import('../typescript.ts')).default).parse;
  const tsWe = (code: string) => { try { tsParse(code); return true; } catch (e) { if (isInputError(e)) return false; throw e; } };
  const tsAccepts = (code: string) => !((ts.createSourceFile('t.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) as any).parseDiagnostics?.length);
  for (const [want, codes] of [[true, tsHeritage.accept], [false, tsHeritage.reject]] as const) {
    for (const code of codes) {
      if (tsAccepts(code) !== want) h_fail.push(`tsc ${want ? 'rejects' : 'accepts'} ${JSON.stringify(code)} (TypeScript): fix the case`);
      if (tsWe(code) !== want) h_fail.push(`we ${want ? 'reject' : 'accept'} ${JSON.stringify(code)} (TypeScript)`);
    }
  }
}
const hN = classHeritage.accept.length + classHeritage.reject.length + tsHeritage.accept.length + tsHeritage.reject.length;
console.log('\n── class heritage ──');
console.log(`  ${hN - h_fail.length}/${hN} as the productions (JavaScript, acorn agreeing; ${classHeritage.tscDeparts.length} where tsc's JS mode departs) and tsc (TypeScript)`);
for (const c of h_fail) console.log('    - ' + c);
const i_fail: string[] = [];
{
  const acorn = await import('acorn');
  const acornAccepts = (code: string) => { try { acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' }); return true; } catch { return false; } };
  const tsParse = createParser((await import('../typescript.ts')).default).parse;
  const tsWe = (code: string) => { try { tsParse(code); return true; } catch (e) { if (isInputError(e)) return false; throw e; } };
  const tsAccepts = (code: string) => !((ts.createSourceFile('t.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) as any).parseDiagnostics?.length);
  for (const [want, codes] of [[true, identifierReferences.accept], [false, identifierReferences.reject]] as const) {
    for (const code of codes) {
      if (jsAccepts(code) !== want) i_fail.push(`tsc JS-mode ${want ? 'rejects' : 'accepts'} ${JSON.stringify(code)}: fix the case`);
      if (acornAccepts(code) !== want) i_fail.push(`acorn ${want ? 'rejects' : 'accepts'} ${JSON.stringify(code)}: fix the case`);
      if (tsAccepts(code) !== want) i_fail.push(`tsc ${want ? 'rejects' : 'accepts'} ${JSON.stringify(code)} (TypeScript): fix the case`);
      if (weAccept(code) !== want) i_fail.push(`we ${want ? 'reject' : 'accept'} ${JSON.stringify(code)}`);
      if (tsWe(code) !== want) i_fail.push(`we ${want ? 'reject' : 'accept'} ${JSON.stringify(code)} (TypeScript)`);
    }
  }
}
const iN = identifierReferences.accept.length + identifierReferences.reject.length;
console.log('\n── identifier references ──');
console.log(`  ${iN - new Set(i_fail.map((f) => f.replace(/ \(TypeScript\)$/, ''))).size}/${iN} as the productions (JavaScript: acorn and tsc's JS mode agreeing; TypeScript: tsc)`);
for (const c of i_fail) console.log('    - ' + c);
// ── Statement positions (14 Statement, 14 Declaration / StatementListItem, 16.2.3 ExportDeclaration) ──
// A sub-statement (the body of `if` / `else`, a loop, `with`, a label) is a Statement, never a
// Declaration: there `let` is the identifier (`if (f) let \n{}` is `let`, ASI, a block) and no
// `let` / `const` / `using` / class / generator / async function declaration stands. Annex B
// (B.3.3, sloppy mode) and LabelledItem keep a plain FunctionDeclaration in an `if` clause and
// after a label. `export` takes a Declaration or a VariableStatement, never another statement
// that begins with a declaration word (`export let: x;`). JavaScript: the productions, acorn
// agreeing (Script goal; Module for `export`). TypeScript: tsc's parser, which takes any
// declaration in a sub-statement position and leaves it to the checker.
const statementPositions: { accept: string[]; reject: string[] } = {
  accept: [
    'if (f) let \n{}', 'while (f) let \n{}', 'a: let \n{}', 'if (f) let;', 'if (f) let = 1;',
    'if (x) function f() {}', 'if (x) function f() {} else function g() {}', 'a: function f() {}',
    'export var a; export let b; export const c = 1; export function f() {} export class C {}',
  ],
  reject: [
    'if (x) let y = 1;', 'if (x) let [a] = b;', 'while (x) const y = 1;', 'for (;;) let y;', 'do let y; while (x)',
    'a: let y;', 'with (x) const y = 1;', 'if (x) class C {}', 'while (x) function f() {}',
    'if (x) async function f() {}', 'if (x) function* g() {}', 'a: function* g() {}', 'if (x) using y = z;',
    'export let: x;', 'export let.x = 1;', 'export var: x;', 'export using x = y;', 'export let\n;',
  ],
};
const p_fail: string[] = [];
const p_tsDeparts: string[] = [];
{
  const acorn = await import('acorn');
  const acornAccepts = (code: string) => { try { acorn.parse(code, { ecmaVersion: 'latest', sourceType: code.startsWith('export') ? 'module' : 'script' }); return true; } catch { return false; } };
  const tsParse = createParser((await import('../typescript.ts')).default).parse;
  const tsWe = (code: string) => { try { tsParse(code); return true; } catch (e) { if (isInputError(e)) return false; throw e; } };
  const tsAccepts = (code: string) => !((ts.createSourceFile('t.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) as any).parseDiagnostics?.length);
  const tsOnly = ['export using: x;', 'export await using meta x = y;', 'export using\nx = y;', 'export using x = y;', 'export await using x = y;', 'if (x) let y = 1;', 'if (x) class C {}'];
  for (const [want, codes] of [[true, statementPositions.accept], [false, statementPositions.reject]] as const) {
    for (const code of codes) {
      if (acornAccepts(code) !== want) p_fail.push(`acorn ${want ? 'rejects' : 'accepts'} ${JSON.stringify(code)}: fix the case`);
      if (weAccept(code) !== want) p_fail.push(`we ${want ? 'reject' : 'accept'} ${JSON.stringify(code)}`);
    }
  }
  // tsc's parser reads an empty declaration list there, as in `var;` (docs/CORRECTNESS.md): a recorded divergence.
  const tsRecorded = ['export let\n;'];
  for (const code of [...new Set([...statementPositions.accept, ...statementPositions.reject, ...tsOnly])]) {
    const want = tsAccepts(code);
    if (tsRecorded.includes(code)) { if (want === tsWe(code)) p_fail.push(`${JSON.stringify(code)} (TypeScript) agrees with tsc now: remove it from tsRecorded`); continue; }
    if (tsWe(code) !== want) p_fail.push(`we ${want ? 'reject' : 'accept'} ${JSON.stringify(code)} (TypeScript, tsc ${want ? 'accepts' : 'rejects'})`);
    if (statementPositions.accept.includes(code) !== want && !tsOnly.includes(code)) p_tsDeparts.push(code);
  }
}
console.log('\n── statement positions ──');
console.log(`  ${statementPositions.accept.length + statementPositions.reject.length} as the productions (JavaScript, acorn agreeing) and tsc (TypeScript; ${p_tsDeparts.length} where tsc's parser departs from the productions)${p_fail.length ? '' : ', all agree'}`);
for (const c of p_fail) console.log('    - ' + c);
// ── [Yield] / [Await] (15 YieldExpression, 15.8 AwaitExpression, 15.3 ArrowFunction) ──
// `yield` is the YieldExpression operator only in a generator body, `await` the AwaitExpression
// operator only in an async body (api.ts `when`); elsewhere each is an IdentifierReference (Script
// goal). An arrow's ConciseBody is [~Yield] and, unless the arrow is async, [~Await]. The top level
// reads `await` both ways (the Module goal's operator for the `module` rows, the Script goal's
// identifier for the others) until the goals land (grammar-utils.ts CTX_PARAMS `syncFn`).
// JavaScript: the productions, acorn agreeing. TypeScript: tsc's parser.
const contexts: { accept: string[]; reject: string[]; module: string[] } = {
  accept: [
    'iter = yield();', 'var yield; yield\n* x;', 'function f() { yield(x); }', 'function* g() { () => yield; }',
    'await = 1;', 'function f() { await(x); }', 'function* g() { yield 1; yield* a; yield\n1; }',
    'async function f() { await a; async () => await b; }', 'async function* g() { async () => await a; }',
    'await x;', 'const { default: d } = await import("m");',
  ],
  reject: [
    'yield * x = 1', 'async function* g() { () => yield a; }', 'async function f() { () => await a; }',
    'function* g() { () => yield a; }', 'function* g() { async () => yield a; }', 'function f() { await x; }',
    'function* g() { function f() { yield a; } }', 'async function f() { function g() { await a; } }', '() => await a',
  ],
  module: ['await x;', 'const { default: d } = await import("m");', '() => await a'],
};
const y_fail: string[] = [];
const y_tsDeparts: string[] = [];
{
  const acorn = await import('acorn');
  const acornAccepts = (code: string) => { try { acorn.parse(code, { ecmaVersion: 'latest', sourceType: contexts.module.includes(code) ? 'module' : 'script' }); return true; } catch { return false; } };
  const tsParse = createParser((await import('../typescript.ts')).default).parse;
  const tsWe = (code: string) => { try { tsParse(code); return true; } catch (e) { if (isInputError(e)) return false; throw e; } };
  const tsAccepts = (code: string) => !((ts.createSourceFile('t.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) as any).parseDiagnostics?.length);
  // TypeScript's grammar is unchanged by `when` (step 1 gates javascript.ts only; TypeScript keeps
  // tsc's reading, `await` an operator everywhere): tsc's parser refuses `yield * x = 1` outside a
  // generator, where typescript.ts reads `yield` as the operator everywhere. A recorded
  // divergence, owed to the TypeScript contexts step (the declared-contexts design, step 4).
  const tsRecorded = ['yield * x = 1'];
  for (const [want, codes] of [[true, contexts.accept], [false, contexts.reject]] as const) {
    for (const code of codes) {
      if (acornAccepts(code) !== want) y_fail.push(`acorn ${want ? 'rejects' : 'accepts'} ${JSON.stringify(code)}: fix the case`);
      if (weAccept(code) !== want) y_fail.push(`we ${want ? 'reject' : 'accept'} ${JSON.stringify(code)}`);
      const tsWant = tsAccepts(code);
      if (tsRecorded.includes(code)) { if (tsWe(code) === tsWant) y_fail.push(`${JSON.stringify(code)} (TypeScript) agrees with tsc now: remove it from tsRecorded`); }
      else if (tsWe(code) !== tsWant) y_fail.push(`we ${tsWant ? 'reject' : 'accept'} ${JSON.stringify(code)} (TypeScript, tsc ${tsWant ? 'accepts' : 'rejects'})`);
      if (tsWant !== want) y_tsDeparts.push(code);
    }
  }
}
console.log('\n── [Yield] / [Await] ──');
console.log(`  ${contexts.accept.length + contexts.reject.length} as the productions (JavaScript, acorn agreeing) and tsc (TypeScript; ${y_tsDeparts.length} where tsc's parser departs from the productions)${y_fail.length ? '' : ', all agree'}`);
for (const c of y_fail) console.log('    - ' + c);
// Corpora 1, 2, the statement ends, the for heads, the class element words, the declaration
// lists, the statement positions, the new targets, the class heritage and the identifier
// references are hard gates.
// ── Expected-fail: inputs the productions reject that the grammar accepts today, each with its
// cause. The gate fails when one of them is rejected (remove it then) or tsc stops rejecting it.
const expectedFail: { code: string; reason: string }[] = [
];
const x_fail: string[] = [];
for (const { code, reason } of expectedFail) {
  if (jsAccepts(code)) x_fail.push(`tsc JS-mode accepts ${JSON.stringify(code)}: not a rejection, fix the case`);
  if (!weAccept(code)) x_fail.push(`we reject ${JSON.stringify(code)} now: remove the expected-fail (${reason})`);
}
console.log('\n── expected-fail ──');
console.log(`  ${expectedFail.length} accepted although the productions reject them (${new Set(expectedFail.map((e) => e.reason)).size} cause(s))${x_fail.length ? '' : ', as recorded'}`);
for (const c of x_fail) console.log('    - ' + c);
const gateFailed = v_fail.length + r_leak.length + s_fail.length + f_fail.length + c_fail.length + d_fail.length + n_fail.length + h_fail.length + i_fail.length + p_fail.length + y_fail.length + x_fail.length > 0;
if (gateFailed) process.exit(1);
