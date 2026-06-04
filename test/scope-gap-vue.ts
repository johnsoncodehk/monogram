// ─────────────────────────────────────────────────────────────────────────────
//  scope-gap-vue.ts — the Vue adapter for the unified scope-gap metric: grade the
//  OFFICIAL Vue grammar (vuejs/language-tools' vue.tmLanguage.json + the two injection
//  grammars) AND Monogram's DERIVED Vue grammar, both against the parser-derived role
//  oracle (vue-oracle.ts), via the FROZEN neutral table in scope-roles.ts. Reports
//  official correct% vs Monogram correct% + the gap — the Vue cut of vscode#203212.
//
//  WHY THIS DOESN'T CALL scope-gap.ts's run():
//    Vue is an INJECTION grammar. The host `text.html.vue` is plain, but directives
//    (`vue.directives`) and `{{…}}` (`vue.interpolations`) are SEPARATE grammars that
//    inject into the host via a package.json `injectTo` descriptor + an injectionSelector.
//    scope-gap.ts's run() tokenizes with a bare vscode-textmate Registry.loadGrammar, which
//    has NO injectTo wiring — so directives + interpolations DON'T fire (verified: `{{ msg }}`
//    stays flat `text.html.derivative`, never embedding source.ts). Grading on that path would
//    test a Vue grammar VS Code never runs. So we tokenize through the SAME faithful tool the
//    rest of the Vue bench uses — vue-grammar-harness.ts's `scopeLookup`, which feeds the
//    grammars + injections to vuejs/language-tools' own `vscode-tmlanguage-snapshot` exactly
//    as VS Code resolves them — and reuse scope-gap's GRADING primitives unchanged
//    (gradeScope / isCorrect / ROLE_SPEC from scope-roles.ts). Same scoring, faithful tokens.
//
//  COVERAGE / SKIPS: see vue-oracle.ts's header. Short version: GRADES template tag names,
//  PLAIN attribute names, the full <script> body at TS/JS fidelity, and {{…}} / directive-VALUE
//  expressions as TS. SKIPS Vue directive NAMES (both grammars render them as keywords, not
//  `entity.other.attribute-name` — no false penalty, and no "directive" role exists in the
//  frozen table) and <style>/CSS (no CSS role table). Honest, bounded first version.
//
//  Run (bare node, Node 24+): node test/scope-gap-vue.ts
// ─────────────────────────────────────────────────────────────────────────────
import { vueOracle } from './vue-oracle.ts';
import { scopeLookup, officialAvailable } from './vue-grammar-harness.ts';
import { gradeScopeStack, isCorrect, ROLE_SPEC } from './scope-roles.ts';
import type { RoleName } from './scope-roles.ts';
import type { GoldToken } from './scope-gap.ts';
import { cases as vueIssueCases } from './vue-issue-cases.ts';

if (!officialAvailable) {
  console.log('⊘ Skipped: official Vue grammars not found under test/fixtures/vue-official.');
  console.log('  Fetch: base=https://raw.githubusercontent.com/vuejs/language-tools/master/extensions/vscode/syntaxes');
  console.log('  curl -fsSL "$base/{vue.tmLanguage.json,vue-directives.json,vue-interpolations.json}" -O (into that dir)');
  process.exit(0);
}

// ── corpus: the SHARED CORE both grammars target (mirrors vue-bench.ts) + the real reported
//    issue SFCs (vue-issue-cases.ts). These are the vendored Vue fixtures the repo already uses. ──
const CORE: string[] = [
  `<script lang="ts">\nconst x: number = 1\n</script>`,
  `<script>\nvar y = 1 < 2\n</script>`,
  `<template>\n  <div>{{ msg }}</div>\n</template>`,
  `<template>\n  <div v-if="ok">x</div>\n</template>`,
  `<template>\n  <a :href="url" @click="go">x</a>\n</template>`,
  `<template>\n  <ul><li v-for="i in items">{{ i }}</li></ul>\n</template>`,
  `<script setup lang="ts">\nconst n = 1\n</script>\n<template>\n  <p :title="n">{{ n + 1 }}</p>\n</template>`,
  `<template><b :value="msg as string">ok</b></template>`,
  `<script lang="ts">\ntype Foo = 123\n</script>\n<template><b /></template>`,
  `<template>\n  <Foo #header="{ x }" @done="onDone">{{ greet(x) }}</Foo>\n</template>`,
  `<template>\n  <li v-for="(item, i) in items" :key="item.id">{{ item.name }}</li>\n</template>`,
  `<script lang="ts">\nimport { ref } from 'vue'\nconst c = ref<number>(0)\n</script>`,
  `<script setup lang="ts">\nimport { computed } from 'vue'\ninterface Props { id: number; name: string }\nconst p = defineProps<Props>()\nconst label = computed(() => p.name.toUpperCase())\n</script>\n<template>\n  <span class="lbl">{{ label }}</span>\n</template>`,
];

const corpus = [
  ...CORE.map((text, i) => ({ name: `core#${i}`, text })),
  ...vueIssueCases.map((c) => ({ name: `issue:${c.id}`, text: c.src })),
];

// ── tokenize via the faithful (injection-aware) harness; grade via the FROZEN table ──────────
// Return the FULL scope CHAIN (not just the innermost) so grading is STACK-AWARE, identical to
// scope-gap.ts's run(): a role correctly nested as an ancestor of a refinement is credited.
type ScopeAt = (offset: number) => string[];
async function lookupFor(which: 'mono' | 'off', src: string): Promise<ScopeAt> {
  const at = await scopeLookup(which, src);             // offset → scopes[] (deepest last)
  return (offset: number) => at(offset);
}

const tally = { oCorrect: 0, oExact: 0, mCorrect: 0, mExact: 0, total: 0 };
const perRole = new Map<RoleName, { n: number; oC: number; mC: number }>();
const onlyMono: { text: string; role: RoleName; o: string; m: string }[] = [];
const onlyOff: { text: string; role: RoleName; o: string; m: string }[] = [];
const snip = { o: 0, m: 0, n: 0 };
let nFiles = 0;

for (const { text } of corpus) {
  let gold: GoldToken[], oAt: ScopeAt, mAt: ScopeAt;
  try {
    gold = vueOracle(text);
    oAt = await lookupFor('off', text);
    mAt = await lookupFor('mono', text);
  } catch { continue; }
  nFiles++;
  let okO = true, okM = true, gradedHere = 0;
  for (const t of gold) {
    const tier = ROLE_SPEC[t.role]?.tier;
    if (!tier || tier === 'lexical') continue;          // lexical floor: excluded from the headline
    const so = oAt(t.start), sm = mAt(t.start);         // full scope CHAINS
    const vo = gradeScopeStack(t.role, so), vm = gradeScopeStack(t.role, sm);
    const oc = isCorrect(vo), mc = isCorrect(vm);
    tally.total++; gradedHere++;
    if (oc) tally.oCorrect++; if (vo === 'exact') tally.oExact++;
    if (mc) tally.mCorrect++; if (vm === 'exact') tally.mExact++;
    const pr = perRole.get(t.role) ?? { n: 0, oC: 0, mC: 0 }; pr.n++; if (oc) pr.oC++; if (mc) pr.mC++; perRole.set(t.role, pr);
    if (!oc) okO = false; if (!mc) okM = false;
    const inner = (s: string[]) => s.length ? s[s.length - 1] : '(none)';
    if (mc && !oc && onlyMono.length < 40) onlyMono.push({ text: t.text, role: t.role, o: inner(so), m: inner(sm) });
    if (oc && !mc && onlyOff.length < 40) onlyOff.push({ text: t.text, role: t.role, o: inner(so), m: inner(sm) });
  }
  if (gradedHere) { snip.n++; if (okO) snip.o++; if (okM) snip.m++; }
}

const pct = (n: number, d = tally.total) => (d ? (100 * n / d).toFixed(1) : 'n/a');
const gap = tally.total ? (100 * (tally.mCorrect - tally.oCorrect) / tally.total).toFixed(1) : 'n/a';
console.log('='.repeat(78));
console.log('  Scope-gap vs the PARSER oracle — Vue  (vscode#203212)');
console.log('  official: test/fixtures/vue-official/vue.tmLanguage.json    monogram: vue.tmLanguage.json');
console.log('  oracle: @vue/compiler-sfc split + parse5 (template) + tsc (script/expr)');
console.log('  tokenized via vscode-tmlanguage-snapshot (injection-aware, vuejs/language-tools\' own tool)');
console.log('='.repeat(78));
console.log(`  ${nFiles} files · ${tally.total} graded tokens (lexical-floor roles + directive names excluded)`);
console.log(`  OFFICIAL  correct ${pct(tally.oCorrect)}%  (exact ${pct(tally.oExact)}%)`);
console.log(`  MONOGRAM  correct ${pct(tally.mCorrect)}%  (exact ${pct(tally.mExact)}%)`);
console.log(`  ══ GAP (Monogram − official) = ${gap} pts ══`);
console.log(`  per-snippet all-tokens-correct: official ${pct(snip.o, snip.n)}%  monogram ${pct(snip.m, snip.n)}%  (n=${snip.n})`);

const rows = [...perRole.entries()]
  .map(([role, r]) => ({ role, n: r.n, o: r.oC, m: r.mC, d: r.mC - r.oC }))
  .sort((a, b) => Math.abs(b.d) - Math.abs(a.d) || b.n - a.n);
console.log(`\n  per-role correctness (official→monogram correct / occurrences):`);
for (const r of rows) console.log(`    ${r.role.padEnd(16)} ${String(r.o).padStart(5)} →${String(r.m).padStart(5)} / ${r.n}   ${r.d > 0 ? '+' : ''}${r.d || ''}`);

if (onlyMono.length) {
  console.log(`\n  only-Monogram-correct tokens (official wrong vs the parser) — ${onlyMono.length} shown:`);
  for (const x of onlyMono.slice(0, 12)) console.log(`    «${x.text.slice(0, 18)}» ${x.role}: official «${x.o}» → monogram «${x.m}»`);
}
if (onlyOff.length) {
  console.log(`\n  only-official-correct tokens (Monogram wrong) — ${onlyOff.length} shown:`);
  for (const x of onlyOff.slice(0, 12)) console.log(`    «${x.text.slice(0, 18)}» ${x.role}: official «${x.o}» → monogram «${x.m}»`);
}
// Machine-readable summary (same shape as scope-gap.ts's ##SCOPEGAP## line) for any table generator.
console.log('##SCOPEGAP## ' + JSON.stringify({
  name: 'Vue', official: 'vue.tmLanguage.json', tokens: tally.total,
  officialPct: tally.total ? (100 * tally.oCorrect) / tally.total : null,
  monogramPct: tally.total ? (100 * tally.mCorrect) / tally.total : null,
}));
console.log('\nDone.');
