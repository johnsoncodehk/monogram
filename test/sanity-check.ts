import { createParser } from '../src/gen-parser.ts';

const grammar = (await import('../typescript.ts')).default;
const { parse } = createParser(grammar);

// Sanity checks for common syntax
const tests = [
  'var x = 1;',
  'function foo() {}',
  'class C { x: number = 1; m() { return this.x; } }',
  'type Foo<T> = T extends string ? T : never;',
  'interface I { x: number; m(): void; }',
  'async function* gen() { yield 1; yield* other(); }',
  'const c = { x: 1, m() {}, get a() { return 1; } };',
  '() => 1',
  'a?.b?.[c]?.()',
  '`hello ${name}`',
  `type T = \`\${infer U}\`;`,
  '@dec class C { @prop x: number; m(@d arg: T) {} }',
  'import { a, b as c } from "m";',
  'export default function() {}',
  'export type { T } from "m";',
];

let passed = 0;
for (const code of tests) {
  try {
    parse(code);
    passed++;
  } catch (e: any) {
    console.log(`FAIL: ${code}`);
    console.log(`  ${e.message.slice(0, 100)}`);
  }
}
console.log(`${passed}/${tests.length} basic tests pass`);
process.exit(passed === tests.length ? 0 : 1);
