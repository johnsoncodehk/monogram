// Shared TSX/JSX corpus — JSX-dialect snippets covering tags, attributes, expression
// containers, raw text, entities, fragments, member/generic tags. Used by both
// test/tsx-highlight.ts (the JSX highlighter gate) and test/highlight-bench.ts (the
// README TSX agreement line), so the one figure has a single source of truth.
export const JSX_CORPUS: string[] = [
  `const a = <div className="x" data-id={5}>It's 100% & more!</div>;`,
  `const b = <ul>{items.map(x => <li key={x.id}>{x.name}</li>)}</ul>;`,
  `const c = <span>&nbsp;&amp; entities &#123;</span>;`,
  `const d = <Foo.Bar baz={1}><Child /></Foo.Bar>;`,
  `const e = <><Header title="Hi" />{children}<Footer /></>;`,
  `const f = <input type="text" value={v} disabled {...rest} />;`,
];
