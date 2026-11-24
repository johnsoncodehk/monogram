// ─────────────────────────────────────────────────────────────────────────────
//  treesitter-verdicts.ts — the derived tree-sitter grammars against the interpreter (createParser)
//  on the same inputs (CI `treesitter` job, after the wasms are built; never in the `test` job's loop).
//  One check over a list of corpora per grammar: the synthetic ones below (JSX, issue cases, reserved
//  words, line breaks, lookaheads, comments, contextual keywords) and the REAL-CODE ones, pinned
//  checkouts CI clones: TypeScript's own src/ at TS_REPO_SHA (typescript) and test262's syntax tests at
//  test/test262.sha (javascript; the files the interpreter accepts).
//  Every disagreement is pinned in test/treesitter-record.txt with its class: an input where tree-sitter
//  reports an ERROR / MISSING node and the interpreter accepts (a defect), one tree-sitter accepts and
//  the interpreter rejects (an over-acceptance), a line-break input split into other statements. The
//  check fails on any movement in either direction, a fix included (re-record it: --write, and say
//  in the landing what left the record). A class is the first cause of a file's ERROR, found by delta
//  debugging (docs/HIGHLIGHTER-EVIDENCE.md, "tree-sitter"); --write keeps the recorded classes and
//  gives a new entry `unclassified`.
//  Build the wasms first (CI does): cd tree-sitter/<g> && npx tree-sitter generate && npx tree-sitter build --wasm .
//  Run: node test/treesitter-verdicts.ts [--write]   (appends the tables to $GITHUB_STEP_SUMMARY when set)
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createParser } from '../src/interpreter.ts';
import { collectLiterals } from '../src/grammar-utils.ts';
import { JSX_CASES } from './curated-corpora.ts';
import { cases as tsxIssueCases } from './tsx-issue-cases.ts';
import { tests as issueTests } from './issue-cases.ts';

// The issue cases no real-code corpus holds (the rest are implied by TypeScript src): regular
// expression edge cases, `with`, `import defer`, a comment inside type arguments, `&` after
// `instanceof`.
const UNIQUE_ISSUE_INPUTS = new Set(['/\\cJ/', '/[a\\-b]/g', 'const re = /foo/v;', 'with (obj) { x; }', 'import defer * as ns from "x";',
  'new Map</* comment */string, IArgs>()', 'if (a instanceof B & c) {}']);
const issueInputs = issueTests.map(t => t.input).filter(i => UNIQUE_ISSUE_INPUTS.has(i));
if (issueInputs.length !== UNIQUE_ISSUE_INPUTS.size) throw new Error(`treesitter-verdicts: ${UNIQUE_ISSUE_INPUTS.size - issueInputs.length} of the kept issue cases are no longer in test/issue-cases.ts`);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// JSX children with free text (an apostrophe, `%`, an entity, punctuation, a line break): the only
// JSX text either real-code corpus lacks; both parsers accept them.
const JSX_TEXT = [
  'const a = <p>Don\'t stop</p>;',
  'const b = <p>100% sure</p>;',
  'const c = <p>a &nbsp; b</p>;',
  'const d = <p>Hello, world!</p>;',
  'const e = <p>line one\n  line two</p>;',
];

// Reserved words in and out of identifier positions: the near-misses a dropped reserved-word guard
// lets through (`var if`), beside the valid uses of the same words (property names, `as` targets).
// The interpreter's verdict is the oracle, as for every corpus here.
const RESERVED_WORDS = [
  'var if = 1;', 'let class = 2;', 'function return() {}', 'const { default } = o;',
  'try {} catch (this) {}', 'class A extends while {}', 'import { if } from "m";', 'import while from "m";',
  'x = { if };', 'for (var new of a);', 'function f(delete) {}', 'const [typeof] = a;', 'x = y + break;', 'var enum = 1;',
  'a.if = 1;', 'x = { if: 1, class: 2 };', 'import { default as d } from "m";', 'class C { if() {} }', 'class C { static() {} }',
  'export { x as default };', 'o.class.new = 1;', 'x = { get if() { return 1; } };', 'o.enum = { enum: 1 };',
];

// Line breaks: statements ended by a line break, `}` or the end of the input; the restricted
// productions (`return` / `break` / `continue` and what follows on the next line, a postfix `++` /
// `--` after a line break, `async` and `function` on two lines); the continuations a line break does
// not end (`(`, `[`, `.`, an infix operator, `=`); comments before the break; and the near misses two
// statements on one line are. The interpreter's verdict is the oracle; an input that splits into two
// statements where the interpreter splits it parses without ERROR only when split the same way
// (`a\n++b` is `a; ++b`, never `a++ b`).
const LINE_BREAKS = [
  'let a = 1\nlet b = 2', 'a = 1\nb = 2', 'f()\ng()', '{ a = 1 }', '{ a = 1\n}', 'a = 1', 'a = 1\n', 'x\n++y', 'x\n--y', 'x++\ny',
  'function f() { return\nx }', 'function f() { return }', 'function f() { return x\n}', 'function f() { return\n}',
  'a = b\n(c)', 'a = b\n[c]', 'a\n.b', 'a\n+b', 'let x\n= 1', 'a\n? b : c', 'a\ninstanceof B',
  'foo: while (1) { break\nfoo }', 'foo: while (1) { continue\nfoo }', 'foo: while (1) { break foo\n}',
  'async\nfunction f() {}', 'x = async\nfunction () {}', 'async function f() {}', 'throw\nx', 'throw x\n',
  'function* g() { yield\nx }', 'function* g() { yield x\n}', 'debugger\nx', 'import a from "m"\nx', 'export * from "m"\nx',
  'a /* c */\nb', 'a // c\nb', 'a /*\n*/ b', 'a\n// c\nb', 'a\n/* c */ b',
  'class C { x = 1\n y = 2 }', 'class C { static\n x() {} }', 'class C { accessor\n x = 1 }', 'class C { async\n x() {} }',
  'x = y\n=> 1', 'a\n`t`', 'a\n/b/g',
  // after a same-line marker, a token a literal begins (`/` a regex, `.` a number)
  'function f() { return /a/; }', 'function f() { return /a/ }', 'function f() {\n return /^a/.test(x);\n}', 'function f() { return /=a/; }',
  'function f() { return .5; }', 'function f() { return `t`; }', 'function f() { return\n/a/ }',
  'if (a) { out.push(1); }', 'if (a) { x.push(1); }',
  // a same-line marker before a name that a keyword may be (the step's own guard decides)
  'class C { async if() {} }', 'class C { accessor if = 1 }', 'class C { get\n if() {} }', 'x = async true => 1', 'x = async if => 1',
  'a b', 'let a = 1 let b = 2', 'f() g()', 'return x y', 'a = 1 b = 2', 'x ++y', '{ a = 1 b = 2 }',
  // TypeScript
  'let x: T\nlet y', 'type A = B\ntype C = D', 'f()\n{ g() }', 'x!\n.y', 'x\n!y', 'let x: T\n[]', 'let x: A\n<B>(y)', 'interface I { a: T\n b: U }',
];

// One-token lookaheads (`not(X)` / `not(not(Y))` before what follows): what `export` takes (a
// declaration, never another statement), the starts an expression statement or an arrow's concise body
// excludes (`{`, `function`, `class`), the for-head and `try` conditions; each beside the valid form.
const LOOKAHEADS = [
  'export x;', 'export if (a) {}', 'export { a };', 'export {};', 'export var a = 1;', 'export let x;', 'export let = 1;', 'export let;',
  'export const a = 1;', 'export function f() {}', 'export { a } from "m";', 'export ;', 'export { a }.b;', 'export let[0] = 1;', 'export x = 1;',
  'export async function f() {}', 'export class C {}',
  '{}.b;', '{} .b', '({}).b;', 'function f() {}.x;', '(function () {}).x;', 'function f(){}\n(g)()', 'class C {}.x;', '(class {}).x;',
  'x = () => {}.x;', 'x = () => ({}).x;', 'x = () => {};', 'x = async () => {}.y;', 'x = a => {}.y;',
  'for (let [a] of b);', 'for ([a] of b);', 'for ({a} of b);', 'for (let in a);', 'for (let.x in a);', 'for (let of a);', 'for (async of a);', 'try {}', 'try {} finally {}',
];

// Block comments: the near misses a comment token that ran past its first `*/` would accept
// (tree-sitter's lexer takes the longest token). The valid comment forms are TypeScript src's.
const COMMENTS = ['/* a */ x */ y;', '/* a */ ) /* b */', 'x = /* a */ 1 */ 2;'];

// A continuation whose operand is another rule that continues (`x as T` then Type's own `[ ]`, `|`,
// `&`, `<`, `?`, `.`): the operand is read whole where it continues, and the expression takes the
// token where the operand's continuation fails (`a as T < b`, `x as T ? a : b`). An operand that ends
// in a type of its own (`| A`, `keyof A`, `() => A`) takes the continuations too (`x as | A | B` is not
// `(x as | A) | B`): spans compared, as a wrong tree here has no ERROR.
const OPERANDS = [
  'x as T[];', 'x satisfies T[];', 'x as A | B;', 'x as A & B;', '<T[]>x;', 'x as T[] | U;', 'x as const;', 'a as T < b;',
  'x as T ? a : b;', 'x as T[0];', 'x as T<U>[];', 'a as any as T[];', 'f(x as T[], y);', 'x as T | U[];', 'x as T\n[0];',
  'y = x as T extends U ? A : B;', 'x as T < b > c;',
  'x as | A | B;', '(x as | A | B).y;', 'x as & A.B;', 'x as () => A | B;', 'x as keyof A | B;', 'x as keyof A ? b : c;',
];

// Contextual keywords: every word-shaped literal the grammar writes (`static`, `type`, `of`, `if`, ...),
// as a name in each position class: one class per word-token step of the JavaScript and TypeScript
// grammars. The word list is
// read from the grammar, not from the generator, so every keyword is tried in every position. Only
// the inputs the interpreter accepts are kept (reserved words drop out where the
// grammar excludes them), so the target is that every one parses.
const CONTEXTUAL_POSITIONS = [
  (w: string) => `let ${w} = 1;`,                        // binding name
  (w: string) => `function f(${w}) {}`,                  // parameter
  (w: string) => `x = ${w} + 1;`,                        // expression
  (w: string) => `class C { ${w}() {} }`,                // class member name
  (w: string) => `o.${w} = { ${w}: 1 };`,                // property access, property key
  (w: string) => `x = { ${w} };`,                        // shorthand property
  (w: string) => `import { ${w} } from "m";`,            // import specifier
  (w: string) => `import ${w} from "m";`,                // default import
  (w: string) => `export { ${w} };`,                     // export specifier
  (w: string) => `${w}: while (1) break ${w};`,          // label
  (w: string) => `${w}: for (;;) continue ${w};`,        // continue label
  (w: string) => `function ${w}() {}`,                   // function declaration name
  (w: string) => `function* ${w}() {}`,                  // generator declaration name
  (w: string) => `class ${w} {}`,                        // class declaration name
  (w: string) => `x = function ${w}() {};`,              // function expression name
  (w: string) => `x = function* ${w}() {};`,             // generator expression name
  (w: string) => `x = class ${w} {};`,                   // class expression name
  (w: string) => `class C extends ${w} {}`,              // heritage
  (w: string) => `x = ${w} => 1;`,                       // arrow parameter
  (w: string) => `x = async ${w} => 1;`,                 // async arrow parameter
  (w: string) => `x = ${w}.y;`,                          // member object
  (w: string) => `for (const ${w} of a);`,               // for-of binding
  (w: string) => `for (let ${w} in a);`,                 // for-in binding
  (w: string) => `let { ${w} } = o;`,                    // shorthand binding property
  (w: string) => `let { a: ${w} } = o;`,                 // binding property value
  (w: string) => `let { ${w}: a } = o;`,                 // binding property key
  (w: string) => `let { ...${w} } = o;`,                 // binding rest property
  (w: string) => `let [${w}] = a;`,                      // array binding element
  (w: string) => `let [...${w}] = a;`,                   // array binding rest
  (w: string) => `function f(...${w}) {}`,               // rest parameter
  (w: string) => `try {} catch (${w}) {}`,               // catch parameter
  (w: string) => `import { a as ${w} } from "m";`,       // import alias
  (w: string) => `import { ${w} as a } from "m";`,       // imported name
  (w: string) => `import * as ${w} from "m";`,           // namespace import
  (w: string) => `export { a as ${w} };`,                // export alias
  (w: string) => `export { ${w} as a };`,                // exported local
  (w: string) => `export * as ${w} from "m";`,           // namespace export
  // TypeScript
  (w: string) => `let x: ${w};`,                         // type reference
  (w: string) => `let x: ${w}.T;`,                       // qualified type name
  (w: string) => `let x: typeof ${w};`,                  // typeof query
  (w: string) => `let x: [${w}: string];`,               // named tuple member
  (w: string) => `let f: (${w}: number) => void;`,       // function type parameter
  (w: string) => `let f: (...${w}: number[]) => void;`,  // function type rest parameter
  (w: string) => `type ${w} = 1;`,                       // type alias name
  (w: string) => `interface ${w} {}`,                    // interface name
  (w: string) => `enum ${w} {}`,                         // enum name
  (w: string) => `namespace ${w} {}`,                    // namespace name
  (w: string) => `declare module ${w} {}`,               // module name
  (w: string) => `function f<${w}>() {}`,                // type parameter
  (w: string) => `function f<const ${w}>() {}`,          // const type parameter
  (w: string) => `type T<in ${w}> = 1;`,                 // variance-annotated type parameter
  (w: string) => `type T = X extends infer ${w} ? 1 : 2;`, // infer
  (w: string) => `function f(x): asserts ${w} {}`,       // asserts predicate
  (w: string) => `function f(x): ${w} is string {}`,     // type predicate
  (w: string) => `interface I { ${w}: 1 }`,              // property signature
  (w: string) => `interface I { m(${w}): void }`,        // method signature parameter
  (w: string) => `interface I { [${w}: string]: 1 }`,    // index signature parameter
  (w: string) => `interface I { new (${w}): I }`,        // construct signature parameter
  (w: string) => `class C { [${w}: string]: any }`,      // class index signature
  (w: string) => `class C { constructor(public ${w}) {} }`, // parameter property
  (w: string) => `class C { static ${w}() {} }`,         // modified member name
  (w: string) => `class C implements ${w} {}`,           // implements clause
  (w: string) => `import ${w} = require("m");`,          // import-equals name
  (w: string) => `import x = ${w}.y;`,                   // import-equals module reference
  (w: string) => `import { type ${w} } from "m";`,       // type-only import specifier
  (w: string) => `export { type ${w} };`,                // type-only export specifier
  (w: string) => `export type { ${w} };`,                // type-only export clause
  (w: string) => `@${w} class C {}`,                     // decorator
  (w: string) => `let x = <${w}>y;`,                     // type assertion
];

/** The word-shaped literals of a grammar's rules and operators. */
function wordLiterals(g: { rules: { body: any }[]; precs: { operators: { value: string }[] }[] }): string[] {
  const out = new Set<string>();
  for (const r of g.rules) for (const l of collectLiterals(r.body)) out.add(l);
  for (const lvl of g.precs) for (const o of lvl.operators) out.add(o.value);
  return [...out].filter(w => /^[A-Za-z_$][\w$]*$/.test(w)).sort();
}

// Operator pairs: `a OP1 c OP2 d` for one operator per precedence level of the grammar's table, every
// continuation connector it declares (ledPrec: `?:`, `in`, `instanceof`, `as`, `satisfies`) and every
// prefix / postfix operator against each of them, nested both ways. Where both accept, tree-sitter's
// expression nodes must span what the interpreter's do: a precedence number that disagrees with the
// Pratt loop's binding power builds a wrong tree with no ERROR (`a ? b : c + d` as `(a ? b : c) + d`),
// which no verdict comparison sees. The pairs that still bracket differently are recorded (`brackets`).
function operatorPairs(gr: { precs: { operators: { value: string; position: string }[] }[]; ledPrecs?: { connector: string }[] }): string[] {
  const bin: string[] = [], pre: string[] = [], post: string[] = [];
  for (const lvl of gr.precs) {
    const i = lvl.operators.find(o => o.position === 'infix'); if (i) bin.push(i.value);
    for (const o of lvl.operators) if (o.position === 'prefix' && !pre.includes(o.value)) pre.push(o.value);
    const p = lvl.operators.find(o => o.position === 'postfix'); if (p) post.push(p.value);
  }
  const forms: ((l: string, r: string) => string)[] = bin.map(op => (l, r) => `${l} ${op} ${r}`);
  for (const lp of gr.ledPrecs ?? []) {
    if (lp.connector === '?') forms.push((l, r) => `${l} ? b : ${r}`);
    else if (lp.connector === 'as' || lp.connector === 'satisfies') forms.push(l => `${l} ${lp.connector} T`);
    else forms.push((l, r) => `${l} ${lp.connector} ${r}`);
  }
  const out = new Set<string>();
  for (const f1 of forms) for (const f2 of forms) { out.add(f2(f1('a', 'c'), 'd') + ';'); out.add(f1('a', f2('c', 'd')) + ';'); }
  for (const p of pre) for (const f of forms) out.add(f(/\w$/.test(p) ? `${p} a` : `${p}a`, 'c') + ';');
  for (const p of post) for (const f of forms) out.add(f(`a${p}`, 'c') + ';');
  for (const f of forms) { out.add(`x = y => ${f('a', 'c')};`); out.add(`x = ${f('a', 'c')};`); out.add(`x = a ? ${f('b', 'c')} : d;`); }
  // `yield` is a capped NUD arm (an AssignmentExpression form), not a prefix of the table, so the
  // loop above does not draw it: its operand must still span every operator form (`yield (a + c)`),
  // a comma must end it (`x = (yield a), b`) and it must nest in itself.
  for (const f of forms) out.add(`yield ${f('a', 'c')};`);
  out.add('x = yield a, b;'); out.add('yield yield a;');
  return [...out];
}
// Type arguments in expressions (TypeScript): a call or tagged template with type arguments, an
// instantiation expression, and the relational `<` / `>` readings beside them. Where both accept, the
// expression spans are compared as for the operator pairs: a wrong tree here has no ERROR either
// (`f<T>(x);` built as `(f < T) > (x)`), and a change to the `<` rendering must not trade one reading
// for another silently (`a + f<T>(x)` is not `(a + f)<T>(x)`).
const TYPE_ARGUMENTS = [
  'f<T>(x);', 'x = f<T>(x);', 'f<T, U>(x);', 'f<T>();', 'f<string>(x);', 'a.b<T>(x);', 'new C<T>(x);', 'f<T>`t`;',
  'x = f<T>;', 'a + f<T>(x);', '-f<T>(x);', 'a < b > (c);', 'a < b;', 'a < b > c;', 'a - b < c;', 'a * b < c;',
  'x = a < b, c > (d);', 'f<T>;', 'new C<T>;', 'a?.b<T>(x);', 'a?.<T>(x);', 'a.b<T>`t`;', 'f<T>(x).y<U>(z);', 'f<A<B>>(x);',
  // a prefix or binary operator before the call; a bare instantiation the interpreter refuses before
  // `+` (the relational reading); `new` with type arguments beside a relational `new C < d`.
  'await f<T>(x);', '!f<T>(x);', 'a && f<T>(x);', 'f<T> + x;', 'new Map<K, V>();', 'new C < d;', 'import<T>(x);',
];
// The same in TSX, beside JSX (`<T,>(x) => x` is a generic arrow, `<div/>` an element argument).
const TSX_TYPE_ARGUMENTS = [...TYPE_ARGUMENTS, 'x = <T,>(x: T) => x;', 'f<T>(<div/>);', 'x = <div>{f<T>(y)}</div>;'];
// An arm's optional arguments beside the call continuation on the arm without them (`new C(x)`, not
// `(new C)(x)`), spans compared as for the operator pairs.
const NEW_ARGUMENTS = [
  'new C(x);', 'new C;', 'new C()();', 'new C(x)(y);', 'new class {}();', 'x = new C(x).y;', 'new C.d(x);', 'new C`t`;',
  'new new C()();', 'new C < d;', 'yield(x);',
];
// The corpora whose trees are compared, not only their verdicts, input by input (`brackets` entries).
const SPAN_CORPORA = new Set(['operator pairs', 'type arguments', 'new arguments', 'operands']);
// The real-code corpora's trees are compared too: every file both parse without ERROR, its expression
// spans against the interpreter's (a wrong tree with no ERROR: every top-level `function f() {}` built
// as an expression statement holding a function expression was found there, by no ERROR count). Too
// many files differ for an entry each, so the record holds, per corpus, the totals and the files by
// the class of their first difference (`spans` entries); any movement fails, an improvement included.
// A class is named by the tree-sitter node of that first difference where that is cheap, else `other`.
function spanClass(cst: any, root: any): { missing: number; extra: number; cls: string | null } {
  const want = new Set(exprSpans(cst));
  const got = new Map<string, any>();
  const visit = (n: any) => { if (n.type === 'expr') got.set(`${n.startIndex}-${n.endIndex}`, n); for (const c of n.namedChildren) visit(c); };
  visit(root);
  let first: [number, string] | null = null;
  const note = (at: number, cls: string) => { if (!first || at < first[0]) first = [at, cls]; };
  let missing = 0, extra = 0;
  for (const k of want) if (!got.has(k)) { missing++; note(Number(k.split('-')[0]), 'other'); }
  for (const [k, n] of got) {
    if (want.has(k)) continue;
    extra++;
    const head = n.child(0)?.type, parent = n.parent;
    const atStatement = parent?.type === 'stmt' && parent.startIndex === n.startIndex;
    note(n.startIndex,
      atStatement && (head === 'function' || head === 'class' || head === 'async') ? 'declaration-as-expression-statement'
      : atStatement && head === '{' ? 'block-as-object-literal'
      : head === '{' && n.previousSibling?.type === '=>' ? 'arrow-body-as-object-literal'
      : 'other');
  }
  return { missing, extra, cls: first ? (first as [number, string])[1] : null };
}
const exprSpans = (n: any, out: string[] = []): string[] => {
  if (n.rule === 'Expr') out.push(`${n.offset}-${n.end}`);
  for (const c of n.children ?? []) if (c.rule) exprSpans(c, out);
  return out;
};
const tsExprSpans = (n: any, out: string[] = []): string[] => {
  if (n.type === 'expr') out.push(`${n.startIndex}-${n.endIndex}`);
  for (const c of n.namedChildren) tsExprSpans(c, out);
  return out;
};

// ── The real-code corpora: pinned checkouts CI clones (.github/workflows/ci.yml, job treesitter) ──
// Every file the interpreter accepts must parse without ERROR; the files that do not are recorded.
const TS_REPO = '/tmp/ts-repo', TS_PIN = '6fbce89821d93a5b761581d9ac540455f38e9acb';   // TS_REPO_SHA in ci.yml
const TEST262 = '/tmp/test262', TEST262_PIN = readFileSync(join(ROOT, 'test/test262.sha'), 'utf8').trim();
interface RealCorpus { name: string; root: string; pin: string; dirs: string[]; file: RegExp }
const REAL: Record<string, RealCorpus[]> = {
  typescript: [{ name: 'TypeScript src', root: TS_REPO, pin: TS_PIN, dirs: ['src'], file: /\.ts$/ }],
  javascript: [{ name: 'test262', root: TEST262, pin: TEST262_PIN, dirs: ['test/language', 'test/annexB/language'], file: /\.js$/ }],
};
const walk = (dir: string, re: RegExp, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, re, out); else if (re.test(e.name)) out.push(p);
  }
  return out;
};
// test262's fixtures (`_FIXTURE`) are module dependencies, parsed with their test.
const realFiles = (c: RealCorpus): { id: string; src: string }[] | string => {
  const head = existsSync(join(c.root, '.git/HEAD')) ? readFileSync(join(c.root, '.git/HEAD'), 'utf8').trim() : null;
  if (head !== c.pin) return `${c.root} is ${head ? `at ${head}` : 'absent'}, the pin is ${c.pin} (clone it as the treesitter job of ci.yml does)`;
  const missing = c.dirs.filter(d => !existsSync(join(c.root, d)));
  if (missing.length) return `${c.root} lacks ${missing.join(', ')} (its sparse checkout)`;
  return c.dirs.flatMap(d => walk(join(c.root, d), c.file)).map(p => ({ id: relative(c.root, p), src: readFileSync(p, 'utf8') }));
};

const { Parser, Language } = await import('web-tree-sitter');
await Parser.init();

// web-tree-sitter (0.26.9) copies a string input into a 10 KiB buffer of UTF-16 units per read
// (stringToUTF16 in _tree_sitter_parse_callback: 5119 units and a terminator), so a surrogate pair
// across that boundary reaches the lexer as two lone surrogates and a valid astral identifier is an
// ERROR (test262's start-unicode-*.js: U+D87B at offset 5114). Native tree-sitter reads UTF-8 and has
// no such boundary: the input is handed over in chunks that end before a high surrogate.
const CHUNK = 4096;
const tsParse = (parser: any, src: string) => parser.parse((i: number) => {
  let e = Math.min(src.length, i + CHUNK);
  if (e < src.length && (src.charCodeAt(e - 1) & 0xfc00) === 0xd800) e--;
  return src.slice(i, e);
});

function errorNodes(root: any): number {
  let n = 0; const stack = [root];
  while (stack.length) { const x = stack.pop(); if (x.type === 'ERROR' || x.isMissing) n++; stack.push(...x.children); }
  return n;
}

// ── The record: every disagreement, `grammar | corpus | direction | class | input`. ──
// direction `rejects`: tree-sitter ERROR where the interpreter accepts (a defect to fix); `accepts`:
// tree-sitter accepts what the interpreter rejects (an over-acceptance, synthetic corpora only: real code
// is the files the interpreter accepts); `splits`: both accept a line-break input, but its top-level
// statements start elsewhere; `spans`: a real-code corpus's expression-span totals and its differing
// files by class (see spanClass); `brackets`: both accept an operator pair, but tree-sitter's expression
// spans are not the interpreter's (a wrong tree without an ERROR). A class is the first cause (by delta debugging the input, see
// docs/HIGHLIGHTER-EVIDENCE.md, "tree-sitter"), kept across re-records; a new entry is `unclassified`.
const RECORD = join(ROOT, 'test/treesitter-record.txt');
const WRITE = process.argv.includes('--write');
const key = (g: string, corpus: string, dir: string, input: string) => `${g} | ${corpus} | ${dir} | ${input}`;
const recorded = new Map<string, string>();   // key → class
if (existsSync(RECORD)) for (const line of readFileSync(RECORD, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const [g, corpus, dir, cls, ...rest] = line.split(' | ');
  recorded.set(key(g, corpus, dir, rest.join(' | ')), cls);
}

interface Row { grammar: string; corpus: string; inputs: number; bothAccept: number; bothReject: number; tsOnlyReject: number; tsOnlyAccept: number; splitDiffers: number; ms: number }
const rows: Row[] = [];
const found = new Map<string, string>();   // key → class (the record's, or unclassified)
let notRun = false;

for (const { lang, mod, corpora, pairs } of [
  { lang: 'typescriptreact', mod: '../typescriptreact.ts', corpora: {
    'curated JSX': JSX_CASES, 'TSX issue cases': tsxIssueCases.map(c => c.src),
    'TS issue cases': issueInputs, 'JSX text': JSX_TEXT, 'reserved words': RESERVED_WORDS, 'line breaks': LINE_BREAKS, lookaheads: LOOKAHEADS, comments: COMMENTS, operands: OPERANDS, 'type arguments': TSX_TYPE_ARGUMENTS, 'new arguments': NEW_ARGUMENTS } },
  { lang: 'javascriptreact', mod: '../javascriptreact.ts', corpora: { 'curated JSX': JSX_CASES, 'JSX text': JSX_TEXT, 'reserved words': RESERVED_WORDS, 'line breaks': LINE_BREAKS, lookaheads: LOOKAHEADS, comments: COMMENTS, 'new arguments': NEW_ARGUMENTS } },
  { lang: 'typescript', mod: '../typescript.ts', corpora: { 'TS issue cases': issueInputs, 'reserved words': RESERVED_WORDS, 'line breaks': LINE_BREAKS, lookaheads: LOOKAHEADS, comments: COMMENTS, operands: OPERANDS, 'type arguments': TYPE_ARGUMENTS, 'new arguments': NEW_ARGUMENTS }, pairs: true },
  { lang: 'javascript', mod: '../javascript.ts', corpora: { 'reserved words': RESERVED_WORDS, 'line breaks': LINE_BREAKS, lookaheads: LOOKAHEADS, comments: COMMENTS, 'new arguments': NEW_ARGUMENTS }, pairs: true },
] as { lang: string; mod: string; corpora: Record<string, string[]>; pairs?: boolean }[]) {
  const wasm = `tree-sitter/${lang}/tree-sitter-${lang}.wasm`;
  if (!existsSync(wasm)) { console.error(`✗ ${wasm} not found (build it: cd tree-sitter/${lang} && npx tree-sitter build --wasm .)`); notRun = true; continue; }
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  const grammar = (await import(mod)).default;
  const interp = createParser(grammar);
  const parse = (src: string) => { try { return interp.parse(src) as { children: { offset: number }[] }; } catch { return null; } };
  const words = wordLiterals(grammar);
  const contextual = words.flatMap(w => CONTEXTUAL_POSITIONS.map(p => p(w))).filter(s => parse(s) !== null);
  // [corpus, inputs as { id, src }, real code?]
  const all: [string, { id: string; src: string }[], boolean][] = [
    ...Object.entries({ ...corpora, 'contextual keywords': contextual, ...(pairs ? { 'operator pairs': operatorPairs(grammar) } : {}) }).map(([c, xs]): [string, { id: string; src: string }[], boolean] => [c, xs.map(s => ({ id: JSON.stringify(s), src: s })), false]),
  ];
  for (const c of REAL[lang] ?? []) {
    const files = realFiles(c);
    if (typeof files === 'string') { console.error(`✗ NOT RUN: ${lang} [${c.name}]: ${files}`); notRun = true; continue; }
    all.push([c.name, files, true]);
  }
  // Where both accept a line-break input: the top-level statements start at the same offsets (a line
  // break ends a statement where the interpreter ends it, `a\n++b` is two statements in both).
  const tsStarts = (root: any) => root.namedChildren.filter((c: any) => !c.isExtra).map((c: any) => c.startIndex).join(',');
  for (const [corpus, inputs, real] of all) {
    const t0 = performance.now();
    const r: Row = { grammar: lang, corpus, inputs: inputs.length, bothAccept: 0, bothReject: 0, tsOnlyReject: 0, tsOnlyAccept: 0, splitDiffers: 0, ms: 0 };
    const spans = { missing: 0, extra: 0, byClass: new Map<string, number>() };
    for (const { id, src } of inputs) {
      const cst = parse(src);
      if (real && !cst) { r.bothReject++; continue; }   // real code: only what the interpreter accepts
      const tree = tsParse(parser, src)!;
      const ts = errorNodes(tree.rootNode) === 0;
      if (cst && ts) {
        r.bothAccept++;
        if (real) {
          const d = spanClass(cst, tree.rootNode);
          spans.missing += d.missing; spans.extra += d.extra;
          if (d.cls) { r.splitDiffers++; spans.byClass.set(d.cls, (spans.byClass.get(d.cls) ?? 0) + 1); }
        }
        if (SPAN_CORPORA.has(corpus) && exprSpans(cst).sort().join(' ') !== tsExprSpans(tree.rootNode).sort().join(' ')) {
          r.splitDiffers++;
          const k = key(lang, corpus, 'brackets', id);
          found.set(k, recorded.get(k) ?? 'unclassified');
        }
        if (corpus === 'line breaks' && cst.children.map(c => c.offset).join(',') !== tsStarts(tree.rootNode)) {
          r.splitDiffers++;
          const k = key(lang, corpus, 'splits', id);
          found.set(k, recorded.get(k) ?? 'unclassified');
        }
      } else if (!cst && !ts) r.bothReject++;
      else {
        if (cst) r.tsOnlyReject++; else r.tsOnlyAccept++;
        const k = key(lang, corpus, cst ? 'rejects' : 'accepts', id);
        found.set(k, recorded.get(k) ?? 'unclassified');
      }
      tree.delete();
    }
    r.ms = performance.now() - t0;
    rows.push(r);
    if (real) {
      const spanKey = (cls: string, what: string) => { const k = key(lang, corpus, 'spans', what); found.set(k, cls); };
      spanKey('totals', `span-equal ${r.bothAccept - r.splitDiffers} of ${r.bothAccept}, interpreter spans missing ${spans.missing}, extra tree-sitter spans ${spans.extra}`);
      for (const [cls, n] of spans.byClass) spanKey(cls, `files ${n}`);
    }
  }
}

const table = [
  '| grammar | corpus | inputs | both accept | both reject | tree-sitter-only ERROR | tree-sitter-only accept | splits / brackets / spans differ | s |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ...rows.map(r => `| ${r.grammar} | ${r.corpus} | ${r.inputs} | ${r.bothAccept} | ${r.bothReject} | ${r.tsOnlyReject} | ${r.tsOnlyAccept} | ${r.splitDiffers} | ${(r.ms / 1000).toFixed(1)} |`),
].join('\n');
// The tree-sitter-only ERRORs of the real-code corpora by class.
const byClass = new Map<string, number>();
for (const [k, cls] of found) { const [g, corpus, dir] = k.split(' | '); if (dir === 'rejects' && REAL[g]?.some(c => c.name === corpus)) byClass.set(`${g} | ${corpus} | ${cls}`, (byClass.get(`${g} | ${corpus} | ${cls}`) ?? 0) + 1); }
const classTable = ['| grammar | corpus | class | files |', '|---|---|---|---:|', ...[...byClass].sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${k} | ${n} |`)].join('\n');
// The real-code corpora's expression spans: totals and the differing files by class.
const spanTable = ['| grammar | corpus | class | spans |', '|---|---|---|---|',
  ...[...found].filter(([k]) => k.split(' | ')[2] === 'spans').map(([k, cls]) => { const [g, corpus, , ...rest] = k.split(' | '); return `| ${g} | ${corpus} | ${cls} | ${rest.join(' | ')} |`; })].join('\n');
const entering = [...found.keys()].filter(k => !recorded.has(k)).sort();
const leaving = [...recorded.keys()].filter(k => !found.has(k) && !notRun).sort();
console.log(table + '\n\n' + classTable + '\n\n' + spanTable);
// A moved entry is printed as its record line (`grammar | corpus | direction | class | input`).
const asLine = (k: string, cls: string) => { const [g, corpus, dir, ...rest] = k.split(' | '); return [g, corpus, dir, cls, rest.join(' | ')].join(' | '); };
const moved = [...entering.map(k => `  + ${asLine(k, found.get(k)!)}`), ...leaving.map(k => `  - ${asLine(k, recorded.get(k)!)}`)];
if (moved.length) console.log(`\nAgainst test/treesitter-record.txt (+ new disagreement, - one that no longer holds):\n${moved.join('\n')}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### tree-sitter verdicts against the interpreter\n\n${table}\n\n${classTable}\n\n${spanTable}\n` +
    (moved.length ? `\n<details><summary>${moved.length} change(s) against the record</summary>\n\n${moved.map(d => '- `' + d.trim().replace(/`/g, "'") + '`').join('\n')}\n</details>\n` : ''));
}
if (WRITE && !notRun) {
  const lines = [...found].map(([k, cls]) => asLine(k, cls)).sort();
  writeFileSync(RECORD, `# tree-sitter against the interpreter: every disagreement (test/treesitter-verdicts.ts --write)\n# grammar | corpus | rejects (tree-sitter ERROR, interpreter accepts) or accepts (the reverse) | class | input\n${lines.join('\n')}\n`);
  console.log(`wrote ${RECORD} (${lines.length} entries)`);
} else if (moved.length) {
  console.error('✗ the verdicts moved against the record: fix it, or re-record with node test/treesitter-verdicts.ts --write and say why');
  process.exitCode = 1;
}
if (notRun) process.exit(1);
