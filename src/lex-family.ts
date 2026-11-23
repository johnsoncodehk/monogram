// Lexer scan family: how far each token of a grammar extends from a position, authored once and
// printed for each target through the `Lowering` it registers with `defineTarget`.
//
// Every scanner is `(s, p) -> end`, with end > p for a match and -1 for none (a negative p never
// matches); an identifier whose escapes spell no IdentifierName is the lexer error -2 - e, for the
// token s[p, e) (as the template span reports its errors). An identifier(-like) token's scanner checks a match that came from the token pattern
// rather than the ASCII run (the branch that can take a `\u` escape) with `IDENT_ESC`, out of
// line, so an ASCII-run identifier pays nothing. A token pattern means what its regex means (the
// interpreter's lexer runs that regex):
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

import { type ElementPlan, type LexTok, type ParserIR, buildLexDispatchPlan, buildLexIdPlan, elementTokens, kidOf, lexTokFirstBytes, lidOf, punctFirstBytes } from './emit-portable.ts';
import type { TokenCharClassItem, TokenPattern } from './types.ts';
import { relexMode } from './relex-family.ts';
import { type CharSet, type CodeRange, type Expr, type Fn, type Lowering, type Stmt, inlineFn, printFns, printStmts } from './algo-ir.ts';
import { ACCEPT, ALL, type CSet, committed, complement, contOf, examinedUnits, exitsWhereBodyStops, failRead, info, intersect, mayMatchText, oneChar, oneEnd, overRead, overTrigger, union } from './lex-match-plan.ts';
import { oneUnit } from './text-units.ts';

type Ex = Expr | string;
const x = (e: Ex): Expr => (typeof e === 'string' ? { k: 'var', name: e } : e);
const I = (v: number): Expr => ({ k: 'int', v });
const F: Expr = { k: 'bool', v: false };
const T: Expr = { k: 'bool', v: true };
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
const call4 = (fn: string, ...args: Ex[]): Expr => ({ k: 'call', fn, args: args.map(x) });
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
// An identifier's escape check, (s, p, q, e) -> int (see identEsc).
export const IDENT_ESC = 'lexIdentEsc';
// The target's Unicode identifier class of a code point, (cp) -> int: 0 neither, 1
// IdentifierPart only, 2 IdentifierStart too (uni-ident.ts). The target prints it.
export const UNI_CLASS = 'lexUniClass';
/** The template span scanner (see `tplSpan`). */
export const TPL_SPAN = 'lexTplSpan';

const sig = (name: string, doc: string, body: Stmt[]): Fn => ({ name, doc, params: [{ name: 's', ty: 'str' }, { name: 'p', ty: 'int' }], ret: ['int'], body });

class LexScan {
  sets: CharSet[] = [];
  fns: Fn[] = [];
  runs = false;    // some scanner calls the target's runEnd routine
  finds = false;   // some scanner calls the target's find routine
  stopSets = new Map<string, number[]>();   // the sets of stops some scanner's findAny takes
  private pats = new Map<string, string>();

  runEnd(set: string, i: Ex): Expr {
    this.runs = true;
    return { k: 'runEnd', set, s: x('s'), i: x(i) };
  }

  find(i: Ex, lit: string): Expr {
    this.finds = true;
    return { k: 'find', s: x('s'), i: x(i), lit };
  }

  findAny(i: Ex, stops: number[]): Expr {
    this.stopSets.set(JSON.stringify(stops), stops);
    return { k: 'findAny', s: x('s'), i: x(i), stops };
  }

  charSet(name: string, rs: CodeRange[]): string {
    this.sets.push({ name, ranges: rs.filter(([lo]) => lo <= 127).map(([lo, hi]) => [Math.max(0, lo), Math.min(127, hi)]) });
    return name;
  }

  // The table of a set of ASCII units a read-end routine runs over: one per distinct set, cold.
  private units = new Map<string, string>();
  unitSet(rs: CodeRange[]): string {
    const key = JSON.stringify(rs);
    let name = this.units.get(key);
    if (!name) {
      name = `lexUnits${this.units.size}`;
      this.units.set(key, name);
      this.sets.push({ name, ranges: rs.map(([lo, hi]) => [Math.max(0, lo), Math.min(127, hi)]), cold: true });
    }
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
        // A character beyond ASCII begins with a unit >= 128 in every target's units, so the
        // class's wide characters are compared only there.
        const beyond = (then: Stmt[]): Stmt[] => (wide.length ? [if_(ge('c', I(128)), then)] : []);
        if (p.negate) return [...head, if_(m, [NONE]), ...beyond(wide.map((ch) => if_(hasAt('p', ch), [NONE]))), ret(add('p', I(1)))];
        return [...head, if_(m, [ret(add('p', I(1)))]), ...beyond(wide.map((ch) => if_(hasAt('p', ch), [ret(add('p', litLen(ch)))]))), NONE];
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

  // The exclusive end of what a failed attempt of t at p read (tokLook: its failRead is more than
  // a few units). The fixed leading items of the pattern are walked as the matcher took them, so
  // an attempt that failed among them reports only what it read there; past them, the attempt
  // read at most up to and including the first unit no path can go past, or the end of the source.
  readEnd(t: LexTok): Fn {
    const name = readEndName(t.name);
    const end1 = add(len('s'), I(1));
    const doc = `${t.name}: where what a failed attempt at p read ends.`;
    const mk = (body: Stmt[]): Fn => ({ ...sig(name, doc, [if_(lt('p', I(0)), [ret(I(0))]), ...body]), cold: true });
    switch (t.kind) {
      case 'string': return mk([if_(and(lt('p', len('s')), eq(code('p'), I(t.delim.charCodeAt(0)))), [ret(end1)]), ret(add('p', I(1)))]);
      case 'block': return mk([if_(hasAt('p', t.open), [ret(end1)]), ret(add('p', litLen(t.open)))]);
      case 'line': return mk([ret(add('p', litLen(t.prefix)))]);
      case 'run': return mk([ret(add('p', I(1)))]);
      case 'runBail': case 'pattern': {
        const items = typeof t.pattern !== 'string' && t.pattern.type === 'seq' ? t.pattern.items : [t.pattern];
        const body: Stmt[] = [let_('q', 'p')];
        let k = 0;
        for (; k < items.length; k++) {
          const it = items[k]!;
          if (typeof it === 'string' && it !== '') {
            body.push(if_(not(hasAt('q', it)), [ret(add('q', litLen(it)))]), set('q', add('q', litLen(it))));
          } else if (typeof it !== 'string' && it.type === 'charClass' && classParts(it.items).wide.length === 0 && !it.negate) {
            body.push(if_(ge('q', len('s')), [ret(add('q', I(1)))]), if_(not(inRanges(code('q'), classParts(it.items).narrow)), [ret(add('q', I(1)))]), set('q', add('q', I(1))));
          } else break;
        }
        const ex = examinedUnits({ type: 'seq', items: items.slice(k) });
        const stop = intersect(complement(ex), [[0, 0xffff]]);
        const stopUnits = stop.flatMap(([a, b]) => (b - a < 8 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [-1]));
        if (stop.length === 0 && k === 0) return mk([ret(end1)]);
        if (stop.length === 0) body.push(ret(end1));
        else if (stopUnits.length <= 4 && stopUnits.every((c) => c >= 0 && (c < 0xd800 || c > 0xdfff))) body.push(ret(add(this.findAny('q', stopUnits), I(1))));
        else {
          // The run of the units it can pass: an ASCII unit by its table (one per distinct set, shared
          // by the tokens that read alike), a unit beyond ASCII only when some path can take one
          // (each of its units is >= 128).
          const ascii = intersect(ex, [[0, 127]]), wide = intersect(ex, [[128, 0x10ffff]]).length > 0;
          const units = this.unitSet(ascii);
          body.push(
            while_(lt('q', len('s')), [
              let_('c', code('q')),
              if_(not(wide ? or(inSet(units, 'c'), ge('c', I(128))) : inSet(units, 'c')), [BREAK]),
              set('q', add('q', I(1))),
            ]),
            ret(add('q', I(1))),
          );
        }
        return mk(body);
      }
    }
  }

  // A pattern match that consumed nothing is no token. An identifier's pattern match is checked
  // for its escapes: the match and the check are one cold function of the token (`escScan`), so the
  // scanner, which the dispatch loop inlines, keeps the shape of a plain pattern call.
  private nonEmpty(m: string): Stmt[] {
    return this.esc === null ? [let_('e', call(m, 'p')), if_(gt('e', 'p'), [ret('e')]), NONE] : [ret(call(this.escScan(m), 'p'))];
  }
  // The same after a run that stopped at a bail character (e is already bound).
  private fallback(m: string): Stmt[] {
    return this.esc === null ? [set('e', call(m, 'p')), if_(gt('e', 'p'), [ret('e')]), NONE] : [ret(call(this.escScan(m), 'p'))];
  }
  // The identifier prefix of the token being scanned (null: not identifier-like), and its name.
  private esc: string | null = null;
  private escTok = '';
  private escScan(m: string): string {
    const name = `${scannerName(this.escTok)}Esc`, q = this.esc ? add('p', litLen(this.esc)) : x('p');
    if (!this.fns.some((f) => f.name === name)) {
      this.fns.push({
        name, cold: true, doc: `${this.escTok}: its token pattern's match, whose escapes must spell IdentifierName characters.`,
        params: [{ name: 's', ty: 'str' }, { name: 'p', ty: 'int' }], ret: ['int'],
        body: [let_('e', call(m, 'p')), if_(gt('e', 'p'), [ret(call4(IDENT_ESC, 's', 'p', q, 'e'))]), NONE],
      });
    }
    return name;
  }

  // A negative p is no position in s. Ruling it out first also tells native compilers that every
  // index the scanner reads is non-negative, so they can drop per-character bounds checks.
  // `esc`: t's identifier prefix when it is an identifier(-like) token (see the header), else null.
  scanner(t: LexTok, esc: string | null): Fn {
    this.esc = esc;
    this.escTok = t.name;
    const f = this.scanBody(t);
    this.esc = null;
    return { ...f, body: [if_(lt('p', I(0)), [NONE]), ...f.body] };
  }

  // Whether the identifier text s[q, e) (after its prefix), as its token pattern matched it, spells
  // an IdentifierName: every `\u` escape decodes to an IdentifierStart (the first character) or an
  // IdentifierPart character. As the interpreter's lexIdentValid, which matches the decoded text,
  // a high-surrogate escape followed by a low-surrogate escape is the one character they spell.
  // Returns e; when the text is no IdentifierName, the lexer error -2 - e.
  // Cold: only a token whose pattern match went past the ASCII run calls it.
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
    const BAD = ret(sub(I(-2), 'e'));
    return {
      name: IDENT_ESC, cold: true,
      doc: 'Whether an identifier spells its escapes as IdentifierName characters: e, else the lexer error -2 - e.',
      params: [{ name: 's', ty: 'str' }, { name: 'p', ty: 'int' }, { name: 'q', ty: 'int' }, { name: 'e', ty: 'int' }],
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
            if_(or(inR('cp', 0xd800, 0xdfff), gt('cp', I(0x10ffff))), [BAD]),
            if_(lt({ k: 'call', fn: UNI_CLASS, args: [x('cp')] }, 'need'), [BAD]),
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
            ...this.fallback(m),
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
        return sig(name, `${t.name}: ${t.prefix}, then up to its first stop.`, [
          if_(not(hasAt('p', t.prefix)), [NONE]),
          ret(this.findAny(add('p', litLen(t.prefix)), t.stops)),
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

// ── What a token's decision reads past its own end (the relex window's lookahead plan) ──
//
// A token is decided by its own match and by the failed attempts, at its start, of the candidates
// its dispatch arm tries before its own. The relex window (src/relex-family.ts) may keep a token
// before an edit only if nothing that decided it read the edited text. Every read within the
// token's end + 1 is covered by the window's margin; this plan names the reads that can go
// further, from each token's shape (src/lex-match-plan.ts for a pattern):
// - `failRead`: the most units a failed attempt reads from the token's start (-1: cannot fail);
// - `over`: the most units a successful match reads at or after its end;
// - `trig`: the units at the end at which a match can read more than one unit past it;
// - `examined`: the units any attempt can read and go past (a read stops at the first unit
//   outside it, which it reads).
export type TokLook = { failRead: number; over: number; trig: CSet; examined: CSet };
const ranges = (rs: CodeRange[]): CSet => union(rs.map(([a, b]) => [a, b]), []);
const litUnits = (s: string): CSet => union([...s].map((c) => [c.charCodeAt(0), c.charCodeAt(0)]), []);
export function tokLook(t: LexTok): TokLook {
  const pat = (p: TokenPattern, fast: number): TokLook => ({
    failRead: Math.max(fast, failRead(p)), over: Math.max(fast, overRead(p)), trig: overTrigger(p), examined: examinedUnits(p),
  });
  switch (t.kind) {
    case 'run': return { failRead: 1, over: 1, trig: [], examined: union(ranges(t.first), ranges(t.cont)) };
    // The ASCII run reads the unit it stops at; a bail goes to the pattern.
    case 'runBail': { const l = pat(t.pattern, 1); return { ...l, examined: union(l.examined, union(ranges(t.first), ranges(t.cont))) }; }
    // Unterminated, it reads to the end of the source; a match ends at its closing delimiter.
    case 'string': return { failRead: Infinity, over: 0, trig: [], examined: ALL };
    case 'block': return { failRead: Infinity, over: 0, trig: [], examined: ALL };
    // After its prefix it cannot fail: it ends at its first stop or the end, which it reads.
    case 'line': return { failRead: t.prefix.length, over: 1, trig: [], examined: union(litUnits(t.prefix), complement(t.stops.map((c) => [c, c]))) };
    case 'pattern': return pat(t.pattern, 0);
  }
}

// A failed attempt that reads more than this many units from the token's start may read past the
// end + 1 of the token decided after it (which takes at least one unit).
const FREE_FAIL = 3;
// A match that reads more than this many units at or after its end may read past end + 1.
const FREE_OVER = 2;

export const readEndName = (tok: string): string => `lexReadEnd${ident(tok)}`;

/** The relex window's lookahead plan of a grammar's lexer.
 *  `arms`: each dispatch arm (its ASCII first units; `null` for a non-ASCII first unit) in which
 *  a candidate whose failed attempt can read past the decided token's end + 1 is tried before
 *  another candidate: its candidates in order up to the last such one (`tok` null for
 *  punctuation), that one with the name of its read-end routine, of the source and a position, (the exclusive
 *  end of what its failed attempt at p read). `over`: the tokens whose match can read past their
 *  end + 1. `reach`: every unit any of those reads can go past. */
export type LookPlan = {
  arms: { units: number[] | null; cands: { tok: string | null; readEnd: string | null }[] }[];
  over: { tok: string; trig: CSet; examined: CSet }[];
  reach: CSet;
};
const lookPlans = new WeakMap<ParserIR, LookPlan>();
export function lexLookPlan(ir: ParserIR): LookPlan {
  const known = lookPlans.get(ir);
  if (known) return known;
  const plan: LookPlan = { arms: [], over: [], reach: [] };
  lookPlans.set(ir, plan);
  // Only the windowed relex keeps tokens before an edit.
  if (!relexMode(ir).window) return plan;
  const toks = scannedTokens(ir);
  const looks = toks.map(tokLook);
  // The candidate order of every target's dispatch: the scanned tokens, then the punctuation.
  const firsts = [...toks.map(lexTokFirstBytes), ...ir.puncts.map(punctFirstBytes)];
  const { arms, fallbackIndices } = buildLexDispatchPlan(firsts);
  let reachSet: CSet = [];
  // A failed candidate decides a token only if another one may still match after it: a later
  // candidate of the arm, or, for a non-ASCII unit, the Unicode identifier fallback.
  const armOf = (units: number[] | null, idx: number[], after: boolean): void => {
    const noted = idx.map((i, k) => i < toks.length && looks[i]!.failRead > FREE_FAIL && (k < idx.length - 1 || after));
    const lastNoted = noted.lastIndexOf(true);
    if (lastNoted < 0) return;
    plan.arms.push({
      units,
      cands: idx.slice(0, lastNoted + 1).map((i, k) => ({ tok: i < toks.length ? toks[i]!.name : null, readEnd: noted[k] ? readEndName(toks[i]!.name) : null })),
    });
    for (let k = 0; k <= lastNoted; k++) if (noted[k]) reachSet = union(reachSet, looks[idx[k]!]!.examined);
  };
  for (const a of arms) armOf(a.bytes, a.indices, false);
  armOf(null, fallbackIndices, !!ir.identToken);
  toks.forEach((t, i) => {
    const l = looks[i]!;
    if (l.over > FREE_OVER && l.trig.length > 0) { plan.over.push({ tok: t.name, trig: l.trig, examined: l.examined }); reachSet = union(reachSet, l.examined); }
  });
  plan.reach = reachSet;
  return plan;
}

// The scanned tokens: every lexer token except the template token, which the target's template
// state machine scans, and an element region's own tokens, which only its frames scan.
export function scannedTokens(ir: Pick<ParserIR, 'tokens' | 'tpl'> & { elements?: ElementPlan | null }): LexTok[] {
  const region = new Set(elementTokens(ir.elements ?? null));
  return ir.tokens.filter((t) => t.name !== ir.tpl?.token && !region.has(t.name));
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

// ---- element regions (ElementPlan; docs/REGIONS.md; the interpreter's emit-lexer.ts is the oracle) ----
//
// A frame on the lexer's frame stack (the template-hole stack of a grammar with elements) is one
// int, low 2 bits its kind: 0 template hole and 1 element hole, each with its brace count in the
// bits above (step 4); 2 element frame, with its sub-state in bits 2-3 (0 children, 1 open tag,
// 2 close tag) and its open-element count above (step 16); 3 is free (raw text). An element
// entered from code pushes 6 (an element frame in an open tag).
export const EL_FRAME_FN = 'lexElFrame';
export const EL_OPENS_FN = 'lexElOpens';
export const EL_REACH_FN = 'lexElReach';
export const EL_RAW_FN = 'lexElRaw';
export const EL_TAG_START_FN = 'lexElTagStart';
export const EL_TEXT_STOP_FN = 'lexElTextStop';
export const EL_TRIVIA_FN = 'lexElTrivia';
export const EL_DIR_OPEN_FN = 'lexElDirOpen';
export const EL_DIR_CONT_FN = 'lexElDirCont';
// A directive frame (an element frame in sub-state 3) with its head's paren depth d: count d + 1.
// A body is count 0 (14). The frame step's `frame` -2: pop the frame, which ended no element.
// The kid the frame step returns for a skipped text token (a comment in text): no token is pushed.
export const EL_SKIP = -1;
// What the type-parameter vetoes decide at a tagOpen at an operand position (EL_OPENS_FN).
export const EL_NOT = 0, EL_OPEN = 1, EL_SPECULATE = 2;

const shr = (a: Ex, b: Ex): Expr => ({ k: 'bin', op: 'shr', a: x(a), b: x(b) });
const retN = (...es: Ex[]): Stmt => ({ k: 'return', es: es.map(x) });

function elementFns(ir: ParserIR, e: ElementPlan, b: LexScan): Fn[] {
  const ids = buildLexIdPlan(ir);
  const fns: Fn[] = [];
  const tokOf = (name: string): LexTok => ir.tokens.find((t) => t.name === name)!;
  // Called from the frame step only, so never spliced into a dispatch site.
  for (const name of [...(e.text ? [e.text] : []), ...e.tagTokens]) fns.push(b.scanner(tokOf(name), null));
  // A tag token whose failed attempt reads further than its decided successor's end + 1 widens the
  // lexer's look end (the tokens before it record one level deeper: docs/REGIONS.md, Relex).
  const tagLooks = e.tagTokens.map((name) => tokLook(tokOf(name)).failRead > FREE_FAIL);
  e.tagTokens.forEach((name, i) => { if (tagLooks[i]) fns.push(b.readEnd(tokOf(name))); });
  // Whether a token can begin at p (its first units; any beyond ASCII when it may begin there):
  // an attempt where it cannot reads only the unit at p.
  const mayBegin = (name: string): Expr => {
    const fb = lexTokFirstBytes(tokOf(name));
    if (!fb) return T;
    return and(lt('p', len('s')), any([...fb.bytes.map((u) => eq(code('p'), I(u))), ...(fb.nonAscii ? [ge(code('p'), I(128))] : [])]));
  };
  const L = litLen(e.tagOpen);
  // Whether a tagOpen at p opens a tag (tagStart: the unit after it is in the class); every place
  // that opens one tests it, the entry from code included (the printers call it there).
  const opensTag = (at: Ex): Expr => (e.tagStart ? and(hasAt(at, e.tagOpen), { k: 'call', fn: EL_TAG_START_FN, args: [x('s'), add(at, L)] }) : hasAt(at, e.tagOpen));
  if (e.tagStart) fns.push({
    name: EL_TAG_START_FN,
    doc: 'Whether the unit at p may follow a tagOpen that opens a tag (elements.tagStart).',
    params: [{ name: 's', ty: 'str' }, { name: 'p', ty: 'int' }], ret: ['bool'],
    body: [if_(ge('p', len('s')), [{ k: 'return', es: [F] }]), let_('c', code('p')), { k: 'return', es: [inRanges('c', e.tagStart)] }],
  });
  // The children's text tokens (ElementPlan.textTokens): each its scanner's own copy (a scanned
  // token's scanner may be spliced into the dispatch, unprinted); a failed attempt that reads past
  // the end + 1 of the token decided after it, and a match that reads past its own end + 1, are
  // recorded in the look end (an unterminated block comment in text reads to the end of the file).
  const copies = new Map<string, { name: string; rd: string | null; begin: (at: Ex) => Expr }>();
  const scanCopy = (token: string, role: string) => {
    let c = copies.get(token);
    if (c) return c;
    const t = tokOf(token), l = tokLook(t);
    if (!scannedTokens(ir).some((s) => s.name === token)) throw new Error(`portable: ${role}: '${token}' is not a scanned token`);
    if (l.over > FREE_OVER && l.trig.length > 0) throw new Error(`portable: ${role}: '${token}' reads past its end + 1 when it matches (no record of that read yet)`);
    const fb = lexTokFirstBytes(t);
    if (!fb || fb.nonAscii) throw new Error(`portable: ${role}: '${token}' may begin beyond ASCII (a run is tested at every unit)`);
    const name = `lexElScan${ident(token)}`;
    fns.push({ ...b.scanner(t, null), name, inline: false });
    const rd = l.failRead > FREE_FAIL ? readEndName(token) : null;
    if (rd && !fns.some((f) => f.name === rd)) fns.push(b.readEnd(t));
    c = { name, rd, begin: (at: Ex) => and(lt(at, len('s')), any(fb.bytes.map((u) => eq(code(at), I(u))))) };
    copies.set(token, c);
    return c;
  };
  const tts = e.textTokens.map(({ token, after }) => ({ ...scanCopy(token, 'text token'), kid: kidOf(ids, token), skip: tokOf(token).skip, after }));
  const ttFail = (t: (typeof tts)[number], at: Ex, k: string): Stmt[] => (t.rd ? [let_(k, call(t.rd, at)), if_(gt(k, 'look'), [set('look', k)])] : []);
  const D = e.directives;
  if (D && !ir.regexCtx) throw new Error('portable: element directives need the regex context');
  const dirBegin = (at: Ex): Expr => and(lt(at, len('s')), any([...new Set(D!.open.map((r) => r.lit.charCodeAt(0)))].map((u) => eq(code(at), I(u)))));
  const callLook = (names: [string, string], fn: string, at: Ex): Stmt => ({ k: 'setCall', names, call: { k: 'call', fn, args: [x('s'), x(at), x('look')] } });
  if (D) {
    // Code trivia after a directive literal: whitespace and the grammar's skip tokens (a failed
    // skip attempt's read recorded, as the scan matcher's).
    const ws = b.exact(D.ws);
    const skips = scannedTokens(ir).filter((t) => t.skip).map((t) => scanCopy(t.name, 'directive trivia'));
    const body: Stmt[] = [let_('look', 'look0'), let_('p', 'p0'), let_('more', I(1)), while_(ne('more', I(0)), [
      set('more', I(0)), set('p', call(ws, 'p')),
      if_(lt('p', len('s')), [
        let_('moved', I(0)),
        ...skips.map((k, i) => if_(and(eq('moved', I(0)), k.begin('p')), [
          let_(`m${i}`, call(k.name, 'p')),
          if_(gt(`m${i}`, 'p'), [set('p', `m${i}`), set('moved', I(1))], k.rd ? [let_(`r${i}`, call(k.rd, 'p')), if_(gt(`r${i}`, 'look'), [set('look', `r${i}`)])] : undefined),
        ])),
        if_(ne('moved', I(0)), [set('more', I(1))]),
      ]),
    ]), retN('p', 'look')];
    fns.push({ name: EL_TRIVIA_FN, doc: 'Where code trivia (whitespace, skip tokens) from p0 ends, and the look end.', params: [{ name: 's', ty: 'str' }, { name: 'p0', ty: 'int' }, { name: 'look0', ty: 'int' }], ret: ['int', 'int'], body });
    // A directive literal of a table at q (after whitespace, for a continuation), not running on
    // into an identifier, followed by one of its required literal sequences (trivia between): its
    // row, or -1; what it read is recorded (a comment in the trivia can reach the end of the file).
    const idc = (at: Ex): Expr => and(lt(at, len('s')), inRanges(code(at), D.idCont));
    const table = (name: string, rows: typeof D.open, lead: boolean): void => {
      const body: Stmt[] = [let_('look', 'look0'), let_('p0', lead ? call(ws, 'q') : 'q'), let_('far', add('p0', I(1))), let_('hit', I(-1))];
      rows.forEach((r, i) => {
        const e0 = `e${i}`;
        const seqs: Stmt[] = r.nexts.map((nx, j) => {
          const pv = `p${i}_${j}`, ok = `ok${i}_${j}`;
          if (!nx.length) return if_(lt('hit', I(0)), [set('hit', I(i))]);
          return if_(lt('hit', I(0)), [
            let_(pv, e0), let_(ok, I(1)),
            ...nx.map((l) => if_(ne(ok, I(0)), [
              { k: 'setCall', names: [pv, 'look'], call: { k: 'call', fn: EL_TRIVIA_FN, args: [x('s'), x(pv), x('look')] } } as Stmt,
              if_(gt(add(add(pv, litLen(l.lit)), I(1)), 'far'), [set('far', add(add(pv, litLen(l.lit)), I(1)))]),
              if_(l.word ? or(not(hasAt(pv, l.lit)), idc(add(pv, litLen(l.lit)))) : not(hasAt(pv, l.lit)), [set(ok, I(0))], [set(pv, add(pv, litLen(l.lit)))]),
            ])),
            if_(ne(ok, I(0)), [set('hit', I(i))]),
          ]);
        });
        body.push(if_(and(lt('hit', I(0)), hasAt('p0', r.lit)), [
          let_(e0, add('p0', litLen(r.lit))),
          if_(gt(add(e0, I(1)), 'far'), [set('far', add(e0, I(1)))]),
          ...(r.word ? [if_(not(idc(e0)), seqs)] : seqs),
        ]));
      });
      body.push(if_(gt('far', 'look'), [set('look', 'far')]), retN('hit', 'look'));
      fns.push({ name, doc: `The ${lead ? 'continuation' : 'opener'} row at q (-1: none), and the look end.`, params: [{ name: 's', ty: 'str' }, { name: 'q', ty: 'int' }, { name: 'look0', ty: 'int' }], ret: ['int', 'int'], body });
    };
    table(EL_DIR_OPEN_FN, D.open, false);
    if (D.cont.length) table(EL_DIR_CONT_FN, D.cont, true);
  }
  if (tts.length || D) {
    // Inside a run (q past its first unit): whether a text token starts at q (its `after` class
    // permitting), or a directive opener does, so the run stops before it; its match is lexed at
    // the next run's start.
    const body: Stmt[] = [let_('look', 'look0')];
    tts.forEach((t, i) => body.push(if_(t.after ? and(t.begin('q'), inRanges(code(sub('q', I(1))), t.after)) : t.begin('q'), [
      if_(gt(call(t.name, 'q'), 'q'), [retN(I(1), 'look')]), ...ttFail(t, 'q', `r${i}`),
    ])));
    if (D) body.push(if_(dirBegin('q'), [let_('d', I(0)), callLook(['d', 'look'], EL_DIR_OPEN_FN, 'q'), if_(ge('d', I(0)), [retN(I(1), 'look')])]));
    body.push(retN(I(0), 'look'));
    fns.push({ name: EL_TEXT_STOP_FN, doc: 'Whether a text token starts at q inside a text run (1), and the look end.', params: [{ name: 's', ty: 'str' }, { name: 'q', ty: 'int' }, { name: 'look0', ty: 'int' }], ret: ['int', 'int'], body });
  }
  const stopAt = (at: Ex): Stmt => ({ k: 'setCall', names: ['hit', 'look'], call: { k: 'call', fn: EL_TEXT_STOP_FN, args: [x('s'), x(at), x('look')] } });
  // The frame step (the frame fr on top is an element frame): what the frame lexes at p, before
  // the ordinary scan. Returns (end, kid, lid, frame, push, angle, look): end -1 when the frame
  // lexes nothing there (the ordinary scan lexes p); else the token [p, end) of kind kid and
  // literal lid, the top frame's new value (-1: pop it, after the token), a frame to push after
  // it (0: none), the new type-argument depth in the tag, and the look end.
  const NO = retN(I(-1), I(0), I(0), 'fr', I(0), 'angle', 'look');
  const tagEnd = (self: boolean): Stmt[] => [
    let_('count', shr('fr', I(4))),
    ...(self ? [] : [if_(eq('sb', I(1)), [set('count', add('count', I(1)))], [set('count', sub('count', I(1)))])]),
    if_(le('count', I(0)), [set('top', I(-1))], [set('top', add(shl('count', I(4)), I(2)))]),
  ];
  const tok = (end: Ex, kid: number, lid: number, top: Ex, push: number, angle: Ex): Stmt => retN(end, I(kid), I(lid), top, I(push), angle, 'look');
  const kidE = (n: string) => kidOf(ids, n), lidE = (l: string) => lidOf(ids, l);
  // a directive frame for the head beginning here (its paren depth + 1 in the count)
  const headFrame = add(shl(add('depth', I(1)), I(4)), I(14));
  const children: Stmt[] = [
    if_(opensTag('p'), [
      // in a directive body a tag opens a frame of its own; a close tag closes none of the body's
      ...(D ? [if_(eq('sb', I(3)), [
        if_(hasAt(add('p', L), e.closeMarker), [tok(add(add('p', L), litLen(e.closeMarker)), kidE(e.closeTag), 0, 'fr', 10, I(0))]),
        tok(add('p', L), 0, lidE(e.tagOpen), 'fr', 6, I(0)),
      ])] : []),
      if_(hasAt(add('p', L), e.closeMarker), [tok(add(add('p', L), litLen(e.closeMarker)), kidE(e.closeTag), 0, add('fr', I(8)), 0, I(0))]),
      tok(add('p', L), 0, lidE(e.tagOpen), add('fr', I(4)), 0, I(0)),
    ]),
    if_(hasAt('p', e.holeOpen), [tok(add('p', litLen(e.holeOpen)), 0, lidE(e.holeOpen), 'fr', 1, 'angle')]),
  ];
  if (D) {
    const LC = litLen(e.holeClose);
    // a body's closer: then a continuation (the frame is a head again) or the directive's end
    children.push(if_(and(eq('sb', I(3)), hasAt('p', e.holeClose)), [
      let_('c', I(-1)),
      ...(D.cont.length ? [callLook(['c', 'look'], EL_DIR_CONT_FN, add('p', LC))] : []),
      if_(ge('c', I(0)), [retN(add('p', LC), I(0), I(lidE(e.holeClose)), headFrame, I(0), 'angle', 'look')]),
      retN(add('p', LC), I(0), I(lidE(e.holeClose)), I(-2), I(0), 'angle', 'look'),
    ]));
    // an opener: its frame is pushed before its token (end p: no token), which the ordinary scan
    // then lexes inside it; a code block opener pushes an element hole
    const nOpen = D.open.filter((r) => !r.block).length;
    children.push(if_(dirBegin('p'), [
      let_('o', I(0)), callLook(['o', 'look'], EL_DIR_OPEN_FN, 'p'),
      if_(ge('o', I(0)), [
        ...(nOpen < D.open.length ? [if_(ge('o', I(nOpen)), [retN('p', I(0), I(0), 'fr', I(1), 'angle', 'look')])] : []),
        retN('p', I(0), I(0), 'fr', headFrame, 'angle', 'look'),
      ]),
    ]));
  }
  tts.forEach((t, i) => children.push(if_(t.begin('p'), [
    let_(`x${i}`, call(t.name, 'p')),
    if_(gt(`x${i}`, 'p'), [t.skip ? retN(`x${i}`, I(EL_SKIP), I(0), 'fr', I(0), 'angle', 'look') : tok(`x${i}`, t.kid, 0, 'fr', 0, 'angle')]),
    ...ttFail(t, 'p', `y${i}`),
  ])));
  if (e.text && (tts.length || D)) {
    // the run: the text token's class runs (joined by every tagOpen that opens no tag), up to the
    // first unit past its first where a text token starts (the interpreter's lxTextStopAt)
    const join = e.tagStart ? [
      if_(and(hasAt('te', e.tagOpen), not(opensTag('te'))), [
        set('hit', I(0)), if_(gt('te', 'p'), [stopAt('te')]),
        if_(eq('hit', I(0)), [set('te', add('te', L)), set('more', I(1))]),
      ]),
    ] : [];
    children.push(let_('te', 'p'), let_('more', I(1)), let_('hit', I(0)), while_(ne('more', I(0)), [
      set('more', I(0)),
      let_('tm', call(scannerName(e.text), 'te')),
      let_('tr', 'te'), if_(gt('tm', 'te'), [set('tr', 'tm')]),
      let_('q', 'te'), if_(eq('te', 'p'), [set('q', add('p', I(1)))]),
      set('hit', I(0)),
      while_(and(lt('q', 'tr'), eq('hit', I(0))), [stopAt('q'), if_(eq('hit', I(0)), [set('q', add('q', I(1)))])]),
      if_(lt('q', 'tr'), [set('te', 'q')], [set('te', 'tr'), ...join]),
    ]));
    children.push(if_(gt('te', 'p'), [tok('te', kidE(e.text), 0, 'fr', 0, 'angle')]));
  } else if (e.text) {
    children.push(let_('te', call(scannerName(e.text), 'p')));
    // with tagStart the run goes on over every tagOpen that opens no tag
    if (e.tagStart) children.push(if_(lt('te', 'p'), [set('te', 'p')]), while_(and(hasAt('te', e.tagOpen), not(opensTag('te'))), [
      set('te', add('te', L)), let_('tm', call(scannerName(e.text), 'te')), if_(gt('tm', 'te'), [set('te', 'tm')]),
    ]));
    children.push(if_(gt('te', 'p'), [tok('te', kidE(e.text), 0, 'fr', 0, 'angle')]));
  }
  const tag: Stmt[] = [];
  e.tagTokens.forEach((name, i) => tag.push(if_(eq('angle', I(0)), [
    let_(`g${i}`, call(scannerName(name), 'p')),
    if_(gt(`g${i}`, 'p'), [tok(`g${i}`, kidE(name), 0, 'fr', 0, 'angle')]),
    ...(tagLooks[i] ? [if_(mayBegin(name), [let_(`r${i}`, call(readEndName(name), 'p')), if_(gt(`r${i}`, 'look'), [set('look', `r${i}`)])])] : []),
  ])));
  tag.push(
    if_(and(and(eq('sb', I(1)), eq('angle', I(0))), hasAt('p', e.closeMarker + e.tagClose)), [
      ...tagEnd(true), tok(add('p', litLen(e.closeMarker + e.tagClose)), kidE(e.selfClose), 0, 'top', 0, I(0)),
    ]),
    if_(hasAt('p', e.tagClose), [
      if_(gt('angle', I(0)), [tok(add('p', litLen(e.tagClose)), 0, lidE(e.tagClose), 'fr', 0, sub('angle', I(1)))]),
      ...tagEnd(false), tok(add('p', litLen(e.tagClose)), 0, lidE(e.tagClose), 'top', 0, I(0)),
    ]),
    // after the attribute assign an element is a value (`a=<b/>`); elsewhere type arguments
    if_(opensTag('p'), [
      if_('afterEq', [tok(add('p', L), 0, lidE(e.tagOpen), 'fr', 6, I(0))]),
      tok(add('p', L), 0, lidE(e.tagOpen), 'fr', 0, add('angle', I(1))),
    ]),
    if_(and(eq('angle', I(0)), hasAt('p', e.holeOpen)), [tok(add('p', litLen(e.holeOpen)), 0, lidE(e.holeOpen), 'fr', 1, 'angle')]),
  );
  fns.push({
    name: EL_FRAME_FN,
    doc: 'The element frame fr on top of the frame stack lexes at p: (end, kid, lid, frame, push, angle, look).',
    params: [{ name: 's', ty: 'str' }, { name: 'p', ty: 'int' }, { name: 'fr', ty: 'int' }, { name: 'angle', ty: 'int' }, { name: 'afterEq', ty: 'bool' }, { name: 'look0', ty: 'int' }, ...(D ? [{ name: 'depth', ty: 'int' as const }] : [])],
    ret: ['int', 'int', 'int', 'int', 'int', 'int', 'int'],
    body: [
      let_('look', 'look0'),
      let_('top', 'fr'),
      let_('sb', sub(shr('fr', I(2)), shl(shr('fr', I(4)), I(2)))),
      ...(D ? [
        // children, or a directive body (sub-state 3, count 0)
        if_(or(eq('sb', I(0)), and(eq('sb', I(3)), eq(shr('fr', I(4)), I(0)))), [...children, NO]),
        // a directive head (count = its paren depth + 1): code, by the ordinary scan; a hole opener
        // at that depth opens the body, a deeper one an element hole
        if_(eq('sb', I(3)), [
          if_(hasAt('p', e.holeOpen), [
            if_(eq('depth', sub(shr('fr', I(4)), I(1))), [retN(add('p', litLen(e.holeOpen)), I(0), I(lidE(e.holeOpen)), I(14), I(0), 'angle', 'look')]),
            tok(add('p', litLen(e.holeOpen)), 0, lidE(e.holeOpen), 'fr', 1, 'angle'),
          ]),
          NO,
        ]),
      ] : [if_(eq('sb', I(0)), [...children, NO])]),
      ...tag,
      NO,
    ],
  });
  if (e.entry === 'operand' && (e.head || e.signature)) {
    // The type-parameter vetoes at a tagOpen at p where an operand may start: (EL_NOT: a type-
    // parameter list | EL_OPEN: an element | EL_SPECULATE: a signature head, decided by lexing its
    // group as code, and where what decided it was read to (exclusive, len + 1 at the end).
    const body: Stmt[] = [let_('q', add('p', L)), let_('re', I(0))];
    const look = (name: string, pat: Parameters<LexScan['pattern']>[0], verdict: number): void => {
      const rd = b.readEnd({ kind: 'pattern', name, pattern: pat, skip: false });
      fns.push(rd);
      body.push(
        let_(`r_${name}`, call(rd.name, 'q')), if_(gt(`r_${name}`, 're'), [set('re', `r_${name}`)]),
        // the regex's own match (with its backtracking), as the interpreter's LX_TP_HEAD / LX_TP_SIG
        if_(ge(call(b.exact(pat), 'q'), I(0)), [retN(I(verdict), 're')]),
      );
    };
    if (e.head) look('ElHead', e.head, EL_NOT);
    if (e.signature) look('ElSignature', e.signature.pre, EL_SPECULATE);
    body.push(retN(I(EL_OPEN), 're'));
    fns.push({ name: EL_OPENS_FN, doc: 'Whether a tagOpen at p where an operand may start opens an element, and how far that was read.', params: [{ name: 's', ty: 'str' }, { name: 'p', ty: 'int' }], ret: ['int', 'int'], body });
  }
  if (e.rawText.length) {
    // An open tag whose name token is s[a, b) ended at p: its raw body (end, kid), kid 0 when the
    // name is no raw-text name. The body runs to tagOpen + closeMarker + name, or to the end.
    const close = e.tagOpen + e.closeMarker;
    const body: Stmt[] = [];
    const lower = (c: string) => c.toLowerCase(), upper = (c: string) => c.toUpperCase();
    const foldAt = (at: Ex, lit: string): Expr => and(le(add(at, litLen(lit)), len('s')), [...lit].reduce<Expr>((acc, ch, i) => {
      const c = code(add(at, I(i)));
      const one = lower(ch) === upper(ch) ? eq(c, I(ch.charCodeAt(0))) : or(eq(c, I(lower(ch).charCodeAt(0))), eq(c, I(upper(ch).charCodeAt(0))));
      return i === 0 ? one : and(acc, one);
    }, T));
    for (const r of e.rawText) {
      for (const tag of r.tags) {
        if ([...tag].some((ch) => ch.charCodeAt(0) > 127)) throw new Error(`portable: elements.rawText: tag ${JSON.stringify(tag)} is not ASCII`);
        const kid = I(kidOf(ids, r.token));
        const named = and(eq(sub('b', 'a'), litLen(tag)), r.ignoreCase ? foldAt('a', tag) : hasAt('a', tag));
        // the body condition: when it matches at the body's start the children are ordinary
        const unless = r.unless === null ? [] : [if_(ge(call(b.exact(r.unless), 'p'), I(0)), [retN(I(-1), I(0))])];
        body.push(if_(named, [...unless, ...(r.ignoreCase ? [
          let_('q', 'p'),
          while_(and(lt('q', len('s')), not(and(hasAt('q', close), foldAt(add('q', litLen(close)), tag)))), [set('q', add('q', I(1)))]),
          retN('q', kid),
        ] : [retN(b.find('p', close + tag), kid)])]));
      }
    }
    body.push(retN(I(-1), I(0)));
    fns.push({ name: EL_RAW_FN, doc: 'The raw body after an open tag named s[a, b) that ended at p: (end, kid), kid 0 when it has none.', params: [{ name: 's', ty: 'str' }, { name: 'a', ty: 'int' }, { name: 'b', ty: 'int' }, { name: 'p', ty: 'int' }], ret: ['int', 'int'], body });
  }
  if (e.signature) {
    // A signature decided by the token ending at q was read through q + 1, and further by any
    // read that passes q: through the units such a read can pass (LookPlan.reach), and the first
    // unit it cannot, inclusive.
    const reach = lexLookPlan(ir).reach;
    const ascii = reach.filter(([a]) => a <= 127).map(([a, z]): CodeRange => [a, Math.min(127, z)]);
    const wide = reach.some(([, z]) => z >= 128);
    fns.push({
      name: EL_REACH_FN,
      doc: 'Where the reads that decided a type-parameter signature at the token ending at q end (exclusive).',
      params: [{ name: 's', ty: 'str' }, { name: 'q', ty: 'int' }],
      ret: ['int'],
      body: [
        let_('r', 'q'),
        while_(lt('r', len('s')), [
          let_('c', code('r')),
          if_(not(any([inRanges('c', ascii), ...(wide ? [ge('c', I(128))] : [])])), [BREAK]),
          set('r', add('r', I(1))),
        ]),
        ret(add('r', I(1))),
      ],
    });
  }
  return fns;
}

type Family = { sets: CharSet[]; fns: Fn[]; runs: boolean; finds: boolean; stopSets: number[][] };
const families = new WeakMap<ParserIR, Family>();
export function lexScanFamily(ir: ParserIR): Family {
  let f = families.get(ir);
  if (!f) {
    const b = new LexScan();
    for (const t of scannedTokens(ir)) b.fns.push({ ...b.scanner(t, ir.identLike.includes(t.name) ? ir.identPrefix[t.name] ?? '' : null), inline: true });
    if (ir.identLike.length) {
      b.fns.push({ name: UNI_CLASS, doc: '', params: [{ name: 'cp', ty: 'int' }], ret: ['int'], body: [], extern: true });
      b.fns.push(b.identEsc());
    }
    if (ir.tpl) b.fns.push(b.tplSpan(ir.tpl));
    if (ir.elements) b.fns.push(...elementFns(ir, ir.elements, b));
    const noted = new Set(lexLookPlan(ir).arms.flatMap((a) => a.cands.filter((c) => c.readEnd).map((c) => c.tok!)));
    // (a text token's read-end routine may be the frame step's already)
    for (const t of scannedTokens(ir)) if (noted.has(t.name) && !b.fns.some((f) => f.name === readEndName(t.name))) b.fns.push(b.readEnd(t));
    f = { sets: b.sets, fns: b.fns, runs: b.runs, finds: b.finds, stopSets: [...b.stopSets.values()] };
    families.set(ir, f);
  }
  return f;
}

export function emitLexScan(ir: ParserIR, lowering: Lowering): string {
  const { sets, fns, runs, finds, stopSets } = lexScanFamily(ir);
  return [...(runs ? [lowering.runEndFn] : []), ...(finds ? [lowering.findFn] : []), ...stopSets.map((st) => lowering.findAnyFn(st)), printFns(lowering, lowering.spliceInline ? fns.filter((f) => !f.inline) : fns, sets)].join('\n');
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
