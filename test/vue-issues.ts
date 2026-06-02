// ─────────────────────────────────────────────────────────────────────────────
//  vue-issues.ts — Monogram's DERIVED Vue grammar vs the hand-written official, on REAL
//  highlighting bugs reported against vuejs/language-tools' vue.tmLanguage.json (the same
//  approach as html-bench, which tests documented textmate/html.tmbundle issues — not a
//  self-curated corpus). The cases live in vue-issue-cases.ts (shared with the README's
//  cross-language ✓ table, test/issue-table.ts).
//
//  Most are CLOSED — the hand-written grammar accumulated + hand-fixed them over many
//  releases. The thesis question: does the DERIVED grammar exhibit them, or is it correct
//  BY CONSTRUCTION? The headline family is TS operators inside template expressions
//  (instanceof / typeof / ?? / ?. / => / <): Monogram embeds its OWN proven TS
//  (source.ts#expression) and gets them free; the official patched each one over time.
//
//  Both grammars are tokenized through `vscode-tmlanguage-snapshot` — vuejs/language-tools'
//  OWN grammar-test tool (see test/vue-grammar-harness.ts) — so the head-to-head is faithful
//  to how the official grammar is actually tested.
//
//  Run: node test/vue-issues.ts   (needs test/fixtures/vue-official — see vue-bench.ts header)
// ─────────────────────────────────────────────────────────────────────────────
import { cases } from './vue-issue-cases.ts';
import { scopeLookup, officialAvailable } from './vue-grammar-harness.ts';

if (!officialAvailable) { console.log('⊘ Skipped: official Vue grammars not found (see test/vue-bench.ts header to fetch).'); process.exit(0); }

// at(text[, nth]) → scopes (space-joined) at the middle of the nth occurrence of `text`.
function makeAt(look: (o: number) => string[], src: string) {
  return (text: string, nth = 0) => {
    let i = -1; for (let k = 0; k <= nth; k++) i = src.indexOf(text, i + 1);
    return i < 0 ? '__NOT_FOUND__' : look(i + Math.floor(text.length / 2)).join(' ');
  };
}

// Expected outcomes — a SNAPSHOT of the honest current state, so this gate catches a
// REGRESSION (a ✓ that flips to ✗) or an unexpected change. Monogram now solves every
// reported case; #6007 is the one the OFFICIAL still gets wrong:
//   #6007 — the #5012 `as`-in-a-directive-value bug. Monogram bounds the value with a
//   CAPTURE-EMBED so the `as`-cast can't run its type context past the closing quote; the
//   official's begin/end region lets it leak. (#5722 and #3999 were Monogram gaps — both
//   FIXED too; see gen-tm generateMarkupInjection / emitRawMultiline.)
const expect: Record<string, { mono: boolean; off: boolean }> = {
  '#3400': { mono: true, off: true }, '#5370': { mono: true, off: true }, '#5118': { mono: true, off: true },
  '#1675': { mono: true, off: true }, '#6039/#4741': { mono: true, off: true }, '#5722': { mono: true, off: true },
  '#6007/#2096/#520': { mono: true, off: false }, '#5538/#2060': { mono: true, off: true },
  '#3999': { mono: true, off: true }, '#4769': { mono: true, off: true }, '#5701': { mono: true, off: true },
  '#6070': { mono: true, off: true },
  // ── 2026-06 expansion: more reported bugs, honest mix (incl. only-official Monogram gaps) ──
  '#5660': { mono: true, off: false }, '#4716/#5571': { mono: true, off: false }, '#4291': { mono: true, off: false },
  '#4410': { mono: false, off: true }, '#3727': { mono: false, off: true }, '#2666': { mono: false, off: true },
  '#2560/#1290': { mono: true, off: true },
};

let mPass = 0, oPass = 0; const rows: string[] = []; const deviations: string[] = [];
for (const c of cases) {
  const mAt = makeAt(await scopeLookup('mono', c.src), c.src), oAt = makeAt(await scopeLookup('off', c.src), c.src);
  const mOk = c.checks.every(ch => ch.want(mAt(ch.at, ch.nth)));
  const oOk = c.checks.every(ch => ch.want(oAt(ch.at, ch.nth)));
  if (mOk) mPass++; if (oOk) oPass++;
  const gap = !mOk && oOk ? '  ← Monogram gap' : (!mOk && !oOk ? '  ← shared ceiling' : '');
  rows.push(`  ${c.id.padEnd(16)} ${(mOk ? '✓' : '✗').padEnd(9)} ${(oOk ? '✓' : '✗').padEnd(9)} ${c.title}${gap}`);
  const e = expect[c.id];
  if (e && (e.mono !== mOk || e.off !== oOk)) deviations.push(`  ${c.id}: expected Monogram ${e.mono}/official ${e.off}, got ${mOk}/${oOk}`);
}

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log('  REAL reported highlighting issues vs vuejs/language-tools vue.tmLanguage.json');
console.log('  (tokenized via vscode-tmlanguage-snapshot — their own tool; both embed');
console.log('   Monogram\'s source.ts, so this isolates the Vue layer)');
console.log('══════════════════════════════════════════════════════════════════════');
console.log(`  ${'issue'.padEnd(16)} ${'Monogram'.padEnd(9)} ${'official'.padEnd(9)} title`);
for (const r of rows) console.log(r);
console.log('  ' + '─'.repeat(60));
console.log(`  ${'PASS'.padEnd(16)} ${(`${mPass}/${cases.length}`).padEnd(9)} ${oPass}/${cases.length}`);
console.log(`\n  Honest reading: these are REAL bugs the hand-written grammar accumulated + hand-fixed`);
console.log(`  over many releases. Monogram WINS the operator family (instanceof / typeof / ?? / ?. /`);
console.log(`  => / <) BY CONSTRUCTION — it embeds its own proven TS, never a per-operator patch.`);
console.log(`  #6007 (#5012 \`as\` in a directive value): Monogram bounds the value with a capture-embed`);
console.log(`  so the cast can't eat the closing quote — the official's begin/end region still leaks.`);
// Gate: reality must match the recorded snapshot — catches a regression or an unexpected change.
if (deviations.length) { console.log('\n✗ Result changed from the recorded snapshot (update expect{} if intended):'); for (const d of deviations) console.log(d); process.exit(1); }
console.log(`\n✓ Matches the recorded snapshot: Monogram ${mPass}/${cases.length}, official ${oPass}/${cases.length} on real reported issues.`);
