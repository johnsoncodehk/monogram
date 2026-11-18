// Gate: the emitted jsTarget read paths (visit / tree / tokenAt) are owned by ONE document and
// reentrant.
//
// A traversal of a document must produce the same enter/leave/leaf sequence — and every leaf's
// token view must equal the leaf's own span — whatever its callbacks do with OTHER documents:
// read the module document (tokenAt, tree accessors, nested visit), read or traverse another
// createParser() handle, parse / edit / tokenize (succeeding or throwing) anywhere else, or
// traverse the same handle again. Parsing or editing the document being traversed is refused
// (throws) before it touches the arena; the document stays as it was and is editable afterwards.
// Handles read their tokens through createParser().tokenAt(handle, i).
//
//   node test/emit-reentrancy.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitParser, jsTarget } from '../src/emit.ts';
import type { CstGrammar } from '../src/types.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};

type Token = { type: string; text: string; offset: number };
type Edit = { start: number; end: number; text: string };
type Fns = { enter?(id: number, cb: number, tb: number): void; leave?(id: number, cb: number, tb: number): void; leaf?(entry: number, tok: number): void };
type Tree = {
  ruleNameOf(id: number): string; lenOf(id: number): number; childCount(id: number): number;
  leafTokenType(entry: number, tokBase: number): string;
  leafOffsetOf(entry: number, tokBase: number): number; leafEndOf(entry: number, tokBase: number): number;
};
type Handle = { root: number; errors: unknown[] };
type Parser = { parse(s: string): Handle; edit(h: Handle, e: Edit[]): void; visit(h: Handle, f: Fns): void; tree: Tree; tokenAt(h: Handle, i: number): Token };
type Mod = {
  parse(s: string): number; visit(root: number, f: Fns): void; tree: Tree; tokenAt(i: number): Token;
  tokenize(s: string): Token[]; createParser(): Parser;
};

interface Case { name: string; path: string; A: string; B: string; badParse: string; badLex: string; edit: Edit }
const CASES: Case[] = [
  { name: 'typescript', path: '../typescript.ts', A: 'foo + bar; baz(1, 2);\nlet x: Array<Array<number>> = y;\n', B: 'qqqqqqq * zz; qqqqqqq', badParse: 'let = ;', badLex: 'let a = 1 # 2;', edit: { start: 0, end: 3, text: 'fooo' } },
  { name: 'yaml', path: '../yaml.ts', A: 'a: 1\nb:\n  - x\n  - y\n', B: 'zz: [1, 2, 3]\nkk: v\n', badParse: 'a: [1, 2\n', badLex: 'a: "unterminated\n', edit: { start: 3, end: 4, text: '22' } },
  { name: 'html', path: '../html.ts', A: '<div><p>one</p><p>two</p></div>', B: '<ul><li>a</li><li>b</li></ul>', badParse: '<p a=></p>', badLex: '', edit: { start: 8, end: 11, text: 'uno' } },
];

// The full traversal sequence; `hook` runs inside every callback, AFTER that callback's reads.
function trace(tree: Tree, tok: (i: number) => Token, run: (f: Fns) => void, src: string, hook?: () => void): { seq: string[]; spanBad: number } {
  const seq: string[] = [];
  let spanBad = 0;
  run({
    enter(id, cb) { seq.push(`E ${tree.ruleNameOf(id)} ${cb} ${cb + tree.lenOf(id)}`); hook?.(); },
    leave(id) { seq.push(`L ${tree.ruleNameOf(id)}`); hook?.(); },
    leaf(entry, t) {
      const tb = t - ((~entry) >>> 2);
      const off = tree.leafOffsetOf(entry, tb), end = tree.leafEndOf(entry, tb);
      const k = tok(t);
      if (k.offset !== -1 && (k.offset !== off || k.text !== src.slice(off, end))) spanBad++;
      seq.push(`T ${tree.leafTokenType(entry, tb)} ${off} ${end}`);
      hook?.();
    },
  });
  return { seq, spanBad };
}

const dir = mkdtempSync(join(tmpdir(), 'monogram-emit-reentrancy-'));
for (const c of CASES) {
  let grammar: CstGrammar;
  try { grammar = (await import(c.path)).default; } catch { console.log(`  ${c.name}: (grammar not present — skipped)`); continue; }
  const src = emitParser(grammar, jsTarget);
  const file = join(dir, `${c.name}.ts`);
  writeFileSync(file, src);
  const m = (await import(file)) as Mod;
  const label = c.name;
  const hasHandleTokenAt = typeof m.createParser().tokenAt === 'function';
  check(`${label}: createParser() exposes tokenAt(handle, i)`, hasHandleTokenAt);

  const p = m.createParser();
  const h = p.parse(c.A);
  const q = m.createParser();
  const qh = q.parse(c.B);
  let mRoot = m.parse(c.B);
  const q2 = m.createParser();
  const q3 = m.createParser();

  // Without a handle tokenAt (the pre-fix API) the leaf token check is skipped, so the
  // traversal sequence alone is compared.
  const handleTok = (pp: Parser, hh: Handle) => (i: number): Token => {
    if (hasHandleTokenAt) return pp.tokenAt(hh, i);
    return { type: '', text: '', offset: -1 };
  };
  const viaHandle = (hook?: () => void) => trace(p.tree, handleTok(p, h), (f) => p.visit(h, f), c.A, hook);
  const want = viaHandle();
  check(`${label}: handle leaves read their own tokens via tokenAt(handle, i)`, want.spanBad === 0, `${want.spanBad} mismatches`);
  const nodes = want.seq.filter((x) => x[0] === 'E').length, leaves = want.seq.filter((x) => x[0] === 'T').length;

  const tsBefore = m.tokenize(c.B);
  const hooks: [string, () => void][] = [
    ['module tokenAt', () => { m.tokenAt(0); }],
    ['module tree accessors', () => { m.tree.ruleNameOf(mRoot); m.tree.childCount(mRoot); }],
    ['nested module visit', () => { m.visit(mRoot, { leaf: (_e, t) => { m.tokenAt(t); } }); }],
    ['other handle: tree, tokenAt, nested visit', () => { q.tree.childCount(qh.root); handleTok(q, qh)(0); q.visit(qh, { leaf: (_e, t) => { handleTok(q, qh)(t); } }); }],
    ['other handle: parse + edit', () => { const x = q2.parse(c.B); q2.edit(x, [{ start: 0, end: 0, text: ' ' }]); }],
    ['module parse', () => { mRoot = m.parse(c.B); }],
    ['tokenize (success and lex error)', () => { m.tokenize(c.B); if (c.badLex) { try { m.tokenize(c.badLex); } catch { /* expected */ } } }],
    ['failing parses elsewhere', () => { try { m.parse(c.badParse); } catch { /* expected */ } mRoot = m.parse(c.B); q3.parse(c.badParse); }],
    ['nested traversal of the same handle', () => { p.visit(h, { leaf: (_e, t) => { handleTok(p, h)(t); } }); }],
  ];
  for (const [name, hook] of hooks) {
    let got: { seq: string[]; spanBad: number } | null = null, err = '';
    try { got = viaHandle(hook); } catch (e) { err = (e as Error).message; }
    check(`${label}: handle visit unchanged by callback — ${name}`, got !== null && got.spanBad === 0 && got.seq.join('\n') === want.seq.join('\n'),
      got ? `nodes ${got.seq.filter((x) => x[0] === 'E').length}/${nodes}, leaves ${got.seq.filter((x) => x[0] === 'T').length}/${leaves}, span mismatches ${got.spanBad}` : err);
  }
  check(`${label}: tokenize results unaffected by reentrant reads`, JSON.stringify(m.tokenize(c.B)) === JSON.stringify(tsBefore));

  // Reverse direction: the module document traversed while callbacks use instances.
  mRoot = m.parse(c.A);
  const viaModule = (hook?: () => void) => trace(m.tree, (i) => m.tokenAt(i), (f) => m.visit(mRoot, f), c.A, hook);
  const wantM = viaModule();
  check(`${label}: module leaves read their own tokens via tokenAt(i)`, wantM.spanBad === 0 && wantM.seq.join('\n') === want.seq.join('\n'));
  const mHooks: [string, () => void][] = [
    ['handle tree, tokenAt, visit', () => { p.tree.ruleNameOf(h.root); handleTok(p, h)(0); p.visit(h, { leaf: (_e, t) => { handleTok(p, h)(t); } }); }],
    ['instance parse + edit', () => { const x = q2.parse(c.B); q2.edit(x, [{ start: 0, end: 0, text: ' ' }]); }],
    ['tokenize (success and lex error)', () => { m.tokenize(c.B); if (c.badLex) { try { m.tokenize(c.badLex); } catch { /* expected */ } } }],
  ];
  for (const [name, hook] of mHooks) {
    let got: { seq: string[]; spanBad: number } | null = null, err = '';
    try { got = viaModule(hook); } catch (e) { err = (e as Error).message; }
    check(`${label}: module visit unchanged by callback — ${name}`, got !== null && got.spanBad === 0 && got.seq.join('\n') === wantM.seq.join('\n'), got ? `span mismatches ${got.spanBad}` : err);
  }

  // Mutating the document under traversal is refused; the document stays as it was and usable.
  {
    let threw = '';
    try { p.visit(h, { enter: () => { p.edit(h, [c.edit]); } }); } catch (e) { threw = (e as Error).message; }
    check(`${label}: editing the visited handle inside its visit throws`, /during visit/.test(threw), threw || 'no error');
    const sameT = trace(p.tree, handleTok(p, h), (f) => p.visit(h, f), c.A);
    check(`${label}: the refused edit left the handle ≡ before`, sameT.seq.join('\n') === want.seq.join('\n') && sameT.spanBad === 0);
    const edited = c.A.slice(0, c.edit.start) + c.edit.text + c.A.slice(c.edit.end);
    p.edit(h, [c.edit]);
    const fresh = m.createParser();
    const fh = fresh.parse(edited);
    const after = trace(p.tree, handleTok(p, h), (f) => p.visit(h, f), edited);
    const freshT = trace(fresh.tree, handleTok(fresh, fh), (f) => fresh.visit(fh, f), edited);
    check(`${label}: the same edit after the visit ≡ a fresh parse`, after.seq.join('\n') === freshT.seq.join('\n') && after.spanBad === 0);
    let threwM = '';
    const r = m.parse(c.A);
    try { m.visit(r, { enter: () => { m.parse(c.B); } }); } catch (e) { threwM = (e as Error).message; }
    check(`${label}: re-parsing the module document inside its visit throws`, /during visit/.test(threwM), threwM || 'no error');
  }

  // A handle's tokenAt refuses foreign and stale handles, like its other methods.
  {
    let foreign = '', stale = '';
    try { handleTok(p, qh)(0); } catch (e) { foreign = (e as Error).message; }
    const p2 = m.createParser();
    const old = p2.parse(c.A);
    p2.parse(c.B);
    try { handleTok(p2, old)(0); } catch (e) { stale = (e as Error).message; }
    check(`${label}: tokenAt(handle) rejects foreign and stale handles`, /foreign/.test(foreign) && /stale/.test(stale), `${foreign} / ${stale}`);
  }
}

console.log(`\n${ok}/${ok + fail} emitted-reentrancy checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
