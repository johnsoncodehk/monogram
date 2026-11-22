// The [Await]/[Yield] context cases: `await` / `yield` as an identifier or as an operator in each
// position the grammar distinguishes, and a context that must be restored after an alternative
// that set it fails (a longest-match candidate, or the last try of a repetition). The verdict and
// the tree of each case differ between the contexts, so a parser that keeps the context wrong,
// leaks it out of a body or fails to restore it after a failed try disagrees with the
// interpreter here. Shared by test/portable-targets.ts (every target ≡ the interpreter) and
// test/incremental-grammars.ts (edit ≡ fresh on the documents below).

// Inputs common to the javascript and typescript grammars.
const accept = [
  // plain function inside an async / generator function and back
  'function f() { await = 1; yield = 2; await(x); }',
  'async function f() { await x; function g() { await = 1; await(y); } await z; }',
  'function* g() { yield 1; function h() { yield = 1; yield(x); } yield 2; }',
  'async function f() { await x; } await(y); var await;',
  'function* g() { yield; } yield(x); var yield;',
  'x = yield => 1; x = await => 1; function* g() { function h() { x = yield => 1; } yield; }',
  // arrows: an async arrow's body and parameters are [+Await]; a plain arrow's body resets,
  // its parameters inherit
  'async function f() { const h = async () => { await x; }; const k = () => await; await y; }',
  'async function f() { (a = await x) => a; await y; }',
  'async (a) => await a; async a => await a; await(x);',
  'async function f() { x => await; await y; }',
  // methods, accessors, constructors, fields, static blocks, computed keys inside async /
  // generator bodies
  'async function f() { class C { m() { await = 1; } async n() { await x; } *g() { yield; } get a() { return await; } set a(v) { await = v; } constructor() { await = 1; } } await y; }',
  'function* g() { class C { m() { yield = 1; } *h() { yield 1; } get a() { return yield; } static { yield = 1; } } yield 2; }',
  'async function f() { class C { x = await; } await y; }',
  'class C { static { var x = 1; } m() { await = 1; } }',
  'async function f() { class C { [await x]() {} } await y; }',
  'function* g() { class C { [yield]() {} } yield 1; }',
  'class C { [await]() {} [yield] = 1; }',
  // parameter defaults
  'function f(a = await) {} async function g(b = 1) { await b; }',
  'function* g(a = 1) { yield a; } function h(b = yield) {}',
  // class heritage
  'async function f() { class C extends (await x) {} await y; }',
  'function* g() { class C extends (yield) {} yield 1; }',
  'class C extends await {} class D extends yield {}',
  // nested generators in async functions, async generators
  'async function f() { function* g() { yield await; } await x; }',
  'async function* ag() { yield await x; function h() { await = yield = 1; } yield 1; }',
  'function* g() { async function f() { await x; yield = 1; } yield 1; }',
  // object-literal methods and accessors, their modifier runs
  'async function f() { return { m() { await = 1; }, async n() { await x; }, *g() { yield; }, get a() { return await; }, [await y]: 1 }; }',
  'function* g() { x = { m() { yield = 1; }, *h() { yield; }, [yield]: 1 }; yield 2; }',
  'x = { async m() { await x; }, n() { await = 1; } }; await(y);',
  // a context restored after a try that set it failed: the async-arrow candidate of
  // `async(...)` enters [+Await] and fails, the call reads `await` as an identifier
  'async(await); async(await, b);',
  'async (await) + 1;',
  'x = async(a, await);',
  // ... and the last try of a repetition (`get a()`'s empty parameter list, `m()`'s) fails inside
  // the reset context, after which the async body's `await` is the operator again
  'async function f() { x = { get a() { return 1; }, m() {} }; await y; }',
  'async function f() { class C { get a() { return 1; } m() {} } await y; }',
  'function* g() { x = { get a() { return 1; } }; yield 1; }',
  'async function f() { function g() {} await y; }',
  'async function f() { (() => {}); await y; }',
];
const reject = [
  'async function f() { await = 1; }',
  'function* g() { x = yield => 1; }',
  'async function f() { function g() {} await = 1; }',
  'async function f() { class C { m() {} } await = 1; }',
  'async function f() { x = { get a() { return 1; } }; await = 1; }',
  'async function f() { (() => {}); await = 1; }',
  'function* g() { function h() {} x = yield => 1; }',
  'async function f(a = await) {}',
  'async (a = await) => 1;',
  'async function f() { class C { static { await = 1; } } }',
  'class C { static { await = 1; } }',
  'async function f() { class C { [await = 1]() {} } }',
  'async function f() { class C extends await {} }',
  'async function f() { x = { [await = 1]: 1 }; }',
  'x = { async m() { await = 1; } };',
  'x = { *g() { x = yield => 1; } };',
  'async function* ag() { await = 1; }',
  'async function* ag() { x = yield => 1; }',
  'async function f() { function* g() { x = yield => 1; } }',
  'async x => await;',
];

// typescript only: TS member forms and type positions
const tsAccept = [
  'async function f() { class C { private async m(): Promise<void> { await x; } public n(): void { await = 1; } } await y; }',
  'async function f() { let x: await = 1; let y: typeof await; await z; }',
  'function* g() { let x: yield; type T = typeof yield; yield 1; }',
  'async function f() { class C { @(await d) m() {} } await y; }',
  'x = { static async m() { await x; }, static n() { await = 1; } };',
];
const tsReject = [
  'async function f() { class C { private async m() { await = 1; } } }',
  'x = { static async m() { await = 1; } };',
];

export const CTX_CASES = {
  javascript: { accept, reject },
  typescript: { accept: [...accept, ...tsAccept], reject: [...reject, ...tsReject] },
};

// ── Edits that change a function's context ──
// Flipping `async` / `*` on an enclosing function changes the context its body is parsed in,
// far from the statements whose meaning it changes. Each op replaces the FIRST occurrence of
// `find` (skipped if absent in the current text); every step must parse as the fresh text does.
export const CTX_DOCS = [
  'async function f(g) {\n  let x = await g();\n  return x;\n}\n',
  'function* gen() {\n  yield 1;\n  let y = 2;\n  return y;\n}\n',
  'const h = async (a) => {\n  await a;\n  return a;\n};\n',
  'class C {\n  async m() { await this.x; }\n  *g() { yield 1; }\n  plain() { let await = 1; return await; }\n}\n',
  'async function* ag() {\n  yield await next();\n  for (let i = 0; i < 3; i++) { await tick(); }\n}\n',
  // several top-level entries: the ones around the edited function are reused, in the base context
  'let a = await(1);\nfunction f() {\n  await(x);\n}\nlet b = await;\nfunction* g() {\n  yield(y);\n}\nlet c = yield;\n',
];
export const CTX_SCRIPT: [string, string][] = [
  ['async function', 'function'],          // drop async: the body leaves [+Await]
  ['{\n  let', '{\n  let q = 0;\n  let'],   // a keystroke inside the now-plain body
  ['function', 'async function'],          // re-add async
  ['function*', 'function'],               // drop the generator star
  ['async (a)', 'async (a, b)'],           // edit an async arrow's parameter list
  ['await ', 'await  '],                   // touch an await operand site
  ['yield 1', 'yield 1 + 1'],              // edit a yield operand inside a generator body
  ['async m()', 'm()'],                    // class: drop a method's async
  ['*g()', 'g()'],                         // class: drop a method's generator star
  ['await(x)', 'await (x)'],               // a keystroke inside a body made async between two plain entries
  ['async function f()', 'function f()'],  // and plain again
  ['function g()', 'function* g()'],       // make it a generator again
  ['yield(y)', 'yield (y)'],               // a keystroke inside the generator body
  ['let b = await;', 'let b = await(2);'], // an entry between the two
];

/** The script's steps on `doc` that apply, each as an edit of the text the previous ones left. */
export function ctxEdits(doc: string): Array<{ start: number; end: number; text: string; next: string }> {
  const out: Array<{ start: number; end: number; text: string; next: string }> = [];
  let text = doc;
  for (const [find, repl] of CTX_SCRIPT) {
    const at = text.indexOf(find);
    if (at < 0) continue;
    const next = text.slice(0, at) + repl + text.slice(at + find.length);
    out.push({ start: at, end: at + find.length, text: repl, next });
    text = next;
  }
  return out;
}
