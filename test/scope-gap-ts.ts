// scope-gap-ts.ts — TypeScript adapter for the unified scope-gap harness. Demonstrates the
// harness reproduces highlight-bench's official-vs-Monogram gap from a parser-role oracle
// (oracle.ts = tsc → roles). Run (bare node): node test/scope-gap-ts.ts [N|all]
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './scope-gap.ts';
import { oracle } from './oracle.ts';

const PARSER_DIR = '/tmp/ts-repo/tests/cases/conformance/parser';
const OFFICIAL = process.env.MONOGRAM_OFFICIAL_TM
  ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json';

function walk(d: string): string[] {
  let o: string[] = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.isDirectory()) o = o.concat(walk(f));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) o.push(f);
  }
  return o;
}
const arg = process.argv[2];
const N = arg === 'all' ? Infinity : Number(arg ?? 400);
const all = walk(PARSER_DIR).sort();
const pick = !isFinite(N) || N >= all.length ? all : Array.from({ length: N }, (_, i) => all[Math.floor(i * all.length / N)]);

await run({
  name: 'TypeScript',
  scopeName: 'source.ts',
  officialPath: OFFICIAL,
  monogramPath: 'typescript.tmLanguage.json',
  loadCorpus: () => pick.map((f) => ({ name: f, text: readFileSync(f, 'utf8') })).filter((x) => !/^\s*\/\/\s*@filename:/im.test(x.text)),
  roleOracle: (text) => oracle(text, ts.ScriptKind.TS),
  isGradable: (text) => {
    const sf = ts.createSourceFile('c.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return (((sf as any).parseDiagnostics?.length ?? 0) === 0);
  },
});
