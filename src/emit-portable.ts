// ── emit-portable ──
//
// The target-agnostic emitter (issue #6). `emitParser(grammar, target)` (see emit.ts) derives
// a COMPLETE, self-contained parser in the target's language from the same CstGrammar the
// TS engine uses. It is the agnosticism proof: ONE analysis → ONE intermediate form (IR)
// → N language renderings that accept/reject the same inputs as the interpreter (see
// test/portable-targets.ts: accept/reject parity plus a rule-skeleton guard on tiny inputs).
//
// SHARED + target-agnostic (here): the grammar ANALYSIS (reused from grammar-analysis.ts),
// the LEXER specs (derived from token-pattern.ts's structural recognizers — char runs,
// quote-delimited strings, line/block comments — so NO regex engine is needed and the
// emitted Go/Rust compile offline), and `buildIR` — the parse plan as plain data
// (recursive-descent rules as alternative step-lists; the Pratt rule as NUD atoms/brackets/
// prefix + binary tables + mixfix LEDs). PER-TARGET (a Target): `render(ir)` — the
// language's lexer + CST runtime + the rendering of each IR node. Adding a language is
// implementing one Target.
//
// SCOPE: char-run / quote-string / line+block-comment tokens; recursive descent with
// backtracking alternation, `*`/`?` quantifiers, `sep`, and inline literal-alternation;
// and a Pratt expression engine with operator precedence/associativity, prefix unary,
// bracket NUDs (grouping, array), and mixfix LEDs (call / member / index) tried before
// operators. buildIR THROWS on a construct outside this set rather than emit a wrong
// parser. This is enough to derive a real JavaScript-subset parser (test/fixtures/minijs.ts).
import type { CstGrammar, RuleExpr, TokenDecl, TokenPattern } from './types.ts';
import { KIND, analyzeGrammar, concreteFirst, findEntryRule } from './grammar-analysis.ts';
import { nameRule, syntaxKey, type RuleNames } from './grammar-names.ts';
import { collectLiterals, gtComposites, isKeywordLiteral } from './grammar-utils.ts';
import { tokenPatternCharLoop, tokenPatternLiteralPrefix } from './token-pattern.ts';
import { type TextUnits, firstUnit, oneUnit, unitLen } from './text-units.ts';
import { scannedTokens, templateLiterals, tokenLiterals } from './lex-family.ts';

// ── Intermediate representation (plain data; every Target renders THIS) ──

export type CharRange = [number, number];   // inclusive char-code range
export type LexTok =
  | { kind: 'run'; name: string; first: CharRange[]; cont: CharRange[]; skip: boolean }   // ident/number char run
  // Char-run with bail stops (e.g. Ident with `\u…` escapes): ASCII tight loop when safe,
  // else fall back to the general pattern matcher from the token start. `bail` governs where
  // the cont run may STOP; `headBail` are ENTRY chars claimed by a complex head alternative
  // (e.g. an escape-led first char) that must route straight to the general matcher.
  | { kind: 'runBail'; name: string; first: CharRange[]; cont: CharRange[];
      bail: number[]; bailNonAscii: boolean;
      headBail: number[]; headBailNonAscii: boolean;
      pattern: TokenPattern; skip: boolean }
  | { kind: 'string'; name: string; delim: string; skip: boolean }                        // delim..delim, `\` escapes next
  // prefix, then every character up to the first stop (the class's excluded characters) or the end
  | { kind: 'line'; name: string; prefix: string; stops: number[]; skip: boolean }
  // open..the first close after it; `guard`: zero-width tests right after the opener.
  | { kind: 'block'; name: string; open: string; close: string; guard: TokenPattern | null; skip: boolean }
  // The general case: the raw token-pattern AST, compiled to a backtracking-free matcher
  // by the target (no regex engine). Subsumes the fast paths above; used for the token
  // shapes they don't cleanly recognise (escaped identifiers, the number family, …).
  | { kind: 'pattern'; name: string; pattern: TokenPattern; skip: boolean };

export type Lit = { value: string; ttype: '$keyword' | '$punct' };
// A FIRST signature: the literal texts and token kinds a branch can begin with, used to emit a
// predictive switch instead of backtracking. `null` = UNPREDICTABLE (the branch leads with a
// zero-width guard, a nullable quantifier, or a reference to an unpredictable/Pratt rule) — keep
// backtracking for it. Computed conservatively in buildIR; targets only render a predictive
// dispatch when every branch in an alt-list is non-null AND the signatures are pairwise disjoint.
export type FirstSig = { lits: string[]; toks: string[] } | null;
// Cap on FIRST-set size for partial pre-filter guards on non-predictive INLINE alts (ordered
// choice). Larger sets skip the guard (|| chains can exceed a failed attempt). Tunable; see P4b/P5c.
// A rule's longest-match candidates are guarded by their Guard instead (below), whatever its size.
export const FIRST_GUARD_K = 4;
/** toks-only sigs may use a larger K (kid compares cheaper than long lid || chains). 0 = off. */
export const FIRST_GUARD_K_TOK = 0;
/** When a non-predictive rule has ≥ this many alts, allow FIRST_GUARD_K_BIG. 0 = off. */
export const FIRST_GUARD_BIG_NALTS = 10;
export const FIRST_GUARD_K_BIG = 8;

/** Whether a FirstSig is small enough to pre-filter before a backtracking attempt. */
export function isFirstGuardable(f: FirstSig, nAlts?: number): f is NonNullable<FirstSig> {
  if (f === null) return false;
  const n = f.lits.length + f.toks.length;
  if (n === 0) return false;
  if (n <= FIRST_GUARD_K) return true;
  if (FIRST_GUARD_K_TOK > 0 && f.lits.length === 0 && f.toks.length <= FIRST_GUARD_K_TOK) return true;
  if (
    FIRST_GUARD_BIG_NALTS > 0 &&
    nAlts != null &&
    nAlts >= FIRST_GUARD_BIG_NALTS &&
    n <= FIRST_GUARD_K_BIG
  ) return true;
  return false;
}

/** Group items by key, preserving first-seen key order and within-group original order. */
export type Grouped<T> = { key: string | number; members: Array<{ item: T; index: number }> };
export function groupByPreserveOrder<T>(
  items: readonly T[],
  keyOf: (item: T, index: number) => string | number,
): Grouped<T>[] {
  const map = new Map<string | number, Array<{ item: T; index: number }>>();
  const order: Array<string | number> = [];
  for (let i = 0; i < items.length; i++) {
    const key = keyOf(items[i]!, i);
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); order.push(key); }
    arr.push({ item: items[i]!, index: i });
  }
  return order.map((key) => ({ key, members: map.get(key)! }));
}
// NAMES (src/grammar-names.ts nameRule: the author-written `arm` / `field`, else the derived
// name) are data the IR carries for a consumer that finds a child or an arm by name (a shape);
// no parse path reads them, and every key under which the IR dedupes or compares steps
// (stepKey, syntaxKey) leaves them out, so a name never changes a parser. A step lowered from a
// named grammar node carries `field` (not `name`: `rule` / `tok` steps already use `name` for
// what they call); an inline alternation carries `branchNames`, parallel to `branches`. A
// shared step (ParserIR.shared) is its first occurrence: each occurrence in a rule body keeps
// its own names.
export type Step = StepOp & { field?: string };
type StepOp =
  | { t: 'lit'; value: string; ttype: '$keyword' | '$punct' }   // match a literal by text
  | { t: 'tok'; name: string; hole?: string }                   // match a token kind; a template kind (TplCfg) carries the rule that parses its `${…}` holes and also matches an interpolated template
  | { t: 'rule'; name: string }                                 // call a rule, append its node
  | { t: 'ruleBp'; name: string; bp: number }                   // call a Pratt rule at a given binding power (chain-rhs led trailing operand)
  | { t: 'star'; step: Step; guard?: number; clean?: true; share?: number }                   // repeat inner 0+
  | { t: 'opt'; steps: Step[]; guard?: number; clean?: true; share?: number }                 // optional sub-sequence
  | { t: 'sep'; elem: Step; delim: string; guard?: number; clean?: true; share?: number }     // elem (delim elem)*
  | { t: 'altlit'; opts: Lit[] }                                // inline alternation of literals (fast path)
  | { t: 'alt'; branches: Step[][]; branchNames?: string[]; firsts?: FirstSig[]; predictive?: boolean; share?: number }            // inline alternation of sub-sequences (backtracking unless predictive)
  | { t: 'look'; id: number; is: boolean }                     // zero-width: whether ParserIR.lookaheads[id] matches here (is) or does not (!is)
  | { t: 'ahead'; set: number; is: boolean }                    // zero-width: whether the next token is (is) or is not (!is) in ParserIR.tokenSets[set]
  | { t: 'aheadCtx'; set: number; is: boolean }                 // zero-width: the `ahead` test of tokenSets[set] plus the operator words of the context in force (ParserIR.ctxWords)
  | { t: 'seq'; steps: Step[]; share?: number }                 // a grouped sub-sequence (e.g. a star body `(',' Expr)`)
  | { t: 'sameLine' }                                           // zero-width: the next token is on the same line (no preceding newline)
  | { t: 'suppress'; set: number; steps: Step[]; share?: number }  // parse the body with the LED connectors of ParserIR.suppressSets[set] disabled (no-`in` context)
  | { t: 'ctx'; ctx: Ctx; steps: Step[]; share?: number };      // parse the body in [Await]/[Yield] context `ctx`, then put back the one in force
export type Alt = Step[];
/** A step's (or step list's) structure as a string, without its names: the key under which two
 *  equal structures are one computation (a lookahead body, a shared step). */
export function stepKey(s: Step | readonly Step[]): string {
  return JSON.stringify(s, (k, v) => (k === 'field' || k === 'branchNames' ? undefined : v));
}
// The ECMAScript [Await] / [Yield] grammar parameters: the context a body is parsed in, as one word
// a parser holds (bit CTX_AWAIT: `await` is the operator, bit CTX_YIELD: `yield` is). The grammar
// marks each body that sets it (awaitCtx / yieldCtx / asyncGenCtx, resetCtx for the bodies that set
// none: a plain function, an accessor, a field initializer); a `ctx` step is such a body. What the
// context decides is whether those words are reserved: an identifier's reserved-word guard
// (`reservableNot`) also refuses the context's operator words, so it is an `aheadCtx` test: its
// words' set, or a word of ParserIR.ctxWords whose bit the context has. Every other step reads the parser's state as it always did, so a parse is
// the same function of (position, state) with the context one more part of the state: a step or a
// lookahead that two contexts share is one computation, and nothing keyed on rule and position is
// kept that the context would have to join (the portable parsers keep no memo; a Doc reuses only
// the entry rule's top-level entries, which are parsed in the entry's context, CTX_NONE).
// A `ctx` step restores the context it found on success and on failure alike, so the context in
// force is always that of the innermost enclosing body.
export const CTX_NONE = 0, CTX_AWAIT = 1, CTX_YIELD = 2;
export type Ctx = 0 | 1 | 2 | 3;
const CTX_OF_MODE: Record<'await' | 'yield' | 'asyncgen' | 'reset', Ctx> = { await: 1, yield: 2, asyncgen: 3, reset: 0 };
/** The operator word each context bit reserves: CTX_WORDS[i] for bit 1 << i. */
const CTX_WORDS: readonly string[] = ['await', 'yield'];
// The LED connectors a `suppress` step disables (`exclude('in', Expr)`: no `in` in a for-head) are
// a constant of the grammar at each site, so a parser never builds one at run time. The grammar
// analysis keeps each distinct set once (ParserIR.suppressSets, sorted; set 0 is the empty set, the
// state outside every suppress step) and decides which sets disable a led (PrattRule.ledSuppressedIn),
// so a parser holds the index of the set in force and a target tests an index, never a set.
// One token, tested without consuming it: a member is a literal text (the token's lid) or a token
// kind (its kid). A lookahead whose body reads exactly one token — `not(alt('(', '=', …))`, or
// `not(not(alt(Ident, String, '[')))` — is this test, so buildIR lowers it to an `ahead` step over
// one shared set instead of a body every target prints at every site. Members are sorted; each
// distinct set appears once in ParserIR.tokenSets.
export type TokenSet = { lits: string[]; toks: string[] };
// A lookahead over more than one token — `not(['[', alt(...), ...])` — runs its body and then
// undoes everything the body did: the position, the children it appended and the nodes it built.
// What it decides is a function of the body and the parser's state alone, so two lookaheads with
// the same body are one computation, wherever they stand and in whichever [Await]/[Yield] context
// (the context is part of the parser's state the body reads). buildIR keeps
// each distinct body once in ParserIR.lookaheads and a `look` step names it; every target prints
// one function per body (per parse mode it emits), called from each site.

// ── How a rule chooses among its alternatives: LONGEST MATCH ──
// A rule's alternatives (an rd rule's `alts`, a Pratt rule's NUD arms) are all candidates at a
// position: the one that advances FARTHEST wins, the EARLIEST-declared one on a tie, and an
// alternative that advances nothing cannot win (README "Adding a language"; gen-parser.ts
// parseNonRec / the NUD loop of prattCore). So the IR hands every target the alternatives in
// the grammar's DECLARATION order — `RdRule.alts`, `PrattRule.nudOrder` — and a target tries
// them in that order, keeping an alternative only when it ends strictly past the best so far
// (or tries them in another order and compares the declaration index on a tie: the winner is
// the same). A target never stops at the first alternative that matches; the one exception is
// a list flagged `predictive`, where the FIRST signatures prove that at most one alternative
// can match at any token, so dispatching to it IS the longest match.
// A candidate is TRIED only where its `Guard` admits the lookahead (see Guard): a candidate the
// guard refuses provably cannot match non-empty there, so it cannot win, and skipping it changes
// no parse. Every target prints the guard as given — it is not a target's choice.
// A target reaches the candidates a token admits through the list's `Dispatch`: a switch on the
// token's literal and one on its kind, then the candidates keyed on neither, so a candidate whose
// key the token does not have costs nothing. That tries candidates out of declaration order, so a
// target keeps a later-tried candidate on a tie only when it was declared earlier.
// (An inline `alt` step is the other construct: ordered choice, the first branch that matches.)
export type RdRule = {
  kind: 'rd'; name: string; alts: Alt[];
  altNames: string[];       // parallel to alts: each one's arm name (see Step, NAMES)
  altFirst: FirstSig[];     // parallel to alts: each one's Step-level FIRST signature — the `predictive` switch's keys
  predictive: boolean;
  altGuard: Guard[];        // parallel to alts: when each one is a candidate at all
  altDispatch: Dispatch;    // how a target reaches the alts a token admits (unused when predictive / one alt)
  altCommit?: Commit;       // the keys at which one alternative is left (see Commit); absent: none
  altBody?: Array<Step | null>;   // parallel to alts, with a Commit: an alternative both its frame and its commit run, as one step printed once (see commitBodies)
};
// The candidates of a longest-match list, by what the first token must be, as sections a target
// prints in order: a `lid` section switches on the token's literal and a `kid` section on its
// kind — each group holds the candidates keyed on exactly that one literal / kind, in declaration
// order — and a `rest` section holds the others (several keys, no guard, or an arm whose test is
// not a set: the prefix arm, a template), in declaration order. Members are indices into the list
// (RdRule.alts, PrattRule.nudOrder); each candidate is in one place. Sections come in the order of
// their earliest-declared member, so a tie a declaration-order loop would settle by order rarely
// has to replace a node already built.
// `ranked`: the candidates that can tie one tried BEFORE them but declared AFTER them — a later
// section's candidate whose key a token can share with that one's (a literal and a kind, or a
// `rest` candidate: two different literals or two different kinds never admit one token). Only
// those compare declaration indices on a tie; every other candidate wins only by ending past the
// best so far, as in a declaration-order loop. Empty: no candidate needs the index.
export type DispatchGroup = { key: string; arms: number[] };
export type DispatchSection = { by: 'lid' | 'kid'; groups: DispatchGroup[] } | { by: 'rest'; arms: number[] };
export type Dispatch = { sections: DispatchSection[]; ranked: number[] };
/** The Dispatch of a candidate list from each candidate's key (null: in `rest`). */
export function dispatchOf(keys: ReadonlyArray<TokenSet | null>): Dispatch {
  const byLid = new Map<string, number[]>(), byKid = new Map<string, number[]>(), rest: number[] = [];
  const add = (m: Map<string, number[]>, k: string, i: number) => { const a = m.get(k); if (a) a.push(i); else m.set(k, [i]); };
  keys.forEach((k, i) => {
    if (k !== null && k.lits.length === 1 && k.toks.length === 0) add(byLid, k.lits[0]!, i);
    else if (k !== null && k.toks.length === 1 && k.lits.length === 0) add(byKid, k.toks[0]!, i);
    else rest.push(i);
  });
  const groups = (m: Map<string, number[]>) => [...m].map(([key, arms]) => ({ key, arms }));
  const first = (sec: DispatchSection) => Math.min(...(sec.by === 'rest' ? sec.arms : sec.groups.map((g) => g.arms[0]!)));
  const sections: DispatchSection[] = [];
  if (byLid.size) sections.push({ by: 'lid', groups: groups(byLid) });
  if (byKid.size) sections.push({ by: 'kid', groups: groups(byKid) });
  if (rest.length) sections.push({ by: 'rest', arms: rest });
  sections.sort((x, y) => first(x) - first(y));
  return { sections, ranked: rankedOf(sections) };
}
/** Dispatch.ranked of sections tried in their order. */
function rankedOf(sections: DispatchSection[]): number[] {
  // Each candidate in trying order, with the section kind and key it is reached by.
  type Tried = { i: number; by: DispatchSection['by']; key: string };
  const tried: Tried[] = sections.flatMap((sec): Tried[] => sec.by === 'rest'
    ? sec.arms.map((i) => ({ i, by: sec.by, key: '' }))
    : sec.groups.flatMap((g) => g.arms.map((i) => ({ i, by: sec.by, key: g.key }))));
  const mayShare = (x: Tried, y: Tried) => x.by === 'rest' || y.by === 'rest' || x.by !== y.by || x.key === y.key;
  return tried.filter((x, n) => tried.slice(0, n).some((y) => y.i > x.i && mayShare(x, y))).map((x) => x.i).sort((a, b) => a - b);
}
// The tokens outside which a candidate only repeats an earlier candidate of its list (null: it
// never does, as far as this can tell). A candidate that opens with optional steps (`?` / `*`)
// and continues exactly as an earlier candidate is written — `[many(Decorator), 'export', X]`
// after `['export', X]` — runs that candidate's own steps from the same token wherever none of
// its optional steps can begin: each of them matches nothing there, so it ends where the earlier
// one ends, and the tie goes to the earlier one. It can therefore win only at a token that begins
// one of those optional steps, and that set is the result. Without this the two candidates each
// parse the whole construct, and a construct nested in itself costs 2^depth parses.
// `earlier` are the candidates declared before `e` that are tried wherever they can match; a
// step's FIRST comes from `first` (null: not known, so nothing is concluded).
export function sameAsEarlierOutside(e: RuleExpr, earlier: readonly RuleExpr[], first: (e: RuleExpr) => Set<string> | null): Set<string> | null {
  const itemsOf = (x: RuleExpr): RuleExpr[] => (x.type === 'seq' ? x.items : [x]);
  const written = new Set(earlier.map((x) => syntaxKey(itemsOf(x))));
  const items = itemsOf(e);
  const lead = new Set<string>();
  for (let k = 0; k < items.length - 1; k++) {
    const opt = items[k]!;
    if (opt.type !== 'quantifier' || opt.kind === '+') return null;
    const f = first(opt);
    if (f === null) return null;
    for (const key of f) lead.add(key);
    if (written.has(syntaxKey(items.slice(k + 1)))) return lead;
  }
  return null;
}
// When a longest-match candidate is tried: only when the token at the candidate's start is in
// ParserIR.tokenSets[first] and, if `second` is set, the token after it is in tokenSets[second]
// (no token there refuses). `null` = always tried. From the grammar's own facts — the FIRST and
// SECOND sets of grammar-analysis.ts (exprFirst / exprSecond), the sets the interpreter prunes its
// candidates with — so a refused candidate cannot match non-empty at that token, and an empty match
// never wins a longest match. Each set is one table test in every target, whatever its size.
// `first` is narrower than FIRST for a candidate that repeats an earlier one of its list behind
// optional steps (see sameAsEarlierOutside): where none of those steps can begin, it would run the
// earlier candidate's steps again, end where that one ends and lose the tie, so it is refused
// there. A token so refused is one the earlier candidate's guard admits: the union of a list's
// `first` sets is still every token a match of the list can begin with.
// `lead`: the candidate's own leading one-token tests, taken over by the guard (see leadOf): its
// first `skip` steps are `ahead` / `aheadCtx` tests of the token at the candidate's start, and the
// guard runs them on the token a target has already buffered, before the candidate's frame, so a
// refusal costs no frame and the candidate's statement runs only its steps after them
// (`steps.slice(skip)`). Adjacent negative tests are one test of the union of their sets. A guard
// with lead tests and no FIRST set has `first` null: it refuses only by its lead tests.
export type Guard = { first: GuardSet | null; second: GuardSet | null; lead: LeadTest[]; skip: number } | null;
/** One test of the buffered token: whether it is in ParserIR.tokenSets[set] — or, with `ctx`, a
 *  word the context in force reserves (ParserIR.ctxWords) — compared with `is`. */
export type LeadTest = { set: number; is: boolean; ctx: boolean };
/** The steps a candidate runs inside its frame: those after the tests its guard took over. */
export const guardedSteps = (g: Guard, steps: Step[]): Step[] => (g === null || g.skip === 0 ? steps : steps.slice(g.skip));
/** A member of ParserIR.tokenSets, by its index and its members. */
export type GuardSet = TokenSet & { id: number };

// ── COMMITTED CHOICE: a longest-match list that has one candidate left at a token ──
// A longest-match list (an rd rule's alternatives, a Pratt rule's NUD arms) runs every candidate a
// token admits in a CANDIDATE frame: a checkpoint at the list's start, the best match so far and
// its end compared with each candidate's, a checkpoint after each new best. All of it exists to
// choose among candidates, so where the token leaves ONE candidate there is nothing to choose: the
// candidate's match is the list's match, its failure the list's failure. Which candidates a token
// can admit is the plan's own data — each candidate's Guard (its FIRST set and lead tests, and for
// a NUD arm the literal or kind it is keyed on) — so it is decided here, per dispatch key, once:
// - A key no candidate admits: the list fails there without its frame (`act` null).
// - A key at which exactly one candidate's admission is certain (its first set and lead tests hold
//   for every token with that key, and it has no test that only the run can decide: a SECOND set,
//   a capped arm's binding power) and the others can be admitted only by such run-time tests
//   (`unless`): when none of those admits the token, the certain one is COMMITTED: run without
//   the frame. When one does, the token goes to the frame as before. A key with no certain
//   candidate commits, under the same `unless`, to its earliest-declared one, whose own run-time
//   tests then decide (refused: the list fails, as the frame would with nothing tried).
// - Every other key: the frame (`'frame'`).
// A committed candidate runs as the SINGLE form runs its alternative: a checkpoint only when its
// steps can fail DIRTY (CommitAct.clean false: Step.clean's definition, the one a repetition reads:
// a candidate that fails clean leaves the state as it found it, so its failure needs no undo), and
// a match of no tokens is no match (CommitAct.nullable: such a match cannot win a longest match).
// Sound because the frame would have run exactly that candidate: every other one is refused by
// its guard, so the frame's best is the committed candidate's match or none. guard-refused attempts
// every other candidate at each committed site on real inputs and requires that none would win.
// A token's literal (lid) decides first: `lid` cases name the literals some candidate's test reads
// (its first set, its lead sets, the context's words), each with its action, where it differs from
// its kind's ('frame' included, so that its kind's case does not apply); every other token is
// decided by its kind (`kid`), and a kind no case names goes to the frame. Keys are texts / kind
// names, as Dispatch's are. Absent: no key commits or fails.
// What a run still tests of a candidate at a key (CommitTest): its first-token test unless every
// token of the key passes it (`first`), and those of its lead tests (indices into Guard.lead) that
// some token of the key fails or that read the context; a SECOND set and a capped arm's binding
// power are always tested.
export type CommitTest = { arm: number; first: boolean; lead: number[] };
export type CommitAct = CommitTest & { nullable: boolean; clean: boolean; unless: CommitTest[] };
export type CommitCase = { keys: string[]; act: CommitAct | null | 'frame' };
export type Commit = { lid: CommitCase[]; kid: CommitCase[] };
/** What the commit analysis reads of one candidate: its first-token set (null: any token), its lead
 *  tests, whether it has a test only the run decides, whether its steps can match nothing / fail
 *  clean, and the kinds at which it has no commit form (an interpolated template arm). */
export type CommitCand = { first: TokenSet | null; lead: LeadTest[]; runtime: boolean; nullable: boolean; clean: boolean; frameAt?: string[] };
type CommitTables = { kinds: string[]; kindsOf: (text: string) => ReadonlySet<string>; tokenSets: TokenSet[]; ctxWords: string[] };
/** The frame's Dispatch once a Commit decides some keys: a `lid` / `kid` group whose every token the
 *  commit switch returns at (it fails there, or commits with no `unless`) is never reached by the
 *  frame, so it is dropped (and `ranked` recomputed over the candidates left). */
export function frameDispatch(d: Dispatch, c: Commit, kindsOf: (text: string) => ReadonlySet<string>): Dispatch {
  const decided = (a: CommitCase['act']) => a === null || (a !== 'frame' && a.unless.length === 0);
  const lidAct = (l: string) => c.lid.find((x) => x.keys.includes(l))?.act;
  const kidAct = (k: string) => c.kid.find((x) => x.keys.includes(k))?.act ?? 'frame';
  const lidDead = (l: string) => { const a = lidAct(l); return a !== undefined ? decided(a) : [...kindsOf(l)].every((k) => decided(kidAct(k))); };
  const kidDead = (k: string) => decided(kidAct(k)) && c.lid.every((x) => decided(x.act) || !x.keys.some((l) => kindsOf(l).has(k)));
  let pruned = false;
  const sections = d.sections.flatMap((sec): DispatchSection[] => {
    if (sec.by === 'rest') return [sec];
    const groups = sec.groups.filter((g) => !(sec.by === 'lid' ? lidDead(g.key) : kidDead(g.key)));
    if (groups.length < sec.groups.length) pruned = true;
    return groups.length ? [{ by: sec.by, groups }] : [];
  });
  return pruned ? { sections, ranked: rankedOf(sections) } : d;
}
/** The candidates a list's Commit commits to that its frame still reaches: each one's steps (those
 *  after its guard's lead tests) as ONE `seq` step, so that shareSteps counts it at its two places
 *  and prints it once, as a shared step both call; null for every other candidate (printed where it
 *  runs) and for one of one step (a call already, or a compound step shareSteps shares itself). `steps`: parallel to
 *  the list, null for an arm with no steps (a token or prefix arm). */
function commitBodies(c: Commit, frame: Dispatch, steps: Array<Step[] | null>): Array<Step | null> | undefined {
  const inFrame = dispatchArms(frame), committed = new Set(commitPrinted(c).map((a) => a.arm));
  const out = steps.map((st, i): Step | null => (st !== null && st.length > 1 && inFrame.has(i) && committed.has(i) ? { t: 'seq', steps: st } : null));
  return out.some((s) => s !== null) ? out : undefined;
}
export function commitOf(cands: CommitCand[], P: CommitTables): Commit | undefined {
  // A token class: a literal the tests read (or none of them: null) and a kind.
  type Cls = { lit: string | null; kind: string };
  const inSet = (s: TokenSet, c: Cls) => (c.lit !== null && s.lits.includes(c.lit)) || s.toks.includes(c.kind);
  const firstHolds = (j: number, c: Cls) => cands[j]!.first === null || inSet(cands[j]!.first!, c);
  // One lead test on the class: 'yes' / 'no', or 'maybe' (a context word: the context in force decides).
  const leadAt = (l: LeadTest, c: Cls): 'yes' | 'no' | 'maybe' => {
    const x = inSet(P.tokenSets[l.set]!, c);
    if (!x && l.ctx && c.lit !== null && P.ctxWords.includes(c.lit)) return 'maybe';
    return x === l.is ? 'yes' : 'no';
  };
  const lead = (j: number, c: Cls) => { const r = cands[j]!.lead.map((l) => leadAt(l, c)); return r.includes('no') ? 'no' : r.includes('maybe') ? 'maybe' : 'yes'; };
  const viable = (j: number, c: Cls) => firstHolds(j, c) && lead(j, c) !== 'no';
  const certain = (j: number, c: Cls) => firstHolds(j, c) && lead(j, c) === 'yes' && !cands[j]!.runtime;
  const testAt = (j: number, cs: Cls[]): CommitTest => ({
    arm: j,
    first: !cs.every((c) => firstHolds(j, c)),
    lead: cands[j]!.lead.flatMap((l, k) => (cs.every((c) => leadAt(l, c) === 'yes') ? [] : [k])),
  });
  const actAt = (cs: Cls[]): CommitAct | null | 'frame' => {
    const V = cands.map((_, j) => j).filter((j) => cs.some((c) => viable(j, c)));
    if (V.length === 0) return null;
    if (V.some((j) => cs.some((c) => viable(j, c) && cands[j]!.frameAt?.includes(c.kind)))) return 'frame';
    const sure = V.filter((j) => cs.every((c) => certain(j, c)));
    if (sure.length > 1) return 'frame';
    const i = sure[0] ?? V[0]!;
    return { ...testAt(i, cs), nullable: cands[i]!.nullable, clean: cands[i]!.clean, unless: V.filter((j) => j !== i).map((j) => testAt(j, cs)) };
  };
  const same = (x: CommitCase['act'], y: CommitCase['act']) => JSON.stringify(x) === JSON.stringify(y);
  const group = (keyed: Array<[string, CommitCase['act']]>): CommitCase[] => {
    const out: CommitCase[] = [];
    for (const [k, act] of keyed) { const g = out.find((c) => same(c.act, act)); if (g) g.keys.push(k); else out.push({ keys: [k], act }); }
    return out;
  };
  const lits = new Set<string>();
  for (const c of cands) {
    for (const l of c.first?.lits ?? []) lits.add(l);
    for (const t of c.lead) { for (const l of P.tokenSets[t.set]!.lits) lits.add(l); if (t.ctx) for (const w of P.ctxWords) lits.add(w); }
  }
  const kidActs = new Map(P.kinds.map((k) => [k, actAt([{ lit: null, kind: k }])] as const));
  const lidKeys: Array<[string, CommitCase['act']]> = [];
  for (const l of [...lits].sort()) {
    const ks = [...P.kindsOf(l)];
    if (ks.length === 0) continue;   // no token carries it
    const act = actAt(ks.map((kind) => ({ lit: l, kind })));
    if (ks.length === 1 && ks[0] !== '' && same(act, kidActs.get(ks[0]!) ?? 'frame')) continue;   // its kind's case decides it alike
    lidKeys.push([l, act]);
  }
  const kidKeys = [...kidActs].filter(([, act]) => act !== 'frame');
  const lid = group(lidKeys), kid = group(kidKeys);
  if (![...lid, ...kid].some((c) => c.act !== 'frame')) return undefined;
  return { lid: lid.filter((c) => !(c.act === 'frame' && kid.length === 0)), kid };
}
// One NUD arm of a Pratt rule, by the bucket that holds its plan and its index there.
export type NudRef =
  | { kind: 'tok'; index: number }       // nudToks[index]
  | { kind: 'bracket'; index: number }   // nudBrackets[index]
  | { kind: 'seq'; index: number }       // nudSeqs[index]
  | { kind: 'capped'; index: number }    // nudCapped[index] — a candidate only when minBp < capBp
  | { kind: 'prefix' };                  // the prefix-operator arm (`prefix $`), every op of `prefix`
export type Bracket = { first: string; steps: Step[] };          // a literal-led sequence (grouping/array; LED call/index)
export type PrattRule = {
  kind: 'pratt';
  name: string;       // the rule name: the parse fn names and the CST node label
  nudToks: string[];                                  // NUD: a bare token wrapped in a node
  nudBrackets: Bracket[];                             // NUD: '(' … ')' / '[' … ']'
  nudSeqs: Step[][];                                  // NUD: a general sequence (guarded ident, class expr), tried with backtracking
  nudSeqGuard: Guard[];                               // parallel to nudSeqs: when each seq is a candidate (see Guard)
  // Tail closure is decided by the construct that builds a node: only a NUD that does not end in
  // a fresh operand, or an access-tail LED, leaves a node that access tails (and postfix ops) may
  // extend. Prefix and binary nodes always close the tail.
  nudBracketClosesTail: boolean[];                    // parallel to nudBrackets: ends in a fresh operand (`... $`)
  nudSeqClosesTail: boolean[];                        // parallel to nudSeqs: ends in a fresh operand
  nudSeqPredictive: boolean;                          // all nudSeqs non-null & pairwise disjoint → render a switch
  nudCapped: Array<{ steps: Step[]; capBp: number }>; // NUD: an assignment-level capped sequence (arrow function) — parsed only when minBp < capBp, admits no led
  nudOrder: NudRef[];                                 // every NUD arm above and the prefix arm, in declaration order: the longest-match candidates
  nudNames: string[];                                 // parallel to nudOrder: each arm's name (the prefix arm: opNames.prefix); see Step, NAMES
  nudDispatch: Dispatch;                              // how a target reaches the nudOrder arms a token admits
  nudCommit?: Commit;                                 // the keys at which one NUD arm is left (see Commit); absent: none
  nudBody?: Array<Step | null>;                       // parallel to nudOrder, with a Commit: an arm both its frame and its commit run, as one step printed once (see commitBodies)
  nudCappedGuard: Guard[];                            // parallel to nudCapped: when each capped seq is a candidate (see Guard)
  // requireTarget: the operand (prefix) / left operand (binary, postfix) must have FORM_TARGET,
  // else the whole Pratt call fails; noUnaryLhs: the left operand must not have FORM_UNARY.
  prefix: Array<{ op: string; rbp: number; requireTarget: boolean; form: AssignForm }>;  // NUD: prefix op then operand at rbp; form = the node's
  binary: Array<{ op: string; lbp: number; rbp: number; requireTarget: boolean; noUnaryLhs: boolean }>;  // LED: infix op, bind iff lbp > minBp, rhs at rbp
  leds: Bracket[];                                    // LED: mixfix continuation (call/member/index), tried before operators
  ledNames: string[];                                 // parallel to leds: each arm's name
  ledLeftNames: string[];                             // parallel to leds: the name of its left operand (the self `$`; derived: `left`)
  ledAccessTail: boolean[];                           // parallel to leds: a "closed punct-connector" tail (member/call/index) — disabled once a postfix binds
  ledLbp: Array<number | null>;                       // parallel to leds: precedence gate (ternary/in/instanceof) — bind only when lbp > minBp; null = bind maximally tight
  ledSameLine: boolean[];                             // parallel to leds: a leading `sameLine` guard (TS type tails) — the connector must be on the operand's line
  ledNotLeftLeaf: Array<string[] | null>;             // parallel to leds: skip this led when the left node's head-leaf text is in this set (`void.x` etc.)
  ledSuppressedIn: number[][];                        // parallel to leds: the ParserIR.suppressSets that hold its connector — the led is tried only while the set in force is none of them
  ledForm: AssignForm[];                              // parallel to leds: the built node's form (a binary-connector led, `a < T >`/`a as T`, is not a target)
  ledClosesTail: boolean[];                           // parallel to leds: not an access tail, or ends in a negative lookahead (`Foo<T>` then nothing)
  postfixToks: string[];                              // LED: a postfix token `$ X` (e.g. a tagged template), tried like a mixfix led (also an access tail)
  postfixTokNames: string[];                          // parallel to postfixToks: each arm's name
  // The names of the synthesized operator forms (a prefix / binary / postfix node); null when the
  // rule declares no operators. An operator itself is named by its text (`prefix[i].op` ...).
  opNames: { binary: string; prefix: string; postfix: string } | null;
  postfix: Array<{ op: string; lbp: number; requireTarget: boolean }>;  // LED: a postfix operator `$ ++` — binds iff lbp > minBp + !tailClosed, no rhs, closes the tail
  postfixSameLine: boolean;                           // the postfix arm is `$ sameLine ++` (a restricted production): the operator binds only on its operand's line
  // Present iff the template token is in nudToks / postfixToks: the rule that parses the
  // `${…}` holes of a template matched there — the one that reference declares (RuleExpr ref.hole).
  nudTplHole?: string;
  postfixTplHole?: string;
};
// The assignment-target form of a Pratt node (the interpreter's notAssignTarget), decided by the
// construct that builds it: an operator node is not a target, a prefix-unary one (`-x`, not
// `++x`) is also refused as a noUnaryLhs left operand; every other node is a target.
export const FORM_TARGET = 0, FORM_NOT_TARGET = 1, FORM_UNARY = 2;
export type AssignForm = typeof FORM_TARGET | typeof FORM_NOT_TARGET | typeof FORM_UNARY;
export type RuleIR = RdRule | PrattRule;

// Stateful regex-vs-division disambiguation (the JS `/` problem): a `/` starts a regex
// literal in expression context but is division after a value. The lexer threads the
// previous token + a control-head paren stack to decide; the predicate sets are baked
// from the grammar's `regexContext`. Mirrors emit-lexer.ts's prevIsValue exactly.
export type RegexCtx = {
  regexToken: string;          // the token flagged `regex`, gated on expression context
  identToken: string;          // identifier token kind (for the keyword-vs-value test)
  divisionTypes: string[];     // prev TOKEN KINDS after which `/` is division
  divisionTexts: string[];     // prev TEXTS after which `/` is division
  regexTexts: string[];        // expression-start keywords (a `/` after them is a regex)
  parenHeadKw: string[];       // keywords whose `(` is a control head (regex after its `)`)
  memberAccess: string[];      // accessors that make a following keyword a member name, not a head
  postfixAfterValue: string[]; // ambiguous postfix/prefix ops (e.g. `!`): value only in postfix
};

// Template literals with `${…}` interpolation: a STATEFUL lexer split. A `` ` `` opens a
// span scanned to the next `${` (→ $templateHead) or closing `` ` `` (→ the whole token,
// no substitution); a `}` that closes a hole resumes the span (→ $templateMiddle / Tail).
// A `templateStack` of brace-depths tracks which `}` closes the hole vs. a nested `{…}`.
// The parser assembles head·hole·(middle·hole)*·tail into a synthetic `$template` node; the rule
// that parses a hole is the matching reference's (PrattRule.nudTplHole / postfixTplHole).
export type TplCfg = {
  token: string;        // the token flagged `template`; its NoSubstitution form is a plain leaf
  open: string;         // `` ` ``
  interpOpen: string;   // `${`
  interpClose: string;  // `}`
  braceOpen: string;    // `{` — a nested one deepens the hole, so its `}` is not the closer
  // One well-formed escape (the token's `escapeValid`): an untagged template's opening span
  // rejects a `\` that does not begin one. Null when the token declares none.
  escapeValid: TokenPattern | null;
};

/** Every rule that parses template holes in `ir` (a Pratt rule's template arms, a template `tok`
 *  step's hole), in first-use order: a target whose template matcher cannot take the hole rule as
 *  an argument emits one matcher per entry. */
export function tplHoleRules(ir: ParserIR): string[] {
  const out = new Set<string>();
  const visit = (st: Step): void => { if (st.t === 'tok' && st.hole !== undefined) out.add(st.hole); stepKids(st).forEach(visit); };
  for (const r of ir.rules) {
    if (r.kind === 'pratt') {
      if (r.nudTplHole !== undefined) out.add(r.nudTplHole);
      if (r.postfixTplHole !== undefined) out.add(r.postfixTplHole);
    }
    for (const body of ruleBodies(r)) body.forEach(visit);
  }
  for (const body of ir.lookaheads) body.forEach(visit);
  return [...out];
}

// Newline-only mode (emit-lexer.ts): an engine-emitted NEWLINE token spanning every line break
// outside flowOpen/flowClose.
export type NewlineCfg = {
  token: string;
  flowOpen: string[];
  flowClose: string[];
};

/** How incremental reuse cuts the entry rule into top-level entries, read off the entry rule's
 *  shape once for every target. A: `star(rule)` or `star(alt(rule, ...))`, each entry one of `rules`
 *  (tried in order). B: `[opt(headRule)] star(seq(loopTok, opt(loopRule)))`, the entries being the
 *  head and each `loopTok`-led segment. Any other entry shape has no plan (no reuse). */
export type ReusePlanA = { kind: 'A'; rules: string[] };
export type ReusePlanB = { kind: 'B'; hasHead: boolean; headRule: string | null; loopTok: string; loopRule: string };
export type ReusePlan = ReusePlanA | ReusePlanB;

function reuseLoopSeq(step: Step): { loopTok: string; loopRule: string } | null {
  if (step.t !== 'seq' || step.steps.length !== 2) return null;
  const [a, b] = step.steps;
  if (a.t !== 'tok') return null;
  if (b.t !== 'opt' || b.steps.length !== 1 || b.steps[0].t !== 'rule') return null;
  return { loopTok: a.name, loopRule: (b.steps[0] as { t: 'rule'; name: string }).name };
}

function reusePlanOf(rules: RuleIR[], entryName: string): ReusePlan | null {
  const entry = rules.find((r) => r.name === entryName);
  if (!entry || entry.kind !== 'rd' || entry.alts.length !== 1) return null;
  const alt = entry.alts[0];
  if (alt.length === 1 && alt[0].t === 'star') {
    const step = alt[0].step;
    if (step.t === 'rule') return { kind: 'A', rules: [step.name] };
    if (step.t === 'alt') {
      for (const br of step.branches) if (br.length !== 1 || br[0].t !== 'rule') return null;
      return { kind: 'A', rules: step.branches.map((br) => (br[0] as { t: 'rule'; name: string }).name) };
    }
    const loop = reuseLoopSeq(step);
    return loop ? { kind: 'B', hasHead: false, headRule: null, ...loop } : null;
  }
  if (alt.length === 2 && alt[0].t === 'opt' && alt[1].t === 'star') {
    const hs = alt[0].steps;
    if (hs.length !== 1 || hs[0].t !== 'rule') return null;
    const loop = reuseLoopSeq(alt[1].step);
    return loop ? { kind: 'B', hasHead: true, headRule: hs[0].name, ...loop } : null;
  }
  return null;
}

export type ParserIR = {
  grammarName: string;
  entry: string;
  tokens: LexTok[];      // for the char scanner, tried in declaration order
  puncts: string[];      // punctuation literals the lexer scans, longest-first (maximal munch)
  /** `>`-led operators composed from single-character tokens where an operator or lookahead
   *  literal is read (gtComposites), longest first; never lexed, so absent from `puncts`. */
  gtComps: string[];
  rules: RuleIR[];
  tokenSets: TokenSet[];       // the sets `ahead` steps test, indexed by Step.set
  ctxWords: string[];          // the operator word each context bit reserves in an `aheadCtx` test (ctxWords[i] for bit 1 << i); empty when no step tests one
  lookaheads: Alt[];           // the bodies `look` steps run, indexed by Step.id; a body names only lower ids
  shared: Step[];              // the steps printed once and called from each site, indexed by Step.share (see shareSteps)
  forms: Forms;                // which rules and shared steps are printed in building and in recognize form (see Forms)
  reuse: ReusePlan | null;     // how incremental reuse cuts the entry rule into top-level entries (see ReusePlan); null: no reuse
  suppressSets: string[][];    // the connector sets `suppress` steps disable, indexed by Step.set; [0] is the empty set
  regexCtx: RegexCtx | null;   // null unless the grammar has a regex token with context
  tpl: TplCfg | null;          // null unless the grammar has a template token
  newlineCfg: NewlineCfg | null;  // null unless the grammar declares `newline`
  /** Token flagged `identifier` (Unicode ID_Start/ID_Continue fallback target); null if none. */
  identToken: string | null;
  /** Identifier-like tokens (bare identifier + identifierPrefix tokens): an adjacent
   *  ID_Continue-only char run extends the previous token of one of these kinds. */
  identLike: string[];
  /** Each identLike token's identifierPrefix ('' for the bare identifier): the text before the
   *  IdentifierName an escape check reads. */
  identPrefix: Record<string, string>;
};

// The target-agnostic parse plan for a grammar, the IR each portable Target (ts/go/rust) renders.
// The [Await]/[Yield] context is a word the parser holds (see Ctx), not a copy of each rule per
// context. The `Target` contract itself lives in emit.ts.
// `facts`: what a target's compiler makes a step cost, where the plan's choice depends on it (each
// printer states its facts with the measurement behind them). Omitted: every step the analysis
// proves, the plan the soundness gates check.
export function portableIR(grammar: CstGrammar, facts: PortableFacts = { calleeFirstGuards: true }): ParserIR {
  return buildIR(grammar, facts);
}
/**
 * calleeFirstGuards: whether a star / opt / sep body that is one rd rule's call, with no FIRST of
 * its own, is guarded by the called rule's FIRST (buildIR, ruleGuard). The guard is tested on every
 * iteration to save the one call that refuses at the loop's exit, so it pays only where a refused
 * call costs more than that test: a target whose function entry runs before the callee's dispatch.
 */
export type PortableFacts = { calleeFirstGuards: boolean };

// ── buildIR: grammar + analysis → the target-agnostic parse plan ──

function isNeverPat(p: TokenPattern): boolean {
  return typeof p !== 'string' && p.type === 'never';
}

function buildIR(grammar: CstGrammar, facts: PortableFacts): ParserIR {
  if (grammar.indent) {
    throw new Error('portable: indent-sensitive grammars are out of scope (use the interpreter path); declare `newline` without `indent` for line-boundary-only mode');
  }
  if (grammar.markup) {
    throw new Error('portable: markup-mode grammars are out of scope (use jsTarget or the interpreter path)');
  }
  // The portable lexers have no element-region frame stack yet (ElementRegion, emit-lexer.ts):
  // refused rather than lexed without the region, so no target diverges from the interpreter.
  if (grammar.elements) {
    throw new Error('portable: element-region grammars are out of scope until the portable lexers carry the frame stack (use jsTarget or the interpreter path)');
  }

  const a = analyzeGrammar(grammar);
  const tokenNames = a.tokenNames;

  // Engine-emitted tokens (`never()` pattern — NEWLINE in newline mode) are excluded from the
  // char scanner; the target lexer state machine emits them instead.
  const tokens: LexTok[] = grammar.tokens.filter((t) => !isNeverPat(t.pattern)).map((t) => lexTok(t));
  const lits = new Set<string>();
  for (const r of grammar.rules) for (const l of collectLiterals(r.body)) lits.add(l);
  for (const lv of grammar.precs) for (const o of lv.operators) lits.add(o.value);
  const gtComps = gtComposites(grammar);
  const puncts = [...lits].filter((l) => !isKeywordLiteral(l) && !gtComps.includes(l)).sort((x, y) => y.length - x.length);

  const litTtype = (v: string): '$keyword' | '$punct' => (isKeywordLiteral(v) ? '$keyword' : '$punct');

  // The members of a step that matches exactly one token and decides on it alone (a literal
  // other than a composed `>` operator, a token kind, or an alternation of such); null otherwise.
  const oneTokenOf = (s: Step): TokenSet | null => {
    switch (s.t) {
      case 'lit': return gtComps.includes(s.value) ? null : { lits: [s.value], toks: [] };
      case 'tok': return s.hole !== undefined ? null : { lits: [], toks: [s.name] };   // a template with holes spans several tokens
      case 'altlit': return s.opts.some((o) => gtComps.includes(o.value)) ? null : { lits: s.opts.map((o) => o.value), toks: [] };
      case 'seq': return s.steps.length === 1 ? oneTokenOf(s.steps[0]) : null;
      case 'alt': {
        const lits: string[] = []; const toks: string[] = [];
        for (const b of s.branches) {
          const m = b.length === 1 ? oneTokenOf(b[0]) : null;
          if (m === null) return null;
          lits.push(...m.lits); toks.push(...m.toks);
        }
        return { lits, toks };
      }
      default: return null;
    }
  };
  const tokenSets: TokenSet[] = [];
  const tokenSetIds = new Map<string, number>();
  const tokenSetOf = (m: TokenSet): number => {
    const set = { lits: [...new Set(m.lits)].sort(), toks: [...new Set(m.toks)].sort() };
    const key = JSON.stringify(set);
    let id = tokenSetIds.get(key);
    if (id === undefined) { id = tokenSets.length; tokenSets.push(set); tokenSetIds.set(key, id); }
    return id;
  };
  const lookaheads: Alt[] = [];
  const lookaheadIds = new Map<string, number>();
  const lookaheadOf = (steps: Step[]): number => {
    const key = stepKey(steps);
    let id = lookaheadIds.get(key);
    if (id === undefined) { id = lookaheads.length; lookaheads.push(steps); lookaheadIds.set(key, id); }
    return id;
  };
  // The suppress sets and which of them disable a led are the grammar analysis's (one definition,
  // shared with the jsTarget parser of emit-parser.ts).
  const { suppressSets } = a;
  const suppressOf = (connectors: string[], steps: Step[]): Step => ({ t: 'suppress', set: a.suppressSetOf(connectors), steps });
  const ctxOf = (mode: keyof typeof CTX_OF_MODE, steps: Step[]): Step => ({ t: 'ctx', ctx: CTX_OF_MODE[mode], steps });
  // An identifier's reserved-word guard: the one-token test of its words and, in each context, the
  // context's operator words. Its body is one token by construction (`reservableNot(alt(...))`).
  // The words' set is a constant of the site, as every `ahead` set is; only the context's words
  // are read at run time: a printer tests the set, then (outside every context, at the cost of one
  // load) whether the token is a word the context reserves.
  let ctxWords: string[] = [];
  const reservableOf = (steps: Step[]): Step => {
    const m = steps.length === 1 ? oneTokenOf(steps[0]) : null;
    if (m === null) throw new Error('portable: a reservable guard must test one token');
    ctxWords = [...CTX_WORDS];
    return { t: 'aheadCtx', set: tokenSetOf(m), is: false };
  };
  // A negative lookahead. Over a one-token body it is the `ahead` test of that token's set, over
  // any other body the `look` test of that body; over an `ahead` or a `look` it is the same test
  // negated (so `not(not(x))` is a positive test).
  const notOf = (steps: Step[]): Step => {
    if (steps.length === 1) {
      const s = steps[0];
      if (s.t === 'ahead' || s.t === 'aheadCtx' || s.t === 'look') return { ...s, is: !s.is };
      const m = oneTokenOf(s);
      if (m !== null) return { t: 'ahead', set: tokenSetOf(m), is: false };
    }
    return { t: 'look', id: lookaheadOf(steps), is: false };
  };

  // The names of the rule being lowered (nameRule): stepOf copies them onto the steps it makes.
  let names: RuleNames | null = null;
  const named = (e: RuleExpr, s: Step): Step => {
    const f = names?.childOf.get(e)?.name;
    if (f !== undefined) s.field = f;
    // Only an alternation the deriver walks has branch names (one inside a lookahead has none:
    // zero-width, it holds no child).
    const bs = s.t === 'alt' ? names?.branches.get(e) : undefined;
    if (bs !== undefined) (s as Extract<Step, { t: 'alt' }>).branchNames = bs.map((x) => x.name);
    return s;
  };
  // RuleExpr → Step, with the names `named` copies.
  function stepOf(e: RuleExpr): Step { return named(e, stepNode(e)); }
  function stepNode(e: RuleExpr): Step {
    switch (e.type) {
      case 'literal': return { t: 'lit', value: e.value, ttype: litTtype(e.value) };
      // A template reference carries its hole rule (RuleExpr ref.hole): the step also matches an
      // interpolated template, wherever it stands.
      case 'ref': return tokenNames.has(e.name) ? { t: 'tok', name: e.name, ...(e.hole !== undefined ? { hole: e.hole } : {}) } : { t: 'rule', name: e.name };
      case 'group': {
        const ss = altSteps(e.body);
        if (e.ctxMode) return ctxOf(e.ctxMode, ss);                                 // [Await]/[Yield] context
        if (e.suppress && e.suppress.length) return suppressOf(e.suppress, ss);   // no-`in` context
        return ss.length === 1 ? ss[0] : { t: 'seq', steps: ss };
      }
      case 'not': return e.reservable ? reservableOf(altSteps(e.body)) : notOf(altSteps(e.body));   // zero-width negative lookahead
      case 'sameLine': return { t: 'sameLine' };                  // zero-width no-newline assertion
      case 'seq': return { t: 'seq', steps: e.items.map(stepOf) };  // grouped sub-sequence (star/sep body)
      case 'sep': return { t: 'sep', elem: stepOf(e.element), delim: e.delimiter };
      case 'quantifier':
        if (e.kind === '*') return { t: 'star', step: stepOf(e.body) };
        if (e.kind === '?') return { t: 'opt', steps: altSteps(e.body) };
        if (e.kind === '+') return { t: 'seq', steps: [stepOf(e.body), { t: 'star', step: stepOf(e.body) }] };   // x+ = x x*
        break;
      case 'alt': {
        // Fast path: an all-literal alternation of single tokens (a composed '>' operator spans
        // several, so it takes the general path through its 'lit' step).
        if (e.items.every((it) => it.type === 'literal' && !gtComps.includes(it.value))) {
          return { t: 'altlit', opts: e.items.map((it) => ({ value: (it as { value: string }).value, ttype: litTtype((it as { value: string }).value) })) };
        }
        return { t: 'alt', branches: e.items.map(altSteps) };   // general: backtracking over sub-sequences
      }
    }
    throw new Error(`portable: rd construct '${e.type}' not in scope`);
  }
  function altSteps(e: RuleExpr): Step[] {
    if (e.type === 'seq') return e.items.map(stepOf);
    return [stepOf(e)];
  }

  // The Guard of a longest-match candidate (a rule alternative), from the grammar's own FIRST and
  // SECOND sets (grammar-analysis.ts exprFirst / exprSecond — the sets the interpreter prunes its
  // longest-match candidates with; exprFirst sees through a leading guard, an optional prefix and
  // a rule reference).
  // - first: the tokens a NON-EMPTY match of the alternative can begin with. An alternative that
  //   can only match nothing at a token cannot win a longest match, so skipping it there changes
  //   no parse. Not knowable (a Pratt rule leads: exprFirst gives up on `prefix`) → no guard.
  // - second: the tokens such a match can continue with. The argument: exprSecond over-approximates
  //   the token that follows the FIRST token of every match, and `len1` says whether a match of
  //   one token exists. Only when none does (and the alternative is not nullable — the
  //   interpreter's condition, gen-parser.ts altSecondDispatch) is a second token outside that set
  //   proof that the alternative cannot match non-empty here. That reads the token after the
  //   first as what follows it in the grammar, which holds only where the first token is ONE
  //   token of the stream: an interpolated template is a head token followed by its hole's
  //   tokens, so an alternative that can begin with a template kind gets no second guard.
  //   (A composed `>` operator is never a FIRST member — it is an infix operator — but may be a
  //   SECOND one; it is keyed on the `>` token it begins with.)
  //   test/fixtures/guardjs.ts has inputs the `len1` condition decides (`{x}`) and the guard refuses (`x;`).
  const templateTokens = new Set(grammar.tokens.filter((t) => t.template).map((t) => t.name));
  const keySet = (keys: Iterable<string>): TokenSet => {
    const lits: string[] = [], toks: string[] = [];
    for (const k of keys) {
      if (tokenNames.has(k)) { toks.push(k); if (templateTokens.has(k)) toks.push('$templateHead'); }   // an interpolated template opens with its head
      else lits.push(gtComps.includes(k) ? '>' : k);                                                    // a composed operator begins at a '>' token
    }
    return { lits, toks };
  };
  const guardSet = (m: TokenSet): GuardSet => { const id = tokenSetOf(m); return { id, ...tokenSets[id]! }; };
  // earlier: the candidates declared before `e` in its list, tried wherever they can match.
  const altGuard = (e: RuleExpr, earlier: readonly RuleExpr[]): Guard => {
    const all = a.exprFirst(e), lead = sameAsEarlierOutside(e, earlier, a.exprFirst);
    const f = lead === null ? all : all === null ? lead : new Set([...all].filter((k) => lead.has(k)));
    if (f === null || f.size === 0) return null;
    const oneToken = [...f].every((k) => !templateTokens.has(k));
    const sec = oneToken && !a.exprNullable(e) ? a.exprSecond(e) : null;
    const second = sec !== null && sec.s !== null && !sec.len1 && sec.s.size > 0 ? guardSet(keySet(sec.s)) : null;
    return { first: guardSet(keySet(f)), second, lead: [], skip: 0 };
  };
  // The guard of a candidate whose steps are `steps`, with the candidate's leading one-token tests
  // taken over (Guard.lead). Moving a test out of the candidate's frame onto the buffered token
  // changes nothing the candidate decides, because each such test (1) is zero-width and builds
  // nothing, (2) stands before every step that consumes, fails or changes the parser's state (the
  // context, the suppress set: a `ctx` / `suppress` step is not a lead test, and none is looked
  // through), so it reads the token at the candidate's start in the state the frame starts in,
  // and (3) reads only that token — its kind and literal, and for `aheadCtx` the context in force —
  // the token every target has already buffered there (a peek that reads no further than it, so
  // no lookahead extent grows). A refused candidate cannot match, so it was never tried anywhere a
  // refusal now skips. A shared step (ParserIR.shared) is a call, not a lead test.
  const leadOf = (g: Guard, steps: readonly Step[]): Guard => {
    let skip = 0;
    const lead: LeadTest[] = [];
    for (const s of steps) {
      if ((s.t !== 'ahead' && s.t !== 'aheadCtx') || ('share' in s && s.share !== undefined)) break;
      const t: LeadTest = { set: s.set, is: s.is, ctx: s.t === 'aheadCtx' };
      const prev = lead[lead.length - 1];
      if (prev !== undefined && !prev.is && !t.is) {
        // not in A, and not in B (or a context word): not in A ∪ B (or a context word)
        const x = tokenSets[prev.set]!, y = tokenSets[t.set]!;
        lead[lead.length - 1] = { set: tokenSetOf({ lits: [...x.lits, ...y.lits], toks: [...x.toks, ...y.toks] }), is: false, ctx: prev.ctx || t.ctx };
      } else lead.push(t);
      skip++;
    }
    if (skip === 0) return g;
    return g === null ? { first: null, second: null, lead, skip } : { ...g, lead, skip };
  };

  const rules: RuleIR[] = grammar.rules.map((r) => {
    // Pratt rules AND left-recursive non-Pratt rules (e.g. NewTarget, TS Type) both parse as
    // atom-then-continuation: buildPratt detects `startsSelf` and splits accordingly, so routing
    // left-recursive rules through it avoids the infinite left-recursion a plain rd rule would hit.
    names = nameRule(r);
    if (a.prattRules.has(r.name) || a.leftRecSet.has(r.name)) {
      const p = buildPratt(r.name, r.body, a, names, stepOf, named, notOf, reservableOf, suppressOf, ctxOf, litTtype, altGuard, templateTokens);
      p.nudSeqGuard = p.nudSeqGuard.map((g, i) => leadOf(g, p.nudSeqs[i]!));
      p.nudCappedGuard = p.nudCappedGuard.map((g, i) => leadOf(g, p.nudCapped[i]!.steps));
      return p;
    }
    const items = r.body.type === 'alt' ? r.body.items : [r.body];
    const altNames = items.map((e) => names!.armOf.get(e)!.name);
    const alts = items.map(altSteps);
    // A single alternative is no candidate (ruleShell SINGLE): it has no guard to take tests over.
    const altGuards = items.map((e, i) => altGuard(e, items.slice(0, i)));
    return { kind: 'rd', name: r.name, alts, altNames, altFirst: [], predictive: false, altGuard: items.length > 1 ? altGuards.map((g, i) => leadOf(g, alts[i]!)) : altGuards, altDispatch: { sections: [], ranked: [] } };
  });
  // Longest match never picks an alternative that advances nothing, and only the entry rule
  // may match the empty input: an entry that must CHOOSE its empty alternative has no rendering.
  const entryDecl = grammar.rules.find((r) => r.name === findEntryRule(grammar));
  if (entryDecl && entryDecl.body.type === 'alt' && entryDecl.body.items.length > 1 && a.exprNullable(entryDecl.body)
    && !a.prattRules.has(entryDecl.name) && !a.leftRecSet.has(entryDecl.name)) {
    throw new Error(`portable: entry rule ${entryDecl.name} has several alternatives and can match the empty input — not in scope (give it one alternative)`);
  }

  // Regex-vs-division context (only if the grammar declares a regex token + config).
  let regexCtx: RegexCtx | null = null;
  const rxTok = grammar.tokens.find((t) => t.flags.includes('regex'));
  const rxCfg = grammar.tokens.find((t) => t.regexContext)?.regexContext;
  if (rxTok && rxCfg) {
    regexCtx = {
      regexToken: rxTok.name,
      identToken: grammar.tokens.find((t) => t.identifier)?.name ?? '',
      // A template's tail ends a value as its NoSubstitution form does (the interpreter's LX_DIVK).
      divisionTypes: [...(rxCfg.divisionAfterTypes ?? []), ...(grammar.tokens.some((t) => t.template) ? ['$templateTail'] : [])],
      divisionTexts: [...(rxCfg.divisionAfterTexts ?? [])],
      regexTexts: [...(rxCfg.regexAfterTexts ?? [])],
      parenHeadKw: [...(rxCfg.regexAfterParenKeywords ?? [])],
      memberAccess: [...(rxCfg.memberAccessTexts ?? [])],
      postfixAfterValue: [...(rxCfg.postfixAfterValueTexts ?? [])],
    };
  }

  // Template literals (only if the grammar declares a template token).
  let tpl: TplCfg | null = null;
  const tplTok = grammar.tokens.find((t) => t.template);
  if (tplTok && tplTok.template) {
    tpl = {
      token: tplTok.name,
      open: tplTok.template.open,
      interpOpen: tplTok.template.interpOpen,
      interpClose: tplTok.template.interpClose,
      braceOpen: tplTok.template.interpOpen.slice(-1),
      escapeValid: tplTok.escapeValidPattern ?? null,
    };
  }

  let newlineCfg: NewlineCfg | null = null;
  if (grammar.newline) {
    const nc = grammar.newline;
    newlineCfg = {
      token: nc.token,
      flowOpen: [...(nc.flowOpen ?? [])],
      flowClose: [...(nc.flowClose ?? [])],
    };
  }

  const identToken = grammar.tokens.find((t) => t.identifier)?.name ?? null;
  const identLike = [
    ...(identToken ? [identToken] : []),
    ...grammar.tokens.filter((t) => t.identifierPrefix).map((t) => t.name),
  ];
  // ── FIRST signatures + predictive flags ──
  // Per-branch FIRST (literal texts + token kinds the branch can begin with, or null =
  // unpredictable) feeds Phase 3's predictive switch dispatch. Computed conservatively from the
  // Step IR: a branch is predictable iff its first CONSUMING step is a literal/token/altlit or a
  // reference to an all-predictable rd rule. A leading zero-width guard (not/sameLine), a nullable
  // quantifier (star/opt/sep), or a reference to a Pratt / mixed-alternative rule marks the branch
  // unpredictable → backtracking fallback. `ruleLead` is the fixpoint of each rule's own leading
  // FIRST (null if any alt is unpredictable); it resolves cross-rule references.
  const ruleLead = new Map<string, FirstSig>();
  const seqFirst = (steps: Step[]): FirstSig => {
    if (steps.length === 0) return null;
    const s = steps[0];
    switch (s.t) {
      case 'lit': return { lits: [gtComps.includes(s.value) ? '>' : s.value], toks: [] };   // a composed operator begins at a '>' token
      case 'tok': return { lits: [], toks: templateTokens.has(s.name) ? [s.name, '$templateHead'] : [s.name] };   // an interpolated template opens with its head
      case 'altlit': return { lits: s.opts.map((o) => o.value), toks: [] };
      case 'rule': case 'ruleBp': { const f = ruleLead.get(s.name); return f === undefined ? null : f; }
      case 'alt': {
        const lits = new Set<string>(); const toks = new Set<string>();
        for (const b of s.branches) { const f = seqFirst(b); if (f === null) return null; f.lits.forEach((x) => lits.add(x)); f.toks.forEach((x) => toks.add(x)); }
        return { lits: [...lits], toks: [...toks] };
      }
      case 'seq': return seqFirst(s.steps);
      case 'suppress': case 'ctx': return seqFirst(s.steps);
      case 'look': case 'ahead': case 'aheadCtx': case 'sameLine': case 'star': case 'opt': case 'sep': return null;   // zero-width / nullable leading → unpredictable
    }
    return null;
  };
  for (let changed = true, guard = 0; changed && guard <= rules.length + 2; guard++) {
    changed = false;
    for (const r of rules) {
      if (r.kind === 'pratt') { if (!ruleLead.has(r.name)) { ruleLead.set(r.name, null); changed = true; } continue; }
      const lits = new Set<string>(); const toks = new Set<string>(); let unpredictable = false;
      for (const alt of r.alts) {
        const f = seqFirst(alt);
        if (f === null) { unpredictable = true; break; }
        f.lits.forEach((x) => lits.add(x)); f.toks.forEach((x) => toks.add(x));
      }
      const next: FirstSig = unpredictable ? null : { lits: [...lits], toks: [...toks] };
      const prev = ruleLead.get(r.name);
      const same = prev === next
        || (prev != null && next != null && prev.lits.length === next.lits.length && prev.toks.length === next.toks.length
          && prev.lits.every((x) => next.lits.includes(x)) && prev.toks.every((x) => next.toks.includes(x)));
      if (!same) { ruleLead.set(r.name, next); changed = true; }
    }
  }
  // Two signatures are disjoint iff no token can begin both. A token is a kind and, when its text
  // is a literal, that literal; which kinds can carry a literal is the lexer's (literalKinds), not
  // the literal's spelling: `get` is an identifier, `@new` a decorator. So the signatures share no
  // literal text and no token kind, and neither begins with a literal some kind of the other's can
  // carry (`alt(['get', …], [Ident, …])` must try the second branch when the first fails on `get`).
  const kindsOf = literalKinds({ tokens, tpl, identToken, identLike, puncts });
  // ── Refusal by the complement of FIRST ──
  // A candidate whose FIRST the plain analysis does not know (a Pratt rule leads: Stmt's expression
  // statement, a for-head's expression arms) has no `first` set, so it was tried at every token. Its
  // FIRST over concrete symbols (grammar-analysis.ts concreteFirst: through prefix operators, with
  // one-token `not` tests and reserved-word guards applied) is known, and so is the set of tokens
  // that provably begin NO match of it: a literal outside that FIRST, and a kind outside it that
  // no literal of it may carry (the lexer plan's literalKinds, a superset: a token of such a kind
  // cannot be one of its literals, so it is not a member whatever its literal). That set is an
  // ordinary token set; the guard refuses the token when it is IN it, a negative lead test, so the
  // set test and its table are the ones every guard uses. It joins the candidate's own negative
  // lead test when it has one (one set test for both), else stands before the others.
  // It is emitted only where it can refuse a token the list is actually tried at: one that begins
  // another candidate of the same list. A refusal no such token reaches would be a test with
  // nothing to refute.
  const concrete = concreteFirst(grammar, a, { kindsOf: (l) => [...kindsOf(l)], gtComps, maybeWords: CTX_WORDS });
  {
    const kinds = [...tokens.map((t) => t.name), ...(tpl ? ['$templateHead', '$templateMiddle', '$templateTail'] : [])];
    const grammarLits = concrete.literals.filter((l) => !gtComps.includes(l));
    for (const r of rules) {
      if (r.kind !== 'rd' || r.alts.length < 2) continue;
      const decl = grammar.rules.find((d) => d.name === r.name)!;
      const items = decl.body.type === 'alt' ? decl.body.items : [decl.body];
      const firsts = items.map((e) => concrete.first1(e));
      r.altGuard = r.altGuard.map((g, i) => {
        if (g !== null && g.first !== null) return g;
        const f = firsts[i]!;
        const litsIn = [...f].filter((x) => !x.startsWith(KIND));
        const lits = grammarLits.filter((l) => !f.has(l));
        const toks = kinds.filter((k) => !f.has(KIND + k) && !litsIn.some((l) => kindsOf(l).has(k)));
        const refused = (x: string) => (x.startsWith(KIND) ? toks.includes(x.slice(KIND.length)) : lits.includes(x));
        if (!firsts.some((o, j) => j !== i && [...o].some(refused))) return g;
        const head = g?.lead[0];
        if (head !== undefined && !head.is) {
          const s = tokenSets[head.set]!;
          return { ...g!, lead: [{ set: tokenSetOf({ lits: [...s.lits, ...lits], toks: [...s.toks, ...toks] }), is: false, ctx: head.ctx }, ...g!.lead.slice(1)] };
        }
        const set = tokenSetOf({ lits, toks });
        return g === null ? { first: null, second: null, lead: [{ set, is: false, ctx: false }], skip: 0 } : { ...g, lead: [{ set, is: false, ctx: false }, ...g.lead] };
      });
    }
  }
  const meets = (a: NonNullable<FirstSig>, b: NonNullable<FirstSig>): boolean =>
    a.lits.some((l) => b.lits.includes(l) || b.toks.some((k) => kindsOf(l).has(k))) || a.toks.some((k) => b.toks.includes(k));
  const disjoint = (a: FirstSig, b: FirstSig): boolean => a !== null && b !== null && !meets(a, b) && !meets(b, a);
  const allDisjoint = (fs: FirstSig[]): boolean => {
    for (let i = 0; i < fs.length; i++) if (fs[i] === null) return false;
    for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) if (!disjoint(fs[i], fs[j])) return false;
    return true;
  };
  // Annotate each rule's alt-level FIRST + predictive flag, and walk nested Steps to annotate
  // inline `alt` branches (used by Phase 3's nested switch dispatch).
  // A star / opt / sep BODY GUARD (`guard`, a ParserIR.tokenSets id): the body's FIRST signature,
  // when it is known (seqFirst: every way the body can match begins by consuming one of its
  // tokens, so the body cannot match empty). Where the next token is outside it the body cannot
  // match, so the step stops (star), matches nothing (opt) or matches no element (sep: its first
  // element; after a delimiter the element must match anyway) without the body's attempt and the
  // mark it is attempted under.
  // A body that is one rd rule's call whose FIRST the plain analysis does not know (a Pratt rule
  // leads one of its alternatives: Block's `many(Stmt)`) is guarded by the rule's FIRST over concrete
  // symbols instead (concreteFirst, the one the complement refusal reads): its literals, and every
  // kind it holds as a kind. A token outside that set begins no match of the rule, so the attempt
  // (the rule's call, and the exit's attempt at `}`) is not made. A rule that can match empty has
  // no such guard (an empty match is not refused by its first token). A target whose refused rd call
  // is cheaper than the guard's test on every iteration does not take it (PortableFacts).
  const ruleGuard = (name: string): number | undefined => {
    if (!facts.calleeFirstGuards || !rules.some((r) => r.kind === 'rd' && r.name === name) || a.nullableRules.has(name)) return undefined;
    const f = concrete.first1({ type: 'ref', name });
    const lits = [...f].filter((x) => !x.startsWith(KIND));
    const toks = [...f].filter((x) => x.startsWith(KIND)).map((x) => x.slice(KIND.length));
    return tokenSetOf({ lits, toks });
  };
  const bodyGuard = (body: Step[]): number | undefined => {
    const f = seqFirst(body);
    if (f !== null) return tokenSetOf(f);
    return body.length === 1 && body[0]!.t === 'rule' ? ruleGuard(body[0]!.name) : undefined;
  };
  // A star / opt / sep body that FAILS CLEAN (`clean`): a failed attempt of it leaves the parser's
  // state (position, children, builder) as it found it, so the attempt takes no mark and a failure
  // undoes nothing. Each piece undoes its own failure: a literal or token test changes nothing until
  // it matches, a zero-width test never moves, an rd rule's function undoes itself on every form's
  // failure (ruleShell: the checkpoint at entry), an inline choice's branches each run in a BRANCH
  // frame, and a star / opt / sep never fails. A step list fails clean when everything before its
  // last step is a zero-width test and its last step fails clean. Not clean: a Pratt rule's call (it
  // can fail after its NUD matched: an operator whose operand must be a target), and any list whose
  // later step can fail after an earlier one consumed.
  const zeroWidth = (s: Step): boolean => s.t === 'ahead' || s.t === 'aheadCtx' || s.t === 'sameLine' || s.t === 'look';
  const rdRules = new Set(rules.filter((r) => r.kind === 'rd').map((r) => r.name));
  const failsClean = (s: Step): boolean => {
    switch (s.t) {
      case 'lit': case 'tok': case 'altlit': case 'alt': case 'star': case 'opt': case 'sep': return true;
      case 'rule': return rdRules.has(s.name);
      case 'seq': case 'suppress': case 'ctx': return listFailsClean(s.steps);
      default: return zeroWidth(s);
    }
  };
  const listFailsClean = (steps: Step[]): boolean => steps.length > 0 && steps.slice(0, -1).every(zeroWidth) && failsClean(steps[steps.length - 1]!);
  const annotateSteps = (steps: Step[]): void => {
    for (const s of steps) {
      if (s.t === 'star') { annotateSteps([s.step]); const g = bodyGuard([s.step]); if (g !== undefined) s.guard = g; if (failsClean(s.step)) s.clean = true; }
      else if (s.t === 'opt') { annotateSteps(s.steps); const g = bodyGuard(s.steps); if (g !== undefined) s.guard = g; if (listFailsClean(s.steps)) s.clean = true; }
      else if (s.t === 'seq' || s.t === 'suppress' || s.t === 'ctx') annotateSteps(s.steps);
      else if (s.t === 'sep') { annotateSteps([s.elem]); const g = bodyGuard([s.elem]); if (g !== undefined) s.guard = g; if (failsClean(s.elem)) s.clean = true; }
      else if (s.t === 'alt') {
        s.firsts = s.branches.map((b) => seqFirst(b));
        s.predictive = allDisjoint(s.firsts);
        s.branches.forEach(annotateSteps);
      }
    }
  };
  for (const r of rules) {
    if (r.kind === 'rd') {
      r.altFirst = r.alts.map((alt) => seqFirst(alt));
      r.predictive = allDisjoint(r.altFirst);
      if (!r.predictive && r.alts.length > 1) r.altDispatch = dispatchOf(r.altGuard.map((g) => g?.first ?? null));
      r.alts.forEach(annotateSteps);
    } else {
      r.nudSeqPredictive = allDisjoint(r.nudSeqs.map((seq) => seqFirst(seq)));
      r.nudSeqs.forEach(annotateSteps);
      r.nudCapped.forEach((c) => annotateSteps(c.steps));
      r.nudBrackets.forEach((b) => annotateSteps(b.steps));
      r.leds.forEach((b) => annotateSteps(b.steps));
      r.ledSuppressedIn = r.leds.map((b) => a.suppressedIn(b.first));
    }
  }
  lookaheads.forEach(annotateSteps);
  // ── Committed choices (Commit): the candidates each token can admit, per dispatch key ──
  {
    // The kinds a parser can buffer: a skipped token (trivia) never reaches it.
    const kinds = [...tokens.filter((t) => !t.skip).map((t) => t.name), ...(newlineCfg ? [newlineCfg.token] : []), ...(tpl ? ['$templateHead', '$templateMiddle', '$templateTail'] : [])];
    const nullableStep = (s: Step): boolean => {
      switch (s.t) {
        case 'lit': case 'tok': case 'altlit': return false;
        case 'rule': case 'ruleBp': return a.nullableRules.has(s.name);
        case 'alt': return s.branches.some(nullableList);
        case 'seq': case 'suppress': case 'ctx': return nullableList(s.steps);
        default: return true;   // star / opt / sep, and every zero-width test
      }
    };
    const nullableList = (steps: Step[]): boolean => steps.every(nullableStep);
    const P = { kinds, kindsOf, tokenSets, ctxWords };
    for (const r of rules) {
      if (r.kind === 'rd') {
        if (r.predictive || r.alts.length < 2) continue;
        const c = commitOf(r.altGuard.map((g, i) => ({
          first: g?.first ?? null, lead: g?.lead ?? [], runtime: g !== null && g.second !== null,
          nullable: nullableList(guardedSteps(g, r.alts[i]!)), clean: listFailsClean(guardedSteps(g, r.alts[i]!)),
        })), P);
        if (c) { r.altCommit = c; r.altDispatch = frameDispatch(r.altDispatch, c, kindsOf); r.altBody = commitBodies(c, r.altDispatch, r.alts.map((alt, i) => guardedSteps(r.altGuard[i]!, alt))); }
      } else {
        const ops = [...new Set(r.prefix.map((p) => p.op))];
        const c = commitOf(r.nudOrder.map((n): CommitCand => {
          switch (n.kind) {
            case 'tok': {
              const k = r.nudToks[n.index]!;
              const tplArm = r.nudTplHole !== undefined && tpl !== null && k === tpl.token;
              return { first: { lits: [], toks: tplArm ? [k, '$templateHead'] : [k] }, lead: [], runtime: false, nullable: false, clean: true, ...(tplArm ? { frameAt: ['$templateHead'] } : {}) };
            }
            case 'bracket': { const b = r.nudBrackets[n.index]!; return { first: { lits: [b.first], toks: [] }, lead: [], runtime: false, nullable: nullableList(b.steps), clean: listFailsClean(b.steps) }; }
            case 'seq': { const g = r.nudSeqGuard[n.index]!; const st = guardedSteps(g, r.nudSeqs[n.index]!); return { first: g?.first ?? null, lead: g?.lead ?? [], runtime: g !== null && g.second !== null, nullable: nullableList(st), clean: listFailsClean(st) }; }
            case 'capped': { const g = r.nudCappedGuard[n.index]!; const st = guardedSteps(g, r.nudCapped[n.index]!.steps); return { first: g?.first ?? null, lead: g?.lead ?? [], runtime: true, nullable: nullableList(st), clean: listFailsClean(st) }; }
            case 'prefix': return { first: { lits: ops, toks: [] }, lead: [], runtime: false, nullable: false, clean: false };
          }
        }), P);
        if (c) { r.nudCommit = c; r.nudDispatch = frameDispatch(r.nudDispatch, c, kindsOf); r.nudBody = commitBodies(c, r.nudDispatch, r.nudOrder.map((n) => (n.kind === 'bracket' ? r.nudBrackets[n.index]!.steps : n.kind === 'seq' ? guardedSteps(r.nudSeqGuard[n.index]!, r.nudSeqs[n.index]!) : n.kind === 'capped' ? guardedSteps(r.nudCappedGuard[n.index]!, r.nudCapped[n.index]!.steps) : null))); }
      }
    }
  }

  const shared = shareSteps([
    ...rules.flatMap(printedBodies),
    ...lookaheads,
  ]);
  const entry = findEntryRule(grammar);
  const forms = formsOf(rules, lookaheads, shared.length, entry);
  const identPrefix = Object.fromEntries(identLike.map((n) => [n, grammar.tokens.find((t) => t.name === n)?.identifierPrefix ?? '']));
  return { grammarName: grammar.name ?? 'grammar', entry, tokens, puncts, gtComps, rules, tokenSets, ctxWords, lookaheads, shared, forms, reuse: reusePlanOf(rules, entry), suppressSets, regexCtx, tpl, newlineCfg, identToken, identLike, identPrefix };
}

// The step lists a rule runs: an rd rule's alternatives, a Pratt rule's NUD and LED arms.
const ruleBodies = (r: RuleIR): Step[][] => (r.kind === 'rd' ? r.alts : [...r.nudBrackets.map((b) => b.steps), ...r.nudSeqs, ...r.nudCapped.map((c) => c.steps), ...r.leds.map((b) => b.steps)]);
// The step lists a rule's functions print, once per place they are printed at (what shareSteps
// counts): a candidate of a list with a Commit once in its frame if the frame still reaches it
// (frameDispatch), and once per commit of it the switch prints (commitPrinted).
const dispatchArms = (d: Dispatch): Set<number> => new Set(d.sections.flatMap((s) => (s.by === 'rest' ? s.arms : s.groups.flatMap((g) => g.arms))));
const commitBodiesOf = (r: RuleIR): Step[] => ((r.kind === 'rd' ? r.altBody : r.nudBody) ?? []).filter((b): b is Step => b !== null);
function printedBodies(r: RuleIR): Step[][] {
  const c = r.kind === 'rd' ? r.altCommit : r.nudCommit;
  if (c === undefined) return ruleBodies(r);
  const times = (i: number, d: Dispatch) => (dispatchArms(d).has(i) ? 1 : 0) + commitPrinted(c).filter((a) => a.arm === i).length;
  // An arm with a body (commitBodies) is that one step at each of its places.
  const at = (i: number, steps: Step[], d: Dispatch, body: Array<Step | null> | undefined) => { const b = body?.[i]; return Array<Step[]>(times(i, d)).fill(b ? [b] : steps); };
  if (r.kind === 'rd') return r.alts.flatMap((alt, i) => at(i, alt, r.altDispatch, r.altBody));
  const arm = (kind: NudRef['kind'], index: number) => r.nudOrder.findIndex((n) => n.kind === kind && 'index' in n && n.index === index);
  const each = (kind: NudRef['kind'], lists: Step[][]) => lists.flatMap((s, k) => at(arm(kind, k), s, r.nudDispatch, r.nudBody));
  return [...each('bracket', r.nudBrackets.map((b) => b.steps)), ...each('seq', r.nudSeqs), ...each('capped', r.nudCapped.map((c) => c.steps)), ...r.leds.map((b) => b.steps)];
}
// The steps directly inside a step (a `look` step's body is a lookahead of its own, not inside it).
const stepKids = (s: Step): Step[] => {
  switch (s.t) {
    case 'star': return [s.step];
    case 'sep': return [s.elem];
    case 'opt': case 'seq': case 'suppress': case 'ctx': return s.steps;
    case 'alt': return s.branches.flat();
    default: return [];
  }
};

// ── Forms: what is built, and what is only recognized ──
// A lookahead runs its body and then undoes everything the body did (see `look`), so nothing the
// body builds is ever seen: what it decides is only whether the body matches, and where it ends.
// So a lookahead body is printed in RECOGNIZE form: each step advances and reports whether it
// matched, and builds nothing — no leaf, no children list, no node, no builder call. It examines
// exactly the tokens the building form examines (the same peeks, the same moves back, in the same
// order), so an entry's extent (EntryMeta.ext) is unchanged, and it reads and restores the parser's
// state (the suppress set, the [Await]/[Yield] context) exactly as the building form does.
// A rule a recognize-form step calls is recognized too: an rd rule has a recognize form (its
// longest match compares end positions only, since the node a tie would choose is never seen); a
// Pratt rule does not, because what it accepts reads the nodes it built (the head leaf a led tests,
// PrattRule.ledNotLeftLeaf), so its recognize form runs the building form and drops the node. A
// lookahead whose body reaches such a call therefore builds, and undoes the builder as well as the
// position (`lookBuilds`); every other lookahead undoes only the position.
// Each rule and shared step is printed in the forms its call sites need: building where a
// consuming position (the entry rule's parse, a template hole, a dropped Pratt parse) reaches it,
// recognize where a lookahead body reaches it; a rule reached both ways has both.
export type Forms = {
  buildRules: string[];        // rules printed in building form
  recognizeRules: string[];    // rules printed in recognize form
  buildShared: boolean[];      // parallel to ParserIR.shared: printed in building form
  recognizeShared: boolean[];  // parallel to ParserIR.shared: printed in recognize form
  lookBuilds: boolean[];       // parallel to ParserIR.lookaheads: its body runs a Pratt rule's building form
  /** The recognize-form functions that run no building form, directly or through anything they
   *  call: they read and move the token cursor alone (position, tokens, look extent, suppress set,
   *  context), so a target with several engine types may print them once, on the cursor. */
  cursorOnly: { rules: string[]; shared: boolean[]; looks: boolean[] };
};
// ── The step walk: one description of how a step runs, rendered by every target ──
// What a step runs, and under which frame, is decided here once: a star / opt / sep body (a step
// inside a body), an ordered choice (each branch in a BRANCH frame, tried under its FIRST set when
// that is small enough to test: isFirstGuardable), a predictive choice (only the branch its FIRST
// set selects), a suppress or ctx body (the state set around the body's conjunction), a shared
// step (ParserIR.shared: its function's call), and every leaf test. A StepLowering spells each
// piece in one target's language, for one engine form (building or recognizing, ParserIR.forms)
// over one receiver; it holds only that spelling.
export type StepLowering = {
  inner(): StepLowering;                         // the lowering inside a body or a choice (a target whose closures take their own receiver)
  shared(id: number): string;                    // a call of ParserIR.shared[id] in this form
  lit(s: Step & { t: 'lit' }): string;
  tok(name: string): string;
  template(name: string, hole: string): string;  // the template kind `name`: its token, or an interpolated template whose holes `hole` parses (a building form, recognized or not: its node is dropped when recognizing)
  rule(name: string): string;
  ruleBp(name: string, bp: number): string;      // only a Pratt rule is called at a binding power
  // body: the inner step, as a boolean expression; guard: the body is attempted only when the next
  // token is in ParserIR.tokenSets[guard] (null: always attempted); clean: the body fails clean
  // (Step.clean), so an attempt takes no mark and a failed one undoes nothing
  star(body: string, guard: number | null, clean: boolean): string;
  opt(body: string, guard: number | null, clean: boolean): string;
  sep(elem: string, delim: string, guard: number | null, clean: boolean): string;   // guard: of the first element
  altlit(values: string[]): string;
  look(id: number, is: boolean): string;         // a lookahead runs in recognize form whatever the form around it
  ahead(set: number, is: boolean): string;
  aheadCtx(set: number, is: boolean): string;
  sameLine(): string;
  inPlace(kind: 'alt' | 'suppress' | 'ctx', stmts: string): string;  // the step's statements (stepStmts) run where the step is
  ret(cond: string): string;                     // statements returning cond
  suppress(set: number, cond: string): string;   // statements: cond with ParserIR.suppressSets[set] staged for the next Pratt call
  ctx(ctx: Ctx, cond: string): string;           // statements: cond in context ctx, the one in force put back after
  branch(cond: string): string;                  // a BRANCH frame: returns true when cond matched, else undoes it
  guarded(first: NonNullable<FirstSig>, branch: string): string;   // the branch, tried only when the next token is in first
  choice(peek: boolean, tries: string[]): string;                  // the tries in order, then false; peek: a guard reads the next token
  predictive(arms: { first: NonNullable<FirstSig>; branch: string }[]): string;   // the one arm the next token selects, else false
};
const conjOf = (steps: Step[], L: StepLowering): string => (steps.length ? steps.map((x) => stepExpr(x, L)).join(' && ') : 'true');
/** A step as a boolean expression: a shared step's call, else the step itself (stepBody). */
export function stepExpr(s: Step, L: StepLowering): string {
  if ('share' in s && s.share !== undefined) return L.shared(s.share);
  return stepBody(s, L);
}
/** The step itself, printed in place (a shared step's function body; every other step's site). */
export function stepBody(s: Step, L: StepLowering): string {
  switch (s.t) {
    case 'lit': return L.lit(s);
    case 'tok': return s.hole !== undefined ? L.template(s.name, s.hole) : L.tok(s.name);
    case 'rule': return L.rule(s.name);
    case 'ruleBp': return L.ruleBp(s.name, s.bp);
    case 'star': return L.star(stepExpr(s.step, L.inner()), s.guard ?? null, s.clean === true);
    case 'opt': { const I = L.inner(); return L.opt(s.steps.map((x) => stepExpr(x, I)).join(' && '), s.guard ?? null, s.clean === true); }
    case 'sep': return L.sep(stepExpr(s.elem, L.inner()), s.delim, s.guard ?? null, s.clean === true);
    case 'altlit': return L.altlit(s.opts.map((o) => o.value));
    case 'alt': return L.inPlace('alt', stepStmts(s, L.inner()));
    case 'look': return L.look(s.id, s.is);
    case 'ahead': return L.ahead(s.set, s.is);
    case 'aheadCtx': return L.aheadCtx(s.set, s.is);
    case 'seq': return `(${conjOf(s.steps, L)})`;
    case 'sameLine': return L.sameLine();
    case 'suppress': return L.inPlace('suppress', L.suppress(s.set, conjOf(s.steps, L)));
    case 'ctx': return L.inPlace('ctx', L.ctx(s.ctx, conjOf(s.steps, L)));
  }
}
/** The step as the statements of a function returning whether it matched (a shared step's body;
 *  an `alt`, `suppress` or `ctx` step run in place). */
export function stepStmts(s: Step, L: StepLowering): string {
  switch (s.t) {
    case 'alt': {
      if (s.predictive) return L.predictive(s.branches.map((br, i) => ({ first: s.firsts![i]!, branch: L.branch(conjOf(br, L)) })));
      const firsts = s.firsts ?? [];
      const n = s.branches.length;
      const tries = s.branches.map((br, i) => {
        const b = L.branch(conjOf(br, L));
        const f = firsts[i] ?? null;
        return isFirstGuardable(f, n) ? L.guarded(f, b) : b;
      });
      return L.choice(s.branches.some((_, i) => isFirstGuardable(firsts[i] ?? null, n)), tries);
    }
    case 'suppress': return L.suppress(s.set, conjOf(s.steps, L));
    case 'ctx': return L.ctx(s.ctx, conjOf(s.steps, L));
    default: return L.ret(stepBody(s, L));
  }
}

// ── The candidate dispatch: one walk over a Dispatch, rendered by every target ──
// A DispatchLowering spells a `lid` / `kid` section's switch on the buffered token (each case: its
// key and its candidates' statements, in order) and the test around it when that token may be
// absent; `rest` sections are their candidates' statements in order.
export type DispatchLowering = {
  sw(by: 'lid' | 'kid', cases: { key: string; arms: string[] }[]): string;
  nil(sw: string): string;                       // the switch, run only when there is a token
};
/** A candidate list's Dispatch: arm(i, keyed) is candidate i's statement (keyed: reached through
 *  its key, which already tested the first token). nilable: the token may be absent. */
export function dispatchWalk(d: Dispatch, ids: LexIdPlan, arm: (i: number, keyed: boolean) => string, D: DispatchLowering, nilable: boolean): string {
  return d.sections.map((sec) => {
    if (sec.by === 'rest') return sec.arms.map((i) => arm(i, false)).join('\n');
    const id = (k: string) => String(sec.by === 'lid' ? lidOf(ids, k) : kidOf(ids, k));
    const sw = D.sw(sec.by, sec.groups.map((g) => ({ key: id(g.key), arms: g.arms.map((i) => arm(i, true)) })));
    return nilable ? D.nil(sw) : sw;
  }).join('\n');
}

// ── The rule shell: how an rd rule's function runs, decided once ──
// Three forms, from the rule's plan (RdRule): PREDICTIVE (the alternative the next token's FIRST
// set selects, nothing else: no candidate frame, a commit), SINGLE (one alternative: nothing to
// choose), LONGEST (every alternative its Dispatch admits, each in a CANDIDATE frame; the longest
// wins, a tie the one declared first). A RuleLowering spells, for one rule in one engine form, the
// function around the statements, the checkpoint and undo, how an alternative's match is accepted
// (`accept(i)`: a node finished for alternative i, or only `true` when recognizing; the place a
// per-alternative construction by a shape plan would go), the candidate frame and its guard.
export type RuleLowering = {
  steps: StepLowering;                           // the alternatives' steps
  fn(lines: string[]): string;                   // the rule's function around its statements
  ind: string;                                   // a statement's indentation
  ifThen(test: string, then: string): string;    // `if test then` (no indentation)
  first(f: FirstSig): string;                    // whether the buffered token starts an alternative (predictive)
  accept(i: number): string;                     // the statement returning alternative i's match
  open: string;                                  // PREDICTIVE / SINGLE: the checkpoint at entry
  peekOrFail: string;                            // PREDICTIVE: buffer the next token; none: no match
  armJoin: string;                               // between PREDICTIVE arms
  fail: string;                                  // undo to the checkpoint; no match
  openBest(d: Dispatch): string;                 // LONGEST: the checkpoint and the best so far
  peekOpt: string;                               // LONGEST: buffer the next token (when a guard reads it)
  cand(d: Dispatch, i: number, cond: string): string;      // the CANDIDATE frame of alternative i
  guard(g: Guard, keyed: boolean, stmt: string): string;   // the candidate's statement under its Guard
  dispatch: DispatchLowering;
  closeBest: string;                             // LONGEST: go to the best's end; return it
  // COMMITTED CHOICE (RdRule.altCommit): before the frame, the buffered token's Commit switch.
  commitPeek: string;                            // buffer the next token for the switch and the frame after it
  commitSteps?: StepLowering;                    // the committed alternative's steps, where the switch runs over another receiver than the frame
  guardConds(g: Guard): string[];                // a Guard's tests of the buffered token (in the switch, where it is present)
  commit(i: number, conds: string[], cond: string, undo: boolean, nullable: boolean): string;  // alternative i committed: when conds hold its steps `cond` run, its match returned (none of no token, when nullable); else no match. undo: its failure is undone to a checkpoint
  commitFail: string;                            // no match, from the switch
  commitSw: CommitLowering;
};
/** An rd rule's function in the form `L` spells. */
export function ruleShell(r: RdRule, ids: LexIdPlan, L: RuleLowering): string {
  const cond = (steps: Step[]) => conjOf(steps, L.steps);
  if (r.predictive) {
    const arm = (steps: Step[], i: number) => `${L.ind}${i === 0 ? '' : 'else '}${L.ifThen(L.first(r.altFirst[i] ?? null), `{ ${L.ifThen(cond(steps), L.accept(i))} }`)}`;
    return L.fn([L.open, L.peekOrFail, r.alts.map(arm).join(L.armJoin), L.fail]);
  }
  if (r.alts.length === 1) return L.fn([L.open, `${L.ind}${L.ifThen(cond(r.alts[0]!), L.accept(0))}`, L.fail]);
  // An alternative's steps as the frame or the commit (over S) runs them: its body step when it has one (commitBodies).
  const body = (i: number, S: StepLowering) => { const b = r.altBody?.[i]; return b ? stepExpr(b, S) : conjOf(guardedSteps(r.altGuard[i]!, r.alts[i]!), S); };
  const arm = (i: number, keyed: boolean) => L.guard(r.altGuard[i]!, keyed, L.cand(r.altDispatch, i, body(i, L.steps)));
  const needPeek = r.altGuard.some((g) => g !== null);
  const frame = [dispatchWalk(r.altDispatch, ids, arm, L.dispatch, true), L.closeBest];
  if (r.altCommit === undefined) return L.fn([L.openBest(r.altDispatch), ...(needPeek ? [L.peekOpt] : []), ...frame]);
  const S = L.commitSteps ?? L.steps;
  const tests = (t: CommitTest) => L.guardConds(commitGuard(r.altGuard[t.arm]!, t));
  const act = (a: CommitAct | null) => (a === null ? L.commitFail
    : L.commit(a.arm, tests(a), body(a.arm, S), !a.clean || a.nullable, a.nullable));
  // A frame left with no candidate (the switch decides every key it could reach) matches nothing.
  const rest = dispatchArms(r.altDispatch).size === 0 ? [`${L.ind}${L.commitFail}`] : [L.openBest(r.altDispatch), ...frame];
  return L.fn([L.commitPeek, L.dispatch.nil(commitWalk(r.altCommit, ids, act, tests, L.commitSw)), ...rest]);
}

// ── The committed choice: one walk over a Commit, rendered by every target ──
// A CommitLowering spells a switch on the buffered token's literal or kind (each case: its keys
// and its statement, '' for one that goes on to the frame; `dflt`: every other key's statements),
// and the run-time tests: `ifAll` (stmt under conds) and `notAll` (the negation of a conjunction).
// A commit that several cases share (one arm, the same run-time tests, under different `unless`
// sets) is printed once: those cases `pick` its number (from 1; `pickDecl` declares the variable,
// 0: none picked) and `picked` runs the one picked after the switch.
export type CommitLowering = {
  sw(by: 'lid' | 'kid', cases: { keys: string[]; stmt: string }[], dflt: string): string;
  ifAll(conds: string[], stmt: string): string;
  notAll(conds: string[]): string;
  pickDecl: string;
  pick(n: number): string;
  picked(cases: { n: number; stmt: string }[]): string;
};
/** The tests a run still makes of a candidate's Guard at a key (CommitTest). */
export const commitGuard = (g: Guard, t: CommitTest): Guard =>
  (g === null ? null : { first: t.first ? g.first : null, second: g.second, lead: t.lead.map((k) => g.lead[k]!), skip: g.skip });
/** A Commit's switch: act(a) commits (or, null, fails); tests(t) are a candidate's run-time tests,
 *  each `unless` candidate's refusal a condition of its commit. */
// A commit by what it runs (its arm and its own tests): the cases that run the same are one printing.
const commitWhat = (a: CommitAct) => JSON.stringify({ ...a, unless: undefined });
/** The commits a Commit's switch prints, once each (commitWalk): the arms whose steps it prints. */
export function commitPrinted(c: Commit): CommitAct[] {
  const out = new Map<string, CommitAct>();
  for (const x of [...c.lid, ...c.kid]) if (x.act !== null && x.act !== 'frame' && !out.has(commitWhat(x.act))) out.set(commitWhat(x.act), x.act);
  return [...out.values()];
}
export function commitWalk(c: Commit, ids: LexIdPlan, act: (a: CommitAct | null) => string, tests: (t: CommitTest) => string[], C: CommitLowering): string {
  // A commit shared by more than one case is picked.
  const what = commitWhat;
  const uses = new Map<string, number>();
  for (const x of [...c.lid, ...c.kid]) if (x.act !== null && x.act !== 'frame') uses.set(what(x.act), (uses.get(what(x.act)) ?? 0) + 1);
  const shared = [...uses].filter(([, n]) => n > 1).map(([w]) => w);
  const stmt = (a: CommitCase['act']): string => {
    if (a === 'frame') return '';
    if (a === null) return act(null);
    const n = shared.indexOf(what(a)) + 1;
    return C.ifAll(a.unless.map((u) => {
      const t = tests(u);
      if (t.length === 0) throw new Error('commitWalk: an unless candidate has no run-time test');
      return C.notAll(t);
    }), n > 0 ? C.pick(n) : act(a));
  };
  const id = (by: 'lid' | 'kid', k: string): string => {
    const n = by === 'lid' ? lidOf(ids, k) : kidOf(ids, k);
    if (n === 0) throw new Error(`commitWalk: ${by} key ${JSON.stringify(k)} has no id`);
    return String(n);
  };
  const cases = (by: 'lid' | 'kid', cs: CommitCase[]) => cs.map((x) => ({ keys: x.keys.map((k) => id(by, k)), stmt: stmt(x.act) }));
  const kid = c.kid.length ? C.sw('kid', cases('kid', c.kid), '') : '';
  const sw = c.lid.length ? C.sw('lid', cases('lid', c.lid), kid) : kid;
  if (shared.length === 0) return sw;
  const acts = [...c.lid, ...c.kid].map((x) => x.act).filter((x): x is CommitAct => x !== null && x !== 'frame');
  return [C.pickDecl, sw, C.picked(shared.map((w, k) => ({ n: k + 1, stmt: act(acts.find((x) => what(x) === w)!) })))].join('\n');
}

// ── The entry rule with reuse recording (ParserIR.reuse), decided once ──
// Shape A: the entry is a loop over top-level entries, each the first of plan.rules that matches,
// recording one EntryMeta per entry. Shape B: an optional head segment (the head rule), then loop
// segments (the loop token, then the loop rule when it follows), each recorded as a Seg / EntryMeta.
// An EntryLowering spells the functions and what a segment records in one engine form.
export type EntryLowering = {
  topCall(rule: string): string;                 // shape A, one rule: the statement returning its match
  topTry(rule: string): string;                  // shape A: the rule tried from here, its match returned
  topFail: string;                               // shape A: none matched
  entryA(topOne: string): string;                // shape A: the top-one function (body `topOne`) and the entry
  headSeg(rule: string): string;                 // shape B: the head segment's function
  headUse: string;                               // shape B: the entry's statements recording the head segment
  loopSeg(kid: number, rule: string): string;    // shape B: one loop segment's function
  entryB(headSeg: string, headUse: string, loopSeg: string): string;   // shape B: the functions and the entry ('' when there is no head)
};
/** The entry rule's functions under a reuse plan, in the form `L` spells. */
export function entryShell(plan: ReusePlan, ids: LexIdPlan, L: EntryLowering): string {
  if (plan.kind === 'A') return L.entryA(plan.rules.length === 1 ? L.topCall(plan.rules[0]!) : [...plan.rules.map((n) => L.topTry(n)), L.topFail].join('\n'));
  const head = plan.hasHead ? plan.headRule : null;
  return L.entryB(head ? L.headSeg(head) : '', head ? L.headUse : '', L.loopSeg(kidOf(ids, plan.loopTok), plan.loopRule));
}

// ── The Pratt shell: how a Pratt rule's functions run, decided once ──
// Three functions: the entry (the suppress set staged for this call put in force), `bp` (a NUD,
// then the LED loop at a minimum binding power) and `nud` (every NUD arm the rule's Dispatch
// admits, each a longest-match candidate). The LED loop tries, in order: the led groups (the leds
// by their connector's lid, each arm under its guard; a group whose arms all failed ends the loop
// when prattLedExits says no later check can take its token), the postfix tokens (by kid; then an
// interpolated template), the postfix operator, the binary operator. A PrattLowering spells, for
// one rule in one engine form, each piece. Where a match becomes a value (the place a shape plan's
// per-arm `construct` goes): nudLeaf / nudTpl / nudSeq / nudPrefix (a NUD arm's node), led (a
// led's node over the left operand), postfixToks / postfixTpl / postfixOp / binary (an operator
// node over it); and `leftDone`: the left operand the loop leaves, once nothing continues it.
export type LedGuardLowering = {
  tailOpen: string;                              // no postfix closed the access tail
  lbpAbove(lbp: number): string;                 // the led's precedence gate: lbp > minBp
  sameLine: string;                              // the connector is on the operand's line
  notLeftLeaf(words: string[]): string;          // the left node's head-leaf text is none of words
  notSuppressed(set: number): string;            // the suppress set in force is not ParserIR.suppressSets[set]
  ifAll(parts: string[]): string;                // the `if` before the led's block ('' when nothing gates it)
};
export type PrattLowering = {
  steps: StepLowering;                           // the arms' steps
  ifAll(conds: string[], stmt: string): string;  // `if conds then stmt` as one statement (stmt alone when none)
  kidIs(kid: number): string;                    // the buffered token's kind is kid
  lidIs(lid: number): string;                    // the buffered token's literal is lid
  capBelow(bp: number): string;                  // minBp < bp: a capped arm is a candidate
  nudGuard(g: Guard, keyed: boolean): string[];  // the conditions of a NUD candidate's Guard on the buffered token (keyed: its Dispatch key tested the first token)
  beats(i: number, end: string): string;         // arm i, ending at end, beats the best so far
  leafEnd: string;                               // where a one-token arm ends
  nudLeaf(i: number): string;                    // the token arm i (after its tests): its node as the best
  nudTpl(i: number, hole: string): string;       // arm i's interpolated template, whose holes `hole` parses
  nudSeq(i: number, cond: string, closesTail: boolean, capped: boolean): string;  // the CANDIDATE frame of a sequence arm
  nudPrefix(i: number): string;                  // the prefix-operator arm
  dispatch: DispatchLowering;
  led: LedGuardLowering;
  ledArm(i: number, cond: string, form: AssignForm, closesTail: boolean, exit: boolean): string;  // led i's block: its node over the left operand, else undone (and the loop left when exit)
  ledSwitch(cases: { key: number; arms: string[] }[]): string;      // the led groups, by the token's lid
  postfixToks(kids: number[]): string;           // the postfix tokens, by the token's kid
  postfixTpl(hole: string): string;              // the postfix interpolated template
  postfixOp: string;                             // the postfix operator
  binary: string;                                // the binary operator, its right operand at rbp
  leftDone?: string;                             // after the loop: the left operand's finishing step (none for the CST)
  entry: string;                                 // the entry function (and the operator tables, where the target prints them beside it)
  bpOpen(label: boolean): string;                // `bp` up to the loop's buffered token (label: a led continues the loop by name)
  bpClose: string;
  nudEnter: string;                              // `nud` up to its buffered token `t` (none: no match)
  nudOpen: string;                               // `nud`'s candidate frame, up to its candidates
  nudClose: string;
  nudEnd: string;                                // the end of `nud`'s function, where it has no frame (the commit switch decides every key)
  // COMMITTED CHOICE (PrattRule.nudCommit): before the frame, the buffered token's Commit switch.
  // Each commit runs its arm when conds hold and returns its node, else fails (commitFail: no
  // match, with the state the frame leaves when nothing matched).
  commitLeaf(i: number, conds: string[]): string;                 // token arm i
  commitSeq(i: number, conds: string[], cond: string, closesTail: boolean, capped: boolean, undo: boolean, nullable: boolean): string;  // a bracket / sequence / capped arm
  commitPrefix(i: number, conds: string[]): string;               // the prefix-operator arm
  commitFail: string;
  commitSw: CommitLowering;
};
/** A Pratt rule's functions in the form `L` spells. */
export function prattShell(r: PrattRule, ir: Pick<ParserIR, 'tokens' | 'tpl' | 'identToken' | 'identLike' | 'puncts' | 'gtComps'>, ids: LexIdPlan, L: PrattLowering): string {
  const cond = (steps: Step[]) => conjOf(steps, L.steps);
  const d = r.nudDispatch;
  // An arm's steps: its body step when it has one (commitBodies).
  const armCond = (i: number, steps: Step[]) => { const b = r.nudBody?.[i]; return b ? stepExpr(b, L.steps) : cond(steps); };
  const nudArm = (i: number, keyed: boolean): string => {
    const a = r.nudOrder[i]!;
    switch (a.kind) {
      case 'tok': {
        const k = r.nudToks[a.index]!;
        const leaf = L.ifAll([...(keyed ? [] : [L.kidIs(kidOf(ids, k))]), L.beats(i, L.leafEnd)], L.nudLeaf(i));
        return r.nudTplHole === undefined || !ir.tpl || k !== ir.tpl.token ? leaf : `${leaf}\n${L.nudTpl(i, r.nudTplHole)}`;
      }
      case 'bracket': {
        const b = r.nudBrackets[a.index]!;
        return L.ifAll(keyed ? [] : [L.lidIs(lidOf(ids, b.first))], L.nudSeq(i, armCond(i, b.steps), r.nudBracketClosesTail[a.index]!, false));
      }
      case 'seq': {
        const g = r.nudSeqGuard[a.index]!;
        return L.ifAll(L.nudGuard(g, keyed), L.nudSeq(i, armCond(i, guardedSteps(g, r.nudSeqs[a.index]!)), r.nudSeqClosesTail[a.index]!, false));
      }
      case 'capped': {
        const c = r.nudCapped[a.index]!;
        const g = r.nudCappedGuard[a.index]!;
        return L.ifAll([L.capBelow(c.capBp), ...L.nudGuard(g, keyed)], L.nudSeq(i, armCond(i, guardedSteps(g, c.steps)), false, true));
      }
      case 'prefix': return L.nudPrefix(i);
    }
  };
  const G = L.led;
  const ledIf = (i: number) => {
    const parts: string[] = [];
    if (r.ledAccessTail[i]) parts.push(G.tailOpen);
    const lbp = r.ledLbp[i]!;
    if (lbp !== null) parts.push(G.lbpAbove(lbp));
    if (r.ledSameLine[i]) parts.push(G.sameLine);
    const nll = r.ledNotLeftLeaf[i]!;
    if (nll) parts.push(G.notLeftLeaf(nll));
    for (const set of r.ledSuppressedIn[i]!) parts.push(G.notSuppressed(set));
    return G.ifAll(parts);
  };
  const exits = prattLedExits(r, ir, ids);
  const leds = r.leds.length === 0 ? '' : L.ledSwitch(groupByPreserveOrder(r.leds, (b) => lidOf(ids, b.first)).map((g) => {
    const lid = g.key as number;
    return { key: lid, arms: g.members.map(({ item: b, index: i }, j) =>
      `${ledIf(i)}${L.ledArm(i, cond(b.steps), r.ledForm[i]!, r.ledClosesTail[i]!, exits.has(lid) && j === g.members.length - 1)}`) };
  }));
  const postToks = r.postfixToks.length === 0 ? ''
    : L.postfixToks(groupByPreserveOrder(r.postfixToks, (tok) => kidOf(ids, tok)).map((g) => g.key as number)) + (r.postfixTplHole !== undefined ? L.postfixTpl(r.postfixTplHole) : '');
  const bp = [L.bpOpen(r.leds.length > 0 || r.postfixToks.length > 0), leds, postToks, L.postfixOp, L.binary, ...(L.leftDone ? [L.leftDone] : []), L.bpClose].join('\n');
  // The committed arm's run-time tests at a key (CommitTest): its token / literal unless the key
  // decides it, its guard's remaining tests, a capped arm's binding power.
  const tests = (t: CommitTest): string[] => {
    const a = r.nudOrder[t.arm]!;
    switch (a.kind) {
      case 'tok': return t.first ? [L.kidIs(kidOf(ids, r.nudToks[a.index]!))] : [];
      case 'bracket': return t.first ? [L.lidIs(lidOf(ids, r.nudBrackets[a.index]!.first))] : [];
      case 'seq': return L.nudGuard(commitGuard(r.nudSeqGuard[a.index]!, t), false);
      case 'capped': return [L.capBelow(r.nudCapped[a.index]!.capBp), ...L.nudGuard(commitGuard(r.nudCappedGuard[a.index]!, t), false)];
      case 'prefix': if (t.first) throw new Error('prattShell: a prefix arm is decided by its key'); return [];
    }
  };
  const act = (c: CommitAct | null): string => {
    if (c === null) return L.commitFail;
    const a = r.nudOrder[c.arm]!, undo = !c.clean || c.nullable;
    switch (a.kind) {
      case 'tok': return L.commitLeaf(c.arm, tests(c));
      case 'bracket': return L.commitSeq(c.arm, tests(c), armCond(c.arm, r.nudBrackets[a.index]!.steps), r.nudBracketClosesTail[a.index]!, false, undo, c.nullable);
      case 'seq': return L.commitSeq(c.arm, tests(c), armCond(c.arm, guardedSteps(r.nudSeqGuard[a.index]!, r.nudSeqs[a.index]!)), r.nudSeqClosesTail[a.index]!, false, undo, c.nullable);
      case 'capped': return L.commitSeq(c.arm, tests(c), armCond(c.arm, guardedSteps(r.nudCappedGuard[a.index]!, r.nudCapped[a.index]!.steps)), false, true, undo, c.nullable);
      case 'prefix': return L.commitPrefix(c.arm, tests(c));
    }
  };
  const commit = r.nudCommit === undefined ? [] : [commitWalk(r.nudCommit, ids, act, tests, L.commitSw)];
  const frame = r.nudCommit !== undefined && dispatchArms(d).size === 0 ? [L.commitFail, L.nudEnd] : [L.nudOpen, dispatchWalk(d, ids, nudArm, L.dispatch, false), L.nudClose];
  const nud = [L.nudEnter, ...commit, ...frame].join('\n');
  return [L.entry, bp, nud].join('\n');
}

function formsOf(rules: RuleIR[], lookaheads: Alt[], nShared: number, entry: string): Forms {
  const byName = new Map(rules.map((r) => [r.name, r]));
  const build = new Set<string>(), recognize = new Set<string>();
  const buildShared = new Array<boolean>(nShared).fill(false), recognizeShared = new Array<boolean>(nShared).fill(false);
  const buildRule = (name: string): void => {
    if (build.has(name)) return;
    build.add(name);
    const r = byName.get(name);
    if (r === undefined) return;
    for (const body of ruleBodies(r)) for (const s of body) buildStep(s);
    for (const b of commitBodiesOf(r)) buildStep(b);
    if (r.kind === 'pratt') for (const h of [r.nudTplHole, r.postfixTplHole]) if (h !== undefined) buildRule(h);
  };
  const buildStep = (s: Step): void => {
    if ('share' in s && s.share !== undefined) { if (buildShared[s.share]) return; buildShared[s.share] = true; }
    if (s.t === 'rule' || s.t === 'ruleBp') buildRule(s.name);
    if (s.t === 'tok' && s.hole !== undefined) buildRule(s.hole);
    for (const k of stepKids(s)) buildStep(k);
  };
  const recognizeRule = (name: string): void => {
    const r = byName.get(name);
    if (r === undefined || recognize.has(name)) return;
    recognize.add(name);
    if (r.kind === 'pratt') buildRule(name);   // recognized by its building form
    else { for (const alt of r.alts) for (const s of alt) recognizeStep(s); for (const b of commitBodiesOf(r)) recognizeStep(b); }
  };
  const recognizeStep = (s: Step): void => {
    if ('share' in s && s.share !== undefined) { if (recognizeShared[s.share]) return; recognizeShared[s.share] = true; }
    if (s.t === 'rule') recognizeRule(s.name);
    if (s.t === 'ruleBp') buildRule(s.name);   // only a Pratt rule is called at a binding power
    if (s.t === 'tok' && s.hole !== undefined) buildRule(s.hole);   // a template is matched by its building form, its node dropped
    for (const k of stepKids(s)) recognizeStep(k);
  };
  buildRule(entry);
  for (const body of lookaheads) for (const s of body) recognizeStep(s);
  // Whether a recognize-form step runs a building form (a Pratt rule's), directly or through the
  // rd rules it recognizes (a fixed point over their recursion); a nested lookahead undoes its own.
  const rdBuilds = new Set<string>();
  const builds = (s: Step): boolean => s.t === 'ruleBp' || (s.t === 'tok' && s.hole !== undefined) || (s.t === 'rule' && (byName.get(s.name)?.kind === 'pratt' || rdBuilds.has(s.name))) || stepKids(s).some(builds);
  for (let changed = true; changed;) {
    changed = false;
    for (const name of recognize) {
      const r = byName.get(name)!;
      if (r.kind === 'rd' && !rdBuilds.has(name) && r.alts.some((alt) => alt.some(builds))) { rdBuilds.add(name); changed = true; }
    }
  }
  // Which recognizers read the cursor alone: none of what they run, directly or through the rules,
  // shared steps and lookaheads they call (nested lookaheads included, unlike `builds`), is a
  // building form. A fixed point over rd rules and lookaheads together, which call each other.
  const ruleCalls = new Set<string>(), lookCalls = new Array<boolean>(lookaheads.length).fill(false);
  const callsBuild = (s: Step): boolean => s.t === 'ruleBp' || (s.t === 'tok' && s.hole !== undefined)
    || (s.t === 'rule' && (byName.get(s.name)?.kind === 'pratt' || ruleCalls.has(s.name)))
    || (s.t === 'look' && lookCalls[s.id]!) || stepKids(s).some(callsBuild);
  for (let changed = true; changed;) {
    changed = false;
    for (const name of recognize) {
      const r = byName.get(name)!;
      if (!ruleCalls.has(name) && (r.kind === 'pratt' || r.alts.some((alt) => alt.some(callsBuild)))) { ruleCalls.add(name); changed = true; }
    }
    lookaheads.forEach((body, id) => { if (!lookCalls[id] && body.some(callsBuild)) { lookCalls[id] = true; changed = true; } });
  }
  const sharedCalls = new Array<boolean>(nShared).fill(false);
  const markShared = (s: Step): void => {
    if ('share' in s && s.share !== undefined && recognizeShared[s.share] && callsBuild(s)) sharedCalls[s.share] = true;
    stepKids(s).forEach(markShared);
  };
  for (const r of rules) { for (const body of ruleBodies(r)) body.forEach(markShared); commitBodiesOf(r).forEach(markShared); }
  lookaheads.forEach((body) => body.forEach(markShared));
  return {
    buildRules: rules.filter((r) => build.has(r.name)).map((r) => r.name),
    recognizeRules: rules.filter((r) => recognize.has(r.name)).map((r) => r.name),
    buildShared, recognizeShared,
    lookBuilds: lookaheads.map((body) => body.some(builds)),
    cursorOnly: {
      rules: rules.filter((r) => recognize.has(r.name) && !ruleCalls.has(r.name)).map((r) => r.name),
      shared: recognizeShared.map((rec, id) => rec && !sharedCalls[id]),
      looks: lookCalls.map((c) => !c),
    },
  };
}

// ── Shared steps: a repeated step sequence is one function ──
// A step is a computation over the parser's state alone: the position, the token stream and the
// lexer's state behind it, the suppress set and the [Await]/[Yield] context in force, the look
// extent, and the children list it appends to (TS: the `kids`/`spans` arrays in scope, passed as
// arguments; Go/Rust: the parser's scratch list and builder). It reads nothing of the site it
// stands at — not the enclosing rule's longest-match bookkeeping, not its node — and on a failure
// it leaves what it advanced and appended for the construct around it to undo, as every step does
// (a `suppress` or `ctx` step puts back the set or context it changed itself, on either outcome, so
// no failure leaves one changed). So two
// structurally identical steps are one computation wherever they stand, and a function that runs
// the step, called at each site, does exactly what the inlined copies did, failure included.
// Steps are shared, not arms: a rule alternative or Pratt arm builds its node and keeps its best
// candidate around its steps; only the steps inside it are candidates here.
// What is shared: every compound step (star / opt / sep / alt / seq / suppress / ctx) that the printed
// program would hold at two or more places. Places are counted as printed: a step inside a shared
// step is printed once, in that step's function, however many sites call it; inside an unshared
// step, once per place that step is printed. So a step that only ever stands inside one shared
// step is not a function of its own. A leaf step (a literal, a token, a rule call, a zero-width
// test) is already one helper call and is never shared. `Step.share` marks every occurrence with
// the id of its entry in ParserIR.shared; it says only how a target prints the step (a call to
// that function), so a reader that does not know the field still reads the step it marks.
function shareSteps(roots: Step[][]): Step[] {
  type Compound = Extract<Step, { share?: number }>;
  const isCompound = (s: Step): s is Compound => s.t === 'star' || s.t === 'opt' || s.t === 'sep' || s.t === 'alt' || s.t === 'seq' || s.t === 'suppress' || s.t === 'ctx';
  const kids = stepKids;
  // Each distinct compound step by its structure: its size (in steps, itself included), how often
  // each distinct compound child occurs in it, how often it stands directly in a root list, and
  // every occurrence.
  type Entry = { size: number; children: Map<string, number>; atRoot: number; occ: Compound[] };
  const entries = new Map<string, Entry>();
  const keyOf = new Map<Step, string>();
  const visit = (s: Step): number => {   // the step's size; records its entry when compound
    let size = 1;
    for (const c of kids(s)) size += visit(c);
    if (!isCompound(s)) return size;
    let key = keyOf.get(s);
    if (key === undefined) { key = stepKey(s); keyOf.set(s, key); }
    let e = entries.get(key);
    if (e === undefined) {
      e = { size, children: new Map(), atRoot: 0, occ: [] };
      for (const c of kids(s)) if (isCompound(c)) { const ck = keyOf.get(c)!; e.children.set(ck, (e.children.get(ck) ?? 0) + 1); }
      entries.set(key, e);
    }
    e.occ.push(s);
    return size;
  };
  for (const list of roots) for (const s of list) { visit(s); if (isCompound(s)) entries.get(keyOf.get(s)!)!.atRoot++; }
  // Places each step is printed at, from the biggest down (a parent is bigger than its children).
  const printed = new Map<string, number>();
  for (const [k, e] of entries) printed.set(k, e.atRoot);
  const shared: Step[] = [];
  const idOf = new Map<string, number>();
  for (const [k, e] of [...entries].sort((x, y) => y[1].size - x[1].size)) {
    const n = printed.get(k)!;
    const share = n >= 2;
    if (share) idOf.set(k, -1);
    for (const [ck, m] of e.children) printed.set(ck, printed.get(ck)! + m * (share ? 1 : n));
  }
  // Ids in the order the steps are first met (an inner step before the step around it).
  for (const [k, e] of entries) if (idOf.has(k)) { idOf.set(k, shared.length); shared.push(e.occ[0]!); }
  for (const [k, e] of entries) { const id = idOf.get(k); if (id !== undefined) for (const s of e.occ) s.share = id; }
  return shared;
}

// Classify a token: a fast-path shape (run/string/line/block) when the pattern IS that shape,
// otherwise the general `pattern` matcher. A fast path scans its shape's language, so it is
// taken only for a pattern of exactly that language; a pattern that merely begins and ends like
// a string or a comment is scanned by its own matcher. The fast paths keep the common simple
// tokens (and the calc/minijs grammars) on tight, readable scan code in every target.
function lexTok(t: TokenDecl): LexTok {
  const skip = t.flags.includes('skip');
  const delim = stringShape(t.pattern);
  if (delim !== null) return { kind: 'string', name: t.name, delim, skip };
  const bd = blockShape(t.pattern);
  if (bd) return { kind: 'block', name: t.name, ...bd, skip };
  const loop = tokenPatternCharLoop(t);
  // Plain `run` only when NOTHING needs the general matcher: no cont-stop bails AND no
  // complex head alternative (`run` has no fallback path — a headBail entry char would
  // otherwise be unlexable in the portable targets, diverging from the interpreter).
  if (loop && loop.bail.length === 0 && !loop.bailNonAscii && loop.headBail.length === 0 && !loop.headBailNonAscii) {
    return { kind: 'run', name: t.name, first: codesToRanges(loop.first), cont: codesToRanges(loop.cont), skip };
  }
  if (loop) {
    return {
      kind: 'runBail', name: t.name,
      first: codesToRanges(loop.first), cont: codesToRanges(loop.cont),
      bail: loop.bail, bailNonAscii: loop.bailNonAscii,
      headBail: loop.headBail, headBailNonAscii: loop.headBailNonAscii,
      pattern: t.pattern, skip,
    };
  }
  const line = lineCommentShape(t.pattern);
  if (line) return { kind: 'line', name: t.name, ...line, skip };
  return { kind: 'pattern', name: t.name, pattern: t.pattern, skip };
}

const isLit = (p: TokenPattern | undefined): p is string => typeof p === 'string' && p.length > 0;
const isAny = (p: TokenPattern): boolean => typeof p !== 'string' && p.type === 'anyChar';
const notAhead = (p: TokenPattern, lit: string): boolean => typeof p !== 'string' && p.type === 'lookahead' && p.negate && p.body === lit;

// `d ([^d\\] | \\ anyChar)* d`, the alternatives in either order: the delimiter, then a run in
// which a backslash takes the next character, then the delimiter. The string scanner compares
// one unit with the delimiter, so the delimiter is one unit in every target's units.
function stringShape(p: TokenPattern): string | null {
  if (typeof p === 'string' || p.type !== 'seq' || p.items.length !== 3) return null;
  const [open, body, close] = p.items;
  if (!isLit(open) || !oneUnit(open) || close !== open) return null;
  if (typeof body === 'string' || body.type !== 'repeat' || body.min !== 0 || body.max !== undefined || !body.greedy) return null;
  const alt = body.body;
  if (typeof alt === 'string' || alt.type !== 'alt' || alt.items.length !== 2) return null;
  const plain = (q: TokenPattern): boolean => {
    if (typeof q === 'string' || q.type !== 'charClass' || !q.negate || q.items.length !== 2) return false;
    const cs = q.items.map((it) => (it.type === 'char' ? it.value : null));
    return cs.includes(open) && cs.includes('\\');
  };
  const escaped = (q: TokenPattern): boolean => typeof q !== 'string' && q.type === 'seq' && q.items.length === 2 && q.items[0] === '\\' && isAny(q.items[1]);
  const [a, b] = alt.items;
  return (plain(a) && escaped(b)) || (escaped(a) && plain(b)) ? open : null;
}

// `open guard* body close` where the body runs to the first close: a lazy `anyChar*`, or a repeat
// of `(?!close) anyChar` (which stops at the first close, greedy or not). The guards are
// zero-width tests right after the opener.
function blockShape(p: TokenPattern): { open: string; close: string; guard: TokenPattern | null } | null {
  if (typeof p === 'string' || p.type !== 'seq' || p.items.length < 3) return null;
  const items = p.items;
  const open = items[0], close = items[items.length - 1], body = items[items.length - 2];
  const guards = items.slice(1, -2);
  if (!isLit(open) || !isLit(close)) return null;
  if (!guards.every((g) => typeof g !== 'string' && g.type === 'lookahead')) return null;
  if (typeof body === 'string' || body.type !== 'repeat' || body.min !== 0 || body.max !== undefined) return null;
  const step = body.body;
  const toClose = (isAny(step) && !body.greedy)
    || (typeof step !== 'string' && step.type === 'seq' && step.items.length === 2 && notAhead(step.items[0], close) && isAny(step.items[1]));
  if (!toClose) return null;
  return { open, close, guard: guards.length === 0 ? null : guards.length === 1 ? guards[0] : { type: 'seq', items: guards } };
}

// `<literal> [^stops]*`: a literal, then a greedy run of every character but a set of stops, each
// one character of the Basic Multilingual Plane (not a surrogate), so a target finds it by its
// UTF-16 unit or its UTF-8 bytes. The shape is the pattern exactly: the scanner runs to the first
// stop, so the stops are all the class's characters. A class with a range is no line shape.
function lineCommentShape(p: TokenPattern): { prefix: string; stops: number[] } | null {
  if (typeof p === 'string' || p.type !== 'seq' || p.items.length !== 2) return null;
  const [head, tail] = p.items;
  if (!isLit(head)) return null;
  if (typeof tail === 'string' || tail.type !== 'repeat' || tail.min !== 0 || tail.max !== undefined || !tail.greedy) return null;
  const body = tail.body;
  if (typeof body === 'string' || body.type !== 'charClass' || !body.negate || body.items.length === 0) return null;
  const stops: number[] = [];
  for (const it of body.items) {
    if (it.type !== 'char' || it.value.length !== 1) return null;
    const c = it.value.charCodeAt(0);
    if (c >= 0xd800 && c <= 0xdfff) return null;
    stops.push(c);
  }
  return { prefix: head, stops: [...new Set(stops)].sort((a, b) => a - b) };
}

function codesToRanges(codes: number[]): CharRange[] {
  const s = [...new Set(codes)].sort((x, y) => x - y);
  const out: CharRange[] = [];
  for (const c of s) {
    const last = out[out.length - 1];
    if (last && c === last[1] + 1) last[1] = c;
    else out.push([c, c]);
  }
  return out;
}

// A Pratt rule's alternatives → NUD atoms/brackets/prefix + binary + mixfix LEDs.
// Binding powers come from the analysis (opTable/prefixOps), single-sourced with the interpreter.
function buildPratt(
  name: string, body: RuleExpr, a: ReturnType<typeof analyzeGrammar>, names: RuleNames,
  stepOf: (e: RuleExpr) => Step, named: (e: RuleExpr, s: Step) => Step, notOf: (steps: Step[]) => Step, reservableOf: (steps: Step[]) => Step,
  suppressOf: (connectors: string[], steps: Step[]) => Step, ctxOf: (mode: 'await' | 'yield' | 'asyncgen' | 'reset', steps: Step[]) => Step,
  litTtype: (v: string) => '$keyword' | '$punct',
  altGuard: (e: RuleExpr, earlier: readonly RuleExpr[]) => Guard, templateTokens: ReadonlySet<string>,
): PrattRule {
  const alts = body.type === 'alt' ? body.items : [body];
  const nudToks: string[] = [];
  const nudBrackets: Bracket[] = [];
  const nudSeqs: Step[][] = [];
  const nudCapped: Array<{ steps: Step[]; capBp: number }> = [];
  const nudSeqGuard: Guard[] = [];
  const nudCappedGuard: Guard[] = [];
  const nudOrder: NudRef[] = [];
  const nudNames: string[] = [], ledNames: string[] = [], ledLeftNames: string[] = [], postfixTokNames: string[] = [];
  const armName = (alt: RuleExpr): string => names.armOf.get(alt)!.name;
  // The NUD alternatives so far that are candidates at every binding power (a token, a bracket
  // or a sequence: a capped one is not, and the prefix arm is no written sequence) — what a later
  // sequence may only repeat (altGuard).
  const nudWritten: RuleExpr[] = [];
  let sawPrefix = false, sawBinary = false, sawPostfix = false, postfixSameLine = false;
  const leds: Bracket[] = [];
  const ledAccessTail: boolean[] = [];
  const ledLbp: Array<number | null> = [];
  const ledSameLine: boolean[] = [];
  const ledNotLeftLeaf: Array<string[] | null> = [];
  const postfixToks: string[] = [];
  // The hole rule of the template reference in NUD / postfix position. One Pratt rule matches
  // the template token there through ONE arm, so two references naming different hole rules
  // cannot both be honoured: refuse the grammar instead of picking one.
  let nudTplHole: string | undefined, postfixTplHole: string | undefined;
  const oneHole = (where: string, prev: string | undefined, hole: string): string => {
    if (prev !== undefined && prev !== hole) throw new Error(`portable: rule ${name} references its template token in ${where} position with two hole rules (${prev}, ${hole})`);
    return hole;
  };
  for (const alt of alts) {
    let items = alt.type === 'seq' ? alt.items : [alt];
    // A left-recursive continuation may carry a leading `notLeftLeaf(words)` head-leaf guard
    // before the self `$` — strip it and attach the word set to the led it produces.
    let nllWords: string[] | null = null;
    if (items[0].type === 'notLeftLeaf' && items[1]?.type === 'ref' && items[1].name === name) {
      nllWords = items[0].words; items = items.slice(1);
    }
    const startsSelf = items[0].type === 'ref' && items[0].name === name;
    if (!startsSelf) {
      // NUD
      if (items.length === 1 && items[0].type === 'ref' && a.tokenNames.has(items[0].name)) {
        nudOrder.push({ kind: 'tok', index: nudToks.length }); nudNames.push(armName(alt));
        nudToks.push(items[0].name);
        nudWritten.push(alt);
        if (items[0].hole !== undefined) nudTplHole = oneHole('NUD', nudTplHole, items[0].hole);
        continue;
      }
      if (items[0].type === 'prefix') { if (!sawPrefix) { nudOrder.push({ kind: 'prefix' }); nudNames.push(names.ops!.prefix); } sawPrefix = true; continue; }
      // A capExpr (arrow function): an assignment-level group{capBelow}.
      if (items.length === 1 && items[0].type === 'group' && items[0].capBelow !== undefined) {
        const capBp = a.nudCapOf(items[0]);
        if (capBp === null) throw new Error(`portable: capBelow connector '${items[0].capBelow}' has no binding power (rule ${name})`);
        const b = items[0].body;
        nudOrder.push({ kind: 'capped', index: nudCapped.length }); nudNames.push(armName(alt));
        nudCappedGuard.push(altGuard(alt, []));
        nudCapped.push({ steps: (b.type === 'seq' ? b.items : [b]).map((it) => stepOfPratt(it)), capBp });
        continue;
      }
      if (items[0].type === 'literal') { nudOrder.push({ kind: 'bracket', index: nudBrackets.length }); nudNames.push(armName(alt)); nudBrackets.push({ first: items[0].value, steps: items.map((it) => stepOfPratt(it)) }); nudWritten.push(alt); continue; }
      // A single transparent group (no suppress, no context) unwraps to its body (an explicit grouping).
      let nudItems = items;
      if (items.length === 1 && items[0].type === 'group' && !items[0].suppress && !items[0].ctxMode) {
        nudItems = items[0].body.type === 'seq' ? items[0].body.items : [items[0].body];
      }
      nudOrder.push({ kind: 'seq', index: nudSeqs.length }); nudNames.push(armName(alt));
      nudSeqGuard.push(altGuard(alt, nudWritten));
      nudWritten.push(alt);
      nudSeqs.push(nudItems.map((it) => stepOfPratt(it)));   // general NUD sequence (guarded ident, class expr)
      continue;
    }
    // LED (starts with self): `$ op $` (binary, op slot + trailing self) or `$ <lit> …` (mixfix)
    const restAll = items.slice(1);
    const hasSameLine = restAll[0]?.type === 'sameLine';   // a TS type tail: `$ sameLine '<' …`
    const rest = hasSameLine ? restAll.slice(1) : restAll;
    if (!hasSameLine && rest[0].type === 'op') { sawBinary = true; continue; }
    if (rest[0].type === 'postfix') { sawPostfix = true; postfixSameLine = hasSameLine; continue; }   // postfix operator (`x++`), restricted when `$ sameLine ++`
    if (rest[0].type === 'literal') {
      const conn = rest[0].value;
      const prec = a.ledPrecByConnector.get(conn);   // { lbp, rhsBp } for ternary/in/instanceof
      const steps = rest.map((it) => stepOfPratt(it));
      const last = steps[steps.length - 1];
      const lastIsOperand = last !== undefined && last.t === 'rule' && last.name === name;   // open binary/ternary operand
      // chain-rhs (`in`/`instanceof`): the trailing self-operand parses at the level's bp (left-chain).
      if (prec && prec.rhsBp !== null && lastIsOperand) steps[steps.length - 1] = { t: 'ruleBp', name, bp: prec.rhsBp };
      const wordConnector = /^[A-Za-z]/.test(conn);                                           // `in`/`instanceof`/`as` — not a tail
      leds.push({ first: conn, steps });
      ledNames.push(armName(alt)); ledLeftNames.push(names.childOf.get(items[0])!.name);
      ledAccessTail.push(!lastIsOperand && !wordConnector);
      ledLbp.push(prec ? prec.lbp : null);
      ledSameLine.push(hasSameLine);
      ledNotLeftLeaf.push(nllWords);
      continue;
    }
    if (rest.length === 1 && rest[0].type === 'ref' && a.tokenNames.has(rest[0].name)) {   // postfix token (tagged template)
      postfixToks.push(rest[0].name); postfixTokNames.push(armName(alt));
      if (rest[0].hole !== undefined) postfixTplHole = oneHole('postfix', postfixTplHole, rest[0].hole);
      continue;
    }
    throw new Error(`portable: Pratt LED shape not in scope (rule ${name})`);
  }
  // a self-ref inside a NUD/LED sub-sequence is a fresh parse of this rule
  function stepOfPratt(e: RuleExpr): Step { return named(e, prattNode(e)); }
  function prattNode(e: RuleExpr): Step {
    if (e.type === 'ref' && e.name === name) return { t: 'rule', name };
    if (e.type === 'seq') return { t: 'seq', steps: e.items.map(stepOfPratt) };
    if (e.type === 'sameLine') return { t: 'sameLine' };
    if (e.type === 'not') return (e.reservable ? reservableOf : notOf)((e.body.type === 'seq' ? e.body.items : [e.body]).map(stepOfPratt));
    if (e.type === 'group' && e.ctxMode && !e.capBelow) return ctxOf(e.ctxMode, (e.body.type === 'seq' ? e.body.items : [e.body]).map(stepOfPratt));
    if (e.type === 'group' && e.suppress && e.suppress.length) return suppressOf(e.suppress, (e.body.type === 'seq' ? e.body.items : [e.body]).map(stepOfPratt));
    if (e.type === 'group' && !e.capBelow) {
      return e.body.type === 'seq' ? { t: 'seq', steps: e.body.items.map(stepOfPratt) } : stepOfPratt(e.body);
    }
    if (e.type === 'sep') return { t: 'sep', elem: stepOfPratt(e.element), delim: e.delimiter };
    if (e.type === 'quantifier' && e.kind === '?') return { t: 'opt', steps: (e.body.type === 'seq' ? e.body.items : [e.body]).map(stepOfPratt) };
    if (e.type === 'quantifier' && e.kind === '*') return { t: 'star', step: stepOfPratt(e.body) };
    if (e.type === 'quantifier' && e.kind === '+') return { t: 'seq', steps: [stepOfPratt(e.body), { t: 'star', step: stepOfPratt(e.body) }] };
    if (e.type === 'literal') return { t: 'lit', value: e.value, ttype: litTtype(e.value) };
    return stepOf(e);   // names its step itself (`named` again finds the same names)
  }
  const prefix = sawPrefix
    ? [...a.prefixOps.entries()].map(([op, info]) => ({ op, rbp: info.rbp, requireTarget: !!info.requireTarget, form: (a.postfixOpValues.has(op) ? FORM_NOT_TARGET : FORM_UNARY) as AssignForm }))
    : [];
  const binary = sawBinary
    ? [...a.opTable.entries()].filter(([, info]) => info.position === 'infix').map(([op, info]) => ({ op, lbp: info.lbp, rbp: info.rbp, requireTarget: !!info.requireTarget, noUnaryLhs: a.noUnaryLhsOps.has(op) }))
    : [];
  const postfix = sawPostfix
    ? [...a.opTable.entries()].filter(([, info]) => info.position === 'postfix').map(([op, info]) => ({ op, lbp: info.lbp, requireTarget: !!info.requireTarget }))
    : [];
  const ledForm = leds.map((l): AssignForm => a.binaryConnectors.has(l.first) ? FORM_NOT_TARGET : FORM_TARGET);
  const endsInOperand = (steps: Step[]): boolean => { const l = steps[steps.length - 1]; return l !== undefined && l.t === 'rule' && l.name === name; };
  const nudBracketClosesTail = nudBrackets.map((b) => endsInOperand(b.steps));
  const nudSeqClosesTail = nudSeqs.map(endsInOperand);
  const ledClosesTail = leds.map((l, i) => { const last = l.steps[l.steps.length - 1]?.t; return !ledAccessTail[i] || last === 'look' || last === 'ahead' || last === 'aheadCtx'; });
  // A template token arm also matches an interpolated template (its head token), so it is in `rest`.
  const nudDispatch = dispatchOf(nudOrder.map((a): TokenSet | null => {
    switch (a.kind) {
      case 'tok': return nudTplHole !== undefined && templateTokens.has(nudToks[a.index]!) ? null : { lits: [], toks: [nudToks[a.index]!] };
      case 'bracket': return { lits: [nudBrackets[a.index]!.first], toks: [] };
      case 'seq': return nudSeqGuard[a.index]?.first ?? null;
      case 'capped': return nudCappedGuard[a.index]?.first ?? null;
      case 'prefix': return null;
    }
  }));
  return { kind: 'pratt', name, nudToks, nudBrackets, nudSeqs, nudSeqGuard, nudSeqPredictive: false, nudBracketClosesTail, nudSeqClosesTail, nudCapped, nudCappedGuard, nudOrder, nudNames, nudDispatch, prefix, binary, leds, ledNames, ledLeftNames, ledAccessTail, ledLbp, ledSameLine, ledNotLeftLeaf, ledSuppressedIn: [], ledForm, ledClosesTail, postfixToks, postfixTokNames, postfix, postfixSameLine, opNames: names.ops ?? null, ...(nudTplHole !== undefined ? { nudTplHole } : {}), ...(postfixTplHole !== undefined ? { postfixTplHole } : {}) };
}

// ── Lex integer ids (kid = kind index, lid = text/literal index) ──
//
// Parser matching hot paths compare u16/uint16/number instead of strings. kid indexes
// `kids` (token kind names); lid indexes `lids` (literal texts). lid is a pure function of
// text and is independent of kind — matching the existing `match_lit` (text-only) contract.

export type LexIdPlan = {
  kids: string[];   // kids[0]='' reserved for punct (kind=""); then tokens in decl order + engine-emitted (NEWLINE, $template*)
  lids: string[];   // lids[0]='' = "not any literal"; then puncts (longest-first), then the other non-word texts, then the words (each lexicographically)
  gtComps: string[];   // ir.gtComps: lids composed from single-character tokens, never lexed
  /** The first word lid: a literal matched in the tree is a `$keyword` leaf exactly when its text
   *  is a word (isKeywordLiteral; `$punct`, never a leaf, otherwise), and the words are the lids
   *  from here on, so a target tells the two apart by its lid and no site passes the type. */
  kwLid: number;
};

/**
 * The token kinds that can carry a literal text, by the lexer's plan: `''` (punctuation) for a
 * punctuation literal the lexer scans, each scanned kind whose shape admits the text
 * (tokenLiterals: the literals a kind's token is looked up among), and the template pieces whose
 * delimiters admit it (templateLiterals). A superset, as those are: a kind not listed never
 * carries the literal, so a token with the literal's id has one of these kinds.
 */
export function literalKinds(ir: Pick<ParserIR, 'tokens' | 'tpl' | 'identToken' | 'identLike' | 'puncts'>): (text: string) => ReadonlySet<string> {
  const memo = new Map<string, Set<string>>();
  return (text) => {
    let ks = memo.get(text);
    if (ks === undefined) {
      ks = new Set<string>();
      if (ir.puncts.includes(text)) ks.add('');
      for (const t of scannedTokens(ir)) if (tokenLiterals(ir, t, [text]).length) ks.add(t.name);
      const tl = templateLiterals(ir, [text]);
      if (ir.tpl && tl.whole.length) ks.add(ir.tpl.token);
      if (tl.head.length) ks.add('$templateHead');
      if (tl.middle.length) ks.add('$templateMiddle');
      if (tl.tail.length) ks.add('$templateTail');
      memo.set(text, ks);
    }
    return ks;
  };
}

/** Collect every literal text that appears in the Step IR (match_lit / altlit / sep / suppress / FIRST / Pratt). */
function collectStepLitTexts(steps: Step[], out: Set<string>): void {
  for (const s of steps) {
    switch (s.t) {
      case 'lit': out.add(s.value); break;
      case 'altlit': for (const o of s.opts) out.add(o.value); break;
      case 'sep': out.add(s.delim); collectStepLitTexts([s.elem], out); break;
      case 'suppress': case 'ctx': collectStepLitTexts(s.steps, out); break;
      case 'star': collectStepLitTexts([s.step], out); break;
      case 'opt': case 'seq': collectStepLitTexts(s.steps, out); break;
      case 'alt': for (const b of s.branches) collectStepLitTexts(b, out); break;
      default: break;
    }
  }
}

/**
 * Build stable kid/lid tables for a ParserIR. Semantics:
 * - kid(kind) = kids.indexOf(kind); punct kind "" → 0.
 * - lid(text) = lids.indexOf(text), or 0 if absent. Independent of kind.
 */
export function buildLexIdPlan(ir: ParserIR): LexIdPlan {
  // kids: '' + lexer token names (declaration order) + engine-emitted kinds not already present
  const kids: string[] = [''];
  const seenKid = new Set<string>(['']);
  const addKid = (k: string) => { if (!seenKid.has(k)) { seenKid.add(k); kids.push(k); } };
  for (const t of ir.tokens) addKid(t.name);
  if (ir.newlineCfg) addKid(ir.newlineCfg.token);
  if (ir.tpl) {
    addKid('$templateHead');
    addKid('$templateMiddle');
    addKid('$templateTail');
  }

  // lids universe: puncts + keyword/other lit texts from IR + regexCtx text sets + tpl delimiters
  const litTexts = new Set<string>();
  for (const p of ir.puncts) litTexts.add(p);
  for (const r of ir.rules) {
    if (r.kind === 'rd') {
      for (const alt of r.alts) collectStepLitTexts(alt, litTexts);
    } else {
      for (const b of r.nudBrackets) { litTexts.add(b.first); collectStepLitTexts(b.steps, litTexts); }
      for (const seq of r.nudSeqs) collectStepLitTexts(seq, litTexts);
      for (const c of r.nudCapped) collectStepLitTexts(c.steps, litTexts);
      for (const p of r.prefix) litTexts.add(p.op);
      for (const b of r.binary) litTexts.add(b.op);
      for (const b of r.leds) { litTexts.add(b.first); collectStepLitTexts(b.steps, litTexts); }
      for (const p of r.postfix) litTexts.add(p.op);
      for (const nll of r.ledNotLeftLeaf) if (nll) for (const x of nll) litTexts.add(x);
    }
  }
  for (const body of ir.lookaheads) collectStepLitTexts(body, litTexts);
  for (const s of ir.tokenSets) for (const x of s.lits) litTexts.add(x);
  for (const x of ir.ctxWords) litTexts.add(x);
  for (const s of ir.suppressSets) for (const x of s) litTexts.add(x);
  if (ir.regexCtx) {
    for (const x of ir.regexCtx.divisionTexts) litTexts.add(x);
    for (const x of ir.regexCtx.regexTexts) litTexts.add(x);
    for (const x of ir.regexCtx.parenHeadKw) litTexts.add(x);
    for (const x of ir.regexCtx.memberAccess) litTexts.add(x);
    for (const x of ir.regexCtx.postfixAfterValue) litTexts.add(x);
  }
  if (ir.tpl) {
    litTexts.add(ir.tpl.open);
    litTexts.add(ir.tpl.interpOpen);
    litTexts.add(ir.tpl.interpClose);
    litTexts.add(ir.tpl.braceOpen);
  }
  if (ir.newlineCfg) {
    for (const x of ir.newlineCfg.flowOpen) litTexts.add(x);
    for (const x of ir.newlineCfg.flowClose) litTexts.add(x);
  }

  // Stable order: puncts longest-first (ir.puncts, never words), then the remaining non-word texts,
  // then the words, each lexicographically: the words are one range from kwLid on.
  const punctSet = new Set(ir.puncts);
  const rest = [...litTexts].filter((t) => !punctSet.has(t)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lids: string[] = ['', ...ir.puncts, ...rest.filter((t) => !isKeywordLiteral(t)), ...rest.filter((t) => isKeywordLiteral(t))];
  const kwLid = lids.findIndex((t, i) => i > 0 && isKeywordLiteral(t));
  if (lids.some((t, i) => i > 0 && isKeywordLiteral(t) !== (kwLid >= 0 && i >= kwLid))) throw new Error('buildLexIdPlan: a punctuation literal is a word');
  return { kids, lids, gtComps: ir.gtComps, kwLid: kwLid < 0 ? lids.length : kwLid };
}

/**
 * ParserIR.tokenSets as bit rows, the one table every target prints for its `ahead` test. There is
 * one row per token key: row `lid` for each lid, then row `kidBase + kid` for each kid; bit k of a
 * row says whether that key is a member of set k. A token t is in set k iff bit k of row `t.lid` or
 * of row `kidBase + t.kid` is set (lid 0, "no literal", and kid 0 are never members). Row r is
 * `words[r * width .. (r + 1) * width)`, 32 bits per word, low bit first, so a test reads word
 * `k >> 5` of the token's two rows: at a call site k is a constant, so that word's offset and the
 * mask `1 << (k & 31)` are constants and the test is two loads keyed by the token's own ids.
 */
export type TokenSetBits = { width: number; kidBase: number; words: number[] };
export function tokenSetBits(plan: LexIdPlan, sets: readonly TokenSet[]): TokenSetBits {
  const kidBase = plan.lids.length;
  const width = Math.max(1, Math.ceil(sets.length / 32));
  const words = new Array<number>((kidBase + plan.kids.length) * width).fill(0);
  const put = (row: number, k: number) => { words[row * width + (k >>> 5)] = (words[row * width + (k >>> 5)] | (1 << (k & 31))) >>> 0; };
  sets.forEach((s, k) => {
    for (const l of s.lits) {
      const lid = plan.lids.indexOf(l);
      if (lid <= 0) throw new Error(`tokenSetBits: literal ${JSON.stringify(l)} has no lid`);
      put(lid, k);
    }
    for (const t of s.toks) {
      const kid = plan.kids.indexOf(t);
      if (kid <= 0) throw new Error(`tokenSetBits: token kind ${JSON.stringify(t)} has no kid`);
      put(kidBase + kid, k);
    }
  });
  return { width, kidBase, words };
}

/** Resolve lid for a known text; 0 if not in the plan (matches runtime lid_of). */
/** The context bit and the literal id of each word of ParserIR.ctxWords (an `aheadCtx` test
 *  refuses the token when the context has the bit and the token's lid is the word's). */
export function ctxWordLids(ir: ParserIR, plan: LexIdPlan): Array<{ bit: number; lid: number }> {
  return ir.ctxWords.map((w, i) => {
    const lid = plan.lids.indexOf(w);
    if (lid <= 0) throw new Error(`portable: context word ${JSON.stringify(w)} has no literal id`);
    return { bit: 1 << i, lid };
  });
}
export function lidOf(plan: LexIdPlan, text: string): number {
  const i = plan.lids.indexOf(text);
  return i >= 0 ? i : 0;
}

/** A Pratt rule's operator tables keyed by literal id: the one description of the binding-power
 *  lookups (binary LED, prefix NUD, postfix LED) that every printer renders as its lookup (a
 *  `match`, a lid-indexed array, a record). Entries in the rule's declaration order, at most one
 *  per lid in each table; `size` = the number of literal ids, so a table of that length takes any
 *  token's lid as its index. */
export type PrattOpTables = {
  size: number;
  bin: Array<{ lid: number; lbp: number; rbp: number; tgt: boolean; noUnary: boolean }>;
  pre: Array<{ lid: number; rbp: number; tgt: boolean; form: AssignForm }>;
  post: Array<{ lid: number; lbp: number; tgt: boolean }>;
};
export function prattOpTables(r: PrattRule, plan: LexIdPlan): PrattOpTables {
  const keyed = <T extends { op: string }, U>(table: string, xs: T[], f: (x: T, lid: number) => U): U[] => {
    const seen = new Set<number>();
    return xs.map((x) => {
      const lid = plan.lids.indexOf(x.op);
      if (lid <= 0) throw new Error(`portable: ${r.name}: ${table} operator ${JSON.stringify(x.op)} has no literal id`);
      if (seen.has(lid)) throw new Error(`portable: ${r.name}: ${table} operator ${JSON.stringify(x.op)} is declared twice`);
      seen.add(lid);
      return f(x, lid);
    });
  };
  return {
    size: plan.lids.length,
    bin: keyed('binary', r.binary, (b, lid) => ({ lid, lbp: b.lbp, rbp: b.rbp, tgt: b.requireTarget, noUnary: b.noUnaryLhs })),
    pre: keyed('prefix', r.prefix, (p, lid) => ({ lid, rbp: p.rbp, tgt: p.requireTarget, form: p.form })),
    post: keyed('postfix', r.postfix, (p, lid) => ({ lid, lbp: p.lbp, tgt: p.requireTarget })),
  };
}

/** The LED loop's exits: the literal ids of a Pratt rule's led groups (its leds by first literal)
 *  after which the loop ENDS when every arm of the group was tried and failed. The reference
 *  (gen-parser.ts parsePratt) goes on to the operator table when no led matched; it can match only
 *  a token that a later check of the loop takes: a postfix token (by the kinds the lexer gives the
 *  literal, or the head of an interpolated template), a postfix or binary operator by its own lid, or a `>` that composes with the tokens
 *  after it (`>>`, `>=`, ...: ParserIR.gtComps). A group whose lid none of them takes ends the
 *  loop at once, as those checks would have; any other falls through to them. */
export function prattLedExits(r: PrattRule, ir: Pick<ParserIR, 'tokens' | 'tpl' | 'identToken' | 'identLike' | 'puncts' | 'gtComps'>, plan: LexIdPlan): Set<number> {
  const kinds = literalKinds(ir);
  const ops = new Set([...r.binary.map((b) => b.op), ...r.postfix.map((p) => p.op)]);
  const exits = new Set<number>();
  for (const b of r.leds) {
    const ks = kinds(b.first);
    const later = ops.has(b.first) || (b.first === '>' && ir.gtComps.length > 0)
      || [...ks].some((k) => r.postfixToks.includes(k)) || (r.postfixTplHole !== undefined && ks.has('$templateHead'));
    if (!later) exits.add(lidOf(plan, b.first));
  }
  return exits;
}

/**
 * O(1) early exit for runtime `lid_of`: a text whose key (length, first unit) no literal has is
 * no literal (lid 0), found without the table lookup.
 *
 * Sound by construction: the bits are set from EVERY literal of the table, under the key
 * (`lidKey`) the emitted `lid_of` computes for any text it is given, and `lid_of` probes them for
 * every text. No literal can be filtered out, whatever its shape.
 *
 * Layout: `(maxLen + 1)` rows × 32 bytes (256 bits), row = key length, bit = key first unit.
 */
export type LidPrefilterPlan = {
  /** The longest literal in the target's string units; a longer text is no literal. */
  maxLen: number;
  /** Flat bit table, length `(maxLen + 1) * 32`: bit `first` of row `len` is set iff a literal has that key. */
  firstByLenBits: Uint8Array;
};

/**
 * `lid_of` keys a text by its length in the target's units (text-units.ts) and the low byte of its
 * first unit — the one definition the emitted `lid_of` of each target computes.
 */
export function lidKey(text: string, units: TextUnits): { len: number; first: number } {
  return { len: unitLen(text, units), first: firstUnit(text, units) & 255 };
}

/** The length × first-unit prefilter over every literal of the table. */
export function buildLidPrefilter(plan: LexIdPlan, units: TextUnits): LidPrefilterPlan {
  const keys = plan.lids.slice(1).map((t) => lidKey(t, units));
  const maxLen = Math.max(0, ...keys.map((k) => k.len));
  const firstByLenBits = new Uint8Array((maxLen + 1) * 32);
  for (const { len, first } of keys) firstByLenBits[len * 32 + (first >> 3)] |= 1 << (first & 7);
  return { maxLen, firstByLenBits };
}

/**
 * The literal table split by the first-byte class `lid_of` routes a text by (lidWordByte): words
 * and the rest, each grouped by the literal's length in `units` (ascending). A target prints a
 * match per half, so an identifier is compared with word literals only.
 */
export function buildLidTables(plan: LexIdPlan, units: TextUnits): { word: [number, { text: string; id: number }[]][]; rest: [number, { text: string; id: number }[]][] } {
  const word = new Map<number, { text: string; id: number }[]>(), rest = new Map<number, { text: string; id: number }[]>();
  for (let i = 1; i < plan.lids.length; i++) {
    const text = plan.lids[i]!;
    const len = unitLen(text, units);
    const m = lidWordByte(firstUnit(text, units)) ? word : rest;
    m.set(len, [...(m.get(len) ?? []), { text, id: i }]);
  }
  const sorted = (m: Map<number, { text: string; id: number }[]>) => [...m.entries()].sort((a, b) => a[0] - b[0]);
  return { word: sorted(word), rest: sorted(rest) };
}

/**
 * The first-byte class by which a target that splits its literal table in two (Rust: words and
 * the rest, so an identifier is compared with words only) splits it, and by which its `lid_of`
 * routes a text: the table half a literal is in is the half `lid_of` looks in for that text.
 */
export function lidWordByte(b: number): boolean {
  return (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95 || b === 36 || b === 64;
}

/** Resolve kid for a known kind; 0 if not in the plan. */
/** The lid of a `sep` step's delimiter. A target matches it as a literal like any other, so it
 *  is a `$punct` (never a leaf) because it is not a word; a word delimiter is refused here rather
 *  than given a type of its own. */
export function sepDelimLid(plan: LexIdPlan, delim: string): number {
  const lid = lidOf(plan, delim);
  if (lid >= plan.kwLid) throw new Error(`sep delimiter ${JSON.stringify(delim)} is a word: the portable targets match a delimiter as punctuation`);
  if (plan.gtComps.includes(delim)) throw new Error(`sep delimiter ${JSON.stringify(delim)} is a composed '>' literal: the portable targets match a delimiter as one token`);
  return lid;
}
/** Whether a literal step is a composed '>'-led literal (LexIdPlan.gtComps), decided at generation
 *  time: it spans several tokens and is only a lookahead operand, so it is matched by the target's
 *  composite reader and never becomes a tree leaf. */
export function gtCompLit(plan: LexIdPlan, s: { value: string; ttype: string }): boolean {
  if (!plan.gtComps.includes(s.value)) return false;
  if (s.ttype !== '$punct') throw new Error(`composed literal ${JSON.stringify(s.value)} must be punctuation`);
  return true;
}
export function kidOf(plan: LexIdPlan, kind: string): number {
  const i = plan.kids.indexOf(kind);
  return i >= 0 ? i : 0;
}

/**
 * Bool table indexed by lid for O(1) set membership in emitted lexers.
 * Slot 0 stays false: lids[0]='' means "not any literal" (Ident/Number text → lid 0).
 */
/** Per lid: +1 for a text of `open`, -1 for one of `close`, else 0. Newline mode's flow depth
 *  moves by it at each literal token, a table lookup instead of a set of strings. */
export function lidDeltaTable(plan: LexIdPlan, open: readonly string[], close: readonly string[]): number[] {
  const o = lidFlagTable(plan, open), c = lidFlagTable(plan, close);
  return o.map((x, i) => (x ? 1 : 0) - (c[i] ? 1 : 0));
}
export function lidFlagTable(plan: LexIdPlan, texts: readonly string[]): boolean[] {
  const t = Array.from({ length: plan.lids.length }, () => false);
  for (const x of texts) {
    const i = plan.lids.indexOf(x);
    if (i > 0) t[i] = true;
  }
  return t;
}

/**
 * Bool table indexed by kid for O(1) kind-set membership.
 * Only sets slots for kinds actually present in the plan (missing → skip, never alias to 0).
 */
export function kidFlagTable(plan: LexIdPlan, kinds: readonly string[]): boolean[] {
  const t = Array.from({ length: plan.kids.length }, () => false);
  for (const x of kinds) {
    const i = plan.kids.indexOf(x);
    if (i >= 0) t[i] = true;
  }
  return t;
}

// ── Arena id tables (rule_id / tt_id for slim Node + inlined leaves) ──
//
// Arena stores only rule nodes; leaf kids are negative i32 encodings that pack
// (tok_idx, tt_id). TT_NAMES is indexed by tt_id; RULE_NAMES by rule_id.
// TT_NAMES starts with LexIdPlan.kids so token-kind leaves can use Tok.kid as tt_id.

export type ArenaIdPlan = {
  ttNames: string[];   // TT_NAMES — leaf tokenType strings
  ruleNames: string[]; // RULE_NAMES — CST rule labels
};

/** Sentinel tt_id for $punct (trivia — never stored as a leaf). Not an index into ttNames. */
export const TT_SKIP_PUNCT = 255;

/** Collect every ttype text that push_leaf / match_lit|match_tok may emit (excluding $punct). */
function collectStepTtypes(steps: Step[], out: Set<string>): void {
  for (const s of steps) {
    switch (s.t) {
      case 'lit': if (s.ttype !== '$punct') out.add(s.ttype); break;
      case 'tok': out.add(s.name); break;
      case 'altlit': for (const o of s.opts) if (o.ttype !== '$punct') out.add(o.ttype); break;
      case 'sep': collectStepTtypes([s.elem], out); break;
      case 'suppress': case 'ctx': collectStepTtypes(s.steps, out); break;
      case 'star': collectStepTtypes([s.step], out); break;
      case 'opt': case 'seq': collectStepTtypes(s.steps, out); break;
      case 'alt': for (const b of s.branches) collectStepTtypes(b, out); break;
      default: break;
    }
  }
}

/**
 * Build TT_NAMES + RULE_NAMES for arena slim encoding.
 * TT_NAMES = kids 全体 ∪ {$keyword,$operator,$templateHead,$templateMiddle,$templateTail}
 *            ∪ other push_leaf ttypes collected from the IR (exhaustive).
 * RULE_NAMES = every rule cstName ∪ {$template} when templates are enabled.
 */
export function buildArenaIdPlan(ir: ParserIR, lexIds: LexIdPlan): ArenaIdPlan {
  const ttNames = [...lexIds.kids];
  const seenTt = new Set<string>(ttNames);
  const addTt = (s: string) => { if (!seenTt.has(s)) { seenTt.add(s); ttNames.push(s); } };
  for (const s of ['$keyword', '$operator', '$templateHead', '$templateMiddle', '$templateTail']) addTt(s);

  const fromSteps = new Set<string>();
  for (const r of ir.rules) {
    if (r.kind === 'rd') {
      for (const alt of r.alts) collectStepTtypes(alt, fromSteps);
    } else {
      for (const t of r.nudToks) fromSteps.add(t);
      for (const b of r.nudBrackets) collectStepTtypes(b.steps, fromSteps);
      for (const seq of r.nudSeqs) collectStepTtypes(seq, fromSteps);
      for (const c of r.nudCapped) collectStepTtypes(c.steps, fromSteps);
      for (const b of r.leds) collectStepTtypes(b.steps, fromSteps);
      for (const t of r.postfixToks) fromSteps.add(t);
    }
  }
  for (const body of ir.lookaheads) collectStepTtypes(body, fromSteps);
  if (ir.newlineCfg) fromSteps.add(ir.newlineCfg.token);
  for (const s of fromSteps) addTt(s);

  if (ttNames.length > 64) {
    throw new Error(`TT_NAMES length ${ttNames.length} exceeds tt_id limit 63`);
  }

  const ruleNames: string[] = [];
  const seenR = new Set<string>();
  const addR = (s: string) => { if (!seenR.has(s)) { seenR.add(s); ruleNames.push(s); } };
  for (const r of ir.rules) addR(r.name);
  if (ir.tpl) addR('$template');

  return { ttNames, ruleNames };
}

/** Resolve tt_id for a leaf tokenType; throws if missing (codegen bug). $punct → TT_SKIP_PUNCT. */
export function ttIdOf(plan: ArenaIdPlan, ttype: string): number {
  if (ttype === '$punct') return TT_SKIP_PUNCT;
  const i = plan.ttNames.indexOf(ttype);
  if (i < 0) throw new Error(`ttIdOf: unknown ttype ${JSON.stringify(ttype)}`);
  return i;
}

/** Resolve rule_id for a CST rule label; throws if missing. */
export function ruleIdOf(plan: ArenaIdPlan, rule: string): number {
  const i = plan.ruleNames.indexOf(rule);
  if (i < 0) throw new Error(`ruleIdOf: unknown rule ${JSON.stringify(rule)}`);
  return i;
}

// ── Lexer first-byte dispatch (IR analysis; targets render buckets) ──

export type LexFirstBytes = { bytes: number[]; nonAscii: boolean };

/** Conservative FIRST-byte analysis for a punct literal. */
export function punctFirstBytes(value: string): LexFirstBytes | null {
  if (value.length === 0) return null;
  const c = value.charCodeAt(0);
  if (c >= 128) return { bytes: [], nonAscii: true };
  return { bytes: [c], nonAscii: false };
}

function expandRangeToAscii(lo: number, hi: number, out: Set<number>): boolean {
  let nonAscii = false;
  if (lo >= 128 || hi >= 128) nonAscii = true;
  for (let c = Math.max(0, lo); c <= Math.min(127, hi); c++) out.add(c);
  return nonAscii;
}

function rangesToFirstBytes(ranges: CharRange[]): LexFirstBytes {
  const bytes = new Set<number>();
  let nonAscii = false;
  for (const [lo, hi] of ranges) nonAscii = expandRangeToAscii(lo, hi, bytes) || nonAscii;
  return { bytes: [...bytes].sort((a, b) => a - b), nonAscii };
}

function patternNullable(p: TokenPattern): boolean {
  if (typeof p === 'string') return false;
  switch (p.type) {
    case 'repeat': return p.min === 0;
    case 'lookahead': case 'lookbehind': case 'anchor': case 'never': return true;
    default: return false;
  }
}

function patternFirst(p: TokenPattern): LexFirstBytes | null {
  if (typeof p === 'string') {
    const c = p.charCodeAt(0);
    if (c >= 128) return { bytes: [], nonAscii: true };
    return { bytes: [c], nonAscii: false };
  }
  switch (p.type) {
    case 'seq': {
      const bytes = new Set<number>();
      let nonAscii = false;
      for (const item of p.items) {
        const fb = patternFirst(item);
        if (fb === null) return null;
        fb.bytes.forEach((b) => bytes.add(b));
        nonAscii = nonAscii || fb.nonAscii;
        if (!patternNullable(item)) break;
      }
      return { bytes: [...bytes].sort((a, b) => a - b), nonAscii };
    }
    case 'alt': {
      const bytes = new Set<number>();
      let nonAscii = false;
      for (const item of p.items) {
        const fb = patternFirst(item);
        if (fb === null) return null;
        fb.bytes.forEach((b) => bytes.add(b));
        nonAscii = nonAscii || fb.nonAscii;
      }
      return { bytes: [...bytes].sort((a, b) => a - b), nonAscii };
    }
    case 'charClass': {
      if (p.negate) {
        const bytes = new Set<number>();
        for (let c = 0; c <= 127; c++) bytes.add(c);
        return { bytes: [...bytes], nonAscii: true };
      }
      const bytes = new Set<number>();
      let nonAscii = false;
      for (const item of p.items) {
        if (item.type === 'char') {
          const c = item.value.charCodeAt(0);
          if (c <= 127) bytes.add(c); else nonAscii = true;
        } else {
          nonAscii = expandRangeToAscii(item.from.charCodeAt(0), item.to.charCodeAt(0), bytes) || nonAscii;
        }
      }
      return { bytes: [...bytes].sort((a, b) => a - b), nonAscii };
    }
    case 'repeat': return patternFirst(p.body);
    case 'anyChar': return null;
    case 'lookahead': case 'lookbehind': case 'anchor': case 'never':
      return { bytes: [], nonAscii: false };
    default: return null;
  }
}

/** Which ASCII bytes (0..127) may start this token matcher; nonAscii ⇒ also in fallback. null ⇒ all bytes + nonAscii. */
export function lexTokFirstBytes(t: LexTok): LexFirstBytes | null {
  switch (t.kind) {
    case 'run': return rangesToFirstBytes(t.first);
    case 'runBail': {
      // first ASCII ∪ bail ASCII ∪ headBail ASCII — so both a `\`-led Ident (cont-escape
      // opener) and a complex-head-only entry char reach this token's dispatch arm.
      const fb = rangesToFirstBytes(t.first);
      const bytes = new Set(fb.bytes);
      let nonAscii = fb.nonAscii || t.bailNonAscii || t.headBailNonAscii;
      for (const b of [...t.bail, ...t.headBail]) {
        if (b < 128) bytes.add(b);
        else nonAscii = true;
      }
      return { bytes: [...bytes].sort((a, b) => a - b), nonAscii };
    }
    case 'string': return punctFirstBytes(t.delim);
    case 'line': return punctFirstBytes(t.prefix);
    case 'block': return punctFirstBytes(t.open);
    case 'pattern': return patternFirst(t.pattern);
  }
}

/** True if any range endpoint is ≥128 (non-ASCII). Used by targets to refuse byte-tight cont loops. */
export function rangesHaveNonAscii(rs: CharRange[]): boolean {
  return rs.some(([, hi]) => hi >= 128);
}

export type LexDispatchMeta = {
  key: string;
  shape: LexTok['kind'] | 'punct';
  firstBytes: LexFirstBytes | null;
};

export type LexDispatchArm = { bytes: number[]; indices: number[] };

/** Build per-byte buckets (0..127) over a fixed global candidate sequence; fallback (a non-ASCII
 * unit at the token's start) = the candidates that may begin with one: first bytes unknown, or nonAscii. */
export function buildLexDispatchPlan(firsts: (LexFirstBytes | null)[]): { arms: LexDispatchArm[]; fallbackIndices: number[] } {
  const n = firsts.length;
  const fallbackIndices = [...Array(n).keys()].filter((i) => firsts[i] === null || firsts[i]!.nonAscii);
  const asciiBuckets: number[][] = Array.from({ length: 128 }, () => []);
  for (let i = 0; i < n; i++) {
    const fb = firsts[i];
    if (fb === null) {
      for (let b = 0; b < 128; b++) asciiBuckets[b].push(i);
    } else {
      for (const b of fb.bytes) if (b >= 0 && b < 128) asciiBuckets[b].push(i);
    }
  }
  const keyToBytes = new Map<string, number[]>();
  const keyToIndices = new Map<string, number[]>();
  for (let b = 0; b < 128; b++) {
    const indices = asciiBuckets[b];
    if (!indices.length) continue;
    const key = indices.join(',');
    if (!keyToIndices.has(key)) { keyToIndices.set(key, indices); keyToBytes.set(key, []); }
    keyToBytes.get(key)!.push(b);
  }
  const arms: LexDispatchArm[] = [...keyToIndices.entries()].map(([key, indices]) => ({
    bytes: keyToBytes.get(key)!.sort((a, b) => a - b),
    indices,
  }));
  arms.sort((a, b) => a.bytes[0] - b.bytes[0]);
  return { arms, fallbackIndices };
}

/** Interval notation for report tables, e.g. "a-z, A-Z, 48". */
export function formatFirstBytes(fb: LexFirstBytes | null): string {
  if (fb === null) return 'null (all ASCII + nonAscii)';
  if (!fb.bytes.length && fb.nonAscii) return '(empty ASCII) nonAscii';
  const parts: string[] = [];
  const sorted = [...fb.bytes].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i];
    let hi = lo;
    while (i + 1 < sorted.length && sorted[i + 1] === hi + 1) { hi = sorted[++i]; }
    if (lo === hi) {
      parts.push(lo >= 32 && lo <= 126 ? `'${String.fromCharCode(lo)}'(${lo})` : String(lo));
    } else {
      const ls = lo >= 32 && lo <= 126 ? `'${String.fromCharCode(lo)}'` : String(lo);
      const hs = hi >= 32 && hi <= 126 ? `'${String.fromCharCode(hi)}'` : String(hi);
      parts.push(`${ls}..${hs}`);
    }
  }
  if (fb.nonAscii) parts.push('nonAscii');
  return parts.join(', ');
}
