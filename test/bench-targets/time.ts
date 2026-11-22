// node time.ts <ts.mts|js.mts> <mode> <file>: one emitted TS-target or JS-target parser timed in a
// fresh process (no JIT state carried between measurements), as go-main.go times the Go target:
// 3 warm-up parses, then parses until at least 1 s and 5 parses; prints "<ms per parse> <parses>".
// Modes. TS target: parse = parse(src); parseWith = parseWith(src, cstBuilder). JS target:
// fresh = createParser().parse(src) per parse; reuse = the module's parse(src), its document reused.
// check = one parse, prints ACCEPT or REJECT.
import { readFileSync } from 'node:fs';
const [mod, mode, file] = process.argv.slice(2);
const m = await import(mod!);
const src = readFileSync(file!, 'utf8');
let sink: unknown;
const once = (): boolean => {
  let r: unknown;
  if (mode === 'parse' || mode === 'check-ts' || mode === 'check-js') r = m.parse(src); // the JS target's module parse is strict (throws on a reject)
  else if (mode === 'parseWith') r = m.parseWith(src, m.cstBuilder);
  else if (mode === 'fresh') r = m.createParser().parse(src); // a total parse: on an accepted input, the strict pass alone
  else if (mode === 'reuse') r = m.parse(src);
  else throw new Error('unknown mode ' + mode);
  sink = r;
  return r !== null && r !== undefined;
};
if (mode!.startsWith('check')) {
  let ok = false;
  try { ok = once(); } catch { ok = false; }
  console.log(ok ? 'ACCEPT' : 'REJECT');
} else {
  for (let i = 0; i < 3; i++) once();
  let n = 0;
  const t0 = performance.now();
  for (;;) {
    once();
    n++;
    if (n >= 5 && performance.now() - t0 >= 1000) break;
  }
  console.log(`${((performance.now() - t0) / n).toFixed(3)} ${n}`);
}
void sink;
