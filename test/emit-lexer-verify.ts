// Gate: the generated lexer (emit-lexer.ts — the only lexer implementation) reproduces
// the frozen behavioural baseline in test/golden/lexer/. Each golden file holds one lexer
// spec (tokens, literals, markup / indent / newline config) and the token streams — or the
// exact error message — the former data-driven lexer (createLexer) produced for every input the
// full test suite fed it (plus the yaml-test-suite inputs and hand-picked inputs for every
// error kind). Token = [type, offset, length, flags], flags 1 newlineBefore, 2 commentBefore,
// 4 multilineFlowBefore. Two consumers of the one generator are checked:
//   1. compileTokenizer(spec) — the tokenizer the interpreter (createParser) runs, per golden;
//   2. the emitted parser module's public tokenize() and its parse-path token columns, for
//      every shipped grammar (token-stream, markup and indentation modes alike). An emitted
//      lexer scans every '>' alone where its grammar composes '>'-led operators in the parser
//      (gtComposites), so a golden token holding such an operator is expected as one single-
//      character punctuation token per character, the first carrying the golden flags.
//   node test/emit-lexer-verify.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compileTokenizer, type LexSpec, type Token } from '../src/emit-lexer.ts';
import { emitParser } from '../src/target.ts';
import { jsTarget } from '../src/emit-parser.ts';
import { gtComposites } from '../src/grammar-utils.ts';
import { scratchDir } from './scratch.ts';

const TMP = scratchDir('emit-lexer-verify');

type Golden = { spec: LexSpec & { name: string | null }; types: string[]; cases: [string, number[] | string][] };
const DIR = new URL('./golden/lexer/', import.meta.url);
const goldens = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({ file: f, g: JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) as Golden }));

const FLAGS = (t: Token) => (t.newlineBefore ? 1 : 0) | (t.commentBefore ? 2 : 0) | (t.multilineFlowBefore ? 4 : 0);

// Compare one tokenizer against one golden; returns the number of mismatching cases.
function check(label: string, g: Golden, tokenize: (s: string) => Token[], parse?: { parse: (s: string) => unknown; tokenAt: (i: number) => Token }, composed: string[] = []) {
  let bad = 0, errs = 0, cols = 0;
  for (const [src, want] of g.cases) {
    let got: Token[] | null = null, err: string | null = null;
    try { got = tokenize(src); } catch (e: any) { err = e.message; }
    if (typeof want === 'string') {
      errs++;
      if (err !== want) { bad++; if (bad <= 5) console.log(`  ${label} ERROR MISMATCH ${JSON.stringify(src.slice(0, 60))}\n    want: ${want}\n    got : ${err ?? 'tokens'}`); }
      continue;
    }
    if (err !== null) { bad++; if (bad <= 5) console.log(`  ${label} THREW ${JSON.stringify(src.slice(0, 60))}: ${err}`); continue; }
    const exp: [string, number, number, number][] = [];
    for (let i = 0; i < want.length; i += 4) {
      const [type, off, len, flags] = [g.types[want[i]]!, want[i + 1]!, want[i + 2]!, want[i + 3]!];
      if (type === '' && composed.includes(src.slice(off, off + len))) for (let c = 0; c < len; c++) exp.push(['', off + c, 1, c === 0 ? flags : 0]);
      else exp.push([type, off, len, flags]);
    }
    let diff = got!.length !== exp.length ? `length ${got!.length} vs ${exp.length}` : '';
    for (let i = 0; !diff && i < got!.length; i++) {
      const t = got![i];
      if (t.text !== src.slice(t.offset, t.offset + t.text.length)) diff = `token ${i} text is not its source span`;
      else if (JSON.stringify([t.type, t.offset, t.text.length, FLAGS(t)]) !== JSON.stringify(exp[i])) {
        diff = `token ${i}: got ${JSON.stringify([t.type, t.offset, t.text.length, FLAGS(t)])} want ${JSON.stringify(exp[i])}`;
      }
    }
    // The parse path's token columns (after an accepted parse) hold the same stream.
    if (!diff && parse) {
      let ok = false;
      try { parse.parse(src); ok = true; } catch { /* columns are compared on accepted inputs */ }
      if (ok) {
        cols++;
        for (let i = 0; i < got!.length && !diff; i++) {
          const x = got![i], y = parse.tokenAt(i);
          if (!(x.type === y.type && x.offset === y.offset && x.text === y.text && x.k === y.k && x.t === y.t && FLAGS(x) === FLAGS(y))) diff = `parse column ${i}: ${JSON.stringify(y)} vs tokenize ${JSON.stringify(x)}`;
        }
      }
    }
    if (diff) { bad++; if (bad <= 5) console.log(`  ${label} ${JSON.stringify(src.slice(0, 60))}: ${diff}`); }
  }
  console.log(`${bad ? '✗' : '✓'} ${label}: ${g.cases.length} inputs (${errs} lex errors${parse ? `, parse columns on ${cols}` : ''})${bad ? ` — ${bad} mismatches` : ''}`);
  return bad;
}

let bad = 0;

// ── 1) every golden spec through the compiled tokenizer (the interpreter's lexer) ──
for (const { file, g } of goldens) bad += check(`compileTokenizer ${file}`, g, compileTokenizer(g.spec));

// ── 2) every shipped grammar through its emitted parser module ──
for (const name of ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'html', 'yaml']) {
  const grammar = (await import(`../${name}.ts`)).default;
  const matches = goldens.filter(({ g }) => g.spec.name === name);
  if (matches.length !== 1) { console.log(`✗ ${name}: expected exactly one golden, found ${matches.length}`); bad++; continue; }
  const src = emitParser(grammar, jsTarget);
  const path = `${TMP}/${name}.mts`;
  writeFileSync(path, src);
  const m = await import(path + '?v=' + Date.now());
  bad += check(`emitted ${name}`, matches[0].g, m.tokenize, m, gtComposites(grammar));
}

// ── 3) an identifier the ASCII pattern cut short extends only from a unit beyond ASCII ──
// (docs/TARGETS.md: where the token's own pattern stops at an ASCII unit, it ends; as the portable
// lexers' lxExt does): on a toy whose identifier pattern lacks `$`, `a$` is `a` then `$` (the
// Unicode fallback's identifier), never one `a$`; an extension begun at `é` takes the whole
// IdentifierPart run after it, ASCII included (`naïve`, `aé$`).
{
  const { token, rule, defineGrammar, seq, oneOf, range, star, many } = await import('../src/api.ts');
  const { lexSpecOf } = await import('../src/emit-lexer.ts');
  const Ident = token(seq(oneOf(range('a', 'z'), '_'), star(oneOf(range('a', 'z'), range('0', '9'), '_'))), { identifier: true });
  const P = rule(() => [[many(Ident)]]);
  const tokenize = compileTokenizer(lexSpecOf(defineGrammar({ name: 'idtoy', tokens: { Ident }, rules: { P } })));
  const rows: [string, string[]][] = [['a$', ['a', '$']], ['a$b', ['a', '$b']], ['ab1 c', ['ab1', 'c']], ['aé', ['aé']], ['aé$', ['aé$']], ['naïve x', ['naïve', 'x']], ['é$ a$', ['é$', 'a', '$']], ['caf\u00e9 x', ['café', 'x']]];
  for (const [src, want] of rows) {
    const got = tokenize(src).map((t) => t.text);
    if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; console.log(`✗ identifier extension ${JSON.stringify(src)}: ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
  }
  console.log(`✓ identifier extension: ${rows.length} rows on a toy whose identifier pattern lacks \`$\``);
}

if (bad > 0) process.exit(1);
console.log('✓ generated lexer ≡ golden token streams + error messages');
