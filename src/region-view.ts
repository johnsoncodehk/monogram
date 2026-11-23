// region-view.ts — what a grammar's element region declares, normalised for the editor
// generators (TextMate, Monarch, tree-sitter). docs/REGIONS.md, "What the generators need".
//
// Every fact here is read from the grammar: the region declaration (`elements`) and the rules
// that use it. Nothing is a built-in element vocabulary: a grammar that declares no region gets
// no view (null), so no element layer, whatever tokens or rules it has.
import type { CstGrammar, ElementRegion, ElementHighlight, RuleExpr, TokenDecl } from './types.ts';
import { tagOpenOnlyOpensTags } from './grammar-analysis.ts';
import { tokenPatternLiteralText } from './token-pattern.ts';

/** The shape of a tag or attribute NAME: the identifier token at its head, and the literals that
 *  join further identifiers to it (`.` / `:` / `-` in JSX's `a.b`, `svg:rect`, `data-id`), in rule order. */
export interface NameShape { rule: string; joiners: string[] }

export interface RegionView {
  region: ElementRegion;
  /** The region's name: the prefix of the generators' own names for it (TextMate repository keys). */
  name: string;
  /** Literal texts of the close-tag (`</`) and self-close (`/>`) tokens. */
  closeTagText: string;
  selfCloseText: string;
  /** How code enters an element: at every `tagOpen` ('always'), or only where an operand may start. */
  entry: 'always' | 'operand';
  /** The element arms, opt / alt / repetition expanded (each a flat item list starting with `tagOpen`). */
  arms: RuleExpr[][];
  /** The rule right after `tagOpen` in an element arm (the tag name), with its name shape. */
  tagName: NameShape | null;
  /** The rule repeated after the tag name (an attribute), with the shape of its name arm. */
  attr: NameShape | null;
  /** The attribute rule itself (whose arms hold the name, the assign literal and the value). */
  attrRule: string | null;
  /** The literal between an attribute's name and its value (`=`), if any. */
  attrAssign: string | null;
  /** An arm `tagOpen tagClose …`: a nameless element (JSX's fragment `<>…</>`). */
  fragment: boolean;
  /** The rule inside a tag's type-argument list `tagOpen Name tagOpen sep(T) tagClose` (TSX), or null. */
  typeArgRule: string | null;
  /** Tokens lexed only in the region (text, close tag, self-close, tag tokens, raw-text bodies). */
  ownTokens: Set<string>;
  tagTokens: TokenDecl[];
  highlight: ElementHighlight;
}

/** Flatten an expression into its item sequences: alt / group expanded, a repetition as zero or
 *  one occurrence (`+` as one), so adjacency scans see every combination. */
export function expandArms(expr: RuleExpr): RuleExpr[][] {
  switch (expr.type) {
    case 'seq': {
      let acc: RuleExpr[][] = [[]];
      for (const item of expr.items) {
        const branches = expandArms(item);
        const next: RuleExpr[][] = [];
        for (const prefix of acc) for (const b of branches) next.push([...prefix, ...b]);
        acc = next;
      }
      return acc;
    }
    case 'alt': return expr.items.flatMap(expandArms);
    case 'group': return expandArms(expr.body);
    case 'quantifier': { const present = expandArms(expr.body); return expr.kind === '+' ? present : [[], ...present]; }
    case 'not': return [[]];
    default: return [[expr]];
  }
}

const isLit = (e: RuleExpr | undefined, v: string): boolean => e?.type === 'literal' && e.value === v;

export function regionView(grammar: CstGrammar): RegionView | null {
  const region = grammar.elements;
  if (!region) return null;
  const tok = (n: string) => grammar.tokens.find((t) => t.name === n);
  const text = (n: string): string => {
    const t = tok(n);
    const s = t ? tokenPatternLiteralText(t) : null;
    if (s === null) throw new Error(`element region: token \`${n}\` must be a literal text`);
    return s;
  };
  const rules = new Map(grammar.rules.map((r) => [r.name, r]));
  const closers = new Set([region.closeTag, region.selfClose]);
  const refsCloser = (items: RuleExpr[]) => items.some((x) => x.type === 'ref' && closers.has(x.name));
  const arms: RuleExpr[][] = [];
  for (const r of grammar.rules) for (const a of expandArms(r.body)) if (isLit(a[0], region.tagOpen) && refsCloser(a)) arms.push(a);

  // The identifier token a name rule begins with, through rule references at its head.
  const identTokens = new Set(grammar.tokens.filter((t) => t.identifier).map((t) => t.name));
  const nameShape = (ruleName: string): NameShape | null => {
    const seen = new Set<string>();
    let cur = ruleName;
    for (;;) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      const r = rules.get(cur);
      if (!r) return null;
      const named = expandArms(r.body).find((a) => a[0]?.type === 'ref');
      if (!named) return null;
      const head = named[0] as { name: string };
      if (identTokens.has(head.name)) {
        // the joiners: literals right before a further identifier in the arms of the name rule
        const joiners: string[] = [];
        for (const a of expandArms(r.body)) {
          if (a[0]?.type !== 'ref' || !identTokens.has((a[0] as { name: string }).name)) continue;
          for (let i = 1; i + 1 < a.length; i++) {
            const j = a[i], n = a[i + 1];
            if (j.type === 'literal' && n.type === 'ref' && identTokens.has(n.name) && !joiners.includes(j.value)) joiners.push(j.value);
          }
        }
        return { rule: cur, joiners };
      }
      cur = head.name;
    }
  };
  let tagName: NameShape | null = null, attr: NameShape | null = null, attrRule: string | null = null, attrAssign: string | null = null, fragment = false, typeArgRule: string | null = null;
  for (const a of arms) {
    const n = a[1];
    if (isLit(n, region.tagClose)) fragment = true;
    if (n?.type !== 'ref' || rules.get(n.name) === undefined) continue;
    tagName ??= nameShape(n.name);
    let i = 2;
    if (isLit(a[2], region.tagOpen) && a[3]?.type === 'sep' && isLit(a[4], region.tagClose)) {
      const el = (a[3] as { element: RuleExpr }).element;
      if (el.type === 'ref') typeArgRule ??= el.name;
      i = 5;
    }
    const at = a[i];
    if (at?.type === 'ref' && rules.has(at.name) && !attr) {
      attr = nameShape(at.name);
      if (attr) attrRule = at.name;
      // the literal between a name and its value: in an attribute arm that begins with its name,
      // the first literal that is no name joiner
      if (attr) for (const arm of expandArms(rules.get(at.name)!.body)) {
        if (arm[0]?.type !== 'ref') continue;
        const l = arm.find((x) => x.type === 'literal' && !attr!.joiners.includes(x.value));
        if (l) { attrAssign = (l as { value: string }).value; break; }
      }
    }
  }
  const tagTokens = (region.tagTokens ?? []).map((n) => tok(n)).filter((t): t is TokenDecl => !!t);
  return {
    region,
    name: region.name ?? grammar.name ?? 'element',
    closeTagText: text(region.closeTag),
    selfCloseText: text(region.selfClose),
    entry: tagOpenOnlyOpensTags(grammar, region) ? 'always' : 'operand',
    arms, tagName, attr, attrRule, attrAssign, fragment, typeArgRule,
    ownTokens: new Set([region.text, region.closeTag, region.selfClose, ...region.tagTokens ?? [], ...(region.rawText ?? []).map((r) => r.token)].filter((x): x is string => x !== undefined)),
    tagTokens,
    highlight: region.highlight ?? {},
  };
}
