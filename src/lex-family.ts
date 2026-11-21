// Lexer scan family: how far each token of a grammar extends from a position, authored once and
// printed for each target through the `Lowering` it registers with `defineTarget`.
//
// Every scanner is `(s, p) -> end`, with end > p for a match and -1 for none (a negative p never
// matches). A token pattern means what its regex means (the interpreter's lexer runs that regex):
// the end of the first match in the regex's order of choices, where a choice that leaves the rest
// of the pattern unmatched is given up for the next one. Where committing to the first choice is
// that answer (src/lex-match-plan.ts decides it per node), a pattern compiles to a matcher of its
// own shape — greedy `repeat`, ordered `alt`, zero-width `lookahead` / `anchor` — that never
// backs up; elsewhere the node's matcher carries the rest of the pattern and tries it after each
// choice in turn. Scanners only read the source; they never touch lexer state.
//
// A skipped token's scanner is `(s, p) -> (end, nl)`: nl answers whether the text it matched holds
// a line terminator (the interpreter's /[\n\r\u2028\u2029]/ on the match), which puts a line break
// before the next token. It falls out of the scan that walks that text: where the scan consumes a
// character that may be a line terminator it notes the position of the first one it read, `nlAt`
// (len(s) while none), and the match holds one exactly when nlAt < end. A position read is a fact
// about the source whether or not the choice that read it is kept: every position a scan reads is
// at or after p, so one before the end lies in the match, and every character of the match was
// read by the choice that consumed it. So a matcher whose pattern can consume a line terminator
// threads nlAt through each call, `(s, p, nlAt) -> (end, nlAt)`, with no rule for which choice
// wins; a matcher whose pattern cannot is the plain one.
//
// Boundary: the dispatch loop stays with each target — whitespace, punctuation, the first-byte
// arms (buildLexDispatchPlan), lexer-mode state (regex / template / newline), token storage, and
// what to do when no scanner matches. A target calls `scanner(name)` at its dispatch site, or,
// when its lowering splices inline fns, prints `scanInline(name)` there.
//
// Offsets are in the target's native string units; the family only does arithmetic on them.

import type { LexTok, ParserIR } from './emit-portable.ts';
import type { TokenCharClassItem, TokenPattern } from './types.ts';
import { type CharSet, type CodeRange, type Expr, type Fn, type Lowering, type Stmt, inlineFn, printFns, printStmts } from './algo-ir.ts';
import { ACCEPT, type CSet, committed, contOf, exitsWhereBodyStops, info, intersect, oneChar, oneEnd } from './lex-match-plan.ts';

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

// ECMAScript's LineTerminator: the characters the interpreter tests a skipped match for.
const LINE_TERMINATORS: CSet = [[10, 10], [13, 13], [0x2028, 0x2029]];
const ANY_CHAR: CSet = [[0, 0x10ffff]];
const NOT_LF: CSet = [[0, 9], [11, 0x10ffff]];
const holdsLt = (p: TokenPattern): boolean => intersect(info(p).chars, LINE_TERMINATORS).length > 0;
// The position of the first line terminator a skipped token's scan has read; len(s) while none.
const NL_AT = 'nlAt';

const inRanges = (v: Ex, rs: CodeRange[]): Expr => any(rs.map(([lo, hi]) => (lo === hi ? eq(v, I(lo)) : and(ge(v, I(lo)), le(v, I(hi))))));
// A class's ASCII ranges, compared with one code unit, and its non-ASCII characters, matched as
// literals: a non-ASCII character is more than one unit in a UTF-8 target, so no single unit is
// it. A non-ASCII range has no such spelling; it is refused rather than compared unit by unit.
function classParts(items: TokenCharClassItem[]): { narrow: CodeRange[]; wide: string[] } {
  const narrow: CodeRange[] = [], wide: string[] = [];
  for (const it of items) {
    if (it.type === 'char') { if (it.value.charCodeAt(0) <= 127) narrow.push([it.value.charCodeAt(0), it.value.charCodeAt(0)]); else wide.push(it.value); continue; }
    const lo = it.from.charCodeAt(0), hi = it.to.charCodeAt(0);
    if (hi > 127) throw new Error(`lex-family: a character class range ${JSON.stringify(it.from)}-${JSON.stringify(it.to)} beyond ASCII has no scanner in every target's units`);
    narrow.push([lo, hi]);
  }
  return { narrow, wide };
}
const isAscii = (t: string): boolean => /^[\x00-\x7f]*$/.test(t);
// A literal's length in native units: a number for ASCII, otherwise measured by the target.
const litLen = (t: string): Expr => (isAscii(t) ? I(t.length) : len({ k: 'str', v: t }));
const ident = (t: string): string => t.replace(/[^A-Za-z0-9]/g, '_');

export const scannerName = (tok: string): string => `lexScan${ident(tok)}`;
/** The template span scanner (see `tplSpan`). */
export const TPL_SPAN = 'lexTplSpan';

const sig = (name: string, doc: string, body: Stmt[]): Fn => ({ name, doc, params: [{ name: 's', ty: 'str' }, { name: 'p', ty: 'int' }], ret: ['int'], body });

// Where a skipped token's scan consumes the character c at `at`, one of `chars`: note it when it is
// a line terminator. A non-ASCII terminator is more than one unit in a UTF-8 target, so it is
// matched as a literal at its first unit.
function seen(track: boolean, c: Ex, at: Ex, chars: CSet): Stmt[] {
  if (!track) return [];
  const is: Expr[] = [], wide: string[] = [];
  for (const [lo, hi] of intersect(chars, LINE_TERMINATORS)) for (let u = lo; u <= hi; u++) (u < 128 ? is.push(eq(c, I(u))) : wide.push(String.fromCharCode(u)));
  if (wide.length) is.push(and(ge(c, I(128)), any(wide.map((w) => hasAt(at, w)))));
  return is.length ? [if_(and(any(is), lt(at, NL_AT)), [set(NL_AT, at)])] : [];
}
// The same where it consumes the literal `lit` at `at`, for the literal's first line terminator.
function seenLit(track: boolean, lit: string, at: Ex): Stmt[] {
  const j = track ? lit.search(/[\n\r\u2028\u2029]/) : -1;
  if (j < 0) return [];
  const q = add(at, litLen(lit.slice(0, j)));
  return [if_(lt(q, NL_AT), [set(NL_AT, q)])];
}

class LexScan {
  sets: CharSet[] = [];
  fns: Fn[] = [];
  private pats = new Map<string, string>();
  // The matchers that thread nlAt: `(s, p, nlAt) -> (end, nlAt)`.
  private threads = new Set<string>();

  // A matcher fn: plain, or (`track`) threading nlAt through `body`, written as for a plain one.
  private define(name: string, doc: string, body: Stmt[], track: boolean): Fn {
    if (!track) return sig(name, doc, body);
    this.threads.add(name);
    return {
      name, doc: `${doc} Threads nlAt, the first line terminator read.`,
      params: [{ name: 's', ty: 'str' }, { name: 'p', ty: 'int' }, { name: 'nl0', ty: 'int' }], ret: ['int', 'int'],
      body: [let_(NL_AT, 'nl0'), ...this.thread(body, (e) => [e, x(NL_AT)])],
    };
  }

  // `body` with nlAt passed into and taken back from each call of a threading matcher, and each
  // return made `answer(end)`. Such a call is only ever a whole let, set or return value.
  thread(body: Stmt[], answer: (end: Expr) => Expr[]): Stmt[] {
    let k = 0;
    const threaded = (e: Expr): e is Expr & { k: 'call' } => e.k === 'call' && this.threads.has(e.fn);
    const callInto = (e: Expr & { k: 'call' }, v: string): Stmt[] => {
      const n = `${NL_AT}${++k}`;
      return [{ k: 'letCall', names: [v, n], call: { ...e, args: [...e.args, x(NL_AT)] } }, set(NL_AT, n)];
    };
    const go = (ss: Stmt[]): Stmt[] => ss.flatMap((st): Stmt[] => {
      switch (st.k) {
        case 'let': return threaded(st.init) ? callInto(st.init, st.name) : [st];
        case 'set': {
          if (!threaded(st.e)) return [st];
          const v = `at${++k}`;
          return [...callInto(st.e, v), set(st.name, v)];
        }
        case 'return': {
          if (!threaded(st.es[0])) return [{ k: 'return', es: answer(st.es[0]) }];
          const v = `at${++k}`;
          return [...callInto(st.es[0], v), { k: 'return', es: answer(x(v)) }];
        }
        case 'if': return [{ ...st, then: go(st.then), else: st.else && go(st.else) }];
        case 'while': return [{ ...st, body: go(st.body) }];
        default: return [st];
      }
    });
    return go(body);
  }

  charSet(name: string, rs: CodeRange[]): string {
    this.sets.push({ name, ranges: rs.filter(([lo]) => lo <= 127).map(([lo, hi]) => [Math.max(0, lo), Math.min(127, hi)]) });
    return name;
  }

  // The matcher fn for a token pattern; sub-patterns come first, so every callee precedes its caller.
  // `track`: a skipped token's matcher, which notes the line terminators it consumes.
  pattern(p: TokenPattern, track = false): string {
    track &&= holdsLt(p);
    const key = JSON.stringify(p) + (track ? ' nl' : '');
    const known = this.pats.get(key);
    if (known) return known;
    const body = this.patternBody(p, track);
    const name = `lexMatch${this.pats.size}`;
    this.pats.set(key, name);
    this.fns.push(this.define(name, 'A token-pattern matcher: the position after the match, or -1.', body, track));
    return name;
  }

  private patternBody(p: TokenPattern, track: boolean): Stmt[] {
    if (typeof p === 'string') return [if_(hasAt('p', p), [...seenLit(track, p, 'p'), ret(add('p', litLen(p)))]), NONE];
    switch (p.type) {
      case 'anyChar': return [if_(lt('p', len('s')), [...(track ? [let_('c', code('p')), ...seen(track, 'c', 'p', ANY_CHAR)] : []), ret(add('p', I(1)))]), NONE];
      case 'charClass': {
        const { narrow, wide } = classParts(p.items);
        const m = inRanges('c', narrow);
        const head = [if_(ge('p', len('s')), [NONE]), let_('c', code('p'))];
        if (p.negate) return [...head, if_(m, [NONE]), ...wide.map((ch) => if_(hasAt('p', ch), [NONE])), ...seen(track, 'c', 'p', info(p).chars), ret(add('p', I(1)))];
        return [...head, if_(m, [...seen(track, 'c', 'p', narrow), ret(add('p', I(1)))]), ...wide.map((ch) => if_(hasAt('p', ch), [...seenLit(track, ch, 'p'), ret(add('p', litLen(ch)))])), NONE];
      }
      case 'seq': {
        // Each step's position is its own local, checked to be a position in s before the
        // next step reads from it (a matcher returns -1 or a position in s).
        const ms = p.items.map((it) => this.pattern(it, track));
        let at = 'p';
        const steps = ms.flatMap((m, k): Stmt[] => {
          const q = `q${k}`, from = at;
          at = q;
          return [let_(q, call(m, from)), if_(any([lt(q, I(0)), gt(q, len('s'))]), [NONE])];
        });
        return [...steps, ret(at)];
      }
      case 'alt': {
        const ms = p.items.map((it) => this.pattern(it, track));
        return [let_('r', I(-1)), ...ms.flatMap((m) => [set('r', call(m, 'p')), if_(ge('r', I(0)), [ret('r')])]), NONE];
      }
      case 'repeat': {
        if (!p.greedy) throw new Error('lex-family: lazy repeat unsupported');
        const b = p.body;
        const counted = p.min > 0 || p.max !== undefined;
        const tail = counted ? [if_(lt('n', I(p.min)), [NONE])] : [];
        const step = [set('q', add('q', I(1))), ...(counted ? [set('n', add('n', I(1)))] : [])];
        const cap = p.max !== undefined ? [if_(ge('n', I(p.max)), [BREAK])] : [];
        if (typeof b !== 'string' && b.type === 'charClass' && classParts(b.items).wide.length === 0) {
          const m = inRanges('c', classParts(b.items).narrow);
          return [
            let_('q', 'p'), ...(counted ? [let_('n', I(0))] : []),
            while_(lt('q', len('s')), [...cap, let_('c', code('q')), if_(b.negate ? m : not(m), [BREAK]), ...seen(track, 'c', 'q', info(b).chars), ...step]),
            ...tail, ret('q'),
          ];
        }
        const m = this.pattern(b, track);
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

  // The matcher for p followed by the continuation k: the end of the first match of p then k in
  // the regex's order of choices, or -1. Where committing is that answer it is p's own matcher.
  exact(p: TokenPattern, k: TokenPattern[] = [], track = false): string {
    track &&= holdsLt(p) || k.some(holdsLt);
    const c = contOf(k, ACCEPT);
    if (committed(p, c)) {
      const m = this.pattern(p, track);
      return k.length === 0 ? m : this.fnFor(['then', p, k], track, () => [let_('e', call(m, 'p')), if_(lt('e', I(0)), [NONE]), ret(this.kAt(k, 'e', track))]);
    }
    if (typeof p === 'string') throw new Error('lex-family: unreachable');
    switch (p.type) {
      case 'seq':
        return p.items.length === 0 ? this.exact('', k, track) : this.exact(p.items[0], [...p.items.slice(1), ...k], track);
      case 'alt': {
        const ms = p.items.map((it) => this.exact(it, k, track));
        return this.fnFor(['alt', p, k], track, () => [let_('r', I(-1)), ...ms.flatMap((m) => [set('r', call(m, 'p')), if_(ge('r', I(0)), [ret('r')])]), NONE]);
      }
      case 'lookahead': {
        // What a lookahead reads, the rest of the pattern consumes, or the match ends before it.
        const m = this.exact(p.body);
        const rest = k.length ? this.exact(k[0], k.slice(1), track) : null;
        return this.fnFor(['look', p, k], track, () => [let_('r', call(m, 'p')), if_(p.negate ? ge('r', I(0)) : lt('r', I(0)), [NONE]), ret(rest ? call(rest, 'p') : x('p'))]);
      }
      case 'repeat': return this.exactRepeat(p, k, c, track);
      default: throw new Error(`lex-family: pattern '${p.type}' unsupported`);
    }
  }

  private exactRepeat(p: Extract<TokenPattern, { type: 'repeat' }>, k: TokenPattern[], c: ReturnType<typeof contOf>, track: boolean): string {
    const b = info(p.body);
    const where = `repeat of ${JSON.stringify(p.body).slice(0, 80)}`;
    if (b.nullable) throw new Error(`lex-family: a ${where} that can match empty, where the pattern must back up into it`);
    if (p.min > 0) return this.exact(p.body, [{ ...p, min: p.min - 1, max: p.max === undefined ? undefined : p.max - 1 }, ...k], track);
    if (p.max === 0) return this.exact('', k, track);
    const m = this.exact(p.body, [], track);
    const counted = p.max !== undefined;
    const capped = counted ? [if_(ge('n', I(p.max!)), [BREAK])] : [];
    if (!p.greedy) {
      // Lazy: the continuation first, one more repeat only when it fails.
      if (!oneChar(p.body) && !oneEnd(p.body)) throw new Error(`lex-family: a lazy ${where} whose body can end in more than one place`);
      return this.fnFor(['lazy', p, k], track, () => [
        let_('q', 'p'), let_('n', I(0)),
        while_({ k: 'bool', v: true }, [
          let_('r', this.kAt(k, 'q', track)), if_(ge('r', I(0)), [ret('r')]),
          ...(counted ? [if_(ge('n', I(p.max!)), [NONE])] : []),
          let_('e', call(m, 'q')), if_(le('e', 'q'), [NONE]), set('q', 'e'), set('n', add('n', I(1))),
        ]),
        NONE,
      ]);
    }
    // Every repeat ends where the body cannot go on, and only that end can let the rest match.
    if (oneEnd(p.body) && exitsWhereBodyStops(p.body, c)) {
      return this.fnFor(['run', p, k], track, () => [
        let_('q', 'p'), let_('n', I(0)), let_('r', call(m, 'q')),
        while_(and(ge('r', I(0)), ne('r', 'q')), [set('q', 'r'), set('n', add('n', I(1))), ...capped, set('r', call(m, 'q'))]),
        ret(this.kAt(k, 'q', track)),
      ]);
    }
    // A one-character body: the repeats end at consecutive positions; try the rest from the most.
    if (oneChar(p.body)) {
      return this.fnFor(['back', p, k], track, () => [
        let_('q', 'p'), let_('n', I(0)), let_('r', call(m, 'q')),
        while_(ge('r', I(0)), [set('q', 'r'), set('n', add('n', I(1))), ...capped, set('r', call(m, 'q'))]),
        while_(ge('q', 'p'), [set('r', this.kAt(k, 'q', track)), if_(ge('r', I(0)), [ret('r')]), set('q', sub('q', I(1)))]),
        NONE,
      ]);
    }
    // A bounded repeat: one more repeat, else the rest.
    if (counted) return this.exact({ type: 'alt', items: [{ type: 'seq', items: [p.body, { ...p, max: p.max! - 1 }] }, ''] }, k, track);
    throw new Error(`lex-family: a ${where} the pattern must back up into, whose body is longer than one character`);
  }

  private kAt(k: TokenPattern[], at: string, track: boolean): Expr {
    return k.length === 0 ? x(at) : call(this.exact(k[0], k.slice(1), track), at);
  }

  private fnFor(key: unknown[], track: boolean, body: () => Stmt[]): string {
    const id = JSON.stringify([...key, track]);
    const known = this.pats.get(id);
    if (known) return known;
    const b = body();
    const name = `lexMatch${this.pats.size}`;
    this.pats.set(id, name);
    this.fns.push(this.define(name, 'A token-pattern matcher followed by the rest of its pattern: the position after both, or -1.', b, track));
    return name;
  }

  // A template literal's text from p (after its opener or a hole's closer) to the delimiter that
  // ends it: the position of that `interpOpen` or closing `open`, -1 when the source ends first,
  // or -2 - q when `strict` and the backslash at q begins no well-formed escape. A backslash
  // otherwise takes the next character.
  tplSpan(t: { open: string; interpOpen: string; escapeValid: TokenPattern | null }): Fn {
    const esc = t.escapeValid === null ? null : this.exact(t.escapeValid);
    const skip = set('q', add('q', I(2)));
    const escape = esc === null ? [skip] : [if_('strict', [
      let_('e', call(esc, 'q')),
      if_(lt('e', I(0)), [ret(sub(I(-2), 'q'))]),
      set('q', 'e'),
    ], [skip])];
    return {
      name: TPL_SPAN,
      doc: 'A template span: the position of the delimiter ending it, -1 when unterminated, -2 - q for a malformed escape at q (strict).',
      params: [{ name: 's', ty: 'str' }, { name: 'p', ty: 'int' }, { name: 'strict', ty: 'bool' }],
      ret: ['int'],
      body: [
        let_('q', 'p'),
        while_(lt('q', len('s')), [
          if_(hasAt('q', t.interpOpen), [ret('q')]),
          if_(eq(code('q'), I(92)), escape, [
            if_(hasAt('q', t.open), [ret('q')]),
            set('q', add('q', I(1))),
          ]),
        ]),
        NONE,
      ],
    };
  }

  // A pattern match that consumed nothing is no token.
  private nonEmpty(m: string): Stmt[] {
    return [let_('e', call(m, 'p')), if_(gt('e', 'p'), [ret('e')]), NONE];
  }

  // A negative p is no position in s. Ruling it out first also tells native compilers that every
  // index the scanner reads is non-negative, so they can drop per-character bounds checks. A
  // skipped token's scanner answers (end, nlAt < end).
  scanner(t: LexTok): Fn {
    const f = this.scanBody(t, t.skip);
    const body = [if_(lt('p', I(0)), [NONE]), ...f.body];
    if (!t.skip) return { ...f, body };
    return {
      ...f, doc: `${f.doc} And whether the match holds a line terminator.`, ret: ['int', 'bool'],
      body: [let_(NL_AT, len('s')), ...this.thread(body, (e) => [e, e.k === 'int' && e.v < 0 ? F : lt(NL_AT, e)])],
    };
  }

  private scanBody(t: LexTok, track: boolean): Fn {
    const name = scannerName(t.name);
    const first = (rs: CodeRange[], then: Stmt[]): Stmt[] => [if_(ge('p', len('s')), [NONE]), let_('c', code('p')), if_(not(inRanges('c', rs)), [NONE]), ...seen(track, 'c', 'p', rs), ...then];
    switch (t.kind) {
      case 'run':
        return sig(name, `${t.name}: a first character, then a run of continue characters.`, first(t.first, [
          let_('e', add('p', I(1))),
          while_(lt('e', len('s')), [let_('d', code('e')), if_(not(inRanges('d', t.cont)), [BREAK]), ...seen(track, 'd', 'e', t.cont), set('e', add('e', I(1)))]),
          ret('e'),
        ]));
      case 'runBail': {
        const m = this.exact(t.pattern, [], track);
        // A run that may not stop at a non-ASCII character goes to the matcher alone.
        if (t.cont.some(([, hi]) => hi > 127)) return sig(name, `${t.name} is scanned by its token pattern alone.`, this.nonEmpty(m));
        const tag = ident(t.name);
        const fs = this.charSet(`lexFirst${tag}`, t.first), cs = this.charSet(`lexCont${tag}`, t.cont);
        const bails = (v: string, bs: number[], nonAscii: boolean): Expr => any([...bs.map((b) => eq(v, I(b))), ...(nonAscii ? [ge(v, I(128))] : [])]);
        const head = [...new Set([...t.bail, ...t.headBail])].sort((a, b) => a - b);
        const contSeen = seen(track, 'd', 'e', t.cont);
        return sig(name, `${t.name}: an ASCII run while no bail character stops it, else the token pattern.`, [
          if_(ge('p', len('s')), [NONE]),
          let_('c', code('p')),
          if_(inSet(fs, 'c'), [
            ...seen(track, 'c', 'p', t.first),
            let_('e', add('p', I(1))),
            while_(lt('e', len('s')), contSeen.length
              ? [let_('d', code('e')), if_(not(inSet(cs, 'd')), [BREAK]), ...contSeen, set('e', add('e', I(1)))]
              : [if_(not(inSet(cs, code('e'))), [BREAK]), set('e', add('e', I(1)))]),
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
        // An escape takes the character after the backslash without reading it, except to note it.
        const escaped = track ? [if_(lt(add('e', I(1)), len('s')), [let_('d', code(add('e', I(1)))), ...seen(track, 'd', add('e', I(1)), ANY_CHAR)])] : [];
        return sig(name, `${t.name}: ${t.delim}..${t.delim}, a backslash escaping the next character.`, [
          if_(ge('p', len('s')), [NONE]),
          if_(ne(code('p'), I(d)), [NONE]),
          let_('e', add('p', I(1))),
          while_(lt('e', len('s')), [
            let_('c', code('e')),
            ...seen(track, 'c', 'e', ANY_CHAR),
            if_(eq('c', I(92)), [...escaped, set('e', add('e', I(2)))], [if_(eq('c', I(d)), [ret(add('e', I(1)))]), set('e', add('e', I(1)))]),
          ]),
          NONE,
        ]);
      }
      case 'line':
        return sig(name, `${t.name}: ${t.prefix} to the end of the line.`, [
          if_(not(hasAt('p', t.prefix)), [NONE]),
          ...seenLit(track, t.prefix, 'p'),
          let_('e', add('p', litLen(t.prefix))),
          while_(lt('e', len('s')), track
            ? [let_('c', code('e')), if_(eq('c', I(10)), [BREAK]), ...seen(track, 'c', 'e', NOT_LF), set('e', add('e', I(1)))]
            : [if_(eq(code('e'), I(10)), [BREAK]), set('e', add('e', I(1)))]),
          ret('e'),
        ]);
      case 'block': {
        // The guard only looks: what it reads, the comment's body consumes.
        const guard = t.guard === null ? [] : [let_('g', call(this.exact(t.guard), 'e')), if_(lt('g', I(0)), [NONE])];
        return sig(name, `${t.name} runs from ${t.open}${t.guard === null ? '' : ' (where its guard holds)'} to the first ${t.close} after it.`, [
          if_(not(hasAt('p', t.open)), [NONE]),
          ...seenLit(track, t.open, 'p'),
          let_('e', add('p', litLen(t.open))),
          ...guard,
          while_(lt('e', len('s')), [
            if_(hasAt('e', t.close), [...seenLit(track, t.close, 'e'), ret(add('e', litLen(t.close)))]),
            ...(track ? [let_('c', code('e')), ...seen(track, 'c', 'e', ANY_CHAR)] : []),
            set('e', add('e', I(1))),
          ]),
          NONE,
        ]);
      }
      case 'pattern':
        return sig(name, `${t.name} is scanned by its token pattern.`, this.nonEmpty(this.exact(t.pattern, [], track)));
    }
  }
}

// The scanned tokens: every lexer token except the template token, which the target's template
// state machine scans.
export function scannedTokens(ir: ParserIR): LexTok[] {
  return ir.tokens.filter((t) => t.name !== ir.tpl?.token);
}

const families = new WeakMap<ParserIR, { sets: CharSet[]; fns: Fn[] }>();
export function lexScanFamily(ir: ParserIR): { sets: CharSet[]; fns: Fn[] } {
  let f = families.get(ir);
  if (!f) {
    const b = new LexScan();
    for (const t of scannedTokens(ir)) b.fns.push({ ...b.scanner(t), inline: true });
    if (ir.tpl) b.fns.push(b.tplSpan(ir.tpl));
    f = { sets: b.sets, fns: b.fns };
    families.set(ir, f);
  }
  return f;
}

export function emitLexScan(ir: ParserIR, lowering: Lowering): string {
  const { sets, fns } = lexScanFamily(ir);
  return printFns(lowering, lowering.spliceInline ? fns.filter((f) => !f.inline) : fns, sets);
}

// Scanners return -1 or a position, never this.
const UNSET = -2;

// The scanner for `token` as statements in the caller's scope: `out` is declared and left holding
// the end the scanner returns for source `s` at position `p` (the caller's variables), and for a
// skipped token `nl` (named exactly then) whether the text it matched holds a line terminator.
export function emitScanInline(ir: ParserIR, lowering: Lowering, token: string, at: { s: string; p: string; out: string; nl?: string }): string[] {
  const { sets, fns } = lexScanFamily(ir);
  const f = fns.find((g) => g.name === scannerName(token));
  if (!f) throw new Error(`lex-family: no scanner for ${token}`);
  const outs = at.nl === undefined ? [at.out] : [at.out, at.nl];
  if (outs.length !== f.ret.length) throw new Error(`lex-family: ${token}'s scanner answers ${f.ret.length === 2 ? 'whether it holds a line terminator; name nl' : 'its end alone; name no nl'}`);
  return printStmts(lowering, fns, sets, [{ name: at.s, ty: 'str' }, { name: at.p, ty: 'int' }], inlineFn(f, [at.s, at.p], outs, UNSET));
}
