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
// Go/Rust toolchains are optional: a missing `go`/`rustc` is logged and skipped (the TS
// rendering, which needs only node, always runs).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createParser } from '../src/gen-parser.ts';
import { createLexer } from '../src/gen-lexer.ts';
import { emitParser, tsTarget, goTarget, rustTarget } from '../src/emit.ts';
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
    // Newline-only mode (engine-emitted NEWLINE at significant line boundaries; flow suspension).
    grammar: 'envspec', path: './fixtures/envspec.ts',
    accept: [
      'A=1', 'A=1\nB=2', 'A=1\n', 'A=1\n# c\nB=2', 'A=fn(1,\n2)\nB=3',
      'A=1\n\n\nB=2', '\n\nA=1', 'A=fn(1,\n2)',
    ],
    reject: ['A B', 'A=', 'A=1 B=2', 'A=fn(1,'],
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
    // can't attach (`a++--`, `a++.b` are ill-formed; `(a++).b` is fine).
    grammar: 'postjs', path: './fixtures/postjs.ts',
    accept: [
      'x++;', 'x--;', 'a + b++;', '++x;', 'x++ + y;', 'a.b++;', '(x)++;', '--a.b;',
      'x++ * 2;', '(a++).b;', 'x.y.z++;',
    ],
    reject: ['a++--;', 'a++.b;', 'a++ ++;', '++;'],
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
    ],
    reject: ['function (', 'a +;', 'if x {}', '{ a: }', 'for (;;', 'a ? b ;',
      '1 + () => 2;', 'a++.b;', 'f(a, b,',
      'for (a = (x in b)) c;',
      'for (a = b ? x in c : y in d) e;'],
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
    ],
    reject: ['interface {}', 'const x: = 1;', 'enum {}', 'a + ;'],
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

type Outcome = { ok: true; cst: string } | { ok: false };
function runProc(cmd: string, args: string[], src: string): Outcome {
  try { return { ok: true, cst: canon(JSON.parse(execFileSync(cmd, args, { input: src, stdio: ['pipe', 'pipe', 'pipe'] }).toString())) }; }
  catch { return { ok: false }; }
}
type Align = { oldN: number; newN: number; prefix: number; suffix: number; relexed?: number; streamEq?: boolean };
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
  const r = spawnSync(cmd, args, { input: json, encoding: 'utf8' });
  const align = parseAlignStderr(r.stderr ?? '');
  if (r.status !== 0) return { ok: false, align };
  try {
    return { ok: true, cst: canon(JSON.parse(r.stdout)), align };
  } catch { return { ok: false, align }; }
}

type AlignMeta = { kind: string; off: number; end: number; nl: boolean };
const oracleToks = (g: CstGrammar, src: string): AlignMeta[] => {
  const { tokenize } = createLexer(g);
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
type EditScenario = { init: string; batches: EditBatch[]; large?: boolean; maxRelexed?: number; fullRelex?: boolean };
const calcLargeInit = '1+2*3+'.repeat(199) + '1+2*3';
const envspecLargeInit = 'A=1\n'.repeat(300);
const regexjsLargeInit = 'var r = /abc/g; a / b;\n'.repeat(60);
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
  ],
  javascript: [
    { init: 'let a = 1;\nf(a);', batches: [[[8, 9, '42']]], fullRelex: true },
    { init: 'let a = 1;\nf(a);', batches: [[[11, 16, '']]], fullRelex: true },
    { init: 'let a = 1;\nf(a);', batches: [[[4, 5, 'b'], [12, 13, 'b']]], fullRelex: true },
    { init: 'let a = 1;\nf(a);', batches: [[[16, 16, '\ng(b);']], [[0, 4, 'var']]], fullRelex: true },
    { init: 'let a = 1;\nf(a);\n'.repeat(80), batches: [[[688, 689, '9']]], large: true, fullRelex: true },
  ],
  envspec: [
    { init: 'A=1\nB=2', batches: [[[2, 2, '3']]] },
    { init: envspecLargeInit, batches: [[[600, 601, '9']]], large: true, maxRelexed: 10 },
    { init: 'A=fn(1,\n2)\nB=3', batches: [[[6, 7, '9']]] },
    { init: 'A=fn(1,\n2)\nB=3', batches: [[[4, 4, '(']]] },
    { init: 'A=1\n# note\nB=2', batches: [[[7, 7, 'x']]] },
    { init: 'A=1\n\n\nB=2', batches: [[[4, 4, '\n']]] },
    { init: envspecLargeInit, batches: [[[envspecLargeInit.length, envspecLargeInit.length, 'Z=9']]], large: true, maxRelexed: 10 },
    { init: 'A=fn(1,\n2)\nB=3', batches: [[[0, 0, 'X']], [[7, 7, '0']]] },
  ],
  regexjs: [
    { init: 'var re = /[a-z]+/i; x / y;', batches: [[[11, 12, '0']]] },
    { init: 'x = a / b / c;', batches: [[[4, 6, '']]] },
    { init: 'if (x) /y/;', batches: [[[0, 2, 'f']]] },
    { init: regexjsLargeInit, batches: [[[600, 601, '9']]], large: true, maxRelexed: 15 },
    { init: 'f(x); a / b;', batches: [[[2, 2, '(']]] },
    { init: 'if (x) /y/;', batches: [[[11, 11, ' /z/;']]] },
  ],
};
const applyEdits = (init: string, batches: EditBatch[]): string => {
  let text = init;
  for (const batch of batches) for (const [start, end, repl] of batch) text = text.slice(0, start) + repl + text.slice(end);
  return text;
};

let failures = 0;
for (const c of CASES) {
  const grammar: CstGrammar = (await import(c.path)).default;
  const oracle = createParser(grammar);
  const oracleOut = (src: string): Outcome => { try { return { ok: true, cst: canon(oracle.parse(src)) }; } catch { return { ok: false }; } };

  const dir = `${TMP}/${c.grammar}`;
  mkdirSync(dir, { recursive: true });
  const runners: Array<{ label: string; run: (src: string) => Outcome }> = [];

  // emitParser is the parser LIBRARY (exports a `parse` entry, no I/O); the executable CLI
  // runner (stdin → CST JSON) is the target's emitRunner(), assembled in HERE — the harness's
  // job, not the parser's. ts/rust append the runner to the library (one file); Go needs it as
  // a SEPARATE runner.go in the same `package main` (its import rules forbid appending inline).
  const tsFile = `${dir}/p.ts`;
  writeFileSync(tsFile, emitParser(grammar, tsTarget) + (tsTarget.emitRunner?.() ?? ''));
  runners.push({ label: 'typescript', run: (src) => runProc('node', [tsFile], src) });

  if (HAS_GO && !c.tsOnly) {
    const gdir = `${dir}/go`; mkdirSync(gdir, { recursive: true });
    writeFileSync(`${gdir}/parser.go`, emitParser(grammar, goTarget));
    writeFileSync(`${gdir}/runner.go`, goTarget.emitRunner?.() ?? '');
    writeFileSync(`${gdir}/go.mod`, 'module p\n\ngo 1.21\n');
    execFileSync('go', ['build', '-o', `${gdir}/p`, '.'], { cwd: gdir, stdio: 'pipe' });
    runners.push({ label: 'go', run: (src) => runProc(`${gdir}/p`, [], src) });
  }
  if (HAS_RUST && !c.tsOnly) {
    const rfile = `${dir}/main.rs`;
    writeFileSync(rfile, emitParser(grammar, rustTarget) + (rustTarget.emitRunner?.() ?? ''));
    execFileSync('rustc', ['-O', '-A', 'warnings', rfile, '-o', `${dir}/pr`], { stdio: 'pipe' });
    runners.push({ label: 'rust', run: (src) => runProc(`${dir}/pr`, [], src) });
  }

  for (const r of runners) {
    let acc = 0, rej = 0, snap = 0;
    for (const src of c.accept) {
      const want = oracleOut(src), got = r.run(src);
      if (want.ok && got.ok) {
        acc++;
        // Shape snapshot on a few tiny inputs: the rule-node skeleton (rule labels tree,
        // trivia/punct leaves stripped) must match the oracle's. Robust to leaf-level CST
        // compression (Phase 5) but catches semantic restructure (a node becoming a different
        // rule / merging / disappearing).
        if (src && c.accept.indexOf(src) < 2 && canon(skeleton(want.cst)) !== canon(skeleton(got.cst))) {
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
      let editOk = 0, alignOk = 0;
      const editCmd = r.label === 'typescript' ? 'node' : r.label === 'go' ? `${dir}/go/p` : `${dir}/pr`;
      const editArgs = r.label === 'typescript' ? [`${dir}/p.ts`, 'edit-session'] : ['edit-session'];
      const runEdit = (json: string) => runEditSession(editCmd, editArgs, json);
      for (const sc of editScenarios) {
        const final = applyEdits(sc.init, sc.batches);
        const a = runEdit(JSON.stringify({ init: sc.init, batches: sc.batches }));
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
      }
      console.log(`  ${c.grammar}/${r.label}: ${editOk}/${editScenarios.length} edit-sessions ≡ fresh`);
      console.log(`  ${c.grammar}/${r.label}: ${alignOk}/${editScenarios.length} token-alignments ≡ oracle`);
    }
  }
}

if (failures > 0) {
  console.error(`\n✗ portable targets diverge from the interpreter (${failures} case(s))`);
  process.exit(1);
}
console.log('\n✓ portable parsers (ts/go/rust) derived from each grammar ≡ interpreter on accept/reject parity (compiled & run)');
