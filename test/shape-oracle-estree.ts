// The ESTree oracle: acorn (8.16.0, in node_modules) on JavaScript, its tree NORMALISED into
// the harness's NTree (test/shape-oracle.ts). The normalisation, declared in one place:
//
// - kind = `type`, start / end = acorn's offsets (UTF-16, trivia excluded); no `pos`.
// - fields: every other own property, in acorn's order (the harness compares them by name):
//   a node is a node, an array a list (a hole of an ArrayExpression / ArrayPattern is null),
//   a plain object a record (`regex: { pattern, flags }`), a primitive a scalar.
// - Literal.value: a RegExp becomes null (ESTree: "null if the regex cannot be represented";
//   the `regex` record carries it), a bigint becomes its decimal text + 'n' (the `bigint`
//   field carries the digits): both have no JSON form otherwise.
// - dropped: `loc`, `range` (not requested), and nothing else. Comments are not in the tree.
// - parse goal: Module first, then Script; a file acorn rejects in both is SKIPPED (not JS by
//   the specification). The goal used is recorded as Program.sourceType.
// - ecmaVersion 'latest'. TypeScript-only syntax has no oracle here: `@typescript-eslint/
//   typescript-estree` is not installed (no dependency is added); it would add the TSESTree
//   node set (TS* types, typeAnnotation / returnType / typeParameters fields, `declare`,
//   `accessibility`, `optional` ...) checked against TypeScript inputs.
import * as acorn from 'acorn';
import type { NTree, NValue, Producer } from './shape-oracle.ts';

export const ACORN_VERSION: string = acorn.version;

type AcornNode = { type: string; start: number; end: number; [k: string]: unknown };
const DROP = new Set(['type', 'start', 'end', 'loc', 'range']);

function value(v: unknown, owner: string, key: string): NValue {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => value(x, owner, key));
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof RegExp) return null;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.type === 'string' && typeof o.start === 'number') return normaliseEstree(o as AcornNode);
    const record: Record<string, NValue> = {};
    for (const [k, x] of Object.entries(o)) record[k] = value(x, owner, k);
    return { record };
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  throw new Error(`estree oracle: unexpected ${typeof v} at ${owner}.${key}`);
}

export function normaliseEstree(n: AcornNode): NTree {
  const fields: Record<string, NValue> = {};
  for (const [k, v] of Object.entries(n)) if (!DROP.has(k)) fields[k] = value(v, n.type, k);
  return { kind: n.type, start: n.start, end: n.end, fields };
}

export function parseEstree(src: string): { tree: AcornNode; goal: 'module' | 'script' } | null {
  for (const goal of ['module', 'script'] as const) {
    try { return { tree: acorn.parse(src, { ecmaVersion: 'latest', sourceType: goal }) as unknown as AcornNode, goal }; }
    catch { /* try the next goal */ }
  }
  return null;
}

export const estreeOracle: Producer = (src) => {
  const r = parseEstree(src);
  if (!r) return { skip: 'acorn rejects it as Module and as Script' };
  return { tree: normaliseEstree(r.tree) };
};
