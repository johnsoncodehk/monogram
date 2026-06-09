// ─────────────────────────────────────────────────────────────────────────────
//  generative-detect.ts — the scope≡role DIVERGENCE DETECTION, factored out of
//  test/generative.ts so a SECOND consumer (test/gap-ledger.ts) can reuse the exact
//  same logic without re-implementing it (and without pulling in generative.ts's
//  top-level WASM load / process.exit driver).
//
//  This module is PURE (no I/O, no global side effects): it takes an already-parsed
//  CST and an already-tokenized flat-grammar token list and reports the positions
//  where the flat highlighter's visual bucket disagrees with a token's by-construction
//  role. test/generative.ts imports these and keeps its own gate behaviour; the gap
//  ledger imports them and treats the SAME violations as the gap set to minimize.
//
//  The two divergence classes (monogram#23/#24) and the gate-1/gate-2 logic live here
//  verbatim — see the comments inline; the original prose is in generative.ts's header.
// ─────────────────────────────────────────────────────────────────────────────
import { normScope } from './scope-roles.ts';
import type { CstNode, CstChild } from '../src/gen-parser.ts';
import type { CstGrammar, TokenPattern } from '../src/types.ts';
import { commentSpec, type GenOptions, type GenInput } from './grammar-gen.ts';

// The generation knobs BOTH consumers use, so the gap ledger sees the SAME derived corpus (hence the
// SAME divergence set) as generative.ts's check. `seed` is a no-op (the generator is a pure function
// of the grammar), kept only for back-compat; nothing here introduces run-to-run variation.
export const GEN_OPTS: GenOptions = { depth: 5, nestDepth: 5, cap: 7, fuzzRounds: 250, maxInputs: 1500, seed: 5 };

// ── flat-grammar token (one vscode-textmate token, absolute offsets) ──────────────
export interface TmTok { start: number; end: number; scopes: string[] }
// binary-search the innermost scope chain covering a byte position
export function scopeAt(toks: TmTok[], pos: number): string[] {
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (toks[mid].start <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans >= 0 && toks[ans].end > pos ? toks[ans].scopes : [];
}
export const innerOf = (s: string[]): string => (s.length ? s[s.length - 1] : '(none)');

// ── visual bucket of a scope chain — the level at which a highlight difference is actually visible.
//    Same partition the scope-gap differential pass uses; the consistency check compares buckets so a
//    `-` painted as string (punct≠string) is caught even though punctuation is a lexical-floor role. ──
export type Bucket = 'invalid' | 'comment' | 'string' | 'number' | 'keyword' | 'name' | 'punct' | 'none';
export function scopeBucket(chain: string[]): Bucket {
  for (let i = chain.length - 1; i >= 0; i--) {
    const s = normScope(chain[i]);
    if (/^invalid/.test(s)) return 'invalid';
    if (/^comment/.test(s)) return 'comment';
    if (/^constant\.numeric/.test(s)) return 'number';
    if (/^(string|constant\.character|constant\.other\.symbol)/.test(s)) return 'string';
    if (/^(keyword|storage|constant\.language|support\.constant|variable\.language)/.test(s)) return 'keyword';
    if (/^(entity|variable|support|constant)/.test(s)) return 'name';
    if (/^punctuation/.test(s)) return 'punct';
  }
  return 'none';
}
// every visual bucket a scope CHAIN spans (a YAML number is `string.unquoted constant.numeric` →
// {string, number} — both are legitimate, since the same token folds to a multi-line string).
export function chainBuckets(scope: string): Set<Bucket> {
  const out = new Set<Bucket>();
  for (const seg of scope.split(/\s+/)) if (seg) out.add(scopeBucket([seg]));
  return out;
}
export const CONTENT = new Set<Bucket>(['string', 'comment', 'number']);   // a STRUCTURAL literal is never one of these

// the visual buckets the highlighter actually painted ACROSS a leaf's span (whitespace skipped)
export function spanBuckets(toks: TmTok[], text: string, start: number, end: number): Set<Bucket> {
  const s = new Set<Bucket>();
  for (let p = start; p < end; p++) { const c = text.charCodeAt(p); if (c === 32 || c === 9) continue; s.add(scopeBucket(scopeAt(toks, p))); }
  return s.size ? s : new Set<Bucket>(['none']);
}

// ── by-construction expected role of a parsed leaf, from the grammar ALONE ──────────────────────
// A leaf's token TYPE → the bucket SET the grammar DECLARES for it: a named token → its `scope`
// chain's buckets; a `$punct`/`$keyword` literal → any `scopes` override, else punctuation / keyword.
// `lit` marks a STRUCTURAL literal (`$punct`/`$keyword`) — one the parser placed as grammar structure,
// so the highlighter painting it as CONTENT (string/comment/number) is always wrong (monogram#24).
export interface LeafRole { start: number; end: number; text: string; tokenType: string; expected: Set<Bucket>; lit: boolean }
export function buildRoleMap(grammar: CstGrammar): (leaf: { tokenType: string; text: string }) => { buckets: Set<Bucket>; lit: boolean } | null {
  const tokScope = new Map<string, string | undefined>();
  for (const t of grammar.tokens) tokScope.set(t.name, t.scope);
  const skip = new Set<string>();
  if (grammar.indent) { skip.add(grammar.indent.indentToken); skip.add(grammar.indent.dedentToken); skip.add(grammar.indent.newlineToken); }
  if (grammar.newline) skip.add(grammar.newline.token);
  const over = grammar.scopeOverrides;
  return (leaf) => {
    const ty = leaf.tokenType;
    if (skip.has(ty)) return null;
    if (ty === '$punct') { const o = over.get(leaf.text); return { buckets: o ? new Set(o.flatMap((s) => [...chainBuckets(s)])) : new Set<Bucket>(['punct']), lit: true }; }
    if (ty === '$keyword') { const o = over.get(leaf.text); return { buckets: o ? new Set(o.flatMap((s) => [...chainBuckets(s)])) : new Set<Bucket>(['keyword']), lit: true }; }
    if (ty.startsWith('$template')) return { buckets: new Set<Bucket>(['string']), lit: false };
    if (tokScope.has(ty)) { const sc = tokScope.get(ty); return sc ? { buckets: chainBuckets(sc), lit: false } : null; }
    return null;   // unscoped / contextual token (a bare identifier) → not checkable by-construction
  };
}
export function leafRoles(grammar: CstGrammar, cst: CstNode, input: string, roleOf: (l: { tokenType: string; text: string }) => { buckets: Set<Bucket>; lit: boolean } | null): LeafRole[] {
  const out: LeafRole[] = [];
  const walk = (n: CstChild) => {
    if ('tokenType' in n) {
      if (n.end <= n.offset) return;
      const text = input.slice(n.offset, n.end);   // leaves are span-only; text is derived
      const r = roleOf({ tokenType: n.tokenType, text });
      if (r) out.push({ start: n.offset, end: n.end, text, tokenType: n.tokenType, expected: r.buckets, lit: r.lit });
    } else for (const c of n.children) walk(c);
  };
  walk(cst);
  return out;
}

// Scopes that belong to a POSITION-ANCHORED token — one whose pattern contains a `start()` anchor
// (e.g. YAML's DocStart/DocEnd `^---`/`^...`). Such a scope is the parser's signal "a marker AT a
// line/stream position"; the flat highlighter, retrying the pattern at every token boundary, may
// paint it on a token the parser placed elsewhere (a value-leading `---`, monogram#23). Map each
// such scope → the set of token names allowed to carry it, so a mismatch is detectable generically.
export function anchoredScopes(grammar: CstGrammar): Map<string, Set<string>> {
  const hasStart = (p: TokenPattern): boolean => {
    if (typeof p === 'string') return false;
    switch (p.type) {
      case 'anchor': return p.kind === 'start';
      case 'seq': case 'alt': return p.items.some(hasStart);
      case 'repeat': case 'lookahead': case 'lookbehind': return hasStart(p.body);
      default: return false;
    }
  };
  const m = new Map<string, Set<string>>();
  for (const t of grammar.tokens) if (t.scope && hasStart(t.pattern)) { const s = m.get(t.scope) ?? new Set(); s.add(t.name); m.set(t.scope, s); }
  return m;
}

// ── a single scope≡role inconsistency (flat highlighter ≠ parser) at a position ──────────────────
export interface Violation { input: string; strategy: string; pos: number; text: string; tokenType: string; expected: string; got: Bucket; gotScope: string; kind: string }

// Per-input divergence detection — the gate-1 (structural-literal→content, #24) and gate-2
// (anchored-marker misfire, #23) scans, factored out so both generative.ts and gap-ledger.ts run
// the IDENTICAL check. Pure: it reads an already-parsed CST and already-tokenized flat tokens.
//   • gate-1 — a `$punct`/`$keyword` the parser placed as grammar STRUCTURE, painted entirely as a
//     CONTENT class (string/comment/number). A `-` indicator is never a string (#24). Floor-blind.
//   • gate-2 — a leaf painted with a position-anchored token's scope when the parser did NOT place
//     that token here (a value-leading `---` scoped document-marker, #23).
// Leniency: a token is CONSISTENT when the highlighter paints ANY part of its span with a scope in the
// token's declared-chain bucket SET (a quote-delimiter sub-scope, a number folded into a string are OK).
export function collectViolations(args: {
  input: string;
  strategy: string;
  cst: CstNode;
  toks: TmTok[];
  leaves: LeafRole[];
  anchored: Map<string, Set<string>>;
  cap?: number;          // stop after this many (generative.ts uses 200; the ledger leaves it open)
  startCount?: number;   // current count toward the cap (so a caller accumulating across inputs can pass it)
}): Violation[] {
  const { input, strategy, toks, leaves, anchored } = args;
  const cap = args.cap ?? Infinity;
  let count = args.startCount ?? 0;
  const out: Violation[] = [];
  const leafCover = (pos: number) => leaves.find((l) => pos >= l.start && pos < l.end);
  for (const lr of leaves) {
    const got = spanBuckets(toks, input, lr.start, lr.end);
    const overlap = [...lr.expected].some((b) => got.has(b));
    if (overlap) continue;                                                  // highlighter painted the declared scope somewhere → consistent
    // A structural literal (`$punct`/`$keyword`) the parser placed as grammar structure painted as a
    // CONTENT class (#24) OR as a NAME class (entity/variable/support — a `-` indicator scoped as a key
    // name when a flat grammar leaks a flow region into a block, monogram's explicit-key `[` gap). Both
    // are unambiguous: the overlap check above already cleared any literal the grammar DECLARES as
    // name/content (a scopes-override), so reaching here means the highlighter invented the class.
    const contentGot = [...got].find((b) => CONTENT.has(b));
    // the NAME check is `$punct`-only: a `-`/`[`/`:` is never a named entity, but a `$keyword` legitimately
    // CAN be (the TS `this` parameter is painted `variable.parameter`, a name) — so keywords are excluded
    // from the name class to avoid that false positive (content, where a keyword is never valid, stays both).
    const nameGot = lr.tokenType === '$punct' && got.has('name') ? 'name' as const : undefined;
    const badGot = contentGot ?? nameGot;
    if (lr.lit && badGot && count < cap) {
      out.push({ input, strategy, pos: lr.start, text: lr.text, tokenType: lr.tokenType, expected: [...lr.expected].join('|'), got: badGot, gotScope: innerOf(scopeAt(toks, lr.start)), kind: contentGot ? '#24 structural-literal→content' : 'structural-literal→name' });
      count++;
    }
  }
  if (anchored.size) for (const t of toks) {
    if (t.end <= t.start) continue;
    const inner = innerOf(t.scopes);
    const owners = anchored.get(inner.replace(/\.[a-z0-9]+$/, '')) ?? anchored.get(inner);
    if (!owners) continue;
    const leaf = leafCover(t.start);
    if (leaf && !owners.has(leaf.tokenType) && count < cap) {
      out.push({ input, strategy, pos: t.start, text: input.slice(t.start, t.end), tokenType: leaf.tokenType, expected: [...owners].join('|'), got: 'name', gotScope: inner, kind: '#23 anchored-marker misfire' });
      count++;
    }
  }
  return out;
}

// ── COMMENT-WITNESS check (the last coverage hole: comment scopes) ───────────────────────────────
// A comment is a `skip:true` token the parser DROPS — it never becomes a CST leaf, so the leaf walk above
// (and `checkedTokens`) can NEVER reach a comment's highlighter scope (0% coverage). The generator closes
// that by INJECTING a comment at a safe position and recording its span as a WITNESS in `GenInput.tokens`
// (grammar-gen.ts §8). THIS is the consumer: for each recorded comment witness, the flat highlighter must
// paint that span with the COMMENT bucket — graded with the SAME `scopeBucket` partition the rest of the
// check uses. The judge compares against the GENERATOR'S witness, not a parser leaf (there is none) — the
// crux the prompt names. Leniency mirrors `collectViolations`: a comment is CONSISTENT if the highlighter
// paints ANY part of its span `comment` (so the `<!--`/`-->` punctuation sub-scope is fine, only the body
// needs `comment`); a span with NO `comment` anywhere (painted entirely string / text / etc.) is the gap.

// The comment-token NAMES of a grammar (so a witness in `tokens` is identifiable as a comment) — the SAME
// generic discovery the generator uses, memoised per grammar object so repeated calls are cheap.
const commentNamesCache = new WeakMap<object, Set<string>>();
export function commentTokenNames(grammar: CstGrammar): Set<string> {
  let s = commentNamesCache.get(grammar);
  if (!s) { s = commentSpec(grammar)?.names ?? new Set<string>(); commentNamesCache.set(grammar, s); }
  return s;
}

// The comment WITNESSES of one generated input: the `tokens` entries whose name is a comment token. ONLY
// a comment-INJECTED input (its strategy carries the `comment:` marker) has authoritative, span-verified
// witnesses — there `tokens` is exactly the comment(s) the generator spliced at a known offset. A BASE
// input may ALSO carry `materialize`-recorded comment tokens (the grammar can emit a native `<!-- -->`),
// but those spans are unreliable for markup fragments (a degenerate `> <!--x-->` mis-spans, an empty
// `<!---->` is all-punctuation) and were never meant as a ground-truth witness — so they are NOT graded.
export function commentWitnesses(grammar: CstGrammar, input: GenInput): GenInput['tokens'] {
  if (!input.strategy.includes('comment:')) return [];
  const names = commentTokenNames(grammar);
  return names.size ? input.tokens.filter((t) => names.has(t.name) && t.end > t.start) : [];
}

// Grade each comment witness: a divergence iff the highlighter painted NO part of the witness span with the
// `comment` bucket. Returns the divergences as `Violation`s (kind `#comment uncolored`), filed like the
// others so they flow into the same report / gate / gap-ledger plumbing.
export function collectCommentViolations(args: { grammar: CstGrammar; input: string; strategy: string; witnesses: GenInput['tokens']; toks: TmTok[] }): Violation[] {
  const out: Violation[] = [];
  for (const w of args.witnesses) {
    const got = spanBuckets(args.toks, args.input, w.start, w.end);
    if (got.has('comment')) continue;                         // painted as a comment somewhere → consistent
    const gotBucket = [...got][0] ?? 'none';
    out.push({ input: args.input, strategy: args.strategy, pos: w.start, text: w.text, tokenType: w.name, expected: 'comment', got: gotBucket, gotScope: innerOf(scopeAt(args.toks, w.start)), kind: '#comment uncolored' });
  }
  return out;
}

// What GATES vs what is a report-only DISCOVERY (generative.ts's exact predicate):
//  • an ANCHORED-MARKER misfire (#23) ALWAYS gates.
//  • a STRUCTURAL-LITERAL divergence (#24 →content, →name) ALWAYS gates, on EVERY strategy
//    INCLUDING fuzz. The prior "fuzz #24 = a standing flat-TM frontier limit → report-only"
//    concession was DISPROVEN: every such divergence found (value-position, flow-in-key, self-close,
//    mixed-case raw-text, non-first-item compact) was a FIXABLE depth/structure bug, closed by
//    deriving the region — never a frontier limit. A structural literal (a punctuation / keyword the
//    parser assigns by construction) painted as content/name is a real bug regardless of HOW it was
//    discovered, so gate it — don't concede it. (A genuinely-proven TextMate limit, if one is ever
//    established, is excluded by an explicit fingerprint allowlist, never a blanket strategy.)
//  • a COMMENT-uncolored divergence ALWAYS gates (same reasoning — no legitimate "frontier limit"
//    where an injected comment is not a comment). On today's correct grammars this finds 0; it
//    CATCHES a future scope regression. Gating is by KIND (the bug class), NOT discovery STRATEGY.
export const isGated = (v: { kind: string }): boolean => v.kind.startsWith('#23') || v.kind.startsWith('#comment') || v.kind.includes('structural-literal');
