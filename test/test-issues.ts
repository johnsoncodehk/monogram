import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
const { INITIAL, Registry, parseRawGrammar } = vsctm;
import onig from 'vscode-oniguruma';
const { loadWASM, OnigScanner, OnigString } = onig;

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
const wasmBin = readFileSync(wasmPath);

await loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

const registry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
    createOnigString: (s: string) => new OnigString(s),
  }),
  loadGrammar: async (scopeName: string) => {
    if (scopeName === 'source.ts') {
      const content = readFileSync('typescript.tmLanguage.json', 'utf-8');
      return parseRawGrammar(content, 'typescript.tmLanguage.json');
    }
    return null;
  },
});

const grammar = await registry.loadGrammar('source.ts');
if (!grammar) throw new Error('Failed to load grammar');

import { tests as allTests, multiLineTests as allMultiLineTests } from './issue-cases.ts';
import type { TestCase, Check, MultiLineTest, MultiLineCheck } from './issue-cases.ts';

// Gate Monogram's KNOWN-GOOD corpus: skip the honest `monoGap` cases — reported bugs the
// DERIVED grammar does not solve yet (only-official / both-miss). They still appear in the
// README cross-language table (issue-table.ts grades them honestly), but asserting Monogram
// produces the correct scope for them would (correctly) fail. Same convention as vue-issues.ts.
const tests = allTests.filter((t) => !t.monoGap);
const multiLineTests = allMultiLineTests.filter((t) => !t.monoGap);

let passed = 0;
let failed = 0;

// ── Single-line tests ──

for (const test of tests) {
  console.log(`\n── ${test.label}: ${test.input} ──`);

  const result = grammar.tokenizeLine(test.input, INITIAL);

  for (const token of result.tokens) {
    const text = test.input.slice(token.startIndex, token.endIndex);
    const innerScope = token.scopes[token.scopes.length - 1];
    console.log(`  ${text.padEnd(15)} ${innerScope}`);
  }

  let checkIdx = 0;
  for (const token of result.tokens) {
    if (checkIdx >= test.checks.length) break;
    const text = test.input.slice(token.startIndex, token.endIndex);
    const check = test.checks[checkIdx];
    if (text === check.text) {
      const scopes = token.scopes.join(' ');
      if (scopes.includes(check.scope)) {
        passed++;
      } else {
        console.log(`  FAIL: '${check.text}' expected scope containing '${check.scope}', got: ${scopes}`);
        failed++;
      }
      checkIdx++;
    }
  }
  if (checkIdx < test.checks.length) {
    for (let i = checkIdx; i < test.checks.length; i++) {
      console.log(`  FAIL: '${test.checks[i].text}' not found in token stream`);
      failed++;
    }
  }
}

// ── Multi-line tests ──

for (const test of multiLineTests) {
  console.log(`\n── ML: ${test.label} ──`);
  console.log(`  input: ${test.lines.map(l => JSON.stringify(l)).join(' / ')}`);

  const lineResults: vsctm.ITokenizeLineResult[] = [];
  let ruleStack = INITIAL;
  for (const line of test.lines) {
    const result = grammar.tokenizeLine(line, ruleStack);
    lineResults.push(result);
    ruleStack = result.ruleStack;
  }

  for (let li = 0; li < test.lines.length; li++) {
    const line = test.lines[li];
    for (const token of lineResults[li].tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      const innerScope = token.scopes[token.scopes.length - 1];
      console.log(`  L${li}: ${text.padEnd(15)} ${innerScope}`);
    }
  }

  for (const check of test.checks) {
    const line = test.lines[check.line];
    const tokens = lineResults[check.line].tokens;
    let found = false;
    for (const token of tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      if (text === check.text) {
        const scopes = token.scopes.join(' ');
        if (scopes.includes(check.scope)) {
          passed++;
        } else {
          console.log(`  FAIL: L${check.line} '${check.text}' expected '${check.scope}', got: ${scopes}`);
          failed++;
        }
        found = true;
        break;
      }
    }
    if (!found) {
      console.log(`  FAIL: L${check.line} '${check.text}' not found in token stream`);
      failed++;
    }
  }
}

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
