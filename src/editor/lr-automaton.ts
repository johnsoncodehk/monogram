// ─────────────────────────────────────────────────────────────────────────────
//  lr-automaton.ts — the LR(0) automaton of a grammar given as Glushkov positions, with LALR(1)
//  lookaheads.
//
//  A generator that targets an LR parser generator (tree-sitter) has to know which terminals that
//  parser can see in one state: a word the parser may lex as a keyword there, a zero-width token its
//  external scanner may return there. The question is answered once, here, over the grammar as the
//  generator renders it: the caller lowers its rules to LEAVES (every literal / token / rule
//  reference of a body is one position: `follow` lists the leaves that may come next in the same
//  rule, `isLast` the ones that may end it, `first` per rule the ones that may start it).
//
//  An item is "after leaf L" or "the start of rule R"; a state is the closure of a kernel of items.
//  The lookaheads are LALR(1): propagated over the kernel items (a closure item `start of B`, added
//  by an item I whose next leaf L references B, gets the terminals that may follow L in I's rule,
//  and I's own lookaheads when I's rule may end after L; a goto carries an item's lookaheads to the
//  advanced item). Every LR(1) state of the same grammar has the core of one of these states and a
//  subset of its lookaheads, so "valid in a state" here is a superset of what an LR(1) parser
//  generator's state holds — the direction a caller needs to stay sound.
// ─────────────────────────────────────────────────────────────────────────────

export interface LeafGraph {
  /** Per leaf: its symbol (a terminal name, or the name of the rule it references). */
  sym: string[];
  /** Per leaf: the index of the rule it references, or -1 for a terminal. */
  nt: number[];
  /** Per leaf: the index of the rule whose body holds it. */
  rule: number[];
  /** Per leaf: the leaves that may come next in the same rule body. */
  follow: number[][];
  /** Per leaf: whether its rule body may end after it. */
  isLast: boolean[];
  /** Per rule: the leaves that may start its body, and whether the body may be empty. */
  first: number[][];
  nullable: boolean[];
  /** The start rule; its lookahead is END. */
  entry: number;
}

/** The end-of-input terminal. */
export const END = '$end';

export interface LrOptions {
  /** Further terminals that also shift a terminal leaf (a keyword the grammar reads as the word
   *  token there): the leaf is advanced by each of them too, and each is valid where it is. */
  alsoShifts?: (leaf: number) => Iterable<string>;
  /** A terminal the lexer returns before the ones listed (a zero-width token its scanner returns
   *  wherever it is valid and one of them comes next): a state that shifts it shifts none of them. */
  preempts?: ReadonlyMap<string, readonly string[]>;
}

export interface LrState {
  /** The closure: kernel items first. An item is a leaf id (after it) or -1 - rule (its start). */
  items: number[];
  /** The leaves the state shifts (terminals and rule references alike). */
  next: number[];
  /** Successor per symbol. */
  goto: Map<string, number>;
}

export interface LrAnalysis {
  states: LrState[];
  /** The terminals, indexed as in the bit sets. */
  terminals: string[];
  terminalId: Map<string, number>;
  /** The terminals valid in a state: shifted there, or the lookahead of an item it completes. */
  valid(state: number): Set<string>;
  /** The terminals valid in a state through reductions only (lookaheads of completed items). */
  lookahead(state: number): Set<string>;
  /** The LALR(1) lookahead of each item of a state's closure (in `items` order): the terminals that
   *  may follow its rule there. */
  itemLookaheads(state: number): Set<string>[];
}

export function buildLr(g: LeafGraph, opts: LrOptions = {}): LrAnalysis {
  const also = (l: number): Iterable<string> => opts.alsoShifts?.(l) ?? [];
  const nextOf = (it: number) => it < 0 ? g.first[-1 - it] : g.follow[it];
  const complete = (it: number) => it < 0 ? g.nullable[-1 - it] : g.isLast[it];

  // ── terminals ──
  const terminals: string[] = [END];
  const terminalId = new Map<string, number>([[END, 0]]);
  const tid = (t: string) => { let i = terminalId.get(t); if (i === undefined) { i = terminals.length; terminals.push(t); terminalId.set(t, i); } return i; };
  for (let l = 0; l < g.sym.length; l++) if (g.nt[l] < 0) { tid(g.sym[l]); for (const t of also(l)) tid(t); }
  const W = Math.ceil(terminals.length / 32);
  const setBit = (into: Uint32Array, at: number, b: number) => { into[at + (b >> 5)] |= 1 << (b & 31); };
  const orTerm = (into: Uint32Array, at: number, l: number) => { setBit(into, at, tid(g.sym[l])); for (const t of also(l)) setBit(into, at, tid(t)); };
  /** into[at..] |= from[fa..]; true when into grew. */
  const orInto = (into: Uint32Array, at: number, from: Uint32Array, fa: number) => {
    let grew = false;
    for (let i = 0; i < W; i++) { const v = (into[at + i] | from[fa + i]) >>> 0; if (v !== into[at + i]) { into[at + i] = v; grew = true; } }
    return grew;
  };

  // ── what a rule reference leaf hands the closure item of its rule: the terminals that may come
  // next in its own rule (through nullable rules), and whether its rule may end after it ──
  const firstTerms: (number[] | undefined)[] = [];
  const firstOfRule = (r: number): number[] => {
    const cached = firstTerms[r];
    if (cached) return cached;
    firstTerms[r] = [];
    const out = new Set<number>(), seen = new Set<number>();
    const go = (ls: number[]) => { for (const l of ls) { if (seen.has(l)) continue; seen.add(l); const n = g.nt[l]; if (n < 0) out.add(l); else { go(g.first[n]); if (g.nullable[n]) go(g.follow[l]); } } };
    go(g.first[r]);
    return firstTerms[r] = [...out];
  };
  const spont = new Map<number, Uint32Array>();
  const passes = new Map<number, boolean>();
  for (let l = 0; l < g.sym.length; l++) {
    if (g.nt[l] < 0) continue;
    const m = new Uint32Array(W);
    let end = g.isLast[l];
    const seen = new Set<number>();
    const go = (ls: number[]) => {
      for (const x of ls) {
        if (seen.has(x)) continue; seen.add(x);
        const n = g.nt[x];
        if (n < 0) { orTerm(m, 0, x); continue; }
        for (const t of firstOfRule(n)) orTerm(m, 0, t);
        if (g.nullable[n]) { go(g.follow[x]); if (g.isLast[x]) end = true; }
      }
    };
    go(g.follow[l]);
    spont.set(l, m); passes.set(l, end);
  }

  // ── the LR(0) automaton ──
  const stateOf = new Map<string, number>();
  const kernels: number[][] = [];
  const states: LrState[] = [];
  const intern = (kernel: number[]) => {
    const key = kernel.join(',');
    let s = stateOf.get(key);
    if (s === undefined) { s = kernels.length; stateOf.set(key, s); kernels.push(kernel); }
    return s;
  };
  intern([-1 - g.entry]);
  for (let s = 0; s < kernels.length; s++) {
    const items = [...kernels[s]];
    const inItems = new Set(items);
    for (let i = 0; i < items.length; i++) for (const l of nextOf(items[i])) {
      const nt = g.nt[l];
      if (nt >= 0 && !inItems.has(-1 - nt)) { inItems.add(-1 - nt); items.push(-1 - nt); }
    }
    const bySym = new Map<string, Set<number>>();
    const add = (sym: string, l: number) => (bySym.get(sym) ?? bySym.set(sym, new Set()).get(sym)!).add(l);
    const next: number[] = [];
    for (const it of items) for (const l of nextOf(it)) {
      next.push(l);
      add(g.sym[l], l);
      if (g.nt[l] < 0) for (const t of also(l)) add(t, l);
    }
    const gone = new Set<string>();
    for (const [z, ts] of opts.preempts ?? []) if (bySym.has(z)) for (const t of ts) if (bySym.delete(t)) gone.add(t);
    const goto = new Map<string, number>();
    for (const [sym, ls] of bySym) goto.set(sym, intern([...ls].sort((a, b) => a - b)));
    states.push({ items, next: [...new Set(next)].filter(l => !gone.has(g.sym[l])), goto });
  }

  // ── LALR(1) lookaheads of the kernel items, to a fixpoint ──
  const kernelPos = kernels.map(k => new Map(k.map((it, i) => [it, i])));
  const kla = kernels.map(k => new Uint32Array(k.length * W));
  setBit(kla[0], 0, 0);   // the start rule is followed by END
  const closureLa = (s: number): Uint32Array => {
    const items = states[s].items;
    const pos = new Map(items.map((it, i) => [it, i]));
    const la = new Uint32Array(items.length * W);
    la.set(kla[s]);
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < items.length; i++) for (const l of nextOf(items[i])) {
        if (g.nt[l] < 0) continue;
        const q = pos.get(-1 - g.nt[l])! * W;
        if (orInto(la, q, spont.get(l)!, 0)) changed = true;
        if (passes.get(l) && orInto(la, q, la, i * W)) changed = true;
      }
    }
    return la;
  };
  const queued = new Uint8Array(kernels.length).fill(1);
  const work = kernels.map((_, s) => s).reverse();
  while (work.length) {
    const s = work.pop()!;
    queued[s] = 0;
    const { items, goto } = states[s];
    const la = closureLa(s);
    const push = (sym: string, l: number, i: number) => {
      const t = goto.get(sym);
      if (t === undefined) return;   // a preempted terminal: not shifted here
      if (orInto(kla[t], kernelPos[t].get(l)! * W, la, i * W) && !queued[t]) { queued[t] = 1; work.push(t); }
    };
    for (let i = 0; i < items.length; i++) for (const l of nextOf(items[i])) {
      push(g.sym[l], l, i);
      if (g.nt[l] < 0) for (const t of also(l)) push(t, l, i);
    }
  }

  const toSet = (m: Uint32Array) => {
    const out = new Set<string>();
    for (let b = 0; b < terminals.length; b++) if ((m[b >> 5] >>> (b & 31)) & 1) out.add(terminals[b]);
    return out;
  };
  const lookaheadBits = (s: number) => {
    const la = closureLa(s), m = new Uint32Array(W);
    states[s].items.forEach((it, i) => { if (complete(it)) orInto(m, 0, la, i * W); });
    return m;
  };
  return {
    states, terminals, terminalId,
    lookahead: s => toSet(lookaheadBits(s)),
    itemLookaheads: s => { const la = closureLa(s); return states[s].items.map((_, i) => toSet(la.subarray(i * W, (i + 1) * W))); },
    valid: s => {
      const m = lookaheadBits(s);
      for (const l of states[s].next) if (g.nt[l] < 0) orTerm(m, 0, l);
      return toSet(m);
    },
  };
}
