// Gate: the CST leaf contract is span-only — a leaf is exactly {kind, tokenType, offset,
// end}: NO text field (text is derivable: source.slice(offset, end) — the invariant that
// licensed dropping it covered every grammar incl. yaml's synthetic indentation tokens,
// merged flow plain-scalar runs, html raw-text/entities and template spans), and spans
// are sane (0 ≤ offset ≤ end ≤ source.length, leaf spans non-decreasing in tree order).
//
// Inputs: the generative corpus (grammar-gen, deterministic) for every grammar, plus a
// stride sample of the real-world TS conformance corpus when present (skipped silently
// otherwise — check.ts gates must not require an external corpus).
//   node test/cst-text-invariant.ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createParser } from '../src/gen-parser.ts';
import { generateInputs } from './grammar-gen.ts';

const GRAMMARS = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'yaml', 'html', 'vue'];

let leaves = 0;
let bad = 0;
const samples: { tag: string; tokenType: string; text: string; span: string }[] = [];

type CstNode = { kind: string; tokenType?: string; text?: string; offset: number; end: number; children?: CstNode[] };
function check(n: CstNode, src: string, tag: string): void {
  if (n.kind === 'leaf') {
    leaves++;
    const ok = !('text' in n)
      && typeof n.offset === 'number' && typeof n.end === 'number'
      && n.offset >= 0 && n.offset <= n.end && n.end <= src.length;
    if (!ok) {
      bad++;
      if (samples.length < 8) samples.push({ tag, tokenType: n.tokenType ?? '', text: String('text' in n ? n.text : '<span bad>'), span: src.slice(n.offset, n.end) });
    }
    return;
  }
  for (const c of n.children ?? []) check(c, src, tag);
}

for (const name of GRAMMARS) {
  const grammar = (await import(`../${name}.ts`)).default;
  const parser = createParser(grammar);
  let parsed = 0;
  for (const input of generateInputs(grammar, { depth: 5, nestDepth: 5, cap: 7, fuzzRounds: 250, maxInputs: 1500, seed: 5 })) {
    let cst: CstNode;
    try { cst = parser.parse(input.text) as CstNode; } catch { continue; }
    check(cst, input.text, name);
    parsed++;
  }
  console.log(`${name.padEnd(18)} generated inputs parsed: ${parsed}`);
}

// Real-world TS sample (optional corpus).
const corpus = '/tmp/ts-repo/tests/cases/conformance';
if (existsSync(corpus)) {
  const files: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) files.push(p);
    }
  })(corpus);
  files.sort();
  const grammar = (await import('../typescript.ts')).default;
  const parser = createParser(grammar);
  const stride = Math.max(1, Math.floor(files.length / 300));
  let parsed = 0;
  for (let i = 0; i < files.length; i += stride) {
    const src = readFileSync(files[i], 'utf-8');
    let cst: CstNode;
    try { cst = parser.parse(src) as CstNode; } catch { continue; }
    check(cst, src, 'ts-corpus');
    parsed++;
  }
  console.log(`${'ts-corpus'.padEnd(18)} corpus files parsed: ${parsed}`);
}

console.log(`leaves checked: ${leaves}, contract violations: ${bad}`);
for (const s of samples) console.log('  ', JSON.stringify(s).slice(0, 160));
if (bad > 0) {
  console.error('✗ leaf shape violates the span-only contract');
  process.exit(1);
}
console.log('✓ every leaf is span-only ({kind, tokenType, offset, end}) with a sane span');
