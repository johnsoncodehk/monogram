// region-view.ts — what a grammar's element region declares, normalised for the editor
// generators (TextMate, Monarch, tree-sitter). docs/REGIONS.md, "What the generators need".
//
// Every fact here is read from the grammar: the region declaration (`elements`) and the rules
// that use it. Nothing is a built-in element vocabulary: a grammar that declares no region gets
// no view (null), so no element layer, whatever tokens or rules it has.
import type { CstGrammar, ElementRegion, ElementHighlight, RuleExpr, TokenDecl, TokenPattern } from './types.ts';
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
  /** The tag-name rule has an arm that is a hole (`<{expr}>…</{expr}>`): a dynamic tag. */
  dynamicTag: boolean;
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
  let tagName: NameShape | null = null, attr: NameShape | null = null, attrRule: string | null = null, attrAssign: string | null = null, fragment = false, dynamicTag = false, typeArgRule: string | null = null;
  for (const a of arms) {
    const n = a[1];
    if (isLit(n, region.tagClose)) fragment = true;
    if (n?.type !== 'ref' || rules.get(n.name) === undefined) continue;
    tagName ??= nameShape(n.name);
    // an arm of the tag-name rule that begins with the hole opener (through rule references)
    const holeHeaded = (ruleName: string, seen: Set<string>): boolean => {
      if (seen.has(ruleName)) return false;
      seen.add(ruleName);
      return expandArms(rules.get(ruleName)?.body ?? { type: 'seq', items: [] }).some((x) =>
        isLit(x[0], region.hole.open) || (x[0]?.type === 'ref' && rules.has(x[0].name) && x.length === 1 && holeHeaded(x[0].name, seen)));
    };
    if (holeHeaded(n.name, new Set())) dynamicTag = true;
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
    arms, tagName, attr, attrRule, attrAssign, fragment, dynamicTag, typeArgRule,
    ownTokens: new Set([region.text, region.closeTag, region.selfClose, ...region.tagTokens ?? [], ...(region.rawText ?? []).map((r) => r.token)].filter((x): x is string => x !== undefined)),
    tagTokens,
    highlight: region.highlight ?? {},
  };
}

/** Whether a match of `p` can end with the unit `ch` (conservative: true when unsure). */
function canEndWith(p: TokenPattern, ch: string): boolean {
  if (typeof p === 'string') return p.endsWith(ch);
  switch (p.type) {
    case 'anyChar': return true;
    case 'charClass': {
      const inItems = p.items.some((it) => (it.type === 'char' ? it.value === ch : it.from <= ch && ch <= it.to));
      return p.negate ? !inItems : inItems;
    }
    case 'seq': {
      for (let i = p.items.length - 1; i >= 0; i--) {
        if (canEndWith(p.items[i], ch)) return true;
        if (!nullable(p.items[i])) return false;
      }
      return false;
    }
    case 'alt': return p.items.some((x) => canEndWith(x, ch));
    case 'repeat': return (p.max ?? 1) > 0 && canEndWith(p.body, ch);
    default: return false;
  }
}
function nullable(p: TokenPattern): boolean {
  if (typeof p === 'string') return p === '';
  switch (p.type) {
    case 'seq': return p.items.every(nullable);
    case 'alt': return p.items.some(nullable);
    case 'repeat': return p.min === 0 || nullable(p.body);
    case 'lookahead': case 'lookbehind': case 'anchor': return true;
    default: return false;
  }
}
/** A pattern that runs to the end of its line: its last item a repetition of a class without `\n`. */
function runsToLineEnd(p: TokenPattern): boolean {
  if (typeof p === 'string' || p.type !== 'seq') return false;
  const last = p.items[p.items.length - 1];
  return typeof last !== 'string' && last.type === 'repeat' && typeof last.body !== 'string' && last.body.type === 'charClass'
    && last.body.negate && last.body.items.some((it) => it.type === 'char' && it.value === '\n');
}
/** The literal text a pattern always ends with, or null. */
function closingText(p: TokenPattern): string | null {
  if (typeof p === 'string') return p || null;
  if (p.type === 'seq') { const last = p.items[p.items.length - 1]; return typeof last === 'string' && last ? last : null; }
  if (p.type === 'alt') { const c = p.items.map(closingText); return c.every((x) => x !== null && x === c[0]) ? c[0] : null; }
  return null;
}

/**
 * Where an element entered at an OPERAND position may start, as texts a highlighter tests BEFORE
 * the `tagOpen` (docs/REGIONS.md, "Entry from code"): the complement of the lexer's `prevIsValue`
 * (the regex / division decision, read from the grammar's `regexContext`).
 *   - `after`: the texts after which an operand may start: every non-word literal of the rules and
 *     operator tables that is not a value text (`divisionAfterTexts`), and the expression-head
 *     keywords (`regexAfterTexts`);
 *   - `notAfter`: value texts that end with one of `after` (`++` ends with `+`), and the closing
 *     text of a skip token whose last unit is one of `after`'s (a block comment's `*` `/`);
 *   - `dropped`: what the complement holds that a test of the text before the `tagOpen` cannot
 *     tell from a value, each with its reason: a text that is postfix after a value and prefix
 *     otherwise (`!`), and a text whose last unit can end a value token (`.` ends the number `1.`).
 * A skip token that runs to its line's end (a line comment) never stands before a `tagOpen` on its
 * own line, so it is no conflict. Null when the grammar declares no `regexContext`.
 */
export interface OperandEntry { after: string[]; notAfter: string[]; dropped: { text: string; reason: string }[] }
export function operandEntry(grammar: CstGrammar): OperandEntry | null {
  const rc = grammar.tokens.find((t) => t.regexContext)?.regexContext;
  if (!rc) return null;
  const lits: string[] = [];
  const add = (s: string) => { if (!lits.includes(s)) lits.push(s); };
  const walk = (e: RuleExpr): void => {
    switch (e.type) {
      case 'literal': add(e.value); return;
      case 'seq': case 'alt': e.items.forEach(walk); return;
      case 'quantifier': case 'group': case 'not': walk(e.body); return;
      case 'sep': walk(e.element); add(e.delimiter); return;
      default: return;
    }
  };
  for (const r of grammar.rules) walk(r.body);
  for (const l of grammar.precs) for (const o of l.operators) add(o.value);
  const isWord = (s: string) => /^\w/.test(s);
  const values = new Set(rc.divisionAfterTexts);
  const postfix = new Set(rc.postfixAfterValueTexts ?? []);
  const valueTokens = grammar.tokens.filter((t) => rc.divisionAfterTypes.includes(t.name));
  const skipTokens = grammar.tokens.filter((t) => t.flags.includes('skip') && !runsToLineEnd(t.pattern));
  const after: string[] = [], notAfter: string[] = [], dropped: { text: string; reason: string }[] = [];
  for (const l of lits) {
    if (isWord(l) || values.has(l)) continue;
    if (postfix.has(l)) { dropped.push({ text: l, reason: 'postfix after a value, prefix otherwise: its reading depends on what precedes it' }); continue; }
    const v = valueTokens.find((t) => canEndWith(t.pattern, l[l.length - 1]));
    if (v) { dropped.push({ text: l, reason: `its last unit can end a \`${v.name}\`` }); continue; }
    after.push(l);
  }
  for (const w of rc.regexAfterTexts) if (!after.includes(w)) after.push(w);
  for (const v of values) if (!isWord(v) && after.some((a) => v.length > a.length && v.endsWith(a)) && !notAfter.includes(v)) notAfter.push(v);
  for (const t of skipTokens) {
    const ends = after.filter((a) => !isWord(a) && canEndWith(t.pattern, a[a.length - 1]));
    if (!ends.length) continue;
    const closing = closingText(t.pattern);
    if (closing !== null) { if (!notAfter.includes(closing)) notAfter.push(closing); continue; }
    for (const a of ends) { after.splice(after.indexOf(a), 1); dropped.push({ text: a, reason: `its last unit can end the skip token \`${t.name}\`` }); }
  }
  return { after, notAfter, dropped };
}
