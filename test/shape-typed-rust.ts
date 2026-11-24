// The typed Rust shape-building parser (emitParser(g, rustTarget, { shape }), src/rust-shape.ts)
// ≡ the evaluator (src/shape2-eval.ts evaluateShape over the interpreter's CST): its AST, written
// as JSON by the per-kind typed writers, is the evaluator's value, on each row (accepted texts;
// a rejected text is rejected; a missing value is missing). What it catches that no other check
// does: a typed Rust build that differs from the reference (a construct, a type, a writer).
// Needs rustc (on this box through the rustlink wrapper: PATH=$SHARED/rustlink/bin:$PATH).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    std::panic::set_hook(Box::new(|_| {}));
    std::thread::Builder::new().stack_size(512 << 20).spawn(move || {
        for src in all.split('\\u{0}') {
            let line = match std::panic::catch_unwind(|| match parse_shape(src) {
                Ok(a) => format!("A\\t{}", a.to_json()),
                Err(e) if e == "syntax error" => "R\\t".to_string(),
                Err(e) => format!("M\\t{}", e),
            }) { Ok(l) => l, Err(e) => format!("P\\t{}", e.downcast_ref::<String>().cloned().or(e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()) };
            println!("{}", line);
        }
    }).unwrap().join().unwrap();
}
`;
/** Keys sorted (a kind's fields are the union over its terms, so a writer's key order is the union's). */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
/** The first path at which two JSON values differ. */
const firstDiff = (a: unknown, b: unknown, at = ''): string | null => {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`); if (d) return d; }
  }
  return `${at}: rust ${JSON.stringify(a)?.slice(0, 160)} eval ${JSON.stringify(b)?.slice(0, 160)}`;
};
const want = (shape: AnyShape, src: string): string => {
  try { return `A\t${JSON.stringify(canon(JSON.parse(JSON.stringify(evaluateShape(shape, createParser(shape.source).parse(src), src) ?? null))))}`; }
  catch (e) { return /Parse error|Unexpected character/.test(String(e)) ? 'R' : 'M'; }
};
let failures = 0, rows = 0;
const kinds = new Map<string, number>();
function check(name: string, shape: AnyShape, srcs: string[], quiet = false): void {
  const file = join(TMP, `${name}.rs`), bin = join(TMP, name);
  writeFileSync(file, emitParser(shape.source, rustTarget, { shape }) + MAIN);
  cachedRustc(['-A', 'warnings', '-C', 'opt-level=1', file, '-o', bin], { timeout: 600_000 });
  const out = execFileSync(bin, { input: srcs.join('\0') }).toString().trimEnd().split('\n');
  srcs.forEach((src, i) => {
    const line = out[i] ?? '';
    // A lex error panics in parse_with (the interpreter throws it too): a rejection.
    const got = /^P\tUnexpected character/.test(line) ? 'R' : line.startsWith('A\t') ? `A\t${JSON.stringify(canon(JSON.parse(line.slice(2))))}` : line.slice(0, 1);
    const w = want(shape, src);
    rows++; kinds.set(`${name} ${got.slice(0, 1)}`, (kinds.get(`${name} ${got.slice(0, 1)}`) ?? 0) + 1);
    if (got !== w) { failures++; if (quiet && failures > 20) return; console.error(`✗ ${name} ${JSON.stringify(src).slice(0, 200)}:\n    ${got[0] === 'A' && w[0] === 'A' ? firstDiff(JSON.parse(got.slice(2)), JSON.parse(w.slice(2))) : `rust ${line.slice(0, 300)}\n    eval ${w.slice(0, 300)}`}`); }
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

// The tsc expression shape's synthesized subset (every inherited attribute at its default) on the
// TypeScript conformance expressions (the pinned corpus; skipped when absent): whole files.
{
  const dir = '/tmp/ts-repo/tests/cases/conformance/expressions';
  if (existsSync(dir)) {
    const files: string[] = [];
    const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts')) files.push(p); } };
    walk(dir);
    const tscSyn = (await import('./fixtures/shape-tsc-synthesized.ts')).default;
    check('tsc-synthesized', tscSyn, files.map((f) => readFileSync(f, 'utf8')), true);
    // Escaped identifiers (the corpus has none): an IdentifierName is its span only while no
    // identifier of the source has an escape (cookIdentSpan); backslashes in strings and regular
    // expressions do not count, one escaped identifier anywhere sends every identifier to the cook.
    check('tsc-escapes', tscSyn, ['"a\\nb"; /x\\d/; abc;', '\\u0061bc; x.\\u{62}c; abc;', 'f("\\t", y); \\u{78}y = 1;'], true);
  } else console.log('  (conformance/expressions absent: run $SHARED/restore-corpus.sh; the tsc rows skipped)');
}

if (failures) { console.error(`\n✗ shape-typed-rust: ${failures} of ${rows} rows differ`); process.exit(1); }
console.log(`✓ shape-typed-rust: the typed Rust AST ≡ evaluateShape on ${rows} rows (${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}; A built, R rejected, M missing)`);
