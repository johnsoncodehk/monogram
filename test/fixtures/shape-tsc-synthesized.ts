// The tsc expression shape's SYNTHESIZED SUBSET: test/fixtures/shape-v2-tsc-expr.ts with every
// inherited attribute at its ROOT DEFAULT (what a node gets from a parent without an equation): a
// scalar attribute's read is its default constant (`chainTop` true, `heritageElement` false), the
// nodes attribute `modifiers` is the empty list (a receiver keeps only its own modifiers), and the
// conditions that become constant are folded. So `led_bang`'s flags are absent, a heritage
// clause's element is its expression, an exported declaration carries only its own words. What a
// parser that builds no inherited context yet builds (the typed Rust target, src/rust-shape.ts):
// test/shape-typed-rust.ts checks it ≡ the evaluator, and the profile's `shape` row measures it.
import typescript from '../../typescript.ts';
import { defineShape } from '../../src/shape2-eval.ts';
import type { ShapeSpec, Term } from '../../src/shape2-schema.ts';
import { tscExprShape } from './shape-v2-tsc-expr.ts';

const spec = tscExprShape.spec as ShapeSpec;
const inh = spec.inherited ?? {};
const K = (value: string | number | boolean | null): Term => ({ t: 'const', value });
/** `t` with every inherited attribute at its default; `empty`: variables bound to the empty nodes list. */
function atDefaults(t: Term, empty: Set<string>): Term {
  const r = (x: Term): Term => atDefaults(x, empty);
  switch (t.t) {
    case 'inh': { const d = inh[t.attr]!; return d.type === 'nodes' ? { t: 'list', items: [] } : K(d.default); }
    case 'let': {
      if (t.value.t === 'inh' && inh[t.value.attr]?.type === 'nodes') return atDefaults(t.body, new Set([...empty, t.name]));
      const inner = new Set([...empty].filter((n) => n !== t.name));
      return { ...t, value: r(t.value), body: atDefaults(t.body, inner) };
    }
    case 'present': return empty.has(t.name) ? K(false) : t;
    case 'var': return empty.has(t.name) ? { t: 'list', items: [] } : t;
    case 'list': return { t: 'list', items: t.items.flatMap((x) => (x !== null && typeof x === 'object' && 'spread' in x ? (x.spread.t === 'var' && empty.has(x.spread.name) ? [] : [{ spread: r(x.spread) }]) : [r(x as Term)])) };
    case 'not': { const a = r(t.arg); return a.t === 'const' ? K(!a.value) : { t: 'not', arg: a }; }
    case 'and': case 'or': {
      const args = t.args.map(r);
      const stop = t.t === 'and' ? false : true;
      if (args.some((a) => a.t === 'const' && a.value === stop)) return K(stop);
      const rest = args.filter((a) => a.t !== 'const');
      return rest.length === 0 ? K(!stop) : rest.length === 1 ? rest[0]! : { t: t.t, args: rest };
    }
    case 'if': { const c = r(t.cond); return c.t === 'const' ? r(c.value ? t.then : t.else) : { t: 'if', cond: c, then: r(t.then), else: r(t.else) }; }
    default: {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(t)) out[k] = mapTerms(v, r);
      return out as Term;
    }
  }
}
function mapTerms(v: unknown, f: (t: Term) => Term): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => mapTerms(x, f));
  if (typeof (v as { t?: unknown }).t === 'string') return f(v as Term);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapTerms(x, f)]));
}
const rules: ShapeSpec['rules'] = Object.fromEntries(Object.entries(spec.rules).map(([rule, arms]) => [rule, Object.fromEntries(Object.entries(arms!).map(([arm, term]) => [arm, atDefaults(term, new Set())]))]));
const synthesized = Object.fromEntries(Object.entries(spec.synthesized ?? {}).map(([a, d]) => [a, { ...d, rules: Object.fromEntries(Object.entries(d.rules).map(([rule, arms]) => [rule, Object.fromEntries(Object.entries(arms!).map(([arm, term]) => [arm, atDefaults(term, new Set())]))])) }]));
export default defineShape(typescript, { ...spec, name: 'tsc-expr-synthesized', inherited: undefined, synthesized, rules });
