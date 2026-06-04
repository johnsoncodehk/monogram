// Throwaway diagnostic: categorize yaml-test-suite inputs as FN (yaml accepts, we reject) /
// FP (yaml rejects, we accept) with Monogram's error, to drive grammar work. Run: node test/yaml-diag.ts
import { readdirSync, readFileSync } from 'node:fs';
import { parse as yamlParse, parseAllDocuments } from 'yaml';
import { createParser } from '../src/gen-parser.ts';
import grammar from '../yaml.ts';

const { parse } = createParser(grammar);
const SUITE = '/tmp/yaml-test-suite/src';
const decode = (s: string) => s.replace(/␣/g, ' ').replace(/—+»/g, '\t').replace(/[↵∎]/g, '');
const corpus: { code: string; origin: string; name: string }[] = [];
for (const f of readdirSync(SUITE).filter((n) => n.endsWith('.yaml'))) {
  try {
    const meta = yamlParse(readFileSync(`${SUITE}/${f}`, 'utf8'));
    for (const t of (Array.isArray(meta) ? meta : [meta])) {
      if (t && typeof t.yaml === 'string') corpus.push({ code: decode(t.yaml), origin: f, name: t.name ?? '' });
    }
  } catch { /* skip */ }
}
const oAccept = (c: string) => { try { return parseAllDocuments(c).every((d: any) => d.errors.length === 0); } catch { return false; } };
const mRes = (c: string) => { try { parse(c); return { ok: true, err: '' }; } catch (e) { return { ok: false, err: String((e as Error).message).split('\n')[0] }; } };

const FN: any[] = [], FP: any[] = [];
let TP = 0, TN = 0;
for (const x of corpus) {
  const o = oAccept(x.code), m = mRes(x.code);
  if (o && m.ok) TP++; else if (o && !m.ok) FN.push({ ...x, err: m.err }); else if (!o && m.ok) FP.push(x); else TN++;
}
console.log(`corpus ${corpus.length}: TP=${TP} FN=${FN.length} FP=${FP.length} TN=${TN}`);

// Group FN by Monogram error message (the failure mode).
const byErr = new Map<string, any[]>();
for (const x of FN) { const k = x.err.replace(/offset \d+/, 'offset N'); (byErr.get(k) ?? byErr.set(k, []).get(k)!).push(x); }
console.log(`\n=== FN grouped by error (${byErr.size} kinds) ===`);
for (const [err, xs] of [...byErr.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n[${xs.length}] ${err}`);
  for (const x of xs.slice(0, 4)) console.log(`   ${JSON.stringify(x.code.slice(0, 60))}`);
}
console.log(`\n=== FP sample (yaml rejects, we accept) — ${FP.length} ===`);
for (const x of FP.slice(0, 18)) console.log(`   ${JSON.stringify(x.code.slice(0, 60))}`);
