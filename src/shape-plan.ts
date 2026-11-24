// planShape: a shape (src/shape2-eval.ts `defineShape`) compiled against the portable engine's IR
// (src/emit-portable.ts) into what a printer needs to emit a parser that builds the shape's values
// DIRECTLY, in the one parse, with no CST: per (rule, engine arm) a CONSTRUCT plan (an algo-ir Fn,
// src/algo-ir.ts "Shape values") that runs where the engine accepts that arm (RuleLowering.accept /
// cand / commit, PrattLowering's nud / led / operator sites) in place of the CST builder's node, and
// the shape form of the IR's steps that leaves on the child stack what the plans read.
//
// What a construct plan reads. When arm i is accepted, its children are the child stack's slots b..n
// (n: the height). Each slot carries a TAG: the number of the grammar node that left it, within its
// arm (numberArm: every token / literal / rule reference / literal alternation of the arm, in
// preorder; an even tag is a NAMED child, an odd one an unnamed leaf), set by the step that left it
// (Step.tag; -1 on anything else). A repetition the plan iterates (map / fold) has its body's steps
// marked (Step.mark): each iteration's slots are preceded by a zero-width MARKER slot (tag -2 - m).
// So the plan finds a child by its tag, an inline alternation's branch by the tag range of the
// branch's nodes, and an iteration between two markers: no matching, no backtracking, no CST.
// Positional children are read by position instead: a Pratt rule's operator forms (left / op /
// right, op / operand, operand / op), a led's left operand (slot b), a NUD token arm's token.
//
// Engine arms against grammar arms (the names a shape is written in, src/grammar-names.ts): an rd
// rule's engine alternative i IS grammar alternative i (RdRule.altNames). A Pratt / left-recursive
// rule's NUD arm i, led i and postfix token i are each one grammar arm (nudNames / ledNames /
// postfixTokNames); every `prefix` / `$ op $` / `$ postfix` grammar alternative is ONE engine path
// per form, and grammar-names gives each form ONE arm name (opNames): one to one again. A NUD or
// postfix token arm whose token is a template token runs as two engine paths (the plain token, the
// interpolated template) for the same arm. A shared step (ParserIR.shared) is printed once for
// every site, so it cannot carry each site's tags: the shape form prints each site in place
// (`share` dropped); passing the site's tag base to the shared function is the end state's answer.
//
// ATTRIBUTES (S2). A synthesized attribute is computed at the accept site, beside the value (it
// reads the arm's own children's synthesized attributes and leaves), and kept per slot.
// An inherited SCALAR attribute reaches a node in one of two ways, and the plan uses each:
// - an rd rule's node is built inside the call its parent makes, so the attribute is CONTEXT the
//   call sets (Step.inh: the parent arm's equation for that child, a constant or a copy of its own
//   attribute, else the default; restored after the call), and a threaded repetition sets the
//   threaded state around each element's calls and computes the next state after each iteration
//   (Step.threadInit / Step.thread, over the iteration's slots between its markers);
// - VARIANTS: a Pratt rule's node can become the LEFT operand of an operator seen after it was
//   built, and the left takes that operator's equation for `left` (or the default), not the
//   context its call had (`a.b.c`: tsc / ESTree `chainTop` is false for `a.b`). So a Pratt arm
//   whose value reads an inherited (bool) attribute is built under BOTH values (what does not
//   depend on it is computed once and shared), and every READER of the node picks the variant by
//   the value it gives the child (its equation, else the default): the led its left, an rd parent
//   its child, parse() the root. Nothing is rebuilt and no children are kept.
// S3: an attribute a Pratt arm reads only in its top layer is READER-APPLIED (topForm: no
// variants), and one a Pratt rule's arms copy into children (a spine: ESTree `pattern`) is CONTEXT
// with RE-PARSE ON DEMAND (Restart). Not yet compiled (an arm needing one is MISSING,
// `unsupported`, which fails only where it is read, as an unmapped arm does): a nodes attribute, a
// template's parts, a Pratt arm reading two variant attributes or handing one down, an inherited
// equation at a call site that reads more than a constant or a copy.
import { ZERO_WIDTH_MARKERS } from './grammar-utils.ts';
import type { Expr, Fn, Stmt } from './algo-ir.ts';
import type { ParserIR, PrattRule, RdRule, RuleIR, ShapeInhVal, Step } from './emit-portable.ts';
import type { RuleExpr } from './types.ts';
import { cardOf, type ArmInfo, type ScopeInfo, type Shape, type Slot } from './shape2-eval.ts';
import { kindsOf } from './shape-types.ts';
import { nodeKeysOf, type CookFn, type InhEq, type Scalar, type Term, type ThreadEq } from './shape2-schema.ts';

/** One engine arm: the rule, the engine's key for it, the grammar arm (null: none maps it). */
export type EngineArm = { id: number; rule: string; key: string; arm: string };
export type ShapePlan = {
  arms: EngineArm[];
  /** The id of the engine arm `key` of `rule` (see armKeys). */
  armId(rule: string, key: string): number;
  /** The construct plans (`construct<id>`), and the extern functions they call. */
  fns: Fn[];
  /** The IR whose building steps are the shape form (tagged, marked, unshared; no reuse). */
  ir: ParserIR;
  /** The cooking functions the plans call. */
  cooks: CookFn[];
  /** The tokens whose leaves the plans cook as IdentifierNames through `cookIdentSpan`: the
   * printer's runtime decides, once per parse, whether any token of these kinds contains a
   * backslash (an escape); when none does, every such cook is the leaf's span itself. */
  identCookTokens: string[];
  /** Arms compiled to a missing value, with the reason. */
  unsupported: Map<number, string>;
  /** The synthesized attributes (index k): per engine arm the function computing it at the
   * arm's accept site (`syn<k>_<id>`), null where the arm takes the default. */
  syn: { name: string; dflt: Scalar | undefined; fns: (string | null)[]; slotRead: boolean }[];
  /** The inherited scalar attributes an rd rule reads (index k: the context the engine sets at
   * each call of such a rule, Step.inh), with their defaults. */
  inh: { name: string; dflt: Scalar }[];
  /** Per engine arm: the bit (in its rule's variant attributes) of the one inherited attribute
   * its value is built under both values of (a Pratt arm: see VARIANTS), else -1; and whether
   * that attribute's default is true (the value a reader without an equation takes). */
  variantBit: number[];
  variantDefault: boolean[];
  /** Per engine arm: the function applying its READER-APPLIED TOP layer (topForm) to its value
   * (`top<id>(x, off, end)`: the layer's node, applied where the arm's kept condition under the
   * attribute = true holds, topBit), else null; and whether the attribute's default is true (an observer of the
   * arm's accept sees the default reading). */
  tops: (string | null)[];
  topDefault: boolean[];
  /** The Pratt rules that re-parse a left operand on demand (Restart). */
  restarts: Restart[];
  /** Slot-leaving steps with a grammar tag, and those that write it (a plan reads it). */
  tagStats: { sites: number; tagged: number };
  /** How the plans' slot reads are compiled (FUSED positions; counted per compiled read site). */
  reads: ReadStats;
  /** Child reads checked for a missing value (kept) and those whose rule builds none (dropped). */
  needs: { kept: number; dropped: number };
  /** The keys a node holds its kind and span under, before its fields (ShapeSpec.node): one flat
   * object per node. */
  nodeKeys: { kind: string; start: string; end: string };
};

/** RE-PARSE ON DEMAND for a Pratt rule's spine attribute k (see planShape): per engine arm whether
 * it is a SPINE arm (it reads the attribute or copies it into a child: the trigger's "the left
 * depends on it"; M5's `form & formPass(i)` is the exact form of the same test); the value the
 * binary operator gives its left (a constant, or the function `fn(b, off, end)` over the operator
 * slot just pushed at b + 1); per led its left's value; the context the binary operator's right
 * operand and the prefix operator's operand are called with. */
export type Restart = {
  rule: string; k: number; spine: boolean[];
  bin: { c: Scalar } | { fn: string }; leds: Scalar[]; right: ShapeInhVal; operand: ShapeInhVal;
};

/** The engine's key for each accept site of a rule: rd `alt<i>`; Pratt `nud<i>`, `led<i>`,
 * `post<i>` (postfix token i), `bin`, `postop`. */
export function armKeys(r: RuleIR): { key: string; arm: string }[] {
  if (r.kind === 'rd') return r.alts.map((_, i) => ({ key: `alt${i}`, arm: r.altNames[i]! }));
  const out: { key: string; arm: string }[] = [];
  r.nudOrder.forEach((_, i) => out.push({ key: `nud${i}`, arm: r.nudNames[i]! }));
  r.leds.forEach((_, i) => out.push({ key: `led${i}`, arm: r.ledNames[i]! }));
  r.postfixToks.forEach((_, i) => out.push({ key: `post${i}`, arm: r.postfixTokNames[i]! }));
  // The operator sites are printed for every Pratt rule; one without operator arms (a left-recursive
  // rule) never reaches them: no arm (NO_ARM), a plan that is never run.
  out.push({ key: 'bin', arm: r.opNames?.binary ?? NO_ARM }); out.push({ key: 'postop', arm: r.opNames?.postfix ?? NO_ARM });
  return out;
}

export const NO_ARM = '(no arm)';
class Unsupported extends Error {}
const no = (why: string): never => { throw new Unsupported(why); };

// ── Tags: the grammar nodes of one arm, numbered ──
type Numbering = { tagOf: Map<RuleExpr, number>; branchRange: Map<RuleExpr, [number, number][]>; nullableBranch: Set<RuleExpr> };
const ZERO_WIDTH = ZERO_WIDTH_MARKERS;
function numberArm(items: RuleExpr[], named: (e: RuleExpr) => boolean): Numbering {
  const n: Numbering = { tagOf: new Map(), branchRange: new Map(), nullableBranch: new Set() };
  let k = 0;
  const leaf = (e: RuleExpr) => { n.tagOf.set(e, 2 * k + (named(e) ? 0 : 1)); k++; };
  const visit = (e: RuleExpr): void => {
    switch (e.type) {
      case 'ref': case 'literal': leaf(e); return;
      case 'group': case 'quantifier': visit(e.body); return;
      case 'seq': e.items.forEach(visit); return;
      case 'sep': visit(e.element); return;
      case 'alt': {
        if (e.items.length > 0 && e.items.every((x) => x.type === 'literal')) { leaf(e); return; }
        const rs: [number, number][] = [];
        for (const b of e.items) { const s = k; visit(b); rs.push([2 * s, 2 * k - 1]); if (k === s) n.nullableBranch.add(e); }
        n.branchRange.set(e, rs);
        return;
      }
      default: if (!ZERO_WIDTH.has(e.type)) throw new Error(`planShape: unexpected grammar item ${e.type}`);
    }
  };
  items.forEach(visit);
  return n;
}

// ── Positions: where the arm's structure fixes a grammar node's slot (the FUSED reads) ──
// Every grammar leaf and rule reference the parse matches leaves exactly one slot, in order (a
// literal the lexer composes from several tokens, ParserIR.gtComps, leaves none in a TS parser:
// its width is unknown here). So within one SCOPE (the arm, whose slots start at b; or one
// iteration of a repetition, whose slots start past its marker) a node's slot is at a fixed offset
// from the scope's first slot when every item before it leaves a fixed number of slots, and (the
// arm only: an iteration's upper bound may hold a delimiter or what follows the repetition) at a
// fixed offset from the arm's last slot when every item after it does. `conds`: the optionals and
// alternation branches between the scope and the node (it is there for sure when every branch in
// it is one the reading scope knows is taken, and no optional). A node met twice in one arm (a
// grammar object referenced twice) has no fixed offset.
type Pos = { lo: number | null; hi: number | null; conds: RuleExpr[] };
type Positions = { pos: Map<RuleExpr, Pos>; width: (e: RuleExpr) => number | null };
function slotPositions(items: RuleExpr[], gtComps: readonly string[]): Positions {
  const pos = new Map<RuleExpr, Pos>();
  const widths = new Map<RuleExpr, number | null>();
  const width = (e: RuleExpr): number | null => {
    if (widths.has(e)) return widths.get(e)!;
    let w: number | null;
    switch (e.type) {
      case 'ref': w = 1; break;
      case 'literal': w = gtComps.includes(e.value) ? null : 1; break;
      case 'group': w = width(e.body); break;
      case 'seq': { w = 0; for (const x of e.items) { const y = width(x); w = w === null || y === null ? null : w + y; } break; }
      case 'quantifier': w = width(e.body) === 0 ? 0 : null; break;
      case 'sep': w = width(e.element) === 0 ? 0 : null; break;
      case 'alt': {
        if (e.items.length > 0 && e.items.every((x) => x.type === 'literal')) { w = e.items.some((x) => gtComps.includes((x as { value: string }).value)) ? null : 1; break; }
        const ws = e.items.map(width);
        w = ws.length > 0 && ws.every((x) => x !== null && x === ws[0]) ? ws[0]! : null;
        break;
      }
      default: w = 0;
    }
    widths.set(e, w);
    return w;
  };
  const twice = new Set<RuleExpr>();
  const at = (e: RuleExpr, lo: number | null, conds: RuleExpr[]) => { if (pos.has(e)) twice.add(e); pos.set(e, { lo, hi: null, conds }); };
  const leafLike = (e: RuleExpr) => e.type === 'ref' || e.type === 'literal' || (e.type === 'alt' && e.items.length > 0 && e.items.every((x) => x.type === 'literal'));
  const plus = (c: number | null, w: number | null) => (c === null || w === null ? null : c + w);
  // Forward: offsets from the scope's first slot; a repetition's body is a scope of its own.
  const fw = (e: RuleExpr, cur: number | null, conds: RuleExpr[]): number | null => {
    if (leafLike(e)) { at(e, cur, conds); return plus(cur, width(e)); }
    switch (e.type) {
      case 'group': return fw(e.body, cur, conds);
      case 'seq': { let c = cur; for (const x of e.items) c = fw(x, c, conds); return c; }
      case 'quantifier':
        if (e.kind === '?') { at(e, cur, conds); fw(e.body, cur, [...conds, e]); return plus(cur, width(e)); }
        at(e, cur, conds); fw(e.body, 0, []); return plus(cur, width(e));
      case 'sep': at(e, cur, conds); fw(e.element, 0, []); return plus(cur, width(e));
      case 'alt': at(e, cur, conds); e.items.forEach((b) => fw(b, cur, [...conds, b])); return plus(cur, width(e));
      default: return cur;
    }
  };
  // Backward, the arm's scope only: offsets from the arm's last slot.
  const bw = (e: RuleExpr, cur: number | null): number | null => {
    const p = pos.get(e);
    if (leafLike(e)) { if (p) p.hi = cur; return plus(cur, width(e)); }
    switch (e.type) {
      case 'group': return bw(e.body, cur);
      case 'seq': { let c = cur; for (let i = e.items.length - 1; i >= 0; i--) c = bw(e.items[i]!, c); return c; }
      case 'quantifier': case 'sep':
        if (p) p.hi = cur;
        if (e.type === 'quantifier' && e.kind === '?') bw(e.body, cur);
        return plus(cur, width(e));
      case 'alt': if (p) p.hi = cur; e.items.forEach((b) => bw(b, cur)); return plus(cur, width(e));
      default: return cur;
    }
  };
  let c: number | null = 0;
  for (const x of items) c = fw(x, c, []);
  c = 0;
  for (let i = items.length - 1; i >= 0; i--) c = bw(items[i]!, c);
  for (const e of twice) pos.set(e, { lo: null, hi: null, conds: [] });
  return { pos, width };
}

// ── algo-ir helpers ──
const v = (name: string): Expr => ({ k: 'var', name });
const int = (x: number): Expr => ({ k: 'int', v: x });
const bin = (op: Extract<Expr, { k: 'bin' }>['op'], a: Expr, b: Expr): Expr => ({ k: 'bin', op, a, b });
const call = (fn: string, ...args: Expr[]): Expr & { k: 'call' } => ({ k: 'call', fn, args });
const VAL = 'val_any', VALS = 'vals_any';
const EXTERNS: Fn[] = [
  ['slotTag', [['i', 'idx']], 'int'], ['slotOff', [['i', 'idx']], 'pos'], ['slotEnd', [['i', 'idx']], 'pos'],
  ['slotVal', [['i', 'idx']], VAL], ['slotArmName', [['i', 'idx']], VAL], ['slotTop', [], 'idx'],
  ['slotFind', [['lo', 'idx'], ['hi', 'idx'], ['t0', 'int'], ['t1', 'int']], 'int'],
  ['slotFindLast', [['lo', 'idx'], ['hi', 'idx'], ['t0', 'int'], ['t1', 'int']], 'int'],
  ['namedEnd', [['lo', 'idx'], ['hi', 'idx']], 'int'],
  // The fused read of a slot that may not be there: slot i when lo <= i < hi and its tag is in
  // t0..t1, else -1.
  ['slotAt', [['i', 'idx'], ['lo', 'idx'], ['hi', 'idx'], ['t0', 'int'], ['t1', 'int']], 'int'],
  ['srcText', [['a', 'pos'], ['b', 'pos']], 'str'],
  // The text s[a, b) of the source as a value (vText of srcText, without the string in between).
  ['textSpan', [['a', 'pos'], ['b', 'pos']], VAL],
  // cook_identifierName of s[a, b), one token of ShapePlan.identCookTokens: the span itself when
  // no token of those kinds in the source has a backslash.
  ['cookIdentSpan', [['a', 'pos'], ['b', 'pos']], VAL],
].map(([name, ps, ret]) => ({ name: name as string, doc: '', params: (ps as [string, string][]).map(([n, ty]) => ({ name: n, ty: ty as never })), ret: [ret as never], body: [], extern: true, method: true, reads: true }));
// The span a value gives a `let` / fold variable: a node's, a non-empty node list's first start /
// last end, else `dflt`.
const SPAN_FNS: Fn[] = ['valStart', 'valEnd'].map((name) => ({ name, doc: '', params: [{ name: 'x', ty: VAL as never }, { name: 'dflt', ty: 'pos' as never }], ret: ['int' as never], body: [], extern: true }));
const cookFn = (fn: CookFn): Fn => ({ name: `cook_${fn}`, doc: '', params: [{ name: 's', ty: 'str' }], ret: [VAL as never], body: [], extern: true });
// The attribute engine methods (S2): an inherited context attribute's current value; a node slot's
// value read with the variant bits its reader gives it; a slot's synthesized attribute k; this
// node's own (computed just before its value); the second variant of a variant arm; a record's
// field; a list without its last element.
const ATTR_FNS: Fn[] = ([
  ['inhVar', [['k', 'int']], VAL, true], ['slotValV', [['i', 'idx'], ['m', 'int']], VAL, true], ['slotSyn', [['k', 'int'], ['i', 'idx']], VAL, true],
  ['selfSyn', [['k', 'int']], VAL, true], ['altVal', [['x', VAL]], null, true], ['recGet', [['x', VAL], ['f', 'str']], VAL, false],
  ['vDropLast', [['x', VAL], ['c', 'bool']], VAL, false],
  // A reader-applied top (topForm): a slot's value read under the attribute = true (its arm's top
  // layer applied when its kept condition holds; m: the variant bits), and the arm's condition kept.
  ['slotValT', [['i', 'idx'], ['m', 'int']], VAL, true], ['topBit', [['c', 'bool']], null, true],
] as [string, [string, string][], string | null, boolean][]).map(([name, ps, ret, method]) => ({
  name, doc: '', params: ps.map(([n, ty]) => ({ name: n, ty: ty as never })), ret: ret === null ? [] : [ret as never], body: [], extern: true,
  ...(method ? { method: true, reads: true } : {}),
}));
const ARM_PARAMS = [{ name: 'b', ty: 'idx' as const }, { name: 'off', ty: 'pos' as const }, { name: 'end', ty: 'pos' as const }];

/** Every term inside a term (itself included). */
function eachTerm(t: unknown, f: (t: Term) => void): void {
  if (t === null || typeof t !== 'object') return;
  if (Array.isArray(t)) { t.forEach((x) => eachTerm(x, f)); return; }
  if (typeof (t as { t?: unknown }).t === 'string') f(t as Term);
  for (const x of Object.values(t)) eachTerm(x, f);
}
const inhReads = (t: unknown): Set<string> => { const out = new Set<string>(); eachTerm(t, (x) => { if (x.t === 'inh') out.add(x.attr); }); return out; };

/** A READER-APPLIED TOP (docs/SHAPE.md "Inherited equations"): an arm term `let(x, X, iff(c, W[x],
 * x))` (what `wrapIf` writes) whose inherited attribute `attr` is read only in that outermost
 * layer: X reads no inherited attribute, c is a bool over `attr`, the arm's own synthesized
 * attributes and constants, and W is a node of a constant kind over x and constants, spanning the
 * arm. The construct then builds X alone (and keeps c under `attr` = true per slot), and each
 * reader of the slot applies the layer (`wrap`, over the variable `name`) with its own equation
 * value of `attr`: no variants. Null: not that form. */
export function topForm(t: Term, attr: string): { inner: Term; name: string; cond: Term; wrap: Term } | null {
  if (t.t !== 'let' || t.body.t !== 'if') return null;
  const { name, value, body } = t;
  const { cond, then, else: els } = body as Extract<Term, { t: 'if' }>;
  if (els.t !== 'var' || els.name !== name) return null;
  if (inhReads(value).size > 0) return null;
  const condOk = (c: Term): boolean => {
    switch (c.t) {
      case 'const': return typeof c.value === 'boolean';
      case 'inh': return c.attr === attr;
      case 'syn': return c.name === undefined;
      case 'not': return condOk(c.arg);
      case 'and': case 'or': return c.args.every(condOk);
      default: return false;
    }
  };
  if (!condOk(cond) || !inhReads(cond).has(attr)) return null;
  if (then.t !== 'node' || then.type.t !== 'const' || then.span !== undefined) return null;
  if (!Object.values(then.fields).every((f) => f.t === 'const' || f.t === 'absent' || (f.t === 'var' && f.name === name))) return null;
  return { inner: value, name, cond, wrap: then };
}

/** An arm's inherited equations: attribute -> child name -> equation. */
type Eqs = Map<string, Map<string, InhEq>>;
type RuleEqs = Record<string, Record<string, Record<string, InhEq>>>;
function armEqs(shape: Shape, rule: string, arm: string): Eqs {
  const out: Eqs = new Map();
  for (const [attr, d] of Object.entries(shape.spec.inherited ?? {})) {
    const kids = (d.rules as RuleEqs)[rule]?.[arm];
    if (kids) out.set(attr, new Map(Object.entries(kids)));
  }
  return out;
}

/** Compile `shape` against `ir` (built from the shape's own grammar). */
export function planShape(shape: Shape, ir: ParserIR): ShapePlan {
  const arms: EngineArm[] = [];
  const ids = new Map<string, number>();
  const unsupported = new Map<number, string>();
  const cooks = new Set<CookFn>();
  const fns: Fn[] = [];
  const newRules: RuleIR[] = [];
  const spec = shape.spec;
  const inhDecls = Object.entries(spec.inherited ?? {});
  const scalarInh = inhDecls.filter(([, d]) => d.type !== 'nodes').map(([name, d]) => ({ name, dflt: (d as { default: Scalar }).default }));
  const inhK = new Map(scalarInh.map((a, k) => [a.name, k]));
  const nodesAttrs = new Set(inhDecls.filter(([, d]) => d.type === 'nodes').map(([n]) => n));
  const synDecls = Object.entries(spec.synthesized ?? {});
  const synK = new Map(synDecls.map(([n], k) => [n, k]));
  const syn = synDecls.map(([name, d]) => ({ name, dflt: d.default, fns: [] as (string | null)[], slotRead: false }));
  const variantBit: number[] = [], variantDefault: boolean[] = [];
  const tagStats = { sites: 0, tagged: 0 };
  // The scalar inherited attributes each rule's arms read (in values and equations): a Pratt
  // rule's are its VARIANT attributes, an rd rule's the context its callers set.
  const kinds = new Map(ir.rules.map((r) => [r.name, r.kind]));
  const reads = new Map<string, string[]>();
  for (const r of ir.rules) {
    const got = inhReads(Object.values(spec.rules[r.name] ?? {}));
    for (const [, d] of inhDecls) for (const kids of Object.values((d.rules as RuleEqs)[r.name] ?? {})) {
      for (const eq of Object.values(kids)) for (const a of inhReads(eq.t === 'thread' ? (eq as ThreadEq).init : eq)) got.add(a);
    }
    reads.set(r.name, scalarInh.map((a) => a.name).filter((a) => got.has(a)));
  }
  // READER-APPLIED TOPS (topForm): a Pratt rule's bool attribute that every arm reading it reads
  // only in its top layer, and that no equation of the rule's arms reads (one per rule). Its
  // readers apply the layer; it is not a variant attribute.
  const topAttr = new Map<string, string>();
  for (const r of ir.rules) {
    if (r.kind !== 'pratt') continue;
    const terms = Object.values(spec.rules[r.name] ?? {});
    const eqReads = new Set<string>();
    for (const [, d] of inhDecls) for (const kids of Object.values((d.rules as RuleEqs)[r.name] ?? {})) for (const eq of Object.values(kids)) for (const a of inhReads(eq.t === 'thread' ? (eq as ThreadEq).init : eq)) eqReads.add(a);
    for (const [, d] of synDecls) for (const eq of Object.values(d.rules[r.name] ?? {})) for (const a of inhReads(eq)) eqReads.add(a);
    const ts = (reads.get(r.name) ?? []).filter((a) => typeof scalarInh[inhK.get(a)!]!.dflt === 'boolean' && !eqReads.has(a)
      && terms.some((t) => inhReads(t).has(a)) && terms.every((t) => !inhReads(t).has(a) || topForm(t, a) !== null));
    if (ts.length === 1) topAttr.set(r.name, ts[0]!);
  }
  // SPINE attributes (RE-PARSE ON DEMAND): a Pratt rule's attribute some arm of the rule copies
  // into a child (ESTree `pattern`: the literals hand it to their elements) is CONTEXT, as an rd
  // rule's is (set at every call of the rule, read as inhVar). A led's equation for its LEFT is
  // known only once the led is seen, after the left was built under the invocation's context: when
  // the two differ and the left's arm reads or copies the attribute (a SPINE arm), the engine
  // re-parses the left under the led's value (restore to the invocation's mark, parse again up to
  // the led's token) and goes on. One per rule.
  const spineAttr = new Map<string, string>();
  for (const r of ir.rules) {
    if (r.kind !== 'pratt') continue;
    const copies = new Set<string>();
    for (const [attr, d] of inhDecls) for (const kids of Object.values((d.rules as RuleEqs)[r.name] ?? {})) for (const eq of Object.values(kids)) if (eq.t === 'inh' && eq.attr === attr) copies.add(attr);
    const ss = (reads.get(r.name) ?? []).filter((a) => copies.has(a) && topAttr.get(r.name) !== a && typeof scalarInh[inhK.get(a)!]!.dflt === 'boolean');
    if (ss.length === 1) spineAttr.set(r.name, ss[0]!);
  }
  const variants = (rule: string): string[] => (kinds.get(rule) === 'pratt' ? (reads.get(rule) ?? []).filter((a) => topAttr.get(rule) !== a && spineAttr.get(rule) !== a) : []);
  // The context attributes a call of `rule` sets (Step.inh).
  const ctxOf = (rule: string): string[] => (kinds.get(rule) === 'rd' ? reads.get(rule) ?? [] : spineAttr.has(rule) ? [spineAttr.get(rule)!] : []);
  const restarts: Restart[] = [];
  const tops: (string | null)[] = [], topDefault: boolean[] = [];
  const cx: AttrCx = { inhK, synK, scalarInh, nodesAttrs, variants, topAttr, ctxOf, synDflt: syn.map((a) => a.dflt), synSlotRead: new Set(), needRule: new Map(), identCook: new Set() };
  const readStats: ReadStats = { fixed: 0, checked: 0, scan: 0, list: 0 };
  for (const r of ir.rules) {
    const view = shape.grammar.arms.get(r.name);
    const names = shape.grammar.names.get(r.name);
    if (!view || !names) throw new Error(`planShape: the IR's rule ${r.name} is not in the shape's grammar (plan a shape against the grammar it was defined on)`);
    const named = (e: RuleExpr) => names.childOf.has(e);
    const marked = new Map<RuleExpr, number>();   // quantifier body / sep element -> marker tag
    const tagsByKey = new Map<string, Numbering>();
    const sitesByKey = new Map<string, ArmSites>();
    for (const { key, arm } of armKeys(r)) {
      const id = arms.length;
      const fnStart = fns.length;
      arms.push({ id, rule: r.name, key, arm });
      ids.set(`${r.name}|${key}`, id);
      variantBit.push(-1); variantDefault.push(false); tops.push(null); topDefault.push(false);
      for (const sy of syn) sy.fns.push(null);
      if (arm === NO_ARM) {
        tagsByKey.set(key, numberArm([], named));
        fns.push({ name: `construct${id}`, doc: `${r.name} ${key}: no such arm`, params: ARM_PARAMS, ret: [VAL as never], body: [{ k: 'return', es: [{ k: 'vMissing', where: `${r.name} ${key}`, why: 'unmapped' }] }], method: true, reads: true });
        continue;
      }
      const info = view.find((a) => a.arm === arm);
      if (!info) throw new Error(`planShape: ${r.name}: the engine arm ${key} names the arm ${arm}, which the shape's grammar view does not have`);
      const num = numberArm(info.items ?? [], named);
      tagsByKey.set(key, num);
      const eqs = armEqs(shape, r.name, arm);
      const sites: ArmSites = { eqs, childOf: childNames(info), threads: new Map() };
      sitesByKey.set(key, sites);
      const sa = spineAttr.get(r.name);
      if (sa !== undefined) {
        let rs = restarts.find((x) => x.rule === r.name);
        if (!rs) { rs = { rule: r.name, k: inhK.get(sa)!, spine: [], bin: { c: false }, leds: [], right: { c: false }, operand: { c: false } }; restarts.push(rs); }
        const dflt = scalarInh[inhK.get(sa)!]!.dflt;
        const kids = eqs.get(sa);
        const t0 = spec.rules[r.name]?.[arm];
        rs.spine[id] = (t0 !== undefined && inhReads(t0).has(sa)) || [...(kids?.values() ?? [])].some((e) => e.t === 'inh' && e.attr === sa);
        const left = kids?.get('left');
        const ctxVal = (e: InhEq | undefined): ShapeInhVal => (e === undefined ? { c: dflt } : inhVal(cx, e as Term));
        if (key.startsWith('led')) {
          if (left !== undefined && left.t !== 'const') throw new Error(`planShape: ${r.name}.${arm}: the left's ${sa} at a led is a constant (re-parse on demand), not ${left.t}`);
          rs.leds[Number(key.slice(3))] = left === undefined ? dflt : (left as { value: Scalar }).value;
        }
        if (key === 'bin') {
          rs.right = ctxVal(kids?.get('right'));
          if (left === undefined || left.t === 'const') rs.bin = { c: left === undefined ? dflt : (left as { value: Scalar }).value };
          else {
            const fnName = `leq${id}`;
            fns.push({ name: fnName, doc: `${r.name}.${arm}: the left's ${sa} (its operator just pushed)`, params: ARM_PARAMS, ret: [VAL as never], body: new ArmCompiler(shape, info, num, positional(r, key, info), 0, marked, cooks, cx, eqs, null, readStats, new Set()).compile(left as Term), method: true, reads: true });
            rs.bin = { fn: fnName };
          }
        }
        if (info.form === 'prefix') rs.operand = ctxVal(kids?.get('operand'));
      }
      let term = spec.rules[r.name]?.[arm];
      const where = `${r.name}.${arm}`;
      const at = info.form ? null : slotPositions(info.items ?? [], ir.gtComps);
      const ownSyn = new Set(synDecls.flatMap(([, d], k) => (d.rules[r.name]?.[arm] !== undefined ? [k] : [])));
      const compiler = () => new ArmCompiler(shape, info, num, positional(r, key, info), key.startsWith('led') ? 1 : 0, marked, cooks, cx, eqs, at, readStats, ownSyn);
      // The arm's synthesized attributes and threads (a reason it cannot is the arm's reason too).
      let attrWhy: string | undefined;
      for (const [k, [attr, d]] of synDecls.entries()) {
        const eq = d.rules[r.name]?.[arm];
        if (eq === undefined) continue;
        const name = `syn${k}_${id}`;
        try { fns.push({ name, doc: `${where} synthesized ${attr}`, params: ARM_PARAMS, ret: [VAL as never], body: compiler().compile(eq), method: true, reads: true }); syn[k]!.fns[id] = name; }
        catch (e) { if (!(e instanceof Unsupported)) throw e; attrWhy ??= e.message; }
      }
      for (const [attr, kids] of eqs) for (const [over, eq] of kids) {
        if (eq.t !== 'thread' || !inhK.has(attr)) continue;
        const k = inhK.get(attr)!;
        try {
          if (r.kind !== 'rd') no(`a thread in a Pratt arm (${attr})`);
          const name = `thr${k}_${id}`;
          const { q, body } = compiler().threadNext(eq as ThreadEq, over, k);
          fns.push({ name, doc: `${where} thread ${attr}: the state after an iteration`, params: [{ name: 'lo', ty: 'idx' }, { name: 'hi', ty: 'idx' }], ret: [VAL as never], body, method: true, reads: true });
          sites.threads.set(q, { k, init: inhVal(cx, (eq as ThreadEq).init), next: name });
        } catch (e) { if (!(e instanceof Unsupported)) throw e; attrWhy ??= e.message; }
      }
      let body: Stmt[];
      if (term === undefined) body = [{ k: 'return', es: [{ k: 'vMissing', where, why: 'unmapped' }] }];
      else {
        try {
          if (attrWhy !== undefined) no(attrWhy);
          if ([...nodesAttrs].some((n) => eqs.has(n))) no('a nodes-attribute equation');
          const vs = variants(r.name);
          if (vs.length) for (const kids of eqs.values()) for (const eq of kids.values()) {
            const h = [...inhReads(eq.t === 'thread' ? (eq as ThreadEq).init : eq)].find((a) => vs.includes(a));
            if (h !== undefined) no(`a Pratt arm handing down ${h}, which a later operator may change`);
          }
          const ta = topAttr.get(r.name);
          let topBody: Stmt[] | undefined;
          if (ta !== undefined && inhReads(term).has(ta)) {
            // A reader-applied top: the construct builds the inner value; top<id> the layer.
            const tf = topForm(term, ta)!;
            fns.push({ name: `top${id}`, doc: `${where}: the top layer (applied by a reader giving ${ta} = true)`, params: [{ name: 'x', ty: VAL as never }, { name: 'off', ty: 'pos' }, { name: 'end', ty: 'pos' }], ret: [VAL as never], body: compiler().compileTop(tf), method: true, reads: true });
            tops[id] = `top${id}`;
            topDefault[id] = scalarInh[inhK.get(ta)!]!.dflt === true;
            topBody = compiler().compileWithTop(tf, ta);
            term = tf.inner;
          }
          const own = [...inhReads(term)].filter((a) => vs.includes(a));
          if (vs.length && own.length > 1) no(`a Pratt arm reading two inherited attributes (${own.join(', ')})`);
          if (vs.length && own.length === 1) {
            if (typeof scalarInh[inhK.get(own[0]!)!]!.dflt !== 'boolean') no(`a Pratt arm reading the non-bool inherited ${own[0]}`);
            body = compiler().compileVariants(term, own[0]!);
            variantBit[id] = vs.indexOf(own[0]!);
            variantDefault[id] = scalarInh[inhK.get(own[0]!)!]!.dflt === true;
          } else body = topBody ?? compiler().compile(term);
        } catch (e) {
          if (!(e instanceof Unsupported)) throw e;
          unsupported.set(id, e.message);
          tops[id] = null;
          body = [{ k: 'return', es: [{ k: 'vMissing', where: `${where} (${e.message})`, why: 'unsupported' }] }];
        }
      }
      fns.push({ name: `construct${id}`, doc: where, params: ARM_PARAMS, ret: [VAL as never], body, method: true, reads: true });
      sites.readsTag = tagsRead(fns.slice(fnStart));
    }
    newRules.push(shapeSteps(r, tagsByKey, marked, sitesByKey, cx, reads, kinds, tagStats));
  }
  for (const k of cx.synSlotRead) syn[k]!.slotRead = true;
  const needs = dropNeeds(fns, arms, unsupported, cx.needRule);
  fns.push(...EXTERNS, ...SPAN_FNS, ...ATTR_FNS, ...[...cooks].map(cookFn));
  return {
    arms, fns, cooks: [...cooks], identCookTokens: [...cx.identCook], unsupported, syn, inh: scalarInh, variantBit, variantDefault, tops, topDefault, restarts, tagStats, reads: readStats, needs, nodeKeys: nodeKeysOf(spec),
    armId: (rule, key) => { const id = ids.get(`${rule}|${key}`); if (id === undefined) throw new Error(`planShape: no engine arm ${rule} ${key}`); return id; },
    ir: { ...ir, rules: newRules, reuse: null },
  };
}

/** A rule whose arms can all be built (none unmapped or unsupported, none reading a child that may
 * be missing, no `match` without a case) builds no missing value: a read of its node needs no check
 * (fixpoint over the rules; a TOTAL shape drops every check). Rewrites those vNeed in place. */
function dropNeeds(fns: Fn[], arms: EngineArm[], unsupported: Map<number, string>, needRule: Map<Expr, string | undefined>): { kept: number; dropped: number } {
  const byName = new Map(fns.map((f) => [f.name, f]));
  const mayMiss = new Set<string>();
  const walk = (x: unknown, f: (e: Expr) => void): void => {
    if (x === null || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach((y) => walk(y, f)); return; }
    if (typeof (x as Expr).k === 'string') f(x as Expr);
    for (const y of Object.values(x)) walk(y, f);
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const a of arms) {
      if (mayMiss.has(a.rule) || a.arm === NO_ARM) continue;
      let miss = unsupported.has(a.id);
      walk(byName.get(`construct${a.id}`)?.body, (e) => {
        if (e.k === 'vMissing') miss = true;
        if (e.k === 'vNeed' && needRule.has(e)) { const r = needRule.get(e); if (r === undefined || mayMiss.has(r)) miss = true; }
      });
      if (miss) { mayMiss.add(a.rule); changed = true; }
    }
  }
  let kept = 0, dropped = 0;
  for (const [e, r] of needRule) {
    if (r === undefined || mayMiss.has(r)) { kept++; continue; }
    const inner = (e as { e: Expr }).e;
    for (const k of Object.keys(e)) delete (e as Record<string, unknown>)[k];
    Object.assign(e, inner);
    dropped++;
  }
  return { kept, dropped };
}

type AttrCx = {
  inhK: Map<string, number>; synK: Map<string, number>; scalarInh: { name: string; dflt: Scalar }[];
  nodesAttrs: Set<string>; variants: (rule: string) => string[];
  /** Per Pratt rule, its reader-applied top attribute (topForm), if any. */
  topAttr: Map<string, string>;
  /** The context attributes a call of a rule sets (an rd rule's, a Pratt rule's spine one). */
  ctxOf: (rule: string) => string[];
  synDflt: (Scalar | undefined)[];
  /** The synthesized attributes some arm reads off a child's slot (kept per slot: the rest are not). */
  synSlotRead: Set<number>;
  /** The tokens of the leaves cooked by cookIdentSpan (ShapePlan.identCookTokens). */
  identCook: Set<string>;
  /** Each child read's vNeed and the child's rule (see ArmCompiler.need). */
  needRule: Map<Expr, string | undefined>;
};
/** How a plan's reads of slots are compiled: at a fixed position (fixed), a check of the one slot
 * at a fixed position (checked: an optional item, a branch, a marker), a scan of the scope's slots
 * (scan: what a repetition or an optional before the item makes dynamic), a walk over a
 * repetition's slots (list: a repeated child's items, a fold's iteration end). */
export type ReadStats = { fixed: number; checked: number; scan: number; list: number };
/** What an arm's call sites set: its equations, its children's names (by grammar node), its
 * threaded repetitions (by repetition node). */
type ArmSites = { eqs: Eqs; childOf: Map<RuleExpr, string>; threads: Map<RuleExpr, { k: number; init: ShapeInhVal; next: string }>; readsTag?: (t: number) => boolean };
/** The slot tags an arm's functions read (slotFind ranges, a list's tag; namedEnd reads every
 * named one): only those steps write a tag (Step.tag), the rest of the arm's slots keep -1. */
function tagsRead(fs: Fn[]): (t: number) => boolean {
  const ranges: [number, number][] = [];
  let all = false;
  const walk = (x: unknown): void => {
    if (x === null || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const e = x as Expr;
    if (e.k === 'call' && (e.fn === 'slotFind' || e.fn === 'slotFindLast' || e.fn === 'slotAt')) {
      const [a, b] = e.fn === 'slotAt' ? e.args.slice(3) : e.args.slice(2);
      if (a?.k === 'int' && b?.k === 'int') ranges.push([a.v, b.v]); else all = true;
    } else if (e.k === 'call' && e.fn === 'namedEnd') all = true;
    else if (e.k === 'bin' && e.op === 'eq' && e.a.k === 'call' && e.a.fn === 'slotTag') { if (e.b.k === 'int') ranges.push([e.b.v, e.b.v]); else all = true; }
    for (const y of Object.values(x)) walk(y);
  };
  fs.forEach((f) => walk(f.body));
  return all ? () => true : (t) => ranges.some(([a, b]) => t >= a && t <= b);
}
function childNames(info: ScopeInfo): Map<RuleExpr, string> {
  const out = new Map<RuleExpr, string>();
  const visit = (s: ScopeInfo): void => { for (const slot of s.slots.values()) { out.set(slot.node, slot.name); slot.branches?.forEach(visit); } };
  visit(info);
  return out;
}
/** A call site's value of an inherited attribute: a constant, or a copy of the caller's own. */
function inhVal(cx: AttrCx, eq: Term): ShapeInhVal {
  if (eq.t === 'const') return { c: eq.value };
  if (eq.t === 'inh' && cx.inhK.has(eq.attr)) return { copy: cx.inhK.get(eq.attr)! };
  throw new Error(`planShape: an inherited equation at a call site is a constant or a copy of the caller's attribute (S2), not ${eq.t}`);
}

/** The children an engine arm reads by position (offset from slot b). */
function positional(r: RuleIR, key: string, info: ArmInfo): Map<RuleExpr, number> {
  const m = new Map<RuleExpr, number>();
  if (info.form) {
    const order = info.form === 'binary' ? ['left', 'op', 'right'] : info.form === 'prefix' ? ['op', 'operand'] : ['operand', 'op'];
    order.forEach((nm, i) => m.set(info.slots.get(nm)!.node, i));
    return m;
  }
  const items = info.items ?? [];
  if (r.kind === 'pratt' && (key.startsWith('led') || key.startsWith('post'))) m.set(items[0]!, 0);
  if (r.kind === 'pratt' && key.startsWith('post')) m.set(items[1]!, 1);
  if (r.kind === 'pratt' && key.startsWith('nud') && r.nudOrder[Number(key.slice(3))]!.kind === 'tok') m.set(items[0]!, 0);
  return m;
}

/** The shape form of a rule's building steps: each slot-leaving step tagged, each marked
 * repetition body marked, every shared step printed in place; each call of an rd rule that
 * reads inherited attributes sets them (Step.inh), each threaded repetition threads its state
 * (Step.threadInit on the repetition, Step.thread on its marked body). */
function shapeSteps(r: RuleIR, tags: Map<string, Numbering>, marked: Map<RuleExpr, number>, sites: Map<string, ArmSites>, cx: AttrCx, reads: Map<string, string[]>, kinds: Map<string, string>, tagStats: { sites: number; tagged: number }): RuleIR {
  const clone = (num: Numbering, site: ArmSites | undefined) => {
    const attached = new Set<RuleExpr>();
    const bodyOf = new Map<RuleExpr, { k: number; next: string }>();
    // threaded: the attributes whose thread runs around this step (its calls keep the state).
    const c = (s: Step, threaded: Set<number>): Step => {
      const o = { ...s } as Step & { share?: number };
      delete o.share;
      if (s.src && (s.t === 'lit' || s.t === 'tok' || s.t === 'rule' || s.t === 'ruleBp' || s.t === 'altlit')) { const t = num.tagOf.get(s.src); if (t !== undefined) { tagStats.sites++; if (site?.readsTag?.(t)) { o.tag = t; tagStats.tagged++; } } }
      if (s.src && marked.has(s.src)) o.mark = marked.get(s.src)!;
      if (site && (s.t === 'rule' || s.t === 'ruleBp') && cx.ctxOf(s.name).length) {
        const kid = s.src ? site.childOf.get(s.src) : undefined;
        const inh: { k: number; v: ShapeInhVal }[] = [];
        for (const attr of cx.ctxOf(s.name)) {
          const k = cx.inhK.get(attr)!;
          if (threaded.has(k)) continue;
          const eq = kid === undefined ? undefined : site.eqs.get(attr)?.get(kid);
          // A Pratt arm handing one down is outside S2 (its construct is missing): the default.
          const v: ShapeInhVal = eq === undefined || eq.t === 'thread' || (eq.t === 'inh' && cx.variants(r.name).includes(eq.attr)) ? { c: cx.scalarInh[k]!.dflt } : inhVal(cx, eq);
          inh.push({ k, v });
        }
        if (inh.length) o.inh = inh;
      }
      let inner = threaded;
      const th = site && s.src ? site.threads.get(s.src) : undefined;
      if (th && (s.t === 'star' || s.t === 'sep')) {
        o.threadInit = { k: th.k, v: th.init };
        attached.add(s.src!);
        bodyOf.set(s.t === 'star' ? s.step.src! : s.elem.src!, { k: th.k, next: th.next });
        inner = new Set([...threaded, th.k]);
      }
      const bt = s.src ? bodyOf.get(s.src) : undefined;
      if (bt) { if (o.mark === undefined) throw new Error(`planShape: ${r.name}: a threaded repetition's body is not marked`); o.thread = bt; }
      switch (o.t) {
        case 'star': o.step = c(o.step, inner); break;
        case 'sep': o.elem = c(o.elem, inner); break;
        case 'opt': case 'seq': case 'suppress': case 'ctx': o.steps = o.steps.map((x) => c(x, inner)); break;
        case 'alt': o.branches = o.branches.map((b) => b.map((x) => c(x, inner))); break;
      }
      return o;
    };
    return (steps: Step[]) => {
      const out = steps.map((x) => c(x, new Set()));
      for (const q of site?.threads.keys() ?? []) if (!attached.has(q)) throw new Error(`planShape: ${r.name}: a threaded repetition has no repetition step`);
      return out;
    };
  };
  const at = (key: string) => clone(tags.get(key)!, sites.get(key));
  if (r.kind === 'rd') return { ...r, alts: r.alts.map((a, i) => at(`alt${i}`)(a)) } as RdRule;
  const p = r as PrattRule;
  const nudKey = (kind: string, index: number) => `nud${p.nudOrder.findIndex((x) => x.kind === kind && 'index' in x && x.index === index)}`;
  return {
    ...p,
    nudBrackets: p.nudBrackets.map((b, i) => ({ ...b, steps: at(nudKey('bracket', i))(b.steps) })),
    nudSeqs: p.nudSeqs.map((s, i) => at(nudKey('seq', i))(s)),
    nudCapped: p.nudCapped.map((c, i) => ({ ...c, steps: at(nudKey('capped', i))(c.steps) })),
    leds: p.leds.map((b, i) => ({ ...b, steps: at(`led${i}`)(b.steps) })),
  };
}

// ── Terms to construct plans ──
// A scope: the arm, a branch, or one iteration (`base`: the repetitions consumed to reach it), over
// the slots lo..hi (algo-ir variables), with the variables bound around it.
type Bound = { val: string; start: string; end: string };
// `origin`: the variable a fixed offset (Pos.lo) counts from (the arm's slot b; an iteration's first
// slot); `hiOk`: hi is the arm's last slot + 1 (Pos.hi counts back from it); `taken`: the branches
// (grammar items) known taken in this scope (a branch case's).
type CScope = { info: ScopeInfo; base: RuleExpr[]; lo: string; hi: string; outer?: CScope; vars: Map<string, Bound>; arm: boolean; origin: string; hiOk: boolean; taken: Set<RuleExpr> };
const startsWith = (a: RuleExpr[], p: RuleExpr[]): boolean => p.every((q, i) => a[i] === q);
const isListQ = (q: RuleExpr): boolean => q.type === 'sep' || (q.type === 'quantifier' && q.kind !== '?');

class ArmCompiler {
  private n = 0;
  private shape: Shape; private info: ArmInfo; private num: Numbering; private pos: Map<RuleExpr, number>; private lo0: number;
  private marked: Map<RuleExpr, number>; private cooks: Set<CookFn>; private cx: AttrCx; private eqs: Eqs;
  // Variants (compileVariants): the inherited attribute fixed to a value while one variant is
  // compiled; the values of terms that do not read it, computed once at the arm's top level.
  private fixed: [string, boolean] | null = null;
  private cache: Map<Term, Expr> | null = null;
  private root: Stmt[] = [];
  private armScope!: CScope;
  private at: Positions | null; private reads: ReadStats; private ownSyn: Set<number>;
  constructor(shape: Shape, info: ArmInfo, num: Numbering, pos: Map<RuleExpr, number>, lo0: number, marked: Map<RuleExpr, number>, cooks: Set<CookFn>, cx: AttrCx, eqs: Eqs, at: Positions | null, reads: ReadStats, ownSyn: Set<number>) {
    this.shape = shape; this.info = info; this.num = num; this.pos = pos; this.lo0 = lo0; this.marked = marked; this.cooks = cooks; this.cx = cx; this.eqs = eqs;
    this.at = at; this.reads = reads; this.ownSyn = ownSyn;
  }
  private tmp(): string { return `t${this.n++}`; }

  private open(): Stmt[] {
    this.root = [
      { k: 'let', name: 'lo', ty: 'idx', init: bin('add', v('b'), int(this.lo0)) },
      { k: 'let', name: 'hi', ty: 'idx', init: call('slotTop') },
    ];
    this.armScope = { info: this.info, base: [], lo: 'lo', hi: 'hi', vars: new Map(), arm: true, origin: 'b', hiOk: true, taken: new Set() };
    return this.root;
  }
  compile(term: Term): Stmt[] {
    const out = this.open();
    const r = this.val(term, this.armScope, out);
    out.push({ k: 'return', es: [r] });
    return out;
  }
  /** The value under `attr` = false (returned) and = true (altVal), sharing what does not read it. */
  compileVariants(term: Term, attr: string): Stmt[] {
    const out = this.open();
    this.cache = new Map();
    this.fixed = [attr, false];
    const f = this.bindVal(this.val(term, this.armScope, out), out);
    this.fixed = [attr, true];
    const t = this.bindVal(this.val(term, this.armScope, out), out);
    out.push({ k: 'run', call: call('altVal', v(t)) });
    out.push({ k: 'return', es: [v(f)] });
    return out;
  }
  /** A reader-applied top's construct (topForm): the inner value, and the layer's condition under
   * the attribute = true (topBit: kept per slot; a reader giving true applies the layer when it is
   * set). The condition under false must be false (a reader giving false reads the value). */
  compileWithTop(tf: { inner: Term; cond: Term }, attr: string): Stmt[] {
    const out = this.open();
    const r = this.bindVal(this.val(tf.inner, this.armScope, out), out);
    this.fixed = [attr, false];
    if (this.staticBool(tf.cond) !== false) no(`a reader-applied ${attr} whose layer applies under ${attr} = false`);
    this.fixed = [attr, true];
    out.push({ k: 'run', call: call('topBit', this.bool(tf.cond, this.armScope, out)) });
    this.fixed = null;
    out.push({ k: 'return', es: [v(r)] });
    return out;
  }
  /** A reader-applied top's layer node over the arm's value `x` spanning off..end. */
  compileTop(tf: { name: string; wrap: Term }): Stmt[] {
    this.root = [];
    const out = this.root;
    this.armScope = { info: this.info, base: [], lo: 'off', hi: 'end', vars: new Map([[tf.name, { val: 'x', start: 'off', end: 'end' }]]), arm: true, origin: 'off', hiOk: false, taken: new Set() };
    out.push({ k: 'return', es: [this.val(tf.wrap, this.armScope, out)] });
    return out;
  }
  /** A thread's next state over one iteration's slots lo..hi (the state: the attribute's current
   * value), and the repetition it threads. */
  threadNext(eq: ThreadEq, over: string, k: number): { q: RuleExpr; body: Stmt[] } {
    const slot = this.info.slots.get(over);
    if (!slot) throw new Error(`planShape: ${this.info.where}: thread over ${over}: no such child`);
    const at = slot.quants.map(isListQ).lastIndexOf(true);
    if (at < 0) throw new Error(`planShape: ${this.info.where}: thread over ${over}, which does not repeat`);
    if (slot.quants.slice(0, at).some(isListQ)) no(`a thread over a nested repetition (${over})`);
    const q = slot.quants[at]!;
    const body = q.type === 'sep' ? q.element : (q as { body: RuleExpr }).body;
    if (!this.marked.has(body)) this.marked.set(body, -2 - this.marked.size);
    this.root = [];
    const out = this.root;
    this.armScope = { info: this.info, base: [], lo: 'lo', hi: 'hi', vars: new Map(), arm: true, origin: 'b', hiOk: true, taken: new Set() };
    const acc = this.bindVal(call('inhVar', int(k)), out);
    out.push({ k: 'let', name: 'accS', ty: 'int', init: int(0) }, { k: 'let', name: 'accE', ty: 'int', init: int(0) });
    const it: CScope = { info: this.info, base: slot.quants.slice(0, at + 1), lo: 'lo', hi: 'hi', vars: new Map([[eq.acc, { val: acc, start: 'accS', end: 'accE' }]]), arm: false, origin: 'lo', hiOk: false, taken: new Set() };
    out.push({ k: 'return', es: [this.val(eq.next, it, out)] });
    return { q, body: out };
  }

  /** A statically known bool (a constant, the fixed attribute, and / or / not of them). */
  private staticBool(t: Term): boolean | undefined {
    switch (t.t) {
      case 'const': return typeof t.value === 'boolean' ? t.value : undefined;
      case 'inh': return this.fixed && this.fixed[0] === t.attr ? this.fixed[1] : undefined;
      case 'not': { const x = this.staticBool(t.arg); return x === undefined ? undefined : !x; }
      case 'and': case 'or': {
        const xs = t.args.map((a) => this.staticBool(a));
        if (t.t === 'and') return xs.includes(false) ? false : xs.every((x) => x === true) ? true : undefined;
        return xs.includes(true) ? true : xs.every((x) => x === false) ? false : undefined;
      }
      default: return undefined;
    }
  }
  private readsFixed(t: Term): boolean { if (!this.fixed) return false; let r = false; eachTerm(t, (x) => { if (x.t === 'inh' && x.attr === this.fixed![0]) r = true; }); return r; }
  /** A child slot's value: with its variant bits when its rule is a Pratt rule with variants (the
   * value this arm gives the child: its equation, else the default). */
  private childVal(idx: Expr, slot: Slot, out: Stmt[]): Expr {
    const vs = slot.rule ? this.cx.variants(slot.rule) : [];
    // A reader-applied top: under the value this arm gives the child (its equation, else the
    // default) = true, the read applies the slot's arm's top layer (slotValT).
    const ta = slot.rule ? this.cx.topAttr.get(slot.rule) : undefined;
    if (ta !== undefined) {
      const eq = this.eqs.get(ta)?.get(slot.name);
      if (eq?.t === 'thread') no(`a thread handing ${ta} to a Pratt rule's node`);
      const st = eq === undefined ? this.cx.scalarInh[this.cx.inhK.get(ta)!]!.dflt === true : this.staticBool(eq as Term);
      if (st === undefined) no(`a computed equation for the reader-applied ${ta}`);
      if (st) { const m = this.variantMask(vs, slot, out); return call('slotValT', idx, m); }
    }
    if (!vs.length) return call('slotVal', idx);
    const m = this.variantMask(vs, slot, out);
    return m.k === 'int' && m.v === 0 ? call('slotVal', idx) : call('slotValV', idx, m);
  }
  /** The variant bits this arm gives a child of a rule with variant attributes `vs`. */
  private variantMask(vs: string[], slot: Slot, out: Stmt[]): Expr {
    let mask = 0;
    const dyn: [number, Expr][] = [];
    vs.forEach((attr, j) => {
      const eq = this.eqs.get(attr)?.get(slot.name);
      if (eq?.t === 'thread') no(`a thread handing ${attr} to a Pratt rule's node`);
      const st = eq === undefined ? this.cx.scalarInh[this.cx.inhK.get(attr)!]!.dflt === true : this.staticBool(eq as Term);
      if (st === true) mask |= 1 << j;
      else if (st === undefined) dyn.push([j, this.bool(eq as Term, this.armScope, out)]);
    });
    if (!dyn.length) return int(mask);
    const m = this.bindInt(int(mask), out);
    for (const [j, c] of dyn) out.push({ k: 'if', c, then: [{ k: 'set', name: m, e: bin('add', v(m), int(1 << j)) }] });
    return v(m);
  }

  /** A child's value read as a child (vNeed), its rule noted: the check is dropped where that
   * rule can build no missing value (planShape's reachability pass). */
  private need(item: Expr, slot: Slot): Expr { const e: Expr = { k: 'vNeed', e: item }; this.cx.needRule.set(e, slot.rule); return e; }
  private bindVal(e: Expr, out: Stmt[]): string { const t = this.tmp(); out.push({ k: 'let', name: t, ty: VAL as never, init: e }); return t; }
  private bindInt(e: Expr, out: Stmt[], ty: 'int' | 'idx' = 'int'): string { const t = this.tmp(); out.push({ k: 'let', name: t, ty, init: e }); return t; }

  private resolve(s: CScope, name: string): { slot: Slot; rest: RuleExpr[]; scope: CScope } {
    const slot = s.info.slots.get(name);
    if (slot && startsWith(slot.quants, s.base)) return { slot, rest: slot.quants.slice(s.base.length), scope: s };
    if (!s.outer) throw new Error(`planShape: no child ${name}`);
    return this.resolve(s.outer, name);
  }
  private lookupVar(s: CScope, name: string): Bound | undefined { return s.vars.get(name) ?? (s.outer ? this.lookupVar(s.outer, name) : undefined); }
  /** The tag range of a slot's items (a branch: all its branches). */
  private range(slot: Slot): [number, number] {
    if (slot.kind === 'branch') {
      if (this.shape.grammar.templateViews.has(slot.node)) no('a template literal\'s parts');
      const rs = this.num.branchRange.get(slot.node)!;
      return [rs[0]![0], rs[rs.length - 1]![1]];
    }
    const t = this.num.tagOf.get(slot.node);
    if (t === undefined) throw new Error(`planShape: ${this.info.where}: child ${slot.name} has no tag`);
    return [t, t];
  }
  /** Where the arm's structure fixes the slot of `r` (FUSED: Pos), as an index expression, and
   * whether the item is there for sure in the reading scope; null: its position is dynamic. */
  private fixedAt(r: { slot: Slot; rest: RuleExpr[]; scope: CScope }, node: RuleExpr = r.slot.node): { idx: Expr; sure: boolean } | null {
    if (r.rest.some(isListQ)) return null;
    const p0 = this.pos.get(node);
    if (p0 !== undefined && r.scope.arm) return { idx: bin('add', v('b'), int(p0)), sure: true };
    const p = this.at?.pos.get(node);
    if (!p) return null;
    const sure = p.conds.every((c) => r.scope.taken.has(c));
    if (p.lo !== null) return { idx: p.lo === 0 ? v(r.scope.origin) : bin('add', v(r.scope.origin), int(p.lo)), sure };
    // From the end: the slot's last slot, so only for an item of one slot.
    if (p.hi !== null && r.scope.hiOk && this.at!.width(node) === 1) return { idx: bin('sub', v(r.scope.hi), int(p.hi + 1)), sure };
    return null;
  }
  /** The index of the first slot in lo..hi with a tag in t0..t1 (-1: none): at the fixed position
   * when there is one (a check of that one slot when the item may be absent), else a scan. */
  private find(r: { slot: Slot; rest: RuleExpr[]; scope: CScope }, out: Stmt[]): { idx: string; sure: boolean } {
    const f = this.fixedAt(r);
    if (f && f.sure) { this.reads.fixed++; return { idx: this.bindInt(f.idx, out), sure: true }; }
    const [t0, t1] = this.range(r.slot);
    if (f) { this.reads.checked++; return { idx: this.bindInt(call('slotAt', f.idx, v(r.scope.lo), v(r.scope.hi), int(t0), int(t1)), out), sure: false }; }
    this.reads.scan++;
    return { idx: this.bindInt(call('slotFind', v(r.scope.lo), v(r.scope.hi), int(t0), int(t1)), out), sure: false };
  }
  /** The index of the single item of `name` (-1: absent), as an int variable; `sure`: never -1. */
  private one(s: CScope, name: string, out: Stmt[]): { idx: string; slot: Slot; scope: CScope; sure: boolean } {
    const r = this.resolve(s, name);
    if (r.rest.some(isListQ)) no(`one item of the repeated child ${name}`);
    const f = this.find(r, out);
    return { idx: f.idx, slot: r.slot, scope: r.scope, sure: f.sure };
  }
  /** `then` when the item `o` is there, else `otherwise`; just `then` when it is there for sure. */
  private ifThere(o: { idx: string; sure: boolean }, then: (o: Stmt[]) => Expr, otherwise: (o: Stmt[]) => Expr, out: Stmt[]): Expr {
    if (o.sure) return then(out);
    return this.choose(bin('ge', v(o.idx), int(0)), then, otherwise, out);
  }
  /** Statements: `x = then` when cond, else `x = otherwise` (each compiled in its own branch). */
  private choose(cond: Expr, then: (o: Stmt[]) => Expr, otherwise: (o: Stmt[]) => Expr, out: Stmt[]): Expr {
    const x = this.tmp();
    out.push({ k: 'let', name: x, ty: VAL as never, init: { k: 'vAbsent' } });
    const a: Stmt[] = []; a.push({ k: 'set', name: x, e: then(a) });
    const b: Stmt[] = []; b.push({ k: 'set', name: x, e: otherwise(b) });
    out.push({ k: 'if', c: cond, then: a, else: b });
    return v(x);
  }
  private boolVal(c: Expr, out: Stmt[]): Expr { return this.choose(c, () => ({ k: 'vConst', v: true }), () => ({ k: 'vConst', v: false }), out); }

  private bool(t: Term, s: CScope, out: Stmt[]): Expr {
    const st = this.staticBool(t);
    if (st !== undefined) return { k: 'bool', v: st };
    switch (t.t) {
      case 'present': return this.present(s, t.name, out);
      case 'not': return { k: 'not', e: this.bool(t.arg, s, out) };
      case 'and': case 'or': {
        const x = this.tmp();
        out.push({ k: 'let', name: x, ty: 'bool', init: { k: 'bool', v: t.t === 'and' } });
        // Short-circuit: each later argument only while the result is still undecided.
        let level = out;
        for (const a of t.args) {
          if (this.staticBool(a) === (t.t === 'and')) continue;   // decides nothing
          const inner: Stmt[] = [];
          inner.push({ k: 'set', name: x, e: this.bool(a, s, inner) });
          level.push({ k: 'if', c: t.t === 'and' ? v(x) : { k: 'not', e: v(x) }, then: inner });
          level = inner;
        }
        return v(x);
      }
      default: return { k: 'vIs', e: this.val(t, s, out), v: true };
    }
  }
  private present(s: CScope, name: string, out: Stmt[]): Expr {
    if (this.lookupVar(s, name)) no('present of a nodes variable');
    const r = this.resolve(s, name);
    const f = this.find(r, out);
    return f.sure ? { k: 'bool', v: true } : bin('ge', v(f.idx), int(0));
  }
  private text(idx: string, slot: Slot, scope: CScope, out: Stmt[]): Expr & { k: 'call' } {
    if (slot.kind === 'branch') {
      // The alternation's last slot: fixed when it ends at a fixed offset from the arm's end.
      const p = this.at?.pos.get(slot.node);
      if (p && p.hi !== null && scope.hiOk && !slot.quants.slice(scope.base.length).some(isListQ)) {
        this.reads.fixed++;
        return call('srcText', call('slotOff', v(idx)), call('slotEnd', bin('sub', v(scope.hi), int(p.hi + 1))));
      }
      const [t0, t1] = this.range(slot);
      this.reads.scan++;
      const last = this.bindInt(call('slotFindLast', v(idx), v(scope.hi), int(t0), int(t1)), out);
      return call('srcText', call('slotOff', v(idx)), call('slotEnd', v(last)));
    }
    return call('srcText', call('slotOff', v(idx)), call('slotEnd', v(idx)));
  }
  private spanEdge(s: CScope, name: string, edge: 'start' | 'end', out: Stmt[]): Expr {
    const b = this.lookupVar(s, name);
    if (b) return v(edge === 'start' ? b.start : b.end);
    const r = this.resolve(s, name);
    const f = this.fixedAt(r);
    if (f && f.sure && r.slot.kind !== 'branch') { this.reads.fixed++; return call(edge === 'start' ? 'slotOff' : 'slotEnd', f.idx); }
    const [t0, t1] = this.range(r.slot);
    this.reads.scan++;
    const i = this.bindInt(call(edge === 'start' ? 'slotFind' : 'slotFindLast', v(r.scope.lo), v(r.scope.hi), int(t0), int(t1)), out);
    return call(edge === 'start' ? 'slotOff' : 'slotEnd', v(i));
  }
  /** The iterations of the repetition holding `over`: a loop over its markers. */
  private iterations(s: CScope, over: string, out: Stmt[], each: (it: CScope, body: Stmt[]) => void): void {
    const r = this.resolve(s, over);
    const at = r.rest.map(isListQ).lastIndexOf(true);
    // Optionals around the repetition are fine: absent, it has no iteration (no marker).
    if (at < 0 || r.rest.slice(0, at).some(isListQ)) no(at < 0 ? `iterations of ${over}, which repeats in no list` : `iterations of a nested repetition (${over})`);
    const q = r.rest[at]!;
    const body = q.type === 'sep' ? q.element : (q as { body: RuleExpr }).body;
    if (!this.marked.has(body)) this.marked.set(body, -2 - this.marked.size);
    const mt = this.marked.get(body)!;
    const m = this.tmp(), nx = this.tmp(), ih = this.tmp();
    // The first marker: at the repetition's fixed position when it has one (absent: no iteration);
    // the next: past one iteration's slots when the body leaves a fixed number (and a separated
    // list's delimiter), else a scan of the iteration's slots.
    const f = this.fixedAt({ slot: r.slot, rest: r.rest.slice(0, at), scope: r.scope }, q);
    if (f) this.reads.checked++; else this.reads.scan++;
    out.push({ k: 'let', name: m, ty: 'int', init: f ? call('slotAt', f.idx, v(r.scope.lo), v(r.scope.hi), int(mt), int(mt)) : call('slotFind', v(r.scope.lo), v(r.scope.hi), int(mt), int(mt)) });
    const w = this.at?.width(body) ?? null;
    if (w !== null) this.reads.checked++; else this.reads.scan++;
    const loop: Stmt[] = [
      { k: 'let', name: nx, ty: 'int', init: w !== null ? call('slotAt', bin('add', v(m), int(1 + w + (q.type === 'sep' ? 1 : 0))), v(r.scope.lo), v(r.scope.hi), int(mt), int(mt)) : call('slotFind', bin('add', v(m), int(1)), v(r.scope.hi), int(mt), int(mt)) },
      { k: 'let', name: ih, ty: 'idx', init: v(r.scope.hi) },
      { k: 'if', c: bin('ge', v(nx), int(0)), then: [{ k: 'set', name: ih, e: v(nx) }] },
    ];
    const lo = this.tmp();
    loop.push({ k: 'let', name: lo, ty: 'idx', init: bin('add', v(m), int(1)) });
    each({ info: r.scope.info, base: [...r.scope.base, ...r.rest.slice(0, at + 1)], lo, hi: ih, outer: s, vars: new Map(), arm: false, origin: lo, hiOk: false, taken: new Set() }, loop);
    loop.push({ k: 'set', name: m, e: v(nx) });
    out.push({ k: 'while', c: bin('ge', v(m), int(0)), body: loop });
  }

  val(t: Term, s: CScope, out: Stmt[]): Expr {
    // Variants: a term that does not read the fixed attribute, at the arm's top level, is
    // computed once for both (its value is visible to everything compiled after it).
    const top = this.cache !== null && out === this.root && s === this.armScope && t.t !== 'const' && t.t !== 'absent' && t.t !== 'var';
    if (top && !this.readsFixed(t)) {
      const hit = this.cache!.get(t);
      if (hit) return hit;
      const x = v(this.bindVal(this.val1(t, s, out), out));
      this.cache!.set(t, x);
      return x;
    }
    return this.val1(t, s, out);
  }
  private val1(t: Term, s: CScope, out: Stmt[]): Expr {
    switch (t.t) {
      case 'const': return { k: 'vConst', v: t.value };
      case 'absent': return { k: 'vAbsent' };
      case 'inh': {
        if (this.fixed && this.fixed[0] === t.attr) return { k: 'vConst', v: this.fixed[1] };
        if (this.cx.nodesAttrs.has(t.attr)) return no(`the nodes attribute ${t.attr}`);
        const k = this.cx.inhK.get(t.attr);
        if (k === undefined) throw new Error(`planShape: no inherited attribute ${t.attr}`);
        if (this.cx.variants(this.info.rule).includes(t.attr)) throw new Error(`planShape: ${this.info.where}: inh(${t.attr}) outside its variants`);
        return call('inhVar', int(k));
      }
      case 'syn': {
        const k = this.cx.synK.get(t.attr);
        if (k === undefined) throw new Error(`planShape: no synthesized attribute ${t.attr}`);
        // The node's own: computed only by an arm with an equation; any other has the default.
        if (t.name === undefined) return this.ownSyn.has(k) ? call('selfSyn', int(k)) : { k: 'vConst', v: (this.cx.synDflt[k] ?? null) as Scalar };
        const o = this.one(s, t.name, out);
        this.cx.synSlotRead.add(k);
        return this.ifThere(o, () => call('slotSyn', int(k), v(o.idx)), () => ({ k: 'vAbsent' }), out);
      }
      case 'get': {
        const o = this.one(s, t.name, out);
        const item = this.childVal(v(o.idx), o.slot, out);
        return this.ifThere(o, () => call('recGet', this.need(item, o.slot), { k: 'str', v: t.field }), () => ({ k: 'vAbsent' }), out);
      }
      case 'dropLastIf': {
        const l = this.bindVal(this.val(t.list, s, out), out);
        return call('vDropLast', v(l), this.bool(t.cond, s, out));
      }
      case 'child': {
        const r = this.resolve(s, t.name);
        if (r.slot.kind !== 'node') throw new Error(`planShape: ${this.info.where}: child ${t.name} is a ${r.slot.kind}`);
        if (cardOf(r.rest) === 'many') {
          // A list: every item, in order. An optional inside the repetition would leave holes the
          // tags cannot show (S1: no array holes).
          // An optional inside the repetition: one element per iteration, null where it is absent.
          const lastList = r.rest.map(isListQ).lastIndexOf(true);
          if (r.rest.slice(lastList + 1).some((q) => q.type === 'quantifier' && q.kind === '?')) return this.holes(s, t.name, out);
          const [t0] = this.range(r.slot);
          this.reads.list++;
          const l = this.tmp(), i = this.tmp();
          out.push({ k: 'let', name: l, ty: VALS as never, init: { k: 'newList', ty: VALS as never } });
          out.push({ k: 'let', name: i, ty: 'idx', init: v(r.scope.lo) });
          const item = this.childVal(v(i), r.slot, out);
          out.push({ k: 'while', c: bin('lt', v(i), v(r.scope.hi)), body: [
            { k: 'if', c: bin('eq', call('slotTag', v(i)), int(t0)), then: [{ k: 'push', list: l, e: this.need(item, r.slot) }] },
            { k: 'set', name: i, e: bin('add', v(i), int(1)) },
          ] });
          return { k: 'vList', e: v(l) };
        }
        const o = this.one(s, t.name, out);
        const item = this.childVal(v(o.idx), o.slot, out);
        return this.ifThere(o, () => (this.need(item, o.slot)), () => ({ k: 'vAbsent' }), out);
      }
      case 'text': {
        if (t.name === undefined) return call('textSpan', v('off'), v('end'));
        const o = this.one(s, t.name, out);
        return this.ifThere(o, (b) => call('textSpan', ...this.text(o.idx, o.slot, o.scope, b).args), () => ({ k: 'vAbsent' }), out);
      }
      case 'cook': {
        this.cooks.add(t.fn);
        const o = this.one(s, t.name, out);
        // An IdentifierName of one token: its span, unless a token of its kind has an escape
        // somewhere in the source (the runtime's once-per-parse fact; cookIdentSpan).
        const tok = o.slot.kind === 'leaf' && o.slot.node.type === 'ref' && this.shape.grammar.tokens.has(o.slot.node.name) ? o.slot.node.name : null;
        if (t.fn === 'identifierName' && tok !== null) {
          this.cx.identCook.add(tok);
          return this.ifThere(o, (b) => call('cookIdentSpan', ...this.text(o.idx, o.slot, o.scope, b).args), () => ({ k: 'vAbsent' }), out);
        }
        return this.ifThere(o, (b) => call(`cook_${t.fn}`, this.text(o.idx, o.slot, o.scope, b)), () => ({ k: 'vAbsent' }), out);
      }
      case 'present': case 'and': case 'or': case 'not': return this.boolVal(this.bool(t, s, out), out);
      case 'armOf': {
        const o = this.one(s, t.name, out);
        if (o.slot.kind === 'branch') return this.branchCase(o.slot, o.scope, out, (_bn, name) => ({ k: 'vConst', v: name }), () => ({ k: 'vAbsent' }));
        return this.ifThere(o, () => call('slotArmName', v(o.idx)), () => ({ k: 'vAbsent' }), out);
      }
      case 'node': {
        const kind = t.type.t === 'const' ? this.val(t.type, s, out) : v(this.bindVal(this.val(t.type, s, out), out));
        const fields = Object.entries(t.fields).map(([name, x]) => ({ name, e: v(this.bindVal(this.val(x, s, out), out)) }));
        let start: Expr = v('off'), end: Expr = v('end');
        const sp = t.span;
        if (sp && 'inside' in sp) no('an `inside` span (template parts)');
        else if (sp && 'after' in sp) { start = end = v(this.bindInt(this.spanEdge(s, sp.after, 'end', out), out)); }
        else if (sp) { start = v(this.bindInt(this.spanEdge(s, sp.from, 'start', out), out)); end = v(this.bindInt(this.spanEdge(s, sp.to, 'end', out), out)); }
        return { k: 'mkNode', kind, kinds: kindsOf(t.type) ?? [], fields, start, end };
      }
      case 'record': return { k: 'mkRecord', fields: Object.entries(t.fields).map(([name, x]) => ({ name, e: v(this.bindVal(this.val(x, s, out), out)) })) };
      case 'list': {
        const l = this.tmp();
        out.push({ k: 'let', name: l, ty: VALS as never, init: { k: 'newList', ty: VALS as never } });
        for (const x of t.items) {
          if ('spread' in x) {
            const sv = this.bindVal(this.val(x.spread, s, out), out), e = this.tmp();
            out.push({ k: 'forEach', v: e, list: { k: 'vItems', e: v(sv) }, body: [{ k: 'push', list: l, e: v(e) }] });
          } else {
            const e = this.bindVal(this.val(x, s, out), out);
            out.push({ k: 'if', c: { k: 'not', e: { k: 'vPresent', e: v(e) } }, then: [{ k: 'set', name: e, e: { k: 'vConst', v: null } }] });
            out.push({ k: 'push', list: l, e: v(e) });
          }
        }
        return { k: 'vList', e: v(l) };
      }
      case 'match': {
        const on = this.bindVal(this.val(t.on, s, out), out);
        const x = this.tmp();
        out.push({ k: 'let', name: x, ty: VAL as never, init: { k: 'vAbsent' } });
        const arm = (c: Term): Stmt[] => { const b: Stmt[] = []; b.push({ k: 'set', name: x, e: this.val(c, s, b) }); return b; };
        const dflt: Stmt[] = t.else !== undefined ? arm(t.else) : [{ k: 'set', name: x, e: { k: 'vNeed', e: { k: 'vMissing', where: `${this.info.where}: match has no case`, why: 'unsupported' } } }];
        out.push({ k: 'switch', on: v(on), cases: Object.entries(t.cases).map(([key, c]) => ({ v: key, body: arm(c) })), else: dflt });
        return v(x);
      }
      case 'if': {
        const st = this.staticBool(t.cond);
        if (st !== undefined) return this.val(st ? t.then : t.else, s, out);
        return this.choose(this.bool(t.cond, s, out), (b) => this.val(t.then, s, b), (b) => this.val(t.else, s, b), out);
      }
      case 'orElse': {
        const x = this.bindVal(this.val(t.of, s, out), out);
        const b: Stmt[] = []; b.push({ k: 'set', name: x, e: this.val(t.else, s, b) });
        out.push({ k: 'if', c: { k: 'not', e: { k: 'vPresent', e: v(x) } }, then: b });
        return v(x);
      }
      case 'branch': {
        const o = this.resolve(s, t.name);
        if (o.rest.some(isListQ)) no(`a branch of a repeated alternation (${t.name})`);
        return this.branchCase(o.slot, o.scope, out, (bn, name, b) => {
          const c = t.cases[name];
          if (c === undefined) return { k: 'vNeed', e: { k: 'vMissing', where: `${s.info.where}: ${t.name}.${name}`, why: 'unmapped' } };
          const bi = this.shape.grammar.branchScopes.get(o.slot.node)!.indexOf(o.slot.branches!.get(name)!);
          const taken = new Set([...o.scope.taken, (o.slot.node as { items: RuleExpr[] }).items[bi]!]);
          return this.val(c, { info: o.slot.branches!.get(name)!, base: [], lo: o.scope.lo, hi: o.scope.hi, outer: s, vars: new Map(), arm: false, origin: o.scope.origin, hiOk: o.scope.hiOk, taken }, b);
        }, () => ({ k: 'vAbsent' }));
      }
      case 'map': case 'fold': {
        if (t.t === 'map') {
          const l = this.tmp();
          out.push({ k: 'let', name: l, ty: VALS as never, init: { k: 'newList', ty: VALS as never } });
          this.iterations(s, t.over, out, (it, body) => {
            const e = this.bindVal(this.val(t.body, it, body), body);
            body.push({ k: 'if', c: { k: 'not', e: { k: 'vPresent', e: v(e) } }, then: [{ k: 'set', name: e, e: { k: 'vConst', v: null } }] });
            body.push({ k: 'push', list: l, e: v(e) });
          });
          return { k: 'vList', e: v(l) };
        }
        const init = this.bindVal(this.val(t.init, s, out), out);
        const acc: Bound = { val: init, start: this.tmp(), end: this.tmp() };
        if (t.init.t === 'child') {
          out.push({ k: 'let', name: acc.start, ty: 'int', init: this.spanEdge(s, t.init.name, 'start', out) });
          out.push({ k: 'let', name: acc.end, ty: 'int', init: this.spanEdge(s, t.init.name, 'end', out) });
        } else {
          out.push({ k: 'let', name: acc.start, ty: 'int', init: call('valStart', v(init), v('off')) });
          out.push({ k: 'let', name: acc.end, ty: 'int', init: call('valEnd', v(init), v('end')) });
        }
        this.iterations(s, t.over, out, (it, body) => {
          it.vars.set(t.acc, acc);
          const nv = this.val(t.body, it, body);
          this.reads.list++;
          const fe = this.bindInt(call('namedEnd', v(it.lo), v(it.hi)), body);
          body.push({ k: 'set', name: init, e: nv });
          body.push({ k: 'if', c: bin('gt', v(fe), v(acc.end)), then: [{ k: 'set', name: acc.end, e: v(fe) }] });
        });
        return v(init);
      }
      case 'let': {
        const x = this.bindVal(this.val(t.value, s, out), out);
        // Its span only where the body reads it (a span endpoint naming it).
        let spanRead = false;
        eachTerm(t.body, (y) => { const sp = y.t === 'node' ? y.span as Record<string, unknown> | undefined : undefined; if (sp && Object.values(sp).includes(t.name)) spanRead = true; });
        const st = spanRead ? this.bindInt(call('valStart', v(x), v('off')), out) : 'off', en = spanRead ? this.bindInt(call('valEnd', v(x), v('end')), out) : 'end';
        return this.val(t.body, { ...s, vars: new Map([...s.vars, [t.name, { val: x, start: st, end: en }]]) }, out);
      }
      case 'var': {
        const b = this.lookupVar(s, t.name);
        if (!b) throw new Error(`planShape: var ${t.name} unbound`);
        return v(b.val);
      }
    }
  }

  /** A repeated child whose element is optional in its iteration: per iteration (its markers) the
   * element's value, or null. */
  private holes(s: CScope, name: string, out: Stmt[]): Expr {
    const l = this.tmp();
    out.push({ k: 'let', name: l, ty: VALS as never, init: { k: 'newList', ty: VALS as never } });
    this.iterations(s, name, out, (it, body) => {
      const r = this.resolve(it, name);
      if (r.rest.some(isListQ)) no(`a repeated child with holes inside a nested repetition (${name})`);
      const o = this.find(r, body);
      const item = this.childVal(v(o.idx), r.slot, body);
      const e = this.ifThere(o, () => (this.need(item, r.slot)), () => ({ k: 'vConst', v: null }), body);
      body.push({ k: 'push', list: l, e });
    });
    return { k: 'vList', e: v(l) };
  }

  /** Which branch of an inline alternation its items fall in: `taken` for that branch, `none`
   * when the alternation matched nothing here (an optional one). A branch with no grammar node at
   * all (`not('?.')`) has no item to show it: it is the branch taken when no other branch's item
   * is there, if the alternation is always entered in this scope (no quantifier between them) and
   * it is the only such branch; else unsupported. */
  private branchCase(slot: Slot, scope: CScope, out: Stmt[], taken: (b: number, name: string, body: Stmt[]) => Expr, none: () => Expr): Expr {
    if (this.shape.grammar.templateViews.has(slot.node)) no('a template literal\'s parts');
    const rs = this.num.branchRange.get(slot.node)!;
    const names = [...slot.branches!.keys()];
    const empty = rs.map(([t0, t1], b) => (t0 > t1 ? b : -1)).filter((b) => b >= 0);
    if (empty.length && (empty.length > 1 || slot.quants.length > scope.base.length)) no(`an alternation with an empty branch (${slot.name})`);
    const x = this.tmp();
    out.push({ k: 'let', name: x, ty: VAL as never, init: none() });
    let level = out;
    // At a fixed position, the alternation's first slot's tag says the branch (a check of that one
    // slot per branch); else each branch's items are searched for.
    // A branch that can begin with a repetition may have its iteration MARKER (not one of its tags)
    // in that first slot (a repetition is marked when some plan iterates it, which can be decided
    // after this one is compiled): then the branch is searched for (tsc's heritage `elements`).
    const startsMarked = (e: RuleExpr): boolean => {
      switch (e.type) {
        case 'group': return startsMarked(e.body);
        case 'seq': { const x = e.items.find((y) => !ZERO_WIDTH.has(y.type)); return x !== undefined && startsMarked(x); }
        case 'quantifier': return e.kind !== '?' || startsMarked(e.body);
        case 'sep': return true;
        case 'alt': return e.items.some(startsMarked);
        default: return false;
      }
    };
    const f = (slot.node as Extract<RuleExpr, { type: 'alt' }>).items.some(startsMarked) ? null : this.fixedAt({ slot, rest: slot.quants.slice(scope.base.length), scope });
    rs.forEach(([t0, t1], b) => {
      if (b === empty[0]) return;
      if (f) this.reads.checked++; else this.reads.scan++;
      const c = bin('ge', v(this.bindInt(f ? call('slotAt', f.idx, v(scope.lo), v(scope.hi), int(t0), int(t1)) : call('slotFind', v(scope.lo), v(scope.hi), int(t0), int(t1)), level)), int(0));
      const then: Stmt[] = []; then.push({ k: 'set', name: x, e: taken(b, names[b]!, then) });
      const els: Stmt[] = [];
      level.push({ k: 'if', c, then, else: els });
      level = els;
    });
    if (empty.length) level.push({ k: 'set', name: x, e: taken(empty[0]!, names[empty[0]!]!, level) });
    return v(x);
  }
}
