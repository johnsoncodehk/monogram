// ─────────────────────────────────────────────────────────────────────────────
//  repo-compat.ts — the REPOSITORY-API match metric for EVERY derived grammar. For a
//  Monogram grammar to be a repository-level DROP-IN for VS Code's official one, the
//  official's `repository` KEY NAMES — the public API other grammars `#include` by name
//  (`source.ts#type`, `source.js#qstring-double`, `text.html.basic#tag`, …) — must also
//  resolve in Monogram's grammar. The `canonicalRepoNames` 限制器 (see typescript.ts /
//  javascript.ts / html.ts) makes gen-tm emit those official names NATIVELY for every
//  construct Monogram genuinely has. This bench reports, per grammar:
//
//    • OVERALL match %  = |Mono ∩ Official| / |Official|  — how much of the official repo
//      API Monogram exposes by name. NOT a gate (full structural parity isn't the goal —
//      Monogram doesn't model every official sub-rule; we align where a construct
//      corresponds, we don't chase keys for constructs Monogram lacks).
//    • PUBLICLY-#INCLUDE'd subset — the keys some grammar in the corpus actually references
//      (`<scope>#<key>` grepped from this repo's own *.tmLanguage.json + the official Vue
//      grammar). A drop-in MUST satisfy these — an unresolved `#include` silently no-ops —
//      so this subset GATES the exit code.
//
//  Pass an optional grammar name to scope the run (`node test/repo-compat.ts javascript`).
//  Skips gracefully (exit 0) if VS Code's official grammars aren't installed (dev-only,
//  like the scope-gap benches / vue-dropin). Run: node test/repo-compat.ts
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const VSC = process.env.MONOGRAM_VSCODE_EXT ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions';
const repoRoot = new URL('..', import.meta.url).pathname;

// Each derived grammar ⇄ its official counterpart + the scopeName external grammars #include it by.
const GRAMMARS = [
  { name: 'typescript',      mono: 'typescript.tmLanguage.json',      off: `${VSC}/typescript-basics/syntaxes/TypeScript.tmLanguage.json`,      scope: 'source.ts' },
  { name: 'javascript',      mono: 'javascript.tmLanguage.json',      off: `${VSC}/javascript/syntaxes/JavaScript.tmLanguage.json`,            scope: 'source.js' },
  { name: 'javascriptreact', mono: 'javascriptreact.tmLanguage.json', off: `${VSC}/javascript/syntaxes/JavaScriptReact.tmLanguage.json`,       scope: 'source.js.jsx' },
  { name: 'typescriptreact', mono: 'typescriptreact.tmLanguage.json', off: `${VSC}/typescript-basics/syntaxes/TypeScriptReact.tmLanguage.json`, scope: 'source.tsx' },
  { name: 'html',            mono: 'html.tmLanguage.json',            off: `${VSC}/html/syntaxes/html.tmLanguage.json`,                       scope: 'text.html.basic' },
];

const only = process.argv[2];                       // optional: run just one grammar
const pct = (n: number, d: number) => (d === 0 ? 100 : (100 * n) / d);

// The corpus of `#include` references: this repo's generated grammars + the official Vue grammar
// (the real external consumer). We scan it once and, per grammar, pick out `<scope>#<key>` refs.
const refTexts: string[] = [];
for (const f of readdirSync(repoRoot)) if (f.endsWith('.tmLanguage.json')) refTexts.push(readFileSync(`${repoRoot}${f}`, 'utf-8'));
const corpus = refTexts.join('\n');

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log('  Monogram ⇄ official — REPOSITORY KEY-API match, per derived grammar');
console.log('══════════════════════════════════════════════════════════════════════');

let anyRun = false, anyFail = false;
for (const g of GRAMMARS) {
  if (only && g.name !== only) continue;
  if (!existsSync(g.off)) { console.log(`  ⊘ ${g.name}: official grammar not found (${g.off})`); continue; }
  anyRun = true;

  const off = JSON.parse(readFileSync(g.off, 'utf-8'));
  const mono = JSON.parse(readFileSync(`${repoRoot}${g.mono}`, 'utf-8'));
  const offK = new Set<string>(Object.keys(off.repository ?? {}));
  const monoK = new Set<string>(Object.keys(mono.repository ?? {}));
  const inter = [...offK].filter(k => monoK.has(k));
  const missing = [...offK].filter(k => !monoK.has(k)).sort();

  // Publicly-#include'd subset for THIS grammar's scope.
  const refRe = new RegExp(g.scope.replace(/\./g, '\\.') + '#([A-Za-z0-9_-]+)', 'g');
  const refs = new Set<string>();
  for (const m of corpus.matchAll(refRe)) refs.add(m[1]);
  const pubOfficial = [...refs].filter(k => offK.has(k)).sort();
  const pubMissing = pubOfficial.filter(k => !monoK.has(k));
  const pubInternal = [...refs].filter(k => !offK.has(k)).sort();   // refs to a Mono-internal name = a hack to undo

  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${g.name}  (official ${offK.size} keys · monogram ${monoK.size} keys)`);
  console.log(`    OVERALL match: ${pct(inter.length, offK.size).toFixed(1)}%  (${inter.length}/${offK.size})`);
  if (pubOfficial.length) {
    console.log(`    public (#include'd): ${pubOfficial.length} [${pubOfficial.join(', ')}] — match ${pubOfficial.length - pubMissing.length}/${pubOfficial.length}`);
  } else {
    console.log('    public (#include\'d): none in the corpus');
  }
  if (pubMissing.length) { console.log(`    ✗ public keys MISSING from Monogram: ${pubMissing.join(', ')}`); anyFail = true; }
  if (pubInternal.length) console.log(`    ⚠ ref still using a Monogram-INTERNAL key (not official API): ${pubInternal.join(', ')}`);
  if (missing.length && only) console.log(`    official keys missing from Monogram (${missing.length}): ${missing.join(', ')}`);
}

console.log('══════════════════════════════════════════════════════════════════════');
if (!anyRun) {
  console.log('  ⊘ Skipped: no official grammars found (set MONOGRAM_VSCODE_EXT=/path/to/.../extensions). Dev-only.');
  process.exit(0);
}
if (anyFail) {
  console.log('\n✗ Some publicly-#included official key(s) do not resolve in Monogram — those embeds would silently no-op.');
  process.exit(1);
}
console.log('\n✓ Every publicly-#included official repository key resolves in Monogram (drop-in safe).');
