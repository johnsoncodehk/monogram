// ─────────────────────────────────────────────────────────────────────────────
//  grammar-gen.ts — a GENERIC, grammar-derived input GENERATOR (monogram#25 part 1).
//
//  The premise of the whole project is that the source IS a grammar: the same
//  combinator object (`yaml.ts`, `typescript.ts`, …) the parser / highlighter /
//  tree-sitter derive from is ALSO a generator. Walk its rule IR — `alt`=branch,
//  `seq`=concat, `*`/`+`/`?`=repeat, `ref`=descend, token=sample — and it emits
//  guaranteed-legal inputs. That replaces "hope the corpus contains the shape" (the
//  blind spot that hid monogram#23/#24 from a corpus-bound metric) with systematic,
//  bounded coverage derived from the grammar itself.
//
//  This file is the ENGINE; the judging (round-trip + scope≡role) lives in the
//  drivers that import it (test/generative.ts). It is language-AGNOSTIC: every
//  per-language fact (indent tokens, flow brackets, markup delimiters, compact
//  indicators) is read from the grammar's own config (`grammar.indent` / `.markup`),
//  never hardcoded — the same discipline the engines follow.
//
//  Three production strategies, all over the SAME walker:
//   • bounded-exhaustive — every derivation to a small depth N (provably complete at
//     small scope; this is what makes coverage `grammar × bound` instead of imagination).
//   • self-recursive nesting — for each rule that can contain itself, the nested shape
//     at depth 1..N. Deep self-embedding is exactly where a flat highlighter loses to
//     the stack-keeping parser (monogram#24 is `BlockSequence` inside `BlockSequence`).
//   • fuzzing — random production choices, for deeper / wider structures.
// ─────────────────────────────────────────────────────────────────────────────
import type { CstGrammar, RuleExpr, RuleDecl, TokenDecl, TokenPattern, TokenCharClassItem } from '../src/types.ts';
import { tokenPatternStartsWithDecimal, tokenPatternHasStartAnchor } from '../src/token-pattern.ts';

// Max emissions in one derivation. A deep tree of 2-rep quantifiers grows the list multiplicatively;
// copying huge lists (not the call count) is what makes a naive enumerator hang — cap it.
const MAX_EMS = 220;

// ── An EMISSION: the atomic unit the walker produces; the materializer renders it. ──
export type Emission =
  | { t: 'tok'; name: string; text: string }                 // a real lexer token (text sampled from its pattern)
  | { t: 'lit'; value: string }                              // a grammar literal (keyword or punctuation)
  | { t: 'struct'; kind: 'indent' | 'dedent' | 'newline' }   // indentation control (YAML indent mode)
  | { t: 'compact' };                                        // marks an indent that the lexer would emit INLINE (YAML compact `- - a`)

// A finished input: rendered text + the real tokens it should lex back to (round-trip witnesses).
export interface GenInput {
  text: string;
  tokens: { start: number; end: number; name: string; text: string }[];
  strategy: string;
  rule: string;        // the top rule the derivation started from (entry, or a self-recursive rule)
}

// ── deterministic PRNG (Date.now/Math.random are unavailable in workflow scripts and make
//    a generator unreproducible anyway — seed it). xorshift32. ──
function rng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1_000_000) / 1_000_000; };
}

// ─── TOKEN SAMPLING ──────────────────────────────────────────────────────────────
// Produce a string that MATCHES a TokenPattern. Conservative by default (a short,
// unambiguous lexeme) so the generated input round-trips; `interesting` injects
// grammar-derived boundary literals (e.g. `---`, `#`, `-`) into free-form tokens so a
// plain scalar can be sampled as `--- x` — legal as that token, but a shape that
// stresses the flat highlighter's context guessing (monogram#23). Returns null when
// the pattern can't be sampled (a `never()` placeholder — a structural token).
interface SampleCtx { rand: () => number; interesting: string[]; variant: number }

function pickNonExcluded(items: TokenCharClassItem[]): string | null {
  // a char NOT in the negated class — try common, readable candidates in order
  const cands = ['a', 'b', 'c', 'x', 'y', 'z', 'A', 'M', '1', '5', '_', '.', '@', '~'];
  const inClass = (ch: string) => items.some((it) =>
    it.type === 'char' ? it.value === ch : ch >= it.from && ch <= it.to);
  for (const ch of cands) if (!inClass(ch)) return ch;
  return null;
}
function firstOfClass(items: TokenCharClassItem[]): string | null {
  for (const it of items) {
    if (it.type === 'char') { if (it.value !== '\n' && it.value !== '\r') return it.value; }
    else { const c = it.from; if (c !== '\n' && c !== '\r') return c; }
  }
  return null;
}

function sample(pat: TokenPattern, ctx: SampleCtx): string | null {
  if (typeof pat === 'string') return pat;
  switch (pat.type) {
    case 'never': return null;                        // structural-token placeholder
    case 'anyChar': return 'x';
    case 'anchor': return '';
    case 'lookahead': case 'lookbehind': return '';   // zero-width; context handled by the materializer's separators
    case 'charClass': {
      const ch = pat.negate ? pickNonExcluded(pat.items) : firstOfClass(pat.items);
      return ch ?? 'x';
    }
    case 'seq': {
      let out = '';
      for (const it of pat.items) { const s = sample(it, ctx); if (s === null) return null; out += s; }
      return out;
    }
    case 'alt': {
      // bias toward branch 0 (usually the simplest); `variant` rotates for variety
      const idx = pat.items.length ? ctx.variant % pat.items.length : 0;
      for (let k = 0; k < pat.items.length; k++) {
        const s = sample(pat.items[(idx + k) % pat.items.length], ctx);
        if (s !== null) return s;
      }
      return null;
    }
    case 'repeat': {
      const reps = pat.min === 0 ? (ctx.variant % 2 === 0 ? 1 : 0) : pat.min;   // 0/1 for *, min for +
      let out = '';
      for (let i = 0; i < Math.max(reps, pat.min); i++) { const s = sample(pat.body, ctx); if (s === null) return null; out += s; }
      return out;
    }
  }
}

// The number of branches in the SHALLOWEST `alt` reachable through the pattern's
// leading seq/group/repeat spine — the branches that a different `variant` index makes
// `sample` rotate through (it picks `variant % items.length` at each alt). A token whose
// value is an alternation of forms (a Number's int / float branches, a string's escape
// alternatives) needs at least this many variant indices for EVERY branch to be emitted,
// not just branch 0 — otherwise the budget caps it at the first form (`0`, never `1.5`).
function topAltBranches(pat: TokenPattern): number {
  if (typeof pat === 'string') return 1;
  switch (pat.type) {
    case 'alt': return pat.items.length;
    case 'seq': return Math.max(1, ...pat.items.map(topAltBranches));
    case 'repeat': return topAltBranches(pat.body);
    default: return 1;
  }
}

// Sample several distinct, legal texts for a token (variants + interesting-literal embeds).
function sampleVariants(decl: TokenDecl, ctx: { rand: () => number; interesting: string[] }, n: number): string[] {
  const out = new Set<string>();
  // Cover every top-level alt branch: a token that is itself an alternation (hex/oct/bin/float
  // forms) must emit ALL its branches, not stop at branch 0 once `n` distinct samples are reached —
  // so the budget is at least the branch count, and the all-branch sweep is NOT capped by `out.size`.
  const budget = Math.max(n + 2, topAltBranches(decl.pattern) + 2);
  for (let v = 0; v < budget; v++) {
    const s = sample(decl.pattern, { ...ctx, variant: v });
    if (s !== null && s.length > 0) out.add(s);
  }
  // a base sample to seed interesting-literal embeds
  const base = sample(decl.pattern, { ...ctx, variant: 0 }) ?? '';
  // Embed grammar-derived boundary literals into free-form (multi-char-capable) tokens, where
  // the result is still a single legal instance of the token — this is what produces the
  // monogram#23 shape (a plain scalar whose text is `--- x`). Verified per-token by re-lexing
  // in the driver; an embed that doesn't re-lex to this token is simply dropped there.
  // GUARD: a token whose pattern starts with a DECIMAL digit (`0x1F`, `1.5`) or carries a
  // `start()` line/stream anchor (a shebang `^#!…`) must NOT get a leading-literal embed: gluing
  // `-`/`#`/`---` on front re-lexes as a different token (`-0x1` = minus + number, `#0x1` ≠ hex)
  // or breaks the column-0 anchor — so the embed would never round-trip back to THIS token. The
  // pure-variant samples above already cover such tokens; only free-form tokens take the embeds.
  const anchored = tokenPatternStartsWithDecimal(decl) || tokenPatternHasStartAnchor(decl);
  if (base.length >= 1 && !anchored) {
    for (const lit of ctx.interesting) {
      if (lit.length === 0 || /[\n\r]/.test(lit)) continue;
      out.add(lit + base);            // glued leading boundary (`---` + `x` → `---x`)
      // a SPACE-separated form (`--- x`): a boundary literal that is line-structural only with a
      // trailing space (a doc marker `---␣`, a comment `#␣`) re-fires its structural meaning here, so
      // this is the form that exercises monogram#23 (a value-leading `--- x` the parser keeps a plain
      // scalar but a flat grammar may mis-scope as a marker). Legal where the token body admits a space.
      out.add(lit + ' ' + base);
      if (out.size > n + ctx.interesting.length * 2) break;
    }
  }
  return [...out];
}

// ─── THE WALKER ──────────────────────────────────────────────────────────────────
export interface GenOptions {
  depth?: number;       // bounded-exhaustive derivation depth (rule-ref recursion)
  cap?: number;         // max alternatives kept at each combinator node (anti-explosion)
  maxInputs?: number;   // global cap on emitted inputs per rule
  fuzzRounds?: number;  // random derivations
  seed?: number;
  nestDepth?: number;   // self-recursive nesting depth
  timeBudgetMs?: number; // wall-clock cap for the depth strategies (large token-stream grammars)
}

class Walker {
  tokenByName = new Map<string, TokenDecl>();
  ruleByName = new Map<string, RuleDecl>();
  interesting: string[];
  structKind = new Map<string, 'indent' | 'dedent' | 'newline'>();
  compactLits: Set<string>;
  reachMap = new Map<string, Set<string>>();   // rule → every rule it can transitively reach
  tokenHostRules = new Map<string, string[]>(); // token name → rules whose body DIRECTLY references it
  ruleMin = new Map<string, Emission[] | null>();
  rand: () => number;
  cap: number;
  grammar: CstGrammar;
  budgetCalls = 0;          // anti-explosion: enum() is a tree walk; cap the work PER top-level call
  maxCalls = 60_000;
  enumTop(e: RuleExpr, budget: number): Emission[][] { this.budgetCalls = 0; return this.enum(e, budget); }

  constructor(grammar: CstGrammar, seed: number, cap: number) {
    this.grammar = grammar;
    this.rand = rng(seed);
    this.cap = cap;
    for (const t of grammar.tokens) this.tokenByName.set(t.name, t);
    for (const r of grammar.rules) this.ruleByName.set(r.name, r);
    const ind = grammar.indent;
    if (ind) {
      this.structKind.set(ind.indentToken, 'indent');
      this.structKind.set(ind.dedentToken, 'dedent');
      this.structKind.set(ind.newlineToken, 'newline');
    }
    this.compactLits = new Set(grammar.indent?.compactIndicators ?? []);
    this.interesting = this.collectInteresting();
    this.computeReach();
    this.computeTokenHosts();
    this.computeMins();
  }

  // For each token, the rules whose body DIRECTLY references it (`ref` to a token name). This is the
  // entry point of tokenCover's directed descent: a scoped token only ever appears at these rules, so
  // building the shortest legal path to one of them and substituting the token covers it. A token with
  // NO host rule (a lexer-trivia token the parser never consumes — a shebang / JSDoc comment, skipped
  // before the token stream) is unreachable by ANY derivation and is left out (it is not a CST leaf).
  computeTokenHosts(): void {
    for (const r of this.grammar.rules) {
      const toks = new Set<string>();
      const go = (e: RuleExpr) => { switch (e.type) {
        case 'ref': if (this.isToken(e.name)) toks.add(e.name); break;
        case 'seq': case 'alt': e.items.forEach(go); break;
        case 'quantifier': case 'group': case 'not': go(e.body); break;
        case 'sep': go(e.element); break;
      } };
      go(r.body);
      for (const tn of toks) (this.tokenHostRules.get(tn) ?? this.tokenHostRules.set(tn, []).get(tn)!).push(r.name);
    }
  }

  computeReach(): void {
    const refs = (e: RuleExpr, acc: Set<string>) => {
      switch (e.type) {
        case 'ref': if (this.ruleByName.has(e.name)) acc.add(e.name); break;
        case 'seq': case 'alt': e.items.forEach((i) => refs(i, acc)); break;
        case 'quantifier': case 'group': case 'not': refs(e.body, acc); break;
        case 'sep': refs(e.element, acc); break;
      }
    };
    for (const r of this.grammar.rules) { const s = new Set<string>(); refs(r.body, s); this.reachMap.set(r.name, s); }
    for (let i = 0; i < this.grammar.rules.length; i++)
      for (const r of this.grammar.rules) { const s = this.reachMap.get(r.name)!; for (const n of [...s]) for (const m of this.reachMap.get(n) ?? []) s.add(m); }
  }
  // does an expression (transitively) reference `target` — i.e. descending into it can reach target?
  // memoised (per expr-object × target) — `nestChain` queries it on every item, so the cache matters.
  reachesCache = new WeakMap<object, Map<string, boolean>>();
  exprReaches(e: RuleExpr, target: string): boolean {
    if (typeof e === 'object') {
      let m = this.reachesCache.get(e); if (!m) { m = new Map(); this.reachesCache.set(e, m); }
      const c = m.get(target); if (c !== undefined) return c;
      const v = this.exprReachesRaw(e, target); m.set(target, v); return v;
    }
    return this.exprReachesRaw(e, target);
  }
  exprReachesRaw(e: RuleExpr, target: string): boolean {
    switch (e.type) {
      case 'ref': return e.name === target || (this.reachMap.get(e.name)?.has(target) ?? false);
      case 'seq': case 'alt': return e.items.some((i) => this.exprReaches(i, target));
      case 'quantifier': case 'group': case 'not': return this.exprReaches(e.body, target);
      case 'sep': return this.exprReaches(e.element, target);
      default: return false;
    }
  }

  // shortest rule-ref distance FROM each rule TO `target` (BFS on the reversed ref graph), memoised.
  // `nestChain` uses it to descend the DIRECT path to target each level — picking merely "a branch
  // that reaches target" loops forever through a long cycle that technically reaches it but never
  // arrives (Node→[Indent,Node]→Node…), producing an empty indent chain instead of nested content.
  distCache = new Map<string, Map<string, number>>();
  distTo(target: string): Map<string, number> {
    let m = this.distCache.get(target); if (m) return m;
    m = new Map([[target, 0]]);
    // reversed adjacency: who DIRECTLY refs each rule
    const back = new Map<string, string[]>();
    for (const r of this.grammar.rules) for (const ref of this.directRuleRefs(r.body)) { (back.get(ref) ?? back.set(ref, []).get(ref)!).push(r.name); }
    const queue = [target];
    while (queue.length) { const cur = queue.shift()!; const d = m.get(cur)!; for (const pre of back.get(cur) ?? []) if (!m.has(pre)) { m.set(pre, d + 1); queue.push(pre); } }
    this.distCache.set(target, m); return m;
  }
  directRuleRefs(e: RuleExpr): string[] {
    const out: string[] = [];
    const go = (x: RuleExpr) => { switch (x.type) {
      case 'ref': if (this.ruleByName.has(x.name)) out.push(x.name); break;
      case 'seq': case 'alt': x.items.forEach(go); break;
      case 'quantifier': case 'group': case 'not': go(x.body); break;
      case 'sep': go(x.element); break;
    } };
    go(e); return out;
  }
  // min distance an expression sits from re-entering `target` (Infinity if it can't reach it)
  distExprCache = new WeakMap<object, Map<string, number>>();
  exprDist(e: RuleExpr, target: string): number {
    if (typeof e === 'object') { let m = this.distExprCache.get(e); if (!m) { m = new Map(); this.distExprCache.set(e, m); } const c = m.get(target); if (c !== undefined) return c; const v = this.exprDistRaw(e, target); m.set(target, v); return v; }
    return this.exprDistRaw(e, target);
  }
  exprDistRaw(e: RuleExpr, target: string): number {
    const dm = this.distTo(target);
    switch (e.type) {
      case 'ref': return e.name === target ? 0 : (dm.has(e.name) ? dm.get(e.name)! : Infinity);
      case 'seq': case 'alt': return Math.min(Infinity, ...e.items.map((i) => this.exprDist(i, target)));
      case 'quantifier': case 'group': case 'not': return this.exprDist(e.body, target);
      case 'sep': return this.exprDist(e.element, target);
      default: return Infinity;
    }
  }

  // grammar-derived boundary literals: every literal in the rules + structural sigils that
  // a free-form token could legally contain but that ALSO start another token (the collision
  // shapes a flat highlighter mis-scopes). Short, non-alphabetic ones are the interesting ones.
  collectInteresting(): string[] {
    const lits = new Set<string>();
    const walk = (e: RuleExpr) => {
      switch (e.type) {
        case 'literal': lits.add(e.value); break;
        case 'seq': case 'alt': e.items.forEach(walk); break;
        case 'quantifier': case 'group': case 'not': walk(e.body); break;
        case 'sep': walk(e.element); break;
      }
    };
    for (const r of this.grammar.rules) walk(r.body);
    // doc markers / block-scalar introducers live in indent config, not the rules
    const ind = this.grammar.indent;
    for (const m of ind?.blockScalar?.documentMarkers ?? []) lits.add(m);
    return [...lits].filter((l) => l.length > 0 && l.length <= 3 && !/^[A-Za-z]+$/.test(l));
  }

  isToken(name: string): boolean { return this.tokenByName.has(name); }
  isStruct(name: string): boolean { return this.structKind.has(name); }

  // ── minimal terminating expansion (fixpoint), so any budget cut-off still produces legal text ──
  computeMins(): void {
    for (const r of this.grammar.rules) this.ruleMin.set(r.name, null);
    for (let iter = 0; iter < this.grammar.rules.length + 2; iter++) {
      let changed = false;
      for (const r of this.grammar.rules) {
        if (this.ruleMin.get(r.name)) continue;
        const m = this.minExpand(r.body);
        if (m) { this.ruleMin.set(r.name, m); changed = true; }
      }
      if (!changed) break;
    }
  }
  minExpand(e: RuleExpr): Emission[] | null {
    switch (e.type) {
      case 'literal': return [{ t: 'lit', value: e.value }];
      case 'ref': {
        if (this.isStruct(e.name)) return [{ t: 'struct', kind: this.structKind.get(e.name)! }];
        if (this.isToken(e.name)) {
          const txt = sample(this.tokenByName.get(e.name)!.pattern, { rand: this.rand, interesting: [], variant: 0 });
          return txt === null ? null : [{ t: 'tok', name: e.name, text: txt || 'x' }];
        }
        return this.ruleMin.get(e.name) ?? null;
      }
      case 'seq': {
        const out: Emission[] = [];
        for (const it of e.items) { const m = this.minExpand(it); if (!m) return null; out.push(...m); }
        return out;
      }
      case 'alt': {
        let best: Emission[] | null = null;
        for (const it of e.items) { const m = this.minExpand(it); if (m && (!best || m.length < best.length)) best = m; }
        return best;
      }
      case 'quantifier': return e.kind === '+' ? this.minExpand(e.body) : [];
      case 'group': return this.minExpand(e.body);
      case 'sep': return this.minExpand(e.element);
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore':
      case 'op': case 'prefix': case 'postfix': return [];
    }
  }

  // Minimal-but-CONTENT-BEARING expansion: like minExpand, but `opt`/`*` fire ONE rep when their body
  // can yield a token, and `alt` prefers a branch that produces a token — so a `- opt(Value)` becomes
  // `- <scalar>` instead of a bare `-`. Bounded by `fuel`; falls back to minExpand at the floor.
  fillBudget = 0;   // global anti-explosion for fillContent's all-branches alt search (huge TS alts)
  fillContent(e: RuleExpr, fuel: number): Emission[] {
    if (--fuel <= 0 || --this.fillBudget <= 0) return this.minExpand(e) ?? [];
    const hasTok = (xs: Emission[]) => xs.some((em) => em.t === 'tok');
    switch (e.type) {
      case 'literal': return [{ t: 'lit', value: e.value }];
      case 'ref': {
        if (this.isStruct(e.name)) return [{ t: 'struct', kind: this.structKind.get(e.name)! }];
        if (this.isToken(e.name)) { const v = sample(this.tokenByName.get(e.name)!.pattern, { rand: this.rand, interesting: [], variant: 0 }); return [{ t: 'tok', name: e.name, text: v || 'x' }]; }
        return this.fillContent(this.ruleByName.get(e.name)!.body, fuel);
      }
      case 'seq': { const out: Emission[] = []; for (const it of e.items) for (const x of this.fillContent(it, fuel)) out.push(x); return out; }
      case 'alt': {
        // prefer a SHORT branch that yields PLAIN-STRING content — a clean scalar value (`- a`), not a
        // sigil-led node (alias `*a`, flow `[…]`) or a multi-line fold. A plain string is what a
        // sibling `-` line can (wrongly) fold into, which is the monogram#24 trigger.
        let best: Emission[] | null = null, bestScore = -Infinity;
        for (const it of e.items) {
          const r = this.fillContent(it, fuel);
          if (!hasTok(r)) continue;
          const stringy = r.some((em) => em.t === 'tok' && /^string\.unquoted/.test(this.tokenByName.get(em.name)?.scope ?? '') && !/[&*!|>[\]{}#%'"]/.test(em.text[0] ?? ''));
          const score = (stringy ? 100 : 0) - r.length;
          if (score > bestScore) { bestScore = score; best = r; }
        }
        return best ?? this.fillContent(e.items[0], fuel);
      }
      case 'quantifier': { const r = this.fillContent(e.body, fuel); if ((e.kind === '?' || e.kind === '*') && !hasTok(r)) return []; return r; }
      case 'group': return this.fillContent(e.body, fuel);
      case 'sep': return this.fillContent(e.element, fuel);
      default: return [];
    }
  }

  // ── bounded-exhaustive enumeration: a capped set of emission-sequences for `e` ──
  enum(e: RuleExpr, budget: number): Emission[][] {
    const cap = this.cap;
    // global work cap: the walk is a tree whose SIZE (not just output) grows with depth×cap×rules;
    // once exceeded, collapse to the minimal expansion so a run always terminates in bounded time.
    if (++this.budgetCalls > this.maxCalls) { const m = this.minExpand(e); return m ? [m] : [[]]; }
    switch (e.type) {
      case 'literal': return [[{ t: 'lit', value: e.value }]];
      case 'ref': {
        if (this.isStruct(e.name)) return [[{ t: 'struct', kind: this.structKind.get(e.name)! }]];
        if (this.isToken(e.name)) {
          const vs = sampleVariants(this.tokenByName.get(e.name)!, { rand: this.rand, interesting: this.interesting }, 3);
          return (vs.length ? vs : ['x']).slice(0, cap).map((t) => [{ t: 'tok', name: e.name, text: t }]);
        }
        if (budget <= 0) { const m = this.ruleMin.get(e.name); return m ? [m] : [[]]; }
        return this.enum(this.ruleByName.get(e.name)!.body, budget - 1);
      }
      case 'seq': {
        let acc: Emission[][] = [[]];
        for (const it of e.items) {
          const parts = this.enum(it, budget);
          const next: Emission[][] = [];
          // skip combos whose emission list would blow past MAX_EMS — a deep tree of 2-rep quantifiers
          // grows the list multiplicatively, and copying huge lists (not the call count) is the cost.
          for (const a of acc) for (const p of parts) { if (a.length + p.length <= MAX_EMS) next.push([...a, ...p]); if (next.length >= cap) break; }
          acc = next.length ? next : acc;
          if (acc.length >= cap) acc = acc.slice(0, cap);
        }
        return acc;
      }
      case 'alt': {
        // round-robin across branches so a deep/recursive branch (usually LAST) is not starved by an
        // earlier scalar branch filling the cap — the difference between ever generating `- - a` or not.
        const perBranch = e.items.map((it) => this.enum(it, budget));
        const out: Emission[][] = [];
        for (let i = 0; out.length < cap; i++) {
          let any = false;
          for (const b of perBranch) { if (i < b.length) { out.push(b[i]); any = true; if (out.length >= cap) break; } }
          if (!any) break;
        }
        return out;
      }
      case 'quantifier': {
        const body = this.enum(e.body, budget);
        const out: Emission[][] = [];
        if (e.kind !== '+') out.push([]);                       // 0 reps for ? and *
        for (const b of body) { out.push(b); if (out.length >= cap) return out; }
        if (e.kind !== '?') for (const b of body) { if (b.length * 2 <= MAX_EMS) { out.push([...b, ...b]); if (out.length >= cap) return out; } }  // 2 reps for * and +
        return out;
      }
      case 'group': return this.enum(e.body, budget);
      case 'sep': {
        const el = this.enum(e.element, budget);
        const out: Emission[][] = [];
        for (const b of el) { out.push(b); if (out.length >= cap) return out; }
        for (const b of el) { if (b.length * 2 + 1 <= MAX_EMS) { out.push([...b, { t: 'lit', value: e.delimiter }, ...b]); if (out.length >= cap) return out; } }
        return out;
      }
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore':
      case 'op': case 'prefix': case 'postfix': return [[]];
    }
  }

  // ── random derivation (fuzzing): one emission sequence, forced to terminate at budget 0 ──
  fuzz(e: RuleExpr, budget: number): Emission[] {
    const pick = <T,>(xs: T[]): T => xs[Math.floor(this.rand() * xs.length)];
    // bounded `for`-push (NOT spread on a possibly-huge array → stack overflow + size blowup)
    const fappend = (out: Emission[], add: Emission[]) => { if (out.length < MAX_EMS) for (const x of add) out.push(x); };
    switch (e.type) {
      case 'literal': return [{ t: 'lit', value: e.value }];
      case 'ref': {
        if (this.isStruct(e.name)) return [{ t: 'struct', kind: this.structKind.get(e.name)! }];
        if (this.isToken(e.name)) {
          const vs = sampleVariants(this.tokenByName.get(e.name)!, { rand: this.rand, interesting: this.interesting }, 4);
          return [{ t: 'tok', name: e.name, text: vs.length ? pick(vs) : 'x' }];
        }
        if (budget <= 0) return this.ruleMin.get(e.name) ?? [];
        return this.fuzz(this.ruleByName.get(e.name)!.body, budget - 1);
      }
      case 'seq': { const out: Emission[] = []; for (const it of e.items) fappend(out, this.fuzz(it, budget)); return out; }
      case 'alt': {
        if (budget <= 0) { const m = this.minExpand(e); if (m) return m; }
        return this.fuzz(pick(e.items), budget);
      }
      case 'quantifier': {
        const reps = budget <= 0 ? (e.kind === '+' ? 1 : 0) : (e.kind === '?' ? Math.floor(this.rand() * 2) : Math.floor(this.rand() * 3) + (e.kind === '+' ? 1 : 0));
        const out: Emission[] = []; for (let i = 0; i < reps; i++) fappend(out, this.fuzz(e.body, budget - 1)); return out;
      }
      case 'group': return this.fuzz(e.body, budget);
      case 'sep': {
        const reps = budget <= 0 ? 1 : Math.floor(this.rand() * 3) + 1; const out: Emission[] = [];
        for (let i = 0; i < reps; i++) { if (i) out.push({ t: 'lit', value: e.delimiter }); fappend(out, this.fuzz(e.element, budget - 1)); }
        return out;
      }
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore':
      case 'op': case 'prefix': case 'postfix': return [];
    }
  }

  // Rules that can (transitively) contain themselves — the self-recursive nesting targets.
  selfRecursive(): string[] {
    return this.grammar.rules.filter((r) => this.reachMap.get(r.name)!.has(r.name)).map((r) => r.name);
  }

  // ── DIRECTED nesting: a random derivation BIASED to descend back toward `target` until `depth`
  //    runs out, then to terminate — so a self-recursive rule is forced to NEST, and its repetitions
  //    fire to add SIBLINGS. This deterministically reaches the deep self-embedding shapes (a
  //    BlockSequence inside a BlockSequence with an inner sibling — monogram#24) that an un-biased,
  //    capped enumeration starves. Agnostic: `target` is any self-recursive rule, found generically.
  siblingLeft = 0;
  // Build a CLEAN, SHORT nested chain of `target` (a collection inside a collection, `nest` levels
  // deep) with ONE inner sibling — the monogram#24 class. Fast and deterministic: at each rule, take
  // the SINGLE first sub-path that re-enters `target` and minimal-fill everything else, so the output
  // is the bare nested skeleton (no kitchen-sink filler). `target` is any self-recursive rule, found
  // generically. The sibling (`- a`/`- b`) is added at the target's own repetition, innermost first.
  nestChain(body: RuleExpr, target: string, nest: number): Emission[] {
    this.siblingLeft = nest + 1;   // one inner sibling per nesting level (the `- a`/`- b` pairs)
    this.fillBudget = 200_000;     // a high backstop (nestChain only runs on small indent/markup grammars now)
    return this.nestRec(body, target, nest, 300, false);
  }
  nestRec(e: RuleExpr, target: string, nest: number, fuel: number, atTarget: boolean): Emission[] {
    if (--fuel <= 0 || nest < 0) { return this.fillContent(e, 30) ?? []; }
    // at the INNERMOST level (nest 0) fill with CONTENT (a scalar value) so a collection item is
    // `- a`, not a bare `-` — monogram#24 needs a plain scalar for the sibling `-` to (wrongly) fold
    // into. Off the recursive path at deeper levels → the minimal terminating filler (short chain).
    if (nest === 0) { return this.fillContent(e, 30); }
    if (!this.exprReaches(e, target)) { const m = this.minExpand(e); if (m) return m; }
    switch (e.type) {
      case 'literal': return [{ t: 'lit', value: e.value }];
      case 'ref': {
        if (this.isStruct(e.name)) return [{ t: 'struct', kind: this.structKind.get(e.name)! }];
        if (this.isToken(e.name)) { const v = sample(this.tokenByName.get(e.name)!.pattern, { rand: this.rand, interesting: [], variant: 0 }); return [{ t: 'tok', name: e.name, text: v || 'x' }]; }
        const re = e.name === target;
        return this.nestRec(this.ruleByName.get(e.name)!.body, target, re ? nest - 1 : nest, fuel, re);
      }
      case 'seq': {
        // descend the item with the SHORTEST distance to re-entering target (the direct path), and —
        // when at the target rule's own body — fire ONE shallow sibling from its repetition (the
        // `- a`/`- b` inner pair, monogram#24). Minimal-fill everything else → a clean nested chain.
        let idx = -1, best = Infinity;
        e.items.forEach((it, i) => { const d = this.exprDist(it, target); if (d < best) { best = d; idx = i; } });
        const out: Emission[] = [];
        e.items.forEach((it, i) => {
          let part: Emission[];
          if (i === idx) part = this.nestRec(it, target, nest, fuel, atTarget);                                // deepen the chain
          else if (atTarget && this.siblingLeft > 0 && it.type === 'quantifier' && this.exprReaches(it, target)) {
            this.siblingLeft--; part = this.nestRec(it.body, target, 0, fuel, false);                          // one shallow SIBLING
          } else part = this.minExpand(it) ?? [];
          for (const x of part) out.push(x);
        });
        return out;
      }
      case 'alt': {
        // the branch that re-enters target SOONEST (min distance) — so the chain actually descends
        let pickEl = e.items[0], best = Infinity;
        for (const it of e.items) { const d = this.exprDist(it, target); if (d < best) { best = d; pickEl = it; } }
        return this.nestRec(pickEl, target, nest, fuel, atTarget);
      }
      case 'quantifier': { const out: Emission[] = []; for (const x of this.nestRec(e.body, target, nest, fuel, atTarget)) out.push(x); return out; }
      case 'group': return this.nestRec(e.body, target, nest, fuel, atTarget);
      case 'sep': { const out: Emission[] = []; for (const x of this.nestRec(e.element, target, nest, fuel, atTarget)) out.push(x); return out; }
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore':
      case 'op': case 'prefix': case 'postfix': return [];
    }
  }

  // ── DIRECTED TOKEN COVERAGE ──────────────────────────────────────────────────────────────────────
  // The same directed-descent idea as nestChain, but the target is a scoped TOKEN, not a self-recursive
  // RULE. A grammar-derived LEGAL corpus is shallow/structural and never reaches an expression-position
  // literal: every numeric, every private field — the scoped leaves the scope≡role judge checks — appears
  // ZERO times. tokenCover fixes that by, for each scoped token, building the SHORTEST legal path from the
  // entry rule to a rule that references it (the SAME reversed-BFS the nesting strategies use, retargeted
  // at a token via its host rules) and substituting real samples of the token there. Minimal context only
  // (shortest path + minExpand filler), so it stays cheap on a 50-rule grammar.

  // shortest rule-ref distance FROM each rule TO any rule that references `tokenName` (reversed-BFS, like
  // distTo but seeded at the token's host rules). Memoised. Infinity-absent ⇒ the rule can't reach the token.
  // A host rule starts at distance 1 (entering its body costs one ref step to reach the direct token use);
  // a DIRECT `ref:token` in an expression is 0. The gap is what makes the descent STOP at the first direct
  // token use instead of recursing into a self-recursive host (`Type` → `aa is Type → …` never terminating):
  // `ref:token` (0) strictly beats `ref:host` (≥1), so a `seq`/`alt`'s shortest branch is the one that
  // actually places the token here, not the one that re-enters a host rule that also eventually reaches it.
  tokenDistCache = new Map<string, Map<string, number>>();
  tokenDistTo(tokenName: string): Map<string, number> {
    let m = this.tokenDistCache.get(tokenName); if (m) return m;
    m = new Map<string, number>();
    const back = new Map<string, string[]>();
    for (const r of this.grammar.rules) for (const ref of this.directRuleRefs(r.body)) (back.get(ref) ?? back.set(ref, []).get(ref)!).push(r.name);
    const queue: string[] = [];
    for (const host of this.tokenHostRules.get(tokenName) ?? []) if (!m.has(host)) { m.set(host, 1); queue.push(host); }   // host rule body = 1 step from the direct token use
    while (queue.length) { const cur = queue.shift()!; const d = m.get(cur)!; for (const pre of back.get(cur) ?? []) if (!m.has(pre)) { m.set(pre, d + 1); queue.push(pre); } }
    this.tokenDistCache.set(tokenName, m); return m;
  }
  // min rule-ref distance from an expression to `tokenName` — 0 if it DIRECTLY refs the token (a direct
  // use strictly beats re-entering a host rule, so the descent terminates at the token, see tokenDistTo).
  exprDistToToken(e: RuleExpr, tokenName: string): number {
    const dm = this.tokenDistTo(tokenName);
    switch (e.type) {
      case 'ref': return e.name === tokenName ? 0 : (dm.has(e.name) ? dm.get(e.name)! : Infinity);
      case 'seq': case 'alt': return Math.min(Infinity, ...e.items.map((i) => this.exprDistToToken(i, tokenName)));
      case 'quantifier': case 'group': case 'not': return this.exprDistToToken(e.body, tokenName);
      case 'sep': return this.exprDistToToken(e.element, tokenName);
      default: return Infinity;
    }
  }
  exprReachesToken(e: RuleExpr, tokenName: string): boolean { return this.exprDistToToken(e, tokenName) < Infinity; }

  // Scoped tokens that tokenCover CAN reach: a declared `.scope`, a samplable pattern (not a `never()`
  // structural placeholder), and at least one host rule reachable from the entry. A trivia token the
  // parser never consumes (no host rule — a shebang / doc comment) is excluded HERE: no rule path reaches
  // it (it is handled, where it can be at all, by `prefixOnlyTokens`).
  coverableTokens(entryName: string): TokenDecl[] {
    return this.grammar.tokens.filter((t) => {
      if (!t.scope) return false;
      if (typeof t.pattern !== 'string' && t.pattern.type === 'never') return false;   // structural placeholder
      const dm = this.tokenDistTo(t.name);
      return dm.has(entryName) || (this.tokenHostRules.get(t.name) ?? []).includes(entryName);
    });
  }

  // Scoped tokens NO rule references but that carry a `start()` line/stream anchor (a shebang `^#!…`) —
  // the parser treats them as leading trivia (skipped, never a CST leaf), so coverableTokens can't reach
  // them, yet they ARE a legal document PREFIX the highlighter scopes. We emit each as a stand-alone line
  // so the generated corpus contains it; it can only be the first emission (the anchor), which a one-token
  // input trivially satisfies. (Such a token is not a CST leaf, so the scope≡role gate does not grade it —
  // this widens the round-trip corpus, not the leaf check.)
  prefixOnlyTokens(): TokenDecl[] {
    return this.grammar.tokens.filter((t) =>
      !!t.scope &&
      !(typeof t.pattern !== 'string' && t.pattern.type === 'never') &&
      !this.tokenHostRules.has(t.name) &&
      tokenPatternHasStartAnchor(t));
  }

  // Build the minimal legal context from `entry` down to `tokenName`, with the token rendered as
  // `sampleText` at its position. Descends the SHORTEST branch toward the token at each node and
  // minimal-fills everything else — the directed, deterministic analogue of nestChain for a token.
  coverToken(entryBody: RuleExpr, tokenName: string, sampleText: string): Emission[] {
    this.coverFuel = 400;
    return this.coverRec(entryBody, tokenName, sampleText);
  }
  coverFuel = 0;
  coverRec(e: RuleExpr, tokenName: string, sampleText: string): Emission[] {
    if (--this.coverFuel <= 0 || !this.exprReachesToken(e, tokenName)) return this.minExpand(e) ?? [];
    switch (e.type) {
      case 'literal': return [{ t: 'lit', value: e.value }];
      case 'ref': {
        if (e.name === tokenName) return [{ t: 'tok', name: e.name, text: sampleText }];               // THE target token → the sample
        if (this.isStruct(e.name)) return [{ t: 'struct', kind: this.structKind.get(e.name)! }];
        if (this.isToken(e.name)) { const v = sample(this.tokenByName.get(e.name)!.pattern, { rand: this.rand, interesting: [], variant: 0 }); return [{ t: 'tok', name: e.name, text: v || 'x' }]; }
        return this.coverRec(this.ruleByName.get(e.name)!.body, tokenName, sampleText);                // descend into the rule
      }
      case 'seq': {
        // descend the ONE item closest to the token; minimal-fill the rest → the shortest legal frame.
        let idx = -1, best = Infinity;
        e.items.forEach((it, i) => { const d = this.exprDistToToken(it, tokenName); if (d < best) { best = d; idx = i; } });
        const out: Emission[] = [];
        e.items.forEach((it, i) => { for (const x of (i === idx ? this.coverRec(it, tokenName, sampleText) : this.minExpand(it) ?? [])) out.push(x); });
        return out;
      }
      case 'alt': {
        // the branch that reaches the token soonest (so the frame actually contains it).
        let pick = e.items[0], best = Infinity;
        for (const it of e.items) { const d = this.exprDistToToken(it, tokenName); if (d < best) { best = d; pick = it; } }
        return this.coverRec(pick, tokenName, sampleText);
      }
      case 'quantifier': return this.coverRec(e.body, tokenName, sampleText);   // fire exactly one rep (it carries the token)
      case 'group': return this.coverRec(e.body, tokenName, sampleText);
      case 'sep': return this.coverRec(e.element, tokenName, sampleText);       // one element (it carries the token)
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore':
      case 'op': case 'prefix': case 'postfix': return [];
    }
  }
}

// ─── MATERIALIZE: emissions → text + token spans ──────────────────────────────────
// The per-language structural-token materialization hook. Token-stream grammars join with a
// space (whitespace-insensitive); indentation grammars (YAML) render struct emissions through an
// indent STACK that mirrors the lexer (newline = same-column sibling, indent = deeper block,
// compact = an inline indent for `- - a`); markup grammars keep tag punctuation adjacent.
interface MatOptions { mode: 'token-stream' | 'indent' | 'markup'; indentStep: number }

function materialize(grammar: CstGrammar, ems: Emission[], opts: MatOptions): { text: string; tokens: GenInput['tokens'] } {
  let text = '';
  const tokens: GenInput['tokens'] = [];
  // hard length cap: a pathological derivation (deep indent, many reps) must never grow text without
  // bound — past the cap, appends are dropped (the input is over-long and discarded by the caller).
  const emit = (s: string) => { if (text.length < 16_000) text += s; };
  const emitTok = (name: string, s: string) => { tokens.push({ start: text.length, end: text.length + s.length, name, text: s }); text += s; };

  if (opts.mode === 'indent') {
    const stack: number[] = [0];            // indentation columns; top = current block column
    let atLineStart = true;
    let pendingCompact = false;             // the previous struct was a compact indicator's inline indent
    const sp = (n: number) => ' '.repeat(n);
    for (let i = 0; i < ems.length; i++) {
      const e = ems[i];
      if (e.t === 'struct') {
        if (e.kind === 'indent') {
          const col = stack[stack.length - 1] + opts.indentStep;
          stack.push(col); emit('\n' + sp(col)); atLineStart = true;
        } else if (e.kind === 'dedent') {
          if (stack.length > 1) stack.pop();
        } else { // newline — sibling at the current column
          emit('\n' + sp(stack[stack.length - 1])); atLineStart = true;
        }
        continue;
      }
      if (e.t === 'compact') {
        // an inline indent: the next content sits on the SAME line; defer the column PUSH until that
        // content is emitted, so the pushed column is exactly where the inner indicator lands (the
        // lexer's compactIndicators geometry — `- - a` pushes column 2, where the second `-` sits).
        pendingCompact = true; continue;
      }
      const s = e.t === 'lit' ? e.value : e.text;
      if (s.length === 0) continue;
      if (pendingCompact) { emit(' '); stack.push(text.length - (text.lastIndexOf('\n') + 1)); pendingCompact = false; }   // inner COLUMN (in-line), not absolute offset
      else if (!atLineStart) emit(' ');                   // ordinary inline separator (`- a`, `key: v`)
      if (e.t === 'tok') emitTok(e.name, s); else emit(s);
      atLineStart = false;
    }
    return { text, tokens };
  }

  if (opts.mode === 'markup') {
    const noSpaceBefore = new Set([grammar.markup?.tagClose, grammar.markup?.closeMarker].filter(Boolean) as string[]);
    let prev = '';
    for (const e of ems) {
      if (e.t === 'struct' || e.t === 'compact') continue;
      const s = e.t === 'lit' ? e.value : e.text;
      if (s.length === 0) continue;
      const adjacent = prev === grammar.markup?.tagOpen || prev === grammar.markup?.closeMarker || noSpaceBefore.has(s) || prev === '';
      if (!adjacent) emit(' ');
      if (e.t === 'tok') emitTok(e.name, s); else emit(s);
      prev = s;
    }
    return { text, tokens };
  }

  // token-stream: join with a single space (always legal in a whitespace-insensitive language)
  let first = true;
  for (const e of ems) {
    if (e.t === 'struct' || e.t === 'compact') continue;
    const s = e.t === 'lit' ? e.value : e.text;
    if (s.length === 0) continue;
    if (!first) emit(' ');
    if (e.t === 'tok') emitTok(e.name, s); else emit(s);
    first = false;
  }
  return { text, tokens };
}

// Rewrite a YAML compact indicator's following `[Indent, …, Dedent]` so the indent renders INLINE
// (`- - a`) rather than next-line (`-\n  - a`). Both are legal and parse identically; the compact
// form is what reproduces monogram#24's column geometry. Applied to a copy of the emission list.
function compactify(ems: Emission[], compactLits: Set<string>): Emission[] {
  const out: Emission[] = [];
  for (let i = 0; i < ems.length; i++) {
    const e = ems[i];
    out.push(e);
    // a compact indicator literal (`-`/`?`) immediately followed by a struct indent → inline it
    if (e.t === 'lit' && compactLits.has(e.value)) {
      const nxt = ems[i + 1];
      if (nxt && nxt.t === 'struct' && nxt.kind === 'indent') { out.push({ t: 'compact' }); i++; }
    }
  }
  return out;
}

// ─── TOP LEVEL ────────────────────────────────────────────────────────────────────
export function generateInputs(grammar: CstGrammar, opts: GenOptions = {}): GenInput[] {
  const depth = opts.depth ?? 5;
  const cap = opts.cap ?? 6;
  const maxInputs = opts.maxInputs ?? 400;
  const fuzzRounds = opts.fuzzRounds ?? 300;
  const nestDepth = opts.nestDepth ?? 5;
  const seed = opts.seed ?? 12345;
  const w = new Walker(grammar, seed, cap);

  const mode: MatOptions['mode'] = grammar.indent ? 'indent' : grammar.markup ? 'markup' : 'token-stream';
  const matOpts: MatOptions = { mode, indentStep: 2 };
  const entry = grammar.rules[grammar.rules.length - 1];

  // wall-clock budget: the depth strategies (nest / dirnest) over a LARGE token-stream grammar (the
  // TS family — 50+ self-recursive rules, huge Pratt-expression alts) are heavy and add little, since
  // those grammars have no indent/markup depth bugs for the scope≡role check to find. Cap total time
  // so one driver stays tractable across all 7 languages; each per-rule loop checks it.
  const t0 = Date.now();
  const timeBudgetMs = opts.timeBudgetMs ?? 9000;
  const timeUp = () => Date.now() - t0 > timeBudgetMs;

  const seen = new Set<string>();
  const out: GenInput[] = [];
  const push = (ems: Emission[], strategy: string, rule: string) => {
    if (out.length >= maxInputs * 4) return;
    for (const variant of mode === 'indent' ? [ems, compactify(ems, w.compactLits)] : [ems]) {
      const { text, tokens } = materialize(grammar, variant, matOpts);
      if (!text.trim() || text.length > 2000 || seen.has(text)) continue;   // skip blank / over-long / duplicate
      seen.add(text);
      out.push({ text, tokens, strategy, rule });
    }
  };

  // 1) bounded-exhaustive from the entry rule: the canonical small shapes (every derivation to depth N)
  for (const ems of w.enumTop(entry.body, depth)) push(ems, 'exhaustive', entry.name);

  // The depth strategies (2,3) only matter for INDENTATION / MARKUP grammars — those are where a flat
  // highlighter loses to the stack-keeping parser (the monogram#23/#24 class). Token-stream grammars
  // are whitespace-insensitive and the flat grammar is exact, so their (large) self-recursive rule set
  // is skipped: it adds no depth coverage and would dominate the time budget.
  const depthMatters = !!(grammar.indent || grammar.markup);
  const recursive = depthMatters ? w.selfRecursive() : [];

  // 2) bounded-exhaustive ROOTED at each self-recursive rule: exercises every rule's own small shapes
  //    (round-tripped against that rule as the entry), incl. the FIRST level of self-embedding.
  for (const rn of recursive) {
    if (timeUp()) break;
    const r = w.ruleByName.get(rn)!;
    for (let d = 1; d <= Math.min(nestDepth, 3); d++) for (const ems of w.enumTop(r.body, d)) push(ems, `nest:${rn}@${d}`, rn);
  }

  // 3) directed nesting: a clean, deterministic nested chain of each self-recursive rule (with one
  //    inner sibling) at depth 1..N — monogram#24 is a BlockSequence inside a BlockSequence with an
  //    inner sibling (`- - a\n  - b\n- c`), which the un-biased capped enumeration starves.
  for (const rn of recursive) {
    if (timeUp()) break;
    const r = w.ruleByName.get(rn)!;
    for (let d = 1; d <= nestDepth; d++) push(w.nestChain(r.body, rn, d), `dirnest:${rn}@${d}`, rn);
  }

  // 4) fuzzing for deeper / wider structures (random production choices), rooted at the entry AND at
  //    each self-recursive rule so deep shapes are reached quickly.
  for (let i = 0; i < fuzzRounds; i++) push(w.fuzz(entry.body, depth + 2), 'fuzz', entry.name);
  for (const rn of recursive) {
    if (timeUp()) break;
    const r = w.ruleByName.get(rn)!;
    for (let i = 0; i < Math.ceil(fuzzRounds / 8); i++) push(w.fuzz(r.body, depth + 2), `fuzz:${rn}`, rn);
  }

  // 5) DIRECTED TOKEN COVERAGE — for each scoped token, the shortest legal context from the entry rule
  //    with several real samples of the token at its position. The bounded-exhaustive / fuzz strategies
  //    only reach a shallow structural skeleton, so an expression-position literal (every numeric, the
  //    private field) — exactly the scoped leaves the scope≡role judge checks — is otherwise NEVER
  //    generated. Each context is minimal (shortest path + minExpand filler), so this stays cheap even
  //    on the 50-rule TS grammar and needs no depth budget. The samples are guard-filtered (sampleVariants
  //    skips the leading-literal embeds for decimal-/anchor-led tokens, so `0x1F` is never mangled to `-0x1F`).
  for (const tok of w.coverableTokens(entry.name)) {
    if (timeUp()) break;
    // CLEAN samples only (no interesting-literal embeds): tokenCover's job is to make the token APPEAR in
    // a legal context, not to stress boundary collisions — that is the enum/fuzz strategies' role, where
    // the embed belongs. Prepending a boundary sigil to a sigil-led token (`<` + `#name`, `>` + `@name`)
    // just produces non-parsing junk here, so the directed contexts stay clean and ~100% legal.
    for (const text of sampleVariants(tok, { rand: w.rand, interesting: [] }, 6)) {
      push(w.coverToken(entry.body, tok.name, text), `tokenCover:${tok.name}`, entry.name);
    }
  }
  // a position-anchored leading-trivia token (a shebang) as a stand-alone first line — see prefixOnlyTokens.
  for (const tok of w.prefixOnlyTokens()) {
    for (const text of sampleVariants(tok, { rand: w.rand, interesting: [] }, 3)) {
      if (!/[\n\r]/.test(text)) push([{ t: 'tok', name: tok.name, text }], `tokenCover:${tok.name}`, entry.name);
    }
  }

  return out.slice(0, maxInputs);
}
