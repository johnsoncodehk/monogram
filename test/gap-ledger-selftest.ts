// ─────────────────────────────────────────────────────────────────────────────
//  gap-ledger-selftest.ts — asserts the gap ledger's load-bearing behaviours,
//  independent of how many gaps the SHIPPED grammars happen to surface:
//
//   (A) the DETECT → MINIMIZE → CLASSIFY-KEEP path — on a deliberately-PERTURBED copy
//       of the html grammar (the attribute value-context `end` rolled back to its pre-fix
//       form, reintroducing the monogram#24 self-close `/`-as-string gap), the ledger
//       DETECTS the divergence, ddmin-MINIMIZES it to `<A A=""/>`, and CLASSIFY-KEEPS it
//       (parse5 accepts the repro). The fixture is a CONSTRUCTED divergence, not a live
//       bug, so the self-test of the MACHINERY stays decoupled from whether the shipped
//       grammar is currently clean — fixing the real bug must not break this test. The
//       DUAL (the shipped grammar does NOT diverge on the same shape) is asserted too.
//
//   (B) the oracle CLASSIFY DROP-PATH — a divergence whose minimized repro the external
//       oracle REJECTS (a parser over-accept, not a real highlighter gap) is DROPPED,
//       not filed. We assert the ledger's keep/drop predicate (`oracleAccepts(repro)`)
//       routes a parser OVER-ACCEPT (a markup the Monogram parser accepts but parse5
//       REJECTS — `< a/>`, `<:a/>`) to DROP, and the oracle-VALID `<A A="">`-shape to KEEP.
//
//   (C) DETERMINISM — `generateInputs` + ddmin + fingerprint are a pure function of the
//       grammar, so two full ledger builds are byte-identical (asserted over the rendered
//       artifact by building it twice).
//
//  Run (bare node):  node test/gap-ledger-selftest.ts
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser } from '../src/gen-parser.ts';
import type { CstGrammar } from '../src/types.ts';
import { buildRoleMap, anchoredScopes, leafRoles, collectViolations, isGated } from './generative-detect.ts';
import { loadTm, tmTokenize, reproStillDiverges, sig, minimize, LANGS, type Probe } from './gap-ledger.ts';

let failures = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${msg}`); if (!cond) failures++; };

// ── build the HTML probe (the cheapest grammar to drive the ledger machinery) ──
const htmlCfg = LANGS.find((l) => l.name === 'html')!;
const grammar = (await import(htmlCfg.module)).default as CstGrammar;
const { parse } = createParser(grammar);
const tm = await loadTm(htmlCfg.scopeName, { [htmlCfg.scopeName]: htmlCfg.tmPath, ...(htmlCfg.tmExtra ?? {}) });
if (!tm) throw new Error('failed to load html grammar');
const probe: Probe = { parse, tm, grammar, roleOf: buildRoleMap(grammar), anchored: anchoredScopes(grammar) };

// the ledger's CLASSIFY predicate, verbatim: keep iff the oracle accepts the minimal repro as VALID.
const classifyKeeps = (text: string) => htmlCfg.oracleAccepts(text);

// ── a deliberately-PERTURBED HTML probe — the SAME flat grammar, but with the attribute value-context
// `end` rolled back so a self-close `/` glued after a closing quote is painted `string.unquoted` again
// (the monogram#24 self-close gap, since FIXED in the shipped grammar). This is the keep-path FIXTURE:
// the self-test of the ledger MACHINERY (detect → minimize → classify-keep) must not be coupled to the
// shipped grammar still CONTAINING that bug — else "fix the bug" and "keep this test green" would be
// mutually exclusive. Perturbing a copy proves the machinery on a KNOWN-CONSTRUCTED divergence,
// independent of whether the real grammar is currently clean. (The drop-path + keep/drop split below
// still run against the REAL grammar.)
const perturbedProbe: Probe = await (async () => {
  const raw = JSON.parse(readFileSync(htmlCfg.tmPath, 'utf8'));
  let rolled = 0;
  for (const p of raw.repository?.attribute?.patterns ?? []) {
    // the `= value` region: drop the `(?<=[quotes])(?=/)` self-close release arm, reverting to the
    // pre-fix `end` that lets the unquoted fallback swallow a `/` glued after a closing quote.
    if (typeof p.begin === 'string' && /^\(=\)/.test(p.begin) && typeof p.end === 'string' && /\(\?<=/.test(p.end)) {
      p.end = p.end.replace(/\|\(\?<=\[[^\]]*\]\)\(\?=[^)]*\)\s*$/, '');
      rolled++;
    }
  }
  if (!rolled) throw new Error('perturbed-probe: could not find the value-context `end` to roll back (grammar shape changed?)');
  const dir = mkdtempSync(join(tmpdir(), 'gap-ledger-selftest-'));
  const file = join(dir, 'html-perturbed.tmLanguage.json');
  writeFileSync(file, JSON.stringify(raw));
  // Load with the perturbed file under the host scope AND redirect every embed entry that pointed
  // BACK at the html grammar (the `source.css → html.tmLanguage.json` self-reference) to the perturbed
  // copy too — vscode-textmate shares rule state across a recursive self-embed, so the `/`-after-quote
  // tokenization only reverts when the self-referenced grammar is the perturbed one as well (the same
  // consistency the real ledger has, where both mappings resolve to the one file).
  const extra = Object.fromEntries(Object.entries(htmlCfg.tmExtra ?? {}).map(([sn, p]) => [sn, p === htmlCfg.tmPath ? file : p]));
  const ptm = await loadTm(htmlCfg.scopeName, { [htmlCfg.scopeName]: file, ...extra });
  if (!ptm) throw new Error('perturbed-probe: failed to load');
  return { parse, tm: ptm, grammar, roleOf: probe.roleOf, anchored: probe.anchored };
})();

console.log('gap-ledger self-test\n');

// ── (B1) the canonical KEPT case: `<a b="c"/>`-shape, oracle-valid, diverges on the PERTURBED grammar ──
const keptInput = '<aA aA = "a"/>';   // the generator's tight-markup shape
{
  // detect the divergence on the perturbed probe, minimize, classify (the real CLASSIFY predicate)
  const v0 = probeDivergence(perturbedProbe, keptInput);
  ok(!!v0, `kept case: a self-close \`/\` divergence is detected on ${JSON.stringify(keptInput)} (perturbed grammar)`);
  if (v0) {
    const repro = minimize(perturbedProbe, keptInput, v0.target);
    ok(!!reproStillDiverges(perturbedProbe, repro, v0.target), `kept case: minimized repro ${JSON.stringify(repro)} still diverges`);
    ok(classifyKeeps(repro), `kept case: parse5 ACCEPTS the minimized repro → KEEP (a real highlighter gap)`);
  }
  // and the DUAL the fix guarantees: the SHIPPED grammar no longer diverges on this shape (BUG #1 fixed).
  ok(!probeDivergence(probe, keptInput), `kept case: the SHIPPED grammar does NOT diverge on ${JSON.stringify(keptInput)} (self-close fixed)`);
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

// ── helper: detect the self-close `/` divergence on `text` (against probe `p`), returning its signature ──
function probeDivergence(p: Probe, text: string): { target: string } | null {
  let cst; try { cst = p.parse(text); } catch { return null; }
  let toks; try { toks = tmTokenize(p.tm, text); } catch { return null; }
  const leaves = leafRoles(p.grammar, cst, p.roleOf);
  const vs = collectViolations({ input: text, strategy: 'fuzz', cst, toks, leaves, anchored: p.anchored });
  const v = vs.find((x) => !isGated(x));
  return v ? { target: sig(v) } : null;
}
