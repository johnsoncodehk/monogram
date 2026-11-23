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
// Below, the public tokenizer's ownership contract (formerly emit-tokenize; see that section).
//
//   node test/emit-reentrancy.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser, jsTarget } from '../src/emit.ts';
import type { CstGrammar } from '../src/types.ts';
import { objectify, type TreeView } from './emitted-obj.ts';
import { scratchDir } from './scratch.ts';

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

const dir = scratchDir('emit-reentrancy');
for (const c of CASES) {
  const grammar: CstGrammar = (await import(c.path)).default;
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

// ════ The public tokenizer and document ownership (formerly emit-tokenize) ════
// For the three lexing modes:
//   1. tokenize(src) tokens carry exactly the Token key set and k = the module's own TYPE_KIND id
//      (the stream itself ≡ the lexer golden is emit-lexer-verify's);
//   2. each call returns a fresh array of fresh objects — mutating one result changes nothing;
//   3. tokenize — succeeding or throwing — never changes what an existing tree, handle or token
//      view reads, and never disturbs an incremental session: a session with tokenize calls
//      interleaved stays ≡ a fresh parse after every edit (tree AND errors);
//   4. the module-level views (tree / visit / tokenAt) read the DEFAULT document no matter what a
//      createParser() instance parsed in between, and an instance's views ignore module-level parses.
{
  type TokToken = { type: string; text: string; offset: number; k: number; [f: string]: unknown };
  type TokCst = { root: number; errors: unknown[] };
  type TokParser = { parse(s: string): TokCst; edit(cst: TokCst, edits: Edit[]): void; visit(cst: TokCst, fns: object): void; tree: TreeView };
  type TokMod = {
    tokenize(s: string): TokToken[];
    parse(s: string): number;
    parseEdited(entry: string | undefined, edits: Edit[]): number;
    visit(root: number, fns: object): void;
    tree: TreeView;
    tokenAt(i: number): TokToken;
    createParser(): TokParser;
  };
  interface TokCase {
    name: string;
    path: string;
    samples: string[];   // all lex cleanly
    lexError: string;    // makes tokenize throw
    docs: [string, string, string];
    edits: Edit[][];     // applied in order to docs[0], with tokenize calls in between
  }
  const TOKENIZE_CASES: TokCase[] = [
    {
      name: 'typescript', path: '../typescript.ts',
      samples: ['let a = 1 + b;\n', 'function f(x: number) {\n  return `t${x}` / 2;\n}\n', 'const r = /a+b/g.test(s); // c\n', 'a\n++b', 'x = y ? z : w;'],
      lexError: 'let a = 1 # 2;',
      docs: ['function foo(a) { return a + 1; }\nfoo(2);\n', 'class K { m() { return [1, 2, 3]; } }\n', 'const zz = { k: 1 };\n'],
      edits: [[{ start: 15, end: 15, text: 'bb' }], [{ start: 0, end: 8, text: 'function' }], [{ start: 20, end: 26, text: 'return (' }], [{ start: 20, end: 28, text: 'return a' }], [{ start: 3, end: 3, text: '\n' }]],
    },
    {
      name: 'yaml', path: '../yaml.ts',
      samples: ['a: 1\nb:\n  - x\n  - y\nc: {k: v, n: [1, 2]}\n', '# comment\nkey: "quoted"\nblock: |\n  line one\n  line two\n', 'a:\n', '- [a, b]\n- {c: d}\n'],
      lexError: 'a: "unterminated\n',
      docs: ['a: 1\nb:\n  - x\n  - y\n', 'k: v\nlist: [1, 2, 3]\n', 'top:\n  nested: true\n'],
      edits: [[{ start: 3, end: 4, text: '22' }], [{ start: 10, end: 10, text: '  - z\n' }], [{ start: 0, end: 1, text: 'aa' }], [{ start: 5, end: 7, text: '' }]],
    },
    {
      name: 'html', path: '../html.ts',
      samples: ['<div class="a">hi<br>there</div>', '<!-- c --><p>a < b</p><script>if (a < b) {}</script>', '<ul><li>one</li><li>two</li></ul>', '<p>unclosed <b>bold'],
      lexError: '',
      docs: ['<div><p>one</p><p>two</p></div>', '<ul><li>a</li></ul>', '<span title="t">x</span>'],
      edits: [[{ start: 8, end: 11, text: 'uno' }], [{ start: 5, end: 5, text: '<b>x</b>' }], [{ start: 0, end: 5, text: '<div>' }]],
    },
  ];
  const tdir = scratchDir('emit-reentrancy-tokenize');
  const json = (v: unknown) => JSON.stringify(v);
  const FIELDS = ['type', 'text', 'offset', 'k', 't', 'newlineBefore', 'commentBefore', 'multilineFlowBefore'];

  for (const c of TOKENIZE_CASES) {
    const grammar: CstGrammar = (await import(c.path)).default;
    const src = emitParser(grammar, jsTarget);
    const file = join(tdir, `${c.name}.ts`);
    writeFileSync(file, src);
    const m = (await import(file)) as TokMod;
    const label = c.name;
    const typeKind = new Map<string, number>(JSON.parse(src.match(/const TYPE_KIND = new Map<[^>]*>\((.*)\);/)![1]!));

    // ── 1. the Token key set and its kind id ──
    for (const s of c.samples) {
      const b = m.tokenize(s);
      const keysOk = b.every((t) => json(Object.keys(t).sort()) === json([...FIELDS].sort()));
      const kindOk = b.every((t) => t.k === typeKind.get(t.type));
      check(`${label}: tokenize tokens carry exactly the Token keys and k = TYPE_KIND for ${json(s.slice(0, 24))}`, b.length > 0 && keysOk && kindOk);
    }

    // ── 2. fresh, caller-owned results ──
    {
      const s = c.samples[0]!;
      const t1 = m.tokenize(s), t2 = m.tokenize(s);
      check(`${label}: each call returns a new array of new objects`, t1 !== t2 && t1.every((t, i) => t !== t2[i]));
      const want = json(t2);
      t1[0]!.text = 'MUTATED'; t1[0]!.offset = -1; t1.length = 0;
      check(`${label}: mutating a result changes no later result`, json(m.tokenize(s)) === want && json(t2) === want);
    }

    const throwingTokenize = () => {
      if (!c.lexError) { m.tokenize(c.samples[1]!); return; }
      try { m.tokenize(c.lexError); check(`${label}: lexError input throws`, false); } catch { /* expected */ }
    };
    const rootOf = { module: -1 };
    const moduleSnap = (n: number) =>
      json(objectify(m.tree, (fns) => m.visit(rootOf.module, fns))) + json(Array.from({ length: n }, (_, i) => m.tokenAt(i)));
    const instSnap = (p: TokParser, h: TokCst) => json(objectify(p.tree, (fns) => p.visit(h, fns))) + json(h.errors);

    // ── 3+4. module document: tokenize and an instance parse leave its views alone ──
    {
      const [A, B, C] = c.docs;
      rootOf.module = m.parse(A);
      const nA = m.tokenize(A).length;
      const before = moduleSnap(nA);
      m.tokenize(B);
      check(`${label}: module tree/tokenAt unchanged after tokenize (success)`, moduleSnap(nA) === before);
      throwingTokenize();
      check(`${label}: module tree/tokenAt unchanged after tokenize (lex error)`, moduleSnap(nA) === before);
      const p = m.createParser();
      const hB = p.parse(B);
      check(`${label}: module tree/tokenAt unchanged after createParser().parse(B)`, moduleSnap(nA) === before);
      const pBefore = instSnap(p, hB);
      rootOf.module = m.parse(C);
      m.tokenize(A);
      throwingTokenize();
      check(`${label}: instance views unchanged after module parse + tokenize`, instSnap(p, hB) === pBefore);
    }

    // ── 3. incremental sessions with tokenize interleaved ≡ fresh parse ──
    {
      let text = c.docs[0];
      const p = m.createParser();
      const h = p.parse(text);
      let modText = text;
      rootOf.module = m.parse(modText);
      let allEq = true, modEq = true;
      for (const batch of c.edits) {
        for (const e of batch) text = text.slice(0, e.start) + e.text + text.slice(e.end);
        m.tokenize(c.docs[1]);
        throwingTokenize();
        p.edit(h, batch);
        m.tokenize(text);
        const fresh = m.createParser();
        const fh = fresh.parse(text);
        if (instSnap(p, h) !== instSnap(fresh, fh)) { allEq = false; console.log(`    ${c.name}: instance edit ≠ fresh for ${json(text)}`); }

        for (const e of batch) modText = modText.slice(0, e.start) + e.text + modText.slice(e.end);
        m.tokenize(c.docs[2]);
        try { rootOf.module = m.parseEdited(undefined, batch); } catch { rootOf.module = -1; }
        throwingTokenize();
        const fresh2 = m.createParser();
        const fh2 = fresh2.parse(modText);
        if (rootOf.module >= 0 && fh2.errors.length === 0) {
          const n = m.tokenize(modText).length;
          const viaModule = json(objectify(m.tree, (fns) => m.visit(rootOf.module, fns)));
          const viaFresh = json(objectify(fresh2.tree, (fns) => fresh2.visit(fh2, fns)));
          const toksEq = json(Array.from({ length: n }, (_, i) => m.tokenAt(i))) === json(m.tokenize(modText));
          if (viaModule !== viaFresh || !toksEq) { modEq = false; console.log(`    ${c.name}: module parseEdited ≠ fresh for ${json(modText)}`); }
        }
      }
      check(`${label}: createParser().edit with tokenize interleaved ≡ fresh parse after every edit`, allEq);
      check(`${label}: module parseEdited with tokenize interleaved ≡ fresh parse (tree + tokenAt)`, modEq);
    }
  }
}

console.log(`\n${ok}/${ok + fail} emitted-reentrancy checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
