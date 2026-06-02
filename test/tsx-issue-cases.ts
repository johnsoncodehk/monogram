// tsx-issue-cases.ts — REAL .tsx highlighting bugs reported against the official VS Code
// TypeScriptReact grammar (generated from microsoft/TypeScript-TmLanguage), as DATA (no
// side effects on import). Shared by test/issue-table.ts (the README cross-language table).
//
// Monogram's .tsx is the JSX dialect DERIVED from the conformance-proven TS base (withJsx) —
// not a separate hand-written grammar. The first cases are ones the hand-written official grammar
// gets wrong: it breaks a generic-arrow type-param list with a default/const modifier to
// `invalid.illegal` (the `<` is taken as a JSX tag), and lumps a member-expression tag name
// into one component token. The derived grammar disambiguates both. (#1033 — a JSX component
// with a generic type argument — the official already handles; Monogram now matches it.)
//
// The ledger is HONEST, not cherry-picked: it also keeps cases the derived grammar loses or ties —
// #794 / #754 are only the official solves (a `!`+`/` division mis-read as a regex so the
// `/>` no longer closes the tag; a JSX element after a `/**/` block comment), #825 is a both-fail
// (a `<` and the tag name split across lines defeats both line-oriented grammars), and
// #585 / #667 / #624 are both-pass (a `//` comment inside an open tag is now scoped as a comment;
// real reported cascades both now handle).
// Every `src` was ground-truthed as valid JSX with tsc (ScriptKind.TSX, 0 parse diagnostics; the
// node kind confirms a real JsxElement, not a generic arrow), so a failing check is a true miss.

export interface Check { at: string; nth?: number; want: (s: string) => boolean; desc: string }
export interface Case { id: string; title: string; src: string; checks: Check[] }

// The generic-arrow `=>` is a function arrow. When the official mis-reads the `<…>` as a JSX
// tag, the whole tail (incl. `=>`) cascades to `invalid.illegal.attribute`, so this single
// check cleanly separates "recognized as a generic arrow" from "broken".
const arrow = (s: string) => s.includes('storage.type.function.arrow');
const isType = (s: string) => s.includes('support.type') || s.includes('entity.name.type');
const isVar = (s: string) => s.includes('variable.other');
// A JSX tag name (intrinsic `entity.name.tag` or a `support.class.component`) — used to tell
// "the `<…>` was recognized as a JSX tag" from "it was read as a `<` comparison / type-args".
const isTag = (s: string) => s.includes('entity.name.tag') || s.includes('support.class.component');
// The self-closing `/>` (or a `>`) really closing a tag, vs. cascading into expression operators.
const isTagEnd = (s: string) => s.includes('punctuation.definition.tag.end');
const isComment = (s: string) => s.includes('comment.');
const isChildren = (s: string) => s.includes('meta.jsx.children');

export const cases: Case[] = [
  // ── generic-arrow type-params with a default / `const` modifier (the official breaks these) ──
  { id: '#967', title: 'generic arrow with a default type in `.tsx`', src: `const f = <T = void,>(): G<T> => true;`,
    checks: [{ at: '=>', want: arrow, desc: 'the generic arrow is a function, not a broken JSX tag' }] },
  { id: '#979', title: '`const` modifier on a type parameter in `.tsx`', src: `const f = <const T,>(v: T) => v;`,
    checks: [{ at: '=>', want: arrow, desc: 'the const-type-param arrow is a function' }] },
  { id: '#1042/#990', title: 'default generic arrow function in `.tsx`', src: `const f = <T = string,>(x: T) => x;`,
    checks: [{ at: '=>', want: arrow, desc: 'the default generic arrow is a function' }] },
  // ── member-expression JSX tag name (the official lumps it; Monogram resolves the reference) ──
  { id: '#627', title: 'member-expression JSX tag name', src: `const e = <comps.MyComp />;`,
    checks: [{ at: 'comps', want: isVar, desc: '`comps` is a variable reference, not lumped into the component name' }] },
  // ── JSX component with a generic type argument (both get this right) ──
  { id: '#1033', title: 'JSX component with a generic type argument', src: `const e = <Box<number> prop={1} />;`,
    checks: [{ at: 'number', want: isType, desc: 'the `<number>` type argument is a type, not a broken attribute' }] },

  // ── beyond the generic-arrow / member-tag wins above: honest cases the DERIVED grammar does
  //    NOT win. Each is a real reported bug, ground-truthed as valid JSX with tsc (ScriptKind.TSX,
  //    parseDiagnostics.length===0); the node kind (JsxSelfClosingElement / JsxElement) confirms
  //    the `<…>` is genuinely a JSX tag, not a generic arrow. We keep every honest verdict. ──

  // #794 (only the official solves this). Inside a JSX-attribute object, a non-null `!` followed by
  // ` / ` is a real division — `image.width! / image.height!`. Monogram reads the `!`+`/` as the
  // start of a regex/relational run, so the self-closing `/>` is mis-scoped as a relational operator
  // (`keyword.operator.relational`) instead of closing the tag; the official keeps `/>` as the tag
  // end. tsc: JsxSelfClosingElement, 0 diagnostics — the `/>` really does close the element.
  { id: '#794', title: 'non-null `!` then `/` (division) in a JSX-attribute object', src: `const x = <Image style={{ r: image.width! / image.height! }} />;`,
    checks: [{ at: '/>', want: isTagEnd, desc: 'the `/>` closes the tag — not a relational/regex operator from the `!` `/` run' }] },

  // #585 (both solve this now). A `//` line comment is legal inside the open tag, between
  // attributes. Monogram's open-tag attribute patterns now include the grammar's comment entries
  // (derived, not hardcoded — see gen-tm's commentRepoKeys), so the `// …` line is scoped
  // `comment.line.double-slash` like the official; a `/* */` block comment in the same position
  // works too. tsc: the element is a valid JsxSelfClosingElement with the comment skipped.
  { id: '#585', title: '`//` line comment inside a JSX open tag', src: `const a = <button\n  // hi\n/>;`,
    checks: [{ at: '// hi', want: isComment, desc: 'the `//` line inside the tag is a comment, not tag/attribute text' }] },

  // #754 (only the official solves this). A JSX element preceded by a `/**/` block comment on the
  // same line. Monogram fails to switch into JSX after the comment — `<Element />` is read as a `<`
  // comparison and `Element` becomes `variable.other.readwrite`; the official recognizes the tag
  // (`entity.name.tag` / `support.class.component`). tsc: JsxSelfClosingElement, 0 diagnostics.
  { id: '#754', title: 'JSX element right after a `/**/` block comment', src: `const a = /**/ <Element />;`,
    checks: [{ at: 'Element', want: isTag, desc: 'the post-comment `<Element />` is a JSX tag, not a `<` comparison' }] },

  // #825 (BOTH miss this). `<` and the tag name split across lines — a chevron alone on one line,
  // the name on the next. This is valid JSX (tsc: nested JsxElements, 0 diagnostics) but defeats
  // both line-oriented TM grammars: each scopes the `span` name as `meta.jsx.children` (plain text)
  // rather than an `entity.name.tag`. Kept as an honest both-fail (a structural TM limitation).
  { id: '#825', title: '`<` and tag name on separate lines', src: `const demo =\n  <div>\n    <\n      span className="foo">\n    </span>\n  </div>;`,
    checks: [{ at: 'span', want: isTag, desc: 'the `span` after a lone `<` is a tag name, not JSX text (both grammars miss this)' }] },

  // #667 (BOTH solve this now). An arrow function plus a ternary inside a JSX attribute used to
  // cascade — the ternary LHS was mis-scoped `meta.parameters` and broke the rest. Both grammars now
  // keep the attribute arrow as a function arrow and the element's `text` as JSX children.
  // tsc: JsxElement + ArrowFunction, 0 diagnostics.
  { id: '#667', title: 'arrow function + ternary inside a JSX attribute', src: `const f = <Foo a={d.X ? (d.Y || null) : 'Add'} onR={(p) => { }}>text</Foo>;`,
    checks: [
      { at: '=>', want: arrow, desc: 'the attribute callback `=>` is a function arrow' },
      { at: 'text', want: isChildren, desc: 'the element body `text` is JSX children (no cascade past the arrow)' },
    ] },

  // #624 (BOTH solve this now). A JSX element inside an array literal whose attribute is a template
  // literal — `<Baz key={`k-${bar.id}`} />, <Qux />`. The reported bug was the array's *second*
  // element losing its tag scope; both grammars now recognize `<Qux />` as a component tag.
  // tsc: ArrowFunction + two JsxSelfClosingElements, 0 diagnostics.
  { id: '#624', title: 'JSX element in an array after a template-literal attribute', src: `const g = bar => ([\n  <Baz key={\`k-\${bar.id}\`} />,\n  <Qux />\n]);`,
    checks: [{ at: '<Qux', want: isTag, desc: 'the second array element `<Qux />` is still a JSX tag (no cascade from the template attribute)' }] },
];
