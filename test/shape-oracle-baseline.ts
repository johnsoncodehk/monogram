// REPORT-ONLY baselines of what monogram produces today, through the oracle harness
// (test/shape-oracle.ts). Not a gate: it measures, it does not judge.
//
//   node test/shape-oracle-baseline.ts tsc [conformance] [lib] [realjs] [<file>...] [--out r.json]
//     the hand-written lowering (test/ts-ast-lowering.ts) against the tsc oracle, in the
//     STRUCTURE view (the lowering names no fields): kind, start, end, child order.
//   node test/shape-oracle-baseline.ts estree [realjs] [<file>...] [--out r.json]
//     the "ESTree-ish" TypeScript ShapeSpec fixture (test/fixtures/shape-typescript.ts, its
//     customs included), emitted as the TS target's parseAst, against the acorn oracle.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { conformanceFiles, formatReport, fromShapeAst, readCorpus, runCorpus, type CorpusReport, type Producer } from './shape-oracle.ts';

export const REALJS_LIST = '/home/linuxuser/.cache/monogram-agents/scratch/fix-grammar-queue-2/realjs-files.txt';
export const libFiles = (): string[] => {
  const dir = new URL('../node_modules/tsc-oracle/lib/', import.meta.url).pathname;
  return readdirSync(dir).filter((f) => /^lib\..*\.d\.ts$/.test(f)).sort().map((f) => dir + f);
};
export const realJsFiles = (): string[] => readFileSync(REALJS_LIST, 'utf-8').split('\n').filter(Boolean);
const corpusPaths = (c: string): string[] =>
  c === 'conformance' ? conformanceFiles() : c === 'lib' ? libFiles() : c === 'realjs' ? realJsFiles() : [c];

/** The ShapeSpec fixture's parseAst as a candidate (emits the TS target once). */
export async function fixtureCandidate(): Promise<Producer> {
  const { emitTs } = await import('../src/target-ts.ts');
  const { scratchDir } = await import('./scratch.ts');
  const { typescriptShape, typescriptEstreeCustoms } = await import('./fixtures/shape-typescript.ts');
  const grammar = (await import('../typescript.ts')).default;
  const file = `${scratchDir('shape-oracle-baseline')}/typescript-shape.ts`;
  writeFileSync(file, emitTs(grammar, { shape: typescriptShape }));
  const mod = await import(pathToFileURL(file).href) as { parseAst: (s: string, o: { customs: unknown }) => unknown };
  return (src) => {
    const ast = mod.parseAst(src, { customs: typescriptEstreeCustoms });
    return ast === null ? { fail: 'parseAst rejects' } : { tree: fromShapeAst(ast) };
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
  const mode = args.shift();
  const reports: CorpusReport[] = [];
  if (mode === 'tsc') {
    const { loweringCandidate, tscStructureOracle } = await import('./ts-ast-verify.ts');
    for (const c of args.length ? args : ['conformance', 'lib', 'realjs']) {
      const r = runCorpus(c, readCorpus(corpusPaths(c)), tscStructureOracle, loweringCandidate);
      console.log(formatReport(r));
      reports.push(r);
    }
  } else if (mode === 'estree') {
    const { estreeOracle } = await import('./shape-oracle-estree.ts');
    const candidate = await fixtureCandidate();
    // acorn's Program spans the whole file (leading / trailing trivia included), a token-span
    // tree its first to last token: a real divergence, but one that skips the whole tree. The
    // second run excuses the root's span only, so the statements below it are compared.
    const rootFree = (p: Producer): Producer => (src, path) => {
      const r = p(src, path);
      return 'tree' in r ? { tree: { ...r.tree, start: 0, end: 0 } } : r;
    };
    for (const c of args.length ? args : ['realjs']) {
      const files = readCorpus(corpusPaths(c));
      for (const [name, o, k] of [[c, estreeOracle, candidate], [`${c} (root span excused)`, rootFree(estreeOracle), rootFree(candidate)]] as const) {
        const r = runCorpus(name, files, o, k);
        console.log(formatReport(r, { top: 25 }));
        reports.push(r);
      }
    }
  } else {
    console.error('usage: node test/shape-oracle-baseline.ts tsc|estree [corpus|file...] [--out r.json]');
    process.exit(2);
  }
  if (out) writeFileSync(out, JSON.stringify(reports, null, 1));
}
