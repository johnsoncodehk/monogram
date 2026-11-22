// node synth2mb.ts <out>: the 2 MB synthetic TypeScript file used for earlier Rust timings
// (docs/TYPED-BACKEND.md "2MB bench"; tok2mb.ts in PR #78's Linux package): an 8-line unit
// repeated 9,616 times = 2,000,128 bytes, sha256 297997ed...1866.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const unit = [
  'const a: number = 1;',
  'function f<T>(x: T): T { return x; }',
  'class C { m() { return 1; } }',
  'type U = A | B;',
  'const g = (x: number) => x + 1;',
  'if (a) b(); else c();',
  'for (const k of xs) { y(k); }',
  'const t = `a${b}c`;',
].join('\n') + '\n';
const src = unit.repeat(9616);
const sha = createHash('sha256').update(src).digest('hex');
if (sha !== '297997edb2c33a9f6d5491ef8ed3e5ec6e8b3e17efc86e71b3f4a0d7cdc81866') throw new Error('synth2mb sha mismatch: ' + sha);
writeFileSync(process.argv[2], src);
