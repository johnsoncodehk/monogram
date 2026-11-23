// ─────────────────────────────────────────────────────────────────────────────
//  arm-graph.ts — which items of a grammar may stand next to each other, as a graph.
//
//  The highlighter detectors ask questions about ADJACENCY: "is a token ever directly followed by
//  `=>`", "a ref, `?`, a ref, `:`, a ref, in a row". They used to answer them by enumerating every
//  ARM of a body (`expandArms`, src/region-view.ts: an `alt` / `?` / `*` / `group` expanded, every
//  other node an item of the arm) and scanning each arm: the full cross product of a body's options
//  (TypeScript: 6.7 million arms). This is the same question asked once over the structure.
//
//  The graph is the Glushkov construction of each ROOT's arm language: a position per ITEM
//  occurrence (what an arm holds: a literal, ref, sep, op / prefix / postfix, sameLine and the other
//  zero-width assertions except `not`, which an arm sees through), `first` / `last` per root and
//  `follow` per position. Its language is exactly expandArms': an arm is a word over the positions;
//  `*` and `+` contribute their body ONCE (an arm does not repeat), `?` and `*` may be absent, a
//  `not` contributes nothing. Every position of a Glushkov automaton lies on an accepted word, so a
//  path p0 -> p1 -> … -> pk in `follow` is exactly a window of k+1 consecutive items of some arm.
//
//  Roots: every rule body (kind 'rule'), and every `sep` element reached from one through
//  seq / alt / quantifier / group / sep (kind 'sep': expandArms keeps a sep as one item, so the
//  detectors that recurse into a sep's element see its arms as arms of their own).
// ─────────────────────────────────────────────────────────────────────────────
import type { CstGrammar, RuleExpr } from './types.ts';

export interface ArmGraph {
  /** Per position: the item it stands for (an expandArms arm holds these same objects). */
  node: RuleExpr[];
  /** Per position: the root whose arms hold it. */
  root: number[];
  /** Per position: the positions that may come next in an arm of its root. */
  follow: number[][];
  /** Per position: whether an arm of its root may end with it. */
  isLast: boolean[];
  /** Per root: the positions that may begin one of its arms, and whether it has an empty arm. */
  first: number[][];
  nullable: boolean[];
  /** Per root: its expression, 'rule' (a rule body) or 'sep' (a sep element), and the index in
   *  grammar.rules of the rule whose body holds it. Roots are in the order a detector that walks
   *  each rule body and then recurses meets them: rule by rule, each followed by the sep elements
   *  within it, depth first. */
  body: RuleExpr[];
  /** Per root: its first position (a root's positions are consecutive). */
  rootFrom: number[];
  rootKind: ('rule' | 'sep')[];
  ruleIndex: number[];
}

const graphs = new WeakMap<CstGrammar, ArmGraph>();

/** The arm graph of a grammar, built once per grammar. */
export function armGraph(grammar: CstGrammar): ArmGraph {
  const hit = graphs.get(grammar);
  if (hit) return hit;
  const node: RuleExpr[] = [], root: number[] = [], follow: number[][] = [], isLast: boolean[] = [];
  const first: number[][] = [], nullable: boolean[] = [], body: RuleExpr[] = [], rootFrom: number[] = [], rootKind: ('rule' | 'sep')[] = [], ruleIndex: number[] = [];
  type G = { first: number[]; last: number[]; nullable: boolean };
  const EMPTY: G = { first: [], last: [], nullable: true };
  let cur = 0, seps: RuleExpr[] = [];
  const link = (from: number[], to: number[]) => { for (const f of from) for (const t of to) follow[f].push(t); };
  const build = (e: RuleExpr): G => {
    switch (e.type) {
      case 'seq': return e.items.map(build).reduce((a, b) => {
        link(a.last, b.first);
        return { first: a.nullable ? [...a.first, ...b.first] : a.first, last: b.nullable ? [...a.last, ...b.last] : b.last, nullable: a.nullable && b.nullable };
      }, EMPTY);
      case 'alt': { const gs = e.items.map(build); return { first: gs.flatMap(g => g.first), last: gs.flatMap(g => g.last), nullable: gs.some(g => g.nullable) }; }
      case 'group': return build(e.body);
      case 'quantifier': { const g = build(e.body); return e.kind === '+' ? g : { ...g, nullable: true }; }
      case 'not': return EMPTY;
      default: {
        if (e.type === 'sep') seps.push(e.element);
        const id = node.length;
        node.push(e); root.push(cur); follow.push([]); isLast.push(false);
        return { first: [id], last: [id], nullable: false };
      }
    }
  };
  const addRoot = (e: RuleExpr, kind: 'rule' | 'sep', rule: number): void => {
    const r = cur = body.length;
    body.push(e); rootFrom.push(node.length); rootKind.push(kind); ruleIndex.push(rule);
    seps = [];
    const g = build(e);
    for (const l of g.last) isLast[l] = true;
    first[r] = g.first; nullable[r] = g.nullable;
    for (const el of seps) addRoot(el, 'sep', rule);
  };
  grammar.rules.forEach((r, i) => addRoot(r.body, 'rule', i));
  const out: ArmGraph = { node, root, follow, isLast, first, nullable, body, rootFrom, rootKind, ruleIndex };
  graphs.set(grammar, out);
  return out;
}

/** Whether some arm (of a root `roots` admits) holds `steps.length` consecutive items, the i-th
 *  satisfying steps[i]. */
export function hasWindow(g: ArmGraph, steps: ((e: RuleExpr) => boolean)[], roots: (root: number) => boolean = () => true): boolean {
  return findWindows(g, steps, roots, true).length > 0;
}

/** The windows (position paths) of `steps.length` consecutive items matching `steps`, in position
 *  order of their first item; `firstOnly` stops at the first. */
export function findWindows(g: ArmGraph, steps: ((e: RuleExpr) => boolean)[], roots: (root: number) => boolean = () => true, firstOnly = false): number[][] {
  const out: number[][] = [];
  const extend = (path: number[]): boolean => {
    if (path.length === steps.length) { out.push(path); return firstOnly; }
    for (const n of g.follow[path[path.length - 1]]) if (steps[path.length](g.node[n]) && extend([...path, n])) return true;
    return false;
  };
  for (let p = 0; p < g.node.length; p++) {
    if (!roots(g.root[p]) || !steps[0](g.node[p])) continue;
    if (extend([p])) break;
  }
  return out;
}

/** Whether a position matching `target` is reachable from position `from` through positions that
 *  all match `through` (none of them, when `target` follows `from` directly). */
export function reachesThrough(g: ArmGraph, from: number, through: (e: RuleExpr) => boolean, target: (e: RuleExpr) => boolean): boolean {
  return reachable(g, from, through, target, true).length > 0;
}

/** The positions matching `target` reachable from `from` through positions matching `through`, in
 *  position order (`firstOnly`: stop at the first found). */
export function reachable(g: ArmGraph, from: number, through: (e: RuleExpr) => boolean, target: (e: RuleExpr) => boolean, firstOnly = false): number[] {
  const out = new Set<number>(), seen = new Set<number>();
  const stack = [from];
  while (stack.length) {
    for (const n of g.follow[stack.pop()!]) {
      if (target(g.node[n])) { out.add(n); if (firstOnly) return [n]; }
      if (through(g.node[n]) && !seen.has(n)) { seen.add(n); stack.push(n); }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Items in the order a scan of the expanded arms first meets them: each candidate is a value with
 *  the window (and gaps) where it was met; a value met several times takes its earliest. */
export function inArmOrder<T>(g: ArmGraph, met: { value: T; window: number[]; gapFree?: boolean[]; atStart?: boolean }[]): T[] {
  const best = new Map<T, number[]>();
  for (const m of met) {
    const key = armOrderKey(g, m.window, m.gapFree, m.atStart);
    const cur = best.get(m.value);
    if (!cur || compareArmOrder(key, cur) < 0) best.set(m.value, key);
  }
  return [...best].sort((a, b) => compareArmOrder(a[1], b[1])).map(([v]) => v);
}

/** The ARM ORDER of a window: the choices of the first arm (in expandArms' order) of its root that
 *  holds the window's positions consecutively, as a vector compared lexicographically (root first).
 *  expandArms orders the arms of a seq by its earlier items first, an alt's by alternative, a `?` /
 *  `*` absent before present; a window's first arm takes, at every choice, the earliest option
 *  that keeps its positions present and the positions between them absent. Sorting windows by this
 *  key puts them in the order a scan of the expanded arms first meets them. `gapFree[i]` lets other
 *  items stand between window[i] and window[i + 1] (a pattern `a … b` rather than `a b`); `atStart`
 *  asks for an arm that BEGINS with the window. */
export function armOrderKey(g: ArmGraph, window: number[], gapFree: boolean[] = [], atStart = false): number[] {
  const r = g.root[window[0]];
  const on = new Set(window);
  const lo = window[0];
  // Whether a position lies strictly inside a gap that must hold nothing.
  const between = (id: number) => (atStart && id < lo) || window.some((w, i) => i + 1 < window.length && !gapFree[i] && id > w && id < window[i + 1]);
  // A root's positions are numbered consecutively in the build's traversal order, so walking the
  // root in that order numbers each leaf again.
  let next = g.rootFrom[r];
  type V = number[] | null;
  const walk = (e: RuleExpr): { v: V; from: number; to: number } => {
    const from = next;
    const v = go(e);
    return { v, from, to: next };
  };
  // Whether a range of positions [from, to) holds a window position.
  const holds = (from: number, to: number) => window.some(p => p >= from && p < to);
  const go = (e: RuleExpr): V => {
    switch (e.type) {
      case 'seq': {
        const out: number[] = []; let ok = true;
        for (const it of e.items) { const { v } = walk(it); if (!v) ok = false; else out.push(...v); }
        return ok ? out : null;
      }
      case 'alt': {
        const parts = e.items.map(walk);
        const from = parts[0]?.from ?? next, to = next;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          // The window's positions inside this alt must all be in the alternative taken.
          if (p.v && window.every(w => w < from || w >= to || (w >= p.from && w < p.to))) return [i, ...p.v];
        }
        return null;
      }
      case 'group': return go(e.body);
      case 'quantifier': {
        const p = walk(e.body);
        if (e.kind === '+') return p.v;
        if (!holds(p.from, p.to)) return [0];
        return p.v ? [1, ...p.v] : null;
      }
      case 'not': return [];
      default: {
        const id = next++;
        return on.has(id) || !between(id) ? [] : null;
      }
    }
  };
  const v = go(g.body[r]);
  if (!v) throw new Error(`arm-graph: window ${window.join(' ')} is in no arm of its root`);
  return [r, ...v, lo];
}

/** Compare two arm-order keys. */
export function compareArmOrder(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Windows sorted into the order a scan of the expanded arms meets them. */
export function sortInArmOrder(g: ArmGraph, windows: number[][]): number[][] {
  return windows.map(w => ({ w, key: armOrderKey(g, w) })).sort((a, b) => compareArmOrder(a.key, b.key)).map(({ w }) => w);
}
