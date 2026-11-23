// Relex / scanMeta algorithm family: the incremental token-stream algorithms of the
// portable Doc (fresh meta scan, windowed relex with resync + suffix adoption, edit
// application, stream equality) authored once and printed for each target through the
// `Lowering` it registers with `defineTarget`.
//
// Boundary: the lexer itself (`lex` / `lexFrom` / lexOne) is still emitted by each target
// module and is NOT part of this family. The family depends on it through exactly two
// calls — `lex(text)` and one `lexFrom(text, pos, ...state, out, 1)` step — whose state
// parameter order is `lexState(mode)` below; every target's lexFrom follows that order.
// A lexer error is a value (`LexErr`, below) each call returns beside its tokens: the family
// tests it right after the call, before it uses a token, and returns it to its caller.
//
// Offsets are in the target's native string units (whatever its lexer reports, e.g. UTF-16
// code units or UTF-8 bytes); the family only does arithmetic on them.
//
// The anchor rule. The windowed relex keeps the old tokens up to an anchor and lexes on from the
// anchor's end with the lexer state recovered from it; later it adopts the shifted old suffix
// from the first new token past the edit whose lexer state matches the old one's. A token is
// decided by everything its lexer read: its own match, and the failed attempts, at its start, of
// the candidates its dispatch arm tries before its own (a regex attempt that falls back to
// division reads to the end of its line). So a token may be kept only if nothing that decided it,
// or any token before it, read text at or after the edit start. A token is a valid restart
// anchor iff (i) it is at least one token before the last token that ends before the edit (every
// read within a token's end + 1 then stays before the edit); (ii) no token at or before it was
// decided by a read past its end + 1 that reaches the edit start: a failed attempt whose
// `readEnd` (src/lex-family.ts, recomputed here on the old text at the token's start) passes
// the edit start, or its own match (`overRead` past end + 1, only where the unit at its end is in
// `overTrigger`) whose reads, through the units its pattern can go past, reach the edit start;
// (iii) no template hole is open after it (td == 0), since the template stack is not recorded.
// Clause (ii) checks only the tokens that start after z, the last unit before the edit that no
// such read can go past (`LookPlan.reach`): a read from an earlier token stops at z at the
// latest. That stays sound when an edit lengthens a run of such units backward across z (an
// insertion right after z): the anchor then ends at or before z, and every token that could read
// the edit is relexed. A resync token is past the edit, and the old tokens adopted after it read
// only the unchanged text after them, so resync needs only the lexer state to match. Nothing of
// this is recorded by the lexer: the lexers pay nothing for it.

import { type ParserIR, buildLexIdPlan, kidOf, lidOf, regionKids } from './emit-portable.ts';
import { type LookPlan, lexLookPlan } from './lex-family.ts';
import type { CSet } from './lex-match-plan.ts';
import { type CharSet, type Expr, type Fn, type ListTy, type Lowering, type MetaFlag, type MetaInt, type RecordDecl, type Stmt, type TokInt, type Ty, printFns } from './algo-ir.ts';

// A lexer error: its kind (0 an unexpected character at off, 1 an identifier whose escapes spell
// no IdentifierName, s[off, end), 2 an unterminated template literal, 3 an invalid escape sequence
// in a template at off). Each target's lexer records it, and spells its message from it.
export const LEX_ERR: RecordDecl = { name: 'LexErr', fields: [{ name: 'kind', ty: 'int' }, { name: 'off', ty: 'int' }, { name: 'end', ty: 'int' }] };
const ERR: Ty = 'opt_LexErr';

export interface RelexMode {
  // Windowed relex (resync + suffix adoption); otherwise every edit re-lexes the whole text.
  window: boolean;
  newline: boolean;
  regex: boolean;
  template: boolean;
  // An element region: the template stack is the frame stack (it exists without a template
  // token too), and a token's depth also counts the lexer's element state (relexDepth).
  elements: boolean;
  // Raw-text elements: the lexer keeps each element frame's tagOpen token index (tagAt).
  raw: boolean;
  // The kinds of the region's own tokens: they carry no literal id (emit-portable.ts regionKids).
  regionKids: number[];
  kidNl: number;
  lidLParen: number;
  // The lexer's reads past a token's end + 1 (anchor rule (ii)); token names resolved to kids.
  look: LookPlan;
  kidOf: (tok: string) => number;
}

export function relexMode(ir: ParserIR): RelexMode {
  const window = (!ir.regexCtx && !ir.tpl) || !ir.newlineCfg;
  const ids = buildLexIdPlan(ir);
  const newline = window && !!ir.newlineCfg;
  const regex = window && !!ir.regexCtx;
  return {
    window,
    newline,
    regex,
    template: window && !!ir.tpl,
    elements: window && !!ir.elements,
    raw: window && !!ir.elements?.rawText.length,
    regionKids: regionKids(ir, ids),
    kidNl: newline ? kidOf(ids, ir.newlineCfg!.token) : -1,
    lidLParen: regex ? lidOf(ids, '(') : -1,
    // lexLookPlan asks relexMode only for `window`: resolved lazily, after this returns.
    get look() { return lexLookPlan(ir); },
    kidOf: (tok) => kidOf(ids, tok),
  };
}
const looks = (m: RelexMode): boolean => m.look.arms.length > 0 || m.look.over.length > 0;

// Meta records lexer state per token only when some state field feeds the meta.
const perToken = (m: RelexMode): boolean => m.newline || m.regex || m.template || m.elements;
// The lexer keeps a frame stack (template holes, and element frames).
const frames = (m: RelexMode): boolean => m.template || m.elements;

// ---- expression / statement shorthands ----
type Ex = Expr | string;
const x = (e: Ex): Expr => (typeof e === 'string' ? { k: 'var', name: e } : e);
const I = (v: number): Expr => ({ k: 'int', v });
const T: Expr = { k: 'bool', v: true };
const F: Expr = { k: 'bool', v: false };
const S = (v: string): Expr => ({ k: 'str', v });
const bin = (op: Extract<Expr, { k: 'bin' }>['op']) => (a: Ex, b: Ex): Expr => ({ k: 'bin', op, a: x(a), b: x(b) });
const add = bin('add'), sub = bin('sub'), shr = bin('shr');
const lt = bin('lt'), le = bin('le'), gt = bin('gt'), ge = bin('ge'), eq = bin('eq'), ne = bin('ne');
const and = (...es: Ex[]): Expr => es.map(x).reduce((a, b) => ({ k: 'bin', op: 'and', a, b }));
const len = (e: Ex): Expr => ({ k: 'len', e: x(e) });
const at = (list: Ex, i: Ex): Expr => ({ k: 'at', list: x(list), i: x(i) });
const last = (list: Ex): Expr => at(list, sub(len(list), I(1)));
const mi = (m: Ex, f: MetaInt): Expr => ({ k: 'metaInt', m: x(m), f });
const mf = (m: Ex, f: MetaFlag): Expr => ({ k: 'metaFlag', m: x(m), f });
const ti = (t: Ex, f: TokInt): Expr => ({ k: 'tokInt', t: x(t), f });
const tnl = (t: Ex): Expr => ({ k: 'tokNl', t: x(t) });
const mtext = (text: Ex, m: Ex): Expr => ({ k: 'metaText', text: x(text), m: x(m) });
const call = (fn: string, ...args: Ex[]): Expr & { k: 'call' } => ({ k: 'call', fn, args: args.map(x) });
const newList = (ty: ListTy, cap?: Ex): Expr => ({ k: 'newList', ty, cap: cap === undefined ? undefined : x(cap) });

const let_ = (name: string, ty: Ty, init: Ex): Stmt => ({ k: 'let', name, ty, init: x(init) });
const set = (name: string, e: Ex): Stmt => ({ k: 'set', name, e: x(e) });
const if_ = (c: Ex, then: Stmt[], els?: Stmt[]): Stmt => ({ k: 'if', c: x(c), then, else: els });
const while_ = (c: Ex, body: Stmt[]): Stmt => ({ k: 'while', c: x(c), body });
const for_ = (v: string, from: Ex, to: Ex, body: Stmt[]): Stmt => ({ k: 'for', v, from: x(from), to: x(to), body });
const push = (list: string, e: Ex): Stmt => ({ k: 'push', list, e: x(e) });
const ret = (...es: Ex[]): Stmt => ({ k: 'return', es: es.map(x) });
const NO_ERR: Expr = { k: 'none', rec: 'LexErr' };
const failed = (v: string): Expr => ({ k: 'isSome', e: x(v) });
const BREAK: Stmt = { k: 'break' };

// ---- lexer state: the lexFrom contract, in parameter order ----
interface StateField { name: string; ty: Ty; init: Expr }

export function lexState(m: RelexMode): StateField[] {
  const f: StateField[] = [{ name: 'pendingNl', ty: 'bool', init: F }];
  if (m.newline) f.push({ name: 'flowDepth', ty: 'depth', init: I(0) });
  if (m.regex) {
    f.push(
      { name: 'prevLid', ty: 'lid', init: I(0) },
      { name: 'prevKid', ty: 'lid', init: I(0) },
      { name: 'bpLid', ty: 'lid', init: I(0) },
      { name: 'hasPrev', ty: 'bool', init: F },
      { name: 'hasPrev2', ty: 'bool', init: F },
      { name: 'parenHead', ty: 'bools', init: newList('bools') },
      { name: 'lastClose', ty: 'bool', init: F },
      { name: 'lastBang', ty: 'bool', init: F },
    );
  }
  if (frames(m)) f.push({ name: 'templateStack', ty: 'depths', init: newList('depths') });
  if (m.elements) {
    // The token just lexed ended an element (a value for the regex test); the type-argument
    // depth in the current tag; the furthest a lookahead read (the tokens before it record
    // deeper); where a kept type-parameter signature ends (no element begins before it).
    f.push(
      { name: 'elEnded', ty: 'bool', init: F },
      { name: 'tagAngle', ty: 'int', init: I(0) },
      { name: 'laEnd', ty: 'int', init: I(0) },
      { name: 'specUntil', ty: 'int', init: I(0) },
    );
    if (m.raw) f.push({ name: 'tagAt', ty: 'depths', init: newList('depths') });
  }
  return f;
}

const stateLets = (m: RelexMode): Stmt[] => lexState(m).map((f) => let_(f.name, f.ty, f.init));
const lexStep = (m: RelexMode, text: string, pos: string, out: string): Stmt =>
  ({ k: 'lexStep', text: x(text), pos, out, state: lexState(m).map((f) => f.name), err: 'err' });

// Meta for a freshly lexed token: the token plus the lexer state right after it.
function metaOf(m: RelexMode, t: string): Expr {
  return {
    k: 'mkMeta',
    off: ti(t, 'off'), end: ti(t, 'end'), kid: ti(t, 'kid'), nl: tnl(t),
    fd: m.newline ? x('flowDepth') : I(0),
    pd: m.regex ? len('parenHead') : I(0),
    lc: m.regex ? x('lastClose') : F,
    lb: m.regex ? x('lastBang') : F,
    hd: m.regex ? and(eq(ti(t, 'lid'), I(m.lidLParen)), gt(len('parenHead'), I(0)), last('parenHead')) : F,
    td: m.elements ? tdOf(t) : m.template ? len('templateStack') : I(0),
  };
}

// A token's depth under element regions, by the lexer state right after it (relexDepth).
const tdOf = (t: Ex): Expr => call('relexDepth', len('templateStack'), 'elEnded', ti(t, 'off'), 'laEnd');
const relexDepthFn = (): Fn => ({
  name: 'relexDepth',
  doc: 'A token\'s depth: the frames open after it, one more when it ended an element (the next token\'s lexing reads that),\nand one more when it starts before the end of a lookahead read (an edit there can change how it was lexed); saturates at 255.',
  params: [{ name: 'n', ty: 'int' }, { name: 'ended', ty: 'bool' }, { name: 'off', ty: 'int' }, { name: 'la', ty: 'int' }],
  ret: ['int'],
  body: [
    let_('d', 'int', 'n'),
    if_('ended', [set('d', add('d', I(1)))]),
    if_(lt('off', 'la'), [set('d', add('d', I(1)))]),
    if_(gt('d', I(255)), [set('d', I(255))]),
    ret('d'),
  ],
});

// Lexer state at the resume point, recovered from the anchor token `anchor` = oldToks[rb].
function restoreFromAnchor(m: RelexMode): Stmt[] {
  const s: Stmt[] = [set('scanOff', mi('anchor', 'end'))];
  if (m.newline) s.push(set('flowDepth', mi('anchor', 'fd')), set('pendingNl', eq(mi('anchor', 'kid'), I(m.kidNl))));
  if (m.regex) {
    // a token's literal id from its text: none for a region token (regionKids)
    const lidOfTok = (name: string, t: Expr): Stmt[] => m.regionKids.length
      ? [if_(or(...m.regionKids.map((k) => eq(mi(t, 'kid'), I(k)))), [set(name, I(0))], [set(name, { k: 'lidOf', s: mtext('oldText', t) })])]
      : [set(name, { k: 'lidOf', s: mtext('oldText', t) })];
    s.push(
      ...lidOfTok('prevLid', x('anchor')),
      set('prevKid', mi('anchor', 'kid')),
      set('hasPrev', T),
      if_(ge('rb', I(1)), [
        ...lidOfTok('bpLid', at('oldToks', sub('rb', I(1)))),
        set('hasPrev2', T),
      ]),
      set('lastClose', mf('anchor', 'lc')),
      set('lastBang', mf('anchor', 'lb')),
      set('parenHead', call('reconstructParens', 'oldToks', 'oldText', 'rb')),
    );
  }
  // Template depth is not restorable from meta: the anchor search only accepts td == 0.
  return s;
}

// ---- functions ----

function toMetaFn(): Fn {
  const zero: RelexMode = { window: false, newline: false, regex: false, template: false, elements: false, raw: false, regionKids: [], kidNl: -1, lidLParen: -1, look: { arms: [], over: [], reach: [] }, kidOf: () => -1 };
  return {
    name: 'toMeta',
    doc: 'Stateless meta for tokens of a lexer whose meta carries no lexer state.',
    params: [{ name: 'toks', ty: 'toks' }],
    ret: ['metas'],
    body: [
      let_('meta', 'metas', newList('metas', len('toks'))),
      for_('i', I(0), len('toks'), [let_('t', 'tok', at('toks', 'i')), push('meta', metaOf(zero, 't'))]),
      ret('meta'),
    ],
  };
}

function scanMetaToksFn(m: RelexMode): Fn {
  const doc = 'Fresh lex of src: (meta, tokens).';
  if (!perToken(m)) {
    return {
      name: 'scanMetaToks', doc, params: [{ name: 'src', ty: 'str' }], ret: ['metas', 'toks', ERR],
      body: [{ k: 'lexAll', text: x('src'), out: 'toks', err: 'err' }, ret(call('toMeta', 'toks'), 'toks', 'err')],
    };
  }
  return {
    name: 'scanMetaToks',
    doc: `${doc} One lexFrom step per token so each meta records the lexer state after it.\nBoth lists grow as tokens are pushed: their length is known only once the scan ends.`,
    params: [{ name: 'src', ty: 'str' }],
    ret: ['metas', 'toks', ERR],
    body: [
      let_('toks', 'toks', newList('toks')),
      let_('meta', 'metas', newList('metas')),
      let_('pos', 'int', I(0)),
      let_('err', ERR, NO_ERR),
      ...stateLets(m),
      while_(lt('pos', len('src')), [
        let_('before', 'int', len('toks')),
        lexStep(m, 'src', 'pos', 'toks'),
        if_(failed('err'), [ret('meta', 'toks', 'err')]),
        if_(eq(len('toks'), 'before'), [BREAK]),
        let_('t', 'tok', last('toks')),
        push('meta', metaOf(m, 't')),
      ]),
      ret('meta', 'toks', 'err'),
    ],
  };
}

const scanMetaFn = (): Fn => ({
  name: 'scanMeta',
  doc: 'Fresh meta stream of src, and the lexer error (none when src lexes).',
  params: [{ name: 'src', ty: 'str' }],
  ret: ['metas', ERR],
  body: [{ k: 'letCall', names: ['meta', '_', 'err'], call: call('scanMetaToks', 'src') }, ret('meta', 'err')],
});

const checkStreamEqFn = (): Fn => ({
  name: 'checkStreamEq',
  doc: 'Incremental meta == fresh scan (every field, plus token text).',
  params: [{ name: 'text', ty: 'str' }, { name: 'meta', ty: 'metas' }],
  ret: ['bool'],
  body: [
    { k: 'letCall', names: ['fresh', 'err'], call: call('scanMeta', 'text') },
    if_(failed('err'), [ret(F)]),
    if_(ne(len('fresh'), len('meta')), [ret(F)]),
    for_('i', I(0), len('fresh'), [
      let_('f', 'meta', at('fresh', 'i')),
      let_('g', 'meta', at('meta', 'i')),
      if_({ k: 'not', e: { k: 'metaEq', a: x('f'), b: x('g') } }, [ret(F)]),
      if_(ne(mtext('text', 'f'), mtext('text', 'g')), [ret(F)]),
    ]),
    ret(T),
  ],
});

const editRangeFn = (): Fn => ({
  name: 'editRange',
  doc: 'Edit range clamped to 0 <= start <= end <= n.',
  params: [{ name: 'n', ty: 'int' }, { name: 'e', ty: 'edit' }],
  ret: ['int', 'int'],
  body: [
    let_('start', 'int', { k: 'editInt', e: x('e'), f: 'start' }),
    if_(lt('start', I(0)), [set('start', I(0))]),
    if_(gt('start', 'n'), [set('start', 'n')]),
    let_('end', 'int', { k: 'editInt', e: x('e'), f: 'end' }),
    if_(lt('end', 'start'), [set('end', 'start')]),
    if_(gt('end', 'n'), [set('end', 'n')]),
    ret('start', 'end'),
  ],
});

const applyEditsFn = (): Fn => ({
  name: 'applyEdits',
  doc: 'Text after applying edits in order (each against the previous result).',
  params: [{ name: 'text', ty: 'str' }, { name: 'edits', ty: 'edits' }],
  ret: ['str'],
  body: [
    let_('out', 'str', { k: 'own', e: x('text') }),
    { k: 'forEach', v: 'e', list: x('edits'), body: [
      { k: 'letCall', names: ['start', 'end'], call: call('editRange', len('out'), 'e') },
      set('out', { k: 'splice', s: x('out'), a: x('start'), b: x('end'), ins: { k: 'editText', e: x('e') } }),
    ] },
    ret('out'),
  ],
});

const findTokAtOffKindFn = (): Fn => ({
  name: 'findTokAtOffKind',
  doc: 'Index of the first token at offset off with kind kid (tokens sorted by off), or -1.',
  params: [{ name: 'toks', ty: 'metas' }, { name: 'off', ty: 'int' }, { name: 'kid', ty: 'int' }],
  ret: ['int'],
  body: [
    let_('lo', 'int', I(0)),
    let_('hi', 'int', len('toks')),
    while_(lt('lo', 'hi'), [
      let_('mid', 'int', shr(add('lo', 'hi'), I(1))),
      if_(lt(mi(at('toks', 'mid'), 'off'), 'off'), [set('lo', add('mid', I(1)))], [set('hi', 'mid')]),
    ]),
    while_(and(lt('lo', len('toks')), eq(mi(at('toks', 'lo'), 'off'), 'off')), [
      if_(eq(mi(at('toks', 'lo'), 'kid'), 'kid'), [ret('lo')]),
      set('lo', add('lo', I(1))),
    ]),
    ret(I(-1)),
  ],
});

const reconstructParensFn = (): Fn => ({
  name: 'reconstructParens',
  doc: 'Open-paren head flags in effect after toks[b], rebuilt from pd/hd of earlier "(" tokens.',
  params: [{ name: 'toks', ty: 'metas' }, { name: 'text', ty: 'str' }, { name: 'b', ty: 'int' }],
  ret: ['bools'],
  body: [
    let_('need', 'int', I(0)),
    if_(ge('b', I(0)), [set('need', mi(at('toks', 'b'), 'pd'))]),
    let_('out', 'bools', { k: 'falses', n: x('need') }),
    let_('i', 'int', 'b'),
    while_(and(ge('i', I(0)), gt('need', I(0))), [
      let_('t', 'meta', at('toks', 'i')),
      if_(and(eq(mtext('text', 't'), S('(')), eq(mi('t', 'pd'), 'need')), [
        { k: 'setAt', list: 'out', i: sub('need', I(1)), e: mf('t', 'hd') },
        set('need', sub('need', I(1))),
      ]),
      set('i', sub('i', I(1))),
    ]),
    ret('out'),
  ],
});

const parenStacksEqFn = (): Fn => ({
  name: 'parenStacksEq',
  doc: 'Element-wise equality of two paren head stacks.',
  params: [{ name: 'a', ty: 'bools' }, { name: 'b', ty: 'bools' }],
  ret: ['bool'],
  body: [
    if_(ne(len('a'), len('b')), [ret(F)]),
    for_('i', I(0), len('a'), [if_(ne(at('a', 'i'), at('b', 'i')), [ret(F)])]),
    ret(T),
  ],
});

// ---- anchor rule (ii): reads past a token's end + 1 ----

const code = (s: Ex, i: Ex): Expr => ({ k: 'code', s: x(s), i: x(i) });
const or = (...es: Ex[]): Expr => es.map(x).reduce((a, b) => ({ k: 'bin', op: 'or', a, b }));
// Whether code unit c may be one of the units of `set`: its ASCII members compared, and any unit
// beyond ASCII taken as one when the set has a member beyond ASCII (a UTF-8 target's units of one
// character are all >= 128, a UTF-16 target's too), so the test errs only towards membership.
function inUnits(c: Ex, set: CSet): Expr {
  const ascii = set.filter(([a]) => a <= 127).map(([a, b]): [number, number] => [Math.max(0, a), Math.min(127, b)]);
  const tests: Expr[] = ascii.map(([a, b]) => (a === b ? eq(c, I(a)) : and(ge(c, I(a)), le(c, I(b)))));
  if (set.some(([, b]) => b >= 128)) tests.push(ge(c, I(128)));
  return tests.length ? or(...tests) : F;
}

// The tables of the unit sets the reads test (relexOverEnd, relexInReach): one per distinct set of
// ASCII units, a unit beyond ASCII a member when the set has one (as inUnits). A set of at most two
// ranges stays a comparison: its table would be the longer spelling.
class UnitSets {
  sets: CharSet[] = [];
  private byKey = new Map<string, string>();
  test(c: Ex, set: CSet): Expr {
    const ascii = set.filter(([a]) => a <= 127).map(([a, b]): [number, number] => [Math.max(0, a), Math.min(127, b)]);
    if (ascii.length <= 2) return inUnits(c, set);
    const key = JSON.stringify(ascii);
    let name = this.byKey.get(key);
    if (!name) {
      name = `relexUnits${this.sets.length}`;
      this.byKey.set(key, name);
      this.sets.push({ name, ranges: ascii, cold: true });
    }
    const t: Expr = { k: 'inSet', set: name, c: x(c) };
    return set.some(([, b]) => b >= 128) ? or(t, ge(c, I(128))) : t;
  }
}

// Sorted units as ranges of consecutive ones.
const unitRuns = (us: number[]): CSet => {
  const out: [number, number][] = [];
  for (const b of [...us].sort((p, q) => p - q)) {
    const last = out[out.length - 1];
    if (last && last[1] + 1 === b) last[1] = b; else out.push([b, b]);
  }
  return out;
};

const readsBeforeFn = (m: RelexMode): Fn => {
  const body: Stmt[] = m.look.arms.length ? [let_('r', 'int', I(0)), if_(ge('off', len('text')), [ret('r')]), let_('u', 'int', code('text', 'off'))] : [let_('r', 'int', I(0))];
  m.look.arms.forEach((arm, ai) => {
    const steps: Stmt[] = [];
    arm.cands.forEach((c, k) => {
      if (c.tok !== null) steps.push(if_(eq('kid', I(m.kidOf(c.tok))), [ret('r')]));
      if (c.readEnd) steps.push(let_(`e${ai}_${k}`, 'int', call(c.readEnd, 'text', 'off')), if_(gt(`e${ai}_${k}`, 'r'), [set('r', `e${ai}_${k}`)]));
    });
    const test = arm.units === null ? ge('u', I(128)) : inUnits('u', unitRuns(arm.units));
    body.push(if_(test, [...steps, ret('r')]));
  });
  body.push(ret('r'));
  return {
    name: 'relexReadsBefore',
    doc: 'Where the failed attempts that decided the token of kind kid at off read to (exclusive): the attempts its dispatch arm makes\nbefore its own candidate that can read past its end + 1; 0 when none.',
    params: [{ name: 'text', ty: 'str' }, { name: 'off', ty: 'int' }, { name: 'kid', ty: 'int' }],
    ret: ['int'],
    body,
  };
};

const overEndFn = (m: RelexMode, u: UnitSets): Fn => ({
  name: 'relexOverEnd',
  doc: 'Where the match of the token of kind kid that ends at e read to (exclusive), when it can be past e + 1: through the units\nits pattern can pass, from a unit its match can read further at; 0 otherwise.',
  params: [{ name: 'text', ty: 'str' }, { name: 'e', ty: 'int' }, { name: 'kid', ty: 'int' }],
  ret: ['int'],
  body: [
    ...(m.look.over.length ? [if_(ge('e', len('text')), [ret(I(0))]), let_('c', 'int', code('text', 'e'))] : []),
    ...m.look.over.map((o) => if_(and(eq('kid', I(m.kidOf(o.tok))), u.test('c', o.trig)), [
      let_('q', 'int', 'e'),
      while_(lt('q', len('text')), [
        let_('u', 'int', code('text', 'q')),
        if_({ k: 'not', e: u.test('u', o.examined) }, [BREAK]),
        set('q', add('q', I(1))),
      ]),
      ret(add('q', I(1))),
    ])),
    ret(I(0)),
  ],
});

const inReachFn = (m: RelexMode, u: UnitSets): Fn => ({
  name: 'relexInReach',
  doc: 'Whether a read past a token\'s end + 1 can pass code unit c.',
  params: [{ name: 'c', ty: 'int' }],
  ret: ['bool'],
  body: [ret(u.test('c', m.look.reach))],
});

function windowRelexStepFn(m: RelexMode): Fn {
  const anchorSearch: Stmt[] = [
    let_('maxIdx', 'int', I(-1)),
    for_('i', I(0), len('oldToks'), [
      if_(lt(mi(at('oldToks', 'i'), 'end'), 'start'), [set('maxIdx', 'i')], [BREAK]),
    ]),
    let_('rb', 'int', I(-1)),
    if_(ge('maxIdx', I(0)), [set('rb', sub('maxIdx', I(1)))]),
  ];
  if (frames(m)) {
    anchorSearch.push(
      { k: 'comment', text: 'Template depth cannot be restored from meta: resume only after a td == 0 token.' },
      if_(ge('rb', I(0)), [
        let_('rb0', 'int', 'rb'),
        set('rb', I(-1)),
        for_('i', 'rb0', len('oldToks'), [
          if_(gt(mi(at('oldToks', 'i'), 'end'), 'start'), [BREAK]),
          if_(eq(mi(at('oldToks', 'i'), 'td'), I(0)), [set('rb', 'i'), BREAK]),
        ]),
      ]),
    );
  }
  if (looks(m)) {
    anchorSearch.push(
      { k: 'comment', text: 'Anchor rule (ii): no token at or before the anchor read the edit; only tokens after z can.' },
      let_('z', 'int', sub('start', I(1))),
      while_(and(ge('z', I(0)), call('relexInReach', code('oldText', 'z'))), [set('z', sub('z', I(1)))]),
      let_('w', 'int', 'rb'),
      while_(and(ge('w', I(0)), gt(mi(at('oldToks', 'w'), 'off'), 'z')), [
        let_('wt', 'meta', at('oldToks', 'w')),
        if_(or(
          gt(call('relexReadsBefore', 'oldText', mi('wt', 'off'), mi('wt', 'kid')), 'start'),
          gt(call('relexOverEnd', 'oldText', mi('wt', 'end'), mi('wt', 'kid')), 'start'),
        ), [set('rb', sub('w', I(1)))]),
        set('w', sub('w', I(1))),
      ]),
    );
    if (frames(m)) {
      anchorSearch.push(
        { k: 'comment', text: 'Back to a td == 0 token at or before it.' },
        while_(and(ge('rb', I(0)), ne(mi(at('oldToks', 'rb'), 'td'), I(0))), [set('rb', sub('rb', I(1)))]),
      );
    }
  }

  // Old token o at the shifted offset is interchangeable with t when its lexical identity and
  // the lexer state after it match; then the rest of the old stream is adopted shifted.
  const same: Expr[] = [
    eq(mi('o', 'kid'), ti('t', 'kid')),
    eq(mi('o', 'end'), sub(ti('t', 'end'), 'delta')),
    eq(mf('o', 'nl'), tnl('t')),
    eq(mtext('oldText', 'o'), { k: 'substr', s: x('newText'), a: ti('t', 'off'), b: ti('t', 'end') }),
  ];
  if (m.newline) same.push(eq(mi('o', 'fd'), 'flowDepth'));
  if (m.elements) same.push(eq(mi('o', 'td'), I(0)), eq(tdOf('t'), I(0)));
  else if (m.template) same.push(eq(mi('o', 'td'), I(0)), eq(len('templateStack'), I(0)));
  const pre: Stmt[] = [];
  if (m.regex) {
    same.push(eq(mi('o', 'pd'), len('parenHead')), eq(mf('o', 'lc'), 'lastClose'), eq(mf('o', 'lb'), 'lastBang'));
    pre.push(
      let_('newPrev', 'str', S('')),
      if_(gt(len('out'), I(1)), [set('newPrev', mtext('newText', at('out', sub(len('out'), I(2)))))]),
      let_('oldPrev', 'str', S('')),
      if_(ge('oIdx', I(1)), [set('oldPrev', mtext('oldText', at('oldToks', sub('oIdx', I(1)))))]),
    );
    same.push(eq('newPrev', 'oldPrev'));
  }
  const adopt: Stmt[] = [
    for_('j', add('oIdx', I(1)), len('oldToks'), [push('out', { k: 'shiftMeta', m: at('oldToks', 'j'), delta: x('delta') })]),
    ret('out', 'relexed', NO_ERR),
  ];
  const onCandidate: Stmt[] = m.regex
    ? [if_(and(...same), [let_('oldStack', 'bools', call('reconstructParens', 'oldToks', 'oldText', 'oIdx')), if_(call('parenStacksEq', 'oldStack', 'parenHead'), adopt)])]
    : [if_(and(...same), adopt)];

  return {
    name: 'windowRelexStep',
    doc: 'One edit: keep tokens before the anchor, relex from the anchor with restored lexer state,\n' +
      'and adopt the shifted old suffix at the first token past the edit whose state matches.\nReturns (new meta, tokens relexed, the lexer error or none).',
    params: [
      { name: 'oldText', ty: 'str' }, { name: 'oldToks', ty: 'metas' }, { name: 'newText', ty: 'str' },
      { name: 'start', ty: 'int' }, { name: 'end', ty: 'int' }, { name: 'ins', ty: 'str' },
    ],
    ret: ['metas', 'int', ERR],
    body: [
      let_('delta', 'int', sub(len('ins'), sub('end', 'start'))),
      let_('editEnd', 'int', add('start', len('ins'))),
      ...anchorSearch,
      { k: 'comment', text: 'Growth estimate: old length plus the len/2 token density of the inserted text.' },
      let_('out', 'metas', { k: 'prefix', list: x('oldToks'), n: add('rb', I(1)), estimate: add(add(len('oldToks'), shr(len('ins'), I(1))), I(2)) }),
      let_('scanOff', 'int', I(0)),
      ...stateLets(m),
      if_(ge('rb', I(0)), [let_('anchor', 'meta', at('oldToks', 'rb')), ...restoreFromAnchor(m)]),
      let_('scratch', 'toks', newList('toks')),
      let_('relexed', 'int', I(0)),
      let_('err', ERR, NO_ERR),
      while_(lt('scanOff', len('newText')), [
        let_('before', 'int', len('scratch')),
        lexStep(m, 'newText', 'scanOff', 'scratch'),
        if_(failed('err'), [ret('out', 'relexed', 'err')]),
        if_(eq(len('scratch'), 'before'), [BREAK]),
        let_('t', 'tok', last('scratch')),
        push('out', metaOf(m, 't')),
        set('relexed', add('relexed', I(1))),
        if_(ge(ti('t', 'off'), 'editEnd'), [
          let_('oIdx', 'int', call('findTokAtOffKind', 'oldToks', sub(ti('t', 'off'), 'delta'), ti('t', 'kid'))),
          if_(ge('oIdx', I(0)), [let_('o', 'meta', at('oldToks', 'oIdx')), ...pre, ...onCandidate]),
        ]),
      ]),
      ret('out', 'relexed', 'err'),
    ],
  };
}

function relexEditsFn(m: RelexMode): Fn {
  const doc = 'Apply edits to (text, meta): returns (new text, new meta, tokens relexed, the lexer error or none).\nWith a lexer error the text and meta are unspecified.';
  const params = [{ name: 'text', ty: 'str' as Ty }, { name: 'toks', ty: 'metas' as Ty }, { name: 'edits', ty: 'edits' as Ty }];
  if (!m.window) {
    return {
      name: 'relexEdits', doc: `${doc}\nThis lexer mode has no windowed relex: the whole text is re-lexed.`, params, ret: ['str', 'metas', 'int', ERR],
      body: [
        let_('next', 'str', call('applyEdits', 'text', 'edits')),
        { k: 'letCall', names: ['meta', 'err'], call: call('scanMeta', 'next') },
        let_('n', 'int', len('meta')),
        ret('next', 'meta', 'n', 'err'),
      ],
    };
  }
  return {
    name: 'relexEdits', doc, params, ret: ['str', 'metas', 'int', ERR],
    body: [
      let_('curText', 'str', { k: 'own', e: x('text') }),
      let_('curToks', 'metas', { k: 'own', e: x('toks') }),
      let_('relexed', 'int', I(0)),
      { k: 'forEach', v: 'e', list: x('edits'), body: [
        { k: 'letCall', names: ['start', 'end'], call: call('editRange', len('curText'), 'e') },
        let_('ins', 'str', { k: 'editText', e: x('e') }),
        let_('next', 'str', { k: 'splice', s: x('curText'), a: x('start'), b: x('end'), ins: x('ins') }),
        { k: 'letCall', names: ['stepToks', 'stepRelexed', 'err'], call: call('windowRelexStep', 'curText', 'curToks', 'next', 'start', 'end', 'ins') },
        if_(failed('err'), [ret('next', 'stepToks', 'relexed', 'err')]),
        set('curText', 'next'),
        set('curToks', 'stepToks'),
        set('relexed', add('relexed', 'stepRelexed')),
      ] },
      ret('curText', 'curToks', 'relexed', NO_ERR),
    ],
  };
}

export function relexFamilyFns(m: RelexMode): Fn[] {
  return relexFamily(m).fns;
}

// The family's functions and the unit tables they test (printed with them).
export function relexFamily(m: RelexMode): { fns: Fn[]; sets: CharSet[] } {
  const fns: Fn[] = [];
  const u = new UnitSets();
  if (!perToken(m)) fns.push(toMetaFn());
  if (m.elements) fns.push(relexDepthFn());
  fns.push(scanMetaToksFn(m), scanMetaFn(), checkStreamEqFn(), editRangeFn(), applyEditsFn());
  if (m.window) {
    fns.push(findTokAtOffKindFn());
    if (m.regex) fns.push(reconstructParensFn(), parenStacksEqFn());
    if (looks(m)) {
      // The read-end routines are the lex-scan family's, printed with the scanners.
      for (const name of new Set(m.look.arms.flatMap((a) => a.cands.flatMap((c) => (c.readEnd ? [c.readEnd] : []))))) {
        fns.push({ name, doc: '', params: [{ name: 's', ty: 'str' }, { name: 'p', ty: 'int' }], ret: ['int'], body: [], extern: true });
      }
      fns.push(readsBeforeFn(m), overEndFn(m, u), inReachFn(m, u));
    }
    fns.push(windowRelexStepFn(m));
  }
  fns.push(relexEditsFn(m));
  return { fns, sets: u.sets };
}

export function emitRelexFamily(ir: ParserIR, lowering: Lowering): string {
  const { fns, sets } = relexFamily(relexMode(ir));
  return printFns(lowering, fns, sets, [LEX_ERR]);
}
