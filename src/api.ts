import type { LedPrec, CstGrammar, TokenDecl, PrecLevel, PrecOperator, RuleDecl, RuleExpr, MarkupConfig, IndentConfig, NewlineConfig, StringInterpolation, TokenPattern } from './types.ts';
import {
  altPattern, anyChar, followedBy, never, noneOf, notFollowedBy,
  notPrecededBy, oneOf, optPattern, plus, precededBy, range, repeat,
  seq, star, start, end,
} from './token-pattern.ts';

export {
  altPattern, anyChar, followedBy, never, noneOf, notFollowedBy, notPrecededBy, oneOf,
  optPattern, plus, precededBy, range, repeat, seq, star, start, end,
};

// ── Token ──

interface TokenOptions {
  skip?: boolean;
  scope?: string;
  escape?: TokenPattern;
  // Highlight-only interpolation regions for ordinary string tokens (e.g. env-spec `${…}` / `$(…)`).
  // The parser/lexer stay token-based; generators re-express these as nested regions.
  interpolation?: StringInterpolation | StringInterpolation[];
  // Highlight-only: this comment token matches only the INTRODUCER (a bare `#`) while the
  // comment runs to end-of-line with parser-tokenized content (a structured-comment dialect).
  // Generators emit a to-EOL region in the token's comment scope so prose dims; `richStarters`
  // lists tokens that keep full token highlighting when one opens the comment body
  // (e.g. env-spec `# @decorator(...)`). See TokenDecl.lineComment.
  lineComment?: {
    richStarters?: TokenRef[];
    continuationBrackets?: [string, string][];
    markup?: { pattern: TokenPattern; scope: string }[];
  };
  // A regex matching exactly one well-formed escape sequence. Engine-scanned tokens
  // (templates) validate each `\`-escape against it and reject any that don't match —
  // unlike `escape` (highlight-only), this drives tokenization. Skipped in tag
  // position, where invalid escapes are legal (cooked = undefined). Optional.
  escapeValid?: TokenPattern;
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
  blockPattern?: TokenPattern;
  // Block-context ONLY (indentation grammars): match this token only outside flow — see TokenDecl.blockOnly.
  blockOnly?: boolean;
}

export class TokenRef {
  readonly __kind = 'token' as const;
  readonly pattern: TokenPattern;
  readonly opts: TokenOptions;
  constructor(pattern: TokenPattern, opts: TokenOptions) {
    this.pattern = pattern;
    this.opts = opts;
  }
}

export function token(pattern: TokenPattern, opts?: TokenOptions): TokenRef {
  return new TokenRef(pattern, opts ?? {});
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
interface NotLeftLeafMarker { readonly __kind: 'notLeftLeaf'; readonly words: string[] }
interface PrefixSlot {
  readonly __kind: 'prefix';
  (...ops: string[]): PrefixOps;
}
interface PostfixSlot {
  readonly __kind: 'postfix';
  (...ops: string[]): PostfixOps;
}
interface PrefixOps { readonly __kind: 'prefix-ops'; ops: string[]; requireTarget?: boolean }
interface PostfixOps { readonly __kind: 'postfix-ops'; ops: string[]; requireTarget?: boolean }
interface NoUnaryLhsOps { readonly __kind: 'no-unary-lhs-ops'; ops: string[] }
interface LhsTargetOps { readonly __kind: 'lhs-target-ops'; ops: string[] }

type Marker = OpMarker | PrefixSlot | PostfixSlot | SameLineMarker | NoCommentMarker | NoMultilineFlowMarker | NotLeftLeafMarker;

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

// Zero-width LEFT-operand head-leaf guard for a Pratt LED arm. Place it at the HEAD of a LED
// alternative, before the self `$` (e.g. `[notLeftLeaf('void','null'), $, '.', Ident]`). The arm
// matches only when the LEFT node's OUTERMOST (head) leaf token TEXT is NOT one of `words`; when it
// IS, the arm is treated as not-matched (skipped) and the connector rebinds to nothing. Models TS's
// rule that a qualified type name's root is an IdentifierReference, so the keyword/literal types
// `void`/`null`/`true`/`false`/`this` are not `.`-qualifiable (`void.x` has no parse tree) while an
// identifier-rooted type (`A.B`, `undefined.x`, `number.x`) is. Mirrors the AssignmentTargetType gate
// (`lhsTarget`/`prefixTarget`), reading the SAME head leaf but predicated on TEXT membership.
export function notLeftLeaf(...words: string[]): NotLeftLeafMarker {
  return { __kind: 'notLeftLeaf', words };
}

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

// Mark infix operators whose LEFT operand must be a valid ASSIGNMENT TARGET
// (a LeftHandSideExpression — identifier / member / element / call / paren / `this`),
// NOT a prefix-unary, prefix-update, or postfix-update expression. E.g. JS `=` and the
// compound assignments: `-x = 1`, `++x = 1`, `x++ = 1` are syntax errors, but `x = 1`,
// `x.y = 1`, `(x++) = 1` (a parenthesized cover) are fine. This is ECMAScript's
// AssignmentTargetType, enforced at PARSE time. A general, declarable property; the
// engine enforces it generically via the operand node's outermost form (head/tail leaf).
export const lhsTarget = (...ops: string[]): LhsTargetOps => ({ __kind: 'lhs-target-ops' as const, ops });

// Postfix operators whose OPERAND must be a valid assignment target (LHS), same shape
// rule as `lhsTarget` above — e.g. JS postfix `++`/`--`: `x++` is fine but `-x++` parses
// as `-(x++)`, and `++x++`, `x++ ++` are syntax errors (the operand `++x` / `x++` is not
// a LeftHandSideExpression). Distinct from `postfix(...)` (no operand-shape constraint).
export const postfixTarget = (...ops: string[]): PostfixOps => ({ __kind: 'postfix-ops' as const, ops, requireTarget: true });

// Prefix operators whose OPERAND must be a valid assignment target (LHS) — e.g. JS prefix
// `++`/`--` (the update prefixes): `++x`, `++x.y` are fine but `++-x`, `++ ++x`, `++x--`
// are syntax errors. Distinct from `prefix(...)` (the pure-unary `-`/`!`/`typeof`/… take
// ANY operand, including an update: `-x++`, `void ++x` are fine).
export const prefixTarget = (...ops: string[]): PrefixOps => ({ __kind: 'prefix-ops' as const, ops, requireTarget: true });

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
class CtxNode {
  // Mark the wrapped items as [Await]/[Yield] context (the ECMAScript grammar
  // parameter): inside an async function/arrow/method body await is the AwaitExpression
  // operator (no bare-identifier reading), and inside a generator body yield is the
  // YieldExpression operator. The await-yield-fork build transform reads this marker to
  // name-fork the body-reachable rule closure; every other consumer treats it as a
  // transparent group. Wrap ONLY the async/generator arm's body+params; a nested
  // non-async function/arrow/class body is simply left UNwrapped (context resets).
  readonly __kind = 'ctx' as const;
  readonly mode: 'await' | 'yield' | 'asyncgen' | 'reset';
  readonly items: Element[];
  constructor(mode: 'await' | 'yield' | 'asyncgen' | 'reset', items: Element[]) { this.mode = mode; this.items = items; }
}
class NotNode {
  readonly __kind = 'not' as const;
  // Zero-width negative lookahead over an element, or an array (a seq, like
  // everywhere else in the rule DSL). Matches nothing; succeeds only when
  // `item` can't match. `reservable` flags the bare-identifier reserved-word guard
  // (notReservedExpr) so the await-yield-fork transform extends it per context family.
  readonly item: Element | Element[];
  readonly reservable: boolean;
  constructor(item: Element | Element[], reservable = false) { this.item = item; this.reservable = reservable; }
}

class RelaxNode {
  // A tree-sitter-only divergence: the PARSER (and every other generator) parses
  // `strict`; gen-treesitter renders `relaxed`. Use when a parser-correct constraint is
  // tree-sitter-GLR-hostile and the highlighter can safely over-accept the rare malformed
  // form (see RuleExpr.group.tsRelaxed). Like ctx/exclude it lowers to a transparent group.
  readonly __kind = 'relax' as const;
  readonly strict: Element[];
  readonly relaxed: Element[];
  // When set, gen-treesitter emits `relaxed` ONCE as a shared rule of this name and renders
  // every reference as `$.<ruleName>`, instead of inlining `relaxed` at each site. Inlining a
  // relaxed form duplicates its states at every use; a shared rule keeps them in ONE place
  // (the difference is large — see issue #46). Visibility follows tree-sitter's `_`-prefix
  // convention (a leading `_` hides the node).
  readonly ruleName?: string;
  constructor(strict: Element[], relaxed: Element[], ruleName?: string) { this.strict = strict; this.relaxed = relaxed; this.ruleName = ruleName; }
}

class CapExprNode {
  // Wrap a NUD alternative that is a complete assignment-level expression — an
  // ArrowFunction, the LOWEST-precedence ECMAScript AssignmentExpression. `below` names
  // the operator whose binding power is the cap: the alternative may be parsed only when
  // the enclosing Pratt minBp is looser than `below`, and once parsed it admits NO led
  // (`() => {} || a` is not `(() => {}) || a` — an arrow can be neither operand of
  // `||`/`??`/`?:`/binary, nor an assignment target). Reuses the transparent `group` node:
  // matched exactly like the bare alternative (no extra CST node), the cap is read only by
  // the expression engine. A general property — any grammar with a lowest-precedence
  // primary expression form can declare it; the engine enforces it generically.
  readonly __kind = 'cap-expr' as const;
  readonly below: string;
  readonly items: Element[];
  constructor(below: string, items: Element[]) { this.below = below; this.items = items; }
}

type Combinator = SepNode | OptNode | ManyNode | Many1Node | AltNode | ExcludeNode | NotNode | CtxNode | RelaxNode | CapExprNode;

export function sep(item: Element, delimiter: string): SepNode {
  return new SepNode(item, delimiter);
}

export function opt(...items: Element[]): OptNode {
  return new OptNode(items);
}

export function many(...items: Element[]): ManyNode {
  return new ManyNode(items);
}

export function many1(...items: Element[]): Many1Node {
  return new Many1Node(items);
}

export function alt(...items: Alternative[]): AltNode {
  return new AltNode(items);
}

// Parse `items` with the given LED connector(s) disabled at the top level (a
// no-`in`-style context). `exclude('in', Expr)` parses an Expr that stops before
// a top-level `in`, leaving it for the enclosing rule.
export function exclude(connectors: string | string[], ...items: Element[]): ExcludeNode {
  return new ExcludeNode(typeof connectors === 'string' ? [connectors] : connectors, items);
}

// Parse `strict` (in the parser and all generators) but render `relaxed` for tree-sitter.
// For a parser-correct constraint that explodes / inflates the tree-sitter GLR table while
// the highlighter doesn't need it. Each side is a single element or an array (a seq).
export function tsRelax(strict: Element | Element[], relaxed: Element | Element[], ruleName?: string): RelaxNode {
  return new RelaxNode(Array.isArray(strict) ? strict : [strict], Array.isArray(relaxed) ? relaxed : [relaxed], ruleName);
}

// Mark a NUD alternative as a complete assignment-level expression (an ArrowFunction —
// the lowest-precedence ECMAScript AssignmentExpression). `below` names the operator whose
// binding power caps it: the alternative parses only when the enclosing Pratt minBp is
// looser than `below`, and once parsed admits no led. See CapExprNode.
export function capExpr(below: string, ...items: Element[]): CapExprNode {
  return new CapExprNode(below, items);
}

// Mark items as await / yield / async-generator context (see CtxNode). Wrap an
// async arm's body and params in awaitCtx(...), a generator arm's in yieldCtx(...),
// an async-generator's in asyncGenCtx(...).
export function awaitCtx(...items: Element[]): CtxNode { return new CtxNode('await', items); }
export function yieldCtx(...items: Element[]): CtxNode { return new CtxNode('yield', items); }
export function asyncGenCtx(...items: Element[]): CtxNode { return new CtxNode('asyncgen', items); }
// Reset to NO await/yield context (a nested non-async/non-generator function/arrow/
// method body, a class body, a computed property key, a field initializer). Wrapping a
// body in resetCtx() inside an already-forked family routes its refs back to the plain
// family — the boundary the fork transform stops at.
export function resetCtx(...items: Element[]): CtxNode { return new CtxNode('reset', items); }

// Zero-width negative lookahead: `not(x)` matches nothing and succeeds only when
// `x` would NOT match here.
export function not(item: Element | Element[]): NotNode {
  return new NotNode(item);
}
// The bare-identifier reserved-word guard (notReservedExpr / notReserved): a `not`
// the await-yield-fork transform extends with await/yield inside those contexts.
export function reservableNot(item: Element | Element[]): NotNode {
  return new NotNode(item, true);
}

// ── Precedence ──

interface PrecLevelDef {
  readonly __kind: 'prec-level';
  assoc: 'left' | 'right' | 'none';
  operators: PrecOperator[];
}

type OpSpec = string | PrefixOps | PostfixOps | NoUnaryLhsOps | LhsTargetOps;

function buildPrecOps(ops: OpSpec[]): PrecOperator[] {
  const result: PrecOperator[] = [];
  for (const o of ops) {
    if (typeof o === 'string') {
      result.push({ value: o, position: 'infix' });
    } else if (o.__kind === 'prefix-ops') {
      for (const v of o.ops) result.push({ value: v, position: 'prefix', requireTarget: o.requireTarget });
    } else if (o.__kind === 'postfix-ops') {
      for (const v of o.ops) result.push({ value: v, position: 'postfix', requireTarget: o.requireTarget });
    } else if (o.__kind === 'lhs-target-ops') {
      for (const v of o.ops) result.push({ value: v, position: 'infix', requireTarget: true });
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
  if (el instanceof CtxNode) {
    // Transparent group carrying the ctxMode marker; only the await-yield-fork
    // transform reads ctxMode, everyone else recurses into body as a plain group.
    const body = el.items.length === 1
      ? toRuleExpr(el.items[0], names)
      : { type: 'seq' as const, items: el.items.map(i => toRuleExpr(i, names)) };
    return { type: 'group', body, ctxMode: el.mode };
  }
  if (el instanceof RelaxNode) {
    // Transparent group: every consumer reads `body` (strict); only gen-treesitter
    // renders `tsRelaxed`.
    const build = (items: Element[]): RuleExpr => items.length === 1
      ? toRuleExpr(items[0], names)
      : { type: 'seq', items: items.map(i => toRuleExpr(i, names)) };
    return { type: 'group', body: build(el.strict), tsRelaxed: build(el.relaxed), tsRuleName: el.ruleName };
  }
  if (el instanceof CapExprNode) {
    // Reuse the transparent `group` node (every walker recurses into `body`); `capBelow`
    // is read only by the expression engine's Pratt core.
    const body = el.items.length === 1
      ? toRuleExpr(el.items[0], names)
      : { type: 'seq' as const, items: el.items.map(i => toRuleExpr(i, names)) };
    return { type: 'group', body, capBelow: el.below };
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
    // an array is a seq here like everywhere else in the rule DSL
    const body = Array.isArray(el.item)
      ? { type: 'seq' as const, items: el.item.map(i => toRuleExpr(i, names)) }
      : toRuleExpr(el.item, names);
    return el.reservable ? { type: 'not', body, reservable: true } : { type: 'not', body };
  }
  const marker = el as Marker;
  if (marker.__kind === 'op') return { type: 'op' };
  if (marker.__kind === 'prefix') return { type: 'prefix' };
  if (marker.__kind === 'postfix') return { type: 'postfix' };
  if (marker.__kind === 'sameLine') return { type: 'sameLine' };
  if (marker.__kind === 'noCommentBefore') return { type: 'noCommentBefore' };
  if (marker.__kind === 'noMultilineFlowBefore') return { type: 'noMultilineFlowBefore' };
  if (marker.__kind === 'notLeftLeaf') return { type: 'notLeftLeaf', words: marker.words };
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
  ledPrec?: LedPrec[];
  rules: Record<string, RuleRef>;
  scopes?: Record<string, string[]>;
  // Highlight-only contextual token scopes: token T carries scope S within rule R (T's
  // immediate enclosing rule) — see CstGrammar.contextualScopes for generator fidelity.
  contextualScopes?: { token: TokenRef; within: RuleRef | RuleRef[]; scope: string }[];
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
      // richStarters are TokenRefs; resolve to declared names (unknown refs are a config error)
      lineComment: tok.opts.lineComment
        ? {
          richStarters: (tok.opts.lineComment.richStarters ?? []).map((ref) => {
            const refName = names.get(ref);
            if (!refName) throw new Error(`lineComment.richStarters on token '${name}' references an undeclared token`);
            return refName;
          }),
          continuationBrackets: tok.opts.lineComment.continuationBrackets?.map((pair) => [...pair] as [string, string]),
          markup: tok.opts.lineComment.markup?.map((m) => ({ ...m })),
        }
        : undefined,
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

  const contextualScopes = (config.contextualScopes ?? []).map((entry) => {
    const tokenName = names.get(entry.token);
    if (!tokenName) throw new Error('contextualScopes entry references an undeclared token');
    const withinRefs = Array.isArray(entry.within) ? entry.within : [entry.within];
    const within = withinRefs.map((ref) => {
      const ruleName = names.get(ref);
      if (!ruleName) throw new Error(`contextualScopes entry for token '${tokenName}' references an undeclared rule`);
      return ruleName;
    });
    return { token: tokenName, within, scope: entry.scope };
  });
  return { name: config.name, scopeName: config.scopeName, tokens, precs, ledPrecs: config.ledPrec, rules, scopeOverrides, contextualScopes, markup: config.markup, indent: config.indent, newline: config.newline, expressionRule: config.expression ? names.get(config.expression) : undefined, aliasScopes: config.aliasScopes, canonicalRepoNames: config.canonicalRepoNames, manifest: config.manifest };
}
