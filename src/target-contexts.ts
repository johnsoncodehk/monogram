// DECLARED ASSIGNMENT-TARGET CONTEXTS (CstGrammar.targets), planned onto the portable IR.
//
// A context is a predicate over nodes: a node passes iff its arm is one of the context's leaves,
// or one of its containers whose named children all pass; a node of one child and nothing else
// (a unit arm: one rule call) is its child; a `last` arm passes as a container's child only as
// the final child with no ',' after it. The engine computes it as a SYNTHESIZED ATTRIBUTE in the
// form it already returns from every Pratt call (`_form`, FORM_*): the low two bits keep their
// meaning (FORM_LOW), and context i has a PASS bit and a LAST bit above them (formPass, formLast).
// So a head is parsed once and checked only where a target is taken: a `target(ctx)` step tests
// the pass bit of the node just returned, a `targetOps` operator that of its left operand.
//
// What each arm contributes is decided here, once, for every target:
// - a leaf arm (and every arm of no context): a constant (ArmForm 'const'); a Pratt arm keeps its
//   low bits and adds the pass bits of the contexts it is a leaf of (and their last bits);
// - a container arm ('acc'): it starts from its contexts' pass bits and every rule call at a named
//   child (Step.acc: the pass bits that child must have) clears the bits the child's form lacks;
//   in a context with `last` arms, a ',' of the arm (Step.accSep) or a later child after a child
//   whose form has the last bit clears that context's pass bit;
// - a unit arm ('unit'): the form its one call returned.
// An rd rule computes its form only when it is in the TARGET CLOSURE: the rules a container calls
// at a named child or a target step reads, and the unit arms' rules of those, transitively; a
// Pratt rule always computes one. A grammar that declares no context gets none of this: the plan
// is absent and every printer prints what it printed before.
import type { CstGrammar } from './types.ts';
import type { RuleIR, Step, RdRule, PrattRule, TargetsIR } from './emit-portable.ts';
import { formPass, formLast, FORM_MAX_CONTEXTS } from './emit-portable.ts';

export type ArmForm = { k: 'const'; v: number } | { k: 'unit' } | { k: 'acc'; init: number; last: number };

type Role = { leaf: number; acc: number; field: Map<number, string>; last: number };

const ZERO_WIDTH = new Set<Step['t']>(['look', 'ahead', 'aheadCtx', 'sameLine', 'target']);

/** Every step inside a step list, outermost first (a `look` body is a lookahead of its own). */
function* walk(steps: Step[]): Generator<Step> {
  for (const s of steps) {
    yield s;
    switch (s.t) {
      case 'star': yield* walk([s.step]); break;
      case 'sep': yield* walk([s.elem]); break;
      case 'opt': case 'seq': case 'suppress': case 'ctx': yield* walk(s.steps); break;
      case 'alt': for (const b of s.branches) yield* walk(b); break;
      default: break;
    }
  }
}

/** The one rule an arm calls when it is a unit arm (one rule call and nothing else), else null. */
function unitCall(steps: Step[]): string | null {
  const own = steps.filter((s) => !ZERO_WIDTH.has(s.t));
  if (own.length !== 1) return null;
  const s = own[0]!;
  return s.t === 'rule' || s.t === 'ruleBp' ? s.name : s.t === 'seq' ? unitCall(s.steps) : null;
}

/** Plan the grammar's declared target contexts onto its rules (in place); null without `targets`. */
export function planTargets(grammar: CstGrammar, rules: RuleIR[]): TargetsIR | null {
  const decl = grammar.targets;
  if (decl === undefined) return null;
  const names = Object.keys(decl);
  if (names.length === 0) return null;
  const ir = { rules };
  if (names.length > FORM_MAX_CONTEXTS) throw new Error(`targets: ${names.length} contexts declared (${names.join(', ')}); the engine's form holds at most ${FORM_MAX_CONTEXTS}`);
  let passes = 0;
  names.forEach((_, i) => { passes |= formPass(i); });
  // arm name -> its role in every context
  const roles = new Map<string, Role>();
  const roleOf = (arm: string): Role => {
    let r = roles.get(arm);
    if (!r) { r = { leaf: 0, acc: 0, field: new Map(), last: 0 }; roles.set(arm, r); }
    return r;
  };
  names.forEach((n, i) => {
    const c = decl[n]!;
    for (const arm of c.leaves) roleOf(arm).leaf |= formPass(i);
    for (const [arm, field] of Object.entries(c.containers ?? {})) { const r = roleOf(arm); r.acc |= formPass(i); r.field.set(i, field); }
    for (const arm of c.last ?? []) roleOf(arm).last |= formLast(i);
    for (const arm of [...c.leaves, ...Object.keys(c.containers ?? {})]) {
      const r = roleOf(arm);
      if ((r.leaf & r.acc) !== 0) throw new Error(`targets: arm ${arm} is both a leaf and a container of context ${n}`);
    }
  });
  const used = new Set<string>();
  const ctxIndex = (ctx: string): number => {
    const i = names.indexOf(ctx);
    if (i < 0) throw new Error(`targets: no context named ${ctx} (declared: ${names.join(', ')})`);
    return i;
  };
  const byName = new Map(ir.rules.map((r) => [r.name, r] as const));
  const closure = new Set<string>();
  const need = (rule: string) => { const r = byName.get(rule); if (r && r.kind === 'rd') closure.add(rule); };

  // The steps of a container arm: mark each rule call at a named child (and ',' where `last` reads it).
  const lastCtx = names.reduce((m, n, i) => ((decl[n]!.last ?? []).length ? m | formPass(i) : m), 0);
  const markAcc = (rule: string, arm: string, steps: Step[], role: Role): void => {
    for (const s of walk(steps)) {
      if (s.t === 'rule' || s.t === 'ruleBp') {
        let m = 0;
        for (const [i, field] of role.field) if (field === 'all' || field === s.field) m |= formPass(i);
        if (m !== 0) { s.acc = m; need(s.name); }
      } else if (s.t === 'lit' && s.value === ',' && (role.acc & lastCtx) !== 0) s.accSep = true;
    }
    for (const [i, field] of role.field) {
      if (field === 'all') continue;
      if (![...walk(steps)].some((s) => (s.t === 'rule' || s.t === 'ruleBp') && s.field === field)) {
        throw new Error(`targets: container ${arm} of context ${names[i]} names child ${field}, which arm ${arm} of rule ${rule} does not call as a rule`);
      }
    }
  };
  const armForm = (rule: string, arm: string, steps: Step[] | null, low: number): ArmForm => {
    const role = roles.get(arm);
    if (role) used.add(arm);
    if (role && role.acc !== 0) {
      if (steps === null) throw new Error(`targets: arm ${arm} of rule ${rule} is a container but has no steps of its own (an operator form)`);
      markAcc(rule, arm, steps, role);
      return { k: 'acc', init: low | role.acc | role.leaf, last: role.last };
    }
    if (role) return { k: 'const', v: low | role.leaf | role.last };
    const u = steps === null ? null : unitCall(steps);
    if (u !== null) return { k: 'unit' };
    return { k: 'const', v: low };
  };
  // target steps: what they read is the rule just before them (checked statically)
  const markTargets = (steps: Step[]): void => {
    for (const s of walk(steps)) if (s.t === 'target') s.mask = formPass(ctxIndex(s.ctx));
  };

  for (const r of ir.rules) {
    if (r.kind === 'rd') {
      r.altForm = r.alts.map((alt, i) => armForm(r.name, r.altNames[i]!, alt, 1));
      r.alts.forEach(markTargets);
    } else planPratt(r);
  }
  function planPratt(r: PrattRule): void {
    r.nudForm = r.nudOrder.map((n, i) => {
      const arm = r.nudNames[i]!;
      switch (n.kind) {
        case 'tok': return armForm(r.name, arm, null, 0);
        case 'bracket': return armForm(r.name, arm, r.nudBrackets[n.index]!.steps, 0);
        case 'seq': return armForm(r.name, arm, r.nudSeqs[n.index]!, 0);
        case 'capped': return armForm(r.name, arm, r.nudCapped[n.index]!.steps, 0);
        case 'prefix': return armForm(r.name, arm, null, 0);   // its low bits are the operator's (PrattRule.prefix form)
      }
    });
    for (const b of [...r.nudBrackets.map((x) => x.steps), ...r.nudSeqs, ...r.nudCapped.map((x) => x.steps), ...r.leds.map((x) => x.steps)]) markTargets(b);
    r.ledForm = r.leds.map((l, i) => {
      const f = armForm(r.name, r.ledNames[i]!, null, r.ledForm[i]!);
      if (f.k !== 'const') throw new Error(`targets: led ${r.ledNames[i]} of rule ${r.name} as a container is not supported`);
      return f.v;
    });
    r.postfixTokForm = r.postfixTokNames.map((arm) => { const f = armForm(r.name, arm, null, 0); return f.k === 'const' ? f.v : 0; });
    if (r.opNames) {
      const bin = roles.get(r.opNames.binary);
      if (bin) used.add(r.opNames.binary);
      let accLeft = 0;
      for (const [i, field] of bin?.field ?? []) {
        if (field !== 'left') throw new Error(`targets: the operator form ${r.opNames.binary} of rule ${r.name} is a container only of its left operand ('left'), not ${field}`);
        accLeft |= formPass(i);
      }
      r.binForm = { leaf: bin ? bin.leaf | bin.last : 0, accLeft };
      const post = roles.get(r.opNames.postfix), pre = roles.get(r.opNames.prefix);
      if (post) used.add(r.opNames.postfix);
      if ((post?.acc ?? 0) !== 0 || (pre?.acc ?? 0) !== 0) throw new Error(`targets: a prefix / postfix operator form of rule ${r.name} as a container is not supported`);
      r.postForm = 1 | (post ? post.leaf | post.last : 0);
      r.preLeaf = pre ? pre.leaf | pre.last : 0;
      for (const b of r.binary) {
        const ctx = grammarOpCtx(grammar, b.op);
        if (ctx !== undefined) b.needCtx = formPass(ctxIndex(ctx));
      }
    }
  }
  // the closure: rd rules whose form a container or a target step reads, and unit arms' rules
  const before = (steps: Step[]): void => {
    steps.forEach((s, k) => {
      if (s.t !== 'target') return;
      const p = steps[k - 1];
      if (p === undefined || (p.t !== 'rule' && p.t !== 'ruleBp')) throw new Error(`targets: target('${s.ctx}') must follow a rule reference in its sequence`);
      need(p.name);
    });
    for (const s of steps) {
      if (s.t === 'star') before([s.step]); else if (s.t === 'sep') before([s.elem]);
      else if (s.t === 'opt' || s.t === 'seq' || s.t === 'suppress' || s.t === 'ctx') before(s.steps);
      else if (s.t === 'alt') s.branches.forEach(before);
    }
  };
  for (const r of ir.rules) for (const b of bodies(r)) before(b);
  for (let grew = true; grew;) {
    grew = false;
    for (const name of [...closure]) {
      const r = byName.get(name) as RdRule;
      r.alts.forEach((alt, i) => {
        if (r.altForm![i]!.k !== 'unit') return;
        const u = unitCall(alt)!;
        const t = byName.get(u);
        if (t && t.kind === 'rd' && !closure.has(u)) { closure.add(u); grew = true; }
      });
    }
  }
  for (const r of ir.rules) if (r.kind === 'rd' && !closure.has(r.name)) delete r.altForm;
  const unknown = [...roles.keys()].filter((arm) => !used.has(arm));
  if (unknown.length) throw new Error(`targets: no arm named ${unknown.join(', ')} in the grammar`);
  return { names, passes, lastCtx };
}

function bodies(r: RuleIR): Step[][] {
  return r.kind === 'rd' ? r.alts : [...r.nudBrackets.map((x) => x.steps), ...r.nudSeqs, ...r.nudCapped.map((x) => x.steps), ...r.leds.map((x) => x.steps)];
}

function grammarOpCtx(g: CstGrammar, op: string): string | undefined {
  for (const level of g.precs) for (const o of level.operators) if (o.value === op && o.position === 'infix' && o.targetCtx !== undefined) return o.targetCtx;
  return undefined;
}
