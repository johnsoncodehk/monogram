// yaml-blockscalar-depth-probe.ts — the depth gate for the BLOCK-SCALAR carrier (§2a⁗), the indent
// construct whose body-mode (the content FLOOR) is per-construct and therefore NOT covered by the
// block-sequence deepest-sibling probe even though both share the consuming-carry core.
//
// A `|N`/`>N`/`|` block scalar whose mapping sits in a compact block sequence (`- - … k: |N`) has a
// content floor; a line AT the floor is block-scalar content, a line one column SHALLOWER ends the
// scalar (a comment / sibling). The §2a⁗ carry must place that floor correctly at ARBITRARY compact
// depth (the monogram#12 #14 class: a flat floor saturated at depth ≥ 2). This sweeps d=1..12 and
// checks BOTH directions against the eemeli CST oracle: the floor line must be block content (an
// UNDER-floor regression paints it a comment), the floor-1 line must be a comment (an OVER-floor
// regression paints it block string). Covers explicit `|N` (N=2,3) and the auto-detect `|`.
//
// Run (bare node): node test/yaml-blockscalar-depth-probe.ts   ·   Exit 0 iff zero mismatch.
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

const raw = JSON.parse(readFileSync('./yaml.tmLanguage.json', 'utf8'));
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

// eemeli CST oracle: the kind of token covering the byte offset of (lineIdx, col).
function oracleKind(src: string, lineIdx: number, col: number): 'blockscalar' | 'comment' | '?' {
  const lines = src.split('\n');
  let off = 0;
  for (let i = 0; i < lineIdx; i++) off += lines[i].length + 1;
  off += col;
  let kind: 'blockscalar' | 'comment' | '?' = '?';
  const walk = (t: any) => {
    if (!t || typeof t !== 'object') return;
    if (t.offset != null && typeof t.source === 'string' && off >= t.offset && off < t.offset + t.source.length) {
      if (t.type === 'comment') kind = 'comment';
      else if (t.type === 'block-scalar') kind = 'blockscalar';
    }
    for (const k in t) if (t[k] && typeof t[k] === 'object') walk(t[k]);
  };
  for (const tok of new YAML.Parser().parse(src)) walk(tok);
  return kind;
}

const bad: string[] = [];
let checked = 0;

// At each depth, the floor line (indent = floor) must be block content; the floor-1 line a comment.
function check(label: string, src: string, floor: number) {
  // floor line is line 1 for explicit (header, floor-line, below) — caller passes the line layout via
  // marker text; we locate the two marker lines by their leading-space width.
  const lines = src.split('\n');
  const floorLine = lines.findIndex((l) => l.startsWith(' '.repeat(floor) + '#atfloor'));
  const belowLine = lines.findIndex((l) => l.startsWith(' '.repeat(floor - 1) + '#below'));
  if (floorLine < 0 || belowLine < 0) { bad.push(`${label}: witness malformed`); return; }
  checked += 2;
  const gF = scopeAt(src, floorLine, floor), oF = oracleKind(src, floorLine, floor);
  const gB = scopeAt(src, belowLine, floor - 1), oB = oracleKind(src, belowLine, floor - 1);
  // floor line: oracle blockscalar, grammar string.unquoted.block (UNDER-floor if grammar says comment)
  if (!(oF === 'blockscalar' && /string\.unquoted\.block/.test(gF ?? ''))) bad.push(`${label} FLOOR@${floor}: grammar «${gF}» oracle «${oF}» (want block content)`);
  // floor-1 line: oracle comment, grammar comment (OVER-floor if grammar says block string)
  if (!(oB === 'comment' && /comment/.test(gB ?? ''))) bad.push(`${label} FLOOR-1@${floor - 1}: grammar «${gB}» oracle «${oB}» (want comment)`);
}

for (let d = 1; d <= 12; d++) {
  const dash = '- '.repeat(d);
  const prefix = dash.length;        // 2*d
  // EXPLICIT |N (N = 2, 3): floor = prefix + N.
  for (const N of [2, 3]) {
    const floor = prefix + N;
    const src = `${dash}k: |${N}\n` + ' '.repeat(floor) + '#atfloor\n' + ' '.repeat(floor - 1) + '#below\n';
    if (YAML.parseDocument(src).errors.length === 0) check(`d${d} |${N}`, src, floor);
  }
  // AUTO-detect |: the floor is the first body line's indent; place it at prefix+2.
  {
    const floor = prefix + 2;
    const src = `${dash}k: |\n` + ' '.repeat(floor) + '#atfloor\n' + ' '.repeat(floor - 1) + '#below\n';
    if (YAML.parseDocument(src).errors.length === 0) check(`d${d} |auto`, src, floor);
  }
}

console.log(`checked ${checked} (floor, floor-1) assertions at d=1..12 (explicit |2/|3 + auto |) vs the eemeli CST oracle`);
for (const b of bad) console.log(`  ✗ ${b}`);
console.log(bad.length === 0 ? '\n✓ block-scalar content floor correct at every depth (no saturation)' : `\n✗ ${bad.length} mismatch(es)`);
process.exit(bad.length === 0 ? 0 : 1);
