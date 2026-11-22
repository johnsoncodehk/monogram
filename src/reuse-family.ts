// Incremental reuse family: the Doc's top-level entry reuse, authored once and printed for each
// target through its `Lowering`. An edit keeps the old top-level entries before it (the prefix)
// and adopts, shifted, the old entries after it (the suffix) once the re-parse of the middle
// reaches one of them.
//
// Entries partition the token stream in order (`EntryMeta`: an entry's tokens [tokStart, tokEnd),
// the tokens its parse read, ext, and its text span). So tokStart ascends, and an old suffix entry
// can be adopted at a new position exactly when the new stream has as many tokens left as the old
// one had from the entry's start: `oldN - tokStart == newN - pos` (tokens left, read in place; no
// per-edit array, 25f7e51).
//
// Boundary: the parse of one entry, the shifting of adopted handles and the building of the new
// root are each target's engine and builder; this family decides which entries are kept, where
// the re-parse starts, and when an entry is adopted or none can be any more.

import type { ParserIR } from './emit-portable.ts';
import { type Expr, type Fn, type Lowering, type RecordDecl, type Stmt, printFns } from './algo-ir.ts';

export const ENTRY_META: RecordDecl = {
  name: 'EntryMeta',
  fields: ['tokStart', 'tokEnd', 'ext', 'off', 'end', 'kidStart', 'kidCount'].map((name) => ({ name, ty: 'pos' as const })),
};
const ENTRIES = 'recs_EntryMeta' as const;
// A segment of the root's kids (shape B: an entry may own several root kids).
export const SEG: RecordDecl = {
  name: 'Seg',
  fields: ['kidStart', 'kidCount', 'tokStart', 'tokEnd', 'ext'].map((name) => ({ name, ty: 'pos' as const })),
};
const SEGS = 'recs_Seg' as const;

const v = (name: string): Expr => ({ k: 'var', name });
const n = (k: number): Expr => ({ k: 'int', v: k });
const bin = (op: (Expr & { k: 'bin' })['op'], a: Expr, b: Expr): Expr => ({ k: 'bin', op, a, b });
const len = (e: Expr): Expr => ({ k: 'len', e });
const fld = (list: string, i: Expr, f: string): Expr => ({ k: 'field', e: { k: 'at', list: v(list), i }, f });
const ret = (...es: Expr[]): Stmt => ({ k: 'return', es });

// The entries kept before the edit, [0, prefixLen): those whose parse read only the unchanged
// prefix tokens (ext <= prefix); and where the suffix candidates start, [suffixStart, len): the
// trailing entries (after the prefix) that start in the unchanged suffix tokens.
const reuseBounds: Fn = {
  name: 'reuseBounds',
  doc: '',
  params: [{ name: 'entries', ty: ENTRIES }, { name: 'prefix', ty: 'idx' }, { name: 'oldN', ty: 'idx' }, { name: 'suffix', ty: 'idx' }],
  ret: ['idx', 'idx'],
  body: [
    { k: 'let', name: 'prefixLen', ty: 'idx', init: n(0) },
    { k: 'while', c: bin('and', bin('lt', v('prefixLen'), len(v('entries'))), bin('le', fld('entries', v('prefixLen'), 'ext'), v('prefix'))), body: [
      { k: 'set', name: 'prefixLen', e: bin('add', v('prefixLen'), n(1)) },
    ] },
    { k: 'let', name: 'suffixStart', ty: 'idx', init: len(v('entries')) },
    { k: 'while', c: bin('and', bin('gt', v('suffixStart'), v('prefixLen')), bin('ge', fld('entries', bin('sub', v('suffixStart'), n(1)), 'tokStart'), bin('sub', v('oldN'), v('suffix')))), body: [
      { k: 'set', name: 'suffixStart', e: bin('sub', v('suffixStart'), n(1)) },
    ] },
    ret(v('prefixLen'), v('suffixStart')),
  ],
};

// The hit test: with `left` tokens of the new stream left, the suffix candidate to adopt from (its
// index in suffixMeta), or -1. Only the unchanged suffix tokens can be adopted (left <= suffix);
// with no candidate, the end of the stream adopts nothing (index 0).
const reuseAdoptAt: Fn = {
  name: 'reuseAdoptAt',
  doc: '',
  params: [{ name: 'suffixMeta', ty: ENTRIES }, { name: 'oldN', ty: 'idx' }, { name: 'suffix', ty: 'idx' }, { name: 'left', ty: 'idx' }],
  ret: ['int'],
  body: [
    { k: 'if', c: bin('gt', v('left'), v('suffix')), then: [ret(n(-1))] },
    { k: 'if', c: bin('and', bin('eq', len(v('suffixMeta')), n(0)), bin('eq', v('left'), n(0))), then: [ret(n(0))] },
    { k: 'for', v: 'i', from: n(0), to: len(v('suffixMeta')), body: [
      { k: 'if', c: bin('eq', bin('sub', v('oldN'), fld('suffixMeta', v('i'), 'tokStart')), v('left')), then: [ret(v('i'))] },
    ] },
    ret(n(-1)),
  ],
};

// Whether no candidate can be adopted any more: fewer tokens are left than from the last
// candidate's start to the old end (candidates ascend, so the fewest of any), and the re-parse
// only consumes tokens.
const reuseGaveUp: Fn = {
  name: 'reuseGaveUp',
  doc: '',
  params: [{ name: 'suffixMeta', ty: ENTRIES }, { name: 'oldN', ty: 'idx' }, { name: 'left', ty: 'idx' }],
  ret: ['bool'],
  body: [
    { k: 'let', name: 'c', ty: 'idx', init: len(v('suffixMeta')) },
    ret(bin('and', bin('gt', v('c'), n(0)), bin('lt', v('left'), bin('sub', v('oldN'), fld('suffixMeta', bin('sub', v('c'), n(1)), 'tokStart'))))),
  ],
};

const ENTRY = 'rec_EntryMeta' as const;
const call = (fn: string, ...args: Expr[]): Expr & { k: 'call' } => ({ k: 'call', fn, args });
const recField = (e: Expr, f: string): Expr => ({ k: 'field', e, f });

// An adopted entry moved by the edit: its tokens by tokDelta, its text by byteDelta.
const shiftEntryMeta: Fn = {
  name: 'shiftEntryMeta',
  doc: '',
  params: [{ name: 'm', ty: ENTRY, ref: true }, { name: 'byteDelta', ty: 'int' }, { name: 'tokDelta', ty: 'int' }],
  ret: [],
  body: [
    ...['tokStart', 'tokEnd', 'ext'].map((f): Stmt => ({ k: 'setField', name: 'm', f, e: bin('add', recField(v('m'), f), v('tokDelta')) })),
    ...['off', 'end'].map((f): Stmt => ({ k: 'setField', name: 'm', f, e: bin('add', recField(v('m'), f), v('byteDelta')) })),
  ],
};

// The new root's entries (one per root child): the kept prefix, the re-parsed middle, and the
// adopted suffix from adoptFrom, moved by the edit.
const reuseEntries: Fn = {
  name: 'reuseEntries',
  doc: '',
  params: [{ name: 'prefixMeta', ty: ENTRIES }, { name: 'midMeta', ty: ENTRIES }, { name: 'suffixMeta', ty: ENTRIES }, { name: 'adoptFrom', ty: 'idx' }, { name: 'byteDelta', ty: 'int' }, { name: 'tokDelta', ty: 'int' }],
  ret: [ENTRIES],
  body: [
    { k: 'let', name: 'out', ty: ENTRIES, init: { k: 'newList', ty: ENTRIES, cap: bin('sub', bin('add', bin('add', len(v('prefixMeta')), len(v('midMeta'))), len(v('suffixMeta'))), v('adoptFrom')) } },
    { k: 'extend', list: 'out', from: v('prefixMeta') },
    { k: 'extend', list: 'out', from: v('midMeta') },
    { k: 'for', v: 'i', from: v('adoptFrom'), to: len(v('suffixMeta')), body: [
      { k: 'let', name: 'em', ty: ENTRY, init: { k: 'at', list: v('suffixMeta'), i: v('i') } },
      { k: 'run', call: call('shiftEntryMeta', v('em'), v('byteDelta'), v('tokDelta')) },
      { k: 'push', list: 'out', e: v('em') },
    ] },
    ret(v('out')),
  ],
};

// The root's span over its entries: the first one's start, the last one's end (all zero without
// entries).
const reuseSpan: Fn = {
  name: 'reuseSpan',
  doc: '',
  params: [{ name: 'entries', ty: ENTRIES }],
  ret: ['pos', 'pos', 'pos', 'pos'],
  body: [
    { k: 'let', name: 'c', ty: 'idx', init: len(v('entries')) },
    { k: 'if', c: bin('eq', v('c'), n(0)), then: [ret(n(0), n(0), n(0), n(0))] },
    ret(fld('entries', n(0), 'off'), fld('entries', bin('sub', v('c'), n(1)), 'end'), fld('entries', n(0), 'tokStart'), fld('entries', bin('sub', v('c'), n(1)), 'tokEnd')),
  ],
};

// Shape B's new segments and entries: the kept prefix, the re-parsed middle and the adopted suffix
// from adoptFrom (moved by the edit), each entry's kids placed after the ones before it.
const segPart = (segs: string, metas: string, from: Expr, shift: boolean): Stmt => ({
  k: 'for', v: 'i', from, to: len(v(segs)), body: [
    { k: 'let', name: 's', ty: 'rec_Seg', init: { k: 'at', list: v(segs), i: v('i') } },
    { k: 'let', name: 'em', ty: ENTRY, init: { k: 'at', list: v(metas), i: v('i') } },
    ...(shift ? [{ k: 'run', call: call('shiftEntryMeta', v('em'), v('byteDelta'), v('tokDelta')) } as Stmt] : []),
    { k: 'setField', name: 'em', f: 'kidStart', e: v('kOff') },
    { k: 'push', list: 'outSegs', e: { k: 'mkRec', rec: 'Seg', fields: {
      kidStart: v('kOff'), kidCount: recField(v('s'), 'kidCount'),
      ...Object.fromEntries(['tokStart', 'tokEnd', 'ext'].map((f) => [f, shift ? bin('add', recField(v('s'), f), v('tokDelta')) : recField(v('s'), f)])),
    } } },
    { k: 'push', list: 'outE', e: v('em') },
    { k: 'set', name: 'kOff', e: bin('add', v('kOff'), recField(v('s'), 'kidCount')) },
  ],
});
const reuseSegEntries: Fn = {
  name: 'reuseSegEntries',
  doc: '',
  params: [
    { name: 'prefixSegs', ty: SEGS }, { name: 'prefixMeta', ty: ENTRIES }, { name: 'midSegs', ty: SEGS }, { name: 'midMeta', ty: ENTRIES },
    { name: 'suffixSegs', ty: SEGS }, { name: 'suffixMeta', ty: ENTRIES }, { name: 'adoptFrom', ty: 'idx' }, { name: 'byteDelta', ty: 'int' }, { name: 'tokDelta', ty: 'int' },
  ],
  ret: [SEGS, ENTRIES],
  body: [
    { k: 'let', name: 'outSegs', ty: SEGS, init: { k: 'newList', ty: SEGS, cap: bin('sub', bin('add', bin('add', len(v('prefixSegs')), len(v('midSegs'))), len(v('suffixSegs'))), v('adoptFrom')) } },
    { k: 'let', name: 'outE', ty: ENTRIES, init: { k: 'newList', ty: ENTRIES, cap: bin('sub', bin('add', bin('add', len(v('prefixMeta')), len(v('midMeta'))), len(v('suffixMeta'))), v('adoptFrom')) } },
    { k: 'let', name: 'kOff', ty: 'idx', init: n(0) },
    segPart('prefixSegs', 'prefixMeta', n(0), false),
    segPart('midSegs', 'midMeta', n(0), false),
    segPart('suffixSegs', 'suffixMeta', v('adoptFrom'), true),
    ret(v('outSegs'), v('outE')),
  ],
};

// The edit's alignment of the old and new token streams: the tokens equal at the start (same kind,
// span, newline flag and text) and at the end (same kind, flag and text, the span moved by the
// text's length change), never overlapping.
const mi = (m: string, f: 'kid' | 'off' | 'end'): Expr => ({ k: 'metaInt', m: v(m), f });
const nl = (m: string): Expr => ({ k: 'metaFlag', m: v(m), f: 'nl' });
const text = (t: string, m: string): Expr => ({ k: 'metaText', text: v(t), m: v(m) });
const or = (...es: Expr[]): Expr => es.reduce((a, b) => bin('or', a, b));
const brk = (c: Expr): Stmt => ({ k: 'if', c, then: [{ k: 'break' }] });
const computeAlignCore: Fn = {
  name: 'computeAlignCore',
  doc: '',
  params: [{ name: 'oldText', ty: 'str' }, { name: 'oldToks', ty: 'metas' }, { name: 'newText', ty: 'str' }, { name: 'newToks', ty: 'metas' }],
  ret: ['idx', 'idx', 'idx', 'idx'],
  body: [
    { k: 'let', name: 'oldN', ty: 'idx', init: len(v('oldToks')) },
    { k: 'let', name: 'newN', ty: 'idx', init: len(v('newToks')) },
    { k: 'let', name: 'prefix', ty: 'idx', init: n(0) },
    { k: 'while', c: bin('and', bin('lt', v('prefix'), v('oldN')), bin('lt', v('prefix'), v('newN'))), body: [
      { k: 'let', name: 'o', ty: 'meta', init: { k: 'at', list: v('oldToks'), i: v('prefix') } },
      { k: 'let', name: 'm', ty: 'meta', init: { k: 'at', list: v('newToks'), i: v('prefix') } },
      brk(or(bin('ne', mi('o', 'kid'), mi('m', 'kid')), bin('ne', mi('o', 'off'), mi('m', 'off')), bin('ne', mi('o', 'end'), mi('m', 'end')), bin('ne', nl('o'), nl('m')))),
      brk(bin('ne', text('oldText', 'o'), text('newText', 'm'))),
      { k: 'set', name: 'prefix', e: bin('add', v('prefix'), n(1)) },
    ] },
    // The length change is signed: both lengths are taken as int before the subtraction.
    { k: 'let', name: 'newLen', ty: 'int', init: len(v('newText')) },
    { k: 'let', name: 'delta', ty: 'int', init: bin('sub', v('newLen'), len(v('oldText'))) },
    { k: 'let', name: 'minN', ty: 'idx', init: v('oldN') },
    { k: 'if', c: bin('lt', v('newN'), v('minN')), then: [{ k: 'set', name: 'minN', e: v('newN') }] },
    { k: 'let', name: 'suffix', ty: 'idx', init: n(0) },
    { k: 'while', c: bin('lt', bin('add', v('prefix'), v('suffix')), v('minN')), body: [
      { k: 'let', name: 'o', ty: 'meta', init: { k: 'at', list: v('oldToks'), i: bin('sub', bin('sub', v('oldN'), n(1)), v('suffix')) } },
      { k: 'let', name: 'm', ty: 'meta', init: { k: 'at', list: v('newToks'), i: bin('sub', bin('sub', v('newN'), n(1)), v('suffix')) } },
      brk(or(bin('ne', mi('o', 'kid'), mi('m', 'kid')), bin('ne', nl('o'), nl('m')))),
      brk(or(bin('ne', mi('m', 'off'), bin('add', mi('o', 'off'), v('delta'))), bin('ne', mi('m', 'end'), bin('add', mi('o', 'end'), v('delta'))))),
      brk(bin('ne', text('oldText', 'o'), text('newText', 'm'))),
      { k: 'set', name: 'suffix', e: bin('add', v('suffix'), n(1)) },
    ] },
    ret(v('oldN'), v('newN'), v('prefix'), v('suffix')),
  ],
};

export const REUSE_FNS: Fn[] = [reuseBounds, reuseAdoptAt, reuseGaveUp, shiftEntryMeta, reuseEntries, reuseSpan, reuseSegEntries];

// The functions a grammar's Doc uses: every Doc aligns the streams (computeAlignCore); the reuse
// functions only with a reuse plan, and the entry list of its shape (A: reuseEntries, B: reuseSegEntries).
export function reuseFamilyFns(ir: ParserIR): Fn[] {
  if (!ir.reuse) return [computeAlignCore];
  const unused = ir.reuse.kind === 'B' ? reuseEntries : reuseSegEntries;
  return [computeAlignCore, ...REUSE_FNS.filter((f) => f !== unused)];
}

export function emitReuseFamily(ir: ParserIR, lowering: Lowering): string {
  return printFns(lowering, reuseFamilyFns(ir), [], [ENTRY_META, SEG]);
}
