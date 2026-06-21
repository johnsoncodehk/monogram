// ── emit-portable ──
//
// The target-agnostic emitter (issue #6). `emitPortableParser(grammar, target)` derives
// a COMPLETE, self-contained parser in the target's language from the same CstGrammar the
// TS engine uses. It is the agnosticism proof: ONE analysis → ONE intermediate form (IR)
// → N language renderings, all producing the byte-identical CST the interpreter does.
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
// parser. This is enough to derive a real JavaScript-subset parser (examples/minijs.ts).
import type { CstGrammar, RuleExpr, TokenDecl, TokenPattern } from './types.ts';
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
  | { kind: 'string'; name: string; delim: string; skip: boolean }                        // delim..delim, `\` escapes next
  | { kind: 'line'; name: string; prefix: string; skip: boolean }                         // prefix..end-of-line
  | { kind: 'block'; name: string; open: string; close: string; skip: boolean }           // open..close
  // The general case: the raw token-pattern AST, compiled to a backtracking-free matcher
  // by the target (no regex engine). Subsumes the fast paths above; used for the token
  // shapes they don't cleanly recognise (escaped identifiers, the number family, …).
  | { kind: 'pattern'; name: string; pattern: TokenPattern; skip: boolean };

export type Lit = { value: string; ttype: '$keyword' | '$punct' };
export type Step =
  | { t: 'lit'; value: string; ttype: '$keyword' | '$punct' }   // match a literal by text
  | { t: 'tok'; name: string }                                  // match a token kind
  | { t: 'rule'; name: string }                                 // call a rule, append its node
  | { t: 'star'; step: Step }                                   // repeat inner 0+
  | { t: 'opt'; steps: Step[] }                                 // optional sub-sequence
  | { t: 'sep'; elem: Step; delim: string }                     // elem (delim elem)*
  | { t: 'altlit'; opts: Lit[] }                                // inline alternation of literals (fast path)
  | { t: 'alt'; branches: Step[][] }                            // inline alternation of sub-sequences (backtracking)
  | { t: 'not'; steps: Step[] }                                 // zero-width negative lookahead (consumes nothing)
  | { t: 'seq'; steps: Step[] }                                 // a grouped sub-sequence (e.g. a star body `(',' Expr)`)
  | { t: 'sameLine' };                                          // zero-width: the next token is on the same line (no preceding newline)
export type Alt = Step[];

export type RdRule = { kind: 'rd'; name: string; alts: Alt[] };
export type Bracket = { first: string; steps: Step[] };          // a literal-led sequence (grouping/array; LED call/index)
export type PrattRule = {
  kind: 'pratt';
  name: string;
  nudToks: string[];                                  // NUD: a bare token wrapped in a node
  nudBrackets: Bracket[];                             // NUD: '(' … ')' / '[' … ']'
  nudSeqs: Step[][];                                  // NUD: a general sequence (guarded ident, class expr), tried with backtracking
  prefix: Array<{ op: string; rbp: number }>;         // NUD: prefix op then operand at rbp
  binary: Array<{ op: string; lbp: number; rbp: number }>;  // LED: infix op, bind iff lbp > minBp, rhs at rbp
  leds: Bracket[];                                    // LED: mixfix continuation (call/member/index), tried before operators
  ledAccessTail: boolean[];                           // parallel to leds: a "closed punct-connector" tail (member/call/index) — disabled once a postfix binds
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

export type ParserIR = {
  grammarName: string;
  entry: string;
  tokens: LexTok[];      // for the char scanner, tried in declaration order
  puncts: string[];      // punctuation literals, longest-first (maximal munch)
  rules: RuleIR[];
  regexCtx: RegexCtx | null;   // null unless the grammar has a regex token with context
  tpl: TplCfg | null;          // null unless the grammar has a template token
};

export interface Target {
  name: string;
  ext: string;                       // emitted file extension (no dot)
  render(ir: ParserIR): string;      // the complete, compilable source
}

export function emitPortableParser(grammar: CstGrammar, target: Target): string {
  return target.render(buildIR(grammar));
}

// ── buildIR: grammar + analysis → the target-agnostic parse plan ──

function buildIR(grammar: CstGrammar): ParserIR {
  const a = analyzeGrammar(grammar);
  const tokenNames = a.tokenNames;

  const tokens: LexTok[] = grammar.tokens.map((t) => lexTok(t));
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
      case 'group': { const ss = altSteps(e.body); if (ss.length !== 1) throw new Error('portable: group must reduce to a single step'); return ss[0]; }
      case 'not': return { t: 'not', steps: altSteps(e.body) };   // zero-width negative lookahead
      case 'sameLine': return { t: 'sameLine' };                  // zero-width no-newline assertion
      case 'seq': return { t: 'seq', steps: e.items.map(stepOf) };  // grouped sub-sequence (star/sep body)
      case 'sep': return { t: 'sep', elem: stepOf(e.element), delim: e.delimiter };
      case 'quantifier':
        if (e.kind === '*') return { t: 'star', step: stepOf(e.body) };
        if (e.kind === '?') return { t: 'opt', steps: altSteps(e.body) };
        if (e.kind === '+') throw new Error("portable: '+' not yet modeled (use '*')");
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
    if (a.prattRules.has(r.name)) return buildPratt(r.name, r.body, a, stepOf, altSteps, litTtype);
    return { kind: 'rd', name: r.name, alts: r.body.type === 'alt' ? r.body.items.map(altSteps) : [altSteps(r.body)] };
  });

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

  return { grammarName: grammar.name ?? 'grammar', entry: findEntryRule(grammar), tokens, puncts, rules, regexCtx, tpl };
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
  if (loop && loop.bail.length === 0 && !loop.bailNonAscii) {
    return { kind: 'run', name: t.name, first: codesToRanges(loop.first), cont: codesToRanges(loop.cont), skip };
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
  name: string, body: RuleExpr, a: ReturnType<typeof analyzeGrammar>,
  stepOf: (e: RuleExpr) => Step, altSteps: (e: RuleExpr) => Step[],
  litTtype: (v: string) => '$keyword' | '$punct',
): PrattRule {
  const alts = body.type === 'alt' ? body.items : [body];
  const nudToks: string[] = [];
  const nudBrackets: Bracket[] = [];
  const nudSeqs: Step[][] = [];
  let sawPrefix = false, sawBinary = false, sawPostfix = false;
  const leds: Bracket[] = [];
  const ledAccessTail: boolean[] = [];
  const postfixToks: string[] = [];
  for (const alt of alts) {
    const items = alt.type === 'seq' ? alt.items : [alt];
    const startsSelf = items[0].type === 'ref' && items[0].name === name;
    if (!startsSelf) {
      // NUD
      if (items.length === 1 && items[0].type === 'ref' && a.tokenNames.has(items[0].name)) { nudToks.push(items[0].name); continue; }
      if (items[0].type === 'prefix') { sawPrefix = true; continue; }
      if (items[0].type === 'literal') { nudBrackets.push({ first: items[0].value, steps: items.map((it) => stepOfPratt(it)) }); continue; }
      // A single transparent group unwraps to its body (an explicit grouping of the NUD sequence).
      let nudItems = items;
      if (items.length === 1 && items[0].type === 'group' && !items[0].capBelow && !items[0].ctxMode && !items[0].suppress) {
        nudItems = items[0].body.type === 'seq' ? items[0].body.items : [items[0].body];
      }
      // capBelow / ctxMode (arrow functions, await/yield context) are a deeper construct — defer.
      if (nudItems.some((it) => it.type === 'group' && (it.capBelow || it.ctxMode || it.suppress))) {
        throw new Error(`portable: Pratt NUD with capBelow/ctxMode/suppress not yet in scope (rule ${name}) — arrow functions etc.`);
      }
      nudSeqs.push(nudItems.map((it) => stepOfPratt(it)));   // general NUD sequence (guarded ident, class expr)
      continue;
    }
    // LED (starts with self): `$ op $` (binary, op slot + trailing self) or `$ <lit> …` (mixfix)
    const rest = items.slice(1);
    if (rest[0].type === 'op') { sawBinary = true; continue; }
    if (rest[0].type === 'postfix') { sawPostfix = true; continue; }   // postfix operator (`x++`)
    if (rest[0].type === 'literal') {
      const steps = rest.map((it) => stepOfPratt(it));
      const last = steps[steps.length - 1];
      const lastIsOperand = last !== undefined && last.t === 'rule' && last.name === name;   // open binary/ternary operand
      const wordConnector = /^[A-Za-z]/.test(rest[0].value);                                  // `in`/`instanceof`/`as` — not a tail
      leds.push({ first: rest[0].value, steps });
      ledAccessTail.push(!lastIsOperand && !wordConnector);
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
    if (e.type === 'group' && !e.capBelow && !e.ctxMode && !e.suppress && e.body.type !== 'seq') return stepOfPratt(e.body);
    if (e.type === 'sep') return { t: 'sep', elem: stepOfPratt(e.element), delim: e.delimiter };
    if (e.type === 'quantifier' && e.kind === '?') return { t: 'opt', steps: (e.body.type === 'seq' ? e.body.items : [e.body]).map(stepOfPratt) };
    if (e.type === 'quantifier' && e.kind === '*') return { t: 'star', step: stepOfPratt(e.body) };
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
  return { kind: 'pratt', name, nudToks, nudBrackets, nudSeqs, prefix, binary, leds, ledAccessTail, postfixToks, postfix };
}
