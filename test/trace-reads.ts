// Preloaded into a gate by check.ts when CHECK_TRACE=<file> is set (CI): records every repository
// file the gate's process loads as a module or opens with node:fs, and writes the list to that
// file at exit. check.ts then fails when a traced file is not among the inputs test/gate-deps.ts
// derives for the gate: the check that keeps `check.ts --changed` from skipping an affected gate.
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, relative, sep } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = process.env.CHECK_TRACE!;
const seen = new Set<string>();
const isFile = fs.statSync;
const note = (p: unknown) => {
  let s = typeof p === 'string' ? p : p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString() : null;
  if (s === null) return;
  if (s.startsWith('file:')) s = fileURLToPath(s);
  const r = relative(ROOT, resolve(s));
  if (r.startsWith('..') || r.startsWith('node_modules') || r.startsWith('.git')) return;
  seen.add(r.split(sep).join('/'));
};
registerHooks({
  load(url, context, next) { if (url.startsWith('file:')) note(url); return next(url, context); },
});
for (const name of ['readFileSync', 'openSync', 'readdirSync', 'existsSync', 'statSync', 'createReadStream'] as const) {
  const orig = (fs as Record<string, unknown>)[name] as (...a: unknown[]) => unknown;
  (fs as Record<string, unknown>)[name] = function (this: unknown, p: unknown, ...a: unknown[]) { note(p); return orig.call(this, p, ...a); };
}
syncBuiltinESMExports();
const origRead = fs.promises.readFile;
fs.promises.readFile = function (p: unknown, ...a: unknown[]) { note(p); return (origRead as (...x: unknown[]) => unknown).call(fs.promises, p, ...a); } as typeof fs.promises.readFile;
process.on('exit', () => { try { fs.writeFileSync(out, [...seen].filter((f) => { try { return isFile(resolve(ROOT, f)).isFile(); } catch { return false; } }).sort().join('\n')); } catch { /* the gate's own exit status stands */ } });
