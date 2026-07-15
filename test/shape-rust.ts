// Gate: Rust shape codegen — calc + toy RD/Pratt full slots, CST≡AST acceptance,
// TS≡Rust neutral AST, no-shape byte identity, fail-fast inventory (Pratt=0; custom+template remain).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { emitParser, rustTarget } from '../src/emit.ts';
import { emitRust } from '../src/target-rust.ts';
import { emitTs } from '../src/target-ts.ts';
import {
  token, rule, defineGrammar, left, op, seq, oneOf, range, star,
  altPattern, noneOf, notFollowedBy,
} from '../src/api.ts';
import type { ShapeSpec } from '../src/shape-schema.ts';
import { calcShape } from '../src/shape-calc.ts';
import calcGrammar from './fixtures/calc.ts';
import toyGrammar, { toyShape, toyGolden, buildToyCorpus, toyPrattWitnesses } from './fixtures/shape-toy.ts';
import typescriptGrammar from '../typescript.ts';
import { typescriptShape } from './fixtures/shape-typescript.ts';

type Ast = Record<string, unknown>;
const TMP = '/tmp/shape-rust-gate';
mkdirSync(TMP, { recursive: true });

// SH3-3 mini grammar: Type deliberately precedes Expr, so portable interpRule=Type.
// Explicit Expr.template must therefore dual-parse each hole to obtain Expr products.
const tplDigit = range('0', '9');
const tplIdentStart = oneOf(range('a', 'z'), range('A', 'Z'), '_');
const tplIdentPart = oneOf(tplIdentStart, tplDigit);
const TplIdent = token(seq(tplIdentStart, star(tplIdentPart)), { identifier: true });
const TplNumber = token(seq(tplDigit, star(tplDigit)));
const TplTemplate = token(
  seq('`', star(altPattern(noneOf('`', '\\', '$'), seq('\\', noneOf('\n')), seq('$', notFollowedBy('{')))), '`'),
  { template: { open: '`', interpOpen: '${', interpClose: '}' } },
);
const TplType = rule(($) => [
  TplNumber, TplIdent, TplTemplate, ['(', $, ')'], [$, op, $], [$, TplTemplate],
]);
const TplExpr = rule(($) => [
  TplNumber, TplIdent, TplTemplate, ['(', $, ')'], [$, op, $], [$, TplTemplate],
]);
const templateMiniGrammar = defineGrammar({
  name: 'shape-template-mini',
  tokens: { Ident: TplIdent, Number: TplNumber, Template: TplTemplate },
  prec: [left('+', '-'), left('*', '/')],
  rules: { Type: TplType, Expr: TplExpr },
  entry: TplExpr,
});
const binaryNode = {
  kind: 'node' as const,
  type: 'BinaryExpression',
  fields: [
    { name: 'left', bind: { at: 0 } as const },
    { name: 'operator', bind: 'opText' as const, typeHint: 'string' },
    { name: 'right', bind: { at: 1 } as const },
  ],
};
const taggedNode = {
  kind: 'node' as const,
  type: 'TaggedTemplate',
  fields: [
    { name: 'tag', bind: { at: 0 } as const },
    { name: 'quasi', bind: { at: 1 } as const },
  ],
};
const templateMiniShape: ShapeSpec = {
  grammar: 'shape-template-mini',
  spans: 'none',
  unmapped: 'error',
  leaves: {
    $punct: { action: 'drop' },
    $operator: { action: 'drop' },
    Ident: { action: 'leafValue', fn: 'ident' },
    Number: { action: 'leafValue', fn: 'number' },
    Template: { action: 'leafValue', fn: 'string' },
  },
  rules: {
    // Omitted template exercises legacy `$template` behavior on the accept parser.
    Type: { kind: 'pratt', atom: { kind: 'keep' }, group: { kind: 'inline' }, binary: { kind: 'keep' }, postfixTok: { kind: 'keep' } },
    Expr: {
      kind: 'pratt',
      atom: { kind: 'keep' },
      group: { kind: 'inline' },
      binary: binaryNode,
      postfixTok: taggedNode,
      template: { kind: 'keep' },
    },
  },
};

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

function compileShape(name: string, source: string): string {
  const rustFile = `${TMP}/${name}.rs`;
  const rustBin = `${TMP}/${name}`;
  writeFileSync(rustFile, source + harness);
  execFileSync('rustc', ['-O', '-A', 'warnings', rustFile, '-o', rustBin], {
    stdio: 'pipe',
    timeout: 180_000,
  });
  return rustBin;
}

function runBatch(bin: string, inputs: string[]): string[] {
  return execFileSync(bin, {
    input: inputs.join('\0'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  }).trimEnd().split('\n');
}

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
      generated.includes('pub enum StmtShape') &&
      generated.includes('struct ShapeCk') &&
      generated.includes('pub enum AstValue'),
  );
  check(
    'zero-cost generic customs + bindOp + ShapeCk',
    generated.includes('pub trait ShapeCustoms') &&
      generated.includes('pub fn parse_ast_with<C: ShapeCustoms>') &&
      generated.includes('self.customs.bind_op') &&
      generated.includes('fn shape_ck(') &&
      generated.includes('fn shape_restore('),
  );

  const calcBin = compileShape('calc-shape', generated);
  check('rustc -O calc shape', true);

  const rustLines = runBatch(calcBin, CORPUS);
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

  const goldenLines = runBatch(calcBin, GOLDEN.map((golden) => golden.src));
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

  // ── toy RD full constructs ───────────────────────────────────────────────
  const toySrc = emitRust(toyGrammar, { shape: toyShape });
  check('toy shape emits (RD + toy-scale Pratt)', toySrc.includes('parse_ast_Transaction') && toySrc.includes('shape_ck'));
  const toyBin = compileShape('toy-shape', toySrc);
  check('rustc -O toy shape', true);

  const toyTsFile = `${TMP}/toy-shape.ts`;
  writeFileSync(toyTsFile, emitTs(toyGrammar, { shape: toyShape }));
  const toyTs = await import(pathToFileURL(toyTsFile).href + `?t=${Date.now()}`) as {
    parseAst: (src: string) => unknown;
    parse: (tokens: unknown[]) => unknown;
    tokenize: (src: string) => unknown[];
  };

  const toyGoldenLines = runBatch(toyBin, toyGolden.map((g) => g.src));
  let toyGoldenBad = 0;
  let toyCrossBad = 0;
  for (let i = 0; i < toyGolden.length; i++) {
    const g = toyGolden[i]!;
    if (!toyGoldenLines[i]?.startsWith('A\t')) {
      toyGoldenBad++;
      continue;
    }
    const rust = stripSpans(JSON.parse(toyGoldenLines[i]!.slice(2)));
    const tsAst = stripSpans(toyTs.parseAst(g.src));
    if (JSON.stringify(rust) !== JSON.stringify(g.expect)) toyGoldenBad++;
    if (JSON.stringify(rust) !== JSON.stringify(tsAst)) toyCrossBad++;
  }
  check('toy Rust golden AST', toyGoldenBad === 0, `${toyGolden.length - toyGoldenBad}/${toyGolden.length}`);
  check('toy TS↔Rust golden isomorphism', toyCrossBad === 0, `${toyGolden.length - toyCrossBad}/${toyGolden.length}`);

  const toyCorpus = buildToyCorpus();
  check('toy corpus size ≥1000', toyCorpus.length >= 1000, `${toyCorpus.length}`);
  const toyCorpusLines = runBatch(toyBin, toyCorpus.map((c) => c.src));
  let toyAcceptDiv = 0;
  let toyIsoBad = 0;
  let toyIsoN = 0;
  for (let i = 0; i < toyCorpus.length; i++) {
    const src = toyCorpus[i]!.src;
    const tsCst = toyTs.parse(toyTs.tokenize(src));
    const tsAst = toyTs.parseAst(src);
    const rustOk = toyCorpusLines[i]!.startsWith('A\t');
    if ((tsCst !== null) !== rustOk || (tsAst !== null) !== rustOk) {
      toyAcceptDiv++;
      continue;
    }
    if (tsCst !== null && rustOk) {
      toyIsoN++;
      const rust = stripSpans(JSON.parse(toyCorpusLines[i]!.slice(2)));
      if (JSON.stringify(rust) !== JSON.stringify(stripSpans(tsAst))) toyIsoBad++;
    }
  }
  check('toy CST≡AST accept equivalence', toyAcceptDiv === 0, `${toyCorpus.length} cases, ${toyAcceptDiv} divergences`);
  check('toy TS↔Rust AST isomorphism', toyIsoBad === 0, `${toyIsoN} compared, ${toyIsoBad} divergences`);

  // SH3-1b: suppress is LED-only — prec-binary under exclude('*') must accept + iso
  const sh31bNoplus = [
    'noplus 1 * 2;', 'noplus 1 * 2 * 3;', 'noplus (1*2);', 'noplus 1*2;',
    'noplus 1/2;', 'noplus 1*2+3;', 'noplus (1*2)*3;', 'noplus 1*(2*3);',
  ];
  const sh31bLines = runBatch(toyBin, sh31bNoplus);
  let sh31bBad = 0;
  for (let i = 0; i < sh31bNoplus.length; i++) {
    const src = sh31bNoplus[i]!;
    const tsCst = toyTs.parse(toyTs.tokenize(src)) !== null;
    const tsAst = toyTs.parseAst(src);
    const rustOk = sh31bLines[i]!.startsWith('A\t');
    if (!tsCst || tsAst === null || !rustOk) { sh31bBad++; continue; }
    const rust = stripSpans(JSON.parse(sh31bLines[i]!.slice(2)));
    if (JSON.stringify(rust) !== JSON.stringify(stripSpans(tsAst))) sh31bBad++;
  }
  check('SH3-1b noplus suppress/binary TS↔Rust', sh31bBad === 0, `${sh31bNoplus.length - sh31bBad}/${sh31bNoplus.length}`);

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
  const cstFixWitnessSrcs = cstFixSepAltWitnesses.map((w) => w.src);
  const cstFixLines = runBatch(toyBin, cstFixWitnessSrcs);
  let cstFixBad = 0;
  for (let i = 0; i < cstFixSepAltWitnesses.length; i++) {
    const { src, want } = cstFixSepAltWitnesses[i]!;
    const tsCst = toyTs.parse(toyTs.tokenize(src)) !== null;
    const tsAst = toyTs.parseAst(src) !== null;
    const rustOk = cstFixLines[i]!.startsWith('A	');
    const ok = want === 'accept' ? tsCst && tsAst && rustOk : !tsCst && !tsAst && !rustOk;
    if (!ok) cstFixBad++;
  }
  check('cst-fix sepAlt witnesses TS↔Rust', cstFixBad === 0, `${cstFixSepAltWitnesses.length - cstFixBad}/${cstFixSepAltWitnesses.length}`);

  // SH3-2: Pratt construct handwritten witnesses (≥3 each) — TS↔Rust iso
  const prattByConstruct = new Map<string, string[]>();
  for (const w of toyPrattWitnesses) {
    const xs = prattByConstruct.get(w.construct) ?? [];
    xs.push(w.src);
    prattByConstruct.set(w.construct, xs);
  }
  const prattConstructs = [...prattByConstruct.entries()];
  const prattCoverageOk = prattConstructs.length >= 9 && prattConstructs.every(([, srcs]) => srcs.length >= 3);
  check(
    'SH3-2 Pratt witness coverage ≥3 per construct',
    prattCoverageOk,
    prattConstructs.map(([k, v]) => `${k}=${v.length}`).join(' '),
  );
  const prattSrcs = toyPrattWitnesses.map((w) => w.src);
  const prattLines = runBatch(toyBin, prattSrcs);
  let prattWitBad = 0;
  for (let i = 0; i < toyPrattWitnesses.length; i++) {
    const src = prattSrcs[i]!;
    const tsCst = toyTs.parse(toyTs.tokenize(src)) !== null;
    const tsAst = toyTs.parseAst(src);
    const rustOk = prattLines[i]!.startsWith('A\t');
    if (!tsCst || tsAst === null || !rustOk) { prattWitBad++; continue; }
    const rust = stripSpans(JSON.parse(prattLines[i]!.slice(2)));
    if (JSON.stringify(rust) !== JSON.stringify(stripSpans(tsAst))) prattWitBad++;
  }
  check(
    'SH3-2 Pratt handwritten witnesses TS↔Rust iso',
    prattWitBad === 0,
    `${toyPrattWitnesses.length - prattWitBad}/${toyPrattWitnesses.length}`,
  );

  // SH3-3: template slot + dual-parse + tagged postfixTok.
  const templateSrc = emitRust(templateMiniGrammar, { shape: templateMiniShape });
  check(
    'SH3-3 template mechanisms emit',
    templateSrc.includes('match_template_ast_Expr') &&
      templateSrc.includes('parse_ast_Type()') &&
      templateSrc.includes('shape_tpl_restore') &&
      templateSrc.includes('typ: "$template".to_owned()') &&
      templateSrc.includes('typ: "TaggedTemplate".to_owned()'),
  );
  const customTemplateShape: ShapeSpec = {
    ...templateMiniShape,
    rules: {
      ...templateMiniShape.rules,
      Expr: {
        kind: 'pratt',
        atom: { kind: 'keep' },
        group: { kind: 'inline' },
        binary: binaryNode,
        postfixTok: { kind: 'custom', fn: 'taggedCustom', reason: 'SH3-3 custom postfixTok emission witness.' },
        template: { kind: 'custom', fn: 'templateCustom', reason: 'SH3-3 custom template-slot emission witness.' },
      },
    },
  };
  const customTemplateSrc = emitRust(templateMiniGrammar, { shape: customTemplateShape });
  check(
    'SH3-3 template custom/postfixTok custom emit',
    customTemplateSrc.includes('ast_custom("templateCustom"') &&
      customTemplateSrc.includes('ast_custom("taggedCustom"'),
  );
  const templateBin = compileShape('template-mini-shape', templateSrc);
  const templateTsFile = `${TMP}/template-mini-shape.ts`;
  writeFileSync(templateTsFile, emitTs(templateMiniGrammar, { shape: templateMiniShape }));
  const templateTs = await import(pathToFileURL(templateTsFile).href + `?t=${Date.now()}`) as {
    parseAst: (src: string) => unknown;
    parse: (tokens: unknown[]) => unknown;
    tokenize: (src: string) => unknown[];
  };
  const templateWitnesses: { kind: string; src: string; want: 'accept' | 'reject' }[] = [
    { kind: 'plain', src: '`hello ${name}`', want: 'accept' },
    { kind: 'nested', src: '`outer ${`inner ${x}`}`', want: 'accept' },
    { kind: 'tagged', src: 'tag`hello ${name}`', want: 'accept' },
    { kind: 'no-substitution', src: '`plain`', want: 'accept' },
    { kind: 'multi-hole', src: '`a ${x} b ${y} c`', want: 'accept' },
    { kind: 'complex-hole', src: '`sum ${1+2*3}`', want: 'accept' },
    // Empty hole lexes but CST/AST reject (batch-safe). Unterminated EOF panics/throws — checked below.
    { kind: 'empty-hole-reject', src: '`a${}`', want: 'reject' },
    { kind: 'multiline', src: '`line1\n${x+1}\nline3`', want: 'accept' },
    { kind: 'tagged-nested', src: 'tag`outer ${inner`x ${y}`}`', want: 'accept' },
    { kind: 'grouped-hole', src: '`group ${((x+1))}`', want: 'accept' },
  ];
  const templateLines = runBatch(templateBin, templateWitnesses.map((w) => w.src));
  let templateAcceptBad = 0;
  let templateIsoBad = 0;
  let templateCompared = 0;
  let dualProductOk = false;
  for (let i = 0; i < templateWitnesses.length; i++) {
    const witness = templateWitnesses[i]!;
    const tsCst = templateTs.parse(templateTs.tokenize(witness.src)) !== null;
    const tsAst = templateTs.parseAst(witness.src);
    const rustOk = templateLines[i]!.startsWith('A\t');
    const wantOk = witness.want === 'accept';
    if (tsCst !== wantOk || (tsAst !== null) !== wantOk || rustOk !== wantOk) {
      templateAcceptBad++;
      continue;
    }
    if (wantOk) {
      templateCompared++;
      const rust = stripSpans(JSON.parse(templateLines[i]!.slice(2)));
      const tsNeutral = stripSpans(tsAst);
      if (JSON.stringify(rust) !== JSON.stringify(tsNeutral)) templateIsoBad++;
      if (witness.kind === 'complex-hole') {
        dualProductOk = JSON.stringify(rust).includes('"BinaryExpression"');
      }
    }
  }
  // Unterminated templates fail in tokenize (TS throw ≡ Rust panic) before parse — separate probe.
  const unterminated = '`oops ${name}';
  let tsLexThrow = false;
  try { templateTs.tokenize(unterminated); } catch { tsLexThrow = true; }
  let rustLexPanic = false;
  try {
    execFileSync(templateBin, {
      input: unterminated,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error instanceof Error ? String(error) : String(error);
    rustLexPanic = /Unterminated template literal/.test(detail);
  }
  check(
    'SH3-3 template witnesses TS↔Rust acceptance',
    templateWitnesses.length >= 8 && templateAcceptBad === 0 && tsLexThrow && rustLexPanic,
    `${templateWitnesses.length - templateAcceptBad}/${templateWitnesses.length} + unterminated throw/panic (${templateWitnesses.map((w) => w.kind).join(', ')}, unterminated)`,
  );
  check(
    'SH3-3 template witnesses TS↔Rust AST isomorphism + dual product',
    templateIsoBad === 0 && dualProductOk,
    `${templateCompared - templateIsoBad}/${templateCompared}, Expr product=${dualProductOk}`,
  );

  let failFast = '';
  try {
    emitRust(typescriptGrammar, { shape: typescriptShape });
  } catch (error) {
    failFast = error instanceof Error ? error.message : String(error);
  }
  const unsupportedCount = Number(failFast.match(/shape rust emit: (\d+) unsupported construct/)?.[1] ?? 0);
  const items = failFast.split('\n').map((line) => {
    const m = line.match(/^\s+([^:]+): (.+)$/);
    return m ? m[2]! : null;
  }).filter((x): x is string => !!x);
  let rdStep = 0;
  let pratt = 0;
  let custom = 0;
  let template = 0;
  let other = 0;
  for (const c of items) {
    if (c.startsWith('step:')) rdStep++;
    else if (c.includes('template')) template++;
    else if (c.startsWith('shape:custom') || c.startsWith('choice-arm:custom') || c.includes(':custom:')) custom++;
    else if (c.startsWith('pratt-')) pratt++;
    else other++;
  }
  check(
    'TypeScript full shape fails fast at emit time',
    unsupportedCount === 60 && rdStep === 0 && pratt === 0 && custom === 60 && template === 0 && other === 0 &&
      (pratt + custom + template) === unsupportedCount &&
      !failFast.toLowerCase().includes('panic'),
    `${unsupportedCount} unsupported (RD-step=${rdStep} Pratt=${pratt} custom=${custom} template=${template} other=${other})`,
  );

  const total = pass + fail;
  console.log(`shape-rust: ${pass}/${total} checks passed`);
  if (fail) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
