// shapeTypes: the TYPES of a shape's values (src/shape/shape2-eval.ts `defineShape`), derived from the
// spec and its grammar alone, for a printer that builds a shape's AST as typed data (the Rust
// target: one struct per node kind, one enum per union of kinds). Target-neutral: it names the
// types and their fields; a printer spells them.
//
// - A NODE KIND is each constant kind string a `node` term can give (a `match` on an operator's
//   text gives each of its cases). Its FIELDS are the union, over every node term of that kind, of
//   the field's values; a field some term of the kind does not write, or writes `absent`, is
//   OPTIONAL and left out when absent; one that can be `null` is optional and written null.
// - A RULE's type is the union of its arms' values (a node union: an enum of kinds; or one scalar,
//   list or record type). A rule some arm of which may give no value (an unmapped or unsupported
//   arm, a `match` without a case) MAY MISS: its union has a Missing variant.
// - Scalars: an open string (source text or cooked), a CLOSED string (only constants: an enum of
//   them), a number, a bool. A list holds one element type (an absent element is null); a record
//   is a struct (a record-valued rule's: named after the rule).
// A value that unions two of those (a node with a string, a list with a scalar) has no typed form:
// shapeTypes lists EVERY such site (ShapeTypeError), `<rule>.<arm>: field <f> unions <...>`.
import type { Card, Shape, ScopeInfo, Slot } from './shape2-eval.ts';
import { cardOf } from './shape2-eval.ts';
import type { RuleExpr } from '../grammar/types.ts';
import type { Term } from './shape2-schema.ts';

/** A value's type as derived: what it can be (several only at an untypeable site). */
export type VType = {
  nodes: Set<string>; records: Set<string>;
  str: boolean; strs: Set<string>; num: boolean; bool: boolean;
  list: VType | null;
  absent: boolean; nul: boolean; missing: boolean;
};
/** A typed form (what a printer spells). `opt`: absent (left out) or null (written null) as none. */
export type TypeRef =
  | { k: 'union'; name: string } | { k: 'str' } | { k: 'strEnum'; name: string } | { k: 'num' } | { k: 'bool' }
  | { k: 'list'; of: TypeRef; elemNull: boolean } | { k: 'record'; name: string } | { k: 'none' };
export type FieldType = { ty: TypeRef; opt: 'absent' | 'null' | null };
/** A record type's key: its field names (every record term with them builds it). */
export const recordKey = (fields: string[]): string => `{${[...fields].sort().join(',')}}`;
export type KindDecl = { name: string; record: boolean; key: string; fields: { name: string; type: FieldType }[] };
export type UnionDecl = { name: string; kinds: string[]; missing: boolean };
export type StrEnumDecl = { name: string; values: string[] };
export type ShapeTypes = {
  /** Node kinds then record types, in first-seen order. */
  kinds: KindDecl[];
  unions: UnionDecl[];
  enums: StrEnumDecl[];
  /** Each mapped (or read) rule's value type. */
  rules: Map<string, FieldType & { missing: boolean }>;
};

export class ShapeTypeError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`shape types: ${problems.length} site(s) with no typed form:\n  ${problems.join('\n  ')}`);
    this.problems = problems;
  }
}

const empty = (): VType => ({ nodes: new Set(), records: new Set(), str: false, strs: new Set(), num: false, bool: false, list: null, absent: false, nul: false, missing: false });
const join = (...ts: VType[]): VType => {
  const o = empty();
  for (const t of ts) {
    t.nodes.forEach((x) => o.nodes.add(x)); t.records.forEach((x) => o.records.add(x)); t.strs.forEach((x) => o.strs.add(x));
    o.str ||= t.str; o.num ||= t.num; o.bool ||= t.bool; o.absent ||= t.absent; o.nul ||= t.nul; o.missing ||= t.missing;
    if (t.list) o.list = o.list ? join(o.list, t.list) : t.list;
  }
  return o;
};
const key = (t: VType): string => JSON.stringify(t, (_k, v) => (v instanceof Set ? [...v].sort() : v));
const of = (f: Partial<VType>): VType => ({ ...empty(), ...f });

/** The constant kinds a node term's `type` can give, or null when it is not a closed set. */
export function kindsOf(t: Term): string[] | null {
  if (t.t === 'const') return typeof t.value === 'string' ? [t.value] : null;
  if (t.t === 'match') {
    const out: string[] = [];
    for (const x of [...Object.values(t.cases), ...(t.else ? [t.else] : [])]) {
      const k = kindsOf(x);
      if (k === null) return null;
      for (const y of k) if (!out.includes(y)) out.push(y);
    }
    return out;
  }
  return null;
}

/** The categories a type holds (more than one: no typed form). */
function categories(t: VType): string[] {
  const c: string[] = [];
  if (t.nodes.size) c.push(`node kinds ${[...t.nodes].join(' | ')}`);
  if (t.records.size) c.push(`record ${[...t.records].join(' | ')}`);
  if (t.str || t.strs.size) c.push('string');
  if (t.num) c.push('number');
  if (t.bool) c.push('bool');
  if (t.list) c.push('list');
  return c;
}

type SScope = { info: ScopeInfo; base: RuleExpr[]; outer?: SScope; vars: Map<string, VType> };
const startsWith = (a: RuleExpr[], p: RuleExpr[]): boolean => p.every((q, i) => a[i] === q);
const isList = (q: RuleExpr): boolean => q.type === 'sep' || (q.type === 'quantifier' && q.kind !== '?');
function resolve(s: SScope, name: string): { slot: Slot; card: Card; scope: SScope } | undefined {
  const slot = s.info.slots.get(name);
  if (slot && startsWith(slot.quants, s.base)) return { slot, card: cardOf(slot.quants.slice(s.base.length)), scope: s };
  return s.outer ? resolve(s.outer, name) : undefined;
}
const lookupVar = (s: SScope, n: string): VType | undefined => s.vars.get(n) ?? (s.outer ? lookupVar(s.outer, n) : undefined);

const COOK_TY: Record<string, Partial<VType>> = {
  numberValue: { num: true }, tsNumericLiteralFlags: { num: true, absent: true }, tsTemplateFlags: { num: true, absent: true },
  hasExtendedUnicodeEscape: { bool: true }, templateCooked: { str: true, nul: true },
};

/** Derive `shape`'s types. `missingArms`: "rule.arm" of arms a printer builds no value for
 * (unsupported), beside the unmapped ones. Throws ShapeTypeError listing every untypeable site. */
export function shapeTypes(shape: Shape, missingArms: Set<string> = new Set()): ShapeTypes {
  const spec = shape.spec;
  const g = shape.grammar;
  const ruleTy = new Map<string, VType>();
  type KindAcc = { record: boolean; terms: number; fields: Map<string, { ty: VType; n: number }>; order: string[]; sites: Set<string> };
  let kinds = new Map<string, KindAcc>();
  let prevKinds = new Map<string, KindAcc>();
  let problems: string[] = [];
  const recHint = new Map<string, string>();
  const synTy = (attr: string): VType => {
    const d = spec.synthesized?.[attr];
    return d ? of(d.type === 'string' ? { str: true } : d.type === 'number' ? { num: true } : { bool: true }) : empty();
  };
  const inhTy = (attr: string): VType => {
    const d = spec.inherited?.[attr];
    if (!d) return empty();
    return of(d.type === 'string' ? { str: true } : d.type === 'number' ? { num: true } : d.type === 'bool' ? { bool: true } : { list: of({}) });
  };
  const childTy = (rule: string | undefined, card: Card): VType => {
    const rt = rule ? (ruleTy.get(rule) ?? of(spec.rules[rule] ? {} : { missing: true })) : of({ missing: true });
    return card === 'many' ? of({ list: rt }) : card === 'opt' ? join(rt, of({ absent: true })) : rt;
  };
  const kindAcc = (name: string, record: boolean): KindAcc => {
    let k = kinds.get(name);
    if (!k) kinds.set(name, (k = { record, terms: 0, fields: new Map(), order: [], sites: new Set() }));
    return k;
  };
  const addTerm = (k: KindAcc, fields: [string, VType][], w: string): void => {
    k.terms++; k.sites.add(w);
    for (const [f, t] of fields) {
      let e = k.fields.get(f);
      if (!e) { k.fields.set(f, (e = { ty: empty(), n: 0 })); k.order.push(f); }
      e.ty = join(e.ty, t); e.n++;
    }
  };
  function ty(t: Term, s: SScope, w: string, hint: string): VType {
    switch (t.t) {
      case 'const': return t.value === null ? of({ nul: true }) : typeof t.value === 'string' ? of({ strs: new Set([t.value]) }) : typeof t.value === 'number' ? of({ num: true }) : of({ bool: true });
      case 'absent': return of({ absent: true });
      case 'child': { const r = resolve(s, t.name); return r ? childTy(r.slot.rule, r.card) : of({ missing: true }); }
      case 'text': return of({ str: true });
      case 'cook': return of(COOK_TY[t.fn] ?? { str: true });
      case 'present': return of({ bool: true });
      case 'armOf': return of({ str: true });
      case 'syn': return synTy(t.attr);
      case 'inh': return inhTy(t.attr);
      case 'node': {
        const ks = kindsOf(t.type);
        const fields = Object.entries(t.fields).map(([f, x]) => [f, ty(x, s, `${w}.${f}`, f)] as [string, VType]);
        if (ks === null) { problems.push(`${w}: a node whose kind is not a closed set of constants; no typed form`); return of({ missing: true }); }
        for (const k of ks) addTerm(kindAcc(k, false), fields, w);
        return of({ nodes: new Set(ks), missing: t.type.t === 'match' && t.type.else === undefined });
      }
      case 'record': {
        const fields = Object.entries(t.fields).map(([f, x]) => [f, ty(x, s, `${w}.${f}`, f)] as [string, VType]);
        const rk = recordKey(Object.keys(t.fields));
        if (!recHint.has(rk)) recHint.set(rk, hint);
        addTerm(kindAcc(rk, true), fields, w);
        return of({ records: new Set([rk]) });
      }
      case 'get': {
        const r = resolve(s, t.name);
        const rt = r?.slot.rule ? ruleTy.get(r.slot.rule) : undefined;
        const out = empty();
        // The record's field as the previous round derived it (this round may not have reached the
        // record's own terms yet); the rounds repeat until the records are stable too.
        for (const rec of rt?.records ?? []) {
          const k = prevKinds.get(rec), f = k?.fields.get(t.field);
          if (f) Object.assign(out, join(out, f.ty));
          if (!f || f.n < k!.terms) out.absent = true;
        }
        if (rt?.missing) out.missing = true;
        return out;
      }
      case 'list': {
        const els: VType[] = [];
        t.items.forEach((x, i) => {
          if (x !== null && typeof x === 'object' && 'spread' in x) { const l = ty(x.spread, s, `${w}[${i}]...`, hint); els.push(l.list ?? empty()); }
          else els.push(ty(x as Term, s, `${w}[${i}]`, hint));
        });
        return of({ list: join(...els) });
      }
      case 'dropLastIf': ty(t.cond, s, `${w} cond`, hint); return ty(t.list, s, `${w} list`, hint);
      case 'match': {
        ty(t.on, s, `${w} on`, hint);
        const cs = Object.entries(t.cases).map(([k, x]) => ty(x, s, `${w} case ${JSON.stringify(k)}`, hint));
        return t.else ? join(...cs, ty(t.else, s, `${w} else`, hint)) : join(...cs, of({ missing: true }));
      }
      case 'if': ty(t.cond, s, `${w} cond`, hint); return join(ty(t.then, s, `${w} then`, hint), ty(t.else, s, `${w} else`, hint));
      case 'and': case 'or': t.args.forEach((x, i) => ty(x, s, `${w}[${i}]`, hint)); return of({ bool: true });
      case 'not': ty(t.arg, s, w, hint); return of({ bool: true });
      case 'orElse': { const a = ty(t.of, s, `${w} of`, hint); return join({ ...a, absent: false }, ty(t.else, s, `${w} else`, hint)); }
      case 'branch': {
        const r = resolve(s, t.name);
        if (!r || !r.slot.branches) return of({ missing: true });
        const cs: VType[] = [];
        for (const [bn, info] of r.slot.branches) {
          const x = t.cases[bn];
          cs.push(x === undefined ? of({ missing: true }) : ty(x, { info, base: [], outer: s, vars: new Map() }, `${w} case ${bn}`, hint));
        }
        return join(...cs);
      }
      case 'map': case 'fold': {
        const r = resolve(s, t.over);
        if (!r) return of({ missing: true });
        const inner = r.slot.quants.slice(r.scope.base.length);
        const at = inner.map(isList).lastIndexOf(true);
        const it = (vars: Map<string, VType>): SScope => ({ info: r.scope.info, base: [...r.scope.base, ...inner.slice(0, at + 1)], outer: s, vars });
        if (t.t === 'map') { const b = ty(t.body, it(new Map()), `${w} body`, hint); return of({ list: b.absent ? { ...b, absent: false, nul: true } : b }); }
        let acc = ty(t.init, s, `${w} init`, hint);
        for (let i = 0; i < 8; i++) {
          const next = join(acc, ty(t.body, it(new Map([[t.acc, acc]])), `${w} body`, hint));
          if (key(next) === key(acc)) break;
          acc = next;
        }
        return acc;
      }
      case 'let': {
        const v = ty(t.value, s, `${w} value`, hint);
        return ty(t.body, { ...s, vars: new Map([...s.vars, [t.name, v]]) }, `${w} body`, hint);
      }
      case 'var': return lookupVar(s, t.name) ?? of({ missing: true });
    }
  }
  // The rule types to a fixpoint (recursive rules read their own type).
  const ruleNames = Object.keys(spec.rules);
  for (let round = 0; ; round++) {
    prevKinds = kinds; kinds = new Map(); problems = [];
    let changed = false;
    for (const rule of ruleNames) {
      const arms = g.arms.get(rule) ?? [];
      const mapped = spec.rules[rule]!;
      const tys: VType[] = [];
      for (const a of arms) {
        const term = mapped[a.arm];
        if (term === undefined || missingArms.has(`${rule}.${a.arm}`)) { tys.push(of({ missing: true })); if (term === undefined) continue; }
        tys.push(ty(term, { info: a, base: [], vars: new Map() }, `${rule}.${a.arm}`, rule));
      }
      const next = join(...tys);
      if (key(next) !== key(ruleTy.get(rule) ?? empty())) { ruleTy.set(rule, next); changed = true; }
    }
    const recKey = (m: Map<string, KindAcc>): string => JSON.stringify([...m].filter(([, k]) => k.record).map(([n, k]) => [n, k.terms, [...k.fields].map(([f, e]) => [f, e.n, key(e.ty)])]));
    if (recKey(kinds) !== recKey(prevKinds)) changed = true;
    if (!changed) break;
    if (round > 40) throw new ShapeTypeError([`the rule types do not reach a fixpoint (a rule whose value nests itself in a list without end)`]);
  }

  // Typed forms: unions of kinds (a rule's own name when a rule has exactly that union), closed
  // string enums, lists.
  const unions = new Map<string, UnionDecl>();
  const unionByKinds = new Map<string, string>();
  const enums = new Map<string, StrEnumDecl>();
  const used = new Set<string>([...kinds].filter(([, k]) => !k.record).map(([n]) => n));
  const fresh = (base: string): string => { let n = used.has(base) ? `${base}Value` : base, i = 2; while (used.has(n)) n = `${base}${i++}`; used.add(n); return n; };
  const pascal = (s: string): string => s.replace(/(^|[^A-Za-z0-9])([A-Za-z0-9])/g, (_m, _a, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');
  const unionOf = (ks: Set<string>, name: string, missing: boolean): string => {
    const k = [...ks].sort().join('|');
    const have = unionByKinds.get(k);
    if (have) { if (missing) unions.get(have)!.missing = true; return have; }
    const n = fresh(name);
    unions.set(n, { name: n, kinds: [...ks], missing });
    unionByKinds.set(k, n);
    return n;
  };
  const typeRef = (t: VType, w: string, name: string, missing = false): TypeRef => {
    const cs = categories(t);
    if (cs.length > 1) { problems.push(`${w} unions ${cs.join(' with ')}; no typed form`); return { k: 'none' }; }
    if (t.nodes.size) return { k: 'union', name: unionOf(t.nodes, name, missing) };
    if (t.records.size > 1) { problems.push(`${w} unions records ${[...t.records].join(' with ')}; no typed form`); return { k: 'none' }; }
    if (t.records.size) return { k: 'record', name: recName([...t.records][0]!) };
    if (t.str) return { k: 'str' };
    if (t.strs.size) {
      const vals = [...t.strs].sort();
      const have = [...enums.values()].find((e) => e.values.join('\0') === vals.join('\0'));
      if (have) return { k: 'strEnum', name: have.name };
      const n = fresh(name); enums.set(n, { name: n, values: vals });
      return { k: 'strEnum', name: n };
    }
    if (t.num) return { k: 'num' };
    if (t.bool) return { k: 'bool' };
    if (t.list) {
      if (t.list.absent && t.list.nul) problems.push(`${w}: a list element that is absent in some terms and null in others; no typed form`);
      return { k: 'list', of: typeRef({ ...t.list, absent: false, nul: false }, `${w} element`, `${name}Item`), elemNull: t.list.absent || t.list.nul };
    }
    return { k: 'none' };
  };
  const optOf = (t: VType, w: string): 'absent' | 'null' | null => {
    if (t.absent && t.nul) { problems.push(`${w}: absent in some terms and null in others; no typed form`); return 'absent'; }
    // A value that is only ever missing (a child of an unmapped rule) is written as absent.
    return t.absent || (!t.nul && categories(t).length === 0) ? 'absent' : t.nul ? 'null' : null;
  };
  const recNames = new Map<string, string>();
  for (const [n, k] of kinds) if (k.record) recNames.set(n, fresh(pascal(recHint.get(n) ?? 'Record')));
  function recName(k: string): string { return recNames.get(k)!; }
  const rules = new Map<string, FieldType & { missing: boolean }>();
  for (const rule of ruleNames) {
    const t = ruleTy.get(rule)!;
    rules.set(rule, { ty: typeRef(t, `${rule}: its arms`, pascal(rule), t.missing), opt: optOf(t, `${rule}: its arms`), missing: t.missing });
  }
  const kindDecls: KindDecl[] = [];
  for (const [name, k] of kinds) {
    kindDecls.push({
      name: k.record ? recName(name) : name, record: k.record, key: name,
      fields: k.order.map((f) => {
        const e = k.fields.get(f)!;
        const t = e.n < k.terms ? join(e.ty, of({ absent: true })) : e.ty;
        const w = `${[...k.sites].join(', ')}: ${name} field ${f}`;
        return { name: f, type: { ty: typeRef(t, w, `${pascal(name)}${pascal(f)}`), opt: optOf(t, w) } };
      }),
    });
  }
  if (problems.length) throw new ShapeTypeError([...new Set(problems)]);
  return { kinds: kindDecls, unions: [...unions.values()], enums: [...enums.values()], rules };
}
