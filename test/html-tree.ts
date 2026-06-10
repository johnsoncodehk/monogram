// Shared, side-effect-free HTML element-tree normalization — the ONE definition of
// "the element tree" both the conformance GATE (test/html-conformance.ts) and the
// README coverage METRIC (test/src-coverage-html.ts) compare on. It used to live
// copied in both files; the copy drifted (the metric kept reading the deleted CST
// `text` field after the span-only contract landed and silently reported 1.2%
// agreement), so the normalization now lives here once.

export interface El { tag: string; children: El[] }

// Element tree (tag + nested elements only — text/comments/attrs ignored) from the
// Monogram CST: an Element node's tag is its open Name/VoidName leaf; its children
// are the Element nodes nested in its content. Leaves are span-only — the tag text
// is sliced from the source.
export function monoTree(node: any, src: string): El[] {
  const out: El[] = [];
  for (const c of node.children ?? []) collect(c, out, src);
  return out;
}
function collect(node: any, out: El[], src: string): void {
  if (node.tokenType !== undefined) return;
  if (node.rule === 'Element') {
    const name = (node.children ?? []).find(
      (c: any) => c.tokenType === 'Name' || c.tokenType === 'VoidName',
    );
    out.push({ tag: (name ? src.slice(name.offset, name.end) : '').toLowerCase(), children: monoTree(node, src) });
    return; // its element children are handled by the recursive monoTree above
  }
  for (const c of node.children ?? []) collect(c, out, src); // descend through wrappers (Node, …)
}

// Same element tree from a parse5 fragment. Spec-mandated containers parse5 SYNTHESISES
// (implied <tbody>, <colgroup>, …) carry a null sourceCodeLocation (needs
// {sourceCodeLocationInfo:true}); drop them and hoist their real children so this compares
// SOURCE structure against the source-faithful CST, not against parse5's constructed DOM.
export function p5Tree(node: any): El[] {
  const out: El[] = [];
  for (const c of node.childNodes ?? []) {
    if (!c.tagName) continue;
    if (c.sourceCodeLocation == null) { out.push(...p5Tree(c)); continue; }
    out.push({ tag: c.tagName.toLowerCase(), children: p5Tree(c) });
  }
  return out;
}
