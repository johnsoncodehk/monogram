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
//
// EVERY READER AND WRITER OF THE FORM'S LOW BITS (FORM_LOW), the one list to extend when a new
// mechanism writes FORM_TARGET / FORM_NOT_TARGET / FORM_UNARY or tests them: with contexts
// declared a reader compares `form & 3` (target-ts.ts lowTs, target-go.ts lowGo, target-rust.ts
// lowRs), a writer ORs the arm's leaf / last bits in (ArmForm, PrattRule.ledForm / postForm /
// binForm / preLeaf). Readers: the prefix operand's requireTarget test (nudPrefix, commitPrefix),
// the postfix operator's (postfixOp), the binary operator's requireTarget and noUnaryLhs tests
// (binary). Writers: every NUD arm (nudLeaf, nudTpl, nudSeq, commitLeaf, commitSeq: `fm`; a prefix-shaped bracket / sequence arm, ending in an `atLevel` operand, has FORM_UNARY low bits: PrattRule.nudBracketForm / nudSeqForm, emit-portable nudLowForm), the
// prefix node (PrattOpTables pre.form), every led (ledForm), a postfix token / template arm
// (postfixTokForm), the postfix operator node (postForm), the binary node (binForm), an rd rule of
// the closure (altForm). Not yet: the recovery encoding (recoveryTables refuses contexts) and the
// typed-AST forms (they refuse them by name). The interpreter computes the predicate as a CST walk
// (declared-targets-cst.ts), not from these bits.
import type { CstGrammar } from './types.ts';
import type { RuleIR, Step, RdRule, PrattRule, TargetsIR, DemandTwin } from './emit-portable.ts';
import { formPass, formLast, FORM_MAX_CONTEXTS, nudLowForm, DEFER_SHIFT, DEMAND_ASSIGNED, DEMAND_MAX_TWINS } from './emit-portable.ts';

// acc: init, the bits the arm starts from (its container contexts' pass bits and its leaf bits); low,
// its FORM_LOW bits; last, its last bits (kept where it passes).
export type ArmForm = { k: 'const'; v: number } | { k: 'unit' } | { k: 'acc'; init: number; low: number; last: number };

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
  if (names.some((n) => decl[n]!.when === 'demand')) return planDemand(grammar, rules, names);
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
    // a sep's delimiter: each element after one clears a pending last child (its first, none)
    for (const s of walk(steps)) if (s.t === 'sep' && s.delim === ',' && (role.acc & lastCtx) !== 0 && [...walk([s.elem])].some((x) => (x.t === 'rule' || x.t === 'ruleBp') && x.acc !== undefined)) s.accSep = true;
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
      return { k: 'acc', init: role.acc | role.leaf, low, last: role.last };
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
        case 'bracket': return armForm(r.name, arm, r.nudBrackets[n.index]!.steps, r.nudBracketForm[n.index]!);   // FORM_UNARY when prefix-shaped
        case 'seq': return armForm(r.name, arm, r.nudSeqs[n.index]!, r.nudSeqForm[n.index]!);
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
      // The binary node's arm is the operator form (opNames.binary, every operator) or one
      // operator, named by its text as the IR names operators (`=`: ECMAScript's AssignmentElement).
      const leftOf = (arm: string, role: Role): number => {
        let m = 0;
        for (const [i, field] of role.field) {
          if (field !== 'left') throw new Error(`targets: the binary node ${arm} of rule ${r.name} is a container only of its left operand ('left'), not ${field}`);
          m |= formPass(i);
        }
        return m;
      };
      const bin = roles.get(r.opNames.binary);
      if (bin) used.add(r.opNames.binary);
      r.binForm = { leaf: bin ? bin.leaf | bin.last : 0, accLeft: bin ? leftOf(r.opNames.binary, bin) : 0 };
      for (const b of r.binary) {
        const own = roles.get(b.op);
        if (own) { used.add(b.op); b.accLeft = leftOf(b.op, own); if (own.leaf | own.last) throw new Error(`targets: operator ${b.op} of rule ${r.name} as a leaf: name the operator form ${r.opNames.binary}`); }
      }
      const post = roles.get(r.opNames.postfix), pre = roles.get(r.opNames.prefix);
      if (post) used.add(r.opNames.postfix);
      if ((post?.acc ?? 0) !== 0 || (pre?.acc ?? 0) !== 0) throw new Error(`targets: a prefix / postfix operator form of rule ${r.name} as a container is not supported`);
      r.postForm = 1 | (post ? post.leaf | post.last : 0);
      r.preLeaf = pre ? pre.leaf | pre.last : 0;
      for (const b of r.binary) {
        const ctx = grammarOpCtx(grammar, b.op);
        if (ctx !== undefined) b.needCtx = formPass(ctxIndex(ctx));
        b.accLeft = (b.accLeft ?? 0) | r.binForm.accLeft;
      }
    }
  }
  // the closure: rd rules whose form a container or a target step reads, and unit arms' rules
  // A target step reads the form of the LAST RULE CALL before it (the engine's form register;
  // the interpreter's last node). `prev` is that rule when it is known statically and nothing
  // between it and here can have run another rule call: literals and token-set lookaheads keep
  // it; a sequence, `exclude` or context wrapper passes it through to its end; an `opt` body
  // and the branches of an alternation whose branches all begin with pairwise-disjoint literals
  // (at most one gets past its first step) inherit it; anything else (a repetition, a token, a
  // rule lookahead, another alternation, the step after an `opt`) leaves it unknown.
  const leadLits = (b: Step[]): string[] | null => {
    const s = b[0];
    return s?.t === 'lit' ? [s.value] : s?.t === 'altlit' ? s.opts.map((o) => o.value) : null;
  };
  const disjointLeads = (bs: Step[][]): boolean => {
    const seen = new Set<string>();
    for (const b of bs) {
      const l = leadLits(b);
      if (l === null) return false;
      for (const v of l) { if (seen.has(v)) return false; seen.add(v); }
    }
    return true;
  };
  const before = (steps: Step[], prevIn: string | null): string | null => {
    let prev = prevIn;
    for (const s of steps) {
      switch (s.t) {
        case 'target':
          if (prev === null) throw new Error(`targets: target('${s.ctx}') must follow a rule reference (with only literals between, in its sequence or the one enclosing its opt / alternation branch)`);
          need(prev);
          break;
        case 'rule': case 'ruleBp': prev = s.name; break;
        case 'lit': case 'altlit': case 'ahead': case 'aheadCtx': case 'sameLine': break;
        case 'seq': case 'suppress': case 'ctx': prev = before(s.steps, prev); break;
        case 'opt': before(s.steps, prev); prev = null; break;
        case 'alt': { const inherit = disjointLeads(s.branches) ? prev : null; s.branches.forEach((b) => before(b, inherit)); prev = null; break; }
        case 'star': before([s.step], null); prev = null; break;
        case 'sep': before([s.elem], null); prev = null; break;
        default: prev = null; break;
      }
    }
    return prev;
  };
  for (const r of ir.rules) for (const b of bodies(r)) before(b, null);
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

// THE ON-DEMAND FORM (TargetContext.when 'demand'; emit-portable.ts DemandIR). The normal parse
// computes nothing: every arm keeps the form it has without contexts, a container arm adds its
// twin's number (a constant), a demand operator's node ASSIGNED. Its twins are the EAGER plan of
// the same context, made on a copy of the rules: each container arm's steps and each rd rule of
// the eager closure, accumulating, and printed only to be run by a re-parse. So the shallow check
// must take exactly the arms the context passes as they are: in every Pratt rule a twin reads (and
// the demand operators' own), an arm the shallow check takes (FORM_TARGET low bits, not capped) is
// a leaf or a container, and a leaf is such an arm; anything else is refused by name.
function planDemand(grammar: CstGrammar, rules: RuleIR[], names: string[]): TargetsIR {
  const ctx = names[0]!;
  const c = grammar.targets![ctx]!;
  if (names.length !== 1) throw new Error(`targets: the demand context ${ctx} must be the grammar's only context (declared: ${names.join(', ')})`);
  for (const r of rules) for (const b of bodies(r)) for (const s of walk(b)) {
    if (s.t === 'target') throw new Error(`targets: the demand context ${ctx} is read by a target('${s.ctx}') marker in rule ${r.name}: a marker reads the form the normal parse computes (declare it eager)`);
  }
  const clones = structuredClone(rules) as RuleIR[];
  const eager = planTargets({ ...grammar, targets: { [ctx]: { ...c, when: 'eager' } } }, clones)!;
  const kindOf = new Map(clones.map((r) => [r.name, r.kind] as const));
  const twins: DemandTwin[] = [];
  for (const r of clones) {
    if (r.kind !== 'pratt') continue;
    r.nudForm!.forEach((f, i) => {
      if (f.k !== 'acc') return;
      const n = r.nudOrder[i]!;
      const steps = n.kind === 'bracket' ? r.nudBrackets[n.index]!.steps : n.kind === 'seq' ? r.nudSeqs[n.index]! : n.kind === 'capped' ? r.nudCapped[n.index]!.steps : null;
      if (steps === null) throw new Error(`targets: container ${r.nudNames[i]} of rule ${r.name} has no steps`);
      twins.push({ k: twins.length, rule: r.name, arm: r.nudNames[i]!, steps, form: f });
    });
  }
  if (twins.length > DEMAND_MAX_TWINS) throw new Error(`targets: the demand context ${ctx} has ${twins.length} container arms; the form numbers at most ${DEMAND_MAX_TWINS}`);
  const rd = clones.filter((r): r is RdRule => r.kind === 'rd' && r.altForm !== undefined);
  const twinRd = new Set(rd.map((r) => r.name));
  const fix = new Set<string>();
  const readAt = (s: Step & { t: 'rule' | 'ruleBp' }) => { s.dfix = s.name; fix.add(s.name); };
  // A twin calls the twins of the closure's rd rules, and reads a Pratt child's form (dfix).
  const rewrite = (steps: Step[]): void => {
    for (const s of walk(steps)) {
      delete (s as { share?: number }).share;
      if (s.t !== 'rule' && s.t !== 'ruleBp') continue;
      if (twinRd.has(s.name)) s.name = `${s.name}__twin`;
      else if (s.acc !== undefined && kindOf.get(s.name) === 'pratt') readAt(s);
    }
  };
  for (const r of rd) {
    r.alts.forEach((alt, i) => {
      if (r.altForm![i]!.k !== 'unit') return;
      const u = unitStep(alt)!;
      if (kindOf.get(u.name) === 'pratt') readAt(u);
    });
    r.alts.forEach(rewrite);
    r.twinOf = r.name;
    r.name = `${r.name}__twin`;
  }
  for (const t of twins) rewrite(t.steps);
  // The real rules: each container arm's twin number, the demand operators.
  const byName = new Map(rules.map((r) => [r.name, r] as const));
  const ops: Array<{ rule: string; op: string }> = [];
  for (const r of rules) {
    if (r.kind !== 'pratt') continue;
    const mine = twins.filter((t) => t.rule === r.name);
    if (mine.length) r.nudForm = r.nudOrder.map((_, i) => { const t = mine.find((x) => x.arm === r.nudNames[i]); return { k: 'const', v: nudLowForm(r, i) | (t ? (t.k + 1) << DEFER_SHIFT : 0) }; });
    for (const b of r.binary) if (grammarOpCtx(grammar, b.op) === ctx) { b.requireTarget = true; ops.push({ rule: r.name, op: b.op }); }
  }
  if (ops.length === 0) throw new Error(`targets: no targetOps operator reads the demand context ${ctx}`);
  const leaf = new Set(c.leaves), cont = new Set(Object.keys(c.containers ?? {}));
  for (const a of c.last ?? []) if (!cont.has(a)) throw new Error(`targets: the last arm ${a} of the demand context ${ctx} must be a container (a leaf keeps the form it has without contexts)`);
  for (const name of new Set([...fix, ...ops.map((o) => o.rule)])) {
    const r = byName.get(name) as PrattRule;
    const check = (arm: string, shallow: boolean, capped: boolean): void => {
      const why = cont.has(arm) ? (shallow ? null : 'is a container the shallow check refuses')
        : leaf.has(arm) ? (!shallow ? 'is a leaf the shallow check refuses' : capped ? 'is a leaf that may be capped (a twin reads a capped node as no target)' : null)
        : shallow && !capped ? 'is taken by the shallow check but is no leaf or container' : null;
      if (why) throw new Error(`targets: arm ${arm} of rule ${r.name} ${why} of the demand context ${ctx}: its leaves must be the arms the shallow check takes`);
    };
    r.nudOrder.forEach((n, i) => {
      const capped = n.kind === 'capped' || (n.kind === 'bracket' && r.nudBracketCapsFromTail[n.index]!) || (n.kind === 'seq' && r.nudSeqCapsFromTail[n.index]!);
      check(r.nudNames[i]!, n.kind !== 'prefix' && nudLowForm(r, i) === 0, capped);
    });
    r.leds.forEach((_, i) => check(r.ledNames[i]!, (r.ledForm[i]! & 3) === 0, r.ledCapsFromTail[i]!));
    r.postfixTokNames.forEach((arm) => check(arm, true, false));
    if (r.opNames) { check(r.opNames.binary, false, false); check(r.opNames.postfix, false, false); }
  }
  return { names, passes: eager.passes, lastCtx: eager.lastCtx, demand: { pass: formPass(0), assigned: DEMAND_ASSIGNED, defer: 7 << DEFER_SHIFT, twins, rd, fix: [...fix], ops } };
}

/** The one rule-call step of a unit arm (unitCall's step). */
function unitStep(steps: Step[]): (Step & { t: 'rule' | 'ruleBp' }) | null {
  const own = steps.filter((s) => !ZERO_WIDTH.has(s.t));
  if (own.length !== 1) return null;
  const s = own[0]!;
  return s.t === 'rule' || s.t === 'ruleBp' ? s : s.t === 'seq' ? unitStep(s.steps) : null;
}
