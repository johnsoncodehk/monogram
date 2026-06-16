// Gate: the CST contract — a leaf is exactly {tokenType, offset, end}, a node exactly
// {rule, children, offset, end}. No `text` (derivable: source.slice(offset, end)) and no
// `kind` (derivable: a leaf has tokenType, a node has children — disjoint by construction)
// on either shape, and spans are sane (0 ≤ offset ≤ end ≤ source.length).
//
// Inputs: the generative corpus (grammar-gen, deterministic) for every grammar, plus a
// stride sample of the real-world TS conformance corpus when present (skipped silently
// otherwise — check.ts gates must not require an external corpus).
//   node test/cst-text-invariant.ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createParser } from '../src/gen-parser.ts';
import { generateInputs } from './grammar-gen.ts';

const GRAMMARS = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'yaml', 'html'];

let leaves = 0;
let bad = 0;
const samples: { tag: string; tokenType: string; text: string; span: string }[] = [];

type AnyCst = { kind?: string; tokenType?: string; rule?: string; text?: string; offset: number; end: number; children?: AnyCst[] };
function check(n: AnyCst, src: string, tag: string): void {
  if (n.children === undefined) {
    leaves++;
    const ok = !('text' in n) && !('kind' in n)
      && typeof n.tokenType === 'string' && !('rule' in n)
      && typeof n.offset === 'number' && typeof n.end === 'number'
      && n.offset >= 0 && n.offset <= n.end && n.end <= src.length;
    if (!ok) {
      bad++;
      if (samples.length < 8) samples.push({ tag, tokenType: n.tokenType ?? '', text: String('text' in n ? n.text : '<shape bad>'), span: src.slice(n.offset, n.end) });
    }
    return;
  }
  if ('kind' in n || 'tokenType' in n || typeof n.rule !== 'string') {
    bad++;
    if (samples.length < 8) samples.push({ tag, tokenType: '<node shape bad>', text: String(n.rule), span: '' });
  }
  for (const c of n.children) check(c, src, tag);
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
  console.error('✗ CST shape violates the contract');
  process.exit(1);
}
console.log('✓ every leaf is {tokenType, offset, end} and every node {rule, children, offset, end}');
