// Which emit targets a gate of `targets: true` (test/check.ts) runs: CHECK_TARGETS=js,ts,go,rust,
// set by `check.ts --changed` when only those targets' code changed (test/gate-deps.ts); unset, all.
// The TypeScript target is the reference some checks compare the others with: a gate keeps running
// it where it does (the portable-targets harness always runs it).
export const CHECK_TARGETS = process.env.CHECK_TARGETS?.split(',');
export const runsTarget = (t: 'js' | 'ts' | 'go' | 'rust'): boolean => !CHECK_TARGETS || CHECK_TARGETS.includes(t);
// The quick tier (`check.ts --quick`): CHECK_QUICK=1 asks a gate for its declared sample.
export const QUICK = process.env.CHECK_QUICK === '1';
// ... and CHECK_QUICK_GO=1 (set when the Go target's own code changed) adds a real grammar's Go parser to it.
export const QUICK_GO = process.env.CHECK_QUICK_GO === '1';
