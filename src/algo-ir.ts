// Typed algorithm IR: a family is authored once as `Fn[]` and printed by whichever target supplies
// a `Lowering`. This module assumes no target and no surface syntax: it walks the IR, tracks
// types, mutability and ownership, decides where a numeric conversion is needed, and hands every
// construct — literals, operators, grouping, calls, indexing, statements, blocks, comments,
// function shells — to the lowering as already-printed children. Every branch and loop of the
// algorithm comes from the IR; a lowering only spells it.

export type Num = 'int' | 'lid' | 'depth';
export type ListTy = 'metas' | 'toks' | 'bools' | 'depths' | 'edits';
export type Ty = Num | 'bool' | 'str' | 'meta' | 'tok' | 'edit' | ListTy;
export type MetaInt = 'off' | 'end' | 'kid' | 'pd' | 'fd' | 'td';
export type MetaFlag = 'nl' | 'lc' | 'lb' | 'hd';
export type TokInt = 'off' | 'end' | 'kid' | 'lid';
export type BinOp = 'add' | 'sub' | 'shr' | 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne' | 'and' | 'or';
export const COMPARISON = new Set<BinOp>(['lt', 'le', 'gt', 'ge', 'eq', 'ne']);

export type MkMeta = { off: Expr; end: Expr; kid: Expr; nl: Expr; fd: Expr; pd: Expr; lc: Expr; lb: Expr; hd: Expr; td: Expr };
// Argument order of the target runtime's meta constructor.
export const MK_META_ORDER: (keyof MkMeta)[] = ['off', 'end', 'kid', 'nl', 'fd', 'pd', 'lc', 'lb', 'hd', 'td'];

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
  // `cap` is an exact final length; `estimate` is a growth guess the lowering may reserve or ignore.
  | { k: 'newList'; ty: ListTy; cap?: Expr; estimate?: Expr }
  | { k: 'falses'; n: Expr }
  | { k: 'prefix'; list: Expr; n: Expr; estimate: Expr }
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
  // Release list capacity when more than half of it is unused (lowerings that never over-reserve skip it).
  | { k: 'shrink'; list: string }
  | { k: 'comment'; text: string };

export interface Param { name: string; ty: Ty }
export interface Fn { name: string; doc: string; params: Param[]; ret: Ty[]; body: Stmt[] }

export const ELEM: Record<ListTy, Ty> = { metas: 'meta', toks: 'tok', bools: 'bool', depths: 'depth', edits: 'edit' };
export const isNum = (t: Ty): t is Num => t === 'int' || t === 'lid' || t === 'depth';
export const isList = (t: Ty): t is ListTy => t in ELEM;

// Printed expression: `c` has native type `nat`. `prec` is the lowering's own binding strength
// (the printer only compares it with ATOM, "never needs grouping"); `owned` marks values the
// expression owns (meaningful for lowerings with `owns`); `lit` marks untyped numeric literals.
export interface R { c: string; ty: Ty; nat: string; prec: number; lit?: boolean; owned?: boolean }
export type Printed = { c: string; prec: number };
interface VarInfo { ty: Ty; owned: boolean }

export const ATOM = 100;

export type Role = 'param' | 'local' | 'ret';

// Printer services a lowering can use on already-printed children.
export interface Cx {
  atom(c: string, ty: Ty, nat: string, extra?: Partial<R>): R;
  coerce(r: R, nat: string): string;
  nat(t: Ty): string;
  type(t: Ty, role: Role, owned?: boolean): string;
  str(r: R): string;
  ref(r: R): string;
}

// Children of block statements arrive as printed lines relative to the statement; the lowering
// places them (indentation, delimiters). `depth` is the statement's nesting level, for layout.
type Lines = string[];

// What a target supplies to print the IR: its complete surface syntax plus its type, ownership,
// storage and capacity decisions. None may add control flow the IR does not contain.
export interface Lowering {
  ident(name: string): string;
  num: Record<Num, string>;
  index: string;                                      // native type of list indices
  type(t: Ty, role: Role, owned: boolean): string;
  // Absent: numbers are untyped, so no conversions are printed.
  cast?(cx: Cx, r: R, nat: string): R;
  // Single-owner values: lists and strings are owned or borrowed, and moves are checked.
  owns: boolean;
  borrowStr?(r: R): string;
  borrowList?(r: R): string;
  borrowVal?(r: R): string;
  expr: {
    literal(v: number | boolean | string): Printed;
    not(r: R): Printed;
    bin(op: BinOp, a: R, b: R): Printed;
    index(list: R, i: R): Printed;
    call(name: string, args: string[]): string;
    len(cx: Cx, l: R): R;
    metaInt(cx: Cx, m: R, f: MetaInt): R;
    metaFlag(cx: Cx, m: R, f: MetaFlag): R;
    tokInt(cx: Cx, t: R, f: TokInt): R;
    tokNl(cx: Cx, t: R): R;
    editInt(cx: Cx, e: R, f: 'start' | 'end'): R;
    editText(cx: Cx, e: R): R;
    metaText(cx: Cx, text: R, m: R): R;
    substr(cx: Cx, s: R, a: R, b: R): R;
    lidOf(cx: Cx, s: R): R;
    mkMeta(cx: Cx, fields: [keyof MkMeta, R][]): R;
    shiftMeta(cx: Cx, m: R, delta: R): R;
    metaEq(cx: Cx, a: R, b: R): R;
    splice(cx: Cx, s: R, a: R, b: R, ins: R): R;
    own(cx: Cx, r: R): R;
    newList(cx: Cx, ty: ListTy, cap?: R, estimate?: R): R;
    falses(cx: Cx, n: R): R;
    prefix(cx: Cx, list: R, n: R, estimate: R): R;
  };
  stmt: {
    comment(text: string): Lines;
    let(cx: Cx, s: { id: string; ty: Ty; r: R; owned: boolean; mutable: boolean; reassigned: boolean; emptyList: boolean }): Lines;
    set(id: string, val: string): Lines;
    setAt(id: string, i: string, val: string): Lines;
    push(cx: Cx, list: string, r: R): Lines;
    // `inline` is the sole statement of a branch-free `if` printed on one line, when it is short.
    if(s: { c: string; then: Lines; else?: Lines; inline?: string; depth: number }): Lines;
    while(c: string, body: Lines): Lines;
    for(cx: Cx, v: string, from: R, to: R, body: Lines): Lines;
    forEach(v: string, list: string, body: Lines): Lines;
    break(): Lines;
    return(vals: string[]): Lines;
    destructure(cx: Cx, s: { declare: boolean; names: string[]; ids: string[]; call: string; mutable: (n: string) => boolean; reassigned: (n: string) => boolean }): Lines;
    lexStep(cx: Cx, s: { text: R; posName: string; pos: string; out: string; state: string[] }): Lines;
    shrink(cx: Cx, list: string, ty: ListTy): Lines;
    fn(s: { name: string; params: { name: string; type: string }[]; rets: string[]; doc: string[]; body: Lines }): string;
  };
}

function refs(e: Expr, out = new Set<string>()): Set<string> {
  if (e.k === 'var') out.add(e.name);
  for (const v of Object.values(e)) {
    if (Array.isArray(v)) v.forEach((x) => typeof x === 'object' && x && refs(x as Expr, out));
    else if (typeof v === 'object' && v && 'k' in v) refs(v as Expr, out);
  }
  return out;
}

class Printer implements Cx {
  private env = new Map<string, VarInfo>();
  private mutable = new Set<string>();
  private reassigned = new Set<string>();
  private sigs: Map<string, Fn>;
  private L: Lowering;

  constructor(lowering: Lowering, fns: Fn[]) {
    this.L = lowering;
    this.sigs = new Map(fns.map((f) => [f.name, f]));
  }

  private id(name: string): string { return name === '_' ? name : this.L.ident(name); }
  nat(t: Ty): string { return isNum(t) ? this.L.num[t] : t; }
  type(t: Ty, role: Role, owned = true): string { return this.L.type(t, role, owned); }

  private coerceR(r: R, nat: string): R {
    if (!this.L.cast || r.lit || r.nat === nat) return r;
    return this.L.cast(this, r, nat);
  }

  coerce(r: R, nat: string): string { return this.coerceR(r, nat).c; }
  str(r: R): string { return this.L.borrowStr ? this.L.borrowStr(r) : r.c; }
  private list(r: R): string { return this.L.borrowList ? this.L.borrowList(r) : r.c; }
  ref(r: R): string { return this.L.borrowVal ? this.L.borrowVal(r) : r.c; }
  atom(c: string, ty: Ty, nat: string, extra: Partial<R> = {}): R { return { c, ty, nat, prec: ATOM, ...extra }; }

  expr(e: Expr): R {
    const X = this.L.expr;
    switch (e.k) {
      case 'int': return { ...X.literal(e.v), ty: 'int', nat: this.nat('int'), lit: true };
      case 'bool': return { ...X.literal(e.v), ty: 'bool', nat: 'bool' };
      case 'str': return { ...X.literal(e.v), ty: 'str', nat: 'str', owned: false };
      case 'var': {
        const v = this.env.get(e.name);
        if (!v) throw new Error(`algo-ir: unknown variable ${e.name}`);
        return this.atom(this.id(e.name), v.ty, this.nat(v.ty), { owned: v.owned });
      }
      case 'bin': return this.bin(e.op, this.expr(e.a), this.expr(e.b));
      case 'not': return { ...X.not(this.expr(e.e)), ty: 'bool', nat: 'bool' };
      case 'len': return X.len(this, this.expr(e.e));
      case 'at': {
        const l = this.expr(e.list), i = this.expr(e.i);
        if (!isList(l.ty)) throw new Error('algo-ir: at() on non-list');
        const ty = ELEM[l.ty];
        return { ...X.index(l, this.coerceR(i, this.L.index)), ty, nat: this.nat(ty) };
      }
      case 'metaInt': return X.metaInt(this, this.expr(e.m), e.f);
      case 'metaFlag': return X.metaFlag(this, this.expr(e.m), e.f);
      case 'tokInt': return X.tokInt(this, this.expr(e.t), e.f);
      case 'tokNl': return X.tokNl(this, this.expr(e.t));
      case 'editInt': return X.editInt(this, this.expr(e.e), e.f);
      case 'editText': return X.editText(this, this.expr(e.e));
      case 'metaText': return X.metaText(this, this.expr(e.text), this.expr(e.m));
      case 'substr': return X.substr(this, this.expr(e.s), this.expr(e.a), this.expr(e.b));
      case 'lidOf': return X.lidOf(this, this.expr(e.s));
      case 'mkMeta': return X.mkMeta(this, MK_META_ORDER.map((f) => [f, this.expr(e[f])]));
      case 'shiftMeta': return X.shiftMeta(this, this.expr(e.m), this.expr(e.delta));
      case 'metaEq': return X.metaEq(this, this.expr(e.a), this.expr(e.b));
      case 'call': {
        const fn = this.sigs.get(e.fn);
        if (!fn) throw new Error(`algo-ir: unknown function ${e.fn}`);
        if (fn.ret.length !== 1) throw new Error(`algo-ir: ${e.fn} returns a tuple; use letCall/setCall`);
        return this.atom(this.callCode(e), fn.ret[0], this.nat(fn.ret[0]), { owned: true });
      }
      case 'splice': return X.splice(this, this.expr(e.s), this.expr(e.a), this.expr(e.b), this.expr(e.ins));
      case 'own': return X.own(this, this.expr(e.e));
      case 'newList': return X.newList(this, e.ty, e.cap && this.expr(e.cap), e.estimate && this.expr(e.estimate));
      case 'falses': return X.falses(this, this.expr(e.n));
      case 'prefix': {
        const l = this.expr(e.list);
        if (!isList(l.ty)) throw new Error('algo-ir: prefix() on non-list');
        return X.prefix(this, l, this.expr(e.n), this.expr(e.estimate));
      }
      case 'lexAll': return this.atom(X.call(this.id('lex'), [this.str(this.expr(e.text))]), 'toks', 'toks', { owned: true });
    }
  }

  private bin(op: BinOp, a: R, b: R): R {
    const cmp = COMPARISON.has(op);
    const res = (c: R, d: R, ty: Ty, nat: string, lit?: boolean): R => ({ ...this.L.expr.bin(op, c, d), ty, nat, ...(lit ? { lit } : {}) });
    if (op === 'and' || op === 'or') return res(a, b, 'bool', 'bool');
    if (isNum(a.ty) && isNum(b.ty)) {
      let [ca, cb, nat] = [a, b, a.lit ? b.nat : a.nat];
      if (!(a.lit || b.lit || a.nat === b.nat)) {
        nat = this.nat('int');
        ca = this.coerceR(a, nat);
        cb = this.coerceR(b, nat);
      }
      return { ...res(ca, cb, cmp ? 'bool' : 'int', cmp ? 'bool' : nat), lit: !cmp && a.lit && b.lit };
    }
    if (a.ty === 'str' && b.ty === 'str') return res({ ...a, c: this.str(a) }, { ...b, c: this.str(b) }, 'bool', 'bool');
    if (a.ty === 'bool' && b.ty === 'bool') return res(a, b, 'bool', 'bool');
    throw new Error(`algo-ir: ${a.ty} ${op} ${b.ty}`);
  }

  private callCode(e: Expr & { k: 'call' }): string {
    const fn = this.sigs.get(e.fn)!;
    if (fn.params.length !== e.args.length) throw new Error(`algo-ir: ${e.fn} arity`);
    const args = e.args.map((a, i) => {
      const r = this.expr(a), pt = fn.params[i].ty;
      if (isNum(pt)) return this.coerce(r, this.nat(pt));
      if (pt === 'str') return this.str(r);
      if (isList(pt)) return this.list(r);
      return r.c;
    });
    return this.L.expr.call(this.id(e.fn), args);
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

  private block(body: Stmt[], depth: number): Lines {
    return body.flatMap((s) => this.stmt(s, depth));
  }

  private stmt(s: Stmt, d: number): Lines {
    const L = this.L, S = L.stmt;
    switch (s.k) {
      case 'comment': return S.comment(s.text);
      case 'let': {
        const r = this.expr(s.init);
        const owned = s.ty === 'str' ? !!r.owned : isList(s.ty);
        if (L.owns && isList(s.ty) && !r.owned) throw new Error(`algo-ir: let ${s.name} needs an owned list`);
        this.env.set(s.name, { ty: s.ty, owned });
        const emptyList = s.init.k === 'newList' && !s.init.cap && !s.init.estimate;
        return S.let(this, { id: this.id(s.name), ty: s.ty, r, owned, mutable: this.mutable.has(s.name), reassigned: this.reassigned.has(s.name), emptyList });
      }
      case 'set': {
        const v = this.env.get(s.name);
        if (!v) throw new Error(`algo-ir: set of unknown ${s.name}`);
        const r = this.expr(s.e);
        let val = r.c;
        if (isNum(v.ty)) val = this.coerce(r, this.nat(v.ty));
        else if (L.owns && v.ty === 'str' && !v.owned) val = this.str(r);
        else if (L.owns && v.owned && !r.owned) throw new Error(`algo-ir: set ${s.name} needs an owned value`);
        return S.set(this.id(s.name), val);
      }
      case 'setAt': {
        const v = this.env.get(s.list)!;
        const elem = ELEM[v.ty as ListTy];
        const i = this.expr(s.i), r = this.expr(s.e);
        const val = isNum(elem) ? this.coerce(r, this.nat(elem)) : r.c;
        return S.setAt(this.id(s.list), this.coerce(i, L.index), val);
      }
      case 'push': return S.push(this, this.id(s.list), this.expr(s.e));
      case 'if': {
        const c = this.expr(s.c).c;
        let inline: string | undefined;
        if (!s.else && s.then.length === 1 && (s.then[0].k === 'break' || s.then[0].k === 'set' || s.then[0].k === 'return')) {
          const inner = this.stmt(s.then[0], 0);
          if (inner.length === 1) inline = inner[0];
        }
        const then = this.block(s.then, d + 1);
        return S.if({ c, then, else: s.else && this.block(s.else, d + 1), inline, depth: d });
      }
      case 'while': return S.while(this.expr(s.c).c, this.block(s.body, d + 1));
      case 'for': {
        const from = this.expr(s.from), to = this.expr(s.to);
        this.env.set(s.v, { ty: 'int', owned: false });
        return S.for(this, this.id(s.v), from, to, this.block(s.body, d + 1));
      }
      case 'forEach': {
        const l = this.expr(s.list);
        if (!isList(l.ty)) throw new Error('algo-ir: forEach over non-list');
        this.env.set(s.v, { ty: ELEM[l.ty], owned: false });
        return S.forEach(this.id(s.v), l.c, this.block(s.body, d + 1));
      }
      case 'break': return S.break();
      case 'return': {
        const fn = this.cur!;
        s.es.forEach((e, i) => {
          if (e.k !== 'var' || !this.env.get(e.name)?.owned) return;
          if (s.es.some((o, j) => j > i && refs(o).has(e.name))) throw new Error(`algo-ir: return moves ${e.name} before a later element reads it`);
        });
        const vals = s.es.map((e, i) => {
          const r = this.expr(e), t = fn.ret[i];
          if (isNum(t)) return this.coerce(r, this.nat(t));
          if (L.owns && t === 'str' && !r.owned) return L.expr.own(this, r).c;
          if (L.owns && isList(t) && !r.owned) throw new Error(`algo-ir: return of borrowed list in ${fn.name}`);
          return r.c;
        });
        return S.return(vals);
      }
      case 'letCall': case 'setCall': {
        const fn = this.sigs.get(s.call.fn);
        if (!fn || fn.ret.length !== s.names.length) throw new Error(`algo-ir: ${s.call.fn} destructure arity`);
        const call = this.callCode(s.call);
        if (s.k === 'letCall') s.names.forEach((n, i) => { if (n !== '_') this.env.set(n, { ty: fn.ret[i], owned: true }); });
        else s.names.forEach((n, i) => { if (n !== '_' && this.env.get(n)?.ty !== fn.ret[i]) throw new Error(`algo-ir: setCall type of ${n}`); });
        return S.destructure(this, {
          declare: s.k === 'letCall', names: s.names, ids: s.names.map((n) => this.id(n)), call,
          mutable: (n) => this.mutable.has(n), reassigned: (n) => this.reassigned.has(n),
        });
      }
      case 'lexStep': return S.lexStep(this, { text: this.expr(s.text), posName: s.pos, pos: this.id(s.pos), out: this.id(s.out), state: s.state.map((n) => this.id(n)) });
      case 'shrink': return S.shrink(this, this.id(s.list), this.env.get(s.list)!.ty as ListTy);
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
    return this.L.stmt.fn({
      name: this.id(f.name),
      params: f.params.map((p) => ({ name: this.id(p.name), type: this.type(p.ty, 'param') })),
      rets: f.ret.map((t) => this.type(t, 'ret')),
      doc: f.doc.split('\n'),
      body: this.block(f.body, 1),
    });
  }
}

export function printFns(lowering: Lowering, fns: Fn[]): string {
  const p = new Printer(lowering, fns);
  return fns.map((f) => p.fn(f)).join('\n');
}
