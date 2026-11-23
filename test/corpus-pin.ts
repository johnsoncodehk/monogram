// The commit test/emit-corpus.ts reads the repository's own sources from (its "PINNED" section says
// why they are pinned), and getting it into a clone that lacks it (CI's shallow checkout).
// The fetch happens ONCE, serially, before any gate runs: in CI's workflow (a step before the
// gates) and in test/check.ts before it starts its pool. A gate never fetches: several gates run at
// once, and two `git fetch`es into one shallow clone race ("fatal: shallow file has changed since we
// read it", CI 45247019068). A gate that finds the commit missing fails with FETCH_HINT.
//   node test/corpus-pin.ts --fetch     fetch the commit if this clone lacks it
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_CORPUS_AT = '7b713ea0555571aa01950592125182c0d5012231';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args: string[]) => execFileSync('git', ['-C', ROOT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
export const FETCH_HINT = `the pinned corpus commit ${REPO_CORPUS_AT} is not in this clone: run \`node test/corpus-pin.ts --fetch\` (test/check.ts does it before the gates start)`;

export function haveCorpusCommit(): boolean {
  try { git(['cat-file', '-e', `${REPO_CORPUS_AT}^{tree}`]); return true; } catch { return false; }
}
/** Fetches the pinned commit when the clone lacks it; throws when it cannot. Call it only while no gate runs. */
export function fetchCorpusCommit(): void {
  if (haveCorpusCommit()) return;
  git(['fetch', '-q', '--depth', '1', 'origin', REPO_CORPUS_AT]);
  if (!haveCorpusCommit()) throw new Error(`git fetch did not bring ${REPO_CORPUS_AT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--fetch')) {
  fetchCorpusCommit();
  console.log(`corpus pin ${REPO_CORPUS_AT.slice(0, 10)}: present`);
}
