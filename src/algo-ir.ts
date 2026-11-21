// Typed algorithm IR: a family is authored once as `Fn[]` and printed by whichever target supplies
// a `Lowering`. This module assumes no target and no surface syntax: it walks the IR, tracks
// types, mutability and ownership, decides where a numeric conversion is needed, and hands every
// construct — literals, operators, grouping, calls, indexing, statements, blocks, comments,
// function shells — to the lowering as already-printed children. Every branch and loop of the
// algorithm comes from the IR; a lowering only spells it.
import { type TextUnits, unitLen } from './text-units.ts';

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
  | { k: 'lexAll'; text: Expr }
  // The code unit of s at i, 0 <= i < len(s), in the target's native string units.
  | { k: 'code'; s: Expr; i: Expr }
  // Whether the literal occurs in s at i, 0 <= i <= len(s).
  | { k: 'hasAt'; s: Expr; i: Expr; lit: string }
  // The literal's length in the target's native string units (an int constant).
  | { k: 'litLen'; lit: string }
  // Whether c is a member of a declared CharSet (only ASCII codes are ever members).
  | { k: 'inSet'; set: string; c: Expr };

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
// `inline`: called once per token from a lexer's dispatch loop. A lowering may ask its compiler
// to inline it, or splice it into its call sites at generation time (`spliceInline`).
export interface Fn { name: string; doc: string; params: Param[]; ret: Ty[]; body: Stmt[]; inline?: boolean }
export type CodeRange = [number, number];
export interface CharSet { name: string; ranges: CodeRange[] }

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
  // The units the target's strings are indexed in: every offset and length it prints is in them.
  units: TextUnits;
  ident(name: string): string;
  num: Record<Num, string>;
  type(t: Ty, role: Role, owned: boolean): string;
  // Absent: numbers are untyped, so no conversions are printed.
  cast?(cx: Cx, r: R, nat: string): R;
  // Single-owner values: lists and strings are owned or borrowed, and moves are checked.
  owns: boolean;
  borrowStr?(r: R): string;
  borrowList?(r: R): string;
  borrowVal?(r: R): string;
  // A module-level membership table for `inSet`.
  charSet(name: string, ranges: CodeRange[]): string;
  expr: {
    literal(v: number | boolean | string): Printed;
    not(r: R): Printed;
    bin(op: BinOp, a: R, b: R): Printed;
    call(name: string, args: string[]): string;
    len(cx: Cx, l: R): R;
    code(cx: Cx, s: R, i: R): R;
    hasAt(cx: Cx, s: R, i: R, lit: string): R;
    inSet(cx: Cx, set: string, c: R): R;
    // Required when `owns`: an owned copy of a borrowed value.
    own?(cx: Cx, r: R): R;
  };
  stmt: {
    comment(text: string): Lines;
    let(cx: Cx, s: { id: string; ty: Ty; r: R; owned: boolean; mutable: boolean; reassigned: boolean; emptyList: boolean }): Lines;
    set(id: string, val: string): Lines;
    // `inline` is the sole statement of a branch-free `if` printed on one line, when it is short.
    if(s: { c: string; then: Lines; else?: Lines; inline?: string; depth: number }): Lines;
    while(c: string, body: Lines): Lines;
    break(): Lines;
    return(vals: string[]): Lines;
    fn(s: { name: string; params: { name: string; type: string }[]; rets: string[]; doc: string[]; body: Lines; inline: boolean }): string;
  };
  // `inline` fns are not printed as functions; each call site prints `inlineFn` of the body
  // instead (for compilers that cannot be told to inline a function).
  spliceInline?: boolean;
  // The token-stream constructs (metas, tokens, edits, lists) the relex family is written in.
  relex?: RelexLowering;
}

export interface RelexLowering {
  index: string;                                      // native type of list indices
  expr: {
    index(list: R, i: R): Printed;
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
    newList(cx: Cx, ty: ListTy, cap?: R, estimate?: R): R;
    falses(cx: Cx, n: R): R;
    prefix(cx: Cx, list: R, n: R, estimate: R): R;
  };
  stmt: {
    setAt(id: string, i: string, val: string): Lines;
    push(cx: Cx, list: string, r: R): Lines;
    for(cx: Cx, v: string, from: R, to: R, body: Lines): Lines;
    forEach(v: string, list: string, body: Lines): Lines;
    destructure(cx: Cx, s: { declare: boolean; names: string[]; ids: string[]; call: string; mutable: (n: string) => boolean; reassigned: (n: string) => boolean }): Lines;
    lexStep(cx: Cx, s: { text: R; posName: string; pos: string; out: string; state: string[] }): Lines;
    shrink(cx: Cx, list: string, ty: ListTy): Lines;
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
  private sets: Set<string>;
  private L: Lowering;

  constructor(lowering: Lowering, fns: Fn[], sets: CharSet[]) {
    this.L = lowering;
    this.sigs = new Map(fns.map((f) => [f.name, f]));
    this.sets = new Set(sets.map((c) => c.name));
  }

  private rx(): RelexLowering {
    if (!this.L.relex) throw new Error('algo-ir: the lowering prints no token-stream constructs');
    return this.L.relex;
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
    const RX = (): RelexLowering['expr'] => this.rx().expr;
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
        return { ...RX().index(l, this.coerceR(i, this.rx().index)), ty, nat: this.nat(ty) };
      }
      case 'metaInt': return RX().metaInt(this, this.expr(e.m), e.f);
      case 'metaFlag': return RX().metaFlag(this, this.expr(e.m), e.f);
      case 'tokInt': return RX().tokInt(this, this.expr(e.t), e.f);
      case 'tokNl': return RX().tokNl(this, this.expr(e.t));
      case 'editInt': return RX().editInt(this, this.expr(e.e), e.f);
      case 'editText': return RX().editText(this, this.expr(e.e));
      case 'metaText': return RX().metaText(this, this.expr(e.text), this.expr(e.m));
      case 'substr': return RX().substr(this, this.expr(e.s), this.expr(e.a), this.expr(e.b));
      case 'lidOf': return RX().lidOf(this, this.expr(e.s));
      case 'mkMeta': return RX().mkMeta(this, MK_META_ORDER.map((f) => [f, this.expr(e[f])]));
      case 'shiftMeta': return RX().shiftMeta(this, this.expr(e.m), this.expr(e.delta));
      case 'metaEq': return RX().metaEq(this, this.expr(e.a), this.expr(e.b));
      case 'call': {
        const fn = this.sigs.get(e.fn);
        if (!fn) throw new Error(`algo-ir: unknown function ${e.fn}`);
        if (fn.ret.length !== 1) throw new Error(`algo-ir: ${e.fn} returns a tuple; use letCall/setCall`);
        return this.atom(this.callCode(e), fn.ret[0], this.nat(fn.ret[0]), { owned: true });
      }
      case 'splice': return RX().splice(this, this.expr(e.s), this.expr(e.a), this.expr(e.b), this.expr(e.ins));
      case 'own': return this.own(this.expr(e.e));
      case 'newList': return RX().newList(this, e.ty, e.cap && this.expr(e.cap), e.estimate && this.expr(e.estimate));
      case 'falses': return RX().falses(this, this.expr(e.n));
      case 'prefix': {
        const l = this.expr(e.list);
        if (!isList(l.ty)) throw new Error('algo-ir: prefix() on non-list');
        return RX().prefix(this, l, this.expr(e.n), this.expr(e.estimate));
      }
      case 'lexAll': return this.atom(X.call(this.id('lex'), [this.str(this.expr(e.text))]), 'toks', 'toks', { owned: true });
      case 'code': return X.code(this, this.expr(e.s), this.expr(e.i));
      case 'hasAt': return X.hasAt(this, this.expr(e.s), this.expr(e.i), e.lit);
      case 'litLen': return this.expr({ k: 'int', v: unitLen(e.lit, this.L.units) });
      case 'inSet': {
        if (!this.sets.has(e.set)) throw new Error(`algo-ir: undeclared char set ${e.set}`);
        return X.inSet(this, this.id(e.set), this.expr(e.c));
      }
    }
  }

  private own(r: R): R {
    if (!this.L.expr.own) throw new Error('algo-ir: an owning lowering needs own()');
    return this.L.expr.own(this, r);
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
        return this.rx().stmt.setAt(this.id(s.list), this.coerce(i, this.rx().index), val);
      }
      case 'push': return this.rx().stmt.push(this, this.id(s.list), this.expr(s.e));
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
        return this.rx().stmt.for(this, this.id(s.v), from, to, this.block(s.body, d + 1));
      }
      case 'forEach': {
        const l = this.expr(s.list);
        if (!isList(l.ty)) throw new Error('algo-ir: forEach over non-list');
        this.env.set(s.v, { ty: ELEM[l.ty], owned: false });
        return this.rx().stmt.forEach(this.id(s.v), l.c, this.block(s.body, d + 1));
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
          if (L.owns && t === 'str' && !r.owned) return this.own(r).c;
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
        return this.rx().stmt.destructure(this, {
          declare: s.k === 'letCall', names: s.names, ids: s.names.map((n) => this.id(n)), call,
          mutable: (n) => this.mutable.has(n), reassigned: (n) => this.reassigned.has(n),
        });
      }
      case 'lexStep': return this.rx().stmt.lexStep(this, { text: this.expr(s.text), posName: s.pos, pos: this.id(s.pos), out: this.id(s.out), state: s.state.map((n) => this.id(n)) });
      case 'shrink': return this.rx().stmt.shrink(this, this.id(s.list), this.env.get(s.list)!.ty as ListTy);
    }
  }

  private cur: Fn | null = null;

  stmts(vars: Param[], body: Stmt[]): Lines {
    this.env = new Map();
    this.mutable = new Set();
    this.reassigned = new Set();
    this.cur = null;
    this.scan(body);
    for (const v of vars) this.env.set(v.name, { ty: v.ty, owned: false });
    return this.block(body, 0);
  }

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
      inline: f.inline === true,
    });
  }
}

// Statements printed in a caller's scope, where `vars` are already bound; `fns` are the callable
// signatures.
export function printStmts(lowering: Lowering, fns: Fn[], sets: CharSet[], vars: Param[], body: Stmt[]): Lines {
  return new Printer(lowering, fns, sets).stmts(vars, body);
}

const hasReturn = (ss: Stmt[]): boolean => ss.some((s) =>
  s.k === 'return' || (s.k === 'if' && (hasReturn(s.then) || hasReturn(s.else ?? []))) || (s.k === 'while' && hasReturn(s.body)));
const alwaysReturns = (ss: Stmt[]): boolean => {
  const l = ss[ss.length - 1];
  return !!l && (l.k === 'return' || (l.k === 'if' && alwaysReturns(l.then) && alwaysReturns(l.else ?? [])));
};

// Generation-time inlining: the body of `f` (one numeric result) as statements that leave the
// result in a new local `out` instead of returning it. Params become the caller's `args`;
// locals that would clash with them are renamed. A return inside a loop ends the loop, and what
// follows the loop runs only while `out` still holds `unset`, a value `f` never returns.
export function inlineFn(f: Fn, args: string[], out: string, unset: number): Stmt[] {
  if (f.ret.length !== 1 || !isNum(f.ret[0]) || args.length !== f.params.length) throw new Error(`algo-ir: cannot inline ${f.name}`);
  const ren = new Map(f.params.map((p, i) => [p.name, args[i]]));
  const locals = new Set<string>();
  const collect = (ss: Stmt[]): void => ss.forEach((s) => {
    if (s.k === 'let') locals.add(s.name);
    else if (s.k === 'if') { collect(s.then); collect(s.else ?? []); }
    else if (s.k === 'while') collect(s.body);
  });
  collect(f.body);
  const taken = new Set([...args, out, ...locals]);
  for (const n of locals) {
    if (n !== out && !args.includes(n)) continue;
    let m = n;
    for (let k = 1; taken.has(m); k++) m = `${n}${k}`;
    taken.add(m);
    ren.set(n, m);
  }
  const name = (n: string): string => ren.get(n) ?? n;
  const ex = (e: Expr): Expr => {
    if (e.k === 'var') return { k: 'var', name: name(e.name) };
    const o: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(e)) {
      o[key] = Array.isArray(v) ? v.map((y) => (typeof y === 'object' && y && 'k' in y ? ex(y as Expr) : y))
        : typeof v === 'object' && v && 'k' in v ? ex(v as Expr) : v;
    }
    return o as Expr;
  };
  const setOut = (e: Expr): Stmt => ({ k: 'set', name: out, e: ex(e) });
  const guard = (rest: Stmt[]): Stmt[] => (rest.length ? [{ k: 'if', c: { k: 'bin', op: 'eq', a: { k: 'var', name: out }, b: { k: 'int', v: unset } }, then: go(rest, false) }] : []);
  const branch = (ss: Stmt[], inLoop: boolean): Stmt[] | undefined => (ss.length ? go(ss, inLoop) : undefined);
  function go(ss: Stmt[], inLoop: boolean): Stmt[] {
    const res: Stmt[] = [];
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i], rest = ss.slice(i + 1);
      switch (s.k) {
        case 'let': res.push({ ...s, name: name(s.name), init: ex(s.init) }); continue;
        case 'set': res.push({ ...s, name: name(s.name), e: ex(s.e) }); continue;
        case 'break': case 'comment': res.push(s); continue;
        case 'return':
          if (s.es.length !== 1) throw new Error(`algo-ir: cannot inline ${f.name}`);
          res.push(setOut(s.es[0]), ...(inLoop ? [{ k: 'break' } as Stmt] : []));
          return res;
        case 'if': {
          const c = ex(s.c), t = s.then, e = s.else ?? [];
          if (inLoop || !hasReturn([s])) { res.push({ k: 'if', c, then: go(t, inLoop), else: branch(e, inLoop) }); continue; }
          const at = alwaysReturns(t), ae = alwaysReturns(e);
          if (at && ae) res.push({ k: 'if', c, then: go(t, false), else: go(e, false) });
          else if (at) res.push({ k: 'if', c, then: go(t, false), else: branch([...e, ...rest], false) });
          else if (ae) res.push({ k: 'if', c, then: go([...t, ...rest], false), else: go(e, false) });
          else res.push({ k: 'if', c, then: go(t, false), else: branch(e, false) }, ...guard(rest));
          return res;
        }
        case 'while': {
          if (inLoop && hasReturn(s.body)) throw new Error(`algo-ir: cannot inline ${f.name}: return in a nested loop`);
          res.push({ k: 'while', c: ex(s.c), body: go(s.body, true) });
          if (inLoop || !hasReturn(s.body)) continue;
          res.push(...guard(rest));
          return res;
        }
        default: throw new Error(`algo-ir: cannot inline ${f.name}: ${s.k}`);
      }
    }
    return res;
  }
  return [{ k: 'let', name: out, ty: f.ret[0], init: { k: 'int', v: unset } }, ...go(f.body, false)];
}

export function printFns(lowering: Lowering, fns: Fn[], sets: CharSet[] = []): string {
  const p = new Printer(lowering, fns, sets);
  return [...sets.map((c) => lowering.charSet(lowering.ident(c.name), c.ranges)), ...fns.map((f) => p.fn(f))].join('\n');
}
