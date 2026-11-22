// Lexer scan family: how far each token of a grammar extends from a position, authored once and
// printed for each target through the `Lowering` it registers with `defineTarget`.
//
// Every scanner is `(s, p) -> end`, with end > p for a match and -1 for none (a negative p never
// matches). An identifier(-like) token's scanner returns -2 - end instead when its match came from
// the token pattern rather than the ASCII run (the branch that can take a `\u` escape); the
// dispatch site then runs `IDENT_ESC` on the match, out of line, so no identifier pays a search. A token pattern means what its regex means (the interpreter's lexer runs that regex):
// the end of the first match in the regex's order of choices, where a choice that leaves the rest
// of the pattern unmatched is given up for the next one. Where committing to the first choice is
// that answer (src/lex-match-plan.ts decides it per node), a pattern compiles to a matcher of its
// own shape — greedy `repeat`, ordered `alt`, zero-width `lookahead` / `anchor` — that never
// backs up; elsewhere the node's matcher carries the rest of the pattern and tries it after each
// choice in turn. Scanners only read the source; they never touch lexer state.
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
import { ACCEPT, committed, contOf, exitsWhereBodyStops, info, mayMatchText, oneChar, oneEnd } from './lex-match-plan.ts';
import { oneUnit } from './text-units.ts';

type Ex = Expr | string;
const x = (e: Ex): Expr => (typeof e === 'string' ? { k: 'var', name: e } : e);
const I = (v: number): Expr => ({ k: 'int', v });
const F: Expr = { k: 'bool', v: false };
const bin = (op: Extract<Expr, { k: 'bin' }>['op']) => (a: Ex, b: Ex): Expr => ({ k: 'bin', op, a: x(a), b: x(b) });
const add = bin('add'), sub = bin('sub'), shl = bin('shl'), lt = bin('lt'), le = bin('le'), gt = bin('gt'), ge = bin('ge'), eq = bin('eq'), ne = bin('ne');
const any = (es: Expr[]): Expr => (es.length ? es.reduce((a, b) => ({ k: 'bin', op: 'or', a, b })) : F);
const and = (a: Ex, b: Ex): Expr => ({ k: 'bin', op: 'and', a: x(a), b: x(b) });
const or = (a: Ex, b: Ex): Expr => ({ k: 'bin', op: 'or', a: x(a), b: x(b) });
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
// A class's ASCII ranges, compared with one code unit, and its non-ASCII characters, matched as
// literals: a non-ASCII character is more than one unit in a UTF-8 target, so no single unit is
// it. A non-ASCII range has no such spelling; it is refused rather than compared unit by unit.
function classParts(items: TokenCharClassItem[]): { narrow: CodeRange[]; wide: string[] } {
  const narrow: CodeRange[] = [], wide: string[] = [];
  for (const it of items) {
    if (it.type === 'char') { if (oneUnit(it.value)) narrow.push([it.value.charCodeAt(0), it.value.charCodeAt(0)]); else wide.push(it.value); continue; }
    const lo = it.from.charCodeAt(0), hi = it.to.charCodeAt(0);
    if (!oneUnit(it.to)) throw new Error(`lex-family: a character class range ${JSON.stringify(it.from)}-${JSON.stringify(it.to)} beyond ASCII has no scanner in every target's units`);
    narrow.push([lo, hi]);
  }
  return { narrow, wide };
}
// A literal's length in the target's units.
const litLen = (lit: string): Expr => ({ k: 'litLen', lit });
// The units every match of p takes, where that is one width: a literal's length, one unit for a
// pattern every path of which takes one unit in every target's units; null otherwise.
const width = (p: TokenPattern): Expr | null => (typeof p === 'string' && p !== '' ? litLen(p) : oneChar(p) ? I(1) : null);
const ident = (t: string): string => t.replace(/[^A-Za-z0-9]/g, '_');

export const scannerName = (tok: string): string => `lexScan${ident(tok)}`;
/** An identifier's escape check, `(s, q, e) -> int` (see `identEsc`). */
export const IDENT_ESC = 'lexIdentEsc';
/** The target's Unicode identifier class of a code point, `(cp) -> int`: 0 neither, 1
 *  IdentifierPart only, 2 IdentifierStart too (uni-ident.ts). The target prints it. */
export const UNI_CLASS = 'lexUniClass';
/** The template span scanner (see `tplSpan`). */
export const TPL_SPAN = 'lexTplSpan';

const sig = (name: string, doc: string, body: Stmt[]): Fn => ({ name, doc, params: [{ name: 's', ty: 'str' }, { name: 'p', ty: 'int' }], ret: ['int'], body });

class LexScan {
  sets: CharSet[] = [];
  fns: Fn[] = [];
  runs = false;    // some scanner calls the target's runEnd routine
  finds = false;   // some scanner calls the target's find routine
  private pats = new Map<string, string>();

  runEnd(set: string, i: Ex): Expr {
    this.runs = true;
    return { k: 'runEnd', set, s: x('s'), i: x(i) };
  }

  find(i: Ex, lit: string): Expr {
    this.finds = true;
    return { k: 'find', s: x('s'), i: x(i), lit };
  }

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
        const { narrow, wide } = classParts(p.items);
        const m = inRanges('c', narrow);
        const head = [if_(ge('p', len('s')), [NONE]), let_('c', code('p'))];
        if (p.negate) return [...head, if_(m, [NONE]), ...wide.map((ch) => if_(hasAt('p', ch), [NONE])), ret(add('p', I(1)))];
        return [...head, if_(m, [ret(add('p', I(1)))]), ...wide.map((ch) => if_(hasAt('p', ch), [ret(add('p', litLen(ch)))])), NONE];
      }
      case 'seq': {
        // Each step's position is its own local, checked to be a position in s before the
        // next step reads from it (a matcher returns -1 or a position in s).
        const ms = p.items.map((it) => this.pattern(it));
        let at = 'p';
        const steps = ms.flatMap((m, k): Stmt[] => {
          const q = `q${k}`, from = at;
          at = q;
          return [let_(q, call(m, from)), if_(any([lt(q, I(0)), gt(q, len('s'))]), [NONE])];
        });
        return [...steps, ret(at)];
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
        if (typeof b !== 'string' && b.type === 'charClass' && classParts(b.items).wide.length === 0) {
          const m = inRanges('c', classParts(b.items).narrow);
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

  // The matcher for p followed by the continuation k: the end of the first match of p then k in
  // the regex's order of choices, or -1. Where committing is that answer it is p's own matcher.
  exact(p: TokenPattern, k: TokenPattern[] = []): string {
    const c = contOf(k, ACCEPT);
    if (committed(p, c)) {
      const m = this.pattern(p);
      return k.length === 0 ? m : this.fnFor(['then', p, k], () => [let_('e', call(m, 'p')), if_(lt('e', I(0)), [NONE]), ret(this.kAt(k, 'e'))]);
    }
    if (typeof p === 'string') throw new Error('lex-family: unreachable');
    switch (p.type) {
      case 'seq':
        return p.items.length === 0 ? this.exact('', k) : this.exact(p.items[0], [...p.items.slice(1), ...k]);
      case 'alt': {
        const ms = p.items.map((it) => this.exact(it, k));
        return this.fnFor(['alt', p, k], () => [let_('r', I(-1)), ...ms.flatMap((m) => [set('r', call(m, 'p')), if_(ge('r', I(0)), [ret('r')])]), NONE]);
      }
      case 'lookahead': {
        const m = this.exact(p.body);
        const rest = k.length ? this.exact(k[0], k.slice(1)) : null;
        return this.fnFor(['look', p, k], () => [let_('r', call(m, 'p')), if_(p.negate ? ge('r', I(0)) : lt('r', I(0)), [NONE]), ret(rest ? call(rest, 'p') : x('p'))]);
      }
      case 'repeat': return this.exactRepeat(p, k, c);
      default: throw new Error(`lex-family: pattern '${p.type}' unsupported`);
    }
  }

  private exactRepeat(p: Extract<TokenPattern, { type: 'repeat' }>, k: TokenPattern[], c: ReturnType<typeof contOf>): string {
    const b = info(p.body);
    const where = `repeat of ${JSON.stringify(p.body).slice(0, 80)}`;
    if (b.nullable) throw new Error(`lex-family: a ${where} that can match empty, where the pattern must back up into it`);
    if (p.min > 0) return this.exact(p.body, [{ ...p, min: p.min - 1, max: p.max === undefined ? undefined : p.max - 1 }, ...k]);
    if (p.max === 0) return this.exact('', k);
    const m = this.exact(p.body);
    const counted = p.max !== undefined;
    const capped = counted ? [if_(ge('n', I(p.max!)), [BREAK])] : [];
    if (!p.greedy) {
      // Lazy: the continuation first, one more repeat only when it fails.
      if (!oneChar(p.body) && !oneEnd(p.body)) throw new Error(`lex-family: a lazy ${where} whose body can end in more than one place`);
      return this.fnFor(['lazy', p, k], () => [
        let_('q', 'p'), let_('n', I(0)),
        while_({ k: 'bool', v: true }, [
          let_('r', this.kAt(k, 'q')), if_(ge('r', I(0)), [ret('r')]),
          ...(counted ? [if_(ge('n', I(p.max!)), [NONE])] : []),
          let_('e', call(m, 'q')), if_(le('e', 'q'), [NONE]), set('q', 'e'), set('n', add('n', I(1))),
        ]),
        NONE,
      ]);
    }
    // Every repeat ends where the body cannot go on, and only that end can let the rest match.
    if (oneEnd(p.body) && exitsWhereBodyStops(p.body, c)) {
      return this.fnFor(['run', p, k], () => [
        let_('q', 'p'), let_('n', I(0)), let_('r', call(m, 'q')),
        while_(and(ge('r', I(0)), ne('r', 'q')), [set('q', 'r'), set('n', add('n', I(1))), ...capped, set('r', call(m, 'q'))]),
        ret(this.kAt(k, 'q')),
      ]);
    }
    // A body of one width: the repeats end that far apart; try the rest from the most.
    const w = width(p.body);
    if (w !== null) {
      return this.fnFor(['back', p, k], () => [
        let_('q', 'p'), let_('n', I(0)), let_('r', call(m, 'q')),
        while_(ge('r', I(0)), [set('q', 'r'), set('n', add('n', I(1))), ...capped, set('r', call(m, 'q'))]),
        while_(ge('q', 'p'), [set('r', this.kAt(k, 'q')), if_(ge('r', I(0)), [ret('r')]), set('q', sub('q', w))]),
        NONE,
      ]);
    }
    // A bounded repeat: one more repeat, else the rest.
    if (counted) return this.exact({ type: 'alt', items: [{ type: 'seq', items: [p.body, { ...p, max: p.max! - 1 }] }, ''] }, k);
    throw new Error(`lex-family: a ${where} the pattern must back up into, whose matches are not all one width`);
  }

  private kAt(k: TokenPattern[], at: string): Expr {
    return k.length === 0 ? x(at) : call(this.exact(k[0], k.slice(1)), at);
  }

  private fnFor(key: unknown[], body: () => Stmt[]): string {
    const id = JSON.stringify(key);
    const known = this.pats.get(id);
    if (known) return known;
    const b = body();
    const name = `lexMatch${this.pats.size}`;
    this.pats.set(id, name);
    this.fns.push(sig(name, 'A token-pattern matcher followed by the rest of its pattern: the position after both, or -1.', b));
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

  // A pattern match that consumed nothing is no token; an identifier's match reports the branch.
  private nonEmpty(m: string): Stmt[] {
    return [let_('e', call(m, 'p')), if_(gt('e', 'p'), [this.matched()]), NONE];
  }
  private esc = false;
  private matched(): Stmt { return ret(this.esc ? sub(I(-2), 'e') : 'e'); }

  // A negative p is no position in s. Ruling it out first also tells native compilers that every
  // index the scanner reads is non-negative, so they can drop per-character bounds checks.
  // `esc`: t is an identifier(-like) token (see the header for what its scanner returns).
  scanner(t: LexTok, esc: boolean): Fn {
    this.esc = esc;
    const f = this.scanBody(t);
    this.esc = false;
    return { ...f, body: [if_(lt('p', I(0)), [NONE]), ...f.body] };
  }

  // Whether the identifier text s[q, e) (after its prefix), as its token pattern matched it, spells
  // an IdentifierName: every `\u` escape decodes to an IdentifierStart (the first character) or an
  // IdentifierPart character. As the interpreter's lexIdentValid, which matches the decoded text,
  // a high-surrogate escape followed by a low-surrogate escape is the one character they spell.
  // Returns e, or -1 when the text is no IdentifierName.
  identEsc(): Fn {
    // The escape at i (`\uXXXX` or `\u{X...}`, as the token pattern matched it) into v; i moves
    // past it. A braced value stops growing past U+10FFFF, so it cannot overflow.
    const hex = (v: string): Stmt[] => [
      set('d', code('i')),
      if_(ge('d', I(97)), [set('d', sub('d', I(87)))], [if_(ge('d', I(65)), [set('d', sub('d', I(55)))], [set('d', sub('d', I(48)))])]),
      if_(le(v, I(0x10ffff)), [set(v, add(shl(v, I(4)), 'd'))]),
      set('i', add('i', I(1))),
    ];
    const escape = (v: string): Stmt[] => [
      set('i', add('i', I(2))),
      set(v, I(0)),
      if_(eq(code('i'), I(123)), [
        set('i', add('i', I(1))),
        while_(ne(code('i'), I(125)), hex(v)),
        set('i', add('i', I(1))),
      ], [let_('n', add('i', I(4))), while_(lt('i', 'n'), hex(v))]),
    ];
    const inR = (v: string, lo: number, hi: number) => and(ge(v, I(lo)), le(v, I(hi)));
    return {
      name: IDENT_ESC,
      doc: 'Whether an identifier spells its escapes as IdentifierName characters: e, else -1.',
      params: [{ name: 's', ty: 'str' }, { name: 'q', ty: 'int' }, { name: 'e', ty: 'int' }],
      ret: ['int'],
      body: [
        let_('i', 'q'), let_('d', I(0)), let_('cp', I(0)), let_('lo', I(0)), let_('need', I(0)),
        while_(lt('i', 'e'), [
          if_(eq(code('i'), I(92)), [
            set('need', I(1)),
            if_(eq('i', 'q'), [set('need', I(2))]),
            ...escape('cp'),
            if_(and(inR('cp', 0xd800, 0xdbff), and(lt('i', 'e'), eq(code('i'), I(92)))), [
              ...escape('lo'),
              if_(inR('lo', 0xdc00, 0xdfff), [set('cp', add(add(I(0x10000), shl(sub('cp', I(0xd800)), I(10))), sub('lo', I(0xdc00))))]),
            ]),
            if_(or(inR('cp', 0xd800, 0xdfff), gt('cp', I(0x10ffff))), [NONE]),
            if_(lt({ k: 'call', fn: UNI_CLASS, args: [x('cp')] }, 'need'), [NONE]),
          ], [set('i', add('i', I(1)))]),
        ]),
        ret('e'),
      ],
    };
  }

  private scanBody(t: LexTok): Fn {
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
        const m = this.exact(t.pattern);
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
            let_('e', this.runEnd(cs, add('p', I(1)))),
            if_(ge('e', len('s')), [ret('e')]),
            let_('d', code('e')),
            if_(not(bails('d', t.bail, t.bailNonAscii)), [ret('e')]),
            set('e', call(m, 'p')),
            if_(gt('e', 'p'), [this.matched()]),
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
          ret(this.find(add('p', litLen(t.prefix)), '\n')),
        ]);
      case 'block': {
        const guard = t.guard === null ? [] : [let_('g', call(this.exact(t.guard), 'e')), if_(lt('g', I(0)), [NONE])];
        return sig(name, `${t.name} runs from ${t.open}${t.guard === null ? '' : ' (where its guard holds)'} to the first ${t.close} after it.`, [
          if_(not(hasAt('p', t.open)), [NONE]),
          let_('e', add('p', litLen(t.open))),
          ...guard,
          set('e', this.find('e', t.close)),
          if_(ge('e', len('s')), [NONE]),
          ret(add('e', litLen(t.close))),
        ]);
      }
      case 'pattern':
        return sig(name, `${t.name} is scanned by its token pattern.`, this.nonEmpty(this.exact(t.pattern)));
    }
  }
}

// The scanned tokens: every lexer token except the template token, which the target's template
// state machine scans.
export function scannedTokens(ir: Pick<ParserIR, 'tokens' | 'tpl'>): LexTok[] {
  return ir.tokens.filter((t) => t.name !== ir.tpl?.token);
}

// The literals a token of `t` can be: those of `lits` its text may equal, by the token's shape (a
// superset). An empty list proves the token's literal id is 0 whatever its text, so a lexer records
// 0 for it without looking its text up. An identifier(-prefixed) token's text may go on past its
// pattern with non-ASCII ID_Continue characters, so a literal with a non-ASCII character is kept.
export function tokenLiterals(ir: Pick<ParserIR, 'identToken' | 'identLike'>, t: LexTok, lits: readonly string[]): string[] {
  const ext = t.name === ir.identToken || ir.identLike.includes(t.name);
  const wide = (l: string) => [...l].some((c) => !oneUnit(c) || c.charCodeAt(0) > 127);
  const inR = (rs: CodeRange[], c: number) => rs.some(([lo, hi]) => c >= lo && c <= hi);
  const span = (l: string, open: string, close: string) => l.length >= open.length + close.length && l.startsWith(open) && l.endsWith(close);
  const may = (l: string): boolean => {
    if (ext && wide(l)) return true;
    switch (t.kind) {
      case 'run': return wide(l) || (l.length > 0 && inR(t.first, l.charCodeAt(0)) && [...l.slice(1)].every((c) => inR(t.cont, c.charCodeAt(0))));
      case 'runBail': case 'pattern': return mayMatchText(t.pattern, l);
      case 'string': return span(l, t.delim, t.delim);
      case 'line': return l.startsWith(t.prefix);
      case 'block': return span(l, t.open, t.close);
    }
  };
  return lits.filter(may);
}

// The literals each piece of a template literal can be, by its delimiters (a superset, as
// tokenLiterals): the whole literal and the head run from the opener, the middle and the tail
// from a hole's closer; the whole literal and the tail end at the opener, the head and the middle
// at a hole's opener.
export function templateLiterals(ir: Pick<ParserIR, 'tpl'>, lits: readonly string[]): { whole: string[]; head: string[]; middle: string[]; tail: string[] } {
  const t = ir.tpl;
  if (!t) return { whole: [], head: [], middle: [], tail: [] };
  const span = (open: string, close: string) => lits.filter((l) => l.length >= open.length + close.length && l.startsWith(open) && l.endsWith(close));
  return { whole: span(t.open, t.open), head: span(t.open, t.interpOpen), middle: span(t.interpClose, t.interpOpen), tail: span(t.interpClose, t.open) };
}

type Family = { sets: CharSet[]; fns: Fn[]; runs: boolean; finds: boolean };
const families = new WeakMap<ParserIR, Family>();
export function lexScanFamily(ir: ParserIR): Family {
  let f = families.get(ir);
  if (!f) {
    const b = new LexScan();
    for (const t of scannedTokens(ir)) b.fns.push({ ...b.scanner(t, ir.identLike.includes(t.name)), inline: true });
    if (ir.identLike.length) {
      b.fns.push({ name: UNI_CLASS, doc: '', params: [{ name: 'cp', ty: 'int' }], ret: ['int'], body: [], extern: true });
      b.fns.push(b.identEsc());
    }
    if (ir.tpl) b.fns.push(b.tplSpan(ir.tpl));
    f = { sets: b.sets, fns: b.fns, runs: b.runs, finds: b.finds };
    families.set(ir, f);
  }
  return f;
}

export function emitLexScan(ir: ParserIR, lowering: Lowering): string {
  const { sets, fns, runs, finds } = lexScanFamily(ir);
  return [...(runs ? [lowering.runEndFn] : []), ...(finds ? [lowering.findFn] : []), printFns(lowering, lowering.spliceInline ? fns.filter((f) => !f.inline) : fns, sets)].join('\n');
}

// Scanners return -1 or a position, never this.
const UNSET = -2;

// The scanner for `token` as statements in the caller's scope: `out` is declared and left holding
// what the scanner returns for source `s` at position `p` (the caller's variables).
export function emitScanInline(ir: ParserIR, lowering: Lowering, token: string, at: { s: string; p: string; out: string }): string[] {
  const { sets, fns } = lexScanFamily(ir);
  const f = fns.find((g) => g.name === scannerName(token));
  if (!f) throw new Error(`lex-family: no scanner for ${token}`);
  return printStmts(lowering, fns, sets, [{ name: at.s, ty: 'str' }, { name: at.p, ty: 'int' }], inlineFn(f, [at.s, at.p], at.out, UNSET));
}
