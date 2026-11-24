// The EMISSION CACHE: emitParser(grammar, target, opts) kept in test/build-cache.ts's store, keyed
// by the content of every file the emission can read: the grammar module's graph and the target
// module's graph as test/gate-deps.ts derives them (its over-approximation only costs hits), the
// grammar's parts (a text dialect built from parts), the target and the options. A change to one
// printer re-emits that target only; a change to a test re-emits nothing.
//   cachedEmit(grammarFile, target, opts, emit, parts?)   the emitted source
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildAll, buildKey } from './build-cache.ts';
import { edges, ROOT, TARGET_ROOTS } from './gate-deps.ts';

const fileHash = new Map<string, string>();
const hashOf = (f: string) => {
  let h = fileHash.get(f);
  if (h === undefined) fileHash.set(f, (h = createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex')));
  return h;
};
const graphHash = new Map<string, string>();
/** The hash of every file a module's graph reaches (gate-deps edges), memoised per root. */
function hashGraph(root: string): string {
  let g = graphHash.get(root);
  if (g !== undefined) return g;
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) { const f = stack.pop()!; if (seen.has(f)) continue; seen.add(f); stack.push(...edges(f)); }
  const h = createHash('sha256');
  for (const f of [...seen].sort()) h.update(f).update('\0').update(hashOf(f)).update('\0');
  graphHash.set(root, (g = h.digest('hex')));
  return g;
}
const TARGET_FILE: Record<string, string> = { js: TARGET_ROOTS.js!, javascript: TARGET_ROOTS.js!, typescript: TARGET_ROOTS.ts!, ts: TARGET_ROOTS.ts!, go: TARGET_ROOTS.go!, rust: TARGET_ROOTS.rust! };

/**
 * `emit()` through the cache. `grammarFile`: the grammar's module (absolute or repository-relative);
 * `target`: its Target's name (`javascript`, `typescript`, `go`, `rust`); `parts`: whatever else the grammar
 * is built from. Set MONOGRAM_EMIT_CACHE=0 to bypass it.
 */
export function cachedEmit(grammarFile: string, target: string, opts: object, emit: () => string, parts: unknown = null): string {
  const tfile = TARGET_FILE[target];
  if (process.env.MONOGRAM_EMIT_CACHE === '0' || !tfile) return emit();
  const g = grammarFile.startsWith('/') ? relative(ROOT, grammarFile) : grammarFile;
  const key = buildKey('emit', target, JSON.stringify(opts), JSON.stringify(parts), g, hashGraph(g), hashGraph(tfile), hashGraph('src/targets/target.ts'));
  let fresh: string | undefined;
  const [dir] = buildAll([{ key, build: (out) => writeFileSync(join(out, 'src'), (fresh = emit())) }]);
  return fresh ?? readFileSync(join(dir!, 'src'), 'utf8');
}
