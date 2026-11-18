// Gate: the generated lexer (emit-lexer.ts — the only lexer implementation) reproduces
// the frozen behavioural baseline in test/golden/lexer/. Each golden file holds one lexer
// spec (tokens, literals, markup / indent / newline config) and the token streams — or the
// exact error message — the former data-driven lexer (createLexer) produced for every input the
// full test suite fed it (plus the yaml-test-suite inputs and hand-picked inputs for every
// error kind). Token = [type, offset, length, flags], flags 1 newlineBefore, 2 commentBefore,
// 4 multilineFlowBefore. Two consumers of the one generator are checked:
//   1. compileTokenizer(spec) — the tokenizer the interpreter (createParser) runs, per golden;
//   2. the emitted parser module's public tokenize() and its parse-path token columns, for
//      every shipped grammar (token-stream, markup and indentation modes alike).
//   node test/emit-lexer-verify.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compileTokenizer, type LexSpec, type Token } from '../src/emit-lexer.ts';
import { emitParser, jsTarget } from '../src/emit.ts';

type Golden = { spec: LexSpec & { name: string | null }; types: string[]; cases: [string, number[] | string][] };
const DIR = new URL('./golden/lexer/', import.meta.url);
const goldens = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({ file: f, g: JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) as Golden }));

const FLAGS = (t: Token) => (t.newlineBefore ? 1 : 0) | (t.commentBefore ? 2 : 0) | (t.multilineFlowBefore ? 4 : 0);

// Compare one tokenizer against one golden; returns the number of mismatching cases.
function check(label: string, g: Golden, tokenize: (s: string) => Token[], parse?: { parse: (s: string) => unknown; tokenAt: (i: number) => Token }) {
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
    let diff = got!.length * 4 !== want.length ? `length ${got!.length} vs ${want.length / 4}` : '';
    for (let i = 0; !diff && i < got!.length; i++) {
      const t = got![i];
      if (t.text !== src.slice(t.offset, t.offset + t.text.length)) diff = `token ${i} text is not its source span`;
      else if (t.type !== g.types[want[i * 4]] || t.offset !== want[i * 4 + 1] || t.text.length !== want[i * 4 + 2] || FLAGS(t) !== want[i * 4 + 3]) {
        diff = `token ${i}: got ${JSON.stringify([t.type, t.offset, t.text.length, FLAGS(t)])} want ${JSON.stringify([g.types[want[i * 4]], want[i * 4 + 1], want[i * 4 + 2], want[i * 4 + 3]])}`;
      }
    }
    // The parse path's token columns (after an accepted parse) must hold the same stream,
    // except where the parser split a `>`-led punctuator at a type-argument close.
    if (!diff && parse) {
      let ok = false;
      try { parse.parse(src); ok = true; } catch { /* columns are compared on accepted inputs */ }
      if (ok) {
        cols++;
        for (let j = 0, i = 0; j < got!.length && !diff; j++, i++) {
          const x = got![j], y = parse.tokenAt(i);
          if (x.type === y.type && x.offset === y.offset && x.text === y.text && x.k === y.k && x.t === y.t && FLAGS(x) === FLAGS(y)) continue;
          let text = y.text;
          const head = y.offset === x.offset && y.text === '>' && x.text.startsWith('>') && x.text.length > 1 && y.k === x.k && FLAGS(y) === FLAGS(x);
          while (head && text.length < x.text.length) {
            const z = parse.tokenAt(++i);
            if (z.offset !== x.offset + text.length || z.k !== x.k) break;
            text += z.text;
          }
          if (!head || text !== x.text) diff = `parse column ${i}: ${JSON.stringify(y)} vs tokenize ${JSON.stringify(x)}`;
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
  const path = `/tmp/emit-lexer-verify-${name}.mts`;
  writeFileSync(path, src);
  const m = await import(path + '?v=' + Date.now());
  bad += check(`emitted ${name}`, matches[0].g, m.tokenize, m);
}

if (bad > 0) process.exit(1);
console.log('✓ generated lexer ≡ golden token streams + error messages');
