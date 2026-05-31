import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { generateTmLanguage } from './gen-tm.ts';
import { generateLanguageConfig } from './gen-vscode-config.ts';
import { generateTreeSitter } from './gen-treesitter.ts';
import { generateMonarch } from './gen-monarch.ts';
import { generateAstTypes } from './gen-ast-types.ts';
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

// Generate VS Code language configuration (editor behaviors)
const langConfig = generateLanguageConfig(grammar);
const cfgPath = join(dirname(file), `${langName}.language-configuration.json`);
writeFileSync(cfgPath, JSON.stringify(langConfig, null, 2) + '\n');
console.log(`→ Generated ${cfgPath}`);

// ── Parser-ecosystem + type targets (one grammar → every ecosystem) ──
const emit = (rel: string, content: string) => {
  const full = join(dirname(file), rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content.endsWith('\n') ? content : content + '\n');
  console.log(`→ Generated ${full}`);
};

// The tree-sitter and Monarch generators target token-stream languages; they do not
// yet understand markup-mode grammars (HTML/Vue), so skip them there rather than emit
// a wrong artifact. The TextMate grammar (markup-aware) + language-config + CST types
// above/below are correct for markup. (Markup support for these two is a later block.)
if (!grammar.markup) {
  // tree-sitter: grammar.js + highlight queries + external scanner scaffold.
  // Namespaced under tree-sitter/<name>/ so multiple grammars coexist (a
  // tree-sitter package keeps grammar.js + queries/ + src/ together).
  const treeSitter = generateTreeSitter(grammar, langName);
  emit(`tree-sitter/${langName}/grammar.js`, treeSitter.grammarJs);
  emit(`tree-sitter/${langName}/queries/highlights.scm`, treeSitter.highlightsScm);
  emit(`tree-sitter/${langName}/src/scanner.c`, treeSitter.scannerC);
  // A package.json so `tree-sitter generate`/`build` can load grammar.js as CommonJS
  // (the repo root is "type":"module", which would otherwise treat .js as ESM and
  // fail on `module.exports`). Minimal — just enough to build the wasm in CI.
  emit(`tree-sitter/${langName}/package.json`,
    JSON.stringify({ name: `tree-sitter-${langName}`, version: '0.0.0', private: true }, null, 2));

  // Monaco Monarch tokenizer
  emit(`${langName}.monarch.json`, JSON.stringify(generateMonarch(grammar), null, 2));
} else {
  console.log('→ Skipped tree-sitter + Monarch (markup grammar — generators are token-stream only for now)');
}

// CST node types (TypeScript) — generic over rules, fine for markup too.
emit(`${langName}.cst-types.ts`, generateAstTypes(grammar));

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
    case 'not': return `not(${formatExpr(expr.body)})`;
    case 'sameLine': return 'sameLine';
    case 'sep': return `sep(${formatExpr(expr.element)}, '${expr.delimiter}')`;
  }
}
