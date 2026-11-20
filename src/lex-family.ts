// Lexer scan family: how far each token of a grammar extends from a position, authored once and
// printed for each target through the `Lowering` it registers with `defineTarget`.
//
// Every scanner is `(s, p) -> end`, with end > p for a match and -1 for none. The token patterns
// compile to backtracking-free matchers of the same shape: greedy `repeat`, ordered `alt`,
// zero-width `lookahead` / `anchor`. Scanners only read the source; they never touch lexer state.
//
// Boundary: the dispatch loop stays with each target — whitespace, punctuation, the first-byte
// arms (buildLexDispatchPlan), lexer-mode state (regex / template / newline), token storage, and
// what to do when no scanner matches. A target calls `scanner(name)` at its dispatch site.
//
// Offsets are in the target's native string units; the family only does arithmetic on them.

import type { LexTok, ParserIR } from './emit-portable.ts';
import type { TokenCharClassItem, TokenPattern } from './types.ts';
import { type CharSet, type CodeRange, type Expr, type Fn, type Lowering, type Stmt, printFns } from './algo-ir.ts';

type Ex = Expr | string;
const x = (e: Ex): Expr => (typeof e === 'string' ? { k: 'var', name: e } : e);
const I = (v: number): Expr => ({ k: 'int', v });
const F: Expr = { k: 'bool', v: false };
const bin = (op: Extract<Expr, { k: 'bin' }>['op']) => (a: Ex, b: Ex): Expr => ({ k: 'bin', op, a: x(a), b: x(b) });
const add = bin('add'), sub = bin('sub'), lt = bin('lt'), le = bin('le'), gt = bin('gt'), ge = bin('ge'), eq = bin('eq'), ne = bin('ne');
const any = (es: Expr[]): Expr => (es.length ? es.reduce((a, b) => ({ k: 'bin', op: 'or', a, b })) : F);
const and = (a: Ex, b: Ex): Expr => ({ k: 'bin', op: 'and', a: x(a), b: x(b) });
const not = (e: Ex): Expr => ({ k: 'not', e: x(e) });
const len = (e: Ex): Expr => ({ k: 'len', e: x(e) });
const code = (i: Ex): Expr => ({ k: 'code', s: x('s'), i: x(i) });
const hasAt = (i: Ex, lit: string): Expr => ({ k: 'hasAt', s: x('s'), i: x(i), lit });
const inSet = (set: string, c: Ex): Expr => ({ k: 'inSet', set, c: x(c) });
const call = (fn: string, i: Ex): Expr => ({ k: 'call', fn, args: [x('s'), x(i)] });
const let_ = (name: string, init: Ex): Stmt => ({ k: 'let', name, ty: 'int', init: x(init) });
const set = (name: string, e: Ex): Stmt => ({ k: 'set', name, e: x(e) });
const if_ = (c: Ex, then: Stmt[], els?: Stmt[]): Stmt => ({ k: 'if', c: x(c), then, else: els });
const while_ = (c: Ex, body: Stmt[]): Stmt => ({ k: 'while', c: x(c), body });
const ret = (e: Ex): Stmt => ({ k: 'return', es: [x(e)] });
const BREAK: Stmt = { k: 'break' };
const NONE = ret(I(-1));

const inRanges = (v: Ex, rs: CodeRange[]): Expr => any(rs.map(([lo, hi]) => (lo === hi ? eq(v, I(lo)) : and(ge(v, I(lo)), le(v, I(hi))))));
const classRanges = (items: TokenCharClassItem[]): CodeRange[] =>
  items.map((it) => (it.type === 'char' ? [it.value.charCodeAt(0), it.value.charCodeAt(0)] : [it.from.charCodeAt(0), it.to.charCodeAt(0)]));
const isAscii = (t: string): boolean => /^[\x00-\x7f]*$/.test(t);
// A literal's length in native units: a number for ASCII, otherwise measured by the target.
const litLen = (t: string): Expr => (isAscii(t) ? I(t.length) : len({ k: 'str', v: t }));
const ident = (t: string): string => t.replace(/[^A-Za-z0-9]/g, '_');

export const scannerName = (tok: string): string => `lexScan${ident(tok)}`;

const sig = (name: string, doc: string, body: Stmt[]): Fn => ({ name, doc, params: [{ name: 's', ty: 'str' }, { name: 'p', ty: 'int' }], ret: ['int'], body });

class LexScan {
  sets: CharSet[] = [];
  fns: Fn[] = [];
  private pats = new Map<string, string>();

  charSet(name: string, rs: CodeRange[]): string {
    this.sets.push({ name, ranges: rs.filter(([lo]) => lo <= 127).map(([lo, hi]) => [Math.max(0, lo), Math.min(127, hi)]) });
    return name;
  }

  // The matcher fn for a token pattern; sub-patterns come first, so every callee precedes its caller.
  pattern(p: TokenPattern): string {
    const key = JSON.stringify(p);
    const known = this.pats.get(key);
    if (known) return known;
    const body = this.patternBody(p);
    const name = `lexMatch${this.pats.size}`;
    this.pats.set(key, name);
    this.fns.push(sig(name, 'A token-pattern matcher: the position after the match, or -1.', body));
    return name;
  }

  private patternBody(p: TokenPattern): Stmt[] {
    if (typeof p === 'string') return [if_(hasAt('p', p), [ret(add('p', litLen(p)))]), NONE];
    switch (p.type) {
      case 'anyChar': return [if_(lt('p', len('s')), [ret(add('p', I(1)))]), NONE];
      case 'charClass': {
        const m = inRanges('c', classRanges(p.items));
        return [if_(ge('p', len('s')), [NONE]), let_('c', code('p')), if_(p.negate ? not(m) : m, [ret(add('p', I(1)))]), NONE];
      }
      case 'seq': {
        const ms = p.items.map((it) => this.pattern(it));
        return [let_('q', 'p'), ...ms.flatMap((m) => [set('q', call(m, 'q')), if_(lt('q', I(0)), [NONE])]), ret('q')];
      }
      case 'alt': {
        const ms = p.items.map((it) => this.pattern(it));
        return [let_('r', I(-1)), ...ms.flatMap((m) => [set('r', call(m, 'p')), if_(ge('r', I(0)), [ret('r')])]), NONE];
      }
      case 'repeat': {
        if (!p.greedy) throw new Error('lex-family: lazy repeat unsupported');
        const b = p.body;
        const counted = p.min > 0 || p.max !== undefined;
        const tail = counted ? [if_(lt('n', I(p.min)), [NONE])] : [];
        const step = [set('q', add('q', I(1))), ...(counted ? [set('n', add('n', I(1)))] : [])];
        const cap = p.max !== undefined ? [if_(ge('n', I(p.max)), [BREAK])] : [];
        if (typeof b !== 'string' && b.type === 'charClass') {
          const m = inRanges('c', classRanges(b.items));
          return [
            let_('q', 'p'), ...(counted ? [let_('n', I(0))] : []),
            while_(lt('q', len('s')), [...cap, let_('c', code('q')), if_(b.negate ? m : not(m), [BREAK]), ...step]),
            ...tail, ret('q'),
          ];
        }
        const m = this.pattern(b);
        return [
          let_('q', 'p'), ...(counted ? [let_('n', I(0))] : []), let_('r', call(m, 'q')),
          while_(and(ge('r', I(0)), ne('r', 'q')), [set('q', 'r'), ...(counted ? [set('n', add('n', I(1)))] : []), ...cap, set('r', call(m, 'q'))]),
          ...tail, ret('q'),
        ];
      }
      case 'lookahead': {
        const m = this.pattern(p.body);
        return [let_('r', call(m, 'p')), if_(p.negate ? lt('r', I(0)) : ge('r', I(0)), [ret('p')]), NONE];
      }
      case 'anchor': return [if_(eq('p', p.kind === 'start' ? I(0) : len('s')), [ret('p')]), NONE];
      default: throw new Error(`lex-family: pattern '${(p as { type: string }).type}' unsupported`);
    }
  }

  // A pattern match that consumed nothing is no token.
  private nonEmpty(m: string): Stmt[] {
    return [let_('e', call(m, 'p')), if_(gt('e', 'p'), [ret('e')]), NONE];
  }

  scanner(t: LexTok): Fn {
    const name = scannerName(t.name);
    const first = (rs: CodeRange[], then: Stmt[]): Stmt[] => [if_(ge('p', len('s')), [NONE]), let_('c', code('p')), if_(not(inRanges('c', rs)), [NONE]), ...then];
    switch (t.kind) {
      case 'run':
        return sig(name, `${t.name}: a first character, then a run of continue characters.`, first(t.first, [
          let_('e', add('p', I(1))),
          while_(lt('e', len('s')), [let_('d', code('e')), if_(not(inRanges('d', t.cont)), [BREAK]), set('e', add('e', I(1)))]),
          ret('e'),
        ]));
      case 'runBail': {
        const m = this.pattern(t.pattern);
        // A run that may not stop at a non-ASCII character goes to the matcher alone.
        if (t.cont.some(([, hi]) => hi > 127)) return sig(name, `${t.name} is scanned by its token pattern alone.`, this.nonEmpty(m));
        const tag = ident(t.name);
        const fs = this.charSet(`lexFirst${tag}`, t.first), cs = this.charSet(`lexCont${tag}`, t.cont);
        const bails = (v: string, bs: number[], nonAscii: boolean): Expr => any([...bs.map((b) => eq(v, I(b))), ...(nonAscii ? [ge(v, I(128))] : [])]);
        const head = [...new Set([...t.bail, ...t.headBail])].sort((a, b) => a - b);
        return sig(name, `${t.name}: an ASCII run while no bail character stops it, else the token pattern.`, [
          if_(ge('p', len('s')), [NONE]),
          let_('c', code('p')),
          if_(inSet(fs, 'c'), [
            let_('e', add('p', I(1))),
            while_(lt('e', len('s')), [if_(not(inSet(cs, code('e'))), [BREAK]), set('e', add('e', I(1)))]),
            if_(ge('e', len('s')), [ret('e')]),
            let_('d', code('e')),
            if_(not(bails('d', t.bail, t.bailNonAscii)), [ret('e')]),
            set('e', call(m, 'p')),
            if_(gt('e', 'p'), [ret('e')]),
            NONE,
          ]),
          if_(bails('c', head, t.bailNonAscii || t.headBailNonAscii), this.nonEmpty(m)),
          NONE,
        ]);
      }
      case 'string': {
        const d = t.delim.charCodeAt(0);
        return sig(name, `${t.name}: ${t.delim}..${t.delim}, a backslash escaping the next character.`, [
          if_(ge('p', len('s')), [NONE]),
          if_(ne(code('p'), I(d)), [NONE]),
          let_('e', add('p', I(1))),
          while_(lt('e', len('s')), [
            let_('c', code('e')),
            if_(eq('c', I(92)), [set('e', add('e', I(2)))], [if_(eq('c', I(d)), [ret(add('e', I(1)))]), set('e', add('e', I(1)))]),
          ]),
          NONE,
        ]);
      }
      case 'line':
        return sig(name, `${t.name}: ${t.prefix} to the end of the line.`, [
          if_(not(hasAt('p', t.prefix)), [NONE]),
          let_('e', add('p', litLen(t.prefix))),
          while_(lt('e', len('s')), [if_(eq(code('e'), I(10)), [BREAK]), set('e', add('e', I(1)))]),
          ret('e'),
        ]);
      case 'block':
        if (t.nested) {
          return sig(name, `${t.name}: ${t.open}..${t.close}, nested openers each closed in turn.`, [
            if_(not(hasAt('p', t.open)), [NONE]),
            let_('e', add('p', litLen(t.open))),
            let_('depth', I(1)),
            while_(lt('e', len('s')), [
              if_(hasAt('e', t.close), [
                set('e', add('e', litLen(t.close))),
                if_(le('depth', I(1)), [ret('e')]),
                set('depth', sub('depth', I(1))),
              ], [
                // Every opener consumes source, so the depth stays below the source length.
                if_(hasAt('e', t.open), [set('e', add('e', litLen(t.open))), if_(lt('depth', len('s')), [set('depth', add('depth', I(1)))])], [set('e', add('e', I(1)))]),
              ]),
            ]),
            NONE,
          ]);
        }
        return sig(name, `${t.name} runs from ${t.open} to the first ${t.close} after it.`, [
          if_(not(hasAt('p', t.open)), [NONE]),
          let_('e', add('p', litLen(t.open))),
          while_(lt('e', len('s')), [if_(hasAt('e', t.close), [ret(add('e', litLen(t.close)))]), set('e', add('e', I(1)))]),
          NONE,
        ]);
      case 'pattern':
        return sig(name, `${t.name} is scanned by its token pattern.`, this.nonEmpty(this.pattern(t.pattern)));
    }
  }
}

// The scanned tokens: every lexer token except the template token, which the target's template
// state machine scans.
export function scannedTokens(ir: ParserIR): LexTok[] {
  return ir.tokens.filter((t) => t.name !== ir.tpl?.token);
}

export function lexScanFamily(ir: ParserIR): { sets: CharSet[]; fns: Fn[] } {
  const b = new LexScan();
  for (const t of scannedTokens(ir)) b.fns.push(b.scanner(t));
  return { sets: b.sets, fns: b.fns };
}

export function emitLexScan(ir: ParserIR, lowering: Lowering): string {
  const { sets, fns } = lexScanFamily(ir);
  return printFns(lowering, fns, sets);
}
