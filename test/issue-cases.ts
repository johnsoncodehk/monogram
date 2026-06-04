// issue-cases.ts — the documented microsoft/TypeScript-TmLanguage issues, as DATA.
// Single source of truth shared by test/test-issues.ts (Monogram self-test) and
// test/scope-gap.ts (neutral-oracle bench). No side effects on import.
// Each case label carries its tracker #issue number (microsoft/TypeScript-TmLanguage).

export interface Check { text: string; scope: string; }
// `monoGap`: an honest reported bug the DERIVED grammar does NOT solve yet (only-official, or
// both-miss). It still appears in the README cross-language comparison table (graded honestly by
// test/issue-table.ts), but the Monogram-measurement consumers SKIP it — the self-test
// (test/test-issues.ts) and the accuracy benches (test/scope-gap.ts, test/treesitter-bench.ts)
// gate Monogram's KNOWN-GOOD corpus, not the full honest comparison universe, so a case Monogram
// gets wrong must not fail them. Same convention as test/vue-issue-cases.ts.
export interface TestCase { label: string; input: string; checks: Check[]; monoGap?: boolean; }
export interface MultiLineCheck { line: number; text: string; scope: string; }
export interface MultiLineTest { label: string; lines: string[]; checks: MultiLineCheck[]; monoGap?: boolean; }

export const tests: TestCase[] = [

  // ── Angle bracket: typeof < comparison ──
  {
    // The reported repro carries the cascade VICTIM (`if (x) {} else {}`) the bug derails — the
    // issue is that the bad `<`-as-type-param reading "breaks all syntax highlighting after it".
    // Keep the victim so the test exercises the actual reported facet, not just the `<` in isolation.
    label: '#1050: typeof y < string is a relational operator not generic (cascade victim intact)',
    input: `x = typeof y < 'z'; if (x) {} else {}`,
    checks: [
      { text: 'typeof', scope: 'keyword.operator.expression' },
      { text: 'y', scope: 'variable.other' },
      // `<` is a bare operator here (not a type-parameter bracket); the official
      // grammar scopes `< > <= >=` `keyword.operator.relational` (vs `comparison`
      // for `== != === !==`).
      { text: '<', scope: 'keyword.operator.relational' },
      // the cascade victim after the `<` keeps its conditional keyword (not swallowed into a type)
      { text: 'if', scope: 'keyword.control.conditional' },
      { text: 'else', scope: 'keyword.control.conditional' },
    ],
  },
  {
    // #978's repro is `typeof x < ''; function f() {}` — the trailing `function f()` is the victim
    // the bug breaks ("breaks all syntax highlighting after it"). The old input dropped it, so the
    // label's "then function" was untested; keep the function so the cascade is actually checked.
    label: '#978: typeof x < string then function (cascade victim intact)',
    input: `typeof x < ''; function f() {}`,
    checks: [
      { text: 'typeof', scope: 'keyword.operator.expression' },
      { text: '<', scope: 'keyword.operator.relational' },
      // the post-`<` function declaration survives (keyword + name correctly scoped)
      { text: 'function', scope: 'storage.type.function' },
      { text: 'f', scope: 'entity.name.function' },
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
  // The regex-internals sub-grammar scopes the whole `\cX` control escape as
  // constant.character.control.regexp (matching the official grammar), rather
  // than the old coarse `\c`-only constant.character.escape.
  {
    label: '#1063: /\\cJ/ control char escape',
    input: '/\\cJ/',
    checks: [
      { text: '\\cJ', scope: 'constant.character.control' },
    ],
  },
  {
    label: '#1063: /\\cj/ lowercase control char',
    input: '/\\cj/',
    // `\cj` (lowercase) is NOT a valid control escape, so `\c` is consumed as a
    // plain backslash escape and `j` is a literal — matching the official grammar.
    checks: [
      { text: '\\c', scope: 'constant.character.escape.backslash' },
    ],
  },

  // ── Regex: character class escape ──
  // The character-class sub-grammar splits `[a\-b]` into the set delimiters, the
  // bare `a`, and the `\-b` range (constant.other.character-class.range.regexp,
  // a constant.other.character-class.* scope) — the official grammar's structure.
  {
    label: '#804: /[a\\-b]/g char class recognized',
    input: '/[a\\-b]/g',
    checks: [
      { text: '\\-b', scope: 'constant.other.character-class' },
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
      { text: '{', scope: 'punctuation.definition.binding-pattern.object' },
      { text: 'a', scope: 'variable.other.constant' },
      { text: ',', scope: 'punctuation.separator.comma' },
      { text: 'b', scope: 'variable.other.constant' },
      { text: '}', scope: 'punctuation.definition.binding-pattern.object' },
      { text: '=', scope: 'keyword.operator.assignment' },
    ],
  },
  {
    label: 'destructuring: object rename',
    input: 'const { a: renamed } = obj;',
    checks: [
      { text: 'const', scope: 'storage.type' },
      { text: 'a', scope: 'variable.object.property' },          // key
      { text: 'renamed', scope: 'variable.other.constant' },     // bound name
      { text: '=', scope: 'keyword.operator.assignment' },
    ],
  },
  {
    label: 'destructuring: object default value',
    input: 'const { a = 1 } = obj;',
    checks: [
      { text: 'a', scope: 'variable.other.constant' },
      { text: '=', scope: 'keyword.operator.assignment' },
      { text: '1', scope: 'constant.numeric' },
    ],
  },
  {
    label: 'destructuring: object rest',
    input: 'const { a, ...rest } = obj;',
    checks: [
      { text: 'a', scope: 'variable.other.constant' },
      { text: 'rest', scope: 'variable.other.constant' },
    ],
  },
  {
    label: 'destructuring: array basic',
    input: 'const [x, y] = arr;',
    checks: [
      { text: 'const', scope: 'storage.type' },
      { text: '[', scope: 'punctuation.definition.binding-pattern.array' },
      { text: 'x', scope: 'variable.other.constant' },
      { text: 'y', scope: 'variable.other.constant' },
      { text: ']', scope: 'punctuation.definition.binding-pattern.array' },
      { text: '=', scope: 'keyword.operator.assignment' },
    ],
  },
  {
    label: 'destructuring: array rest',
    input: 'const [first, ...rest] = arr;',
    checks: [
      { text: 'first', scope: 'variable.other.constant' },
      { text: 'rest', scope: 'variable.other.constant' },
    ],
  },
  {
    label: 'destructuring: nested array',
    input: 'const [a, [b, c]] = nested;',
    checks: [
      { text: 'a', scope: 'variable.other.constant' },
      { text: 'b', scope: 'variable.other.constant' },
      { text: 'c', scope: 'variable.other.constant' },
    ],
  },
  {
    label: 'destructuring: nested object',
    input: 'const { a: { b } } = obj;',
    checks: [
      { text: 'a', scope: 'variable.object.property' },   // key
      { text: 'b', scope: 'variable.other.constant' },    // nested bound name
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
      { text: 'a', scope: 'variable.parameter' },
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
      { text: '{', scope: 'punctuation.definition.binding-pattern.object' },  // not a plain bracket
      { text: 'x', scope: 'variable.other.readwrite' },                       // mutable binding (NOT constant)
      { text: 'y', scope: 'variable.other.readwrite' },
      { text: 'getPoint', scope: 'entity.name.function' },
    ],
  },
  {
    label: 'destructuring: let/var rename + array rest (readwrite flavor)',
    input: 'let { p, q: qq } = o; var [h, ...t] = a;',
    checks: [
      { text: 'let', scope: 'storage.type' },
      { text: '{', scope: 'punctuation.definition.binding-pattern.object' },
      { text: 'p', scope: 'variable.other.readwrite' },
      { text: 'q', scope: 'variable.object.property' },        // renamed key, not a binding name
      { text: 'qq', scope: 'variable.other.readwrite' },       // the bound (mutable) name
      { text: '}', scope: 'punctuation.definition.binding-pattern.object' },
      { text: 'var', scope: 'storage.type' },
      { text: '[', scope: 'punctuation.definition.binding-pattern.array' },
      { text: 'h', scope: 'variable.other.readwrite' },
      { text: '...', scope: 'keyword.operator.rest' },
      { text: 't', scope: 'variable.other.readwrite' },
      { text: ']', scope: 'punctuation.definition.binding-pattern.array' },
    ],
  },
  {
    label: 'destructuring: complex nested',
    input: 'const { data: [first, ...rest] } = response;',
    checks: [
      { text: 'const', scope: 'storage.type' },
      { text: 'data', scope: 'variable.object.property' },   // key (nested array binding follows)
      { text: 'first', scope: 'variable.other.constant' },
      { text: 'rest', scope: 'variable.other.constant' },
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
      { text: 'export', scope: 'keyword.control.export' },
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
      { text: 'export', scope: 'keyword.control.export' },
      { text: 'type', scope: 'storage.type.type' },
      { text: 'Foo', scope: 'variable.other' },
    ],
  },
  {
    label: 'export * re-export',
    input: "export * from 'module';",
    checks: [
      { text: 'export', scope: 'keyword.control.export' },
      { text: 'from', scope: 'keyword.control.from' },
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
    label: 'return gets keyword.control.flow, break gets keyword.control.loop',
    input: 'return x; break;',
    checks: [
      { text: 'return', scope: 'keyword.control.flow' },
      // `break`/`continue` are loop-control in the official grammar (keyword.control.loop).
      { text: 'break', scope: 'keyword.control.loop' },
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
  // #995's real repro is the `d` FORM — a paren-wrapped object literal whose `(` and `{` are on
  // SEPARATE lines: only THEN does the inner `as keyof typeof` mis-tokenize (the single-line `c`
  // form works fine, so it does NOT exercise the bug). The old input here was a simple single-line
  // paren cast (`(obj as keyof typeof X)`), a different construct — moved to multiLineTests below
  // as the faithful multi-line `d`-form repro (Monogram keeps `as`/`keyof`/`typeof` keywords there).
  //
  // #994 is about a JSDoc `@template` DEFAULT — `@template [Output=Value]` inside a `/** */`
  // comment — whose param name is "not colored". It is NOT about a generic-parameter default
  // (`function f<T = string>`, which both grammars already color). The TS-flavored bracket form
  // `[Name=Default]` starts with `[`, so the official's two `@template` patterns (an
  // identifier-list and a `{Constraint}` brace form — both of which Monogram mirrors exactly)
  // never match it; the official leaves the whole `[Output=Value]` as one bare
  // `comment.block.documentation` blob, `Output` unscoped. Monogram's DERIVED, extensible JSDoc
  // sub-grammar adds a dedicated bracket-default pattern (gen-tm `generateJsdocPatterns`): the
  // `[`/`]` get the `@param [opt=default]` square-bracket scopes, `=` is the assignment operator,
  // and the declared param NAME (and its default) become `entity.name.type.jsdoc`. So Monogram
  // colors `Output` as a type name while the official still misses it → an only-Monogram win
  // (the plain `@template T` / `T, U` / `{C} T` forms stay byte-identical to the official).
  {
    label: '#994: JSDoc `@template [Output=Value]` default — Monogram colors the param name, official misses it',
    input: '/** @template [Output=Value] */',
    checks: [
      // Monogram scopes the declared template-param name as a type name (the official leaves it
      // as bare comment text). This is the only-Monogram win.
      { text: 'Output', scope: 'entity.name.type.jsdoc' },
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
      { text: 'from', scope: 'keyword.control.from' },
    ],
  },
  // Contextual operator keywords (`as`/`keyof`/`is`/…): keyword only in operator/type
  // position, a plain variable as an identifier — matching the official grammar.
  {
    label: 'contextual `as`: identifier binding is a variable, not a keyword',
    input: 'const as = 1;',
    checks: [
      { text: 'as', scope: 'variable.other' },
    ],
  },
  {
    label: 'contextual `as`: the cast operator stays a keyword',
    input: 'const y = x as T;',
    checks: [
      { text: 'as', scope: 'keyword.operator.expression' },
    ],
  },
  {
    label: 'contextual `keyof`: identifier binding is a variable',
    input: 'const keyof = 1;',
    checks: [
      { text: 'keyof', scope: 'variable.other' },
    ],
  },
  {
    label: 'contextual `keyof`/`is` in TYPE position stay keywords (not entity.name.type)',
    input: 'function f(p): p is keyof T {}',
    checks: [
      { text: 'is', scope: 'keyword.operator.expression' },
      { text: 'keyof', scope: 'keyword.operator.expression' },
    ],
  },

  // ── More documented official-grammar bugs (graded honestly: wins, ties, and gaps) ──

  // `instanceof` followed by a bitwise/arithmetic/equality operator: the official grammar
  // mis-reads the right-hand operand as a TYPE name (entity.name.type) and the highlighting
  // derails — Monogram keeps it a value expression.
  {
    label: '#814: `a instanceof B & c` keeps the operand a value, not a type',
    input: 'if (a instanceof B & c) {}',
    checks: [
      { text: 'instanceof', scope: 'keyword.operator.expression' },
      { text: 'B', scope: 'variable.other' },   // official paints this entity.name.type
      { text: 'c', scope: 'variable.other' },
    ],
  },
  // `as const satisfies Foo`: the reported bug (the `satisfies` keyword not being colored) is
  // fixed in BOTH grammars now — a both-pass kept to document the resolved issue honestly.
  {
    label: '#956: `as const satisfies Foo` colors the satisfies keyword and the type',
    input: 'const x = { a: 1 } as const satisfies Foo;',
    checks: [
      { text: 'satisfies', scope: 'keyword' },
      { text: 'Foo', scope: 'entity.name.type' },
    ],
  },
  // `import type from "./type"` is a DEFAULT import whose binding is named `type` (tsc:
  // isTypeOnly=false, importClause.name=`type`) — so `type` should be a variable. Monogram's
  // PARSER already distinguishes it (the CFG admits `type` as the default binding), and the
  // DERIVED highlighter now scopes it variable.other too: gen-tm emits an `import-default-binding`
  // rule — the identifier directly after an import keyword that is immediately followed by the
  // module-source connector (or a `,`) is a bound name, exactly like a `const` binding. All three
  // ingredients are read from the grammar, not hardcoded: the import keyword(s) (scope
  // keyword.control.import*, placing a bare identifier after them), the `from` connector (scope
  // keyword.control.from), and the disambiguator (a default binding is FOLLOWED by the connector,
  // whereas the `type` MODIFIER in `import type X from` is followed by the clause identifier — so
  // `import type { A }` / `import type X` / `import type * as ns` keep `type` as the modifier).
  // The rule is gated on the language having a contextual (non-reserved) declaration keyword that
  // can stand in the binding slot — plain JS has none, so its grammar stays byte-identical. The
  // official hardcodes `import type` and STILL misses this (scopes `type`→keyword.control.type);
  // Monogram now gets it right (`type`→variable.other.readwrite).
  {
    label: '#950: default import named `type` — the binding is a variable, not the `type` keyword',
    input: `import type from "./type";`,
    checks: [
      { text: 'type', scope: 'variable.other' },
    ],
  },
  // TS 5.9 `import defer * as ns` (deferred-import, valid in tsc 5.9.3): the `defer` modifier should
  // be a keyword. The official grammar still misses it (its vocabulary has no `defer`, so it scopes
  // it variable.other.readwrite[.alias]). Monogram MODELS the deferred-import production in the CFG
  // (`['defer','*','as',Ident]` in ImportClause) and marks `defer` a keyword.control.import.phase —
  // and the agnostic generator scopes it as a keyword ONLY in phase-modifier position (immediately
  // before the namespace `*`, via the import-export-all pattern), so `defer` stays an ordinary
  // identifier everywhere else (`const defer = 1`, `defer()`, `import defer from "m"`). A Monogram win.
  {
    label: '#1058: `import defer` should scope `defer` as a keyword',
    input: `import defer * as ns from "x";`,
    checks: [
      { text: 'defer', scope: 'keyword' },
    ],
  },
  // Conditional type with an un-parenthesized `typeof` operand: the `? :` is a type ternary.
  // The derived grammar emits a `type-conditional` region (anchored on the `extends` connector,
  // mirroring the official's `#type-conditional`) so the `?`/`:` are scoped keyword.operator.ternary
  // like the expression ternary — the connector anchor keeps an OPTIONAL `?` (`{ a?: T }`) distinct.
  {
    label: '#907: `typeof x extends string ? 1 : 2` conditional-type ternary',
    input: 'type T = typeof x extends string ? 1 : 2;',
    checks: [
      { text: '?', scope: 'keyword.operator.ternary' },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════
// Multi-line tests
// ══════════════════════════════════════════════════════════════════

export const multiLineTests: MultiLineTest[] = [

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
  // #884's real repro declares `const x = 1;` first, so the `< x … >` run references a real
  // binding (the issue's point: `< x >` is mis-read as a type spec). Keep the declaration.
  {
    label: '#884: const x=1; 0\\n< x\\n&& 1 > 0 is comparison (not a type spec)',
    lines: [
      'const x = 1;',
      '0',
      '< x',
      '&& 1 > 0',
    ],
    checks: [
      { line: 0, text: 'const', scope: 'storage.type' },
      { line: 1, text: '0', scope: 'constant.numeric' },
      { line: 2, text: '<', scope: 'keyword.operator' },
      { line: 2, text: 'x', scope: 'variable.other' },
      { line: 3, text: '&&', scope: 'keyword.operator.logical' },
      { line: 3, text: '1', scope: 'constant.numeric' },
      { line: 3, text: '>', scope: 'keyword.operator' },
      { line: 3, text: '0', scope: 'constant.numeric' },
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
  // #890's real repro wraps the `<\n a\n >{…}` in a `foo(bar, …)` call inside method `A`, and the
  // reported victims are the string `"a string"` (not colored) and method `B`'s `return` (not
  // colored). Keep that wrapper + both victims so the test exercises the actual cascade.
  {
    label: '#890: multiline JSX/generic in a `foo(bar, …)` call doesn\'t break the string or next method',
    lines: [
      'class C {',
      '  A() {',
      '    return foo(bar, <',
      '      a',
      '    >{ v: "a string" });',
      '  }',
      '  B() {',
      '    return 101;',
      '  }',
      '}',
    ],
    checks: [
      { line: 1, text: 'A', scope: 'entity.name.function' },
      { line: 2, text: 'foo', scope: 'entity.name.function' },
      { line: 2, text: 'bar', scope: 'variable.other' },
      { line: 4, text: 'a string', scope: 'string.quoted.double' },  // reported victim: "string is not colored"
      { line: 6, text: 'B', scope: 'entity.name.function' },
      { line: 7, text: 'return', scope: 'keyword.control' },         // reported victim: "return keyword is not colored"
      { line: 7, text: '101', scope: 'constant.numeric' },
    ],
  },

  // ── Angle bracket: multiline new Map<> then broken method ──
  // #973's real repro puts the split `new Map<\n T1, T2>([])` inside a `readonly bar = { map: … }`
  // class field, with the victim being the following `private function()` method (its `return` is
  // the reported casualty). Keep that wrapper + victim. NOTE: the object-literal key in a class-field
  // initializer (`readonly bar = { map: … }`) is an expression position, so the constructor `Map` is
  // `entity.name.function` — consistent with the bare `new Map<…>` form (#1020 / #855). (It was briefly
  // `entity.name.type` only because field-object keys were mis-read as type annotations; that bug is fixed.)
  {
    label: '#973: split `new Map<…>([])` in a `readonly bar` field doesn\'t break the next method',
    lines: [
      'export class Foo {',
      '  readonly bar = {',
      '    map: new Map<',
      '      Type1, Type2>([])',
      '  };',
      '  private function() {',
      '    return 1;',
      '  }',
      '}',
    ],
    checks: [
      { line: 1, text: 'readonly', scope: 'storage.modifier' },
      { line: 2, text: 'new', scope: 'keyword.operator.expression' },
      { line: 2, text: 'Map', scope: 'entity.name.function' },
      { line: 3, text: 'Type1', scope: 'entity.name.type' },
      { line: 5, text: 'function', scope: 'entity.name.function' },  // victim method name survives
      { line: 6, text: 'return', scope: 'keyword.control' },         // reported victim: return not colored
      { line: 6, text: '1', scope: 'constant.numeric' },
    ],
  },

  // ── Angle bracket: multiline type assertion ──
  // #983's real repro destructures `const { id1, id2 } = <\n {…}\n >req.query;` and the reported
  // victim is the following `if (id1) { throw new Error(…) }` block ("highlighting breaks after
  // req.query"). Keep the binding + the real cascade victim (not a bare `if (true) {}` stand-in).
  {
    label: '#983: multiline `<{…}>req.query` type assertion then `if (id1){throw}` not broken',
    lines: [
      'const { id1, id2 } = <',
      '  {',
      '    id1: string;',
      '    id2: string;',
      '  }',
      '>req.query;',
      'if (id1) {',
      `  throw new Error('syntax highlighting broke');`,
      '}',
    ],
    checks: [
      { line: 2, text: 'string', scope: 'support.type.primitive' },
      { line: 3, text: 'string', scope: 'support.type.primitive' },
      { line: 5, text: 'req', scope: 'variable.other' },
      { line: 6, text: 'if', scope: 'keyword.control' },          // cascade victim: stays a control keyword
      { line: 7, text: 'throw', scope: 'keyword.control' },       // victim body survives
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
      // `null` in the RETURN TYPE union is a type-builtin (official: support.type.builtin),
      // not the value constant — only `return null` in the body is constant.language.null.
      { line: 1, text: 'null', scope: 'support.type.builtin' },
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

  // ── More documented official-grammar bugs (multi-line; graded honestly) ──

  // A generic arrow whose `(` parameter list is broken before the close `)`: the official
  // grammar swallows the rest of the FILE into a `cast.expr` type context (the `return` becomes
  // entity.name.type), exactly the reported "breaks highlighting for the rest of the file".
  {
    label: '#1048: `<T extends number>(a\\n) =>` does not derail the body',
    lines: [
      'const echo = <T extends number>(a',
      ') => {',
      '  return a;',
      '};',
    ],
    checks: [
      { line: 1, text: '=>', scope: 'storage.type.function.arrow' },
      { line: 2, text: 'return', scope: 'keyword.control.flow' },  // official: entity.name.type
    ],
  },

  // A lambda block inside an object literal inside parentheses in a `return`: the official
  // grammar mis-reads `({…})` as an object-binding-pattern parameter and every following
  // function (here `function two`) is swallowed as an object-literal key for the rest of the file.
  {
    label: '#988: nested lambda-in-object-in-parens does not break later functions',
    lines: [
      'function one() {',
      '  return (',
      '    {',
      '      toString: () => {',
      '        return "x";',
      '      }',
      '    }',
      '  );',
      '}',
      'function two() {',
      '  return "??";',
      '}',
    ],
    checks: [
      { line: 9, text: 'function', scope: 'storage.type.function' },
      { line: 9, text: 'two', scope: 'entity.name.function' },     // official: meta.object-literal.key
      { line: 10, text: 'return', scope: 'keyword.control.flow' },
    ],
  },

  // A `//` line comment terminating a union-type member: on the NEXT line the official grammar
  // drops the type-annotation context — the line-2 `|` becomes a bitwise operator — while the
  // derived grammar keeps the union pipe a type operator. (The README table's line-agnostic
  // substring matcher can't tell the two `|`s apart so it scores this a tie; the line-aware
  // self-test below locks the real win on the line-2 pipe.)
  {
    label: '#989: trailing `//` inside a multiline union keeps the next `|` a type operator',
    lines: [
      'let test:',
      '  | null //',
      '  | undefined;',
    ],
    checks: [
      { line: 0, text: 'let', scope: 'storage.type' },
      { line: 2, text: '|', scope: 'keyword.operator.type' },        // official: keyword.operator.bitwise
      // `undefined` in a type union is a type-builtin (official: support.type.builtin),
      // not the value constant — the line-2 check still proves the type context survives.
      { line: 2, text: 'undefined', scope: 'support.type.builtin' },
    ],
  },

  // A multi-line `new Map<…>` type-argument list containing an indexed-access type: the official
  // grammar loses the type context across the line breaks — `number`/`Array` become plain
  // variables and the `["events"]` is read as an array LITERAL. The derived grammar keeps it a type.
  {
    label: '#1064: multiline `new Map<…Array<DB.X["events"]>…>` stays a type',
    lines: [
      'const eventMap = new Map<',
      '  number,',
      '  Array<DB.Infertable["events"]>',
      '>();',
    ],
    checks: [
      { line: 1, text: 'number', scope: 'entity.name.type' },       // official: variable.other.readwrite
      { line: 2, text: 'Array', scope: 'entity.name.type' },
      { line: 3, text: '>', scope: 'punctuation.definition.typeparameters.end' },
    ],
  },

  // A `declare function` returning a multi-line union of object types: BOTH grammars mis-handle
  // the SECOND union member's properties (the reported inconsistency between the first `data`,
  // correctly a property, and the second `data`). An honest both-miss the derived grammar shares.
  {
    label: '#997: union of object types — both members’ props should be properties',
    monoGap: true,
    lines: [
      'declare function getCb():',
      '  | { data: string; cb: (arg: string) => void }',
      '  | { data: number; cb: (arg: number) => void }',
    ],
    checks: [
      { line: 1, text: 'data', scope: 'variable.object.property' },  // member 1: official ✓, mono ✗
      { line: 2, text: 'data', scope: 'variable.object.property' },  // member 2: both ✗
    ],
  },

  // #995's faithful `d`-form repro (moved here from the single-line cases, which only held the
  // easy `c` form the issue says "works fine"). A paren-wrapped object literal whose `(` and `{`
  // are on SEPARATE lines: the official then mis-tokenizes the inner `as keyof typeof` as
  // `variable.parameter` (the reported bug). The derived grammar keeps them operator keywords —
  // an only-Monogram win. (Not in the README single-line ledger, which grades only the `tests`
  // array; it joins the multi-line only-Monogram cohort that the self-test verifies.)
  {
    label: '#995: paren-wrapped object-literal `as keyof typeof` (the `d`-form) stays operator keywords',
    lines: [
      'const a = { a: "", b: "" }',
      'const d = (',
      '    {',
      '        key: a.a, label: a.b[a.a as keyof typeof a.b]',
      '    })',
    ],
    checks: [
      // the inner assertion operators on the object-literal property line — official: variable.parameter
      { line: 3, text: 'as', scope: 'keyword.operator.expression' },
      { line: 3, text: 'keyof', scope: 'keyword.operator.expression.keyof' },
      { line: 3, text: 'typeof', scope: 'keyword.operator.expression' },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════
// Run tests
// ══════════════════════════════════════════════════════════════════
