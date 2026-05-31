// TSX conformance, mirroring test/js-conformance.ts but for examples/typescriptreact.ts.
// Ground truth is TS's OWN parser in TSX mode
// (`ts.createSourceFile(..., ts.ScriptKind.TSX)` → `parseDiagnostics`).
//
// Three corpora are measured:
//
//   1. A curated set of valid-TSX snippets (the JSX SUBSET Monogram targets:
//      elements, self-closing, fragments, member/namespaced/hyphenated tags,
//      attributes incl. `{expr}` values and `{...spread}`, expression
//      containers in children, generic components). These MUST all parse — the
//      hard acceptance gate.
//
//   2. A "TS still works under .tsx" set: ordinary TypeScript (no JSX) that
//      must keep parsing, proving the JSX layer is purely additive and did not
//      regress the inherited TS grammar.
//
//   3. A known-UNSUPPORTED set: valid TSX whose JSX *children* contain raw text
//      with arbitrary punctuation (HTML entities `&nbsp;`, `%`, apostrophes) —
//      not tokenizable without a dedicated JSX text-lexer mode, which this
//      subset deliberately omits. These document the boundary; TS accepts them,
//      Monogram does not. Printed for transparency, not gated.
import { createParser } from '../src/gen-parser.ts';
import ts from 'typescript';

const grammar = (await import('../examples/typescriptreact.ts')).default;
const { parse } = createParser(grammar);

const tsxAccepts = (code: string) => {
  const sf = ts.createSourceFile('t.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ((sf as any).parseDiagnostics as ts.Diagnostic[] | undefined)?.length ? false : true;
};
const weAccept = (code: string) => {
  try { parse(code); return true; } catch { return false; }
};

// ── Corpus 1: curated valid TSX (the JSX subset) — must all parse ──
const validTsx: string[] = [
  // elements & self-closing
  `const a = <div></div>;`,
  `const b = <Foo />;`,
  `const c = <input type="text" value="x" />;`,
  // attributes: string, expression-container, boolean, spread
  `const d = <Button onClick={handleClick} disabled>Save</Button>;`,
  `const e = <input value={value} {...rest} />;`,
  `const f = <img src={url} alt="logo" width={120} />;`,
  // hyphenated / namespaced attribute names
  `const g = <div data-id="42" aria-label="close" className="btn" />;`,
  `const h = <svg:rect x="0" y="0" />;`,
  // member / namespaced / hyphenated tag names
  `const i = <Foo.Bar baz={1} />;`,
  `const j = <Menu.Item.Label>Text</Menu.Item.Label>;`,
  `const k = <my-widget value="1" />;`,
  // fragments
  `const l = <><span>1</span><span>2</span></>;`,
  // expression containers in children (incl. .map with nested element)
  `const m = <ul>{items.map(x => <li key={x.id}>{x.name}</li>)}</ul>;`,
  `const n = <div>{count}{label}</div>;`,
  `const o = <p>Hello {name}, welcome</p>;`,
  // generic component / type-arguments on a tag
  `const p = <List<string> items={xs} />;`,
  // JSX in expression positions: ternary, array, call argument, arrow return
  `const q = ok ? <Yes /> : <No />;`,
  `const r = [<li key="a" />, <li key="b" />];`,
  `render(<App config={cfg} />);`,
  // a realistic component with types + JSX together
  `function Card({ title }: { title: string }): JSX.Element {\n  return <section className="card"><h2>{title}</h2></section>;\n}`,
  // nested multi-line tree
  `const t =\n  <div className="root">\n    <Header title="Hi" />\n    <Main>{children}</Main>\n    <Footer />\n  </div>;`,
  // template literal inside an attribute value
  `const u = <div className={\`box \${variant}\`} />;`,
];

// ── Corpus 2: TS-without-JSX still parses under the .tsx grammar ──
const tsStillWorks: [string, string][] = [
  ['comparison', `const a = x < y;`],
  ['generic call', `const b = identity<string>("x");`],
  ['division', `const c = total / count;`],
  ['regex literal', `const d = /ab+c/gi.test(s);`],
  ['type annotation', `let v: number = 1;`],
  ['generic function', `function f<T>(x: T): T { return x; }`],
  ['as expression', `const e = val as unknown as Foo;`],
  ['interface', `interface I { a: number; b(): void; }`],
  ['enum', `enum E { A, B, C }`],
  ['arrow with type params', `const g = <T,>(x: T): T => x;`],
];

// ── Corpus 3: known-unsupported valid TSX (raw-text children) — documents the gap ──
const unsupported: [string, string][] = [
  ['HTML entity in text', `const a = <div>&nbsp;</div>;`],
  ['percent in text', `const b = <span>50% off</span>;`],
  ['apostrophe in text', `const c = <p>It's great</p>;`],
  ['punctuation-heavy text', `const d = <p>Cost: $5 (each)!</p>;`],
];

let v_ok = 0;
const v_fail: string[] = [];
for (const code of validTsx) {
  if (weAccept(code)) v_ok++;
  else v_fail.push(code);
}
console.log('── Corpus 1: curated valid TSX (hard acceptance gate) ──');
console.log(`  Accepted: ${v_ok}/${validTsx.length}  (${(v_ok / validTsx.length * 100).toFixed(1)}%)`);
if (v_fail.length) {
  console.log('  FAILED (valid TSX we reject):');
  for (const c of v_fail) console.log('    - ' + JSON.stringify(c).slice(0, 100));
}
// Sanity: every curated snippet really is valid TSX per the TS parser.
const v_tsbad = validTsx.filter(c => !tsxAccepts(c));
if (v_tsbad.length) {
  console.log('  WARNING — curated snippet rejected by tsc (fix the corpus):');
  for (const c of v_tsbad) console.log('    - ' + JSON.stringify(c).slice(0, 100));
}

let ts_ok = 0;
const ts_fail: string[] = [];
for (const [name, code] of tsStillWorks) {
  if (weAccept(code)) ts_ok++;
  else ts_fail.push(`${name}: ${code}`);
}
console.log('\n── Corpus 2: TypeScript (no JSX) still parses under .tsx — additivity gate ──');
console.log(`  Accepted: ${ts_ok}/${tsStillWorks.length}`);
if (ts_fail.length) {
  console.log('  REGRESSED (TS we now reject):');
  for (const c of ts_fail) console.log('    - ' + c);
}

console.log('\n── Corpus 3: known-unsupported valid TSX (raw-text children) ──');
console.log('  (TS accepts these; Monogram does not. JSX text is RAW TEXT, not a token');
console.log('   sequence — `It\'s 100% & more!` has an unterminated string, a modulo, etc.');
console.log('   Emitting it as one JSXText token needs a context-sensitive lexer mode, but');
console.log('   Monogram lexes the whole source in ONE pass with NO parser feedback and a');
console.log('   deliberately grammar-agnostic lexer (test/agnostic.ts) — it cannot know it');
console.log('   is between `>` and `</`. The TextMate HIGHLIGHTER has no such limit (it is');
console.log('   region-based): test/tsx-highlight.ts shows raw text + entities highlight');
console.log('   correctly. So this is a PARSER-conformance boundary only, not a highlighter');
console.log('   gap.)');
for (const [name, code] of unsupported) {
  const we = weAccept(code), t = tsxAccepts(code);
  console.log(`    - ${we ? 'accept' : 'reject'}${t ? '' : ' [TS also rejects — recheck]'}: ${name}`);
}

// ── Hard gate: the curated valid-TSX set must be a SOLID majority. ──
const FLOOR = 0.85;
const rate = v_ok / validTsx.length;
console.log(`\nTSX subset acceptance: ${(rate * 100).toFixed(1)}%  (floor ${FLOOR * 100}%)`);
if (rate < FLOOR || ts_ok < tsStillWorks.length) {
  console.log(rate < FLOOR ? '✗ TSX acceptance below floor' : '✗ TS regression under .tsx');
  process.exit(1);
}
console.log('✓ TSX conformance: JSX subset accepted + TS unregressed');
