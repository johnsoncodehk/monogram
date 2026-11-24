// The names of a grammar's arms and children: ONE deriver, read by every consumer that names
// them (the CST destructurers of gen-cst-match today; ShapeSpecs and the portable IR next).
//
// A name is either AUTHOR-WRITTEN (`arm(name, ...)` / `field(name, ...)` in src/api.ts, carried
// on the RuleExpr node as `arm` / `field`) or DERIVED from the syntax: an arm from its first
// significant item (`if`, `led_dot`, `export`), a child from what it references (`expr`,
// `block`), a keyword leading an optional group as `<kw>Tok`, a pure keyword alternation as
// `<first>Kw`, a structural alternation as `alt`, an inline branch like an arm. Names are
// identifier-safe (sanitizeIdent). Within one scope (a rule's arms; one arm's or one inline
// branch's children; one alternation's branches) a derived name that repeats gets a numeric
// suffix (`export2`, `expr2`): such a name is POSITIONAL (it moves when an earlier arm or
// child is added or removed), and `nameReport` lists every one so an author can name it. An
// author-written name never gets a suffix: two equal author-written names in one scope, or one
// equal to a derived name there, are an error.
//
// The walk mirrors which items a CST arm holds as children (gen-cst-match's step plan): zero-
// width items hold none; a literal holds an unnamed leaf (except the keyword that leads an
// optional group); a token or rule reference holds one child; an alternation of literals one
// leaf; a structural alternation one child whose branches are scopes of their own.
import type { RuleDecl, RuleExpr } from './types.ts';
import { isKeywordLiteral, ZERO_WIDTH_MARKERS } from './grammar-utils.ts';

const RESERVED = new Set(['arm', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await',
  // not reserved words, but no strict-mode binding may be named so (the generated destructurers
  // declare a local per name, in a module: `let arguments` is a SyntaxError there)
  'arguments', 'eval']);

const PUNCT_NAMES: Record<string, string> = {
  '(': 'paren', ')': 'parenClose', '[': 'bracket', ']': 'bracketClose', '{': 'brace', '}': 'braceClose',
  ';': 'semi', ',': 'comma', ':': 'colon', '.': 'dot', '...': 'spread', '?': 'question', '?.': 'optChain',
  '=': 'eq', '=>': 'arrow', '<': 'lt', '>': 'gt', '*': 'star', '!': 'bang', '#': 'hash', '@': 'at',
  '|': 'pipe', '&': 'amp', '-': 'dash', '+': 'plus', '/': 'slash', '%': 'percent', '~': 'tilde', '^': 'caret',
};

export function lowerFirst(s: string): string { return s.charAt(0).toLowerCase() + s.slice(1); }
export function sanitizeIdent(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_$]/g, '_');
  let base = /^[0-9]/.test(cleaned) ? '_' + cleaned : cleaned;
  if (base.startsWith('__')) base = 'f' + base;   // '__' is reserved for the emitted helpers
  return RESERVED.has(base) ? base + '_' : base;
}

/** A RuleExpr's syntax as a string, without its names: the key under which two equal syntaxes
 * are one (a parser that dedupes or compares subexpressions must not tell them apart by a name). */
export function syntaxKey(e: RuleExpr | readonly RuleExpr[]): string {
  return JSON.stringify(e, (k, v) => (k === 'arm' || k === 'field' ? undefined : v));
}

const ZERO_WIDTH = ZERO_WIDTH_MARKERS;

// Name an arm from its first significant item; `sig` is self-stripped for leds.
export function deriveArmName(items: RuleExpr[], isLed: boolean): string {
  const sig = isLed ? items.slice(1) : items;
  return (isLed ? 'led_' : '') + nameFrom(sig, 8);
}
export function nameFrom(items: RuleExpr[], fuel: number): string {
  const first = items[0];
  if (!first || fuel <= 0) return 'empty';
  if (first.type === 'literal') {
    const v = first.value;
    return isKeywordLiteral(v) ? v : (PUNCT_NAMES[v] ?? 'p' + [...v].map(c => c.charCodeAt(0)).join('_'));
  }
  if (first.type === 'ref') return lowerFirst(first.name);
  if (ZERO_WIDTH.has(first.type)) return nameFrom(items.slice(1), fuel - 1);   // zero-width: name by what follows
  if (first.type === 'alt') {
    const lits = first.items.filter((x): x is Extract<RuleExpr, { type: 'literal' }> => x.type === 'literal');
    if (lits.length === first.items.length && lits.length > 0) return sanitizeIdent(lits[0].value);
    return nameFrom([first.items[0], ...items.slice(1)], fuel - 1);
  }
  if (first.type === 'quantifier' || first.type === 'group') return nameFrom([first.body, ...items.slice(1)], fuel - 1);
  if (first.type === 'sep') return lowerFirst(first.element.type === 'ref' ? first.element.name : 'list');
  return first.type;
}

/** Why a name is what it is. */
export type NameOrigin = 'authored' | 'derived' | 'suffixed';
/** `positional`: the name depends on the item's position among the items of its scope that
 * derive the same base (the first keeps the bare base, the later ones a suffix), so it changes
 * when one of them is added, removed or moved. */
export type NamedSlot = { name: string; base: string; origin: NameOrigin; clash?: string; positional?: boolean };
/** One arm's (or one inline branch's) names: its own, and its children's in order. `arm` is
 * the index of the grammar arm it is (or, for a branch, sits in); `index` its own index; `path`
 * where it sits (`Stmt arm 2`, `Stmt arm 1 child 3 branch 0`: positional, for reports only). */
export type ArmNames = NamedSlot & { arm: number; index: number; led: boolean; children: NamedSlot[]; path: string };
export type RuleNames = {
  rule: string;
  /** The grammar arms in declaration order (op-form marker arms excluded: see `ops`). */
  arms: ArmNames[];
  /** The synthesized Pratt operator forms, when the rule declares operators. */
  ops?: { binary: string; prefix: string; postfix: string };
  /** The name of each arm / inline-branch node, keyed by node identity. */
  armOf: Map<RuleExpr, NamedSlot>;
  /** The name of each child node, keyed by node identity. */
  childOf: Map<RuleExpr, NamedSlot>;
  /** Inline branches of each structural alternation node, in order. */
  branches: Map<RuleExpr, ArmNames[]>;
};

/** The children of the synthesized Pratt operator forms, in CST order: a binary node is
 * `[left, op, right]`, a prefix node `[op, operand]`, a postfix node `[operand, op]` (`op` is
 * the `$operator` leaf). Fixed names: the forms come from the precedence table, not from an
 * arm an author could annotate. */
export const OP_FORM_CHILDREN = {
  binary: ['left', 'op', 'right'],
  prefix: ['op', 'operand'],
  postfix: ['operand', 'op'],
} as const;

/** A naming scope: a derived name that repeats gets the first free numeric suffix (2, 3, …). */
class Scope {
  private used = new Set<string>();
  private authored = new Set<string>();
  private firstOf = new Map<string, NamedSlot>();
  private where: string;
  constructor(where: string) { this.where = where; }
  take(base: string, authored: string | undefined): NamedSlot {
    if (authored !== undefined) {
      const nm = sanitizeIdent(authored);
      if (nm !== authored) throw new Error(`grammar-names: ${this.where}: the name ${JSON.stringify(authored)} is not identifier-safe (would be ${JSON.stringify(nm)})`);
      if (this.used.has(nm)) throw new Error(`grammar-names: ${this.where}: the name ${JSON.stringify(nm)} is already used in this scope`);
      this.used.add(nm);
      this.authored.add(nm);
      return { name: nm, base: nm, origin: 'authored' };
    }
    const b = sanitizeIdent(base);
    if (!this.used.has(b)) {
      this.used.add(b);
      const slot: NamedSlot = { name: b, base: b, origin: 'derived' };
      this.firstOf.set(b, slot);
      return slot;
    }
    if (this.authored.has(b)) throw new Error(`grammar-names: ${this.where}: the derived name ${JSON.stringify(b)} equals an author-written name in this scope; name this item too`);
    let k = 2;
    while (this.used.has(b + k)) k++;
    this.used.add(b + k);
    const first = this.firstOf.get(b);
    if (first) first.positional = true;
    return { name: b + k, base: b, origin: 'suffixed', clash: b, positional: true };
  }
}

const itemsOf = (e: RuleExpr): RuleExpr[] => (e.type === 'seq' ? e.items : [e]);
const isOpMarker = (e: RuleExpr): boolean => e.type === 'op' || e.type === 'prefix' || e.type === 'postfix';

/** Does `e` produce at least one CST step? Zero-width items and empty seqs do not. */
function holdsChild(e: RuleExpr): boolean {
  switch (e.type) {
    case 'seq': return e.items.some(holdsChild);
    case 'group': return holdsChild(e.body);
    default: return !ZERO_WIDTH.has(e.type);
  }
}
/** The first step-producing item of `e`, when that item is a literal (the keyword that may
 * lead an optional group). */
function leadLiteral(e: RuleExpr): Extract<RuleExpr, { type: 'literal' }> | null {
  switch (e.type) {
    case 'literal': return e;
    case 'group': return leadLiteral(e.body);
    case 'seq': {
      for (const it of e.items) if (holdsChild(it)) return leadLiteral(it);
      return null;
    }
    default: return null;
  }
}

/** The names of one rule's arms, inline branches and children. */
export function nameRule(rule: RuleDecl): RuleNames {
  const self = rule.name;
  const alts = rule.body.type === 'alt' ? rule.body.items : [rule.body];
  const out: RuleNames = { rule: self, arms: [], armOf: new Map(), childOf: new Map(), branches: new Map() };
  const put = (m: Map<RuleExpr, NamedSlot>, node: RuleExpr, slot: NamedSlot): NamedSlot => {
    if (m.has(node)) throw new Error(`grammar-names: ${self}: one RuleExpr node is reached twice; a node must be one item`);
    m.set(node, slot);
    return slot;
  };
  const armScope = new Scope(`${self} arms`);
  alts.forEach((alt, index) => {
    const raw = itemsOf(alt);
    // A leading `notLeftLeaf(...)` head-leaf guard sits BEFORE the self `$` of a LED arm and is
    // zero-width: the LED is classified past it (as the parsers' classifyAlts do).
    const items = raw[0]?.type === 'notLeftLeaf' ? raw.slice(1) : raw;
    // Pratt op-form marker arms are named by the synthesized operator forms (`ops`).
    if (items.some(isOpMarker)) return;
    const led = items[0]?.type === 'ref' && items[0].name === self;
    const where = `${self} arm ${index}`;
    const kids = new Scope(where);
    const children: NamedSlot[] = [];
    if (led) children.push(put(out.childOf, items[0], kids.take('left', items[0].field)));
    for (const it of led ? items.slice(1) : items) walk(it, kids, children, where, index);
    const own = put(out.armOf, alt, armScope.take(deriveArmName(items, led), alt.arm));
    out.arms.push(Object.assign(own, { arm: index, index, led, children, path: where }));
  });
  if (alts.some((a) => itemsOf(a).some(isOpMarker))) {
    out.ops = { binary: armScope.take('binaryOp', undefined).name, prefix: armScope.take('prefixOp', undefined).name, postfix: armScope.take('postfixOp', undefined).name };
  }
  return out;

  function walk(it: RuleExpr, scope: Scope, children: NamedSlot[], where: string, arm: number): void {
    switch (it.type) {
      case 'ref':
        children.push(put(out.childOf, it, scope.take(lowerFirst(it.name), it.field)));
        return;
      case 'group':
        walk(it.body, scope, children, where, arm);
        return;
      case 'seq':
        for (const s of it.items) walk(s, scope, children, where, arm);
        return;
      case 'quantifier': {
        walk(it.body, scope, children, where, arm);
        // A keyword literal LEADING an optional group marks the group's presence and carries
        // its position (the 'catch' / 'else' / 'finally' anchors consumers need).
        const lead = it.kind === '?' ? leadLiteral(it.body) : null;
        // A lead the author named is already this scope's child (the `literal` case below).
        if (lead && lead.field === undefined && isKeywordLiteral(lead.value)) children.push(put(out.childOf, lead, scope.take(lead.value + 'Tok', lead.field)));
        return;
      }
      case 'sep':
        walk(it.element, scope, children, where, arm);
        return;
      case 'alt': {
        if (it.items.length > 0 && it.items.every((x) => x.type === 'literal')) {
          children.push(put(out.childOf, it, scope.take(sanitizeIdent((it.items[0] as { value: string }).value) + 'Kw', it.field)));
          return;
        }
        const at = `${where} child ${children.length}`;
        const tags = new Scope(`${at} alternation`);
        const branches: ArmNames[] = [];
        it.items.forEach((b, index) => {
          const bw = `${at} branch ${index}`;
          const kids = new Scope(bw);
          const bc: NamedSlot[] = [];
          walk(b, kids, bc, bw, arm);
          const own = put(out.armOf, b, tags.take(holdsChild(b) ? sanitizeIdent(nameFrom(itemsOf(b), 8)) : 'empty', b.arm));
          branches.push(Object.assign(own, { arm, index, led: false, children: bc, path: bw }));
        });
        out.branches.set(it, branches);
        children.push(put(out.childOf, it, scope.take('alt', it.field)));
        return;
      }
      case 'literal':
        // An unnamed leaf. A `field` on it names it for later readers (a shape's `present`
        // bind) in this scope; the CST destructurers do not capture it.
        if (it.field !== undefined) put(out.childOf, it, scope.take(it.value, it.field));
        return;
      default:
        return;   // zero-width markers: no child
    }
  }
}

/** A positional name: what an author should write instead. */
export type NameFinding = { rule: string; arm: number; path: string; child?: number; name: string; clash: string; kind: 'arm' | 'branch' | 'child' };

/** Every arm, inline branch and child whose derived name is positional (it shares its base with
 * another item of its scope: the first holds the bare base, the others a numeric suffix), with
 * that base: the list an author reads to decide which names to write. */
export function nameReport(rules: readonly RuleDecl[]): NameFinding[] {
  const out: NameFinding[] = [];
  for (const r of rules) {
    const n = nameRule(r);
    const visit = (a: ArmNames, kind: 'arm' | 'branch'): void => {
      if (a.positional) out.push({ rule: r.name, arm: a.arm, path: a.path, name: a.name, clash: a.base, kind });
      a.children.forEach((c, i) => {
        if (c.positional) out.push({ rule: r.name, arm: a.arm, path: a.path, child: i, name: c.name, clash: c.base, kind: 'child' });
      });
    };
    for (const a of n.arms) visit(a, 'arm');
    for (const bs of n.branches.values()) for (const b of bs) visit(b, 'branch');
  }
  return out;
}
