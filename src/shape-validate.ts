/**
 * Shape validator — checks ShapeSpec against portable IR.
 */
import { portableIR } from './emit-portable.ts';
import type { ParserIR, RuleIR, Step, Alt, RdRule, PrattRule } from './emit-portable.ts';
import type {
  ShapeSpec, ShapeIR, ShapeIRRule, ShapeDiag, RuleShape, NodeShape, ChoiceShape,
  PrattShape, FieldDecl, TokenLeafPolicy,
} from './shape-schema.ts';
import type { CstGrammar } from './types.ts';

export type ValidateResult = { ok: boolean; ir: ShapeIR; errors: ShapeDiag[]; warns: ShapeDiag[] };

type Slot =
  | { k: 'leaf'; ttype: string; text?: string; dropped: boolean }
  | { k: 'rule'; name: string }
  | { k: 'star'; inner: Slot }
  | { k: 'sep'; inner: Slot; delim: string }
  | { k: 'opt'; slots: Slot[] }
  | { k: 'alt'; branches: Slot[][] }
  | { k: 'zw' };

function leafDropped(ttype: string, leaves: Record<string, TokenLeafPolicy>): boolean {
  const p = leaves[ttype];
  return p?.action === 'drop';
}

function slotsOfStep(s: Step, leaves: Record<string, TokenLeafPolicy>): Slot[] {
  switch (s.t) {
    case 'lit':
      return [{ k: 'leaf', ttype: s.ttype, text: s.value, dropped: leafDropped(s.ttype, leaves) }];
    case 'tok':
      return [{ k: 'leaf', ttype: s.name, dropped: leafDropped(s.name, leaves) }];
    case 'rule':
    case 'ruleBp':
      return [{ k: 'rule', name: s.name }];
    case 'star': {
      const inner = slotsOfStep(s.step, leaves);
      if (inner.length === 1) return [{ k: 'star', inner: inner[0]! }];
      return [{ k: 'star', inner: { k: 'alt', branches: [inner] } }];
    }
    case 'sep': {
      const inner = slotsOfStep(s.elem, leaves);
      const i = inner.length === 1 ? inner[0]! : { k: 'alt' as const, branches: [inner] };
      return [{ k: 'sep', inner: i, delim: s.delim }];
    }
    case 'opt':
      return [{ k: 'opt', slots: s.steps.flatMap((x) => slotsOfStep(x, leaves)) }];
    case 'altlit':
      return [{
        k: 'alt',
        branches: s.opts.map((o) => [{
          k: 'leaf' as const, ttype: o.ttype, text: o.value, dropped: leafDropped(o.ttype, leaves),
        }]),
      }];
    case 'alt':
      return [{ k: 'alt', branches: s.branches.map((b) => b.flatMap((x) => slotsOfStep(x, leaves))) }];
    case 'seq':
      return s.steps.flatMap((x) => slotsOfStep(x, leaves));
    case 'suppress':
      return s.steps.flatMap((x) => slotsOfStep(x, leaves));
    case 'not':
    case 'sameLine':
      return [{ k: 'zw' }];
  }
}

function slotsOfAlt(alt: Alt, leaves: Record<string, TokenLeafPolicy>): Slot[] {
  return alt.flatMap((s) => slotsOfStep(s, leaves));
}

function fullyDropped(s: Slot): boolean {
  if (s.k === 'zw') return true;
  if (s.k === 'leaf') return s.dropped;
  if (s.k === 'rule') return false;
  if (s.k === 'star' || s.k === 'sep') return fullyDropped(s.inner);
  if (s.k === 'opt') return s.slots.every(fullyDropped);
  if (s.k === 'alt') return s.branches.every((b) => b.every(fullyDropped));
  return false;
}

function visible(slots: Slot[]): Slot[] {
  const out: Slot[] = [];
  for (const s of slots) {
    if (fullyDropped(s)) continue;
    if (s.k === 'opt') {
      const v = visible(s.slots);
      if (v.length) out.push({ k: 'opt', slots: v });
      continue;
    }
    if (s.k === 'alt') {
      const kept = s.branches.map(visible).filter((b) => b.length > 0);
      if (kept.length === 0) continue;
      if (kept.length === 1 && kept[0]!.length === 1) { out.push(kept[0]![0]!); continue; }
      out.push({ k: 'alt', branches: kept });
      continue;
    }
    if (s.k === 'star') {
      if (fullyDropped(s.inner)) continue;
      out.push(s);
      continue;
    }
    if (s.k === 'sep') {
      if (fullyDropped(s.inner)) continue;
      out.push(s);
      continue;
    }
    out.push(s);
  }
  return out;
}

function arity(slots: Slot[]): { min: number; max: number | 'inf' } {
  let min = 0;
  let max: number | 'inf' = 0;
  const addMax = (n: number | 'inf') => {
    if (max === 'inf' || n === 'inf') max = 'inf';
    else max += n;
  };
  for (const s of slots) {
    if (s.k === 'leaf' && !s.dropped) { min++; addMax(1); }
    else if (s.k === 'rule') { min++; addMax(1); }
    else if (s.k === 'star') { addMax('inf'); }
    else if (s.k === 'sep') { min++; addMax('inf'); }
    else if (s.k === 'opt') {
      const a = arity(s.slots);
      if (a.max === 'inf') max = 'inf'; else if (max !== 'inf') max += a.max;
    } else if (s.k === 'alt') {
      let bMin = Infinity, bMax: number | 'inf' = 0;
      for (const b of s.branches) {
        const a = arity(b);
        bMin = Math.min(bMin, a.min);
        if (a.max === 'inf' || bMax === 'inf') bMax = 'inf';
        else bMax = Math.max(bMax as number, a.max);
      }
      if (bMin === Infinity) bMin = 0;
      min += bMin;
      addMax(bMax);
    }
  }
  return { min, max };
}

function hasListSlot(slots: Slot[]): boolean {
  return slots.some((s) => s.k === 'star' || s.k === 'sep' || (s.k === 'opt' && hasListSlot(s.slots)) || (s.k === 'alt' && s.branches.some(hasListSlot)));
}

function onlyListWithOptionalNoise(slots: Slot[]): boolean {
  const v = visible(slots);
  if (v.length === 1 && (v[0]!.k === 'star' || v[0]!.k === 'sep')) return true;
  if (v.length === 1 && v[0]!.k === 'star') return true;
  return false;
}

function resolveShape(
  r: RuleIR,
  spec: ShapeSpec,
): { shape: RuleShape; source: ShapeIRRule['source'] } {
  if (spec.rules[r.name]) return { shape: spec.rules[r.name]!, source: 'exact' };
  if (spec.rules[r.cstName]) return { shape: spec.rules[r.cstName]!, source: 'cstName' };
  return { shape: { kind: 'keep' }, source: 'default' };
}

function summarizeSlots(slots: Slot[]): string {
  return '[' + slots.map((s) => {
    if (s.k === 'leaf') return s.dropped ? `drop:${s.ttype}` : `leaf:${s.ttype}${s.text ? '=' + JSON.stringify(s.text) : ''}`;
    if (s.k === 'rule') return `rule:${s.name}`;
    if (s.k === 'star') return `star`;
    if (s.k === 'sep') return `sep`;
    if (s.k === 'opt') return `opt(${summarizeSlots(s.slots)})`;
    if (s.k === 'alt') return `alt`;
    return 'zw';
  }).join(' ') + ']';
}

function checkOpTextFields(
  ruleName: string,
  node: NodeShape,
  diags: ShapeDiag[],
  where: string,
  allowed: boolean,
): void {
  for (const f of node.fields) {
    if (f.bind !== 'opText') continue;
    if (!allowed) {
      diags.push({
        level: 'error', rule: ruleName, code: 'opText-invalid',
        message: `${where}: field '${f.name}' bind:'opText' only allowed on pratt prefix/binary/postfix node fields`,
      });
    }
  }
}

function checkNodeAgainstSlots(
  ruleName: string,
  node: NodeShape,
  slots: Slot[],
  diags: ShapeDiag[],
  where: string,
  allowOpText = false,
): void {
  checkOpTextFields(ruleName, node, diags, where, allowOpText);
  const v = visible(slots);
  const used = new Set<number>();
  let sawListBind = false;
  for (const f of node.fields) {
    if (f.bind === 'opText') continue;
    if (f.bind && 'from' in f.bind && f.bind.from === 'list') {
      sawListBind = true;
      const of = f.bind.of;
      if (of === 'rest') {
        if (!hasListSlot(v)) {
          diags.push({
            level: 'error', rule: ruleName, code: 'list-without-star',
            message: `${where}: field '${f.name}' wants list/rest but no star/sep slot in ${summarizeSlots(v)}`,
          });
        }
      } else if (typeof of === 'number') {
        if (of < 0 || of >= v.length || (v[of]!.k !== 'star' && v[of]!.k !== 'sep')) {
          diags.push({
            level: 'error', rule: ruleName, code: 'list-slot-miss',
            message: `${where}: field '${f.name}' from:list of:${of} but slot is ${v[of] ? v[of]!.k : 'OOB'}`,
          });
        }
      }
    } else if (f.bind && 'from' in f.bind && f.bind.from === 'opt') {
      const i = f.bind.at;
      if (i < 0 || i >= v.length || v[i]!.k !== 'opt') {
        diags.push({
          level: 'error', rule: ruleName, code: 'opt-slot-miss',
          message: `${where}: field '${f.name}' from:opt at:${i} but slot is ${v[i] ? v[i]!.k : 'OOB'}`,
        });
      }
      if (!f.optional) {
        diags.push({
          level: 'warn', rule: ruleName, code: 'opt-not-marked',
          message: `${where}: field '${f.name}' binds an opt slot but optional:true not set`,
        });
      }
    } else if (f.bind && 'at' in f.bind) {
      const i = f.bind.at;
      used.add(i);
      if (i < 0 || i >= v.length) {
        diags.push({
          level: 'error', rule: ruleName, code: 'field-oob',
          message: `${where}: field '${f.name}' binds at:${i} but visible arity is ${v.length} (${summarizeSlots(v)})`,
        });
        continue;
      }
      const slot = v[i]!;
      if ((slot.k === 'star' || slot.k === 'sep') && !f.optional) {
        diags.push({
          level: 'error', rule: ruleName, code: 'star-needs-list',
          message: `${where}: field '${f.name}' at:${i} hits a ${slot.k} slot — use { from:'list', of:i } or rule-level list()`,
        });
      }
    }
  }
  // A list nested inside opt/alt is one packed visible slot, not a direct list
  // channel. Only direct star/sep slots require a list binding.
  const hasDirectList = v.some((s) => s.k === 'star' || s.k === 'sep');
  if (hasDirectList && !sawListBind && !node.fields.some((f) => f.bind !== 'opText' && typeof f.bind === 'object' && 'from' in f.bind && f.bind.from === 'list')) {
    diags.push({
      level: 'error', rule: ruleName, code: 'star-needs-list',
      message: `${where}: visible stream has star/sep (${summarizeSlots(v)}) but no list-binding field`,
    });
  }
}

function checkRuleShape(
  r: RuleIR,
  shape: RuleShape,
  leaves: Record<string, TokenLeafPolicy>,
  diags: ShapeDiag[],
  inlineRules: Set<string>,
): void {
  if (shape.kind === 'custom' || shape.kind === 'keep' || shape.kind === 'drop' || shape.kind === 'leafValue') {
    if (shape.kind === 'custom' && !shape.reason) {
      diags.push({ level: 'error', rule: r.name, code: 'custom-no-reason', message: 'custom() requires reason' });
    }
    return;
  }
  if (shape.kind === 'inline') {
    inlineRules.add(r.name);
    return;
  }
  if (shape.kind === 'list') {
    if (r.kind !== 'rd') {
      diags.push({ level: 'error', rule: r.name, code: 'list-on-pratt', message: 'list() only valid on RD rules (or use pratt+list field)' });
      return;
    }
    r.alts.forEach((alt, i) => {
      const slots = slotsOfAlt(alt, leaves);
      if (!onlyListWithOptionalNoise(slots) && !hasListSlot(visible(slots))) {
        diags.push({
          level: 'error', rule: r.name, code: 'list-shape-miss',
          message: `list() but alt[${i}] visible=${summarizeSlots(visible(slots))} (need a star/sep)`,
        });
      }
    });
    return;
  }
  if (shape.kind === 'node') {
    if (r.kind === 'rd') {
      r.alts.forEach((alt, i) => checkNodeAgainstSlots(r.name, shape, slotsOfAlt(alt, leaves), diags, `alt[${i}]`, false));
    } else {
      diags.push({
        level: 'warn', rule: r.name, code: 'node-on-pratt',
        message: 'bare node() on Pratt rule; prefer pratt({binary, prefix, …}) or custom',
      });
    }
    return;
  }
  if (shape.kind === 'choice') {
    if (r.kind !== 'rd') {
      diags.push({ level: 'error', rule: r.name, code: 'choice-on-pratt', message: 'choice() is for RD alts; use pratt() for Pratt' });
      return;
    }
    checkChoice(r, shape, leaves, diags, inlineRules);
    return;
  }
  if (shape.kind === 'pratt') {
    if (r.kind !== 'pratt') {
      diags.push({ level: 'error', rule: r.name, code: 'pratt-on-rd', message: 'pratt() only for Pratt IR rules' });
      return;
    }
    checkPratt(r, shape, diags);
    return;
  }
}

function checkChoice(
  r: RdRule,
  shape: ChoiceShape,
  leaves: Record<string, TokenLeafPolicy>,
  diags: ShapeDiag[],
  inlineRules: Set<string>,
): void {
  const n = r.alts.length;
  const covered = new Array<number>(n).fill(0);
  for (const arm of shape.arms) {
    for (const i of arm.altIndices) {
      if (i < 0 || i >= n) {
        diags.push({ level: 'error', rule: r.name, code: 'choice-oob', message: `arm '${arm.name}' altIndex ${i} out of 0..${n - 1}` });
        continue;
      }
      covered[i]!++;
    }
    for (const i of arm.altIndices) {
      if (i < 0 || i >= n) continue;
      if (arm.shape.kind === 'node') {
        checkNodeAgainstSlots(r.name, arm.shape, slotsOfAlt(r.alts[i]!, leaves), diags, `choice:${arm.name}/alt[${i}]`, false);
      } else if (arm.shape.kind === 'list') {
        const slots = slotsOfAlt(r.alts[i]!, leaves);
        if (!hasListSlot(visible(slots))) {
          diags.push({
            level: 'error', rule: r.name, code: 'list-shape-miss',
            message: `choice:${arm.name}/alt[${i}] list() but visible=${summarizeSlots(visible(slots))}`,
          });
        }
      } else if (arm.shape.kind === 'inline') {
        inlineRules.add(r.name);
      } else if (arm.shape.kind === 'custom' && !arm.shape.reason) {
        diags.push({ level: 'error', rule: r.name, code: 'custom-no-reason', message: `arm '${arm.name}' custom lacks reason` });
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (covered[i] === 0) {
      diags.push({ level: 'error', rule: r.name, code: 'choice-gap', message: `alt[${i}] not covered by any choice arm` });
    } else if (covered[i]! > 1) {
      diags.push({ level: 'error', rule: r.name, code: 'choice-overlap', message: `alt[${i}] covered by ${covered[i]} arms` });
    }
  }
}

function checkPratt(r: PrattRule, shape: PrattShape, diags: ShapeDiag[]): void {
  if (shape.binary && r.binary.length === 0) {
    diags.push({ level: 'warn', rule: r.name, code: 'pratt-extra-binary', message: 'pratt.binary declared but IR has no binary ops' });
  }
  if (shape.prefix && r.prefix.length === 0) {
    diags.push({ level: 'warn', rule: r.name, code: 'pratt-extra-prefix', message: 'pratt.prefix declared but IR has no prefix ops' });
  }
  if (shape.led && r.leds.length === 0 && r.postfixToks.length === 0) {
    diags.push({ level: 'warn', rule: r.name, code: 'pratt-extra-led', message: 'pratt.led declared but IR has no leds' });
  }
  const checkC = (x: { kind: string; reason?: string } | undefined, label: string) => {
    if (x && x.kind === 'custom' && !x.reason) {
      diags.push({ level: 'error', rule: r.name, code: 'custom-no-reason', message: `pratt.${label} custom lacks reason` });
    }
  };
  checkC(shape.atom as { kind: string; reason?: string } | undefined, 'atom');
  checkC(shape.binary as { kind: string; reason?: string } | undefined, 'binary');
  checkC(shape.prefix as { kind: string; reason?: string } | undefined, 'prefix');
  checkC(shape.led as { kind: string; reason?: string } | undefined, 'led');
  checkC(shape.nudSeq as { kind: string; reason?: string } | undefined, 'nudSeq');
  checkC(shape.nudCapped as { kind: string; reason?: string } | undefined, 'nudCapped');
  if (shape.prefix?.kind === 'node') checkOpTextFields(r.name, shape.prefix, diags, 'pratt.prefix', true);
  if (shape.binary?.kind === 'node') checkOpTextFields(r.name, shape.binary, diags, 'pratt.binary', true);
  if (shape.postfix?.kind === 'node') checkOpTextFields(r.name, shape.postfix, diags, 'pratt.postfix', true);
}

function checkSpliceLegality(
  pir: ParserIR,
  resolved: Map<string, RuleShape>,
  leaves: Record<string, TokenLeafPolicy>,
  diags: ShapeDiag[],
): void {
  const isInline = (name: string): boolean => resolved.get(name)?.kind === 'inline';

  for (const r of pir.rules) {
    if (r.kind !== 'rd') continue;
    const shape = resolved.get(r.name);
    if (!shape) continue;
    const nodes: { where: string; node: NodeShape }[] = [];
    if (shape.kind === 'node') nodes.push({ where: 'node', node: shape });
    if (shape.kind === 'choice') {
      for (const arm of shape.arms) {
        if (arm.shape.kind === 'node') nodes.push({ where: `choice:${arm.name}`, node: arm.shape });
      }
    }
    for (const { where, node } of nodes) {
      for (const f of node.fields) {
        if (f.bind === 'opText' || !('at' in f.bind)) continue;
        const at = f.bind.at;
        for (let ai = 0; ai < r.alts.length; ai++) {
          const v = visible(slotsOfAlt(r.alts[ai]!, leaves));
          if (at >= v.length) continue;
          const slot = v[at]!;
          if (slot.k === 'rule' && isInline(slot.name)) {
            const child = pir.rules.find((x) => x.name === slot.name);
            const childShape = resolved.get(slot.name);
            let unary = false;
            if (childShape?.kind === 'leafValue' || childShape?.kind === 'keep') unary = true;
            if (child?.kind === 'rd') {
              unary = child.alts.every((alt) => {
                const a = arity(visible(slotsOfAlt(alt, leaves)));
                return a.min === 1 && a.max === 1;
              });
            }
            if (!unary) {
              diags.push({
                level: 'error', rule: r.name, code: 'splice-ambiguous',
                message: `${where} field '${f.name}' at:${at} refs inline rule '${slot.name}' whose arity is not stably 1 — ` +
                  `positional single-handle bind is ambiguous after splice (alt[${ai}] ${summarizeSlots(v)})`,
              });
            }
          }
        }
      }
    }
  }
}

export function validateShape(grammarModule: { default: CstGrammar }, spec: ShapeSpec): ValidateResult {
  const pir = portableIR(grammarModule.default);
  const diags: ShapeDiag[] = [];
  const rulesOut: ShapeIRRule[] = [];
  const resolved = new Map<string, RuleShape>();
  const inlineRules = new Set<string>();

  for (const r of pir.rules) {
    const { shape, source } = resolveShape(r, spec);
    if (source === 'default') {
      if (spec.unmapped === 'error') {
        diags.push({
          level: 'error', rule: r.name, code: 'unmapped',
          message: `rule '${r.name}' (cst=${r.cstName}) has no shape mapping and unmapped:'error'`,
        });
      } else {
        diags.push({
          level: 'info', rule: r.name, code: 'defaulted',
          message: `rule '${r.name}' defaulted to keep`,
        });
      }
    }
    resolved.set(r.name, shape);
    checkRuleShape(r, shape, spec.leaves, diags, inlineRules);
    rulesOut.push({ name: r.name, cstName: r.cstName, kind: r.kind, source, shape });
  }

  const irNames = new Set(pir.rules.map((r) => r.name));
  const cstNames = new Set(pir.rules.map((r) => r.cstName));
  for (const k of Object.keys(spec.rules)) {
    if (!irNames.has(k) && !cstNames.has(k)) {
      diags.push({ level: 'error', code: 'unknown-rule', message: `shape key '${k}' is not an IR rule name or cstName` });
    }
  }

  checkSpliceLegality(pir, resolved, spec.leaves, diags);

  if (rulesOut.length !== pir.rules.length) {
    diags.push({
      level: 'error', code: 'count-mismatch',
      message: `ShapeIR.rules.length=${rulesOut.length} !== IR rules=${pir.rules.length}`,
    });
  }

  const errors = diags.filter((d) => d.level === 'error');
  const warns = diags.filter((d) => d.level === 'warn');
  return {
    ok: errors.length === 0,
    ir: {
      grammar: spec.grammar,
      spans: spec.spans,
      leaves: spec.leaves,
      rules: rulesOut,
      diagnostics: diags,
    },
    errors,
    warns,
  };
}

export function validateShapeOrThrow(grammar: CstGrammar, spec: ShapeSpec): ShapeIR {
  const result = validateShape({ default: grammar }, spec);
  if (!result.ok) {
    throw new Error(result.errors.map((e) => `[${e.code}]${e.rule ? ` ${e.rule}:` : ''} ${e.message}`).join('; '));
  }
  return result.ir;
}

export { slotsOfAlt, visible, summarizeSlots, arity };
