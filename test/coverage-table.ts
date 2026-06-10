// coverage-table.ts — regenerate the README per-language alignment tables. Runs each
// src-coverage + scope-gap adapter as a subprocess, parses its ##COV## / ##SCOPEGAP## summary
// line, and writes two tables into the README between <!-- coverage:start --> / <!-- coverage:end -->.
//   node test/coverage-table.ts            # print the tables (don't touch the README)
//   node test/coverage-table.ts --write    # rewrite the README region
// Needs the corpora the adapters use (/tmp/ts-repo, /tmp/test262, /tmp/yaml-test-suite) and a VS
// Code install for the official grammars; an adapter whose inputs are missing renders as "—".
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const WRITE = process.argv.includes('--write');

function runAdapter(script: string, args: string[], marker: string, env?: NodeJS.ProcessEnv): any | null {
  try {
    const out = execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 128 * 1024 * 1024, env: env ?? process.env });
    const line = out.split('\n').find((l) => l.startsWith(marker));
    return line ? JSON.parse(line.slice(marker.length).trim()) : null;
  } catch { return null; }
}

// Both metrics now run through ONE data-driven driver each, parameterised by the `<lang>` code
// (test/scope-gap-run.ts, test/src-coverage-run.ts). TS/JS use deterministic stride subsets for
// speed; the rest run their full corpus.
const COV = [
  { lang: 'TypeScript', script: 'test/src-coverage-run.ts', args: ['ts', '1500'] },
  { lang: 'JavaScript', script: 'test/src-coverage-run.ts', args: ['js', '800'] },
  { lang: 'JSX', script: 'test/src-coverage-run.ts', args: ['jsx'] },
  { lang: 'TSX', script: 'test/src-coverage-run.ts', args: ['tsx'] },
  { lang: 'HTML', script: 'test/src-coverage-run.ts', args: ['html'] },
  { lang: 'YAML', script: 'test/src-coverage-run.ts', args: ['yaml'] },
];
// The 4 TS-family scope-gap entries all read ONE shared env var (MONOGRAM_OFFICIAL_TM) for the
// official grammar, so each needs its OWN grammar mapped in (CI sets MONOGRAM_OFFICIAL_TS/TSX/JS/JSX).
// html/yaml read their own var (MONOGRAM_OFFICIAL_HTML/_YAML), inherited as-is; vue is vendored.
// Absent (local, no env) → the driver's VS Code-install fallback path.
const GAP = [
  { lang: 'TypeScript', script: 'test/scope-gap-run.ts', args: ['ts', '800'], officialEnv: 'MONOGRAM_OFFICIAL_TS' },
  { lang: 'JavaScript', script: 'test/scope-gap-run.ts', args: ['js', '800'], officialEnv: 'MONOGRAM_OFFICIAL_JS' },
  { lang: 'JSX', script: 'test/scope-gap-run.ts', args: ['jsx'], officialEnv: 'MONOGRAM_OFFICIAL_JSX' },
  { lang: 'TSX', script: 'test/scope-gap-run.ts', args: ['tsx'], officialEnv: 'MONOGRAM_OFFICIAL_TSX' },
  { lang: 'HTML', script: 'test/scope-gap-run.ts', args: ['html'] },
  { lang: 'YAML', script: 'test/scope-gap-run.ts', args: ['yaml'] },
  { lang: 'Vue', script: 'test/scope-gap-run.ts', args: ['vue'] },
] as { lang: string; script: string; args: string[]; officialEnv?: string }[];

const pct = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1) + '%');

console.error('Running src-coverage adapters…');
const covRows = COV.map((a) => { console.error('  ' + a.lang); return { lang: a.lang, r: runAdapter(a.script, a.args, '##COV##') }; });
console.error('Running scope-gap adapters…');
const gapRows = GAP.map((a) => {
  console.error('  ' + a.lang);
  // Remap the per-language official grammar onto the adapter's shared MONOGRAM_OFFICIAL_TM
  // (only the TS-family needs it; absent → no override → the adapter's own fallback).
  const src = a.officialEnv ? process.env[a.officialEnv] : undefined;
  const env = src ? { ...process.env, MONOGRAM_OFFICIAL_TM: src } : undefined;
  return { lang: a.lang, r: runAdapter(a.script, a.args, '##SCOPEGAP##', env) };
});

const covBy = new Map(covRows.map((x) => [x.lang, x.r]));
const gapBy = new Map(gapRows.map((x) => [x.lang, x.r]));
const LANGS = ['TypeScript', 'JavaScript', 'JSX', 'TSX', 'HTML', 'YAML', 'Vue'];

let md = '';
// The legend (agree / covered / Highlighter) is hand-written prose in the README, above the
  // markers — this region is DATA only, so the narrative can be reworded without a regen.
  md += '| Grammar | Parser — agree · covered | Highlighter — Monogram vs official |\n|---|---|---|\n';
for (const lang of LANGS) {
  const c = covBy.get(lang), g = gapBy.get(lang);
  const parser = c ? `${pct(c.agreePct)} · ${pct(c.denoms?.[c.denoms.length - 1]?.completeness)}` : '—';
  const hl = g ? `${pct(g.monogramPct)} vs ${pct(g.officialPct)}` : '—';
  md += `| ${lang} | ${parser} | ${hl} |\n`;
}

const block = '<!-- coverage:start -->\n' + md + '<!-- coverage:end -->';
if (!WRITE) { console.log('\n' + md); process.exit(0); }

// Refuse to clobber the committed table with a partial one: a missing corpus or official
// grammar makes an adapter return null → "—". Vue has no parser-axis adapter, so its Parser
// cell is the single allowed gap; every other cell must be present before we overwrite.
const missing: string[] = [];
for (const lang of LANGS) {
  if (!gapBy.get(lang)) missing.push(`${lang} highlighter`);
  if (lang !== 'Vue' && !covBy.get(lang)) missing.push(`${lang} parser`);
}
if (missing.length) {
  console.error('Refusing to write a partial coverage table — missing: ' + missing.join(', '));
  process.exit(1);
}

const README = 'README.md';
let txt = readFileSync(README, 'utf8');
if (!/<!-- coverage:start -->[\s\S]*?<!-- coverage:end -->/.test(txt)) {
  console.error('No <!-- coverage:start/end --> markers in README.md — add them first.');
  process.exit(1);
}

// Refuse to publish a metric COLLAPSE: a harness broken by an internal contract change
// (not a real regression) produces an absurd drop, and the auto-regen workflow would
// commit it silently — the HTML parser axis once sat at 1.2% for two regens because a
// duplicated normalizer kept reading a deleted CST field. Compare each new parser-agree
// value against the committed table; a fall of more than 20 points is treated as a
// broken harness, not a result.
{
  const committed = txt.match(/<!-- coverage:start -->[\s\S]*?<!-- coverage:end -->/)![0];
  const collapsed: string[] = [];
  for (const lang of LANGS) {
    const c = covBy.get(lang);
    if (!c) continue;
    const row = committed.match(new RegExp(`\\|\\s*${lang}\\s*\\|\\s*([\\d.]+)%`));
    if (row && Number(row[1]) - c.agreePct > 20) {
      collapsed.push(`${lang}: ${row[1]}% → ${c.agreePct.toFixed(1)}%`);
    }
  }
  if (collapsed.length) {
    console.error('Refusing to write a collapsed parser-agree value (broken harness, not a result): ' + collapsed.join(', '));
    process.exit(1);
  }
}

txt = txt.replace(/<!-- coverage:start -->[\s\S]*?<!-- coverage:end -->/, () => block);
writeFileSync(README, txt);
console.error('✓ README coverage region updated.');
