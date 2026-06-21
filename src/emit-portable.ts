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
  | { t: 'altlit'; opts: Lit[] };                               // inline alternation of literals
export type Alt = Step[];

export type RdRule = { kind: 'rd'; name: string; alts: Alt[] };
export type Bracket = { first: string; steps: Step[] };          // a literal-led sequence (grouping/array; LED call/index)
export type PrattRule = {
  kind: 'pratt';
  name: string;
  nudToks: string[];                                  // NUD: a bare token wrapped in a node
  nudBrackets: Bracket[];                             // NUD: '(' … ')' / '[' … ']'
  prefix: Array<{ op: string; rbp: number }>;         // NUD: prefix op then operand at rbp
  binary: Array<{ op: string; lbp: number; rbp: number }>;  // LED: infix op, bind iff lbp > minBp, rhs at rbp
  leds: Bracket[];                                    // LED: mixfix continuation (call/member/index), tried before operators
};
export type RuleIR = RdRule | PrattRule;

export type ParserIR = {
  grammarName: string;
  entry: string;
  tokens: LexTok[];      // for the char scanner, tried in declaration order
  puncts: string[];      // punctuation literals, longest-first (maximal munch)
  rules: RuleIR[];
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
      case 'sep': return { t: 'sep', elem: stepOf(e.element), delim: e.delimiter };
      case 'quantifier':
        if (e.kind === '*') return { t: 'star', step: stepOf(e.body) };
        if (e.kind === '?') return { t: 'opt', steps: altSteps(e.body) };
        if (e.kind === '+') throw new Error("portable: '+' not yet modeled (use '*')");
        break;
      case 'alt': {
        const opts: Lit[] = [];
        for (const it of e.items) {
          if (it.type !== 'literal') throw new Error('portable: inline alt must be all literals');
          opts.push({ value: it.value, ttype: litTtype(it.value) });
        }
        return { t: 'altlit', opts };
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

  return { grammarName: grammar.name ?? 'grammar', entry: findEntryRule(grammar), tokens, puncts, rules };
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
  let sawPrefix = false, sawBinary = false;
  const leds: Bracket[] = [];
  for (const alt of alts) {
    const items = alt.type === 'seq' ? alt.items : [alt];
    const startsSelf = items[0].type === 'ref' && items[0].name === name;
    if (!startsSelf) {
      // NUD
      if (items.length === 1 && items[0].type === 'ref' && a.tokenNames.has(items[0].name)) { nudToks.push(items[0].name); continue; }
      if (items[0].type === 'prefix') { sawPrefix = true; continue; }
      if (items[0].type === 'literal') { nudBrackets.push({ first: items[0].value, steps: items.map((it) => stepOfPratt(it)) }); continue; }
      throw new Error(`portable: Pratt NUD shape not in scope (rule ${name})`);
    }
    // LED (starts with self): `$ op $` (binary, op slot + trailing self) or `$ <lit> …` (mixfix)
    const rest = items.slice(1);
    if (rest[0].type === 'op') { sawBinary = true; continue; }
    if (rest[0].type === 'literal') { leds.push({ first: rest[0].value, steps: rest.map((it) => stepOfPratt(it)) }); continue; }
    throw new Error(`portable: Pratt LED shape not in scope (rule ${name})`);
  }
  // a self-ref inside a NUD/LED sub-sequence is a fresh parse of this rule
  function stepOfPratt(e: RuleExpr): Step {
    if (e.type === 'ref' && e.name === name) return { t: 'rule', name };
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
  return { kind: 'pratt', name, nudToks, nudBrackets, prefix, binary, leds };
}
