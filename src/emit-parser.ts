// ── emit-parser ──
//
// An EMITTER (vs the createParser RUNTIME INTERPRETER in gen-parser.ts). It takes
// the same CstGrammar, re-derives the SAME static analysis createParser does
// (precedence/binding-power tables, Pratt NUD/LED classification, FIRST sets,
// nullability, mixfix/access-tail detection), and emits SELF-CONTAINED JavaScript
// for a parser that bakes those tables in as constants and emits the PER-RULE +
// PER-ARM matching as SPECIALIZED straight-line code — replacing the interpreter's
// matchExpr/matchSeq/matchQuantifier/matchSep tree-walk dispatch.
//
// The algorithmic CONTROL cores (the Pratt precedence loop, the left-recursion
// loop, the longest-match non-recursive loop, the mixfix operand re-bind, the
// packrat memo, save/restore backtracking) stay as a generic runtime that the
// emitted code CALLS — copied VERBATIM from gen-parser.ts so their longest-match /
// tail-closing / suppress / mixfix semantics are byte-identical to the oracle.
// What those loops used to dispatch per arm (matchExpr(alt) / matchSeq(items)) is
// now a GENERATED specialized matcher per NUD/LED/alt arm, so the interpretive
// dispatch — the ~third of parse time the CPU profile attributes to matchExpr +
// per-arm re-classification — is removed.
//
// The LEXER is identical in both worlds and is OUTSIDE this optimization, so the
// emitted code imports the fixed createLexer RUNTIME and feeds it the grammar's
// baked token+config DATA (a "grammar-lite"); it never imports the grammar
// DEFINITION object. createParser is the correctness oracle — the emitted parser
// must reproduce its CST byte-for-byte.

import type { CstGrammar, RuleExpr, RuleDecl } from './types.ts';
import { isKeywordLiteral, collectLiterals } from './grammar-utils.ts';
import { analyzeGrammar, findEntryRule, type Sec } from './grammar-analysis.ts';
import { emitSoaLexer } from './emit-lexer.ts';
import type { Target } from './emit.ts';
import { withAwaitYield } from './await-yield-fork.ts';

// ── Static analysis ──
// The STRUCTURAL analysis (precedence, NUD/LED + atom/continuation classification, left
// recursion, nullability) is single-sourced in grammar-analysis.ts and shared with the
// interpreter; the emitter layers the emit-only pieces on top: the reserved-aware "qualKeys"
// FIRST sets, the SECOND-token dispatch, ledMeta/nudCap/contMeta, and the integer token
// vocabulary.

type FirstTok = { lit: string } | { tok: string } | null;
type MixfixInfo = { openLit: string; sepLit: string };

/** Build the full static analysis the emitter needs, returned as plain data. */
function analyze(grammar: CstGrammar) {
  const {
    tokenNames, opTable, prefixOps, noUnaryLhsOps, postfixOpValues, requireTargetOps,
    ledPrecByConnector, binaryConnectors, connectorLbp,
    prattRules, prattClassified, leftRecClassified, leftRecSet, ruleByName,
    nullableRules, exprNullable, maxBp, templateTokenName, templateTokenNames,
    exprSecond,
  } = analyzeGrammar(grammar);

  // First-token dispatch.
  function firstTokenOf(alt: RuleExpr): FirstTok {
    const items = alt.type === 'seq' ? alt.items : [alt];
    const first = items[0];
    if (!first) return null;
    if (first.type === 'literal') return { lit: first.value };
    if (first.type === 'ref' && tokenNames.has(first.name)) return { tok: first.name };
    return null;
  }

  // Mixfix operand re-bind shape: `<lit L1> $self <lit L2> …`.
  function selfRefName(e: RuleExpr | undefined, ruleName: string): boolean {
    return !!e && e.type === 'ref' && e.name === ruleName;
  }
  function mixfixOf(items: RuleExpr[], ruleName: string): MixfixInfo | null {
    if (items.length >= 4 && items[0]?.type === 'literal' && selfRefName(items[1], ruleName) && items[2]?.type === 'literal') {
      return { openLit: items[0].value, sepLit: items[2].value };
    }
    return null;
  }

  // Access-tail + tail-closing LED classification (Pratt).
  // Returns, per Pratt rule, parallel arrays of flags aligned to the leds array.
  const ledMeta = new Map<string, { accessTail: boolean[]; tailClosing: boolean[]; mixfix: (MixfixInfo | null)[]; first: FirstTok[]; prec: ({ lbp: number; rhsBp: number | null } | null)[]; notLeftLeaf: (string[] | null)[] }>();
  for (const [ruleName, { leds }] of prattClassified.entries()) {
    const accessTail: boolean[] = [];
    const tailClosing: boolean[] = [];
    const mixfix: (MixfixInfo | null)[] = [];
    const first: FirstTok[] = [];
    const prec: ({ lbp: number; rhsBp: number | null } | null)[] = [];
    const notLeftLeaf: (string[] | null)[] = [];
    for (const led of leds) {
      const it = led.items;
      let isAccessTail = false, isTailClosing = false;
      if (it.length > 0 && it[0].type !== 'op' && it[0].type !== 'postfix') {
        const last = it[it.length - 1];
        const lastIsOperand = selfRefName(last, ruleName);
        const wordConnector = it[0].type === 'literal' && /^[A-Za-z]/.test(it[0].value);
        if (!lastIsOperand && !wordConnector) isAccessTail = true;
        if (last.type === 'not') isTailClosing = true;
      }
      accessTail.push(isAccessTail);
      tailClosing.push(isTailClosing);
      mixfix.push(mixfixOf(led.items, ruleName));
      first.push(firstTokenOf({ type: 'seq', items: led.items } as RuleExpr));
      const firstItem = led.items[0];
      const lp = firstItem?.type === 'literal' ? ledPrecByConnector.get(firstItem.value) ?? null : null;
      if (lp !== null && lp.rhsBp !== null) {
        const last = led.items[led.items.length - 1];
        if (!(last?.type === 'ref' && last.name === ruleName)) {
          throw new Error(`ledPrec ${firstItem.type === 'literal' ? firstItem.value : '?'}: chainRhs requires a trailing self-operand`);
        }
      }
      prec.push(lp);
      notLeftLeaf.push(led.notLeftLeaf ?? null);
    }
    ledMeta.set(ruleName, { accessTail, tailClosing, mixfix, first, prec, notLeftLeaf });
  }

  // Capped-NUD classification (Pratt). A NUD alternative wrapped in a `cap`-group is a
  // complete assignment-level expression (an ArrowFunction — the lowest-precedence
  // AssignmentExpression): it parses only when minBp is LOOSER than the named connector's
  // binding power (so it is refused as the operand of any tighter operator, e.g.
  // `a || () => {}`), and once parsed it admits NO led (so `() => {} || a` leaves `|| a`
  // unconsumed and the parse rejects). `cap[i]` is the binding-power threshold for nud i
  // (null = uncapped). The connector's lbp resolves from the ladder or the ledPrec table.
  const nudCap = new Map<string, (number | null)[]>();
  for (const [ruleName, { nuds }] of prattClassified.entries()) {
    nudCap.set(ruleName, nuds.map(nud =>
      nud.type === 'group' && nud.capBelow !== undefined ? connectorLbp(nud.capBelow) : null));
  }

  // Left-rec continuation mixfix.
  const contMeta = new Map<string, (MixfixInfo | null)[]>();
  for (const [ruleName, { continuations }] of leftRecClassified.entries()) {
    contMeta.set(ruleName, continuations.map(c => mixfixOf(c, ruleName)));
  }


  // FIRST sets.
  //
  // Reserved-aware keys: a `not(alt('if', 'var', …))` guard immediately before the
  // first consuming element proves those keyword texts can never be this position's
  // token. A token-name key gathered under such a guard becomes a QUALIFIED key
  // ('\0Q:'-prefixed, registered in qualKeys) and is emitted as TM[0] plus every
  // non-excluded keyword t-bit instead of the blanket k-bit — so a reserved-keyword
  // lookahead no longer admits identifier-led alternatives it provably cannot start
  // (the dominant longest-match waste: expr-stmt/labeled-stmt arms on 'var'/'if'/…).
  // Sound: every pruned (alt, token) pair fails its not-guard before consuming.
  const qualKeys = new Map<string, { tok: string; except: Set<string> }>();
  function qualKey(tok: string, except: Set<string>): string {
    const sorted = [...except].sort();
    const key = '\u0000Q:' + tok + ':' + sorted.join(',');
    if (!qualKeys.has(key)) qualKeys.set(key, { tok, except: new Set(sorted) });
    return key;
  }
  // null = the key is guarded out entirely (a keyword literal inside its own not-class).
  function excludeKey(k: string, pending: Set<string>): string | null {
    const q = qualKeys.get(k);
    if (q) return qualKey(q.tok, new Set([...q.except, ...pending]));
    if (tokenNames.has(k)) return qualKey(k, pending);
    if (pending.has(k)) return null;
    return k;
  }
  // A not() whose body is purely keyword literals (the reserved-word guard shape).
  function notKeywordClass(body: RuleExpr): Set<string> | null {
    const items = body.type === 'alt' ? body.items : [body];
    const out = new Set<string>();
    for (const it of items) {
      if (it.type !== 'literal' || !isKeywordLiteral(it.value)) return null;
      out.add(it.value);
    }
    return out.size > 0 ? out : null;
  }
  const firstSets = new Map<string, Set<string> | null>();
  function exprFirst(e: RuleExpr): Set<string> | null {
    switch (e.type) {
      case 'literal': return new Set([e.value]);
      case 'ref': {
        if (tokenNames.has(e.name)) return new Set([e.name]);
        return firstSets.has(e.name) ? firstSets.get(e.name)! : new Set();
      }
      case 'seq': {
        const acc = new Set<string>();
        let pending: Set<string> | null = null;
        for (const item of e.items) {
          if (item.type === 'prefix') {
            // A pratt prefix form ([prefix, operand]): its first token is one of the
            // prefix-operator literals — a real set, not unknown. Keeps FIRST(Expr)
            // from collapsing to null/always-admit.
            for (const op of prefixOps.keys()) {
              const ek = pending ? excludeKey(op, pending) : op;
              if (ek !== null) acc.add(ek);
            }
            return acc;
          }
          if (item.type === 'not') {
            const kws = notKeywordClass(item.body);
            if (kws) pending = pending ? new Set([...pending, ...kws]) : kws;
            continue;
          }
          if (item.type === 'op' || item.type === 'postfix' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore' || item.type === 'notLeftLeaf') continue;
          const f = exprFirst(item);
          if (f === null) return null;
          for (const k of f) {
            const ek = pending ? excludeKey(k, pending) : k;
            if (ek !== null) acc.add(ek);
          }
          if (!exprNullable(item)) return acc;
        }
        return acc;
      }
      case 'alt': {
        const acc = new Set<string>();
        for (const item of e.items) {
          const f = exprFirst(item);
          if (f === null) return null;
          for (const k of f) acc.add(k);
        }
        return acc;
      }
      case 'quantifier': case 'group': return exprFirst(e.body);
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore': case 'notLeftLeaf': return new Set();
      case 'sep': return exprFirst(e.element);
      default: return null;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      const prev = firstSets.get(rule.name);
      if (prev === null) continue;
      const next = exprFirst(rule.body);
      if (next === null) { firstSets.set(rule.name, null); changed = true; continue; }
      const merged = prev ? new Set(prev) : new Set<string>();
      let grew = false;
      for (const k of next) if (!merged.has(k)) { merged.add(k); grew = true; }
      if (grew || prev === undefined) { firstSets.set(rule.name, merged); changed = true; }
    }
  }

  // Deep per-alternative FIRST set + nullability for the longest-match dispatch — the
  // emitted mirror of gen-parser.ts's altMightStart. An alternative whose FIRST element
  // is a rule ref (`Decl …`, `Expr …`) is pruned when the lookahead can't begin that
  // rule (resolved through the transitive firstSets), not only when it begins with a
  // known literal/token. Sound: exprFirst over-approximates (never omits a startable
  // token) and a nullable alt is always tried (its empty match never wins longest-match).
  const altDeepFirst = new Map<RuleExpr, Set<string> | null>();
  const altNullable = new Map<RuleExpr, boolean>();
  for (const rule of grammar.rules) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    for (const alt of alts) { altDeepFirst.set(alt, exprFirst(alt)); altNullable.set(alt, exprNullable(alt)); }
  }

  // SECOND-token dispatch: the per-rule SECOND sets (and the plain FIRST they feed off) are
  // single-sourced in grammar-analysis.ts and destructured above as exprSecond; altSecond
  // below precomputes each alternative's dispatch keys from it (the emitter's own reserved-
  // aware qualKeys FIRST, used for the FIRST dispatch, stays separate above).
  const altSecond = new Map<RuleExpr, Sec>();
  for (const rule of grammar.rules) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    for (const alt of alts) altSecond.set(alt, exprSecond(alt));
  }

  // ── Lever 1: integer token kinds ──
  // Replace the per-call string dispatch in literal/token matching and FIRST gating
  // (matchLiteral / matchToken / the membershipFn byte tables) with integer compares.
  // Two int fields are interned onto each token at parse time (see the emitted tokenize
  // wiring):
  //   tok.k = TYPE kind   — an int for tok.type ('' punctuation → PUNCT sentinel;
  //                         each declared token name → its own int; the three
  //                         template-token-kinds $templateHead/$templateMiddle/
  //                         $templateTail get their own ints below PUNCT-named).
  //   tok.t = LITERAL kind — if tok.text is a known keyword literal (for a named,
  //                         non-'' token) OR a known punctuation literal (for a ''
  //                         token), that literal's int; else 0 (NONE). Keyword ints
  //                         and punct ints occupy DISJOINT ranges, so tok.t alone
  //                         disambiguates keyword-vs-punct.
  // A keyword token (an identifier-type token whose text is e.g. "if") therefore has
  // tok.k = <Ident kind> AND tok.t = <KW_if>, so it matches BOTH the identifier
  // token-name key and the keyword key — exactly the dual-match keyMatchesTok did.
  //
  // Kind ranges (so a single >= test answers "is a declared token name"):
  //   PUNCT = 1; $templateHead = 2, $templateMiddle = 3, $templateTail = 4;
  //   declared token names: 5, 6, … (NAMED_MIN = 5).
  const KIND_PUNCT = 1;
  const KIND_TEMPLATE_HEAD = 2;
  const KIND_TEMPLATE_MIDDLE = 3;
  const KIND_TEMPLATE_TAIL = 4;
  const KIND_NAMED_MIN = 5;
  const typeKind = new Map<string, number>();
  typeKind.set('', KIND_PUNCT);
  typeKind.set('$templateHead', KIND_TEMPLATE_HEAD);
  typeKind.set('$templateMiddle', KIND_TEMPLATE_MIDDLE);
  typeKind.set('$templateTail', KIND_TEMPLATE_TAIL);
  let nextKind = KIND_NAMED_MIN;
  for (const name of tokenNames) if (!typeKind.has(name)) typeKind.set(name, nextKind++);

  // Literal ints: keyword literals in [1 .. kwCount], punct literals after, disjoint.
  // The vocabulary must be a SUPERSET of every string classifyKey()/matchLiteralCall()
  // is ever called with — otherwise an unlisted literal gets int 0 (NONE) and a t===0
  // compare would false-match every plain token. classifyKey/matchLiteral see:
  //   • every `literal` node value reachable in a rule body — INCLUDING inside `not`
  //     (the reserved-word negative-lookahead), which shared collectLiterals
  //     deliberately does NOT descend into; so we walk the full tree here.
  //   • every operator value (prefix/infix/postfix) — keyword-shaped ops like `delete`
  //     are matched as literals inside the reserved-word `not`, yet live only in `precs`.
  //   • every FIRST-set member (defensive; these are literals or token names).
  const allLiterals = new Set<string>();
  function collectAllLiterals(e: RuleExpr): void {
    switch (e.type) {
      case 'literal': allLiterals.add(e.value); return;
      case 'seq': case 'alt': e.items.forEach(collectAllLiterals); return;
      case 'quantifier': case 'group': case 'not': collectAllLiterals(e.body); return;
      case 'sep': collectAllLiterals(e.element); allLiterals.add(e.delimiter); return;
      default: return;
    }
  }
  for (const rule of grammar.rules) collectAllLiterals(rule.body);
  for (const level of grammar.precs) for (const op of level.operators) allLiterals.add(op.value);
  for (const fs of firstSets.values()) if (fs) for (const k of fs) if (!tokenNames.has(k) && !qualKeys.has(k)) allLiterals.add(k);
  const kwLitKind = new Map<string, number>();
  const puLitKind = new Map<string, number>();
  let nextLit = 1;
  for (const lit of allLiterals) if (isKeywordLiteral(lit) && !kwLitKind.has(lit)) kwLitKind.set(lit, nextLit++);
  for (const lit of allLiterals) if (!isKeywordLiteral(lit) && !puLitKind.has(lit)) puLitKind.set(lit, nextLit++);

  // Pre-classify a FIRST-set key the SAME way keyMatchesTok does, into an int
  // descriptor the emitted checks consume. Order MUST match keyMatchesTok:
  // tokenNames.has → token-name; else isKeywordLiteral → keyword; else punct.
  type KeyDesc =
    | { kind: 'tok'; k: number; template: boolean }
    | { kind: 'kw'; t: number }
    | { kind: 'punct'; t: number; v: string };
  function classifyKey(key: string): KeyDesc {
    if (tokenNames.has(key)) {
      return { kind: 'tok', k: typeKind.get(key)!, template: templateTokenNames.has(key) };
    }
    if (isKeywordLiteral(key)) {
      // A keyword key whose literal int we know (it is a literal in some rule body).
      // If somehow not in the vocabulary (defensive), fall back to a never-matching 0.
      return { kind: 'kw', t: kwLitKind.get(key) ?? 0 };
    }
    return { kind: 'punct', t: puLitKind.get(key) ?? 0, v: key };
  }
  // A sentinel kind for any non-'' token type the lexer did not declare (unreachable
  // for this closed lexer, but kept faithful): one past the max declared kind, so it
  // is >= NAMED_MIN (behaves as "a named token" for the keyword-by-text branch) yet
  // collides with NO real token-name kind (so matchToken(name) never false-matches it).
  const KIND_NAMED_FALLBACK = nextKind;
  typeKind.set('$error', KIND_NAMED_FALLBACK);
  const symtab = {
    KIND_PUNCT, KIND_TEMPLATE_HEAD, KIND_NAMED_MIN, KIND_NAMED_FALLBACK,
    typeKind, kwLitKind, puLitKind, classifyKey,
  };

  // Column element types: Uint8 when the kind/literal id spaces fit a byte (the SoA
  // token columns and their spare-buffer mirrors). Single-sourced here so every emit
  // function — emitRuntime's `let tk* = new …`, emitDriver's `let alt* …` — agrees.
  const tMaxT = Math.max(1, ...kwLitKind.values(), ...puLitKind.values());
  const kArr = KIND_NAMED_FALLBACK <= 255 ? 'Uint8Array' : 'Uint16Array';
  const tArr = tMaxT <= 255 ? 'Uint8Array' : 'Uint16Array';

  return {
    grammar, tokenNames, opTable, prefixOps, noUnaryLhsOps, postfixOpValues, requireTargetOps, binaryConnectors,
    prattRules, leftRecSet, ruleByName, prattClassified, leftRecClassified,
    maxBp, templateTokenName, templateTokenNames, firstTokenOf, altDeepFirst, altNullable,
    altSecond, ledMeta, contMeta, nudCap, nullableRules, firstSets, symtab, qualKeys,
    exprFirst, exprNullable, kArr, tArr,
  };
}

// ── Code-emission helpers ──

const J = (v: unknown) => JSON.stringify(v);
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Emit a specialized matcher BODY for a RuleExpr — straight-line code that mirrors
 * matchExpr/matchSeq/matchQuantifier/matchSep exactly, but with each step inlined as
 * a direct call (matchLiteral('x'), the ref's parse function, matchToken, an unrolled
 * quantifier loop, the zero-width assertions, sep). Pushes matched leaves/nodes into a
 * local array `out` (declared by the caller). On failure it `pos = <saveVar>; return null`.
 * Returns a string of statements. `saveVar` is the position to restore to on failure.
 *
 * The semantics are a 1:1 transcription of the interpreter's matchExpr switch, so the
 * emitted code accepts/rejects and shapes the CST identically.
 */
class Emitter {
  private buf: string[] = [];
  private tmp = 0;
  // Generated compound-matcher helpers, deduplicated by their structural key so an
  // expr shared across rules emits one helper. Each is a fn returning children[]|null
  // (the matchExpr contract) — control flow is `return`, never `break`, so inlined
  // loops (quantifier/sep) never clash with an enclosing construct's loop.
  private helpers = new Map<string, string>();   // structural key → fn name
  private helperDefs: string[] = [];
  // Deduped FIRST-set membership tables + their per-set test fns, hoisted to module
  // level. The longest-match alt guards and the rule-ref guards sit on the hottest
  // dispatch paths; each set bakes to two Uint8Array byte tables (indexed by tok.k /
  // tok.t) so the test is two loads + an or — no per-desc loop. Spliced at the same
  // `//${HELPERS}` sentinel (top-level, above the rule fns).
  private u8Consts = new Map<string, string>();     // `${size}:${ones}` → const name
  private memberFns = new Map<string, string>();    // `${kConst}|${tConst}` → fn name
  private u32Consts = new Map<string, string>();    // mask-table values → const name
  private u8Emitted = false;
  readonly a: ReturnType<typeof analyze>;
  constructor(a: ReturnType<typeof analyze>) { this.a = a; }

  // Token-text materialization: a source-span slice for an emitted (SoA) lexer, the
  // converter-filled text column for createLexer-fallback grammars (synthetic tokens
  // there — indent/dedent etc. — have text that is NOT a source span). Chosen at emit
  // time; the runtime has a single form.
  soa = false;
  textAt(idx: string): string {
    return this.soa ? `src.slice(tkOff[${idx}], tkEnd[${idx}])` : `tkText[${idx}]`;
  }
  private id() { return `_t${this.tmp++}`; }

  emit(line = '') { this.buf.push(line); }
  // The compound-matcher helpers are function declarations (hoisted), but they must sit
  // BELOW the module's import statements. The header emits a `${HELPERS}` sentinel right
  // after the imports/tables; we splice the collected helpers there.
  toString() {
    // MEMO_RULES is known only after every memoized rule allocated its slot.
    this.helperDefs.push(`const MEMO_RULES = ${this.memoIdx.size};`);
    const src = this.buf.join('\n');
    return src.replace('//${HELPERS}', this.helperDefs.join('\n\n'));
  }

  // Per-memoized-rule slot in the parse-wide memo array (replaces the string-keyed
  // outer Map: parseRuleEntry runs per rule entry, so the name hash was on a hot path).
  private memoIdx = new Map<string, number>();
  memoIndex(name: string): number {
    let i = this.memoIdx.get(name);
    if (i === undefined) { i = this.memoIdx.size; this.memoIdx.set(name, i); }
    return i;
  }

  // Reference to a rule's parse function (token refs are inlined where used).
  private ruleFn(name: string) { return `R_${sanitize(name)}`; }

  // SPINE rules — the entry rule's repetition units (the rules its body references
  // directly): memoized through parseRuleEntry and therefore the adoption/run-
  // extension granularity. Shared by emitRuleFns (memoized emission) and the
  // quantifier run-extension hook. Grammar-shape-derived — no language names.
  private spine: Set<string> | null = null;
  spineSet(): Set<string> {
    if (this.spine !== null) return this.spine;
    const a = this.a;
    const spine = new Set<string>();
    const entryRule = a.grammar.rules[a.grammar.rules.length - 1];
    const walk = (x: RuleExpr): void => {
      switch (x.type) {
        case 'ref': if (a.ruleByName.has(x.name)) spine.add(x.name); return;
        case 'seq': case 'alt': x.items.forEach(walk); return;
        case 'quantifier': case 'group': walk(x.body); return;
        case 'sep': walk(x.element); return;
        default: return;
      }
    };
    walk(entryRule.body);
    spine.delete(entryRule.name);
    return (this.spine = spine);
  }
  // The run-extension target of a repetition: when the body unwraps to a plain ref of
  // a rule that routes through parseRuleEntry (pratt / left-rec / spine), its rule id;
  // else -1 (the loop gets no extension hook — adoption stays element-by-element).
  quantRunInfo(body: RuleExpr): { rid: number; name: string } | null {
    const a = this.a;
    let expr = body;
    while (true) {
      if (expr.type === 'group' && !(expr.suppress && expr.suppress.length)) { expr = expr.body; continue; }
      if (expr.type === 'seq') {
        const real = expr.items.filter(it => it.type !== 'op' && it.type !== 'prefix' && it.type !== 'postfix');
        if (real.length === 1) { expr = real[0]; continue; }
      }
      break;
    }
    if (expr.type !== 'ref' || !a.ruleByName.has(expr.name)) return null;
    const name = expr.name;
    if (!(a.prattRules.has(name) || a.leftRecSet.has(name) || this.spineSet().has(name))) return null;
    const rid = a.grammar.rules.findIndex(r => r.name === name);
    return rid >= 0 ? { rid, name } : null;
  }
  quantRunRuleId(body: RuleExpr): number {
    const info = this.quantRunInfo(body);
    return info === null ? -1 : info.rid;
  }
  // Recovery hooks stay at SPINE-SHAPED repetitions (a plain rule ref or an
  // alt of rule refs — statement/member lists): hooking expression-internal
  // repetitions lets a bar-armed absorption fire inside longest-match arm probing,
  // which distorts arm selection and cascades (measured: 273 errors for one broken
  // identifier). An unhooked inner failure escalates to the nearest hooked list,
  // which absorbs at statement granularity.
  quantRecoverFirst(body: RuleExpr): Set<string> | null {
    const a = this.a;
    const unwrap = (x: RuleExpr): RuleExpr => {
      while (true) {
        if (x.type === 'group' && !(x.suppress && x.suppress.length)) { x = x.body; continue; }
        if (x.type === 'seq') {
          const real = x.items.filter(it => it.type !== 'op' && it.type !== 'prefix' && it.type !== 'postfix');
          if (real.length === 1) { x = real[0]; continue; }
        }
        return x;
      }
    };
    const expr = unwrap(body);
    const refFirst = (x: RuleExpr): Set<string> | null => {
      if (x.type !== 'ref' || !a.ruleByName.has(x.name)) return null;
      if (a.nullableRules.has(x.name)) return null;
      const fs = a.firstSets.get(x.name);
      return fs && fs.size > 0 ? fs : null;
    };
    if (expr.type === 'ref') return refFirst(expr);
    if (expr.type === 'alt') {
      const u = new Set<string>();
      for (const item of expr.items) {
        const fs = refFirst(unwrap(item));
        if (fs === null) return null;
        for (const k of fs) u.add(k);
      }
      return u.size > 0 ? u : null;
    }
    return null;
  }

  /**
   * Emit (once) a helper fn for a compound `expr` and return its name. The helper
   * has the matchExpr contract: returns the matched children array or null, with pos
   * restored on failure. Using a function (not inlined statements) means failure is a
   * `return null` and loops use `return`, so nested compounds never have a `break`
   * that escapes to the wrong loop — the one real hazard of inlining the tree-walk.
   */
  private matchFn(expr: RuleExpr): string {
    const key = JSON.stringify(expr);
    const existing = this.helpers.get(key);
    if (existing) return existing;
    const name = `m${this.helpers.size}`;
    this.helpers.set(key, name);
    const body: string[] = [`function ${name}() {`];
    const single = this.singleLeafBody(expr);
    if (single) {
      // Matcher produces exactly one child: the matcher call already pushes it —
      // no save needed (a failing single matcher consumes nothing).
      body.push(single);
    } else {
      body.push(`  const _save = pos; const _sn = scn;`);
      body.push(this.matchInto(expr, `pos = _save; scn = _sn; return false;`));
      body.push(`  return true;`);
    }
    body.push(`}`);
    this.helperDefs.push(body.join('\n'));
    return name;
  }

  // Public wrapper so free-function emitters (emitArmNamed) can reuse the single-leaf
  // specialization.
  singleLeafBodyPublic(expr: RuleExpr): string | null { return this.singleLeafBody(expr); }

  // If `expr` matches exactly one child (a single literal, a single non-template token
  // ref, or a single rule ref — possibly wrapped in a transparent group / one-item seq),
  // return a body that just delegates to the (already pushing) matcher call — skipping
  // the save/restore (a failing single matcher consumes nothing and pushes nothing).
  // Else null. Excludes template-token refs (two-branch) and suppress-groups.
  private singleLeafBody(expr: RuleExpr): string | null {
    const a = this.a;
    // Unwrap transparent wrappers that don't themselves emit/consume.
    while (true) {
      if (expr.type === 'group' && !(expr.suppress && expr.suppress.length)) { expr = expr.body; continue; }
      if (expr.type === 'seq') {
        const real = expr.items.filter(it => it.type !== 'op' && it.type !== 'prefix' && it.type !== 'postfix');
        if (real.length === 1) { expr = real[0]; continue; }
      }
      break;
    }
    if (expr.type === 'literal') {
      return `  return ${this.matchLiteralCall(expr.value)};`;
    }
    if (expr.type === 'ref') {
      if (a.tokenNames.has(expr.name)) {
        if (a.templateTokenNames.has(expr.name)) return null;   // two-branch (template) — not single-leaf
        return `  return ${this.matchTokenCall(expr.name)};`;
      }
      // Rule ref: keep the FIRST-set guard, then the call.
      const guard = this.firstGuard(expr.name);
      const guardLine = guard ? `  if (${guard}) { return false; }\n` : '';
      return `${guardLine}  return ${this.ruleFn(expr.name)}();`;
    }
    return null;
  }

  /**
   * Generate statements that match `expr`, PUSHING children onto the scratch stack
   * (the arena protocol — every matcher/rule call pushes its own result), and on any
   * failure execute `onFail` (which restores pos + scn and returns). Simple/flat
   * shapes are INLINED here (specialized straight-line code, no matchExpr switch);
   * compound shapes (alt / quantifier / sep / nested seq with a contained loop)
   * delegate to a generated helper fn via matchFn — keeping control flow `return`-based.
   */
  matchInto(expr: RuleExpr, onFail: string): string {
    const a = this.a;
    switch (expr.type) {
      case 'literal': {
        const vs = this.vsetNext;
        this.vsetNext = 0;
        return `if (!${this.matchLiteralCall(expr.value, vs)}) { ${onFail} }`;
      }
      case 'ref': {
        if (a.tokenNames.has(expr.name)) {
          // Template tokens: route to parseTemplateExpr first (interpolated templates).
          if (a.templateTokenNames.has(expr.name)) {
            return `if (!parseTemplateExpr() && !${this.matchTokenCall(expr.name)}) { ${onFail} }`;
          }
          return `if (!${this.matchTokenCall(expr.name)}) { ${onFail} }`;
        }
        // Rule ref: FIRST-set guard (ruleMightStart) baked as a direct check, then call.
        const guard = this.firstGuard(expr.name);
        return [
          guard ? `if (${guard}) { ${onFail} }` : ``,
          `if (!${this.ruleFn(expr.name)}()) { ${onFail} }`,
        ].filter(Boolean).join('\n');
      }
      case 'seq': {
        // Inline each item in order; share the caller's onFail (which restores to the
        // seq's save point). matchSeq skips op/prefix/postfix markers. A nested seq is
        // flattened inline too — its failure restores to the SAME save point (the whole
        // matcher fn's _save), exactly like matchSeq's single saved/restore.
        const parts: string[] = [];
        for (let i = 0; i < expr.items.length; i++) {
          const item = expr.items[i];
          if (item.type === 'op' || item.type === 'prefix' || item.type === 'postfix') continue;
          if (item.type === 'quantifier') {
            const nx = expr.items[i + 1];
            this.quantFollowT = nx !== undefined && nx.type === 'literal' ? this.litT(nx.value) : -1;
          }
          if (item.type === 'literal') this.vsetNext = this.vsetFor(expr.items, i);
          parts.push(this.matchInto(item, onFail));
          this.quantFollowT = -1;
        }
        return parts.join('\n');
      }
      case 'alt': {
        // matchExpr 'alt': try each arm (a helper fn) from a shared save; first
        // success wins — its children are already on scratch.
        const save = this.id(), sn = this.id(), r = this.id();
        const lines: string[] = [`const ${save} = pos; const ${sn} = scn;`, `let ${r} = false;`];
        for (const item of expr.items) {
          const fn = this.matchFn(item);
          lines.push(`if (!${r}) { pos = ${save}; scn = ${sn}; ${r} = ${fn}(); }`);
        }
        lines.push(`if (!${r}) { pos = ${save}; scn = ${sn}; ${onFail} }`);
        return lines.join('\n');
      }
      case 'quantifier':
        {
          const closerT = this.quantFollowT;
          this.quantFollowT = -1;
          return this.matchQuantifierInto(expr.body, expr.kind, onFail, closerT);
        }
      case 'group': {
        // A suppress-carrying group stages the LED-connector exclusion for the next
        // parseRule, then matches its body (same as matchExpr 'group').
        const pre = (expr.suppress && expr.suppress.length)
          ? `suppressNext = new Set<string>(${J(expr.suppress)});`
          : ``;
        return [pre, this.matchInto(expr.body, onFail)].filter(Boolean).join('\n');
      }
      case 'not': {
        // Zero-width negative lookahead: succeed (no children) iff body does NOT match.
        const kinds = this.notKwKinds(expr.body);
        if (kinds) {
          // Fast: one keyword-kind membership test (no body matcher, nothing pushed).
          const cond = kinds.map(k => `_tt === ${k}`).join(' || ');
          return `if (pos < cap && tkK[pos] >= K_NAMED_MIN) { const _tt = tkT[pos]; if (${cond}) { ${onFail} } }`;
        }
        const save = this.id(), sn = this.id(), fn = this.matchFn(expr.body), m = this.id();
        return [
          `{ const ${save} = pos; const ${sn} = scn; probing++; const ${m} = ${fn}(); probing--; pos = ${save}; scn = ${sn};`,
          `  if (${m}) { ${onFail} } }`,
        ].join('\n');
      }
      case 'sameLine':
        return `if (!(pos < cap && (tkFl[pos] & 1) === 0)) { ${onFail} }`;
      case 'noCommentBefore':
        return `if (!(pos < cap && (tkFl[pos] & 2) === 0)) { ${onFail} }`;
      case 'noMultilineFlowBefore':
        return `if (!(pos < cap && (tkFl[pos] & 4) === 0)) { ${onFail} }`;
      case 'notLeftLeaf':
        // The head-leaf LED gate is applied in the Pratt LED loop (not here); the marker is
        // stripped from the LED arm's items, so it never reaches the matcher. As a leaf-position
        // no-op it consumes nothing and succeeds (matches the empty string).
        return ``;
      case 'sep':
        return this.matchSepInto(expr.element, expr.delimiter, onFail);
      default:
        // op/prefix/postfix — handled by Pratt; in matchExpr these return null.
        return `{ ${onFail} }`;
    }
  }

  // Quantifier: body is matched via a helper fn (pushes + boolean), so the loop here
  // uses `return`/`break` only against ITS OWN while — no nested-loop hazard.
  private quantFollowT = -1;
  litT(value: string): number { return -1; }   // bound by emitParser to the punct-literal table

  // ── Viable-set companions (diagnostics) ──
  // For a REQUIRED literal C in a seq, the literals PROVABLY still accepted when
  // C's matcher fails: walking backward from C, a repetition ('*'/'+') is always
  // re-enterable so its nullable-prefix-reachable literals stay viable; nullable
  // one-shot items ('?' optionals, nullable groups, sep, zero-width markers) are
  // crossed but contribute nothing (they may already have consumed their match);
  // the first non-nullable item stops the walk. "expected ',' or ']'" therefore
  // never names an impossible continuation — unlike a static FIRST union, which
  // after `[1, 2` would still claim an expression. Each distinct message gets one
  // id, threaded through the matcher into the $missing row (settle decodes it).
  private vsetNext = 0;
  vsetMsgs: string[] = [''];
  private vsetIds = new Map<string, number>();
  private nullPrefixLits(x: RuleExpr, acc: Set<string>): boolean {   // → nullable (crossable)?
    switch (x.type) {
      case 'literal': acc.add(x.value); return false;
      case 'seq': { for (const it of x.items) if (!this.nullPrefixLits(it, acc)) return false; return true; }
      case 'group': return this.nullPrefixLits(x.body, acc);
      case 'quantifier': { this.nullPrefixLits(x.body, acc); return x.kind !== '+'; }
      case 'alt': { let all = true; for (const it of x.items) if (!this.nullPrefixLits(it, acc)) all = false; return all; }
      case 'ref': return false;   // conservative: treat rules as non-nullable
      case 'sep': return true;
      default: return true;       // zero-width markers / Pratt position markers
    }
  }
  private vsetFor(items: RuleExpr[], k: number): number {
    const item = items[k];
    if (item.type !== 'literal') return 0;
    const comp = new Set<string>();
    for (let j = k - 1; j >= 0; j--) {
      const pj = items[j];
      if (pj.type === 'op' || pj.type === 'prefix' || pj.type === 'postfix') continue;
      if (pj.type === 'quantifier' && pj.kind !== '?') { this.nullPrefixLits(pj.body, comp); continue; }
      if (pj.type === 'quantifier' || pj.type === 'sep' || pj.type === 'not' || pj.type === 'sameLine' || pj.type === 'noCommentBefore') continue;
      if (pj.type === 'group' && this.nullPrefixLits(pj.body, new Set())) continue;
      break;
    }
    comp.delete(item.value);
    if (comp.size === 0) return 0;
    const msg = [...comp, item.value].map(v => "'" + v + "'").join(' or ');
    let id = this.vsetIds.get(msg);
    if (id === undefined) { id = this.vsetMsgs.length; this.vsetMsgs.push(msg); this.vsetIds.set(msg, id); }
    return id;
  }
  private matchQuantifierInto(body: RuleExpr, kind: '*' | '+' | '?', onFail: string, closerT = -1): string {
    const fn = this.matchFn(body);
    if (kind === '?') {
      // Try once; on failure the helper restored pos/scn itself. The probe guard
      // keeps synthesis out of UNCOMMITTED optional paths, tsc-style: before the
      // group consumes a real token its failure is free (no synthesis); once it
      // has consumed (pos > probeBase) the group is committed — 'const a = ;'
      // must synthesize the initializer Expr, not drop the whole '= Expr' group.
      return `{ const _pb = probeBase; probeBase = pos; ${fn}(); probeBase = _pb; }`;
    }
    // Run-extension: after an iteration whose element was ADOPTED from the old tree,
    // bulk-adopt its following old siblings (runExtend) instead of re-entering the
    // rule machinery once per element. Only loops over a parseRuleEntry-routed rule
    // get the hook, and runExtend re-checks rid + generation, so an inner rule's
    // adoption can never feed elements into an outer loop.
    //
    // The same loops are the RECOVERY sync points: in recovering mode (second pass,
    // entered only after the strict parse rejected) a failing element absorbs tokens
    // into an $error node up to the element's FIRST set / a closer / EOF and the
    // loop continues — strict-mode behavior is byte-identical (the hook is gated on
    // `recovering`, and a SUCCEEDING rule parses identically in both modes).
    const runInfo = this.quantRunInfo(body);
    const runId = runInfo === null ? -1 : runInfo.rid;
    const ext = runId >= 0 ? `\n  if (adoptRunPos === pos) runExtend(${runId});` : '';
    const recFirst = this.quantRecoverFirst(body);
    const csFn = recFirst !== null ? this.membershipFn(recFirst) : 'null';
    // The element's LEADING token is the loop's continuation decision — its
    // failure is a normal list end, so synthesis is suppressed until the element
    // commits (consumes past the iteration start): rep(seq(',', Expr)) must not
    // mint a phantom ',' to keep the list going, but once the real ',' is there
    // a missing Expr synthesizes (tsc list-element semantics). Same commitment
    // device as the optional-probe guard, staged inline (hot loop — no closure).
    const failFor = (beforeV: string, bsnV: string) => recFirst !== null
      ? `const ${beforeV}_pb = probeBase; probeBase = pos; const ${beforeV}_fm = frameMax; frameMax = pos; const ${beforeV}_ok = ${fn}(); probeBase = ${beforeV}_pb; const ${beforeV}_re = frameMax; if (${beforeV}_fm > frameMax) frameMax = ${beforeV}_fm;\n  if (!${beforeV}_ok) { if (!recovering || !recoverSkip(${csFn}, ${closerT}, ${beforeV}, ${beforeV}_re)) break; continue; }\n  if (recovering && pos === ${beforeV}) { scn = ${bsnV}; if (!recoverSkip(${csFn}, ${closerT}, ${beforeV}, ${beforeV}_re)) break; continue; }`
      : `const ${beforeV}_pb = probeBase; probeBase = pos; const ${beforeV}_ok = ${fn}(); probeBase = ${beforeV}_pb;\n  if (!${beforeV}_ok) break;`;
    if (kind === '*') {
      const before = this.id(), bsn = this.id();
      return [
        `while (true) {`,
        `  const ${before} = pos; const ${bsn} = scn;`,
        `  ${failFor(before, bsn)}`,
        `  if (pos === ${before}) { scn = ${bsn}; break; }` + ext,
        `}`,
      ].join('\n');
    }
    // '+': first mandatory, then the same loop.
    const before = this.id(), bsn = this.id();
    return [
      `if (!${fn}()) { ${onFail} }`,
      `while (true) {`,
      `  const ${before} = pos; const ${bsn} = scn;`,
      `  ${failFor(before, bsn)}`,
      `  if (pos === ${before}) { scn = ${bsn}; break; }` + ext,
      `}`,
    ].join('\n');
  }

  // sep = (element (delimiter element)*)?  — never fails (matches zero elements).
  // element matched via helper fn. A delimiter with no following element stays kept
  // (trailing-delimiter semantics) — it was already pushed by its matcher.
  private matchSepInto(element: RuleExpr, delimiter: string, _onFail: string): string {
    const fn = this.matchFn(element);
    return [
      `if (${fn}()) {`,
      `  while (true) {`,
      `    const _ds = pos; probing++; const _dm = ${this.matchLiteralCall(delimiter)}; probing--; if (!_dm) { pos = _ds; break; }`,
      `    if (!${fn}()) break;`,
      `  }`,
      `}`,
    ].join('\n');
  }

  // Baked FIRST-set guard for a rule ref: the NEGATED ruleMightStart condition (so
  // the caller writes `if (<guard>) { onFail }`). Returns '' when the rule can always
  // start (nullable / null FIRST set) → no guard (matches ruleMightStart returning true).
  firstGuard(name: string): string {
    const a = this.a;
    if (a.nullableRules.has(name)) return '';
    const fs = a.firstSets.get(name);
    if (!fs || fs.size === 0) return '';
    // ruleMightStart: true iff some key in fs matches peek(); guard = NOT that. The set
    // is baked as a per-set membership fn over two byte tables (see membershipFn).
    // Recovering runs skip the guard: at a bar the next token is exactly what CANNOT
    // start the rule, and the missing-nonterminal hook lives inside parseRuleEntry —
    // a pre-call rejection would silence it ('a, ;' must mint the Expr, not end the
    // list). Strict pays one global read only when the guard would fail anyway.
    return `(!${this.membershipFn(fs)}(pos) && !recovering)`;
  }

  // Deep per-alternative dispatch condition (mirrors gen-parser.ts altMightStart): the
  // POSITIVE "this alt might start at startTok" test for the longest-match loops. `true`
  // when the alt is nullable or its FIRST set is unknown/empty (always tried — an empty
  // match never wins longest-match); else a membership test over the alt's transitive
  // FIRST set, baked as a hoisted int-descriptor array (same encoding firstGuard uses).
  altGuard(alt: RuleExpr): string {
    const a = this.a;
    if (a.altNullable.get(alt)) return 'true';
    const fs = a.altDeepFirst.get(alt);
    if (!fs || fs.size === 0) return 'true';
    return `${this.membershipFn(fs)}(saved)`;
  }

  // A `not(...)` over a literal / alternation of KEYWORD literals → the int keyword-kinds,
  // else null. Lets the not be one membership test instead of matching each keyword arm
  // (mirrors gen-parser.ts notKwSet; emits the same check matchKwLit uses, so byte-identical).
  notKwKinds(body: RuleExpr): number[] | null {
    const kinds: number[] = [];
    const collect = (e: RuleExpr): boolean =>
      e.type === 'literal' ? (isKeywordLiteral(e.value) ? (kinds.push(this.a.symtab.kwLitKind.get(e.value)!), true) : false)
        : e.type === 'alt' ? e.items.every(collect)
        : false;
    return collect(body) && kinds.length > 0 ? kinds : null;
  }

  // Register (deduped) a FIRST-set's membership test as a module-level fn over two
  // byte tables and return the fn's NAME. Test: `!tok || (KT[tok.k] | TT[tok.t])` —
  // faithful to the old per-desc loop because the kw int range and the punct int range
  // are DISJOINT (so the loop's k!==K_PUNCT / k===K_PUNCT guards were redundant), and
  // a punct desc's text.startsWith(v) arm is enumerated over the closed punct
  // vocabulary at emit time. The one narrowing: a K_PUNCT token whose text is OUTSIDE
  // the vocabulary (t=0) can't startsWith-match here — such a token is unreachable
  // (the lexer scans only vocabulary puncts; `>`-split rests stay in-vocabulary),
  // and the full-corpus byte-identical gate covers it empirically.
  membershipFn(fs: Set<string>): string {
    const { kArr, tArr } = this.membershipTables(fs);
    const fnKey = `${kArr}|${tArr}`;
    let nm = this.memberFns.get(fnKey);
    if (!nm) {
      nm = `_q${this.memberFns.size}`;
      this.memberFns.set(fnKey, nm);
      this.helperDefs.push(`function ${nm}(i: number) { return i >= cap || (${kArr}[tkK[i]] | ${tArr}[tkT[i]]) !== 0; }`);
    }
    return nm;
  }

  // The first-token gate for an alt/LED whose tok is already known non-null: the same
  // two-table membership as membershipFn, open-coded (no call). null FirstTok → no gate.
  ftCond(ft: FirstTok, idxVar: string): string | null {
    if (!ft) return null;
    const key = 'tok' in ft ? ft.tok : ft.lit;
    const { kArr, tArr } = this.membershipTables(new Set([key]));
    return `(${kArr}[tkK[${idxVar}]] | ${tArr}[tkT[${idxVar}]]) !== 0`;
  }

  // A FIRST set's admitted (tok.k, tok.t) index sets — the shared classification behind
  // the byte tables and the alt-dispatch masks (same split keyMatchesTok used).
  private firstSetOnes(fs: Set<string>): { kOnes: Set<number>; tOnes: Set<number> } {
    const st = this.a.symtab;
    const kOnes = new Set<number>(), tOnes = new Set<number>();
    for (const key of [...fs].sort()) {
      const q = this.a.qualKeys.get(key);
      if (q) {
        // Reserved-qualified token key: admit by t instead of the blanket k-bit —
        // t=0 (covers plain members of the token class; over-admits other t=0 kinds
        // harmlessly) plus every keyword t outside the guard class.
        tOnes.add(0);
        for (const [text, id] of st.kwLitKind) if (!q.except.has(text)) tOnes.add(id);
        continue;
      }
      const d = st.classifyKey(key);
      if (d.kind === 'tok') {
        kOnes.add(d.k);
        if (d.template) kOnes.add(st.KIND_TEMPLATE_HEAD);
      } else if (d.kind === 'kw') {
        if (d.t === 0) throw new Error(`emit: FIRST key ${J(key)} missing from the literal vocabulary`);
        tOnes.add(d.t);
      } else {
        if (d.t === 0) throw new Error(`emit: FIRST key ${J(key)} missing from the literal vocabulary`);
        for (const [text, id] of st.puLitKind) if (text.startsWith(d.v)) tOnes.add(id);
      }
    }
    return { kOnes, tOnes };
  }

  private kSize(): number { return this.a.symtab.KIND_NAMED_FALLBACK + 1; }
  private tSize(): number {
    const st = this.a.symtab;
    let n = 1;
    for (const v of st.kwLitKind.values()) n = Math.max(n, v + 1);
    for (const v of st.puLitKind.values()) n = Math.max(n, v + 1);
    return n;
  }

  // Build (deduped) the two byte tables for a FIRST set's membership test.
  private membershipTables(fs: Set<string>): { kArr: string; tArr: string } {
    const { kOnes, tOnes } = this.firstSetOnes(fs);
    return {
      kArr: this.u8Const(this.kSize(), [...kOnes].sort((a, b) => a - b)),
      tArr: this.u8Const(this.tSize(), [...tOnes].sort((a, b) => a - b)),
    };
  }

  // Per-alternative dispatch masks for a longest-match alt list (one bit per alt):
  //   mask = startTok ? KM[startTok.k] | TM[startTok.t] : ALL
  // and each alt's guard is one bit test — replacing a per-alt membership call with a
  // shared pair of loads. Bit i is set exactly where altGuard(alt_i) is true: an
  // always-tried alt (nullable / unknown-FIRST) has its bit in every k slot, and a null
  // lookahead (EOF) admits every alt, mirroring the per-alt guards' !tok → true.
  //
  // Lists over 32 alts span MULTIPLE mask words (one table pair + one local per word;
  // alt i lives in word i>>5, bit i&31) — there is deliberately NO arm-count ceiling:
  // a single-word cap silently dropped a rule back to serial per-alt guards the moment
  // a grammar widening pushed it past 32 (R_Type crossed at 33 and cost ~25% whole-parse
  // until the cliff was found), and dispatch must degrade smoothly, not cliff.
  // null only when the list is too small for the tables to pay.
  altMaskDispatch(alts: RuleExpr[], maskVar: string): { maskInit: string; bit: (i: number) => string } | null {
    if (alts.length < 3) return null;
    const a = this.a;
    const words = Math.ceil(alts.length / 32);
    const wVar = (w: number) => (words === 1 ? maskVar : `${maskVar}_w${w}`);
    const kMask = Array.from({ length: words }, () => new Array<number>(this.kSize()).fill(0));
    const tMask = Array.from({ length: words }, () => new Array<number>(this.tSize()).fill(0));
    const all = new Array<number>(words).fill(0);
    alts.forEach((alt, i) => {
      const w = i >> 5;
      const bit = (1 << (i & 31)) | 0;
      all[w] |= bit;
      const fs = a.altDeepFirst.get(alt);
      if (a.altNullable.get(alt) || !fs || fs.size === 0) {
        for (let k = 0; k < kMask[w].length; k++) kMask[w][k] |= bit;
        return;
      }
      const { kOnes, tOnes } = this.firstSetOnes(fs);
      for (const k of kOnes) kMask[w][k] |= bit;
      for (const t of tOnes) tMask[w][t] |= bit;
    });
    // SECOND-token refinement: drop an admitted alt when the actual second token can't
    // be its second token and it can't end after one. An alt with unknown/len1/nullable
    // SECOND keeps its bit everywhere (and in the EOF-after-one mask `alw2`). Sound:
    // a pruned arm needs a second token it provably can't accept — it would fail.
    // (The '>'-split is covered: a '>' SECOND key sets every '>'-led punct bit via
    // firstSetOnes' startsWith expansion, so post-splice second tokens stay admitted.)
    const k2Mask = Array.from({ length: words }, () => new Array<number>(this.kSize()).fill(0));
    const t2Mask = Array.from({ length: words }, () => new Array<number>(this.tSize()).fill(0));
    const alw2 = new Array<number>(words).fill(0);
    let refines = false;
    alts.forEach((alt, i) => {
      const w = i >> 5;
      const bit = (1 << (i & 31)) | 0;
      const sec = a.altSecond.get(alt);
      // The always conditions MIRROR gen-parser's altMightSecond null-keys cases
      // exactly (incl. empty-set → always) — engine-identical prune decisions.
      if (a.altNullable.get(alt) || !sec || sec.s === null || sec.len1 || sec.s.size === 0) {
        for (let k = 0; k < k2Mask[w].length; k++) k2Mask[w][k] |= bit;
        alw2[w] |= bit;
        return;
      }
      refines = true;
      const { kOnes, tOnes } = this.firstSetOnes(sec.s);
      for (const k of kOnes) k2Mask[w][k] |= bit;
      for (const t of tOnes) t2Mask[w][t] |= bit;
    });
    const inits: string[] = [];
    for (let w = 0; w < words; w++) {
      const kArr = this.u32Const(kMask[w]);
      const tArr = this.u32Const(tMask[w]);
      if (!refines) {
        inits.push(`const ${wVar(w)} = saved < tokN ? (${kArr}[tkK[saved]] | ${tArr}[tkT[saved]]) : ${all[w]};`);
      } else {
        const k2Arr = this.u32Const(k2Mask[w]);
        const t2Arr = this.u32Const(t2Mask[w]);
        inits.push(`const ${wVar(w)} = saved < tokN ? ((${kArr}[tkK[saved]] | ${tArr}[tkT[saved]]) & (saved + 1 < cap ? (${k2Arr}[tkK[saved + 1]] | ${t2Arr}[tkT[saved + 1]]) : ${alw2[w]})) : ${all[w]};`);
      }
    }
    return {
      maskInit: inits.join(' '),
      bit: (i: number) => `${wVar(i >> 5)} & ${(1 << (i & 31)) | 0}`,
    };
  }

  // Bitmask dispatch over a list of first-TOKEN gates (the LED chain): the same mask
  // tables as altMaskDispatch, built from per-LED FirstTok keys (null ft = always
  // admitted); the lookahead is known non-null at the LED loop head. Multi-word over
  // 32 entries, same scheme as altMaskDispatch — no arm-count cliff.
  ftMaskDispatch(fts: FirstTok[], maskVar: string, tokVar: string): { maskInit: string; bit: (i: number) => string } | null {
    if (fts.length < 3) return null;
    const words = Math.ceil(fts.length / 32);
    const wVar = (w: number) => (words === 1 ? maskVar : `${maskVar}_w${w}`);
    const kMask = Array.from({ length: words }, () => new Array<number>(this.kSize()).fill(0));
    const tMask = Array.from({ length: words }, () => new Array<number>(this.tSize()).fill(0));
    fts.forEach((ft, i) => {
      const w = i >> 5;
      const bit = (1 << (i & 31)) | 0;
      if (!ft) { for (let k = 0; k < kMask[w].length; k++) kMask[w][k] |= bit; return; }
      const key = 'tok' in ft ? ft.tok : ft.lit;
      const { kOnes, tOnes } = this.firstSetOnes(new Set([key]));
      for (const k of kOnes) kMask[w][k] |= bit;
      for (const t of tOnes) tMask[w][t] |= bit;
    });
    const inits: string[] = [];
    for (let w = 0; w < words; w++) {
      inits.push(`const ${wVar(w)} = ${this.u32Const(kMask[w])}[tkK[${tokVar}]] | ${this.u32Const(tMask[w])}[tkT[${tokVar}]];`);
    }
    return {
      maskInit: inits.join(' '),
      bit: (i: number) => `${wVar(i >> 5)} & ${(1 << (i & 31)) | 0}`,
    };
  }

  // A deduped Int32Array const (the per-rule alt-dispatch mask tables).
  private u32Const(values: number[]): string {
    const key = values.join(',');
    let nm = this.u32Consts.get(key);
    if (!nm) {
      nm = `_am${this.u32Consts.size}`;
      this.u32Consts.set(key, nm);
      this.helperDefs.push(`const ${nm} = Int32Array.from([${key}]);`);
    }
    return nm;
  }

  // A deduped Uint8Array const with 1s at `ones` (the byte tables behind membershipFn).
  private u8Const(size: number, ones: number[]): string {
    const key = `${size}:${ones.join(',')}`;
    let nm = this.u8Consts.get(key);
    if (!nm) {
      if (!this.u8Emitted) {
        this.helperDefs.push(`function u8(n: number, ones: number[]) { const a = new Uint8Array(n); for (let i = 0; i < ones.length; i++) a[ones[i]] = 1; return a; }`);
        this.u8Emitted = true;
      }
      nm = `_qb${this.u8Consts.size}`;
      this.u8Consts.set(key, nm);
      this.helperDefs.push(`const ${nm} = u8(${size}, [${ones.join(',')}]);`);
    }
    return nm;
  }

  // ── Lever 1 emit helpers ──
  // Specialized literal matcher call: keyword → matchKwLit, punct → matchPuLit, each
  // with the value's baked int (so the runtime does int compares, not string work).
  // vs > 0 = this call site's viable-set id (companion literals provably still
  // accepted when the match fails — threaded into the synthesized $missing row).
  matchLiteralCall(value: string, vs = 0): string {
    const d = this.a.symtab.classifyKey(value);
    const va = vs > 0 ? `, ${vs}` : '';
    if (d.kind === 'kw') return `matchKwLit(${d.t}${va})`;
    if (d.kind === 'punct') return value === '>' ? `matchPuLitGT(${d.t}${va})` : `matchPuLit(${d.t}${va})`;
    // A literal key that classifies as a token-name (a token name used as a literal):
    // unreachable for real grammars, but stay safe via the generic matchLiteral.
    return `matchLiteral(${J(value)})`;
  }
  // Specialized token matcher call: tok.k === <name kind>.
  matchTokenCall(name: string): string {
    const k = this.a.symtab.typeKind.get(name);
    return k === undefined ? `matchLiteral(${J(name)})` : `matchTokK(${k})`;
  }
}

// ── Top-level emit ──

// The `js` Target: the optimized SoA-int parser/lexer, wrapped behind the same two-method
// Target contract as the portable ts/go/rust targets (see emit.ts). `emitJsLexer` derives the
// standalone lexer; `emitJsParser` embeds whatever lexer source it is handed. Splitting the
// lexer COMPUTATION from its EMBEDDING leaves the emitted bytes identical (both re-derive the
// same deterministic symtab), so `emit-parser-verify` stays byte-for-byte.
export const jsTarget: Target = {
  name: 'javascript',
  ext: 'js',
  emitLexer: emitJsLexer,
  emitParser: emitJsParser,
};

export function emitJsLexer(grammar: CstGrammar): string | null {
  grammar = withAwaitYield(grammar);
  const st = analyze(grammar).symtab;
  return emitSoaLexer(grammar, {
    typeKind: st.typeKind, kwLitKind: st.kwLitKind, puLitKind: st.puLitKind,
    KIND_PUNCT: st.KIND_PUNCT, KIND_NAMED_FALLBACK: st.KIND_NAMED_FALLBACK,
  });
}

export function emitJsParser(grammar: CstGrammar, lexSrc: string | null): string {
  // [Await]/[Yield] context: name-fork the body-reachable rule closure into $A/$Y/$AY
  // families (see await-yield-fork.ts). No-op for a grammar with no ctx markers. Done
  // HERE (not at grammar export) so the forks exist ONLY in the parser's rule identity
  // / memo / adoption space; the derived-artifact generators see the base grammar with
  // the (transparent-group) markers and emit byte-identically.
  grammar = withAwaitYield(grammar);
  const a = analyze(grammar);
  const e = new Emitter(a);
  e.litT = (v: string) => a.symtab.puLitKind.get(v) ?? -1;
  const entry = findEntryRule(grammar);

  // Grammar-lite for the lexer: ONLY what createLexer reads (tokens, precs, the
  // literals via rules, markup, indent). We bake the token/precs/markup/indent DATA
  // and replace `rules` with ONE synthetic rule whose body is an `alt` of every
  // literal the real rules contribute — so createLexer's `allLiterals` set (and thus
  // its punctuation table) is identical, without baking the grammar definition.
  const allLits = new Set<string>();
  for (const rule of grammar.rules) for (const l of collectLiterals(rule.body)) allLits.add(l);
  const litRuleBody: RuleExpr = { type: 'alt', items: [...allLits].map(v => ({ type: 'literal', value: v } as RuleExpr)) };
  const lexGrammar = {
    tokens: grammar.tokens,
    precs: grammar.precs,
    rules: [{ name: '$lits', body: litRuleBody, flags: [] }],
    markup: grammar.markup,
    indent: grammar.indent,
    newline: grammar.newline,
    scopeOverrides: [],
  };

  // ── Header: imports + baked tables + grammar-lite ──
  e.emit(`// GENERATED by src/emit-parser.ts — do not edit. Specialized parser for grammar ${J(grammar.name ?? '')}.`);
  // The lexer: EMITTED (specialized, standalone — see emit-lexer.ts) when the grammar
  // is a plain token stream; the data-driven createLexer runtime otherwise
  // (markup/indent/newline state machines stay interpreter-only).
  // `lexSrc` is handed in by the Target façade (emitParser reuses emitLexer) — see emit.ts.
  const st = a.symtab;
  e.soa = lexSrc !== null;
  if (!lexSrc) {
    e.emit(`import { createLexer } from ${J(resolveLexerImport())};`);
    e.emit(``);
    e.emit(`const LEX_GRAMMAR = ${J(lexGrammar)};`);
  }
  e.emit(``);
  // ── Lever 1: integer token-kind tables (see analyze()'s symtab) ──
  // TYPE_KIND: tok.type → int. LIT_KW / LIT_PU: tok.text → keyword / punct literal int.
  // Every token is BORN with tok.k (type kind) + tok.t (literal kind) and the stamp
  // flags — one monomorphic shape, one allocation, no post-pass.
  e.emit(`const TYPE_KIND = new Map<string, number>(${J([...st.typeKind])});`);
  e.emit(`const LIT_KW = new Map<string, number>(${J([...st.kwLitKind])});`);
  e.emit(`const LIT_PU = new Map<string, number>(${J([...st.puLitKind])});`);
  e.emit(`const K_PUNCT = ${st.KIND_PUNCT};`);
  e.emit(`const K_TEMPLATE_HEAD = ${st.KIND_TEMPLATE_HEAD};`);
  e.emit(`const K_TEMPLATE_MIDDLE = ${st.KIND_TEMPLATE_HEAD + 1};`);
  e.emit(`const K_TEMPLATE_TAIL = ${st.KIND_TEMPLATE_HEAD + 2};`);
  e.emit(`const K_NAMED_MIN = ${st.KIND_NAMED_MIN};`);
  e.emit(`const K_NAMED_FALLBACK = ${st.KIND_NAMED_FALLBACK};`);
  // The template token's own kind (-1 when the grammar has no template token).
  e.emit(`const K_TPL_TOKEN = ${a.templateTokenName ? st.typeKind.get(a.templateTokenName) : -1};`);
  e.emit(``);
  if (lexSrc) {
    e.emit(lexSrc);
  } else {
    e.emit(`const { tokenize } = createLexer(LEX_GRAMMAR as any, {`);
    e.emit(`  typeKind: TYPE_KIND, kwLit: LIT_KW, puLit: LIT_PU,`);
    e.emit(`  punctKind: K_PUNCT, namedFallback: K_NAMED_FALLBACK,`);
    e.emit(`});`);
  }
  e.emit(``);
  // Baked maps. Emit as object literals → Map.
  e.emit(`const opTable = new Map<string, any>(${J([...a.opTable])});`);
  e.emit(`const prefixOps = new Map<string, any>(${J([...a.prefixOps])});`);
  // The same op tables re-keyed by the literal int (tok.t): the Pratt loops look an
  // operator up for EVERY token they reach, and tok.t is already interned — an array
  // load replaces the string-keyed Map.get. Equivalent because a token's text can equal
  // an operator value only for punct tokens and keyword-shaped idents, exactly the
  // classes tok.t indexes (operator values are in the literal vocabulary by construction).
  {
    let tSize = 1;
    for (const v of st.kwLitKind.values()) tSize = Math.max(tSize, v + 1);
    for (const v of st.puLitKind.values()) tSize = Math.max(tSize, v + 1);
    const byT = (m: Map<string, unknown>) => {
      const arr: unknown[] = new Array(tSize).fill(null);
      for (const [value, info] of m) {
        const d = st.classifyKey(value);
        if (d.kind === 'tok' || d.t === 0) throw new Error(`emit: operator ${J(value)} missing from the literal vocabulary`);
        arr[d.t] = info;
      }
      return arr;
    };
    e.emit(`type OpInfo = { lbp: number; rbp: number; assoc: string; position: string; requireTarget?: boolean };`);
    e.emit(`const OP_BY_T: (OpInfo | null)[] = ${J(byT(a.opTable))};`);
    e.emit(`const PREFIX_BY_T: (OpInfo | null)[] = ${J(byT(a.prefixOps))};`);
  }
  e.emit(`const noUnaryLhsOps = new Set<string>(${J([...a.noUnaryLhsOps])});`);
  {
    let tSize = 1;
    for (const v of st.kwLitKind.values()) tSize = Math.max(tSize, v + 1);
    for (const v of st.puLitKind.values()) tSize = Math.max(tSize, v + 1);
    const nu = new Array<number>(tSize).fill(0);
    for (const v of a.noUnaryLhsOps) {
      const d = st.classifyKey(v);
      if (d.kind !== 'tok' && d.t > 0) nu[d.t] = 1;
    }
    e.emit(`const NOUNARY_T = Uint8Array.from([${nu.join(',')}]);`);
  }
  // Ops whose operand must be a valid assignment target (LHS) — byte-table for the LED
  // dispatch (a token's t equals an op value iff its t-int matches — vocabulary).
  {
    let tSize = 1;
    for (const v of st.kwLitKind.values()) tSize = Math.max(tSize, v + 1);
    for (const v of st.puLitKind.values()) tSize = Math.max(tSize, v + 1);
    const rt = new Array<number>(tSize).fill(0);
    for (const v of a.requireTargetOps) {
      const d = st.classifyKey(v);
      if (d.kind !== 'tok' && d.t > 0) rt[d.t] = 1;
    }
    e.emit(`const REQTGT_T = Uint8Array.from([${rt.join(',')}]);`);
  }
  e.emit(`const postfixOpValues = new Set<string>(${J([...a.postfixOpValues])});`);
  e.emit(`const binaryConnectors = new Set<string>(${J([...a.binaryConnectors])});`);
  // Assignment-target shape test (ECMAScript AssignmentTargetType): a node id is NOT a
  // valid LHS target iff its outermost form is a prefix-op (prefix-unary OR prefix-update
  // `++x`) — head kid is an operator-tag leaf in prefixOps — or a postfix-update (`x++`) —
  // tail kid is an operator-tag leaf in postfixOpValues. A parenthesized cover / member /
  // element / call / non-null tail has no operator-tag leaf at head or tail, so it passes.
  e.emit(`function _notTarget(lhs: number) {`);
  e.emit(`  const n = rowCount[lhs]; if (n === 0) return false;`);
  e.emit(`  const cs = rowStart[lhs];`);
  e.emit(`  const _h = kids[cs];`);
  e.emit(`  if (_h < 0 && ((~_h) & 3) === 2) {`);
  e.emit(`    const _ht = absTok[lhs] + ((~_h) >>> 2);`);
  e.emit(`    if (prefixOps.has(${e.soa ? 'docText(toff(_ht), tend(_ht))' : 'tkText[_ht]'})) return true;`);
  e.emit(`  }`);
  e.emit(`  const _t = kids[cs + n - 1];`);
  e.emit(`  if (_t < 0 && ((~_t) & 3) === 2) {`);
  e.emit(`    const _tt = absTok[lhs] + ((~_t) >>> 2);`);
  e.emit(`    if (postfixOpValues.has(${e.soa ? 'docText(toff(_tt), tend(_tt))' : 'tkText[_tt]'})) return true;`);
  e.emit(`  }`);
  // a binary / relational / conditional expression (`a + b`, `a in b`, `a as T`, …) is not a
  // LeftHandSideExpression: its MIDDLE child is a binary connector leaf. (Member `a.b` /
  // element `a[b]` have a PUNCT leaf there, a parenthesized cover has a NODE child, so those
  // pass — `(a + b) = c` via the cover is correctly accepted, like tsc.)
  e.emit(`  if (n >= 3) { const _m = kids[cs + 1]; if (_m < 0) { const _mt = absTok[lhs] + ((~_m) >>> 2); if (binaryConnectors.has(${e.soa ? 'docText(toff(_mt), tend(_mt))' : 'tkText[_mt]'})) return true; } }`);
  e.emit(`  return false;`);
  e.emit(`}`);
  // Head-leaf TEXT of a node: descend the LEFTMOST-child spine to the OUTERMOST leaf and return its
  // token text (the SAME head-leaf the _notTarget gate reads, generalized to recurse through child
  // nodes). Drives the notLeftLeaf LED gate: a node whose head leaf text is in the arm's word set
  // (e.g. `void`/`null`/`this` for the type `.` qualification) is not a valid LEFT operand of the
  // arm. A childless ($missing recovery) node returns '' (matches no word → the arm is not blocked).
  e.emit(`function _headLeafText(id: number) {`);
  e.emit(`  while (rowCount[id] > 0) {`);
  e.emit(`    const _hh = kids[rowStart[id]];`);
  e.emit(`    if (_hh >= 0) { id = _hh; continue; }`);
  e.emit(`    const _ht = absTok[id] + ((~_hh) >>> 2);`);
  e.emit(`    return ${e.soa ? 'docText(toff(_ht), tend(_ht))' : 'tkText[_ht]'};`);
  e.emit(`  }`);
  e.emit(`  return '';`);
  e.emit(`}`);
  e.emit(`const tokenNames = new Set<string>(${J([...a.tokenNames])});`);
  e.emit(`const templateTokenNames = new Set<string>(${J([...a.templateTokenNames])});`);
  e.emit(`const templateTokenName = ${J(a.templateTokenName ?? null)};`);
  e.emit(`const maxBp = ${a.maxBp};`);
  e.emit(`const ENTRY = ${J(entry)};`);
  // Rule-name table: rowRule stores the index; '$template' takes the slot after the
  // declared rules (parseTemplateExpr's synthetic node).
  e.emit(`const RULE_NAMES = ${J([...grammar.rules.map(r => r.name), '$template', '$error', '$missing'])};`);
  // DISPLAY names: an [Await]/[Yield] fork (RuleDecl.canon set) keeps its distinct
  // RULE_NAMES entry for memo/adoption rule identity, but REPORTS its base name as the
  // node's rule name so trees stay byte-identical to the base grammar. Identical to
  // RULE_NAMES when no rule is forked (the common case).
  e.emit(`const RULE_DISPLAY = ${J([...grammar.rules.map(r => r.canon ?? r.name), '$template', '$error', '$missing'])};`);
  e.emit(`const RID_TEMPLATE = ${grammar.rules.length};`);
  e.emit(`const RID_ERROR = ${grammar.rules.length + 1};`);
  e.emit(`const RID_MISSING = ${grammar.rules.length + 2};`);
  {
    // literal-int → text (for "expected 'x'" diagnostics on $missing rows)
    const inv: string[] = [];
    for (const [txt, t] of a.symtab.kwLitKind) inv[t] = txt;
    for (const [txt, t] of a.symtab.puLitKind) inv[t] = txt;
    e.emit(`const LIT_NAMES = ${J(Array.from(inv, (x) => x ?? ''))};`);
  }
  // (recovery sync closers are threaded per-loop from the enclosing seq — see
  // quantFollowT; a global closer table froze top-level recovery at any ']'.)
  e.emit(`const prattRuleNames = new Set<string>(${J([...a.prattRules])});`);
  // The expression rule the template-interpolation fallback (findExprRule) picks:
  // first pratt rule that isn't Type, in declaration order. Bake the resolved name.
  const exprRuleName = (() => {
    for (const r of grammar.rules) if (a.prattRules.has(r.name) && r.name !== 'Type') return r.name;
    return grammar.rules[0].name;
  })();
  e.emit(`const EXPR_RULE = ${J(exprRuleName)};`);
  e.emit(``);
  // Compound-matcher helper fns are spliced in here (after imports/tables).
  e.emit(`//\${HELPERS}`);
  e.emit(``);

  // ── Shared runtime (copied semantics from gen-parser.ts) ──
  emitRuntime(e);

  // ── Per-rule parse functions ──
  emitRuleFns(e, a);

  // ── parse() driver ──
  emitDriver(e, a, entry);

  return e.toString();
}

// The lexer + utils imports are resolved relative to where the emitted file is
// written. Callers write the emitted file and decide the path; by default we emit
// absolute file: paths to THIS repo's src so the emitted file works from anywhere
// (e.g. /tmp). resolveLexerImport returns that absolute specifier.
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
function resolveLexerImport(): string { return pathResolve(__dir, 'gen-lexer.ts'); }

// ── Runtime: the generic engine state + control loops, emitted verbatim ──
// These are copied from gen-parser.ts so their semantics are byte-identical. The
// ONLY change: where the interpreter called matchExpr(alt)/matchSeq(items) per arm,
// these call the GENERATED per-arm matcher functions (installed via the rule fns).
function emitRuntime(e: Emitter) {
  // Column element type: Uint8 when the kind/literal id spaces fit a byte (single-
  // sourced in analyze() so emitDriver's spare-buffer mirrors pick the same width).
  const K_ARR = e.a.kArr;
  const T_ARR = e.a.tArr;
  e.emit(String.raw`
// ── Token stream: struct-of-arrays (no per-token object, no eager text) ──
// tkK = type kind, tkT = literal kind, tkOff/tkEnd = source span, tkFl = stamp bits
// (1 newlineBefore, 2 commentBefore, 4 multilineFlowBefore). Token text is materialized
// only when a CST leaf is built. The arrays persist across parses (pointer-free, no
// write-barrier or pinning cost) and grow by doubling.
let tkK = new ${K_ARR}(4096);
let tkT = new ${T_ARR}(4096);
let tkOff = new Int32Array(4096);
let tkEnd = new Int32Array(4096);
let tkFl = new Uint8Array(4096);
// lexer-state depth records per token (windowed relex restart/resync safety):
// tkDp = template-interp stack depth, tkPd = paren-head stack depth, both AS RECORDED
// at the token's push (the convention per token kind is fixed by the lexer's code
// path; determinism is what the predicates rely on, depth-0 is the safe state).
let tkDp = new Uint8Array(4096);
let tkPd = new Uint16Array(4096);
let tkCap = 4096;
let tokN = 0;
// ── The DOCUMENT text layer ──
// The text lives as PIECES (flat string fragments): applying a change splits the
// covering pieces (O(1) SlicedString views — never a flatten) and splices the new
// text in, so a keystroke costs O(pieces), not the O(n) cons-flatten a slice+concat
// per edit forces in V8 (measured: ~1.2ms per edit on 9MB). docFlat caches the
// joined form for the cold paths that need one (errors, debug views); batch parses
// set it directly. Reads route through docChar/docText: flat fast path, piece
// lookup (cursor-cached) otherwise.
let docPieces: string[] | null = null;
let docPieceOff: number[] | null = null;
let docLen = 0;
let docFlat: string | null = null;
let docCur = 0;
function docLocate(i: number) {
  let k = docCur;
  const po = docPieceOff!;
  const n = po.length;
  if (k >= n || po[k] > i || (k + 1 < n && po[k + 1] <= i)) {
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (po[m] <= i) lo = m + 1; else hi = m; }
    k = lo - 1;
    docCur = k;
  }
  return k;
}
function docChar(i: number) {
  if (docFlat !== null) return docFlat.charCodeAt(i);
  const k = docLocate(i);
  return docPieces![k].charCodeAt(i - docPieceOff![k]);
}
function docText(a: number, b: number) {
  if (docFlat !== null) return docFlat.slice(a, b);
  if (b <= a) return '';
  let k = docLocate(a);
  const first = docPieces![k];
  const lo = a - docPieceOff![k];
  if (b - docPieceOff![k] <= first.length) return first.slice(lo, b - docPieceOff![k]);
  let out = first.slice(lo);
  k++;
  while (k < docPieces!.length && docPieceOff![k] < b) {
    const piece = docPieces![k];
    const need = b - docPieceOff![k];
    out += need >= piece.length ? piece : piece.slice(0, need);
    k++;
  }
  return out;
}
function flattenDoc() {
  if (docFlat === null) docFlat = docPieces!.join('');
  return docFlat;
}
function applyChange(start: number, end: number, text: string) {
  const ks = docLocate(start);
  const ke = docLocate(end > start ? end - 1 : start);
  const head = docPieces![ks].slice(0, start - docPieceOff![ks]);
  const tailPiece = end > start ? docPieces![ke] : docPieces![ks];
  const tailOff = end - docPieceOff![end > start ? ke : ks];
  const tail = tailPiece.slice(tailOff);
  const repl = [];
  if (head.length > 0) repl.push(head);
  if (text.length > 0) repl.push(text);
  if (tail.length > 0) repl.push(tail);
  docPieces!.splice(ks, (end > start ? ke : ks) - ks + 1, ...repl);
  // consolidate when fragmenting (amortized: a join every ≥256 edits)
  if (docPieces!.length > 256) {
    docPieces = [docPieces!.join('')];
  }
  docLen += text.length - (end - start);
  // rebuild offsets from the splice point (suffix offsets shifted anyway)
  if (docPieceOff!.length !== docPieces!.length) docPieceOff!.length = docPieces!.length;
  let off = ks > 0 && ks - 1 < docPieces!.length ? docPieceOff![ks - 1] + docPieces![ks - 1].length : 0;
  for (let k2 = ks > 0 ? ks : 0; k2 < docPieces!.length; k2++) {
    docPieceOff![k2] = off;
    off += docPieces![k2].length;
  }
  if (docPieces!.length === 1) docPieceOff![0] = 0;
  docCur = 0;
  docFlat = null;
}
// ── EOF-relative spans (incremental sessions) ──
// A token's tkOff/tkEnd may be stored EOF-RELATIVE (value − (srcLen + 1), strictly
// negative): the decode adds the CURRENT length back, so a pure suffix never needs
// the O(suffix) add-loop a char delta would otherwise force — updating srcLenP1 IS
// the shift. Values self-describe by sign, so mixed zones stay readable; negFrom
// only bounds where negatives may exist (the flip-band maintenance range). Batch
// parses are all-positive and the decode branch never fires.
let srcLenP1 = 1;
let negFrom = 0x7fffffff;
function toff(i: number) { const v = tkOff[i]; return v < 0 ? v + srcLenP1 : v; }
function tend(i: number) { const v = tkEnd[i]; return v < 0 ? v + srcLenP1 : v; }
${e.soa ? '' : 'let tkText: string[] = [];   // fallback-lexer text column (synthetic tokens are not source spans)'}
function growTok() {
  tkCap *= 2;
  const k = new ${K_ARR}(tkCap); k.set(tkK); tkK = k;
  const t = new ${T_ARR}(tkCap); t.set(tkT); tkT = t;
  const o = new Int32Array(tkCap); o.set(tkOff); tkOff = o;
  const e2 = new Int32Array(tkCap); e2.set(tkEnd); tkEnd = e2;
  const f = new Uint8Array(tkCap); f.set(tkFl); tkFl = f;
  const d = new Uint8Array(tkCap); d.set(tkDp); tkDp = d;
  const q = new Uint16Array(tkCap); q.set(tkPd); tkPd = q;
}

// ── CST arena: nodes are rows in parallel columns; leaves are TOKEN REFERENCES ──
// A node is an integer id (row index). A leaf needs no storage at all — the token
// columns above already hold its span; a kids entry encodes which token and HOW it
// was matched (the match path decides the materialized tokenType):
//   entry >= 0  → node id
//   entry <  0  → leaf: ~((tokenIndex << 2) | kind), kind 0 = type-derived
//                 ($punct / token name / template part), 1 = '$keyword', 2 = '$operator'
// Rows store ABSOLUTE offsets in this phase (the green {rel,len} re-base is the
// incremental round's move; flipping the stored form regenerates matchers only).
let rowRule = new Uint16Array(8192);    // rule id (index into RULE_NAMES)
let rowLen = new Int32Array(8192);
let rowTokLen = new Int32Array(8192);   // subtree token count
let rowStart = new Int32Array(8192);    // first index into kids
let rowCount = new Int32Array(8192);
// lookahead GAP: how far past its own first token the node's parse may have READ
// (ext − start, a length — position-independent like everything green). Adoption
// validity across edits compares q + rowExt + slack against the damage start.
let rowExt = new Int32Array(8192);
// adoption eligibility: set ONLY where the old parse MEMOIZED the node — a row built
// under a suppress (no-'in') or parseLimit-capped context is a context-dependent
// parse and must never be adopted into a normal entry (the memo carry never stored
// those; adoption must not widen the contract).
let rowOK = new Uint8Array(8192);
// kid-containment bit (lazy): 0 unknown, 1 = every kid's probe watermark stays
// at/below the next kid's start (so a prefix-keep check of the LAST kept kid
// transitively bounds all earlier ones), 2 = violated somewhere. Computed on
// first surgical use of a row, maintained across in-place splices.
let rowKC = new Uint8Array(8192);
// END-RELATIVE kid rels (incremental sessions): a ROW kid's kidTokRel/kidRel may be
// stored relative to the parent's END (value − (parentLen + 1), strictly negative);
// the decode adds the parent's CURRENT length back. A surgical splice then shifts
// the whole suffix by updating the parent's lengths — no per-kid add-loop — and the
// values stay correct as long as the parent row is unedited (only surgery changes a
// row's lengths, and it maintains its own band). Leaf kids pack their rel inside the
// kids value and always stay start-relative (the trailing-leaf walk shifts them
// eagerly). rowNF = first kid index (absolute, like rowStart) that may hold an
// end-relative value; batch parses never flip, so the decode branch never fires.
let rowNF = new Int32Array(8192).fill(0x7fffffff);
// recovery-made bit: the row was memoized during a RECOVERING parse while recovery
// candidates were being created under it — its subtree may contain $error rows, so
// a STRICT pass must not adopt it (an adopted error region would let a strict pass
// 'succeed' over broken text and wipe its diagnostics). Recovering passes adopt
// these rows freely.
let rowRM = new Uint8Array(8192);
function ktr(p: number, k: number) { const v = kidTokRel[k]; return v < 0 ? v + rowTokLen[p] + 1 : v; }
function kcr(p: number, k: number) { const v = kidRel[k]; return v < 0 ? v + rowLen[p] + 1 : v; }
// transient BUILD coordinates (absolute), valid for rows completed in the current
// parse and REFRESHED at memo-hit time for reused roots — parents read them at
// finishNode to write the children's relative fields; never part of the green tree.
let absChar = new Int32Array(8192);
let absTok = new Int32Array(8192);
let rowCap = 8192;
let nodeN = 0;
// Arena reclamation (issue #45 C1): edit() only APPENDS rows (old ones become unreachable
// garbage), and only a full parse resets the cursor. arenaLiveBaseline is nodeN right after the
// last full parse (the compacted live size); when an edit would push nodeN past
// factor×baseline + min, that edit re-parses fresh instead (see editCore) — bounding a
// long edit session at ~factor× the live tree.
let arenaLiveBaseline = 0;
let arenaCompactions = 0;
let arenaCompactFactor = 3;
let arenaCompactMin = 4096;
let arenaInPlaceShrink = 0;   // surgery splices that fit a SHRUNK kid count in place (C2)
let kids = new Int32Array(16384);
// A node child's RELATIVE coordinates live in the PARENT's kids stream (parallel to
// kids), not on the child row: a memo-reused subtree can be a child of several
// longest-match CANDIDATES, and a losing candidate completing after the winner would
// clobber child-side rel fields. The parent owns its edges; rows own only lengths.
let kidRel = new Int32Array(16384);
let kidTokRel = new Int32Array(16384);
let kidCap = 16384;
let kidN = 0;
// Scratch: completed-but-unattached children of in-progress arms. Every
// save/restore of pos pairs with a save/restore of scn — they travel together.
let sc = new Int32Array(4096);
let scCap = 4096;
let scn = 0;
function growRows() {
  rowCap *= 2;
  const r = new Uint16Array(rowCap); r.set(rowRule); rowRule = r;
  const l = new Int32Array(rowCap); l.set(rowLen); rowLen = l;
  const tl = new Int32Array(rowCap); tl.set(rowTokLen); rowTokLen = tl;
  const s = new Int32Array(rowCap); s.set(rowStart); rowStart = s;
  const c = new Int32Array(rowCap); c.set(rowCount); rowCount = c;
  const x = new Int32Array(rowCap); x.set(rowExt); rowExt = x;
  const ok = new Uint8Array(rowCap); ok.set(rowOK); rowOK = ok;
  const kc = new Uint8Array(rowCap); kc.set(rowKC); rowKC = kc;
  const nf = new Int32Array(rowCap).fill(0x7fffffff); nf.set(rowNF.subarray(0, nodeN)); rowNF = nf;
  const rm = new Uint8Array(rowCap); rm.set(rowRM.subarray(0, nodeN)); rowRM = rm;
  const ac = new Int32Array(rowCap); ac.set(absChar); absChar = ac;
  const at = new Int32Array(rowCap); at.set(absTok); absTok = at;
}
function growKids(n: number) {
  while (kidN + n > kidCap) kidCap *= 2;
  const k = new Int32Array(kidCap); k.set(kids.subarray(0, kidN)); kids = k;
  const r = new Int32Array(kidCap); r.set(kidRel.subarray(0, kidN)); kidRel = r;
  const t = new Int32Array(kidCap); t.set(kidTokRel.subarray(0, kidN)); kidTokRel = t;
}
function scPush(e: number) {
  if (scn === scCap) { scCap *= 2; const s = new Int32Array(scCap); s.set(sc); sc = s; }
  sc[scn++] = e;
}
function entryOff(e: number) { return e >= 0 ? absChar[e] : toff((~e) >>> 2); }
function entryEnd(e: number) { return e >= 0 ? absChar[e] + rowLen[e] : tend((~e) >>> 2); }
function entryTok(e: number) { return e >= 0 ? absTok[e] : (~e) >>> 2; }
function entryTokEnd(e: number) { return e >= 0 ? absTok[e] + rowTokLen[e] : ((~e) >>> 2) + 1; }
// Complete a node whose children are scratch[mark..scn): copy them into kids, write
// the row, truncate scratch, return the id. Empty children = a zero-width node
// at the current token (the old offset() rule).
function finishNode(rid: number, mark: number) {
  const n = scn - mark;
  if (nodeN === rowCap) growRows();
  const id = nodeN++;
  let myOff, myEnd, myTok, myTokEnd;
  if (n > 0) {
    if (kidN + n > kidCap) growKids(n);
    const ks = kidN;
    myOff = entryOff(sc[mark]);
    myEnd = entryEnd(sc[scn - 1]);
    myTok = entryTok(sc[mark]);
    myTokEnd = entryTokEnd(sc[scn - 1]);
    // GREEN conversion: scratch entries carry ABSOLUTE coordinates; the kids span is
    // written position-independent — a leaf becomes node-relative-token-encoded, a
    // child node gets its rel fields written here (its own row knows only lengths).
    for (let i = 0; i < n; i++) {
      const e = sc[mark + i];
      if (e < 0) {
        kids[ks + i] = ~(((((~e) >>> 2) - myTok) << 2) | ((~e) & 3));
      } else {
        kids[ks + i] = e;
        kidRel[ks + i] = absChar[e] - myOff;
        kidTokRel[ks + i] = absTok[e] - myTok;
      }
    }
    kidN += n;
    rowStart[id] = ks;
  } else {
    rowStart[id] = kidN;
    myOff = offset(); myEnd = myOff;
    myTok = pos; myTokEnd = pos;
  }
  rowRule[id] = rid; rowLen[id] = myEnd - myOff; rowCount[id] = n;
  rowTokLen[id] = myTokEnd - myTok;
  rowExt[id] = frameMax - myTok;
  rowOK[id] = 0;
  rowKC[id] = 0;
  rowNF[id] = 0x7fffffff;
  rowRM[id] = 0;
  // recovery-made propagation: STRUCTURAL, bitwise — bit 1: a kid is (or contains)
  // an $error row; bit 2: a kid's result is context-tainted (the cycle sentinel)
  // and must not be reused outside its own parse. Batch parses never enter this.
  if (recovering) {
    const ke = rowStart[id] + rowCount[id];
    let rm = 0;
    for (let i2 = rowStart[id]; i2 < ke; i2++) {
      const e2 = kids[i2];
      if (e2 >= 0) {
        rm |= rowRM[e2] | (rowRule[e2] >= RID_ERROR ? 1 : 0);
        if (rm === 3) break;
      }
    }
    rowRM[id] = rm;
  }
  absChar[id] = myOff; absTok[id] = myTok;
  scn = mark;
  return id;
}
// Complete a LED/continuation wrap: children = [lhs, ...scratch[mark..scn)].
function finishWrap(rid: number, lhsId: number, mark: number) {
  const n = scn - mark;
  if (nodeN === rowCap) growRows();
  const id = nodeN++;
  if (kidN + n + 1 > kidCap) growKids(n + 1);
  const ks = kidN;
  const myOff = absChar[lhsId];
  const myTok = absTok[lhsId];
  const myEnd = n > 0 ? entryEnd(sc[scn - 1]) : myOff + rowLen[lhsId];
  const myTokEnd = n > 0 ? entryTokEnd(sc[scn - 1]) : myTok + rowTokLen[lhsId];
  kids[ks] = lhsId;
  kidRel[ks] = 0;
  kidTokRel[ks] = 0;
  for (let i = 0; i < n; i++) {
    const e = sc[mark + i];
    if (e < 0) {
      kids[ks + 1 + i] = ~(((((~e) >>> 2) - myTok) << 2) | ((~e) & 3));
    } else {
      kids[ks + 1 + i] = e;
      kidRel[ks + 1 + i] = absChar[e] - myOff;
      kidTokRel[ks + 1 + i] = absTok[e] - myTok;
    }
  }
  kidN += n + 1;
  rowRule[id] = rid; rowLen[id] = myEnd - myOff;
  rowStart[id] = ks; rowCount[id] = n + 1;
  rowTokLen[id] = myTokEnd - myTok;
  rowExt[id] = frameMax - myTok;
  rowOK[id] = 0;
  rowKC[id] = 0;
  rowNF[id] = 0x7fffffff;
  rowRM[id] = 0;
  // recovery-made propagation: STRUCTURAL, bitwise — bit 1: a kid is (or contains)
  // an $error row; bit 2: a kid's result is context-tainted (the cycle sentinel)
  // and must not be reused outside its own parse. Batch parses never enter this.
  if (recovering) {
    const ke = rowStart[id] + rowCount[id];
    let rm = 0;
    for (let i2 = rowStart[id]; i2 < ke; i2++) {
      const e2 = kids[i2];
      if (e2 >= 0) {
        rm |= rowRM[e2] | (rowRule[e2] >= RID_ERROR ? 1 : 0);
        if (rm === 3) break;
      }
    }
    rowRM[id] = rm;
  }
  absChar[id] = myOff; absTok[id] = myTok;
  scn = mark;
  return id;
}

// ── per-parse state (module-level closures, reset by parse()) ──
let pos = 0;
let maxPos = 0;
// Cap-propagation flag (capExpr): set true when a pratt call returns a CAPPED
// assignment-level expression (an ArrowFunction), so an enclosing operator LED can refuse
// to continue it (in  a = ()=>{} || x  the assignment RHS is a capped arrow, so the || must
// not attach to the assignment; it stays unconsumed and the parse rejects). Reset at each
// capped-rule pratt entry; read by the op LED right after parsing its RHS.
let _prattCapped = false;
// Frame-LOCAL advance watermark: reach of the CURRENT rule frame (reset to the
// frame's start at parseRuleEntry, folded back into the parent on exit). Keeps
// rowExt/memo watermarks EXACT — the global maxPos contaminates them with probes
// from earlier siblings, and recovery-bar minting (bar = strict-fail maxPos) must
// be identical between a fresh parse and an adoption re-run. frameMax <= maxPos
// always, so the hot advance pays one extra compare only at frontier breaches.
let frameMax = 0;
let memoNode: number[][] = [];
let memoEnd: number[][] = [];
let memoExt: number[][] = [];   // per-entry lookahead extent (see parseRuleEntry)
// GENERATION-STAMPED memo: the per-rule arrays persist across parses (allocating
// fresh multi-million-slot arrays per edit cost ~30% of a large-file edit in GC
// alone); an entry is live iff its stamp equals the current generation — bumping
// memoGenCur IS the whole reset.
let memoGen: Int32Array[] = [];
let memoGenCur = 0;
let parseLimit = -1;
// cap = the exclusive lookahead bound: min(parseLimit-or-∞, tokN), maintained at the
// parseLimit set/restore sites and the one token-stream mutation (the '>' splice).
let cap = 0;
let currentPrattContext: string | null = null;
let suppressNext: Set<string> | null = null;
let suppressCur: Set<string> | null = null;

function offset() {
  if (pos < cap) return toff(pos);
  return tokN > 0 ? tend(tokN - 1) : 0;
}

// ── Lever 1: integer-kind matchers ──
// All matchers PUSH their leaf entry onto the scratch stack and return a boolean
// (the arena protocol) — leaves cost no allocation, only an int.
// Keyword literal: the interpreter required tok.type !== '' && tokenNames.has(tok.type)
// && tok.text === value. With interned kinds that is tok.k >= K_NAMED_MIN (a declared
// token name; '' is PUNCT, templates are below NAMED_MIN) && tok.t === KW(value).
function matchKwLit(kw: number, vs?: number) {
  // A kw-range t can only come from a named token (template spans never intern to a
  // keyword), so the old k >= K_NAMED_MIN guard was redundant — one int compare.
  // vs (optional) = the call site's viable-set id, threaded into the $missing row.
  if (pos >= cap || tkT[pos] !== kw) return recovering ? missTok(kw, vs) : false;
  scPush(~((pos << 2) | 1));
  if (++pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }
  return true;
}
// Punct literal: tok.type === '' && tok.text === value, with the gt-splice fallback.
// tok.t === PU(value) is the exact-text fast path; the splice handles a longer
// gt-led token matching the gt key. value/pu are baked by the caller.
function matchPuLit(pu: number, vs?: number) {
  // A pu-range t can only come from a punct token, so the old k === K_PUNCT guard was
  // redundant — one int compare. The '>'-split lives only in matchPuLitGT ('>' sites).
  if (pos >= cap || tkT[pos] !== pu) return recovering ? missTok(pu, vs) : false;
  scPush(~(pos << 2));
  if (++pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }
  return true;
}
function matchPuLitGT(pu: number, vs?: number) {
  if (pos >= cap) return false;
  const off = toff(pos);
  if (tkT[pos] === pu) {
    scPush(~(pos << 2));
    if (++pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }
    return true;
  }
  // Split multi-'>' tokens: '>>', '>>>', '>>=', '>>>=' can yield a single '>': shift the
  // columns up one slot and write the '>' + rest pair in place (both born flag-less,
  // matching the old mkPunct pair).
  if (tkK[pos] === K_PUNCT && tend(pos) - off > 1 && ${e.soa ? 'docChar(off) === 62' : "tkText[pos].charCodeAt(0) === 62"}) {
    const end0 = tend(pos);
    ${e.soa ? '' : 'const restText = tkText[pos].slice(1);'}
    if (tokN === tkCap) growTok();
    ${e.soa ? 'parenCachePos = -1;' : ''}   // invalidate the paren-stack cache (soa emitted lexer only)
    // token indices shift past this point: the OLD-TREE adoption mapping
    // (adoptDmg*/adoptDelta, frozen at edit start) is no longer valid — turn
    // adoption off for the remainder of this parse (the '>' split is rare; the
    // memo generation bump below already isolates the memo)
    adoptRoot = -1;
    adoptRunPos = -1;
    tkK.copyWithin(pos + 1, pos, tokN);
    tkT.copyWithin(pos + 1, pos, tokN);
    tkOff.copyWithin(pos + 1, pos, tokN);
    tkEnd.copyWithin(pos + 1, pos, tokN);
    tkDp.copyWithin(pos + 1, pos, tokN);
    tkPd.copyWithin(pos + 1, pos, tokN);
    tkFl.copyWithin(pos + 1, pos, tokN);
    ${e.soa ? '' : "tkText.splice(pos, 1, '>', restText);"}
    // Keep the EOF-relative zone invariant: a split at/past negFrom writes the new
    // pair EOF-relative (a positive value there would not ride later srcLenP1
    // shifts); below it, the boundary index moves up one slot with the suffix.
    if (pos < negFrom) {
      negFrom++;
      tkT[pos] = pu; tkEnd[pos] = off + 1; tkFl[pos] = 0;
      tkOff[pos + 1] = off + 1; tkFl[pos + 1] = 0;
    } else {
      tkT[pos] = pu; tkEnd[pos] = off + 1 - srcLenP1; tkFl[pos] = 0;
      tkOff[pos + 1] = off + 1 - srcLenP1; tkFl[pos + 1] = 0;
    }
    tkT[pos + 1] = ${e.soa ? 'LIT_PU.get(docText(off + 1, end0)) ?? 0' : 'LIT_PU.get(restText) ?? 0'};
    tokN++;
    if (parseLimit < 0) cap = tokN;
    // Token indices shifted: drop the per-rule memo arrays (recreated lazily at the new size).
    memoGenCur++;   // positions shifted mid-parse: every stamped entry is stale
    memoRecFloor = 0x7fffffff;   // including across attempts: pre-split positions
                                 // can never be revalidated against the new stream
    for (let _ep = docEmptyPops.length - 1; _ep >= 0 && docEmptyPops[_ep] >= pos; _ep--) docEmptyPops[_ep]++;
    // GREEN tree: no kids/scratch fixup — every completed row and scratch entry lies
    // wholly BEFORE the splice point (token pos is being consumed right now), and the
    // carried memo was just cleared, so nothing reachable references shifted indices.
    scPush(~(pos << 2));
    if (++pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }
    return true;
  }
  return recovering ? missTok(pu, vs) : false;
}
// Generic matchLiteral kept for any unspecialized site: classify value via the baked
// tables (no per-call isKeywordLiteral / string compares) and delegate.
function matchLiteral(value: string) {
  const kw = LIT_KW.get(value);
  if (kw !== undefined) return matchKwLit(kw);
  if (value === '>') return matchPuLitGT(LIT_PU.get(value) ?? 0);
  return matchPuLit(LIT_PU.get(value) ?? 0);
}

// Match a token ref by its baked TYPE kind: tok.type === name  ⟺  tok.k === nameKind.
// (No named-token kind equals K_NAMED_FALLBACK, so an unforeseen type never matches.)
// The materialized tokenType is type-derived (kind 0) — name needs no baking here.
function matchTokK(nameKind: number) {
  if (pos >= cap || tkK[pos] !== nameKind) return recovering ? missTok(-nameKind) : false;
  scPush(~(pos << 2));
  if (++pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }
  return true;
}

// (First-token / FIRST-set gating is baked at emit time: per-set _qN byte-table fns
// for rule/alt guards, and open-coded two-table loads for the LED dispatch — see
// membershipFn / ftCond in the emitter.)
function parseTemplateExpr() {
  if (pos >= cap) return false;
  const k = tkK[pos];
  if (k === K_TPL_TOKEN) {
    scPush(~(pos << 2));
    if (++pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }
    return true;
  }
  if (k === K_TEMPLATE_HEAD) {
    const mark = scn;
    const save = pos;
    scPush(~(pos << 2));
    if (++pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }
    const interpRule = currentPrattContext ?? EXPR_RULE;
    // a head COMMITS to the full chain: every substitution must hold an
    // expression and every span must continue (middle) or close (tail) — an
    // unterminated template is a parse failure, not a shorter match
    while (true) {
      if (!RULES[interpRule]() || pos >= cap) { pos = save; scn = mark; return false; }
      const nk = tkK[pos];
      if (nk === K_TEMPLATE_MIDDLE) {
        scPush(~(pos << 2));
        if (++pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }
        continue;
      }
      if (nk === K_TEMPLATE_TAIL) {
        scPush(~(pos << 2));
        if (++pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }
        break;
      }
      pos = save; scn = mark; return false;
    }
    scPush(finishNode(RID_TEMPLATE, mark));
    return true;
  }
  return false;
}
`);
}

// Emit the per-rule parse functions + the RULES dispatch table.
function emitRuleFns(e: Emitter, a: ReturnType<typeof analyze>) {
  const ruleFn = (name: string) => `R_${sanitize(name)}`;
  // SPINE rules — the entry rule's repetition units (the rules its body references
  // directly): the natural reuse granularity for incremental re-parsing, so they get
  // memoized through parseRuleEntry like pratt/left-rec rules. Without this only
  // expression/type subtrees reuse and every statement re-walks on each edit.
  // Derived from the grammar shape — no language names.
  const spine = e.spineSet();
  for (const rule of a.grammar.rules) {
    if (a.prattRules.has(rule.name)) emitPrattRule(e, a, rule);
    else if (a.leftRecSet.has(rule.name)) emitLeftRecRule(e, a, rule);
    else emitNonRecRule(e, a, rule, spine.has(rule.name) && !a.prattRules.has(rule.name) && !a.leftRecSet.has(rule.name));
  }
  // Dispatch table (string rule name → fn), for parseTemplateExpr's dynamic interp rule.
  e.emit(`const RULES: Record<string, () => boolean> = {`);
  for (const rule of a.grammar.rules) e.emit(`  ${J(rule.name)}: ${ruleFn(rule.name)},`);
  e.emit(`};`);

  // Surgical-container table: rule id → its repetition element's rule id, for rules
  // whose body is a PURE seq/group of literals/refs around exactly one '*'/'+' rep
  // of a parseRuleEntry-routed rule. No alt/sep/opt/not anywhere in the body: a
  // longest-match arm (or lookahead) at the container's OWN level may probe into
  // the rep zone without any kid row owning the read, which would break the
  // prefix-keep watermark argument node surgery relies on.
  const surg: number[] = a.grammar.rules.map(() => -1);
  a.grammar.rules.forEach((rule, ri) => {
    if (a.prattRules.has(rule.name) || a.leftRecSet.has(rule.name)) return;
    let reps = 0; let bad = false; let elem = -1;
    const walk = (x: RuleExpr): void => {
      if (bad) return;
      switch (x.type) {
        case 'seq': x.items.forEach(walk); return;
        case 'group':
          if (x.suppress && x.suppress.length) { bad = true; return; }
          walk(x.body); return;
        case 'literal': case 'ref': case 'op': case 'prefix': case 'postfix': return;
        case 'quantifier':
          if (x.kind === '?') { bad = true; return; }
          reps++; elem = e.quantRunRuleId(x.body);
          return;
        default: bad = true; return;
      }
    };
    walk(rule.body);
    if (!bad && reps === 1 && elem >= 0) surg[ri] = elem;
  });
  e.emit(`const SURG_ELEM = new Int32Array([${surg.join(',')}]);`);
  e.emit(`const RULE_FN_BY_ID = [${a.grammar.rules.map(r => ruleFn(r.name)).join(', ')}];`);
  {
    // Paired-opener table for diagnostics: for each literal C, intersect — across
    // every seq occurrence of C that has preceding literals in its sequencing scope
    // (transparent groups inlined; quantifier/alt/not bodies are separate scopes) —
    // the SETS of those preceding literals. A unique survivor is C's structural
    // opener: ')' keeps '(' through if/while/call alike (interior separators like
    // the index signature's ':' vary per shape and intersect away), while ','/':'
    // themselves intersect to nothing. No bracket list is hardcoded. Used to attach
    // "to match this 'x'" related info to "expected 'C'" $missing diagnostics; the
    // sibling scan at collect time self-guards (no opener leaf in the row, no info).
    const tOfLit = (txt: string) => (isKeywordLiteral(txt) ? a.symtab.kwLitKind.get(txt) : a.symtab.puLitKind.get(txt)) ?? 0;
    const inter = new Map<number, number[]>();   // closer t → intersection, nearest-last order
    const walk = (x: RuleExpr, acc: number[] | null): void => {
      switch (x.type) {
        case 'seq': { const sc = acc ?? []; for (const it of x.items) walk(it, sc); return; }
        case 'group': walk(x.body, acc); return;
        case 'literal': {
          const c = tOfLit(x.value);
          if (c <= 0) return;
          if (acc !== null && acc.length > 0) {
            const prev = inter.get(c);
            if (prev === undefined) inter.set(c, acc.filter(o => o !== c));
            else inter.set(c, prev.filter(o => acc.includes(o)));
          }
          if (acc !== null) acc.push(c);
          return;
        }
        // quantifier/alt contents physically FOLLOW the scope's earlier literals
        // (an arm of `seq('[', alt(...), ']')` sits after the '['), so they inherit
        // a COPY of the accumulator; nothing leaks back out (which arm matched, or
        // whether the quantifier matched at all, is unknowable statically).
        case 'quantifier': walk(x.body, acc === null ? null : [...acc]); return;
        case 'alt': for (const it of x.items) walk(it, acc === null ? null : [...acc]); return;
        case 'not': return;
        default: return;   // refs / zero-width markers neither pair nor reset
      }
    };
    for (const rule of a.grammar.rules) walk(rule.body, null);
    const n = a.symtab.kwLitKind.size + a.symtab.puLitKind.size + 1;
    const arr = new Array(n).fill(0);
    for (const [c, set] of inter) if (set.length === 1) arr[c] = set[0];
    e.emit(`const PAIR_OPEN = new Int32Array([${arr.join(',')}]);`);
  }
  // Viable-set messages, registered per CALL SITE during the rule emission above
  // (see vsetFor): id → " or "-joined alternatives, decoded from the $missing
  // row's packed rowStart at settle.
  e.emit(`const VSETS = ${J(e.vsetMsgs)};`);
}

// Non-recursive rule: longest-match over alts (mirrors parseNonRec). A better arm is
// committed to the arena IMMEDIATELY (finishNode also truncates scratch back to mark);
// a not-better arm's children are dropped by the next arm's scn reset (a beaten
// committed candidate stays as an arena hole — the measured 3-5% discard class).
function emitNonRecRule(e: Emitter, a: ReturnType<typeof analyze>, rule: RuleDecl, memoized = false) {
  const ruleFn = `R_${sanitize(rule.name)}`;
  const rid = a.grammar.rules.indexOf(rule);
  const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
  // A memoized (spine) rule splits into the public wrapper (parseRuleEntry owns the
  // push+boolean contract and the memo) and an id-returning core, exactly like the
  // pratt/left-rec rules.
  if (memoized) {
    e.emit(`function ${ruleFn}() { return parseRuleEntry(${e.memoIndex(rule.name)}, ${rid}, ${J(rule.name)}, ${ruleFn}_core); }`);
    e.emit(`function ${ruleFn}_core(_minBp: number) {`);
  } else {
    e.emit(`function ${ruleFn}() {`);
  }
  e.emit(`  const saved = pos; const mark = scn;`);
  e.emit(`  let bestId = -1; let bestPos = saved;`);
  const dispatch = e.altMaskDispatch(alts, '_am');
  if (dispatch) e.emit(`  ${dispatch.maskInit}`);
  alts.forEach((alt, i) => {
    e.emit(`  // alt ${i}`);
    e.emit(`  if (${dispatch ? dispatch.bit(i) : e.altGuard(alt)}) {`);
    e.emit(`    pos = saved; scn = mark;`);
    e.emit(`    if (arm_${sanitize(rule.name)}_${i}() && pos > bestPos) {`);
    e.emit(`      bestId = finishNode(${rid}, mark);`);
    e.emit(`      bestPos = pos;`);
    e.emit(`    }`);
    e.emit(`  }`);
  });
  if (memoized) {
    e.emit(`  if (bestId >= 0) { pos = bestPos; scn = mark; return bestId; }`);
    e.emit(`  pos = saved; scn = mark; return -1;`);
  } else {
    e.emit(`  if (bestId >= 0) { pos = bestPos; scn = mark; scPush(bestId); return true; }`);
    e.emit(`  pos = saved; scn = mark; return false;`);
  }
  e.emit(`}`);
  // Arm matchers.
  alts.forEach((alt, i) => emitArm(e, a, rule.name, i, alt));
}

// Left-recursive (non-Pratt) rule: atom then continuations (mirrors parseLeftRec).
function emitLeftRecRule(e: Emitter, a: ReturnType<typeof analyze>, rule: RuleDecl) {
  const ruleFn = `R_${sanitize(rule.name)}`;
  const sn = sanitize(rule.name);
  const { atoms, continuations, contNotLeftLeaf } = a.leftRecClassified.get(rule.name)!;
  const contMix = a.contMeta.get(rule.name)!;
  // A left-rec rule, like a Pratt rule, goes through parseRule's memo + context +
  // suppress wrapper in the interpreter — so currentPrattContext is set to this rule
  // (the template-interpolation rule resolution depends on it: a `${…}` hole inside a
  // template-literal TYPE must parse as Type, not the default expression rule).
  const rid = a.grammar.rules.indexOf(rule);
  e.emit(`function ${ruleFn}() { return parseRuleEntry(${e.memoIndex(rule.name)}, ${rid}, ${J(rule.name)}, ${ruleFn}_lr); }`);
  // notLeftLeaf head-leaf word sets (module-level, built once) for this rule's gated continuations.
  contNotLeftLeaf.forEach((words, i) => {
    if (words) e.emit(`const _NLLC_${sn}_${i} = new Set<string>(${J(words)});`);
  });
  e.emit(`function ${ruleFn}_lr(_minBp: number) {`);
  e.emit(`  const saved = pos; const mark = scn;`);
  e.emit(`  let node = -1; let bestAtomPos = saved;`);
  const atomDispatch = e.altMaskDispatch(atoms, '_am');
  if (atomDispatch) e.emit(`  ${atomDispatch.maskInit}`);
  atoms.forEach((atom, i) => {
    e.emit(`  if (${atomDispatch ? atomDispatch.bit(i) : e.altGuard(atom)}) {`);
    e.emit(`    pos = saved; scn = mark;`);
    e.emit(`    if (atom_${sanitize(rule.name)}_${i}() && pos > bestAtomPos) {`);
    e.emit(`      node = finishNode(${rid}, mark);`);
    e.emit(`      bestAtomPos = pos;`);
    e.emit(`    }`);
    e.emit(`  }`);
  });
  e.emit(`  scn = mark;`);
  e.emit(`  if (node < 0) { pos = saved; return -1; }`);
  e.emit(`  pos = bestAtomPos;`);
  e.emit(`  outer: while (true) {`);
  e.emit(`    const contSaved = pos; const contMark = scn;`);
  continuations.forEach((cont, i) => {
    e.emit(`    pos = contSaved; scn = contMark;`);
    // notLeftLeaf head-leaf gate: skip this continuation when the LEFT node's outermost (head) leaf
    // text is in its word set (e.g. `void`/`null`/`this` can't be `.`-qualified as a type).
    const gate = contNotLeftLeaf[i] ? `!_NLLC_${sn}_${i}.has(_headLeafText(node)) && ` : '';
    e.emit(`    { let ok = ${gate}cont_${sanitize(rule.name)}_${i}();`);
    if (contMix[i]) {
      e.emit(`      if (!ok) { pos = contSaved; scn = contMark; ok = matchMixfixLed_${sanitize(rule.name)}_cont_${i}(); }`);
    }
    // A zero-width continuation is possible only via token synthesis (a strict one
    // would never terminate this loop) — discard it or the loop spins.
    e.emit(`      if (ok && pos === contSaved) { scn = contMark; ok = false; }`);
    e.emit(`      if (ok) {`);
    e.emit(`        node = finishWrap(${rid}, node, contMark);`);
    e.emit(`        continue outer;`);
    e.emit(`      } }`);
  });
  e.emit(`    pos = contSaved; scn = contMark; break;`);
  e.emit(`  }`);
  e.emit(`  return node;`);
  e.emit(`}`);
  // Atom + continuation matchers.
  atoms.forEach((atom, i) => emitArmNamed(e, a, `atom_${sanitize(rule.name)}_${i}`, atom));
  continuations.forEach((cont, i) => {
    emitArmNamed(e, a, `cont_${sanitize(rule.name)}_${i}`, { type: 'seq', items: cont } as RuleExpr);
    if (contMix[i]) emitMixfixLed(e, a, `matchMixfixLed_${sanitize(rule.name)}_cont_${i}`, rule.name, cont, contMix[i]!);
  });
}

// Pratt rule (mirrors parsePratt). minBp is a parameter; the NUD/LED arms are
// specialized functions; the control loop is copied verbatim.
function emitPrattRule(e: Emitter, a: ReturnType<typeof analyze>, rule: RuleDecl) {
  const ruleFn = `R_${sanitize(rule.name)}`;
  const sn = sanitize(rule.name);
  const { nuds, leds } = a.prattClassified.get(rule.name)!;
  const meta = a.ledMeta.get(rule.name)!;
  const nudCap = a.nudCap.get(rule.name)!;
  const anyCapped = nudCap.some(c => c !== null);

  // R_<rule>() wraps parseRule's memo/context handling, then calls the bp-taking core.
  const rid = a.grammar.rules.indexOf(rule);
  e.emit(`function ${ruleFn}() { return parseRuleEntry(${e.memoIndex(rule.name)}, ${rid}, ${J(rule.name)}, ${ruleFn}_pratt); }`);
  // notLeftLeaf head-leaf word sets (module-level, built once) for this rule's gated LED arms.
  meta.notLeftLeaf.forEach((words, i) => {
    if (words) e.emit(`const _NLL_${sn}_${i} = new Set<string>(${J(words)});`);
  });
  e.emit(`function ${ruleFn}_pratt(minBp: number) {`);
  e.emit(`  const saved = pos; const mark = scn;`);
  e.emit(`  let lhs = -1; let bestNudPos = saved;`);
  // `capped` becomes true iff the winning NUD is a capped (assignment-level) expression —
  // an ArrowFunction. Such a NUD admits no led, so the led loop is skipped entirely.
  if (anyCapped) e.emit(`  let capped = false; _prattCapped = false;`);
  // NUD loop.
  const nudDispatch = e.altMaskDispatch(nuds, '_am');
  if (nudDispatch) e.emit(`  ${nudDispatch.maskInit}`);
  nuds.forEach((nud, i) => {
    const items = nud.type === 'seq' ? nud.items : [nud];
    const capBp = nudCap[i];
    e.emit(`  // nud ${i}`);
    // A capped NUD parses only at a minBp LOOSER than its cap: it is refused as a tighter
    // operator's operand (so `a || () => {}` rejects — `||`'s rhs minBp >= the cap).
    const guard = nudDispatch ? nudDispatch.bit(i) : e.altGuard(nud);
    e.emit(`  if (${capBp !== null ? `minBp < ${capBp} && ` : ''}${guard}) {`);
    e.emit(`    pos = saved; scn = mark;`);
    if (items[0]?.type === 'prefix') {
      // prefix $ pattern: identical to parsePratt's prefix branch.
      e.emit(`    if (pos < cap) {`);
      e.emit(`      const info = PREFIX_BY_T[tkT[pos]];`);
      e.emit(`      if (info) {`);
      e.emit(`        scPush(~((pos << 2) | 2));`);
      e.emit(`        if (++pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }`);
      e.emit(`        let rhs = ${ruleFn}_pratt(info.rbp);`);
      e.emit(`        if (rhs < 0 && recovering) rhs = missRule(${rid});`);
      // A target-requiring prefix (`++`/`--`) operand must be a LeftHandSideExpression
      // (`++-x`, `++ ++x`, `++x--`, `++await x` are syntax errors). Fail hard like
      // noUnaryLhs. A recovery-synthesized $missing operand has no children, so
      // _notTarget returns false → recovery is not falsely rejected.
      e.emit(`        if (rhs >= 0 && info.requireTarget && _notTarget(rhs)) return -1;`);
      e.emit(`        if (rhs >= 0 && pos > bestNudPos) { scPush(rhs); lhs = finishNode(${rid}, mark); bestNudPos = pos; }`);
      e.emit(`      }`);
      e.emit(`    }`);
    } else {
      e.emit(`    if (nud_${sn}_${i}() && pos > bestNudPos) {`);
      e.emit(`      lhs = finishNode(${rid}, mark);`);
      e.emit(`      bestNudPos = pos;`);
      // The LONGEST match wins; record whether THAT winner is capped.
      if (anyCapped) e.emit(`      capped = ${capBp !== null ? 'true' : 'false'};`);
      e.emit(`    }`);
    }
    e.emit(`  }`);
  });
  e.emit(`  scn = mark;`);
  e.emit(`  if (lhs < 0) { pos = saved; return -1; }`);
  e.emit(`  pos = bestNudPos;`);
  // A capped NUD (assignment-level arrow) admits no led: return it as-is so a trailing
  // tighter operator stays unconsumed and the enclosing parse rejects (`() => {} || a`).
  if (anyCapped) e.emit(`  if (capped) { _prattCapped = true; return lhs; }`);
  e.emit(`  let tailClosed = false;`);
  e.emit(`  while (true) {`);
  e.emit(`    if (pos >= cap) break;`);
  e.emit(`    const ledSaved = pos; const ledMark = scn;`);
  e.emit(`    let matched = false;`);
  // Non-op LED loop. The shared `maxBp > minBp` is hoisted out of the per-led conds,
  // and the per-led first-token gates collapse into one bitmask pair of loads.
  const realLeds = leds.map((led, i) => ({ led, i }))
    .filter(({ led }) => led.items[0]?.type !== 'op' && led.items[0]?.type !== 'postfix');
  if (realLeds.length > 0) {
    const ledMask = e.ftMaskDispatch(realLeds.map(({ i }) => meta.first[i]), '_lm', 'pos');
    e.emit(`    if (maxBp > minBp) {`);
    if (ledMask) e.emit(`    ${ledMask.maskInit}`);
    realLeds.forEach(({ led, i }, j) => {
      const conds: string[] = [];
      if (meta.accessTail[i]) conds.push(`!(tailClosed)`);
      // Precedence gate for alternative-form LEDs (see LedPrec): without it they bind
      // maximally tight (`a == b ? c : d` mis-grouped as `a == (b ? c : d)`).
      if (meta.prec[i]) conds.push(`${meta.prec[i]!.lbp} > minBp`);
      // notLeftLeaf head-leaf gate: skip the arm when the LEFT node's outermost (head) leaf text
      // is in the arm's word set (e.g. `void`/`null`/`this` can't be `.`-qualified as a type).
      if (meta.notLeftLeaf[i]) conds.push(`!_NLL_${sn}_${i}.has(_headLeafText(lhs))`);
      // suppress: skip a LED whose first literal connector is in suppressCur.
      const firstLit = (led.items[0]?.type === 'literal') ? led.items[0].value : null;
      if (firstLit !== null) conds.push(`!(suppressCur && suppressCur.has(${J(firstLit)}))`);
      if (ledMask) conds.push(ledMask.bit(j));
      else {
        const ftc = e.ftCond(meta.first[i], 'pos');   // pos < cap here (the loop breaks above)
        if (ftc) conds.push(ftc);
      }
      e.emit(`    // led ${i}`);
      e.emit(`    if (${['!matched', ...conds].join(' && ')}) {`);
      e.emit(`      pos = ledSaved; scn = ledMark;`);
      e.emit(`      let ok = led_${sn}_${i}();`);
      if (meta.mixfix[i]) {
        e.emit(`      if (!ok) { pos = ledSaved; scn = ledMark; ok = matchMixfixLed_${sn}_led_${i}(); }`);
      }
      // Zero-width LED = synthetic-only (see the continuation loop note) — discard.
      e.emit(`      if (ok && pos === ledSaved) { scn = ledMark; ok = false; }`);
      e.emit(`      if (ok) {`);
      e.emit(`        lhs = finishWrap(${rid}, lhs, ledMark);`);
      if (meta.tailClosing[i]) e.emit(`        tailClosed = true;`);
      e.emit(`        matched = true;`);
      e.emit(`      }`);
      e.emit(`    }`);
    });
    e.emit(`    }`);
  }
  e.emit(`    if (matched) continue;`);
  // Operator LED ($ op $ / postfix), copied verbatim. The no-unary-LHS check is a byte
  // table over t (a token's text equals an op value iff its t-int matches — vocabulary).
  // The lhs head probe reads the arena row instead of an object's children array.
  e.emit(`    const info = OP_BY_T[tkT[pos]];`);
  e.emit(`    if (info && info.lbp > minBp) {`);
  e.emit(`      if (info.position === 'postfix') {`);
  e.emit(`        if (!tailClosed) {`);
  // A target-requiring postfix (`++`/`--`) may not apply to a unary/update operand
  // (`++x++`, `x++ ++`): its operand must be a LeftHandSideExpression. Fail hard (like
  // noUnaryLhs), so the expression can't reparse some other way.
  e.emit(`          if (REQTGT_T[tkT[pos]] !== 0 && _notTarget(lhs)) return -1;`);
  e.emit(`          scPush(~((pos << 2) | 2));`);
  e.emit(`          if (++pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }`);
  e.emit(`          lhs = finishWrap(${rid}, lhs, ledMark);`);
  e.emit(`          tailClosed = true; matched = true;`);
  e.emit(`        }`);
  e.emit(`      } else {`);
  // A target-requiring infix (`=`/`+=`/…) needs a LeftHandSideExpression LEFT operand
  // (`-x = 1`, `++x = 1`, `x++ = 1` are syntax errors). Like noUnaryLhs, fail hard.
  e.emit(`        if (REQTGT_T[tkT[pos]] !== 0 && _notTarget(lhs)) return -1;`);
  e.emit(`        if (NOUNARY_T[tkT[pos]] !== 0 && rowCount[lhs] > 0) {`);
  e.emit(`          const _h = kids[rowStart[lhs]];`);
  e.emit(`          if (_h < 0 && ((~_h) & 3) === 2) {`);
  e.emit(`            const _ht = absTok[lhs] + ((~_h) >>> 2);`);
  e.emit(`            const _htext = ${e.soa ? 'docText(toff(_ht), tend(_ht))' : 'tkText[_ht]'};`);
  e.emit(`            if (prefixOps.has(_htext) && !postfixOpValues.has(_htext)) { return -1; }`);
  e.emit(`          }`);
  e.emit(`        }`);
  e.emit(`        scPush(~((pos << 2) | 2));`);
  e.emit(`        if (++pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }`);
  e.emit(`        let rhs = ${ruleFn}_pratt(info.rbp);`);
  e.emit(`        if (rhs < 0 && recovering) rhs = missRule(${rid});`);
  // CAP PROPAGATION: an operator whose RHS is a capped assignment-level expression (an
  // ArrowFunction) is ITSELF capped — `a = () => {}` admits no further led, so a trailing
  // `|| x` / `? :` stays unconsumed and the parse rejects (`a = () => {} || x`). `return lhs`
  // keeps `_prattCapped` true so an enclosing operator refuses it too (`b = a = arrow`).
  if (anyCapped) e.emit(`        if (rhs >= 0 && _prattCapped) { scPush(rhs); lhs = finishWrap(${rid}, lhs, ledMark); return lhs; }`);
  e.emit(`        if (rhs >= 0) { scPush(rhs); lhs = finishWrap(${rid}, lhs, ledMark); matched = true; }`);
  e.emit(`        else { pos = ledSaved; scn = ledMark; }`);
  e.emit(`      }`);
  e.emit(`      if (matched) continue;`);
  e.emit(`    }`);
  e.emit(`    if (!matched) { pos = ledSaved; scn = ledMark; break; }`);
  e.emit(`  }`);
  e.emit(`  return lhs;`);
  e.emit(`}`);

  // NUD arm matchers (skip prefix nuds — handled inline above).
  nuds.forEach((nud, i) => {
    const items = nud.type === 'seq' ? nud.items : [nud];
    if (items[0]?.type === 'prefix') return;
    emitArmNamed(e, a, `nud_${sn}_${i}`, nud);
  });
  // LED arm matchers (skip operator leds).
  leds.forEach((led, i) => {
    if (led.items[0]?.type === 'op' || led.items[0]?.type === 'postfix') return;
    const lp = meta.prec[i];
    if (lp && lp.rhsBp !== null) {
      // Chain-rhs led ('in'/'instanceof'): trailing self-operand at the level's bp
      // (left-chaining like a ladder op's rhs), bypassing the bp-0 rule entry.
      e.emit(`function led_${sn}_${i}() {`);
      e.emit(`  const _save = pos; const _sn = scn;`);
      e.emit(e.matchInto({ type: 'seq', items: led.items.slice(0, -1) } as RuleExpr, 'pos = _save; scn = _sn; return false;'));
      e.emit(`  let _rhs = ${ruleFn}_pratt(${lp.rhsBp});`);
      e.emit(`  if (_rhs < 0 && recovering) _rhs = missRule(${rid});`);
      e.emit(`  if (_rhs < 0) { pos = _save; scn = _sn; return false; }`);
      e.emit(`  scPush(_rhs);`);
      e.emit(`  return true;`);
      e.emit(`}`);
    } else {
      emitArmNamed(e, a, `led_${sn}_${i}`, { type: 'seq', items: led.items } as RuleExpr);
    }
    if (meta.mixfix[i]) emitMixfixLed(e, a, `matchMixfixLed_${sn}_led_${i}`, rule.name, led.items, meta.mixfix[i]!);
  });
}

// Emit `arm_<rule>_<i>()` — a matchExpr(alt) specialization returning children|null.
function emitArm(e: Emitter, a: ReturnType<typeof analyze>, ruleName: string, i: number, alt: RuleExpr) {
  emitArmNamed(e, a, `arm_${sanitize(ruleName)}_${i}`, alt);
}

// Emit a named matcher fn for `expr`: pushes the matched children onto scratch and
// returns a boolean, restoring pos AND scn on failure (the arena matcher contract).
function emitArmNamed(e: Emitter, a: ReturnType<typeof analyze>, fnName: string, expr: RuleExpr) {
  e.emit(`function ${fnName}() {`);
  const single = e.singleLeafBodyPublic(expr);
  if (single) {
    e.emit(single);
  } else {
    e.emit(`  const _save = pos; const _sn = scn;`);
    e.emit(e.matchInto(expr, 'pos = _save; scn = _sn; return false;'));
    e.emit(`  return true;`);
  }
  e.emit(`}`);
}

// Emit a specialized matchMixfixLed for a LED/cont (mirrors the interpreter's
// matchMixfixLed exactly; the rest-matching uses an inlined matchSeq of items[3:]).
function emitMixfixLed(e: Emitter, a: ReturnType<typeof analyze>, fnName: string, ruleName: string, items: RuleExpr[], info: MixfixInfo) {
  const ruleFn = `R_${sanitize(ruleName)}`;
  const restItems = items.slice(3);
  e.emit(`function ${fnName}() {`);
  e.emit(`  const saved = pos; const _sn = scn;`);
  e.emit(`  if (!${e.matchLiteralCall(info.openLit)}) { pos = saved; scn = _sn; return false; }`);
  e.emit(`  const afterOpen = pos; const aoMark = scn;`);
  e.emit(`  if (!${ruleFn}()) { pos = saved; scn = _sn; return false; }`);
  e.emit(`  const greedyEnd = pos;`);
  e.emit(`  if (${e.matchLiteralCall(info.sepLit)}) { pos = saved; scn = _sn; return false; }`);
  const pu = (lit: string) => a.symtab.puLitKind.get(lit) ?? -1;
  // The separator is a literal, so it classifies as kw/punct (both carry t); a
  // token-name key (impossible here) gets the never-matching -1.
  const sepDesc = a.symtab.classifyKey(info.sepLit);
  const sepT = sepDesc.kind === 'tok' ? -1 : sepDesc.t;
  e.emit(`  let depth = 0; const candidates = [];`);
  e.emit(`  for (let i = afterOpen; i < greedyEnd; i++) {`);
  e.emit(`    if (tkK[i] !== K_PUNCT) continue;`);
  e.emit(`    const t = tkT[i];`);
  e.emit(`    if (t === ${pu('(')} || t === ${pu('[')} || t === ${pu('{')}) depth++;`);
  e.emit(`    else if (t === ${pu(')')} || t === ${pu(']')} || t === ${pu('}')}) depth--;`);
  e.emit(`    else if (depth === 0 && t === ${sepT}) candidates.push(i);`);
  e.emit(`  }`);
  e.emit(`  for (const sepIdx of candidates) {`);
  e.emit(`    pos = afterOpen; scn = aoMark;`);
  e.emit(`    const prevLimit = parseLimit; parseLimit = sepIdx; cap = sepIdx;`);
  e.emit(`    const reOperand = ${ruleFn}();`);
  e.emit(`    parseLimit = prevLimit; cap = prevLimit >= 0 ? prevLimit : tokN;`);
  e.emit(`    if (!reOperand || pos !== sepIdx) continue;`);
  e.emit(`    if (!${e.matchLiteralCall(info.sepLit)}) continue;`);
  // rest = matchSeq(items[3:]) — inline (pushes; restores pos/scn on failure).
  e.emit(`    const rest = (function(){ const _save = pos; const _rsn = scn;`);
  e.emit(e.matchInto({ type: 'seq', items: restItems } as RuleExpr, 'pos = _save; scn = _rsn; return false;'));
  e.emit(`      return true; })();`);
  e.emit(`    if (!rest) continue;`);
  e.emit(`    return true;`);
  e.emit(`  }`);
  e.emit(`  pos = saved; scn = _sn; return false;`);
  e.emit(`}`);
}

// Emit parseRuleEntry (memo + context handling for pratt/left-rec rules, mirrors
// parseRule's pratt/left-rec branch) and the parse() driver.
function emitDriver(e: Emitter, a: ReturnType<typeof analyze>, entry: string) {
  e.emit(String.raw`
// parseRule for a pratt/left-rec rule: memo + context + suppress, then the core.
// The memo is per-rule arrays indexed by start pos (lazily sized to the token count,
// undefined-holed): a lookup is two array loads, a store allocates nothing — no Map
// hashing and no {node, end} wrapper per store. The core returns a node ID (or -1);
// this wrapper owns the public arena contract (push the id, return a boolean).
//
// memoExt records each entry's LOOKAHEAD EXTENT — the farthest token index the parse
// may have READ (not merely consumed) — which is what incremental invalidation must
// intersect with an edit's damage window: a PEG parse probes beyond its end (failed
// longer arms, not() lookaheads, SECOND-token dispatch). The extent comes for free
// from the global advance watermark: maxPos at frame exit, +2 covering the stop-token
// and SECOND-token reads past it. Left-to-right parsing keeps the watermark near the
// current frontier, so the value is tight on the dominant flow and only OVER-
// invalidates (soundly) near big-backtrack clusters.
function parseRuleEntry(idx: number, rid: number, name: string, core: (minBp: number) => number) {
  const mySup = suppressNext;
  suppressNext = null;
  const capped = parseLimit >= 0;
  const start = pos;
  // Capture the arrays together: a '>'-splice inside core() detaches them via
  // fill(undefined), and the store below must then write into the DETACHED arrays
  // (i.e. be discarded), exactly like the old per-rule Map did.
  let me = memoEnd[idx];
  let mn = memoNode[idx];
  let mx = memoExt[idx];
  let mg = memoGen[idx];
  const mgs = me !== undefined ? mg[start] : 0;
  // Entry validity: its own generation (negative = cycle-tainted, own-generation
  // only, and whoever reuses it inherits the taint), or — across recovery attempts
  // of one sequence — any earlier attempt's entry whose probe window is bar-free
  // (strict, context-free behavior; see memoRecFloor) and untainted.
  if (!mySup && !capped && me !== undefined && (mgs === memoGenCur
    || (recovering && (mgs === -memoGenCur
      || (mgs >= memoRecFloor && mgs < memoGenCur && !recoverFree && barFreeWin(start, mx[start])))))) {
    const e = me[start];
    if (e !== undefined) {
      if (mgs !== memoGenCur) {
        if (mgs < 0) cycleMinSerial = 0; else mg[start] = memoGenCur;
      }
      pos = e;
      // The jump SEMANTICALLY reads everything the stored parse read: keep the advance
      // watermark ≥ the entry's watermark, or an ENCLOSING rule that completes right
      // after a reused subtree stores a watermark smaller than what its result depends
      // on (including the child's own over-probing failed arms), and a later edit in
      // the gap keeps the stale entry alive. A guaranteed batch no-op: the watermark is
      // monotone and was already ≥ this value when the entry was stored.
      const ex = mx[start];
      if (ex > frameMax) { frameMax = ex; if (ex > maxPos) maxPos = ex; }
      const id = mn[start];
      if (id >= 0) {
        // refresh the reused root's transient BUILD coordinates to the current stream
        // (its green internals are position-independent; only the attachment point —
        // what the enclosing finishNode reads — must be current). start can be tokN
        // for a zero-width synthesized row minted AT EOF — toff(tokN) reads past the
        // token columns (stale slots from a longer previous document), so use the
        // same EOF guard offset() uses.
        absTok[id] = start;
        absChar[id] = start < tokN ? toff(start) : (tokN > 0 ? tend(tokN - 1) : 0);
        scPush(id);
        return true;
      }
      return false;
    }
  }
  if (!mySup && !capped && adoptRoot >= 0) {
    // map the new position into OLD token coordinates; inside the damage = no mapping
    const q = start < adoptDmgStart ? start
      : start >= adoptDmgOldEnd + adoptDelta ? start - adoptDelta : -1;
    if (q >= 0) {
      const aid = adoptSeek(q, rid);
      if (aid >= 0 && recovering && rowRM[aid] !== 0 && missAt(start + rowTokLen[aid])) {
        // RE-DERIVE (don't adopt): this recovery-made row ENDS on a recovery bar — exactly
        // where a following sibling's list-element / optional synthesis reads the per-position
        // memo that this row's interior derivation SEEDS under commitment (missRule/missTok
        // fire only when pos > probeBase, a NON-local context barsWindowEq can't see). Adopting
        // skips the interior, leaving the memo un-seeded, so the sibling synthesizes one fewer
        // $missing than a fresh parse — the incremental≢fresh divergence (#47). Synthesis only
        // fires AT a bar (recoverArmed), so a bar at this row's end is precisely the condition.
      } else if (aid >= 0 && recovering && !barsWindowEq(start, q, rowExt[aid])) {
        // bar context differs from the build run — parse this window for real
      } else if (aid >= 0) {
        pos = start + rowTokLen[aid];
        const ext = start + rowExt[aid];
        if (ext > frameMax) { frameMax = ext; if (ext > maxPos) maxPos = ext; }
        absTok[aid] = start;
        absChar[aid] = toff(start);
        if (adoptHitP >= 0) {
          adoptRunPos = pos; adoptRunRid = rid; adoptRunGen = memoGenCur;
          adoptRunP = adoptHitP; adoptRunKid = adoptHitKid + 1;
          adoptRunOq = q + rowTokLen[aid]; adoptRunBase = adoptHitBase;
        }
        if (me === undefined || me.length < tokN + 1) {
          me = new Array(tokN + 1);
          mn = new Array(tokN + 1);
          mx = new Array(tokN + 1);
          mg = new Int32Array(tokN + 1);
          memoEnd[idx] = me;
          memoNode[idx] = mn;
          memoExt[idx] = mx;
          memoGen[idx] = mg;
        }
        me[start] = pos;
        mn[start] = aid;
        mx[start] = ext;
        mg[start] = memoGenCur;
        scPush(aid);
        return true;
      }
    }
  }
  let recKey = -1;
  let mySerial = 0;
  if (recovering) {
    recKey = idx * (tokN + 1) + start;
    const rs = recRunning.get(recKey);
    if (rs !== undefined) {
      // PEG cycle refusal — record which frame it leans on: every open frame
      // entered after that one now holds a context-dependent partial result.
      if (rs < cycleMinSerial) cycleMinSerial = rs;
      return false;
    }
    mySerial = ++recSerial;
    recRunning.set(recKey, mySerial);
  }
  const prevContext = currentPrattContext;
  currentPrattContext = name;
  const prevSup = suppressCur;
  suppressCur = mySup;
  const fm0 = frameMax;
  frameMax = start;
  const cm0 = cycleMinSerial;
  if (recKey >= 0) cycleMinSerial = 0x7fffffff;
  let result;
  try {
    result = core(0);
  } finally {
    currentPrattContext = prevContext;
    suppressCur = prevSup;
    if (recKey >= 0) recRunning.delete(recKey);
  }
  let tainted = false;
  if (recKey >= 0) {
    // Tainted iff some cycle refusal inside this frame leaned on an ancestor of
    // the frame itself (entered strictly before it). Fold the minimum outward:
    // a refusal that taints this frame taints every enclosing one too.
    tainted = cycleMinSerial < mySerial;
    if (cm0 < cycleMinSerial) cycleMinSerial = cm0;
  }
  if (result < 0 && recovering) result = missRule(rid);
  if (!mySup && !capped) {
    if (me === undefined || me.length < tokN + 1) {
      me = new Array(tokN + 1);
      mn = new Array(tokN + 1);
      mx = new Array(tokN + 1);
      mg = new Int32Array(tokN + 1);
      memoEnd[idx] = me;
      memoNode[idx] = mn;
      memoExt[idx] = mx;
      memoGen[idx] = mg;
    }
    me[start] = pos;
    mn[start] = result;
    mx[start] = frameMax;     // the TRUE probe watermark — the +2 read slack (stop token,
                              // SECOND-token dispatch) is applied at INVALIDATION time
    mg[start] = tainted ? -memoGenCur : memoGenCur;
    if (result >= 0) {
      rowOK[result] = 1;
      // a context-tainted result (cycle refusal leaning on an ancestor) is also
      // untrustworthy as a ROW: stamp rowRM bit 2 so adoption refuses it — the
      // memo stamp alone only protects the entry, not the row adoptSeek can find
      if (tainted) rowRM[result] |= 2;
      // The row's OWN watermark freezes at finishNode — for a Pratt rule that is
      // BEFORE the failed LED extension arms run (the NUD/shorter row survives the
      // longest-match), so rowExt under-records the rule's true probe extent and a
      // later edit inside a failed arm's reads would not invalidate an adoption.
      // The memo watermark (maxPos at exit) is the truth — write it back to the
      // row, where adoption can see it after the memo generation dies. (This also
      // covers recovering-built rows: a fire that cut a losing arm short is still
      // bounded by the recorded probes, so no mode stamp is needed for adoption —
      // rowRM stays purely structural for the diagnostics walk.)
      const re = frameMax - start;
      if (re > rowExt[result]) rowExt[result] = re;
    }

  }
  if (fm0 > frameMax) frameMax = fm0;
  if (result >= 0) { scPush(result); return true; }
  return false;
}

// Token text at an arbitrary index (cold paths: errors, the tokenAt debug view).
function tokTextAt(i: number) {
  return ${e.soa ? 'docText(toff(i), tend(i))' : 'tkText[i]'};
}
// The k → type-name inverse, for reconstructing a token object (tokenAt).
const K_NAMES: string[] = [];
for (const [n, k] of TYPE_KIND) K_NAMES[k] = n;
// A per-token object view over the columns (gates / debugging — the parser never builds these).
export function tokenAt(i: number) {
  return {
    type: K_NAMES[tkK[i]] ?? '',
    text: tokTextAt(i),
    offset: toff(i),
    k: tkK[i],
    t: tkT[i],
    newlineBefore: (tkFl[i] & 1) !== 0,
    commentBefore: (tkFl[i] & 2) !== 0,
    multilineFlowBefore: (tkFl[i] & 4) !== 0,
  };
}

// The CST is span-only: a node's text is derived from the source it was parsed from.
// ── Arena tree access ──
// The arena IS the tree: parse() returns the root node id and consumers traverse
// via visit()/the accessors — nothing is materialized on the parse path. All views
// are valid until the NEXT parse (the columns are reused).
function leafTokenType(entry: number, tokBase: number) {
  const tok = tokBase + ((~entry) >>> 2);
  const kind = (~entry) & 3;
  return kind === 1 ? '$keyword'
    : kind === 2 ? '$operator'
    : tkK[tok] === K_PUNCT ? '$punct'
    : (K_NAMES[tkK[tok]] ?? '');
}
// Raw arena accessors. An ENTRY is a node id (>= 0) or a leaf (< 0, token-encoded);
// offsetOf/endOf/textOf accept either.
// GREEN accessors: positions are RELATIVE — a node knows (rel, len) against its
// parent and (tokRel, tokLen) in tokens; consumers descend with (charBase, tokBase)
// — the node's own absolute start coordinates. Leaf spans come from the token
// columns at tokBase + the entry's node-relative token index.
export const tree = {
  ruleNameOf: (id: number) => RULE_DISPLAY[rowRule[id]],
  ruleIdOf: (id: number) => rowRule[id],
  lenOf: (id: number) => rowLen[id],
  tokLenOf: (id: number) => rowTokLen[id],
  // a node CHILD's relative coordinates live on the parent edge (kids-parallel)
  childRelAt: (id: number, i: number) => kcr(id, rowStart[id] + i),
  childTokRelAt: (id: number, i: number) => ktr(id, rowStart[id] + i),
  // base-threaded spans: nodes from their bases, leaves from the token columns
  offsetOf: (entry: number, charBase: number, tokBase: number) => entry >= 0 ? charBase : toff(tokBase + ((~entry) >>> 2)),
  endOf: (entry: number, charBase: number, tokBase: number) => entry >= 0 ? charBase + rowLen[entry] : tend(tokBase + ((~entry) >>> 2)),
  childCount: (id: number) => rowCount[id],
  childAt: (id: number, i: number) => kids[rowStart[id] + i],
  // Bulk child load into a caller-owned array; returns the count. One call per node
  // instead of childCount+childAt-per-probe (the generated matchers' hot path).
  childrenInto: (id: number, out2: number[]) => {
    const n2 = rowCount[id];
    const cs2 = rowStart[id];
    for (let i2 = 0; i2 < n2; i2++) out2[i2] = kids[cs2 + i2];
    return n2;
  },
  isLeaf: (entry: number) => entry < 0,
  leafToken: (entry: number, tokBase: number) => tokBase + ((~entry) >>> 2),
  leafTokenType,
  // Int-world leaf accessors (the match-path encoding): kind bits — 0 type-derived,
  // 1 '$keyword', 2 '$operator' — and the token's TYPE kind int (1 = punctuation).
  leafKindOf: (entry: number) => (~entry) & 3,
  leafTokKindOf: (entry: number, tokBase: number) => tkK[tokBase + ((~entry) >>> 2)],
  leafOffsetOf: (entry: number, tokBase: number) => toff(tokBase + ((~entry) >>> 2)),
  leafEndOf: (entry: number, tokBase: number) => tend(tokBase + ((~entry) >>> 2)),
  textOf: (entry: number, source: string, charBase: number, tokBase: number) => entry >= 0
    ? source.slice(charBase, charBase + rowLen[entry])
    : source.slice(toff(tokBase + ((~entry) >>> 2)), tend(tokBase + ((~entry) >>> 2))),
};
// Depth-first traversal from a node id or leaf entry:
//   enter(id)         — each NODE before its children; return false to skip its subtree
//   leave(id)         — each node after its children
//   leaf(entry, tok)  — each leaf (tok = its token index)
// Depth-first traversal threading the RED coordinates: enter/leave receive the
// node's absolute (charBase, tokBase); leaf receives its absolute token index.
// Call with the root only — the bases default from the root's rel fields.
type _VisitFns = { enter?: (id: number, charBase: number, tokBase: number) => boolean | void; leave?: (id: number, charBase: number, tokBase: number) => void; leaf?: (entry: number, tok: number) => void };
function visitCore(entry: number, fns: _VisitFns, charBase?: number, tokBase?: number) {
  if (charBase === undefined) { charBase = rootCharBase; tokBase = rootTokBase; }
  if (entry < 0) { if (fns.leaf) fns.leaf(entry, tokBase! + ((~entry) >>> 2)); return; }
  if (fns.enter && fns.enter(entry, charBase, tokBase!) === false) return;
  const n = rowCount[entry];
  const cs = rowStart[entry];
  for (let i = 0; i < n; i++) {
    const e = kids[cs + i];
    if (e < 0) { if (fns.leaf) fns.leaf(e, tokBase! + ((~e) >>> 2)); }
    else visitCore(e, fns, charBase + kcr(entry, cs + i), tokBase! + ktr(entry, cs + i));
  }
  if (fns.leave) fns.leave(entry, charBase, tokBase!);
}

// Parse to the ARENA: returns the root node id.
function lexInto(source: string) {
${e.soa ? `  tokenize(source);
  docEmptyPops = lexEmptyPops.slice();` : String.raw`  docPieces = [source]; docPieceOff = [0]; docLen = source.length; docFlat = source; docCur = 0;
  const _toks = tokenize(source);
  const _n = _toks.length;
  while (tkCap < _n + 1) growTok();
  tkText.length = 0;
  for (let _i = 0; _i < _n; _i++) {
    const _t = _toks[_i];
    tkK[_i] = _t.k; tkT[_i] = _t.t; tkOff[_i] = _t.offset; tkEnd[_i] = _t.offset + _t.text.length;
    tkFl[_i] = (_t.newlineBefore ? 1 : 0) | (_t.commentBefore ? 2 : 0) | (_t.multilineFlowBefore ? 4 : 0);
    tkDp[_i] = 0; tkPd[_i] = 0;
    tkText[_i] = _t.text;
  }
  tokN = _n;`}
}

function farthest(errPos: number) {
  if (maxPos <= errPos || maxPos >= tokN) return '';
  return ' [farthest: offset ' + toff(maxPos) + " near '" + tokTextAt(maxPos).slice(0, 20) + "']";
}

// Run the entry rule over the CURRENT token stream (shared by parse / parseEdited —
// everything per-parse EXCEPT the memo and the arena cursor, which parseEdited carries).
function runParse(entryRule?: string) {
  pos = 0;
  maxPos = 0;
  frameMax = 0;
  recRunning.clear();
  recSerial = 0;
  cycleMinSerial = 0x7fffffff;
  parseLimit = -1;
  cap = tokN;
  currentPrattContext = null;
  suppressNext = null;
  suppressCur = null;
  scn = 0;
  const entry = entryRule ?? ENTRY;
  if (tokN === 0) {
    const rid = RULE_NAMES.indexOf(entry);
    const er = finishNode(rid < 0 ? 0 : rid, scn);
    rootCharBase = absChar[er]; rootTokBase = absTok[er];
    return er;
  }
  if (!RULES[entry]()) {
    if (!recovering || !recoverArmed(pos, maxPos)) {
      const hasTok = pos < cap;
      throw new Error('Parse error at offset ' + (hasTok ? toff(pos) : 0) + ': unexpected ' + (hasTok ? "'" + tokTextAt(pos) + "'" : 'end of input') + farthest(pos));
    }
    const mark = scn;
    const from = pos;
    while (pos < tokN) { scPush(~(pos << 2)); pos++; }
    if (pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }
    docDiags.push({ offset: from < tokN ? toff(from) : 0, end: tokN > 0 ? tend(tokN - 1) : 0, message: 'no parse' });
    scPush(finishNode(RID_ERROR, mark));
  }
  if (pos < tokN) {
    if (!recovering || !recoverArmed(pos, maxPos)) {
      throw new Error('Parse error at offset ' + toff(pos) + ": unexpected '" + tokTextAt(pos) + "' after successful parse" + farthest(pos));
    }
    // absorb the unconsumed tail and WRAP [root, tail] — only non-repetition entry
    // rules can get here (a rep entry absorbs at its own level)
    const mark = scn;
    const from = pos;
    while (pos < tokN) { scPush(~(pos << 2)); pos++; }
    if (pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }
    docDiags.push({ offset: toff(from), end: tend(tokN - 1), message: "unexpected '" + tokTextAt(from) + "' after successful parse" });
    scPush(finishNode(RID_ERROR, mark));
    scPush(finishNode(RID_ERROR, 0));
  }
  const rootId = sc[--scn];
  rootCharBase = absChar[rootId]; rootTokBase = absTok[rootId];
  return rootId;
}

// Source of the last COMPLETED parse — the token columns, arena and memo describe it.
// null whenever the module state is not a coherent snapshot (no parse yet, or the last
// attempt threw), so parseEdited falls back to a full parse.

// the LAST parse root's absolute coordinates (the descent origin — see visit/toObject)
let rootCharBase = 0;
let rootTokBase = 0;

// ── M4: old-tree ADOPTION (cursor reuse) ──
// During an incremental re-parse, a rule entry first asks the PREVIOUS tree: is there
// an old node of this rule starting at the corresponding old position whose lookahead
// stayed clear of the damage? Adoption is STATELESS — nothing is consumed, so PEG
// backtracking needs no cursor rollback, and a node refused under one candidate arm
// can be adopted by the next. The memo stays purely intra-parse.
let lastRoot = -1;           // previous parse's root id + its absolute first token
let lastRootTok = 0;
let adoptRoot = -1;          // previous root id (-1 = no adoption)
let adoptRootTok = 0;        // its absolute first token (old coords)
let adoptDmgStart = 0;       // damage window in OLD token coords: [adoptDmgStart, adoptDmgOldEnd)
let adoptDmgOldEnd = 0;
let adoptDelta = 0;          // new-minus-old token delta past the damage
// cached descent path (top-down): ids + their absolute old token bases
let adoptPath: number[] = [];
let adoptBase: number[] = [];
// run-extension state: where the last single adoption sat in the old tree (its
// parent row / kid index / parent token base), published by adoptSeek, plus the
// (pos, rid, generation) signature a repetition must present to consume it.
let adoptHitP = -1, adoptHitKid = 0, adoptHitBase = 0;
let adoptRunPos = -1, adoptRunRid = -1, adoptRunGen = -1;
let adoptRunP = -1, adoptRunKid = 0, adoptRunOq = 0, adoptRunBase = 0;
function adoptSeek(q: number, rid: number) {
  // reuse the cached path while it still CONTAINS q (strictly inside, not at start)
  let depth = 0;
  while (depth < adoptPath.length) {
    const id = adoptPath[depth];
    const b = adoptBase[depth];
    if (b < q && q < b + rowTokLen[id]) depth++;
    else break;
  }
  adoptPath.length = depth;
  adoptBase.length = depth;
  let id: number, base: number;
  if (depth === 0) {
    if (q < adoptRootTok || q >= adoptRootTok + rowTokLen[adoptRoot]) return -1;
    id = adoptRoot; base = adoptRootTok;
    if (base === q) { /* root itself starts at q — fall through to the chain walk */ }
    adoptPath.push(id); adoptBase.push(base);
  } else {
    id = adoptPath[depth - 1]; base = adoptBase[depth - 1];
  }
  // descend: containment steps are committed to the cache; the exploratory chain of
  // nodes starting EXACTLY at q is walked in locals (a later seek with another rule
  // must see the same chain).
  for (;;) {
    // binary search the first child whose END exceeds q
    const cs = rowStart[id];
    const n = rowCount[id];
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const e = kids[cs + mid];
      const end = e < 0 ? base + ((~e) >>> 2) + 1 : base + ktr(id, cs + mid) + rowTokLen[e];
      if (end <= q) lo = mid + 1; else hi = mid;
    }
    if (lo >= n) return -1;
    const e = kids[cs + lo];
    if (e < 0) return -1;                                  // the position is a leaf here
    const cb = base + ktr(id, cs + lo);
    if (cb > q) return -1;                                 // a gap — nothing starts at q
    if (cb === q) {
      // the exploratory chain: every node from here down whose start is exactly q
      adoptHitP = id; adoptHitKid = cs + lo; adoptHitBase = base;
      let xid = e, xb = cb;
      for (;;) {
        if (rowOK[xid] !== 0 && rowRule[xid] === rid
            && ((recovering ? rowRM[xid] & 2 : rowRM[xid]) === 0)
            && (q + rowExt[xid] + 2 <= adoptDmgStart || q >= adoptDmgOldEnd)) {
          return xid;
        }
        const xcs = rowStart[xid];
        if (rowCount[xid] === 0) return -1;
        const fe = kids[xcs];
        if (fe < 0 || ktr(xid, xcs) !== 0) return -1;
        adoptHitP = -1;
        xid = fe; xb = xb;
      }
    }
    // containment: commit and descend
    id = e; base = cb;
    adoptPath.push(id); adoptBase.push(base);
  }
}
// ── Error recovery (the TOTAL second pass) ──
// parse/edit never crash on input: the strict pass runs first (valid inputs take it
// exclusively — byte-identical trees, full PEG alternative exploration), and only a
// strict REJECT re-parses with the recovering flag set. Failing elements absorb
// tokens into $error rows (their leaves keep the CST text-tiling invariant); what
// went wrong lands in docDiags — the cst.errors field.
let recovering = false;
// cst.errors — a VIEW rebuilt per parse/edit from two sources (array identity is
// stable; contents are spliced in place):
//   docLex: STRUCTURED lexer diagnostics (kind + position), persistent across edits
//     (shifted like any suffix span; the damage window's re-lex replaces its range).
//     Messages are FORMATTED at settle time with the CURRENT offset — a stored
//     message string would embed a stale offset after shifts.
//   parser diagnostics: derived from the TREE — fresh $error rows via the surviving
//     recovery candidates, ADOPTED ones by walking the rowRM-marked subtrees that
//     adoption reused this pass (a recovering pass adopts error regions wholesale,
//     so per-pass collection alone would silently drop their diagnostics). docPar
//     keeps the formatted result for the paths that do not re-parse (surgery).
let docDiags: Diag[] = [];
let docLex: LexDiag[] = [];
let docPar: Diag[] = [];

function lexMsg(g: LexDiag) {
  if (g.kind === 0) return "Unexpected character at offset " + g.offset + ": '" + g.ch + "'";
  if (g.kind === 1) return 'Invalid escape sequence in template at offset ' + g.offset;
  if (g.kind === 2) return 'Unterminated template literal at offset ' + g.offset;
  if (g.kind === 3) return "Invalid identifier escape at offset " + g.offset + ": '" + g.ch + "'";
  return g.ch;   // kind 4: a verbatim engine message (the totality net)
}
// ── Recovery BARS: the discipline that keeps recovery equivalence-safe ──
// A repetition element fails constantly during ORDINARY parsing (a statement list
// legitimately ends at 'case'; a losing longest-match arm fails mid-probe). Letting
// recovery fire at any failure absorbs valid text and RESCUES losing arms — and the
// incremental side, which adopts strictly-parsed rows instead of re-probing them,
// would diverge from a fresh recovering parse. Recovery therefore only fires at
// positions a STRICT pass has proven to fail: each attempt runs strictly except at
// the ordered bar list (fire when probing reaches the bar, then disarm); a failure
// past the last bar aborts the attempt, appends the new farthest-fail bar, and the
// pass re-runs (adoption keeps re-runs cheap). Bars are text-determined, so fresh
// and incremental recovering parses are byte-identical by construction.
let recoverBars: number[] = [];
// (rule, pos) frames currently ON THE STACK during a recovering run, keyed to
// their entry SERIAL. Token synthesis makes zero-width matches possible, so a rule
// can re-enter itself at the SAME position through a synthesized leading token —
// an unbounded recursion no grammar check can rule out. A re-entered (rule, pos)
// frame fails (PEG cycle semantics). Recovering runs also open the first-token
// dispatch guards, so a guard-free ref chain can cycle at one position WITHOUT any
// synthesis — the refusal then depends on which frames are on the stack, i.e. the
// failing result is a function of the frame's ANCESTORS, not of the text alone.
// Strict runs never consult this (zero hot-path cost).
const recRunning = new Map();
let recSerial = 0;
// Minimum entry-serial referenced by any cycle refusal during the current frame's
// core (0x7fffffff = none). A refusal leaning on a frame entered BEFORE the current
// one (serial < the frame's own) taints the frame: its memo entry is valid only
// where the same ancestors are guaranteed — within its own generation — never
// across attempts. Internal cycles (both ends inside the frame) replay from the
// window text alone and do not taint.
let cycleMinSerial = 0x7fffffff;
// First memo generation of the CURRENT recovery attempt sequence (0x7fffffff =
// none active). Attempts in one sequence parse the SAME token stream under a
// monotonically growing bar list, so an entry from an earlier attempt is valid in
// a later one iff its probe window saw NO bars — no bars means no synthesis and no
// skip arming (both require a window bar), and the open dispatch guards only add
// non-consuming probes, so the frame behaved strictly: a pure function of the
// window text, stable under any bar list that stays out of the window.
let memoRecFloor = 0x7fffffff;
function barFreeWin(s: number, m: number) {
  const hi = m + 2;
  for (let i = 0; i < recoverBars.length; i++) {
    const b = recoverBars[i];
    if (b > hi) break;
    if (b >= s) return false;
  }
  return true;
}
let recoverFree = false;   // iteration-cap fallback: fire at any failure (still deterministic)
// Missing-token synthesis (the tsc parseExpected analog): at a bar-adjacent failure
// of a REQUIRED literal/token match, materialize a zero-width $missing row instead
// of failing the construct — the structure completes (a call keeps its Call shape
// with the ')' marked missing) and the diagnostic reads "expected 'x'". The firing
// condition is a PURE FUNCTION of (position, bar list): pos within a fixed window
// below a bar — no counters, no maxPos (a global budget threads non-local state
// through the parse and desynchronizes adopted regions; the first attempt at this
// proved it with the cross-grammar gate). probing>0 marks failure-tolerated probes
// (not(), sep delimiters, optionals) where synthesis would flip semantics. The
// zero-width spin is killed structurally: recovering repetition loops DISCARD
// zero-width elements (hooked elements are non-nullable — only synthesis can make
// them zero-width).
let probing = 0;
// Innermost ACTIVE optional-probe start (-1 = none). Synthesis inside an optional
// group is allowed only once the group consumed past this (committed) — failures
// of an uncommitted probe are ordinary "the optional thing isn't there".
let probeBase = -1;
function missAt(p2: number) {
  for (let i = 0; i < recoverBars.length; i++) {
    const b = recoverBars[i];
    if (b > p2 + 2) break;
    if (p2 <= b && b <= p2 + 2) return true;
  }
  return false;
}
function missTok(t: number, vs?: number) {
  if (probing !== 0 || pos <= probeBase || recoverFree || !missAt(pos)) return false;
  const id = finishNode(RID_MISSING, scn);
  rowStart[id] = vs ? t | (vs << 21) : t;
                      // expected identity: >0 literal int, <0 named token kind,
                      // >= RULE_MISS_BASE a missing NONTERMINAL (rid offset);
                      // bits 21+ carry the call site's viable-set id when the
                      // grammar proves companion literals still accepted here.
                      // A zero-kid row never dereferences its kids base, so the
                      // slot is free storage.
  scPush(id);
  return true;
}
// Missing-NONTERMINAL synthesis (the tsc "Expression expected" analog): a REQUIRED
// rule reference failing inside the bar window stands in as a zero-width $missing
// row carrying the rule identity. Same purity rules as missTok. Returns the node
// id (not pushed — call sites differ) or -1.
const RULE_MISS_BASE = 1 << 20;
function missRule(rid: number) {
  if (probing !== 0 || pos <= probeBase || recoverFree || !missAt(pos)) return -1;
  const id = finishNode(RID_MISSING, scn);
  rowStart[id] = RULE_MISS_BASE + rid;
  return id;
}

// Collect $error rows under an adopted recovery-made subtree: offset/end from the
// row spans, the message re-derived from the first absorbed token — byte-identical
// to what recoverSkip emitted when the row was built.
// Collect every $error row in the FINAL tree by descending only the recovery-made
// spine (rowRM propagates structurally at finishNode): O(error paths), no global
// walk, no per-candidate bookkeeping — losing-arm rows are simply unreachable.
// Decode a $missing row's packed expected identity (see missTok): bits 21+ carry
// the call site's viable-set id; bit 20 marks a missing nonterminal; else a plain
// literal int (>0) or a named token kind (<0).
function missLit(v: number) {
  if (v >= 1 << 21) return v & 0xFFFFF;
  return v > 0 && v < RULE_MISS_BASE ? v : 0;
}
function missEntry(v: number, kb: number): Diag {
  let message;
  if (v >= 1 << 21) message = 'expected ' + VSETS[v >>> 21];
  else if (v >= RULE_MISS_BASE) message = 'expected ' + RULE_DISPLAY[v - RULE_MISS_BASE];
  else if (v > 0) message = "expected '" + LIT_NAMES[v] + "'";
  else message = "expected '" + (K_NAMES[-v] ?? '?') + "'";
  return { offset: kb, end: kb, message };
}
function collectErrRows(id: number, charBase: number, tokBase: number) {
  if (rowRule[id] === RID_MISSING) {
    docPar.push(missEntry(rowStart[id], charBase));
    return;
  }
  if (rowRule[id] === RID_ERROR) {
    const fe = rowCount[id] > 0 ? kids[rowStart[id]] : 0;
    if (fe < 0) {
      // plain absorb: kids are raw tokens — the message quotes the first one
      const ft = tokBase + ((~fe) >>> 2);
      docPar.push({ offset: charBase, end: charBase + rowLen[id], message: "unexpected '" + docText(toff(ft), tend(ft)) + "'" });
      return;
    }
    // WRAPPER shape (the runParse leftover net wraps [partial-root, tail-$error]):
    // the first kid is a NODE — decoding it as a token leaf reads a garbage column
    // (the message then quotes text from an unrelated offset, and differently per
    // text layer). Fall through to the generic descent: each kid derives its own
    // diagnostics, the tail $error quoting its real first token.
    if (rowCount[id] === 0) return;
  }
  const cs = rowStart[id], n = rowCount[id];
  for (let i = 0; i < n; i++) {
    const e = kids[cs + i];
    if (e >= 0 && ((rowRM[e] & 1) !== 0 || rowRule[e] >= RID_ERROR)) {
      if (rowRule[e] === RID_MISSING) {
        // a missing CLOSER names its matched opener (tsc's "to match this '('"):
        // PAIR_OPEN holds the grammar-derived structural pair, and the opener leaf
        // — if the construct really matched one — sits among the earlier siblings
        const entry = missEntry(rowStart[e], charBase + kcr(id, cs + i));
        // a missing CLOSER names its matched opener (tsc's "to match this '('"):
        // PAIR_OPEN holds the grammar-derived structural pair, and the opener leaf
        // — if the construct really matched one — sits among the earlier siblings
        const lt = missLit(rowStart[e]);
        if (lt > 0 && PAIR_OPEN[lt] !== 0) {
          for (let j = i - 1; j >= 0; j--) {
            const ee = kids[cs + j];
            if (ee < 0) {
              const tk = tokBase + ((~ee) >>> 2);
              if (tkT[tk] === PAIR_OPEN[lt]) {
                entry.related = { offset: toff(tk), end: tend(tk), message: "to match this '" + LIT_NAMES[PAIR_OPEN[lt]] + "'" };
                break;
              }
            }
          }
        }
        docPar.push(entry);
        continue;
      }
      collectErrRows(e, charBase + kcr(id, cs + i), tokBase + ktr(id, cs + i));
    }
  }
}
// Rebuild the cst.errors view: formatted lexer diagnostics + tree-derived parser
// diagnostics (fresh survivors + adopted rowRM subtrees), ordered by offset.
function settleDiags() {
  docPar.length = 0;
  if (lastRoot >= 0 && ((rowRM[lastRoot] & 1) !== 0 || rowRule[lastRoot] >= RID_ERROR)) {
    collectErrRows(lastRoot, rootCharBase, rootTokBase);
  }
  rebuildDiagView();
}
function rebuildDiagView() {
  docDiags.length = 0;
  for (let i = 0; i < docLex.length; i++) {
    const g = docLex[i];
    docDiags.push({ offset: g.offset, end: g.end, message: lexMsg(g) });
  }
  for (let i = 0; i < docPar.length; i++) docDiags.push(docPar[i]);
  docDiags.sort((x, y) => x.offset - y.offset);
}
// Armed iff some bar lies in [pos, maxPos]: the failing element started at/before a
// proven fail point and probing reached it. STATELESS — a losing longest-match arm
// may fire and be discarded without consuming anything (backtrack-safe), legitimate
// repetition ends PAST a bar stay silent (pos > bar), and the runParse safety net
// obeys the same discipline (an ungated net would absorb on the FIRST bar-less
// attempt and pre-empt the whole iteration).
// Token indices of ')' pops that found an EMPTY paren stack, ascending (the lexer
// appends as it lexes; the window splice recomposes). Almost always empty — a
// stray closer beyond balance. The shifted lexer resync's dominant q=0 case needs
// exactly one fact about the whole old suffix ("no pop-on-empty beyond the
// candidate"), which this list answers O(1) instead of an O(suffix) min-build.
let docEmptyPops: number[] = [];
// Bar list that built lastRoot (that run's token coords); null = free-fire built
// (free-fire decisions are not bar-pure — such a tree is never adoptable while
// recovering). Strict trees carry [].
let lastBars: number[] | null = [];
// A row replays identically in a recovering run iff its window sees the SAME bars
// (shifted) the build run saw there — every recovery decision (hook arming,
// missTok/missRule, the cycle sentinel) is position-pure, so window text + window
// bars determine the frame's behavior completely.
function barsWindowEq(s: number, q: number, ext: number) {
  if (lastBars === null) return false;
  const hiN = s + ext + 2, hiO = q + ext + 2;
  let i = 0, j = 0;
  while (i < recoverBars.length && recoverBars[i] < s) i++;
  while (j < lastBars.length && lastBars[j] < q) j++;
  for (;;) {
    const a = i < recoverBars.length && recoverBars[i] <= hiN ? recoverBars[i] - s : -1;
    const b = j < lastBars.length && lastBars[j] <= hiO ? lastBars[j] - q : -1;
    if (a !== b) return false;
    if (a === -1) return true;
    i++; j++;
  }
}
function recoverArmed(from: number, reach: number) {
  // armed iff THE FAILING ELEMENT is stuck at a bar: it starts at/before the bar
  // and its OWN farthest probe sits ON it (+2 read slack). The reach is the
  // element's frame-local watermark, NOT the global maxPos — a global frontier
  // parked on a far bar must not arm unrelated loops (position-PURITY: every
  // recovery decision inside a row is a function of the row's window text and
  // the bars inside that window, which is what makes recovering adoption sound).
  if (recoverFree) return true;
  for (let i = 0; i < recoverBars.length; i++) {
    const b = recoverBars[i];
    if (from <= b && b <= reach && reach <= b + 2) return true;
    if (b > reach) break;
  }
  return false;
}
function recoverSkip(canStart: ((p: number) => boolean) | null, closerT: number, from0: number, reach: number) {
  if (!recoverArmed(from0, reach)) return false;
  if (pos >= cap) return false;
  if (closerT >= 0 && tkK[pos] === K_PUNCT && tkT[pos] === closerT) return false;
  const mark = scn;
  const from = pos;
  // the offending token is consumed unconditionally (it may well be IN the
  // element's FIRST set — the element failed past it), then run to a sync point
  scPush(~(pos << 2)); pos++;
  while (pos < cap
      && !(closerT >= 0 && tkK[pos] === K_PUNCT && tkT[pos] === closerT)
      && !(canStart !== null && canStart(pos))) {
    scPush(~(pos << 2)); pos++;
  }
  if (pos > frameMax) { frameMax = pos; if (pos > maxPos) maxPos = pos; }
  scPush(finishNode(RID_ERROR, mark));
  return true;
}

// Run-extension: a repetition whose element was just ADOPTED bulk-adopts the
// following OLD SIBLINGS in one tight loop — whole-statement reuse without
// re-entering parseRuleEntry/adoptSeek once per element. Soundness: each member
// re-passes exactly the single-adoption eligibility (same-rule row, memoized
// [rowOK], contiguous, lookahead clear of the damage), a member's existence
// proves the loop's FIRST-set guard true at its position (its first token starts
// the rule), and the loop's own continuation checks run again after the run
// breaks. Members get no memo entries — a backtracking re-probe just re-adopts.
function runExtend(rid: number) {
  if (rid !== adoptRunRid || memoGenCur !== adoptRunGen) { adoptRunPos = -1; return; }
  adoptRunPos = -1;
  const P = adoptRunP;
  const csEnd = rowStart[P] + rowCount[P];
  const pb = adoptRunBase;
  let i = adoptRunKid;
  let oq = adoptRunOq;
  let nq = pos;
  const sfx = oq >= adoptDmgOldEnd;   // past the damage: monotone, no per-member ext check
  let mp = frameMax;
  while (i < csEnd) {
    const e = kids[i];
    if (e < 0) break;
    if (pb + ktr(P, i) !== oq) break;
    if (rowRule[e] !== rid || rowOK[e] === 0) break;
    if ((recovering ? rowRM[e] & 2 : rowRM[e]) !== 0) break;
    if (recovering && !barsWindowEq(nq, oq, rowExt[e])) break;
    const tl = rowTokLen[e];
    if (tl === 0) break;
    const ex = rowExt[e];
    if (!sfx && oq + ex + 2 > adoptDmgStart) break;
    absTok[e] = nq; absChar[e] = toff(nq);
    scPush(e);
    const w = nq + ex;
    if (w > mp) mp = w;
    nq += tl; oq += tl;
    i++;
  }
  if (mp > frameMax) { frameMax = mp; if (mp > maxPos) maxPos = mp; }
  pos = nq;
}

// ── Node SURGERY: patch the damage path in place ──
// Even with run-adoption, a keystroke inside one statement of a large list rebuilds
// every node on the damage path — the list parent re-collects ALL its kids through
// scratch (and the arena grows by that much per edit). Surgery keeps those rows:
// descend the old tree to the deepest PURE container (SURG_ELEM), re-parse only the
// affected elements with the real rule fn (adoption reuses their undamaged
// subtrees), and when the fresh elements REJOIN an old kid start exactly, splice the
// container's kid range and shift the suffix rels by the edit deltas. Every check
// happens BEFORE any row is mutated; any failure falls back to the full adoption
// re-parse. Prefix kids are kept under the same watermark rule single adoption
// uses, made transitive by rowKC: each kid's probe watermark stays at/below the
// next kid's start, so checking the LAST kept kid bounds them all.
let surgX: number[] = [], surgBase: number[] = [], surgA: number[] = [], surgB: number[] = [];
// composed change envelope handed from the text-application step to the window relex
let editDmgS = 0, editDmgE = 0;
function rowKCof(id: number) {
  const c = rowKC[id];
  if (c !== 0) return c;
  const cs = rowStart[id], n = rowCount[id];
  let ok = 1, prevW = -1;
  for (let k = 0; k < n; k++) {
    const e = kids[cs + k];
    const st = e < 0 ? (~e) >>> 2 : ktr(id, cs + k);
    if (prevW > st) { ok = 2; break; }
    prevW = e < 0 ? st + 1 : st + rowExt[e];
  }
  rowKC[id] = ok;
  return ok;
}
function trySurgery(dmgA: number, dmgB: number, tokD: number, chrD: number) {
  if (adoptRoot < 0) return -1;
  if (rowRule[adoptRoot] >= RID_ERROR) return -1;
  // A recovery-made tree (rowRM root) CAN take a strict splice when the edit
  // provably commutes with every recovery decision: decisions are position-pure
  // functions of (window text, window bars), so if no bar window touches the
  // damage or the re-parsed span (second check after the re-parse, when the span's
  // probe reach is known), no decision changes - kept rows replay identically at
  // shifted positions, and a fresh recovering parse behaves strictly across the
  // span, exactly like the strict re-parse below (its first possible fire inside
  // the span would need a bar at/below the probe reach + 2). Bars adjacent to the
  // damage are unmappable across the token delta; free-fire trees (lastBars null)
  // are not window-pure - both refuse.
  const recTree = rowRM[adoptRoot] !== 0;
  if (recTree) {
    if (lastBars === null) return -1;
    for (let i = 0; i < lastBars.length; i++) {
      const b = lastBars[i];
      if (b + 2 >= dmgA && b <= dmgB + 2) return -1;
    }
  }
  // the whole-file token math must close, or the shape changed beyond a splice
  if (adoptRootTok + rowTokLen[adoptRoot] + tokD !== tokN) return -1;
  // 1. descend along single-affected-row kids, recording the path
  surgX.length = 0; surgBase.length = 0; surgA.length = 0; surgB.length = 0;
  let X = adoptRoot, base = adoptRootTok;
  for (;;) {
    const cs = rowStart[X], n = rowCount[X];
    let lo = 0, hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      const e = kids[cs + m];
      const st = base + (e < 0 ? (~e) >>> 2 : ktr(X, cs + m));
      if (st < dmgB) lo = m + 1; else hi = m;
    }
    const b = lo;
    let a = b;
    while (a > 0) {
      const e = kids[cs + a - 1];
      const st = base + (e < 0 ? (~e) >>> 2 : ktr(X, cs + a - 1));
      if (e < 0 ? st < dmgA : st + rowExt[e] + 2 <= dmgA) break;
      a--;
    }
    surgX.push(X); surgBase.push(base); surgA.push(a); surgB.push(b);
    if (b - a !== 1) break;
    const e = kids[cs + a];
    if (e < 0 || rowCount[e] === 0) break;
    base = base + ktr(X, cs + a);
    X = e;
  }
  // 2. choose D: the deepest surgical level whose affected kids are all rep rows
  let L = -1;
  for (let i = surgX.length - 1; i >= 0; i--) {
    const Xi = surgX[i];
    const elem = SURG_ELEM[rowRule[Xi]];
    if (elem < 0) continue;
    const cs = rowStart[Xi];
    const ai = surgA[i], bi = surgB[i];
    let okR = true;
    for (let k = ai; k < bi; k++) {
      const e = kids[cs + k];
      if (e < 0 || rowRule[e] !== elem) { okR = false; break; }
    }
    if (!okR) continue;
    if (bi === ai) {
      // pure insertion at a kid boundary: it must sit INSIDE the rep zone — at
      // least one neighbour is an element row. Otherwise the insertion belongs to
      // an enclosing list (e.g. right after this container's closing brace, where
      // an element-loop alignment would stitch the new element into a CLOSED node).
      const pe = ai > 0 ? kids[cs + ai - 1] : -1;
      const ne = ai < rowCount[Xi] ? kids[cs + ai] : -1;
      const prevOk = pe >= 0 && rowRule[pe] === elem;
      const nextOk = ne >= 0 && rowRule[ne] === elem;
      if (!prevOk && !nextOk) continue;
    }
    if (ai > 0 && rowKCof(Xi) !== 1) continue;
    L = i;
    break;
  }
  if (L < 0) return -1;
  const D = surgX[L], Dbase = surgBase[L], Da = surgA[L];
  const Db = surgB[L];
  // recovered trees use the length += chrD update below, which needs the node's
  // char base unchanged; at Dbase >= dmgA the base token was re-lexed and its
  // start may have moved
  if (recTree && Dbase >= dmgA) return -1;
  const elem = SURG_ELEM[rowRule[D]];
  const csD = rowStart[D], nD = rowCount[D];
  const DendNew = Dbase + rowTokLen[D] + tokD;
  // 3. re-parse the affected span with the real rule (adoption live); the first
  //    affected kid starts at/before the damage, so old == new coordinates there
  pos = Da < Db
    ? Dbase + (kids[csD + Da] < 0 ? (~kids[csD + Da]) >>> 2 : ktr(D, csD + Da))
    : dmgA;
  const s0 = pos;
  maxPos = pos; frameMax = pos; scn = 0; parseLimit = -1; cap = tokN;
  currentPrattContext = null; suppressNext = null; suppressCur = null;
  const genAt = memoGenCur;
  const fn = RULE_FN_BY_ID[elem];
  let j = Db, guard = 0;
  for (;;) {
    let target;
    if (j < nD) {
      const e = kids[csD + j];
      target = Dbase + (e < 0 ? (~e) >>> 2 : ktr(D, csD + j)) + tokD;
    } else target = DendNew;
    if (pos === target) break;
    if (pos > target) {
      // the fresh parse consumed past old kid j: only a rep row may be subsumed
      if (j >= nD) return -1;
      const e = kids[csD + j];
      if (e < 0 || rowRule[e] !== elem) return -1;
      j++;
      continue;
    }
    if (++guard > 65536) return -1;
    const pp = pos;
    if (!fn()) return -1;
    if (memoGenCur !== genAt || pos === pp) return -1;
  }
  if (recTree) {
    // the strict re-parse stands for the fresh recovering parse of this span only
    // if no bar window touches anything it read (probes included)
    for (let i = 0; i < lastBars!.length; i++) {
      const b = lastBars![i];
      const bn = b < dmgA ? b : b + tokD;
      if (bn + 2 >= s0 && bn <= maxPos + 2) return -1;
    }
  }
  // 4. POINT OF NO RETURN — splice D's kid range, shift suffix rels, patch the path
  const f = scn;
  const removed = j - Da;
  const DcharBase = toff(Dbase);
  let csD2 = csD;
  if (f === removed) {
    for (let k = 0; k < f; k++) {
      const id = sc[k];
      kids[csD + Da + k] = id;
      kidTokRel[csD + Da + k] = absTok[id] - Dbase;
      kidRel[csD + Da + k] = absChar[id] - DcharBase;
    }
  } else {
    const n2k = nD - removed + f;
    // f < removed (a SHRINK, e.g. deleting a list element) fits the OLD range in place: the
    // suffix shifts LEFT, an overlap-safe forward copy, so target csD and grow the arena by
    // nothing (issue #45 C2). f > removed (a GROW) cannot fit, so it relocates to the arena end
    // and leaves the old range as garbage the C1 compaction later reclaims. The per-kid
    // transforms — prefix normalize, new kids, suffix copy, boundary remap — are identical.
    const inPlace = f < removed;
    let ks;
    if (inPlace) { ks = csD; arenaInPlaceShrink++; }
    else { if (kidN + n2k > kidCap) growKids(n2k); ks = kidN; }
    for (let k = 0; k < Da; k++) {
      kids[ks + k] = kids[csD + k];
      // NORMALIZE prefix rels to absolute while copying: the boundary remap below
      // puts rowNF at the suffix start, so an end-relative value surviving in the
      // copied prefix would never flip down again — its decode would drift by every
      // later length update (lengths are still the OLD ones here, so the decode
      // bias matches the encoding)
      const vtr = kidTokRel[csD + k];
      if (vtr < 0) {
        kidTokRel[ks + k] = vtr + rowTokLen[D] + 1;
        kidRel[ks + k] = kidRel[csD + k] + rowLen[D] + 1;
      } else {
        kidRel[ks + k] = kidRel[csD + k];
        kidTokRel[ks + k] = vtr;
      }
    }
    for (let k = 0; k < f; k++) {
      const id = sc[k];
      kids[ks + Da + k] = id;
      kidTokRel[ks + Da + k] = absTok[id] - Dbase;
      kidRel[ks + Da + k] = absChar[id] - DcharBase;
    }
    for (let k = j; k < nD; k++) {
      kids[ks + Da + f + (k - j)] = kids[csD + k];
      kidRel[ks + Da + f + (k - j)] = kidRel[csD + k];
      kidTokRel[ks + Da + f + (k - j)] = kidTokRel[csD + k];
    }
    if (!inPlace) kidN = ks + n2k;   // in-place reuses the old range; it adds no rows
    rowStart[D] = ks;
    rowCount[D] = n2k;
    // remap the end-relative boundary into the relocated range (suffix kids kept
    // their sign-encoded values; indices shifted by the move + the count change).
    // Three cases keep it Int32-safe: no negatives among the copied kids (the
    // sentinel maps to itself, NOT through the index arithmetic), all possibly
    // negative, or a boundary inside the copied range.
    const nfOld = rowNF[D];
    rowNF[D] = nfOld >= csD + nD ? 0x7fffffff
      : nfOld <= csD + j ? ks + Da + f
      : (nfOld - csD - j) + ks + Da + f;
    csD2 = ks;
  }
  const n2 = rowCount[D];
  // End-relative band maintenance (old lengths — the bias cancels against the new
  // ones exactly like the token-level flip): rows entering the suffix flip to
  // end-relative; rows leaving it flip back to absolute rels. Rows already beyond
  // the old boundary auto-shift via the length update below. Leaf kids cannot be
  // sign-encoded (packed): inside the flip-up band they are re-packed eagerly, and
  // the trailing run (a pure container's only leaves past the rep) gets the same
  // eager shift by the backward walk.
  const bnd = csD2 + Da + f;
  const nf = rowNF[D];
  const kidsEnd = csD2 + n2;
  if (nf < bnd) {
    for (let k = nf; k < bnd; k++) {
      const v = kidTokRel[k];
      if (v < 0) { kidTokRel[k] = v + rowTokLen[D] + 1; kidRel[k] += rowLen[D] + 1; }
    }
  } else if (nf > bnd) {
    const hi = nf < kidsEnd ? nf : kidsEnd;
    for (let k = bnd; k < hi; k++) {
      const e = kids[k];
      if (e < 0) { if (tokD !== 0) kids[k] = ~(((((~e) >>> 2) + tokD) << 2) | ((~e) & 3)); }
      else {
        const v = kidTokRel[k];
        if (v >= 0) { kidTokRel[k] = v - rowTokLen[D] - 1; kidRel[k] -= rowLen[D] + 1; }
      }
    }
  }
  if (tokD !== 0) {
    const tlFrom = nf > bnd ? (nf < kidsEnd ? nf : kidsEnd) : bnd;
    for (let k = kidsEnd - 1; k >= tlFrom; k--) {
      const e = kids[k];
      if (e >= 0) break;
      kids[k] = ~(((((~e) >>> 2) + tokD) << 2) | ((~e) & 3));
    }
  }
  rowNF[D] = bnd;
  // A node whose token end lies strictly beyond the damage keeps its char end
  // shape: every end-determining coordinate (last real token, or a trailing
  // zero-width $missing kid's anchor - finishNode takes the LAST KID's end, which
  // a zero-width row can push past the last real token) sits in the suffix and
  // shifts by exactly chrD. Only a node ENDING at/inside the damage derives its
  // length from the token columns: a pure-trivia edit can sit at a node's token
  // BOUNDARY (between its last token and the next sibling's first), token-inside
  // but char-outside - the gap belongs to no node, and tend/toff give the exact
  // new span. No zero-width kid can end such a node: zero-width rows live at
  // bars, and bars adjacent to the damage were refused above.
  // ... and only while the node's char BASE is unchanged (a base token at/inside
  // the damage was re-lexed and may have moved - leading trivia inserted at a
  // node's very start shifts base and end together, leaving the LENGTH alone,
  // which is exactly what the token derivation computes)
  const keepEndD = Dbase + rowTokLen[D] > dmgB && Dbase < dmgA;
  rowTokLen[D] += tokD;
  if (keepEndD) rowLen[D] += chrD;
  else if (rowTokLen[D] > 0) rowLen[D] = tend(Dbase + rowTokLen[D] - 1) - toff(Dbase);
  {
    let x = rowExt[D] + (tokD > 0 ? tokD : 0);
    const fw = maxPos - Dbase;
    if (fw > x) x = fw;
    rowExt[D] = x;
  }
  // containment bit: only the pairs around the splice changed
  if (rowKC[D] === 1) {
    let okB = 1;
    const from = Da > 0 ? Da - 1 : 0;
    for (let k = from; k < Da + f && k + 1 < n2; k++) {
      const e = kids[csD2 + k];
      const w = e < 0 ? ((~e) >>> 2) + 1 : ktr(D, csD2 + k) + rowExt[e];
      const e2 = kids[csD2 + k + 1];
      const st2 = e2 < 0 ? (~e2) >>> 2 : ktr(D, csD2 + k + 1);
      if (w > st2) { okB = 2; break; }
    }
    rowKC[D] = okB;
  }
  // 5. ancestors bottom-up: lengths, suffix rels, ext, containment boundary pair
  for (let i = L - 1; i >= 0; i--) {
    const Ai = surgX[i];
    const csA = rowStart[Ai], nA = rowCount[Ai];
    const ki = surgA[i];
    // kids at/before the path kid are NOT suffix for this edit (the damage sits
    // inside the path kid): any end-relative rel there must flip back to absolute
    // with the OLD lengths, or the length update below would shift it
    const nfA = rowNF[Ai];
    if (nfA <= csA + ki) {
      for (let k = nfA; k <= csA + ki; k++) {
        const v = kidTokRel[k];
        if (v < 0) { kidTokRel[k] = v + rowTokLen[Ai] + 1; kidRel[k] += rowLen[Ai] + 1; }
      }
      rowNF[Ai] = csA + ki + 1;
    }
    // Suffix kids: a PURE-container ancestor (interior = element rows only, leaves
    // only as a trailing run) gets the same end-relative band as D — without it, a
    // deep edit under a giant flat list pays an O(suffix) eager walk per keystroke
    // (measured: 0.6ms median on the 9MB body as ancestor). Mixed-content ancestors
    // (interleaved leaves can't sign-encode inside the packed entry) keep the eager
    // walk; their kid counts are the grammar's non-list shapes.
    if (SURG_ELEM[rowRule[Ai]] >= 0) {
      const bndA = csA + ki + 1;
      const nfA2 = rowNF[Ai];
      const kidsEndA = csA + nA;
      if (nfA2 > bndA) {
        const hi = nfA2 < kidsEndA ? nfA2 : kidsEndA;
        for (let k = bndA; k < hi; k++) {
          const e = kids[k];
          if (e < 0) { if (tokD !== 0) kids[k] = ~(((((~e) >>> 2) + tokD) << 2) | ((~e) & 3)); }
          else {
            const v = kidTokRel[k];
            if (v >= 0) { kidTokRel[k] = v - rowTokLen[Ai] - 1; kidRel[k] -= rowLen[Ai] + 1; }
          }
        }
      }
      if (tokD !== 0) {
        const tlFrom = nfA2 > bndA ? (nfA2 < kidsEndA ? nfA2 : kidsEndA) : bndA;
        for (let k = kidsEndA - 1; k >= tlFrom; k--) {
          const e = kids[k];
          if (e >= 0) break;
          kids[k] = ~(((((~e) >>> 2) + tokD) << 2) | ((~e) & 3));
        }
      }
      rowNF[Ai] = bndA;
    } else {
      for (let k = ki + 1; k < nA; k++) {
        const e = kids[csA + k];
        if (e < 0) kids[csA + k] = ~(((((~e) >>> 2) + tokD) << 2) | ((~e) & 3));
        else if (kidTokRel[csA + k] >= 0) { kidTokRel[csA + k] += tokD; kidRel[csA + k] += chrD; }
        // (end-relative kids past the boundary auto-shift via the length update below)
      }
    }
    const keepEndA = surgBase[i] + rowTokLen[Ai] > dmgB && surgBase[i] < dmgA;   // see rowLen[D] above
    rowTokLen[Ai] += tokD;
    if (keepEndA) rowLen[Ai] += chrD;
    else if (rowTokLen[Ai] > 0) rowLen[Ai] = tend(surgBase[i] + rowTokLen[Ai] - 1) - toff(surgBase[i]);
    {
      let x = rowExt[Ai] + (tokD > 0 ? tokD : 0);
      const cw = ktr(Ai, csA + ki) + rowExt[surgX[i + 1]];
      if (cw > x) x = cw;
      rowExt[Ai] = x;
    }
    if (rowKC[Ai] === 1 && ki + 1 < nA) {
      const e2 = kids[csA + ki + 1];
      const st2 = e2 < 0 ? (~e2) >>> 2 : ktr(Ai, csA + ki + 1);
      if (ktr(Ai, csA + ki) + rowExt[surgX[i + 1]] > st2) rowKC[Ai] = 2;
    }
  }
  return adoptRoot;
}

// The spare token-column buffer set (parseEdited ping-pongs between the live set and
// this one, so steady-state edits never allocate columns).
let altK: typeof tkK | null = null, altT: typeof tkT | null = null, altOff: typeof tkOff | null = null, altEnd: typeof tkEnd | null = null, altFl: typeof tkFl | null = null, altDp: typeof tkDp | null = null, altPd: typeof tkPd | null = null;
let altCap = 0;
let altN = 0;   // old-stream token count while a window lex runs (lexCore's resync bound)

// ── Documents: the per-document state set behind the handle API ──
// The module-level variables above are the ACTIVE REGISTER SET — the hot paths
// never indirect through an object. A document object stores the same 51 fields;
// activate() lazily swaps: the active doc's object may be stale while the module
// variables are the truth, and is written back only when another doc activates.
// Per-PARSE transients (pos/maxPos/scratch/adopt*/surg*) reset on every entry and
// are shared safely.
type Diag = { offset: number; end: number; message: string; related?: { offset: number; end: number; message: string } };
type LexDiag = { offset: number; end: number; kind: number; ch: string };
type Edit = { start: number; end: number; text: string };
type Doc = {
  tkK: typeof tkK; tkT: typeof tkT; tkOff: typeof tkOff; tkEnd: typeof tkEnd; tkFl: typeof tkFl; tkDp: typeof tkDp; tkPd: typeof tkPd;
  tkCap: number; tokN: number; srcLenP1: number; negFrom: number;
  rowRule: typeof rowRule; rowLen: typeof rowLen; rowTokLen: typeof rowTokLen; rowStart: typeof rowStart; rowCount: typeof rowCount; rowExt: typeof rowExt;
  rowOK: typeof rowOK; rowKC: typeof rowKC; rowNF: typeof rowNF; rowRM: typeof rowRM; absChar: typeof absChar; absTok: typeof absTok;
  rowCap: number; nodeN: number;
  kids: typeof kids; kidRel: typeof kidRel; kidTokRel: typeof kidTokRel; kidCap: number; kidN: number;
  memoNode: number[][]; memoEnd: number[][]; memoExt: number[][]; memoGen: Int32Array[]; memoGenCur: number;
  docDiags: Diag[]; docLex: LexDiag[]; docPar: Diag[];
  docPieces: string[] | null; docPieceOff: number[] | null; docLen: number; docFlat: string | null; docCur: number;
  rootCharBase: number; rootTokBase: number; lastRoot: number; lastRootTok: number; lastBars: number[] | null; docEmptyPops: number[];
${e.soa ? '  parenCachePos: number; parenCacheStack: boolean[];' : ''}
  altK: typeof tkK | null; altT: typeof tkT | null; altOff: typeof tkOff | null; altEnd: typeof tkEnd | null; altFl: typeof tkFl | null; altDp: typeof tkDp | null; altPd: typeof tkPd | null;
  altCap: number; altN: number;
};
type Handle = { d: Doc; gen: number; root: number; errors: Diag[] };
function makeDoc(): Doc {
  return {
    tkK: new (tkK.constructor as any)(4096), tkT: new (tkT.constructor as any)(4096),
    tkOff: new Int32Array(4096), tkEnd: new Int32Array(4096), tkFl: new Uint8Array(4096),
    tkDp: new Uint8Array(4096), tkPd: new Uint16Array(4096),
    tkCap: 4096, tokN: 0, srcLenP1: 1, negFrom: 0x7fffffff,
    rowRule: new Uint16Array(8192), rowLen: new Int32Array(8192), rowTokLen: new Int32Array(8192),
    rowStart: new Int32Array(8192), rowCount: new Int32Array(8192), rowExt: new Int32Array(8192),
    rowOK: new Uint8Array(8192), rowKC: new Uint8Array(8192),
    rowNF: new Int32Array(8192).fill(0x7fffffff),
    rowRM: new Uint8Array(8192),
    absChar: new Int32Array(8192), absTok: new Int32Array(8192),
    rowCap: 8192, nodeN: 0,
    kids: new Int32Array(16384), kidRel: new Int32Array(16384), kidTokRel: new Int32Array(16384),
    kidCap: 16384, kidN: 0,
    memoNode: [], memoEnd: [], memoExt: [], memoGen: [], memoGenCur: 0,
    docDiags: [], docLex: [], docPar: [],
    docPieces: null, docPieceOff: null, docLen: 0, docFlat: null, docCur: 0,
    rootCharBase: 0, rootTokBase: 0, lastRoot: -1, lastRootTok: 0, lastBars: null, docEmptyPops: [],
${e.soa ? '    parenCachePos: -1, parenCacheStack: [],' : ''}
    altK: null, altT: null, altOff: null, altEnd: null, altFl: null, altDp: null, altPd: null,
    altCap: 0, altN: 0,
  };
}
function saveDoc(d: Doc) {
  d.tkK = tkK; d.tkT = tkT; d.tkOff = tkOff; d.tkEnd = tkEnd; d.tkFl = tkFl;
  d.tkDp = tkDp; d.tkPd = tkPd; d.tkCap = tkCap; d.tokN = tokN;
  d.srcLenP1 = srcLenP1; d.negFrom = negFrom;
  d.rowRule = rowRule; d.rowLen = rowLen; d.rowTokLen = rowTokLen; d.rowStart = rowStart;
  d.rowCount = rowCount; d.rowExt = rowExt; d.rowOK = rowOK; d.rowKC = rowKC; d.rowNF = rowNF; d.rowRM = rowRM;
  d.absChar = absChar; d.absTok = absTok; d.rowCap = rowCap; d.nodeN = nodeN;
  d.kids = kids; d.kidRel = kidRel; d.kidTokRel = kidTokRel; d.kidCap = kidCap; d.kidN = kidN;
  d.memoNode = memoNode; d.memoEnd = memoEnd; d.memoExt = memoExt; d.memoGen = memoGen;
  d.memoGenCur = memoGenCur;
  d.docDiags = docDiags; d.docLex = docLex; d.docPar = docPar;
  d.docPieces = docPieces; d.docPieceOff = docPieceOff; d.docLen = docLen; d.docFlat = docFlat; d.docCur = docCur;
  d.rootCharBase = rootCharBase; d.rootTokBase = rootTokBase;
  d.lastRoot = lastRoot; d.lastRootTok = lastRootTok; d.lastBars = lastBars; d.docEmptyPops = docEmptyPops;
${e.soa ? '  d.parenCachePos = parenCachePos; d.parenCacheStack = parenCacheStack;' : ''}
  d.altK = altK; d.altT = altT; d.altOff = altOff; d.altEnd = altEnd; d.altFl = altFl;
  d.altDp = altDp; d.altPd = altPd; d.altCap = altCap; d.altN = altN;
}
function loadDoc(d: Doc) {
  tkK = d.tkK; tkT = d.tkT; tkOff = d.tkOff; tkEnd = d.tkEnd; tkFl = d.tkFl;
  tkDp = d.tkDp; tkPd = d.tkPd; tkCap = d.tkCap; tokN = d.tokN;
  srcLenP1 = d.srcLenP1; negFrom = d.negFrom;
  rowRule = d.rowRule; rowLen = d.rowLen; rowTokLen = d.rowTokLen; rowStart = d.rowStart;
  rowCount = d.rowCount; rowExt = d.rowExt; rowOK = d.rowOK; rowKC = d.rowKC; rowNF = d.rowNF; rowRM = d.rowRM;
  absChar = d.absChar; absTok = d.absTok; rowCap = d.rowCap; nodeN = d.nodeN;
  kids = d.kids; kidRel = d.kidRel; kidTokRel = d.kidTokRel; kidCap = d.kidCap; kidN = d.kidN;
  memoNode = d.memoNode; memoEnd = d.memoEnd; memoExt = d.memoExt; memoGen = d.memoGen;
  memoGenCur = d.memoGenCur;
  docDiags = d.docDiags; docLex = d.docLex; docPar = d.docPar;
  docPieces = d.docPieces; docPieceOff = d.docPieceOff; docLen = d.docLen; docFlat = d.docFlat; docCur = d.docCur;
  rootCharBase = d.rootCharBase; rootTokBase = d.rootTokBase;
  lastRoot = d.lastRoot; lastRootTok = d.lastRootTok; lastBars = d.lastBars; docEmptyPops = d.docEmptyPops;
${e.soa ? '  parenCachePos = d.parenCachePos; parenCacheStack = d.parenCacheStack;' : ''}
  altK = d.altK; altT = d.altT; altOff = d.altOff; altEnd = d.altEnd; altFl = d.altFl;
  altDp = d.altDp; altPd = d.altPd; altCap = d.altCap; altN = d.altN;
}
const docDefault = makeDoc();
let curDoc = docDefault;
loadDoc(docDefault);
function activate(d: Doc) {
  if (d === curDoc) return;
  saveDoc(curDoc);
  loadDoc(d);
  curDoc = d;
}
function swapBuffers() {
  let x: any;
  x = tkK; tkK = altK!; altK = x;
  x = tkT; tkT = altT!; altT = x;
  x = tkOff; tkOff = altOff!; altOff = x;
  x = tkEnd; tkEnd = altEnd!; altEnd = x;
  x = tkFl; tkFl = altFl!; altFl = x;
  x = tkDp; tkDp = altDp!; altDp = x;
  x = tkPd; tkPd = altPd!; altPd = x;
  x = tkCap; tkCap = altCap; altCap = x;
}
${e.soa ? '' : 'let altText: string[] = [];'}

function parseCore(source: string, entryRule?: string) {
  adoptRoot = -1;
  adoptRunPos = -1;
  lexInto(source);
  if (memoEnd.length !== MEMO_RULES) {
    memoNode = new Array(MEMO_RULES);
    memoEnd = new Array(MEMO_RULES);
    memoExt = new Array(MEMO_RULES);
    memoGen = new Array(MEMO_RULES);
  }
  memoGenCur++;
  nodeN = 0;
  kidN = 0;
  const root = runParse(entryRule);
  lastRoot = root;
  lastRootTok = rootTokBase;
  arenaLiveBaseline = nodeN;   // the compacted live size (see arena reclamation note)
  return root;
}

// In-place diagnostic shift for a LOCALLY-strict edit (surgery): diags before the
// damage stay, diags at/after the old damage end ride the char delta, overlapping
// ones drop (their region re-parsed strictly). Splices in place — cst.errors IS
// this array.
// Parser-diag shift for the LOCALLY-strict paths (surgery / strict success): the
// LEXER list is maintained by the window block (which already dropped the re-lexed
// range and shifted the suffix — shifting here would double-apply the delta).
function shiftDiags(a: number, b: number, delta: number) {
  let w = 0;
  for (let i = 0; i < docPar.length; i++) {
    const g = docPar[i];
    if (g.end <= a) { /* kept as is */ }
    else if (g.offset >= b) { g.offset += delta; g.end += delta; }
    else continue;
    // the related anchor (the matched opener) shifts on its own coordinates — it
    // can sit on the other side of the damage from its diagnostic
    const r = g.related;
    if (r !== undefined) {
      if (r.end <= a) { /* kept */ }
      else if (r.offset >= b) { r.offset += delta; r.end += delta; }
      else g.related = undefined;   // its token was edited: stale
    }
    docPar[w++] = g;
  }
  docPar.length = w;
  rebuildDiagView();
}

// ── Incremental re-parse ──
// No edit protocol: the caller hands the NEW source; the damage window is DERIVED by
// diffing the old and new token columns (longest identical prefix; longest suffix
// identical modulo the character delta). Reuse then flows through the carried memo:
//   - prefix entries survive when their lookahead extent never reached the damage;
//   - suffix entries survive shifted by the token delta (their reads are wholly inside
//     the suffix, which is identical modulo position);
//   - damaged-region entries are dropped and re-parsed.
// The old arena is re-based in place (rows starting at/after the suffix shift by the
// char delta; reused leaf entries by the token delta; rows STARTING inside the damage
// are unreachable garbage — their values no longer matter), and new rows append after
// the old ones. A full parse() compacts (resets the arena); long edit sessions grow
// until then. Lexing is FULL-FILE by design: the lexer carries cross-token state
// (template nesting, regex context, markup modes), full lexing is a small share of a
// parse, and the diff is what localizes the damage — not the lexer.
// Last-resort totality net: a layer without recovery support threw — the handle
// API still never crashes. Zero-width $error root + the thrown message as the
// diagnostic; the next successful parse/edit resumes normal service.
function totalNet(e: any) {
  // the message lives in the SOURCE layer (docLex kind 4) — a later settle rebuilds
  // the view from the sources, and a view-only push would be wiped by it
  docLex.length = 0;
  docPar.length = 0;
  docLex.push({ offset: 0, end: 0, kind: 4, ch: String(e && e.message ? e.message : e) });
  rebuildDiagView();
  scn = 0;
  const root = finishNode(RID_ERROR, 0);
  lastRoot = root;
  lastRootTok = 0;
  lastBars = null;
  rootCharBase = 0;
  rootTokBase = 0;
  return root;
}
function apiMisuse(msg: string) {
  const e: any = new Error(msg);
  e.apiMisuse = true;
  return e;
}
function editCore(entryRule: string | undefined, edits?: Edit[]) {
  if (edits === undefined || edits.length === 0) {
    throw apiMisuse('edit() requires the changes: [{ start, end, text }] (LSP-style - each edit in the coordinates of the document AFTER the preceding edits in the array)');
  }
  // The engine owns the document text: the new source is BUILT from the changes,
  // so "the ranges do not match the text" is unrepresentable. Each edit is applied
  // sequentially (LSP incremental-sync semantics); the damage envelope is composed
  // alongside: dS in prefix coordinates (identical old/new), dE in FINAL
  // coordinates, the old end recovered through the total delta. V8 cons strings
  // make the slice+concat construction cheap; the flat-string cost, where a read
  // path needs one, is the same the caller would have paid building the text.
  if (docPieces === null) throw apiMisuse('edit() before parse(): no document');
  const oldLen = docLen;
  {
    let dS = 0x7fffffff;
    let dE = -1;
    for (let i = 0; i < edits.length; i++) {
      const ed = edits[i];
      const start = ed.start, end = ed.end, text = ed.text;
      if (!(start >= 0 && start <= end && end <= docLen) || typeof text !== 'string') {
        throw apiMisuse('edit() change #' + i + ' out of range: [' + start + ', ' + end + ') of ' + docLen);
      }
      applyChange(start, end, text);
      const newEnd = start + text.length;
      const delta = newEnd - end;
      if (dE > start) dE = dE >= end ? dE + delta : newEnd;
      if (newEnd > dE) dE = newEnd;
      if (start < dS) dS = start;
    }
    editDmgS = dS;
    editDmgE = dE;
  }

  // Damage envelope from the composed changes: prefix coordinates are shared, the
  // old end comes back through the total delta. The shared post-fork settle
  // (shiftDiags) and the soa window both read these, so they live OUTSIDE the
  // lex fork — the non-soa branch reads cs/ceOld/charDelta too.
  const newLen = docLen;
  const cs = editDmgS < newLen ? editDmgS : newLen;
  const ceNew = editDmgE < cs ? cs : editDmgE;
  const ceOld = ceNew - (newLen - oldLen);
  const charDelta = newLen - oldLen;
${e.soa ? String.raw`  // ── M1: WINDOWED re-lex ──
  // Restart anchor: the last token B ending at/before the damage whose recorded
  // depths are zero and whose shape carries no cross-token lexer flag (')' control-
  // head, postfix-ambiguous op). B = -1 restarts at the file head — always sound.
  //
  // RECOVERED streams add a constraint a strict stream never has: a lexer
  // diagnostic marks a point whose tokenization can COUPLE BACKWARD to a later
  // edit (a dangling quote pairs with a newly typed one, re-lexing everything
  // between), so the window must start below the EARLIEST such point before the
  // damage. Forward coupling needs no guard — the resync equality only accepts
  // exact re-agreement with the old stream.
  let anchorCs = cs;
  for (let i = 0; i < docLex.length; i++) if (docLex[i].offset < anchorCs) anchorCs = docLex[i].offset;
  const B = findRestart(anchorCs);
  const initParens = reconstructParensCached(B);
  const oN = tokN;
  // first old token at/after the damage end — the resync search floor
  let r0 = oN;
  { let lo = 0, hi = oN;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (toff(mid) < ceOld) lo = mid + 1; else hi = mid; }
    r0 = lo; }
  // Old-side trajectory floor across the damage itself: min recorded paren depth of
  // the OLD tokens inside [damage start, damage end) - the lexes diverge at the
  // damage start, and the resync's fast tier needs the old min from that point on.
  {
    let lo = 0, hi = r0;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (toff(mid) < cs) lo = mid + 1; else hi = mid; }
    let m = 0x7fffffff;
    for (let i = lo; i < r0; i++) if (tkPd[i] < m) m = tkPd[i];
    wndOldMin0 = m;
  }
  // Lex the window into the spare buffers (the old stream stays live for resync).
  if (altK === null || altCap < tkCap) {
    altK = new (tkK.constructor as any)(tkCap); altT = new (tkT.constructor as any)(tkCap);
    altOff = new Int32Array(tkCap); altEnd = new Int32Array(tkCap); altFl = new Uint8Array(tkCap);
    altDp = new Uint8Array(tkCap); altPd = new Uint16Array(tkCap);
    altCap = tkCap;
  }
  altN = oN;
  altSuffMin = null;          // the old-suffix min-depth cache follows the alt stream
  swapBuffers();              // live = scratch, alt = OLD stream
  tokN = 0;
  const startOff = B >= 0 ? (altEnd![B] < 0 ? altEnd![B] + srcLenP1 : altEnd![B]) : 0;
  // Window-materialized relex: lexCore reads a SMALL flat slice of the pieces with
  // an absolute bias; -2 = ran off the window end before resyncing — re-materialize
  // a larger window and retry (the common case fits the first one).
  let R0;
  const preLexN = docLex.length;   // persisted lexer diags; the window's own
                                   // emissions land after this index
  lexDiagBase = preLexN;
  {
    let wHi = ceNew + 4096;
    for (;;) {
      if (wHi > docLen) wHi = docLen;
      const windowStr = docText(startOff, wHi);
      docLex.length = preLexN;     // an aborted attempt re-lexes: drop its pushes
      tokN = 0;
      try {
        R0 = lexCore(windowStr, 0, B >= 0 ? altK![B] : -1, B >= 0 ? altT![B] : 0, r0, ceNew, charDelta, cs, initParens.slice(), startOff, wHi < docLen);
      } catch (e2) {
        if (e2 !== LEX_RETRY) {
          if (recovering) throw e2;        // a recovering lexer never throws — a bug
          recovering = true;               // lex error: the rest of this edit runs in
          continue;                        // the recovering pass (parse included)
        }
        R0 = -2;
      }
      if (R0 !== -2) break;
      wHi = wHi >= docLen ? docLen : (wHi - startOff) * 4 + startOff;
    }
  }
  const W = tokN;
  const R = R0 >= 0 ? R0 : oN;
  swapBuffers();              // live = OLD stream again; window sits in the alt buffers
  tokN = oN;
  // Persisted lexer diagnostics (AFTER the swap-back — toff must decode the OLD
  // columns, not the spare window set): entries inside the re-lexed range are
  // superseded by the window's own emissions (queued at [preLexN..)); suffix
  // entries ride the char delta; prefix entries are untouched.
  {
    const wndLo = startOff;
    const wndHiOld = R < oN ? toff(R) : oldLen;
    let w2 = 0;
    for (let i = 0; i < preLexN; i++) {
      const g = docLex[i];
      if (g.end <= wndLo) docLex[w2++] = g;
      else if (g.offset >= wndHiOld) { g.offset += charDelta; g.end += charDelta; docLex[w2++] = g; }
    }
    // window emissions sit at [preLexN..) in CURRENT coordinates — never shifted;
    // compact them down after the kept prefix
    if (w2 < preLexN) {
      for (let i = preLexN; i < docLex.length; i++) docLex[w2++] = docLex[i];
      docLex.length = w2;
    }
  }
  // EOF-relative maintenance: move the negative-zone boundary to THIS edit's suffix
  // start R. Tokens dropping out of the suffix ([negFrom, R)) flip back to absolute
  // (they sit at/before the damage now — EOF-unstable); tokens entering it
  // ([R, negFrom)) flip to EOF-relative, encoded against the OLD length (their new
  // absolute is oldValue + charDelta, and newLen = oldLen + charDelta, so the bias
  // cancels). Both bands are cursor-locality sized; the suffix itself is never
  // walked again — updating srcLenP1 after the splice IS the char-delta shift the
  // old O(suffix) add-loop used to apply.
  if (negFrom < R) {
    for (let i = negFrom, e2 = R < oN ? R : oN; i < e2; i++) {
      const o = tkOff[i]; if (o < 0) tkOff[i] = o + srcLenP1;
      const en = tkEnd[i]; if (en < 0) tkEnd[i] = en + srcLenP1;
    }
  } else if (negFrom > R) {
    for (let i = R, e2 = negFrom < oN ? negFrom : oN; i < e2; i++) {
      const o = tkOff[i]; if (o >= 0) tkOff[i] = o - srcLenP1;
      const en = tkEnd[i]; if (en >= 0) tkEnd[i] = en - srcLenP1;
    }
  }
  // TRUE token prefix p: the window re-derives [B+1 .. p) byte-identically; only past
  // p is real damage (compared BEFORE the splice clobbers the old slots).
  let p = B + 1;
  { let i = 0;
    while (i < W && p < R && altK![i] === tkK[p] && altT![i] === tkT[p] && altOff![i] === tkOff[p]
        && altEnd![i] === tkEnd[p] && altFl![i] === tkFl[p]) { i++; p++; }
  }
  const dOldEnd = R;
  const tokenDelta = (B + 1 + W) - R;
  // ── splice: old[0..B] + window[0..W) + old[R..oN), then shift the suffix spans ──
  const nN = B + 1 + W + (oN - R);
  while (tkCap < nN + 1) growTok();
  if (R !== B + 1 + W) {
    tkK.copyWithin(B + 1 + W, R, oN); tkT.copyWithin(B + 1 + W, R, oN);
    tkOff.copyWithin(B + 1 + W, R, oN); tkEnd.copyWithin(B + 1 + W, R, oN);
    tkFl.copyWithin(B + 1 + W, R, oN); tkDp.copyWithin(B + 1 + W, R, oN); tkPd.copyWithin(B + 1 + W, R, oN);
  }
  if (W > 0) {
    tkK.set(altK!.subarray(0, W), B + 1); tkT.set(altT!.subarray(0, W), B + 1);
    tkOff.set(altOff!.subarray(0, W), B + 1); tkEnd.set(altEnd!.subarray(0, W), B + 1);
    tkFl.set(altFl!.subarray(0, W), B + 1); tkDp.set(altDp!.subarray(0, W), B + 1); tkPd.set(altPd!.subarray(0, W), B + 1);
  }
  negFrom = B + 1 + W;
  srcLenP1 = newLen + 1;
  tokN = nN;
  // a SHIFTED resync adopted the suffix at a different absolute paren depth: re-base
  // the adopted depth records to the new truth ('(' head bits are unchanged - an
  // entry's head-ness is a local fact of its own neighbors)
  if (R0 >= 0 && lexResyncPd !== 0) {
    for (let i = B + 1 + W; i < nN; i++) tkPd[i] += lexResyncPd;
    lexResyncPd = 0;
  }
  // recompose the pop-on-empty index list: kept prefix + the window's own
  // (window-relative + B+1) + kept suffix riding the token delta
  {
    const nep = [];
    for (let i = 0; i < docEmptyPops.length && docEmptyPops[i] <= B; i++) nep.push(docEmptyPops[i]);
    for (let i = 0; i < lexEmptyPops.length; i++) nep.push(lexEmptyPops[i] + B + 1);
    for (let i = 0; i < docEmptyPops.length; i++) { const v = docEmptyPops[i]; if (v >= R) nep.push(v + tokenDelta); }
    docEmptyPops = nep;
  }
  const nN2 = nN;` : String.raw`  // (fallback-lexer grammars keep the full-relex + token-diff path)
  const oK = tkK, oT = tkT, oOff = tkOff, oEnd = tkEnd, oFl = tkFl, oN = tokN;
  const oText = tkText;
  if (altK === null || altK.length !== tkCap) {
    altK = new (tkK.constructor as any)(tkCap); altT = new (tkT.constructor as any)(tkCap);
    altOff = new Int32Array(tkCap); altEnd = new Int32Array(tkCap); altFl = new Uint8Array(tkCap);
    altDp = new Uint8Array(tkCap); altPd = new Uint16Array(tkCap);
  }
  tkK = altK!; tkT = altT!; tkOff = altOff!; tkEnd = altEnd!; tkFl = altFl!;
  { const _d = tkDp; tkDp = altDp!; altDp = _d; const _q = tkPd; tkPd = altPd!; altPd = _q; }
  tkText = altText; tkText.length = 0;
  altK = oK; altT = oT; altOff = oOff; altEnd = oEnd; altFl = oFl;
  altText = oText;
  docLex.length = 0;   // a FULL relex re-derives all lexer diagnostics (none, for
                       // the recovery-blind fallback lexer) — persisted entries
                       // from an earlier totality-net edit would go stale
  lexInto(flattenDoc());
  const nN = tokN;
  const minN = oN < nN ? oN : nN;
  let p = 0;
  while (p < minN && oK[p] === tkK[p] && oT[p] === tkT[p] && oFl[p] === tkFl[p]
      && oOff[p] === tkOff[p] && oEnd[p] === tkEnd[p] && oText[p] === tkText[p]) p++;
  let s = 0;
  while (s < minN - p) {
    const i = oN - 1 - s, j = nN - 1 - s;
    if (oK[i] === tkK[j] && oT[i] === tkT[j] && oFl[i] === tkFl[j]
      && oOff[i] + charDelta === tkOff[j] && oEnd[i] + charDelta === tkEnd[j] && oText[i] === tkText[j]) s++;
    else break;
  }
  const dOldEnd = oN - s;
  const tokenDelta = nN - oN;
  const nN2 = nN;`}
  // M4: NO memo carry — the memo is intra-parse; reuse flows through old-tree
  // adoption (parseRuleEntry consults the previous root via adoptSeek), so the whole
  // O(rules × n) carry/invalidate machinery is gone.
  if (memoEnd.length !== MEMO_RULES) {
    memoNode = new Array(MEMO_RULES);
    memoEnd = new Array(MEMO_RULES);
    memoExt = new Array(MEMO_RULES);
    memoGen = new Array(MEMO_RULES);
  }
  memoGenCur++;
  // C1: bound arena growth. The arena only appends across edits, so when nodeN has grown well
  // past the live tree, drop incremental reuse for THIS edit — reset the arena cursor and parse
  // the (already re-lexed) full stream with NO adoption/surgery. runParse restarts at pos 0, so
  // the result is byte-identical to a fresh parse (incremental ≡ fresh); pure reclamation, paid
  // as one slower edit. Skipped while recovering (the recovery loop owns the arena cursor).
  const compact = !recovering && nodeN > arenaLiveBaseline * arenaCompactFactor + arenaCompactMin;
  if (compact) { nodeN = 0; kidN = 0; arenaCompactions++; }
  adoptRoot = compact ? -1 : lastRoot;
  adoptRootTok = lastRootTok;
  adoptDmgStart = p;
  adoptDmgOldEnd = dOldEnd;
  adoptDelta = tokenDelta;
  adoptPath.length = 0;
  adoptBase.length = 0;
  adoptRunPos = -1;
  const sroot = (recovering || compact) ? -1 : trySurgery(p, dOldEnd, tokenDelta, charDelta);
  if (sroot >= 0) {
    adoptRoot = -1;
    rootCharBase = toff(adoptRootTok);
    rootTokBase = adoptRootTok;
    lastRoot = sroot;
    lastRootTok = adoptRootTok;
    // the spliced tree keeps its bar list (surgery proved the edit clear of every
    // bar window) - suffix bars ride the token delta like everything else
    if (lastBars !== null) {
      for (let i = 0; i < lastBars.length; i++) if (lastBars[i] >= dOldEnd) lastBars[i] += tokenDelta;
    }
    shiftDiags(cs, ceOld, charDelta);
    return sroot;
  }
  let root!: number;
  {
    // recovering may already be true here (the window relex recovered a lex error
    // and pushed its diagnostics): the first attempt then runs with EMPTY bars —
    // strict at the repetition level — and a parse failure flows into the same bar
    // iteration. Lex diagnostics are re-seeded into every attempt (the window was
    // lexed once; only the parse re-runs).
    const lexRecovered = recovering;
    const lexSnap = docLex.slice();
    try {
      root = runParse(entryRule);
      if (!lexRecovered) {
        // a strict full pass proves the document free of PARSE errors; persisted
        // lexer diagnostics (e.g. an invalid escape outside the damage — its token
        // is valid) survive with their shifted positions
        docPar.length = 0;
        rebuildDiagView();
        lastBars = [];
      } else {
        lastRoot = root;
        lastRootTok = rootTokBase;
        lastBars = [];
        settleDiags();
      }
      recovering = false;
    } catch (e) {
      // total edit: re-run the SAME spliced stream under the bar discipline.
      // Adoption stays LIVE under the bars-window predicate: a row whose window
      // saw the same (shifted) bars in the build run replays identically — all
      // recovery decisions are position-pure — so each attempt is byte-equal to
      // the fresh side's while reusing every row whose bar context matches.
      // Attempt 0 (no bars) adopts only where the build run was also bar-free.
      recovering = true;
      const bars = [];
      let done = false;
      memoRecFloor = memoGenCur + 1;   // attempts share the stream: bar-free-window
                                       // entries survive across them (see decl)
      try {
        for (let attempt = 0; attempt < 32 && !done; attempt++) {
          try {
            docLex.length = 0;
            for (let i = 0; i < lexSnap.length; i++) docLex.push(lexSnap[i]);
            recoverBars = bars;
            memoGenCur++;
            // adoptPath/adoptBase PERSIST across recovery attempts (C4): adoptRoot is the
            // pre-edit tree, fixed for the whole loop, so the navigation cache stays valid;
            // adoptSeek self-truncates to the prefix containing the new q. Bars change the
            // adoption DECISION (re-evaluated per call), not the cache. Only the per-attempt
            // run-extension state resets.
            adoptRunPos = -1;
            scn = 0;
            root = runParse(entryRule);
            done = true;
            lastBars = bars.slice();
          } catch (e2) {
            let b = maxPos;
            if (bars.length > 0 && b <= bars[bars.length - 1]) b = bars[bars.length - 1] + 1;
            bars.push(b);
          }
        }
        if (!done) {
          recoverFree = true;
          lastBars = null;
          try {
            docLex.length = 0;
            for (let i = 0; i < lexSnap.length; i++) docLex.push(lexSnap[i]);
            memoGenCur++;
            // adoptPath/adoptBase PERSIST across recovery attempts (C4): adoptRoot is the
            // pre-edit tree, fixed for the whole loop, so the navigation cache stays valid;
            // adoptSeek self-truncates to the prefix containing the new q. Bars change the
            // adoption DECISION (re-evaluated per call), not the cache. Only the per-attempt
            // run-extension state resets.
            adoptRunPos = -1;
            scn = 0;
            root = runParse(entryRule);
          } catch (e3) {
            root = totalNet(e3);
          } finally {
            recoverFree = false;
          }
        }
      } finally {
        recovering = false;
        recoverBars = [];
        memoRecFloor = 0x7fffffff;
      }
      lastRoot = root;
      lastRootTok = rootTokBase;
      settleDiags();
    }
  }
  adoptRoot = -1;
  lastRoot = root;
  lastRootTok = rootTokBase;
  if (compact) arenaLiveBaseline = nodeN;   // reset the compacted-size baseline (see C1)
  return root;
}


export { tokenize };
// ── Module-level API: the DEFAULT document (one shared session; tokenize and the
// raw tree/tokenAt views read the ACTIVE doc — they are gate/debug surfaces) ──
export function parse(source: string, entryRule?: string) { activate(docDefault); return parseCore(source, entryRule); }
export function parseEdited(entryRule?: string, edits?: Edit[]) { activate(docDefault); return editCore(entryRule, edits); }
// Arena reclamation introspection + budget override — TEST HOOKS (issue #45 C1). __arenaStats
// reports the live arena, the compacted-size baseline, and how many edits re-parsed to reclaim;
// __setArenaBudget lowers the factor/min so a gate can force compaction deterministically.
export function __arenaStats() { return { nodeN, kidN, baseline: arenaLiveBaseline, compactions: arenaCompactions, inPlaceShrink: arenaInPlaceShrink }; }
export function __setArenaBudget(factor: number, min: number) { arenaCompactFactor = factor; arenaCompactMin = min; }
export function visit(entry: number, fns: _VisitFns, charBase?: number, tokBase?: number) { activate(docDefault); return visitCore(entry, fns, charBase, tokBase); }
// ── Handle API: explicit trees over per-instance documents ──
// const p = createParser(); const cst = p.parse(text); p.edit(cst, next[, edits]);
// The handle is the STABLE IDENTITY of this document's tree: edit() mutates it in
// place (node surgery) and returns nothing — a return value would read as a clone,
// and there is none. A REJECTED edit (parse error) throws and leaves the handle on
// the previous tree; the next edit falls back to a full re-parse internally. Only
// parse() re-opening the document invalidates old handles (they throw).
export function createParser() {
  const d = makeDoc();
  let gen = 0;
  let entryUsed: string | undefined;
  const chk = (cst: Handle | null | undefined) => {
    if (cst === null || cst === undefined || cst.d !== d) throw new Error('foreign tree handle: it belongs to another parser instance');
    if (cst.gen !== gen) throw new Error('stale tree handle: parse() re-opened this document - use the handle from the latest parse()');
  };
  const view: Record<string, (a: number, b: number) => any> = {};
  for (const k of Object.keys(tree)) {
    const f = (tree as any)[k];
    view[k] = (a: number, b: number) => { activate(d); return f(a, b); };
  }
  return {
    parse(source: string, entryRule?: string) {
      activate(d);
      entryUsed = entryRule;
      gen++;   // re-opening resets the arena: old handles die regardless of outcome
      docDiags.length = 0;
      docLex.length = 0;
      docPar.length = 0;
      let root!: number;
      try {
        root = parseCore(source, entryRule);
        lastBars = [];
      } catch (e) {
        // total parse: the strict pass rejected — iterate recovery under the bar
        // discipline (see recoverBars); the iteration cap degrades to free-fire,
        // and a recovery-blind layer (fallback lexers) degrades to the zero-width
        // $error root. Never a crash.
        recovering = true;
        const bars = [];
        let done = false;
        // NO cross-attempt survival here: parseCore resets the arena cursor per
        // attempt (only parseEdited carries it), so an earlier attempt's rows are
        // clobbered — a surviving entry would point at overwritten rows.
        try {
          for (let attempt = 0; attempt < 32 && !done; attempt++) {
            try {
              docLex.length = 0;
              recoverBars = bars;
              root = parseCore(source, entryRule);
              done = true;
              lastBars = bars.slice();
            } catch (e2) {
              let b = maxPos;
              if (bars.length > 0 && b <= bars[bars.length - 1]) b = bars[bars.length - 1] + 1;
              bars.push(b);
            }
          }
          if (!done) {
            recoverFree = true;
            lastBars = null;
            adoptRoot = -1;   // free-fire decisions are non-local: adoption would desync
            try {
              docLex.length = 0;
              root = parseCore(source, entryRule);
            } catch (e3) {
              root = totalNet(e3);
            } finally {
              recoverFree = false;
            }
          }
        } finally {
          recovering = false;
          recoverBars = [];
          memoRecFloor = 0x7fffffff;
        }
        settleDiags();
      }
      return { d, gen, root, errors: docDiags };
    },
    edit(cst: Handle, edits?: Edit[]) {
      chk(cst);
      activate(d);
      try {
        cst.root = editCore(entryUsed, edits);
      } catch (e) {
        if (e instanceof RangeError || (e && (e as any).apiMisuse)) throw e;
        cst.root = totalNet(e);
      }
    },
    visit(cst: Handle, fns: _VisitFns) { chk(cst); activate(d); return visitCore(cst.root, fns); },
    tree: view,
  };
}
`);
}
