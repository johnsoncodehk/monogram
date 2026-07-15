/**
 * SH3-4: Rust ShapeCustoms for typescript ESTree — mechanical translation of
 * test/fixtures/shape-typescript.ts customs (22 unique fns).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURATED_TS, CURATED_TS_INVALID } from '../emit-corpus.ts';

const _DIR = dirname(fileURLToPath(import.meta.url));
/** Rust source spliced before `pub fn parse_ast_with`. */
export const TYPESCRIPT_RUST_CUSTOMS = readFileSync(join(_DIR, 'shape-typescript-rust-customs.rs'), 'utf8');

export function injectTypescriptRustCustoms(emitSrc: string): string {
  return emitSrc.replace('pub fn parse_ast_with', TYPESCRIPT_RUST_CUSTOMS + '\npub fn parse_ast_with');
}

/** TypeScript acceptance corpus: curated + seeds + generated expansions ≥2000. */
export function buildTsCorpus(): { src: string; source: string }[] {
  function rng32(seed: number) {
    return () => {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rng = rng32(0x75_2026);
  const seeds = [
    ...CURATED_TS,
    ...CURATED_TS_INVALID,
    'const a: number = 1;', 'let s: string;', 'type Alias = { a: number; b?: string };',
    'type U = "a" | "b" | "c";', 'function gen2<T, U extends T>(x: T, y: U): T { return x; }',
    'x => x + 1;', 'a ? b : c;', 'a.b.c();', 'f(g(1, 2), 3);', 'a++; b--;',
    'typeof x; void 0;', 'new Foo(1, 2);', 'a ?? b; a?.b?.c;', 'class C { m() {} }',
    'const n = maybe!;', 'enum E { A, B }', 'interface I { x: number }',
  ];
  const pads = ['', ' ', '  ', '\n', ' \n ', '\t'];
  const out: { src: string; source: string }[] = seeds.map((src) => ({ src, source: 'seed' }));
  let i = 0;
  while (out.length < 2000) {
    const s = seeds[i % seeds.length]!;
    const pad = pads[Math.floor(rng() * pads.length)]!;
    out.push({ src: pad + s + pad, source: 'pad-variant' });
    i++;
  }
  return out;
}

export const TS_GOLDEN: { label: string; src: string; expect: unknown }[] = [
      { label: 'C1 estreeStmt expr', src: '1 + 2;', expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: { type: 'BinaryExpression', left: 1, operator: '+', right: 2 } }] } },
      { label: 'C1 estreeStmt decl', src: 'let x = 1;', expect: { type: 'Program', body: [{ type: 'VariableDeclaration', kind: 'let', declarations: [{ type: 'VariableDeclarator', id: 'x', typeAnnotation: null, init: 1 }] }] } },
      { label: 'C2 estreeDecl fn', src: 'function f() {}', expect: { type: 'Program', body: [{ type: 'FunctionDeclaration', async: false, generator: false, id: 'f', typeParameters: null, params: [], returnType: null, body: { type: 'BlockStatement', body: [] } }] } },
      { label: 'C3 estreeParenOrComma', src: '(1, 2);', expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: { type: 'SequenceExpression', expressions: [1, 2] } }] } },
      { label: 'C4 estreeExprLed call', src: 'a.b();', expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: { type: 'CallExpression', callee: { type: 'MemberExpression', object: { type: 'Identifier', name: 'a' }, property: { type: 'Identifier', name: 'b' }, computed: false, optional: false }, arguments: [] } }] } },
      { label: 'C5 estreeExprNudSeq', src: 'foo;', expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: { type: 'Identifier', name: 'foo' } }] } },
      { label: 'C6 estreeArrow', src: 'x => x + 1;', expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: { type: 'ArrowFunctionExpression', params: [{ type: 'Identifier', name: 'x' }], body: { type: 'BinaryExpression', left: { type: 'Identifier', name: 'x' }, operator: '+', right: 1 }, async: false, expression: true } }] } },
      { label: 'C7 tsTypeLed', src: 'type U = A<B>;', expect: { type: 'Program', body: [{ type: 'TSTypeAliasDeclaration', id: 'U', typeParameters: null, typeAnnotation: { type: 'TSTypeReference', typeName: { type: 'Type', children: ['A'], headText: 'A' }, typeParameters: [{ type: 'Type', children: ['B'], headText: 'B' }], meta: { op: '<' } } }] } },
      { label: 'C8 estreeNewTargetLed', src: 'new Foo.bar();', expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: { type: 'MemberExpression', object: 'Foo', property: { type: 'Identifier', name: 'bar' }, computed: false, optional: false } }] } },
      { label: 'C9 estreeArrayPattern', src: 'const [a, , b] = arr;', expect: { type: 'Program', body: [{ type: 'VariableDeclaration', kind: 'const', declarations: [{ type: 'VariableDeclarator', id: { type: 'ArrayPattern', elements: [{ type: 'AssignmentPatternOrId', id: 'a', init: null }, null, { type: 'AssignmentPatternOrId', id: 'b', init: null }] }, typeAnnotation: null, init: { type: 'Identifier', name: 'arr' } }] }] } },
      { label: 'C10 estreeBindingProperty', src: 'const { a, b: c } = obj;', expect: { type: 'Program', body: [{ type: 'VariableDeclaration', kind: 'const', declarations: [{ type: 'VariableDeclarator', id: { type: 'ObjectPattern', properties: [{ type: 'Property', key: { type: 'Identifier', name: 'a' }, value: { type: 'Identifier', name: 'a' }, kind: 'init', method: false, shorthand: true, computed: false }, { type: 'Property', key: { type: 'Identifier', name: 'b' }, value: { type: 'AssignmentPatternOrId', id: 'c', init: null }, kind: 'init', method: false, shorthand: false, computed: false }] }, typeAnnotation: null, init: { type: 'Identifier', name: 'obj' } }] }] } },
      { label: 'C11 estreeParam', src: 'function g(this: T) {}', expect: { type: 'Program', body: [{ type: 'FunctionDeclaration', async: false, generator: false, id: 'g', typeParameters: null, params: [{ type: 'Identifier', name: 'this', typeAnnotation: { type: 'Type', children: ['T'], headText: 'T' } }], returnType: null, body: { type: 'BlockStatement', body: [] } }] } },
      { label: 'C12 estreeForHead', src: 'for (x in y) z;', expect: { type: 'Program', body: [{ type: 'ForInStatement', left: { type: 'Identifier', name: 'x' }, right: { type: 'Identifier', name: 'y' }, body: { type: 'ExpressionStatement', expression: { type: 'Identifier', name: 'z' } } }] } },
      { label: 'C13 estreeSwitchCase fold', src: 'switch (1) { case 1: break; default: x; }', expect: { type: 'Program', body: [{ type: 'SwitchStatement', discriminant: 1, cases: [{ type: 'SwitchCase', test: 1, consequent: [{ type: 'BreakStatement', label: null }] }, { type: 'SwitchCase', test: null, consequent: [{ type: 'ExpressionStatement', expression: { type: 'Identifier', name: 'x' } }] }] }] } },
      { label: 'C13 multi-case fold', src: 'switch (x) { case 1: case 2: y; break; default: z; }', expect: { type: 'Program', body: [{ type: 'SwitchStatement', discriminant: { type: 'Identifier', name: 'x' }, cases: [{ type: 'SwitchCase', test: 1, consequent: [] }, { type: 'SwitchCase', test: 2, consequent: [{ type: 'ExpressionStatement', expression: { type: 'Identifier', name: 'y' } }, { type: 'BreakStatement', label: null }] }, { type: 'SwitchCase', test: null, consequent: [{ type: 'ExpressionStatement', expression: { type: 'Identifier', name: 'z' } }] }] }] } },
      { label: 'C14 estreeDecorator', src: '@Dec class C {}', expect: { type: 'Program', body: [{ type: 'ClassDeclaration', decorators: [{ type: 'Decorator', expression: { type: 'Identifier', name: 'Dec' } }], id: 'C', superClass: null, body: { type: 'ClassBody', body: [] } }] } },
      { label: 'C15 estreeClassMember body kids', src: 'class C { m() { 1; } }', expect: { type: 'Program', body: [{ type: 'ClassDeclaration', decorators: [], id: 'C', superClass: null, body: { type: 'ClassBody', body: [{ type: 'MethodDefinition', kind: 'method', key: { type: 'MemberName', children: ['m'], arm: 'passthrough', alt: 0 }, value: { type: 'FunctionExpression', params: [], body: { type: 'BlockStatement', body: [{ type: 'ExpressionStatement', expression: 1 }] }, async: false, generator: false }, static: false, computed: false }] } }] } },
      { label: 'C16 tsInterfaceMember', src: 'interface I { x: number; }', expect: { type: 'Program', body: [{ type: 'TSInterfaceDeclaration', id: 'I', typeParameters: null, extends: [], body: { type: 'TSInterfaceBody', body: [{ type: 'TSPropertySignature', key: { type: 'MemberName', children: ['x'], arm: 'passthrough', alt: 0 }, typeAnnotation: { type: 'Type', children: ['number'], headText: 'number' }, optional: false, readonly: false }] } }] } },
      { label: 'C17 tsTypeMember + object TSTypeLiteral', src: 'type T = { x: number };', expect: { type: 'Program', body: [{ type: 'TSTypeAliasDeclaration', id: 'T', typeParameters: null, typeAnnotation: { type: 'TSTypeLiteral', members: [{ type: 'TSPropertySignature', key: 'x', typeAnnotation: { type: 'Type', children: ['number'], headText: 'number' }, optional: false, readonly: false }] } }] } },
      { label: 'C18 estreeProp object', src: '({ a: 1, b });', expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: { type: 'SequenceExpression', expressions: [{ type: 'Property', key: { type: 'MemberName', children: ['a'], arm: 'passthrough', alt: 0 }, value: 1, kind: 'init', shorthand: false, computed: false, method: false }, { type: 'Property', key: { type: 'Identifier', name: 'b' }, value: null, kind: 'init', shorthand: false, computed: false, method: false }] } }] } },
      { label: 'new.target MetaProperty', src: 'new.target;', expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: { type: 'MetaProperty', meta: { type: 'Identifier', name: 'new' }, property: { type: 'Identifier', name: 'target' } } }] } },
      // SH2-4d TemplateLiteral quasis/expressions (hole = enclosing Pratt, not global Type)
      {
        label: 'SH2-4d plain template with subst',
        src: '`a${b}c`;',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'TemplateLiteral',
              quasis: [
                { type: 'TemplateElement', value: { raw: 'a' }, tail: false },
                { type: 'TemplateElement', value: { raw: 'c' }, tail: true },
              ],
              expressions: [{ type: 'Identifier', name: 'b' }],
            },
          }],
        },
      },
      {
        label: 'SH2-4d nested template',
        src: '`a${`b${c}`}d`;',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'TemplateLiteral',
              quasis: [
                { type: 'TemplateElement', value: { raw: 'a' }, tail: false },
                { type: 'TemplateElement', value: { raw: 'd' }, tail: true },
              ],
              expressions: [{
                type: 'TemplateLiteral',
                quasis: [
                  { type: 'TemplateElement', value: { raw: 'b' }, tail: false },
                  { type: 'TemplateElement', value: { raw: '' }, tail: true },
                ],
                expressions: [{ type: 'Identifier', name: 'c' }],
              }],
            },
          }],
        },
      },
      {
        label: 'SH2-4d tagged nested template',
        src: 'tag`a${b}${`c${d}`}e`;',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'TaggedTemplateExpression',
              tag: { type: 'Identifier', name: 'tag' },
              quasi: {
                type: 'TemplateLiteral',
                quasis: [
                  { type: 'TemplateElement', value: { raw: 'a' }, tail: false },
                  { type: 'TemplateElement', value: { raw: '' }, tail: false },
                  { type: 'TemplateElement', value: { raw: 'e' }, tail: true },
                ],
                expressions: [
                  { type: 'Identifier', name: 'b' },
                  {
                    type: 'TemplateLiteral',
                    quasis: [
                      { type: 'TemplateElement', value: { raw: 'c' }, tail: false },
                      { type: 'TemplateElement', value: { raw: '' }, tail: true },
                    ],
                    expressions: [{ type: 'Identifier', name: 'd' }],
                  },
                ],
              },
            },
          }],
        },
      },
      {
        label: 'tagged template with substitution',
        src: 'tag`a${b}`;',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'TaggedTemplateExpression',
              tag: { type: 'Identifier', name: 'tag' },
              quasi: {
                type: 'TemplateLiteral',
                quasis: [
                  { type: 'TemplateElement', value: { raw: 'a' }, tail: false },
                  { type: 'TemplateElement', value: { raw: '' }, tail: true },
                ],
                expressions: [{ type: 'Identifier', name: 'b' }],
              },
            },
          }],
        },
      },
      { label: 'C1 if stmt', src: 'if (a) b(); else c();', expect: { type: 'Program', body: [{ type: 'IfStatement', test: { type: 'Identifier', name: 'a' }, consequent: { type: 'ExpressionStatement', expression: { type: 'CallExpression', callee: { type: 'Identifier', name: 'b' }, arguments: [] } }, alternate: { type: 'ExpressionStatement', expression: { type: 'CallExpression', callee: { type: 'Identifier', name: 'c' }, arguments: [] } } }] } },
      // SH2-3b LED / binary family goldens
      {
        label: 'LED nested ternary right-assoc',
        src: 'x = a ? b : c ? d : e;',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'AssignmentExpression',
              left: { type: 'Identifier', name: 'x' },
              operator: '=',
              right: {
                type: 'ConditionalExpression',
                test: { type: 'Identifier', name: 'a' },
                consequent: { type: 'Identifier', name: 'b' },
                alternate: {
                  type: 'ConditionalExpression',
                  test: { type: 'Identifier', name: 'c' },
                  consequent: { type: 'Identifier', name: 'd' },
                  alternate: { type: 'Identifier', name: 'e' },
                },
              },
            },
          }],
        },
      },
      {
        label: 'binary assignment =',
        src: 'a = b;',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'AssignmentExpression',
              left: { type: 'Identifier', name: 'a' },
              operator: '=',
              right: { type: 'Identifier', name: 'b' },
            },
          }],
        },
      },
      {
        label: 'binary compound +=',
        src: 'a += b;',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'AssignmentExpression',
              left: { type: 'Identifier', name: 'a' },
              operator: '+=',
              right: { type: 'Identifier', name: 'b' },
            },
          }],
        },
      },
      {
        label: 'binary logical ??',
        src: 'a ?? b;',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'LogicalExpression',
              left: { type: 'Identifier', name: 'a' },
              operator: '??',
              right: { type: 'Identifier', name: 'b' },
            },
          }],
        },
      },
      {
        label: 'LED as → TSAsExpression',
        src: 'a as T;',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'TSAsExpression',
              expression: { type: 'Identifier', name: 'a' },
              typeAnnotation: { type: 'Type', children: ['T'], headText: 'T' },
            },
          }],
        },
      },
      {
        label: 'LED instanceof',
        src: 'a instanceof b;',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'BinaryExpression',
              left: { type: 'Identifier', name: 'a' },
              operator: 'instanceof',
              right: { type: 'Identifier', name: 'b' },
            },
          }],
        },
      },
      {
        label: 'LED in',
        src: 'a in b;',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'BinaryExpression',
              left: { type: 'Identifier', name: 'a' },
              operator: 'in',
              right: { type: 'Identifier', name: 'b' },
            },
          }],
        },
      },
      {
        label: 'LED satisfies → TSSatisfiesExpression',
        src: 'a satisfies T;',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'TSSatisfiesExpression',
              expression: { type: 'Identifier', name: 'a' },
              typeAnnotation: { type: 'Type', children: ['T'], headText: 'T' },
            },
          }],
        },
      },
      {
        label: 'LED optional call a?.()',
        src: 'a?.();',
        expect: {
          type: 'Program',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'CallExpression',
              callee: { type: 'Identifier', name: 'a' },
              arguments: [],
              optional: true,
            },
          }],
        },
      },
    ];
export const FAIL_LOUD_RD_FNS = [
  'estreeStmt', 'estreeDecl', 'estreeParenOrComma', 'estreeExprLed',
  'estreeExprNudSeq', 'estreeArrow', 'tsTypeLed', 'estreeNewTargetLed',
  'estreeArrayPattern', 'estreeBindingProperty', 'estreeParam', 'estreeForHead',
  'estreeSwitchCase', 'estreeDecorator', 'estreeClassMember',
  'tsInterfaceMember', 'tsTypeMember', 'estreeProp',
] as const;

export const FAIL_LOUD_PRATT_FNS = [
  'estreeExprBinary', 'estreeExprPrefix', 'estreeExprPostfixTok', 'estreeTemplateLiteral',
] as const;

export const TYPESCRIPT_CUSTOM_FN_COUNT = 22;
