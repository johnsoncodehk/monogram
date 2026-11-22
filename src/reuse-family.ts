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
  doc: 'The kept prefix entries [0, prefixLen) and the suffix candidates [suffixStart, len(entries)).',
  params: [{ name: 'entries', ty: ENTRIES }, { name: 'prefix', ty: 'int' }, { name: 'oldN', ty: 'int' }, { name: 'suffix', ty: 'int' }],
  ret: ['int', 'int'],
  body: [
    { k: 'let', name: 'prefixLen', ty: 'int', init: n(0) },
    { k: 'while', c: bin('and', bin('lt', v('prefixLen'), len(v('entries'))), bin('le', fld('entries', v('prefixLen'), 'ext'), v('prefix'))), body: [
      { k: 'set', name: 'prefixLen', e: bin('add', v('prefixLen'), n(1)) },
    ] },
    { k: 'let', name: 'suffixStart', ty: 'int', init: len(v('entries')) },
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
  doc: 'The suffix candidate adopted with left tokens left (its index), or -1.',
  params: [{ name: 'suffixMeta', ty: ENTRIES }, { name: 'oldN', ty: 'int' }, { name: 'suffix', ty: 'int' }, { name: 'left', ty: 'int' }],
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
  doc: 'Whether, with left tokens left, no suffix candidate can be adopted any more.',
  params: [{ name: 'suffixMeta', ty: ENTRIES }, { name: 'oldN', ty: 'int' }, { name: 'left', ty: 'int' }],
  ret: ['bool'],
  body: [
    { k: 'let', name: 'c', ty: 'int', init: len(v('suffixMeta')) },
    ret(bin('and', bin('gt', v('c'), n(0)), bin('lt', v('left'), bin('sub', v('oldN'), fld('suffixMeta', bin('sub', v('c'), n(1)), 'tokStart'))))),
  ],
};

export const REUSE_FNS: Fn[] = [reuseBounds, reuseAdoptAt, reuseGaveUp];

// The family for a grammar whose entry rule records entries (`ir.reuse`); empty otherwise.
export function emitReuseFamily(ir: ParserIR, lowering: Lowering): string {
  if (!ir.reuse) return '';
  return printFns(lowering, REUSE_FNS, [], [ENTRY_META]);
}
