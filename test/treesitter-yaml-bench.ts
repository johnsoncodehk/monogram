// YAML tree-sitter accuracy bench (issue #3): how many VALID yaml-test-suite inputs the DERIVED
// YAML tree-sitter parses with no ERROR/MISSING node. "Valid" = the `yaml` package accepts the input
// (so a failure is the tree-sitter grammar's, not a malformed sample). The corpus is extracted from
// the yaml-test-suite src meta-files exactly like test/src-coverage-yaml.ts.
//
//   git clone --depth 1 https://github.com/yaml/yaml-test-suite /tmp/yaml-test-suite
//   cd tree-sitter/yaml && npx tree-sitter generate && npx tree-sitter build --wasm .
//   node test/treesitter-yaml-bench.ts
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { parse as yamlParse, parseAllDocuments } from 'yaml';

const WASM = 'tree-sitter/yaml/tree-sitter-yaml.wasm';
const SUITE = '/tmp/yaml-test-suite/src';
if (!existsSync(WASM)) { console.error(`missing ${WASM} — run: (cd tree-sitter/yaml && npx tree-sitter build --wasm .)`); process.exit(1); }
if (!existsSync(SUITE)) { console.error(`missing ${SUITE} — git clone --depth 1 https://github.com/yaml/yaml-test-suite /tmp/yaml-test-suite`); process.exit(1); }

const { Parser, Language } = await import('web-tree-sitter');
await Parser.init();
const lang = await Language.load(WASM);
const parser = new Parser();
parser.setLanguage(lang);

// Decode the suite's visible-whitespace markers to real bytes (same as src-coverage-yaml).
const decode = (s: string) => s.replace(/␣/g, ' ').replace(/—*»/g, '\t').replace(/[↵∎]/g, '');
const corpus: string[] = [];
for (const f of readdirSync(SUITE).filter((n) => n.endsWith('.yaml'))) {
  try {
    const meta = yamlParse(readFileSync(`${SUITE}/${f}`, 'utf8'));
    for (const t of (Array.isArray(meta) ? meta : [meta])) if (t && typeof t.yaml === 'string') corpus.push(decode(t.yaml));
  } catch { /* skip meta-files that don't round-trip */ }
}
const valid = corpus.filter((c) => { try { return parseAllDocuments(c).every((d: any) => d.errors.length === 0); } catch { return false; } });

function hasError(node: any): boolean {
  if (node.type === 'ERROR' || node.isError === true || node.isMissing === true) return true;
  for (let i = 0; i < node.childCount; i++) { const c = node.child(i); if (c && hasError(c)) return true; }
  return false;
}

let ok = 0;
for (const c of valid) { const tree = parser.parse(c); if (tree && !hasError(tree.rootNode)) ok++; }
const pct = ((100 * ok) / valid.length).toFixed(1);
console.log(`YAML corpus: ${corpus.length} inputs (${valid.length} valid per the yaml package).`);
console.log(`YAML tree-sitter accuracy: ${ok}/${valid.length} valid inputs parse ERROR-free (${pct}%).`);
console.log(`##TSYAML## ${JSON.stringify({ name: 'YAML', engine: 'tree-sitter (derived)', valid: valid.length, errorFree: ok, pct: Number(pct) })}`);
