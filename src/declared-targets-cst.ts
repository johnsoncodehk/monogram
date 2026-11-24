// DECLARED ASSIGNMENT-TARGET CONTEXTS (Grammar.targets) in the interpreter (gen-parser.ts): the
// predicate as a WALK over the CST, the reference the portable engine's synthesized form
// (declared-targets.ts) is held to by the parity gates. A node passes context `ctx` iff its arm is
// one of the context's leaves, or one of its containers whose children at the named field (every
// rule child: 'all'; a binary node's left operand: 'left') all pass, a child whose arm is a `last`
// arm of the context being the final such child with no ',' after it; a node of a unit arm (one
// rule call and nothing else, an arm of no context) is its child.
// The interpreter records, only when the grammar declares contexts, which arm built each node and
// which rule references produced each child node (a memoized node may be produced by several).
import { isZeroWidthMarker } from './grammar-utils.ts';
import type { Grammar, RuleDecl, RuleExpr } from './types.ts';
import type { CstNode, CstChild } from './gen-parser.ts';
import { nameRule } from './grammar-names.ts';

type Role = { leaf: Set<number>; field: Map<number, string>; last: Set<number> };
/** What built a node: its arm's name, its unit-ness, and the rule references of the arm with their child names. */
export type ArmInfo = { name: string; unit: boolean; refs: Map<RuleExpr, string> | null; op?: string };


export function targetWalker(grammar: Grammar, rules: Iterable<RuleDecl>, tokenNames: Set<string>) {
  const decl = grammar.targets!;
  const names = Object.keys(decl);
  const roles = new Map<string, Role>();
  const roleOf = (arm: string): Role => {
    let r = roles.get(arm);
    if (!r) { r = { leaf: new Set(), field: new Map(), last: new Set() }; roles.set(arm, r); }
    return r;
  };
  names.forEach((n, i) => {
    const c = decl[n]!;
    for (const a of c.leaves) roleOf(a).leaf.add(i);
    for (const [a, f] of Object.entries(c.containers ?? {})) roleOf(a).field.set(i, f);
    for (const a of c.last ?? []) roleOf(a).last.add(i);
  });
  const isRule = (e: RuleExpr) => e.type === 'ref' && !tokenNames.has(e.name);
  // One rule reference and nothing else (zero-width items aside).
  const unitOf = (e: RuleExpr): boolean => {
    if (isRule(e)) return true;
    if (e.type === 'group' && e.suppress === undefined && e.ctxMode === undefined) return unitOf(e.body);
    if (e.type !== 'seq') return false;
    const own = e.items.filter((x) => !isZeroWidthMarker(x.type));
    return own.length === 1 && unitOf(own[0]!);
  };
  // The rule references of an arm (outside lookaheads), with their child names.
  const refsOf = (alt: RuleExpr, childName: (e: RuleExpr) => string | undefined): Map<RuleExpr, string> => {
    const m = new Map<RuleExpr, string>();
    const go = (e: RuleExpr): void => {
      if (isRule(e)) { m.set(e, childName(e) ?? ''); return; }
      switch (e.type) {
        case 'seq': case 'alt': e.items.forEach(go); break;
        case 'group': case 'quantifier': go(e.body); break;
        case 'sep': go(e.element); break;
        default: break;
      }
    };
    go(alt);
    return m;
  };
  // Every arm of every rule, by its grammar node.
  const arms = new Map<RuleExpr, ArmInfo>();
  const ops = new Map<string, { binary: string; prefix: string; postfix: string }>();
  for (const r of rules) {
    const nr = nameRule(r);
    if (nr.ops) ops.set(r.name, nr.ops);
    const items = r.body.type === 'alt' ? r.body.items : [r.body];
    for (const alt of items) {
      const slot = nr.armOf.get(alt);
      if (!slot) continue;
      const role = roles.get(slot.name);
      arms.set(alt, { name: slot.name, unit: role === undefined && unitOf(alt), refs: role && role.field.size ? refsOf(alt, (e) => nr.childOf.get(e)?.name) : null });
    }
  }

  const armOf = new WeakMap<CstNode, ArmInfo>();
  const producedBy = new WeakMap<CstNode, RuleExpr[]>();
  const nodeKids = (n: CstNode) => n.children.filter((c): c is CstNode => !('tokenType' in c));
  const atField = (c: CstNode, parent: CstNode, info: ArmInfo, field: string): boolean => {
    if (field === 'all') return true;
    if (field === 'left') return parent.children[0] === c;
    const by = producedBy.get(c) ?? [];
    return by.some((e) => info.refs?.get(e) === field);
  };
  const walk = (node: CstNode, i: number, source: string): { pass: boolean; last: boolean } => {
    const info = armOf.get(node);
    if (info === undefined) throw new Error(`targets: the interpreter has no arm recorded for a ${node.rule} node (a construct the target walk does not cover)`);
    const role = (info.op !== undefined ? roles.get(info.op) : undefined) ?? roles.get(info.name);
    if (role === undefined) {
      if (!info.unit) return { pass: false, last: false };
      const kids = nodeKids(node);
      if (kids.length !== 1) throw new Error(`targets: unit arm ${info.name} built ${kids.length} nodes`);
      return walk(kids[0]!, i, source);
    }
    const last = role.last.has(i);
    if (role.leaf.has(i)) return { pass: true, last };
    const field = role.field.get(i);
    if (field === undefined) return { pass: false, last: false };
    let pending = false;
    for (const c of node.children) {
      if ('tokenType' in c) {
        if (pending && source.slice(c.offset, c.end) === ',') return { pass: false, last: false };
        continue;
      }
      const counted = atField(c, node, info, field);
      const any = counted || [...role.field.values()].some((f) => atField(c, node, info, f));
      if (any && pending) return { pass: false, last: false };
      pending = false;
      if (!counted) continue;
      const r = walk(c, i, source);
      if (!r.pass) return { pass: false, last: false };
      pending = r.last;
    }
    return { pass: true, last };
  };
  return {
    /** Record the arm `alt` built `node` (a binary / prefix / postfix operator node: its form, and the operator). */
    built(node: CstNode, alt: RuleExpr): void { const a = arms.get(alt); if (a) armOf.set(node, a); },
    op(node: CstNode, rule: string, form: 'binary' | 'prefix' | 'postfix', op: string): void {
      const o = ops.get(rule);
      if (o) armOf.set(node, { name: o[form], unit: false, refs: null, op: form === 'binary' ? op : undefined });
    },
    produced(child: CstChild, ref: RuleExpr): void {
      if ('tokenType' in child) return;
      const by = producedBy.get(child);
      if (by) { if (!by.includes(ref)) by.push(ref); } else producedBy.set(child, [ref]);
    },
    passes(node: CstChild | undefined, ctx: string, source: string): boolean {
      const i = names.indexOf(ctx);
      if (i < 0) throw new Error(`targets: no context named ${ctx}`);
      if (node === undefined || 'tokenType' in node) throw new Error(`targets: target('${ctx}') must follow a rule reference`);
      return walk(node, i, source).pass;
    },
  };
}
