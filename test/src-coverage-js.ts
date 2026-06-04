// src-coverage-js.ts — JavaScript (.js, VS Code "javascript") entrypoint.
// Official parser = typescript.js with ScriptKind.JS (this IS VS Code's built-in JS support);
// Monogram grammar = javascript.ts. The TS test suite has ~no .js corpus, so we use Test262
// (tc39/test262) — the canonical ECMAScript corpus, including negative parse tests (great
// reject cases). Provision once:
//   git clone --depth 1 https://github.com/tc39/test262 /tmp/test262
// Run (bare node): node test/src-coverage-js.ts [N|all]   (Test262 is huge; default sample 800)
//
// Note: VS Code's `javascript` (ScriptKind.JS) ALLOWS JSX, but Monogram's javascript.ts models
// no JSX (that lives in javascriptreact.ts). Test262 is pure ECMAScript with no JSX, so this
// definitional gap doesn't trigger here — the comparison stays clean.

import ts from 'typescript';
import { run } from './src-coverage.ts';
import { tsFamilyAdapter, walkCorpus, subsetArg } from './src-coverage-tsfamily.ts';

const BASE = '/tmp/test262/test/language'; // the syntax-relevant subtree of Test262
const corpus = walkCorpus([BASE], ['.js'], subsetArg(800)).filter((c) => !c.file.endsWith('_FIXTURE.js'));
console.log(`JavaScript corpus: ${corpus.length} Test262 .js cases (test/language, stride-sampled).`);

await run(tsFamilyAdapter({
  name: 'JavaScript (.js)',
  scriptKind: ts.ScriptKind.JS,
  grammar: (await import('../javascript.ts')).default,
  corpus,
  originBase: '/tmp/test262',
}));
