// Rebind family: the mixfix operand re-bind (parser-ir.ts PrattRule.ledRebind), authored once
// and printed for every engine form of every target (the native rule functions and the recovery
// interpreter alike).
//
// A led `<L1> $ <L2> …` whose greedy operand took the L2 it needs fails; the re-bind then retries
// the operand CAPPED at each depth-0 L2 token inside what the greedy operand took (the brackets
// `( [ {` against `) ] }` counted), in order, and takes the first where the operand ends exactly at
// that token and L2 and the rest match (the interpreter's matchMixfixLed, interpreter.ts). The cap
// is the token stream ending there: a capped parse is a parse of a shorter input. It runs only on
// the led's failure path, and undoes itself when it fails.
//
// Boundary: the led's steps are the engine's (`rbStep`: the native form's lowered step, or the
// interpreter's table walk); the marks, the cap and the token read are each engine form's externs.

import { type Expr, type Fn, type Lowering, type Stmt, printFns } from './algo-ir.ts';
import { rebindBrackets, type LexIdPlan } from './parser-ir.ts';

type Ty0 = 'int' | 'bool';
const v = (name: string): Expr => ({ k: 'var', name });
const n = (k: number): Expr => ({ k: 'int', v: k });
const bin = (op: (Expr & { k: 'bin' })['op'], a: Expr, b: Expr): Expr => ({ k: 'bin', op, a, b });
const call = (fn: string, ...args: Expr[]): Expr & { k: 'call' } => ({ k: 'call', fn, args });
const run = (fn: string, ...args: Expr[]): Stmt => ({ k: 'run', call: call(fn, ...args) });
const let_ = (name: string, init: Expr, ty: Ty0 = 'int'): Stmt => ({ k: 'let', name, ty, init });
const set = (name: string, e: Expr): Stmt => ({ k: 'set', name, e });
const if_ = (c: Expr, then: Stmt[], els?: Stmt[]): Stmt => (els ? { k: 'if', c, then, else: els } : { k: 'if', c, then });
const ret = (e: Expr): Stmt => ({ k: 'return', es: [e] });
const tru: Expr = { k: 'bool', v: true }, fls: Expr = { k: 'bool', v: false };
const ext = (name: string, params: [string, Ty0][], r: Ty0[] = []): Fn => ({ name, doc: '', params: params.map(([pn, ty]) => ({ name: pn, ty })), ret: r, body: [], extern: true, method: true });

// Each engine form's part: a mark of the position, the children list and the builder, as four
// ints (what the form's mark holds), and the undo to one; the position; the literal id of token i.
// Each engine's: step k of led `led` (0 the connector, 1 the operand, 2 L2, 3 the rest; `d` is the
// interpreter's, a native form ignores it), and the operand step under a cap at token i (the
// token stream cut to its first i tokens for the call, then put back).
export const REBIND_EXTERNS: Fn[] = [
  ext('rbMark', [], ['int', 'int', 'int', 'int']), ext('rbReset', [['p', 'int'], ['s', 'int'], ['c', 'int'], ['e', 'int']]),
  ext('rbPos', [], ['int']), ext('rbTokLid', [['i', 'int']], ['int']),
];
const stepExt = (name: string): Fn => ext(name, [['led', 'int'], ['k', 'int'], ['d', 'int']], ['bool']);
const cappedExt = (name: string): Fn => ext(name, [['led', 'int'], ['i', 'int'], ['d', 'int']], ['bool']);

// The bracket a literal id is: 1 an opener, -1 a closer, 0 neither (rebindBrackets).
function rbBracketFn(ids: LexIdPlan): Fn {
  const { opens, closes } = rebindBrackets(ids);
  const any = (xs: number[]): Expr => (xs.length ? xs.map((x) => bin('eq', v('l'), n(x))).reduce((a, b) => bin('or', a, b)) : fls);
  return {
    name: 'rbBracket', doc: '', params: [{ name: 'l', ty: 'int' }], ret: ['int'],
    body: [if_(any(opens), [ret(n(1))]), if_(any(closes), [ret(n(-1))]), ret(n(0))],
  };
}

// The re-bind of led `led` whose L2 is literal `sep`, its steps taken by `step` (an engine method
// (led, k, d) -> bool) and its capped operand by `capped` ((led, i, d) -> bool): whether it matched
// (the led's steps then hold their match), else nothing changed. `held`: one more engine length
// the interpreter's marks hold (its repair memory, recovery-family.ts: a repair made in an undone
// try is undone with it), read by `held` and cut back by `cut`.
export function rbScanFn(name: string, step: string, capped: string, held?: { len: string; cut: string }): Fn {
  const mark = (x: string): Stmt[] => [{ k: 'letCall', names: [0, 1, 2, 3].map((j) => `${x}${j}`), call: call('rbMark') }, ...(held ? [let_(`${x}h`, call(held.len))] : [])];
  const reset = (x: string): Stmt[] => [run('rbReset', ...[0, 1, 2, 3].map((j) => v(`${x}${j}`))), ...(held ? [run(held.cut, v(`${x}h`))] : [])];
  const st = (k: number): Expr => call(step, v('led'), n(k), v('d'));
  return {
    name, doc: '', method: true, ret: ['bool'],
    params: [{ name: 'led', ty: 'int' }, { name: 'sep', ty: 'int' }, { name: 'd', ty: 'int' }],
    body: [
      ...mark('m'),
      if_(st(0), [
        ...mark('a'),
        let_('i', call('rbPos')),
        if_(bin('and', st(1), { k: 'not', e: st(2) }), [
          let_('g', call('rbPos')),
          let_('depth', n(0)),
          { k: 'while', c: bin('lt', v('i'), v('g')), body: [
            let_('l', call('rbTokLid', v('i'))),
            let_('br', call('rbBracket', v('l'))),
            if_(bin('ne', v('br'), n(0)), [set('depth', bin('add', v('depth'), v('br')))], [
              if_(bin('and', bin('eq', v('depth'), n(0)), bin('eq', v('l'), v('sep'))), [
                ...reset('a'),
                if_(bin('and', bin('and', call(capped, v('led'), v('i'), v('d')), bin('eq', call('rbPos'), v('i'))), bin('and', st(2), st(3))), [ret(tru)]),
              ]),
            ]),
            set('i', bin('add', v('i'), n(1))),
          ] },
        ]),
      ]),
      ...reset('m'),
      ret(fls),
    ],
  };
}

// The native forms' re-bind and the recovery interpreter's (recovery-family.ts): one body.
export const RB_SCAN: Fn = rbScanFn('rbScan', 'rbStep', 'rbCapped');
export const RI_RB_SCAN: Fn = rbScanFn('riRbScan', 'riRbStep', 'riRbCapped', { len: 'enRmLen', cut: 'enRmCut' });
export const RB_EXTERNS_NATIVE: Fn[] = [...REBIND_EXTERNS, stepExt('rbStep'), cappedExt('rbCapped')];
export const RB_EXTERNS_INTERP: Fn[] = [cappedExt('riRbCapped')];
export function rebindFamilyFns(ids: LexIdPlan): Fn[] {
  return [rbBracketFn(ids), RB_SCAN, ...RB_EXTERNS_NATIVE];
}
export { rbBracketFn };
// The family for one engine form: `rbBracket` (a free function, printed once per module: `free`)
// and the method `rbScan`.
export function emitRebindFamily(L: Lowering, ids: LexIdPlan, part: 'free' | 'methods'): string {
  return printFns(L, rebindFamilyFns(ids), [], [], [], (f) => (f.method === true) === (part === 'methods'), part === 'free');
}
