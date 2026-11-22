// `defineTarget`: the one entry point each portable target module calls to register itself.
// A target supplies its name, its `Lowering` (how the
// shared algorithm IR is spelled, stored, owned and sized in that language) and its own parser
// emitter; it receives the shared algorithm families already printed with that lowering, so a
// target never authors or re-decides those algorithms. A target that embeds no shared algorithm
// may omit the lowering; asking it for one is then an error.
import type { Lowering } from './algo-ir.ts';
import { unitLen } from './text-units.ts';
import type { Target } from './emit.ts';
import type { LexTok, ParserIR } from './emit-portable.ts';
import type { CstGrammar } from './types.ts';
import { IDENT_ESC, TPL_SPAN, UNI_CLASS, emitLexScan, emitScanInline, scannedTokens, scannerName, templateLiterals, tokenLiterals } from './lex-family.ts';
import { emitRelexFamily } from './relex-family.ts';

// The shared algorithm families, printed for the defining target.
export interface SharedAlgorithms {
  relexFamily(ir: ParserIR): string;
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
  // An identifier(-like) token's scanner returns -2 - e when its match may hold a `\u` escape
  // (lex-family.ts); the dispatch site then calls `fn(s, p + prefix, e)`, which returns e when every
  // escape spells an identifier character and -1 (the site's lexer error) otherwise. `uniClass`
  // is the name the target prints its Unicode identifier class under (`(cp) -> int`).
  identEsc(ir: ParserIR, token: string): { fn: string; prefix: number };
  uniClass(): string;
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
  const shared: SharedAlgorithms = {
    relexFamily: (ir) => {
      if (!lowering().relex) throw new Error(`defineTarget: target ${def.name} supplies no token-stream Lowering for the relex family`);
      return emitRelexFamily(ir, lowering());
    },
    lexScan: (ir) => emitLexScan(ir, lowering()),
    scannedTokens,
    scanner: (token) => {
      if (lowering().spliceInline) throw new Error(`defineTarget: target ${def.name} splices scanners; use scanInline`);
      return lowering().ident(scannerName(token));
    },
    scanInline: (ir, token, at) => emitScanInline(ir, lowering(), token, at),
    tokenLiterals,
    templateLiterals,
    tplSpan: () => lowering().ident(TPL_SPAN),
    identEsc: (ir, token) => ({ fn: lowering().ident(IDENT_ESC), prefix: unitLen(ir.identPrefix[token] ?? '', lowering().units) }),
    uniClass: () => lowering().ident(UNI_CLASS),
  };
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
