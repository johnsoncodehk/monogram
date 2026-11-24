import type { CstGrammar, RuleExpr, TokenDecl, TokenPattern } from './types.ts';
import { regionView, type RegionView, type NameShape } from './region-view.ts';
import { directivesOf } from './grammar-analysis.ts';
import { armGraph, findWindows, hasWindow, inArmOrder } from './arm-graph.ts';
import { classifyTokenScope, scopeToMonarch } from './highlight-roles.ts';
import { highlightFacts, type TypeContext } from './highlight-facts.ts';
import type { HighlighterRefusal } from './define-highlighter.ts';
import { identifierClassesOf } from './uni-ident.ts';
import { info as patternInfo, type CSet } from './lex-match-plan.ts';
import { collectLiterals, escapeRegex, isKeywordLiteral } from './grammar-utils.ts';
import {
  caseFoldLiteralSource,
  tokenEscapePatternSource,
  tokenPatternBlockDelimiterSources,
  tokenPatternBlockDelimiters,
  tokenPatternHasStartAnchor,
  tokenPatternIdentifierExtraChars,
  tokenPatternLiteralPrefix,
  tokenPatternSource,
  tokenPatternStringDelimiters,
  tokenPatternToRegex,
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
// from the per-token lexer hints, exactly like emit-lexer.ts.
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
  | { token: string; next?: string; switchTo?: string; nextEmbedded?: string }   // token `@rematch`: consume nothing
  | { cases: Record<string, MonarchAction> }
  | MonarchAction[];   // one action per capture group (the groups cover the match)

/** A single tokenizer rule. */
export type MonarchRule =
  | [string, MonarchAction]
  | [string, MonarchAction, string]
  | { include: string };

export interface MonarchLanguage {
  defaultToken: string;
  tokenPostfix: string;
  ignoreCase: boolean;
  /** Every regex is compiled with the `u` flag (Monaco's `unicode` option). */
  unicode?: boolean;
  /** Bracket pairs for Monaco bracket matching / colorization. */
  brackets: { open: string; close: string; token: string }[];
  /** The tokenizer state machine. */
  tokenizer: Record<string, MonarchRule[]>;
  /** The identifier's regex, read by the rules as `@ident`. */
  ident?: string;
}

// ── Regex helpers (JS RegExp dialect) ──

/** Escape a char for use inside a `[...]` class (JS dialect specials). */
const OPEN_BRACKETS = new Set(['(', '[', '{', '<']);

// What the Monarch renderer declines, per grammar (src/highlighters.ts reads it): filled by
// generateMonarch.
const refusalsOf = new WeakMap<CstGrammar, HighlighterRefusal[]>();
export function monarchRefusals(grammar: CstGrammar): HighlighterRefusal[] {
  if (!refusalsOf.has(grammar)) generateMonarch(grammar);
  return refusalsOf.get(grammar) ?? [];
}

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


// ── Angle-bracket (generic) ambiguity detection — mirrors gen-tm ──
//
// `<` is generic-open iff it is BOTH a prec-table operator (comparison) AND a
// rule delimiter paired with `>` around a separated inner rule (the type args).

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

  // Over the arm graph (src/arm-graph.ts): a `'<' sep '>'` window in a rule-body arm, and the confirming
  // characters of the items after it, in the order the arms meet them.
  const g = armGraph(grammar);
  const isLit = (v: string) => (e: RuleExpr) => e.type === 'literal' && e.value === v;
  const steps = [isLit('<'), (e: RuleExpr) => e.type === 'sep', isLit('>')];
  const rules = (r: number) => g.rootKind[r] === 'rule';
  return hasWindow(g, steps, rules) ? {
    confirmChars: inArmOrder(g, findWindows(g, [...steps, () => true], rules).flatMap(w => { const ch = confirmCharOf(g.node[w[3]]); return ch && ch.length === 1 ? [{ value: ch, window: w }] : []; })),
  } : null;
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

export function generateMonarch(grammar: CstGrammar): MonarchLanguage {
  return monacoRegexes(grammar.markup ? generateMarkupMonarch(grammar) : generateTokenMonarch(grammar));
}

// Monaco's Monarch compiler reads `@name` in a rule's regex as a reference to the language
// attribute `name` (and throws when there is none); `@@` is a literal `@`. The generator's
// regexes mean every `@` literally, so an `@` before a word unit is written `@@`, once, here
// (`@if` in a directive opener; a lone `@` before a non-word unit is left as it is).
// A reference to a language attribute in a generated regex (`${ATTR}ident` is `@ident`).
const ATTR = '\u0002';
function monacoRegexes(lang: MonarchLanguage): MonarchLanguage {
  // a copy of each rule: one rule object can stand in several states
  const tokenizer = Object.fromEntries(Object.entries(lang.tokenizer).map(([k, rules]) =>
    [k, rules.map(r => Array.isArray(r) ? [r[0].replace(/@(?=\w)/g, '@@').replaceAll(ATTR, '@'), ...r.slice(1)] as MonarchRule : r)]));
  return { ...lang, tokenizer };
}

function generateTokenMonarch(grammar: CstGrammar): MonarchLanguage {
  const { scopeOverrides } = grammar;
  const view = regionView(grammar);

  // ── Identifier token: the one TextMate reads (highlight-facts' identToken: the declared
  //    `identifier` token, else the bare `variable.other` token). ──
  const identToken = highlightFacts(grammar).identToken;
  // A declared identifier token's run is the lexer's: its ASCII pattern or a run starting at a
  // Unicode IdentifierStart character, extended by IdentifierPart characters (uni-ident.ts
  // identifierClassesOf, the classes the lexer compiles). The classes are `\p{…}` properties, so
  // the language is compiled in u-mode (`unicode: true`): EVERY regex of it must then be valid
  // under the `u` flag (no identity escape of a non-syntax character, no lone `{`), which
  // test/monarch-dialect.ts's compile section checks.
  const uniIdent = identToken?.identifier ? identifierClassesOf(grammar.tokens) : null;
  const identRegex = !identToken ? '[a-zA-Z_]\\w*'
    : uniIdent ? `(?:${anchoredSource(tokenPatternSource(identToken))}|${uniIdent.start})${uniIdent.continue}*`
    : tokenPatternSource(identToken);
  // Every rule reads the identifier through the language attribute `ident` (Monaco's compiler
  // substitutes `@ident`; the marker becomes the `@` after monacoRegexes' escaping).
  const IDENT = `${ATTR}ident`;

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
    // A `support.class` word (`Set`, `Error`, `Array`) is an identifier: in an expression state it
    // is a VALUE name (`new Set()`, `Array.isArray(v)`, `throw new Error(…)`: the parser reads an
    // identifier reference there), so it keeps the identifier token; in a type state (`type`)
    // every name is a type anyway.
    if (scopes[0] === 'support.class' || scopes[0].startsWith('support.class.')) continue;
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
  // One skip token's rule, with the regex of its start: a block (open / close delimiters) pushes a
  // state that spans lines; a token with a literal prefix runs to the end of the line. Shared by
  // the code (`commentRules`) and an element region's text tokens.
  const skipTokenRule = (t: TokenDecl): { rule: MonarchRule; start: string } | null => {
    const scope = classifyTokenScope(t);
    const tok = scopeToMonarch(scope);
    const block = tokenPatternBlockDelimiters(t);
    if (block) {
      const [openLit, closeLit] = block;
      const [openRe, closeRe] = tokenPatternBlockDelimiterSources(t) ?? [escapeRegex(openLit), escapeRegex(closeLit)];
      const state = `comment_${delimStateSuffix(openLit)}`;
      if (!tokenizer[state]) {
        const closeFirst = closeLit[0] ?? '*';
        tokenizer[state] = [
          [`[^${escapeForCharClass(closeFirst)}]+`, tok],
          [anchoredSource(closeRe), { token: tok, next: '@pop' }],
          ['.', tok],
        ];
      }
      return { rule: [anchoredSource(openRe), { token: tok, next: `@${state}` }], start: anchoredSource(openRe) };
    }
    if (tokenPatternHasStartAnchor(t)) return null;
    const prefix = tokenPatternLiteralPrefix(t);
    return prefix ? { rule: [`${escapeRegex(prefix)}.*$`, tok], start: escapeRegex(prefix) } : null;
  };
  const commentRules: MonarchRule[] = [];
  for (const t of grammar.tokens) {
    if (!t.flags.includes('skip')) continue;
    const r = skipTokenRule(t);
    if (r) commentRules.push(r.rule);
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
    if (t.name === grammar.elements?.text || grammar.elements?.tagTokens?.includes(t.name) || grammar.elements?.rawText?.some(r => r.token === t.name)) continue;  // an element region's own tokens exist only inside the region
    if (t.string) continue;  // handled as a string span above
    // a prefixed identifier (`#name`: `identifierPrefix`) reads its name as the identifier does
    const pattern = t.identifierPrefix && uniIdent
      ? `(?:${anchoredSource(tokenPatternSource(t))}|${escapeRegex(t.identifierPrefix)}${uniIdent.start})${uniIdent.continue}*`
      : tokenPatternSource(t);
    const scope = classifyTokenScope(t);
    if (scope.startsWith('string') || scope.startsWith('constant.numeric')) continue;
    otherTokenRules.push([anchoredSource(pattern), toValue(scopeToMonarch(scope))]);
  }

  const wordEnd = `(?![\\w${escapeForCharClass(identToken ? tokenPatternIdentifierExtraChars(identToken) : '')}])`;
  // ── Type positions (highlight-facts' typeBody / typeContexts) ──
  // One state family: `type` is a type's text (type words and names, literal types, the type
  // operators), shared by include; `<` `(` `[` `{` push the bracket states, each popped by its
  // close bracket; a type POSITION is a state that ends the type, zero-width, at the closers the
  // fact computes for it (the literal FOLLOW of the reference, through rule ends), and includes
  // `type`. A closer that also continues a type (the fact's conflicts) ends it only where the
  // parser does not read the type on (`reads: 'closer'`); a bracket that begins a type never ends
  // one there. Entered where one rule's text shows the position: after a keyword opener (`as`,
  // `satisfies`, `is`, `implements`), at a declaration head `kw name (<…>)? opener` (`type A =`,
  // `let x:`), and at a type-argument `<` (the bounded lookahead below). Every other position,
  // and every conflict read as a closer, is a refusal.
  const facts = highlightFacts(grammar);
  const tbody = facts.typeBody;
  const typeEntryRules: MonarchRule[] = [];
  const rootTypeRules: MonarchRule[] = [];   // tried in an expression position only (Monarch's root state)
  const refusals: HighlighterRefusal[] = [];
  const refuse = (construct: string) => { if (!refusals.some(r => r.construct === construct)) refusals.push({ construct, reason: 'Monarch matches at the cursor and sees no text before it' }); };
  if (tbody) {
    const ident = IDENT;
    const tok = (lit: string, dflt = 'delimiter') => symbolToken.get(lit) ?? dflt;
    // the words of a type: its keywords (typeContextKeywords: `keyof`, `void`, `infer` … a
    // keyword there, whatever the expression reads), the scoped built-ins; every other word names a type
    const typeCases: Record<string, MonarchAction> = {};
    // a word scoped for both readings (`void`: an operator, a primitive type) takes its type
    // scope (`support.type…`) there, as TextMate's type rules do
    for (const w of facts.typeContextKeywords) {
      const scopes = scopeOverrides.get(w) ?? [];
      const ty = scopes.find(x => x.startsWith('support.type'));
      typeCases[w] = ty ? scopeToMonarch(ty) : identKeywordToken.get(w) ?? 'keyword';
    }
    // a word of a type followed by a VALUE name (`typeof a.b`: tbody.valueAfter): the name, then
    // `.` name, reads as an identifier
    const valueAfter = tbody.valueAfter.filter(w => typeCases[w]);
    if (valueAfter.length) {
      tokenizer['typeValue'] = [wsRule, [ident, { token: 'identifier', switchTo: '@typeValueDot' }], ['', { token: '', next: '@pop' }]];
      tokenizer['typeValueDot'] = [[`\\.(?=\\s*${ident})`, { token: tok('.'), switchTo: '@typeValue' }], ['', { token: '', next: '@pop' }]];
    }
    for (const [w] of scopeOverrides) if (identKeywordToken.has(w) && !allLiterals.has(w)) typeCases[w] = identKeywordToken.get(w)!;
    const idName0 = identToken ? `<${identToken.name}>` : null;
    const namedOpeners = [...new Set(facts.typeContexts.sites.filter(s => s.opener && isKeywordLiteral(s.opener) && s.left.length && s.left.every(([n, m]) => n === idName0 && m === ':')).map(s => s.opener!))].sort();
    const groups: [string, string, string][] = [];   // [open, close, state]
    groups.push(['<', '>', 'type_angle']);
    if (facts.parenType) groups.push(['(', ')', 'type_paren']);
    if (facts.bracketType) groups.push(['[', ']', 'type_square']);
    if (facts.objectType) groups.push(['{', '}', 'type_object']);
    tokenizer['type'] = [
      wsRule, ...commentRules, ...stringNestedRules, ...templateNestedRules, ...numberRules.map(stripSwitch),
      ...groups.map(([o, , st]) => [escapeRegex(o), { token: o === '<' ? 'delimiter.angle' : tok(o), next: `@${st}` }] as MonarchRule),
      ...valueAfter.length ? [[`(?:${valueAfter.map(escapeRegex).join('|')})${wordEnd}`, { cases: Object.fromEntries(valueAfter.map(w => [w, { token: typeCases[w] as string, next: '@typeValue' }])) }] as MonarchRule] : [],
      // a name before an opener word whose position's left is that name after `:` (`): x is T`: the
      // name of a parameter where a type would begin)
      ...namedOpeners.length ? [[`${ident}(?=\\s+(?:${namedOpeners.map(escapeRegex).join('|')})${wordEnd})`, 'identifier'] as MonarchRule] : [],
      [ident, { cases: { ...typeCases, '@default': 'type.identifier' } }],
      { include: '@symbols' },
    ];
    // a name before `:` / `?:` in a parameter list or tuple; in an object type also before `(` or
    // `<…>(` (a method signature: `NonNullable<T>` is no member name)
    const nameBefore = (f: string): MonarchRule => [`${ident}(?=\\s*${f})`, 'identifier'];
    for (const [o, c, st] of groups) tokenizer[st] = [
      [escapeRegex(c), { token: o === '<' ? 'delimiter.angle' : tok(c), next: '@pop' }],
      ...o === '<' ? [['(?=[;)\\]}])', { token: '', next: '@pop' }] as MonarchRule] : [],
      ...o === '(' || o === '[' ? [nameBefore('\\??\\s*:')] : o === '{' ? [nameBefore('\\??\\s*(?:[:(]|<[^<>]*>\\s*\\()')] : [],
      { include: '@type' },
    ];
    // ── the type positions: one state per closer set ──
    const { sites, openerWords } = facts.typeContexts;
    const typeLits = [...facts.typeLiterals];
    // a closer, as a lookahead alternative: not where a longer literal of a type begins with it
    // (`=` of `=>`), a word as a whole word
    const closerAlt = (c: string) => {
      if (isKeywordLiteral(c)) return escapeRegex(c) + wordEnd;
      const longer = typeLits.filter(l => l.length > c.length && l.startsWith(c)).map(l => escapeRegex(l.slice(c.length)));
      return escapeRegex(c) + (longer.length ? `(?!${longer.join('|')})` : '');
    };
    // the lookahead of a closer set: a closer another one's lookahead already sees is left out
    // (`==` behind `=(?!>)`), the one-character closers without an exception as one class
    const closerLookahead = (closers: string[]): string => {
      const alts = closers.map(c => [c, closerAlt(c)] as const);
      const kept = alts.filter(([c]) => !alts.some(([d, re]) => d !== c && d.length < c.length && new RegExp(`^(?:${re})`).test(c)));
      const single = kept.filter(([c, re]) => c.length === 1 && re === escapeRegex(c)).map(([c]) => c);
      const rest = kept.filter(([c, re]) => !(c.length === 1 && re === escapeRegex(c))).map(([, re]) => re);
      return `(?=${[...rest, ...single.length ? [`[${single.map(escapeForCharClass).join('')}]`] : []].join('|')})`;
    };
    const startsType = new Set(tbody.starts);
    const siteStates = new Map<string, string>();
    const siteState = (closers: string[]): string => {
      const key = closers.join('\0');
      let st = siteStates.get(key);
      if (!st) {
        siteStates.set(key, st = `type_${siteStates.size + 1}`);
        tokenizer[st] = [[closerLookahead(closers), { token: '', next: '@pop' }], { include: '@type' }];
        // a closer that is a bracket beginning a type (`{` after `x is`) begins it as the type's
        // first token: the position is entered in a state that reads that bracket's group, then
        // reads on in the position's state (after a first token the bracket ends the type)
        const firstBrackets = groups.filter(([o]) => closers.includes(o) && startsType.has(o));
        if (firstBrackets.length) tokenizer[`${st}_first`] = [
          wsRule,
          ...firstBrackets.map(([o, , gs]) => [escapeRegex(o), { token: tok(o), next: `@${gs}` }] as MonarchRule),
          ['', { token: '', switchTo: `@${st}` }],
        ];
      }
      return tokenizer[`${st}_first`] ? `${st}_first` : st;
    };
    const entered = new Set<TypeContext>();
    // the closers of the positions one entry reads: a list's delimiter goes on to the next type;
    // a conflict the parser reads as the type's is the type's; a bracket that begins a type
    // never ends one there (the entry reads the type's first token in the same state)
    const closersOf = (ss: TypeContext[], extra: string[] = []): string[] => {
      const out = new Set<string>(extra);
      for (const s of ss) {
        ss.forEach(x => entered.add(x));
        for (const c of s.closers) {
          if (c === s.delimiter || s.conflicts.some(k => k.literal === c && k.reads === 'type')) continue;
          if (OPEN_BRACKETS.has(c) && startsType.has(c)) refuse(`type after \`${s.opener}\`: \`${c}\` begins it as its first token, ends it after one (a bracket after a union's \`|\` ends it too)`);
          const k = s.conflicts.find(k => k.literal === c);
          if (k) refuse(`type after \`${s.opener}\`: \`${c}\` ends it (it continues a type only inside a construct or behind a lookahead not tracked)`);
          out.add(c);
        }
      }
      return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    };
    // 1. a keyword opener: the word pushes its position's state (in a base state and in a hole)
    //    where what begins a type follows it on the line (`is.filter(…)` is a name)
    const symStarts = tbody.starts.filter(l => !isKeywordLiteral(l)).map(escapeRegex);
    const typeAhead = `(?=\\s*(?:${[ident, ...symStarts].join('|')}))`;
    const openerCases: Record<string, MonarchAction> = {};
    for (const { word, elsewhere, ambiguous } of openerWords) {
      const ss = sites.filter(s => s.opener === word);
      if (ambiguous) refuse(`type after \`${word}\`: not entered (elsewhere the word is followed by an expression)`);
      if (ambiguous || !identKeywordToken.has(word)) continue;
      openerCases[word] = { token: identKeywordToken.get(word)!, next: `@${siteState(closersOf(ss, elsewhere))}` };
    }
    const openers = Object.keys(openerCases);
    if (openers.length) typeEntryRules.push([`(?:${openers.map(escapeRegex).join('|')})${wordEnd}${typeAhead}`, { cases: openerCases }]);
    // 2. a declaration head `kw name !? <…>? opener`, kw a variable-declaration keyword or a
    //    declaration whose name is followed by the opener (`type A =`): the keyword pushes a head
    //    state (the name, `!`, type parameters) whose opener switches to the position's state
    const idName = identToken ? `<${identToken.name}>` : null;
    const decls = new Map(facts.declarations.filter(d => d.endHint).map(d => [d.keyword, d] as const));
    const heads = new Map<string, { kws: string[]; opener: string; bang: boolean; params: boolean; sites: TypeContext[] }>();
    for (const s of sites) {
      if (entered.has(s) || !s.opener || isKeywordLiteral(s.opener) || s.insideBracket) continue;
      const kws = [...new Set(s.left.filter(([n, k]) => n === idName && k !== undefined
        && (facts.varDeclarationKeywords.has(k) || decls.get(k)?.endHint === s.opener)).map(p => p[1]))].sort();
      if (!kws.length) continue;
      const key = `${kws.join('|')}\0${s.opener}`;
      const h = heads.get(key) ?? heads.set(key, { kws, opener: s.opener, bang: false, params: false, sites: [] }).get(key)!;
      h.sites.push(s);
      h.bang ||= s.left.some(([n, m]) => n === '!' && m === idName);
      h.params ||= s.left.some(([n, m]) => m === idName && n !== idName && n.startsWith('<') && kws.some(k => decls.get(k)?.hasTypeParams));
    }
    let nHead = 0;
    for (const { kws, opener, bang, params, sites: ss } of heads.values()) {
      const st = siteState(closersOf(ss));
      const hs = `typehead_${++nHead}`;
      const nameTok = decls.has(kws[0]) ? scopeToMonarch(decls.get(kws[0])!.nameScope) : 'identifier';
      tokenizer[hs] = [
        wsRule, [ident, nameTok],
        ...bang ? [['!', tok('!', 'operator')] as MonarchRule] : [],
        ...params ? [['<', { token: 'delimiter.angle', next: '@type_angle' }] as MonarchRule] : [],
        [escapeRegex(opener), { token: tok(opener), switchTo: `@${st}` }],
        ['', { token: '', next: '@pop' }],
      ];
      const ahead = `(?=\\s+${ident}\\s*${bang ? '(?:!\\s*)?' : ''}(?:${params ? '<|' : ''}${escapeRegex(opener)}))`;
      typeEntryRules.push([`(?:${kws.map(escapeRegex).join('|')})${wordEnd}${ahead}`,
        { cases: Object.fromEntries(kws.map(k => [k, { token: identKeywordToken.get(k) ?? 'keyword', next: `@${hs}` }])) }]);
    }
    // 3. a parameter list: a `:` position whose left is a name right after an open bracket
    //    (`(x: T`, `[k: string`) is entered at the bracket, confirmed by a bounded lookahead: the
    //    bracket, words (modifiers, names) each followed by a space or `,`, an optional `...`, a
    //    name, `?`, `:` (`( name :` is no expression: a `:` after a name inside a bracket needs a
    //    ternary's `?` before it). The list's state reads its own `:` positions and default values
    //    (`=`, read to the list's `,` or close bracket, brackets counted), and after its close
    //    bracket a `:` position whose left is that bracket (a return type). Past the bound: a list
    //    whose first annotated parameter follows a binding pattern or a decorator is not entered.
    //    A `()` in an expression position (Monarch's root state) is an arrow's empty list; a `)`
    //    elsewhere followed by `: T {` (a name, `.` names, `<…>` without nested angles, `[]`,
    //    `|` unions) on the line is a return type before a body; `): T =>` there is not read (the
    //    ternary `c ? (x) : y => z`): both refusals.
    const interp = !!templateToken?.template;
    const closeOf = (o: string) => groups.find(([g]) => g === o)?.[1] ?? { '(': ')', '[': ']' }[o];
    const nameFirst = (n: string) => n === idName || (isKeywordLiteral(n) && !facts.varDeclarationKeywords.has(n));
    const listBrackets = [...new Set(sites.flatMap(s => s.opener === ':' && !entered.has(s) ? s.left.filter(([n, b]) => nameFirst(n) && (b === '(' || b === '[')).map(p => p[1]) : []))].sort();
    if (listBrackets.length && interp && tokenizer['bracketCounting']) {
      const listRules = new Set(sites.filter(s => s.opener === ':' && s.left.some(([n, b]) => nameFirst(n) && listBrackets.includes(b))).map(s => s.rule));
      const paramSites = sites.filter(s => s.opener === ':' && listRules.has(s.rule));
      const paramState = siteState(closersOf(paramSites));
      // brackets counted: `(` `[` pushed here, `{` by the brace-counting state, which reads the rest
      const nest: MonarchRule[] = [{ include: '@typeEntry' }, ['\\(', { token: tok('('), next: '@typenest_paren' }],
        ['\\[', { token: tok('['), next: '@typenest_square' }], { include: '@bracketCounting' }];
      tokenizer['typenest_paren'] = [['\\)', { token: tok(')'), next: '@pop' }], ...nest];
      tokenizer['typenest_square'] = [['\\]', { token: tok(']'), next: '@pop' }], ...nest];
      const listDelims = [...new Set(paramSites.flatMap(s => s.closers).filter(c => c === ',' || listBrackets.some(b => closeOf(b) === c)))];
      tokenizer['typelist_default'] = [[`(?=[${listDelims.map(escapeForCharClass).join('')}])`, { token: '', next: '@pop' }], ...nest];
      const eq = paramSites.some(s => s.closers.includes('=')) ? closerAlt('=') : null;
      const optional = paramSites.some(s => s.left.some(([n]) => n === '?'));
      const word = `${ident}\\s*${optional ? '\\??\\s*' : ''}:`;
      const spread = paramSites.some(s => s.left.some(([n, m]) => n === idName && m === '...')) ? '(?:\\.\\.\\.\\s*)?' : '';
      const ahead = `(?=\\s*(?:${ident}(?:\\s*,\\s*|\\s+))*${spread}${word})`;
      for (const b of listBrackets) {
        const c = closeOf(b)!, st = `typelist_${b === '(' ? 'paren' : 'square'}`;
        const ret = sites.filter(s => s.opener === ':' && s.left.some(([n]) => n === c));
        const rules: MonarchRule[] = [];
        if (ret.length) {
          const retState = siteState(closersOf(ret));
          tokenizer[`${st}_ret`] = [wsRule, [':', { token: tok(':'), switchTo: `@${retState}` }], ['', { token: '', next: '@pop' }]];
          rules.push([`${escapeRegex(c)}(?=\\s*:)`, { token: tok(c), switchTo: `@${st}_ret` }]);
          if (b === '(') {
            // outside a confirmed list: `): T {` on the line; in an expression position: `()`
            const T = `${ident}(?:\\s*\\.\\s*${ident})*(?:\\s*<[^<>;{}()]*>)?(?:\\s*\\[\\s*\\])*`;
            typeEntryRules.push([`\\)(?=\\s*:\\s*${T}(?:\\s*\\|\\s*${T})*\\s*\\{)`, { token: tok(')'), next: `@${st}_ret` }]);
            rootTypeRules.push([`\\((?=\\s*\\)\\s*:)`, { token: tok('('), next: `@${st}` }]);
            refuse(`return type after \`)\` + \`:\`: entered after a parameter list read as one, after \`()\` in an expression position, or before \`{\` on the line (\`c ? (x) : y => z\` is a ternary)`);
          }
        }
        tokenizer[st] = [
          ...rules,
          [escapeRegex(c), { token: tok(c), next: '@pop' }],
          [`${ident}(?=\\s*${optional ? '\\??\\s*' : ''}:)`, 'identifier'],
          [':', { token: tok(':'), next: `@${paramState}` }],
          ...eq ? [[eq, { token: tok('=', 'operator'), next: '@typelist_default' }] as MonarchRule] : [],
          ...nest,
        ];
        typeEntryRules.push([`${escapeRegex(b)}${ahead}`, { token: tok(b), next: `@${st}` }]);
      }
      refuse(`parameter list: entered where its first annotated parameter is a name (\`(a, b: T\`, \`(...r: T\`); after a binding pattern or a decorator not entered`);
    }
    // the positions no entry reads
    const left = new Map<string, number>();
    for (const s of sites) if (!entered.has(s) && s.opener !== '<' && s.insideBracket !== '<') { const k = `\`${s.opener ?? '?'}\` in ${s.rule}`; left.set(k, (left.get(k) ?? 0) + 1); }
    for (const [k, n] of left) refuse(`type position after ${k} (${n}): not entered (its left context is not in one rule's text)`);
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
    IDENT,
    { cases: { ...identCases, '@default': toValue('identifier') } },
  ];
  const identRuleInterp: MonarchRule = [
    IDENT,
    { cases: { ...identCasesInterp, '@default': 'identifier' } },
  ];
  // ── A keyword word where the keyword cannot stand is a name (highlight-facts'
  // keywordFollowers): a word whose closed follower set lacks the literal after it (`set:`,
  // `const from = 1`, `(of, x)`, `type(…)`). Keywords sharing a follower set share a rule; a
  // following word or token decides nothing (no rule), nor does a follower that is a prefix of
  // the literal there (the test is conservative). Tried before the identifier rule.
  const kwNames = highlightFacts(grammar).keywordNameGroups;
  // One copy, in a state both the base states and the holes include: its action sets no mode.
  // The mode after a name matters only when the next character reads differently in the
  // expression and the value state (`/`: a regex or a division; `<`: a comparison or type
  // arguments / a tag); the base states first try, per such character, the words whose group
  // has it among `starts` and no follower beginning with it, and switch to the value state.
  const kwNameRules: MonarchRule[] = kwNames.flatMap(({ words, followers, starts }) => {
    const ws = words.filter(w => identKeywordToken.has(w));
    if (!ws.length) return [];
    const f = followers.map(escapeRegex).join('|');
    return [[`(?:${ws.map(escapeRegex).join('|')})${wordEnd}${f ? `(?!\\s*(?:${f}))` : ''}(?=\\s*[${starts.map(escapeForCharClass).join('')}])`, 'identifier'] as MonarchRule];
  });
  const modeChars = [...regexToken ? ['/'] : [], ...angle || view ? ['<'] : []];
  const kwNameModeRules: MonarchRule[] = modeChars.flatMap(c => {
    const ws = kwNames.filter(k => k.starts.includes(c) && !k.followers.some(l => l.startsWith(c))).flatMap(k => k.words.filter(w => identKeywordToken.has(w)));
    return ws.length ? [[`(?:${ws.map(escapeRegex).join('|')})${wordEnd}(?=\\s*${escapeRegex(c)})`, toValue('identifier')] as MonarchRule] : [];
  });
  if (kwNameRules.length) tokenizer['keywordName'] = kwNameRules;
  const kwName: MonarchRule[] = kwNameRules.length ? [{ include: '@keywordName' }] : [];
  // the declaration heads push in a base state and in a hole alike: one state, included by both
  const typeEntry: MonarchRule[] = typeEntryRules.length ? [{ include: '@typeEntry' }] : [];
  if (typeEntryRules.length) tokenizer['typeEntry'] = typeEntryRules;
  const identRules = [...typeEntry, ...kwNameModeRules, ...kwName, identRule];
  const identRulesInterp = [...typeEntry, ...kwName, identRuleInterp];

  // ── Operators & structural punctuation ──
  // Closers (`)`,`]`,`}`) → value position; everything else (openers, `,`, ops,
  // accessors) → expression position. `<`/`>` are withheld when generics are
  // active (handled by type_angle + comparison fallback). `/`-leading symbols are
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

  // ── A name after a member-access text is a property (highlight-facts' memberAccessTexts, the
  // lexer's LX_MEMBER rule): `e.type`, `m.get(…)` are names, not the keywords `type` / `get`.
  // Monarch sees nothing before a rule's match, so the accessor itself enters a state where the
  // next word is read as a name: switched into from a base state (the name is a value), pushed
  // inside a hole (popped after the name). The accessor rule fires only when a word follows on
  // the line (a lookahead), so `?.(` / `...` / a number's `.5` keep their rules.
  const memberTexts = highlightFacts(grammar).memberAccessTexts.filter(t => allLiterals.has(t)).sort((a, b) => b.length - a.length);
  const memberEntry = (nested: boolean): MonarchRule[] => memberTexts.map(t =>
    [`${escapeRegex(t)}(?=\\s*${IDENT})`, nested
      ? { token: symbolToken.get(t) ?? 'delimiter', next: '@memberN' }
      : { token: symbolToken.get(t) ?? 'delimiter', switchTo: '@member' }] as MonarchRule);
  const memberRules = memberEntry(false), memberRulesInterp = memberEntry(true);
  if (memberTexts.length) {
    tokenizer['member'] = [wsRule, [IDENT, toValue('identifier')], ['', { token: '', switchTo: '@root' }]];
    tokenizer['memberN'] = [wsRule, [IDENT, { token: 'identifier', next: '@pop' }], ['', { token: '', next: '@pop' }]];
  }

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

  if (tbody) tokenizer['symbols'] = symbolRulesInterp;

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
    ...identRules,
    ...memberRules,
    ...symbolRules,
  ];
  tokenizer['exprBody'] = exprBody;

  // The element layer (docs/REGIONS.md): states from the declared region, null without one.
  // Its code (holes, code children) is the single-mode interpolation body: `@interpExprBody`, or
  // the same rules in a state of the layer's own when the grammar has no template.
  const el = view ? elementLayer(view, grammar, {
    identRegex: IDENT, wsRule, commentRules, stringNestedRules, templateNestedRules, typeargs: !!angle && !!tbody,
    codeBody: templateToken?.template ? '@interpExprBody' : [
      ...numberRules.map(stripSwitch), ...otherTokenRules.map(stripSwitch), ...identRulesInterp, ...interpSlashRules, ...memberRulesInterp, ...symbolRulesInterp,
      ...angle ? [['[<>]', comparisonTok] as MonarchRule] : [],
    ],
    braces: tokenizer['bracketCounting'] ? '@bracketCounting' : null,
    skipTokenRule,
    identPattern: identToken?.pattern ?? null,
    blockComments: grammar.tokens.flatMap(t => {
      if (!t.flags.includes('skip')) return [];
      const b = tokenPatternBlockDelimiters(t);
      if (!b) return [];
      const [a, z] = tokenPatternBlockDelimiterSources(t) ?? [escapeRegex(b[0]), escapeRegex(b[1])];
      return [[anchoredSource(a), anchoredSource(z)] as [string, string]];
    }),
  }) : null;
  if (el) Object.assign(tokenizer, el.states);

  const root: MonarchRule[] = [...el?.entryTop ?? [], ...rootTypeRules, { include: '@exprBody' }];
  if (regexToken) root.push(...exprSlashRules);
  if (angle) root.push(['<|>', toExpr(comparisonTok)]);   // expr-pos `<`/`>` = comparison
  tokenizer['root'] = root;

  const value: MonarchRule[] = [...el?.entry === 'always' ? el.entryTop : []];
  if (angle) {
    // `<` after a value opens generics ONLY when the bounded type-arg lookahead
    // succeeds (otherwise it stays a comparison via the `<|>` fallback below).
    value.push([`<${genericGuard}`, { token: 'delimiter.angle', next: '@type_angle' }]);
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
      ...el?.entryNested ?? [],
      ...numberRules.map(stripSwitch),
      ...otherTokenRules.map(stripSwitch),
      ...identRulesInterp,
      ...interpSlashRules,
      ...memberRulesInterp,
      ...symbolRulesInterp,
    ];
    if (angle) interpExprBody.push(['[<>]', comparisonTok]);
    tokenizer['interpExprBody'] = interpExprBody;
  }

  refusalsOf.set(grammar, refusals);
  return {
    ident: anchoredSource(identRegex),
    defaultToken: 'invalid',
    tokenPostfix: `.${(grammar as { name?: string }).name ?? 'lang'}`,
    ignoreCase: false,
    ...uniIdent ? { unicode: true } : {},
    brackets: bracketPairs,
    tokenizer,
  };
}

// ── Element layer (docs/REGIONS.md, "a region is a declared lexer state") ──
// One Monarch state per lexer state of the region, every datum from `regionView` (region-view.ts,
// shared with gen-tm / gen-treesitter):
//   <name>_open   after `tagOpen`: the tag name (its name shape), a fragment's `tagClose`, a
//                 dynamic tag's hole;
//   <name>_tag    the open tag: attributes (their name shape), the assign literal, the tag tokens'
//                 quoted forms, holes, tag type arguments (`type_angle`), the self-close token, and
//                 `tagClose` into the children;
//   <name>_children  text runs (the `text` token's class, `highlight.text` patterns) or, without a
//                 `text` token, code; nested elements, holes, the close-tag token;
//   <name>_close  the close tag's name (or hole) up to `tagClose`;
//   <name>_hole   a hole: code up to `hole.close` at brace depth 0.
// Monarch's state stack is the frame stack: a nested element is PUSHED and pops after its end,
// so nesting needs no counter. An element entered from a base state (`root` / `value`) instead
// SWITCHES into the `…T` variant of its states, whose end switches to `value`: an element is a
// value, as the lexer's `prevIsValue` reads it. Entry: an `operand` region is entered only in the
// operand-position state (`root`, the state where a regex literal may start: exactly the lexer's
// `!prevIsValue()`), an `always` region in both base states; the `typeParameters` vetoes are
// negative lookaheads on the entry (the signature veto only within the line). Inside holes and
// template interpolations Monarch is single-mode (it does not track values there), so an element
// is entered at every `tagOpen` the vetoes and `tagStart` allow (`{a <b}` reads an element).
interface ElementCtx {
  identRegex: string;
  wsRule: MonarchRule;
  commentRules: MonarchRule[];
  stringNestedRules: MonarchRule[];
  templateNestedRules: MonarchRule[];
  /** the grammar has the type-argument state (`type_angle`) */
  typeargs: boolean;
  /** the single-mode code body (`@interpExprBody`), or its rules when the grammar has none */
  codeBody: string | MonarchRule[];
  /** the brace-counting state (`@bracketCounting`), or null when the grammar has none */
  braces: string | null;
  /** the identifier token's pattern (its units decide a word literal's boundary), if any */
  identPattern: TokenPattern | null;
  /** the skip tokens' block delimiters as regex sources ([open, close]) */
  blockComments: [string, string][];
  /** a skip token's rule (the code's comment rules) and the regex of its start */
  skipTokenRule: (t: TokenDecl) => { rule: MonarchRule; start: string } | null;
}
interface ElementLayer {
  states: Record<string, MonarchRule[]>;
  entry: 'always' | 'operand';
  /** the entry rule in a base state (switches into the top-level variant) */
  entryTop: MonarchRule[];
  /** the entry rule inside a pushed frame (pushes the nested variant) */
  entryNested: MonarchRule[];
}

// A Monarch token for an element-layer scope: Monaco's HTML vocabulary for tag and attribute
// names (`tag`, `attribute.name`), the general mapping otherwise.
function elementToken(scope: string): string {
  if (scope.startsWith('entity.name.tag')) return 'tag';
  if (scope.startsWith('entity.other.attribute-name')) return 'attribute.name';
  return scopeToMonarch(scope);
}

function elementLayer(view: RegionView, grammar: CstGrammar, cx: ElementCtx): ElementLayer {
  const r = view.region;
  const n = view.name;
  const S = (k: string, top = false) => `${n}_${k}${top ? 'T' : ''}`;
  const at = (k: string, top = false) => `@${S(k, top)}`;
  const o = escapeRegex(r.tagOpen), c = escapeRegex(r.tagClose);
  const ho = escapeRegex(r.hole.open), hc = escapeRegex(r.hole.close);
  const id = `(?:${anchoredSource(cx.identRegex)})`;
  const D = 'delimiter.tag', B = 'delimiter.bracket';
  const alt = (xs: string[]) => xs.length === 1 ? escapeRegex(xs[0]) : `(?:${xs.map(escapeRegex).join('|')})`;
  const states: Record<string, MonarchRule[]> = {};
  const trivia: MonarchRule[] = [cx.wsRule, ...cx.commentRules];

  // ── entry ──
  const tagStartLA = r.tagStart !== undefined ? `(?=${tokenPatternToRegex(r.tagStart)})` : '';
  const tp = r.typeParameters;
  const headVeto = tp?.head !== undefined ? `(?!${tokenPatternToRegex(tp.head)})` : '';
  const sig = tp?.signature;
  const sigVeto = sig
    ? `(?!\\s*${id}\\s*${c}\\s*${escapeRegex(sig.open)}[^${escapeForCharClass(sig.close)}]*${escapeRegex(sig.close)}\\s*${alt(sig.then)})`
    : '';
  const entryRe = `${o}${tagStartLA}${headVeto}${sigVeto}`;
  const entryTop: MonarchRule[] = [[entryRe, { token: D, switchTo: at('open', true) }]];
  const entryNested: MonarchRule[] = [[entryRe, { token: D, next: at('open') }]];

  // ── code inside a hole / code children: single-mode, with nested spans and elements ──
  const codeBody = typeof cx.codeBody === 'string' ? cx.codeBody : `@${S('code')}`;
  if (typeof cx.codeBody !== 'string') states[S('code')] = [...entryNested, ...cx.codeBody];
  const braces = cx.braces ?? `@${S('braces')}`;
  const codeRules: MonarchRule[] = [...trivia, ...cx.stringNestedRules, ...cx.templateNestedRules, ...entryNested, ['\\{', { token: B, next: braces }]];
  if (!cx.braces) states[S('braces')] = [['\\}', { token: B, next: '@pop' }], ...codeRules, { include: codeBody }];
  states[S('hole')] = [[hc, { token: B, next: '@pop' }], ...codeRules, { include: codeBody }];

  // ── names (region-view.ts NameShape): prefix joiner, member accessors, joiners within ──
  const nameBody = (shape: NameShape | null) => `${id}${shape?.within.length ? `(?:${alt(shape.within)}${id})*` : ''}`;
  const ctxTagScope = view.tagName && (grammar.contextualScopes ?? []).find(s => s.within.includes(view.tagName!.rule))?.scope;
  const tagNameRules = (act: (token: string) => MonarchAction): MonarchRule[] => {
    const shape = view.tagName;
    const out: MonarchRule[] = [];
    if (shape?.prefix) out.push([`(${id})(${escapeRegex(shape.prefix.text)})`, ['tag', 'delimiter']]);
    if (shape?.member.length) {
      out.push([`${id}(?=\\s*${alt(shape.member)})`, 'identifier']);
      out.push([alt(shape.member), 'delimiter']);
    }
    const entries = view.highlight.tagName ?? [];
    for (const e of entries) out.push([`${e.match ? `(?=${tokenPatternToRegex(e.match)})` : ''}${nameBody(shape)}`, act(elementToken(e.scope))]);
    if (!entries.length || entries[entries.length - 1].match) out.push([nameBody(shape), act(elementToken(ctxTagScope ?? 'entity.name.tag'))]);
    return out;
  };

  // ── tag tokens: each quoted form a pushed span (no escapes: the lexer's tag token has none) ──
  const tagTokenRules: MonarchRule[] = [];
  for (const t of view.tagTokens) {
    const tok = elementToken(t.scope ?? classifyTokenScope(t));
    for (const q of tokenPatternStringDelimiters(t)) {
      const st = S(`str_${delimStateSuffix(q)}`);
      states[st] = [[`[^${escapeForCharClass(q)}]+`, tok], [escapeRegex(q), { token: tok, next: '@pop' }]];
      tagTokenRules.push([escapeRegex(q), { token: tok, next: `@${st}` }]);
    }
  }

  // ── the children: a text run (the `text` token's class, minus the `highlight.text` patterns'
  // starts) or code ──
  // ── directives (derived: grammar-analysis.ts directivesOf; docs/REGIONS.md "Directives"), in
  // text children only. An opener is tried where the lexer's opener test runs: in the children
  // and a directive body, at a run's start and inside a run (the run stops before it). The test
  // is a lookahead: the literal, a word boundary when it ends with an identifier unit, then one
  // of its required literal sequences, each literal after trivia (whitespace and one-line block
  // comments), a word literal again not running on; the lookahead sees one line. Then states,
  // pushed from the children and popped after the last body, as the lexer's sub-state 3:
  //   <name>_dlead   the required literals; a head's `(` (rematched in the head) or the body's
  //                  `hole.open`;
  //   <name>_dhead   the head: code, a `(` pushes `<name>_dparen` (code to its `)`, nested), and
  //                  `hole.open` at the head's own depth opens the body;
  //   <name>_dbody   children (text, text tokens, holes, elements, directives), a close tag a
  //                  pushed close tag; `hole.close` ends it;
  //   <name>_dcont   after a body: a continuation (its literal and a required sequence, blanks
  //                  before it, over lines) goes back to `<name>_dlead`; anything else pops.
  // A code block (`@{`) pushes a hole. A directive keyword's token is its literal's declared
  // scope, else `keyword.control`.
  const dirs = r.text !== undefined ? directivesOf(grammar, r) : null;
  const dirMarks: string[] = [];
  const dirRules: MonarchRule[] = [];
  let dirCont: MonarchRule[] = [];
  let dirLead: MonarchRule[] = [];
  if (dirs && (dirs.openers.length || dirs.blocks.length)) {
    if (!cx.identPattern) throw new Error('element region: directives need the identifier token (its units decide a word literal\'s boundary)');
    const idc = csetClass(patternInfo(cx.identPattern).chars);
    const isWord = (l: string) => new RegExp(`^${idc}$`, 'u').test(l[l.length - 1]);
    const lit = (l: string) => `${escapeRegex(l)}${isWord(l) ? `(?!${idc})` : ''}`;
    const gap = `(?:\\s|${cx.blockComments.map(([a, b]) => `${a}(?:(?!${b}).)*${b}`).join('|') || '(?!)'})*`;
    const seqs = (nexts: string[][]) => `(?:${nexts.map(n => n.map(l => `${gap}${lit(l)}`).join('')).join('|')})`;
    const kwTok = (l: string) => scopeToMonarch(grammar.scopeOverrides.get(l)?.[0] ?? 'keyword.control');
    for (const d of dirs.openers) {
      const test = `${lit(d.lit)}(?=${seqs(d.nexts)})`;
      dirMarks.push(test);
      dirRules.push([test, { token: kwTok(d.lit), next: at('dlead') }]);
    }
    for (const b of dirs.blocks) {
      dirMarks.push(escapeRegex(b));
      dirRules.push([escapeRegex(b), { token: kwTok(b), next: at('hole') }]);
    }
    // the required literals (every one but the last of a sequence), then the head or the body
    const req = new Set<string>(), heads = new Set<string>();
    for (const d of [...dirs.openers, ...dirs.continuations]) for (const n of d.nexts) {
      n.slice(0, -1).forEach(l => req.add(l));
      const last = n[n.length - 1];
      if (last !== r.hole.open) heads.add(last);
    }
    for (const h of heads) if (h !== '(') throw new Error(`element region: a directive head opened by \`${h}\`: the Monarch element layer reads a parenthesised head`);
    dirLead = [
      ...trivia,
      ...[...req].map(l => [lit(l), isWord(l) ? kwTok(l) : 'delimiter'] as MonarchRule),
      ...heads.size ? [['\\(', { token: '@rematch', switchTo: at('dhead') }] as MonarchRule] : [],
      [ho, { token: B, switchTo: at('dbody') }],
    ];
    const contTests = dirs.continuations.map(d => ({ d, test: `${lit(d.lit)}(?=${seqs(d.nexts)})` }));
    dirCont = [
      ...contTests.map(({ d, test }) => [test, { token: kwTok(d.lit), switchTo: at('dlead') }] as MonarchRule),
      ...contTests.length ? [[`\\s+(?=${contTests.map(c => c.test).join('|')})|\\s+$`, ''] as MonarchRule] : [],
      ['', { token: '', next: '@pop' }],
    ];
  }

  const textRules: MonarchRule[] = [];
  if (r.text !== undefined) {
    const textTok = grammar.tokens.find(t => t.name === r.text);
    const p = textTok?.pattern;
    if (!p || typeof p === 'string' || p.type !== 'repeat' || typeof p.body === 'string' || p.body.type !== 'charClass')
      throw new Error(`element region: the text token \`${r.text}\` must be a run of one character class for the Monarch element layer`);
    const marks: string[] = [...dirMarks];
    for (const h of view.highlight.text ?? []) {
      const m = h.match as TokenPattern;
      const parts = typeof m !== 'string' && m.type === 'seq' ? m.items : [];
      const first = parts[0], last = parts[parts.length - 1];
      if (h.delimiters && parts.length >= 3 && typeof first === 'string' && typeof last === 'string') {
        const mid = parts.slice(1, -1);
        textRules.push([`(${escapeRegex(first)})(${tokenPatternToRegex(mid.length === 1 ? mid[0] : { type: 'seq', items: mid })})(${escapeRegex(last)})`,
          [scopeToMonarch(h.delimiters), scopeToMonarch(h.scope), scopeToMonarch(h.delimiters)]]);
      } else textRules.push([tokenPatternToRegex(m), scopeToMonarch(h.scope)]);
      marks.push(tokenPatternToRegex(m));
    }
    // text tokens (`textTokens`), tried before the run: at a run's start always; inside the run
    // the run stops before one, or, with an `after` class, only right after a unit of that class:
    // a lookbehind WITHIN the run's own match (Monarch sees nothing before a rule's match, and a
    // run's first unit has already been tried by the token rules)
    const stops: string[] = [];
    for (const tt of r.textTokens ?? []) {
      const t = grammar.tokens.find(x => x.name === tt.token);
      if (!t) throw new Error(`element region: the text token \`${tt.token}\` is not a token`);
      const re = tokenPatternToRegex(t.pattern);
      const { rule, start } = cx.skipTokenRule(t) ?? { rule: [re, scopeToMonarch(classifyTokenScope(t))] as MonarchRule, start: re };
      textRules.push(rule);
      if (tt.after === undefined) marks.push(start);
      else {
        // a `highlight.text` match ends a Monarch rule inside the lexer's run: the unit before a
        // text token right after it would not be seen
        if (view.highlight.text?.length) throw new Error(`element region: a text token with an \`after\` class (\`${tt.token}\`) and \`highlight.text\` patterns: the Monarch element layer cannot see the unit before a text token that follows a highlight.text match`);
        stops.push(`(?<=${tokenPatternToRegex(tt.after)})${start}`);
      }
    }
    const cls = tokenPatternToRegex(p.body);
    const not = [...marks, ...stops];
    textRules.push([not.length ? `(?:(?!${not.join('|')})${cls})+` : `${cls}+`, '']);
    // with `tagStart`, a `tagOpen` the class does not allow after it is text
    if (tagStartLA) textRules.push([o, '']);
  }

  // ── raw text (`rawText`): an open tag whose name a declaration lists has its own tag state
  // (`<name>_rawtag_<tag>`), whose `tagClose` enters the body: the declared embed's language
  // (`nextEmbedded`; Monaco ends it at the first match of the body state's `@pop` rule, the
  // close tag `tagOpen closeMarker name`, as the lexer ends the raw token), or, without an embed,
  // the raw token's own scope. `unlessBodyStarts` decides first, in a state of its own
  // (`<name>_rawstart_<tag>`): the pattern at the body's start makes the body children. A
  // pattern that begins with a repetition of a class holding a line break (`star(blank)`) is
  // read over lines: a rest of the line wholly in that class leaves the decision to the next
  // line. The tag name is told by a `cases` dispatch on the name rules' match (ASCII case-folded
  // under `ignoreCase`). A dynamic tag and a fragment are never raw, as for the lexer.
  const raws = (r.rawText ?? []).flatMap(decl => decl.tags.map(tag => {
    const emb = decl.embed?.[tag];
    const scope = typeof emb === 'string' ? emb : emb?.default;
    const tok = grammar.tokens.find(t => t.name === decl.token);
    return {
      decl, tag, key: tag.replace(/\W/g, '_'),
      nameKey: decl.ignoreCase ? caseFoldLiteralSource(tag) : /^\w+$/.test(tag) ? tag : escapeRegex(tag),
      closeRe: `${escapeRegex(r.tagOpen + r.closeMarker)}${decl.ignoreCase ? caseFoldLiteralSource(tag) : escapeRegex(tag)}`,
      language: scope !== undefined ? monacoLanguageOfScope(scope) : null,
      token: tok ? scopeToMonarch(tok.scope ?? classifyTokenScope(tok)) : '',
    };
  }));
  const rawStart = (p: TokenPattern): MonarchRule[] => {
    const lead = typeof p !== 'string' && p.type === 'seq' ? p.items[0] : null;
    if (!lead || typeof lead === 'string' || lead.type !== 'repeat' || lead.min !== 0) return [];
    const cls = tokenPatternToRegex(lead.body);
    return new RegExp(`^(?:${cls})$`).test('\n') ? [[`(?:${cls})+$`, '']] : [];
  };

  // the children's items after the close tag: nested elements, holes, directives, text or code
  const childItems: MonarchRule[] = [
    [`${o}${tagStartLA}`, { token: D, next: at('open') }],
    [ho, { token: B, next: at('hole') }],
    ...dirRules,
    ...r.text !== undefined ? textRules : [...codeRules, { include: codeBody }],
  ];
  if (dirLead.length) {
    states[S('dlead')] = dirLead;
    const paren: MonarchRule = ['\\(', { token: 'delimiter.parenthesis', next: at('dparen') }];
    states[S('dhead')] = [[ho, { token: B, switchTo: at('dbody') }], paren, ...codeRules, { include: codeBody }];
    states[S('dparen')] = [['\\)', { token: 'delimiter.parenthesis', next: '@pop' }], paren, ...codeRules, { include: codeBody }];
    // a close tag in a body is pushed (it pops at its `tagClose`): the parser rejects a stray one
    states[S('dbody')] = [[hc, { token: B, switchTo: at('dcont') }], [escapeRegex(view.closeTagText), { token: D, next: at('close') }], ...childItems];
    states[S('dcont')] = dirCont;
  }

  for (const top of [false, true]) {
    const end: MonarchAction = top ? { token: D, switchTo: '@value' } : { token: D, next: '@pop' };
    const toTag = (token: string): MonarchAction => raws.length
      ? { cases: Object.fromEntries([...raws.map(w => [w.nameKey, { token, switchTo: at(`rawtag_${w.key}`, top) }]), ['@default', { token, switchTo: at('tag', top) }]]) }
      : { token, switchTo: at('tag', top) };
    states[S('open', top)] = [
      ...trivia,
      ...view.fragment ? [[c, { token: D, switchTo: at('children', top) }] as MonarchRule] : [],
      ...view.dynamicTag ? [[ho, { token: B, switchTo: at('dyn', top) }] as MonarchRule] : [],
      ...tagNameRules(toTag),
      ['', { token: '', switchTo: at('tag', top) }],
    ];
    if (view.dynamicTag) states[S('dyn', top)] = [[hc, { token: B, switchTo: at('tag', top) }], ...codeRules, { include: codeBody }];
    const attr = view.attr;
    const assign = view.attrAssign;
    const tagRules = (close: MonarchAction): MonarchRule[] => [
      ...trivia,
      ...assign !== null ? [
        [`${escapeRegex(assign)}(?=\\s*${o})`, { token: 'delimiter', next: at('eqel') }] as MonarchRule,
        [escapeRegex(assign), 'delimiter'] as MonarchRule,
      ] : [],
      ...cx.typeargs && view.typeArgRule ? [[o, { token: 'delimiter.angle', next: '@type_angle' }] as MonarchRule] : [],
      [escapeRegex(view.selfCloseText), end],
      [c, close],
      ...attr?.prefix ? [[`(${id})(${escapeRegex(attr.prefix.text)})`, ['attribute.name', 'delimiter']] as MonarchRule] : [],
      ...attr ? [[`${id}${attr.joiners.filter(j => j !== attr.prefix?.text).length ? `(?:${alt(attr.joiners.filter(j => j !== attr.prefix?.text))}${id})*` : ''}`, 'attribute.name'] as MonarchRule] : [],
      ...tagTokenRules,
      [ho, { token: B, next: at('hole') }],
    ];
    states[S('tag', top)] = tagRules({ token: D, switchTo: at('children', top) });
    for (const w of raws) {
      const body = at(`raw_${w.key}`, top);
      const enter = { token: D, switchTo: body, ...w.language !== null ? { nextEmbedded: w.language } : {} };
      const unless = w.decl.unlessBodyStarts;
      if (unless !== undefined) {
        states[S(`rawtag_${w.key}`, top)] = tagRules({ token: D, switchTo: at(`rawstart_${w.key}`, top) });
        states[S(`rawstart_${w.key}`, top)] = [
          [`(?=${tokenPatternToRegex(unless)})`, { token: '', switchTo: at('children', top) }],
          ...rawStart(unless),
          ['', { ...enter, token: '' }],
        ];
      } else states[S(`rawtag_${w.key}`, top)] = tagRules(enter);
      // the body ends before the close tag, which the children lex
      states[S(`raw_${w.key}`, top)] = w.language !== null
        ? [[w.closeRe, { token: '@rematch', switchTo: at('children', top), nextEmbedded: '@pop' }]]
        : [[`(?=${w.closeRe})`, { token: '', switchTo: at('children', top) }], [`(?:(?!${w.closeRe}).)+`, w.token]];
    }
    states[S('children', top)] = [
      [escapeRegex(view.closeTagText), { token: D, switchTo: at('close', top) }],
      ...childItems,
    ];
    states[S('close', top)] = [
      ...trivia,
      ...view.dynamicTag ? [[ho, { token: B, next: at('hole') }] as MonarchRule] : [],
      ...tagNameRules((token) => token),
      [c, end],
    ];
  }
  // `=` before a nested element: pushed, then switched into the nested element's open tag
  states[S('eqel')] = [cx.wsRule, [o, { token: D, switchTo: at('open') }]];
  return { states, entry: view.entry, entryTop, entryNested };
}

// A character class of a set of code-unit ranges (lex-match-plan.ts CSet), for a JS regex with
// the `u` flag off: ranges above U+FFFF are cut at it (a word boundary reads one code unit).
function csetClass(set: CSet): string {
  const u = (c: number) => `\\u${c.toString(16).padStart(4, '0')}`;
  const items = set.filter(([a]) => a >= 0 && a <= 0xffff).map(([a, b]) => a === b ? u(a) : `${u(a)}-${u(Math.min(b, 0xffff))}`);
  return items.length ? `[${items.join('')}]` : '(?!)';
}

// The Monaco language an embed's TextMate scope names: `source.css` → `css`, `source.js` → `js`
// (the root scope's second segment is the language's conventional name; Monaco resolves
// `nextEmbedded` by language name or alias, then mime type, then id, so `js` is `javascript`).
function monacoLanguageOfScope(scope: string): string {
  const m = /^(?:source|text)\.([\w-]+)/.exec(scope);
  if (!m) throw new Error(`element region: the raw-text embed scope \`${scope}\` names no language (\`source.<language>\` or \`text.<language>\`)`);
  return m[1];
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
