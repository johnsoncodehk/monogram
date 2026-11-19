// Regression test for issue #10 — a `newline`-sensitive mode INDEPENDENT of `indent`.
//
// A tiny dotenv / env-spec-flavoured grammar (KEY=value statements, one per line; a
// value is a scalar or a function call whose args may span lines INSIDE `( … )`; `#`
// line comments) exercises the LAYERED newline machinery: the lexer emits one NEWLINE
// token spanning EVERY line break outside flow delimiters, with NO indent stack and NO
// INDENT/DEDENT tokens; which breaks matter is the grammar's to say. All four backends
// (parser / TextMate / Monarch / tree-sitter) stay coherent. The grammar is defined INLINE (like test/agnostic.ts) —
// no new language file is added to the repo.
//
// Run with: node test/newline-mode.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { token, rule, defineGrammar, many, opt, alt, sep, seq, plus, oneOf, range, star, noneOf, never } from '../src/api.ts';
import { compileTokenizer, lexSpecOf } from '../src/emit-lexer.ts';
import { createParser } from '../src/gen-parser.ts';
import { emitParser, jsTarget } from '../src/emit.ts';
import { objectify } from './emitted-obj.ts';
import { generateTmLanguage } from '../src/gen-tm.ts';
import { generateMonarch } from '../src/gen-monarch.ts';
import { generateTreeSitter } from '../src/gen-treesitter.ts';
import type { NewlineConfig } from '../src/types.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { if (cond) ok++; else { fail++; console.log('  ✗', label); } };

// ── A minimal newline-aware, NON-indent grammar (env-spec flavour) ──
const Newline = token(never(), {});                 // engine-emitted at every line break outside flow
const Ident   = token(plus(oneOf(range('a', 'z'), range('A', 'Z'), range('0', '9'), '_')), { identifier: true });
const Comment = token(seq('#', star(noneOf('\n'))), { skip: true });

const Value   = rule(($: any) => [Ident, [Ident, '(', sep($, ','), ')']]);  // scalar OR call (call args may span lines)
const Stmt    = rule(() => [[Ident, '=', Value]]);
const Program = rule(() => [[opt(Stmt), many(Newline, opt(Stmt))]]);

const newline: NewlineConfig = { token: 'Newline', flowOpen: ['('], flowClose: [')'] };
const g = defineGrammar({
  name: 'envspec', scopeName: 'source.envspec',
  tokens: { Comment, Ident, Newline },
  rules: { Value, Stmt, Program }, entry: Program,
  newline,
});

// ── 0. defineGrammar rejects declaring both indent and newline ──
let bothRejected = false;
try {
  defineGrammar({
    name: 'bad', tokens: { Ident, Newline }, rules: { Stmt, Program }, entry: Program,
    newline, indent: { indentToken: 'X', dedentToken: 'Y', newlineToken: 'Newline' },
  });
} catch { bothRejected = true; }
check('defineGrammar rejects declaring BOTH indent and newline', bothRejected);
// newline mode has one shape; the removed separator-era options fail loudly instead of being ignored
for (const extra of [{ comment: '#' }, { mode: 'terminator' }, { mode: 'separator' }]) {
  let msg = '';
  try { defineGrammar({ name: 'bad', tokens: { Ident, Newline }, rules: { Stmt, Program }, entry: Program, newline: { ...newline, ...extra } as NewlineConfig }); }
  catch (e: any) { msg = e.message; }
  check(`defineGrammar rejects newline.${Object.keys(extra)[0]}`, msg.startsWith(`newline.${Object.keys(extra)[0]} is not a newline option`));
}

// ── 1. Lexer: a NEWLINE spanning every line break outside flow, NO indent tokens ──
const tokenize = compileTokenizer(lexSpecOf(g));
const nls = (s: string) => JSON.stringify(tokenize(s).filter(t => t.type === 'Newline').map(t => [t.offset, t.text]));
const hasIndentTokens = (s: string) => tokenize(s).some(t => t.type === 'Indent' || t.type === 'Dedent');

check('a break between two statements is one NEWLINE spanning it', nls('A=1\nB=2') === '[[3,"\\n"]]');
check('never emits INDENT/DEDENT (newline ≠ indent)', !hasIndentTokens('A=1\nB=2\nC=3'));
check('every blank line is its own NEWLINE', nls('A=1\n\n\nB=2') === '[[3,"\\n"],[4,"\\n"],[5,"\\n"]]');
check('a comment-only line still breaks', nls('A=1\n# note\nB=2') === '[[3,"\\n"],[10,"\\n"]]');
check('a whitespace-only line (spaces, tabs) breaks', nls('A=1\n \t\nB=2') === '[[3,"\\n"],[6,"\\n"]]');
check('leading breaks are emitted', nls('\n\nA=1') === '[[0,"\\n"],[1,"\\n"]]');
check('a trailing break is emitted', nls('A=1\n') === '[[3,"\\n"]]');
check('no break, no NEWLINE', nls('A=1') === '[]');
check('CRLF is one NEWLINE spanning both characters', nls('A=1\r\n\r\nB=2') === '[[3,"\\r\\n"],[5,"\\r\\n"]]');
check('a lone CR is a break', nls('A=1\rB=2') === '[[3,"\\r"]]');
check('breaks INSIDE flow ( … ) are suspended', nls('A=fn(1,\n2)\nB=3') === '[[10,"\\n"]]');
check('flow value still produces no indent tokens', !hasIndentTokens('A=fn(1,\n2)'));
check('the token after a break (block or flow) has newlineBefore', JSON.stringify(tokenize('A=fn(1,\n2)\nB=3').filter(t => t.newlineBefore).map(t => t.offset)) === '[8,11]');

// ── 2. Parser: accepts line-delimited / flow-spanning input, rejects malformed ──
const { parse } = createParser(g);
const accepts = (s: string) => { try { return parse(s).rule !== undefined; } catch { return false; } };
check('accepts a single statement', accepts('A=1'));
check('accepts newline-separated statements', accepts('A=1\nB=2'));
check('accepts a trailing newline', accepts('A=1\n'));
check('accepts a comment line between statements', accepts('A=1\n# c\nB=2'));
check('accepts blank lines between statements (the grammar absorbs them)', accepts('A=1\n\n\nB=2'));
check('accepts leading blank lines', accepts('\n\nA=1'));
check('accepts a function-call value spanning lines in ( … )', accepts('A=fn(1,\n2)\nB=3'));
check('rejects a statement with no `=`', !accepts('A B'));
check('rejects a statement with no value', !accepts('A='));

// ── 3. TextMate: generates without error; the NEWLINE never() token yields no rule ──
const tm = generateTmLanguage(g);
check('TextMate grammar has a non-empty repository', !!tm.repository && Object.keys(tm.repository).length > 0);
check('TextMate grammar has patterns', Array.isArray(tm.patterns) && tm.patterns.length > 0);
check('TextMate: NEWLINE is an invisible never-match (?!) rule (same convention as YAML indent tokens)', tm.repository.newline?.match === '(?!)');

// ── 4. Monarch: generates without error ──
const mon = generateMonarch(g);
check('Monarch tokenizer has a root state', !!mon.tokenizer && !!mon.tokenizer.root);

// ── 5. tree-sitter: NEWLINE is a stateless external token; coherent grammar.js + scanner.c ──
const { grammarJs, scannerC, highlightsScm, externalTokens } = generateTreeSitter(g, 'envspec');
check('tree-sitter declares externals', /externals:\s*\$ =>/.test(grammarJs));
check('tree-sitter externalTokens include newline', externalTokens.includes('newline'));
check('grammar rules reference $.newline (external) as separator', grammarJs.includes('$.newline'));
check('scanner.c declares the NEWLINE enum', /enum TokenType\s*\{[^}]*\bNEWLINE\b/.test(scannerC));
check('scanner.c implements scan_newline', scannerC.includes('scan_newline'));
check('scanner.c dispatches NEWLINE in scan()', scannerC.includes('valid_symbols[NEWLINE]'));

// grammar.js must parse & execute as real JS through stubbed tree-sitter DSL globals.
function grammarExecutes(src: string): { ok: boolean; err?: string } {
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
  try { vm.runInContext(src, sandbox, { filename: 'grammar.js' }); return { ok: true }; }
  catch (e: any) { return { ok: false, err: e.message }; }
}
const exec = grammarExecutes(grammarJs);
check(`tree-sitter grammar.js parses & executes${exec.err ? ' (' + exec.err + ')' : ''}`, exec.ok);

// ── 6. Optional: real tree-sitter CLI — generate + parse proves scanner.c COMPILES
//      and that NEWLINE fires at boundaries but is suppressed inside flow ( … ). ──
const tsBin = join(process.cwd(), 'node_modules', '.bin', 'tree-sitter');
function hasCli(): boolean {
  if (!existsSync(tsBin)) return false;
  try { execFileSync(tsBin, ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
if (hasCli()) {
  console.log('\ntree-sitter CLI found — generating + parsing to validate scanner.c…');
  const dir = mkdtempSync(join(tmpdir(), 'monogram-nl-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'queries'), { recursive: true });
  writeFileSync(join(dir, 'grammar.js'), grammarJs);
  writeFileSync(join(dir, 'src', 'scanner.c'), scannerC);
  writeFileSync(join(dir, 'queries', 'highlights.scm'), highlightsScm);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tree-sitter-envspec-monogram', version: '0.0.0' }, null, 2));
  let generated = false;
  try {
    execFileSync(tsBin, ['generate'], { cwd: dir, stdio: 'pipe' });
    generated = true;
  } catch (e: any) {
    console.log('  generate failed:', ((e.stderr || e.message || '') + '').split('\n').slice(0, 8).join('\n  '));
  }
  check('tree-sitter generate succeeds (externals/scanner consistent)', generated);
  if (generated) {
    const parseTree = (input: string) => {
      writeFileSync(join(dir, 'in.env'), input);
      // `tree-sitter parse` auto-builds (compiles parser.c + scanner.c) then parses;
      // it exits non-zero when the tree contains an ERROR but still prints the tree.
      try { return execFileSync(tsBin, ['parse', 'in.env'], { cwd: dir, encoding: 'utf8' }); }
      catch (e: any) { return ((e.stdout || '') + '\n' + (e.stderr || '')); }
    };
    const t1 = parseTree('A=1\nB=2\n');
    check('parse: NEWLINE node present between statements, no ERROR', t1.includes('newline') && !t1.includes('ERROR'));
    const t2 = parseTree('A=fn(1,\n2)\nB=3\n');
    // fn(1,\n2) must parse with NO newline node inside it (flow suspends the line break);
    // the only two newline nodes are the A→B separator and the trailing line break.
    check('parse: flow-internal newline suppressed (no ERROR; newlines only at statement boundaries)',
      !t2.includes('ERROR') && (t2.match(/\(newline /g) ?? []).length === 2);
  }
  console.log(`  (artifacts in ${dir})`);
} else {
  console.log('\ntree-sitter CLI not found — structural validation only (not a failure).');
}


// ── 7. A grammar that keeps blank lines as lines (env-spec: `File = many(Line)`,
//      `Line = Stmt NEWLINE? | NEWLINE`): every line, blank ones included, is its own node at its
//      own offset — what an editor maps to a line number. ──
const LineT = rule(() => [[Stmt, opt(Newline)], [Newline]]);
const FileT = rule(() => [[many(LineT)]]);
const gT = defineGrammar({
  name: 'envspec-lines', scopeName: 'source.envspec-lines',
  tokens: { Comment, Ident, Newline },
  rules: { Value, Stmt, Line: LineT, File: FileT }, entry: FileT,
  newline,
});
{
  const parseT = createParser(gT).parse;
  const acceptsT = (s: string) => { try { return parseT(s).rule !== undefined; } catch { return false; } };
  check('lines: parses statements with blank lines between and a trailing break', acceptsT('A=1\n\nB=2\n'));
  check('lines: parses leading blank lines', acceptsT('\n\nA=1'));
  check('lines: parses a lone statement without a break', acceptsT('A=1'));
  check('lines: parses a flow value spanning lines', acceptsT('A=fn(1,\n2)\nB=3'));
  check('lines: parses comment-only and whitespace-only lines', acceptsT('A=1\n# c\n \t\nB=2'));
  check('lines: still rejects a malformed statement', !acceptsT('A B'));
  const lines = (s: string) => (parseT(s) as any).children.map((l: any) => [l.children.length, JSON.stringify(l).match(/"tokenType":"Newline","offset":(\d+),"end":(\d+)/)?.slice(1).join('-') ?? null]);
  check('lines: a statement line owns its break, a blank line is its own Line at its own span',
    JSON.stringify(lines('A=1\n\nB=2')) === '[[2,"3-4"],[1,"4-5"],[1,null]]');
  check('lines: CRLF spans are kept per line', JSON.stringify(lines('A=1\r\n\r\n')) === '[[2,"3-5"],[1,"5-7"]]');

  // ── 8. The emitted engine parses identically (its lexer is generated from the same spec) ──
  const dirE = mkdtempSync(join(tmpdir(), 'monogram-nl-emit-'));
  const file = join(dirE, 'envspec-lines.ts');
  writeFileSync(file, emitParser(gT, jsTarget));
  const p = (await import(file + '?v=' + Date.now())).createParser();
  for (const src of ['A=1\n\nB=2\n', '\n\nA=1', 'A=fn(1,\n2)\nB=3', 'A=1\n# note\nB=2', 'A=1\r\n\r\nB=2']) {
    const cst = p.parse(src);
    const obj = objectify(p.tree, (fns: any) => p.visit(cst, fns));
    check(`lines: emitted engine ≡ interpreter for ${JSON.stringify(src)}`, cst.errors.length === 0 && JSON.stringify(obj) === JSON.stringify(parseT(src)));
  }
}

// ── 9. tree-sitter on the same grammar. The derived scanner already emits one newline per break
//      (section 6), but `Line = Stmt NEWLINE? | NEWLINE` is LR-ambiguous after a statement: shift
//      the break into the statement's Line, or reduce and start a blank Line. The PEG engine's
//      `opt` is greedy (shift); gen-treesitter does not yet derive that resolution, so `tree-sitter
//      generate` reports the conflict. This check pins the gap: it fails once the generator emits
//      the resolution, and should then become a parse check (one newline node per break). ──
if (hasCli()) {
  const tsT = generateTreeSitter(gT, 'envspec_lines');
  const dirT = mkdtempSync(join(tmpdir(), 'monogram-nl-lines-'));
  mkdirSync(join(dirT, 'src'), { recursive: true });
  mkdirSync(join(dirT, 'queries'), { recursive: true });
  writeFileSync(join(dirT, 'grammar.js'), tsT.grammarJs);
  writeFileSync(join(dirT, 'src', 'scanner.c'), tsT.scannerC);
  writeFileSync(join(dirT, 'queries', 'highlights.scm'), tsT.highlightsScm);
  writeFileSync(join(dirT, 'package.json'), JSON.stringify({ name: 'tree-sitter-envspec-lines-monogram', version: '0.0.0' }, null, 2));
  let err = '';
  try { execFileSync(tsBin, ['generate'], { cwd: dirT, stdio: 'pipe' }); } catch (e: any) { err = String(e.stderr ?? e.message); }
  check('lines/tree-sitter: generate reports the greedy-opt conflict on `line` (known generator gap)',
    /Unresolved conflict/.test(err) && /\(line\s+stmt\s+•\s+newline\)/.test(err));
}

console.log(fail === 0 ? `\n${ok}/${ok} newline-mode checks pass` : `\n${fail} of ${ok + fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
