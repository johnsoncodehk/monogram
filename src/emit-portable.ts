// ── emit-portable ──
//
// The target-agnostic emitter (issue #6). `emitPortableParser(grammar, target)` derives
// a COMPLETE, self-contained parser in the target's language from the same CstGrammar the
// TS engine uses. It is the agnosticism proof: ONE analysis → ONE intermediate form (IR)
// → N language renderings, all producing the byte-identical CST the interpreter does.
//
// SHARED + target-agnostic (here): the grammar ANALYSIS (reused from grammar-analysis.ts)
// and `buildIR` — the parse plan as plain data (recursive-descent rules as alternative
// step-lists, the Pratt rule as NUD-atom / prefix / binary tables, the char-class lexer
// specs, the literal vocabulary, the entry rule). PER-TARGET (a Target): `render(ir)` —
// the language's lexer + CST runtime + the rendering of each IR node. Adding a language is
// implementing one Target; nothing here changes.
//
// SCOPE (the verifiable core): char-class tokens (`charClass` then `star(charClass)`), a
// recursive-descent + backtracking-alternation + `*` body, and a Pratt expression engine
// with operator PRECEDENCE/associativity + prefix unary + parenthesised grouping. The
// portable lexer is a dependency-free char scanner (no regex), so the emitted Go/Rust
// compile offline. Richer surface (mixfix/postfix LEDs, `sep`/`opt`, lexer lookahead,
// left-recursion beyond Pratt) is the documented next increment; buildIR THROWS on a
// construct it does not model rather than emit a wrong parser.
import type { CstGrammar, RuleExpr, TokenDecl, TokenPattern } from './types.ts';
import { analyzeGrammar, findEntryRule } from './grammar-analysis.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';

// ── Intermediate representation (plain data; every Target renders THIS) ──

export type CharRange = [number, number];   // inclusive char-code range
export type TokenSpec = { name: string; first: CharRange[]; cont: CharRange[] };

export type Step =
  | { t: 'lit'; value: string; ttype: '$keyword' | '$punct' }   // match a literal by text
  | { t: 'tok'; name: string }                                  // match a token kind
  | { t: 'rule'; name: string }                                 // call a rule, append its node
  | { t: 'star'; step: Step };                                  // repeat the inner step 0+ times
export type Alt = Step[];

export type RdRule = { kind: 'rd'; name: string; alts: Alt[] };
export type PrattRule = {
  kind: 'pratt';
  name: string;
  atomToks: string[];                                  // NUD: a bare token (Number/Ident) wrapped in a node
  group: { open: string; close: string } | null;      // NUD: '(' Expr ')'
  prefix: Array<{ op: string; rbp: number }>;          // NUD: prefix op then operand parsed at rbp
  binary: Array<{ op: string; lbp: number; rbp: number }>;  // LED: infix op, bind iff lbp > minBp, rhs at rbp
};
export type RuleIR = RdRule | PrattRule;

export type ParserIR = {
  grammarName: string;
  entry: string;
  tokens: TokenSpec[];   // named tokens, for the char scanner (tried in declaration order)
  puncts: string[];      // punctuation literals, sorted longest-first (maximal munch)
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

  // Lexer token specs: each token must be `charClass` then `star(charClass)` (the portable
  // scanner's shape). Anything else is out of the verifiable core → throw, don't mis-lex.
  const tokens: TokenSpec[] = grammar.tokens.map((t) => {
    const { first, cont } = charClassFirstCont(t);
    return { name: t.name, first, cont };
  });

  // Literal vocabulary, split keyword (alpha — lexed as an identifier, matched by text) vs
  // punctuation (lexed as its own token). Puncts longest-first for maximal munch.
  const lits = new Set<string>();
  for (const r of grammar.rules) for (const l of collectLiterals(r.body)) lits.add(l);
  for (const lv of grammar.precs) for (const o of lv.operators) lits.add(o.value);
  const puncts = [...lits].filter((l) => !isKeywordLiteral(l)).sort((x, y) => y.length - x.length);

  const litTtype = (v: string): '$keyword' | '$punct' => (isKeywordLiteral(v) ? '$keyword' : '$punct');

  const rules: RuleIR[] = grammar.rules.map((r) => {
    if (a.prattRules.has(r.name)) return buildPratt(r.name, r.body, a);
    return { kind: 'rd', name: r.name, alts: buildRdAlts(r.body) };
  });

  function buildRdAlts(body: RuleExpr): Alt[] {
    if (body.type === 'alt') return body.items.map(altSteps);
    return [altSteps(body)];
  }
  function altSteps(e: RuleExpr): Step[] {
    if (e.type === 'seq') return e.items.flatMap(stepOf);
    return stepOf(e);
  }
  function stepOf(e: RuleExpr): Step[] {
    switch (e.type) {
      case 'literal': return [{ t: 'lit', value: e.value, ttype: litTtype(e.value) }];
      case 'ref': return [tokenNames.has(e.name) ? { t: 'tok', name: e.name } : { t: 'rule', name: e.name }];
      case 'quantifier': {
        if (e.kind !== '*') throw new Error(`portable: quantifier '${e.kind}' not in the verifiable core (only '*')`);
        const inner = stepOf(e.body);
        if (inner.length !== 1) throw new Error('portable: `*` body must be a single step (a rule/token ref)');
        return [{ t: 'star', step: inner[0] }];
      }
      case 'group': return altSteps(e.body);
      default: throw new Error(`portable: rd construct '${e.type}' not in the verifiable core`);
    }
  }

  return { grammarName: grammar.name ?? 'grammar', entry: findEntryRule(grammar), tokens, puncts, rules };
}

// A Pratt rule's alternatives, classified into NUD atoms / grouping / prefix and LED binary.
// The binding powers come from the analysis (opTable/prefixOps), so precedence is single-
// sourced with the interpreter.
function buildPratt(name: string, body: RuleExpr, a: ReturnType<typeof analyzeGrammar>): PrattRule {
  const alts = body.type === 'alt' ? body.items : [body];
  const atomToks: string[] = [];
  let group: { open: string; close: string } | null = null;
  let sawPrefix = false;
  let sawBinary = false;
  for (const alt of alts) {
    const items = alt.type === 'seq' ? alt.items : [alt];
    if (items.length === 1 && items[0].type === 'ref' && a.tokenNames.has(items[0].name)) {
      atomToks.push(items[0].name);                                  // [Token]
    } else if (items.length === 3 && items[0].type === 'literal' && items[2].type === 'literal'
               && items[1].type === 'ref' && items[1].name === name) {
      group = { open: items[0].value, close: items[2].value };       // [ '(' $ ')' ]
    } else if (items.length === 2 && items[0].type === 'prefix' && items[1].type === 'ref' && items[1].name === name) {
      sawPrefix = true;                                              // [ prefix $ ]
    } else if (items.length === 3 && items[0].type === 'ref' && items[0].name === name
               && items[1].type === 'op' && items[2].type === 'ref' && items[2].name === name) {
      sawBinary = true;                                              // [ $ op $ ]
    } else {
      throw new Error(`portable: Pratt alt shape not in the verifiable core (rule ${name})`);
    }
  }
  const prefix = sawPrefix
    ? [...a.prefixOps.entries()].map(([op, info]) => ({ op, rbp: info.rbp }))
    : [];
  const binary = sawBinary
    ? [...a.opTable.entries()]
        .filter(([, info]) => info.position === 'infix')
        .map(([op, info]) => ({ op, lbp: info.lbp, rbp: info.rbp }))
    : [];
  return { kind: 'pratt', name, atomToks, group, prefix, binary };
}

// Extract a token's (first-char, continue-char) code ranges from a `charClass` then
// `star(charClass)` pattern. Throws for any other shape (out of the verifiable core).
function charClassFirstCont(t: TokenDecl): { first: CharRange[]; cont: CharRange[] } {
  const p = t.pattern;
  if (typeof p === 'string' || p.type !== 'seq' || p.items.length !== 2) throw new Error(`portable: token ${t.name} not [charClass, star(charClass)]`);
  const head = p.items[0];
  const tail = p.items[1];
  if (typeof tail === 'string' || tail.type !== 'repeat' || tail.min !== 0) throw new Error(`portable: token ${t.name} tail is not star(charClass)`);
  return { first: classRanges(head, t.name), cont: classRanges(tail.body, t.name) };
}
function classRanges(p: TokenPattern, tok: string): CharRange[] {
  if (typeof p === 'string' || p.type !== 'charClass' || p.negate) throw new Error(`portable: token ${tok} uses a non-positive char class`);
  return p.items.map((it): CharRange => {
    if (it.type === 'char') return [it.value.charCodeAt(0), it.value.charCodeAt(0)];
    if (it.type === 'range') return [it.from.charCodeAt(0), it.to.charCodeAt(0)];
    throw new Error(`portable: token ${tok} char-class item '${(it as { type: string }).type}' unsupported`);
  });
}
