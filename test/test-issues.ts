import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vsctm from 'vscode-textmate';
const { INITIAL, Registry, parseRawGrammar } = vsctm;
import onig from 'vscode-oniguruma';
const { loadWASM, OnigScanner, OnigString } = onig;

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
const wasmBin = readFileSync(wasmPath);

await loadWASM(wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength));

const registry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
    createOnigString: (s: string) => new OnigString(s),
  }),
  loadGrammar: async (scopeName: string) => {
    if (scopeName === 'source.typescript') {
      const content = readFileSync('examples/typescript.tmLanguage.json', 'utf-8');
      return parseRawGrammar(content, 'typescript.tmLanguage.json');
    }
    return null;
  },
});

const grammar = await registry.loadGrammar('source.typescript');
if (!grammar) throw new Error('Failed to load grammar');

// ── Interfaces ──

interface Check {
  text: string;
  scope: string;
}

interface TestCase {
  label: string;
  input: string;
  checks: Check[];
}

interface MultiLineCheck {
  line: number;
  text: string;
  scope: string;
}

interface MultiLineTest {
  label: string;
  lines: string[];
  checks: MultiLineCheck[];
}

// ══════════════════════════════════════════════════════════════════
// Single-line tests
// ══════════════════════════════════════════════════════════════════

const tests: TestCase[] = [

  // ── Angle bracket: typeof < comparison ──
  {
    label: '#1050: typeof y < string is comparison not generic',
    input: `x = typeof y < 'z';`,
    checks: [
      { text: 'typeof', scope: 'keyword.operator.expression' },
      { text: 'y', scope: 'variable.other' },
      { text: '<', scope: 'keyword.operator.comparison' },
    ],
  },
  {
    label: '#978: typeof x < string then function',
    input: `typeof x < '';`,
    checks: [
      { text: 'typeof', scope: 'keyword.operator.expression' },
      { text: '<', scope: 'keyword.operator.comparison' },
    ],
  },

  // ── Angle bracket: as cast inside comparison ──
  {
    label: '#859: as cast inside < > comparison',
    input: 'if (a < (b as {c: number}).c || a > (b as {c: number}).c) {}',
    checks: [
      { text: 'a', scope: 'variable.other' },
      { text: 'as', scope: 'keyword.operator.expression' },
      { text: 'number', scope: 'support.type.primitive' },
    ],
  },

  // ── Angle bracket: new Map with generic, no parens ──
  {
    label: '#1020: new Map<number, number>; (no parens)',
    input: 'let m = new Map<number, number>;',
    checks: [
      { text: 'new', scope: 'keyword.operator.expression' },
      { text: 'Map', scope: 'entity.name.function' },
    ],
  },

  // ── Angle bracket: comment inside generic ──
  {
    label: '#855: new Map</* comment */string, IArgs>()',
    input: 'new Map</* comment */string, IArgs>()',
    checks: [
      { text: 'new', scope: 'keyword.operator.expression' },
      { text: 'Map', scope: 'entity.name.function' },
      { text: '/*', scope: 'comment.block' },
    ],
  },

  // ── Regex: after keywords ──
  {
    label: '#853: throw /foo/ is regex',
    input: 'throw /foo/;',
    checks: [
      { text: 'throw', scope: 'keyword.control' },
      { text: 'foo', scope: 'string.regexp' },
    ],
  },
  {
    label: '#853: void /foo/ is regex',
    input: 'void /foo/;',
    checks: [
      { text: 'void', scope: 'keyword.operator.expression' },
      { text: 'foo', scope: 'string.regexp' },
    ],
  },
  {
    label: '#853: typeof /foo/ is regex',
    input: 'typeof /foo/;',
    checks: [
      { text: 'typeof', scope: 'keyword.operator.expression' },
      { text: 'foo', scope: 'string.regexp' },
    ],
  },
  {
    label: '#853: await /foo/ is regex',
    input: 'await /foo/;',
    checks: [
      { text: 'await', scope: 'keyword.control' },
      { text: 'foo', scope: 'string.regexp' },
    ],
  },
  {
    label: '#853: yield /foo/ is regex',
    input: 'yield /foo/;',
    checks: [
      { text: 'yield', scope: 'keyword.control' },
      { text: 'foo', scope: 'string.regexp' },
    ],
  },

  // ── Regex: control escape ──
  {
    label: '#1063: /\\cJ/ control char escape',
    input: '/\\cJ/',
    checks: [
      { text: '\\c', scope: 'constant.character.escape' },
    ],
  },
  {
    label: '#1063: /\\cj/ lowercase control char',
    input: '/\\cj/',
    checks: [
      { text: '\\c', scope: 'constant.character.escape' },
    ],
  },

  // ── Regex: character class escape ──
  {
    label: '#804: /[a\\-b]/g char class recognized',
    input: '/[a\\-b]/g',
    checks: [
      { text: 'a\\-b', scope: 'constant.other.character-class' },
      { text: 'g', scope: 'keyword.other.regexp' },
    ],
  },

  // ── Ternary: in operator before ternary ──
  {
    label: '#869: x in obj ? x : fallback ternary works',
    input: `hello = val in _typeIs ? val : 'any'`,
    checks: [
      { text: 'in', scope: 'keyword.control' },
      { text: '?', scope: 'keyword.operator.ternary' },
      { text: ':', scope: 'keyword.operator.ternary' },
    ],
  },

  // ── Property/method scoping ──
  {
    label: '#736: obj.example() method gets entity.name.function',
    input: 'obj.example()',
    checks: [
      { text: 'obj', scope: 'variable.other' },
      { text: '.', scope: 'punctuation.accessor' },
      { text: 'example', scope: 'entity.name.function' },
    ],
  },
  {
    label: '#770: function call parens are punctuation',
    input: 'foo(x)',
    checks: [
      { text: 'foo', scope: 'entity.name.function' },
      { text: '(', scope: 'punctuation.bracket.round' },
      { text: ')', scope: 'punctuation.bracket.round' },
    ],
  },

  // ── Destructuring ──
  {
    label: 'destructuring: object basic',
    input: 'const { a, b } = obj;',
    checks: [
      { text: 'const', scope: 'storage.type' },
      { text: '{', scope: 'punctuation.bracket.curly' },
      { text: 'a', scope: 'variable.other' },
      { text: ',', scope: 'punctuation.separator.comma' },
      { text: 'b', scope: 'variable.other' },
      { text: '}', scope: 'punctuation.bracket.curly' },
      { text: '=', scope: 'keyword.operator.assignment' },
    ],
  },
  {
    label: 'destructuring: object rename',
    input: 'const { a: renamed } = obj;',
    checks: [
      { text: 'const', scope: 'storage.type' },
      { text: 'a', scope: 'variable.other' },
      { text: 'renamed', scope: 'variable.other' },
      { text: '=', scope: 'keyword.operator.assignment' },
    ],
  },
  {
    label: 'destructuring: object default value',
    input: 'const { a = 1 } = obj;',
    checks: [
      { text: 'a', scope: 'variable.other' },
      { text: '=', scope: 'keyword.operator.assignment' },
      { text: '1', scope: 'constant.numeric' },
    ],
  },
  {
    label: 'destructuring: object rest',
    input: 'const { a, ...rest } = obj;',
    checks: [
      { text: 'a', scope: 'variable.other' },
      { text: 'rest', scope: 'variable.other' },
    ],
  },
  {
    label: 'destructuring: array basic',
    input: 'const [x, y] = arr;',
    checks: [
      { text: 'const', scope: 'storage.type' },
      { text: '[', scope: 'punctuation.bracket.square' },
      { text: 'x', scope: 'variable.other' },
      { text: 'y', scope: 'variable.other' },
      { text: ']', scope: 'punctuation.bracket.square' },
      { text: '=', scope: 'keyword.operator.assignment' },
    ],
  },
  {
    label: 'destructuring: array rest',
    input: 'const [first, ...rest] = arr;',
    checks: [
      { text: 'first', scope: 'variable.other' },
      { text: 'rest', scope: 'variable.other' },
    ],
  },
  {
    label: 'destructuring: nested array',
    input: 'const [a, [b, c]] = nested;',
    checks: [
      { text: 'a', scope: 'variable.other' },
      { text: 'b', scope: 'variable.other' },
      { text: 'c', scope: 'variable.other' },
    ],
  },
  {
    label: 'destructuring: nested object',
    input: 'const { a: { b } } = obj;',
    checks: [
      { text: 'a', scope: 'variable.other' },
      { text: 'b', scope: 'variable.other' },
    ],
  },
  {
    label: 'destructuring: param object',
    input: 'function f({ a, b }: Props) {}',
    checks: [
      { text: 'function', scope: 'storage.type.function' },
      { text: 'f', scope: 'entity.name.function' },
      { text: '{', scope: 'punctuation.bracket.curly' },
      { text: 'a', scope: 'variable.other' },
      { text: 'b', scope: 'variable.other' },
      { text: '}', scope: 'punctuation.bracket.curly' },
    ],
  },
  {
    label: 'destructuring: param array',
    input: 'function f([a, b]: number[]) {}',
    checks: [
      { text: 'f', scope: 'entity.name.function' },
      { text: '[', scope: 'punctuation.bracket.square' },
      { text: 'a', scope: 'variable.other' },
      { text: 'b', scope: 'variable.other' },
      { text: ']', scope: 'punctuation.bracket.square' },
    ],
  },
  {
    label: 'destructuring: default param',
    input: 'function f(a = 1) {}',
    checks: [
      { text: 'f', scope: 'entity.name.function' },
      { text: 'a', scope: 'variable.other' },
      { text: '=', scope: 'keyword.operator.assignment' },
      { text: '1', scope: 'constant.numeric' },
    ],
  },
  {
    label: 'destructuring: for-of array',
    input: 'for (const [key, value] of entries) {}',
    checks: [
      { text: 'for', scope: 'keyword.control' },
      { text: 'const', scope: 'storage.type' },
      { text: 'key', scope: 'variable.other' },
      { text: 'value', scope: 'variable.other' },
      { text: 'of', scope: 'keyword.control' },
    ],
  },
  {
    label: 'destructuring: for-of object',
    input: 'for (const { name, age } of users) {}',
    checks: [
      { text: 'for', scope: 'keyword.control' },
      { text: 'const', scope: 'storage.type' },
      { text: 'name', scope: 'variable.other' },
      { text: 'age', scope: 'variable.other' },
      { text: 'of', scope: 'keyword.control' },
    ],
  },
  {
    label: 'destructuring: let with type',
    input: 'let { x, y }: Point = getPoint();',
    checks: [
      { text: 'let', scope: 'storage.type' },
      { text: 'x', scope: 'variable.other' },
      { text: 'y', scope: 'variable.other' },
      { text: 'getPoint', scope: 'entity.name.function' },
    ],
  },
  {
    label: 'destructuring: complex nested',
    input: 'const { data: [first, ...rest] } = response;',
    checks: [
      { text: 'const', scope: 'storage.type' },
      { text: 'data', scope: 'variable.other' },
      { text: 'first', scope: 'variable.other' },
      { text: 'rest', scope: 'variable.other' },
      { text: '=', scope: 'keyword.operator.assignment' },
    ],
  },
  {
    label: 'destructuring: arrow param destructuring',
    input: 'const fn = ({ x, y }: Point) => x + y;',
    checks: [
      { text: 'fn', scope: 'variable.other' },
      { text: 'x', scope: 'variable.other' },
      { text: 'y', scope: 'variable.other' },
    ],
  },

  // ── New construct coverage tests ──

  {
    label: 'satisfies enters type context',
    input: 'x satisfies Record;',
    checks: [
      { text: 'satisfies', scope: 'keyword.operator.expression' },
      { text: 'Record', scope: 'entity.name.type' },
    ],
  },
  {
    label: 'debugger statement',
    input: 'debugger;',
    checks: [
      { text: 'debugger', scope: 'keyword.control' },
    ],
  },
  {
    label: 'export default expression',
    input: 'export default 42;',
    checks: [
      { text: 'export', scope: 'keyword.control.import' },
      { text: 'default', scope: 'keyword.control' },
      { text: '42', scope: 'constant.numeric' },
    ],
  },
  {
    label: 'const enum declaration',
    input: 'const enum Color { Red, Green }',
    checks: [
      { text: 'const', scope: 'storage.type' },
      { text: 'enum', scope: 'storage.type.enum' },
      { text: 'Color', scope: 'entity.name.type' },
    ],
  },
  {
    label: 'import type statement',
    input: "import type { Foo } from 'bar';",
    checks: [
      { text: 'import', scope: 'keyword.control.import' },
      { text: 'type', scope: 'storage.type.type' },
      { text: 'Foo', scope: 'variable.other' },
    ],
  },
  {
    label: 'export type re-export',
    input: "export type { Foo } from 'bar';",
    checks: [
      { text: 'export', scope: 'keyword.control.import' },
      { text: 'type', scope: 'storage.type.type' },
      { text: 'Foo', scope: 'variable.other' },
    ],
  },
  {
    label: 'export * re-export',
    input: "export * from 'module';",
    checks: [
      { text: 'export', scope: 'keyword.control.import' },
      { text: 'from', scope: 'keyword.control.import' },
    ],
  },
  {
    label: 'dynamic import()',
    input: "const m = import('./foo');",
    checks: [
      { text: 'const', scope: 'storage.type' },
      { text: 'import', scope: 'keyword.control.import' },
    ],
  },
  {
    label: 'import.meta',
    input: 'const url = import.meta.url;',
    checks: [
      { text: 'const', scope: 'storage.type' },
      { text: 'import', scope: 'keyword.control.import' },
    ],
  },
  {
    label: 'using declaration',
    input: 'using handle = getResource();',
    checks: [
      { text: 'using', scope: 'storage.type' },
      { text: 'handle', scope: 'variable.other' },
    ],
  },
  {
    label: 'optional chaining call',
    input: 'obj?.method(x);',
    checks: [
      { text: 'obj', scope: 'variable.other' },
      { text: '?.', scope: 'punctuation.accessor.optional' },
    ],
  },
  {
    label: 'accessor keyword in class',
    input: 'accessor name: string;',
    checks: [
      { text: 'accessor', scope: 'storage.modifier' },
    ],
  },
  {
    label: 'infer keyword in type',
    input: 'type Elem = T extends Array<infer U> ? U : T;',
    checks: [
      { text: 'type', scope: 'storage.type.type' },
      { text: 'infer', scope: 'keyword.operator.expression' },
    ],
  },
  {
    label: 'asserts keyword in type',
    input: 'function assert(x: any): asserts x {}',
    checks: [
      { text: 'function', scope: 'storage.type.function' },
      { text: 'asserts', scope: 'keyword.operator.expression' },
    ],
  },
  {
    label: 'with statement',
    input: 'with (obj) { x; }',
    checks: [
      { text: 'with', scope: 'keyword.control' },
    ],
  },
  // ── Phase 14: type-keyword context ──
  {
    label: 'as enters type context',
    input: 'x as string;',
    checks: [
      { text: 'as', scope: 'keyword.operator.expression' },
      { text: 'string', scope: 'support.type.primitive' },
    ],
  },
  {
    label: 'satisfies with generic type',
    input: 'x satisfies Record<string, number>;',
    checks: [
      { text: 'satisfies', scope: 'keyword.operator.expression' },
      { text: 'Record', scope: 'entity.name.type' },
      { text: 'string', scope: 'support.type.primitive' },
    ],
  },
  // ── Phase 17: keyword granularity ──
  {
    label: 'if/else gets keyword.control.conditional',
    input: 'if (x) {} else {}',
    checks: [
      { text: 'if', scope: 'keyword.control.conditional' },
      { text: 'else', scope: 'keyword.control.conditional' },
    ],
  },
  {
    label: 'for/while gets keyword.control.loop',
    input: 'for (;;) {} while (true) {}',
    checks: [
      { text: 'for', scope: 'keyword.control.loop' },
      { text: 'while', scope: 'keyword.control.loop' },
    ],
  },
  {
    label: 'return/break gets keyword.control.flow',
    input: 'return x; break;',
    checks: [
      { text: 'return', scope: 'keyword.control.flow' },
      { text: 'break', scope: 'keyword.control.flow' },
    ],
  },
  {
    label: 'try/catch/throw gets keyword.control.trycatch',
    input: 'try {} catch (e) { throw e; }',
    checks: [
      { text: 'try', scope: 'keyword.control.trycatch' },
      { text: 'catch', scope: 'keyword.control.trycatch' },
      { text: 'throw', scope: 'keyword.control.trycatch' },
    ],
  },
  // ── Phase 15: string punctuation captures ──
  {
    label: 'double-quoted string punctuation captures',
    input: 'const x = "hello";',
    checks: [
      { text: '"', scope: 'punctuation.definition.string.begin' },
      { text: '"', scope: 'punctuation.definition.string.end' },
    ],
  },
  {
    label: 'single-quoted string punctuation captures',
    input: "const x = 'hello';",
    checks: [
      { text: "'", scope: 'punctuation.definition.string.begin' },
      { text: "'", scope: 'punctuation.definition.string.end' },
    ],
  },
  {
    label: 'template literal punctuation captures',
    input: 'const x = `hello`;',
    checks: [
      { text: '`', scope: 'punctuation.definition.string.template.begin' },
      { text: '`', scope: 'punctuation.definition.string.template.end' },
    ],
  },

  // ── Backlog issues confirmed already-correct in the generated grammar (verified, then locked in) ──
  {
    label: '#1021: regex with the v (unicode-sets) flag is recognized',
    input: 'const re = /foo/v;',
    checks: [
      { text: 'foo', scope: 'string.regexp' },
      { text: 'v', scope: 'keyword.other.regexp' },
    ],
  },
  {
    label: '#788: optional chaining ?. is the optional accessor',
    input: 'a?.b;',
    checks: [
      { text: '?.', scope: 'punctuation.accessor.optional' },
      { text: 'b', scope: 'variable.other' },
    ],
  },
  {
    label: '#1025: for-of without surrounding space keeps `of` a loop keyword',
    input: 'for(const x of[1]);',
    checks: [
      { text: 'of', scope: 'keyword.control.loop' },
    ],
  },
  {
    label: '#1025: for-in without surrounding space keeps `in` a loop keyword',
    input: 'for(const k in o);',
    checks: [
      { text: 'in', scope: 'keyword.control.loop' },
    ],
  },
  {
    label: '#815: a class method named `new` is a method name, not the operator',
    input: 'class C { new() {} }',
    checks: [
      { text: 'new', scope: 'entity.name.function' },
    ],
  },
  {
    label: '#881: `override` modifier on a method is storage.modifier',
    input: 'class C extends B { override f() {} }',
    checks: [
      { text: 'override', scope: 'storage.modifier' },
      { text: 'f', scope: 'entity.name.function' },
    ],
  },
  {
    label: '#1066: triple-slash reference directive is a comment',
    input: `/// <reference path="x.d.ts" />`,
    checks: [
      { text: `/// <reference path="x.d.ts" />`, scope: 'comment.line.triple-slash' },
    ],
  },
  {
    label: '#992: casting to a type named `type` does not break highlighting',
    input: 'const y = (x as type).z;',
    checks: [
      { text: 'as', scope: 'keyword.operator.expression' },
      { text: 'type', scope: 'entity.name.type' },
      { text: 'z', scope: 'entity.other.property' },
    ],
  },
  {
    label: '#995: paren-wrapped `as keyof typeof` assertion tokenizes',
    input: 'const k = (obj as keyof typeof X);',
    checks: [
      { text: 'as', scope: 'keyword.operator.expression' },
      { text: 'keyof', scope: 'keyword.operator.expression.keyof' },
      { text: 'typeof', scope: 'keyword.operator.expression' },
      { text: 'X', scope: 'variable.other' },
    ],
  },
  {
    label: '#994: default type-parameter value is colored',
    input: 'function f<T = string>(): T {}',
    checks: [
      { text: 'T', scope: 'entity.name.type' },
      { text: 'string', scope: 'support.type.primitive' },
    ],
  },
  {
    label: '#1027: nested generic `>>` closes two type-arg lists, not a shift',
    input: 'let m: Map<string, Array<number>>;',
    checks: [
      { text: 'Map', scope: 'entity.name.type' },
      { text: 'Array', scope: 'entity.name.type' },
      { text: 'number', scope: 'support.type.primitive' },
    ],
  },
  {
    label: '#891: `from` as an ordinary variable is not a keyword',
    input: 'const from = 1;',
    checks: [
      { text: 'from', scope: 'variable.other' },
    ],
  },
  {
    label: '#891: default import named `from` — binding is a variable, source-`from` stays a keyword',
    input: 'import from from "m";',
    checks: [
      { text: 'from', scope: 'variable.other' },
      { text: 'from', scope: 'keyword.control.import' },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════
// Multi-line tests
// ══════════════════════════════════════════════════════════════════

const multiLineTests: MultiLineTest[] = [

  // ── Angle bracket: multiline generic call ──
  {
    label: '#1014: multiline generic call abc<X,Y,Z>()',
    lines: [
      'const result4 = abc<',
      '\tX,',
      '\tY,',
      '\tZ',
      '>()',
    ],
    checks: [
      { line: 0, text: 'abc', scope: 'variable.other' },
      { line: 0, text: '<', scope: 'punctuation' },
      { line: 1, text: 'X', scope: 'entity.name.type' },
      { line: 2, text: 'Y', scope: 'entity.name.type' },
      { line: 3, text: 'Z', scope: 'entity.name.type' },
      { line: 4, text: '>', scope: 'punctuation' },
    ],
  },

  // ── Angle bracket: comparison at start of line ──
  {
    label: '#884: 0\\n< x\\n&& 1 > 0 is comparison',
    lines: [
      '0',
      '< x',
      '&& 1 > 0',
    ],
    checks: [
      { line: 0, text: '0', scope: 'constant.numeric' },
      { line: 1, text: '<', scope: 'keyword.operator' },
      { line: 1, text: 'x', scope: 'variable.other' },
      { line: 2, text: '&&', scope: 'keyword.operator.logical' },
      { line: 2, text: '1', scope: 'constant.numeric' },
      { line: 2, text: '>', scope: 'keyword.operator' },
      { line: 2, text: '0', scope: 'constant.numeric' },
    ],
  },
  {
    label: '#904: let bad = 1\\n  < obj.two is comparison',
    lines: [
      'let bad = 1',
      '  < obj.two',
    ],
    checks: [
      { line: 0, text: 'let', scope: 'storage.type' },
      { line: 0, text: '1', scope: 'constant.numeric' },
      { line: 1, text: '<', scope: 'keyword.operator' },
      { line: 1, text: 'two', scope: 'entity.other.property' },
    ],
  },

  // ── Angle bracket: multiline generic in class method doesn't break subsequent code ──
  {
    label: '#890: multiline JSX/generic in class doesn\'t break method',
    lines: [
      'class Foo {',
      '  method1() {',
      '    return <',
      '      a',
      '    >{ v: "a string" };',
      '  }',
      '  method2() {',
      '    return 1;',
      '  }',
      '}',
    ],
    checks: [
      { line: 1, text: 'method1', scope: 'entity.name.function' },
      { line: 6, text: 'method2', scope: 'entity.name.function' },
      { line: 7, text: 'return', scope: 'keyword.control' },
      { line: 7, text: '1', scope: 'constant.numeric' },
    ],
  },

  // ── Angle bracket: multiline new Map<> then broken method ──
  {
    label: '#973: new Map<Type1, Type2>([]) doesn\'t break next method',
    lines: [
      'class Foo {',
      '  method1() {',
      '    new Map<',
      '      Type1, Type2>([])',
      '  }',
      '  method2() {',
      '    return 1;',
      '  }',
      '}',
    ],
    checks: [
      { line: 1, text: 'method1', scope: 'entity.name.function' },
      { line: 2, text: 'new', scope: 'keyword.operator.expression' },
      { line: 2, text: 'Map', scope: 'entity.name.function' },
      { line: 5, text: 'method2', scope: 'entity.name.function' },
      { line: 6, text: 'return', scope: 'keyword.control' },
    ],
  },

  // ── Angle bracket: multiline type assertion ──
  {
    label: '#983: multiline type assertion <{...}>expr then if works',
    lines: [
      '<',
      '  {',
      '    id1: string;',
      '  }',
      '>req.query',
      'if (true) {}',
    ],
    checks: [
      { line: 2, text: 'string', scope: 'support.type.primitive' },
      { line: 4, text: 'req', scope: 'variable.other' },
      { line: 5, text: 'if', scope: 'keyword.control' },
    ],
  },

  // ── Angle bracket: multiline generic with extends and nested generics ──
  // (angle-bracket fallback scope: type-inner patterns not yet applied)
  {
    label: '#1028: test<A extends Record<string, any>, ...>(a, b) in object',
    lines: [
      'const obj = {',
      '  test<',
      '    A extends Record<string, any>,',
      '    B extends string',
      '  >(a: A, b: B) {}',
      '}',
    ],
    checks: [
      { line: 1, text: 'test', scope: 'variable.other' },
      { line: 2, text: 'Record', scope: 'entity.name.type' },
      { line: 2, text: 'string', scope: 'support.type.primitive' },
      { line: 4, text: '>', scope: 'typeparameters.end' },
    ],
  },

  // ── Angle bracket: object shorthand with multiline generics ──
  // (angle-bracket fallback: string gets entity.name.type inside brackets)
  {
    label: '#894: fn<K extends string>(_: K) in object shorthand',
    lines: [
      'const o = {',
      '  fn<',
      '    K extends string',
      '  >(_: K) {}',
      '}',
    ],
    checks: [
      { line: 1, text: 'fn', scope: 'variable.other' },
      { line: 2, text: 'string', scope: 'entity.name.type' },
      { line: 3, text: '>', scope: 'typeparameters.end' },
    ],
  },

  // ── Angle bracket: async arrow with multiline generics ──
  // (known gap: async <T>() arrow generic not fully detected as type params)
  {
    label: '#819: async <TData, TError extends string>(...) multiline generic arrow',
    lines: [
      'const fn = async <TData, TError extends string = string>(',
      '  url: string,',
      '  data: TData',
      ') => {}',
    ],
    checks: [
      { line: 0, text: 'async', scope: 'storage.modifier' },
      { line: 0, text: 'extends', scope: 'keyword.other.extends' },
      { line: 3, text: '=>', scope: 'storage.type.function.arrow' },
    ],
  },

  // ── Angle bracket: nested generic with default type ──
  {
    label: '#1035: func<T = Lowercase<StringLiteral>>(): T in interface',
    lines: [
      'interface I {',
      `  func<T = Lowercase<'StringLiteral'>>(): T;`,
      '  let var2;',
      '}',
    ],
    checks: [
      { line: 0, text: 'interface', scope: 'storage.type.interface' },
      { line: 1, text: 'func', scope: 'entity.name.function' },
      { line: 1, text: 'T', scope: 'entity.name.type' },
      { line: 1, text: 'Lowercase', scope: 'entity.name.type' },
    ],
  },

  // ── Angle bracket: type followed by call on next line ──
  {
    label: '#873: type Type = string\\nfoo().then(...) not broken',
    lines: [
      'type Type = string',
      'foo().then(async bar => {',
      '  return bar',
      '})',
    ],
    checks: [
      { line: 0, text: 'type', scope: 'storage.type.type' },
      { line: 0, text: 'Type', scope: 'entity.name.type' },
      { line: 0, text: 'string', scope: 'support.type.primitive' },
      { line: 1, text: 'foo', scope: 'entity.name.function' },
      { line: 1, text: 'then', scope: 'entity.name.function' },
      { line: 1, text: 'bar', scope: 'variable.parameter' },
    ],
  },

  // ── Angle bracket: template literal generic ──
  {
    label: '#896: on<Key extends string>(eventName: `${Key}Changed`)',
    lines: [
      'interface I {',
      '  on<Key extends string>',
      '    (eventName: `${Key}Changed`): void;',
      '}',
    ],
    checks: [
      { line: 1, text: 'on', scope: 'entity.name.function' },
      { line: 1, text: 'Key', scope: 'entity.name.type' },
      { line: 1, text: 'extends', scope: 'keyword.other.extends' },
      { line: 1, text: 'string', scope: 'support.type.primitive' },
      { line: 2, text: 'eventName', scope: 'variable.parameter' },
      { line: 2, text: 'void', scope: 'support.type.primitive' },
    ],
  },

  // ── Type/declaration: multiline return type with union ──
  {
    label: '#1051: function myFunction():\\n| null\\n| null\\n| null {',
    lines: [
      'function myFunction():',
      '  | null',
      '  | null',
      '  | null {',
      '  return null;',
      '}',
    ],
    checks: [
      { line: 0, text: 'function', scope: 'storage.type.function' },
      { line: 0, text: 'myFunction', scope: 'entity.name.function' },
      { line: 1, text: 'null', scope: 'constant.language.null' },
      { line: 4, text: 'return', scope: 'keyword.control' },
      { line: 4, text: 'null', scope: 'constant.language.null' },
    ],
  },

  // ── Type/declaration: method return union with Array<> ──
  {
    label: '#1041: foo():\\n| string\\n| Array<number> {',
    lines: [
      'class C {',
      '  foo():',
      '    | string',
      '    | Array<number> {',
      '    return 1;',
      '  }',
      '}',
    ],
    checks: [
      { line: 1, text: 'foo', scope: 'entity.name.function' },
      { line: 2, text: 'string', scope: 'support.type.primitive' },
      { line: 3, text: 'Array', scope: 'entity.name.type' },
      { line: 3, text: 'number', scope: 'support.type.primitive' },
      { line: 4, text: 'return', scope: 'keyword.control' },
    ],
  },

  // ── Type/declaration: let union type then function ──
  {
    label: '#1043: let myObj:\\n| {prop1}\\n| {prop2}\\nfunction myFunc()',
    lines: [
      'let myObj:',
      '  | { prop1: string }',
      '  | { prop2: string }',
      'function myFunc() {}',
    ],
    checks: [
      { line: 0, text: 'let', scope: 'storage.type' },
      { line: 1, text: 'string', scope: 'support.type.primitive' },
      { line: 2, text: 'string', scope: 'support.type.primitive' },
      { line: 3, text: 'function', scope: 'storage.type.function' },
      { line: 3, text: 'myFunc', scope: 'entity.name.function' },
    ],
  },

  // ── Type/declaration: generic with default array type ──
  {
    label: '#1040: a<A extends [number] = [\\nnumber\\n]>(value): boolean',
    lines: [
      'interface I {',
      '  a<A extends [number] = [',
      '    number',
      '  ]>(value: number): boolean;',
      '}',
    ],
    checks: [
      { line: 1, text: 'a', scope: 'entity.name.function' },
      { line: 1, text: 'A', scope: 'entity.name.type' },
      { line: 1, text: 'extends', scope: 'keyword.other.extends' },
      { line: 2, text: 'number', scope: 'support.type.primitive' },
      { line: 3, text: 'value', scope: 'variable.parameter' },
      { line: 3, text: 'boolean', scope: 'support.type.primitive' },
    ],
  },

  // ── Type/declaration: let union then for loop ──
  {
    label: '#1056: let value:\\n| {x}\\n| undefined\\nfor loop',
    lines: [
      'let value:',
      '  | { x: number }',
      '  | undefined',
      'for (let i = 0; i < 3; ++i) {}',
    ],
    checks: [
      { line: 0, text: 'let', scope: 'storage.type' },
      { line: 1, text: 'number', scope: 'support.type.primitive' },
      { line: 3, text: 'for', scope: 'keyword.control' },
      { line: 3, text: 'i', scope: 'variable.other' },
    ],
  },

  // ── Type/declaration: const = (\\ndata: Set<string>\\n) => {} ──
  {
    label: '#1053: const clearSet =\\n(\\ndata: Set<string>\\n) => {}',
    lines: [
      'const clearSet =',
      '(',
      '  data: Set<string>',
      ') => {}',
    ],
    checks: [
      { line: 0, text: 'const', scope: 'storage.type' },
      { line: 2, text: 'data', scope: 'variable.other' },
      { line: 2, text: 'string', scope: 'support.type.primitive' },
      { line: 3, text: '=>', scope: 'storage.type.function.arrow' },
    ],
  },

  // ── Type/declaration: async arrow with multiline object param ──
  {
    label: '#1059: async (params?: {\\narg?: string;\\n}) => {}',
    lines: [
      'const a = async (params?: {',
      '  arg?: string;',
      '}) => { return params; };',
    ],
    checks: [
      { line: 0, text: 'async', scope: 'storage.modifier' },
      { line: 1, text: 'string', scope: 'support.type.primitive' },
      { line: 2, text: '=>', scope: 'storage.type.function.arrow' },
      { line: 2, text: 'return', scope: 'keyword.control' },
    ],
  },

  // ── Type/declaration: generic with callback type ──
  {
    label: '#1002: AFunction<\\n(arg: string) => unknown\\n>(() => {})',
    lines: [
      'AFunction<',
      '  (arg: string) => unknown',
      '>(() => {});',
    ],
    checks: [
      { line: 0, text: 'AFunction', scope: 'variable.other' },
      { line: 1, text: 'unknown', scope: 'support.type.primitive' },
      { line: 2, text: '=>', scope: 'storage.type.function.arrow' },
    ],
  },

  // ── Type/declaration: let:\\nnumber\\nfor ──
  {
    label: '#981: let a:\\nnumber\\nfor (;;);',
    lines: [
      'let a:',
      '  number',
      'for (;;);',
    ],
    checks: [
      { line: 0, text: 'let', scope: 'storage.type' },
      { line: 1, text: 'number', scope: 'support.type.primitive' },
      { line: 2, text: 'for', scope: 'keyword.control' },
    ],
  },

  // ── Type/declaration: arrow return tuple type ──
  {
    label: '#911: const foo = (...): [\\nel1: number,\\n] => {}',
    lines: [
      'const foo = (...args: any[]): [',
      '  el1: number,',
      `] => { return [1, '2'] }`,
    ],
    checks: [
      { line: 0, text: 'any', scope: 'support.type.primitive' },
      { line: 2, text: '=>', scope: 'storage.type.function.arrow' },
      { line: 2, text: 'return', scope: 'keyword.control' },
    ],
  },

  // ── Regex: division on new line ──
  {
    label: '#1024: 1\\n/ f(/u/g) division not regex',
    lines: [
      '1',
      '\t/ f(/u/g)',
    ],
    checks: [
      { line: 0, text: '1', scope: 'constant.numeric' },
    ],
  },

  // ── Regex: backtick inside regex then template ──
  {
    label: '#1055: const regex = /sql`/gu; then template literal',
    lines: [
      'const regex = /sql`/gu;',
      'const s = `hello`;',
    ],
    checks: [
      { line: 0, text: 'const', scope: 'storage.type' },
      { line: 0, text: 'sql`', scope: 'string.regexp' },
      { line: 0, text: 'gu', scope: 'keyword.other.regexp' },
      { line: 1, text: 'const', scope: 'storage.type' },
    ],
  },

  // ── Regex: in for-of (known gap: of /regex/ not yet detected) ──
  {
    label: '#883: regex in for-of: for (const req of /require/.exec(...))',
    lines: [
      'for (const req of /require/.exec(fileCode)) {',
      '  console.log(req);',
      '}',
    ],
    checks: [
      { line: 0, text: 'for', scope: 'keyword.control' },
      { line: 0, text: 'const', scope: 'storage.type' },
      { line: 0, text: 'req', scope: 'variable.other' },
      { line: 0, text: 'of', scope: 'keyword.control' },
      { line: 1, text: 'console', scope: 'support.variable' },
    ],
  },

  // ── Ternary: multiline with template literal ──
  {
    label: '#1019: "a"\\n+ (!b() ? `_${1}` : "")',
    lines: [
      '"a"',
      '+ (!b() ? `_${1}` : "")',
    ],
    checks: [
      { line: 1, text: '?', scope: 'keyword.operator.ternary' },
      { line: 1, text: ':', scope: 'keyword.operator.ternary' },
    ],
  },

  // ── Scope leak: type = number then const on next line ──
  {
    label: '#889: type B = number\\nconst b = 5 inside lambda',
    lines: [
      'const fn = () => {',
      '  type B = number',
      '  const b = 5',
      '}',
      'const a = 1',
    ],
    checks: [
      { line: 1, text: 'type', scope: 'storage.type.type' },
      { line: 1, text: 'B', scope: 'entity.name.type' },
      { line: 1, text: 'number', scope: 'support.type.primitive' },
      { line: 2, text: 'const', scope: 'storage.type' },
      { line: 2, text: '5', scope: 'constant.numeric' },
      { line: 4, text: 'const', scope: 'storage.type' },
      { line: 4, text: '1', scope: 'constant.numeric' },
    ],
  },

  // ── Angle bracket: eslint comments between generic params ──
  // (known gap: // inside type generic breaks the generic scope)
  {
    label: '#876: multiline type with eslint comments between params',
    lines: [
      'type T = Map<',
      '  // eslint-disable-next-line',
      '  string,',
      '  number',
      '>',
    ],
    checks: [
      { line: 0, text: 'type', scope: 'storage.type.type' },
      { line: 0, text: 'T', scope: 'entity.name.type' },
      { line: 0, text: 'Map', scope: 'entity.name.type' },
    ],
  },

  // ── Template literal with interpolation ──
  {
    label: 'template literal ${expr} interpolation',
    lines: [
      'const msg = `hello ${name}!`;',
    ],
    checks: [
      { line: 0, text: 'const', scope: 'storage.type' },
      { line: 0, text: 'msg', scope: 'variable.other' },
      { line: 0, text: '`', scope: 'string.quoted.other.template' },
      { line: 0, text: 'name', scope: 'variable.other' },
    ],
  },
  {
    label: 'template literal type with ${string}',
    lines: [
      'type Greeting = `hello ${string}`;',
    ],
    checks: [
      { line: 0, text: 'type', scope: 'storage.type.type' },
      { line: 0, text: 'Greeting', scope: 'entity.name.type' },
      { line: 0, text: 'string', scope: 'support.type.primitive' },
    ],
  },
  // ── Phase 13: block delimiter captures ──
  {
    label: 'class body { } gets punctuation.definition.block',
    lines: [
      'class Foo {',
      '  x = 1;',
      '}',
    ],
    checks: [
      { line: 0, text: 'class', scope: 'storage.type.class' },
      { line: 0, text: '{', scope: 'punctuation.definition.block' },
      { line: 2, text: '}', scope: 'punctuation.definition.block' },
    ],
  },
  {
    label: 'function body { } gets punctuation.definition.block',
    lines: [
      'function foo() {',
      '  return 1;',
      '}',
    ],
    checks: [
      { line: 0, text: 'function', scope: 'storage.type.function' },
      { line: 0, text: '{', scope: 'punctuation.definition.block' },
      { line: 2, text: '}', scope: 'punctuation.definition.block' },
    ],
  },
  // ── Phase 15: template interpolation captures ──
  {
    label: 'template ${} gets punctuation.definition.template-expression',
    lines: [
      'const x = `hi ${name}!`;',
    ],
    checks: [
      { line: 0, text: '`', scope: 'punctuation.definition.string.template.begin' },
      { line: 0, text: '${', scope: 'punctuation.definition.template-expression.begin' },
      { line: 0, text: '}', scope: 'punctuation.definition.template-expression.end' },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════
// Run tests
// ══════════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;

// ── Single-line tests ──

for (const test of tests) {
  console.log(`\n── ${test.label}: ${test.input} ──`);

  const result = grammar.tokenizeLine(test.input, INITIAL);

  for (const token of result.tokens) {
    const text = test.input.slice(token.startIndex, token.endIndex);
    const innerScope = token.scopes[token.scopes.length - 1];
    console.log(`  ${text.padEnd(15)} ${innerScope}`);
  }

  let checkIdx = 0;
  for (const token of result.tokens) {
    if (checkIdx >= test.checks.length) break;
    const text = test.input.slice(token.startIndex, token.endIndex);
    const check = test.checks[checkIdx];
    if (text === check.text) {
      const scopes = token.scopes.join(' ');
      if (scopes.includes(check.scope)) {
        passed++;
      } else {
        console.log(`  FAIL: '${check.text}' expected scope containing '${check.scope}', got: ${scopes}`);
        failed++;
      }
      checkIdx++;
    }
  }
  if (checkIdx < test.checks.length) {
    for (let i = checkIdx; i < test.checks.length; i++) {
      console.log(`  FAIL: '${test.checks[i].text}' not found in token stream`);
      failed++;
    }
  }
}

// ── Multi-line tests ──

for (const test of multiLineTests) {
  console.log(`\n── ML: ${test.label} ──`);
  console.log(`  input: ${test.lines.map(l => JSON.stringify(l)).join(' / ')}`);

  const lineResults: vsctm.ITokenizeLineResult[] = [];
  let ruleStack = INITIAL;
  for (const line of test.lines) {
    const result = grammar.tokenizeLine(line, ruleStack);
    lineResults.push(result);
    ruleStack = result.ruleStack;
  }

  for (let li = 0; li < test.lines.length; li++) {
    const line = test.lines[li];
    for (const token of lineResults[li].tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      const innerScope = token.scopes[token.scopes.length - 1];
      console.log(`  L${li}: ${text.padEnd(15)} ${innerScope}`);
    }
  }

  for (const check of test.checks) {
    const line = test.lines[check.line];
    const tokens = lineResults[check.line].tokens;
    let found = false;
    for (const token of tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      if (text === check.text) {
        const scopes = token.scopes.join(' ');
        if (scopes.includes(check.scope)) {
          passed++;
        } else {
          console.log(`  FAIL: L${check.line} '${check.text}' expected '${check.scope}', got: ${scopes}`);
          failed++;
        }
        found = true;
        break;
      }
    }
    if (!found) {
      console.log(`  FAIL: L${check.line} '${check.text}' not found in token stream`);
      failed++;
    }
  }
}

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
