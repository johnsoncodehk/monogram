// `defineTarget`: the one entry point each portable target module calls to register itself.
// A target supplies its name, its `Lowering` (how the
// shared algorithm IR is spelled, stored, owned and sized in that language) and its own parser
// emitter; it receives the shared algorithm families already printed with that lowering, so a
// target never authors or re-decides those algorithms. A target that embeds no shared algorithm
// may omit the lowering; asking it for one is then an error.
import type { Lowering } from './algo-ir.ts';
import type { Target } from './emit.ts';
import type { ParserIR } from './emit-portable.ts';
import type { CstGrammar } from './types.ts';
import { emitRelexFamily } from './relex-family.ts';

// The shared algorithm families, printed for the defining target.
export interface SharedAlgorithms {
  relexFamily(ir: ParserIR): string;
}

export interface TargetDefinition {
  name: string;
  ext: string;
  lowering?: Lowering;
  emitParser(grammar: CstGrammar, shared: SharedAlgorithms): string;
  emitRunner?(): string;
}

export interface PortableTarget extends Target {
  lowering?: Lowering;
  shared: SharedAlgorithms;
}

const registry = new Map<string, PortableTarget>();

export function defineTarget(def: TargetDefinition): PortableTarget {
  if (registry.has(def.name)) throw new Error(`defineTarget: target ${def.name} is already registered`);
  const lowering = (): Lowering => {
    if (!def.lowering) throw new Error(`defineTarget: target ${def.name} supplies no Lowering for shared algorithms`);
    return def.lowering;
  };
  const shared: SharedAlgorithms = { relexFamily: (ir) => emitRelexFamily(ir, lowering()) };
  const target: PortableTarget = {
    name: def.name,
    ext: def.ext,
    lowering: def.lowering,
    shared,
    emitParser: (grammar) => def.emitParser(grammar, shared),
  };
  if (def.emitRunner) target.emitRunner = def.emitRunner;
  registry.set(def.name, target);
  return target;
}

export function registeredTargets(): PortableTarget[] {
  return [...registry.values()];
}
