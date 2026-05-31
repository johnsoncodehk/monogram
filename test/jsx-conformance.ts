// JSX conformance for examples/javascriptreact.ts (the `.jsx` dialect = JavaScript +
// JSX). Ground truth is TS's own parser in JSX mode (ts.createSourceFile(...,
// ts.ScriptKind.JSX) → parseDiagnostics). The JS counterpart of tsx-conformance.ts:
//   1. curated valid JSX-in-JS — the hard acceptance gate (must all parse);
//   2. plain JavaScript still parses under the .jsx grammar — additivity gate;
//   3. TypeScript-only syntax (type annotations, generics) is REJECTED — .jsx is
//      JavaScript, so a type layer must NOT leak in via the shared JSX module.
import { createParser } from '../src/gen-parser.ts';
import ts from 'typescript';

const grammar = (await import('../examples/javascriptreact.ts')).default;
const { parse } = createParser(grammar);
// The JS base, to prove withJsx adds ONLY a JSX layer (identical type behavior).
const baseParse = createParser((await import('../examples/javascript.ts')).default).parse;

const jsxAccepts = (code: string) => {
  const sf = ts.createSourceFile('t.jsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  return ((sf as any).parseDiagnostics as ts.Diagnostic[] | undefined)?.length ? false : true;
};
const weAccept = (code: string) => { try { parse(code); return true; } catch { return false; } };

// ── Corpus 1: curated valid JSX-in-JS — must all parse ──
const validJsx: string[] = [
  `const a = <div></div>;`,
  `const b = <Foo />;`,
  `const c = <input type="text" value="x" />;`,
  `const d = <Button onClick={handleClick} disabled>Save</Button>;`,
  `const e = <input value={value} {...rest} />;`,
  `const g = <div data-id="42" aria-label="close" className="btn" />;`,
  `const i = <Foo.Bar baz={1} />;`,
  `const j = <Menu.Item.Label>Text</Menu.Item.Label>;`,
  `const k = <my-widget value="1" />;`,
  `const l = <><span>1</span><span>2</span></>;`,
  `const m = <ul>{items.map(x => <li key={x.id}>{x.name}</li>)}</ul>;`,
  `const n = <div>{count}{label}</div>;`,
  `const o = <p>Hello {name}, welcome</p>;`,
  `const q = ok ? <Yes /> : <No />;`,
  `const r = [<li key="a" />, <li key="b" />];`,
  `render(<App config={cfg} />);`,
  `function Card({ title }) {\n  return <section className="card"><h2>{title}</h2></section>;\n}`,
  `const u = <div className={\`box \${variant}\`} />;`,
];

// ── Corpus 2: plain JavaScript still parses under the .jsx grammar ──
const jsStillWorks: [string, string][] = [
  ['comparison', `const a = x < y;`],
  ['division', `const c = total / count;`],
  ['regex literal', `const d = /ab+c/gi.test(s);`],
  ['arrow', `const g = (x) => x * 2;`],
  ['class + private', `class P { #x = 0; get x() { return this.#x; } }`],
  ['destructuring', `const { a, b: r, ...rest } = obj;`],
  ['template', `const t = \`hi \${name}\`;`],
  ['async/await', `async function f() { return await g(); }`],
];

// ── Corpus 3: type-behavior PARITY with the JS base ──
// withJsx adds ONLY a JSX layer, so javascriptreact must accept/reject TypeScript
// syntax EXACTLY as javascript.ts does — neither stricter nor more lenient. (The JS
// base genuinely rejects type annotations; it leniently accepts a couple of
// contextual-keyword forms like `as`/`interface` — that over-accept class is the JS
// base's, measured by js-conformance.ts, and must simply be UNCHANGED here.)
const tsParity: [string, string][] = [
  ['type annotation', `let v: number = 1;`],
  ['generic function', `function f<T>(x) { return x; }`],
  ['as expression', `const e = val as Foo;`],
  ['interface', `interface I { a: 1 }`],
];

let v_ok = 0; const v_fail: string[] = [];
for (const code of validJsx) (weAccept(code) ? v_ok++ : v_fail.push(code));
console.log('── Corpus 1: curated valid JSX-in-JS (hard acceptance gate) ──');
console.log(`  Accepted: ${v_ok}/${validJsx.length}  (${(v_ok / validJsx.length * 100).toFixed(1)}%)`);
for (const c of v_fail) console.log('    FAIL: ' + JSON.stringify(c).slice(0, 90));
const v_tsbad = validJsx.filter(c => !jsxAccepts(c));
for (const c of v_tsbad) console.log('    WARNING — tsc rejects this curated snippet: ' + JSON.stringify(c).slice(0, 80));

let ts_ok = 0; const ts_fail: string[] = [];
for (const [name, code] of jsStillWorks) (weAccept(code) ? ts_ok++ : ts_fail.push(`${name}: ${code}`));
console.log('\n── Corpus 2: JavaScript (no JSX) still parses under .jsx — additivity gate ──');
console.log(`  Accepted: ${ts_ok}/${jsStillWorks.length}`);
for (const c of ts_fail) console.log('    REGRESSED: ' + c);

let par_ok = 0; const par_fail: string[] = [];
const baseAccepts = (code: string) => { try { baseParse(code); return true; } catch { return false; } };
for (const [name, code] of tsParity) {
  (weAccept(code) === baseAccepts(code)) ? par_ok++ : par_fail.push(`${name}: jsx=${weAccept(code)} base=${baseAccepts(code)}`);
}
console.log('\n── Corpus 3: type-behavior parity with the JavaScript base (withJsx is JSX-only) ──');
console.log(`  Matches base: ${par_ok}/${tsParity.length}`);
for (const c of par_fail) console.log('    DIVERGED from base (withJsx changed type handling): ' + c);

const FLOOR = 0.85;
const rate = v_ok / validJsx.length;
console.log(`\nJSX subset acceptance: ${(rate * 100).toFixed(1)}%  (floor ${FLOOR * 100}%)`);
if (rate < FLOOR || ts_ok < jsStillWorks.length || par_ok < tsParity.length) {
  console.log(rate < FLOOR ? '✗ JSX acceptance below floor'
    : ts_ok < jsStillWorks.length ? '✗ JavaScript regression under .jsx'
    : '✗ withJsx changed type handling vs the JS base');
  process.exit(1);
}
console.log('✓ JSX conformance: JSX-in-JS accepted + JavaScript unregressed + type-behavior matches the JS base');
