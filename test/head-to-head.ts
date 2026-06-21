// Head-to-head bench: Monogram vs tsc (ts.updateSourceFile) vs official
// tree-sitter-typescript, on one large TypeScript document under the same
// single-character edit script: warm valid keystrokes, a paren-deleting
// BREAKING edit, while-broken typing, and the FIXING edit.
//
// Reproduce:
//   git -C /tmp clone --depth 1 https://github.com/microsoft/TypeScript ts-repo   # corpus file
//   mkdir -p /tmp/tsbench && npm install --prefix /tmp/tsbench tree-sitter tree-sitter-typescript
//   node test/head-to-head.ts
//
// Notes on fairness: every engine receives byte-identical edit sequences with
// positions recomputed from the current text; timers wrap ONLY the engine call
// (tree-sitter's line/col points are precomputed outside). tsc runs with
// setParentNodes=false; node-tree-sitter caps any input string at 32767 chars,
// so it reads through a 16KB chunk callback (its documented large-input path).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { emitParser } from '../src/emit-parser.ts';
import { writeFileSync } from 'node:fs';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const TS_BENCH = process.env.TSBENCH_DIR ?? '/tmp/tsbench';
const CORPUS = process.env.H2H_FILE ?? '/tmp/ts-repo/tests/cases/unittests/matchFiles.ts';
const TreeSitter = require(TS_BENCH + '/node_modules/tree-sitter');
const TSLang = require(TS_BENCH + '/node_modules/tree-sitter-typescript').typescript;

const grammar = (await import('../typescript.ts')).default;
const emPath = '/tmp/emitted-h2h.mts';
writeFileSync(emPath, emitParser(grammar));
const { createParser } = await import(emPath + '?v=' + process.pid);

const unit = readFileSync(CORPUS, 'utf-8');
const BASE = unit.repeat(Math.ceil(9 * 1024 * 1024 / unit.length));
console.log(`doc: ${(BASE.length / 1024 / 1024).toFixed(2)} MB TypeScript (${CORPUS})`);

function posOf(text: string, off: number) {
  let row = 0, last = -1;
  for (let i = 0; i < off; i++) if (text.charCodeAt(i) === 10) { row++; last = i; }
  return { row, column: off - last - 1 };
}
const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];

type Engine = { fresh(text: string): void; edit(text: string, start: number, end: number, ins: string): number; errors(): number };

function runScript(eng: Engine) {
  let txt = BASE;
  let t0 = performance.now();
  eng.fresh(txt);
  const fresh = performance.now() - t0;
  if (eng.errors() > 0) throw new Error('base doc reports errors');
  const apply = (start: number, end: number, ins: string) => {
    const dt = eng.edit(txt, start, end, ins);
    txt = txt.slice(0, start) + ins + txt.slice(end);
    return dt;
  };
  const identAt = txt.indexOf(' expected', Math.floor(txt.length / 4)) + 1;
  const valid: number[] = [];
  for (let i = 0; i < 5; i++) valid.push(apply(identAt + i, identAt + i, 'x'));
  if (eng.errors() > 0) throw new Error('valid keystrokes broke the doc');
  const parenAt = txt.indexOf(');', Math.floor(txt.length * 0.75));
  const breaking = apply(parenAt, parenAt + 1, '');
  const breakErrs = eng.errors();
  const broken: number[] = [];
  for (let i = 0; i < 10; i++) broken.push(apply(parenAt + i, parenAt + i, 'z'));
  apply(parenAt, parenAt + 10, '');
  const fixing = apply(parenAt, parenAt, ')');
  return { fresh, valid: med(valid), breaking, broken: med(broken), fixing, breakErrs, fixErrs: eng.errors() };
}

const engines: Record<string, Engine> = {
  monogram: (() => {
    const p = createParser();
    let c: { errors: unknown[] };
    return {
      fresh(text: string) { c = p.parse(text); },
      edit(_text: string, start: number, end: number, ins: string) {
        const t0 = performance.now();
        p.edit(c, [{ start, end, text: ins }]);
        return performance.now() - t0;
      },
      errors() { return c.errors.length; },
    };
  })(),
  tsc: (() => {
    let sf: ts.SourceFile;
    return {
      fresh(text: string) { sf = ts.createSourceFile('t.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS); },
      edit(text: string, start: number, end: number, ins: string) {
        const newText = text.slice(0, start) + ins + text.slice(end);
        const t0 = performance.now();
        sf = ts.updateSourceFile(sf, newText, { span: { start, length: end - start }, newLength: ins.length });
        return performance.now() - t0;
      },
      errors() { return (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length; },
    };
  })(),
  treesitter: (() => {
    const p = new TreeSitter();
    p.setLanguage(TSLang);
    let tree: ReturnType<typeof p.parse>;
    const CHUNK = 16 * 1024;
    const input = (text: string) => (index: number) => (index < text.length ? text.slice(index, index + CHUNK) : null);
    return {
      fresh(text: string) { tree = p.parse(input(text)); },
      edit(text: string, start: number, end: number, ins: string) {
        const newText = text.slice(0, start) + ins + text.slice(end);
        const sp = posOf(text, start), oep = posOf(text, end), nep = posOf(newText, start + ins.length);
        const t0 = performance.now();
        tree.edit({ startIndex: start, oldEndIndex: end, newEndIndex: start + ins.length, startPosition: sp, oldEndPosition: oep, newEndPosition: nep });
        tree = p.parse(input(newText), tree);
        return performance.now() - t0;
      },
      errors() { return tree.rootNode.hasError ? 1 : 0; },
    };
  })(),
};

const fmt = (x: number) => x.toFixed(2).padStart(8);
console.log('engine      |    fresh |  valid✎ | breaking✎ | broken✎ | fixing✎ | errs(break/fix)');
for (const [name, eng] of Object.entries(engines)) {
  const r = runScript(eng);
  console.log(`${name.padEnd(11)} | ${fmt(r.fresh)} | ${fmt(r.valid)} | ${fmt(r.breaking)} | ${fmt(r.broken)} | ${fmt(r.fixing)} | ${r.breakErrs}/${r.fixErrs}`);
}
console.log('(ms; ✎ = per single-character edit, median; node ' + process.version + ')');
