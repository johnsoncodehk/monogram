// Gate: the EMITTED lexer (emit-lexer.ts, embedded in the emitted parser) must produce
// a token stream IDENTICAL to the data-driven createLexer — every field (type, text,
// offset, k, t, stamp flags) and identical error messages on lex-error inputs — across
// the conformance corpus. This is the lexer counterpart of emit-parser-verify (which
// compares CSTs and is therefore blind to equal-on-both-sides lexer bugs only when the
// lexers are SHARED; with an emitted lexer the streams must be compared directly).
//   node test/emit-lexer-verify.ts            # full conformance corpus
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLexer } from '../src/gen-lexer.ts';
import { emitParser } from '../src/emit-parser.ts';

const grammar = (await import('../typescript.ts')).default;

// The reference: createLexer with the SAME intern config the emitted parser bakes.
const EMITTED = '/tmp/emit-lexer-verify-parser.mjs';
writeFileSync(EMITTED, emitParser(grammar));
const emitted = await import(EMITTED + '?v=' + Date.now());
const src = readFileSync(EMITTED, 'utf-8');
if (src.includes('createLexer(')) {
  console.error('✗ the emitted parser still imports createLexer for this grammar — emit-lexer fell back');
  process.exit(1);
}
// Rebuild the intern config from the emitted tables' source of truth: re-emit via the
// analyzer is private, so read the reference lexer through a tiny probe grammar parse —
// simplest faithful route: intern maps are exactly the emitted TYPE_KIND/LIT_KW/LIT_PU.
const tk = new Map<string, number>(JSON.parse(src.match(/const TYPE_KIND = new Map\((.*)\);/)![1]));
const kw = new Map<string, number>(JSON.parse(src.match(/const LIT_KW = new Map\((.*)\);/)![1]));
const pu = new Map<string, number>(JSON.parse(src.match(/const LIT_PU = new Map\((.*)\);/)![1]));
const kPunct = Number(src.match(/const K_PUNCT = (\d+);/)![1]);
const kFallback = Number(src.match(/const K_NAMED_FALLBACK = (\d+);/)![1]);
const ref = createLexer(grammar, { typeKind: tk, kwLit: kw, puLit: pu, punctKind: kPunct, namedFallback: kFallback });

const files: string[] = [];
(function walk(d: string) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (p.endsWith('.ts')) files.push(p);
  }
})('/tmp/ts-repo/tests/cases/conformance');

let same = 0, diff = 0, bothThrow = 0, throwMismatch = 0;
for (const f of files) {
  const code = readFileSync(f, 'utf8');
  // The emitted tokenize fills struct-of-arrays columns and returns the count;
  // tokenAt(i) reconstructs the per-token object view for the comparison.
  let a: any[] | null = null, bn: number | null = null, ea: string | null = null, eb: string | null = null;
  try { a = ref.tokenize(code); } catch (e) { ea = String(e); }
  try { bn = emitted.tokenize(code); } catch (e) { eb = String(e); }
  if (ea !== null || eb !== null) {
    if (ea !== null && ea === eb) { bothThrow++; continue; }
    throwMismatch++;
    console.log('THROW MISMATCH', f, '\n  ref :', ea, '\n  emit:', eb);
    continue;
  }
  if (a!.length !== bn!) { diff++; console.log('LEN DIFF', f, a!.length, bn); continue; }
  let ok = true;
  for (let i = 0; i < a!.length; i++) {
    const x = a![i], y = emitted.tokenAt(i);
    if (x.type !== y.type || x.text !== y.text || x.offset !== y.offset || x.k !== y.k || x.t !== y.t
        || x.newlineBefore !== y.newlineBefore || x.commentBefore !== y.commentBefore
        || x.multilineFlowBefore !== y.multilineFlowBefore) {
      ok = false;
      console.log('TOK DIFF', f, 'at', i, JSON.stringify(x), JSON.stringify(y));
      break;
    }
  }
  ok ? same++ : diff++;
}
console.log(`files=${files.length} same=${same} bothThrow(sameMsg)=${bothThrow} diff=${diff} throwMismatch=${throwMismatch}`);
if (diff > 0 || throwMismatch > 0) process.exit(1);
console.log('✓ emitted lexer ≡ createLexer (full token streams + error messages)');
