// ─────────────────────────────────────────────────────────────────────────────
//  treesitter-jsx.ts — REPORT-ONLY verdict comparison for the DERIVED tree-sitter TSX and JSX
//  grammars, and over the TS issue cases and the reserved-word corpus the TS and JS ones
//  (CI `treesitter` job). Until now CI generated these two grammars (the conflict gate)
//  but never built or parsed with them. Over a corpus of TSX / JSX inputs it parses each with
//  the tree-sitter wasm and counts ERROR / MISSING nodes, and compares the accept verdict (no
//  such node) with the Monogram interpreter's on the same grammar — as test/yaml-treesitter.ts
//  does for YAML. Nothing here is a target yet: the numbers are the baseline later editor-lane
//  changes (tree-sitter names, fields, a `jsx_text` external) are measured against, so the
//  script exits 0 whatever they are, and fails only when a wasm cannot be loaded.
//  Build the wasms first (CI does):
//    cd tree-sitter/typescriptreact && npx tree-sitter generate && npx tree-sitter build --wasm .
//    cd tree-sitter/javascriptreact && npx tree-sitter generate && npx tree-sitter build --wasm .
//  Run: node test/treesitter-jsx.ts   (appends a table to $GITHUB_STEP_SUMMARY when set)
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createParser } from '../src/gen-parser.ts';
import { collectLiterals } from '../src/grammar-utils.ts';
import { JSX_CASES } from './curated-corpora.ts';
import { cases as tsxIssueCases } from './tsx-issue-cases.ts';
import { tests as issueTests } from './issue-cases.ts';

// JSX children with free text: valid TSX / JSX that the interpreter rejects today (no JSX-text
// lexer region; test/tsx-conformance.ts lists the same class as known-unsupported).
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
  'let x: T\nlet y', 'type A = B\ntype C = D', 'x!\n.y', 'x\n!y', 'let x: T\n[]', 'let x: A\n<B>(y)', 'interface I { a: T\n b: U }',
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
  'for (let [a] of b);', 'for ([a] of b);', 'for ({a} of b);', 'for (let in a);', 'for (let of a);', 'for (async of a);', 'try {}', 'try {} finally {}',
];

// Block comments: two comments with code between them are two comments (tree-sitter's lexer takes the
// longest token, so a comment token must not run past its first `*/`), beside the near misses a
// comment that swallowed code would accept.
const COMMENTS = [
  '/** a */\ninterface P {\n    /** b */\n}', '/* a */\nclass P {\n    /* b */\n}', '/** a */\nfunction f() {\n    /** b */\n}',
  '/** a */ x = { /** b */ };', 'x = 1 /* a */ + /* b */ 2;', '/***/ x;', '/**/ x;', '/* a **/ x; /** b ***/ y;', '/* a * / b */ x;',
  '/* a */ x */ y;', '/* a */ ) /* b */', 'x = /* a */ 1 */ 2;',
];

// A continuation whose operand is another rule that continues (`x as T` then Type's own `[ ]`, `|`,
// `&`, `<`, `?`, `.`): the operand is read whole where it continues, and the expression takes the
// token where the operand's continuation fails (`a as T < b`, `x as T ? a : b`).
const OPERANDS = [
  'x as T[];', 'x satisfies T[];', 'x as A | B;', 'x as A & B;', '<T[]>x;', 'x as T[] | U;', 'x as const;', 'a as T < b;',
  'x as T ? a : b;', 'x as T[0];', 'x as T<U>[];', 'a as any as T[];', 'f(x as T[], y);', 'x as T | U[];', 'x as T\n[0];',
  'y = x as T extends U ? A : B;', 'x as T < b > c;',
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
// which no verdict comparison sees. The pairs that still bracket differently are pinned in
// test/treesitter-brackets-record.txt (the run fails when that list moves; `--write` re-records).
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
  return [...out];
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
const BRACKETS_RECORD = 'test/treesitter-brackets-record.txt';
const bracketsDiffer: string[] = [];

const { Parser, Language } = await import('web-tree-sitter');
await Parser.init();

function errorNodes(root: any): number {
  let n = 0; const stack = [root];
  while (stack.length) { const x = stack.pop(); if (x.type === 'ERROR' || x.isMissing) n++; stack.push(...x.children); }
  return n;
}

interface Row { grammar: string; corpus: string; inputs: number; bothAccept: number; bothReject: number; tsOnlyReject: number; tsOnlyAccept: number; errorNodes: number; splitDiffers: number }
const rows: Row[] = [];
const disagreements: string[] = [];
let loadFailed = false;

for (const { lang, mod, corpora, pairs } of [
  { lang: 'typescriptreact', mod: '../typescriptreact.ts', corpora: {
    'curated JSX': JSX_CASES, 'TSX issue cases': tsxIssueCases.map(c => c.src),
    'TS issue cases': issueTests.map(t => t.input), 'JSX text': JSX_TEXT, 'reserved words': RESERVED_WORDS, 'line breaks': LINE_BREAKS, lookaheads: LOOKAHEADS, comments: COMMENTS, operands: OPERANDS } },
  { lang: 'javascriptreact', mod: '../javascriptreact.ts', corpora: { 'curated JSX': JSX_CASES, 'JSX text': JSX_TEXT, 'reserved words': RESERVED_WORDS, 'line breaks': LINE_BREAKS, lookaheads: LOOKAHEADS, comments: COMMENTS } },
  { lang: 'typescript', mod: '../typescript.ts', corpora: { 'TS issue cases': issueTests.map(t => t.input), 'reserved words': RESERVED_WORDS, 'line breaks': LINE_BREAKS, lookaheads: LOOKAHEADS, comments: COMMENTS, operands: OPERANDS }, pairs: true },
  { lang: 'javascript', mod: '../javascript.ts', corpora: { 'reserved words': RESERVED_WORDS, 'line breaks': LINE_BREAKS, lookaheads: LOOKAHEADS, comments: COMMENTS }, pairs: true },
]) {
  const wasm = `tree-sitter/${lang}/tree-sitter-${lang}.wasm`;
  if (!existsSync(wasm)) { console.error(`✗ ${wasm} not found (build it: cd tree-sitter/${lang} && npx tree-sitter build --wasm .)`); loadFailed = true; continue; }
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  const grammar = (await import(mod)).default;
  const interp = createParser(grammar);
  const accepts = (src: string) => { try { interp.parse(src); return true; } catch { return false; } };
  const words = wordLiterals(grammar);
  const contextual = words.flatMap(w => CONTEXTUAL_POSITIONS.map(p => p(w))).filter(accepts);
  console.log(`${lang}: ${words.length} word-shaped literals, ${contextual.length} accepted name uses`);
  // Where both accept: the top-level statements start at the same offsets (a line break ends a
  // statement where the interpreter ends it, `a\n++b` is two statements in both).
  const starts = (src: string) => (interp.parse(src) as { children: { offset: number }[] }).children.map(c => c.offset).join(',');
  const tsStarts = (root: any) => root.namedChildren.filter((c: any) => !c.isExtra).map((c: any) => c.startIndex).join(',');
  for (const [corpus, inputs] of Object.entries({ ...corpora, 'contextual keywords': contextual, ...(pairs ? { 'operator pairs': operatorPairs(grammar) } : {}) })) {
    const r: Row = { grammar: lang, corpus, inputs: inputs.length, bothAccept: 0, bothReject: 0, tsOnlyReject: 0, tsOnlyAccept: 0, errorNodes: 0, splitDiffers: 0 };
    for (const src of inputs) {
      const root = parser.parse(src)!.rootNode;
      const errs = errorNodes(root);
      r.errorNodes += errs;
      const mono = accepts(src), ts = errs === 0;
      if (mono && ts) {
        r.bothAccept++;
        if (corpus === 'operator pairs') {
          const a = exprSpans(interp.parse(src)).sort().join(' '), b = tsExprSpans(root).sort().join(' ');
          if (a !== b) { r.splitDiffers++; bracketsDiffer.push(`${lang}\t${JSON.stringify(src)}`); }
        }
        if (corpus === 'line breaks' && starts(src) !== tsStarts(root)) { r.splitDiffers++; disagreements.push(`${lang} [${corpus}] statements start at ${tsStarts(root)} in tree-sitter, ${starts(src)} in the interpreter: ${JSON.stringify(src).slice(0, 120)}`); }
      }
      else if (!mono && !ts) r.bothReject++;
      else {
        if (mono) r.tsOnlyReject++; else r.tsOnlyAccept++;
        disagreements.push(`${lang} [${corpus}] ${mono ? 'tree-sitter ERROR, interpreter accepts' : 'tree-sitter accepts, interpreter rejects'}: ${JSON.stringify(src).slice(0, 120)}`);
      }
    }
    rows.push(r);
  }
}

const table = [
  '| grammar | corpus | inputs | both accept | both reject | tree-sitter-only ERROR | tree-sitter-only accept | ERROR/MISSING nodes | split / brackets differ |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ...rows.map(r => `| ${r.grammar} | ${r.corpus} | ${r.inputs} | ${r.bothAccept} | ${r.bothReject} | ${r.tsOnlyReject} | ${r.tsOnlyAccept} | ${r.errorNodes} | ${r.splitDiffers} |`),
].join('\n');
console.log(table);
if (disagreements.length) console.log('\nDisagreements:\n' + disagreements.map(d => '  ' + d).join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### tree-sitter verdicts against the interpreter (report-only)\n\n${table}\n` +
    (disagreements.length ? `\n<details><summary>${disagreements.length} disagreement(s)</summary>\n\n${disagreements.map(d => '- `' + d.replace(/`/g, "'") + '`').join('\n')}\n</details>\n` : ''));
}
// The pinned operator pairs that still bracket differently (the over-acceptances and the classes the
// generator does not yet render are in docs/TREE-SITTER.md): any movement fails, in either direction.
if (!loadFailed) {
  const now = bracketsDiffer.sort().join('\n') + '\n';
  if (process.argv.includes('--write')) writeFileSync(BRACKETS_RECORD, now);
  else {
    const was = existsSync(BRACKETS_RECORD) ? readFileSync(BRACKETS_RECORD, 'utf8') : '';
    if (was !== now) {
      const a = new Set(was.split('\n').filter(Boolean)), b = new Set(now.split('\n').filter(Boolean));
      console.error(`✗ operator pairs bracketing differently moved from ${BRACKETS_RECORD} (re-record with --write if intended):`);
      for (const x of b) if (!a.has(x)) console.error(`  + ${x}`);
      for (const x of a) if (!b.has(x)) console.error(`  - ${x}`);
      process.exit(1);
    }
    console.log(`✓ operator pairs: ${bracketsDiffer.length} bracket differently, as recorded in ${BRACKETS_RECORD}`);
  }
}
if (loadFailed) process.exit(1);
