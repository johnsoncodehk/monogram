// node allocs.ts <ts.mts|js.mts> <ts-parse|js-fresh> <work dir> <file>...: the allocations of ONE
// parse of the TS target (`parse(src)`) or the emitted JS parser (`createParser().parse(src)`) of
// each file, counted exactly by test/alloc-instrument.ts (the alloc-work gate's instrumentation)
// after one warm parse. Prints "<file> allocs=<n> bytes=<modeled bytes>" per file (the module is
// instrumented once: that is most of the cost). Beside the block counts of blocks.ts it gives
// the profile the cost direction those cannot: block executions see control flow, and on PR #141
// they rose 7-10% while time fell 10-28% and allocations fell 27%.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { instrument } from '../alloc-instrument.ts';

const [mod, mode, dir, ...files] = process.argv.slice(2);
if (!mod || !mode || !dir || files.length === 0) throw new Error('usage: allocs.ts <module> <ts-parse|js-fresh> <work dir> <file>...');
type Alloc = { on: boolean; counts: Map<string, { n: number; bytes: number }>; site: WeakMap<object, number> };
const st: Alloc = { on: false, counts: new Map(), site: new WeakMap() };
(globalThis as any).__alloc = st;
const { code } = instrument(readFileSync(mod, 'utf8'), basename(mod));
mkdirSync(dir, { recursive: true });
const out = join(resolve(dir), basename(mod).replace(/\.mts$/, '') + '.alloc.mjs');
writeFileSync(out, code);
const m = await import(pathToFileURL(out).href);
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const once = () => (mode === 'ts-parse' ? m.parse(src) : mode === 'js-fresh' ? m.createParser().parse(src) : (() => { throw new Error('unknown mode ' + mode); })());
  once(); // what a module builds once (lazy tables) is not per parse
  st.counts = new Map(); st.site = new WeakMap();
  st.on = true;
  once();
  st.on = false;
  let n = 0, bytes = 0;
  for (const v of st.counts.values()) { n += v.n; bytes += v.bytes; }
  console.log(`${basename(file)} allocs=${n} bytes=${bytes}`);
}
