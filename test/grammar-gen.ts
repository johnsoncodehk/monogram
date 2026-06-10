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
//  Production strategies, all over the SAME walker — ALL DETERMINISTIC (no PRNG seed; the
//  generator is a pure function of the grammar, so a gap ledger is reproducible across commits):
//   • bounded-exhaustive — every derivation to a small depth N (provably complete at
//     small scope; this is what makes coverage `grammar × bound` instead of imagination).
//   • self-recursive nesting — for each rule that can contain itself, the nested shape
//     at depth 1..N. Deep self-embedding is exactly where a flat highlighter loses to
//     the stack-keeping parser (monogram#24 is `BlockSequence` inside `BlockSequence`).
//   • directed token coverage — the shortest legal context for every scoped token.
//   • systematic t-wise coverage (was random "fuzzing") — for deeper / wider structures: a
//     DETERMINISTIC mixed-radix enumeration over the grammar's CHOICE POINTS (which `alt`
//     branch, how many `quantifier`/`sep` reps). Round i → a choice vector derived from i
//     alone (no external seed). A FULL cartesian over the first few choice-point digits
//     covers every t-tuple (t≤digits) of (choice-point, value) among them BY CONSTRUCTION —
//     so it reaches INTERACTION shapes (an explicit key × a `[` in its scalar, monogram's
//     `[`-in-key leak) deterministically, not by the luck of a seed. Polynomial (C^D rounds),
//     never the exponential full derivation tree.
// ─────────────────────────────────────────────────────────────────────────────
import type { CstGrammar, RuleExpr, RuleDecl, TokenDecl, TokenPattern, TokenCharClassItem } from '../src/types.ts';
import { tokenPatternStartsWithDecimal, tokenPatternHasStartAnchor, tokenPatternBlockDelimiters } from '../src/token-pattern.ts';
import { createParser } from '../src/gen-parser.ts';

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
// `tokens` also carries the COMMENT WITNESSES injected by `injectComments` — a comment is a `skip:true`
// token the PARSER DROPS (it never becomes a CST leaf), so the scope≡role judge — which walks parser
// leaves — can never check a comment's highlighter scope (0% coverage). The generator therefore RECORDS
// each injected comment's span here as the GROUND TRUTH the judge grades the highlighter against; this
// is the FIRST consumer of `tokens` (see the comment arm in generative-detect.ts / generative.ts).
export interface GenInput {
  text: string;
  tokens: { start: number; end: number; name: string; text: string }[];
  strategy: string;
  rule: string;        // the top rule the derivation started from (entry, or a self-recursive rule)
}

// ── fixed-seed xorshift32. The generator has NO external randomness: every STRUCTURE choice is made
//    by the deterministic t-wise schedule (the `cover` strategy / mixed-radix chooser), and every
//    token-TEXT sample is indexed deterministically (`sample`/`sampleVariants` rotate on a `variant`
//    INDEX, never on `rand`). This PRNG is retained only so any future text-sampling path that wants a
//    tie-break has one; it is seeded from a FIXED constant so two `generateInputs(grammar)` calls are
//    byte-identical regardless of any `opts.seed` (which is now a NO-OP, kept for back-compat). ──
const FIXED_SEED = 0x9e3779b9 | 0;   // a constant (golden-ratio bits); NOT derived from time / opts.
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
// `blockEmbed` (indent grammars) are content literals that are STRUCTURAL in flow context but
// plain-scalar CONTENT in BLOCK context (the flow brackets `[`/`{`/`]`/`}`) — see the internal-embed
// note below; passed from the grammar's `indent.flowOpen`/`flowClose`, empty otherwise.
function sampleVariants(decl: TokenDecl, ctx: { rand: () => number; interesting: string[]; blockEmbed?: string[] }, n: number): string[] {
  const out = new Set<string>();
  // Cover every top-level alt branch: a token that is itself an alternation (hex/oct/bin/float
  // forms) must emit ALL its branches, not stop at branch 0 once `n` distinct samples are reached —
  // so the budget is at least the branch count, and the all-branch sweep is NOT capped by `out.size`.
  const budget = Math.max(n + 2, topAltBranches(decl.pattern) + 2);
  for (let v = 0; v < budget; v++) {
    const s = sample(decl.pattern, { ...ctx, variant: v });
    if (s !== null && s.length > 0) out.add(s);
  }
  // INTERNAL boundary-literal embeds (indent grammars with a block-context pattern): a flow bracket
  // (`[`/`{`) is a flow INDICATOR inside `[ ]`/`{ }`, but ordinary plain-scalar CONTENT in block
  // context — which is the whole reason a token carries a `blockPattern` (its body drops the flow
  // exclusions). The default `.pattern` (flow-restricted) can NEVER sample such a char, so a block
  // plain scalar like `k [y` — one scalar to the stack-keeping parser, but a phantom flow-open to a
  // flat grammar — is otherwise unreachable. Sample the base from the BLOCK pattern and splice a
  // bracket AFTER the head char (the head must stay a non-indicator, so the splice is mid-token, never
  // leading); the parser re-lexes the result as ONE scalar (verified by the round-trip). This makes
  // `? k [y : …` (the monogram `[`-in-key flow-leak) producible deterministically.
  const blockBase = decl.blockPattern ? (sample(decl.blockPattern, { ...ctx, variant: 0 }) ?? '') : '';
  if (blockBase.length >= 1 && ctx.blockEmbed?.length && !tokenPatternHasStartAnchor(decl) && !tokenPatternStartsWithDecimal(decl)) {
    const head = blockBase[0], tail = blockBase.slice(1) || 'y';
    for (const br of ctx.blockEmbed) {
      if (br.length !== 1 || /[\n\r]/.test(br)) continue;
      out.add(head + br + tail);          // glued mid-scalar (`k` + `[` + `y` → `k[y`)
      out.add(head + ' ' + br + tail);    // space-led bracket (`k [y`) — the prompt's exact shape
    }
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

// ─── DETERMINISTIC CHOICE SCHEDULE (t-wise systematic coverage) ────────────────────────────────────
// A `Chooser` answers each production CHOICE POINT during a `cover` walk, in WALK ORDER. Two kinds:
//   • `next(radix)`  — a STRUCTURAL choice (which alt branch · how many quantifier/sep reps). These drive
//      the t-wise cartesian: because the walk is deterministic given the answers, the k-th structural call
//      is always choice point k, so a Chooser IS a choice vector `(v_0, v_1, …)` and a derivation is a
//      function of it. The shape of the tree (key-vs-seq, explicit-vs-plain, nesting) lives here.
//   • `variant(n)` — a token-TEXT choice (which sampled lexeme for a token: `x` vs the boundary-embed
//      `--- x`, an int vs a float form). These do NOT change the tree SHAPE, only a leaf's bytes, so they
//      are kept on a SEPARATE fast counter — every token position (even a DEEP value scalar) then sweeps
//      its variants across rounds, instead of being frozen by a slow high mixed-radix digit. That is what
//      reliably lands a boundary-embed in VALUE position (`k: --- x`, monogram#23) — a structural-context
//      × text-variant interaction the cartesian reaches the context for and the text counter the variant.
export interface Chooser { next: (radix: number) => number; variant: (n: number) => number }

// One round's choice vector, as a MIXED-RADIX reading of a round index `i` (NO external seed):
//   structural digit k = ( ⌊ i / B^k ⌋ + k·rot ) mod radix_k
// `B` is the schedule BASE. Reading `i` low-digit-first means the FIRST choice points (the structurally
// decisive ones — which Node kind, key-vs-seq, explicit-vs-plain) move SLOWEST, so a contiguous block of
// rounds holds a fixed prefix while the deeper tail varies. Enumerating i over `B^D` (the coverSchedule
// loop) therefore walks the FULL cartesian product of the first D structural digits → every t-tuple
// (t ≤ D) of (choice-point, value) among the first D points appears in SOME round, BY CONSTRUCTION. That
// is the t-wise (here t≤D≈4) interaction guarantee — it covers an explicit-key × `[`-in-its-scalar pair,
// monogram's `[`-in-key leak, deterministically, with no luck. `rot` (a per-schedule offset) perturbs
// the deeper tail so a second/third pass reaches different deep shapes than the first; it does NOT affect
// the prefix cartesian (it shifts every digit by a constant, a relabelling of values, so all tuples among
// the first D points still occur — just at permuted round indices). Polynomial: B^D rounds, never the
// exponential whole derivation tree (a structural point past digit D simply reads its slow-moving high
// digit). The token-TEXT counter is an INDEPENDENT per-round walk index (j-th text choice = (i+j) mod n),
// so it cycles every position's variants fast regardless of structural depth.
function mixedRadixChooser(i: number, base: number, rot: number): Chooser {
  let k = 0;   // structural choice-point index (drives the mixed-radix cartesian)
  let j = 0;   // token-text choice index (independent fast counter)
  return {
    next(radix: number): number {
      if (radix <= 1) return 0;                              // a forced single option consumes a (no-op) digit slot
      const digit = Math.floor(i / Math.pow(base, k)) + k * rot;
      k++;
      return ((digit % radix) + radix) % radix;
    },
    variant(n: number): number {
      if (n <= 1) return 0;
      const idx = (i + j) % n;   // fast: sweeps each token position's variants across rounds, depth-agnostic
      j++;
      return idx;
    },
  };
}

// The deterministic schedule of choice vectors the `cover` strategy enumerates: the full cartesian over
// the first D digits (radix `base`) — `base^D` rounds — optionally repeated under a few `rot` offsets so
// the deep tail (past digit D) also varies. `rounds` caps it (polynomial, bounded). Pure function of its
// args: identical every call, so `generateInputs` is reproducible. Yields `Chooser`s in order.
function* coverSchedule(base: number, digits: number, rounds: number, rotations: number[]): Generator<Chooser> {
  const span = Math.pow(base, digits);
  let emitted = 0;
  for (const rot of rotations) {
    for (let i = 0; i < span && emitted < rounds; i++, emitted++) yield mixedRadixChooser(i, base, rot);
    if (emitted >= rounds) return;
  }
}

// ─── THE WALKER ──────────────────────────────────────────────────────────────────
export interface GenOptions {
  depth?: number;       // bounded-exhaustive derivation depth (rule-ref recursion)
  cap?: number;         // max alternatives kept at each combinator node (anti-explosion)
  maxInputs?: number;   // global cap on emitted inputs per rule
  fuzzRounds?: number;  // budget (cap) on systematic-coverage rounds — DETERMINISTIC choice vectors, not random
  seed?: number;        // NO-OP, retained for back-compat: the generator is a pure function of the grammar
  nestDepth?: number;   // self-recursive nesting depth
  timeBudgetMs?: number; // NO-OP, retained for back-compat: generation is deterministically work-capped (a wall-clock budget made the gate load-dependent)
}

class Walker {
  tokenByName = new Map<string, TokenDecl>();
  ruleByName = new Map<string, RuleDecl>();
  interesting: string[];
  structKind = new Map<string, 'indent' | 'dedent' | 'newline'>();
  compactLits: Set<string>;
  blockEmbed: string[];   // flow brackets (`[`/`{`/`]`/`}`) — flow indicators, but block-scalar CONTENT
  reachMap = new Map<string, Set<string>>();   // rule → every rule it can transitively reach
  tokenHostRules = new Map<string, string[]>(); // token name → rules whose body DIRECTLY references it
  ruleMin = new Map<string, Emission[] | null>();
  rand: () => number;
  cap: number;
  grammar: CstGrammar;
  budgetCalls = 0;          // anti-explosion: enum() is a tree walk; cap the work PER top-level call
  maxCalls = 60_000;
  enumTop(e: RuleExpr, budget: number): Emission[][] { this.budgetCalls = 0; return this.enum(e, budget); }

  constructor(grammar: CstGrammar, cap: number) {
    this.grammar = grammar;
    this.rand = rng(FIXED_SEED);   // FIXED — the walker is a pure function of the grammar (see rng note).
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
    // flow brackets are flow indicators in `[ ]`/`{ }` but plain-scalar CONTENT in block context — the
    // single-char ones seed the internal-embed that makes a `[`-in-block-scalar (`k [y`) producible.
    this.blockEmbed = [...(ind?.flowOpen ?? []), ...(ind?.flowClose ?? [])].filter((b) => b.length === 1);
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
          const vs = sampleVariants(this.tokenByName.get(e.name)!, { rand: this.rand, interesting: this.interesting, blockEmbed: this.blockEmbed }, 3);
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

  // ── DETERMINISTIC SYSTEMATIC derivation (replaces random fuzzing): one emission sequence whose every
  //    production CHOICE comes from a `Chooser`, not a PRNG. The walk is otherwise identical to the old
  //    fuzz, so the SAME structures are reachable — but reproducibly. A Chooser is consulted at each
  //    CHOICE POINT in walk order (alt branch · quantifier reps · sep reps · token-text variant); since
  //    the walk is deterministic given the chooser's outputs, choice point k is ALWAYS the k-th call, so
  //    a mixed-radix counter (slow-moving early digits, fast late ones) keeps a stable choice-point
  //    PREFIX while sweeping the tail — which is what yields t-wise coverage over the prefix (see
  //    coverSchedule). Forced to terminate at budget 0 (the minimal expansion), like fuzz. ──
  cover(e: RuleExpr, budget: number, ch: Chooser): Emission[] {
    // bounded `for`-push (NOT spread on a possibly-huge array → stack overflow + size blowup)
    const cappend = (out: Emission[], add: Emission[]) => { if (out.length < MAX_EMS) for (const x of add) out.push(x); };
    switch (e.type) {
      case 'literal': return [{ t: 'lit', value: e.value }];
      case 'ref': {
        if (this.isStruct(e.name)) return [{ t: 'struct', kind: this.structKind.get(e.name)! }];
        if (this.isToken(e.name)) {
          const vs = sampleVariants(this.tokenByName.get(e.name)!, { rand: this.rand, interesting: this.interesting, blockEmbed: this.blockEmbed }, 4);
          // pick a variant on the TOKEN-TEXT counter (ch.variant, not the structural ch.next), so the
          // token TEXT (a plain scalar `--- x` vs `x`, a number's int vs float form) is swept fast at EVERY
          // position regardless of structural depth — see the Chooser note (this lands #23's `k: --- x`).
          return [{ t: 'tok', name: e.name, text: vs.length ? vs[ch.variant(vs.length)] : 'x' }];
        }
        if (budget <= 0) return this.ruleMin.get(e.name) ?? [];
        return this.cover(this.ruleByName.get(e.name)!.body, budget - 1, ch);
      }
      case 'seq': { const out: Emission[] = []; for (const it of e.items) cappend(out, this.cover(it, budget, ch)); return out; }
      case 'alt': {
        if (budget <= 0) { const m = this.minExpand(e); if (m) return m; }      // no budget → shortest, no choice consumed
        return this.cover(e.items[ch.next(e.items.length)], budget, ch);        // CHOICE POINT: which branch
      }
      case 'quantifier': {
        // CHOICE POINT: how many reps. `?`→{0,1} (radix 2), `*`/`+`→{0..2}/{1..3} (radix 3). At budget 0
        // the count is forced to the minimum (radix 1 → digit is a fixed no-op, keeping schedules aligned).
        const lo = e.kind === '+' ? 1 : 0;
        const radix = budget <= 0 ? 1 : (e.kind === '?' ? 2 : 3);
        const reps = lo + ch.next(radix);
        const out: Emission[] = []; for (let i = 0; i < reps; i++) cappend(out, this.cover(e.body, budget - 1, ch)); return out;
      }
      case 'group': return this.cover(e.body, budget, ch);
      case 'sep': {
        // CHOICE POINT: element count (≥1). radix 3 → 1..3 elements; forced to 1 at budget 0.
        const reps = 1 + (budget <= 0 ? 0 : ch.next(3)); const out: Emission[] = [];
        for (let i = 0; i < reps; i++) { if (i) out.push({ t: 'lit', value: e.delimiter }); cappend(out, this.cover(e.element, budget - 1, ch)); }
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

  // ── DIRECTED MARKUP SELF-CLOSE-WITH-ATTRIBUTE (markup grammars only) ──────────────────────────────
  // The minimal self-closing element carrying ONE quoted attribute: `<name attr="v"/>`. Built DIRECTLY
  // from `grammar.markup` (tagOpen / attributeAssign / attributeQuotes / closeMarker / tagClose) plus two
  // generically-discovered tokens — a NAME token (an `identifier` token: the tag + attribute name) and a
  // QUOTED-VALUE token (a `string` token whose sample opens with an `attributeQuote`) — so it stays
  // language-agnostic (no `<`/`/`/HTML hardcoded; a markup grammar with different delimiters yields its
  // own shape). The un-biased bounded-exhaustive enumeration STARVES this combination at a small `cap`
  // (the cross of "an attribute has a quoted value" × "the optional self-close `/` fired" is past the
  // first few derivations), so — exactly like nestChain forces a starved nesting and coverToken a starved
  // token — this forces it deterministically. Its tight rendering (`name="v"/>` flush) is what exposes
  // the flat grammar mis-scoping the self-close `/` as unquoted-value content (a STANDING flat-TM limit).
  // Returns [] when the grammar lacks the needed tokens (no string/identifier token) — then it is a no-op.
  markupSelfCloseAttr(): Emission[] {
    const mk = this.grammar.markup;
    if (!mk || !mk.closeMarker) return [];
    const nameTok = this.grammar.tokens.find((t) => t.identifier);   // the tag / attribute NAME token
    // a string token whose conservative sample is a QUOTED value (opens with one of the attribute quotes)
    const quotes = mk.attributeQuotes ?? ['"', "'"];
    const valTok = this.grammar.tokens.find((t) => {
      if (!t.string && !t.scope) return false;
      const s = sample(t.pattern, { rand: this.rand, interesting: [], variant: 0 });
      return s !== null && s.length >= 2 && quotes.includes(s[0]);
    });
    if (!nameTok || !valTok) return [];
    const nameTxt = sample(nameTok.pattern, { rand: this.rand, interesting: [], variant: 0 }) || 'a';
    const valTxt = sample(valTok.pattern, { rand: this.rand, interesting: [], variant: 0 })!;
    const assign = mk.attributeAssign ?? '=';
    return [
      { t: 'lit', value: mk.tagOpen },
      { t: 'tok', name: nameTok.name, text: nameTxt },     // tag name
      { t: 'tok', name: nameTok.name, text: nameTxt },     // attribute name
      { t: 'lit', value: assign },
      { t: 'tok', name: valTok.name, text: valTxt },       // quoted attribute value
      { t: 'lit', value: mk.closeMarker },                 // self-close marker
      { t: 'lit', value: mk.tagClose },
    ];
  }

  // DIRECTED RAW-TEXT / VOID element using the SPECIFIC declared tag literals (`grammar.markup.rawText.tags`
  // / `voidTags`), NOT a generic identifier sample. The un-biased enumeration + tokenCover only ever
  // materialise a generic placeholder tag name (`a`), so the SPECIAL-tag behaviours — a case-insensitive
  // raw-text region, a void element — are NEVER exercised by generation. This forces them: `<script><b</script>`
  // (a raw-text body carrying a would-be `<b` tag the region must keep as content) and `<br>`. Combined with
  // the tag-name CASE variation in `push`, this is what produces `<SCRIPT><b</SCRIPT>` — the witness for a
  // case-sensitive raw-text region. Returns [] when the grammar declares no rawText/void tags.
  markupRawText(): Emission[][] {
    const mk = this.grammar.markup;
    const nameTok = this.grammar.tokens.find((t) => t.identifier);
    if (!mk || !nameTok) return [];
    const open = mk.tagOpen, closeTag = mk.tagClose, closeMk = mk.closeMarker ?? '';
    const out: Emission[][] = [];
    // Close emitted as SEPARATE open + closeMarker + name (NOT `</` combined) so the materializer GLUES
    // it — `<`(tagOpen)`/`(prev=tagOpen→adjacent)`script`(prev=closeMarker→adjacent)`>` = `</script>`. A
    // combined `</` lit would take a space before the name (`</ script`) and the lexer's `</script` close
    // matcher would miss it, leaving the element unclosed.
    for (const tag of mk.rawText?.tags ?? []) out.push([
      { t: 'lit', value: open }, { t: 'tok', name: nameTok.name, text: tag }, { t: 'lit', value: closeTag },
      { t: 'lit', value: open + 'b' },                                          // raw-text body: a would-be `<b` tag
      { t: 'lit', value: open }, { t: 'lit', value: closeMk }, { t: 'tok', name: nameTok.name, text: tag }, { t: 'lit', value: closeTag },
    ]);
    for (const tag of (mk.voidTags ?? []).slice(0, 1)) out.push([
      { t: 'lit', value: open }, { t: 'tok', name: nameTok.name, text: tag }, { t: 'lit', value: closeTag },
    ]);
    return out;
  }

  // The leading literal of an alt arm's seq/group spine (the indicator a `? …`/`- …` arm starts with).
  private armLeadLiteral(e: RuleExpr): string | null {
    if (e.type === 'literal') return e.value;
    if (e.type === 'seq') return e.items.length ? this.armLeadLiteral(e.items[0]) : null;
    if (e.type === 'group') return this.armLeadLiteral(e.body);
    return null;
  }
  private exprContainsLiteral(e: RuleExpr, v: string): boolean {
    switch (e.type) {
      case 'literal': return e.value === v;
      case 'seq': case 'alt': return e.items.some((i) => this.exprContainsLiteral(i, v));
      case 'quantifier': case 'group': case 'not': return this.exprContainsLiteral(e.body, v);
      case 'sep': return this.exprContainsLiteral(e.element, v);
      default: return false;
    }
  }
  // The explicit-key indicator of an indent grammar (YAML `?`), found GENERICALLY: the `compactIndicator`
  // that heads a rule arm which ALSO carries the key/value separator (`? key : value`), distinguishing it
  // from the block-SEQUENCE indicator (`-`, whose arm leads to an item, not a `:` pair). Config-derived
  // (compactIndicators × keyValueSeparator), so no token/rule name is hardcoded; null if none qualifies.
  explicitKeyIndicator(): string | null {
    const ind = this.grammar.indent; if (!ind?.compactIndicators) return null;
    const kv = ind.keyValueSeparator ?? ':';
    const ci = new Set(ind.compactIndicators);
    for (const r of this.grammar.rules) {
      const arms = r.body.type === 'alt' ? r.body.items : [r.body];
      for (const arm of arms) { const lead = this.armLeadLiteral(arm); if (lead && ci.has(lead) && this.exprContainsLiteral(arm, kv)) return lead; }
    }
    return null;
  }

  // ── DIRECTED INDENT EXPLICIT-KEY WITH A FLOW-BRACKET PLAIN SCALAR (indent grammars only) ───────────
  // The shape `? k [y :\n  - p\n  - q`: an EXPLICIT-key entry whose KEY is a plain scalar containing a flow
  // bracket, with a block-SEQUENCE value. To the stack-keeping parser the key is ONE plain scalar (its
  // `blockPattern` admits `[`/`{` outside flow) and the `-` items are sequence indicators; a flat grammar
  // instead opens a phantom flow at the `[` that never closes, so the value `-`s leak to the key scope.
  // Two structural facts STARVE this in the un-biased strategies: a plain-scalar key in EXPLICIT position
  // is itself rare (the cover walk reaches `? *alias :`/`? {flow} :`/`?\n indented`, but not `? plain :`),
  // and the bracket must additionally land in THAT key — so it is forced here, deterministically, the
  // indent analogue of markupSelfCloseAttr. All pieces are config-derived (the explicit-key indicator, the
  // key/value separator, the flow brackets, the seq indicator = the OTHER compactIndicator, and the indent
  // struct tokens), with the scalar drawn from a `blockPattern` token — no YAML token/rule name hardcoded.
  // Returns [] when the grammar lacks the config (no explicit-key indicator / flow brackets / block scalar).
  indentExplicitKeyBracket(): Emission[] {
    const ind = this.grammar.indent; if (!ind) return [];
    const qmark = this.explicitKeyIndicator(); if (!qmark) return [];
    const bracket = this.blockEmbed[0]; if (!bracket) return [];                  // a flow-bracket content char
    const kv = ind.keyValueSeparator ?? ':';
    const seqInd = (ind.compactIndicators ?? []).find((c) => c !== qmark);        // the block-sequence indicator
    if (!seqInd) return [];
    // a block plain-scalar token whose blockPattern admits the bracket (the KEY), and one for the items.
    const scalarTok = this.grammar.tokens.find((t) => t.blockPattern && t.scope); if (!scalarTok) return [];
    const head = sample(scalarTok.blockPattern!, { rand: this.rand, interesting: [], variant: 0 }) || 'k';
    const keyTxt = head[0] + ' ' + bracket + (head.slice(1) || 'y');             // `k [y` — bracket mid-scalar
    const itemTxt = (sample(scalarTok.blockPattern!, { rand: this.rand, interesting: [], variant: 0 }) || 'p');
    return [
      { t: 'lit', value: qmark },                                                // `?`
      { t: 'tok', name: scalarTok.name, text: keyTxt },                          // `k [y`
      { t: 'lit', value: kv },                                                   // `:`
      { t: 'struct', kind: 'indent' },                                          // block value, more-indented
      { t: 'lit', value: seqInd }, { t: 'tok', name: scalarTok.name, text: itemTxt },        // `- p`
      { t: 'struct', kind: 'newline' },                                         // sibling item
      { t: 'lit', value: seqInd }, { t: 'tok', name: scalarTok.name, text: itemTxt },        // `- p`
      { t: 'struct', kind: 'dedent' },
    ];
  }

  // ── DIRECTED BLOCK SCALAR (indent grammars with a block-scalar config) ─────────────────────────────
  // A YAML block scalar `|\n  body\n  more`: an introducer (`|`/`>`, +optional chomping/indent indicators)
  // then verbatim more-indented lines emitted as ONE token (like raw text, but bounded by indentation, not
  // a close tag). Its token is `never()` (the LEXER emits it from indentation state), so `sample()` yields
  // null and the ordinary strategies NEVER produce it — leaving its scope (`string.unquoted.block`) at 0%
  // coverage. This synthesizes it directly from `indent.blockScalar` (the introducers + token name) as a
  // single multi-line tok at the document root (the minimal legal frame — a bare block scalar parses as a
  // one-token document). Body lines are STRICTLY more-indented (the `indentWidth` columns) and plain words,
  // never a col-0 `documentMarker` (`---`/`...`), which would terminate the scalar early (a doc boundary
  // outranks indentation). Emitted as one tok (not a `lit`+struct), so `compactify` — which only rewrites a
  // compact-indicator literal followed by a struct indent — leaves it untouched. Returns [] without config.
  indentBlockScalar(indentWidth: number): Emission[] {
    const bs = this.grammar.indent?.blockScalar; if (!bs || !bs.introducers.length) return [];
    const tok = this.grammar.tokens.find((t) => t.name === bs.token); if (!tok) return [];
    const pad = ' '.repeat(Math.max(1, indentWidth));
    const markers = new Set(bs.documentMarkers ?? []);
    // a plain body word that is NOT a document marker (so it can't terminate the scalar at col-0; here it is
    // indented anyway, but keep it marker-free for safety) — derived from a block plain-scalar token sample.
    const scalarTok = this.grammar.tokens.find((t) => t.blockPattern && t.scope);
    let body = (scalarTok && sample(scalarTok.blockPattern!, { rand: this.rand, interesting: [], variant: 0 })) || 'body';
    if (markers.has(body)) body = body + 'x';
    const intro = bs.introducers[0];                                            // `|`
    return [{ t: 'tok', name: bs.token, text: `${intro}\n${pad}${body}\n${pad}${body}` }];
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

// ─── COMMENT INJECTION + WITNESSES (the LAST coverage hole: comment scopes) ─────────────────────────
// A comment is a `skip:true` token: the parser DROPS it (it never becomes a CST leaf), so the scope≡role
// judge — which walks the parser's leaves — can NEVER reach a comment's highlighter scope. Injecting a
// comment into the text does not, by itself, close that hole; the JUDGE must compare the highlighter
// against a WITNESS the GENERATOR records (not against a parser leaf). This block is the generator side:
// it discovers the comment delimiters from the grammar's OWN config (no `//`/`#`/`<!--` hardcoded),
// injects a comment at a SAFE, DETERMINISTIC position per materialization mode, and records the comment's
// span as a witness in `GenInput.tokens`. A re-parse-and-drop net keeps only injections that still parse.

// The comment delimiters + the witness expectation, discovered GENERICALLY from the grammar config — the
// SAME comment-classification gen-tm uses (`flags.includes('skip')` OR a `comment.`-prefixed scope), so
// the set of `names` is exactly the tokens the highlighter paints with a `comment.*` scope. `mode` selects
// the injection geometry (block delimiters sit mid-line; a line comment is end-of-line only). `names` lets
// the judge filter the witnesses back out of `tokens`. Returns null when the grammar declares no comment.
export interface CommentSpec {
  open: string;          // the opening delimiter / line introducer (`/*`, `<!--`, `#`)
  close: string;         // the closing delimiter (`*/`, `-->`); '' for a line comment
  witnessName: string;   // the comment token's name, recorded on each witness
  names: Set<string>;    // every comment-token name (so the judge can filter `tokens` to comment witnesses)
  mode: 'token-stream' | 'indent' | 'markup';
}
export function commentSpec(grammar: CstGrammar): CommentSpec | null {
  // every token the highlighter scopes as a comment (gen-tm's exact rule: a skip token, or an explicit
  // comment.* scope). A skip token with NO `.scope` (TS/JS `BlockComment`/`LineComment`) is INCLUDED —
  // gen-tm classifies it `comment.block`/`comment.line` from its flags, so the highlighter paints it.
  const isCommentTok = (t: TokenDecl) => t.flags.includes('skip') || (t.scope?.startsWith('comment.') ?? false);
  const names = new Set(grammar.tokens.filter(isCommentTok).map((t) => t.name));
  if (!names.size) return null;

  const mode: CommentSpec['mode'] = grammar.indent ? 'indent' : grammar.markup ? 'markup' : 'token-stream';
  if (mode === 'markup') {
    const c = grammar.markup!.comment; if (!c) return null;
    return { open: c.open, close: c.close, witnessName: c.token, names, mode };
  }
  if (mode === 'indent') {
    const intro = grammar.indent!.comment; if (!intro) return null;
    // the comment TOKEN whose pattern starts with the introducer (YAML `#…`) — its `.scope` is the one
    // the highlighter paints; a line comment (no closing delimiter) is EOL-only.
    const tok = grammar.tokens.find((t) => isCommentTok(t) && (t.scope?.startsWith('comment.') ?? false));
    return { open: intro, close: '', witnessName: tok?.name ?? [...names][0], names, mode };
  }
  // token-stream: a skip comment token DELIMITED on both sides (a block comment) — the only form safe to
  // splice at an inter-token space in whitespace-insensitive text (a line comment would swallow the rest
  // of the line; the generated text has no newlines, so it would eat the whole document). Prefer the
  // SHORTEST opener (a plain `/*` over a doc `/**`), so the witness is an ordinary block comment. Returns
  // null when the language has only line comments (no block form) — then no safe token-stream injection.
  const blockToks = grammar.tokens.filter((t) => isCommentTok(t) && tokenPatternBlockDelimiters(t));
  blockToks.sort((a, b) => tokenPatternBlockDelimiters(a)![0].length - tokenPatternBlockDelimiters(b)![0].length);
  if (!blockToks.length) return null;
  const [open, close] = tokenPatternBlockDelimiters(blockToks[0])!;
  return { open, close, witnessName: blockToks[0].name, names, mode };
}

// Splice ONE comment into `text` at the first SAFE position for the mode (a FIXED rule — no randomness,
// so the generator stays a pure function of the grammar), returning the new text + the comment's span.
// Position rules (each measured to round-trip; the caller's re-parse net drops any that don't):
//   • token-stream — at the first inter-token SPACE (a space with a non-space, non-newline neighbour on
//     each side): a no-newline block comment there is 100% safe in whitespace-insensitive code.
//   • indent (YAML) — appended at END-OF-LINE of the first non-blank line that doesn't already carry the
//     comment introducer: a `# c` end-of-line comment is safe OUTSIDE flow / a block-scalar body, which
//     the re-parse net rejects (a mid-line `#` is content in flow / ends a plain scalar, so never mid-line).
//   • markup — right after the first `tagClose` (`>`): comment text BETWEEN tags / in content is safe;
//     never inside a tag (the re-parse net rejects an in-tag splice).
// The body is a minimal `' c '` (space-padded), legal in every comment grammar. `tagClose` (markup only)
// is the grammar's tag-close delimiter (`>`), passed in so the function bakes in no HTML-specific literal.
// Returns null when no safe position exists in this particular input (then no comment variant is produced).
function injectComment(text: string, spec: CommentSpec, tagClose: string, mk?: CstGrammar['markup']): { text: string; start: number; end: number; comment: string } | null {
  if (spec.mode === 'token-stream') {
    const comment = spec.open + ' c ' + spec.close;     // `/* c */`
    for (let i = 1; i < text.length - 1; i++) {
      if (text[i] === ' ' && text[i - 1] !== ' ' && text[i + 1] !== ' ' && text[i - 1] !== '\n' && text[i + 1] !== '\n') {
        const start = i + 1;                            // splice the comment + a trailing space after the space
        return { text: text.slice(0, start) + comment + ' ' + text.slice(start), start, end: start + comment.length, comment };
      }
    }
    return null;
  }
  if (spec.mode === 'indent') {
    const comment = spec.open + ' c';                   // `# c`
    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li];
      if (!ln.trim() || ln.includes(spec.open)) continue;        // skip blank / already-commented lines
      const prefixLen = lines.slice(0, li).reduce((a, l) => a + l.length + 1, 0);   // chars before this line (+\n each)
      const start = prefixLen + ln.length + 1;          // after the line text + the joining space
      lines[li] = ln + ' ' + comment;
      return { text: lines.join('\n'), start, end: start + comment.length, comment };
    }
    return null;
  }
  // markup — after a tagClose (`>`), but NEVER inside a RAW-TEXT element body: a markup comment there is
  // raw-text content (e.g. inside `<script>`/`<style>`), not a comment, so the witness would be a false
  // divergence (the highlighter correctly scopes it as embedded/raw content, the parser keeps no comment).
  // Find the first `>` whose tag is NOT an OPEN raw-text element. All grammar-derived (mk / rawText.tags).
  const comment = spec.open + ' c ' + spec.close;       // `<!-- c -->`
  if (!tagClose) return null;
  const tagOpen = mk?.tagOpen ?? '', closeMk = mk?.closeMarker ?? '';
  const rawSet = new Set((mk?.rawText?.tags ?? []).map((t) => t.toLowerCase()));
  for (let from = 0; ; ) {
    const gt = text.indexOf(tagClose, from);
    if (gt < 0) return null;
    const lt = tagOpen ? text.lastIndexOf(tagOpen, gt) : -1;          // the tagOpen this `>` pairs with
    const inner = lt >= 0 ? text.slice(lt + tagOpen.length, gt) : ''; // `script` / `/script` / `a attr="x"`
    const isClose = !!closeMk && inner.startsWith(closeMk);
    const name = (isClose ? inner.slice(closeMk.length) : inner).match(/^[A-Za-z][A-Za-z0-9]*/)?.[0]?.toLowerCase() ?? '';
    if (!isClose && rawSet.has(name)) { from = gt + tagClose.length; continue; }   // opens a raw-text body → skip
    const start = gt + tagClose.length;
    return { text: text.slice(0, start) + comment + text.slice(start), start, end: start + comment.length, comment };
  }
}

// ─── MATERIALIZE: emissions → text + token spans ──────────────────────────────────
// The per-language structural-token materialization hook. Token-stream grammars join with a
// space (whitespace-insensitive); indentation grammars (YAML) render struct emissions through an
// indent STACK that mirrors the lexer (newline = same-column sibling, indent = deeper block,
// compact = an inline indent for `- - a`); markup grammars keep tag punctuation adjacent.
// `tight` (markup only) ALSO glues the attribute-internal punctuation — `name="value"` with no
// spaces around the `attributeAssign`/quotes — so a quoted value sits FLUSH against the self-close
// `/>` (the WHATWG-canonical `<img src="a"/>`). That adjacency is what the spaced rendering never
// forms, and it is exactly where a flat TextMate grammar mis-scopes the `/` (it reads the closing
// quote then the `/` as an unquoted-value char, not tag punctuation). A SECOND, legal rendering of
// the same emission list — the markup analogue of indent's compactify — in the exploratory tier.
interface MatOptions { mode: 'token-stream' | 'indent' | 'markup'; indentStep: number; tight?: boolean }

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
    const assign = grammar.markup?.attributeAssign;   // `=`; in tight mode it glues `name=value`
    let prev = '';
    for (const e of ems) {
      if (e.t === 'struct' || e.t === 'compact') continue;
      const s = e.t === 'lit' ? e.value : e.text;
      if (s.length === 0) continue;
      // TIGHT also glues the attribute `=` to its name and value: `name=` (cur is the assign) and
      // `=value` (prev was the assign). Combined with `noSpaceBefore` already gluing the value→`/>`,
      // this renders `<img src="a"/>`. The inter-attribute / name boundary still takes a space (the
      // value isn't an assign, the next name isn't), so `a="x" b="y"` stays well-formed.
      const tightGlue = !!opts.tight && !!assign && (s === assign || prev === assign);
      const adjacent = prev === grammar.markup?.tagOpen || prev === grammar.markup?.closeMarker || noSpaceBefore.has(s) || tightGlue || prev === '';
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
// UPPERCASE the tag NAMES in a markup string — the letters right after `tagOpen` (`<`) or
// `tagOpen`+`closeMarker` (`</`). Tag names are case-insensitive in markup (the lexer folds case), so this
// is an equally-legal variant; `<!`-led forms (comments / doctype) start with a non-letter and are untouched.
// Derived from `grammar.markup` (tagOpen / closeMarker) — no hardcoded `<`.
function caseVaryTags(grammar: CstGrammar, text: string): string {
  const m = grammar.markup; if (!m) return text;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${esc(m.tagOpen)}${m.closeMarker ? `${esc(m.closeMarker)}?` : ''})([A-Za-z][A-Za-z0-9]*)`, 'g');
  return text.replace(re, (_full, open: string, name: string) => open + name.toUpperCase());
}

export function generateInputs(grammar: CstGrammar, opts: GenOptions = {}): GenInput[] {
  const depth = opts.depth ?? 5;
  const cap = opts.cap ?? 6;
  const maxInputs = opts.maxInputs ?? 400;
  // `fuzzRounds` is honoured as the BUDGET (cap on systematic-coverage rounds), but the rounds are now
  // DETERMINISTIC choice vectors, not random draws. `opts.seed` is a NO-OP (kept for back-compat): the
  // generator is a pure function of the grammar, so two calls — with any seed or none — are identical.
  const coverRounds = opts.fuzzRounds ?? 300;
  const nestDepth = opts.nestDepth ?? 5;
  const w = new Walker(grammar, cap);

  const mode: MatOptions['mode'] = grammar.indent ? 'indent' : grammar.markup ? 'markup' : 'token-stream';
  const matOpts: MatOptions = { mode, indentStep: 2 };
  const entry = grammar.rules[grammar.rules.length - 1];

  // NO wall-clock budget: every strategy below is bounded by DETERMINISTIC work caps
  // (enumTop's budgetCalls, coverRounds, maxInputs, per-token sample counts), and the
  // depth strategies only run for indent/markup grammars at all (depthMatters) — the
  // whole 7-grammar sweep measures ~5s on a calm machine, worst single grammar ~4s.
  // A Date.now() budget USED to sit here and made the GATE load-dependent: under a
  // saturated machine the yaml depth strategies got cut mid-walk, the #23/#24 witness
  // shapes silently vanished from the corpus, and mustCover failed with no code change
  // anywhere. A correctness gate must be a pure function of the grammar.

  const seen = new Set<string>();
  const out: GenInput[] = [];
  // The render JOBS for one emission list: each pairs an emission-variant with materialize options and
  // the strategy label to file the resulting input under. Most modes have ONE job (the canonical
  // rendering, same strategy). Two modes add a SECOND, equally-legal rendering of the same emissions:
  //  • indent → a compactified copy (`- - a` inline), SAME strategy (a correct shape, still a gate).
  //  • markup → a TIGHT copy (`name="value"/>` flush), filed in the EXPLORATORY (`fuzz`) tier. The
  //    tight adjacency is where a flat grammar mis-scopes the self-close `/` — a STANDING flat-TM
  //    limit in the unfixed grammar, not a regression of a structured shape — so, like a gnarly fuzz
  //    derivation, it is report-only (`isGated` keys off the `fuzz` prefix). The spaced rendering keeps
  //    the original strategy, so the structured round-trip guarantee is untouched.
  const renderJobs = (ems: Emission[], strategy: string): { variant: Emission[]; mat: MatOptions; strat: string }[] => {
    if (mode === 'indent') return [ems, compactify(ems, w.compactLits)].map((variant) => ({ variant, mat: matOpts, strat: strategy }));
    if (mode === 'markup') return [
      { variant: ems, mat: matOpts, strat: strategy },
      { variant: ems, mat: { ...matOpts, tight: true }, strat: `fuzz:tight:${strategy}` },
    ];
    return [{ variant: ems, mat: matOpts, strat: strategy }];
  };
  const push = (ems: Emission[], strategy: string, rule: string) => {
    if (out.length >= maxInputs * 4) return;
    for (const job of renderJobs(ems, strategy)) {
      const { text, tokens } = materialize(grammar, job.variant, job.mat);
      if (!text.trim() || text.length > 2000 || seen.has(text)) continue;   // skip blank / over-long / duplicate
      seen.add(text);
      out.push({ text, tokens, strategy: job.strat, rule });
      // markup: a CASE-VARIED copy (UPPERCASE the tag NAMES). Tag-name matching is case-INSENSITIVE (the
      // lexer folds case), so this is an equally-legal shape — but the materializer only ever emits the
      // grammar's lowercase literals, so without this the generator NEVER produces `<SCRIPT>` and is blind
      // to a parser↔highlighter case asymmetry (a case-sensitive highlighter region the lexer folds past —
      // exactly the mixed-case raw-text bug). UPPERCASE preserves length, so the token offsets stay valid.
      if (mode === 'markup') {
        const up = caseVaryTags(grammar, text);
        if (up !== text && !seen.has(up)) {
          seen.add(up);
          out.push({ text: up, tokens: tokens.map((t) => ({ ...t, text: up.slice(t.start, t.end) })), strategy: `case:${job.strat}`, rule });
        }
      }
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
    const r = w.ruleByName.get(rn)!;
    for (let d = 1; d <= Math.min(nestDepth, 3); d++) for (const ems of w.enumTop(r.body, d)) push(ems, `nest:${rn}@${d}`, rn);
  }

  // 3) directed nesting: a clean, deterministic nested chain of each self-recursive rule (with one
  //    inner sibling) at depth 1..N — monogram#24 is a BlockSequence inside a BlockSequence with an
  //    inner sibling (`- - a\n  - b\n- c`), which the un-biased capped enumeration starves.
  for (const rn of recursive) {
    const r = w.ruleByName.get(rn)!;
    for (let d = 1; d <= nestDepth; d++) push(w.nestChain(r.body, rn, d), `dirnest:${rn}@${d}`, rn);
  }

  // 4) SYSTEMATIC t-wise coverage for deeper / wider structures (DETERMINISTIC choice vectors, was random
  //    fuzzing), rooted at the entry AND at each self-recursive rule. The schedule is a full mixed-radix
  //    cartesian over the first `COVER_DIGITS` choice points at `COVER_BASE` values each (covers every
  //    t-tuple, t≤COVER_DIGITS, of those points BY CONSTRUCTION → reaches an explicit-key × `[`-in-scalar
  //    interaction without a seed), with a few rotation offsets perturbing the deeper tail. `coverRounds`
  //    caps it — polynomial (COVER_BASE^COVER_DIGITS ≈ 256), never the exponential whole derivation tree.
  // NB the emitted strategy key stays `fuzz` (the driver buckets it as the EXPLORATORY tier — deeper/wider
  // shapes that legitimately reach STANDING flat-TM frontier limits, so #24 is report-only there; the
  // STRUCTURED strategies remain the by-construction gate). Only the MECHANISM changed (deterministic, not
  // random); the bucket's meaning is the same, so the driver's gating semantics are untouched.
  const COVER_BASE = 4, COVER_DIGITS = 4, ROTS = [0, 1, 2];
  for (const ch of coverSchedule(COVER_BASE, COVER_DIGITS, coverRounds, ROTS)) push(w.cover(entry.body, depth + 2, ch), 'fuzz', entry.name);
  for (const rn of recursive) {
    const r = w.ruleByName.get(rn)!;
    for (const ch of coverSchedule(COVER_BASE, COVER_DIGITS, Math.ceil(coverRounds / 8), ROTS)) push(w.cover(r.body, depth + 2, ch), `fuzz:${rn}`, rn);
  }

  // 5) DIRECTED TOKEN COVERAGE — for each scoped token, the shortest legal context from the entry rule
  //    with several real samples of the token at its position. The bounded-exhaustive / fuzz strategies
  //    only reach a shallow structural skeleton, so an expression-position literal (every numeric, the
  //    private field) — exactly the scoped leaves the scope≡role judge checks — is otherwise NEVER
  //    generated. Each context is minimal (shortest path + minExpand filler), so this stays cheap even
  //    on the 50-rule TS grammar and needs no depth budget. The samples are guard-filtered (sampleVariants
  //    skips the leading-literal embeds for decimal-/anchor-led tokens, so `0x1F` is never mangled to `-0x1F`).
  for (const tok of w.coverableTokens(entry.name)) {
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

  // 6) DIRECTED MARKUP SELF-CLOSE-WITH-ATTRIBUTE (markup grammars) — `<name attr="v"/>`. The un-biased
  //    enumeration starves the quoted-attribute × self-close cross at a small cap, so this forces it (the
  //    markup analogue of nestChain/tokenCover). Filed in the EXPLORATORY (`fuzz`) tier: even the SPACED
  //    rendering puts the quoted value FLUSH against the self-close `/` (the `/` is structural punctuation,
  //    always glued), and that flush value→`/` adjacency is exactly the STANDING flat-TM limit (the grammar
  //    reads the `/` as unquoted-value content) — a real highlighter bug in the unfixed grammar, not a
  //    regression of a by-construction shape, so it is report-only like a gnarly fuzz derivation, not a gate.
  if (mode === 'markup') {
    const sc = w.markupSelfCloseAttr();
    if (sc.length) push(sc, 'fuzz:markupSelfClose', entry.name);
    // raw-text / void elements with the SPECIFIC tag literals (+ the case-varied UPPERCASE copy from push)
    // → exercises the case-insensitive raw-text region the generic-placeholder enumeration never reached.
    for (const ems of w.markupRawText()) push(ems, 'markupRawText', entry.name);
  }

  // 7) DIRECTED INDENT EXPLICIT-KEY-WITH-BRACKET-SCALAR (indent grammars) — `? k [y :\n  - p\n  - q`. The
  //    un-biased strategies starve a plain-scalar explicit key (let alone one carrying a `[`), so this forces
  //    it — the indent analogue of markupSelfCloseAttr. Filed EXPLORATORY (`fuzz:`): it deliberately stresses
  //    the block-vs-flow-stack limit a flat grammar lacks (the phantom flow a `[`-in-key opens), so any
  //    divergence is a STANDING limit of the unfixed grammar, report-only, not a by-construction gate.
  if (mode === 'indent') {
    const ek = w.indentExplicitKeyBracket();
    if (ek.length) push(ek, 'fuzz:explicitKeyBracket', entry.name);
    // a block scalar (`|\n  body`): its token is lexer-emitted (never() pattern), so no ordinary strategy
    // produces it — synthesize one so its `string.unquoted.block` scope is covered. A clean structured
    // shape that round-trips (a one-token document), so it is a normal `nest`-tier input (no flat-TM limit).
    const bs = w.indentBlockScalar(matOpts.indentStep);
    if (bs.length) push(bs, 'nest:blockScalar', entry.name);
  }

  // 8) COMMENT INJECTION (the last coverage hole). A comment is a `skip` token the parser DROPS, so the
  //    scope≡role judge — which walks parser LEAVES — never reaches a comment's highlighter scope (0%
  //    coverage). Inject a comment into a SAFE, DETERMINISTIC position of each already-generated input and
  //    record its span as a WITNESS in `tokens` (the FIRST consumer of that field) — the judge grades the
  //    highlighter against THAT witness, not a parser leaf (see the comment arm in generative-detect.ts).
  //    Re-parse-and-DROP: an injection that breaks parsing is discarded (the un-injected input is always
  //    kept — these are ADDITIONAL variants). DETERMINISTIC: a fixed position rule, no randomness, and we
  //    iterate a SNAPSHOT of the inputs generated above (in their deterministic order), so two calls match.
  //    Collected SEPARATELY and concatenated AFTER the base `maxInputs` slice, so the comment witnesses are
  //    never starved by the cap (closing the coverage hole is the point); bounded by the same maxInputs.
  const base = out.slice(0, maxInputs);
  const commentInputs: GenInput[] = [];
  const cspec = commentSpec(grammar);
  if (cspec) {
    const tagClose = grammar.markup?.tagClose ?? '';
    const { parse } = createParser(grammar);   // lazy: only built when a comment can be injected
    for (const inp of base) {                  // a snapshot — never inject into an already-injected variant
      if (commentInputs.length >= maxInputs) break;
      const inj = injectComment(inp.text, cspec, tagClose, grammar.markup);
      if (!inj) continue;
      if (inj.text.slice(inj.start, inj.end) !== inj.comment) continue;   // span sanity (the splice put it exactly here)
      // re-parse-and-DROP, at the ENTRY rule: the injected text must be a FULL DOCUMENT (the highlighter
      // tokenizes the whole text as the entry scope, and the judge grades comment witnesses only on
      // entry-legal inputs) — this single full-document parse is the authoritative net (a fragment host
      // whose injected form doesn't parse as a document is simply dropped here).
      try { parse(inj.text); } catch { continue; }
      if (!inj.text.trim() || inj.text.length > 2000 || seen.has(inj.text)) continue;
      seen.add(inj.text);
      // `tokens` becomes EXACTLY the injected comment WITNESS — the span-verified ground truth the judge
      // grades the highlighter against. We do NOT carry over the host's `materialize`-recorded tokens: that
      // list was never consumed and is unreliable for markup fragments (a degenerate `> <!--x-->` mis-spans),
      // so the only authoritative witness is the comment we just spliced at a known offset (text === slice).
      // The variant INHERITS the host's tier: a `fuzz`-host (exploratory, may carry a STANDING flat-TM limit
      // like the self-close `/` #24) stays `fuzz:comment:…` so that inherited #24 remains report-only — only
      // the COMMENT-witness check itself always gates (isGated keys `#comment` on kind, not the tier). A
      // structured host stays `comment:…`. Either way the strategy CONTAINS `comment:`, the judge's marker.
      const tier = inp.strategy.startsWith('fuzz') ? 'fuzz:' : '';
      commentInputs.push({ text: inj.text, tokens: [{ start: inj.start, end: inj.end, name: cspec.witnessName, text: inj.comment }], strategy: `${tier}comment:${cspec.witnessName}`, rule: inp.rule });
    }
  }

  return [...base, ...commentInputs];
}
