// The REFERENCE INTERPRETER of ShapeSpec v2 (src/shape2-schema.ts): (spec, interpreter CST) ->
// value. It is the executable definition printers will be checked against, so it is written to
// be small and obviously correct, not fast: an arm is found by a backtracking match of the CST
// node's children against the grammar's arms in declaration order (greedy repetitions, the
// first arm that consumes every child wins: the parser's own tie-break), and every name comes
// from the one deriver (src/grammar-names.ts).
//
//   loadShape2(grammar, spec)   type-checks the spec against the grammar and rejects anything
//                               outside the calculus (Shape2SpecError lists every problem)
//   evaluate(loaded, cst, src)  the value of a CST node (a Program, or any node: e.g. a Stmt)
//   dependencies(loaded)        per (rule, arm): which inherited attributes its value reads
import type { CstChild, CstLeaf, CstNode } from './gen-parser.ts';
import type { CstGrammar, RuleDecl, RuleExpr } from './types.ts';
import { isKeywordLiteral } from './grammar-utils.ts';
import { nameRule, OP_FORM_CHILDREN, type RuleNames } from './grammar-names.ts';
import { COOK_FNS, OPERATORS, type CookFn, type InhAttr, type InhEq, type Scalar, type Shape2Spec, type Span, type Term, type ThreadEq } from './shape2-schema.ts';

// ── Values ──

/** A node value: the same plain-data form the oracle harness compares (test/shape-oracle.ts). */
export type S2Node = { kind: string; start: number; end: number; fields: Record<string, S2Value> };
export type S2Value = S2Node | S2Value[] | Scalar | { record: Record<string, S2Value> };

export class Shape2SpecError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(`shape2 spec rejected:\n  ${problems.join('\n  ')}`); this.problems = problems; }
}
/** Evaluation reached an arm the (non-total) spec does not map. */
export class Shape2Unmapped extends Error {
  readonly rule: string;
  readonly arm: string;
  constructor(rule: string, arm: string) { super(`shape2: ${rule}.${arm} is not mapped`); this.rule = rule; this.arm = arm; }
}

// ── The static view of an arm: its named children ──

type SlotKind = 'node' | 'leaf' | 'branch' | 'template';
type Card = 'one' | 'opt' | 'many';
/** A named child. `quants`: the repetitions / optionals around it inside its scope, outer first. */
type Slot = { name: string; kind: SlotKind; rule?: string; node: RuleExpr; quants: RuleExpr[]; branches?: Map<string, ScopeInfo> };
type ScopeInfo = { where: string; slots: Map<string, Slot> };
type ArmInfo = ScopeInfo & { rule: string; arm: string; form?: 'binary' | 'prefix' | 'postfix'; items?: RuleExpr[] };

const ZERO_WIDTH = new Set(['not', 'sameLine', 'noCommentBefore', 'noMultilineFlowBefore', 'notLeftLeaf']);
const isList = (q: RuleExpr): boolean => q.type === 'sep' || (q.type === 'quantifier' && q.kind !== '?');
const cardOf = (quants: RuleExpr[]): Card => (quants.some(isList) ? 'many' : quants.length ? 'opt' : 'one');

type GrammarView = {
  rules: Map<string, RuleDecl>; tokens: Set<string>; templates: Set<string>; arms: Map<string, ArmInfo[]>;
  names: Map<string, RuleNames>;
  /** Each structural alternation's branch scopes, in branch order. */
  branchScopes: Map<RuleExpr, ScopeInfo[]>;
};

function viewOf(grammar: CstGrammar): GrammarView {
  const g: GrammarView = {
    rules: new Map(grammar.rules.map((r) => [r.name, r])),
    tokens: new Set(grammar.tokens.map((t) => t.name)),
    templates: new Set(grammar.tokens.filter((t) => t.template).map((t) => t.name)),
    arms: new Map(),
    names: new Map(),
    branchScopes: new Map(),
  };
  for (const r of grammar.rules) g.arms.set(r.name, armsOf(g, r));
  return g;
}

function armsOf(g: GrammarView, rule: RuleDecl): ArmInfo[] {
  const names = nameRule(rule);
  g.names.set(rule.name, names);
  const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
  const out: ArmInfo[] = [];
  const opMarker = (e: RuleExpr): boolean => e.type === 'op' || e.type === 'prefix' || e.type === 'postfix';
  for (const alt of alts) {
    const raw = alt.type === 'seq' ? alt.items : [alt];
    const items = raw[0]?.type === 'notLeftLeaf' ? raw.slice(1) : raw;
    if (items.some(opMarker)) continue;
    const arm = names.armOf.get(alt)!.name;
    const info: ArmInfo = { rule: rule.name, arm, where: `${rule.name}.${arm}`, slots: new Map(), items };
    for (const it of items) walk(g, names, it, [], info);
    out.push(info);
  }
  if (names.ops) {
    for (const form of ['binary', 'prefix', 'postfix'] as const) {
      const arm = names.ops[form];
      const info: ArmInfo = { rule: rule.name, arm, where: `${rule.name}.${arm}`, slots: new Map(), form };
      for (const nm of OP_FORM_CHILDREN[form]) {
        info.slots.set(nm, nm === 'op'
          ? { name: nm, kind: 'leaf', node: { type: 'literal', value: '' }, quants: [] }
          : { name: nm, kind: 'node', rule: rule.name, node: { type: 'ref', name: rule.name }, quants: [] });
      }
      out.push(info);
    }
  }
  return out;
}

function walk(g: GrammarView, names: RuleNames, it: RuleExpr, quants: RuleExpr[], scope: ScopeInfo): void {
  const add = (kind: SlotKind, rule?: string, branches?: Map<string, ScopeInfo>): void => {
    const slot = names.childOf.get(it);
    if (!slot) return;
    scope.slots.set(slot.name, { name: slot.name, kind, rule, node: it, quants, branches });
  };
  switch (it.type) {
    case 'ref':
      if (g.tokens.has(it.name)) add(g.templates.has(it.name) ? 'template' : 'leaf');
      else add('node', it.name);
      return;
    case 'literal': add('leaf'); return;
    case 'group': walk(g, names, it.body, quants, scope); return;
    case 'seq': for (const s of it.items) walk(g, names, s, quants, scope); return;
    case 'quantifier': walk(g, names, it.body, [...quants, it], scope); return;
    case 'sep': walk(g, names, it.element, [...quants, it], scope); return;
    case 'alt': {
      if (it.items.length > 0 && it.items.every((x) => x.type === 'literal')) { add('leaf'); return; }
      const branches = new Map<string, ScopeInfo>();
      for (const b of it.items) {
        const bn = names.armOf.get(b)!.name;
        const bs: ScopeInfo = { where: `${scope.where} ${names.childOf.get(it)!.name}.${bn}`, slots: new Map() };
        walk(g, names, b, [], bs);
        branches.set(bn, bs);
      }
      g.branchScopes.set(it, [...branches.values()]);
      add('branch', undefined, branches);
      return;
    }
    default:
      if (!ZERO_WIDTH.has(it.type)) throw new Error(`shape2: unexpected grammar item ${it.type}`);
  }
}

// ── Matching a CST node to its arm ──

type Item =
  | { k: 'node'; node: CstNode }
  | { k: 'leaf'; leaf: CstLeaf }
  | { k: 'template'; of: CstChild }
  | { k: 'branch'; name: string; info: ScopeInfo; frame: Frame; start: number; end: number };
/** What one scope (an arm, a branch, one iteration) matched: its captures by grammar node, and
 * the iterations of each repetition / optional directly inside it. */
type Frame = { caps: Map<RuleExpr, Item>; iters: Map<RuleExpr, Frame[]> };
const newFrame = (): Frame => ({ caps: new Map(), iters: new Map() });
type Matched = { info: ArmInfo; frame: Frame };

const isLeaf = (c: CstChild | undefined): c is CstLeaf => c !== undefined && 'tokenType' in c;
const spanOfItem = (it: Item): { start: number; end: number } =>
  it.k === 'node' ? { start: it.node.offset, end: it.node.end }
  : it.k === 'leaf' ? { start: it.leaf.offset, end: it.leaf.end }
  : it.k === 'template' ? { start: it.of.offset, end: it.of.end }
  : { start: it.start, end: it.end };

function matchArm(g: GrammarView, n: CstNode, src: string): Matched {
  const arms = g.arms.get(n.rule);
  if (!arms) throw new Error(`shape2: no rule ${n.rule} in the grammar`);
  const kids = n.children;
  const opAt = kids.findIndex((c) => isLeaf(c) && c.tokenType === '$operator');
  if (opAt >= 0) {
    const form = kids.length === 3 ? 'binary' : opAt === 0 ? 'prefix' : 'postfix';
    const info = arms.find((a) => a.form === form)!;
    const frame = newFrame();
    OP_FORM_CHILDREN[form].forEach((nm, i) => {
      const s = info.slots.get(nm)!;
      frame.caps.set(s.node, nm === 'op' ? { k: 'leaf', leaf: kids[i] as CstLeaf } : { k: 'node', node: kids[i] as CstNode });
    });
    return { info, frame };
  }
  const names = g.names.get(n.rule)!;
  for (const info of arms) {
    if (!info.items) continue;
    const frame = newFrame();
    if (seqM(info.items, 0, 0, frame, (i) => i === kids.length)) return { info, frame };
  }
  throw new Error(`shape2: no arm of ${n.rule} matches the CST node at ${n.offset}..${n.end}`);

  function seqM(items: RuleExpr[], k: number, i: number, f: Frame, done: (i: number) => boolean): boolean {
    if (k === items.length) return done(i);
    return m(items[k], i, f, (j) => seqM(items, k + 1, j, f, done));
  }
  function cap(e: RuleExpr, f: Frame, item: Item, i: number, done: (i: number) => boolean): boolean {
    const named = names.childOf.has(e);
    if (named) f.caps.set(e, item);
    if (done(i)) return true;
    if (named) f.caps.delete(e);
    return false;
  }
  function iterate(q: RuleExpr, f: Frame, its: Frame[], done: () => boolean): boolean {
    f.iters.set(q, its);
    if (done()) return true;
    f.iters.delete(q);
    return false;
  }
  function m(e: RuleExpr, i: number, f: Frame, done: (i: number) => boolean): boolean {
    const c = kids[i];
    switch (e.type) {
      case 'literal': {
        const tt = isKeywordLiteral(e.value) ? '$keyword' : '$punct';
        if (!isLeaf(c) || c.tokenType !== tt || src.slice(c.offset, c.end) !== e.value) return false;
        return cap(e, f, { k: 'leaf', leaf: c }, i + 1, done);
      }
      case 'ref': {
        if (c === undefined) return false;
        if (g.tokens.has(e.name)) {
          if (isLeaf(c) ? c.tokenType !== e.name : !(g.templates.has(e.name) && c.rule === '$template')) return false;
          return cap(e, f, g.templates.has(e.name) ? { k: 'template', of: c } : { k: 'leaf', leaf: c as CstLeaf }, i + 1, done);
        }
        if (isLeaf(c) || c.rule !== e.name) return false;
        return cap(e, f, { k: 'node', node: c }, i + 1, done);
      }
      case 'group': return m(e.body, i, f, done);
      case 'seq': return seqM(e.items, 0, i, f, done);
      case 'alt': {
        if (e.items.length > 0 && e.items.every((x) => x.type === 'literal')) {
          for (const x of e.items) {
            const tt = isKeywordLiteral((x as { value: string }).value) ? '$keyword' : '$punct';
            if (isLeaf(c) && c.tokenType === tt && src.slice(c.offset, c.end) === (x as { value: string }).value) {
              return cap(e, f, { k: 'leaf', leaf: c }, i + 1, done);
            }
          }
          return false;
        }
        const tags = names.branches.get(e)!;
        for (let b = 0; b < e.items.length; b++) {
          const bf = newFrame();
          const ok = m(e.items[b], i, bf, (j) => {
            const start = j > i ? kids[i].offset : (c?.offset ?? n.end);
            const end = j > i ? kids[j - 1].end : start;
            return cap(e, f, { k: 'branch', name: tags[b].name, info: g.branchScopes.get(e)![b], frame: bf, start, end }, j, done);
          });
          if (ok) return true;
        }
        return false;
      }
      case 'quantifier': {
        const min = e.kind === '+' ? 1 : 0;
        const max = e.kind === '?' ? 1 : Infinity;
        const its: Frame[] = [];
        const loop = (j: number): boolean => {
          if (its.length < max) {
            const it = newFrame();
            const more = m(e.body, j, it, (j2) => {
              if (j2 === j) return false;   // a zero-width iteration ends the repetition
              its.push(it);
              if (loop(j2)) return true;
              its.pop();
              return false;
            });
            if (more) return true;
          }
          return its.length >= min && iterate(e, f, [...its], () => done(j));
        };
        return loop(i);
      }
      case 'sep': {
        // element (delimiter element)* delimiter?, or nothing (the parsers' sep).
        const its: Frame[] = [];
        const isDelim = (j: number): boolean => {
          const d = kids[j];
          return isLeaf(d) && d.tokenType === (isKeywordLiteral(e.delimiter) ? '$keyword' : '$punct') && src.slice(d.offset, d.end) === e.delimiter;
        };
        const element = (j: number): boolean => {
          const it = newFrame();
          return m(e.element, j, it, (j2) => {
            its.push(it);
            if (isDelim(j2) && (element(j2 + 1) || iterate(e, f, [...its], () => done(j2 + 1)))) return true;
            if (iterate(e, f, [...its], () => done(j2))) return true;
            its.pop();
            return false;
          });
        };
        return element(i) || iterate(e, f, [], () => done(i));
      }
      default:
        if (ZERO_WIDTH.has(e.type)) return done(i);
        throw new Error(`shape2: unexpected grammar item ${e.type}`);
    }
  }
}

/** A slot's items under a frame: `quants` are the slot's repetitions below that frame. An absent
 * optional is `undefined` (a hole inside a repetition) or nothing (when a repetition is inside). */
function collect(f: Frame, quants: RuleExpr[], node: RuleExpr): (Item | undefined)[] {
  if (quants.length === 0) return [f.caps.get(node)];
  const [q, ...rest] = quants;
  const its = f.iters.get(q) ?? [];
  if (q.type === 'quantifier' && q.kind === '?' && its.length === 0) return rest.some(isList) ? [] : [undefined];
  return its.flatMap((it) => collect(it, rest, node));
}

// ── Loading: the static check ──

export type LoadedShape2 = { spec: Shape2Spec; grammar: GrammarView };

/** A static scope: an arm, a branch, or one iteration (`base`: the repetitions consumed to reach
 * it), with the variables bound around it. */
type SScope = { info: ScopeInfo; base: RuleExpr[]; outer?: SScope; vars: Set<string> };
const startsWith = (a: RuleExpr[], p: RuleExpr[]): boolean => p.every((q, i) => a[i] === q);

function resolveStatic(s: SScope, name: string): { slot: Slot; card: Card; scope: SScope } | undefined {
  const slot = s.info.slots.get(name);
  if (slot && startsWith(slot.quants, s.base)) return { slot, card: cardOf(slot.quants.slice(s.base.length)), scope: s };
  return s.outer ? resolveStatic(s.outer, name) : undefined;
}
const hasVar = (s: SScope, name: string): boolean => s.vars.has(name) || (s.outer ? hasVar(s.outer, name) : false);

type Ty = 'string' | 'number' | 'bool' | 'null' | 'node' | 'list' | 'record' | 'any';

export function loadShape2(grammar: CstGrammar, spec: Shape2Spec): LoadedShape2 {
  const g = viewOf(grammar);
  const problems: string[] = [];
  const err = (where: string, msg: string): void => { problems.push(`${where}: ${msg}`); };
  const syns = spec.synthesized ?? {};
  const inhs = spec.inherited ?? {};
  const armIn = (rule: string, arm: string): ArmInfo | undefined => g.arms.get(rule)?.find((a) => a.arm === arm);
  const known = new Set(Object.keys(OPERATORS));

  // Every rule / arm key must exist; under `total` every arm of a mapped rule must be mapped.
  const eachArmKey = (where: string, table: Record<string, Record<string, unknown>>, visit: (a: ArmInfo, v: unknown, w: string) => void): void => {
    for (const [rule, arms] of Object.entries(table)) {
      if (!g.arms.has(rule)) { err(`${where} ${rule}`, `the grammar has no rule ${rule}`); continue; }
      if (arms === null || typeof arms !== 'object') { err(`${where} ${rule}`, 'must map arm names to terms'); continue; }
      for (const [arm, v] of Object.entries(arms)) {
        const a = armIn(rule, arm);
        if (!a) { err(`${where} ${rule}.${arm}`, `${rule} has no arm ${arm} (its arms: ${g.arms.get(rule)!.map((x) => x.arm).join(', ')})`); continue; }
        visit(a, v, `${where} ${rule}.${arm}`);
      }
    }
  };
  eachArmKey('rules', spec.rules, (a, v, w) => term(v, { info: a, base: [], vars: new Set() }, w, 'value', a));
  if (spec.total) {
    for (const rule of Object.keys(spec.rules)) for (const a of g.arms.get(rule) ?? []) {
      if (!(a.arm in spec.rules[rule])) err(`rules ${rule}.${a.arm}`, 'not mapped (the spec is total)');
    }
  }
  for (const [attr, d] of Object.entries(syns)) {
    eachArmKey(`synthesized ${attr}`, d.rules, (a, v, w) => {
      const ty = term(v, { info: a, base: [], vars: new Set() }, w, 'syn', a);
      if (!scalarOk(ty, d.type)) err(w, `a ${d.type} attribute's equation has type ${ty}`);
    });
  }
  for (const [attr, d] of Object.entries(inhs)) {
    eachArmKey(`inherited ${attr}`, d.rules, (a, v, w) => {
      if (v === null || typeof v !== 'object') { err(w, 'must map child names to equations'); return; }
      const eqs = Object.entries(v as Record<string, InhEq>);
      if (eqs.length > 1 && eqs.some(([, e]) => e?.t === 'thread')) err(w, `an arm threading ${attr} has no other equation for it (its elements take the threaded state)`);
      for (const [kid, eq] of eqs) {
        if (eq?.t === 'thread') { threadEq(a, kid, eq, d, `${w}.${kid}`); continue; }
        const r = findSlotAnywhere(a, kid);
        if (!r) err(`${w}.${kid}`, `${a.where} has no child ${kid}`);
        else if (r.kind !== 'node') err(`${w}.${kid}`, `the child ${kid} is a ${r.kind}; only a rule node has inherited attributes`);
        const e = eq as Term;
        if (e?.t === 'const') { if (!scalarOk(constTy(e.value), d.type)) err(`${w}.${kid}`, `a ${d.type} attribute's equation is ${JSON.stringify(e.value)}`); }
        else if (e?.t === 'inh') { if (!(e.attr in inhs)) err(`${w}.${kid}`, `no inherited attribute ${e.attr}`); else if (inhs[e.attr].type !== d.type) err(`${w}.${kid}`, `copies ${e.attr} (${inhs[e.attr].type}) into a ${d.type} attribute`); }
        else err(`${w}.${kid}`, 'an inherited equation is a constant or `inh` of the parent\'s attribute (the calculus allows no other outer context)');
      }
    });
    if (!scalarOk(constTy(d.default), d.type)) err(`inherited ${attr}`, `default ${JSON.stringify(d.default)} is not a ${d.type}`);
  }
  if (problems.length) throw new Shape2SpecError(problems);
  return { spec, grammar: g };

  /** A threaded equation: on a repeated child of the arm's own scope; `init` as any inherited
   * equation; `next` a scalar of the attribute's type over the accumulator and the element. */
  function threadEq(a: ArmInfo, kid: string, eq: ThreadEq, d: InhAttr, w: string): void {
    const slot = a.slots.get(kid);
    const at = slot ? slot.quants.map(isList).lastIndexOf(true) : -1;
    if (!slot) { err(w, `thread: ${a.where} has no child ${kid} of its own (a thread runs over a repetition of the arm itself)`); return; }
    if (at < 0) { err(w, `thread: ${kid} is not repeated; a thread runs over the elements of a repetition`); return; }
    if (slot.kind !== 'node' && slot.kind !== 'branch') err(w, `thread: ${kid} is a ${slot.kind}; the elements must hold rule nodes`);
    const init = eq.init as Term;
    if (init?.t === 'const') { if (!scalarOk(constTy(init.value), d.type)) err(`${w} init`, `a ${d.type} attribute's initial state is ${JSON.stringify(init.value)}`); }
    else if (init?.t === 'inh') { if (!(init.attr in inhs)) err(`${w} init`, `no inherited attribute ${init.attr}`); else if (inhs[init.attr].type !== d.type) err(`${w} init`, `copies ${init.attr} (${inhs[init.attr].type}) into a ${d.type} attribute`); }
    else err(`${w} init`, 'a thread\'s initial state is a constant or `inh` of the parent\'s attribute');
    if (typeof eq.acc !== 'string') { err(w, 'thread: acc is a variable name'); return; }
    const ty = term(eq.next, { info: a, base: slot.quants.slice(0, at + 1), vars: new Set([eq.acc]) }, `${w} next`, 'thread', a);
    if (!scalarOk(ty, d.type)) err(`${w} next`, `a ${d.type} attribute's next state has type ${ty}`);
  }

  function findSlotAnywhere(s: ScopeInfo, name: string): Slot | undefined {
    const own = s.slots.get(name);
    if (own) return own;
    for (const sl of s.slots.values()) for (const b of sl.branches?.values() ?? []) {
      const r = findSlotAnywhere(b, name);
      if (r) return r;
    }
    return undefined;
  }

  /** Check one term in a scope; returns its type. `ctx`: a value term, or a synthesized
   * attribute's equation (scalars over the subtree only). */
  function term(raw: unknown, s: SScope, w: string, ctx: 'value' | 'syn' | 'thread', arm: ArmInfo): Ty {
    if (typeof raw === 'function') { err(w, 'a function is not a term: the calculus has no escape to code (v2 has no `custom`)'); return 'any'; }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { err(w, `${JSON.stringify(raw)} is not a term`); return 'any'; }
    const e = raw as Term;
    if (!known.has(e.t)) { err(w, `\`${String((e as { t: unknown }).t)}\` is not an operator of the calculus (${[...known].join(', ')})`); return 'any'; }
    if (ctx === 'syn' && !OPERATORS[e.t].synAttr) { err(w, `\`${e.t}\` cannot appear in a synthesized attribute's equation (scalars over the subtree only)`); return 'any'; }
    if (ctx === 'thread' && !OPERATORS[e.t].synAttr && e.t !== 'var') { err(w, `\`${e.t}\` cannot appear in a thread's next state (a scalar over the state and the element's own children only)`); return 'any'; }
    const sub = (x: unknown, at: string, sc: SScope = s): Ty => term(x, sc, `${w} ${at}`, ctx, arm);
    const need = (x: unknown, at: string, want: Ty): void => {
      const ty = sub(x, at);
      if (ty !== want && ty !== 'any') err(`${w} ${at}`, `must be a ${want}, is a ${ty}`);
    };
    const slotOf = (name: unknown, op: string): { slot: Slot; card: Card; scope: SScope } | undefined => {
      if (typeof name !== 'string') { err(w, `${op}: a child name is a string`); return undefined; }
      const r = resolveStatic(s, name);
      if (!r && ctx === 'thread' && findSlotAnywhere(arm, name)) err(w, `${op}(${name}): ${name} is not in the element: a thread's next state reads only the element's own children (no other sibling)`);
      else if (!r) err(w, `${op}(${name}): ${s.info.where} has no child ${name} (its children: ${[...s.info.slots.keys()].join(', ') || 'none'})`);
      return r;
    };
    switch (e.t) {
      case 'const': return constTy(e.value);
      case 'absent': return 'any';
      case 'child': {
        const r = slotOf(e.name, 'child');
        if (!r) return 'any';
        if (r.slot.kind === 'leaf') err(w, `child(${e.name}): ${e.name} is a leaf, which has no value of its own: use text / cook, or build a node with its span`);
        if (r.slot.kind === 'branch') err(w, `child(${e.name}): ${e.name} is an inline alternation: use branch(${e.name}, {...})`);
        if (r.slot.kind === 'template') err(w, `child(${e.name}): template literals are not in the calculus yet`);
        return r.card === 'many' ? 'list' : 'any';
      }
      case 'text': {
        if (e.name === undefined) return 'string';
        const r = slotOf(e.name, 'text');
        if (r && r.card === 'many') err(w, `text(${e.name}): ${e.name} is a list; text takes one child`);
        return 'string';
      }
      case 'cook': {
        if (!(COOK_FNS as readonly string[]).includes(e.fn)) err(w, `cook: ${JSON.stringify(e.fn)} is not a cooking function of the calculus (${COOK_FNS.join(', ')})`);
        const r = slotOf(e.name, 'cook');
        if (r && r.slot.kind !== 'leaf') err(w, `cook(${e.fn}, ${e.name}): ${e.name} is a ${r.slot.kind}; cooking reads one leaf`);
        if (r && r.card === 'many') err(w, `cook(${e.fn}, ${e.name}): ${e.name} is a list; cooking reads one leaf`);
        return e.fn === 'numberValue' || e.fn === 'tsNumericLiteralFlags' ? 'number' : e.fn === 'hasExtendedUnicodeEscape' ? 'bool' : 'string';
      }
      case 'present': {
        const r = slotOf(e.name, 'present');
        if (r && r.card === 'one') err(w, `present(${e.name}): ${e.name} is a required child (always present)`);
        return 'bool';
      }
      case 'armOf': {
        const r = slotOf(e.name, 'armOf');
        if (r && r.slot.kind !== 'node' && r.slot.kind !== 'branch') err(w, `armOf(${e.name}): ${e.name} is a ${r.slot.kind}; only a rule node or an inline alternation has an arm`);
        if (r && r.card === 'many') err(w, `armOf(${e.name}): ${e.name} is a list`);
        return 'string';
      }
      case 'syn': {
        const d = syns[e.attr];
        if (!d) { err(w, `syn: no synthesized attribute ${e.attr}`); return 'any'; }
        if (e.name === undefined) {
          if (ctx === 'syn') err(w, `syn(${e.attr}) of the node itself inside an equation is a cycle`);
          if (ctx === 'thread') err(w, `syn(${e.attr}) of the parent inside a thread's next state: the next state reads the element's own children only`);
          return d.type === 'bool' ? 'bool' : d.type;
        }
        const r = slotOf(e.name, 'syn');
        if (r && r.slot.kind !== 'node') err(w, `syn(${e.attr}, ${e.name}): ${e.name} is a ${r.slot.kind}; only a rule node has attributes`);
        if (r && r.card === 'many') err(w, `syn(${e.attr}, ${e.name}): ${e.name} is a list`);
        return d.type === 'bool' ? 'bool' : d.type;
      }
      case 'inh': {
        const d = inhs[e.attr];
        if (!d) { err(w, `inh: no inherited attribute ${e.attr}`); return 'any'; }
        return d.type === 'bool' ? 'bool' : d.type;
      }
      case 'node': {
        need(e.type, 'type', 'string');
        if (e.fields === null || typeof e.fields !== 'object') err(w, 'node: fields is a record of terms');
        else for (const [k, x] of Object.entries(e.fields)) sub(x, `.${k}`);
        if (e.span !== undefined) span(e.span, s, w);
        return 'node';
      }
      case 'record':
        for (const [k, x] of Object.entries(e.fields ?? {})) sub(x, `.${k}`);
        return 'record';
      case 'list':
        (e.items ?? []).forEach((x, i) => {
          if (x !== null && typeof x === 'object' && 'spread' in x) {
            const ty = sub(x.spread, `[${i}]...`);
            if (ty !== 'list' && ty !== 'any') err(`${w} [${i}]`, `spread of a ${ty}; spread takes a list`);
          } else sub(x, `[${i}]`);
        });
        return 'list';
      case 'match': {
        need(e.on, 'on', 'string');
        const tys = Object.entries(e.cases ?? {}).map(([k, x]) => sub(x, `case ${JSON.stringify(k)}`));
        if (e.else !== undefined) tys.push(sub(e.else, 'else'));
        return join(tys);
      }
      case 'if': need(e.cond, 'cond', 'bool'); return join([sub(e.then, 'then'), sub(e.else, 'else')]);
      case 'and': case 'or': (e.args ?? []).forEach((x, i) => need(x, `${e.t}[${i}]`, 'bool')); return 'bool';
      case 'not': need(e.arg, 'not', 'bool'); return 'bool';
      case 'orElse': return join([sub(e.of, 'of'), sub(e.else, 'else')]);
      case 'branch': {
        const r = slotOf(e.name, 'branch');
        if (!r) return 'any';
        if (r.slot.kind !== 'branch') { err(w, `branch(${e.name}): ${e.name} is a ${r.slot.kind}, not an inline alternation`); return 'any'; }
        if (r.card === 'many') err(w, `branch(${e.name}): ${e.name} is a list: map over it`);
        const tys: Ty[] = [];
        for (const [bn, x] of Object.entries(e.cases ?? {})) {
          const info = r.slot.branches!.get(bn);
          if (!info) { err(w, `branch(${e.name}): no branch ${bn} (its branches: ${[...r.slot.branches!.keys()].join(', ')})`); continue; }
          tys.push(sub(x, `case ${bn}`, { info, base: [], outer: s, vars: new Set() }));
        }
        if (spec.total) for (const bn of r.slot.branches!.keys()) if (!(bn in (e.cases ?? {}))) err(w, `branch(${e.name}): branch ${bn} not mapped (the spec is total)`);
        return join(tys);
      }
      case 'map': case 'fold': {
        const r = slotOf(e.over, e.t);
        if (!r) return 'any';
        const inner = r.slot.quants.slice(r.scope.base.length);
        const at = inner.map(isList).lastIndexOf(true);
        if (at < 0) { err(w, `${e.t}(${e.over}): ${e.over} is not repeated`); return 'any'; }
        const it: SScope = { info: r.scope.info, base: [...r.scope.base, ...inner.slice(0, at + 1)], outer: s, vars: new Set() };
        if (e.t === 'map') { sub(e.body, 'body', it); return 'list'; }
        sub(e.init, 'init');
        it.vars.add(e.acc);
        sub(e.body, 'body', it);
        return 'any';
      }
      case 'let': {
        sub(e.value, 'value');
        return sub(e.body, 'body', { info: s.info, base: s.base, outer: s.outer, vars: new Set([...s.vars, e.name]) });
      }
      case 'var':
        if (!hasVar(s, e.name)) err(w, `var(${e.name}) is not bound here`);
        return 'any';
    }
  }
  function span(sp: Span, s: SScope, w: string): void {
    for (const k of ['from', 'to'] as const) {
      const nm = sp?.[k];
      if (typeof nm !== 'string') { err(w, `span.${k} is a child or variable name`); continue; }
      if (!hasVar(s, nm) && !resolveStatic(s, nm)) err(w, `span.${k}: ${s.info.where} has no child or variable ${nm}`);
    }
  }
}
const constTy = (v: unknown): Ty => (v === null ? 'null' : typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'any');
const scalarOk = (ty: Ty, want: string): boolean => ty === 'any' || ty === want;
const join = (tys: Ty[]): Ty => (tys.length && tys.every((t) => t === tys[0]) ? tys[0] : 'any');

// ── Evaluation ──

type Inh = Record<string, Scalar>;
/** A run-time scope: what `SScope` is statically, over a matched frame. */
type RScope = { info: ScopeInfo; base: RuleExpr[]; frame: Frame; outer?: RScope; vars: Map<string, Bound>; m: Matched; node: CstNode; inh: Inh };
type Bound = { value: S2Value | undefined; start: number; end: number };

/** The value of `cst` (the root: its context is every inherited attribute's default). */
export function evaluate(loaded: LoadedShape2, cst: CstNode, src: string): S2Value | undefined {
  return evaluator(loaded, cst, src)(cst);
}

/** An evaluator over one tree: the value of any node under `root`, in the context its
 * ancestors (and, through a thread, its left siblings) give it. Matches and attributes are
 * memoised across calls. */
export function evaluator(loaded: LoadedShape2, root: CstNode, src: string): (n: CstNode) => S2Value | undefined {
  const { spec, grammar: g } = loaded;
  const matches = new WeakMap<CstNode, Matched>();
  const synMemo = new WeakMap<CstNode, Map<string, Scalar>>();
  const threadMemo = new WeakMap<CstNode, Map<string, Map<CstNode, Scalar>>>();
  const inhMemo = new WeakMap<CstNode, Inh>();
  const kidNames = new WeakMap<CstNode, Map<CstNode, string>>();
  let parents: WeakMap<CstNode, CstNode> | undefined;
  const inhs = spec.inherited ?? {};
  const rootInh: Inh = Object.fromEntries(Object.entries(inhs).map(([k, d]) => [k, d.default]));

  function matched(n: CstNode): Matched {
    let r = matches.get(n);
    if (!r) { r = matchArm(g, n, src); matches.set(n, r); }
    return r;
  }
  function scopeOf(n: CstNode, inh: Inh): RScope {
    const m = matched(n);
    return { info: m.info, base: [], frame: m.frame, vars: new Map(), m, node: n, inh };
  }
  function valueOf(n: CstNode, inh: Inh): S2Value | undefined {
    const s = scopeOf(n, inh);
    const t = spec.rules[n.rule]?.[s.m.info.arm];
    if (t === undefined) throw new Shape2Unmapped(n.rule, s.m.info.arm);
    return ev(t, s);
  }
  function synOf(n: CstNode, attr: string): Scalar {
    let memo = synMemo.get(n);
    if (!memo) { memo = new Map(); synMemo.set(n, memo); }
    if (memo.has(attr)) return memo.get(attr)!;
    const d = spec.synthesized![attr];
    const s = scopeOf(n, {});
    const eq = d.rules[n.rule]?.[s.m.info.arm];
    let val: Scalar;
    if (eq !== undefined) val = ev(eq, s) as Scalar;
    else if (d.default !== undefined) val = d.default;
    else throw new Error(`shape2: synthesized ${attr} has no equation for ${n.rule}.${s.m.info.arm} and no default`);
    memo.set(attr, val);
    return val;
  }
  /** The inherited attributes a parent (scope `s`, in its arm) hands its child `kid`, named
   * `name`: by the arm's thread when it threads the attribute, else by the child's equation. */
  function inhFor(s: RScope, name: string, kid: CstNode): Inh {
    const out: Inh = {};
    for (const [attr, d] of Object.entries(inhs)) {
      const eqs = d.rules[s.m.info.rule]?.[s.m.info.arm];
      const th = eqs && Object.entries(eqs).find(([, e]) => e.t === 'thread');
      if (th) {
        const states = threadStates(s, attr, th[0], th[1] as ThreadEq);
        out[attr] = states.has(kid) ? states.get(kid)! : d.default;
        continue;
      }
      const eq = eqs?.[name] as Term | undefined;
      out[attr] = eq === undefined ? d.default : eq.t === 'const' ? eq.value : s.inh[(eq as { attr: string }).attr];
    }
    return out;
  }
  /** The state a thread hands each rule node of each element of the repetition holding `over`. */
  function threadStates(s: RScope, attr: string, over: string, eq: ThreadEq): Map<CstNode, Scalar> {
    let byAttr = threadMemo.get(s.node);
    if (!byAttr) { byAttr = new Map(); threadMemo.set(s.node, byAttr); }
    const memo = byAttr.get(attr);
    if (memo) return memo;
    const arm = scopeOf(s.node, s.inh);
    const slot = arm.info.slots.get(over)!;
    const base = slot.quants.slice(0, slot.quants.map(isList).lastIndexOf(true) + 1);
    const out = new Map<CstNode, Scalar>();
    let state = ev(eq.init as Term, arm) as Scalar;
    for (const f of iterFrames(arm.frame, base)) {
      for (const n of nodesIn(arm.info, base, f)) out.set(n, state);
      const acc: Bound = { value: state, start: s.node.offset, end: s.node.end };
      state = ev(eq.next, { info: arm.info, base, frame: f, vars: new Map([[eq.acc, acc]]), m: arm.m, node: s.node, inh: s.inh }) as Scalar;
    }
    byAttr.set(attr, out);
    return out;
  }
  /** The rule nodes one scope's frame holds (with the branches taken inside it). */
  function nodesIn(info: ScopeInfo, base: RuleExpr[], f: Frame): CstNode[] {
    const out: CstNode[] = [];
    for (const slot of info.slots.values()) {
      if (!startsWith(slot.quants, base)) continue;
      for (const it of collect(f, slot.quants.slice(base.length), slot.node)) {
        if (it?.k === 'node') out.push(it.node);
        else if (it?.k === 'branch') out.push(...nodesIn(it.info, [], it.frame));
      }
    }
    return out;
  }
  /** The name of each rule-node child of `p` (in its arm, or in a branch it took). */
  function namesOfKids(p: CstNode): Map<CstNode, string> {
    let out = kidNames.get(p);
    if (out) return out;
    out = new Map();
    const visit = (info: ScopeInfo, f: Frame): void => {
      for (const slot of info.slots.values()) for (const it of collect(f, slot.quants, slot.node)) {
        if (it?.k === 'node') out!.set(it.node, slot.name);
        else if (it?.k === 'branch') visit(it.info, it.frame);
      }
    };
    const m = matched(p);
    visit(m.info, m.frame);
    kidNames.set(p, out);
    return out;
  }
  /** A node's inherited attributes, from the root down. */
  function inhOf(n: CstNode): Inh {
    const memo = inhMemo.get(n);
    if (memo) return memo;
    if (!parents) {
      parents = new WeakMap();
      const walk = (x: CstNode): void => { for (const k of x.children) if (!isLeaf(k)) { parents!.set(k, x); walk(k); } };
      walk(root);
    }
    const p = parents.get(n);
    let out: Inh;
    if (p === undefined) {
      if (n !== root) throw new Error(`shape2: the node at ${n.offset}..${n.end} is not under the evaluator's root`);
      out = rootInh;
    } else {
      const name = namesOfKids(p).get(n);
      if (name === undefined) throw new Error(`shape2: the node at ${n.offset}..${n.end} is not a named child of its ${p.rule} parent`);
      out = inhFor(scopeOf(p, inhOf(p)), name, n);
    }
    inhMemo.set(n, out);
    return out;
  }
  function resolve(s: RScope, name: string): { items: (Item | undefined)[]; card: Card; scope: RScope } {
    const slot = s.info.slots.get(name);
    if (slot && startsWith(slot.quants, s.base)) {
      const rest = slot.quants.slice(s.base.length);
      return { items: collect(s.frame, rest, slot.node), card: cardOf(rest), scope: s };
    }
    if (!s.outer) throw new Error(`shape2: no child ${name}`);
    return resolve(s.outer, name);
  }
  const lookupVar = (s: RScope, name: string): Bound | undefined => s.vars.get(name) ?? (s.outer ? lookupVar(s.outer, name) : undefined);
  const one = (s: RScope, name: string): Item | undefined => resolve(s, name).items[0];
  const textOf = (it: Item): string => { const sp = spanOfItem(it); return src.slice(sp.start, sp.end); };
  /** The value of one child item, seen from the scope that holds it. */
  function itemValue(it: Item | undefined, holder: RScope, name: string): S2Value | undefined {
    if (it === undefined) return undefined;
    if (it.k !== 'node') throw new Error(`shape2: child ${name} is a ${it.k}`);
    return valueOf(it.node, inhFor(holder, name, it.node));
  }
  function spanEdge(s: RScope, name: string, edge: 'start' | 'end'): number {
    const b = lookupVar(s, name);
    if (b) return b[edge];
    const items = resolve(s, name).items.filter((x): x is Item => x !== undefined);
    if (!items.length) throw new Error(`shape2: span ${edge} of ${name}: the child is absent`);
    return spanOfItem(edge === 'start' ? items[0] : items[items.length - 1])[edge];
  }

  function ev(t: Term, s: RScope): S2Value | undefined {
    switch (t.t) {
      case 'const': return t.value;
      case 'absent': return undefined;
      case 'child': {
        const r = resolve(s, t.name);
        if (r.card === 'many') return r.items.map((it) => itemValue(it, r.scope, t.name) ?? null);
        return itemValue(r.items[0], r.scope, t.name);
      }
      case 'text': {
        if (t.name === undefined) return src.slice(s.node.offset, s.node.end);
        const it = one(s, t.name);
        return it === undefined ? undefined : textOf(it);
      }
      case 'cook': {
        const it = one(s, t.name);
        return it === undefined ? undefined : COOK[t.fn](textOf(it));
      }
      case 'present': return resolve(s, t.name).items.some((x) => x !== undefined);
      case 'armOf': {
        const it = one(s, t.name);
        if (it === undefined) return undefined;
        return it.k === 'branch' ? it.name : matched((it as { node: CstNode }).node).info.arm;
      }
      case 'syn': {
        if (t.name === undefined) return synOf(s.node, t.attr);
        const it = one(s, t.name);
        return it === undefined ? undefined : synOf((it as { node: CstNode }).node, t.attr);
      }
      case 'inh': return s.inh[t.attr];
      case 'node': {
        const fields: Record<string, S2Value> = {};
        for (const [k, x] of Object.entries(t.fields)) {
          const val = ev(x, s);
          if (val !== undefined) fields[k] = val;
        }
        const start = t.span ? spanEdge(s, t.span.from, 'start') : s.node.offset;
        const end = t.span ? spanEdge(s, t.span.to, 'end') : s.node.end;
        return { kind: ev(t.type, s) as string, start, end, fields };
      }
      case 'record': {
        const record: Record<string, S2Value> = {};
        for (const [k, x] of Object.entries(t.fields)) { const val = ev(x, s); if (val !== undefined) record[k] = val; }
        return { record };
      }
      case 'list': {
        const out: S2Value[] = [];
        for (const x of t.items) {
          if ('spread' in x) out.push(...(ev(x.spread, s) as S2Value[]));
          else out.push(ev(x, s) ?? null);
        }
        return out;
      }
      case 'match': {
        const on = ev(t.on, s) as string;
        if (Object.hasOwn(t.cases, on)) return ev(t.cases[on], s);
        if (t.else !== undefined) return ev(t.else, s);
        throw new Error(`shape2: ${s.info.where}: match has no case ${JSON.stringify(on)}`);
      }
      case 'if': return ev(ev(t.cond, s) ? t.then : t.else, s);
      case 'and': return t.args.every((x) => ev(x, s) === true);
      case 'or': return t.args.some((x) => ev(x, s) === true);
      case 'not': return ev(t.arg, s) !== true;
      case 'orElse': { const val = ev(t.of, s); return val === undefined ? ev(t.else, s) : val; }
      case 'branch': {
        const it = one(s, t.name) as Extract<Item, { k: 'branch' }> | undefined;
        if (it === undefined) return undefined;
        const c = t.cases[it.name];
        if (c === undefined) throw new Shape2Unmapped(s.info.where, `${t.name}.${it.name}`);
        return ev(c, { info: it.info, base: [], frame: it.frame, outer: s, vars: new Map(), m: s.m, node: s.node, inh: s.inh });
      }
      case 'map': case 'fold': {
        const r = resolve(s, t.over);
        const slot = r.scope.info.slots.get(t.over)!;
        const inner = slot.quants.slice(r.scope.base.length);
        const at = inner.map(isList).lastIndexOf(true);
        const base = [...r.scope.base, ...inner.slice(0, at + 1)];
        const frames = iterFrames(r.scope.frame, inner.slice(0, at + 1));
        const iterScope = (f: Frame, vars: Map<string, Bound>): RScope => ({ info: r.scope.info, base, frame: f, outer: s, vars, m: s.m, node: s.node, inh: s.inh });
        if (t.t === 'map') return frames.map((f) => ev(t.body, iterScope(f, new Map())) ?? null);
        const init = ev(t.init, s);
        let acc: Bound = { value: init, ...(isNode(init) ? { start: init.start, end: init.end } : { start: s.node.offset, end: s.node.end }) };
        if (t.init.t === 'child') acc = { value: init, start: spanEdge(s, t.init.name, 'start'), end: spanEdge(s, t.init.name, 'end') };
        for (const f of frames) {
          const sc = iterScope(f, new Map([[t.acc, acc]]));
          acc = { value: ev(t.body, sc), start: acc.start, end: Math.max(acc.end, frameEnd(f)) };
        }
        return acc.value;
      }
      case 'let': {
        const val = ev(t.value, s);
        const b: Bound = isNode(val) ? { value: val, start: val.start, end: val.end } : { value: val, start: s.node.offset, end: s.node.end };
        return ev(t.body, { ...s, vars: new Map([...s.vars, [t.name, b]]) });
      }
      case 'var': {
        const b = lookupVar(s, t.name);
        if (!b) throw new Error(`shape2: var ${t.name} unbound`);
        return b.value;
      }
    }
  }

  return (n) => valueOf(n, inhOf(n));
}
const isNode = (v: S2Value | undefined): v is S2Node => v !== null && typeof v === 'object' && !Array.isArray(v) && 'kind' in v;

/** The end of the last item a frame (with its iterations) captured. */
function frameEnd(f: Frame): number {
  let end = -1;
  for (const it of f.caps.values()) end = Math.max(end, spanOfItem(it).end);
  for (const its of f.iters.values()) for (const x of its) end = Math.max(end, frameEnd(x));
  return end;
}

/** The frames of the iterations reached through `quants` (an optional on the way contributes
 * its one iteration or none). */
function iterFrames(f: Frame, quants: RuleExpr[]): Frame[] {
  if (quants.length === 0) return [f];
  const [q, ...rest] = quants;
  return (f.iters.get(q) ?? []).flatMap((it) => iterFrames(it, rest));
}

// ── Dependencies (what incremental reuse needs) ──

/** Per (rule, arm): the inherited attributes its VALUE depends on: those it reads (`inh`), and
 * those it hands a child by copy (`inh` in an inherited equation, or as a thread's initial
 * state) when that child's value depends on the copied attribute (a fixpoint over the rules).
 * An arm that depends on none is a function of its own subtree: its node is reusable wherever it
 * sits. A constant equation (`chainTop: false` for a link's object) makes the CHILD context-
 * dependent, not the parent.
 *
 * `threads`: the arm's threaded equations. An element of such a repetition depends on its LEFT
 * SIBLINGS through the state only: the state entering element k is a function of the initial
 * state and the `reads` (the synthesized attributes `next` reads, of each element before k). So
 * after an edit, an element is reusable when the state entering it is unchanged; the elements
 * after an edited one are re-evaluated only while the recomputed state differs from the old one,
 * and reused from the first element whose incoming state is equal again. */
export type ArmDeps = { inherited: string[]; threads?: { attr: string; over: string; reads: string[] }[] };
export function dependencies(loaded: LoadedShape2): Record<string, ArmDeps> {
  const { spec, grammar: g } = loaded;
  const inhs = spec.inherited ?? {};
  const direct = new Map<string, Set<string>>();
  const walkT = (x: unknown, tag: string, acc: Set<string>): void => {
    if (x === null || typeof x !== 'object') return;
    if ((x as Term).t === tag) acc.add((x as { attr: string }).attr);
    for (const val of Object.values(x)) walkT(val, tag, acc);
  };
  for (const [rule, arms] of Object.entries(spec.rules)) for (const [arm, t] of Object.entries(arms)) {
    const acc = new Set<string>();
    walkT(t, 'inh', acc);
    direct.set(`${rule}.${arm}`, acc);
  }
  const deps = new Map([...direct].map(([k, v2]) => [k, new Set(v2)]));
  const threads = new Map<string, NonNullable<ArmDeps['threads']>>();
  const ofRule = (rule: string): Set<string> => {
    const out = new Set<string>();
    for (const [k, v2] of deps) if (k.startsWith(`${rule}.`)) v2.forEach((x) => out.add(x));
    return out;
  };
  const slotRules = (scope: ScopeInfo, name: string): string[] => {
    const own = scope.slots.get(name);
    if (own) return own.rule ? [own.rule] : [];
    for (const sl of scope.slots.values()) for (const b of sl.branches?.values() ?? []) { const r = slotRules(b, name); if (r.length) return r; }
    return [];
  };
  /** The rules of every rule node an element of the repetition `base` can hold. */
  const elementRules = (scope: ScopeInfo, base: RuleExpr[]): string[] => {
    const out: string[] = [];
    for (const sl of scope.slots.values()) {
      if (!startsWith(sl.quants, base)) continue;
      if (sl.rule) out.push(sl.rule);
      for (const b of sl.branches?.values() ?? []) out.push(...elementRules(b, []));
    }
    return out;
  };
  for (const [attr, d] of Object.entries(inhs)) for (const [rule, arms] of Object.entries(d.rules)) for (const [arm, kids] of Object.entries(arms)) {
    for (const [kid, eq] of Object.entries(kids)) {
      if (eq.t !== 'thread') continue;
      const key = `${rule}.${arm}`;
      const reads = new Set<string>();
      walkT(eq.next, 'syn', reads);
      if (!threads.has(key)) threads.set(key, []);
      threads.get(key)!.push({ attr, over: kid, reads: [...reads].sort() });
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [attr, d] of Object.entries(inhs)) for (const [rule, arms] of Object.entries(d.rules)) for (const [arm, kids] of Object.entries(arms)) {
      const key = `${rule}.${arm}`;
      if (!deps.has(key)) deps.set(key, new Set());   // an unmapped arm that hands its children context
      const info = g.arms.get(rule)!.find((a) => a.arm === arm)!;
      for (const [kid, eq] of Object.entries(kids)) {
        const copied = eq.t === 'inh' ? eq.attr : eq.t === 'thread' && (eq.init as Term).t === 'inh' ? (eq.init as { attr: string }).attr : undefined;
        if (copied === undefined) continue;
        const rules = eq.t === 'thread'
          ? elementRules(info, (() => { const q = info.slots.get(kid)!.quants; return q.slice(0, q.map(isList).lastIndexOf(true) + 1); })())
          : slotRules(info, kid);
        if (rules.some((r) => ofRule(r).has(attr)) && !deps.get(key)!.has(copied)) { deps.get(key)!.add(copied); changed = true; }
      }
    }
  }
  const keys = [...new Set([...deps.keys(), ...threads.keys()])];
  return Object.fromEntries(keys.map((k) => [k, { inherited: [...(deps.get(k) ?? [])].sort(), ...(threads.has(k) ? { threads: threads.get(k) } : {}) }]));
}

/** The arm name the reference matcher gives a CST node (for totality checks of the matcher). */
export function armNameOf(loaded: LoadedShape2, n: CstNode, src: string): string {
  return matchArm(loaded.grammar, n, src).info.arm;
}

// ── The cooking functions (the reference definitions of COOK_FNS) ──

const unescapeCodePoints = (s: string): string =>
  s.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (_, a, b) => String.fromCodePoint(parseInt(a ?? b, 16)));

function stringValue(raw: string): string {
  const body = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const n = body[++i];
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '\r': if (body[i + 1] === '\n') i++; break;   // line continuation
      case '\n': case ' ': case ' ': break;
      case 'x': out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; break;
      case 'u': {
        if (body[i + 1] === '{') {
          const close = body.indexOf('}', i);
          out += String.fromCodePoint(parseInt(body.slice(i + 2, close), 16));
          i = close;
        } else { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; }
        break;
      }
      default: {
        if (n >= '0' && n <= '7') {
          // \0 (not followed by a digit) and the legacy octal escapes (Annex B.1.2).
          const m = /^[0-3][0-7]{0,2}|^[4-7][0-7]?/.exec(body.slice(i))![0];
          out += String.fromCharCode(parseInt(m, 8));
          i += m.length - 1;
        } else out += n;   // \8, \9 and every other escaped character stand for themselves
      }
    }
  }
  return out;
}

function numberValue(raw: string): number {
  const t = raw.replace(/_/g, '');
  if (/^0[xX]/.test(t)) return parseInt(t.slice(2), 16);
  if (/^0[oO]/.test(t)) return parseInt(t.slice(2), 8);
  if (/^0[bB]/.test(t)) return parseInt(t.slice(2), 2);
  if (/^0[0-7]+$/.test(t)) return parseInt(t.slice(1), 8);   // legacy octal (Annex B.1.1)
  return Number(t);
}

/** tsc's TokenFlags of a numeric literal's spelling (Scientific 16, Octal 32, HexSpecifier 64,
 * BinarySpecifier 128, OctalSpecifier 256, ContainsSeparator 512, ContainsLeadingZero 8192). */
function tsNumericLiteralFlags(raw: string): number | undefined {
  let f = 0;
  if (/^0[xX]/.test(raw)) f |= 64;
  else if (/^0[bB]/.test(raw)) f |= 128;
  else if (/^0[oO]/.test(raw)) f |= 256;
  else if (/^0[0-7]+$/.test(raw)) f |= 32;
  else {
    if (/^0[0-9]/.test(raw)) f |= 8192;
    if (/[eE]/.test(raw)) f |= 16;
  }
  if (raw.includes('_')) f |= 512;
  return f === 0 ? undefined : f;
}

const COOK: Record<CookFn, (raw: string) => Scalar | undefined> = {
  tsNumericText: (raw) => String(numberValue(raw)),
  tsNumericLiteralFlags,
  tsBigIntText: (raw) => raw.replace(/_/g, ''),
  hasExtendedUnicodeEscape: (raw) => /(^|[^\\])(\\\\)*\\u\{/.test(raw),
  identifierName: unescapeCodePoints,
  stringValue,
  numberValue,
  bigintValue: (raw) => `${BigInt(raw.slice(0, -1).replace(/_/g, ''))}n`,
  bigintText: (raw) => raw.slice(0, -1).replace(/_/g, ''),
  privateName: (raw) => unescapeCodePoints(raw.slice(1)),
  regexPattern: (raw) => raw.slice(1, raw.lastIndexOf('/')),
  regexFlags: (raw) => raw.slice(raw.lastIndexOf('/') + 1),
  stringBody: (raw) => raw.slice(1, -1),
};
