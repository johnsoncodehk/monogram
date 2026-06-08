// ─────────────────────────────────────────────────────────────────────────────
//  src-coverage-run.ts — the UNIFIED, data-driven entry for the source-coverage parser-alignment
//  metric (monogram#25 part 2B). One driver + a per-language config TABLE, replacing the four thin
//  src-coverage-{ts,js,jsx,tsx} adapters: each was just a corpus + ScriptKind + grammar over the
//  SHARED `tsFamilyAdapter` (the accept/reject oracle) and `run()` core (src-coverage.ts).
//
//  Run (bare node):  node test/src-coverage-run.ts <lang> [N|all]
//                    lang ∈ ts | js | jsx | tsx | html | yaml
//
//  The thicker html / yaml adapters use a DIFFERENT oracle (html = parse5 STRUCTURAL tree-equality,
//  yaml = the `yaml` package accept/reject) and their own corpus, so they keep their files;
//  `<lang> html|yaml` DELEGATES to them. The per-language entry stays a `<lang>` parameter throughout.
// ─────────────────────────────────────────────────────────────────────────────
import ts from 'typescript';
import { run } from './src-coverage.ts';
import { tsFamilyAdapter, walkCorpus, type TsFamilyCase } from './src-coverage-tsfamily.ts';
import { JSX_CASES } from './curated-corpora.ts';

const subN = (def = 400): number => { const a = process.argv[3]; return a === 'all' ? Infinity : Number(a ?? process.env.SUBSET ?? def); };

const lang = process.argv[2];

// html / yaml use a different oracle + corpus → their own files; delegate (preserves the `<lang>` entry).
if (lang === 'html') { await import('./src-coverage-html.ts'); }
else if (lang === 'yaml') { await import('./src-coverage-yaml.ts'); }
else {
  // ── TS-family config table: ts/js/jsx/tsx differ only by ScriptKind + grammar + corpus ──
  const TS_BASE = '/tmp/ts-repo/tests/cases';
  const BUILDERS: Record<string, () => Promise<{ opts: Parameters<typeof tsFamilyAdapter>[0]; note: string }>> = {
    ts: async () => {
      const corpus = walkCorpus([`${TS_BASE}/conformance`], ['.ts'], subN(400));
      return { opts: { name: 'TypeScript (.ts)', scriptKind: ts.ScriptKind.TS, grammar: (await import('../typescript.ts')).default, corpus, originBase: `${TS_BASE}/conformance` }, note: `${corpus.length} single-file .ts cases (tests/cases/conformance).` };
    },
    js: async () => {
      const corpus = walkCorpus(['/tmp/test262/test/language'], ['.js'], subN(800)).filter((c) => !c.file.endsWith('_FIXTURE.js'));
      return { opts: { name: 'JavaScript (.js)', scriptKind: ts.ScriptKind.JS, grammar: (await import('../javascript.ts')).default, corpus, originBase: '/tmp/test262' }, note: `${corpus.length} Test262 .js cases (test/language, stride-sampled).` };
    },
    jsx: async () => {
      const corpus: TsFamilyCase[] = JSX_CASES.map((code, i) => ({ file: `<curated #${i}>`, code }));
      return { opts: { name: 'JavaScriptReact (.jsx)', scriptKind: ts.ScriptKind.JSX, grammar: (await import('../javascriptreact.ts')).default, corpus }, note: `${corpus.length} curated .jsx cases.` };
    },
    tsx: async () => {
      const corpus = walkCorpus([`${TS_BASE}/conformance`, `${TS_BASE}/compiler`], ['.tsx'], subN(Infinity));
      return { opts: { name: 'TypeScriptReact (.tsx)', scriptKind: ts.ScriptKind.TSX, grammar: (await import('../typescriptreact.ts')).default, corpus, originBase: TS_BASE }, note: `${corpus.length} single-file .tsx cases (conformance + compiler).` };
    },
  };
  const build = BUILDERS[lang];
  if (!build) { console.error(`usage: node test/src-coverage-run.ts <ts|js|jsx|tsx|html|yaml> [N|all]\nunknown language: ${lang ?? '(none)'}`); process.exit(1); }
  const { opts, note } = await build();
  console.log(`${opts.name} corpus: ${note}`);
  await run(tsFamilyAdapter(opts));
}
