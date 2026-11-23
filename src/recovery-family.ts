// Recovery family: total parsing's diagnostics, authored once and printed for each target through
// its `Lowering` (emitted only with the emit option `{ recovery: true }`, docs/TARGETS.md "Errors
// and tokens").
//
// A diagnostic is a record of numbers (`Diag`): what kind of repair it reports, its span, and the
// literal / kind it names. ONE formatter (`diagMessage`) spells every target's message text, so
// the three targets give the same words for the same record.
//
// Total parsing (stage 3): a text the native parse rejects is parsed again by the interpreter of
// the parse plan (below) with repairs: a tree all the same, with `$missing` / `$error` nodes and
// one diagnostic per repair.
//
// Boundary: the engine (the target's builder parse: position, children list, builder, examined
// extent) is the target's, reached through the extern methods `en*`; this family decides every
// repair and how it is worded. No extern reads a node: a node is made through the builder's
// node / finish, so any builder (a CST, a shape's) takes the reserved rules like the grammar's.

import { type Expr, type Fn, type Lowering, type RecordDecl, type Stmt, printFns } from './algo-ir.ts';
import { REC_RD, REC_N_TOK, REC_N_BRACKET, REC_N_SEQ, REC_N_CAPPED, REC_N_PREFIX, REC_S_LIT, REC_S_COMP, REC_S_TOK, REC_S_TPLTOK, REC_S_RULE, REC_S_RULEBP, REC_S_STAR, REC_S_OPT, REC_S_SEP, REC_S_ALTLIT, REC_S_ALT, REC_S_LOOK, REC_S_AHEAD, REC_S_AHEADCTX, REC_S_SEQ, REC_S_SAMELINE, REC_S_SUPPRESS, REC_S_CTX, REC_S_SHARED } from './emit-portable.ts';

export const DIAG: RecordDecl = {
  name: 'Diag',
  fields: ['kind', 'off', 'end', 'relOff', 'relEnd', 'arg'].map((name) => ({ name, ty: 'int' as const })),
};
// The kinds of a diagnostic. One per repair: a literal (arg: its lid) or a token of a kind (arg:
// its kid) the parse supplied where it was missing, a zero-width `$missing` node; tokens the parse
// skipped, an `$error` node over them (arg: the end of its first token; at the end of input, off).
// The strict parse's error (stage 1, the interpreter's primary error): the entry rule failed at a
// token; it failed with no token left; it matched and a token is left over.
export const DK_MISS_LIT = 0, DK_MISS_TOK = 1, DK_SKIP = 2, DK_UNEXPECTED = 3, DK_EOF = 4, DK_LEFTOVER = 5;
// The best candidate of a longest match so far (riCand): where it ended, its node's offset, whether
// one won, the node's form, tail and capped flag, and where the repair memory stood when the
// match began (h0) and where the best's repairs end (hb).
const BEST: RecordDecl = {
  name: 'BestCand',
  fields: ['pos', 'off', 'won', 'form', 'tail', 'capped', 'h0', 'hb'].map((name) => ({ name, ty: 'int' as const })),
};

const v = (name: string): Expr => ({ k: 'var', name });
const n = (k: number): Expr => ({ k: 'int', v: k });
const s = (t: string): Expr => ({ k: 'str', v: t });
const bin = (op: (Expr & { k: 'bin' })['op'], a: Expr, b: Expr): Expr => ({ k: 'bin', op, a, b });
const fld = (e: Expr, f: string): Expr => ({ k: 'field', e, f });
const tok = (i: Expr, f: 'off' | 'end'): Expr => ({ k: 'tokInt', t: { k: 'at', list: v('toks'), i }, f });
const ret = (...es: Expr[]): Stmt => ({ k: 'return', es });
const diag = (kind: Expr, off: Expr, end: Expr, relOff: Expr, relEnd: Expr, arg: Expr = n(0)): Expr => ({ k: 'mkRec', rec: 'Diag', fields: { kind, off, end, relOff, relEnd, arg } });

// The message of a diagnostic of src.
const diagMessage: Fn = {
  name: 'diagMessage',
  doc: '',
  params: [{ name: 'src', ty: 'str' }, { name: 'd', ty: 'rec_Diag' }],
  ret: ['str'],
  body: [
    { k: 'if', c: bin('eq', fld(v('d'), 'kind'), n(DK_MISS_LIT)), then: [ret({ k: 'cat', parts: [s("expected '"), { k: 'call', fn: 'litText', args: [fld(v('d'), 'arg')] }, s("'")] })] },
    { k: 'if', c: bin('eq', fld(v('d'), 'kind'), n(DK_MISS_TOK)), then: [ret({ k: 'cat', parts: [s('expected '), { k: 'call', fn: 'kindText', args: [fld(v('d'), 'arg')] }] })] },
    { k: 'if', c: bin('eq', fld(v('d'), 'kind'), n(DK_SKIP)), then: [
      { k: 'if', c: bin('eq', fld(v('d'), 'arg'), fld(v('d'), 'off')), then: [ret(s('unexpected end of input'))] },
      ret({ k: 'cat', parts: [s("unexpected '"), { k: 'substr', s: v('src'), a: fld(v('d'), 'off'), b: fld(v('d'), 'arg') }, s("'")] }),
    ] },
    { k: 'if', c: bin('eq', fld(v('d'), 'kind'), n(DK_EOF)), then: [ret(s('unexpected end of input'))] },
    { k: 'let', name: 'text', ty: 'str', init: { k: 'cat', parts: [s("unexpected '"), { k: 'substr', s: v('src'), a: fld(v('d'), 'off'), b: fld(v('d'), 'end') }, s("'")] } },
    { k: 'if', c: bin('eq', fld(v('d'), 'kind'), n(DK_LEFTOVER)), then: [ret({ k: 'cat', parts: [v('text'), s(' after successful parse')] })] },
    ret(v('text')),
  ],
};

// The message of a diagnostic's related location (relOff >= 0).
const diagRelated: Fn = {
  name: 'diagRelated',
  doc: '',
  params: [{ name: 'd', ty: 'rec_Diag' }],
  ret: ['str'],
  body: [ret(s('the parse reached this far'))],
};

// The primary error of a parse that rejected: the entry rule returned `entryOk` with the position
// at `pos` (of `toks`), having examined the tokens before `look` (one past the furthest token a
// read reached). The related location is the furthest examined token when it lies past pos (the
// interpreter's farthest hint, which counts only tokens a match advanced past: a guard's read of
// the token after the current one is examined, not advanced past, so the two can differ);
// otherwise none (-1).
const rejectDiag: Fn = {
  name: 'rejectDiag',
  doc: '',
  params: [{ name: 'toks', ty: 'toks' }, { name: 'pos', ty: 'idx' }, { name: 'entryOk', ty: 'bool' }, { name: 'look', ty: 'idx' }],
  ret: ['rec_Diag'],
  body: [
    { k: 'let', name: 'relOff', ty: 'int', init: n(-1) },
    { k: 'let', name: 'relEnd', ty: 'int', init: n(-1) },
    { k: 'if', c: bin('and', bin('gt', v('look'), bin('add', v('pos'), n(1))), bin('le', v('look'), { k: 'len', e: v('toks') })), then: [
      { k: 'set', name: 'relOff', e: tok(bin('sub', v('look'), n(1)), 'off') },
      { k: 'set', name: 'relEnd', e: tok(bin('sub', v('look'), n(1)), 'end') },
    ] },
    { k: 'if', c: bin('ge', v('pos'), { k: 'len', e: v('toks') }), then: [ret(diag(n(DK_EOF), n(0), n(0), v('relOff'), v('relEnd')))] },
    { k: 'let', name: 'kind', ty: 'int', init: n(DK_UNEXPECTED) },
    // A rule matches only when it consumes a token (longest match: gen-parser.ts parseNonRec); the
    // reuse plan's entry shells return true for zero top-level entries.
    { k: 'if', c: bin('and', v('entryOk'), bin('gt', v('pos'), n(0))), then: [{ k: 'set', name: 'kind', e: n(DK_LEFTOVER) }] },
    ret(diag(v('kind'), tok(v('pos'), 'off'), tok(v('pos'), 'end'), v('relOff'), v('relEnd'))),
  ],
};


// ── The strict interpreter (stage 2) ──
// The parse plan's tables (emit-portable.ts recoveryTables, the int table `rt`) run over the
// target's engine. It parses as the native functions do: the same verdict, the same tree through
// the builder, the same leaves offered to it. A longest-match list's candidates are tried in
// declaration order where their guards admit the token (the native Dispatch / Commit only skip
// candidates that cannot win). `d`: how many more rule levels are interpreted; a rule reached
// with d = 0 is the native function (native-first). Lookahead bodies and template holes always
// run natively: no repair fires inside a probe. Every function is an engine method: the engine
// (the target's builder parse) is the state it reads and writes through the extern methods
// `en*`, each a call of what the target's native functions already do.

type Ty0 = 'int' | 'bool';
const ext = (name: string, params: [string, Ty0][], ret: Ty0[] = []): Fn => ({ name, doc: '', params: params.map(([pn, ty]) => ({ name: pn, ty })), ret, body: [], extern: true, method: true });
// An extern that only reads the engine (another method's argument may call it).
const extR = (name: string, params: [string, Ty0][], ret: Ty0[]): Fn => ({ ...ext(name, params, ret), reads: true });
// The engine, as the interpreter sees it (each target prints these over its own parse state).
export const ENGINE_EXTERNS: Fn[] = [
  // The position: read, set, and moved back (as the native backtrack does, folding what was examined).
  extR('enPos', [], ['int']), ext('enSetPos', [['p', 'int']]), ext('enBack', [['p', 'int']]),
  // The token at the position: its kid (-1 at the end of input), lid, and whether a line break precedes it.
  ext('enPeekKid', [], ['int']), ext('enPeekLid', [], ['int']), ext('enPeekNl', [], ['bool']),
  // The building matchers: a literal, a composed '>' literal, a token kind.
  ext('enLit', [['l', 'int']], ['bool']), ext('enComp', [['l', 'int']], ['bool']), ext('enTok', [['k', 'int']], ['bool']),
  ext('enAhead', [['set', 'int'], ['is', 'bool']], ['bool']), ext('enCtxWord', [], ['bool']), ext('enSecondIn', [['set', 'int']], ['bool']),
  // The native functions: a lookahead body, a rule (its node appended), a Pratt rule at a binding
  // power (its node appended), a shared step, an interpolated template whose holes rule `hole` parses.
  ext('enLook', [['id', 'int']], ['bool']), ext('enRule', [['r', 'int']], ['bool']), ext('enBp', [['r', 'int'], ['bp', 'int']], ['bool']),
  ext('enShared', [['i', 'int']], ['bool']), ext('enTpl', [['hole', 'int']], ['bool']),
  // The children list's height and a cut back to h (nothing else undone); a mark of the position,
  // the list and the builder, undone to (kept) and dropped (with every later one).
  ext('enSh', [], ['int']), ext('enCut', [['h', 'int']]), ext('enMark', [], ['int']), ext('enReset', [['k', 'int']]), ext('enUnmark', [['k', 'int']]),
  // Mark k dropped alone (the later ones keep their order, one index lower).
  ext('enMarkDrop', [['k', 'int']]),
  // A candidate tried from token `save`, its children from height c, won: its node replaces the
  // list from height sb. A Pratt continuation's node over the left operand from height sb, the
  // left's offset and first token its span's fallback and first token. The offset of the node either finished.
  ext('enWin', [['r', 'int'], ['c', 'int'], ['save', 'int'], ['sb', 'int']]), ext('enFinLed', [['r', 'int'], ['sb', 'int'], ['off', 'int'], ['tok', 'int']]), ext('enFinOff', [], ['int']),
  // The binary operator at the position (a '>' composed with the tokens after it): its lid, and its
  // leaf over every token it spans. A prefix / postfix operator's leaf; the token's leaf of its kind.
  ext('enOpLid', [], ['int']), ext('enLeafOpN', []), ext('enLeafOp', []), ext('enLeafKid', []),
  // The lid of the text of the first leaf of the node at height sb (0: none).
  ext('enHeadLid', [['sb', 'int']], ['int']),
  // The engine's flags (ST_*), as ints; one interpreted step taken (the step counter).
  ext('enSt', [['k', 'int']], ['int']), ext('enSetSt', [['k', 'int'], ['v', 'int']]), ext('enTick', []),
  // The repair memory (total parsing): a list of ints the family lays out (RM_*): its cell i, set,
  // its length, one more cell, and a cut back to length n. A mark holds its length and a reset cuts
  // back to it, so the repairs a losing attempt recorded vanish with its nodes.
  extR('enRm', [['i', 'int']], ['int']), ext('enRmSet', [['i', 'int'], ['v', 'int']]), extR('enRmLen', [], ['int']), ext('enRmPush', [['v', 'int']]), ext('enRmCut', [['n', 'int']]),
  // A node of rule r with no children at the position (zero-width: at its token, or after the last
  // token at the end of input), appended to the list.
  ext('enMiss', [['r', 'int']]),
  // The examined extent (one past the furthest token examined: lookEnd), and its reset to e.
  extR('enLookEnd', [], ['int']), ext('enLookSet', [['e', 'int']]),
];
// The text of a literal (by lid) and the name of a token kind (by kid): the words of a repair's
// message (each target prints them over its own tables).
const textExt = (name: string): Fn => ({ name, doc: '', params: [{ name: 'x', ty: 'int' }], ret: ['str'], body: [], extern: true });
export const TEXT_EXTERNS: Fn[] = [textExt('litText'), textExt('kindText')];
// The repair memory's layout: whether a total parse is recovering; the farthest token index a
// required literal / token / NUD failed at in this attempt (-1: none); where the innermost probe
// began (an optional, a repetition's element, an ordered branch: no repair before it consumed;
// -1: none); the position and depth of the interpreted frames entered there with nothing consumed
// (termination T2); the attempts made, and the most one scope took; the bars (strictly increasing, at most RM_MAX_BARS); then the
// repairs, three ints each (kind, token index, arg).
export const RM_REC = 0, RM_FAIL = 1, RM_PROBE = 2, RM_SP = 3, RM_SD = 4, RM_ATT = 5, RM_AMAX = 6, RM_NB = 7, RM_BARS = 8, RM_MAX_BARS = 32, RM_DIAGS = RM_BARS + RM_MAX_BARS;
export const ST_CAPPED = 0, ST_FORM = 1, ST_TAIL = 2, ST_SUP_NEXT = 3, ST_SUP_CUR = 4, ST_CTX = 5;
const ST_ALL = [ST_CAPPED, ST_FORM, ST_TAIL, ST_SUP_NEXT, ST_SUP_CUR, ST_CTX];

const T = (i: Expr): Expr => ({ k: 'tab', t: 'rt', i });
const add = (a: Expr, b: Expr): Expr => bin('add', a, b);
const sub = (a: Expr, b: Expr): Expr => bin('sub', a, b);
const eq = (a: Expr, b: Expr): Expr => bin('eq', a, b);
const ne = (a: Expr, b: Expr): Expr => bin('ne', a, b);
const lt = (a: Expr, b: Expr): Expr => bin('lt', a, b);
const ge = (a: Expr, b: Expr): Expr => bin('ge', a, b);
const gt = (a: Expr, b: Expr): Expr => bin('gt', a, b);
const and = (...es: Expr[]): Expr => es.reduce((x, y) => bin('and', x, y));
const or = (...es: Expr[]): Expr => es.reduce((x, y) => bin('or', x, y));
const not = (e: Expr): Expr => ({ k: 'not', e });
const call = (fn: string, ...args: Expr[]): Expr & { k: 'call' } => ({ k: 'call', fn, args });
const run = (fn: string, ...args: Expr[]): Stmt => ({ k: 'run', call: call(fn, ...args) });
const let_ = (name: string, init: Expr, ty: Ty0 = 'int'): Stmt => ({ k: 'let', name, ty, init });
const set = (name: string, e: Expr): Stmt => ({ k: 'set', name, e });
const if_ = (c: Expr, then: Stmt[], els?: Stmt[]): Stmt => (els ? { k: 'if', c, then, else: els } : { k: 'if', c, then });
const while_ = (c: Expr, body: Stmt[]): Stmt => ({ k: 'while', c, body });
const brk: Stmt = { k: 'break' };
const tru: Expr = { k: 'bool', v: true }, fls: Expr = { k: 'bool', v: false };
// Table cell base + k, and whether it holds 1.
const at = (base: Expr, k: number): Expr => T(k === 0 ? base : add(base, n(k)));
// The record a reference cell refers to (-1: none); the table holds references relative to their cell.
const R = (c: Expr): Expr => call('riRef', c);
const atR = (base: Expr, k: number): Expr => R(k === 0 ? base : add(base, n(k)));
const isT = (base: Expr, k: number): Expr => eq(at(base, k), n(1));
const inc = (name: string, k: Expr = n(1)): Stmt => set(name, add(v(name), k));
const le0 = (name: string): Expr => bin('le', v(name), n(0));
const b2i = (e: Expr, name: string): Stmt[] => [set(name, n(0)), if_(e, [set(name, n(1))])];
const method = (name: string, params: [string, Ty0][], ret: Ty0[], body: Stmt[]): Fn => ({ name, doc: '', params: params.map(([pn, ty]) => ({ name: pn, ty })), ret, body, method: true });

// Whether the token at the position is in FIRST signature f ([nLits lid* nKinds kid*]).
const riSig = method('riSig', [['f', 'int']], ['bool'], [
  let_('kid', call('enPeekKid')),
  if_(lt(v('kid'), n(0)), [ret(fls)]),
  let_('lid', call('enPeekLid')),
  let_('nl', T(v('f'))),
  let_('i', n(0)),
  while_(lt(v('i'), v('nl')), [if_(eq(T(add(add(v('f'), n(1)), v('i'))), v('lid')), [ret(tru)]), inc('i')]),
  let_('kb', add(add(v('f'), n(1)), v('nl'))),
  let_('nk', T(v('kb'))),
  set('i', n(0)),
  while_(lt(v('i'), v('nk')), [if_(eq(T(add(add(v('kb'), n(1)), v('i'))), v('kid')), [ret(tru)]), inc('i')]),
  ret(fls),
]);
// The record the reference in cell c refers to (-1: none).
const riRef: Fn = { ...method('riRef', [['c', 'int']], ['int'], [
  let_('x', T(v('c'))),
  if_(lt(v('x'), n(0)), [ret(n(-1))]),
  ret(sub(v('c'), v('x'))),
]), reads: true };
// Whether x is in the list l ([n x*]).
const riIn = method('riIn', [['l', 'int'], ['x', 'int']], ['bool'], [
  let_('i', n(0)),
  while_(lt(v('i'), T(v('l'))), [if_(eq(T(add(add(v('l'), n(1)), v('i'))), v('x')), [ret(tru)]), inc('i')]),
  ret(fls),
]);
// Whether Guard g admits the token at the position (-1: no guard). A guard that tests anything
// refuses at the end of input, as the native candidate frame does.
const riGuardIn = method('riGuardIn', [['g', 'int']], ['bool'], [
  if_(lt(v('g'), n(0)), [ret(tru)]),
  if_(lt(call('enPeekKid'), n(0)), [ret(fls)]),
  if_(and(ge(at(v('g'), 0), n(0)), not(call('enAhead', at(v('g'), 0), tru))), [ret(fls)]),
  if_(and(ge(at(v('g'), 1), n(0)), not(call('enSecondIn', at(v('g'), 1)))), [ret(fls)]),
  let_('nl', at(v('g'), 2)),
  let_('i', n(0)),
  while_(lt(v('i'), v('nl')), [
    let_('x', add(add(v('g'), n(3)), add(add(v('i'), v('i')), v('i')))),
    let_('hit', or(call('enAhead', at(v('x'), 0), tru), and(isT(v('x'), 2), call('enCtxWord'))), 'bool'),
    if_(ne(v('hit'), isT(v('x'), 1)), [ret(fls)]),
    inc('i'),
  ]),
  let_('pb', add(add(v('g'), n(3)), add(add(v('nl'), v('nl')), v('nl')))),
  let_('np', T(v('pb'))),
  set('i', n(0)),
  while_(lt(v('i'), v('np')), [
    let_('x', add(add(v('pb'), n(1)), add(v('i'), v('i')))),
    if_(and(call('enAhead', at(v('x'), 0), tru), not(call('enSecondIn', at(v('x'), 1)))), [ret(fls)]),
    inc('i'),
  ]),
  let_('fs', R(add(add(v('pb'), n(1)), add(v('np'), v('np'))))),
  if_(and(ge(v('fs'), n(0)), not(call('riSig', v('fs')))), [ret(fls)]),
  ret(tru),
]);
// Guard g refuses: a failure at the position (see guarded).
const riGuard = method('riGuard', [['g', 'int']], ['bool'], [
  if_(call('riGuardIn', v('g')), [ret(tru)]),
  run('riFail', call('enPos')),
  ret(fls),
]);
// A rule (by id), interpreted with d levels left, or native at d = 0.
const riRule = method('riRule', [['r', 'int'], ['d', 'int']], ['bool'], [
  if_(le0('d'), [ret(call('enRule', v('r')))]),
  if_(call('riNat', v('r'), n(-1)), [ret(tru)]),
  let_('rec', T(add(n(2), v('r')))),
  if_(eq(T(v('rec')), n(REC_RD)), [ret(call('riRd', v('r'), v('rec'), sub(v('d'), n(1))))]),
  // A Pratt rule called fresh: the suppress set staged for it becomes the one in force.
  let_('prev', call('enSt', n(ST_SUP_CUR))),
  let_('next', call('enSt', n(ST_SUP_NEXT))),
  run('enSetSt', n(ST_SUP_CUR), v('next')),
  run('enSetSt', n(ST_SUP_NEXT), n(0)),
  let_('ok', call('riBp', v('r'), v('rec'), n(0), sub(v('d'), n(1))), 'bool'),
  run('enSetSt', n(ST_SUP_CUR), v('prev')),
  ret(v('ok')),
]);
const newBest = (pos: Expr): Expr => ({ k: 'mkRec', rec: 'BestCand', fields: { pos, off: n(0), won: n(0), form: n(0), tail: n(0), capped: n(0), h0: call('enRmLen'), hb: call('enRmLen') } });
// The position after a longest match: where its best candidate ended (each candidate went back to save).
const wonPos: Stmt[] = [if_(gt(fld(v('best'), 'won'), n(0)), [run('enSetPos', fld(v('best'), 'pos'))])];
// A candidate of rule r's longest match tried from token `save` (the list from height sb), its
// children from height c, under mark k, that matched (ok): when it ends past the best so far its
// node replaces the list from sb and it is the best (with the node's form, tail and capped flag),
// else it is undone. The position goes back to save either way. A repaired candidate (stage 3)
// competes by its end too; at an equal end the one with fewer repairs wins (never in a strict
// parse, which has none). The repairs of a best it beat are dropped from the repair memory (the
// best's are [h0, hb), this candidate's from hb).
const riCand = method('riCand', [['r', 'int'], ['sb', 'int'], ['save', 'int'], ['c', 'int'], ['k', 'int'], ['ok', 'bool'], ['form', 'int'], ['tail', 'int'], ['capped', 'int']], [], [
  let_('x', fld(v('best'), 'hb')),
  let_('win', fls, 'bool'),
  if_(v('ok'), [
    let_('e', call('enPos')),
    set('win', or(gt(v('e'), fld(v('best'), 'pos')), and(eq(v('e'), fld(v('best'), 'pos')), gt(fld(v('best'), 'won'), n(0)), lt(sub(call('enRmLen'), v('x')), sub(v('x'), fld(v('best'), 'h0')))))),
  ]),
  if_(v('win'), [
    run('enUnmark', v('k')),
    run('enWin', v('r'), v('c'), v('save'), v('sb')),
    if_(gt(v('x'), fld(v('best'), 'h0')), [run('riRmDrop', fld(v('best'), 'h0'), v('x'))]),
    { k: 'setField', name: 'best', f: 'hb', e: call('enRmLen') },
    { k: 'setField', name: 'best', f: 'pos', e: call('enPos') },
    { k: 'setField', name: 'best', f: 'off', e: call('enFinOff') },
    { k: 'setField', name: 'best', f: 'won', e: n(1) },
    { k: 'setField', name: 'best', f: 'form', e: v('form') },
    { k: 'setField', name: 'best', f: 'tail', e: v('tail') },
    { k: 'setField', name: 'best', f: 'capped', e: v('capped') },
  ], [run('enReset', v('k')), run('enUnmark', v('k'))]),
  run('enBack', v('save')),
]);
riCand.params.push({ name: 'best', ty: 'rec_BestCand', ref: true });
// An rd rule (record rec). The single and the predictive forms take their one admitted
// alternative's match (an empty one too); a longest-match list keeps a candidate only when it
// ends past the best so far (an earlier-declared one wins a tie).
// (The single and predictive forms' best starts below save, so their one match wins even empty.)
const riRdIn = method('riRdIn', [['r', 'int'], ['rec', 'int'], ['d', 'int']], ['bool'], [
  let_('na', at(v('rec'), 2)),
  let_('one', or(isT(v('rec'), 1), eq(v('na'), n(1))), 'bool'),
  let_('save', call('enPos')),
  let_('sb', call('enSh')),
  { k: 'let', name: 'best', ty: 'rec_BestCand', init: newBest(v('save')) },
  if_(v('one'), [{ k: 'setField', name: 'best', f: 'pos', e: sub(v('save'), n(1)) }]),
  let_('i', n(0)),
  while_(lt(v('i'), v('na')), [
    let_('a', add(add(v('rec'), n(3)), add(v('i'), v('i')))),
    if_(call('riGuard', atR(v('a'), 0)), [
      let_('c', call('enSh')),
      let_('k', call('enMark')),
      let_('ok', call('riList', atR(v('a'), 1), v('d')), 'bool'),
      run('riCand', v('r'), v('sb'), v('save'), v('c'), v('k'), v('ok'), n(0), n(0), n(0), v('best')),
      if_(v('one'), [brk]),
    ]),
    inc('i'),
  ]),
  if_(eq(fld(v('best'), 'won'), n(0)), [run('riFail', v('save'))]),
  ...wonPos,
  ret(gt(fld(v('best'), 'won'), n(0))),
]);
const riList = method('riList', [['l', 'int'], ['d', 'int']], ['bool'], [
  let_('nn', T(v('l'))),
  let_('i', n(0)),
  while_(lt(v('i'), v('nn')), [if_(not(call('riStep', R(add(add(v('l'), n(1)), v('i'))), v('d'))), [ret(fls)]), inc('i')]),
  ret(tru),
]);
// An attempt undone when it fails (a repetition body, an optional, an ordered branch).
const attempt = (ok: string, e: Expr, onFail: Stmt[] = [], onOk: Stmt[] = []): Stmt[] => [
  let_('k', call('enMark')), let_(ok, e, 'bool'),
  if_(v(ok), [run('enUnmark', v('k')), ...onOk], [run('enReset', v('k')), run('enUnmark', v('k')), ...onFail]),
];
// Steps run as a probe (an optional, a repetition's element, an ordered branch, an element after a
// separator): no repair fires in them before they consumed a token (RM_PROBE: where the innermost
// began). `pr` names the local that keeps the outer probe.
const probe = (pr: string, body: Stmt[]): Stmt[] => [
  let_(pr, call('enRm', n(RM_PROBE))), run('enRmSet', n(RM_PROBE), call('enPos')), ...body, run('enRmSet', n(RM_PROBE), v(pr)),
];
const op = (k: number, body: Stmt[]): Stmt => if_(eq(v('op'), n(k)), body);
const S1 = at(v('s'), 1), S2 = at(v('s'), 2), S3 = at(v('s'), 3), S1R = atR(v('s'), 1), S2R = atR(v('s'), 2), S3R = atR(v('s'), 3);
// A body guard that refuses: a failure at the position, as the body's attempt would have been (a
// plan with more guards records the same failures: the bars do not depend on the plan).
const guarded = (body: Stmt[]): Stmt => if_(and(ge(S1, n(0)), not(call('enAhead', S1, tru))), [run('riFail', call('enPos')), ...body]);
const riStep = method('riStep', [['s', 'int'], ['d', 'int']], ['bool'], [
  run('enTick'),
  let_('op', T(v('s'))),
  op(REC_S_LIT, [ret(or(call('enLit', S1), call('riMiss', n(REC_S_LIT), S1)))]),
  op(REC_S_COMP, [ret(or(call('enComp', S1), call('riMiss', n(REC_S_COMP), S1)))]),
  op(REC_S_TOK, [ret(or(call('enTok', S1), call('riMiss', n(REC_S_TOK), S1)))]),
  op(REC_S_TPLTOK, [ret(or(call('enTok', S1), call('enTpl', S2)))]),
  op(REC_S_RULE, [ret(call('riRule', S1, v('d')))]),
  op(REC_S_RULEBP, [
    if_(le0('d'), [ret(call('enBp', S1, S2))]),
    if_(call('riNat', S1, S2), [ret(tru)]),
    ret(call('riBp', S1, T(add(n(2), S1)), S2, sub(v('d'), n(1)))),
  ]),
  // A repetition stops at a body that matches nothing (an interpreted loop drops a zero-width
  // iteration: termination T1); the native loop never meets one on input it accepts.
  op(REC_S_STAR, [
    while_(tru, [
      guarded([brk]),
      let_('p0', call('enPos')),
      ...probe('pr', attempt('ok', call('riStep', S2R, v('d')))),
      if_(or(not(v('ok')), eq(call('enPos'), v('p0'))), [brk]),
    ]),
    ret(tru),
  ]),
  op(REC_S_OPT, [guarded([ret(tru)]), ...probe('pr', attempt('ok', call('riList', S2R, v('d')))), ret(tru)]),
  // elem (delim elem)*: a trailing delimiter stays matched.
  op(REC_S_SEP, [
    guarded([ret(tru)]),
    let_('el', S2R),
    ...probe('pr', attempt('ok', call('riStep', v('el'), v('d')))),
    if_(not(v('ok')), [ret(tru)]),
    while_(call('enLit', S3), [
      let_('k2', call('enMark')),
      ...probe('pr2', [let_('ok2', call('riStep', v('el'), v('d')), 'bool')]),
      if_(not(v('ok2')), [run('enReset', v('k2')), run('enUnmark', v('k2')), brk]),
      run('enUnmark', v('k2')),
    ]),
    ret(tru),
  ]),
  op(REC_S_ALTLIT, [
    let_('i', n(0)),
    while_(lt(v('i'), S1), [if_(call('enLit', T(add(add(v('s'), n(2)), v('i')))), [ret(tru)]), inc('i')]),
    run('riFail', call('enPos')),
    ret(fls),
  ]),
  // An ordered choice: the first branch its FIRST signature admits (-1: any) that matches; a
  // predictive one only the first it admits.
  op(REC_S_ALT, [
    let_('i', n(0)),
    while_(lt(v('i'), S2), [
      let_('a', add(add(v('s'), n(3)), add(v('i'), v('i')))),
      let_('f', atR(v('a'), 0)),
      let_('adm', or(lt(v('f'), n(0)), call('riSig', v('f'))), 'bool'),
      if_(not(v('adm')), [run('riFail', call('enPos'))]),
      if_(v('adm'), [
        ...probe('pr', attempt('ok', call('riList', atR(v('a'), 1), v('d')))),
        if_(v('ok'), [ret(tru)]),
        if_(eq(S1, n(1)), [brk]),
      ]),
      inc('i'),
    ]),
    run('riFail', call('enPos')),
    ret(fls),
  ]),
  op(REC_S_LOOK, [ret(eq(call('enLook', S1), eq(S2, n(1))))]),
  op(REC_S_AHEAD, [ret(call('enAhead', S1, eq(S2, n(1))))]),
  op(REC_S_AHEADCTX, [
    if_(eq(S2, n(1)), [ret(or(call('enAhead', S1, tru), call('enCtxWord')))]),
    ret(and(call('enAhead', S1, fls), not(call('enCtxWord')))),
  ]),
  op(REC_S_SEQ, [ret(call('riList', S1R, v('d')))]),
  op(REC_S_SAMELINE, [ret(and(ge(call('enPeekKid'), n(0)), not(call('enPeekNl'))))]),
  op(REC_S_SUPPRESS, [
    run('enSetSt', n(ST_SUP_NEXT), S1),
    let_('ok', call('riList', S2R, v('d')), 'bool'),
    run('enSetSt', n(ST_SUP_NEXT), n(0)),
    ret(v('ok')),
  ]),
  op(REC_S_CTX, [
    let_('c0', call('enSt', n(ST_CTX))),
    run('enSetSt', n(ST_CTX), S1),
    let_('ok', call('riList', S2R, v('d')), 'bool'),
    run('enSetSt', n(ST_CTX), v('c0')),
    ret(v('ok')),
  ]),
  // A shared step: the native function at d = 0 (where it is printed in building form), else its body.
  op(REC_S_SHARED, [
    if_(and(le0('d'), eq(S2, n(1))), [ret(call('enShared', S1))]),
    ret(call('riStep', S3R, v('d'))),
  ]),
  ret(fls),
]);

// ── Pratt rules (record rec: emit-portable.ts recoveryTables, pratt) ──
// The cells of a Pratt record: its header, then sections at offsets the header holds.
const P_NUD_HOLE = 1, P_POST_HOLE = 2, P_POST_SAMELINE = 3, P_ARMS = 4, P_PRE = 5, P_BIN = 6, P_POST = 7, P_LED = 8, P_POST_TOK = 9;
const sec = (k: number): Expr => add(v('rec'), at(v('rec'), k));
// The operand of an operator: the rule again at binding power bp, interpreted or native.
const operand = (bp: Expr): Expr => ({ k: 'call', fn: 'riOperand', args: [v('r'), v('rec'), bp, v('d')] });
const riOperand = method('riOperand', [['r', 'int'], ['rec', 'int'], ['bp', 'int'], ['d', 'int']], ['bool'], [
  if_(le0('d'), [ret(call('enBp', v('r'), v('bp')))]),
  if_(call('riNat', v('r'), v('bp')), [ret(tru)]),
  ret(call('riBp', v('r'), v('rec'), v('bp'), sub(v('d'), n(1)))),
]);
// The entry of an operator table (tables[i] = [n (lid field*)*], `w` ints each) for lid, or -1.
const riOp = method('riOp', [['tb', 'int'], ['w', 'int'], ['lid', 'int']], ['int'], [
  let_('i', n(0)),
  let_('x', add(v('tb'), n(1))),
  while_(lt(v('i'), T(v('tb'))), [if_(eq(T(v('x')), v('lid')), [ret(v('x'))]), inc('x', v('w')), inc('i')]),
  ret(n(-1)),
]);
// A NUD arm tried from `save` (its children from height c, mark k): riCand.
const nudCand = (ok: Expr, form: Expr, tail: Expr, capped: Expr): Stmt[] => [
  let_('c', call('enSh')),
  let_('k', call('enMark')),
  let_('ok', ok, 'bool'),
  run('riCand', v('r'), v('sb'), v('save'), v('c'), v('k'), v('ok'), form, tail, capped, v('best')),
];
// The NUD: every arm a candidate of a longest match. It returns whether one matched and the
// offset of its node, and leaves the node's capped flag, form and tail in the engine.
const riNud = method('riNud', [['r', 'int'], ['rec', 'int'], ['minBp', 'int'], ['d', 'int']], ['bool', 'int'], [
  run('enSetSt', n(ST_CAPPED), n(0)),
  let_('kid', call('enPeekKid')),
  if_(lt(v('kid'), n(0)), [ret(fls, n(0))]),
  let_('lid', call('enPeekLid')),
  let_('save', call('enPos')), let_('sb', call('enSh')),
  { k: 'let', name: 'best', ty: 'rec_BestCand', init: newBest(v('save')) },
  let_('x', add(sec(P_ARMS), n(1))),
  let_('i', n(0)),
  while_(lt(v('i'), T(sec(P_ARMS))), [
    let_('tag', T(v('x'))),
    if_(eq(v('tag'), n(REC_N_TOK)), [
      // A token arm's leaf is offered only when its one-token match would win.
      if_(and(eq(v('kid'), at(v('x'), 1)), gt(add(v('save'), n(1)), fld(v('best'), 'pos'))), [
        let_('c', call('enSh')),
        let_('k', call('enMark')),
        run('enLeafKid'),
        run('riCand', v('r'), v('sb'), v('save'), v('c'), v('k'), tru, n(0), n(0), n(0), v('best')),
      ]),
      if_(and(isT(v('x'), 2), eq(v('kid'), T(n(1)))), nudCand(call('enTpl', at(v('rec'), P_NUD_HOLE)), n(0), n(0), n(0))),
      inc('x', n(3)),
    ], [
      if_(eq(v('tag'), n(REC_N_PREFIX)), [
        let_('p', call('riOp', sec(P_PRE), n(4), v('lid'))),
        if_(ge(v('p'), n(0)), [
          let_('c', call('enSh')),
          let_('k', call('enMark')),
          run('enLeafOp'),
          let_('ok', operand(at(v('p'), 1)), 'bool'),
          // An operand that is not the target the operator requires fails the whole Pratt call.
          if_(and(v('ok'), isT(v('p'), 2), ne(call('enSt', n(ST_FORM)), n(0))), [
            run('enReset', v('k')), run('enUnmark', v('k')), run('enSetSt', n(ST_CAPPED), n(0)), ret(fls, n(0)),
          ]),
          let_('pf', at(v('p'), 3)),
          run('riCand', v('r'), v('sb'), v('save'), v('c'), v('k'), v('ok'), v('pf'), n(1), n(0), v('best')),
        ]),
        inc('x', n(1)),
      ], [
        if_(eq(v('tag'), n(REC_N_BRACKET)), [
          if_(eq(v('lid'), at(v('x'), 1)), nudCand(call('riList', atR(v('x'), 2), v('d')), n(0), at(v('x'), 3), n(0))),
        ]),
        if_(eq(v('tag'), n(REC_N_SEQ)), [
          if_(call('riGuard', atR(v('x'), 1)), nudCand(call('riList', atR(v('x'), 2), v('d')), n(0), at(v('x'), 3), n(0))),
        ]),
        if_(eq(v('tag'), n(REC_N_CAPPED)), [
          if_(and(lt(v('minBp'), at(v('x'), 3)), call('riGuard', atR(v('x'), 1))), nudCand(call('riList', atR(v('x'), 2), v('d')), n(0), n(0), n(1))),
        ]),
        inc('x', n(4)),
      ]),
    ]),
    inc('i'),
  ]),
  if_(eq(fld(v('best'), 'won'), n(0)), [run('riFail', v('save'))]),
  // A sub-parse may leave the capped flag set: only a capped arm that won makes this node capped.
  run('enSetSt', n(ST_CAPPED), fld(v('best'), 'capped')), run('enSetSt', n(ST_FORM), fld(v('best'), 'form')), run('enSetSt', n(ST_TAIL), fld(v('best'), 'tail')),
  ...wonPos,
  ret(gt(fld(v('best'), 'won'), n(0)), fld(v('best'), 'off')),
]);
// The Pratt loop at minimum binding power minBp: the NUD, then continuations (mixfix leds,
// postfix tokens and templates, postfix and binary operators) while one binds. The left operand
// is the node at height sb.
const ledOk = (x: Expr): Expr => and(
  not(and(isT(x, 4), eq(v('tc'), n(1)))),
  or(lt(at(x, 2), n(0)), gt(at(x, 2), v('minBp'))),
  not(and(isT(x, 3), v('nl'))),
  or(lt(at(x, 7), n(0)), not(call('riIn', atR(x, 7), v('head')))),
  not(call('riIn', add(x, n(8)), v('sup'))),
);
const finLed = (form: Expr): Stmt[] => [
  run('enFinLed', v('r'), v('sb'), v('leftOff'), v('start')), set('leftOff', call('enFinOff')), set('hl', call('enSh')), set('fm', form), set('prog', tru),
];
const riBpIn = method('riBpIn', [['r', 'int'], ['rec', 'int'], ['minBp', 'int'], ['d', 'int']], ['bool'], [
  let_('start', call('enPos')),
  let_('sb', call('enSh')),
  { k: 'letCall', names: ['ok', 'leftOff'], call: call('riNud', v('r'), v('rec'), v('minBp'), v('d')) },
  if_(not(v('ok')), [ret(fls)]),
  let_('fm', call('enSt', n(ST_FORM))),
  if_(ne(call('enSt', n(ST_CAPPED)), n(0)), [ret(tru)]),
  let_('tc', call('enSt', n(ST_TAIL))),
  let_('hl', call('enSh')),
  while_(tru, [
    let_('kid', call('enPeekKid')),
    if_(lt(v('kid'), n(0)), [brk]),
    let_('lid', call('enPeekLid')),
    let_('nl', call('enPeekNl'), 'bool'),
    let_('prog', fls, 'bool'),
    // What the led tests read of the engine: the left operand's first leaf, the suppress set in force.
    let_('head', call('enHeadLid', v('sb'))),
    let_('sup', call('enSt', n(ST_SUP_CUR))),
    let_('j', n(0)),
    let_('x', add(sec(P_LED), n(1))),
    while_(and(lt(v('j'), T(sec(P_LED))), not(v('prog'))), [
      if_(and(eq(at(v('x'), 0), v('lid')), ledOk(v('x'))), [
        let_('k', call('enMark')),
        if_(call('riList', atR(v('x'), 1), v('d')), [
          run('enUnmark', v('k')),
          ...finLed(at(v('x'), 6)),
          if_(isT(v('x'), 5), [set('tc', n(1))]),
        ], [run('enReset', v('k')), run('enUnmark', v('k'))]),
      ]),
      inc('x', add(n(9), at(v('x'), 8))),
      inc('j'),
    ]),
    if_(and(not(v('prog')), eq(v('tc'), n(0)), call('riIn', sec(P_POST_TOK), v('kid'))), [run('enLeafKid'), ...finLed(n(0))]),
    if_(and(not(v('prog')), eq(v('tc'), n(0)), ge(at(v('rec'), P_POST_HOLE), n(0)), eq(v('kid'), T(n(1)))), [
      if_(call('enTpl', at(v('rec'), P_POST_HOLE)), finLed(n(0))),
    ]),
    if_(not(v('prog')), [
      let_('q', call('riOp', sec(P_POST), n(3), v('lid'))),
      if_(and(ge(v('q'), n(0)), eq(v('tc'), n(0)), gt(at(v('q'), 1), v('minBp')), or(not(isT(v('rec'), P_POST_SAMELINE)), not(v('nl')))), [
        if_(and(isT(v('q'), 2), ne(v('fm'), n(0))), [ret(fls)]),
        run('enLeafOp'), ...finLed(n(1)), set('tc', n(1)),
      ]),
    ]),
    if_(not(v('prog')), [
      let_('opl', call('enOpLid')),
      let_('b', call('riOp', sec(P_BIN), n(5), v('opl'))),
      if_(or(lt(v('b'), n(0)), bin('le', at(v('b'), 1), v('minBp'))), [brk]),
      if_(or(and(isT(v('b'), 3), ne(v('fm'), n(0))), and(isT(v('b'), 4), eq(v('fm'), n(2)))), [ret(fls)]),
      let_('ls', call('enPos')),
      run('enLeafOpN'),
      if_(not(operand(at(v('b'), 2))), [run('enBack', v('ls')), run('enCut', v('hl')), brk]),
      ...finLed(n(1)),
      // A capped right operand caps this node: it returns at once, still capped (PrattLowering.binary).
      if_(ne(call('enSt', n(ST_CAPPED)), n(0)), [run('enSetSt', n(ST_FORM), n(1)), ret(tru)]),
      set('tc', n(1)),
    ]),
  ]),
  // A sub-parse's capped flag is not this node's (PrattLowering.bpClose).
  run('enSetSt', n(ST_CAPPED), n(0)),
  run('enSetSt', n(ST_FORM), v('fm')),
  ret(tru),
]);

// ── Recovery (stage 3): bars, repairs, attempts and the total parse ──
// A total parse runs where the native parse rejected (recovery-1/DESIGN.md, recovery-5/NOTES.md).
// Its scope is one top-level entry (the reuse plan's: the entry rule's repetition element) or, for
// a grammar without one, the whole input. Attempt 0 is the strict parse of the scope; attempt k
// runs with the bars 1..k, bar k the farthest token a required literal / token / NUD failed at in
// attempt k-1 (strictly increasing, at most RM_MAX_BARS). A repair fires only near a bar (a bar in
// [pos, pos + 2]) and never in a probe before it consumed: a required literal or token that is not
// there is supplied, a zero-width `$missing` node and its repair record. Every decision is a
// function of the position and the bars, so the result is deterministic and the same in every
// target. When no attempt succeeds, the scope's tokens up to the next one that can begin an entry
// (at least one) become one `$error` node, and the next entry is parsed.
// Native-first: an interpreted frame runs the native function first and keeps its result when it
// matched and no bar lies in [start, x + 2], x its examined extent (no repair could fire in it: the
// interpreted frame would be strict there, and strict ≡ native); otherwise it is undone and
// interpreted. A frame that failed is interpreted, so a failure's position is known.
const INF = 1 << 30;
const rm = (i: number): Expr => call('enRm', n(i));
// The trailer of the plan's table ([2 + N] holds its index): the rule ids of `$error`, `$missing`
// and the entry rule; the top-level element (-1: the scope is the whole input); the FIRST
// signature of a top-level entry (-1: unknown).
const TR = (k: number): Expr => add(T(add(n(2), T(n(0)))), n(k));
// Cells [a, b) of the repair memory removed (the cells after them moved down).
const riRmDrop = method('riRmDrop', [['a', 'int'], ['b', 'int']], [], [
  let_('ln', call('enRmLen')),
  let_('i', v('b')),
  while_(lt(v('i'), v('ln')), [run('enRmSet', sub(add(v('a'), v('i')), v('b')), call('enRm', v('i'))), inc('i')]),
  run('enRmCut', sub(v('ln'), sub(v('b'), v('a')))),
]);
// Whether a bar lies in [lo, hi].
const riBarIn = method('riBarIn', [['lo', 'int'], ['hi', 'int']], ['bool'], [
  let_('nb', rm(RM_NB)),
  let_('i', n(0)),
  while_(lt(v('i'), v('nb')), [
    let_('b', call('enRm', add(n(RM_BARS), v('i')))),
    if_(and(ge(v('b'), v('lo')), bin('le', v('b'), v('hi'))), [ret(tru)]),
    inc('i'),
  ]),
  ret(fls),
]);
// A required match failed at token p: the attempt's farthest failure.
const riFail = method('riFail', [['p', 'int']], [], [if_(gt(v('p'), rm(RM_FAIL)), [run('enRmSet', n(RM_FAIL), v('p'))])]);
// The match of step op (REC_S_LIT / COMP: a literal, lid x; REC_S_TOK: a token of kind x).
const riMatch = method('riMatch', [['op', 'int'], ['x', 'int']], ['bool'], [
  if_(eq(v('op'), n(REC_S_LIT)), [ret(call('enLit', v('x')))]),
  if_(eq(v('op'), n(REC_S_COMP)), [ret(call('enComp', v('x')))]),
  ret(call('enTok', v('x'))),
]);
// A required literal or token (step op, x its lid / kid) is not at the position. When a bar is near
// and no probe is still unconsumed it is repaired: when it is the token after, the token at the
// position is extra (an `$error` node over it, then the match); else it is supplied (a `$missing`
// node). Otherwise a failure.
const riMiss = method('riMiss', [['op', 'int'], ['x', 'int']], ['bool'], [
  let_('p', call('enPos')),
  let_('pr', rm(RM_PROBE)),
  if_(or(and(ge(v('pr'), n(0)), bin('le', v('p'), v('pr'))), not(call('riBarIn', v('p'), add(v('p'), n(2))))), [run('riFail', v('p')), ret(fls)]),
  if_(ge(call('enPeekKid'), n(0)), [
    let_('k', call('enMark')),
    let_('c', call('enSh')),
    run('enLeafKid'),
    run('enFinLed', T(TR(0)), v('c'), n(0), v('p')),
    if_(call('riMatch', v('op'), v('x')), [
      run('enUnmark', v('k')),
      run('enRmPush', n(DK_SKIP)), run('enRmPush', v('p')), run('enRmPush', add(v('p'), n(1))),
      ret(tru),
    ]),
    run('enReset', v('k')), run('enUnmark', v('k')),
  ]),
  run('enMiss', T(TR(1))),
  let_('kind', n(DK_MISS_LIT)),
  if_(eq(v('op'), n(REC_S_TOK)), [set('kind', n(DK_MISS_TOK))]),
  run('enRmPush', v('kind')), run('enRmPush', v('p')), run('enRmPush', v('x')),
  ret(tru),
]);
// Native-first (recovering only): rule r (bp < 0) or Pratt rule r at bp, natively; kept when it
// matched and no bar lies in its window, else undone (false: interpret it).
const riNat = method('riNat', [['r', 'int'], ['bp', 'int']], ['bool'], [
  if_(eq(rm(RM_REC), n(0)), [ret(fls)]),
  let_('start', call('enPos')),
  let_('lk', call('enLookEnd')),
  run('enLookSet', n(0)),
  let_('k', call('enMark')),
  // The engine's flags as the native call found them (it stages the suppress set it reads), put
  // back when it is undone, so the interpreted frame starts where the native one did.
  ...ST_ALL.map((st) => let_(`st${st}`, call('enSt', n(st)))),
  let_('ok', fls, 'bool'),
  if_(lt(v('bp'), n(0)), [set('ok', call('enRule', v('r')))], [set('ok', call('enBp', v('r'), v('bp')))]),
  let_('x', call('enLookEnd')),
  if_(gt(v('lk'), v('x')), [run('enLookSet', v('lk'))], [run('enLookSet', v('x'))]),
  if_(and(v('ok'), not(call('riBarIn', v('start'), add(v('x'), n(2))))), [run('enUnmark', v('k')), ret(tru)]),
  run('enReset', v('k')), run('enUnmark', v('k')),
  ...ST_ALL.map((st) => run('enSetSt', n(st), v(`st${st}`))),
  ret(fls),
]);
// Termination T2 (recovering only): the interpreted rd / Pratt frames entered at one position with
// nothing consumed are at most 2N + 2 deep (a strict parse never re-enters a rule there with the
// same state, so a deeper chain is a repair's recursion).
const t2 = (name: string, inner: string, params: [string, Ty0][]): Fn => method(name, params, ['bool'], [
  if_(eq(rm(RM_REC), n(0)), [ret(call(inner, ...params.map(([pn]) => v(pn))))]),
  let_('p', call('enPos')),
  let_('sp', rm(RM_SP)),
  let_('sd', rm(RM_SD)),
  let_('nd', n(1)),
  if_(eq(v('sp'), v('p')), [set('nd', add(v('sd'), n(1)))]),
  if_(gt(v('nd'), add(add(T(n(0)), T(n(0))), n(2))), [ret(fls)]),
  run('enRmSet', n(RM_SP), v('p')), run('enRmSet', n(RM_SD), v('nd')),
  let_('ok', call(inner, ...params.map(([pn]) => v(pn))), 'bool'),
  run('enRmSet', n(RM_SP), v('sp')), run('enRmSet', n(RM_SD), v('sd')),
  ret(v('ok')),
]);
const riRd = t2('riRd', 'riRdIn', [['r', 'int'], ['rec', 'int'], ['d', 'int']]);
const riBp = t2('riBp', 'riBpIn', [['r', 'int'], ['rec', 'int'], ['minBp', 'int'], ['d', 'int']]);
// One attempt at the scope from the position: top-level elements el, each consuming, until the
// position passes upto (one element when upto is the position), or the entry rule over the whole
// input (el < 0).
const riUnit = method('riUnit', [['el', 'int'], ['upto', 'int']], ['bool'], [
  if_(lt(v('el'), n(0)), [ret(and(call('riRule', T(TR(2)), n(INF)), lt(call('enPeekKid'), n(0))))]),
  while_(tru, [
    let_('p0', call('enPos')),
    if_(not(call('riStep', v('el'), n(INF))), [ret(fls)]),
    let_('p1', call('enPos')),
    if_(bin('le', v('p1'), v('p0')), [ret(fls)]),
    if_(gt(v('p1'), v('upto')), [ret(tru)]),
  ]),
  ret(fls),
]);
// The attempts at one scope: attempt 0 strict, each next one with one more bar; whether one matched
// (its nodes and repairs kept; a failed one undone).
const riAttempts = method('riAttempts', [['el', 'int'], ['upto', 'int']], ['bool'], [
  run('enRmSet', n(RM_NB), n(0)),
  let_('a0', rm(RM_ATT)),
  while_(tru, [
    run('enRmSet', n(RM_FAIL), n(-1)), run('enRmSet', n(RM_PROBE), n(-1)), run('enRmSet', n(RM_SP), n(-1)), run('enRmSet', n(RM_SD), n(0)),
    run('enRmSet', n(RM_ATT), add(rm(RM_ATT), n(1))),
    if_(gt(sub(rm(RM_ATT), v('a0')), rm(RM_AMAX)), [run('enRmSet', n(RM_AMAX), sub(rm(RM_ATT), v('a0')))]),
    let_('k', call('enMark')),
    if_(call('riUnit', v('el'), v('upto')), [run('enUnmark', v('k')), ret(tru)]),
    run('enReset', v('k')), run('enUnmark', v('k')),
    let_('f', rm(RM_FAIL)),
    let_('nb', rm(RM_NB)),
    if_(or(lt(v('f'), n(0)), ge(v('nb'), n(RM_MAX_BARS))), [brk]),
    if_(and(gt(v('nb'), n(0)), bin('le', v('f'), call('enRm', add(n(RM_BARS - 1), v('nb'))))), [brk]),
    run('enRmSet', add(n(RM_BARS), v('nb')), v('f')),
    run('enRmSet', n(RM_NB), add(v('nb'), n(1))),
  ]),
  ret(fls),
]);
// The totality fallback: the token at the position and the ones after it up to the next where a
// top-level entry el parses strictly (one that can begin one: FIRST signature sync, -1 unknown;
// el < 0: every token left) become one `$error` node and its repair. At the end of input: an
// `$error` node with no children.
const riSkip = method('riSkip', [['el', 'int'], ['sync', 'int']], [], [
  let_('p0', call('enPos')),
  let_('c', call('enSh')),
  if_(lt(call('enPeekKid'), n(0)), [run('enMiss', T(TR(0))), run('enRmPush', n(DK_SKIP)), run('enRmPush', v('p0')), run('enRmPush', v('p0')), ret()]),
  run('enLeafKid'),
  while_(ge(call('enPeekKid'), n(0)), [
    if_(and(ge(v('el'), n(0)), or(lt(v('sync'), n(0)), call('riSig', v('sync')))), [
      let_('p1', call('enPos')),
      let_('k', call('enMark')),
      let_('ok', call('riStep', v('el'), n(0)), 'bool'),
      let_('p2', call('enPos')),
      run('enReset', v('k')), run('enUnmark', v('k')),
      if_(and(v('ok'), gt(v('p2'), v('p1'))), [brk]),
    ]),
    run('enLeafKid'),
  ]),
  run('enFinLed', T(TR(0)), v('c'), n(0), v('p0')),
  run('enRmPush', n(DK_SKIP)), run('enRmPush', v('p0')), run('enRmPush', call('enPos')),
]);
// The total parse from the first token: the entry rule's node over every top-level entry (each
// parsed by its attempts, or skipped), or over the whole input; its repairs in the repair memory
// from RM_DIAGS. Look-back: an entry whose attempts all fail may follow one that ended early (an
// optional part of it failed where the error is: `try {} catch (e) { … finally {}`), so before the
// fallback the attempts run again from the previous entry's start (kept by the mark kp), over the
// entries up to past the failing one; if those fail too, the previous entry is parsed again as it
// was (its attempt 0) and the fallback skips from the failing one.
const riTotal = method('riTotal', [], [], [
  run('enRmSet', n(RM_REC), n(1)),
  run('enRmSet', n(RM_ATT), n(0)),
  let_('entry', T(TR(2))),
  let_('el', R(TR(3))),
  let_('sync', R(TR(4))),
  let_('sb', call('enSh')),
  if_(lt(v('el'), n(0)), [
    if_(not(call('riAttempts', n(-1), n(0))), [run('riSkip', n(-1), n(-1)), run('enWin', v('entry'), v('sb'), n(0), v('sb'))]),
  ], [
    let_('pp', n(-1)),
    while_(ge(call('enPeekKid'), n(0)), [
      let_('p', call('enPos')),
      let_('k', call('enMark')),
      if_(call('riAttempts', v('el'), v('p')), [
        if_(ge(v('pp'), n(0)), [run('enMarkDrop', n(0))]),
        set('pp', v('p')),
      ], [
        run('enUnmark', v('k')),
        let_('ok', fls, 'bool'),
        if_(ge(v('pp'), n(0)), [
          run('enReset', n(0)),
          set('ok', call('riAttempts', v('el'), v('p'))),
          // (attempt 0 matched it before, so it matches again)
          if_(not(v('ok')), [run('enSetPos', v('pp')), if_(not(call('riAttempts', v('el'), v('pp'))), [])]),
          run('enUnmark', n(0)),
        ]),
        if_(not(v('ok')), [run('riSkip', v('el'), v('sync'))]),
        set('pp', n(-1)),
      ]),
    ]),
    if_(ge(v('pp'), n(0)), [run('enUnmark', n(0))]),
    run('enWin', v('entry'), v('sb'), n(0), v('sb')),
  ]),
  run('enRmSet', n(RM_REC), n(0)),
]);
// A repair's diagnostic (kind, token index t, arg as riMiss / riSkip recorded it): a missing
// literal or token is zero-width where its node is; a skip spans its tokens [t, arg).
const repairDiag: Fn = {
  name: 'repairDiag',
  doc: '',
  params: [{ name: 'toks', ty: 'toks' }, { name: 'kind', ty: 'int' }, { name: 't', ty: 'idx' }, { name: 'arg', ty: 'idx' }],
  ret: ['rec_Diag'],
  body: [
    if_(and(eq(v('kind'), n(DK_SKIP)), gt(v('arg'), v('t'))), [ret(diag(v('kind'), tok(v('t'), 'off'), tok(sub(v('arg'), n(1)), 'end'), n(-1), n(-1), tok(v('t'), 'end')))]),
    let_('off', n(0)),
    if_(lt(v('t'), { k: 'len', e: v('toks') }), [set('off', tok(v('t'), 'off'))], [if_(gt(v('t'), n(0)), [set('off', tok(sub(v('t'), n(1)), 'end'))])]),
    if_(eq(v('kind'), n(DK_SKIP)), [ret(diag(v('kind'), v('off'), v('off'), n(-1), n(-1), v('off')))]),
    ret(diag(v('kind'), v('off'), v('off'), n(-1), n(-1), v('arg'))),
  ],
};

export function recoveryFamilyFns(): Fn[] {
  return [rejectDiag, repairDiag, diagMessage, diagRelated, riRef, riSig, riIn, riGuard, riGuardIn, riRule, riCand, riRd, riRdIn, riList, riStep, riOperand, riOp, riNud, riBp, riBpIn,
    riRmDrop, riBarIn, riFail, riMatch, riMiss, riNat, riUnit, riAttempts, riSkip, riTotal, ...ENGINE_EXTERNS, ...TEXT_EXTERNS];
}

// The family for a grammar: the functions, the record Diag and the plan's int table `rt`.
// `methods`: print only the engine methods (true), only the free functions (false), or all.
export function emitRecoveryFamily(L: Lowering, rt: number[], methods?: boolean): string {
  return printFns(L, recoveryFamilyFns(), [], [DIAG, BEST], [{ name: 'rt', data: rt }], methods === undefined ? undefined : (f) => (f.method === true) === methods, methods !== true);
}
