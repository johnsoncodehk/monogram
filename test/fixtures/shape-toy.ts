/**
 * SH2-0 toy grammar + formal ShapeSpec (ported from SH2a proto2).
 *
 * Coverage targets: overlapping RD (Bang 2-arm, Tagged 3-arm as ONE choice arm),
 * opt(seq), sep (zero + trailing), not, star(seq(rule,lit)), Pratt call LED.
 */
import {
  token, rule, defineGrammar, left, prefix, op,
  seq, oneOf, range, star, many, opt, sep, not,
} from '../../src/api.ts';
import type { ShapeSpec } from '../../src/shape-schema.ts';

const digit = range('0', '9');
const identStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const identPart = oneOf(identStart, digit);
const Ident = token(seq(identStart, star(identPart)), { identifier: true });
const Number_ = token(seq(digit, star(digit)), { scope: 'constant.numeric' });

const Atom = rule(() => [Number_, Ident]);

/** FIRST overlap: arm 0 must roll back after consuming one '!'. */
const Bang = rule(() => [
  ['!', Atom],
  ['!', '!', Atom],
]);

const Expr = rule(($) => [
  Number_,
  Ident,
  ['(', $, ')'],
  [prefix, $],
  [$, op, $],
  [$, '(', sep($, ','), ')'], // general Pratt LED (call)
]);

/** FIRST overlap on "tag"; single choice arm covers all three alts (multi-alt bug). */
const Tagged = rule(() => [
  ['tag', Ident, ':', Expr],
  ['tag', Ident, '=', Expr],
  ['tag', Ident],
]);

/** opt(non-rule seq) + zero-width not. */
const Guarded = rule(() => [
  ['guard', not('bad'), Ident, opt(':', Ident)],
]);

const Item = rule(() => [
  ['bang', Bang],
  Tagged,
  Guarded,
  ['args', '(', sep(Expr, ','), ')'],
  [Expr],
]);

const Program = rule(() => [many(Item, ';')]);

export const toyGrammar = defineGrammar({
  name: 'shape-toy',
  tokens: { Ident, Number: Number_ },
  prec: [left('+', '-'), left('*', '/'), left(prefix('-'))],
  rules: { Atom, Bang, Expr, Tagged, Guarded, Item, Program },
  entry: Program,
});

export default toyGrammar;

/** Formal ShapeSpec — Tagged is ONE arm with altIndices [0,1,2]. */
export const toyShape: ShapeSpec = {
  grammar: 'shape-toy',
  spans: 'none',
  unmapped: 'error',
  leaves: {
    $punct: { action: 'drop' },
    $keyword: { action: 'drop' },
    $operator: { action: 'drop' },
    Number: { action: 'leafValue', fn: 'number' },
    Ident: { action: 'leafValue', fn: 'ident' },
  },
  rules: {
    Atom: {
      kind: 'choice',
      arms: [
        {
          name: 'Number',
          altIndices: [0],
          shape: {
            kind: 'node',
            type: 'Number',
            fields: [{ name: 'value', bind: { at: 0 }, typeHint: 'number' }],
          },
        },
        {
          name: 'Identifier',
          altIndices: [1],
          shape: {
            kind: 'node',
            type: 'Identifier',
            fields: [{ name: 'name', bind: { at: 0 }, typeHint: 'string' }],
          },
        },
      ],
    },
    Bang: {
      kind: 'choice',
      arms: [
        {
          name: 'BangOne',
          altIndices: [0],
          shape: {
            kind: 'node',
            type: 'BangOne',
            fields: [{ name: 'arg', bind: { at: 0 }, typeHint: 'AtomShape' }],
          },
        },
        {
          name: 'BangTwo',
          altIndices: [1],
          shape: {
            kind: 'node',
            type: 'BangTwo',
            fields: [{ name: 'arg', bind: { at: 0 }, typeHint: 'AtomShape' }],
          },
        },
      ],
    },
    Expr: {
      kind: 'pratt',
      // Delegate to Atom choice so Number|Identifier nodes need no runtime custom.
      atom: { kind: 'rule', name: 'Atom' },
      group: { kind: 'inline' },
      prefix: {
        kind: 'node',
        type: 'UnaryExpression',
        fields: [
          { name: 'operator', bind: 'opText', typeHint: 'string' },
          { name: 'argument', bind: { at: 0 }, typeHint: 'ExprShape' },
        ],
      },
      binary: {
        kind: 'node',
        type: 'BinaryExpression',
        fields: [
          { name: 'left', bind: { at: 0 }, typeHint: 'ExprShape' },
          { name: 'operator', bind: 'opText', typeHint: 'string' },
          { name: 'right', bind: { at: 1 }, typeHint: 'ExprShape' },
        ],
      },
      led: {
        kind: 'node',
        type: 'CallExpression',
        fields: [
          { name: 'callee', bind: { at: 0 }, typeHint: 'ExprShape' },
          { name: 'arguments', bind: { from: 'list', of: 0 }, typeHint: 'ExprShape' },
        ],
      },
    },
    // Three node arms (FIRST-overlap + true backtrack). Multi-alt single custom arm
    // remains proven via shape-parity's taggedCustomShape emit (altPath witness).
    Tagged: {
      kind: 'choice',
      arms: [
        {
          name: 'ColonTag',
          altIndices: [0],
          shape: {
            kind: 'node',
            type: 'ColonTag',
            fields: [
              { name: 'name', bind: { at: 0 }, typeHint: 'string' },
              { name: 'value', bind: { at: 1 }, typeHint: 'ExprShape' },
            ],
          },
        },
        {
          name: 'EqualsTag',
          altIndices: [1],
          shape: {
            kind: 'node',
            type: 'EqualsTag',
            fields: [
              { name: 'name', bind: { at: 0 }, typeHint: 'string' },
              { name: 'value', bind: { at: 1 }, typeHint: 'ExprShape' },
            ],
          },
        },
        {
          name: 'BareTag',
          altIndices: [2],
          shape: {
            kind: 'node',
            type: 'BareTag',
            fields: [{ name: 'name', bind: { at: 0 }, typeHint: 'string' }],
          },
        },
      ],
    },
    Guarded: {
      kind: 'node',
      type: 'Guarded',
      fields: [
        { name: 'name', bind: { at: 0 }, typeHint: 'string' },
        { name: 'alias', bind: { from: 'opt', at: 1 }, optional: true, typeHint: 'string' },
      ],
    },
    Item: {
      kind: 'choice',
      arms: [
        { name: 'Bang', altIndices: [0], shape: { kind: 'inline' } },
        { name: 'Tagged', altIndices: [1], shape: { kind: 'inline' } },
        { name: 'Guarded', altIndices: [2], shape: { kind: 'inline' } },
        {
          name: 'Args',
          altIndices: [3],
          shape: {
            kind: 'node',
            type: 'Args',
            fields: [{ name: 'values', bind: { from: 'list', of: 0 }, typeHint: 'ExprShape' }],
          },
        },
        {
          name: 'ExprItem',
          altIndices: [4],
          shape: {
            kind: 'node',
            type: 'ExprItem',
            fields: [{ name: 'expression', bind: { at: 0 }, typeHint: 'ExprShape' }],
          },
        },
      ],
    },
    Program: {
      kind: 'node',
      type: 'Program',
      fields: [{ name: 'body', bind: { from: 'list', of: 0 }, typeHint: 'unknown' }],
    },
  },
};

export type ToyAstCustomCtx = {
  kids: readonly unknown[];
  altPath: readonly number[];
  src: string;
  off: number;
  end: number;
};

export type ToyAstCustoms = Record<string, (ctx: ToyAstCustomCtx) => unknown>;

const I = (name: string) => ({ type: 'Identifier', name });
const N = (value: number) => ({ type: 'Number', value });

/** Optional customs for override/witness tests (default toy shape needs none). */
export const toyCustoms: ToyAstCustoms = {
  atom: (ctx) => {
    const t = ctx.kids[0];
    if (typeof t === 'number') return N(t);
    if (typeof t === 'string') return I(t);
    return t;
  },
  Tagged: (ctx) => {
    const name = ctx.kids[0] as string;
    const value = ctx.kids[1];
    const forms = ['ColonTag', 'EqualsTag', 'BareTag'] as const;
    const type = forms[ctx.altPath[0]!]!;
    return value === undefined ? { type, name } : { type, name, value };
  },
};

/** Multi-alt single custom arm — used by shape-parity altPath witness emit. */
export const toyTaggedCustomShape: ShapeSpec = {
  ...toyShape,
  rules: {
    ...toyShape.rules,
    Tagged: {
      kind: 'choice',
      arms: [
        {
          name: 'Tagged',
          altIndices: [0, 1, 2],
          shape: {
            kind: 'custom',
            fn: 'Tagged',
            reason:
              'Three alts share FIRST "tag" and yield ColonTag|EqualsTag|BareTag; ' +
              'one arm must try alts sequentially and hand altPath to custom',
          },
        },
      ],
    },
  },
};

/** Proto2 golden (10), including custom-ctx row. */
export const toyGolden: { src: string; expect: unknown; customs?: ToyAstCustoms }[] = [
  { src: 'bang !x;', expect: { type: 'Program', body: [{ type: 'BangOne', arg: I('x') }] } },
  { src: 'bang !!7;', expect: { type: 'Program', body: [{ type: 'BangTwo', arg: N(7) }] } },
  {
    src: 'tag x:1+2;',
    expect: {
      type: 'Program',
      body: [{
        type: 'ColonTag', name: 'x',
        value: { type: 'BinaryExpression', left: N(1), operator: '+', right: N(2) },
      }],
    },
  },
  { src: 'tag y=3;', expect: { type: 'Program', body: [{ type: 'EqualsTag', name: 'y', value: N(3) }] } },
  { src: 'tag z;', expect: { type: 'Program', body: [{ type: 'BareTag', name: 'z' }] } },
  { src: 'guard ok:alias;', expect: { type: 'Program', body: [{ type: 'Guarded', name: 'ok', alias: 'alias' }] } },
  { src: 'guard fine;', expect: { type: 'Program', body: [{ type: 'Guarded', name: 'fine', alias: null }] } },
  { src: 'args(1,x,);', expect: { type: 'Program', body: [{ type: 'Args', values: [N(1), I('x')] }] } },
  {
    src: 'f(1,2+3);',
    expect: {
      type: 'Program',
      body: [{
        type: 'ExprItem',
        expression: {
          type: 'CallExpression',
          callee: I('f'),
          arguments: [N(1), { type: 'BinaryExpression', left: N(2), operator: '+', right: N(3) }],
        },
      }],
    },
  },
];

/** Seeded corpus: SH2-0 base + SH2-0b multi-stmt / nested-group / adv-112 (seed → 800). */
export function buildToyCorpus(seed = 0x5a2_2026): { src: string; source: string }[] {
  function rng32(s: number) {
    return () => {
      let t = (s += 0x6d2b79f5);
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rng = rng32(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)]!;
  const ids = ['a', 'b', 'x', 'foo', 'bar', 'good', 'ctx'];
  const nums = ['0', '1', '2', '7', '42'];
  function atom() { return rng() < .55 ? pick(ids) : pick(nums); }
  function expr(depth = 0): string {
    if (depth > 2 || rng() < .35) return atom();
    const r = rng();
    if (r < .18) return `-${expr(depth + 1)}`;
    if (r < .34) return `(${expr(depth + 1)})`;
    if (r < .56) return `${expr(depth + 1)}(${expr(depth + 1)},${rng() < .25 ? '' : expr(depth + 1)})`;
    return `${expr(depth + 1)}${pick(['+', '-', '*', '/'])}${expr(depth + 1)}`;
  }
  /** Nested grouping for choice-arm Expr tails. */
  function groupedExpr(depth = 1): string {
    let e = atom();
    for (let i = 0; i < depth; i++) e = `(${e})`;
    return e;
  }
  function validItem(): string {
    const r = rng();
    if (r < .18) return `bang ${rng() < .5 ? '!' : '!!'}${atom()}`;
    if (r < .40) {
      const nest = 1 + Math.floor(rng() * 4);
      const tail = pick([
        `:${expr()}`,
        `=${expr()}`,
        `:${groupedExpr(nest)}`,
        `=${groupedExpr(nest)}`,
        '',
      ]);
      return `tag ${pick(ids)}${tail}`;
    }
    if (r < .56) return `guard ${pick(ids)}${rng() < .5 ? `:${pick(ids)}` : ''}`;
    if (r < .72) {
      const n = Math.floor(rng() * 4);
      const values = Array.from({ length: n }, () => expr()).join(',');
      return `args(${values}${n && rng() < .25 ? ',' : ''})`;
    }
    return expr();
  }
  /** Always 2–5 statements (SH2-0b multi-stmt coverage). */
  function multiProgram(): string {
    const n = 2 + Math.floor(rng() * 4);
    return Array.from({ length: n }, () => validItem() + ';').join(rng() < .3 ? '\n' : ' ');
  }
  function validProgram(): string {
    const n = Math.floor(rng() * 5);
    return Array.from({ length: n }, () => validItem() + ';').join(rng() < .3 ? '\n' : ' ');
  }
  function invalidProgram(): string {
    return pick([
      'bang !!!x;', 'bang !;', 'tag ;', 'tag x:', 'tag x=;', 'guard bad;',
      'guard x:;', 'args(1,,2);', 'args(;', 'f(1,2;', '1+;', '(1+2;',
      'tag x', 'bang !!x', 'unknown unknown;', 'guard ;', 'args(1 2);',
    ]);
  }
  // Planner adversarial 112 cases (depth groups + fragment cross-product).
  const advCases: string[] = [];
  for (let d = 1; d <= 40; d += 3) {
    advCases.push('tag x' + '='.repeat(1) + '('.repeat(d) + '1' + ')'.repeat(d) + ';');
  }
  const frag = [
    'tag x:1;', 'tag y=2;', 'tag z;', 'bang!x;', 'bang x;', 'f(1,2,)( );', 'a:(-b);',
    'tag x:1', 'tag x=;', 'tag :1;', 'bang !;', 'f(,);', 'f(1,,2);', 'tag x:1;tag y=2;tag z;',
  ];
  for (const a of frag) for (const b of frag.slice(0, 7)) advCases.push(a + b);

  const anchors = [
    '', 'bang !x;', 'bang !!x;', 'bang !!!x;', 'tag x:1;', 'tag x=1;', 'tag x;',
    'tag x:;', 'tag x=;', 'guard bad;', 'guard good;', 'guard good:a;',
    'args();', 'args(1,);', 'args(1,2);', 'f();', 'f(1,);', 'f(1)(2);',
    '1+2*3;', '-x(1);', 'tag t:f(1,2); bang !!7;',
    // SH2-0b: choice-arm nested groups + multi-stmt
    'tag x=(1);', 'tag x=((1));', 'tag y=(((2)));', 'tag z:(3);', 'tag z:((a));',
    'tag x:1;tag y=2;', 'bang!x;tag z;', 'tag x=(1);tag y=2;tag z;',
    'tag a=(1);tag b=((2));tag c:(((3)));bang!x;guard ok;',
  ].map((src) => ({ src, source: 'boundary' }));

  const corpus = [
    ...anchors,
    ...advCases.map((src) => ({ src, source: 'adv-112' as const })),
  ];
  while (corpus.length < 560) corpus.push({ src: multiProgram(), source: 'multi-stmt' });
  while (corpus.length < 680) corpus.push({ src: validProgram(), source: 'random-valid' });
  while (corpus.length < 800) corpus.push({ src: invalidProgram(), source: 'random-invalid' });
  return corpus;
}
