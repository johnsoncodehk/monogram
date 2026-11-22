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
import { appendFileSync, existsSync } from 'node:fs';
import { createParser } from '../src/gen-parser.ts';
import { generateTreeSitter } from '../src/gen-treesitter.ts';
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

// Contextual keywords: every keyword the generated grammar reads both ways (generateTreeSitter's
// `contextualKeywords`, derived from the grammar), as an identifier in each position class: one
// class per word-token step of the JavaScript and TypeScript grammars (the steps a keyword set is
// planned for, planContextualWords). Only the inputs the interpreter accepts are kept, so the target
// is that every one parses.
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

const { Parser, Language } = await import('web-tree-sitter');
await Parser.init();

function errorNodes(root: any): number {
  let n = 0; const stack = [root];
  while (stack.length) { const x = stack.pop(); if (x.type === 'ERROR' || x.isMissing) n++; stack.push(...x.children); }
  return n;
}

interface Row { grammar: string; corpus: string; inputs: number; bothAccept: number; bothReject: number; tsOnlyReject: number; tsOnlyAccept: number; errorNodes: number }
const rows: Row[] = [];
const disagreements: string[] = [];
let loadFailed = false;

for (const { lang, mod, corpora } of [
  { lang: 'typescriptreact', mod: '../typescriptreact.ts', corpora: {
    'curated JSX': JSX_CASES, 'TSX issue cases': tsxIssueCases.map(c => c.src),
    'TS issue cases': issueTests.map(t => t.input), 'JSX text': JSX_TEXT, 'reserved words': RESERVED_WORDS } },
  { lang: 'javascriptreact', mod: '../javascriptreact.ts', corpora: { 'curated JSX': JSX_CASES, 'JSX text': JSX_TEXT, 'reserved words': RESERVED_WORDS } },
  { lang: 'typescript', mod: '../typescript.ts', corpora: { 'TS issue cases': issueTests.map(t => t.input), 'reserved words': RESERVED_WORDS } },
  { lang: 'javascript', mod: '../javascript.ts', corpora: { 'reserved words': RESERVED_WORDS } },
]) {
  const wasm = `tree-sitter/${lang}/tree-sitter-${lang}.wasm`;
  if (!existsSync(wasm)) { console.error(`✗ ${wasm} not found (build it: cd tree-sitter/${lang} && npx tree-sitter build --wasm .)`); loadFailed = true; continue; }
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  const grammar = (await import(mod)).default;
  const interp = createParser(grammar);
  const accepts = (src: string) => { try { interp.parse(src); return true; } catch { return false; } };
  const words = generateTreeSitter(grammar, lang).contextualKeywords ?? [];
  const contextual = words.flatMap(w => CONTEXTUAL_POSITIONS.map(p => p(w))).filter(accepts);
  console.log(`${lang}: ${words.length} contextual keywords, ${contextual.length} accepted identifier uses`);
  for (const [corpus, inputs] of Object.entries({ ...corpora, 'contextual keywords': contextual })) {
    const r: Row = { grammar: lang, corpus, inputs: inputs.length, bothAccept: 0, bothReject: 0, tsOnlyReject: 0, tsOnlyAccept: 0, errorNodes: 0 };
    for (const src of inputs) {
      const errs = errorNodes(parser.parse(src)!.rootNode);
      r.errorNodes += errs;
      const mono = accepts(src), ts = errs === 0;
      if (mono && ts) r.bothAccept++;
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
  '| grammar | corpus | inputs | both accept | both reject | tree-sitter-only ERROR | tree-sitter-only accept | ERROR/MISSING nodes |',
  '|---|---|---:|---:|---:|---:|---:|---:|',
  ...rows.map(r => `| ${r.grammar} | ${r.corpus} | ${r.inputs} | ${r.bothAccept} | ${r.bothReject} | ${r.tsOnlyReject} | ${r.tsOnlyAccept} | ${r.errorNodes} |`),
].join('\n');
console.log(table);
if (disagreements.length) console.log('\nDisagreements:\n' + disagreements.map(d => '  ' + d).join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### tree-sitter verdicts against the interpreter (report-only)\n\n${table}\n` +
    (disagreements.length ? `\n<details><summary>${disagreements.length} disagreement(s)</summary>\n\n${disagreements.map(d => '- `' + d.replace(/`/g, "'") + '`').join('\n')}\n</details>\n` : ''));
}
if (loadFailed) process.exit(1);
