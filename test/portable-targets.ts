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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createParser } from '../src/gen-parser.ts';
import { compileTokenizer, lexSpecOf } from '../src/emit-lexer.ts';
import { emitParser, tsTarget, goTarget, rustTarget } from '../src/emit.ts';
import { asGoMain } from './go-main.ts';
import type { CstGrammar } from '../src/types.ts';

type Case = { grammar: string; path: string; accept: string[]; reject: string[]; tsOnly?: boolean };
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
    // The REAL javascript.ts grammar (89 rules after the [Await]/[Yield] fork) — the proof
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
      'x.y.z++;', '(a++).b;', 'a++ instanceof B;', 'a++(x);',
      'for (a in b) c;',
      'for (a = x in b) c;',
      'for (a in b) { d = c in e; }',
      'new a.b();', '((((x))));',
      'for (a = x + y in b) c;',
      // An assignment / update operand needs only a LeftHandSideExpression's shape; target validity is a consumer's.
      '-x++;', '(a) = 1;', 'a = b = c;', '1 = 2;', '1++;', '++1;', 'f() = 1;', 'f()++;', '++f();', 'this = 1;',
      '(a + b) = c;', '(a, b) = 1;', 'a?.b = 1;', 'a?.b++;', '[a + b] = c;', '({a: 1} = c);', 'new.target = 1;',
      'for (1 of x);', 'for (a + b in x);', 'for (f() in x);',
    ],
    reject: ['function (', 'a +;', 'if x {}', '{ a: }', 'for (;;', 'a ? b ;',
      '1 + () => 2;', 'a++.b;', 'f(a, b,',
      'for (a = (x in b)) c;',
      'for (a = b ? x in c : y in d) e;',
      // An assignment / update operand (prefix ++/-- included) without a LeftHandSideExpression's shape has no parse.
      'a + b = c;', 'a++ = 1;', '-a = 1;', '++ -x;', '++x++;', '++ ++x;'],
  },
  {
    // The real typescript.ts grammar — the second, most complex full language proving the
    // agnostic emitter (types, generics, interfaces, enums, assertions, variance). ASCII.
    grammar: 'typescript', path: '../typescript.ts',
    accept: [
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
      'x = { static: 1, public() {}, get: 2 };', 'x = { public static x() {}, static get y() { return 1; } };',
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
    ],
    // Operators that require an assignment target or forbid a unary left operand.
    reject: ['interface {}', 'const x: = 1;', 'enum {}', 'a + ;',
      'a + b = 1;', 'a < b = 1;', 'a in b = 1;', 'a as T = 1;', '-x = 1;', 'x++ = 1;', '++x++;', '++-x;', '++ ++x;', '-x ** 2;', 'typeof x ** 2;', 'm > B<C> >>= 1;',
      // Only an access tail extends an access tail.
      'a = x++.y;', '-B<C>.d;', 'x as T (1);', 'x = B<C>.d;', 'x = B<C>?.d;',
      'x = B<C> < 1;', 'x = B<C> >= 1;', 'x = B<C>!;', 'x = B<C> /re/;',
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
      'class C { p: this is }', 'var v = y as this is;', 'function f(x: any): void is T { }', 'function f(x: any): class is T { }'],
  },
];

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

const TMP = '/tmp/portable-targets';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
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
type Align = { oldN: number; newN: number; prefix: number; suffix: number; relexed?: number; reused?: number; streamEq?: boolean; treeEq?: boolean };
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
type TsLib = { parse(src: string): unknown; createDoc(src: string, opts: { validate: boolean }): TsDoc };
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

type Runner = {
  label: string;
  run: (src: string) => Outcome;
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
const UNICODE_EDITS: { name: string; init: string; batches: EditBatch[]; restores?: boolean }[] = [
  { name: 'edit-before-multibyte', init: 'const x = "café";', batches: [[[14, 14, 'X']]] },
  { name: 'edit-replace-multibyte', init: 'const x = "café";', batches: [[[14, 15, 'e']]] },
  { name: 'edit-after-multibyte', init: 'const x = "café";', batches: [[[15, 15, '!']]] },
  // delete the closing backtick / `*/` → reject; restore → accept (edit ≡ fresh)
  { name: 'edit-unterm-template-restore', init: 'const x = `cafe`;', batches: [[[15, 16, '']], [[15, 15, '`']]], restores: true },
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
  }
  console.log(`  javascript/unicode/${r.label}: ${editOk}/${UNICODE_EDITS.length} edit-sessions ≡ fresh`);
}

let failures = 0;
for (const c of CASES) {
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
  writeFileSync(`${dir}/lib.ts`, tsLibSrc);
  const tsLib = await import(`${dir}/lib.ts`) as TsLib;
  runners.push({
    label: 'typescript', run: (src) => tsRun(tsLib, src), edit: (json, fast) => tsEditSession(tsLib, json, fast),
    spans: { cmd: 'node', args: [tsFile, 'tok-spans'] }, utf8Edits: false,
  });

  if (HAS_GO && !c.tsOnly) {
    const gdir = `${dir}/go`; mkdirSync(gdir, { recursive: true });
    writeFileSync(`${gdir}/parser.go`, asGoMain(emitParser(grammar, goTarget)));
    writeFileSync(`${gdir}/runner.go`, goTarget.emitRunner?.() ?? '');
    writeFileSync(`${gdir}/go.mod`, 'module p\n\ngo 1.21\n');
    execFileSync('go', ['build', '-o', `${gdir}/p`, '.'], { cwd: gdir, stdio: 'pipe' });
    const bin = `${gdir}/p`;
    runners.push({
      label: 'go', run: (src) => runProc(bin, [], src), edit: (json, fast) => runEditSession(bin, [fast ? 'edit-session-fast' : 'edit-session'], json),
      spans: { cmd: bin, args: ['tok-spans'] }, utf8Edits: true,
    });
  }
  if (HAS_RUST && !c.tsOnly) {
    const rfile = `${dir}/main.rs`;
    const bin = `${dir}/pr`;
    writeFileSync(rfile, emitParser(grammar, rustTarget) + (rustTarget.emitRunner?.() ?? ''));
    execFileSync('rustc', ['-A', 'warnings', rfile, '-o', bin], { stdio: 'pipe' });
    runners.push({
      label: 'rust', run: (src) => runProc(bin, [], src), edit: (json, fast) => runEditSession(bin, [fast ? 'edit-session-fast' : 'edit-session'], json),
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
}

if (failures > 0) {
  console.error(`\n✗ portable targets diverge from the interpreter (${failures} case(s))`);
  process.exit(1);
}
console.log('\n✓ portable parsers (ts/go/rust) derived from each grammar ≡ interpreter on accept/reject parity (compiled & run)');
