// Typed algorithm IR: a family is authored once as `Fn[]` and printed as straight-line
// native TS / Go / Rust. Printers only map primitives (indexing, slices, owned strings,
// casts, list growth); every branch and loop of the algorithm comes from the IR.

export type Host = 'ts' | 'go' | 'rust';

export type Num = 'int' | 'lid' | 'depth';
export type ListTy = 'metas' | 'toks' | 'bools' | 'depths' | 'edits';
export type Ty = Num | 'bool' | 'str' | 'meta' | 'tok' | 'edit' | ListTy;
export type MetaInt = 'off' | 'end' | 'kid' | 'pd' | 'fd' | 'td';
export type MetaFlag = 'nl' | 'lc' | 'lb' | 'hd';
export type TokInt = 'off' | 'end' | 'kid' | 'lid';
type BinOp = '+' | '-' | '>>' | '<' | '<=' | '>' | '>=' | '==' | '!=' | '&&' | '||';

export type MkMeta = { off: Expr; end: Expr; kid: Expr; nl: Expr; fd: Expr; pd: Expr; lc: Expr; lb: Expr; hd: Expr; td: Expr };

export type Expr =
  | { k: 'int'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'str'; v: string }
  | { k: 'var'; name: string }
  | { k: 'bin'; op: BinOp; a: Expr; b: Expr }
  | { k: 'not'; e: Expr }
  | { k: 'len'; e: Expr }
  | { k: 'at'; list: Expr; i: Expr }
  | { k: 'metaInt'; m: Expr; f: MetaInt }
  | { k: 'metaFlag'; m: Expr; f: MetaFlag }
  | { k: 'tokInt'; t: Expr; f: TokInt }
  | { k: 'tokNl'; t: Expr }
  | { k: 'editInt'; e: Expr; f: 'start' | 'end' }
  | { k: 'editText'; e: Expr }
  | { k: 'metaText'; text: Expr; m: Expr }
  | { k: 'substr'; s: Expr; a: Expr; b: Expr }
  | { k: 'lidOf'; s: Expr }
  | ({ k: 'mkMeta' } & MkMeta)
  | { k: 'shiftMeta'; m: Expr; delta: Expr }
  | { k: 'metaEq'; a: Expr; b: Expr }
  | { k: 'call'; fn: string; args: Expr[] }
  | { k: 'splice'; s: Expr; a: Expr; b: Expr; ins: Expr }
  | { k: 'own'; e: Expr }
  | { k: 'newList'; ty: ListTy; cap?: Expr }
  | { k: 'falses'; n: Expr }
  | { k: 'prefix'; list: Expr; n: Expr; cap: Expr }
  | { k: 'lexAll'; text: Expr };

export type Stmt =
  | { k: 'let'; name: string; ty: Ty; init: Expr }
  | { k: 'set'; name: string; e: Expr }
  | { k: 'setAt'; list: string; i: Expr; e: Expr }
  | { k: 'push'; list: string; e: Expr }
  | { k: 'if'; c: Expr; then: Stmt[]; else?: Stmt[] }
  | { k: 'while'; c: Expr; body: Stmt[] }
  | { k: 'for'; v: string; from: Expr; to: Expr; body: Stmt[] }
  | { k: 'forEach'; v: string; list: Expr; body: Stmt[] }
  | { k: 'break' }
  | { k: 'return'; es: Expr[] }
  | { k: 'letCall'; names: string[]; call: Expr & { k: 'call' } }
  | { k: 'setCall'; names: string[]; call: Expr & { k: 'call' } }
  // One lexer step: `lexFrom(text, pos, ...state, out, 1)` reassigning pos and every state var.
  // The lexer itself is emitted per target outside this IR; `state` follows its parameter order.
  | { k: 'lexStep'; text: Expr; pos: string; out: string; state: string[] }
  // Release list capacity when more than half of it is unused (no-op where the host has no capacity).
  | { k: 'shrink'; list: string }
  | { k: 'comment'; text: string };

export interface Param { name: string; ty: Ty }
export interface Fn { name: string; doc: string; params: Param[]; ret: Ty[]; body: Stmt[] }

const ELEM: Record<ListTy, Ty> = { metas: 'meta', toks: 'tok', bools: 'bool', depths: 'depth', edits: 'edit' };
const isNum = (t: Ty): t is Num => t === 'int' || t === 'lid' || t === 'depth';
const isList = (t: Ty): t is ListTy => t in ELEM;

// Rendered expression: `c` has host type `nat`; `owned` marks Rust String/Vec values.
interface R { c: string; ty: Ty; nat: string; prec: number; lit?: boolean; owned?: boolean }
interface VarInfo { ty: Ty; owned: boolean }

const PREC: Record<BinOp, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '>>': 5, '+': 6, '-': 6 };
const CMP = new Set<BinOp>(['==', '!=', '<', '<=', '>', '>=']);
const ATOM = 100;
const CAST = 8;

const snake = (s: string): string => s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);

const GO_META: Record<MetaInt, string> = { off: 'int32', end: 'int32', kid: 'uint16', pd: 'uint16', fd: 'uint16', td: 'uint8' };
const RS_META: Record<MetaInt, string> = { off: 'u32', end: 'u32', kid: 'u16', pd: 'u16', fd: 'u16', td: 'u8' };
const GO_TOK: Record<TokInt, string> = { off: 'uint32', end: 'uint32', kid: 'uint16', lid: 'uint16' };
const RS_TOK: Record<TokInt, string> = { off: 'u32', end: 'u32', kid: 'u16', lid: 'u16' };

class Printer {
  private env = new Map<string, VarInfo>();
  private mutable = new Set<string>();
  private reassigned = new Set<string>();
  private sigs: Map<string, Fn>;
  private ind: string;
  private host: Host;

  constructor(host: Host, fns: Fn[]) {
    this.host = host;
    this.sigs = new Map(fns.map((f) => [f.name, f]));
    this.ind = host === 'ts' ? '  ' : host === 'go' ? '\t' : '    ';
  }

  private id(name: string): string { return this.host === 'rust' && name !== '_' ? snake(name) : name; }

  private nat(t: Ty): string {
    if (this.host === 'ts') return isNum(t) ? 'number' : t;
    if (this.host === 'go') return t === 'int' || t === 'depth' ? 'int' : t === 'lid' ? 'uint16' : t;
    return t === 'int' ? 'isize' : t === 'lid' ? 'u16' : t === 'depth' ? 'i64' : t;
  }

  private tyName(t: Ty, role: 'param' | 'local' | 'ret', owned = true): string {
    const h = this.host;
    if (h === 'ts') {
      const m: Record<Ty, string> = { int: 'number', lid: 'number', depth: 'number', bool: 'boolean', str: 'string', meta: 'AlignMeta', tok: 'Tok', edit: 'Edit', metas: 'AlignMeta[]', toks: 'Tok[]', bools: 'boolean[]', depths: 'number[]', edits: 'Edit[]' };
      return m[t];
    }
    if (h === 'go') {
      const m: Record<Ty, string> = { int: 'int', lid: 'uint16', depth: 'int', bool: 'bool', str: 'string', meta: 'alignMeta', tok: 'Tok', edit: 'Edit', metas: '[]alignMeta', toks: '[]Tok', bools: '[]bool', depths: '[]int', edits: '[]Edit' };
      return m[t];
    }
    const elem: Record<ListTy, string> = { metas: 'AlignMeta', toks: 'Tok', bools: 'bool', depths: 'i64', edits: 'Edit' };
    if (isList(t)) return role === 'param' ? `&[${elem[t]}]` : `Vec<${elem[t]}>`;
    if (t === 'str') return role === 'param' || !owned ? '&str' : 'String';
    if (t === 'edit') return '&Edit';
    const m: Record<string, string> = { int: 'isize', lid: 'u16', depth: 'i64', bool: 'bool', meta: 'AlignMeta', tok: 'Tok' };
    return m[t];
  }

  // Rust `as` casts get CAST precedence: unwrapped in index/argument position, parenthesized as
  // a binary operand (where `x as T < y` would parse as generics).
  private coerceR(r: R, nat: string): R {
    if (this.host === 'ts' || r.lit || r.nat === nat) return r;
    if (this.host === 'go') return { ...r, c: `${nat}(${r.c})`, nat, prec: ATOM };
    return { ...r, c: `${this.wrap(r, ATOM)} as ${nat}`, nat, prec: CAST };
  }

  private coerce(r: R, nat: string): string { return this.coerceR(r, nat).c; }

  private wrap(r: R, min: number): string { return r.prec < min ? `(${r.c})` : r.c; }

  private asStr(r: R): string {
    if (this.host !== 'rust' || !r.owned) return r.c;
    return /^\w+$/.test(r.c) ? `${r.c}.as_str()` : `(${r.c}).as_str()`;
  }

  private asSlice(r: R): string { return this.host === 'rust' && r.owned ? `&${r.c}` : r.c; }

  private ref(r: R): string { return this.host === 'rust' ? `&${r.c}` : r.c; }

  private atom(c: string, ty: Ty, nat: string, extra: Partial<R> = {}): R { return { c, ty, nat, prec: ATOM, ...extra }; }

  expr(e: Expr): R {
    const h = this.host;
    switch (e.k) {
      case 'int': return this.atom(String(e.v), 'int', this.nat('int'), { lit: true, prec: e.v < 0 ? 7 : ATOM });
      case 'bool': return this.atom(String(e.v), 'bool', 'bool');
      case 'str': return this.atom(JSON.stringify(e.v), 'str', 'str', { owned: false });
      case 'var': {
        const v = this.env.get(e.name);
        if (!v) throw new Error(`algo-ir: unknown variable ${e.name}`);
        return this.atom(this.id(e.name), v.ty, this.nat(v.ty), { owned: v.owned });
      }
      case 'bin': return this.bin(e.op, this.expr(e.a), this.expr(e.b));
      case 'not': {
        const r = this.expr(e.e);
        return { c: `!${this.wrap(r, ATOM)}`, ty: 'bool', nat: 'bool', prec: 90 };
      }
      case 'len': {
        const r = this.expr(e.e);
        if (h === 'ts') return this.atom(`${this.wrap(r, ATOM)}.length`, 'int', 'number');
        if (h === 'go') return this.atom(`len(${r.c})`, 'int', 'int');
        return this.atom(`${this.wrap(r, ATOM)}.len()`, 'int', 'usize');
      }
      case 'at': {
        const l = this.expr(e.list), i = this.expr(e.i);
        if (!isList(l.ty)) throw new Error('algo-ir: at() on non-list');
        const ty = ELEM[l.ty];
        const idx = h === 'rust' ? this.coerce(i, 'usize') : this.coerce(i, this.nat('int'));
        return this.atom(`${this.wrap(l, ATOM)}[${idx}]`, ty, this.nat(ty));
      }
      case 'metaInt': {
        const m = this.expr(e.m);
        if (h === 'ts') return this.atom(`${this.wrap(m, ATOM)}.${e.f}`, 'int', 'number');
        if (h === 'go') return this.atom(`${this.wrap(m, ATOM)}.${cap(e.f)}`, 'int', GO_META[e.f]);
        return this.atom(`${this.wrap(m, ATOM)}.${e.f}`, 'int', RS_META[e.f]);
      }
      case 'metaFlag': {
        const m = this.expr(e.m);
        if (h === 'ts') return this.atom(`am_${e.f}(${m.c})`, 'bool', 'bool');
        if (h === 'go') return this.atom(`am${cap(e.f)}(${m.c})`, 'bool', 'bool');
        return this.atom(`am_${e.f}(${this.ref(m)})`, 'bool', 'bool');
      }
      case 'tokInt': {
        const t = this.expr(e.t);
        if (h === 'ts') return this.atom(`${this.wrap(t, ATOM)}.${e.f}`, 'int', 'number');
        if (h === 'go') return this.atom(`${this.wrap(t, ATOM)}.${cap(e.f)}`, 'int', GO_TOK[e.f]);
        return this.atom(`${this.wrap(t, ATOM)}.${e.f}`, 'int', RS_TOK[e.f]);
      }
      case 'tokNl': {
        const t = this.expr(e.t);
        return this.atom(`${this.wrap(t, ATOM)}.${h === 'go' ? 'Nl' : 'nl'}`, 'bool', 'bool');
      }
      case 'editInt': {
        const x = this.expr(e.e);
        if (h === 'ts') return this.atom(`${x.c}.${e.f}`, 'int', 'number');
        if (h === 'go') return this.atom(`${x.c}.${cap(e.f)}`, 'int', 'int');
        return this.atom(`${x.c}.${e.f}`, 'int', 'usize');
      }
      case 'editText': {
        const x = this.expr(e.e);
        if (h === 'ts') return this.atom(`${x.c}.text`, 'str', 'str');
        if (h === 'go') return this.atom(`${x.c}.Text`, 'str', 'str');
        return this.atom(`${x.c}.text.as_str()`, 'str', 'str', { owned: false });
      }
      case 'metaText': {
        const t = this.expr(e.text), m = this.expr(e.m);
        if (h === 'ts') return this.atom(`am_text(${t.c}, ${m.c})`, 'str', 'str');
        if (h === 'go') return this.atom(`amText(${t.c}, ${m.c})`, 'str', 'str');
        return this.atom(`am_text(${this.asStr(t)}, ${this.ref(m)})`, 'str', 'str', { owned: false });
      }
      case 'substr': {
        const s = this.expr(e.s), a = this.expr(e.a), b = this.expr(e.b);
        if (h === 'ts') return this.atom(`${this.wrap(s, ATOM)}.slice(${a.c}, ${b.c})`, 'str', 'str');
        if (h === 'go') return this.atom(`${this.wrap(s, ATOM)}[${this.coerce(a, 'int')}:${this.coerce(b, 'int')}]`, 'str', 'str');
        return { c: `&${this.wrap(s, ATOM)}[${this.coerce(a, 'usize')}..${this.coerce(b, 'usize')}]`, ty: 'str', nat: 'str', prec: 90, owned: false };
      }
      case 'lidOf': {
        const s = this.expr(e.s);
        const fn = h === 'go' ? 'lidOf' : 'lid_of';
        return this.atom(`${fn}(${this.asStr(s)})`, 'lid', this.nat('lid'));
      }
      case 'mkMeta': {
        const nats: Record<keyof MkMeta, [string, string]> = {
          off: ['int32', 'u32'], end: ['int32', 'u32'], kid: ['uint16', 'u16'], nl: ['bool', 'bool'], fd: ['uint16', 'u16'],
          pd: ['uint16', 'u16'], lc: ['bool', 'bool'], lb: ['bool', 'bool'], hd: ['bool', 'bool'], td: ['uint8', 'u8'],
        };
        const order: (keyof MkMeta)[] = ['off', 'end', 'kid', 'nl', 'fd', 'pd', 'lc', 'lb', 'hd', 'td'];
        const args = order.map((f) => {
          const r = this.expr(e[f]);
          return h === 'ts' ? r.c : this.coerce(r, nats[f][h === 'go' ? 0 : 1]);
        });
        return this.atom(`${h === 'go' ? 'mkAlign' : 'mk_align'}(${args.join(', ')})`, 'meta', 'meta');
      }
      case 'shiftMeta': {
        const m = this.expr(e.m), d = this.expr(e.delta);
        if (h === 'ts') return this.atom(`shift_align(${m.c}, ${d.c})`, 'meta', 'meta');
        if (h === 'go') return this.atom(`shiftAlign(${m.c}, ${this.coerce(d, 'int')})`, 'meta', 'meta');
        return this.atom(`shift_align(${this.ref(m)}, ${this.coerce(d, 'isize')})`, 'meta', 'meta');
      }
      case 'metaEq': {
        const a = this.expr(e.a), b = this.expr(e.b);
        if (h !== 'ts') return { c: `${a.c} == ${b.c}`, ty: 'bool', nat: 'bool', prec: PREC['=='] };
        const fs = ['off', 'end', 'kid', 'pd', 'fd', 'flags', 'td'].map((f) => `${a.c}.${f} === ${b.c}.${f}`);
        return { c: fs.join(' && '), ty: 'bool', nat: 'bool', prec: PREC['&&'] };
      }
      case 'call': {
        const fn = this.sigs.get(e.fn);
        if (!fn) throw new Error(`algo-ir: unknown function ${e.fn}`);
        if (fn.ret.length !== 1) throw new Error(`algo-ir: ${e.fn} returns a tuple; use letCall/setCall`);
        return this.atom(this.callCode(e), fn.ret[0], this.nat(fn.ret[0]), { owned: true });
      }
      case 'splice': {
        const s = this.expr(e.s), a = this.expr(e.a), b = this.expr(e.b), ins = this.expr(e.ins);
        if (h === 'ts') return { c: `${this.wrap(s, ATOM)}.slice(0, ${a.c}) + ${ins.c} + ${this.wrap(s, ATOM)}.slice(${b.c})`, ty: 'str', nat: 'str', prec: PREC['+'] };
        if (h === 'go') return { c: `${this.wrap(s, ATOM)}[:${this.coerce(a, 'int')}] + ${ins.c} + ${this.wrap(s, ATOM)}[${this.coerce(b, 'int')}:]`, ty: 'str', nat: 'str', prec: PREC['+'] };
        return this.atom(`format!("{}{}{}", &${this.wrap(s, ATOM)}[..${this.coerce(a, 'usize')}], ${this.asStr(ins)}, &${this.wrap(s, ATOM)}[${this.coerce(b, 'usize')}..])`, 'str', 'str', { owned: true });
      }
      case 'own': {
        const r = this.expr(e.e);
        if (h !== 'rust') return r;
        if (r.ty === 'str') return this.atom(`${this.wrap(r, ATOM)}.to_string()`, 'str', 'str', { owned: true });
        if (isList(r.ty)) return this.atom(`${this.wrap(r, ATOM)}.to_vec()`, r.ty, r.ty, { owned: true });
        return r;
      }
      case 'newList': {
        const elem = this.tyName(e.ty, 'local').replace(/^\[\]/, '');
        if (h === 'ts') return this.atom('[]', e.ty, e.ty, { owned: true });
        if (h === 'go') return this.atom(e.cap ? `make([]${elem}, 0, ${this.coerce(this.expr(e.cap), 'int')})` : 'nil', e.ty, e.ty, { owned: true });
        return this.atom(e.cap ? `Vec::with_capacity(${this.coerce(this.expr(e.cap), 'usize')})` : 'Vec::new()', e.ty, e.ty, { owned: true });
      }
      case 'falses': {
        const n = this.expr(e.n);
        if (h === 'ts') return this.atom(`new Array<boolean>(${n.c}).fill(false)`, 'bools', 'bools', { owned: true });
        if (h === 'go') return this.atom(`make([]bool, ${this.coerce(n, 'int')})`, 'bools', 'bools', { owned: true });
        return this.atom(`vec![false; ${this.coerce(n, 'usize')}]`, 'bools', 'bools', { owned: true });
      }
      case 'prefix': {
        const l = this.expr(e.list), n = this.expr(e.n), c = this.expr(e.cap);
        if (!isList(l.ty)) throw new Error('algo-ir: prefix() on non-list');
        if (h === 'ts') return this.atom(`${this.wrap(l, ATOM)}.slice(0, ${n.c})`, l.ty, l.ty, { owned: true });
        if (h === 'go') {
          const elem = this.tyName(l.ty, 'local').slice(2);
          return this.atom(`append(make([]${elem}, 0, ${this.coerce(c, 'int')}), ${this.wrap(l, ATOM)}[:${this.coerce(n, 'int')}]...)`, l.ty, l.ty, { owned: true });
        }
        return this.atom(`{ let mut v = Vec::with_capacity(${this.coerce(c, 'usize')}); v.extend_from_slice(&${this.wrap(l, ATOM)}[..${this.coerce(n, 'usize')}]); v }`, l.ty, l.ty, { owned: true });
      }
      case 'lexAll': {
        const t = this.expr(e.text);
        return this.atom(`lex(${this.asStr(t)})`, 'toks', 'toks', { owned: true });
      }
    }
  }

  private bin(op: BinOp, a: R, b: R): R {
    const h = this.host;
    const p = PREC[op];
    const side = (r: R, right: boolean): string => {
      const needs = r.prec < p || r.prec === CAST || (right && r.prec === p) || (op === '>>' && r.prec < ATOM) || (CMP.has(op) && r.prec >= 3 && r.prec <= 4);
      return needs ? `(${r.c})` : r.c;
    };
    const jsOp = h === 'ts' && op === '==' ? '===' : h === 'ts' && op === '!=' ? '!==' : op;
    if (op === '&&' || op === '||') return { c: `${side(a, false)} ${op} ${side(b, true)}`, ty: 'bool', nat: 'bool', prec: p };
    if (isNum(a.ty) && isNum(b.ty)) {
      let [ca, cb, nat] = [a, b, a.lit ? b.nat : a.nat];
      if (!(a.lit || b.lit || a.nat === b.nat)) {
        nat = this.nat('int');
        ca = this.coerceR(a, nat);
        cb = this.coerceR(b, nat);
      }
      const cmp = CMP.has(op);
      return { c: `${side(ca, false)} ${jsOp} ${side(cb, true)}`, ty: cmp ? 'bool' : 'int', nat: cmp ? 'bool' : nat, prec: p, lit: !cmp && a.lit && b.lit };
    }
    if (a.ty === 'str' && b.ty === 'str') {
      return { c: `${side({ ...a, c: this.asStr(a) }, false)} ${jsOp} ${side({ ...b, c: this.asStr(b) }, true)}`, ty: 'bool', nat: 'bool', prec: p };
    }
    if (a.ty === 'bool' && b.ty === 'bool') return { c: `${side(a, false)} ${jsOp} ${side(b, true)}`, ty: 'bool', nat: 'bool', prec: p };
    throw new Error(`algo-ir: ${a.ty} ${op} ${b.ty}`);
  }

  private callCode(e: Expr & { k: 'call' }): string {
    const fn = this.sigs.get(e.fn)!;
    if (fn.params.length !== e.args.length) throw new Error(`algo-ir: ${e.fn} arity`);
    const args = e.args.map((a, i) => {
      const r = this.expr(a), pt = fn.params[i].ty;
      if (isNum(pt)) return this.coerce(r, this.nat(pt));
      if (pt === 'str') return this.asStr(r);
      if (isList(pt)) return this.asSlice(r);
      return r.c;
    });
    return `${this.id(e.fn)}(${args.join(', ')})`;
  }

  private scan(body: Stmt[]): void {
    for (const s of body) {
      switch (s.k) {
        case 'set': this.mutable.add(s.name); this.reassigned.add(s.name); break;
        case 'setCall': for (const n of s.names) { this.mutable.add(n); this.reassigned.add(n); } break;
        case 'setAt': case 'push': this.mutable.add(s.list); break;
        case 'shrink': this.mutable.add(s.list); this.reassigned.add(s.list); break;
        case 'lexStep':
          for (const n of [s.pos, ...s.state]) { this.mutable.add(n); this.reassigned.add(n); }
          this.mutable.add(s.out);
          break;
        case 'if': this.scan(s.then); if (s.else) this.scan(s.else); break;
        case 'while': case 'for': case 'forEach': this.scan(s.body); break;
      }
    }
  }

  private block(body: Stmt[], depth: number): string[] {
    return body.flatMap((s) => this.stmt(s, depth));
  }

  private stmt(s: Stmt, d: number): string[] {
    const h = this.host;
    const pad = this.ind.repeat(d);
    const semi = h === 'go' ? '' : ';';
    switch (s.k) {
      case 'comment': return [`${pad}// ${s.text}`];
      case 'let': {
        const r = this.expr(s.init);
        const owned = s.ty === 'str' ? !!r.owned : isList(s.ty);
        if (h === 'rust' && isList(s.ty) && !r.owned) throw new Error(`algo-ir: let ${s.name} needs an owned list`);
        this.env.set(s.name, { ty: s.ty, owned });
        const name = this.id(s.name);
        if (h === 'ts') {
          const kw = this.reassigned.has(s.name) ? 'let' : 'const';
          return [`${pad}${kw} ${name}: ${this.tyName(s.ty, 'local')} = ${r.c};`];
        }
        if (h === 'go') {
          if (s.init.k === 'newList' && !s.init.cap) return [`${pad}var ${name} ${this.tyName(s.ty, 'local')}`];
          if (isNum(s.ty)) {
            const nat = this.nat(s.ty);
            if (r.lit) return [nat === 'int' ? `${pad}${name} := ${r.c}` : `${pad}var ${name} ${nat} = ${r.c}`];
            return [`${pad}${name} := ${this.coerce(r, nat)}`];
          }
          return [`${pad}${name} := ${r.c}`];
        }
        const mut = this.mutable.has(s.name) ? 'mut ' : '';
        const val = isNum(s.ty) ? this.coerce(r, this.nat(s.ty)) : r.c;
        return [`${pad}let ${mut}${name}: ${this.tyName(s.ty, 'local', owned)} = ${val};`];
      }
      case 'set': {
        const v = this.env.get(s.name);
        if (!v) throw new Error(`algo-ir: set of unknown ${s.name}`);
        const r = this.expr(s.e);
        let val = r.c;
        if (isNum(v.ty)) val = this.coerce(r, this.nat(v.ty));
        else if (h === 'rust' && v.ty === 'str' && !v.owned) val = this.asStr(r);
        else if (h === 'rust' && v.owned && !r.owned) throw new Error(`algo-ir: set ${s.name} needs an owned value`);
        return [`${pad}${this.id(s.name)} = ${val}${semi}`];
      }
      case 'setAt': {
        const v = this.env.get(s.list)!;
        const elem = ELEM[v.ty as ListTy];
        const i = this.expr(s.i), r = this.expr(s.e);
        const idx = h === 'rust' ? this.coerce(i, 'usize') : this.coerce(i, this.nat('int'));
        const val = isNum(elem) ? this.coerce(r, this.nat(elem)) : r.c;
        return [`${pad}${this.id(s.list)}[${idx}] = ${val}${semi}`];
      }
      case 'push': {
        const r = this.expr(s.e);
        const l = this.id(s.list);
        return [h === 'go' ? `${pad}${l} = append(${l}, ${r.c})` : `${pad}${l}.push(${r.c});`];
      }
      case 'if': {
        const c = this.expr(s.c).c;
        const open = h === 'ts' ? `if (${c})` : `if ${c}`;
        if (!s.else && s.then.length === 1 && (s.then[0].k === 'break' || s.then[0].k === 'set' || s.then[0].k === 'return')) {
          const inner = this.stmt(s.then[0], 0);
          const line = h === 'ts' ? `${pad}${open} ${inner[0]}` : `${pad}${open} { ${inner[0]} }`;
          if (inner.length === 1 && line.length <= 110) return [line];
        }
        const out = [`${pad}${open} {`, ...this.block(s.then, d + 1)];
        if (s.else) out.push(`${pad}} else {`, ...this.block(s.else, d + 1));
        out.push(`${pad}}`);
        return out;
      }
      case 'while': {
        const c = this.expr(s.c).c;
        const open = h === 'ts' ? `while (${c}) {` : h === 'go' ? `for ${c} {` : `while ${c} {`;
        return [`${pad}${open}`, ...this.block(s.body, d + 1), `${pad}}`];
      }
      case 'for': {
        const from = this.expr(s.from), to = this.expr(s.to);
        this.env.set(s.v, { ty: 'int', owned: false });
        const v = this.id(s.v);
        const open = h === 'ts'
          ? `for (let ${v} = ${from.c}; ${v} < ${to.c}; ${v}++) {`
          : h === 'go'
            ? `for ${v} := ${this.coerce(from, 'int')}; ${v} < ${this.coerce(to, 'int')}; ${v}++ {`
            : `for ${v} in ${this.coerce(from, 'isize')}..${this.coerce(to, 'isize')} {`;
        return [`${pad}${open}`, ...this.block(s.body, d + 1), `${pad}}`];
      }
      case 'forEach': {
        const l = this.expr(s.list);
        if (!isList(l.ty)) throw new Error('algo-ir: forEach over non-list');
        this.env.set(s.v, { ty: ELEM[l.ty], owned: false });
        const v = this.id(s.v);
        const open = h === 'ts' ? `for (const ${v} of ${l.c}) {` : h === 'go' ? `for _, ${v} := range ${l.c} {` : `for ${v} in ${l.c} {`;
        return [`${pad}${open}`, ...this.block(s.body, d + 1), `${pad}}`];
      }
      case 'break': return [`${pad}break${semi}`];
      case 'return': {
        const fn = this.cur!;
        const vals = s.es.map((e, i) => {
          const r = this.expr(e), t = fn.ret[i];
          if (isNum(t)) return this.coerce(r, this.nat(t));
          if (h === 'rust' && t === 'str' && !r.owned) return `${this.wrap(r, ATOM)}.to_string()`;
          if (h === 'rust' && isList(t) && !r.owned) throw new Error(`algo-ir: return of borrowed list in ${fn.name}`);
          return r.c;
        });
        if (vals.length === 1) return [`${pad}return ${vals[0]}${semi}`];
        return [h === 'ts' ? `${pad}return [${vals.join(', ')}];` : h === 'go' ? `${pad}return ${vals.join(', ')}` : `${pad}return (${vals.join(', ')});`];
      }
      case 'letCall': case 'setCall': {
        const fn = this.sigs.get(s.call.fn);
        if (!fn || fn.ret.length !== s.names.length) throw new Error(`algo-ir: ${s.call.fn} destructure arity`);
        const call = this.callCode(s.call);
        if (s.k === 'letCall') s.names.forEach((n, i) => { if (n !== '_') this.env.set(n, { ty: fn.ret[i], owned: true }); });
        else s.names.forEach((n, i) => { if (n !== '_' && this.env.get(n)?.ty !== fn.ret[i]) throw new Error(`algo-ir: setCall type of ${n}`); });
        const names = s.names.map((n) => this.id(n));
        if (h === 'ts') {
          const pat = `[${s.names.map((n) => (n === '_' ? '' : n)).join(', ').replace(/(, )+$/, '')}]`;
          if (s.k === 'setCall') return [`${pad}${pat} = ${call};`];
          const kw = s.names.some((n) => this.reassigned.has(n)) ? 'let' : 'const';
          return [`${pad}${kw} ${pat} = ${call};`];
        }
        if (h === 'go') return [`${pad}${names.join(', ')} ${s.k === 'letCall' ? ':=' : '='} ${call}`];
        if (s.k === 'setCall') return [`${pad}(${names.join(', ')}) = ${call};`];
        const pat = s.names.map((n, i) => (n !== '_' && this.mutable.has(n) ? `mut ${names[i]}` : names[i]));
        return [`${pad}let (${pat.join(', ')}) = ${call};`];
      }
      case 'lexStep': {
        const text = this.expr(s.text);
        const st = s.state.map((n) => this.id(n));
        const pos = this.id(s.pos), out = this.id(s.out);
        if (h === 'ts') {
          const lhs = [s.pos === 'pos' ? 'pos' : `pos: ${s.pos}`, ...st].join(', ');
          return [`${pad}({ ${lhs} } = lexFrom(${text.c}, ${pos}, ${[...st, out].join(', ')}, 1));`];
        }
        if (h === 'go') return [`${pad}${[pos, ...st].join(', ')} = lexFrom(${text.c}, ${pos}, ${[...st, `&${out}`].join(', ')}, 1)`];
        return [
          `${pad}let lexed = lex_from(${this.asStr(text)}, ${pos} as usize, ${[...st, `&mut ${out}`].join(', ')}, 1);`,
          `${pad}${pos} = lexed.0 as isize;`,
          ...st.map((n, i) => `${pad}${n} = lexed.${i + 1};`),
        ];
      }
      case 'shrink': {
        const v = this.env.get(s.list)!;
        const l = this.id(s.list);
        if (h === 'ts') return [];
        if (h === 'go') return [`${pad}if cap(${l}) > 2*len(${l}) { ${l} = append(${this.tyName(v.ty, 'local')}(nil), ${l}...) }`];
        return [`${pad}if ${l}.capacity() > 2 * ${l}.len() { ${l}.shrink_to_fit(); }`];
      }
    }
  }

  private cur: Fn | null = null;

  fn(f: Fn): string {
    this.env = new Map();
    this.mutable = new Set();
    this.reassigned = new Set();
    this.cur = f;
    this.scan(f.body);
    for (const p of f.params) this.env.set(p.name, { ty: p.ty, owned: false });
    const h = this.host;
    const params = f.params.map((p) => (h === 'go' ? `${p.name} ${this.tyName(p.ty, 'param')}` : `${this.id(p.name)}: ${this.tyName(p.ty, 'param')}`));
    const rets = f.ret.map((t) => this.tyName(t, 'ret'));
    const ret = h === 'ts'
      ? (rets.length === 1 ? rets[0] : `[${rets.join(', ')}]`)
      : h === 'go'
        ? (rets.length === 1 ? rets[0] : `(${rets.join(', ')})`)
        : (rets.length === 1 ? rets[0] : `(${rets.join(', ')})`);
    const head = h === 'ts'
      ? `function ${f.name}(${params.join(', ')}): ${ret} {`
      : h === 'go'
        ? `func ${f.name}(${params.join(', ')}) ${ret} {`
        : `fn ${this.id(f.name)}(${params.join(', ')}) -> ${ret} {`;
    const doc = f.doc.split('\n').map((l) => `// ${l}`);
    return [...doc, head, ...this.block(f.body, 1), '}'].join('\n');
  }
}

export function printFns(host: Host, fns: Fn[]): string {
  const p = new Printer(host, fns);
  return fns.map((f) => p.fn(f)).join('\n');
}
