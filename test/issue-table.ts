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
import { cases as tsxCases } from './tsx-issue-cases.ts';
import { cases as htmlCases } from './html-issue-cases.ts';
import { cases as vueCases } from './vue-issue-cases.ts';
import { scopeLookup as vueScopeLookup, officialAvailable as vueOfficialAvailable } from './vue-grammar-harness.ts';

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
  tsx: process.env.MONOGRAM_OFFICIAL_TSX ?? `${VSCODE}/typescript-basics/syntaxes/TypeScriptReact.tmLanguage.json`,
  html: process.env.MONOGRAM_OFFICIAL_HTML ?? `${VSCODE}/html/syntaxes/html.tmLanguage.json`,
  js: process.env.MONOGRAM_OFFICIAL_JS ?? `${VSCODE}/javascript/syntaxes/JavaScript.tmLanguage.json`,
  css: process.env.MONOGRAM_OFFICIAL_CSS ?? `${VSCODE}/css/syntaxes/css.tmLanguage.json`,
};

function scopeAtFns(grammar: any, src: string) {
  const lines = src.split('\n'); const start: number[] = []; let acc = 0;
  for (const l of lines) { start.push(acc); acc += l.length + 1; }
  const toks: any[][] = []; let st: any = INITIAL;
  for (const l of lines) { const r = grammar.tokenizeLine(l, st); toks.push(r.tokens); st = r.ruleStack; }
  const at = (offset: number) => { let li = 0; while (li + 1 < start.length && start[li + 1] <= offset) li++; const c = offset - start[li]; for (const t of toks[li] ?? []) if (c >= t.startIndex && c < t.endIndex) return t.scopes.join(' '); return ''; };
  const find = (text: string, nth = 0) => { let i = -1; for (let k = 0; k <= nth; k++) i = src.indexOf(text, i + 1); return i < 0 ? '' : at(i + Math.floor(text.length / 2)); };
  return Object.assign(find, { at }); // .at(offset) lets gradeTs walk checks from a running position
}

interface Row { id: string; title: string; mono: boolean; off: boolean }
const idOf = (label: string) => (label.match(/#[\w./-]+/g) ?? [label]).join('/');

// ── TS: tests are {label, input, checks:[{text, scope}]}; pass = every check's scope is produced.
async function gradeTs(): Promise<Row[] | null> {
  if (!existsSync(official.ts)) return null;
  const mk = (path: string) => new Registry({ onigLib, loadGrammar: async (sn) => sn === 'source.ts' ? parseRawGrammar(read(path), 'ts.json') : (sn.startsWith('source.') ? stub(sn) : null) });
  const mono = (await mk('typescript.tmLanguage.json').loadGrammar('source.ts'))!;
  const off = (await mk(official.ts).loadGrammar('source.ts'))!;
  // Grade checks SEQUENTIALLY: find each check's text from the end of the previous match, then read
  // the scope at the span midpoint. The running start position is what makes repeated tokens and
  // sub-token substrings resolve to the intended span — the two `from`s of `import from from "m"`
  // (#891) and the `y` that also hides inside `typeof` (#1050). A plain indexOf-from-0 collapsed
  // both checks onto the first occurrence and mis-graded these as unsolved even though the grammar
  // tokenizes them correctly (test/test-issues.ts confirms). Midpoint (rather than whole-token)
  // keeps whole-line span checks like #1066's `/// <reference … />` passing for the official
  // grammar, which splits that directive into sub-tokens.
  const pass = (g: any, t: typeof tsTests[number]) => {
    const f = scopeAtFns(g, t.input); let pos = 0;
    for (const c of t.checks) {
      const idx = t.input.indexOf(c.text, pos);
      if (idx < 0 || !f.at(idx + Math.floor(c.text.length / 2)).includes(c.scope)) return false;
      pos = idx + c.text.length;
    }
    return true;
  };
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

// ── TSX: cases are {id, title, src, checks:[{at, want}]} (predicate-based, like Vue). Monogram's
// typescriptreact (source.tsx) vs the official TypeScriptReact, both self-contained .tsx grammars.
async function gradeTsx(): Promise<Row[] | null> {
  if (!existsSync(official.tsx)) return null;
  const mk = (path: string) => new Registry({ onigLib, loadGrammar: async (sn) => sn === 'source.tsx' ? parseRawGrammar(read(path), 'tsx.json') : (sn.startsWith('source.') ? stub(sn) : null) });
  const mono = (await mk('typescriptreact.tmLanguage.json').loadGrammar('source.tsx'))!;
  const off = (await mk(official.tsx).loadGrammar('source.tsx'))!;
  const pass = (g: any, c: typeof tsxCases[number]) => { const at = scopeAtFns(g, c.src); return c.checks.every(ch => ch.want(at(ch.at, ch.nth))); };
  return tsxCases.map(c => ({ id: c.id, title: c.title, mono: pass(mono, c), off: pass(off, c) }));
}

// ── HTML: cases are {id, title, src, at, want}; pass = want(scope at the marked span).
async function gradeHtml(): Promise<Row[] | null> {
  if (!existsSync(official.html)) return null;
  // Grade against the REAL embedded grammars (JS, CSS) so a ✓ means the span is *correctly*
  // highlighted, not merely delegated — a stub hides embedded bugs (e.g. #113: `//` inside an
  // onclick JS string read as a comment). Monogram's html.ts embeds nothing in attributes, so
  // these embeds are reached only for the official.
  const mkReg = (htmlPath: string, embeds: Record<string, string>) => new Registry({ onigLib, loadGrammar: async (sn) =>
    sn === 'text.html.basic' ? parseRawGrammar(read(htmlPath), 'html.json') :
    (embeds[sn] && existsSync(embeds[sn])) ? parseRawGrammar(read(embeds[sn]), `${sn}.json`) :
    (sn.startsWith('source.') || sn.startsWith('text.')) ? stub(sn) : null });
  const mono = (await mkReg('html.tmLanguage.json', { 'source.js': 'javascript.tmLanguage.json', 'source.css': official.css }).loadGrammar('text.html.basic'))!;
  const off = (await mkReg(official.html, { 'source.js': official.js, 'source.css': official.css }).loadGrammar('text.html.basic'))!;
  return htmlCases.map(c => ({ id: c.id, title: c.title, mono: c.want(scopeAtFns(mono, c.src)(c.at, c.nth)), off: c.want(scopeAtFns(off, c.src)(c.at, c.nth)) }));
}

// ── Vue: full stack; cases are {id, title, src, checks:[{at, want}]}. Tokenized through
// vscode-tmlanguage-snapshot (vuejs/language-tools' own tool) — see vue-grammar-harness.ts —
// the SAME engine as test/vue-issues.ts, so the README table and the bench can't drift.
async function gradeVue(): Promise<Row[] | null> {
  if (!vueOfficialAvailable) return null;
  const makeAt = (look: (o: number) => string[], src: string) => (text: string, nth = 0) => {
    let i = -1; for (let k = 0; k <= nth; k++) i = src.indexOf(text, i + 1);
    return i < 0 ? '' : look(i + Math.floor(text.length / 2)).join(' ');
  };
  const rows: Row[] = [];
  for (const c of vueCases) {
    const mAt = makeAt(await vueScopeLookup('mono', c.src), c.src), oAt = makeAt(await vueScopeLookup('off', c.src), c.src);
    rows.push({ id: c.id, title: c.title, mono: c.checks.every(ch => ch.want(mAt(ch.at, ch.nth))), off: c.checks.every(ch => ch.want(oAt(ch.at, ch.nth))) });
  }
  return rows;
}

const langs: { name: string; key: string; opponent: string; rows: Row[] | null }[] = [
  { name: 'TypeScript', key: 'ts', opponent: 'microsoft/TypeScript-TmLanguage', rows: await gradeTs() },
  { name: 'TSX', key: 'tsx', opponent: 'microsoft/TypeScript-TmLanguage (TypeScriptReact)', rows: await gradeTsx() },
  { name: 'HTML', key: 'html', opponent: "VS Code's html.tmLanguage", rows: await gradeHtml() },
  { name: 'Vue', key: 'vue', opponent: 'vuejs/language-tools vue.tmLanguage.json', rows: await gradeVue() },
];

// ── render ──
const mark = (b: boolean) => b ? '✓' : '·';
// Link each tracker id to its issue. ids look like `#1050`, `tmbundle#118`, `vscode#140360`,
// or `#6007/#2096/#520`; the prefix (or the language) selects the repo.
const REPO: Record<string, string> = { ts: 'microsoft/TypeScript-TmLanguage', tsx: 'microsoft/TypeScript-TmLanguage', html: 'textmate/html.tmbundle', vue: 'vuejs/language-tools' };
const PREFIX: Record<string, string> = { tmbundle: 'textmate/html.tmbundle', vscode: 'microsoft/vscode' };
const linkify = (id: string, key: string) => id.replace(/([a-z]+)?#(\d+)/g, (_m, pfx, num) => `[${pfx ?? ''}#${num}](https://github.com/${(pfx && PREFIX[pfx]) || REPO[key]}/issues/${num})`);
const graded = langs.filter(l => l.rows) as { name: string; key: string; opponent: string; rows: Row[] }[];
// One-line tally + per-language detail, written into a single auto-generated region.
// The summary used to be a table, but it just duplicated the detail below — collapse it to
// a sentence that keeps the headline contrast (Monogram vs official, each on its own bugs).
const tally = graded.map(({ name, rows }) =>
  `**${name} ${rows.filter(r => r.mono).length}/${rows.length}** (official ${rows.filter(r => r.off).length}/${rows.length})`).join(' · ');
const skipped = langs.filter(l => !l.rows).map(l => l.name);
let summaryMd = `_Each hand-written **official** grammar vs Monogram's **derived** one, on the bugs filed against it: ${tally}` +
  (skipped.length ? ` (${skipped.join(', ')} skipped — no official grammar)` : '') +
  '. Per-issue detail below — auto-generated by `npm run bench:issues`._\n';

// per-language detail — the ASYMMETRIES (only-Monogram / only-official / both-miss) are the
// point, so they stay visible; the rows where both grammars already agree (✓/✓) are folded
// into a <details> so they don't bury the contrast. (GitHub renders a table inside <details>
// only with a blank line after <summary> and before </details>.)
let detailMd = '';
for (const { name, key, rows } of graded) {
  // No (only Monogram) / (both miss) tags — the ✓/· columns already say which side solves it.
  const header = `| issue | Monogram | official |\n|---|:--:|:--:|\n`;
  const rowMd = (r: Row) => `| ${linkify(r.id, key)} — ${r.title} | ${mark(r.mono)} | ${mark(r.off)} |\n`;
  const diff = [...rows.filter(r => r.mono && !r.off), ...rows.filter(r => !r.mono && r.off), ...rows.filter(r => !r.mono && !r.off)];
  const both = rows.filter(r => r.mono && r.off);
  detailMd += `#### ${name}\n`;
  detailMd += diff.length ? header + diff.map(rowMd).join('') : `_No asymmetries — both grammars handle all ${rows.length} filed bugs below._\n`;
  if (both.length) detailMd += `\n<details><summary>… and ${both.length} more both grammars already handle (✓ / ✓)</summary>\n\n${header}${both.map(rowMd).join('')}\n</details>\n`;
  detailMd += '\n';
}
detailMd = detailMd.trimEnd() + '\n';

// console summary
console.log('\n══════════ cross-language documented-issue scorecard ══════════');
for (const { name, rows } of langs) {
  if (!rows) { console.log(`  ${name.padEnd(12)} (skipped — no official grammar)`); continue; }
  const om = rows.filter(r => r.mono && !r.off).length, oo = rows.filter(r => !r.mono && r.off).length, bm = rows.filter(r => !r.mono && !r.off).length;
  console.log(`  ${name.padEnd(12)} Monogram ${rows.filter(r => r.mono).length}/${rows.length} · official ${rows.filter(r => r.off).length}/${rows.length}   (only-Monogram ${om}, only-official ${oo}, both-miss ${bm})`);
}

if (process.argv.includes('--write')) {
  // CLOBBER GUARD: only write a COMPLETE table. The block replaces every language section, so a
  // partial environment (a missing official grammar → that language graded `null`/skipped, e.g. CI
  // without VS Code or the Vue fixtures) would silently drop those sections and overwrite the full
  // committed ledger with a subset. Refuse instead — the README must be regenerated where ALL
  // official grammars are present (locally, or the CI job that fetches/commits every one).
  if (skipped.length) { console.log(`\n✗ Refusing to --write a PARTIAL ledger: ${skipped.join(', ')} skipped (no official grammar). Provide every official grammar (set MONOGRAM_OFFICIAL_TM/TSX/HTML/CSS/JS + the test/fixtures/vue-official files) and retry.`); process.exit(1); }
  const START = '<!-- issues:start -->', END = '<!-- issues:end -->';
  const note = '<!-- generated by `npm run bench:issues` — do not edit by hand -->';
  const readme = read('README.md');
  if (!readme.includes(START) || !readme.includes(END)) { console.log(`\n✗ README.md is missing the ${START} … ${END} markers — add them where the ledger should go.`); process.exit(1); }
  const block = `${START}\n${note}\n${summaryMd}\n${detailMd}${END}`;
  const out = readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), () => block); // fn replacer: body may contain `$`
  writeFileSync('README.md', out);
  console.log('\n✓ Wrote the issue ledger into README.md');
} else {
  console.log('\n(run with --write to update README.md)');
}
