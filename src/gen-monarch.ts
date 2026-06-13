import type { CstGrammar, RuleExpr, TokenDecl } from './types.ts';
import { collectLiterals, isKeywordLiteral } from './grammar-utils.ts';
import {
  tokenEscapePatternSource,
  tokenPatternBlockDelimiterSources,
  tokenPatternBlockDelimiters,
  tokenPatternContainsLiteral,
  tokenPatternHasStartAnchor,
  tokenPatternIdentifierExtraChars,
  tokenPatternLiteralPrefix,
  tokenPatternSource,
  tokenPatternStartsWithDecimal,
  tokenPatternStringDelimiters,
} from './token-pattern.ts';

// ─────────────────────────────────────────────────────────────────────────────
// gen-monarch — derive a Monaco *Monarch* tokenizer from ONE grammar.
//
// Monarch is Monaco's built-in, line-oriented tokenizer: a plain JS object of
// the shape `{ tokenizer: { <state>: Rule[] }, … }`, where each Rule is
// `[regex, action]` / `[regex, action, next]` / `{ include }`, using **plain
// JavaScript RegExp** — NO Oniguruma, NO recursive subpatterns, NO `\g<…>`.
//
// It is a sibling of gen-tm.ts: both INFER highlight roles from the grammar's
// token shapes + the `scopes` section. gen-tm emits TextMate (Oniguruma); this
// emits Monarch. The scope inference is shared in spirit — we re-derive it from
// the same data, then map each inferred TextMate scope to the closest Monarch
// token — so the parser and both highlighters never disagree about what a token
// *is*.
//
// Everything is derived from the grammar: nothing hardcodes a language's tokens
// (no literal "typeof"/"`"/"/"). Identifier / template / regex behaviour all come
// from the per-token lexer hints, exactly like gen-lexer.ts.
//
// Where this BEATS Monaco's hand-written TS Monarch:
//   • regex-vs-division by PRECEDING context — two base states `root`
//     (expression position → a leading `/` is a regex literal) and `value`
//     (just saw a value → a leading `/` is the division operator). Monaco
//     instead guesses from what FOLLOWS `/`, which mis-tokenizes cases like
//     `return /re/g` vs `a /b/ c`.
//   • generics `<…>` as a real type-argument STATE → type args become
//     `type.identifier` by CONTEXT. Monaco's hand-written TS Monarch only does
//     `[A-Z]\w* → type.identifier` (capitalization), missing lower-case type
//     names (`type x = foo<bar>`) and over-claiming capitalised *values*.
//   Bounded by JS-regex limits (no recursion): generics nest via stacked states
//   and are reliable to a fixed shallow depth; see the smoke test for specifics.
// ─────────────────────────────────────────────────────────────────────────────

// ── Monarch object shape (the subset we emit) ──

/** A Monarch token action: a bare token string, an object carrying a state
 *  transition, or a `cases` dispatch keyed on the matched text. */
export type MonarchAction =
  | string
  | { token: string; next?: string; switchTo?: string }
  | { cases: Record<string, MonarchAction> };

/** A single tokenizer rule. */
export type MonarchRule =
  | [string, MonarchAction]
  | [string, MonarchAction, string]
  | { include: string };

export interface MonarchLanguage {
  defaultToken: string;
  tokenPostfix: string;
  ignoreCase: boolean;
  /** Bracket pairs for Monaco bracket matching / colorization. */
  brackets: { open: string; close: string; token: string }[];
  /** The tokenizer state machine. */
  tokenizer: Record<string, MonarchRule[]>;
}

// ── Regex helpers (JS RegExp dialect) ──

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape a char for use inside a `[...]` class (JS dialect specials). */
function escapeForCharClass(s: string): string {
  return s.replace(/[\]\\^-]/g, '\\$&');
}

/** Strip a single leading `^` — Monarch already anchors each rule at the cursor. */
function anchoredSource(pattern: string): string {
  return pattern.startsWith('^') ? pattern.slice(1) : pattern;
}

/** An identifier-safe suffix for a state named after a delimiter. */
function delimStateSuffix(delim: string): string {
  const names: Record<string, string> = {
    '/': 'slash', '*': 'star', '<': 'angle', '>': 'angle', '!': 'bang', '-': 'dash',
    '"': 'dquote', "'": 'squote', '`': 'backtick', '#': 'hash', '+': 'plus', '~': 'tilde',
  };
  return [...delim].map(c => names[c] ?? (/[a-zA-Z0-9]/.test(c) ? c : `u${c.charCodeAt(0)}`)).join('');
}

// ── TextMate-scope → Monarch-token mapping ──
//
// gen-tm already INFERS a TextMate scope for every construct. Monarch uses a
// flatter, theme-oriented vocabulary (keyword, type.identifier, number.hex,
// delimiter.*, …). We map the inferred TM scope to its closest Monarch token so
// BOTH highlighters agree on roles while each speaks its engine's idiom. Driven
// by scope PREFIXES — language-agnostic.
function scopeToMonarch(scope: string): string {
  // A space-separated scope is `ancestor… leaf`; a single Monarch token wants the LEAF (the
  // semantic type), not the string ancestor that only supplies the TextMate chain.
  if (scope.includes(' ')) scope = scope.slice(scope.lastIndexOf(' ') + 1);
  if (scope.startsWith('comment')) return 'comment';
  if (scope.startsWith('string.regexp')) return 'regexp';
  if (scope.startsWith('string')) return 'string';
  if (scope.startsWith('constant.numeric')) {
    const kind = scope.slice('constant.numeric.'.length);
    const map: Record<string, string> = {
      hex: 'number.hex', octal: 'number.octal', binary: 'number.binary',
      float: 'number.float', integer: 'number', bigint: 'number',
    };
    return map[kind] ?? 'number';
  }
  if (scope.startsWith('constant.language')) return 'keyword';      // true/false/null
  if (scope.startsWith('variable.language')) return 'keyword';      // this/super
  if (scope.startsWith('constant')) return 'constant';
  if (scope.startsWith('storage.type.function.arrow')) return 'operator';
  if (scope.startsWith('storage')) return 'keyword';
  if (scope.startsWith('keyword.operator')) return 'operator';
  if (scope.startsWith('keyword')) return 'keyword';
  if (scope.startsWith('entity.other.document')) return 'delimiter';  // YAML --- / ... markers
  if (scope.startsWith('entity.name.function.decorator')) return 'annotation';
  if (scope.startsWith('entity.name.function')) return 'identifier';
  if (scope.startsWith('entity.name.type')) return 'type.identifier';
  if (scope.startsWith('entity')) return 'identifier';
  if (scope.startsWith('support.type')) return 'keyword';          // primitive types
  if (scope.startsWith('support.class')) return 'type.identifier'; // built-in classes
  if (scope.startsWith('support.variable')) return 'variable';
  if (scope.startsWith('support')) return 'identifier';
  if (scope.startsWith('punctuation.bracket')) {
    if (scope.includes('round')) return 'delimiter.parenthesis';
    if (scope.includes('curly')) return 'delimiter.bracket';
    if (scope.includes('square')) return 'delimiter.square';
    if (scope.includes('angle')) return 'delimiter.angle';
    return 'delimiter.bracket';
  }
  if (scope.startsWith('punctuation')) return 'delimiter';
  if (scope.startsWith('variable')) return 'variable';
  return 'identifier';
}

// ── Token classification (parallels gen-tm.classifyToken) ──
//
// Resolve the highlight role of a *declared token* from its pattern + flags +
// any `@scope` override. Same inference gen-tm performs → consistent roles.
function classifyTokenScope(token: TokenDecl): string {
  if (token.scope) return token.scope;
  if (token.flags.includes('skip')) {
    if (tokenPatternBlockDelimiters(token)) return 'comment.block';
    return 'comment.line';
  }
  if (tokenPatternStartsWithDecimal(token)) {
    if (tokenPatternContainsLiteral(token, '.')) return 'constant.numeric.float';
    return 'constant.numeric.integer';
  }
  const delimiters = tokenPatternStringDelimiters(token);
  if (delimiters.includes('"')) return 'string.quoted.double';
  if (delimiters.includes("'")) return 'string.quoted.single';
  if (delimiters.includes('`')) return 'string.quoted.other.template';
  return 'variable.other';
}

// ── Angle-bracket (generic) ambiguity detection — mirrors gen-tm ──
//
// `<` is generic-open iff it is BOTH a prec-table operator (comparison) AND a
// rule delimiter paired with `>` around a separated inner rule (the type args).

/** Expand opt()/alt()/quantifiers into flat top-level item sequences so an
 *  adjacency like `'<' sep '>'` is visible even when written via opt()/alt().
 *  Bounded by 2^(#opts) per alternative. Mirrors gen-tm.expandAlts. */
function expandAlts(expr: RuleExpr): RuleExpr[][] {
  switch (expr.type) {
    case 'seq': {
      let acc: RuleExpr[][] = [[]];
      for (const item of expr.items) {
        const branches = expandAlts(item);
        const next: RuleExpr[][] = [];
        for (const prefix of acc) for (const b of branches) next.push([...prefix, ...b]);
        acc = next;
      }
      return acc;
    }
    case 'alt':
      return expr.items.flatMap(expandAlts);
    case 'group':
      return expandAlts(expr.body);
    case 'quantifier': {
      const present = expandAlts(expr.body);
      return expr.kind === '+' ? present : [[], ...present];
    }
    default:
      return [[expr]];
  }
}

interface AngleInfo {
  /** Chars that, right after a balanced `>`, CONFIRM the `<…>` was a generic
   *  argument list — e.g. `(` (a call), `` ` `` (a tagged template). Collected
   *  from the item following `>` in every `'<' sep '>'` adjacency (mirrors
   *  gen-tm's confirm-token collection). */
  confirmChars: string[];
}

function detectAngleBrackets(grammar: CstGrammar): AngleInfo | null {
  const precOps = new Set<string>();
  for (const level of grammar.precs)
    for (const op of level.operators) precOps.add(op.value);
  if (!precOps.has('<') || !precOps.has('>')) return null;

  const confirm = new Set<string>();
  let found = false;

  // Resolve the leading literal char of the item that follows `>`.
  function confirmCharOf(item: RuleExpr | undefined): string | null {
    if (!item) return null;
    if (item.type === 'literal') return (item as { value: string }).value;
    if (item.type === 'ref') {
      const token = grammar.tokens.find(t => t.name === (item as { name: string }).name);
      const delimiter = token ? tokenPatternStringDelimiters(token)[0] : undefined;
      if (delimiter && /^[`'"]/.test(delimiter)) return delimiter[0];
    }
    return null;
  }

  for (const rule of grammar.rules) {
    for (const seq of expandAlts(rule.body)) {
      for (let i = 0; i < seq.length - 2; i++) {
        if (seq[i].type === 'literal' && (seq[i] as { value: string }).value === '<' &&
            seq[i + 1].type === 'sep' &&
            seq[i + 2].type === 'literal' && (seq[i + 2] as { value: string }).value === '>') {
          found = true;
          const ch = confirmCharOf(seq[i + 3]);
          if (ch && ch.length === 1) confirm.add(ch);
        }
      }
    }
  }
  return found ? { confirmChars: [...confirm] } : null;
}

// ── Markup tokenizer (HTML/Vue) ──
// A markup grammar's Monarch tokenizer is a state machine over tags/text/raw-text,
// derived from the markup config — NOT the token-stream construction below. Each rule
// emits a single token (the type models no multi-capture action), so open/close tags
// are split into states to keep the `<`/`>` delimiter distinct from the tag name.
function generateMarkupMonarch(grammar: CstGrammar): MonarchLanguage {
  const m = grammar.markup!;
  const idTok = grammar.tokens.find(t => t.identifier);
  const name = idTok ? tokenPatternSource(idTok) : '[a-zA-Z][\\w:.-]*';
  const o = escapeRegex(m.tagOpen), c = escapeRegex(m.tagClose), sl = escapeRegex(m.closeMarker ?? '/');
  const oc = m.tagOpen;                                   // raw open char for char classes (`<` is class-safe)
  // Attribute rules shared by the normal tag state and each raw-text start tag.
  const attrRules: MonarchRule[] = [
    [name, 'attribute.name'],
    ['=', 'delimiter'],
    ['"', { token: 'string', next: '@dq' }],
    ["'", { token: 'string', next: '@sq' }],
    ['\\s+', ''],
  ];

  const tokenizer: Record<string, MonarchRule[]> = {
    root: [
      ...(m.comment ? [[escapeRegex(m.comment.open), { token: 'comment', next: '@comment' }] as MonarchRule] : []),
      [`${o}${sl}`, { token: 'delimiter', next: '@closetag' }],
      [`${o}`, { token: 'delimiter', next: '@opentag' }],
      [`[^${oc}]+`, ''],                                   // text content (the uncoloured root)
    ],
    // Just consumed `<` — the tag name decides the next state. Raw-text elements switch
    // to a body state where `<`/`>` are content, not markup.
    opentag: [
      ...(m.rawText?.tags ?? []).map(tag => [`${tag}\\b`, { token: 'tag', switchTo: `@rawtag_${tag}` }] as MonarchRule),
      [name, { token: 'tag', switchTo: '@tag' }],
      ['', '', '@pop'],
    ],
    closetag: [
      [name, 'tag'],
      [`${c}`, { token: 'delimiter', next: '@pop' }],
      ['\\s+', ''],
    ],
    tag: [
      ...attrRules,
      [`${sl}?${c}`, { token: 'delimiter', next: '@pop' }],
    ],
    dq: [['[^"]+', 'string'], ['"', { token: 'string', next: '@pop' }]],
    sq: [["[^']+", 'string'], ["'", { token: 'string', next: '@pop' }]],
  };
  if (m.comment) {
    const close = escapeRegex(m.comment.close);
    tokenizer.comment = [
      [close, { token: 'comment', next: '@pop' }],
      [`[^${escapeRegex(m.comment.close[0])}]+`, 'comment'],
      ['[\\s\\S]', 'comment'],
    ];
  }
  for (const tag of m.rawText?.tags ?? []) {
    const embed = tag === 'script' ? 'source.js' : tag === 'style' ? 'source.css' : 'source';
    tokenizer[`rawtag_${tag}`] = [
      ...attrRules,
      [`${c}`, { token: 'delimiter', switchTo: `@rawbody_${tag}` }],
    ];
    tokenizer[`rawbody_${tag}`] = [
      [`${o}${sl}${tag}\\s*${c}`, { token: 'tag', next: '@popall' }],   // close tag → back to root
      [`[^${oc}]+`, embed],
      [`${o}`, embed],                                                   // a stray `<` in the body is content
    ];
  }

  return {
    defaultToken: '',
    tokenPostfix: `.${(grammar as { name?: string }).name ?? 'markup'}`,
    ignoreCase: true,            // HTML tag/attribute names are case-insensitive
    brackets: [],
    tokenizer,
  };
}

// ── Main generator ──

function applyAdjacentTagHeadMonarch(grammar: CstGrammar, tokenizer: Record<string, MonarchRule[]>): void {
  const usesAdjacent = (() => {
    const w = (e: RuleExpr | undefined): boolean => !e ? false
      : e.type === 'adjacent' ? true
      : (e.type === 'seq' || e.type === 'alt') ? e.items.some(w)
      : (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') ? w(e.body)
      : e.type === 'sep' ? w(e.element) : false;
    return grammar.rules.some(r => w(r.body));
  })();
  if (!usesAdjacent) return;

  const tokenNames = new Set(grammar.tokens.map(t => t.name));
  const isTok = (n: string) => tokenNames.has(n);
  const tokByName = new Map(grammar.tokens.map(t => [t.name, t]));
  const ruleByName = new Map(grammar.rules.map(r => [r.name, r]));
  const directTokens = (e: RuleExpr | undefined, out: Set<string>): void => {
    if (!e) return;
    if (e.type === 'ref') { if (isTok(e.name)) out.add(e.name); return; }
    if (e.type === 'seq' || e.type === 'alt') { for (const i of e.items) directTokens(i, out); return; }
    if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') return directTokens(e.body, out);
    if (e.type === 'sep') return directTokens(e.element, out);
  };
  const directRules = (e: RuleExpr | undefined, out: Set<string>): void => {
    if (!e) return;
    if (e.type === 'ref') { if (!isTok(e.name)) out.add(e.name); return; }
    if (e.type === 'seq' || e.type === 'alt') { for (const i of e.items) directRules(i, out); return; }
    if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') return directRules(e.body, out);
    if (e.type === 'sep') return directRules(e.element, out);
  };
  const reachableTokens = (rn: string, out: Set<string>, seen = new Set<string>()): void => {
    if (seen.has(rn)) return; seen.add(rn);
    const r = ruleByName.get(rn); if (!r) return;
    const t = new Set<string>(); directTokens(r.body, t); for (const x of t) out.add(x);
    const rr = new Set<string>(); directRules(r.body, rr); for (const x of rr) reachableTokens(x, out, seen);
  };

  const selectorTokens = new Set<string>(), leadTokens = new Set<string>(), attrRules = new Set<string>();
  const glued = (after: RuleExpr | undefined, leads: string[]) => {
    if (!after) return;
    const t = new Set<string>(); directTokens(after, t);
    const r = new Set<string>(); directRules(after, r);
    if (t.size) { for (const x of t) selectorTokens.add(x); for (const l of leads) leadTokens.add(l); }
    for (const x of r) attrRules.add(x);
  };
  const payload = (e: RuleExpr): RuleExpr | null =>
    ((e.type === 'quantifier' || e.type === 'group') && e.body && e.body.type === 'seq' && e.body.items[0]?.type === 'adjacent')
      ? (e.body.items[1] ?? e.body) : null;
  const walkSeq = (items: RuleExpr[]) => {
    const leads: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type === 'adjacent') { glued(items[i + 1], leads.slice()); continue; }
      const p = payload(it); if (p) { glued(p, leads.slice()); continue; }
      const t = new Set<string>(); directTokens(it, t); for (const x of t) leads.push(x);
    }
  };
  const walk = (e: RuleExpr | undefined) => {
    if (!e) return;
    if (e.type === 'seq') walkSeq(e.items);
    if (e.type === 'seq' || e.type === 'alt') { for (const i of e.items) walk(i); return; }
    if (e.type === 'quantifier' || e.type === 'group' || e.type === 'not') return walk(e.body);
    if (e.type === 'sep') return walk(e.element);
  };
  for (const r of grammar.rules) walk(r.body);
  if (!selectorTokens.size) return;

  // Prefer Monaco-native tag-head tokens (tag/attribute.name) over the coarse generic mapping
  // (which folds every `entity.*` to `identifier`), so the tag head highlights per-part.
  const monarchScope = (sc: string): string =>
    sc.startsWith("entity.name.tag") ? "tag"
    : sc.startsWith("entity.other.attribute-name") ? "attribute.name"
    : sc.startsWith("support.class") ? "tag"
    : scopeToMonarch(sc);
  const scopeOf = (t: TokenDecl) => monarchScope(t.scope ?? classifyTokenScope(t));
  const pat = (n: string) => { const t = tokByName.get(n); return t ? tokenPatternSource(t).replace(/^\^/, '') : ''; };

  // Continuation selectors (stay in the head); plus the glued attribute list.
  const headRules: MonarchRule[] = [];
  for (const n of selectorTokens) { const t = tokByName.get(n); if (t) headRules.push([pat(n), scopeOf(t)]); }

  // Literals reachable inside the attr-list rule (`=`, `,`, …) — emitted as
  // delimiters so e.g. `name="v"` doesn't tokenize its `=` as the default token.
  const directLiterals = (e: RuleExpr, out: Set<string>): void => {
    if (e.type === 'literal') { out.add((e as { value: string }).value); return; }
    if (e.type === 'seq' || e.type === 'alt') { for (const i of e.items) directLiterals(i, out); return; }
    if ((e.type === 'quantifier' || e.type === 'group' || e.type === 'not') && e.body) return directLiterals(e.body, out);
    if (e.type === 'sep') return directLiterals(e.element, out);
  };
  const reachableLiterals = (rn: string, out: Set<string>, seen = new Set<string>()): void => {
    if (seen.has(rn)) return; seen.add(rn);
    const r = ruleByName.get(rn); if (!r) return;
    directLiterals(r.body, out);
    const rr = new Set<string>(); directRules(r.body, rr); for (const x of rr) reachableLiterals(x, out, seen);
  };

  let attrInclude = false;
  for (const rn of attrRules) {
    const ar = ruleByName.get(rn); if (!ar) continue;
    const alts = ar.body.type === 'alt' ? ar.body.items : [ar.body];
    let open = '(', close = ')';
    for (const a of alts) { const its = a.type === 'seq' ? a.items : [a];
      const lits = its.filter(x => x.type === 'literal').map(x => (x as { value: string }).value);
      if (lits.length >= 2) { open = lits[0]; close = lits[lits.length - 1]; } }
    const toks = new Set<string>(); reachableTokens(rn, toks);
    const inner: MonarchRule[] = [];
    for (const n of toks) { const t = tokByName.get(n); if (t) inner.push([pat(n), scopeOf(t)]); }
    const lits = new Set<string>(); reachableLiterals(rn, lits);
    lits.delete(open); lits.delete(close);
    // Stateful value rules FIRST: interpolated/multi-line templates and `{expr}`
    // holes reuse the shared nesting machinery (which pops back here) instead of
    // the flat single-line token patterns, which can't span `${…}` or newlines.
    const statefulValues: MonarchRule[] = [];
    if (tokenizer['templateN']) statefulValues.push(['`', { token: 'string', next: '@templateN' }]);
    if (tokenizer['bracketCounting']) {
      statefulValues.push(['\\{', { token: 'delimiter.bracket', next: '@bracketCounting' }]);
      lits.delete('{'); lits.delete('}');
    }
    const litRules: MonarchRule[] = [...lits].sort((a, b) => b.length - a.length)
      .map(l => [escapeRegex(l), 'delimiter'] as MonarchRule);
    tokenizer['adj_attrlist'] = [
      ...statefulValues,
      ...inner,
      ...litRules,
      ['[ \\t]+', 'white'],
      [escapeRegex(close), { token: 'delimiter.parenthesis', next: '@pop' }],
    ];
    headRules.push([escapeRegex(open), { token: 'delimiter.parenthesis', next: '@adj_attrlist' }]);
    attrInclude = true;
    break;
  }

  // The tag-head state: glued selectors/attrs stay; a space or EOL ENDS the head (resetting to
  // root via @popall through the body state) so anything after a space is plain text.
  tokenizer['adj_taghead'] = [
    ...headRules,
    ['[ \\t]+', { token: 'white', next: '@adj_tagbody' }],
    ['$', { token: '', next: '@popall' }],
    ['.', { token: '', next: '@adj_tagbody' }],
  ];
  tokenizer['adj_tagbody'] = [
    ['[^\\n]+', { token: '', next: '@popall' }],
    ['$', { token: '', next: '@popall' }],
  ];

  // root DISPATCHES the first token of each line: a head-lead (tag/selector) opens the tag head;
  // anything else routes to @adj_linebody — the normal line content, but WITHOUT the head-lead rules
  // and resetting at EOL via @popall. So a tag-name-like word later on a NON-element line (e.g. pipe
  // text `| word`) is never taken as a tag. (Monarch has no line-start anchor, so we anchor via the
  // per-line @popall reset + a one-shot dispatch.)
  const oldRoot = (tokenizer['root'] ?? []).slice();
  const leadRules: MonarchRule[] = [];
  for (const n of [...leadTokens, ...selectorTokens]) {
    const t = tokByName.get(n); if (!t) continue;
    leadRules.push([pat(n), { token: scopeOf(t), next: '@adj_taghead' }]);
  }
  tokenizer['adj_linebody'] = [...oldRoot, ['$', { token: '', next: '@popall' }]];
  tokenizer['root'] = [...leadRules, ['(?=.)', { token: '', next: '@adj_linebody' }]];
}


export function generateMonarch(grammar: CstGrammar): MonarchLanguage {
  if (grammar.markup) return generateMarkupMonarch(grammar);
  const { scopeOverrides } = grammar;

  // ── Identifier token: prefer the declared `identifier` hint (the lexer's own
  //    source of truth), else the token gen-tm would treat as the identifier. ──
  const identToken =
    grammar.tokens.find(t => t.identifier) ??
    grammar.tokens.find(t => classifyTokenScope(t) === 'variable.other');
  const identRegex = identToken ? tokenPatternSource(identToken) : '[a-zA-Z_]\\w*';

  // ── Every literal from rules + prec ops (the lexer's punctuation universe) ──
  const allLiterals = new Set<string>();
  for (const rule of grammar.rules) for (const l of collectLiterals(rule.body)) allLiterals.add(l);
  for (const level of grammar.precs) for (const op of level.operators) allLiterals.add(op.value);

  const precOpSet = new Set<string>();
  for (const level of grammar.precs) for (const op of level.operators) precOpSet.add(op.value);

  // ── Token hints ──
  const templateToken = grammar.tokens.find(t => t.template);
  const regexToken = grammar.tokens.find(t => t.flags.includes('regex'));
  const regexCtx = regexToken?.regexContext;
  const angle = detectAngleBrackets(grammar);

  // ── Brackets (Monaco bracket matching) — from punctuation.bracket.* scopes ──
  const bracketPairs: { open: string; close: string; token: string }[] = [];
  const byScope = new Map<string, string[]>();
  for (const [lit, scopes] of scopeOverrides)
    for (const s of scopes) (byScope.get(s) ?? byScope.set(s, []).get(s)!).push(lit);
  for (const [scope, lits] of byScope) {
    if (scope.startsWith('punctuation.bracket.') && lits.length === 2) {
      bracketPairs.push({ open: lits[0], close: lits[1], token: scopeToMonarch(scope) });
    }
  }
  const closeBrackets = new Set(bracketPairs.map(b => b.close));

  // ───────────────────────────────────────────────────────────────────────────
  // Keyword / built-in dispatch table for identifiers.
  //
  // Monarch idiom: match the identifier ONCE, then dispatch on its text via
  // `cases`. We precompute, for every alphabetic literal (keyword) and every
  // extra identifier that lives only in `scopes` (this/Promise/console/…), its
  // Monarch token using the SAME scope gen-tm assigns. So `if` and `Promise`
  // colour correctly without a regex-per-word.
  //
  // We also record which words leave us in VALUE position (a following `/` is
  // division). The grammar's regexContext hints refine this: regexAfterTexts
  // (return/typeof/…) RE-ENTER expression position; divisionAfterTexts
  // (this/true/…) force value position.
  // ───────────────────────────────────────────────────────────────────────────
  const identKeywordToken = new Map<string, string>();
  const valueWords = new Set<string>();
  const exprWords = new Set<string>(regexCtx?.regexAfterTexts ?? []);

  function wordProducesValue(scope: string): boolean {
    return scope.startsWith('constant.language') || scope.startsWith('variable.language') ||
           scope.startsWith('support.class') || scope.startsWith('support.variable') ||
           scope.startsWith('support.type');
  }
  const addWord = (word: string, scope: string) => {
    identKeywordToken.set(word, scopeToMonarch(scope));
    if (wordProducesValue(scope)) valueWords.add(word);
  };
  for (const lit of allLiterals) {
    if (isKeywordLiteral(lit)) addWord(lit, scopeOverrides.get(lit)?.[0] ?? 'keyword');
  }
  for (const [word, scopes] of scopeOverrides) {
    if (!isKeywordLiteral(word) || word.startsWith('.') || allLiterals.has(word)) continue;
    addWord(word, scopes[0]);
  }
  for (const txt of regexCtx?.divisionAfterTexts ?? [])
    if (isKeywordLiteral(txt)) valueWords.add(txt);
  for (const w of exprWords) valueWords.delete(w);   // expr-reentry wins over value

  // ── Symbolic literals → Monarch token (scope override wins; else operator if
  //    in the prec table, else structural delimiter) ──
  const symbolicLiterals = [...allLiterals].filter(l => !isKeywordLiteral(l));
  const symbolToken = new Map<string, string>();
  for (const lit of symbolicLiterals) {
    const scope = scopeOverrides.get(lit)?.[0];
    if (scope) symbolToken.set(lit, scopeToMonarch(scope));
    else if (precOpSet.has(lit)) symbolToken.set(lit, 'operator');
    else symbolToken.set(lit, 'delimiter');
  }
  const comparisonTok = symbolToken.get('<') ?? symbolToken.get('>') ?? 'operator';

  // ── Generic-open guard (the lookahead that disambiguates `<` generic-open
  //    from `<` less-than, WITHOUT Oniguruma recursion) ──
  //
  // We only treat a value-position `<` as a generic when a BOUNDED, SHALLOW
  // type-argument list follows: dotted identifiers separated by commas, with up
  // to ONE level of nested `<…>` (JS regex can't recurse), then a balanced `>`,
  // then either a confirm char (`(`/`` ` ``, from the grammar) OR end-of-line.
  // This keeps `a < b` / `a < b > c` as comparisons while catching `f<T>(…)`,
  // `f<A, B>(…)`, `f<Map<K,V>>(…)`, tagged templates, etc. It is strictly more
  // precise than Monaco's hand-written TS Monarch, which has NO such guard.
  let genericGuard = '';
  if (angle) {
    const cls = `[\\w${escapeForCharClass(identToken ? tokenPatternIdentifierExtraChars(identToken) : '')}]`;
    const id = `${cls}+(?:\\s*\\.\\s*${cls}+)*`;            // dotted identifier
    const lvl0 = `${id}(?:\\s*\\[\\s*\\])*`;                // T, a.b, T[]
    const inner = `${lvl0}(?:\\s*<\\s*${lvl0}(?:\\s*,\\s*${lvl0})*\\s*>)?`; // 1 nesting level
    const list = `${inner}(?:\\s*,\\s*${inner})*`;
    const confirmCls = angle.confirmChars.length
      ? `[${angle.confirmChars.map(escapeForCharClass).join('')}]`
      : null;
    const after = confirmCls ? `(?:\\s*${confirmCls}|\\s*$)` : '\\s*$';
    genericGuard = `(?=\\s*${list}\\s*>${after})`;
  }

  const tokenizer: Record<string, MonarchRule[]> = {};

  // Action builders for the two-mode (expression/value) flip via `switchTo`.
  const toValue = (token: string): MonarchAction => ({ token, switchTo: '@value' });
  const toExpr = (token: string): MonarchAction => ({ token, switchTo: '@root' });

  const wsRule: MonarchRule = ['[ \\t\\r\\n]+', 'white'];

  // ── Comments (mode-preserving spans: push/pop, never change expr/value mode) ──
  // A comment is whitespace-like, so after it we keep whatever mode we were in →
  // it must NOT use switchTo. Block comments span lines via a pushed state.
  const commentRules: MonarchRule[] = [];
  for (const t of grammar.tokens) {
    if (!t.flags.includes('skip')) continue;
    const scope = classifyTokenScope(t);
    const tok = scopeToMonarch(scope);
    const block = tokenPatternBlockDelimiters(t);
    if (block) {
      const [openLit, closeLit] = block;
      const [openRe, closeRe] = tokenPatternBlockDelimiterSources(t) ?? [escapeRegex(openLit), escapeRegex(closeLit)];
      const state = `comment_${delimStateSuffix(openLit)}`;
      commentRules.push([anchoredSource(openRe), { token: tok, next: `@${state}` }]);
      if (!tokenizer[state]) {
        const closeFirst = closeLit[0] ?? '*';
        tokenizer[state] = [
          [`[^${escapeForCharClass(closeFirst)}]+`, tok],
          [anchoredSource(closeRe), { token: tok, next: '@pop' }],
          ['.', tok],
        ];
      }
    } else {
      if (tokenPatternHasStartAnchor(t)) continue;
      const prefix = tokenPatternLiteralPrefix(t);
      if (prefix) commentRules.push([`${escapeRegex(prefix)}.*$`, tok]);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Value-producing spans (strings, templates).
  //
  // These need TWO entry variants because of how Monarch's state stack interacts
  // with our expr/value mode tracking:
  //   • From a base mode (`root`/`value`) we enter via `switchTo` so that on
  //     close we `switchTo '@value'` (a string/template yields a value) without
  //     leaking a stack frame.
  //   • From inside an interpolation hole (a pushed frame) we enter via `next`
  //     (push) into a `…N` variant whose close does `@pop`, so the hole context
  //     below is preserved. (Strings can't hold interpolation, but they DO occur
  //     inside holes, so they need the nested variant too.)
  // The rule bodies are shared via `include`; only the close rule differs.
  // ───────────────────────────────────────────────────────────────────────────

  const stringTopRules: MonarchRule[] = [];      // entered from root/value
  const stringNestedRules: MonarchRule[] = [];   // entered from interpolation holes
  // Highlight-only string interpolation regions (e.g. env-spec `${…}` / `$(…)`): per region we add a
  // begin rule into the string body and build a dedicated interp state (re-enter the expression body,
  // pop on the region's end). Specs are collected here; the states are built after templates, once the
  // nested string/template rules they include are populated.
  const interpStateSpecs: { name: string; end: string }[] = [];

  for (const t of grammar.tokens) {
    if (t.flags.includes('skip') || t.flags.includes('regex') || t.template) continue;
    // A token is a string if it carries the `string` lexer hint (the same signal
    // gen-vscode-config uses) OR its shape classifies as a string. The hint lets
    // a non-quote delimiter (e.g. `~…~`) be a string without hardcoding quotes.
    const classified = classifyTokenScope(t);
    if (!t.string && !classified.startsWith('string')) continue;
    const scope = t.scope ?? (classified.startsWith('string') ? classified : 'string.quoted');
    const tok = scopeToMonarch(scope);
    for (const delim of tokenPatternStringDelimiters(t)) {
      const suffix = delimStateSuffix(delim);
      const bodyState = `string_${suffix}_body`;
      if (!tokenizer[bodyState]) {
        const body: MonarchRule[] = [];
        const escapePattern = tokenEscapePatternSource(t);
        if (escapePattern) body.push([anchoredSource(escapePattern), 'string.escape']);
        // Interpolation openers come BEFORE the content run so they win; the content run then excludes
        // any position that begins an interpolation (negative lookahead) so it can't swallow `${`.
        const interps = t.interpolation ?? [];
        interps.forEach((interp, i) => {
          const name = `string_interp_${suffix}_${i + 1}`;
          body.push([escapeRegex(interp.begin), { token: 'delimiter.bracket', next: `@${name}` }]);
          interpStateSpecs.push({ name, end: interp.end });
        });
        const dc = escapeForCharClass(delim[0]);
        const content = interps.length
          ? `(?:(?!${interps.map(p => escapeRegex(p.begin)).join('|')})[^${dc}\\\\])+`
          : `[^${dc}\\\\]+`;
        body.push([content, tok]);
        body.push(['\\\\.', 'string.escape']);
        tokenizer[bodyState] = body;
      }
      // top-level: switchTo into the string, close → switchTo value
      const topState = `string_${suffix}`;
      if (!tokenizer[topState]) {
        tokenizer[topState] = [
          { include: `@${bodyState}` },
          [escapeRegex(delim), toValue(tok)],
        ];
        stringTopRules.push([escapeRegex(delim), { token: tok, switchTo: `@${topState}` }]);
      }
      // nested (inside interpolation): push, close → pop
      const nestedState = `string_${suffix}N`;
      if (!tokenizer[nestedState]) {
        tokenizer[nestedState] = [
          { include: `@${bodyState}` },
          [escapeRegex(delim), { token: tok, next: '@pop' }],
        ];
        stringNestedRules.push([escapeRegex(delim), { token: tok, next: `@${nestedState}` }]);
      }
    }
  }

  // Template literal + interpolation.
  const templateTopRules: MonarchRule[] = [];
  const templateNestedRules: MonarchRule[] = [];
  if (templateToken?.template) {
    const { open, interpOpen, interpClose } = templateToken.template;
    const scope = templateToken.scope ?? 'string.quoted.other.template';
    const tok = scopeToMonarch(scope);
    const interpOpenEsc = escapeRegex(interpOpen);
    const escapePattern = tokenEscapePatternSource(templateToken);
    const stopChars = escapeForCharClass(open[0]) + '\\\\' + escapeForCharClass(interpOpen[0]);

    // Shared template body (content + escapes + `${` → interpolation), no close.
    const bodyState = 'template_body';
    const tbody: MonarchRule[] = [];
    if (escapePattern) tbody.push([anchoredSource(escapePattern), 'string.escape']);
    tbody.push([interpOpenEsc, { token: 'delimiter.bracket', next: '@templateInterp' }]);
    tbody.push([`[^${stopChars}]+`, tok]);
    tokenizer[bodyState] = tbody;

    // top-level template: switchTo, close → value
    tokenizer['template'] = [
      { include: `@${bodyState}` },
      [escapeRegex(open), toValue(tok)],
      ['.', tok],
    ];
    templateTopRules.push([escapeRegex(open), { token: tok, switchTo: '@template' }]);

    // nested template (inside an interpolation hole): push, close → pop
    tokenizer['templateN'] = [
      { include: `@${bodyState}` },
      [escapeRegex(open), { token: tok, next: '@pop' }],
      ['.', tok],
    ];
    templateNestedRules.push([escapeRegex(open), { token: tok, next: '@templateN' }]);

    // Interpolation hole: a balanced `interpClose` at this frame's depth ends it
    // (pop → back to the template body). A plain `{` pushes a brace-counting
    // frame so inner object literals don't prematurely close the hole. Inside
    // holes we run the shared expression body @exprBody plus the NESTED span
    // entries and a single-mode `/` handling (the precise expr/value `/` split is
    // a TOP-LEVEL feature; documented bound).
    tokenizer['templateInterp'] = [
      wsRule,
      ...commentRules,
      ...stringNestedRules,
      ...templateNestedRules,
      ['\\{', { token: 'delimiter.bracket', next: '@bracketCounting' }],
      [escapeRegex(interpClose), { token: 'delimiter.bracket', next: '@pop' }],
      { include: '@interpExprBody' },
    ];
    tokenizer['bracketCounting'] = [
      wsRule,
      ...commentRules,
      ...stringNestedRules,
      ...templateNestedRules,
      ['\\{', { token: 'delimiter.bracket', next: '@bracketCounting' }],
      ['\\}', { token: 'delimiter.bracket', next: '@pop' }],
      { include: '@interpExprBody' },
    ];
  }

  // String-interpolation states (collected in the string loop above). Built here, after templates,
  // so the nested string/template rules they include are populated; `@interpExprBody` is a lazy
  // include resolved by Monarch. A bare `{` pushes a brace-counting frame (shared with templates).
  if (interpStateSpecs.length) {
    if (!tokenizer['bracketCounting']) {
      tokenizer['bracketCounting'] = [
        wsRule, ...commentRules, ...stringNestedRules, ...templateNestedRules,
        ['\\{', { token: 'delimiter.bracket', next: '@bracketCounting' }],
        ['\\}', { token: 'delimiter.bracket', next: '@pop' }],
        { include: '@interpExprBody' },
      ];
    }
    for (const spec of interpStateSpecs) {
      tokenizer[spec.name] = [
        wsRule, ...commentRules, ...stringNestedRules, ...templateNestedRules,
        ['\\{', { token: 'delimiter.bracket', next: '@bracketCounting' }],
        [escapeRegex(spec.end), { token: 'delimiter.bracket', next: '@pop' }],
        { include: '@interpExprBody' },
      ];
    }
  }

  // ── Numbers (most-specific first; token decl order encodes specificity) ──
  const numberRules: MonarchRule[] = [];
  for (const t of grammar.tokens) {
    const pattern = tokenPatternSource(t);
    const scope = classifyTokenScope(t);
    if (!scope.startsWith('constant.numeric')) continue;
    numberRules.push([anchoredSource(pattern), toValue(scopeToMonarch(scope))]);
  }

  // ── Other simple scoped tokens (decorator @x, private #x, …) → value ──
  const otherTokenRules: MonarchRule[] = [];
  for (const t of grammar.tokens) {
    if (t.flags.includes('skip') || t.flags.includes('regex') || t.template || t === identToken) continue;
    if (t.string) continue;  // handled as a string span above
    const pattern = tokenPatternSource(t);
    const scope = classifyTokenScope(t);
    if (scope.startsWith('string') || scope.startsWith('constant.numeric')) continue;
    otherTokenRules.push([anchoredSource(pattern), toValue(scopeToMonarch(scope))]);
  }

  // ── Identifier rule with keyword/built-in dispatch ──
  // Plain identifiers → value. Words that re-enter expression position
  // (typeof/return/new/…) → root. Built-in values (this/Promise/…) → value.
  // Generic keywords → expression position (operands follow).
  const identCases: Record<string, MonarchAction> = {};
  for (const [word, tok] of identKeywordToken) {
    identCases[word] = exprWords.has(word) ? toExpr(tok)
      : valueWords.has(word) ? toValue(tok)
      : toExpr(tok);
  }
  // Variant used inside interpolation holes (single-mode → no switchTo, which
  // would clobber the hole frame; just emit the token, stay in the hole).
  const identCasesInterp: Record<string, MonarchAction> = {};
  for (const [word, tok] of identKeywordToken) identCasesInterp[word] = tok;

  const identRule: MonarchRule = [
    anchoredSource(identRegex),
    { cases: { ...identCases, '@default': toValue('identifier') } },
  ];
  const identRuleInterp: MonarchRule = [
    anchoredSource(identRegex),
    { cases: { ...identCasesInterp, '@default': 'identifier' } },
  ];

  // ── Operators & structural punctuation ──
  // Closers (`)`,`]`,`}`) → value position; everything else (openers, `,`, ops,
  // accessors) → expression position. `<`/`>` are withheld when generics are
  // active (handled by typeargs + comparison fallback). `/`-leading symbols are
  // handled by the slash rules.
  function buildSymbolRules(modeFlip: boolean): MonarchRule[] {
    const rules: MonarchRule[] = [];
    if (modeFlip) {
      for (const lit of [...closeBrackets].sort((a, b) => b.length - a.length)) {
        rules.push([escapeRegex(lit), toValue(symbolToken.get(lit) ?? 'delimiter')]);
      }
    }
    const groups = new Map<string, string[]>();
    for (const lit of symbolicLiterals) {
      if (modeFlip && closeBrackets.has(lit)) continue;
      if (angle && (lit === '<' || lit === '>')) continue;
      if (regexToken && lit[0] === '/') continue;
      const tok = symbolToken.get(lit)!;
      (groups.get(tok) ?? groups.set(tok, []).get(tok)!).push(lit);
    }
    for (const [tok, lits] of groups) {
      const sorted = [...lits].sort((a, b) => b.length - a.length);
      rules.push([sorted.map(escapeRegex).join('|'), modeFlip ? toExpr(tok) : tok]);
    }
    return rules;
  }
  const symbolRules = buildSymbolRules(true);          // top-level (mode-flipping)
  const symbolRulesInterp = buildSymbolRules(false);   // inside holes (no mode flip)

  // ── The `/` rules (only ambiguous when a regex token exists) ──
  const exprSlashRules: MonarchRule[] = [];
  const valueSlashRules: MonarchRule[] = [];
  const interpSlashRules: MonarchRule[] = [];
  if (regexToken) {
    const regexPattern = tokenPatternSource(regexToken);
    exprSlashRules.push([anchoredSource(regexPattern), toValue('regexp')]);
    const slashOps = symbolicLiterals.filter(o => o[0] === '/').sort((a, b) => b.length - a.length);
    const slashTok = symbolToken.get('/') ?? 'operator';
    if (slashOps.length) valueSlashRules.push([slashOps.map(escapeRegex).join('|'), toExpr(slashTok)]);
    // Inside holes (single-mode): prefer a regex literal, else division operator.
    interpSlashRules.push([anchoredSource(regexPattern), 'regexp']);
    if (slashOps.length) interpSlashRules.push([slashOps.map(escapeRegex).join('|'), slashTok]);
  }

  // ── Generic type-argument state (shallow generics done well) ──
  if (angle) {
    const typeCases: Record<string, MonarchAction> = {};
    for (const [word, tok] of identKeywordToken) {
      if (tok === 'keyword' || tok === 'operator') typeCases[word] = tok;  // primitives/keywords keep token
    }
    const typeArgRules: MonarchRule[] = [
      wsRule,
      ...commentRules,
      ['<', { token: 'delimiter.angle', next: '@typeargs' }],   // nested generics (stacked)
      ['>', { token: 'delimiter.angle', next: '@pop' }],        // close one frame → value
      [anchoredSource(identRegex), { cases: { ...typeCases, '@default': 'type.identifier' } }],
      [',', 'delimiter'],
      ['\\.', 'delimiter'],
    ];
    if (symbolToken.has('|')) typeArgRules.push(['\\|', 'operator']);
    if (symbolToken.has('&')) typeArgRules.push(['&', 'operator']);
    if (symbolToken.has('[') && symbolToken.has(']')) {
      typeArgRules.push(['\\[\\]', 'operator']);
      typeArgRules.push(['[\\[\\]]', 'delimiter.square']);
    }
    // Bail-out: a char that cannot be inside a type closes the type-args context
    // (defensive against an unbalanced `<` — e.g. if a genuine `a < b` slipped past
    // the open guard). Zero-width lookahead + `@pop`: nothing is consumed, so the
    // char is re-scanned in `value`. (The guard makes this path rare in practice.)
    typeArgRules.push(['(?=[;)\\]}=])', { token: '', next: '@pop' }]);
    tokenizer['typeargs'] = typeArgRules;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Compose the states.
  //   @exprBody       — shared body for an EXPRESSION position (top-level modes).
  //   root            — expr position: @exprBody + regex `/` + `<`/`>` comparison.
  //   value           — value position: generic `<` + @exprBody + division `/` …
  //   @interpExprBody — body used inside interpolation holes (single-mode).
  // ───────────────────────────────────────────────────────────────────────────
  const exprBody: MonarchRule[] = [
    wsRule,
    ...commentRules,
    ...stringTopRules,
    ...templateTopRules,
    ...numberRules,
    ...otherTokenRules,
    identRule,
    ...symbolRules,
  ];
  tokenizer['exprBody'] = exprBody;

  const root: MonarchRule[] = [{ include: '@exprBody' }];
  if (regexToken) root.push(...exprSlashRules);
  if (angle) root.push(['<|>', toExpr(comparisonTok)]);   // expr-pos `<`/`>` = comparison
  tokenizer['root'] = root;

  const value: MonarchRule[] = [];
  if (angle) {
    // `<` after a value opens generics ONLY when the bounded type-arg lookahead
    // succeeds (otherwise it stays a comparison via the `<|>` fallback below).
    value.push([`<${genericGuard}`, { token: 'delimiter.angle', next: '@typeargs' }]);
  }
  value.push({ include: '@exprBody' });
  if (regexToken) value.push(...valueSlashRules);
  if (angle) value.push(['<|>', toExpr(comparisonTok)]);  // leftover `<`/`>` = comparison
  tokenizer['value'] = value;

  // Body used inside interpolation holes. Single-mode (no expr/value switchTo,
  // which would clobber the hole frame on the stack). Spans use the nested
  // (push/pop) variants, already injected by templateInterp/bracketCounting.
  if (templateToken?.template) {
    const interpExprBody: MonarchRule[] = [
      ...numberRules.map(stripSwitch),
      ...otherTokenRules.map(stripSwitch),
      identRuleInterp,
      ...interpSlashRules,
      ...symbolRulesInterp,
    ];
    if (angle) interpExprBody.push(['[<>]', comparisonTok]);
    tokenizer['interpExprBody'] = interpExprBody;
  }

  applyAdjacentTagHeadMonarch(grammar, tokenizer);

  return {
    defaultToken: 'invalid',
    tokenPostfix: `.${(grammar as { name?: string }).name ?? 'lang'}`,
    ignoreCase: false,
    brackets: bracketPairs,
    tokenizer,
  };
}

/** Drop a `switchTo`/`next` mode flip from a rule's action, keeping just the
 *  token — used to reuse top-level value-producing rules inside interpolation
 *  holes where switching the base mode would clobber the hole's stack frame. */
function stripSwitch(rule: MonarchRule): MonarchRule {
  if (Array.isArray(rule) && rule.length >= 2 && rule[1] && typeof rule[1] === 'object' && 'token' in rule[1]) {
    return [rule[0], (rule[1] as { token: string }).token];
  }
  return rule;
}
