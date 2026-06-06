// Contract: token-level string `interpolation` metadata propagates to TextMate, Monarch, and
// tree-sitter (originally PR #9, ported to the current token-pattern-IR API). A `string` token
// declares interpolation regions (`${…}` / `$(…)`); each generator re-expresses them as nested
// regions / states / rules. `begin`/`end` are regex-source fragments (highlight-only), unaffected
// by the token IR.
//
// Run with: node test/interpolation-metadata.ts
import { defineGrammar, many, rule, token, seq, star, alt, lit, oneOf, noneOf, anyChar, range, plus } from '../src/api.ts';
import { generateTmLanguage } from '../src/gen-tm.ts';
import { generateMonarch } from '../src/gen-monarch.ts';
import { generateTreeSitter } from '../src/gen-treesitter.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let ok = 0;
let fail = 0;
const check = (label: string, cond: boolean) => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}`); }
};

const WS = token(plus(oneOf(' ', '\t')), { skip: true });
const NL = token(seq(star(lit('\r')), lit('\n')), { skip: true });
const KEY = token(seq(oneOf(range('A', 'Z'), '_'), star(oneOf(range('A', 'Z'), range('0', '9'), '_'))), { identifier: true });
const DQ = token(
  seq(lit('"'), star(alt(seq(lit('\\'), anyChar()), noneOf(oneOf('"', '\\')))), lit('"')),
  {
    string: true,
    escape: seq(lit('\\'), anyChar()),
    interpolation: [
      {
        begin: '${',
        end: '}',
        beginScope: 'punctuation.definition.interpolation.begin',
        endScope: 'punctuation.definition.interpolation.end',
        contentScope: 'variable.function',
      },
      {
        begin: '$(',
        end: ')',
        beginScope: 'punctuation.definition.interpolation.begin',
        endScope: 'punctuation.definition.interpolation.end',
        contentScope: 'variable.function',
      },
    ],
  },
);

const Value = rule(() => [[DQ]]);
const Line = rule(() => [[KEY, '=', Value]]);
const File = rule(() => [[many(Line)]]);

const grammar = defineGrammar({
  name: 'interpolation-metadata',
  tokens: { WS, NL, KEY, DQ },
  rules: { Value, Line, File },
  scopes: { 'keyword.operator.assignment': ['='] },
  entry: File,
});

// ── TextMate generation ──
const tm = generateTmLanguage(grammar, 'interpolation-metadata');
const dqTm = tm.repository.dq;
check('tm: DQ repository entry exists', !!dqTm);
check('tm: DQ ${ interpolation begin is the escaped literal', JSON.stringify(dqTm).includes('"begin":"\\\\$\\\\{"'));
check('tm: DQ $( interpolation begin is the escaped literal', JSON.stringify(dqTm).includes('"begin":"\\\\$\\\\("'));
check('tm: interpolation begin scope emitted', JSON.stringify(dqTm).includes('punctuation.definition.interpolation.begin.interpolation-metadata'));
check('tm: interpolation end scope emitted', JSON.stringify(dqTm).includes('punctuation.definition.interpolation.end.interpolation-metadata'));

// ── Monarch generation ──
const monarch = generateMonarch(grammar);
const bodyStateName = Object.keys(monarch.tokenizer).find(s => s.startsWith('string_dquote_body'));
check('monarch: has double-quote string body state', !!bodyStateName);
const bodyRules = bodyStateName ? monarch.tokenizer[bodyStateName] : [];
check('monarch: body has ${ interpolation begin rule', bodyRules.some(r => Array.isArray(r) && r[0] === '\\$\\{'));
check('monarch: body has $( interpolation begin rule', bodyRules.some(r => Array.isArray(r) && r[0] === '\\$\\('));
check('monarch: creates interpolation state', Object.keys(monarch.tokenizer).some(s => s.startsWith('string_interp_dquote_')));

// ── Tree-sitter generation ──
const ts = generateTreeSitter(grammar, 'interpolation-metadata');
check('treesitter: re-emits DQ token as rule', ts.grammarJs.includes('dq: $ => seq('));
check('treesitter: emits first interpolation rule', ts.grammarJs.includes('dq_interpolation_1'));
check('treesitter: emits second interpolation rule', ts.grammarJs.includes('dq_interpolation_2'));
check('treesitter: scanner has dq chars scan fn', ts.scannerC.includes('scan_dq_chars'));
check('treesitter: scanner openers include ${', ts.scannerC.includes('"${"'));
check('treesitter: scanner openers include $(', ts.scannerC.includes('"$("'));
check('treesitter: highlights capture interpolation punctuation', ts.highlightsScm.includes('(dq_interpolation_1 "${") @punctuation.special'));
check('treesitter: highlights capture interpolation punctuation for $(', ts.highlightsScm.includes('(dq_interpolation_2 "$(") @punctuation.special'));

// ── Optional: real tree-sitter CLI — generate + parse proves scanner.c COMPILES and that the
//    `dq_chars` external + interpolation rules actually tokenize an interpolated string. ──
const tsBin = join(process.cwd(), 'node_modules', '.bin', 'tree-sitter');
if (existsSync(tsBin)) {
  console.log('\ntree-sitter CLI found — generating + parsing an interpolated string…');
  const dir = mkdtempSync(join(tmpdir(), 'monogram-interp-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'queries'), { recursive: true });
  writeFileSync(join(dir, 'grammar.js'), ts.grammarJs);
  writeFileSync(join(dir, 'src', 'scanner.c'), ts.scannerC);
  writeFileSync(join(dir, 'queries', 'highlights.scm'), ts.highlightsScm);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tree-sitter-interp-monogram', version: '0.0.0' }));
  let generated = false;
  try {
    execFileSync(tsBin, ['generate'], { cwd: dir, stdio: 'pipe' });
    generated = true;
  } catch (e: any) {
    console.log('  generate failed:', ((e.stderr || e.message || '') + '').split('\n').slice(0, 8).join('\n  '));
  }
  check('tree-sitter generate succeeds (interpolation rules + scanner consistent)', generated);
  if (generated) {
    // `a` and `b` are dq_chars runs; `${}` / `$()` are interpolation regions (empty holes — the
    // tiny grammar has no expression rule, so blank() — which still exercises the scanner stops).
    writeFileSync(join(dir, 'in.env'), 'A="a${}b$()c"\n');
    let tree = '';
    try { tree = execFileSync(tsBin, ['parse', 'in.env'], { cwd: dir, encoding: 'utf8' }); }
    catch (e: any) { tree = ((e.stdout || '') + '\n' + (e.stderr || '')); }
    check('parse: both interpolation regions present, no ERROR',
      tree.includes('dq_interpolation_1') && tree.includes('dq_interpolation_2') && !tree.includes('ERROR'));
  }
  console.log(`  (artifacts in ${dir})`);
} else {
  console.log('\ntree-sitter CLI not found — structural validation only (not a failure).');
}

console.log(
  fail === 0
    ? `\n${ok}/${ok} interpolation-metadata checks pass`
    : `\n${fail} FAILED (of ${ok + fail})`,
);
process.exit(fail === 0 ? 0 : 1);
