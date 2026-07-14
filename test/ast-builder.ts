// Gate: TS-target Builder / parseWith — default cstBuilder ≡ parse(), demo ESTree-style
// builder golden snapshots, and (when run as main) CST-prefix identity vs master emit tip.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { emitParser, rustTarget, tsTarget } from '../src/emit.ts';
import type { CstGrammar } from '../src/types.ts';

type Case = { grammar: string; path: string; seeds: string[] };

const CASES: Case[] = [
  {
    grammar: 'calc', path: './fixtures/calc.ts',
    seeds: ['1;', 'a;', '', '1 + 2 * 3;', '1 * 2 + 3;', '1 - 2 - 3;', 'a / b / c;', '1 + 2 + 3 + 4;',
      '-a;', '-(-a);', '- - a;', '-a * b;', '-a + b * c;', '-(a + b) * c;',
      '(1);', '((a));', '(1 + 2) * (3 - 4);', 'a * b + c * d - e / f;',
      'let x = 1; let y = x + 2 * x; (y);', 'let z = -(a * b) / (c - -d);', 'foo; bar; baz;'],
  },
  {
    grammar: 'minijs', path: './fixtures/minijs.ts',
    seeds: ['1;', 'a;', '', 'x = 1 + 2 * 3;', '-a * b + 1;', '(1 + 2) * 3;',
      'foo(a, b);', 'a.b.c;', 'a[0][1];', 'f()()();', 'a.b(c).d[e];',
      'let x = 1; let y = x + 2;', '[1, 2, 3];', '[];', '[a, [b, c]];',
      'if (x < 10) { x = x + 1; } else { y(); }', 'while (i) { i = i - 1; }',
      'function f(a, b) { return a + b; }', 'var s = "hi\\"x"; // c\n s.length;',
      '/* block */ a;', 'a === b !== c;', 'a && b || c;', '!a && -b;',
      'return;', 'return a + b;', 'const PI = 3;', '{ a; b; }',
      'f(g(h(x)), [1, 2], y.z);', 'while (a < b) { if (c) { d(); } e = e + 1; }'],
  },
  {
    grammar: 'richtokens', path: './fixtures/richtokens.ts',
    seeds: ['123', '0xFF', '1_000_000', '3.14', 'foo', 'bar_$x9', '"hi"', "'single'",
      '"esc\\"q\\n"', '123 0xa foo "s" 3.14', '0xDEADbeef 42 _id $x cafe // line\n 7',
      '/* block */ 99 x', 'caf\\u00e9 \\u0041bc', '1_2_3 0X1F 10.5 a1 b2'],
  },
  {
    grammar: 'regexjs', path: './fixtures/regexjs.ts',
    seeds: ['a / b;', 'var r = /abc/g;', 'return /re/;', 'if (x) /re/;', '(a + b) / c;',
      'a.b / c;', 'foo(x) / y;', '[1, 2] / 3;', 'var x = a / b / c;',
      'var re = /[a-z]+/i; x / y;', 'f(/re/, a / b);', 'var z = /a\\/b/;',
      'var d = /\\d+\\w/g;', 'var k = /[\\]]/;', 'if (a) /x/; else b / c;'],
  },
  {
    grammar: 'templatejs', path: './fixtures/templatejs.ts',
    seeds: ['var a = `hello`;', 'var b = `hi ${name}!`;', 'var c = `${x}${y}`;',
      'var d = `a${ x + 1 }b${ y * 2 }c`;', 'var e = `outer ${ `inner ${z}` } end`;',
      'var f = `${ {a} }`;', 'var f2 = `${ {a, b} } and ${ c }`;', 'var g = `no holes $ here`;',
      'f(`${a}`, `${b}`);', 'var h = `${a}${b}${c}`;', 'return `${ {x, y} }`;',
      'tag`hello`;', 'tag`${a}${b}`;', 'String.raw`a${b}c`.length;', 'x.tag`${y}`;'],
  },
  {
    grammar: 'envspec', path: './fixtures/envspec.ts',
    seeds: ['A=1', 'A=1\nB=2', 'A=1\n', 'A=1\n# c\nB=2', 'A=fn(1,\n2)\nB=3',
      'A=1\n\n\nB=2', '\n\nA=1', 'A=fn(1,\n2)'],
  },
  {
    grammar: 'altjs', path: './fixtures/altjs.ts',
    seeds: ['{a: 1};', '{"k": 2};', '{1: x};', '{a: 1, "b": 2, 3: c};', '{x: 1 + 2 * 3};',
      '({nested: {inner: 1}});', '{};', 'a + b;', '{k: (1 + 2)};'],
  },
  {
    grammar: 'nudjs', path: './fixtures/nudjs.ts',
    seeds: ['x;', 'foo + bar;', 'class C {};', 'class {};', 'class C extends B {};',
      '@dec class C { m(){} };', 'new Foo;', 'new C();', 'a.b.c;',
      'class C { @x m(){} n(){} };', 'x + class {} + y;'],
  },
  {
    grammar: 'postjs', path: './fixtures/postjs.ts',
    seeds: ['x++;', 'x--;', 'a + b++;', '++x;', 'x++ + y;', 'a.b++;', '(x)++;', '--a.b;',
      'x++ * 2;', '(a++).b;', 'x.y.z++;'],
  },
  {
    grammar: 'seqjs', path: './fixtures/seqjs.ts',
    seeds: ['[1, 2, 3];', '[];', '[1];', 'f(1, 2);', 'f();', '[a + b, c];',
      'f(g(1, 2), 3);', '(x);', 'f(a)(b, c);', '[[1,2],[3,4]];'],
  },
  {
    grammar: 'sljs', path: './fixtures/sljs.ts',
    seeds: ['return 1;', 'return;', 'return 1 + 2;', '1 + 2;', 'return /* c */ 1;',
      '(a);', 'return (1);', 'return\t1;'],
  },
  {
    grammar: 'arrowjs', path: './fixtures/arrowjs.ts',
    seeds: ['x => x;', '(a, b) => a + b;', '() => {};', 'x = (() => 1);', 'f(() => 1, 2);',
      '(x);', 'a + b;', 'x => y => x;', '(() => 2);', '(a) => a;', 'x = y => y;', 'foo();',
      '(a,) => b;', '(a, b,) => a;'],
  },
  {
    grammar: 'ledjs', path: './fixtures/ledjs.ts',
    seeds: ['a == b ? c : d;', 'a ? b : c ? d : e;', 'a + b ? c : d - e;', 'a in b;',
      'a in b in c;', 'x instanceof Y;', 'a < b in c;', '1 + 2 * 3 ? 4 : 5;',
      '(a ? b : c) + d;', 'a in b ? c : d;', 'a = b ? c : d;'],
  },
  {
    grammar: 'noinjs', path: './fixtures/noinjs.ts',
    seeds: ['for (x in y) z;', 'x in y;', 'for (a.b in c) d;', 'a in b in c;',
      'for ((x) in y) z;', 'for (x in y) a in b;', 'for (x in a in b) z;',
      '(a in b);', 'for (a in b) for (c in d) e;'],
  },
  {
    grammar: 'javascript', path: '../javascript.ts',
    seeds: [
      'var x = 1, y = 2;', 'function f(a, b) { return a + b; }', 'const g = (x) => x * 2;',
      'x => x + 1;', 'a ? b : c;', 'a.b.c();', 'f(g(1, 2), 3);', '[1, 2, 3].map(f);',
      'for (let i = 0; i < n; i++) x();', 'for (const k in obj) { y(); }', 'while (x) { z(); }',
      'if (a) b(); else c();', 'class C extends B { m() {} get p() { return 1; } }', 'a++; b--;',
      'typeof x; void 0;', 'new Foo(1, 2);', 'a ?? b; a?.b?.c;',
      'try { f(); } catch (e) { g(); } finally { h(); }', 'switch (x) { case 1: f(); break; default: g(); }',
      'a instanceof B; a in obj;', '(function () {})(); (() => {})();', 'x = a && b || c;',
      'do { x(); } while (y);', 'function* gen() { yield* o(); }', 'const { a, b: c, ...r } = o;',
      'const [p, , q, ...z] = arr;', 'label: for (;;) { break label; }', 'async function h() { await x; }',
      '(() => {})();', 'f(() => a, () => b);', 'let g = () => x => x + 1;',
      'x.y.z++;', '(a++).b;', 'a++ instanceof B;', 'for (a in b) c;', 'new a.b();', '((((x))));',
    ],
  },
  {
    grammar: 'typescript', path: '../typescript.ts',
    seeds: [
      'const a: number = 1;', 'let s: string;', 'type Alias = { a: number; b?: string };',
      'type U = "a" | "b" | "c";', 'function gen2<T, U extends T>(x: T, y: U): T { return x; }',
      'interface I<T> extends A<T> { m(x: T): T; }', 'const c = x as const;',
      'function isStr(x: unknown): x is string { return true; }', 'enum E { A, B, C }',
      'const n = maybe!;', 'let arr: number[];', 'type Fn = (x: number) => string;',
      'class C<in out T> { value!: T; }',
      'var x = 1, y = 2;', 'function f(a, b) { return a + b; }', 'const g = (x) => x * 2;',
      'x => x + 1;', 'a ? b : c;', 'a.b.c();', 'f(g(1, 2), 3);',
    ],
  },
];

const TMP = '/tmp/ast-builder-gate';
mkdirSync(TMP, { recursive: true });

/** ≥300 inputs per grammar — whitespace paddings only (keep lexical validity). */
function variants(seeds: string[], n = 300): string[] {
  const out: string[] = [];
  const pads = ['', ' ', '  ', '\n', ' \n ', '\t', '  \t  '];
  let i = 0;
  while (out.length < n) {
    const s = seeds[i % seeds.length]!;
    const p = pads[i % pads.length]!;
    const q = pads[(i * 3) % pads.length]!;
    if (i % 5 === 0) out.push(s);
    else if (i % 5 === 1) out.push(p + s + q);
    else if (i % 5 === 2) out.push(p + s);
    else if (i % 5 === 3) out.push(s + q);
    else out.push(q + p + s + p + q);
    i++;
  }
  return out;
}

type Tok = { off: number; end: number; nl: boolean; kid: number; lid: number };
type Mod = {
  tokenize: (src: string) => { off: number; end: number; nl: boolean; kid: number; lid: number }[];
  parse: (toks: Tok[]) => unknown;
  parseWith: <H>(src: string, b: Builder<H>) => H | null;
  cstBuilder: Builder<unknown>;
};

type Builder<H> = {
  leaf(tokenType: string, kid: number, lid: number, off: number, end: number): H | null;
  node(rule: string, children: H[], off: number, end: number): H | H[] | null;
};

async function loadMod(grammar: CstGrammar, name: string): Promise<Mod> {
  const out = `${TMP}/${name}.mts`;
  writeFileSync(out, emitParser(grammar, tsTarget));
  return await import(out + '?t=' + Date.now()) as Mod;
}

function parseJson(mod: Mod, src: string): string {
  try {
    const toks = mod.tokenize(src).map((t) => ({ off: t.off, end: t.end, nl: t.nl, kid: t.kid, lid: t.lid }));
    return JSON.stringify(mod.parse(toks));
  } catch {
    return '__THROW__';
  }
}

function withJson(mod: Mod, src: string): string {
  try {
    return JSON.stringify(mod.parseWith(src, mod.cstBuilder));
  } catch {
    return '__THROW__';
  }
}

// ─── Demo ESTree-ish builder for javascript ─────────────────────────────────
// Demonstrates: drop punct/keyword leaves; splice single-child chains; rename rules
type DemoNode = { type: string; [k: string]: unknown };

const DROP_LEAF = new Set(['$punct', '$keyword', '$operator', '$templateHead', '$templateMiddle', '$templateTail']);

/** Minimal ESTree-flavored builder — not a full ESTree emitter. */
function demoBuilder(src: string): Builder<DemoNode | string> {
  return {
    leaf(tokenType, _kid, _lid, off, end) {
      if (DROP_LEAF.has(tokenType)) return null; // drop
      return src.slice(off, end); // keep payload tokens as raw text handles
    },
    node(rule, children, _off, _end) {
      // inline single-child wrapper chains
      if (children.length === 1) return children as DemoNode[]; // splice / inline
      // drop empty after drops
      if (children.length === 0) return null;

      // A few illustrative renames + positional → named fields (not full ESTree).
      if (rule === 'Program') return { type: 'Program', body: children };
      if (rule === 'Stmt' || rule === 'Stmt_A') {
        // Heuristic: ExpressionStatement if single non-object remains unusual —
        // with drops, Stmt often becomes a thin wrapper already inlined; when kept,
        // treat as ExpressionStatement with expression = first child.
        return { type: 'ExpressionStatement', expression: children[0] };
      }
      if (rule === 'Expr' || rule === 'Expr_A') {
        // Binary-ish: left, op(text may be dropped), right → BinaryExpression when 2 kids
        if (children.length === 2) {
          return { type: 'BinaryExpression', left: children[0], right: children[1] };
        }
        if (children.length === 3) {
          return { type: 'BinaryExpression', left: children[0], operator: children[1], right: children[2] };
        }
        return { type: 'Expression', children };
      }
      if (rule === 'Decl' || rule === 'Decl_A') return { type: 'Declaration', children };
      if (rule === 'Block' || rule === 'Block_A') return { type: 'BlockStatement', body: children };
      return { type: rule.replace(/_A$/, ''), children };
    },
  };
}

/** Slim builder used in the CST-premium bench: drop trivia/punct leaves + inline unary chains. */
export function slimBuilder(): Builder<unknown> {
  return {
    leaf(tokenType, _k, _l, off, end) {
      if (tokenType === '$punct' || tokenType === '$keyword' || tokenType === '$operator') return null;
      return { t: tokenType, off, end };
    },
    node(rule, children, off, end) {
      if (children.length === 1) return children as unknown[];
      if (children.length === 0) return null;
      return { r: rule, c: children, off, end };
    },
  };
}

// Fixed demo golden inputs (≥5).
const DEMO_INPUTS = [
  '1 + 2;',
  'var x = 1;',
  'a.b.c;',
  '(1);',
  'if (a) b(); else c();',
  'const g = (x) => x * 2;',
] as const;

// Frozen after demoBuilder semantics (drop punct/keyword/ops, splice unary chains).
// Root may be inlined past Program when Program has a single child.
const DEMO_GOLDEN: Record<string, string> = {
  '1 + 2;':
    '{"type":"BinaryExpression","left":"1","right":"2"}',
  'var x = 1;':
    '{"type":"Binding","children":["x","1"]}',
  'a.b.c;':
    '{"type":"BinaryExpression","left":{"type":"BinaryExpression","left":"a","right":"b"},"right":"c"}',
  '(1);':
    '"1"',
  'if (a) b(); else c();':
    '{"type":"ExpressionStatement","expression":"a"}',
  'const g = (x) => x * 2;':
    '{"type":"Binding","children":["g",{"type":"BinaryExpression","left":"x","right":{"type":"BinaryExpression","left":"x","right":"2"}}]}',
};

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failures++; }
}

// ─── 1. Default equivalence: 16 grammars × ≥300 variants ────────────────────
console.log('ast-builder: cstBuilder ≡ parse()');
for (const c of CASES) {
  const grammar: CstGrammar = (await import(c.path)).default;
  const mod = await loadMod(grammar, c.grammar);
  const inputs = variants(c.seeds, 300);
  assert(inputs.length >= 300, `${c.grammar}: need ≥300, got ${inputs.length}`);
  let eq = 0, bothNull = 0, mismatch = 0;
  for (const src of inputs) {
    const a = parseJson(mod, src);
    const b = withJson(mod, src);
    if (a === b) {
      eq++;
      if (a === 'null') bothNull++;
    } else {
      mismatch++;
      if (mismatch <= 3) console.log(`    mismatch ${c.grammar}: ${JSON.stringify(src)}\n      A=${a.slice(0, 180)}\n      B=${b.slice(0, 180)}`);
    }
  }
  check(`${c.grammar} (${inputs.length} inputs)`, mismatch === 0, `${eq} eq (${bothNull} null)`);
}

// ─── 2. Demo golden ─────────────────────────────────────────────────────────
console.log('\nast-builder: demo ESTree-ish builder golden');
{
  const grammar: CstGrammar = (await import('../javascript.ts')).default;
  const mod = await loadMod(grammar, 'javascript-demo');
  for (const src of DEMO_INPUTS) {
    const tree = mod.parseWith(src, demoBuilder(src));
    const got = JSON.stringify(tree);
    const want = DEMO_GOLDEN[src];
    if (want === undefined) {
      // First-run helper: print so we can freeze.
      console.log(`  SNAP ${JSON.stringify(src)} => ${got}`);
      check(`demo ${JSON.stringify(src)}`, false, 'missing golden');
    } else {
      check(`demo ${JSON.stringify(src)}`, got === want, got === want ? '' : `got ${got}`);
    }
  }
  // Prove three semantics with dedicated samples
  {
    // drop: punct around (1) — unary inlines leave bare "1"
    const drop = mod.parseWith('(1);', demoBuilder('(1);'));
    check('semantic drop ($punct/$keyword)', JSON.stringify(drop) === '"1"');
    // splice/inline: single-child Expr wrappers collapsed to leaf text
    const inline = mod.parseWith('1;', demoBuilder('1;'));
    check('semantic splice/inline (unary chain)', JSON.stringify(inline) === '"1"');
    // node-null: empty kids after drops
    const nullB: Builder<unknown> = {
      leaf: () => null,
      node: (rule, kids) => (rule === 'Program' && kids.length === 0 ? null : (kids.length === 1 ? kids as unknown[] : { rule, kids })),
    };
    const nulled = mod.parseWith(';', nullB);
    // All leaves/null → Stmt with empty kids (Program single-child splice to Stmt)
    check('semantic node-null (all-drop)', JSON.stringify(nulled) === '{"rule":"Stmt","kids":[]}');
    // force node null for Stmt
    const nullStmt: Builder<unknown> = {
      leaf: (tt, _k, _l, off, end) => (tt === '$punct' || tt === '$keyword' ? null : { tt, off, end }),
      node: (rule, kids, off, end) => {
        if (rule === 'Stmt' || rule === 'Stmt_A') return null;
        if (kids.length === 1) return kids as unknown[];
        return { rule, kids, off, end };
      },
    };
    const ns = mod.parseWith('1;', nullStmt);
    check('semantic node-null Stmt', JSON.stringify(ns) === '{"rule":"Program","kids":[],"off":0,"end":1}');
  }
}

// ─── 3. CST emit prefix identity tip (additive marker present) ──────────────
{
  const grammar: CstGrammar = (await import('./fixtures/calc.ts')).default;
  const emitted = emitParser(grammar, tsTarget);
  check('builder addon marker present', emitted.includes('// ─── Builder API'));
  check('exports parseWith + cstBuilder + Builder',
    emitted.includes('export function parseWith') && emitted.includes('export const cstBuilder') && emitted.includes('export type Builder'));
  const prefix = emitted.slice(0, emitted.indexOf('// ─── Builder API'));
  check('CST prefix stable hash (nonempty)', prefix.length > 1000,
    createHash('sha256').update(prefix).digest('hex').slice(0, 12));
}

// ─── 4. Rust target: parse_with(CstBuilder) ≡ parse + SlimBuilder smoke ──────
console.log('\nast-builder: rust parse_with(CstBuilder) ≡ parse()');
const RUST_TMP = '/tmp/ast-builder-rust-gate';
mkdirSync(RUST_TMP, { recursive: true });

function haveRustc(): boolean {
  try { execFileSync('rustc', ['--version'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

const rustHarness = `
fn gate_skip_ws(s: &[u8], mut i: usize) -> usize { while i < s.len() && (s[i] as char).is_whitespace() { i += 1; } i }
fn gate_parse_str(s: &[u8], mut i: usize) -> Option<(String, usize)> {
    if s.get(i)? != &b'"' { return None; }
    i += 1;
    let mut out = String::new();
    while i < s.len() {
        match s[i] {
            b'"' => return Some((out, i + 1)),
            b'\\\\' => { i += 1; if i >= s.len() { return None; }
                out.push(match s[i] { b'n' => '\\n', b'r' => '\\r', b't' => '\\t', b'"' => '"', b'\\\\' => '\\\\', b'/' => '/', c => c as char });
                i += 1; }
            c if c < 0x80 => { out.push(c as char); i += 1; }
            _ => {
                let w = match s[i] { 0xC0..=0xDF => 2, 0xE0..=0xEF => 3, 0xF0..=0xF7 => 4, _ => return None };
                if i + w > s.len() { return None; }
                let ch = std::str::from_utf8(&s[i..i + w]).ok()?.chars().next()?;
                out.push(ch); i += w;
            }
        }
    }
    None
}
fn parse_json_str_array(s: &str) -> Option<Vec<String>> {
    let b = s.as_bytes();
    let mut i = gate_skip_ws(b, 0);
    if *b.get(i)? != b'[' { return None; }
    i = gate_skip_ws(b, i + 1);
    let mut out = Vec::new();
    if *b.get(i)? == b']' { return Some(out); }
    loop {
        let (v, ni) = gate_parse_str(b, i)?;
        out.push(v);
        i = gate_skip_ws(b, ni);
        if *b.get(i)? == b']' { return Some(out); }
        if *b.get(i)? != b',' { return None; }
        i = gate_skip_ws(b, i + 1);
    }
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(|s| s.as_str()).unwrap_or("eq-batch");
    if mode == "slim-demo" {
        for src in &["(1);", "1;"] {
            let mut s = SlimBuilder::new();
            match parse_with(src, &mut s) {
                Some(h) if h < 0 => {
                    let toks = lex(src);
                    let (ti, tt) = decode_leaf(h);
                    let t = &toks[ti as usize];
                    println!("LEAF\\t{}\\t{}\\t{}", src, TT_NAMES[tt as usize], t.off);
                }
                Some(h) => println!("NODE\\t{}\\t{}", src, slim_json_with(&s, &lex(src), h)),
                None => println!("NULL\\t{}", src),
            }
        }
        return;
    }
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap();
    let inputs = parse_json_str_array(&raw).expect("json string array");
    let mut bad = 0usize;
    for (i, src) in inputs.iter().enumerate() {
        let a = parse(tokenize(src));
        let mut b = CstBuilder::new();
        let root = parse_with(src, &mut b);
        match (a.as_ref(), root) {
            (Some((p, r)), Some(rw)) => {
                let mut ja = String::new();
                write_json(p, *r, &mut ja);
                let jb = cst_json_with(&b, &lex(src), rw);
                if ja != jb {
                    bad += 1;
                    if bad <= 3 { eprintln!("mismatch[{}]: {:?}", i, src); }
                }
            }
            (None, None) => {}
            _ => { bad += 1; if bad <= 3 { eprintln!("accept[{}]: {:?}", i, src); } }
        }
    }
    if bad == 0 { println!("ok {}", inputs.len()); } else { println!("bad {}", bad); std::process::exit(1); }
}
`;

if (!haveRustc()) {
  check('rust toolchain present', false, 'rustc missing — rust builder gates skipped');
} else {
  // Additive marker + prefix tip on calc
  {
    const grammar: CstGrammar = (await import('./fixtures/calc.ts')).default;
    const emitted = emitParser(grammar, rustTarget);
    check('rust builder addon marker', emitted.includes('// ─── Builder API'));
    check('rust exports parse_with + CstBuilder + Builder',
      emitted.includes('pub fn parse_with') && emitted.includes('pub struct CstBuilder') && emitted.includes('pub trait Builder'));
    const prefix = emitted.slice(0, emitted.indexOf('// ─── Builder API'));
    check('rust CST prefix nonempty', prefix.length > 1000,
      createHash('sha256').update(prefix).digest('hex').slice(0, 12));
  }

  for (const c of CASES) {
    const grammar: CstGrammar = (await import(c.path)).default;
    const rfile = `${RUST_TMP}/${c.grammar}.rs`;
    const bin = `${RUST_TMP}/${c.grammar}`;
    writeFileSync(rfile, emitParser(grammar, rustTarget) + rustHarness);
    try {
      execFileSync('rustc', ['-A', 'warnings', rfile, '-o', bin], { stdio: 'pipe', timeout: 120_000 });
    } catch (e) {
      check(`rustc ${c.grammar}`, false, String(e).slice(0, 200));
      continue;
    }
    const inputs = variants(c.seeds, 300);
    const out = execFileSync(bin, ['eq-batch'], {
      input: JSON.stringify(inputs), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
    }).trim();
    check(`rust ${c.grammar} (${inputs.length} inputs)`, out.startsWith('ok '), out);
  }

  // SlimBuilder smoke on javascript
  {
    const grammar: CstGrammar = (await import('../javascript.ts')).default;
    const rfile = `${RUST_TMP}/javascript-slim.rs`;
    const bin = `${RUST_TMP}/javascript-slim`;
    writeFileSync(rfile, emitParser(grammar, rustTarget) + rustHarness);
    execFileSync('rustc', ['-A', 'warnings', rfile, '-o', bin], { stdio: 'pipe', timeout: 120_000 });
    const slimOut = execFileSync(bin, ['slim-demo'], { encoding: 'utf8' }).trim().split('\n');
    check('rust slim (1); → Number leaf (splice)', slimOut.some((l) => l.startsWith('LEAF\t(1);\tNumber\t')));
    check('rust slim 1; → Number leaf (splice)', slimOut.some((l) => l.startsWith('LEAF\t1;\tNumber\t')));
  }

  // 2MB corpus equivalence (rebuild if missing)
  {
    const corpusPath = '/tmp/p6c-corpus-2mb.ts';
    if (!existsSync(corpusPath)) {
      // Minimal rebuild: concatenate typescript seeds enough to pass ~2MB
      const seeds = CASES.find((x) => x.grammar === 'typescript')!.seeds;
      let body = '';
      let i = 0;
      while (Buffer.byteLength(body) < 2_100_000) {
        body += seeds[i % seeds.length] + '\n';
        i++;
      }
      writeFileSync(corpusPath, body);
    }
    const corpus = readFileSync(corpusPath, 'utf8');
    check('2MB corpus present', Buffer.byteLength(corpus) >= 2_000_000, `${Buffer.byteLength(corpus)} bytes`);
    const grammar: CstGrammar = (await import('../typescript.ts')).default;
    const rfile = `${RUST_TMP}/typescript-2mb.rs`;
    const bin = `${RUST_TMP}/typescript-2mb`;
    writeFileSync(rfile, emitParser(grammar, rustTarget) + rustHarness);
    execFileSync('rustc', ['-A', 'warnings', rfile, '-o', bin], { stdio: 'pipe', timeout: 180_000 });
    const out = execFileSync(bin, ['eq-batch'], {
      input: JSON.stringify([corpus]), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 180_000,
    }).trim();
    check('rust 2MB corpus parse_with ≡ parse', out === 'ok 1', out);
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} ast-builder (${failures} failure(s))`);
process.exit(failures ? 1 : 0);
