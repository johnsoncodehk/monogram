// ─────────────────────────────────────────────────────────────────────────────
//  treesitter-jsx.ts — REPORT-ONLY verdict comparison for the DERIVED tree-sitter TSX and JSX
//  grammars (CI `treesitter` job). Until now CI generated these two grammars (the conflict gate)
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
    'TS issue cases': issueTests.map(t => t.input), 'JSX text': JSX_TEXT } },
  { lang: 'javascriptreact', mod: '../javascriptreact.ts', corpora: { 'curated JSX': JSX_CASES, 'JSX text': JSX_TEXT } },
]) {
  const wasm = `tree-sitter/${lang}/tree-sitter-${lang}.wasm`;
  if (!existsSync(wasm)) { console.error(`✗ ${wasm} not found (build it: cd tree-sitter/${lang} && npx tree-sitter build --wasm .)`); loadFailed = true; continue; }
  const parser = new Parser();
  parser.setLanguage(await Language.load(wasm));
  const interp = createParser((await import(mod)).default);
  const accepts = (src: string) => { try { interp.parse(src); return true; } catch { return false; } };
  for (const [corpus, inputs] of Object.entries(corpora)) {
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
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### tree-sitter TSX / JSX verdicts against the interpreter (report-only)\n\n${table}\n` +
    (disagreements.length ? `\n<details><summary>${disagreements.length} disagreement(s)</summary>\n\n${disagreements.map(d => '- `' + d.replace(/`/g, "'") + '`').join('\n')}\n</details>\n` : ''));
}
if (loadFailed) process.exit(1);
