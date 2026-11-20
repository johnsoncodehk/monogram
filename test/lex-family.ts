// Gate: the lexer token scanners exist once, in the shared lex-scan family (src/lex-family.ts),
// and every portable target lexes through them.
//
//   1. no target module recognizes tokens itself: no LexTok-kind or token-pattern switch, no
//      TokenPattern import — scanning arrives via `shared.lexScan` / `shared.scanner`;
//   2. in every emitted TS / Go / Rust lexer, each scanned token's scanner is defined exactly
//      once and called from the dispatch loop;
//   3. the family, printed through the TS target and executed, scans a grammar covering every
//      scanner kind (nested and flat block comments, line comments, escaping strings, char
//      runs, seq / alt / repeat / negated-lookahead patterns) to the expected end — and to -1
//      on unterminated or non-matching input;
//   4. those cases catch defects: each mutant of the printed scanners fails at least one case.
//
//   node test/lex-family.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { token, rule, defineGrammar, many, seq, plus, star, oneOf, noneOf, range, altPattern, anyChar, notFollowedBy } from '../src/api.ts';
import { portableIR, type ParserIR } from '../src/emit-portable.ts';
import { tsTarget, goTarget, rustTarget } from '../src/emit.ts';
import type { CstGrammar } from '../src/types.ts';

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  ✗ ${msg}`); };

// ── 1. no recognizer left in a target module ──
const RECOGNIZER = /case '(run|runBail|block|line|string|pattern|charClass|repeat|lookahead|anchor|anyChar)'|kind === '(run|runBail|block|line|string|pattern)'|\bTokenPattern\b|\bcompilePat\b/;
for (const f of ['target-ts.ts', 'target-go.ts', 'target-rust.ts']) {
  const s = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const m = s.match(RECOGNIZER);
  if (m) fail(`${f}: recognizes tokens itself (${m[0]})`);
}

// ── a grammar with every scanner kind ──
const digit = range('0', '9');
const identStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const bcAtom = altPattern(noneOf('*', '/'), seq('*', notFollowedBy('/')), seq('/', notFollowedBy('*')));
const bcNest = seq('/*', star(bcAtom), '*/');
const LineComment = token(seq('//', star(noneOf('\n'))), { skip: true });
const BlockComment = token(seq('/*', star(altPattern(bcNest, bcAtom)), '*/'), { skip: true });
const Str = token(seq('"', star(altPattern(seq('\\', anyChar()), noneOf('"', '\\'))), '"'), { string: true });
const Hex = token(seq('0x', plus(oneOf(digit, range('a', 'f'))), notFollowedBy(oneOf(identStart, digit))));
const Float = token(seq(plus(digit), '.', plus(digit)));
const Int = token(plus(digit));
const Ident = token(seq(identStart, star(oneOf(identStart, digit))), { identifier: true });
const Atom = rule(() => [Hex, Float, Int, Str, Ident]);
const Program = rule(() => [[many(Atom)]]);
const kinds = defineGrammar({
  name: 'lexkinds',
  tokens: { LineComment, BlockComment, Str, Hex, Float, Int, Ident },
  rules: { Atom, Program },
  entry: Program,
});
const flat = (await import('../javascript.ts')).default as CstGrammar;

const kindOf = (ir: ParserIR, name: string) => ir.tokens.find((t) => t.name === name);
const ir = portableIR(kinds);
const want: [string, string][] = [['LineComment', 'line'], ['BlockComment', 'block'], ['Str', 'string'], ['Hex', 'pattern'], ['Float', 'pattern'], ['Int', 'pattern'], ['Ident', 'run']];
for (const [name, k] of want) if (kindOf(ir, name)?.kind !== k) fail(`lexkinds: ${name} is ${kindOf(ir, name)?.kind}, want ${k}`);
const nestedOf = (g: CstGrammar, name: string) => { const t = kindOf(portableIR(g), name); return t?.kind === 'block' ? t.nested : undefined; };
if (nestedOf(kinds, 'BlockComment') !== true) fail('lexkinds: BlockComment is not a nested block');
if (nestedOf(flat, 'BlockComment') !== false) fail('javascript: BlockComment is not a flat block');

// ── 2. every emitted lexer defines each scanner once and calls it ──
const HOSTS = [
  { name: 'typescript', target: tsTarget, def: (n: string) => `function ${n}(`, use: (n: string) => `${n}(src, pos)` },
  { name: 'go', target: goTarget, def: (n: string) => `func ${n}(`, use: (n: string) => `${n}(src, pos)` },
  { name: 'rust', target: rustTarget, def: (n: string) => `fn ${n}(`, use: (n: string) => `${n}(src, pos as isize)` },
];
const count = (s: string, sub: string) => s.split(sub).length - 1;
const GRAMMARS: [string, CstGrammar][] = [['lexkinds', kinds], ['javascript', flat], ['calc', (await import('./fixtures/calc.ts')).default], ['envtpl', (await import('./fixtures/envtpl.ts')).default]];
for (const [gname, g] of GRAMMARS) {
  const gir = portableIR(g);
  for (const h of HOSTS) {
    const out = h.target.emitParser(g);
    const toks = h.target.shared.scannedTokens(gir);
    for (const t of toks) {
      const n = h.target.shared.scanner(t.name);
      if (count(out, h.def(n)) !== 1) fail(`${gname}/${h.name}: ${n} defined ${count(out, h.def(n))}×, want 1`);
      if (count(out, h.use(n)) < 1) fail(`${gname}/${h.name}: ${n} is never called by the lexer`);
    }
    if (gir.tpl && toks.some((t) => t.name === gir.tpl!.token)) fail(`${gname}/${h.name}: the template token is scanned outside the template state machine`);
  }
  console.log(`  ${gname}: ${portableIR(g).tokens.length} tokens; ts / go / rust each define and call every scanner once`);
}

// ── 3. the printed family, executed ──
type Case = [token: string, src: string, pos: number, end: number];
const CASES: Case[] = [
  ['BlockComment', '/* a /* b */ c */x', 0, 17],
  ['BlockComment', '/* a */ */', 0, 7],
  ['BlockComment', '/* /* */', 0, -1],
  ['BlockComment', '/* a', 0, -1],
  ['BlockComment', 'x/**/', 1, 5],
  ['BlockComment', '/x', 0, -1],
  ['LineComment', '// hi\nx', 0, 5],
  ['LineComment', '//', 0, 2],
  ['LineComment', '/ x', 0, -1],
  ['Str', '"a\\"b"x', 0, 6],
  ['Str', 'x = "q"', 4, 7],
  ['Str', '"abc', 0, -1],
  ['Str', '"a\\', 0, -1],
  ['Hex', '0x1f+', 0, 4],
  ['Hex', '0x1fz', 0, -1],
  ['Hex', '0x', 0, -1],
  ['Float', '12.50x', 0, 5],
  ['Float', 'y=3.1', 2, 5],
  ['Float', '12.', 0, -1],
  ['Float', '12', 0, -1],
  ['Int', '0042x', 0, 4],
  ['Int', 'x', 0, -1],
  ['Ident', 'ab_9 ', 0, 4],
  ['Ident', '9a', 0, -1],
  ['Ident', ' z', 1, 2],
];

const dir = mkdtempSync(join(tmpdir(), 'lex-family-'));
const printed = tsTarget.shared.lexScan(ir);
const names = ir.tokens.map((t) => tsTarget.shared.scanner(t.name));
let mod = 0;
async function load(src: string): Promise<Record<string, (s: string, p: number) => number>> {
  const f = join(dir, `scan${mod++}.ts`);
  writeFileSync(f, `${src}\nexport { ${names.join(', ')} };\n`);
  return import(pathToFileURL(f).href);
}
function run(scan: Record<string, (s: string, p: number) => number>): string[] {
  const bad: string[] = [];
  for (const [tok, src, pos, end] of CASES) {
    const got = scan[tsTarget.shared.scanner(tok)]!(src, pos);
    if (got !== end) bad.push(`${tok}(${JSON.stringify(src)}, ${pos}) = ${got}, want ${end}`);
  }
  return bad;
}
try {
  for (const b of run(await load(printed))) fail(`lexkinds: ${b}`);
  console.log(`  lexkinds: ${CASES.length} scanner cases through the printed family`);

  // ── 4. mutants ──
  const MUTANTS: [string, RegExp, string][] = [
    ['nested block depth never grows', /depth = depth \+ 1/, 'depth = depth'],
    ['string escape skips one character', /e = e \+ 2/, 'e = e + 1'],
    ['negated lookahead inverted', /if \(r < 0\) return p;/, 'if (r >= 0) return p;'],
    ['seq drops its last item', /const (q\d+): number = lexMatch\d+\(s, (q\d+)\);\n\s+if \(\1 < 0 \|\| \1 > s\.length\) return -1;\n\s+return \1;/, 'return $2;'],
    ['run stops after the first character', /while \(e < s\.length\) \{\n(\s+)const d/, 'while (false) {\n$1const d'],
    ['repeat ignores its minimum', /if \(n < 1\) return -1;/g, ''],
  ];
  for (const [what, re, by] of MUTANTS) {
    if (!re.test(printed)) { fail(`mutant "${what}": pattern not found in the printed family`); continue; }
    const bad = run(await load(printed.replace(re, by)));
    if (!bad.length) fail(`mutant "${what}" survives every case`);
    else console.log(`  mutant "${what}": caught (${bad.length} case(s))`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n✗ lex-family: ${failures} problem(s)`);
  process.exit(1);
}
console.log('\n✓ lex-family: token scanners authored once, printed per target, called by every emitted lexer');
