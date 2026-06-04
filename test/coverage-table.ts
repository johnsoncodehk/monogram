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

function runAdapter(script: string, args: string[], marker: string): any | null {
  try {
    const out = execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 128 * 1024 * 1024 });
    const line = out.split('\n').find((l) => l.startsWith(marker));
    return line ? JSON.parse(line.slice(marker.length).trim()) : null;
  } catch { return null; }
}

// TS/JS use deterministic stride subsets for speed; the rest run their full corpus.
const COV = [
  { lang: 'TypeScript', script: 'test/src-coverage-ts.ts', args: ['1500'] },
  { lang: 'JavaScript', script: 'test/src-coverage-js.ts', args: ['800'] },
  { lang: 'JSX', script: 'test/src-coverage-jsx.ts', args: [] },
  { lang: 'TSX', script: 'test/src-coverage-tsx.ts', args: [] },
  { lang: 'HTML', script: 'test/src-coverage-html.ts', args: [] },
  { lang: 'YAML', script: 'test/src-coverage-yaml.ts', args: [] },
];
const GAP = [
  { lang: 'TypeScript', script: 'test/scope-gap-ts.ts', args: ['800'] },
  { lang: 'JavaScript', script: 'test/scope-gap-js.ts', args: ['800'] },
  { lang: 'JSX', script: 'test/scope-gap-jsx.ts', args: [] },
  { lang: 'TSX', script: 'test/scope-gap-tsx.ts', args: [] },
  { lang: 'HTML', script: 'test/scope-gap-html.ts', args: [] },
  { lang: 'YAML', script: 'test/scope-gap-yaml.ts', args: [] },
  { lang: 'Vue', script: 'test/scope-gap-vue.ts', args: [] },
];

const pct = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1) + '%');

console.error('Running src-coverage adapters…');
const covRows = COV.map((a) => { console.error('  ' + a.lang); return { lang: a.lang, r: runAdapter(a.script, a.args, '##COV##') }; });
console.error('Running scope-gap adapters…');
const gapRows = GAP.map((a) => { console.error('  ' + a.lang); return { lang: a.lang, r: runAdapter(a.script, a.args, '##SCOPEGAP##') }; });

const covBy = new Map(covRows.map((x) => [x.lang, x.r]));
const gapBy = new Map(gapRows.map((x) => [x.lang, x.r]));
const LANGS = ['TypeScript', 'JavaScript', 'JSX', 'TSX', 'HTML', 'YAML', 'Vue'];

let md = '';
md += "Per-grammar comparison vs the **official parser** as the neutral oracle (`node test/coverage-table.ts --write`).\n\n**Parser** — Monogram's parser vs the official parser (`test/src-coverage.ts`). **agree** is the closeness number: Monogram and the official parser return the same verdict on each corpus file (both accept / both reject; **structural parse-tree equality** for HTML via parse5). **covered** is the share of the official parser's branches the corpus actually exercises — a blind-spot gauge; Monogram's behaviour on the uncovered remainder is untested, so read `agree` as \"on the `covered` portion.\" For the non-HTML grammars `agree` is accept/reject, *not* tree-equality; their parse-**structure** correctness is exercised instead by the **Highlighter** axis below, whose token roles are read off the parse tree. (Each adapter's detailed output also prints a coverage-weighted branch-alignment %, which is more lenient than `agree`.)\n\n**Highlighter** — Monogram's derived TextMate grammar vs the official one, both graded against the parser's token roles (`test/scope-gap.ts`); the [vscode#203212](https://github.com/microsoft/vscode/issues/203212) comparison.\n\n";
md += '| Grammar | Parser — agree · covered | Highlighter — Monogram vs official |\n|---|---|---|\n';
for (const lang of LANGS) {
  const c = covBy.get(lang), g = gapBy.get(lang);
  const parser = c ? `${pct(c.agreePct)} · ${pct(c.denoms?.[c.denoms.length - 1]?.completeness)}` : '—';
  const hl = g ? `${pct(g.monogramPct)} vs ${pct(g.officialPct)}` : '—';
  md += `| ${lang} | ${parser} | ${hl} |\n`;
}

const block = '<!-- coverage:start -->\n' + md + '<!-- coverage:end -->';
if (!WRITE) { console.log('\n' + md); process.exit(0); }

const README = 'README.md';
let txt = readFileSync(README, 'utf8');
if (!/<!-- coverage:start -->[\s\S]*?<!-- coverage:end -->/.test(txt)) {
  console.error('No <!-- coverage:start/end --> markers in README.md — add them first.');
  process.exit(1);
}
txt = txt.replace(/<!-- coverage:start -->[\s\S]*?<!-- coverage:end -->/, () => block);
writeFileSync(README, txt);
console.error('✓ README coverage region updated.');
