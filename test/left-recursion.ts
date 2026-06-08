// Regression: left recursion is defined by the LEFT-CORNER relation, not the syntactic
// `items[0] === self` shape. A rule is left-recursive iff it can derive ITSELF as its
// leftmost symbol without consuming input. DIRECT recursion (A → A …) whose self-alt the
// transform peels is handleable and parses; INDIRECT cycles (A → B → A) and recursion
// HIDDEN behind a nullable prefix (A → opt(x) A …) cannot be peeled, so they are rejected
// at BUILD time with a named-cycle diagnostic — NOT left to overflow the stack at parse
// time, which is what the old syntactic check allowed (it only saw the length-1,
// non-nullable case).
import { token, rule, defineGrammar, range, opt } from '../src/api.ts';
import { createParser } from '../src/gen-parser.ts';

let ok = 0, fail = 0;
const check = (label: string, cond: boolean) => { cond ? ok++ : (fail++, console.log('  ✗', label)); };

// 'parsed' | 'rejected' (build-time Error) | 'overflow' (parse-time RangeError) | 'parse-error'.
function outcome(build: () => any, input: string): string {
  let parser: any;
  try { parser = createParser(build()); }
  catch (e: unknown) { return e instanceof RangeError ? 'overflow' : 'rejected'; }
  try { parser.parse(input); return 'parsed'; }
  catch (e: unknown) { return e instanceof RangeError ? 'overflow' : 'parse-error'; }
}

// DIRECT — A → A W | W. Left-corner self-cycle whose direct self-alt is peeled into an
// iterative loop ⇒ handleable ⇒ parses.
check('direct left recursion parses', outcome(() => {
  const W = token(range('a', 'z'), { identifier: true });
  const A: any = rule(($: any) => [[$, W], W]);
  return defineGrammar({ name: 'lr_direct', tokens: { W }, rules: { A }, entry: A });
}, 'ab') === 'parsed');

// INDIRECT — A → B | W ; B → A | W. The cycle A → B → A survives peeling (no direct
// self-alt to peel), so it is rejected at build time, not overflowed at parse time.
check('indirect left recursion rejected at build time', outcome(() => {
  const W = token(range('a', 'z'), { identifier: true });
  const A: any = rule(() => [B, W]);
  const B: any = rule(() => [A, W]);
  return defineGrammar({ name: 'lr_indirect', tokens: { W }, rules: { A, B }, entry: A });
}, 'a') === 'rejected');

// NULLABLE-HIDDEN — A → opt(D) A W | W. A references itself directly, but behind a
// nullable prefix, so its first item is not a bare self-ref. The left-corner relation
// still sees the cycle (the nullable element passes through) ⇒ rejected at build time.
check('nullable-hidden left recursion rejected at build time', outcome(() => {
  const W = token(range('a', 'z'), { identifier: true });
  const D = token(range('0', '9'));
  const A: any = rule(($: any) => [[opt(D), $, W], W]);
  return defineGrammar({ name: 'lr_hidden', tokens: { W, D }, rules: { A }, entry: A });
}, 'a') === 'rejected');

// The diagnostic names the offending rule and the left-corner cycle path.
let msg = '';
try {
  const W = token(range('a', 'z'), { identifier: true });
  const A: any = rule(() => [B, W]);
  const B: any = rule(() => [A, W]);
  createParser(defineGrammar({ name: 'lr_msg', tokens: { W }, rules: { A, B }, entry: A }));
} catch (e: unknown) { msg = e instanceof Error ? e.message : String(e); }
check('diagnostic names the rule and the left-corner cycle',
  /left recursion/i.test(msg) && msg.includes("'A'") && msg.includes('→'));

console.log(fail === 0 ? `\n${ok}/${ok} left-recursion checks pass` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
