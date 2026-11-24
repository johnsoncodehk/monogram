// Gate: the lexer token scanners exist once, in the shared lex-scan family (src/lex-family.ts),
// and every portable target lexes through them.
//
//   1. no target module recognizes tokens itself: no LexTok-kind or token-pattern switch, no
//      TokenPattern import — scanning arrives via `shared.lexScan` / `shared.scanner`;
//   2. in every emitted TS / Go / Rust lexer, each scanned token's scanner is defined exactly
//      once and called from the dispatch loop — or, for a lowering that splices inline fns (Go),
//      no scanner fn is printed and each scanner's statements appear at the dispatch;
//   3. the family, printed through the TS target and executed, scans a grammar covering every
//      scanner kind (block comments with and without a guard after the opener, line comments,
//      escaping strings, char runs, seq / alt / repeat / negated-lookahead patterns, and
//      patterns whose regex has to back up out of a choice: an alternative, a repeat of one
//      character, a bounded repeat, a lazy repeat) to the regex's end — and to -1 on
//      unterminated or non-matching input, and at a negative position;
//   4b. a fast-path scanner kind is chosen only for a pattern of exactly that shape: a pattern
//      that only begins and ends like a string or a comment is scanned by its own matcher;
//   4. the same cases pass through every scanner spliced by generation-time inlining;
//   5. those cases catch defects: each mutant of the printed scanners, and of the splicing
//      (a loop return that does not end the loop, a missing after-loop guard), fails a case;
//  11. the relex / scanMeta family is embedded verbatim from its one source in every target's
//      output, each of its functions defined once, every lexer mode covered (formerly relex-family).
//
//   node test/lex-family.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { token, rule, defineGrammar, many, seq, plus, star, oneOf, noneOf, range, repeat, altPattern, anyChar, notFollowedBy } from '../src/api.ts';
import { buildLexDispatchPlan, buildLexIdPlan, lexTokFirstBytes, portableIR, punctFirstBytes, type ParserIR } from '../src/emit-portable.ts';
import { info } from '../src/lex-match-plan.ts';
import { emitParser, type Target } from '../src/target.ts';
import { tsTarget } from '../src/target-ts.ts';
import { goTarget } from '../src/target-go.ts';
import { rustTarget } from '../src/target-rust.ts';
import type { PortableTarget } from '../src/define-target.ts';
import { emitRelexFamily, relexFamilyFns, relexMode, type RelexMode } from '../src/relex-family.ts';
import { type TextUnits, unitLen } from '../src/text-units.ts';
import type { Grammar } from '../src/types.ts';
import { tokenPatternToRegex } from '../src/token-pattern.ts';
import { scratchDir } from './scratch.ts';
import { tokenEdgeTexts } from './token-edges.ts';

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
const hex = oneOf(digit, range('a', 'f'));
const toClose = seq(notFollowedBy('*/'), anyChar());
const LineComment = token(seq('//', star(noneOf('\n'))), { skip: true });
const Rem = token(seq('--', star(noneOf('\n', '\r', '\u2028', '\u2029'))), { skip: true });   // stops at every JS LineTerminator
const DocComment = token(seq('/**', notFollowedBy('/'), star(toClose), '*/'), { skip: true });
const BlockComment = token(seq('/*', star(toClose), '*/'), { skip: true });
// Patterns whose regex backs up: `0*` gives back zeros, the 1–5 digit alternative gives way to
// `10`+4 digits, `[a-z]{1,3}` gives back letters, and the lazy body stops at the first `;;`.
const Esc = token(seq('\\u{', star('0'), altPattern(repeat(hex, 1, 5), seq('10', repeat(hex, 4, 4))), '}'));
const Tag = token(seq('@', repeat(range('a', 'z'), 1, 3), 'z!'));
const Lazy = token(seq('%', star(noneOf('\n'), { greedy: false }), ';;'));
const Str = token(seq('"', star(altPattern(seq('\\', anyChar()), noneOf('"', '\\'))), '"'), { string: true });
const Hex = token(seq('0x', plus(oneOf(digit, range('a', 'f'))), notFollowedBy(oneOf(identStart, digit))));
const Float = token(seq(plus(digit), '.', plus(digit)));
const Int = token(plus(digit));
const Ident = token(seq(identStart, star(oneOf(identStart, digit))), { identifier: true });
const Atom = rule(() => [Esc, Tag, Lazy, Hex, Float, Int, Str, Ident]);
const Program = rule(() => [[many(Atom)]]);
const kinds = defineGrammar({
  name: 'lexkinds',
  tokens: { LineComment, Rem, DocComment, BlockComment, Esc, Tag, Lazy, Str, Hex, Float, Int, Ident },
  rules: { Atom, Program },
  entry: Program,
});
const flat = (await import('../javascript.ts')).default as Grammar;

const kindOf = (ir: ParserIR, name: string) => ir.tokens.find((t) => t.name === name);
const ir = portableIR(kinds);
const want: [string, string][] = [['LineComment', 'line'], ['Rem', 'line'], ['DocComment', 'block'], ['BlockComment', 'block'], ['Esc', 'pattern'], ['Tag', 'pattern'], ['Lazy', 'pattern'], ['Str', 'string'], ['Hex', 'pattern'], ['Float', 'pattern'], ['Int', 'pattern'], ['Ident', 'run']];
for (const [name, k] of want) if (kindOf(ir, name)?.kind !== k) fail(`lexkinds: ${name} is ${kindOf(ir, name)?.kind}, want ${k}`);
for (const name of ['JSDoc', 'BlockComment']) if (kindOf(portableIR(flat), name)?.kind !== 'block') fail(`javascript: ${name} is not a block`);

// ── 4b. a shape that only begins and ends like a string or a comment is no fast path ──
{
  const NearIdent = token(plus(range('a', 'z')), { identifier: true });
  const near = defineGrammar({
    name: 'nearshapes',
    tokens: {
      // A backslash may not take a newline; the body stops at `*` (so `/* a **/` is no comment).
      Str: token(seq('"', star(altPattern(noneOf('"', '\\'), seq('\\', noneOf('\n')))), '"')),
      Block: token(seq('/*', star(altPattern(noneOf('*'), seq('*', noneOf('/')))), '*/'), { skip: true }),
      Greedy: token(seq('<!', star(anyChar()), '!>')),
      Ident: NearIdent,
    },
    rules: { Program: rule(() => [[many(NearIdent)]]) },
  } as never);
  const nir = portableIR(near);
  for (const name of ['Str', 'Block', 'Greedy']) if (kindOf(nir, name)?.kind !== 'pattern') fail(`nearshapes: ${name} is ${kindOf(nir, name)?.kind}, want pattern`);
}

// ── 4c. a line shape IS its token's pattern ──
// The `line` scanner runs from its prefix to the first of its stops, so the shape is proven equal
// to the declared pattern by rebuilding the pattern from the shape: the prefix, then a greedy run
// of every character but exactly the stops. A class the shape could not run exactly (a range, a
// stop that is two UTF-16 units) is no line shape.
{
  const rebuilt = (t: { prefix: string; stops: number[] }) => seq(t.prefix, star(noneOf(...t.stops.map((c) => String.fromCharCode(c)))));
  const canonical = (p: unknown): string => JSON.stringify(p, (_k, v) => (v && typeof v === 'object' && v.type === 'charClass'
    ? { ...v, items: [...v.items].sort((a: { value?: string; from?: string }, b: { value?: string; from?: string }) => ((a.value ?? a.from)! < (b.value ?? b.from)! ? -1 : 1)) } : v));
  let lines = 0;
  for (const path of ['../javascript.ts', '../typescript.ts', ...['calc', 'minijs', 'richtokens', 'regexjs', 'templatejs', 'envspec', 'envtpl', 'altjs', 'nudjs', 'sljs', 'unilits'].map((f) => `./fixtures/${f}.ts`)]) {
    const g = (await import(path)).default as Grammar;
    for (const t of portableIR(g).tokens) {
      if (t.kind !== 'line') continue;
      lines++;
      const decl = g.tokens.find((d) => d.name === t.name)!;
      if (canonical(rebuilt(t)) !== canonical(decl.pattern)) fail(`${g.name}/${t.name}: its line shape (${JSON.stringify(t.prefix)} up to ${t.stops.join(', ')}) is not its pattern ${JSON.stringify(decl.pattern)}`);
    }
  }
  const jsLine = portableIR(flat).tokens.find((t) => t.name === 'LineComment');
  if (jsLine?.kind !== 'line' || jsLine.stops.join() !== '10,13,8232,8233') fail(`javascript: LineComment stops at ${jsLine?.kind === 'line' ? jsLine.stops.join() : jsLine?.kind}, want every LineTerminator (10,13,8232,8233)`);
  const NearId = token(plus(range('a', 'z')), { identifier: true });
  const odd = portableIR(defineGrammar({
    name: 'nearlines',
    tokens: {
      Ranged: token(seq('#', star(noneOf(range('0', '9'), '\n'))), { skip: true }),
      Astral: token(seq('%', star(noneOf('\n', '\u{1F600}'))), { skip: true }),
      Wide: token(seq(';;', star(noneOf('\n', '\r', '\u2028', '\u2029', 'é'))), { skip: true }),
      Ident: NearId,
    },
    rules: { Program: rule(() => [[many(NearId)]]) },
  } as never));
  for (const [name, k] of [['Ranged', 'pattern'], ['Astral', 'pattern'], ['Wide', 'line']] as const) if (kindOf(odd, name)?.kind !== k) fail(`nearlines: ${name} is ${kindOf(odd, name)?.kind}, want ${k}`);
  console.log(`  ${lines} line shapes ≡ their token patterns; a ranged or astral class is no line shape`);
}

// ── 2. every emitted lexer defines each scanner once and calls it ──
const HOSTS = [
  { name: 'typescript', target: tsTarget, def: (n: string) => `function ${n}(`, use: (n: string) => `${n}(src, pos)` as string | null },
  { name: 'go', target: goTarget, def: (n: string) => `func ${n}(`, use: null },
  { name: 'rust', target: rustTarget, def: (n: string) => `fn ${n}(`, use: (n: string) => `${n}(src, pos as isize)` },
];
const count = (s: string, sub: string) => s.split(sub).length - 1;
// Occurrences of `block` as consecutive lines of `out`, ignoring indentation.
const countBlock = (out: string[], block: string[]): number => {
  const b = block.map((l) => l.trim());
  let n = 0;
  for (let i = 0; i + b.length <= out.length; i++) if (b.every((l, k) => out[i + k] === l)) n++;
  return n;
};
const GRAMMARS: [string, Grammar][] = [['lexkinds', kinds], ['javascript', flat], ['calc', (await import('./fixtures/calc.ts')).default], ['envtpl', (await import('./fixtures/envtpl.ts')).default]];
for (const [gname, g] of GRAMMARS) {
  const gir = portableIR(g);
  for (const h of HOSTS) {
    const out = h.target.emitParser(g);
    const lines = out.split('\n').map((l) => l.trim());
    const toks = h.target.shared.scannedTokens(gir);
    for (const t of toks) {
      if (h.use === null) {
        if (out.includes(h.def('lexScan'))) fail(`${gname}/${h.name}: prints a scanner fn although it splices them`);
        if (countBlock(lines, h.target.shared.scanInline(gir, t.name, { s: 'src', p: 'pos', out: 'e' })) < 1) fail(`${gname}/${h.name}: ${t.name}'s scanner is not spliced into the lexer`);
        continue;
      }
      const n = h.target.shared.scanner(t.name);
      if (count(out, h.def(n)) !== 1) fail(`${gname}/${h.name}: ${n} defined ${count(out, h.def(n))}×, want 1`);
      if (count(out, h.use(n)) < 1) fail(`${gname}/${h.name}: ${n} is never called by the lexer`);
    }
    if (gir.tpl && toks.some((t) => t.name === gir.tpl!.token)) fail(`${gname}/${h.name}: the template token is scanned outside the template state machine`);
  }
  console.log(`  ${gname}: ${portableIR(g).tokens.length} tokens; ts / rust define and call every scanner once, go splices each`);
}

// ── 3. the printed family, executed ──
type Case = [token: string, src: string, pos: number, end: number];
const CASES: Case[] = [
  ['BlockComment', '/* a /* b */ c */x', 0, 12],
  ['BlockComment', '/* a */ */', 0, 7],
  ['BlockComment', '/* /* */', 0, 8],
  ['BlockComment', '/**/ x */', 0, 4],
  ['DocComment', '/** a */', 0, 8],
  ['DocComment', '/***/', 0, 5],
  ['DocComment', '/**/ x */', 0, -1],
  ['Esc', '\\u{0}', 0, 5],
  ['Esc', '\\u{000}', 0, 7],
  ['Esc', '\\u{10ffff}', 0, 10],
  ['Esc', '\\u{0010ffff}', 0, 12],
  ['Esc', '\\u{110000}', 0, -1],
  ['Esc', '\\u{}', 0, -1],
  ['Tag', '@abz!', 0, 5],
  ['Tag', '@abcz!', 0, 6],
  ['Tag', '@abcdz!', 0, -1],
  ['Lazy', '%a;;b;;', 0, 4],
  ['Lazy', '%;;', 0, 3],
  ['Lazy', '%a;b', 0, -1],
  ['Lazy', '%a\n;;', 0, -1],
  ['BlockComment', '/* a', 0, -1],
  ['BlockComment', '/* a * b ** c *** d **/x', 0, 23],
  ['BlockComment', '/* a long comment with no close at all *', 0, -1],
  ['LineComment', '// a line comment longer than one word\r\nx', 0, 39],
  ['BlockComment', 'x/**/', 1, 5],
  ['BlockComment', '/x', 0, -1],
  ['LineComment', '// hi\nx', 0, 5],
  ['LineComment', '// hi\rx', 0, 7],
  ['Rem', '-- hi\rx', 0, 5],
  ['Rem', '-- a long remark, then CR\rx', 0, 25],
  ['Rem', '-- a long remark, then LS\u2028x', 0, 25],
  ['Rem', '-- a long remark, then PS\u2029x', 0, 25],
  ['Rem', '-- é\u2027\u202a then CR LF\r\nx', 0, 17],
  ['Rem', '-- no terminator at all, past eight units', 0, 41],
  ['Rem', '--', 0, 2],
  ['Rem', '-x', 0, -1],
  ['LineComment', '//', 0, 2],
  ['LineComment', '/ x', 0, -1],
  ['Str', '"a\\"b"x', 0, 6],
  ['Str', 'x = "q"', 4, 7],
  ['Str', '"a" "b"', 0, 3],
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
  ['Ident', 'ab', -1, -1],
  ['LineComment', '// x', -1, -1],
  ['BlockComment', '/**/', -1, -1],
  ['Str', '"a"', -1, -1],
  ['Float', '1.5', -1, -1],
];

const dir = scratchDir('lex-family');
const printed = tsTarget.shared.lexScan(ir);
const names = ir.tokens.map((t) => tsTarget.shared.scanner(t.name));
// Each scanner spliced into a wrapper fn `inline<scanner>(src, pos)`, as a dispatch site gets it.
const spliced = ir.tokens.map((t) => [
  `export function inline${tsTarget.shared.scanner(t.name)}(src: string, pos: number): number {`,
  ...tsTarget.shared.scanInline(ir, t.name, { s: 'src', p: 'pos', out: 'e' }).map((l) => `  ${l}`),
  '  return e;',
  '}',
].join('\n')).join('\n');
let mod = 0;
async function load(src: string): Promise<Record<string, (s: string, p: number) => number>> {
  const f = join(dir, `scan${mod++}.ts`);
  writeFileSync(f, `${src}\nexport { ${names.join(', ')} };\n`);
  return import(pathToFileURL(f).href);
}
function run(scan: Record<string, (s: string, p: number) => number>, prefix = ''): string[] {
  const bad: string[] = [];
  for (const [tok, src, pos, end] of CASES) {
    const got = scan[prefix + tsTarget.shared.scanner(tok)]!(src, pos);
    if (got !== end) bad.push(`${tok}(${JSON.stringify(src)}, ${pos}) = ${got}, want ${end}`);
  }
  return bad;
}
{
  for (const b of run(await load(printed))) fail(`lexkinds: ${b}`);
  console.log(`  lexkinds: ${CASES.length} scanner cases through the printed family`);
  for (const b of run(await load(`${printed}\n${spliced}`), 'inline')) fail(`lexkinds/spliced: ${b}`);
  console.log(`  lexkinds: ${CASES.length} scanner cases through the spliced scanners`);

  // ── 5. mutants ──
  const MUTANTS: [string, RegExp, string][] = [
    ['a block ignores its guard', /if \(g < 0\) return -1;/, ''],
    ['an alternative does not give way to the next', /(r = lexMatch\d+\(s, p\);\n\s+if \(r >= 0\) return r;\n\s+)r = lexMatch\d+\(s, p\);\n\s+if \(r >= 0\) return r;/, '$1'],
    ['a repeat of one character gives nothing back', /q = q - 1;/, 'q = p - 1;'],
    ['a lazy repeat tries one more first', /(const r: number = )(lexMatch\d+\(s, q\));/, '$1-1;'],
    ['string escape skips one character', /e = e \+ 2/, 'e = e + 1'],
    ['negated lookahead inverted', /if \(r < 0\) return p;/, 'if (r >= 0) return p;'],
    ['seq drops its last item', /const (q\d+): number = lexMatch\d+\(s, (q\d+)\);\n\s+if \(\1 < 0 \|\| \1 > s\.length\) return -1;\n\s+return \1;/, 'return $2;'],
    ['run stops after the first character', /while \(e < s\.length\) \{\n(\s+)const d/, 'while (false) {\n$1const d'],
    ['repeat ignores its minimum', /if \(n < 1\) return -1;/g, ''],
    ['a negative position is scanned', /if \(p < 0\) return -1;/g, ''],
  ];
  for (const [what, re, by] of MUTANTS) {
    if (!re.test(printed)) { fail(`mutant "${what}": pattern not found in the printed family`); continue; }
    const bad = run(await load(printed.replace(re, by)));
    if (!bad.length) fail(`mutant "${what}" survives every case`);
    else console.log(`  mutant "${what}": caught (${bad.length} case(s))`);
  }
  const SPLICE_MUTANTS: [string, RegExp, string][] = [
    ['a return inside a loop does not end it', /(\n\s+e = [^;\n]+;)\n\s+break;/g, '$1'],
    ['no guard after a loop that may return', /if \(e === -2\) e = -1;/g, ''],
  ];
  for (const [what, re, by] of SPLICE_MUTANTS) {
    if (!re.test(spliced)) { fail(`splice mutant "${what}": pattern not found in the spliced scanners`); continue; }
    const bad = run(await load(`${printed}\n${spliced.replace(re, by)}`), 'inline');
    if (!bad.length) fail(`splice mutant "${what}" survives every case`);
    else console.log(`  splice mutant "${what}": caught (${bad.length} case(s))`);
  }
}

// ── 6. every scanner is its token's regex ──
// The interpreter's lexer runs each token pattern as a regex (tokenPatternToRegex); the printed
// scanner must end where that regex's match ends, on the token's edge texts (test/token-edges.ts)
// and on each of them followed by more source.
{
  const PORTABLE = ['../javascript.ts', '../typescript.ts', ...['calc', 'minijs', 'richtokens', 'regexjs', 'templatejs', 'envspec', 'envtpl', 'altjs', 'nudjs', 'sljs', 'unilits'].map((f) => `./fixtures/${f}.ts`)];
  let checked = 0;
  for (const path of PORTABLE) {
    const g = (await import(path)).default as Grammar;
    const gir = portableIR(g);
    const toks = tsTarget.shared.scannedTokens(gir);
    const f = join(dir, `regex${mod++}.ts`);
    // The escape check's two target routines, as stubs that pass every escape: the scanner's end
    // is the regex's either way (whether an escape is valid is portable-targets' corpus).
    const stubs = (gir.identLike.length ? `function ${tsTarget.shared.uniClass()}(cp: number): number { return 2; }\n` : '') + (tsTarget.shared.uniIdent(gir) ? `function ${tsTarget.shared.uniIdent(gir)}(s: string, p: number): number { return -1; }\n` : '');
    writeFileSync(f, `${tsTarget.shared.lexScan(gir)}\n${stubs}export { ${toks.map((t) => tsTarget.shared.scanner(t.name)).join(', ')} };\n`);
    const scan = await import(pathToFileURL(f).href) as Record<string, (s: string, p: number) => number>;
    for (const t of toks) {
      const decl = g.tokens.find((d) => d.name === t.name)!;
      const re = new RegExp(tokenPatternToRegex(decl.pattern), 'y');
      const fn = scan[tsTarget.shared.scanner(t.name)]!;
      let bad = 0;
      for (const base of tokenEdgeTexts(decl)) {
        for (const src of [base, base + ' x', base + base, base + '\n;']) {
          re.lastIndex = 0;
          const m = re.exec(src);
          const want = m && m[0].length > 0 ? m[0].length : -1;
          const got = fn(src, 0);
          checked++;
          if (got !== want && bad++ < 3) fail(`${g.name}/${t.name} (${t.kind}): ${JSON.stringify(src)} scans to ${got}, its regex to ${want}`);
        }
      }
    }
  }
  console.log(`  every portable grammar: ${checked} token-edge texts scan to their token regex's end`);

  // ── 7. the Rust / Go sources hold no raw control character a literal may not hold ──
  // A TS template literal that prints `'\n'` without doubling the backslash hands rustc / go a
  // character literal holding a real line feed (or NUL), which neither compiler accepts; only
  // CI has rustc. Every emitted library and runner is read here instead: no control character
  // but LF and TAB anywhere, and no character literal that is a raw LF (Go, Rust) or TAB (Rust).
  let sources = 0;
  for (const path of PORTABLE) {
    const g = (await import(path)).default as Grammar;
    for (const [lang, target, charLit] of [['rust', rustTarget, /'[\n\t]'/], ['go', goTarget, /'\n'/]] as const) {
      for (const [part, src] of [['library', target.emitParser(g)], ['runner', target.emitRunner?.() ?? '']] as const) {
        sources++;
        const ctl = src.search(/[\x00-\x08\x0b-\x1f\x7f]/);
        if (ctl >= 0) fail(`${g.name}/${lang} ${part}: raw control character U+${src.charCodeAt(ctl).toString(16).padStart(4, '0')} near ${JSON.stringify(src.slice(Math.max(0, ctl - 40), ctl + 10))}`);
        const m = charLit.exec(src);
        if (m) fail(`${g.name}/${lang} ${part}: a character literal holding a raw ${JSON.stringify(m[0])} near ${JSON.stringify(src.slice(Math.max(0, m.index - 40), m.index + 10))}`);
      }
    }
  }
  console.log(`  ${sources} emitted Rust / Go sources hold no raw control character in a literal`);

  // ── 8. a lexer advances past a literal by its length in the target's units ──
  // Go and Rust index by UTF-8 byte, TS by UTF-16 unit; a length measured with JavaScript's
  // `.length` is right in TS only. Each emitted lexer is read: wherever it tests for a literal
  // (a punctuator, a template delimiter) and advances on the same line, the advance must be that
  // literal's length in the target's units. This sees only lengths printed next to their literal;
  // a length inside a shared scanner, a composed operator's read or a decision such as "one
  // unit" is checked by running the parsers (test/portable-targets.ts, the unilits fixture).
  const LIT = '("(?:[^"\\\\]|\\\\.)*")';
  const ADVANCE: [string, Target, TextUnits, RegExp][] = [
    ['typescript', tsTarget, 'utf16', new RegExp(`src\\.startsWith\\(${LIT}, (?:pos|q)\\)[^\\n]*?(?:pos \\+=|end: q \\+) (\\d+)`, 'g')],
    ['go', goTarget, 'utf8', new RegExp(`strings\\.HasPrefix\\(src\\[(?:pos|q):\\], ${LIT}\\)[^\\n]*?(?:pos \\+=|return true, q \\+) (\\d+)`, 'g')],
    ['rust', rustTarget, 'utf8', new RegExp(`(?:src\\[pos\\.\\.\\]\\.starts_with\\(${LIT}\\)|starts_with\\(${LIT}\\.as_bytes\\(\\)\\))[^\\n]*?(?:pos \\+=|return \\(true, q \\+) (\\d+)`, 'g')],
  ];
  let advances = 0;
  for (const path of PORTABLE) {
    const g = (await import(path)).default as Grammar;
    for (const [lang, target, units, re] of ADVANCE) {
      for (const m of target.emitParser(g).matchAll(re)) {
        const lit = JSON.parse(m[1] ?? m[2]!) as string, n = Number(m[m.length - 1]);
        advances++;
        if (n !== unitLen(lit, units)) fail(`${g.name}/${lang}: advances ${n} past ${JSON.stringify(lit)}, its length in ${units} is ${unitLen(lit, units)}`);
      }
    }
  }
  if (advances === 0) fail('no literal advance found in any emitted lexer (the spellings this check reads have changed)');
  console.log(`  ${advances} literal advances in the emitted lexers are their literal's length in the target's units`);
}

// ── 6b. an element region's routines are the interpreter's (src/emit-lexer.ts) ──
// The region tokens (children text, tag tokens) scan to their regex's end; the type-parameter
// vetoes decide what the interpreter's LX_TP_HEAD / LX_TP_SIG regexes decide, on every text built
// from a vocabulary of the pieces they read, and how far they read bounds where they could have
// looked (an extension of the text past that bound never changes the decision).
{
  const { scannerName, EL_OPENS_FN, EL_NOT, EL_OPEN, EL_SPECULATE } = await import('../src/lex-family.ts');
  let scanned = 0, decided = 0;
  for (const path of ['../typescriptreact.ts', '../javascriptreact.ts', './fixtures/elementdialect.ts', './fixtures/textdialect.ts']) {
    const g = (await import(path)).default as Grammar;
    const gir = portableIR(g);
    const e = gir.elements!;
    const region = [...(e.text ? [e.text] : []), ...e.tagTokens];
    // the TS target returns the opens step's second value in a module slot (tsSlotted in src/target-ts.ts)
    const opens = e.entry === 'operand' && (e.head || e.signature) ? [EL_OPENS_FN, `${EL_OPENS_FN}_r1`] : [];
    const f = join(dir, `el${mod++}.ts`);
    const stubs = (gir.identLike.length ? `function ${tsTarget.shared.uniClass()}(cp: number): number { return 2; }\n` : '') + (tsTarget.shared.uniIdent(gir) ? `function ${tsTarget.shared.uniIdent(gir)}(s: string, p: number): number { return -1; }\n` : '');
    writeFileSync(f, `${tsTarget.shared.lexScan(gir)}\n${stubs}export { ${[...region.map((n) => scannerName(n)), ...opens].join(', ')} };\n`);
    const m = await import(pathToFileURL(f).href) as Record<string, (s: string, p: number) => number>;
    for (const name of region) {
      const decl = g.tokens.find((d) => d.name === name)!;
      const re = new RegExp(tokenPatternToRegex(decl.pattern), 'y');
      for (const base of tokenEdgeTexts(decl)) for (const src of [base, base + ' x', base + base, base + '<', base + '"\n}']) {
        re.lastIndex = 0;
        const mm = re.exec(src);
        const want = mm && mm[0].length > 0 ? mm[0].length : -1;
        const got = m[scannerName(name)]!(src, 0);
        scanned++;
        if (got !== want) fail(`${g.name}/${name}: ${JSON.stringify(src)} scans to ${got}, its regex to ${want}`);
      }
    }
    // A text dialect's directive tests and text-run stop: what each decides at q is decided within
    // the read it reports (the look end): an insertion at or past it never changes the decision.
    // (The reported read may pass the end: a literal compared there counts its length.)
    if (e.directives) {
      const { EL_DIR_OPEN_FN, EL_DIR_CONT_FN, EL_TEXT_STOP_FN } = await import('../src/lex-family.ts');
      const fdir = join(dir, `el${mod++}.ts`);
      const fnsOf = [EL_DIR_OPEN_FN, EL_DIR_CONT_FN, EL_TEXT_STOP_FN];
      writeFileSync(fdir, `${tsTarget.shared.lexScan(gir)}\n${stubs}export { ${fnsOf.flatMap((n) => [n, `${n}_r1`]).join(', ')} };\n`);
      const dm = await import(pathToFileURL(fdir).href) as Record<string, unknown>;
      const PIECES = ['@if', '@for', '@else', '@try', '@{', '@empty', ' ', '(', '{', 'await', 'if', 'x', '/*', '*/', '//', '\n'];
      const texts: string[] = [];
      const grow = (t: string, d: number): void => { texts.push(t); if (d < 3) for (const q of PIECES) grow(t + q, d + 1); };
      grow('', 0);
      for (const fn of fnsOf) {
        const call = (t: string): [number, number] => { const h = (dm[fn] as (s: string, q: number, look: number) => number)(`a${t}`, 1, 0); return [h, dm[`${fn}_r1`] as number]; };
        for (const t of texts) {
          const [h, re] = call(t);
          decided++;
          // a text-run stop that holds is the token lexed next at q: its match is that token's
          if (fn === EL_TEXT_STOP_FN && h !== 0) continue;
          // (q + 1 is within the end + 1 of the token decided at q, which takes q: always free)
          for (let at = Math.max(re - 1, 2); at <= t.length; at++) for (const tail of ['x', ' ', '(', '{', '*/', ')']) {
            const u = t.slice(0, at) + tail + t.slice(at);
            if (call(u)[0] !== h) { fail(`${g.name}: ${fn}(${JSON.stringify(t)}) = ${h} read to ${re}, but ${JSON.stringify(u)} decides ${call(u)[0]}`); break; }
          }
        }
      }
    }
    if (!opens.length) continue;
    const tp = g.elements!.typeParameters!;
    const head = tp.head ? new RegExp(`(?:${tokenPatternToRegex(tp.head)})`, 'y') : null;
    const ident = g.tokens.find((t) => t.identifier)!;
    const sig = tp.signature ? new RegExp(`\\s*(?:${tokenPatternToRegex(ident.pattern)})\\s*>\\s*\\(`, 'y') : null;
    const want = (s: string): number => {
      if (head) { head.lastIndex = 1; if (head.test(s)) return EL_NOT; }
      if (sig) { sig.lastIndex = 1; if (sig.test(s)) return EL_SPECULATE; }
      return EL_OPEN;
    };
    const PIECES = ['T', 'const', 'extends', ' ', '\n', ',', '=', '==', '=>', '>', '/', '(', 'x', '_1', '$', ' ', 'U'];
    const texts: string[] = [];
    const grow = (s: string, d: number): void => { texts.push(s); if (d < 4) for (const p of PIECES) grow(s + p, d + 1); };
    grow('<', 0);
    for (const s of texts) {
      const op = m[EL_OPENS_FN]!(s, 0), re = m[`${EL_OPENS_FN}_r1`] as unknown as number;
      decided++;
      if (op !== want(s)) { fail(`${g.name}: ${EL_OPENS_FN}(${JSON.stringify(s)}) = ${op}, the interpreter's vetoes ${want(s)}`); continue; }
      // the read bound: past it nothing changes the decision
      if (re < 1 || re > s.length + 1) fail(`${g.name}: ${EL_OPENS_FN}(${JSON.stringify(s)}) reads to ${re}`);
      else if (re <= s.length) for (const tail of ['x', ' ', ',', '>', '(', '=']) {
        const t = s.slice(0, re) + tail + s.slice(re);
        if (want(t) !== op) fail(`${g.name}: ${JSON.stringify(s)} decided by reading to ${re}, but ${JSON.stringify(t)} decides ${want(t)}`);
      }
    }
  }
  console.log(`  element regions: ${scanned} region-token texts scan to their regex's end; ${decided} type-parameter veto texts decided as the interpreter decides, within their read bound`);
}

// ── 7. the literals a token kind can be (tokenLiterals) hold every literal its regex can match ──
// A lexer records literal id 0 without a lookup for a kind whose list is empty, so a list must
// hold every literal a token of the kind can be: here, every literal its whole token regex (what
// the interpreter's lexer runs) matches. The typescript grammar's lists are also pinned, so a
// change in what the analysis proves is seen.
{
  let pairs = 0;
  const GS = ['../javascript.ts', '../typescript.ts', ...['calc', 'minijs', 'richtokens', 'regexjs', 'templatejs', 'envspec', 'envtpl', 'altjs', 'nudjs', 'sljs', 'unilits'].map((f) => `./fixtures/${f}.ts`)];
  for (const path of GS) {
    const g = (await import(path)).default as Grammar;
    const pir = portableIR(g);
    const lits = buildLexIdPlan(pir).lids.slice(1);
    for (const t of tsTarget.shared.scannedTokens(pir)) {
      const decl = g.tokens.find((d) => d.name === t.name)!;
      const re = new RegExp(`^(?:${tokenPatternToRegex(decl.pattern)})$`);
      const have = new Set(tsTarget.shared.tokenLiterals(pir, t, lits));
      for (const l of lits) {
        pairs++;
        if (re.test(l) && !have.has(l)) fail(`${g.name}: ${t.name}'s regex matches the literal ${JSON.stringify(l)}, which tokenLiterals leaves out`);
      }
    }
  }
  const ts = (await import('../typescript.ts')).default as Grammar;
  const tir = portableIR(ts);
  const tlits = buildLexIdPlan(tir).lids.slice(1);
  const lists = Object.fromEntries(tsTarget.shared.scannedTokens(tir).filter((t) => !t.skip).map((t) => [t.name, tsTarget.shared.tokenLiterals(tir, t, tlits)]));
  const words = tlits.filter((l) => /^[A-Za-z_$][\w$]*$/.test(l));
  if (JSON.stringify(lists['Ident']) !== JSON.stringify(words)) fail(`typescript: Ident can be ${JSON.stringify(lists['Ident'])}, want every word literal`);
  if (JSON.stringify(lists['Decorator']) !== JSON.stringify(['@new'])) fail(`typescript: Decorator can be ${JSON.stringify(lists['Decorator'])}, want ["@new"]`);
  const none = Object.keys(lists).filter((k) => lists[k]!.length === 0).sort();
  const NONE = ['BigInt', 'BinaryNumber', 'HexNumber', 'Number', 'OctalNumber', 'PrivateField', 'Regex', 'String'];
  if (JSON.stringify(none) !== JSON.stringify(NONE)) fail(`typescript: the kinds that can be no literal are ${JSON.stringify(none)}, want ${JSON.stringify(NONE)}`);
  const tl = tsTarget.shared.templateLiterals(tir, tlits);
  if (Object.values(tl).some((l) => l.length > 0)) fail(`typescript: a template piece can be a literal: ${JSON.stringify(tl)}`);
  console.log(`  ${pairs} (token, literal) pairs: every literal a token's regex matches is in its tokenLiterals; typescript records 0 for ${none.length} kinds and the template pieces`);
}

// ── 9. at a non-ASCII unit a lexer tries only the candidates that can begin with one ──
// A lexer's first-byte dispatch sends a token start whose unit is >= 128 to its fallback list
// (buildLexDispatchPlan). A candidate left out of that list must be one no non-ASCII character can
// begin: proved here by lex-match-plan's own first-character analysis of the token pattern (a
// punctuator: its first character), and seen on the token's regex at a sample of non-ASCII starts.
{
  const GS = ['../javascript.ts', '../typescript.ts', ...['calc', 'minijs', 'richtokens', 'regexjs', 'templatejs', 'envspec', 'envtpl', 'altjs', 'nudjs', 'sljs', 'unilits'].map((f) => `./fixtures/${f}.ts`)];
  const STARTS = ['\u0080', '\u00a0', 'é', 'ñ', '\u2028', '\u2029', '\u3000', '\ufeff', '日', 'ŉ', '😀', '\u0301', '\u200c', '\uffff'];
  let dropped = 0, kept = 0;
  for (const path of GS) {
    const g = (await import(path)).default as Grammar;
    const pir = portableIR(g);
    const toks = tsTarget.shared.scannedTokens(pir);
    const cands: { name: string; pattern: import('../src/types.ts').TokenPattern }[] = [
      ...toks.map((t) => ({ name: t.name, pattern: g.tokens.find((d) => d.name === t.name)!.pattern })),
      ...pir.puncts.map((p) => ({ name: JSON.stringify(p), pattern: p as import('../src/types.ts').TokenPattern })),
    ];
    const { fallbackIndices } = buildLexDispatchPlan([...toks.map(lexTokFirstBytes), ...pir.puncts.map(punctFirstBytes)]);
    const inFallback = new Set(fallbackIndices);
    cands.forEach((c, i) => {
      if (inFallback.has(i)) { kept++; return; }
      dropped++;
      const wide = info(c.pattern).first.filter(([, hi]) => hi >= 128);
      if (wide.length) fail(`${g.name}: ${c.name} is left out of the non-ASCII fallback, but its pattern can begin with ${JSON.stringify(wide)}`);
      const re = new RegExp(tokenPatternToRegex(c.pattern), 'y');
      for (const st of STARTS) {
        re.lastIndex = 0;
        const m = re.exec(`${st}a1 ;\n`);
        if (m && m[0].length > 0) fail(`${g.name}: ${c.name} is left out of the non-ASCII fallback, but its regex matches ${JSON.stringify(m[0])} at ${JSON.stringify(st)}`);
      }
    });
    if (g.name === 'typescript') {
      // No typescript token or punctuator begins with a non-ASCII character: such a start goes
      // straight to the Unicode whitespace test and the identifier fallback.
      const names = fallbackIndices.map((i) => cands[i]!.name);
      if (names.length) fail(`typescript: the non-ASCII fallback holds ${JSON.stringify(names)}, want none`);
    }
  }
  console.log(`  ${dropped} candidates left out of a non-ASCII fallback (${kept} kept), none can begin with a non-ASCII character`);
}

// ── 10. what a token's decision reads past its end (the relex anchor rule's plan) ──
// lex-match-plan's read bounds of every token of every grammar, pinned for javascript; and, for
// every scanned token of every portable grammar, the bounds proved by the printed scanners
// themselves: a scan's result (its end, or no match) is the same whatever the source holds at
// and after the bound: `readEnd` (or failRead) for an attempt that fails, the end + 1 for a match,
// or, where the unit at the end is one of `overTrigger`, the first unit after the end that is not
// one of `examinedUnits`, + 1.
{
  const { failRead, overRead, overTrigger, examinedUnits, reach, minUnits, maxUnits } = await import('../src/lex-match-plan.ts');
  const { tokLook, lexLookPlan, readEndName } = await import('../src/lex-family.ts');
  const inC = (c: number, s: [number, number][]) => s.some(([a, b]) => c >= a && c <= b);
  // javascript, by its token patterns: [failRead, overRead, overTrigger empty?]
  const JS_TABLE: Record<string, [number, number, boolean]> = {
    // (a lazy repeat is bounded as the regex runs it: a block comment reads nothing past its `*/`)
    Shebang: [2, 1, true], JSDoc: [Infinity, 0, true], TripleSlash: [Infinity, 1, true], LineComment: [2, 1, true],
    BlockComment: [Infinity, 0, true], Ident: [Infinity, Infinity, false], HexNumber: [Infinity, 2, false],
    OctalNumber: [Infinity, 2, false], BinaryNumber: [Infinity, 2, false], BigInt: [Infinity, 1, true], Number: [Infinity, Infinity, false], LegacyNumber: [Infinity, Infinity, false],
    String: [Infinity, Infinity, true], Template: [Infinity, 0, true], Regex: [Infinity, Infinity, false], Decorator: [Infinity, Infinity, false],
    PrivateField: [Infinity, Infinity, false],
  };
  const jsg = (await import('../javascript.ts')).default as Grammar;
  for (const d of jsg.tokens) {
    const want = JS_TABLE[d.name];
    const got: [number, number, boolean] = [failRead(d.pattern), overRead(d.pattern), overTrigger(d.pattern).length === 0];
    if (!want || JSON.stringify(want) !== JSON.stringify(got)) fail(`javascript/${d.name}: (failRead, overRead, no trigger) ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  const rx = jsg.tokens.find((d) => d.name === 'Regex')!;
  const rxStops = JSON.stringify(complementBMP(examinedUnits(rx.pattern)));
  if (rxStops !== '[[10,10],[13,13],[8232,8233]]') fail(`javascript/Regex: the units no attempt goes past are ${rxStops}, want the four line terminators`);
  function complementBMP(s: [number, number][]): [number, number][] {
    const out: [number, number][] = [];
    let lo = 0;
    for (const [a, b] of [...s].sort((x, y) => x[0] - y[0])) { if (b < 0) continue; if (a > lo) out.push([lo, Math.min(a - 1, 0xffff)]); lo = Math.max(lo, b + 1); if (lo > 0xffff) break; }
    if (lo <= 0xffff) out.push([lo, 0xffff]);
    return out;
  }
  // Every grammar's every token: the functions agree with one another.
  let rows = 0;
  for (const n of ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'html', 'yaml']) {
    const g = (await import(`../${n}.ts`)).default as Grammar;
    for (const d of g.tokens) {
      rows++;
      const f = failRead(d.pattern), o = overRead(d.pattern), r = reach(d.pattern);
      if (Number.isNaN(f) || Number.isNaN(o) || Number.isNaN(r)) fail(`${n}/${d.name}: a read bound is NaN`);
      if (f > r) fail(`${n}/${d.name}: failRead ${f} > reach ${r}`);
      if (minUnits(d.pattern) > maxUnits(d.pattern)) fail(`${n}/${d.name}: minUnits > maxUnits`);
    }
  }
  // The plan of javascript's lexer: which failed attempts and which matches it checks.
  const jir = portableIR(jsg);
  const jplan = lexLookPlan(jir);
  const noted = [...new Set(jplan.arms.flatMap((a) => a.cands.filter((c) => c.readEnd).map((c) => c.tok)))].sort();
  const overToks = jplan.over.map((o) => o.tok).sort();
  if (JSON.stringify(noted) !== JSON.stringify(['BigInt', 'BinaryNumber', 'BlockComment', 'Decorator', 'HexNumber', 'JSDoc', 'Number', 'OctalNumber', 'Regex', 'TripleSlash'])) fail(`javascript: failed attempts checked ${JSON.stringify(noted)}`);
  if (JSON.stringify(overToks) !== JSON.stringify(['Decorator', 'Ident', 'LegacyNumber', 'Number', 'PrivateField', 'Regex'])) fail(`javascript: matches checked ${JSON.stringify(overToks)}`);
  console.log(`  ${rows} tokens of 6 grammars: read bounds consistent; javascript's pinned; its relex checks the failed attempts of ${noted.length} tokens and the matches of ${overToks.length}`);

  // Proved on the printed scanners.
  const PORTABLE = ['../javascript.ts', '../typescript.ts', ...['calc', 'minijs', 'richtokens', 'regexjs', 'templatejs', 'envspec', 'envtpl', 'altjs', 'nudjs', 'sljs', 'unilits'].map((f) => `./fixtures/${f}.ts`)];
  const TAILS = ['', ' x', '\n;', '_x', '.x', '_1_1x', 'e+', '\\u{4', '\\u004', '*/', '/', '"', 'n', '1', 'x\n'];
  const REPL = ['', 'x', '0', '/', '*/', '}', '\n', '"', '\\u0041', ' ', '_5', 'e5', '{'];
  let proved = 0, unbounded = 0;
  for (const path of PORTABLE) {
    const g = (await import(path)).default as Grammar;
    const gir = portableIR(g);
    const toks = tsTarget.shared.scannedTokens(gir);
    const plan = lexLookPlan(gir);
    const withEnd = new Set(plan.arms.flatMap((a) => a.cands.filter((c) => c.readEnd).map((c) => c.tok!)));
    const f = join(dir, `reads${mod++}.ts`);
    const stubs = (gir.identLike.length ? `function ${tsTarget.shared.uniClass()}(cp: number): number { return 2; }\n` : '') + (tsTarget.shared.uniIdent(gir) ? `function ${tsTarget.shared.uniIdent(gir)}(s: string, p: number): number { return -1; }\n` : '');
    const exps = [...toks.map((t) => tsTarget.shared.scanner(t.name)), ...[...withEnd].map(readEndName)];
    writeFileSync(f, `${tsTarget.shared.lexScan(gir)}\n${stubs}export { ${exps.join(', ')} };\n`);
    const scan = await import(pathToFileURL(f).href) as Record<string, (s: string, p: number) => number>;
    for (const t of toks) {
      const decl = g.tokens.find((d) => d.name === t.name)!;
      const look = tokLook(t);
      const fn = scan[tsTarget.shared.scanner(t.name)]!;
      let bad = 0;
      for (const base of tokenEdgeTexts(decl)) {
        for (const src of TAILS.map((tl) => base + tl)) {
          const e = fn(src, 0);
          let bound: number;
          if (e < 0) {
            if (look.failRead <= 3) bound = Math.max(0, look.failRead);
            else if (withEnd.has(t.name)) bound = scan[readEndName(t.name)]!(src, 0);
            else { unbounded++; continue; }
          } else if (e < src.length && inC(src.charCodeAt(e), look.trig)) {
            let q = e;
            while (q < src.length && inC(src.charCodeAt(q), look.examined)) q++;
            bound = q + 1;
          } else bound = e + 1;
          for (let c = Math.max(0, bound); c <= src.length; c++) {
            for (const rp of REPL) {
              const alt = src.slice(0, c) + rp;
              proved++;
              const e2 = fn(alt, 0);
              if (e2 !== e && bad++ < 3) fail(`${g.name}/${t.name}: ${JSON.stringify(src)} scans to ${e}, and to ${e2} with ${JSON.stringify(rp)} from ${c} (its reads were bounded by ${bound})`);
            }
          }
        }
      }
    }
  }
  console.log(`  every portable grammar: ${proved} scans unchanged by any text at or after their read bound (${unbounded} failed attempts no relex check needs: last in their arms)`);

  // The same bounds proved on the regexes the interpreter's lexer runs (src/emit-lexer.ts records
  // them while lexing): every token of every grammar, a failed attempt bounded by its
  // `readEndWalk` (or by two units where its first two rule a longer read out: `failReadFirst`,
  // `continuesAt`), a match by the unit after its end, or, at an `overTrigger` unit, by the first
  // unit after the end outside `examinedUnits`, + 1. Lazy repeats (block comments) included.
  const { readEndWalk, failReadFirst, continuesAt } = await import('../src/lex-match-plan.ts');
  const { tokenPatternSource } = await import('../src/token-pattern.ts');
  const walkEnd = (w: ReturnType<typeof readEndWalk>, s: string): number => {
    let q = 0;
    for (const it of w.lead) {
      if ('lit' in it) { if (!s.startsWith(it.lit, q)) return q + it.lit.length; q += it.lit.length; }
      else { if (q >= s.length || !inC(s.charCodeAt(q), it.cls)) return q + 1; q++; }
    }
    while (q < s.length && inC(s.charCodeAt(q), w.past)) q++;
    return q + 1;
  };
  let rxProved = 0;
  for (const n of ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'html', 'yaml']) {
    const g = (await import(`../${n}.ts`)).default as Grammar;
    for (const d of g.tokens) {
      if (d.template) continue;
      const re = new RegExp(`(?:${tokenPatternSource(d)})`, 'y');
      const run = (s: string): number => { re.lastIndex = 0; const m = re.exec(s); return m === null ? -1 : m[0].length; };
      const w = readEndWalk(d.pattern), trig = overTrigger(d.pattern), ex = examinedUnits(d.pattern);
      let bad = 0;
      for (const base of tokenEdgeTexts(d)) {
        for (const src of TAILS.map((tl) => base + tl)) {
          const e = run(src);
          let bound: number;
          // as the lexer bounds it: from the arm's first unit (failReadFirst, continuesAt), else the walk
          if (e < 0) bound = src.length === 0 ? 1 : failReadFirst(d.pattern, src.charCodeAt(0)) <= 2 || src.length < 2 || !inC(src.charCodeAt(1), continuesAt(d.pattern, src.charCodeAt(0))) ? 2 : walkEnd(w, src);
          else if (e < src.length && inC(src.charCodeAt(e), trig)) { let q = e; while (q < src.length && inC(src.charCodeAt(q), ex)) q++; bound = q + 1; }
          else bound = e + 1;
          for (let c = Math.max(0, bound); c <= src.length; c++) {
            for (const rp of REPL) {
              rxProved++;
              const e2 = run(src.slice(0, c) + rp);
              if (e2 !== e && bad++ < 3) fail(`${n}/${d.name} (regex): ${JSON.stringify(src)} matches to ${e}, and to ${e2} with ${JSON.stringify(rp)} from ${c} (its reads were bounded by ${bound})`);
            }
          }
        }
      }
    }
  }
  console.log(`  every grammar's token regexes (the interpreter's lexer): ${rxProved} matches unchanged by any text at or after their read bound`);
}

// ── 11. the relex / scanMeta family has ONE source too, src/relex-family.ts (formerly relex-family) ──
//   a. every portable target's output embeds the family exactly as printed from that source
//      (adapters cannot patch or re-decide it per target);
//   b. each family function is defined exactly once per output (no hand-written duplicate or
//      per-mode variant left beside it), and stateful modes define no stateless toMeta;
//   c. the fixtures below cover every lexer mode the family specializes for — the behavioral
//      edit ≡ fresh / streamEq / oracle-alignment checks for them live in portable-targets.
{
  const FIXTURES: Array<{ path: string; mode: string }> = [
    { path: './fixtures/calc.ts', mode: 'plain' },
    { path: './fixtures/envspec.ts', mode: 'newline' },
    { path: './fixtures/regexjs.ts', mode: 'regex' },
    { path: './fixtures/templatejs.ts', mode: 'template' },
    { path: '../javascript.ts', mode: 'regex+template' },
    { path: './fixtures/envtpl.ts', mode: 'full-relex' },
  ];
  const modeName = (m: RelexMode): string => {
    if (!m.window) return 'full-relex';
    const parts = [m.newline && 'newline', m.regex && 'regex', m.template && 'template'].filter(Boolean);
    return parts.length ? parts.join('+') : 'plain';
  };
  const RELEX_HOSTS: Array<{ host: string; target: PortableTarget; def: (name: string) => RegExp }> = [
    { host: 'ts', target: tsTarget, def: (n) => new RegExp(`^(function ${n}\\(|const ${n} =)`, 'gm') },
    { host: 'go', target: goTarget, def: (n) => new RegExp(`^func ${n}\\(`, 'gm') },
    { host: 'rust', target: rustTarget, def: (n) => new RegExp(`^fn ${n.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())}\\(`, 'gm') },
  ];
  const FAMILY_NAMES = ['toMeta', 'scanMetaToks', 'scanMeta', 'checkStreamEq', 'editRange', 'applyEdits', 'applyEdit',
    'findTokAtOff', 'findTokAtOffKind', 'reconstructParens', 'parenStacksEq', 'windowRelexStep', 'relexEdits'];
  const seen = new Set<string>();
  for (const f of FIXTURES) {
    const grammar = (await import(f.path)).default;
    const ir = portableIR(grammar);
    const mode = relexMode(ir);
    const name = modeName(mode);
    seen.add(name);
    if (name !== f.mode) fail(`${f.path}: expected mode ${f.mode}, got ${name}`);
    const expected = new Set(relexFamilyFns(mode).map((fn) => fn.name));
    for (const h of RELEX_HOSTS) {
      const out = emitParser(grammar, h.target);
      const family = emitRelexFamily(ir, h.target.lowering!);
      const at = out.indexOf(family);
      if (at < 0) { fail(`${f.path}/${h.host}: output does not embed the generated family verbatim`); continue; }
      if (out.indexOf(family, at + 1) >= 0) fail(`${f.path}/${h.host}: family embedded twice`);
      for (const fn of FAMILY_NAMES) {
        const n = (out.match(h.def(fn)) ?? []).length;
        const want = expected.has(fn) ? 1 : 0;
        if (n !== want) fail(`${f.path}/${h.host}: ${fn} defined ${n}×, want ${want}`);
      }
    }
    console.log(`  ${f.path}: relex ${name} — family embedded once per host, ${expected.size} functions`);
  }
  for (const m of ['plain', 'newline', 'regex', 'template', 'regex+template', 'full-relex']) {
    if (!seen.has(m)) fail(`no fixture covers lexer mode ${m}`);
  }
}

if (failures > 0) {
  console.error(`\n✗ lex-family: ${failures} problem(s)`);
  process.exit(1);
}
console.log('\n✓ lex-family: token scanners authored once, printed per target, called by every emitted lexer; the relex family embedded verbatim from its one source');
