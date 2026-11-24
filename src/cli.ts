import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { generateLanguageConfig } from './gen-vscode-config.ts';
import { registeredHighlighters, highlighterInput } from './define-highlighter.ts';
import { treeSitterFiles } from './highlighters.ts';
import { generateCstMatch } from './gen-cst-match.ts';
import type { Grammar, RuleExpr } from './types.ts';
import { tokenPatternSource } from './token-pattern.ts';
import { decisionReport } from './decision-report.ts';

// `--decisions` also writes <name>.decisions.md: how the generated parser decides every choice
// point, with the dead alternatives and declaration-order ties to act on (src/decision-report.ts).
// It is a diagnostic for the grammar's author, not an artifact a consumer ships, so it is not in
// the default output set that `npm run gen` commits.
//
// `--shape <shape.ts>` checks a shape (the module's default export, a `defineShape` result: see
// docs/SHAPE.md) against the grammar and prints its coverage: every arm mapped, left out and
// reached from the entry rule (with a term to start from), or left out and not reached.
// `--shape-skeleton` prints a complete shape module mapping every arm to a node of its named
// children: the file to start a shape from. Both write no artifact.
const args = process.argv.slice(2);
const decisions = args.includes('--decisions');
const shapeAt = args.indexOf('--shape');
const shapeFile = shapeAt >= 0 ? args[shapeAt + 1] : undefined;
const file = args.find((a, i) => !a.startsWith('--') && (shapeAt < 0 || i !== shapeAt + 1));
if (!file || (shapeAt >= 0 && (!shapeFile || shapeFile.startsWith('--')))) {
  console.error('Usage: node src/cli.ts <grammar.ts> [--decisions] | <grammar.ts> --shape <shape.ts> | <grammar.ts> --shape-skeleton');
  process.exit(1);
}

const mod = await import(resolve(file));
const grammar = mod.default as Grammar;
const langName = grammar.name;

if (args.includes('--shape-skeleton')) {
  const { shapeSkeleton } = await import('./shape-coverage.ts');
  console.log(shapeSkeleton(grammar, `./${basename(file)}`));
  process.exit(0);
}
if (shapeFile) {
  const { shapeCoverage, coverageReport } = await import('./shape-coverage.ts');
  // Loading the module runs defineShape: a spec that does not fit throws ShapeSpecError here.
  const shape = (await import(resolve(shapeFile))).default as import('./shape2-eval.ts').Shape;
  if (shape?.source !== grammar) {
    console.error(`${shapeFile}: its default export is not a shape defined on ${file} (export default defineShape(grammar, { ... }) with grammar imported from ${file})`);
    process.exit(1);
  }
  console.log(coverageReport(shapeCoverage(shape)));
  process.exit(0);
}

console.log(`Parsed ${file}:`);
console.log(`  ${grammar.tokens.length} tokens`);
console.log(`  ${grammar.precs.length} precedence levels`);
console.log(`  ${grammar.rules.length} rules`);
console.log();

// Dump parsed model
console.log('── Tokens ──');
for (const t of grammar.tokens) {
  const flags = t.flags.length > 0 ? `  @${t.flags.join(' @')}` : '';
  console.log(`  ${t.name}: /${tokenPatternSource(t)}/${flags}`);
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

// ── The highlighters (src/highlighters.ts, registered with defineHighlighter): each renders its
// files from the grammar's highlight facts; a construct one declines is listed with its reason.
const emit = (rel: string, content: string) => {
  const full = join(dirname(file), rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content.endsWith('\n') ? content : content + '\n');
  console.log(`→ Generated ${full}`);
};
const hlInput = highlighterInput(grammar, langName);
console.log();
for (const hl of registeredHighlighters()) {
  for (const f of hl.render(hlInput)) emit(f.path, f.content);
  for (const r of hl.refusals(hlInput)) console.log(`  ${hl.name} refuses ${r.construct}: ${r.reason}`);
}

// Generate VS Code language configuration (editor behaviors)
const langConfig = generateLanguageConfig(grammar);
const cfgPath = join(dirname(file), `${langName}.language-configuration.json`);
writeFileSync(cfgPath, JSON.stringify(langConfig, null, 2) + '\n');
console.log(`→ Generated ${cfgPath}`);

// ── Parser-ecosystem + type targets (one grammar → every ecosystem) ──

// tree-sitter: grammar.js + highlight queries + (optionally) an external scanner.
// Namespaced under tree-sitter/<name>/ so multiple grammars coexist (a tree-sitter
// package keeps grammar.js + queries/ + src/ together). Markup grammars get a
// purpose-built grammar with NO external tokens (v1), so no scanner.c is emitted.
// (The highlight queries are the treesitter-highlights highlighter's, written above.)
const treeSitter = treeSitterFiles(grammar, langName);
emit(`tree-sitter/${langName}/grammar.js`, treeSitter.grammarJs);
if (treeSitter.scannerC.trim()) emit(`tree-sitter/${langName}/src/scanner.c`, treeSitter.scannerC);
emit(`tree-sitter/${langName}/tree-sitter.json`, treeSitter.treeSitterJson);
// A package.json so `tree-sitter generate`/`build` can load grammar.js as CommonJS
// (the repo root is "type":"module", which would otherwise treat .js as ESM and
// fail on `module.exports`). Minimal — just enough to build the wasm in CI.
emit(`tree-sitter/${langName}/package.json`,
  JSON.stringify({ name: `tree-sitter-${langName}`, version: '0.0.0', private: true }, null, 2));

// Per-arm CST destructurers.
emit(`${langName}.cst-match.ts`, generateCstMatch(grammar));

// The decision report (on request).
if (decisions) {
  const { text, findings } = decisionReport(grammar, langName);
  emit(`${langName}.decisions.md`, text);
  console.log(`  ${findings.dead.length} dead alternatives, ${findings.ties.length} declaration-order ties, ${findings.unreached.length} unreached alternatives`);
}

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
    case 'assignTarget': return `assignTarget('${expr.ctx}')`;
    case 'noCommentBefore': return 'noCommentBefore';
    case 'noMultilineFlowBefore': return 'noMultilineFlowBefore';
    case 'notLeftLeaf': return `notLeftLeaf(${expr.words.map(w => `'${w}'`).join(', ')})`;
    case 'sep': return `sep(${formatExpr(expr.element)}, '${expr.delimiter}')`;
  }
}
