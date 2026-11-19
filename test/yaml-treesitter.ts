// ─────────────────────────────────────────────────────────────────────────────
//  yaml-treesitter.ts — runtime gate for the DERIVED tree-sitter YAML grammar. Loads the wasm
//  built from tree-sitter/yaml/grammar.js (+ src/scanner.c) and parses flow-entry and empty-key
//  forms, checking that its accept/reject verdict (no ERROR/MISSING node) agrees with the
//  Monogram interpreter on each case:
//    • `{: a : b}` — the empty-key flow arm ends in `not(':')`; tree-sitter has no lookahead, so
//      the generator must lower it into the CFG or the trailing `: value` is wrongly accepted.
//    • `---\n:\n---\na` (yaml-test-suite NKF9) — a line-lead empty key; the external scanner must
//      not fold the declined `:` into the following NEWLINE.
//  Build the wasm first:
//    cd tree-sitter/yaml && npx tree-sitter generate && npx tree-sitter build --wasm .
//
//  Run: node test/yaml-treesitter.ts
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync } from 'node:fs';
import { createParser } from '../src/gen-parser.ts';
import yaml from '../yaml.ts';

const WASM = 'tree-sitter/yaml/tree-sitter-yaml.wasm';
if (!existsSync(WASM)) {
  console.error(`✗ Monogram tree-sitter wasm not found at ${WASM}\n  Build it: cd tree-sitter/yaml && npx tree-sitter generate && npx tree-sitter build --wasm .`);
  process.exit(1);
}

const { Parser, Language } = await import('web-tree-sitter');
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(WASM));

function hasError(root: any): boolean {
  const stack = [root];
  while (stack.length) { const n = stack.pop(); if (n.type === 'ERROR' || n.isMissing) return true; stack.push(...n.children); }
  return false;
}
const tsAccepts = (src: string) => !hasError(parser.parse(src)!.rootNode);
const interp = createParser(yaml);
const monogramAccepts = (src: string) => { try { interp.parse(src); return true; } catch { return false; } };

const accept = [
  '---\n:\n---\na\n',
  '---\nkey: value\n: empty key\n---\n{\n key: value, : empty key\n}\n---\n# empty key and value\n:\n---\n# empty key and value\n{ : }\n',
  '{: v}', '{:}', '{ : }', '{a: b, : v}', '{a:}', '{a: &x}', '{&x : v}', '{a, b}',
  '{? a : b, ? c, ?}', '{? foo :,}', '{foo\n: bar}', '[a: b]', '[: v]', '[&x, !!str]',
];
const reject = ['{: a : b}', '{a: b : c}', '{: : b}', '[a,,b]', '[,a]', '{a,,b}'];

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { if (cond) ok++; else { fail++; console.log('  ✗', label); } };
for (const s of accept) {
  check(`monogram accepts ${JSON.stringify(s)}`, monogramAccepts(s));
  check(`tree-sitter accepts ${JSON.stringify(s)}`, tsAccepts(s));
}
for (const s of reject) {
  check(`monogram rejects ${JSON.stringify(s)}`, !monogramAccepts(s));
  check(`tree-sitter rejects ${JSON.stringify(s)}`, !tsAccepts(s));
}
{
  const root = parser.parse('---\n:\n---\na\n')!.rootNode;
  const types: string[] = []; const stack = [root];
  while (stack.length) { const n = stack.pop(); types.push(n.type); stack.push(...n.children); }
  check('the NKF9 line-lead `:` is an empty_key_mapping (not folded into a NEWLINE)', types.includes('empty_key_mapping'));
}

console.log(`\n${ok}/${ok + fail} yaml tree-sitter checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
