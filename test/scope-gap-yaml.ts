// scope-gap-yaml.ts — YAML adapter for the unified scope-gap harness. vscode#203212 language #1:
// VS Code's YAML grammar is the unmaintained textmate/yaml.tmbundle; the oracle is the `yaml`
// package (maintained). Run (bare node): node test/scope-gap-yaml.ts
//   Override the official grammar: MONOGRAM_OFFICIAL_YAML=/path/to/yaml.tmLanguage.json
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as yamlParse, parseAllDocuments } from 'yaml';
import { run } from './scope-gap.ts';
import { yamlOracle } from './yaml-oracle.ts';

const OFFICIAL = process.env.MONOGRAM_OFFICIAL_YAML
  ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/yaml/syntaxes/yaml.tmLanguage.json';
// VS Code's YAML grammar is a dispatcher stub that include()s version-specific sub-grammars in
// the same syntaxes/ dir — load them all, or the official scopes nothing (everything → root).
const SYN = dirname(OFFICIAL);
const officialExtra: Record<string, string> = {
  'source.yaml.1.2': join(SYN, 'yaml-1.2.tmLanguage.json'),
  'source.yaml.1.1': join(SYN, 'yaml-1.1.tmLanguage.json'),
  'source.yaml.1.0': join(SYN, 'yaml-1.0.tmLanguage.json'),
  'source.yaml.1.3': join(SYN, 'yaml-1.3.tmLanguage.json'),
  'source.yaml.embedded': join(SYN, 'yaml-embedded.tmLanguage.json'),
};

// Corpus: yaml-test-suite inputs (src meta-files; decode the visible-whitespace markers).
const SUITE = '/tmp/yaml-test-suite/src';
const decode = (s: string) => s.replace(/␣/g, ' ').replace(/—+»/g, '\t').replace(/[↵∎]/g, '');
const corpus: { name: string; text: string }[] = [];
for (const f of readdirSync(SUITE).filter((n) => n.endsWith('.yaml'))) {
  try {
    const meta = yamlParse(readFileSync(`${SUITE}/${f}`, 'utf8'));
    for (const t of (Array.isArray(meta) ? meta : [meta])) {
      if (t && typeof t.yaml === 'string') corpus.push({ name: f, text: decode(t.yaml) });
    }
  } catch { /* skip */ }
}

await run({
  name: 'YAML',
  scopeName: 'source.yaml',
  officialPath: OFFICIAL,
  officialExtra,
  monogramPath: 'yaml.tmLanguage.json',
  loadCorpus: () => corpus,
  roleOracle: yamlOracle,
  // grade only inputs the parser fully accepts (the oracle is meaningful there).
  isGradable: (text) => { try { return parseAllDocuments(text).every((d: any) => d.errors.length === 0); } catch { return false; } },
});
