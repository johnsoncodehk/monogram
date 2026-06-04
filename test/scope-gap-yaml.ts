// scope-gap-yaml.ts — YAML adapter for the unified scope-gap harness. NOTE: unlike most of the
// vscode#203212 list, VS Code already switched YAML OFF the dead textmate/yaml.tmbundle TO the
// maintained RedCMD/YAML-Syntax-Highlighter (microsoft/vscode#232244). So YAML's "official"
// baseline here is that MAINTAINED grammar — this gap is Monogram vs a maintained competitor, not
// a dead bundle. Default = RedCMD UPSTREAM; clone it first:
//   git clone --depth 1 https://github.com/RedCMD/YAML-Syntax-Highlighter /tmp/redcmd-yaml
// (VS Code's bundled YAML is the same grammar — identical result; set MONOGRAM_OFFICIAL_YAML to
//  .../extensions/yaml/syntaxes/yaml.tmLanguage.json for that.) Oracle = the `yaml` package.
// Run (bare node): node test/scope-gap-yaml.ts
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as yamlParse, parseAllDocuments } from 'yaml';
import { run } from './scope-gap.ts';
import { yamlOracle } from './yaml-oracle.ts';

const OFFICIAL = process.env.MONOGRAM_OFFICIAL_YAML ?? '/tmp/redcmd-yaml/syntaxes/yaml.tmLanguage.json';
// The RedCMD/VS Code YAML grammar is a dispatcher stub that include()s version-specific
// sub-grammars in the same syntaxes/ dir — load them all, or the official scopes nothing.
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
