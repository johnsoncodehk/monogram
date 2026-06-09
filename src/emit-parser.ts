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

import type { CstGrammar, RuleExpr, RuleDecl, PrecLevel } from './types.ts';
import { isKeywordLiteral, collectLiterals } from './grammar-utils.ts';

// ── Static analysis (re-derived; mirrors gen-parser.ts exactly) ──

interface OpInfo {
  lbp: number;
  rbp: number;
  assoc: 'left' | 'right' | 'none';
  position: 'infix' | 'prefix' | 'postfix';
}

type FirstTok = { lit: string } | { tok: string } | null;
type MixfixInfo = { openLit: string; sepLit: string };

function hasMarker(expr: RuleExpr): boolean {
  if (expr.type === 'op' || expr.type === 'prefix' || expr.type === 'postfix') return true;
  if (expr.type === 'seq' || expr.type === 'alt') return expr.items.some(hasMarker);
  if (expr.type === 'quantifier' || expr.type === 'group') return hasMarker(expr.body);
  if (expr.type === 'sep') return hasMarker(expr.element);
  return false;
}

function findEntryRule(grammar: CstGrammar): string {
  return grammar.rules[grammar.rules.length - 1].name;
}

/** Build the full static analysis createParser performs, returned as plain data. */
function analyze(grammar: CstGrammar) {
  const tokenNames = new Set(grammar.tokens.map(t => t.name));

  // Precedence table — identical to gen-parser.ts.
  const opTable = new Map<string, OpInfo>();
  const prefixOps = new Map<string, OpInfo>();
  const noUnaryLhsOps = new Set<string>();
  const postfixOpValues = new Set<string>();
  for (let i = 0; i < grammar.precs.length; i++) {
    const level = grammar.precs[i];
    const bp = (i + 1) * 2;
    for (const op of level.operators) {
      if (op.position === 'prefix') {
        prefixOps.set(op.value, { lbp: 0, rbp: level.assoc === 'right' ? bp - 1 : bp, assoc: level.assoc, position: 'prefix' });
      } else if (op.position === 'postfix') {
        postfixOpValues.add(op.value);
        opTable.set(op.value, { lbp: bp, rbp: 0, assoc: level.assoc, position: 'postfix' });
      } else {
        const lbp = bp;
        const rbp = level.assoc === 'right' ? bp - 1 : bp;
        opTable.set(op.value, { lbp, rbp, assoc: level.assoc, position: 'infix' });
        if (op.noUnaryLhs) noUnaryLhsOps.add(op.value);
      }
    }
  }

  // Pratt rules.
  const prattRules = new Set<string>();
  for (const rule of grammar.rules) if (hasMarker(rule.body)) prattRules.add(rule.name);

  function classifyAlts(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const nuds: RuleExpr[] = [];
    const leds: { expr: RuleExpr; items: RuleExpr[] }[] = [];
    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      if (items[0]?.type === 'ref' && items[0].name === rule.name) leds.push({ expr: alt, items: items.slice(1) });
      else nuds.push(alt);
    }
    return { nuds, leds };
  }
  function classifyLeftRec(rule: RuleDecl) {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    const atoms: RuleExpr[] = [];
    const continuations: RuleExpr[][] = [];
    for (const alt of alts) {
      const items = alt.type === 'seq' ? alt.items : [alt];
      if (items[0]?.type === 'ref' && items[0].name === rule.name) continuations.push(items.slice(1));
      else atoms.push(alt);
    }
    return { atoms, continuations };
  }
  function isLeftRecursive(rule: RuleDecl): boolean {
    const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
    return alts.some(alt => {
      const items = alt.type === 'seq' ? alt.items : [alt];
      return items[0]?.type === 'ref' && items[0].name === rule.name;
    });
  }

  const maxBp = (grammar.precs.length + 1) * 2;
  const ruleByName = new Map<string, RuleDecl>(grammar.rules.map(r => [r.name, r]));
  const leftRecSet = new Set<string>(grammar.rules.filter(isLeftRecursive).map(r => r.name));
  const prattClassified = new Map<string, ReturnType<typeof classifyAlts>>();
  const leftRecClassified = new Map<string, ReturnType<typeof classifyLeftRec>>();
  for (const rule of grammar.rules) {
    if (prattRules.has(rule.name)) prattClassified.set(rule.name, classifyAlts(rule));
    else if (leftRecSet.has(rule.name)) leftRecClassified.set(rule.name, classifyLeftRec(rule));
  }

  const templateTokenName = grammar.tokens.find(t => t.template)?.name;
  const templateTokenNames = new Set<string>(grammar.tokens.filter(t => t.template).map(t => t.name));

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
  const ledMeta = new Map<string, { accessTail: boolean[]; tailClosing: boolean[]; mixfix: (MixfixInfo | null)[]; first: FirstTok[] }>();
  for (const [ruleName, { leds }] of prattClassified.entries()) {
    const accessTail: boolean[] = [];
    const tailClosing: boolean[] = [];
    const mixfix: (MixfixInfo | null)[] = [];
    const first: FirstTok[] = [];
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
    }
    ledMeta.set(ruleName, { accessTail, tailClosing, mixfix, first });
  }

  // Left-rec continuation mixfix.
  const contMeta = new Map<string, (MixfixInfo | null)[]>();
  for (const [ruleName, { continuations }] of leftRecClassified.entries()) {
    contMeta.set(ruleName, continuations.map(c => mixfixOf(c, ruleName)));
  }

  // Nullability.
  const nullableRules = new Set<string>();
  function exprNullable(e: RuleExpr): boolean {
    switch (e.type) {
      case 'literal': return false;
      case 'ref': return tokenNames.has(e.name) ? false : nullableRules.has(e.name);
      case 'seq': return e.items.every(exprNullable);
      case 'alt': return e.items.some(exprNullable);
      case 'quantifier': return e.kind === '+' ? exprNullable(e.body) : true;
      case 'group': return exprNullable(e.body);
      case 'not': return true;
      case 'sep': return true;
      default: return true;
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of grammar.rules) {
      if (!nullableRules.has(rule.name) && exprNullable(rule.body)) { nullableRules.add(rule.name); changed = true; }
    }
  }

  // FIRST sets.
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
        for (const item of e.items) {
          if (item.type === 'prefix') return null;
          if (item.type === 'op' || item.type === 'postfix' || item.type === 'not' || item.type === 'sameLine' || item.type === 'noCommentBefore' || item.type === 'noMultilineFlowBefore') continue;
          const f = exprFirst(item);
          if (f === null) return null;
          for (const k of f) acc.add(k);
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
      case 'not': case 'sameLine': case 'noCommentBefore': case 'noMultilineFlowBefore': return new Set();
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
  for (const fs of firstSets.values()) if (fs) for (const k of fs) if (!tokenNames.has(k)) allLiterals.add(k);
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
  const symtab = {
    KIND_PUNCT, KIND_TEMPLATE_HEAD, KIND_NAMED_MIN, KIND_NAMED_FALLBACK,
    typeKind, kwLitKind, puLitKind, classifyKey,
  };

  return {
    grammar, tokenNames, opTable, prefixOps, noUnaryLhsOps, postfixOpValues,
    prattRules, leftRecSet, ruleByName, prattClassified, leftRecClassified,
    maxBp, templateTokenName, templateTokenNames, firstTokenOf, altDeepFirst, altNullable,
    ledMeta, contMeta, nullableRules, firstSets, symtab,
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
  private u8Emitted = false;
  private a: ReturnType<typeof analyze>;
  constructor(a: ReturnType<typeof analyze>) { this.a = a; }
  private id() { return `_t${this.tmp++}`; }

  emit(line = '') { this.buf.push(line); }
  // The compound-matcher helpers are function declarations (hoisted), but they must sit
  // BELOW the module's import statements. The header emits a `${HELPERS}` sentinel right
  // after the imports/tables; we splice the collected helpers there.
  toString() {
    const src = this.buf.join('\n');
    return src.replace('//${HELPERS}', this.helperDefs.join('\n\n'));
  }

  // Reference to a rule's parse function (token refs are inlined where used).
  private ruleFn(name: string) { return `R_${sanitize(name)}`; }

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
    const single = this.singleLeafBody(expr, '_save');
    if (single) {
      // Matcher produces exactly one child: return the one-element array literal
      // directly, skipping the out=[] alloc + push + intermediate (these single-token
      // / single-ref arms are the hottest in the nud/alt dispatch).
      body.push(`  const _save = pos;`, single);
    } else {
      body.push(`  const _save = pos; const out = [];`);
      body.push(this.matchInto(expr, 'out', `pos = _save; return null;`));
      body.push(`  return out;`);
    }
    body.push(`}`);
    this.helperDefs.push(body.join('\n'));
    return name;
  }

  // Public wrapper so free-function emitters (emitArmNamed) can reuse the single-leaf
  // specialization.
  singleLeafBodyPublic(expr: RuleExpr, saveVar: string): string | null { return this.singleLeafBody(expr, saveVar); }

  // If `expr` matches exactly one child (a single literal, a single non-template token
  // ref, or a single rule ref — possibly wrapped in a transparent group / one-item seq),
  // return a body that yields `[leaf]` directly (matchExpr contract: pos restored on
  // failure). Else null. Byte-identical: the produced child array is the same `[x]` the
  // out=[]/push path built. Excludes template-token refs (two-branch) and suppress-groups.
  private singleLeafBody(expr: RuleExpr, saveVar: string): string | null {
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
    const onFail = `pos = ${saveVar}; return null;`;
    if (expr.type === 'literal') {
      const v = this.id();
      return `  const ${v} = ${this.matchLiteralCall(expr.value)}; if (${v} === null) { ${onFail} } return [${v}];`;
    }
    if (expr.type === 'ref') {
      if (a.tokenNames.has(expr.name)) {
        if (a.templateTokenNames.has(expr.name)) return null;   // two-branch (template) — not single-leaf
        const lf = this.id();
        return `  const ${lf} = ${this.matchTokenCall(expr.name)}; if (${lf} === null) { ${onFail} } return [${lf}];`;
      }
      // Rule ref: keep the FIRST-set guard, then the call.
      const nd = this.id();
      const guard = this.firstGuard(expr.name);
      const guardLine = guard ? `  if (${guard}) { ${onFail} }\n` : '';
      return `${guardLine}  const ${nd} = ${this.ruleFn(expr.name)}(); if (${nd} === null) { ${onFail} } return [${nd}];`;
    }
    return null;
  }

  /**
   * Generate statements that match `expr`, appending children to `out`, and on any
   * failure execute `onFail` (which restores pos + returns). Simple/flat shapes are
   * INLINED here (specialized straight-line code, no matchExpr switch); compound
   * shapes (alt / quantifier / sep / nested seq with a contained loop) delegate to a
   * generated helper fn via matchFn — keeping control flow `return`-based.
   */
  matchInto(expr: RuleExpr, out: string, onFail: string): string {
    const a = this.a;
    switch (expr.type) {
      case 'literal': {
        const v = this.id();
        return `const ${v} = ${this.matchLiteralCall(expr.value)}; if (${v} === null) { ${onFail} } ${out}.push(${v});`;
      }
      case 'ref': {
        if (a.tokenNames.has(expr.name)) {
          // Template tokens: route to parseTemplateExpr first (interpolated templates).
          if (a.templateTokenNames.has(expr.name)) {
            const tm = this.id(), lf = this.id();
            return [
              `{ const ${tm} = parseTemplateExpr(); if (${tm} !== null) { ${out}.push(${tm}); }`,
              `  else { const ${lf} = ${this.matchTokenCall(expr.name)}; if (${lf} === null) { ${onFail} } ${out}.push(${lf}); } }`,
            ].join('\n');
          }
          const lf = this.id();
          return `const ${lf} = ${this.matchTokenCall(expr.name)}; if (${lf} === null) { ${onFail} } ${out}.push(${lf});`;
        }
        // Rule ref: FIRST-set guard (ruleMightStart) baked as a direct check, then call.
        const nd = this.id();
        const guard = this.firstGuard(expr.name);
        return [
          guard ? `if (${guard}) { ${onFail} }` : ``,
          `const ${nd} = ${this.ruleFn(expr.name)}(); if (${nd} === null) { ${onFail} } ${out}.push(${nd});`,
        ].filter(Boolean).join('\n');
      }
      case 'seq': {
        // Inline each item in order; share the caller's onFail (which restores to the
        // seq's save point). matchSeq skips op/prefix/postfix markers. A nested seq is
        // flattened inline too — its failure restores to the SAME save point (the whole
        // matcher fn's _save), exactly like matchSeq's single saved/restore.
        const parts: string[] = [];
        for (const item of expr.items) {
          if (item.type === 'op' || item.type === 'prefix' || item.type === 'postfix') continue;
          parts.push(this.matchInto(item, out, onFail));
        }
        return parts.join('\n');
      }
      case 'alt': {
        // matchExpr 'alt': try each arm (a helper fn) from a shared save; first
        // non-null wins. Splicing the returned children mirrors `return result`.
        const save = this.id(), r = this.id();
        const lines: string[] = [`const ${save} = pos;`, `let ${r} = null;`];
        for (const item of expr.items) {
          const fn = this.matchFn(item);
          lines.push(`if (${r} === null) { pos = ${save}; ${r} = ${fn}(); }`);
        }
        lines.push(`if (${r} === null) { pos = ${save}; ${onFail} }`);
        lines.push(`for (let _i = 0; _i < ${r}.length; _i++) ${out}.push(${r}[_i]);`);
        return lines.join('\n');
      }
      case 'quantifier':
        return this.matchQuantifierInto(expr.body, expr.kind, out, onFail);
      case 'group': {
        // A suppress-carrying group stages the LED-connector exclusion for the next
        // parseRule, then matches its body (same as matchExpr 'group').
        const pre = (expr.suppress && expr.suppress.length)
          ? `suppressNext = new Set(${J(expr.suppress)});`
          : ``;
        return [pre, this.matchInto(expr.body, out, onFail)].filter(Boolean).join('\n');
      }
      case 'not': {
        // Zero-width negative lookahead: succeed (no children) iff body does NOT match.
        const kinds = this.notKwKinds(expr.body);
        if (kinds) {
          // Fast: one keyword-kind membership test (no body matcher / no `out` alloc per arm).
          const cond = kinds.map(k => `_tk.t === ${k}`).join(' || ');
          return `{ const _tk = peek(); if (_tk && _tk.k >= K_NAMED_MIN && (${cond})) { ${onFail} } }`;
        }
        const save = this.id(), fn = this.matchFn(expr.body), m = this.id();
        return [
          `{ const ${save} = pos; const ${m} = ${fn}(); pos = ${save};`,
          `  if (${m} !== null) { ${onFail} } }`,
        ].join('\n');
      }
      case 'sameLine':
        return `{ const _tk = peek(); if (!(_tk && !_tk.newlineBefore)) { ${onFail} } }`;
      case 'noCommentBefore':
        return `{ const _tk = peek(); if (!(_tk && !_tk.commentBefore)) { ${onFail} } }`;
      case 'noMultilineFlowBefore':
        return `{ const _tk = peek(); if (!(_tk && !_tk.multilineFlowBefore)) { ${onFail} } }`;
      case 'sep':
        return this.matchSepInto(expr.element, expr.delimiter, out, onFail);
      default:
        // op/prefix/postfix — handled by Pratt; in matchExpr these return null.
        return `{ ${onFail} }`;
    }
  }

  // Quantifier: body is matched via a helper fn (children|null), so the loop here uses
  // `return`/`break` only against ITS OWN while — no nested-loop hazard.
  private matchQuantifierInto(body: RuleExpr, kind: '*' | '+' | '?', out: string, onFail: string): string {
    const fn = this.matchFn(body);
    if (kind === '?') {
      // matchExpr(body) ?? []  → try once; on failure leave pos (the helper restored it).
      const r = this.id();
      return [
        `{ const ${r} = ${fn}();`,
        `  if (${r} !== null) for (let _i = 0; _i < ${r}.length; _i++) ${out}.push(${r}[_i]); }`,
      ].join('\n');
    }
    if (kind === '*') {
      const before = this.id(), r = this.id();
      return [
        `while (true) {`,
        `  const ${before} = pos; const ${r} = ${fn}();`,
        `  if (${r} === null) break;`,
        `  if (${r}.length === 0 && pos === ${before}) break;`,
        `  for (let _i = 0; _i < ${r}.length; _i++) ${out}.push(${r}[_i]);`,
        `}`,
      ].join('\n');
    }
    // '+': first mandatory, then the same loop.
    const first = this.id(), before = this.id(), r = this.id();
    return [
      `{ const ${first} = ${fn}(); if (${first} === null) { ${onFail} }`,
      `  for (let _i = 0; _i < ${first}.length; _i++) ${out}.push(${first}[_i]); }`,
      `while (true) {`,
      `  const ${before} = pos; const ${r} = ${fn}();`,
      `  if (${r} === null) break;`,
      `  if (${r}.length === 0 && pos === ${before}) break;`,
      `  for (let _i = 0; _i < ${r}.length; _i++) ${out}.push(${r}[_i]);`,
      `}`,
    ].join('\n');
  }

  // sep = (element (delimiter element)*)?  — never fails (matches zero elements).
  // element matched via helper fn.
  private matchSepInto(element: RuleExpr, delimiter: string, out: string, _onFail: string): string {
    const fn = this.matchFn(element);
    const first = this.id(), dl = this.id(), next = this.id();
    return [
      `{ const ${first} = ${fn}();`,
      `  if (${first} !== null) {`,
      `    for (let _i = 0; _i < ${first}.length; _i++) ${out}.push(${first}[_i]);`,
      `    while (true) {`,
      `      const _ds = pos; const ${dl} = ${this.matchLiteralCall(delimiter)}; if (${dl} === null) { pos = _ds; break; }`,
      `      const ${next} = ${fn}();`,
      `      if (${next} === null) { ${out}.push(${dl}); break; }`,
      `      ${out}.push(${dl}); for (let _i = 0; _i < ${next}.length; _i++) ${out}.push(${next}[_i]);`,
      `    }`,
      `  } }`,
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
    return `!${this.membershipFn(fs)}(peek())`;
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
    return `${this.membershipFn(fs)}(startTok)`;
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
      this.helperDefs.push(`function ${nm}(tok) { return !tok || (${kArr}[tok.k] | ${tArr}[tok.t]) !== 0; }`);
    }
    return nm;
  }

  // The first-token gate for an alt/LED whose tok is already known non-null: the same
  // two-table membership as membershipFn, open-coded (no call). null FirstTok → no gate.
  ftCond(ft: FirstTok, tokVar: string): string | null {
    if (!ft) return null;
    const key = 'tok' in ft ? ft.tok : ft.lit;
    const { kArr, tArr } = this.membershipTables(new Set([key]));
    return `(${kArr}[${tokVar}.k] | ${tArr}[${tokVar}.t]) !== 0`;
  }

  // Build (deduped) the two byte tables for a FIRST set's membership test.
  private membershipTables(fs: Set<string>): { kArr: string; tArr: string } {
    const st = this.a.symtab;
    const kOnes = new Set<number>(), tOnes = new Set<number>();
    for (const key of [...fs].sort()) {
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
    let tSize = 1;
    for (const v of st.kwLitKind.values()) tSize = Math.max(tSize, v + 1);
    for (const v of st.puLitKind.values()) tSize = Math.max(tSize, v + 1);
    return {
      kArr: this.u8Const(st.KIND_NAMED_FALLBACK + 1, [...kOnes].sort((a, b) => a - b)),
      tArr: this.u8Const(tSize, [...tOnes].sort((a, b) => a - b)),
    };
  }

  // A deduped Uint8Array const with 1s at `ones` (the byte tables behind membershipFn).
  private u8Const(size: number, ones: number[]): string {
    const key = `${size}:${ones.join(',')}`;
    let nm = this.u8Consts.get(key);
    if (!nm) {
      if (!this.u8Emitted) {
        this.helperDefs.push(`function u8(n, ones) { const a = new Uint8Array(n); for (let i = 0; i < ones.length; i++) a[ones[i]] = 1; return a; }`);
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
  matchLiteralCall(value: string): string {
    const d = this.a.symtab.classifyKey(value);
    if (d.kind === 'kw') return `matchKwLit(${J(value)}, ${d.t})`;
    if (d.kind === 'punct') return `matchPuLit(${J(value)}, ${d.t})`;
    // A literal key that classifies as a token-name (a token name used as a literal):
    // unreachable for real grammars, but stay safe via the generic matchLiteral.
    return `matchLiteral(${J(value)})`;
  }
  // Specialized token matcher call: tok.k === <name kind>.
  matchTokenCall(name: string): string {
    const k = this.a.symtab.typeKind.get(name);
    return k === undefined ? `matchLiteral(${J(name)})` : `matchTokK(${J(name)}, ${k})`;
  }
}

// ── Top-level emit ──

export function emitParser(grammar: CstGrammar): string {
  const a = analyze(grammar);
  const e = new Emitter(a);
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
  e.emit(`import { createLexer } from ${J(resolveLexerImport())};`);
  e.emit(`import { isKeywordLiteral } from ${J(resolveUtilsImport())};`);
  e.emit(``);
  e.emit(`const LEX_GRAMMAR = ${J(lexGrammar)};`);
  e.emit(`const { tokenize: _lexTokenize } = createLexer(LEX_GRAMMAR);`);
  e.emit(``);
  // ── Lever 1: integer token-kind tables (see analyze()'s symtab) ──
  // TYPE_KIND: tok.type → int. LIT_KW / LIT_PU: tok.text → keyword / punct literal int.
  // The interning wrapper below sets tok.k (type kind) + tok.t (literal kind) once per
  // token, so the per-call string dispatch becomes integer compares.
  const st = a.symtab;
  e.emit(`const TYPE_KIND = ${J(Object.fromEntries(st.typeKind))};`);
  e.emit(`const LIT_KW = ${J(Object.fromEntries(st.kwLitKind))};`);
  e.emit(`const LIT_PU = ${J(Object.fromEntries(st.puLitKind))};`);
  e.emit(`const K_PUNCT = ${st.KIND_PUNCT};`);
  e.emit(`const K_TEMPLATE_HEAD = ${st.KIND_TEMPLATE_HEAD};`);
  e.emit(`const K_NAMED_MIN = ${st.KIND_NAMED_MIN};`);
  e.emit(`const K_NAMED_FALLBACK = ${st.KIND_NAMED_FALLBACK};`);
  e.emit(``);
  // Rebuild each lexer token as ONE object literal carrying every field the parser
  // reads — type/text/offset, the int kinds k (TYPE kind: PUNCT for '' tokens, else the
  // declared/template kind, NAMED_FALLBACK for an unforeseen type) and t (LITERAL kind:
  // a '' token's text in the punct table, a named token's text in the keyword table),
  // and the three stamp flags normalized to booleans (absent ≡ false for the parser's
  // truthiness reads). One monomorphic shape from birth: the old in-place interning
  // added k/t to already-shaped tokens — two hidden-class transitions per token, and
  // that loop dominated the parse() profile.
  e.emit(String.raw`function mkTok(type, text, offset, k, t, nl, cb, mf) {
  return { type, text, offset, k, t, newlineBefore: nl, commentBefore: cb, multilineFlowBefore: mf };
}
function mkPunct(text, offset) {
  return mkTok('', text, offset, K_PUNCT, LIT_PU[text] | 0, false, false, false);
}
function tokenize(source) {
  const raw = _lexTokenize(source);
  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const ty = r.type;
    let k, t;
    if (ty === '') { k = K_PUNCT; t = LIT_PU[r.text] | 0; }
    else { k = TYPE_KIND[ty]; if (k === undefined) k = K_NAMED_FALLBACK; t = LIT_KW[r.text] | 0; }
    out[i] = mkTok(ty, r.text, r.offset, k, t,
      r.newlineBefore === true, r.commentBefore === true, r.multilineFlowBefore === true);
  }
  return out;
}`);
  e.emit(``);
  // Baked maps. Emit as object literals → Map.
  e.emit(`const opTable = new Map(${J([...a.opTable])});`);
  e.emit(`const prefixOps = new Map(${J([...a.prefixOps])});`);
  e.emit(`const noUnaryLhsOps = new Set(${J([...a.noUnaryLhsOps])});`);
  e.emit(`const postfixOpValues = new Set(${J([...a.postfixOpValues])});`);
  e.emit(`const tokenNames = new Set(${J([...a.tokenNames])});`);
  e.emit(`const templateTokenNames = new Set(${J([...a.templateTokenNames])});`);
  e.emit(`const templateTokenName = ${J(a.templateTokenName ?? null)};`);
  e.emit(`const maxBp = ${a.maxBp};`);
  e.emit(`const ENTRY = ${J(entry)};`);
  e.emit(`const prattRuleNames = new Set(${J([...a.prattRules])});`);
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
function resolveUtilsImport(): string { return pathResolve(__dir, 'grammar-utils.ts'); }

// ── Runtime: the generic engine state + control loops, emitted verbatim ──
// These are copied from gen-parser.ts so their semantics are byte-identical. The
// ONLY change: where the interpreter called matchExpr(alt)/matchSeq(items) per arm,
// these call the GENERATED per-arm matcher functions (installed via the rule fns).
function emitRuntime(e: Emitter) {
  e.emit(String.raw`
// ── per-parse state (module-level closures, reset by parse()) ──
let tokens = [];
let pos = 0;
let maxPos = 0;
let memo = new Map();
let parseLimit = -1;
let currentPrattContext = null;
let suppressNext = null;
let suppressCur = null;

function peek() {
  if (pos > maxPos) maxPos = pos;
  if (parseLimit >= 0 && pos >= parseLimit) return null;
  return tokens[pos] ?? null;
}
function offset() {
  const t = peek();
  if (t) return t.offset;
  return tokens.length > 0 ? tokens[tokens.length - 1].offset + tokens[tokens.length - 1].text.length : 0;
}
function childOffset(c) { return c.offset; }
function childEnd(c) { return c.end; }

// ── Lever 1: integer-kind matchers ──
// Keyword literal: the interpreter required tok.type !== '' && tokenNames.has(tok.type)
// && tok.text === value. With interned kinds that is tok.k >= K_NAMED_MIN (a declared
// token name; '' is PUNCT, templates are below NAMED_MIN) && tok.t === KW(value).
// Returns the SAME $keyword leaf as before. value/kw are baked by the caller.
function matchKwLit(value, kw) {
  const tok = peek();
  if (!tok) return null;
  if (tok.k >= K_NAMED_MIN && tok.t === kw) {
    pos++;
    return { kind: 'leaf', tokenType: '$keyword', text: value, offset: tok.offset, end: tok.offset + tok.text.length };
  }
  return null;
}
// Punct literal: tok.type === '' && tok.text === value, with the gt-splice fallback.
// tok.t === PU(value) is the exact-text fast path; the splice handles a longer
// gt-led token matching the gt key. value/pu are baked by the caller.
function matchPuLit(value, pu) {
  const tok = peek();
  if (!tok) return null;
  if (tok.k === K_PUNCT && tok.t === pu) {
    pos++;
    return { kind: 'leaf', tokenType: '$punct', text: value, offset: tok.offset, end: tok.offset + tok.text.length };
  }
  if (value === '>' && tok.k === K_PUNCT && tok.text.length > 1 && tok.text[0] === '>') {
    const rest = tok.text.slice(1);
    const a = mkPunct('>', tok.offset);
    const b = mkPunct(rest, tok.offset + 1);
    tokens.splice(pos, 1, a, b);
    memo.clear();
    pos++;
    return { kind: 'leaf', tokenType: '$punct', text: '>', offset: tok.offset, end: tok.offset + 1 };
  }
  return null;
}
// Generic matchLiteral kept for any unspecialized site: classify value via the baked
// tables (no per-call isKeywordLiteral / string compares) and delegate.
function matchLiteral(value) {
  const kw = LIT_KW[value];
  if (kw !== undefined) return matchKwLit(value, kw);
  return matchPuLit(value, LIT_PU[value] | 0);
}

// Match a token ref by its baked TYPE kind: tok.type === name  ⟺  tok.k === nameKind.
// (No named-token kind equals K_NAMED_FALLBACK, so an unforeseen type never matches.)
function matchTokK(name, nameKind) {
  const tok = peek();
  if (!tok) return null;
  if (tok.k === nameKind) {
    pos++;
    return { kind: 'leaf', tokenType: name, text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };
  }
  return null;
}

// (First-token / FIRST-set gating is baked at emit time: per-set _qN byte-table fns
// for rule/alt guards, and open-coded two-table loads for the LED dispatch — see
// membershipFn / ftCond in the emitter.)
function parseTemplateExpr() {
  const tok = peek();
  if (!tok) return null;
  if (tok.type === templateTokenName) {
    pos++;
    return { kind: 'leaf', tokenType: templateTokenName, text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };
  }
  if (tok.type === '$templateHead') {
    const children = [];
    pos++;
    children.push({ kind: 'leaf', tokenType: '$templateHead', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length });
    const interpRule = currentPrattContext ?? EXPR_RULE;
    while (true) {
      const exprNode = RULES[interpRule]();
      if (exprNode) children.push(exprNode);
      const next = peek();
      if (!next) break;
      if (next.type === '$templateMiddle') {
        pos++;
        children.push({ kind: 'leaf', tokenType: '$templateMiddle', text: next.text, offset: next.offset, end: next.offset + next.text.length });
        continue;
      }
      if (next.type === '$templateTail') {
        pos++;
        children.push({ kind: 'leaf', tokenType: '$templateTail', text: next.text, offset: next.offset, end: next.offset + next.text.length });
        break;
      }
      break;
    }
    const startOff = children.length > 0 ? childOffset(children[0]) : offset();
    const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();
    return { kind: 'node', rule: '$template', children, offset: startOff, end: endOff };
  }
  return null;
}
`);
}

// Emit the per-rule parse functions + the RULES dispatch table.
function emitRuleFns(e: Emitter, a: ReturnType<typeof analyze>) {
  const ruleFn = (name: string) => `R_${sanitize(name)}`;
  for (const rule of a.grammar.rules) {
    if (a.prattRules.has(rule.name)) emitPrattRule(e, a, rule);
    else if (a.leftRecSet.has(rule.name)) emitLeftRecRule(e, a, rule);
    else emitNonRecRule(e, a, rule);
  }
  // Dispatch table (string rule name → fn), for parseTemplateExpr's dynamic interp rule.
  e.emit(`const RULES = {`);
  for (const rule of a.grammar.rules) e.emit(`  ${J(rule.name)}: ${ruleFn(rule.name)},`);
  e.emit(`};`);
}

// Non-recursive rule: longest-match over alts (mirrors parseNonRec).
function emitNonRecRule(e: Emitter, a: ReturnType<typeof analyze>, rule: RuleDecl) {
  const ruleFn = `R_${sanitize(rule.name)}`;
  const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
  e.emit(`function ${ruleFn}() {`);
  e.emit(`  const saved = pos;`);
  e.emit(`  let bestNode = null; let bestPos = saved;`);
  e.emit(`  const startTok = tokens[saved] ?? null;`);
  alts.forEach((alt, i) => {
    e.emit(`  // alt ${i}`);
    e.emit(`  if (${e.altGuard(alt)}) {`);
    e.emit(`    pos = saved;`);
    e.emit(`    const children = arm_${sanitize(rule.name)}_${i}();`);
    e.emit(`    if (children !== null && pos > bestPos) {`);
    e.emit(`      const startOff = children.length > 0 ? childOffset(children[0]) : offset();`);
    e.emit(`      const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();`);
    e.emit(`      bestNode = { kind: 'node', rule: ${J(rule.name)}, children, offset: startOff, end: endOff };`);
    e.emit(`      bestPos = pos;`);
    e.emit(`    }`);
    e.emit(`  }`);
  });
  e.emit(`  if (bestNode) { pos = bestPos; return bestNode; }`);
  e.emit(`  pos = saved; return null;`);
  e.emit(`}`);
  // Arm matchers.
  alts.forEach((alt, i) => emitArm(e, a, rule.name, i, alt));
}

// Left-recursive (non-Pratt) rule: atom then continuations (mirrors parseLeftRec).
function emitLeftRecRule(e: Emitter, a: ReturnType<typeof analyze>, rule: RuleDecl) {
  const ruleFn = `R_${sanitize(rule.name)}`;
  const { atoms, continuations } = a.leftRecClassified.get(rule.name)!;
  const contMix = a.contMeta.get(rule.name)!;
  // A left-rec rule, like a Pratt rule, goes through parseRule's memo + context +
  // suppress wrapper in the interpreter — so currentPrattContext is set to this rule
  // (the template-interpolation rule resolution depends on it: a `${…}` hole inside a
  // template-literal TYPE must parse as Type, not the default expression rule).
  e.emit(`function ${ruleFn}() { return parseRuleEntry(${J(rule.name)}, ${ruleFn}_lr); }`);
  e.emit(`function ${ruleFn}_lr(_minBp) {`);
  e.emit(`  const saved = pos;`);
  e.emit(`  let node = null; let bestAtomPos = saved;`);
  e.emit(`  const startTok = tokens[saved] ?? null;`);
  atoms.forEach((atom, i) => {
    e.emit(`  if (${e.altGuard(atom)}) {`);
    e.emit(`    pos = saved;`);
    e.emit(`    const children = atom_${sanitize(rule.name)}_${i}();`);
    e.emit(`    if (children !== null && pos > bestAtomPos) {`);
    e.emit(`      const startOff = children.length > 0 ? childOffset(children[0]) : offset();`);
    e.emit(`      const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();`);
    e.emit(`      node = { kind: 'node', rule: ${J(rule.name)}, children, offset: startOff, end: endOff };`);
    e.emit(`      bestAtomPos = pos;`);
    e.emit(`    }`);
    e.emit(`  }`);
  });
  e.emit(`  if (!node) { pos = saved; return null; }`);
  e.emit(`  pos = bestAtomPos;`);
  e.emit(`  outer: while (true) {`);
  e.emit(`    const contSaved = pos;`);
  continuations.forEach((cont, i) => {
    e.emit(`    pos = contSaved;`);
    e.emit(`    { let children = cont_${sanitize(rule.name)}_${i}();`);
    if (contMix[i]) {
      e.emit(`      if (children === null) { pos = contSaved; children = matchMixfixLed_${sanitize(rule.name)}_cont_${i}(); }`);
    }
    e.emit(`      if (children !== null) {`);
    e.emit(`        node = { kind: 'node', rule: ${J(rule.name)}, children: [node, ...children], offset: node.offset, end: children.length > 0 ? childEnd(children[children.length - 1]) : node.end };`);
    e.emit(`        continue outer;`);
    e.emit(`      } }`);
  });
  e.emit(`    pos = contSaved; break;`);
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

  // R_<rule>() wraps parseRule's memo/context handling, then calls the bp-taking core.
  e.emit(`function ${ruleFn}() { return parseRuleEntry(${J(rule.name)}, ${ruleFn}_pratt); }`);
  e.emit(`function ${ruleFn}_pratt(minBp) {`);
  e.emit(`  const saved = pos;`);
  e.emit(`  let lhs = null; let bestNudPos = saved;`);
  e.emit(`  const startTok = tokens[saved] ?? null;`);
  // NUD loop.
  nuds.forEach((nud, i) => {
    const items = nud.type === 'seq' ? nud.items : [nud];
    e.emit(`  // nud ${i}`);
    e.emit(`  if (${e.altGuard(nud)}) {`);
    e.emit(`    pos = saved;`);
    if (items[0]?.type === 'prefix') {
      // prefix $ pattern: identical to parsePratt's prefix branch.
      e.emit(`    { const tok = peek();`);
      e.emit(`      if (tok) {`);
      e.emit(`        const info = prefixOps.get(tok.text);`);
      e.emit(`        if (info) {`);
      e.emit(`          pos++;`);
      e.emit(`          const opLeaf = { kind: 'leaf', tokenType: '$operator', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };`);
      e.emit(`          const rhs = ${ruleFn}_pratt(info.rbp);`);
      e.emit(`          if (rhs && pos > bestNudPos) { lhs = { kind: 'node', rule: ${J(rule.name)}, children: [opLeaf, rhs], offset: opLeaf.offset, end: rhs.end }; bestNudPos = pos; }`);
      e.emit(`        }`);
      e.emit(`      } }`);
    } else {
      e.emit(`    const children = nud_${sn}_${i}();`);
      e.emit(`    if (children !== null && pos > bestNudPos) {`);
      e.emit(`      const startOff = children.length > 0 ? childOffset(children[0]) : offset();`);
      e.emit(`      const endOff = children.length > 0 ? childEnd(children[children.length - 1]) : offset();`);
      e.emit(`      lhs = { kind: 'node', rule: ${J(rule.name)}, children, offset: startOff, end: endOff };`);
      e.emit(`      bestNudPos = pos;`);
      e.emit(`    }`);
    }
    e.emit(`  }`);
  });
  e.emit(`  if (lhs) pos = bestNudPos;`);
  e.emit(`  if (!lhs) { pos = saved; return null; }`);
  e.emit(`  let tailClosed = false;`);
  e.emit(`  while (true) {`);
  e.emit(`    const tok = peek();`);
  e.emit(`    if (!tok) break;`);
  e.emit(`    const ledSaved = pos;`);
  e.emit(`    let matched = false;`);
  // Non-op LED loop.
  leds.forEach((led, i) => {
    if (led.items[0]?.type === 'op' || led.items[0]?.type === 'postfix') return; // operator LEDs handled below
    const ft = meta.first[i];
    const conds: string[] = [];
    conds.push(`maxBp > minBp`);
    if (meta.accessTail[i]) conds.push(`!(tailClosed)`);
    // suppress: skip a LED whose first literal connector is in suppressCur.
    const firstLit = (led.items[0]?.type === 'literal') ? led.items[0].value : null;
    if (firstLit !== null) conds.push(`!(suppressCur && suppressCur.has(${J(firstLit)}))`);
    const ftc = e.ftCond(ft, 'tok');   // tok is non-null here (the loop breaks on !tok above)
    if (ftc) conds.push(ftc);
    e.emit(`    // led ${i}`);
    e.emit(`    if (!matched && ${conds.join(' && ')}) {`);
    e.emit(`      pos = ledSaved;`);
    e.emit(`      let children = led_${sn}_${i}();`);
    if (meta.mixfix[i]) {
      e.emit(`      if (children === null) { pos = ledSaved; children = matchMixfixLed_${sn}_led_${i}(); }`);
    }
    e.emit(`      if (children !== null) {`);
    e.emit(`        lhs = { kind: 'node', rule: ${J(rule.name)}, children: [lhs, ...children], offset: lhs.offset, end: children.length > 0 ? childEnd(children[children.length - 1]) : lhs.end };`);
    if (meta.tailClosing[i]) e.emit(`        tailClosed = true;`);
    e.emit(`        matched = true;`);
    e.emit(`      }`);
    e.emit(`    }`);
  });
  e.emit(`    if (matched) continue;`);
  // Operator LED ($ op $ / postfix), copied verbatim.
  e.emit(`    const tokKey = tok.text;`);
  e.emit(`    const info = opTable.get(tokKey);`);
  e.emit(`    if (info && info.lbp > minBp) {`);
  e.emit(`      if (info.position === 'postfix') {`);
  e.emit(`        if (!tailClosed) {`);
  e.emit(`          pos++;`);
  e.emit(`          const opLeaf = { kind: 'leaf', tokenType: '$operator', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };`);
  e.emit(`          lhs = { kind: 'node', rule: ${J(rule.name)}, children: [lhs, opLeaf], offset: lhs.offset, end: opLeaf.end };`);
  e.emit(`          tailClosed = true; matched = true;`);
  e.emit(`        }`);
  e.emit(`      } else {`);
  e.emit(`        if (noUnaryLhsOps.has(tokKey) && lhs.kind === 'node') {`);
  e.emit(`          const head = lhs.children[0];`);
  e.emit(`          if (head && head.kind === 'leaf' && head.tokenType === '$operator' && prefixOps.has(head.text) && !postfixOpValues.has(head.text)) { return null; }`);
  e.emit(`        }`);
  e.emit(`        pos++;`);
  e.emit(`        const opLeaf = { kind: 'leaf', tokenType: '$operator', text: tok.text, offset: tok.offset, end: tok.offset + tok.text.length };`);
  e.emit(`        const rhs = ${ruleFn}_pratt(info.rbp);`);
  e.emit(`        if (rhs) { lhs = { kind: 'node', rule: ${J(rule.name)}, children: [lhs, opLeaf, rhs], offset: lhs.offset, end: rhs.end }; matched = true; }`);
  e.emit(`        else { pos = ledSaved; }`);
  e.emit(`      }`);
  e.emit(`      if (matched) continue;`);
  e.emit(`    }`);
  e.emit(`    if (!matched) { pos = ledSaved; break; }`);
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
    emitArmNamed(e, a, `led_${sn}_${i}`, { type: 'seq', items: led.items } as RuleExpr);
    if (meta.mixfix[i]) emitMixfixLed(e, a, `matchMixfixLed_${sn}_led_${i}`, rule.name, led.items, meta.mixfix[i]!);
  });
}

// Emit `arm_<rule>_<i>()` — a matchExpr(alt) specialization returning children|null.
function emitArm(e: Emitter, a: ReturnType<typeof analyze>, ruleName: string, i: number, alt: RuleExpr) {
  emitArmNamed(e, a, `arm_${sanitize(ruleName)}_${i}`, alt);
}

// Emit a named matcher fn for `expr`: returns the matched children array or null,
// restoring pos on failure (the matchExpr/matchSeq contract).
function emitArmNamed(e: Emitter, a: ReturnType<typeof analyze>, fnName: string, expr: RuleExpr) {
  e.emit(`function ${fnName}() {`);
  const single = e.singleLeafBodyPublic(expr, '_save');
  if (single) {
    e.emit(`  const _save = pos;`);
    e.emit(single);
  } else {
    e.emit(`  const _save = pos; const out = [];`);
    e.emit(e.matchInto(expr, 'out', 'pos = _save; return null;'));
    e.emit(`  return out;`);
  }
  e.emit(`}`);
}

// Emit a specialized matchMixfixLed for a LED/cont (mirrors the interpreter's
// matchMixfixLed exactly; the rest-matching uses an inlined matchSeq of items[3:]).
function emitMixfixLed(e: Emitter, a: ReturnType<typeof analyze>, fnName: string, ruleName: string, items: RuleExpr[], info: MixfixInfo) {
  const ruleFn = `R_${sanitize(ruleName)}`;
  const restItems = items.slice(3);
  e.emit(`function ${fnName}() {`);
  e.emit(`  const saved = pos;`);
  e.emit(`  const openLeaf = ${e.matchLiteralCall(info.openLit)};`);
  e.emit(`  if (!openLeaf) { pos = saved; return null; }`);
  e.emit(`  const afterOpen = pos;`);
  e.emit(`  const operand = ${ruleFn}();`);
  e.emit(`  if (!operand) { pos = saved; return null; }`);
  e.emit(`  const greedyEnd = pos;`);
  e.emit(`  if (${e.matchLiteralCall(info.sepLit)}) { pos = saved; return null; }`);
  e.emit(`  let depth = 0; const candidates = [];`);
  e.emit(`  for (let i = afterOpen; i < greedyEnd; i++) {`);
  e.emit(`    const t = tokens[i];`);
  e.emit(`    if (t.type !== '') continue;`);
  e.emit(`    if (t.text === '(' || t.text === '[' || t.text === '{') depth++;`);
  e.emit(`    else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;`);
  e.emit(`    else if (depth === 0 && t.text === ${J(info.sepLit)}) candidates.push(i);`);
  e.emit(`  }`);
  e.emit(`  for (const sepIdx of candidates) {`);
  e.emit(`    pos = afterOpen;`);
  e.emit(`    const prevLimit = parseLimit; parseLimit = sepIdx;`);
  e.emit(`    const reOperand = ${ruleFn}();`);
  e.emit(`    parseLimit = prevLimit;`);
  e.emit(`    if (!reOperand || pos !== sepIdx) continue;`);
  e.emit(`    const sepLeaf = ${e.matchLiteralCall(info.sepLit)};`);
  e.emit(`    if (!sepLeaf) continue;`);
  // rest = matchSeq(items[3:]) — inline.
  e.emit(`    const rest = (function(){ const _save = pos; const out = [];`);
  e.emit(e.matchInto({ type: 'seq', items: restItems } as RuleExpr, 'out', 'pos = _save; return null;'));
  e.emit(`      return out; })();`);
  e.emit(`    if (rest === null) continue;`);
  e.emit(`    return [openLeaf, reOperand, sepLeaf, ...rest];`);
  e.emit(`  }`);
  e.emit(`  pos = saved; return null;`);
  e.emit(`}`);
}

// Emit parseRuleEntry (memo + context handling for pratt/left-rec rules, mirrors
// parseRule's pratt/left-rec branch) and the parse() driver.
function emitDriver(e: Emitter, a: ReturnType<typeof analyze>, entry: string) {
  e.emit(String.raw`
// parseRule for a pratt/left-rec rule: memo + context + suppress, then the core.
function parseRuleEntry(name, core) {
  const mySup = suppressNext;
  suppressNext = null;
  const capped = parseLimit >= 0;
  const start = pos;
  let m = memo.get(name);
  if (!mySup && !capped) {
    const hit = m && m.get(start);
    if (hit !== undefined) { pos = hit.end; return hit.node; }
  }
  const prevContext = currentPrattContext;
  currentPrattContext = name;
  const prevSup = suppressCur;
  suppressCur = mySup;
  let result;
  try {
    result = core(0);
  } finally {
    currentPrattContext = prevContext;
    suppressCur = prevSup;
  }
  if (!mySup && !capped) {
    if (!m) { m = new Map(); memo.set(name, m); }
    m.set(start, { node: result, end: pos });
  }
  return result;
}

export function parse(source, entryRule) {
  tokens = tokenize(source);
  pos = 0;
  maxPos = 0;
  memo = new Map();
  parseLimit = -1;
  currentPrattContext = null;
  suppressNext = null;
  suppressCur = null;

  const entry = entryRule ?? ENTRY;
  if (tokens.length === 0) {
    return { kind: 'node', rule: entry, children: [], offset: 0, end: 0 };
  }
  const result = RULES[entry]();
  if (!result) {
    const tok = peek();
    throw new Error('Parse error at offset ' + (tok?.offset ?? 0) + ': unexpected ' + (tok ? "'" + tok.text + "'" : 'end of input') + farthest(pos));
  }
  if (pos < tokens.length) {
    const tok = tokens[pos];
    throw new Error('Parse error at offset ' + tok.offset + ": unexpected '" + tok.text + "' after successful parse" + farthest(pos));
  }
  return result;

  function farthest(errPos) {
    if (maxPos <= errPos || maxPos >= tokens.length) return '';
    const tok = tokens[maxPos];
    return ' [farthest: offset ' + tok.offset + " near '" + tok.text.slice(0, 20) + "']";
  }
}

export { tokenize };
export function createParser() { return { parse, tokenize }; }
`);
}
