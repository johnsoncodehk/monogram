// Shared JavaScript corpus — representative valid JS across the highlight families.
// Used by both test/js-highlight-bench.ts (the JS accuracy gate) and
// test/highlight-bench.ts (the README per-language comparison table), so the
// single 92.6% figure has ONE source of truth.
export const JS_CORPUS: string[] = [
  `const x = 1, y = 2.5, z = 0xff, b = 0b101, big = 10n; let s = "a"; var t = 'b';`,
  `function add(a, b) { return a + b; }`,
  `const g = (x) => x * 2, h = async (p) => { return await p; };`,
  `async function load(url) { const r = await fetch(url); return r.json(); }`,
  `function* gen() { yield 1; yield* other(); }`,
  `class Point { #x = 0; static origin = null; constructor(x) { this.#x = x; } get x() { return this.#x; } set x(v) { this.#x = v; } move(dx) { return dx; } }`,
  `class Sub extends Base { method() { return super.method(); } }`,
  `const { a, b: renamed, c = 1, ...rest } = obj;`,
  `const [first, , third, ...more] = arr;`,
  `const o = { key: 1, shorthand, method() {}, [computed]: 2, ...spread, get d() { return 1; } };`,
  `const t = \`hello \${name}, you are \${age} years old\`;`,
  `const re = /ab+c/gi, re2 = /\\d{3}-\\d{4}/;`,
  `obj.prop.nested; arr.map(f).filter(g); console.log(x, y);`,
  `foo?.bar?.(); a ?? b; obj?.[key];`,
  `if (a > b) { doThing(); } else if (c < d) { other(); } else { fallback(); }`,
  `for (const item of items) process(item); for (let i = 0; i < n; i++) loop(i);`,
  `while (running) { tick(); } do { once(); } while (false);`,
  `switch (kind) { case 1: handle(); break; default: skip(); }`,
  `try { risky(); } catch (e) { report(e); } finally { cleanup(); }`,
  `const sum = a + b * c - d / e % f ** g; const cmp = x === y && z !== w || !q;`,
  `const d = new Date(); const m = new Map([[1, 'one']]);`,
  `label: for (;;) { break label; }`,
  `import defaultExport, { named, alias as renamed } from './mod.js'; export const v = 1; export default fn;`,
  `// a line comment\n/* a block comment */\nconst commented = 1;`,
  `throw new Error('bad'); delete obj.key; typeof x; void 0;`,
  `const ternary = cond ? whenTrue : whenFalse; const tagged = tag\`x\${y}\`;`,
];
