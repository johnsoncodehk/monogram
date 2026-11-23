// node test/emit-sizes.ts [<monogram source tree>=.]: the byte size and a short sha256 of
// emitParser(<grammar>, <target>) (and with each emit option, `<target>+<option>`) for the real grammars typescript, javascript and their element dialects and every emit target that tree exports,
// as one JSON object { "<grammar>": { "<target>": { bytes, sha } } } on stdout. The measurement
// workflow (.github/workflows/measure-profile.yml) runs it on a pull request's merge base and head
// and reports the sizes A / M / delta (test/bench-rust-profile/pr-summary.ts); the sha says whether
// the emitted output is identical, which a size alone does not.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? '.');
const url = (p: string) => pathToFileURL(root + '/' + p).href;
const emit = await import(url('src/emit.ts'));
const TARGETS = ['tsTarget', 'jsTarget', 'goTarget', 'rustTarget'] as const;
const out: Record<string, Record<string, { bytes: number; sha: string }>> = {};
for (const g of ['typescript', 'javascript', 'typescriptreact', 'javascriptreact']) {
  const grammar = (await import(url(g + '.ts'))).default;
  out[g] = {};
  for (const t of TARGETS) {
    if (!emit[t]) continue; // a target this tree does not have yet: absent, not zero
    let s: string;
    // A target this tree's generator refuses the grammar for (the portable targets refused
    // `elements` before a3fb3a9): absent, said on stderr. A grammar the merge base emits and the
    // head refuses is then missing for M, which pr-summary.ts reports as NOT RUN.
    try { s = emit.emitParser(grammar, emit[t]); } catch (e) { console.error(`${g} ${t}: refused (${String(e).split('\n')[0]})`); continue; }
    out[g][t.replace(/Target$/, '')] = { bytes: Buffer.byteLength(s, 'utf8'), sha: createHash('sha256').update(s).digest('hex').slice(0, 12) };
    // The emit option `recovery` (total parsing): the key `<target>+recovery`, for a target of a
    // tree that has it (an older tree ignores the option and emits the default module: no row).
    if (t === 'jsTarget') continue;
    const r = emit.emitParser(grammar, emit[t], { recovery: true });
    if (r === s) continue;
    out[g][t.replace(/Target$/, '') + '+recovery'] = { bytes: Buffer.byteLength(r, 'utf8'), sha: createHash('sha256').update(r).digest('hex').slice(0, 12) };
  }
}
console.log(JSON.stringify(out, null, 1));
