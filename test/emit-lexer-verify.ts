// Gate: the EMITTED lexer (emit-lexer.ts, embedded in the emitted parser) must produce
// a token stream IDENTICAL to the data-driven createLexer — every field (type, text,
// offset, k, t, stamp flags) and identical error messages on lex-error inputs — across
// the conformance corpus. This is the lexer counterpart of emit-parser-verify (which
// compares CSTs and is therefore blind to equal-on-both-sides lexer bugs only when the
// lexers are SHARED; with an emitted lexer the streams must be compared directly).
// HARD gate = the in-repo corpus (test/emit-corpus.ts); the optional /tmp/ts-repo corpus
// is also swept when present. Corpus-free, so it runs in `npm run check` everywhere.
//   node test/emit-lexer-verify.ts            # in-repo corpus (+ /tmp/ts-repo if present)
import { readFileSync, writeFileSync } from 'node:fs';
import { createLexer } from '../src/gen-lexer.ts';
import { emitParser, jsTarget } from '../src/emit.ts';
import { inRepoCorpus, externalTsFiles } from './emit-corpus.ts';

const grammar = (await import('../typescript.ts')).default;

// The reference: createLexer with the SAME intern config the emitted parser bakes.
const EMITTED = '/tmp/emit-lexer-verify-parser.mts';
writeFileSync(EMITTED, emitParser(grammar, jsTarget));
const emitted = await import(EMITTED + '?v=' + Date.now());
const src = readFileSync(EMITTED, 'utf-8');
if (src.includes('createLexer(')) {
  console.error('✗ the emitted parser still imports createLexer for this grammar — emit-lexer fell back');
  process.exit(1);
}
// Rebuild the intern config from the emitted tables' source of truth: re-emit via the
// analyzer is private, so read the reference lexer through a tiny probe grammar parse —
// simplest faithful route: intern maps are exactly the emitted TYPE_KIND/LIT_KW/LIT_PU.
const tk = new Map<string, number>(JSON.parse(src.match(/const TYPE_KIND = new Map(?:<[^>]*>)?\((.*)\);/)![1]));
const kw = new Map<string, number>(JSON.parse(src.match(/const LIT_KW = new Map(?:<[^>]*>)?\((.*)\);/)![1]));
const pu = new Map<string, number>(JSON.parse(src.match(/const LIT_PU = new Map(?:<[^>]*>)?\((.*)\);/)![1]));
const kPunct = Number(src.match(/const K_PUNCT = (\d+);/)![1]);
const kFallback = Number(src.match(/const K_NAMED_FALLBACK = (\d+);/)![1]);
const ref = createLexer(grammar, { typeKind: tk, kwLit: kw, puLit: pu, punctKind: kPunct, namedFallback: kFallback });

function sweep(label: string, samples: { name: string; code: string }[]) {
  let same = 0, diff = 0, bothThrow = 0, throwMismatch = 0;
  for (const { name, code } of samples) {
    // The emitted tokenize fills struct-of-arrays columns and returns the count;
    // tokenAt(i) reconstructs the per-token object view for the comparison.
    let a: any[] | null = null, bn: number | null = null, ea: string | null = null, eb: string | null = null;
    try { a = ref.tokenize(code); } catch (e) { ea = String(e); }
    try { bn = emitted.tokenize(code); } catch (e) { eb = String(e); }
    if (ea !== null || eb !== null) {
      if (ea !== null && ea === eb) { bothThrow++; continue; }
      throwMismatch++;
      console.log('THROW MISMATCH', name, '\n  ref :', ea, '\n  emit:', eb);
      continue;
    }
    if (a!.length !== bn!) { diff++; console.log('LEN DIFF', name, a!.length, bn); continue; }
    let ok = true;
    for (let i = 0; i < a!.length; i++) {
      const x = a![i], y = emitted.tokenAt(i);
      if (x.type !== y.type || x.text !== y.text || x.offset !== y.offset || x.k !== y.k || x.t !== y.t
          || x.newlineBefore !== y.newlineBefore || x.commentBefore !== y.commentBefore
          || x.multilineFlowBefore !== y.multilineFlowBefore) {
        ok = false;
        console.log('TOK DIFF', name, 'at', i, JSON.stringify(x), JSON.stringify(y));
        break;
      }
    }
    ok ? same++ : diff++;
  }
  console.log(`${label}: samples=${samples.length} same=${same} bothThrow(sameMsg)=${bothThrow} diff=${diff} throwMismatch=${throwMismatch}`);
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
