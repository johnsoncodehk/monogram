// Gate: the EMITTED lexer (emit-lexer.ts, embedded in the emitted parser) must produce
// a token stream IDENTICAL to the data-driven createLexer — every field (type, text,
// offset, k, t, stamp flags) and identical error messages on lex-error inputs — across
// the conformance corpus. This is the lexer counterpart of emit-parser-verify (which
// compares CSTs and is therefore blind to equal-on-both-sides lexer bugs only when the
// lexers are SHARED; with an emitted lexer the streams must be compared directly).
// Two views of the one emitted lexer are compared: the public tokenize() array, and the
// parse path's token columns (tokenAt after a successful parse).
// HARD gate = the in-repo corpus (test/emit-corpus.ts); the optional /tmp/ts-repo corpus
// is also swept when present. Corpus-free, so it runs in `npm run check` everywhere.
//   node test/emit-lexer-verify.ts            # in-repo corpus (+ /tmp/ts-repo if present)
import { readFileSync, writeFileSync } from 'node:fs';
import { createLexer, type Token } from '../src/gen-lexer.ts';
import { emitParser, jsTarget } from '../src/emit.ts';
import { inRepoCorpus, externalTsFiles } from './emit-corpus.ts';
import { internOf } from './emitted-intern.ts';

const grammar = (await import('../typescript.ts')).default;

const EMITTED = '/tmp/emit-lexer-verify-parser.mts';
writeFileSync(EMITTED, emitParser(grammar, jsTarget));
const emitted = await import(EMITTED + '?v=' + Date.now());
const src = readFileSync(EMITTED, 'utf-8');
if (src.includes('createLexer(')) {
  console.error('✗ the emitted parser carries the createLexer runtime for this grammar — emit-lexer fell back');
  process.exit(1);
}
// The reference: createLexer with the SAME intern config the emitted parser bakes.
const ref = createLexer(grammar, internOf(src));

const FIELDS = ['type', 'text', 'offset', 'k', 't', 'newlineBefore', 'commentBefore', 'multilineFlowBefore'] as const;
const tokDiff = (x: Token, y: Token) =>
  Object.keys(y).length !== FIELDS.length || FIELDS.some((f) => x[f] !== y[f]);

function sweep(label: string, samples: { name: string; code: string }[]) {
  let same = 0, diff = 0, bothThrow = 0, throwMismatch = 0, parsed = 0;
  for (const { name, code } of samples) {
    let a: Token[] | null = null, b: Token[] | null = null, ea: string | null = null, eb: string | null = null;
    try { a = ref.tokenize(code); } catch (e) { ea = String(e); }
    try { b = emitted.tokenize(code); } catch (e) { eb = String(e); }
    if (ea !== null || eb !== null) {
      if (ea !== null && ea === eb) { bothThrow++; continue; }
      throwMismatch++;
      console.log('THROW MISMATCH', name, '\n  ref :', ea, '\n  emit:', eb);
      continue;
    }
    if (a!.length !== b!.length) { diff++; console.log('LEN DIFF', name, a!.length, b!.length); continue; }
    let ok = true;
    for (let i = 0; i < a!.length && ok; i++) {
      if (tokDiff(a![i], b![i])) { ok = false; console.log('TOK DIFF', name, 'at', i, JSON.stringify(a![i]), JSON.stringify(b![i])); }
    }
    let parseOk = false;
    try { emitted.parse(code); parseOk = true; } catch { /* reject: the columns are compared on accepted inputs */ }
    if (parseOk) {
      parsed++;
      // The parser splits a `>`-led punctuator (`>>`, `>=`, …) where a type-argument list
      // closes, so the columns equal the stream except for such runs of split pieces.
      for (let j = 0, i = 0; j < a!.length && ok; j++, i++) {
        const x = a![j], y = emitted.tokenAt(i) as Token;
        if (!tokDiff(x, y)) continue;
        let text = y.text;
        const head = y.offset === x.offset && y.text === '>' && x.text.startsWith('>') && x.text.length > 1
          && y.k === x.k && y.newlineBefore === x.newlineBefore && y.commentBefore === x.commentBefore;
        while (head && text.length < x.text.length) {
          const z = emitted.tokenAt(++i) as Token;
          if (z.offset !== x.offset + text.length || z.k !== x.k) break;
          text += z.text;
        }
        if (!head || text !== x.text) { ok = false; console.log('COLUMN DIFF', name, 'at', j, JSON.stringify(x), JSON.stringify(y)); }
      }
    }
    ok ? same++ : diff++;
  }
  console.log(`${label}: samples=${samples.length} same=${same} (parse-path columns checked on ${parsed}) bothThrow(sameMsg)=${bothThrow} diff=${diff} throwMismatch=${throwMismatch}`);
  return diff + throwMismatch;
}

// ── 1) HARD gate: in-repo corpus ──
let bad = sweep('in-repo corpus', inRepoCorpus());

// ── 2) Optional breadth: external corpus ──
const ext = externalTsFiles();
if (ext.length) {
  const samples = ext.map((f) => { try { return { name: f, code: readFileSync(f, 'utf8') }; } catch { return null; } }).filter(Boolean) as { name: string; code: string }[];
  bad += sweep('external corpus', samples);
} else {
  console.log('external corpus (/tmp/ts-repo) absent — in-repo gate only');
}

if (bad > 0) process.exit(1);
console.log('✓ emitted lexer ≡ createLexer (full token streams + error messages)');
