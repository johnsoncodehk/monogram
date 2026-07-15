// Gate: SH2-1 shape CST↔parseAst parity — calc+toy corpus ≥2500, toy golden ≥14,
// coverage table, typescript+SH0 fail-fast (no home-path permanent dependency).
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

/** SH0 representative fragments inlined — no permanent home-path gate. */
function sh0SampleShape(): ShapeSpec {
  return {
    grammar: 'typescript',
    spans: 'optional',
    unmapped: 'default',
    leaves: {
      $punct: { action: 'drop' },
      $keyword: { action: 'drop' },
      $operator: { action: 'drop' },
      Ident: { action: 'leafValue', fn: 'ident' },
      Number: { action: 'leafValue', fn: 'number' },
    },
    rules: {
      Program: {
        kind: 'node',
        type: 'Program',
        fields: [{ name: 'body', bind: { from: 'list', of: 0 }, typeHint: 'Statement' }],
      },
      Expr: {
        kind: 'pratt',
        atom: { kind: 'keep' },
        group: {
          kind: 'custom', fn: 'estreeParenOrComma',
          reason: 'SH0: nudBracket "(" is Expr star(, Expr) — not pure group',
        },
        prefix: {
          kind: 'node',
          type: 'UnaryExpression',
          fields: [{ name: 'argument', bind: { at: 0 }, typeHint: 'Expression' }],
        },
        binary: {
          kind: 'node',
          type: 'BinaryExpression',
          fields: [
            { name: 'left', bind: { at: 0 }, typeHint: 'Expression' },
            { name: 'right', bind: { at: 1 }, typeHint: 'Expression' },
          ],
        },
        led: {
          kind: 'custom', fn: 'estreeExprLed',
          reason: 'SH0: ≥7 mixfix LED shapes need connector→node dispatch',
        },
        nudSeq: {
          kind: 'custom', fn: 'estreeExprNudSeq',
          reason: 'SH0: bare Ident + decorated class forms',
        },
        nudCapped: {
          kind: 'custom', fn: 'estreeArrow',
          reason: 'SH0: ArrowFunctionExpression forms',
        },
      },
      Stmt: {
        kind: 'custom', fn: 'estreeStmt',
        reason: 'SH0: Stmt has 19 RD alts with distinct ESTree products',
      },
    },
  };
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
  check(goldenOk === goldenTotal && goldenTotal >= 14, `toy golden ${goldenOk}/${goldenTotal}`);

  const toyCorpus = buildToyCorpus(0x5a2_2026);
  check(toyCorpus.length === 2100, `toy corpus exact 2100 (got ${toyCorpus.length})`);
  const calcCorpus = buildCalcCorpus();
  const totalN = toyCorpus.length + calcCorpus.length;
  check(totalN >= 2500, `corpus total ≥2500 (got ${totalN})`);

  function parity(
    label: string,
    mod: Emitted,
    corpus: { src: string; source: string }[],
    customs?: ToyAstCustoms,
  ): { diverge: number; cstAcc: number; astAcc: number } {
    let diverge = 0, cstAcc = 0, astAcc = 0;
    for (const x of corpus) {
      const toks = mod.tokenize(x.src).map((t) => ({
        off: t.off, end: t.end, nl: t.nl, kid: t.kid, lid: t.lid,
      }));
      let cst = false, ast = false, cstErr: string | null = null, astErr: string | null = null;
      try { cst = mod.parse(toks) !== null; } catch (e) { cstErr = String(e); }
      try { ast = mod.parseAst(x.src, customs ? { customs } : undefined) !== null; }
      catch (e) { astErr = String(e); }
      if (cst) cstAcc++;
      if (ast) astAcc++;
      if (cst !== ast || cstErr || astErr) {
        diverge++;
        if (diverge <= 5) {
          console.error(`  diverge[${label}] ${JSON.stringify(x.src)} cst=${cst} ast=${ast} ${cstErr ?? ''} ${astErr ?? ''}`);
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

  let tsErr = '';
  try {
    emitTs(typescriptGrammar, { shape: sh0SampleShape() });
    tsErr = '';
  } catch (e) {
    tsErr = String(e);
  }
  const hasRuleConstruct = /Program:|Expr:/.test(tsErr) && /unsupported construct/.test(tsErr);
  const multi = (tsErr.match(/\n\s+\S+:/g) ?? []).length >= 2
    || (tsErr.match(/pratt\./g) ?? []).length >= 2
    || (tsErr.match(/star\(/g) ?? []).length + (tsErr.match(/pratt\./g) ?? []).length >= 2;
  check(!!tsErr && hasRuleConstruct && multi, 'typescript+SH0 emit fail-fast lists unsupported',
    tsErr ? tsErr.slice(0, 400) : 'no error');
  const remaining = [...tsErr.matchAll(/\n\s+([^:\n]+): ([^\n]+)/g)]
    .map((m) => ({ rule: m[1]!, construct: m[2]! }));
  const isPrattDeferred = (construct: string) =>
    construct.startsWith('pratt.') || construct === 'expected-pratt-shape';
  const rdRemaining = remaining.filter((x) => !isPrattDeferred(x.construct));
  check(
    remaining.length > 0 && rdRemaining.length === 0,
    `typescript+SH0 RD unsupported=0; Pratt deferred=${remaining.length}`,
    rdRemaining.slice(0, 10).map((x) => `${x.rule}:${x.construct}`).join(', '),
  );

  console.log(`\nshape-parity summary: toy ${toyP.cstAcc}/${toyCorpus.length} accept, calc ${calcP.cstAcc}/${calcCorpus.length} accept, corpus=${totalN}`);
  console.log(`shape-parity: ${pass}/${pass + fail} checks passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
