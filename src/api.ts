import type { CstGrammar, TokenDecl, PrecLevel, PrecOperator, RuleDecl, RuleExpr } from './types.ts';

// ── Token ──

interface TokenOptions {
  skip?: boolean;
  scope?: string;
  escape?: RegExp;
  regex?: boolean;
  embed?: string;
  // ── Lexer hints (keep gen-parser language-agnostic; all optional) ──
  identifier?: boolean;
  template?: { open: string; interpOpen: string; interpClose: string };
  regexContext?: {
    divisionAfterTypes?: string[];
    divisionAfterTexts?: string[];
    regexAfterTexts?: string[];
    regexAfterParenKeywords?: string[];
    memberAccessTexts?: string[];
  };
  string?: boolean;
}

export class TokenRef {
  readonly __kind = 'token' as const;
  readonly pattern: RegExp;
  readonly opts: TokenOptions;
  constructor(pattern: RegExp, opts: TokenOptions) {
    this.pattern = pattern;
    this.opts = opts;
  }
}

export function token(pattern: RegExp, opts?: TokenOptions): TokenRef {
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

type Marker = OpMarker | PrefixSlot | PostfixSlot;

export const op: OpMarker = { __kind: 'op' };

export const prefix: PrefixSlot = Object.assign(
  (...ops: string[]): PrefixOps => ({ __kind: 'prefix-ops' as const, ops }),
  { __kind: 'prefix' as const },
) as PrefixSlot;

export const postfix: PostfixSlot = Object.assign(
  (...ops: string[]): PostfixOps => ({ __kind: 'postfix-ops' as const, ops }),
  { __kind: 'postfix' as const },
) as PostfixSlot;

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

type Combinator = SepNode | OptNode | ManyNode | Many1Node | AltNode;

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

// ── Precedence ──

interface PrecLevelDef {
  readonly __kind: 'prec-level';
  assoc: 'left' | 'right' | 'none';
  operators: PrecOperator[];
}

function buildPrecOps(ops: (string | PrefixOps | PostfixOps)[]): PrecOperator[] {
  const result: PrecOperator[] = [];
  for (const o of ops) {
    if (typeof o === 'string') {
      result.push({ value: o, position: 'infix' });
    } else if (o.__kind === 'prefix-ops') {
      for (const v of o.ops) result.push({ value: v, position: 'prefix' });
    } else {
      for (const v of o.ops) result.push({ value: v, position: 'postfix' });
    }
  }
  return result;
}

export function left(...ops: (string | PrefixOps | PostfixOps)[]): PrecLevelDef {
  return { __kind: 'prec-level', assoc: 'left', operators: buildPrecOps(ops) };
}

export function right(...ops: (string | PrefixOps | PostfixOps)[]): PrecLevelDef {
  return { __kind: 'prec-level', assoc: 'right', operators: buildPrecOps(ops) };
}

export function none(...ops: (string | PrefixOps | PostfixOps)[]): PrecLevelDef {
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
  const marker = el as Marker;
  if (marker.__kind === 'op') return { type: 'op' };
  if (marker.__kind === 'prefix') return { type: 'prefix' };
  if (marker.__kind === 'postfix') return { type: 'postfix' };
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
}

export function defineGrammar(config: GrammarConfig): CstGrammar & { name: string; scopeName?: string } {
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
      pattern: tok.pattern.source,
      flags,
      scope: tok.opts.scope,
      escapePattern: tok.opts.escape?.source,
      embed: tok.opts.embed,
      identifier: tok.opts.identifier,
      template: tok.opts.template,
      regexContext: tok.opts.regexContext && {
        divisionAfterTypes: tok.opts.regexContext.divisionAfterTypes ?? [],
        divisionAfterTexts: tok.opts.regexContext.divisionAfterTexts ?? [],
        regexAfterTexts: tok.opts.regexContext.regexAfterTexts ?? [],
        regexAfterParenKeywords: tok.opts.regexContext.regexAfterParenKeywords ?? [],
        memberAccessTexts: tok.opts.regexContext.memberAccessTexts ?? [],
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

  return { name: config.name, scopeName: config.scopeName, tokens, precs, rules, scopeOverrides };
}
