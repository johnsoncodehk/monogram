// scope-gap-js.ts — JavaScript (.js) adapter for the unified scope-gap harness. Grades VS Code's
// OFFICIAL JavaScript.tmLanguage.json AND Monogram's javascript.tmLanguage.json against the parser
// oracle (oracle.ts with ScriptKind.JS). Both grammars declare scopeName `source.js`, so they load
// + compare on one scale. Corpus = Test262 (tc39/test262), the canonical ECMAScript corpus — the TS
// suite has ~no .js. Provision once:  git clone --depth 1 https://github.com/tc39/test262 /tmp/test262
// Run (bare node): node test/scope-gap-js.ts [N|all]   (Test262 is huge; default sample 800)
import ts from 'typescript';
import { run } from './scope-gap.ts';
import { oracle } from './oracle.ts';
import { walkCorpus, subsetArg } from './src-coverage-tsfamily.ts';

const BASE = '/tmp/test262/test/language'; // the syntax-relevant subtree of Test262
const OFFICIAL = process.env.MONOGRAM_OFFICIAL_TM
  ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/javascript/syntaxes/JavaScript.tmLanguage.json';

// walkCorpus already drops .d.ts + multi-file (@filename) fixtures and stride-samples.
const corpus = walkCorpus([BASE], ['.js'], subsetArg(800)).filter((c) => !c.file.endsWith('_FIXTURE.js'));

await run({
  name: 'JavaScript (.js)',
  scopeName: 'source.js',
  officialPath: OFFICIAL,
  monogramPath: 'javascript.tmLanguage.json',
  loadCorpus: () => corpus.map((c) => ({ name: c.file, text: c.code })),
  roleOracle: (text) => oracle(text, ts.ScriptKind.JS),
  isGradable: (text) => {
    const sf = ts.createSourceFile('c.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    return (((sf as any).parseDiagnostics?.length ?? 0) === 0);
  },
});
