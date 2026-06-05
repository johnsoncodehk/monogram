// src-coverage-yaml.ts — YAML adapter for the source-coverage alignment metric.
// Anchored on microsoft/vscode#203212: VS Code highlights YAML with the UNMAINTAINED
// textmate/yaml.tmbundle (last touched ~6 years ago). The official PARSER, by contrast, is
// alive: the `yaml` package (eemeli) is the most spec-compliant JS YAML parser and underlies
// redhat's yaml-language-server. So we align Monogram's derived YAML grammar to that parser.
//
// Oracle = accept/reject: official accept iff parseAllDocuments() reports no errors; Monogram
// accept iff createParser(yaml grammar).parse() doesn't throw. Corpus = the inputs extracted
// from yaml-test-suite (the canonical conformance suite):
//   git clone --depth 1 https://github.com/yaml/yaml-test-suite /tmp/yaml-test-suite
// Run (bare node): node test/src-coverage-yaml.ts

import { readdirSync, readFileSync } from 'node:fs';
import { parse as yamlParse, parseAllDocuments } from 'yaml';
import { createParser } from '../src/gen-parser.ts';
import { run, type AgreeResult, type CorpusItem } from './src-coverage.ts';

const grammar = (await import('../yaml.ts')).default;
const { parse } = createParser(grammar);

// Corpus: each yaml-test-suite src/*.yaml is itself a YAML sequence of test maps; the input
// document lives in each map's `yaml:` block scalar. Extract them all.
const SUITE = '/tmp/yaml-test-suite/src';
// The suite's src format encodes whitespace visibly (per its ReadMe): ␣ = space, —…» = hard
// tab, ↵/∎ = trailing-newline markers. Decode to real bytes so each input is genuine YAML.
const decode = (s: string) => s.replace(/␣/g, ' ').replace(/—*»/g, '\t').replace(/[↵∎]/g, '');
const corpus: { code: string; origin: string }[] = [];
for (const f of readdirSync(SUITE).filter((n) => n.endsWith('.yaml'))) {
  try {
    const meta = yamlParse(readFileSync(`${SUITE}/${f}`, 'utf8'));
    for (const t of (Array.isArray(meta) ? meta : [meta])) {
      if (t && typeof t.yaml === 'string') corpus.push({ code: decode(t.yaml), origin: f });
    }
  } catch { /* skip meta-files that don't themselves round-trip through yaml.parse */ }
}
console.log(`YAML corpus: ${corpus.length} inputs extracted from yaml-test-suite (src meta-files).`);

let officialThrew = 0;
function officialAccepts(code: string): boolean {
  try {
    return parseAllDocuments(code).every((d: any) => d.errors.length === 0);
  } catch { officialThrew++; return false; }
}
const monogramAccepts = (code: string): boolean => { try { parse(code); return true; } catch { return false; } };

await run({
  name: 'YAML',
  oracle: 'accept/reject (yaml package)',
  urlMatch: (url) => /node_modules\/yaml\//.test(url),
  loadCorpus: (): CorpusItem[] => corpus.map((c) => ({ code: c.code, origin: c.origin })),
  warmup: () => { officialAccepts('a: 1\nb: [1, 2]\nc:\n  d: e\n- x\n'); },
  runOfficial: (code) => ({ accept: officialAccepts(code) }), // the measured yaml-package parse
  agree: (code, official): AgreeResult => {
    const o = (official as { accept: boolean }).accept;
    const m = monogramAccepts(code);
    return { agree: o === m, officialAccept: o, monoAccept: m };
  },
  denominators: [{ label: 'all of yaml package', keep: () => true }],
  ledgerTop: 12,
  renderHeader: (results) => {
    let TP = 0, FN = 0, FP = 0, TN = 0;
    for (const r of results) {
      const o = r.officialAccept as boolean, m = r.monoAccept as boolean;
      if (o && m) TP++; else if (o && !m) FN++; else if (!o && m) FP++; else TN++;
    }
    const total = TP + FN + FP + TN || 1;
    console.log(`  confusion: TP=${TP} (both accept)  FN=${FN} (yaml accepts, we reject)  FP=${FP} (yaml rejects, we accept)  TN=${TN} (both reject)`);
    console.log(`  bidirectional agree: ${((100 * (TP + TN)) / total).toFixed(2)}%`);
    if (officialThrew) console.log(`  caveat: yaml parser threw on ${officialThrew} input(s) — counted as reject`);
  },
});
