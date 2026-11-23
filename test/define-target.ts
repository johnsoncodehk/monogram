// Gate: the shared algorithm core is target-language-agnostic and the portable targets register
// themselves independently.
//
//   1. core modules (algo-ir / relex-family / lex-family / define-target) import no target module, name no
//      target, keep no host switch, and none of their string literals carries punctuation —
//      every operator, delimiter, comment marker and keyword comes from a target's Lowering
//      (point 4 prints the families through a non-C lowering);
//   2. exactly one `defineTarget(...)` call per target module (target-ts / target-go /
//      target-rust), each with its own `Lowering`; no target module imports another target
//      module, an algorithm family, or the IR printer — families arrive via `shared`;
//   3. the registry holds exactly those three targets, each the module's exported target,
//      refuses a second registration under the same name, and a target without a Lowering
//      cannot be handed shared algorithms;
//   4. a test-only S-expression target prints the lex-scan / relex / reuse / recovery families with
//      no C-family surface, and every IR construct comes out as its own printed form.
//
//   node test/define-target.ts
import { readFileSync } from 'node:fs';
import { tsTarget } from '../src/target-ts.ts';
import { goTarget } from '../src/target-go.ts';
import { rustTarget } from '../src/target-rust.ts';
import { defineTarget, registeredTargets } from '../src/define-target.ts';
import { portableIR } from '../src/emit-portable.ts';
import { relexFamily, relexFamilyFns, relexMode } from '../src/relex-family.ts';
import { lexScanFamily } from '../src/lex-family.ts';
import { reuseFamilyFns } from '../src/reuse-family.ts';
import { recoveryFamilyFns } from '../src/recovery-family.ts';
import { ATOM, type BinOp, type Expr, type Fn, type Lowering, type Stmt, UNPACK_INTS, packInts, printFns } from '../src/algo-ir.ts';

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  ✗ ${msg}`); };

const CORE = ['algo-ir.ts', 'relex-family.ts', 'lex-family.ts', 'reuse-family.ts', 'define-target.ts'];
const TARGETS = [
  { file: 'target-ts.ts', target: tsTarget, name: 'typescript' },
  { file: 'target-go.ts', target: goTarget, name: 'go' },
  { file: 'target-rust.ts', target: rustTarget, name: 'rust' },
];

const code = (s: string) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, '')).join('\n');
const imports = (s: string) => [...s.matchAll(/^import [^;]*? from '([^']+)'/gms)].map((m) => m[1]);
// String literals with interpolations removed; import paths and error messages skipped.
const literals = (s: string) => [...s.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)]
  .map((m) => { let l = m[0]; while (/\$\{[^{}]*\}/.test(l)) l = l.replace(/\$\{[^{}]*\}/g, ''); return l; })
  .filter((l) => !/^.\.\//.test(l) && !/^.(algo-ir|defineTarget|relex-family|lex-family):/.test(l));

const TARGET_NAMES = /\b(ts|go|rust|typescript|golang|TS|Go|Rust|TypeScript|Golang)\b/;
const HOST_SWITCH = /\b(host|Host|HOSTS)\b/;
const PUNCT = /[^\w\s]/;
// Line separators, and the parsed language's own `(` token text (grammar data), are not target syntax.
const NOT_SYNTAX = new Set(["'\\n'", "'('"]);
// Doc and comment prose (the lowering decides how comments are written) is not syntax.
const isProse = (body: string) => (body.match(/[A-Za-z]{2,}/g) ?? []).length >= 4;

for (const f of CORE) {
  const s = code(src(f));
  for (const i of imports(s)) if (/target-/.test(i)) fail(`${f}: core imports target module ${i}`);
  if (HOST_SWITCH.test(s)) fail(`${f}: core mentions a host switch (${s.match(HOST_SWITCH)![0]})`);
  for (const l of literals(s)) {
    if (TARGET_NAMES.test(l)) fail(`${f}: literal names a target: ${l.slice(0, 80)}`);
    const body = l.slice(1, -1);
    if (!NOT_SYNTAX.has(l) && !isProse(body) && PUNCT.test(body)) fail(`${f}: literal carries surface syntax (${body.match(PUNCT)![0]}): ${l.slice(0, 80)}`);
  }
}

const defineCalls = new Map<string, number>();
for (const f of ['emit.ts', 'emit-portable.ts', 'emit-parser.ts', ...CORE, ...TARGETS.map((t) => t.file)]) {
  const n = (code(src(f)).match(/(?<!function )\bdefineTarget\(/g) ?? []).length;
  if (n) defineCalls.set(f, n);
}
for (const t of TARGETS) {
  const s = code(src(t.file));
  if (defineCalls.get(t.file) !== 1) fail(`${t.file}: ${defineCalls.get(t.file) ?? 0} defineTarget calls, want 1`);
  if (!/^const \w+Lowering: Lowering = \{/m.test(s)) fail(`${t.file}: defines no Lowering of its own`);
  for (const i of imports(s)) {
    if (/\/target-/.test(i)) fail(`${t.file}: imports another target module ${i}`);
    if (/(relex|lex|reuse)-family/.test(i)) fail(`${t.file}: imports an algorithm family directly (${i}); use shared`);
  }
  if (/\b(printFns|emitRelexFamily|emitLexScan|lexScanFamily)\b/.test(s)) fail(`${t.file}: prints shared algorithms itself; use shared`);
}
for (const [f] of defineCalls) if (!TARGETS.some((t) => t.file === f)) fail(`${f}: defineTarget called outside a target module`);

const reg = registeredTargets();
const names = reg.map((t) => t.name).sort();
if (names.join() !== 'go,rust,typescript') fail(`registry holds [${names}], want [go, rust, typescript]`);
for (const t of TARGETS) {
  const r = reg.find((x) => x.name === t.name);
  if (r !== t.target) fail(`${t.name}: registered target is not ${t.file}'s export`);
}
if (new Set(reg.map((t) => t.lowering)).size !== reg.length) fail('targets share a Lowering object');
try {
  defineTarget({ name: 'go', ext: 'go', lowering: goTarget.lowering, emitParser: () => '' });
  fail('a second defineTarget("go") was accepted');
} catch { /* expected */ }
const bare = defineTarget({ name: 'no-lowering-probe', ext: 'txt', emitParser: (_g, shared) => shared.relexFamily({} as never) });
try {
  bare.emitParser({} as never);
  fail('a target without a Lowering was handed shared algorithms');
} catch (e) {
  if (!/supplies no Lowering/.test((e as Error).message)) fail(`unexpected error for a target without a Lowering: ${(e as Error).message}`);
}

// ── 4. the core carries no surface syntax, shown by printing it (formerly syntax-agnostic) ──
// A test-only target registered with `defineTarget` (after the registry checks above, which it
// would otherwise join) prints the lex-scan and relex families — with the reuse and recovery
// families — as S-expressions: prefix operators, no braces, semicolons, brackets, infix or C
// comments, for every lexer mode; the printed forms are counted against the IR: every statement,
// operator, index and negation the IR holds reaches the lowering and comes out as its own form.
// Not a supported language; a proof that all syntax lives in the lowering.
const OP: Record<BinOp, string> = { add: '+', sub: '-', shr: 'shr', shl: 'shl', lt: '<', le: '<=', gt: '>', ge: '>=', eq: '=', ne: '/=', and: 'and', or: 'or' };
const form = (...xs: string[]) => `(${xs.join(' ')})`;
const nest = (lines: string[]) => lines.map((l) => '  ' + l);
const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
const at = (c: string) => ({ c, prec: ATOM });

const sexpr: Lowering = {
  ident: kebab,
  num: { int: 'int', lid: 'lid', depth: 'int', pos: 'int', idx: 'int' },
  type: (t) => t,
  cast: (_cx, r, nat) => ({ ...r, c: form('as', nat, r.c), nat, prec: ATOM }),
  owns: false,
  charSet: (name, rs) => form('define-char-set', name, ...rs.map(([lo, hi]) => form(String(lo), String(hi)))),
  runEndFn: form('define-runtime', 'run-end'),
  findFn: form('define-runtime', 'find'),
  findAnyFn: (stops) => form('define-runtime', 'find-any', ...stops.map(String)),
  expr: {
    literal: (v) => at(typeof v === 'string' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? '#t' : '#f') : String(v)),
    not: (r) => at(form('not', r.c)),
    bin: (op, a, b) => at(form(OP[op], a.c, b.c)),
    call: (name, args, method) => (method ? form('send', 'engine', name, ...args) : form(name, ...args)),
    len: (cx, l) => cx.atom(form('length', l.c), 'int', 'int'),
    own: (_cx, r) => r,
    code: (cx, s, i) => cx.atom(form('char-code', s.c, i.c), 'int', 'int'),
    hasAt: (cx, s, i, lit) => cx.atom(form('starts-at?', s.c, i.c, JSON.stringify(lit)), 'bool', 'bool'),
    inSet: (_cx, set, c) => at(form('in-set?', set, c.c)),
    runEnd: (cx, set, s, i) => cx.atom(form('run-end', set, s.c, i.c), 'int', 'int'),
    find: (cx, s, i, lit) => cx.atom(form('find', s.c, i.c, JSON.stringify(lit)), 'int', 'int'),
    findAny: (cx, s, i, stops) => cx.atom(form('find-any', s.c, i.c, form('stops', ...stops.map(String))), 'int', 'int'),
    cat: (cx, parts) => cx.atom(form('string-append', ...parts.map((r) => r.c)), 'str', 'str'),
    tab: (cx, name, i) => cx.atom(form('table-ref', name, i.c), 'int', 'int'),
  },
  intTable: (name, packed) => form('define-table', name, JSON.stringify(packed)),
  stmt: {
    comment: (text) => [`;; ${text}`],
    let: (_cx, s) => [form('define', s.id, s.r.c)],
    set: (id, val) => [form('set!', id, val)],
    if: (s) => (s.else
      ? [`(if ${s.c}`, ...nest(['(begin', ...nest(s.then), ')', '(begin', ...nest(s.else), ')']), ')']
      : [`(when ${s.c}`, ...nest(s.then), ')']),
    while: (c, body) => [`(while ${c}`, ...nest(body), ')'],
    break: () => ['(break)'],
    run: (call) => call,
    return: (vals) => [form('return', ...vals)],
    fn: (f) => [
      ...f.doc.map((l) => `;; ${l}`),
      `(${f.method ? 'defmethod' : 'defn'} ${f.name} (${f.params.map((p) => form(p.name, p.type)).join(' ')}) (returns ${f.rets.join(' ')})`,
      ...nest(f.body),
      ')',
    ].join('\n'),
  },
  relex: {
    index: 'int',
    expr: {
      index: (l, i) => at(form('nth', l.c, i.c)),
      metaInt: (cx, m, f) => cx.atom(form(`meta-${f}`, m.c), 'int', 'int'),
      metaFlag: (cx, m, f) => cx.atom(form(`meta-${f}?`, m.c), 'bool', 'bool'),
      tokInt: (cx, t, f) => cx.atom(form(`tok-${f}`, t.c), 'int', f === 'lid' ? 'lid' : 'int'),
      tokNl: (cx, t) => cx.atom(form('tok-nl?', t.c), 'bool', 'bool'),
      editInt: (cx, e, f) => cx.atom(form(`edit-${f}`, e.c), 'int', 'int'),
      editText: (cx, e) => cx.atom(form('edit-text', e.c), 'str', 'str'),
      metaText: (cx, t, m) => cx.atom(form('meta-text', t.c, m.c), 'str', 'str'),
      substr: (cx, s, a, b) => cx.atom(form('substring', s.c, a.c, b.c), 'str', 'str'),
      lidOf: (cx, s) => cx.atom(form('lid-of', s.c), 'lid', 'lid'),
      mkMeta: (cx, fs) => cx.atom(form('make-meta', ...fs.map(([f, r]) => `#:${f} ${r.c}`)), 'meta', 'meta'),
      shiftMeta: (cx, m, d) => cx.atom(form('shift-meta', m.c, d.c), 'meta', 'meta'),
      metaEq: (cx, a, b) => cx.atom(form('meta=?', a.c, b.c), 'bool', 'bool'),
      splice: (cx, s, a, b, ins) => cx.atom(form('string-splice', s.c, a.c, b.c, ins.c), 'str', 'str'),
      newList: (cx, ty, cap, estimate) => cx.atom(form('make-list', ...(cap ? ['#:capacity', cap.c] : []), ...(estimate ? ['#:estimate', estimate.c] : [])), ty, ty, { owned: true }),
      falses: (cx, n) => cx.atom(form('make-flags', n.c), 'bools', 'bools', { owned: true }),
      prefix: (cx, l, n, estimate) => cx.atom(form('take', l.c, n.c, '#:estimate', estimate.c), l.ty, l.ty, { owned: true }),
    },
    stmt: {
      setAt: (id, i, val) => [form('set-nth!', id, i, val)],
      push: (_cx, l, r) => [form('push!', l, r.c)],
      for: (_cx, v, from, to, body) => [`(for (${v} ${from.c} ${to.c})`, ...nest(body), ')'],
      forEach: (v, l, body) => [`(for-each (${v} ${l})`, ...nest(body), ')'],
      destructure: (_cx, s) => [form(s.declare ? 'define-values' : 'set-values!', form(...s.ids), s.call)],
      lexStep: (_cx, s) => [form('lex-step!', s.text.c, s.pos, ...s.state, s.out, s.err)],
      lexAll: (_cx, s) => [form('lex-all!', s.text.c, s.out, s.err)],
      shrink: (_cx, l) => [form('shrink!', l)],
    },
  },
  record: {
    field: (cx, r, _rec, f, ty) => cx.atom(form('field', r.c, kebab(f)), ty === 'bool' ? 'bool' : 'int', 'int'),
    setField: (id, f, val) => [form('set-field!', id, kebab(f), val)],
    make: (cx, rec, fs) => cx.atom(form('make-record', kebab(rec), ...fs.map(([f, v]) => `#:${kebab(f)} ${v}`)), `rec_${rec}`, `rec_${rec}`, { owned: true }),
    refType: (rec) => form('ref', kebab(rec)),
    refArg: (r) => r.c,
    extend: (_cx, l, from) => [form('extend!', l, from.c)],
    none: (cx, rec) => cx.atom(form('none', kebab(rec)), `opt_${rec}`, `opt_${rec}`),
    some: (cx, rec, r) => cx.atom(form('some', r.c), `opt_${rec}`, `opt_${rec}`),
    isSome: (_cx, r) => at(form('some?', r.c)),
  },
};

const target = defineTarget({
  name: 'sexpr-syntax-probe',
  ext: 'scm',
  lowering: sexpr,
  emitParser: (grammar, shared) => { const ir = portableIR(grammar); return shared.lexScan(ir) + '\n' + shared.relexFamily(ir) + '\n' + shared.reuseFamily(ir) + '\n' + shared.recoveryFamily(ir); },
});

// IR census: what the printed forms must account for.
const HEAD: Partial<Record<Stmt['k'], string[]>> = {
  let: ['define'], set: ['set!'], setAt: ['set-nth!'], push: ['push!'], if: ['if', 'when'], while: ['while'], for: ['for'],
  forEach: ['for-each'], break: ['break'], return: ['return'], letCall: ['define-values'], setCall: ['set-values!'],
  lexStep: ['lex-step!'], lexAll: ['lex-all!'], shrink: ['shrink!'], extend: ['extend!'], setField: ['set-field!'],
};
function census(fns: Fn[]): Map<string, number> {
  const sigs = new Map(fns.map((f) => [f.name, f]));
  const n = new Map<string, number>();
  const bump = (k: string) => n.set(k, (n.get(k) ?? 0) + 1);
  const ex = (e: Expr): void => {
    if (e.k === 'bin') bump(OP[e.op]);
    if (e.k === 'not') bump('not');
    if (e.k === 'at') bump('nth');
    if (e.k === 'field') bump('field');
    if (e.k === 'mkRec') { bump('make-record'); Object.values(e.fields).forEach(ex); }
    if (e.k === 'none') bump('none');
    if (e.k === 'some') bump('some');
    if (e.k === 'isSome') bump('some?');
    if (e.k === 'code') bump('char-code');
    if (e.k === 'hasAt') bump('starts-at?');
    if (e.k === 'inSet') bump('in-set?');
    if (e.k === 'runEnd') bump('run-end');
    if (e.k === 'find') bump('find');
    if (e.k === 'findAny') { bump('find-any'); bump('stops'); }
    if (e.k === 'cat') bump('string-append');
    if (e.k === 'tab') bump('table-ref');
    if (e.k === 'call' && sigs.get(e.fn)?.method) bump('send');
    for (const v of Object.values(e)) {
      if (Array.isArray(v)) v.forEach((y) => y && typeof y === 'object' && 'k' in y && ex(y as Expr));
      else if (v && typeof v === 'object' && 'k' in v) ex(v as Expr);
    }
  };
  const st = (s: Stmt): void => {
    if (s.k !== 'run') bump(s.k === 'comment' ? ';;' : HEAD[s.k]!.join('|'));
    for (const [key, v] of Object.entries(s)) {
      if (key === 'then' || key === 'else' || key === 'body') (v as Stmt[] | undefined)?.forEach(st);
      else if (Array.isArray(v)) v.forEach((y) => y && typeof y === 'object' && ex(y as Expr));
      else if (v && typeof v === 'object' && 'k' in v) ex(v as Expr);
    }
  };
  for (const f of fns) {
    if (f.extern) continue;   // a signature only: the target prints it (printFns skips it)
    bump(f.method ? 'defmethod' : 'defn');
    if (f.doc !== '') for (let i = 0; i < f.doc.split('\n').length; i++) bump(';;');
    f.body.forEach(st);
  }
  return n;
}

// Reader: balanced forms with string literals; collects each form's head.
function read(src: string): Map<string, number> {
  const heads = new Map<string, number>();
  const code = src.split('\n').map((l) => (/^\s*;;/.test(l) ? '' : l)).join('\n');
  let depth = 0, i = 0, expectHead = false;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"') { i++; while (code[i] !== '"') i += code[i] === '\\' ? 2 : 1; i++; expectHead = false; continue; }
    if (ch === '(') { depth++; i++; expectHead = true; continue; }
    if (ch === ')') { if (--depth < 0) throw new Error('unbalanced )'); i++; expectHead = false; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    let j = i;
    while (j < code.length && !/[\s()"]/.test(code[j])) j++;
    const tok = code.slice(i, j);
    if (expectHead) heads.set(tok, (heads.get(tok) ?? 0) + 1);
    else if (Object.values(OP).includes(tok) || tok === 'not' || tok === 'nth') throw new Error(`operator ${tok} outside head position`);
    expectHead = false;
    i = j;
  }
  if (depth !== 0) throw new Error(`unbalanced: depth ${depth}`);
  heads.set(';;', src.split('\n').filter((l) => /^\s*;;/.test(l)).length);
  return heads;
}

// `!` ends Lisp mutator names (`set!`); only a prefix `!` is C negation.
const C_SURFACE = /[{};[\],]|&&|\|\||==|!=|(?<![\w?-])!|\/\/|:=|->|\.\w/;
const FIXTURES = ['./fixtures/calc.ts', './fixtures/envspec.ts', './fixtures/regexjs.ts', './fixtures/templatejs.ts', '../javascript.ts', './fixtures/envtpl.ts'];

for (const path of FIXTURES) {
  const grammar = (await import(path)).default;
  const lex = lexScanFamily(portableIR(grammar));
  const fns = [...lex.fns, ...relexFamilyFns(relexMode(portableIR(grammar))), ...reuseFamilyFns(portableIR(grammar)), ...recoveryFamilyFns(), UNPACK_INTS];
  const out = target.emitParser(grammar);
  const code = out.split('\n').filter((l) => !/^\s*;;/.test(l)).join('\n').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const bad = code.match(C_SURFACE);
  if (bad) fail(`${path}: C-family surface ${JSON.stringify(bad[0])} in printed S-expressions`);
  let heads: Map<string, number>;
  try { heads = read(out); } catch (e) { fail(`${path}: ${(e as Error).message}`); continue; }
  const want = census(fns);
  want.set('define-char-set', lex.sets.length + relexFamily(relexMode(portableIR(grammar))).sets.length);
  want.set('define-table', 1);
  want.set('define-runtime', (want.has('run-end') ? 1 : 0) + (want.has('find') ? 1 : 0) + lex.stopSets.length);
  for (const [k, n] of want) {
    const got = k.split('|').reduce((s, h) => s + (heads.get(h) ?? 0), 0);
    if (got !== n) fail(`${path}: ${k} printed ${got}×, IR holds ${n}`);
  }
  if (!lex.fns.length) fail(`${path}: no token scanners printed`);
  console.log(`  ${path}: ${fns.length} functions, ${[...want.values()].reduce((a, b) => a + b, 0)} IR constructs ≡ printed forms`);
}

// Int tables and engine methods (algo-ir `tab`, `ints`, Fn.method): a method reading a packed table
// into an int stack, calling an extern method and the shared decoder's printed form.
{
  const v = (name: string): Expr => ({ k: 'var', name });
  const ext: Fn = { name: 'enginePos', doc: '', params: [], ret: ['int'], body: [], extern: true, method: true };
  const probe: Fn = { name: 'tableProbe', doc: '', params: [{ name: 'i', ty: 'int' }], ret: ['ints'], method: true, body: [
    { k: 'let', name: 'out', ty: 'ints', init: { k: 'newList', ty: 'ints' } },
    { k: 'push', list: 'out', e: { k: 'bin', op: 'add', a: { k: 'tab', t: 'probe', i: v('i') }, b: { k: 'call', fn: 'enginePos', args: [] } } },
    { k: 'return', es: [v('out')] },
  ] };
  const data = [-1, 0, 31, 32, 1023, 1024, 70000];
  const out = printFns(sexpr, [probe, ext], [], [], [{ name: 'probe', data }]);
  const heads = read(out);
  const want = census([probe, ext, UNPACK_INTS]);
  want.set('define-table', 1);
  for (const [k, n] of want) { const got = k.split('|').reduce((s, h) => s + (heads.get(h) ?? 0), 0); if (got !== n) fail(`int table probe: ${k} printed ${got}×, IR holds ${n}`); }
  // The packing round-trips through the decoder's arithmetic.
  const s = packInts(data), dec: number[] = [];
  for (let i = 0, val = 0, sh = 0; i < s.length; i++) { const d = s.charCodeAt(i) - 48; if (d >= 32) { val += (d - 32) << sh; sh += 5; } else { dec.push(val + (d << sh) - 1); val = 0; sh = 0; } }
  if (dec.join() !== data.join()) fail(`packInts: ${data} decodes as ${dec}`);
  console.log(`  int table probe: ${[...want.values()].reduce((a, b) => a + b, 0)} IR constructs ≡ printed forms`);
}

if (failures > 0) {
  console.error(`\n✗ defineTarget: ${failures} problem(s)`);
  process.exit(1);
}
console.log('✓ defineTarget: target-agnostic core (it prints as S-expressions through a test-only target, every IR construct accounted for); typescript / go / rust each registered once from its own module');
