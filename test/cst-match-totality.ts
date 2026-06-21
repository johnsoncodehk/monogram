// Gate: the generated per-arm destructurers (<grammar>.cst-match.ts) are TOTAL over
// real CSTs — for every node of every parsed input, the node's rule matcher must find
// an arm that unifies with the children EXACTLY (full consumption). A miss means the
// generator's unification semantics diverged from the engine's matcher semantics
// (greediness, sep trailing delimiters, template duals, op forms, …).
//
// The matchers are ARENA-NATIVE: inputs are parsed with the EMITTED parser (built
// fresh per grammar) and every node id is destructured through TreeAccess — this gate
// therefore also exercises the emitted arena end-to-end.
//
// Inputs: the deterministic generative corpus per grammar (grammar-gen), plus a TS
// conformance stride sample when the corpus is present.
//   node test/cst-match-totality.ts
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser } from '../src/emit-parser.ts';
import { generateInputs } from './grammar-gen.ts';

const GRAMMARS = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'yaml', 'html'];

let nodes = 0;
let misses = 0;
const samples: string[] = [];

type Emitted = {
  parse(src: string, entry?: string): number;
  visit(entry: number, fns: { enter?(id: number, charBase: number, tokBase: number): boolean | void; leaf?(e: number, tok: number): void }): void;
  tree: { ruleNameOf(id: number): string; lenOf(id: number): number };
};

function checkTree(em: Emitted, root: number, src: string, matchers: Record<string, (t: never, n: never, tb: number, src: string) => { arm: string }>, tag: string): void {
  em.visit(root, {
    enter(id, charBase, tokBase) {
      const m = matchers[em.tree.ruleNameOf(id)];
      if (m !== undefined) {
        nodes++;
        try {
          m(em.tree as never, id as never, tokBase, src);
        } catch (e) {
          misses++;
          if (samples.length < 10) {
            const end = charBase + em.tree.lenOf(id);
            samples.push(`${tag} ${em.tree.ruleNameOf(id)} @${charBase}..${end} «${src.slice(charBase, Math.min(end, charBase + 50)).replace(/\n/g, '\\n')}» — ${(e as Error).message.slice(0, 60)}`);
          }
        }
      }
    },
  });
}

for (const name of GRAMMARS) {
  const grammar = (await import(`../${name}.ts`)).default;
  const matchers = (await import(`../${name}.cst-match.ts`)).MATCHERS;
  const emPath = `/tmp/emitted-totality-${name}.mts`;
  writeFileSync(emPath, emitParser(grammar));
  const em = (await import(emPath + '?v=' + process.pid)) as Emitted;
  let parsed = 0;
  for (const input of generateInputs(grammar, { depth: 5, nestDepth: 5, cap: 7, fuzzRounds: 250, maxInputs: 1500, seed: 5 })) {
    let root: number;
    try { root = em.parse(input.text); } catch { continue; }
    checkTree(em, root, input.text, matchers, name);
    parsed++;
  }
  console.log(`${name.padEnd(18)} inputs parsed: ${parsed}`);

  if (name === 'typescript') {
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
      const stride = Math.max(1, Math.floor(files.length / 300));
      let parsed2 = 0;
      for (let i = 0; i < files.length; i += stride) {
        const src = readFileSync(files[i], 'utf-8');
        let root: number;
        try { root = em.parse(src); } catch { continue; }
        checkTree(em, root, src, matchers, 'ts-corpus:' + files[i].split('/').pop());
        parsed2++;
      }
      console.log(`${'ts-corpus'.padEnd(18)} corpus files parsed: ${parsed2}`);
    }
  }
}

console.log(`nodes matched: ${nodes}, misses: ${misses}`);
for (const s of samples) console.log('  ', s);
if (misses > 0) {
  console.error('✗ generated destructurers are not total over real CSTs');
  process.exit(1);
}
console.log('✓ every CST node destructures through its generated matcher');
