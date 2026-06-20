// ─────────────────────────────────────────────────────────────────────────────
//  tm-mutation.ts — MUTATION TESTING for the completeness gap-detector.
//
//  The completeness checker (test/tm-completeness.ts) proves structural properties
//  (closure, reachability, token discharge, leaf coverage). But "the checker passes"
//  only means something if the checker can actually FAIL when there IS a gap. A clean
//  pass on a blind checker is worthless — the exact corpus-blindness this project has
//  been bitten by. So this harness MEASURES the detector's power directly: it INJECTS a
//  catalogue of known gaps into the emitted grammar (fault injection), runs every
//  detector layer, and records which layer (if any) catches each.
//
//  This is the honest answer to "can every gap be found?" — not an a-priori completeness
//  claim (the review showed ordering / disambiguation-correctness obligations are not
//  grammar-algebraic and slide into undecidable territory), but a MEASURED kill rate:
//
//    • PRESENCE gaps (a token / scope / key dropped or neutered) MUST be killed by a
//      corpus-free STRUCTURAL detector (reachability / token-census / leaf-coverage).
//      A surviving presence mutant is a detector bug → this gate fails.
//    • CORRECTNESS / ORDERING gaps (a disambiguation guard weakened, two patterns
//      reordered) are EXPECTED to slip past the structural detectors — they are caught,
//      if at all, only by a differential WITNESS (a paint change on a targeted input).
//      Survivors here are the detector's MEASURED blind spots, reported not failed: they
//      are the honest boundary COMPLETENESS.md draws, made empirical.
//
//  Run:  node test/tm-mutation.ts
// ─────────────────────────────────────────────────────────────────────────────
import { generateTmLanguage } from '../src/gen-tm.ts';
import { createParser } from '../src/gen-parser.ts';
import type { CstGrammar } from '../src/types.ts';
import { generateInputs } from './grammar-gen.ts';
import { buildRoleMap, leafRoles, spanBuckets, scopeAt, GEN_OPTS, type TmTok, type Bucket } from './generative-detect.ts';
import {
  checkReachability, tokenCensus, literalDischarge, leafCoverage, loadTmFromObject, tmTokenize,
  type TmGrammarJson,
} from './tm-completeness.ts';

// ── a mutation: a precise, kind-labelled fault injected into the emitted grammar ──
type MutClass = 'presence' | 'correctness' | 'ordering';
interface Mutation {
  label: string;
  cls: MutClass;
  // mutate the (already-deep-cloned) emitted grammar in place; return false to skip
  // (the site does not exist in this grammar — keeps the catalogue grammar-agnostic).
  apply: (tm: any) => boolean;
  witness?: string;       // a targeted input the differential detector tokenises
  leaf?: string;          // the substring whose paint the differential watches
  equivalent?: boolean;   // a true gap is created (false) vs a no-op the detector SHOULDN'T flag (true)
}

const rootIncludeIndex = (tm: any, key: string) =>
  (tm.patterns as any[]).findIndex(p => p?.include === `#${key}`);
// recursively delete every `{include:#key}` anywhere in the grammar (so the key truly dies)
function dropAllIncludes(node: any, key: string): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (let i = node.length - 1; i >= 0; i--) { if (node[i]?.include === `#${key}`) node.splice(i, 1); else dropAllIncludes(node[i], key); } return; }
  for (const v of Object.values(node)) dropAllIncludes(v, key);
}

// the catalogue is built PER-WITNESS: we tokenise the baseline, find the repository key that
// ACTUALLY paints each witness leaf, and target THAT key — so a mutation creates a real gap
// instead of an equivalent mutant (e.g. dropping #number's ROOT include is a no-op because
// #number is still reachable from #expression; only dropping ALL includes truly kills it).
function buildCatalogue(tm: any, paintKey: (w: string, leaf: string) => string | null): Mutation[] {
  const root = String(tm.scopeName ?? 'source');
  const lang = root.replace(/^(source|text)\./, '');
  const muts: Mutation[] = [];
  const sites: { witness: string; leaf: string; role: string }[] = [
    { witness: 'q = 42', leaf: '42', role: 'number' },
    { witness: 'q = "x"', leaf: '"x"', role: 'string' },
    { witness: 'a // c', leaf: '// c', role: 'comment' },
  ];
  for (const s of sites) {
    const key = paintKey(s.witness, s.leaf);
    if (!key) continue;
    // PRESENCE — a corpus-free structural detector must kill each of these:
    muts.push({ label: `drop ${s.role} key (all includes + entry)`, cls: 'presence', witness: s.witness, leaf: s.leaf,
      apply: (t) => { dropAllIncludes(t, key); delete t.repository[key]; return true; } });
    muts.push({ label: `neuter ${s.role} scope → bare root`, cls: 'presence', witness: s.witness, leaf: s.leaf,
      apply: (t) => { t.repository[key] = { ...t.repository[key], name: root }; if (t.repository[key].patterns || t.repository[key].begin) { delete t.repository[key].beginCaptures; delete t.repository[key].endCaptures; t.repository[key].patterns = []; } return true; } });
    // CORRECTNESS — a VALID grammar that paints the WRONG role (leaf still painted, just wrong):
    muts.push({ label: `mis-scope ${s.role} → keyword (wrong role, still painted)`, cls: 'correctness', witness: s.witness, leaf: s.leaf,
      apply: (t) => { t.repository[key] = { ...t.repository[key], name: `keyword.control.${lang}` }; return true; } });
  }
  // PRESENCE — a real dead key (nothing includes it) and a real dangling include:
  muts.push({ label: 'add an unreachable (dead) repo key', cls: 'presence',
    apply: (t) => { t.repository['__orphan__'] = { match: 'zzzqqq', name: `comment.${lang}` }; return true; } });
  muts.push({ label: 'dangling include to a missing key', cls: 'presence',
    apply: (t) => { t.patterns.unshift({ include: '#__ghost__' }); return true; } });
  // ORDERING — flip a disambiguation priority so a looser rule shadows a tighter one:
  if (tm.repository['generic-call'] && rootIncludeIndex(tm, 'comparison') >= 0) {
    muts.push({ label: 'move generic-call after comparison (priority flip)', cls: 'ordering', witness: 'a<T>(x)', leaf: 'T',
      apply: (t) => { const gi = rootIncludeIndex(t, 'generic-call'); if (gi < 0) return false; const [g] = t.patterns.splice(gi, 1); t.patterns.push(g); return true; } });
  }
  return muts;
}

// ── detectors ──────────────────────────────────────────────────────────────────────
// corpus-FREE structural detectors (the ones whose guarantee is a-priori, not sampled)
function structuralCatches(g: CstGrammar, mutated: TmGrammarJson): string[] {
  const hits: string[] = [];
  const r = checkReachability(g, mutated);
  if (r.dead.length) hits.push(`reachability:dead(${r.dead.join(',')})`);
  if (r.danglingWithSource.length) hits.push(`reachability:dangling(${r.danglingWithSource.join(',')})`);
  const c = tokenCensus(g, mutated);
  if (c.orphans.length) hits.push(`token-census:orphan(${c.orphans.join(',')})`);
  if (c.neutered.length) hits.push(`token-census:neutered(${c.neutered.join(',')})`);
  const ld = literalDischarge(g, mutated);
  if (ld.gaps.length) hits.push(`literal-discharge(${ld.gaps.slice(0, 3).join(',')})`);
  return hits;
}
// load that survives an invalid mutated grammar (a broken regex) — a grammar that fails
// to compile is itself a detectable defect, reported as compile-error rather than crashing.
async function tryLoad(scope: string, grammar: object): Promise<{ tm: any } | { err: string }> {
  try { const tm = await loadTmFromObject(scope, { [scope]: grammar }); return tm ? { tm } : { err: 'load-null' }; }
  catch (e: any) { return { err: `compile-error(${String(e?.message ?? e).slice(0, 30)})` }; }
}
// grammar-derived-corpus detector (leaf coverage over generated inputs)
async function corpusCatches(g: CstGrammar, scope: string, mutated: object): Promise<string | null> {
  const r = await tryLoad(scope, mutated);
  if ('err' in r) return `leaf-coverage:${r.err}`;
  const cov = leafCoverage(g, r.tm, { ...GEN_OPTS, maxInputs: 250 });
  return cov.painted < cov.den ? `leaf-coverage(${cov.painted}/${cov.den})` : null;
}
// targeted DIFFERENTIAL detector: did the witness leaf's paint change vs baseline?
async function differentialCatches(scope: string, base: object, mutated: object, witness: string, leaf: string): Promise<string | null> {
  const [bt, mt] = await Promise.all([tryLoad(scope, base), tryLoad(scope, mutated)]);
  if ('err' in bt) return null;
  if ('err' in mt) return `differential:${mt.err}`;
  const at = witness.indexOf(leaf); if (at < 0) return null;
  const bb = bucketsAt(bt.tm, witness, at, leaf.length), mb = bucketsAt(mt.tm, witness, at, leaf.length);
  const bs = [...bb].sort().join('|'), ms = [...mb].sort().join('|');
  return bs !== ms ? `differential({${bs||'∅'}}→{${ms||'∅'}})` : null;
}
function bucketsAt(tm: any, text: string, start: number, len: number): Set<Bucket> {
  return spanBuckets(tmTokenize(tm, text), text, start, start + len);
}

// ── driver ──────────────────────────────────────────────────────────────────────────
interface Row { grammar: string; label: string; cls: MutClass; equivalent: boolean; killedBy: string[]; survived: boolean; skipped: boolean }

async function runGrammar(name: string, module: string, scope: string): Promise<Row[]> {
  const g = (await import(module)).default as CstGrammar;
  const base = generateTmLanguage(g) as any;
  if (base.scopeName) scope = base.scopeName;
  const baseTm = await loadTmFromObject(scope, { [scope]: base });
  if (!baseTm) return [];
  // the painting-key finder: the repo key whose `name` paints a witness leaf (sampled at the
  // leaf's MIDDLE char, so a string's CONTENT scope is found, not its delimiter punctuation).
  const paintKey = (witness: string, leaf: string): string | null => {
    const at = witness.indexOf(leaf); if (at < 0) return null;
    const inner = scopeAt(tmTokenize(baseTm, witness), at + Math.floor(leaf.length / 2)).at(-1) ?? '';
    if (!inner || inner === scope) return null;
    for (const [k, v] of Object.entries(base.repository) as [string, any][]) if (v?.name === inner) return k;
    for (const [k, v] of Object.entries(base.repository) as [string, any][]) if (typeof v?.name === 'string' && inner.startsWith(v.name + '.')) return k;
    return null;
  };
  const rows: Row[] = [];
  for (const m of buildCatalogue(base, paintKey)) {
    const mutated = structuredClone(base);
    if (!m.apply(mutated)) { rows.push({ grammar: name, label: m.label, cls: m.cls, equivalent: !!m.equivalent, killedBy: [], survived: false, skipped: true }); continue; }
    const killedBy = structuralCatches(g, mutated);
    const corpus = await corpusCatches(g, scope, mutated); if (corpus) killedBy.push(corpus);
    if (m.witness && m.leaf) { const d = await differentialCatches(scope, base, mutated, m.witness, m.leaf); if (d) killedBy.push(d); }
    rows.push({ grammar: name, label: m.label, cls: m.cls, equivalent: !!m.equivalent, killedBy, survived: killedBy.length === 0, skipped: false });
  }
  return rows;
}

async function main(): Promise<void> {
  const GRAMMARS = [
    { name: 'typescript', module: '../typescript.ts', scope: 'source.ts' },
    { name: 'yaml', module: '../yaml.ts', scope: 'source.yaml' },
  ];
  const rows: Row[] = [];
  for (const cfg of GRAMMARS) rows.push(...await runGrammar(cfg.name, cfg.module, cfg.scope));

  console.log('── mutation testing: which detector layer kills each injected gap ──\n');
  for (const r of rows) {
    const mark = r.skipped ? '·' : r.equivalent ? (r.survived ? '✓' : '⚠') : r.survived ? '✗' : '✓';
    const by = r.skipped ? '(site n/a — skipped)'
      : r.equivalent ? (r.survived ? 'correctly NOT flagged (no-op mutant)' : `FALSE ALARM: ${r.killedBy.join(' ')}`)
      : r.survived ? 'SURVIVED — no detector caught it' : r.killedBy.join('  ');
    console.log(`  ${mark} [${r.cls.padEnd(11)}]${r.equivalent ? '[equiv]' : '       '} ${r.grammar.padEnd(11)} ${r.label.padEnd(52)} ${by}`);
  }

  const live = rows.filter(r => !r.skipped);
  const real = live.filter(r => !r.equivalent);
  const presence = real.filter(r => r.cls === 'presence');
  const presenceSurvivors = presence.filter(r => r.survived);
  const structuralKill = (r: Row) => r.killedBy.some(k => k.startsWith('reachability') || k.startsWith('token-census'));
  const corrOrder = real.filter(r => r.cls !== 'presence');
  const corrOrderSurvivors = corrOrder.filter(r => r.survived);
  const falseAlarms = live.filter(r => r.equivalent && !r.survived);

  console.log('\n── measured detection power ──');
  console.log(`  presence gaps        : ${presence.length - presenceSurvivors.length}/${presence.length} killed · ${presence.filter(structuralKill).length}/${presence.length} by a CORPUS-FREE structural detector`);
  console.log(`  correctness/ordering : ${corrOrder.length - corrOrderSurvivors.length}/${corrOrder.length} caught (differential) · ${corrOrderSurvivors.length} survived (measured blind spot)`);
  console.log(`  equivalent controls  : ${falseAlarms.length} false alarm(s) (a precision bug if > 0)`);

  // GATE: every real presence gap MUST be killed; no equivalent mutant may be falsely flagged.
  // correctness/ordering survivors are the honest, documented boundary — reported, not failed.
  const failures = [...presenceSurvivors.map(r => `presence SURVIVED: ${r.grammar} — ${r.label}`),
    ...falseAlarms.map(r => `FALSE ALARM on equivalent mutant: ${r.grammar} — ${r.label}`)];
  if (failures.length) { console.log('\n✗ detector defect(s):'); for (const f of failures) console.log(`    - ${f}`); process.exit(1); }
  console.log(`\n✓ every presence gap killed, no false alarms; correctness/ordering blind spots measured = ${corrOrderSurvivors.length} (the boundary COMPLETENESS.md states).`);
  void createParser; void buildRoleMap; void leafRoles; void generateInputs;
}

if ((import.meta as any).main) await main();
