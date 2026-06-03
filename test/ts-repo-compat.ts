// ─────────────────────────────────────────────────────────────────────────────
//  ts-repo-compat.ts — the REPOSITORY-API match metric. For Monogram's source.ts to be a
//  true repository-level DROP-IN for VS Code's official TypeScript grammar, the official's
//  `repository` KEY NAMES (the public API other grammars `#include` by name —
//  `source.ts#expression`, `source.ts#type`, `source.ts#comment`, …) must also resolve in
//  Monogram's grammar. This bench compares the two `repository` key sets and reports:
//
//    • overall match %  = |Mono ∩ Official| / |Official|  (how much of the official's repo
//      API Monogram exposes by name), the missing-from-Mono list, and the Mono-only keys.
//    • PUBLICLY-EMBEDDED subset — the keys external grammars actually `#include` (grepped from
//      this repo's own `*.tmLanguage.json` + the official Vue grammar). Those are what a
//      drop-in must satisfy; an unresolved `#include` silently no-ops, so a missing public
//      key = a real, visible breakage. Its match % is printed separately and gates exit code.
//
//  Skips gracefully (exit 0) if VS Code's official grammar isn't installed — like
//  highlight-bench / vue-dropin (dev-only). Run: node test/ts-repo-compat.ts
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const VSC = process.env.MONOGRAM_VSCODE_EXT ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions';
const offTsPath = `${VSC}/typescript-basics/syntaxes/TypeScript.tmLanguage.json`;
const monoTsPath = new URL('../typescript.tmLanguage.json', import.meta.url).pathname;

if (!existsSync(offTsPath)) {
  console.log(`⊘ Skipped: VS Code official TS grammar not found at ${offTsPath}`);
  console.log('  (set MONOGRAM_VSCODE_EXT=/path/to/.../extensions). Dev-only, like highlight-bench.');
  process.exit(0);
}

const off = JSON.parse(readFileSync(offTsPath, 'utf-8'));
const mono = JSON.parse(readFileSync(monoTsPath, 'utf-8'));
const offKeys = new Set<string>(Object.keys(off.repository ?? {}));
const monoKeys = new Set<string>(Object.keys(mono.repository ?? {}));

const inter = [...offKeys].filter(k => monoKeys.has(k)).sort();
const missing = [...offKeys].filter(k => !monoKeys.has(k)).sort();
const monoOnly = [...monoKeys].filter(k => !offKeys.has(k)).sort();
const pct = (n: number, d: number) => (d === 0 ? 100 : (100 * n) / d);

// ── Discover the PUBLICLY-EMBEDDED keys: `source.ts#…` / `source.tsx#…` references in this
//    repo's own generated grammars + the official Vue grammar (the real external consumer /
//    drop-in target). These are the keys whose NAME must resolve for embeds to light up. ──
const repoRoot = new URL('..', import.meta.url).pathname;
const refSources: string[] = [];
for (const f of readdirSync(repoRoot)) if (f.endsWith('.tmLanguage.json')) refSources.push(`${repoRoot}${f}`);
const offVue = `${repoRoot}test/fixtures/vue-official/vue.tmLanguage.json`;
if (existsSync(offVue)) refSources.push(offVue);

const publicKeys = new Set<string>();
const refRe = /source\.tsx?#([A-Za-z0-9_-]+)/g;
for (const src of refSources) {
  const text = readFileSync(src, 'utf-8');
  for (const m of text.matchAll(refRe)) publicKeys.add(m[1]);
}
// Keep only public refs that name an OFFICIAL repo key (the API surface that must match);
// a Monogram-internal-only name like `type-inner` isn't part of the official API.
const publicOfficial = [...publicKeys].filter(k => offKeys.has(k)).sort();
const publicMatched = publicOfficial.filter(k => monoKeys.has(k));
const publicMissing = publicOfficial.filter(k => !monoKeys.has(k));
// Public refs that are Monogram-internal (not in the official API) — flagged as a hack to undo.
const publicMonoInternal = [...publicKeys].filter(k => !offKeys.has(k)).sort();

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log('  Monogram source.ts ⇄ official source.ts — REPOSITORY KEY-API match');
console.log('══════════════════════════════════════════════════════════════════════');
console.log(`  official repo keys: ${offKeys.size}   monogram repo keys: ${monoKeys.size}   shared: ${inter.length}`);
console.log(`  OVERALL match: ${pct(inter.length, offKeys.size).toFixed(2)}%  (${inter.length}/${offKeys.size} of the official API exposed by name)`);
console.log('──────────────────────────────────────────────────────────────────────');
console.log(`  PUBLICLY-EMBEDDED subset (keys external grammars #include): ${publicOfficial.length}`);
console.log(`    [${publicOfficial.join(', ')}]`);
console.log(`  PUBLIC match: ${pct(publicMatched.length, publicOfficial.length).toFixed(1)}%  (${publicMatched.length}/${publicOfficial.length})`);
if (publicMissing.length) console.log(`    ✗ public keys MISSING from Monogram: ${publicMissing.join(', ')}`);
else console.log('    ✓ every publicly-embedded official key resolves in Monogram');
if (publicMonoInternal.length) console.log(`    ⚠ embeds still using a Monogram-INTERNAL key (not official API): ${publicMonoInternal.join(', ')}`);
console.log('──────────────────────────────────────────────────────────────────────');
console.log(`  official keys MISSING from Monogram (${missing.length}):`);
console.log('   ', missing.join(', ') || '(none)');
console.log(`  Monogram-only keys (${monoOnly.length}): not part of the official API (internal structure).`);
console.log('══════════════════════════════════════════════════════════════════════');

// Gate on the public subset: those are the keys a drop-in MUST satisfy. (The overall % is a
// reported metric, not a gate — full structural parity isn't the goal; the public API is.)
if (publicMissing.length > 0) {
  console.log(`\n✗ ${publicMissing.length} publicly-embedded official key(s) do not resolve in Monogram — embeds would silently no-op.`);
  process.exit(1);
}
console.log('\n✓ All publicly-embedded official repository keys resolve in Monogram (drop-in safe).');
