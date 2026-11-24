// What a shape covers of its grammar, and the starting spec for one: both read the grammar's
// NAMES (src/grammar-names.ts, through the static view src/shape2-eval.ts builds), since half of
// them are derived from the syntax and a user cannot write a shape without seeing them.
//
//   shapeCoverage(shape)      per (rule, arm): mapped or not, and whether evaluation from the
//                             grammar's entry rule can reach it (computed from the grammar and the
//                             spec, not from a corpus): a left-out arm that is reached throws
//                             ShapeUnmapped when an input holds it; one that is not is never
//                             evaluated from the root
//   coverageReport(coverage)  the same as text, each left-out arm with a skeleton term to paste
//   shapeSkeleton(grammar)    a complete, loadable `defineShape` source mapping every arm to a
//                             node named `Rule.arm` holding its named children: the CST as a
//                             shape, the file a user starts from and fills in
import type { CstGrammar } from './types.ts';
import { findEntryRule } from './grammar-analysis.ts';
import { cardOf, defineShape, type ArmInfo, type Card, type ScopeInfo, type Shape, type Slot, type SlotKind } from './shape2-eval.ts';
import { branch, child, map, node, text, type Term } from './shape2-schema.ts';

export type ChildInfo = { name: string; kind: SlotKind; card: Card; rule?: string };
export type ArmCoverage = {
  rule: string;
  arm: string;
  mapped: boolean;
  /** Evaluation from the entry rule can reach a node of this arm: its rule is a child that a
   * mapped arm reached from the entry reads (`child` / `get`, or a nodes equation). */
  reached: boolean;
  /** The arm's own named children (an inline alternation's branches hold more: see `skeleton`). */
  children: ChildInfo[];
  /** A term mapping the arm to a node `Rule.arm` of its named children (shapeSkeleton's). */
  skeleton: Term;
};
export type ShapeCoverage = { shape: string; grammar: string; entry: string; arms: ArmCoverage[] };

export function shapeCoverage(shape: Shape): ShapeCoverage {
  const { spec, grammar: g, source } = shape;
  const entry = findEntryRule(source);
  const nodesEqs = Object.values(spec.inherited ?? {}).filter((d) => d.type === 'nodes').map((d) => d.rules);
  // Rules reached from the entry: through the children each reached rule's MAPPED arms read.
  const reached = new Set<string>([entry]);
  const work = [entry];
  while (work.length) {
    const rule = work.pop()!;
    for (const a of g.arms.get(rule) ?? []) {
      const t = spec.rules[rule]?.[a.arm];
      if (t === undefined) continue;   // evaluation stops at an unmapped arm
      const names = new Set<string>();
      readsOf(t, names);
      for (const eqs of nodesEqs) readsOf(eqs[rule]?.[a.arm], names);
      for (const nm of names) for (const r of rulesNamed(a, nm)) if (!reached.has(r)) { reached.add(r); work.push(r); }
    }
  }
  const arms: ArmCoverage[] = [];
  for (const [rule, infos] of g.arms) for (const a of infos) {
    arms.push({
      rule, arm: a.arm, mapped: spec.rules[rule]?.[a.arm] !== undefined, reached: reached.has(rule),
      children: [...a.slots.values()].map((s) => ({ name: s.name, kind: s.kind, card: cardOf(s.quants), ...(s.rule ? { rule: s.rule } : {}) })),
      skeleton: skeletonOf(a, `${rule}.${a.arm}`),
    });
  }
  return { shape: spec.name, grammar: source.name ?? '(unnamed)', entry, arms };
}

/** The child names a term reads the VALUE of (`child`, `get`), anywhere in it. */
function readsOf(x: unknown, out: Set<string>): void {
  if (x === null || typeof x !== 'object') return;
  const t = x as { t?: string; name?: unknown };
  if ((t.t === 'child' || t.t === 'get') && typeof t.name === 'string') out.add(t.name);
  for (const v of Object.values(x)) readsOf(v, out);
}
/** The rules of every rule-node child named `name` in an arm's scopes (its branches included). */
function rulesNamed(scope: ScopeInfo, name: string): string[] {
  const out: string[] = [];
  for (const s of scope.slots.values()) {
    if (s.name === name && s.rule) out.push(s.rule);
    for (const b of s.branches?.values() ?? []) out.push(...rulesNamed(b, name));
  }
  return out;
}

/** A node `kind` of the scope's named children: a rule node by `child`, a leaf by its text, an
 * inline alternation by the branch taken (a node per branch, `kind.child.branch`); a repeated leaf
 * or alternation by a `map`. A branch's node spans the arm (a branch may hold no child to span). */
function skeletonOf(scope: ScopeInfo, kind: string): Term {
  const fields: Record<string, Term> = {};
  for (const s of scope.slots.values()) fields[s.name] = slotTerm(s, kind);
  return node(kind, fields);
}
function slotTerm(s: Slot, kind: string): Term {
  if (s.kind === 'node') return child(s.name);
  const one = s.kind === 'leaf' ? text(s.name)
    : branch(s.name, Object.fromEntries([...s.branches!].map(([bn, b]) => [bn, skeletonOf(b, `${kind}.${s.name}.${bn}`)])));
  return cardOf(s.quants) === 'many' ? map(s.name, one) : one;
}

// ── Text ──

const childText = (c: ChildInfo): string => `${c.name}: ${c.kind === 'node' ? c.rule : c.kind}${c.card === 'one' ? '' : c.card === 'opt' ? '?' : '[]'}`;
const armComment = (a: ArmCoverage): string => (a.children.length ? a.children.map(childText).join(', ') : 'no named children');

export function coverageReport(c: ShapeCoverage): string {
  const mapped = c.arms.filter((a) => a.mapped);
  const lines = [`shape ${JSON.stringify(c.shape)} on grammar ${JSON.stringify(c.grammar)} (entry rule ${c.entry}): ${mapped.length} of ${c.arms.length} arms mapped`];
  const byRule = (as: ArmCoverage[]): Map<string, ArmCoverage[]> => {
    const m = new Map<string, ArmCoverage[]>();
    for (const a of as) { if (!m.has(a.rule)) m.set(a.rule, []); m.get(a.rule)!.push(a); }
    return m;
  };
  lines.push('', 'mapped:');
  for (const [rule, as] of byRule(mapped)) lines.push(`  ${rule}: ${as.map((a) => a.arm).join(', ')}`);
  const reached = c.arms.filter((a) => !a.mapped && a.reached);
  lines.push('', `left out, reached from ${c.entry} (an input holding one throws ShapeUnmapped; a term to start from):`);
  if (!reached.length) lines.push('  none');
  for (const a of reached) lines.push(`  ${a.rule}.${a.arm}: ${termSource(a.skeleton)}   // ${armComment(a)}`);
  const unreached = c.arms.filter((a) => !a.mapped && !a.reached);
  lines.push('', `left out, not reached from ${c.entry} through the mapped arms (never evaluated from the root):`);
  if (!unreached.length) lines.push('  none');
  for (const [rule, as] of byRule(unreached)) lines.push(`  ${rule}: ${as.map((a) => a.arm).join(', ')}`);
  return lines.join('\n');
}

/** A complete `defineShape` module for `grammar` (imported from `grammarImport`): every arm mapped
 * to its skeleton term, with its named children in a comment. It loads as it is (test/shape2-eval.ts). */
/** Node keys no field of these terms takes: kind / start / end, each `$`-prefixed while a field has
 * the name (a skeleton's fields are the grammar's names, and `kind` is one of them in JavaScript). */
export function freeNodeKeys(terms: Term[]): { kind: string; start: string; end: string } {
  const used = new Set<string>();
  const fieldsOf = (t: unknown): void => {
    if (t === null || typeof t !== 'object') return;
    if ((t as Term).t === 'node') for (const k of Object.keys((t as { fields: object }).fields)) used.add(k);
    Object.values(t).forEach(fieldsOf);
  };
  terms.forEach(fieldsOf);
  const key = (k: string): string => { let x = k; while (used.has(x)) x = '$' + x; return x; };
  return { kind: key('kind'), start: key('start'), end: key('end') };
}

export function shapeSkeleton(grammar: CstGrammar, grammarImport: string): string {
  const c = shapeCoverage(defineShape(grammar, { name: `${grammar.name ?? 'grammar'}-skeleton`, rules: {} }));
  const out = [
    `import grammar from '${grammarImport}';`,
    `import { defineShape, branch, child, map, node, text } from 'monogram/shape';`,
    '',
    '// Every arm of the grammar, mapped to a node `Rule.arm` of its named children (the CST as a',
    '// shape). Replace each term with your node; an arm you delete is left out (see --shape).',
    `export default defineShape(grammar, {`,
    `  name: '${grammar.name ?? 'grammar'}-shape',`,
  ];
  const keys = freeNodeKeys(c.arms.map((a) => a.skeleton));
  if (keys.kind !== 'kind' || keys.start !== 'start' || keys.end !== 'end') out.push(`  node: { kind: '${keys.kind}', start: '${keys.start}', end: '${keys.end}' },`);
  out.push('  rules: {');
  let rule = '';
  for (const a of c.arms) {
    if (a.rule !== rule) { if (rule) out.push('    },'); out.push(`    ${a.rule}: {`); rule = a.rule; }
    out.push(`      ${a.arm}: ${termSource(a.skeleton)},   // ${armComment(a)}`);
  }
  if (rule) out.push('    },');
  out.push('  },', '});', '');
  return out.join('\n');
}

/** A term as the constructor calls of src/shape2-schema.ts that build it (the skeleton's terms). */
export function termSource(t: Term): string {
  const s = (x: unknown): string => (typeof x === 'string' ? `'${x.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(x));
  const rec = (r: Record<string, Term>): string => {
    const es = Object.entries(r);
    return es.length ? `{ ${es.map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : s(k)}: ${termSource(v)}`).join(', ')} }` : '{}';
  };
  switch (t.t) {
    case 'node': return t.type.t === 'const' ? `node(${s(t.type.value)}, ${rec(t.fields)})` : `node(${termSource(t.type)}, ${rec(t.fields)})`;
    case 'child': return `child(${s(t.name)})`;
    case 'text': return t.name === undefined ? 'text()' : `text(${s(t.name)})`;
    case 'map': return `map(${s(t.over)}, ${termSource(t.body)})`;
    case 'branch': return `branch(${s(t.name)}, ${rec(t.cases)})`;
    case 'const': return `c(${s(t.value)})`;
    default: throw new Error(`termSource: ${t.t} is not a skeleton term`);
  }
}
