// tsx-issue-cases.ts — REAL .tsx highlighting bugs reported against the official VS Code
// TypeScriptReact grammar (generated from microsoft/TypeScript-TmLanguage), as DATA (no
// side effects on import). Shared by test/issue-table.ts (the README cross-language table).
//
// Monogram's .tsx is the JSX dialect DERIVED from the conformance-proven TS base (withJsx) —
// not a separate hand-written grammar. These are cases the hand-written official grammar gets
// wrong: it breaks a generic-arrow type-param list with a default/const modifier to
// `invalid.illegal` (the `<` is taken as a JSX tag), and lumps a member-expression tag name
// into one component token. The derived grammar disambiguates both. (#1033 — a JSX component
// with a generic type argument — the official already handles; Monogram now matches it.)

export interface Check { at: string; nth?: number; want: (s: string) => boolean; desc: string }
export interface Case { id: string; title: string; src: string; checks: Check[] }

// The generic-arrow `=>` is a function arrow. When the official mis-reads the `<…>` as a JSX
// tag, the whole tail (incl. `=>`) cascades to `invalid.illegal.attribute`, so this single
// check cleanly separates "recognized as a generic arrow" from "broken".
const arrow = (s: string) => s.includes('storage.type.function.arrow');
const isType = (s: string) => s.includes('support.type') || s.includes('entity.name.type');
const isVar = (s: string) => s.includes('variable.other');

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
];
