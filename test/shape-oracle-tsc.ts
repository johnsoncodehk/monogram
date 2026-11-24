// The tsc oracle: the real `typescript` package's parser, its tree NORMALISED into the
// harness's NTree (test/shape-oracle.ts). The normalisation, declared in one place:
//
// - kind: the SyntaxKind NAME, canonical = the first name the enum declares for the number
//   (`ts.SyntaxKind[n]` returns the LAST alias, e.g. FirstAssignment for EqualsToken).
// - start = `getStart()` (trivia excluded), end = `node.end`, pos = `node.pos` (full start,
//   leading trivia included): both starts are recorded; the harness compares pos only when
//   the candidate carries it.
// - fields, in `ts.forEachChild` order: every child node or NodeArray, named by the node's own
//   property that holds it (found by identity over the node's own enumerable properties).
//   Modifiers and operator / punctuation tokens are children in tsc (`modifiers`,
//   `operatorToken`, `questionDotToken`, `equalsGreaterThanToken`, ...), so they appear here.
//   A NodeArray is a list; an absent optional child is absent (not null).
// - scalar fields (SCALARS below): the syntactic primitives tsc's parser stores on a node:
//   identifier / literal text, template raw text, token-valued properties (`operator`,
//   `token`, `keywordToken`, `phaseModifier`) as SyntaxKind names, the boolean syntax facts
//   (`isTypeOnly`, `isExportEquals`, `isTypeOf`, ...), scanner token flags of literals.
// - flags: the SYNTACTIC NodeFlags subset (SYNTACTIC_FLAGS), as `A|B` names, absent when none:
//   Let / Const / Using (the declaration list's keyword), Namespace / NestedNamespace /
//   GlobalAugmentation (which module form was written), OptionalChain (a link of a `?.` chain).
//   The other NodeFlags are excluded: parser CONTEXT (YieldContext, AwaitContext,
//   DisallowInContext, DecoratorContext, Ambient, InWithStatement, JavaScriptFile, JsonFile,
//   JSDoc), error state (ThisNodeHasError, ThisNodeOrAnySubNodesHasError), binder / checker
//   facts (HasImplicitReturn, HasExplicitReturn, ExportContext, ContainsThis, TypeCached,
//   Deprecated, HasAggregatedChildData, PossiblyContainsDynamicImport/ImportMeta,
//   HasAsyncFunctions, Synthesized) and identifier escape bookkeeping. They are not the
//   node's syntax: the same text can carry different values of them.
// - ignored for now (stated): parent, id, symbol, localSymbol, flowNode, transformFlags,
//   modifierFlagsCache, emitNode, original, locals, nextContainer, JSDoc (`jsDoc`, `jsDocCache`:
//   comments are trivia here), NodeArray.hasTrailingComma, `multiLine` (a layout fact: whether
//   a newline was written inside a literal or block), `possiblyExhaustive` (binder), SourceFile
//   bookkeeping (fileName, text, languageVersion, identifiers, ...: no scalar is read on the
//   root). The root is a SourceFile with `statements` and `endOfFileToken`. The kept list was
//   audited against every own property tsc 5.9.3 sets on the conformance corpus's nodes.
// - files tsc reports PARSE errors for are skipped: its tree there is an error-recovery shape,
//   and recovery policy is out of contract (as in test/ts-ast-verify.ts).
import ts from 'tsc-oracle';
import type { NTree, NValue, Produced, Producer } from './shape-oracle.ts';

const KIND_NAME: string[] = [];
for (const [name, v] of Object.entries(ts.SyntaxKind)) if (typeof v === 'number' && KIND_NAME[v] === undefined) KIND_NAME[v] = name;
export const kindName = (k: number): string => KIND_NAME[k] ?? `SyntaxKind(${k})`;
/** Canonical SyntaxKind name for a name a candidate writes (an alias maps to the first name);
 * undefined for a name SyntaxKind does not have. */
export const canonicalKind = (name: string): string | undefined => {
  const v = (ts.SyntaxKind as unknown as Record<string, number>)[name];
  return v === undefined ? undefined : KIND_NAME[v];
};

const F = ts.NodeFlags;
const SYNTACTIC_FLAGS: [string, number][] = [
  ['Let', F.Let], ['Const', F.Const], ['Using', F.Using],
  ['Namespace', F.Namespace], ['NestedNamespace', F.NestedNamespace], ['GlobalAugmentation', F.GlobalAugmentation],
  ['OptionalChain', F.OptionalChain],
];
const flagNames = (f: number): string => SYNTACTIC_FLAGS.filter(([, m]) => (f & m) === m && m !== 0).map(([n]) => n).join('|');

/** Scalar properties kept, and how: 'kind' = a SyntaxKind number rendered as its name. */
const SCALARS: Record<string, 'value' | 'kind'> = {
  text: 'value', rawText: 'value', escapedText: 'value',
  numericLiteralFlags: 'value', templateFlags: 'value', hasExtendedUnicodeEscape: 'value', singleQuote: 'value', isUnterminated: 'value',
  operator: 'kind', token: 'kind', keywordToken: 'kind', phaseModifier: 'kind',
  isTypeOnly: 'value', isExportEquals: 'value', isTypeOf: 'value',
};

export function normaliseTs(n: ts.Node, sf: ts.SourceFile): NTree {
  const fields: Record<string, NValue> = {};
  const own = n as unknown as Record<string, unknown>;
  const nameOf = new Map<unknown, string>();
  for (const k of Object.keys(own)) if (k !== 'parent' && own[k] !== null && typeof own[k] === 'object') nameOf.set(own[k], k);
  const named = (v: unknown): string => {
    const k = nameOf.get(v);
    if (k === undefined) throw new Error(`tsc oracle: a ${kindName(n.kind)} child is held by no own property`);
    return k;
  };
  ts.forEachChild(n,
    (c) => { fields[named(c)] = normaliseTs(c, sf); },
    (cs) => { fields[named(cs)] = cs.map((c) => normaliseTs(c, sf)); });
  if (n.kind !== ts.SyntaxKind.SourceFile) for (const [k, how] of Object.entries(SCALARS)) {
    const v = own[k];
    if (v === undefined || (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')) continue;
    if (k === 'escapedText') { fields.text = ts.idText(n as ts.Identifier); continue; }
    if (k === 'numericLiteralFlags' || k === 'templateFlags') { if (v !== 0) fields[k] = v; continue; }
    fields[k] = how === 'kind' ? kindName(v as number) : v;
  }
  const fl = flagNames(n.flags);
  if (fl) fields.flags = fl;
  return { kind: kindName(n.kind), start: n.getStart(sf), end: n.end, pos: n.pos, fields };
}

export function parseTs(src: string, path = 'f.ts'): { sf: ts.SourceFile; errors: number } {
  const kind = /\.d\.ts$/.test(path) ? ts.ScriptKind.TS : /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);
  return { sf, errors: (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length };
}

/** tsc's tree of `src` in a view; skipped when tsc reports parse errors, failed when tsc's
 * parser itself throws (a Debug assertion on some conformance inputs). */
export function tscProduce(src: string, path: string, view: (sf: ts.SourceFile) => NTree): Produced {
  let r;
  try { r = parseTs(src, path); } catch (e) { return { fail: `tsc threw: ${(e as Error).message.slice(0, 60)}` }; }
  if (r.errors > 0) return { skip: `tsc reports ${r.errors} parse error(s) — recovery shapes are out of contract` };
  return { tree: view(r.sf) };
}

export const tscOracle: Producer = (src, path) => tscProduce(src, path, (sf) => normaliseTs(sf, sf));
