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
import { cases as issue12 } from './yaml-issue12-regressions.ts';

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
// Plus the RedCMD monogram#12 repros (many are tiny edge/error inputs absent from the suite) so the
// metric actually SEES the constructs the comment flagged. Asserted should-be scopes live in their
// own gate (yaml-issue12-regressions.ts); here they just widen what the gap/differential pass covers.
for (const c of issue12) corpus.push({ name: `monogram#12 ${c.id}`, text: c.src });

await run({
  name: 'YAML',
  scopeName: 'source.yaml',
  officialPath: OFFICIAL,
  officialExtra,
  monogramPath: 'yaml.tmLanguage.json',
  loadCorpus: () => corpus,
  roleOracle: yamlOracle,
  // The GRADED headline stays valid-only: on malformed YAML the AST's key/value resolution is itself
  // unreliable, so grading it would inject false "Monogram-wrong" tokens and poison the very signal
  // we're making trustworthy. The invalid-input blind spot is instead closed by TWO mechanisms that
  // stay honest there: (1) the asserted regression gate (yaml-issue12-regressions.ts) pins the
  // should-be scope of the specific malformed repros (#4/#5/#8); (2) the differential pass below runs
  // on ALL inputs and FLAGS invalid-input divergences for human review without auto-judging them.
  isGradable: (text) => { try { return parseAllDocuments(text).every((d: any) => d.errors.length === 0); } catch { return false; } },
  // YAML's oracle emits COARSE, role-homogeneous spans (a whole plain scalar, a block-scalar body, a
  // directive line); grade every char so a bug mid-span (a `%YAML` folded into a scalar, a block line
  // bailing to a comment) is caught instead of hidden behind a correct start. See scope-gap.ts.
  fullSpan: true,
  // Also report oracle-INDEPENDENT divergences (Monogram vs official, where the oracle is silent) so a
  // construct the CST oracle doesn't model can't become a silent blind spot. See scope-gap.ts.
  differential: true,
});
