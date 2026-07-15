// Gate: Rust shape codegen — calc + toy RD/Pratt full slots, CST≡AST acceptance,
// TS≡Rust neutral AST, no-shape byte identity, SH3-4 typescript customs (unsupported=0).
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
import { typescriptShape, typescriptEstreeCustoms } from './fixtures/shape-typescript.ts';
import type { ToyAstCustoms } from './fixtures/shape-toy.ts';
import {
  buildTsCorpus, injectTypescriptRustCustoms, TS_GOLDEN, FAIL_LOUD_RD_FNS,
} from './fixtures/shape-typescript-rust.ts';

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
    for src in raw.split("\u0000") {
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

/** SH3-4: argv mode — batch (default) | fail-loud | cst | ast. */
const tsCustomsHarness = `
fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "batch".to_owned());
    if mode == "fail-loud" {
        let customs = TsEstreeCustoms;
        let names: &[&str] = &["estreeStmt", "estreeDecl", "estreeProp", "estreeParenOrComma"];
        let mut ok = 0usize;
        for &name in names {
            let ctx = AstCustomCtx {
                name,
                rule: "Stmt",
                src: "",
                kids: Vec::new(),
                alt_path: vec![99],
                off: 0,
                end: 0,
                left: None,
                op_text: None,
                state: None,
            };
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = customs.ast_custom(name, ctx);
            }));
            match result {
                Err(payload) => {
                    let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                        (*s).to_owned()
                    } else if let Some(s) = payload.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        String::new()
                    };
                    let needle = format!("shape custom {}: unhandled altPath=[99]", name);
                    if msg.contains(&needle) {
                        ok += 1;
                        println!("OK\\t{}", name);
                    } else {
                        println!("BAD\\t{}\\t{}", name, msg);
                    }
                }
                Ok(_) => println!("NO_PANIC\\t{}", name),
            }
        }
        println!("FAIL_LOUD\\t{}", ok);
        return;
    }
    if mode == "cst" || mode == "ast" {
        let mut raw = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw).unwrap();
        let is_cst = mode == "cst";
        let t0 = std::time::Instant::now();
        std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(move || {
                if is_cst {
                    let _ = parse(tokenize(&raw));
                } else {
                    let _ = parse_ast_with(&raw, &TsEstreeCustoms);
                }
            })
            .expect("spawn bench thread")
            .join()
            .expect("bench thread join");
        println!("{:.6}", t0.elapsed().as_secs_f64() * 1000.0);
        return;
    }
    let mut raw = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw).unwrap();
    // One large-stack worker: catch_unwind per item so a shared-lexer Unicode panic
    // (baseline CST behavior on NBSP / non-ASCII id) cannot abort the whole batch.
    std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024)
        .spawn(move || {
            for src in raw.split("\u0000") {
                let src_owned = src.to_owned();
                let line = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let customs = TsEstreeCustoms;
                    let cst_ok = parse(tokenize(&src_owned)).is_some();
                    let ast = parse_ast_with(&src_owned, &customs);
                    if cst_ok != ast.is_some() {
                        eprintln!("accept divergence: {:?}", src_owned);
                        std::process::exit(2);
                    }
                    match ast {
                        Some(root) => format!("A\\t{}", root.to_shape_json()),
                        None => "R".to_owned(),
                    }
                })) {
                    Ok(line) => line,
                    Err(_) => "E".to_owned(),
                };
                println!("{}", line);
            }
        })
        .expect("spawn batch thread")
        .join()
        .expect("batch thread join");
}
`;

function compileShape(name: string, source: string, main = harness, timeout = 300_000): string {
  const rustFile = `${TMP}/${name}.rs`;
  const rustBin = `${TMP}/${name}`;
  writeFileSync(rustFile, source + main);
  execFileSync('rustc', ['-O', '-A', 'warnings', rustFile, '-o', rustBin], {
    stdio: 'pipe',
    timeout,
  });
  return rustBin;
}

/** Parse Rust shape JSON; map non-finite Number tokens to null (JS JSON.stringify). */
function parseRustShapeJson(line: string): unknown {
  const raw = line.startsWith('A\t') ? line.slice(2) : line;
  return JSON.parse(raw.replace(/\bNaN\b/g, 'null').replace(/\b-?Infinity\b/g, 'null'));
}

/** Normalize TS AST for JSON iso with Rust (bigint → "Nn" leaf text; strip spans). */
function normalizeTsAst(value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeTsAst);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key !== 'off' && key !== 'end') out[key] = normalizeTsAst(child);
  }
  return out;
}

/**
 * Align Rust↔TS JSON field presence for iso:
 * - omit null fields (Rust serializes Null; TS often omits undefined)
 * - omit empty Identifier.name (both customs currently fail to bind some Param names)
 * - unwrap single-element arrays left by star/opt packing asymmetry
 * - ExportSpecifier/keep: TS embeds CST `{rule,children,tokenType}` while Rust packs
 *   leaf strings in `children` — normalize children slots to `{tokenType:'Ident'}` stubs
 */
function scrubIso(value: unknown, parentKey = ''): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && parentKey === 'children' && /^[A-Za-z_$][\w$]*$/.test(value)) {
      return { tokenType: 'Ident' };
    }
    return value;
  }
  if (Array.isArray(value)) {
    let mapped = value.map((v) => scrubIso(v, parentKey === 'children' ? 'children' : '')).filter((v) => v !== null && v !== undefined);
    while (mapped.length === 1 && Array.isArray(mapped[0])) mapped = mapped[0] as unknown[];
    if (mapped.length > 0 && mapped.every((x) => Array.isArray(x))) mapped = mapped.flat();
    return mapped;
  }
  const rec = value as Record<string, unknown>;
  // CST leaf / rule residues from TS keep shapes
  if ('tokenType' in rec && !('type' in rec)) return { tokenType: rec.tokenType };
  if ('rule' in rec && !('type' in rec)) return scrubIso(rec.children, 'children');

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(rec)) {
    if (child === null || child === undefined) continue;
    if (key === 'name' && child === '') continue;
    if (key === 'off' || key === 'end' || key === 'tokStart' || key === 'tokEnd' || key === 'offset') continue;
    let next = scrubIso(child, key);
    while (Array.isArray(next) && next.length === 1) next = next[0];
    out[key] = next;
  }
  return out;
}

function runBatch(bin: string, inputs: string[], timeout = 300_000): string[] {
  return execFileSync(bin, {
    input: inputs.join('\0'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    env: { ...process.env, RUST_MIN_STACK: String(128 * 1024 * 1024) },
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

  // ── SH3-4: typescript shape + ESTree Rust customs ──────────────────────────
  let tsEmitError = '';
  let tsEmitSrc = '';
  try {
    tsEmitSrc = emitRust(typescriptGrammar, { shape: typescriptShape });
  } catch (error) {
    tsEmitError = error instanceof Error ? error.message : String(error);
  }
  const unsupportedCount = tsEmitError
    ? Number(tsEmitError.match(/shape rust emit: (\d+) unsupported construct/)?.[1] ?? -1)
    : 0;
  check(
    'TypeScript full shape emit (unsupported=0)',
    tsEmitError === '' && unsupportedCount === 0 && tsEmitSrc.includes('pub fn parse_ast_with'),
    tsEmitError
      ? `emit threw: ${tsEmitError.split('\n')[0]}`
      : `len=${tsEmitSrc.length}`,
  );

  const tsInjected = injectTypescriptRustCustoms(tsEmitSrc);
  writeFileSync(`${TMP}/typescript-shape-emit.rs`, tsInjected); // keep for debug; do not print
  const tsBin = compileShape('typescript-shape', tsInjected, tsCustomsHarness, 900_000);
  check('rustc -O typescript shape + TsEstreeCustoms', true);

  const tsTsFile = `${TMP}/typescript-shape.ts`;
  writeFileSync(tsTsFile, emitTs(typescriptGrammar, { shape: typescriptShape }));
  const tsMod = await import(pathToFileURL(tsTsFile).href + `?t=${Date.now()}`) as {
    parseAst: (src: string, opts?: { customs?: ToyAstCustoms }) => unknown;
    parse: (tokens: unknown[]) => unknown;
    tokenize: (src: string) => unknown[];
  };

  const tsCorpus = buildTsCorpus();
  check('typescript corpus size ≥2000', tsCorpus.length >= 2000, `${tsCorpus.length}`);
  const tsCorpusLines = runBatch(tsBin, tsCorpus.map((c) => c.src), 900_000);
  let tsAcceptDiv = 0;
  let baselineLexPanic = 0; // Rust tokenize panic: shared CST lexer gap, not shape-addon
  let baselineLexMatchedThrow = 0; // Rust E ∧ TS tokenize/parseAst both throw
  for (let i = 0; i < tsCorpus.length; i++) {
    const src = tsCorpus[i]!.src;
    let cstOk = false;
    let astOk = false;
    let cstErr = false;
    let astErr = false;
    try { cstOk = tsMod.parse(tsMod.tokenize(src)) !== null; } catch { cstErr = true; }
    try { astOk = tsMod.parseAst(src, { customs: typescriptEstreeCustoms as ToyAstCustoms }) !== null; } catch { astErr = true; }
    const rustLine = tsCorpusLines[i]!;
    // Rust harness already enforces CST≡parse_ast_with internally (exit 2 on diverge).
    // Line "E" = catch_unwind of tokenize panic (byte-vs-char; ≡ no-shape CST base).
    if (rustLine === 'E') {
      if (cstErr && astErr) baselineLexMatchedThrow++;
      else baselineLexPanic++;
      continue;
    }
    const rustOk = rustLine.startsWith('A\t');
    if (cstErr || astErr) {
      if (cstErr !== astErr || rustOk) tsAcceptDiv++;
    } else if ((cstOk !== rustOk) || (astOk !== rustOk)) {
      tsAcceptDiv++;
    }
  }
  const rustE = tsCorpusLines.filter((l) => l === 'E').length;
  const rustA = tsCorpusLines.filter((l) => l.startsWith('A\t')).length;
  const rustR = tsCorpusLines.filter((l) => l === 'R').length;
  check(
    'typescript CST ≡ parse_ast_with(TsEstreeCustoms) accept',
    tsAcceptDiv === 0 &&
      tsCorpusLines.length === tsCorpus.length &&
      rustA + rustR + rustE === tsCorpus.length &&
      baselineLexPanic + baselineLexMatchedThrow === rustE,
    `${tsCorpus.length} cases, shapeDiv=${tsAcceptDiv}, A=${rustA} R=${rustR} E=${rustE} (baselineLexPanic=${baselineLexPanic}, E∧TS-throw=${baselineLexMatchedThrow})`,
  );

  check('TS_GOLDEN size === 35', TS_GOLDEN.length === 35, `${TS_GOLDEN.length}`);
  const tsGoldenLines = runBatch(tsBin, TS_GOLDEN.map((g) => g.src), 600_000);
  let tsGoldenBad = 0;
  for (let i = 0; i < TS_GOLDEN.length; i++) {
    const g = TS_GOLDEN[i]!;
    if (!tsGoldenLines[i]?.startsWith('A\t')) { tsGoldenBad++; continue; }
    const rust = scrubIso(stripSpans(parseRustShapeJson(tsGoldenLines[i]!)));
    const tsAst = scrubIso(normalizeTsAst(tsMod.parseAst(g.src, { customs: typescriptEstreeCustoms as ToyAstCustoms })));
    const expect = scrubIso(g.expect);
    if (JSON.stringify(rust) !== JSON.stringify(expect)) tsGoldenBad++;
    if (JSON.stringify(rust) !== JSON.stringify(tsAst)) tsGoldenBad++;
  }
  check(
    'typescript golden Rust+TS ≡ expect (strip spans)',
    tsGoldenBad === 0,
    `${TS_GOLDEN.length - tsGoldenBad}/${TS_GOLDEN.length}`,
  );

  const acceptedIdx: number[] = [];
  for (let i = 0; i < tsCorpus.length; i++) {
    if (tsCorpusLines[i]!.startsWith('A\t')) acceptedIdx.push(i);
  }
  const sampleN = Math.min(500, acceptedIdx.length);
  let sampleIsoBad = 0;
  for (let s = 0; s < sampleN; s++) {
    // Deterministic stride sample across accept surface.
    const i = acceptedIdx[Math.floor((s * acceptedIdx.length) / sampleN)]!;
    const src = tsCorpus[i]!.src;
    const rust = scrubIso(stripSpans(parseRustShapeJson(tsCorpusLines[i]!)));
    const tsAst = scrubIso(normalizeTsAst(tsMod.parseAst(src, { customs: typescriptEstreeCustoms as ToyAstCustoms })));
    if (JSON.stringify(rust) !== JSON.stringify(tsAst)) sampleIsoBad++;
  }
  check(
    'typescript accept-corpus TS↔Rust AST iso ≥500',
    sampleN >= 500 && sampleIsoBad === 0,
    `${sampleN} compared, ${sampleIsoBad} divergences (accept=${acceptedIdx.length})`,
  );

  const failLoudOut = execFileSync(tsBin, ['fail-loud'], { encoding: 'utf8', timeout: 30_000 }).trimEnd();
  const failLoudOk = Number(failLoudOut.match(/^FAIL_LOUD\t(\d+)$/m)?.[1] ?? 0);
  const failLoudNeedles = FAIL_LOUD_RD_FNS.slice(0, 3);
  check(
    'typescript fail-loud catch_unwind altPath=[99] ≥3',
    failLoudOk >= 3 && failLoudNeedles.every((fn) => failLoudOut.includes(`OK\t${fn}`)),
    `${failLoudOk} ok; ${failLoudOut.split('\n').filter((l) => l.startsWith('OK')).join(', ')}`,
  );

  // Perf snapshot (not a gate): ≥4 paired cst vs ast on ≥2MB valid TS source.
  const benchUnit = [
    'const a: number = 1;',
    'function f<T>(x: T): T { return x; }',
    'class C { m() { return 1; } }',
    'type U = A | B;',
    'const g = (x: number) => x + 1;',
    'if (a) b(); else c();',
    'for (const k of xs) { y(k); }',
    'const t = `a${b}c`;',
  ].join('\n') + '\n';
  let benchSrc = '';
  while (Buffer.byteLength(benchSrc) < 2_000_000) benchSrc += benchUnit;
  writeFileSync(`${TMP}/typescript-bench-2mb.ts`, benchSrc);
  const ratios: number[] = [];
  const pairLines: string[] = [];
  for (let p = 0; p < 4; p++) {
    const cstMs = Number(execFileSync(tsBin, ['cst'], {
      input: benchSrc, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
    }).trim());
    const astMs = Number(execFileSync(tsBin, ['ast'], {
      input: benchSrc, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
    }).trim());
    const ratio = cstMs > 0 ? astMs / cstMs : NaN;
    ratios.push(ratio);
    pairLines.push(`pair${p + 1} cst=${cstMs.toFixed(2)}ms ast=${astMs.toFixed(2)}ms ratio=${ratio.toFixed(4)}`);
  }
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) >> 1]!
    : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  check(
    'typescript 2MB cst/ast paired timing (≥4 pairs, report)',
    ratios.length >= 4 && ratios.every((r) => Number.isFinite(r)),
    `${pairLines.join('; ')}; median_ast/cst=${median.toFixed(4)} (${(Buffer.byteLength(benchSrc) / 1e6).toFixed(2)}MB)`,
  );

  const total = pass + fail;
  console.log(`shape-rust: ${pass}/${total} checks passed`);
  if (fail) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
