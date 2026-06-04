// src-coverage-jsx.ts — JSX (.jsx, VS Code "javascriptreact") entrypoint.
// Official parser = typescript.js with ScriptKind.JSX; Monogram grammar = javascriptreact.ts
// (JS + JSX, NO TypeScript types). Neither the TS suite nor Test262 ships a .jsx corpus, so
// this uses a CURATED set exercising both halves (plain JS + JSX constructs). It is small, so
// completeness% is honestly low; a real .jsx corpus is a follow-up. Run: node test/src-coverage-jsx.ts

import ts from 'typescript';
import { run } from './src-coverage.ts';
import { tsFamilyAdapter } from './src-coverage-tsfamily.ts';

// No TS types — these are .jsx (JavaScript + JSX) only.
const JSX_CASES: string[] = [
  // --- plain JS half ---
  'const x = 1, y = 2;',
  'function f(a, b = 1, ...rest) { return a + b + rest.length; }',
  'class C extends B { #p = 1; static s() {} get v() { return this.#p; } }',
  'const g = async (x) => { for await (const v of x) console.log(v); };',
  'const { a, b: { c } = {}, ...r } = obj;',
  'label: for (let i = 0; i < 10; i++) { if (i) continue label; }',
  'try { risky(); } catch { recover(); } finally { done(); }',
  'a ??= b; c ||= d; e &&= f; g?.h?.[i]?.(j);',
  'const t = `a${b}c${d}e`, n = 1_000_000n, hex = 0xFF, oct = 0o17, bin = 0b101;',
  'export default function () {}; export const z = 1; export * from "m";',
  'import def, { named as alias } from "mod"; import * as ns from "ns";',
  'switch (x) { case 1: break; default: { let y = 2; } }',
  'do { step(); } while (cond);',
  'const re = /foo\\d+/giu; const s = "a\\u{1F600}b";',
  'new.target; import.meta.url; function* gen() { yield* other(); }',
  // --- JSX half ---
  'const a = <div />;',
  'const b = <div className="x" id={y} data-z={1} {...props}>text</div>;',
  'const frag = <><Alpha /><Beta /></>;',
  'const member = <Foo.Bar.Baz prop={1} />;',
  'const ns = <svg:rect width="10" />;',
  'const nested = <Outer header={<Inner title="x" />}>{children}</Outer>;',
  'const cond = ok ? <Yes /> : <No />;',
  'const list = items.map((it) => <li key={it.id}>{it.label}</li>);',
  'const guard = <div>{show && <Modal />}{count || <Empty />}</div>;',
  'const text = <p> leading {a} middle {b} trailing </p>;',
  'const selfClosingVoid = <input type="text" disabled />;',
  'const entity = <span>a &amp; b &lt; c &#x1F600;</span>;',
  'const multiline = (\n  <section>\n    <h1>Title</h1>\n    <p>Body</p>\n  </section>\n);',
  'const exprChild = <div>{/* comment */}{items.length}</div>;',
  'const spreadChild = <List>{...rows}</List>;',
  'function App() { return <main><Header /><Content /></main>; }',
  'const attrExpr = <a href={"/" + slug} onClick={() => go()}>link</a>;',
  'const deep = <a><b><c>deep</c></b></a>;',
  'const stringAttr = <div title=\'single\' alt="double" />;',
  'const boolAttr = <button autofocus formNoValidate>ok</button>;',
];

const corpus = JSX_CASES.map((code, i) => ({ file: `<curated #${i}>`, code }));
console.log(`JSX corpus: ${corpus.length} curated .jsx snippets (no .jsx corpus exists in the TS suite / Test262; partial — completeness% will be low).`);

await run(tsFamilyAdapter({
  name: 'JavaScriptReact (.jsx)',
  scriptKind: ts.ScriptKind.JSX,
  grammar: (await import('../javascriptreact.ts')).default,
  corpus,
}));
