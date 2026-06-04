// src-coverage-tsx.ts — TSX (.tsx, VS Code "typescriptreact") entrypoint.
// Same official parser as TS (typescript.js) but ScriptKind.TSX + the typescriptreact grammar.
// Corpus = the TypeScript repo's .tsx tests (conformance/jsx + compiler), single-file.
// Run (bare node): node test/src-coverage-tsx.ts [N|all]   (default: all — the .tsx set is small)

import ts from 'typescript';
import { run } from './src-coverage.ts';
import { tsFamilyAdapter, walkCorpus, subsetArg } from './src-coverage-tsfamily.ts';

const BASE = '/tmp/ts-repo/tests/cases';
const corpus = walkCorpus([`${BASE}/conformance`, `${BASE}/compiler`], ['.tsx'], subsetArg(Infinity));
console.log(`TSX corpus: ${corpus.length} single-file .tsx cases (conformance + compiler).`);

await run(tsFamilyAdapter({
  name: 'TypeScriptReact (.tsx)',
  scriptKind: ts.ScriptKind.TSX,
  grammar: (await import('../typescriptreact.ts')).default,
  corpus,
  originBase: BASE,
}));
