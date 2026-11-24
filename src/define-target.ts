// `defineParserTarget`: the one entry point each portable target module calls to register itself.
// A target supplies its name, its `Lowering` (how the
// shared algorithm IR is spelled, stored, owned and sized in that language) and its own parser
// emitter; it receives the shared algorithm families already printed with that lowering, so a
// target never authors or re-decides those algorithms. A target that embeds no shared algorithm
// may omit the lowering; asking it for one is then an error.
import type { Lowering } from './algo-ir.ts';
import type { EmitOptions, Target } from './target.ts';
import { type LexTok, type ParserIR, buildArenaIdPlan, buildLexIdPlan, hasCappedSeq, hasRebind, recoveryTables } from './emit-portable.ts';
import type { CstGrammar } from './types.ts';
import { EL_FRAME_FN, EL_OPENS_FN, EL_RAW_FN, EL_REACH_FN, EL_TAG_START_FN, TPL_SPAN, UNI_CLASS, UNI_IDENT, emitLexScan, hasUniPrefix, emitScanInline, scannedTokens, scannerName, templateLiterals, tokenLiterals } from './lex-family.ts';
import { emitRelexFamily } from './relex-family.ts';
import { emitReuseFamily } from './reuse-family.ts';
import { emitRecoveryFamily } from './recovery-family.ts';
import { emitRebindFamily } from './rebind-family.ts';
import { printFns } from './algo-ir.ts';
import { planShape, type ShapePlan } from './shape-plan.ts';
import type { Shape } from './shape2-eval.ts';

// The shared algorithm families, printed for the defining target.
export interface SharedAlgorithms {
  relexFamily(ir: ParserIR): string;
  // The incremental reuse decisions over recorded top-level entries (empty without `ir.reuse`).
  reuseFamily(ir: ParserIR): string;
  // Total parsing's diagnostics and their one formatter (src/recovery-family.ts), for the emit
  // option `recovery`.
  // With the strict interpreter over the parse plan's table (emit-portable recoveryTables);
  // `methods`: only its engine methods (true) or only the free functions (false), for a target
  // that prints its engine's methods inside the receiver's declaration.
  recoveryFamily(ir: ParserIR, methods?: boolean): string;
  // The mixfix operand re-bind (src/rebind-family.ts) for one engine form: its free function
  // (`free`, once per module) or its method; `L`: the engine form's lowering, where the target
  // spells a method's receiver per form (default: the target's lowering).
  rebindFamily(ir: ParserIR, part: 'free' | 'methods', L?: Lowering): string;
  // The token scanners, the tokens they cover, and the printed name of the scanner a dispatch
  // site calls for a token. A lowering with `spliceInline` gets the scanner's statements for its
  // dispatch site instead (`out` declared and holding the scanner's result).
  lexScan(ir: ParserIR): string;
  scannedTokens(ir: ParserIR): LexTok[];
  scanner(token: string): string;
  scanInline(ir: ParserIR, token: string, at: { s: string; p: string; out: string }): string[];
  // The literals (of `lits`) a token's text may equal: none proves its literal id is 0.
  tokenLiterals(ir: ParserIR, token: LexTok, lits: readonly string[]): string[];
  templateLiterals(ir: ParserIR, lits: readonly string[]): { whole: string[]; head: string[]; middle: string[]; tail: string[] };
  // The printed name of the template span scanner, `(s, p, strict) -> int`: the position of the
  // delimiter that ends the span, -1 when unterminated, -2 - q for a malformed escape at q.
  tplSpan(): string;
  // The name the target prints the identifier escape check's Unicode identifier class under
  // (lex-family.ts), `(cp) -> int`.
  uniClass(): string;
  // The name it prints the Unicode IdentifierName scanner under (lex-family.ts UNI_IDENT),
  // `(s, p) -> int`: the end, or -1; null when the scanners do not call it (no identifier-like
  // token has a prefix), so the target prints none.
  uniIdent(ir: ParserIR): string | null;
  // The printed names of an element region's routines (lex-family.ts elementFns): the frame
  // step, the type-parameter vetoes, the read end of a signature's decision, the raw body, and
  // whether a tagOpen opens a tag (tagStart).
  elementFn(which: 'frame' | 'opens' | 'reach' | 'raw' | 'tagStart'): string;
  // A shape (emit option `shape`) planned against the IR built from its grammar (src/shape-plan.ts),
  // and its construct plans printed (refused for a target whose Lowering has no `shape`).
  shapePlan(shape: Shape, ir: ParserIR): ShapePlan;
  shapeFamily(plan: ShapePlan): string;
}

export interface TargetDefinition {
  name: string;
  ext: string;
  lowering?: Lowering;
  emitParser(grammar: CstGrammar, shared: SharedAlgorithms, opts: EmitOptions): string;
  emitRunner?(opts?: EmitOptions): string;
}

export interface PortableTarget extends Target {
  lowering?: Lowering;
  shared: SharedAlgorithms;
}

const registry = new Map<string, PortableTarget>();

export function defineParserTarget(def: TargetDefinition): PortableTarget {
  if (registry.has(def.name)) throw new Error(`defineParserTarget: target ${def.name} is already registered`);
  const lowering = (): Lowering => {
    if (!def.lowering) throw new Error(`defineParserTarget: target ${def.name} supplies no Lowering for shared algorithms`);
    return def.lowering;
  };
  const shared: SharedAlgorithms = {
    relexFamily: (ir) => {
      if (!lowering().relex) throw new Error(`defineParserTarget: target ${def.name} supplies no token-stream Lowering for the relex family`);
      return emitRelexFamily(ir, lowering());
    },
    reuseFamily: (ir) => {
      if (!lowering().record) throw new Error(`defineParserTarget: target ${def.name} supplies no record Lowering for the reuse family`);
      return emitReuseFamily(ir, lowering());
    },
    rebindFamily: (ir, part, L) => emitRebindFamily(L ?? lowering(), buildLexIdPlan(ir), part),
    recoveryFamily: (ir, methods) => {
      if (!lowering().record || !lowering().relex) throw new Error(`defineParserTarget: target ${def.name} supplies no record and token-stream Lowering for the recovery family`);
      const ids = buildLexIdPlan(ir);
      const ar = buildArenaIdPlan(ir, ids);
      const labels = Object.entries(ir.ruleLabels).flatMap(([name, label]): [number, string][] => { const r = ar.ruleNames.indexOf(name); return r < 0 ? [] : [[r, label]]; });
      return emitRecoveryFamily(lowering(), recoveryTables(ir, ids, ar).data, methods, hasRebind(ir), ids, hasCappedSeq(ir), labels);
    },
    lexScan: (ir) => emitLexScan(ir, lowering()),
    scannedTokens,
    scanner: (token) => {
      if (lowering().spliceInline) throw new Error(`defineParserTarget: target ${def.name} splices scanners; use scanInline`);
      return lowering().ident(scannerName(token));
    },
    scanInline: (ir, token, at) => emitScanInline(ir, lowering(), token, at),
    tokenLiterals,
    templateLiterals,
    tplSpan: () => lowering().ident(TPL_SPAN),
    uniClass: () => lowering().ident(UNI_CLASS),
    uniIdent: (ir) => (hasUniPrefix(ir) ? lowering().ident(UNI_IDENT) : null),
    shapePlan: planShape,
    shapeFamily: (plan) => {
      if (!lowering().shape) throw new Error(`defineParserTarget: target ${def.name} prints no shape values (Lowering.shape): it cannot emit a shape-building parser yet`);
      return printFns(lowering(), plan.fns);
    },
    elementFn: (which) => lowering().ident({ frame: EL_FRAME_FN, opens: EL_OPENS_FN, reach: EL_REACH_FN, raw: EL_RAW_FN, tagStart: EL_TAG_START_FN }[which]),
  };
  const target: PortableTarget = {
    name: def.name,
    ext: def.ext,
    lowering: def.lowering,
    shared,
    emitParser: (grammar, opts = {}) => def.emitParser(grammar, shared, opts),
  };
  if (def.emitRunner) target.emitRunner = def.emitRunner;
  registry.set(def.name, target);
  return target;
}

export function registeredTargets(): PortableTarget[] {
  return [...registry.values()];
}
