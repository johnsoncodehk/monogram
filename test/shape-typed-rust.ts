// The typed Rust shape-building parser (emitParser(g, rustTarget, { shape }), src/rust-shape.ts)
// ≡ the evaluator (src/shape2-eval.ts evaluateShape over the interpreter's CST): its AST, written
// as JSON by the per-kind typed writers, is the evaluator's value, on each row (accepted texts;
// a rejected text is rejected; a missing value is missing). What it catches that no other check
// does: a typed Rust build that differs from the reference (a construct, a type, a writer).
// Needs rustc (on this box through the rustlink wrapper: PATH=$SHARED/rustlink/bin:$PATH).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitParser } from '../src/target.ts';
import { rustTarget } from '../src/target-rust.ts';
import { createParser } from '../src/gen-parser.ts';
import { evaluateShape, defineShape } from '../src/shape2-eval.ts';
import { child, node, text } from '../src/shape2-schema.ts';
import { token, rule, defineGrammar, many, plus, oneOf, range, arm, field } from '../src/api.ts';
import { cachedRustc } from './build-cache.ts';
import calcExample from './fixtures/shape-namedcalc.ts';

type AnyShape = Parameters<typeof evaluateShape>[0];
const TMP = join(tmpdir(), 'monogram-shape-typed-rust');
mkdirSync(TMP, { recursive: true });
const MAIN = `
fn main() {
    use std::io::Read;
    let mut all = String::new();
    std::io::stdin().read_to_string(&mut all).unwrap();
    for src in all.split('\\u{0}') {
        match parse_shape(src) {
            Ok(a) => println!("A\\t{}", a.to_json()),
            Err(e) if e == "syntax error" => println!("R\\t"),
            Err(e) => println!("M\\t{}", e),
        }
    }
}
`;
/** Keys sorted (a kind's fields are the union over its terms, so a writer's key order is the union's). */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
const want = (shape: AnyShape, src: string): string => {
  try { return `A\t${JSON.stringify(canon(JSON.parse(JSON.stringify(evaluateShape(shape, createParser(shape.source).parse(src), src) ?? null))))}`; }
  catch (e) { return /Parse error/.test(String(e)) ? 'R' : 'M'; }
};
let failures = 0, rows = 0;
function check(name: string, shape: AnyShape, srcs: string[]): void {
  const file = join(TMP, `${name}.rs`), bin = join(TMP, name);
  writeFileSync(file, emitParser(shape.source, rustTarget, { shape }) + MAIN);
  cachedRustc(['-A', 'warnings', '-C', 'opt-level=1', file, '-o', bin], { timeout: 600_000 });
  const out = execFileSync(bin, { input: srcs.join('\0') }).toString().trimEnd().split('\n');
  srcs.forEach((src, i) => {
    const line = out[i] ?? '';
    const got = line.startsWith('A\t') ? `A\t${JSON.stringify(canon(JSON.parse(line.slice(2))))}` : line.slice(0, 1);
    const w = want(shape, src);
    rows++;
    if (got !== w) { failures++; console.error(`✗ ${name} ${JSON.stringify(src)}:\n    rust ${line.slice(0, 400)}\n    eval ${w.slice(0, 400)}`); }
  });
}

// The doc example's calc shape (docs/SHAPE.md), on shape2-eval's rows for the TypeScript build.
check('namedcalc', calcExample, ['let x = 1 + 2 * y;', '-3; (a - b) / c;', 'x;', '', 'let a = -(1); b * -c - d;', '(((n)));', 'a + ;', 'let = 1;', 'let x = -(1 + y);', 'let z = 12 * 345 / q;']);
// A losing candidate: S.short at `x` is built and beaten by S.long; it is in no value returned.
{
  const ID = token(plus(oneOf(range('a', 'z'))), { identifier: true });
  const WS = token(plus(oneOf(' ')), { skip: true });
  const A = rule(() => [arm('a', ID)]);
  const S = rule(() => [arm('short', field('head', A)), arm('long', field('head', A), '!')]);
  const P = rule(() => [arm('program', many(field('stmt', S)))]);
  const g = defineGrammar({ name: 'losing', tokens: { WS, ID }, rules: { A, S, P }, entry: P });
  check('losing', defineShape(g, { name: 'losing-ast', rules: {
    A: { a: node('A', { name: text('iD') }) },
    S: { short: node('Short', { head: child('head') }), long: node('Long', { head: child('head') }) },
    P: { program: node('P', { body: child('stmt') }) },
  } }), ['x! y', 'x y! z', '']);
}

if (failures) { console.error(`\n✗ shape-typed-rust: ${failures} of ${rows} rows differ`); process.exit(1); }
console.log(`✓ shape-typed-rust: the typed Rust AST ≡ evaluateShape on ${rows} rows (namedcalc, a losing candidate)`);
