// The emitted-size record (docs/emit-sizes.json): the bytes of emitParser(<grammar>, <target>) for
// the grammars and targets test/emit-sizes.ts measures, as accepted by the last landing that
// re-recorded them. NOT a gate of test/check.ts: the comparison is the measure-profile job's
// (test/bench-rust-profile/pr-summary.ts lists a size more than TOLERANCE away from its record,
// either way, as a regression, on every landing). Run directly, this script fails on the same
// condition, or when a grammar x target is in one and not the other; `--write` re-records, which
// only a landing that changes a size on purpose does.
//
// Why a tolerance and why this one: every landing moves some emitted size, and a check that failed
// on any byte would make every landing re-record, which records nothing. (As a gate even ±0.25%
// made unrelated landings re-record whenever master moved under them: it left check.ts.) Steps that each stay under
// the profile summary's 1% listing added up to +18% in Go in two days (0016998 -> d326d65), seen
// only afterwards. With ±0.25% the record is never more than 0.25% stale: a landing may move a size
// that far unrecorded, and the landing that takes the accumulated drift past it re-records, so the
// acceptance of the growth so far is a diff of this file that its author and the lander see. The
// profile summary prints the drift against the record on every landing (pr-summary.ts).
//
// Shape: { "<grammar>": { "<key>": bytes } }, the key being the target (`ts`, `js`, `go`, `rust`)
// for the default emission, and `<target>+<option>` (options sorted, joined by `+`) for an emission
// with emitParser options set, e.g. `rust+recovery` for `{ recovery: true }`: such a row is added by
// test/emit-sizes.ts printing it, with no change to this file's format or this gate.
//
//   node test/emit-size-record.ts [--write]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TOLERANCE = 0.25; // percent, either way
const RECORD = new URL('../docs/emit-sizes.json', import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const sizes = JSON.parse(execFileSync('node', [fileURLToPath(new URL('./emit-sizes.ts', import.meta.url)), root], { encoding: 'utf8', maxBuffer: 1 << 26 })) as Record<string, Record<string, { bytes: number }>>;
const now: Record<string, Record<string, number>> = {};
for (const [g, ts] of Object.entries(sizes)) { now[g] = {}; for (const [t, v] of Object.entries(ts)) now[g][t] = v.bytes; }

if (process.argv.includes('--write')) {
  writeFileSync(RECORD, JSON.stringify(now, null, 1) + '\n');
  console.log('✓ emit-size-record: docs/emit-sizes.json re-recorded');
  process.exit(0);
}
let rec: Record<string, Record<string, number>> = {};
try { rec = JSON.parse(readFileSync(RECORD, 'utf8')); } catch { /* no record: every size is missing from it */ }
const bad: string[] = [];
let n = 0;
for (const [g, ts] of Object.entries(now)) for (const [t, b] of Object.entries(ts)) {
  n++;
  const r = rec[g]?.[t];
  if (r === undefined) { bad.push(`${g} ${t}: ${b} B, not in the record`); continue; }
  const d = ((b - r) / r) * 100;
  const line = `${g} ${t}: ${r} -> ${b} B (${d >= 0 ? '+' : ''}${d.toFixed(2)}%)`;
  if (Math.abs(d) > TOLERANCE) bad.push(line); else if (b !== r) console.log(`  ${line}, within ±${TOLERANCE}%`);
}
for (const [g, ts] of Object.entries(rec)) for (const t of Object.keys(ts)) if (now[g]?.[t] === undefined) bad.push(`${g} ${t}: in the record, not emitted`);
for (const x of bad) console.log(`  ✗ ${x}`);
if (bad.length) {
  console.error(`\n✗ emit-size-record: ${bad.length} size(s) beyond ±${TOLERANCE}% of docs/emit-sizes.json: re-record with \`node test/emit-size-record.ts --write\` and say why in the message`);
  process.exit(1);
}
console.log(`\n✓ emit-size-record: ${n} emitted sizes within ±${TOLERANCE}% of docs/emit-sizes.json`);
