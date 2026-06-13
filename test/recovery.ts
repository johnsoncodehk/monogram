// Gate: TOTAL PARSING (issue #39). The handle API never crashes on input — every
// text produces a tree plus cst.errors — under three hard invariants:
//
//   1. VALID texts parse byte-identically to the STRICT module-level parse with an
//      empty errors field (the strict pass runs first and exclusively; recovery
//      cannot perturb the valid path).
//   2. INVALID texts never throw, report errors exactly when strict rejects, parse
//      deterministically (same input twice → identical tree + errors), and every
//      diagnostic span stays inside the document.
//   3. A TYPING session through transiently-invalid states (the editor reality:
//      char-by-char insertion makes most intermediate states invalid) keeps every
//      intermediate edit byte-identical to a fresh handle parse — tree and errors.
//
//   node test/recovery.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { emitParser } from '../src/emit-parser.ts';
import { objectify } from './emitted-obj.ts';

const grammar = (await import('../typescript.ts')).default;
const emPath = '/tmp/emitted-recovery.mjs';
writeFileSync(emPath, emitParser(grammar));
type Edit = { start: number; end: number; text: string };
type Diag = { offset: number; end: number; message: string; related?: { offset: number; end: number; message: string } };
type Cst = { root: number; errors: Diag[] };
type Parser = { parse(s: string): Cst; edit(cst: Cst, edits: Edit[]): void; visit(cst: Cst, fns: object): void; tree: import('./emitted-obj.ts').TreeView };
type Em = {
  parse(s: string): number;
  visit(entry: number, fns: object): void;
  tree: import('./emitted-obj.ts').TreeView;
  createParser(): Parser;
};
const em = (await import(emPath + '?v=' + process.pid)) as Em;
const p = em.createParser();
const q = em.createParser();

let fails = 0;
const bad = (msg: string) => { fails++; if (fails < 12) console.log('  ✗ ' + msg); };
const objH = (pp: Parser, c: Cst) => JSON.stringify(objectify(pp.tree, (fns) => pp.visit(c, fns)));

// ── 1. valid corpus: recovery-capable parse ≡ strict parse, errors empty ──
const VALID: string[] = [
  'const a = 1;\n',
  'function f(a: number): string { return `${a}`; }\nclass C<T> { m(x: T): T { return x; } }\n',
  'const x = a < b ? c : d;\nfor (const k of ks) { if (k) break; }\n',
];
for (const f of [
  '/tmp/ts-repo/tests/cases/conformance/fixSignatureCaching.ts',
  // parserRealSource12 (not 7): #7 has `new TypeLink[]` which is a tsc PARSE ERROR — it
  // only "passed" here by exploiting the mid-line opt(';') split that statement-ASI removes.
  '/tmp/ts-repo/tests/cases/conformance/parser/ecmascript5/parserRealSource12.ts',
]) if (existsSync(f)) VALID.push(readFileSync(f, 'utf-8'));
let validN = 0;
for (const text of VALID) {
  const c = p.parse(text);
  const strictRoot = em.parse(text);
  const a = objH(p, c);
  const b = JSON.stringify(objectify(em.tree, (fns) => em.visit(strictRoot, fns)));
  if (a !== b) bad(`valid text: handle tree ≠ strict tree (${text.slice(0, 30)}…)`);
  else if (c.errors.length !== 0) bad(`valid text reported ${c.errors.length} errors`);
  else validN++;
}

// ── 2. invalid corpus: total, error-reporting, deterministic, spans in bounds ──
const INVALID: string[] = [
  'const ] = ;',
  'const a = 1; ]] const b = 2;\n',
  'function f( { return 1; }\n',
  'class C { m( { } \n const after = 1;\n',
  'const s = "unterminated\nconst t = 2;\n',
  'const u = `tpl ${ x ;\n',
  'const v = 1; \\ const w = 2;\n',
  'if (a { b(); }\nconst tail = 3;\n',
  '@@@@\n',
  '}{)(\n',
  // session-found shapes: bar-ladder degeneracies, lex-recovered docs, glued junk
  'class za {" z',
  'funtionzaaz( a z { }',
  'function \\u{0} ( (aa ) { }',
  'functio aa (z az x1<) {  }',
];
let invalidN = 0;
for (const text of INVALID) {
  let strictRejects = false;
  try { em.parse(text); } catch { strictRejects = true; }
  let c: Cst;
  try { c = p.parse(text); } catch (e) { bad(`THROWS on «${text.slice(0, 24)}»: ${(e as Error).message.slice(0, 40)}`); continue; }
  if (strictRejects !== c.errors.length > 0) { bad(`errors(${c.errors.length}) vs strict ${strictRejects ? 'reject' : 'accept'} on «${text.slice(0, 24)}»`); continue; }
  for (const g of c.errors) {
    if (!(g.offset >= 0 && g.offset <= g.end && g.end <= text.length && g.message.length > 0)) {
      bad(`malformed diagnostic ${JSON.stringify(g)} on «${text.slice(0, 24)}»`);
    }
  }
  const first = objH(p, c) + JSON.stringify(c.errors);
  const c2 = p.parse(text);
  const second = objH(p, c2) + JSON.stringify(c2.errors);
  if (first !== second) { bad(`nondeterministic parse on «${text.slice(0, 24)}»`); continue; }
  invalidN++;
}

// ── 3. typing through invalid states: every keystroke ≡ fresh, tree AND errors ──
const BASE = 'function g(a) {\n  return a + 1;\n}\nconst tail = g(2);\n';
const TYPED = 'const x = f(1, "s");';
let typedOk = 0;
{
  const at = BASE.indexOf('}\n') + 2;   // between the function and the tail stmt
  const c = p.parse(BASE);
  let text = BASE;
  for (let i = 0; i < TYPED.length; i++) {
    const ch = TYPED[i];
    const pos = at + i;
    p.edit(c, [{ start: pos, end: pos, text: ch }]);
    text = text.slice(0, pos) + ch + text.slice(pos);
    const fc = q.parse(text);
    const a = objH(p, c) + JSON.stringify(c.errors);
    const b = objH(q, fc) + JSON.stringify(fc.errors);
    if (a !== b) { bad(`keystroke ${i} («${TYPED.slice(0, i + 1)}»): edit ≠ fresh`); break; }
    typedOk++;
  }
  if (c.errors.length !== 0) bad('completed statement still reports errors');
}

// ── 4. missing-token synthesis: tsc-style "expected 'x'" diagnostics with the
// structure PRESERVED (a zero-width $missing leaf closes the construct instead of
// an $error absorbing the rest). Exact-match pins — quality must not regress to
// absorption silently.
const SYNTH: Array<[string, string[]]> = [
  // viable-set messages: every listed literal is PROVABLY still accepted at the
  // position (trailing comma is legal, so ',' joins ')' — tsc's single "')'
  // expected" under-reports); the related info names the matched opener
  ['const x = f(1, 2;', ["16:expected ')' @11:to match this '('"]],
  ['function g() { return 1;', ["24:expected '}' @13:to match this '{'"]],
  ['if (x { y(); }', ["6:expected ',' or ')' @3:to match this '('"]],
  ['const y = [1, ;', ["14:expected ',' or ']' @10:to match this '['"]],
  ['const t = obj[i;', ["15:expected ']' @13:to match this '['"]],
  // missing NONTERMINALS (the tsc "Expression expected" analog): required rule
  // refs failing inside the bar window mint a zero-width $missing carrying the
  // rule identity — committed optionals ('= Expr' after the real '='), operator
  // rhs, mixfix arms, and list elements after a real separator all synthesize
  ['const a = ;', ['10:expected Expr']],
  ['const x = a + ;', ['14:expected Expr']],
  ['const a = -;', ['11:expected Expr']],
  ['x ? y : ;', ['8:expected Expr']],
  ['a, ;', ['3:expected Expr']],
  ["f(1, ;", ["5:expected Expr", "5:expected ')' @1:to match this '('"]],
];
let synthN = 0;
for (const [text, want] of SYNTH) {
  const c = p.parse(text);
  const got = c.errors.map((g) => g.offset + ':' + g.message
    + (g.related ? ` @${g.related.offset}:${g.related.message}` : ''));
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad(`synthesis on «${text}»: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    continue;
  }
  let missing = 0;
  p.visit(c, { enter(id: number) { if (p.tree.ruleNameOf(id) === '$missing') missing++; } });
  if (missing === 0) { bad(`synthesis on «${text}»: no $missing node in the tree`); continue; }
  synthN++;
}

console.log(`recovery: valid ${validN}/${VALID.length} ≡ strict+clean · invalid ${invalidN}/${INVALID.length} total+deterministic · typing ${typedOk}/${TYPED.length} keystrokes ≡ fresh · synthesis ${synthN}/${SYNTH.length} exact`);
if (fails > 0) {
  console.error('✗ total-parsing contract violated');
  process.exit(1);
}
console.log('✓ parse/edit are total: valid path byte-identical, errors field exact, typing sessions equivalent');
