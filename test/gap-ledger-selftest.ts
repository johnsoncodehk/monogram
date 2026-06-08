// ─────────────────────────────────────────────────────────────────────────────
//  gap-ledger-selftest.ts — asserts the gap ledger's two load-bearing behaviours
//  on the REAL HTML probe, independent of how many gaps happen to surface:
//
//   (A) DETERMINISM — `generateInputs` + ddmin + fingerprint are a pure function of
//       the grammar, so two full ledger builds are byte-identical. Asserted here over
//       the rendered KNOWN-GAPS.md (the committed artifact) by building it twice.
//
//   (B) the oracle CLASSIFY DROP-PATH — a divergence whose minimized repro the external
//       oracle REJECTS (a parser over-accept, not a real highlighter gap) is DROPPED,
//       not filed. We assert the ledger's keep/drop predicate (`oracleAccepts(repro)`)
//       routes a parser OVER-ACCEPT (a markup the Monogram parser accepts but parse5
//       REJECTS — `< a/>`, `<:a/>`) to DROP, and the oracle-VALID `<a b="c"/>`-shape to
//       KEEP. (Note: the self-close `/` divergence itself only arises on WELL-FORMED tag
//       shapes — which parse5 also accepts — so a single input that BOTH diverges AND is
//       oracle-rejected does not exist for this gap; the drop-path is exercised by the
//       classify predicate over real over-accept markup, which is what would gate it.)
//
//  Run (bare node):  node test/gap-ledger-selftest.ts
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { createParser } from '../src/gen-parser.ts';
import type { CstGrammar } from '../src/types.ts';
import { buildRoleMap, anchoredScopes, leafRoles, collectViolations, isGated } from './generative-detect.ts';
import { loadTm, tmTokenize, reproStillDiverges, sig, minimize, LANGS, type Probe } from './gap-ledger.ts';

let failures = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${msg}`); if (!cond) failures++; };

// ── build the HTML probe (the cheapest grammar with a known divergence) ──
const htmlCfg = LANGS.find((l) => l.name === 'html')!;
const grammar = (await import(htmlCfg.module)).default as CstGrammar;
const { parse } = createParser(grammar);
const tm = await loadTm(htmlCfg.scopeName, { [htmlCfg.scopeName]: htmlCfg.tmPath, ...(htmlCfg.tmExtra ?? {}) });
if (!tm) throw new Error('failed to load html grammar');
const probe: Probe = { parse, tm, grammar, roleOf: buildRoleMap(grammar), anchored: anchoredScopes(grammar) };

// the ledger's CLASSIFY predicate, verbatim: keep iff the oracle accepts the minimal repro as VALID.
const classifyKeeps = (text: string) => htmlCfg.oracleAccepts(text);

console.log('gap-ledger self-test\n');

// ── (B1) the canonical KEPT case: `<a b="c"/>`-shape, oracle-valid, still diverges ──
const keptInput = '<aA aA = "a"/>';   // the generator's tight-markup shape
{
  // detect the divergence on the real input, minimize, classify
  const v0 = probeDivergence(keptInput);
  ok(!!v0, `kept case: a self-close \`/\` divergence is detected on ${JSON.stringify(keptInput)}`);
  if (v0) {
    const repro = minimize(probe, keptInput, v0.target);
    ok(!!reproStillDiverges(probe, repro, v0.target), `kept case: minimized repro ${JSON.stringify(repro)} still diverges`);
    ok(classifyKeeps(repro), `kept case: parse5 ACCEPTS the minimized repro → KEEP (a real highlighter gap)`);
  }
}

// ── (B2) the DROP case: real parser OVER-ACCEPTS (parser accepts, parse5 REJECTS) ──
// markup the Monogram markup parser accepts but parse5 does NOT recover as an element — exactly the
// "Monogram parses but the oracle rejects" class the ledger must DROP (a parser concern, not a
// highlighter gap). We assert each is parser-accepted AND classify-DROPPED (oracleAccepts == false).
const overAccepts = ['< a/>', '<:a/>'];
let dropProven = false;
for (const cand of overAccepts) {
  let parserOk = false; try { parse(cand); parserOk = true; } catch { /* */ }
  if (!parserOk) continue;
  ok(!classifyKeeps(cand), `drop case: ${JSON.stringify(cand)} is parser-accepted but parse5-REJECTS → classify DROPS it`);
  dropProven = true;
}
ok(dropProven, 'drop case: at least one real parser-over-accept is parser-accepted and confirmed dropped');
// and the dual: the oracle-VALID minimal repro is KEPT (not dropped) — the keep/drop split is real.
ok(classifyKeeps('<A A=""/>'), 'keep/drop split: the oracle-VALID `<A A="">`-shape repro is KEPT (not dropped)');

// ── (A) determinism of the rendered artifact: two builds byte-identical ──
console.log('\n  determinism (two full ledger builds)…');
const run = () => execFileSync('node', ['test/gap-ledger.ts'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
const a = run(), b = run();
ok(a === b, `two \`node test/gap-ledger.ts\` runs produce byte-identical output (${a.length} bytes)`);

console.log(failures ? `\n${failures} self-test failure(s).` : '\nAll gap-ledger self-tests passed.');
process.exit(failures ? 1 : 0);

// ── helper: detect the self-close `/` divergence on `text`, returning its signature ──
function probeDivergence(text: string): { target: string } | null {
  let cst; try { cst = parse(text); } catch { return null; }
  let toks; try { toks = tmTokenize(probe.tm, text); } catch { return null; }
  const leaves = leafRoles(grammar, cst, probe.roleOf);
  const vs = collectViolations({ input: text, strategy: 'fuzz', cst, toks, leaves, anchored: probe.anchored });
  const v = vs.find((x) => !isGated(x));
  return v ? { target: sig(v) } : null;
}
