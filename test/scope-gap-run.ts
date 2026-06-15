// ─────────────────────────────────────────────────────────────────────────────
//  scope-gap-run.ts — the UNIFIED, data-driven entry for the scope-gap metric (monogram#25
//  part 2B). One driver + a per-language config TABLE, replacing the seven thin
//  scope-gap-{ts,js,jsx,tsx,html,yaml,vue} adapter files: each was mostly the same `run(adapter)`
//  literal differing only in corpus path / grammar path / scopeName / oracle / official path.
//  Those vary as DATA here; the shared core stays scope-gap.ts's `run()`.
//
//  Run (bare node):  node test/scope-gap-run.ts <lang> [N|all]
//                    lang ∈ ts | js | jsx | tsx | html | yaml | vue
//
//  Per-language entry is preserved as the `<lang>` PARAMETER (the npm scripts pass it). The
//  thicker html / yaml specifics (multi-file official loader, fullSpan, differential) live in their
//  TABLE ENTRY, not a separate file. VUE is genuinely different — it is an INJECTION grammar that
//  needs vuejs/language-tools' own tokenizer (a bare Registry.loadGrammar never fires the directive
//  / interpolation injections), so it cannot use `run()`; `<lang> vue` DELEGATES to scope-gap-vue.ts.
// ─────────────────────────────────────────────────────────────────────────────
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as yamlParse, parseAllDocuments } from 'yaml';
import { run, type ScopeGapAdapter } from './scope-gap.ts';
import { oracle } from './oracle.ts';
import { yamlOracle } from './yaml-oracle.ts';
import { htmlOracle } from './html-oracle.ts';
import { walkCorpus } from './src-coverage-tsfamily.ts';
import { JSX_CASES, HTML_GENERAL } from './curated-corpora.ts';
import { cases as htmlIssueCases } from './html-issue-cases.ts';
import { cases as yamlIssue12 } from './yaml-issue12-regressions.ts';

const VSCODE_TM = '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions';
// subset size from argv[3] (argv[2] is the language) / env SUBSET / default; `all` = the full corpus.
const subN = (def = 400): number => { const a = process.argv[3]; return a === 'all' ? Infinity : Number(a ?? process.env.SUBSET ?? def); };
const tsParseClean = (kind: ts.ScriptKind, fn: string) => (text: string): boolean => {
  const sf = ts.createSourceFile(fn, text, ts.ScriptTarget.Latest, true, kind);
  return (((sf as any).parseDiagnostics?.length ?? 0) === 0);
};

// One TS-family scope-gap adapter (TS/JS/JSX/TSX differ only by ScriptKind + corpus + paths).
function tsFamily(o: { name: string; scopeName: string; kind: ts.ScriptKind; mono: string; officialEnv: string; officialDefault: string; fn: string; corpus: () => { name: string; text: string }[] }): ScopeGapAdapter {
  return {
    name: o.name, scopeName: o.scopeName,
    officialPath: process.env[o.officialEnv] ?? o.officialDefault,
    monogramPath: o.mono,
    loadCorpus: o.corpus,
    roleOracle: (text) => oracle(text, o.kind),
    isGradable: tsParseClean(o.kind, o.fn),
  };
}

// ── per-language config table ────────────────────────────────────────────────────────────────────
const BUILDERS: Record<string, () => ScopeGapAdapter> = {
  ts: () => {
    // The TS entry strides over the FULL .ts file list then drops multi-file (@filename) fixtures —
    // the original scope-gap-ts order (walk-all → stride-pick → filter), preserved so the metric is
    // byte-identical (it differs subtly from walkCorpus, which filters before the stride).
    const DIR = '/tmp/ts-repo/tests/cases/conformance/parser';
    const all: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) all.push(f); } };
    walk(DIR); all.sort();
    return tsFamily({
      name: 'TypeScript', scopeName: 'source.ts', kind: ts.ScriptKind.TS, mono: 'typescript.tmLanguage.json', fn: 'c.ts',
      officialEnv: 'MONOGRAM_OFFICIAL_TM', officialDefault: `${VSCODE_TM}/typescript-basics/syntaxes/TypeScript.tmLanguage.json`,
      corpus: () => { const N = subN(400); const pick = !isFinite(N) || N >= all.length ? all : Array.from({ length: N }, (_, i) => all[Math.floor(i * all.length / N)]); return pick.map((f) => ({ name: f, text: readFileSync(f, 'utf8') })).filter((x) => !/^\s*\/\/\s*@filename:/im.test(x.text)); },
    });
  },
  js: () => tsFamily({
    name: 'JavaScript (.js)', scopeName: 'source.js', kind: ts.ScriptKind.JS, mono: 'javascript.tmLanguage.json', fn: 'c.js',
    officialEnv: 'MONOGRAM_OFFICIAL_TM', officialDefault: `${VSCODE_TM}/javascript/syntaxes/JavaScript.tmLanguage.json`,
    corpus: () => walkCorpus(['/tmp/test262/test/language'], ['.js'], subN(800)).filter((c) => !c.file.endsWith('_FIXTURE.js')).map((c) => ({ name: c.file, text: c.code })),
  }),
  jsx: () => tsFamily({
    name: 'JavaScriptReact (.jsx)', scopeName: 'source.js.jsx', kind: ts.ScriptKind.JSX, mono: 'javascriptreact.tmLanguage.json', fn: 'c.jsx',
    officialEnv: 'MONOGRAM_OFFICIAL_TM', officialDefault: `${VSCODE_TM}/javascript/syntaxes/JavaScriptReact.tmLanguage.json`,
    corpus: () => JSX_CASES.map((text, i) => ({ name: `<curated #${i}>`, text })),
  }),
  tsx: () => {
    const BASE = '/tmp/ts-repo/tests/cases';
    return tsFamily({
      name: 'TypeScriptReact (.tsx)', scopeName: 'source.tsx', kind: ts.ScriptKind.TSX, mono: 'typescriptreact.tmLanguage.json', fn: 'c.tsx',
      officialEnv: 'MONOGRAM_OFFICIAL_TM', officialDefault: `${VSCODE_TM}/typescript-basics/syntaxes/TypeScriptReact.tmLanguage.json`,
      corpus: () => walkCorpus([`${BASE}/conformance`, `${BASE}/compiler`], ['.tsx'], subN(Infinity)).map((c) => ({ name: c.file, text: c.code })),
    });
  },
  html: () => ({
    name: 'HTML', scopeName: 'text.html.basic',
    officialPath: process.env.MONOGRAM_OFFICIAL_HTML ?? `${VSCODE_TM}/html/syntaxes/html.tmLanguage.json`,
    monogramPath: 'html.tmLanguage.json',
    loadCorpus: () => [
      ...HTML_GENERAL.map((text, i) => ({ name: `general#${i}`, text })),
      ...htmlIssueCases.map((c: any, i: number) => ({ name: `issue:${c.title ?? i}`, text: c.src as string })),
    ],
    roleOracle: htmlOracle,
  }),
  yaml: () => {
    // The "official" YAML baseline is the MAINTAINED RedCMD/VS Code grammar (microsoft/vscode#232244),
    // a multi-file dispatcher that include()s version-specific sub-grammars in the same dir.
    const OFFICIAL = process.env.MONOGRAM_OFFICIAL_YAML ?? '/tmp/redcmd-yaml/syntaxes/yaml.tmLanguage.json';
    const SYN = dirname(OFFICIAL);
    const SUITE = '/tmp/yaml-test-suite/src';
    const decode = (s: string) => s.replace(/␣/g, ' ').replace(/—+»/g, '\t').replace(/[↵∎]/g, '');
    const corpus: { name: string; text: string }[] = [];
    for (const f of readdirSync(SUITE).filter((n) => n.endsWith('.yaml'))) {
      try { const meta = yamlParse(readFileSync(`${SUITE}/${f}`, 'utf8')); for (const t of (Array.isArray(meta) ? meta : [meta])) if (t && typeof t.yaml === 'string') corpus.push({ name: f, text: decode(t.yaml) }); } catch { /* skip */ }
    }
    for (const c of yamlIssue12) corpus.push({ name: `monogram#12 ${c.id}`, text: c.src });
    return {
      name: 'YAML', scopeName: 'source.yaml', officialPath: OFFICIAL, monogramPath: 'yaml.tmLanguage.json',
      officialExtra: {
        'source.yaml.1.2': join(SYN, 'yaml-1.2.tmLanguage.json'), 'source.yaml.1.1': join(SYN, 'yaml-1.1.tmLanguage.json'),
        'source.yaml.1.0': join(SYN, 'yaml-1.0.tmLanguage.json'), 'source.yaml.1.3': join(SYN, 'yaml-1.3.tmLanguage.json'),
        'source.yaml.embedded': join(SYN, 'yaml-embedded.tmLanguage.json'),
      },
      loadCorpus: () => corpus,
      roleOracle: yamlOracle,
      // Only grade valid YAML (the AST's key/value resolution is unreliable on malformed input); the
      // invalid-input blind spot is covered by the asserted issue12 gate + the differential pass.
      isGradable: (text) => { try { return parseAllDocuments(text).every((d: any) => d.errors.length === 0); } catch { return false; } },
      fullSpan: true,       // YAML's oracle emits coarse, role-homogeneous spans — grade every char
      differential: true,   // also report oracle-independent Monogram-vs-official divergences
    };
  },
};

const lang = process.argv[2];
const build = BUILDERS[lang];
if (!build) { console.error(`usage: node test/scope-gap-run.ts <ts|js|jsx|tsx|html|yaml> [N|all]\nunknown language: ${lang ?? '(none)'}`); process.exit(1); }
await run(build());
