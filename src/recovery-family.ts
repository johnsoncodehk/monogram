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

export function recoveryFamilyFns(): Fn[] {
  return [rejectDiag, diagMessage, diagRelated];
}

export function emitRecoveryFamily(L: Lowering): string {
  return printFns(L, recoveryFamilyFns(), [], [DIAG]);
}
