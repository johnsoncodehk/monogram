// Gate: BOUNDED-EXHAUSTIVE edit/fresh equivalence. Over a small expression
// grammar, enumerate EVERY document up to N characters over the grammar's
// alphabet, and for each apply EVERY single-character edit (every deletion,
// every replacement, every insertion at every position). Each edited handle
// must be byte-identical — tree AND errors — to a fresh parse of the edited
// text. Unlike the generative gates this is complete within its bound: any
// equivalence bug reachable through small documents has a witness here.
//
//   node --max-old-space-size=4096 test/exhaustive-edits.ts
import { writeFileSync } from 'node:fs';
import { token, rule, defineGrammar, many, opt, sep, plus, oneOf, range, seq, star, noneOf } from '../src/api.ts';
import { emitParser, jsTarget } from '../src/emit.ts';
import { objectify } from './emitted-obj.ts';

// A deliberately bracket-and-list-shaped grammar: parens force synthesis and
// paired-opener paths, ';' forces statement splits, '+' forces Pratt-free
// infix shapes through the seq machinery, idents and numbers collide at edits.
const Ident = token(plus(oneOf(range('a', 'b'))), { identifier: true });
const Num = token(plus(oneOf(range('0', '1'))), {});
const Expr = rule(($: unknown) => [
  Ident,
  Num,
  ['(', sep($, ','), ')'],
  [$, '+', $],
]);
const Stmt = rule(() => [[Expr, ';']]);
const Program = rule(() => [[many(Stmt)]]);
const g = defineGrammar({
  name: 'mini', scopeName: 'source.mini',
  tokens: { Ident, Num },
  rules: { Expr, Stmt, Program }, entry: Program,
});

const emPath = '/tmp/emitted-exhaustive.mts';
writeFileSync(emPath, emitParser(g, jsTarget));
type Cst = { root: number; errors: object[] };
type Parser = { parse(s: string): Cst; edit(c: Cst, e: object[]): void; visit(c: Cst, fns: object): void; tree: import('./emitted-obj.ts').TreeView };
const em = (await import(emPath + '?v=' + process.pid)) as { createParser(): Parser; __arenaStats(): { inPlaceShrink: number } };

const ALPHABET = ['a', '0', '(', ')', ',', '+', ';', ' '];
const MAXLEN = Number(process.env.EXH_MAXLEN ?? 4);   // ~330k steps; EXH_MAXLEN=5 for the 3.2M-step deep run

const fresh = em.createParser();
const edited = em.createParser();
const H = (p: Parser, c: Cst) => JSON.stringify(objectify(p.tree, (fns) => p.visit(c, fns))) + JSON.stringify(c.errors);

let docs = 0, edits = 0, mismatches = 0;
const docsAt: string[][] = [['']];
for (let L = 1; L <= MAXLEN; L++) {
  docsAt.push(docsAt[L - 1].flatMap(d => ALPHABET.map(ch => d + ch)));
}
for (let L = 0; L <= MAXLEN; L++) {
  for (const base of docsAt[L]) {
    docs++;
    const variants: { start: number; end: number; text: string }[] = [];
    for (let i = 0; i < base.length; i++) variants.push({ start: i, end: i + 1, text: '' });          // delete
    for (let i = 0; i < base.length; i++) for (const ch of ALPHABET) if (ch !== base[i]) variants.push({ start: i, end: i + 1, text: ch });  // replace
    for (let i = 0; i <= base.length; i++) for (const ch of ALPHABET) variants.push({ start: i, end: i, text: ch });                          // insert
    for (const v of variants) {
      edits++;
      const c = edited.parse(base);          // re-open the handle on the base text
      edited.edit(c, [v]);
      const next = base.slice(0, v.start) + v.text + base.slice(v.end);
      const fc = fresh.parse(next);
      if (H(edited, c) !== H(fresh, fc)) {
        mismatches++;
        if (mismatches <= 10) console.log(`  ✗ «${base}» + ${JSON.stringify(v)} → «${next}»`);
      }
    }
  }
}
// The deletions in this list-shaped grammar shrink kid counts, so the C2 in-place-shrink
// surgery branch must actually fire here — otherwise the 0-mismatch result would only prove
// the path is UNREACHABLE, not correct.
const inPlaceShrink = em.__arenaStats().inPlaceShrink;
console.log(`exhaustive-edits: ${docs} documents ≤${MAXLEN} chars × every 1-char edit = ${edits} steps · ${mismatches} mismatches · ${inPlaceShrink} in-place shrink splices`);
if (mismatches > 0) { console.error('✗ edit ≢ fresh inside the exhaustive bound'); process.exit(1); }
if (inPlaceShrink === 0) { console.error('✗ the in-place shrink surgery path (C2) never fired — coverage gap'); process.exit(1); }
console.log('✓ edit ≡ fresh holds COMPLETELY within the bound (tree + errors, byte-identical)');
