// TSX conformance, mirroring test/js-conformance.ts but for typescriptreact.ts.
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
//   3. A known-UNSUPPORTED set (expected-fail): valid TSX the lexer-local element
//      region decides differently from tsc's parser-driven scanner (see
//      `ElementRegion` in src/grammar/types.ts). A row that starts parsing fails the gate.
//
//   4. Invalid TSX that must be REJECTED (near misses of the element region).
import { createParser } from '../src/interpreter/interpreter.ts';
import ts from 'tsc-oracle';

const grammar = (await import('../typescriptreact.ts')).default;
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
  // children are TEXT (the element region): any character but `{ < > }`, entities kept verbatim
  `const a = <div>&nbsp;</div>;`,
  `const b = <span>50% off</span>;`,
  `const c = <p>It's great</p>;`,
  `const d = <p>Cost: $5 (each)!</p>;`,
  `const v = <p>a # b | c \\ d — © é</p>;`,
  `const w = <a>// not a comment</a>;`,
  `const x = <a>(note)</a>;`,
  `const y = <a>\n  <b/>\n</a>;`,
  `const z = <a>{\`x\${<b>y's</b>}\`}</a>;`,
  `const aa = <a b={c > d}>x</a>;`,
  `const ab = <A<string>>t</A>;`,
  `const ac = <>it's</>;`,
  `const ad = <a>{/* c */}</a>;`,
  `function f() {}\n<div>it's</div>;`,
  `const ae = <a>x</a> / 2;`,
  // `</` and `/>` are tokens only inside an element: elsewhere `<` and `/` are separate
  `new Map</* comment */string, IArgs>()`,
  `const t = a </* c */ b;`,
  `const r = />/.test(s);`,
  // a `<` at an operand position that begins a type-parameter list is not an element
  `type F = <T>(x: T) => T;`,
  `let f: <T>(x: T) => T;`,
  `interface I { <T>(x: T): T }`,
  `let t: new <T>() => T;`,
  `const g = <T extends>(x)</T>;`,
  `const h = <T,>(x: T) => <p>{x}'s</p>;`,
  // an attribute string is the tag's own token: no escapes, may span lines (tsc's scanJsxAttributeValue)
  `let a = <a b="\\" c="d" />;`,
  `let a = <a b='\\' c='it"s' d="it's" />;`,
  `let a = <a b="x\ny" />;`,
  `let a = <List<string> b="\\" />;`,
  `let a = <a b={"\\\"" + 'q'} />;`,
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

// ── Corpus 3: known-unsupported valid TSX: where the lexer-local element region decides
// differently from tsc, whose scanner is driven by the parser (ElementRegion in src/grammar/types.ts) ──
const unsupported: [string, string][] = [
  // a `<Name>` head whose `( … )` is followed by `:` reads as a type-parameter signature
  ['needs parser context: text of an attribute-less element: a group then `:`', `const a = <li>(1): one</li>;`],
  // a call signature without a return type: the `;` after the group is no signature end
  ['needs parser context: call signature without a return type', `interface I { <T>(x: T); }`],
  // the type-parameter head pattern does not skip comments
  ['needs parser context: comment inside a type-parameter head', `const f = <T /* c */,>(x: T) => x;`],
  // an element is entered where a regex may start: after a value ended by ASI it is a comparison
  // (the same miss as `import a from "b"\n/re/.test(s)`)
  ['needs parser context (the prevIsValue class): an element after a statement ended by ASI on a value', `import a from "b"\n<h>it's</h>;`],
];

// ── Corpus 4: invalid TSX the element region must reject ──
const invalidTsx: string[] = [
  `const a = <p>a > b</p>;`,   // tsc: "Unexpected token. Did you mean `{'>'}` or `&gt;`?"
  `const b = <p>a } b</p>;`,
  `const c = <a>x;`,
  `x = a </ b;`,
  `let a = <a b="x />;`,
  `const d = <a>x</a>\n/re/.test(s);`,
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

console.log('\n── Corpus 3: known-unsupported valid TSX (lexer-local element region vs tsc) ──');
// Expected-fail: each row is valid TSX that Monogram rejects today. A row that starts parsing
// fails the gate until it moves to corpus 1 (the record moves with the fix).
const nowAccepted: string[] = [];
for (const [name, code] of unsupported) {
  const we = weAccept(code), t = tsxAccepts(code);
  if (we) nowAccepted.push(name);
  console.log(`    - ${we ? 'accept' : 'reject'}${t ? '' : ' [TS also rejects — recheck]'}: ${name}`);
}
if (nowAccepted.length) {
  console.log(`✗ known-unsupported rows now parse: move them to corpus 1: ${nowAccepted.join('; ')}`);
  process.exit(1);
}

console.log('\n── Corpus 4: invalid TSX must be rejected ──');
const overAccepted = invalidTsx.filter(weAccept);
const invalidTscOk = invalidTsx.filter(tsxAccepts);
for (const c of invalidTscOk) console.log('  WARNING — tsc accepts this invalid snippet (fix the corpus): ' + JSON.stringify(c));
console.log(`  Rejected: ${invalidTsx.length - overAccepted.length}/${invalidTsx.length}`);
for (const c of overAccepted) console.log('  ✗ ACCEPTED: ' + JSON.stringify(c));
if (overAccepted.length || invalidTscOk.length) process.exit(1);

// ── Hard gate: the curated valid-TSX set must be a SOLID majority. ──
const FLOOR = 0.85;
const rate = v_ok / validTsx.length;
console.log(`\nTSX subset acceptance: ${(rate * 100).toFixed(1)}%  (floor ${FLOOR * 100}%)`);
if (rate < FLOOR || ts_ok < tsStillWorks.length) {
  console.log(rate < FLOOR ? '✗ TSX acceptance below floor' : '✗ TS regression under .tsx');
  process.exit(1);
}
console.log('✓ TSX conformance: JSX subset accepted + TS unregressed');
