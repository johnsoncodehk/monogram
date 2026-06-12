import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { generateTmLanguage, generateMarkupInjection, generateAliasGrammar, generateContributes } from './gen-tm.ts';
import { generateLanguageConfig } from './gen-vscode-config.ts';
import { generateTreeSitter } from './gen-treesitter.ts';
import { generateMonarch } from './gen-monarch.ts';
import { generateAstTypes } from './gen-ast-types.ts';
import { generateCstMatch } from './gen-cst-match.ts';
import type { CstGrammar, RuleExpr } from './types.ts';
import { tokenPatternSource } from './token-pattern.ts';

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

// Generate TextMate grammar
const tm = generateTmLanguage(grammar, langName);
const outPath = join(dirname(file), `${langName}.tmLanguage.json`);
writeFileSync(outPath, JSON.stringify(tm, null, 2) + '\n');
console.log(`\n→ Generated ${outPath}`);

// Markup-injection grammars (Vue directives + interpolation), when the grammar declares
// `markup.inject` — one THIN-STUB file per concern, injected onto the host (HTML) scopes,
// matching the official Vue topology (vue-directives.json / vue-interpolations.json). The
// rule bodies live in the main grammar's repository; these files just include them.
for (const injection of generateMarkupInjection(grammar, langName)) {
  const injPath = join(dirname(file), `${injection.scopeName}.tmLanguage.json`);
  writeFileSync(injPath, JSON.stringify(injection, null, 2) + '\n');
  console.log(`→ Generated ${injPath}`);
}

// Alias grammars — extra files that re-expose this grammar under another scopeName (e.g.
// text.html.derivative for embedded HTML fragments). One thin `{scopeName, include}` file each.
for (const alias of grammar.aliasScopes ?? []) {
  const aliasGrammar = generateAliasGrammar(grammar.scopeName ?? `source.${langName}`, alias.scope);
  const aliasPath = join(dirname(file), `${alias.file}.tmLanguage.json`);
  writeFileSync(aliasPath, JSON.stringify(aliasGrammar, null, 2) + '\n');
  console.log(`→ Generated ${aliasPath}`);
}

// A VS Code `contributes` snippet — packaging that wires all the generated grammars (main +
// injections + aliases) into an editor. For Vue this is what makes the files a drop-in for
// vuejs/language-tools'; emitted only when the grammar declares a `manifest`.
const contributes = generateContributes(grammar, langName);
if (contributes) {
  const cPath = join(dirname(file), `${langName}.contributes.json`);
  writeFileSync(cPath, JSON.stringify({ contributes }, null, 2) + '\n');
  console.log(`→ Generated ${cPath}`);
}

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

// tree-sitter: grammar.js + highlight queries + (optionally) an external scanner.
// Namespaced under tree-sitter/<name>/ so multiple grammars coexist (a tree-sitter
// package keeps grammar.js + queries/ + src/ together). Markup grammars get a
// purpose-built grammar with NO external tokens (v1), so no scanner.c is emitted.
const treeSitter = generateTreeSitter(grammar, langName);
emit(`tree-sitter/${langName}/grammar.js`, treeSitter.grammarJs);
emit(`tree-sitter/${langName}/queries/highlights.scm`, treeSitter.highlightsScm);
if (treeSitter.scannerC.trim()) emit(`tree-sitter/${langName}/src/scanner.c`, treeSitter.scannerC);
// A package.json so `tree-sitter generate`/`build` can load grammar.js as CommonJS
// (the repo root is "type":"module", which would otherwise treat .js as ESM and
// fail on `module.exports`). Minimal — just enough to build the wasm in CI.
emit(`tree-sitter/${langName}/package.json`,
  JSON.stringify({ name: `tree-sitter-${langName}`, version: '0.0.0', private: true }, null, 2));

// Monaco Monarch tokenizer (markup-aware: emits a tag/text/raw-text state machine).
emit(`${langName}.monarch.json`, JSON.stringify(generateMonarch(grammar), null, 2));

// CST node types (TypeScript) — generic over rules, fine for markup too.
emit(`${langName}.cst-types.ts`, generateAstTypes(grammar));

// Per-arm CST destructurers (value-level sibling of the types above).
emit(`${langName}.cst-match.ts`, generateCstMatch(grammar, `./${langName}.cst-types.ts`));

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
    case 'adjacent': return 'adjacent';
    case 'noCommentBefore': return 'noCommentBefore';
    case 'noMultilineFlowBefore': return 'noMultilineFlowBefore';
    case 'sep': return `sep(${formatExpr(expr.element)}, '${expr.delimiter}')`;
  }
}
