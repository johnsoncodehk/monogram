// Gate: the generated per-arm destructurers (<grammar>.cst-match.ts) are TOTAL over
// real CSTs — for every node of every parsed input, the node's rule matcher must find
// an arm that unifies with the children EXACTLY (full consumption). A miss means the
// generator's unification semantics diverged from the engine's matcher semantics
// (greediness, sep trailing delimiters, template duals, op forms, …).
//
// Inputs: the deterministic generative corpus per grammar (grammar-gen), plus a TS
// conformance stride sample when the corpus is present.
//   node test/cst-match-totality.ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createParser } from '../src/gen-parser.ts';
import { generateInputs } from './grammar-gen.ts';

const GRAMMARS = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'yaml', 'html', 'vue'];

let nodes = 0;
let misses = 0;
const samples: string[] = [];

type AnyNode = { rule?: string; tokenType?: string; offset: number; end: number; children?: AnyNode[] };

function checkTree(cst: AnyNode, src: string, matchers: Record<string, (n: never, src: string) => { arm: string }>, tag: string): void {
  const walk = (n: AnyNode): void => {
    if (n.children === undefined) return;
    const m = matchers[n.rule!];
    if (m !== undefined) {
      nodes++;
      try {
        m(n as never, src);
      } catch (e) {
        misses++;
        if (samples.length < 10) {
          samples.push(`${tag} ${n.rule} @${n.offset}..${n.end} «${src.slice(n.offset, Math.min(n.end, n.offset + 50)).replace(/\n/g, '\\n')}» — ${(e as Error).message.slice(0, 60)}`);
        }
      }
    }
    for (const c of n.children) walk(c);
  };
  walk(cst);
}

for (const name of GRAMMARS) {
  const grammar = (await import(`../${name}.ts`)).default;
  const matchers = (await import(`../${name}.cst-match.ts`)).MATCHERS;
  const parser = createParser(grammar);
  let parsed = 0;
  for (const input of generateInputs(grammar, { depth: 5, nestDepth: 5, cap: 7, fuzzRounds: 250, maxInputs: 1500, seed: 5 })) {
    let cst: AnyNode;
    try { cst = parser.parse(input.text) as AnyNode; } catch { continue; }
    checkTree(cst, input.text, matchers, name);
    parsed++;
  }
  console.log(`${name.padEnd(18)} inputs parsed: ${parsed}`);
}

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
  const matchers = (await import('../typescript.cst-match.ts')).MATCHERS;
  const parser = createParser(grammar);
  const stride = Math.max(1, Math.floor(files.length / 300));
  let parsed = 0;
  for (let i = 0; i < files.length; i += stride) {
    const src = readFileSync(files[i], 'utf-8');
    let cst: AnyNode;
    try { cst = parser.parse(src) as AnyNode; } catch { continue; }
    checkTree(cst, src, matchers, 'ts-corpus:' + files[i].split('/').pop());
    parsed++;
  }
  console.log(`${'ts-corpus'.padEnd(18)} corpus files parsed: ${parsed}`);
}

console.log(`nodes matched: ${nodes}, misses: ${misses}`);
for (const s of samples) console.log('  ', s);
if (misses > 0) {
  console.error('✗ generated destructurers are not total over real CSTs');
  process.exit(1);
}
console.log('✓ every CST node destructures through its generated matcher');
