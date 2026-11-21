// Gate: the emitted jsTarget module's PUBLIC tokenizer and its document ownership.
//
// For the three lexing modes (TypeScript: token stream, YAML: indent, HTML: markup):
//   1. tokenize(src) ≡ the frozen lexer golden: type, span and flags of every token, text =
//      its source span, k = the module's own TYPE_KIND id, the exact Token key set, identical
//      lex-error messages;
//   2. each call returns a fresh array of fresh objects — mutating one result changes nothing;
//   3. tokenize — succeeding or throwing — never changes what an existing tree, handle or
//      token view reads, and never disturbs an incremental session: a session with tokenize
//      calls interleaved stays ≡ a fresh parse after every edit (tree AND errors);
//   4. the module-level views (tree / visit / tokenAt) read the DEFAULT document no matter
//      what a createParser() instance parsed in between, and an instance's views ignore
//      module-level parses.
//
//   node test/emit-tokenize.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitParser, jsTarget } from '../src/emit.ts';
import type { Token } from '../src/emit-lexer.ts';
import { objectify, type TreeView } from './emitted-obj.ts';
import { goldenStream, streamOf } from './golden-lexer.ts';
import type { CstGrammar } from '../src/types.ts';
import { scratchDir } from './scratch.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) ok++;
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};

type Edit = { start: number; end: number; text: string };
type Cst = { root: number; errors: unknown[] };
type Parser = { parse(s: string): Cst; edit(cst: Cst, edits: Edit[]): void; visit(cst: Cst, fns: object): void; tree: TreeView };
type Mod = {
  tokenize(s: string): Token[];
  parse(s: string): number;
  parseEdited(entry: string | undefined, edits: Edit[]): number;
  visit(root: number, fns: object): void;
  tree: TreeView;
  tokenAt(i: number): Token;
  createParser(): Parser;
};

interface Case {
  name: string;
  path: string;
  samples: string[];   // all lex cleanly
  lexError: string;    // makes tokenize throw
  docs: [string, string, string];
  edits: Edit[][];     // applied in order to docs[0], with tokenize calls in between
}

const CASES: Case[] = [
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

const dir = scratchDir('emit-tokenize');
const json = (v: unknown) => JSON.stringify(v);
const FIELDS = ['type', 'text', 'offset', 'k', 't', 'newlineBefore', 'commentBefore', 'multilineFlowBefore'];

for (const c of CASES) {
  const grammar: CstGrammar = (await import(c.path)).default;
  const src = emitParser(grammar, jsTarget);
  const file = join(dir, `${c.name}.ts`);
  writeFileSync(file, src);
  const m = (await import(file)) as Mod;
  const label = c.name;
  const typeKind = new Map<string, number>(JSON.parse(src.match(/const TYPE_KIND = new Map<[^>]*>\((.*)\);/)![1]));

  // ── 1. parity with the lexer golden ──
  for (const s of c.samples) {
    const b = m.tokenize(s), want = goldenStream(c.name, s);
    const keysOk = b.every((t) => json(Object.keys(t).sort()) === json([...FIELDS].sort()));
    const spansOk = b.every((t) => t.text === s.slice(t.offset, t.offset + t.text.length) && t.k === typeKind.get(t.type));
    check(`${label}: tokenize ≡ lexer golden for ${json(s.slice(0, 24))}`, want !== undefined && json(want) === json(streamOf(b)) && keysOk && spansOk,
      want === undefined ? 'input not in the golden' : '');
  }
  if (c.lexError) {
    let eb = '';
    try { m.tokenize(c.lexError); } catch (e) { eb = (e as Error).message; }
    const want = goldenStream(c.name, c.lexError);
    check(`${label}: lex error is the golden's`, want !== undefined && 'error' in want && want.error === eb, `golden=${json(want)} emit=${eb}`);
  }

  // ── 2. fresh, caller-owned results ──
  {
    const s = c.samples[0];
    const t1 = m.tokenize(s), t2 = m.tokenize(s);
    check(`${label}: each call returns a new array of new objects`, t1 !== t2 && t1.every((t, i) => t !== t2[i]));
    const want = json(t2);
    t1[0].text = 'MUTATED'; t1[0].offset = -1; t1.length = 0;
    check(`${label}: mutating a result changes no later result`, json(m.tokenize(s)) === want && json(t2) === want);
  }

  const throwingTokenize = () => {
    if (!c.lexError) { m.tokenize(c.samples[1]); return; }
    try { m.tokenize(c.lexError); check(`${label}: lexError input throws`, false); } catch { /* expected */ }
  };
  const moduleSnap = (n: number) =>
    json(objectify(m.tree, (fns) => m.visit(rootOf.module, fns))) + json(Array.from({ length: n }, (_, i) => m.tokenAt(i)));
  const instSnap = (p: Parser, h: Cst) => json(objectify(p.tree, (fns) => p.visit(h, fns))) + json(h.errors);
  const rootOf = { module: -1 };

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

console.log(`\n${ok}/${ok + fail} emitted-tokenize checks pass${fail ? '' : ' ✓'}`);
if (fail) process.exit(1);
