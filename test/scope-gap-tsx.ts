// scope-gap-tsx.ts — TSX (.tsx) adapter for the unified scope-gap harness. Grades VS Code's
// OFFICIAL TypeScriptReact.tmLanguage.json AND Monogram's typescriptreact.tmLanguage.json against
// the parser oracle (oracle.ts with ScriptKind.TSX). Both grammars declare scopeName `source.tsx`.
// Corpus = the TypeScript repo's single-file .tsx tests (conformance/jsx + compiler).
// Run (bare node): node test/scope-gap-tsx.ts [N|all]   (default: all — the .tsx set is small)
import ts from 'typescript';
import { run } from './scope-gap.ts';
import { oracle } from './oracle.ts';
import { walkCorpus, subsetArg } from './src-coverage-tsfamily.ts';

const BASE = '/tmp/ts-repo/tests/cases';
const OFFICIAL = process.env.MONOGRAM_OFFICIAL_TM
  ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/typescript-basics/syntaxes/TypeScriptReact.tmLanguage.json';

const corpus = walkCorpus([`${BASE}/conformance`, `${BASE}/compiler`], ['.tsx'], subsetArg(Infinity));

await run({
  name: 'TypeScriptReact (.tsx)',
  scopeName: 'source.tsx',
  officialPath: OFFICIAL,
  monogramPath: 'typescriptreact.tmLanguage.json',
  loadCorpus: () => corpus.map((c) => ({ name: c.file, text: c.code })),
  roleOracle: (text) => oracle(text, ts.ScriptKind.TSX),
  isGradable: (text) => {
    const sf = ts.createSourceFile('c.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    return (((sf as any).parseDiagnostics?.length ?? 0) === 0);
  },
});
