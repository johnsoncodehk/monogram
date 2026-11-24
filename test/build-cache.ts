// The content-keyed BUILD CACHE of the Go and Rust gates: a build's outputs, stored under the
// sha-256 of everything the build reads (its sources, its command, the toolchain), so a build whose
// inputs did not change is a copy, in this run and every later one, in any gate and any worktree.
//   buildAll(builds)                 the portable-targets harness: an entry per (grammar, target)
//   cachedGoBuild(args, { cwd })     a drop-in for scratch.ts's goBuild: keyed by the .go / go.mod
//                                    files under cwd (or the .go files named) and the arguments
//   cachedRustc(args, { cwd })       a drop-in for execFileSync('rustc', args): keyed by the .rs
//                                    files beside the crate root and the rlibs it links
// A gate that builds through one of these needs no Go / Rust compile when nothing it builds changed.
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { goBuild } from './scratch.ts';

// ── The build cache ──
// One directory per entry under `<tmpdir>/monogram-build-cache/`, named by the sha-256 of the
// build's inputs; an entry holds only its outputs and is complete once its `ok` marker exists
// (an entry is built in a private directory and renamed into place, so a reader never sees half
// of one). Lifetime: content-addressed entries are never stale, only unused, so every use touches
// the marker, and the first cache access of a process removes the entries no process has used for
// CACHE_TTL_H hours, then the least recently used ones while the cache is above CACHE_MAX_MB.
// A lock (`<key>.lock`, a directory holding the owner's pid) belongs to a running process; one
// whose owner is gone is taken over.
const CACHE = join(tmpdir(), 'monogram-build-cache');
const CACHE_TTL_H = 24, CACHE_MAX_MB = 3072;
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let cacheSwept = false;
function sweepCache(): void {
  cacheSwept = true;
  mkdirSync(CACHE, { recursive: true });
  const now = Date.now();
  const entries: { dir: string; used: number; bytes: number }[] = [];
  for (const n of readdirSync(CACHE)) {
    const dir = join(CACHE, n);
    if (n.endsWith('.lock') || n.includes('.tmp-')) {
      const pid = Number((n.endsWith('.lock') ? safeRead(join(dir, 'pid')) : n.split('.tmp-')[1]) ?? NaN);
      if (Number.isFinite(pid) && !alive(pid)) rmSync(dir, { recursive: true, force: true });
      continue;
    }
    let used: number, bytes = 0;
    try { used = statSync(join(dir, 'ok')).mtimeMs; for (const f of readdirSync(dir)) bytes += statSync(join(dir, f)).size; } catch { rmSync(dir, { recursive: true, force: true }); continue; }
    entries.push({ dir, used, bytes });
  }
  entries.sort((a, b) => a.used - b.used);
  let total = entries.reduce((s, e) => s + e.bytes, 0);
  for (const e of entries) {
    if (now - e.used < CACHE_TTL_H * 3600e3 && total < CACHE_MAX_MB * 1048576) break;
    rmSync(e.dir, { recursive: true, force: true });
    total -= e.bytes;
  }
}
function safeRead(f: string): string | undefined { try { return readFileSync(f, 'utf8'); } catch { return undefined; } }

/** A build: its inputs (hashed into the key) and the function that builds `outputs` into a directory. */
export type Build = { key: string; build: (dir: string) => void };
export const buildKey = (...parts: string[]): string => {
  const h = createHash('sha256');
  for (const p of parts) h.update(String(p.length)).update(':').update(p);
  return h.digest('hex').slice(0, 40);
};
function tryBuild(b: Build): 'done' | 'busy' {
  if (!cacheSwept) sweepCache();
  const dir = join(CACHE, b.key);
  if (existsSync(join(dir, 'ok'))) { const t = new Date(); utimesSync(join(dir, 'ok'), t, t); return 'done'; }
  const lock = `${dir}.lock`;
  try { mkdirSync(lock); } catch {
    const pid = Number(safeRead(join(lock, 'pid')) ?? NaN);
    // a lock without its pid file yet is being taken right now; one whose owner died is free
    if (!Number.isFinite(pid) || alive(pid)) return 'busy';
    rmSync(lock, { recursive: true, force: true });
    return tryBuild(b);
  }
  writeFileSync(join(lock, 'pid'), String(process.pid));
  try {
    if (!existsSync(join(dir, 'ok'))) {
      const tmp = `${dir}.tmp-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      b.build(tmp);
      writeFileSync(join(tmp, 'ok'), '');
      renameSync(tmp, dir);
    }
  } finally { rmSync(lock, { recursive: true, force: true }); }
  return 'done';
}
/** Builds (or finds) every entry, taking first the ones no other process is building; returns their directories. */
export function buildAll(builds: Build[]): string[] {
  let pending = builds.filter((b) => tryBuild(b) === 'busy');
  while (pending.length) { sleepMs(250); pending = pending.filter((b) => tryBuild(b) === 'busy'); }
  return builds.map((b) => join(CACHE, b.key));
}

const toolVersion = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }); } catch { return ''; } };
export const GO_VERSION = toolVersion('go', ['version']), RUSTC_VERSION = toolVersion('rustc', ['-vV']);
// The Rust build reads the wrapper or toolchain `rustc` resolves to: its path is part of the key.
export const RUSTC_PATH = toolVersion('sh', ['-c', 'command -v rustc']);

/** rustc's lint flags for every emitted Rust parser a gate compiles: anything unused is an error
 * (the `unused` group: dead code, unused variables / assignments / mut, unreachable code ...).
 * Allowed and owed: the two style lints of the group, unused_parens and unused_braces (the printer
 * still writes redundant parentheses and braces). */
export const RUSTC_LINTS = ['-D', 'unused', '-A', 'unused_parens', '-A', 'unused_braces'];

/** rustc flags that make its output independent of the build's directories (see below). */
export const RUSTC_PATH_FLAGS = (...dirs: string[]): string[] => [...new Set(dirs)].map((d) => `--remap-path-prefix=${d}=.`);

// ── Drop-ins for a gate's own `go build` / `rustc` ──
// The key holds every input file's path RELATIVE to the build's directory (Go: its cwd; Rust: the
// directory of its crate root, which a gate often names by an absolute path from the repository
// root) and its content, and the arguments with each path made relative the same way (a gate builds
// in a fresh scratch directory each run: an absolute path in the key would miss every time). So that
// a hit is byte-for-byte the binary a cold build in the hit's own directory makes, the output must
// not depend on that directory: Go builds with -trimpath (scratch.ts's goBuild), Rust with
// --remap-path-prefix=<dir>=. (RUSTC_PATH_FLAGS; panic locations name the file relative to it). The outputs (`-o <path>`, a lib
// crate's lib<name>.rlib) are stored by name and copied back on a hit. A rlib is an input of the
// crate that links it by its bytes, so a rebuilt rlib with the same bytes keeps the consumer's key.
const sourcesUnder = (dir: string, keep: (f: string) => boolean): string[] => {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (keep(e.name)) out.push(p); } };
  walk(dir);
  return out;
};
function cached(tool: string, args: string[], cwd: string, base: string, inputs: string[], outputs: string[], run: () => void): void {
  const rel = (p: string) => relative(base, resolve(cwd, p));
  const key = buildKey(tool, tool === 'go' ? GO_VERSION : RUSTC_VERSION + RUSTC_PATH, ...args.map((a) => (a.startsWith('/') ? rel(a) : a)),
    ...inputs.flatMap((f) => [rel(f), readFileSync(f).toString('base64')]));
  let built = false;
  const [dir] = buildAll([{ key, build: (out) => {
    run();
    built = true;
    for (const o of outputs) copyFileSync(resolve(cwd, o), join(out, basename(o)));
  } }]);
  if (built) return; // built in place by this call
  for (const o of outputs) {
    const to = resolve(cwd, o);
    rmSync(to, { force: true });
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(dir!, basename(o)), to);
    chmodSync(to, 0o755);
  }
}
const outputOf = (args: string[]): string[] => { const i = args.indexOf('-o'); return i >= 0 ? [args[i + 1]!] : []; };
/** scratch.ts's goBuild through the cache: the inputs are the .go files named, else every .go / go.mod / go.sum under cwd. */
export function cachedGoBuild(args: string[], opts: ExecFileSyncOptions = {}): void {
  const cwd = String(opts.cwd ?? process.cwd());
  const named = args.filter((a) => a.endsWith('.go')).map((a) => resolve(cwd, a));
  const inputs = named.length ? named : sourcesUnder(cwd, (f) => f.endsWith('.go') || f === 'go.mod' || f === 'go.sum');
  const outputs = outputOf(args);
  if (!outputs.length) throw new Error('cachedGoBuild: the build names no -o output');
  cached('go', args, cwd, cwd, inputs, outputs, () => goBuild(args, opts));
}
/** execFileSync('rustc', args, opts) through the cache: the inputs are the .rs files beside each .rs argument and the rlibs of --extern. */
export function cachedRustc(args: string[], opts: ExecFileSyncOptions = {}): void {
  const cwd = String(opts.cwd ?? process.cwd());
  const roots = args.filter((a) => a.endsWith('.rs')).map((a) => resolve(cwd, a));
  const externs = args.flatMap((a, i) => (args[i - 1] === '--extern' && a.includes('=') ? [resolve(cwd, a.split('=')[1]!)] : []));
  const beside = (r: string) => sourcesUnder(dirname(r), (f) => f.endsWith('.rs')).filter((f) => dirname(f) === dirname(r));
  const inputs = [...new Set([...roots.flatMap(beside), ...externs])];
  const lib = args.includes('--crate-type') && args[args.indexOf('--crate-type') + 1] === 'lib';
  const outputs = outputOf(args).length ? outputOf(args) : lib ? [`lib${args[args.indexOf('--crate-name') + 1]}.rlib`] : [];
  if (!outputs.length) throw new Error('cachedRustc: the build names no output');
  const base = roots.length ? dirname(roots[0]!) : cwd;
  cached('rustc', args, cwd, base, inputs, outputs, () => { execFileSync('rustc', [...RUSTC_PATH_FLAGS(base, cwd), ...args], { stdio: 'pipe', ...opts }); });
}

