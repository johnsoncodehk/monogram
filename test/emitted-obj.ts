// Materialize an emitted-engine tree as a plain object — TEST-SIDE ONLY. The engine
// deliberately exposes a single consumption surface (visit + tree accessors); full
// materialization is a consumer choice, and the only consumer that needs it is the
// gate layer's byte-identical JSON comparison (incremental ≡ fresh, emit ≡ interp).
// The shape (and KEY ORDER — JSON.stringify equality depends on it) mirrors the
// interpreter's native object trees: nodes { rule, children, offset, end }, leaves
// { tokenType, offset, end }.
export interface TreeView {
  ruleNameOf(id: number): string;
  lenOf(id: number): number;
  leafTokenType(entry: number, tokBase: number): string;
  leafOffsetOf(entry: number, tokBase: number): number;
  leafEndOf(entry: number, tokBase: number): number;
}
type VisitFns = {
  enter?(id: number, charBase: number, tokBase: number): boolean | void;
  leave?(id: number, charBase: number, tokBase: number): void;
  leaf?(entry: number, tok: number): void;
};
export type ObjNode = { rule: string; children: (ObjNode | ObjLeaf)[]; offset: number; end: number };
export type ObjLeaf = { tokenType: string; offset: number; end: number };

export function objectify(tree: TreeView, runVisit: (fns: VisitFns) => void): ObjNode {
  const rootHolder: { children: (ObjNode | ObjLeaf)[] } = { children: [] };
  const stack: { children: (ObjNode | ObjLeaf)[] }[] = [rootHolder];
  runVisit({
    enter(id, charBase) {
      const node: ObjNode = { rule: tree.ruleNameOf(id), children: [], offset: charBase, end: charBase + tree.lenOf(id) };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    },
    leave() { stack.pop(); },
    leaf(entry, tok) {
      const tb = tok - ((~entry) >>> 2);
      stack[stack.length - 1].children.push({ tokenType: tree.leafTokenType(entry, tb), offset: tree.leafOffsetOf(entry, tb), end: tree.leafEndOf(entry, tb) });
    },
  });
  return rootHolder.children[0] as ObjNode;
}
