// Recovery family: total parsing's diagnostics, authored once and printed for each target through
// its `Lowering` (emitted only with the emit option `{ recovery: true }`, docs/TARGETS.md "Errors
// and tokens").
//
// A diagnostic is a record of numbers (`Diag`): what kind it is, the span it reports, and the span
// of a related location, or none. ONE formatter (`diagMessage`, `diagRelated`) spells every
// target's message text, so the three targets give the same words for the same record.
//
// Stage 1 (reject diagnostics, no recovery): the primary error of a rejected parse is the
// interpreter's (src/gen-parser.ts): the token at the position the entry rule stopped at, "after
// successful parse" when the entry rule matched and input is left over; its related location is
// the farthest token the parse examined, when that lies past the error (the interpreter's
// `[farthest: …]` hint).
//
// Boundary: running the entry rule and reading its examined extent (`lookEnd`) are each target's
// engine; this family decides what is reported from them, and how it is worded.

import { type Expr, type Fn, type Lowering, type RecordDecl, type Stmt, printFns } from './algo-ir.ts';
import { REC_RD, REC_N_TOK, REC_N_BRACKET, REC_N_SEQ, REC_N_CAPPED, REC_N_PREFIX, REC_S_LIT, REC_S_COMP, REC_S_TOK, REC_S_TPLTOK, REC_S_RULE, REC_S_RULEBP, REC_S_STAR, REC_S_OPT, REC_S_SEP, REC_S_ALTLIT, REC_S_ALT, REC_S_LOOK, REC_S_AHEAD, REC_S_AHEADCTX, REC_S_SEQ, REC_S_SAMELINE, REC_S_SUPPRESS, REC_S_CTX, REC_S_SHARED } from './emit-portable.ts';

export const DIAG: RecordDecl = {
  name: 'Diag',
  fields: ['kind', 'off', 'end', 'relOff', 'relEnd'].map((name) => ({ name, ty: 'int' as const })),
};
// The kinds of a diagnostic: the entry rule failed at a token; it failed with no token left; it
// matched and a token is left over.
export const DK_UNEXPECTED = 0, DK_EOF = 1, DK_LEFTOVER = 2;

const v = (name: string): Expr => ({ k: 'var', name });
const n = (k: number): Expr => ({ k: 'int', v: k });
const s = (t: string): Expr => ({ k: 'str', v: t });
const bin = (op: (Expr & { k: 'bin' })['op'], a: Expr, b: Expr): Expr => ({ k: 'bin', op, a, b });
const fld = (e: Expr, f: string): Expr => ({ k: 'field', e, f });
const tok = (i: Expr, f: 'off' | 'end'): Expr => ({ k: 'tokInt', t: { k: 'at', list: v('toks'), i }, f });
const ret = (...es: Expr[]): Stmt => ({ k: 'return', es });
const diag = (kind: Expr, off: Expr, end: Expr, relOff: Expr, relEnd: Expr): Expr => ({ k: 'mkRec', rec: 'Diag', fields: { kind, off, end, relOff, relEnd } });

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

// The message of a diagnostic of src.
const diagMessage: Fn = {
  name: 'diagMessage',
  doc: '',
  params: [{ name: 'src', ty: 'str' }, { name: 'd', ty: 'rec_Diag' }],
  ret: ['str'],
  body: [
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
// The engine, as the interpreter sees it (each target prints these over its own parse state).
export const ENGINE_EXTERNS: Fn[] = [
  // The position: read, set, and moved back (as the native backtrack does, folding what was examined).
  ext('enPos', [], ['int']), ext('enSetPos', [['p', 'int']]), ext('enBack', [['p', 'int']]),
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
];
export const ST_CAPPED = 0, ST_FORM = 1, ST_TAIL = 2, ST_SUP_NEXT = 3, ST_SUP_CUR = 4, ST_CTX = 5;

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
const riGuard = method('riGuard', [['g', 'int']], ['bool'], [
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
// A rule (by id), interpreted with d levels left, or native at d = 0.
const riRule = method('riRule', [['r', 'int'], ['d', 'int']], ['bool'], [
  if_(le0('d'), [ret(call('enRule', v('r')))]),
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
// An rd rule (record rec). The single and the predictive forms take their one admitted
// alternative's match (an empty one too); a longest-match list keeps a candidate only when it
// ends past the best so far (an earlier-declared one wins a tie).
const riRd = method('riRd', [['r', 'int'], ['rec', 'int'], ['d', 'int']], ['bool'], [
  let_('na', at(v('rec'), 2)),
  let_('one', or(isT(v('rec'), 1), eq(v('na'), n(1))), 'bool'),
  let_('save', call('enPos')),
  let_('sb', call('enSh')),
  let_('bestPos', v('save')),
  let_('won', fls, 'bool'),
  let_('i', n(0)),
  while_(lt(v('i'), v('na')), [
    let_('a', add(add(v('rec'), n(3)), add(v('i'), v('i')))),
    if_(call('riGuard', atR(v('a'), 0)), [
      let_('c', call('enSh')),
      let_('k', call('enMark')),
      let_('ok', call('riList', atR(v('a'), 1), v('d')), 'bool'),
      if_(and(v('ok'), or(v('one'), gt(call('enPos'), v('bestPos')))), [
        run('enUnmark', v('k')),
        run('enWin', v('r'), v('c'), v('save'), v('sb')),
        set('bestPos', call('enPos')),
        set('won', tru),
      ], [run('enReset', v('k')), run('enUnmark', v('k'))]),
      if_(v('one'), [brk]),
      run('enBack', v('save')),
    ]),
    inc('i'),
  ]),
  run('enSetPos', v('bestPos')),
  ret(v('won')),
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
const op = (k: number, body: Stmt[]): Stmt => if_(eq(v('op'), n(k)), body);
const S1 = at(v('s'), 1), S2 = at(v('s'), 2), S3 = at(v('s'), 3), S1R = atR(v('s'), 1), S2R = atR(v('s'), 2), S3R = atR(v('s'), 3);
const guarded = (body: Stmt[]): Stmt => if_(and(ge(S1, n(0)), not(call('enAhead', S1, tru))), body);
const riStep = method('riStep', [['s', 'int'], ['d', 'int']], ['bool'], [
  run('enTick'),
  let_('op', T(v('s'))),
  op(REC_S_LIT, [ret(call('enLit', S1))]),
  op(REC_S_COMP, [ret(call('enComp', S1))]),
  op(REC_S_TOK, [ret(call('enTok', S1))]),
  op(REC_S_TPLTOK, [ret(or(call('enTok', S1), call('enTpl', S2)))]),
  op(REC_S_RULE, [ret(call('riRule', S1, v('d')))]),
  op(REC_S_RULEBP, [
    if_(le0('d'), [ret(call('enBp', S1, S2))]),
    ret(call('riBp', S1, T(add(n(2), S1)), S2, sub(v('d'), n(1)))),
  ]),
  // A repetition stops at a body that matches nothing (an interpreted loop drops a zero-width
  // iteration: termination T1); the native loop never meets one on input it accepts.
  op(REC_S_STAR, [
    while_(tru, [
      guarded([brk]),
      let_('p0', call('enPos')),
      ...attempt('ok', call('riStep', S2R, v('d'))),
      if_(or(not(v('ok')), eq(call('enPos'), v('p0'))), [brk]),
    ]),
    ret(tru),
  ]),
  op(REC_S_OPT, [guarded([ret(tru)]), ...attempt('ok', call('riList', S2R, v('d'))), ret(tru)]),
  // elem (delim elem)*: a trailing delimiter stays matched.
  op(REC_S_SEP, [
    guarded([ret(tru)]),
    let_('el', S2R),
    ...attempt('ok', call('riStep', v('el'), v('d')), [ret(tru)]),
    while_(call('enLit', S3), [
      let_('k2', call('enMark')),
      if_(not(call('riStep', v('el'), v('d'))), [run('enReset', v('k2')), run('enUnmark', v('k2')), brk]),
      run('enUnmark', v('k2')),
    ]),
    ret(tru),
  ]),
  op(REC_S_ALTLIT, [
    let_('i', n(0)),
    while_(lt(v('i'), S1), [if_(call('enLit', T(add(add(v('s'), n(2)), v('i')))), [ret(tru)]), inc('i')]),
    ret(fls),
  ]),
  // An ordered choice: the first branch its FIRST signature admits (-1: any) that matches; a
  // predictive one only the first it admits.
  op(REC_S_ALT, [
    let_('i', n(0)),
    while_(lt(v('i'), S2), [
      let_('a', add(add(v('s'), n(3)), add(v('i'), v('i')))),
      let_('f', atR(v('a'), 0)),
      if_(or(lt(v('f'), n(0)), call('riSig', v('f'))), [
        ...attempt('ok', call('riList', atR(v('a'), 1), v('d')), [], [ret(tru)]),
        if_(eq(S1, n(1)), [ret(fls)]),
      ]),
      inc('i'),
    ]),
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
  ret(call('riBp', v('r'), v('rec'), v('bp'), sub(v('d'), n(1)))),
]);
// The entry of an operator table (tables[i] = [n (lid field*)*], `w` ints each) for lid, or -1.
const riOp = method('riOp', [['tb', 'int'], ['w', 'int'], ['lid', 'int']], ['int'], [
  let_('i', n(0)),
  let_('x', add(v('tb'), n(1))),
  while_(lt(v('i'), T(v('tb'))), [if_(eq(T(v('x')), v('lid')), [ret(v('x'))]), inc('x', v('w')), inc('i')]),
  ret(n(-1)),
]);
// A NUD arm that matched (ok) from `save`, its children from height c (mark k): past the best so
// far it wins, with the node's form, tail and capped flag.
const nudCand = (ok: Expr, form: Expr, tail: Expr, capped: Expr): Stmt[] => [
  let_('c', call('enSh')),
  let_('k', call('enMark')),
  let_('ok', ok, 'bool'),
  if_(and(v('ok'), gt(call('enPos'), v('bestPos'))), [
    run('enUnmark', v('k')),
    run('enWin', v('r'), v('c'), v('save'), v('sb')),
    set('bestPos', call('enPos')), set('boff', call('enFinOff')), set('won', tru),
    set('bf', form), set('bt', tail), set('bc', capped),
  ], [run('enReset', v('k')), run('enUnmark', v('k'))]),
  run('enBack', v('save')),
];
// The NUD: every arm a candidate of a longest match. It returns whether one matched and the
// offset of its node, and leaves the node's capped flag, form and tail in the engine.
const riNud = method('riNud', [['r', 'int'], ['rec', 'int'], ['minBp', 'int'], ['d', 'int']], ['bool', 'int'], [
  run('enSetSt', n(ST_CAPPED), n(0)),
  let_('kid', call('enPeekKid')),
  if_(lt(v('kid'), n(0)), [ret(fls, n(0))]),
  let_('lid', call('enPeekLid')),
  let_('save', call('enPos')), let_('sb', call('enSh')), let_('bestPos', v('save')), let_('won', fls, 'bool'),
  let_('bf', n(0)), let_('bt', n(0)), let_('bc', n(0)), let_('boff', n(0)),
  let_('x', add(sec(P_ARMS), n(1))),
  let_('i', n(0)),
  while_(lt(v('i'), T(sec(P_ARMS))), [
    let_('tag', T(v('x'))),
    if_(eq(v('tag'), n(REC_N_TOK)), [
      // A token arm's leaf is offered only when its one-token match would win.
      if_(and(eq(v('kid'), at(v('x'), 1)), gt(add(v('save'), n(1)), v('bestPos'))), [
        let_('c', call('enSh')),
        run('enLeafKid'),
        run('enWin', v('r'), v('c'), v('save'), v('sb')),
        set('bestPos', call('enPos')), set('boff', call('enFinOff')), set('won', tru),
        set('bf', n(0)), set('bt', n(0)), set('bc', n(0)),
        run('enBack', v('save')),
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
          if_(and(v('ok'), gt(call('enPos'), v('bestPos'))), [
            run('enUnmark', v('k')),
            run('enWin', v('r'), v('c'), v('save'), v('sb')),
            set('bestPos', call('enPos')), set('boff', call('enFinOff')), set('won', tru),
            set('bf', at(v('p'), 3)), set('bt', n(1)), set('bc', n(0)),
          ], [run('enReset', v('k')), run('enUnmark', v('k'))]),
          run('enBack', v('save')),
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
  // A sub-parse may leave the capped flag set: only a capped arm that won makes this node capped.
  run('enSetSt', n(ST_CAPPED), v('bc')), run('enSetSt', n(ST_FORM), v('bf')), run('enSetSt', n(ST_TAIL), v('bt')),
  run('enSetPos', v('bestPos')),
  ret(v('won'), v('boff')),
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
const riBp = method('riBp', [['r', 'int'], ['rec', 'int'], ['minBp', 'int'], ['d', 'int']], ['bool'], [
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
      ...finLed(n(1)), set('tc', n(1)),
    ]),
  ]),
  run('enSetSt', n(ST_FORM), v('fm')),
  ret(tru),
]);

export function recoveryFamilyFns(): Fn[] {
  return [rejectDiag, diagMessage, diagRelated, riRef, riSig, riIn, riGuard, riRule, riRd, riList, riStep, riOperand, riOp, riNud, riBp, ...ENGINE_EXTERNS];
}

// The family for a grammar: the functions, the record Diag and the plan's int table `rt`.
// `methods`: print only the engine methods (true), only the free functions (false), or all.
export function emitRecoveryFamily(L: Lowering, rt: number[], methods?: boolean): string {
  return printFns(L, recoveryFamilyFns(), [], [DIAG], [{ name: 'rt', data: rt }], methods === undefined ? undefined : (f) => (f.method === true) === methods, methods !== true);
}
