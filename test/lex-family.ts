// Gate: the lexer token scanners exist once, in the shared lex-scan family (src/lex-family.ts),
// and every portable target lexes through them.
//
//   1. no target module recognizes tokens itself: no LexTok-kind or token-pattern switch, no
//      TokenPattern import — scanning arrives via `shared.lexScan` / `shared.scanner`;
//   2. in every emitted TS / Go / Rust lexer, each scanned token's scanner is defined exactly
//      once and called from the dispatch loop — or, for a lowering that splices inline fns (Go),
//      no scanner fn is printed and each scanner's statements appear at the dispatch;
//   2b. a skipped token's dispatch site takes whether its text holds a line terminator from the
//      scanner, which walked that text: it reads none of the skipped text again;
//   3. the family, printed through the TS target and executed, scans a grammar covering every
//      scanner kind (block comments with and without a guard after the opener, line comments,
//      escaping strings, char runs, seq / alt / repeat / negated-lookahead patterns, and
//      patterns whose regex has to back up out of a choice: an alternative, a repeat of one
//      character, a bounded repeat, a lazy repeat) to the regex's end — and to -1 on
//      unterminated or non-matching input, and at a negative position; a skipped token's
//      scanner also answers whether the text it matched holds a line terminator, including
//      where the scan read one in a choice it gave up;
//   4b. a fast-path scanner kind is chosen only for a pattern of exactly that shape: a pattern
//      that only begins and ends like a string or a comment is scanned by its own matcher;
//   4. the same cases pass through every scanner spliced by generation-time inlining;
//   6. every portable grammar's scanners end where their token regex's match ends, and a skipped
//      token's scanner holds a line terminator exactly when that match does;
//   5. those cases catch defects: each mutant of the printed scanners, and of the splicing
//      (a loop return that does not end the loop, a missing after-loop guard), fails a case.
//
//   node test/lex-family.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { token, rule, defineGrammar, many, seq, plus, star, oneOf, noneOf, range, repeat, altPattern, anyChar, notFollowedBy } from '../src/api.ts';
import { portableIR, type ParserIR } from '../src/emit-portable.ts';
import { tsTarget, goTarget, rustTarget } from '../src/emit.ts';
import type { CstGrammar } from '../src/types.ts';
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
// Skipped patterns that read a line terminator in a choice they give up: the first alternative
// reads `a` and the line feed before it fails; the repeat runs to the end and backs up to the `!`.
const Mark = token(seq('#', altPattern(seq('a', '\n', 'b'), 'a')), { skip: true });
const Bang = token(seq('~', star(anyChar()), '!'), { skip: true });
const Atom = rule(() => [Esc, Tag, Lazy, Hex, Float, Int, Str, Ident]);
const Program = rule(() => [[many(Atom)]]);
const kinds = defineGrammar({
  name: 'lexkinds',
  tokens: { LineComment, DocComment, BlockComment, Mark, Bang, Esc, Tag, Lazy, Str, Hex, Float, Int, Ident },
  rules: { Atom, Program },
  entry: Program,
});
const flat = (await import('../javascript.ts')).default as CstGrammar;

const kindOf = (ir: ParserIR, name: string) => ir.tokens.find((t) => t.name === name);
const ir = portableIR(kinds);
const want: [string, string][] = [['LineComment', 'line'], ['DocComment', 'block'], ['BlockComment', 'block'], ['Mark', 'pattern'], ['Bang', 'pattern'], ['Esc', 'pattern'], ['Tag', 'pattern'], ['Lazy', 'pattern'], ['Str', 'string'], ['Hex', 'pattern'], ['Float', 'pattern'], ['Int', 'pattern'], ['Ident', 'run']];
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

// ── 2. every emitted lexer defines each scanner once and calls it ──
const HOSTS = [
  { name: 'typescript', target: tsTarget, def: (n: string) => `function ${n}(`, use: (n: string) => `${n}(src, pos)` as string | null },
  { name: 'go', target: goTarget, def: (n: string) => `func ${n}(`, use: null },
  { name: 'rust', target: rustTarget, def: (n: string) => `fn ${n}(`, use: (n: string) => `${n}(src, pos as isize)` },
];
const count = (s: string, sub: string) => s.split(sub).length - 1;
// Where `block` occurs as consecutive lines of `out`, ignoring indentation: the line after each.
const blockEnds = (out: string[], block: string[]): number[] => {
  const b = block.map((l) => l.trim());
  const ends: number[] = [];
  for (let i = 0; i + b.length <= out.length; i++) if (b.every((l, k) => out[i + k] === l)) ends.push(i + b.length);
  return ends;
};
const countBlock = (out: string[], block: string[]): number => blockEnds(out, block).length;
// A dispatch site that slices the source between the token's start and end reads that text again.
const RESCAN = /src\[pos\s*(\.\.|:)\s*e\]|src\.slice\(pos, e\)/;
const GRAMMARS: [string, CstGrammar][] = [['lexkinds', kinds], ['javascript', flat], ['calc', (await import('./fixtures/calc.ts')).default], ['envtpl', (await import('./fixtures/envtpl.ts')).default]];
for (const [gname, g] of GRAMMARS) {
  const gir = portableIR(g);
  for (const h of HOSTS) {
    const out = h.target.emitParser(g);
    const lines = out.split('\n').map((l) => l.trim());
    const toks = h.target.shared.scannedTokens(gir);
    for (const t of toks) {
      if (h.use === null) {
        if (out.includes(h.def('lexScan'))) fail(`${gname}/${h.name}: prints a scanner fn although it splices them`);
        const ends = blockEnds(lines, h.target.shared.scanInline(gir, t.name, { s: 'src', p: 'pos', out: 'e', ...(t.skip ? { nl: 'nl' } : {}) }));
        if (ends.length < 1) fail(`${gname}/${h.name}: ${t.name}'s scanner is not spliced into the lexer`);
        if (t.skip) for (const i of ends) if (RESCAN.test(lines[i])) fail(`${gname}/${h.name}: ${t.name}'s dispatch site reads the skipped text again: ${lines[i]}`);
        continue;
      }
      const n = h.target.shared.scanner(t.name);
      if (count(out, h.def(n)) !== 1) fail(`${gname}/${h.name}: ${n} defined ${count(out, h.def(n))}×, want 1`);
      if (count(out, h.use(n)) < 1) fail(`${gname}/${h.name}: ${n} is never called by the lexer`);
      if (t.skip) for (const l of lines) if (l.includes(h.use(n)) && RESCAN.test(l)) fail(`${gname}/${h.name}: ${t.name}'s dispatch site reads the skipped text again: ${l}`);
    }
    if (gir.tpl && toks.some((t) => t.name === gir.tpl!.token)) fail(`${gname}/${h.name}: the template token is scanned outside the template state machine`);
  }
  console.log(`  ${gname}: ${portableIR(g).tokens.length} tokens; ts / rust define and call every scanner once, go splices each; no skipped text is read twice`);
}

// ── 3. the printed family, executed ──
// `nl`: a skipped token's scanner also answers whether its match holds a line terminator.
type Case = [token: string, src: string, pos: number, end: number, nl?: boolean];
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
  ['Ident', 'ab', -1, -1],
  ['LineComment', '// x', -1, -1],
  ['BlockComment', '/**/', -1, -1],
  ['Str', '"a"', -1, -1],
  ['Float', '1.5', -1, -1],
  ['LineComment', '// a\rb\nx', 0, 6, true],
  ['LineComment', '// a\u2028b', 0, 6, true],
  ['LineComment', '// a\u2029', 0, 5, true],
  ['LineComment', '// é\n', 0, 4, false],
  ['BlockComment', '/* a\n */', 0, 8, true],
  ['BlockComment', '/*\r*/', 0, 5, true],
  ['BlockComment', '/* a */\n', 0, 7, false],
  ['BlockComment', '/* a\n', 0, -1, false],
  ['DocComment', '/** a\u2029 */', 0, 9, true],
  ['Mark', '#a\nb', 0, 4, true],
  ['Mark', '#a\nc', 0, 2, false],
  ['Mark', '#a', -1, -1, false],
  ['Bang', '~a\n!b', 0, 4, true],
  ['Bang', '~a!\n', 0, 3, false],
  ['Bang', '~a\n', 0, -1, false],
];
const skipped = new Set(ir.tokens.filter((t) => t.skip).map((t) => t.name));

const dir = scratchDir('lex-family');
const printed = tsTarget.shared.lexScan(ir);
const names = ir.tokens.map((t) => tsTarget.shared.scanner(t.name));
// Each scanner spliced into a wrapper fn `inline<scanner>(src, pos)`, as a dispatch site gets it.
const spliced = ir.tokens.map((t) => [
  `export function inline${tsTarget.shared.scanner(t.name)}(src: string, pos: number): ${t.skip ? '[number, boolean]' : 'number'} {`,
  ...tsTarget.shared.scanInline(ir, t.name, { s: 'src', p: 'pos', out: 'e', ...(t.skip ? { nl: 'nl' } : {}) }).map((l) => `  ${l}`),
  t.skip ? '  return [e, nl];' : '  return e;',
  '}',
].join('\n')).join('\n');
type Scan = (s: string, p: number) => number | [number, boolean];
let mod = 0;
async function load(src: string): Promise<Record<string, Scan>> {
  const f = join(dir, `scan${mod++}.ts`);
  writeFileSync(f, `${src}\nexport { ${names.join(', ')} };\n`);
  return import(pathToFileURL(f).href);
}
function run(scan: Record<string, Scan>, prefix = ''): string[] {
  const bad: string[] = [];
  for (const [tok, src, pos, end, nl] of CASES) {
    const got = JSON.stringify(scan[prefix + tsTarget.shared.scanner(tok)]!(src, pos));
    const want = JSON.stringify(skipped.has(tok) ? [end, nl ?? false] : end);
    if (got !== want) bad.push(`${tok}(${JSON.stringify(src)}, ${pos}) = ${got}, want ${want}`);
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
    ['a block ignores its guard', /if \(g < 0\) return \[-1, false\];/, ''],
    ['an alternative does not give way to the next', /(r = lexMatch\d+\(s, p\);\n\s+if \(r >= 0\) return r;\n\s+)r = lexMatch\d+\(s, p\);\n\s+if \(r >= 0\) return r;/, '$1'],
    ['a repeat of one character gives nothing back', /q = q - 1;/, 'q = p - 1;'],
    ['a lazy repeat tries one more first', /(const r: number = )(lexMatch\d+\(s, q\));/, '$1-1;'],
    ['string escape skips one character', /e = e \+ 2/, 'e = e + 1'],
    ['negated lookahead inverted', /if \(r < 0\) return p;/, 'if (r >= 0) return p;'],
    ['seq drops its last item', /const (q\d+): number = lexMatch\d+\(s, (q\d+)\);\n\s+if \(\1 < 0 \|\| \1 > s\.length\) return -1;\n\s+return \1;/, 'return $2;'],
    ['run stops after the first character', /while \(e < s\.length\) \{\n(\s+)const d/, 'while (false) {\n$1const d'],
    ['repeat ignores its minimum', /if \(n < 1\) return -1;/g, ''],
    ['a negative position is scanned', /if \(p < 0\) return (-1|\[-1, false\]);/g, ''],
    ['a skipped scan misses a carriage return', /c === 13 \|\| /g, ''],
    ['a skipped scan misses a non-ASCII line terminator', /c >= 128 && \(/g, 'false && ('],
    ['a threaded call drops the line terminators its callee read', /\n\s+nlAt = nlAt\d+;/g, ''],
    ['a skipped token counts a line terminator read past its end', /\[e, nlAt < e\]/g, '[e, nlAt < s.length]'],
  ];
  for (const [what, re, by] of MUTANTS) {
    if (!re.test(printed)) { fail(`mutant "${what}": pattern not found in the printed family`); continue; }
    const bad = run(await load(printed.replace(re, by)));
    if (!bad.length) fail(`mutant "${what}" survives every case`);
    else console.log(`  mutant "${what}": caught (${bad.length} case(s))`);
  }
  const SPLICE_MUTANTS: [string, RegExp, string][] = [
    ['a return inside a loop does not end it', /(\n\s+e = [^;\n]+;(?:\n\s+nl = [^;\n]+;)?)\n\s+break;/g, '$1'],
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
  const PORTABLE = ['../javascript.ts', '../typescript.ts', ...['calc', 'minijs', 'richtokens', 'regexjs', 'templatejs', 'envspec', 'envtpl', 'altjs', 'nudjs', 'sljs'].map((f) => `./fixtures/${f}.ts`)];
  let checked = 0;
  for (const path of PORTABLE) {
    const g = (await import(path)).default as CstGrammar;
    const gir = portableIR(g);
    const toks = tsTarget.shared.scannedTokens(gir);
    const f = join(dir, `regex${mod++}.ts`);
    writeFileSync(f, `${tsTarget.shared.lexScan(gir)}\nexport { ${toks.map((t) => tsTarget.shared.scanner(t.name)).join(', ')} };\n`);
    const scan = await import(pathToFileURL(f).href) as Record<string, Scan>;
    for (const t of toks) {
      const decl = g.tokens.find((d) => d.name === t.name)!;
      const re = new RegExp(tokenPatternToRegex(decl.pattern), 'y');
      const fn = scan[tsTarget.shared.scanner(t.name)]!;
      let bad = 0;
      for (const base of tokenEdgeTexts(decl)) {
        for (const src of [base, base + ' x', base + base, base + '\n;']) {
          re.lastIndex = 0;
          const m = re.exec(src);
          const end = m && m[0].length > 0 ? m[0].length : -1;
          // The interpreter's lexer: a skipped match holding a line terminator breaks the line.
          const want = JSON.stringify(t.skip ? [end, end >= 0 && /[\n\r\u2028\u2029]/.test(m![0])] : end);
          const got = JSON.stringify(fn(src, 0));
          checked++;
          if (got !== want && bad++ < 3) fail(`${g.name}/${t.name} (${t.kind}): ${JSON.stringify(src)} scans to ${got}, its regex to ${want}`);
        }
      }
    }
  }
  console.log(`  every portable grammar: ${checked} token-edge texts scan to their token regex's end (and a skipped token's line terminator)`);

  // ── 7. the Rust / Go sources hold no raw control character a literal may not hold ──
  // A TS template literal that prints `'\n'` without doubling the backslash hands rustc / go a
  // character literal holding a real line feed (or NUL), which neither compiler accepts; only
  // CI has rustc. Every emitted library and runner is read here instead: no control character
  // but LF and TAB anywhere, and no character literal that is a raw LF (Go, Rust) or TAB (Rust).
  let sources = 0;
  for (const path of PORTABLE) {
    const g = (await import(path)).default as CstGrammar;
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
}

if (failures > 0) {
  console.error(`\n✗ lex-family: ${failures} problem(s)`);
  process.exit(1);
}
console.log('\n✓ lex-family: token scanners authored once, printed per target, called by every emitted lexer');
