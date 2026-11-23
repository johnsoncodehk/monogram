// Gate: the shared algorithm core carries no surface syntax. A test-only target registered with
// `defineTarget` prints the lex-scan and relex families as S-expressions — prefix operators, no braces,
// semicolons, brackets, infix or C comments — for every lexer mode, and the printed forms
// are counted against the IR: every statement, operator, index and negation the IR holds
// reaches the lowering and comes out as its own form. Not a supported language; a proof that
// all syntax lives in the lowering.
//
//   node test/syntax-agnostic.ts
import { defineTarget } from '../src/define-target.ts';
import { portableIR } from '../src/emit-portable.ts';
import { relexFamily, relexFamilyFns, relexMode } from '../src/relex-family.ts';
import { lexScanFamily } from '../src/lex-family.ts';
import { reuseFamilyFns } from '../src/reuse-family.ts';
import { recoveryFamilyFns } from '../src/recovery-family.ts';
import { ATOM, type BinOp, type Expr, type Fn, type Lowering, type Stmt } from '../src/algo-ir.ts';

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
    call: (name, args) => form(name, ...args),
    len: (cx, l) => cx.atom(form('length', l.c), 'int', 'int'),
    own: (_cx, r) => r,
    code: (cx, s, i) => cx.atom(form('char-code', s.c, i.c), 'int', 'int'),
    hasAt: (cx, s, i, lit) => cx.atom(form('starts-at?', s.c, i.c, JSON.stringify(lit)), 'bool', 'bool'),
    inSet: (_cx, set, c) => at(form('in-set?', set, c.c)),
    runEnd: (cx, set, s, i) => cx.atom(form('run-end', set, s.c, i.c), 'int', 'int'),
    find: (cx, s, i, lit) => cx.atom(form('find', s.c, i.c, JSON.stringify(lit)), 'int', 'int'),
    findAny: (cx, s, i, stops) => cx.atom(form('find-any', s.c, i.c, form('stops', ...stops.map(String))), 'int', 'int'),
    cat: (cx, parts) => cx.atom(form('string-append', ...parts.map((r) => r.c)), 'str', 'str'),
  },
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
      `(defn ${f.name} (${f.params.map((p) => form(p.name, p.type)).join(' ')}) (returns ${f.rets.join(' ')})`,
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
  emitParser: (grammar, shared) => { const ir = portableIR(grammar); return shared.lexScan(ir) + '\n' + shared.relexFamily(ir) + '\n' + shared.reuseFamily(ir) + '\n' + shared.recoveryFamily(); },
});

// IR census: what the printed forms must account for.
const HEAD: Partial<Record<Stmt['k'], string[]>> = {
  let: ['define'], set: ['set!'], setAt: ['set-nth!'], push: ['push!'], if: ['if', 'when'], while: ['while'], for: ['for'],
  forEach: ['for-each'], break: ['break'], return: ['return'], letCall: ['define-values'], setCall: ['set-values!'],
  lexStep: ['lex-step!'], lexAll: ['lex-all!'], shrink: ['shrink!'], extend: ['extend!'], setField: ['set-field!'],
};
function census(fns: Fn[]): Map<string, number> {
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
    bump('defn');
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

let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  ✗ ${msg}`); };

for (const path of FIXTURES) {
  const grammar = (await import(path)).default;
  const lex = lexScanFamily(portableIR(grammar));
  const fns = [...lex.fns, ...relexFamilyFns(relexMode(portableIR(grammar))), ...reuseFamilyFns(portableIR(grammar)), ...recoveryFamilyFns()];
  const out = target.emitParser(grammar);
  const code = out.split('\n').filter((l) => !/^\s*;;/.test(l)).join('\n').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const bad = code.match(C_SURFACE);
  if (bad) fail(`${path}: C-family surface ${JSON.stringify(bad[0])} in printed S-expressions`);
  let heads: Map<string, number>;
  try { heads = read(out); } catch (e) { fail(`${path}: ${(e as Error).message}`); continue; }
  const want = census(fns);
  want.set('define-char-set', lex.sets.length + relexFamily(relexMode(portableIR(grammar))).sets.length);
  want.set('define-runtime', (want.has('run-end') ? 1 : 0) + (want.has('find') ? 1 : 0) + lex.stopSets.length);
  for (const [k, n] of want) {
    const got = k.split('|').reduce((s, h) => s + (heads.get(h) ?? 0), 0);
    if (got !== n) fail(`${path}: ${k} printed ${got}×, IR holds ${n}`);
  }
  if (!lex.fns.length) fail(`${path}: no token scanners printed`);
  console.log(`  ${path}: ${fns.length} functions, ${[...want.values()].reduce((a, b) => a + b, 0)} IR constructs ≡ printed forms`);
}

if (failures > 0) {
  console.error(`\n✗ syntax-agnostic: ${failures} problem(s)`);
  process.exit(1);
}
console.log('\n✓ syntax-agnostic: the lex-scan and relex families print as S-expressions through defineTarget (with the reuse and recovery families); every IR construct accounted for');
