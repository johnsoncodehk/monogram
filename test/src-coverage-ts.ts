// src-coverage-ts.ts — TypeScript (.ts) entrypoint for the source-coverage alignment metric.
// Thin: corpus + dialect knobs only; the TS-family adapter is in ./src-coverage-tsfamily.ts
// and the coverage harness in ./src-coverage.ts.
//
// Oracle/corpus/Monogram-invocation mirror the accept/reject oracle: ts.createSourceFile (TS),
// accept iff no parseDiagnostics; /tmp/ts-repo/tests/cases/conformance, single-file .ts.
//
// Run (Node 24+, bare node — NOT tsx):
//   node test/src-coverage-ts.ts            # default subset (env SUBSET, default 400)
//   node test/src-coverage-ts.ts 1000       # subset size as arg
//   node test/src-coverage-ts.ts all        # full single-file corpus

import ts from 'typescript';
import { run } from './src-coverage.ts';
import { tsFamilyAdapter, walkCorpus, subsetArg } from './src-coverage-tsfamily.ts';

const BASE = '/tmp/ts-repo/tests/cases';
const corpus = walkCorpus([`${BASE}/conformance`], ['.ts'], subsetArg());
console.log(`TypeScript corpus: ${corpus.length} single-file .ts cases (tests/cases/conformance).`);

await run(tsFamilyAdapter({
  name: 'TypeScript (.ts)',
  scriptKind: ts.ScriptKind.TS,
  grammar: (await import('../typescript.ts')).default,
  corpus,
  originBase: `${BASE}/conformance`,
}));
