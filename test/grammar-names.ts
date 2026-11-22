// REPORT (not a gate yet): for each grammar, the arms, inline branches and children whose name
// src/grammar-names.ts can only derive POSITIONALLY (a numeric suffix: `export2`, `expr2`),
// i.e. the names an author must write with `arm(...)` / `field(...)` for the name to survive an
// edit of an earlier arm or child. One line per finding:
//   rule / arm index [/ branch index] [/ child index] / derived name / why / the arm's syntax
//
//   node test/grammar-names.ts [javascript] [typescript] [--json]
import { nameReport, type NameFinding } from '../src/grammar-names.ts';
import type { RuleExpr } from '../src/types.ts';

const show = (e: RuleExpr, depth = 0): string => {
  if (depth > 3) return '…';
  switch (e.type) {
    case 'literal': return JSON.stringify(e.value);
    case 'ref': return e.name;
    case 'seq': return e.items.map((x) => show(x, depth + 1)).join(' ');
    case 'alt': return `alt(${e.items.map((x) => show(x, depth + 1)).join(' | ')})`;
    case 'quantifier': return `${e.kind === '?' ? 'opt' : e.kind === '*' ? 'many' : 'many1'}(${show(e.body, depth + 1)})`;
    case 'group': return show(e.body, depth);
    case 'sep': return `sep(${show(e.element, depth + 1)}, ${JSON.stringify(e.delimiter)})`;
    case 'not': return `not(…)`;
    default: return e.type;
  }
};

const args = process.argv.slice(2);
const json = args.includes('--json');
const grammars = args.filter((a) => !a.startsWith('--'));
const all: Record<string, (NameFinding & { syntax: string })[]> = {};
for (const g of grammars.length ? grammars : ['javascript', 'typescript']) {
  const grammar = (await import(`../${g}.ts`)).default;
  const findings = nameReport(grammar.rules);
  all[g] = findings.map((f) => {
    const r = grammar.rules.find((x: { name: string }) => x.name === f.rule)!;
    const alts: RuleExpr[] = r.body.type === 'alt' ? r.body.items : [r.body];
    return { ...f, syntax: show(alts[f.arm]).slice(0, 110) };
  });
  if (json) continue;
  const arms = findings.filter((f) => f.kind !== 'child').length;
  console.log(`${g}: ${findings.length} positional names (${arms} arms / branches, ${findings.length - arms} children)`);
  for (const f of all[g]) {
    const where = f.path + (f.child !== undefined ? ` child ${f.child}` : '');
    console.log(`  ${where} / ${f.name} / '${f.clash}' taken earlier in this ${f.kind === 'arm' ? 'rule' : f.kind === 'branch' ? 'alternation' : 'scope'} / ${f.syntax}`);
  }
}
if (json) console.log(JSON.stringify(all, null, 1));
