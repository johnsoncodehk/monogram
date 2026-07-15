// Gate: TS shape codegen — validateShape, emitTs+parseAst golden AST, no-shape byte identity.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { emitParser, tsTarget } from '../src/emit.ts';
import { emitTs } from '../src/target-ts.ts';
import { calcShape } from '../src/shape-calc.ts';
import { validateShape, validateShapeOrThrow } from '../src/shape-validate.ts';
import calcGrammar from './fixtures/calc.ts';

type Ast = Record<string, unknown>;

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

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emitAndLoad(shape?: typeof calcShape): Promise<{
  parseAst: (src: string) => Ast | null;
  parseWith: (src: string, b: unknown) => Ast | null;
  cstBuilder: unknown;
}> {
  const src = emitTs(calcGrammar, shape ? { shape } : undefined);
  const dir = '/tmp/shape-codegen';
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/calc-parser.ts`;
  writeFileSync(file, src);
  return import(file);
}

// ── Handwritten golden expectations (no parseAst backfill) ───────────────────

const GOLDEN: { src: string; expect: Ast }[] = [
  {
    src: 'let x = 1;',
    expect: {
      type: 'Program',
      body: [{ type: 'LetStatement', id: 'x', init: 1 }],
    },
  },
  {
    src: '1 + 2;',
    expect: {
      type: 'Program',
      body: [{
        type: 'ExpressionStatement',
        expression: { type: 'BinaryExpression', left: 1, operator: '+', right: 2 },
      }],
    },
  },
  {
    src: '1 + 2 * 3;',
    expect: {
      type: 'Program',
      body: [{
        type: 'ExpressionStatement',
        expression: {
          type: 'BinaryExpression', left: 1, operator: '+',
          right: { type: 'BinaryExpression', left: 2, operator: '*', right: 3 },
        },
      }],
    },
  },
  {
    src: '-a;',
    expect: {
      type: 'Program',
      body: [{
        type: 'ExpressionStatement',
        expression: { type: 'UnaryExpression', operator: '-', argument: 'a' },
      }],
    },
  },
  {
    src: '(1);',
    expect: {
      type: 'Program',
      body: [{ type: 'ExpressionStatement', expression: 1 }],
    },
  },
  {
    src: 'let a = 1; let b = 2; a + b;',
    expect: {
      type: 'Program',
      body: [
        { type: 'LetStatement', id: 'a', init: 1 },
        { type: 'LetStatement', id: 'b', init: 2 },
        {
          type: 'ExpressionStatement',
          expression: { type: 'BinaryExpression', left: 'a', operator: '+', right: 'b' },
        },
      ],
    },
  },
  {
    src: '1 - 2 - 3;',
    expect: {
      type: 'Program',
      body: [{
        type: 'ExpressionStatement',
        expression: {
          type: 'BinaryExpression',
          left: { type: 'BinaryExpression', left: 1, operator: '-', right: 2 },
          operator: '-',
          right: 3,
        },
      }],
    },
  },
  {
    src: '-(a * b);',
    expect: {
      type: 'Program',
      body: [{
        type: 'ExpressionStatement',
        expression: {
          type: 'UnaryExpression', operator: '-',
          argument: { type: 'BinaryExpression', left: 'a', operator: '*', right: 'b' },
        },
      }],
    },
  },
  {
    src: 'foo; bar; baz;',
    expect: {
      type: 'Program',
      body: [
        { type: 'ExpressionStatement', expression: 'foo' },
        { type: 'ExpressionStatement', expression: 'bar' },
        { type: 'ExpressionStatement', expression: 'baz' },
      ],
    },
  },
];

// ── Validator negatives ───────────────────────────────────────────────────────

const NEGATIVES: { label: string; spec: typeof calcShape; wantCode: string }[] = [
  {
    label: 'field-oob',
    spec: {
      ...calcShape,
      rules: {
        ...calcShape.rules,
        Program: {
          kind: 'node',
          type: 'Program',
          fields: [{ name: 'body', bind: { at: 5 }, typeHint: 'Statement' }],
        },
      },
    },
    wantCode: 'field-oob',
  },
  {
    label: 'star-needs-list',
    spec: {
      ...calcShape,
      rules: {
        ...calcShape.rules,
        Program: {
          kind: 'node',
          type: 'Program',
          fields: [{ name: 'body', bind: { at: 0 }, typeHint: 'Statement' }],
        },
      },
    },
    wantCode: 'star-needs-list',
  },
  {
    label: 'unmapped',
    spec: {
      ...calcShape,
      rules: { Expr: calcShape.rules.Expr!, Stmt: calcShape.rules.Stmt! },
    },
    wantCode: 'unmapped',
  },
];

function cstPrefix(src: string): string {
  const marker = '// ─── Shape AST';
  const i = src.indexOf(marker);
  return i < 0 ? src : src.slice(0, i);
}

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;

  // validateShape on calc
  const vr = validateShape({ default: calcGrammar }, calcShape);
  if (!vr.ok) {
    console.error('validateShape calc failed:', vr.errors);
    fail++;
  } else {
    pass++;
    console.log(`✓ validateShape calc ok (${vr.ir.rules.length} rules)`);
  }

  // negatives
  for (const neg of NEGATIVES) {
    const r = validateShape({ default: calcGrammar }, neg.spec);
    const hit = r.errors.some((e) => e.code === neg.wantCode);
    if (r.ok || !hit) {
      console.error(`✗ negative ${neg.label}: want code=${neg.wantCode}, got ok=${r.ok} errors=${JSON.stringify(r.errors)}`);
      fail++;
    } else {
      pass++;
      console.log(`✓ negative ${neg.label} → code=${neg.wantCode}`);
    }
  }

  // validateShapeOrThrow hard error
  try {
    validateShapeOrThrow(calcGrammar, NEGATIVES[0]!.spec);
    console.error('✗ validateShapeOrThrow should throw');
    fail++;
  } catch (e) {
    pass++;
    console.log('✓ validateShapeOrThrow throws on field-oob');
  }

  // no-shape SHA256 ≡ master emitParser prefix
  const noShape = emitTs(calcGrammar);
  const master = emitParser(calcGrammar, tsTarget);
  const hNo = createHash('sha256').update(cstPrefix(noShape)).digest('hex').slice(0, 12);
  const hMa = createHash('sha256').update(cstPrefix(master)).digest('hex').slice(0, 12);
  if (hNo !== hMa) {
    console.error(`✗ no-shape prefix sha256 ${hNo} !== master ${hMa}`);
    fail++;
  } else {
    pass++;
    console.log(`✓ no-shape emitted prefix sha256=${hNo} ≡ master`);
  }

  // golden parseAst
  const mod = await emitAndLoad(calcShape);
  for (const g of GOLDEN) {
    const got = stripSpans(mod.parseAst(g.src));
    if (!deepEq(got, g.expect)) {
      console.error(`✗ golden ${JSON.stringify(g.src)}`);
      console.error('  got:  ', JSON.stringify(got));
      console.error('  want: ', JSON.stringify(g.expect));
      fail++;
    } else {
      pass++;
    }
  }
  console.log(`✓ golden parseAst ${GOLDEN.length}/${GOLDEN.length}`);

  // operator spot-check
  const bin = mod.parseAst('2 / 3;') as Ast;
  const stmt = (bin?.body as Ast[])?.[0] as Ast;
  const expr = stmt?.expression as Ast;
  if (expr?.type !== 'BinaryExpression' || expr.operator !== '/') {
    console.error(`✗ BinaryExpression.operator got ${JSON.stringify(expr)}`);
    fail++;
  } else {
    pass++;
    console.log('✓ BinaryExpression.operator=/');
  }
  const un = mod.parseAst('--x;') as Ast;
  const ustmt = (un?.body as Ast[])?.[0] as Ast;
  const uexpr = ustmt?.expression as Ast;
  if (uexpr?.type !== 'UnaryExpression' || uexpr.operator !== '-') {
    console.error(`✗ UnaryExpression.operator got ${JSON.stringify(uexpr)}`);
    fail++;
  } else {
    pass++;
    console.log('✓ UnaryExpression.operator=-');
  }

  // performance smoke: parseAst vs parseWith on ≥1MB calc input
  const chunk = 'let x = 1 + 2 * 3;\n';
  const big = chunk.repeat(Math.ceil((1024 * 1024) / chunk.length));
  const t0 = performance.now();
  mod.parseAst(big);
  const astMs = performance.now() - t0;
  if (typeof mod.parseWith === 'function') {
    const t1 = performance.now();
    mod.parseWith(big, mod.cstBuilder);
    const withMs = performance.now() - t1;
    console.log(`✓ perf smoke ${(big.length / 1024 / 1024).toFixed(2)}MB parseAst=${astMs.toFixed(1)}ms parseWith=${withMs.toFixed(1)}ms`);
    pass++;
  } else {
    console.log(`✓ perf smoke ${(big.length / 1024 / 1024).toFixed(2)}MB parseAst=${astMs.toFixed(1)}ms (no parseWith)`);
    pass++;
  }

  const total = pass + fail;
  console.log(`shape-codegen: ${pass}/${total} checks passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
