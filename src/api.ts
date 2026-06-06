import type { CstGrammar, TokenDecl, PrecLevel, PrecOperator, RuleDecl, RuleExpr, MarkupConfig, IndentConfig, NewlineConfig, StringInterpolation, TokenPattern } from './types.ts';
import {
  altPattern, anyChar, followedBy, isTokenPattern, lit, never, noneOf, notFollowedBy,
  notPrecededBy, oneOf, optPattern, plus, precededBy, range, repeat,
  seq, star, start, end, toTokenPattern,
  type TokenPatternInput,
} from './token-pattern.ts';

export {
  anyChar, followedBy, lit, never, noneOf, notFollowedBy, notPrecededBy, oneOf,
  plus, precededBy, range, repeat, seq, star, start, end,
};

// ── Token ──

interface TokenOptions {
  skip?: boolean;
  scope?: string;
  escape?: TokenPatternInput;
  // Highlight-only interpolation regions for ordinary string tokens (e.g. env-spec `${…}` / `$(…)`).
  // The parser/lexer stay token-based; generators re-express these as nested regions.
  interpolation?: StringInterpolation | StringInterpolation[];
  // A regex matching exactly one well-formed escape sequence. Engine-scanned tokens
  // (templates) validate each `\`-escape against it and reject any that don't match —
  // unlike `escape` (highlight-only), this drives tokenization. Skipped in tag
  // position, where invalid escapes are legal (cooked = undefined). Optional.
  escapeValid?: TokenPatternInput;
  regex?: boolean;
  embed?: string;
  // ── Lexer hints (keep gen-parser language-agnostic; all optional) ──
  identifier?: boolean;
  // A token that is a fixed literal prefix followed by an IdentifierName (e.g. JS private
  // names, `#x`). Declares the prefix so the lexer's Unicode ID_Start/ID_Continue fallback
  // can match a non-ASCII `prefix`-name (`#℘`, `#<ZWNJ>`) the ASCII token pattern misses —
  // the same fallback the bare `identifier` token gets, just behind the prefix.
  identifierPrefix?: string;
  template?: { open: string; interpOpen: string; interpClose: string };
  regexContext?: {
    divisionAfterTypes?: string[];
    divisionAfterTexts?: string[];
    regexAfterTexts?: string[];
    regexAfterParenKeywords?: string[];
    memberAccessTexts?: string[];
    postfixAfterValueTexts?: string[];
  };
  string?: boolean;
  // Block-context (flowDepth===0) pattern variant for indentation grammars — see TokenDecl.blockPattern.
  blockPattern?: TokenPatternInput;
  // Block-context ONLY (indentation grammars): match this token only outside flow — see TokenDecl.blockOnly.
  blockOnly?: boolean;
}

type NormalizedTokenOptions = Omit<TokenOptions, 'escape' | 'escapeValid' | 'blockPattern'> & {
  escape?: TokenPattern;
  escapeValid?: TokenPattern;
  blockPattern?: TokenPattern;
};

export class TokenRef {
  readonly __kind = 'token' as const;
  readonly pattern: TokenPattern;
  readonly opts: NormalizedTokenOptions;
  constructor(pattern: TokenPattern, opts: NormalizedTokenOptions) {
    this.pattern = pattern;
    this.opts = opts;
  }
}

export function token(pattern: TokenPatternInput, opts?: TokenOptions): TokenRef {
  return new TokenRef(toTokenPattern(pattern), normalizeTokenOptions(opts ?? {}));
}

function normalizeTokenOptions(opts: TokenOptions): NormalizedTokenOptions {
  return {
    ...opts,
    escape: opts.escape ? toTokenPattern(opts.escape) : undefined,
    escapeValid: opts.escapeValid ? toTokenPattern(opts.escapeValid) : undefined,
    blockPattern: opts.blockPattern ? toTokenPattern(opts.blockPattern) : undefined,
  };
}

// ── Rule ──

interface RuleOptions {
  type?: boolean;
}

type Element = string | TokenRef | RuleRef | Marker | Combinator;
type Sequence = Element[];
type Alternative = Element | Sequence;
type RuleBody = (self: RuleRef) => Alternative[];

export class RuleRef {
  readonly __kind = 'rule' as const;
  readonly def: RuleBody;
  readonly opts: RuleOptions;
  constructor(def: RuleBody, opts: RuleOptions) {
    this.def = def;
    this.opts = opts;
  }
}

export function rule(def: RuleBody, opts?: RuleOptions): RuleRef {
  return new RuleRef(def, opts ?? {});
}

// ── Special slots for rules ──

interface OpMarker { readonly __kind: 'op' }
interface SameLineMarker { readonly __kind: 'sameLine' }
interface NoCommentMarker { readonly __kind: 'noCommentBefore' }
interface NoMultilineFlowMarker { readonly __kind: 'noMultilineFlowBefore' }
interface PrefixSlot {
  readonly __kind: 'prefix';
  (...ops: string[]): PrefixOps;
}
interface PostfixSlot {
  readonly __kind: 'postfix';
  (...ops: string[]): PostfixOps;
}
interface PrefixOps { readonly __kind: 'prefix-ops'; ops: string[] }
interface PostfixOps { readonly __kind: 'postfix-ops'; ops: string[] }
interface NoUnaryLhsOps { readonly __kind: 'no-unary-lhs-ops'; ops: string[] }

type Marker = OpMarker | PrefixSlot | PostfixSlot | SameLineMarker | NoCommentMarker | NoMultilineFlowMarker;

export const op: OpMarker = { __kind: 'op' };

// Zero-width "no LineTerminator here" assertion (see RuleExpr 'sameLine').
export const sameLine: SameLineMarker = { __kind: 'sameLine' };

// Zero-width "no comment was skipped before the next token" assertion (indentation grammars). A
// comment ENDS a plain scalar in YAML, so a multi-line plain fold guards each continuation line
// with this so it cannot reabsorb a line that follows a comment (see RuleExpr 'noCommentBefore').
export const noCommentBefore: NoCommentMarker = { __kind: 'noCommentBefore' };

// Zero-width "the flow collection that just closed was single-line" assertion (indentation
// grammars). A flow collection may be an implicit block mapping KEY only on one line (YAML §7.4.2),
// so the flow-collection-as-block-key rule guards the `:` with this so a multi-line flow key is
// rejected while a single-line one accepts (see RuleExpr 'noMultilineFlowBefore').
export const noMultilineFlowBefore: NoMultilineFlowMarker = { __kind: 'noMultilineFlowBefore' };

export const prefix: PrefixSlot = Object.assign(
  (...ops: string[]): PrefixOps => ({ __kind: 'prefix-ops' as const, ops }),
  { __kind: 'prefix' as const },
) as PrefixSlot;

export const postfix: PostfixSlot = Object.assign(
  (...ops: string[]): PostfixOps => ({ __kind: 'postfix-ops' as const, ops }),
  { __kind: 'postfix' as const },
) as PostfixSlot;

// Mark infix operators whose LEFT operand may not be a bare unary-prefix expression
// (a prefix-op result that is NOT also an update `++`/`--`). E.g. JS `**`: `-x ** y`
// is a syntax error (write `(-x) ** y` or `-(x ** y)`), but `x ** -y`, `(-x) ** y`,
// and `++x ** y` are fine. A general, declarable property — Python, by contrast,
// allows `-x ** y` and would not use this. The engine enforces it generically.
export const noUnaryLhs = (...ops: string[]): NoUnaryLhsOps => ({ __kind: 'no-unary-lhs-ops' as const, ops });

// ── Combinators ──

class SepNode {
  readonly __kind = 'sep' as const;
  readonly item: Element;
  readonly delimiter: string;
  constructor(item: Element, delimiter: string) {
    this.item = item;
    this.delimiter = delimiter;
  }
}
class OptNode {
  readonly __kind = 'opt' as const;
  readonly items: Element[];
  constructor(items: Element[]) { this.items = items; }
}
class ManyNode {
  readonly __kind = 'many' as const;
  readonly items: Element[];
  constructor(items: Element[]) { this.items = items; }
}
class Many1Node {
  readonly __kind = 'many1' as const;
  readonly items: Element[];
  constructor(items: Element[]) { this.items = items; }
}
class AltNode {
  readonly __kind = 'alt' as const;
  // Branches may be a single element OR a sequence (array), so alt() can express
  // a left-factored rule: alt([a, b], [a, c]) etc.
  readonly items: Alternative[];
  constructor(items: Alternative[]) { this.items = items; }
}
class ExcludeNode {
  // Parse the wrapped rule, but with the given infix/LED connectors disabled at
  // the top level (they rebind to the enclosing context). Models grammars with a
  // "no-`in`" production: a for-head's `var x = E` parses E so a following `in`
  // is the for-in keyword, not the `in` operator. The excluded tokens are grammar
  // DATA, so the engine stays language-agnostic.
  readonly __kind = 'exclude' as const;
  readonly connectors: string[];
  readonly items: Element[];
  constructor(connectors: string[], items: Element[]) { this.connectors = connectors; this.items = items; }
}
class NotNode {
  readonly __kind = 'not' as const;
  // Zero-width negative lookahead over a single element (wrap a sequence in a
  // group/alt if needed). Matches nothing; succeeds only when `item` can't match.
  readonly item: Element;
  constructor(item: Element) { this.item = item; }
}

type Combinator = SepNode | OptNode | ManyNode | Many1Node | AltNode | ExcludeNode | NotNode;

export function sep(item: Element, delimiter: string): SepNode {
  return new SepNode(item, delimiter);
}

export function opt(...items: [TokenPattern, ...TokenPatternInput[]]): TokenPattern;
export function opt(...items: Element[]): OptNode;
export function opt(...items: (Element | TokenPatternInput)[]): OptNode | TokenPattern {
  if (items.some(isTokenPattern)) return optPattern(...items as TokenPatternInput[]);
  return new OptNode(items as Element[]);
}

export function many(...items: Element[]): ManyNode {
  return new ManyNode(items);
}

export function many1(...items: Element[]): Many1Node {
  return new Many1Node(items);
}

export function alt(...items: [TokenPattern, ...TokenPatternInput[]]): TokenPattern;
export function alt(...items: Alternative[]): AltNode;
export function alt(...items: (Alternative | TokenPatternInput)[]): AltNode | TokenPattern {
  if (items.some(isTokenPattern)) return altPattern(...items as TokenPatternInput[]);
  return new AltNode(items as Alternative[]);
}

// Parse `items` with the given LED connector(s) disabled at the top level (a
// no-`in`-style context). `exclude('in', Expr)` parses an Expr that stops before
// a top-level `in`, leaving it for the enclosing rule.
export function exclude(connectors: string | string[], ...items: Element[]): ExcludeNode {
  return new ExcludeNode(typeof connectors === 'string' ? [connectors] : connectors, items);
}

// Zero-width negative lookahead: `not(x)` matches nothing and succeeds only when
// `x` would NOT match here.
export function not(item: Element): NotNode {
  return new NotNode(item);
}

// ── Precedence ──

interface PrecLevelDef {
  readonly __kind: 'prec-level';
  assoc: 'left' | 'right' | 'none';
  operators: PrecOperator[];
}

type OpSpec = string | PrefixOps | PostfixOps | NoUnaryLhsOps;

function buildPrecOps(ops: OpSpec[]): PrecOperator[] {
  const result: PrecOperator[] = [];
  for (const o of ops) {
    if (typeof o === 'string') {
      result.push({ value: o, position: 'infix' });
    } else if (o.__kind === 'prefix-ops') {
      for (const v of o.ops) result.push({ value: v, position: 'prefix' });
    } else if (o.__kind === 'postfix-ops') {
      for (const v of o.ops) result.push({ value: v, position: 'postfix' });
    } else {
      for (const v of o.ops) result.push({ value: v, position: 'infix', noUnaryLhs: true });
    }
  }
  return result;
}

export function left(...ops: OpSpec[]): PrecLevelDef {
  return { __kind: 'prec-level', assoc: 'left', operators: buildPrecOps(ops) };
}

export function right(...ops: OpSpec[]): PrecLevelDef {
  return { __kind: 'prec-level', assoc: 'right', operators: buildPrecOps(ops) };
}

export function none(...ops: OpSpec[]): PrecLevelDef {
  return { __kind: 'prec-level', assoc: 'none', operators: buildPrecOps(ops) };
}

// ── AST conversion ──

function toRuleExpr(el: Element, names: Map<object, string>): RuleExpr {
  if (typeof el === 'string') {
    return { type: 'literal', value: el };
  }
  if (el instanceof TokenRef) {
    const name = names.get(el);
    if (!name) throw new Error('Token not registered in defineGrammar');
    return { type: 'ref', name };
  }
  if (el instanceof RuleRef) {
    const name = names.get(el);
    if (!name) throw new Error('Rule not registered in defineGrammar');
    return { type: 'ref', name };
  }
  if (el instanceof SepNode) {
    return { type: 'sep', element: toRuleExpr(el.item, names), delimiter: el.delimiter };
  }
  if (el instanceof OptNode) {
    const body = el.items.length === 1
      ? toRuleExpr(el.items[0], names)
      : { type: 'seq' as const, items: el.items.map(i => toRuleExpr(i, names)) };
    return { type: 'quantifier', body, kind: '?' };
  }
  if (el instanceof ManyNode) {
    const body = el.items.length === 1
      ? toRuleExpr(el.items[0], names)
      : { type: 'seq' as const, items: el.items.map(i => toRuleExpr(i, names)) };
    return { type: 'quantifier', body, kind: '*' };
  }
  if (el instanceof Many1Node) {
    const body = el.items.length === 1
      ? toRuleExpr(el.items[0], names)
      : { type: 'seq' as const, items: el.items.map(i => toRuleExpr(i, names)) };
    return { type: 'quantifier', body, kind: '+' };
  }
  if (el instanceof ExcludeNode) {
    // Reuse the transparent `group` node (every walker recurses into `body`);
    // `suppress` is read only by the parser's expression engine.
    const body = el.items.length === 1
      ? toRuleExpr(el.items[0], names)
      : { type: 'seq' as const, items: el.items.map(i => toRuleExpr(i, names)) };
    return { type: 'group', body, suppress: el.connectors };
  }
  if (el instanceof AltNode) {
    // A branch may be a single element or a sequence (array → seq).
    return {
      type: 'alt',
      items: el.items.map(i => {
        if (Array.isArray(i)) {
          return i.length === 1
            ? toRuleExpr(i[0], names)
            : { type: 'seq' as const, items: i.map(x => toRuleExpr(x, names)) };
        }
        return toRuleExpr(i, names);
      }),
    };
  }
  if (el instanceof NotNode) {
    return { type: 'not', body: toRuleExpr(el.item, names) };
  }
  const marker = el as Marker;
  if (marker.__kind === 'op') return { type: 'op' };
  if (marker.__kind === 'prefix') return { type: 'prefix' };
  if (marker.__kind === 'postfix') return { type: 'postfix' };
  if (marker.__kind === 'sameLine') return { type: 'sameLine' };
  if (marker.__kind === 'noCommentBefore') return { type: 'noCommentBefore' };
  if (marker.__kind === 'noMultilineFlowBefore') return { type: 'noMultilineFlowBefore' };
  throw new Error(`Unknown element: ${JSON.stringify(el)}`);
}

function convertAlternatives(alts: Alternative[], names: Map<object, string>): RuleExpr {
  const items: RuleExpr[] = alts.map(a => {
    if (Array.isArray(a)) {
      if (a.length === 1) return toRuleExpr(a[0], names);
      return { type: 'seq' as const, items: a.map(el => toRuleExpr(el, names)) };
    }
    return toRuleExpr(a, names);
  });
  if (items.length === 1) return items[0];
  return { type: 'alt', items };
}

// ── Grammar assembly ──

interface GrammarConfig {
  name: string;
  scopeName?: string;
  tokens: Record<string, TokenRef>;
  prec?: PrecLevelDef[];
  rules: Record<string, RuleRef>;
  scopes?: Record<string, string[]>;
  entry: RuleRef;
  markup?: MarkupConfig;  // opt-in markup-mode tokenization (HTML/Vue)
  indent?: IndentConfig;  // opt-in indentation-sensitive tokenization (YAML)
  newline?: NewlineConfig;  // opt-in NEWLINE-sensitive tokenization, independent of indent (no indent stack)
  expression?: RuleRef;   // the rule that produces an EXPRESSION; enables a derived `#expression` sub-grammar (expression-only embeds)
  aliasScopes?: { scope: string; file: string }[];  // extra grammars re-exposing this one under another scopeName (e.g. text.html.derivative)
  canonicalRepoNames?: Record<string, string | string[]>;  // official repo KEY NAME → structural key(s) for the SAME construct; gen-tm RENAMES the structural key (or synthesises a union wrapper) to emit the official name natively (the 限制器; see CstGrammar.canonicalRepoNames)
  manifest?: import('./types.ts').ContributesManifest;  // VS Code `contributes` packaging (emits a pasteable snippet)
}

export function defineGrammar(config: GrammarConfig): CstGrammar & { name: string; scopeName?: string } {
  // `indent` is the richer layer built on top of newline-significant line boundaries, so the two
  // modes are mutually exclusive — declaring both is a configuration error, not a merge.
  if (config.indent && config.newline) {
    throw new Error('A grammar may declare `indent` OR `newline`, not both — `indent` already implies newline-significant line boundaries.');
  }
  const names = new Map<object, string>();
  for (const [name, tok] of Object.entries(config.tokens)) {
    names.set(tok, name);
  }
  for (const [name, r] of Object.entries(config.rules)) {
    names.set(r, name);
  }

  const tokens: TokenDecl[] = Object.entries(config.tokens).map(([name, tok]) => {
    const flags: string[] = [];
    if (tok.opts.skip) flags.push('skip');
    if (tok.opts.regex) flags.push('regex');
    return {
      name,
      pattern: tok.pattern,
      blockPattern: tok.opts.blockPattern,
      blockOnly: tok.opts.blockOnly,
      flags,
      scope: tok.opts.scope,
      escapePattern: tok.opts.escape,
      interpolation: tok.opts.interpolation
        ? (Array.isArray(tok.opts.interpolation) ? tok.opts.interpolation : [tok.opts.interpolation]).map((i) => ({ ...i }))
        : undefined,
      escapeValidPattern: tok.opts.escapeValid,
      embed: tok.opts.embed,
      identifier: tok.opts.identifier,
      identifierPrefix: tok.opts.identifierPrefix,
      template: tok.opts.template,
      regexContext: tok.opts.regexContext && {
        divisionAfterTypes: tok.opts.regexContext.divisionAfterTypes ?? [],
        divisionAfterTexts: tok.opts.regexContext.divisionAfterTexts ?? [],
        regexAfterTexts: tok.opts.regexContext.regexAfterTexts ?? [],
        regexAfterParenKeywords: tok.opts.regexContext.regexAfterParenKeywords ?? [],
        memberAccessTexts: tok.opts.regexContext.memberAccessTexts ?? [],
        postfixAfterValueTexts: tok.opts.regexContext.postfixAfterValueTexts ?? [],
      },
      string: tok.opts.string,
    };
  });

  const precs: PrecLevel[] = (config.prec ?? []).map(p => ({
    assoc: p.assoc,
    operators: [...p.operators],
  }));

  const rules: RuleDecl[] = Object.entries(config.rules).map(([name, r]) => {
    const alts = r.def(r);
    return {
      name,
      body: convertAlternatives(alts, names),
      flags: r.opts.type ? ['type'] : [],
    };
  });

  const scopeOverrides = new Map<string, string[]>();
  if (config.scopes) {
    for (const [scope, literals] of Object.entries(config.scopes)) {
      for (const lit of literals) {
        const existing = scopeOverrides.get(lit);
        if (existing) {
          existing.push(scope);
        } else {
          scopeOverrides.set(lit, [scope]);
        }
      }
    }
  }

  return { name: config.name, scopeName: config.scopeName, tokens, precs, rules, scopeOverrides, markup: config.markup, indent: config.indent, newline: config.newline, expressionRule: config.expression ? names.get(config.expression) : undefined, aliasScopes: config.aliasScopes, canonicalRepoNames: config.canonicalRepoNames, manifest: config.manifest };
}
