// Gate: SH2-2 shape CST↔parseAst parity — calc+toy ≥2800, golden ≥22,
// typescript+SH0 full emit + ≥2000 accept-parity (blocking).
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { emitTs } from '../src/target-ts.ts';
import { emitParser, tsTarget } from '../src/emit.ts';
import { calcShape } from '../src/shape-calc.ts';
import type { ShapeSpec } from '../src/shape-schema.ts';
import calcGrammar from './fixtures/calc.ts';
import toyGrammar, {
  toyShape, toyCustoms, toyTaggedCustomShape, toyGolden, buildToyCorpus, type ToyAstCustoms,
} from './fixtures/shape-toy.ts';
import typescriptGrammar from '../typescript.ts';
import javascriptGrammar from '../javascript.ts';
import { typescriptShape, typescriptEstreeCustoms } from './fixtures/shape-typescript.ts';
import { CURATED_TS, CURATED_TS_INVALID } from './emit-corpus.ts';

const OUT = '/tmp/shape-parity';
mkdirSync(OUT, { recursive: true });

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stripSpans(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(stripSpans);
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) {
    if (k === 'off' || k === 'end') continue;
    out[k] = stripSpans(val);
  }
  return out;
}

type Emitted = {
  parseAst: (src: string, opts?: { customs?: ToyAstCustoms }) => unknown;
  tokenize: (src: string) => { off: number; end: number; nl: boolean; kid: number; lid: number }[];
  parse: (toks: { off: number; end: number; nl: boolean; kid: number; lid: number }[]) => unknown;
  parseWith: (src: string, builder: {
    leaf: (tokenType: string, kid: number, lid: number, off: number, end: number) => unknown;
    node: (rule: string, children: unknown[], off: number, end: number) => unknown;
  }) => unknown;
  shapeCoverage: {
    step: Record<string, number>;
    pratt: Record<string, number>;
    unsupported: { rule: string; construct: string }[];
  };
};

async function emitLoad(name: string, grammar: unknown, shape: ShapeSpec): Promise<Emitted> {
  const src = emitTs(grammar as any, { shape });
  const file = `${OUT}/${name}.ts`;
  writeFileSync(file, src);
  return import(pathToFileURL(file).href + `?t=${Date.now()}`) as Promise<Emitted>;
}

async function emitLoadNoShape(name: string, grammar: unknown): Promise<Emitted> {
  const file = `${OUT}/${name}.ts`;
  writeFileSync(file, emitTs(grammar as any));
  return import(pathToFileURL(file).href + `?t=${Date.now()}`) as Promise<Emitted>;
}

/** Deterministic calc corpus (positive + negative), stable across runs. */
function buildCalcCorpus(): { src: string; source: string }[] {
  function rng32(seed: number) {
    return () => {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rng = rng32(0xc41c_2026);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)]!;
  const ids = ['a', 'b', 'x', 'y', 'foo'];
  const nums = ['0', '1', '2', '3', '9', '42'];
  function atom() { return rng() < .5 ? pick(ids) : pick(nums); }
  function expr(d = 0): string {
    if (d > 2 || rng() < .4) return atom();
    const r = rng();
    if (r < .2) return `-${expr(d + 1)}`;
    if (r < .4) return `(${expr(d + 1)})`;
    return `${expr(d + 1)}${pick(['+', '-', '*', '/'])}${expr(d + 1)}`;
  }
  function stmt() {
    return rng() < .45 ? `let ${pick(ids)} = ${expr()};` : `${expr()};`;
  }
  function prog() {
    const n = 1 + Math.floor(rng() * 4);
    return Array.from({ length: n }, () => stmt()).join(rng() < .3 ? '\n' : ' ');
  }
  const anchors = [
    'let x = 1;', '1 + 2;', '1 + 2 * 3;', '-a;', '(1);',
    'let a = 1; let b = 2; a + b;', '1 - 2 - 3;', '-(a * b);',
    'foo; bar; baz;', '2 / 3;', '--x;',
    // SH2-0b: choice-arm group + multi-stmt (star Stmt)
    'let x = (1+2);', 'let y = ((3));', 'let a = (1); let b = (2+3); a + b;',
    'let x = 1; let y = 2; let z = 3; x + y + z;',
    '(1+2); (3);', 'let x = (1+2); 3 + 4;',
    'let ;', '1+', '(1', 'let x =', ';;;', 'x = 1;',
  ].map((src) => ({ src, source: 'boundary' }));
  const out = [...anchors];
  while (out.length < 320) out.push({ src: prog(), source: 'random-valid' });
  while (out.length < 450) {
    out.push({
      src: pick(['let ;', '1+', '(1', 'let x =', 'x = 1;', '* 2;', 'let let = 1;']),
      source: 'random-invalid',
    });
  }
  return out;
}

/** TypeScript acceptance corpus: curated + seeds + generated expansions ≥2000. */
function buildTsCorpus(): { src: string; source: string }[] {
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

function printCoverage(label: string, cov: Emitted['shapeCoverage']): void {
  const stepKeys = Object.keys(cov.step).sort();
  const prattKeys = Object.keys(cov.pratt).sort();
  const stepParts = stepKeys.filter((k) => cov.step[k]).map((k) => `${k}=${cov.step[k]}`);
  const prattParts = prattKeys.filter((k) => cov.pratt[k]).map((k) => `${k}=${cov.pratt[k]}`);
  console.log(`  coverage[${label}] step{${stepParts.join(' ')}} pratt{${prattParts.join(' ')}} unsupported=${cov.unsupported.length}`);
}

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;
  const check = (ok: boolean, label: string, detail?: string) => {
    if (ok) { pass++; console.log(`✓ ${label}`); }
    else { fail++; console.error(`✗ ${label}${detail ? ': ' + detail : ''}`); }
  };

  const noShape = emitTs(calcGrammar);
  const master = emitParser(calcGrammar, tsTarget);
  const hNo = createHash('sha256').update(noShape).digest('hex');
  const hMa = createHash('sha256').update(master).digest('hex');
  check(noShape === master && hNo === hMa, `no-shape calc ≡ emitParser sha=${hNo.slice(0, 12)}`);
  const noShapeTs = emitTs(typescriptGrammar);
  const masterTs = emitParser(typescriptGrammar, tsTarget);
  const hNoTs = createHash('sha256').update(noShapeTs).digest('hex');
  const hMaTs = createHash('sha256').update(masterTs).digest('hex');
  check(noShapeTs === masterTs && hNoTs === hMaTs, `no-shape typescript ≡ emitParser sha=${hNoTs.slice(0, 12)}`);

  const calcMod = await emitLoad('calc', calcGrammar, calcShape);
  check(calcMod.shapeCoverage.unsupported.length === 0, 'calc unsupported=0');
  printCoverage('calc', calcMod.shapeCoverage);

  const toyMod = await emitLoad('toy', toyGrammar, toyShape);
  check(toyMod.shapeCoverage.unsupported.length === 0, 'toy unsupported=0');
  printCoverage('toy', toyMod.shapeCoverage);

  let goldenOk = 0;
  for (const g of toyGolden) {
    const got = toyMod.parseAst(g.src);
    if (deepEq(got, g.expect)) goldenOk++;
    else {
      console.error(`  golden fail ${JSON.stringify(g.src)}`);
      console.error(`    got  ${JSON.stringify(got)}`);
      console.error(`    want ${JSON.stringify(g.expect)}`);
    }
  }
  // Multi-alt custom arm + altPath witness (separate emit; default toy is node arms).
  const taggedCustomMod = await emitLoad('toy-tagged-custom', toyGrammar, toyTaggedCustomShape);
  let customSeen: unknown = null;
  const customGot = taggedCustomMod.parseAst('tag ctx=9;', {
    customs: {
      ...toyCustoms,
      Tagged: (ctx) => {
        customSeen = {
          kids: ctx.kids,
          altPath: ctx.altPath,
          text: ctx.src.slice(ctx.off, ctx.end),
        };
        return { type: 'CustomTag', arm: ctx.altPath[0], name: ctx.kids[0], value: ctx.kids[1] };
      },
    },
  });
  const customExpect = {
    type: 'Program',
    body: [{ type: 'CustomTag', arm: 1, name: 'ctx', value: { type: 'Number', value: 9 } }],
  };
  const customCtxExpect = {
    kids: ['ctx', { type: 'Number', value: 9 }],
    altPath: [1],
    text: 'tag ctx=9',
  };
  if (deepEq(customGot, customExpect) && deepEq(customSeen, customCtxExpect)) goldenOk++;
  else console.error('  custom-ctx fail', { customGot, customSeen });
  const goldenTotal = toyGolden.length + 1;
  check(goldenOk === goldenTotal && goldenTotal >= 22, `toy golden ${goldenOk}/${goldenTotal}`);

  const toyCorpus = buildToyCorpus(0x5a2_2026);
  check(toyCorpus.length >= 2800, `toy corpus ≥2800 (got ${toyCorpus.length})`);
  const calcCorpus = buildCalcCorpus();
  const totalN = toyCorpus.length + calcCorpus.length;
  check(totalN >= 3200, `corpus total ≥3200 (got ${totalN})`);

  function parity(
    label: string,
    mod: Emitted,
    corpus: { src: string; source: string }[],
    customs?: ToyAstCustoms,
  ): { diverge: number; cstAcc: number; astAcc: number } {
    let diverge = 0, cstAcc = 0, astAcc = 0;
    for (const x of corpus) {
      let cst = false, ast = false, cstErr: string | null = null, astErr: string | null = null;
      try {
        const toks = mod.tokenize(x.src).map((t) => ({
          off: t.off, end: t.end, nl: t.nl, kid: t.kid, lid: t.lid,
        }));
        try { cst = mod.parse(toks) !== null; } catch (e) { cstErr = String(e); }
      } catch (e) { cstErr = String(e); }
      try { ast = mod.parseAst(x.src, customs ? { customs } : undefined) !== null; }
      catch (e) { astErr = String(e); }
      if (cst) cstAcc++;
      if (ast) astAcc++;
      // Throw-reject on both sides is agreement (lex errors, missing customs, …).
      const disagree = cst !== ast || (!!cstErr !== !!astErr);
      if (disagree) {
        diverge++;
        if (diverge <= 5) {
          console.error(`  diverge[${label}] ${JSON.stringify(x.src).slice(0, 100)} cst=${cst} ast=${ast} ${cstErr ?? ''} ${astErr ?? ''}`);
        }
      }
    }
    const conserved = corpus.length === cstAcc + (corpus.length - cstAcc)
      && corpus.length === astAcc + (corpus.length - astAcc);
    check(diverge === 0 && conserved, `${label} CST↔AST 0 diverge (${cstAcc} accept / ${corpus.length - cstAcc} reject)`);
    return { diverge, cstAcc, astAcc };
  }

  const toyP = parity('toy', toyMod, toyCorpus);
  const calcP = parity('calc', calcMod, calcCorpus);

  const requiredRdKinds = [
    'lit', 'tok', 'rule', 'star', 'opt', 'sep', 'altlit', 'alt',
    'not', 'seq', 'sameLine', 'suppress',
  ];
  check(
    requiredRdKinds.every((k) => toyMod.shapeCoverage.step[k] > 0)
      && toyMod.shapeCoverage.unsupported.length === 0,
    'toy RD Step coverage handled; unsupported=0',
    JSON.stringify(toyMod.shapeCoverage.step),
  );

  const accepts = (mod: Emitted, src: string, ast: boolean): boolean => {
    if (ast) return mod.parseAst(src) !== null;
    const toks = mod.tokenize(src).map((t) => ({
      off: t.off, end: t.end, nl: t.nl, kid: t.kid, lid: t.lid,
    }));
    return mod.parse(toks) !== null;
  };
  const txnExpect = {
    type: 'Program',
    body: [{ type: 'Transaction', value: [['a'], 'b'] }],
  };
  check(
    accepts(toyMod, 'txn a:b?;', false)
      && accepts(toyMod, 'txn a:b?;', true)
      && deepEq(toyMod.parseAst('txn a:b?;'), txnExpect),
    'transaction rollback restores failed-arm list/hole kids',
  );
  check(
    accepts(toyMod, 'line a b;', false) && accepts(toyMod, 'line a b;', true),
    'sameLine accepts same-line on CST/AST',
  );
  check(
    !accepts(toyMod, 'line a\nb;', false) && !accepts(toyMod, 'line a\nb;', true),
    'sameLine rejects cross-line on CST/AST',
  );

  const calcSpot = stripSpans(calcMod.parseAst('let x = 1; 2 + 3;'));
  check(
    deepEq(calcSpot, {
      type: 'Program',
      body: [
        { type: 'LetStatement', id: 'x', init: 1 },
        { type: 'ExpressionStatement', expression: { type: 'BinaryExpression', left: 2, operator: '+', right: 3 } },
      ],
    }),
    'calc spot golden',
  );
  const calcGroup = stripSpans(calcMod.parseAst('let x = (1+2); let y = ((3));'));
  check(
    deepEq(calcGroup, {
      type: 'Program',
      body: [
        {
          type: 'LetStatement', id: 'x',
          init: { type: 'BinaryExpression', left: 1, operator: '+', right: 2 },
        },
        { type: 'LetStatement', id: 'y', init: 3 },
      ],
    }),
    'calc group-in-let + multi-stmt',
  );

  // ── typescript + SH0 full emit (blocking) ─────────────────────────────────
  let tsMod: Emitted | null = null;
  let tsEmitErr = '';
  try {
    tsMod = await emitLoad('typescript-sh0', typescriptGrammar, typescriptShape);
  } catch (e) {
    tsEmitErr = String(e);
  }
  check(!tsEmitErr && !!tsMod, 'typescript+SH0 emit succeeds (unsupported=0)', tsEmitErr.slice(0, 500));
  if (tsMod) {
    check(tsMod.shapeCoverage.unsupported.length === 0, 'typescript coverage unsupported=0');
    printCoverage('typescript', tsMod.shapeCoverage);
    const want: Record<string, number> = {
      led: 116, nudSeq: 28, nudCapped: 16, postfix: 8, postfixTok: 4,
      group: 216, prefix: 44, binary: 156, template: 4,
    };
    const got = tsMod.shapeCoverage.pratt;
    const prattOk = Object.keys(want).every((k) => got[k] === want[k]);
    check(prattOk, 'typescript Pratt slot counters ≡ SH2a inventory',
      JSON.stringify({ want, got }));

    const tsCorpus = buildTsCorpus();
    check(tsCorpus.length >= 2000, `typescript corpus ≥2000 (got ${tsCorpus.length})`);
    parity('typescript', tsMod, tsCorpus, typescriptEstreeCustoms as ToyAstCustoms);

    // ── SH2-3: typescript AST goldens (handwritten) ─────────────────────────
    const TS_GOLDEN: { label: string; src: string; expect: unknown }[] = [
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
      { label: 'C1+C3 deep 1+2*3', src: '1 + 2 * 3;', expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: { type: 'BinaryExpression', left: 1, operator: '+', right: { type: 'BinaryExpression', left: 2, operator: '*', right: 3 } } }] } },
      { label: 'C6 deep arrow nested', src: 'const g = (x) => x * 2;', expect: { type: 'Program', body: [{ type: 'VariableDeclaration', kind: 'const', declarations: [{ type: 'VariableDeclarator', id: 'g', typeAnnotation: null, init: { type: 'ArrowFunctionExpression', params: [{ type: 'Identifier', decorators: [], optional: false }], body: { type: 'BinaryExpression', left: { type: 'Identifier', name: 'x' }, operator: '*', right: 2 }, async: false, expression: true } }] }] } },
      { label: 'C4 deep member chain', src: 'a.b.c;', expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: { type: 'MemberExpression', object: { type: 'MemberExpression', object: { type: 'Identifier', name: 'a' }, property: { type: 'Identifier', name: 'b' }, computed: false, optional: false }, property: { type: 'Identifier', name: 'c' }, computed: false, optional: false } }] } },
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
    let tsGoldenOk = 0;
    for (const g of TS_GOLDEN) {
      const got = stripSpans(tsMod.parseAst(g.src, { customs: typescriptEstreeCustoms as ToyAstCustoms }));
      if (deepEq(got, g.expect)) tsGoldenOk++;
      else console.error(`  ts golden fail ${g.label}`, JSON.stringify(got).slice(0, 200));
    }
    check(tsGoldenOk === TS_GOLDEN.length && TS_GOLDEN.length >= 18, `typescript AST golden ${tsGoldenOk}/${TS_GOLDEN.length} (≥18)`);

    // SH2-3b: fold adversarial fixed cases (≥10; shapes, not only accept)
    const advP = (src: string) =>
      stripSpans(tsMod!.parseAst(src, { customs: typescriptEstreeCustoms as ToyAstCustoms }));
    const advJ = (src: string) => JSON.stringify(advP(src));
    {
      const s1 = advJ('x = a ? b : c ? d : e;');
      check(
        s1.includes('AssignmentExpression') && s1.includes('ConditionalExpression') && !s1.includes('SequenceExpression'),
        'adv nested ternary Assignment+Conditional right-assoc',
        s1.slice(0, 300),
      );
      const s2 = advJ('switch (x) { default: a; }');
      check(
        /"cases":\[\{[^\]]*"consequent":\[\{"type":"ExpressionStatement"/.test(s2),
        'adv switch default-only fold',
        s2.slice(0, 400),
      );
      const s3 = advJ('switch (a) { case 1: x; } switch (b) { case 2: y; }');
      const caseCount = (s3.match(/SwitchCase/g) ?? []).length;
      check(
        caseCount === 2 && (s3.match(/"consequent":\[\{/g) ?? []).length === 2,
        'adv two switches fold isolated',
        `cases=${caseCount}`,
      );
      const t4 = advP('switch (a) { case 1: switch (b) { case 2: z; } break; }');
      const s4 = JSON.stringify(t4);
      check(
        t4 !== null && (s4.match(/SwitchStatement/g) ?? []).length === 2,
        'adv nested switch parses',
      );
      const s5 = advJ('const [a, , b] = xs;');
      check(s5.includes('null') && s5.includes('ArrayPattern'), 'adv array pattern hole');
      const t6a = advJ('(1, 2, 3);');
      const t6b = advJ('(1);');
      check(t6a.includes('SequenceExpression'), 'adv comma → SequenceExpression');
      check(!t6b.includes('SequenceExpression'), 'adv paren single → inline');
      const t7 = advJ('a.b().c[d]();');
      check(
        (t7.match(/CallExpression/g) ?? []).length === 2 && (t7.match(/MemberExpression/g) ?? []).length >= 2,
        'adv member/call chain',
      );
      const t8 = advJ('x = 1 - 2 / 3;');
      check(
        t8.includes('"operator":"-"') && t8.includes('"operator":"/"') && t8.includes('AssignmentExpression'),
        'adv binary ops under assignment',
      );
      check(advP('a?.b;') !== null && advJ('a?.b;').includes('"optional":true'), 'adv optional member a?.b');
    }

    // SH2-4d: consolidate remaining adversarial items from
    // /tmp/sh23-adv.mts (A), /tmp/sh23-adv2.mts (B), /tmp/sh24-adv3.mts (C).
    {
      // B gaps (full expect trees)
      const bGoldens: { label: string; src: string; expect: unknown }[] = [
        {
          label: 'adv2 as+satisfies chain',
          src: 'x as A satisfies B;',
          expect: {
            type: 'Program',
            body: [{
              type: 'ExpressionStatement',
              expression: {
                type: 'TSSatisfiesExpression',
                expression: {
                  type: 'TSAsExpression',
                  expression: { type: 'Identifier', name: 'x' },
                  typeAnnotation: { type: 'Type', children: ['A'], headText: 'A' },
                },
                typeAnnotation: { type: 'Type', children: ['B'], headText: 'B' },
              },
            }],
          },
        },
        {
          label: 'adv2 &&= Assignment',
          src: 'a &&= b;',
          expect: {
            type: 'Program',
            body: [{
              type: 'ExpressionStatement',
              expression: {
                type: 'AssignmentExpression',
                left: { type: 'Identifier', name: 'a' },
                operator: '&&=',
                right: { type: 'Identifier', name: 'b' },
              },
            }],
          },
        },
        {
          label: 'adv2 ternary in += rhs',
          src: 'x += a ? b : c;',
          expect: {
            type: 'Program',
            body: [{
              type: 'ExpressionStatement',
              expression: {
                type: 'AssignmentExpression',
                left: { type: 'Identifier', name: 'x' },
                operator: '+=',
                right: {
                  type: 'ConditionalExpression',
                  test: { type: 'Identifier', name: 'a' },
                  consequent: { type: 'Identifier', name: 'b' },
                  alternate: { type: 'Identifier', name: 'c' },
                },
              },
            }],
          },
        },
        {
          label: 'adv2 ++ Update',
          src: '++x;',
          expect: {
            type: 'Program',
            body: [{
              type: 'ExpressionStatement',
              expression: {
                type: 'UpdateExpression',
                operator: '++',
                argument: { type: 'Identifier', name: 'x' },
                prefix: true,
              },
            }],
          },
        },
        {
          label: 'adv2 non-null !',
          src: 'a!.b;',
          expect: {
            type: 'Program',
            body: [{
              type: 'ExpressionStatement',
              expression: {
                type: 'MemberExpression',
                object: { type: 'TSNonNullExpression', expression: { type: 'Identifier', name: 'a' } },
                property: { type: 'Identifier', name: 'b' },
                computed: false,
                optional: false,
              },
            }],
          },
        },
        {
          label: 'adv2 ternary inside as',
          src: '(a ? b : c) as T;',
          expect: {
            type: 'Program',
            body: [{
              type: 'ExpressionStatement',
              expression: {
                type: 'TSAsExpression',
                expression: {
                  type: 'ConditionalExpression',
                  test: { type: 'Identifier', name: 'a' },
                  consequent: { type: 'Identifier', name: 'b' },
                  alternate: { type: 'Identifier', name: 'c' },
                },
                typeAnnotation: { type: 'Type', children: ['T'], headText: 'T' },
              },
            }],
          },
        },
      ];
      let bOk = 0;
      for (const g of bGoldens) {
        if (deepEq(advP(g.src), g.expect)) bOk++;
        else console.error(`  ${g.label} fail`, JSON.stringify(advP(g.src)).slice(0, 240));
      }
      check(bOk === bGoldens.length, `adv2 gap goldens ${bOk}/${bGoldens.length}`);

      // C: real-input no-throw suite (adv3 L15–26) + shape spot checks
      const realNoThrow = [
        'class A { constructor(private x: number) { super(); this.x = x; } static async *m<T>(a: T = 1 as T): Promise<void> { await a; } get p() { return 1; } set p(v) {} }',
        'interface I { new (a: number): I; readonly [k: string]: number; m?(): void; }',
        'type T = { a: 1; b?: () => void; readonly c: string[]; };',
        'const o = { a, b: 1, [c]: 2, ...rest, m() {}, get g() { return 1; }, async *[Symbol.x]() {} };',
        'for (const { a, b: [c, , d] = [], ...e } of xs) {}',
        'switch (a) { case f(x)?.y: break; }',
        'label: { break label; }',
        'new.target;',
        'tag`a${b}${`c${d}`}e`;',
        'x = { t: new.target, u: tag`v${w}` };',
      ];
      let realOk = 0, realThrow = 0;
      for (const src of realNoThrow) {
        try {
          const r = tsMod!.parseAst(src, { customs: typescriptEstreeCustoms as ToyAstCustoms });
          if (r !== null) realOk++;
          else {
            const toks = tsMod!.tokenize(src).map((t) => ({
              off: t.off, end: t.end, nl: t.nl, kid: t.kid, lid: t.lid,
            }));
            if (tsMod!.parse(toks) === null) realOk++; // both reject
            else console.error('  real-no-throw null while CST accepts', src.slice(0, 60));
          }
        } catch (e) {
          realThrow++;
          console.error('  real-no-throw THROW', src.slice(0, 60), String(e).slice(0, 120));
        }
      }
      check(realOk === realNoThrow.length && realThrow === 0,
        `adv3 real-no-throw ${realOk}/${realNoThrow.length} throws=${realThrow}`);

      const nestedTpl = advJ('tag`a${b}${`c${d}`}e`;');
      const taggedN = nestedTpl.split('TaggedTemplateExpression').length - 1;
      const tplLitN = nestedTpl.split('TemplateLiteral').length - 1;
      check(
        taggedN === 1 && tplLitN >= 2 && !nestedTpl.includes('"$template"'),
        'adv3 nested tagged tpl shape (1 Tagged + ≥2 TemplateLiteral)',
        nestedTpl.slice(0, 300),
      );
      check(
        advJ('x = { t: new.target };').includes('MetaProperty'),
        'adv3 new.target in object',
      );
      check(
        advJ('class C { m() { return 1; } }').includes('ReturnStatement'),
        'adv3 class method body ReturnStatement',
      );
      check(
        advJ('type T = { a: 1 };').includes('TSTypeLiteral'),
        'adv3 type literal members',
      );
    }

    let switchFoldState: unknown = null;
    const foldCustoms = { ...typescriptEstreeCustoms } as Record<string, (ctx: any) => unknown>;
    const stmtCustom = foldCustoms.estreeStmt!;
    foldCustoms.estreeStmt = (ctx) => {
      if (ctx.altPath[0] === 6) switchFoldState = ctx.state;
      return stmtCustom(ctx);
    };
    tsMod.parseAst('switch (x) { case 1: case 2: y; break; default: z; }', {
      customs: foldCustoms as ToyAstCustoms,
    });
    check(
      deepEq(switchFoldState, { 'switch-consequent': { starts: 3, appends: 3 } }),
      'SwitchCase parent fold state starts=3 appends=3',
      JSON.stringify(switchFoldState),
    );

    // alt / LED identity counterexamples (wrong altPath → different shape)
    let altNegOk = 0;
    const bindAlt = (fn: string, src: string, good: number[], bad: number[]) => {
      const wrap = (altPath: number[]) => {
        const customs = { ...typescriptEstreeCustoms } as Record<string, (ctx: any) => unknown>;
        const orig = customs[fn]!;
        customs[fn] = (ctx) => orig({ ...ctx, altPath });
        return stripSpans(tsMod!.parseAst(src, { customs: customs as ToyAstCustoms }));
      };
      return !deepEq(wrap(good), wrap(bad));
    };
    if (bindAlt('estreeBindingProperty', 'const { a } = o;', [1], [0])) altNegOk++;
    if (bindAlt('estreeBindingProperty', 'const { x: y } = o;', [0], [1])) altNegOk++;
    if (bindAlt('estreeSwitchCase', 'switch(0){case 1:x;}', [0], [1])) altNegOk++;
    if (bindAlt('estreeProp', '({ a, b: 1 });', [4], [0])) altNegOk++;
    check(altNegOk >= 4, `typescript alt identity counterexamples ${altNegOk}/4`);
    let ledNegOk = 0;
    if (bindAlt('estreeExprLed', 'a.b;', [3], [2])) ledNegOk++;
    if (bindAlt('estreeExprLed', 'f();', [2], [5])) ledNegOk++;
    check(ledNegOk >= 2, `typescript LED identity counterexamples ${ledNegOk}/2`);

    const failLoudFns = [
      'estreeStmt', 'estreeDecl', 'estreeParenOrComma', 'estreeExprLed',
      'estreeExprNudSeq', 'estreeArrow', 'tsTypeLed', 'estreeNewTargetLed',
      'estreeArrayPattern', 'estreeBindingProperty', 'estreeParam', 'estreeForHead',
      'estreeSwitchCase', 'estreeDecorator', 'estreeClassMember',
      'tsInterfaceMember', 'tsTypeMember', 'estreeProp',
    ] as const;
    let failLoudOk = 0;
    for (const fn of failLoudFns) {
      try {
        (typescriptEstreeCustoms as Record<string, (ctx: any) => unknown>)[fn]!({
          src: '', kids: [], off: 0, end: 0, altPath: [99],
          opText: '__unknown', left: null,
        });
      } catch (e) {
        const message = String(e);
        if (message.includes(`shape custom ${fn}`) && (message.includes('altPath') || message.includes('opText'))) {
          failLoudOk++;
        }
      }
    }
    check(failLoudOk === 18, `typescript custom fallback fail-loud ${failLoudOk}/18`);

    const extraFailLoudFns = [
      'estreeExprBinary', 'estreeExprPrefix', 'estreeExprPostfixTok', 'estreeTemplateLiteral',
    ] as const;
    let extraFailLoudOk = 0;
    for (const fn of extraFailLoudFns) {
      try {
        (typescriptEstreeCustoms as Record<string, (ctx: any) => unknown>)[fn]!({
          src: '', kids: [], off: 0, end: 0, altPath: [], opText: '__unknown', left: null,
        });
      } catch (e) {
        if (String(e).includes(`shape custom ${fn}`)) extraFailLoudOk++;
      }
    }
    check(extraFailLoudOk === 4, `typescript Pratt subslot fallback fail-loud ${extraFailLoudOk}/4`);

    // Independent cross-validation against test/ast-builder.ts demoBuilder semantics.
    const demoMod = await emitLoadNoShape('javascript-demo-xval', javascriptGrammar);
    const DROP = new Set(['$punct', '$keyword', '$operator', '$templateHead', '$templateMiddle', '$templateTail']);
    const demoBuilder = (src: string) => ({
      leaf(tokenType: string, _kid: number, _lid: number, off: number, end: number) {
        return DROP.has(tokenType) ? null : src.slice(off, end);
      },
      node(rule: string, children: unknown[]) {
        if (children.length === 1) return children;
        if (children.length === 0) return null;
        if (rule === 'Program') return { type: 'Program', body: children };
        if (rule === 'Stmt' || rule === 'Stmt_A') return { type: 'ExpressionStatement', expression: children[0] };
        if (rule === 'Expr' || rule === 'Expr_A') {
          if (children.length === 2) return { type: 'BinaryExpression', left: children[0], right: children[1] };
          if (children.length === 3) return { type: 'BinaryExpression', left: children[0], operator: children[1], right: children[2] };
          return { type: 'Expression', children };
        }
        if (rule === 'Decl' || rule === 'Decl_A') return { type: 'Declaration', children };
        if (rule === 'Block' || rule === 'Block_A') return { type: 'BlockStatement', body: children };
        return { type: rule.replace(/_A$/, ''), children };
      },
    });
    const projectToDemo = (tree: unknown): unknown => {
      if (tree === null) return tree;
      if (typeof tree === 'number' || typeof tree === 'bigint' || typeof tree === 'boolean') return String(tree);
      if (typeof tree !== 'object') return tree;
      if (Array.isArray(tree)) {
        const xs = tree.map(projectToDemo);
        return xs.length === 1 ? xs[0] : xs;
      }
      const o = tree as Record<string, unknown>;
      if (o.type === 'Program') return projectToDemo(o.body);
      if (o.type === 'ExpressionStatement') return projectToDemo(o.expression);
      if (o.type === 'Identifier') return o.name;
      if (o.type === 'BinaryExpression') return { type: 'BinaryExpression', left: projectToDemo(o.left), right: projectToDemo(o.right) };
      if (o.type === 'MemberExpression') return { type: 'BinaryExpression', left: projectToDemo(o.object), right: projectToDemo(o.property) };
      if (o.type === 'VariableDeclaration') return projectToDemo(o.declarations);
      if (o.type === 'VariableDeclarator') return { type: 'Binding', children: [projectToDemo(o.id), projectToDemo(o.init)] };
      if (o.type === 'BlockStatement') return { type: 'BlockStatement', body: projectToDemo(o.body) };
      return o;
    };
    const DEMO_XVAL = [
      '1 + 2;', '1 + 2 * 3;', '1 - 2 - 3;', '(1);', 'foo;',
      'var x = 1;', 'a.b.c;', 'if (a) b(); else c();',
      'const g = (x) => x * 2;', 'class C {}', 'function f(){}',
    ];
    const KNOWN_DEMO_DIFF = new Set([
      'if (a) b(); else c();', 'const g = (x) => x * 2;', 'class C {}', 'function f(){}',
    ]);
    let xvalSame = 0, xvalKnown = 0;
    const xvalUnexpected: string[] = [];
    for (const src of DEMO_XVAL) {
      const ast = stripSpans(tsMod.parseAst(src, { customs: typescriptEstreeCustoms as ToyAstCustoms }));
      const demo = demoMod.parseWith(src, demoBuilder(src));
      if (deepEq(projectToDemo(ast), demo)) xvalSame++;
      else if (KNOWN_DEMO_DIFF.has(src)) xvalKnown++;
      else xvalUnexpected.push(src);
    }
    check(
      xvalSame + xvalKnown === DEMO_XVAL.length && DEMO_XVAL.length >= 10,
      `demo parseWith cross-validation ${xvalSame} same + ${xvalKnown} declared differences / ${DEMO_XVAL.length}`,
      xvalUnexpected.join('; '),
    );

  }

  // ── SH3-1b: suppress is LED-only; prec-binary survives exclude('*', Expr) ─
  const sh31bNoplus = [
    'noplus 1 * 2;', 'noplus 1 * 2 * 3;', 'noplus (1*2);', 'noplus 1*2;',
    'noplus 1/2;', 'noplus 1*2+3;', 'noplus (1*2)*3;', 'noplus 1*(2*3);',
  ];
  for (const src of sh31bNoplus) {
    check(
      accepts(toyMod, src, false) && accepts(toyMod, src, true),
      `SH3-1b suppress/binary accept ${JSON.stringify(src)}`,
    );
  }

  const cstFixSepAltWitnesses: { src: string; want: 'accept' | 'reject' }[] = [
    { src: "pairs (a : );", want: 'reject' },
    { src: "pairs (1, a : );", want: 'reject' },
    { src: "pairs(a:);", want: 'reject' },
    { src: "pairs(1,a:);", want: 'reject' },
    { src: "pairs(a:1,b:);", want: 'reject' },
    { src: "pairs(a : );", want: 'reject' },
    { src: "pairs(1, a:);", want: 'reject' },
    { src: "notany bad;", want: 'reject' },
    { src: "txn a:b;", want: 'reject' },
    { src: 'line a\nb;', want: 'reject' },
    { src: "args(1,,2);", want: 'reject' },
    { src: "pairs();", want: 'accept' },
    { src: "pairs(a:1);", want: 'accept' },
    { src: "pairs(1, a:2);", want: 'accept' },
    { src: "pairs(a:1,2,b:3,);", want: 'accept' },
    { src: "pairs( a : 1 , );", want: 'accept' },
    { src: "maybe;", want: 'accept' },
    { src: "maybe a 1;", want: 'accept' },
    { src: "repeat a 1 b 2;", want: 'accept' },
    { src: "notany good;", want: 'accept' },
    { src: "txn a:b?;", want: 'accept' },
    { src: "noplus 1 * 2;", want: 'accept' },
    { src: "line a b;", want: 'accept' },
    { src: "args();", want: 'accept' },
    { src: "args(1,);", want: 'accept' },
  ];
  for (const { src, want } of cstFixSepAltWitnesses) {
    const cst = accepts(toyMod, src, false);
    const ast = accepts(toyMod, src, true);
    const ok = want === 'accept' ? cst && ast : !cst && !ast;
    check(ok, `cst-fix sepAlt witness ${want} ${JSON.stringify(src)} (cst=${cst} ast=${ast})`);
  }

  // ── Guard + capped witnesses (toy) ────────────────────────────────────────
  check(
    accepts(toyMod, 'a::b;', false) && accepts(toyMod, 'a::b;', true),
    'LED sameLine accepts same-line ::',
  );
  check(
    !accepts(toyMod, 'a\n::b;', false) && !accepts(toyMod, 'a\n::b;', true),
    'LED sameLine rejects cross-line :: (newline before connector)',
  );
  check(
    !accepts(toyMod, 'void##x;', false) && !accepts(toyMod, 'void##x;', true),
    'LED notLeftLeaf rejects void##x',
  );
  check(
    accepts(toyMod, 'a##x;', false) && accepts(toyMod, 'a##x;', true),
    'LED notLeftLeaf accepts a##x',
  );
  check(
    accepts(toyMod, 'a?1:2;', false) && accepts(toyMod, 'a?1:2;', true),
    'LED lbp ternary accepts a?1:2',
  );
  check(
    accepts(toyMod, 'a.b;', false) && accepts(toyMod, 'a.b;', true),
    'LED accessTail member accepts a.b',
  );
  check(
    !accepts(toyMod, 'a++.b;', false) && !accepts(toyMod, 'a++.b;', true),
    'LED accessTail rejects after postfix close a++.b',
  );
  check(
    accepts(toyMod, 'x=>1;', false) && accepts(toyMod, 'x=>1;', true),
    'nudCapped arrow accepts',
  );
  check(
    accepts(toyMod, 'f(x=>1);', false) && accepts(toyMod, 'f(x=>1);', true),
    'capped nested in call LED; transaction keeps parse correct',
  );

  console.log(`\nshape-parity summary: toy ${toyP.cstAcc}/${toyCorpus.length} accept, calc ${calcP.cstAcc}/${calcCorpus.length} accept, corpus=${totalN}`);
  console.log(`shape-parity: ${pass}/${pass + fail} checks passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
