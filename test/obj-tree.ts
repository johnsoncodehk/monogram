// A TreeAccess adapter over an INTERPRETER object CST — absolute coordinates, ids
// assigned by one post-order walk. It lets matcher consumers (the ts-ast lowering)
// run against the interp oracle without caring that the EMITTED tree went green
// (relative coordinates): the adapter ignores every tokBase it is handed.
//
// leafTokKindOf is only ever consulted on kind-0 leaves (the generated probes test
// the kind bit first), where the object leaf's tokenType IS the token name (or
// '$punct') — so the name→type-kind map (same derivation as the engine: punct 1,
// template spans 2-4, named tokens from 5 in declaration order) is complete.
import type { CstGrammar } from '../src/types.ts';

type Leafish = { tokenType: string; offset: number; end: number };
type Nodeish = { rule: string; children: (Leafish | Nodeish)[]; offset: number; end: number };

export interface ObjTree {
  rootId: number;
  // matcher-facing (TreeAccess-compatible; tokBase params ignored)
  ruleNameOf(id: number): string;
  ruleIdOf(id: number): number;
  childCount(id: number): number;
  childAt(id: number, i: number): number;
  childrenInto(id: number, out: number[]): number;
  leafKindOf(entry: number): number;
  leafTokKindOf(entry: number, tokBase?: number): number;
  leafOffsetOf(entry: number, tokBase?: number): number;
  leafEndOf(entry: number, tokBase?: number): number;
  // stateless absolute conveniences (the lowering's toolkit)
  offsetOf(entry: number): number;
  endOf(entry: number): number;
  leafTokenType(entry: number): string;
}

export function objTree(root: Nodeish, grammar: CstGrammar): ObjTree {
  const typeKind = new Map<string, number>([['', 1], ['$punct', 1], ['$templateHead', 2], ['$templateMiddle', 3], ['$templateTail', 4]]);
  { let next = 5; for (const t of grammar.tokens) if (!typeKind.has(t.name)) typeKind.set(t.name, next++); }
  const ruleIdM = new Map<string, number>(grammar.rules.map((r, i) => [r.name, i]));
  ruleIdM.set('$template', grammar.rules.length);

  const nodes: Nodeish[] = [];
  const leaves: Leafish[] = [];
  const kidsOf: number[][] = [];
  const walk = (n: Nodeish): number => {
    const ks: number[] = [];
    for (const c of n.children) {
      if ((c as Leafish).tokenType !== undefined) {
        const lf = c as Leafish;
        const li = leaves.length;
        leaves.push(lf);
        const kind = lf.tokenType === '$keyword' ? 1 : lf.tokenType === '$operator' ? 2 : 0;
        ks.push(~((li << 2) | kind));
      } else {
        ks.push(walk(c as Nodeish));
      }
    }
    const id = nodes.length;
    nodes.push(n);
    kidsOf.push(ks);
    return id;
  };
  const rootId = walk(root);
  const leafOf = (e: number) => leaves[(~e) >>> 2];

  return {
    rootId,
    ruleNameOf: (id) => nodes[id].rule,
    ruleIdOf: (id) => ruleIdM.get(nodes[id].rule) ?? -1,
    childCount: (id) => kidsOf[id].length,
    childAt: (id, i) => kidsOf[id][i],
    childrenInto: (id, out) => { const ks = kidsOf[id]; for (let i = 0; i < ks.length; i++) out[i] = ks[i]; return ks.length; },
    leafKindOf: (e) => (~e) & 3,
    leafTokKindOf: (e) => typeKind.get(leafOf(e).tokenType) ?? 0,
    leafOffsetOf: (e) => leafOf(e).offset,
    leafEndOf: (e) => leafOf(e).end,
    offsetOf: (e) => e >= 0 ? nodes[e].offset : leafOf(e).offset,
    endOf: (e) => e >= 0 ? nodes[e].end : leafOf(e).end,
    leafTokenType: (e) => leafOf(e).tokenType,
  };
}
