// Gate class of the portable targets (test/portable-harness.ts): EDITED ≡ FRESH. In every target,
// a Doc edited by exhaustive one-character edits (template holes, regex attempts, reads past a
// token's end, element regions) and by the edit sessions below gives a fresh parse's verdict and
// CST, its relexed stream aligns with the old one as the oracle lexer's does, and the fast
// (unvalidated) session reports what the validated one does.
import type { Grammar } from '../src/types.ts';
import { compileTokenizer, lexSpecOf } from '../src/emit-lexer.ts';
import { HOLE_EDIT_DOCS, LOOK_EDIT_DOCS } from './relex-edit-docs.ts';
import { CTX_DOCS, ctxEdits } from './context-cases.ts';
import { applyEdits, finish, gate, prepareAll, selectedCases, type Align, type EditBatch } from './portable-harness.ts';
import { QUICK } from './check-targets.ts';
const QUICK_EDIT_STRIDE = 3;


type AlignMeta = { kind: string; off: number; end: number; nl: boolean };
// The oracle lexer is compiled once per grammar, and the oracle's alignment of an edit is computed
// once for all the runners that are compared with it (a lexer error is cached and thrown again).
const tokenizers = new WeakMap<Grammar, ReturnType<typeof compileTokenizer>>();
const oracleToks = (g: Grammar, src: string): AlignMeta[] => {
  let tokenize = tokenizers.get(g);
  if (!tokenize) tokenizers.set(g, (tokenize = compileTokenizer(lexSpecOf(g))));
  return tokenize(src).map((t) => ({ kind: t.type, off: t.offset, end: t.offset + t.text.length, nl: t.newlineBefore }));
};
const aligns = new WeakMap<Grammar, Map<string, { align: Align } | { error: unknown }>>();
const computeAlign = (oldText: string, oldToks: AlignMeta[], newText: string, newToks: AlignMeta[]): Align => {
  const oldN = oldToks.length, newN = newToks.length;
  let prefix = 0;
  while (prefix < oldN && prefix < newN) {
    const o = oldToks[prefix], n = newToks[prefix];
    if (o.kind !== n.kind || o.off !== n.off || o.end !== n.end || o.nl !== n.nl) break;
    if (oldText.slice(o.off, o.end) !== newText.slice(n.off, n.end)) break;
    prefix++;
  }
  const delta = newText.length - oldText.length;
  const minN = Math.min(oldN, newN);
  let suffix = 0;
  while (prefix + suffix < minN) {
    const o = oldToks[oldN - 1 - suffix], n = newToks[newN - 1 - suffix];
    if (o.kind !== n.kind || o.nl !== n.nl || n.off !== o.off + delta || n.end !== o.end + delta) break;
    if (oldText.slice(o.off, o.end) !== newText.slice(n.off, n.end)) break;
    suffix++;
  }
  return { oldN, newN, prefix, suffix };
};
const expectAlign = (g: Grammar, init: string, batches: EditBatch[]): Align => {
  let memo = aligns.get(g);
  if (!memo) aligns.set(g, (memo = new Map()));
  const key = JSON.stringify([init, batches]);
  let hit = memo.get(key);
  if (!hit) {
    try { hit = { align: computeExpectAlign(g, init, batches) }; } catch (error) { hit = { error }; }
    memo.set(key, hit);
  }
  if ('error' in hit) throw hit.error;
  return { ...hit.align };
};
const computeExpectAlign = (g: Grammar, init: string, batches: EditBatch[]): Align => {
  let text = init;
  for (let i = 0; i < batches.length - 1; i++) for (const [s, e, r] of batches[i]) text = text.slice(0, s) + r + text.slice(e);
  const oldText = text;
  const batch = batches[batches.length - 1];
  for (const [s, e, r] of batch) text = text.slice(0, s) + r + text.slice(e);
  return computeAlign(oldText, oracleToks(g, oldText), text, oracleToks(g, text));
};

type EditScenario = {
  init: string;
  batches: EditBatch[];
  large?: boolean;
  maxRelexed?: number;
  fullRelex?: boolean;
  /** Minimum reused top-level kids (tree reuse) — all targets. */
  minReused?: number;
  /** Exact reused count — all targets. */
  reused?: number;
  /** Reused must be strictly less than this (lookahead / ext gate) — all targets. */
  maxReused?: number;
  /** Long arena session: assert treeEq after every cumulative batch prefix. */
  longSession?: boolean;
};
const calcLargeInit = '1+2*3+'.repeat(199) + '1+2*3';
const calcReuseInit = Array.from({ length: 40 }, (_, i) => `let x${i}=${i};`).join('\n');
const calcReuseMid = calcReuseInit.indexOf('let x20=') + 'let x20='.length;
const calcReuseFirstEq = calcReuseInit.indexOf('=') + 1;
const calcReuseLastEq = calcReuseInit.lastIndexOf('=') + 1;
const calcReuseSemi = calcReuseInit.indexOf(';');
const calcLongInit = Array.from({ length: 80 }, (_, i) => `let y${i}=${i};`).join('\n');
const calcLongBatches: EditBatch[] = Array.from({ length: 24 }, (_, i) => {
  const needle = `let y${i}=`;
  const at = calcLongInit.indexOf(needle) + needle.length;
  return [[at, at + 1, String((i * 7 + 3) % 10)]] as EditBatch;
});
const envspecLargeInit = 'A=1\n'.repeat(300);
const envReuseInit = Array.from({ length: 40 }, (_, i) => `K${i}=${i}`).join('\n');
const envReuseMid = envReuseInit.indexOf('K20=') + 'K20='.length;
const envReuseFirstEq = envReuseInit.indexOf('=') + 1;
const envReuseLastEq = envReuseInit.lastIndexOf('=') + 1;
const envFlowInit = 'A=1\nB=fn(a,\nb)\nC=3';
const envFlowEdit = envFlowInit.indexOf('fn(a') + 'fn('.length; // 'a' inside hanging flow stmt
const envMultiBatches: EditBatch[] = [
  [[envReuseMid, envReuseMid + 1, '9']],
  [[envReuseInit.indexOf('K5=') + 'K5='.length, envReuseInit.indexOf('K5=') + 'K5='.length + 1, '7']],
  [[envReuseLastEq, envReuseLastEq + 1, '8']],
];
// Shape-B adopted entry ext must shift with tokDelta: insert-front (adopt suffix) then poke a later
// value whose align.prefix sits in the stale-ext..shifted-ext window — unshifted Ext over-reuses.
const envSegExtInit = Array.from({ length: 8 }, (_, i) => `K${i}=${i}`).join('\n');
const envSegExtIns = 'Z=9\n';
const envSegExtPoke = envSegExtInit.indexOf('K3=') + 'K3='.length + envSegExtIns.length;
const regexjsLargeInit = 'var r = /abc/g; a / b;\n'.repeat(60);
const regexjsAfterParen = 'if (a) /b/g; c / d / e;';
const tplLargeInit = ('`a${x}b`; f(1);\n').repeat(50);
const jsLargeInit = ('var r = /a/g; `t${x}u`; f(1);\n').repeat(40);
const jsLargeEdit = jsLargeInit.indexOf('f(1)', 600) + 2;
const jsLookaheadInit = 'let x = (a)\nfoo;\nbar;';
const jsLookaheadEdit = jsLookaheadInit.indexOf('\n') + 1; // first char of peeked-into second stmt
// Edits that move a body in and out of an async / generator function, and keystrokes inside and
// around such bodies (test/context-cases.ts): one session per document, the tree ≡ a fresh parse
// after every batch.
const CTX_EDITS: EditScenario[] = CTX_DOCS.map((init) => ({ init, batches: ctxEdits(init).map((e): EditBatch => [[e.start, e.end, e.text]]), longSession: true }));
// Documents for the exhaustive one-character edits (above the edit sessions): template holes, and
// a `/` decided by what follows it.
const HOLE_EDIT_GRAMMARS = new Set(['javascript', 'typescript']);
// Element regions share the frame stack: text, tags, holes, templates in holes, a type-parameter
// signature decided by lexing its group (an edit can flip it), an attribute string, `</*` outside
// elements, code children with directives and a dynamic tag (as test/incremental-grammars.ts).
// the text dialect's (test/incremental-grammars.ts TEXT_INS)
const TEXT_INS = ['{', '}', '<', '>', '/', ';', 'x', ' ', '\n', '9', '_', '.'];
const FRAME_INS = ['`', '$', '{', '}', '(', ')', '<', '>', '/', ':', ',', '=', 'x', ' ', '\n', '"', "'", '\\'];
// A document is its text, or its text with the insertions it is edited with (FRAME_INS otherwise).
const FRAME_EDIT_DOCS: Record<string, (string | { doc: string; ins: string[] })[]> = {
  typescriptreact: [
    "let a = <p>It's {x} 50%</p>;\nlet b = 1;",
    'f(<a b={c > d}><i/>t</a>, `x${<b>y</b>}`);',
    'type F = <T>(x: T) => T;\nlet g = <T,>(y: T) => <q>{y}</q>;',
    'let h = <T>(x: T) => x; z = 1;',
    // a head veto decided by the characters after its tagOpen: an edit there can make it an element
    'let a = <T,>x</T>;\nlet b = <T extends U>y</T>;',
    'let m = new Map</* c */string, X>();',
    'let a = <a b="\\" c=\'d\ne\'>t</a>;\nlet z = "q";',
  ],
  javascriptreact: ['let s = `a${b}c${`${d}`}`;\nx = 1;', "let a = <><p>It's</p>{`${<b/>}`}</>;\nx</*c*/y;", 'x = <a/> / 2; y = <b c={1}>t</b>;'],
  // an edit inside a failed attribute string's read, past the element's end (`{x}` → `{x'}`),
  // makes it a string
  // and a token at depth 0 right after the read's end (`ab`, past the line the failed attempt read):
  // an edit right after it (`ab c` → `abc`) must not keep it as the restart anchor
  tagtokdialect: ["<a k=n'/> {w} {x}\n<b m='n'>{y}</b>", "<a k=n'/>\nab c"],
  elementdialect: [
    'component C(a) {\n  <a k="v">@if (a) { <b/> } @else { "e" } {a}</a> "z" <c/>\n}',
    'component D() { <a><b>{1}</b><{t} id="d">"s"</{t}></a> }\ncomponent E() { "q" }',
    // a raw-text element: one body token up to its close tag; edits that break or make the close tag, an empty body
    'component S() { <a><style k="v">.a { b: "c" } <i></style>"t"</a> <style></style> }',
  ],
  // a tag start made or broken (`<` before a blank, a digit, `<`, a letter, `{`), a comparison
  // next to an element, a `<style>` raw or not by the `{` after its open tag (as the
  // interpreter's test/incremental-grammars.ts)
  'textdialect-tagstart': [
    { doc: 'component C(a) {\n  <p k="v">1 < 2 {a} <b/>x<9 <></></p>;\n  const z = a <b;\n  return <{a}>y</{a}>;\n}', ins: TEXT_INS },
    { doc: 'component S() { <style>{a}</style>; <style> .x{}</style>; <script>a<b</script> }', ins: TEXT_INS },
  ],
  // comments in text: edits that make or break `/*`, `*/`, `//` and the blank before it; an
  // unterminated `/*` in text reads to the end of the file, past the element
  'textdialect-text': [
    { doc: 'component C(a) {\n  <p>hi // n\n a/* c */b {a}// m\n</p>;\n  const z = 1; /* k */\n}', ins: [...TEXT_INS, '*'] },
    { doc: 'component C() { <p>q /*</p>; const z = 1; }', ins: ['*/', '*', '/', ' ', 'x'] },
    // the same at a run's start: the text token's failed attempt there is the read's only record
    { doc: 'component C() { <p>/*</p>; const z = 1; }', ins: ['*/', '*', '/', ' ', 'x'] },
    { doc: 'component C(a) {\n  <p k="v">1 < 2 {a} <b/>x<9 <></></p>;\n  const z = a <b;\n  return <{a}>y</{a}>;\n}', ins: TEXT_INS },
  ],
  // directives: edits that make and break an opener (`@if (` / `@iffy`), a head's parens and braces,
  // a body's closer, a continuation; and an opener / a continuation made by closing a comment
  // after the element (their tests read the comment to the end of the file)
  'textdialect-dir': [
    // a read through a line comment that ENDS (no failed attempt to record), past the element's
    // close: only the opener's / continuation's own read (its far end) records it
    { doc: 'component C(a) { <p>@if // x</p>\n; const z = 1; }', ins: ['(', '(a) {y}</p>', ' '] },
    { doc: 'component C(a) { <p>@if (a) {y} @else // x</p>\n; const z = 1; }', ins: ['{', '{n}</p>', ' '] },
    { doc: 'component C(a) { <p>@if /* (a) {y}</p>; const z = 1; }', ins: ['*/ (a) {y}</p>; ', '*/'] },
    { doc: 'component C(a) { <p>@if (a) {y} @else /* {n}</p>; const z = 1; }', ins: ['*/ {n}</p>; ', '*/'] },
  ],
  textdialect: [
    { doc: 'component C(a) {\n  <p>x @if (a) { y <b/> } @else if ({a}.a) {m} @else { n } z@for await (i of a) {{i}} @empty {e}</p>;\n}', ins: ['{', '}', '<', '/', ';', 'x', ' ', '\n', '@', '(', ')', 'e', 'f'] },
    { doc: 'component C(a) { <p>@if /* (a) {y}</p>; const z = 1; }', ins: ['*/ (a) {y}</p>; ', '*/'] },
    { doc: 'component C(a) { <p>@if (a) {y} @else /* {n}</p>; const z = 1; }', ins: ['*/ {n}</p>; ', '*/'] },
    { doc: 'component C(a) {\n  <p>hi // n\n a/* c */b {a}// m\n</p>;\n  const z = 1; /* k */\n}', ins: [...TEXT_INS, '*'] },
    { doc: 'component S() { <style>{a}</style>; <style> .x{}</style>; <script>a<b</script> }', ins: TEXT_INS },
  ],
};
// Edits whose relexed stream is known to differ from a fresh lex, each with its cause; the gate
// fails when one passes.
const HOLE_EDIT_EXPECTED_FAIL: { doc: string; edit: [number, number, string]; reason: string }[] = [];
// Insert each of a few characters that open, close or end something at every offset, and delete
// every character.
function oneCharEdits(doc: string, ins: string[] = ['x', ' ', '}', '{', '`', '$', '/']): [number, number, string][] {
  const out: [number, number, string][] = [];
  for (let at = 0; at <= doc.length; at++) {
    for (const ch of ins) out.push([at, at, ch]);
    if (at < doc.length) out.push([at, at + 1, '']);
  }
  return out;
}
const EDIT_SCENARIOS: Record<string, EditScenario[]> = {
  calc: [
    { init: '1+2*3', batches: [[[3, 3, '4']]] },
    { init: '1+2*3', batches: [[[1, 3, '']]] },
    { init: '1+2*3', batches: [[[2, 5, '(7-8)']]] },
    { init: '1+2*3', batches: [[[0, 0, '9-']], [[7, 8, '']]] },
    { init: calcLargeInit, batches: [[[600, 601, '9']]], large: true, maxRelexed: 8 },
    { init: '1 2;', batches: [[[1, 2, '']]] },
    { init: calcLargeInit, batches: [[[calcLargeInit.length, calcLargeInit.length, '+4']]], maxRelexed: 5 },
    { init: calcLargeInit, batches: [[[0, 1, '9']]], maxRelexed: 8 },
    // S7b tree-reuse scenarios
    { init: calcReuseInit, batches: [[[calcReuseMid, calcReuseMid + 1, '9']]], minReused: 30 },
    { init: calcReuseInit, batches: [[[calcReuseFirstEq, calcReuseFirstEq + 1, '9']]], minReused: 1 },
    { init: calcReuseInit, batches: [[[calcReuseLastEq, calcReuseLastEq + 1, '9']]], minReused: 1 },
    { init: calcReuseInit, batches: [[[calcReuseSemi - 1, calcReuseSemi + 1, '9;']]], minReused: 1 },
    { init: calcReuseInit, batches: [[[calcReuseMid, calcReuseMid + 1, '9']], [[calcReuseMid, calcReuseMid + 1, '8']]], minReused: 30 },
    // Boundary-hit must be exact (===): merging b;c via `;`→`+` lands on `d`; a `>=` mutant would adopt too early.
    { init: 'a;\nb;\nc;\nd;', batches: [[[4, 5, '+']]] },
    // Mid overshoot past suffix candidates → tryReuse fails, full-parse fallback (reused:0) still ≡ fresh.
    { init: 'a;\nb;\nc;\nd;', batches: [[[7, 8, '+']]], reused: 0 },
    // S7c long arena session: ≥20 continuous edits; each cumulative prefix treeEq + final ≡ fresh.
    { init: calcLongInit, batches: calcLongBatches, longSession: true, minReused: 1 },
    // Reject-then-edit: batch 1 breaks the doc; batch 2 must not resurrect a partial old
    // tree via reuse (a Go parse wrapper without the full-consumption guard did exactly that).
    { init: 'let a = 1;\nlet b = 2;\nlet c = 3;', batches: [[[19, 20, '']], [[29, 30, '4']]], reused: 0 },
    // Reject-then-repair: same setup, batch 2 restores validity; must parse fresh (reused:0) ≡ fresh.
    { init: 'let a = 1;\nlet b = 2;\nlet c = 3;', batches: [[[19, 20, '']], [[19, 19, '2']]], reused: 0 },
    // Relex across the edit merges tokens (`12`+`34` → `1234`): resync only after the merge.
    { init: '12+34+56', batches: [[[2, 3, '']]] },
  ],
  javascript: [
    { init: 'let a = 1;\nf(a);', batches: [[[8, 9, '42']]] },
    { init: 'let a = 1;\nf(a);', batches: [[[11, 16, '']]] },
    { init: 'let a = 1;\nf(a);', batches: [[[4, 5, 'b'], [12, 13, 'b']]] },
    { init: 'let a = 1;\nf(a);', batches: [[[16, 16, '\ng(b);']], [[0, 4, 'var']]] },
    { init: 'let a = 1;\nf(a);\n'.repeat(80), batches: [[[688, 689, '9']]], large: true, maxRelexed: 15 },
    { init: 'var q = `x${a/b}y`;', batches: [[[12, 13, 'c']]] },
    // predecessor peeked into second stmt (ext > tokEnd); editing that region must not keep stmt0
    { init: jsLookaheadInit, batches: [[[jsLookaheadEdit, jsLookaheadEdit + 1, '+']]], maxReused: 1 },
    // Same-text token re-entering at template depth 1 must not resync (see templatejs).
    { init: 'a = {b} // `\n;', batches: [[[4, 5, '`${']]] },
    // Edit inside a hole: regex/division state and template depth both resume from the anchor.
    { init: 'a; `b${x}c`; d / e / f;', batches: [[[7, 8, 'g / h']]] },
    // Division → regex flip far from the edit; suffix adoption needs equal prev-token/paren state.
    { init: 'x = a / b / c; `t${y}u`;', batches: [[[4, 6, '']]] },
    { init: jsLargeInit, batches: [[[jsLargeEdit, jsLargeEdit + 1, '9']]], large: true, maxRelexed: 15 },
    ...CTX_EDITS,
  ],
  // The same edits of the [Await]/[Yield] context (test/context-cases.ts) on the typescript grammar.
  typescript: [
    ...CTX_EDITS,
  ],
  templatejs: [
    { init: '`a${x}b`;', batches: [[[4, 5, 'y']]] },
    { init: '`a${ {x} }b`;', batches: [[[6, 7, 'y']]] },
    { init: '`a${x}b`;', batches: [[[2, 4, '']]] },
    { init: '`a${x}b${y}c`;', batches: [[[6, 7, 'z']]] },
    { init: ('`a${x}b`; f(1);\n').repeat(50), batches: [[[600, 601, '9']]], large: true, maxRelexed: 15 },
    { init: '`a`; z; `b${x}c`;', batches: [[[5, 6, 'w']]] },
    // Removing a hole: the head/tail split of the first template disappears.
    { init: '`a${x}b` + c + `d${y}e`;', batches: [[[2, 6, '']]] },
    // Adding a hole next to an existing one: template depth after the edit differs from the old stream.
    { init: 'f(`a${x}b`, c);', batches: [[[8, 8, '${y}']]] },
    // `{` → `${`: the old `b` (td 0) reappears at the shifted offset inside a hole (td 1) with equal text —
    // adopting it would keep `}` as a brace; the comment-swallowed backtick keeps both texts lexable.
    { init: 'a = {b} // `\n;', batches: [[[4, 5, '`${']]] },
    // Edit inside the first hole: anchor search must back off to a td == 0 token, then resync.
    { init: tplLargeInit, batches: [[[3, 4, 'y']]], maxRelexed: 15 },
  ],
  envspec: [
    // Existing scenes — reused pinned from S8 measurement (was 0 under shape-A-only).
    { init: 'A=1\nB=2', batches: [[[2, 2, '3']]], minReused: 1 },
    { init: envspecLargeInit, batches: [[[600, 601, '9']]], large: true, maxRelexed: 10, minReused: 200 },
    // Comma→digit rejects the doc → full-parse fallback, reused:0.
    { init: 'A=fn(1,\n2)\nB=3', batches: [[[6, 7, '9']]], reused: 0 },
    { init: 'A=fn(1,\n2)\nB=3', batches: [[[4, 4, '(']]], reused: 0 },
    { init: 'A=1\n# note\nB=2', batches: [[[7, 7, 'x']]], minReused: 1 },
    { init: 'A=1\n\n\nB=2', batches: [[[4, 4, '\n']]], minReused: 1 },
    { init: 'A=1\nB=2\nC=3', batches: [[[3, 4, '\r\n\r\n']]] },
    { init: 'A=1\r\nB=2', batches: [[[4, 5, '']]] },
    { init: envspecLargeInit, batches: [[[envspecLargeInit.length, envspecLargeInit.length, 'Z=9']]], large: true, maxRelexed: 10, minReused: 200 },
    { init: 'A=fn(1,\n2)\nB=3', batches: [[[0, 0, 'X']], [[7, 7, '0']]], minReused: 1 },
    // S8 segment-reuse scenes
    { init: envReuseInit, batches: [[[envReuseMid, envReuseMid + 1, '9']]], minReused: 30 },
    { init: envReuseInit, batches: [[[envReuseFirstEq, envReuseFirstEq + 1, '9']]], minReused: 1 },
    { init: envReuseInit, batches: [[[envReuseLastEq, envReuseLastEq + 1, '9']]], minReused: 1 },
    { init: 'A=1\n\n\n\nB=2', batches: [[[4, 5, '']]], minReused: 1 }, // blank-line fold
    { init: 'A=1\n\nB=2', batches: [[[4, 4, '\n']]], minReused: 1 }, // blank-line expand
    { init: envFlowInit, batches: [[[envFlowEdit, envFlowEdit + 1, 'x']]], minReused: 2 }, // mid flow stmt; sides reused
    { init: envReuseInit, batches: envMultiBatches, longSession: true, minReused: 1 },
    // Go adopted entry Ext + tokDelta (pre-fix: reused 9 from stale keep-prefix watermarks).
    { init: envSegExtInit, batches: [[[0, 0, envSegExtIns]], [[envSegExtPoke, envSegExtPoke + 1, '9']]], reused: 8 },
    // Dropping a flow `(`: later tokens change flowDepth, so equal-text old tokens are not adopted.
    { init: 'A=fn(1,\n2)\nB=3\nC=4', batches: [[[4, 5, '']]] },
    // Opening a flow at the head swallows the next line break.
    { init: 'A=fn(1,\n2)\nB=3\nC=4', batches: [[[0, 0, 'X=g(\n']]] },
  ],
  envtpl: [
    { init: 'A=`x${B}y`\nC=2', batches: [[[6, 7, 'Q']]], fullRelex: true },
    { init: 'A=fn(`a`,\nb)\nB=`q${r}s`', batches: [[[4, 5, '']]], fullRelex: true },
    { init: 'A=1\nB=2', batches: [[[3, 3, '\nC=`z`']]], fullRelex: true },
  ],
  regexjs: [
    { init: 'var re = /[a-z]+/i; x / y;', batches: [[[11, 12, '0']]] },
    { init: 'x = a / b / c;', batches: [[[4, 6, '']]] },
    { init: 'if (x) /y/;', batches: [[[0, 2, 'f']]] },
    { init: regexjsLargeInit, batches: [[[600, 601, '9']]], large: true, maxRelexed: 15 },
    { init: 'f(x); a / b;', batches: [[[2, 2, '(']]] },
    { init: 'if (x) /y/;', batches: [[[11, 11, ' /z/;']]] },
    // `if (a)` → `f (a)`: the paren head flag flips, `/b/g` becomes division; adoption waits for equal state.
    { init: regexjsAfterParen, batches: [[[0, 2, 'f']]] },
    // `(a) / b` → `if (a) / b`: the reverse flip.
    { init: '(a) / b / c; d / e;', batches: [[[0, 0, 'if ']]] },
    // Edit at the head of a large doc: resume right after it.
    { init: regexjsLargeInit, batches: [[[4, 5, 's']]], maxRelexed: 15 },
  ],
};

for (const { c, grammar, runners, oracleOut } of await prepareAll(selectedCases().filter((c) => HOLE_EDIT_GRAMMARS.has(c.grammar) || FRAME_EDIT_DOCS[c.grammar] || EDIT_SCENARIOS[c.grammar]))) {
  for (const r of runners) {
    // Every one-character insertion and deletion at every offset of small documents with template
    // holes (nested, holding strings, braces, templates, comments): the edited Doc ≡ a fresh parse
    // of the edited text, on the verdict and the CST, and its own validation (stream and tree
    // against a fresh lex and parse) holds. Exhaustive, not random: a random edit rarely lands
    // inside a hole, where the relex window must not restart.
    if (HOLE_EDIT_GRAMMARS.has(c.grammar) || FRAME_EDIT_DOCS[c.grammar]) {
      const sessions = (HOLE_EDIT_GRAMMARS.has(c.grammar) ? [...HOLE_EDIT_DOCS.map((doc) => ({ doc, ins: undefined as string[] | undefined })), ...LOOK_EDIT_DOCS] : FRAME_EDIT_DOCS[c.grammar]!.map((d) => (typeof d === 'string' ? { doc: d, ins: FRAME_INS } : d)))
        .flatMap(({ doc: init, ins }) => oneCharEdits(init, ins).map((e) => ({ init, e, final: init.slice(0, e[0]) + e[2] + init.slice(e[1]) })))
        // the quick tier's sample (CHECK_QUICK=1): one edit in QUICK_EDIT_STRIDE of the list, which runs
        // offset by offset, so the sample moves across offsets and inserted characters alike
        .filter((_, i) => !QUICK || i % QUICK_EDIT_STRIDE === 0);
      const fresh = r.batch(sessions.map((x) => x.final));
      const edited = r.editBatch(sessions.map((x) => JSON.stringify({ init: x.init, batches: [[x.e]] })), false);
      const bad: string[] = [];
      let knownHit = 0;
      sessions.forEach((x, i) => {
        const a = edited[i]!, b = fresh[i]!;
        // The relexed stream itself (before the Doc parses it) ≡ a fresh lex: its alignment with
        // the old stream is the oracle's.
        let want: Align | null = null;
        try { want = expectAlign(grammar, x.init, [[x.e]]); } catch { /* the edited text does not lex */ }
        const why = a.ok !== b.ok ? `edited ${a.ok ? 'accepts' : 'rejects'}, fresh ${b.ok ? 'accepts' : 'rejects'}`
          : a.ok && a.cst !== b.cst ? 'CSTs differ'
          : a.align && (a.align.streamEq === false || a.align.treeEq === false) ? `validation streamEq=${a.align.streamEq} treeEq=${a.align.treeEq}`
          : want && (!a.align || a.align.oldN !== want.oldN || a.align.newN !== want.newN || a.align.prefix !== want.prefix || a.align.suffix !== want.suffix) ? `relexed stream ≠ a fresh lex (align ${JSON.stringify(a.align)}, oracle ${JSON.stringify(want)})` : '';
        const known = HOLE_EDIT_EXPECTED_FAIL.find((k) => k.doc === x.init && JSON.stringify(k.edit) === JSON.stringify(x.e));
        if (known) { if (!why) bad.push(`expected-fail passes now, remove it (${known.reason}): ${JSON.stringify(x.init)} edit ${JSON.stringify(x.e)}`); else knownHit++; return; }
        if (why) bad.push(`${why}: ${JSON.stringify(x.init)} edit ${JSON.stringify(x.e)}`);
      });
      console.log(`  ${c.grammar}/${r.label}: ${sessions.length - bad.length - knownHit}/${sessions.length} one-character edits in and around template holes, regex attempts and reads past a token's end ≡ fresh (${knownHit} expected-fail)`);
      for (const smp of bad.slice(0, 6)) console.log(`      ${smp}`);
      gate.failures += bad.length;
    }

    const editScenarios = EDIT_SCENARIOS[c.grammar];
    if (editScenarios) {
      let editOk = 0, alignOk = 0, fastOk = 0;
      const runEdit = (json: string) => r.edit(json, false);
      const runFast = (json: string) => r.edit(json, true);
      for (const sc of editScenarios) {
        const final = applyEdits(sc.init, sc.batches);
        const payload = JSON.stringify({ init: sc.init, batches: sc.batches });
        const a = runEdit(payload);
        const b = r.run(final);
        if (a.ok === b.ok && (!a.ok || a.cst === b.cst) && a.ok === oracleOut(final).ok) editOk++;
        else {
          gate.failures++;
          console.log(`  ${c.grammar}/${r.label}: edit-session mismatch (final=${JSON.stringify(final)}) A ok=${a.ok} B ok=${b.ok}`);
        }
        const want = expectAlign(grammar, sc.init, sc.batches);
        if (a.align && a.align.oldN === want.oldN && a.align.newN === want.newN && a.align.prefix === want.prefix && a.align.suffix === want.suffix) {
          alignOk++;
          if (sc.large && want.prefix + want.suffix < want.oldN - 8) {
            gate.failures++;
            console.log(`  ${c.grammar}/${r.label}: large-doc align too narrow prefix+suffix=${want.prefix + want.suffix} oldN=${want.oldN}`);
          }
          if (a.align.streamEq !== true) {
            gate.failures++;
            console.log(`  ${c.grammar}/${r.label}: streamEq want=true got=${JSON.stringify(a.align.streamEq)}`);
          }
          if (a.align.treeEq !== true) {
            gate.failures++;
            console.log(`  ${c.grammar}/${r.label}: treeEq want=true got=${JSON.stringify(a.align.treeEq)}`);
          }
          if (a.align.reused === undefined) {
            gate.failures++;
            console.log(`  ${c.grammar}/${r.label}: reused field missing got=${JSON.stringify(a.align)}`);
          }
          if (sc.reused !== undefined && a.align.reused !== sc.reused) {
            gate.failures++;
            console.log(`  ${c.grammar}/${r.label}: reused want=${sc.reused} got=${JSON.stringify(a.align.reused)}`);
          }
          if (sc.minReused !== undefined && (a.align.reused === undefined || a.align.reused < sc.minReused)) {
            gate.failures++;
            console.log(`  ${c.grammar}/${r.label}: reused want>=${sc.minReused} got=${JSON.stringify(a.align.reused)}`);
          }
          if (sc.maxReused !== undefined && (a.align.reused === undefined || a.align.reused > sc.maxReused)) {
            gate.failures++;
            console.log(`  ${c.grammar}/${r.label}: reused want<=${sc.maxReused} got=${JSON.stringify(a.align.reused)}`);
          }
          if (sc.longSession) {
            for (let bi = 1; bi < sc.batches.length; bi++) {
              const prefixPayload = JSON.stringify({ init: sc.init, batches: sc.batches.slice(0, bi) });
              const p = runEdit(prefixPayload);
              if (p.align?.treeEq !== true) {
                gate.failures++;
                console.log(`  ${c.grammar}/${r.label}: longSession batch ${bi} treeEq want=true got=${JSON.stringify(p.align?.treeEq)}`);
              }
            }
          }
          if (sc.maxRelexed !== undefined && (a.align.relexed === undefined || a.align.relexed > sc.maxRelexed)) {
            gate.failures++;
            console.log(`  ${c.grammar}/${r.label}: relexed want<=${sc.maxRelexed} got=${JSON.stringify(a.align.relexed)}`);
          }
          if (sc.fullRelex && a.align.relexed !== want.newN) {
            gate.failures++;
            console.log(`  ${c.grammar}/${r.label}: fullRelex want relexed=${want.newN} got=${JSON.stringify(a.align.relexed)}`);
          }
        } else {
          gate.failures++;
          console.log(`  ${c.grammar}/${r.label}: token-align mismatch want=${JSON.stringify(want)} got=${JSON.stringify(a.align)}`);
        }
        const f = runFast(payload);
        const sixEq = !!(a.align && f.align
          && a.align.oldN === f.align.oldN && a.align.newN === f.align.newN
          && a.align.prefix === f.align.prefix && a.align.suffix === f.align.suffix
          && a.align.relexed === f.align.relexed && a.align.reused === f.align.reused);
        const noValidateKeys = f.align !== undefined && !('streamEq' in f.align) && !('treeEq' in f.align);
        const outEq = a.ok === f.ok && (!a.ok || a.cst === f.cst);
        if (sixEq && noValidateKeys && outEq) fastOk++;
        else {
          gate.failures++;
          console.log(`  ${c.grammar}/${r.label}: fast≢validated sixEq=${sixEq} noValidateKeys=${noValidateKeys} outEq=${outEq} validated=${JSON.stringify(a.align)} fast=${JSON.stringify(f.align)}`);
        }
      }
      console.log(`  ${c.grammar}/${r.label}: ${editOk}/${editScenarios.length} edit-sessions ≡ fresh`);
      console.log(`  ${c.grammar}/${r.label}: ${alignOk}/${editScenarios.length} token-alignments ≡ oracle`);
      console.log(`  ${c.grammar}/${r.label}: ${fastOk}/${editScenarios.length} fast ≡ validated`);
    }
  }
}

finish('edited ≡ fresh (one-character edits, edit sessions)');
