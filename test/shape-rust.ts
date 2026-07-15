// Gate: Rust calc shape codegen — rustc -O, CST≡AST acceptance, TS≡Rust neutral AST,
// no-shape byte identity, and fail-fast inventory for the full TypeScript shape.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { emitParser, rustTarget } from '../src/emit.ts';
import { emitRust } from '../src/target-rust.ts';
import { emitTs } from '../src/target-ts.ts';
import { calcShape } from '../src/shape-calc.ts';
import calcGrammar from './fixtures/calc.ts';
import typescriptGrammar from '../typescript.ts';
import { typescriptShape } from './fixtures/shape-typescript.ts';

type Ast = Record<string, unknown>;
const TMP = '/tmp/shape-rust-gate';
mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function stripSpans(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripSpans);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== 'off' && key !== 'end') out[key] = stripSpans(child);
  }
  return out;
}

const GOLDEN: { src: string; expect: Ast }[] = [
  { src: 'let x = 1;', expect: { type: 'Program', body: [{ type: 'LetStatement', id: 'x', init: 1 }] } },
  {
    src: '1 + 2;',
    expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: { type: 'BinaryExpression', left: 1, operator: '+', right: 2 } }] },
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
    expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: { type: 'UnaryExpression', operator: '-', argument: 'a' } }] },
  },
  { src: '(1);', expect: { type: 'Program', body: [{ type: 'ExpressionStatement', expression: 1 }] } },
  {
    src: 'let a = 1; let b = 2; a + b;',
    expect: {
      type: 'Program',
      body: [
        { type: 'LetStatement', id: 'a', init: 1 },
        { type: 'LetStatement', id: 'b', init: 2 },
        { type: 'ExpressionStatement', expression: { type: 'BinaryExpression', left: 'a', operator: '+', right: 'b' } },
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

// Mixed valid/invalid, precedence, whitespace, rollback, and prefix cases (≥30 adversarial).
const CORPUS = [...new Set([...GOLDEN.map((golden) => golden.src), ...[
  '', '1;', 'a;', 'let x = 1;', 'let long_name=42;', '1+2;', '1 + 2 * 3;',
  '(1);', '((1));', '-1;', '--x;', '-(a*b);', '1-2-3;', '8/4/2;', '1+-2;',
  'let a=1;let b=2;a+b;', 'foo;bar;baz;', '1 * (2 + 3);', '(1+2)*3;',
  'let x = -1; x / 2;', '0;', '999999;', '_x;', 'A1;', 'let _ = (1);',
  '  1;\n 2;\n', '1/*c*/+2;', 'let letx=3;', 'a+b*c-d/e;', '----1;',
  '1', 'let x=1', 'let x = ;', 'let = 1;', '1 + ;', '+1;', '(1;', '1);',
  '1 2;', 'let x 1;', 'let x == 1;', 'let x = 1;;', ';', '()', 'let;',
  '1 + * 2;', '((1);', 'let x = (1+2;',
]])];

const harness = `
fn main() {
    let mut raw = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw).unwrap();
    for src in raw.split('\\0') {
        let cst_ok = parse(tokenize(src)).is_some();
        let ast = parse_ast(src);
        if cst_ok != ast.is_some() {
            eprintln!("accept divergence: {:?}", src);
            std::process::exit(2);
        }
        match ast {
            Some(root) => println!("A\\t{}", root.to_shape_json()),
            None => println!("R"),
        }
    }
}
`;

async function main(): Promise<void> {
  const noShape = emitRust(calcGrammar);
  const base = emitParser(calcGrammar, rustTarget);
  const noHash = createHash('sha256').update(noShape).digest('hex');
  const baseHash = createHash('sha256').update(base).digest('hex');
  check('no-shape Rust byte identity', noShape === base && noHash === baseHash, `${noHash} ≡ ${baseHash}`);

  const generated = emitRust(calcGrammar, { shape: calcShape });
  check(
    'generated Rust AST structs/enums',
    generated.includes('pub struct Program') &&
      generated.includes('pub enum ExprShape') &&
      generated.includes('pub enum StmtShape'),
  );
  check(
    'zero-cost generic customs + bindOp',
    generated.includes('pub trait ShapeCustoms') &&
      generated.includes('pub fn parse_ast_with<C: ShapeCustoms>') &&
      generated.includes('self.customs.bind_op'),
  );

  const rustFile = `${TMP}/calc-shape.rs`;
  const rustBin = `${TMP}/calc-shape`;
  writeFileSync(rustFile, generated + harness);
  execFileSync('rustc', ['-O', '-A', 'warnings', rustFile, '-o', rustBin], {
    stdio: 'pipe',
    timeout: 120_000,
  });
  check('rustc -O calc shape', true);

  const rustLines = execFileSync(rustBin, {
    input: CORPUS.join('\0'),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  }).trimEnd().split('\n');
  check('calc CST parse ≡ Rust parse_ast acceptance', rustLines.length === CORPUS.length, `${CORPUS.length} cases, 0 divergences`);

  const tsFile = `${TMP}/calc-shape.ts`;
  writeFileSync(tsFile, emitTs(calcGrammar, { shape: calcShape }));
  const ts = await import(tsFile + `?t=${Date.now()}`) as {
    parseAst: (src: string) => Ast | null;
    parse: (tokens: unknown[]) => unknown;
    tokenize: (src: string) => unknown[];
  };
  let parityBad = 0;
  for (let i = 0; i < CORPUS.length; i++) {
    const tsCst = ts.parse(ts.tokenize(CORPUS[i]!));
    const tsAst = ts.parseAst(CORPUS[i]!);
    const rustAccepted = rustLines[i]!.startsWith('A\t');
    if ((tsCst !== null) !== rustAccepted || (tsAst !== null) !== rustAccepted) parityBad++;
  }
  check('calc TS CST/AST ≡ Rust AST acceptance', parityBad === 0, `${CORPUS.length} cases, ${parityBad} divergences`);

  const goldenLines = execFileSync(rustBin, {
    input: GOLDEN.map((golden) => golden.src).join('\0'),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  }).trimEnd().split('\n');
  let goldenBad = 0;
  let crossBad = 0;
  for (let i = 0; i < GOLDEN.length; i++) {
    const golden = GOLDEN[i]!;
    if (!goldenLines[i]?.startsWith('A\t')) {
      goldenBad++;
      continue;
    }
    const rust = JSON.parse(goldenLines[i]!.slice(2)) as Ast;
    const tsAst = ts.parseAst(golden.src);
    const neutralRust = stripSpans(rust);
    const neutralTs = stripSpans(tsAst);
    if (JSON.stringify(neutralRust) !== JSON.stringify(golden.expect)) goldenBad++;
    if (JSON.stringify(neutralRust) !== JSON.stringify(neutralTs)) crossBad++;
  }
  check('Rust handwritten golden AST', goldenBad === 0, `${GOLDEN.length - goldenBad}/${GOLDEN.length}`);
  check('TS vs Rust neutral JSON AST isomorphism', crossBad === 0, `${GOLDEN.length - crossBad}/${GOLDEN.length}`);

  let failFast = '';
  try {
    emitRust(typescriptGrammar, { shape: typescriptShape });
  } catch (error) {
    failFast = error instanceof Error ? error.message : String(error);
  }
  const unsupportedCount = Number(failFast.match(/shape rust emit: (\d+) unsupported construct/)?.[1] ?? 0);
  check(
    'TypeScript full shape fails fast at emit time',
    unsupportedCount > 0 &&
      failFast.includes('pratt-ir:') &&
      failFast.includes('step:') &&
      !failFast.toLowerCase().includes('panic'),
    `${unsupportedCount} unsupported constructs`,
  );

  const total = pass + fail;
  console.log(`shape-rust: ${pass}/${total} checks passed`);
  if (fail) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
