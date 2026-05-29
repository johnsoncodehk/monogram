import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const TEST_DIR = '/tmp/ts-repo/tests/cases/conformance';

// ── Collect test files ──

function walkDir(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkDir(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

const testFiles = walkDir(TEST_DIR).sort();

// ── Gap patterns: syntax our grammar does NOT define rules for ──
// Grouped by category, ordered by likely impact

interface Gap {
  name: string;
  category: string;
  test: (s: string) => boolean;
  difficulty: 'easy' | 'medium' | 'hard';
  covered?: boolean;
}

const gaps: Gap[] = [
  // ── Destructuring (COVERED — rules added) ──
  { name: 'Object destructuring binding',   category: 'Destructuring', difficulty: 'hard', covered: true,
    test: s => /(?:let|const|var)\s+\{/.test(s) },
  { name: 'Array destructuring binding',    category: 'Destructuring', difficulty: 'hard', covered: true,
    test: s => /(?:let|const|var)\s+\[/.test(s) },
  { name: 'Destructuring in params',        category: 'Destructuring', difficulty: 'hard', covered: true,
    test: s => /\(\s*\{[^}]*\}\s*[,:)]/.test(s) || /\(\s*\[[^\]]*\]\s*[,:)]/.test(s) },
  { name: 'Destructuring in for-of/in',     category: 'Destructuring', difficulty: 'hard', covered: true,
    test: s => /for\s*\(\s*(?:const|let|var)\s+[\[{]/.test(s) },
  { name: 'Default values in destructuring', category: 'Destructuring', difficulty: 'hard', covered: true,
    test: s => /\{\s*\w+\s*=\s*[^=]/.test(s) && /(?:let|const|var|function|\()/.test(s) },

  // ── Statements (COVERED) ──
  { name: 'Labeled statement',              category: 'Statements', difficulty: 'easy', covered: true,
    test: s => /^\s*[a-zA-Z_$]\w*\s*:\s*(?:for|while|do|switch)/m.test(s) },
  { name: 'debugger statement',             category: 'Statements', difficulty: 'easy', covered: true,
    test: s => /^\s*debugger\s*;?\s*$/m.test(s) },
  { name: 'with statement',                 category: 'Statements', difficulty: 'easy', covered: true,
    test: s => /\bwith\s*\(/.test(s) },
  { name: 'Empty statement (bare ;)',        category: 'Statements', difficulty: 'easy', covered: true,
    test: s => /^\s*;\s*$/m.test(s) },

  // ── Type features ──
  { name: 'Index signature [k: T]: V',      category: 'Types', difficulty: 'medium', covered: true,
    test: s => /\[\s*\w+\s*:\s*(?:string|number|symbol)\s*\]\s*:/.test(s) },
  { name: 'Conditional type extends?:',      category: 'Types', difficulty: 'medium', covered: true,
    test: s => /\bextends\b[^{]*\?\s*\S[^;]*\s*:/.test(s) && /\btype\b/.test(s) },
  { name: 'Mapped type {[K in T]: V}',      category: 'Types', difficulty: 'medium', covered: true,
    test: s => /\{\s*\[?\s*\w+\s+in\s+/.test(s) },
  { name: 'infer keyword',                  category: 'Types', difficulty: 'medium', covered: true,
    test: s => /\binfer\s+[A-Z]/.test(s) },
  { name: 'Template literal type',          category: 'Types', difficulty: 'medium', covered: true,
    test: s => /type\s+\w+[^=]*=\s*`/.test(s) },
  { name: 'Type predicate (x is T)',        category: 'Types', difficulty: 'easy', covered: true,
    test: s => /\)\s*:\s*\w+\s+is\s+\w/.test(s) },
  { name: 'asserts keyword',                category: 'Types', difficulty: 'easy', covered: true,
    test: s => /\basserts\s+\w+/.test(s) },
  { name: 'import type / export type',      category: 'Types', difficulty: 'easy', covered: true,
    test: s => /\b(?:import|export)\s+type\s+[{A-Z]/.test(s) },
  { name: 'satisfies operator',             category: 'Types', difficulty: 'easy', covered: true,
    test: s => /\bsatisfies\s+\w/.test(s) },

  // ── Expression features ──
  { name: 'Template literal ${expr}',       category: 'Expressions', difficulty: 'hard', covered: true,
    test: s => /`[^`]*\$\{/.test(s) },
  { name: 'Default parameter value',        category: 'Expressions', difficulty: 'easy', covered: true,
    test: s => /\(\s*\w+\s*(?::\s*\w[^)]*?)?\s*=[^=>][^)]*\)/.test(s) },
  { name: 'Optional chaining ?.( / ?.[',    category: 'Expressions', difficulty: 'easy', covered: true,
    test: s => /\?\.\s*[\[(]/.test(s) },
  { name: 'Dynamic import()',               category: 'Expressions', difficulty: 'easy', covered: true,
    test: s => /\bimport\s*\(/.test(s) },
  { name: 'import.meta',                    category: 'Expressions', difficulty: 'easy', covered: true,
    test: s => /\bimport\s*\.\s*meta\b/.test(s) },
  { name: 'Tagged template f`...`',         category: 'Expressions', difficulty: 'medium', covered: true,
    test: s => /\w\s*`/.test(s) && /`[^`]*\$\{/.test(s) },
  { name: 'Comma operator',                 category: 'Expressions', difficulty: 'easy', covered: true,
    test: s => /\breturn\s*\(.*,.*\)\s*;/.test(s) },
  { name: 'Class expression',               category: 'Expressions', difficulty: 'medium', covered: true,
    test: s => /=\s*class\s*(?:\w+\s*)?\{/.test(s) },
  { name: 'Function expression',            category: 'Expressions', difficulty: 'easy', covered: true,
    test: s => /=\s*function\s*\w*\s*[\(<]/.test(s) },
  { name: 'void expression',                category: 'Expressions', difficulty: 'easy', covered: true,
    test: s => /\bvoid\s+\w/.test(s) },

  // ── Declaration features ──
  { name: 'export default',                 category: 'Declarations', difficulty: 'easy', covered: true,
    test: s => /\bexport\s+default\b/.test(s) },
  { name: 'export * / re-export',           category: 'Declarations', difficulty: 'easy', covered: true,
    test: s => /\bexport\s+\*/.test(s) || /\bexport\s+\{[^}]+\}\s+from\b/.test(s) },
  { name: 'export = / import =',            category: 'Declarations', difficulty: 'easy', covered: true,
    test: s => /\bexport\s*=/.test(s) || /\bimport\s+\w+\s*=\s*require/.test(s) },
  { name: 'const enum',                     category: 'Declarations', difficulty: 'easy', covered: true,
    test: s => /\bconst\s+enum\b/.test(s) },
  { name: 'Class static block',             category: 'Declarations', difficulty: 'medium', covered: true,
    test: s => /\bstatic\s*\{/.test(s) },
  { name: 'Call/construct signature',        category: 'Declarations', difficulty: 'medium', covered: true,
    test: s => /(?:interface|type)[^{]*\{[^}]*(?:new\s*\(|^\s*\()/ms.test(s) },
  { name: 'Method overloads',               category: 'Declarations', difficulty: 'medium', covered: true,
    test: s => /\w+\s*\([^)]*\)\s*:\s*\w[^{;]*;\s*\n\s*\w+\s*\(/m.test(s) },
  { name: 'using / await using',            category: 'Declarations', difficulty: 'easy', covered: true,
    test: s => /\b(?:await\s+)?using\s+\w+\s*=/.test(s) },
  { name: 'accessor keyword',               category: 'Declarations', difficulty: 'easy', covered: true,
    test: s => /\baccessor\s+\w+/.test(s) },

  // ── Class features ──
  { name: 'Parameter properties',           category: 'Classes', difficulty: 'easy', covered: true,
    test: s => /constructor\s*\([^)]*\b(?:public|private|protected|readonly)\b/.test(s) },
  { name: 'Decorators with args @f()',       category: 'Classes', difficulty: 'easy', covered: true,
    test: s => /@\w+\s*\([^)]*\)/.test(s) },
];

// ── Scan ──

console.log(`Scanning ${testFiles.length} conformance test files...\n`);

const gapHits = new Map<string, { count: number; examples: string[] }>();
for (const g of gaps) gapHits.set(g.name, { count: 0, examples: [] });

let filesWithGaps = 0;

for (const file of testFiles) {
  const source = readFileSync(file, 'utf-8');
  const rel = relative(TEST_DIR, file);
  let hasGap = false;

  for (const g of gaps) {
    if (g.test(source)) {
      const hit = gapHits.get(g.name)!;
      hit.count++;
      if (hit.examples.length < 3) hit.examples.push(rel);
      hasGap = true;
    }
  }

  if (hasGap) filesWithGaps++;
}

// ── Report ──

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Monogram — Parser Gap Analysis');
console.log(`  ${testFiles.length} TypeScript conformance tests → ${filesWithGaps} files with gaps`);
console.log('═══════════════════════════════════════════════════════════════\n');

const categories = [...new Set(gaps.map(g => g.category))];
const allHitsRaw = gaps.map(g => ({ ...g, ...gapHits.get(g.name)! })).filter(g => g.count > 0);

// Recompute filesWithGaps excluding covered constructs
let filesWithRemainingGaps = 0;
for (const file of testFiles) {
  const source = readFileSync(file, 'utf-8');
  let hasUncoveredGap = false;
  for (const g of gaps) {
    if (g.covered) continue;
    if (g.test(source)) { hasUncoveredGap = true; break; }
  }
  if (hasUncoveredGap) filesWithRemainingGaps++;
}

// ── Covered constructs ──
const coveredHits = allHitsRaw.filter(g => g.covered && g.count > 0);
if (coveredHits.length > 0) {
  const covTotal = coveredHits.reduce((s, g) => s + g.count, 0);
  console.log(`── COVERED (in grammar) ──  (${covTotal} file hits)\n`);
  for (const g of coveredHits.sort((a, b) => b.count - a.count)) {
    const pct = ((g.count / testFiles.length) * 100).toFixed(1);
    console.log(`  ✓ ${g.name.padEnd(38)} ${String(g.count).padStart(4)} files  (${pct}%)`);
  }
  console.log();
}

// ── Remaining gaps ──
let totalGapFiles = 0;

for (const cat of categories) {
  const catGaps = gaps.filter(g => g.category === cat && !g.covered);
  const catHits = catGaps
    .map(g => ({ ...g, ...gapHits.get(g.name)! }))
    .filter(g => g.count > 0)
    .sort((a, b) => b.count - a.count);

  if (catHits.length === 0) continue;

  const catTotal = catHits.reduce((s, g) => s + g.count, 0);
  totalGapFiles += catTotal;

  console.log(`── ${cat} ──  (${catTotal} hits)\n`);

  for (const g of catHits) {
    const pct = ((g.count / testFiles.length) * 100).toFixed(1);
    const diff = g.difficulty === 'easy' ? '●' : g.difficulty === 'medium' ? '◐' : '○';
    console.log(`  ${diff} ${g.name.padEnd(38)} ${String(g.count).padStart(4)} files  (${pct}%)  [${g.difficulty}]`);
  }
  console.log();
}

// ── Difficulty summary ──
const allHits = allHitsRaw.filter(g => !g.covered);
const easy   = allHits.filter(g => g.difficulty === 'easy');
const medium = allHits.filter(g => g.difficulty === 'medium');
const hard   = allHits.filter(g => g.difficulty === 'hard');

const easyFiles   = easy.reduce((s, g) => s + g.count, 0);
const mediumFiles = medium.reduce((s, g) => s + g.count, 0);
const hardFiles   = hard.reduce((s, g) => s + g.count, 0);

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Summary');
console.log('═══════════════════════════════════════════════════════════════\n');
const coveredCount = coveredHits.reduce((s, g) => s + g.count, 0);
console.log(`  Total test files:        ${testFiles.length}`);
console.log(`  Files fully covered:     ${testFiles.length - filesWithRemainingGaps}  (${(((testFiles.length - filesWithRemainingGaps) / testFiles.length) * 100).toFixed(1)}%)`);
console.log(`  Files with gaps:         ${filesWithRemainingGaps}  (${((filesWithRemainingGaps / testFiles.length) * 100).toFixed(1)}%)`);
console.log(`  Recently covered:        ${coveredHits.length} constructs (${coveredCount} file hits)`);
console.log();
console.log(`  Remaining gaps:`);
console.log(`  ● Easy:    ${easy.length.toString().padStart(2)} constructs  (${easyFiles} file hits)    — add rule/keyword`);
console.log(`  ◐ Medium:  ${medium.length.toString().padStart(2)} constructs  (${mediumFiles} file hits)    — new rule + patterns`);
console.log(`  ○ Hard:    ${hard.length.toString().padStart(2)} constructs  (${hardFiles} file hits)    — recursive patterns / new concepts`);
console.log();

// ── What closing easy gaps would achieve ──
let onlyEasyGapFiles = 0;
for (const file of testFiles) {
  const source = readFileSync(file, 'utf-8');
  let hasHard = false;
  let hasMedium = false;
  let hasAny = false;
  for (const g of gaps) {
    if (g.covered) continue;
    if (!g.test(source)) continue;
    hasAny = true;
    if (g.difficulty === 'hard') hasHard = true;
    if (g.difficulty === 'medium') hasMedium = true;
  }
  if (hasAny && !hasHard && !hasMedium) onlyEasyGapFiles++;
}

const afterEasy = testFiles.length - filesWithRemainingGaps + onlyEasyGapFiles;
console.log(`\n  After closing ● easy:    ${afterEasy}/${testFiles.length} files covered (${((afterEasy / testFiles.length) * 100).toFixed(1)}%)`);
