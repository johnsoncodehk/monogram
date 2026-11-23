// Per-run scratch space for gates. Every file a gate writes for itself (an emitted parser it
// imports, a Go module or Rust binary it builds) lives in the directory `scratchDir` returns:
// a fresh `mkdtemp` directory owned by this process alone, removed when the process exits. Two
// runs of the same gate (two worktrees, two people, two agents) therefore never see each
// other's files. Fixed INPUT corpora (/tmp/ts-repo, /tmp/test262, …) are read where CI clones
// them and are not scratch.
//
// Go's build cache (GOCACHE) is what keeps a repeat run warm. Without -trimpath its keys include
// the source directory, so a build in a fresh directory would miss every time; `goBuild` passes
// -trimpath, which keys the cache by content alone. GOCACHE is content-addressed and safe for
// concurrent writers.
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
// Removed on every exit that runs 'exit' handlers (normal end, process.exit, an uncaught throw).
// A gate killed by a signal cannot clean up after itself: a JS signal handler would only run once
// the gate's synchronous work yields, so it would delay the kill instead. So each directory's
// name carries its owner's pid, and the first scratchDir call of every later run removes the
// directories whose owner is no longer running (a Rust or Go build tree is hundreds of MB).
process.on('exit', () => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const OWNED = /^monogram-.+-p(\d+)-[^-]+$/;
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
let swept = false;
function sweepOrphans(): void {
  swept = true;
  for (const n of readdirSync(tmpdir())) {
    const m = OWNED.exec(n);
    if (m && !alive(Number(m[1]))) rmSync(join(tmpdir(), n), { recursive: true, force: true });
  }
}

export function scratchDir(name: string): string {
  if (!swept) sweepOrphans();
  const dir = mkdtempSync(join(tmpdir(), `monogram-${name}-p${process.pid}-`));
  dirs.push(dir);
  return dir;
}

export function goBuild(args: string[], opts: ExecFileSyncOptions = {}): void {
  execFileSync('go', ['build', '-trimpath', ...args], { stdio: 'pipe', ...opts });
}
