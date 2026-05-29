import { writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { generateTmLanguage } from './gen-tm.ts';
import type { CstGrammar, RuleExpr } from './types.ts';

const file = process.argv[2];
if (!file) {
  console.error('Usage: tsx src/cli.ts <grammar.ts>');
  process.exit(1);
}

const mod = await import(resolve(file));
const grammar = mod.default as CstGrammar & { name?: string };
const langName = grammar.name ?? basename(file, '.ts');

console.log(`Parsed ${file}:`);
console.log(`  ${grammar.tokens.length} tokens`);
console.log(`  ${grammar.precs.length} precedence levels`);
console.log(`  ${grammar.rules.length} rules`);
console.log();

// Dump parsed model
console.log('── Tokens ──');
for (const t of grammar.tokens) {
  const flags = t.flags.length > 0 ? `  @${t.flags.join(' @')}` : '';
  console.log(`  ${t.name}: /${t.pattern}/${flags}`);
}

console.log('\n── Precedence ──');
for (const p of grammar.precs) {
  const ops = p.operators.map(o => {
    const pos = o.position !== 'infix' ? `${o.position} ` : '';
    return `${pos}'${o.value}'`;
  }).join(' ');
  console.log(`  ${p.assoc}: ${ops}`);
}

console.log('\n── Rules ──');
for (const r of grammar.rules) {
  console.log(`  ${r.name} = ${formatExpr(r.body)}`);
}

// Generate TextMate grammar
const tm = generateTmLanguage(grammar, langName);
const outPath = join(dirname(file), `${langName}.tmLanguage.json`);
writeFileSync(outPath, JSON.stringify(tm, null, 2) + '\n');
console.log(`\n→ Generated ${outPath}`);

function formatExpr(expr: RuleExpr): string {
  switch (expr.type) {
    case 'literal': return `'${expr.value}'`;
    case 'ref': return expr.name;
    case 'op': return 'op';
    case 'prefix': return 'prefix';
    case 'postfix': return 'postfix';
    case 'seq': return expr.items.map(formatExpr).join(' ');
    case 'alt': return expr.items.map(formatExpr).join(' | ');
    case 'quantifier': return `${formatExpr(expr.body)}${expr.kind}`;
    case 'group': return `(${formatExpr(expr.body)})`;
    case 'sep': return `sep(${formatExpr(expr.element)}, '${expr.delimiter}')`;
  }
}
