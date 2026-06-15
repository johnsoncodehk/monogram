// yaml-deepest-sibling-probe.ts — the BIDIRECTIONAL adversarial oracle check for the compact
// block-sequence deepest-sibling (monogram#24 inline-deep residual). For an inline `- - … - a`
// header (d dashes on one physical line) followed by a sibling `- b` at column C, the dash at C
// is `punctuation` IFF the eemeli `yaml` CST emits a `seq-item-ind` token there. This probe sweeps
// EVERY valid (header-shape, sibling-column) pair at d = 1..8 (single- and double-space compaction)
// and compares the GENERATED grammar to that oracle in BOTH directions:
//   • UNDER-reclaim: grammar paints non-punctuation where the oracle says seq-item-ind (a real
//     sibling folded to string — the bug this region is meant to fix).
//   • OVER-reclaim:  grammar paints punctuation where the oracle says it is NOT a seq-item-ind (a
//     deeper FOLD line wrongly claimed as a sibling — the regression a too-greedy reclaim causes).
// A correct grammar has ZERO of both. Master under-reclaims at d>=4 (the saturated-column residual)
// but has zero over-reclaim; the arbiter for any candidate fix is "0 over-reclaim AND fewer (ideally
// 0) under-reclaim, with no new mismatch of either kind".
//
// Run (bare node): node test/yaml-deepest-sibling-probe.ts [path/to/yaml.tmLanguage.json]
// Exit code: 0 iff zero mismatches (fully oracle-correct); 1 otherwise. Prints per-direction counts
// and every mismatch so a candidate fix can be judged precisely.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import YAML from 'yaml';

const { INITIAL, Registry } = vsctm;
const { loadWASM, OnigScanner, OnigString } = onig;
const require = createRequire(import.meta.url);
const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

const grammarPath = process.argv[2] ?? './yaml.tmLanguage.json';
const raw = JSON.parse(readFileSync(grammarPath, 'utf8'));
const registry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (ps: string[]) => new OnigScanner(ps),
    createOnigString: (s: string) => new OnigString(s),
  }),
  loadGrammar: async (scope: string) => (scope === raw.scopeName ? raw : null),
});
const grammar = await registry.loadGrammar(raw.scopeName);

function scopeAt(src: string, lineIdx: number, col: number): string | null {
  const lines = src.split('\n');
  let rs = INITIAL;
  let res: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const r = grammar!.tokenizeLine(lines[i], rs);
    if (i === lineIdx) for (const t of r.tokens) if (col >= t.startIndex && col < t.endIndex) res = t.scopes[t.scopes.length - 1];
    rs = r.ruleStack;
  }
  return res;
}

// eemeli CST oracle: is there a `seq-item-ind` token at the byte offset of (lineIdx, col)?
function oracleIsSeqDash(src: string, lineIdx: number, col: number): boolean {
  const lines = src.split('\n');
  let off = 0;
  for (let i = 0; i < lineIdx; i++) off += lines[i].length + 1;
  off += col;
  let seq = false;
  const walk = (t: any) => {
    if (!t || typeof t !== 'object') return;
    if (t.type === 'seq-item-ind' && t.offset === off) seq = true;
    for (const k in t) if (t[k] && typeof t[k] === 'object') walk(t[k]);
  };
  for (const tok of new YAML.Parser().parse(src)) walk(tok);
  return seq;
}

const under: string[] = [];   // grammar non-punct, oracle SEQ  (real sibling folded → bug)
const over: string[] = [];    // grammar punct,     oracle fold (deeper fold reclaimed → regression)
let checked = 0;

for (const sp of [' ', '  ']) {
  for (let d = 1; d <= 8; d++) {
    const header = (`-${sp}`).repeat(d) + 'a';
    const maxCol = (1 + sp.length) * d + 2;
    for (let col = 0; col <= maxCol; col++) {
      const src = `${header}\n${' '.repeat(col)}- b\n`;
      if (YAML.parseDocument(src).errors.length) continue;   // only VALID YAML
      checked++;
      const isPunct = /punctuation/.test(scopeAt(src, 1, col) ?? '');
      const isSeq = oracleIsSeqDash(src, 1, col);
      const tag = `sp${sp.length} d${d} c${col}  ${JSON.stringify(src)}`;
      if (isSeq && !isPunct) under.push(tag);
      if (!isSeq && isPunct) over.push(tag);
    }
  }
}

console.log(`grammar: ${grammarPath}`);
console.log(`checked ${checked} valid (header, sibling-column) pairs against the eemeli CST oracle`);
console.log(`  UNDER-reclaim (real sibling folded to string): ${under.length}`);
for (const u of under) console.log(`    under  ${u}`);
console.log(`  OVER-reclaim  (deeper fold claimed as sibling): ${over.length}`);
for (const o of over) console.log(`    over   ${o}`);
const total = under.length + over.length;
console.log(total === 0 ? '\n✓ fully oracle-correct (0 mismatches in both directions)' : `\n✗ ${total} mismatch(es) — ${under.length} under, ${over.length} over`);
process.exit(total === 0 ? 0 : 1);
