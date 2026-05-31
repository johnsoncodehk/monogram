// ─────────────────────────────────────────────────────────────────────────────
//  issue-table.ts — AUTO-GENERATES the README's cross-language ✓ table: for every
//  language, the REAL documented highlighting issues, and whether Monogram's DERIVED
//  grammar and the hand-written OFFICIAL grammar each solve them — so you can see which
//  bugs only the official solved and which only Monogram solved.
//
//  Sources (all side-effect-free DATA modules): issue-cases.ts (TS, microsoft/TypeScript-
//  TmLanguage), html-issue-cases.ts (textmate/html.tmbundle + VS Code), vue-issue-cases.ts
//  (vuejs/language-tools). Official grammars: VS Code's installed TS/JS/HTML + the Vue
//  fixtures (test/fixtures/vue-official). Each language is graded only if its official
//  grammar is present, else skipped (the table keeps the languages it could grade).
//
//  Run:  node test/issue-table.ts            (print only)
//        node test/issue-table.ts --write    (also rewrite the README block)
// ─────────────────────────────────────────────────────────────────────────────
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tests as tsTests } from './issue-cases.ts';
import { cases as htmlCases } from './html-issue-cases.ts';
import { cases as vueCases } from './vue-issue-cases.ts';

const { INITIAL, Registry, parseRawGrammar } = vsctm;
const require = createRequire(import.meta.url);
const wasmBin = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));
const onigLib = Promise.resolve({ createOnigScanner: (p: string[]) => new onig.OnigScanner(p), createOnigString: (s: string) => new onig.OnigString(s) });
const read = (p: string) => readFileSync(p, 'utf-8');
const stub = (sn: string) => parseRawGrammar(JSON.stringify({ scopeName: sn, patterns: [{ match: '[^\\n]+', name: sn }] }), `${sn}.json`);
const VSCODE = '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions';
const official = {
  ts: process.env.MONOGRAM_OFFICIAL_TM ?? `${VSCODE}/typescript-basics/syntaxes/TypeScript.tmLanguage.json`,
  html: process.env.MONOGRAM_OFFICIAL_HTML ?? `${VSCODE}/html/syntaxes/html.tmLanguage.json`,
};
const VUEFIX = 'test/fixtures/vue-official';

function scopeAtFns(grammar: any, src: string) {
  const lines = src.split('\n'); const start: number[] = []; let acc = 0;
  for (const l of lines) { start.push(acc); acc += l.length + 1; }
  const toks: any[][] = []; let st: any = INITIAL;
  for (const l of lines) { const r = grammar.tokenizeLine(l, st); toks.push(r.tokens); st = r.ruleStack; }
  const at = (offset: number) => { let li = 0; while (li + 1 < start.length && start[li + 1] <= offset) li++; const c = offset - start[li]; for (const t of toks[li] ?? []) if (c >= t.startIndex && c < t.endIndex) return t.scopes.join(' '); return ''; };
  return (text: string, nth = 0) => { let i = -1; for (let k = 0; k <= nth; k++) i = src.indexOf(text, i + 1); return i < 0 ? '' : at(i + Math.floor(text.length / 2)); };
}

interface Row { id: string; title: string; mono: boolean; off: boolean }
const idOf = (label: string) => (label.match(/#[\w./-]+/g) ?? [label]).join('/');

// ── TS: tests are {label, input, checks:[{text, scope}]}; pass = every check's scope is produced.
async function gradeTs(): Promise<Row[] | null> {
  if (!existsSync(official.ts)) return null;
  const mk = (path: string) => new Registry({ onigLib, loadGrammar: async (sn) => sn === 'source.ts' ? parseRawGrammar(read(path), 'ts.json') : (sn.startsWith('source.') ? stub(sn) : null) });
  const mono = (await mk('typescript.tmLanguage.json').loadGrammar('source.ts'))!;
  const off = (await mk(official.ts).loadGrammar('source.ts'))!;
  const pass = (g: any, t: typeof tsTests[number]) => { const at = scopeAtFns(g, t.input); return t.checks.every(c => at(c.text).includes(c.scope)); };
  // Ledger = real REPORTED tracker issues (a `#` in the label); the unnumbered cases are
  // Monogram's own coverage cases, not bugs filed against the official — they live in the
  // self-test (test-issues.ts), not here. Dedupe sub-cases by issue: an issue counts as
  // solved only if every one of its checks passes.
  const byId = new Map<string, Row>();
  for (const t of tsTests.filter(t => /#\d/.test(t.label))) {
    const id = idOf(t.label), m = pass(mono, t), o = pass(off, t);
    const prev = byId.get(id);
    if (prev) { prev.mono &&= m; prev.off &&= o; }
    else byId.set(id, { id, title: t.label.replace(/^#[\w./-]+:\s*/, ''), mono: m, off: o });
  }
  return [...byId.values()];
}

// ── HTML: cases are {id, title, src, at, want}; pass = want(scope at the marked span).
async function gradeHtml(): Promise<Row[] | null> {
  if (!existsSync(official.html)) return null;
  const mk = (path: string) => new Registry({ onigLib, loadGrammar: async (sn) => sn === 'text.html.basic' ? parseRawGrammar(read(path), 'html.json') : (sn.startsWith('source.') || sn.startsWith('text.') ? stub(sn) : null) });
  const mono = (await mk('html.tmLanguage.json').loadGrammar('text.html.basic'))!;
  const off = (await mk(official.html).loadGrammar('text.html.basic'))!;
  return htmlCases.map(c => ({ id: c.id, title: c.title, mono: c.want(scopeAtFns(mono, c.src)(c.at, c.nth)), off: c.want(scopeAtFns(off, c.src)(c.at, c.nth)) }));
}

// ── Vue: full stack; cases are {id, title, src, checks:[{at, want}]}.
async function gradeVue(): Promise<Row[] | null> {
  if (!existsSync(`${VUEFIX}/vue.tmLanguage.json`)) return null;
  const mk = (off: boolean) => new Registry({
    onigLib,
    loadGrammar: async (sn) => {
      if (sn === 'text.html.vue') return parseRawGrammar(read(off ? `${VUEFIX}/vue.tmLanguage.json` : 'vue.tmLanguage.json'), 'vue.json');
      if (sn === 'text.html.basic') return parseRawGrammar(read('html.tmLanguage.json'), 'html.json');
      if (sn === 'source.ts') return parseRawGrammar(read('typescript.tmLanguage.json'), 'ts.json');
      if (sn === 'source.js') return parseRawGrammar(read('javascript.tmLanguage.json'), 'js.json');
      if (sn === 'vue.injection') return parseRawGrammar(read('vue.injection.tmLanguage.json'), 'inj.json');
      if (sn === 'vue.directives') return parseRawGrammar(read(`${VUEFIX}/vue-directives.json`), 'dir.json');
      if (sn === 'vue.interpolations') return parseRawGrammar(read(`${VUEFIX}/vue-interpolations.json`), 'int.json');
      if (sn.startsWith('source.')) return stub(sn);
      return null;
    },
    getInjections: (sn) => off ? (sn === 'text.html.vue' ? ['vue.directives', 'vue.interpolations'] : undefined) : ((sn === 'text.html.basic' || sn === 'text.html.vue') ? ['vue.injection'] : undefined),
  });
  const load = async (off: boolean) => { const r = mk(off); if (off) { await r.loadGrammar('vue.directives'); await r.loadGrammar('vue.interpolations'); } else { await r.loadGrammar('vue.injection'); } return (await r.loadGrammar('text.html.vue'))!; };
  const mono = await load(false), off = await load(true);
  const pass = (g: any, c: typeof vueCases[number]) => { const at = scopeAtFns(g, c.src); return c.checks.every(ch => ch.want(at(ch.at, ch.nth))); };
  return vueCases.map(c => ({ id: c.id, title: c.title, mono: pass(mono, c), off: pass(off, c) }));
}

const langs: { name: string; key: string; opponent: string; rows: Row[] | null }[] = [
  { name: 'TypeScript', key: 'ts', opponent: 'microsoft/TypeScript-TmLanguage', rows: await gradeTs() },
  { name: 'HTML', key: 'html', opponent: "VS Code's html.tmLanguage", rows: await gradeHtml() },
  { name: 'Vue', key: 'vue', opponent: 'vuejs/language-tools vue.tmLanguage.json', rows: await gradeVue() },
];

// ── render ──
const mark = (b: boolean) => b ? '✓' : '·';
// Link each tracker id to its issue. ids look like `#1050`, `tmbundle#118`, `vscode#140360`,
// or `#6007/#2096/#520`; the prefix (or the language) selects the repo.
const REPO: Record<string, string> = { ts: 'microsoft/TypeScript-TmLanguage', html: 'textmate/html.tmbundle', vue: 'vuejs/language-tools' };
const PREFIX: Record<string, string> = { tmbundle: 'textmate/html.tmbundle', vscode: 'microsoft/vscode' };
const linkify = (id: string, key: string) => id.replace(/([a-z]+)?#(\d+)/g, (_m, pfx, num) => `[${pfx ?? ''}#${num}](https://github.com/${(pfx && PREFIX[pfx]) || REPO[key]}/issues/${num})`);
const graded = langs.filter(l => l.rows) as { name: string; key: string; opponent: string; rows: Row[] }[];
let md = '_Real bugs reported against each hand-written **official** grammar — does Monogram\'s **derived** grammar solve them? Both grammars current; graded against the documented-correct scope. Auto-generated by `npm run bench:issues`._\n\n';
// summary table — the at-a-glance overview; the four buckets (only-Mono, only-official,
// both solve, both miss) sum to the issue count, so "both have the bug" is counted too.
md += '| language | vs hand-written grammar | Monogram | official | only Monogram | only official | both solve | both miss |\n';
md += '|---|---|:--:|:--:|:--:|:--:|:--:|:--:|\n';
for (const { name, opponent, rows } of graded) {
  const om = rows.filter(r => r.mono && !r.off).length, oo = rows.filter(r => !r.mono && r.off).length;
  const bs = rows.filter(r => r.mono && r.off).length, bm = rows.filter(r => !r.mono && !r.off).length;
  md += `| ${name} | ${opponent} | **${rows.filter(r => r.mono).length}/${rows.length}** | ${rows.filter(r => r.off).length}/${rows.length} | ${om} | ${oo} | ${bs} | ${bm} |\n`;
}
for (const l of langs) if (!l.rows) md += `| ${l.name} | — | _skipped (no official grammar)_ |  |  |  |  |  |\n`;
// per-language detail — a full ✓ table for every language, ids linked to their trackers,
// asymmetries (only-Monogram / only-official / both-miss) listed before the both-solve rows.
for (const { name, key, rows } of graded) {
  const tag = (r: Row) => r.mono && !r.off ? ' **(only Monogram)**' : (!r.mono && r.off ? ' **(only official)**' : (!r.mono && !r.off ? ' _(both miss)_' : ''));
  const order = [...rows.filter(r => r.mono && !r.off), ...rows.filter(r => !r.mono && r.off), ...rows.filter(r => !r.mono && !r.off), ...rows.filter(r => r.mono && r.off)];
  md += `\n#### ${name}\n| issue | Monogram | official |\n|---|:--:|:--:|\n`;
  for (const r of order) md += `| ${linkify(r.id, key)} — ${r.title}${tag(r)} | ${mark(r.mono)} | ${mark(r.off)} |\n`;
}

// console summary
console.log('\n══════════ cross-language documented-issue scorecard ══════════');
for (const { name, rows } of langs) {
  if (!rows) { console.log(`  ${name.padEnd(12)} (skipped — no official grammar)`); continue; }
  const om = rows.filter(r => r.mono && !r.off).length, oo = rows.filter(r => !r.mono && r.off).length, bm = rows.filter(r => !r.mono && !r.off).length;
  console.log(`  ${name.padEnd(12)} Monogram ${rows.filter(r => r.mono).length}/${rows.length} · official ${rows.filter(r => r.off).length}/${rows.length}   (only-Monogram ${om}, only-official ${oo}, both-miss ${bm})`);
}

if (process.argv.includes('--write')) {
  const START = '<!-- issues:start -->', END = '<!-- issues:end -->';
  const note = '<!-- generated by `npm run bench:issues` — do not edit by hand -->';
  const readme = read('README.md');
  if (!readme.includes(START) || !readme.includes(END)) { console.log(`\n✗ README.md is missing the ${START} … ${END} markers — add them where the table should go.`); process.exit(1); }
  const block = `${START}\n${note}\n${md}${END}`;
  const out = readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
  writeFileSync('README.md', out);
  console.log('\n✓ Wrote the cross-language issue table into README.md');
} else {
  console.log('\n(run with --write to update README.md)');
}
