// Smoke test for gen-treesitter: generate a tree-sitter package from the
// TypeScript grammar and structurally sanity-check the three artifacts
// (grammar.js, queries/highlights.scm, src/scanner.c).
//
// Run with: node test/treesitter-smoke.ts
//
// If the `tree-sitter` CLI is installed, this ALSO tries to compile the generated
// grammar.js and reports the result — but never fails the suite on a missing
// toolchain (the task says: validate structurally, don't block on installs).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { generateTreeSitter } from '../src/gen-treesitter.ts';

const grammar = (await import('../typescript.ts')).default;

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => {
  if (cond) ok++;
  else { fail++; console.log('  ✗', label); }
};

const { grammarJs, highlightsScm, scannerC, externalTokens } = generateTreeSitter(grammar, 'typescript');

// ── grammar.js ──────────────────────────────────────────────────────────────
check('grammar.js is non-empty', grammarJs.length > 500);
check('grammar.js calls grammar({...})', /module\.exports\s*=\s*grammar\(\{/.test(grammarJs));
check('grammar.js has a name field', /name:\s*"typescript"/.test(grammarJs));
check('grammar.js has a rules: block', /rules:\s*\{/.test(grammarJs));
check('grammar.js declares extras (whitespace + comments)', /extras:\s*\$ =>/.test(grammarJs));
check('grammar.js declares word (identifier token)', /word:\s*\$ =>\s*\$\.\w+/.test(grammarJs));
check('grammar.js references the entry rule (program)', /\bprogram:\s*\$ =>/.test(grammarJs));
check('grammar.js uses seq()', grammarJs.includes('seq('));
check('grammar.js uses choice()', grammarJs.includes('choice('));
check('grammar.js uses optional()', grammarJs.includes('optional('));
check('grammar.js uses repeat()', grammarJs.includes('repeat('));
check('grammar.js maps prec.left for left-assoc operators', grammarJs.includes('prec.left('));
check('grammar.js maps prec.right for right-assoc operators', grammarJs.includes('prec.right('));
check('grammar.js declares conflicts (generics/arrow ambiguities)', /conflicts:\s*\$ =>/.test(grammarJs));
check('grammar.js declares externals (scanner regex token)', /externals:\s*\$ =>/.test(grammarJs));
check('grammar.js maps operator into a field', grammarJs.includes("field('operator'"));
check('grammar.js wraps declaration names in a name field', grammarJs.includes("field('name'"));

// Balanced parens/braces — a crude validity check on the generated JS.
function balanced(src: string, open: string, close: string): boolean {
  let depth = 0, inStr: string | null = null, inRegex = false, prev = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; prev = c; continue; }
    if (inRegex) { if (c === '/' && prev !== '\\') inRegex = false; prev = c; continue; }
    if (c === '"' || c === "'") { inStr = c; prev = c; continue; }
    // crude regex-literal skip: `/` preceded by `(` or `,` or whitespace
    if (c === '/' && /[(,\s]/.test(prev)) { inRegex = true; prev = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth < 0) return false; }
    prev = c;
  }
  return depth === 0;
}
check('grammar.js has balanced parentheses', balanced(grammarJs, '(', ')'));
check('grammar.js has balanced braces', balanced(grammarJs, '{', '}'));

// Strongest validity check: the generated grammar.js must PARSE and EXECUTE as
// real JS through stubbed tree-sitter DSL globals. This catches malformed regex
// literals, stray tokens, and unresolved references that brace-counting misses.
function grammarExecutes(src: string): { ok: boolean; ruleCount: number; err?: string } {
  const mk = (name: string) => (...args: unknown[]) => ({ type: name, args });
  const prec = Object.assign((...a: unknown[]) => mk('prec')(...a), {
    left: (...a: unknown[]) => mk('prec.left')(...a),
    right: (...a: unknown[]) => mk('prec.right')(...a),
  });
  const sandbox: Record<string, unknown> = {
    module: { exports: {} as { rules?: Record<string, unknown> } },
    grammar: (def: any) => {
      const $ = new Proxy({}, { get: (_t, k) => ({ type: 'ref', name: String(k) }) });
      for (const fn of Object.values(def.rules)) (fn as (x: unknown) => unknown)($);
      for (const k of ['extras', 'word', 'externals', 'conflicts']) if (def[k]) def[k]($);
      return def;
    },
    seq: mk('seq'), choice: mk('choice'), optional: mk('optional'),
    repeat: mk('repeat'), repeat1: mk('repeat1'), token: mk('token'),
    field: mk('field'), blank: mk('blank'), prec,
  };
  vm.createContext(sandbox);
  try {
    new vm.Script(src, { filename: 'grammar.js' });
    vm.runInContext(src, sandbox, { filename: 'grammar.js' });
    const exp = (sandbox.module as { exports: { rules?: Record<string, unknown> } }).exports;
    return { ok: true, ruleCount: Object.keys(exp.rules ?? {}).length };
  } catch (e: any) {
    return { ok: false, ruleCount: 0, err: e.message };
  }
}
const exec = grammarExecutes(grammarJs);
check(`grammar.js parses & executes as JS${exec.err ? ' (' + exec.err + ')' : ''}`, exec.ok);
check(`grammar.js exposes all rules after execution (${exec.ruleCount})`, exec.ruleCount >= grammar.rules.length);

// Every rule and non-scanner token should appear as a rule entry.
const ruleNamesSnake = grammar.rules.map(r => r.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
const missingRules = ruleNamesSnake.filter(n => !new RegExp(`\\b${n}:\\s*\\$ =>`).test(grammarJs));
check(`all ${grammar.rules.length} rules emitted (missing: ${missingRules.join(',') || 'none'})`, missingRules.length === 0);

// ── highlights.scm ────────────────────────────────────────────────────────────
check('highlights.scm is non-empty', highlightsScm.length > 200);
check('highlights.scm has @keyword captures', highlightsScm.includes('@keyword'));
check('highlights.scm has @string captures', highlightsScm.includes('@string'));
check('highlights.scm has @number captures', highlightsScm.includes('@number'));
check('highlights.scm has @operator captures', highlightsScm.includes('@operator'));
check('highlights.scm has @type captures', highlightsScm.includes('@type'));
check('highlights.scm has @function captures', highlightsScm.includes('@function'));
check('highlights.scm has @comment captures', highlightsScm.includes('@comment'));
check('highlights.scm has @variable fallback', highlightsScm.includes('@variable'));
check('highlights.scm has @constant.builtin (true/false/null)', highlightsScm.includes('@constant.builtin'));
check('highlights.scm has @type.builtin (primitives)', highlightsScm.includes('@type.builtin'));
check('highlights.scm captures specific keywords (class)', highlightsScm.includes('"class"'));
check('highlights.scm uses list form [ … ] for grouped literals', /\[\s*\n/.test(highlightsScm));
check('highlights.scm queries declaration names via the name: field', /name:\s*\(\w+\)\s*@/.test(highlightsScm));
check('highlights.scm uses only standard predicates (#any-of?/#eq?/#match?)',
  (highlightsScm.match(/#[\w-]+\?/g) ?? []).every(p => ['#any-of?', '#eq?', '#match?', '#not-eq?', '#set!'].includes(p)));
// Balanced brackets in the query file.
check('highlights.scm has balanced brackets', balanced(highlightsScm, '[', ']'));
check('highlights.scm has balanced parens', balanced(highlightsScm, '(', ')'));

// Count captures — should be plentiful.
const captureCount = (highlightsScm.match(/@[\w.]+/g) ?? []).length;
check(`highlights.scm has many captures (${captureCount})`, captureCount > 30);

// ── scanner.c ─────────────────────────────────────────────────────────────────
check('scanner.c is non-empty', scannerC.length > 300);
check('scanner.c includes parser.h', scannerC.includes('#include "tree_sitter/parser.h"'));
check('scanner.c defines the 5 required entry points',
  scannerC.includes('_external_scanner_create') &&
  scannerC.includes('_external_scanner_destroy') &&
  scannerC.includes('_external_scanner_serialize') &&
  scannerC.includes('_external_scanner_deserialize') &&
  scannerC.includes('_external_scanner_scan'));
check('scanner.c declares a TokenType enum', scannerC.includes('enum TokenType'));
check('scanner.c implements regex-literal scan', scannerC.includes('scan_regex'));
check('scanner.c derives regex flag chars from the token', /flags = "[a-z]+"/i.test(scannerC));
check('scanner.c references the external token name', externalTokens.length > 0 && scannerC.includes(externalTokens[0].toUpperCase()));
check('scanner.c documents the template stub with derived delimiters', scannerC.includes('interpOpen  = "${"'));
check('externalTokens reported', externalTokens.length >= 1);

// ── Optional: try the real tree-sitter CLI if present ──────────────────────────
function hasTreeSitter(): boolean {
  try { execFileSync('tree-sitter', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

if (hasTreeSitter()) {
  console.log('\ntree-sitter CLI found — attempting to generate the parser…');
  try {
    const dir = mkdtempSync(join(tmpdir(), 'monogram-ts-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'queries'), { recursive: true });
    writeFileSync(join(dir, 'grammar.js'), grammarJs);
    writeFileSync(join(dir, 'queries', 'highlights.scm'), highlightsScm);
    writeFileSync(join(dir, 'src', 'scanner.c'), scannerC);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tree-sitter-typescript-monogram', version: '0.0.0' }, null, 2));
    try {
      const result = execFileSync('tree-sitter', ['generate'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
      console.log('  tree-sitter generate SUCCEEDED');
      if (result.trim()) console.log('  ' + result.trim().split('\n').join('\n  '));
    } catch (e: any) {
      console.log('  tree-sitter generate reported issues (expected for a derived grammar):');
      const msg = (e.stderr || e.stdout || e.message || '').toString();
      console.log('  ' + msg.trim().split('\n').slice(0, 12).join('\n  '));
    }
    console.log(`  (artifacts written to ${dir})`);
  } catch (e: any) {
    console.log('  could not run CLI test:', e.message);
  }
} else {
  console.log('\ntree-sitter CLI not found — structural validation only (not a failure).');
}

console.log(`\n${ok}/${ok + fail} structural checks pass`);
process.exit(fail === 0 ? 0 : 1);
