// Reparse family: `reparseFrom(p0, stop, k)`, the one primitive that parses a stretch of tokens
// again by a routine of the engine's and puts everything back, authored once and printed for
// every target (the demand form of a declared target context, assign-targets.ts planDemand:
// a container on the left of a demand operator parsed again by its accumulating twin).
//
// From the mark p0 (a token index), routine k (`rpTwin`: the engine's switch) runs; it holds when
// the routine matched and ended at `stop`. The position, the scratch list and the builder are put
// back as they were, so it leaves only what the routine wrote outside them (a twin: its form).
//
// The bound: a re-parse nested in another (a container child of a container) starts strictly
// after the enclosing one's start, so the chain of nested re-parses over one operand is at most
// its token count long and each token is parsed again at most once per enclosing container (the
// nesting depth). `rpCount(over)` counts every re-parse and those that break it; the gates assert
// none does (demandRestarts in the TS target).

import { type Expr, type Fn, type Lowering, type Stmt, printFns } from './algo-ir.ts';

type Ty0 = 'int' | 'bool';
const v = (name: string): Expr => ({ k: 'var', name });
const bin = (op: (Expr & { k: 'bin' })['op'], a: Expr, b: Expr): Expr => ({ k: 'bin', op, a, b });
const call = (fn: string, ...args: Expr[]): Expr & { k: 'call' } => ({ k: 'call', fn, args });
const run = (fn: string, ...args: Expr[]): Stmt => ({ k: 'run', call: call(fn, ...args) });
const let_ = (name: string, init: Expr, ty: Ty0 = 'int'): Stmt => ({ k: 'let', name, ty, init });
const ext = (name: string, params: [string, Ty0][], r: Ty0[] = []): Fn => ({ name, doc: '', params: params.map(([pn, ty]) => ({ name: pn, ty })), ret: r, body: [], extern: true, method: true });

// Each engine form's part: a mark (the position, the scratch list's length and the builder's
// checkpoint, as four ints) and the undo to one; the position; routine k; the start of the
// re-parse in progress (-1: none) and its setter; the counter.
export const REPARSE_EXTERNS: Fn[] = [
  ext('rpMark', [], ['int', 'int', 'int', 'int']), ext('rpReset', [['p', 'int'], ['s', 'int'], ['c', 'int'], ['e', 'int']]),
  ext('rpPos', [], ['int']), ext('rpTwin', [['k', 'int']], ['bool']),
  ext('rpAt', [], ['int']), ext('rpSetAt', [['p', 'int']]), ext('rpCount', [['over', 'bool']]),
];

export const REPARSE_FROM: Fn = {
  name: 'reparseFrom', doc: '', method: true, ret: ['bool'],
  params: [{ name: 'p0', ty: 'int' }, { name: 'stop', ty: 'int' }, { name: 'k', ty: 'int' }],
  body: [
    { k: 'letCall', names: ['m0', 'm1', 'm2', 'm3'], call: call('rpMark') },
    let_('at', call('rpAt')),
    run('rpCount', bin('le', v('p0'), v('at'))),
    run('rpSetAt', v('p0')),
    run('rpReset', v('p0'), v('m1'), v('m2'), v('m3')),
    let_('ok', bin('and', call('rpTwin', v('k')), bin('eq', call('rpPos'), v('stop'))), 'bool'),
    run('rpSetAt', v('at')),
    run('rpReset', v('m0'), v('m1'), v('m2'), v('m3')),
    { k: 'return', es: [v('ok')] },
  ],
};

export function emitReparseFamily(L: Lowering): string {
  return printFns(L, [REPARSE_FROM, ...REPARSE_EXTERNS], [], [], [], (f) => f.method === true, false);
}
