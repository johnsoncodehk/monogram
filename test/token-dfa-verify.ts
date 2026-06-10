// Correctness + speed gate for token-dfa.ts: for every TS token whose pattern compiles
// to a DFA, the DFA's match length must equal the token's sticky-regex match length at
// EVERY position of the corpus (byte-identical), and we measure the per-token speedup.
//
//   node test/token-dfa-verify.ts
import { compileTokenDfa } from '../src/token-dfa.ts';
import { tokenPatternSource } from '../src/token-pattern.ts';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const grammar = (await import('../typescript.ts')).default;

const base = '/tmp/ts-repo/tests/cases/conformance';
function walk(d: string): string[] {
  const o: string[] = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    if (e.isDirectory()) o.push(...walk(f));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) o.push(f);
  }
  return o;
}
const files = walk(base).sort().filter((_, i) => i % 11 === 0);   // ~stride sample
const sources = files.map(f => { try { return readFileSync(f, 'utf-8'); } catch { return ''; } }).filter(Boolean);
const totalChars = sources.reduce((a, s) => a + s.length, 0);

// Tokens the per-position lexer loop actually runs through a regex (skip template).
const tokens = grammar.tokens.filter(t => !t.template);

console.log(`tokens: ${tokens.length} · corpus sample: ${sources.length} files, ${(totalChars / 1024).toFixed(0)} KB\n`);
console.log('token            DFA?    positions   mism   regex ms   dfa ms   speedup');
console.log('-'.repeat(78));

let totalMism = 0, compiled = 0, fellBack = 0;
for (const t of tokens) {
  let src: string;
  try { src = tokenPatternSource(t); } catch { src = ''; }
  const dfa = compileTokenDfa(t.pattern);
  if (!dfa) {
    fellBack++;
    console.log(`${t.name.padEnd(16)} regex   ${'—'.padStart(10)}   ${'—'.padStart(4)}   (unsupported → falls back to regex)`);
    continue;
  }
  compiled++;
  const re = new RegExp(`(?:${src})`, 'y');

  // Correctness: at every position, DFA length === regex length.
  let mism = 0, positions = 0;
  for (const s of sources) {
    for (let pos = 0; pos < s.length; pos++) {
      re.lastIndex = pos;
      const m = re.exec(s);
      const reLen = m ? m[0].length : -1;
      const dfaLen = dfa.match(s, pos);
      positions++;
      if (reLen !== dfaLen) {
        if (mism < 3) console.log(`    MISMATCH @${pos} re=${reLen} dfa=${dfaLen} ctx=${JSON.stringify(s.slice(pos, pos + 24))}`);
        mism++;
      }
    }
  }
  totalMism += mism;

  // Speed: scan each source once via regex vs DFA (best-of-5).
  const timeRe = () => { let acc = 0; for (const s of sources) for (let p = 0; p < s.length; p++) { re.lastIndex = p; const m = re.exec(s); acc += m ? m[0].length : 0; } return acc; };
  const timeDfa = () => { let acc = 0; for (const s of sources) for (let p = 0; p < s.length; p++) { const l = dfa.match(s, p); acc += l > 0 ? l : 0; } return acc; };
  const best = (fn: () => number) => { for (let w = 0; w < 2; w++) fn(); let b = Infinity; for (let r = 0; r < 5; r++) { const t0 = process.hrtime.bigint(); fn(); const dt = Number(process.hrtime.bigint() - t0) / 1e6; if (dt < b) b = dt; } return b; };
  const reMs = best(timeRe), dfaMs = best(timeDfa);
  console.log(`${t.name.padEnd(16)} dfa     ${String(positions).padStart(10)}   ${String(mism).padStart(4)}   ${reMs.toFixed(1).padStart(8)}   ${dfaMs.toFixed(1).padStart(6)}   ${(reMs / dfaMs).toFixed(2)}×`);
}

console.log('-'.repeat(78));
console.log(`compiled to DFA: ${compiled} · fell back to regex: ${fellBack} · TOTAL mismatches: ${totalMism}`);
process.exit(totalMism === 0 ? 0 : 1);
