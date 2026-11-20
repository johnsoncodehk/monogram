// Relex / scanMeta algorithm family: the incremental token-stream algorithms of the
// portable Doc (fresh meta scan, windowed relex with resync + suffix adoption, edit
// application, stream equality) authored once and printed for TS / Go / Rust.
//
// Boundary: the lexer itself (`lex` / `lexFrom` / lexOne) is still emitted per target by
// target-*.ts and is NOT part of this family. The family depends on it through exactly two
// calls — `lex(text)` and one `lexFrom(text, pos, ...state, out, 1)` step — whose state
// parameter order is `lexState(mode)` below; every target's lexFrom follows that order.
//
// Offsets are host-native string units (UTF-16 code units in TS, UTF-8 bytes in Go/Rust),
// the same units the per-target lexer reports; the family only does arithmetic on them.

import { type ParserIR, buildLexIdPlan, kidOf, lidOf } from './emit-portable.ts';
import { type Expr, type Fn, type Host, type ListTy, type MetaFlag, type MetaInt, type Stmt, type TokInt, type Ty, printFns } from './algo-ir.ts';

export interface RelexMode {
  // Windowed relex (resync + suffix adoption); otherwise every edit re-lexes the whole text.
  window: boolean;
  newline: boolean;
  regex: boolean;
  template: boolean;
  kidNl: number;
  lidLParen: number;
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
    kidNl: newline ? kidOf(ids, ir.newlineCfg!.token) : -1,
    lidLParen: regex ? lidOf(ids, '(') : -1,
  };
}

// Meta records lexer state per token only when some state field feeds the meta.
const perToken = (m: RelexMode): boolean => m.newline || m.regex || m.template;

// ---- expression / statement shorthands ----
type Ex = Expr | string;
const x = (e: Ex): Expr => (typeof e === 'string' ? { k: 'var', name: e } : e);
const I = (v: number): Expr => ({ k: 'int', v });
const T: Expr = { k: 'bool', v: true };
const F: Expr = { k: 'bool', v: false };
const S = (v: string): Expr => ({ k: 'str', v });
const bin = (op: Extract<Expr, { k: 'bin' }>['op']) => (a: Ex, b: Ex): Expr => ({ k: 'bin', op, a: x(a), b: x(b) });
const add = bin('+'), sub = bin('-'), shr = bin('>>');
const lt = bin('<'), le = bin('<='), gt = bin('>'), ge = bin('>='), eq = bin('=='), ne = bin('!=');
const and = (...es: Ex[]): Expr => es.map(x).reduce((a, b) => ({ k: 'bin', op: '&&', a, b }));
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
const estList = (ty: ListTy, estimate: Ex): Expr => ({ k: 'newList', ty, estimate: x(estimate) });

const let_ = (name: string, ty: Ty, init: Ex): Stmt => ({ k: 'let', name, ty, init: x(init) });
const set = (name: string, e: Ex): Stmt => ({ k: 'set', name, e: x(e) });
const if_ = (c: Ex, then: Stmt[], els?: Stmt[]): Stmt => ({ k: 'if', c: x(c), then, else: els });
const while_ = (c: Ex, body: Stmt[]): Stmt => ({ k: 'while', c: x(c), body });
const for_ = (v: string, from: Ex, to: Ex, body: Stmt[]): Stmt => ({ k: 'for', v, from: x(from), to: x(to), body });
const push = (list: string, e: Ex): Stmt => ({ k: 'push', list, e: x(e) });
const ret = (...es: Ex[]): Stmt => ({ k: 'return', es: es.map(x) });
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
  if (m.template) f.push({ name: 'templateStack', ty: 'depths', init: newList('depths') });
  return f;
}

const stateLets = (m: RelexMode): Stmt[] => lexState(m).map((f) => let_(f.name, f.ty, f.init));
const lexStep = (m: RelexMode, text: string, pos: string, out: string): Stmt =>
  ({ k: 'lexStep', text: x(text), pos, out, state: lexState(m).map((f) => f.name) });

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
    td: m.template ? len('templateStack') : I(0),
  };
}

// Lexer state at the resume point, recovered from the anchor token `anchor` = oldToks[rb].
function restoreFromAnchor(m: RelexMode): Stmt[] {
  const s: Stmt[] = [set('scanOff', mi('anchor', 'end'))];
  if (m.newline) s.push(set('flowDepth', mi('anchor', 'fd')), set('pendingNl', eq(mi('anchor', 'kid'), I(m.kidNl))));
  if (m.regex) {
    s.push(
      set('prevLid', { k: 'lidOf', s: mtext('oldText', 'anchor') }),
      set('prevKid', mi('anchor', 'kid')),
      set('hasPrev', T),
      if_(ge('rb', I(1)), [
        set('bpLid', { k: 'lidOf', s: mtext('oldText', at('oldToks', sub('rb', I(1)))) }),
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
  const zero: RelexMode = { window: false, newline: false, regex: false, template: false, kidNl: -1, lidLParen: -1 };
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
      name: 'scanMetaToks', doc, params: [{ name: 'src', ty: 'str' }], ret: ['metas', 'toks'],
      body: [let_('toks', 'toks', { k: 'lexAll', text: x('src') }), ret(call('toMeta', 'toks'), 'toks')],
    };
  }
  return {
    name: 'scanMetaToks',
    doc: `${doc} One lexFrom step per token so each meta records the lexer state after it.\nGrowth estimate len(src)/2 per list; sparse lists are trimmed because the Doc keeps them.`,
    params: [{ name: 'src', ty: 'str' }],
    ret: ['metas', 'toks'],
    body: [
      let_('toks', 'toks', estList('toks', shr(len('src'), I(1)))),
      let_('meta', 'metas', estList('metas', shr(len('src'), I(1)))),
      let_('pos', 'int', I(0)),
      ...stateLets(m),
      while_(lt('pos', len('src')), [
        let_('before', 'int', len('toks')),
        lexStep(m, 'src', 'pos', 'toks'),
        if_(eq(len('toks'), 'before'), [BREAK]),
        let_('t', 'tok', last('toks')),
        push('meta', metaOf(m, 't')),
      ]),
      { k: 'shrink', list: 'toks' },
      { k: 'shrink', list: 'meta' },
      ret('meta', 'toks'),
    ],
  };
}

const scanMetaFn = (): Fn => ({
  name: 'scanMeta',
  doc: 'Fresh meta stream of src.',
  params: [{ name: 'src', ty: 'str' }],
  ret: ['metas'],
  body: [{ k: 'letCall', names: ['meta', '_'], call: call('scanMetaToks', 'src') }, ret('meta')],
});

const checkStreamEqFn = (): Fn => ({
  name: 'checkStreamEq',
  doc: 'Incremental meta == fresh scan (every field, plus token text).',
  params: [{ name: 'text', ty: 'str' }, { name: 'meta', ty: 'metas' }],
  ret: ['bool'],
  body: [
    let_('fresh', 'metas', call('scanMeta', 'text')),
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

function windowRelexStepFn(m: RelexMode): Fn {
  const anchorSearch: Stmt[] = [
    let_('maxIdx', 'int', I(-1)),
    for_('i', I(0), len('oldToks'), [
      if_(lt(mi(at('oldToks', 'i'), 'end'), 'start'), [set('maxIdx', 'i')], [BREAK]),
    ]),
    let_('rb', 'int', I(-1)),
    if_(ge('maxIdx', I(0)), [set('rb', sub('maxIdx', I(1)))]),
  ];
  if (m.template) {
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

  // Old token o at the shifted offset is interchangeable with t when its lexical identity and
  // the lexer state after it match; then the rest of the old stream is adopted shifted.
  const same: Expr[] = [
    eq(mi('o', 'kid'), ti('t', 'kid')),
    eq(mi('o', 'end'), sub(ti('t', 'end'), 'delta')),
    eq(mf('o', 'nl'), tnl('t')),
    eq(mtext('oldText', 'o'), { k: 'substr', s: x('newText'), a: ti('t', 'off'), b: ti('t', 'end') }),
  ];
  if (m.newline) same.push(eq(mi('o', 'fd'), 'flowDepth'));
  if (m.template) same.push(eq(mi('o', 'td'), I(0)), eq(len('templateStack'), I(0)));
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
    ret('out', 'relexed'),
  ];
  const onCandidate: Stmt[] = m.regex
    ? [if_(and(...same), [let_('oldStack', 'bools', call('reconstructParens', 'oldToks', 'oldText', 'oIdx')), if_(call('parenStacksEq', 'oldStack', 'parenHead'), adopt)])]
    : [if_(and(...same), adopt)];

  return {
    name: 'windowRelexStep',
    doc: 'One edit: keep tokens before the anchor, relex from the anchor with restored lexer state,\n' +
      'and adopt the shifted old suffix at the first token past the edit whose state matches.\nReturns (new meta, tokens relexed).',
    params: [
      { name: 'oldText', ty: 'str' }, { name: 'oldToks', ty: 'metas' }, { name: 'newText', ty: 'str' },
      { name: 'start', ty: 'int' }, { name: 'end', ty: 'int' }, { name: 'ins', ty: 'str' },
    ],
    ret: ['metas', 'int'],
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
      while_(lt('scanOff', len('newText')), [
        let_('before', 'int', len('scratch')),
        lexStep(m, 'newText', 'scanOff', 'scratch'),
        if_(eq(len('scratch'), 'before'), [BREAK]),
        let_('t', 'tok', last('scratch')),
        push('out', metaOf(m, 't')),
        set('relexed', add('relexed', I(1))),
        if_(ge(ti('t', 'off'), 'editEnd'), [
          let_('oIdx', 'int', call('findTokAtOffKind', 'oldToks', sub(ti('t', 'off'), 'delta'), ti('t', 'kid'))),
          if_(ge('oIdx', I(0)), [let_('o', 'meta', at('oldToks', 'oIdx')), ...pre, ...onCandidate]),
        ]),
      ]),
      ret('out', 'relexed'),
    ],
  };
}

function relexEditsFn(m: RelexMode): Fn {
  const doc = 'Apply edits to (text, meta): returns (new text, new meta, tokens relexed).';
  const params = [{ name: 'text', ty: 'str' as Ty }, { name: 'toks', ty: 'metas' as Ty }, { name: 'edits', ty: 'edits' as Ty }];
  if (!m.window) {
    return {
      name: 'relexEdits', doc: `${doc}\nThis lexer mode has no windowed relex: the whole text is re-lexed.`, params, ret: ['str', 'metas', 'int'],
      body: [
        let_('next', 'str', call('applyEdits', 'text', 'edits')),
        let_('meta', 'metas', call('scanMeta', 'next')),
        let_('n', 'int', len('meta')),
        ret('next', 'meta', 'n'),
      ],
    };
  }
  return {
    name: 'relexEdits', doc, params, ret: ['str', 'metas', 'int'],
    body: [
      let_('curText', 'str', { k: 'own', e: x('text') }),
      let_('curToks', 'metas', { k: 'own', e: x('toks') }),
      let_('relexed', 'int', I(0)),
      { k: 'forEach', v: 'e', list: x('edits'), body: [
        { k: 'letCall', names: ['start', 'end'], call: call('editRange', len('curText'), 'e') },
        let_('ins', 'str', { k: 'editText', e: x('e') }),
        let_('next', 'str', { k: 'splice', s: x('curText'), a: x('start'), b: x('end'), ins: x('ins') }),
        { k: 'letCall', names: ['stepToks', 'stepRelexed'], call: call('windowRelexStep', 'curText', 'curToks', 'next', 'start', 'end', 'ins') },
        set('curText', 'next'),
        set('curToks', 'stepToks'),
        set('relexed', add('relexed', 'stepRelexed')),
      ] },
      ret('curText', 'curToks', 'relexed'),
    ],
  };
}

export function relexFamilyFns(m: RelexMode): Fn[] {
  const fns: Fn[] = [];
  if (!perToken(m)) fns.push(toMetaFn());
  fns.push(scanMetaToksFn(m), scanMetaFn(), checkStreamEqFn(), editRangeFn(), applyEditsFn());
  if (m.window) {
    fns.push(findTokAtOffKindFn());
    if (m.regex) fns.push(reconstructParensFn(), parenStacksEqFn());
    fns.push(windowRelexStepFn(m));
  }
  fns.push(relexEditsFn(m));
  return fns;
}

export function emitRelexFamily(ir: ParserIR, host: Host): string {
  const fns = relexFamilyFns(relexMode(ir));
  return `\n// ---- relex family: generated from src/relex-family.ts (shared by the TS / Go / Rust targets) ----\n${printFns(host, fns)}\n`;
}
