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
import { withAwaitYield } from './await-yield-fork.ts';
import { analyzeGrammar, findEntryRule } from './grammar-analysis.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';
import {
  tokenPatternCharLoop, tokenPatternQuoteDelimAndEscape,
  tokenPatternBlockDelimiters, tokenPatternLiteralPrefix,
} from './token-pattern.ts';

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
  | { kind: 'line'; name: string; prefix: string; skip: boolean }                         // prefix..end-of-line
  | { kind: 'block'; name: string; open: string; close: string; skip: boolean }           // open..close
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
export type Step =
  | { t: 'lit'; value: string; ttype: '$keyword' | '$punct' }   // match a literal by text
  | { t: 'tok'; name: string }                                  // match a token kind
  | { t: 'rule'; name: string }                                 // call a rule, append its node
  | { t: 'ruleBp'; name: string; bp: number }                   // call a Pratt rule at a given binding power (chain-rhs led trailing operand)
  | { t: 'star'; step: Step }                                   // repeat inner 0+
  | { t: 'opt'; steps: Step[] }                                 // optional sub-sequence
  | { t: 'sep'; elem: Step; delim: string }                     // elem (delim elem)*
  | { t: 'altlit'; opts: Lit[] }                                // inline alternation of literals (fast path)
  | { t: 'alt'; branches: Step[][]; firsts?: FirstSig[]; predictive?: boolean }                            // inline alternation of sub-sequences (backtracking unless predictive)
  | { t: 'not'; steps: Step[] }                                 // zero-width negative lookahead (consumes nothing)
  | { t: 'seq'; steps: Step[] }                                 // a grouped sub-sequence (e.g. a star body `(',' Expr)`)
  | { t: 'sameLine' }                                           // zero-width: the next token is on the same line (no preceding newline)
  | { t: 'suppress'; connectors: string[]; steps: Step[] };     // parse the body with these LED connectors disabled (no-`in` context)
export type Alt = Step[];

export type RdRule = { kind: 'rd'; name: string; cstName: string; alts: Alt[]; altFirst: FirstSig[]; predictive: boolean };
export type Bracket = { first: string; steps: Step[] };          // a literal-led sequence (grouping/array; LED call/index)
export type PrattRule = {
  kind: 'pratt';
  name: string;       // the (possibly $A/$Y-forked) rule name — used for the parse fn names
  cstName: string;    // the CANON name — the CST node label (a fork collapses to its base)
  nudToks: string[];                                  // NUD: a bare token wrapped in a node
  nudBrackets: Bracket[];                             // NUD: '(' … ')' / '[' … ']'
  nudSeqs: Step[][];                                  // NUD: a general sequence (guarded ident, class expr), tried with backtracking
  nudSeqFirst: FirstSig[];                            // parallel to nudSeqs: each seq's FIRST signature (null = unpredictable)
  nudSeqPredictive: boolean;                          // all nudSeqs non-null & pairwise disjoint → render a switch
  nudCapped: Array<{ steps: Step[]; capBp: number }>; // NUD: an assignment-level capped sequence (arrow function) — parsed only when minBp < capBp, admits no led
  nudCappedFirst: FirstSig[];                         // parallel to nudCapped: each capped seq's FIRST signature
  prefix: Array<{ op: string; rbp: number }>;         // NUD: prefix op then operand at rbp
  binary: Array<{ op: string; lbp: number; rbp: number }>;  // LED: infix op, bind iff lbp > minBp, rhs at rbp
  leds: Bracket[];                                    // LED: mixfix continuation (call/member/index), tried before operators
  ledAccessTail: boolean[];                           // parallel to leds: a "closed punct-connector" tail (member/call/index) — disabled once a postfix binds
  ledLbp: Array<number | null>;                       // parallel to leds: precedence gate (ternary/in/instanceof) — bind only when lbp > minBp; null = bind maximally tight
  ledSameLine: boolean[];                             // parallel to leds: a leading `sameLine` guard (TS type tails) — the connector must be on the operand's line
  ledNotLeftLeaf: Array<string[] | null>;             // parallel to leds: skip this led when the left node's head-leaf text is in this set (`void.x` etc.)
  postfixToks: string[];                              // LED: a postfix token `$ X` (e.g. a tagged template), tried like a mixfix led (also an access tail)
  postfix: Array<{ op: string; lbp: number }>;        // LED: a postfix operator `$ ++` — binds iff lbp > minBp + !tailClosed, no rhs, closes the tail
};
export type RuleIR = RdRule | PrattRule;

// Stateful regex-vs-division disambiguation (the JS `/` problem): a `/` starts a regex
// literal in expression context but is division after a value. The lexer threads the
// previous token + a control-head paren stack to decide; the predicate sets are baked
// from the grammar's `regexContext`. Mirrors gen-lexer.ts's prevIsValue exactly.
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
// The parser assembles head·expr·(middle·expr)*·tail into a synthetic `$template` node.
export type TplCfg = {
  token: string;        // the token flagged `template`; its NoSubstitution form is a plain leaf
  open: string;         // `` ` ``
  interpOpen: string;   // `${`
  interpClose: string;  // `}`
  braceOpen: string;    // `{` — a nested one deepens the hole, so its `}` is not the closer
  interpRule: string;   // the rule that parses each `${…}` hole (the Pratt expression rule)
};

// Newline-only mode (gen-lexer.ts L236–253, L677–747): engine-emitted NEWLINE tokens at
// significant line boundaries; flowOpen/flowClose suspend; comment-only lines are skipped.
export type NewlineCfg = {
  token: string;
  flowOpen: string[];
  flowClose: string[];
  comment: string | null;
};

export type ParserIR = {
  grammarName: string;
  entry: string;
  tokens: LexTok[];      // for the char scanner, tried in declaration order
  puncts: string[];      // punctuation literals, longest-first (maximal munch)
  rules: RuleIR[];
  regexCtx: RegexCtx | null;   // null unless the grammar has a regex token with context
  tpl: TplCfg | null;          // null unless the grammar has a template token
  newlineCfg: NewlineCfg | null;  // null unless the grammar declares `newline`
};

// The target-agnostic parse plan for a grammar. Applies the [Await]/[Yield] context fork
// exactly as createParser does (so `await`/`yield` are keywords inside async/generator bodies
// and identifiers outside — name-forked into $A/$Y/$AY rule families), then builds the IR each
// portable Target (ts/go/rust) renders. The `Target` contract itself lives in emit.ts.
export function portableIR(grammar: CstGrammar): ParserIR {
  return buildIR(withAwaitYield(grammar));
}

// ── buildIR: grammar + analysis → the target-agnostic parse plan ──

function isNeverPat(p: TokenPattern): boolean {
  return typeof p !== 'string' && p.type === 'never';
}

function buildIR(grammar: CstGrammar): ParserIR {
  if (grammar.indent) {
    throw new Error('portable: indent-sensitive grammars are out of scope (use the interpreter path); declare `newline` without `indent` for line-boundary-only mode');
  }

  const a = analyzeGrammar(grammar);
  const tokenNames = a.tokenNames;

  // Engine-emitted tokens (`never()` pattern — NEWLINE in newline mode) are excluded from the
  // char scanner; the target lexer state machine emits them instead.
  const tokens: LexTok[] = grammar.tokens.filter((t) => !isNeverPat(t.pattern)).map((t) => lexTok(t));
  const lits = new Set<string>();
  for (const r of grammar.rules) for (const l of collectLiterals(r.body)) lits.add(l);
  for (const lv of grammar.precs) for (const o of lv.operators) lits.add(o.value);
  const puncts = [...lits].filter((l) => !isKeywordLiteral(l)).sort((x, y) => y.length - x.length);

  const litTtype = (v: string): '$keyword' | '$punct' => (isKeywordLiteral(v) ? '$keyword' : '$punct');

  // RuleExpr → Step. `selfName` (when set) maps a self-ref to a fresh rule call.
  function stepOf(e: RuleExpr): Step {
    switch (e.type) {
      case 'literal': return { t: 'lit', value: e.value, ttype: litTtype(e.value) };
      case 'ref': return tokenNames.has(e.name) ? { t: 'tok', name: e.name } : { t: 'rule', name: e.name };
      case 'group': {   // transparent (ctxMode is invisible to the portable parser)
        const ss = altSteps(e.body);
        if (e.suppress && e.suppress.length) return { t: 'suppress', connectors: e.suppress, steps: ss };   // no-`in` context
        return ss.length === 1 ? ss[0] : { t: 'seq', steps: ss };
      }
      case 'not': return { t: 'not', steps: altSteps(e.body) };   // zero-width negative lookahead
      case 'sameLine': return { t: 'sameLine' };                  // zero-width no-newline assertion
      case 'seq': return { t: 'seq', steps: e.items.map(stepOf) };  // grouped sub-sequence (star/sep body)
      case 'sep': return { t: 'sep', elem: stepOf(e.element), delim: e.delimiter };
      case 'quantifier':
        if (e.kind === '*') return { t: 'star', step: stepOf(e.body) };
        if (e.kind === '?') return { t: 'opt', steps: altSteps(e.body) };
        if (e.kind === '+') return { t: 'seq', steps: [stepOf(e.body), { t: 'star', step: stepOf(e.body) }] };   // x+ = x x*
        break;
      case 'alt': {
        if (e.items.every((it) => it.type === 'literal')) {   // fast path: all-literal alternation
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

  const rules: RuleIR[] = grammar.rules.map((r) => {
    const cstName = (r as { canon?: string }).canon ?? r.name;   // a forked $A/$Y rule labels its CST node with the base name
    // Pratt rules AND left-recursive non-Pratt rules (e.g. NewTarget, TS Type) both parse as
    // atom-then-continuation: buildPratt detects `startsSelf` and splits accordingly, so routing
    // left-recursive rules through it avoids the infinite left-recursion a plain rd rule would hit.
    if (a.prattRules.has(r.name) || a.leftRecSet.has(r.name)) return buildPratt(r.name, cstName, r.body, a, stepOf, altSteps, litTtype);
    return { kind: 'rd', name: r.name, cstName, alts: r.body.type === 'alt' ? r.body.items.map(altSteps) : [altSteps(r.body)], altFirst: [], predictive: false };
  });

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
      case 'lit': return { lits: [s.value], toks: [] };
      case 'tok': return { lits: [], toks: [s.name] };
      case 'altlit': return { lits: s.opts.map((o) => o.value), toks: [] };
      case 'rule': case 'ruleBp': { const f = ruleLead.get(s.name); return f === undefined ? null : f; }
      case 'alt': {
        const lits = new Set<string>(); const toks = new Set<string>();
        for (const b of s.branches) { const f = seqFirst(b); if (f === null) return null; f.lits.forEach((x) => lits.add(x)); f.toks.forEach((x) => toks.add(x)); }
        return { lits: [...lits], toks: [...toks] };
      }
      case 'seq': return seqFirst(s.steps);
      case 'suppress': return seqFirst(s.steps);
      case 'not': case 'sameLine': case 'star': case 'opt': case 'sep': return null;   // zero-width / nullable leading → unpredictable
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
  // Two signatures are disjoint iff they share no literal text and no token kind.
  const disjoint = (a: FirstSig, b: FirstSig): boolean =>
    a !== null && b !== null && a.lits.every((x) => !b.lits.includes(x)) && a.toks.every((x) => !b.toks.includes(x));
  const allDisjoint = (fs: FirstSig[]): boolean => {
    for (let i = 0; i < fs.length; i++) if (fs[i] === null) return false;
    for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) if (!disjoint(fs[i], fs[j])) return false;
    return true;
  };
  // Annotate each rule's alt-level FIRST + predictive flag, and walk nested Steps to annotate
  // inline `alt` branches (used by Phase 3's nested switch dispatch).
  const annotateSteps = (steps: Step[]): void => {
    for (const s of steps) {
      if (s.t === 'star') annotateSteps([s.step]);
      else if (s.t === 'opt' || s.t === 'not' || s.t === 'seq' || s.t === 'suppress') annotateSteps(s.steps);
      else if (s.t === 'sep') annotateSteps([s.elem]);
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
      r.alts.forEach(annotateSteps);
    } else {
      r.nudSeqFirst = r.nudSeqs.map((seq) => seqFirst(seq));
      r.nudSeqPredictive = allDisjoint(r.nudSeqFirst);
      r.nudCappedFirst = r.nudCapped.map((c) => seqFirst(c.steps));
      r.nudSeqs.forEach(annotateSteps);
      r.nudCapped.forEach((c) => annotateSteps(c.steps));
      r.nudBrackets.forEach((b) => annotateSteps(b.steps));
      r.leds.forEach((b) => annotateSteps(b.steps));
    }
  }

  // Regex-vs-division context (only if the grammar declares a regex token + config).
  let regexCtx: RegexCtx | null = null;
  const rxTok = grammar.tokens.find((t) => t.flags.includes('regex'));
  const rxCfg = grammar.tokens.find((t) => t.regexContext)?.regexContext;
  if (rxTok && rxCfg) {
    regexCtx = {
      regexToken: rxTok.name,
      identToken: grammar.tokens.find((t) => t.identifier)?.name ?? '',
      divisionTypes: [...(rxCfg.divisionAfterTypes ?? [])],
      divisionTexts: [...(rxCfg.divisionAfterTexts ?? [])],
      regexTexts: [...(rxCfg.regexAfterTexts ?? [])],
      parenHeadKw: [...(rxCfg.regexAfterParenKeywords ?? [])],
      memberAccess: [...(rxCfg.memberAccessTexts ?? [])],
      postfixAfterValue: [...(rxCfg.postfixAfterValueTexts ?? [])],
    };
  }

  // Template literals (only if the grammar declares a template token). The interpolation
  // holes are parsed by the Pratt expression rule — the rule that carries operator leds.
  let tpl: TplCfg | null = null;
  const tplTok = grammar.tokens.find((t) => t.template);
  if (tplTok && tplTok.template) {
    const prattName = rules.find((r) => r.kind === 'pratt')?.name;
    if (!prattName) throw new Error('portable: a template token needs a Pratt expression rule to parse its interpolations');
    tpl = {
      token: tplTok.name,
      open: tplTok.template.open,
      interpOpen: tplTok.template.interpOpen,
      interpClose: tplTok.template.interpClose,
      braceOpen: tplTok.template.interpOpen.slice(-1),
      interpRule: prattName,
    };
  }

  // The [Await]/[Yield] fork names rules `Expr$A`/`Expr$Y` — `$` is a valid TS identifier but
  // NOT a Go/Rust one. Sanitize every rule-IDENTIFIER use (`$`→`_`) for the emitted parse-fn
  // names; the CST node label (cstName) keeps the canon base name, so the tree is unchanged.
  const san = (n: string) => n.replace(/\$/g, '_');
  const sanStep = (s: Step): void => {
    if (s.t === 'rule' || s.t === 'ruleBp') s.name = san(s.name);
    else if (s.t === 'star') sanStep(s.step);
    else if (s.t === 'opt' || s.t === 'not' || s.t === 'seq' || s.t === 'suppress') s.steps.forEach(sanStep);
    else if (s.t === 'sep') sanStep(s.elem);
    else if (s.t === 'alt') s.branches.forEach((b) => b.forEach(sanStep));
  };
  for (const r of rules) {
    r.name = san(r.name);
    if (r.kind === 'rd') r.alts.forEach((alt) => alt.forEach(sanStep));
    else {
      r.nudBrackets.forEach((b) => b.steps.forEach(sanStep));
      r.nudSeqs.forEach((seq) => seq.forEach(sanStep));
      r.nudCapped.forEach((c) => c.steps.forEach(sanStep));
      r.leds.forEach((b) => b.steps.forEach(sanStep));
    }
  }
  if (tpl) tpl.interpRule = san(tpl.interpRule);

  let newlineCfg: NewlineCfg | null = null;
  if (grammar.newline) {
    const nc = grammar.newline;
    newlineCfg = {
      token: nc.token,
      flowOpen: [...(nc.flowOpen ?? [])],
      flowClose: [...(nc.flowClose ?? [])],
      comment: nc.comment ?? null,
    };
    // Prefix-ambiguous rd alts (e.g. Ident vs Ident '(' … ')') are ordered longest-first so
    // first-match backtracking agrees with the interpreter's longest-match rd parse (gen-parser.ts).
    for (const r of rules) {
      if (r.kind !== 'rd' || r.alts.length < 2) continue;
      const order = r.alts.map((_, i) => i).sort((a, b) => r.alts[b].length - r.alts[a].length);
      if (order.every((v, i) => v === i)) continue;
      r.alts = order.map((i) => r.alts[i]);
      r.altFirst = order.map((i) => r.altFirst[i]);
    }
  }

  return { grammarName: grammar.name ?? 'grammar', entry: san(findEntryRule(grammar)), tokens, puncts, rules, regexCtx, tpl, newlineCfg };
}

// Classify a token: a fast-path shape (run/string/line/block) when one cleanly matches,
// otherwise the general `pattern` matcher. The fast paths keep the common simple tokens
// (and the calc/minijs grammars) on tight, readable scan code in every target.
function lexTok(t: TokenDecl): LexTok {
  const skip = t.flags.includes('skip');
  const qs = tokenPatternQuoteDelimAndEscape(t);
  if (qs) return { kind: 'string', name: t.name, delim: qs.delim, skip };
  const bd = tokenPatternBlockDelimiters(t);
  if (bd) return { kind: 'block', name: t.name, open: bd[0], close: bd[1], skip };
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
  const line = lineCommentShape(t.pattern);   // PRECISE: prefix-literal then star(non-newline)
  if (line) return { kind: 'line', name: t.name, prefix: line, skip };
  return { kind: 'pattern', name: t.name, pattern: t.pattern, skip };
}

// A token is a line comment iff its pattern is `seq(<literal>, star(charClass excluding \n))`.
function lineCommentShape(p: TokenPattern): string | null {
  if (typeof p === 'string' || p.type !== 'seq' || p.items.length !== 2) return null;
  const [head, tail] = p.items;
  if (typeof head !== 'string') return null;
  if (typeof tail === 'string' || tail.type !== 'repeat' || tail.min !== 0) return null;
  const body = tail.body;
  if (typeof body === 'string' || body.type !== 'charClass' || !body.negate) return null;
  const excludesNl = body.items.some((it): boolean => it.type === 'char' && it.value === '\n');
  return excludesNl ? head : null;
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
  name: string, cstName: string, body: RuleExpr, a: ReturnType<typeof analyzeGrammar>,
  stepOf: (e: RuleExpr) => Step, altSteps: (e: RuleExpr) => Step[],
  litTtype: (v: string) => '$keyword' | '$punct',
): PrattRule {
  const alts = body.type === 'alt' ? body.items : [body];
  const nudToks: string[] = [];
  const nudBrackets: Bracket[] = [];
  const nudSeqs: Step[][] = [];
  const nudCapped: Array<{ steps: Step[]; capBp: number }> = [];
  let sawPrefix = false, sawBinary = false, sawPostfix = false;
  const leds: Bracket[] = [];
  const ledAccessTail: boolean[] = [];
  const ledLbp: Array<number | null> = [];
  const ledSameLine: boolean[] = [];
  const ledNotLeftLeaf: Array<string[] | null> = [];
  const postfixToks: string[] = [];
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
      if (items.length === 1 && items[0].type === 'ref' && a.tokenNames.has(items[0].name)) { nudToks.push(items[0].name); continue; }
      if (items[0].type === 'prefix') { sawPrefix = true; continue; }
      // A capExpr (arrow function): an assignment-level group{capBelow}. ctxMode in its body
      // is treated as transparent (the await/yield fork is not modelled in the portable parser).
      if (items.length === 1 && items[0].type === 'group' && items[0].capBelow !== undefined) {
        const capBp = a.nudCapOf(items[0]);
        if (capBp === null) throw new Error(`portable: capBelow connector '${items[0].capBelow}' has no binding power (rule ${name})`);
        const b = items[0].body;
        nudCapped.push({ steps: (b.type === 'seq' ? b.items : [b]).map((it) => stepOfPratt(it)), capBp });
        continue;
      }
      if (items[0].type === 'literal') { nudBrackets.push({ first: items[0].value, steps: items.map((it) => stepOfPratt(it)) }); continue; }
      // A single transparent (non-suppress) group unwraps to its body (an explicit grouping).
      let nudItems = items;
      if (items.length === 1 && items[0].type === 'group' && !items[0].suppress) {
        nudItems = items[0].body.type === 'seq' ? items[0].body.items : [items[0].body];
      }
      nudSeqs.push(nudItems.map((it) => stepOfPratt(it)));   // general NUD sequence (guarded ident, class expr)
      continue;
    }
    // LED (starts with self): `$ op $` (binary, op slot + trailing self) or `$ <lit> …` (mixfix)
    const restAll = items.slice(1);
    const hasSameLine = restAll[0]?.type === 'sameLine';   // a TS type tail: `$ sameLine '<' …`
    const rest = hasSameLine ? restAll.slice(1) : restAll;
    if (!hasSameLine && rest[0].type === 'op') { sawBinary = true; continue; }
    if (!hasSameLine && rest[0].type === 'postfix') { sawPostfix = true; continue; }   // postfix operator (`x++`)
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
      ledAccessTail.push(!lastIsOperand && !wordConnector);
      ledLbp.push(prec ? prec.lbp : null);
      ledSameLine.push(hasSameLine);
      ledNotLeftLeaf.push(nllWords);
      continue;
    }
    if (rest.length === 1 && rest[0].type === 'ref' && a.tokenNames.has(rest[0].name)) { postfixToks.push(rest[0].name); continue; }  // postfix token (tagged template)
    throw new Error(`portable: Pratt LED shape not in scope (rule ${name})`);
  }
  // a self-ref inside a NUD/LED sub-sequence is a fresh parse of this rule
  function stepOfPratt(e: RuleExpr): Step {
    if (e.type === 'ref' && e.name === name) return { t: 'rule', name };
    if (e.type === 'seq') return { t: 'seq', steps: e.items.map(stepOfPratt) };
    if (e.type === 'sameLine') return { t: 'sameLine' };
    if (e.type === 'not') return { t: 'not', steps: (e.body.type === 'seq' ? e.body.items : [e.body]).map(stepOfPratt) };
    if (e.type === 'group' && e.suppress && e.suppress.length) return { t: 'suppress', connectors: e.suppress, steps: (e.body.type === 'seq' ? e.body.items : [e.body]).map(stepOfPratt) };
    // ctxMode (await/yield) is transparent to the portable parser (no fork); unwrap the group.
    if (e.type === 'group' && !e.capBelow) {
      return e.body.type === 'seq' ? { t: 'seq', steps: e.body.items.map(stepOfPratt) } : stepOfPratt(e.body);
    }
    if (e.type === 'sep') return { t: 'sep', elem: stepOfPratt(e.element), delim: e.delimiter };
    if (e.type === 'quantifier' && e.kind === '?') return { t: 'opt', steps: (e.body.type === 'seq' ? e.body.items : [e.body]).map(stepOfPratt) };
    if (e.type === 'quantifier' && e.kind === '*') return { t: 'star', step: stepOfPratt(e.body) };
    if (e.type === 'quantifier' && e.kind === '+') return { t: 'seq', steps: [stepOfPratt(e.body), { t: 'star', step: stepOfPratt(e.body) }] };
    if (e.type === 'literal') return { t: 'lit', value: e.value, ttype: litTtype(e.value) };
    return stepOf(e);
  }
  const prefix = sawPrefix ? [...a.prefixOps.entries()].map(([op, info]) => ({ op, rbp: info.rbp })) : [];
  const binary = sawBinary
    ? [...a.opTable.entries()].filter(([, info]) => info.position === 'infix').map(([op, info]) => ({ op, lbp: info.lbp, rbp: info.rbp }))
    : [];
  const postfix = sawPostfix
    ? [...a.opTable.entries()].filter(([, info]) => info.position === 'postfix').map(([op, info]) => ({ op, lbp: info.lbp }))
    : [];
  return { kind: 'pratt', name, cstName, nudToks, nudBrackets, nudSeqs, nudSeqFirst: [], nudSeqPredictive: false, nudCapped, nudCappedFirst: [], prefix, binary, leds, ledAccessTail, ledLbp, ledSameLine, ledNotLeftLeaf, postfixToks, postfix };
}

// ── Lex integer ids (kid = kind index, lid = text/literal index) ──
//
// Parser matching hot paths compare u16/uint16/number instead of strings. kid indexes
// `kids` (token kind names); lid indexes `lids` (literal texts). lid is a pure function of
// text and is independent of kind — matching the existing `match_lit` (text-only) contract.

export type LexIdPlan = {
  kids: string[];   // kids[0]='' reserved for punct (kind=""); then tokens in decl order + engine-emitted (NEWLINE, $template*)
  lids: string[];   // lids[0]='' = "not any literal"; then puncts (longest-first), then remaining texts lexicographically
};

/** Collect every literal text that appears in the Step IR (match_lit / altlit / sep / suppress / FIRST / Pratt). */
function collectStepLitTexts(steps: Step[], out: Set<string>): void {
  for (const s of steps) {
    switch (s.t) {
      case 'lit': out.add(s.value); break;
      case 'altlit': for (const o of s.opts) out.add(o.value); break;
      case 'sep': out.add(s.delim); collectStepLitTexts([s.elem], out); break;
      case 'suppress': for (const c of s.connectors) out.add(c); collectStepLitTexts(s.steps, out); break;
      case 'star': collectStepLitTexts([s.step], out); break;
      case 'opt': case 'not': case 'seq': collectStepLitTexts(s.steps, out); break;
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

  // Stable order: puncts longest-first (ir.puncts), then remaining texts lexicographically
  const punctSet = new Set(ir.puncts);
  const rest = [...litTexts].filter((t) => !punctSet.has(t)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lids: string[] = ['', ...ir.puncts, ...rest];
  return { kids, lids };
}

/** Resolve lid for a known text; 0 if not in the plan (matches runtime lid_of). */
export function lidOf(plan: LexIdPlan, text: string): number {
  const i = plan.lids.indexOf(text);
  return i >= 0 ? i : 0;
}

/** Resolve kid for a known kind; 0 if not in the plan. */
export function kidOf(plan: LexIdPlan, kind: string): number {
  const i = plan.kids.indexOf(kind);
  return i >= 0 ? i : 0;
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
      case 'suppress': collectStepTtypes(s.steps, out); break;
      case 'star': collectStepTtypes([s.step], out); break;
      case 'opt': case 'not': case 'seq': collectStepTtypes(s.steps, out); break;
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
  if (ir.newlineCfg) fromSteps.add(ir.newlineCfg.token);
  for (const s of fromSteps) addTt(s);

  if (ttNames.length > 64) {
    throw new Error(`TT_NAMES length ${ttNames.length} exceeds tt_id limit 63`);
  }

  const ruleNames: string[] = [];
  const seenR = new Set<string>();
  const addR = (s: string) => { if (!seenR.has(s)) { seenR.add(s); ruleNames.push(s); } };
  for (const r of ir.rules) addR(r.cstName);
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

/** Build per-byte buckets (0..127) over a fixed global candidate sequence; fallback = full sequence. */
export function buildLexDispatchPlan(firsts: (LexFirstBytes | null)[]): { arms: LexDispatchArm[]; fallbackIndices: number[] } {
  const n = firsts.length;
  const fallbackIndices = [...Array(n).keys()];
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
